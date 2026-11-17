import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

import { normalizeKey } from "./credentials.js";
import { readInventory, starterInventory, type Inventory } from "../items/inventory.js";
import { STARTING_PROGRESS, readProgress, type Progress } from "../progression/level.js";
import { STARTING_STATS, readStats, type PlayerStats } from "../progression/stats.js";
import { EMPTY_PERIODS, readPeriods, type PeriodCounters, type RankingSource } from "../progression/ranking.js";
import { DEFAULT_SOCIAL_SETTINGS, isBodyType, readSocialSettings, type BodyType, type SocialSettings } from "../net/protocol.js";
import { readFriendIds } from "../social/friends.js";
import { readGuildRecord, type GuildRecord } from "../social/guilds.js";
import { readListing, type Listing } from "../items/market.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  MAX_SESSIONS_PER_ACCOUNT,
  generatePlayerId,
  generateSessionToken,
  hashSessionToken,
  type Account,
  type AccountStore,
  type AuthSuccess,
  type PasswordResetRecord,
  type RegisterResult,
  type ResetTarget,
  type SavedPosition,
} from "./AccountStore.js";

/** Endereço padrão do MongoDB local (docker-compose.yml). Trocar com a variável MONGO_URL. */
export const DEFAULT_MONGO_URL = "mongodb://localhost:27017/mmo";

/** Documento da coleção `accounts`. Ver mmo-docs [INFRA-07]. */
interface AccountDocument {
  /** Id interno do jogador (único). */
  playerId: string;
  /** Username como foi digitado (é o que aparece no jogo). */
  username: string;
  /** Username normalizado (minúsculas): índice único, usado no login. */
  usernameKey: string;
  /** E-mail normalizado (minúsculas): índice único, usado no login. */
  emailKey: string;
  /** Hash scrypt da senha (ver password.ts). A senha em si nunca é salva. */
  passwordHash: string;
  /** SHA-256 dos tokens de sessão ativos (um por aparelho, no máximo MAX_SESSIONS_PER_ACCOUNT). */
  sessionHashes: string[];
  createdAt: Date;
  lastLoginAt: Date;
  lastPosition: SavedPosition | null;
  /** Vestido + mochila. Pode faltar em conta antiga (vira o inicial ao ler). Lido sempre por readInventory. */
  inventory?: Inventory;
  /** Corpo do personagem ("male" | "female"). Falta/null = ainda não escolheu (conta antiga também). */
  body?: string | null;
  /** Nível e XP ([JOGO-12]). Pode faltar em conta antiga (vira nível 1 ao ler). Lido sempre por readProgress. */
  progress?: Progress;
  /** Contadores do perfil ([SOC-08]). Pode faltar em conta antiga (= tudo zero). Lido sempre por readStats. */
  stats?: PlayerStats;
  /** Contadores do dia/semana dos rankings ([SOC-07]). Pode faltar (= vazio). Lido sempre por readPeriods. */
  periods?: PeriodCounters;
  /** Amigos (ids de jogador, mútuo, [SOC-04]). Pode faltar em conta antiga (= nenhum). Lido sempre por readFriendIds. */
  friends?: string[];
  /** Configuração social ([SOC-04]). Pode faltar em conta antiga (= mostra tudo). Lido sempre por readSocialSettings. */
  social?: SocialSettings;
  /** Quando saiu por vontade própria da última guilda (ms, [SOC-06]); falta/null = nunca. */
  guildLeftAt?: number | null;
  /** Código de recuperar senha pendente ([INFRA-13]); falta/null = nenhum. */
  passwordReset?: PasswordResetRecord | null;
}

/** Objeto comum (não nulo, não lista). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lê o código de recuperar senha do banco (formato estranho = nenhum). */
function readResetRecord(raw: unknown): PasswordResetRecord | null {
  if (!isPlainRecord(raw)) return null;
  const { codeHash, expiresAt, attempts, sentAt } = raw;
  if (typeof codeHash !== "string" || typeof expiresAt !== "number" || typeof attempts !== "number" || typeof sentAt !== "number") return null;
  return { codeHash, expiresAt, attempts, sentAt };
}

/** Código de erro do MongoDB para violação de índice único. */
const DUPLICATE_KEY = 11000;

/** Contas guardadas no MongoDB (coleção `accounts`). */
export class MongoAccountStore implements AccountStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly accounts: Collection<AccountDocument>,
    private readonly guilds: Collection<GuildRecord>,
    private readonly market: Collection<Listing>,
  ) {}

  /**
   * Conecta, cria os índices (se faltarem) e devolve o store pronto.
   * Falha rápido (5 s) se o banco não estiver no ar.
   */
  static async connect(url: string = DEFAULT_MONGO_URL): Promise<MongoAccountStore> {
    const client: MongoClient = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db: Db = client.db();
    const accounts: Collection<AccountDocument> = db.collection<AccountDocument>("accounts");
    await accounts.createIndex({ playerId: 1 }, { unique: true });
    await accounts.createIndex({ usernameKey: 1 }, { unique: true });
    await accounts.createIndex({ emailKey: 1 }, { unique: true });
    await accounts.createIndex({ sessionHashes: 1 });
    // Guildas ([SOC-06]): ficam todas na memória do servidor; o índice só garante id único.
    const guilds: Collection<GuildRecord> = db.collection<GuildRecord>("guilds");
    await guilds.createIndex({ id: 1 }, { unique: true });
    // Mercado ([JOGO-25]): idem, todos na memória do servidor.
    const market: Collection<Listing> = db.collection<Listing>("market");
    await market.createIndex({ id: 1 }, { unique: true });
    return new MongoAccountStore(client, db, accounts, guilds, market);
  }

  async register(username: string, email: string, password: string): Promise<RegisterResult> {
    const usernameKey: string = normalizeKey(username);
    const emailKey: string = normalizeKey(email);
    // Checagem amigável antes do hash (caro); o índice único garante mesmo em cadastros simultâneos.
    if ((await this.accounts.countDocuments({ usernameKey }, { limit: 1 })) > 0) return { ok: false, reason: "username_taken" };
    if ((await this.accounts.countDocuments({ emailKey }, { limit: 1 })) > 0) return { ok: false, reason: "email_taken" };

    const sessionToken: string = generateSessionToken();
    const now: Date = new Date();
    const passwordHash: string = await hashPassword(password);
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc: AccountDocument = {
        playerId: generatePlayerId(),
        username: username.trim(),
        usernameKey,
        emailKey,
        passwordHash,
        sessionHashes: [hashSessionToken(sessionToken)],
        createdAt: now,
        lastLoginAt: now,
        lastPosition: null,
        inventory: starterInventory(),
        body: null,
        progress: STARTING_PROGRESS,
        stats: STARTING_STATS,
        periods: EMPTY_PERIODS,
        friends: [],
        social: DEFAULT_SOCIAL_SETTINGS,
      };
      try {
        await this.accounts.insertOne(doc);
        return { ok: true, account: MongoAccountStore.toAccount(doc), sessionToken };
      } catch (error: unknown) {
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) throw error;
        const key: unknown = error.keyPattern;
        if (typeof key === "object" && key !== null && "usernameKey" in key) return { ok: false, reason: "username_taken" };
        if (typeof key === "object" && key !== null && "emailKey" in key) return { ok: false, reason: "email_taken" };
        // Colisão de playerId (raríssima): tenta de novo com outro.
      }
    }
    throw new Error("não foi possível gerar um playerId único");
  }

  async login(usernameOrEmail: string, password: string): Promise<AuthSuccess | null> {
    const key: string = normalizeKey(usernameOrEmail);
    const doc: AccountDocument | null = await this.accounts.findOne({ $or: [{ usernameKey: key }, { emailKey: key }] });
    if (doc === null || !(await verifyPassword(password, doc.passwordHash))) return null;

    const sessionToken: string = generateSessionToken();
    await this.accounts.updateOne(
      { playerId: doc.playerId },
      {
        $set: { lastLoginAt: new Date() },
        // Adiciona a sessão nova e mantém só as N mais recentes.
        $push: { sessionHashes: { $each: [hashSessionToken(sessionToken)], $slice: -MAX_SESSIONS_PER_ACCOUNT } },
      },
    );
    return { ok: true, account: MongoAccountStore.toAccount(doc), sessionToken };
  }

  async resume(sessionToken: string): Promise<Account | null> {
    const doc: AccountDocument | null = await this.accounts.findOneAndUpdate(
      { sessionHashes: hashSessionToken(sessionToken) },
      { $set: { lastLoginAt: new Date() } },
      { returnDocument: "after" },
    );
    return doc === null ? null : MongoAccountStore.toAccount(doc);
  }

  async logout(sessionToken: string): Promise<void> {
    const hash: string = hashSessionToken(sessionToken);
    await this.accounts.updateOne({ sessionHashes: hash }, { $pull: { sessionHashes: hash } });
  }

  async savePosition(playerId: string, position: SavedPosition): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { lastPosition: position } });
  }

  async saveInventory(playerId: string, inventory: Inventory): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { inventory } });
  }

  async saveProgress(playerId: string, progress: Progress): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { progress } });
  }

  async saveStats(playerId: string, stats: PlayerStats, periods: PeriodCounters): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { stats, periods } });
  }

  async rankingSources(): Promise<RankingSource[]> {
    const result: RankingSource[] = [];
    const docs = this.accounts.find(
      { $or: [{ "stats.monsterXp": { $gt: 0 } }, { "stats.kills": { $gt: 0 } }], emailKey: { $not: /@convidado\.local$/ } },
      { projection: { playerId: 1, username: 1, stats: 1, periods: 1 } },
    );
    for await (const doc of docs) {
      result.push({ id: doc.playerId, name: doc.username, stats: readStats(doc.stats), periods: readPeriods(doc.periods) });
    }
    return result;
  }

  async chooseBody(playerId: string, body: BodyType): Promise<boolean> {
    // Só grava se ainda não houver corpo: a escolha é para sempre (e duas conexões não brigam).
    const result = await this.accounts.updateOne(
      { playerId, $or: [{ body: null }, { body: { $exists: false } }] },
      { $set: { body } },
    );
    return result.modifiedCount === 1;
  }

  async addFriendship(a: string, b: string): Promise<void> {
    // $addToSet: repetir não duplica (dois aceites quase juntos, por exemplo).
    await this.accounts.updateOne({ playerId: a }, { $addToSet: { friends: b } });
    await this.accounts.updateOne({ playerId: b }, { $addToSet: { friends: a } });
  }

  async removeFriendship(a: string, b: string): Promise<void> {
    await this.accounts.updateOne({ playerId: a }, { $pull: { friends: b } });
    await this.accounts.updateOne({ playerId: b }, { $pull: { friends: a } });
  }

  async usernamesOf(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const names: Map<string, string> = new Map();
    if (playerIds.length === 0) return names;
    const docs = this.accounts.find({ playerId: { $in: [...playerIds] } }, { projection: { playerId: 1, username: 1 } });
    for await (const doc of docs) names.set(doc.playerId, doc.username);
    return names;
  }

  async saveSocialSettings(playerId: string, settings: SocialSettings): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { social: settings } });
  }

  async saveGuildLeftAt(playerId: string, atMs: number): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { guildLeftAt: atMs } });
  }

  async loadGuilds(): Promise<GuildRecord[]> {
    const result: GuildRecord[] = [];
    for await (const doc of this.guilds.find({}, { projection: { _id: 0 } })) {
      const guild: GuildRecord | null = readGuildRecord(doc);
      if (guild !== null) result.push(guild);
    }
    return result;
  }

  async saveGuild(guild: GuildRecord): Promise<void> {
    await this.guilds.replaceOne({ id: guild.id }, { ...guild, members: [...guild.members] }, { upsert: true });
  }

  async loadListings(): Promise<Listing[]> {
    const result: Listing[] = [];
    for await (const doc of this.market.find({}, { projection: { _id: 0 } })) {
      const listing: Listing | null = readListing(doc);
      if (listing !== null) result.push(listing);
    }
    return result;
  }

  async saveListing(listing: Listing): Promise<void> {
    await this.market.replaceOne({ id: listing.id }, { ...listing }, { upsert: true });
  }

  async deleteListing(listingId: string): Promise<void> {
    await this.market.deleteOne({ id: listingId });
  }

  async addGold(playerId: string, amount: number): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $inc: { "progress.gold": amount } });
  }

  async deleteGuild(guildId: string): Promise<void> {
    await this.guilds.deleteOne({ id: guildId });
  }

  async findForReset(usernameOrEmail: string): Promise<ResetTarget | null> {
    const key: string = normalizeKey(usernameOrEmail);
    const doc: AccountDocument | null = await this.accounts.findOne({ $or: [{ usernameKey: key }, { emailKey: key }] });
    if (doc === null) return null;
    return { playerId: doc.playerId, username: doc.username, email: doc.emailKey, reset: readResetRecord(doc.passwordReset) };
  }

  async saveReset(playerId: string, reset: PasswordResetRecord | null): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { passwordReset: reset } });
  }

  async setPassword(playerId: string, password: string): Promise<void> {
    const passwordHash: string = await hashPassword(password);
    // Senha nova: todos os aparelhos logados saem (quem roubou a sessão também).
    await this.accounts.updateOne({ playerId }, { $set: { passwordHash, sessionHashes: [], passwordReset: null } });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /** Fecha a conexão com o banco. */
  close(): Promise<void> {
    return this.client.close();
  }

  private static toAccount(doc: AccountDocument): Account {
    return {
      playerId: doc.playerId,
      username: doc.username,
      lastPosition: doc.lastPosition,
      inventory: readInventory(doc.inventory),
      body: isBodyType(doc.body) ? doc.body : null,
      progress: readProgress(doc.progress),
      stats: readStats(doc.stats),
      periods: readPeriods(doc.periods),
      friends: readFriendIds(doc.friends),
      social: readSocialSettings(doc.social),
      guildLeftAt: typeof doc.guildLeftAt === "number" ? doc.guildLeftAt : null,
    };
  }
}

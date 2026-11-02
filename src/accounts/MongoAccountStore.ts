import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

import { normalizeKey } from "./credentials.js";
import { readInventory, starterInventory, type Inventory } from "../items/inventory.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  MAX_SESSIONS_PER_ACCOUNT,
  generatePlayerId,
  generateSessionToken,
  hashSessionToken,
  type Account,
  type AccountStore,
  type AuthSuccess,
  type RegisterResult,
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
}

/** Código de erro do MongoDB para violação de índice único. */
const DUPLICATE_KEY = 11000;

/** Contas guardadas no MongoDB (coleção `accounts`). */
export class MongoAccountStore implements AccountStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly accounts: Collection<AccountDocument>,
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
    return new MongoAccountStore(client, db, accounts);
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
    };
  }
}

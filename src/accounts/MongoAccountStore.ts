import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

import {
  generateGuestToken,
  generatePlayerId,
  hashGuestToken,
  type AccountStore,
  type GuestLogin,
  type SavedPosition,
} from "./AccountStore.js";

/** Endereço padrão do MongoDB local (docker-compose.yml). Trocar com a variável MONGO_URL. */
export const DEFAULT_MONGO_URL = "mongodb://localhost:27017/mmo";

/** Documento da coleção `accounts`. Ver mmo-docs [INFRA-07]. */
interface AccountDocument {
  /** Id público do jogador (único). */
  playerId: string;
  /** SHA-256 do token de convidado (único). O token em si nunca é salvo. */
  guestTokenHash: string;
  createdAt: Date;
  lastLoginAt: Date;
  lastPosition: SavedPosition | null;
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
    await accounts.createIndex({ guestTokenHash: 1 }, { unique: true });
    return new MongoAccountStore(client, db, accounts);
  }

  async loginGuest(guestToken: string | null): Promise<GuestLogin> {
    const now: Date = new Date();
    if (guestToken !== null) {
      const found: AccountDocument | null = await this.accounts.findOneAndUpdate(
        { guestTokenHash: hashGuestToken(guestToken) },
        { $set: { lastLoginAt: now } },
        { returnDocument: "after" },
      );
      if (found !== null) {
        return { account: { playerId: found.playerId, lastPosition: found.lastPosition }, guestToken, created: false };
      }
    }

    // Conta nova. O playerId é aleatório; se colidir (muito raro), tenta de novo.
    const newToken: string = generateGuestToken();
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc: AccountDocument = {
        playerId: generatePlayerId(),
        guestTokenHash: hashGuestToken(newToken),
        createdAt: now,
        lastLoginAt: now,
        lastPosition: null,
      };
      try {
        await this.accounts.insertOne(doc);
        return { account: { playerId: doc.playerId, lastPosition: null }, guestToken: newToken, created: true };
      } catch (error: unknown) {
        if (!(error instanceof MongoServerError && error.code === DUPLICATE_KEY)) throw error;
      }
    }
    throw new Error("não foi possível gerar um playerId único");
  }

  async savePosition(playerId: string, position: SavedPosition): Promise<void> {
    await this.accounts.updateOne({ playerId }, { $set: { lastPosition: position } });
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
}

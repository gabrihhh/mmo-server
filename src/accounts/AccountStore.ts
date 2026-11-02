import { createHash, randomBytes } from "node:crypto";

/**
 * Contas de jogador. Por enquanto só existe **conta de convidado**: o aparelho guarda um
 * token secreto e o servidor acha a conta por ele. Ver mmo-docs [INFRA-07].
 */

/** Última posição salva de um jogador (para voltar onde parou). Metros e radianos. */
export interface SavedPosition {
  readonly zone: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** Conta como o resto do servidor a enxerga (sem segredos). */
export interface Account {
  /** Id público e estável do jogador (8 caracteres). É o id que aparece no jogo e no protocolo. */
  readonly playerId: string;
  /** Onde o jogador estava ao sair pela última vez; `null` em conta nova. */
  readonly lastPosition: SavedPosition | null;
}

/** Resultado de {@link AccountStore.loginGuest}. */
export interface GuestLogin {
  readonly account: Account;
  /**
   * Token que o cliente deve guardar e mandar no próximo login.
   * É o mesmo recebido, ou um novo se a conta foi criada agora.
   */
  readonly guestToken: string;
  /** `true` se a conta foi criada neste login. */
  readonly created: boolean;
}

/** Onde as contas ficam guardadas (MongoDB no jogo, memória nos testes). */
export interface AccountStore {
  /**
   * Login de convidado: se `guestToken` for de uma conta existente, entra nela;
   * se for `null` ou desconhecido (ex.: banco apagado), cria uma conta nova com token novo.
   */
  loginGuest(guestToken: string | null): Promise<GuestLogin>;
  /** Salva a posição do jogador (chamado ao sair da zona). */
  savePosition(playerId: string, position: SavedPosition): Promise<void>;
  /** `true` se o armazenamento está acessível (usado pelo `/health`). */
  isHealthy(): Promise<boolean>;
}

/** Gera um token de convidado: 32 bytes aleatórios em base64url (não adivinhável). */
export function generateGuestToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Gera um id público de jogador: 6 bytes aleatórios em base64url (8 caracteres). */
export function generatePlayerId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * Hash SHA-256 do token. O banco guarda só o hash: quem ler o banco não consegue
 * se passar pelo jogador. (SHA-256 basta porque o token já é aleatório e longo.)
 */
export function hashGuestToken(guestToken: string): string {
  return createHash("sha256").update(guestToken).digest("hex");
}

/** Implementação em memória, para testes (não precisa de MongoDB). */
export class InMemoryAccountStore implements AccountStore {
  private readonly byTokenHash: Map<string, { playerId: string; lastPosition: SavedPosition | null }> = new Map();

  async loginGuest(guestToken: string | null): Promise<GuestLogin> {
    if (guestToken !== null) {
      const found = this.byTokenHash.get(hashGuestToken(guestToken));
      if (found !== undefined) return { account: { ...found }, guestToken, created: false };
    }
    const newToken: string = generateGuestToken();
    const record = { playerId: generatePlayerId(), lastPosition: null };
    this.byTokenHash.set(hashGuestToken(newToken), record);
    return { account: { ...record }, guestToken: newToken, created: true };
  }

  async savePosition(playerId: string, position: SavedPosition): Promise<void> {
    for (const record of this.byTokenHash.values()) {
      if (record.playerId === playerId) record.lastPosition = position;
    }
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}

import { createHash, randomBytes } from "node:crypto";

import { normalizeKey } from "./credentials.js";
import { readInventory, starterInventory, type Inventory } from "../items/inventory.js";
import { STARTING_PROGRESS, readProgress, type Progress } from "../progression/level.js";
import { hashPassword, verifyPassword } from "./password.js";
import { DEFAULT_SOCIAL_SETTINGS, readSocialSettings, type BodyType, type SocialSettings } from "../net/protocol.js";
import { readFriendIds } from "../social/friends.js";

/**
 * Contas de jogador: cadastro com username + e-mail + senha, login por username OU e-mail,
 * e token de sessão para o aparelho entrar direto nas próximas vezes. Ver mmo-docs [INFRA-07].
 *
 * Validação de formato (username, e-mail, senha) fica em `credentials.ts` e é feita ANTES de chamar
 * o store; aqui só se garante unicidade e se guarda/confere os segredos.
 * Username: único e buscado SEM diferenciar maiúsculas (chave normalizada), mas guardado e exibido
 * exatamente como foi digitado.
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
  /** Id interno e estável do jogador (8 caracteres). Usado no protocolo para identificar entidades. */
  readonly playerId: string;
  /** Nome exibido acima do personagem, exatamente como foi cadastrado. */
  readonly username: string;
  /** Onde o jogador estava ao sair pela última vez; `null` em conta nova. */
  readonly lastPosition: SavedPosition | null;
  /** Itens vestidos e mochila ([JOGO-04]). Conta nova começa com o kit de treino. */
  readonly inventory: Inventory;
  /** Corpo do personagem, escolhido uma vez na primeira entrada; `null` = ainda não escolheu. */
  readonly body: BodyType | null;
  /** Nível e XP do personagem ([JOGO-12]). Conta nova/antiga: nível 1, sem XP. */
  readonly progress: Progress;
  /** Amigos (ids de jogador, amizade mútua, [SOC-04]). Conta nova/antiga: nenhum. Fakes de teste não entram aqui. */
  readonly friends: readonly string[];
  /** Configuração social (Sempre/Ocultar pedidos de amizade e convites de grupo, [SOC-04]). Conta antiga: mostra tudo. */
  readonly social: SocialSettings;
}

/** Login aceito: a conta e o token de sessão que o aparelho deve guardar. */
export interface AuthSuccess {
  readonly ok: true;
  readonly account: Account;
  /** Token secreto de sessão: com ele o aparelho entra sem digitar a senha ({@link AccountStore.resume}). */
  readonly sessionToken: string;
}

/** Motivo de recusa no cadastro. */
export type RegisterFailure = "username_taken" | "email_taken";

/** Resultado de {@link AccountStore.register}. */
export type RegisterResult = AuthSuccess | { readonly ok: false; readonly reason: RegisterFailure };

/** Código de recuperar senha guardado na conta ([INFRA-13]); só o hash do código. Tempos em ms (`Date.now()`). */
export interface PasswordResetRecord {
  readonly codeHash: string;
  readonly expiresAt: number;
  /** Códigos errados digitados para este código. */
  readonly attempts: number;
  /** Quando o e-mail foi mandado (freio de reenvio). */
  readonly sentAt: number;
}

/** Conta achada para recuperar a senha: para onde mandar o código e o código pendente. */
export interface ResetTarget {
  readonly playerId: string;
  readonly username: string;
  /** E-mail da conta (como guardado: minúsculas). */
  readonly email: string;
  readonly reset: PasswordResetRecord | null;
}

/** Quantas sessões (aparelhos) uma conta guarda; a mais antiga sai quando passa disso. */
export const MAX_SESSIONS_PER_ACCOUNT = 5;

/** Onde as contas ficam guardadas (MongoDB no jogo, memória nos testes). */
export interface AccountStore {
  /** Cria a conta (dados já validados) e abre uma sessão. Recusa username/e-mail repetido. */
  register(username: string, email: string, password: string): Promise<RegisterResult>;
  /** Confere username OU e-mail + senha e abre uma sessão. `null` = credenciais inválidas (sem dizer qual). */
  login(usernameOrEmail: string, password: string): Promise<AuthSuccess | null>;
  /** Entra com um token de sessão salvo no aparelho. `null` = token desconhecido/encerrado. */
  resume(sessionToken: string): Promise<Account | null>;
  /** Encerra a sessão deste token (logout). Ignora token desconhecido. */
  logout(sessionToken: string): Promise<void>;
  /** Salva a posição do jogador (chamado ao sair da zona). */
  savePosition(playerId: string, position: SavedPosition): Promise<void>;
  /** Salva o inventário (chamado a cada troca aceita). */
  saveInventory(playerId: string, inventory: Inventory): Promise<void>;
  /** Salva nível e XP (chamado quando o jogador ganha XP, [JOGO-12]). */
  saveProgress(playerId: string, progress: Progress): Promise<void>;
  /**
   * Grava o corpo do personagem SE ainda não houver um (a escolha é para sempre). `true` = gravou; `false` = já tinha
   * (ou conta inexistente).
   */
  chooseBody(playerId: string, body: BodyType): Promise<boolean>;
  /** Grava a amizade de `a` e `b` nas DUAS contas (mútua; repetir não duplica). */
  addFriendship(a: string, b: string): Promise<void>;
  /** Desfaz a amizade de `a` e `b` nas DUAS contas (remoção mútua; ignora quem não era amigo). */
  removeFriendship(a: string, b: string): Promise<void>;
  /** Usernames (como cadastrados) das contas pedidas; id sem conta fica de fora. Lista de amigos offline. */
  usernamesOf(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Salva a Configuração social da conta ([SOC-04]). */
  saveSocialSettings(playerId: string, settings: SocialSettings): Promise<void>;
  /** Conta por username OU e-mail, para recuperar a senha ([INFRA-13]). `null` = não existe. */
  findForReset(usernameOrEmail: string): Promise<ResetTarget | null>;
  /** Grava (ou apaga, com `null`) o código de recuperar senha da conta. */
  saveReset(playerId: string, reset: PasswordResetRecord | null): Promise<void>;
  /** Troca a senha (já validada), apaga o código e ENCERRA todas as sessões da conta. */
  setPassword(playerId: string, password: string): Promise<void>;
  /** `true` se o armazenamento está acessível (usado pelo `/health`). */
  isHealthy(): Promise<boolean>;
}

/** Gera um token de sessão: 32 bytes aleatórios em base64url (não adivinhável). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Gera um id de jogador: 6 bytes aleatórios em base64url (8 caracteres). */
export function generatePlayerId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * Hash SHA-256 do token de sessão. O banco guarda só o hash: quem ler o banco não consegue entrar
 * na conta. (SHA-256 basta porque o token já é aleatório e longo; senha usa scrypt.)
 */
export function hashSessionToken(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

/** Registro interno da versão em memória. */
interface MemoryRecord {
  playerId: string;
  username: string;
  usernameKey: string;
  emailKey: string;
  passwordHash: string;
  sessionHashes: string[];
  lastPosition: SavedPosition | null;
  inventory: Inventory;
  body: BodyType | null;
  progress: Progress;
  friends: string[];
  social: SocialSettings;
  passwordReset: PasswordResetRecord | null;
}

/** Implementação em memória, para testes (não precisa de MongoDB). Mesmas regras da versão Mongo. */
export class InMemoryAccountStore implements AccountStore {
  private readonly records: MemoryRecord[] = [];

  /**
   * [newInventory] = com que inventário uma conta nasce (padrão: o do jogo, {@link starterInventory}, sem itens). Os
   * testes que precisam vestir algo passam o kit completo (`fullKitInventory`).
   */
  constructor(private readonly newInventory: () => Inventory = starterInventory) {}

  async register(username: string, email: string, password: string): Promise<RegisterResult> {
    const usernameKey: string = normalizeKey(username);
    const emailKey: string = normalizeKey(email);
    if (this.records.some((r) => r.usernameKey === usernameKey)) return { ok: false, reason: "username_taken" };
    if (this.records.some((r) => r.emailKey === emailKey)) return { ok: false, reason: "email_taken" };
    const record: MemoryRecord = {
      playerId: generatePlayerId(),
      username: username.trim(),
      usernameKey,
      emailKey,
      passwordHash: await hashPassword(password),
      sessionHashes: [],
      lastPosition: null,
      inventory: this.newInventory(),
      body: null,
      progress: STARTING_PROGRESS,
      friends: [],
      social: DEFAULT_SOCIAL_SETTINGS,
      passwordReset: null,
    };
    this.records.push(record);
    return this.openSession(record);
  }

  async login(usernameOrEmail: string, password: string): Promise<AuthSuccess | null> {
    const key: string = normalizeKey(usernameOrEmail);
    const record: MemoryRecord | undefined = this.records.find((r) => r.usernameKey === key || r.emailKey === key);
    if (record === undefined || !(await verifyPassword(password, record.passwordHash))) return null;
    return this.openSession(record);
  }

  async resume(sessionToken: string): Promise<Account | null> {
    const hash: string = hashSessionToken(sessionToken);
    const record: MemoryRecord | undefined = this.records.find((r) => r.sessionHashes.includes(hash));
    return record === undefined ? null : InMemoryAccountStore.toAccount(record);
  }

  async logout(sessionToken: string): Promise<void> {
    const hash: string = hashSessionToken(sessionToken);
    for (const record of this.records) record.sessionHashes = record.sessionHashes.filter((h) => h !== hash);
  }

  async savePosition(playerId: string, position: SavedPosition): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record !== undefined) record.lastPosition = position;
  }

  async saveInventory(playerId: string, inventory: Inventory): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record !== undefined) record.inventory = inventory;
  }

  async saveProgress(playerId: string, progress: Progress): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record !== undefined) record.progress = progress;
  }

  async chooseBody(playerId: string, body: BodyType): Promise<boolean> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record === undefined || record.body !== null) return false;
    record.body = body;
    return true;
  }

  async addFriendship(a: string, b: string): Promise<void> {
    for (const [self, other] of [[a, b], [b, a]] as const) {
      const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === self);
      if (record !== undefined && !record.friends.includes(other)) record.friends = [...record.friends, other];
    }
  }

  async removeFriendship(a: string, b: string): Promise<void> {
    for (const [self, other] of [[a, b], [b, a]] as const) {
      const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === self);
      if (record !== undefined) record.friends = record.friends.filter((id) => id !== other);
    }
  }

  async usernamesOf(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const names: Map<string, string> = new Map();
    for (const record of this.records) if (playerIds.includes(record.playerId)) names.set(record.playerId, record.username);
    return names;
  }

  async saveSocialSettings(playerId: string, settings: SocialSettings): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record !== undefined) record.social = settings;
  }

  async findForReset(usernameOrEmail: string): Promise<ResetTarget | null> {
    const key: string = normalizeKey(usernameOrEmail);
    const record: MemoryRecord | undefined = this.records.find((r) => r.usernameKey === key || r.emailKey === key);
    return record === undefined ? null : { playerId: record.playerId, username: record.username, email: record.emailKey, reset: record.passwordReset };
  }

  async saveReset(playerId: string, reset: PasswordResetRecord | null): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record !== undefined) record.passwordReset = reset;
  }

  async setPassword(playerId: string, password: string): Promise<void> {
    const record: MemoryRecord | undefined = this.records.find((r) => r.playerId === playerId);
    if (record === undefined) return;
    record.passwordHash = await hashPassword(password);
    record.sessionHashes = [];
    record.passwordReset = null;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  private openSession(record: MemoryRecord): AuthSuccess {
    const sessionToken: string = generateSessionToken();
    record.sessionHashes = [...record.sessionHashes, hashSessionToken(sessionToken)].slice(-MAX_SESSIONS_PER_ACCOUNT);
    return { ok: true, account: InMemoryAccountStore.toAccount(record), sessionToken };
  }

  private static toAccount(record: MemoryRecord): Account {
    return {
      playerId: record.playerId,
      username: record.username,
      lastPosition: record.lastPosition,
      inventory: readInventory(record.inventory),
      body: record.body,
      progress: readProgress(record.progress),
      friends: readFriendIds(record.friends),
      social: readSocialSettings(record.social),
    };
  }
}

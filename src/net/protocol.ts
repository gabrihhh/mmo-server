/**
 * Contrato de rede cliente ↔ servidor.
 *
 * Transporte: WebSocket, um objeto JSON por mensagem de texto, sempre no formato
 * `{ "type": string, "data": object }`. Posições em metros, rotações em radianos.
 *
 * Fluxo: conectar → autenticar (`register`, `login` ou `resume`) → `auth_ok` → `join` → `welcome` →
 * `input`/`snapshot` (mmo-docs [INFRA-09]).
 *
 * ATENÇÃO: qualquer mudança aqui precisa ser espelhada no cliente
 * (mmo-client/scripts/network/protocol.gd e network.gd) e documentada em mmo-docs [INFRA-04].
 * Mudança incompatível → incremente {@link PROTOCOL_VERSION}.
 */

/** Versão do protocolo. O cliente envia a dele ao autenticar; se for diferente, a conexão é recusada. */
export const PROTOCOL_VERSION = 4;

/** Tipos de mensagem cliente → servidor. */
export const ClientMessageType = {
  /** Cria conta (username, e-mail, senha). Payload: {@link RegisterData}. */
  Register: "register",
  /** Entra com username OU e-mail + senha. Payload: {@link LoginData}. */
  Login: "login",
  /** Entra com o token de sessão salvo no aparelho. Payload: {@link ResumeData}. */
  Resume: "resume",
  /** Encerra a sessão deste aparelho (o token deixa de valer) e fecha a conexão. Payload: `{}`. */
  Logout: "logout",
  /** Pede para entrar numa zona (exige estar autenticado). Payload: {@link JoinData}. */
  Join: "join",
  /**
   * Intenção de movimento de UM tick (não a posição: o servidor é a autoridade e simula).
   * Payload: {@link InputData}. Ver mmo-docs [INFRA-09].
   */
  Input: "input",
} as const;

/** Tipos de mensagem servidor → cliente. */
export const ServerMessageType = {
  /** Autenticação aceita: quem é o jogador e o token de sessão a guardar. */
  AuthOk: "auth_ok",
  /** Entrada na zona aceita: tick, parâmetros da simulação e todos os jogadores (inclusive o próprio). */
  Welcome: "welcome",
  /** Outro jogador entrou na zona. */
  PlayerJoined: "player_joined",
  /** Um jogador saiu da zona. */
  PlayerLeft: "player_left",
  /** Estado da zona a cada tick de simulação, com o último input processado de quem recebe. */
  Snapshot: "snapshot",
  /** Pedido recusado ou mensagem inválida. Ver {@link ErrorCode}. */
  Error: "error",
} as const;

/** Códigos enviados em {@link ServerMessageType.Error}. */
export const ErrorCode = {
  /** JSON inválido, tipo desconhecido ou payload fora do formato. A conexão continua. */
  BadMessage: "bad_message",
  /** Versão do protocolo diferente da do servidor. A conexão é fechada. */
  VersionMismatch: "version_mismatch",
  /** Username fora das regras (3–16 caracteres: letras, números, `_`). A conexão continua. */
  InvalidUsername: "invalid_username",
  /** E-mail com formato inválido. A conexão continua. */
  InvalidEmail: "invalid_email",
  /** Senha fora das regras (8–72 caracteres). A conexão continua. */
  InvalidPassword: "invalid_password",
  /** Username já usado (sem diferenciar maiúsculas). A conexão continua. */
  UsernameTaken: "username_taken",
  /** E-mail já usado. A conexão continua. */
  EmailTaken: "email_taken",
  /** Login: usuário/e-mail ou senha errados (sem dizer qual). A conexão continua. */
  InvalidCredentials: "invalid_credentials",
  /** Token de sessão desconhecido ou encerrado: o cliente apaga o token e mostra o login. A conexão continua. */
  InvalidSession: "invalid_session",
  /** Tentativas de autenticação demais nesta conexão. A conexão é fechada. */
  TooManyAttempts: "too_many_attempts",
  /** Autenticar de novo numa conexão já autenticada. A conexão continua. */
  AlreadyAuthenticated: "already_authenticated",
  /** `join`/`input` antes de autenticar. A conexão continua. */
  NotAuthenticated: "not_authenticated",
  /** Zona inexistente. A conexão é fechada. */
  UnknownZone: "unknown_zone",
  /** Zona lotada. A conexão é fechada. */
  ZoneFull: "zone_full",
  /** `join` repetido na mesma conexão. A conexão continua. */
  AlreadyJoined: "already_joined",
  /** Falha interna (ex.: banco fora do ar). A conexão é fechada. */
  ServerError: "server_error",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Close codes do WebSocket usados pelo servidor. */
export const CloseCode = {
  /** Saída normal (inclui logout). */
  Normal: 1000,
  /** Recusado (veja a mensagem `error` enviada antes do fechamento). */
  Rejected: 4000,
  /** Conexão sem resposta ao ping (heartbeat). */
  Timeout: 4001,
  /** A mesma conta entrou por outra conexão (outro aparelho/janela); esta foi derrubada. */
  Replaced: 4002,
} as const;

/** Payload de `register`. Regras em `src/accounts/credentials.ts`. */
export interface RegisterData {
  /** {@link PROTOCOL_VERSION} do cliente. */
  readonly version: number;
  /** Como o jogador quer aparecer no jogo (é exibido exatamente assim). */
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** Payload de `login`. */
export interface LoginData {
  readonly version: number;
  /** Username ou e-mail (sem diferenciar maiúsculas). */
  readonly login: string;
  readonly password: string;
}

/** Payload de `resume`. */
export interface ResumeData {
  readonly version: number;
  /** Token recebido no último `auth_ok`. */
  readonly sessionToken: string;
}

/** Payload de `join`. */
export interface JoinData {
  /** Id da zona (ex.: `"zone_1"`). */
  readonly zone: string;
}

/** Maior número de sequência aceito (cabe com folga num int de 32 bits). */
export const MAX_INPUT_SEQ = 2_000_000_000;

/** Payload de `input`: direção desejada no mundo para um tick. */
export interface InputData {
  /** Número do input, crescente a partir de 1. O servidor devolve o último processado em `snapshot.ack`. */
  readonly seq: number;
  /** Direção no plano XZ do mundo; comprimento até 1 (maior é normalizado pelo servidor). */
  readonly x: number;
  readonly z: number;
}

/** Mensagem cliente → servidor já validada (formato; as regras de conta são checadas depois). */
export type ClientMessage =
  | { readonly type: typeof ClientMessageType.Register; readonly data: RegisterData }
  | { readonly type: typeof ClientMessageType.Login; readonly data: LoginData }
  | { readonly type: typeof ClientMessageType.Resume; readonly data: ResumeData }
  | { readonly type: typeof ClientMessageType.Logout; readonly data: Record<string, never> }
  | { readonly type: typeof ClientMessageType.Join; readonly data: JoinData }
  | { readonly type: typeof ClientMessageType.Input; readonly data: InputData };

/** Posição pública de um jogador, como vai no `snapshot` (a cada tick, sem o nome para economizar). */
export interface PlayerSnapshot {
  /** Id do jogador (playerId). */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** Jogador completo, como vai no `welcome` e no `player_joined`: posição + nome exibido. */
export interface PlayerInfo extends PlayerSnapshot {
  /** Username exatamente como foi cadastrado. */
  readonly name: string;
}

/** Parâmetros da simulação enviados no `welcome`. */
export interface SimParams {
  /** Ticks por segundo. */
  readonly tickRate: number;
  /** Velocidade de caminhada, m/s. */
  readonly moveSpeed: number;
  /** Metade do lado da zona, em metros. */
  readonly zoneHalfSize: number;
}

/** Payload de `snapshot`. */
export interface SnapshotData {
  /** Número do tick do servidor que gerou este estado. */
  readonly tick: number;
  /** Último `input.seq` de QUEM RECEBE que já foi aplicado (0 = nenhum). Base da reconciliação. */
  readonly ack: number;
  /** Todos os jogadores da zona (inclusive quem recebe). */
  readonly players: readonly PlayerSnapshot[];
}

/** Mensagem servidor → cliente. */
export type ServerMessage =
  | {
      readonly type: typeof ServerMessageType.AuthOk;
      readonly data: {
        /** Id do jogador desta conexão. */
        readonly playerId: string;
        /** Username exibido. */
        readonly username: string;
        /** Token a guardar no aparelho e mandar no próximo `resume`. */
        readonly sessionToken: string;
      };
    }
  | {
      readonly type: typeof ServerMessageType.Welcome;
      readonly data: {
        readonly playerId: string;
        readonly zone: string;
        /** Tick atual do servidor (o cliente sincroniza o relógio da interpolação por ele). */
        readonly tick: number;
        /** Parâmetros da simulação compartilhada (o cliente usa os do servidor, não os dele). */
        readonly sim: SimParams;
        readonly players: readonly PlayerInfo[];
      };
    }
  | { readonly type: typeof ServerMessageType.PlayerJoined; readonly data: { readonly player: PlayerInfo } }
  | { readonly type: typeof ServerMessageType.PlayerLeft; readonly data: { readonly id: string } }
  | { readonly type: typeof ServerMessageType.Snapshot; readonly data: SnapshotData }
  | { readonly type: typeof ServerMessageType.Error; readonly data: { readonly code: ErrorCode; readonly message: string } };

/** Serializa uma mensagem para enviar pelo WebSocket. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** `true` se `value` for um objeto simples (não null, não array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `true` se `value` for um número finito (rejeita NaN, Infinity e não-números). */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** `true` se `value` for string com até `max` caracteres. */
const isStringUpTo = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** Versão do protocolo válida (inteiro). */
const isVersion = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value);

/**
 * Tamanho máximo aceito nos campos de texto de autenticação. É só um limite de formato (proteção);
 * as regras de verdade (ex.: senha até 72) ficam em `credentials.ts` e geram erros específicos.
 */
const MAX_AUTH_FIELD = 256;

/** Valida o formato de `register`. */
export function parseRegisterData(data: unknown): RegisterData | null {
  if (!isRecord(data)) return null;
  const { version, username, email, password } = data;
  if (!isVersion(version)) return null;
  if (!isStringUpTo(username, MAX_AUTH_FIELD) || !isStringUpTo(email, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, username, email, password };
}

/** Valida o formato de `login`. */
export function parseLoginData(data: unknown): LoginData | null {
  if (!isRecord(data)) return null;
  const { version, login, password } = data;
  if (!isVersion(version) || !isStringUpTo(login, MAX_AUTH_FIELD) || !isStringUpTo(password, MAX_AUTH_FIELD)) return null;
  return { version, login, password };
}

/** Valida o formato de `resume`. */
export function parseResumeData(data: unknown): ResumeData | null {
  if (!isRecord(data)) return null;
  const { version, sessionToken } = data;
  if (!isVersion(version) || !isStringUpTo(sessionToken, 128) || sessionToken.length === 0) return null;
  return { version, sessionToken };
}

/** Valida o payload de `join`. */
export function parseJoinData(data: unknown): JoinData | null {
  if (!isRecord(data)) return null;
  const { zone } = data;
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return null;
  return { zone };
}

/** Valida o payload de `input`. A direção pode ter qualquer comprimento: a simulação normaliza. */
export function parseInputData(data: unknown): InputData | null {
  if (!isRecord(data)) return null;
  const { seq, x, z } = data;
  if (!isFiniteNumber(seq) || !Number.isInteger(seq) || seq < 1 || seq > MAX_INPUT_SEQ) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(z)) return null;
  return { seq, x, z };
}

/**
 * Decodifica e valida uma mensagem de texto vinda da rede (não confiável).
 * @returns a mensagem tipada, ou `null` se o JSON, o tipo ou o payload forem inválidos.
 */
export function parseClientMessage(text: string): ClientMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const raw: unknown = decoded["data"];

  switch (decoded["type"]) {
    case ClientMessageType.Register: {
      const data = parseRegisterData(raw);
      return data === null ? null : { type: ClientMessageType.Register, data };
    }
    case ClientMessageType.Login: {
      const data = parseLoginData(raw);
      return data === null ? null : { type: ClientMessageType.Login, data };
    }
    case ClientMessageType.Resume: {
      const data = parseResumeData(raw);
      return data === null ? null : { type: ClientMessageType.Resume, data };
    }
    case ClientMessageType.Logout:
      return { type: ClientMessageType.Logout, data: {} };
    case ClientMessageType.Join: {
      const data = parseJoinData(raw);
      return data === null ? null : { type: ClientMessageType.Join, data };
    }
    case ClientMessageType.Input: {
      const data = parseInputData(raw);
      return data === null ? null : { type: ClientMessageType.Input, data };
    }
    default:
      return null;
  }
}

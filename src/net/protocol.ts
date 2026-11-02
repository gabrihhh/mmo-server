/**
 * Contrato de rede cliente ↔ servidor.
 *
 * Transporte: WebSocket, um objeto JSON por mensagem de texto, sempre no formato
 * `{ "type": string, "data": object }`. Posições em metros, rotações em radianos.
 *
 * ATENÇÃO: qualquer mudança aqui precisa ser espelhada no cliente
 * (mmo-client/scripts/network/protocol.gd e network.gd) e documentada em mmo-docs [INFRA-04].
 * Mudança incompatível → incremente {@link PROTOCOL_VERSION}.
 */

/** Versão do protocolo. O cliente envia a dele no `join`; se for diferente, a entrada é recusada. */
export const PROTOCOL_VERSION = 3;

/** Tipos de mensagem cliente → servidor. */
export const ClientMessageType = {
  /** Pede para entrar numa zona. Payload: {@link JoinData}. */
  Join: "join",
  /**
   * Intenção de movimento de UM tick (não a posição: o servidor é a autoridade e simula).
   * Payload: {@link InputData}. Ver mmo-docs [INFRA-09].
   */
  Input: "input",
} as const;

/** Tipos de mensagem servidor → cliente. */
export const ServerMessageType = {
  /** Entrada aceita: id do jogador, token de convidado e todos os jogadores da zona (inclusive o próprio). */
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
  /** Zona inexistente. A conexão é fechada. */
  UnknownZone: "unknown_zone",
  /** Zona lotada. A conexão é fechada. */
  ZoneFull: "zone_full",
  /** `join` repetido na mesma conexão. A conexão continua. */
  AlreadyJoined: "already_joined",
  /** Falha interna (ex.: banco fora do ar) ao processar o `join`. A conexão é fechada. */
  ServerError: "server_error",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Close codes do WebSocket usados pelo servidor. */
export const CloseCode = {
  /** Saída normal. */
  Normal: 1000,
  /** Entrada recusada (veja a mensagem `error` enviada antes do fechamento). */
  Rejected: 4000,
  /** Conexão sem resposta ao ping (heartbeat). */
  Timeout: 4001,
  /** A mesma conta entrou por outra conexão (outro aparelho/janela); esta foi derrubada. */
  Replaced: 4002,
} as const;

/** Payload de `join`. */
export interface JoinData {
  /** Id da zona (ex.: `"zone_1"`). */
  readonly zone: string;
  /** {@link PROTOCOL_VERSION} do cliente. */
  readonly version: number;
  /**
   * Token de convidado guardado no aparelho, ou `null` no primeiro acesso (o servidor cria a conta
   * e devolve um token novo no `welcome`). Ver mmo-docs [INFRA-07].
   */
  readonly guestToken: string | null;
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

/** Mensagem cliente → servidor já validada. */
export type ClientMessage =
  | { readonly type: typeof ClientMessageType.Join; readonly data: JoinData }
  | { readonly type: typeof ClientMessageType.Input; readonly data: InputData };

/** Estado público de um jogador, como enviado aos clientes. */
export interface PlayerSnapshot {
  /** Id público do jogador (estável entre sessões). */
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
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
      readonly type: typeof ServerMessageType.Welcome;
      readonly data: {
        /** Id público do jogador desta conexão. */
        readonly playerId: string;
        /** Token a guardar no aparelho e mandar no próximo `join`. */
        readonly guestToken: string;
        readonly zone: string;
        /** Tick atual do servidor (o cliente sincroniza o relógio da interpolação por ele). */
        readonly tick: number;
        /** Parâmetros da simulação compartilhada (o cliente usa os do servidor, não os dele). */
        readonly sim: SimParams;
        readonly players: readonly PlayerSnapshot[];
      };
    }
  | { readonly type: typeof ServerMessageType.PlayerJoined; readonly data: { readonly player: PlayerSnapshot } }
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

/** Valida o payload de `join`. */
export function parseJoinData(data: unknown): JoinData | null {
  if (!isRecord(data)) return null;
  const { zone, version, guestToken } = data;
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return null;
  if (!isFiniteNumber(version) || !Number.isInteger(version)) return null;
  // Ausente ou null = primeiro acesso. Se vier, é string de tamanho razoável.
  if (guestToken === undefined || guestToken === null) return { zone, version, guestToken: null };
  if (typeof guestToken !== "string" || guestToken.length === 0 || guestToken.length > 128) return null;
  return { zone, version, guestToken };
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

  switch (decoded["type"]) {
    case ClientMessageType.Join: {
      const data = parseJoinData(decoded["data"]);
      return data === null ? null : { type: ClientMessageType.Join, data };
    }
    case ClientMessageType.Input: {
      const data = parseInputData(decoded["data"]);
      return data === null ? null : { type: ClientMessageType.Input, data };
    }
    default:
      return null;
  }
}

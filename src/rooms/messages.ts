/**
 * Contrato de mensagens cliente → servidor.
 *
 * ATENÇÃO: qualquer mudança aqui precisa ser espelhada no cliente
 * (mmo-client/scripts/network/network.gd) e documentada em mmo-docs [INFRA-04].
 */

/** Tipos de mensagem aceitos pelas rooms. */
export const MessageType = {
  /** Cliente informa a própria posição/rotação. Payload: {@link MoveMessage}. */
  Move: "move",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Payload de {@link MessageType.Move}. Unidades em metros; `rotY` em radianos. */
export interface MoveMessage {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** `true` se `value` for um número finito (rejeita NaN, Infinity e não-números). */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Valida um payload vindo da rede (não confiável).
 * @returns a mensagem tipada, ou `null` se o formato for inválido.
 */
export function parseMoveMessage(payload: unknown): MoveMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { x, y, z, rotY } = payload as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z) || !isFiniteNumber(rotY)) {
    return null;
  }
  return { x, y, z, rotY };
}

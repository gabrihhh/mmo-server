/**
 * Simulação de movimento COMPARTILHADA entre servidor e cliente. Ver mmo-docs [INFRA-09].
 *
 * O servidor é a autoridade: é ele que roda esta função para valer. O cliente roda a MESMA conta
 * para prever o próprio movimento sem esperar a rede (client-side prediction); se divergir, o
 * snapshot do servidor corrige (reconciliação). Por isso as duas versões precisam dar o mesmo resultado.
 *
 * ATENÇÃO: espelho em mmo-client/scripts/sim/movement.gd. Mudou aqui → mude lá (mesma ordem de
 * operações) e atualize mmo-docs [INFRA-09].
 */

/** Ticks de simulação por segundo (servidor e cliente). */
export const TICK_RATE_HZ = 20;

/** Duração de um tick, em segundos. */
export const TICK_SECONDS: number = 1 / TICK_RATE_HZ;

/** Velocidade de caminhada, em m/s. */
export const MOVE_SPEED = 5;

/** Abaixo deste comprimento o input é "parado" (não gira o personagem). */
const MIN_INPUT_LENGTH = 0.01;

/** Estado simulado de um personagem. Metros e radianos. */
export interface MoveState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** Direção desejada no mundo (plano XZ). Comprimento até 1 (maior é normalizado: anti-speedhack). */
export interface MoveInput {
  readonly x: number;
  readonly z: number;
}

/** Parâmetros da simulação (vêm da zona; o cliente recebe no `welcome`). */
export interface MoveParams {
  /** m/s. */
  readonly speed: number;
  /** Metade do lado da zona, em metros (posição limitada a ±halfSize em X e Z). */
  readonly halfSize: number;
}

/**
 * Aplica UM tick de input: anda `speed * dt` na direção pedida (comprimento ≤ 1), limita às bordas
 * e vira o personagem para a direção do movimento.
 */
export function stepMovement(state: MoveState, input: MoveInput, dt: number, params: MoveParams): MoveState {
  let dx: number = input.x;
  let dz: number = input.z;
  // sqrt(x²+z²) e não Math.hypot: é a mesma conta do GDScript, então dá o mesmo double nos dois lados.
  const length: number = Math.sqrt(dx * dx + dz * dz);
  if (length < MIN_INPUT_LENGTH) return state;
  if (length > 1) {
    dx /= length;
    dz /= length;
  }
  const limit: number = params.halfSize;
  return {
    x: Math.min(limit, Math.max(-limit, state.x + dx * params.speed * dt)),
    y: state.y,
    z: Math.min(limit, Math.max(-limit, state.z + dz * params.speed * dt)),
    // Mesma convenção do Godot: rotY = 0 olha para -Z.
    rotY: Math.atan2(-dx, -dz),
  };
}

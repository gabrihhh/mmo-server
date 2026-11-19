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
export const TICK_RATE_HZ = 30;

/** Duração de um tick, em segundos. */
export const TICK_SECONDS: number = 1 / TICK_RATE_HZ;

/** Velocidade de caminhada, em m/s. */
export const MOVE_SPEED = 5;

/** Abaixo deste comprimento o input é "parado" (não move nem gira; também não cancela lançamento). */
export const MIN_INPUT_LENGTH = 0.01;

/**
 * Posições ficam em **milímetros** ({@link POSITION_STEPS} passos por metro): cada passo da simulação arredonda X e Z
 * com {@link quantize}. O número vai curto na rede (fase 1 de desempenho, [INFRA-11]) e servidor e cliente arredondam
 * igual, então a previsão continua batendo exato.
 * > mudança (2026-11-15): era centímetro; a 30 Hz o passo tem 16,67 cm e virava 17 (andava 2% mais rápido, e
 * > diferente em cada direção). Em mm o erro é desprezível.
 */
export const POSITION_STEPS = 1000;

/**
 * Arredonda [value] (m) ao milímetro. `floor(v × 1000 + 0,5)` e não `Math.round`: o `round` do GDScript arredonda o
 * ,5 negativo para longe do zero e o do JS para cima — com `floor` os dois dão o mesmo double.
 * ATENÇÃO: espelho em mmo-client/scripts/sim/movement.gd (`quantize`).
 */
export function quantize(value: number): number {
  return Math.floor(value * POSITION_STEPS + 0.5) / POSITION_STEPS;
}

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
 * e vira o personagem para a direção do movimento. X e Z saem arredondados ao milímetro ({@link quantize}).
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
    x: quantize(Math.min(limit, Math.max(-limit, state.x + dx * params.speed * dt))),
    y: state.y,
    z: quantize(Math.min(limit, Math.max(-limit, state.z + dz * params.speed * dt))),
    // Mesma convenção do Godot: rotY = 0 olha para -Z.
    rotY: Math.atan2(-dx, -dz),
  };
}

/**
 * Um passo da Investida: desloca `distance` metros na direção (dirX, dirZ), limitado às bordas, e vira para ela.
 * A Investida inteira são vários destes, um por passo de movimento ([JOGO-07]). Direção quase zero = não faz nada. ATENÇÃO: espelho em mmo-client/scripts/sim/movement.gd (`dash`).
 */
export function dashMovement(state: MoveState, dirX: number, dirZ: number, distance: number, halfSize: number): MoveState {
  const length: number = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (length < MIN_INPUT_LENGTH) return state;
  const dx: number = dirX / length;
  const dz: number = dirZ / length;
  return {
    x: quantize(Math.min(halfSize, Math.max(-halfSize, state.x + dx * distance))),
    y: state.y,
    z: quantize(Math.min(halfSize, Math.max(-halfSize, state.z + dz * distance))),
    rotY: Math.atan2(-dx, -dz),
  };
}

/**
 * Limites da arena do Coliseu (mmo-docs [JOGO-28]): muro redondo e, na preparação e nas pausas, a barreira no meio.
 * Metros.
 */
export interface ArenaBounds {
  /** Raio do muro (centro na origem). */
  readonly radius: number;
  /**
   * Lado em que a barreira prende o jogador: -1 = só x ≤ −`barrierGap` (time 0), 1 = só x ≥ `barrierGap` (time 1),
   * 0 = barreira desligada.
   */
  readonly side: -1 | 0 | 1;
  /** Folga da barreira até o plano x = 0. */
  readonly barrierGap: number;
}

/**
 * Prende a posição dentro da arena, depois de cada passo/trecho de Investida: primeiro o muro (puxa para o círculo na
 * mesma direção), depois a barreira (x do lado do time). Dentro dos limites devolve o mesmo estado (sem quantizar de
 * novo). Mesma conta e ordem no cliente.
 */
export function constrainArena(state: MoveState, bounds: ArenaBounds): MoveState {
  let x: number = state.x;
  let z: number = state.z;
  const distance: number = Math.sqrt(x * x + z * z);
  if (distance > bounds.radius) {
    x = (x * bounds.radius) / distance;
    z = (z * bounds.radius) / distance;
  }
  if (bounds.side < 0) x = Math.min(x, -bounds.barrierGap);
  else if (bounds.side > 0) x = Math.max(x, bounds.barrierGap);
  if (x === state.x && z === state.z) return state;
  return { x: quantize(x), y: state.y, z: quantize(z), rotY: state.rotY };
}

/**
 * Evolução: nível e experiência (XP). Regras puras (sem banco nem rede). Ver mmo-docs [JOGO-12].
 *
 * Regra do grupo (2026-11-06): tudo cresce **1% por nível, acumulando** (× 1,01 a cada nível):
 * - força de quem tem o nível (jogador ou NPC): vida, mana, dano, cura e escudo × {@link levelFactor};
 * - XP para subir: 100 do nível 0 para o 1, e cada nível pede 1% a mais que o anterior ({@link xpToNextLevel});
 * - XP que um monstro dá: 20 no nível 1, e 1% a mais por nível ({@link xpReward}).
 * XP é guardada com 1 casa decimal (20,2), para o 1% contar desde os níveis baixos.
 * **Sem nível máximo** (decisão 2026-11-13: o jogo ainda não definiu se terá um).
 */

/** Nível de um personagem novo. */
export const STARTING_LEVEL = 0;

/** Crescimento por nível (1%, acumulando). */
export const LEVEL_GROWTH = 1.01;

/** XP para ir do nível 0 ao 1. */
export const BASE_XP_TO_LEVEL = 100;

/** XP que um monstro de nível 1 dá. */
export const BASE_XP_REWARD = 20;

/** Nível e XP guardados na conta. */
export interface Progress {
  /** Nível atual ({@link STARTING_LEVEL} ou mais; sem teto). */
  readonly level: number;
  /** XP juntada DENTRO do nível atual (0 até menos que {@link xpToNextLevel}(level)), 1 casa decimal; zera ao subir. */
  readonly xp: number;
}

/** Personagem novo: nível 0, sem XP. */
export const STARTING_PROGRESS: Progress = { level: STARTING_LEVEL, xp: 0 };

/** Arredonda a 1 casa decimal (XP guardada e enviada assim). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Multiplicador de força de quem está no nível `level` (1,01^nível: nível 0 = 1, nível 3 ≈ 1,0303). */
export function levelFactor(level: number): number {
  return LEVEL_GROWTH ** Math.max(0, level);
}

/**
 * XP que falta juntar no nível `level` para subir ao próximo: 100 × 1,01^nível (1 casa).
 * ATENÇÃO: o cliente não calcula isso — recebe pronto no snapshot (`me.xpNext`).
 */
export function xpToNextLevel(level: number): number {
  return round1(BASE_XP_TO_LEVEL * levelFactor(level));
}

/** XP que um monstro de nível `level` dá a quem o mata: 20 no nível 1, × 1,01 por nível acima (1 casa). */
export function xpReward(level: number): number {
  return round1(BASE_XP_REWARD * LEVEL_GROWTH ** (Math.max(1, level) - 1));
}

/**
 * Soma `amount` de XP, subindo quantos níveis couberem (a sobra passa para o nível seguinte).
 */
export function addXp(progress: Progress, amount: number): Progress {
  let level: number = progress.level;
  let xp: number = round1(progress.xp + Math.max(0, amount));
  while (xp >= xpToNextLevel(level)) {
    xp = round1(xp - xpToNextLevel(level));
    level += 1;
  }
  return { level, xp };
}

/** Lê o progresso guardado no banco; dado ausente/estragado (conta antiga) vira {@link STARTING_PROGRESS}. */
export function readProgress(raw: unknown): Progress {
  if (typeof raw !== "object" || raw === null) return STARTING_PROGRESS;
  const level: unknown = Reflect.get(raw, "level");
  const xp: unknown = Reflect.get(raw, "xp");
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level < STARTING_LEVEL) return STARTING_PROGRESS;
  const safeLevel: number = level;
  const safeXp: number = typeof xp === "number" && Number.isFinite(xp) ? round1(xp) : 0;
  return { level: safeLevel, xp: Math.min(Math.max(0, safeXp), round1(xpToNextLevel(safeLevel) - 0.1)) };
}

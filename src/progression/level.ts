/**
 * Evolução: nível e experiência (XP). Regras puras (sem banco nem rede). Ver mmo-docs [JOGO-12].
 *
 * Regras (2026-11-14; antes tudo era 1% acumulando):
 * - **jogador**: vida, mana, dano, cura e escudo ganham **1% da base do nível 0 por nível, SEM acumular**
 *   ({@link playerFactor}: nível 100 = × 2);
 * - **monstro**: vida e dano crescem **2% por nível, acumulando** ({@link monsterFactor}), e a vida dele ainda tem
 *   +20% ({@link MONSTER_EDGE}). A diferença para o jogador aumenta com o nível: no alto, só em grupo;
 * - XP para subir: 100 do nível 0 para o 1, e cada nível pede 1% a mais que o anterior ({@link xpToNextLevel});
 * - XP que um monstro dá: 20 no nível 1, e 1% a mais por nível ({@link xpReward}). Como as duas crescem igual, são
 *   sempre ~5 monstros do seu nível para subir um nível.
 * XP é guardada com 1 casa decimal (20,2), para o 1% contar desde os níveis baixos.
 * **Sem nível máximo** (decisão 2026-11-13: o jogo ainda não definiu se terá um).
 */

/** Nível de um personagem novo. */
export const STARTING_LEVEL = 0;

/** Crescimento da XP por nível (1%, acumulando): XP para subir e XP que o monstro dá. */
export const LEVEL_GROWTH = 1.01;

/** Quanto o jogador ganha por nível: 1% da força do nível 0 (soma, não acumula). */
export const PLAYER_GROWTH_PER_LEVEL = 0.01;

/** Crescimento do monstro por nível (2%, acumulando). */
export const MONSTER_GROWTH = 1.02;

/** Vantagem do monstro: vida × 1,2 sobre a dele (mais forte que um jogador do mesmo nível desde o começo). */
export const MONSTER_EDGE = 1.2;

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

/** Multiplicador da XP no nível `level` (1,01^nível: nível 0 = 1, nível 3 ≈ 1,0303). */
export function xpFactor(level: number): number {
  return LEVEL_GROWTH ** Math.max(0, level);
}

/** Força do jogador no nível `level`: 1 + 1% por nível (nível 0 = 1, nível 50 = 1,5, nível 100 = 2). */
export function playerFactor(level: number): number {
  return 1 + PLAYER_GROWTH_PER_LEVEL * Math.max(0, level);
}

/** Força (vida e dano) do monstro no nível `level`: 1,02^nível (nível 50 ≈ 2,69, nível 100 ≈ 7,24). */
export function monsterFactor(level: number): number {
  return MONSTER_GROWTH ** Math.max(0, level);
}

/**
 * XP que falta juntar no nível `level` para subir ao próximo: 100 × 1,01^nível (1 casa).
 * ATENÇÃO: o cliente não calcula isso — recebe pronto no snapshot (`me.xpNext`).
 */
export function xpToNextLevel(level: number): number {
  return round1(BASE_XP_TO_LEVEL * xpFactor(level));
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

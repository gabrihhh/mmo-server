/**
 * Evolução do personagem: nível e experiência (XP). Regras puras (sem banco nem rede). Ver mmo-docs [JOGO-12].
 * O nível é do PERSONAGEM (da conta), não dos itens. Números provisórios.
 */

/** Nível de um personagem novo. */
export const STARTING_LEVEL = 1;

/** Nível máximo (provisório): nele a XP para de contar. */
export const MAX_LEVEL = 50;

/** Nível e XP guardados na conta. */
export interface Progress {
  /** Nível atual (1..{@link MAX_LEVEL}). */
  readonly level: number;
  /** XP juntada DENTRO do nível atual (0..{@link xpToNextLevel}(level) − 1); zera ao subir. */
  readonly xp: number;
}

/** Personagem novo: nível 1, sem XP. */
export const STARTING_PROGRESS: Progress = { level: STARTING_LEVEL, xp: 0 };

/**
 * XP que falta juntar no nível `level` para subir ao próximo (provisório: 100 × nível). No nível máximo, 0.
 * ATENÇÃO: o cliente não calcula isso — recebe pronto no snapshot (`me.xpNext`).
 */
export function xpToNextLevel(level: number): number {
  return level >= MAX_LEVEL ? 0 : 100 * level;
}

/**
 * Soma `amount` de XP, subindo quantos níveis couberem (a sobra passa para o nível seguinte).
 * No nível máximo a XP fica em 0.
 */
export function addXp(progress: Progress, amount: number): Progress {
  let level: number = progress.level;
  let xp: number = progress.xp + Math.max(0, Math.floor(amount));
  while (level < MAX_LEVEL && xp >= xpToNextLevel(level)) {
    xp -= xpToNextLevel(level);
    level += 1;
  }
  return { level, xp: level >= MAX_LEVEL ? 0 : xp };
}

/** Lê o progresso guardado no banco; dado ausente/estragado (conta antiga) vira {@link STARTING_PROGRESS}. */
export function readProgress(raw: unknown): Progress {
  if (typeof raw !== "object" || raw === null) return STARTING_PROGRESS;
  const level: unknown = Reflect.get(raw, "level");
  const xp: unknown = Reflect.get(raw, "xp");
  if (typeof level !== "number" || !Number.isInteger(level) || level < STARTING_LEVEL) return STARTING_PROGRESS;
  const safeLevel: number = Math.min(level, MAX_LEVEL);
  const safeXp: number = typeof xp === "number" && Number.isFinite(xp) ? Math.floor(xp) : 0;
  return { level: safeLevel, xp: Math.min(Math.max(0, safeXp), Math.max(0, xpToNextLevel(safeLevel) - 1)) };
}

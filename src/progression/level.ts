/**
 * Evolução: nível e experiência (XP). Regras puras (sem banco nem rede). Ver mmo-docs [JOGO-12].
 *
 * Regras (2026-11-14; antes tudo era 1% acumulando, inclusive a XP):
 * - **jogador**: vida, mana, dano, cura e escudo ganham **1% da base do nível 0 por nível, SEM acumular**
 *   ({@link playerFactor}: nível 100 = × 2);
 * - **monstro**: vida e dano crescem **2% por nível, acumulando** ({@link monsterFactor}), e a vida dele ainda tem
 *   +20% ({@link MONSTER_EDGE}). A diferença para o jogador aumenta com o nível: no alto, só em grupo;
 * - XP para subir: 100 do nível 0 para o 1, e cada nível pede **2% a mais** que o anterior ({@link xpToNextLevel});
 * - XP que um monstro dá: 20 no nível 1, e **2% a mais por nível** ({@link xpReward}), o mesmo ritmo da força dele.
 *   Como as duas crescem igual, são sempre ~5 monstros do seu nível para subir um nível; monstro fraco rende cada vez
 *   menos (nível 60: 16 zumbis de nível 1 por nível), então no alto compensa caçar no seu nível, em grupo;
 * - **bônus de grupo**: cada jogador a mais na luta dá +10% de XP a todos ({@link groupXp}; 2026-11-14). Contam (e
 *   ganham) também os membros do grupo de quem lutou que estão a até 45 m do monstro (`Zone.ts`, mmo-docs [SOC-03]).
 * XP é guardada com 1 casa decimal (20,2), para o 1% contar desde os níveis baixos.
 * **Moedas** (2026-11-14, [JOGO-15]): o dinheiro do personagem fica junto do progresso; matar um monstro dá
 * {@link goldReward} do nível dele a cada um que ganha a XP (não divide, sem bônus de grupo).
 * **Sem nível máximo** (decisão 2026-11-13: o jogo ainda não definiu se terá um).
 */

/** Nível de um personagem novo. */
export const STARTING_LEVEL = 0;

/**
 * Crescimento da XP por nível (2%, acumulando): XP para subir e XP que o monstro dá. Igual ao
 * {@link MONSTER_GROWTH} de propósito: a recompensa acompanha a dificuldade do monstro. Antes (até 2026-11-14): 1%.
 */
export const XP_GROWTH = 1.02;

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

/**
 * Bônus de grupo: +10% da XP do monstro para cada jogador a mais que ganha a XP — participou da luta ou é membro do
 * grupo de quem participou e estava a até 45 m (mmo-docs [SOC-03]) — soma, sem teto.
 */
export const GROUP_XP_BONUS = 0.1;

/** Moedas que um monstro de nível 1 dá (a cada participante). Provisório: a economia ainda não foi decidida. */
export const BASE_GOLD_REWARD = 10;

/** Crescimento das moedas do monstro por nível (2%, acumulando: o mesmo ritmo da XP e da força dele). */
export const GOLD_GROWTH = 1.02;

/** Nível, XP e moedas guardados na conta. */
export interface Progress {
  /** Nível atual ({@link STARTING_LEVEL} ou mais; sem teto). */
  readonly level: number;
  /** XP juntada DENTRO do nível atual (0 até menos que {@link xpToNextLevel}(level)), 1 casa decimal; zera ao subir. */
  readonly xp: number;
  /** Moedas (dinheiro) do personagem: inteiro, 0 ou mais ([JOGO-15]). */
  readonly gold: number;
}

/** Personagem novo: nível 0, sem XP, sem moedas. */
export const STARTING_PROGRESS: Progress = { level: STARTING_LEVEL, xp: 0, gold: 0 };

/** Arredonda a 1 casa decimal (XP guardada e enviada assim). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Multiplicador da XP no nível `level` (1,02^nível: nível 0 = 1, nível 3 ≈ 1,0612). */
export function xpFactor(level: number): number {
  return XP_GROWTH ** Math.max(0, level);
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
 * XP que falta juntar no nível `level` para subir ao próximo: 100 × 1,02^nível (1 casa).
 * ATENÇÃO: o cliente não calcula isso — recebe pronto no snapshot (`me.xpNext`).
 */
export function xpToNextLevel(level: number): number {
  return round1(BASE_XP_TO_LEVEL * xpFactor(level));
}

/** XP que um monstro de nível `level` dá a cada participante: 20 no nível 1, × 1,02 por nível acima (1 casa). */
export function xpReward(level: number): number {
  return round1(BASE_XP_REWARD * XP_GROWTH ** (Math.max(1, level) - 1));
}

/**
 * XP que CADA participante ganha quando `players` jogadores lutaram juntos: a recompensa inteira + 10% por jogador a
 * mais (sozinho = × 1; 3 jogadores = × 1,2; 5 = × 1,4), 1 casa. Ninguém divide: o grupo só soma.
 */
export function groupXp(reward: number, players: number): number {
  return round1(reward * (1 + GROUP_XP_BONUS * Math.max(0, Math.floor(players) - 1)));
}

/**
 * Moedas que um monstro de nível `level` dá a cada participante: 10 no nível 1, × 1,02 por nível acima, arredondado
 * para inteiro (nível 10 = 12; nível 50 = 26; nível 100 = 71). [JOGO-15]
 */
export function goldReward(level: number): number {
  return Math.max(1, Math.round(BASE_GOLD_REWARD * GOLD_GROWTH ** (Math.max(1, level) - 1)));
}

/** Soma `amount` moedas (inteiro, nunca negativo). */
export function addGold(progress: Progress, amount: number): Progress {
  return { ...progress, gold: progress.gold + Math.max(0, Math.floor(amount)) };
}

/**
 * Soma `amount` de XP, subindo quantos níveis couberem (a sobra passa para o nível seguinte). As moedas não mudam.
 */
export function addXp(progress: Progress, amount: number): Progress {
  let level: number = progress.level;
  let xp: number = round1(progress.xp + Math.max(0, amount));
  while (xp >= xpToNextLevel(level)) {
    xp = round1(xp - xpToNextLevel(level));
    level += 1;
  }
  return { level, xp, gold: progress.gold };
}

/** Lê o progresso guardado no banco; dado ausente/estragado (conta antiga) vira {@link STARTING_PROGRESS}. */
export function readProgress(raw: unknown): Progress {
  if (typeof raw !== "object" || raw === null) return STARTING_PROGRESS;
  const level: unknown = Reflect.get(raw, "level");
  const xp: unknown = Reflect.get(raw, "xp");
  const gold: unknown = Reflect.get(raw, "gold");
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level < STARTING_LEVEL) return STARTING_PROGRESS;
  const safeLevel: number = level;
  const safeXp: number = typeof xp === "number" && Number.isFinite(xp) ? round1(xp) : 0;
  // Moedas: conta antiga (sem o campo) ou valor estragado = 0.
  const safeGold: number = typeof gold === "number" && Number.isSafeInteger(gold) && gold > 0 ? gold : 0;
  return { level: safeLevel, xp: Math.min(Math.max(0, safeXp), round1(xpToNextLevel(safeLevel) - 0.1)), gold: safeGold };
}

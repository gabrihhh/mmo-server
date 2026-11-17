/**
 * Contadores do perfil do jogador (mmo-docs [SOC-08]): XP ganha matando monstros, jogadores mortos e mortes. Regras
 * puras (sem banco nem rede). Começaram do zero quando a feature entrou (2026-11-17): não havia esses números antes.
 * São a base dos rankings ([SOC-07]).
 */

/** Contadores guardados na conta (campo `stats`). Nunca diminuem. */
export interface PlayerStats {
  /**
   * XP ganha matando monstros, somada a vida inteira (1 casa decimal): a XP que entrou de fato, com o bônus de grupo
   * ([JOGO-12]). Perder XP ao morrer não desconta.
   */
  readonly monsterXp: number;
  /** Jogadores de verdade que ele matou (PvP, [JOGO-22]); fake de teste não conta. */
  readonly kills: number;
  /** Vezes que morreu (para monstro e para jogador, [JOGO-21]). */
  readonly deaths: number;
}

/** Conta nova (e conta antiga, sem o campo): tudo zero. */
export const STARTING_STATS: PlayerStats = { monsterXp: 0, kills: 0, deaths: 0 };

/** Arredonda a 1 casa decimal (como a XP, [JOGO-12]). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Soma `amount` à XP de monstros (negativo/inválido = nada). */
export function addMonsterXp(stats: PlayerStats, amount: number): PlayerStats {
  if (!Number.isFinite(amount) || amount <= 0) return stats;
  return { ...stats, monsterXp: round1(stats.monsterXp + amount) };
}

/** +1 jogador morto. */
export function addKill(stats: PlayerStats): PlayerStats {
  return { ...stats, kills: stats.kills + 1 };
}

/** +1 morte. */
export function addDeath(stats: PlayerStats): PlayerStats {
  return { ...stats, deaths: stats.deaths + 1 };
}

/** Lê os contadores guardados no banco, campo a campo: ausente/estragado (conta antiga) vira 0. */
export function readStats(raw: unknown): PlayerStats {
  if (typeof raw !== "object" || raw === null) return STARTING_STATS;
  const monsterXp: unknown = Reflect.get(raw, "monsterXp");
  const kills: unknown = Reflect.get(raw, "kills");
  const deaths: unknown = Reflect.get(raw, "deaths");
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
  return {
    monsterXp: typeof monsterXp === "number" && Number.isFinite(monsterXp) && monsterXp > 0 ? round1(monsterXp) : 0,
    kills: count(kills),
    deaths: count(deaths),
  };
}

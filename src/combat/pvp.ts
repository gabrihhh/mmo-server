/**
 * Regras de jogador contra jogador ([JOGO-22]). Puro, testado em `test/pvp.test.ts`.
 *
 * - **Quem pode atacar quem:** só jogadores com até {@link PVP_MAX_LEVEL_GAP} níveis de diferença, e nenhum dos dois
 *   em cima das pedras da praça ({@link inSafeZone}). Membros do mesmo grupo nunca (regra do grupo, [SOC-03]).
 * - **Morte para jogador** (substitui a perda normal de morte, [JOGO-21]): quem morreu perde **1 nível** (não passa de
 *   0) e {@link PVP_GOLD_TRANSFER} das moedas; quem matou ganha **1 nível** e exatamente essas moedas (o dinheiro troca
 *   de mão, não é criado). A XP dentro do nível fica como estava (cortada para caber no nível de baixo).
 */
import { xpToNextLevel, type Progress } from "../progression/level.js";

/** Maior diferença de nível entre dois jogadores para um poder atacar o outro. ATENÇÃO: = PvpRules.MAX_LEVEL_GAP no cliente. */
export const PVP_MAX_LEVEL_GAP = 10;
/**
 * Metade do lado (m) da área segura: o quadrado de pedra da praça do spawn (20 × 20 m no centro, [MUN-03]). Em cima
 * dela ninguém ataca nem é atacado por jogador. ATENÇÃO: = SAFE_ZONE_HALF em mmo-client/scripts/combat/pvp_rules.gd.
 */
export const SAFE_ZONE_HALF = 10;
/** Fração das moedas de quem morreu que passa para quem matou. */
export const PVP_GOLD_TRANSFER = 0.1;

/** O ponto (x, z) está dentro do quadrado seguro de metade do lado [half] (m) no centro (0 = zona sem área segura)? */
export function inSafeZone(x: number, z: number, half: number = SAFE_ZONE_HALF): boolean {
  return half > 0 && Math.abs(x) <= half && Math.abs(z) <= half;
}

/** Os níveis [a] e [b] estão perto o bastante para PvP ({@link PVP_MAX_LEVEL_GAP})? */
export function pvpLevelsAllowed(a: number, b: number): boolean {
  return Math.abs(a - b) <= PVP_MAX_LEVEL_GAP;
}

/** Resultado de uma morte PvP: os dois progressos novos, as moedas que trocaram de mão e os níveis que o morto perdeu. */
export interface PvpKill {
  readonly killer: Progress;
  readonly victim: Progress;
  readonly goldMoved: number;
  readonly levelsLost: number;
}

/** Aplica uma morte PvP: [killer] matou [victim]. */
export function pvpKill(killer: Progress, victim: Progress): PvpKill {
  const goldMoved: number = Math.floor(victim.gold * PVP_GOLD_TRANSFER);
  const victimLevel: number = Math.max(0, victim.level - 1);
  const killerLevel: number = killer.level + 1;
  const fit = (xp: number, level: number): number => Math.min(xp, Math.max(0, Math.round((xpToNextLevel(level) - 0.1) * 10) / 10));
  return {
    killer: { ...killer, level: killerLevel, xp: fit(killer.xp, killerLevel), gold: killer.gold + goldMoved },
    victim: { ...victim, level: victimLevel, xp: fit(victim.xp, victimLevel), gold: victim.gold - goldMoved },
    goldMoved,
    levelsLost: victim.level - victimLevel,
  };
}

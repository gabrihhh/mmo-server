import { addGold, addXp, xpToNextLevel, type Progress } from "../progression/level.js";
import { dayKey } from "../progression/ranking.js";

/**
 * Prêmio e ranking do Coliseu (mmo-docs [JOGO-28], plans/plan-1/spec.md seções 5 e 7). Regras puras. Valores
 * provisórios, iguais nos 3 modos.
 *
 * | | Moedas | XP | Pontos de Coliseu | Ranking |
 * |---|---|---|---|---|
 * | Vencedor | 100 | 40% da XP que falta para o próximo nível | 10 | +20 |
 * | Perdedor / empate | 30 | 12% | 3 | −20 (empate 0) |
 * | Abandonou | 0 | 0 | 0 | −20 × tamanho do time |
 *
 * - VIP e poção de XP multiplicam **só moedas e XP**; Pontos de Coliseu e ranking nunca.
 * - Só as {@link DAILY_REWARD_LIMIT} primeiras partidas do dia (Brasília) dão moedas/XP/Pontos; o ranking sempre conta.
 * - Colega de quem abandonou que perdeu não perde ranking (prêmio de perdedor normal).
 * - Ranking nunca abaixo de 0.
 */

/** Moedas do vencedor. */
export const WIN_GOLD = 100;
/** Moedas de quem perdeu ou empatou. */
export const LOSS_GOLD = 30;
/** Fração da XP que falta para o próximo nível (no nível real) que o vencedor ganha. */
export const WIN_XP_FRACTION = 0.4;
/** Idem para quem perdeu ou empatou. */
export const LOSS_XP_FRACTION = 0.12;
/** Pontos de Coliseu do vencedor. */
export const WIN_COLOSSEUM_POINTS = 10;
/** Pontos de Coliseu de quem perdeu ou empatou. */
export const LOSS_COLOSSEUM_POINTS = 3;
/** Pontos de ranking que a vitória dá e a derrota tira; abandono tira isto × tamanho do time. */
export const RATING_STEP = 20;
/** Partidas premiadas (moedas/XP/Pontos) por dia de Brasília. */
export const DAILY_REWARD_LIMIT = 10;

/** Como a partida terminou para um jogador. */
export type ColosseumOutcome = "win" | "loss" | "draw" | "abandon";

/** O que um jogador ganha (ou perde) no fim da partida. */
export interface ColosseumReward {
  readonly gold: number;
  readonly xp: number;
  /** Pontos de Coliseu (só acumulam). */
  readonly points: number;
  /** Variação do ranking do modo (antes do piso 0). */
  readonly ratingDelta: number;
  /** `false` = passou do teto diário: sem moedas/XP/Pontos (o ranking conta igual). */
  readonly rewarded: boolean;
}

/** Contador de partidas premiadas do dia, salvo na conta. */
export interface DailyRewards {
  /** Dia de Brasília do contador ("2026-11-19"); outro dia = zerado. */
  readonly day: string;
  /** Partidas premiadas nesse dia. */
  readonly count: number;
}

/** Nada contado ainda. */
export const NO_DAILY_REWARDS: DailyRewards = { day: "", count: 0 };

/** Partidas premiadas hoje (zero se o contador é de outro dia). */
export function rewardsToday(daily: DailyRewards, nowMs: number): number {
  return daily.day === dayKey(nowMs) ? daily.count : 0;
}

/** Contador depois de uma partida premiada agora. */
export function countReward(daily: DailyRewards, nowMs: number): DailyRewards {
  return { day: dayKey(nowMs), count: rewardsToday(daily, nowMs) + 1 };
}

/** Dados de um jogador para calcular o prêmio. */
export interface RewardInput {
  readonly outcome: ColosseumOutcome;
  /** Nível REAL (da conta): a XP é uma fração do que falta nele. */
  readonly level: number;
  /** Jogadores por time no modo (abandono tira {@link RATING_STEP} × isto). */
  readonly teamSize: number;
  /** Algum colega do time abandonou (perdeu → não perde ranking). */
  readonly teammateAbandoned: boolean;
  /** VIP / poção de XP ([JOGO-27]). */
  readonly multipliers: { readonly xp: number; readonly gold: number };
  /** Partidas já premiadas hoje (antes desta). */
  readonly rewardedToday: number;
}

/** Prêmio de um jogador no fim da partida (ver a tabela no topo do arquivo). */
export function colosseumReward(input: RewardInput): ColosseumReward {
  if (input.outcome === "abandon") return { gold: 0, xp: 0, points: 0, ratingDelta: -RATING_STEP * input.teamSize, rewarded: false };
  const win: boolean = input.outcome === "win";
  const ratingDelta: number = win ? RATING_STEP : input.outcome === "draw" || input.teammateAbandoned ? 0 : -RATING_STEP;
  if (input.rewardedToday >= DAILY_REWARD_LIMIT) return { gold: 0, xp: 0, points: 0, ratingDelta, rewarded: false };
  const baseXp: number = xpToNextLevel(input.level) * (win ? WIN_XP_FRACTION : LOSS_XP_FRACTION);
  return {
    gold: Math.round((win ? WIN_GOLD : LOSS_GOLD) * input.multipliers.gold),
    xp: Math.round(baseXp * input.multipliers.xp * 10) / 10,
    points: win ? WIN_COLOSSEUM_POINTS : LOSS_COLOSSEUM_POINTS,
    ratingDelta,
    rewarded: true,
  };
}

/** Ranking novo: `current + delta`, nunca abaixo de 0. */
export function applyRating(current: number, delta: number): number {
  return Math.max(0, current + delta);
}

/** Progresso real depois do prêmio (moedas + XP, pode subir de nível). */
export function applyRewardToProgress(progress: Progress, reward: ColosseumReward): Progress {
  return addXp(addGold(progress, reward.gold), reward.xp);
}

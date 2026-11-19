/**
 * Quem ganha o round e a partida do Coliseu (mmo-docs [JOGO-28], plans/plan-1/spec.md seção 4). Regras puras: a
 * partida (`ArenaMatch`) junta o estado dos times no fim de cada tick e pergunta aqui.
 *
 * - Round acaba quando um time cai inteiro: o outro ganha 1 ponto; os dois caindo no mesmo tick = ninguém pontua.
 * - {@link ROUND_SECONDS} sem eliminação: ganha a maior **média de vida em %** (morto = 0, 1 casa decimal); empate →
 *   quem causou mais dano no round; empate também → ninguém pontua.
 * - Primeiro a {@link POINTS_TO_WIN} vence; {@link MAX_ROUNDS} jogados sem vencedor → mais pontos vence, placar igual =
 *   partida empatada.
 */

/** Duração máxima de um round, em segundos. */
export const ROUND_SECONDS = 180;
/** Preparação antes do round 1 (20 escolhas, barreira), em segundos. */
export const PREP_SECONDS = 60;
/** Pausa com o placar entre os rounds, em segundos. */
export const ROUND_PAUSE_SECONDS = 5;
/** Pontos para vencer a partida. */
export const POINTS_TO_WIN = 3;
/** Rounds no máximo por partida. */
export const MAX_ROUNDS = 9;

/** Índice do time (0 ou 1). */
export type TeamIndex = 0 | 1;

/** Estado de um time num instante do round. */
export interface TeamRoundState {
  /** Vida de cada jogador do time em fração da vida máxima (0..1; morto ou fora = 0). */
  readonly hpFractions: readonly number[];
  /** Dano causado pelo time no round (vida + escudo tirados dos inimigos). */
  readonly damage: number;
}

/** Resultado de um round: o time que pontua ou `null` (ninguém pontua). */
export type RoundWinner = TeamIndex | null;

/** `true` se o time ainda tem alguém de pé. */
export function teamAlive(team: TeamRoundState): boolean {
  return team.hpFractions.some((fraction) => fraction > 0);
}

/**
 * Round acabou por eliminação? `undefined` = os dois têm alguém de pé (continua); senão o vencedor ou `null` (os dois
 * caíram no mesmo tick).
 */
export function eliminationWinner(teams: readonly [TeamRoundState, TeamRoundState]): RoundWinner | undefined {
  const alive0: boolean = teamAlive(teams[0]);
  const alive1: boolean = teamAlive(teams[1]);
  if (alive0 && alive1) return undefined;
  if (alive0) return 0;
  if (alive1) return 1;
  return null;
}

/** Média de vida do time em %, com 1 casa (morto = 0). Time vazio = 0. */
export function averageHpPercent(team: TeamRoundState): number {
  if (team.hpFractions.length === 0) return 0;
  const sum: number = team.hpFractions.reduce((total, fraction) => total + Math.max(0, Math.min(1, fraction)), 0);
  return Math.round((sum / team.hpFractions.length) * 1000) / 10;
}

/** Fim do tempo: maior média de vida %; empate → mais dano; empate → ninguém (`null`). */
export function timeoutWinner(teams: readonly [TeamRoundState, TeamRoundState]): RoundWinner {
  const hp0: number = averageHpPercent(teams[0]);
  const hp1: number = averageHpPercent(teams[1]);
  if (hp0 !== hp1) return hp0 > hp1 ? 0 : 1;
  const damage0: number = Math.round(teams[0].damage * 10) / 10;
  const damage1: number = Math.round(teams[1].damage * 10) / 10;
  if (damage0 !== damage1) return damage0 > damage1 ? 0 : 1;
  return null;
}

/** Placar: pontos de cada time. */
export type Score = readonly [number, number];

/** Como está a partida depois de um round. */
export type MatchOutcome = { readonly over: false } | { readonly over: true; readonly winner: TeamIndex | null };

/**
 * A partida acabou com o placar `score` depois de `roundsPlayed` rounds? Primeiro a {@link POINTS_TO_WIN}; no limite
 * de {@link MAX_ROUNDS}, mais pontos vence e placar igual = empate (`winner: null`).
 */
export function matchOutcome(score: Score, roundsPlayed: number): MatchOutcome {
  if (score[0] >= POINTS_TO_WIN) return { over: true, winner: 0 };
  if (score[1] >= POINTS_TO_WIN) return { over: true, winner: 1 };
  if (roundsPlayed < MAX_ROUNDS) return { over: false };
  if (score[0] === score[1]) return { over: true, winner: null };
  return { over: true, winner: score[0] > score[1] ? 0 : 1 };
}

/** Soma o ponto do round `winner` ao placar. */
export function addRoundPoint(score: Score, winner: RoundWinner): Score {
  if (winner === null) return score;
  return winner === 0 ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
}

import { dayKey, weekKey } from "../progression/ranking.js";
import { COLOSSEUM_MODES, type ColosseumMode } from "./build.js";
import { NO_DAILY_REWARDS, applyRating, countReward, type ColosseumReward, type DailyRewards } from "./rewards.js";

/**
 * O que o Coliseu guarda na conta (campo `colosseum`, mmo-docs [JOGO-28], plans/plan-1/spec.md seções 5–7): ranking
 * por modo, Pontos de Coliseu, bloqueio da fila, teto diário de partidas premiadas e o saldo do dia/semana para os
 * rankings diário e semanal. Regras puras.
 */

/** Pontos de cada modo. */
export type ModePoints = Readonly<Record<ColosseumMode, number>>;

/** Nada em nenhum modo. */
export const NO_MODE_POINTS: ModePoints = { "1x1": 0, "2x2": 0, "3x3": 0 };

/** Dados do Coliseu na conta. */
export interface ColosseumRecord {
  /** Ranking atual de cada modo (nunca abaixo de 0): o ranking global. */
  readonly rating: ModePoints;
  /** Pontos de Coliseu juntados (só acumulam; a loja é outra feature). */
  readonly points: number;
  /** Até quando (ms) não pode entrar na fila (abandono 10 min, recusas seguidas 2 min); 0 = livre. */
  readonly banUntil: number;
  /** Partidas premiadas do dia (teto {@link DAILY_REWARD_LIMIT}). */
  readonly daily: DailyRewards;
  /** Dia de Brasília do saldo diário. */
  readonly day: string;
  /** Saldo de ranking ganho no dia, por modo (pode ser negativo; o ranking diário mostra só o positivo). */
  readonly dayNet: ModePoints;
  /** Segunda-feira (dia de Brasília) do saldo semanal. */
  readonly week: string;
  /** Saldo de ranking ganho na semana, por modo. */
  readonly weekNet: ModePoints;
}

/** Conta nova/antiga: nada. */
export const EMPTY_COLOSSEUM_RECORD: ColosseumRecord = {
  rating: NO_MODE_POINTS,
  points: 0,
  banUntil: 0,
  daily: NO_DAILY_REWARDS,
  day: "",
  dayNet: NO_MODE_POINTS,
  week: "",
  weekNet: NO_MODE_POINTS,
};

/** Bloqueio por abandono (ms): 10 min sem fila. */
export const ABANDON_BAN_MS = 10 * 60_000;

/** `record` com o bloqueio até `untilMs` (fica o maior dos dois). */
export function withBan(record: ColosseumRecord, untilMs: number): ColosseumRecord {
  return { ...record, banUntil: Math.max(record.banUntil, untilMs) };
}

/**
 * Aplica o fim de uma partida do modo `mode`: ranking (piso 0), Pontos de Coliseu, contador diário (se foi premiada) e o
 * saldo do dia/semana (o que o ranking realmente mudou, depois do piso).
 */
export function applyMatchToRecord(record: ColosseumRecord, mode: ColosseumMode, reward: ColosseumReward, nowMs: number): ColosseumRecord {
  const before: number = record.rating[mode];
  const after: number = applyRating(before, reward.ratingDelta);
  const change: number = after - before;
  const today: string = dayKey(nowMs);
  const thisWeek: string = weekKey(nowMs);
  const dayNet: ModePoints = record.day === today ? record.dayNet : NO_MODE_POINTS;
  const weekNet: ModePoints = record.week === thisWeek ? record.weekNet : NO_MODE_POINTS;
  return {
    ...record,
    rating: { ...record.rating, [mode]: after },
    points: record.points + reward.points,
    daily: reward.rewarded ? countReward(record.daily, nowMs) : record.daily,
    day: today,
    dayNet: { ...dayNet, [mode]: dayNet[mode] + change },
    week: thisWeek,
    weekNet: { ...weekNet, [mode]: weekNet[mode] + change },
  };
}

/** Número inteiro ≥ 0 de `raw[key]` (dado do banco não confiável); senão 0. */
function count(raw: object, key: string): number {
  const value: unknown = Reflect.get(raw, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Inteiro (pode ser negativo) de `raw[key]`; senão 0. */
function integer(raw: object, key: string): number {
  const value: unknown = Reflect.get(raw, key);
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/** Texto de `raw[key]`; senão "". */
function text(raw: object, key: string): string {
  const value: unknown = Reflect.get(raw, key);
  return typeof value === "string" ? value : "";
}

/** Pontos por modo guardados no banco; `signed` aceita negativo (saldo). */
function readModePoints(raw: unknown, signed: boolean): ModePoints {
  if (typeof raw !== "object" || raw === null) return NO_MODE_POINTS;
  const read = (mode: ColosseumMode): number => (signed ? integer(raw, mode) : count(raw, mode));
  const result: Record<ColosseumMode, number> = { "1x1": 0, "2x2": 0, "3x3": 0 };
  for (const mode of COLOSSEUM_MODES) result[mode] = read(mode);
  return result;
}

/** Lê o campo `colosseum` do banco; ausente/estragado (conta antiga) vira {@link EMPTY_COLOSSEUM_RECORD}. */
export function readColosseumRecord(raw: unknown): ColosseumRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_COLOSSEUM_RECORD;
  const dailyRaw: unknown = Reflect.get(raw, "daily");
  const daily: DailyRewards =
    typeof dailyRaw === "object" && dailyRaw !== null ? { day: text(dailyRaw, "day"), count: count(dailyRaw, "count") } : NO_DAILY_REWARDS;
  return {
    rating: readModePoints(Reflect.get(raw, "rating"), false),
    points: count(raw, "points"),
    banUntil: count(raw, "banUntil"),
    daily,
    day: text(raw, "day"),
    dayNet: readModePoints(Reflect.get(raw, "dayNet"), true),
    week: text(raw, "week"),
    weekNet: readModePoints(Reflect.get(raw, "weekNet"), true),
  };
}

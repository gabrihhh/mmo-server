/**
 * Rankings (mmo-docs [SOC-07]): contadores do dia e da semana e o cálculo das tabelas. Regras puras (sem banco nem
 * rede); o `GameServer` guarda os contadores na conta e o {@link RankingBoards} monta as tabelas a partir das contas.
 *
 * - **Monstros** = XP ganha matando monstros; **PvP** = jogadores mortos. **Guilda** = soma dos membros ATUAIS (quem
 *   sai leva os números consigo e passa a somar na guilda nova).
 * - Períodos: **diário** (vira à meia-noite de Brasília), **semanal** (vira segunda-feira à meia-noite de Brasília) e
 *   **global** (a vida inteira = os contadores do perfil, [SOC-08]). Tudo começou do zero em 2026-11-17.
 * - Brasília = UTC−3 fixo (o Brasil não tem horário de verão desde 2019).
 */

import type { PlayerStats } from "./stats.js";

/** Fuso de Brasília em relação ao UTC (horas). */
export const BRASILIA_OFFSET_HOURS = -3;
const OFFSET_MS: number = BRASILIA_OFFSET_HOURS * 3_600_000;
const DAY_MS = 86_400_000;

/** Categorias de ranking. ATENÇÃO: mmo-client/scripts/network/ranking_data.gd (CATEGORY_*). */
export const RANKING_CATEGORIES = ["monsters", "pvp", "guild_monsters", "guild_pvp"] as const;
export type RankingCategory = (typeof RANKING_CATEGORIES)[number];
/** Períodos. ATENÇÃO: mmo-client/scripts/network/ranking_data.gd (PERIOD_*). */
export const RANKING_PERIODS = ["daily", "weekly", "global"] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

/** Quantos aparecem em cada tabela. */
export const RANKING_TOP = 100;

/** Contadores do dia e da semana guardados na conta (campo `periods`). Chave velha = o período virou: vale zero. */
export interface PeriodCounters {
  /** Dia de Brasília dos contadores diários ("2026-11-17"). */
  readonly day: string;
  readonly dayMonsterXp: number;
  readonly dayKills: number;
  /** Segunda-feira (dia de Brasília) da semana dos contadores semanais ("2026-11-16"). */
  readonly week: string;
  readonly weekMonsterXp: number;
  readonly weekKills: number;
}

/** Conta nova/antiga: nada contado. */
export const EMPTY_PERIODS: PeriodCounters = { day: "", dayMonsterXp: 0, dayKills: 0, week: "", weekMonsterXp: 0, weekKills: 0 };

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** "AAAA-MM-DD" de uma data já deslocada para Brasília. */
function isoDay(shifted: Date): string {
  return shifted.toISOString().slice(0, 10);
}

/** Dia de Brasília no instante [nowMs] ("2026-11-17"). */
export function dayKey(nowMs: number): string {
  return isoDay(new Date(nowMs + OFFSET_MS));
}

/** Segunda-feira (dia de Brasília) da semana do instante [nowMs]. */
export function weekKey(nowMs: number): string {
  const shifted: Date = new Date(nowMs + OFFSET_MS);
  const sinceMonday: number = (shifted.getUTCDay() + 6) % 7;
  return isoDay(new Date(shifted.getTime() - sinceMonday * DAY_MS));
}

/** Segundos até o período virar (diário: meia-noite; semanal: segunda à meia-noite; global: nunca = 0). */
export function secondsUntilReset(period: RankingPeriod, nowMs: number): number {
  if (period === "global") return 0;
  const shifted: number = nowMs + OFFSET_MS;
  const nextMidnight: number = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
  let target: number = nextMidnight;
  if (period === "weekly") {
    const day: number = new Date(shifted).getUTCDay();
    const daysToMonday: number = (8 - day) % 7;
    target = nextMidnight + ((daysToMonday === 0 ? 7 : daysToMonday) - 1) * DAY_MS;
  }
  return Math.max(1, Math.ceil((target - shifted) / 1000));
}

/**
 * Soma [monsterXp] e [kills] aos contadores do dia/semana de [nowMs] (período virado = recomeça do zero). Valores
 * negativos não descontam.
 */
export function addToPeriods(counters: PeriodCounters, monsterXp: number, kills: number, nowMs: number): PeriodCounters {
  const xp: number = Number.isFinite(monsterXp) && monsterXp > 0 ? monsterXp : 0;
  const killed: number = Number.isFinite(kills) && kills > 0 ? Math.floor(kills) : 0;
  if (xp === 0 && killed === 0) return counters;
  const day: string = dayKey(nowMs);
  const week: string = weekKey(nowMs);
  const sameDay: boolean = counters.day === day;
  const sameWeek: boolean = counters.week === week;
  return {
    day,
    dayMonsterXp: round1((sameDay ? counters.dayMonsterXp : 0) + xp),
    dayKills: (sameDay ? counters.dayKills : 0) + killed,
    week,
    weekMonsterXp: round1((sameWeek ? counters.weekMonsterXp : 0) + xp),
    weekKills: (sameWeek ? counters.weekKills : 0) + killed,
  };
}

/** Lê os contadores do banco campo a campo (ausente/estragado = vazio). */
export function readPeriods(raw: unknown): PeriodCounters {
  if (typeof raw !== "object" || raw === null) return EMPTY_PERIODS;
  const text = (key: string): string => {
    const value: unknown = Reflect.get(raw, key);
    return typeof value === "string" ? value : "";
  };
  const num = (key: string): number => {
    const value: unknown = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? round1(value) : 0;
  };
  return {
    day: text("day"),
    dayMonsterXp: num("dayMonsterXp"),
    dayKills: Math.floor(num("dayKills")),
    week: text("week"),
    weekMonsterXp: num("weekMonsterXp"),
    weekKills: Math.floor(num("weekKills")),
  };
}

/** Uma conta como entra no cálculo do ranking. */
export interface RankingSource {
  readonly id: string;
  readonly name: string;
  readonly stats: PlayerStats;
  readonly periods: PeriodCounters;
}

/** Valor de [source] no ranking de jogador [category] ("monsters"/"pvp") e [period], no instante [nowMs]. */
export function playerValue(source: RankingSource, category: "monsters" | "pvp", period: RankingPeriod, nowMs: number): number {
  const monsters: boolean = category === "monsters";
  if (period === "global") return monsters ? source.stats.monsterXp : source.stats.kills;
  if (period === "daily") {
    if (source.periods.day !== dayKey(nowMs)) return 0;
    return monsters ? source.periods.dayMonsterXp : source.periods.dayKills;
  }
  if (source.periods.week !== weekKey(nowMs)) return 0;
  return monsters ? source.periods.weekMonsterXp : source.periods.weekKills;
}

/** Uma linha da tabela. */
export interface RankRow {
  /** Posição (1 = primeiro). */
  readonly rank: number;
  /** Id do jogador ou da guilda. */
  readonly id: string;
  /** Nome do jogador, ou "[TAG] Nome" da guilda. */
  readonly name: string;
  readonly value: number;
}

/** Ordena do maior para o menor (empate: nome) e numera; valor zero fica de fora. */
export function rankRows(rows: ReadonlyArray<{ readonly id: string; readonly name: string; readonly value: number }>): RankRow[] {
  return rows
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "pt-BR"))
    .map((row, index) => ({ rank: index + 1, id: row.id, name: row.name, value: round1(row.value) }));
}

/** Uma guilda como entra no ranking de guilda: id, "[TAG] Nome" e os ids dos membros atuais. */
export interface GuildRankingSource {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
}

/**
 * Todas as tabelas, calculadas de uma vez a partir das contas ([sources]) e das guildas ([guilds]) no instante
 * [nowMs]. Guarda a lista inteira (não só o top 100) para achar a posição de qualquer um.
 */
export class RankingBoards {
  private readonly boards: Map<string, RankRow[]> = new Map();

  constructor(sources: readonly RankingSource[], guilds: readonly GuildRankingSource[], readonly builtAtMs: number) {
    const byId: Map<string, RankingSource> = new Map(sources.map((s) => [s.id, s]));
    for (const period of RANKING_PERIODS) {
      for (const category of ["monsters", "pvp"] as const) {
        this.boards.set(RankingBoards.key(category, period), rankRows(sources.map((s) => ({ id: s.id, name: s.name, value: playerValue(s, category, period, builtAtMs) }))));
        const guildCategory: RankingCategory = category === "monsters" ? "guild_monsters" : "guild_pvp";
        this.boards.set(
          RankingBoards.key(guildCategory, period),
          rankRows(guilds.map((g) => ({
            id: g.id,
            name: g.name,
            value: g.memberIds.reduce((sum, id) => {
              const source: RankingSource | undefined = byId.get(id);
              return sum + (source === undefined ? 0 : playerValue(source, category, period, builtAtMs));
            }, 0),
          }))),
        );
      }
    }
  }

  /** As [RANKING_TOP] primeiras linhas. */
  top(category: RankingCategory, period: RankingPeriod): RankRow[] {
    return (this.boards.get(RankingBoards.key(category, period)) ?? []).slice(0, RANKING_TOP);
  }

  /** A linha de [id] (jogador ou guilda), ou `null` se ainda não pontuou. */
  rowOf(category: RankingCategory, period: RankingPeriod, id: string): RankRow | null {
    return (this.boards.get(RankingBoards.key(category, period)) ?? []).find((row) => row.id === id) ?? null;
  }

  private static key(category: RankingCategory, period: RankingPeriod): string {
    return `${category}:${period}`;
  }
}

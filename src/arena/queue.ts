import { COLOSSEUM_MODES, TEAM_COMPOSITION, roleAllowed, roleOf, type ArenaBuild, type ArenaRole, type ColosseumMode } from "./build.js";

/**
 * Fila do Coliseu (mmo-docs [JOGO-28], plans/plan-1/spec.md seção 1). Regras puras: o relógio (`nowMs`) vem de fora e
 * ninguém aqui manda mensagem — quem usa (o `Colosseum`) avisa os jogadores pelo que cada método devolve.
 *
 * - Uma fila por modo, **por ordem de chegada** (não olha ranking). Uma fila por vez por jogador.
 * - Partida montada = os jogadores saem da fila na hora (síncrono, sem corrida) e entram na **janela de aceite**
 *   ({@link ACCEPT_WINDOW_MS}). Todos aceitaram → começa. Alguém recusou, não respondeu ou saiu → a partida cai, quem
 *   não aceitou sai da fila e os outros **voltam à frente** (com a ordem de chegada original).
 * - {@link MAX_CONSECUTIVE_DECLINES} recusas seguidas = {@link DECLINE_BAN_MS} sem fila (o bloqueio é salvo na conta
 *   por quem usa; aqui só o contador de recusas, que zera ao aceitar).
 * - No máximo {@link MAX_ACTIVE_MATCHES} partidas ao mesmo tempo (contando as em aceite); acima disso a fila espera.
 */

/** Janela "Partida encontrada — Aceitar / Recusar", em ms. */
export const ACCEPT_WINDOW_MS = 15_000;
/** Recusas (ou deixar passar) seguidas que bloqueiam a fila. */
export const MAX_CONSECUTIVE_DECLINES = 2;
/** Bloqueio por recusas seguidas, em ms (2 min). */
export const DECLINE_BAN_MS = 2 * 60_000;
/** Partidas simultâneas (VPS de 1 vCPU, [DEPLOY-01]); acima disso a fila espera. */
export const MAX_ACTIVE_MATCHES = 20;

/** Um jogador esperando na fila. */
export interface QueueEntry {
  readonly playerId: string;
  readonly mode: ColosseumMode;
  readonly build: ArenaBuild;
  readonly role: ArenaRole;
  /** Ordem de chegada (menor = chegou antes); quem volta de uma partida que caiu mantém a sua. */
  readonly order: number;
}

/** Partida montada esperando todos aceitarem. */
export interface PendingMatch {
  readonly id: string;
  readonly mode: ColosseumMode;
  /** Os dois times (time 0 e time 1), cada um com a composição do modo. */
  readonly teams: readonly [readonly QueueEntry[], readonly QueueEntry[]];
  /** Até quando dá para aceitar (ms). */
  readonly deadlineMs: number;
  /** Quem já aceitou. */
  readonly accepted: Set<string>;
}

/** Por que um jogador não pôde entrar na fila. */
export type QueueJoinFailure = "already_queued" | "healer_not_allowed" | "queue_banned";

/** Resultado de entrar na fila. */
export type QueueJoinResult = { readonly ok: true } | { readonly ok: false; readonly reason: QueueJoinFailure };

/** Bloqueio novo por recusas seguidas: quem e até quando (ms). */
export interface QueueBan {
  readonly playerId: string;
  readonly untilMs: number;
}

/** Como terminou uma janela de aceite. */
export type AcceptResolution =
  /** Todos aceitaram: a partida começa com estes times. */
  | { readonly kind: "start"; readonly match: PendingMatch }
  /**
   * A partida caiu: `refused` (recusou, não respondeu ou saiu) saiu da fila; `returned` voltou à frente da fila;
   * `bans` = bloqueios novos por recusas seguidas.
   */
  | {
      readonly kind: "cancel";
      readonly match: PendingMatch;
      readonly refused: readonly string[];
      readonly returned: readonly string[];
      readonly bans: readonly QueueBan[];
    };

/** Onde um jogador está na fila. */
export type QueueStatus =
  | { readonly kind: "none" }
  | { readonly kind: "queued"; readonly mode: ColosseumMode }
  | { readonly kind: "pending"; readonly match: PendingMatch };

/** Opções (os testes encurtam os tempos). */
export interface ColosseumQueueOptions {
  readonly acceptWindowMs?: number;
  readonly maxActiveMatches?: number;
}

/** Fila do Coliseu (ver o topo do arquivo). */
export class ColosseumQueue {
  private readonly queues: Map<ColosseumMode, QueueEntry[]> = new Map(COLOSSEUM_MODES.map((mode) => [mode, []]));
  private readonly pending: Map<string, PendingMatch> = new Map();
  /** Partida em aceite de cada jogador. */
  private readonly pendingOf: Map<string, PendingMatch> = new Map();
  /** Recusas seguidas de cada jogador (zera ao aceitar; some ao bloquear). */
  private readonly declines: Map<string, number> = new Map();
  private nextOrder: number = 1;
  private nextMatchId: number = 1;
  private readonly acceptWindowMs: number;
  private readonly maxActiveMatches: number;

  constructor(options: ColosseumQueueOptions = {}) {
    this.acceptWindowMs = options.acceptWindowMs ?? ACCEPT_WINDOW_MS;
    this.maxActiveMatches = options.maxActiveMatches ?? MAX_ACTIVE_MATCHES;
  }

  /**
   * Entra na fila do `mode` com a `build`. `banUntilMs` = bloqueio salvo na conta (abandono/recusas; 0 = nenhum).
   * Quem já está em fila ou em aceite é recusado (uma fila por vez); healer é recusado no 1x1. As outras condições
   * (praça, vivo, convidado, já em partida) são de quem chama.
   */
  join(playerId: string, mode: ColosseumMode, build: ArenaBuild, nowMs: number, banUntilMs: number): QueueJoinResult {
    if (this.status(playerId).kind !== "none") return { ok: false, reason: "already_queued" };
    if (nowMs < banUntilMs) return { ok: false, reason: "queue_banned" };
    const role: ArenaRole = roleOf(build);
    if (!roleAllowed(mode, role)) return { ok: false, reason: "healer_not_allowed" };
    this.queueOf(mode).push({ playerId, mode, build, role, order: this.nextOrder++ });
    return { ok: true };
  }

  /**
   * Sai da fila (botão, saiu da praça, desconectou). Esperando na fila: só sai (não conta recusa). Na janela de
   * aceite: conta como **recusa** e a partida cai (devolve a resolução). Fora da fila: `null`.
   */
  leave(playerId: string, nowMs: number): AcceptResolution | null {
    const match: PendingMatch | undefined = this.pendingOf.get(playerId);
    if (match !== undefined) return this.decline(playerId, nowMs);
    for (const queue of this.queues.values()) {
      const index: number = queue.findIndex((entry) => entry.playerId === playerId);
      if (index >= 0) queue.splice(index, 1);
    }
    return null;
  }

  /** Onde `playerId` está: fora, esperando num modo ou numa janela de aceite. */
  status(playerId: string): QueueStatus {
    const match: PendingMatch | undefined = this.pendingOf.get(playerId);
    if (match !== undefined) return { kind: "pending", match };
    for (const [mode, queue] of this.queues) if (queue.some((entry) => entry.playerId === playerId)) return { kind: "queued", mode };
    return { kind: "none" };
  }

  /** Quantos esperam na fila do `mode` (tela do Coliseu). */
  waiting(mode: ColosseumMode): number {
    return this.queueOf(mode).length;
  }

  /**
   * Monta as partidas que dá: por modo, pega por ordem de chegada os primeiros DPS e healers que fecham os dois times
   * e abre a janela de aceite. `activeMatches` = partidas em andamento (as em aceite já contam aqui dentro). Devolve
   * as partidas novas (quem chama manda "Partida encontrada").
   */
  tryMatch(nowMs: number, activeMatches: number): PendingMatch[] {
    const created: PendingMatch[] = [];
    for (const mode of COLOSSEUM_MODES) {
      while (activeMatches + this.pending.size < this.maxActiveMatches) {
        const match: PendingMatch | null = this.matchFrom(mode, nowMs);
        if (match === null) break;
        created.push(match);
      }
    }
    return created;
  }

  /**
   * `playerId` aceitou a partida em que está. Idempotente (aceitar de novo não muda nada). Todos aceitaram → devolve
   * `start` (a partida sai da fila); senão `waiting`. Fora de uma janela de aceite: `not_pending`.
   */
  accept(playerId: string): AcceptResolution | "waiting" | "not_pending" {
    const match: PendingMatch | undefined = this.pendingOf.get(playerId);
    if (match === undefined) return "not_pending";
    match.accepted.add(playerId);
    this.declines.delete(playerId);
    if (match.teams.some((team) => team.some((entry) => !match.accepted.has(entry.playerId)))) return "waiting";
    this.close(match);
    return { kind: "start", match };
  }

  /** `playerId` recusou a partida em que está: ela cai (ver {@link AcceptResolution}). Fora de uma: `null`. */
  decline(playerId: string, nowMs: number): AcceptResolution | null {
    const match: PendingMatch | undefined = this.pendingOf.get(playerId);
    if (match === undefined) return null;
    return this.cancel(match, [playerId], nowMs);
  }

  /** Janelas de aceite vencidas: quem não aceitou conta como recusa. Chamar a cada tick. */
  expire(nowMs: number): AcceptResolution[] {
    const resolutions: AcceptResolution[] = [];
    for (const match of [...this.pending.values()]) {
      if (nowMs < match.deadlineMs) continue;
      const missing: string[] = match.teams.flat().filter((entry) => !match.accepted.has(entry.playerId)).map((entry) => entry.playerId);
      resolutions.push(this.cancel(match, missing, nowMs));
    }
    return resolutions;
  }

  /** Esquece o contador de recusas de `playerId` (testes; o bloqueio em si fica na conta). */
  resetDeclines(playerId: string): void {
    this.declines.delete(playerId);
  }

  private queueOf(mode: ColosseumMode): QueueEntry[] {
    const queue: QueueEntry[] | undefined = this.queues.get(mode);
    if (queue === undefined) throw new Error(`fila sem o modo ${mode}`);
    return queue;
  }

  /** Uma partida do `mode` com os primeiros da fila que fecham os dois times, ou `null` se faltar gente. */
  private matchFrom(mode: ColosseumMode, nowMs: number): PendingMatch | null {
    const queue: QueueEntry[] = this.queueOf(mode);
    const composition = TEAM_COMPOSITION[mode];
    const dps: QueueEntry[] = queue.filter((entry) => entry.role === "dps").slice(0, composition.dps * 2);
    const healers: QueueEntry[] = queue.filter((entry) => entry.role === "healer").slice(0, composition.healer * 2);
    if (dps.length < composition.dps * 2 || healers.length < composition.healer * 2) return null;
    // Alterna entre os times na ordem de chegada (o 1º DPS vai para o time 0, o 2º para o time 1...).
    const teamA: QueueEntry[] = [];
    const teamB: QueueEntry[] = [];
    for (const list of [dps, healers]) list.forEach((entry, index) => (index % 2 === 0 ? teamA : teamB).push(entry));
    const chosen: Set<string> = new Set([...teamA, ...teamB].map((entry) => entry.playerId));
    this.queues.set(mode, queue.filter((entry) => !chosen.has(entry.playerId)));
    const match: PendingMatch = {
      id: `m${this.nextMatchId++}`,
      mode,
      teams: [teamA, teamB],
      deadlineMs: nowMs + this.acceptWindowMs,
      accepted: new Set(),
    };
    this.pending.set(match.id, match);
    for (const id of chosen) this.pendingOf.set(id, match);
    return match;
  }

  /** Tira a partida da janela de aceite (começou ou caiu). */
  private close(match: PendingMatch): void {
    this.pending.delete(match.id);
    for (const entry of match.teams.flat()) if (this.pendingOf.get(entry.playerId) === match) this.pendingOf.delete(entry.playerId);
  }

  /** A partida cai: `refusedIds` sai (conta recusa, pode bloquear); os outros voltam à frente com a ordem original. */
  private cancel(match: PendingMatch, refusedIds: readonly string[], nowMs: number): AcceptResolution {
    this.close(match);
    const refused: Set<string> = new Set(refusedIds);
    const bans: QueueBan[] = [];
    for (const id of refused) {
      const count: number = (this.declines.get(id) ?? 0) + 1;
      if (count >= MAX_CONSECUTIVE_DECLINES) {
        this.declines.delete(id);
        bans.push({ playerId: id, untilMs: nowMs + DECLINE_BAN_MS });
      } else {
        this.declines.set(id, count);
      }
    }
    const back: QueueEntry[] = match.teams.flat().filter((entry) => !refused.has(entry.playerId));
    const queue: QueueEntry[] = this.queueOf(match.mode);
    // Ordem de chegada original: quem voltou chegou antes de quem entrou durante a janela, então fica na frente.
    this.queues.set(match.mode, [...back, ...queue].sort((a, b) => a.order - b.order));
    return { kind: "cancel", match, refused: [...refused], returned: back.map((entry) => entry.playerId), bans };
  }
}

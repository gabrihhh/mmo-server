import type { AttributeId } from "../items/attributes.js";
import type { EquipSlot } from "../items/catalog.js";
import {
  attributeEffectsOf,
  basicAttackOf,
  bonusHpOf,
  equippedAbilities,
  lookLevelsOf,
  lookOf,
  type Inventory,
} from "../items/inventory.js";
import type { BodyType } from "../net/protocol.js";
import { STARTING_STATS } from "../progression/stats.js";
import { TICK_RATE_HZ } from "../sim/movement.js";
import { Zone, type JoinResult, type SpawnPoint, type ZoneMember } from "../zones/Zone.js";
import {
  ARENA_PROGRESS,
  NO_ARENA_POINTS,
  PREP_CHOICES,
  applyPrepPoint,
  arenaInventory,
  fillRemainingPoints,
  type ArenaBuild,
  type ArenaPoints,
  type ColosseumMode,
  type PrepPointFailure,
} from "./build.js";
import type { ColosseumOutcome } from "./rewards.js";
import {
  PREP_SECONDS,
  ROUND_PAUSE_SECONDS,
  ROUND_SECONDS,
  addRoundPoint,
  eliminationWinner,
  matchOutcome,
  timeoutWinner,
  type MatchOutcome,
  type RoundWinner,
  type Score,
  type TeamIndex,
  type TeamRoundState,
} from "./rounds.js";

/**
 * Uma partida do Coliseu (mmo-docs [JOGO-28], plans/plan-1/spec.md seções 3, 4 e 6) sobre uma {@link Zone} de arena
 * só dela. Quem cria (o `Colosseum`) chama {@link tick} a cada tick do servidor e recebe os avisos por
 * {@link ArenaMatchHooks}; a partida não conhece WebSocket nem conta.
 *
 * Fases: **preparação** ({@link PREP_SECONDS} s; barreira e travas; 20 escolhas, sobra sorteada no fim) → **round**
 * (até {@link ROUND_SECONDS} s; acaba no fim do tick em que um time cai inteiro ou no tempo) → **pausa**
 * ({@link ROUND_PAUSE_SECONDS} s com o placar; barreira e travas) → próximo round … → **fim**.
 *
 * Abandono ({@link abandon}): botão Sair, logout, não voltou em {@link RECONNECT_SECONDS} s ou AFK
 * ({@link AFK_SECONDS} s sem agir durante um round). O corpo fica morto o resto da partida. Abandono antes do fim do
 * round 1 anula a partida; time inteiro abandonou = o outro vence na hora.
 */

/** Raio da arena placeholder, em metros. */
export const ARENA_RADIUS = 20;
/** Sem andar, lançar nem escolher alvo por isto (s) durante um round = abandono. */
export const AFK_SECONDS = 30;
/** Quem caiu tem isto (s) para voltar; depois é abandono. */
export const RECONNECT_SECONDS = 60;
/** Distância (m) entre jogadores do mesmo time no ponto de nascer. */
const SPAWN_SPACING = 3;
/** Fração do raio em que ficam os pontos de nascer (cada time de um lado). */
const SPAWN_DISTANCE_FRACTION = 0.6;

/** Um jogador que entra na partida. */
export interface ArenaParticipant {
  readonly id: string;
  /** Nome exibido (username). */
  readonly name: string;
  readonly body: BodyType;
  readonly team: TeamIndex;
  readonly build: ArenaBuild;
  /** Envia uma mensagem já serializada (troca na reconexão, {@link ArenaMatch.reconnect}). */
  readonly send: (text: string) => void;
}

/** Fase da partida. */
export type ArenaPhase = "prep" | "round" | "pause" | "over";

/** Por que alguém abandonou. */
export type AbandonReason = "left" | "logout" | "timeout" | "afk";

/** Como a partida terminou para um jogador. */
export interface ArenaPlayerResult {
  readonly id: string;
  readonly team: TeamIndex;
  readonly outcome: ColosseumOutcome;
  /** Algum colega do time abandonou (perdeu → não perde ranking). */
  readonly teammateAbandoned: boolean;
}

/** Fim da partida. */
export interface ArenaMatchResult {
  readonly matchId: string;
  readonly mode: ColosseumMode;
  /** Time vencedor; `null` = empate (ou anulada). */
  readonly winner: TeamIndex | null;
  /** Anulada (abandono antes do fim do round 1): sem prêmio nem ranking, só a punição de quem abandonou. */
  readonly annulled: boolean;
  readonly score: Score;
  /** Rounds jogados até o fim. */
  readonly rounds: number;
  readonly players: readonly ArenaPlayerResult[];
}

/** Avisos da partida para quem a criou. */
export interface ArenaMatchHooks {
  /** Mudou a fase, o round ou o placar (manda `colosseum_state` a todos). */
  onState(match: ArenaMatch): void;
  /** `playerId` abandonou: quem guarda a sessão o devolve à praça (se online) e aplica a punição no fim. */
  onAbandon(playerId: string, reason: AbandonReason): void;
  /** A partida acabou: quem guarda as contas dá o prêmio e devolve todos à praça. */
  onFinish(result: ArenaMatchResult): void;
}

/** Estado de um jogador dentro da partida. */
interface MatchPlayer {
  readonly participant: ArenaParticipant;
  /** Índice dele dentro do time (ponto de nascer). */
  readonly slot: number;
  points: ArenaPoints;
  /** Para onde vão as mensagens dele agora (troca na reconexão; vazio depois do abandono). */
  send: (text: string) => void;
  /** Tick da zona em que caiu; `null` = conectado. */
  disconnectedTick: number | null;
  abandoned: boolean;
}

/** Opções (os testes trocam o sorteio e encurtam a arena). */
export interface ArenaMatchOptions {
  /** Sorteio 0 a <1 (sobra das escolhas e crítico). Padrão `Math.random`. */
  readonly random?: () => number;
  /** Raio da arena (m). Padrão {@link ARENA_RADIUS}. */
  readonly radius?: number;
  /** Durações em segundos (os testes pela rede encurtam). Padrão {@link PREP_SECONDS}, {@link ROUND_SECONDS}, {@link ROUND_PAUSE_SECONDS}. */
  readonly prepSeconds?: number;
  readonly roundSeconds?: number;
  readonly pauseSeconds?: number;
}

/** Ticks de `seconds` segundos. */
const ticks = (seconds: number): number => Math.round(seconds * TICK_RATE_HZ);

/** Uma partida do Coliseu (ver o topo do arquivo). */
export class ArenaMatch {
  /** A instância da arena (só os jogadores da partida; sem NPCs). */
  readonly zone: Zone;
  private readonly players: Map<string, MatchPlayer> = new Map();
  private currentPhase: ArenaPhase = "prep";
  /** Tick da zona em que a fase atual acaba. */
  private phaseEndTick: number;
  private currentRound: number = 0;
  private currentScore: Score = [0, 0];
  private readonly random: () => number;
  private readonly radius: number;
  private readonly prepSeconds: number;
  private readonly roundSeconds: number;
  private readonly pauseSeconds: number;

  constructor(
    readonly id: string,
    readonly mode: ColosseumMode,
    participants: readonly ArenaParticipant[],
    private readonly hooks: ArenaMatchHooks,
    options: ArenaMatchOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.radius = options.radius ?? ARENA_RADIUS;
    this.prepSeconds = options.prepSeconds ?? PREP_SECONDS;
    this.roundSeconds = options.roundSeconds ?? ROUND_SECONDS;
    this.pauseSeconds = options.pauseSeconds ?? ROUND_PAUSE_SECONDS;
    this.zone = new Zone({
      id: `arena_${id}`,
      halfSize: this.radius + 1,
      maxPlayers: participants.length,
      spawnRadius: 0,
      pvp: true,
      dummies: [],
      arena: { radius: this.radius },
    });
    this.zone.random = this.random;
    const slots: Map<TeamIndex, number> = new Map();
    for (const participant of participants) {
      const slot: number = slots.get(participant.team) ?? 0;
      slots.set(participant.team, slot + 1);
      const player: MatchPlayer = { participant, slot, points: NO_ARENA_POINTS, send: participant.send, disconnectedTick: null, abandoned: false };
      this.players.set(participant.id, player);
    }
    for (const player of this.players.values()) this.joinZone(player);
    this.zone.setArenaPhase(true, true);
    this.phaseEndTick = this.zone.tickNumber + ticks(this.prepSeconds);
  }

  /** Fase atual. */
  get phase(): ArenaPhase {
    return this.currentPhase;
  }

  /** Round atual (0 na preparação; 1, 2… depois). */
  get round(): number {
    return this.currentRound;
  }

  /** Placar (pontos do time 0 e do time 1). */
  get score(): Score {
    return this.currentScore;
  }

  /** Segundos até a fase atual acabar (arredondado para cima; 0 no fim). */
  get secondsLeft(): number {
    if (this.currentPhase === "over") return 0;
    return Math.max(0, Math.ceil((this.phaseEndTick - this.zone.tickNumber) / TICK_RATE_HZ));
  }

  /** Ids de todos os jogadores da partida (inclusive quem abandonou). */
  playerIds(): string[] {
    return [...this.players.keys()];
  }

  /** Os jogadores da partida (placar): id, nome, time, build e se abandonou. */
  members(): Array<{ readonly id: string; readonly name: string; readonly team: TeamIndex; readonly build: ArenaBuild; readonly abandoned: boolean }> {
    return [...this.players.values()].map((player) => ({
      id: player.participant.id,
      name: player.participant.name,
      team: player.participant.team,
      build: player.participant.build,
      abandoned: player.abandoned,
    }));
  }

  /** `true` se `id` é desta partida e ainda não abandonou. */
  has(id: string): boolean {
    const player: MatchPlayer | undefined = this.players.get(id);
    return player !== undefined && !player.abandoned;
  }

  /** Time de `id` (`undefined` se não é da partida). */
  teamOf(id: string): TeamIndex | undefined {
    return this.players.get(id)?.participant.team;
  }

  /** Escolhas que `id` ainda tem na preparação. */
  choicesLeft(id: string): number {
    const player: MatchPlayer | undefined = this.players.get(id);
    return player === undefined ? 0 : PREP_CHOICES - player.points.used;
  }

  /** Inventário de arena de `id` (build + pontos): o que Inspecionar mostra. */
  inventoryOf(id: string): Inventory | undefined {
    const player: MatchPlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : arenaInventory(player.participant.build, player.points);
  }

  /**
   * Uma escolha da preparação: peça `slot` → `attribute` (+1 novo, +2 repetido). Só na preparação, só de quem é da
   * partida, até 20, só atributo do conjunto da peça. `count` = quantas escolhas de uma vez no mesmo atributo (cada
   * uma pela regra +1 novo / +2 repetido); mais do que falta = usa só o que falta. Aceita: a zona passa a usar os
   * atributos novos na hora.
   */
  choosePoint(
    id: string,
    slot: EquipSlot,
    attribute: AttributeId,
    count: number = 1,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: PrepPointFailure | "not_in_prep" } {
    const player: MatchPlayer | undefined = this.players.get(id);
    if (player === undefined || player.abandoned || this.currentPhase !== "prep") return { ok: false, reason: "not_in_prep" };
    const first = applyPrepPoint(player.points, player.participant.build, slot, attribute);
    if (!first.ok) return first;
    let points: ArenaPoints = first.points;
    for (let i = 1; i < count; i++) {
      const next = applyPrepPoint(points, player.participant.build, slot, attribute);
      if (!next.ok) break;
      points = next.points;
    }
    player.points = points;
    this.applyLoadout(player);
    return { ok: true };
  }

  /** Caiu a conexão de `id`: a entidade fica na arena sem comando; tem {@link RECONNECT_SECONDS} s para voltar. */
  disconnect(id: string): void {
    const player: MatchPlayer | undefined = this.players.get(id);
    if (player === undefined || player.abandoned || player.disconnectedTick !== null) return;
    player.disconnectedTick = this.zone.tickNumber;
    player.send = (): void => {};
  }

  /** `id` voltou dentro do prazo: as mensagens passam a ir por `send`. `false` se não é da partida (ou abandonou). */
  reconnect(id: string, send: (text: string) => void): boolean {
    const player: MatchPlayer | undefined = this.players.get(id);
    if (player === undefined || player.abandoned) return false;
    player.disconnectedTick = null;
    player.send = send;
    // O AFK conta de novo a partir de agora (parado enquanto estava fora não é AFK).
    this.zone.markActive(id);
    return true;
  }

  /**
   * `id` abandonou: o corpo cai e fica morto o resto da partida, as mensagens param e avisa quem criou. Antes do fim do
   * round 1 anula a partida; se o time dele inteiro abandonou, o outro vence na hora.
   */
  abandon(id: string, reason: AbandonReason): void {
    const player: MatchPlayer | undefined = this.players.get(id);
    if (player === undefined || player.abandoned || this.currentPhase === "over") return;
    player.abandoned = true;
    player.send = (): void => {};
    this.zone.killInArena(id);
    this.hooks.onAbandon(id, reason);
    // Antes de acabar o round 1 (preparação ou round 1): anulada.
    if (this.currentRound <= 1 && (this.currentPhase === "prep" || this.currentPhase === "round")) {
      this.finish(null, true);
      return;
    }
    const team: TeamIndex = player.participant.team;
    if (this.teamIds(team).every((other) => this.players.get(other)?.abandoned === true)) this.finish(team === 0 ? 1 : 0, false);
  }

  /** Um tick: simula a arena e, no fim do tick, avança a fase, decide o round e confere AFK/quedas. */
  tick(): void {
    if (this.currentPhase === "over") return;
    this.zone.tick();
    this.checkAbsent();
    // Um abandono no checkAbsent pode ter acabado a partida.
    if (this.isOver()) return;
    const now: number = this.zone.tickNumber;
    switch (this.currentPhase) {
      case "prep":
        if (now >= this.phaseEndTick) {
          for (const player of this.players.values()) {
            player.points = fillRemainingPoints(player.points, player.participant.build, this.random);
            this.applyLoadout(player);
          }
          this.startRound();
        }
        return;
      case "round": {
        const teams: readonly [TeamRoundState, TeamRoundState] = [this.zone.arenaTeamState(this.teamIds(0)), this.zone.arenaTeamState(this.teamIds(1))];
        const eliminated: RoundWinner | undefined = eliminationWinner(teams);
        if (eliminated !== undefined) this.endRound(eliminated);
        else if (now >= this.phaseEndTick) this.endRound(timeoutWinner(teams));
        return;
      }
      case "pause":
        if (now >= this.phaseEndTick) this.startRound();
        return;
    }
  }

  /** `true` depois do fim (lido de novo a cada chamada: abandono no meio do tick muda a fase). */
  private isOver(): boolean {
    return this.currentPhase === "over";
  }

  /** Ids do time `team`, na ordem de entrada. */
  private teamIds(team: TeamIndex): string[] {
    return [...this.players.values()].filter((player) => player.participant.team === team).map((player) => player.participant.id);
  }

  /** Ponto de nascer de `player`: cada time de um lado (x), olhando para o centro, espalhados em z. */
  private spawnOf(player: MatchPlayer): SpawnPoint {
    const side: number = player.participant.team === 0 ? -1 : 1;
    const teamCount: number = this.teamIds(player.participant.team).length;
    return {
      x: side * this.radius * SPAWN_DISTANCE_FRACTION,
      y: 0,
      z: (player.slot - (teamCount - 1) / 2) * SPAWN_SPACING,
      // rotY = 0 olha para −Z; o time 0 olha para +X e o time 1 para −X.
      rotY: Math.atan2(side, 0),
    };
  }

  /** Põe `player` na zona de arena com o inventário sintético e o nível de arena (nada da conta). */
  private joinZone(player: MatchPlayer): void {
    const inventory: Inventory = arenaInventory(player.participant.build, player.points);
    const member: ZoneMember = {
      id: player.participant.id,
      name: player.participant.name,
      body: player.participant.body,
      // Sem onProgress/onStats/onDeath/rewardMultipliers: nada da arena vai para a conta.
      send: (text: string): void => player.send(text),
    };
    const result: JoinResult = this.zone.join(
      member,
      this.spawnOf(player),
      basicAttackOf(inventory),
      equippedAbilities(inventory),
      lookOf(inventory),
      bonusHpOf(inventory),
      ARENA_PROGRESS,
      attributeEffectsOf(inventory),
      lookLevelsOf(inventory),
      STARTING_STATS,
    );
    if (result.status === "full") throw new Error(`arena ${this.id} lotada`);
    this.zone.setArenaTeam(player.participant.id, player.participant.team);
  }

  /** A zona passa a usar os pontos atuais de `player`. */
  private applyLoadout(player: MatchPlayer): void {
    const inventory: Inventory = arenaInventory(player.participant.build, player.points);
    this.zone.setLoadout(
      player.participant.id,
      basicAttackOf(inventory),
      equippedAbilities(inventory),
      lookOf(inventory),
      bonusHpOf(inventory),
      attributeEffectsOf(inventory),
      lookLevelsOf(inventory),
    );
  }

  /** Quem caiu e não voltou a tempo, ou ficou parado demais num round, abandona. */
  private checkAbsent(): void {
    const now: number = this.zone.tickNumber;
    for (const player of [...this.players.values()]) {
      if (player.abandoned || this.currentPhase === "over") continue;
      const id: string = player.participant.id;
      if (player.disconnectedTick !== null) {
        if (now - player.disconnectedTick >= ticks(RECONNECT_SECONDS)) this.abandon(id, "timeout");
        continue;
      }
      if (this.currentPhase !== "round" || !this.zone.isAlive(id)) continue;
      const last: number = this.zone.lastActionTickOf(id) ?? now;
      if (now - last >= ticks(AFK_SECONDS)) this.abandon(id, "afk");
    }
  }

  /** Começa o próximo round: todos (menos quem abandonou) no seu ponto, cheios; barreira e travas desligadas. */
  private startRound(): void {
    const spawns: Map<string, SpawnPoint> = new Map();
    for (const player of this.players.values()) if (!player.abandoned) spawns.set(player.participant.id, this.spawnOf(player));
    this.zone.resetArenaRound(spawns);
    this.zone.setArenaPhase(false, false);
    this.currentRound++;
    this.currentPhase = "round";
    this.phaseEndTick = this.zone.tickNumber + ticks(this.roundSeconds);
    this.hooks.onState(this);
  }

  /** Fim do round: ponto (ou ninguém), limpa o combate e vai para a pausa ou para o fim. */
  private endRound(winner: RoundWinner): void {
    this.zone.clearArenaCombat();
    this.zone.setArenaPhase(true, true);
    this.currentScore = addRoundPoint(this.currentScore, winner);
    const outcome: MatchOutcome = matchOutcome(this.currentScore, this.currentRound);
    if (outcome.over) {
      this.finish(outcome.winner, false);
      return;
    }
    this.currentPhase = "pause";
    this.phaseEndTick = this.zone.tickNumber + ticks(this.pauseSeconds);
    this.hooks.onState(this);
  }

  /** Acaba a partida e avisa quem criou com o resultado de cada um. */
  private finish(winner: TeamIndex | null, annulled: boolean): void {
    this.currentPhase = "over";
    this.zone.clearArenaCombat();
    this.zone.setArenaPhase(true, true);
    const results: ArenaPlayerResult[] = [...this.players.values()].map((player) => {
      const team: TeamIndex = player.participant.team;
      const teammateAbandoned: boolean = this.teamIds(team).some((other) => other !== player.participant.id && this.players.get(other)?.abandoned === true);
      const outcome: ColosseumOutcome = player.abandoned ? "abandon" : winner === null ? "draw" : winner === team ? "win" : "loss";
      return { id: player.participant.id, team, outcome, teammateAbandoned };
    });
    this.hooks.onState(this);
    this.hooks.onFinish({ matchId: this.id, mode: this.mode, winner: annulled ? null : winner, annulled, score: this.currentScore, rounds: this.currentRound, players: results });
  }
}

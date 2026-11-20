import { EQUIP_SLOTS, getItem, type EquipSlot } from "../items/catalog.js";
import { attributesForSet, type AttributeId } from "../items/attributes.js";
import {
  ServerMessageType,
  encodeServerMessage,
  type BodyType,
  type ColosseumMemberView,
  type ColosseumPieceView,
  type ColosseumStateData,
  type ServerMessage,
} from "../net/protocol.js";
import { COLOSSEUM_MODES, teamSize, type ArenaBuild, type ColosseumMode, type PrepPointFailure } from "./build.js";
import { ArenaMatch, type AbandonReason, type ArenaMatchOptions, type ArenaMatchResult, type ArenaParticipant } from "./match.js";
import { ColosseumQueue, type AcceptResolution, type ColosseumQueueOptions, type PendingMatch, type QueueJoinResult } from "./queue.js";
import type { TeamIndex } from "./rounds.js";

/**
 * Coliseu do servidor (mmo-docs [JOGO-28]): junta a fila ({@link ColosseumQueue}) e as partidas ({@link ArenaMatch}) e
 * manda as mensagens de fila/aceite/placar. O que mexe em sessão, zona e conta (levar para a arena, devolver à praça,
 * prêmio, bloqueio) fica com quem hospeda ({@link ColosseumHost}, o `GameServer`).
 *
 * As partidas **não** ficam na lista de zonas do servidor: o `join` comum não as acha; quem chama {@link tick} a cada
 * tick é o laço do `GameServer`.
 */

/** O que o Coliseu precisa de quem o hospeda. */
export interface ColosseumHost {
  /** Mensagem para um jogador (ignora se offline). */
  send(playerId: string, message: ServerMessage): void;
  /** Nome, corpo e envio de um jogador online para entrar na partida; `null` = não está mais online. */
  participantInfo(playerId: string): { readonly name: string; readonly body: BodyType; readonly send: (text: string) => void } | null;
  /** A partida começou: leva o jogador para a arena (sai da zona comum, `welcome` da arena). */
  enterArena(playerId: string, match: ArenaMatch): void;
  /** `playerId` abandonou: bloqueio da fila e volta à praça (se online). A perda de ranking vem no fim. */
  abandoned(playerId: string, match: ArenaMatch, reason: AbandonReason): void;
  /** A partida acabou: prêmio/ranking de cada um, volta à praça de quem ainda está nela e `colosseum_result`. */
  finished(match: ArenaMatch, result: ArenaMatchResult): void;
  /** Bloqueio novo por recusas seguidas (salvar na conta). */
  banned(playerId: string, untilMs: number): void;
  /** Os pontos de arena de `playerId` mudaram (escolha ou sorteio do fim da preparação): manda o `inventory` da arena. */
  arenaInventoryChanged(playerId: string, match: ArenaMatch): void;
}

/** Opções (os testes encurtam a janela de aceite e fixam o sorteio). */
export interface ColosseumOptions extends ColosseumQueueOptions, ArenaMatchOptions {}

/** Resultado de uma escolha da preparação. */
export type PointResult = { readonly ok: true } | { readonly ok: false; readonly reason: PrepPointFailure | "not_in_prep" };

/** Coliseu do servidor (ver o topo do arquivo). */
export class Colosseum {
  private readonly queue: ColosseumQueue;
  private readonly matches: Map<string, ArenaMatch> = new Map();
  private readonly matchOfPlayer: Map<string, ArenaMatch> = new Map();

  constructor(
    private readonly host: ColosseumHost,
    private readonly options: ColosseumOptions = {},
  ) {
    this.queue = new ColosseumQueue(options);
  }

  /** Partida em que `playerId` está (e não abandonou), ou `undefined`. */
  matchOf(playerId: string): ArenaMatch | undefined {
    const match: ArenaMatch | undefined = this.matchOfPlayer.get(playerId);
    return match !== undefined && match.has(playerId) ? match : undefined;
  }

  /** Partidas em andamento. */
  get activeMatches(): number {
    return this.matches.size;
  }

  /** Modo da fila em que `playerId` espera (ou da partida encontrada); `null` = fora. */
  queuedMode(playerId: string): ColosseumMode | null {
    const status = this.queue.status(playerId);
    return status.kind === "queued" ? status.mode : status.kind === "pending" ? status.match.mode : null;
  }

  /** Quantos esperam em cada fila. */
  waiting(): Record<ColosseumMode, number> {
    const result: Record<ColosseumMode, number> = { "1x1": 0, "2x2": 0, "3x3": 0 };
    for (const mode of COLOSSEUM_MODES) result[mode] = this.queue.waiting(mode);
    return result;
  }

  /** Ids de quem está em fila ou numa janela de aceite (confere a praça a cada segundo). */
  queuedPlayers(): string[] {
    return this.queue.players();
  }

  /** Entra na fila (as condições de praça/vivo/convidado são de quem chama). Já em partida = `already_queued`. */
  join(playerId: string, mode: ColosseumMode, build: ArenaBuild, nowMs: number, banUntilMs: number): QueueJoinResult {
    if (this.matchOf(playerId) !== undefined) return { ok: false, reason: "already_queued" };
    return this.queue.join(playerId, mode, build, nowMs, banUntilMs);
  }

  /** Sai da fila (botão, saiu da praça, caiu). Na janela de aceite conta como recusa. */
  leaveQueue(playerId: string, nowMs: number): void {
    const resolution: AcceptResolution | null = this.queue.leave(playerId, nowMs);
    if (resolution !== null) this.resolve(resolution);
  }

  /** Aceita a partida encontrada. `false` = não tinha partida encontrada. */
  accept(playerId: string): boolean {
    const result = this.queue.accept(playerId);
    if (result === "not_pending") return false;
    if (result === "waiting") {
      const status = this.queue.status(playerId);
      if (status.kind === "pending") this.sendAcceptStatus(status.match);
      return true;
    }
    this.resolve(result);
    return true;
  }

  /** Recusa a partida encontrada. `false` = não tinha partida encontrada. */
  decline(playerId: string, nowMs: number): boolean {
    const resolution: AcceptResolution | null = this.queue.decline(playerId, nowMs);
    if (resolution === null) return false;
    this.resolve(resolution);
    return true;
  }

  /** `count` escolhas da preparação (mesma peça e atributo) de quem está numa partida. */
  choosePoint(playerId: string, slot: EquipSlot, attribute: AttributeId, count: number = 1): PointResult {
    const match: ArenaMatch | undefined = this.matchOf(playerId);
    if (match === undefined) return { ok: false, reason: "not_in_prep" };
    const result: PointResult = match.choosePoint(playerId, slot, attribute, count);
    if (result.ok) {
      this.host.arenaInventoryChanged(playerId, match);
      this.host.send(playerId, { type: ServerMessageType.ColosseumState, data: Colosseum.stateFor(match, playerId) });
    }
    return result;
  }

  /** Abandono pedido (botão Sair da partida, logout). */
  leaveMatch(playerId: string, reason: AbandonReason): boolean {
    const match: ArenaMatch | undefined = this.matchOf(playerId);
    if (match === undefined) return false;
    match.abandon(playerId, reason);
    return true;
  }

  /** A conexão de `playerId` caiu: sai da fila (recusa, se em aceite) e, em partida, começa o prazo de volta. */
  disconnect(playerId: string, nowMs: number): void {
    this.leaveQueue(playerId, nowMs);
    this.matchOf(playerId)?.disconnect(playerId);
  }

  /** `playerId` voltou: as mensagens da partida passam a ir por `send`. Devolve a partida (ou `undefined`). */
  reconnect(playerId: string, send: (text: string) => void): ArenaMatch | undefined {
    const match: ArenaMatch | undefined = this.matchOf(playerId);
    if (match === undefined || !match.reconnect(playerId, send)) return undefined;
    return match;
  }

  /** Um tick: janelas de aceite vencidas, partidas novas e o tick de cada partida. */
  tick(nowMs: number): void {
    for (const resolution of this.queue.expire(nowMs)) this.resolve(resolution);
    for (const match of this.queue.tryMatch(nowMs, this.matches.size)) this.announce(match);
    for (const match of [...this.matches.values()]) match.tick();
  }

  /** `colosseum_state` de `match` para `playerId`. */
  static stateFor(match: ArenaMatch, playerId: string): ColosseumStateData {
    const members = match.members();
    const view = (team: TeamIndex): ColosseumMemberView[] =>
      members.filter((m) => m.team === team).map((m) => ({ id: m.id, name: m.name, build: m.build, abandoned: m.abandoned }));
    const inventory = match.inventoryOf(playerId);
    const pieces: ColosseumPieceView[] = [];
    for (const slot of EQUIP_SLOTS) {
      const stack = inventory?.equipped[slot] ?? null;
      const set: string = stack === null ? "" : (getItem(stack.itemId)?.set ?? "");
      if (stack !== null) pieces.push({ slot, set, itemId: stack.itemId, attrs: stack.attrs ?? {}, allowed: attributesForSet(set) });
    }
    return {
      mode: match.mode,
      phase: match.phase,
      round: match.round,
      score: match.score,
      secondsLeft: match.secondsLeft,
      choicesLeft: match.choicesLeft(playerId),
      team: match.teamOf(playerId) ?? 0,
      teams: [view(0), view(1)],
      pieces,
    };
  }

  /** Partida montada: "Partida encontrada" para todos. */
  private announce(match: PendingMatch): void {
    const total: number = match.teams[0].length + match.teams[1].length;
    const seconds: number = Math.max(1, Math.round((match.deadlineMs - Date.now()) / 1000));
    for (const entry of match.teams.flat()) {
      this.host.send(entry.playerId, { type: ServerMessageType.ColosseumFound, data: { mode: match.mode, seconds, total } });
    }
  }

  /** Quantos já aceitaram, para todos da partida encontrada. */
  private sendAcceptStatus(match: PendingMatch): void {
    const total: number = match.teams[0].length + match.teams[1].length;
    for (const entry of match.teams.flat()) {
      this.host.send(entry.playerId, { type: ServerMessageType.ColosseumAcceptStatus, data: { accepted: match.accepted.size, total } });
    }
  }

  /** Fim de uma janela de aceite: começa a partida ou avisa quem caiu/voltou. */
  private resolve(resolution: AcceptResolution): void {
    if (resolution.kind === "start") {
      this.start(resolution.match);
      return;
    }
    const banned: Map<string, number> = new Map(resolution.bans.map((ban) => [ban.playerId, ban.untilMs]));
    for (const [playerId, untilMs] of banned) this.host.banned(playerId, untilMs);
    for (const playerId of resolution.refused) {
      const until: number | undefined = banned.get(playerId);
      const banSeconds: number = until === undefined ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
      this.host.send(playerId, { type: ServerMessageType.ColosseumCancelled, data: { reason: "you_refused", requeued: false, banSeconds } });
    }
    for (const playerId of resolution.returned) {
      this.host.send(playerId, { type: ServerMessageType.ColosseumCancelled, data: { reason: "other_refused", requeued: true, banSeconds: 0 } });
    }
  }

  /** Todos aceitaram: cria a partida e leva cada um para a arena. */
  private start(pending: PendingMatch): void {
    const participants: ArenaParticipant[] = [];
    pending.teams.forEach((team, index) => {
      const teamIndex: TeamIndex = index === 0 ? 0 : 1;
      for (const entry of team) {
        const info = this.host.participantInfo(entry.playerId);
        // Caiu entre o último aceite e agora: entra mesmo assim, desconectado (tem o prazo de volta).
        participants.push({
          id: entry.playerId,
          name: info?.name ?? entry.playerId,
          body: info?.body ?? "male",
          team: teamIndex,
          build: entry.build,
          send: info?.send ?? ((): void => {}),
        });
      }
    });
    const match: ArenaMatch = new ArenaMatch(
      pending.id,
      pending.mode,
      participants,
      {
        onState: (current): void => {
          // Começo do round 1: a sobra da preparação acabou de ser sorteada (pontos novos nos itens).
          const prepEnded: boolean = current.phase === "round" && current.round === 1;
          for (const member of current.members()) {
            if (member.abandoned) continue;
            if (prepEnded) this.host.arenaInventoryChanged(member.id, current);
            this.host.send(member.id, { type: ServerMessageType.ColosseumState, data: Colosseum.stateFor(current, member.id) });
          }
        },
        onAbandon: (playerId, reason): void => this.host.abandoned(playerId, match, reason),
        onFinish: (result): void => {
          this.matches.delete(match.id);
          for (const id of match.playerIds()) if (this.matchOfPlayer.get(id) === match) this.matchOfPlayer.delete(id);
          this.host.finished(match, result);
        },
      },
      this.options,
    );
    this.matches.set(match.id, match);
    for (const participant of participants) {
      this.matchOfPlayer.set(participant.id, match);
      if (this.host.participantInfo(participant.id) === null) match.disconnect(participant.id);
      else this.host.enterArena(participant.id, match);
    }
    for (const participant of participants) {
      this.host.send(participant.id, { type: ServerMessageType.ColosseumState, data: Colosseum.stateFor(match, participant.id) });
    }
  }

  /** Jogadores por time no modo de `match` (abandono tira ranking × isto). */
  static teamSizeOf(match: ArenaMatch): number {
    return teamSize(match.mode);
  }

  /** Mensagem já serializada (atalho para quem monta o `send` de um participante). */
  static encode(message: ServerMessage): string {
    return encodeServerMessage(message);
  }
}

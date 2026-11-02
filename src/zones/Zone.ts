import {
  ServerMessageType,
  encodeServerMessage,
  type InputData,
  type PlayerInfo,
  type PlayerSnapshot,
  type ServerMessage,
  type SimParams,
} from "../net/protocol.js";
import { MOVE_SPEED, TICK_RATE_HZ, TICK_SECONDS, stepMovement, type MoveParams, type MoveState } from "../sim/movement.js";

/**
 * Quem está numa zona, do ponto de vista dela: um id e um jeito de receber mensagens.
 * A zona não conhece WebSocket, o que permite testá-la sem rede.
 */
export interface ZoneMember {
  /** Id do jogador. */
  readonly id: string;
  /** Nome exibido (username como foi cadastrado). */
  readonly name: string;
  /** Envia uma mensagem já serializada (JSON). */
  send(text: string): void;
}

/** Parâmetros de uma zona. */
export interface ZoneConfig {
  /** Id usado pelo cliente no `join` (ex.: `"zone_1"`). */
  readonly id: string;
  /** Metade do lado do mapa quadrado centrado na origem, em metros. */
  readonly halfSize: number;
  /** Máximo de jogadores simultâneos. */
  readonly maxPlayers: number;
  /** Raio (m) ao redor da origem onde novos jogadores nascem. */
  readonly spawnRadius: number;
}

/** Onde e virado para onde o jogador aparece. Metros e radianos. */
export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** Resultado de {@link Zone.join}: lotada, ou aceito com a lista de quem está na zona (inclusive ele). */
export type JoinResult = { readonly status: "full" } | { readonly status: "joined"; readonly players: PlayerInfo[] };

/**
 * Quantos inputs de um jogador a zona aplica por tick, no máximo. O cliente manda 1 por tick;
 * aceitar 2 absorve a variação da rede (dois chegam juntos) sem deixar ninguém andar mais rápido.
 */
export const MAX_INPUTS_PER_TICK = 2;

/** Tamanho máximo da fila de inputs por jogador. Excesso descarta os mais antigos (anti-speedhack/flood). */
export const MAX_INPUT_QUEUE = 4;

/** Jogador dentro da zona (estado interno; o que vai para a rede é {@link PlayerSnapshot}). */
interface ZonePlayer {
  readonly member: ZoneMember;
  state: MoveState;
  /** Inputs recebidos e ainda não simulados, em ordem de seq. */
  readonly inputs: InputData[];
  /** Maior seq já recebido (para rejeitar repetidos/fora de ordem). */
  lastReceivedSeq: number;
  /** Último seq aplicado na simulação; vai como `ack` no snapshot dele. */
  lastAppliedSeq: number;
}

/** Limita `value` ao intervalo fechado [min, max]. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Uma zona do mundo: jogadores presentes e a simulação autoritativa deles. Ver mmo-docs [INFRA-09].
 *
 * O cliente NÃO diz onde está: manda `input` (direção desejada, numerada). A cada {@link tick}
 * (20 Hz) a zona aplica até {@link MAX_INPUTS_PER_TICK} inputs de cada jogador com a simulação
 * compartilhada (`src/sim/movement.ts`) e envia a todos um `snapshot` com a posição de todo mundo
 * e, para cada destinatário, o último input dele que foi aplicado (`ack`).
 */
export class Zone {
  private readonly players: Map<string, ZonePlayer> = new Map();
  private currentTick = 0;

  constructor(readonly config: ZoneConfig) {}

  /** Número de jogadores na zona. */
  get size(): number {
    return this.players.size;
  }

  /** Tick atual da simulação (cresce 1 a cada {@link tick}). */
  get tickNumber(): number {
    return this.currentTick;
  }

  /** Parâmetros da simulação desta zona (vão no `welcome`). */
  get simParams(): SimParams {
    return { tickRate: TICK_RATE_HZ, moveSpeed: MOVE_SPEED, zoneHalfSize: this.config.halfSize };
  }

  /** `true` se o jogador `id` está nesta zona. */
  has(id: string): boolean {
    return this.players.has(id);
  }

  /**
   * Coloca o jogador em `spawn` (limitado às bordas) ou, sem `spawn`, num ponto aleatório perto
   * do centro, e envia `player_joined` aos demais. O `welcome` fica por conta de quem chamou
   * (usa a lista de jogadores devolvida), porque ele também leva dados da conta.
   * Se o id já estiver na zona, a entrada antiga é substituída.
   */
  join(member: ZoneMember, spawn?: SpawnPoint): JoinResult {
    if (!this.players.has(member.id) && this.players.size >= this.config.maxPlayers) return { status: "full" };
    this.leave(member.id);

    const start: SpawnPoint = spawn ?? this.randomSpawn();
    const limit: number = this.config.halfSize;
    const player: ZonePlayer = {
      member,
      state: { x: clamp(start.x, -limit, limit), y: start.y, z: clamp(start.z, -limit, limit), rotY: start.rotY },
      inputs: [],
      lastReceivedSeq: 0,
      lastAppliedSeq: 0,
    };
    this.players.set(member.id, player);

    this.broadcast({ type: ServerMessageType.PlayerJoined, data: { player: Zone.info(member.id, player) } }, member.id);
    return { status: "joined", players: Array.from(this.players, ([id, p]) => Zone.info(id, p)) };
  }

  /** Remove o jogador e avisa os demais com `player_left`. Ignora ids que não estão na zona. */
  leave(id: string): void {
    if (!this.players.delete(id)) return;
    this.broadcast({ type: ServerMessageType.PlayerLeft, data: { id } });
  }

  /**
   * Enfileira um input para o próximo {@link tick}. Ignora seq repetido ou fora de ordem; se a fila
   * passar de {@link MAX_INPUT_QUEUE}, descarta os mais antigos (o cliente se corrige pelo snapshot).
   */
  queueInput(id: string, input: InputData): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined || input.seq <= player.lastReceivedSeq) return;
    player.lastReceivedSeq = input.seq;
    player.inputs.push(input);
    while (player.inputs.length > MAX_INPUT_QUEUE) player.inputs.shift();
  }

  /** Estado atual de um jogador, ou `undefined` se não estiver na zona. */
  getSnapshot(id: string): PlayerSnapshot | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : Zone.snapshot(id, player);
  }

  /**
   * Um passo da simulação: aplica os inputs da fila de cada jogador (até {@link MAX_INPUTS_PER_TICK})
   * e envia a cada um o `snapshot` da zona com o `ack` dele. Sem input na fila, o jogador fica parado.
   */
  tick(): void {
    this.currentTick++;
    const params: MoveParams = { speed: MOVE_SPEED, halfSize: this.config.halfSize };
    for (const player of this.players.values()) {
      for (let i = 0; i < MAX_INPUTS_PER_TICK; i++) {
        const input: InputData | undefined = player.inputs.shift();
        if (input === undefined) break;
        player.state = stepMovement(player.state, input, TICK_SECONDS, params);
        player.lastAppliedSeq = input.seq;
      }
    }
    if (this.players.size === 0) return;

    // A lista de jogadores é igual para todos: serializa uma vez e só o `ack` muda por destinatário.
    const playersJson: string = JSON.stringify(this.snapshotAll());
    for (const player of this.players.values()) {
      player.member.send(
        `{"type":"${ServerMessageType.Snapshot}","data":{"tick":${this.currentTick},"ack":${player.lastAppliedSeq},"players":${playersJson}}}`,
      );
    }
  }

  /** Serializa uma vez e envia para todos da zona, exceto `exceptId`. */
  private broadcast(message: ServerMessage, exceptId?: string): void {
    const text: string = encodeServerMessage(message);
    for (const [id, player] of this.players) {
      if (id !== exceptId) player.member.send(text);
    }
  }

  private randomSpawn(): SpawnPoint {
    const angle: number = Math.random() * Math.PI * 2;
    const radius: number = this.config.spawnRadius;
    return { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius, rotY: 0 };
  }

  private snapshotAll(): PlayerSnapshot[] {
    return Array.from(this.players, ([id, player]) => Zone.snapshot(id, player));
  }

  private static snapshot(id: string, player: ZonePlayer): PlayerSnapshot {
    return { id, x: player.state.x, y: player.state.y, z: player.state.z, rotY: player.state.rotY };
  }

  /** Snapshot + nome: para quem está conhecendo o jogador agora (`welcome`, `player_joined`). */
  private static info(id: string, player: ZonePlayer): PlayerInfo {
    return { ...Zone.snapshot(id, player), name: player.member.name };
  }
}

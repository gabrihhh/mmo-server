import {
  ServerMessageType,
  encodeServerMessage,
  type MoveData,
  type PlayerSnapshot,
  type ServerMessage,
} from "../net/protocol.js";

/**
 * Quem está numa zona, do ponto de vista dela: um id e um jeito de receber mensagens.
 * A zona não conhece WebSocket, o que permite testá-la sem rede.
 */
export interface ZoneMember {
  /** Id da sessão. */
  readonly id: string;
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

/** Jogador dentro da zona (estado interno; o que vai para a rede é {@link PlayerSnapshot}). */
interface ZonePlayer {
  readonly member: ZoneMember;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Mudou desde o último {@link Zone.tick}. */
  dirty: boolean;
}

/** Onde e virado para onde o jogador aparece. Metros e radianos. */
export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/** Resultado de {@link Zone.join}: lotada, ou aceito com a lista de quem está na zona (inclusive ele). */
export type JoinResult = { readonly status: "full" } | { readonly status: "joined"; readonly players: PlayerSnapshot[] };

/** Limita `value` ao intervalo fechado [min, max]. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Uma zona do mundo: jogadores presentes e a replicação das posições entre eles.
 *
 * MVP: o cliente é autoritativo sobre a própria posição. Ele envia `move`, a zona
 * limita às bordas do mapa e, a cada {@link tick}, envia a todos um lote `positions`
 * só com quem se moveu. Validação de velocidade e anti-cheat ficam para depois (mmo-docs [INFRA-02]).
 */
export class Zone {
  private readonly players: Map<string, ZonePlayer> = new Map();

  constructor(readonly config: ZoneConfig) {}

  /** Número de jogadores na zona. */
  get size(): number {
    return this.players.size;
  }

  /** `true` se a sessão `id` está nesta zona. */
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
      x: clamp(start.x, -limit, limit),
      y: start.y,
      z: clamp(start.z, -limit, limit),
      rotY: start.rotY,
      dirty: false,
    };
    this.players.set(member.id, player);

    this.broadcast({ type: ServerMessageType.PlayerJoined, data: { player: Zone.snapshot(member.id, player) } }, member.id);
    return { status: "joined", players: this.snapshotAll() };
  }

  /** Remove o jogador e avisa os demais com `player_left`. Ignora ids que não estão na zona. */
  leave(id: string): void {
    if (!this.players.delete(id)) return;
    this.broadcast({ type: ServerMessageType.PlayerLeft, data: { id } });
  }

  /** Aplica o `move` do jogador (posição limitada às bordas). Vai para os outros no próximo {@link tick}. */
  move(id: string, move: MoveData): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return;
    const limit: number = this.config.halfSize;
    player.x = clamp(move.x, -limit, limit);
    player.y = move.y;
    player.z = clamp(move.z, -limit, limit);
    player.rotY = move.rotY;
    player.dirty = true;
  }

  /** Posição atual de um jogador, ou `undefined` se não estiver na zona. */
  getSnapshot(id: string): PlayerSnapshot | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : Zone.snapshot(id, player);
  }

  /**
   * Envia a todos um `positions` com os jogadores que mudaram desde o último tick.
   * Não envia nada se ninguém se moveu. O próprio jogador também recebe a sua entrada
   * (o cliente ignora o próprio id); assim a mensagem é serializada uma vez só.
   */
  tick(): void {
    const changed: PlayerSnapshot[] = [];
    for (const [id, player] of this.players) {
      if (!player.dirty) continue;
      player.dirty = false;
      changed.push(Zone.snapshot(id, player));
    }
    if (changed.length > 0) this.broadcast({ type: ServerMessageType.Positions, data: { players: changed } });
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
    return { id, x: player.x, y: player.y, z: player.z, rotY: player.rotY };
  }
}

import {
  ServerMessageType,
  encodeServerMessage,
  type CombatEvent,
  type InputData,
  type NpcSnapshot,
  type OwnStatus,
  type PlayerInfo,
  type PlayerSnapshot,
  type ServerMessage,
  type SimParams,
} from "../net/protocol.js";
import { MOVE_SPEED, TICK_RATE_HZ, TICK_SECONDS, stepMovement, type MoveParams, type MoveState } from "../sim/movement.js";
import { UNARMED_ATTACK, type AbilityDef } from "../items/catalog.js";
import {
  DUMMY_MAX_HP,
  DUMMY_RESPAWN_SECONDS,
  HP_REGEN_PER_SECOND,
  MANA_REGEN_PER_SECOND,
  PLAYER_MAX_HP,
  PLAYER_MAX_MANA,
  PLAYER_RESPAWN_SECONDS,
  RANGE_TOLERANCE,
} from "../combat/stats.js";

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

/** Boneco de treino fixo na zona. Metros. */
export interface DummyConfig {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
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
  /** Jogadores podem atacar jogadores aqui ([JOGO-02]). `false` = zona segura (só monstros). */
  readonly pvp: boolean;
  /** Bonecos de treino da zona. */
  readonly dummies: readonly DummyConfig[];
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

/** Converte segundos em ticks (arredonda para cima: nunca antes da hora). */
const secondsToTicks = (seconds: number): number => Math.max(1, Math.ceil(seconds * TICK_RATE_HZ));

/** Vida, morte e posição: o que jogadores e bonecos têm em comum. */
interface Combatant {
  readonly id: string;
  readonly name: string;
  state: MoveState;
  hp: number;
  readonly maxHp: number;
  dead: boolean;
  /** Tick em que renasce (só vale com `dead`). */
  respawnTick: number;
}

/** Jogador dentro da zona (estado interno; o que vai para a rede é {@link PlayerSnapshot}). */
interface ZonePlayer extends Combatant {
  readonly kind: "player";
  readonly member: ZoneMember;
  mana: number;
  readonly maxMana: number;
  /** Inputs recebidos e ainda não simulados, em ordem de seq. */
  readonly inputs: InputData[];
  /** Maior seq já recebido (para rejeitar repetidos/fora de ordem). */
  lastReceivedSeq: number;
  /** Último seq aplicado na simulação; vai como `ack` no snapshot dele. */
  lastAppliedSeq: number;
  /** Ataque simples da arma vestida (muda com o inventário). */
  basicAttack: AbilityDef;
  /** Alvo fixo do ataque simples (`null` = nenhum). */
  attackTarget: string | null;
  /** Primeiro tick em que pode dar o próximo golpe. */
  nextAttackTick: number;
}

/** Boneco de treino: parado, sem regeneração, reaparece no mesmo lugar. */
interface ZoneDummy extends Combatant {
  readonly kind: "dummy";
  readonly home: MoveState;
}

type Entity = ZonePlayer | ZoneDummy;

/** Resultado de {@link Zone.setAttackTarget}. */
export type TargetResult = "ok" | "invalid_target";

/** Limita `value` ao intervalo fechado [min, max]. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Arredonda vida/mana a 0,1 para o JSON (a conta interna segue com precisão total). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Uma zona do mundo: jogadores, bonecos e a simulação autoritativa deles ([INFRA-09], [JOGO-05]).
 *
 * O cliente NÃO diz onde está nem quanto dano deu: manda `input` (direção) e `attack` (alvo). A cada
 * {@link tick} (20 Hz) a zona: renasce quem já pode, aplica os inputs, executa os ataques em alcance,
 * regenera vida/mana e manda a cada jogador um `snapshot` com todos os estados, os eventos do tick
 * e os dados só dele (`me`, `ack`).
 */
export class Zone {
  private readonly players: Map<string, ZonePlayer> = new Map();
  private readonly dummies: Map<string, ZoneDummy> = new Map();
  private currentTick = 0;
  /** Eventos acumulados no tick em andamento (vão no próximo snapshot). */
  private events: CombatEvent[] = [];

  constructor(readonly config: ZoneConfig) {
    for (const dummy of config.dummies) {
      const home: MoveState = { x: dummy.x, y: 0, z: dummy.z, rotY: 0 };
      this.dummies.set(dummy.id, {
        kind: "dummy",
        id: dummy.id,
        name: dummy.name,
        state: home,
        home,
        hp: DUMMY_MAX_HP,
        maxHp: DUMMY_MAX_HP,
        dead: false,
        respawnTick: 0,
      });
    }
  }

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

  /** Bonecos/monstros como vão no `welcome` e no `snapshot`. */
  npcSnapshots(): NpcSnapshot[] {
    return Array.from(this.dummies.values(), (dummy) => ({ ...Zone.snapshot(dummy), name: dummy.name }));
  }

  /**
   * Coloca o jogador em `spawn` (limitado às bordas) ou, sem `spawn`, num ponto aleatório perto
   * do centro, e envia `player_joined` aos demais. O `welcome` fica por conta de quem chamou
   * (usa a lista de jogadores devolvida), porque ele também leva dados da conta.
   * Se o id já estiver na zona, a entrada antiga é substituída.
   */
  join(member: ZoneMember, spawn?: SpawnPoint, basicAttack: AbilityDef = UNARMED_ATTACK): JoinResult {
    if (!this.players.has(member.id) && this.players.size >= this.config.maxPlayers) return { status: "full" };
    this.leave(member.id);

    const start: SpawnPoint = spawn ?? this.randomSpawn();
    const limit: number = this.config.halfSize;
    const player: ZonePlayer = {
      kind: "player",
      id: member.id,
      name: member.name,
      member,
      state: { x: clamp(start.x, -limit, limit), y: start.y, z: clamp(start.z, -limit, limit), rotY: start.rotY },
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      dead: false,
      respawnTick: 0,
      inputs: [],
      lastReceivedSeq: 0,
      lastAppliedSeq: 0,
      basicAttack,
      attackTarget: null,
      nextAttackTick: 0,
    };
    this.players.set(member.id, player);

    this.broadcast({ type: ServerMessageType.PlayerJoined, data: { player: Zone.info(player) } }, member.id);
    return { status: "joined", players: Array.from(this.players.values(), (p) => Zone.info(p)) };
  }

  /** Remove o jogador e avisa os demais com `player_left`. Ignora ids que não estão na zona. */
  leave(id: string): void {
    if (!this.players.delete(id)) return;
    for (const other of this.players.values()) if (other.attackTarget === id) other.attackTarget = null;
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

  /** Troca o ataque simples (o inventário mudou). */
  setBasicAttack(id: string, basicAttack: AbilityDef): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player !== undefined) player.basicAttack = basicAttack;
  }

  /**
   * Fixa o alvo do ataque simples de `id` (ou limpa com `null`). Recusa alvo inexistente, morto,
   * ele mesmo, ou outro jogador numa zona sem PvP. O ataque acontece nos ticks, quando em alcance.
   */
  setAttackTarget(id: string, targetId: string | null): TargetResult {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return "invalid_target";
    if (targetId === null) {
      player.attackTarget = null;
      return "ok";
    }
    const target: Entity | undefined = this.entity(targetId);
    if (target === undefined || target.dead || targetId === id || player.dead) return "invalid_target";
    if (target.kind === "player" && !this.config.pvp) return "invalid_target";
    player.attackTarget = targetId;
    return "ok";
  }

  /** Estado atual de um jogador, ou `undefined` se não estiver na zona. */
  getSnapshot(id: string): PlayerSnapshot | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : Zone.snapshot(player);
  }

  /**
   * Um passo da simulação, nesta ordem: renascimentos → movimento → ataques → regeneração → snapshot.
   * Morto não anda (os inputs são consumidos e confirmados sem mover, para o cliente não acumular).
   */
  tick(): void {
    this.currentTick++;
    this.respawnDue();
    this.applyMovement();
    this.applyAttacks();
    this.regenerate();
    this.sendSnapshots();
    this.events = [];
  }

  private respawnDue(): void {
    for (const entity of this.entities()) {
      if (!entity.dead || this.currentTick < entity.respawnTick) continue;
      entity.dead = false;
      entity.hp = entity.maxHp;
      if (entity.kind === "player") {
        const spawn: SpawnPoint = this.randomSpawn();
        entity.state = { x: spawn.x, y: spawn.y, z: spawn.z, rotY: spawn.rotY };
        entity.mana = entity.maxMana;
      } else {
        entity.state = entity.home;
      }
      this.events.push({ type: "respawn", id: entity.id });
    }
  }

  private applyMovement(): void {
    const params: MoveParams = { speed: MOVE_SPEED, halfSize: this.config.halfSize };
    for (const player of this.players.values()) {
      for (let i = 0; i < MAX_INPUTS_PER_TICK; i++) {
        const input: InputData | undefined = player.inputs.shift();
        if (input === undefined) break;
        if (!player.dead) player.state = stepMovement(player.state, input, TICK_SECONDS, params);
        player.lastAppliedSeq = input.seq;
      }
    }
  }

  /** Ataque simples: quem tem alvo vivo dentro do alcance (+ folga) e já pode bater, bate. */
  private applyAttacks(): void {
    for (const player of this.players.values()) {
      if (player.dead || player.attackTarget === null) continue;
      const target: Entity | undefined = this.entity(player.attackTarget);
      if (target === undefined || target.dead) {
        player.attackTarget = null;
        continue;
      }
      if (this.currentTick < player.nextAttackTick) continue;
      const attack: AbilityDef = player.basicAttack;
      const dx: number = target.state.x - player.state.x;
      const dz: number = target.state.z - player.state.z;
      if (Math.sqrt(dx * dx + dz * dz) > attack.range + RANGE_TOLERANCE) continue;
      player.nextAttackTick = this.currentTick + secondsToTicks(attack.cooldown);
      this.damage(player, target, attack.damage, attack.id);
    }
  }

  /** Aplica dano; em 0 de vida, morre (e quem mirava nele perde o alvo). */
  private damage(source: Entity, target: Entity, amount: number, abilityId: string): void {
    if (target.dead || amount <= 0) return;
    const dealt: number = Math.min(target.hp, amount);
    target.hp -= dealt;
    this.events.push({ type: "damage", source: source.id, target: target.id, amount: dealt, ability: abilityId });
    if (target.hp > 0) return;
    target.hp = 0;
    target.dead = true;
    const respawnSeconds: number = target.kind === "player" ? PLAYER_RESPAWN_SECONDS : DUMMY_RESPAWN_SECONDS;
    target.respawnTick = this.currentTick + secondsToTicks(respawnSeconds);
    if (target.kind === "player") {
      target.attackTarget = null;
      target.inputs.length = 0;
    }
    for (const player of this.players.values()) if (player.attackTarget === target.id) player.attackTarget = null;
    this.events.push({ type: "death", id: target.id, killer: source.id });
  }

  private regenerate(): void {
    for (const player of this.players.values()) {
      if (player.dead) continue;
      player.hp = Math.min(player.maxHp, player.hp + HP_REGEN_PER_SECOND * TICK_SECONDS);
      player.mana = Math.min(player.maxMana, player.mana + MANA_REGEN_PER_SECOND * TICK_SECONDS);
    }
  }

  /**
   * Manda a cada jogador o snapshot do tick. A parte comum (jogadores, bonecos, eventos) é
   * serializada uma vez; só `ack` e `me` mudam por destinatário.
   */
  private sendSnapshots(): void {
    if (this.players.size === 0) return;
    const shared: string = [
      `"players":${JSON.stringify(Array.from(this.players.values(), (p) => Zone.snapshot(p)))}`,
      `"npcs":${JSON.stringify(this.npcSnapshots())}`,
      `"events":${JSON.stringify(this.events)}`,
    ].join(",");
    for (const player of this.players.values()) {
      const me: OwnStatus = {
        mana: round1(player.mana),
        maxMana: player.maxMana,
        respawnIn: player.dead ? round1(Math.max(0, player.respawnTick - this.currentTick) * TICK_SECONDS) : 0,
        target: player.attackTarget,
      };
      player.member.send(
        `{"type":"${ServerMessageType.Snapshot}","data":{"tick":${this.currentTick},"ack":${player.lastAppliedSeq},${shared},"me":${JSON.stringify(me)}}}`,
      );
    }
  }

  private entity(id: string): Entity | undefined {
    return this.players.get(id) ?? this.dummies.get(id);
  }

  private entities(): Entity[] {
    return [...this.players.values(), ...this.dummies.values()];
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

  private static snapshot(entity: Combatant): PlayerSnapshot {
    return {
      id: entity.id,
      x: entity.state.x,
      y: entity.state.y,
      z: entity.state.z,
      rotY: entity.state.rotY,
      hp: round1(entity.hp),
      maxHp: entity.maxHp,
      dead: entity.dead,
    };
  }

  /** Snapshot + nome: para quem está conhecendo o jogador agora (`welcome`, `player_joined`). */
  private static info(player: ZonePlayer): PlayerInfo {
    return { ...Zone.snapshot(player), name: player.name };
  }
}

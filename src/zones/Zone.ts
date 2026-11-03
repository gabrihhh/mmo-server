import {
  ServerMessageType,
  encodeServerMessage,
  type CastData,
  type CombatEvent,
  type InputData,
  type NpcSnapshot,
  type OwnStatus,
  type Look,
  type PlayerInfo,
  type PlayerSnapshot,
  type ServerMessage,
  type SimParams,
} from "../net/protocol.js";
import {
  MOVE_SPEED,
  TICK_RATE_HZ,
  TICK_SECONDS,
  dashMovement,
  stepMovement,
  type MoveParams,
  type MoveState,
} from "../sim/movement.js";
import { UNARMED_ATTACK, isMovementAbility, type AbilityDef } from "../items/catalog.js";
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

/** Aparência sem nada vestido (padrão de quem entra sem inventário, ex.: testes). */
export const NO_LOOK: Look = { hand: null, head: null, chest: null, feet: null };

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
  /** Escudo: dano que ainda absorve e o tick em que acaba (0 = sem escudo). */
  shield: number;
  shieldUntilTick: number;
}

/** Jogador dentro da zona (estado interno; o que vai para a rede é {@link PlayerSnapshot}). */
interface ZonePlayer extends Combatant {
  readonly kind: "player";
  readonly member: ZoneMember;
  mana: number;
  readonly maxMana: number;
  /** Inputs recebidos e ainda não simulados, em ordem de seq. */
  readonly inputs: Command[];
  /** Disparada ativa ([JOGO-07]): multiplicador para os próximos `stepsLeft` passos, até `untilTick`. */
  boost: SpeedBoost | null;
  /** Maior seq já recebido (para rejeitar repetidos/fora de ordem). */
  lastReceivedSeq: number;
  /** Último seq aplicado na simulação; vai como `ack` no snapshot dele. */
  lastAppliedSeq: number;
  /** Ataque simples da arma vestida (muda com o inventário). */
  basicAttack: AbilityDef;
  /** Habilidades (cartas) vestidas, por id ([JOGO-06]). */
  abilities: ReadonlyMap<string, AbilityDef>;
  /** O que veste (aparência que os outros veem). */
  look: Look;
  /** Tick em que cada habilidade fica pronta de novo (recarga), por id. */
  readonly readyTick: Map<string, number>;
  /** Alvo fixo do ataque simples (`null` = nenhum). */
  attackTarget: string | null;
  /** Lançamento em andamento (`null` = nenhum). O efeito só sai no `endTick`, se o alvo ainda estiver no alcance. */
  cast: Cast | null;
}

/**
 * Um comando na fila do jogador, na ordem do `seq` do cliente: passo de movimento (`input`) ou habilidade de
 * movimento (Investida/Disparada, [JOGO-07]). A mesma ordem dos dois lados é o que mantém a predição exata.
 */
type Command =
  | { readonly kind: "move"; readonly seq: number; readonly input: InputData }
  | { readonly kind: "cast"; readonly seq: number; readonly request: CastData };

/** Disparada em andamento. */
interface SpeedBoost {
  readonly multiplier: number;
  /** Passos de movimento que ainda ganham o bônus (conta igual no cliente). */
  stepsLeft: number;
  /** Também acaba neste tick, mesmo parado. */
  readonly untilTick: number;
}

/** Um lançamento em andamento ([JOGO-05], [JOGO-06]): golpe do ataque simples ou habilidade. */
interface Cast {
  readonly kind: "attack" | "ability";
  readonly ability: AbilityDef;
  /** Alvo (mira "target" e ataque simples); `null` nas outras miras. */
  readonly targetId: string | null;
  /** Mira "direction": vetor unitário. Mira "area": ponto no chão. Outras: posição de quem lança. */
  readonly aimX: number;
  readonly aimZ: number;
  /** Tick em que o efeito acontece. */
  readonly endTick: number;
}

/** Projétil em voo ([JOGO-08]): sai no fim do lançamento e anda `speed` m/s em linha reta a cada tick. */
interface Projectile {
  readonly id: number;
  /** Quem lançou (continua valendo para o dano mesmo se ele morrer ou sair). */
  readonly source: ZonePlayer;
  readonly ability: AbilityDef;
  /** Posição atual (m) e direção (vetor unitário). */
  x: number;
  z: number;
  readonly dirX: number;
  readonly dirZ: number;
  /** Metros já percorridos (acaba em `ability.range`). */
  traveled: number;
}

/** Motivo de recusa de um `cast` (mesmos nomes dos códigos de erro do protocolo). */
export type CastFailure =
  | "busy"
  | "ability_not_equipped"
  | "ability_unavailable"
  | "on_cooldown"
  | "not_enough_mana"
  | "invalid_target"
  | "out_of_range";

/** Resultado de {@link Zone.castAbility}. */
export type CastResult = { readonly ok: true } | { readonly ok: false; readonly reason: CastFailure; readonly message: string };

/** "Raio do corpo" (m) somado às áreas e à largura da linha: acerta quem encosta na borda. */
const BODY_RADIUS = 0.4;

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
  /** Projéteis em voo ([JOGO-08]). */
  private projectiles: Projectile[] = [];
  private nextProjectileId: number = 1;
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
        shield: 0,
        shieldUntilTick: 0,
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
  join(
    member: ZoneMember,
    spawn?: SpawnPoint,
    basicAttack: AbilityDef = UNARMED_ATTACK,
    abilities: ReadonlyMap<string, AbilityDef> = new Map(),
    look: Look = NO_LOOK,
  ): JoinResult {
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
      shield: 0,
      shieldUntilTick: 0,
      inputs: [],
      boost: null,
      lastReceivedSeq: 0,
      lastAppliedSeq: 0,
      basicAttack,
      abilities,
      look,
      readyTick: new Map(),
      attackTarget: null,
      cast: null,
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
    this.enqueue(id, { kind: "move", seq: input.seq, input });
  }

  private enqueue(id: string, command: Command): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined || command.seq <= player.lastReceivedSeq) return;
    player.lastReceivedSeq = command.seq;
    player.inputs.push(command);
    while (player.inputs.length > MAX_INPUT_QUEUE) player.inputs.shift();
  }

  /**
   * Troca o ataque simples, as cartas e a aparência (o inventário mudou). A recarga de cada habilidade é mantida.
   * Aparência diferente vira o evento `look` no próximo snapshot (todos da zona veem a troca).
   */
  setLoadout(id: string, basicAttack: AbilityDef, abilities: ReadonlyMap<string, AbilityDef>, look?: Look): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return;
    player.basicAttack = basicAttack;
    player.abilities = abilities;
    if (look !== undefined && !Zone.sameLook(player.look, look)) {
      player.look = look;
      this.events.push({ type: "look", id, look });
    }
  }

  /**
   * Começa a lançar uma habilidade vestida ([JOGO-06]). Confere: vivo e sem outra habilidade em andamento,
   * vestida, disponível, recarga, mana e — mira "target" — alvo válido no alcance. Aceita: gasta a mana,
   * começa a recarga, interrompe o golpe do ataque simples (o alvo fixo continua) e manda `cast_start`.
   * O efeito sai no fim do lançamento ({@link tick}), se ainda couber no alcance.
   */
  castAbility(id: string, request: CastData): CastResult {
    // Investida/Disparada com seq: entram na fila de movimento e são validadas na vez delas ([JOGO-07]).
    const queued: AbilityDef | undefined = this.players.get(id)?.abilities.get(request.abilityId);
    if (request.seq !== null && queued !== undefined && isMovementAbility(queued)) {
      this.enqueue(id, { kind: "cast", seq: request.seq, request });
      return { ok: true };
    }
    return this.startAbility(id, request);
  }

  /** Validação e início de uma habilidade (ver {@link castAbility}). */
  private startAbility(id: string, request: CastData): CastResult {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined || player.dead) return Zone.refuse("busy", "Você não pode agir agora.");
    if (player.cast !== null && player.cast.kind === "ability") return Zone.refuse("busy", "Já está lançando uma habilidade.");
    const ability: AbilityDef | undefined = player.abilities.get(request.abilityId);
    if (ability === undefined) return Zone.refuse("ability_not_equipped", "Essa habilidade não está vestida.");
    if (!ability.available) return Zone.refuse("ability_unavailable", `${ability.title}: disponível em breve.`);
    const readyTick: number = player.readyTick.get(ability.id) ?? 0;
    if (this.currentTick < readyTick) {
      const seconds: number = (readyTick - this.currentTick) * TICK_SECONDS;
      return Zone.refuse("on_cooldown", `${ability.title} recarrega em ${seconds.toFixed(1)} s.`);
    }
    if (player.mana < ability.manaCost) return Zone.refuse("not_enough_mana", "Mana insuficiente.");

    let targetId: string | null = null;
    let aimX: number = player.state.x;
    let aimZ: number = player.state.z;
    switch (ability.aim) {
      case "target": {
        const target: Entity | undefined = request.targetId === null ? undefined : this.entity(request.targetId);
        if (target === undefined || !this.isEnemy(player, target)) return Zone.refuse("invalid_target", "Escolha um alvo.");
        if (!Zone.inRange(player, target, ability.range)) return Zone.refuse("out_of_range", "Fora de alcance.");
        targetId = target.id;
        break;
      }
      case "direction": {
        const length: number = Math.sqrt((request.x ?? 0) ** 2 + (request.z ?? 0) ** 2);
        // Sem direção válida: para onde o personagem está virado.
        aimX = length > 1e-6 ? (request.x ?? 0) / length : -Math.sin(player.state.rotY);
        aimZ = length > 1e-6 ? (request.z ?? 0) / length : -Math.cos(player.state.rotY);
        break;
      }
      case "area": {
        // Ponto pedido, limitado ao alcance; sem ponto: na frente, no alcance máximo.
        let dx: number = request.x === null ? -Math.sin(player.state.rotY) * ability.range : request.x - player.state.x;
        let dz: number = request.z === null ? -Math.cos(player.state.rotY) * ability.range : request.z - player.state.z;
        const distance: number = Math.sqrt(dx * dx + dz * dz);
        if (distance > ability.range && distance > 0) {
          dx *= ability.range / distance;
          dz *= ability.range / distance;
        }
        aimX = player.state.x + dx;
        aimZ = player.state.z + dz;
        break;
      }
      case "area_self":
      case "self":
        break;
    }

    player.mana -= ability.manaCost;
    player.readyTick.set(ability.id, this.currentTick + secondsToTicks(ability.cooldown));
    if (isMovementAbility(ability)) {
      this.applyMovementAbility(player, ability, aimX, aimZ);
      return { ok: true };
    }
    const castTicks: number = ability.castTime > 0 ? secondsToTicks(ability.castTime) : 0;
    player.cast = { kind: "ability", ability, targetId, aimX, aimZ, endTick: this.currentTick + castTicks };
    this.faceCast(player, player.cast);
    const visual: { x?: number; z?: number; radius?: number; aim?: string } =
      ability.aim === "area"
        ? { x: aimX, z: aimZ, radius: ability.radius }
        : ability.aim === "direction"
          ? { x: player.state.x + aimX * ability.range, z: player.state.z + aimZ * ability.range, radius: ability.radius }
          : ability.aim === "area_self"
            ? { radius: ability.radius }
            : {};
    this.events.push({
      type: "cast_start",
      source: player.id,
      ability: ability.id,
      target: targetId ?? "",
      duration: castTicks * TICK_SECONDS,
      aim: ability.aim,
      ...visual,
    });
    return { ok: true };
  }

  /**
   * Investida/Disparada: efeito na hora (sem lançamento), para bater com a predição do cliente ([JOGO-07]).
   * Investida desloca `dashDistance` na direção; Disparada multiplica a velocidade dos próximos passos.
   */
  private applyMovementAbility(player: ZonePlayer, ability: AbilityDef, dirX: number, dirZ: number): void {
    const visual: { x?: number; z?: number } = {};
    if (ability.dashDistance > 0) {
      player.state = dashMovement(player.state, dirX, dirZ, ability.dashDistance, this.config.halfSize);
      visual.x = player.state.x;
      visual.z = player.state.z;
    }
    if (ability.speedMultiplier > 0) {
      player.boost = {
        multiplier: ability.speedMultiplier,
        stepsLeft: Math.round(ability.speedSeconds * TICK_RATE_HZ),
        untilTick: this.currentTick + secondsToTicks(ability.speedSeconds),
      };
    }
    this.events.push({ type: "cast_start", source: player.id, ability: ability.id, target: "", duration: 0, ...visual });
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
      if (player.cast?.kind === "attack") player.cast = null;
      return "ok";
    }
    const target: Entity | undefined = this.entity(targetId);
    if (target === undefined || player.dead || !this.isEnemy(player, target)) return "invalid_target";
    // Trocar de alvo cancela o golpe do ataque simples em andamento (habilidade não).
    if (player.cast !== null && player.cast.kind === "attack" && player.cast.targetId !== targetId) player.cast = null;
    player.attackTarget = targetId;
    return "ok";
  }

  /** Estado atual de um jogador, ou `undefined` se não estiver na zona. */
  getSnapshot(id: string): PlayerSnapshot | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : Zone.snapshot(player);
  }

  /**
   * Um passo da simulação, nesta ordem: renascimentos → movimento → lançamentos (habilidades e ataque
   * simples) → regeneração/escudos → snapshot. Os lançamentos vêm depois do movimento: quem está lançando
   * termina o tick virado para o alvo/ponto.
   * Morto não anda (os inputs são consumidos e confirmados sem mover, para o cliente não acumular).
   */
  tick(): void {
    this.currentTick++;
    this.respawnDue();
    this.applyMovement();
    // Antes dos lançamentos: o projétil que sai neste tick começa a andar só no próximo (o cliente desenha igual).
    this.moveProjectiles();
    this.applyCasts();
    this.regenerate();
    this.sendSnapshots();
    this.events = [];
  }

  private respawnDue(): void {
    for (const entity of this.entities()) {
      if (!entity.dead || this.currentTick < entity.respawnTick) continue;
      entity.dead = false;
      entity.hp = entity.maxHp;
      entity.shield = 0;
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

  /**
   * Processa a fila de cada jogador na ordem do `seq`: passos (com a Disparada, se ativa) e Investida/Disparada.
   * Recusa de habilidade na fila (recarga, mana...) vai como `error` só para o jogador; o cliente se corrige
   * pela reconciliação.
   */
  private applyMovement(): void {
    for (const player of this.players.values()) {
      if (player.boost !== null && this.currentTick >= player.boost.untilTick) player.boost = null;
      for (let i = 0; i < MAX_INPUTS_PER_TICK; i++) {
        const command: Command | undefined = player.inputs.shift();
        if (command === undefined) break;
        player.lastAppliedSeq = command.seq;
        if (player.dead) continue;
        if (command.kind === "move") {
          this.step(player, command.input);
          continue;
        }
        const result: CastResult = this.startAbility(player.id, command.request);
        if (!result.ok) {
          player.member.send(encodeServerMessage({ type: ServerMessageType.Error, data: { code: result.reason, message: result.message } }));
        }
      }
    }
  }

  /** Um passo de movimento; com Disparada, velocidade multiplicada (e gasta um passo do bônus). */
  private step(player: ZonePlayer, input: InputData): void {
    let speed: number = MOVE_SPEED;
    const boost: SpeedBoost | null = player.boost;
    if (boost !== null && boost.stepsLeft > 0) {
      speed = MOVE_SPEED * boost.multiplier;
      boost.stepsLeft--;
      if (boost.stepsLeft <= 0) player.boost = null;
    }
    const params: MoveParams = { speed, halfSize: this.config.halfSize };
    player.state = stepMovement(player.state, input, TICK_SECONDS, params);
  }

  /**
   * Lançamentos, por jogador:
   * - habilidade em andamento: fica virado; no fim, resolve o efeito ({@link resolveAbility});
   * - ataque simples ([JOGO-05]): sem lançamento em andamento e com o alvo fixo no alcance (+ folga),
   *   começa um golpe (`cast_start`); no fim acerta se o alvo ainda estiver vivo e no alcance, senão erra.
   *   O golpe seguinte pode começar no mesmo tick: com lançamento de 1 s, bate 1 vez por segundo.
   */
  private applyCasts(): void {
    for (const player of this.players.values()) {
      if (player.dead) continue;
      const cast: Cast | null = player.cast;
      if (cast !== null && cast.kind === "ability") {
        this.faceCast(player, cast);
        if (this.currentTick < cast.endTick) continue;
        player.cast = null;
        this.resolveAbility(player, cast);
      }
      this.applyAttack(player);
    }
  }

  private applyAttack(player: ZonePlayer): void {
    if (player.dead || player.attackTarget === null) return;
    const target: Entity | undefined = this.entity(player.attackTarget);
    if (target === undefined || target.dead) {
      player.attackTarget = null;
      if (player.cast?.kind === "attack") player.cast = null;
      return;
    }
    const cast: Cast | null = player.cast;
    if (cast !== null && cast.kind === "attack") {
      Zone.face(player, target);
      if (this.currentTick < cast.endTick) return;
      player.cast = null;
      if (Zone.inRange(player, target, cast.ability.range)) this.damage(player, target, cast.ability.damage, cast.ability.id);
      else this.events.push({ type: "miss", source: player.id, target: target.id, ability: cast.ability.id });
    }
    if (player.cast !== null) return;
    const attack: AbilityDef = player.basicAttack;
    if (!Zone.inRange(player, target, attack.range)) return;
    const duration: number = secondsToTicks(attack.castTime);
    player.cast = { kind: "attack", ability: attack, targetId: target.id, aimX: 0, aimZ: 0, endTick: this.currentTick + duration };
    Zone.face(player, target);
    this.events.push({ type: "cast_start", source: player.id, ability: attack.id, target: target.id, duration: duration * TICK_SECONDS });
  }

  /**
   * Efeito de uma habilidade no fim do lançamento ([JOGO-06]), com a posição de quem lançou AGORA:
   * - target: dano se o alvo ainda estiver vivo e no alcance; senão erra;
   * - direction: dano no PRIMEIRO inimigo na linha (alcance × largura); ninguém = erra;
   * - area: dano em todos no círculo do ponto; ponto fora do alcance (você se afastou) = erra;
   * - area_self: dano em todos ao redor;
   * - self: cura e/ou escudo em quem lançou.
   */
  private resolveAbility(player: ZonePlayer, cast: Cast): void {
    const ability: AbilityDef = cast.ability;
    switch (ability.aim) {
      case "target": {
        const target: Entity | undefined = cast.targetId === null ? undefined : this.entity(cast.targetId);
        if (target !== undefined && !target.dead && Zone.inRange(player, target, ability.range)) {
          this.damage(player, target, ability.damage, ability.id);
        } else {
          this.events.push({ type: "miss", source: player.id, target: cast.targetId ?? "", ability: ability.id });
        }
        return;
      }
      case "direction": {
        if (ability.projectileSpeed > 0) {
          this.launchProjectile(player, ability, cast.aimX, cast.aimZ);
          return;
        }
        let best: Entity | null = null;
        let bestAlong: number = Infinity;
        for (const enemy of this.enemiesOf(player)) {
          const ex: number = enemy.state.x - player.state.x;
          const ez: number = enemy.state.z - player.state.z;
          const along: number = ex * cast.aimX + ez * cast.aimZ;
          const across: number = Math.abs(ex * cast.aimZ - ez * cast.aimX);
          if (along < 0 || along > ability.range + BODY_RADIUS || across > ability.radius + BODY_RADIUS) continue;
          if (along < bestAlong) {
            best = enemy;
            bestAlong = along;
          }
        }
        if (best === null) {
          this.events.push({ type: "miss", source: player.id, target: "", ability: ability.id });
          return;
        }
        this.events.push({ type: "impact", source: player.id, ability: ability.id, x: best.state.x, z: best.state.z, radius: ability.radius });
        this.damage(player, best, ability.damage, ability.id);
        return;
      }
      case "area": {
        const dx: number = cast.aimX - player.state.x;
        const dz: number = cast.aimZ - player.state.z;
        if (Math.sqrt(dx * dx + dz * dz) > ability.range + RANGE_TOLERANCE) {
          this.events.push({ type: "miss", source: player.id, target: "", ability: ability.id });
          return;
        }
        this.areaDamage(player, ability, cast.aimX, cast.aimZ);
        return;
      }
      case "area_self":
        this.areaDamage(player, ability, player.state.x, player.state.z);
        return;
      case "self":
        if (ability.heal > 0) {
          const healed: number = Math.min(player.maxHp - player.hp, ability.heal);
          player.hp += healed;
          this.events.push({ type: "heal", source: player.id, target: player.id, amount: healed, ability: ability.id });
        }
        if (ability.shield > 0) {
          player.shield = ability.shield;
          player.shieldUntilTick = this.currentTick + secondsToTicks(ability.shieldSeconds);
        }
        return;
    }
  }

  /** Solta um projétil de quem lançou, na direção (dirX, dirZ) unitária ([JOGO-08]). */
  private launchProjectile(player: ZonePlayer, ability: AbilityDef, dirX: number, dirZ: number): void {
    const projectile: Projectile = {
      id: this.nextProjectileId++,
      source: player,
      ability,
      x: player.state.x,
      z: player.state.z,
      dirX,
      dirZ,
      traveled: 0,
    };
    this.projectiles.push(projectile);
    this.events.push({
      type: "projectile",
      id: projectile.id,
      source: player.id,
      ability: ability.id,
      x: projectile.x,
      z: projectile.z,
      dirX,
      dirZ,
      speed: ability.projectileSpeed,
      range: ability.range,
      radius: ability.radius,
    });
  }

  /**
   * Anda cada projétil `speed × tick` (sem passar do alcance) e confere quem ele cruzou NESTE trecho: acerta o
   * primeiro inimigo cujo corpo (+ raio do projétil) encosta no caminho. Acertou ou chegou ao fim: some.
   */
  private moveProjectiles(): void {
    const flying: Projectile[] = [];
    for (const projectile of this.projectiles) {
      const ability: AbilityDef = projectile.ability;
      const step: number = Math.min(ability.projectileSpeed * TICK_SECONDS, ability.range - projectile.traveled);
      const reach: number = ability.radius + BODY_RADIUS;
      let hit: Entity | null = null;
      let hitAlong: number = Infinity;
      for (const enemy of this.enemiesOf(projectile.source)) {
        const ex: number = enemy.state.x - projectile.x;
        const ez: number = enemy.state.z - projectile.z;
        const along: number = ex * projectile.dirX + ez * projectile.dirZ;
        const across: number = Math.abs(ex * projectile.dirZ - ez * projectile.dirX);
        if (across > reach) continue;
        // Primeiro ponto do trecho que encosta no corpo (entrada no círculo), limitado ao começo do trecho.
        const entry: number = Math.max(0, along - Math.sqrt(reach * reach - across * across));
        if (entry > step) continue;
        // Atrás do ponto de partida: só acerta se o corpo já encosta nele.
        if (along < 0 && along * along + across * across > reach * reach) continue;
        if (entry < hitAlong) {
          hit = enemy;
          hitAlong = entry;
        }
      }
      if (hit !== null) {
        const x: number = projectile.x + projectile.dirX * hitAlong;
        const z: number = projectile.z + projectile.dirZ * hitAlong;
        this.events.push({ type: "projectile_end", id: projectile.id, x, z });
        this.events.push({ type: "impact", source: projectile.source.id, ability: ability.id, x, z, radius: ability.radius });
        this.damage(projectile.source, hit, ability.damage, ability.id);
        continue;
      }
      projectile.x += projectile.dirX * step;
      projectile.z += projectile.dirZ * step;
      projectile.traveled += step;
      if (projectile.traveled >= ability.range - 1e-9) {
        this.events.push({ type: "projectile_end", id: projectile.id, x: projectile.x, z: projectile.z });
        this.events.push({ type: "miss", source: projectile.source.id, target: "", ability: ability.id });
        continue;
      }
      flying.push(projectile);
    }
    this.projectiles = flying;
  }

  /** Dano em todos os inimigos a até `radius` (+ corpo) do ponto, e o evento visual do impacto. */
  private areaDamage(player: ZonePlayer, ability: AbilityDef, x: number, z: number): void {
    this.events.push({ type: "impact", source: player.id, ability: ability.id, x, z, radius: ability.radius });
    for (const enemy of this.enemiesOf(player)) {
      const dx: number = enemy.state.x - x;
      const dz: number = enemy.state.z - z;
      if (Math.sqrt(dx * dx + dz * dz) <= ability.radius + BODY_RADIUS) this.damage(player, enemy, ability.damage, ability.id);
    }
  }

  /** `true` se `player` pode atingir `target`: vivo, não é ele mesmo, e jogador só com PvP na zona. */
  private isEnemy(player: ZonePlayer, target: Entity): boolean {
    if (target.dead || target.id === player.id) return false;
    return target.kind === "dummy" || this.config.pvp;
  }

  private enemiesOf(player: ZonePlayer): Entity[] {
    return this.entities().filter((entity) => this.isEnemy(player, entity));
  }

  /** Vira quem lança para o alvo, o ponto (área) ou a direção (linha) do lançamento. */
  private faceCast(player: ZonePlayer, cast: Cast): void {
    if (cast.targetId !== null) {
      const target: Entity | undefined = this.entity(cast.targetId);
      if (target !== undefined) Zone.face(player, target);
      return;
    }
    if (cast.ability.aim === "direction") {
      player.state = { ...player.state, rotY: Math.atan2(-cast.aimX, -cast.aimZ) };
    } else if (cast.ability.aim === "area") {
      const dx: number = cast.aimX - player.state.x;
      const dz: number = cast.aimZ - player.state.z;
      if (dx * dx + dz * dz > 1e-6) player.state = { ...player.state, rotY: Math.atan2(-dx, -dz) };
    }
  }

  private static refuse(reason: CastFailure, message: string): CastResult {
    return { ok: false, reason, message };
  }

  /** `true` se `target` está a até `range` (+ folga) de `source`, no plano XZ. */
  private static inRange(source: Combatant, target: Combatant, range: number): boolean {
    const dx: number = target.state.x - source.state.x;
    const dz: number = target.state.z - source.state.z;
    return Math.sqrt(dx * dx + dz * dz) <= range + RANGE_TOLERANCE;
  }

  /** Vira `source` para `target` (mesma convenção da simulação: rotY = 0 olha para -Z). */
  private static face(source: Combatant, target: Combatant): void {
    const dx: number = target.state.x - source.state.x;
    const dz: number = target.state.z - source.state.z;
    if (dx * dx + dz * dz < 1e-6) return;
    source.state = { ...source.state, rotY: Math.atan2(-dx, -dz) };
  }

  /**
   * Aplica dano; o escudo absorve primeiro. Em 0 de vida, morre (e quem mirava nele perde o alvo).
   * O evento leva o dano na vida (`amount`) e o absorvido pelo escudo (`absorbed`).
   */
  private damage(source: Entity, target: Entity, amount: number, abilityId: string): void {
    if (target.dead || amount <= 0) return;
    let remaining: number = amount;
    let absorbed: number = 0;
    if (target.shield > 0 && this.currentTick < target.shieldUntilTick) {
      absorbed = Math.min(target.shield, remaining);
      target.shield -= absorbed;
      remaining -= absorbed;
    }
    const dealt: number = Math.min(target.hp, remaining);
    target.hp -= dealt;
    this.events.push({ type: "damage", source: source.id, target: target.id, amount: dealt, absorbed, ability: abilityId });
    if (target.hp > 0) return;
    target.hp = 0;
    target.dead = true;
    const respawnSeconds: number = target.kind === "player" ? PLAYER_RESPAWN_SECONDS : DUMMY_RESPAWN_SECONDS;
    target.respawnTick = this.currentTick + secondsToTicks(respawnSeconds);
    target.shield = 0;
    if (target.kind === "player") {
      target.attackTarget = null;
      target.cast = null;
      target.inputs.length = 0;
      target.boost = null;
    }
    for (const player of this.players.values()) if (player.attackTarget === target.id) player.attackTarget = null;
    this.events.push({ type: "death", id: target.id, killer: source.id });
  }

  private regenerate(): void {
    for (const entity of this.entities()) {
      if (entity.shield > 0 && this.currentTick >= entity.shieldUntilTick) entity.shield = 0;
    }
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
        casting:
          player.cast === null
            ? null
            : {
                ability: player.cast.ability.id,
                target: player.cast.targetId ?? "",
                remaining: round1(Math.max(0, player.cast.endTick - this.currentTick) * TICK_SECONDS),
              },
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

  private static snapshot(entity: Entity): PlayerSnapshot {
    return {
      id: entity.id,
      x: entity.state.x,
      y: entity.state.y,
      z: entity.state.z,
      rotY: entity.state.rotY,
      hp: round1(entity.hp),
      maxHp: entity.maxHp,
      dead: entity.dead,
      shield: round1(entity.shield),
      speed: entity.kind === "player" && entity.boost !== null ? entity.boost.multiplier : 1,
    };
  }

  /** Snapshot + nome + aparência: para quem está conhecendo o jogador agora (`welcome`, `player_joined`). */
  private static info(player: ZonePlayer): PlayerInfo {
    return { ...Zone.snapshot(player), name: player.name, look: player.look };
  }

  /** `true` se as duas aparências vestem o mesmo item em todos os slots. */
  private static sameLook(a: Look, b: Look): boolean {
    return a.hand === b.hand && a.head === b.head && a.chest === b.chest && a.feet === b.feet;
  }
}

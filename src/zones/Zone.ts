import {
  ServerMessageType,
  encodeServerMessage,
  type CastData,
  type CombatEvent,
  type InputData,
  type NpcSnapshot,
  type OwnStatus,
  type BodyType,
  type EquipSlotName,
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
  MIN_INPUT_LENGTH,
  dashMovement,
  stepMovement,
  type MoveParams,
  type MoveState,
} from "../sim/movement.js";
import { ITEMS, UNARMED_ATTACK, dashSteps, getItem, isMovementAbility, type AbilityDef, type ItemDef } from "../items/catalog.js";
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
/**
 * Ticks depois do último passo em que o ataque simples ainda não começa um golpe (20 Hz → 0,1 s): o input do
 * joystick pode chegar com buracos de 1 tick sem o jogador ter parado de verdade.
 */
const ATTACK_MOVE_GRACE_TICKS = 2;

export interface ZoneMember {
  /** Id do jogador. */
  readonly id: string;
  /** Nome exibido (username como foi cadastrado). */
  readonly name: string;
  /** Corpo do personagem (qual modelo os outros desenham). Ausente = "male" (testes). */
  readonly body?: BodyType;
  /** Envia uma mensagem já serializada (JSON). */
  send(text: string): void;
}

/**
 * O que um NPC fixo da zona faz ([JOGO-11]):
 * - `dummy`: boneco de treino, parado, morre e reaparece;
 * - `shooter`: humano **invulnerável** (não é alvo de ninguém) que lança as habilidades de `rotation` (ids do
 *   catálogo), uma de cada vez, no NPC `target`, com `pauseSeconds` entre o fim de uma e o começo da próxima. Veste o
 *   conjunto da habilidade da vez (evento `look`);
 * - `punchingBag`: leva dano mas **não morre** (a vida para em 1); conta como **aliado** (os jogadores curam e
 *   protegem, não atacam). Chegou em 1: volta à vida cheia `regenDelaySeconds` depois, mesmo apanhando (o atirador
 *   nunca para). Sem levar dano por `regenDelaySeconds`, também recupera `regenPerSecond` de vida por segundo;
 * - `brawler`: parado, ataca sozinho com o ataque simples da arma `weapon` quem chegar no alcance (jogadores e
 *   NPCs); tem vida e morre como o boneco.
 */
export type NpcBehavior =
  | { readonly kind: "dummy" }
  | { readonly kind: "shooter"; readonly target: string; readonly rotation: readonly string[]; readonly pauseSeconds: number }
  | { readonly kind: "punchingBag"; readonly regenDelaySeconds: number; readonly regenPerSecond: number }
  | { readonly kind: "brawler"; readonly weapon: string };

/** NPC fixo na zona (boneco de treino e os de teste, [JOGO-05], [JOGO-11]). Metros. */
export interface DummyConfig {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  /** Comportamento; sem = boneco de treino. */
  readonly behavior?: NpcBehavior;
  /** Corpo humano: o cliente desenha um personagem vestido em vez do boneco de palha. */
  readonly body?: BodyType;
  /** Roupa inicial (humanos). O atirador troca para o conjunto da habilidade da vez. */
  readonly look?: Look;
  /** Vida máxima (padrão: a do boneco de treino). */
  readonly maxHp?: number;
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

/** Vida, morte, posição e lançamento: o que jogadores e NPCs têm em comum (os dois lançam e atacam). */
interface Combatant {
  readonly id: string;
  readonly name: string;
  state: MoveState;
  hp: number;
  /** Vida máxima. Jogador: base + vida extra dos itens vestidos ([JOGO-09]); muda ao trocar de item. */
  maxHp: number;
  dead: boolean;
  /** Tick em que renasce (só vale com `dead`). */
  respawnTick: number;
  /** Escudo: dano que ainda absorve e o tick em que acaba (0 = sem escudo). */
  shield: number;
  shieldUntilTick: number;
  /** Redução de dano (0..1) e o tick em que acaba ([JOGO-09]); 0 = sem redução. */
  reduction: number;
  reductionUntilTick: number;
  /** Ataque simples (jogador: da arma vestida; NPC brigão: da arma dele; os outros não atacam). */
  basicAttack: AbilityDef;
  /** Alvo fixo do ataque simples (`null` = nenhum). */
  attackTarget: string | null;
  /** Último tick em que andou de verdade (input ≥ {@link MIN_INPUT_LENGTH}); -Infinity = nunca (NPCs). */
  lastMoveTick: number;
  /** Lançamento em andamento (`null` = nenhum). O efeito só sai no `endTick`, se o alvo ainda estiver no alcance. */
  cast: Cast | null;
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
  /** Investida em andamento ([JOGO-07]): os próximos `stepsLeft` passos andam na direção dela (ignoram o joystick). */
  dash: DashMove | null;
  /** Maior seq já recebido (para rejeitar repetidos/fora de ordem). */
  lastReceivedSeq: number;
  /** Último seq aplicado na simulação; vai como `ack` no snapshot dele. */
  lastAppliedSeq: number;
  /** Habilidades (cartas) vestidas, por id ([JOGO-06]). */
  abilities: ReadonlyMap<string, AbilityDef>;
  /** O que veste (aparência que os outros veem). */
  look: Look;
  /** Tick em que cada habilidade fica pronta de novo (recarga), por id. */
  readonly readyTick: Map<string, number>;
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

/**
 * Investida em andamento. Conta em PASSOS de movimento (igual ao cliente), não em tempo: assim os dois lados
 * aplicam o mesmo trecho nos mesmos `seq` e a predição bate. O cliente manda um passo por tick enquanto dura.
 */
interface DashMove {
  /** Direção (vetor unitário) e metros por passo. */
  readonly dirX: number;
  readonly dirZ: number;
  readonly stepDistance: number;
  stepsLeft: number;
  /** Segurança: acaba neste tick mesmo se os passos não chegarem (cliente travado/trapaceando). */
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
  /**
   * Tick em que o tiro sai da mão (`endTick` − `releaseTime`; = `endTick` sem soltura antecipada). A partir dele andar
   * não cancela mais ([JOGO-05]).
   */
  readonly releaseTick: number;
  /** Alvo estava no alcance quando o tiro saiu (`null` = ainda não saiu): é isso que vale no fim. */
  inRangeAtRelease: boolean | null;
}

/** Projétil em voo ([JOGO-08]): sai no fim do lançamento e anda `speed` m/s em linha reta a cada tick. */
interface Projectile {
  readonly id: number;
  /** Quem lançou, jogador ou NPC (continua valendo para o dano mesmo se ele morrer ou sair). */
  readonly source: Entity;
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

/** NPC fixo (boneco de treino e os de teste, [JOGO-11]): parado, reaparece no mesmo lugar. */
interface ZoneDummy extends Combatant {
  readonly kind: "dummy";
  readonly home: MoveState;
  readonly behavior: NpcBehavior;
  /** Corpo humano (`null` = boneco de palha) e o que veste. */
  readonly body: BodyType | null;
  look: Look;
  /** Atirador: próxima habilidade da rotação e o tick em que pode começar. */
  rotationIndex: number;
  nextActionTick: number;
  /** Último tick em que levou dano (saco de pancadas: só recupera vida depois de um tempo sem apanhar). */
  lastHitTick: number;
  /** Saco de pancadas em 1 de vida: tick em que volta à vida cheia (0 = não está esperando). */
  refillTick: number;
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
      const behavior: NpcBehavior = dummy.behavior ?? { kind: "dummy" };
      const maxHp: number = dummy.maxHp ?? DUMMY_MAX_HP;
      this.dummies.set(dummy.id, {
        kind: "dummy",
        id: dummy.id,
        name: dummy.name,
        state: home,
        home,
        behavior,
        body: dummy.body ?? null,
        look: dummy.look ?? NO_LOOK,
        hp: maxHp,
        maxHp,
        dead: false,
        respawnTick: 0,
        shield: 0,
        shieldUntilTick: 0,
        reduction: 0,
        reductionUntilTick: 0,
        basicAttack: behavior.kind === "brawler" ? (getItem(behavior.weapon)?.basicAttack ?? UNARMED_ATTACK) : UNARMED_ATTACK,
        attackTarget: null,
        lastMoveTick: Number.NEGATIVE_INFINITY,
        cast: null,
        rotationIndex: 0,
        // Começa 2 s depois de a zona subir (dá tempo de o cliente desenhar tudo).
        nextActionTick: secondsToTicks(2),
        lastHitTick: Number.NEGATIVE_INFINITY,
        refillTick: 0,
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
    return Array.from(this.dummies.values(), (dummy) => ({
      ...Zone.snapshot(dummy),
      name: dummy.name,
      // Humano: o cliente desenha um personagem com esse corpo e roupa ([JOGO-11]).
      ...(dummy.body !== null ? { body: dummy.body, look: dummy.look } : {}),
      // Aliado (saco de pancadas: dá para curar) e quem não serve de alvo de ataque (atirador invulnerável, aliado).
      ...(dummy.behavior.kind === "punchingBag" ? { ally: true } : {}),
      ...(dummy.behavior.kind === "shooter" || dummy.behavior.kind === "punchingBag" ? { targetable: false } : {}),
    }));
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
    bonusHp: number = 0,
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
      hp: PLAYER_MAX_HP + bonusHp,
      maxHp: PLAYER_MAX_HP + bonusHp,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      dead: false,
      respawnTick: 0,
      shield: 0,
      shieldUntilTick: 0,
      reduction: 0,
      reductionUntilTick: 0,
      inputs: [],
      boost: null,
      dash: null,
      lastReceivedSeq: 0,
      lastAppliedSeq: 0,
      basicAttack,
      abilities,
      look,
      readyTick: new Map(),
      attackTarget: null,
      lastMoveTick: Number.NEGATIVE_INFINITY,
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
   * Troca o ataque simples, as cartas, a aparência e a vida extra dos itens (o inventário mudou). A recarga de cada
   * habilidade é mantida. Aparência diferente vira o evento `look` no próximo snapshot (todos da zona veem a troca).
   * Vida máxima nova: a vida atual acompanha na MESMA proporção (tirar e vestir de novo não cura).
   * Se o alvo fixo não serve mais para o ataque novo (ex.: aliado e agora é uma espada), ele é solto.
   */
  setLoadout(
    id: string,
    basicAttack: AbilityDef,
    abilities: ReadonlyMap<string, AbilityDef>,
    look?: Look,
    bonusHp: number = 0,
  ): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return;
    player.basicAttack = basicAttack;
    player.abilities = abilities;
    const maxHp: number = PLAYER_MAX_HP + bonusHp;
    if (maxHp !== player.maxHp) {
      player.hp = player.dead ? 0 : (player.hp * maxHp) / player.maxHp;
      player.maxHp = maxHp;
    }
    const target: Entity | undefined = player.attackTarget === null ? undefined : this.entity(player.attackTarget);
    if (target !== undefined && !this.validAttackTarget(player, basicAttack, target)) {
      player.attackTarget = null;
      if (player.cast?.kind === "attack") player.cast = null;
    }
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
      case "ally": {
        // Sem alvo (ou alvo = você): em você mesmo. Alvo que não é aliado: recusa.
        const target: Entity | undefined = request.targetId === null ? player : this.entity(request.targetId);
        if (target === undefined || !Zone.isAlly(target)) return Zone.refuse("invalid_target", "Escolha um aliado.");
        if (!Zone.inRange(player, target, ability.range)) return Zone.refuse("out_of_range", "Fora de alcance.");
        targetId = target.id;
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
    this.beginAbilityCast(player, ability, targetId, aimX, aimZ);
    return { ok: true };
  }

  /**
   * Começa o lançamento de `ability` (já validada) por `caster`, jogador ou NPC: guarda o {@link Cast}, vira para a
   * mira e manda `cast_start` com o visual (ponto, raio e mira do aviso no chão; soltura do tiro). Mira "target"/"ally":
   * `targetId`; "direction": (aimX, aimZ) unitário; "area": ponto no chão; outras: posição de quem lança.
   */
  private beginAbilityCast(caster: Entity, ability: AbilityDef, targetId: string | null, aimX: number, aimZ: number): Cast {
    const castTicks: number = ability.castTime > 0 ? secondsToTicks(ability.castTime) : 0;
    const endTick: number = this.currentTick + castTicks;
    const cast: Cast = { kind: "ability", ability, targetId, aimX, aimZ, endTick, releaseTick: Zone.releaseTick(ability, endTick), inRangeAtRelease: null };
    caster.cast = cast;
    this.faceCast(caster, cast);
    const visual: { x?: number; z?: number; radius?: number; aim?: string } =
      ability.aim === "area"
        ? { x: aimX, z: aimZ, radius: ability.radius }
        : ability.aim === "direction"
          ? { x: caster.state.x + aimX * ability.range, z: caster.state.z + aimZ * ability.range, radius: ability.radius }
          : ability.aim === "area_self"
            ? { radius: ability.radius }
            : {};
    this.events.push({
      type: "cast_start",
      source: caster.id,
      ability: ability.id,
      target: targetId ?? "",
      duration: castTicks * TICK_SECONDS,
      aim: ability.aim,
      ...visual,
      ...Zone.releaseField(cast),
    });
    return cast;
  }

  /**
   * Investida/Disparada: começam na hora (sem lançamento), na ordem da fila, para bater com a predição do cliente
   * ([JOGO-07]). Investida: os próximos `round(dashSeconds × tick)` passos percorrem `dashDistance` na direção (o
   * comando em si não move). Disparada: multiplica a velocidade dos próximos passos.
   */
  private applyMovementAbility(player: ZonePlayer, ability: AbilityDef, dirX: number, dirZ: number): void {
    const visual: { x?: number; z?: number } = {};
    let duration: number = 0;
    if (ability.dashDistance > 0) {
      const steps: number = dashSteps(ability);
      player.dash = {
        dirX,
        dirZ,
        stepDistance: ability.dashDistance / steps,
        stepsLeft: steps,
        untilTick: this.currentTick + steps + TICK_RATE_HZ,
      };
      // Onde a Investida termina (se nada mudar): só para efeitos visuais.
      const end: MoveState = dashMovement(player.state, dirX, dirZ, ability.dashDistance, this.config.halfSize);
      visual.x = end.x;
      visual.z = end.z;
      duration = steps * TICK_SECONDS;
    }
    if (ability.speedMultiplier > 0) {
      player.boost = {
        multiplier: ability.speedMultiplier,
        stepsLeft: Math.round(ability.speedSeconds * TICK_RATE_HZ),
        untilTick: this.currentTick + secondsToTicks(ability.speedSeconds),
      };
    }
    this.events.push({ type: "cast_start", source: player.id, ability: ability.id, target: "", duration, ...visual });
  }

  /**
   * Fixa o alvo do ataque simples de `id` (ou limpa com `null`). Recusa alvo inexistente, morto,
   * ele mesmo, ou outro jogador numa zona sem PvP. Ataque de cura (mira "ally", [JOGO-09]): o alvo é outro jogador
   * vivo. O ataque acontece nos ticks, quando em alcance.
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
    if (target === undefined || player.dead || !this.validAttackTarget(player, player.basicAttack, target)) return "invalid_target";
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
   * Um passo da simulação, nesta ordem: renascimentos → movimento → projéteis → decisão dos NPCs ({@link npcThink}) →
   * lançamentos (habilidades e ataque simples, de jogadores e NPCs) → regeneração/escudos → snapshot. Os lançamentos vêm depois do movimento: quem está lançando
   * termina o tick virado para o alvo/ponto.
   * Morto não anda (os inputs são consumidos e confirmados sem mover, para o cliente não acumular).
   */
  tick(): void {
    this.currentTick++;
    this.respawnDue();
    this.applyMovement();
    // Antes dos lançamentos: o projétil que sai neste tick começa a andar só no próximo (o cliente desenha igual).
    this.moveProjectiles();
    this.npcThink();
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
      if (player.dash !== null && this.currentTick >= player.dash.untilTick) player.dash = null;
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

  /**
   * Um passo de movimento:
   * - Investida em andamento: anda o trecho dela na direção dela (o joystick é ignorado; não gasta Disparada);
   * - senão, anda pelo input (com Disparada, velocidade multiplicada e gasta um passo do bônus). Andar de verdade
   *   CANCELA o que estiver em lançamento ({@link cancelCast}): habilidade ou golpe do ataque simples.
   */
  private step(player: ZonePlayer, input: InputData): void {
    const dash: DashMove | null = player.dash;
    if (dash !== null) {
      player.state = dashMovement(player.state, dash.dirX, dash.dirZ, dash.stepDistance, this.config.halfSize);
      dash.stepsLeft--;
      if (dash.stepsLeft <= 0) player.dash = null;
      return;
    }
    if (Math.sqrt(input.x * input.x + input.z * input.z) >= MIN_INPUT_LENGTH) {
      player.lastMoveTick = this.currentTick;
      // Só antes de o tiro sair: o que já saiu da mão chega ([JOGO-05]).
      if (player.cast !== null && this.currentTick < player.cast.releaseTick) this.cancelCast(player, player.cast);
    }
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
   * Cancela o lançamento em andamento (o jogador andou, [JOGO-05]/[JOGO-06]) e avisa todos com `cast_cancel` (param a
   * animação, o brilho e o aviso no chão). Habilidade: sem efeito, devolve a mana e zera a recarga (pode lançar de
   * novo na hora). Golpe do ataque simples: sem dano; o alvo fixo continua e o golpe recomeça quando parar.
   */
  private cancelCast(player: ZonePlayer, cast: Cast): void {
    player.cast = null;
    if (cast.kind === "ability") {
      player.mana = Math.min(player.maxMana, player.mana + cast.ability.manaCost);
      player.readyTick.delete(cast.ability.id);
    }
    this.events.push({ type: "cast_cancel", source: player.id, ability: cast.ability.id });
  }

  /** Tick em que o tiro de `ability` sai da mão, num lançamento que termina em `endTick`. */
  private static releaseTick(ability: AbilityDef, endTick: number): number {
    return ability.releaseTime > 0 ? endTick - secondsToTicks(ability.releaseTime) : endTick;
  }

  /** Campo `release` do `cast_start` (s antes do fim em que o tiro sai), só se houver soltura antecipada. */
  private static releaseField(cast: Cast): { release?: number } {
    return cast.releaseTick < cast.endTick ? { release: (cast.endTick - cast.releaseTick) * TICK_SECONDS } : {};
  }

  /** No tick em que o tiro sai, guarda se o alvo estava no alcance (é o que vale no fim, mesmo que ele ande). */
  private markRelease(player: Entity, cast: Cast): void {
    if (cast.inRangeAtRelease !== null || cast.releaseTick >= cast.endTick || this.currentTick < cast.releaseTick) return;
    const target: Entity | undefined = cast.targetId === null ? undefined : this.entity(cast.targetId);
    cast.inRangeAtRelease = target !== undefined && !target.dead && Zone.inRange(player, target, cast.ability.range);
  }

  /**
   * Lançamentos, por jogador:
   * - habilidade em andamento: fica virado; no fim, resolve o efeito ({@link resolveAbility});
   * - ataque simples ([JOGO-05]): sem lançamento em andamento e com o alvo fixo no alcance (+ folga),
   *   começa um golpe (`cast_start`); no fim acerta se o alvo ainda estiver vivo e no alcance, senão erra.
   *   O golpe seguinte pode começar no mesmo tick: com lançamento de 1 s, bate 1 vez por segundo.
   */
  private applyCasts(): void {
    for (const caster of this.entities()) {
      if (caster.dead) continue;
      const cast: Cast | null = caster.cast;
      if (cast !== null && cast.kind === "ability") {
        this.faceCast(caster, cast);
        this.markRelease(caster, cast);
        if (this.currentTick < cast.endTick) continue;
        caster.cast = null;
        this.resolveAbility(caster, cast);
      }
      this.applyAttack(caster);
    }
  }

  /**
   * Decisão dos NPCs a cada tick ([JOGO-11]), antes dos lançamentos:
   * - atirador: sem lançamento em andamento e passada a pausa, começa a próxima habilidade da rotação no alvo dele;
   * - brigão: fixa como alvo do ataque simples o inimigo mais perto no alcance (o golpe em si é o mesmo dos jogadores,
   *   {@link applyAttack}); ninguém no alcance = sem alvo.
   */
  private npcThink(): void {
    for (const npc of this.dummies.values()) {
      if (npc.dead) continue;
      if (npc.behavior.kind === "shooter") this.shooterThink(npc, npc.behavior);
      else if (npc.behavior.kind === "brawler") this.brawlerThink(npc);
    }
  }

  private shooterThink(npc: ZoneDummy, behavior: Extract<NpcBehavior, { kind: "shooter" }>): void {
    if (npc.cast !== null || this.currentTick < npc.nextActionTick || behavior.rotation.length === 0) return;
    const target: Entity | undefined = this.entity(behavior.target);
    if (target === undefined || target.dead) return;
    const abilityId: string = behavior.rotation[npc.rotationIndex % behavior.rotation.length] ?? "";
    npc.rotationIndex++;
    const found: { item: ItemDef; ability: AbilityDef } | undefined = Zone.findAbility(abilityId);
    if (found === undefined) return;
    const look: Look = Zone.setLook(found.item);
    if (!Zone.sameLook(look, npc.look)) {
      npc.look = look;
      this.events.push({ type: "look", id: npc.id, look });
    }
    const ability: AbilityDef = found.ability;
    const dx: number = target.state.x - npc.state.x;
    const dz: number = target.state.z - npc.state.z;
    const length: number = Math.sqrt(dx * dx + dz * dz) || 1;
    // Mira como um jogador faria: no alvo, na direção dele ou no ponto onde ele está.
    const targetId: string | null = ability.aim === "target" ? target.id : null;
    const aimX: number = ability.aim === "direction" ? dx / length : target.state.x;
    const aimZ: number = ability.aim === "direction" ? dz / length : target.state.z;
    const cast: Cast = this.beginAbilityCast(npc, ability, targetId, aimX, aimZ);
    npc.nextActionTick = cast.endTick + secondsToTicks(behavior.pauseSeconds);
  }

  private brawlerThink(npc: ZoneDummy): void {
    const range: number = npc.basicAttack.range;
    const current: Entity | undefined = npc.attackTarget === null ? undefined : this.entity(npc.attackTarget);
    if (current !== undefined && !current.dead && this.isEnemy(npc, current) && Zone.inRange(npc, current, range)) return;
    let nearest: Entity | null = null;
    let nearestDistance: number = Infinity;
    for (const enemy of this.enemiesOf(npc)) {
      const dx: number = enemy.state.x - npc.state.x;
      const dz: number = enemy.state.z - npc.state.z;
      const distance: number = Math.sqrt(dx * dx + dz * dz);
      if (distance <= range + RANGE_TOLERANCE && distance < nearestDistance) {
        nearest = enemy;
        nearestDistance = distance;
      }
    }
    if (nearest === null && npc.cast?.kind === "attack") {
      // Ficou sem ninguém no meio do golpe: cancela (o cliente para a animação), como quando o jogador anda.
      this.events.push({ type: "cast_cancel", source: npc.id, ability: npc.cast.ability.id });
      npc.cast = null;
    }
    npc.attackTarget = nearest?.id ?? null;
  }

  private applyAttack(player: Entity): void {
    if (player.dead || player.attackTarget === null) return;
    const target: Entity | undefined = this.entity(player.attackTarget);
    if (target === undefined || target.dead || !this.validAttackTarget(player, player.basicAttack, target)) {
      player.attackTarget = null;
      if (player.cast?.kind === "attack") player.cast = null;
      return;
    }
    const cast: Cast | null = player.cast;
    if (cast !== null && cast.kind === "attack") {
      Zone.face(player, target);
      this.markRelease(player, cast);
      if (this.currentTick < cast.endTick) return;
      player.cast = null;
      if (cast.inRangeAtRelease ?? Zone.inRange(player, target, cast.ability.range)) {
        if (cast.ability.aim === "ally") this.support(player, target, cast.ability);
        else this.damage(player, target, cast.ability.damage, cast.ability.id);
      }
      else this.events.push({ type: "miss", source: player.id, target: target.id, ability: cast.ability.id });
    }
    if (player.cast !== null) return;
    // Andando (ou acabou de andar) não começa golpe: senão cada passo cancelaria e recomeçaria o ataque.
    if (this.currentTick - player.lastMoveTick <= ATTACK_MOVE_GRACE_TICKS) return;
    const attack: AbilityDef = player.basicAttack;
    if (!Zone.inRange(player, target, attack.range)) return;
    const duration: number = secondsToTicks(attack.castTime);
    const endTick: number = this.currentTick + duration;
    player.cast = { kind: "attack", ability: attack, targetId: target.id, aimX: 0, aimZ: 0, endTick, releaseTick: Zone.releaseTick(attack, endTick), inRangeAtRelease: null };
    Zone.face(player, target);
    this.events.push({ type: "cast_start", source: player.id, ability: attack.id, target: target.id, duration: duration * TICK_SECONDS, ...Zone.releaseField(player.cast) });
  }

  /**
   * Efeito de uma habilidade no fim do lançamento ([JOGO-06]), com a posição de quem lançou AGORA:
   * - target: dano se o alvo ainda estiver vivo e no alcance; senão erra;
   * - direction: dano no PRIMEIRO inimigo na linha (alcance × largura); ninguém = erra;
   * - area: dano em todos no círculo do ponto; ponto fora do alcance (você se afastou) = erra;
   * - area_self: dano em todos ao redor;
   * - self: cura e/ou escudo em quem lançou.
   */
  private resolveAbility(player: Entity, cast: Cast): void {
    const ability: AbilityDef = cast.ability;
    switch (ability.aim) {
      case "target": {
        const target: Entity | undefined = cast.targetId === null ? undefined : this.entity(cast.targetId);
        if (target !== undefined && !target.dead && (cast.inRangeAtRelease ?? Zone.inRange(player, target, ability.range))) {
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
        // Cura/escudo em área: em você e nos aliados em volta ([JOGO-09]).
        if (ability.heal > 0 || ability.shield > 0) {
          for (const ally of this.entities()) {
            if (!Zone.isAlly(ally)) continue;
            const dx: number = ally.state.x - player.state.x;
            const dz: number = ally.state.z - player.state.z;
            if (Math.sqrt(dx * dx + dz * dz) <= ability.radius + BODY_RADIUS) this.support(player, ally, ability);
          }
        }
        return;
      case "ally": {
        const target: Entity | undefined = cast.targetId === null ? undefined : this.entity(cast.targetId);
        if (target !== undefined && Zone.isAlly(target) && Zone.inRange(player, target, ability.range)) {
          this.support(player, target, ability);
        } else {
          this.events.push({ type: "miss", source: player.id, target: cast.targetId ?? "", ability: ability.id });
        }
        return;
      }
      case "self":
        this.support(player, player, ability);
        if (ability.damageReduction > 0) {
          player.reduction = ability.damageReduction;
          player.reductionUntilTick = this.currentTick + secondsToTicks(ability.reductionSeconds);
        }
        return;
    }
  }

  /** Solta um projétil de quem lançou, na direção (dirX, dirZ) unitária ([JOGO-08]). */
  private launchProjectile(player: Entity, ability: AbilityDef, dirX: number, dirZ: number): void {
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

  /**
   * Cura e/ou escudo de `ability` em `target` (você mesmo ou um aliado, [JOGO-09]). A cura não passa da vida
   * máxima (o evento `heal` leva quanto curou de fato); o escudo substitui o anterior.
   */
  private support(source: Entity, target: Entity, ability: AbilityDef): void {
    if (target.dead) return;
    if (ability.heal > 0) {
      const healed: number = Math.min(target.maxHp - target.hp, ability.heal);
      target.hp += healed;
      this.events.push({ type: "heal", source: source.id, target: target.id, amount: healed, ability: ability.id });
    }
    if (ability.shield > 0) {
      target.shield = ability.shield;
      target.shieldUntilTick = this.currentTick + secondsToTicks(ability.shieldSeconds);
    }
  }

  /** Dano em todos os inimigos a até `radius` (+ corpo) do ponto, e o evento visual do impacto. */
  private areaDamage(player: Entity, ability: AbilityDef, x: number, z: number): void {
    this.events.push({ type: "impact", source: player.id, ability: ability.id, x, z, radius: ability.radius });
    if (ability.damage <= 0) return;
    for (const enemy of this.enemiesOf(player)) {
      const dx: number = enemy.state.x - x;
      const dz: number = enemy.state.z - z;
      if (Math.sqrt(dx * dx + dz * dz) <= ability.radius + BODY_RADIUS) this.damage(player, enemy, ability.damage, ability.id);
    }
  }

  /**
   * `true` se `source` pode atingir `target` (vivo e não é ele mesmo). Atirador de teste é invulnerável (ninguém o
   * atinge). Jogador atinge NPCs (menos o saco de pancadas, que é aliado) e jogadores só com PvP na zona. NPC
   * atirador só atinge o alvo dele; brigão atinge todos ([JOGO-11]); boneco não ataca.
   */
  private isEnemy(source: Entity, target: Entity): boolean {
    if (target.dead || target.id === source.id) return false;
    if (target.kind === "dummy" && target.behavior.kind === "shooter") return false;
    if (source.kind === "dummy") {
      if (source.behavior.kind === "shooter") return target.id === source.behavior.target;
      return source.behavior.kind === "brawler";
    }
    if (target.kind === "dummy") return target.behavior.kind !== "punchingBag";
    return this.config.pvp;
  }

  /**
   * `true` se um jogador pode curar/proteger `target` ([JOGO-09]): jogador vivo — você mesmo ou outro — ou o saco de
   * pancadas de teste ([JOGO-11]). Ainda não há grupos, então todo jogador conta como aliado, mesmo numa zona com PvP
   * (onde ele também é inimigo). ATENÇÃO: mesma regra em mmo-client/scripts/world/zone.gd (get_allies).
   */
  private static isAlly(target: Entity): boolean {
    if (target.dead) return false;
    return target.kind === "player" || target.behavior.kind === "punchingBag";
  }

  /**
   * `true` se `target` serve de alvo fixo para o ataque simples `attack`: inimigo (dano) ou, no ataque de cura
   * (mira "ally"), outro jogador vivo (você mesmo não: o alvo fixo é sempre outro).
   */
  private validAttackTarget(player: Entity, attack: AbilityDef, target: Entity): boolean {
    if (attack.aim === "ally") return target.id !== player.id && Zone.isAlly(target);
    return this.isEnemy(player, target);
  }

  private enemiesOf(player: Entity): Entity[] {
    return this.entities().filter((entity) => this.isEnemy(player, entity));
  }

  /** Vira quem lança para o alvo, o ponto (área) ou a direção (linha) do lançamento. */
  private faceCast(player: Entity, cast: Cast): void {
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

  /** Habilidade (carta ou ataque simples) `abilityId` do catálogo e o item que a dá, ou `undefined`. */
  private static findAbility(abilityId: string): { item: ItemDef; ability: AbilityDef } | undefined {
    for (const item of Object.values(ITEMS)) {
      const ability: AbilityDef | undefined = [item.basicAttack, ...item.abilities].find((a) => a?.id === abilityId) ?? undefined;
      if (ability !== undefined && ability !== null) return { item, ability };
    }
    return undefined;
  }

  /**
   * Aparência com o conjunto de `item` inteiro vestido (um item por slot, [JOGO-09]), com o próprio `item` no slot
   * dele (o Treino tem duas armas: quem lança o Raio segura o cajado, não a espada).
   */
  private static setLook(item: ItemDef): Look {
    const look: Record<EquipSlotName, string | null> = { hand: null, head: null, chest: null, feet: null };
    for (const other of Object.values(ITEMS)) {
      if (other.set === item.set && look[other.slot] === null) look[other.slot] = other.id;
    }
    look[item.slot] = item.id;
    return look;
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
   * Aplica dano; a redução de dano diminui e depois o escudo absorve. Em 0 de vida, morre (e quem mirava nele perde o alvo).
   * O evento leva o dano na vida (`amount`) e o absorvido pelo escudo (`absorbed`).
   */
  private damage(source: Entity, target: Entity, amount: number, abilityId: string): void {
    if (target.dead || amount <= 0) return;
    // Atirador de teste: invulnerável ([JOGO-11]).
    if (target.kind === "dummy" && target.behavior.kind === "shooter") return;
    // Redução de dano ([JOGO-09]) vale antes do escudo; arredonda para inteiro (números limpos na tela).
    const reduced: boolean = target.reduction > 0 && this.currentTick < target.reductionUntilTick;
    let remaining: number = reduced ? Math.round(amount * (1 - target.reduction)) : amount;
    let absorbed: number = 0;
    if (target.shield > 0 && this.currentTick < target.shieldUntilTick) {
      absorbed = Math.min(target.shield, remaining);
      target.shield -= absorbed;
      remaining -= absorbed;
    }
    // Saco de pancadas: não morre, a vida para em 1 ([JOGO-11]).
    const unkillable: boolean = target.kind === "dummy" && target.behavior.kind === "punchingBag";
    const dealt: number = Math.min(unkillable ? Math.max(0, target.hp - 1) : target.hp, remaining);
    target.hp -= dealt;
    if (target.kind === "dummy") target.lastHitTick = this.currentTick;
    this.events.push({ type: "damage", source: source.id, target: target.id, amount: dealt, absorbed, ability: abilityId });
    if (target.hp > 0) return;
    target.hp = 0;
    target.dead = true;
    const respawnSeconds: number = target.kind === "player" ? PLAYER_RESPAWN_SECONDS : DUMMY_RESPAWN_SECONDS;
    target.respawnTick = this.currentTick + secondsToTicks(respawnSeconds);
    target.shield = 0;
    target.reduction = 0;
    target.attackTarget = null;
    target.cast = null;
    if (target.kind === "player") {
      target.inputs.length = 0;
      target.boost = null;
      target.dash = null;
    }
    for (const entity of this.entities()) if (entity.attackTarget === target.id) entity.attackTarget = null;
    this.events.push({ type: "death", id: target.id, killer: source.id });
  }

  private regenerate(): void {
    for (const entity of this.entities()) {
      if (entity.shield > 0 && this.currentTick >= entity.shieldUntilTick) entity.shield = 0;
      if (entity.reduction > 0 && this.currentTick >= entity.reductionUntilTick) entity.reduction = 0;
    }
    // Saco de pancadas: recupera vida depois de um tempo sem apanhar ([JOGO-11]).
    for (const npc of this.dummies.values()) {
      if (npc.dead || npc.behavior.kind !== "punchingBag") continue;
      const delay: number = secondsToTicks(npc.behavior.regenDelaySeconds);
      // Chegou em 1: enche de novo depois do tempo, mesmo apanhando.
      if (npc.hp <= 1 && npc.refillTick === 0) npc.refillTick = this.currentTick + delay;
      if (npc.refillTick !== 0 && this.currentTick >= npc.refillTick) {
        npc.hp = npc.maxHp;
        npc.refillTick = 0;
        continue;
      }
      if (npc.hp > 1) npc.refillTick = 0;
      if (this.currentTick - npc.lastHitTick < delay) continue;
      npc.hp = Math.min(npc.maxHp, npc.hp + npc.behavior.regenPerSecond * TICK_SECONDS);
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
      // Redução de dano ativa (0..1, [JOGO-09]); o cliente desenha um brilho em quem tem.
      guard: entity.reduction,
      speed: entity.kind === "player" && entity.boost !== null ? entity.boost.multiplier : 1,
      // Mana é pública (barra acima da cabeça, [CLI-04]); bonecos não têm.
      ...(entity.kind === "player" ? { mana: round1(entity.mana), maxMana: entity.maxMana } : {}),
    };
  }

  /** Snapshot + nome + aparência: para quem está conhecendo o jogador agora (`welcome`, `player_joined`). */
  private static info(player: ZonePlayer): PlayerInfo {
    return { ...Zone.snapshot(player), name: player.name, look: player.look, body: player.member.body ?? "male" };
  }

  /** `true` se as duas aparências vestem o mesmo item em todos os slots. */
  private static sameLook(a: Look, b: Look): boolean {
    return a.hand === b.hand && a.head === b.head && a.chest === b.chest && a.feet === b.feet;
  }
}

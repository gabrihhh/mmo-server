import {
  GROUP_POSITIONS_HZ,
  ServerMessageType,
  encodeServerMessage,
  type CastData,
  type CombatEvent,
  type InputData,
  type NpcSnapshot,
  type OwnStatus,
  type BodyType,
  type NpcBodyType,
  type EquipSlotName,
  type Look,
  type LookLevels,
  type PlayerInfo,
  type PlayerSnapshot,
  type ServerMessage,
  type SimParams,
  type AttributesView,
  type EquippedItemSummary,
  type GroupView,
  type GroupPositionView,
} from "../net/protocol.js";
import { Groups, type GroupResult } from "./groups.js";
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
import {
  addGold,
  addXp,
  monsterFactor,
  playerFactor,
  goldReward,
  groupXp,
  xpReward,
  xpToNextLevel,
  MONSTER_EDGE,
  STARTING_PROGRESS,
  type Progress,
} from "../progression/level.js";
import { CRIT_MULTIPLIER, NO_EFFECTS, type AttributeEffects, type AttributeId } from "../items/attributes.js";
import type { Inventory } from "../items/inventory.js";
import { upgradeItem, type UpgradeResult } from "../items/upgrade.js";
import { EQUIP_SLOTS, ITEMS, UNARMED_ATTACK, dashSteps, getItem, isMovementAbility, type AbilityDef, type ItemDef } from "../items/catalog.js";
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
import {
  TAUNT_THREAT_MULTIPLIER,
  THREAT_INITIAL,
  THREAT_PER_DAMAGE,
  THREAT_PER_HEAL,
  ThreatTable,
  chooseThreatTarget,
  type ThreatCandidate,
} from "../combat/threat.js";

/**
 * Quem está numa zona, do ponto de vista dela: um id e um jeito de receber mensagens.
 * A zona não conhece WebSocket, o que permite testá-la sem rede.
 */
/**
 * Ticks depois do último passo em que o ataque simples ainda não começa um golpe (20 Hz → 0,1 s): o input do
 * joystick pode chegar com buracos de 1 tick sem o jogador ter parado de verdade.
 */
const ATTACK_MOVE_GRACE_TICKS = 2;

/**
 * `ability` do evento `heal` do roubo de vida ([JOGO-16]): não é uma carta, o cliente só mostra o número verde.
 * ATENÇÃO: mmo-client trata ids desconhecidos de `heal` como cura comum.
 */
export const LIFESTEAL_ABILITY = "lifesteal";

/** Distância máxima (m) do ferreiro para melhorar itens ([JOGO-16]). ATENÇÃO: = BLACKSMITH_RANGE em mmo-client (hud). */
export const BLACKSMITH_RANGE = 4;

export interface ZoneMember {
  /** Id do jogador. */
  readonly id: string;
  /** Nome exibido (username como foi cadastrado). */
  readonly name: string;
  /** Corpo do personagem (qual modelo os outros desenham). Ausente = "male" (testes). */
  readonly body?: BodyType;
  /** Envia uma mensagem já serializada (JSON). */
  send(text: string): void;
  /** Nível/XP mudaram (matou um monstro, [JOGO-12]): quem guarda a conta salva. Ausente = não salva (testes). */
  onProgress?(progress: Progress): void;
  /**
   * `true` = este jogador oculta convites de grupo: todo convite é recusado sozinho, sem aparecer para ele, e quem
   * convidou recebe o aviso "X recusou o convite" ([SOC-03]). Ausente = mostra os convites.
   * Configuração → "Convites de grupo: Sempre / Ocultar" ([SOC-04], salvo na conta): o GameServer preenche isto no
   * `join` lendo a opção da conta a cada chamada (mudar a opção vale na hora); a zona consulta em
   * {@link Zone.groupInviteAutoAnswer}.
   */
  hidesGroupInvites?(): boolean;
}

/**
 * O que um NPC fixo da zona faz ([JOGO-11]):
 * - `dummy`: boneco de treino, parado, morre e reaparece;
 * - `shooter`: humano **invulnerável** (não é alvo de ninguém) que lança as habilidades de `rotation` (ids do
 *   catálogo), uma de cada vez, no NPC `target` (os tiros e áreas também acertam jogadores no caminho), com `pauseSeconds` entre o fim de uma e o começo da próxima. Veste o
 *   conjunto da habilidade da vez (evento `look`);
 * - `punchingBag`: leva dano mas **não morre** (a vida para em 1); conta como **aliado** (os jogadores curam e
 *   protegem, não atacam). Chegou em 1: volta à vida cheia `regenDelaySeconds` depois, mesmo apanhando (o atirador
 *   nunca para). Sem levar dano por `regenDelaySeconds`, também recupera `regenPerSecond` de vida por segundo;
 * - `brawler`: parado, ataca sozinho com o ataque simples da arma `weapon` quem chegar no alcance (jogadores e
 *   NPCs); tem vida e morre como o boneco;
 * - `zombie`: monstro ([JOGO-13]). Parado em casa até um jogador chegar a `aggroRadius` m de casa (ou bater nele);
 *   aí anda até ele a `speed` m/s e bate com o ataque simples da arma `weapon`, usando também a habilidade `ability`
 *   da arma quando ela estiver pronta e o alvo no alcance dela. Quem ele ataca sai da tabela de ameaça ([JOGO-14]).
 *   Passou de `leashRadius` m de casa: desiste, volta andando (sem atacar) e enche a vida. Só ataca jogadores. Quem lutou contra ele ganha XP ({@link xpReward} do nível dele + {@link groupXp}) e moedas ({@link goldReward}).
 */
export type NpcBehavior =
  | { readonly kind: "dummy" }
  | { readonly kind: "shooter"; readonly target: string; readonly rotation: readonly string[]; readonly pauseSeconds: number }
  | { readonly kind: "punchingBag"; readonly regenDelaySeconds: number; readonly regenPerSecond: number }
  | { readonly kind: "brawler"; readonly weapon: string }
  /** Ferreiro ([JOGO-16]): parado, invulnerável, não é alvo; perto dele dá para melhorar itens. */
  | { readonly kind: "blacksmith" }
  | {
      readonly kind: "zombie";
      readonly weapon: string;
      readonly ability: string;
      readonly aggroRadius: number;
      readonly leashRadius: number;
      readonly speed: number;
    };

/** NPC fixo na zona (boneco de treino e os de teste, [JOGO-05], [JOGO-11]). Metros. */
export interface DummyConfig {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  /** Comportamento; sem = boneco de treino. */
  readonly behavior?: NpcBehavior;
  /** Corpo (de jogador ou de monstro, ex. `zombie`): o cliente desenha esse personagem em vez do boneco de palha. */
  readonly body?: NpcBodyType;
  /** Roupa inicial (humanos). O atirador troca para o conjunto da habilidade da vez. */
  readonly look?: Look;
  /** Vida máxima no nível 0 (padrão: a do boneco de treino); monstro: × 1,2 × {@link monsterFactor}, outros: × {@link playerFactor} do `level`. */
  readonly maxHp?: number;
  /** Nível do NPC ([JOGO-12]): força × 1,01 por nível e, monstro, a XP que dá. Padrão 0. */
  readonly level?: number;
  /** Segundos até reaparecer depois de morrer (padrão: {@link DUMMY_RESPAWN_SECONDS}). */
  readonly respawnSeconds?: number;
  /**
   * Multiplicador do dano que ele dá (padrão 1): monstros usam os números das armas dos jogadores, mas mais fracos
   * (provisório, [JOGO-13]). Vale junto com o do nível.
   */
  readonly damageMultiplier?: number;
}

/**
 * Como um jogador fake responde a convites de grupo e pedidos de amizade (mmo-docs [SOC-01]): `accept` aceita
 * sempre, `reject` recusa sempre. A resposta chega a quem pediu como se viesse de um jogador de verdade.
 * Lido por {@link Zone.autoReplyOf} e, no grupo ([SOC-03]), por {@link Zone.groupInviteAutoAnswer}; amizade
 * ([SOC-04]) também lê daqui.
 */
export type AutoReply = "accept" | "reject";

/**
 * Jogador fake de teste ([SOC-01]): para o jogo é um jogador (vem no `welcome`/`snapshot` como jogador, com nome,
 * nível, roupa e corpo), mas não tem conexão nem anda. Monstros e NPCs não o atacam (para não sumir no teste);
 * jogadores com PvP podem. Morto, renasce no mesmo lugar. Metros.
 */
export interface FakePlayerConfig {
  /** Id de jogador (não pode colidir com um `playerId` de conta; usamos o prefixo `fake_`). */
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly body: BodyType;
  /** Nível ([JOGO-12]): vida/mana máximas e força como as de um jogador desse nível. */
  readonly level: number;
  /** O que veste (vida extra dos itens conta na vida máxima, como no jogador). */
  readonly look: Look;
  readonly autoReply: AutoReply;
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
  /** Jogadores fake de teste ([SOC-01]); ausente = nenhum. Não contam em `maxPlayers` nem no "online". */
  readonly fakePlayers?: readonly FakePlayerConfig[];
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

/**
 * Área de interesse (m): cada jogador recebe no snapshot só os jogadores e NPCs a esta distância dele (mais ele
 * mesmo e o alvo dele), como nos MMOs. A câmera mostra ~25 m em volta ([CLI-02]); a folga evita que alguém "pisque"
 * na borda da tela. Menos dados por segundo e o cliente só desenha/anima quem está perto. Ver mmo-docs [INFRA-04].
 *
 * ATENÇÃO: quem some do snapshot o cliente esconde e congela (mmo-client/scripts/network/network.gd, `in_view`).
 */
export const VIEW_RADIUS = 45;

/**
 * Distância (m) do monstro, na hora da morte, até onde um membro do grupo de quem lutou ganha a XP mesmo sem ter batido
 * nem curado ([JOGO-12], [SOC-03]): a mesma da área de interesse (quem está vendo a luta).
 */
export const GROUP_XP_RADIUS = VIEW_RADIUS;

/**
 * A cada quantos ticks a zona manda `group_positions` (os membros do grupo longe, para o mapa; [SOC-03], [CLI-11]):
 * {@link GROUP_POSITIONS_HZ} Hz a {@link TICK_RATE_HZ} Hz de simulação = a cada 10 ticks.
 */
export const GROUP_POSITIONS_EVERY_TICKS: number = Math.max(1, Math.round(TICK_RATE_HZ / GROUP_POSITIONS_HZ));

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
  /**
   * Nível ([JOGO-12]): vida/mana máximas, dano, cura e escudo de quem tem × o fator do nível (Zone.strength). Jogador: o da conta
   * (sobe matando monstros); NPC: o da configuração. Público (vai no snapshot).
   */
  level: number;
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
  /**
   * Tick em que cada POSIÇÃO de carta fica pronta de novo (recarga), por {@link Zone.cardSlot} ("hand:0".."feet:0").
   * Por posição, não por habilidade ([JOGO-06]): trocar de item não zera a recarga — a habilidade nova que entrou na
   * mesma posição espera o que faltava da anterior; depois de usada, vale a recarga dela.
   */
  readonly readyTick: Map<string, number>;
}

/** Jogador dentro da zona (estado interno; o que vai para a rede é {@link PlayerSnapshot}). */
interface ZonePlayer extends Combatant {
  readonly kind: "player";
  readonly member: ZoneMember;
  mana: number;
  /** Mana máxima: base × {@link playerFactor} do nível. */
  maxMana: number;
  /** Vida extra dos itens vestidos ([JOGO-09]); a vida máxima é (base + isto) × {@link playerFactor}. */
  bonusHp: number;
  /** Atributos de melhoria somados do que veste ([JOGO-16]): dano, crítico, defesa, recarga... */
  effects: AttributeEffects;
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
  /** Nível de melhoria das peças vestidas (brilho que os outros veem, [JOGO-17]). */
  lookLevels: LookLevels;
  /** Nível e XP do personagem ([JOGO-12]); vão só para ele, no `me` do snapshot. */
  progress: Progress;
  /** Jogador fake de teste ([SOC-01]): como responde e onde renasce. `null` = jogador de verdade. */
  readonly fake: FakeState | null;
}

/** O que só o jogador fake tem ([SOC-01]). */
interface FakeState {
  readonly autoReply: AutoReply;
  /** Onde fica parado (e renasce). */
  readonly home: MoveState;
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
  readonly body: NpcBodyType | null;
  look: Look;
  /** Atirador: próxima habilidade da rotação e o tick em que pode começar. */
  rotationIndex: number;
  nextActionTick: number;
  /** Último tick em que levou dano (saco de pancadas: só recupera vida depois de um tempo sem apanhar). */
  lastHitTick: number;
  /** Saco de pancadas em 1 de vida: tick em que volta à vida cheia (0 = não está esperando). */
  refillTick: number;
  /** Segundos até reaparecer depois de morrer. */
  readonly respawnSeconds: number;
  /** Multiplicador do dano que ele dá ({@link DummyConfig.damageMultiplier}). */
  readonly damageMultiplier: number;
  /** Zumbi: a habilidade da arma que ele usa (`null` nos outros). */
  readonly ability: AbilityDef | null;
  /** Zumbi: desistiu do alvo e está voltando para casa (não ataca; chegando, enche a vida). */
  returning: boolean;
  /**
   * Monstro: jogadores que participaram da luta atual (bateram nele, ou curaram/protegeram quem bateu). Na morte,
   * TODOS ganham a XP inteira ([JOGO-12]). Zera quando ele desiste (volta para casa) e quando reaparece.
   */
  readonly contributors: Set<string>;
  /**
   * Monstro: tabela de ameaça da luta atual ([JOGO-14]): decide quem ele ataca. Zera quando ele desiste (volta para
   * casa), morre e reaparece; quem morre ou sai da zona sai dela. Separada dos `contributors` (XP).
   */
  readonly threat: ThreatTable;
  /** Monstro provocado (Desafio, [JOGO-14]): por quem (`null` = ninguém) e até que tick fica preso nele. */
  tauntedBy: string | null;
  tauntUntilTick: number;
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
  /** Grupos e convites de grupo desta zona ([SOC-03]). */
  private readonly groups: Groups = new Groups({
    send: (playerId, message): void => this.players.get(playerId)?.member.send(encodeServerMessage(message)),
    nameOf: (playerId): string | undefined => this.players.get(playerId)?.name,
    levelOf: (playerId): number => this.players.get(playerId)?.level ?? 0,
    autoAnswer: (playerId): "accept" | "reject" | null => this.groupInviteAutoAnswer(playerId),
  });

  /** Sorteio (0 a <1) do crítico ([JOGO-16]) e da melhoria no ferreiro; os testes trocam por um fixo. */
  random: () => number = Math.random;

  constructor(readonly config: ZoneConfig) {
    for (const dummy of config.dummies) {
      const home: MoveState = { x: dummy.x, y: 0, z: dummy.z, rotY: 0 };
      const behavior: NpcBehavior = dummy.behavior ?? { kind: "dummy" };
      const level: number = dummy.level ?? 0;
      // Monstro: vida × 1,2 × 1,02^nível; os outros NPCs (treino) seguem a curva do jogador ([JOGO-12]).
      const monster: boolean = behavior.kind === "zombie";
      const growth: number = monster ? MONSTER_EDGE * monsterFactor(level) : playerFactor(level);
      const maxHp: number = round1((dummy.maxHp ?? DUMMY_MAX_HP) * growth);
      const weapon: string | null = behavior.kind === "brawler" || behavior.kind === "zombie" ? behavior.weapon : null;
      this.dummies.set(dummy.id, {
        kind: "dummy",
        id: dummy.id,
        name: dummy.name,
        level,
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
        basicAttack: weapon === null ? UNARMED_ATTACK : (getItem(weapon)?.basicAttack ?? UNARMED_ATTACK),
        attackTarget: null,
        lastMoveTick: Number.NEGATIVE_INFINITY,
        cast: null,
        readyTick: new Map(),
        rotationIndex: 0,
        // Começa 2 s depois de a zona subir (dá tempo de o cliente desenhar tudo).
        nextActionTick: secondsToTicks(2),
        lastHitTick: Number.NEGATIVE_INFINITY,
        refillTick: 0,
        respawnSeconds: dummy.respawnSeconds ?? DUMMY_RESPAWN_SECONDS,
        damageMultiplier: dummy.damageMultiplier ?? 1,
        ability: behavior.kind === "zombie" ? (Zone.findAbility(behavior.ability)?.ability ?? null) : null,
        returning: false,
        contributors: new Set(),
        threat: new ThreatTable(),
        tauntedBy: null,
        tauntUntilTick: 0,
      });
    }
    for (const fake of config.fakePlayers ?? []) this.addFake(fake);
  }

  /**
   * Põe o jogador fake [fake] na zona ([SOC-01]): um {@link ZonePlayer} cujo `send` não faz nada (não tem conexão)
   * e que nunca manda input. A vida extra dos itens vestidos conta como no jogador de verdade.
   */
  private addFake(fake: FakePlayerConfig): void {
    const factor: number = playerFactor(fake.level);
    let bonusHp: number = 0;
    for (const slot of EQUIP_SLOTS) {
      const itemId: string | null = fake.look[slot];
      if (itemId !== null) bonusHp += getItem(itemId)?.bonusHp ?? 0;
    }
    const home: MoveState = { x: fake.x, y: 0, z: fake.z, rotY: 0 };
    const maxHp: number = round1((PLAYER_MAX_HP + bonusHp) * factor);
    const maxMana: number = round1(PLAYER_MAX_MANA * factor);
    this.players.set(fake.id, {
      kind: "player",
      id: fake.id,
      name: fake.name,
      level: fake.level,
      member: { id: fake.id, name: fake.name, body: fake.body, send: (): void => {} },
      state: home,
      hp: maxHp,
      maxHp,
      mana: maxMana,
      maxMana,
      bonusHp,
      effects: NO_EFFECTS,
      lookLevels: {},
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
      basicAttack: UNARMED_ATTACK,
      abilities: new Map(),
      look: fake.look,
      progress: { level: fake.level, xp: 0, gold: 0 },
      readyTick: new Map(),
      attackTarget: null,
      lastMoveTick: Number.NEGATIVE_INFINITY,
      cast: null,
      fake: { autoReply: fake.autoReply, home },
    });
  }

  /** Jogadores de verdade (com conexão) na zona: sem os fakes de teste ([SOC-01]). */
  private realPlayerCount(): number {
    let count: number = 0;
    for (const player of this.players.values()) if (player.fake === null) count++;
    return count;
  }

  /**
   * Como o jogador `id` responde sozinho a convites/pedidos ([SOC-01]): `accept`/`reject` se for um fake de teste,
   * `null` se for um jogador de verdade (ou não estiver na zona). Usado pelo grupo ([SOC-03]) e pela amizade
   * ([SOC-04], no `GameServer`).
   */
  autoReplyOf(id: string): AutoReply | null {
    return this.players.get(id)?.fake?.autoReply ?? null;
  }

  /** Nome do jogador fake de teste `id` desta zona ([SOC-01]); `undefined` se não for um fake daqui. Amizade ([SOC-04]). */
  fakeName(id: string): string | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player !== undefined && player.fake !== null ? player.name : undefined;
  }

  /**
   * Resposta automática do jogador `id` a um convite de grupo ([SOC-03]), ou `null` = mostrar o convite para ele:
   * - jogador fake de teste ([SOC-01]): a resposta configurada dele (`accept`/`reject`);
   * - **jogador que oculta convites de grupo** ({@link ZoneMember.hidesGroupInvites}, Configuração, [SOC-04]):
   *   `reject` — recusa sozinho, sem mostrar nada; quem convidou vê "X recusou o convite".
   * É o ÚNICO ponto onde a zona decide isso; o `GameServer` preenche `hidesGroupInvites` no `ZoneMember` (opção da conta).
   */
  groupInviteAutoAnswer(id: string): AutoReply | null {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return null;
    if (player.fake !== null) return player.fake.autoReply;
    if (player.member.hidesGroupInvites?.() === true) return "reject";
    return null;
  }

  /** `from` convida `to` para o grupo ([SOC-03]; regras em {@link Groups.invite}). */
  inviteToGroup(from: string, to: string): GroupResult {
    return this.groups.invite(from, to, this.currentTick);
  }

  /** `to` aceita (`accept`) ou recusa o convite de grupo de `from` ({@link Groups.answer}). */
  answerGroupInvite(to: string, from: string, accept: boolean): GroupResult {
    return this.groups.answer(to, from, accept);
  }

  /** O líder `leader` expulsa `target` do grupo ({@link Groups.kick}). */
  kickFromGroup(leader: string, target: string): GroupResult {
    return this.groups.kick(leader, target);
  }

  /** `id` sai do grupo ({@link Groups.leave}). */
  leaveGroup(id: string): GroupResult {
    return this.groups.leave(id);
  }

  /** O grupo de `id` (líder e membros), ou `null` sem grupo. */
  groupOf(id: string): GroupView | null {
    return this.groups.view(id);
  }

  /**
   * Atributos do jogador `id` para a tela de Atributos ([SOC-02]; resposta ao `inspect`), ou `undefined` se ele não
   * está na zona. Sem limite de distância: a lista do grupo (etapa 2) também abre os Atributos de quem está longe.
   */
  attributes(id: string): AttributesView | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return undefined;
    const power: number = Zone.strength(player);
    const summary = (itemId: string | null): EquippedItemSummary | null => {
      const item: ItemDef | undefined = itemId === null ? undefined : getItem(itemId);
      return item === undefined ? null : { itemId: item.id, name: item.name, set: item.set };
    };
    return {
      id: player.id,
      name: player.name,
      level: player.level,
      maxHp: player.maxHp,
      maxMana: player.maxMana,
      power: { damage: power, healing: power, shield: power },
      equipped: {
        hand: summary(player.look.hand),
        head: summary(player.look.head),
        chest: summary(player.look.chest),
        feet: summary(player.look.feet),
      },
    };
  }

  /** Número de jogadores de verdade na zona (os fakes de teste não contam, [SOC-01]). */
  get size(): number {
    return this.realPlayerCount();
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
      ...(dummy.behavior.kind === "shooter" || dummy.behavior.kind === "punchingBag" || dummy.behavior.kind === "blacksmith" ? { targetable: false } : {}),
      ...(dummy.behavior.kind === "blacksmith" ? { service: "blacksmith" as const } : {}),
      // Monstro ([JOGO-13]): o cliente mostra só vida, nível e lançamento (sem nome).
      ...(dummy.behavior.kind === "zombie" ? { monster: true } : {}),
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
    progress: Progress = STARTING_PROGRESS,
    effects: AttributeEffects = NO_EFFECTS,
    lookLevels: LookLevels = {},
  ): JoinResult {
    if (!this.players.has(member.id) && this.realPlayerCount() >= this.config.maxPlayers) return { status: "full" };
    this.leave(member.id);

    const start: SpawnPoint = spawn ?? this.randomSpawn();
    const factor: number = playerFactor(progress.level);
    const limit: number = this.config.halfSize;
    const player: ZonePlayer = {
      kind: "player",
      id: member.id,
      name: member.name,
      level: progress.level,
      member,
      state: { x: clamp(start.x, -limit, limit), y: start.y, z: clamp(start.z, -limit, limit), rotY: start.rotY },
      hp: round1((PLAYER_MAX_HP + bonusHp) * factor * (1 + effects.health)),
      maxHp: round1((PLAYER_MAX_HP + bonusHp) * factor * (1 + effects.health)),
      mana: round1(PLAYER_MAX_MANA * factor * (1 + effects.mana)),
      maxMana: round1(PLAYER_MAX_MANA * factor * (1 + effects.mana)),
      bonusHp,
      effects,
      lookLevels,
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
      progress,
      readyTick: new Map(),
      attackTarget: null,
      lastMoveTick: Number.NEGATIVE_INFINITY,
      cast: null,
      fake: null,
    };
    this.players.set(member.id, player);

    this.broadcast({ type: ServerMessageType.PlayerJoined, data: { player: Zone.info(player) } }, member.id);
    return { status: "joined", players: Array.from(this.players.values(), (p) => Zone.info(p)) };
  }

  /** Remove o jogador (e do grupo dele, [SOC-03]) e avisa os demais com `player_left`. Ignora ids que não estão na zona. */
  leave(id: string): void {
    if (!this.players.has(id)) return;
    // Sai do grupo e os convites somem ([SOC-03]); antes de sair da lista (os avisos usam o nome).
    this.groups.removePlayer(id);
    this.players.delete(id);
    for (const other of this.players.values()) if (other.attackTarget === id) other.attackTarget = null;
    // Saiu da zona: sai da tabela de ameaça dos monstros ([JOGO-14]).
    this.forgetThreat(id);
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
   * Troca o ataque simples, as cartas, a aparência, a vida extra e os atributos de melhoria ([JOGO-16]) dos itens (o inventário mudou). A recarga de cada
   * POSIÇÃO de carta é mantida ({@link Combatant.readyTick}): a carta nova espera o que faltava da anterior. Aparência diferente vira o evento `look` no próximo snapshot (todos da zona veem a troca).
   * Vida máxima nova: a vida atual acompanha na MESMA proporção (tirar e vestir de novo não cura).
   * Se o alvo fixo não serve mais para o ataque novo (ex.: aliado e agora é uma espada), ele é solto.
   */
  setLoadout(
    id: string,
    basicAttack: AbilityDef,
    abilities: ReadonlyMap<string, AbilityDef>,
    look?: Look,
    bonusHp: number = 0,
    effects: AttributeEffects = NO_EFFECTS,
    lookLevels: LookLevels = {},
  ): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return;
    player.basicAttack = basicAttack;
    player.abilities = abilities;
    player.bonusHp = bonusHp;
    player.effects = effects;
    this.applyPlayerStats(player);
    const target: Entity | undefined = player.attackTarget === null ? undefined : this.entity(player.attackTarget);
    if (target !== undefined && !this.validAttackTarget(player, basicAttack, target)) {
      player.attackTarget = null;
      if (player.cast?.kind === "attack") player.cast = null;
    }
    if (look !== undefined && (!Zone.sameLook(player.look, look) || !Zone.sameLevels(player.lookLevels, lookLevels))) {
      player.look = look;
      player.lookLevels = lookLevels;
      this.events.push({ type: "look", id, look, ...(Object.keys(lookLevels).length > 0 ? { levels: lookLevels } : {}) });
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
    const readyTick: number = player.readyTick.get(Zone.cardSlot(ability.id)) ?? 0;
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
    // Atributo Recarga ([JOGO-16]): menos tempo de recarga.
    player.readyTick.set(Zone.cardSlot(ability.id), this.currentTick + secondsToTicks(ability.cooldown * (1 - player.effects.cooldown)));
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

  /**
   * Tabela de ameaça do monstro `npcId` ([JOGO-14]), cópia só de leitura; `undefined` se o NPC não existe. Não vai para
   * a rede (não há UI de ameaça): serve aos testes e à depuração.
   */
  threatOf(npcId: string): ReadonlyMap<string, number> | undefined {
    return this.dummies.get(npcId)?.threat.snapshot();
  }

  /** Alvo atual do NPC `npcId` (`null` = nenhum; `undefined` = NPC não existe). Testes/depuração ([JOGO-14]). */
  npcTargetOf(npcId: string): string | null | undefined {
    return this.dummies.get(npcId)?.attackTarget;
  }

  /** Estado atual de um jogador, ou `undefined` se não estiver na zona. */
  getSnapshot(id: string): PlayerSnapshot | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player === undefined ? undefined : Zone.snapshot(player);
  }

  /**
   * Um passo da simulação, nesta ordem: renascimentos → movimento → projéteis → decisão dos NPCs ({@link npcThink}) →
   * lançamentos (habilidades e ataque simples, de jogadores e NPCs) → regeneração/escudos → snapshot (e, a cada
   * {@link GROUP_POSITIONS_EVERY_TICKS}, as posições do grupo longe). Os lançamentos vêm depois do movimento: quem está lançando
   * termina o tick virado para o alvo/ponto.
   * Morto não anda (os inputs são consumidos e confirmados sem mover, para o cliente não acumular).
   */
  tick(): void {
    this.currentTick++;
    this.groups.expire(this.currentTick);
    this.respawnDue();
    this.applyMovement();
    // Antes dos lançamentos: o projétil que sai neste tick começa a andar só no próximo (o cliente desenha igual).
    this.moveProjectiles();
    this.npcThink();
    this.applyCasts();
    this.regenerate();
    this.sendSnapshots();
    if (this.currentTick % GROUP_POSITIONS_EVERY_TICKS === 0) this.sendGroupPositions();
    this.events = [];
  }

  private respawnDue(): void {
    for (const entity of this.entities()) {
      if (!entity.dead || this.currentTick < entity.respawnTick) continue;
      entity.dead = false;
      entity.hp = entity.maxHp;
      entity.shield = 0;
      if (entity.kind === "player") {
        // Fake de teste ([SOC-01]) renasce no lugar dele; jogador, no círculo do spawn.
        const spawn: SpawnPoint = entity.fake?.home ?? this.randomSpawn();
        entity.state = { x: spawn.x, y: spawn.y, z: spawn.z, rotY: spawn.rotY };
        entity.mana = entity.maxMana;
      } else {
        entity.state = entity.home;
        entity.returning = false;
        entity.contributors.clear();
        Zone.resetThreat(entity);
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
      player.readyTick.delete(Zone.cardSlot(cast.ability.id));
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
      else if (npc.behavior.kind === "zombie") this.zombieThink(npc, npc.behavior);
    }
  }

  /**
   * Zumbi ([JOGO-13]), a cada tick: voltando → anda para casa e, chegando, enche a vida; longe demais de casa →
   * desiste; jogador inimigo a até `aggroRadius` m de casa entra na tabela de ameaça com {@link THREAT_INITIAL};
   * alvo = pela ameaça ({@link chooseZombieTarget}, [JOGO-14]); ninguém na tabela → volta para casa; com alvo e sem
   * lançamento em andamento → usa a habilidade (pronta e no alcance dela), senão anda até o alcance do ataque simples
   * (o golpe é o mesmo dos jogadores, {@link applyAttack}). Lançando, fica parado.
   */
  private zombieThink(npc: ZoneDummy, behavior: Extract<NpcBehavior, { kind: "zombie" }>): void {
    if (npc.returning) {
      if (this.walkToward(npc, npc.home.x, npc.home.z, behavior.speed)) {
        npc.returning = false;
        npc.hp = npc.maxHp;
      }
      return;
    }
    if (Zone.distance(npc.state, npc.home) > behavior.leashRadius) {
      this.giveUp(npc);
      return;
    }
    // Percepção: quem chega perto da casa entra na tabela com uma ameaça pequena, só para ele começar a vir.
    for (const player of this.players.values()) {
      if (this.isEnemy(npc, player) && Zone.distance(player.state, npc.home) <= behavior.aggroRadius) {
        npc.threat.ensure(player.id, THREAT_INITIAL);
      }
    }
    const target: ZonePlayer | undefined = this.chooseZombieTarget(npc);
    if (target === undefined) {
      this.setNpcTarget(npc, null);
      // Perdeu o alvo (morreu, saiu) longe de casa: volta.
      if (Zone.distance(npc.state, npc.home) > 0.5) this.giveUp(npc);
      return;
    }
    this.setNpcTarget(npc, target.id);
    if (npc.cast !== null) return;
    const ability: AbilityDef | null = npc.ability;
    const slot: string = ability === null ? "" : Zone.cardSlot(ability.id);
    if (ability !== null && this.currentTick >= (npc.readyTick.get(slot) ?? 0) && Zone.inRange(npc, target, ability.range)) {
      npc.readyTick.set(slot, this.currentTick + secondsToTicks(ability.cooldown));
      const dx: number = target.state.x - npc.state.x;
      const dz: number = target.state.z - npc.state.z;
      const length: number = Math.sqrt(dx * dx + dz * dz) || 1;
      const targetId: string | null = ability.aim === "target" ? target.id : null;
      const aimX: number = ability.aim === "direction" ? dx / length : target.state.x;
      const aimZ: number = ability.aim === "direction" ? dz / length : target.state.z;
      this.beginAbilityCast(npc, ability, targetId, aimX, aimZ);
      return;
    }
    if (Zone.distance(npc.state, target.state) > npc.basicAttack.range) {
      this.walkToward(npc, target.state.x, target.state.z, behavior.speed);
      npc.lastMoveTick = this.currentTick;
    }
  }

  /**
   * Alvo do zumbi pela ameaça ([JOGO-14]). Provocado (Desafio) e quem provocou ainda é inimigo → ele, sem olhar a
   * tabela. Senão {@link chooseThreatTarget} entre os jogadores da tabela que ele pode atacar ({@link isEnemy});
   * corpo a corpo = a até o alcance do ataque simples dele + {@link RANGE_TOLERANCE}. Quem não está mais na zona ou
   * morreu sai da tabela aqui também (segurança além de {@link forgetThreat}). `undefined` = ninguém.
   */
  private chooseZombieTarget(npc: ZoneDummy): ZonePlayer | undefined {
    if (npc.tauntedBy !== null) {
      const taunter: ZonePlayer | undefined = this.players.get(npc.tauntedBy);
      if (this.currentTick < npc.tauntUntilTick && taunter !== undefined && this.isEnemy(npc, taunter)) return taunter;
      npc.tauntedBy = null;
    }
    const candidates: ThreatCandidate[] = [];
    for (const [id, threat] of Array.from(npc.threat.entries())) {
      const player: ZonePlayer | undefined = this.players.get(id);
      if (player === undefined || player.dead) {
        npc.threat.remove(id);
        continue;
      }
      if (!this.isEnemy(npc, player)) continue;
      const distance: number = Zone.distance(npc.state, player.state);
      candidates.push({ id, threat, distance, melee: distance <= npc.basicAttack.range + RANGE_TOLERANCE });
    }
    const chosen: string | null = chooseThreatTarget(candidates, npc.attackTarget);
    return chosen === null ? undefined : this.players.get(chosen);
  }

  /**
   * Troca o alvo do NPC. Mudou de alvo: o golpe do ataque simples em andamento contra o anterior é cancelado
   * (`cast_cancel`), como quando o jogador troca de alvo; habilidade em andamento continua.
   */
  private setNpcTarget(npc: ZoneDummy, targetId: string | null): void {
    if (npc.attackTarget === targetId) return;
    npc.attackTarget = targetId;
    if (npc.cast !== null && npc.cast.kind === "attack" && npc.cast.targetId !== targetId) {
      this.events.push({ type: "cast_cancel", source: npc.id, ability: npc.cast.ability.id });
      npc.cast = null;
    }
  }

  /** Esvazia a tabela de ameaça e solta a provocação do monstro ([JOGO-14]). */
  private static resetThreat(npc: ZoneDummy): void {
    npc.threat.clear();
    npc.tauntedBy = null;
    npc.tauntUntilTick = 0;
  }

  /** Tira o jogador `id` da tabela de ameaça (e da provocação) de todos os monstros: morreu ou saiu da zona. */
  private forgetThreat(id: string): void {
    for (const npc of this.dummies.values()) {
      npc.threat.remove(id);
      if (npc.tauntedBy === id) npc.tauntedBy = null;
    }
  }

  /**
   * Desafio ([JOGO-14]): todo monstro vivo, inimigo de `caster` e não voltando para casa, a até `radius` (+ corpo) de
   * quem lançou, é provocado por `tauntSeconds`: vira o alvo na hora (golpe contra outro é cancelado) e a ameaça de
   * `caster` nele sobe para {@link TAUNT_THREAT_MULTIPLIER} × a maior dos outros (no mínimo {@link THREAT_INITIAL};
   * se já for maior, mantém). Só jogadores provocam.
   */
  private taunt(caster: Entity, ability: AbilityDef): void {
    if (caster.kind !== "player") return;
    for (const npc of this.dummies.values()) {
      if (!Zone.isMonster(npc) || npc.dead || npc.returning || !this.isEnemy(npc, caster)) continue;
      if (Zone.distance(npc.state, caster.state) > ability.radius + BODY_RADIUS) continue;
      npc.threat.raiseTo(caster.id, Math.max(THREAT_INITIAL, npc.threat.maxExcept(caster.id) * TAUNT_THREAT_MULTIPLIER));
      npc.tauntedBy = caster.id;
      npc.tauntUntilTick = this.currentTick + secondsToTicks(ability.tauntSeconds);
      this.setNpcTarget(npc, caster.id);
    }
  }

  /** Zumbi desiste: solta o alvo, cancela o que estava lançando e volta para casa ([JOGO-13]). */
  private giveUp(npc: ZoneDummy): void {
    npc.attackTarget = null;
    npc.returning = true;
    // Desistiu: a luta acabou sem morte, ninguém leva XP dela, e a ameaça zera ([JOGO-14]).
    npc.contributors.clear();
    Zone.resetThreat(npc);
    if (npc.cast !== null) {
      this.events.push({ type: "cast_cancel", source: npc.id, ability: npc.cast.ability.id });
      npc.cast = null;
    }
  }

  /**
   * Anda um tick (`speed` m/s) em direção a (x, z), virado para lá, sem passar do ponto nem das bordas.
   * `true` se chegou.
   */
  private walkToward(npc: ZoneDummy, x: number, z: number, speed: number): boolean {
    const dx: number = x - npc.state.x;
    const dz: number = z - npc.state.z;
    const distance: number = Math.sqrt(dx * dx + dz * dz);
    const step: number = speed * TICK_SECONDS;
    const limit: number = this.config.halfSize;
    if (distance <= step) {
      npc.state = { ...npc.state, x: clamp(x, -limit, limit), z: clamp(z, -limit, limit) };
      return true;
    }
    npc.state = {
      x: clamp(npc.state.x + (dx / distance) * step, -limit, limit),
      y: npc.state.y,
      z: clamp(npc.state.z + (dz / distance) * step, -limit, limit),
      rotY: Math.atan2(-dx, -dz),
    };
    return false;
  }

  /** Distância no plano XZ (m). */
  private static distance(a: MoveState, b: MoveState): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
  }

  /**
   * Vida e mana máximas do jogador pelo nível e pelos itens: (base + vida extra) × {@link playerFactor} × (1 + atributo
   * Vida/Mana dos itens melhorados, [JOGO-16]). A vida e a
   * mana atuais acompanham na MESMA proporção (trocar de item ou subir de nível não cura).
   */
  private applyPlayerStats(player: ZonePlayer): void {
    const factor: number = playerFactor(player.level);
    const maxHp: number = round1((PLAYER_MAX_HP + player.bonusHp) * factor * (1 + player.effects.health));
    const maxMana: number = round1(PLAYER_MAX_MANA * factor * (1 + player.effects.mana));
    if (maxHp !== player.maxHp) {
      player.hp = player.dead ? 0 : (player.hp * maxHp) / player.maxHp;
      player.maxHp = maxHp;
    }
    if (maxMana !== player.maxMana) {
      player.mana = (player.mana * maxMana) / player.maxMana;
      player.maxMana = maxMana;
    }
  }

  /**
   * Dá `amount` de XP ([JOGO-12]) e `gold` moedas ([JOGO-15]) ao jogador; subindo de nível, refaz vida/mana máximas e
   * avisa todos (`level_up`). XP e moedas só vão para ele (no `me` do snapshot): os outros veem o nível, não quanto
   * falta nem o dinheiro. O progresso novo vai para quem guarda a conta ({@link ZoneMember.onProgress}).
   */
  private grantReward(player: ZonePlayer, amount: number, gold: number): void {
    const progress: Progress = addGold(addXp(player.progress, amount), gold);
    player.progress = progress;
    if (progress.level !== player.level) {
      player.level = progress.level;
      this.applyPlayerStats(player);
      this.events.push({ type: "level_up", id: player.id, level: progress.level });
      // A lista do grupo mostra o nível de cada membro ([SOC-03]).
      this.groups.refresh(player.id);
    }
    player.member.onProgress?.(progress);
  }

  /**
   * Melhoria no ferreiro ([JOGO-16]): o jogador precisa estar vivo e a até {@link BLACKSMITH_RANGE} m de um ferreiro
   * da zona. Quem decide o resultado é {@link upgradeItem} (com o sorteio {@link random}); aceita, as moedas saem do
   * progresso do jogador (salvo por {@link ZoneMember.onProgress}). Devolve o resultado para quem guarda o inventário.
   */
  upgradeItem(playerId: string, inventory: Inventory, uid: string, attribute: AttributeId): UpgradeResult | { readonly ok: false; readonly reason: "too_far" } {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player === undefined || player.dead || !this.nearBlacksmith(player)) return { ok: false, reason: "too_far" };
    const result: UpgradeResult = upgradeItem(inventory, uid, attribute, player.progress.gold, this.random());
    if (!result.ok) return result;
    player.progress = { ...player.progress, gold: player.progress.gold - result.cost };
    player.member.onProgress?.(player.progress);
    return result;
  }

  /** `true` se há um ferreiro a até {@link BLACKSMITH_RANGE} m (+ corpo) do jogador. */
  private nearBlacksmith(player: ZonePlayer): boolean {
    for (const npc of this.dummies.values()) {
      if (npc.behavior.kind === "blacksmith" && Zone.distance(player.state, npc.state) <= BLACKSMITH_RANGE + BODY_RADIUS) return true;
    }
    return false;
  }

  private shooterThink(npc: ZoneDummy, behavior: Extract<NpcBehavior, { kind: "shooter" }>): void {
    if (npc.cast !== null || this.currentTick < npc.nextActionTick || behavior.rotation.length === 0) return;
    const target: Entity | undefined = this.entity(behavior.target);
    if (target === undefined || target.dead) return;
    const abilityId: string = behavior.rotation[npc.rotationIndex % behavior.rotation.length] ?? "";
    const found: { item: ItemDef; ability: AbilityDef } | undefined = Zone.findAbility(abilityId);
    if (found === undefined) {
      npc.rotationIndex++;
      return;
    }
    // Mesma regra do jogador: a posição da carta ainda recarregando (de outra habilidade) faz esperar.
    const slot: string = Zone.cardSlot(abilityId);
    const ready: number = npc.readyTick.get(slot) ?? 0;
    if (this.currentTick < ready) {
      npc.nextActionTick = ready;
      return;
    }
    npc.rotationIndex++;
    npc.readyTick.set(slot, this.currentTick + secondsToTicks(found.ability.cooldown));
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
    if (player.dead || player.attackTarget === null) {
      // Golpe órfão (o alvo saiu/morreu e já foi solto): não fica "golpeando" o nada.
      if (player.cast?.kind === "attack") player.cast = null;
      return;
    }
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
    // O golpe que acabou de acertar pode ter matado o alvo (a morte solta o alvo de todos): sem golpe novo no corpo.
    if (player.cast !== null || target.dead || player.attackTarget === null) return;
    // Andando (ou acabou de andar) não começa golpe: senão cada passo cancelaria e recomeçaria o ataque.
    if (this.currentTick - player.lastMoveTick <= ATTACK_MOVE_GRACE_TICKS) return;
    const attack: AbilityDef = player.basicAttack;
    if (!Zone.inRange(player, target, attack.range)) return;
    // Atributo Velocidade de ataque ([JOGO-16], só jogador): o golpe (e a soltura do tiro) fica mais curto.
    const speed: number = 1 + (player.kind === "player" ? player.effects.attackSpeed : 0);
    const duration: number = secondsToTicks(attack.castTime / speed);
    const endTick: number = this.currentTick + duration;
    const releaseTick: number = attack.releaseTime > 0 ? endTick - secondsToTicks(attack.releaseTime / speed) : endTick;
    player.cast = { kind: "attack", ability: attack, targetId: target.id, aimX: 0, aimZ: 0, endTick, releaseTick, inRangeAtRelease: null };
    Zone.face(player, target);
    this.events.push({ type: "cast_start", source: player.id, ability: attack.id, target: target.id, duration: duration * TICK_SECONDS, ...Zone.releaseField(player.cast) });
  }

  /**
   * Efeito de uma habilidade no fim do lançamento ([JOGO-06]), com a posição de quem lançou AGORA:
   * - target: dano se o alvo ainda estiver vivo e no alcance; senão erra;
   * - direction: dano no PRIMEIRO inimigo na linha (alcance × largura); ninguém = erra;
   * - area: dano em todos no círculo do ponto; ponto fora do alcance (você se afastou) = erra;
   * - area_self: dano em todos ao redor (e provoca os monstros em volta, se `tauntSeconds`);
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
        // Provocar (Desafio, [JOGO-14]).
        if (ability.tauntSeconds > 0) this.taunt(player, ability);
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
   * máxima (o evento `heal` leva quanto curou de fato); o escudo substitui o anterior. Jogador curando/protegendo
   * jogador: ganha ameaça ({@link THREAT_PER_HEAL} × cura efetiva + escudo dado) em cada monstro que tem o curado na
   * tabela ([JOGO-14]).
   */
  private support(source: Entity, target: Entity, ability: AbilityDef): void {
    if (target.dead) return;
    const factor: number = Zone.strength(source);
    // Curou/protegeu quem está lutando com um monstro: participa da luta (ganha a XP dele, [JOGO-12]).
    if (source.kind === "player" && target.kind === "player") {
      for (const npc of this.dummies.values()) {
        if (!npc.dead && npc.contributors.has(target.id)) npc.contributors.add(source.id);
      }
    }
    let supported: number = 0;
    // Atributos Cura/Escudo de quem cura ([JOGO-16]).
    const healBonus: number = source.kind === "player" ? 1 + source.effects.healing : 1;
    const shieldBonus: number = source.kind === "player" ? 1 + source.effects.shield : 1;
    if (ability.heal > 0) {
      const healed: number = round1(Math.min(target.maxHp - target.hp, ability.heal * factor * healBonus));
      target.hp += healed;
      supported += healed;
      this.events.push({ type: "heal", source: source.id, target: target.id, amount: healed, ability: ability.id });
    }
    if (ability.shield > 0) {
      target.shield = round1(ability.shield * factor * shieldBonus);
      target.shieldUntilTick = this.currentTick + secondsToTicks(ability.shieldSeconds);
      supported += target.shield;
    }
    // Ameaça da cura/escudo ([JOGO-14]): nos monstros que estão lutando com o curado.
    if (supported > 0 && source.kind === "player" && target.kind === "player") {
      for (const npc of this.dummies.values()) {
        if (!npc.dead && !npc.returning && npc.threat.has(target.id)) npc.threat.add(source.id, supported * THREAT_PER_HEAL);
      }
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
   * atinge). Jogador atinge NPCs (menos o saco de pancadas, que é aliado) e jogadores só com PvP na zona e fora do
   * grupo dele ([SOC-03]). NPC
   * atirador atinge o alvo dele e jogadores (no caminho/área); brigão atinge todos ([JOGO-11]); boneco não ataca.
   */
  private isEnemy(source: Entity, target: Entity): boolean {
    if (target.dead || target.id === source.id) return false;
    if (target.kind === "dummy" && (target.behavior.kind === "shooter" || target.behavior.kind === "blacksmith")) return false;
    // Jogador fake de teste: NPCs e monstros não o atacam (senão ele sumia no meio do teste, [SOC-01]).
    if (source.kind === "dummy" && target.kind === "player" && target.fake !== null) return false;
    if (source.kind === "dummy") {
      // Atirador: o alvo dele e qualquer jogador no caminho/área (dá para desviar e testar defesa); outros NPCs não.
      if (source.behavior.kind === "shooter") return target.id === source.behavior.target || target.kind === "player";
      // Zumbi: só jogadores ([JOGO-13]).
      if (source.behavior.kind === "zombie") return target.kind === "player";
      return source.behavior.kind === "brawler";
    }
    if (target.kind === "dummy") return target.behavior.kind !== "punchingBag";
    // Membros do mesmo grupo nunca se atingem, mesmo com PvP ([SOC-03]): vale para alvo, linha, área e projétil.
    if (this.groups.sameGroup(source.id, target.id)) return false;
    return this.config.pvp;
  }

  /**
   * `true` se um jogador pode curar/proteger `target` ([JOGO-09]): jogador vivo — você mesmo ou outro — ou o saco de
   * pancadas de teste ([JOGO-11]). Todo jogador conta como aliado (do grupo ou não, [SOC-03]), mesmo numa zona com PvP
   * (onde quem não é do seu grupo também é inimigo). ATENÇÃO: mesma regra em mmo-client/scripts/world/zone.gd (get_allies).
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

  /** Posição de carta de cada habilidade do catálogo (cache de {@link cardSlot}). */
  private static readonly CARD_SLOTS: Map<string, string> = new Map();

  /**
   * Posição da carta que a habilidade `abilityId` ocupa: slot do item + ordem dela no item ("hand:0", "hand:2",
   * "head:0"...). É a chave da recarga ({@link Combatant.readyTick}). Fora do catálogo: o próprio id.
   */
  static cardSlot(abilityId: string): string {
    const cached: string | undefined = Zone.CARD_SLOTS.get(abilityId);
    if (cached !== undefined) return cached;
    let slot: string = abilityId;
    for (const item of Object.values(ITEMS)) {
      const index: number = item.abilities.findIndex((a) => a.id === abilityId);
      if (index >= 0) {
        slot = `${item.slot}:${index}`;
        break;
      }
    }
    Zone.CARD_SLOTS.set(abilityId, slot);
    return slot;
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
    // Atirador de teste e ferreiro: invulneráveis ([JOGO-11], [JOGO-16]).
    if (target.kind === "dummy" && (target.behavior.kind === "shooter" || target.behavior.kind === "blacksmith")) return;
    // Fake de teste não leva dano de NPC/monstro, nem de área/projétil que passe por ele ([SOC-01]).
    if (source.kind === "dummy" && target.kind === "player" && target.fake !== null) return;
    // Membro do grupo não leva dano de outro membro ([SOC-03]; segurança além do isEnemy).
    if (source.kind === "player" && target.kind === "player" && this.groups.sameGroup(source.id, target.id)) return;
    // Redução de dano ([JOGO-09]) vale antes do escudo; arredonda para inteiro (números limpos na tela).
    // Nível de quem bate ([JOGO-12]): jogador × (1 + 1% por nível), monstro × 1,02^nível × o multiplicador dele.
    // Atributos de melhoria ([JOGO-16]): Dano e Crítico de quem bate (jogador), Defesa de quem apanha (jogador).
    const multiplier: number = source.kind === "dummy" ? source.damageMultiplier : 1 + source.effects.damage;
    const crit: boolean = source.kind === "player" && source.effects.crit > 0 && this.random() < source.effects.crit;
    const scaled: number = round1(amount * Zone.strength(source) * multiplier * (crit ? CRIT_MULTIPLIER : 1));
    const reduced: boolean = target.reduction > 0 && this.currentTick < target.reductionUntilTick;
    const defense: number = target.kind === "player" ? target.effects.defense : 0;
    let remaining: number = round1(scaled * (reduced ? 1 - target.reduction : 1) * (1 - defense));
    let absorbed: number = 0;
    if (target.shield > 0 && this.currentTick < target.shieldUntilTick) {
      absorbed = Math.min(target.shield, remaining);
      target.shield = round1(target.shield - absorbed);
      remaining = round1(remaining - absorbed);
    }
    // Saco de pancadas: não morre, a vida para em 1 ([JOGO-11]).
    const unkillable: boolean = target.kind === "dummy" && target.behavior.kind === "punchingBag";
    const dealt: number = Math.min(unkillable ? Math.max(0, target.hp - 1) : target.hp, remaining);
    target.hp -= dealt;
    if (target.kind === "dummy") {
      target.lastHitTick = this.currentTick;
      if (source.kind === "player" && Zone.isMonster(target)) target.contributors.add(source.id);
      // Ameaça do dano ([JOGO-14]): conta o que tirou da vida e do escudo dele. Quem bate de longe (fora da
      // percepção) entra na tabela por aqui e o zumbi vai atrás. Voltando para casa, não ouve ninguém.
      if (source.kind === "player" && Zone.isMonster(target) && !target.returning) {
        target.threat.add(source.id, (dealt + absorbed) * THREAT_PER_DAMAGE);
      }
    }
    this.events.push({ type: "damage", source: source.id, target: target.id, amount: dealt, absorbed, ability: abilityId, ...(crit ? { crit: true } : {}) });
    // Roubo de vida ([JOGO-16]): parte do dano causado (vida + escudo) volta para quem bateu, até a vida máxima.
    if (source.kind === "player" && source.effects.lifesteal > 0 && !source.dead) {
      const stolen: number = round1(Math.min(source.maxHp - source.hp, (dealt + absorbed) * source.effects.lifesteal));
      if (stolen > 0) {
        source.hp += stolen;
        this.events.push({ type: "heal", source: source.id, target: source.id, amount: stolen, ability: LIFESTEAL_ABILITY });
      }
    }
    if (target.hp > 0) return;
    target.hp = 0;
    target.dead = true;
    const respawnSeconds: number = target.kind === "player" ? PLAYER_RESPAWN_SECONDS : target.respawnSeconds;
    target.respawnTick = this.currentTick + secondsToTicks(respawnSeconds);
    target.shield = 0;
    target.reduction = 0;
    target.attackTarget = null;
    target.cast = null;
    if (target.kind === "player") {
      target.inputs.length = 0;
      target.boost = null;
      target.dash = null;
      // Morreu: sai da tabela de ameaça dos monstros ([JOGO-14]).
      this.forgetThreat(target.id);
    } else {
      Zone.resetThreat(target);
    }
    // Quem atacava o morto solta o alvo, e o golpe do ataque simples em andamento contra ele é cancelado (senão o
    // personagem ficava virado para o corpo, "golpeando", e o ataque travava até trocar de alvo).
    for (const entity of this.entities()) {
      if (entity.attackTarget === target.id) entity.attackTarget = null;
      if (entity.cast?.kind === "attack" && entity.cast.targetId === target.id) {
        this.events.push({ type: "cast_cancel", source: entity.id, ability: entity.cast.ability.id });
        entity.cast = null;
      }
    }
    this.events.push({ type: "death", id: target.id, killer: source.id });
    // Monstro morto: XP inteira + bônus de grupo (+10% por jogador a mais) para cada jogador que participou da luta
    // (bateu, curou ou protegeu) e ainda está na zona, [JOGO-12] — e para cada membro do grupo de um deles que esteja
    // na zona a até GROUP_XP_RADIUS do monstro, mesmo sem ter lutado ([SOC-03]). Cada um conta e ganha uma vez só.
    if (target.kind === "dummy" && Zone.isMonster(target)) {
      const winners: Set<ZonePlayer> = new Set();
      for (const id of target.contributors) {
        const player: ZonePlayer | undefined = this.players.get(id);
        if (player === undefined) continue;
        winners.add(player);
        for (const memberId of this.groups.membersOf(id)) {
          const member: ZonePlayer | undefined = this.players.get(memberId);
          if (member !== undefined && Zone.distance(member.state, target.state) <= GROUP_XP_RADIUS) winners.add(member);
        }
      }
      const reward: number = groupXp(xpReward(target.level), winners.size);
      // Moedas pelo nível do monstro, inteiras para cada um (sem bônus de grupo), [JOGO-15].
      const gold: number = goldReward(target.level);
      for (const player of winners) this.grantReward(player, reward, gold);
      target.contributors.clear();
    }
  }

  /** Monstro: NPC que luta e dá XP (hoje, o zumbi, [JOGO-13]). */
  private static isMonster(entity: ZoneDummy): boolean {
    return entity.behavior.kind === "zombie";
  }

  /**
   * Multiplicador da força (vida, dano, cura, escudo) de quem tem o nível ([JOGO-12]): monstro pela curva dos
   * monstros (2% acumulando), jogador e os outros NPCs pela do jogador (1% por nível, sem acumular).
   */
  private static strength(entity: Entity): number {
    return entity.kind === "dummy" && Zone.isMonster(entity) ? monsterFactor(entity.level) : playerFactor(entity.level);
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
   * Manda a cada jogador o snapshot do tick, só com quem está na área de interesse dele ({@link VIEW_RADIUS}): ele
   * mesmo, o alvo dele e os jogadores/NPCs até essa distância. O JSON de cada entidade é montado uma vez por tick; por
   * destinatário só se escolhe quais entram e se montam `ack` e `me`. Eventos vão para todos.
   */
  private sendSnapshots(): void {
    if (this.realPlayerCount() === 0) return;
    const players: Array<[Entity, string]> = Array.from(this.players.values(), (p): [Entity, string] => [p, JSON.stringify(Zone.snapshot(p))]);
    const npcs: Array<[Entity, string]> = this.npcSnapshots().flatMap((snap): Array<[Entity, string]> => {
      const dummy: ZoneDummy | undefined = this.dummies.get(snap.id);
      return dummy === undefined ? [] : [[dummy, JSON.stringify(snap)]];
    });
    const events: string = JSON.stringify(this.events);
    for (const player of this.players.values()) {
      // Fake de teste não tem conexão: não precisa de snapshot.
      if (player.fake !== null) continue;
      const near = ([entity]: [Entity, string]): boolean => Zone.inView(player, entity);
      const shared: string = [
        `"players":[${players.filter(near).map(([, json]) => json).join(",")}]`,
        `"npcs":[${npcs.filter(near).map(([, json]) => json).join(",")}]`,
        `"events":${events}`,
      ].join(",");
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
        level: player.progress.level,
        xp: player.progress.xp,
        xpNext: xpToNextLevel(player.progress.level),
        gold: player.progress.gold,
      };
      player.member.send(
        `{"type":"${ServerMessageType.Snapshot}","data":{"tick":${this.currentTick},"ack":${player.lastAppliedSeq},${shared},"me":${JSON.stringify(me)}}}`,
      );
    }
  }

  /**
   * `true` se `entity` vai no snapshot de `viewer`: ele mesmo, o alvo dele ou alguém a até {@link VIEW_RADIUS}.
   * Mesma regra no snapshot e no `group_positions` (que manda justamente quem fica de fora).
   */
  private static inView(viewer: ZonePlayer, entity: Entity): boolean {
    return entity.id === viewer.id || entity.id === viewer.attackTarget || Zone.distance(entity.state, viewer.state) <= VIEW_RADIUS;
  }

  /**
   * Manda `group_positions` a cada jogador de verdade que está em grupo: onde estão os membros dele que NÃO vieram no
   * snapshot (longe da área de interesse), para o mapa do Menu ([CLI-11]). Sem grupo, ou com o grupo todo perto,
   * não manda nada: o custo é zero para quem joga sozinho e, com grupo, no máximo 4 posições a
   * {@link GROUP_POSITIONS_HZ} Hz (uma mensagem própria em vez de um campo no snapshot de 20 Hz).
   */
  private sendGroupPositions(): void {
    for (const player of this.players.values()) {
      if (player.fake !== null) continue;
      const far: GroupPositionView[] = [];
      for (const memberId of this.groups.membersOf(player.id)) {
        const member: ZonePlayer | undefined = this.players.get(memberId);
        if (member === undefined || Zone.inView(player, member)) continue;
        far.push({ id: member.id, x: round1(member.state.x), z: round1(member.state.z) });
      }
      if (far.length > 0) player.member.send(encodeServerMessage({ type: ServerMessageType.GroupPositions, data: { members: far } }));
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
      level: entity.level,
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
    const levels: LookLevels = player.lookLevels;
    return {
      ...Zone.snapshot(player),
      name: player.name,
      look: player.look,
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
      body: player.member.body ?? "male",
    };
  }

  /** `true` se as duas aparências vestem o mesmo item em todos os slots. */
  private static sameLook(a: Look, b: Look): boolean {
    return a.hand === b.hand && a.head === b.head && a.chest === b.chest && a.feet === b.feet;
  }

  /** `true` se as peças têm os mesmos níveis de melhoria (brilho, [JOGO-17]). */
  private static sameLevels(a: LookLevels, b: LookLevels): boolean {
    return a.hand === b.hand && a.head === b.head && a.chest === b.chest && a.feet === b.feet;
  }
}

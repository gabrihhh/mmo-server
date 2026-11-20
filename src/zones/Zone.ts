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
  type ChestView,
} from "../net/protocol.js";
import { Groups, type GroupResult } from "./groups.js";
import { Trades, type TradeChange, type TradeResult } from "./trades.js";
import {
  MOVE_SPEED,
  TICK_RATE_HZ,
  TICK_SECONDS,
  MIN_INPUT_LENGTH,
  constrainArena,
  dashMovement,
  quantize,
  stepMovement,
  type MoveParams,
  type MoveState,
} from "../sim/movement.js";
import type { TeamIndex, TeamRoundState } from "../arena/rounds.js";
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
import { STARTING_STATS, addDeath, addKill, addMonsterXp, type PlayerStats } from "../progression/stats.js";
import { CRIT_MULTIPLIER, NO_EFFECTS, type AttributeEffects, type AttributeId } from "../items/attributes.js";
import type { Inventory, ItemStack } from "../items/inventory.js";
import { rollChestLoot, type LootEntry } from "../items/loot.js";
import { fuseItems, type FusionResult } from "../items/fusion.js";
import { deathPenalty, type DeathPenalty } from "../combat/death.js";
import { inSafeZone, pvpKill, pvpLevelsAllowed, type PvpKill } from "../combat/pvp.js";
import { upgradeItem, type UpgradeResult } from "../items/upgrade.js";
import { buyItem, sellItem, type ShopResult } from "../items/shop.js";
import { buyStorageTab, putInStorage, takeFromStorage, type StorageResult } from "../items/storage.js";
import { EQUIP_SLOTS, ITEMS, MONSTER_ABILITIES, UNARMED_ATTACK, dashSteps, getItem, isMovementAbility, type AbilityDef, type ItemDef } from "../items/catalog.js";
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
 * Ticks depois do último passo em que o NPC ainda não começa um golpe do ataque simples (0,1 s; a 30 Hz, 3 ticks):
 * o zumbi que acabou de chegar ao alcance para antes de bater.
 */
const ATTACK_MOVE_GRACE_TICKS: number = Math.max(2, Math.round(0.1 * TICK_RATE_HZ));

/**
 * Chave do ataque simples em {@link Combatant.readyTick}: tick em que o próximo golpe pode sair ([JOGO-05]). Jogador:
 * fim do tempo de execução do golpe anterior. Monstro: intervalo (`cooldown`) entre o início de um golpe e o próximo.
 */
const ATTACK_SLOT = "attack";

/**
 * Folga (ticks) para aceitar o golpe do jogador um pouco antes do fim do anterior: o pedido pode chegar adiantado pela
 * oscilação da rede (o cliente só manda quando o relógio dele acabou). Sem isso, toques no ritmo certo seriam recusados.
 */
const ATTACK_EARLY_TICKS: number = 2;

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
   * Contadores do perfil mudaram (XP de monstros, jogador morto, morreu; [SOC-08]): quem guarda a conta salva.
   * Ausente = não salva (testes, fakes).
   */
  onStats?(stats: PlayerStats): void;
  /**
   * Morreu ([JOGO-21]): a zona já tirou as moedas/XP (e salvou por {@link onProgress}); quem guarda o inventário sorteia
   * a peça da roleta e manda a tela de morte. `killer` = nome de quem matou. Ausente = nada (testes, fakes).
   */
  onDeath?(info: DeathInfo): void;
  /**
   * Multiplicadores da recompensa dos monstros deste jogador (VIP e poção de XP da Loja premium, [JOGO-27]), lidos a
   * cada recompensa (o VIP pode acabar no meio da sessão). Ausente = 1 e 1.
   */
  rewardMultipliers?(): { readonly xp: number; readonly gold: number };
  /**
   * `true` = este jogador oculta convites de grupo: todo convite é recusado sozinho, sem aparecer para ele, e quem
   * convidou recebe o aviso "X recusou o convite" ([SOC-03]). Ausente = mostra os convites.
   * Configuração → "Convites de grupo: Sempre / Ocultar" ([SOC-04], salvo na conta): o GameServer preenche isto no
   * `join` lendo a opção da conta a cada chamada (mudar a opção vale na hora); a zona consulta em
   * {@link Zone.groupInviteAutoAnswer}.
   */
  hidesGroupInvites?(): boolean;
  /**
   * `true` = "Pedidos de troca: Ocultar" ([SOC-05], Configuração): todo pedido de troca é recusado sozinho. Lido a cada
   * pedido (como {@link hidesGroupInvites}). Ausente = mostra os pedidos.
   */
  hidesTradeRequests?(): boolean;
  /** Mochila atual da conta (a troca, [SOC-05], confere e mostra os itens oferecidos). Ausente = mochila vazia (testes). */
  bag?(): readonly ItemStack[];
  /**
   * A troca aconteceu ([SOC-05]): esta é a mochila nova (as moedas novas já vão por {@link onProgress}). Quem guarda a
   * conta troca a mochila, salva e manda o `inventory`. Ausente = nada (testes).
   */
  onTradeBag?(bag: readonly ItemStack[]): void;
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
 *   aí anda até ele a `speed` m/s e bate com o golpe `attack` (ataque simples, de {@link MONSTER_ABILITIES}: zumbi não
 *   segura arma), usando também a habilidade `ability` (idem) quando ela estiver pronta e o alvo no alcance dela. Quem ele ataca sai da tabela de ameaça ([JOGO-14]).
 *   Passou de `leashRadius` m de casa: desiste, volta andando (sem atacar) e enche a vida. Só ataca jogadores. Quem lutou contra ele ganha XP ({@link xpReward} do nível dele + {@link groupXp}) e moedas ({@link goldReward}).
 */
export type NpcBehavior =
  | { readonly kind: "dummy" }
  | { readonly kind: "shooter"; readonly target: string; readonly rotation: readonly string[]; readonly pauseSeconds: number }
  | { readonly kind: "punchingBag"; readonly regenDelaySeconds: number; readonly regenPerSecond: number }
  | { readonly kind: "brawler"; readonly weapon: string }
  /** Ferreiro ([JOGO-16]): parado, invulnerável, não é alvo; perto dele dá para melhorar itens. */
  | { readonly kind: "blacksmith" }
  /** Armazém ([JOGO-26]): baú parado, invulnerável, não é alvo; perto dele guarda/tira itens. */
  | { readonly kind: "storage" }
  /** Mercador ([JOGO-25]): tenda parada, invulnerável, não é alvo; perto dela abre o Mercado entre jogadores. */
  | { readonly kind: "market" }
  | {
      readonly kind: "zombie";
      /** Ataque simples: id em {@link MONSTER_ABILITIES} (ex. `zombie_punch`). */
      readonly attack: string;
      /** Habilidade: id em {@link MONSTER_ABILITIES} ou de um item do catálogo. */
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
  /**
   * Tamanho do corpo (padrão 1): o chefe é um zumbi maior ([JOGO-18]). O cliente desenha o modelo nessa escala e o
   * corpo dele conta maior nos alcances (raio {@link BODY_RADIUS} × escala).
   */
  readonly scale?: number;
  /** Chefe ([JOGO-18]): o cliente mostra o nome dele em dourado e o mapa o marca diferente. Padrão `false`. */
  readonly boss?: boolean;
  /** Multiplicador da XP e das moedas que o monstro dá (padrão 1; chefe dá mais, [JOGO-18]). */
  readonly rewardMultiplier?: number;
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
  /**
   * Estoque de passos ({@link MOVE_BUFFER}; padrão ele). 1 = sem estoque (aplica assim que chega; os testes de mecânica
   * usam para não depender do atraso de 1 tick ao começar a andar).
   */
  readonly moveBuffer?: number;
  /** Bonecos de treino da zona. */
  readonly dummies: readonly DummyConfig[];
  /** Jogadores fake de teste ([SOC-01]); ausente = nenhum. Não contam em `maxPlayers` nem no "online". */
  readonly fakePlayers?: readonly FakePlayerConfig[];
  /** Acampamentos com baú ([JOGO-19]); ausente = nenhum. */
  readonly camps?: readonly CampConfig[];
  /**
   * Área segura no centro ([JOGO-22]): metade do lado (m) do quadrado onde não há PvP (a praça de pedra da zona 1 =
   * `SAFE_ZONE_HALF`). Ausente/0 = nenhuma.
   */
  readonly safeZoneHalf?: number;
  /**
   * Arena do Coliseu ([JOGO-28]): instância de uma partida. Inimigo/aliado só pelo time ({@link Zone.setArenaTeam}),
   * ignorando grupo, guilda, níveis e área segura; ninguém renasce sozinho; morrer não tira nada nem conta no perfil;
   * muro redondo e barreira no meio ({@link Zone.setArenaPhase}). Ausente = zona comum.
   */
  readonly arena?: ArenaZoneConfig;
}

/** Parâmetros da arena do Coliseu ([JOGO-28]). Metros. */
export interface ArenaZoneConfig {
  /** Raio do muro redondo (centro na origem). */
  readonly radius: number;
}

/** Folga (m) da barreira do meio da arena até o plano x = 0 (o corpo não encosta na linha). */
export const ARENA_BARRIER_GAP = 0.5;

/**
 * Acampamento com baú ([JOGO-19]): onde fica o baú (no chão, m) e os monstros dele (ids de `dummies`). O nível do baú
 * é o maior entre os zumbis comuns; com chefe, o loot aumenta (`src/items/loot.ts`).
 */
export interface CampConfig {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly monsterIds: readonly string[];
}

/**
 * Segundos que o baú fica aberto depois de matar o acampamento se NINGUÉM abrir; depois tudo volta (zumbis e baú
 * fechado). Alguém abriu → volta {@link CHEST_RESET_AFTER_OPEN_SECONDS} depois disso ([JOGO-19]).
 */
export const CHEST_OPEN_SECONDS = 120;
/** Segundos entre o primeiro jogador abrir o baú e o acampamento inteiro voltar de uma vez ([JOGO-19]). */
export const CHEST_RESET_AFTER_OPEN_SECONDS = 60;
/**
 * Acampamento pela metade (algum zumbi morto, baú fechado) e este tempo (s) sem combate nele: os mortos voltam todos
 * juntos e a rodada recomeça ([JOGO-19]). Zumbi de acampamento não renasce sozinho.
 */
export const CAMP_IDLE_RESET_SECONDS = 60;
/** Distância (m) do baú para abrir/pegar (+ corpo do jogador). ATENÇÃO: = CHEST_RANGE em mmo-client/scripts/world/zone.gd. */
export const CHEST_RANGE = 3;

/** Estado de um acampamento na zona. */
interface CampState {
  readonly config: CampConfig;
  /** Nível do baú (maior nível entre os zumbis comuns) e se tem chefe. */
  readonly level: number;
  readonly boss: boolean;
  /** Baú aberto (acampamento morto) e até que tick. */
  open: boolean;
  openUntilTick: number;
  /** Algum jogador já abriu o baú desta rodada (o reset passa a ser {@link CHEST_RESET_AFTER_OPEN_SECONDS} depois). */
  opened: boolean;
  /** Último tick com combate no acampamento (zumbi lutando, voltando ou morrendo), para {@link CAMP_IDLE_RESET_SECONDS}. */
  lastCombatTick: number;
  /** Tick da volta que os jogadores já sabem (último evento `chest`, 0 = sem relógio), para o mapa ([CLI-11]). */
  sentResetTick: number;
  /** Quem ajudou a matar o acampamento nesta rodada (ganha baú quando abrir). */
  readonly eligible: Set<string>;
  /** O que sobrou no baú de cada jogador (individual). */
  readonly loot: Map<string, LootEntry[]>;
}

/** Recusa ao abrir/pegar do baú ([JOGO-19]). */
export type ChestFailure = "chest_not_found" | "chest_closed" | "too_far" | "loot_not_found" | "bag_full";

/** O que saiu ao pegar: item (o GameServer põe na mochila) ou moedas (a zona já somou). */
export type TakenLoot = { readonly kind: "item"; readonly stack: ItemStack } | { readonly kind: "gold"; readonly amount: number };

/** Onde e virado para onde o jogador aparece. Metros e radianos. */
export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY: number;
}

/**
 * Diagnóstico da chegada dos passos de um jogador ([INFRA-12]), desde a última leitura ({@link Zone.takeNetStats}):
 * buracos entre passos (rede segurando), ticks em que vieram 2+ de uma vez (rajada), fila e passos jogados fora.
 */
export interface NetStats {
  /** Quando chegou o último passo (ms, `performance.now`); 0 = nenhum ainda. */
  lastArrivalMs: number;
  /** Passos que chegaram. */
  arrivals: number;
  /** Maior intervalo entre dois passos seguidos (ms) e quantos intervalos passaram de 100 ms. */
  maxGapMs: number;
  gapsOver100: number;
  /** Ticks em que 2 ou mais passos foram aplicados juntos (chegaram em rajada). */
  bursts: number;
  /** Maior fila vista no começo de um tick. */
  maxQueue: number;
  /** Passos jogados fora por fila cheia. */
  dropped: number;
}

/** O que a zona conta a quem guarda a conta quando o jogador morre ([JOGO-21]). */
export interface DeathInfo {
  readonly goldLost: number;
  readonly xpLost: number;
  /** Níveis perdidos (morte para jogador: 1, ou 0 no nível 0, [JOGO-22]; morte para monstro: 0). */
  readonly levelsLost: number;
  /** Nome de quem matou (monstro, NPC ou jogador). */
  readonly killer: string;
}

/** Resultado de {@link Zone.join}: lotada, ou aceito com a lista de quem está na zona (inclusive ele). */
export type JoinResult = { readonly status: "full" } | { readonly status: "joined"; readonly players: PlayerInfo[] };

/**
 * Quantos passos de movimento de um jogador a zona aplica por tick, no máximo (se houver crédito, ver
 * {@link MAX_INPUT_CREDIT}). O cliente manda 1 por tick; quando a rede segura os pacotes e solta em rajada (comum no
 * Wi-Fi do celular), a zona alcança o jogador em poucos ticks em vez de jogar comandos fora ([INFRA-09]).
 */
export const MAX_INPUTS_PER_TICK = 4;

/**
 * Crédito de comandos (anti-speedhack sem punir rede ruim, [INFRA-09]): cada tick dá 1 crédito ao jogador, guardado
 * até este máximo (meio segundo de ticks: 15 a 30 Hz); cada PASSO aplicado gasta 1 (habilidade na fila não gasta: tem recarga). Assim, depois de a rede segurar os pacotes por
 * até meio segundo, a rajada é aplicada inteira (sem o "puxão para trás"), mas na média ninguém passa de 1 comando por
 * tick: só dá para gastar o que acumulou parado/travado.
 */
export const MAX_INPUT_CREDIT: number = Math.round(0.5 * TICK_RATE_HZ);

/**
 * Estoque de passos ([INFRA-12]): o celular manda os passos no relógio dele e o servidor aplica no dele; sem estoque,
 * ~20% dos ticks recebiam 0 passos e o seguinte 2 (medido), e o personagem andava "para-pula" para os OUTROS. Ao
 * começar a andar, a zona espera ter este tanto de passos na fila (ou o mais velho ter esperado
 * {@link MOVE_BUFFER_MAX_WAIT_TICKS}) e daí aplica 1 por tick, liso; fila vazia = reabastece. Custa ~1 tick a mais para
 * os outros verem; quem anda não sente (o cliente prevê).
 */
export const MOVE_BUFFER = 2;
/** Espera máxima (ticks) pelo estoque ao começar a andar: um toque curto (1 passo só) não fica preso. */
export const MOVE_BUFFER_MAX_WAIT_TICKS = 1;
/**
 * Fila acima do estoque + isto (passos) = acumulou (rede soltou uma rajada, relógio do celular um pouco mais rápido):
 * aplica mais de 1 por tick para alcançar (até {@link MAX_INPUTS_PER_TICK}, com crédito).
 */
export const MOVE_BUFFER_CATCHUP_EXTRA = 2;

/**
 * Área de interesse (m): cada jogador recebe no snapshot só os jogadores e NPCs a esta distância dele (mais ele
 * mesmo e o alvo dele), como nos MMOs. A câmera mostra ~25 m em volta ([CLI-02]); a folga evita que alguém "pisque"
 * na borda da tela. Menos dados por segundo e o cliente só desenha/anima quem está perto. Ver mmo-docs [INFRA-04].
 *
 * ATENÇÃO: quem sai da vista vai em `snapshot.gone` e o cliente esconde e congela (mmo-client/scripts/network/network.gd,
 * `in_view`); a vista também tem limite na multidão ({@link MAX_VIEW_PLAYERS}).
 */
export const VIEW_RADIUS = 45;

/**
 * Multidão ([INFRA-11]): no máximo tantos jogadores e NPCs na vista de cada um (os mais perto; ele mesmo, o alvo dele e
 * os membros do grupo dentro do raio entram sempre). Sem limite, 100 pessoas no mesmo lugar = cada uma recebe as outras
 * 99 a 30 Hz. ATENÇÃO: quem fica de fora o cliente trata como longe (mmo-client/scripts/network/network.gd).
 */
export const MAX_VIEW_PLAYERS = 40;
/** Ver {@link MAX_VIEW_PLAYERS}. */
export const MAX_VIEW_NPCS = 50;
/**
 * Evento de combate com ponto (impacto, projétil, aviso) vai para quem está a até {@link VIEW_RADIUS} + isto (m) dele,
 * mesmo sem ver quem lançou: cobre o projétil que entra na vista (alcance máximo hoje 16 m) e o raio das áreas.
 */
export const EVENT_VIEW_MARGIN = 20;

/**
 * Ordem dos campos do snapshot em {@link EntityFields} (os que mudam com o tempo; nome, corpo e roupa vão no
 * `welcome`/`player_joined` e no evento `look`). `mana`/`maxMana` só nos jogadores.
 */
const SNAPSHOT_FIELD_KEYS = ["x", "y", "z", "rotY", "hp", "maxHp", "level", "dead", "shield", "guard", "speed", "mana", "maxMana"] as const;

/**
 * Campos de snapshot de uma entidade num tick, já prontos para o envio ([INFRA-11]): valores na ordem de
 * {@link SNAPSHOT_FIELD_KEYS} (posição em mm, giro 0,01 rad), o pedaço de JSON de cada um (`"x":1.25`) e as entradas
 * prontas do snapshot: `fullEntry` (todos os campos, para quem acabou de ver) e `deltaEntry` (só o que mudou desde a
 * versão anterior, para quem viu a anterior — quase todo mundo). Montadas UMA vez por tick para todos os que veem
 * ([INFRA-11] fase 2). Imutável: nada mudou de um tick para o outro = o mesmo objeto.
 */
interface EntityFields {
  readonly idJson: string;
  readonly values: ReadonlyArray<number | boolean>;
  readonly parts: readonly string[];
  /** Cresce 1 a cada mudança da entidade (0 = primeira). */
  readonly version: number;
  /** `{"id":..,todos os campos}`. */
  readonly fullEntry: string;
  /** `{"id":..,campos diferentes da versão `version − 1`}` (vazio na versão 0). */
  readonly deltaEntry: string;
}

/** Célula da grade espacial: jogadores e NPCs dentro dela. */
interface GridCell {
  readonly players: Entity[];
  readonly npcs: Entity[];
}

/** Grade espacial de um tick: célula ({@link Zone.cellKey}, lado {@link VIEW_RADIUS} m) → quem está nela. */
type SpatialGrid = Map<number, GridCell>;

/** Evento do tick já separado para o filtro por vista (`Zone.eventFor`): JSON, ids envolvidos e ponto (ou null). */
interface PreparedEvent {
  readonly json: string;
  /** Vai para todos (troca de roupa). */
  readonly always: boolean;
  readonly ids: readonly string[];
  readonly x: number | null;
  readonly z: number | null;
}

/**
 * Distância (m) do monstro, na hora da morte, até onde um membro do grupo de quem lutou ganha a XP mesmo sem ter batido
 * nem curado ([JOGO-12], [SOC-03]): a mesma da área de interesse (quem está vendo a luta).
 */
export const GROUP_XP_RADIUS = VIEW_RADIUS;

/**
 * A cada quantos ticks a zona manda `group_positions` (os membros do grupo longe, para o mapa; [SOC-03], [CLI-11]):
 * {@link GROUP_POSITIONS_HZ} Hz a {@link TICK_RATE_HZ} Hz de simulação (a 30 Hz, a cada 15 ticks).
 */
export const GROUP_POSITIONS_EVERY_TICKS: number = Math.max(1, Math.round(TICK_RATE_HZ / GROUP_POSITIONS_HZ));

/**
 * Tamanho máximo da fila de comandos por jogador (1 s de comandos: 30 a 30 Hz). Excesso descarta os mais antigos (flood).
 * > mudança (2026-11-15): era 4 — qualquer travada de rede de mais de 200 ms jogava passos fora e o jogador era
 * > puxado para trás ([INFRA-09]).
 */
export const MAX_INPUT_QUEUE: number = TICK_RATE_HZ;

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
  /** Ataque simples (jogador: da arma vestida; NPC brigão: da arma dele; zumbi: golpe de monstro). */
  basicAttack: AbilityDef;
  /**
   * NPC: quem ele está atacando agora (`null` = ninguém); o golpe sai na direção dele ({@link Zone.applyAttack}).
   * Jogador: sempre `null` — o ataque simples é livre, por direção, sem alvo fixo ([JOGO-05]).
   */
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
  /** Crédito de comandos ({@link MAX_INPUT_CREDIT}): +1 por tick, −1 por comando aplicado. */
  inputCredit: number;
  /** Diagnóstico de rede deste jogador ({@link Zone.takeNetStats}, [INFRA-12]). */
  readonly net: NetStats;
  /** Estoque de passos ({@link MOVE_BUFFER}): esperando juntar antes de começar a andar, e há quantos ticks. */
  moveBuffering: boolean;
  moveBufferWait: number;
  /**
   * O que este jogador já recebeu de cada entidade que está na vista dele (id → campos do último envio). O snapshot
   * leva só o que mudou desde então; quem sai da vista vai em `gone` (fase 1 de desempenho, [INFRA-11]).
   */
  view: Map<string, EntityFields>;
  /** Último valor enviado de cada campo do `me` (JSON pronto): o `me` também só leva o que mudou. */
  readonly sentMe: Map<string, string>;
  /** Habilidades (cartas) vestidas, por id ([JOGO-06]). */
  abilities: ReadonlyMap<string, AbilityDef>;
  /** O que veste (aparência que os outros veem). */
  look: Look;
  /** Nível de melhoria das peças vestidas (brilho que os outros veem, [JOGO-17]). */
  lookLevels: LookLevels;
  /** Nível e XP do personagem ([JOGO-12]); vão só para ele, no `me` do snapshot. */
  progress: Progress;
  /** Contadores do perfil ([SOC-08]): XP de monstros, jogadores mortos, mortes. Vão na tela de Atributos. */
  stats: PlayerStats;
  /** Guilda ([SOC-06]): membros da mesma guilda não se batem; a tag vai no {@link PlayerInfo}. `null` = sem guilda. */
  guild: { readonly id: string; readonly tag: string } | null;
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

/**
 * Um lançamento em andamento ([JOGO-05], [JOGO-06]): habilidade, ou golpe do ataque simples de MONSTRO (carregamento
 * com aviso no chão). O golpe do jogador não é lançamento: sai na hora ({@link Zone.startBasicAttack}).
 */
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

/** Saída de {@link Zone.swingHits}: quem o golpe em leque acerta. */
type SwingTargets = Entity[];

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
  /** Tamanho do corpo (1 = normal; chefe maior, [JOGO-18]): o raio do corpo nos alcances cresce junto. */
  readonly scale: number;
  /** Chefe ([JOGO-18]). */
  readonly boss: boolean;
  /** Multiplicador da XP e das moedas que dá (chefe, [JOGO-18]). */
  readonly rewardMultiplier: number;
  /** Zumbi: a habilidade que ele usa (`null` nos outros). */
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

/** Limita `value` ao intervalo fechado [min, max]. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Arredonda vida/mana a 0,1 para o JSON (a conta interna segue com precisão total). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Uma zona do mundo: jogadores, bonecos e a simulação autoritativa deles ([INFRA-09], [JOGO-05]).
 *
 * O cliente NÃO diz onde está nem quanto dano deu: manda `input` (direção) e `cast` (golpe livre ou carta). A cada
 * {@link tick} ({@link TICK_RATE_HZ} Hz) a zona: renasce quem já pode, aplica os inputs, executa os ataques em alcance,
 * regenera vida/mana e manda a cada jogador um `snapshot` com todos os estados, os eventos do tick
 * e os dados só dele (`me`, `ack`).
 */
export class Zone {
  private readonly players: Map<string, ZonePlayer> = new Map();
  private readonly dummies: Map<string, ZoneDummy> = new Map();
  /** Acampamentos com baú ([JOGO-19]) e de qual acampamento é cada monstro. */
  private readonly camps: Map<string, CampState> = new Map();
  private readonly campOf: Map<string, CampState> = new Map();
  /** Campos de snapshot de cada entidade no tick atual ({@link refreshFields}, [INFRA-11]). */
  private readonly fieldCache: Map<string, EntityFields> = new Map();
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
  /** Mochila de mentira dos fakes de teste ([SOC-01]): recebe o que se troca com eles (some ao reiniciar). */
  private readonly fakeBags: Map<string, readonly ItemStack[]> = new Map();
  /** Trocas e pedidos de troca desta zona ([SOC-05]). */
  private readonly trades: Trades = new Trades({
    send: (playerId, message): void => this.players.get(playerId)?.member.send(encodeServerMessage(message)),
    nameOf: (playerId): string | undefined => this.players.get(playerId)?.name,
    distance: (a, b): number | undefined => {
      const pa: ZonePlayer | undefined = this.players.get(a);
      const pb: ZonePlayer | undefined = this.players.get(b);
      return pa === undefined || pb === undefined ? undefined : Zone.distance(pa.state, pb.state);
    },
    bagOf: (playerId): readonly ItemStack[] => this.bagOf(playerId),
    goldOf: (playerId): number => this.players.get(playerId)?.progress.gold ?? 0,
    autoAnswer: (playerId): "accept" | "reject" | null => this.tradeAutoAnswer(playerId),
    autoConfirms: (playerId): boolean => this.players.get(playerId)?.fake?.autoReply === "accept",
    apply: (changes): void => this.applyTrade(changes),
  });

  /** Sorteio (0 a <1) do crítico ([JOGO-16]) e da melhoria no ferreiro; os testes trocam por um fixo. */
  random: () => number = Math.random;

  // --- Arena do Coliseu ([JOGO-28]); só valem com `config.arena` ---
  /** Time de cada jogador da arena. */
  private readonly arenaTeams: Map<string, TeamIndex> = new Map();
  /** Barreira do meio ligada (preparação e pausas). */
  private arenaBarrier: boolean = false;
  /** Cartas e ataque simples travados (preparação e pausas). */
  private arenaLocked: boolean = false;
  /** Dano causado no round por jogador (vida + escudo tirados de inimigos): desempate do fim do tempo. */
  private readonly roundDamage: Map<string, number> = new Map();
  /** Último tick em que cada jogador fez algo de verdade (andou, lançou, escolheu alvo): AFK da arena. */
  private readonly lastActionTick: Map<string, number> = new Map();

  constructor(readonly config: ZoneConfig) {
    for (const dummy of config.dummies) {
      const home: MoveState = { x: dummy.x, y: 0, z: dummy.z, rotY: 0 };
      const behavior: NpcBehavior = dummy.behavior ?? { kind: "dummy" };
      const level: number = dummy.level ?? 0;
      // Monstro: vida × 1,2 × 1,02^nível; os outros NPCs (treino) seguem a curva do jogador ([JOGO-12]).
      const monster: boolean = behavior.kind === "zombie";
      const growth: number = monster ? MONSTER_EDGE * monsterFactor(level) : playerFactor(level);
      const maxHp: number = round1((dummy.maxHp ?? DUMMY_MAX_HP) * growth);
      const weapon: string | null = behavior.kind === "brawler" ? behavior.weapon : null;
      // Zumbi bate com a mão: o golpe dele vem de MONSTER_ABILITIES, não de uma arma ([JOGO-18]).
      const monsterAttack: AbilityDef | undefined = behavior.kind === "zombie" ? MONSTER_ABILITIES[behavior.attack] : undefined;
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
        basicAttack: monsterAttack ?? (weapon === null ? UNARMED_ATTACK : (getItem(weapon)?.basicAttack ?? UNARMED_ATTACK)),
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
        scale: dummy.scale ?? 1,
        boss: dummy.boss ?? false,
        rewardMultiplier: dummy.rewardMultiplier ?? 1,
        ability: behavior.kind === "zombie" ? (MONSTER_ABILITIES[behavior.ability] ?? Zone.findAbility(behavior.ability)?.ability ?? null) : null,
        returning: false,
        contributors: new Set(),
        threat: new ThreatTable(),
        tauntedBy: null,
        tauntUntilTick: 0,
      });
    }
    for (const fake of config.fakePlayers ?? []) this.addFake(fake);
    for (const camp of config.camps ?? []) this.addCamp(camp);
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
      inputCredit: 0,
      moveBuffering: true,
      moveBufferWait: 0,
      net: Zone.emptyNetStats(),
      view: new Map(),
      sentMe: new Map(),
      basicAttack: UNARMED_ATTACK,
      abilities: new Map(),
      look: fake.look,
      progress: { level: fake.level, xp: 0, gold: 0 },
      stats: STARTING_STATS,
      guild: null,
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
  /**
   * Troca a guilda do jogador `id` ([SOC-06]; `null` = saiu) e avisa a zona inteira (`player_guild`: tag no nome e cor
   * de guildeiro). O `GameServer` chama ao entrar na zona e a cada mudança. Ignora quem não está aqui.
   */
  setGuild(id: string, guild: { readonly id: string; readonly tag: string } | null): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return;
    if (player.guild?.id === guild?.id && player.guild?.tag === guild?.tag) return;
    player.guild = guild;
    this.broadcast({ type: ServerMessageType.PlayerGuild, data: { id, guildId: guild?.id ?? null, guildTag: guild?.tag ?? null } });
  }

  /** Nível do jogador `id` se ele está nesta zona, senão `null` (lista da guilda, [SOC-06]). */
  levelOf(id: string): number | null {
    return this.players.get(id)?.level ?? null;
  }

  /** Membros do grupo de [id] nesta zona (vazio = sem grupo, [SOC-03]); usado pelo chat do grupo ([SOC-09]). */
  groupMembersOf(id: string): readonly string[] {
    return this.groups.membersOf(id);
  }

  /**
   * Tira `amount` moedas do jogador `id` (criar guilda, [SOC-06]) e salva por {@link ZoneMember.onProgress}.
   * `false` = não tem moedas suficientes ou não está na zona (nada muda).
   */
  /** Moedas de [id] agora (0 se não está aqui). */
  goldOf(id: string): number {
    return this.players.get(id)?.progress.gold ?? 0;
  }

  /** Dá [amount] moedas a [id] (Mercado: venda ou taxa de volta, [JOGO-25]); `false` se ele não está nesta zona. */
  addGold(id: string, amount: number): boolean {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return false;
    player.progress = { ...player.progress, gold: player.progress.gold + amount };
    player.member.onProgress?.(player.progress);
    this.trades.belongingsChanged(id, this.currentTick);
    return true;
  }

  spendGold(id: string, amount: number): boolean {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined || player.progress.gold < amount) return false;
    player.progress = { ...player.progress, gold: player.progress.gold - amount };
    player.member.onProgress?.(player.progress);
    this.trades.belongingsChanged(id, this.currentTick);
    return true;
  }

  /** Ids dos jogadores fake de teste desta zona ([SOC-01]). */
  fakeIds(): string[] {
    return Array.from(this.players.values()).filter((p) => p.fake !== null).map((p) => p.id);
  }

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

  /**
   * Resposta automática do jogador `id` a um pedido de troca ([SOC-05]), ou `null` = mostrar a janela: fake de teste
   * responde o configurado dele; "Pedidos de troca: Ocultar" ({@link ZoneMember.hidesTradeRequests}) recusa sozinho.
   */
  tradeAutoAnswer(id: string): AutoReply | null {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return null;
    if (player.fake !== null) return player.fake.autoReply;
    if (player.member.hidesTradeRequests?.() === true) return "reject";
    return null;
  }

  /** `from` pede para trocar com `to` ([SOC-05]; regras em {@link Trades.request}). */
  requestTrade(from: string, to: string): TradeResult {
    return this.trades.request(from, to, this.currentTick);
  }

  /** `to` responde ao pedido de troca de `from` ({@link Trades.answer}). */
  answerTrade(to: string, from: string, accept: boolean): TradeResult {
    return this.trades.answer(to, from, accept, this.currentTick);
  }

  /** `id` troca a oferta dele ({@link Trades.offer}). */
  offerTrade(id: string, uids: readonly string[], gold: number): TradeResult {
    return this.trades.offer(id, uids, gold, this.currentTick);
  }

  /** `id` confirma a troca ({@link Trades.confirm}). */
  confirmTrade(id: string): TradeResult {
    return this.trades.confirm(id, this.currentTick);
  }

  /** `id` fecha a janela de troca ({@link Trades.cancel}). */
  cancelTrade(id: string): TradeResult {
    return this.trades.cancel(id, this.currentTick);
  }

  /** `true` se `id` está numa troca aberta. */
  inTrade(id: string): boolean {
    return this.trades.inTrade(id);
  }

  /**
   * A mochila/moedas de `id` mudaram fora da troca (vestir, ferreiro, baú, morte...): a troca dele confere a oferta
   * ({@link Trades.belongingsChanged}). O `GameServer` chama depois de cada mudança no inventário.
   */
  tradeBelongingsChanged(id: string): void {
    this.trades.belongingsChanged(id, this.currentTick);
  }

  /** Mochila do jogador para a troca: a da conta ({@link ZoneMember.bag}) ou, fake, a de mentira. */
  private bagOf(id: string): readonly ItemStack[] {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return [];
    if (player.fake !== null) return this.fakeBags.get(id) ?? [];
    return player.member.bag?.() ?? [];
  }

  /** Aplica uma troca ([SOC-05]): moedas (salvas por `onProgress`) e mochila de cada lado. */
  private applyTrade(changes: readonly TradeChange[]): void {
    for (const change of changes) {
      const player: ZonePlayer | undefined = this.players.get(change.playerId);
      if (player === undefined) continue;
      if (player.progress.gold !== change.gold) {
        player.progress = { ...player.progress, gold: change.gold };
        player.member.onProgress?.(player.progress);
      }
      if (player.fake !== null) this.fakeBags.set(player.id, change.bag);
      else player.member.onTradeBag?.(change.bag);
    }
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
      stats: { monsterXp: player.stats.monsterXp, kills: player.stats.kills, deaths: player.stats.deaths },
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
      ...(dummy.behavior.kind === "shooter" || dummy.behavior.kind === "punchingBag" || Zone.isService(dummy.behavior) ? { targetable: false } : {}),
      ...(dummy.behavior.kind === "blacksmith" ? { service: "blacksmith" as const } : {}),
      ...(dummy.behavior.kind === "storage" ? { service: "storage" as const } : {}),
      ...(dummy.behavior.kind === "market" ? { service: "market" as const } : {}),
      // Monstro ([JOGO-13]): o cliente mostra só vida, nível e lançamento (sem nome).
      ...(dummy.behavior.kind === "zombie" ? { monster: true } : {}),
      // Chefe ([JOGO-18]): maior (escala do modelo) e com o nome à vista.
      ...(dummy.scale !== 1 ? { scale: dummy.scale } : {}),
      ...(dummy.boss ? { boss: true } : {}),
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
    stats: PlayerStats = STARTING_STATS,
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
      // Posição em milímetros desde a entrada (a simulação arredonda assim; o cliente prevê igual).
      state: { x: quantize(clamp(start.x, -limit, limit)), y: start.y, z: quantize(clamp(start.z, -limit, limit)), rotY: start.rotY },
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
      inputCredit: 0,
      moveBuffering: true,
      moveBufferWait: 0,
      net: Zone.emptyNetStats(),
      view: new Map(),
      sentMe: new Map(),
      basicAttack,
      abilities,
      look,
      progress,
      stats,
      guild: null,
      readyTick: new Map(),
      attackTarget: null,
      lastMoveTick: Number.NEGATIVE_INFINITY,
      cast: null,
      fake: null,
    };
    this.players.set(member.id, player);
    this.lastActionTick.set(member.id, this.currentTick);

    this.broadcast({ type: ServerMessageType.PlayerJoined, data: { player: Zone.info(player) } }, member.id);
    return { status: "joined", players: Array.from(this.players.values(), (p) => Zone.info(p)) };
  }

  /** Remove o jogador (e do grupo dele, [SOC-03]) e avisa os demais com `player_left`. Ignora ids que não estão na zona. */
  leave(id: string): void {
    if (!this.players.has(id)) return;
    // Sai do grupo e os convites somem ([SOC-03]); antes de sair da lista (os avisos usam o nome).
    this.groups.removePlayer(id);
    // A troca dele acaba e os pedidos somem ([SOC-05]).
    this.trades.removePlayer(id);
    this.players.delete(id);
    this.lastActionTick.delete(id);
    this.arenaTeams.delete(id);
    this.roundDamage.delete(id);
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
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player !== undefined) {
      const now: number = performance.now();
      const net: NetStats = player.net;
      if (net.lastArrivalMs > 0) {
        const gap: number = now - net.lastArrivalMs;
        net.maxGapMs = Math.max(net.maxGapMs, gap);
        if (gap > 100) net.gapsOver100++;
      }
      net.lastArrivalMs = now;
      net.arrivals++;
    }
    this.enqueue(id, { kind: "move", seq: input.seq, input });
  }

  /** Lê e zera o diagnóstico de rede de `id` ({@link NetStats}); `undefined` se não está na zona. */
  takeNetStats(id: string): NetStats | undefined {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined) return undefined;
    const copy: NetStats = { ...player.net };
    Object.assign(player.net, { ...Zone.emptyNetStats(), lastArrivalMs: player.net.lastArrivalMs });
    return copy;
  }

  private static emptyNetStats(): NetStats {
    return { lastArrivalMs: 0, arrivals: 0, maxGapMs: 0, gapsOver100: 0, bursts: 0, maxQueue: 0, dropped: 0 };
  }

  private enqueue(id: string, command: Command): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (player === undefined || command.seq <= player.lastReceivedSeq) return;
    player.lastReceivedSeq = command.seq;
    player.inputs.push(command);
    while (player.inputs.length > MAX_INPUT_QUEUE) {
      player.inputs.shift();
      player.net.dropped++;
    }
  }

  /**
   * Troca o ataque simples, as cartas, a aparência, a vida extra e os atributos de melhoria ([JOGO-16]) dos itens (o inventário mudou). A recarga de cada
   * POSIÇÃO de carta é mantida ({@link Combatant.readyTick}): a carta nova espera o que faltava da anterior. Aparência diferente vira o evento `look` no próximo snapshot (todos da zona veem a troca).
   * Vida máxima nova: a vida atual acompanha na MESMA proporção (tirar e vestir de novo não cura).
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
    if (look !== undefined && (!Zone.sameLook(player.look, look) || !Zone.sameLevels(player.lookLevels, lookLevels))) {
      player.look = look;
      player.lookLevels = lookLevels;
      this.events.push({ type: "look", id, look, ...(Object.keys(lookLevels).length > 0 ? { levels: lookLevels } : {}) });
    }
  }

  /**
   * Começa a lançar uma habilidade vestida ([JOGO-06]) — ou, com o id do ataque simples da arma, dá um golpe livre
   * ({@link startBasicAttack}, [JOGO-05]). Habilidade: confere vivo e sem outra habilidade em andamento,
   * vestida, disponível, recarga, mana e — mira "target" — alvo válido no alcance. Aceita: gasta a mana,
   * começa a recarga e manda `cast_start`. O efeito sai no fim do lançamento ({@link tick}), se ainda couber no alcance.
   */
  castAbility(id: string, request: CastData): CastResult {
    // Investida/Disparada (e o golpe com passo das adagas) com seq: entram na fila de movimento e são validadas na vez
    // delas ([JOGO-07]).
    const player: ZonePlayer | undefined = this.players.get(id);
    const queued: AbilityDef | undefined =
      player === undefined ? undefined : request.abilityId === player.basicAttack.id ? player.basicAttack : player.abilities.get(request.abilityId);
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
    // Arena na preparação/pausa ([JOGO-28]): cartas travadas.
    if (this.arenaLocked) return Zone.refuse("busy", "Espere o round começar.");
    if (request.abilityId === player.basicAttack.id) return this.startBasicAttack(player, request);
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
        if (target === undefined || !this.isAlly(player, target)) return Zone.refuse("invalid_target", "Escolha um aliado.");
        if (!Zone.inRange(player, target, ability.range)) return Zone.refuse("out_of_range", "Fora de alcance.");
        targetId = target.id;
        break;
      }
      case "area_self":
      case "self":
        break;
    }

    player.mana -= ability.manaCost;
    this.lastActionTick.set(player.id, this.currentTick);
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
  private beginAbilityCast(
    caster: Entity,
    ability: AbilityDef,
    targetId: string | null,
    aimX: number,
    aimZ: number,
    kind: Cast["kind"] = "ability",
  ): Cast {
    const castTicks: number = ability.castTime > 0 ? secondsToTicks(ability.castTime) : 0;
    const endTick: number = this.currentTick + castTicks;
    const cast: Cast = { kind, ability, targetId, aimX, aimZ, endTick, releaseTick: Zone.releaseTick(ability, endTick), inRangeAtRelease: null };
    caster.cast = cast;
    this.faceCast(caster, cast);
    const visual: { x?: number; z?: number; radius?: number; aim?: string; arc?: number } =
      ability.aim === "area"
        ? { x: aimX, z: aimZ, radius: ability.radius }
        : ability.aim === "direction"
          ? Zone.directionVisual(caster, ability, aimX, aimZ)
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
      const end: MoveState = this.startDash(player, ability, dirX, dirZ);
      visual.x = end.x;
      visual.z = end.z;
      duration = dashSteps(ability) * TICK_SECONDS;
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
   * Começa o deslocamento da Investida (ou do passo das adagas): os próximos `round(dashSeconds × tick)` passos
   * percorrem `dashDistance` na direção unitária (dirX, dirZ) ([JOGO-07]). Devolve onde termina, se nada mudar.
   */
  private startDash(player: ZonePlayer, ability: AbilityDef, dirX: number, dirZ: number): MoveState {
    const steps: number = dashSteps(ability);
    player.dash = {
      dirX,
      dirZ,
      stepDistance: ability.dashDistance / steps,
      stepsLeft: steps,
      untilTick: this.currentTick + steps + TICK_RATE_HZ,
    };
    return this.constrain(player, dashMovement(player.state, dirX, dirZ, ability.dashDistance, this.config.halfSize));
  }

  /**
   * Golpe do ataque simples do jogador ([JOGO-05]): livre, na direção pedida (sem direção: para a frente), SEM
   * carregamento — o efeito sai na hora ({@link swing}) e o resto é o tempo de execução (`castTime`, encurtado pelo
   * atributo Velocidade de ataque, [JOGO-16]). Recusa (`busy`) se o golpe anterior ainda está sendo executado (com
   * {@link ATTACK_EARLY_TICKS} de folga) ou se há uma habilidade carregando. Dá para andar durante a execução; uma
   * carta pode ser lançada durante ela. Golpe com passo (adagas): anda `dashDistance` e o golpe vale de onde o passo
   * termina. Manda `cast_start` com `instant` (o cliente anima e mostra o clarão; sem aviso no chão).
   */
  private startBasicAttack(player: ZonePlayer, request: CastData): CastResult {
    const attack: AbilityDef = player.basicAttack;
    if (player.cast !== null && player.cast.kind === "ability") return Zone.refuse("busy", "Termine a habilidade antes de atacar.");
    const ready: number = player.readyTick.get(ATTACK_SLOT) ?? 0;
    if (this.currentTick + ATTACK_EARLY_TICKS < ready) return Zone.refuse("busy", "O golpe anterior ainda não acabou.");
    const length: number = Math.sqrt((request.x ?? 0) ** 2 + (request.z ?? 0) ** 2);
    const dirX: number = length > 1e-6 ? (request.x ?? 0) / length : -Math.sin(player.state.rotY);
    const dirZ: number = length > 1e-6 ? (request.z ?? 0) / length : -Math.cos(player.state.rotY);
    const ticks: number = Math.max(1, secondsToTicks(attack.castTime / (1 + player.effects.attackSpeed)));
    // Aceito adiantado (folga): o próximo conta do fim do anterior, para a folga não encurtar o ritmo de quem toca sem
    // parar (o dano por segundo fica o do catálogo).
    player.readyTick.set(ATTACK_SLOT, Math.max(this.currentTick, ready) + ticks);
    this.lastActionTick.set(player.id, this.currentTick);
    player.state = { ...player.state, rotY: Math.atan2(-dirX, -dirZ) };
    const origin: MoveState = attack.dashDistance > 0 ? this.startDash(player, attack, dirX, dirZ) : player.state;
    this.events.push({
      type: "cast_start",
      source: player.id,
      ability: attack.id,
      target: "",
      duration: ticks * TICK_SECONDS,
      instant: true,
      ...Zone.directionVisual(player, attack, dirX, dirZ),
    });
    this.swing(player, attack, origin.x, origin.z, dirX, dirZ);
    return { ok: true };
  }

  /**
   * Efeito de um golpe por direção (ataque simples do jogador e do NPC brigão, na hora; golpe de monstro, no fim do
   * carregamento): projétil → sai de quem bate; leque (`arc`) → dano em quem está dentro ({@link swingHits}), a partir de
   * (originX, originZ); linha → primeiro inimigo na faixa (via {@link resolveAbility}). Leque sem ninguém: nada (o golpe
   * no ar não é "Errou", só o monstro avisa `miss`).
   */
  private swing(source: Entity, ability: AbilityDef, originX: number, originZ: number, dirX: number, dirZ: number): void {
    if (ability.projectileSpeed > 0) {
      this.launchProjectile(source, ability, dirX, dirZ);
      return;
    }
    const hits: SwingTargets = this.swingHits(source, ability, originX, originZ, dirX, dirZ);
    for (const target of hits) this.damage(source, target, ability.damage, ability.id);
    if (hits.length === 0 && source.kind === "dummy") this.events.push({ type: "miss", source: source.id, target: "", ability: ability.id });
  }

  /**
   * Inimigos de `source` dentro do leque de `ability` ([JOGO-05]): a até `range` + corpo do alvo (+ o quanto o corpo de
   * quem bate passa do normal: chefe) de (originX, originZ) e com o corpo encostando no ângulo de `arc` (total)
   * centrado em (dirX, dirZ). Do mais perto ao mais longe, no máximo `maxTargets` (0 = todos).
   */
  private swingHits(source: Entity, ability: AbilityDef, originX: number, originZ: number, dirX: number, dirZ: number): SwingTargets {
    const found: { entity: Entity; distance: number }[] = [];
    const half: number = ability.arc / 2;
    for (const enemy of this.enemiesOf(source)) {
      const ex: number = enemy.state.x - originX;
      const ez: number = enemy.state.z - originZ;
      const distance: number = Math.sqrt(ex * ex + ez * ez);
      const body: number = Zone.bodyRadius(enemy);
      if (distance > ability.range + body + Zone.extraBody(source)) continue;
      if (distance > body) {
        // Ângulo até o centro do alvo, menos o "pedaço" que o corpo dele ocupa visto de quem bate.
        const angle: number = Math.acos(clamp((ex * dirX + ez * dirZ) / distance, -1, 1));
        if (angle - Math.asin(Math.min(1, body / distance)) > half) continue;
      }
      found.push({ entity: enemy, distance });
    }
    found.sort((a, b) => a.distance - b.distance);
    const limit: number = ability.maxTargets > 0 ? ability.maxTargets : found.length;
    return found.slice(0, limit).map((entry) => entry.entity);
  }

  /**
   * Campos visuais do `cast_start` de uma mira "direction" com direção unitária (dirX, dirZ): ponto no fim do alcance
   * e o raio do aviso — meia-largura da faixa, ou, no leque, o alcance (com `arc`).
   */
  private static directionVisual(caster: Entity, ability: AbilityDef, dirX: number, dirZ: number): { x: number; z: number; radius: number; aim: string; arc?: number } {
    const reach: number = ability.range + Zone.extraBody(caster);
    return {
      x: caster.state.x + dirX * reach,
      z: caster.state.z + dirZ * reach,
      radius: ability.arc > 0 ? reach : ability.radius,
      aim: "direction",
      ...(ability.arc > 0 ? { arc: ability.arc } : {}),
    };
  }

  /**
   * Tabela de ameaça do monstro `npcId` ([JOGO-14]), cópia só de leitura; `undefined` se o NPC não existe. Não vai para
   * a rede (não há UI de ameaça): serve aos testes e à depuração.
   */
  threatOf(npcId: string): ReadonlyMap<string, number> | undefined {
    return this.dummies.get(npcId)?.threat.snapshot();
  }

  /** Id do ataque simples vestido por `playerId` (o `abilityId` do golpe no `cast`), ou `undefined`. Testes/depuração. */
  basicAttackId(playerId: string): string | undefined {
    return this.players.get(playerId)?.basicAttack.id;
  }

  /** Posição (x, z) em metros de um jogador ou NPC da zona, ou `undefined`. Testes/depuração. */
  positionOf(id: string): { readonly x: number; readonly z: number } | undefined {
    const entity: Entity | undefined = this.entity(id);
    return entity === undefined ? undefined : { x: entity.state.x, z: entity.state.z };
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
    this.updateCamps();
    this.applyMovement();
    // Antes dos lançamentos: o projétil que sai neste tick começa a andar só no próximo (o cliente desenha igual).
    this.moveProjectiles();
    this.npcThink();
    this.applyCasts();
    this.regenerate();
    // Trocas ([SOC-05]): pedidos vencidos, distância, contagem final.
    this.trades.tick(this.currentTick);
    this.sendSnapshots();
    if (this.currentTick % GROUP_POSITIONS_EVERY_TICKS === 0) this.sendGroupPositions();
    this.events = [];
  }

  private respawnDue(): void {
    for (const entity of this.entities()) {
      if (!entity.dead || this.currentTick < entity.respawnTick) continue;
      // Monstro de acampamento com o baú aberto só volta no reset ([JOGO-19]).
      if (entity.kind === "dummy" && this.campOf.get(entity.id)?.open === true) continue;
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
      // Crédito: +1 por tick (guarda até MAX_INPUT_CREDIT); cada PASSO gasta 1. Habilidade na fila (Investida,
      // Disparada) não gasta: tem a recarga dela, e gastar deixaria um passo sobrando na fila a cada uma (atraso).
      player.inputCredit = Math.min(MAX_INPUT_CREDIT, player.inputCredit + 1);
      player.net.maxQueue = Math.max(player.net.maxQueue, player.inputs.length);
      // Estoque de passos: quantos passos este tick pode aplicar (0 juntando, 1 normal, mais se acumulou).
      const buffer: number = this.config.moveBuffer ?? MOVE_BUFFER;
      const queuedMoves: number = player.inputs.reduce((count, c) => count + (c.kind === "move" ? 1 : 0), 0);
      if (queuedMoves === 0) {
        player.moveBuffering = true;
        player.moveBufferWait = 0;
      } else if (player.moveBuffering) {
        if (queuedMoves >= buffer || player.moveBufferWait >= MOVE_BUFFER_MAX_WAIT_TICKS) player.moveBuffering = false;
        else player.moveBufferWait++;
      }
      const allowedMoves: number = player.moveBuffering ? 0 : queuedMoves > buffer + MOVE_BUFFER_CATCHUP_EXTRA ? MAX_INPUTS_PER_TICK : 1;
      let moves: number = 0;
      while (player.inputs.length > 0) {
        const next: Command | undefined = player.inputs[0];
        if (next !== undefined && next.kind === "move" && (moves >= allowedMoves || player.inputCredit < 1)) break;
        const command: Command | undefined = player.inputs.shift();
        if (command === undefined) break;
        if (command.kind === "move") {
          moves++;
          player.inputCredit -= 1;
        }
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
      if (moves >= 2) player.net.bursts++;
    }
  }

  /**
   * Um passo de movimento:
   * - Investida em andamento: anda o trecho dela na direção dela (o joystick é ignorado; não gasta Disparada);
   * - senão, anda pelo input (com Disparada, velocidade multiplicada e gasta um passo do bônus). Andar de verdade
   *   CANCELA a habilidade em lançamento ({@link cancelCast}). O ataque simples não é cancelado: dá para andar e bater
   *   ([JOGO-05]).
   */
  private step(player: ZonePlayer, input: InputData): void {
    const dash: DashMove | null = player.dash;
    if (dash !== null) {
      player.state = this.constrain(player, dashMovement(player.state, dash.dirX, dash.dirZ, dash.stepDistance, this.config.halfSize));
      dash.stepsLeft--;
      if (dash.stepsLeft <= 0) player.dash = null;
      return;
    }
    if (Math.sqrt(input.x * input.x + input.z * input.z) >= MIN_INPUT_LENGTH) {
      player.lastMoveTick = this.currentTick;
      this.lastActionTick.set(player.id, this.currentTick);
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
    player.state = this.constrain(player, stepMovement(player.state, input, TICK_SECONDS, params));
  }

  /** Na arena ([JOGO-28]): prende `state` no muro redondo e, com a barreira ligada, no lado do time. */
  private constrain(player: ZonePlayer, state: MoveState): MoveState {
    const arena: ArenaZoneConfig | undefined = this.config.arena;
    if (arena === undefined) return state;
    const team: TeamIndex | undefined = this.arenaTeams.get(player.id);
    const side: -1 | 0 | 1 = !this.arenaBarrier || team === undefined ? 0 : team === 0 ? -1 : 1;
    return constrainArena(state, { radius: arena.radius, side, barrierGap: ARENA_BARRIER_GAP });
  }

  /**
   * Cancela a habilidade em lançamento (o jogador andou, [JOGO-06]) e avisa todos com `cast_cancel` (param a
   * animação, o brilho e o aviso no chão): sem efeito, devolve a mana e zera a recarga (pode lançar de novo na hora).
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
   * Lançamentos, por jogador e NPC:
   * - em andamento (habilidade ou golpe de monstro): fica virado; no fim, resolve o efeito ({@link resolveAbility});
   * - ataque simples dos NPCs ({@link applyAttack}). O do jogador não passa por aqui: sai na hora do pedido
   *   ({@link startBasicAttack}).
   */
  private applyCasts(): void {
    for (const caster of this.entities()) {
      if (caster.dead) continue;
      const cast: Cast | null = caster.cast;
      if (cast !== null) {
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
    // Percepção dos zumbis pela grade dos jogadores ([INFRA-11] fase 2): cada um olha só as células em volta de casa,
    // não a zona inteira (102 zumbis × 400 jogadores eram 40 mil contas por tick). Montada só se tem jogador.
    const playerGrid: SpatialGrid | null = this.players.size === 0 ? null : this.buildGrid(false);
    for (const npc of this.dummies.values()) {
      if (npc.dead) continue;
      if (npc.behavior.kind === "shooter") this.shooterThink(npc, npc.behavior);
      else if (npc.behavior.kind === "brawler") this.brawlerThink(npc);
      else if (npc.behavior.kind === "zombie") this.zombieThink(npc, npc.behavior, playerGrid);
    }
  }

  /**
   * Jogadores da [grid] a até [radius] m de (x, z), sem olhar o resto da zona. Cobre as células que o círculo toca
   * (raio maior que uma célula também funciona).
   */
  private static playersNear(grid: SpatialGrid, x: number, z: number, radius: number): ZonePlayer[] {
    const found: ZonePlayer[] = [];
    const radiusSq: number = radius * radius;
    for (let cx = Zone.cellOf(x - radius); cx <= Zone.cellOf(x + radius); cx++) {
      for (let cz = Zone.cellOf(z - radius); cz <= Zone.cellOf(z + radius); cz++) {
        const cell: GridCell | undefined = grid.get(Zone.cellKey(cx, cz));
        if (cell === undefined) continue;
        for (const entity of cell.players) {
          if (entity.kind !== "player") continue;
          const dx: number = entity.state.x - x;
          const dz: number = entity.state.z - z;
          if (dx * dx + dz * dz <= radiusSq) found.push(entity);
        }
      }
    }
    return found;
  }

  /**
   * Zumbi ([JOGO-13]), a cada tick: voltando → anda para casa e, chegando, enche a vida; longe demais de casa →
   * desiste; jogador inimigo a até `aggroRadius` m de casa entra na tabela de ameaça com {@link THREAT_INITIAL};
   * alvo = pela ameaça ({@link chooseZombieTarget}, [JOGO-14]); ninguém na tabela → volta para casa; com alvo e sem
   * lançamento em andamento → usa a habilidade (pronta e no alcance dela), senão anda até o alcance do ataque simples
   * (o golpe é o mesmo dos jogadores, {@link applyAttack}). Lançando, fica parado.
   */
  private zombieThink(npc: ZoneDummy, behavior: Extract<NpcBehavior, { kind: "zombie" }>, playerGrid: SpatialGrid | null): void {
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
    if (playerGrid !== null) {
      for (const player of Zone.playersNear(playerGrid, npc.home.x, npc.home.z, behavior.aggroRadius)) {
        if (this.isEnemy(npc, player)) npc.threat.ensure(player.id, THREAT_INITIAL);
      }
    }
    // Dormindo: em casa, sem ninguém na tabela nem provocação, nada a fazer neste tick.
    if (npc.threat.size === 0 && npc.tauntedBy === null && npc.attackTarget === null && npc.cast === null &&
      npc.state.x === npc.home.x && npc.state.z === npc.home.z) return;
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
   * Troca o alvo do NPC. O golpe que já está carregando continua: ele é por direção (aviso no chão), não segue o alvo.
   */
  private setNpcTarget(npc: ZoneDummy, targetId: string | null): void {
    npc.attackTarget = targetId;
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
      if (Zone.distance(npc.state, caster.state) > ability.radius + Zone.bodyRadius(npc)) continue;
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

  /** Troca os contadores do perfil de [player] ([SOC-08]); salva por {@link ZoneMember.onStats}. */
  private setStats(player: ZonePlayer, stats: PlayerStats): void {
    player.stats = stats;
    player.member.onStats?.(stats);
  }

  /**
   * Troca o progresso de [player] por [progress] (PvP, [JOGO-22]): mudou o nível → refaz vida/mana máximas, avisa a
   * zona (`level_up` quando sobe) e o grupo; salva por `onProgress`.
   */
  private setProgress(player: ZonePlayer, progress: Progress): void {
    const rose: boolean = progress.level > player.level;
    player.progress = progress;
    if (progress.level !== player.level) {
      player.level = progress.level;
      this.applyPlayerStats(player);
      if (rose) this.events.push({ type: "level_up", id: player.id, level: progress.level });
      this.groups.refresh(player.id);
    }
    player.member.onProgress?.(progress);
  }

  /**
   * Dá `amount` de XP ([JOGO-12]) e `gold` moedas ([JOGO-15]) ao jogador; subindo de nível, refaz vida/mana máximas e
   * avisa todos (`level_up`). XP e moedas só vão para ele (no `me` do snapshot): os outros veem o nível, não quanto
   * falta nem o dinheiro. O progresso novo vai para quem guarda a conta ({@link ZoneMember.onProgress}).
   */
  private grantReward(player: ZonePlayer, amount: number, gold: number): void {
    // Só monstro dá recompensa: a XP entra também no contador do perfil ([SOC-08]) — a XP base, sem o bônus da Loja
    // premium, para o ranking não ser comprado.
    this.setStats(player, addMonsterXp(player.stats, amount));
    // VIP / poção de XP ([JOGO-27]).
    const bonus = player.member.rewardMultipliers?.() ?? { xp: 1, gold: 1 };
    const progress: Progress = addGold(addXp(player.progress, round1(amount * bonus.xp)), Math.round(gold * bonus.gold));
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
   * da zona. Quem decide o resultado é {@link upgradeItem} (com o sorteio {@link random}; [guaranteed] = pedra da Loja
   * premium, não sorteia); aceita, as moedas saem do progresso do jogador (salvo por {@link ZoneMember.onProgress}).
   * Devolve o resultado para quem guarda o inventário.
   */
  upgradeItem(
    playerId: string,
    inventory: Inventory,
    uid: string,
    attribute: AttributeId,
    guaranteed: boolean = false,
  ): UpgradeResult | { readonly ok: false; readonly reason: "too_far" } {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player === undefined || player.dead || !this.nearBlacksmith(player)) return { ok: false, reason: "too_far" };
    // Pedra de melhoria garantida ([JOGO-27]): sorteio 0 = sempre dá certo (quem gasta a pedra é o GameServer).
    const result: UpgradeResult = upgradeItem(inventory, uid, attribute, player.progress.gold, guaranteed ? 0 : this.random());
    if (!result.ok) return result;
    player.progress = { ...player.progress, gold: player.progress.gold - result.cost };
    player.member.onProgress?.(player.progress);
    return result;
  }

  /**
   * Fusão no ferreiro ([JOGO-20]): [playerId] perto de um ferreiro funde [materialUid] em [targetUid] (os dois o mesmo
   * item). Sem moedas; o sorteio dos atributos usa o sorteador da zona. Devolve o resultado para quem guarda o
   * inventário.
   */
  fuseItem(playerId: string, inventory: Inventory, targetUid: string, materialUid: string): FusionResult | { readonly ok: false; readonly reason: "too_far" } {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player === undefined || player.dead || !this.nearBlacksmith(player)) return { ok: false, reason: "too_far" };
    return fuseItems(inventory, targetUid, materialUid, this.random);
  }

  /**
   * Loja do Ferreiro ([JOGO-23]): [playerId] perto de um ferreiro compra [itemId] (`buy`) ou vende o item [uid] da
   * mochila (`sell`). Aceita → as moedas mudam no progresso (salvo por {@link ZoneMember.onProgress}); devolve o
   * resultado para quem guarda o inventário.
   */
  shopTrade(playerId: string, inventory: Inventory, action: "buy" | "sell", id: string): ShopResult | { readonly ok: false; readonly reason: "too_far" } {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player === undefined || player.dead || !this.nearBlacksmith(player)) return { ok: false, reason: "too_far" };
    const result: ShopResult = action === "buy" ? buyItem(inventory, id, player.progress.gold) : sellItem(inventory, id);
    if (!result.ok) return result;
    player.progress = { ...player.progress, gold: player.progress.gold + result.goldDelta };
    player.member.onProgress?.(player.progress);
    return result;
  }

  /**
   * Armazém ([JOGO-26]): [playerId] perto do baú guarda (`put`) ou tira (`take`) o item [uid], ou compra uma aba
   * (`buyTab`, gasta moedas do progresso). [extraTabs] = abas do VIP ([JOGO-27]). Devolve o resultado para quem guarda
   * o inventário.
   */
  storageAction(
    playerId: string,
    inventory: Inventory,
    action: "put" | "take" | "buyTab",
    uid: string,
    extraTabs: number = 0,
  ): StorageResult | { readonly ok: false; readonly reason: "too_far" } {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player === undefined || player.dead || !this.nearService(player, "storage")) return { ok: false, reason: "too_far" };
    const result: StorageResult =
      action === "put" ? putInStorage(inventory, uid, extraTabs) : action === "take" ? takeFromStorage(inventory, uid) : buyStorageTab(inventory, player.progress.gold);
    if (!result.ok) return result;
    if (result.goldDelta !== 0) {
      player.progress = { ...player.progress, gold: player.progress.gold + result.goldDelta };
      player.member.onProgress?.(player.progress);
    }
    return result;
  }

  /** `true` se [playerId] está vivo e a até {@link BLACKSMITH_RANGE} m do Mercador ([JOGO-25]). */
  nearMarket(playerId: string): boolean {
    const player: ZonePlayer | undefined = this.players.get(playerId);
    return player !== undefined && !player.dead && this.nearService(player, "market");
  }

  /** NPC de serviço (ferreiro, armazém, mercador): parado, invulnerável, não é alvo. */
  private static isService(behavior: NpcBehavior): boolean {
    return behavior.kind === "blacksmith" || behavior.kind === "storage" || behavior.kind === "market";
  }

  /** `true` se há um ferreiro a até {@link BLACKSMITH_RANGE} m (+ corpo) do jogador. */
  private nearBlacksmith(player: ZonePlayer): boolean {
    return this.nearService(player, "blacksmith");
  }

  /** `true` se há um NPC de serviço [kind] a até {@link BLACKSMITH_RANGE} m (+ corpo) do jogador (mesmo alcance p/ todos). */
  private nearService(player: ZonePlayer, kind: "blacksmith" | "storage" | "market"): boolean {
    for (const npc of this.dummies.values()) {
      if (npc.behavior.kind === kind && Zone.distance(player.state, npc.state) <= BLACKSMITH_RANGE + BODY_RADIUS) return true;
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
    npc.attackTarget = nearest?.id ?? null;
  }

  /**
   * Ataque simples dos NPCs ([JOGO-05]), a cada tick: com alvo vivo e inimigo no alcance, parado há pelo menos
   * {@link ATTACK_MOVE_GRACE_TICKS}, sem nada carregando e com o golpe pronto ({@link ATTACK_SLOT}), bate NA DIREÇÃO do
   * alvo. Golpe de monstro (`MONSTER_ABILITIES`): carrega `castTime` com aviso no chão (dá para sair) e resolve no fim;
   * o próximo pode começar `cooldown` depois do início. NPC brigão (arma de jogador): sai na hora, como o do jogador.
   * Jogador não passa por aqui: o golpe dele é pedido ({@link startBasicAttack}).
   */
  private applyAttack(entity: Entity): void {
    if (entity.kind !== "dummy" || entity.dead || this.arenaLocked) return;
    const npc: ZoneDummy = entity;
    const targetId: string | null = npc.attackTarget;
    if (targetId === null) return;
    const target: Entity | undefined = this.entity(targetId);
    if (target === undefined || !this.isEnemy(npc, target)) {
      npc.attackTarget = null;
      return;
    }
    if (npc.cast !== null || this.currentTick - npc.lastMoveTick <= ATTACK_MOVE_GRACE_TICKS) return;
    const attack: AbilityDef = npc.basicAttack;
    if (!Zone.inRange(npc, target, attack.range) || this.currentTick < (npc.readyTick.get(ATTACK_SLOT) ?? 0)) return;
    const dx: number = target.state.x - npc.state.x;
    const dz: number = target.state.z - npc.state.z;
    const length: number = Math.sqrt(dx * dx + dz * dz);
    const dirX: number = length > 1e-6 ? dx / length : -Math.sin(npc.state.rotY);
    const dirZ: number = length > 1e-6 ? dz / length : -Math.cos(npc.state.rotY);
    if (MONSTER_ABILITIES[attack.id] === attack) {
      npc.readyTick.set(ATTACK_SLOT, this.currentTick + secondsToTicks(Math.max(attack.cooldown, attack.castTime)));
      this.beginAbilityCast(npc, attack, null, dirX, dirZ, "attack");
      return;
    }
    const ticks: number = Math.max(1, secondsToTicks(attack.castTime));
    npc.readyTick.set(ATTACK_SLOT, this.currentTick + ticks);
    npc.state = { ...npc.state, rotY: Math.atan2(-dirX, -dirZ) };
    this.events.push({
      type: "cast_start",
      source: npc.id,
      ability: attack.id,
      target: "",
      duration: ticks * TICK_SECONDS,
      instant: true,
      ...Zone.directionVisual(npc, attack, dirX, dirZ),
    });
    this.swing(npc, attack, npc.state.x, npc.state.z, dirX, dirZ);
  }

  /**
   * Efeito de uma habilidade no fim do lançamento ([JOGO-06]), com a posição de quem lançou AGORA:
   * - target: dano se o alvo ainda estiver vivo e no alcance; senão erra;
   * - direction: projétil; leque (`arc`, golpe de monstro: dano em todos dentro, {@link swing}); ou dano no PRIMEIRO
   *   inimigo na linha (alcance × largura); ninguém = erra;
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
        if (ability.projectileSpeed > 0 || ability.arc > 0) {
          this.swing(player, ability, player.state.x, player.state.z, cast.aimX, cast.aimZ);
          return;
        }
        let best: Entity | null = null;
        let bestAlong: number = Infinity;
        for (const enemy of this.enemiesOf(player)) {
          const ex: number = enemy.state.x - player.state.x;
          const ez: number = enemy.state.z - player.state.z;
          const along: number = ex * cast.aimX + ez * cast.aimZ;
          const across: number = Math.abs(ex * cast.aimZ - ez * cast.aimX);
          const body: number = Zone.bodyRadius(enemy);
          if (along < 0 || along > ability.range + body || across > ability.radius + body) continue;
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
            if (!this.isAlly(player, ally)) continue;
            const dx: number = ally.state.x - player.state.x;
            const dz: number = ally.state.z - player.state.z;
            if (Math.sqrt(dx * dx + dz * dz) <= ability.radius + BODY_RADIUS) this.support(player, ally, ability);
          }
        }
        return;
      case "ally": {
        const target: Entity | undefined = cast.targetId === null ? undefined : this.entity(cast.targetId);
        if (target !== undefined && this.isAlly(player, target) && Zone.inRange(player, target, ability.range)) {
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
   * primeiro inimigo cujo corpo (+ raio do projétil) encosta no caminho. Projétil que cura (`heal` > 0, raio de luz
   * do Curandeiro, [JOGO-05]): também para no primeiro ALIADO (não inimigo, nunca quem lançou) e cura ele; no
   * inimigo, dá o dano. Acertou ou chegou ao fim: some.
   */
  private moveProjectiles(): void {
    const flying: Projectile[] = [];
    for (const projectile of this.projectiles) {
      const ability: AbilityDef = projectile.ability;
      const step: number = Math.min(ability.projectileSpeed * TICK_SECONDS, ability.range - projectile.traveled);
      let hit: Entity | null = null;
      let hitAlong: number = Infinity;
      for (const enemy of this.projectileTargets(projectile.source, ability)) {
        const reach: number = ability.radius + Zone.bodyRadius(enemy);
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
        if (this.isEnemy(projectile.source, hit)) this.damage(projectile.source, hit, ability.damage, ability.id);
        else this.support(projectile.source, hit, ability);
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
      if (Math.sqrt(dx * dx + dz * dz) <= ability.radius + Zone.bodyRadius(enemy)) this.damage(player, enemy, ability.damage, ability.id);
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
    // Arena ([JOGO-28]): só o time decide (ignora grupo, guilda, níveis e área segura).
    if (this.config.arena !== undefined) {
      const sourceTeam: TeamIndex | undefined = this.arenaTeams.get(source.id);
      const targetTeam: TeamIndex | undefined = this.arenaTeams.get(target.id);
      return sourceTeam !== undefined && targetTeam !== undefined && sourceTeam !== targetTeam;
    }
    if (target.kind === "dummy" && (target.behavior.kind === "shooter" || Zone.isService(target.behavior))) return false;
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
    // Membros do mesmo grupo ([SOC-03]) ou da mesma guilda ([SOC-06]) nunca se atingem, mesmo com PvP: vale para
    // alvo, linha, área e projétil.
    if (this.groups.sameGroup(source.id, target.id) || Zone.sameGuild(source, target)) return false;
    // PvP ([JOGO-22]): só até 10 níveis de diferença e ninguém em cima das pedras da praça (área segura).
    if (!pvpLevelsAllowed(source.level, target.level)) return false;
    const safe: number = this.config.safeZoneHalf ?? 0;
    if (inSafeZone(source.state.x, source.state.z, safe) || inSafeZone(target.state.x, target.state.z, safe)) return false;
    return this.config.pvp;
  }

  /**
   * `true` se um jogador pode curar/proteger `target` ([JOGO-09]): jogador vivo — você mesmo ou outro — ou o saco de
   * pancadas de teste ([JOGO-11]). Todo jogador conta como aliado (do grupo ou não, [SOC-03]), mesmo numa zona com PvP
   * (onde quem não é do seu grupo também é inimigo). ATENÇÃO: mesma regra em mmo-client/scripts/world/zone.gd (get_allies).
   */
  private isAlly(source: Entity, target: Entity): boolean {
    if (target.dead) return false;
    // Arena ([JOGO-28]): só você e o seu time.
    if (this.config.arena !== undefined) {
      if (target.id === source.id) return true;
      const team: TeamIndex | undefined = this.arenaTeams.get(source.id);
      return team !== undefined && this.arenaTeams.get(target.id) === team;
    }
    return target.kind === "player" || target.behavior.kind === "punchingBag";
  }

  /** Quem o projétil de `ability` pode atingir: inimigos e, se ele cura, os aliados (menos quem lançou). */
  private projectileTargets(source: Entity, ability: AbilityDef): Entity[] {
    if (ability.heal <= 0) return this.enemiesOf(source);
    return this.entities().filter((entity) => entity.id !== source.id && (this.isEnemy(source, entity) || this.isAlly(source, entity)));
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
   * dele (conjunto com duas armas: quem lança a carta segura a arma dela).
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
  private static inRange(source: Entity, target: Entity, range: number): boolean {
    const dx: number = target.state.x - source.state.x;
    const dz: number = target.state.z - source.state.z;
    return Math.sqrt(dx * dx + dz * dz) <= range + RANGE_TOLERANCE + Zone.extraBody(source) + Zone.extraBody(target);
  }

  /** Raio do corpo de `entity` (m): {@link BODY_RADIUS} × a escala (chefe maior, [JOGO-18]). */
  private static bodyRadius(entity: Entity): number {
    return entity.kind === "dummy" ? BODY_RADIUS * entity.scale : BODY_RADIUS;
  }

  /** Quanto o corpo de `entity` passa do normal (m; 0 em quem tem escala 1): soma nos alcances de ataque. */
  private static extraBody(entity: Entity): number {
    return Zone.bodyRadius(entity) - BODY_RADIUS;
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
    if (target.kind === "dummy" && (target.behavior.kind === "shooter" || Zone.isService(target.behavior))) return;
    // Fake de teste não leva dano de NPC/monstro, nem de área/projétil que passe por ele ([SOC-01]).
    if (source.kind === "dummy" && target.kind === "player" && target.fake !== null) return;
    // Membro do grupo não leva dano de outro membro ([SOC-03]; segurança além do isEnemy).
    if (this.config.arena === undefined && source.kind === "player" && target.kind === "player" && (this.groups.sameGroup(source.id, target.id) || Zone.sameGuild(source, target))) return;
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
    // Levou dano (mesmo só no escudo): a troca dele acaba ([SOC-05]).
    if (target.kind === "player" && dealt + absorbed > 0) this.trades.damaged(target.id);
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
    // Desempate do round da arena ([JOGO-28]): dano em inimigo (vida + escudo).
    if (this.config.arena !== undefined && source.kind === "player" && this.isEnemy(source, target)) {
      this.roundDamage.set(source.id, (this.roundDamage.get(source.id) ?? 0) + dealt + absorbed);
    }
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
      // Arena ([JOGO-28]): não renasce no round, não perde nada e não conta no perfil.
      if (this.config.arena !== undefined) target.respawnTick = Number.POSITIVE_INFINITY;
      // Perde moedas e XP ([JOGO-21]); a tela de morte (roleta do item) é de quem guarda o inventário. Fake não perde.
      // Contador de mortes do perfil ([SOC-08]); fake não conta.
      if (target.fake === null && this.config.arena === undefined) this.setStats(target, addDeath(target.stats));
      if (this.config.arena !== undefined) {
        // Nada: quem cuida do placar é a partida (ArenaMatch).
      } else if (target.fake === null && source.kind === "player" && source.id !== target.id) {
        // Jogador morto no perfil de quem matou ([SOC-08]).
        if (source.fake === null) this.setStats(source, addKill(source.stats));
        // Morto por jogador ([JOGO-22]): perde 1 nível e 10% das moedas, que vão para quem matou (+1 nível).
        const kill: PvpKill = pvpKill(source.progress, target.progress);
        this.setProgress(source, kill.killer);
        this.setProgress(target, kill.victim);
        target.member.onDeath?.({ goldLost: kill.goldMoved, xpLost: 0, levelsLost: kill.levelsLost, killer: source.name });
      } else if (target.fake === null) {
        const penalty: DeathPenalty = deathPenalty(target.progress);
        target.progress = penalty.progress;
        target.member.onProgress?.(target.progress);
        target.member.onDeath?.({ goldLost: penalty.goldLost, xpLost: penalty.xpLost, levelsLost: 0, killer: source.name });
      }
    } else {
      Zone.resetThreat(target);
    }
    // NPCs que atacavam o morto soltam o alvo (o golpe que já carregava é por direção e termina sozinho).
    for (const entity of this.entities()) {
      if (entity.attackTarget === target.id) entity.attackTarget = null;
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
      // Chefe dá mais (rewardMultiplier, [JOGO-18]).
      const reward: number = round1(groupXp(xpReward(target.level), winners.size) * target.rewardMultiplier);
      // Moedas pelo nível do monstro, inteiras para cada um (sem bônus de grupo), [JOGO-15].
      const gold: number = Math.round(goldReward(target.level) * target.rewardMultiplier);
      for (const player of winners) this.grantReward(player, reward, gold);
      target.contributors.clear();
      const camp: CampState | undefined = this.campOf.get(target.id);
      if (camp !== undefined) {
        // Zumbi de acampamento não renasce sozinho: volta com o acampamento inteiro (resetCamp).
        target.respawnTick = Number.POSITIVE_INFINITY;
        camp.lastCombatTick = this.currentTick;
        for (const player of winners) camp.eligible.add(player.id);
        this.openChestIfCleared(camp);
      }
    }
  }

  // --- Baús dos acampamentos ([JOGO-19]) ---

  private addCamp(config: CampConfig): void {
    const monsters: ZoneDummy[] = config.monsterIds.map((id) => {
      const npc: ZoneDummy | undefined = this.dummies.get(id);
      if (npc === undefined) throw new Error(`acampamento ${config.id}: monstro ${id} não existe na zona`);
      return npc;
    });
    const regular: ZoneDummy[] = monsters.filter((npc) => !npc.boss);
    const state: CampState = {
      config,
      level: Math.max(0, ...(regular.length > 0 ? regular : monsters).map((npc) => npc.level)),
      boss: monsters.some((npc) => npc.boss),
      open: false,
      openUntilTick: 0,
      opened: false,
      lastCombatTick: 0,
      sentResetTick: 0,
      eligible: new Set(),
      loot: new Map(),
    };
    this.camps.set(config.id, state);
    for (const npc of monsters) this.campOf.set(npc.id, state);
  }

  /** Todos os monstros do acampamento mortos ao mesmo tempo → abre o baú e sorteia o de cada um que ajudou. */
  private openChestIfCleared(camp: CampState): void {
    if (camp.open || !camp.config.monsterIds.every((id) => this.dummies.get(id)?.dead === true)) return;
    camp.open = true;
    camp.openUntilTick = this.currentTick + secondsToTicks(CHEST_OPEN_SECONDS);
    for (const id of camp.eligible) {
      if (this.players.has(id)) camp.loot.set(id, rollChestLoot({ level: camp.level, boss: camp.boss }, this.random));
    }
    this.pushCampEvent(camp);
  }

  /**
   * Volta dos acampamentos ([JOGO-19]), a cada tick:
   * - baú aberto e passou o prazo (1 min depois de alguém abrir, ou {@link CHEST_OPEN_SECONDS} se ninguém abriu):
   *   fecha, esquece o que sobrou e o acampamento inteiro volta junto;
   * - baú fechado com algum zumbi morto e {@link CAMP_IDLE_RESET_SECONDS} sem combate (ninguém lutando com os vivos):
   *   os mortos voltam todos juntos e quem ajudou nesta rodada é esquecido.
   */
  private updateCamps(): void {
    for (const camp of this.camps.values()) {
      if (camp.open) {
        if (this.currentTick >= camp.openUntilTick) {
          this.resetCamp(camp);
          this.pushCampEvent(camp);
        } else if (camp.sentResetTick !== camp.openUntilTick) this.pushCampEvent(camp);
        continue;
      }
      for (const id of camp.config.monsterIds) {
        const npc: ZoneDummy | undefined = this.dummies.get(id);
        if (npc !== undefined && !npc.dead && (npc.threat.size > 0 || npc.attackTarget !== null || npc.returning)) {
          camp.lastCombatTick = this.currentTick;
        }
      }
      const resetTick: number = this.campResetTick(camp);
      if (resetTick !== 0 && this.currentTick >= resetTick) this.resetCamp(camp);
      // Relógio começou (combate acabou), parou (voltou a lutar) ou o acampamento voltou: avisa (mapa, [CLI-11]).
      if (this.campResetTick(camp) !== camp.sentResetTick) this.pushCampEvent(camp);
    }
  }

  /**
   * Tick em que o acampamento volta inteiro, 0 = nenhum relógio correndo: baú aberto → o prazo dele; pela metade e
   * sem combate desde o último tick → {@link CAMP_IDLE_RESET_SECONDS} depois do último combate; senão 0.
   */
  private campResetTick(camp: CampState): number {
    if (camp.open) return camp.openUntilTick;
    const anyDead: boolean = camp.config.monsterIds.some((id) => this.dummies.get(id)?.dead === true);
    if (!anyDead || camp.lastCombatTick >= this.currentTick) return 0;
    return camp.lastCombatTick + secondsToTicks(CAMP_IDLE_RESET_SECONDS);
  }

  /** Evento `chest` (vai para toda a zona): aberto ou não e em quantos segundos o acampamento volta (0 = sem relógio). */
  private pushCampEvent(camp: CampState): void {
    const resetTick: number = this.campResetTick(camp);
    camp.sentResetTick = resetTick;
    this.events.push({
      type: "chest",
      id: camp.config.id,
      open: camp.open,
      x: camp.config.x,
      z: camp.config.z,
      resetIn: Zone.ticksToResetIn(resetTick, this.currentTick),
    });
  }

  /** Segundos (0,1) de agora até [resetTick]; 0 = sem relógio. */
  private static ticksToResetIn(resetTick: number, now: number): number {
    return resetTick === 0 ? 0 : Math.max(0.1, round1((resetTick - now) * TICK_SECONDS));
  }

  /** Acampamento volta inteiro: baú fechado e vazio, rodada nova, os mortos renascem no próximo {@link respawnDue}. */
  private resetCamp(camp: CampState): void {
    camp.open = false;
    camp.opened = false;
    camp.eligible.clear();
    camp.loot.clear();
    camp.lastCombatTick = this.currentTick;
    for (const id of camp.config.monsterIds) {
      const npc: ZoneDummy | undefined = this.dummies.get(id);
      if (npc !== undefined && npc.dead) npc.respawnTick = this.currentTick;
    }
  }

  /**
   * "Renascer" na tela de morte ([JOGO-21]): o jogador morto renasce no próximo tick (no spawn), sem esperar o
   * {@link PLAYER_RESPAWN_SECONDS} automático. Vivo ou fora da zona: nada.
   */
  requestRespawn(playerId: string): void {
    // Arena ([JOGO-28]): ninguém renasce no meio do round (sem botão).
    if (this.config.arena !== undefined) return;
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (player !== undefined && player.dead) player.respawnTick = this.currentTick;
  }

  // --- Arena do Coliseu ([JOGO-28]); quem comanda é a partida (src/arena/match.ts) ---

  /** Põe o jogador `id` no time `team` (inimigo/aliado só pelo time). Fora da arena: nada. */
  setArenaTeam(id: string, team: TeamIndex): void {
    if (this.config.arena === undefined || !this.players.has(id)) return;
    this.arenaTeams.set(id, team);
  }

  /**
   * Fase da arena: `barrier` = barreira do meio ligada (cada time preso no seu lado); `locked` = cartas e ataque simples
   * travados. Preparação e pausas: os dois ligados; round: os dois desligados.
   */
  setArenaPhase(barrier: boolean, locked: boolean): void {
    this.arenaBarrier = barrier;
    this.arenaLocked = locked;
  }

  /**
   * Fim do round: tira do jogo tudo o que ainda daria dano ou efeito (projéteis, lançamentos, golpes, alvo fixo, fila
   * de comandos, Investida, Disparada). Depois disto nenhum dano conta para o round que acabou.
   */
  clearArenaCombat(): void {
    this.projectiles = [];
    for (const player of this.players.values()) {
      player.cast = null;
      player.attackTarget = null;
      player.inputs.length = 0;
      player.boost = null;
      player.dash = null;
    }
  }

  /**
   * Começo de round: cada jogador de `spawns` volta vivo no ponto dele, com vida/mana cheias, sem escudo/redução,
   * recargas zeradas e o combate limpo ({@link clearArenaCombat}); quem não está em `spawns` (abandonou) fica morto. O
   * dano do round zera e a contagem de AFK recomeça agora. Manda `respawn` de quem voltou (o cliente reposiciona).
   */
  resetArenaRound(spawns: ReadonlyMap<string, SpawnPoint>): void {
    this.clearArenaCombat();
    this.roundDamage.clear();
    for (const player of this.players.values()) {
      const spawn: SpawnPoint | undefined = spawns.get(player.id);
      player.shield = 0;
      player.shieldUntilTick = 0;
      player.reduction = 0;
      player.reductionUntilTick = 0;
      player.readyTick.clear();
      this.lastActionTick.set(player.id, this.currentTick);
      if (spawn === undefined) {
        player.dead = true;
        player.hp = 0;
        player.respawnTick = Number.POSITIVE_INFINITY;
        continue;
      }
      player.dead = false;
      player.respawnTick = 0;
      player.hp = player.maxHp;
      player.mana = player.maxMana;
      player.state = { x: quantize(spawn.x), y: spawn.y, z: quantize(spawn.z), rotY: spawn.rotY };
      player.moveBuffering = true;
      player.moveBufferWait = 0;
      this.events.push({ type: "respawn", id: player.id });
    }
  }

  /**
   * Estado do time `team` para decidir o round: vida em fração de cada jogador listado em `ids` (fora da zona ou morto
   * = 0) e o dano que eles causaram no round.
   */
  arenaTeamState(ids: readonly string[]): TeamRoundState {
    const hpFractions: number[] = ids.map((id) => {
      const player: ZonePlayer | undefined = this.players.get(id);
      return player === undefined || player.dead || player.maxHp <= 0 ? 0 : player.hp / player.maxHp;
    });
    const damage: number = ids.reduce((total, id) => total + (this.roundDamage.get(id) ?? 0), 0);
    return { hpFractions, damage };
  }

  /**
   * Abandono na arena: o corpo de `id` cai morto e fica assim o resto da partida (não renasce nos rounds seguintes, pois
   * a partida não o põe nos `spawns`). Manda `death` como se tivesse morrido (killer = ele mesmo).
   */
  killInArena(id: string): void {
    const player: ZonePlayer | undefined = this.players.get(id);
    if (this.config.arena === undefined || player === undefined || player.dead) return;
    player.dead = true;
    player.hp = 0;
    player.respawnTick = Number.POSITIVE_INFINITY;
    player.shield = 0;
    player.cast = null;
    player.attackTarget = null;
    player.inputs.length = 0;
    player.boost = null;
    player.dash = null;
    for (const entity of this.entities()) if (entity.attackTarget === id) entity.attackTarget = null;
    this.events.push({ type: "death", id, killer: id });
  }

  /** Conta como "fez algo agora" para o AFK da arena (quem acabou de voltar de uma queda, [JOGO-28]). */
  markActive(id: string): void {
    if (this.players.has(id)) this.lastActionTick.set(id, this.currentTick);
  }

  /** Último tick em que `id` andou, lançou ou escolheu alvo (AFK da arena); `undefined` fora da zona. */
  lastActionTickOf(id: string): number | undefined {
    return this.lastActionTick.get(id);
  }

  /** Todos os jogadores da zona como vão no `welcome` (o da arena, [JOGO-28], monta a lista por aqui). */
  playersInfo(): PlayerInfo[] {
    return Array.from(this.players.values(), (player) => Zone.info(player));
  }

  /** `true` se `id` está na zona e vivo. */
  isAlive(id: string): boolean {
    const player: ZonePlayer | undefined = this.players.get(id);
    return player !== undefined && !player.dead;
  }

  /** Baús da zona como vão no `welcome`: onde ficam, nível, chefe e se está aberto agora. */
  chestViews(): ChestView[] {
    return Array.from(this.camps.values(), (camp) => ({
      id: camp.config.id,
      x: camp.config.x,
      z: camp.config.z,
      level: camp.level,
      boss: camp.boss,
      open: camp.open,
      resetIn: Zone.ticksToResetIn(this.campResetTick(camp), this.currentTick),
    }));
  }

  /** Confere se [playerId] pode mexer no baú [chestId] agora (aberto e a até {@link CHEST_RANGE}). */
  private chestFor(playerId: string, chestId: string): { camp: CampState; player: ZonePlayer } | { failure: ChestFailure } {
    const camp: CampState | undefined = this.camps.get(chestId);
    const player: ZonePlayer | undefined = this.players.get(playerId);
    if (camp === undefined || player === undefined) return { failure: "chest_not_found" };
    if (!camp.open) return { failure: "chest_closed" };
    const dx: number = player.state.x - camp.config.x;
    const dz: number = player.state.z - camp.config.z;
    if (player.dead || Math.sqrt(dx * dx + dz * dz) > CHEST_RANGE + BODY_RADIUS) return { failure: "too_far" };
    return { camp, player };
  }

  /** O que sobrou no baú [chestId] para [playerId] (vazio = nada para ele), ou a recusa. */
  chestLoot(playerId: string, chestId: string): readonly LootEntry[] | ChestFailure {
    const found = this.chestFor(playerId, chestId);
    if ("failure" in found) return found.failure;
    // Primeiro a abrir (quem ajudou, tem sorteio): o acampamento volta 1 min depois ([JOGO-19]). Quem só passou e
    // olhou o baú vazio não encurta o tempo de quem lutou.
    if (!found.camp.opened && found.camp.loot.has(playerId)) {
      found.camp.opened = true;
      found.camp.openUntilTick = this.currentTick + secondsToTicks(CHEST_RESET_AFTER_OPEN_SECONDS);
    }
    return found.camp.loot.get(playerId) ?? [];
  }

  /**
   * Pega [lootId] do baú [chestId] de [playerId]. Moedas: a zona soma ao progresso (salva por `onProgress`). Item: sai
   * do baú e volta para quem chamou pôr na mochila — com [bagHasRoom] falso, recusa (`bag_full`) e o item fica no baú.
   */
  takeLoot(playerId: string, chestId: string, lootId: string, bagHasRoom: boolean): TakenLoot | ChestFailure {
    const found = this.chestFor(playerId, chestId);
    if ("failure" in found) return found.failure;
    const entries: LootEntry[] = found.camp.loot.get(playerId) ?? [];
    const index: number = entries.findIndex((entry) => entry.lootId === lootId);
    const entry: LootEntry | undefined = entries[index];
    if (entry === undefined) return "loot_not_found";
    if (entry.kind === "item" && !bagHasRoom) return "bag_full";
    entries.splice(index, 1);
    if (entry.kind === "gold") {
      found.player.progress = addGold(found.player.progress, entry.amount);
      found.player.member.onProgress?.(found.player.progress);
      return { kind: "gold", amount: entry.amount };
    }
    return { kind: "item", stack: entry.stack };
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
  /**
   * Snapshot de cada jogador ([INFRA-04], [INFRA-11]): **só o que mudou** desde o último que ele recebeu.
   * - `players`/`npcs`: entidades da vista dele ({@link selectView}) com ao menos um campo diferente do último envio
   *   (só esses campos + `id`); quem acabou de entrar na vista vai com todos os campos. Quem não veio está igual.
   * - `gone`: ids que estavam na vista e saíram (longe, limite da multidão ou saíram da zona).
   * - `events`: só os que interessam a ele ({@link eventFor}).
   * - `me`: só os campos que mudaram.
   *
   * Barato de propósito (é o laço mais quente do servidor): os campos de cada entidade são montados UMA vez por tick
   * ({@link refreshFields}) e, se nada mudou, o objeto do tick anterior é reaproveitado — então "não mudou desde o
   * último envio" é só comparar referência. Os pedaços de JSON (`"x":1.25`) já vêm prontos; quem está perto sai de
   * uma grade espacial ({@link buildGrid}), não de comparar todo mundo com todo mundo.
   */
  private sendSnapshots(): void {
    if (this.realPlayerCount() === 0) return;
    this.refreshFields();
    const grid: SpatialGrid = this.buildGrid();
    const events: PreparedEvent[] = this.events.map(Zone.prepareEvent);
    for (const player of this.players.values()) {
      // Fake de teste não tem conexão: não precisa de snapshot.
      if (player.fake !== null) continue;
      const visible: { players: Entity[]; npcs: Entity[] } = this.selectView(player, grid);
      const next: Map<string, EntityFields> = new Map();
      const playersJson: string = this.section(player, visible.players, next);
      const npcsJson: string = this.section(player, visible.npcs, next);
      let gone: string = "";
      for (const id of player.view.keys()) {
        if (!next.has(id)) gone += (gone.length > 0 ? "," : "") + JSON.stringify(id);
      }
      player.view = next;
      let eventsJson: string = "";
      for (const prepared of events) {
        if (Zone.eventFor(player, prepared)) eventsJson += (eventsJson.length > 0 ? "," : "") + prepared.json;
      }
      const me: string = Zone.meDiff(player, this.ownStatus(player));
      player.member.send(
        `{"type":"${ServerMessageType.Snapshot}","data":{"tick":${this.currentTick},"ack":${player.lastAppliedSeq},` +
          `"players":[${playersJson}],"npcs":[${npcsJson}],"gone":[${gone}],"events":[${eventsJson}],"me":{${me}}}}`,
      );
    }
  }

  /**
   * Entradas de [list] para [viewer] (`{"id":..,campos que mudaram}` separadas por vírgula) e anota em [next] o que
   * ele passa a conhecer. Mesmo objeto do último envio = nada mudou = nada vai.
   */
  private section(viewer: ZonePlayer, list: readonly Entity[], next: Map<string, EntityFields>): string {
    let out: string = "";
    for (const entity of list) {
      const now: EntityFields | undefined = this.fieldCache.get(entity.id);
      if (now === undefined) continue;
      next.set(entity.id, now);
      const before: EntityFields | undefined = viewer.view.get(entity.id);
      if (before === now) continue;
      let entry: string;
      if (before === undefined) entry = now.fullEntry;
      // O caso comum (viu a versão anterior): a entrada já está pronta, igual para todos.
      else if (before.version === now.version - 1) entry = now.deltaEntry;
      else {
        const diff: string = Zone.fieldsDiff(before, now.values, now.parts);
        entry = diff.length === 0 ? "" : `{"id":${now.idJson},${diff}}`;
      }
      if (entry.length > 0) out += (out.length > 0 ? "," : "") + entry;
    }
    return out;
  }

  /**
   * Campos de snapshot de cada entidade neste tick ({@link fieldCache}). Igual ao tick anterior → mantém o MESMO
   * objeto (é assim que {@link section} sabe, por referência, que nada mudou). Quem saiu da zona sai do cache.
   */
  private refreshFields(): void {
    const alive: Set<string> = new Set();
    for (const entity of this.entities()) {
      alive.add(entity.id);
      const snap: PlayerSnapshot = Zone.snapshot(entity);
      const values: Array<number | boolean> = [snap.x, snap.y, snap.z, snap.rotY, snap.hp, snap.maxHp, snap.level, snap.dead, snap.shield, snap.guard, snap.speed];
      if (snap.mana !== undefined && snap.maxMana !== undefined) values.push(snap.mana, snap.maxMana);
      const cached: EntityFields | undefined = this.fieldCache.get(entity.id);
      if (cached !== undefined && Zone.sameValues(cached.values, values)) continue;
      const parts: string[] = values.map((value, i) => `"${SNAPSHOT_FIELD_KEYS[i] ?? ""}":${String(value)}`);
      const idJson: string = cached?.idJson ?? JSON.stringify(entity.id);
      const fullEntry: string = `{"id":${idJson},${parts.join(",")}}`;
      const delta: string = cached === undefined ? "" : Zone.fieldsDiff(cached, values, parts);
      this.fieldCache.set(entity.id, {
        idJson,
        values,
        parts,
        version: cached === undefined ? 0 : cached.version + 1,
        fullEntry,
        deltaEntry: delta.length === 0 ? "" : `{"id":${idJson},${delta}}`,
      });
    }
    for (const id of Array.from(this.fieldCache.keys())) if (!alive.has(id)) this.fieldCache.delete(id);
  }

  /** Mesmos valores, na mesma ordem. */
  private static sameValues(a: ReadonlyArray<number | boolean>, b: ReadonlyArray<number | boolean>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Pedaços de JSON (`"x":1.25,...`) dos campos de [values] diferentes de [before] (outra quantidade = todos). */
  private static fieldsDiff(before: EntityFields, values: ReadonlyArray<number | boolean>, parts: readonly string[]): string {
    if (before.values.length !== values.length) return parts.join(",");
    let diff: string = "";
    for (let i = 0; i < values.length; i++) {
      if (before.values[i] !== values[i]) diff += (diff.length > 0 ? "," : "") + (parts[i] ?? "");
    }
    return diff;
  }

  /**
   * Grade espacial (células de {@link VIEW_RADIUS} m): quem está perto de alguém fica nas 9 células em volta.
   * `withNpcs = false` monta só a dos jogadores (percepção dos monstros, {@link npcThink}).
   */
  private buildGrid(withNpcs: boolean = true): SpatialGrid {
    const grid: SpatialGrid = new Map();
    const add = (entity: Entity, kind: "players" | "npcs"): void => {
      const key: number = Zone.cellKey(Zone.cellOf(entity.state.x), Zone.cellOf(entity.state.z));
      let cell: GridCell | undefined = grid.get(key);
      if (cell === undefined) {
        cell = { players: [], npcs: [] };
        grid.set(key, cell);
      }
      cell[kind].push(entity);
    };
    for (const player of this.players.values()) add(player, "players");
    if (withNpcs) for (const npc of this.dummies.values()) add(npc, "npcs");
    return grid;
  }

  /** Coluna/linha da grade de uma coordenada (m). */
  private static cellOf(coordinate: number): number {
    return Math.floor(coordinate / VIEW_RADIUS);
  }

  /**
   * Chave numérica da célula (mais barata que texto no `Map`). Única enquanto |cz| < 2048 células (92 km): o mapa
   * tem 300 m.
   */
  private static cellKey(cx: number, cz: number): number {
    return cx * 4096 + cz;
  }

  /** O que vai no `me` de [player] (todos os campos; {@link meDiff} escolhe os que mudaram). */
  private ownStatus(player: ZonePlayer): OwnStatus {
    return {
      mana: round1(player.mana),
      maxMana: player.maxMana,
      // Arena ([JOGO-28]): morto não renasce no round (tick infinito) → 0, não Infinity (vira null no JSON).
      respawnIn: player.dead && Number.isFinite(player.respawnTick) ? round1(Math.max(0, player.respawnTick - this.currentTick) * TICK_SECONDS) : 0,
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
  }

  /** Campos do `me` que mudaram desde o último envio a [player] (`"chave":valor,...`; vazio = nada mudou). */
  private static meDiff(player: ZonePlayer, me: OwnStatus): string {
    let out: string = "";
    for (const [key, value] of Object.entries(me)) {
      const json: string = typeof value === "number" ? String(value) : JSON.stringify(value);
      if (player.sentMe.get(key) === json) continue;
      player.sentMe.set(key, json);
      out += `${out.length > 0 ? "," : ""}"${key}":${json}`;
    }
    return out;
  }

  /**
   * Quem [viewer] vê neste tick ([INFRA-11]): ele mesmo e quem está a até {@link VIEW_RADIUS} (procurado
   * só nas 9 células da [grid] em volta); na multidão, os {@link MAX_VIEW_PLAYERS} jogadores e {@link MAX_VIEW_NPCS}
   * NPCs mais perto (ele e os membros do grupo no raio entram sempre, sem contar no limite). Não há mais alvo fixo
   * para trazer de longe: o ataque simples é por direção ([JOGO-05]).
   */
  private selectView(viewer: ZonePlayer, grid: SpatialGrid): { players: Entity[]; npcs: Entity[] } {
    const group: readonly string[] = this.groups.membersOf(viewer.id);
    const cx: number = Zone.cellOf(viewer.state.x);
    const cz: number = Zone.cellOf(viewer.state.z);
    const vx: number = viewer.state.x;
    const vz: number = viewer.state.z;
    const radiusSq: number = VIEW_RADIUS * VIEW_RADIUS;
    const pick = (kind: "players" | "npcs", max: number): Entity[] => {
      const always: Entity[] = [];
      // Candidatos e a distância² de cada um em listas paralelas (sem um objeto por candidato a cada tick).
      const near: Entity[] = [];
      const nearSq: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell: GridCell | undefined = grid.get(Zone.cellKey(cx + dx, cz + dz));
          if (cell === undefined) continue;
          for (const entity of cell[kind]) {
            if (entity.id === viewer.id) continue;
            const ex: number = entity.state.x - vx;
            const ez: number = entity.state.z - vz;
            const distanceSq: number = ex * ex + ez * ez;
            if (distanceSq > radiusSq) continue;
            if (group.length > 0 && group.includes(entity.id)) always.push(entity);
            else {
              near.push(entity);
              nearSq.push(distanceSq);
            }
          }
        }
      }
      // Ele mesmo entra sempre.
      if (kind === "players" && !always.includes(viewer)) always.push(viewer);
      if (near.length <= max) {
        for (const entity of near) always.push(entity);
        return always;
      }
      // Multidão: só os `max` mais perto.
      const order: number[] = near.map((_, i) => i).sort((a, b) => (nearSq[a] ?? 0) - (nearSq[b] ?? 0));
      for (let i = 0; i < max; i++) {
        const entity: Entity | undefined = near[order[i] ?? 0];
        if (entity !== undefined) always.push(entity);
      }
      return always;
    };
    return { players: pick("players", MAX_VIEW_PLAYERS), npcs: pick("npcs", MAX_VIEW_NPCS) };
  }

  /** Separa uma vez por tick o que {@link eventFor} olha em cada evento (ids envolvidos, ponto) e o JSON dele. */
  private static prepareEvent(event: CombatEvent): PreparedEvent {
    const ids: string[] = [];
    for (const key of ["source", "target", "id", "killer"]) {
      const id: unknown = Reflect.get(event, key);
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    const x: unknown = Reflect.get(event, "x");
    const z: unknown = Reflect.get(event, "z");
    return {
      json: JSON.stringify(event),
      // Troca de roupa e baú abrindo/fechando vão para todos (raros; o cliente guarda o estado de todos).
      always: event.type === "look" || event.type === "chest",
      ids,
      x: typeof x === "number" ? x : null,
      z: typeof z === "number" ? z : null,
    };
  }

  /**
   * O evento interessa a [viewer]? Troca de roupa (`look`) vai para todos (é rara e o cliente guarda a roupa de todos).
   * Os outros: se envolve ele ou alguém da vista dele (`source`, `target`, `id`, `killer`), ou se tem um ponto a até
   * {@link VIEW_RADIUS} + {@link EVENT_VIEW_MARGIN} dele. Chamar depois de atualizar `viewer.view`.
   */
  private static eventFor(viewer: ZonePlayer, event: PreparedEvent): boolean {
    if (event.always) return true;
    for (const id of event.ids) if (id === viewer.id || viewer.view.has(id)) return true;
    if (event.x !== null && event.z !== null) {
      const dx: number = event.x - viewer.state.x;
      const dz: number = event.z - viewer.state.z;
      return dx * dx + dz * dz <= (VIEW_RADIUS + EVENT_VIEW_MARGIN) ** 2;
    }
    return false;
  }

  /**
   * Manda `group_positions` a cada jogador de verdade que está em grupo: onde estão os membros dele que NÃO vieram no
   * snapshot (longe da área de interesse), para o mapa do Menu ([CLI-11]). Sem grupo, ou com o grupo todo perto,
   * não manda nada: o custo é zero para quem joga sozinho e, com grupo, no máximo 4 posições a
   * {@link GROUP_POSITIONS_HZ} Hz (uma mensagem própria em vez de um campo no snapshot de 30 Hz).
   */
  private sendGroupPositions(): void {
    for (const player of this.players.values()) {
      if (player.fake !== null) continue;
      const far: GroupPositionView[] = [];
      for (const memberId of this.groups.membersOf(player.id)) {
        const member: ZonePlayer | undefined = this.players.get(memberId);
        // Quem já veio no snapshot deste tick (está na vista) não precisa.
        if (member === undefined || player.view.has(member.id)) continue;
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
    return { x: quantize(Math.cos(angle) * radius), y: 0, z: quantize(Math.sin(angle) * radius), rotY: 0 };
  }

  private static snapshot(entity: Entity): PlayerSnapshot {
    return {
      id: entity.id,
      // Milímetros e 0,01 rad ([INFRA-11]): jogador já anda em mm (a simulação arredonda); NPC só aqui.
      x: quantize(entity.state.x),
      y: quantize(entity.state.y),
      z: quantize(entity.state.z),
      rotY: Math.round(entity.state.rotY * 100) / 100,
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
      ...(player.guild !== null ? { guildId: player.guild.id, guildTag: player.guild.tag } : {}),
    };
  }

  /** `true` se os dois são jogadores da mesma guilda ([SOC-06]). */
  private static sameGuild(a: Entity, b: Entity): boolean {
    return a.kind === "player" && b.kind === "player" && a.guild !== null && a.guild.id === b.guild?.id;
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

import type { CampConfig, DummyConfig, FakePlayerConfig, ZoneConfig } from "./Zone.js";
import { SAFE_ZONE_HALF } from "../combat/pvp.js";
import { parseZoneMap, type MonsterKind, type MonsterSpawn, type ZoneMapData } from "./zoneMap.js";
// Monstros e lugar dos NPCs de teste: exportados do spawn.blend ([ART-10]). Importado (não lido do disco) para o
// `tsx watch` recarregar o servidor sozinho quando o arquivo muda.
import zone1MapFile from "./maps/zone_1.json" with { type: "json" };

/**
 * Metade do lado da Zone 1 em metros (terreno 300 m × 300 m centrado na origem). Ver mmo-docs [MUN-03].
 *
 * ATENÇÃO: precisa bater com ZONE_HALF_SIZE em mmo-client/scripts/world/world_constants.gd.
 */
export const ZONE_HALF_SIZE = 150;

/**
 * Vida (no nível 0), velocidade (m/s) e tempo para reaparecer (s) dos zumbis. Percepção e desistência são de cada
 * zumbi (Custom Properties no Blender, [ART-10]).
 */
const ZOMBIE_FIGHTER_HP = 150;
const ZOMBIE_SHOOTER_HP = 100;
const ZOMBIE_SPEED = 3.5;
const ZOMBIE_RESPAWN_SECONDS = 10;
/** Dano dos zumbis: metade do golpe (provisório; com a força cheia, um jogador nível 0 não aguenta). */
const ZOMBIE_DAMAGE_MULTIPLIER = 0.5;
/**
 * Chefe ([JOGO-18]): zumbi gigante (escala do Blender). Vida × {@link BOSS_HP_MULTIPLIER} da do lutador, dano ×
 * {@link BOSS_DAMAGE_MULTIPLIER} (já com o 0,5 provisório), XP e moedas × {@link BOSS_REWARD_MULTIPLIER}, demora
 * {@link BOSS_RESPAWN_SECONDS} s para voltar e anda um pouco mais devagar. Pensado para grupo (ou solo bem acima do
 * nível dele).
 */
const BOSS_HP_MULTIPLIER = 8;
const BOSS_DAMAGE_MULTIPLIER = 0.75;
const BOSS_REWARD_MULTIPLIER = 10;
const BOSS_RESPAWN_SECONDS = 120;
const BOSS_SPEED = 3.2;

/**
 * Zumbi do tipo [spawn.kind] no lugar e no nível de [spawn] ([JOGO-13], [JOGO-18]). **Não segura arma**: o lutador
 * bate com a mão (Soco de zumbi + Pancadão), o cuspidor (`shooter`) cospe de longe (Cuspe + Bola de gosma); o chefe
 * (`boss`) é um lutador gigante com Murro gigante + Pisão. Vida, dano e XP crescem com o nível ([JOGO-12]).
 */
function zombie(spawn: MonsterSpawn): DummyConfig {
  const kind: MonsterKind = spawn.kind;
  const fighter: boolean = kind === "fighter";
  const boss: boolean = spawn.boss;
  const defaultName: string = boss ? "Chefe zumbi" : fighter ? "Zumbi lutador" : "Zumbi cuspidor";
  const baseHp: number = fighter ? ZOMBIE_FIGHTER_HP : ZOMBIE_SHOOTER_HP;
  return {
    id: spawn.id,
    name: spawn.name.length > 0 ? spawn.name : defaultName,
    x: spawn.x,
    z: spawn.z,
    level: spawn.level,
    maxHp: boss ? baseHp * BOSS_HP_MULTIPLIER : baseHp,
    respawnSeconds: boss ? BOSS_RESPAWN_SECONDS : ZOMBIE_RESPAWN_SECONDS,
    damageMultiplier: boss ? BOSS_DAMAGE_MULTIPLIER : ZOMBIE_DAMAGE_MULTIPLIER,
    scale: spawn.scale,
    boss,
    rewardMultiplier: boss ? BOSS_REWARD_MULTIPLIER : 1,
    // Modelo do zumbi (pele verde, roupa rasgada); sem equipamento e sem arma (bate com a mão).
    body: "zombie",
    look: { hand: null, head: null, chest: null, feet: null },
    behavior: {
      kind: "zombie",
      attack: boss ? "boss_smash" : fighter ? "zombie_punch" : "zombie_spit",
      ability: boss ? "boss_stomp" : fighter ? "zombie_bash" : "acid_glob",
      aggroRadius: spawn.perception,
      leashRadius: spawn.resetRange,
      speed: boss ? BOSS_SPEED : ZOMBIE_SPEED,
    },
  };
}

/** Acampamentos do mapa [map] para a zona: onde fica o baú e os ids dos monstros de cada um ([JOGO-19]). */
export function campsOf(map: ZoneMapData): CampConfig[] {
  return map.camps.map((camp) => ({
    id: camp.id,
    x: camp.x,
    z: camp.z,
    monsterIds: map.monsters.filter((monster) => monster.camp === camp.id).map((monster) => monster.id),
  }));
}

/** Mapa da Zone 1 (validado: erro ao subir se o arquivo estiver errado). */
const ZONE_1_MAP: ZoneMapData = parseZoneMap(zone1MapFile, ZONE_HALF_SIZE);

/**
 * Bonecos de treino e NPCs de teste que existem ([JOGO-05], [JOGO-11]), sem lugar: entram na zona só os que estão no
 * mapa do Blender (cilindro com `(id)` no nome), na posição de lá. Os que não estão no mapa ficam de fora.
 */
const TEST_NPCS: readonly Omit<DummyConfig, "x" | "z">[] = [
  { id: "dummy_1", name: "Boneco de treino" },
  { id: "dummy_2", name: "Boneco de treino" },
  { id: "dummy_3", name: "Boneco de treino" },
  // Saco de pancadas: leva os tiros do atirador, não morre, dá para curar.
  { id: "test_bag", name: "Saco de pancadas", behavior: { kind: "punchingBag", regenDelaySeconds: 5, regenPerSecond: 40 } },
  // Atirador: humano invulnerável, alterna habilidades de longe de três conjuntos no saco de pancadas.
  {
    id: "test_shooter",
    name: "Atirador de treino",
    body: "male",
    behavior: {
      kind: "shooter",
      target: "test_bag",
      rotation: ["fireball", "meteor", "ice_lance", "starfall", "piercing_bolt", "bolt_rain", "bolt", "quick_shot"],
      pauseSeconds: 2,
    },
  },
  // Ferreiro ([JOGO-16]): parado na praça, invulnerável; perto dele melhora os itens com moedas.
  {
    id: "blacksmith",
    name: "Ferreiro",
    body: "male",
    look: { hand: null, head: null, chest: "knight_plate", feet: "training_boots" },
    behavior: { kind: "blacksmith" },
  },
  // Armazém ([JOGO-26]): o baú grande da praça (não é pessoa); perto dele guarda itens além da mochila.
  {
    id: "storage",
    name: "Armazém",
    body: "male",
    behavior: { kind: "storage" },
  },
  // Mercador ([JOGO-25]): a tenda cheia de ouro na praça; perto dele abre o Mercado entre jogadores.
  {
    id: "market",
    name: "Mercador",
    body: "male",
    behavior: { kind: "market" },
  },
  // Brigão: parado, bate com o ataque da espada longa em quem chegar perto; tem vida e morre.
  {
    id: "test_brawler",
    name: "Brigão",
    body: "male",
    look: { hand: "knight_sword", head: "knight_helm", chest: "knight_plate", feet: "knight_greaves" },
    behavior: { kind: "brawler", weapon: "knight_sword" },
  },
];

/**
 * Jogadores fake de teste ([SOC-01]), parados perto do spawn, para testar Jogadores Próximos, Atributos, grupo e
 * amizade sem um segundo aparelho. **Fora do jogo desde 2026-11-14** (o usuário aprovou o teste e pediu para tirar):
 * nenhuma zona os usa; ficam aqui para os testes automáticos e para voltar com uma linha
 * (`fakePlayers: placeFakePlayers(ZONE_1_MAP)` na zona). Ligados, entram no lugar do cilindro com `(id)` no nome do
 * `spawn.blend`, se houver ("Fake Aceita (fake_accept)"), senão na posição padrão daqui.
 */
export const TEST_FAKE_PLAYERS: readonly FakePlayerConfig[] = [
  {
    id: "fake_accept",
    name: "Fake Aceita",
    x: 7,
    z: -2,
    body: "female",
    level: 3,
    look: { hand: "healer_tome", head: "healer_circlet", chest: "healer_robe", feet: "healer_sandals" },
    autoReply: "accept",
  },
  {
    id: "fake_reject",
    name: "Fake Recusa",
    x: 7,
    z: 2,
    body: "male",
    level: 5,
    look: { hand: "knight_sword", head: "knight_helm", chest: "knight_plate", feet: "knight_greaves" },
    autoReply: "reject",
  },
];

/** Os jogadores fake ({@link TEST_FAKE_PLAYERS}), cada um no lugar que o mapa [map] der para ele (ou no padrão). */
export function placeFakePlayers(map: ZoneMapData): FakePlayerConfig[] {
  return TEST_FAKE_PLAYERS.map((fake): FakePlayerConfig => {
    const placement = map.npcs.find((candidate) => candidate.id === fake.id);
    return placement === undefined ? fake : { ...fake, x: placement.x, z: placement.z };
  });
}

/**
 * Os NPCs de teste que o mapa [map] põe na zona, cada um no seu lugar. Ids de jogador fake ({@link TEST_FAKE_PLAYERS})
 * são pulados (entram por {@link placeFakePlayers}); qualquer outro id que não existe em {@link TEST_NPCS} → erro.
 */
export function placeTestNpcs(map: ZoneMapData): DummyConfig[] {
  const placements = map.npcs.filter((placement) => !TEST_FAKE_PLAYERS.some((fake) => fake.id === placement.id));
  return placements.map((placement): DummyConfig => {
    const npc = TEST_NPCS.find((candidate) => candidate.id === placement.id);
    if (npc === undefined) {
      throw new Error(`mapa: NPC ${placement.id} não existe em zones.ts (TEST_NPCS)`);
    }
    return { ...npc, x: placement.x, z: placement.z };
  });
}

/** Zonas que o servidor cria ao subir. O cliente escolhe uma pelo `id` no `join`. */
export const ZONE_CONFIGS: readonly ZoneConfig[] = [
  {
    // ATENÇÃO: id usado pelo cliente em mmo-client/scripts/network/network_config.gd (ZONE_ID).
    id: "zone_1",
    halfSize: ZONE_HALF_SIZE,
    maxPlayers: 50,
    // Nasce dentro do círculo de pedra do centro da praça (raio 4,5 m no cliente: ZoneTerrain.SPAWN_CIRCLE_RADIUS).
    spawnRadius: 3.5,
    // PvP ligado: é assim que testamos ([JOGO-02]). Zonas seguras virão com `pvp: false`.
    pvp: true,
    // Em cima das pedras da praça (20 × 20 m) não há PvP ([JOGO-22]).
    safeZoneHalf: SAFE_ZONE_HALF,
    // NPCs de teste e zumbis ([JOGO-13]) onde estão no mapa do Blender ([ART-10]).
    dummies: [...placeTestNpcs(ZONE_1_MAP), ...ZONE_1_MAP.monsters.map(zombie)],
    // Baús dos acampamentos ([JOGO-19]): cada um com os monstros da subcoleção dele no Blender.
    camps: campsOf(ZONE_1_MAP),
    // Sem jogadores fake (tirados em 2026-11-14, [SOC-01]); para voltar: fakePlayers: placeFakePlayers(ZONE_1_MAP).
  },
];

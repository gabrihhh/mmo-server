import type { DummyConfig, ZoneConfig } from "./Zone.js";
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
/** Dano dos zumbis: metade do da arma (provisório; com a força cheia, um jogador nível 0 não aguenta). */
const ZOMBIE_DAMAGE_MULTIPLIER = 0.5;

/**
 * Zumbi do tipo [spawn.kind] — lutador (espada longa, Corte em linha) ou atirador (besta, Virote certeiro) — no
 * lugar e no nível de [spawn]. Vida, dano e XP crescem com o nível ([JOGO-12]).
 */
function zombie(spawn: MonsterSpawn): DummyConfig {
  const kind: MonsterKind = spawn.kind;
  const fighter: boolean = kind === "fighter";
  const weapon: string = fighter ? "knight_sword" : "ranger_crossbow";
  return {
    id: spawn.id,
    name: fighter ? "Zumbi lutador" : "Zumbi atirador",
    x: spawn.x,
    z: spawn.z,
    level: spawn.level,
    maxHp: fighter ? ZOMBIE_FIGHTER_HP : ZOMBIE_SHOOTER_HP,
    respawnSeconds: ZOMBIE_RESPAWN_SECONDS,
    damageMultiplier: ZOMBIE_DAMAGE_MULTIPLIER,
    // Modelo do zumbi (pele verde, roupa rasgada); sem equipamento: só a arma na mão.
    body: "zombie",
    look: { hand: weapon, head: null, chest: null, feet: null },
    behavior: {
      kind: "zombie",
      weapon,
      ability: fighter ? "line_cleave" : "piercing_bolt",
      aggroRadius: spawn.perception,
      leashRadius: spawn.resetRange,
      speed: ZOMBIE_SPEED,
    },
  };
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
  // Brigão: parado, bate com o ataque da espada longa em quem chegar perto; tem vida e morre.
  {
    id: "test_brawler",
    name: "Brigão",
    body: "male",
    look: { hand: "knight_sword", head: "knight_helm", chest: "knight_plate", feet: "knight_greaves" },
    behavior: { kind: "brawler", weapon: "knight_sword" },
  },
];

/** Os NPCs de teste que o mapa [map] põe na zona, cada um no seu lugar. Id que não existe em {@link TEST_NPCS} → erro. */
export function placeTestNpcs(map: ZoneMapData): DummyConfig[] {
  return map.npcs.map((placement): DummyConfig => {
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
    // NPCs de teste e zumbis ([JOGO-13]) onde estão no mapa do Blender ([ART-10]).
    dummies: [...placeTestNpcs(ZONE_1_MAP), ...ZONE_1_MAP.monsters.map(zombie)],
  },
];

import type { ZoneConfig } from "./Zone.js";

/**
 * Metade do lado da Zone 1 em metros (terreno 300 m × 300 m centrado na origem). Ver mmo-docs [MUN-03].
 *
 * ATENÇÃO: precisa bater com ZONE_HALF_SIZE em mmo-client/scripts/world/world_constants.gd.
 */
export const ZONE_HALF_SIZE = 150;

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
    // Bonecos de treino no campo, logo depois da escada do lado −Z da praça ([JOGO-05], [MUN-03]).
    dummies: [
      { id: "dummy_1", name: "Boneco de treino", x: 0, z: -18 },
      { id: "dummy_2", name: "Boneco de treino", x: -6, z: -21 },
      { id: "dummy_3", name: "Boneco de treino", x: 6, z: -21 },
    ],
  },
];

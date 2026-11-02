/**
 * Números do combate (placeholders). Ver mmo-docs [JOGO-05].
 * Tudo em unidades do jogo: vida/mana em pontos, tempo em segundos, distância em metros.
 */

/** Vida e mana máximas do jogador. */
export const PLAYER_MAX_HP = 100;
export const PLAYER_MAX_MANA = 100;

/** Regeneração por segundo (sempre ativa enquanto vivo). */
export const HP_REGEN_PER_SECOND = 2;
export const MANA_REGEN_PER_SECOND = 5;

/** Tempo até o jogador renascer (no spawn, vida/mana cheias). */
export const PLAYER_RESPAWN_SECONDS = 5;

/** Vida do boneco de treino e o tempo até ele reaparecer. Boneco não regenera. */
export const DUMMY_MAX_HP = 200;
export const DUMMY_RESPAWN_SECONDS = 5;

/**
 * Folga somada ao alcance do ataque (m). Compensa a diferença entre o que o cliente vê (outros
 * jogadores 100 ms no passado) e a posição atual no servidor, para não "errar" por centímetros.
 */
export const RANGE_TOLERANCE = 0.5;

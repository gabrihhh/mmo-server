/**
 * Onde ficam os monstros de cada zona e de que nível ([JOGO-13], [MUN-05]). Os dados vêm de
 * `src/zones/monsters/<zona>.json`, escrito pelo editor do Godot (cena `mmo-client/scenes/world/zone_1_monsters.tscn`:
 * arrasta o zumbi, escolhe tipo e nível no inspetor, Ctrl+S). Este módulo valida o arquivo: dado de fora, passa por
 * parser tipado como as mensagens da rede.
 *
 * ATENÇÃO: o formato é escrito por `mmo-client/scripts/world/monster_spawns.gd` (MonsterSpawns.to_json); tipos em
 * `MonsterSpawn.KIND_IDS` (mmo-client/scripts/world/monster_spawn.gd).
 */

/** Tipos de monstro que o editor oferece: zumbi lutador (espada longa) ou atirador (besta). */
export const MONSTER_KINDS = ["fighter", "shooter"] as const;
/** Um dos {@link MONSTER_KINDS}. */
export type MonsterKind = (typeof MONSTER_KINDS)[number];

/** Um monstro posto no mapa: id único na zona, tipo, nível e posição no chão (m). */
export interface MonsterSpawn {
  readonly id: string;
  readonly kind: MonsterKind;
  /** Nível ([JOGO-12]): vida, dano e a XP que dá crescem 1% por nível, acumulando. */
  readonly level: number;
  readonly x: number;
  readonly z: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coordenada [value] do eixo [axis] dentro do mapa (±[halfSize] m), ou erro com [where]. */
function readCoordinate(value: unknown, axis: string, where: string, halfSize: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > halfSize) {
    throw new Error(`${where}: ${axis} fora do mapa (±${halfSize} m): ${String(value)}`);
  }
  return value;
}

function isKind(value: unknown): value is MonsterKind {
  return typeof value === "string" && (MONSTER_KINDS as readonly string[]).includes(value);
}

/**
 * Valida a lista de monstros [data] (o JSON lido) de uma zona com metade do lado [halfSize] (m). Erro (com o motivo e
 * o índice) se algo estiver fora do formato: id vazio ou repetido, tipo desconhecido, nível fora de 0..50 ou não
 * inteiro, posição fora do mapa. Falha alto de propósito: monstro sumido sem aviso seria pior.
 */
export function parseMonsterSpawns(data: unknown, halfSize: number): MonsterSpawn[] {
  if (!Array.isArray(data)) {
    throw new Error("monstros: o arquivo precisa ser uma lista");
  }
  const seen = new Set<string>();
  return data.map((entry: unknown, index: number): MonsterSpawn => {
    const where = `monstros[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${where}: precisa ser um objeto`);
    }
    const { id, kind, level } = entry;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      throw new Error(`${where}: id vazio ou repetido (${String(id)})`);
    }
    seen.add(id);
    if (!isKind(kind)) {
      throw new Error(`${where}: tipo desconhecido (${String(kind)})`);
    }
    // Sem nível máximo ([JOGO-12]); só inteiro, 0 ou mais.
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level < 0) {
      throw new Error(`${where}: nível precisa ser inteiro, 0 ou mais (${String(level)})`);
    }
    const x: number = readCoordinate(entry["x"], "x", where, halfSize);
    const z: number = readCoordinate(entry["z"], "z", where, halfSize);
    return { id, kind, level, x, z };
  });
}

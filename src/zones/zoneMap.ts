/**
 * O que o mapa feito no Blender diz sobre uma zona ([ART-10], [JOGO-13]): onde ficam os monstros (tipo, nível e
 * alcances de cada um) e os NPCs de teste. Os dados vêm de `src/zones/maps/<zona>.json`, escrito pelo exportador
 * `mmo-client/tools/blender/export_zone.py` a partir dos cilindros da coleção `NPCs e zumbis` do `spawn.blend`
 * (Custom Properties do cilindro). Este módulo valida o arquivo: dado de fora, passa por parser tipado como as
 * mensagens da rede.
 *
 * ATENÇÃO: o formato é escrito por `mmo-client/tools/blender/blender_export_zone.py` (read_mobs).
 */

/** Tipos de monstro: zumbi lutador (espada longa; `ataque` melee no Blender) ou atirador (besta; ranged). */
export const MONSTER_KINDS = ["fighter", "shooter"] as const;
/** Um dos {@link MONSTER_KINDS}. */
export type MonsterKind = (typeof MONSTER_KINDS)[number];

/** Um monstro posto no mapa: id único na zona, tipo, nível, posição no chão (m) e alcances (m). */
export interface MonsterSpawn {
  readonly id: string;
  readonly kind: MonsterKind;
  /** Nível ([JOGO-12]): vida, dano e a XP que dá crescem com ele. Sem máximo. */
  readonly level: number;
  readonly x: number;
  readonly z: number;
  /** Distância de casa (m) em que desiste do alvo e volta (`alcance_reset` no Blender). */
  readonly resetRange: number;
  /** Jogador a esta distância de casa (m) chama a atenção dele (`percepcao` no Blender). */
  readonly perception: number;
}

/** Onde fica um NPC de teste de `zones.ts` (id do NPC; posição no chão, m). */
export interface NpcPlacement {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

/** Conteúdo validado de `maps/<zona>.json`. */
export interface ZoneMapData {
  readonly monsters: readonly MonsterSpawn[];
  readonly npcs: readonly NpcPlacement[];
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

/** Distância [value] (m) maior que 0, ou erro com [where]. */
function readRange(value: unknown, name: string, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where}: ${name} precisa ser maior que 0 (${String(value)})`);
  }
  return value;
}

/** Id [value] não vazio e ainda não visto em [seen], ou erro com [where]. */
function readId(value: unknown, where: string, seen: Set<string>): string {
  if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
    throw new Error(`${where}: id vazio ou repetido (${String(value)})`);
  }
  seen.add(value);
  return value;
}

function isKind(value: unknown): value is MonsterKind {
  return typeof value === "string" && (MONSTER_KINDS as readonly string[]).includes(value);
}

function readMonster(entry: unknown, where: string, halfSize: number, seen: Set<string>): MonsterSpawn {
  if (!isRecord(entry)) {
    throw new Error(`${where}: precisa ser um objeto`);
  }
  const id: string = readId(entry["id"], where, seen);
  const kind: unknown = entry["kind"];
  if (!isKind(kind)) {
    throw new Error(`${where}: tipo desconhecido (${String(kind)})`);
  }
  const level: unknown = entry["level"];
  // Sem nível máximo ([JOGO-12]); só inteiro, 0 ou mais.
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level < 0) {
    throw new Error(`${where}: nível precisa ser inteiro, 0 ou mais (${String(level)})`);
  }
  return {
    id,
    kind,
    level,
    x: readCoordinate(entry["x"], "x", where, halfSize),
    z: readCoordinate(entry["z"], "z", where, halfSize),
    resetRange: readRange(entry["resetRange"], "resetRange", where),
    perception: readRange(entry["perception"], "perception", where),
  };
}

/**
 * Valida o mapa [data] (o JSON lido) de uma zona com metade do lado [halfSize] (m). Erro (com o motivo e o índice) se
 * algo estiver fora do formato: id vazio ou repetido, tipo desconhecido, nível não inteiro ou negativo, alcance ≤ 0,
 * posição fora do mapa. Falha alto de propósito: monstro sumido sem aviso seria pior.
 */
export function parseZoneMap(data: unknown, halfSize: number): ZoneMapData {
  if (!isRecord(data) || !Array.isArray(data["monsters"]) || !Array.isArray(data["npcs"])) {
    throw new Error("mapa: o arquivo precisa ter as listas monsters e npcs");
  }
  const monsterIds = new Set<string>();
  const monsters: MonsterSpawn[] = data["monsters"].map(
    (entry: unknown, index: number): MonsterSpawn => readMonster(entry, `monsters[${index}]`, halfSize, monsterIds),
  );
  const npcIds = new Set<string>();
  const npcs: NpcPlacement[] = data["npcs"].map((entry: unknown, index: number): NpcPlacement => {
    const where = `npcs[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${where}: precisa ser um objeto`);
    }
    return {
      id: readId(entry["id"], where, npcIds),
      x: readCoordinate(entry["x"], "x", where, halfSize),
      z: readCoordinate(entry["z"], "z", where, halfSize),
    };
  });
  return { monsters, npcs };
}

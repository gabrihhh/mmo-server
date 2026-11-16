/**
 * Sorteio dos baús dos acampamentos ([JOGO-19]). Puro (recebe o sorteador), testado em `test/loot.test.ts`.
 *
 * **Lê o catálogo, sem lista fixa:** qualquer item de {@link ITEMS} com `lootable` diferente de `false` entra — peça ou
 * arma nova, ou conjunto (classe) novo, passa a sair nos baús sem mexer aqui. Roupa = slots `head`, `chest`, `feet`;
 * arma = `hand`. Primeiro sorteia a CLASSE (o conjunto, entre os que têm item daquele tipo) e depois o item dela: uma
 * classe com mais peças não sai mais vezes que as outras.
 *
 * Cada item sai com um nível de melhoria de +0 até o nível do acampamento (os altos mais raros) e os pontos de atributo
 * que o ferreiro daria nesse caminho ([JOGO-16]): a cada nível, um atributo do conjunto sorteado (novo +1, de novo +2).
 */
import { attributesForSet, type AttributeId, type AttributePoints } from "./attributes.js";
import { ITEMS, type ItemDef } from "./catalog.js";
import { newItemUid, type ItemStack } from "./inventory.js";
import { NEW_ATTRIBUTE_POINTS, REINFORCE_POINTS } from "./upgrade.js";
import { goldReward } from "../progression/level.js";

/** Peças de roupa por baú: de {@link MIN_ARMOR_PIECES} a {@link MAX_ARMOR_PIECES} (sorteado). */
export const MIN_ARMOR_PIECES = 1;
/** Ver {@link MIN_ARMOR_PIECES}. */
export const MAX_ARMOR_PIECES = 2;
/** Chance (0..1) de vir também uma arma. */
export const WEAPON_CHANCE = 0.1;
/** Moedas: {@link goldReward} do nível do acampamento × um número de {@link MIN_GOLD_MULTIPLIER} a {@link MAX_GOLD_MULTIPLIER}. */
export const MIN_GOLD_MULTIPLIER = 3;
/** Ver {@link MIN_GOLD_MULTIPLIER}. */
export const MAX_GOLD_MULTIPLIER = 6;
/** Acampamento com chefe: peças a mais, chance de arma e multiplicador das moedas. */
export const BOSS_EXTRA_PIECES = 1;
/** Ver {@link BOSS_EXTRA_PIECES}. */
export const BOSS_WEAPON_CHANCE = 0.25;
/** Ver {@link BOSS_EXTRA_PIECES}. */
export const BOSS_GOLD_MULTIPLIER = 2;
/**
 * Curva do nível: `floor((nível + 1) × sorteio^LEVEL_SKEW)`. 1 = todos os níveis iguais; 2 = os altos mais raros (num
 * acampamento nível 10, +0 sai ~30% das vezes e +10 ~5%).
 */
export const LEVEL_SKEW = 2;

/** Slots de roupa (o resto é arma). */
const ARMOR_SLOTS: ReadonlySet<string> = new Set(["head", "chest", "feet"]);

/** O que há num baú para um jogador: um item (já com uid, nível e atributos) ou moedas. `lootId` = id dentro do baú. */
export type LootEntry =
  | { readonly lootId: string; readonly kind: "item"; readonly stack: ItemStack }
  | { readonly lootId: string; readonly kind: "gold"; readonly amount: number };

/** O acampamento de onde sai o baú: nível (o maior dos zumbis comuns dele) e se tem chefe. */
export interface ChestSource {
  readonly level: number;
  readonly boss: boolean;
}

/** Itens sorteáveis por conjunto (classe) → lista, só roupa ou só arma. Lido do catálogo a cada chamada (barato). */
export function lootPool(kind: "armor" | "weapon", items: Readonly<Record<string, ItemDef>> = ITEMS): Map<string, ItemDef[]> {
  const pool: Map<string, ItemDef[]> = new Map();
  for (const item of Object.values(items)) {
    if (item.lootable === false) continue;
    if ((kind === "armor") !== ARMOR_SLOTS.has(item.slot)) continue;
    const list: ItemDef[] = pool.get(item.set) ?? [];
    list.push(item);
    pool.set(item.set, list);
  }
  return pool;
}

/** Nível de um item sorteado: de 0 a [maxLevel], os altos mais raros ({@link LEVEL_SKEW}). */
export function rollLootLevel(maxLevel: number, random: () => number): number {
  const top: number = Math.max(0, Math.floor(maxLevel));
  return Math.min(top, Math.floor((top + 1) * random() ** LEVEL_SKEW));
}

/**
 * Pontos de atributo de um item do conjunto [set] que chegou a [level] pelo caminho do ferreiro: a cada nível, um
 * atributo sorteado entre os do conjunto ganha +1 (primeira vez) ou +2 (de novo).
 */
export function rollAttributes(set: string, level: number, random: () => number): AttributePoints {
  const allowed: readonly AttributeId[] = attributesForSet(set);
  const points: Partial<Record<AttributeId, number>> = {};
  for (let i = 0; i < level && allowed.length > 0; i++) {
    const attribute: AttributeId | undefined = allowed[Math.floor(random() * allowed.length)];
    if (attribute === undefined) continue;
    const current: number = points[attribute] ?? 0;
    points[attribute] = current + (current > 0 ? REINFORCE_POINTS : NEW_ATTRIBUTE_POINTS);
  }
  return points;
}

/** Um item de [pool]: classe sorteada, depois o item dela; nível e atributos até [maxLevel]. `null` se o pool está vazio. */
export function rollItem(pool: ReadonlyMap<string, readonly ItemDef[]>, maxLevel: number, random: () => number): ItemStack | null {
  const sets: string[] = Array.from(pool.keys()).filter((set) => (pool.get(set)?.length ?? 0) > 0);
  const set: string | undefined = sets[Math.floor(random() * sets.length)];
  const items: readonly ItemDef[] = set === undefined ? [] : (pool.get(set) ?? []);
  const def: ItemDef | undefined = items[Math.floor(random() * items.length)];
  if (def === undefined) return null;
  const level: number = rollLootLevel(maxLevel, random);
  if (level === 0) return { uid: newItemUid(), itemId: def.id };
  return { uid: newItemUid(), itemId: def.id, level, attrs: rollAttributes(def.set, level, random) };
}

/**
 * O baú de um jogador: {@link MIN_ARMOR_PIECES}–{@link MAX_ARMOR_PIECES} peças de roupa, {@link WEAPON_CHANCE} de uma
 * arma e moedas (com chefe: mais peças, mais chance de arma e o dobro de moedas). Moedas sempre por último.
 */
export function rollChestLoot(source: ChestSource, random: () => number): LootEntry[] {
  const entries: LootEntry[] = [];
  const add = (stack: ItemStack | null): void => {
    if (stack !== null) entries.push({ lootId: `i${entries.length + 1}`, kind: "item", stack });
  };
  const armor: Map<string, ItemDef[]> = lootPool("armor");
  const pieces: number =
    MIN_ARMOR_PIECES + Math.floor(random() * (MAX_ARMOR_PIECES - MIN_ARMOR_PIECES + 1)) + (source.boss ? BOSS_EXTRA_PIECES : 0);
  for (let i = 0; i < pieces; i++) add(rollItem(armor, source.level, random));
  if (random() < (source.boss ? BOSS_WEAPON_CHANCE : WEAPON_CHANCE)) add(rollItem(lootPool("weapon"), source.level, random));
  const multiplier: number = MIN_GOLD_MULTIPLIER + Math.floor(random() * (MAX_GOLD_MULTIPLIER - MIN_GOLD_MULTIPLIER + 1));
  const gold: number = goldReward(source.level) * multiplier * (source.boss ? BOSS_GOLD_MULTIPLIER : 1);
  entries.push({ lootId: "gold", kind: "gold", amount: gold });
  return entries;
}

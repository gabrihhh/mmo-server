import { attributesForSet, type AttributeId } from "./attributes.js";
import { EQUIP_SLOTS, getItem, type EquipSlot } from "./catalog.js";
import type { Inventory, ItemStack } from "./inventory.js";

/**
 * Melhoria de itens no ferreiro (mmo-docs [JOGO-16]). Regras puras (sem banco nem rede; o sorteio vem de fora).
 *
 * - Cada tentativa custa moedas ({@link upgradeCost}) e sobe o item **um nível** (+1, +2… **sem teto**) se der certo
 *   ({@link upgradeChance}). Falhou: perde só as moedas; item e nível ficam iguais.
 * - Ao melhorar, o jogador escolhe um atributo do conjunto do item ({@link attributesForSet}): **novo** = +1 ponto;
 *   **que o item já tem** = +2 pontos. Sem limite de atributos por item.
 * Valores provisórios (2026-11-14): acertar testando.
 */

/** Preço da melhoria do +0 para o +1, em moedas. */
export const BASE_UPGRADE_COST = 50;

/** Crescimento do preço por nível (10%, acumulando). */
export const UPGRADE_COST_GROWTH = 1.1;

/** Até este nível (o nível que se tenta alcançar) a melhoria nunca falha. */
export const SAFE_UPGRADE_LEVEL = 5;

/** Depois do nível seguro, a chance de dar certo é × isto por nível (10% a menos, acumulando). */
export const UPGRADE_CHANCE_DECAY = 0.9;

/** Chance mínima de dar certo (o piso: nunca fica impossível). */
export const MIN_UPGRADE_CHANCE = 0.01;

/** Pontos que um atributo novo começa e que reforçar um atributo que o item já tem dá. */
export const NEW_ATTRIBUTE_POINTS = 1;
export const REINFORCE_POINTS = 2;

/** Moedas para tentar melhorar um item que está no nível `level` (50 no +0; × 1,1 por nível; inteiro). */
export function upgradeCost(level: number): number {
  return Math.round(BASE_UPGRADE_COST * UPGRADE_COST_GROWTH ** Math.max(0, level));
}

/**
 * Chance (0 a 1) de dar certo melhorar um item que está no nível `level`: 100% até chegar ao +5; depois × 0,9 por
 * nível (+10 ≈ 59%, +20 ≈ 21%, +30 ≈ 7%), nunca abaixo de 1%.
 */
export function upgradeChance(level: number): number {
  const target: number = Math.max(0, level) + 1;
  if (target <= SAFE_UPGRADE_LEVEL) return 1;
  return Math.max(MIN_UPGRADE_CHANCE, UPGRADE_CHANCE_DECAY ** (target - SAFE_UPGRADE_LEVEL));
}

/** Motivo de recusa de uma melhoria (nada muda, nem as moedas). */
export type UpgradeFailure = "item_not_found" | "invalid_attribute" | "not_enough_gold";

/** Resultado de uma tentativa aceita: pagou `cost`; `success` = subiu de nível. */
export type UpgradeResult =
  | { readonly ok: true; readonly success: boolean; readonly cost: number; readonly inventory: Inventory; readonly stack: ItemStack }
  | { readonly ok: false; readonly reason: UpgradeFailure };

/** Onde está o item `uid`: vestido (slot) ou na mochila (posição). */
function locate(inventory: Inventory, uid: string): { slot: EquipSlot; stack: ItemStack } | { index: number; stack: ItemStack } | null {
  for (const slot of EQUIP_SLOTS) {
    const stack: ItemStack | null = inventory.equipped[slot];
    if (stack !== null && stack.uid === uid) return { slot, stack };
  }
  const index: number = inventory.bag.findIndex((stack) => stack.uid === uid);
  const stack: ItemStack | undefined = inventory.bag[index];
  return stack === undefined ? null : { index, stack };
}

/** Atributos que o item `stack` aceita no ferreiro (vazio se o item não existe). */
export function upgradeAttributesOf(stack: ItemStack): readonly AttributeId[] {
  const def = getItem(stack.itemId);
  return def === undefined ? [] : attributesForSet(def.set);
}

/**
 * Tenta melhorar o item `uid` (vestido ou na mochila) escolhendo `attribute`, com `gold` moedas e o sorteio `roll`
 * (0 a <1; dá certo se `roll < upgradeChance`). Recusa sem cobrar se o item não existe, o atributo não é do conjunto
 * dele ou faltam moedas. Aceita: cobra {@link upgradeCost} e, se deu certo, sobe 1 nível e dá os pontos.
 */
export function upgradeItem(inventory: Inventory, uid: string, attribute: AttributeId, gold: number, roll: number): UpgradeResult {
  const found = locate(inventory, uid);
  if (found === null) return { ok: false, reason: "item_not_found" };
  if (!upgradeAttributesOf(found.stack).includes(attribute)) return { ok: false, reason: "invalid_attribute" };
  const level: number = found.stack.level ?? 0;
  const cost: number = upgradeCost(level);
  if (gold < cost) return { ok: false, reason: "not_enough_gold" };
  if (roll >= upgradeChance(level)) return { ok: true, success: false, cost, inventory, stack: found.stack };

  const attrs: Partial<Record<AttributeId, number>> = { ...found.stack.attrs };
  const current: number = attrs[attribute] ?? 0;
  attrs[attribute] = current + (current > 0 ? REINFORCE_POINTS : NEW_ATTRIBUTE_POINTS);
  const stack: ItemStack = { uid: found.stack.uid, itemId: found.stack.itemId, level: level + 1, attrs };
  const next: Inventory =
    "slot" in found
      ? { ...inventory, equipped: { ...inventory.equipped, [found.slot]: stack } }
      : { ...inventory, bag: inventory.bag.map((other, i) => (i === found.index ? stack : other)) };
  return { ok: true, success: true, cost, inventory: next, stack };
}

/**
 * Fusão no ferreiro ([JOGO-20]): sacrifica um item para dar a experiência dele a outro **igual** (mesmo `itemId`).
 * Puro (recebe o sorteador), testado em `test/fusion.test.ts`.
 *
 * - Cada nível pede {@link levelXp} de experiência (a mesma curva do preço de melhorar com moedas: 50 no +0, 10% a mais
 *   por nível). Um item "carrega" a experiência de todos os níveis que já subiu + a que juntou ({@link itemXp}); um
 *   +0 que nunca juntou nada vale {@link ZERO_ITEM_XP} (metade de um nível).
 * - O principal soma essa experiência e sobe quantos níveis ela pagar; a sobra fica guardada (`ItemStack.xp`). Como cada
 *   nível pede mais, uma adaga +3 numa +9 sobe menos de 3 níveis (vira +10 e um pouco).
 * - Cada nível ganho dá um atributo sorteado do conjunto (como o ferreiro daria, [JOGO-16]); os atributos do item
 *   sacrificado somem com ele. Sem custo em moedas e sem chance de falhar.
 */
import { attributesForSet, type AttributeId } from "./attributes.js";
import { EQUIP_SLOTS, getItem, type EquipSlot } from "./catalog.js";
import type { Inventory, ItemStack } from "./inventory.js";
import { NEW_ATTRIBUTE_POINTS, REINFORCE_POINTS, upgradeCost } from "./upgrade.js";

/** Experiência que um item +0 que nunca juntou nada vale na fusão: metade do caminho até o +1. */
export const ZERO_ITEM_XP: number = levelXp(0) / 2;

/** Experiência para ir do nível [level] ao seguinte (= o preço de melhorar com moedas nesse nível). */
export function levelXp(level: number): number {
  return upgradeCost(level);
}

/** Experiência que o item [stack] carrega: a de todos os níveis que subiu + a juntada; +0 vazio = {@link ZERO_ITEM_XP}. */
export function itemXp(stack: ItemStack): number {
  let total: number = stack.xp ?? 0;
  for (let level = 0; level < (stack.level ?? 0); level++) total += levelXp(level);
  return total > 0 ? total : ZERO_ITEM_XP;
}

/** Recusa da fusão. */
export type FusionFailure = "item_not_found" | "not_same_item" | "material_equipped";

/** Fusão aceita: inventário novo, o principal depois de subir, quantos níveis ganhou e quanta experiência recebeu. */
export type FusionResult =
  | {
      readonly ok: true;
      readonly inventory: Inventory;
      readonly stack: ItemStack;
      readonly levelsGained: number;
      readonly xpGained: number;
    }
  | { readonly ok: false; readonly reason: FusionFailure };

/**
 * Soma [xp] ao item [stack]: sobe os níveis que ela pagar (cada um com um atributo sorteado do conjunto) e guarda a
 * sobra. Devolve o item novo e quantos níveis subiu.
 */
export function addItemXp(stack: ItemStack, xp: number, random: () => number): { stack: ItemStack; levelsGained: number } {
  const set: string = getItem(stack.itemId)?.set ?? "";
  const allowed: readonly AttributeId[] = attributesForSet(set);
  const attrs: Partial<Record<AttributeId, number>> = { ...stack.attrs };
  let level: number = stack.level ?? 0;
  let banked: number = (stack.xp ?? 0) + xp;
  let levelsGained: number = 0;
  while (banked >= levelXp(level)) {
    banked -= levelXp(level);
    level++;
    levelsGained++;
    const attribute: AttributeId | undefined = allowed[Math.floor(random() * allowed.length)];
    if (attribute !== undefined) {
      const current: number = attrs[attribute] ?? 0;
      attrs[attribute] = current + (current > 0 ? REINFORCE_POINTS : NEW_ATTRIBUTE_POINTS);
    }
  }
  const rest: number = Math.round(banked * 10) / 10;
  return {
    stack: { uid: stack.uid, itemId: stack.itemId, level, attrs, ...(rest > 0 ? { xp: rest } : {}) },
    levelsGained,
  };
}

/**
 * Funde [materialUid] (da MOCHILA; vestido não, para ninguém perder o que está usando sem querer) em [targetUid]
 * (vestido ou na mochila), os dois o mesmo item. O material some; o principal recebe {@link itemXp} dele.
 */
export function fuseItems(inventory: Inventory, targetUid: string, materialUid: string, random: () => number): FusionResult {
  if (targetUid === materialUid) return { ok: false, reason: "item_not_found" };
  const materialIndex: number = inventory.bag.findIndex((stack) => stack.uid === materialUid);
  const material: ItemStack | undefined = inventory.bag[materialIndex];
  const equippedMaterial: boolean = EQUIP_SLOTS.some((slot) => inventory.equipped[slot]?.uid === materialUid);
  if (material === undefined) return { ok: false, reason: equippedMaterial ? "material_equipped" : "item_not_found" };
  let targetSlot: EquipSlot | null = null;
  let target: ItemStack | undefined;
  for (const slot of EQUIP_SLOTS) {
    if (inventory.equipped[slot]?.uid === targetUid) {
      targetSlot = slot;
      target = inventory.equipped[slot] ?? undefined;
    }
  }
  if (target === undefined) target = inventory.bag.find((stack) => stack.uid === targetUid);
  if (target === undefined) return { ok: false, reason: "item_not_found" };
  if (target.itemId !== material.itemId) return { ok: false, reason: "not_same_item" };
  const xpGained: number = itemXp(material);
  const grown = addItemXp(target, xpGained, random);
  const bag: ItemStack[] = inventory.bag.filter((stack) => stack.uid !== materialUid).map((stack) => (stack.uid === targetUid ? grown.stack : stack));
  const equipped = targetSlot === null ? inventory.equipped : { ...inventory.equipped, [targetSlot]: grown.stack };
  return { ok: true, inventory: { ...inventory, equipped, bag }, stack: grown.stack, levelsGained: grown.levelsGained, xpGained };
}

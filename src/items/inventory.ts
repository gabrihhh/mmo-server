import { randomBytes } from "node:crypto";

import { EQUIP_SLOTS, STARTER_BAG, STARTER_EQUIPPED, getItem, type EquipSlot } from "./catalog.js";

/**
 * Inventário de um personagem: 4 slots vestidos + mochila. Regras puras (sem banco nem rede),
 * para testar fácil. Ver mmo-docs [JOGO-04].
 */

/** Capacidade da mochila, em itens. */
export const BAG_CAPACITY = 20;

/** Um item que o jogador possui. `uid` diferencia dois itens iguais (no futuro: qualidade, durabilidade). */
export interface ItemStack {
  readonly uid: string;
  readonly itemId: string;
}

/** Inventário completo. */
export interface Inventory {
  /** O que está vestido em cada slot (`null` = vazio). */
  readonly equipped: Readonly<Record<EquipSlot, ItemStack | null>>;
  /** Itens guardados, na ordem em que aparecem. */
  readonly bag: readonly ItemStack[];
}

/** Motivo de recusa de uma troca. */
export type InventoryFailure = "item_not_found" | "bag_full" | "slot_empty";

/** Resultado de uma troca: inventário novo, ou o motivo da recusa (o antigo não muda). */
export type InventoryResult =
  | { readonly ok: true; readonly inventory: Inventory }
  | { readonly ok: false; readonly reason: InventoryFailure };

/** Id novo de item (12 caracteres). */
export function newItemUid(): string {
  return randomBytes(9).toString("base64url");
}

/** Inventário inicial de uma conta nova. */
export function starterInventory(): Inventory {
  const equipped: Record<EquipSlot, ItemStack | null> = { hand: null, head: null, chest: null, feet: null };
  for (const slot of EQUIP_SLOTS) equipped[slot] = { uid: newItemUid(), itemId: STARTER_EQUIPPED[slot] };
  return { equipped, bag: STARTER_BAG.map((itemId) => ({ uid: newItemUid(), itemId })) };
}

/**
 * Veste o item `uid` da mochila no slot dele. O que estava vestido ali volta para a mochila, no
 * lugar do item vestido (troca direta). `item_not_found` se o uid não está na mochila.
 */
export function equip(inventory: Inventory, uid: string): InventoryResult {
  const index: number = inventory.bag.findIndex((stack) => stack.uid === uid);
  const stack: ItemStack | undefined = inventory.bag[index];
  const def = stack === undefined ? undefined : getItem(stack.itemId);
  if (stack === undefined || def === undefined) return { ok: false, reason: "item_not_found" };

  const previous: ItemStack | null = inventory.equipped[def.slot];
  const bag: ItemStack[] = [...inventory.bag];
  if (previous === null) bag.splice(index, 1);
  else bag.splice(index, 1, previous);
  return { ok: true, inventory: { equipped: { ...inventory.equipped, [def.slot]: stack }, bag } };
}

/** Tira o item do slot e põe no fim da mochila. `slot_empty` se não há nada; `bag_full` se não cabe. */
export function unequip(inventory: Inventory, slot: EquipSlot): InventoryResult {
  const current: ItemStack | null = inventory.equipped[slot];
  if (current === null) return { ok: false, reason: "slot_empty" };
  if (inventory.bag.length >= BAG_CAPACITY) return { ok: false, reason: "bag_full" };
  return { ok: true, inventory: { equipped: { ...inventory.equipped, [slot]: null }, bag: [...inventory.bag, current] } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lê um ItemStack guardado; `null` se inválido ou de item que não existe mais. */
function readStack(value: unknown): ItemStack | null {
  if (!isRecord(value)) return null;
  const { uid, itemId } = value;
  if (typeof uid !== "string" || typeof itemId !== "string" || getItem(itemId) === undefined) return null;
  return { uid, itemId };
}

/**
 * Lê o inventário vindo do banco (não confiável: pode ser antigo ou ter item removido do catálogo).
 * Sem inventário salvo → inicial. Item no slot errado volta para a mochila; itens desconhecidos somem.
 */
export function readInventory(raw: unknown): Inventory {
  if (!isRecord(raw)) return starterInventory();
  const equipped: Record<EquipSlot, ItemStack | null> = { hand: null, head: null, chest: null, feet: null };
  const bag: ItemStack[] = [];
  const rawEquipped: unknown = raw["equipped"];
  for (const slot of EQUIP_SLOTS) {
    const stack: ItemStack | null = isRecord(rawEquipped) ? readStack(rawEquipped[slot]) : null;
    if (stack === null) continue;
    if (getItem(stack.itemId)?.slot === slot) equipped[slot] = stack;
    else bag.push(stack);
  }
  const rawBag: unknown = raw["bag"];
  if (Array.isArray(rawBag)) {
    for (const value of rawBag) {
      const stack: ItemStack | null = readStack(value);
      if (stack !== null && bag.length < BAG_CAPACITY) bag.push(stack);
    }
  }
  return { equipped, bag };
}

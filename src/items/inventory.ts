import { randomBytes } from "node:crypto";

import type { Look, LookLevels } from "../net/protocol.js";
import { attributeEffects, readPoints, sumPoints, type AttributeEffects, type AttributePoints } from "./attributes.js";
import { EQUIP_SLOTS, FULL_KIT, GRANTS, STARTER_BAG, UNARMED_ATTACK, getItem, type AbilityDef, type EquipSlot } from "./catalog.js";

/**
 * Inventário de um personagem: 4 slots vestidos + mochila. Regras puras (sem banco nem rede),
 * para testar fácil. Ver mmo-docs [JOGO-04].
 */

/** Capacidade da mochila, em itens. */
export const BAG_CAPACITY = 30;

/** Um item que o jogador possui. `uid` diferencia dois itens iguais (cada um tem o seu nível de melhoria). */
export interface ItemStack {
  readonly uid: string;
  readonly itemId: string;
  /** Nível de melhoria no ferreiro ([JOGO-16]): +1, +2… sem teto. Ausente = +0. */
  readonly level?: number;
  /** Pontos de atributo ganhos nas melhorias ([JOGO-16]). Ausente = nenhum. */
  readonly attrs?: AttributePoints;
  /**
   * Experiência juntada rumo ao próximo nível pela fusão ([JOGO-20], `src/items/fusion.ts`): o que sobrou depois de
   * subir. Ausente = 0.
   */
  readonly xp?: number;
}

/** Inventário completo. */
export interface Inventory {
  /** O que está vestido em cada slot (`null` = vazio). */
  readonly equipped: Readonly<Record<EquipSlot, ItemStack | null>>;
  /** Itens guardados, na ordem em que aparecem. */
  readonly bag: readonly ItemStack[];
  /** Presentes únicos já recebidos (ids de `GRANTS` do catálogo): não são dados de novo. */
  readonly grants: readonly string[];
}

/** Motivo de recusa de uma troca. */
export type InventoryFailure = "item_not_found" | "bag_full" | "slot_empty";

/** Resultado de uma troca: inventário novo, ou o motivo da recusa (o antigo não muda). */
export type InventoryResult =
  | { readonly ok: true; readonly inventory: Inventory }
  | { readonly ok: false; readonly reason: InventoryFailure };

/** Põe [stack] no fim da mochila (baú dos acampamentos, [JOGO-19]); recusa com a mochila cheia. */
export function addToBag(inventory: Inventory, stack: ItemStack): InventoryResult {
  if (inventory.bag.length >= BAG_CAPACITY) return { ok: false, reason: "bag_full" };
  return { ok: true, inventory: { ...inventory, bag: [...inventory.bag, stack] } };
}

/** Inventário com o kit completo na mochila ({@link FULL_KIT}): o que a conta nova ganhava antes; só para testes. */
export function fullKitInventory(): Inventory {
  return { ...starterInventory(), bag: FULL_KIT.map((itemId) => ({ uid: newItemUid(), itemId })) };
}

/** Id novo de item (12 caracteres). */
export function newItemUid(): string {
  return randomBytes(9).toString("base64url");
}

/** Nada vestido. */
const NOTHING_EQUIPPED: Readonly<Record<EquipSlot, ItemStack | null>> = { hand: null, head: null, chest: null, feet: null };

/**
 * Inventário inicial de uma conta nova ([JOGO-04]): **sem nenhum item** (nada vestido, mochila {@link STARTER_BAG}
 * vazia). Os presentes de `GRANTS` contam como recebidos (são para contas antigas, não para quem nasce agora).
 */
export function starterInventory(): Inventory {
  return {
    equipped: { ...NOTHING_EQUIPPED },
    bag: STARTER_BAG.map((itemId) => ({ uid: newItemUid(), itemId })),
    grants: Object.keys(GRANTS),
  };
}

/**
 * Dá os presentes de `GRANTS` que o inventário ainda não recebeu: põe no fim da mochila cada item que a conta ainda
 * não tem (vestido ou guardado), até a mochila encher, e marca o presente como recebido.
 * O `uid` do item dado é fixo (`grant-<presente>-<itemId>`): ler a mesma conta duas vezes antes de salvar dá o mesmo
 * inventário (o `equip` de quem ainda não salvou continua achando o item).
 */
export function applyGrants(inventory: Inventory): Inventory {
  const missing: string[] = Object.keys(GRANTS).filter((grant) => !inventory.grants.includes(grant));
  if (missing.length === 0) return inventory;
  const bag: ItemStack[] = [...inventory.bag];
  const owned: Set<string> = new Set([...bag, ...EQUIP_SLOTS.map((slot) => inventory.equipped[slot])].flatMap((stack) => (stack === null ? [] : [stack.itemId])));
  for (const grant of missing) {
    for (const itemId of GRANTS[grant] ?? []) {
      if (owned.has(itemId) || bag.length >= BAG_CAPACITY || getItem(itemId) === undefined) continue;
      bag.push({ uid: `grant-${grant}-${itemId}`, itemId });
      owned.add(itemId);
    }
  }
  return { equipped: inventory.equipped, bag, grants: [...inventory.grants, ...missing] };
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
  return { ok: true, inventory: { ...inventory, equipped: { ...inventory.equipped, [def.slot]: stack }, bag } };
}

/**
 * Tira o item do slot e põe na mochila: na posição `index` (arrastado para uma vaga, [CLI-10]; os de depois andam uma
 * para a frente) ou, sem `index` / além do fim, no fim. `slot_empty` se não há nada; `bag_full` se não cabe.
 */
export function unequip(inventory: Inventory, slot: EquipSlot, index: number | null = null): InventoryResult {
  const current: ItemStack | null = inventory.equipped[slot];
  if (current === null) return { ok: false, reason: "slot_empty" };
  if (inventory.bag.length >= BAG_CAPACITY) return { ok: false, reason: "bag_full" };
  const bag: ItemStack[] = [...inventory.bag];
  const at: number = index === null ? bag.length : Math.min(Math.max(0, Math.floor(index)), bag.length);
  bag.splice(at, 0, current);
  return { ok: true, inventory: { ...inventory, equipped: { ...inventory.equipped, [slot]: null }, bag } };
}

/**
 * Organiza a mochila (arrastar um item para outra vaga, [CLI-10]): o item da posição `from` troca de lugar com o da
 * posição `to`; `to` numa vaga livre (além do último item) leva o item para o fim. `item_not_found` se `from` não tem
 * item. Mesma posição = nada muda (aceito).
 */
export function moveInBag(inventory: Inventory, from: number, to: number): InventoryResult {
  const stack: ItemStack | undefined = Number.isInteger(from) ? inventory.bag[from] : undefined;
  if (stack === undefined || !Number.isInteger(to) || to < 0) return { ok: false, reason: "item_not_found" };
  const bag: ItemStack[] = [...inventory.bag];
  const other: ItemStack | undefined = bag[to];
  if (other === undefined) {
    bag.splice(from, 1);
    bag.push(stack);
  } else {
    bag[from] = other;
    bag[to] = stack;
  }
  return { ok: true, inventory: { ...inventory, bag } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lê um ItemStack guardado; `null` se inválido ou de item que não existe mais. */
function readStack(value: unknown): ItemStack | null {
  if (!isRecord(value)) return null;
  const { uid, itemId, level, attrs, xp } = value;
  if (typeof uid !== "string" || typeof itemId !== "string" || getItem(itemId) === undefined) return null;
  // Melhoria ([JOGO-16]): só guarda os campos se o item foi melhorado (item +0 continua { uid, itemId }).
  const safeLevel: number = typeof level === "number" && Number.isSafeInteger(level) && level > 0 ? level : 0;
  const points: AttributePoints = readPoints(attrs);
  // Experiência da fusão ([JOGO-20]): só guarda se tiver.
  const safeXp: number = typeof xp === "number" && Number.isFinite(xp) && xp > 0 ? Math.round(xp * 10) / 10 : 0;
  if (safeLevel === 0 && Object.keys(points).length === 0 && safeXp === 0) return { uid, itemId };
  return { uid, itemId, level: safeLevel, attrs: points, ...(safeXp > 0 ? { xp: safeXp } : {}) };
}

/**
 * Lê o inventário vindo do banco (não confiável: pode ser antigo ou ter item removido do catálogo).
 * Sem inventário salvo → inicial. Item no slot errado volta para a mochila; itens desconhecidos somem.
 * Presentes ainda não recebidos ({@link applyGrants}) entram no fim da mochila.
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
  const rawGrants: unknown = raw["grants"];
  const grants: string[] = Array.isArray(rawGrants) ? rawGrants.filter((grant): grant is string => typeof grant === "string") : [];
  return applyGrants({ equipped, bag, grants });
}


/** Ataque simples atual: o da arma vestida, ou o soco sem arma. */
export function basicAttackOf(inventory: Inventory): AbilityDef {
  const weapon: ItemStack | null = inventory.equipped.hand;
  const def = weapon === null ? undefined : getItem(weapon.itemId);
  return def?.basicAttack ?? UNARMED_ATTACK;
}

/** Habilidades (cartas) de tudo que está vestido, por id. Só elas podem ser lançadas ([JOGO-06]). */
export function equippedAbilities(inventory: Inventory): Map<string, AbilityDef> {
  const result: Map<string, AbilityDef> = new Map();
  for (const slot of EQUIP_SLOTS) {
    const stack: ItemStack | null = inventory.equipped[slot];
    const def = stack === null ? undefined : getItem(stack.itemId);
    for (const ability of def?.abilities ?? []) result.set(ability.id, ability);
  }
  return result;
}

/** Vida máxima extra de tudo que está vestido ([JOGO-09]); soma com `PLAYER_MAX_HP`. */
export function bonusHpOf(inventory: Inventory): number {
  let total: number = 0;
  for (const slot of EQUIP_SLOTS) {
    const stack: ItemStack | null = inventory.equipped[slot];
    total += (stack === null ? undefined : getItem(stack.itemId))?.bonusHp ?? 0;
  }
  return total;
}

/** Efeito somado dos atributos de melhoria de tudo que está vestido ([JOGO-16]). */
export function attributeEffectsOf(inventory: Inventory): AttributeEffects {
  const lists: AttributePoints[] = [];
  for (const slot of EQUIP_SLOTS) {
    const attrs: AttributePoints | undefined = inventory.equipped[slot]?.attrs;
    if (attrs !== undefined) lists.push(attrs);
  }
  return attributeEffects(sumPoints(lists));
}

/** Nível de melhoria de cada peça vestida (só as com nível > 0): o brilho que todos veem ([JOGO-17]). */
export function lookLevelsOf(inventory: Inventory): LookLevels {
  const levels: Partial<Record<EquipSlot, number>> = {};
  for (const slot of EQUIP_SLOTS) {
    const level: number = inventory.equipped[slot]?.level ?? 0;
    if (level > 0) levels[slot] = level;
  }
  return levels;
}

/** Aparência: o `itemId` vestido em cada slot (o que os outros jogadores veem). */
export function lookOf(inventory: Inventory): Look {
  return {
    hand: inventory.equipped.hand?.itemId ?? null,
    head: inventory.equipped.head?.itemId ?? null,
    chest: inventory.equipped.chest?.itemId ?? null,
    feet: inventory.equipped.feet?.itemId ?? null,
  };
}

import { BAG_CAPACITY, type Inventory, type ItemStack } from "./inventory.js";

/**
 * Armazém ([JOGO-26]): o baú grande da praça onde cada conta guarda itens além da mochila. Regras puras (sem banco
 * nem rede); quem confere a distância do baú e mexe nas moedas é a `Zone`. O armazém vive dentro do {@link Inventory}
 * (`storage` e `storageTabs`), para ser salvo junto com a mochila.
 */

/** Espaços de cada aba do armazém. */
export const STORAGE_TAB_SIZE = 20;
/** Preço (moedas) da 1ª aba comprada (a 1ª aba do armazém é grátis). */
export const FIRST_TAB_COST = 5000;
/** Cada aba comprada custa esta vez a anterior (1,5 = +50%). Provisório. */
export const TAB_COST_GROWTH = 1.5;

/** Itens guardados no armazém (conta antiga = vazio). */
export function storageOf(inventory: Inventory): readonly ItemStack[] {
  return inventory.storage ?? [];
}

/**
 * Espaços do armazém: 1 aba grátis + as compradas (moedas ou Diamantes, as duas somam em `storageTabs`) +
 * [extraTabs] (a aba do VIP enquanto ativo, [JOGO-27]).
 */
export function storageCapacity(inventory: Inventory, extraTabs: number = 0): number {
  return STORAGE_TAB_SIZE * (1 + (inventory.storageTabs ?? 0) + Math.max(0, extraTabs));
}

/** Preço da próxima aba, já tendo comprado [bought]: 5.000, 7.500, 11.250… (arredondado). */
export function storageTabCost(bought: number): number {
  return Math.round(FIRST_TAB_COST * TAB_COST_GROWTH ** Math.max(0, bought));
}

/** Motivo de recusa no armazém. */
export type StorageFailure = "item_not_found" | "item_equipped" | "storage_full" | "bag_full" | "not_enough_gold";

/** Resultado de uma ação no armazém: inventário novo e as moedas que mudaram (negativo = gastou), ou o motivo. */
export type StorageResult =
  | { readonly ok: true; readonly inventory: Inventory; readonly goldDelta: number }
  | { readonly ok: false; readonly reason: StorageFailure };

/**
 * Guarda o item [uid] da mochila no fim do armazém. Vestido não entra (`item_equipped`). [extraTabs] = abas do VIP
 * ({@link storageCapacity}); acabou o VIP, o que passou da capacidade fica guardado, só não entra mais nada.
 */
export function putInStorage(inventory: Inventory, uid: string, extraTabs: number = 0): StorageResult {
  const index: number = inventory.bag.findIndex((stack) => stack.uid === uid);
  const stack: ItemStack | undefined = inventory.bag[index];
  if (stack === undefined) {
    const worn: boolean = Object.values(inventory.equipped).some((item) => item?.uid === uid);
    return { ok: false, reason: worn ? "item_equipped" : "item_not_found" };
  }
  const storage: readonly ItemStack[] = storageOf(inventory);
  if (storage.length >= storageCapacity(inventory, extraTabs)) return { ok: false, reason: "storage_full" };
  return {
    ok: true,
    inventory: { ...inventory, bag: inventory.bag.filter((_, i) => i !== index), storage: [...storage, stack] },
    goldDelta: 0,
  };
}

/** Tira o item [uid] do armazém para o fim da mochila. */
export function takeFromStorage(inventory: Inventory, uid: string): StorageResult {
  const storage: readonly ItemStack[] = storageOf(inventory);
  const index: number = storage.findIndex((stack) => stack.uid === uid);
  const stack: ItemStack | undefined = storage[index];
  if (stack === undefined) return { ok: false, reason: "item_not_found" };
  if (inventory.bag.length >= BAG_CAPACITY) return { ok: false, reason: "bag_full" };
  return {
    ok: true,
    inventory: { ...inventory, bag: [...inventory.bag, stack], storage: storage.filter((_, i) => i !== index) },
    goldDelta: 0,
  };
}

/** Compra mais uma aba de {@link STORAGE_TAB_SIZE} espaços com [gold] moedas ({@link storageTabCost}). */
export function buyStorageTab(inventory: Inventory, gold: number): StorageResult {
  const bought: number = inventory.storageTabs ?? 0;
  const cost: number = storageTabCost(bought);
  if (gold < cost) return { ok: false, reason: "not_enough_gold" };
  return { ok: true, inventory: { ...inventory, storageTabs: bought + 1 }, goldDelta: -cost };
}

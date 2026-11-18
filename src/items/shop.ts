import { ITEMS, getItem, type ItemDef } from "./catalog.js";
import { BAG_CAPACITY, newItemUid, type Inventory, type ItemStack } from "./inventory.js";
import { upgradeCost } from "./upgrade.js";

/**
 * Loja do Ferreiro ([JOGO-23]): comprar peças +0 de qualquer conjunto e vender itens da mochila para o jogo.
 * Regras puras (sem banco nem rede); quem confere a distância do ferreiro e mexe nas moedas é a `Zone`.
 * Preços provisórios.
 */

/** Preço de compra (moedas) de uma peça de qualquer conjunto. */
export const SET_PRICE = 500;
/** Parte do preço de compra que o ferreiro paga na venda (0,2 = 20%). */
export const SELL_BASE_SHARE = 0.2;
/** Parte do custo de melhoria (do +0 até o nível do item, sem falhas) que volta na venda (0,25 = 25%). */
export const SELL_UPGRADE_SHARE = 0.25;

/** Preço de compra de [def] na loja. */
export function buyPrice(def: ItemDef): number {
  void def; // mesmo preço para todas as peças (o Treino, mais barato, saiu em 2026-11-17)
  return SET_PRICE;
}

/** Itens à venda na loja: todo o catálogo, na ordem dele (agrupado por conjunto). */
export function shopItems(): readonly ItemDef[] {
  return Object.values(ITEMS);
}

/**
 * Quanto o ferreiro paga por [stack]: 20% do preço de compra + 25% do que custaria levar o item do +0 até o nível dele
 * (soma de `upgradeCost`), arredondado para baixo. Cresce com o nível do item. 0 se o item não existe mais.
 */
export function sellPrice(stack: ItemStack): number {
  const def: ItemDef | undefined = getItem(stack.itemId);
  if (def === undefined) return 0;
  let upgrades: number = 0;
  for (let level: number = 0; level < (stack.level ?? 0); level++) upgrades += upgradeCost(level);
  return Math.floor(buyPrice(def) * SELL_BASE_SHARE + upgrades * SELL_UPGRADE_SHARE);
}

/** Motivo de recusa na loja. */
export type ShopFailure = "item_not_found" | "not_enough_gold" | "bag_full" | "item_equipped";

/** Resultado de comprar/vender: inventário novo e as moedas que mudaram (positivo = ganhou), ou o motivo. */
export type ShopResult =
  | { readonly ok: true; readonly inventory: Inventory; readonly goldDelta: number; readonly itemId: string }
  | { readonly ok: false; readonly reason: ShopFailure };

/** Compra [itemId] (+0, sem atributos) com [gold] moedas: vai para o fim da mochila. */
export function buyItem(inventory: Inventory, itemId: string, gold: number): ShopResult {
  const def: ItemDef | undefined = getItem(itemId);
  if (def === undefined) return { ok: false, reason: "item_not_found" };
  const price: number = buyPrice(def);
  if (gold < price) return { ok: false, reason: "not_enough_gold" };
  if (inventory.bag.length >= BAG_CAPACITY) return { ok: false, reason: "bag_full" };
  return { ok: true, inventory: { ...inventory, bag: [...inventory.bag, { uid: newItemUid(), itemId }] }, goldDelta: -price, itemId };
}

/** Vende o item [uid] da mochila por {@link sellPrice}. Vestido não vende (`item_equipped`). */
export function sellItem(inventory: Inventory, uid: string): ShopResult {
  const index: number = inventory.bag.findIndex((stack) => stack.uid === uid);
  const stack: ItemStack | undefined = inventory.bag[index];
  if (stack === undefined) {
    const worn: boolean = Object.values(inventory.equipped).some((item) => item?.uid === uid);
    return { ok: false, reason: worn ? "item_equipped" : "item_not_found" };
  }
  return { ok: true, inventory: { ...inventory, bag: inventory.bag.filter((_, i) => i !== index) }, goldDelta: sellPrice(stack), itemId: stack.itemId };
}

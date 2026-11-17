import type { AbilityView, InventoryView, ItemView, LootView } from "../net/protocol.js";
import { sellPrice } from "./shop.js";
import { storageCapacity, storageOf, storageTabCost } from "./storage.js";
import type { LootEntry } from "./loot.js";
import { BAG_CAPACITY, type Inventory, type ItemStack } from "./inventory.js";
import { upgradeAttributesOf, upgradeChance, upgradeCost } from "./upgrade.js";
import { itemXp, levelXp } from "./fusion.js";
import { SET_PROFILES, UNARMED_ATTACK, getItem, type AbilityDef } from "./catalog.js";

/**
 * Monta o que vai para o cliente na mensagem `inventory` (nome, slot, descrição e habilidades de cada item, com os
 * números para a ficha do item).
 * Ver mmo-docs [JOGO-04].
 */

function abilityView(def: AbilityDef): AbilityView {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    aim: def.aim,
    range: def.range,
    radius: def.radius,
    cooldown: def.cooldown,
    castTime: def.castTime,
    manaCost: def.manaCost,
    dashDistance: def.dashDistance,
    dashSeconds: def.dashSeconds,
    speedMultiplier: def.speedMultiplier,
    speedSeconds: def.speedSeconds,
    damage: def.damage,
    heal: def.heal,
    shield: def.shield,
    shieldSeconds: def.shieldSeconds,
    projectileSpeed: def.projectileSpeed,
    damageReduction: def.damageReduction,
    reductionSeconds: def.reductionSeconds,
    tauntSeconds: def.tauntSeconds,
  };
}

/** Item visto pelo cliente; `null` se o item não existe no catálogo (não deveria acontecer após readInventory). */
export function itemView(stack: ItemStack): ItemView | null {
  const def = getItem(stack.itemId);
  if (def === undefined) return null;
  return {
    uid: stack.uid,
    itemId: def.id,
    name: def.name,
    description: def.description,
    set: def.set,
    slot: def.slot,
    bonusHp: def.bonusHp,
    profile: SET_PROFILES[def.set] ?? null,
    basicAttack: def.basicAttack === null ? null : abilityView(def.basicAttack),
    abilities: def.abilities.map(abilityView),
    // Melhoria no ferreiro ([JOGO-16]): nível, pontos, o que aceita e a próxima tentativa (preço e chance prontos).
    level: stack.level ?? 0,
    attrs: stack.attrs ?? {},
    upgradeAttributes: upgradeAttributesOf(stack),
    upgradeCost: upgradeCost(stack.level ?? 0),
    upgradeChance: upgradeChance(stack.level ?? 0),
    // Fusão ([JOGO-20]): barrinha rumo ao próximo nível e quanto vale se for fundido.
    xp: stack.xp ?? 0,
    xpNext: levelXp(stack.level ?? 0),
    fusionXp: itemXp(stack),
    sellPrice: sellPrice(stack),
  };
}

/** O que sobrou num baú visto pelo cliente ([JOGO-19]): item com a ficha completa, ou moedas. */
export function lootViews(entries: readonly LootEntry[]): LootView[] {
  const views: LootView[] = [];
  for (const entry of entries) {
    if (entry.kind === "gold") {
      views.push({ lootId: entry.lootId, kind: "gold", amount: entry.amount });
      continue;
    }
    const item: ItemView | null = itemView(entry.stack);
    if (item !== null) views.push({ lootId: entry.lootId, kind: "item", item });
  }
  return views;
}

/** Inventário completo visto pelo cliente. */
export function inventoryView(inventory: Inventory): InventoryView {
  const slot = (stack: ItemStack | null): ItemView | null => (stack === null ? null : itemView(stack));
  return {
    equipped: {
      hand: slot(inventory.equipped.hand),
      head: slot(inventory.equipped.head),
      chest: slot(inventory.equipped.chest),
      feet: slot(inventory.equipped.feet),
    },
    bag: inventory.bag.map(itemView).filter((view): view is ItemView => view !== null),
    bagCapacity: BAG_CAPACITY,
    unarmedAttack: abilityView(UNARMED_ATTACK),
    storage: storageOf(inventory).map(itemView).filter((view): view is ItemView => view !== null),
    storageCapacity: storageCapacity(inventory),
    storageTabCost: storageTabCost(inventory.storageTabs ?? 0),
  };
}

import type { AbilityView, InventoryView, ItemView } from "../net/protocol.js";
import { BAG_CAPACITY, type Inventory, type ItemStack } from "./inventory.js";
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
  };
}

/** Item visto pelo cliente; `null` se o item não existe no catálogo (não deveria acontecer após readInventory). */
function itemView(stack: ItemStack): ItemView | null {
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
  };
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
  };
}

/**
 * O que o jogador perde ao morrer ([JOGO-21]), por qualquer motivo (monstro, PvP). Puro (recebe o sorteador), testado
 * em `test/death.test.ts`.
 *
 * - **Moedas:** {@link DEATH_GOLD_LOSS} do que carrega (arredondado para baixo).
 * - **XP:** {@link DEATH_XP_LOSS} do que o nível atual pede; nunca cai de nível (com menos XP que isso, fica em 0).
 * - **Item:** sorteia uma das peças VESTIDAS (é o que a roleta da tela de morte mostra) e ela quebra — some do
 *   inventário — com chance {@link ITEM_BREAK_CHANCE}.
 */
import { EQUIP_SLOTS, type EquipSlot } from "../items/catalog.js";
import type { Inventory } from "../items/inventory.js";
import { xpToNextLevel, type Progress } from "../progression/level.js";

/** Fração das moedas perdida ao morrer. */
export const DEATH_GOLD_LOSS = 0.1;
/** Fração da XP que o nível atual pede perdida ao morrer (sem cair de nível). */
export const DEATH_XP_LOSS = 0.1;
/** Chance (0..1) de a peça sorteada quebrar: 0,05% = 1 em 2.000 mortes. */
export const ITEM_BREAK_CHANCE = 0.0005;

/** Progresso depois de morrer e quanto foi perdido. */
export interface DeathPenalty {
  readonly progress: Progress;
  readonly goldLost: number;
  readonly xpLost: number;
}

/** Aplica as perdas de moedas e XP de uma morte a [progress]. */
export function deathPenalty(progress: Progress): DeathPenalty {
  const goldLost: number = Math.floor(progress.gold * DEATH_GOLD_LOSS);
  const xpLost: number = Math.round(Math.min(progress.xp, xpToNextLevel(progress.level) * DEATH_XP_LOSS) * 10) / 10;
  return {
    progress: { ...progress, gold: progress.gold - goldLost, xp: Math.round((progress.xp - xpLost) * 10) / 10 },
    goldLost,
    xpLost,
  };
}

/** A peça sorteada na roleta (`null` = nada vestido) e se quebrou. */
export interface ItemRoll {
  readonly slot: EquipSlot | null;
  readonly broken: boolean;
}

/** Sorteia uma das peças vestidas em [inventory] e se ela quebra ({@link ITEM_BREAK_CHANCE}). */
export function rollDeathItem(inventory: Inventory, random: () => number): ItemRoll {
  const worn: EquipSlot[] = EQUIP_SLOTS.filter((slot) => inventory.equipped[slot] !== null);
  const slot: EquipSlot | undefined = worn[Math.floor(random() * worn.length)];
  if (slot === undefined) return { slot: null, broken: false };
  return { slot, broken: random() < ITEM_BREAK_CHANCE };
}

/** [inventory] sem a peça vestida em [slot] (quebrou). */
export function breakEquipped(inventory: Inventory, slot: EquipSlot): Inventory {
  return { ...inventory, equipped: { ...inventory.equipped, [slot]: null } };
}

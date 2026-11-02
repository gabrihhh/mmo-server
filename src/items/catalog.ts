/**
 * Catálogo de itens e habilidades (placeholders de treino). Ver mmo-docs [JOGO-01], [JOGO-03], [JOGO-04].
 *
 * O servidor é a fonte da verdade: o cliente recebe só o que precisa para mostrar (nome, slot,
 * tipo de mira, alcance). Efeitos, dano, recarga e mana entram no passo 3 do [ROAD-05].
 *
 * ATENÇÃO: os tipos de mira (`AimType`) são lidos por mmo-client/scripts/combat/ability_view.gd.
 */

/** Slots vestidos. A ordem é a da HUD: arma (3 cartas), cabeça, peito, pés. */
export const EQUIP_SLOTS = ["hand", "head", "chest", "feet"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** Quantas habilidades (cartas) cada slot dá ([JOGO-01]). */
export const ABILITIES_PER_SLOT: Readonly<Record<EquipSlot, number>> = { hand: 3, head: 1, chest: 1, feet: 1 };

/** Como a habilidade mira (ver [JOGO-02]). */
export type AimType = "target" | "direction" | "area" | "area_self" | "self";

/** Habilidade (dados de exibição/mira). Metros. */
export interface AbilityDef {
  readonly id: string;
  /** Nome curto na carta. */
  readonly title: string;
  readonly aim: AimType;
  /** Alcance (target, direction, area). */
  readonly range: number;
  /** Raio (area, area_self) ou largura da linha (direction). */
  readonly radius: number;
  /** Tempo de recarga em segundos (no ataque simples: intervalo entre golpes). */
  readonly cooldown: number;
  /** Dano por acerto (0 = não causa dano). Só o servidor usa; não vai para o cliente. */
  readonly damage: number;
}

/** Item vestível. */
export interface ItemDef {
  readonly id: string;
  /** Nome exibido. */
  readonly name: string;
  readonly slot: EquipSlot;
  /** Ataque simples (só armas). */
  readonly basicAttack: AbilityDef | null;
  /** Habilidades do item: {@link ABILITIES_PER_SLOT} do slot. */
  readonly abilities: readonly AbilityDef[];
}

const ability = (
  id: string,
  title: string,
  aim: AimType,
  cooldown: number,
  range: number = 0,
  radius: number = 0,
  damage: number = 0,
): AbilityDef => ({ id, title, aim, range, radius, cooldown, damage });

/** Ataque sem arma na mão. */
export const UNARMED_ATTACK: AbilityDef = ability("punch", "Soco", "target", 0.8, 1.5, 0, 4);

/** Todos os itens que existem. Placeholders de treino ([JOGO-03]). */
export const ITEMS: Readonly<Record<string, ItemDef>> = {
  training_sword: {
    id: "training_sword",
    name: "Espada de treino",
    slot: "hand",
    basicAttack: ability("sword_attack", "Ataque", "target", 1, 2.5, 0, 10),
    abilities: [
      ability("heavy_strike", "Golpe forte", "target", 6, 3),
      ability("dash", "Investida", "direction", 8, 6, 1),
      ability("spin", "Giro", "area_self", 10, 0, 3),
    ],
  },
  training_staff: {
    id: "training_staff",
    name: "Cajado de treino",
    slot: "hand",
    basicAttack: ability("staff_attack", "Ataque", "target", 1.2, 8, 0, 7),
    abilities: [
      ability("fireball", "Bola de fogo", "direction", 4, 12, 0.6),
      ability("meteor", "Meteoro", "area", 12, 10, 2.5),
      ability("bolt", "Raio", "target", 7, 10),
    ],
  },
  training_hood: {
    id: "training_hood",
    name: "Capuz de treino",
    slot: "head",
    basicAttack: null,
    abilities: [ability("heal", "Cura", "self", 15)],
  },
  training_vest: {
    id: "training_vest",
    name: "Colete de treino",
    slot: "chest",
    basicAttack: null,
    abilities: [ability("shield", "Escudo", "self", 18)],
  },
  training_boots: {
    id: "training_boots",
    name: "Bota de treino",
    slot: "feet",
    basicAttack: null,
    abilities: [ability("sprint", "Disparada", "self", 12)],
  },
};

/** Item pelo id, ou `undefined` se não existe (ex.: dado antigo no banco). */
export function getItem(itemId: string): ItemDef | undefined {
  return Object.hasOwn(ITEMS, itemId) ? ITEMS[itemId] : undefined;
}

/** O que uma conta nova recebe: kit de treino vestido + cajado na mochila (para testar a troca de arma). */
export const STARTER_EQUIPPED: Readonly<Record<EquipSlot, string>> = {
  hand: "training_sword",
  head: "training_hood",
  chest: "training_vest",
  feet: "training_boots",
};
export const STARTER_BAG: readonly string[] = ["training_staff"];

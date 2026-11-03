/**
 * Catálogo de itens e habilidades (placeholders de treino). Ver mmo-docs [JOGO-01], [JOGO-03], [JOGO-04], [JOGO-06].
 *
 * O servidor é a fonte da verdade: o cliente recebe só o que precisa para mostrar (nome, slot,
 * tipo de mira, alcance, recarga, lançamento). Dano, cura, escudo e mana ficam só aqui.
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

/** Habilidade. Metros, segundos, pontos de vida/mana. */
export interface AbilityDef {
  readonly id: string;
  /** Nome curto na carta. */
  readonly title: string;
  readonly aim: AimType;
  /** Alcance (target, direction, area). */
  readonly range: number;
  /** Raio (area, area_self) ou meia-largura da linha (direction). */
  readonly radius: number;
  /** Tempo de recarga em segundos (no ataque simples: intervalo entre golpes). */
  readonly cooldown: number;
  /**
   * Tempo de lançamento em segundos: do início da ação até o efeito ([JOGO-05]). Durante ele o personagem fica
   * virado para o alvo/direção; no fim, o alvo precisa estar no alcance, senão erra. No ataque simples é
   * igual ao intervalo entre golpes (espada: 1 golpe por segundo).
   */
  readonly castTime: number;
  /** Mana gasta ao começar o lançamento (0 no ataque simples). Só o servidor usa. */
  readonly manaCost: number;
  /** Dano por alvo atingido. Só o servidor usa. */
  readonly damage: number;
  /** Vida recuperada por quem lança (habilidades "self"). Só o servidor usa. */
  readonly heal: number;
  /** Escudo: dano absorvido e por quantos segundos. Só o servidor usa. */
  readonly shield: number;
  readonly shieldSeconds: number;
  /**
   * `false` = ainda não implementada no servidor (Investida e Disparada mexem no movimento: passo 3c do
   * [ROAD-05]). O servidor recusa com "Disponível em breve".
   */
  readonly available: boolean;
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

/** Campos obrigatórios de toda habilidade; o resto tem padrão zero / disponível. */
type AbilitySpec = Pick<AbilityDef, "id" | "title" | "aim" | "cooldown" | "castTime"> & Partial<AbilityDef>;

/** Monta uma habilidade com os campos que faltarem em zero (e disponível). */
const ability = (spec: AbilitySpec): AbilityDef => ({
  range: 0,
  radius: 0,
  manaCost: 0,
  damage: 0,
  heal: 0,
  shield: 0,
  shieldSeconds: 0,
  available: true,
  ...spec,
});

/** Ataque sem arma na mão. */
export const UNARMED_ATTACK: AbilityDef = ability({
  id: "punch", title: "Soco", aim: "target", range: 1.5, cooldown: 0.8, castTime: 0.8, damage: 4,
});

/** Todos os itens que existem. Placeholders de treino ([JOGO-03]). */
export const ITEMS: Readonly<Record<string, ItemDef>> = {
  training_sword: {
    id: "training_sword",
    name: "Espada de treino",
    slot: "hand",
    basicAttack: ability({ id: "sword_attack", title: "Ataque", aim: "target", range: 2.5, cooldown: 1, castTime: 1, damage: 10 }),
    abilities: [
      ability({ id: "heavy_strike", title: "Golpe forte", aim: "target", range: 3, cooldown: 6, castTime: 0.5, manaCost: 15, damage: 25 }),
      ability({ id: "dash", title: "Investida", aim: "direction", range: 6, radius: 1, cooldown: 8, castTime: 0.15, manaCost: 10, available: false }),
      ability({ id: "spin", title: "Giro", aim: "area_self", radius: 3, cooldown: 10, castTime: 0.4, manaCost: 20, damage: 15 }),
    ],
  },
  training_staff: {
    id: "training_staff",
    name: "Cajado de treino",
    slot: "hand",
    basicAttack: ability({ id: "staff_attack", title: "Ataque", aim: "target", range: 8, cooldown: 1.2, castTime: 1.2, damage: 7 }),
    abilities: [
      ability({ id: "fireball", title: "Bola de fogo", aim: "direction", range: 12, radius: 0.6, cooldown: 4, castTime: 0.6, manaCost: 15, damage: 20 }),
      ability({ id: "meteor", title: "Meteoro", aim: "area", range: 10, radius: 2.5, cooldown: 12, castTime: 1, manaCost: 30, damage: 30 }),
      ability({ id: "bolt", title: "Raio", aim: "target", range: 10, cooldown: 7, castTime: 0.4, manaCost: 12, damage: 18 }),
    ],
  },
  training_hood: {
    id: "training_hood",
    name: "Capuz de treino",
    slot: "head",
    basicAttack: null,
    abilities: [ability({ id: "heal", title: "Cura", aim: "self", cooldown: 15, castTime: 0.8, manaCost: 25, heal: 30 })],
  },
  training_vest: {
    id: "training_vest",
    name: "Colete de treino",
    slot: "chest",
    basicAttack: null,
    abilities: [ability({ id: "shield", title: "Escudo", aim: "self", cooldown: 18, castTime: 0.2, manaCost: 20, shield: 30, shieldSeconds: 4 })],
  },
  training_boots: {
    id: "training_boots",
    name: "Bota de treino",
    slot: "feet",
    basicAttack: null,
    abilities: [ability({ id: "sprint", title: "Disparada", aim: "self", cooldown: 12, castTime: 0, manaCost: 10, available: false })],
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

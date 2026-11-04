/**
 * Catálogo de itens e habilidades (placeholders de treino). Ver mmo-docs [JOGO-01], [JOGO-03], [JOGO-04], [JOGO-06].
 *
 * O servidor é a fonte da verdade. O cliente recebe os números para MOSTRAR (carta, prévia da mira e a ficha do item
 * no inventário: dano, cura, escudo, duração, recarga, lançamento, mana); quem aplica é sempre o servidor.
 *
 * ATENÇÃO: os tipos de mira (`AimType`) são lidos por mmo-client/scripts/combat/ability_view.gd.
 */

import { TICK_RATE_HZ } from "../sim/movement.js";

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
  /** Frase curta (português) na ficha do item no inventário. Só exibição. */
  readonly description: string;
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
  /** Mana gasta ao começar o lançamento (0 no ataque simples). */
  readonly manaCost: number;
  /** Dano por alvo atingido. */
  readonly damage: number;
  /** Vida recuperada por quem lança (habilidades "self"). */
  readonly heal: number;
  /** Escudo: dano absorvido e por quantos segundos. */
  readonly shield: number;
  readonly shieldSeconds: number;
  /**
   * Projétil (só mira "direction"), em m/s. Maior que 0: no fim do lançamento sai um projétil que voa em linha reta
   * até `range` e acerta o primeiro inimigo que encontrar NO CAMINHO — dá para desviar ([JOGO-08]).
   * 0: acerta na hora, no fim do lançamento, o primeiro inimigo na linha.
   */
  readonly projectileSpeed: number;
  /**
   * Mira "alvo" com projétil só visual (ataque do cajado, Raio): quantos segundos ANTES do fim do lançamento o tiro
   * sai da mão ([JOGO-08]). Depois disso andar não cancela mais e o alcance é conferido nesse momento (o tiro que saiu
   * sempre chega). 0 = sem soltura antecipada (efeito só no fim). Vai no `cast_start` como `release`.
   * ATENÇÃO: o cliente lança o projétil visual nesse instante (mmo-client/scripts/world/zone.gd).
   */
  readonly releaseTime: number;
  /** Investida: metros percorridos na direção ([JOGO-07]). */
  readonly dashDistance: number;
  /**
   * Investida: duração do deslocamento, em segundos. O personagem PERCORRE o caminho (não teleporta): a distância é
   * dividida igualmente pelos `round(dashSeconds × 20)` passos de movimento seguintes ([JOGO-07]).
   */
  readonly dashSeconds: number;
  /** Disparada: multiplicador de velocidade e por quantos segundos / passos de movimento ([JOGO-07]). */
  readonly speedMultiplier: number;
  readonly speedSeconds: number;
  /** `false` = ainda não implementada no servidor; ele recusa com "disponível em breve". */
  readonly available: boolean;
}

/** Item vestível. */
export interface ItemDef {
  readonly id: string;
  /** Nome exibido. */
  readonly name: string;
  /** Frase curta (português) na ficha do item no inventário. Só exibição. */
  readonly description: string;
  /** Conjunto a que o item pertence (agrupa na ficha: "Treino", "Mago", "Cavaleiro"). Só exibição. */
  readonly set: string;
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
  description: "",
  range: 0,
  radius: 0,
  manaCost: 0,
  damage: 0,
  heal: 0,
  shield: 0,
  shieldSeconds: 0,
  projectileSpeed: 0,
  releaseTime: 0,
  dashDistance: 0,
  dashSeconds: 0,
  speedMultiplier: 0,
  speedSeconds: 0,
  available: true,
  ...spec,
});

/** Ataque sem arma na mão. */
export const UNARMED_ATTACK: AbilityDef = ability({
  id: "punch", title: "Soco", description: "Soco de mão vazia.", aim: "target", range: 1.5, cooldown: 0.8, castTime: 0.8, damage: 4,
});

/**
 * Todos os itens que existem ([JOGO-03]): kit de treino + conjunto do Mago + conjunto do Cavaleiro.
 * ATENÇÃO: cada itemId precisa de ícone em mmo-client/assets/icons/items/<itemId>.png e cada habilidade em
 * mmo-client/assets/icons/abilities/<abilityId>.png (sem ícone o cliente desenha um quadro vazio).
 */
export const ITEMS: Readonly<Record<string, ItemDef>> = {
  // --- Kit de treino -------------------------------------------------------------------------------------------
  training_sword: {
    id: "training_sword",
    name: "Espada de treino",
    description: "Espada curva de duas mãos, boa para aprender a lutar de perto.",
    set: "Treino",
    slot: "hand",
    basicAttack: ability({ id: "sword_attack", title: "Ataque", description: "Golpe de espada no alvo.", aim: "target", range: 2.5, cooldown: 1, castTime: 1, damage: 10 }),
    abilities: [
      // Corpo a corpo: acerta só quem está em volta do personagem (não precisa de alvo).
      ability({ id: "heavy_strike", title: "Golpe forte", description: "Pancada no chão que acerta todos em volta.", aim: "area_self", radius: 2.5, cooldown: 6, castTime: 0.5, manaCost: 15, damage: 25 }),
      // Sem lançamento: começa na hora e percorre 6 m em 0,3 s pela fila de movimento (predição exata, [JOGO-07]).
      ability({ id: "dash", title: "Investida", description: "Avança rápido na direção escolhida.", aim: "direction", range: 6, radius: 1, cooldown: 8, castTime: 0, manaCost: 10, dashDistance: 6, dashSeconds: 0.3 }),
      ability({ id: "spin", title: "Giro", description: "Gira a espada e corta todos ao redor.", aim: "area_self", radius: 3, cooldown: 10, castTime: 0.4, manaCost: 20, damage: 15 }),
    ],
  },
  training_staff: {
    id: "training_staff",
    name: "Cajado de treino",
    description: "Cajado de madeira simples para as primeiras magias.",
    set: "Treino",
    slot: "hand",
    basicAttack: ability({ id: "staff_attack", title: "Ataque", description: "Faísca mágica no alvo.", aim: "target", range: 8, cooldown: 1.2, castTime: 1.2, damage: 7, releaseTime: 0.3 }),
    abilities: [
      ability({ id: "fireball", title: "Bola de fogo", description: "Projétil de fogo que acerta o primeiro no caminho (dá para desviar).", aim: "direction", range: 12, radius: 0.6, cooldown: 4, castTime: 0.6, manaCost: 15, damage: 20, projectileSpeed: 14 }),
      ability({ id: "meteor", title: "Meteoro", description: "Meteoro cai no ponto escolhido e queima todos na área.", aim: "area", range: 10, radius: 2.5, cooldown: 12, castTime: 1, manaCost: 30, damage: 30 }),
      ability({ id: "bolt", title: "Raio", description: "Raio rápido no alvo.", aim: "target", range: 10, cooldown: 7, castTime: 0.4, manaCost: 12, damage: 18, releaseTime: 0.15 }),
    ],
  },
  training_hood: {
    id: "training_hood",
    name: "Capuz de treino",
    description: "Capuz de linho grosso.",
    set: "Treino",
    slot: "head",
    basicAttack: null,
    abilities: [ability({ id: "heal", title: "Cura", description: "Recupera um pouco de vida.", aim: "self", cooldown: 15, castTime: 0.8, manaCost: 25, heal: 30 })],
  },
  training_vest: {
    id: "training_vest",
    name: "Colete de treino",
    description: "Colete de couro acolchoado.",
    set: "Treino",
    slot: "chest",
    basicAttack: null,
    abilities: [ability({ id: "shield", title: "Escudo", description: "Escudo que absorve dano por pouco tempo.", aim: "self", cooldown: 18, castTime: 0.2, manaCost: 20, shield: 30, shieldSeconds: 4 })],
  },
  training_boots: {
    id: "training_boots",
    name: "Bota de treino",
    description: "Botas de couro para correr.",
    set: "Treino",
    slot: "feet",
    basicAttack: null,
    abilities: [
      ability({ id: "sprint", title: "Disparada", description: "Corre com o dobro da velocidade por um instante.", aim: "self", cooldown: 12, castTime: 0, manaCost: 10, speedMultiplier: 2, speedSeconds: 2.5 }),
    ],
  },

  // --- Conjunto do Mago: dano à distância, área grande, fuga rápida; frágil de perto ---------------------------
  arcane_staff: {
    id: "arcane_staff",
    name: "Cajado arcano",
    description: "Cajado retorcido com um cristal arcano. Magias fortes de longe.",
    set: "Mago",
    slot: "hand",
    basicAttack: ability({ id: "arcane_attack", title: "Ataque", description: "Faísca arcana no alvo.", aim: "target", range: 9, cooldown: 1.1, castTime: 1.1, damage: 7, releaseTime: 0.3 }),
    abilities: [
      ability({ id: "ice_lance", title: "Lança de gelo", description: "Lança de gelo rápida que acerta o primeiro no caminho.", aim: "direction", range: 14, radius: 0.4, cooldown: 5, castTime: 0.5, manaCost: 18, damage: 24, projectileSpeed: 20 }),
      ability({ id: "arcane_nova", title: "Nova arcana", description: "Explosão arcana que acerta todos ao seu redor.", aim: "area_self", radius: 4, cooldown: 11, castTime: 0.6, manaCost: 25, damage: 22 }),
      ability({ id: "starfall", title: "Chuva de estrelas", description: "Estrelas caem numa área grande, longe de você.", aim: "area", range: 12, radius: 3, cooldown: 14, castTime: 1.2, manaCost: 35, damage: 35 }),
    ],
  },
  mage_hat: {
    id: "mage_hat",
    name: "Chapéu de mago",
    description: "Chapéu pontudo de feltro azul com uma estrela dourada.",
    set: "Mago",
    slot: "head",
    basicAttack: null,
    abilities: [
      ability({ id: "meditation", title: "Meditação", description: "Concentra-se e recupera bastante vida (lançamento longo).", aim: "self", cooldown: 18, castTime: 1.5, manaCost: 15, heal: 40 }),
    ],
  },
  mage_tunic: {
    id: "mage_tunic",
    name: "Túnica arcana",
    description: "Túnica azul com runa arcana e faixa roxa.",
    set: "Mago",
    slot: "chest",
    basicAttack: null,
    abilities: [
      ability({ id: "arcane_barrier", title: "Barreira arcana", description: "Barreira mágica que absorve dano.", aim: "self", cooldown: 20, castTime: 0.3, manaCost: 30, shield: 45, shieldSeconds: 5 }),
    ],
  },
  mage_shoes: {
    id: "mage_shoes",
    name: "Sapatilhas arcanas",
    description: "Sapatilhas de seda que dobram o espaço.",
    set: "Mago",
    slot: "feet",
    basicAttack: null,
    abilities: [
      // Investida curtíssima (0,1 s = 2 passos): na prática um teleporte curto, com a mesma predição ([JOGO-07]).
      ability({ id: "blink", title: "Teleporte", description: "Some e reaparece alguns metros à frente.", aim: "direction", range: 7, radius: 0.6, cooldown: 10, castTime: 0, manaCost: 15, dashDistance: 7, dashSeconds: 0.1 }),
    ],
  },

  // --- Conjunto do Cavaleiro: corpo a corpo, aguenta muito dano, chega rápido no inimigo -----------------------
  knight_sword: {
    id: "knight_sword",
    name: "Espada longa",
    description: "Espada reta de aço com guarda dourada. Golpes pesados de perto.",
    set: "Cavaleiro",
    slot: "hand",
    basicAttack: ability({ id: "knight_attack", title: "Ataque", description: "Golpe de espada longa no alvo.", aim: "target", range: 2.8, cooldown: 1.3, castTime: 1.3, damage: 14 }),
    abilities: [
      // Sem projétil: acerta na hora o primeiro inimigo na faixa larga à frente.
      ability({ id: "line_cleave", title: "Corte em linha", description: "Corte largo à frente que acerta o primeiro inimigo.", aim: "direction", range: 4, radius: 1.2, cooldown: 7, castTime: 0.5, manaCost: 15, damage: 28 }),
      ability({ id: "heroic_charge", title: "Avanço heroico", description: "Avança longe na direção escolhida.", aim: "direction", range: 8, radius: 1, cooldown: 10, castTime: 0, manaCost: 12, dashDistance: 8, dashSeconds: 0.4 }),
      ability({ id: "ground_slam", title: "Terremoto", description: "Crava a espada no chão e acerta todos em volta.", aim: "area_self", radius: 3.5, cooldown: 13, castTime: 0.8, manaCost: 25, damage: 30 }),
    ],
  },
  knight_helm: {
    id: "knight_helm",
    name: "Elmo do cavaleiro",
    description: "Elmo de aço com crista azul.",
    set: "Cavaleiro",
    slot: "head",
    basicAttack: null,
    abilities: [
      ability({ id: "second_wind", title: "Segundo fôlego", description: "Recupera vida quase na hora.", aim: "self", cooldown: 20, castTime: 0.3, manaCost: 15, heal: 25 }),
    ],
  },
  knight_plate: {
    id: "knight_plate",
    name: "Peitoral de placas",
    description: "Couraça de aço com tabardo azul.",
    set: "Cavaleiro",
    slot: "chest",
    basicAttack: null,
    abilities: [
      ability({ id: "steel_wall", title: "Muralha de aço", description: "Escudo grande e duradouro.", aim: "self", cooldown: 25, castTime: 0.5, manaCost: 30, shield: 60, shieldSeconds: 6 }),
    ],
  },
  knight_greaves: {
    id: "knight_greaves",
    name: "Grevas do cavaleiro",
    description: "Botas de placas de aço.",
    set: "Cavaleiro",
    slot: "feet",
    basicAttack: null,
    abilities: [
      ability({ id: "steady_march", title: "Marcha firme", description: "Anda mais rápido por mais tempo.", aim: "self", cooldown: 16, castTime: 0, manaCost: 15, speedMultiplier: 1.6, speedSeconds: 4 }),
    ],
  },
};

/** Item pelo id, ou `undefined` se não existe (ex.: dado antigo no banco). */
export function getItem(itemId: string): ItemDef | undefined {
  return Object.hasOwn(ITEMS, itemId) ? ITEMS[itemId] : undefined;
}

/** Conjuntos novos (Mago e Cavaleiro). */
export const MAGE_SET: readonly string[] = ["arcane_staff", "mage_hat", "mage_tunic", "mage_shoes"];
export const KNIGHT_SET: readonly string[] = ["knight_sword", "knight_helm", "knight_plate", "knight_greaves"];

/**
 * Conta nova "nasce pelada" (nada vestido, [JOGO-04]) com os três conjuntos na mochila, para escolher o que vestir.
 */
export const STARTER_BAG: readonly string[] = [
  "training_sword", "training_staff", "training_hood", "training_vest", "training_boots",
  ...MAGE_SET,
  ...KNIGHT_SET,
];

/**
 * Presentes únicos para contas que já existiam: id do presente → itens que ela recebe na mochila (só os que ainda
 * não tem e só o que couber). O inventário guarda os ids já recebidos (`grants`) para não dar de novo.
 * Conta nova já nasce com todos marcados ({@link STARTER_BAG} tem tudo).
 */
export const GRANTS: Readonly<Record<string, readonly string[]>> = {
  sets_v1: [...MAGE_SET, ...KNIGHT_SET],
};

/** `true` se a habilidade mexe no movimento (Investida, Disparada): vai pela fila de comandos ([JOGO-07]). */
export function isMovementAbility(ability: AbilityDef): boolean {
  return ability.dashDistance > 0 || ability.speedMultiplier > 0;
}

/** Passos de movimento que uma Investida dura (pelo menos 1). ATENÇÃO: mesma conta em mmo-client AbilityView.dash_steps. */
export function dashSteps(ability: AbilityDef): number {
  return Math.max(1, Math.round(ability.dashSeconds * TICK_RATE_HZ));
}

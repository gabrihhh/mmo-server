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

/**
 * Como a habilidade mira (ver [JOGO-02]). "ally" = um jogador aliado (outro jogador vivo, ou você mesmo sem alvo):
 * cura/escudo nele ([JOGO-09]). Sem grupos ainda, todo jogador conta como aliado (mesmo com PvP).
 */
export type AimType = "target" | "direction" | "area" | "area_self" | "self" | "ally";

/**
 * Nível de um atributo do conjunto, mostrado na ficha do item ([JOGO-09]): "zero" (não tem), baixo, médio, alto.
 * Cada nível corresponde a uma faixa de números da tabela de balanceamento em [JOGO-09].
 * ATENÇÃO: o cliente traduz os nomes em mmo-client/scripts/ui/item_detail_panel.gd.
 */
export type Tier = "zero" | "low" | "medium" | "high";

/** Perfil do conjunto em baixo/médio/alto: o que ele faz bem e mal ([JOGO-09]). Só exibição. */
export interface SetProfile {
  /** Dano por segundo sustentado (ataque simples + cartas). */
  readonly damage: Tier;
  /** Vida máxima (vida extra que as peças dão, {@link ItemDef.bonusHp}). */
  readonly health: Tier;
  /** Cura (em si ou nos aliados). */
  readonly healing: Tier;
  /** Tempo de recarga das cartas (alto = espera muito entre um uso e outro). */
  readonly cooldown: Tier;
}

/**
 * Vida extra que o conjunto INTEIRO vestido dá em cada nível de vida ([JOGO-09]); fica dividida entre as peças.
 * Vida base de todo jogador: `PLAYER_MAX_HP` (stats.ts).
 */
export const SET_BONUS_HP: Readonly<Record<Tier, number>> = { zero: 0, low: 0, medium: 60, high: 150 };

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
  /** Vida recuperada: por quem lança ("self"), pelo aliado ("ally") ou pelos aliados em volta ("area_self"). */
  readonly heal: number;
  /** Escudo: dano absorvido e por quantos segundos. */
  readonly shield: number;
  readonly shieldSeconds: number;
  /**
   * Redução de dano (0..1) em quem lança, por `reductionSeconds` ([JOGO-09]): 0,5 = recebe metade. Vale antes do
   * escudo. Só em habilidades "self".
   */
  readonly damageReduction: number;
  readonly reductionSeconds: number;
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
  /** Conjunto a que o item pertence (agrupa na ficha: "Treino", "Mago", "Cavaleiro"...). Só exibição. */
  readonly set: string;
  readonly slot: EquipSlot;
  /** Vida máxima extra enquanto vestido (soma com as outras peças, [JOGO-09]). */
  readonly bonusHp: number;
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
  damageReduction: 0,
  reductionSeconds: 0,
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
 * Perfil de cada conjunto em baixo/médio/alto ([JOGO-09]). O nome é o `set` dos itens. Só exibição: os números de
 * verdade estão nas habilidades e no `bonusHp` das peças, escolhidos para cair na faixa do nível.
 * Todo conjunto tem pelo menos uma carta defensiva (escudo, redução de dano, cura ou fuga).
 */
export const SET_PROFILES: Readonly<Record<string, SetProfile>> = {
  Treino: { damage: "medium", health: "low", healing: "low", cooldown: "medium" },
  Mago: { damage: "medium", health: "low", healing: "low", cooldown: "medium" },
  Cavaleiro: { damage: "low", health: "high", healing: "low", cooldown: "medium" },
  Atirador: { damage: "medium", health: "low", healing: "low", cooldown: "medium" },
  Assassino: { damage: "high", health: "low", healing: "zero", cooldown: "high" },
  Curandeiro: { damage: "zero", health: "low", healing: "medium", cooldown: "medium" },
};

/**
 * Todos os itens que existem ([JOGO-03], [JOGO-09]): kit de treino + conjuntos Mago, Cavaleiro, Atirador, Assassino e
 * Curandeiro.
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
    bonusHp: 0,
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
    bonusHp: 0,
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
    bonusHp: 0,
    basicAttack: null,
    abilities: [ability({ id: "heal", title: "Cura", description: "Recupera um pouco de vida.", aim: "self", cooldown: 15, castTime: 0.8, manaCost: 25, heal: 30 })],
  },
  training_vest: {
    id: "training_vest",
    name: "Colete de treino",
    description: "Colete de couro acolchoado.",
    set: "Treino",
    slot: "chest",
    bonusHp: 0,
    basicAttack: null,
    abilities: [ability({ id: "shield", title: "Escudo", description: "Escudo que absorve dano por pouco tempo.", aim: "self", cooldown: 18, castTime: 0.2, manaCost: 20, shield: 30, shieldSeconds: 4 })],
  },
  training_boots: {
    id: "training_boots",
    name: "Bota de treino",
    description: "Botas de couro para correr.",
    set: "Treino",
    slot: "feet",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "sprint", title: "Disparada", description: "Corre com o dobro da velocidade por um instante.", aim: "self", cooldown: 12, castTime: 0, manaCost: 10, speedMultiplier: 2, speedSeconds: 2.5 }),
    ],
  },

  // --- Mago: dano médio constante de longe, vida baixa ----------------------------------------------------------
  arcane_staff: {
    id: "arcane_staff",
    name: "Cajado arcano",
    description: "Cajado retorcido com um cristal arcano. Dano constante de longe.",
    set: "Mago",
    slot: "hand",
    bonusHp: 0,
    basicAttack: ability({ id: "arcane_attack", title: "Ataque", description: "Faísca arcana no alvo.", aim: "target", range: 9, cooldown: 1.1, castTime: 1.1, damage: 9, releaseTime: 0.3 }),
    abilities: [
      ability({ id: "ice_lance", title: "Lança de gelo", description: "Lança de gelo rápida que acerta o primeiro no caminho.", aim: "direction", range: 14, radius: 0.4, cooldown: 4, castTime: 0.5, manaCost: 15, damage: 20, projectileSpeed: 20 }),
      ability({ id: "arcane_nova", title: "Nova arcana", description: "Explosão arcana que acerta todos ao seu redor.", aim: "area_self", radius: 4, cooldown: 8, castTime: 0.6, manaCost: 20, damage: 18 }),
      ability({ id: "starfall", title: "Chuva de estrelas", description: "Estrelas caem numa área grande, longe de você.", aim: "area", range: 12, radius: 3, cooldown: 10, castTime: 1.2, manaCost: 25, damage: 24 }),
    ],
  },
  mage_hat: {
    id: "mage_hat",
    name: "Chapéu de mago",
    description: "Chapéu pontudo de feltro azul com uma estrela dourada.",
    set: "Mago",
    slot: "head",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "meditation", title: "Meditação", description: "Concentra-se e recupera vida (lançamento longo).", aim: "self", cooldown: 18, castTime: 1.5, manaCost: 15, heal: 30 }),
    ],
  },
  mage_tunic: {
    id: "mage_tunic",
    name: "Túnica arcana",
    description: "Túnica azul com runa arcana e faixa roxa.",
    set: "Mago",
    slot: "chest",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "arcane_barrier", title: "Barreira arcana", description: "Barreira mágica que absorve dano.", aim: "self", cooldown: 18, castTime: 0.3, manaCost: 25, shield: 40, shieldSeconds: 5 }),
    ],
  },
  mage_shoes: {
    id: "mage_shoes",
    name: "Sapatilhas arcanas",
    description: "Sapatilhas de seda que dobram o espaço.",
    set: "Mago",
    slot: "feet",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      // Investida curtíssima (0,1 s = 2 passos): na prática um teleporte curto, com a mesma predição ([JOGO-07]).
      ability({ id: "blink", title: "Teleporte", description: "Some e reaparece alguns metros à frente.", aim: "direction", range: 7, radius: 0.6, cooldown: 10, castTime: 0, manaCost: 15, dashDistance: 7, dashSeconds: 0.1 }),
    ],
  },

  // --- Cavaleiro: dano baixo, vida alta, mais cartas defensivas -------------------------------------------------
  knight_sword: {
    id: "knight_sword",
    name: "Espada longa",
    description: "Espada reta de aço com guarda dourada. Bate pouco, mas segura a linha de frente.",
    set: "Cavaleiro",
    slot: "hand",
    bonusHp: 0,
    basicAttack: ability({ id: "knight_attack", title: "Ataque", description: "Golpe de espada longa no alvo.", aim: "target", range: 2.8, cooldown: 1.3, castTime: 1.3, damage: 8 }),
    abilities: [
      // Sem projétil: acerta na hora o primeiro inimigo na faixa larga à frente.
      ability({ id: "line_cleave", title: "Corte em linha", description: "Corte largo à frente que acerta o primeiro inimigo.", aim: "direction", range: 4, radius: 1.2, cooldown: 7, castTime: 0.5, manaCost: 12, damage: 14 }),
      ability({ id: "heroic_charge", title: "Avanço heroico", description: "Avança longe na direção escolhida.", aim: "direction", range: 8, radius: 1, cooldown: 10, castTime: 0, manaCost: 12, dashDistance: 8, dashSeconds: 0.4 }),
      ability({ id: "ground_slam", title: "Terremoto", description: "Crava a espada no chão e acerta todos em volta.", aim: "area_self", radius: 3.5, cooldown: 12, castTime: 0.8, manaCost: 20, damage: 12 }),
    ],
  },
  knight_helm: {
    id: "knight_helm",
    name: "Elmo do cavaleiro",
    description: "Elmo de aço com crista azul.",
    set: "Cavaleiro",
    slot: "head",
    bonusHp: 40,
    basicAttack: null,
    abilities: [
      // area_self sem dano: escudo em todos os aliados em volta, você incluído ([JOGO-09]).
      ability({ id: "rallying_cry", title: "Grito de proteção", description: "Escudo em você e nos aliados em volta.", aim: "area_self", radius: 4, cooldown: 18, castTime: 0.3, manaCost: 20, shield: 25, shieldSeconds: 5 }),
    ],
  },
  knight_plate: {
    id: "knight_plate",
    name: "Peitoral de placas",
    description: "Couraça de aço com tabardo azul.",
    set: "Cavaleiro",
    slot: "chest",
    bonusHp: 70,
    basicAttack: null,
    abilities: [
      ability({ id: "steel_wall", title: "Muralha de aço", description: "Escudo grande e duradouro.", aim: "self", cooldown: 22, castTime: 0.5, manaCost: 25, shield: 60, shieldSeconds: 6 }),
    ],
  },
  knight_greaves: {
    id: "knight_greaves",
    name: "Grevas do cavaleiro",
    description: "Botas de placas de aço.",
    set: "Cavaleiro",
    slot: "feet",
    bonusHp: 40,
    basicAttack: null,
    abilities: [
      ability({ id: "iron_stance", title: "Pés de ferro", description: "Firma os pés e recebe metade do dano por um tempo.", aim: "self", cooldown: 16, castTime: 0, manaCost: 15, damageReduction: 0.5, reductionSeconds: 4 }),
    ],
  },

  // --- Atirador (besta): dano médio constante de longe, vida baixa ----------------------------------------------
  ranger_crossbow: {
    id: "ranger_crossbow",
    name: "Besta de caça",
    description: "Besta leve de madeira escura. Tiros constantes de bem longe.",
    set: "Atirador",
    slot: "hand",
    bonusHp: 0,
    basicAttack: ability({ id: "crossbow_attack", title: "Ataque", description: "Virote no alvo.", aim: "target", range: 11, cooldown: 1.2, castTime: 1.2, damage: 10, releaseTime: 0.25 }),
    abilities: [
      ability({ id: "piercing_bolt", title: "Virote certeiro", description: "Virote muito rápido que acerta o primeiro no caminho.", aim: "direction", range: 16, radius: 0.4, cooldown: 5, castTime: 0.6, manaCost: 15, damage: 22, projectileSpeed: 26 }),
      ability({ id: "bolt_rain", title: "Chuva de virotes", description: "Dispara para o alto e os virotes caem numa área.", aim: "area", range: 13, radius: 2.5, cooldown: 10, castTime: 1, manaCost: 25, damage: 22 }),
      ability({ id: "quick_shot", title: "Tiro rápido", description: "Tiro quase instantâneo no alvo.", aim: "target", range: 12, cooldown: 6, castTime: 0.3, manaCost: 10, damage: 14, releaseTime: 0.1 }),
    ],
  },
  ranger_hood: {
    id: "ranger_hood",
    name: "Capuz do atirador",
    description: "Capuz verde de caçador.",
    set: "Atirador",
    slot: "head",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "bandage", title: "Curativo", description: "Faz um curativo rápido e recupera vida.", aim: "self", cooldown: 16, castTime: 1, manaCost: 15, heal: 25 }),
    ],
  },
  ranger_jerkin: {
    id: "ranger_jerkin",
    name: "Gibão de couro",
    description: "Gibão de couro com painéis verdes.",
    set: "Atirador",
    slot: "chest",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "leather_guard", title: "Couro reforçado", description: "Escudo que absorve dano por pouco tempo.", aim: "self", cooldown: 18, castTime: 0.2, manaCost: 20, shield: 35, shieldSeconds: 4 }),
    ],
  },
  ranger_boots: {
    id: "ranger_boots",
    name: "Botas de caçador",
    description: "Botas altas de couro para terreno difícil.",
    set: "Atirador",
    slot: "feet",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      // Fuga curta: Investida de 5 m (arrastar para trás para se afastar), mesma predição ([JOGO-07]).
      ability({ id: "roll", title: "Rolamento", description: "Rola alguns metros para fugir de perto.", aim: "direction", range: 5, radius: 0.6, cooldown: 9, castTime: 0, manaCost: 10, dashDistance: 5, dashSeconds: 0.25 }),
    ],
  },

  // --- Assassino (duas adagas): dano alto e rápido, recarga longa, vida baixa -----------------------------------
  assassin_daggers: {
    id: "assassin_daggers",
    name: "Adagas gêmeas",
    description: "Par de adagas curvas. Golpes rápidos e cartas fortes, mas que demoram a voltar.",
    set: "Assassino",
    slot: "hand",
    bonusHp: 0,
    basicAttack: ability({ id: "dagger_attack", title: "Ataque", description: "Golpe rápido de adaga no alvo.", aim: "target", range: 2.2, cooldown: 0.7, castTime: 0.7, damage: 8 }),
    abilities: [
      // Aproximação: Investida longa e curtíssima (toque = na direção do alvo fixo, [JOGO-07]).
      ability({ id: "shadow_leap", title: "Salto sombrio", description: "Salta até o inimigo num instante.", aim: "direction", range: 9, radius: 0.6, cooldown: 14, castTime: 0, manaCost: 10, dashDistance: 9, dashSeconds: 0.2 }),
      ability({ id: "backstab", title: "Apunhalar", description: "Golpe muito forte no alvo, de perto.", aim: "target", range: 2.5, cooldown: 14, castTime: 0.2, manaCost: 15, damage: 50 }),
      ability({ id: "blade_flurry", title: "Dança das lâminas", description: "Rodopia com as adagas e corta todos em volta.", aim: "area_self", radius: 2.5, cooldown: 16, castTime: 0.3, manaCost: 20, damage: 40 }),
    ],
  },
  assassin_hood: {
    id: "assassin_hood",
    name: "Capuz sombrio",
    description: "Capuz negro com máscara roxa.",
    set: "Assassino",
    slot: "head",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "evasion", title: "Evasão", description: "Esquiva de quase tudo por um instante (recebe bem menos dano).", aim: "self", cooldown: 20, castTime: 0, manaCost: 15, damageReduction: 0.6, reductionSeconds: 2.5 }),
    ],
  },
  assassin_vest: {
    id: "assassin_vest",
    name: "Colete sombrio",
    description: "Colete de couro negro com faixa roxa.",
    set: "Assassino",
    slot: "chest",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "smoke_veil", title: "Véu de fumaça", description: "Escudo curto que absorve um golpe forte.", aim: "self", cooldown: 20, castTime: 0.1, manaCost: 15, shield: 30, shieldSeconds: 3 }),
    ],
  },
  assassin_boots: {
    id: "assassin_boots",
    name: "Botas silenciosas",
    description: "Botas macias de tecido enrolado.",
    set: "Assassino",
    slot: "feet",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "shadow_step", title: "Passo sombrio", description: "Corre bem mais rápido por alguns segundos.", aim: "self", cooldown: 16, castTime: 0, manaCost: 10, speedMultiplier: 1.8, speedSeconds: 3 }),
    ],
  },

  // --- Curandeiro (livro): zero dano, cura média nos aliados, vida baixa ----------------------------------------
  healer_tome: {
    id: "healer_tome",
    name: "Livro sagrado",
    description: "Tomo branco com um sol dourado. Não causa dano: cura e protege os aliados.",
    set: "Curandeiro",
    slot: "hand",
    bonusHp: 0,
    // Ataque simples de cura: alvo fixo é um aliado, cura a cada lançamento ([JOGO-09]).
    basicAttack: ability({ id: "tome_attack", title: "Toque de luz", description: "Cura constante no aliado escolhido.", aim: "ally", range: 9, cooldown: 1.2, castTime: 1.2, heal: 8 }),
    abilities: [
      ability({ id: "greater_heal", title: "Cura maior", description: "Cura forte no aliado (sem alvo: em você).", aim: "ally", range: 10, cooldown: 8, castTime: 1, manaCost: 20, heal: 35 }),
      ability({ id: "healing_circle", title: "Círculo de cura", description: "Cura você e os aliados em volta.", aim: "area_self", radius: 5, cooldown: 12, castTime: 0.8, manaCost: 25, heal: 25 }),
      ability({ id: "holy_shield", title: "Escudo sagrado", description: "Escudo no aliado (sem alvo: em você).", aim: "ally", range: 10, cooldown: 14, castTime: 0.3, manaCost: 20, shield: 40, shieldSeconds: 5 }),
    ],
  },
  healer_circlet: {
    id: "healer_circlet",
    name: "Tiara da luz",
    description: "Tiara dourada com véu branco.",
    set: "Curandeiro",
    slot: "head",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "grace", title: "Graça", description: "Recebe menos dano por alguns segundos.", aim: "self", cooldown: 18, castTime: 0, manaCost: 15, damageReduction: 0.4, reductionSeconds: 4 }),
    ],
  },
  healer_robe: {
    id: "healer_robe",
    name: "Manto da luz",
    description: "Manto branco com faixa verde.",
    set: "Curandeiro",
    slot: "chest",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "aegis", title: "Égide", description: "Escudo em você e nos aliados em volta.", aim: "area_self", radius: 5, cooldown: 20, castTime: 0.4, manaCost: 25, shield: 25, shieldSeconds: 4 }),
    ],
  },
  healer_sandals: {
    id: "healer_sandals",
    name: "Sapatilhas da luz",
    description: "Sapatilhas leves de couro claro.",
    set: "Curandeiro",
    slot: "feet",
    bonusHp: 0,
    basicAttack: null,
    abilities: [
      ability({ id: "light_steps", title: "Passos leves", description: "Anda mais rápido por alguns segundos.", aim: "self", cooldown: 14, castTime: 0, manaCost: 10, speedMultiplier: 1.5, speedSeconds: 3 }),
    ],
  },
};

/** Item pelo id, ou `undefined` se não existe (ex.: dado antigo no banco). */
export function getItem(itemId: string): ItemDef | undefined {
  return Object.hasOwn(ITEMS, itemId) ? ITEMS[itemId] : undefined;
}

/** Peças de cada conjunto, na ordem arma, cabeça, peito, pés. */
export const MAGE_SET: readonly string[] = ["arcane_staff", "mage_hat", "mage_tunic", "mage_shoes"];
export const KNIGHT_SET: readonly string[] = ["knight_sword", "knight_helm", "knight_plate", "knight_greaves"];
export const RANGER_SET: readonly string[] = ["ranger_crossbow", "ranger_hood", "ranger_jerkin", "ranger_boots"];
export const ASSASSIN_SET: readonly string[] = ["assassin_daggers", "assassin_hood", "assassin_vest", "assassin_boots"];
export const HEALER_SET: readonly string[] = ["healer_tome", "healer_circlet", "healer_robe", "healer_sandals"];

/**
 * Conta nova "nasce pelada" (nada vestido, [JOGO-04]) com o treino e todos os conjuntos na mochila, para escolher o
 * que vestir.
 */
export const STARTER_BAG: readonly string[] = [
  "training_sword", "training_staff", "training_hood", "training_vest", "training_boots",
  ...MAGE_SET,
  ...KNIGHT_SET,
  ...RANGER_SET,
  ...ASSASSIN_SET,
  ...HEALER_SET,
];

/**
 * Presentes únicos para contas que já existiam: id do presente → itens que ela recebe na mochila (só os que ainda
 * não tem e só o que couber). O inventário guarda os ids já recebidos (`grants`) para não dar de novo.
 * Conta nova já nasce com todos marcados ({@link STARTER_BAG} tem tudo).
 */
export const GRANTS: Readonly<Record<string, readonly string[]>> = {
  sets_v1: [...MAGE_SET, ...KNIGHT_SET],
  sets_v2: [...RANGER_SET, ...ASSASSIN_SET, ...HEALER_SET],
};

/** `true` se a habilidade mexe no movimento (Investida, Disparada): vai pela fila de comandos ([JOGO-07]). */
export function isMovementAbility(ability: AbilityDef): boolean {
  return ability.dashDistance > 0 || ability.speedMultiplier > 0;
}

/** Passos de movimento que uma Investida dura (pelo menos 1). ATENÇÃO: mesma conta em mmo-client AbilityView.dash_steps. */
export function dashSteps(ability: AbilityDef): number {
  return Math.max(1, Math.round(ability.dashSeconds * TICK_RATE_HZ));
}

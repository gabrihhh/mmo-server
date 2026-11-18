/**
 * Atributos de melhoria dos itens (ferreiro, mmo-docs [JOGO-16]). Regras puras, sem banco nem rede.
 *
 * Cada nível de melhoria dá pontos num atributo do item (+1 num atributo novo, +2 num que ele já tem). Os pontos de
 * TUDO que está vestido somam e valem para o personagem inteiro ({@link attributeEffects}).
 *
 * Dois jeitos de crescer, porque o nível de melhoria **não tem teto**:
 * - **sem teto** (dano, cura, escudo, vida, mana, velocidade de ataque): +1% por ponto, somando;
 * - **com retorno decrescente** (defesa, recarga, crítico, roubo de vida): `1 − 1 / (1 + 0,005 × pontos)` — começa em
 *   ~0,5% por ponto e nunca chega a 100% (100 pontos ≈ 33%; 200 ≈ 50%; 600 = 75%).
 * Valores provisórios: acertar testando.
 */

/**
 * Atributos que um item pode ganhar no ferreiro.
 * ATENÇÃO: espelho dos nomes em mmo-client/scripts/items/item_attributes.gd (títulos e textos da tela).
 */
export const ATTRIBUTE_IDS = [
  "damage",
  "healing",
  "shield",
  "health",
  "mana",
  "defense",
  "cooldown",
  "crit",
  "attackSpeed",
  "lifesteal",
] as const;

/** Um atributo de melhoria. */
export type AttributeId = (typeof ATTRIBUTE_IDS)[number];

/** Pontos em cada atributo (sem chave = 0). */
export type AttributePoints = Readonly<Partial<Record<AttributeId, number>>>;

/** `true` se `value` é um {@link AttributeId}. */
export function isAttributeId(value: unknown): value is AttributeId {
  return typeof value === "string" && (ATTRIBUTE_IDS as readonly string[]).includes(value);
}

/** Atributos sem teto: quanto cada ponto soma (fração: 0,01 = +1%). */
export const LINEAR_PER_POINT = 0.01;

/** Atributos com retorno decrescente: constante de `1 − 1 / (1 + k × pontos)` (~0,5% por ponto no começo). */
export const DIMINISHING_K = 0.005;

/** Crítico: o golpe crítico dá este múltiplo do dano. */
export const CRIT_MULTIPLIER = 1.5;

/**
 * Atributos que cada conjunto aceita no ferreiro ("cada arma sobe diferente"). Item de conjunto fora da tabela =
 * {@link DEFAULT_SET_ATTRIBUTES}. Sem limite de quantos atributos um item junta: com o tempo pode ter todos os do
 * conjunto.
 */
export const SET_ATTRIBUTES: Readonly<Record<string, readonly AttributeId[]>> = {
  Mago: ["damage", "mana", "cooldown", "crit"],
  Cavaleiro: ["defense", "health", "damage", "lifesteal"],
  Atirador: ["damage", "attackSpeed", "crit"],
  Assassino: ["damage", "crit", "attackSpeed", "lifesteal"],
  Curandeiro: ["healing", "shield", "mana", "cooldown"],
};

/** Atributos de quem não está em {@link SET_ATTRIBUTES}. */
export const DEFAULT_SET_ATTRIBUTES: readonly AttributeId[] = ["damage", "health"];

/** Atributos que um item do conjunto `set` aceita. */
export function attributesForSet(set: string): readonly AttributeId[] {
  return SET_ATTRIBUTES[set] ?? DEFAULT_SET_ATTRIBUTES;
}

/** Efeito somado dos atributos de tudo que está vestido (frações; 0 = nada). */
export interface AttributeEffects {
  /** Multiplicador extra do dano que você causa (0,04 = +4%). */
  readonly damage: number;
  /** Multiplicador extra da cura. */
  readonly healing: number;
  /** Multiplicador extra do escudo que você dá. */
  readonly shield: number;
  /** Multiplicador extra da vida máxima. */
  readonly health: number;
  /** Multiplicador extra da mana máxima. */
  readonly mana: number;
  /** Fração do dano recebido que some (antes do escudo), 0 a <1. */
  readonly defense: number;
  /** Fração a menos no tempo de recarga das cartas, 0 a <1. */
  readonly cooldown: number;
  /** Chance (0 a <1) de cada golpe/dano seu ser crítico ({@link CRIT_MULTIPLIER}). */
  readonly crit: number;
  /** Velocidade extra do ataque simples (0,1 = 10% mais rápido: tempo ÷ 1,1). */
  readonly attackSpeed: number;
  /** Fração (0 a <1) do dano que você causa que volta como vida. */
  readonly lifesteal: number;
}

/** Nenhum atributo. */
export const NO_EFFECTS: AttributeEffects = {
  damage: 0,
  healing: 0,
  shield: 0,
  health: 0,
  mana: 0,
  defense: 0,
  cooldown: 0,
  crit: 0,
  attackSpeed: 0,
  lifesteal: 0,
};

/** Retorno decrescente: `1 − 1 / (1 + k × pontos)`. */
export function diminishing(points: number): number {
  return points <= 0 ? 0 : 1 - 1 / (1 + DIMINISHING_K * points);
}

/** Soma os pontos de várias listas (um por item vestido). */
export function sumPoints(lists: readonly AttributePoints[]): Record<AttributeId, number> {
  const total: Record<AttributeId, number> = {
    damage: 0,
    healing: 0,
    shield: 0,
    health: 0,
    mana: 0,
    defense: 0,
    cooldown: 0,
    crit: 0,
    attackSpeed: 0,
    lifesteal: 0,
  };
  for (const points of lists) {
    for (const id of ATTRIBUTE_IDS) total[id] += points[id] ?? 0;
  }
  return total;
}

/** Efeito dos pontos somados (ver as duas regras no topo do arquivo). */
export function attributeEffects(points: Readonly<Record<AttributeId, number>>): AttributeEffects {
  return {
    damage: points.damage * LINEAR_PER_POINT,
    healing: points.healing * LINEAR_PER_POINT,
    shield: points.shield * LINEAR_PER_POINT,
    health: points.health * LINEAR_PER_POINT,
    mana: points.mana * LINEAR_PER_POINT,
    attackSpeed: points.attackSpeed * LINEAR_PER_POINT,
    defense: diminishing(points.defense),
    cooldown: diminishing(points.cooldown),
    crit: diminishing(points.crit),
    lifesteal: diminishing(points.lifesteal),
  };
}

/** Lê pontos guardados no banco (não confiável): só atributos conhecidos, inteiros positivos. */
export function readPoints(raw: unknown): AttributePoints {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const points: Partial<Record<AttributeId, number>> = {};
  for (const id of ATTRIBUTE_IDS) {
    const value: unknown = Reflect.get(raw, id);
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) points[id] = value;
  }
  return points;
}

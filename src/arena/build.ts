import { ATTRIBUTE_IDS, attributesForSet, type AttributeId, type AttributePoints } from "../items/attributes.js";
import { EQUIP_SLOTS, ITEMS, type EquipSlot } from "../items/catalog.js";
import type { Inventory, ItemStack } from "../items/inventory.js";
import { NEW_ATTRIBUTE_POINTS, REINFORCE_POINTS } from "../items/upgrade.js";
import type { Progress } from "../progression/level.js";

/**
 * Build do Coliseu (mmo-docs [JOGO-28], plans/plan-1/spec.md seções 1–3). Regras puras (sem rede nem zona).
 *
 * Na arena **ninguém usa os próprios itens nem o próprio nível**: cada jogador escolhe um conjunto por slot (mão,
 * cabeça, peito, pés), entra no {@link ARENA_LEVEL} com o item **+0** do catálogo daquele conjunto e slot e, na
 * preparação, distribui {@link PREP_CHOICES} pontos peça → atributo do conjunto da peça (conta do Ferreiro: atributo
 * novo +1, repetido +2). Nada disso vai para a conta.
 */

/**
 * Modos do Coliseu. ATENÇÃO: espelho em mmo-client (tela do Coliseu); o texto vai no protocolo.
 */
export const COLOSSEUM_MODES = ["1x1", "2x2", "3x3"] as const;
/** Um modo do Coliseu. */
export type ColosseumMode = (typeof COLOSSEUM_MODES)[number];

/** `true` se `value` é um modo do Coliseu (dado da rede). */
export function isColosseumMode(value: unknown): value is ColosseumMode {
  return typeof value === "string" && (COLOSSEUM_MODES as readonly string[]).includes(value);
}

/** Papel no time, decidido pela mão: Curandeiro = `healer`, o resto = `dps`. */
export type ArenaRole = "dps" | "healer";

/** Quantos de cada papel cada time precisa, por modo: 1x1 = 1 DPS; 2x2 = 1 DPS + 1 healer; 3x3 = 2 DPS + 1 healer. */
export const TEAM_COMPOSITION: Readonly<Record<ColosseumMode, Readonly<Record<ArenaRole, number>>>> = {
  "1x1": { dps: 1, healer: 0 },
  "2x2": { dps: 1, healer: 1 },
  "3x3": { dps: 2, healer: 1 },
};

/** Jogadores por time no modo `mode`. */
export function teamSize(mode: ColosseumMode): number {
  const composition: Readonly<Record<ArenaRole, number>> = TEAM_COMPOSITION[mode];
  return composition.dps + composition.healer;
}

/** Nível de todo mundo na arena (vida/mana máximas e força pela conta desse nível, [JOGO-12]). */
export const ARENA_LEVEL = 20;

/** Conjuntos que dá para escolher na build (os do catálogo). ATENÇÃO: espelho na tela do Coliseu do mmo-client. */
export const ARENA_SETS = ["Mago", "Cavaleiro", "Atirador", "Assassino", "Curandeiro"] as const;
/** Um conjunto escolhível na build. */
export type ArenaSet = (typeof ARENA_SETS)[number];

/** Conjunto cuja arma faz o jogador ser o healer do time. */
export const HEALER_SET: ArenaSet = "Curandeiro";

/** `true` se `value` é um conjunto escolhível (dado da rede). */
export function isArenaSet(value: unknown): value is ArenaSet {
  return typeof value === "string" && (ARENA_SETS as readonly string[]).includes(value);
}

/** Build escolhida na fila: um conjunto por slot. */
export type ArenaBuild = Readonly<Record<EquipSlot, ArenaSet>>;

/** Papel de quem escolheu `build` (a mão decide). */
export function roleOf(build: ArenaBuild): ArenaRole {
  return build.hand === HEALER_SET ? "healer" : "dps";
}

/** `true` se o modo aceita esse papel (healer fora do 1x1). */
export function roleAllowed(mode: ColosseumMode, role: ArenaRole): boolean {
  return TEAM_COMPOSITION[mode][role] > 0;
}

/**
 * Item do catálogo do conjunto `set` no slot `slot` ("tier alto" = o único item que o catálogo tem por
 * conjunto/slot). Lança se não existir: os conjuntos de {@link ARENA_SETS} têm as 4 peças (teste garante).
 */
export function arenaItemId(set: ArenaSet, slot: EquipSlot): string {
  for (const item of Object.values(ITEMS)) if (item.set === set && item.slot === slot) return item.id;
  throw new Error(`catálogo sem item do conjunto ${set} no slot ${slot}`);
}

/** Atributos que a peça do slot `slot` aceita na preparação (os do conjunto dela, [JOGO-16]). */
export function slotAttributes(build: ArenaBuild, slot: EquipSlot): readonly AttributeId[] {
  return attributesForSet(build[slot]);
}

/** Escolhas da preparação de um jogador: quantas já usou e os pontos de cada peça. */
export interface ArenaPoints {
  /** Escolhas feitas (0 a {@link PREP_CHOICES}). */
  readonly used: number;
  /** Pontos de atributo de cada peça. */
  readonly attrs: Readonly<Record<EquipSlot, AttributePoints>>;
}

/** Escolhas da preparação por jogador. */
export const PREP_CHOICES = 20;

/** Ninguém escolheu nada ainda. */
export const NO_ARENA_POINTS: ArenaPoints = { used: 0, attrs: { hand: {}, head: {}, chest: {}, feet: {} } };

/** Por que uma escolha da preparação foi recusada. */
export type PrepPointFailure = "no_choices_left" | "invalid_attribute";

/** Resultado de uma escolha: pontos novos ou o motivo da recusa. */
export type PrepPointResult = { readonly ok: true; readonly points: ArenaPoints } | { readonly ok: false; readonly reason: PrepPointFailure };

/**
 * Uma escolha: +1 em `attribute` na peça `slot` se ela ainda não tem esse atributo, +2 se já tem (conta do Ferreiro,
 * {@link NEW_ATTRIBUTE_POINTS}/{@link REINFORCE_POINTS}). Recusa sem mudar nada se acabaram as escolhas ou se o
 * atributo não é do conjunto da peça. Não dá para desfazer.
 */
export function applyPrepPoint(points: ArenaPoints, build: ArenaBuild, slot: EquipSlot, attribute: AttributeId): PrepPointResult {
  if (points.used >= PREP_CHOICES) return { ok: false, reason: "no_choices_left" };
  if (!slotAttributes(build, slot).includes(attribute)) return { ok: false, reason: "invalid_attribute" };
  const current: number = points.attrs[slot][attribute] ?? 0;
  const piece: AttributePoints = { ...points.attrs[slot], [attribute]: current + (current > 0 ? REINFORCE_POINTS : NEW_ATTRIBUTE_POINTS) };
  return { ok: true, points: { used: points.used + 1, attrs: { ...points.attrs, [slot]: piece } } };
}

/**
 * Sobra do fim do minuto: sorteia cada escolha que faltou entre as peças e os atributos válidos (uma de cada vez,
 * com a mesma conta +1/+2). `random` = 0 a <1 (os testes passam um fixo).
 */
export function fillRemainingPoints(points: ArenaPoints, build: ArenaBuild, random: () => number): ArenaPoints {
  let current: ArenaPoints = points;
  while (current.used < PREP_CHOICES) {
    const slot: EquipSlot = pick(EQUIP_SLOTS, random);
    const attribute: AttributeId = pick(slotAttributes(build, slot), random);
    const result: PrepPointResult = applyPrepPoint(current, build, slot, attribute);
    if (!result.ok) break;
    current = result.points;
  }
  return current;
}

/** Um elemento sorteado de `list` (não vazia). */
function pick<T>(list: readonly T[], random: () => number): T {
  const value: T | undefined = list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  if (value === undefined) throw new Error("sorteio numa lista vazia");
  return value;
}

/** Prefixo dos uids dos itens de arena: nunca colidem com itens de verdade (que são hex aleatórios). */
export const ARENA_UID_PREFIX = "arena-";

/**
 * Inventário sintético da arena: em cada slot o item +0 do conjunto escolhido, com os pontos da preparação; mochila
 * vazia. Os helpers de sempre (`basicAttackOf`, `equippedAbilities`, `attributeEffectsOf`, `bonusHpOf`, `lookOf`)
 * funcionam nele. `level` fica 0 (sem brilho): só os `attrs` mudam.
 */
export function arenaInventory(build: ArenaBuild, points: ArenaPoints = NO_ARENA_POINTS): Inventory {
  const piece = (slot: EquipSlot): ItemStack => {
    const attrs: AttributePoints = points.attrs[slot];
    const hasAttrs: boolean = ATTRIBUTE_IDS.some((id) => (attrs[id] ?? 0) > 0);
    return { uid: `${ARENA_UID_PREFIX}${slot}`, itemId: arenaItemId(build[slot], slot), ...(hasAttrs ? { attrs } : {}) };
  };
  return { equipped: { hand: piece("hand"), head: piece("head"), chest: piece("chest"), feet: piece("feet") }, bag: [], grants: [] };
}

/** Progresso sintético da arena: nível {@link ARENA_LEVEL}, sem XP nem moedas (a verdade fica na conta). */
export const ARENA_PROGRESS: Progress = { level: ARENA_LEVEL, xp: 0, gold: 0 };

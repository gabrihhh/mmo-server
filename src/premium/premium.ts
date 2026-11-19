/**
 * Loja premium do Menu ([JOGO-27]): Diamantes (moeda comprada com dinheiro real) e o que eles compram. Regras puras
 * (sem banco nem rede): quem guarda a conta e responde é o `GameServer`.
 *
 * - **Diamantes** só entram por pacote ({@link PREMIUM_PACKS}). Hoje só existe a **compra de teste** (servidor com
 *   `PREMIUM_TEST_PURCHASES=1`, sem dinheiro); a compra real pela Google Play / App Store é a etapa 2 ([INFRA-14]).
 *   A 1ª compra de cada pacote vem em dobro.
 * - **Produtos** ({@link PREMIUM_PRODUCTS}): VIP, conveniência e poder. O Visual (tintas, aura, efeito no nome) e
 *   "+10 na mochila" / "trocar nome" ainda não existem (próxima leva).
 * - O estado fica na conta (`premium`, separado do `progress` que a zona grava a cada XP) e o servidor é a autoridade.
 * Preços em Diamantes provisórios (só o VIP, 300, foi aprovado pelo dono).
 */

/** Duração do VIP comprado: 30 dias, em ms. Comprar de novo soma ao que falta. */
export const VIP_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
/** Duração da poção de XP: 1 h, em ms. Comprar de novo soma ao que falta. */
export const XP_BOOST_DURATION_MS = 60 * 60 * 1000;
/** VIP: +20% de XP e de moedas dos monstros (soma com a poção). */
export const VIP_REWARD_BONUS = 0.2;
/** Poção de XP: ×2 na XP dos monstros (+100%, soma com o VIP: os dois = ×2,2). */
export const XP_BOOST_BONUS = 1;
/** Abas do Armazém a mais enquanto o VIP está ativo. */
export const VIP_STORAGE_TABS = 1;
/** Vagas de anúncio no Mercado a mais enquanto o VIP está ativo. */
export const VIP_MARKET_SLOTS = 5;
/** Vagas de anúncio a mais do produto permanente "+5 vagas no Mercado" (compra única). */
export const MARKET_SLOTS_PRODUCT = 5;
/** Quantas compras o histórico guarda (as mais novas). */
export const PREMIUM_HISTORY_LIMIT = 50;

/** Aba da Loja onde o produto aparece. ATENÇÃO: espelhado em mmo-client/scripts/ui/premium_shop_panel.gd. */
export type PremiumCategory = "vip" | "convenience" | "power";

/** Id dos produtos da Loja. ATENÇÃO: espelhado em mmo-client (ícones/descrição vêm do servidor, só o id é chave). */
export type PremiumProductId = "vip_30d" | "xp_boost_1h" | "upgrade_stone" | "death_protection" | "storage_tab" | "market_slots";

/** Um produto da Loja: preço em Diamantes e o texto da ficha. */
export interface PremiumProduct {
  readonly id: PremiumProductId;
  readonly category: PremiumCategory;
  readonly name: string;
  readonly description: string;
  /** Preço em Diamantes. */
  readonly price: number;
  /** `true` = só dá para comprar uma vez (fica "Comprado" depois). */
  readonly once: boolean;
}

/** Catálogo da Loja, na ordem da tela. */
export const PREMIUM_PRODUCTS: readonly PremiumProduct[] = [
  {
    id: "vip_30d",
    category: "vip",
    name: "VIP 30 dias",
    description: "+20% de XP e de moedas dos monstros, +1 aba no Armazém e +5 vagas no Mercado por 30 dias.",
    price: 300,
    once: false,
  },
  {
    id: "storage_tab",
    category: "convenience",
    name: "Aba do Armazém",
    description: "Mais uma aba de 20 espaços no Armazém, para sempre (sem gastar moedas).",
    price: 150,
    once: false,
  },
  {
    id: "market_slots",
    category: "convenience",
    name: "+5 vagas no Mercado",
    description: "Anuncie até 5 itens a mais no Mercado, para sempre.",
    price: 200,
    once: true,
  },
  {
    id: "xp_boost_1h",
    category: "power",
    name: "Poção de XP ×2",
    description: "Dobra a XP dos monstros por 1 hora (soma com o VIP).",
    price: 50,
    once: false,
  },
  {
    id: "upgrade_stone",
    category: "power",
    name: "Pedra de melhoria garantida",
    description: "Uma melhoria no ferreiro que não falha (você ainda paga as moedas). Só é gasta quando a chance é menor que 100%.",
    price: 80,
    once: false,
  },
  {
    id: "death_protection",
    category: "power",
    name: "Proteção da roleta",
    description: "Na próxima morte, a peça sorteada na roleta não quebra. Gasta uma por morte.",
    price: 30,
    once: false,
  },
];

/** Um pacote de Diamantes: quantos vêm e o preço (texto) na loja do celular. */
export interface PremiumPack {
  readonly id: string;
  readonly diamonds: number;
  /** Preço exibido. Na etapa 2 vem da loja do celular (moeda do país); hoje é o aprovado pelo dono em R$. */
  readonly priceLabel: string;
}

/** Pacotes de Diamantes (aprovados pelo dono, [JOGO-27]). A 1ª compra de cada um vem em dobro. */
export const PREMIUM_PACKS: readonly PremiumPack[] = [
  { id: "diamonds_100", diamonds: 100, priceLabel: "R$ 4,90" },
  { id: "diamonds_220", diamonds: 220, priceLabel: "R$ 9,90" },
  { id: "diamonds_600", diamonds: 600, priceLabel: "R$ 24,90" },
  { id: "diamonds_1300", diamonds: 1300, priceLabel: "R$ 49,90" },
  { id: "diamonds_2800", diamonds: 2800, priceLabel: "R$ 99,90" },
];

/** Uma linha do histórico de compras (Menu → Loja → Histórico; para o suporte). */
export interface PremiumHistoryEntry {
  /** Quando (ms, `Date.now()`). */
  readonly at: number;
  /** `pack` = comprou Diamantes; `product` = gastou Diamantes num produto. */
  readonly kind: "pack" | "product";
  /** Id do pacote ou do produto. */
  readonly id: string;
  /** Diamantes que entraram (positivo) ou saíram (negativo). */
  readonly diamonds: number;
  /** `true` = compra de teste (sem dinheiro). Só em `pack`. */
  readonly test: boolean;
}

/** O que a conta tem da Loja premium. Tempos em ms (`Date.now()`); 0 = nunca teve. */
export interface PremiumState {
  /** Saldo de Diamantes (inteiro, 0 ou mais). */
  readonly diamonds: number;
  /** Fim do VIP; ativo enquanto `vipUntil > agora`. */
  readonly vipUntil: number;
  /** Fim da poção de XP ×2. */
  readonly xpBoostUntil: number;
  /** Pedras de melhoria garantida guardadas. */
  readonly upgradeStones: number;
  /** Proteções da roleta da morte guardadas. */
  readonly deathProtections: number;
  /** Vagas de anúncio permanentes compradas (0 ou {@link MARKET_SLOTS_PRODUCT}). */
  readonly marketSlots: number;
  /** Pacotes já comprados alguma vez (a 1ª compra de cada um vem em dobro). */
  readonly packsBought: readonly string[];
  /** Compras, da mais nova para a mais velha (até {@link PREMIUM_HISTORY_LIMIT}). */
  readonly history: readonly PremiumHistoryEntry[];
}

/** Conta nova (ou antiga, sem o campo): nada da Loja. */
export const EMPTY_PREMIUM: PremiumState = {
  diamonds: 0,
  vipUntil: 0,
  xpBoostUntil: 0,
  upgradeStones: 0,
  deathProtections: 0,
  marketSlots: 0,
  packsBought: [],
  history: [],
};

/** Produto pelo id; `undefined` = não existe. */
export function getPremiumProduct(id: string): PremiumProduct | undefined {
  return PREMIUM_PRODUCTS.find((product) => product.id === id);
}

/** Pacote pelo id; `undefined` = não existe. */
export function getPremiumPack(id: string): PremiumPack | undefined {
  return PREMIUM_PACKS.find((pack) => pack.id === id);
}

/** `true` se o VIP está ativo em [nowMs]. */
export function isVip(state: PremiumState, nowMs: number): boolean {
  return state.vipUntil > nowMs;
}

/**
 * Multiplicadores da recompensa dos monstros em [nowMs]: VIP dá +20% na XP e nas moedas, a poção +100% na XP (somam:
 * VIP + poção = XP ×2,2, moedas ×1,2). Sem nada = 1 e 1.
 */
export function rewardMultipliers(state: PremiumState, nowMs: number): { readonly xp: number; readonly gold: number } {
  const vip: number = isVip(state, nowMs) ? VIP_REWARD_BONUS : 0;
  const boost: number = state.xpBoostUntil > nowMs ? XP_BOOST_BONUS : 0;
  return { xp: 1 + vip + boost, gold: 1 + vip };
}

/** Abas do Armazém a mais por causa do VIP em [nowMs] (os itens guardados ficam se o VIP acaba; só não cabe mais). */
export function bonusStorageTabs(state: PremiumState, nowMs: number): number {
  return isVip(state, nowMs) ? VIP_STORAGE_TABS : 0;
}

/** Vagas de anúncio a mais no Mercado em [nowMs]: as permanentes + as do VIP. */
export function bonusMarketSlots(state: PremiumState, nowMs: number): number {
  return state.marketSlots + (isVip(state, nowMs) ? VIP_MARKET_SLOTS : 0);
}

/** Põe [entry] no topo do histórico, cortando no limite. */
function withHistory(state: PremiumState, entry: PremiumHistoryEntry): readonly PremiumHistoryEntry[] {
  return [entry, ...state.history].slice(0, PREMIUM_HISTORY_LIMIT);
}

/** Resultado de comprar um pacote: estado novo e quantos Diamantes entraram (com o dobro da 1ª compra). */
export type PackResult =
  | { readonly ok: true; readonly state: PremiumState; readonly diamonds: number }
  | { readonly ok: false; readonly reason: "pack_not_found" };

/**
 * Credita o pacote [packId] (pagamento já confirmado — hoje, compra de teste). 1ª compra deste pacote = em dobro.
 * [test] = compra de teste (marcada no histórico).
 */
export function creditPack(state: PremiumState, packId: string, nowMs: number, test: boolean): PackResult {
  const pack: PremiumPack | undefined = getPremiumPack(packId);
  if (pack === undefined) return { ok: false, reason: "pack_not_found" };
  const first: boolean = !state.packsBought.includes(pack.id);
  const diamonds: number = first ? pack.diamonds * 2 : pack.diamonds;
  return {
    ok: true,
    diamonds,
    state: {
      ...state,
      diamonds: state.diamonds + diamonds,
      packsBought: first ? [...state.packsBought, pack.id] : state.packsBought,
      history: withHistory(state, { at: nowMs, kind: "pack", id: pack.id, diamonds, test }),
    },
  };
}

/** Motivo de recusa ao comprar um produto. */
export type PremiumFailure = "product_not_found" | "not_enough_diamonds" | "already_owned";

/**
 * Resultado de comprar um produto: estado novo e se ele dá uma aba do Armazém (`storageTab`: quem guarda o inventário
 * soma em `storageTabs`), ou o motivo.
 */
export type ProductResult =
  | { readonly ok: true; readonly state: PremiumState; readonly product: PremiumProduct; readonly storageTab: boolean }
  | { readonly ok: false; readonly reason: PremiumFailure };

/** Estende um tempo que acaba em [until] por [durationMs] a partir de agora ou do fim atual (o que vier depois). */
function extend(until: number, nowMs: number, durationMs: number): number {
  return Math.max(until, nowMs) + durationMs;
}

/** Compra o produto [productId] com os Diamantes de [state] e aplica o efeito. */
export function buyProduct(state: PremiumState, productId: string, nowMs: number): ProductResult {
  const product: PremiumProduct | undefined = getPremiumProduct(productId);
  if (product === undefined) return { ok: false, reason: "product_not_found" };
  if (product.id === "market_slots" && state.marketSlots > 0) return { ok: false, reason: "already_owned" };
  if (state.diamonds < product.price) return { ok: false, reason: "not_enough_diamonds" };
  const paid: PremiumState = {
    ...state,
    diamonds: state.diamonds - product.price,
    history: withHistory(state, { at: nowMs, kind: "product", id: product.id, diamonds: -product.price, test: false }),
  };
  const applied: PremiumState = applyProduct(paid, product.id, nowMs);
  return { ok: true, state: applied, product, storageTab: product.id === "storage_tab" };
}

/** Efeito de cada produto no estado (a aba do Armazém mexe no inventário, fora daqui). */
function applyProduct(state: PremiumState, id: PremiumProductId, nowMs: number): PremiumState {
  switch (id) {
    case "vip_30d":
      return { ...state, vipUntil: extend(state.vipUntil, nowMs, VIP_DURATION_MS) };
    case "xp_boost_1h":
      return { ...state, xpBoostUntil: extend(state.xpBoostUntil, nowMs, XP_BOOST_DURATION_MS) };
    case "upgrade_stone":
      return { ...state, upgradeStones: state.upgradeStones + 1 };
    case "death_protection":
      return { ...state, deathProtections: state.deathProtections + 1 };
    case "market_slots":
      return { ...state, marketSlots: MARKET_SLOTS_PRODUCT };
    case "storage_tab":
      return state;
  }
}

/** Gasta uma pedra de melhoria garantida; `null` = não tem. */
export function useUpgradeStone(state: PremiumState): PremiumState | null {
  return state.upgradeStones > 0 ? { ...state, upgradeStones: state.upgradeStones - 1 } : null;
}

/** Gasta uma proteção da roleta; `null` = não tem. */
export function useDeathProtection(state: PremiumState): PremiumState | null {
  return state.deathProtections > 0 ? { ...state, deathProtections: state.deathProtections - 1 } : null;
}

/** Inteiro seguro, 0 ou mais; outra coisa vira 0. */
function count(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

/** Lê uma linha do histórico guardada; estragada = `null`. */
function readHistoryEntry(raw: unknown): PremiumHistoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const at: unknown = Reflect.get(raw, "at");
  const kind: unknown = Reflect.get(raw, "kind");
  const id: unknown = Reflect.get(raw, "id");
  const diamonds: unknown = Reflect.get(raw, "diamonds");
  if (typeof at !== "number" || (kind !== "pack" && kind !== "product") || typeof id !== "string" || typeof diamonds !== "number") return null;
  return { at, kind, id, diamonds, test: Reflect.get(raw, "test") === true };
}

/** Lê o `premium` guardado na conta; ausente/estragado (conta antiga) = {@link EMPTY_PREMIUM}. */
export function readPremium(raw: unknown): PremiumState {
  if (typeof raw !== "object" || raw === null) return EMPTY_PREMIUM;
  const packs: unknown = Reflect.get(raw, "packsBought");
  const history: unknown = Reflect.get(raw, "history");
  return {
    diamonds: count(Reflect.get(raw, "diamonds")),
    vipUntil: count(Reflect.get(raw, "vipUntil")),
    xpBoostUntil: count(Reflect.get(raw, "xpBoostUntil")),
    upgradeStones: count(Reflect.get(raw, "upgradeStones")),
    deathProtections: count(Reflect.get(raw, "deathProtections")),
    marketSlots: Math.min(count(Reflect.get(raw, "marketSlots")), MARKET_SLOTS_PRODUCT),
    packsBought: Array.isArray(packs) ? packs.filter((id: unknown): id is string => typeof id === "string") : [],
    history: Array.isArray(history)
      ? history.map((entry: unknown) => readHistoryEntry(entry)).filter((entry): entry is PremiumHistoryEntry => entry !== null).slice(0, PREMIUM_HISTORY_LIMIT)
      : [],
  };
}

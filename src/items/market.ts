import { readPoints } from "./attributes.js";
import { getItem } from "./catalog.js";
import type { ItemStack } from "./inventory.js";

/**
 * Mercado global entre jogadores ([JOGO-25]): um só para o jogo inteiro. Anúncios ficam todos na memória do servidor
 * (como as guildas) e são gravados no banco a cada mudança (coleção `market`). Regras puras aqui; quem confere a
 * distância do Mercador, mexe nas moedas e na mochila é o `GameServer`. Como o servidor é um processo só e tudo isto
 * é síncrono, uma compra é decidida de uma vez: dois compradores ao mesmo tempo → só um leva.
 */

/** Taxa paga ao anunciar (0,05 = 5% do preço; decisão do dono, 2026-11-17). Volta ao cancelar/vencer. */
export const MARKET_FEE_RATE = 0.05;
/** Anúncios por jogador (ativos + vencidos ainda não retirados). */
export const MAX_LISTINGS = 10;
/** Quanto tempo (ms) o anúncio fica à venda: 7 dias. */
export const LISTING_DURATION_MS = 7 * 24 * 3600 * 1000;
/** Preço máximo (moedas). */
export const MAX_PRICE = 1_000_000_000;
/** Por quanto tempo (ms) uma venda fica no histórico de "Meus anúncios": 7 dias. */
export const SOLD_HISTORY_MS = 7 * 24 * 3600 * 1000;
/** Anúncios por página na busca. */
export const MARKET_PAGE_SIZE = 20;

/** Um anúncio, como fica no banco. */
export interface Listing {
  readonly id: string;
  readonly sellerId: string;
  readonly sellerName: string;
  /** O item inteiro (uid, nível, atributos), guardado pelo mercado enquanto está à venda. */
  readonly item: ItemStack;
  readonly price: number;
  /** Taxa paga ao anunciar (volta ao cancelar/retirar). */
  readonly fee: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Quando vendeu (`null` = não vendeu) e para quem. */
  readonly soldAt: number | null;
  readonly buyerName: string | null;
  /** O vendedor já foi avisado da venda (ao vivo ou ao entrar). */
  readonly notified: boolean;
}

/** Situação de um anúncio agora. */
export type ListingStatus = "active" | "expired" | "sold";

/** Ordem da busca. */
export type MarketSort = "price" | "new";

/** Taxa de anunciar por [price]: 5%, arredondada para cima, mínimo 1. */
export function listingFee(price: number): number {
  return Math.max(1, Math.ceil(price * MARKET_FEE_RATE));
}

/** Preço aceito: inteiro de 1 a {@link MAX_PRICE}. */
export function isValidPrice(price: number): boolean {
  return Number.isSafeInteger(price) && price >= 1 && price <= MAX_PRICE;
}

/** Situação de [listing] em [nowMs]. */
export function listingStatus(listing: Listing, nowMs: number): ListingStatus {
  if (listing.soldAt !== null) return "sold";
  return nowMs >= listing.expiresAt ? "expired" : "active";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Lê um anúncio do banco (não confiável); `null` se inválido ou de item que não existe mais. */
export function readListing(raw: unknown): Listing | null {
  if (!isRecord(raw)) return null;
  const { id, sellerId, sellerName, item, price, fee, createdAt, expiresAt, soldAt, buyerName, notified } = raw;
  if (typeof id !== "string" || typeof sellerId !== "string" || typeof sellerName !== "string") return null;
  if (!isRecord(item) || typeof item["uid"] !== "string" || typeof item["itemId"] !== "string" || getItem(item["itemId"]) === undefined) return null;
  if (!isNum(price) || !isNum(fee) || !isNum(createdAt) || !isNum(expiresAt)) return null;
  const stack: ItemStack = {
    uid: item["uid"],
    itemId: item["itemId"],
    ...(isNum(item["level"]) && item["level"] > 0 ? { level: item["level"] } : {}),
    ...(isRecord(item["attrs"]) ? { attrs: readPoints(item["attrs"]) } : {}),
    ...(isNum(item["xp"]) && item["xp"] > 0 ? { xp: item["xp"] } : {}),
  };
  return {
    id, sellerId, sellerName, item: stack, price, fee, createdAt, expiresAt,
    soldAt: isNum(soldAt) ? soldAt : null,
    buyerName: typeof buyerName === "string" ? buyerName : null,
    notified: notified === true,
  };
}

/** Onde o mercado grava (o `GameServer` liga no banco). */
export interface MarketHost {
  save(listing: Listing): void;
  remove(listingId: string): void;
}

/** Motivo de recusa no mercado. */
export type MarketFailure = "listing_gone" | "own_listing" | "too_many_listings" | "not_your_listing";

/** Todos os anúncios do jogo. */
export class Market {
  private readonly listings: Map<string, Listing> = new Map();
  private nextId: number = 1;

  constructor(private readonly host: MarketHost) {}

  /** Carrega do banco ao ligar o servidor. */
  load(listings: readonly Listing[]): void {
    for (const listing of listings) this.listings.set(listing.id, listing);
  }

  /** O anúncio [id], ou `undefined`. */
  get(id: string): Listing | undefined {
    return this.listings.get(id);
  }

  /** Quantos anúncios de [sellerId] contam no limite (ativos + vencidos não retirados). */
  openCount(sellerId: string): number {
    let count: number = 0;
    for (const listing of this.listings.values()) if (listing.sellerId === sellerId && listing.soldAt === null) count++;
    return count;
  }

  /**
   * Anuncia [item] de [sellerId] por [price] (taxa [fee] já paga). Recusa se passou do limite de anúncios.
   * Quem chama já tirou o item da mochila.
   */
  create(sellerId: string, sellerName: string, item: ItemStack, price: number, fee: number, nowMs: number): Listing | MarketFailure {
    if (this.openCount(sellerId) >= MAX_LISTINGS) return "too_many_listings";
    const id: string = `${nowMs.toString(36)}-${(this.nextId++).toString(36)}-${item.uid}`;
    const listing: Listing = {
      id, sellerId, sellerName, item, price, fee, createdAt: nowMs, expiresAt: nowMs + LISTING_DURATION_MS, soldAt: null, buyerName: null, notified: false,
    };
    this.listings.set(id, listing);
    this.host.save(listing);
    return listing;
  }

  /**
   * Busca os anúncios ATIVOS: [query] no nome do item ou do conjunto (sem diferenciar maiúsculas), [slot] opcional,
   * ordem [sort] (preço crescente ou mais novos), página [page] (0 = primeira).
   */
  search(query: string, slot: string | null, sort: MarketSort, page: number, nowMs: number): { readonly listings: Listing[]; readonly total: number } {
    const wanted: string = query.trim().toLowerCase();
    const found: Listing[] = [...this.listings.values()].filter((listing) => {
      if (listingStatus(listing, nowMs) !== "active") return false;
      const def = getItem(listing.item.itemId);
      if (def === undefined || (slot !== null && def.slot !== slot)) return false;
      return wanted.length === 0 || def.name.toLowerCase().includes(wanted) || def.set.toLowerCase().includes(wanted);
    });
    found.sort((a, b) => (sort === "price" ? a.price - b.price || b.createdAt - a.createdAt : b.createdAt - a.createdAt));
    const start: number = Math.max(0, Math.floor(page)) * MARKET_PAGE_SIZE;
    return { listings: found.slice(start, start + MARKET_PAGE_SIZE), total: found.length };
  }

  /** Anúncios de [sellerId]: ativos e vencidos, e as vendas dos últimos 7 dias (mais novos primeiro). */
  mine(sellerId: string, nowMs: number): Listing[] {
    return [...this.listings.values()]
      .filter((listing) => listing.sellerId === sellerId && (listing.soldAt === null || nowMs - listing.soldAt < SOLD_HISTORY_MS))
      .sort((a, b) => (b.soldAt ?? b.createdAt) - (a.soldAt ?? a.createdAt));
  }

  /**
   * Compra o anúncio [id] ATIVO por [buyerId]: marca como vendido na hora (quem vier depois recebe `listing_gone`).
   * Quem chama já conferiu e cobrou as moedas do comprador e o espaço na mochila.
   */
  buy(id: string, buyerId: string, buyerName: string, nowMs: number): Listing | MarketFailure {
    const listing: Listing | undefined = this.listings.get(id);
    if (listing === undefined || listingStatus(listing, nowMs) !== "active") return "listing_gone";
    if (listing.sellerId === buyerId) return "own_listing";
    const sold: Listing = { ...listing, soldAt: nowMs, buyerName };
    this.listings.set(id, sold);
    this.host.save(sold);
    return sold;
  }

  /** Confere se [sellerId] pode tirar o anúncio [id] (ativo = cancelar; vencido = retirar). Não tira. */
  canWithdraw(id: string, sellerId: string): Listing | MarketFailure {
    const listing: Listing | undefined = this.listings.get(id);
    if (listing === undefined || listing.soldAt !== null) return "listing_gone";
    if (listing.sellerId !== sellerId) return "not_your_listing";
    return listing;
  }

  /** Tira o anúncio [id] (cancelado/retirado: item e taxa voltam para quem chamou). */
  withdraw(id: string): void {
    if (this.listings.delete(id)) this.host.remove(id);
  }

  /** Vendas de [sellerId] ainda não avisadas; marca como avisadas. */
  takeUnnotifiedSales(sellerId: string): Listing[] {
    const sales: Listing[] = [];
    for (const listing of this.listings.values()) {
      if (listing.sellerId !== sellerId || listing.soldAt === null || listing.notified) continue;
      const done: Listing = { ...listing, notified: true };
      this.listings.set(listing.id, done);
      this.host.save(done);
      sales.push(done);
    }
    return sales;
  }

  /** Apaga as vendas mais velhas que {@link SOLD_HISTORY_MS} já avisadas. */
  prune(nowMs: number): void {
    for (const listing of [...this.listings.values()]) {
      if (listing.soldAt !== null && listing.notified && nowMs - listing.soldAt >= SOLD_HISTORY_MS) this.withdraw(listing.id);
    }
  }
}

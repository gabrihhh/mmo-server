import assert from "assert";

import { LISTING_DURATION_MS, MAX_LISTINGS, Market, isValidPrice, listingFee, listingStatus, readListing, type Listing } from "../src/items/market.js";

describe("mercado ([JOGO-25])", () => {
  const saved: Map<string, Listing> = new Map();
  const market = (): Market => {
    saved.clear();
    return new Market({ save: (l) => saved.set(l.id, l), remove: (id) => saved.delete(id) });
  };

  it("taxa de 5% para cima, mínimo 1; preço de 1 a 1 bilhão, inteiro", () => {
    assert.strictEqual(listingFee(1000), 50);
    assert.strictEqual(listingFee(1001), 51);
    assert.strictEqual(listingFee(3), 1);
    assert.ok(isValidPrice(1) && isValidPrice(1_000_000_000));
    assert.ok(!isValidPrice(0) && !isValidPrice(1.5) && !isValidPrice(1_000_000_001));
  });

  it("anuncia, busca por nome/conjunto e preço; compra só uma vez; não compra o próprio", () => {
    const m = market();
    const a = m.create("s", "Vendedor", { uid: "u1", itemId: "knight_sword", level: 4 }, 900, 45, 0);
    const b = m.create("s", "Vendedor", { uid: "u2", itemId: "mage_hat" }, 100, 5, 10);
    assert.ok(typeof a !== "string" && typeof b !== "string");
    assert.deepStrictEqual(m.search("", null, "price", 0, 20).listings.map((l) => l.item.uid), ["u2", "u1"]);
    assert.deepStrictEqual(m.search("cavaleiro", null, "price", 0, 20).listings.map((l) => l.item.uid), ["u1"]);
    assert.deepStrictEqual(m.search("", "head", "new", 0, 20).listings.map((l) => l.item.uid), ["u2"]);
    assert.strictEqual(m.buy(a.id, "s", "Vendedor", 30), "own_listing");
    const sold = m.buy(a.id, "c", "Comprador", 30);
    assert.ok(typeof sold !== "string" && sold.buyerName === "Comprador");
    assert.strictEqual(m.buy(a.id, "d", "Outro", 31), "listing_gone", "segundo comprador não leva");
    assert.strictEqual(saved.get(a.id)?.soldAt, 30);
    assert.deepStrictEqual(m.takeUnnotifiedSales("s").map((l) => l.id), [a.id]);
    assert.deepStrictEqual(m.takeUnnotifiedSales("s"), []);
  });

  it("limite de 10 anúncios; vence em 7 dias (sai da busca) e pode ser retirado só pelo dono", () => {
    const m = market();
    for (let i = 0; i < MAX_LISTINGS; i++) assert.ok(typeof m.create("s", "V", { uid: `u${i}`, itemId: "mage_hat" }, 10, 1, 0) !== "string");
    assert.strictEqual(m.create("s", "V", { uid: "x", itemId: "mage_hat" }, 10, 1, 0), "too_many_listings");
    const first = m.mine("s", 0)[0];
    assert.ok(first !== undefined);
    assert.strictEqual(listingStatus(first, LISTING_DURATION_MS), "expired");
    assert.strictEqual(m.search("", null, "new", 0, LISTING_DURATION_MS).total, 0);
    assert.strictEqual(m.canWithdraw(first.id, "outro"), "not_your_listing");
    assert.ok(typeof m.canWithdraw(first.id, "s") !== "string");
    m.withdraw(first.id);
    assert.ok(!saved.has(first.id));
    assert.strictEqual(m.openCount("s"), MAX_LISTINGS - 1);
  });

  it("lê do banco; item que não existe mais some", () => {
    const ok = readListing({ id: "a", sellerId: "s", sellerName: "V", item: { uid: "u", itemId: "mage_hat", level: 2 }, price: 5, fee: 1, createdAt: 0, expiresAt: 9, soldAt: null, buyerName: null, notified: false });
    assert.strictEqual(ok?.item.level, 2);
    assert.strictEqual(readListing({ id: "a", sellerId: "s", sellerName: "V", item: { uid: "u", itemId: "nao_existe" }, price: 5, fee: 1, createdAt: 0, expiresAt: 9 }), null);
  });
});

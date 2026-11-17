import assert from "assert";

import { BAG_CAPACITY, starterInventory, type Inventory } from "../src/items/inventory.js";
import { buyItem, sellItem, sellPrice } from "../src/items/shop.js";

describe("loja do ferreiro ([JOGO-23])", () => {
  it("preço de venda: 20% da compra + 25% do custo de melhoria até o nível", () => {
    assert.strictEqual(sellPrice({ uid: "a", itemId: "knight_sword" }), 100);
    assert.strictEqual(sellPrice({ uid: "a", itemId: "knight_sword", level: 5 }), 176);
    assert.strictEqual(sellPrice({ uid: "a", itemId: "training_sword" }), 20);
  });

  it("compra põe item +0 no fim da mochila e cobra; recusa sem moedas ou mochila cheia", () => {
    const inv: Inventory = starterInventory();
    const bought = buyItem(inv, "knight_sword", 600);
    assert.ok(bought.ok);
    assert.strictEqual(bought.goldDelta, -500);
    assert.strictEqual(bought.inventory.bag.at(-1)?.itemId, "knight_sword");
    assert.strictEqual(bought.inventory.bag.at(-1)?.level, undefined);
    const poor = buyItem(inv, "knight_sword", 499);
    assert.ok(!poor.ok && poor.reason === "not_enough_gold");
    const full: Inventory = { ...inv, bag: Array.from({ length: BAG_CAPACITY }, (_, i) => ({ uid: `b${i}`, itemId: "training_hood" })) };
    const noRoom = buyItem(full, "knight_sword", 1000);
    assert.ok(!noRoom.ok && noRoom.reason === "bag_full");
    const unknown = buyItem(inv, "nao_existe", 1000);
    assert.ok(!unknown.ok && unknown.reason === "item_not_found");
  });

  it("venda tira da mochila e paga; item vestido não vende", () => {
    const inv: Inventory = {
      ...starterInventory(),
      equipped: { hand: { uid: "w", itemId: "training_sword" }, head: null, chest: null, feet: null },
      bag: [{ uid: "s", itemId: "knight_sword", level: 5 }],
    };
    const sold = sellItem(inv, "s");
    assert.ok(sold.ok);
    assert.strictEqual(sold.goldDelta, 176);
    assert.strictEqual(sold.inventory.bag.length, 0);
    const worn = sellItem(inv, "w");
    assert.ok(!worn.ok && worn.reason === "item_equipped");
    const missing = sellItem(inv, "x");
    assert.ok(!missing.ok && missing.reason === "item_not_found");
  });
});

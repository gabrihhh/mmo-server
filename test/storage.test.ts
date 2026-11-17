import assert from "assert";

import { BAG_CAPACITY, readInventory, starterInventory, type Inventory } from "../src/items/inventory.js";
import { buyStorageTab, putInStorage, storageCapacity, storageTabCost, takeFromStorage, STORAGE_TAB_SIZE } from "../src/items/storage.js";
import { inventoryView } from "../src/items/view.js";

describe("armazém ([JOGO-26])", () => {
  const base = (): Inventory => ({
    ...starterInventory(),
    equipped: { hand: { uid: "w", itemId: "training_sword" }, head: null, chest: null, feet: null },
    bag: [{ uid: "a", itemId: "knight_sword", level: 3 }],
  });

  it("guarda da mochila e tira de volta; vestido não entra", () => {
    const put = putInStorage(base(), "a");
    assert.ok(put.ok);
    assert.strictEqual(put.inventory.bag.length, 0);
    assert.strictEqual(put.inventory.storage?.[0]?.level, 3, "guarda o item inteiro (nível)");
    const take = takeFromStorage(put.inventory, "a");
    assert.ok(take.ok);
    assert.strictEqual(take.inventory.bag[0]?.uid, "a");
    assert.strictEqual(take.inventory.storage?.length, 0);
    const worn = putInStorage(base(), "w");
    assert.ok(!worn.ok && worn.reason === "item_equipped");
  });

  it("20 espaços por aba; cheio recusa; mochila cheia não deixa tirar", () => {
    const full: Inventory = { ...base(), storage: Array.from({ length: STORAGE_TAB_SIZE }, (_, i) => ({ uid: `s${i}`, itemId: "training_hood" })) };
    const refused = putInStorage(full, "a");
    assert.ok(!refused.ok && refused.reason === "storage_full");
    const bagFull: Inventory = { ...full, bag: Array.from({ length: BAG_CAPACITY }, (_, i) => ({ uid: `b${i}`, itemId: "training_hood" })) };
    const noRoom = takeFromStorage(bagFull, "s0");
    assert.ok(!noRoom.ok && noRoom.reason === "bag_full");
  });

  it("aba nova: 5.000 e +50% a cada compra; sem moedas recusa", () => {
    assert.deepStrictEqual([0, 1, 2, 3].map(storageTabCost), [5000, 7500, 11250, 16875]);
    const poor = buyStorageTab(base(), 4999);
    assert.ok(!poor.ok && poor.reason === "not_enough_gold");
    const bought = buyStorageTab(base(), 5000);
    assert.ok(bought.ok);
    assert.strictEqual(bought.goldDelta, -5000);
    assert.strictEqual(storageCapacity(bought.inventory), 40);
    const view = inventoryView(bought.inventory);
    assert.strictEqual(view.storageCapacity, 40);
    assert.strictEqual(view.storageTabCost, 7500);
  });

  it("lê do banco: armazém e abas sobrevivem; conta antiga = vazio", () => {
    const saved = readInventory({ equipped: {}, bag: [], grants: [], storage: [{ uid: "x", itemId: "mage_hat", level: 2 }, { uid: "y", itemId: "nao_existe" }], storageTabs: 2 });
    assert.deepStrictEqual(saved.storage?.map((stack) => stack.uid), ["x"]);
    assert.strictEqual(saved.storageTabs, 2);
    const old = readInventory({ equipped: {}, bag: [], grants: [] });
    assert.strictEqual(old.storage, undefined);
    assert.strictEqual(storageCapacity(old), 20);
  });
});

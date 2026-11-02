import assert from "assert";

import { BAG_CAPACITY, equip, readInventory, starterInventory, unequip, type Inventory } from "../src/items/inventory.js";
import { ABILITIES_PER_SLOT, EQUIP_SLOTS, ITEMS } from "../src/items/catalog.js";
import { inventoryView } from "../src/items/view.js";

describe("catálogo e inventário", () => {
  it("cada item tem o número certo de habilidades do slot; só armas têm ataque simples", () => {
    for (const item of Object.values(ITEMS)) {
      assert.strictEqual(item.abilities.length, ABILITIES_PER_SLOT[item.slot], item.id);
      assert.strictEqual(item.basicAttack !== null, item.slot === "hand", item.id);
    }
  });

  it("conta nova: kit de treino vestido e cajado na mochila", () => {
    const inv: Inventory = starterInventory();
    for (const slot of EQUIP_SLOTS) assert.ok(inv.equipped[slot], slot);
    assert.strictEqual(inv.equipped.hand?.itemId, "training_sword");
    assert.deepStrictEqual(inv.bag.map((s) => s.itemId), ["training_staff"]);
  });

  it("equip troca direto: o item vestido volta para a mochila no lugar", () => {
    const inv: Inventory = starterInventory();
    const staff = inv.bag[0];
    assert.ok(staff);
    const result = equip(inv, staff.uid);
    assert.ok(result.ok);
    assert.strictEqual(result.inventory.equipped.hand?.uid, staff.uid);
    assert.deepStrictEqual(result.inventory.bag.map((s) => s.itemId), ["training_sword"]);
    assert.strictEqual(inv.equipped.hand?.itemId, "training_sword", "o original não muda");
  });

  it("recusas: item fora da mochila, slot vazio, mochila cheia", () => {
    const inv: Inventory = starterInventory();
    assert.deepStrictEqual(equip(inv, "nao-existe"), { ok: false, reason: "item_not_found" });
    const vested = inv.equipped.head;
    assert.ok(vested);
    assert.deepStrictEqual(equip(inv, vested.uid), { ok: false, reason: "item_not_found" }, "vestido não está na mochila");

    const off = unequip(inv, "head");
    assert.ok(off.ok);
    assert.strictEqual(off.inventory.equipped.head, null);
    assert.deepStrictEqual(unequip(off.inventory, "head"), { ok: false, reason: "slot_empty" });

    const full: Inventory = { ...inv, bag: Array.from({ length: BAG_CAPACITY }, (_, i) => ({ uid: `u${i}`, itemId: "training_staff" })) };
    assert.deepStrictEqual(unequip(full, "feet"), { ok: false, reason: "bag_full" });
  });

  it("readInventory: sem dado → inicial; item desconhecido some; slot errado vai para a mochila", () => {
    assert.strictEqual(readInventory(undefined).equipped.hand?.itemId, "training_sword");
    const inv: Inventory = readInventory({
      equipped: { hand: { uid: "a", itemId: "training_boots" }, head: { uid: "b", itemId: "item_apagado" }, chest: null },
      bag: [{ uid: "c", itemId: "training_staff" }, { lixo: true }],
    });
    assert.strictEqual(inv.equipped.hand, null);
    assert.strictEqual(inv.equipped.head, null);
    assert.deepStrictEqual(inv.bag.map((s) => s.uid), ["a", "c"]);
  });

  it("view: cartas da arma, ataque simples e o soco sem arma", () => {
    const view = inventoryView(starterInventory());
    assert.deepStrictEqual(view.equipped.hand?.abilities.map((a) => a.title), ["Golpe forte", "Investida", "Giro"]);
    assert.strictEqual(view.equipped.hand?.basicAttack?.range, 2.5);
    assert.strictEqual(view.equipped.feet?.abilities[0]?.id, "sprint");
    assert.strictEqual(view.unarmedAttack.id, "punch");
    assert.strictEqual(view.equipped.feet?.abilities[0]?.cooldown, 12, "recarga vai para o cliente");
  });
});

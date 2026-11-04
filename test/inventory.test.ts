import assert from "assert";

import { BAG_CAPACITY, equip, readInventory, starterInventory, unequip, type Inventory, type ItemStack } from "../src/items/inventory.js";
import { ABILITIES_PER_SLOT, EQUIP_SLOTS, ITEMS, KNIGHT_SET, MAGE_SET, STARTER_BAG } from "../src/items/catalog.js";
import { inventoryView } from "../src/items/view.js";

describe("catálogo e inventário", () => {
  it("cada item tem o número certo de habilidades do slot; só armas têm ataque simples", () => {
    for (const item of Object.values(ITEMS)) {
      assert.strictEqual(item.abilities.length, ABILITIES_PER_SLOT[item.slot], item.id);
      assert.strictEqual(item.basicAttack !== null, item.slot === "hand", item.id);
    }
  });

  it("ids de habilidade são únicos no jogo inteiro (a recarga é guardada por id)", () => {
    const ids: string[] = Object.values(ITEMS).flatMap((item) => [
      ...(item.basicAttack === null ? [] : [item.basicAttack.id]),
      ...item.abilities.map((a) => a.id),
    ]);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("conta nova nasce pelada, com os três conjuntos na mochila", () => {
    const inv: Inventory = starterInventory();
    for (const slot of EQUIP_SLOTS) assert.strictEqual(inv.equipped[slot], null, slot);
    assert.deepStrictEqual(inv.bag.map((s) => s.itemId), [...STARTER_BAG]);
    assert.ok(inv.bag.length <= BAG_CAPACITY);
    assert.ok(MAGE_SET.every((id) => ITEMS[id] !== undefined) && KNIGHT_SET.every((id) => ITEMS[id] !== undefined));
  });

  /** Inventário com a espada vestida e o cajado na mochila. */
  function swordAndStaff(): Inventory {
    return {
      equipped: { hand: { uid: "s", itemId: "training_sword" }, head: { uid: "h", itemId: "training_hood" }, chest: null, feet: { uid: "f", itemId: "training_boots" } },
      bag: [{ uid: "st", itemId: "training_staff" }],
      grants: ["sets_v1"],
    };
  }

  it("equip troca direto: o item vestido volta para a mochila no lugar", () => {
    const inv: Inventory = swordAndStaff();
    const result = equip(inv, "st");
    assert.ok(result.ok);
    assert.strictEqual(result.inventory.equipped.hand?.uid, "st");
    assert.deepStrictEqual(result.inventory.bag.map((s) => s.itemId), ["training_sword"]);
    assert.strictEqual(inv.equipped.hand?.itemId, "training_sword", "o original não muda");
  });

  it("equip em slot vazio tira o item da mochila", () => {
    const inv: Inventory = starterInventory();
    const plate: ItemStack | undefined = inv.bag.find((s) => s.itemId === "knight_plate");
    assert.ok(plate);
    const result = equip(inv, plate.uid);
    assert.ok(result.ok);
    assert.strictEqual(result.inventory.equipped.chest?.uid, plate.uid);
    assert.strictEqual(result.inventory.bag.length, inv.bag.length - 1);
  });

  it("recusas: item fora da mochila, slot vazio, mochila cheia", () => {
    const inv: Inventory = swordAndStaff();
    assert.deepStrictEqual(equip(inv, "nao-existe"), { ok: false, reason: "item_not_found" });
    assert.deepStrictEqual(equip(inv, "h"), { ok: false, reason: "item_not_found" }, "vestido não está na mochila");

    const off = unequip(inv, "head");
    assert.ok(off.ok);
    assert.strictEqual(off.inventory.equipped.head, null);
    assert.deepStrictEqual(unequip(off.inventory, "head"), { ok: false, reason: "slot_empty" });

    const full: Inventory = { ...inv, bag: Array.from({ length: BAG_CAPACITY }, (_, i) => ({ uid: `u${i}`, itemId: "training_staff" })) };
    assert.deepStrictEqual(unequip(full, "feet"), { ok: false, reason: "bag_full" });
  });

  it("readInventory: sem dado → inicial; item desconhecido some; slot errado vai para a mochila", () => {
    assert.strictEqual(readInventory(undefined).equipped.hand, null);
    const inv: Inventory = readInventory({
      equipped: { hand: { uid: "a", itemId: "training_boots" }, head: { uid: "b", itemId: "item_apagado" }, chest: null },
      bag: [{ uid: "c", itemId: "training_staff" }, { lixo: true }],
      grants: ["sets_v1"],
    });
    assert.strictEqual(inv.equipped.hand, null);
    assert.strictEqual(inv.equipped.head, null);
    assert.deepStrictEqual(inv.bag.map((s) => s.uid), ["a", "c"]);
  });

  it("conta antiga (sem grants) recebe uma vez os conjuntos novos que ainda não tem, com uid fixo", () => {
    const old = { equipped: { hand: { uid: "a", itemId: "knight_sword" } }, bag: [{ uid: "c", itemId: "training_staff" }] };
    const inv: Inventory = readInventory(old);
    assert.deepStrictEqual(inv.grants, ["sets_v1"]);
    const given: string[] = inv.bag.slice(1).map((s) => s.itemId);
    assert.deepStrictEqual(given, [...MAGE_SET, ...KNIGHT_SET].filter((id) => id !== "knight_sword"), "não duplica o que já tem");
    assert.deepStrictEqual(readInventory(old).bag, inv.bag, "ler de novo antes de salvar dá os mesmos uids");
    assert.deepStrictEqual(readInventory(inv).bag, inv.bag, "depois de salvo não dá de novo");

    const nearlyFull = { equipped: {}, bag: Array.from({ length: BAG_CAPACITY - 2 }, (_, i) => ({ uid: `u${i}`, itemId: "training_staff" })) };
    assert.strictEqual(readInventory(nearlyFull).bag.length, BAG_CAPACITY, "só o que couber");
  });

  it("view: cartas da arma, ataque simples e o soco sem arma", () => {
    const view = inventoryView(swordAndStaff());
    assert.deepStrictEqual(view.equipped.hand?.abilities.map((a) => a.title), ["Golpe forte", "Investida", "Giro"]);
    assert.strictEqual(view.equipped.hand?.basicAttack?.range, 2.5);
    assert.strictEqual(view.equipped.feet?.abilities[0]?.id, "sprint");
    assert.strictEqual(view.unarmedAttack.id, "punch");
    assert.strictEqual(view.equipped.feet?.abilities[0]?.cooldown, 12, "recarga vai para o cliente");
    assert.strictEqual(view.equipped.hand?.basicAttack?.castTime, 1, "lançamento vai para o cliente");
    assert.strictEqual(view.equipped.hand?.abilities[0]?.damage, 25, "dano vai para a ficha do item");
    assert.strictEqual(view.equipped.hand?.set, "Treino");
    assert.ok(view.equipped.head?.description);
  });
});

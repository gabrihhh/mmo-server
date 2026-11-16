import assert from "assert";

import { attributesForSet } from "../src/items/attributes.js";
import { ZERO_ITEM_XP, addItemXp, fuseItems, itemXp, levelXp } from "../src/items/fusion.js";
import { readInventory, type Inventory, type ItemStack } from "../src/items/inventory.js";
import { upgradeCost } from "../src/items/upgrade.js";

const always = (): number => 0;

/** Item `itemId` no nível `level` (sem atributos). */
const stack = (uid: string, itemId: string, level: number, xp?: number): ItemStack => ({
  uid,
  itemId,
  ...(level > 0 ? { level, attrs: {} } : {}),
  ...(xp !== undefined ? { xp } : {}),
});

const inventory = (bag: ItemStack[], hand: ItemStack | null = null): Inventory => ({
  equipped: { hand, head: null, chest: null, feet: null },
  bag,
  grants: [],
});

/** Fusão no ferreiro ([JOGO-20]). */
describe("fusão de itens", () => {
  it("cada nível pede a curva do preço de melhorar; um item carrega a experiência dos níveis que subiu", () => {
    assert.strictEqual(levelXp(9), upgradeCost(9));
    assert.strictEqual(itemXp(stack("a", "assassin_daggers", 3)), levelXp(0) + levelXp(1) + levelXp(2));
    assert.strictEqual(itemXp(stack("a", "assassin_daggers", 2, 10)), levelXp(0) + levelXp(1) + 10, "soma a juntada");
    assert.strictEqual(itemXp(stack("a", "assassin_daggers", 0)), ZERO_ITEM_XP, "+0 vazio vale metade de um nível");
    assert.strictEqual(ZERO_ITEM_XP, levelXp(0) / 2);
  });

  it("o exemplo do dono: adaga +3 numa +9 sobe menos de 3 níveis (vira +10 e guarda a sobra)", () => {
    const inv = inventory([stack("main", "assassin_daggers", 9), stack("food", "assassin_daggers", 3)]);
    const result = fuseItems(inv, "main", "food", always);
    assert.ok(result.ok);
    const given: number = levelXp(0) + levelXp(1) + levelXp(2);
    assert.strictEqual(result.xpGained, given);
    assert.strictEqual(result.levelsGained, 1);
    assert.strictEqual(result.stack.level, 10);
    assert.strictEqual(result.stack.xp, given - levelXp(9), "a sobra fica guardada no item");
    assert.ok((result.stack.xp ?? 0) < levelXp(10));
    assert.deepStrictEqual(result.inventory.bag.map((s) => s.uid), ["main"], "o sacrificado some");
  });

  it("experiência sobrando sobe vários níveis, cada um com um atributo do conjunto", () => {
    const grown = addItemXp(stack("a", "arcane_staff", 0), levelXp(0) + levelXp(1) + levelXp(2) + 1, () => 0.5);
    assert.strictEqual(grown.levelsGained, 3);
    assert.strictEqual(grown.stack.level, 3);
    assert.strictEqual(grown.stack.xp, 1);
    const allowed = attributesForSet("Mago") as readonly string[];
    const total: number = Object.entries(grown.stack.attrs ?? {}).reduce((sum, [key, value]) => {
      assert.ok(allowed.includes(key));
      return sum + (value ?? 0);
    }, 0);
    // 3 níveis: +1 no primeiro, +2 nos que repetem o mesmo atributo (o sorteador fixo escolhe sempre o mesmo).
    assert.strictEqual(total, 1 + 2 + 2);
  });

  it("só o mesmo item; o sacrificado tem que estar na mochila (vestido não); o principal pode estar vestido", () => {
    const inv = inventory([stack("food", "assassin_daggers", 2), stack("other", "knight_sword", 2)], stack("worn", "assassin_daggers", 4));
    assert.deepStrictEqual(fuseItems(inv, "worn", "other", always), { ok: false, reason: "not_same_item" });
    assert.deepStrictEqual(fuseItems(inv, "food", "worn", always), { ok: false, reason: "material_equipped" });
    assert.deepStrictEqual(fuseItems(inv, "worn", "worn", always), { ok: false, reason: "item_not_found" });
    assert.deepStrictEqual(fuseItems(inv, "nada", "food", always), { ok: false, reason: "item_not_found" });
    const result = fuseItems(inv, "worn", "food", always);
    assert.ok(result.ok);
    assert.strictEqual(result.inventory.equipped.hand?.uid, "worn", "continua vestido");
    assert.ok((result.inventory.equipped.hand?.xp ?? 0) > 0 || (result.inventory.equipped.hand?.level ?? 0) > 4);
  });

  it("a experiência guardada vai para o banco e volta", () => {
    const back: Inventory = readInventory(JSON.parse(JSON.stringify(inventory([stack("a", "assassin_daggers", 2, 37.5)]))));
    assert.strictEqual(back.bag[0]?.xp, 37.5);
    assert.strictEqual(readInventory(JSON.parse(JSON.stringify(inventory([stack("b", "assassin_daggers", 0)])))).bag[0]?.xp, undefined);
  });
});

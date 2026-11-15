import assert from "assert";

import { attributeEffects, diminishing, readPoints, sumPoints, NO_EFFECTS } from "../src/items/attributes.js";
import { attributeEffectsOf, readInventory, type Inventory } from "../src/items/inventory.js";
import { upgradeChance, upgradeCost, upgradeItem } from "../src/items/upgrade.js";
import { inventoryView } from "../src/items/view.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import type { Progress } from "../src/progression/level.js";

/** Membro falso: guarda o progresso salvo e os eventos do último snapshot. */
class Member implements ZoneMember {
  readonly name: string;
  saved: Progress | null = null;
  events: Array<Record<string, unknown>> = [];
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Reflect.get(decoded, "type") !== "snapshot") return;
    const events: unknown = Reflect.get(Reflect.get(decoded, "data") as object, "events");
    if (Array.isArray(events)) this.events.push(...events.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null));
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
}

/** Uma espada longa (Cavaleiro: defesa, vida, dano, roubo de vida) vestida e um cajado arcano na mochila. */
function inventory(): Inventory {
  return {
    equipped: { hand: { uid: "sword", itemId: "knight_sword" }, head: null, chest: null, feet: null },
    bag: [{ uid: "staff", itemId: "arcane_staff" }],
    grants: ["sets_v1", "sets_v2"],
  };
}

const SWORD: AbilityDef = ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK;

describe("ferreiro: melhoria de itens ([JOGO-16])", () => {
  it("preço: 50 no +0 e 10% a mais por nível; chance: 100% até o +5, depois × 0,9 por nível, piso de 1%", () => {
    assert.strictEqual(upgradeCost(0), 50);
    assert.strictEqual(upgradeCost(1), 55);
    assert.strictEqual(upgradeCost(10), 130);
    assert.strictEqual(upgradeChance(0), 1);
    assert.strictEqual(upgradeChance(4), 1, "4 → 5 ainda é seguro");
    assert.ok(Math.abs(upgradeChance(5) - 0.9) < 1e-12, "5 → 6 = 90%");
    assert.ok(Math.abs(upgradeChance(9) - 0.9 ** 5) < 1e-12, "+10 ≈ 59%");
    assert.strictEqual(upgradeChance(500), 0.01, "nunca menos que 1%");
  });

  it("atributo novo dá +1, reforçar dá +2; sobe o nível; vale vestido e na mochila", () => {
    const first = upgradeItem(inventory(), "sword", "damage", 1000, 0);
    assert.ok(first.ok && first.success);
    assert.deepStrictEqual(first.inventory.equipped.hand, { uid: "sword", itemId: "knight_sword", level: 1, attrs: { damage: 1 } });
    const second = upgradeItem(first.inventory, "sword", "damage", 1000, 0);
    assert.ok(second.ok && second.success);
    assert.deepStrictEqual(second.stack.attrs, { damage: 3 });
    assert.strictEqual(second.stack.level, 2);
    assert.strictEqual(second.cost, upgradeCost(1));
    const third = upgradeItem(second.inventory, "sword", "defense", 1000, 0);
    assert.ok(third.ok);
    assert.deepStrictEqual(third.stack.attrs, { damage: 3, defense: 1 }, "sem limite de atributos");
    const bag = upgradeItem(inventory(), "staff", "crit", 1000, 0);
    assert.ok(bag.ok && bag.success);
    assert.strictEqual(bag.inventory.bag[0]?.level, 1);
  });

  it("falha: cobra, mas item e nível ficam iguais; recusas não cobram", () => {
    const high: Inventory = { ...inventory(), equipped: { ...inventory().equipped, hand: { uid: "sword", itemId: "knight_sword", level: 9, attrs: { damage: 5 } } } };
    const failed = upgradeItem(high, "sword", "damage", 1000, 0.99);
    assert.ok(failed.ok && !failed.success);
    assert.strictEqual(failed.cost, upgradeCost(9));
    assert.strictEqual(failed.inventory, high, "nada mudou");
    assert.deepStrictEqual(upgradeItem(inventory(), "nada", "damage", 1000, 0), { ok: false, reason: "item_not_found" });
    assert.deepStrictEqual(upgradeItem(inventory(), "sword", "healing", 1000, 0), { ok: false, reason: "invalid_attribute" }, "cavaleiro não tem cura");
    assert.deepStrictEqual(upgradeItem(inventory(), "sword", "damage", 49, 0), { ok: false, reason: "not_enough_gold" });
  });

  it("atributos: +1% sem teto; defesa/recarga/crítico/roubo com retorno decrescente; soma do vestido", () => {
    assert.strictEqual(diminishing(0), 0);
    assert.ok(Math.abs(diminishing(200) - 0.5) < 1e-12);
    assert.ok(diminishing(100000) < 1);
    const effects = attributeEffects(sumPoints([{ damage: 3, crit: 200 }, { damage: 2 }]));
    assert.ok(Math.abs(effects.damage - 0.05) < 1e-12);
    assert.ok(Math.abs(effects.crit - 0.5) < 1e-12);
    assert.deepStrictEqual(readPoints({ damage: 2, crit: -1, foo: 3, mana: 1.5 }), { damage: 2 });
    const upgraded: Inventory = { ...inventory(), equipped: { ...inventory().equipped, hand: { uid: "sword", itemId: "knight_sword", level: 2, attrs: { health: 3 } } } };
    assert.ok(Math.abs(attributeEffectsOf(upgraded).health - 0.03) < 1e-12);
    assert.deepStrictEqual(attributeEffectsOf(inventory()), NO_EFFECTS);
  });

  it("banco e cliente: item +0 continua { uid, itemId }; melhorado guarda nível/atributos; a ficha leva preço e chance", () => {
    const read = readInventory({ equipped: { hand: { uid: "s", itemId: "knight_sword", level: 3, attrs: { damage: 5, foo: 1 } } }, bag: [{ uid: "b", itemId: "arcane_staff" }], grants: ["sets_v1", "sets_v2"] });
    assert.deepStrictEqual(read.equipped.hand, { uid: "s", itemId: "knight_sword", level: 3, attrs: { damage: 5 } });
    assert.deepStrictEqual(read.bag[0], { uid: "b", itemId: "arcane_staff" });
    const view = inventoryView(read).equipped.hand;
    assert.ok(view !== null);
    assert.strictEqual(view.level, 3);
    assert.deepStrictEqual(view.upgradeAttributes, ["defense", "health", "damage", "lifesteal"]);
    assert.strictEqual(view.upgradeCost, upgradeCost(3));
    assert.strictEqual(view.upgradeChance, 1);
  });
});

describe("ferreiro na zona e atributos no combate ([JOGO-16])", () => {
  const blacksmith: DummyConfig = { id: "blacksmith", name: "Ferreiro", x: 0, z: 0, behavior: { kind: "blacksmith" } };
  const bag: DummyConfig = { id: "bag", name: "Saco", x: 0, z: -1.5, behavior: { kind: "dummy" }, maxHp: 100000 };

  function zone(dummies: DummyConfig[]): Zone {
    return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies });
  }

  it("só melhora perto do ferreiro; cobra as moedas do progresso e salva", () => {
    const z = zone([blacksmith]);
    const near = new Member("near");
    const far = new Member("far");
    z.join(near, { x: 2, y: 0, z: 0, rotY: 0 }, SWORD, new Map(), undefined, 0, { level: 0, xp: 0, gold: 120 });
    z.join(far, { x: 20, y: 0, z: 0, rotY: 0 }, SWORD, new Map(), undefined, 0, { level: 0, xp: 0, gold: 120 });
    z.random = (): number => 0;
    assert.deepStrictEqual(z.upgradeItem("far", inventory(), "sword", "damage"), { ok: false, reason: "too_far" });
    const result = z.upgradeItem("near", inventory(), "sword", "damage");
    assert.ok(result.ok && result.success);
    assert.strictEqual(near.saved?.gold, 70, "120 − 50");
    const again = z.upgradeItem("near", result.inventory, "sword", "damage");
    assert.ok(again.ok);
    assert.strictEqual(near.saved?.gold, 15, "70 − 55");
    assert.deepStrictEqual(z.upgradeItem("near", again.inventory, "sword", "damage"), { ok: false, reason: "not_enough_gold" });
  });

  it("ferreiro não é alvo nem leva dano", () => {
    const z = zone([blacksmith]);
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 1.5, rotY: 0 }, SWORD);
    assert.strictEqual(z.setAttackTarget("a", "blacksmith"), "invalid_target");
    for (let i = 0; i < 40; i++) z.tick();
    assert.ok(!a.events.some((e) => e["type"] === "damage" && e["target"] === "blacksmith"));
  });

  it("dano e crítico aumentam o golpe (crit no evento)", () => {
    const plain = zone([bag]);
    const a = new Member("a");
    plain.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    plain.setAttackTarget("a", "bag");
    for (let i = 0; i < 40 && !a.events.some((e) => e["type"] === "damage"); i++) plain.tick();
    const base: unknown = a.events.find((e) => e["type"] === "damage")?.["amount"];
    assert.ok(typeof base === "number" && base > 0);

    const strong = zone([bag]);
    const b = new Member("b");
    strong.random = (): number => 0; // sempre crítico
    strong.join(b, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD, new Map(), undefined, 0, undefined, {
      ...NO_EFFECTS,
      damage: 0.1,
      crit: 0.5,
      lifesteal: 0.5,
    });
    strong.setAttackTarget("b", "bag");
    for (let i = 0; i < 40 && !b.events.some((e) => e["type"] === "damage"); i++) strong.tick();
    const hit = b.events.find((e) => e["type"] === "damage");
    assert.ok(hit !== undefined);
    assert.strictEqual(hit["crit"], true);
    assert.ok(Math.abs(Number(hit["amount"]) - Math.round(base * 1.1 * 1.5 * 10) / 10) < 0.11, `crítico × 1,5 e +10% (${String(hit["amount"])})`);
  });
});

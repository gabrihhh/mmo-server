import assert from "assert";

import { attributesForSet } from "../src/items/attributes.js";
import { ITEMS, type ItemDef } from "../src/items/catalog.js";
import {
  BOSS_GOLD_MULTIPLIER,
  MAX_ARMOR_PIECES,
  MIN_ARMOR_PIECES,
  WEAPON_CHANCE,
  lootPool,
  rollAttributes,
  rollChestLoot,
  rollLootLevel,
  type LootEntry,
} from "../src/items/loot.js";

/** Sorteador com semente (testes repetíveis). */
function seeded(seed: number): () => number {
  let state: number = seed;
  return (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const items = (entries: readonly LootEntry[]): ItemDef[] =>
  entries.flatMap((entry) => (entry.kind === "item" ? [ITEMS[entry.stack.itemId]].filter((d): d is ItemDef => d !== undefined) : []));

/** Sorteio dos baús ([JOGO-19]). */
describe("loot dos baús", () => {
  it("lê o catálogo: roupa e arma por classe; item novo entra sozinho", () => {
    const armor = lootPool("armor");
    const weapons = lootPool("weapon");
    for (const list of armor.values()) for (const item of list) assert.notStrictEqual(item.slot, "hand");
    for (const list of weapons.values()) for (const item of list) assert.strictEqual(item.slot, "hand");
    const knight: ItemDef | undefined = ITEMS["knight_sword"];
    assert.ok(knight);
    // Uma arma nova (classe nova) no catálogo aparece no sorteio sem mexer no loot.
    const withNew = { ...ITEMS, new_axe: { ...knight, id: "new_axe", name: "Machado", set: "Bárbaro" } };
    assert.deepStrictEqual(lootPool("weapon", withNew).get("Bárbaro")?.map((item) => item.id), ["new_axe"]);
  });

  it("nível de +0 até o do acampamento, os altos mais raros", () => {
    const random = seeded(1);
    const levels: number[] = Array.from({ length: 4000 }, () => rollLootLevel(10, random));
    assert.ok(levels.every((level) => level >= 0 && level <= 10));
    const average: number = levels.reduce((a, b) => a + b, 0) / levels.length;
    assert.ok(average < 5, `média ${average.toFixed(2)} puxa para baixo`);
    assert.ok(levels.includes(10), "o máximo ainda sai às vezes");
    assert.strictEqual(rollLootLevel(0, random), 0);
  });

  it("atributos como o ferreiro daria: um por nível, só os do conjunto (novo +1, de novo +2)", () => {
    const random = seeded(2);
    const points = rollAttributes("Mago", 6, random);
    const allowed = attributesForSet("Mago");
    const values: number[] = Object.entries(points).map(([key, value]) => {
      assert.ok((allowed as readonly string[]).includes(key), `${key} é do Mago`);
      return value ?? 0;
    });
    const total: number = values.reduce((a, b) => a + b, 0);
    // 6 melhorias: cada uma +1 (atributo novo) ou +2 (de novo).
    assert.ok(total >= 6 && total <= 12, `total ${total}`);
  });

  it("baú comum: 1–2 peças de roupa até o nível dele, ~10% de arma e sempre moedas por último", () => {
    const random = seeded(3);
    let weapons = 0;
    const runs = 3000;
    for (let i = 0; i < runs; i++) {
      const entries: LootEntry[] = rollChestLoot({ level: 7, boss: false }, random);
      const last: LootEntry | undefined = entries[entries.length - 1];
      assert.ok(last?.kind === "gold" && last.amount > 0, "moedas por último");
      const defs: ItemDef[] = items(entries);
      const armor: number = defs.filter((def) => def.slot !== "hand").length;
      assert.ok(armor >= MIN_ARMOR_PIECES && armor <= MAX_ARMOR_PIECES, `peças: ${armor}`);
      weapons += defs.filter((def) => def.slot === "hand").length;
      for (const entry of entries) if (entry.kind === "item") assert.ok((entry.stack.level ?? 0) <= 7);
      assert.ok(defs.every((def) => def.lootable !== false));
    }
    const rate: number = weapons / runs;
    assert.ok(Math.abs(rate - WEAPON_CHANCE) < 0.03, `arma em ${(rate * 100).toFixed(1)}%`);
  });

  it("chefe: mais peças e o dobro das moedas", () => {
    const random = seeded(4);
    const entries: LootEntry[] = rollChestLoot({ level: 5, boss: true }, random);
    assert.ok(items(entries).filter((def) => def.slot !== "hand").length >= MIN_ARMOR_PIECES + 1);
    const gold: LootEntry | undefined = entries.find((entry) => entry.kind === "gold");
    // Comum: goldReward(5) × 3..6; chefe: × 2 por cima.
    assert.ok(gold?.kind === "gold" && gold.amount % BOSS_GOLD_MULTIPLIER === 0);
  });
});

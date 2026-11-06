import assert from "assert";

import { MAX_LEVEL, STARTING_PROGRESS, addXp, readProgress, xpToNextLevel } from "../src/progression/level.js";
import { Zone, type ZoneMember } from "../src/zones/Zone.js";
import { UNARMED_ATTACK } from "../src/items/catalog.js";

/** Membro falso que guarda o `me` do último snapshot. */
class Member implements ZoneMember {
  readonly name: string;
  me: Record<string, unknown> = {};
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || decoded.type !== "snapshot") return;
    if (!("data" in decoded) || typeof decoded.data !== "object" || decoded.data === null || !("me" in decoded.data)) return;
    const me: unknown = decoded.data.me;
    if (typeof me !== "object" || me === null) return;
    this.me = Object.fromEntries(Object.entries(me));
  }
}

describe("evolução (nível e XP)", () => {
  it("personagem novo começa no nível 1 sem XP; XP pedida cresce com o nível", () => {
    assert.deepStrictEqual(STARTING_PROGRESS, { level: 1, xp: 0 });
    assert.ok(xpToNextLevel(2) > xpToNextLevel(1));
    assert.strictEqual(xpToNextLevel(MAX_LEVEL), 0);
  });

  it("addXp sobe de nível e passa a sobra adiante; no máximo para", () => {
    const need: number = xpToNextLevel(1);
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, need - 1), { level: 1, xp: need - 1 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, need + 5), { level: 2, xp: 5 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, need + xpToNextLevel(2)), { level: 3, xp: 0 });
    assert.deepStrictEqual(addXp({ level: MAX_LEVEL, xp: 0 }, 1_000_000), { level: MAX_LEVEL, xp: 0 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, -50), STARTING_PROGRESS);
  });

  it("readProgress: conta antiga/estragada vira nível 1; valores fora da faixa são limitados", () => {
    assert.deepStrictEqual(readProgress(undefined), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: "3" }), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: 0, xp: 5 }), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: 3, xp: 40 }), { level: 3, xp: 40 });
    assert.deepStrictEqual(readProgress({ level: 2, xp: 999999 }), { level: 2, xp: xpToNextLevel(2) - 1 });
    assert.deepStrictEqual(readProgress({ level: 999, xp: 10 }), { level: MAX_LEVEL, xp: 0 });
  });

  it("o snapshot leva nível, XP e XP do próximo nível só no `me`", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies: [] });
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 4, xp: 120 });
    zone.tick();
    assert.strictEqual(a.me["level"], 4);
    assert.strictEqual(a.me["xp"], 120);
    assert.strictEqual(a.me["xpNext"], xpToNextLevel(4));
  });
});

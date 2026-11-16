import assert from "assert";

import { DEATH_GOLD_LOSS, ITEM_BREAK_CHANCE, breakEquipped, deathPenalty, rollDeathItem } from "../src/combat/death.js";
import { PLAYER_RESPAWN_SECONDS } from "../src/combat/stats.js";
import { UNARMED_ATTACK } from "../src/items/catalog.js";
import type { Inventory } from "../src/items/inventory.js";
import { xpToNextLevel, type Progress } from "../src/progression/level.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import { Zone, type DeathInfo, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";

const inventory = (worn: Partial<Record<"hand" | "head" | "chest" | "feet", string>>): Inventory => ({
  equipped: {
    hand: worn.hand === undefined ? null : { uid: "h", itemId: worn.hand },
    head: worn.head === undefined ? null : { uid: "c", itemId: worn.head },
    chest: worn.chest === undefined ? null : { uid: "p", itemId: worn.chest },
    feet: worn.feet === undefined ? null : { uid: "f", itemId: worn.feet },
  },
  bag: [],
  grants: [],
});

/** Membro que guarda o progresso salvo e as mortes avisadas. */
class Member implements ZoneMember {
  readonly name: string;
  saved: Progress | null = null;
  readonly deaths: DeathInfo[] = [];
  constructor(readonly id: string) {
    this.name = id;
  }
  send(): void {}
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
  onDeath(info: DeathInfo): void {
    this.deaths.push(info);
  }
}

/** Morte do jogador ([JOGO-21]). */
describe("morte do jogador", () => {
  it("perde 10% das moedas e 10% da XP que o nível pede, sem cair de nível", () => {
    const penalty = deathPenalty({ level: 5, xp: 50, gold: 1234 });
    assert.strictEqual(penalty.goldLost, Math.floor(1234 * DEATH_GOLD_LOSS));
    assert.strictEqual(penalty.xpLost, Math.round(xpToNextLevel(5) * 0.1 * 10) / 10);
    assert.deepStrictEqual(penalty.progress, { level: 5, xp: Math.round((50 - penalty.xpLost) * 10) / 10, gold: 1234 - penalty.goldLost });
    const poor = deathPenalty({ level: 3, xp: 2, gold: 5 });
    assert.deepStrictEqual(poor.progress, { level: 3, xp: 0, gold: 5 }, "XP para no começo do nível; 10% de 5 moedas = 0");
    assert.strictEqual(poor.xpLost, 2);
  });

  it("roleta: sorteia uma das peças vestidas; quebra rara (1 em 2.000); nada vestido = nada", () => {
    const worn: Inventory = inventory({ hand: "knight_sword", chest: "knight_plate" });
    let seed = 7;
    const random = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const slots: Set<string> = new Set();
    let broken = 0;
    const runs = 20000;
    for (let i = 0; i < runs; i++) {
      const roll = rollDeathItem(worn, random);
      assert.ok(roll.slot === "hand" || roll.slot === "chest", "só peça vestida");
      slots.add(roll.slot ?? "");
      if (roll.broken) broken++;
    }
    assert.deepStrictEqual(slots, new Set(["hand", "chest"]));
    assert.ok(broken / runs < ITEM_BREAK_CHANCE * 4, `quebrou ${broken} em ${runs}`);
    assert.deepStrictEqual(rollDeathItem(inventory({}), random), { slot: null, broken: false });
    assert.strictEqual(rollDeathItem(worn, () => 0).broken, true, "sorteio abaixo da chance quebra");
    assert.strictEqual(breakEquipped(worn, "chest").equipped.chest, null, "quebrou: some");
  });

  it("na zona (morto por monstro): perde na hora (salvo), avisa quem guarda o inventário, e renasce pelo botão ou sozinho em 60 s", () => {
    const zombie: DummyConfig = {
      id: "z",
      name: "Zumbi",
      x: 0,
      z: -1.2,
      level: 0,
      maxHp: 9999,
      damageMultiplier: 1000,
      body: "zombie",
      behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 5, leashRadius: 50, speed: 0 },
    };
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [zombie] });
    const victim = new Member("v");
    zone.join(victim, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 2, xp: 30, gold: 500 });
    for (let i = 0; i < 5 * TICK_RATE_HZ && victim.deaths.length === 0; i++) zone.tick();
    assert.strictEqual(victim.deaths.length, 1);
    assert.deepStrictEqual(victim.deaths[0], { goldLost: 50, xpLost: Math.round(xpToNextLevel(2) * 0.1 * 10) / 10, levelsLost: 0, killer: "Zumbi" });
    assert.strictEqual(victim.saved?.gold, 450, "moedas tiradas e salvas");
    assert.strictEqual(victim.saved?.level, 2, "monstro não tira nível");
    // Fica morto (não renasce em 5 s como antes) até tocar em Renascer.
    for (let i = 0; i < 10 * TICK_RATE_HZ; i++) zone.tick();
    assert.strictEqual(zone.getSnapshot("v")?.dead, true);
    zone.requestRespawn("v");
    zone.tick();
    assert.strictEqual(zone.getSnapshot("v")?.dead, false, "Renascer: volta na hora");

    // Sozinho: morre de novo e espera PLAYER_RESPAWN_SECONDS.
    for (let i = 0; i < 5 * TICK_RATE_HZ && victim.deaths.length === 1; i++) zone.tick();
    assert.strictEqual(victim.deaths.length, 2);
    for (let i = 0; i < PLAYER_RESPAWN_SECONDS * TICK_RATE_HZ + 1 && zone.getSnapshot("v")?.dead === true; i++) zone.tick();
    assert.strictEqual(zone.getSnapshot("v")?.dead, false, "renasceu sozinho");
  });
});

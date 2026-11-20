import assert from "assert";

import { PVP_MAX_LEVEL_GAP, SAFE_ZONE_HALF, inSafeZone, pvpKill, pvpLevelsAllowed } from "../src/combat/pvp.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import type { Progress } from "../src/progression/level.js";
import { Zone, type DeathInfo, type ZoneMember } from "../src/zones/Zone.js";
import { keepAttacking, canHit } from "./helpers.js";

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

const LETHAL: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), damage: 99999, castTime: 0.05, cooldown: 0.05 };

function pvpZone(): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [], safeZoneHalf: SAFE_ZONE_HALF });
}

/** Jogador contra jogador ([JOGO-22]). */
describe("PvP", () => {
  it("regras puras: área segura na praça, até 10 níveis, morte troca 1 nível e 10% das moedas", () => {
    assert.ok(inSafeZone(0, 0) && inSafeZone(SAFE_ZONE_HALF, -SAFE_ZONE_HALF) && !inSafeZone(SAFE_ZONE_HALF + 0.1, 0));
    assert.ok(!inSafeZone(0, 0, 0), "zona sem área segura");
    assert.ok(pvpLevelsAllowed(5, 5 + PVP_MAX_LEVEL_GAP) && !pvpLevelsAllowed(5, 6 + PVP_MAX_LEVEL_GAP));
    const kill = pvpKill({ level: 4, xp: 10, gold: 100 }, { level: 7, xp: 50, gold: 555 });
    assert.deepStrictEqual(kill.killer, { level: 5, xp: 10, gold: 155 });
    assert.deepStrictEqual(kill.victim, { level: 6, xp: 50, gold: 500 });
    assert.strictEqual(kill.goldMoved, 55);
    assert.strictEqual(kill.levelsLost, 1);
    const zero = pvpKill({ level: 0, xp: 0, gold: 0 }, { level: 0, xp: 5, gold: 9 });
    assert.strictEqual(zero.victim.level, 0, "nível 0 não cai");
    assert.strictEqual(zero.levelsLost, 0);
    assert.strictEqual(zero.killer.level, 1, "quem matou sobe mesmo assim");
  });

  it("na zona: quem matou sobe 1 nível e leva 10% das moedas; quem morreu perde o nível e as moedas", () => {
    const zone = pvpZone();
    const a = new Member("a");
    const b = new Member("b");
    zone.join(a, { x: 30, y: 0, z: 30, rotY: 0 }, LETHAL, new Map(), undefined, 0, { level: 3, xp: 0, gold: 10 });
    zone.join(b, { x: 31, y: 0, z: 30, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 5, xp: 0, gold: 300 });
    keepAttacking(zone, "a", "b");
    for (let i = 0; i < 10 && b.deaths.length === 0; i++) zone.tick();
    assert.deepStrictEqual(b.deaths[0], { goldLost: 30, xpLost: 0, levelsLost: 1, killer: "a" });
    assert.deepStrictEqual([b.saved?.level, b.saved?.gold], [4, 270]);
    assert.deepStrictEqual([a.saved?.level, a.saved?.gold], [4, 40]);
    assert.strictEqual(zone.getSnapshot("a")?.level, 4, "o nível novo aparece para todos");
  });

  it("mais de 10 níveis de diferença: não dá para atacar", () => {
    const zone = pvpZone();
    zone.join(new Member("a"), { x: 30, y: 0, z: 30, rotY: 0 }, LETHAL, new Map(), undefined, 0, { level: 0, xp: 0, gold: 0 });
    zone.join(new Member("b"), { x: 31, y: 0, z: 30, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 11, xp: 0, gold: 0 });
    assert.ok(!canHit(zone, "a", "b"), "mais de 10 níveis: não acerta");
  });

  it("praça segura: ninguém em cima das pedras ataca nem é atacado por jogador", () => {
    const zone = pvpZone();
    const a = new Member("a");
    const b = new Member("b");
    zone.join(a, { x: 11, y: 0, z: 0, rotY: 0 }, LETHAL);
    zone.join(b, { x: 9.5, y: 0, z: 0, rotY: 0 });
    assert.ok(!canHit(zone, "a", "b"), "b está na praça");
    assert.ok(!canHit(zone, "b", "a"), "b atacando de dentro da praça");
    assert.strictEqual(b.deaths.length, 0);
  });
});

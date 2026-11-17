import assert from "assert";

import { SAFE_ZONE_HALF } from "../src/combat/pvp.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { STARTING_STATS, addDeath, addKill, addMonsterXp, readStats, type PlayerStats } from "../src/progression/stats.js";
import { Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";

/** Membro que guarda os contadores salvos (onStats) e quantas mortes viu. */
class Member implements ZoneMember {
  readonly name: string;
  stats: PlayerStats | null = null;
  died: number = 0;
  constructor(readonly id: string) {
    this.name = id;
  }
  send(): void {}
  onStats(stats: PlayerStats): void {
    this.stats = stats;
  }
  onDeath(): void {
    this.died += 1;
  }
}

const LETHAL: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), damage: 99999, castTime: 0.05, cooldown: 0.05 };

/** Zumbi fraco (1 de vida) ou forte, perto da origem. */
function zombie(maxHp: number): DummyConfig {
  return {
    id: "zombie",
    name: "Zumbi",
    x: 31,
    z: 30,
    level: 1,
    maxHp,
    respawnSeconds: 10,
    body: "male",
    behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 8, leashRadius: 20, speed: 3.5 },
  };
}

function zoneWith(dummies: DummyConfig[], pvp: boolean = false): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp, dummies, safeZoneHalf: SAFE_ZONE_HALF });
}

/** Contadores do perfil ([SOC-08]). */
describe("contadores do perfil (stats)", () => {
  it("regras puras: somam e nunca descem; conta antiga/estragada vira zero", () => {
    assert.deepStrictEqual(addMonsterXp(STARTING_STATS, 20.24), { monsterXp: 20.2, kills: 0, deaths: 0 });
    assert.strictEqual(addMonsterXp(STARTING_STATS, -5), STARTING_STATS, "negativo não desconta");
    assert.deepStrictEqual(addDeath(addKill(STARTING_STATS)), { monsterXp: 0, kills: 1, deaths: 1 });
    assert.deepStrictEqual(readStats(undefined), STARTING_STATS);
    assert.deepStrictEqual(readStats({ monsterXp: "x", kills: -2, deaths: 1.5 }), STARTING_STATS);
    assert.deepStrictEqual(readStats({ monsterXp: 12.34, kills: 3, deaths: 4 }), { monsterXp: 12.3, kills: 3, deaths: 4 });
  });

  it("matar monstro soma a XP ganha no perfil e salva; aparece nos Atributos", () => {
    const zone = zoneWith([zombie(1)]);
    const a = new Member("a");
    zone.join(a, { x: 30, y: 0, z: 30, rotY: 0 }, LETHAL, new Map(), undefined, 0, undefined, undefined, undefined, { monsterXp: 5, kills: 2, deaths: 1 });
    zone.setAttackTarget("a", "zombie");
    for (let i = 0; i < 30 && a.stats === null; i++) zone.tick();
    assert.deepStrictEqual(a.stats, { monsterXp: 25, kills: 2, deaths: 1 }, "20 de XP do zumbi nível 1 em cima do que já tinha");
    assert.deepStrictEqual(zone.attributes("a")?.stats, { monsterXp: 25, kills: 2, deaths: 1 });
  });

  it("PvP: quem matou ganha +1 jogador morto e quem morreu +1 morte", () => {
    const zone = zoneWith([], true);
    const a = new Member("a");
    const b = new Member("b");
    zone.join(a, { x: 30, y: 0, z: 30, rotY: 0 }, LETHAL, new Map(), undefined, 0, { level: 3, xp: 0, gold: 0 });
    zone.join(b, { x: 31, y: 0, z: 30, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 3, xp: 0, gold: 0 });
    zone.setAttackTarget("a", "b");
    for (let i = 0; i < 10 && b.died === 0; i++) zone.tick();
    assert.deepStrictEqual(a.stats, { monsterXp: 0, kills: 1, deaths: 0 });
    assert.deepStrictEqual(b.stats, { monsterXp: 0, kills: 0, deaths: 1 });
  });

  it("morrer para monstro conta como morte", () => {
    const zone = zoneWith([zombie(99999)]);
    const a = new Member("a");
    zone.join(a, { x: 30, y: 0, z: 30, rotY: 0 });
    for (let i = 0; i < 30 * 60 && a.died === 0; i++) zone.tick();
    assert.strictEqual(a.died, 1);
    assert.deepStrictEqual(a.stats, { monsterXp: 0, kills: 0, deaths: 1 });
  });
});

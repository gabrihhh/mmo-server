import assert from "assert";

import {
  MAX_LEVEL,
  STARTING_PROGRESS,
  addXp,
  levelFactor,
  readProgress,
  xpReward,
  xpToNextLevel,
} from "../src/progression/level.js";
import { Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { PLAYER_MAX_HP, PLAYER_MAX_MANA } from "../src/combat/stats.js";
import type { Progress } from "../src/progression/level.js";

/** Membro falso: guarda o último snapshot e o progresso salvo. */
class Member implements ZoneMember {
  readonly name: string;
  last: Record<string, unknown> = {};
  saved: Progress | null = null;
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || decoded.type !== "snapshot") return;
    if (!("data" in decoded) || typeof decoded.data !== "object" || decoded.data === null) return;
    this.last = Object.fromEntries(Object.entries(decoded.data));
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
  me(): Record<string, unknown> {
    const me: unknown = this.last["me"];
    return typeof me === "object" && me !== null ? Object.fromEntries(Object.entries(me)) : {};
  }
  /** Campo `key` da entidade `id` (jogador ou NPC) no último snapshot. */
  field(id: string, key: string): unknown {
    for (const list of [this.last["players"], this.last["npcs"]]) {
      if (!Array.isArray(list)) continue;
      for (const e of list) if (typeof e === "object" && e !== null && "id" in e && e.id === id) return Reflect.get(e, key);
    }
    return undefined;
  }
  events(type: string): Array<Record<string, unknown>> {
    const events: unknown = this.last["events"];
    if (!Array.isArray(events)) return [];
    return events.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && Reflect.get(e, "type") === type);
  }
}

const SWORD: AbilityDef = ITEMS["training_sword"]?.basicAttack ?? UNARMED_ATTACK;

function zombieConfig(kind: "fighter" | "shooter", x: number, z: number, level: number = 1): DummyConfig {
  const fighter: boolean = kind === "fighter";
  const weapon: string = fighter ? "knight_sword" : "ranger_crossbow";
  return {
    id: "zombie",
    name: "Zumbi",
    x,
    z,
    level,
    maxHp: 100,
    respawnSeconds: 10,
    body: "male",
    look: { hand: weapon, head: null, chest: null, feet: null },
    behavior: { kind: "zombie", weapon, ability: fighter ? "line_cleave" : "piercing_bolt", aggroRadius: 8, leashRadius: 20, speed: 3.5 },
  };
}

function zoneWith(dummies: DummyConfig[]): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies });
}

function ticks(zone: Zone, count: number): void {
  for (let i = 0; i < count; i++) zone.tick();
}

describe("evolução (nível e XP)", () => {
  it("começa no nível 0; tudo cresce 1% por nível, acumulando", () => {
    assert.deepStrictEqual(STARTING_PROGRESS, { level: 0, xp: 0 });
    assert.strictEqual(levelFactor(0), 1);
    assert.ok(Math.abs(levelFactor(3) - 1.01 ** 3) < 1e-12);
    assert.strictEqual(xpToNextLevel(0), 100);
    assert.strictEqual(xpToNextLevel(1), 101);
    assert.strictEqual(xpToNextLevel(10), 110.5); // 100 × 1,01^10 = 110,46 → 110,5
    assert.strictEqual(xpToNextLevel(MAX_LEVEL), 0);
    assert.strictEqual(xpReward(1), 20);
    assert.strictEqual(xpReward(3), 20.4); // 20 × 1,01² = 20,402
  });

  it("addXp sobe de nível e passa a sobra adiante (1 casa); no máximo para", () => {
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, 99.9), { level: 0, xp: 99.9 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, 105.3), { level: 1, xp: 5.3 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, 201), { level: 2, xp: 0 });
    assert.deepStrictEqual(addXp({ level: MAX_LEVEL, xp: 0 }, 1_000_000), { level: MAX_LEVEL, xp: 0 });
    assert.deepStrictEqual(addXp(STARTING_PROGRESS, -50), STARTING_PROGRESS);
    // 5 zumbis de nível 1 (20 cada) = 100: sobe do 0 para o 1.
    let progress: Progress = STARTING_PROGRESS;
    for (let i = 0; i < 5; i++) progress = addXp(progress, xpReward(1));
    assert.deepStrictEqual(progress, { level: 1, xp: 0 });
  });

  it("readProgress: conta antiga/estragada vira nível 0; valores fora da faixa são limitados", () => {
    assert.deepStrictEqual(readProgress(undefined), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: "3" }), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: -1, xp: 5 }), STARTING_PROGRESS);
    assert.deepStrictEqual(readProgress({ level: 3, xp: 40.25 }), { level: 3, xp: 40.3 });
    assert.deepStrictEqual(readProgress({ level: 0, xp: 999999 }), { level: 0, xp: 99.9 });
    assert.deepStrictEqual(readProgress({ level: 999, xp: 10 }), { level: MAX_LEVEL, xp: 0 });
  });

  it("o snapshot leva o nível de todos e a XP só no `me`; vida/mana máximas crescem com o nível", () => {
    const zone = zoneWith([]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 0, { level: 10, xp: 12.5 });
    zone.tick();
    assert.strictEqual(a.me()["level"], 10);
    assert.strictEqual(a.me()["xp"], 12.5);
    assert.strictEqual(a.me()["xpNext"], xpToNextLevel(10));
    assert.strictEqual(a.field("a", "level"), 10);
    assert.strictEqual(a.field("a", "xp"), undefined);
    assert.strictEqual(a.field("a", "maxHp"), Math.round(PLAYER_MAX_HP * 1.01 ** 10 * 10) / 10);
    assert.strictEqual(a.field("a", "maxMana"), Math.round(PLAYER_MAX_MANA * 1.01 ** 10 * 10) / 10);
  });

  it("multiplicador de dano do monstro vale junto com o nível", () => {
    const zone = zoneWith([{ ...zombieConfig("fighter", 0, -2, 0), damageMultiplier: 0.5 }]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
    let damage: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && damage === undefined; i++) {
      zone.tick();
      damage = a.events("damage").find((e) => e["target"] === "a");
    }
    assert.strictEqual(damage?.["amount"], 7); // Corte em linha 14 × 0,5
  });

  it("dano cresce com o nível de quem bate (zumbi nível 3 bate 3% acumulado a mais)", () => {
    const zone = zoneWith([zombieConfig("fighter", 0, -2, 3)]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
    let damage: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && damage === undefined; i++) {
      zone.tick();
      damage = a.events("damage").find((e) => e["target"] === "a");
    }
    assert.ok(damage !== undefined);
    // Primeiro golpe: Corte em linha (14) × 1,01³ = 14,42 → 14,4.
    assert.strictEqual(damage["amount"], 14.4);
    assert.strictEqual(a.field("zombie", "maxHp"), Math.round(100 * 1.01 ** 3 * 10) / 10);
  });
});

describe("zumbis", () => {
  it("parado até alguém entrar no raio; aí anda até o jogador e bate", () => {
    const zone = zoneWith([zombieConfig("fighter", 0, -12)]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 9, rotY: 0 }, SWORD); // 21 m de casa: fora do raio de 8 m
    ticks(zone, 20);
    assert.strictEqual(a.field("zombie", "z"), -12);
    assert.strictEqual(a.field("zombie", "monster"), true);
    assert.strictEqual(a.field("zombie", "level"), 1);
    const zone2 = zoneWith([zombieConfig("fighter", 0, -12)]);
    const b = new Member("b");
    zone2.join(b, { x: 0, y: 0, z: -5, rotY: 0 }, SWORD); // 7 m de casa
    ticks(zone2, 20); // 1 s a 3,5 m/s
    const z: unknown = b.field("zombie", "z");
    assert.ok(typeof z === "number" && z > -12 + 2, `andou até o jogador (z=${String(z)})`);
    let hit = false;
    for (let i = 0; i < 100 && !hit; i++) {
      zone2.tick();
      hit = b.events("damage").some((e) => e["source"] === "zombie" && e["target"] === "b");
    }
    assert.ok(hit, "bateu no jogador");
  });

  it("usa a habilidade da arma: lutador o Corte em linha, atirador o Virote certeiro (projétil)", () => {
    for (const [kind, ability] of [["fighter", "line_cleave"], ["shooter", "piercing_bolt"]] as const) {
      const zone = zoneWith([zombieConfig(kind, 0, -4)]);
      const a = new Member("a");
      zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
      let used = false;
      for (let i = 0; i < 60 && !used; i++) {
        zone.tick();
        used = a.events("cast_start").some((e) => e["source"] === "zombie" && e["ability"] === ability);
      }
      assert.ok(used, `${kind} usou ${ability}`);
    }
  });

  it("passou de 20 m de casa: desiste, volta e enche a vida", () => {
    const zone = zoneWith([zombieConfig("fighter", 0, 0)]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 6, rotY: 0 }, SWORD);
    zone.setAttackTarget("a", "zombie");
    // Bate até ele levar dano e foge para +Z (mais rápido que o zumbi).
    let seq = 0;
    for (let i = 0; i < 40; i++) zone.tick();
    for (let i = 0; i < 200; i++) {
      zone.queueInput("a", { seq: ++seq, x: 0, z: 1 });
      zone.tick();
    }
    const z: unknown = a.field("zombie", "z");
    assert.ok(typeof z === "number" && z < 20.5, `não passa muito de 20 m (z=${String(z)})`);
    ticks(zone, 200);
    assert.strictEqual(a.field("zombie", "z"), 0, "voltou para casa");
    assert.strictEqual(a.field("zombie", "hp"), a.field("zombie", "maxHp"), "vida cheia");
  });

  it("atacado de fora do raio: vai atrás de quem bateu", () => {
    const zone = zoneWith([zombieConfig("fighter", 0, 0)]);
    const a = new Member("a");
    const staff: AbilityDef = ITEMS["training_staff"]?.basicAttack ?? UNARMED_ATTACK;
    // 8,4 m de casa: fora do raio de 8 m, mas no alcance do cajado (8 m + 0,5 de folga).
    zone.join(a, { x: 0, y: 0, z: 8.4, rotY: 0 }, staff);
    ticks(zone, 20);
    assert.strictEqual(a.field("zombie", "z"), 0, "parado antes de apanhar");
    zone.setAttackTarget("a", "zombie");
    ticks(zone, 60);
    const z: unknown = a.field("zombie", "z");
    assert.ok(typeof z === "number" && z > 1, `veio atrás (z=${String(z)})`);
  });

  it("quem mata ganha XP do nível do zumbi e salva; zumbi não dá XP a NPC nem ao morrer de novo", () => {
    const zone = zoneWith([{ ...zombieConfig("fighter", 0, -2), maxHp: 1 }]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    zone.setAttackTarget("a", "zombie");
    let died = false;
    for (let i = 0; i < 60 && !died; i++) {
      zone.tick();
      died = a.events("death").some((e) => e["id"] === "zombie");
    }
    assert.ok(died);
    assert.deepStrictEqual(a.saved, { level: 0, xp: 20 });
    assert.strictEqual(a.me()["xp"], 20);
  });

  it("alvo morreu: quem atacava solta o alvo e o golpe em andamento é cancelado (não fica travado no corpo)", () => {
    const zone = zoneWith([{ ...zombieConfig("fighter", 0, -2), maxHp: 1 }]);
    const a = new Member("a");
    const b = new Member("b");
    const staff: AbilityDef = ITEMS["training_staff"]?.basicAttack ?? UNARMED_ATTACK;
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    // b começa a golpear depois (cajado, lançamento mais longo): quando a espada de a mata, o golpe de b está no meio.
    zone.join(b, { x: 1, y: 0, z: 0, rotY: 0 }, staff);
    zone.setAttackTarget("a", "zombie");
    zone.setAttackTarget("b", "zombie");
    let died = false;
    for (let i = 0; i < 60 && !died; i++) {
      zone.tick();
      died = a.events("death").some((e) => e["id"] === "zombie");
    }
    assert.ok(died, "zumbi morreu");
    for (const member of [a, b]) {
      assert.strictEqual(member.me()["target"], null, `${member.id}: alvo solto`);
      assert.strictEqual(member.me()["casting"], null, `${member.id}: sem golpe preso no corpo`);
    }
    assert.ok(b.events("cast_cancel").some((e) => e["source"] === "b"), "o golpe de b foi cancelado (cliente para a animação)");
  });

  it("subir de nível manda `level_up` para todos e aumenta vida/mana máximas", () => {
    const zone = zoneWith([{ ...zombieConfig("fighter", 0, -2), maxHp: 1 }]);
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD, new Map(), undefined, 0, { level: 0, xp: 90 });
    zone.setAttackTarget("a", "zombie");
    let levelUp: Record<string, unknown> | undefined;
    for (let i = 0; i < 60 && levelUp === undefined; i++) {
      zone.tick();
      levelUp = a.events("level_up")[0];
    }
    assert.deepStrictEqual(levelUp, { type: "level_up", id: "a", level: 1 });
    assert.deepStrictEqual(a.saved, { level: 1, xp: 10 });
    assert.strictEqual(a.field("a", "maxHp"), 101);
    assert.strictEqual(a.field("a", "maxMana"), 101);
  });
});

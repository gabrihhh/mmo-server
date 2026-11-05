import assert from "assert";

import { Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { DUMMY_MAX_HP, DUMMY_RESPAWN_SECONDS } from "../src/combat/stats.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";

/** NPCs de teste ([JOGO-11]): atirador invulnerável, saco de pancadas que não morre e brigão. */

/** Membro falso que guarda os snapshots e junta todos os eventos recebidos. */
class Member implements ZoneMember {
  readonly name: string;
  last: Record<string, unknown> = {};
  readonly allEvents: Array<Record<string, unknown>> = [];
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || !("data" in decoded)) return;
    if (decoded.type !== "snapshot" || typeof decoded.data !== "object" || decoded.data === null) return;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decoded.data)) data[k] = v;
    this.last = data;
    const events: unknown = data["events"];
    if (Array.isArray(events)) for (const e of events) if (typeof e === "object" && e !== null) this.allEvents.push({ ...e });
  }
  /** Eventos do último snapshot. */
  events(): Array<Record<string, unknown>> {
    const events: unknown = this.last["events"];
    return Array.isArray(events) ? events.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null) : [];
  }
  /** Campo `field` da entidade `id` no último snapshot. */
  field(id: string, field: string): unknown {
    for (const key of ["players", "npcs"]) {
      const list: unknown = this.last[key];
      if (!Array.isArray(list)) continue;
      for (const e of list) if (typeof e === "object" && e !== null && "id" in e && e.id === id) return (e as Record<string, unknown>)[field];
    }
    return undefined;
  }
}

const BAG: DummyConfig = { id: "bag", name: "Saco", x: 0, z: -8, behavior: { kind: "punchingBag", regenDelaySeconds: 1, regenPerSecond: 50 } };
const SHOOTER: DummyConfig = {
  id: "shooter",
  name: "Atirador",
  x: 0,
  z: -16,
  body: "male",
  behavior: { kind: "shooter", target: "bag", rotation: ["bolt", "fireball", "meteor"], pauseSeconds: 0.5 },
};
const BRAWLER: DummyConfig = { id: "brawler", name: "Brigão", x: 10, z: 0, body: "male", behavior: { kind: "brawler", weapon: "knight_sword" } };

function zone(dummies: readonly DummyConfig[]): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies });
}

function ticks(z: Zone, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * TICK_RATE_HZ); i++) z.tick();
}

const SWORD: AbilityDef = ITEMS["training_sword"]?.basicAttack ?? UNARMED_ATTACK;
const KNIGHT_ATTACK: AbilityDef = ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK;

describe("NPCs de teste", () => {
  it("atirador lança a rotação no saco de pancadas e veste o conjunto da habilidade da vez", () => {
    const z = zone([BAG, SHOOTER]);
    const a = new Member("a");
    z.join(a, { x: 30, y: 0, z: 30, rotY: 0 });
    ticks(z, 12);
    const casts: unknown[] = a.allEvents.filter((e) => e["type"] === "cast_start" && e["source"] === "shooter").map((e) => e["ability"]);
    assert.deepStrictEqual(casts.slice(0, 3), ["bolt", "fireball", "meteor"], "segue a rotação");
    assert.ok(a.allEvents.some((e) => e["type"] === "damage" && e["source"] === "shooter" && e["target"] === "bag"), "acerta o saco");
    assert.ok(a.allEvents.some((e) => e["type"] === "projectile" && e["source"] === "shooter"), "bola de fogo voa de verdade");
    const look: unknown = a.allEvents.find((e) => e["type"] === "look" && e["id"] === "shooter")?.["look"];
    assert.ok(typeof look === "object" && look !== null && "hand" in look && look.hand === "training_staff", "veste o conjunto");
    assert.strictEqual(a.field("shooter", "body"), "male", "vai no snapshot como humano");
    assert.strictEqual(a.field("shooter", "targetable"), false);
  });

  it("tiros e áreas do atirador acertam jogadores no caminho/área (não só o saco)", () => {
    const z = zone([BAG, { ...SHOOTER, behavior: { kind: "shooter", target: "bag", rotation: ["meteor", "fireball"], pauseSeconds: 0.5 } }]);
    const a = new Member("a");
    // Em cima do saco (área do meteoro) e na linha da bola de fogo.
    z.join(a, { x: 0, y: 0, z: -9, rotY: 0 });
    ticks(z, 6);
    const hits: unknown[] = a.allEvents.filter((e) => e["type"] === "damage" && e["source"] === "shooter" && e["target"] === "a").map((e) => e["ability"]);
    assert.ok(hits.includes("meteor"), "meteoro pegou o jogador na área");
    assert.ok(hits.includes("fireball"), "bola de fogo pegou o jogador no caminho");
  });

  it("atirador é invulnerável e não é alvo de ataque", () => {
    const z = zone([BAG, SHOOTER]);
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: -15, rotY: 0 }, SWORD);
    assert.strictEqual(z.setAttackTarget("a", "shooter"), "invalid_target");
    ticks(z, 1);
    assert.strictEqual(a.field("shooter", "hp"), DUMMY_MAX_HP);
  });

  it("saco de pancadas não morre (para em 1), recupera vida e é aliado (curável, não atacável)", () => {
    const z = zone([BAG, SHOOTER]);
    const a = new Member("a");
    const heal: AbilityDef | undefined = ITEMS["healer_tome"]?.abilities.find((x) => x.id === "greater_heal");
    assert.ok(heal);
    z.join(a, { x: 0, y: 0, z: -3, rotY: 0 }, SWORD, new Map([[heal.id, heal]]));
    assert.strictEqual(z.setAttackTarget("a", "bag"), "invalid_target", "jogador não ataca o aliado");
    assert.strictEqual(a.field("bag", "ally"), undefined, "sem snapshot ainda");
    ticks(z, 60);
    assert.ok(!a.allEvents.some((e) => e["type"] === "death" && e["id"] === "bag"), "nunca morre");
    const low: unknown = a.field("bag", "hp");
    assert.ok(typeof low === "number" && low >= 1);
    assert.strictEqual(a.field("bag", "ally"), true);
    // Curar o saco: a Cura maior aceita como aliado.
    const result = z.castAbility("a", { abilityId: heal.id, targetId: "bag", x: null, z: null, seq: null });
    assert.deepStrictEqual(result, { ok: true });
    ticks(z, heal.castTime + 0.1);
    assert.ok(a.allEvents.some((e) => e["type"] === "heal" && e["target"] === "bag"), "curou o saco");
  });

  it("saco em 1 de vida volta à vida cheia depois do tempo, mesmo apanhando sem parar", () => {
    // Três posições de carta diferentes (hand:2, hand:0, hand:1): não esperam a recarga uma da outra.
    const z = zone([{ ...BAG, maxHp: 30 }, { ...SHOOTER, behavior: { kind: "shooter", target: "bag", rotation: ["bolt", "fireball", "meteor"], pauseSeconds: 0 } }]);
    const a = new Member("a");
    z.join(a, { x: 30, y: 0, z: 30, rotY: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 8 * TICK_RATE_HZ; i++) {
      z.tick();
      const hp: unknown = a.field("bag", "hp");
      if (typeof hp === "number") seen.push(hp);
    }
    const firstLow: number = seen.indexOf(1);
    assert.ok(firstLow >= 0, "chegou em 1");
    assert.ok(seen.slice(firstLow).some((hp) => hp === 30), "voltou à vida cheia apanhando sem parar");
    assert.ok(Math.min(...seen) >= 1, "nunca abaixo de 1");
  });

  it("saco recupera vida depois de um tempo sem apanhar", () => {
    const z = zone([BAG, { ...SHOOTER, behavior: { kind: "shooter", target: "bag", rotation: ["bolt"], pauseSeconds: 100 } }]);
    const a = new Member("a");
    z.join(a, { x: 30, y: 0, z: 30, rotY: 0 });
    ticks(z, 3);
    const hit: unknown = a.field("bag", "hp");
    assert.ok(typeof hit === "number" && hit < DUMMY_MAX_HP, "levou o raio");
    ticks(z, 5);
    assert.strictEqual(a.field("bag", "hp"), DUMMY_MAX_HP, "encheu de novo");
  });

  it("atirador respeita a recarga da POSIÇÃO da carta: habilidade de outro item na mesma posição espera", () => {
    // Bola de fogo (Treino, hand:0, recarga 4 s) e Lança de gelo (Mago, hand:0): mesma posição.
    const z = zone([BAG, { ...SHOOTER, behavior: { kind: "shooter", target: "bag", rotation: ["fireball", "ice_lance"], pauseSeconds: 0 } }]);
    const a = new Member("a");
    z.join(a, { x: 30, y: 0, z: 30, rotY: 0 });
    const startTicks: number[] = [];
    for (let i = 0; i < 10 * TICK_RATE_HZ; i++) {
      z.tick();
      if (a.events().length === 0) continue;
      for (const e of a.events()) if (e["type"] === "cast_start" && e["source"] === "shooter") startTicks.push(i);
    }
    assert.ok(startTicks.length >= 2);
    const gap: number = ((startTicks[1] ?? 0) - (startTicks[0] ?? 0)) / TICK_RATE_HZ;
    const fireball: AbilityDef | undefined = ITEMS["training_staff"]?.abilities[0];
    assert.ok(fireball !== undefined && gap >= fireball.cooldown - 0.05, `esperou a recarga da bola de fogo (${gap} s)`);
  });

  it("brigão bate em quem chega perto (não em quem está longe), morre e reaparece", () => {
    const z = zone([BRAWLER]);
    const near = new Member("near");
    const far = new Member("far");
    z.join(near, { x: 10, y: 0, z: 2, rotY: 0 }, SWORD);
    z.join(far, { x: 30, y: 0, z: 0, rotY: 0 }, SWORD);
    ticks(z, KNIGHT_ATTACK.castTime + 0.2);
    assert.ok(near.allEvents.some((e) => e["type"] === "damage" && e["source"] === "brawler" && e["target"] === "near"), "bateu em quem está perto");
    assert.ok(!near.allEvents.some((e) => e["type"] === "damage" && e["source"] === "brawler" && e["target"] === "far"), "não bate longe");
    // Jogador perto mata o brigão (tem vida e morre como o boneco).
    assert.strictEqual(z.setAttackTarget("near", "brawler"), "ok");
    ticks(z, (DUMMY_MAX_HP / SWORD.damage + 2) * SWORD.castTime);
    assert.ok(near.allEvents.some((e) => e["type"] === "death" && e["id"] === "brawler"), "morreu");
    ticks(z, DUMMY_RESPAWN_SECONDS + 0.5);
    assert.ok(near.allEvents.some((e) => e["type"] === "respawn" && e["id"] === "brawler"), "reapareceu");
  });
});

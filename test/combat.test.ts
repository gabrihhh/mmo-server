import assert from "assert";

import { Zone, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { DUMMY_MAX_HP, DUMMY_RESPAWN_SECONDS, PLAYER_MAX_HP, PLAYER_MAX_MANA, PLAYER_RESPAWN_SECONDS } from "../src/combat/stats.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";

/** Membro falso que guarda o último snapshot (decodificado). */
class Member implements ZoneMember {
  readonly name: string;
  last: Record<string, unknown> = {};
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
  }
  /** Eventos do último snapshot. */
  events(): Array<Record<string, unknown>> {
    const events: unknown = this.last["events"];
    return Array.isArray(events) ? events : [];
  }
}

const SWORD: AbilityDef = ITEMS["training_sword"]?.basicAttack ?? UNARMED_ATTACK;

function zone(pvp: boolean = true): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp, dummies: [{ id: "dummy", name: "Boneco", x: 0, z: -2 }] });
}

/** HP de uma entidade no último snapshot recebido por `member`. */
function hpOf(member: Member, id: string): number {
  for (const key of ["players", "npcs"]) {
    const list: unknown = member.last[key];
    if (!Array.isArray(list)) continue;
    for (const e of list) if (typeof e === "object" && e !== null && "id" in e && e.id === id && "hp" in e && typeof e.hp === "number") return e.hp;
  }
  return NaN;
}

describe("combate (ataque simples)", () => {
  it("snapshot leva a mana dos jogadores (barra acima da cabeça); bonecos não têm mana", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    z.tick();
    const players: unknown = a.last["players"];
    const npcs: unknown = a.last["npcs"];
    assert.ok(Array.isArray(players) && Array.isArray(npcs));
    const me: unknown = players[0];
    const dummy: unknown = npcs[0];
    assert.ok(typeof me === "object" && me !== null && "mana" in me && "maxMana" in me);
    assert.strictEqual(me.mana, PLAYER_MAX_MANA);
    assert.strictEqual(me.maxMana, PLAYER_MAX_MANA);
    assert.ok(typeof dummy === "object" && dummy !== null && !("mana" in dummy) && !("maxMana" in dummy));
  });

  it("golpe tem tempo de lançamento: dano só no fim, 1 golpe por lançamento", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    assert.strictEqual(z.setAttackTarget("a", "dummy"), "ok");
    const castTicks: number = SWORD.castTime * TICK_RATE_HZ;
    z.tick();
    assert.ok(a.events().some((e) => e["type"] === "cast_start" && e["target"] === "dummy"), "começa o golpe");
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP, "ainda sem dano");
    for (let i = 1; i < castTicks; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP, "não acerta antes do fim do lançamento");
    z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP - SWORD.damage);
    assert.ok(a.events().some((e) => e["type"] === "damage" && e["amount"] === SWORD.damage));
    for (let i = 0; i < castTicks; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP - 2 * SWORD.damage, "segundo golpe 1 lançamento depois");
  });

  it("durante o golpe fica virado para o alvo, mesmo andando para outro lado", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    z.setAttackTarget("a", "dummy"); // boneco em (0, -2): à frente (-Z) → rotY 0
    z.queueInput("a", { seq: 1, x: 1, z: 0 }); // anda para +X (viraria para -PI/2)
    z.tick();
    const rot: number | undefined = z.getSnapshot("a")?.rotY;
    assert.ok(rot !== undefined && Math.abs(Math.atan2(Math.sin(rot), Math.cos(rot))) < 0.2, `virado para o boneco (rotY=${rot})`);
  });

  it("se no fim do golpe o alvo saiu do alcance, erra (miss)", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    z.setAttackTarget("a", "dummy");
    z.tick(); // começa o golpe em alcance
    let seq = 0;
    for (let i = 0; i < SWORD.castTime * TICK_RATE_HZ; i++) {
      z.queueInput("a", { seq: ++seq, x: 0, z: 1 }); // se afasta do boneco (que está em -Z)
      z.tick();
      if (a.events().some((e) => e["type"] === "miss")) break;
    }
    assert.ok(a.events().some((e) => e["type"] === "miss" && e["target"] === "dummy"), "errou");
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP);
  });

  it("fora de alcance não bate (mas o alvo continua fixo)", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 50, y: 0, z: 50, rotY: 0 }, SWORD);
    z.setAttackTarget("a", "dummy");
    for (let i = 0; i < 40; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP);
    const me: unknown = a.last["me"];
    assert.ok(typeof me === "object" && me !== null && "target" in me && me.target === "dummy");
  });

  it("boneco morre, perde o alvo de quem batia e reaparece", () => {
    const z = zone();
    const a = new Member("a");
    const hit: AbilityDef = { ...SWORD, damage: DUMMY_MAX_HP, cooldown: 0.05, castTime: 0.05 };
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, hit);
    z.setAttackTarget("a", "dummy");
    z.tick();
    z.tick();
    assert.ok(a.events().some((e) => e["type"] === "death" && e["id"] === "dummy" && e["killer"] === "a"));
    assert.strictEqual(z.setAttackTarget("a", "dummy"), "invalid_target", "morto não é alvo");
    for (let i = 0; i < DUMMY_RESPAWN_SECONDS * TICK_RATE_HZ; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP);
  });

  it("PvP: jogador é alvo só com pvp ligado; nunca você mesmo", () => {
    const on = zone(true);
    on.join(new Member("a"), { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    on.join(new Member("b"), { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    assert.strictEqual(on.setAttackTarget("a", "b"), "ok");
    assert.strictEqual(on.setAttackTarget("a", "a"), "invalid_target");
    assert.strictEqual(on.setAttackTarget("a", "ninguem"), "invalid_target");

    const off = zone(false);
    off.join(new Member("a"), { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    off.join(new Member("b"), { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    assert.strictEqual(off.setAttackTarget("a", "b"), "invalid_target");
    assert.strictEqual(off.setAttackTarget("a", "dummy"), "ok", "monstro continua valendo");
  });

  it("jogador morto não anda, renasce com vida cheia e regenera", () => {
    const z = zone();
    const a = new Member("a");
    const b = new Member("b");
    const lethal: AbilityDef = { ...SWORD, damage: PLAYER_MAX_HP, cooldown: 0.05, castTime: 0.05 };
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, lethal);
    z.join(b, { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    z.setAttackTarget("a", "b");
    z.tick();
    z.tick();
    assert.strictEqual(z.getSnapshot("b")?.dead, true);
    z.queueInput("b", { seq: 1, x: 1, z: 0 });
    z.tick();
    assert.strictEqual(z.getSnapshot("b")?.x, 1, "morto não anda");
    const me: unknown = b.last["me"];
    assert.ok(typeof me === "object" && me !== null && "respawnIn" in me && typeof me.respawnIn === "number" && me.respawnIn > 0);
    for (let i = 0; i < PLAYER_RESPAWN_SECONDS * TICK_RATE_HZ; i++) z.tick();
    assert.strictEqual(z.getSnapshot("b")?.dead, false);
    assert.strictEqual(z.getSnapshot("b")?.hp, PLAYER_MAX_HP);
  });
});

import assert from "assert";

import { Zone, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { DUMMY_MAX_HP, DUMMY_RESPAWN_SECONDS, PLAYER_MAX_HP, PLAYER_MAX_MANA, PLAYER_RESPAWN_SECONDS } from "../src/combat/stats.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import { SnapshotView, attackFor, strike } from "./helpers.js";

/** Membro falso que guarda o último snapshot (decodificado). */
class Member implements ZoneMember {
  readonly name: string;
  last: Record<string, unknown> = {};
  /** Estado inteiro montado dos snapshots por diferença (como o cliente). */
  private readonly snapshots: SnapshotView = new SnapshotView();
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || !("data" in decoded)) return;
    if (decoded.type !== "snapshot" || typeof decoded.data !== "object" || decoded.data === null) return;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decoded.data)) data[k] = v;
    this.last = this.snapshots.apply(data);
  }
  /** Eventos do último snapshot. */
  events(): Array<Record<string, unknown>> {
    const events: unknown = this.last["events"];
    return Array.isArray(events) ? events : [];
  }
}

/** Ataque de espada só do teste: leque de 90° da espada do Cavaleiro, com números redondos. */
const SWORD: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), id: "sword_attack", range: 2.5, cooldown: 1, castTime: 1, damage: 10 };
const STAFF: AbilityDef = ITEMS["arcane_staff"]?.basicAttack ?? UNARMED_ATTACK;
const DAGGERS: AbilityDef = ITEMS["assassin_daggers"]?.basicAttack ?? UNARMED_ATTACK;

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

  it("golpe sai na hora (sem carregamento); outro só depois do tempo de execução", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    const execTicks: number = SWORD.castTime * TICK_RATE_HZ;
    assert.deepStrictEqual(strike(z, "a", "dummy"), { ok: true });
    z.tick();
    const start = a.events().find((e) => e["type"] === "cast_start");
    assert.ok(start !== undefined && start["instant"] === true && start["target"] === "" && start["arc"] === SWORD.arc, "cast_start do golpe livre");
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP - SWORD.damage, "dano na hora");
    for (let i = 0; i < execTicks - 4; i++) {
      const refused = strike(z, "a", "dummy");
      assert.ok(!refused.ok && refused.reason === "busy", "golpe anterior ainda executando");
      z.tick();
    }
    for (let i = 0; i < 4; i++) z.tick();
    assert.deepStrictEqual(strike(z, "a", "dummy"), { ok: true }, "acabou a execução: sai outro");
    z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP - 2 * SWORD.damage);
  });

  it("vira para a direção do golpe", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: Math.PI / 2 }, SWORD); // de lado para o boneco
    strike(z, "a", "dummy"); // boneco em (0, -2): à frente (-Z) → rotY 0
    z.tick();
    const rot: number | undefined = z.getSnapshot("a")?.rotY;
    assert.ok(rot !== undefined && Math.abs(Math.atan2(Math.sin(rot), Math.cos(rot))) < 0.2, `virado para o boneco (rotY=${rot})`);
  });

  it("espada: leque de 90° acerta todos dentro; fora do ângulo ou do alcance, não", () => {
    const z = new Zone({
      id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true,
      dummies: [
        { id: "frente", name: "B", x: 0, z: -2 },
        { id: "diagonal", name: "B", x: 1.2, z: -1.6 }, // ~37° da frente: dentro dos 45°
        { id: "lado", name: "B", x: 2, z: 0 }, // 90°: fora
        { id: "atras", name: "B", x: 0, z: 2 },
        { id: "longe", name: "B", x: 0, z: -4 },
      ],
    });
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    z.castAbility("a", { abilityId: SWORD.id, targetId: null, x: 0, z: -1, seq: null });
    z.tick();
    const hit = new Set(a.events().filter((e) => e["type"] === "damage").map((e) => e["target"]));
    assert.deepStrictEqual([...hit].sort(), ["diagonal", "frente"]);
  });

  it("adagas: um alvo só (o mais perto) e o golpe vem com um passo à frente", () => {
    const z = new Zone({
      id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, moveBuffer: 1,
      dummies: [{ id: "perto", name: "B", x: 0, z: -3 }, { id: "atras_dele", name: "B", x: 0.3, z: -3.5 }],
    });
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, DAGGERS);
    // Com seq: vai na fila de movimento (o cliente prevê o passo, [JOGO-07]).
    assert.deepStrictEqual(z.castAbility("a", { abilityId: DAGGERS.id, targetId: null, x: 0, z: -1, seq: 1 }), { ok: true });
    z.tick();
    const hits = a.events().filter((e) => e["type"] === "damage");
    assert.strictEqual(hits.length, 1, "um alvo");
    assert.strictEqual(hits[0]?.["target"], "perto", "o mais perto (alcançado graças ao passo)");
    let seq = 1;
    for (let i = 0; i < DAGGERS.dashSeconds * TICK_RATE_HZ + 1; i++) {
      z.queueInput("a", { seq: ++seq, x: 0, z: 0 });
      z.tick();
    }
    const after: number = z.getSnapshot("a")?.z ?? 0;
    assert.ok(Math.abs(after + DAGGERS.dashDistance) < 0.05, `andou ${DAGGERS.dashDistance} m (z=${after})`);
  });

  it("cajado: faísca em linha acerta o primeiro inimigo do caminho; dá para desviar", () => {
    const z = zone();
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, STAFF);
    strike(z, "a", "dummy");
    let hit = false;
    for (let i = 0; i < TICK_RATE_HZ; i++) {
      z.tick();
      hit ||= a.events().some((e) => e["type"] === "damage" && e["target"] === "dummy" && e["amount"] === STAFF.damage);
    }
    assert.ok(hit, "acertou o boneco na linha");
    const before: number = hpOf(a, "dummy");
    z.castAbility("a", { abilityId: STAFF.id, targetId: null, x: 1, z: 0, seq: null }); // para o lado: erra
    for (let i = 0; i < TICK_RATE_HZ; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), before, "tiro para outro lado não acerta");
  });

  it("boneco morre e reaparece", () => {
    const z = zone();
    const a = new Member("a");
    const hit: AbilityDef = { ...SWORD, damage: DUMMY_MAX_HP, cooldown: 0.05, castTime: 0.05 };
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, hit);
    strike(z, "a", "dummy");
    z.tick();
    assert.ok(a.events().some((e) => e["type"] === "death" && e["id"] === "dummy" && e["killer"] === "a"));
    for (let i = 0; i < DUMMY_RESPAWN_SECONDS * TICK_RATE_HZ; i++) z.tick();
    assert.strictEqual(hpOf(a, "dummy"), DUMMY_MAX_HP);
  });

  it("PvP: o golpe acerta jogador só com pvp ligado; nunca você mesmo", () => {
    const on = zone(true);
    const a = new Member("a");
    on.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    on.join(new Member("b"), { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    strike(on, "a", "b");
    on.tick();
    assert.ok(a.events().some((e) => e["type"] === "damage" && e["target"] === "b"));
    assert.ok(!a.events().some((e) => e["type"] === "damage" && e["target"] === "a"));

    const off = zone(false);
    const c = new Member("a");
    off.join(c, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    off.join(new Member("b"), { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    strike(off, "a", "b");
    off.tick();
    assert.ok(!c.events().some((e) => e["type"] === "damage" && e["target"] === "b"), "sem pvp: não acerta");
  });

  it("jogador morto não anda, renasce com vida cheia e regenera", () => {
    const z = zone();
    const a = new Member("a");
    const b = new Member("b");
    const lethal: AbilityDef = { ...SWORD, damage: PLAYER_MAX_HP, cooldown: 0.05, castTime: 0.05 };
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, lethal);
    z.join(b, { x: 1, y: 0, z: 0, rotY: 0 }, SWORD);
    attackFor(z, "a", "b", 1);
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

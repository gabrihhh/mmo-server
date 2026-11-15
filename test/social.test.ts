import assert from "assert";

import { Zone, type DummyConfig, type FakePlayerConfig, type ZoneMember } from "../src/zones/Zone.js";
import { placeFakePlayers, placeTestNpcs, TEST_FAKE_PLAYERS, ZONE_CONFIGS } from "../src/zones/zones.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { PLAYER_MAX_HP, PLAYER_MAX_MANA, PLAYER_RESPAWN_SECONDS } from "../src/combat/stats.js";
import { playerFactor } from "../src/progression/level.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";

/** Social, etapa 1 ([SOC-01], [SOC-02]): jogadores fake de teste e a mensagem de Atributos. */

/** Membro que guarda o último snapshot recebido. */
class Member implements ZoneMember {
  readonly name: string;
  last: Record<string, unknown> = {};
  readonly damaged: string[] = [];
  readonly deaths: string[] = [];
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
    if (!Array.isArray(events)) return;
    for (const e of events) {
      if (typeof e === "object" && e !== null && "type" in e && e.type === "damage" && "target" in e && typeof e.target === "string") {
        this.damaged.push(e.target);
      }
      if (typeof e === "object" && e !== null && "type" in e && e.type === "death" && "id" in e && typeof e.id === "string") this.deaths.push(e.id);
    }
  }
  /** Ids da lista `players` do último snapshot. */
  playerIds(): string[] {
    const list: unknown = this.last["players"];
    if (!Array.isArray(list)) return [];
    return list.flatMap((e: unknown): string[] => (typeof e === "object" && e !== null && "id" in e && typeof e.id === "string" ? [e.id] : []));
  }
  /** Campo `field` do jogador `id` no último snapshot. */
  field(id: string, field: string): unknown {
    const list: unknown = this.last["players"];
    if (!Array.isArray(list)) return undefined;
    for (const e of list) if (typeof e === "object" && e !== null && "id" in e && e.id === id) return (e as Record<string, unknown>)[field];
    return undefined;
  }
}

const ACCEPT: FakePlayerConfig = {
  id: "fake_accept",
  name: "Fake Aceita",
  x: 0,
  z: 0,
  body: "female",
  level: 3,
  look: { hand: "healer_tome", head: null, chest: "knight_plate", feet: null },
  autoReply: "accept",
};
const REJECT: FakePlayerConfig = { ...ACCEPT, id: "fake_reject", name: "Fake Recusa", x: 4, autoReply: "reject", look: { hand: null, head: null, chest: null, feet: null } };
/** Zumbi em cima dos fakes, com percepção grande: se pudesse, atacaria. */
const ZOMBIE: DummyConfig = {
  id: "zombie",
  name: "Zumbi",
  x: 1,
  z: 0,
  body: "zombie",
  behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 30, leashRadius: 60, speed: 3.5 },
};

function zone(dummies: readonly DummyConfig[] = [], maxPlayers: number = 10): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers, spawnRadius: 0, pvp: true, dummies, fakePlayers: [ACCEPT, REJECT] });
}

function ticks(z: Zone, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * TICK_RATE_HZ); i++) z.tick();
}

describe("jogadores fake de teste", () => {
  it("aparecem como jogadores (welcome e snapshot), mas não contam como online nem lotam a zona", () => {
    const z: Zone = zone([], 1);
    assert.strictEqual(z.size, 0);
    const a = new Member("a");
    const joined = z.join(a, { x: 2, y: 0, z: 0, rotY: 0 });
    assert.strictEqual(joined.status, "joined");
    if (joined.status !== "joined") return;
    const names: string[] = joined.players.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ["Fake Aceita", "Fake Recusa", "a"]);
    const fake = joined.players.find((p) => p.id === "fake_accept");
    assert.strictEqual(fake?.body, "female");
    assert.strictEqual(fake?.level, 3);
    assert.strictEqual(fake?.look.hand, "healer_tome");
    assert.strictEqual(z.size, 1, "fake não conta como online");
    z.tick();
    assert.deepStrictEqual(a.playerIds().sort(), ["a", "fake_accept", "fake_reject"]);
    assert.strictEqual(z.join(new Member("b")).status, "full", "maxPlayers = 1 conta só os de verdade");
  });

  it("vida extra dos itens e nível valem como no jogador; ficam parados", () => {
    const z: Zone = zone();
    const a = new Member("a");
    z.join(a, { x: 2, y: 0, z: 0, rotY: 0 });
    ticks(z, 1);
    const bonus: number = ITEMS["knight_plate"]?.bonusHp ?? 0;
    assert.ok(bonus > 0);
    assert.strictEqual(a.field("fake_accept", "maxHp"), Math.round((PLAYER_MAX_HP + bonus) * playerFactor(3) * 10) / 10);
    assert.deepStrictEqual([a.field("fake_accept", "x"), a.field("fake_accept", "z")], [0, 0]);
  });

  it("monstro não ataca o fake, mas o jogador com PvP sim; morto, renasce no mesmo lugar", () => {
    const z: Zone = zone([ZOMBIE]);
    // Único jogador de verdade fica longe (fora da percepção de 30 m): perto do zumbi só os fakes.
    const far = new Member("far");
    z.join(far, { x: 100, y: 0, z: 100, rotY: 0 });
    ticks(z, 5);
    assert.ok(!far.damaged.includes("fake_accept") && !far.damaged.includes("fake_reject"), "zumbi não bate no fake");

    // Jogador ao lado do Fake Recusa (x = 4), com PvP, bate nele.
    const sword: AbilityDef = ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK;
    const b = new Member("b");
    z.join(b, { x: 5.5, y: 0, z: 0, rotY: 0 }, sword);
    assert.strictEqual(z.setAttackTarget("b", "fake_reject"), "ok");
    ticks(z, 3);
    assert.ok(b.damaged.includes("fake_reject"), "jogador com PvP bate no fake");
    ticks(z, 30);
    assert.ok(b.deaths.includes("fake_reject"), "fake morre");
    ticks(z, PLAYER_RESPAWN_SECONDS + 1);
    assert.strictEqual(b.field("fake_reject", "dead"), false);
    assert.deepStrictEqual([b.field("fake_reject", "x"), b.field("fake_reject", "z")], [4, 0], "renasce no lugar dele");
  });

  it("autoReplyOf diz como o fake responde (null para jogador de verdade)", () => {
    const z: Zone = zone();
    z.join(new Member("a"));
    assert.strictEqual(z.autoReplyOf("fake_accept"), "accept");
    assert.strictEqual(z.autoReplyOf("fake_reject"), "reject");
    assert.strictEqual(z.autoReplyOf("a"), null);
    assert.strictEqual(z.autoReplyOf("ninguem"), null);
  });

  it("Zone 1 sem fakes (tirados); placeFakePlayers usa o lugar do mapa ou o padrão; o id do fake no mapa não vira NPC", () => {
    assert.deepStrictEqual(ZONE_CONFIGS[0]?.fakePlayers ?? [], [], "fakes fora do jogo");
    assert.deepStrictEqual(TEST_FAKE_PLAYERS.map((f) => [f.name, f.autoReply]), [["Fake Aceita", "accept"], ["Fake Recusa", "reject"]]);
    const placed = placeFakePlayers({ monsters: [], npcs: [{ id: "fake_reject", x: -3, z: 9 }] });
    assert.deepStrictEqual([placed[0]?.x, placed[0]?.z], [TEST_FAKE_PLAYERS[0]?.x, TEST_FAKE_PLAYERS[0]?.z]);
    assert.deepStrictEqual([placed[1]?.x, placed[1]?.z], [-3, 9]);
    assert.deepStrictEqual(placeTestNpcs({ monsters: [], npcs: [{ id: "fake_accept", x: 0, z: 0 }] }), []);
  });
});

describe("atributos (inspect)", () => {
  it("nome, nível, vida/mana máximas, força pelo nível e itens vestidos", () => {
    const z: Zone = zone();
    const view = z.attributes("fake_accept");
    assert.ok(view !== undefined);
    const factor: number = playerFactor(3);
    assert.strictEqual(view.name, "Fake Aceita");
    assert.strictEqual(view.level, 3);
    assert.strictEqual(view.maxMana, Math.round(PLAYER_MAX_MANA * factor * 10) / 10);
    assert.deepStrictEqual(view.power, { damage: factor, healing: factor, shield: factor });
    assert.deepStrictEqual(view.equipped.hand, { itemId: "healer_tome", name: ITEMS["healer_tome"]?.name, set: ITEMS["healer_tome"]?.set });
    assert.strictEqual(view.equipped.head, null);
    assert.strictEqual(z.attributes("ninguem"), undefined);
  });

  it("jogador de verdade: o que veste agora e o nível dele", () => {
    const z: Zone = zone();
    z.join(new Member("a"), undefined, UNARMED_ATTACK, new Map(), { hand: "knight_sword", head: null, chest: null, feet: null }, 0, { level: 10, xp: 0, gold: 0 });
    const view = z.attributes("a");
    assert.strictEqual(view?.level, 10);
    assert.strictEqual(view?.equipped.hand?.itemId, "knight_sword");
    assert.strictEqual(view?.power.damage, playerFactor(10));
  });
});

import assert from "assert";

import { CAMP_IDLE_RESET_SECONDS, CHEST_OPEN_SECONDS, CHEST_RANGE, CHEST_RESET_AFTER_OPEN_SECONDS, Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import type { Progress } from "../src/progression/level.js";
import { keepAttacking } from "./helpers.js";

/** Membro falso: guarda os eventos de todos os snapshots e o progresso salvo. */
class Member implements ZoneMember {
  readonly name: string;
  readonly events: Array<Record<string, unknown>> = [];
  saved: Progress | null = null;
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Reflect.get(decoded, "type") !== "snapshot") return;
    const data: unknown = Reflect.get(decoded, "data");
    const list: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "events") : null;
    if (Array.isArray(list)) for (const event of list) if (typeof event === "object" && event !== null) this.events.push(Object.fromEntries(Object.entries(event)));
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
}

/** Golpe que mata na hora (os zumbis têm 1 de vida) e alcança os três. */
const KILL: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), damage: 9999, range: 6, castTime: 0.05, cooldown: 0.05, arc: 0.05, maxTargets: 1 };

const zombie = (id: string, x: number, z: number, level: number, boss: boolean = false): DummyConfig => ({
  id,
  name: id,
  x,
  z,
  level,
  maxHp: 1,
  damageMultiplier: 0,
  respawnSeconds: 2,
  boss,
  body: "zombie",
  behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 0.1, leashRadius: 50, speed: 0 },
});

function campZone(): Zone {
  return new Zone({
    id: "t",
    halfSize: 150,
    maxPlayers: 10,
    spawnRadius: 0,
    pvp: false,
    dummies: [zombie("z1", -1, -3, 2), zombie("z2", 0, -3, 4), zombie("z3", 1, -3, 3)],
    camps: [{ id: "camp", x: 0, z: -1, monsterIds: ["z1", "z2", "z3"] }],
  });
}

function ticks(zone: Zone, count: number): void {
  for (let i = 0; i < count; i++) zone.tick();
}

/** Ataca cada zumbi até morrer (sem esperar o reaparecer). */
function killAll(zone: Zone, playerId: string, ids: readonly string[]): void {
  for (const id of ids) {
    keepAttacking(zone, playerId, id);
    for (let i = 0; i < 10; i++) zone.tick();
  }
}

/** Baús dos acampamentos ([JOGO-19]). */
describe("baús dos acampamentos", () => {
  it("fechado até os três morrerem juntos; abre com sorteio só para quem ajudou", () => {
    const zone = campZone();
    const a = new Member("a");
    const b = new Member("b");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    zone.join(b, { x: 1, y: 0, z: 0, rotY: 0 });
    assert.deepStrictEqual(zone.chestViews().map((c) => [c.id, c.open, c.level, c.boss]), [["camp", false, 4, false]]);
    assert.strictEqual(zone.chestLoot("a", "camp"), "chest_closed");
    killAll(zone, "a", ["z1", "z2", "z3"]);
    assert.ok(a.events.some((e) => e["type"] === "chest" && e["id"] === "camp" && e["open"] === true), "evento de abrir");
    assert.ok(b.events.some((e) => e["type"] === "chest" && e["open"] === true), "todos da zona veem o baú abrir");
    const loot = zone.chestLoot("a", "camp");
    assert.ok(Array.isArray(loot) && loot.length >= 2, "itens + moedas para quem matou");
    assert.deepStrictEqual(zone.chestLoot("b", "camp"), [], "quem não ajudou: nada");
  });

  it("pegar: moedas vão para o progresso; item precisa de espaço na mochila; longe não pega", () => {
    const zone = campZone();
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    killAll(zone, "a", ["z1", "z2", "z3"]);
    const loot = zone.chestLoot("a", "camp");
    assert.ok(Array.isArray(loot));
    const goldBefore: number = a.saved?.gold ?? 0;
    const gold = zone.takeLoot("a", "camp", "gold", true);
    assert.ok(typeof gold === "object" && gold.kind === "gold");
    assert.strictEqual(a.saved?.gold, goldBefore + gold.amount, "moedas no progresso (salvo)");
    const item = loot.find((entry) => entry.kind === "item");
    assert.ok(item);
    assert.strictEqual(zone.takeLoot("a", "camp", item.lootId, false), "bag_full", "mochila cheia: fica no baú");
    const taken = zone.takeLoot("a", "camp", item.lootId, true);
    assert.ok(typeof taken === "object" && taken.kind === "item" && taken.stack.itemId === (item.kind === "item" ? item.stack.itemId : ""));
    assert.strictEqual(zone.takeLoot("a", "camp", item.lootId, true), "loot_not_found", "não pega duas vezes");

    // Longe do baú: recusa.
    for (let seq = 1; seq <= Math.ceil(((CHEST_RANGE + 3) / 5) * TICK_RATE_HZ) + 5; seq++) {
      zone.queueInput("a", { seq, x: 1, z: 0 });
      zone.tick();
    }
    assert.strictEqual(zone.chestLoot("a", "camp"), "too_far");
  });

  it("alguém (que ajudou) abriu o baú: o acampamento inteiro volta 1 min depois", () => {
    const zone = campZone();
    const a = new Member("a");
    const b = new Member("b");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    zone.join(b, { x: 0.5, y: 0, z: 0, rotY: 0 });
    killAll(zone, "a", ["z1", "z2", "z3"]);
    keepAttacking(zone, "a", null);
    ticks(zone, 10 * TICK_RATE_HZ);
    assert.ok(Array.isArray(zone.chestLoot("b", "camp")), "b (não ajudou) olha o baú vazio");
    ticks(zone, 2);
    assert.ok((zone.chestViews()[0]?.resetIn ?? 0) > CHEST_OPEN_SECONDS - 15, "quem não ajudou não encurta o prazo");
    assert.ok(Array.isArray(zone.chestLoot("a", "camp")));
    ticks(zone, 2);
    const left: number = zone.chestViews()[0]?.resetIn ?? 0;
    assert.ok(Math.abs(left - CHEST_RESET_AFTER_OPEN_SECONDS) < 0.5, `1 min a partir de agora (${left})`);
    assert.ok(a.events.some((e) => e["type"] === "chest" && e["open"] === true && Math.abs(Number(e["resetIn"]) - CHEST_RESET_AFTER_OPEN_SECONDS) < 0.5), "evento com o relógio novo");
    ticks(zone, CHEST_RESET_AFTER_OPEN_SECONDS * TICK_RATE_HZ);
    assert.strictEqual(zone.chestViews()[0]?.open, false, "fechou");
    assert.strictEqual(a.events.filter((e) => e["type"] === "respawn").length, 3, "os três voltaram juntos");
  });

  it("depois de CHEST_OPEN_SECONDS (ninguém abriu) o acampamento volta: zumbis vivos, baú fechado e vazio", () => {
    const zone = campZone();
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    killAll(zone, "a", ["z1", "z2", "z3"]);
    keepAttacking(zone, "a", null);
    // Aberto: os zumbis NÃO voltam sozinhos (reaparecer de 2 s ignorado).
    for (let i = 0; i < 5 * TICK_RATE_HZ; i++) zone.tick();
    assert.strictEqual(zone.chestViews()[0]?.open, true);
    for (let i = 0; i < CHEST_OPEN_SECONDS * TICK_RATE_HZ; i++) zone.tick();
    assert.strictEqual(zone.chestViews()[0]?.open, false, "fechou");
    assert.ok(a.events.some((e) => e["type"] === "chest" && e["open"] === false), "evento de fechar");
    assert.ok(a.events.filter((e) => e["type"] === "respawn").length >= 3, "os três voltaram");
    assert.strictEqual(zone.chestLoot("a", "camp"), "chest_closed");
  });

  it("matar só parte: os mortos NÃO voltam sozinhos; 1 min sem combate e voltam todos juntos (relógio no evento)", () => {
    const zone = campZone();
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    killAll(zone, "a", ["z1", "z2"]);
    keepAttacking(zone, "a", null);
    ticks(zone, 5 * TICK_RATE_HZ);
    assert.strictEqual(zone.chestViews()[0]?.open, false);
    assert.ok(!a.events.some((e) => e["type"] === "respawn"), "o reaparecer de 2 s não vale no acampamento");
    // Relógio da volta no evento e no welcome (para o mapa).
    const timer = a.events.find((e) => e["type"] === "chest" && typeof e["resetIn"] === "number" && e["resetIn"] > 0);
    assert.ok(timer, "evento com o relógio");
    assert.ok(Math.abs(Number(timer["resetIn"]) - CAMP_IDLE_RESET_SECONDS) < 0.5, `começa em ~60 s (${String(timer["resetIn"])})`);
    const left: number = zone.chestViews()[0]?.resetIn ?? 0;
    assert.ok(left > CAMP_IDLE_RESET_SECONDS - 6 && left < CAMP_IDLE_RESET_SECONDS - 4, `welcome conta o tempo (${left})`);
    ticks(zone, (CAMP_IDLE_RESET_SECONDS - 5) * TICK_RATE_HZ + 2);
    const back: string[] = a.events.filter((e) => e["type"] === "respawn").map((e) => String(e["id"]));
    assert.deepStrictEqual(back.sort(), ["z1", "z2"], "os dois mortos voltaram juntos");
    assert.strictEqual(zone.chestViews()[0]?.resetIn, 0, "sem relógio de novo");
  });

  it("combate no acampamento segura o relógio (zumbis lutando = o morto não volta)", () => {
    // Percepção de 10 m: z2 e z3 vêm lutar com o jogador (sem dano) e não param.
    const aggro = (config: DummyConfig): DummyConfig => ({
      ...config,
      behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 10, leashRadius: 50, speed: 0 },
    });
    const zone = new Zone({
      id: "t",
      halfSize: 150,
      maxPlayers: 10,
      spawnRadius: 0,
      pvp: false,
      dummies: [zombie("z1", -1, -3, 2), aggro(zombie("z2", 0, -3, 4)), aggro(zombie("z3", 1, -3, 3))],
      camps: [{ id: "camp", x: 0, z: -1, monsterIds: ["z1", "z2", "z3"] }],
    });
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, KILL);
    killAll(zone, "a", ["z1"]);
    keepAttacking(zone, "a", null);
    ticks(zone, (CAMP_IDLE_RESET_SECONDS + 10) * TICK_RATE_HZ);
    assert.ok(!a.events.some((e) => e["type"] === "respawn"), "lutando: não volta");
    assert.strictEqual(zone.chestViews()[0]?.resetIn, 0, "sem relógio durante o combate");
  });

  it("acampamento com chefe: o baú marca chefe (loot maior) e o nível é o dos zumbis comuns", () => {
    const zone = new Zone({
      id: "t",
      halfSize: 150,
      maxPlayers: 10,
      spawnRadius: 0,
      pvp: false,
      dummies: [zombie("z1", 0, -3, 6), zombie("boss", 1, -3, 12, true)],
      camps: [{ id: "camp", x: 0, z: -1, monsterIds: ["z1", "boss"] }],
    });
    assert.deepStrictEqual(zone.chestViews().map((c) => [c.level, c.boss]), [[6, true]]);
  });
});

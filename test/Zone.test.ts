import assert from "assert";

import { MAX_INPUT_QUEUE, MAX_INPUTS_PER_TICK, NO_LOOK, Zone, type ZoneMember } from "../src/zones/Zone.js";
import { UNARMED_ATTACK } from "../src/items/catalog.js";
import type { Look } from "../src/net/protocol.js";
import { MOVE_SPEED, TICK_SECONDS } from "../src/sim/movement.js";

/** Membro falso que guarda as mensagens recebidas, já decodificadas. */
class FakeMember implements ZoneMember {
  readonly received: Array<{ type: string; data: unknown }> = [];
  readonly name: string;
  constructor(readonly id: string) {
    this.name = `Nome_${id}`;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded === "object" && decoded !== null && "type" in decoded && "data" in decoded) {
      this.received.push({ type: String(decoded.type), data: decoded.data });
    }
  }
  types(): string[] {
    return this.received.map((m) => m.type);
  }
}

const newZone = (maxPlayers: number = 50, pvp: boolean = true): Zone =>
  new Zone({ id: "test", halfSize: 150, maxPlayers, spawnRadius: 5, pvp, dummies: [{ id: "dummy", name: "Boneco", x: 0, z: -2 }] });

/** Vida cheia de jogador, como sai no snapshot. */
const FULL = { hp: 100, maxHp: 100, dead: false, shield: 0, speed: 1 };

describe("Zone", () => {
  it("devolve a lista de jogadores a quem entra e avisa player_joined aos outros", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    const ra = zone.join(a);
    const rb = zone.join(b);

    assert.ok(ra.status === "joined" && rb.status === "joined");
    assert.deepStrictEqual(rb.players.map((p) => p.id).sort(), ["a", "b"]);
    assert.deepStrictEqual(rb.players.map((p) => p.name).sort(), ["Nome_a", "Nome_b"], "welcome leva o nome");
    assert.deepStrictEqual(a.types(), ["player_joined"]);
    const joined: unknown = a.received[0]?.data;
    assert.ok(typeof joined === "object" && joined !== null && "player" in joined);
    const player: unknown = joined.player;
    assert.ok(typeof player === "object" && player !== null && "name" in player && player.name === "Nome_b");
    assert.deepStrictEqual(b.types(), []);
    assert.strictEqual(zone.size, 2);
  });

  it("usa o spawn informado, limitado às bordas", () => {
    const zone = newZone();
    zone.join(new FakeMember("a"), { x: 20, y: 1, z: -999, rotY: 2 });
    assert.deepStrictEqual(zone.getSnapshot("a"), { id: "a", x: 20, y: 1, z: -150, rotY: 2, ...FULL });
  });

  it("recusa entrada com a zona lotada", () => {
    const zone = newZone(1);
    assert.strictEqual(zone.join(new FakeMember("a")).status, "joined");
    assert.strictEqual(zone.join(new FakeMember("b")).status, "full");
    assert.strictEqual(zone.size, 1);
  });

  /** Último snapshot recebido por um membro (falha se não houver). */
  function lastSnapshot(member: FakeMember): { tick: number; ack: number; players: Array<Record<string, number | string>> } {
    const msg = member.received.filter((m) => m.type === "snapshot").at(-1);
    assert.ok(msg, "deveria ter recebido snapshot");
    const data: unknown = msg.data;
    assert.ok(typeof data === "object" && data !== null && "tick" in data && "ack" in data && "players" in data);
    assert.ok(typeof data.tick === "number" && typeof data.ack === "number" && Array.isArray(data.players));
    return { tick: data.tick, ack: data.ack, players: data.players };
  }

  it("cada tick aplica o input com a velocidade do servidor e manda snapshot com ack", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
    zone.join(b, { x: 10, y: 0, z: 10, rotY: 0 });

    zone.queueInput("a", { seq: 1, x: 1, z: 0 });
    zone.tick();

    // 5 m/s * 0,05 s = 0,25 m para +X; virado para +X => rotY = atan2(-1, -0) = -PI/2.
    assert.deepStrictEqual(zone.getSnapshot("a"), {
      id: "a",
      x: MOVE_SPEED * TICK_SECONDS,
      y: 0,
      z: 0,
      rotY: Math.atan2(-1, -0),
      ...FULL,
    });
    assert.strictEqual(lastSnapshot(a).ack, 1);
    assert.strictEqual(lastSnapshot(b).ack, 0, "b não mandou input");
    assert.strictEqual(lastSnapshot(b).tick, 1);
    assert.strictEqual(lastSnapshot(b).players.length, 2);

    zone.tick();
    assert.strictEqual(zone.getSnapshot("a")?.x, MOVE_SPEED * TICK_SECONDS, "sem input, fica parado");
  });

  it("anti-speedhack: normaliza direção > 1, limita inputs por tick e o tamanho da fila", () => {
    const zone = newZone();
    zone.join(new FakeMember("a"), { x: 0, y: 0, z: 0, rotY: 0 });

    zone.queueInput("a", { seq: 1, x: 1000, z: 0 });
    zone.tick();
    assert.strictEqual(zone.getSnapshot("a")?.x, MOVE_SPEED * TICK_SECONDS, "comprimento normalizado para 1");

    for (let seq = 2; seq <= 11; seq++) zone.queueInput("a", { seq, x: 1, z: 0 });
    zone.tick();
    const afterBurst: number = zone.getSnapshot("a")?.x ?? NaN;
    assert.ok(Math.abs(afterBurst - 3 * MOVE_SPEED * TICK_SECONDS) < 1e-9, `no máximo ${MAX_INPUTS_PER_TICK} por tick`);
    zone.tick();
    zone.tick();
    const total: number = zone.getSnapshot("a")?.x ?? NaN;
    assert.ok(Math.abs(total - (1 + MAX_INPUT_QUEUE) * MOVE_SPEED * TICK_SECONDS) < 1e-9, "fila limitada");
  });

  it("ignora seq repetido ou antigo e limita às bordas", () => {
    const zone = newZone();
    zone.join(new FakeMember("a"), { x: 149.9, y: 0, z: 0, rotY: 0 });
    zone.queueInput("a", { seq: 5, x: 1, z: 0 });
    zone.queueInput("a", { seq: 5, x: 1, z: 0 });
    zone.queueInput("a", { seq: 3, x: 1, z: 0 });
    zone.tick();
    zone.tick();
    assert.strictEqual(zone.getSnapshot("a")?.x, 150);
  });

  it("avisa player_left ao sair e ignora saída/input de quem não está", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    zone.join(a);
    zone.join(b);
    zone.leave("b");
    zone.leave("b");
    zone.queueInput("b", { seq: 1, x: 1, z: 1 });

    assert.deepStrictEqual(a.received.at(-1), { type: "player_left", data: { id: "b" } });
    assert.deepStrictEqual(a.types().filter((t) => t === "player_left"), ["player_left"]);
    assert.strictEqual(zone.size, 1);
  });
  it("aparência: vai no welcome/player_joined e a troca vira o evento look para todos", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    const sword: Look = { ...NO_LOOK, hand: "training_sword" };
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, new Map(), sword);
    const rb = zone.join(b);
    assert.ok(rb.status === "joined");
    assert.deepStrictEqual(rb.players.find((p) => p.id === "a")?.look, sword, "quem entra vê a espada de a");

    const staff: Look = { ...NO_LOOK, hand: "training_staff" };
    zone.setLoadout("a", UNARMED_ATTACK, new Map(), staff);
    zone.setLoadout("a", UNARMED_ATTACK, new Map(), staff); // igual: não repete o evento
    zone.tick();
    for (const member of [a, b]) {
      const snap = member.received.filter((m) => m.type === "snapshot").at(-1)?.data;
      assert.ok(typeof snap === "object" && snap !== null && "events" in snap && Array.isArray(snap.events));
      const looks: unknown[] = snap.events.filter((e: unknown) => typeof e === "object" && e !== null && "type" in e && e.type === "look");
      assert.deepStrictEqual(looks, [{ type: "look", id: "a", look: staff }]);
    }
  });
});

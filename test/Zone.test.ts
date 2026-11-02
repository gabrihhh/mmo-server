import assert from "assert";

import { Zone, type ZoneMember } from "../src/zones/Zone.js";

/** Membro falso que guarda as mensagens recebidas, já decodificadas. */
class FakeMember implements ZoneMember {
  readonly received: Array<{ type: string; data: unknown }> = [];
  constructor(readonly id: string) {}
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

const newZone = (maxPlayers: number = 50): Zone =>
  new Zone({ id: "test", halfSize: 150, maxPlayers, spawnRadius: 5 });

describe("Zone", () => {
  it("envia welcome a quem entra e player_joined aos outros", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    assert.strictEqual(zone.join(a), "joined");
    assert.strictEqual(zone.join(b), "joined");

    assert.deepStrictEqual(a.types(), ["welcome", "player_joined"]);
    assert.deepStrictEqual(b.types(), ["welcome"]);
    assert.strictEqual(zone.size, 2);
  });

  it("recusa entrada com a zona lotada", () => {
    const zone = newZone(1);
    assert.strictEqual(zone.join(new FakeMember("a")), "joined");
    assert.strictEqual(zone.join(new FakeMember("b")), "full");
    assert.strictEqual(zone.size, 1);
  });

  it("limita o move às bordas e só envia positions no tick, para quem mudou", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    zone.join(a);
    zone.join(b);
    a.received.length = 0;
    b.received.length = 0;

    zone.tick();
    assert.strictEqual(b.received.length, 0, "sem movimento, sem mensagem");

    zone.move("a", { x: 9999, y: 1, z: -9999, rotY: 0.5 });
    assert.deepStrictEqual(zone.getSnapshot("a"), { id: "a", x: 150, y: 1, z: -150, rotY: 0.5 });
    zone.tick();
    assert.deepStrictEqual(b.received, [
      { type: "positions", data: { players: [{ id: "a", x: 150, y: 1, z: -150, rotY: 0.5 }] } },
    ]);

    zone.tick();
    assert.strictEqual(b.received.length, 1, "dirty é limpo após o tick");
  });

  it("avisa player_left ao sair e ignora saída/move de quem não está", () => {
    const zone = newZone();
    const a = new FakeMember("a");
    const b = new FakeMember("b");
    zone.join(a);
    zone.join(b);
    zone.leave("b");
    zone.leave("b");
    zone.move("b", { x: 1, y: 0, z: 1, rotY: 0 });

    assert.deepStrictEqual(a.received.at(-1), { type: "player_left", data: { id: "b" } });
    assert.deepStrictEqual(a.types().filter((t) => t === "player_left"), ["player_left"]);
    assert.strictEqual(zone.size, 1);
  });
});

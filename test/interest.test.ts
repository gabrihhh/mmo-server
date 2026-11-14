import assert from "assert";

import { VIEW_RADIUS, Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";

/** Membro falso: guarda os ids de jogadores e NPCs do último snapshot. */
class Member implements ZoneMember {
  readonly name: string;
  players: string[] = [];
  npcs: string[] = [];
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Reflect.get(decoded, "type") !== "snapshot") return;
    const data: unknown = Reflect.get(decoded, "data");
    const ids = (key: string): string[] => {
      const list: unknown = typeof data === "object" && data !== null ? Reflect.get(data, key) : null;
      return Array.isArray(list) ? list.map((e: unknown) => String(typeof e === "object" && e !== null ? Reflect.get(e, "id") : "")) : [];
    };
    this.players = ids("players");
    this.npcs = ids("npcs");
  }
  onProgress(): void {}
}

const dummy = (id: string, x: number, z: number): DummyConfig => ({ id, name: id, x, z });

/** Área de interesse ([INFRA-04]): cada jogador recebe só quem está perto, ele mesmo e o alvo dele. */
describe("área de interesse do snapshot", () => {
  it("manda só jogadores e NPCs até VIEW_RADIUS m; o alvo vem mesmo longe", () => {
    const zone = new Zone({
      id: "t",
      halfSize: 150,
      maxPlayers: 10,
      spawnRadius: 0,
      pvp: false,
      dummies: [dummy("perto", 0, VIEW_RADIUS - 5), dummy("longe", 0, VIEW_RADIUS + 20), dummy("alvo", 0, -VIEW_RADIUS - 20)],
    });
    const a = new Member("a");
    const b = new Member("b");
    const c = new Member("c");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
    zone.join(b, { x: 10, y: 0, z: 0, rotY: 0 });
    zone.join(c, { x: 120, y: 0, z: 0, rotY: 0 });
    zone.tick();
    assert.deepStrictEqual(a.players.sort(), ["a", "b"]);
    assert.deepStrictEqual(a.npcs, ["perto"]);
    assert.deepStrictEqual(c.players, ["c"]);
    assert.deepStrictEqual(c.npcs, []);
    zone.setAttackTarget("a", "alvo");
    zone.tick();
    assert.deepStrictEqual(a.npcs.sort(), ["alvo", "perto"]);
  });
});

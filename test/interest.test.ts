import assert from "assert";

import { MAX_VIEW_PLAYERS, VIEW_RADIUS, Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import { SnapshotView } from "./helpers.js";
import { UNARMED_ATTACK } from "../src/items/catalog.js";

/** Membro falso: guarda os ids de jogadores e NPCs na vista (montada dos snapshots por diferença, como o cliente). */
class Member implements ZoneMember {
  readonly name: string;
  players: string[] = [];
  npcs: string[] = [];
  /** Bytes de cada snapshot recebido. */
  readonly sizes: number[] = [];
  private readonly view: SnapshotView = new SnapshotView();
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Reflect.get(decoded, "type") !== "snapshot") return;
    this.sizes.push(text.length);
    const raw: unknown = Reflect.get(decoded, "data");
    const data: unknown = typeof raw === "object" && raw !== null ? this.view.apply(Object.fromEntries(Object.entries(raw))) : raw;
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

  it("só manda o que mudou: parado não vai de novo; andou vai só a posição ([INFRA-11])", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies: [dummy("boneco", 0, 5)] });
    const raw: Array<Record<string, unknown>> = [];
    const a = new Member("a");
    const spy: ZoneMember = { id: "a", name: "a", send: (t: string): void => { a.send(t); raw.push(JSON.parse(t).data); } };
    zone.join(spy, { x: 0, y: 0, z: 0, rotY: 0 });
    const b = new Member("b");
    zone.join(b, { x: 3, y: 0, z: 0, rotY: 0 });
    zone.tick();
    zone.tick();
    const idle = raw.at(-1);
    assert.deepStrictEqual([idle?.["players"], idle?.["npcs"], idle?.["gone"], idle?.["events"]], [[], [], [], []], "nada mudou: listas vazias");
    assert.deepStrictEqual(idle?.["me"], {}, "me sem mudança");
    zone.queueInput("b", { seq: 1, x: 1, z: 0 });
    zone.tick();
    assert.deepStrictEqual(raw.at(-1)?.["players"], [{ id: "b", x: 3.25, rotY: -1.57 }], "só o que mudou de b");
    // Antes (versão 21) eram ~700 bytes com os dois jogadores e o boneco inteiros.
    assert.ok((a.sizes.at(-1) ?? 0) < 160, `snapshot pequeno (${a.sizes.at(-1)} bytes)`);
  });

  it("quem sai da vista vai em gone; quem volta vem com todos os campos", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies: [] });
    const raw: Array<Record<string, unknown>> = [];
    const spy: ZoneMember = { id: "a", name: "a", send: (t: string): void => { raw.push(JSON.parse(t).data); } };
    zone.join(spy, { x: 0, y: 0, z: 0, rotY: 0 });
    zone.join(new Member("b"), { x: VIEW_RADIUS - 1, y: 0, z: 0, rotY: 0 });
    zone.tick();
    for (let seq = 1; seq <= 10; seq++) {
      zone.queueInput("b", { seq, x: 1, z: 0 });
      zone.tick();
    }
    assert.ok(raw.some((d) => Array.isArray(d["gone"]) && d["gone"].includes("b")), "b saiu da vista: gone");
    zone.leave("b");
    const c = new Member("c");
    zone.join(c, { x: 1, y: 0, z: 0, rotY: 0 });
    zone.tick();
    const entry: unknown = (raw.at(-1)?.["players"] as unknown[] | undefined)?.find((e) => typeof e === "object" && e !== null && Reflect.get(e, "id") === "c");
    assert.ok(typeof entry === "object" && entry !== null && "hp" in entry && "maxHp" in entry && "x" in entry, "entrou: todos os campos");
  });

  it("multidão: no máximo MAX_VIEW_PLAYERS na vista (os mais perto), o alvo entra sempre", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 200, spawnRadius: 0, pvp: true, dummies: [] });
    const a = new Member("a");
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 });
    for (let i = 0; i < MAX_VIEW_PLAYERS + 10; i++) zone.join(new Member("p" + i), { x: 1 + i * 0.5, y: 0, z: 0, rotY: 0 });
    zone.tick();
    assert.strictEqual(a.players.length, MAX_VIEW_PLAYERS + 1, "os 40 mais perto + ele mesmo");
    assert.ok(!a.players.includes("p" + (MAX_VIEW_PLAYERS + 9)), "o mais longe ficou de fora");
    zone.setAttackTarget("a", "p" + (MAX_VIEW_PLAYERS + 9));
    zone.tick();
    assert.ok(a.players.includes("p" + (MAX_VIEW_PLAYERS + 9)), "o alvo entra mesmo fora do limite");
  });

  it("eventos de combate longe não chegam; troca de roupa chega a todos", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [dummy("boneco", 100, 0)] });
    const events: string[] = [];
    const far: ZoneMember = {
      id: "far",
      name: "far",
      send: (t: string): void => {
        const d: unknown = JSON.parse(t).data;
        const list: unknown = typeof d === "object" && d !== null ? Reflect.get(d, "events") : null;
        if (Array.isArray(list)) for (const e of list) events.push(String(Reflect.get(e, "type")));
      },
    };
    zone.join(far, { x: -100, y: 0, z: 0, rotY: 0 });
    zone.join(new Member("fighter"), { x: 100, y: 0, z: 1, rotY: 0 });
    zone.setAttackTarget("fighter", "boneco");
    for (let i = 0; i < 40; i++) zone.tick();
    assert.ok(!events.includes("damage") && !events.includes("cast_start"), "a luta a 200 m não chega");
    zone.setLoadout("fighter", UNARMED_ATTACK, new Map(), { hand: "training_staff", head: null, chest: null, feet: null });
    zone.tick();
    assert.ok(events.includes("look"), "a roupa nova chega mesmo longe");
  });
});

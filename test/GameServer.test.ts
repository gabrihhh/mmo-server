import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
import { MOVE_SPEED, TICK_SECONDS } from "../src/sim/movement.js";
import { TestClient, sleep } from "./helpers.js";

const ZONE = "zone_1";

/** Resultado de {@link joined}. */
interface Joined {
  readonly client: TestClient;
  readonly playerId: string;
  readonly guestToken: string;
  readonly players: unknown[];
}

describe("GameServer", () => {
  let server: GameServer;
  let accounts: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  /** Conecta e entra na zona (com o token, se houver), devolvendo os dados do `welcome`. */
  async function joined(guestToken: string | null = null): Promise<Joined> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("join", { zone: ZONE, version: PROTOCOL_VERSION, guestToken });
    const welcome = await client.next("welcome");
    const playerId: unknown = welcome.data["playerId"];
    const token: unknown = welcome.data["guestToken"];
    const players: unknown = welcome.data["players"];
    assert.ok(typeof playerId === "string" && typeof token === "string" && Array.isArray(players));
    return { client, playerId, guestToken: token, players };
  }

  /** Lê o campo `id` de um objeto vindo da rede. */
  function idOf(value: unknown): unknown {
    return typeof value === "object" && value !== null && "id" in value ? value.id : undefined;
  }

  beforeEach(async () => {
    accounts = new InMemoryAccountStore();
    server = new GameServer({ accounts, heartbeatIntervalMs: 100, log: false });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("entra na zona e avisa os outros (player_joined / player_left)", async () => {
    const a = await joined();
    assert.strictEqual(a.players.length, 1);

    const b = await joined();
    assert.strictEqual(b.players.length, 2);
    const joinedMsg = await a.client.next("player_joined");
    assert.strictEqual(idOf(joinedMsg.data["player"]), b.playerId);

    await b.client.close();
    const left = await a.client.next("player_left");
    assert.strictEqual(left.data["id"], b.playerId);
    assert.strictEqual(server.getZone(ZONE)?.size, 1);
  });

  /** Entrada de `id` na lista `players` de um snapshot/welcome. */
  function entryOf(players: unknown, id: string): Record<string, unknown> | undefined {
    if (!Array.isArray(players)) return undefined;
    for (const p of players) {
      if (typeof p === "object" && p !== null && "id" in p && p.id === id) {
        const entry: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p)) entry[k] = v;
        return entry;
      }
    }
    return undefined;
  }

  it("servidor simula o input: confirma no ack e replica para os outros", async () => {
    const a = await joined();
    const b = await joined();
    const startX: unknown = entryOf(a.players, a.playerId)?.["x"];
    assert.ok(typeof startX === "number");

    a.client.send("input", { seq: 1, x: 1, z: 0 });
    const acked = await a.client.nextMatching("snapshot", (m) => m.data["ack"] === 1);
    const meAfter = entryOf(acked.data["players"], a.playerId);
    assert.ok(meAfter && typeof meAfter["x"] === "number");
    assert.ok(Math.abs(meAfter["x"] - (startX + MOVE_SPEED * TICK_SECONDS)) < 1e-9, "andou exatamente um tick");

    const seen = await b.client.nextMatching("snapshot", (m) => entryOf(m.data["players"], a.playerId)?.["x"] === meAfter["x"]);
    assert.strictEqual(seen.data["ack"], 0, "o ack de b é o de b, não o de a");
  });

  it("ignora o antigo `move` com posição (o cliente não diz onde está)", async () => {
    const a = await joined();
    a.client.send("move", { x: 100, y: 0, z: 100, rotY: 0 });
    const error = await a.client.next("error");
    assert.strictEqual(error.data["code"], "bad_message");
  });

  it("conta de convidado: mesmo token = mesmo jogador, voltando onde parou", async () => {
    const first = await joined();
    for (let seq = 1; seq <= 4; seq++) first.client.send("input", { seq, x: 0, z: 1 });
    const last = await first.client.nextMatching("snapshot", (m) => m.data["ack"] === 4);
    const where = entryOf(last.data["players"], first.playerId);
    await first.client.close();
    await sleep(20); // savePosition é assíncrono

    const again = await joined(first.guestToken);
    assert.strictEqual(again.playerId, first.playerId);
    assert.strictEqual(again.guestToken, first.guestToken);
    assert.deepStrictEqual(entryOf(again.players, first.playerId), where);
  });

  it("token desconhecido cria conta nova com token novo", async () => {
    const a = await joined("token-que-nao-existe");
    assert.notStrictEqual(a.guestToken, "token-que-nao-existe");
  });

  it("a mesma conta entrando de novo derruba a conexão antiga (4002)", async () => {
    const first = await joined();
    const second = await joined(first.guestToken);
    assert.strictEqual(await first.client.waitClose(), CloseCode.Replaced);
    assert.strictEqual(second.playerId, first.playerId);
    assert.strictEqual(server.getZone(ZONE)?.size, 1);
  });

  it("responde bad_message a mensagem inválida e mantém a conexão", async () => {
    const a = await joined();
    a.client.socket.send("lixo");
    const error = await a.client.next("error");
    assert.strictEqual(error.data["code"], "bad_message");
    assert.strictEqual(a.client.closeCode, null);
  });

  it("recusa versão de protocolo diferente e zona inexistente, fechando com 4000", async () => {
    for (const data of [
      { zone: ZONE, version: PROTOCOL_VERSION + 1 },
      { zone: "zona_que_nao_existe", version: PROTOCOL_VERSION },
    ]) {
      const client: TestClient = await TestClient.connect(port);
      clients.push(client);
      client.send("join", data);
      const error = await client.next("error");
      assert.ok(error.data["code"] === "version_mismatch" || error.data["code"] === "unknown_zone");
      assert.strictEqual(await client.waitClose(), CloseCode.Rejected);
    }
  });

  it("desconecta quem não responde ao heartbeat e tira da zona", async () => {
    const a = await joined();
    const b = await joined();
    // Simula celular sem rede: com a leitura pausada, o cliente não responde aos pings.
    b.client.socket.pause();

    const left = await a.client.next("player_left", 3000);
    assert.strictEqual(left.data["id"], b.playerId);
    await sleep(10);
    assert.strictEqual(server.getZone(ZONE)?.size, 1);
  });

  it("GET /health responde ok", async () => {
    const res: Response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "ok");
  });
});

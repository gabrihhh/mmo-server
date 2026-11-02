import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
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
    server = new GameServer({ accounts, tickRateHz: 50, heartbeatIntervalMs: 100, log: false });
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

  it("replica o move para os outros no próximo tick", async () => {
    const a = await joined();
    const b = await joined();

    a.client.send("move", { x: 10, y: 0, z: -20, rotY: 1.5 });
    const positions = await b.client.next("positions");
    assert.deepStrictEqual(positions.data["players"], [{ id: a.playerId, x: 10, y: 0, z: -20, rotY: 1.5 }]);
  });

  it("conta de convidado: mesmo token = mesmo jogador, voltando onde parou", async () => {
    const first = await joined();
    first.client.send("move", { x: 33, y: 0, z: -12, rotY: 0.7 });
    await sleep(60); // um tick para o move ser aplicado
    await first.client.close();
    await sleep(20); // savePosition é assíncrono

    const again = await joined(first.guestToken);
    assert.strictEqual(again.playerId, first.playerId);
    assert.strictEqual(again.guestToken, first.guestToken);
    const me: unknown = again.players.find((p) => idOf(p) === first.playerId);
    assert.deepStrictEqual(me, { id: first.playerId, x: 33, y: 0, z: -12, rotY: 0.7 });
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

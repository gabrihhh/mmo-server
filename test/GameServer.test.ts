import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
import { TestClient, sleep } from "./helpers.js";

const ZONE = "zone_1";

describe("GameServer", () => {
  let server: GameServer;
  let port: number;
  const clients: TestClient[] = [];

  /** Conecta e já entra na zona, devolvendo o cliente e o `welcome`. */
  async function joined(): Promise<{ client: TestClient; sessionId: string; playerCount: number }> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("join", { zone: ZONE, version: PROTOCOL_VERSION });
    const welcome = await client.next("welcome");
    const sessionId: unknown = welcome.data["sessionId"];
    const players: unknown = welcome.data["players"];
    assert.ok(typeof sessionId === "string" && Array.isArray(players));
    return { client, sessionId, playerCount: players.length };
  }

  beforeEach(async () => {
    server = new GameServer({ tickRateHz: 50, heartbeatIntervalMs: 100, log: false });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("entra na zona e avisa os outros (player_joined / player_left)", async () => {
    const a = await joined();
    assert.strictEqual(a.playerCount, 1);

    const b = await joined();
    assert.strictEqual(b.playerCount, 2);
    const joinedMsg = await a.client.next("player_joined");
    const player: unknown = joinedMsg.data["player"];
    assert.ok(typeof player === "object" && player !== null && "id" in player);
    assert.strictEqual(player.id, b.sessionId);

    await b.client.close();
    const left = await a.client.next("player_left");
    assert.strictEqual(left.data["id"], b.sessionId);
    assert.strictEqual(server.getZone(ZONE)?.size, 1);
  });

  it("replica o move para os outros no próximo tick", async () => {
    const a = await joined();
    const b = await joined();

    a.client.send("move", { x: 10, y: 0, z: -20, rotY: 1.5 });
    const positions = await b.client.next("positions");
    assert.deepStrictEqual(positions.data["players"], [{ id: a.sessionId, x: 10, y: 0, z: -20, rotY: 1.5 }]);
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
    assert.strictEqual(left.data["id"], b.sessionId);
    await sleep(10);
    assert.strictEqual(server.getZone(ZONE)?.size, 1);
  });
});

import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import { TestClient, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";

/** Chat pela rede ([SOC-09]): Geral para a zona, privado pelo nome, eco do Fake Aceita, recusas. */

const PASSWORD = "senha-forte-123";

describe("chat pela rede (chat_send)", () => {
  let server: GameServer;
  let port: number;
  const clients: TestClient[] = [];

  /** Cadastra, escolhe o corpo e entra na zona. */
  async function ready(username: string): Promise<TestClient> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    await client.next("auth_ok");
    client.send("choose_body", { body: "male" });
    await client.next("body_chosen");
    client.send("join", { zone: "zone_1" });
    await client.next("welcome");
    return client;
  }

  beforeEach(async () => {
    server = new GameServer({ accounts: new InMemoryAccountStore(), heartbeatIntervalMs: 100, log: false, zones: ZONES_WITH_FAKES });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("Geral chega para quem está na zona (e volta para quem mandou); privado só para os dois", async () => {
    const a = await ready("Falante");
    const b = await ready("Ouvinte");
    a.send("chat_send", { channel: "zone", text: "  oi\\n gente " });
    const got: ReceivedMessage = await b.next("chat");
    assert.strictEqual(got.data["from"], "Falante");
    assert.strictEqual(got.data["channel"], "zone");
    const own: ReceivedMessage = await a.next("chat");
    assert.strictEqual(own.data["fromId"], got.data["fromId"]);
    a.send("chat_send", { channel: "private", text: "segredo", to: "ouvinte" });
    const whisper: ReceivedMessage = await b.next("chat");
    assert.strictEqual(whisper.data["to"], "Ouvinte");
    assert.strictEqual(whisper.data["text"], "segredo");
  });

  it("privado para o Fake Aceita volta com eco; ninguém → player_not_found; sem grupo → not_in_group", async () => {
    const a = await ready("Testa");
    a.send("chat_send", { channel: "private", text: "olá", to: "Fake Aceita" });
    await a.nextMatching("chat", (m) => m.data["fromId"] !== "fake_accept");
    const echo: ReceivedMessage = await a.nextMatching("chat", (m) => m.data["fromId"] === "fake_accept");
    assert.strictEqual(echo.data["text"], "Você disse: olá");
    a.send("chat_send", { channel: "private", text: "oi", to: "Ninguem" });
    assert.strictEqual((await a.next("chat_refused")).data["reason"], "player_not_found");
    a.send("chat_send", { channel: "group", text: "oi" });
    assert.strictEqual((await a.next("chat_refused")).data["reason"], "not_in_group");
    a.send("chat_send", { channel: "global", text: "vendo espada" });
    await a.next("chat");
    a.send("chat_send", { channel: "global", text: "de novo" });
    const wait: ReceivedMessage = await a.next("chat_refused");
    assert.strictEqual(wait.data["reason"], "cooldown");
    assert.ok(typeof wait.data["seconds"] === "number" && wait.data["seconds"] > 590);
  });
});

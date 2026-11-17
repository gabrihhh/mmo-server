import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore, type Account } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import { GRANTS } from "../src/items/catalog.js";
import type { ZoneConfig } from "../src/zones/Zone.js";
import { TestClient, sleep, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";

/** Troca pela rede ([SOC-05]): mensagens trade_*, a mochila e as moedas salvas na conta, "Pedidos de troca: Ocultar". */

const PASSWORD = "senha-forte-123";

/** As zonas de teste com os fakes encostados no spawn (a até 10 m de quem nasce, [SOC-05]). */
const ZONES: readonly ZoneConfig[] = ZONES_WITH_FAKES.map((zone) => ({
  ...zone,
  fakePlayers: (zone.fakePlayers ?? []).map((fake) => ({ ...fake, x: 1, z: 0 })),
}));

describe("troca pela rede (trade_*)", () => {
  let server: GameServer;
  let store: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  /** Cadastra, dá `gold` moedas e uma espada na mochila, reconecta com a sessão e entra na zona. */
  async function ready(username: string, gold: number): Promise<{ client: TestClient; token: string; playerId: string }> {
    const first: TestClient = await TestClient.connect(port);
    clients.push(first);
    first.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    const ok: ReceivedMessage = await first.next("auth_ok");
    const { playerId, sessionToken } = ok.data;
    assert.ok(typeof playerId === "string" && typeof sessionToken === "string");
    first.send("choose_body", { body: "male" });
    await first.next("body_chosen");
    await first.close();
    await store.saveInventory(playerId, {
      equipped: { hand: null, head: null, chest: null, feet: null },
      bag: [{ uid: `${username}-sword`, itemId: "training_sword" }],
      grants: Object.keys(GRANTS),
    });
    await store.saveProgress(playerId, { level: 0, xp: 0, gold });
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("resume", { version: PROTOCOL_VERSION, sessionToken });
    await client.next("auth_ok");
    client.send("join", { zone: "zone_1" });
    await client.next("welcome");
    return { client, token: sessionToken, playerId };
  }

  async function saved(token: string): Promise<Account> {
    const account: Account | null = await store.resume(token);
    assert.ok(account !== null);
    return account;
  }

  beforeEach(async () => {
    store = new InMemoryAccountStore();
    server = new GameServer({ accounts: store, heartbeatIntervalMs: 100, log: false, zones: ZONES });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("troca com o Fake Aceita: oferta, confirmação, contagem; mochila e moedas salvas e inventory novo", async () => {
    const a = await ready("Trocador", 40);
    a.client.send("trade_request", { playerId: "fake_accept" });
    const opened: ReceivedMessage = await a.client.next("trade_state");
    assert.strictEqual(opened.data["partnerName"], "Fake Aceita");
    a.client.send("trade_offer", { uids: ["Trocador-sword"], gold: 15 });
    await a.client.nextMatching("trade_state", (m) => (m.data["mine"] as { gold: number }).gold === 15);
    await a.client.nextMatching("trade_state", (m) => m.data["theirConfirmed"] === true, 4000);
    a.client.send("trade_confirm", {});
    await a.client.nextMatching("trade_state", (m) => m.data["countdown"] !== null);
    const done: ReceivedMessage = await a.client.next("trade_done", 7000);
    assert.strictEqual(done.data["partnerName"], "Fake Aceita");
    const inventory: ReceivedMessage = await a.client.nextMatching("inventory", (m) => Array.isArray(m.data["bag"]) && m.data["bag"].length === 0);
    assert.deepStrictEqual(inventory.data["bag"], []);
    await sleep(50);
    const account: Account = await saved(a.token);
    assert.deepStrictEqual(account.inventory.bag, []);
    assert.strictEqual(account.progress.gold, 25);
  });

  it("Pedidos de troca: Ocultar recusa sozinho; trade_offer sem troca → not_in_trade", async () => {
    const a = await ready("Pede", 0);
    const b = await ready("Oculta", 0);
    b.client.send("social_settings", { friendRequests: "always", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "hide" });
    await b.client.next("social_settings");
    a.client.send("trade_request", { playerId: b.playerId });
    const notice: ReceivedMessage = await a.client.next("trade_notice");
    assert.strictEqual(notice.data["code"], "rejected");
    assert.strictEqual(b.client.hasPending("trade_requested"), false);
    a.client.send("trade_offer", { uids: [], gold: 0 });
    const error: ReceivedMessage = await a.client.next("error");
    assert.strictEqual(error.data["code"], "not_in_trade");
  });
});

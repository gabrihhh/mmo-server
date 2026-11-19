import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore, type Account } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import { TestClient, sleep, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";

/** Loja premium pela rede ([JOGO-27]): compra de teste de pacote, produtos, histórico e servidor sem compra de teste. */

const PASSWORD = "senha-forte-123";

describe("Loja premium pela rede (premium_*)", () => {
  let server: GameServer;
  let store: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  async function start(testPurchases: boolean): Promise<void> {
    store = new InMemoryAccountStore();
    server = new GameServer({ accounts: store, heartbeatIntervalMs: 100, log: false, zones: ZONES_WITH_FAKES, testPurchases });
    port = await server.listen(0);
  }

  /** Cadastra e devolve o cliente autenticado (sem entrar na zona: a Loja abre de qualquer lugar). */
  async function ready(username: string): Promise<{ client: TestClient; token: string }> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    const ok: ReceivedMessage = await client.next("auth_ok");
    const token: unknown = ok.data["sessionToken"];
    assert.ok(typeof token === "string");
    // Logo depois de autenticar vem o estado da Loja (saldo 0).
    assert.strictEqual((await client.next("premium")).data["diamonds"], 0);
    return { client, token };
  }

  async function saved(token: string): Promise<Account> {
    const account: Account | null = await store.resume(token);
    assert.ok(account !== null);
    return account;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("compra de teste dá Diamantes (1ª em dobro), compra produtos, salva e mostra o histórico", async () => {
    await start(true);
    const { client, token } = await ready("Rico");
    client.send("premium_open", {});
    const open: ReceivedMessage = await client.next("premium");
    assert.strictEqual(open.data["diamonds"], 0);
    assert.strictEqual(open.data["testPurchases"], true);
    assert.ok(Array.isArray(open.data["products"]) && open.data["products"].length > 0);

    client.send("premium_pack", { packId: "diamonds_220" });
    const pack: ReceivedMessage = await client.next("premium_result");
    assert.strictEqual(pack.data["diamonds"], 440);
    assert.strictEqual((await client.next("premium")).data["diamonds"], 440);

    client.send("premium_buy", { productId: "storage_tab" });
    await client.next("premium_result");
    assert.strictEqual((await client.next("premium")).data["diamonds"], 290);

    client.send("premium_buy", { productId: "vip_30d" });
    assert.strictEqual((await client.next("error")).data["code"], "not_enough_diamonds");

    client.send("premium_pack", { packId: "diamonds_100" });
    await client.next("premium_result");
    await client.next("premium");
    client.send("premium_buy", { productId: "vip_30d" });
    assert.strictEqual((await client.next("premium_result")).data["id"], "vip_30d");
    const afterVip: ReceivedMessage = await client.next("premium");
    assert.strictEqual(afterVip.data["diamonds"], 190);
    assert.ok(typeof afterVip.data["vipSeconds"] === "number" && afterVip.data["vipSeconds"] > 29 * 24 * 3600);
    await sleep(50);
    const account: Account = await saved(token);
    assert.strictEqual(account.premium.diamonds, 190);
    assert.strictEqual(account.inventory.storageTabs, 1, "a aba comprada com Diamantes soma no Armazém");

    client.send("premium_history", {});
    const history: ReceivedMessage = await client.next("premium_history_list");
    const entries = history.data["entries"] as { name: string; diamonds: number }[];
    assert.deepStrictEqual(entries.map((e) => e.diamonds), [-300, 200, -150, 440]);
    assert.strictEqual(entries[3]?.name, "220 Diamantes");
  });

  it("sem a compra de teste ligada, pacote é recusado", async () => {
    await start(false);
    const { client } = await ready("Pobre");
    client.send("premium_pack", { packId: "diamonds_100" });
    assert.strictEqual((await client.next("error")).data["code"], "purchases_unavailable");
  });
});

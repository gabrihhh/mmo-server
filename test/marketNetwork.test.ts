import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore, type Account } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import { GRANTS } from "../src/items/catalog.js";
import type { ZoneConfig } from "../src/zones/Zone.js";
import { TestClient, sleep, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";

/** Mercado pela rede ([JOGO-25]): anunciar (taxa), comprar (moedas ao vendedor, online ou não), cancelar, longe. */

const PASSWORD = "senha-forte-123";

/** Zonas de teste com o Mercador no centro (quem nasce fica a até 4 m dele) e nascimento no ponto 0. */
const ZONES: readonly ZoneConfig[] = ZONES_WITH_FAKES.map((zone) => ({
  ...zone,
  spawnRadius: 0,
  dummies: zone.dummies.map((dummy) => (dummy.id === "market" ? { ...dummy, x: 1, z: 0 } : dummy)),
}));

describe("mercado pela rede (market_*)", () => {
  let server: GameServer;
  let store: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  /** Cadastra com `gold` moedas e uma espada na mochila e entra na zona. */
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
      bag: [{ uid: `${username}-sword`, itemId: "knight_sword", level: 2 }],
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

  it("anuncia pagando 5%, outro compra; vendedor online recebe as moedas e o aviso", async () => {
    const seller = await ready("Vende", 100);
    const buyer = await ready("Compra", 2000);
    seller.client.send("market_sell", { uid: "Vende-sword", price: 1000 });
    const sold: ReceivedMessage = await seller.client.next("market_result");
    assert.strictEqual(sold.data["gold"], 50);
    await seller.client.nextMatching("inventory", (m) => Array.isArray(m.data["bag"]) && m.data["bag"].length === 0);
    buyer.client.send("market_list", { query: "longa", slot: null, sort: "price", page: 0 });
    const page: ReceivedMessage = await buyer.client.next("market_page");
    const listings = page.data["listings"] as { id: string; price: number }[];
    assert.strictEqual(listings.length, 1);
    buyer.client.send("market_buy", { listingId: listings[0]?.id });
    await buyer.client.next("market_result");
    const notice: ReceivedMessage = await seller.client.next("market_sold");
    assert.strictEqual(notice.data["buyerName"], "Compra");
    buyer.client.send("market_buy", { listingId: listings[0]?.id });
    assert.strictEqual((await buyer.client.next("error")).data["code"], "listing_gone");
    await sleep(80);
    assert.strictEqual((await saved(buyer.token)).inventory.bag[0]?.level, 2, "o item vai inteiro (nível)");
    assert.strictEqual((await saved(buyer.token)).progress.gold, 1000);
    assert.strictEqual((await saved(seller.token)).progress.gold, 1050, "100 − 50 de taxa + 1000");
  });

  it("sem moedas para a taxa não anuncia; cancelar devolve item e taxa", async () => {
    const poor = await ready("Pobre", 10);
    poor.client.send("market_sell", { uid: "Pobre-sword", price: 1000 });
    assert.strictEqual((await poor.client.next("error")).data["code"], "not_enough_gold");
    poor.client.send("market_sell", { uid: "Pobre-sword", price: 200 });
    await poor.client.next("market_result");
    const mine: ReceivedMessage = await poor.client.next("market_mine_list");
    const id: string = (mine.data["listings"] as { id: string }[])[0]?.id ?? "";
    poor.client.send("market_cancel", { listingId: id });
    const back: ReceivedMessage = await poor.client.next("market_result");
    assert.strictEqual(back.data["action"], "cancel");
    await sleep(80);
    const account: Account = await saved(poor.token);
    assert.strictEqual(account.inventory.bag[0]?.uid, "Pobre-sword");
    assert.strictEqual(account.progress.gold, 10);
  });
});

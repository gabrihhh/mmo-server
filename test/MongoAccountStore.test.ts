import assert from "assert";
import { MongoClient } from "mongodb";

import { MongoAccountStore } from "../src/accounts/MongoAccountStore.js";

/** Banco separado só para testes (apagado a cada execução). Precisa do Mongo local: npm run db:up. */
const TEST_MONGO_URL: string = process.env["MONGO_TEST_URL"] ?? "mongodb://localhost:27017/mmo_test";

describe("MongoAccountStore (MongoDB real)", function () {
  let store: MongoAccountStore | null = null;

  before(async function () {
    const admin: MongoClient = new MongoClient(TEST_MONGO_URL, { serverSelectionTimeoutMS: 1500 });
    try {
      await admin.connect();
      await admin.db().dropDatabase();
    } catch {
      console.warn(`    (pulado: MongoDB não está acessível em ${TEST_MONGO_URL}; rode npm run db:up)`);
      this.skip();
    } finally {
      await admin.close();
    }
    store = await MongoAccountStore.connect(TEST_MONGO_URL);
  });

  after(async () => {
    await store?.close();
  });

  it("cria conta de convidado, reencontra pelo token e salva a posição", async () => {
    assert.ok(store);
    const created = await store.loginGuest(null);
    assert.strictEqual(created.created, true);
    assert.strictEqual(created.account.lastPosition, null);

    await store.savePosition(created.account.playerId, { zone: "zone_1", x: 1, y: 0, z: 2, rotY: 3 });

    const again = await store.loginGuest(created.guestToken);
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.account.playerId, created.account.playerId);
    assert.deepStrictEqual(again.account.lastPosition, { zone: "zone_1", x: 1, y: 0, z: 2, rotY: 3 });

    const other = await store.loginGuest("token-desconhecido");
    assert.strictEqual(other.created, true);
    assert.notStrictEqual(other.account.playerId, created.account.playerId);
    assert.strictEqual(await store.isHealthy(), true);
  });
});

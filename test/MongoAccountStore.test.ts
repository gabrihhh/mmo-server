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

  it("cadastra, recusa repetidos sem diferenciar maiúsculas e guarda o nome como digitado", async () => {
    assert.ok(store);
    const created = await store.register("Joao_Pe", "Joao@Mail.com", "senha-1234");
    assert.ok(created.ok);
    assert.strictEqual(created.account.username, "Joao_Pe");

    assert.deepStrictEqual(await store.register("JOAO_PE", "outro@mail.com", "senha-1234"), { ok: false, reason: "username_taken" });
    assert.deepStrictEqual(await store.register("Outro", "joao@mail.com", "senha-1234"), { ok: false, reason: "email_taken" });
  });

  it("login por username/e-mail, sessão, logout e posição", async () => {
    assert.ok(store);
    assert.strictEqual(await store.login("joao_pe", "errada-000"), null);
    const byName = await store.login("joao_pe", "senha-1234");
    const byEmail = await store.login("JOAO@MAIL.COM", "senha-1234");
    assert.ok(byName && byEmail);
    assert.strictEqual(byName.account.username, "Joao_Pe");
    assert.strictEqual(byEmail.account.playerId, byName.account.playerId);

    await store.savePosition(byName.account.playerId, { zone: "zone_1", x: 1, y: 0, z: 2, rotY: 3 });
    const resumed = await store.resume(byName.sessionToken);
    assert.deepStrictEqual(resumed?.lastPosition, { zone: "zone_1", x: 1, y: 0, z: 2, rotY: 3 });

    const resumedInventory = resumed?.inventory;
    assert.strictEqual(resumedInventory?.equipped.hand, null, "conta nova nasce pelada");
    assert.ok(resumedInventory?.bag.some((s) => s.itemId === "training_sword"), "com o kit na mochila");
    const sword = { uid: "espada", itemId: "training_sword" };
    await store.saveInventory(byName.account.playerId, { ...resumedInventory, equipped: { ...resumedInventory.equipped, hand: sword } });
    assert.deepStrictEqual((await store.resume(byName.sessionToken))?.inventory.equipped.hand, sword, "inventário salvo");

    await store.logout(byName.sessionToken);
    assert.strictEqual(await store.resume(byName.sessionToken), null);
    assert.ok(await store.resume(byEmail.sessionToken), "outra sessão continua valendo");
    assert.strictEqual(await store.isHealthy(), true);
  });
});

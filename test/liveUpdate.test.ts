import assert from "assert";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { UpdateWatcher, parseManifestVersion } from "../src/http/updateWatcher.js";
import { CloseCode, PROTOCOL_VERSION, parseClientMessage } from "../src/net/protocol.js";
import { TestClient, sleep } from "./helpers.js";

/**
 * Atualização com o jogo aberto (mmo-docs [INFRA-08]): o servidor percebe o manifesto novo e manda atualizar quem está
 * na versão velha (`update_required` + close 4003), também na autenticação; dev (pacote 0) nunca.
 */

const PASSWORD = "senha-forte-123";

/** Publica `version` para `platform` como o publish_update.sh: escreve um temporário e troca de uma vez (`mv`). */
async function publish(dir: string, platform: string, version: number): Promise<void> {
  await mkdir(join(dir, platform), { recursive: true });
  const manifest: string = join(dir, platform, "manifest.json");
  await writeFile(`${manifest}.tmp`, JSON.stringify({ version, url: `/updates/${platform}/game-${version}.pck`, sha256: "0".repeat(64), size: 1, minLauncherVersion: 1 }));
  await rename(`${manifest}.tmp`, manifest);
}

/** Espera até `condition()` ser verdade (ou falha depois de `timeoutMs`). */
async function until(condition: () => boolean, timeoutMs: number = 3000): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timeout esperando a condição");
    await sleep(20);
  }
}

describe("parseManifestVersion / client na autenticação", () => {
  it("lê a versão do manifesto e recusa o que não serve", () => {
    assert.strictEqual(parseManifestVersion('{"version": 7, "url": "x"}'), 7);
    for (const text of ["", "{", "[]", '{"version": -1}', '{"version": 1.5}', '{"version": "3"}', "{}"]) {
      assert.strictEqual(parseManifestVersion(text), null, text);
    }
  });

  it("o client (plataforma + pacote) é opcional e validado", () => {
    assert.deepStrictEqual(parseClientMessage('{"type":"resume","data":{"version":16,"sessionToken":"t","client":{"platform":"android","pack":3}}}'), {
      type: "resume",
      data: { version: 16, sessionToken: "t", client: { platform: "android", pack: 3 } },
    });
    for (const client of ['{"platform":"Android","pack":3}', '{"platform":"android","pack":-1}', '{"platform":"android"}', '"android"']) {
      assert.strictEqual(parseClientMessage(`{"type":"login","data":{"version":16,"login":"a","password":"b","client":${client}}}`), null, client);
    }
  });
});

describe("UpdateWatcher", () => {
  let dir: string;
  let watcher: UpdateWatcher | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmo-watch-"));
  });

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("lê as versões ao iniciar sem avisar e avisa só quando a versão sobe (troca atômica)", async () => {
    await publish(dir, "android", 4);
    const seen: Array<[string, number]> = [];
    watcher = new UpdateWatcher({ dir, pollIntervalMs: 60_000, onVersion: (p, v) => seen.push([p, v]) });
    await watcher.start();
    assert.strictEqual(watcher.latestVersion("android"), 4);
    assert.strictEqual(watcher.latestVersion("desktop"), undefined);
    assert.deepStrictEqual(seen, []);

    await publish(dir, "android", 5); // o fs.watch avisa (a varredura periódica está em 60 s)
    await until(() => seen.length === 1);
    assert.deepStrictEqual(seen, [["android", 5]]);
    assert.strictEqual(watcher.latestVersion("android"), 5);

    await publish(dir, "desktop", 1); // plataforma nova (pasta criada depois do início)
    await until(() => seen.length === 2);
    assert.deepStrictEqual(seen[1], ["desktop", 1]);
  });

  it("sem fs.watch (pasta criada depois), a varredura periódica pega; manifesto quebrado é ignorado", async () => {
    const root: string = join(dir, "ainda-nao-existe");
    const seen: Array<[string, number]> = [];
    watcher = new UpdateWatcher({ dir: root, pollIntervalMs: 50, onVersion: (p, v) => seen.push([p, v]) });
    await watcher.start();
    await mkdir(join(root, "android"), { recursive: true });
    await writeFile(join(root, "android", "manifest.json"), "{ meio escrito");
    await sleep(200);
    assert.deepStrictEqual(seen, []);
    await publish(root, "android", 2);
    await until(() => seen.length === 1);
    assert.deepStrictEqual(seen, [["android", 2]]);
  });
});

describe("GameServer: atualização obrigatória com o jogo aberto", () => {
  let dir: string;
  let server: GameServer;
  let port: number;
  const clients: TestClient[] = [];
  let counter = 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmo-live-update-"));
    await publish(dir, "android", 10);
    await publish(dir, "desktop", 3);
    server = new GameServer({ accounts: new InMemoryAccountStore(), log: false, updatesDir: dir, updatePollIntervalMs: 50 });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Conecta e cadastra uma conta nova dizendo rodar o pacote `client` (sem = dev/antigo). */
  async function signUp(client?: { platform: string; pack: number }, version: number = PROTOCOL_VERSION): Promise<TestClient> {
    const c: TestClient = await TestClient.connect(port);
    clients.push(c);
    const username: string = `Atualiza_${++counter}`;
    c.send("register", { version, username, email: `${username}@teste.com`, password: PASSWORD, ...(client === undefined ? {} : { client }) });
    return c;
  }

  /** Cadastra, escolhe o corpo e entra na zona. */
  async function playing(client?: { platform: string; pack: number }): Promise<TestClient> {
    const c: TestClient = await signUp(client);
    await c.next("auth_ok");
    c.send("choose_body", { body: "male" });
    await c.next("body_chosen");
    c.send("join", { zone: "zone_1" });
    await c.next("welcome");
    return c;
  }

  it("pacote atual entra; pacote velho recebe update_required no lugar do auth_ok e a conexão fecha com 4003", async () => {
    const current: TestClient = await signUp({ platform: "android", pack: 10 });
    await current.next("auth_ok");

    const old: TestClient = await signUp({ platform: "android", pack: 9 });
    assert.deepStrictEqual((await old.next("update_required")).data, { version: 10 });
    // O close vem depois de um tempo: o WebSocketPeer do Godot descarta mensagens que chegam junto com o close.
    assert.strictEqual(old.closeCode, null);
    assert.strictEqual(await old.waitClose(), CloseCode.UpdateRequired);
    assert.ok(!old.hasPending("auth_ok"));
  });

  it("pacote velho com protocolo velho também é mandado atualizar (não só version_mismatch)", async () => {
    const old: TestClient = await signUp({ platform: "desktop", pack: 2 }, PROTOCOL_VERSION - 1);
    assert.deepStrictEqual((await old.next("update_required")).data, { version: 3 });
    assert.strictEqual(await old.waitClose(), CloseCode.UpdateRequired);
  });

  it("dev (pacote 0), sem client e plataforma sem manifesto nunca são forçados", async () => {
    for (const client of [{ platform: "android", pack: 0 }, undefined, { platform: "ios", pack: 1 }]) {
      const c: TestClient = await signUp(client);
      await c.next("auth_ok");
    }
  });

  it("versão nova publicada derruba só quem está na versão velha daquela plataforma", async () => {
    const oldAndroid: TestClient = await playing({ platform: "android", pack: 10 });
    const desktop: TestClient = await playing({ platform: "desktop", pack: 3 });
    const dev: TestClient = await playing({ platform: "android", pack: 0 });
    const legacy: TestClient = await playing();
    assert.strictEqual(server.getZone("zone_1")?.size, 4);

    await publish(dir, "android", 11);
    assert.deepStrictEqual((await oldAndroid.next("update_required", 3000)).data, { version: 11 });
    assert.strictEqual(await oldAndroid.waitClose(), CloseCode.UpdateRequired);
    await until(() => server.getZone("zone_1")?.size === 3);

    // Os outros continuam conectados e jogando.
    await sleep(150);
    for (const c of [desktop, dev, legacy]) {
      assert.strictEqual(c.closeCode, null);
      assert.ok(!c.hasPending("update_required"));
    }

    // Quem chega com o pacote novo entra normalmente.
    const updated: TestClient = await signUp({ platform: "android", pack: 11 });
    await updated.next("auth_ok");
  });
});

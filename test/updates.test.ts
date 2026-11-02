import assert from "assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";

describe("GET /updates/*", () => {
  let server: GameServer;
  let base: string;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mmo-updates-"));
    await writeFile(join(dir, "manifest.json"), '{"version":3}');
    await writeFile(join(dir, "game-3.pck"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(dir, "secreto.txt"), "não pode sair");
    server = new GameServer({ accounts: new InMemoryAccountStore(), log: false, updatesDir: dir });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });

  after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serve o manifesto sem cache", async () => {
    const res: Response = await fetch(`${base}/updates/manifest.json`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("cache-control"), "no-cache");
    assert.deepStrictEqual(await res.json(), { version: 3 });
  });

  it("serve o .pck com o tamanho certo", async () => {
    const res: Response = await fetch(`${base}/updates/game-3.pck`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-length"), "4");
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
  });

  it("404 para arquivo inexistente, extensão não permitida e tentativa de sair da pasta", async () => {
    for (const path of ["game-9.pck", "secreto.txt", "..%2Fpackage.json", "../package.json", ".hidden.json"]) {
      const res: Response = await fetch(`${base}/updates/${path}`);
      assert.strictEqual(res.status, 404, path);
    }
  });
});

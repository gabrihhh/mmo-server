import assert from "assert";

import { GameServer, MAX_AUTH_FAILURES } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
import { MOVE_SPEED, TICK_SECONDS } from "../src/sim/movement.js";
import { TestClient, sleep, type ReceivedMessage } from "./helpers.js";

const ZONE = "zone_1";
const PASSWORD = "senha-forte-123";

/** Jogador conectado e autenticado (e, se pedido, dentro da zona). */
interface Player {
  readonly client: TestClient;
  readonly playerId: string;
  readonly username: string;
  readonly sessionToken: string;
}

/** Lê os campos de um `auth_ok`. */
function authData(message: ReceivedMessage): { playerId: string; username: string; sessionToken: string } {
  const { playerId, username, sessionToken } = message.data;
  assert.ok(typeof playerId === "string" && typeof username === "string" && typeof sessionToken === "string");
  return { playerId, username, sessionToken };
}

/** Entrada de `id` numa lista `players` vinda da rede (cópia simples dos campos). */
function entryOf(players: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(players)) return undefined;
  for (const p of players) {
    if (typeof p === "object" && p !== null && "id" in p && p.id === id) {
      const entry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) entry[k] = v;
      return entry;
    }
  }
  return undefined;
}

describe("GameServer", () => {
  let server: GameServer;
  let port: number;
  const clients: TestClient[] = [];
  let counter = 0;

  async function connect(): Promise<TestClient> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    return client;
  }

  /** Cria uma conta nova (username único por teste) e devolve o jogador autenticado. */
  async function registered(username: string = `Jogador_${++counter}`): Promise<Player> {
    const client: TestClient = await connect();
    client.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    return { client, ...authData(await client.next("auth_ok")) };
  }

  /** Manda `join` e devolve a lista `players` do `welcome`. */
  async function join(player: Player): Promise<unknown[]> {
    player.client.send("join", { zone: ZONE });
    const welcome: ReceivedMessage = await player.client.next("welcome");
    const players: unknown = welcome.data["players"];
    assert.ok(Array.isArray(players));
    return players;
  }

  beforeEach(async () => {
    server = new GameServer({ accounts: new InMemoryAccountStore(), heartbeatIntervalMs: 100, log: false });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  describe("cadastro e login", () => {
    it("cadastro devolve auth_ok com o username como foi digitado", async () => {
      const p: Player = await registered("GaBrIeL_01");
      assert.strictEqual(p.username, "GaBrIeL_01");
      assert.ok(p.sessionToken.length > 20);
    });

    it("username é único sem diferenciar maiúsculas; e-mail também", async () => {
      await registered("Gabriel");
      const c: TestClient = await connect();
      c.send("register", { version: PROTOCOL_VERSION, username: "gabriel", email: "outro@x.com", password: PASSWORD });
      assert.strictEqual((await c.next("error")).data["code"], "username_taken");
      c.send("register", { version: PROTOCOL_VERSION, username: "Outro", email: "GABRIEL@teste.com", password: PASSWORD });
      assert.strictEqual((await c.next("error")).data["code"], "email_taken");
      assert.strictEqual(c.closeCode, null, "erro de cadastro não derruba a conexão");
    });

    it("recusa username, e-mail e senha fora das regras", async () => {
      const c: TestClient = await connect();
      const cases: Array<[Record<string, string>, string]> = [
        [{ username: "ab", email: "a@b.com", password: PASSWORD }, "invalid_username"],
        [{ username: "com espaço", email: "a@b.com", password: PASSWORD }, "invalid_username"],
        [{ username: "Valido", email: "sem-arroba", password: PASSWORD }, "invalid_email"],
        [{ username: "Valido", email: "a@b.com", password: "curta" }, "invalid_password"],
      ];
      for (const [data, code] of cases) {
        c.send("register", { version: PROTOCOL_VERSION, ...data });
        assert.strictEqual((await c.next("error")).data["code"], code, JSON.stringify(data));
      }
    });

    it("login por username ou e-mail, sem diferenciar maiúsculas; nome exibido continua o original", async () => {
      const created: Player = await registered("Maria_Silva");
      for (const login of ["maria_silva", "MARIA_SILVA@TESTE.COM"]) {
        const c: TestClient = await connect();
        c.send("login", { version: PROTOCOL_VERSION, login, password: PASSWORD });
        const ok = authData(await c.next("auth_ok"));
        assert.strictEqual(ok.playerId, created.playerId);
        assert.strictEqual(ok.username, "Maria_Silva");
      }
    });

    it("senha errada: invalid_credentials; depois de várias, fecha a conexão", async () => {
      await registered("Alvo");
      const c: TestClient = await connect();
      for (let i = 1; i < MAX_AUTH_FAILURES; i++) {
        c.send("login", { version: PROTOCOL_VERSION, login: "Alvo", password: "errada-123" });
        assert.strictEqual((await c.next("error")).data["code"], "invalid_credentials");
      }
      c.send("login", { version: PROTOCOL_VERSION, login: "Alvo", password: "errada-123" });
      assert.strictEqual((await c.next("error")).data["code"], "too_many_attempts");
      assert.strictEqual(await c.waitClose(), CloseCode.Rejected);
    });

    it("resume entra com o token salvo; logout invalida o token", async () => {
      const p: Player = await registered();
      const c: TestClient = await connect();
      c.send("resume", { version: PROTOCOL_VERSION, sessionToken: p.sessionToken });
      assert.strictEqual(authData(await c.next("auth_ok")).playerId, p.playerId);
      assert.strictEqual(await p.client.waitClose(), CloseCode.Replaced, "a conexão antiga da mesma conta cai");

      c.send("logout", {});
      assert.strictEqual(await c.waitClose(), CloseCode.Normal);
      const d: TestClient = await connect();
      d.send("resume", { version: PROTOCOL_VERSION, sessionToken: p.sessionToken });
      assert.strictEqual((await d.next("error")).data["code"], "invalid_session");
    });

    it("versão de protocolo diferente fecha com 4000", async () => {
      const c: TestClient = await connect();
      c.send("login", { version: PROTOCOL_VERSION + 1, login: "x", password: "y" });
      assert.strictEqual((await c.next("error")).data["code"], "version_mismatch");
      assert.strictEqual(await c.waitClose(), CloseCode.Rejected);
    });

    it("join antes de autenticar é recusado", async () => {
      const c: TestClient = await connect();
      c.send("join", { zone: ZONE });
      assert.strictEqual((await c.next("error")).data["code"], "not_authenticated");
    });
  });

  describe("zona", () => {
    it("entra na zona e avisa os outros, com o nome de cada um", async () => {
      const a: Player = await registered("Alice");
      assert.strictEqual(entryOf(await join(a), a.playerId)?.["name"], "Alice");

      const b: Player = await registered("Bob_2");
      const players: unknown[] = await join(b);
      assert.strictEqual(players.length, 2);
      assert.strictEqual(entryOf(players, a.playerId)?.["name"], "Alice");
      const joinedMsg: ReceivedMessage = await a.client.next("player_joined");
      assert.strictEqual(entryOf([joinedMsg.data["player"]], b.playerId)?.["name"], "Bob_2");

      await b.client.close();
      assert.strictEqual((await a.client.next("player_left")).data["id"], b.playerId);
      assert.strictEqual(server.getZone(ZONE)?.size, 1);
    });

    it("servidor simula o input: confirma no ack e replica para os outros", async () => {
      const a: Player = await registered();
      const b: Player = await registered();
      const startX: unknown = entryOf(await join(a), a.playerId)?.["x"];
      await join(b);
      assert.ok(typeof startX === "number");

      a.client.send("input", { seq: 1, x: 1, z: 0 });
      const acked: ReceivedMessage = await a.client.nextMatching("snapshot", (m) => m.data["ack"] === 1);
      const after: unknown = entryOf(acked.data["players"], a.playerId)?.["x"];
      assert.ok(typeof after === "number" && Math.abs(after - (startX + MOVE_SPEED * TICK_SECONDS)) < 1e-9);

      const seen: ReceivedMessage = await b.client.nextMatching(
        "snapshot",
        (m) => entryOf(m.data["players"], a.playerId)?.["x"] === after,
      );
      assert.strictEqual(seen.data["ack"], 0, "o ack de b é o de b, não o de a");
    });

    it("volta onde parou ao entrar de novo pela sessão salva", async () => {
      const first: Player = await registered();
      await join(first);
      for (let seq = 1; seq <= 4; seq++) first.client.send("input", { seq, x: 0, z: 1 });
      const last: ReceivedMessage = await first.client.nextMatching("snapshot", (m) => m.data["ack"] === 4);
      const where = entryOf(last.data["players"], first.playerId);
      await first.client.close();
      await sleep(20); // savePosition é assíncrono

      const c: TestClient = await connect();
      c.send("resume", { version: PROTOCOL_VERSION, sessionToken: first.sessionToken });
      await c.next("auth_ok");
      c.send("join", { zone: ZONE });
      const players: unknown = (await c.next("welcome")).data["players"];
      const me = entryOf(players, first.playerId);
      assert.deepStrictEqual({ ...me, name: undefined }, { ...where, name: undefined });
    });

    it("ignora o antigo `move` com posição (o cliente não diz onde está)", async () => {
      const a: Player = await registered();
      await join(a);
      a.client.send("move", { x: 100, y: 0, z: 100, rotY: 0 });
      assert.strictEqual((await a.client.next("error")).data["code"], "bad_message");
    });

    it("zona inexistente fecha com 4000", async () => {
      const a: Player = await registered();
      a.client.send("join", { zone: "zona_que_nao_existe" });
      assert.strictEqual((await a.client.next("error")).data["code"], "unknown_zone");
      assert.strictEqual(await a.client.waitClose(), CloseCode.Rejected);
    });

    it("desconecta quem não responde ao heartbeat e tira da zona", async () => {
      const a: Player = await registered();
      const b: Player = await registered();
      await join(a);
      await join(b);
      // Simula celular sem rede: com a leitura pausada, o cliente não responde aos pings.
      b.client.socket.pause();
      assert.strictEqual((await a.client.next("player_left", 3000)).data["id"], b.playerId);
      await sleep(10);
      assert.strictEqual(server.getZone(ZONE)?.size, 1);
    });
  });

  it("responde bad_message a mensagem inválida e mantém a conexão", async () => {
    const c: TestClient = await connect();
    c.socket.send("lixo");
    assert.strictEqual((await c.next("error")).data["code"], "bad_message");
    assert.strictEqual(c.closeCode, null);
  });

  it("GET /health responde ok", async () => {
    const res: Response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "ok");
  });
});

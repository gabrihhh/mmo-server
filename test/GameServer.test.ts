import assert from "assert";

import { GameServer, MAX_AUTH_FAILURES } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { CloseCode, PROTOCOL_VERSION } from "../src/net/protocol.js";
import { MOVE_SPEED, TICK_SECONDS } from "../src/sim/movement.js";
import { TestClient, sleep, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";
import { TEST_FAKE_PLAYERS, ZONE_CONFIGS } from "../src/zones/zones.js";
import { VIEW_RADIUS } from "../src/zones/Zone.js";
import { fullKitInventory } from "../src/items/inventory.js";

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

  /**
   * Cria uma conta nova (username único por teste) e devolve o jogador autenticado, já com o corpo escolhido
   * (`body`; `null` = não escolhe, para testar a escolha).
   */
  async function registered(username: string = `Jogador_${++counter}`, body: string | null = "male"): Promise<Player> {
    const client: TestClient = await connect();
    client.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    const player: Player = { client, ...authData(await client.next("auth_ok")) };
    if (body !== null) {
      client.send("choose_body", { body });
      await client.next("body_chosen");
    }
    return player;
  }

  /** Veste `itemId` (da mochila da conta nova) e espera o inventário novo. */
  async function wear(player: Player, itemId: string): Promise<void> {
    const bag: unknown = (await player.client.next("inventory")).data["bag"];
    assert.ok(Array.isArray(bag));
    const stack: unknown = bag.find((item: unknown) => typeof item === "object" && item !== null && "itemId" in item && item.itemId === itemId);
    assert.ok(typeof stack === "object" && stack !== null && "uid" in stack);
    player.client.send("equip", { uid: stack.uid });
    await player.client.next("inventory");
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
    // Contas com o kit completo (a conta nova do jogo nasce vazia, [JOGO-04]): os testes vestem itens.
    server = new GameServer({ accounts: new InMemoryAccountStore(fullKitInventory), heartbeatIntervalMs: 100, log: false, zones: ZONES_WITH_FAKES });
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

  describe("corpo do personagem (escolha na primeira entrada)", () => {
    it("conta nova vem sem corpo; join antes de escolher é recusado; escolhe uma vez e vale para sempre", async () => {
      const c: TestClient = await connect();
      c.send("register", { version: PROTOCOL_VERSION, username: "Escolhe", email: "escolhe@teste.com", password: PASSWORD });
      const ok: ReceivedMessage = await c.next("auth_ok");
      assert.strictEqual(ok.data["body"], null, "ainda não escolheu");
      c.send("join", { zone: ZONE });
      assert.strictEqual((await c.next("error")).data["code"], "body_not_chosen");

      c.send("choose_body", { body: "alien" });
      assert.strictEqual((await c.next("error")).data["code"], "bad_message", "corpo inexistente");
      c.send("choose_body", { body: "female" });
      assert.strictEqual((await c.next("body_chosen")).data["body"], "female");
      c.send("choose_body", { body: "male" });
      assert.strictEqual((await c.next("error")).data["code"], "body_already_chosen");

      c.send("join", { zone: ZONE });
      const players: unknown = (await c.next("welcome")).data["players"];
      const me = entryOf(players, authData(ok).playerId);
      assert.strictEqual(me?.["body"], "female", "os outros desenham o corpo escolhido");

      await c.close();
      await sleep(20);
      const again: TestClient = await connect();
      again.send("resume", { version: PROTOCOL_VERSION, sessionToken: authData(ok).sessionToken });
      assert.strictEqual((await again.next("auth_ok")).data["body"], "female", "lembra a escolha");
    });
  });

  describe("inventário", () => {
    /** Lê o `uid` e o `itemId` de um ItemView vindo da rede. */
    function itemOf(value: unknown): { uid: string; itemId: string } | null {
      if (typeof value !== "object" || value === null || !("uid" in value) || !("itemId" in value)) return null;
      return typeof value.uid === "string" && typeof value.itemId === "string" ? { uid: value.uid, itemId: value.itemId } : null;
    }

    it("chega logo após o auth_ok (nasce pelado); equip veste; fica salvo para a próxima sessão", async () => {
      const p: Player = await registered();
      const first: ReceivedMessage = await p.client.next("inventory");
      const equipped: unknown = first.data["equipped"];
      assert.ok(typeof equipped === "object" && equipped !== null && "hand" in equipped);
      assert.strictEqual(equipped.hand, null, "conta nova não tem nada vestido");
      const bag: unknown = first.data["bag"];
      assert.ok(Array.isArray(bag));
      const staff = bag.map(itemOf).find((item) => item?.itemId === "training_staff");
      assert.ok(staff);

      p.client.send("equip", { uid: staff.uid });
      const after: ReceivedMessage = await p.client.next("inventory");
      const afterEquipped: unknown = after.data["equipped"];
      assert.ok(typeof afterEquipped === "object" && afterEquipped !== null && "hand" in afterEquipped);
      assert.strictEqual(itemOf(afterEquipped.hand)?.uid, staff.uid);

      const c: TestClient = await connect();
      c.send("resume", { version: PROTOCOL_VERSION, sessionToken: p.sessionToken });
      await c.next("auth_ok");
      const resumed: unknown = (await c.next("inventory")).data["equipped"];
      assert.ok(typeof resumed === "object" && resumed !== null && "hand" in resumed);
      assert.strictEqual(itemOf(resumed.hand)?.itemId, "training_staff");
    });

    it("recusas viram erro e não mudam nada", async () => {
      const p: Player = await registered();
      await p.client.next("inventory");
      p.client.send("equip", { uid: "nao-existe" });
      assert.strictEqual((await p.client.next("error")).data["code"], "item_not_found");
      p.client.send("unequip", { slot: "head" });
      assert.strictEqual((await p.client.next("error")).data["code"], "slot_empty", "nasce sem nada vestido");
    });

    it("equip sem autenticar é recusado", async () => {
      const c: TestClient = await connect();
      c.send("equip", { uid: "x" });
      assert.strictEqual((await c.next("error")).data["code"], "not_authenticated");
    });
  });

  describe("atributos (inspect)", () => {
    it("responde os atributos de um jogador da zona; quem não está → player_not_found", async () => {
      const a: Player = await registered("Inspetor");
      a.client.send("inspect", { playerId: "fake_accept" });
      assert.strictEqual((await a.client.next("error")).data["code"], "not_authenticated", "antes de entrar na zona");
      await join(a);
      a.client.send("inspect", { playerId: "fake_accept" });
      const attributes: ReceivedMessage = await a.client.next("attributes");
      assert.strictEqual(attributes.data["name"], "Fake Aceita");
      assert.strictEqual(attributes.data["level"], TEST_FAKE_PLAYERS[0]?.level);
      const equipped: unknown = attributes.data["equipped"];
      assert.ok(typeof equipped === "object" && equipped !== null && "hand" in equipped);
      a.client.send("inspect", { playerId: a.playerId });
      assert.strictEqual((await a.client.next("attributes")).data["name"], "Inspetor", "dá para ver os próprios");
      a.client.send("inspect", { playerId: "ninguem" });
      assert.strictEqual((await a.client.next("error")).data["code"], "player_not_found");
    });
  });

  describe("grupo (group_*)", () => {
    it("convite pela rede: fake aceita, jogador recebe group_invited, aceita; desconectar tira do grupo", async () => {
      const a: Player = await registered("Lider");
      a.client.send("group_invite", { playerId: "fake_accept" });
      assert.strictEqual((await a.client.next("error")).data["code"], "not_authenticated", "antes de entrar na zona");
      await join(a);
      a.client.send("group_invite", { playerId: "fake_accept" });
      assert.strictEqual((await a.client.next("group_notice")).data["code"], "accepted");
      const group: unknown = (await a.client.next("group")).data["group"];
      assert.ok(typeof group === "object" && group !== null && "leaderId" in group);
      assert.strictEqual(group.leaderId, a.playerId);

      const b: Player = await registered("Convidado");
      await join(b);
      a.client.send("group_invite", { playerId: b.playerId });
      const invited: ReceivedMessage = await b.client.next("group_invited");
      assert.strictEqual(invited.data["fromName"], "Lider");
      b.client.send("group_answer", { fromId: a.playerId, accept: true });
      assert.strictEqual((await a.client.next("group_notice")).data["code"], "accepted");
      b.client.send("group_kick", { playerId: a.playerId });
      assert.strictEqual((await b.client.next("error")).data["code"], "not_group_leader");

      await a.client.close();
      // A saiu: o próximo que entrou (o fake) vira líder; sobram o fake e B.
      const after: ReceivedMessage = await b.client.nextMatching("group", (m) => {
        const g: unknown = m.data["group"];
        return typeof g === "object" && g !== null && "leaderId" in g && g.leaderId === "fake_accept";
      });
      assert.ok(after !== undefined);
      b.client.send("group_leave", {});
      const left: unknown = (await b.client.nextMatching("group", (m) => m.data["group"] === null)).data["group"];
      assert.strictEqual(left, null);
    });
  });

  describe("zona", () => {
    it("entra na zona e avisa os outros, com o nome de cada um", async () => {
      const a: Player = await registered("Alice");
      assert.strictEqual(entryOf(await join(a), a.playerId)?.["name"], "Alice");

      const b: Player = await registered("Bob_2");
      const players: unknown[] = await join(b);
      // Os dois jogadores + os jogadores fake de teste ([SOC-01]), que vêm como jogadores.
      assert.strictEqual(players.length, 2 + TEST_FAKE_PLAYERS.length);
      assert.strictEqual(entryOf(players, a.playerId)?.["name"], "Alice");
      assert.strictEqual(entryOf(players, "fake_accept")?.["name"], "Fake Aceita");
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
      // Posição em mm (a simulação arredonda): até 1 mm de diferença da conta exata.
      assert.ok(typeof after === "number" && Math.abs(after - (startX + MOVE_SPEED * TICK_SECONDS)) <= 0.0006);

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
      // Snapshot por diferença ([INFRA-11]): andou só em Z, então só o z (e o que mais mudou) vem nele.
      const whereZ: unknown = entryOf(last.data["players"], first.playerId)?.["z"];
      assert.ok(typeof whereZ === "number");
      await first.client.close();
      await sleep(20); // savePosition é assíncrono

      const c: TestClient = await connect();
      c.send("resume", { version: PROTOCOL_VERSION, sessionToken: first.sessionToken });
      await c.next("auth_ok");
      c.send("join", { zone: ZONE });
      const players: unknown = (await c.next("welcome")).data["players"];
      const me = entryOf(players, first.playerId);
      assert.strictEqual(me?.["z"], whereZ, "voltou no mesmo lugar");
      assert.deepStrictEqual(
        me?.["look"],
        { hand: null, head: null, chest: null, feet: null },
        "welcome leva a aparência (conta nova: nada vestido)",
      );
    });

    it("baús dos acampamentos ([JOGO-19]): vêm no welcome; abrir fechado/inexistente é recusado", async () => {
      const a: Player = await registered();
      a.client.send("join", { zone: ZONE });
      const welcome: ReceivedMessage = await a.client.next("welcome");
      const chests: unknown = welcome.data["chests"];
      assert.ok(Array.isArray(chests) && chests.length === (ZONE_CONFIGS[0]?.camps?.length ?? 0) && chests.length > 0, "baús no welcome");
      const first: unknown = chests[0];
      assert.ok(typeof first === "object" && first !== null && "id" in first && typeof first.id === "string" && "open" in first && first.open === false);
      a.client.send("chest_open", { chestId: first.id });
      assert.strictEqual((await a.client.next("error")).data["code"], "chest_closed");
      a.client.send("chest_take", { chestId: "nao_existe", lootId: "gold" });
      assert.strictEqual((await a.client.next("error")).data["code"], "chest_not_found");
    });

    it("attack fixa o alvo (aparece em snapshot.me.target) e recusa alvo inexistente", async () => {
      const a: Player = await registered();
      const players: unknown[] = await join(a);
      assert.ok(players.length >= 1);
      a.client.send("attack", { targetId: "nao-existe" });
      assert.strictEqual((await a.client.next("error")).data["code"], "invalid_target");
      a.client.send("attack", { targetId: "dummy_2" });
      const snap: ReceivedMessage = await a.client.nextMatching("snapshot", (m) => {
        const me: unknown = m.data["me"];
        return typeof me === "object" && me !== null && "target" in me && me.target === "dummy_2";
      });
      const npcs: unknown = snap.data["npcs"];
      // Só os NPCs perto (área de interesse, VIEW_RADIUS) vêm no snapshot.
      const near: number = (ZONE_CONFIGS[0]?.dummies ?? []).filter((d) => Math.hypot(d.x, d.z) <= VIEW_RADIUS + 4).length;
      // Snapshot por diferença: pode vir só quem mudou (até nenhum), mas nunca quem está longe.
      assert.ok(Array.isArray(npcs) && npcs.length <= near, "só NPCs da área de interesse no snapshot");
    });

    it("cast: aceito vira cast_start; durante o lançamento = busy; depois, antes da recarga = on_cooldown", async () => {
      const a: Player = await registered();
      await wear(a, "training_vest");
      await join(a);
      a.client.send("cast", { abilityId: "shield" });
      await a.client.nextMatching("snapshot", (m) => {
        const events: unknown = m.data["events"];
        return Array.isArray(events) && events.some((e) => typeof e === "object" && e !== null && "type" in e && e.type === "cast_start");
      });
      a.client.send("cast", { abilityId: "shield" });
      assert.strictEqual((await a.client.next("error")).data["code"], "busy", "ainda lançando");
      await sleep(400);
      a.client.send("cast", { abilityId: "shield" });
      assert.strictEqual((await a.client.next("error")).data["code"], "on_cooldown");
      a.client.send("cast", { abilityId: "nao_existe" });
      assert.strictEqual((await a.client.next("error")).data["code"], "ability_not_equipped");
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

import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore, type Account } from "../src/accounts/AccountStore.js";
import { FRIEND_REQUEST_SECONDS, PROTOCOL_VERSION, ServerMessageType, type ServerMessage } from "../src/net/protocol.js";
import { FRIEND_REQUEST_MS, FriendRequests, readFriendIds } from "../src/social/friends.js";
import { TestClient, sleep, type ReceivedMessage, ZONES_WITH_FAKES } from "./helpers.js";

const ZONE = "zone_1";
const PASSWORD = "senha-forte-123";

/** Jogador conectado e autenticado. */
interface Player {
  readonly client: TestClient;
  readonly playerId: string;
  readonly sessionToken: string;
}

/** Lista `friends` como pares "id:online" (para comparar fácil). */
function friendList(message: ReceivedMessage): string[] {
  const friends: unknown = message.data["friends"];
  assert.ok(Array.isArray(friends));
  return friends.map((f: unknown) => {
    assert.ok(typeof f === "object" && f !== null && "id" in f && "online" in f && "name" in f);
    return `${String(f.id)}:${f.online === true ? "on" : "off"}`;
  });
}

describe("amizade e configuração social (friend_*, social_settings)", () => {
  let server: GameServer;
  let store: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  async function registered(username: string): Promise<Player> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("register", { version: PROTOCOL_VERSION, username, email: `${username}@teste.com`, password: PASSWORD });
    const ok: ReceivedMessage = await client.next("auth_ok");
    const { playerId, sessionToken } = ok.data;
    assert.ok(typeof playerId === "string" && typeof sessionToken === "string");
    assert.deepStrictEqual(ok.data["social"], { friendRequests: "always", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" }, "conta nova mostra tudo");
    client.send("choose_body", { body: "male" });
    await client.next("body_chosen");
    return { client, playerId, sessionToken };
  }

  /** Espera a próxima lista `friends` igual a `expected` (as anteriores, intermediárias, são descartadas). */
  function friendsBecome(player: Player, expected: string[]): Promise<ReceivedMessage> {
    return player.client.nextMatching("friends", (m) => JSON.stringify(friendList(m)) === JSON.stringify(expected));
  }

  async function saved(player: Player): Promise<Account> {
    const account: Account | null = await store.resume(player.sessionToken);
    assert.ok(account !== null);
    return account;
  }

  beforeEach(async () => {
    store = new InMemoryAccountStore();
    server = new GameServer({ accounts: store, heartbeatIntervalMs: 100, log: false, zones: ZONES_WITH_FAKES });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  it("fakes: Fake Aceita vira amigo na hora (só na memória), Fake Recusa recusa; já amigo e remover", async () => {
    const a: Player = await registered("Amigavel");
    await friendsBecome(a, []);
    a.client.send("friend_request", { playerId: "fake_accept" });
    const accepted: ReceivedMessage = await a.client.next("friend_notice");
    assert.strictEqual(accepted.data["code"], "accepted");
    assert.strictEqual(accepted.data["message"], "Fake Aceita aceitou o pedido de amizade.");
    await friendsBecome(a, ["fake_accept:on"]);
    assert.deepStrictEqual((await saved(a)).friends, [], "amizade com fake não vai para a conta");

    a.client.send("friend_request", { playerId: "fake_accept" });
    assert.strictEqual((await a.client.next("error")).data["code"], "already_friends");

    a.client.send("friend_request", { playerId: "fake_reject" });
    const rejected: ReceivedMessage = await a.client.next("friend_notice");
    assert.strictEqual(rejected.data["code"], "rejected");
    assert.strictEqual(rejected.data["message"], "Fake Recusa recusou o pedido de amizade.");

    a.client.send("friend_remove", { playerId: "fake_accept" });
    assert.strictEqual((await a.client.next("friend_notice")).data["code"], "removed");
    await friendsBecome(a, []);
    a.client.send("friend_remove", { playerId: "fake_accept" });
    assert.strictEqual((await a.client.next("error")).data["code"], "not_friends");
  });

  it("entre jogadores: pedido, duplicado, aceite (salvo nas duas contas), online/offline e remoção mútua", async () => {
    const a: Player = await registered("Ana");
    const b: Player = await registered("Beto");
    a.client.send("friend_request", { playerId: b.playerId });
    const request: ReceivedMessage = await b.client.next("friend_requested");
    assert.deepStrictEqual(request.data, { fromId: a.playerId, fromName: "Ana", expiresIn: FRIEND_REQUEST_SECONDS });
    a.client.send("friend_request", { playerId: b.playerId });
    assert.strictEqual((await a.client.next("error")).data["code"], "friend_request_pending", "pedido repetido");

    b.client.send("friend_answer", { fromId: a.playerId, accept: true });
    const notice: ReceivedMessage = await a.client.next("friend_notice");
    assert.strictEqual(notice.data["message"], "Beto aceitou o pedido de amizade.");
    assert.strictEqual((await b.client.next("friend_notice")).data["code"], "added");
    await friendsBecome(a, [`${b.playerId}:on`]);
    await friendsBecome(b, [`${a.playerId}:on`]);
    assert.deepStrictEqual((await saved(a)).friends, [b.playerId]);
    assert.deepStrictEqual((await saved(b)).friends, [a.playerId]);

    b.client.send("friend_request", { playerId: a.playerId });
    assert.strictEqual((await b.client.next("error")).data["code"], "already_friends");

    // B sai do servidor: A o vê offline (nome vem do banco/cache); B volta: online de novo, com a lista salva.
    await b.client.close();
    const offline: ReceivedMessage = await friendsBecome(a, [`${b.playerId}:off`]);
    assert.ok(JSON.stringify(offline.data).includes("Beto"));
    const back: TestClient = await TestClient.connect(port);
    clients.push(back);
    back.send("resume", { version: PROTOCOL_VERSION, sessionToken: b.sessionToken });
    await back.next("auth_ok");
    const bBack: Player = { client: back, playerId: b.playerId, sessionToken: b.sessionToken };
    await friendsBecome(bBack, [`${a.playerId}:on`]);
    await friendsBecome(a, [`${b.playerId}:on`]);

    // Remoção mútua (o outro estando online).
    bBack.client.send("friend_remove", { playerId: a.playerId });
    assert.strictEqual((await bBack.client.next("friend_notice")).data["message"], "Ana foi removido dos seus amigos.");
    await friendsBecome(a, []);
    await friendsBecome(bBack, []);
    assert.deepStrictEqual((await saved(a)).friends, []);
    assert.deepStrictEqual((await saved(b)).friends, []);
  });

  it("recusa, pedidos cruzados viram amizade, pedido a si mesmo/a quem não está online, resposta sem pedido", async () => {
    const a: Player = await registered("Caio");
    const b: Player = await registered("Duda");
    a.client.send("friend_request", { playerId: b.playerId });
    await b.client.next("friend_requested");
    b.client.send("friend_answer", { fromId: a.playerId, accept: false });
    assert.strictEqual((await a.client.next("friend_notice")).data["message"], "Duda recusou o pedido de amizade.");
    b.client.send("friend_answer", { fromId: a.playerId, accept: true });
    assert.strictEqual((await b.client.next("error")).data["code"], "friend_request_not_found");

    // Cada um pede ao outro: o segundo pedido vale como aceite.
    a.client.send("friend_request", { playerId: b.playerId });
    await b.client.next("friend_requested");
    b.client.send("friend_request", { playerId: a.playerId });
    assert.strictEqual((await b.client.next("friend_notice")).data["code"], "added", "B aceitou o pedido de A");
    assert.strictEqual((await a.client.next("friend_notice")).data["code"], "accepted");
    await friendsBecome(a, [`${b.playerId}:on`]);

    a.client.send("friend_request", { playerId: a.playerId });
    assert.strictEqual((await a.client.next("error")).data["code"], "invalid_friend_request");
    a.client.send("friend_request", { playerId: "ninguem" });
    assert.strictEqual((await a.client.next("error")).data["code"], "player_not_found");
  });

  it("Configuração: ocultar pedidos de amizade recusa sozinho; salvo na conta e devolvido no auth_ok", async () => {
    const a: Player = await registered("Edu");
    const b: Player = await registered("Fabi");
    b.client.send("social_settings", { friendRequests: "hide", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" });
    assert.deepStrictEqual((await b.client.next("social_settings")).data, { friendRequests: "hide", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" });
    assert.deepStrictEqual((await saved(b)).social, { friendRequests: "hide", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" });

    a.client.send("friend_request", { playerId: b.playerId });
    assert.strictEqual((await a.client.next("friend_notice")).data["message"], "Fabi recusou o pedido de amizade.");
    await sleep(100);
    assert.strictEqual(b.client.hasPending("friend_requested"), false, "nada aparece para quem oculta");

    b.client.send("social_settings", { friendRequests: "hide" });
    assert.strictEqual((await b.client.next("error")).data["code"], "bad_message", "as três opções são obrigatórias");

    const again: TestClient = await TestClient.connect(port);
    clients.push(again);
    again.send("resume", { version: PROTOCOL_VERSION, sessionToken: b.sessionToken });
    assert.deepStrictEqual((await again.next("auth_ok")).data["social"], { friendRequests: "hide", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" });
  });

  it("Perfil ([SOC-08]): público mostra tudo; só amigos/ninguém fecha os Atributos; você sempre vê o seu", async () => {
    const a: Player = await registered("Iara");
    const b: Player = await registered("Juca");
    for (const p of [a, b]) {
      p.client.send("join", { zone: ZONE });
      await p.client.next("welcome");
    }
    a.client.send("inspect", { playerId: b.playerId });
    const open: ReceivedMessage = await a.client.next("attributes");
    assert.deepStrictEqual(open.data["stats"], { monsterXp: 0, kills: 0, deaths: 0 }, "público: contadores do perfil");

    b.client.send("social_settings", { friendRequests: "always", groupInvites: "always", guildInvites: "always", profile: "nobody", tradeRequests: "always" });
    await b.client.next("social_settings");
    assert.strictEqual((await saved(b)).social.profile, "nobody");
    a.client.send("inspect", { playerId: b.playerId });
    assert.deepStrictEqual((await a.client.next("attributes")).data, { id: b.playerId, name: "Juca", level: 0, hidden: true });
    b.client.send("inspect", { playerId: b.playerId });
    assert.ok((await b.client.next("attributes")).data["stats"] !== undefined, "o dono vê o próprio perfil");

    b.client.send("social_settings", { friendRequests: "always", groupInvites: "always", guildInvites: "always", profile: "friends", tradeRequests: "always" });
    await b.client.next("social_settings");
    a.client.send("inspect", { playerId: b.playerId });
    assert.strictEqual((await a.client.next("attributes")).data["hidden"], true, "ainda não são amigos");
    a.client.send("friend_request", { playerId: b.playerId });
    await b.client.next("friend_requested");
    b.client.send("friend_answer", { fromId: a.playerId, accept: true });
    await a.client.next("friend_notice");
    a.client.send("inspect", { playerId: b.playerId });
    assert.ok((await a.client.next("attributes")).data["equipped"] !== undefined, "amigo vê tudo");
  });

  it("guilda pela rede ([SOC-06]): sem moedas recusa; com 1000 cria, convida o Fake Aceita e a tag chega à zona", async () => {
    const a: Player = await registered("Lider");
    a.client.send("join", { zone: ZONE });
    await a.client.next("welcome");
    a.client.send("guild_create", { name: "Ordem", tag: "ord" });
    assert.strictEqual((await a.client.next("error")).data["code"], "not_enough_gold");

    // Com moedas na conta: entra de novo (a conta é lida no resume).
    await store.saveProgress(a.playerId, { level: 0, xp: 0, gold: 1500 });
    const again: TestClient = await TestClient.connect(port);
    clients.push(again);
    again.send("resume", { version: PROTOCOL_VERSION, sessionToken: a.sessionToken });
    assert.deepStrictEqual((await again.next("guild")).data, { guild: null });
    again.send("join", { zone: ZONE });
    await again.next("welcome");
    again.send("guild_create", { name: "Ordem", tag: "ord" });
    const created: ReceivedMessage = await again.nextMatching("guild", (m) => m.data["guild"] !== null);
    assert.strictEqual(JSON.stringify(created.data).includes('"tag":"ORD"'), true);
    const tag: ReceivedMessage = await again.nextMatching("player_guild", (m) => m.data["id"] === a.playerId);
    assert.strictEqual(tag.data["guildTag"], "ORD");
    assert.strictEqual((await saved(a)).progress.gold, 500, "cobrou 1000");

    again.send("guild_invite", { playerId: "fake_accept" });
    await again.nextMatching("guild", (m) => JSON.stringify(m.data).includes("fake_accept"));
    const fakeTag: ReceivedMessage = await again.nextMatching("player_guild", (m) => m.data["id"] === "fake_accept");
    assert.strictEqual(fakeTag.data["guildTag"], "ORD");
    again.send("guild_kick", { playerId: "fake_accept" });
    await again.nextMatching("player_guild", (m) => m.data["id"] === "fake_accept" && m.data["guildId"] === null);
  });

  it("Configuração: ocultar convites de grupo (opção da conta) recusa sozinho e vale na hora", async () => {
    const a: Player = await registered("Gil");
    const b: Player = await registered("Hana");
    for (const p of [a, b]) {
      p.client.send("join", { zone: ZONE });
      await p.client.next("welcome");
    }
    b.client.send("social_settings", { friendRequests: "always", groupInvites: "hide", guildInvites: "always", profile: "public", tradeRequests: "always" });
    await b.client.next("social_settings");
    a.client.send("group_invite", { playerId: b.playerId });
    const notice: ReceivedMessage = await a.client.next("group_notice");
    assert.strictEqual(notice.data["code"], "rejected");
    assert.strictEqual(notice.data["message"], "Hana recusou o convite.");
    assert.strictEqual(b.client.hasPending("group_invited"), false);

    b.client.send("social_settings", { friendRequests: "always", groupInvites: "always", guildInvites: "always", profile: "public", tradeRequests: "always" });
    await b.client.next("social_settings");
    a.client.send("group_invite", { playerId: b.playerId });
    assert.strictEqual((await b.client.next("group_invited")).data["fromName"], "Gil", "voltou a mostrar na hora");
  });
});

describe("FriendRequests (regras sem rede)", () => {
  /** Host em memória: a, b e c online; amizades num Set "a|b". */
  function setup(): { requests: FriendRequests; sent: Array<{ to: string; message: ServerMessage }>; friends: Set<string> } {
    const sent: Array<{ to: string; message: ServerMessage }> = [];
    const friends: Set<string> = new Set();
    const key = (x: string, y: string): string => [x, y].sort().join("|");
    const requests: FriendRequests = new FriendRequests({
      send: (to, message): void => {
        sent.push({ to, message });
      },
      nameOf: (id): string | undefined => (["a", "b", "c"].includes(id) ? id.toUpperCase() : undefined),
      autoAnswer: (): null => null,
      areFriends: (x, y): boolean => friends.has(key(x, y)),
      friendCount: (id): number => [...friends].filter((k) => k.split("|").includes(id)).length,
      befriend: (x, y): void => {
        friends.add(key(x, y));
      },
    });
    return { requests, sent, friends };
  }

  it("pedido sem resposta expira e quem pediu recebe 'não respondeu'", () => {
    const { requests, sent } = setup();
    assert.deepStrictEqual(requests.request("a", "b", 1000), { ok: true });
    assert.strictEqual(sent[0]?.message.type, ServerMessageType.FriendRequested);
    requests.expire(1000 + FRIEND_REQUEST_MS - 1);
    assert.ok(requests.hasRequest("b", "a"), "ainda no prazo");
    requests.expire(1000 + FRIEND_REQUEST_MS);
    assert.strictEqual(requests.hasRequest("b", "a"), false);
    const last: ServerMessage | undefined = sent.at(-1)?.message;
    assert.ok(last?.type === ServerMessageType.FriendNotice && last.data.code === "expired");
    assert.strictEqual(last.data.message, "B não respondeu ao pedido de amizade.");
  });

  it("quem sai do servidor leva os pedidos junto", () => {
    const { requests } = setup();
    requests.request("a", "b", 0);
    requests.request("c", "a", 0);
    requests.removePlayer("a");
    assert.strictEqual(requests.hasRequest("b", "a"), false);
    assert.strictEqual(requests.hasRequest("a", "c"), false);
  });

  it("readFriendIds: conta antiga/estragada vira lista vazia; ignora lixo e repetidos", () => {
    assert.deepStrictEqual(readFriendIds(undefined), []);
    assert.deepStrictEqual(readFriendIds("x"), []);
    assert.deepStrictEqual(readFriendIds(["a", 3, "a", "", "b"]), ["a", "b"]);
  });
});

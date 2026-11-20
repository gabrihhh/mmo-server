import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore, type Account } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import type { ZoneConfig } from "../src/zones/Zone.js";
import { TestClient, sleep, type ReceivedMessage } from "./helpers.js";

/** Coliseu pela rede ([JOGO-28]): fila na praça, aceite, arena, rounds, prêmio/ranking e volta à praça. */

const PASSWORD = "senha-forte-123";

/** Zona mínima com a praça de pedra no centro: todo mundo nasce nela (a fila só se entra lá). */
const PLAZA_ZONE: ZoneConfig = { id: "zone_1", halfSize: 50, maxPlayers: 20, spawnRadius: 3, pvp: true, dummies: [], safeZoneHalf: 10 };

const DPS_BUILD = { hand: "Mago", head: "Cavaleiro", chest: "Cavaleiro", feet: "Atirador" };
const HEALER_BUILD = { hand: "Curandeiro", head: "Curandeiro", chest: "Cavaleiro", feet: "Mago" };

interface Player {
  readonly client: TestClient;
  readonly token: string;
  readonly id: string;
}

describe("Coliseu pela rede (colosseum_*)", () => {
  let server: GameServer;
  let store: InMemoryAccountStore;
  let port: number;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    store = new InMemoryAccountStore();
    server = new GameServer({
      accounts: store,
      heartbeatIntervalMs: 1000,
      log: false,
      zones: [PLAZA_ZONE],
      colosseum: { acceptWindowMs: 2000, prepSeconds: 0.3, roundSeconds: 0.3, pauseSeconds: 0.1, random: () => 0.5 },
    });
    port = await server.listen(0);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  /** Cadastra, escolhe o corpo e entra na zona 1 (na praça). */
  async function enter(username: string, email: string = `${username}@teste.com`): Promise<Player> {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("register", { version: PROTOCOL_VERSION, username, email, password: PASSWORD });
    const ok: ReceivedMessage = await client.next("auth_ok");
    const token: unknown = ok.data["sessionToken"];
    const id: unknown = ok.data["playerId"];
    assert.ok(typeof token === "string" && typeof id === "string");
    client.send("choose_body", { body: "male" });
    await client.next("body_chosen");
    client.send("join", { zone: "zone_1" });
    const welcome: ReceivedMessage = await client.next("welcome");
    assert.strictEqual(welcome.data["kind"], undefined, "zona comum não marca kind");
    return { client, token, id };
  }

  async function saved(player: Player): Promise<Account> {
    const account: Account | null = await store.resume(player.token);
    assert.ok(account !== null);
    return account;
  }

  /** Todos entram na fila, a partida é encontrada, todos aceitam e chegam na arena. */
  async function startMatch(mode: string, players: ReadonlyArray<{ player: Player; build: Record<string, string> }>): Promise<void> {
    for (const { player, build } of players) {
      player.client.send("colosseum_queue", { mode, build });
      const info: ReceivedMessage = await player.client.next("colosseum_info");
      assert.strictEqual(info.data["queued"], mode);
    }
    for (const { player } of players) {
      const found: ReceivedMessage = await player.client.next("colosseum_found");
      assert.strictEqual(found.data["total"], players.length);
    }
    for (const { player } of players) player.client.send("colosseum_accept", {});
    for (const { player } of players) {
      const welcome: ReceivedMessage = await player.client.nextMatching("welcome", (m) => m.data["kind"] === "arena", 3000);
      assert.ok(Array.isArray(welcome.data["players"]) && welcome.data["players"].length === players.length);
      assert.deepStrictEqual(welcome.data["npcs"], []);
    }
  }

  it("1x1: fila → aceite → arena → 9 rounds empatados → prêmio de empate e volta à praça", async function () {
    this.timeout(20000);
    const a: Player = await enter("Alfa");
    const b: Player = await enter("Bravo");
    const before: Account = await saved(a);
    await startMatch("1x1", [{ player: a, build: DPS_BUILD }, { player: b, build: DPS_BUILD }]);

    // Dentro da arena: inventário e serviços recusados; a escolha da preparação vale.
    a.client.send("equip", { uid: "qualquer" });
    assert.strictEqual((await a.client.next("error")).data["code"], "in_colosseum");
    a.client.send("colosseum_point", { slot: "chest", attribute: "defense" });
    const state: ReceivedMessage = await a.client.nextMatching("colosseum_state", (m) => m.data["choicesLeft"] === 19);
    assert.strictEqual(state.data["phase"], "prep");
    // As peças vêm no placar: a do peito (Cavaleiro) já com o ponto e os atributos que aceita.
    const pieces: unknown = state.data["pieces"];
    assert.ok(Array.isArray(pieces) && pieces.length === 4);
    const chest: unknown = pieces.find((p: unknown) => typeof p === "object" && p !== null && Reflect.get(p, "slot") === "chest");
    assert.deepStrictEqual(Reflect.get(chest as object, "attrs"), { defense: 1 });
    assert.ok((Reflect.get(chest as object, "allowed") as unknown[]).includes("defense"));

    // Ninguém se mexe: os rounds acabam no tempo empatados (vida e dano iguais) até o limite de 9.
    const result: ReceivedMessage = await a.client.next("colosseum_result", 15000);
    assert.strictEqual(result.data["outcome"], "draw");
    assert.strictEqual(result.data["annulled"], false);
    assert.strictEqual(result.data["gold"], 30);
    assert.strictEqual(result.data["ratingDelta"], 0);
    assert.strictEqual(result.data["points"], 3);
    const back: ReceivedMessage = await a.client.nextMatching("welcome", (m) => m.data["kind"] === undefined, 3000);
    assert.strictEqual(back.data["zone"], "zone_1");
    await sleep(100);
    const after: Account = await saved(a);
    assert.strictEqual(after.progress.gold, before.progress.gold + 30);
    assert.strictEqual(after.colosseum.points, 3);
    assert.strictEqual(after.colosseum.daily.count, 1);
    assert.deepStrictEqual(after.lastPosition, before.lastPosition === null ? after.lastPosition : before.lastPosition);
    assert.strictEqual(after.lastPosition?.zone, "zone_1", "a posição da arena nunca é salva");
  });

  it("3x3 com 6 conexões: o time 1 inteiro abandona depois do round 1 → time 0 vence; ranking e bloqueio gravados", async function () {
    this.timeout(20000);
    const players: Player[] = [];
    for (const name of ["Dps1", "Dps2", "Dps3", "Dps4", "Cura1", "Cura2"]) players.push(await enter(name));
    const entries = players.map((player, index) => ({ player, build: index < 4 ? DPS_BUILD : HEALER_BUILD }));
    await startMatch("3x3", entries);
    // Times por ordem de chegada: Dps1, Dps3, Cura1 (time 0) × Dps2, Dps4, Cura2 (time 1).
    const [dps1, dps2, dps3, dps4, cura1, cura2] = players;
    assert.ok(dps1 !== undefined && dps2 !== undefined && dps3 !== undefined && dps4 !== undefined && cura1 !== undefined && cura2 !== undefined);
    const stateOf: ReceivedMessage = await dps1.client.nextMatching("colosseum_state", (m) => m.data["phase"] === "pause", 5000);
    assert.strictEqual(stateOf.data["round"], 1);
    for (const quitter of [dps2, dps4, cura2]) quitter.client.send("colosseum_leave_match", {});

    const win: ReceivedMessage = await dps1.client.next("colosseum_result", 5000);
    assert.strictEqual(win.data["outcome"], "win");
    assert.strictEqual(win.data["gold"], 100);
    assert.strictEqual(win.data["ratingDelta"], 20);
    const quit: ReceivedMessage = await dps2.client.next("colosseum_result", 5000);
    assert.strictEqual(quit.data["outcome"], "abandon");
    assert.strictEqual(quit.data["rating"], 0, "piso 0");
    await sleep(100);
    assert.strictEqual((await saved(dps3)).colosseum.rating["3x3"], 20);
    assert.strictEqual((await saved(cura1)).colosseum.rating["3x3"], 20);
    const banned: Account = await saved(cura2);
    assert.ok(banned.colosseum.banUntil > Date.now() + 9 * 60_000, "abandono = 10 min sem fila");

    // Quem abandonou já voltou à praça e não entra na fila.
    cura2.client.send("colosseum_queue", { mode: "2x2", build: HEALER_BUILD });
    assert.strictEqual((await cura2.client.nextMatching("error", (m) => m.data["code"] !== "in_colosseum")).data["code"], "colosseum_banned");
  });

  it("recusas: quem recusou sai, o outro volta à fila; convidado e healer no 1x1 são recusados", async function () {
    this.timeout(10000);
    const a: Player = await enter("Carlos");
    const b: Player = await enter("Diana");
    a.client.send("colosseum_queue", { mode: "1x1", build: HEALER_BUILD });
    assert.strictEqual((await a.client.next("error")).data["code"], "colosseum_healer_not_allowed");
    a.client.send("colosseum_queue", { mode: "1x1", build: DPS_BUILD });
    await a.client.next("colosseum_info");
    b.client.send("colosseum_queue", { mode: "1x1", build: DPS_BUILD });
    await b.client.next("colosseum_info");
    await a.client.next("colosseum_found");
    await b.client.next("colosseum_found");
    b.client.send("colosseum_decline", {});
    assert.deepStrictEqual((await b.client.next("colosseum_cancelled")).data, { reason: "you_refused", requeued: false, banSeconds: 0 });
    assert.deepStrictEqual((await a.client.next("colosseum_cancelled")).data, { reason: "other_refused", requeued: true, banSeconds: 0 });
    a.client.send("colosseum_open", {});
    assert.strictEqual((await a.client.nextMatching("colosseum_info", (m) => m.data["queued"] === "1x1")).data["queued"], "1x1");

    const guest: Player = await enter("Convidado1", "c1@convidado.local");
    guest.client.send("colosseum_queue", { mode: "1x1", build: DPS_BUILD });
    assert.strictEqual((await guest.client.next("error")).data["code"], "colosseum_guest");
  });

  it("a arena não é acessível pelo join comum", async () => {
    const client: TestClient = await TestClient.connect(port);
    clients.push(client);
    client.send("register", { version: PROTOCOL_VERSION, username: "Curioso", email: "curioso@teste.com", password: PASSWORD });
    await client.next("auth_ok");
    client.send("choose_body", { body: "male" });
    await client.next("body_chosen");
    client.send("join", { zone: "arena_m1" });
    assert.strictEqual((await client.next("error")).data["code"], "unknown_zone");
  });
});

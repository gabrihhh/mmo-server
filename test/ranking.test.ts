import assert from "assert";

import { GameServer } from "../src/GameServer.js";
import { InMemoryAccountStore } from "../src/accounts/AccountStore.js";
import { PROTOCOL_VERSION } from "../src/net/protocol.js";
import {
  EMPTY_PERIODS,
  RankingBoards,
  addToPeriods,
  dayKey,
  playerValue,
  rankRows,
  readPeriods,
  secondsUntilReset,
  weekKey,
  type RankingSource,
} from "../src/progression/ranking.js";
import { STARTING_STATS } from "../src/progression/stats.js";
import { TestClient, ZONES_WITH_FAKES } from "./helpers.js";

/** 2026-11-17 (terça) 12:00 em Brasília = 15:00 UTC. */
const TUESDAY_NOON: number = Date.UTC(2026, 10, 17, 15, 0, 0);
const HOUR = 3_600_000;

function source(id: string, monsterXp: number, kills: number, periods = EMPTY_PERIODS): RankingSource {
  return { id, name: id.toUpperCase(), stats: { ...STARTING_STATS, monsterXp, kills }, periods };
}

describe("rankings ([SOC-07])", () => {
  it("dia e semana de Brasília (UTC−3): a meia-noite e a segunda-feira viram", () => {
    assert.strictEqual(dayKey(TUESDAY_NOON), "2026-11-17");
    assert.strictEqual(weekKey(TUESDAY_NOON), "2026-11-16", "segunda da semana");
    // 23:30 de Brasília ainda é o mesmo dia (02:30 UTC do dia seguinte).
    assert.strictEqual(dayKey(Date.UTC(2026, 10, 18, 2, 30)), "2026-11-17");
    assert.strictEqual(dayKey(Date.UTC(2026, 10, 18, 3, 0)), "2026-11-18", "meia-noite de Brasília");
    // Domingo 23h → ainda a semana de 16; segunda 00h → semana de 23.
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 23, 2, 0)), "2026-11-16");
    assert.strictEqual(weekKey(Date.UTC(2026, 10, 23, 3, 0)), "2026-11-23");
    assert.strictEqual(secondsUntilReset("daily", TUESDAY_NOON), 12 * 3600);
    assert.strictEqual(secondsUntilReset("weekly", TUESDAY_NOON), (6 * 24 - 12) * 3600, "até segunda 00h");
    assert.strictEqual(secondsUntilReset("global", TUESDAY_NOON), 0);
  });

  it("contadores do período: somam no mesmo dia/semana e recomeçam quando viram", () => {
    let p = addToPeriods(EMPTY_PERIODS, 20, 1, TUESDAY_NOON);
    p = addToPeriods(p, 5.5, 0, TUESDAY_NOON + HOUR);
    assert.deepStrictEqual(p, { day: "2026-11-17", dayMonsterXp: 25.5, dayKills: 1, week: "2026-11-16", weekMonsterXp: 25.5, weekKills: 1 });
    const nextDay = addToPeriods(p, 10, 0, TUESDAY_NOON + 24 * HOUR);
    assert.deepStrictEqual([nextDay.dayMonsterXp, nextDay.dayKills, nextDay.weekMonsterXp, nextDay.weekKills], [10, 0, 35.5, 1]);
    assert.strictEqual(addToPeriods(p, -3, 0, TUESDAY_NOON), p, "nada a somar");
    assert.deepStrictEqual(readPeriods({ day: 3, dayKills: -1 }), EMPTY_PERIODS);
    // Valor do dia antigo não conta hoje.
    assert.strictEqual(playerValue(source("a", 99, 0, p), "monsters", "daily", TUESDAY_NOON + 24 * HOUR), 0);
    assert.strictEqual(playerValue(source("a", 99, 0, p), "monsters", "global", TUESDAY_NOON), 99);
  });

  it("tabelas: maior primeiro, zero fora, empate pelo nome; guilda soma os membros atuais", () => {
    assert.deepStrictEqual(rankRows([{ id: "b", name: "B", value: 5 }, { id: "a", name: "A", value: 5 }, { id: "z", name: "Z", value: 0 }]).map((r) => [r.rank, r.id]), [[1, "a"], [2, "b"]]);
    const today = addToPeriods(EMPTY_PERIODS, 30, 2, TUESDAY_NOON);
    const sources: RankingSource[] = [source("a", 100, 0, today), source("b", 50, 3), source("c", 10, 1)];
    const boards = new RankingBoards(sources, [{ id: "g1", name: "[ORD] Ordem", memberIds: ["b", "c"] }, { id: "g2", name: "[SOL] Só", memberIds: ["a"] }], TUESDAY_NOON);
    assert.deepStrictEqual(boards.top("monsters", "global").map((r) => r.id), ["a", "b", "c"]);
    assert.deepStrictEqual(boards.top("pvp", "global").map((r) => r.id), ["b", "c"]);
    assert.deepStrictEqual(boards.top("monsters", "daily").map((r) => [r.id, r.value]), [["a", 30]]);
    assert.deepStrictEqual(boards.top("guild_monsters", "global").map((r) => [r.id, r.value]), [["g2", 100], ["g1", 60]]);
    assert.deepStrictEqual(boards.top("guild_pvp", "global").map((r) => [r.id, r.value]), [["g1", 4]]);
    assert.strictEqual(boards.rowOf("monsters", "global", "c")?.rank, 3);
    assert.strictEqual(boards.rowOf("pvp", "daily", "b"), null, "não pontuou hoje");
  });

  it("pela rede: ranking_request devolve top + a sua linha; convidado fica de fora", async () => {
    const store = new InMemoryAccountStore();
    const server = new GameServer({ accounts: store, heartbeatIntervalMs: 100, log: false, zones: ZONES_WITH_FAKES });
    const port: number = await server.listen(0);
    const clients: TestClient[] = [];
    try {
      const player = await store.register("Caçador", "cacador@teste.com", "senha-forte-123");
      const guest = await store.register("Convidado_1", "convidado_1@convidado.local", "senha-forte-123");
      assert.ok(player.ok && guest.ok);
      await store.saveStats(player.account.playerId, { ...STARTING_STATS, monsterXp: 40 }, addToPeriods(EMPTY_PERIODS, 40, 0, Date.now()));
      await store.saveStats(guest.account.playerId, { ...STARTING_STATS, monsterXp: 999 }, EMPTY_PERIODS);
      const client: TestClient = await TestClient.connect(port);
      clients.push(client);
      client.send("resume", { version: PROTOCOL_VERSION, sessionToken: player.sessionToken });
      await client.next("auth_ok");
      client.send("ranking_request", { category: "monsters", period: "daily" });
      const ranking = await client.next("ranking");
      assert.deepStrictEqual(ranking.data["rows"], [{ rank: 1, id: player.account.playerId, name: "Caçador", value: 40 }], "sem o convidado");
      assert.deepStrictEqual(ranking.data["me"], { rank: 1, id: player.account.playerId, name: "Caçador", value: 40 });
      assert.ok(typeof ranking.data["resetsIn"] === "number" && ranking.data["resetsIn"] > 0);
      client.send("ranking_request", { category: "guild_pvp", period: "global" });
      const guild = await client.next("ranking");
      assert.deepStrictEqual([guild.data["rows"], guild.data["me"]], [[], null], "sem guilda");
      client.send("ranking_request", { category: "xyz", period: "global" });
      assert.strictEqual((await client.next("error")).data["code"], "bad_message");
    } finally {
      for (const c of clients) c.socket.terminate();
      await server.close();
    }
  });
});

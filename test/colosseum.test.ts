import assert from "assert";

import {
  ARENA_LEVEL,
  ARENA_PROGRESS,
  ARENA_SETS,
  NO_ARENA_POINTS,
  PREP_CHOICES,
  applyPrepPoint,
  arenaInventory,
  arenaItemId,
  fillRemainingPoints,
  roleOf,
  teamSize,
  type ArenaBuild,
  type ArenaPoints,
  type PrepPointResult,
} from "../src/arena/build.js";
import { ACCEPT_WINDOW_MS, ColosseumQueue, DECLINE_BAN_MS, type AcceptResolution, type PendingMatch } from "../src/arena/queue.js";
import {
  MAX_ROUNDS,
  addRoundPoint,
  averageHpPercent,
  eliminationWinner,
  matchOutcome,
  timeoutWinner,
  type TeamRoundState,
} from "../src/arena/rounds.js";
import {
  DAILY_REWARD_LIMIT,
  NO_DAILY_REWARDS,
  applyRating,
  applyRewardToProgress,
  colosseumReward,
  countReward,
  rewardsToday,
  type RewardInput,
} from "../src/arena/rewards.js";
import { EQUIP_SLOTS, getItem } from "../src/items/catalog.js";
import { attributeEffectsOf, basicAttackOf, equippedAbilities, lookLevelsOf } from "../src/items/inventory.js";
import { xpToNextLevel } from "../src/progression/level.js";

const DPS: ArenaBuild = { hand: "Mago", head: "Cavaleiro", chest: "Cavaleiro", feet: "Assassino" };
const HEALER: ArenaBuild = { hand: "Curandeiro", head: "Curandeiro", chest: "Cavaleiro", feet: "Mago" };

/** Pontos já aplicados, falhando o teste se alguma escolha for recusada. */
function points(build: ArenaBuild, choices: ReadonlyArray<readonly [(typeof EQUIP_SLOTS)[number], Parameters<typeof applyPrepPoint>[3]]>): ArenaPoints {
  let current: ArenaPoints = NO_ARENA_POINTS;
  for (const [slot, attribute] of choices) {
    const result: PrepPointResult = applyPrepPoint(current, build, slot, attribute);
    assert.ok(result.ok, `escolha ${slot}/${attribute} recusada`);
    current = result.points;
  }
  return current;
}

describe("Coliseu — build", () => {
  it("todo conjunto escolhível tem as 4 peças no catálogo", () => {
    for (const set of ARENA_SETS) {
      for (const slot of EQUIP_SLOTS) {
        const item = getItem(arenaItemId(set, slot));
        assert.strictEqual(item?.set, set);
        assert.strictEqual(item?.slot, slot);
      }
    }
  });

  it("a mão decide o papel e o tamanho do time vem do modo", () => {
    assert.strictEqual(roleOf(DPS), "dps");
    assert.strictEqual(roleOf(HEALER), "healer");
    assert.deepStrictEqual([teamSize("1x1"), teamSize("2x2"), teamSize("3x3")], [1, 2, 3]);
  });

  it("inventário sintético: item +0 do conjunto em cada slot, mochila vazia, sem brilho", () => {
    const inventory = arenaInventory(DPS);
    assert.strictEqual(inventory.equipped.hand?.itemId, "arcane_staff");
    assert.strictEqual(inventory.equipped.head?.itemId, "knight_helm");
    assert.strictEqual(inventory.equipped.feet?.itemId, "assassin_boots");
    assert.ok(inventory.equipped.hand?.uid.startsWith("arena-"));
    assert.deepStrictEqual(inventory.bag, []);
    assert.deepStrictEqual(lookLevelsOf(inventory), {});
    assert.strictEqual(basicAttackOf(inventory).id, getItem("arcane_staff")?.basicAttack?.id);
    assert.ok(equippedAbilities(inventory).size > 0);
    assert.deepStrictEqual(ARENA_PROGRESS, { level: ARENA_LEVEL, xp: 0, gold: 0 });
  });

  it("escolha: atributo novo +1, repetido +2, e vale no inventário", () => {
    const result = points(DPS, [["head", "defense"], ["head", "defense"], ["hand", "crit"]]);
    assert.strictEqual(result.used, 3);
    assert.deepStrictEqual(result.attrs.head, { defense: 3 });
    assert.deepStrictEqual(result.attrs.hand, { crit: 1 });
    assert.ok(attributeEffectsOf(arenaInventory(DPS, result)).defense > 0);
  });

  it("recusa atributo fora do conjunto da peça e passar de 20 escolhas", () => {
    // Mago não tem defesa; Cavaleiro tem.
    assert.deepStrictEqual(applyPrepPoint(NO_ARENA_POINTS, DPS, "hand", "defense"), { ok: false, reason: "invalid_attribute" });
    const full: ArenaPoints = { ...NO_ARENA_POINTS, used: PREP_CHOICES };
    assert.deepStrictEqual(applyPrepPoint(full, DPS, "head", "defense"), { ok: false, reason: "no_choices_left" });
  });

  it("sobra sorteada completa as 20 escolhas só com atributos válidos", () => {
    let seed: number = 7;
    const random = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const filled: ArenaPoints = fillRemainingPoints(points(DPS, [["head", "health"]]), DPS, random);
    assert.strictEqual(filled.used, PREP_CHOICES);
    let total: number = 0;
    for (const slot of EQUIP_SLOTS) {
      for (const [attribute, value] of Object.entries(filled.attrs[slot])) {
        assert.ok(value !== undefined && value > 0, `${slot}/${attribute}`);
        total += value ?? 0;
      }
    }
    // 20 escolhas: entre 20 (todas novas) e 39 (uma nova por atributo, o resto +2).
    assert.ok(total >= 20 && total <= 39, `total ${total}`);
  });
});

describe("Coliseu — fila", () => {
  const NOW = 1_000_000;

  it("1x1 recusa healer, uma fila por vez e bloqueio da conta", () => {
    const queue = new ColosseumQueue();
    assert.deepStrictEqual(queue.join("h", "1x1", HEALER, NOW, 0), { ok: false, reason: "healer_not_allowed" });
    assert.deepStrictEqual(queue.join("a", "1x1", DPS, NOW, 0), { ok: true });
    assert.deepStrictEqual(queue.join("a", "2x2", DPS, NOW, 0), { ok: false, reason: "already_queued" });
    assert.deepStrictEqual(queue.join("b", "1x1", DPS, NOW, NOW + 1), { ok: false, reason: "queue_banned" });
    assert.deepStrictEqual(queue.status("a"), { kind: "queued", mode: "1x1" });
  });

  it("monta por ordem de chegada com a composição certa e tira da fila na hora", () => {
    const queue = new ColosseumQueue();
    for (const id of ["d1", "d2", "d3", "d4", "d5"]) queue.join(id, "3x3", DPS, NOW, 0);
    queue.join("h1", "3x3", HEALER, NOW, 0);
    assert.deepStrictEqual(queue.tryMatch(NOW, 0), [], "falta um healer");
    queue.join("h2", "3x3", HEALER, NOW, 0);
    const [match] = queue.tryMatch(NOW, 0);
    assert.ok(match !== undefined);
    const ids = (team: PendingMatch["teams"][0]): string[] => team.map((entry) => entry.playerId);
    assert.deepStrictEqual(ids(match.teams[0]), ["d1", "d3", "h1"]);
    assert.deepStrictEqual(ids(match.teams[1]), ["d2", "d4", "h2"]);
    assert.strictEqual(queue.waiting("3x3"), 1, "d5 continua esperando");
    assert.strictEqual(queue.status("d1").kind, "pending");
    assert.strictEqual(match.deadlineMs, NOW + ACCEPT_WINDOW_MS);
  });

  it("todos aceitam → começa (aceitar de novo não muda nada)", () => {
    const queue = new ColosseumQueue();
    queue.join("a", "1x1", DPS, NOW, 0);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    assert.strictEqual(queue.accept("a"), "waiting");
    assert.strictEqual(queue.accept("a"), "waiting");
    const result = queue.accept("b");
    assert.ok(typeof result === "object" && result.kind === "start");
    assert.strictEqual(queue.status("a").kind, "none");
    assert.strictEqual(queue.accept("a"), "not_pending");
  });

  it("recusa devolve os outros à frente da fila; quem recusou sai", () => {
    const queue = new ColosseumQueue();
    queue.join("a", "1x1", DPS, NOW, 0);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    queue.join("c", "1x1", DPS, NOW, 0);
    const result: AcceptResolution | null = queue.decline("b", NOW);
    assert.ok(result?.kind === "cancel");
    assert.deepStrictEqual(result.refused, ["b"]);
    assert.deepStrictEqual(result.returned, ["a"]);
    assert.deepStrictEqual(result.bans, []);
    assert.strictEqual(queue.status("b").kind, "none");
    const [next] = queue.tryMatch(NOW, 0);
    assert.deepStrictEqual(next?.teams.flat().map((entry) => entry.playerId), ["a", "c"], "a volta na frente de c");
  });

  it("deixar o tempo passar conta como recusa; 2 seguidas = bloqueio de 2 min", () => {
    const queue = new ColosseumQueue();
    queue.join("a", "1x1", DPS, NOW, 0);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    queue.accept("a");
    assert.deepStrictEqual(queue.expire(NOW + ACCEPT_WINDOW_MS - 1), []);
    const [first] = queue.expire(NOW + ACCEPT_WINDOW_MS);
    assert.ok(first?.kind === "cancel");
    assert.deepStrictEqual(first.refused, ["b"]);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    const second = queue.leave("b", NOW + 10);
    assert.ok(second?.kind === "cancel");
    assert.deepStrictEqual(second.bans, [{ playerId: "b", untilMs: NOW + 10 + DECLINE_BAN_MS }]);
  });

  it("aceitar zera as recusas seguidas", () => {
    const queue = new ColosseumQueue();
    queue.join("a", "1x1", DPS, NOW, 0);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    queue.decline("b", NOW);
    queue.join("b", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    queue.accept("b");
    const result = queue.decline("a", NOW);
    assert.ok(result?.kind === "cancel");
    queue.tryMatch(NOW, 0);
    queue.join("c", "1x1", DPS, NOW, 0);
    queue.tryMatch(NOW, 0);
    const again = queue.decline("b", NOW);
    assert.ok(again?.kind === "cancel");
    assert.deepStrictEqual(again.bans, [], "a 1ª recusa foi apagada pelo aceite");
  });

  it("sair da fila esperando não conta recusa; limite de partidas segura a fila", () => {
    const queue = new ColosseumQueue({ maxActiveMatches: 1 });
    queue.join("a", "1x1", DPS, NOW, 0);
    assert.strictEqual(queue.leave("a", NOW), null);
    assert.strictEqual(queue.status("a").kind, "none");
    for (const id of ["a", "b", "c", "d"]) queue.join(id, "1x1", DPS, NOW, 0);
    assert.strictEqual(queue.tryMatch(NOW, 0).length, 1, "a 2ª espera vaga");
    assert.strictEqual(queue.tryMatch(NOW, 1).length, 0);
  });
});

describe("Coliseu — rounds", () => {
  const team = (hpFractions: number[], damage: number = 0): TeamRoundState => ({ hpFractions, damage });

  it("eliminação, morte no mesmo tick e round que continua", () => {
    assert.strictEqual(eliminationWinner([team([0.5, 0]), team([0.1])]), undefined);
    assert.strictEqual(eliminationWinner([team([0, 0]), team([0.1])]), 1);
    assert.strictEqual(eliminationWinner([team([0.2]), team([0, 0, 0])]), 0);
    assert.strictEqual(eliminationWinner([team([0]), team([0])]), null);
  });

  it("tempo: média de vida % com 1 casa, depois dano, depois ninguém", () => {
    assert.strictEqual(averageHpPercent(team([1, 0, 0.5])), 50);
    assert.strictEqual(timeoutWinner([team([0.6]), team([0.5])]), 0);
    // 33,33% e 33,34% viram 33,3 os dois: decide o dano.
    assert.strictEqual(timeoutWinner([team([0.3333], 10), team([0.3334], 20)]), 1);
    assert.strictEqual(timeoutWinner([team([0.5], 10), team([0.5], 10)]), null);
  });

  it("primeiro a 3 vence; limite de 9 rounds decide pelos pontos ou empata", () => {
    assert.deepStrictEqual(matchOutcome([3, 1], 4), { over: true, winner: 0 });
    assert.deepStrictEqual(matchOutcome([2, 2], 4), { over: false });
    assert.deepStrictEqual(matchOutcome([2, 1], MAX_ROUNDS), { over: true, winner: 0 });
    assert.deepStrictEqual(matchOutcome([2, 2], MAX_ROUNDS), { over: true, winner: null });
    assert.deepStrictEqual(addRoundPoint([1, 1], 1), [1, 2]);
    assert.deepStrictEqual(addRoundPoint([1, 1], null), [1, 1]);
  });
});

describe("Coliseu — prêmio e ranking", () => {
  const base: RewardInput = { outcome: "win", level: 10, teamSize: 3, teammateAbandoned: false, multipliers: { xp: 1, gold: 1 }, rewardedToday: 0 };

  it("vitória, derrota e empate seguem a tabela", () => {
    const xpNext: number = xpToNextLevel(10);
    assert.deepStrictEqual(colosseumReward(base), { gold: 100, xp: Math.round(xpNext * 0.4 * 10) / 10, points: 10, ratingDelta: 20, rewarded: true });
    const loss = colosseumReward({ ...base, outcome: "loss" });
    assert.deepStrictEqual([loss.gold, loss.points, loss.ratingDelta], [30, 3, -20]);
    assert.strictEqual(loss.xp, Math.round(xpNext * 0.12 * 10) / 10);
    assert.strictEqual(colosseumReward({ ...base, outcome: "draw" }).ratingDelta, 0);
  });

  it("VIP/poção multiplicam só moedas e XP", () => {
    const boosted = colosseumReward({ ...base, multipliers: { xp: 2, gold: 1.2 } });
    const plain = colosseumReward(base);
    assert.strictEqual(boosted.gold, 120);
    assert.strictEqual(boosted.xp, Math.round(xpToNextLevel(10) * 0.4 * 2 * 10) / 10);
    assert.strictEqual(boosted.points, plain.points);
    assert.strictEqual(boosted.ratingDelta, plain.ratingDelta);
  });

  it("abandono: nada e −20 × tamanho do time; colega que perdeu não perde ranking", () => {
    assert.deepStrictEqual(colosseumReward({ ...base, outcome: "abandon" }), { gold: 0, xp: 0, points: 0, ratingDelta: -60, rewarded: false });
    assert.strictEqual(colosseumReward({ ...base, outcome: "abandon", teamSize: 1 }).ratingDelta, -20);
    const mate = colosseumReward({ ...base, outcome: "loss", teammateAbandoned: true });
    assert.deepStrictEqual([mate.gold, mate.ratingDelta], [30, 0]);
  });

  it("teto diário: depois de 10 partidas, só o ranking conta", () => {
    const capped = colosseumReward({ ...base, rewardedToday: DAILY_REWARD_LIMIT });
    assert.deepStrictEqual(capped, { gold: 0, xp: 0, points: 0, ratingDelta: 20, rewarded: false });
    const now: number = Date.UTC(2026, 10, 19, 15);
    const daily = countReward(countReward(NO_DAILY_REWARDS, now), now);
    assert.strictEqual(rewardsToday(daily, now), 2);
    // Meia-noite de Brasília = 03:00 UTC: o contador zera.
    assert.strictEqual(rewardsToday(daily, Date.UTC(2026, 10, 20, 3)), 0);
  });

  it("ranking nunca abaixo de 0 e a XP pode subir de nível", () => {
    assert.strictEqual(applyRating(10, -60), 0);
    assert.strictEqual(applyRating(10, 20), 30);
    const progress = applyRewardToProgress({ level: 0, xp: 90, gold: 5 }, { gold: 100, xp: 20, points: 10, ratingDelta: 20, rewarded: true });
    assert.deepStrictEqual(progress, { level: 1, xp: 10, gold: 105 });
  });
});

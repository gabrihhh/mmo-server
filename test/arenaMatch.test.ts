import assert from "assert";

import { PREP_CHOICES, type ArenaBuild } from "../src/arena/build.js";
import {
  AFK_SECONDS,
  ARENA_RADIUS,
  ArenaMatch,
  RECONNECT_SECONDS,
  type AbandonReason,
  type ArenaMatchHooks,
  type ArenaMatchResult,
  type ArenaParticipant,
} from "../src/arena/match.js";
import { PREP_SECONDS, ROUND_PAUSE_SECONDS, ROUND_SECONDS, type TeamIndex } from "../src/arena/rounds.js";
import { TICK_RATE_HZ, constrainArena } from "../src/sim/movement.js";
import { ARENA_BARRIER_GAP, Zone, type DeathInfo, type ZoneMember } from "../src/zones/Zone.js";

const MAGE: ArenaBuild = { hand: "Mago", head: "Mago", chest: "Cavaleiro", feet: "Cavaleiro" };
const HEALER: ArenaBuild = { hand: "Curandeiro", head: "Curandeiro", chest: "Curandeiro", feet: "Curandeiro" };

/** Guarda os avisos da partida. */
class Hooks implements ArenaMatchHooks {
  states: number = 0;
  readonly abandons: Array<{ id: string; reason: AbandonReason }> = [];
  result: ArenaMatchResult | null = null;
  onState(): void {
    this.states++;
  }
  onAbandon(playerId: string, reason: AbandonReason): void {
    this.abandons.push({ id: playerId, reason });
  }
  onFinish(result: ArenaMatchResult): void {
    this.result = result;
  }
}

const participant = (id: string, team: TeamIndex, build: ArenaBuild = MAGE): ArenaParticipant => ({ id, name: id, body: "male", team, build, send: (): void => {} });

/** Sorteio fixo que anda (a sobra das escolhas não cai sempre no mesmo lugar). */
function seeded(): () => number {
  let seed: number = 11;
  return (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

/** Roda `seconds` segundos da partida; `keepAlive` = ids que "agem" a cada 10 s (não caem por AFK). */
function run(match: ArenaMatch, seconds: number, keepAlive: readonly string[] = []): void {
  const total: number = Math.round(seconds * TICK_RATE_HZ);
  for (let i = 0; i < total; i++) {
    if (i % (10 * TICK_RATE_HZ) === 0) {
      for (const id of keepAlive) {
        const enemy: string | undefined = match.playerIds().find((other) => match.teamOf(other) !== match.teamOf(id));
        if (enemy !== undefined) match.zone.setAttackTarget(id, enemy);
      }
    }
    match.tick();
    if (match.phase === "over") return;
  }
}

/** Partida 1x1 (a × b) já no round 1. */
function inRound(hooks: Hooks = new Hooks()): ArenaMatch {
  const match = new ArenaMatch("t1", "1x1", [participant("a", 0), participant("b", 1)], hooks, { random: seeded() });
  run(match, PREP_SECONDS + 0.1, ["a", "b"]);
  assert.strictEqual(match.phase, "round");
  return match;
}

describe("Coliseu — arena na Zone", () => {
  it("muro redondo e barreira na simulação compartilhada", () => {
    const out = constrainArena({ x: 30, y: 0, z: 40, rotY: 1 }, { radius: 20, side: 0, barrierGap: 0.5 });
    assert.ok(Math.abs(Math.hypot(out.x, out.z) - 20) < 0.002);
    assert.strictEqual(out.rotY, 1);
    assert.strictEqual(constrainArena({ x: 3, y: 0, z: 1, rotY: 0 }, { radius: 20, side: -1, barrierGap: 0.5 }).x, -0.5);
    assert.strictEqual(constrainArena({ x: -3, y: 0, z: 1, rotY: 0 }, { radius: 20, side: 1, barrierGap: 0.5 }).x, 0.5);
    const inside = { x: 1, y: 0, z: 1, rotY: 0 };
    assert.strictEqual(constrainArena(inside, { radius: 20, side: 0, barrierGap: 0.5 }), inside);
  });

  it("na preparação ninguém cruza a barreira nem usa carta", () => {
    const match = new ArenaMatch("t2", "1x1", [participant("a", 0), participant("b", 1)], new Hooks());
    for (let seq = 1; seq <= 200; seq++) {
      match.zone.queueInput("a", { seq, x: 1, z: 0 });
      match.tick();
    }
    const a = match.zone.getSnapshot("a");
    assert.ok(a !== undefined && a.x <= -ARENA_BARRIER_GAP + 1e-9, `x = ${a?.x}`);
    const cast = match.zone.castAbility("a", { abilityId: "ice_lance", targetId: null, x: 1, z: 0, seq: null });
    assert.ok(!cast.ok && cast.reason === "busy", "carta travada na preparação");
  });

  it("aliado/inimigo só pelo time: o mesmo time não é alvo, o outro é", () => {
    const match = new ArenaMatch("t3", "2x2", [participant("a", 0), participant("h", 0, HEALER), participant("b", 1), participant("k", 1, HEALER)], new Hooks());
    assert.strictEqual(match.zone.setAttackTarget("a", "h"), "invalid_target");
    assert.strictEqual(match.zone.setAttackTarget("a", "b"), "ok");
    // Ataque de cura do healer: só no próprio time.
    assert.strictEqual(match.zone.setAttackTarget("h", "a"), "ok");
    assert.strictEqual(match.zone.setAttackTarget("h", "b"), "invalid_target");
  });

  it("morrer na arena não tira nada nem chama a tela de morte, e não renasce sozinho", () => {
    const deaths: DeathInfo[] = [];
    const zone = new Zone({ id: "arena_x", halfSize: 21, maxPlayers: 2, spawnRadius: 0, pvp: true, dummies: [], arena: { radius: 20 } });
    const member = (id: string): ZoneMember => ({ id, name: id, send: (): void => {}, onDeath: (info): void => void deaths.push(info) });
    zone.join(member("a"), { x: -1, y: 0, z: 0, rotY: 0 });
    zone.join(member("b"), { x: 1, y: 0, z: 0, rotY: 0 });
    zone.setArenaTeam("a", 0);
    zone.setArenaTeam("b", 1);
    zone.killInArena("b");
    zone.requestRespawn("b");
    for (let i = 0; i < 30 * TICK_RATE_HZ; i++) zone.tick();
    assert.strictEqual(zone.isAlive("b"), false);
    assert.deepStrictEqual(deaths, []);
  });
});

describe("Coliseu — partida", () => {
  it("preparação: escolhas válidas contam, inválidas são recusadas e a sobra é sorteada", () => {
    const hooks = new Hooks();
    const match = new ArenaMatch("t4", "1x1", [participant("a", 0), participant("b", 1)], hooks, { random: seeded() });
    assert.deepStrictEqual(match.choosePoint("a", "chest", "defense"), { ok: true });
    assert.deepStrictEqual(match.choosePoint("a", "hand", "defense"), { ok: false, reason: "invalid_attribute" });
    assert.strictEqual(match.choicesLeft("a"), PREP_CHOICES - 1);
    // Várias de uma vez: 5 em Vida no peito (Cavaleiro) = +1 e +2 × 4 = 9; pedir mais do que falta usa só o que falta.
    assert.deepStrictEqual(match.choosePoint("a", "chest", "health", 5), { ok: true });
    assert.strictEqual(match.inventoryOf("a")?.equipped.chest?.attrs?.health, 9);
    assert.strictEqual(match.choicesLeft("a"), PREP_CHOICES - 6);
    assert.deepStrictEqual(match.choosePoint("a", "head", "damage", 99), { ok: true });
    assert.strictEqual(match.choicesLeft("a"), 0);
    assert.deepStrictEqual(match.choosePoint("a", "head", "damage"), { ok: false, reason: "no_choices_left" });
    run(match, PREP_SECONDS + 0.1, ["a", "b"]);
    assert.strictEqual(match.phase, "round");
    assert.strictEqual(match.round, 1);
    assert.strictEqual(match.choicesLeft("a"), 0);
    assert.deepStrictEqual(match.choosePoint("a", "chest", "defense"), { ok: false, reason: "not_in_prep" });
    assert.strictEqual(match.choicesLeft("b"), 0, "a sobra do b foi sorteada");
    assert.strictEqual(match.inventoryOf("a")?.equipped.chest?.attrs?.defense !== undefined, true);
  });

  it("eliminação dá o ponto; primeiro a 3 vence; ninguém renasce no meio do round", () => {
    const hooks = new Hooks();
    const match = inRound(hooks);
    for (let round = 1; round <= 3; round++) {
      match.zone.killInArena("b");
      run(match, 1 / TICK_RATE_HZ, ["a"]);
      assert.deepStrictEqual(match.score, [round, 0]);
      if (round < 3) {
        assert.strictEqual(match.phase, "pause");
        assert.strictEqual(match.zone.isAlive("b"), false, "morto não renasce na pausa");
        run(match, ROUND_PAUSE_SECONDS + 0.1, ["a", "b"]);
        assert.strictEqual(match.phase, "round");
        assert.strictEqual(match.zone.isAlive("b"), true, "volta no começo do round");
      }
    }
    assert.strictEqual(match.phase, "over");
    assert.strictEqual(hooks.result?.winner, 0);
    assert.strictEqual(hooks.result?.annulled, false);
    assert.deepStrictEqual(hooks.result?.players.map((p) => [p.id, p.outcome]), [["a", "win"], ["b", "loss"]]);
  });

  it("os dois caindo no mesmo tick: ninguém pontua", () => {
    const match = inRound();
    match.zone.killInArena("a");
    match.zone.killInArena("b");
    run(match, 1 / TICK_RATE_HZ);
    assert.deepStrictEqual(match.score, [0, 0]);
    assert.strictEqual(match.phase, "pause");
  });

  it("fim do tempo com vida e dano iguais: ninguém pontua e vem o round 2", () => {
    const match = inRound();
    run(match, ROUND_SECONDS + 0.1, ["a", "b"]);
    assert.deepStrictEqual(match.score, [0, 0]);
    assert.strictEqual(match.phase, "pause");
    run(match, ROUND_PAUSE_SECONDS + 0.1, ["a", "b"]);
    assert.strictEqual(match.round, 2);
  });

  it("abandono antes do fim do round 1 anula a partida (quem saiu leva a punição)", () => {
    const hooks = new Hooks();
    const match = new ArenaMatch("t5", "1x1", [participant("a", 0), participant("b", 1)], hooks);
    match.abandon("b", "left");
    assert.deepStrictEqual(hooks.abandons, [{ id: "b", reason: "left" }]);
    assert.strictEqual(hooks.result?.annulled, true);
    assert.strictEqual(hooks.result?.players.find((p) => p.id === "b")?.outcome, "abandon");
  });

  it("time inteiro abandona depois do round 1: o outro vence na hora; colega de quem saiu fica marcado", () => {
    const hooks = new Hooks();
    const match = new ArenaMatch("t6", "2x2", [participant("a", 0), participant("h", 0, HEALER), participant("b", 1), participant("k", 1, HEALER)], hooks, { random: seeded() });
    run(match, PREP_SECONDS + 0.1, ["a", "h", "b", "k"]);
    match.zone.killInArena("b");
    match.zone.killInArena("k");
    run(match, 1 / TICK_RATE_HZ);
    assert.strictEqual(match.phase, "pause");
    match.abandon("a", "left");
    assert.strictEqual(hooks.result === null, true, "ainda tem o h no time 0");
    match.abandon("h", "logout");
    assert.strictEqual(hooks.result?.winner, 1);
    assert.strictEqual(hooks.result?.annulled, false);
    const outcomes = Object.fromEntries(hooks.result?.players.map((p) => [p.id, [p.outcome, p.teammateAbandoned]]) ?? []);
    assert.deepStrictEqual(outcomes, { a: ["abandon", true], h: ["abandon", true], b: ["win", false], k: ["win", false] });
  });

  it("AFK por 30 s num round = abandono", () => {
    const hooks = new Hooks();
    const match = inRound(hooks);
    run(match, AFK_SECONDS + 0.5, ["a"]);
    assert.deepStrictEqual(hooks.abandons, [{ id: "b", reason: "afk" }]);
  });

  it("queda: volta em 60 s continua na partida; não voltou = abandono", () => {
    const hooks = new Hooks();
    const match = inRound(hooks);
    match.disconnect("b");
    run(match, 20, ["a", "b"]);
    assert.strictEqual(match.reconnect("b", (): void => {}), true);
    run(match, 1, ["a", "b"]);
    assert.deepStrictEqual(hooks.abandons, []);
    // Voltar depois de muito tempo parado não cai em AFK na hora (o AFK recomeça na volta).
    match.disconnect("b");
    run(match, AFK_SECONDS + 5, ["a"]);
    assert.strictEqual(match.reconnect("b", (): void => {}), true);
    run(match, 1, ["a"]);
    assert.deepStrictEqual(hooks.abandons, [], "voltou e não foi expulso por AFK");
    match.disconnect("b");
    run(match, RECONNECT_SECONDS + 0.5, ["a", "b"]);
    assert.deepStrictEqual(hooks.abandons, [{ id: "b", reason: "timeout" }]);
    assert.strictEqual(match.reconnect("b", (): void => {}), false);
  });

  it("os pontos de nascer ficam dentro da arena, cada time de um lado", () => {
    const match = new ArenaMatch("t7", "3x3", [participant("a", 0), participant("c", 0), participant("h", 0, HEALER), participant("b", 1), participant("d", 1), participant("k", 1, HEALER)], new Hooks());
    for (const id of match.playerIds()) {
      const snapshot = match.zone.getSnapshot(id);
      assert.ok(snapshot !== undefined && Math.hypot(snapshot.x, snapshot.z) < ARENA_RADIUS);
      assert.ok(match.teamOf(id) === 0 ? snapshot.x < 0 : snapshot.x > 0);
    }
  });
});

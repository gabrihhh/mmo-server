import assert from "assert";

import { Zone, type FakePlayerConfig, type ZoneMember } from "../src/zones/Zone.js";
import { TRADE_CONFIRM_DELAY_TICKS, TRADE_COUNTDOWN_TICKS, TRADE_REQUEST_TICKS } from "../src/zones/trades.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { BAG_CAPACITY, type ItemStack } from "../src/items/inventory.js";
import { TRADE_RANGE, TRADE_REQUEST_SECONDS } from "../src/net/protocol.js";
import type { Progress } from "../src/progression/level.js";
import { keepAttacking } from "./helpers.js";

/** Troca entre jogadores ([SOC-05]): pedido, ofertas, confirmação, contagem, aplicação e cancelamentos. */

interface Received {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Membro com mochila e moedas, que guarda as mensagens de troca. */
class Member implements ZoneMember {
  readonly name: string;
  readonly inbox: Received[] = [];
  bagItems: ItemStack[] = [];
  saved: Progress | null = null;
  hides: boolean = false;
  constructor(readonly id: string) {
    this.name = id.toUpperCase();
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || !("data" in decoded)) return;
    if (typeof decoded.type !== "string" || typeof decoded.data !== "object" || decoded.data === null) return;
    if (decoded.type === "snapshot") return;
    this.inbox.push({ type: decoded.type, data: Object.fromEntries(Object.entries(decoded.data)) });
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
  hidesTradeRequests(): boolean {
    return this.hides;
  }
  bag(): readonly ItemStack[] {
    return this.bagItems;
  }
  onTradeBag(bag: readonly ItemStack[]): void {
    this.bagItems = [...bag];
  }
  all(type: string): Received[] {
    return this.inbox.filter((m) => m.type === type);
  }
  lastOf(type: string): Record<string, unknown> | undefined {
    const list: Received[] = this.all(type);
    return list[list.length - 1]?.data;
  }
  notices(): string[] {
    return this.all("trade_notice").map((m) => String(m.data["code"]));
  }
  uids(): string[] {
    return this.bagItems.map((s) => s.uid);
  }
}

const ACCEPT: FakePlayerConfig = {
  id: "fake_accept",
  name: "Fake Aceita",
  x: 2,
  z: 0,
  body: "female",
  level: 3,
  look: { hand: null, head: null, chest: null, feet: null },
  autoReply: "accept",
};
const REJECT: FakePlayerConfig = { ...ACCEPT, id: "fake_reject", name: "Fake Recusa", x: 4, autoReply: "reject" };

/** Ataque de espada só do teste, com os números da antiga espada de treino (saiu do jogo em 2026-11-17). */
const SWORD: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), id: "sword_attack", range: 2.5, cooldown: 1, castTime: 1, damage: 10 };

function zone(): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 20, spawnRadius: 0, pvp: true, moveBuffer: 1, dummies: [], fakePlayers: [ACCEPT, REJECT] });
}

/** Põe um jogador em (x, 0) com `gold` moedas e `items` na mochila (uid = `<id>-<n>`). */
function player(z: Zone, id: string, x: number, gold: number, items: number): Member {
  const member = new Member(id);
  member.bagItems = Array.from({ length: items }, (_, i) => ({ uid: `${id}-${i}`, itemId: "knight_sword" }));
  z.join(member, { x, y: 0, z: 0, rotY: 0 }, SWORD, new Map(), undefined, 0, { level: 0, xp: 0, gold });
  return member;
}

function ticks(z: Zone, count: number): void {
  for (let i = 0; i < count; i++) z.tick();
}

const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? "ok" : (r.reason ?? ""));

/** `a` pede, `b` aceita: troca aberta. */
function openTrade(z: Zone, a: Member, b: Member): void {
  assert.deepStrictEqual(z.requestTrade(a.id, b.id), { ok: true });
  assert.deepStrictEqual(z.answerTrade(b.id, a.id, true), { ok: true });
}

describe("troca ([SOC-05])", () => {
  it("pedido para jogador de verdade: janela com prazo; aceitar abre a troca para os dois", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 0);
    const b = player(z, "b", 1, 0, 0);
    assert.deepStrictEqual(z.requestTrade("a", "b"), { ok: true });
    assert.deepStrictEqual(b.lastOf("trade_requested"), { fromId: "a", fromName: "A", expiresIn: TRADE_REQUEST_SECONDS });
    assert.strictEqual(z.inTrade("a"), false, "só abre quando ele aceita");
    assert.deepStrictEqual(z.answerTrade("b", "a", true), { ok: true });
    assert.ok(z.inTrade("a") && z.inTrade("b"));
    assert.strictEqual(a.lastOf("trade_state")?.["partnerName"], "B");
    assert.strictEqual(b.lastOf("trade_state")?.["partnerName"], "A");
  });

  it("recusar, não responder, ocultar pedidos e fake que recusa: avisos para quem pediu", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 0);
    const b = player(z, "b", 1, 0, 0);
    z.requestTrade("a", "b");
    z.answerTrade("b", "a", false);
    assert.deepStrictEqual(a.notices(), ["rejected"]);
    z.requestTrade("a", "b");
    ticks(z, TRADE_REQUEST_TICKS);
    assert.deepStrictEqual(a.notices(), ["rejected", "expired"]);
    assert.strictEqual(reason(z.answerTrade("b", "a", true)), "trade_request_not_found");
    b.hides = true;
    z.requestTrade("a", "b");
    assert.deepStrictEqual(a.notices(), ["rejected", "expired", "rejected"]);
    assert.strictEqual(b.all("trade_requested").length, 2, "oculto: o pedido não aparece");
    z.requestTrade("a", "fake_reject");
    assert.match(String(a.lastOf("trade_notice")?.["message"]), /Fake Recusa recusou a troca/);
  });

  it("recusa: você mesmo, longe demais, já trocando; o outro trocando → aviso 'busy'", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 0);
    const b = player(z, "b", 1, 0, 0);
    player(z, "far", TRADE_RANGE + 2, 0, 0);
    const c = player(z, "c", -1, 0, 0);
    assert.strictEqual(reason(z.requestTrade("a", "a")), "invalid_trade");
    assert.strictEqual(reason(z.requestTrade("a", "far")), "trade_too_far");
    openTrade(z, a, b);
    assert.strictEqual(reason(z.requestTrade("a", "c")), "trade_busy");
    assert.deepStrictEqual(z.requestTrade("c", "a"), { ok: true });
    assert.deepStrictEqual(c.notices(), ["busy"]);
  });

  it("troca completa: ofertas, espera para confirmar, os dois confirmam, contagem, itens e moedas trocados", () => {
    const z = zone();
    const a = player(z, "a", 0, 100, 2);
    const b = player(z, "b", 1, 50, 1);
    openTrade(z, a, b);
    assert.deepStrictEqual(z.offerTrade("a", ["a-1"], 30), { ok: true });
    assert.deepStrictEqual(z.offerTrade("b", ["b-0"], 0), { ok: true });
    const seen = b.lastOf("trade_state");
    const theirs = seen?.["theirs"] as { items: Array<{ uid: string }>; gold: number } | undefined;
    assert.deepStrictEqual(theirs?.items.map((i) => i.uid), ["a-1"], "o outro vê a oferta ao vivo, com a ficha do item");
    assert.strictEqual(theirs?.gold, 30);
    assert.strictEqual(reason(z.confirmTrade("a")), "trade_not_ready", "acabou de mudar: espera");
    ticks(z, TRADE_CONFIRM_DELAY_TICKS);
    assert.deepStrictEqual(z.confirmTrade("a"), { ok: true });
    assert.strictEqual(b.lastOf("trade_state")?.["theirConfirmed"], true);
    assert.deepStrictEqual(z.confirmTrade("b"), { ok: true });
    assert.strictEqual(a.lastOf("trade_state")?.["countdown"], 5);
    ticks(z, TRADE_COUNTDOWN_TICKS - 1);
    assert.deepStrictEqual(a.uids(), ["a-0", "a-1"], "ainda na contagem");
    ticks(z, 1);
    assert.deepStrictEqual(a.uids(), ["a-0", "b-0"]);
    assert.deepStrictEqual(b.uids(), ["a-1"]);
    assert.strictEqual(a.saved?.gold, 70);
    assert.strictEqual(b.saved?.gold, 80);
    assert.ok(a.all("trade_done").length === 1 && b.all("trade_done").length === 1);
    assert.strictEqual(z.inTrade("a"), false);
  });

  it("qualquer mudança zera as confirmações dos dois e para a contagem", () => {
    const z = zone();
    const a = player(z, "a", 0, 100, 2);
    const b = player(z, "b", 1, 0, 0);
    openTrade(z, a, b);
    z.offerTrade("a", ["a-0"], 0);
    ticks(z, TRADE_CONFIRM_DELAY_TICKS);
    z.confirmTrade("a");
    z.confirmTrade("b");
    ticks(z, 10);
    z.offerTrade("a", ["a-0", "a-1"], 0);
    const state = b.lastOf("trade_state");
    assert.strictEqual(state?.["myConfirmed"], false);
    assert.strictEqual(state?.["theirConfirmed"], false);
    assert.strictEqual(state?.["countdown"], null);
    ticks(z, TRADE_COUNTDOWN_TICKS);
    assert.deepStrictEqual(b.uids(), [], "não trocou");
  });

  it("oferta inválida: item que não está na mochila, moedas a mais", () => {
    const z = zone();
    const a = player(z, "a", 0, 10, 1);
    const b = player(z, "b", 1, 0, 0);
    openTrade(z, a, b);
    assert.strictEqual(reason(z.offerTrade("a", ["b-0"], 0)), "invalid_trade");
    assert.strictEqual(reason(z.offerTrade("a", [], 11)), "invalid_trade");
    assert.strictEqual(reason(z.offerTrade("c", [], 0)), "not_in_trade");
  });

  it("mochila de quem recebe sem espaço: aviso no estado e não deixa confirmar", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 1);
    const b = player(z, "b", 1, 0, BAG_CAPACITY);
    openTrade(z, a, b);
    z.offerTrade("a", ["a-0"], 0);
    assert.match(String(a.lastOf("trade_state")?.["problem"]), /mochila de B não tem espaço/);
    ticks(z, TRADE_CONFIRM_DELAY_TICKS);
    assert.strictEqual(reason(z.confirmTrade("a")), "trade_not_ready");
    // B entrega um item em troca: agora cabe.
    z.offerTrade("b", ["b-0"], 0);
    assert.strictEqual(a.lastOf("trade_state")?.["problem"], null);
  });

  it("item oferecido que sai da mochila (vestiu, fundiu) sai da oferta e zera as confirmações", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 2);
    const b = player(z, "b", 1, 0, 0);
    openTrade(z, a, b);
    z.offerTrade("a", ["a-0", "a-1"], 0);
    ticks(z, TRADE_CONFIRM_DELAY_TICKS);
    z.confirmTrade("b");
    a.bagItems = a.bagItems.filter((s) => s.uid !== "a-0");
    z.tradeBelongingsChanged("a");
    const state = b.lastOf("trade_state");
    assert.deepStrictEqual((state?.["theirs"] as { items: Array<{ uid: string }> }).items.map((i) => i.uid), ["a-1"]);
    assert.strictEqual(state?.["myConfirmed"], false);
  });

  it("cancela sozinha: fechar a janela, afastar-se, levar dano, sair da zona", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 0);
    const b = player(z, "b", 1, 0, 0);
    openTrade(z, a, b);
    z.cancelTrade("a");
    assert.deepStrictEqual(b.notices(), ["cancelled"]);
    assert.match(String(b.lastOf("trade_notice")?.["message"]), /A cancelou a troca/);

    openTrade(z, a, b);
    for (let i = 0; i < 6 * 30 && z.inTrade("a"); i++) {
      z.queueInput("b", { seq: i + 1, x: 1, z: 0 });
      z.tick();
    }
    assert.strictEqual(b.notices().pop(), "too_far");

    const c = player(z, "c", 0, 0, 0);
    const d = player(z, "d", 0.8, 0, 0);
    openTrade(z, c, d);
    keepAttacking(z, "d", "c");
    ticks(z, 60);
    assert.strictEqual(c.notices().pop(), "damaged");

    const e = player(z, "e", -1, 0, 0);
    openTrade(z, c, e);
    z.leave("c");
    assert.strictEqual(e.notices().pop(), "left");
    assert.strictEqual(z.inTrade("e"), false);
  });

  it("Fake Aceita aceita na hora e confirma sozinho; o item vai para a mochila de mentira dele", () => {
    const z = zone();
    const a = player(z, "a", 0, 0, 1);
    assert.deepStrictEqual(z.requestTrade("a", "fake_accept"), { ok: true });
    assert.ok(z.inTrade("a"));
    z.offerTrade("a", ["a-0"], 0);
    ticks(z, TRADE_CONFIRM_DELAY_TICKS);
    assert.strictEqual(a.lastOf("trade_state")?.["theirConfirmed"], true);
    z.confirmTrade("a");
    ticks(z, TRADE_COUNTDOWN_TICKS);
    assert.deepStrictEqual(a.uids(), []);
    assert.ok(a.all("trade_done").length === 1);
  });
});

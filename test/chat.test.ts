import assert from "assert";

import { ChatLimiter, cleanChatText, GLOBAL_COOLDOWN_MS, SPAM_MUTE_MS } from "../src/social/chat.js";

describe("chat ([SOC-09])", () => {
  it("limpa o texto: quebras viram espaço, vazio e longo recusados", () => {
    assert.strictEqual(cleanChatText("  oi\n\ttudo   bem  "), "oi tudo bem");
    assert.strictEqual(cleanChatText("   \n "), null);
    assert.strictEqual(cleanChatText("a".repeat(200)), "a".repeat(200));
    assert.strictEqual(cleanChatText("a".repeat(201)), null);
  });

  it("anti-spam: 5 em 10 s passa, a 6ª deixa 30 s sem falar", () => {
    const limiter = new ChatLimiter();
    for (let i = 0; i < 5; i++) assert.ok(limiter.check("p", "zone", `msg ${i}`, i * 100).ok);
    const sixth = limiter.check("p", "group", "outra", 600);
    assert.ok(!sixth.ok && sixth.reason === "spam" && sixth.seconds === 30);
    assert.ok(!limiter.check("p", "zone", "ainda mudo", 600 + SPAM_MUTE_MS - 1000).ok);
    assert.ok(limiter.check("p", "zone", "voltou", 600 + SPAM_MUTE_MS).ok);
  });

  it("a mesma mensagem 3 vezes seguidas em 30 s é recusada", () => {
    const limiter = new ChatLimiter();
    assert.ok(limiter.check("p", "zone", "Oi", 0).ok);
    assert.ok(limiter.check("p", "zone", "oi", 3000).ok);
    const third = limiter.check("p", "zone", "OI", 6000);
    assert.ok(!third.ok && third.reason === "repeat");
    assert.ok(limiter.check("p", "zone", "outra coisa", 7000).ok);
  });

  it("Global: 1 a cada 10 min, sem contar no anti-spam dos outros canais; não zera ao sair", () => {
    const limiter = new ChatLimiter();
    assert.ok(limiter.check("p", "global", "vendo espada", 0).ok);
    const again = limiter.check("p", "global", "compro escudo", 60_000);
    assert.ok(!again.ok && again.reason === "cooldown" && again.seconds === 540);
    assert.ok(limiter.check("p", "zone", "oi", 61_000).ok);
    limiter.forgetSpam("p");
    assert.ok(!limiter.check("p", "global", "relogou", 120_000).ok);
    assert.ok(limiter.check("p", "global", "agora sim", GLOBAL_COOLDOWN_MS).ok);
  });
});

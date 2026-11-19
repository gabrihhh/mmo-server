import assert from "assert";

import {
  EMPTY_PREMIUM,
  PREMIUM_HISTORY_LIMIT,
  VIP_DURATION_MS,
  XP_BOOST_DURATION_MS,
  bonusMarketSlots,
  bonusStorageTabs,
  buyProduct,
  creditPack,
  readPremium,
  rewardMultipliers,
  useDeathProtection,
  useUpgradeStone,
  type PremiumState,
} from "../src/premium/premium.js";
import { putInStorage, storageCapacity, STORAGE_TAB_SIZE } from "../src/items/storage.js";
import type { Inventory } from "../src/items/inventory.js";

/** Regras puras da Loja premium ([JOGO-27]). */

const NOW = 1_000_000_000_000;

/** Estado com [diamonds] Diamantes. */
const rich = (diamonds: number): PremiumState => ({ ...EMPTY_PREMIUM, diamonds });

describe("Loja premium (regras)", () => {
  it("pacote: a 1ª compra de cada pacote vem em dobro, a 2ª não; histórico marca o teste", () => {
    const first = creditPack(EMPTY_PREMIUM, "diamonds_100", NOW, true);
    assert.ok(first.ok);
    assert.strictEqual(first.diamonds, 200);
    const second = creditPack(first.state, "diamonds_100", NOW + 1, true);
    assert.ok(second.ok);
    assert.strictEqual(second.diamonds, 100);
    assert.strictEqual(second.state.diamonds, 300);
    assert.deepStrictEqual(second.state.history.map((e) => [e.kind, e.diamonds, e.test]), [["pack", 100, true], ["pack", 200, true]]);
    assert.deepStrictEqual(creditPack(EMPTY_PREMIUM, "nao_existe", NOW, true), { ok: false, reason: "pack_not_found" });
  });

  it("produto: cobra, recusa sem saldo/inexistente e o +5 vagas só uma vez", () => {
    assert.deepStrictEqual(buyProduct(rich(299), "vip_30d", NOW), { ok: false, reason: "not_enough_diamonds" });
    assert.deepStrictEqual(buyProduct(rich(999), "nada", NOW), { ok: false, reason: "product_not_found" });
    const slots = buyProduct(rich(500), "market_slots", NOW);
    assert.ok(slots.ok);
    assert.strictEqual(slots.state.diamonds, 300);
    assert.strictEqual(slots.state.marketSlots, 5);
    assert.deepStrictEqual(buyProduct(slots.state, "market_slots", NOW), { ok: false, reason: "already_owned" });
    assert.strictEqual(slots.state.history[0]?.diamonds, -200);
  });

  it("VIP e poção somam tempo ao que falta e multiplicam a recompensa", () => {
    const vip = buyProduct(rich(1000), "vip_30d", NOW);
    assert.ok(vip.ok);
    assert.strictEqual(vip.state.vipUntil, NOW + VIP_DURATION_MS);
    const again = buyProduct(vip.state, "vip_30d", NOW + 1000);
    assert.ok(again.ok);
    assert.strictEqual(again.state.vipUntil, NOW + 2 * VIP_DURATION_MS, "soma ao fim atual, não ao agora");
    const boost = buyProduct(again.state, "xp_boost_1h", NOW);
    assert.ok(boost.ok);
    assert.strictEqual(boost.state.xpBoostUntil, NOW + XP_BOOST_DURATION_MS);
    assert.deepStrictEqual(rewardMultipliers(boost.state, NOW), { xp: 2.2, gold: 1.2 });
    assert.deepStrictEqual(rewardMultipliers(boost.state, NOW + XP_BOOST_DURATION_MS), { xp: 1.2, gold: 1.2 }, "a poção acabou");
    assert.deepStrictEqual(rewardMultipliers(EMPTY_PREMIUM, NOW), { xp: 1, gold: 1 });
    assert.strictEqual(bonusStorageTabs(vip.state, NOW), 1);
    assert.strictEqual(bonusStorageTabs(vip.state, NOW + VIP_DURATION_MS), 0, "VIP vencido");
    assert.strictEqual(bonusMarketSlots(vip.state, NOW), 5);
  });

  it("pedra e proteção: guardam e gastam uma de cada vez; aba avisa quem guarda o inventário", () => {
    const stone = buyProduct(rich(100), "upgrade_stone", NOW);
    assert.ok(stone.ok);
    assert.strictEqual(stone.state.upgradeStones, 1);
    const spent = useUpgradeStone(stone.state);
    assert.strictEqual(spent?.upgradeStones, 0);
    assert.strictEqual(spent === null ? null : useUpgradeStone(spent), null);
    const shield = buyProduct(rich(100), "death_protection", NOW);
    assert.ok(shield.ok);
    assert.strictEqual(useDeathProtection(shield.state)?.deathProtections, 0);
    const tab = buyProduct(rich(150), "storage_tab", NOW);
    assert.ok(tab.ok && tab.storageTab);
  });

  it("aba do VIP no Armazém: cabe mais enquanto ativo; vencido, o que passou fica guardado", () => {
    const full: Inventory = {
      equipped: { hand: null, head: null, chest: null, feet: null },
      bag: [{ uid: "novo", itemId: "knight_sword" }],
      grants: [],
      storage: Array.from({ length: STORAGE_TAB_SIZE }, (_, i) => ({ uid: `s${i}`, itemId: "knight_sword" })),
    };
    assert.strictEqual(storageCapacity(full, 1), 2 * STORAGE_TAB_SIZE);
    assert.deepStrictEqual(putInStorage(full, "novo"), { ok: false, reason: "storage_full" });
    assert.ok(putInStorage(full, "novo", 1).ok);
  });

  it("lê conta antiga/estragada como vazia e corta o histórico", () => {
    assert.deepStrictEqual(readPremium(undefined), EMPTY_PREMIUM);
    assert.deepStrictEqual(readPremium({ diamonds: -5, vipUntil: "x", marketSlots: 99 }), { ...EMPTY_PREMIUM, marketSlots: 5 });
    const history = Array.from({ length: PREMIUM_HISTORY_LIMIT + 10 }, (_, i) => ({ at: i, kind: "pack", id: "diamonds_100", diamonds: 100 }));
    assert.strictEqual(readPremium({ history: [...history, { lixo: true }] }).history.length, PREMIUM_HISTORY_LIMIT);
  });
});

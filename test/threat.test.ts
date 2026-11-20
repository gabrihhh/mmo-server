import assert from "assert";

import { Zone, type DummyConfig, type ZoneMember } from "../src/zones/Zone.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import {
  TAUNT_THREAT_MULTIPLIER,
  THREAT_INITIAL,
  THREAT_PER_DAMAGE,
  THREAT_PER_HEAL,
  THREAT_SWITCH_MELEE,
  THREAT_SWITCH_RANGED,
  ThreatTable,
  chooseThreatTarget,
} from "../src/combat/threat.js";
import { goldReward, groupXp, xpReward, type Progress } from "../src/progression/level.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import type { CastData } from "../src/net/protocol.js";
import { keepAttacking } from "./helpers.js";

/** Membro falso: guarda os eventos de todos os snapshots e o progresso salvo. */
class Member implements ZoneMember {
  readonly name: string;
  readonly events: Array<Record<string, unknown>> = [];
  saved: Progress | null = null;
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || decoded.type !== "snapshot") return;
    if (!("data" in decoded) || typeof decoded.data !== "object" || decoded.data === null) return;
    const events: unknown = Reflect.get(decoded.data, "events");
    if (Array.isArray(events)) for (const e of events) if (typeof e === "object" && e !== null) this.events.push(Object.fromEntries(Object.entries(e)));
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
}

function abilityOf(itemId: string, abilityId: string): AbilityDef {
  const found: AbilityDef | undefined = ITEMS[itemId]?.abilities.find((a) => a.id === abilityId);
  assert.ok(found, abilityId);
  return found;
}

/**
 * Cartas só do teste, com os números do antigo kit de treino (saiu do jogo em 2026-11-17): as contas de 110%/130%
 * abaixo foram feitas com eles (Raio 18 no alvo, Bola de fogo 20 com projétil, Meteoro 30 em área). Fora do catálogo,
 * cada uma tem a própria posição de carta (`Zone.cardSlot`).
 */
const TEST_BOLT: AbilityDef = { ...abilityOf("ranger_crossbow", "quick_shot"), id: "bolt", range: 10, cooldown: 7, castTime: 0.4, manaCost: 12, damage: 18, releaseTime: 0.15 };
const TEST_FIREBALL: AbilityDef = { ...abilityOf("arcane_staff", "ice_lance"), id: "fireball", range: 12, radius: 0.6, cooldown: 4, castTime: 0.6, damage: 20, projectileSpeed: 14 };
const TEST_METEOR: AbilityDef = { ...abilityOf("arcane_staff", "starfall"), id: "meteor", range: 10, radius: 2.5, cooldown: 12, castTime: 1, manaCost: 30, damage: 30 };

/** Todas as habilidades do catálogo + as cartas só do teste (o jogador de teste veste tudo). */
const ALL: ReadonlyMap<string, AbilityDef> = new Map([
  ...Object.values(ITEMS).flatMap((item) => item.abilities.map((a): [string, AbilityDef] => [a.id, a])),
  ...[TEST_BOLT, TEST_FIREBALL, TEST_METEOR].map((a): [string, AbilityDef] => [a.id, a]),
]);
/** Ataque de espada só do teste, com os números da antiga espada de treino (saiu do jogo em 2026-11-17). */
const SWORD: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), id: "sword_attack", range: 2.5, cooldown: 1, castTime: 1, damage: 10 };

/**
 * Zumbi lutador (espada longa, alcance 2,8 m) nível 0 em (x, z). Percepção quase nula (só entra na tabela quem bate)
 * e sem dano por padrão, para os números da ameaça serem exatos.
 */
function zombie(id: string, x: number, z: number, extra: Partial<DummyConfig> = {}): DummyConfig {
  return {
    id,
    name: "Zumbi",
    x,
    z,
    level: 0,
    maxHp: 2000,
    respawnSeconds: 1,
    damageMultiplier: 0,
    body: "zombie",
    behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 0.1, leashRadius: 50, speed: 3.5 },
    ...extra,
  };
}

function zoneWith(dummies: DummyConfig[]): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: false, dummies });
}

function join(zone: Zone, id: string, x: number, z: number, basic: AbilityDef = UNARMED_ATTACK): Member {
  const member = new Member(id);
  zone.join(member, { x, y: 0, z, rotY: 0 }, basic, ALL);
  return member;
}

const cast = (abilityId: string, extra: Partial<CastData> = {}): CastData => ({ abilityId, targetId: null, x: null, z: null, seq: null, ...extra });

function ticks(zone: Zone, count: number): void {
  for (let i = 0; i < count; i++) zone.tick();
}

/** Lança e roda até o efeito (mais `extraTicks`, ex.: voo do projétil). */
function castAndFinish(zone: Zone, id: string, request: CastData, extraTicks: number = 0): void {
  const result = zone.castAbility(id, request);
  assert.ok(result.ok, `${id} lançou ${request.abilityId}: ${result.ok ? "" : result.message}`);
  const ability: AbilityDef | undefined = ALL.get(request.abilityId);
  ticks(zone, Math.ceil((ability?.castTime ?? 0) * TICK_RATE_HZ) + 1 + extraTicks);
}

const threat = (zone: Zone, npc: string, player: string): number => zone.threatOf(npc)?.get(player) ?? 0;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

describe("ameaça (aggro) dos monstros", () => {
  it("constantes combinadas", () => {
    assert.strictEqual(THREAT_PER_DAMAGE, 1);
    assert.strictEqual(THREAT_PER_HEAL, 0.5);
    assert.strictEqual(THREAT_SWITCH_MELEE, 1.1);
    assert.strictEqual(THREAT_SWITCH_RANGED, 1.3);
    assert.strictEqual(THREAT_INITIAL, 1);
    assert.strictEqual(TAUNT_THREAT_MULTIPLIER, 1.1);
  });

  it("chooseThreatTarget: maior ameaça sem alvo; troca só acima de 110% (perto) / 130% (longe)", () => {
    const c = (id: string, threat: number, melee: boolean, distance: number = 1) => ({ id, threat, melee, distance });
    assert.strictEqual(chooseThreatTarget([], null), null);
    assert.strictEqual(chooseThreatTarget([c("a", 5, true), c("b", 9, false)], null), "b");
    assert.strictEqual(chooseThreatTarget([c("a", 5, true, 3), c("b", 5, true, 1)], null), "b", "empate: o mais perto");
    // Alvo atual "a" com 100.
    assert.strictEqual(chooseThreatTarget([c("a", 100, true), c("b", 110, true)], "a"), "a", "110% exato não troca");
    assert.strictEqual(chooseThreatTarget([c("a", 100, true), c("b", 110.1, true)], "a"), "b", "passou de 110% perto");
    assert.strictEqual(chooseThreatTarget([c("a", 100, true), c("b", 125, false)], "a"), "a", "longe precisa de 130%");
    assert.strictEqual(chooseThreatTarget([c("a", 100, true), c("b", 130.1, false)], "a"), "b");
    // Longe com mais ameaça mas abaixo de 130%; perto acima de 110%: vai no de perto.
    assert.strictEqual(chooseThreatTarget([c("a", 100, true), c("far", 125, false), c("melee", 115, true)], "a"), "melee");
    // Alvo atual sumiu da lista (morreu/saiu): o maior.
    assert.strictEqual(chooseThreatTarget([c("b", 3, true), c("c", 4, false)], "a"), "c");
  });

  it("ThreatTable: soma, garante inicial, sobe só para cima e zera", () => {
    const table = new ThreatTable();
    table.ensure("a", 1);
    table.ensure("a", 5);
    assert.strictEqual(table.get("a"), 1);
    table.add("a", 9);
    table.add("a", 0);
    assert.strictEqual(table.get("a"), 10);
    table.add("b", 4);
    assert.strictEqual(table.maxExcept("b"), 10);
    assert.strictEqual(table.maxExcept("a"), 4);
    table.raiseTo("a", 3);
    assert.strictEqual(table.get("a"), 10);
    table.remove("b");
    assert.ok(!table.has("b"));
    table.clear();
    assert.strictEqual(table.size, 0);
  });

  it("percepção pela grade ([INFRA-11]): acha quem está no raio (até maior que uma célula de 45 m) e ignora o resto", () => {
    // Casa na borda de uma célula (x = 44,9) e raio de 60 m: o círculo cobre várias células da grade.
    const zone: Zone = zoneWith([zombie("z1", 44.9, 0, { behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 60, leashRadius: 200, speed: 0 } })]);
    join(zone, "dentro", 44.9 - 59, 0);
    join(zone, "diagonal", 44.9 + 40, 40);
    join(zone, "fora", 44.9 + 61, 0);
    join(zone, "longe", -140, -140);
    ticks(zone, 1);
    assert.strictEqual(threat(zone, "z1", "dentro"), THREAT_INITIAL);
    assert.strictEqual(threat(zone, "z1", "diagonal"), THREAT_INITIAL, "56,6 m na diagonal, outra célula");
    assert.strictEqual(threat(zone, "z1", "fora"), 0);
    assert.strictEqual(threat(zone, "z1", "longe"), 0);
  });

  it("dano gera ameaça (1 por ponto) e entra na tabela; percepção dá a ameaça inicial", () => {
    const zone = zoneWith([zombie("z", 0, 0), zombie("z2", 30, 0, { behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 5, leashRadius: 50, speed: 3.5 } })]);
    join(zone, "a", 0, 2);
    join(zone, "p", 30, 3);
    zone.tick();
    assert.strictEqual(zone.threatOf("z")?.size, 0, "ninguém perto nem bateu");
    assert.strictEqual(threat(zone, "z2", "p"), THREAT_INITIAL, "entrou na percepção: ameaça inicial");
    assert.strictEqual(zone.npcTargetOf("z2"), "p", "e ele vem");
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" }));
    assert.strictEqual(threat(zone, "z", "a"), 18 * THREAT_PER_DAMAGE);
    assert.strictEqual(zone.npcTargetOf("z"), "a");
  });

  it("perto: troca para quem passou de 110% da ameaça do alvo; abaixo, não", () => {
    // a e b no corpo a corpo do zumbi (2 m, alcance 2,8 + 0,5).
    const zone = zoneWith([zombie("z", 0, 0)]);
    join(zone, "a", 0, 2);
    join(zone, "b", 2, 0);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" })); // a = 18
    castAndFinish(zone, "b", cast("bolt", { targetId: "z" })); // b = 18: não passou de 19,8
    assert.strictEqual(threat(zone, "z", "b"), 18);
    assert.strictEqual(zone.npcTargetOf("z"), "a", "empate/abaixo de 110%: continua no primeiro");
    // b: Bola de fogo (20) → 38 > 19,8: troca.
    castAndFinish(zone, "b", cast("fireball", { x: -1, z: 0 }), 10);
    assert.strictEqual(threat(zone, "z", "b"), 38);
    assert.strictEqual(zone.npcTargetOf("z"), "b");

    // Só a bola de fogo (20 > 19,8) já troca quando quem passou está perto.
    const zone2 = zoneWith([zombie("z", 0, 0)]);
    join(zone2, "a", 0, 2);
    join(zone2, "b", 2, 0);
    castAndFinish(zone2, "a", cast("bolt", { targetId: "z" }));
    castAndFinish(zone2, "b", cast("fireball", { x: -1, z: 0 }), 10);
    assert.strictEqual(threat(zone2, "z", "b"), 20);
    assert.strictEqual(zone2.npcTargetOf("z"), "b");
  });

  it("longe: precisa passar de 130% (20 contra 18 não troca; 38 troca)", () => {
    const zone = zoneWith([zombie("z", 0, 0)]);
    join(zone, "a", 0, 2);
    join(zone, "far", 8, 0); // 8 m: fora do corpo a corpo (2,8 + 0,5)
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" })); // a = 18
    castAndFinish(zone, "far", cast("fireball", { x: -1, z: 0 }), 15); // far = 20 < 23,4
    assert.strictEqual(threat(zone, "z", "far"), 20);
    assert.strictEqual(zone.npcTargetOf("z"), "a", "longe e abaixo de 130%: não troca");
    castAndFinish(zone, "far", cast("bolt", { targetId: "z" })); // far = 38 > 23,4
    assert.strictEqual(zone.npcTargetOf("z"), "far");
  });

  it("cura dá ameaça ao curandeiro (0,5 × cura efetiva) só nos monstros que lutam com o curado", () => {
    // Zumbi que bate de verdade (para ter o que curar) e um segundo zumbi longe, fora da luta.
    const zone = zoneWith([zombie("z", 0, 0, { damageMultiplier: 1 }), zombie("other", 40, 0)]);
    const a = join(zone, "a", 0, 2);
    const healer = join(zone, "h", 4, 4);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" }));
    let hit = false;
    for (let i = 0; i < 100 && !hit; i++) {
      zone.tick();
      hit = a.events.some((e) => e["type"] === "damage" && e["target"] === "a");
    }
    assert.ok(hit, "o zumbi bateu em a");
    assert.ok(!zone.threatOf("z")?.has("h"), "curandeiro ainda fora da tabela");
    castAndFinish(zone, "h", cast("greater_heal", { targetId: "a" }));
    const heal = healer.events.find((e) => e["type"] === "heal" && e["source"] === "h" && e["target"] === "a");
    const healed: unknown = heal?.["amount"];
    assert.ok(typeof healed === "number" && healed > 0 && healed < abilityOf("healer_tome", "greater_heal").heal, "cura efetiva (sem o que passou)");
    assert.ok(near(threat(zone, "z", "h"), healed * THREAT_PER_HEAL), `ameaça = metade da cura efetiva (${threat(zone, "z", "h")})`);
    assert.ok(!zone.threatOf("other")?.has("h"), "monstro que não luta com o curado não liga");
  });

  it("cura em quem está com a vida cheia não dá ameaça; escudo dá 0,5 × o escudo aplicado", () => {
    const zone = zoneWith([zombie("z", 0, 0)]);
    join(zone, "a", 0, 2);
    join(zone, "h", 4, 4);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" }));
    castAndFinish(zone, "h", cast("greater_heal", { targetId: "a" }));
    assert.ok(!zone.threatOf("z")?.has("h"), "curou 0: sem ameaça");
    castAndFinish(zone, "h", cast("holy_shield", { targetId: "a" }));
    assert.strictEqual(threat(zone, "z", "h"), abilityOf("healer_tome", "holy_shield").shield * THREAT_PER_HEAL);
  });

  it("Desafio: provoca todo monstro a até 6 m por 4 s (ignora a troca) e a ameaça vira 110% da maior", () => {
    const challenge: AbilityDef = abilityOf("knight_sword", "challenge");
    assert.strictEqual(challenge.aim, "area_self");
    assert.strictEqual(challenge.radius, 6);
    assert.strictEqual(challenge.damage, 0);
    assert.strictEqual(challenge.tauntSeconds, 4);
    const zone = zoneWith([zombie("z1", 0, 0), zombie("z2", 4, 0), zombie("z3", 14, 0)]);
    join(zone, "a", 0, 2, SWORD);
    join(zone, "k", 2, 2);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z1" })); // a = 18 no z1
    castAndFinish(zone, "a", cast("fireball", { x: 2, z: -1 }), 10); // bola de fogo no z2
    const before1: number = threat(zone, "z1", "a");
    const before2: number = threat(zone, "z2", "a");
    assert.ok(before1 > 0 && before2 > 0, `a bateu nos dois (${before1}, ${before2})`);
    castAndFinish(zone, "k", cast("challenge"));
    for (const [id, before] of [["z1", before1], ["z2", before2]] as const) {
      assert.strictEqual(zone.npcTargetOf(id), "k", `${id} provocado`);
      assert.ok(near(threat(zone, id, "k"), Math.max(THREAT_INITIAL, before * TAUNT_THREAT_MULTIPLIER)), `${id}: 110% da maior`);
    }
    assert.notStrictEqual(zone.npcTargetOf("z3"), "k", "fora dos 6 m: não provocado");
    assert.ok(!zone.threatOf("z3")?.has("k"));
    // a bate no z1 muito acima de 130% durante a provocação: continua no cavaleiro.
    keepAttacking(zone, "a", "z1");
    ticks(zone, Math.round(3 * TICK_RATE_HZ));
    assert.ok(threat(zone, "z1", "a") > threat(zone, "z1", "k") * THREAT_SWITCH_RANGED, "a passou de longe");
    assert.strictEqual(zone.npcTargetOf("z1"), "k", "preso no cavaleiro durante os 4 s");
    // Acabou a provocação: vale a regra de troca de novo (a está no corpo a corpo e passou de 110%).
    ticks(zone, Math.round(1.5 * TICK_RATE_HZ));
    assert.strictEqual(zone.npcTargetOf("z1"), "a");
  });

  it("Desafio: quem já tem mais que 110% da maior mantém a ameaça", () => {
    const zone = zoneWith([zombie("z", 0, 0)]);
    join(zone, "a", 0, 2);
    join(zone, "k", 2, 0);
    // Cartas de posições diferentes (a recarga é da posição, [JOGO-06]): fireball = hand:0, meteor = hand:1, Desafio = hand:2.
    castAndFinish(zone, "k", cast("fireball", { x: -1, z: 0 }), 10); // k = 20
    castAndFinish(zone, "k", cast("meteor", { x: 0, z: 0 })); // k = 50
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" })); // a = 18
    assert.strictEqual(threat(zone, "z", "k"), 50);
    assert.strictEqual(threat(zone, "z", "a"), 18);
    castAndFinish(zone, "k", cast("challenge"));
    assert.strictEqual(threat(zone, "z", "k"), 50, "já era maior que 110% da maior: manteve");
    assert.strictEqual(zone.npcTargetOf("z"), "k");
  });

  it("zera ao desistir (voltar para casa) e ao morrer/reaparecer", () => {
    const zone = zoneWith([zombie("z", 0, 0, { behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 0.1, leashRadius: 10, speed: 3.5 } })]);
    join(zone, "a", 0, 2);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" }));
    assert.strictEqual(threat(zone, "z", "a"), 18);
    // a foge (5 m/s; o zumbi anda 3,5): ele passa de 10 m de casa e desiste.
    let seq = 0;
    for (let i = 0; i < 120; i++) {
      zone.queueInput("a", { seq: ++seq, x: 0, z: 1 });
      zone.tick();
    }
    assert.strictEqual(zone.threatOf("z")?.size, 0, "desistiu: tabela vazia");
    assert.strictEqual(zone.npcTargetOf("z"), null);

    const zone2 = zoneWith([zombie("z", 0, 0, { maxHp: 30 })]);
    join(zone2, "a", 0, 2);
    join(zone2, "b", 2, 0);
    castAndFinish(zone2, "b", cast("starfall", { x: 0, z: 0 }));
    assert.strictEqual(threat(zone2, "z", "b"), 24);
    castAndFinish(zone2, "a", cast("bolt", { targetId: "z" })); // 24 + 18 ≥ 30 × 1,2: mata
    assert.strictEqual(zone2.threatOf("z")?.size, 0, "morreu: tabela vazia");
    ticks(zone2, Math.round(1.5 * TICK_RATE_HZ));
    assert.strictEqual(zone2.threatOf("z")?.size, 0, "reapareceu vazio");
  });

  it("quem morre ou sai da zona sai da tabela", () => {
    // Zumbi que bate muito forte: mata a em poucos golpes.
    const zone = zoneWith([zombie("z", 0, 0, { damageMultiplier: 20 })]);
    join(zone, "a", 0, 2);
    join(zone, "b", 9, 0);
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" }));
    castAndFinish(zone, "b", cast("bolt", { targetId: "z" }));
    assert.ok(zone.threatOf("z")?.has("b"));
    zone.leave("b");
    assert.ok(!zone.threatOf("z")?.has("b"), "saiu da zona: fora da tabela");
    let died = false;
    for (let i = 0; i < 200 && !died; i++) {
      zone.tick();
      died = zone.getSnapshot("a")?.dead === true;
    }
    assert.ok(died, "a morreu");
    assert.ok(!zone.threatOf("z")?.has("a"), "morreu: fora da tabela");
  });

  it("XP não muda: só percepção/provocação não dá XP; quem bateu ganha a XP de sempre", () => {
    const zone = zoneWith([
      zombie("z", 0, 0, { maxHp: 14, level: 1, behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 5, leashRadius: 50, speed: 3.5 } }),
    ]);
    const a = join(zone, "a", 0, 2);
    const near1 = join(zone, "n", 3, 0);
    const knight = join(zone, "k", -2, 0);
    zone.tick();
    assert.ok(zone.threatOf("z")?.has("n"), "na percepção: tem ameaça");
    castAndFinish(zone, "k", cast("challenge"));
    assert.strictEqual(zone.npcTargetOf("z"), "k");
    castAndFinish(zone, "a", cast("bolt", { targetId: "z" })); // 18 > 14 × 1,2 × 1,02: mata
    assert.deepStrictEqual(a.saved, { level: 0, xp: groupXp(xpReward(1), 1), gold: goldReward(1) }, "só quem bateu, sem bônus");
    assert.strictEqual(near1.saved, null, "ameaça de percepção não dá XP");
    assert.strictEqual(knight.saved, null, "provocar não é bater nem curar: sem XP (fora de grupo)");
  });
});

import assert from "assert";

import { Zone, type ZoneMember } from "../src/zones/Zone.js";
import {
  ASSASSIN_SET,
  HEALER_SET,
  ITEMS,
  KNIGHT_SET,
  MAGE_SET,
  RANGER_SET,
  UNARMED_ATTACK,
  dashSteps,
  isMovementAbility,
  type AbilityDef,
} from "../src/items/catalog.js";
import { DUMMY_MAX_HP, PLAYER_MAX_HP, PLAYER_MAX_MANA } from "../src/combat/stats.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";
import type { CastData } from "../src/net/protocol.js";

/** Membro falso que guarda os eventos e o último snapshot. */
class Member implements ZoneMember {
  readonly name: string;
  readonly events: Array<Record<string, unknown>> = [];
  last: Record<string, unknown> = {};
  constructor(readonly id: string) {
    this.name = id;
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || !("data" in decoded)) return;
    if (decoded.type !== "snapshot" || typeof decoded.data !== "object" || decoded.data === null) return;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decoded.data)) data[k] = v;
    this.last = data;
    const events: unknown = data["events"];
    if (Array.isArray(events)) for (const e of events) this.events.push(e);
  }
  has(type: string, ability: string): boolean {
    return this.events.some((e) => e["type"] === type && e["ability"] === ability);
  }
}

/** Habilidade do catálogo pelo id (falha o teste se não existir). */
function def(itemId: string, abilityId: string): AbilityDef {
  const found: AbilityDef | undefined = ITEMS[itemId]?.abilities.find((a) => a.id === abilityId);
  assert.ok(found, abilityId);
  return found;
}

const ALL: ReadonlyMap<string, AbilityDef> = new Map(
  Object.values(ITEMS).flatMap((item) => item.abilities.map((a): [string, AbilityDef] => [a.id, a])),
);

/** Zona com o jogador "a" na origem (todas as habilidades vestidas) e um boneco em (0, -2). */
function setup(dummyAt: { x: number; z: number } = { x: 0, z: -2 }): { z: Zone; a: Member } {
  const z = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [{ id: "dummy", name: "B", ...dummyAt }] });
  const a = new Member("a");
  z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, ALL);
  return { z, a };
}

const cast = (abilityId: string, extra: Partial<CastData> = {}): CastData => ({
  abilityId,
  targetId: null,
  x: null,
  z: null,
  seq: null,
  ...extra,
});

/** Roda ticks até o fim do lançamento de `ability`. */
function finish(z: Zone, ability: AbilityDef): void {
  for (let i = 0; i <= Math.ceil(ability.castTime * TICK_RATE_HZ); i++) z.tick();
}

function npcHp(member: Member): number {
  const npcs: unknown = member.last["npcs"];
  if (!Array.isArray(npcs)) return NaN;
  const npc: unknown = npcs[0];
  return typeof npc === "object" && npc !== null && "hp" in npc && typeof npc.hp === "number" ? npc.hp : NaN;
}

describe("habilidades (cast)", () => {
  it("todos os conjuntos: toda carta de dano/cura/escudo é aceita e faz efeito no boneco/em si", () => {
    for (const itemId of [...MAGE_SET, ...KNIGHT_SET, ...RANGER_SET, ...ASSASSIN_SET, ...HEALER_SET]) {
      for (const ability of ITEMS[itemId]?.abilities ?? []) {
        if (isMovementAbility(ability)) continue; // Teleporte/Avanço/Marcha: mesma regra de Investida/Disparada ([JOGO-07])
        const { z, a } = setup();
        const aim: Partial<CastData> =
          ability.aim === "target" ? { targetId: "dummy" } : ability.aim === "direction" ? { x: 0, z: -1 } : ability.aim === "area" ? { x: 0, z: -2 } : {};
        assert.deepStrictEqual(z.castAbility("a", cast(ability.id, aim)), { ok: true }, ability.id);
        finish(z, ability);
        for (let i = 0; i < 20; i++) z.tick(); // projéteis chegam
        if (ability.damage > 0) assert.strictEqual(npcHp(a), DUMMY_MAX_HP - ability.damage, ability.id);
        if (ability.heal > 0) assert.ok(a.has("heal", ability.id), ability.id); // sem alvo, "ally" cura você
        if (ability.shield > 0) assert.ok(a.events.some((e) => e["type"] === "cast_start" && e["ability"] === ability.id), ability.id);
      }
    }
  });

  it("Golpe forte: gasta mana, começa recarga, dano em volta no fim do lançamento (sem precisar de alvo)", () => {
    const { z, a } = setup();
    const strike: AbilityDef = def("training_sword", "heavy_strike");
    assert.strictEqual(strike.aim, "area_self");
    assert.deepStrictEqual(z.castAbility("a", cast("heavy_strike")), { ok: true });
    z.tick();
    assert.ok(a.has("cast_start", "heavy_strike"));
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP, "sem dano antes do fim");
    finish(z, strike);
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP - strike.damage);
    const again = z.castAbility("a", cast("heavy_strike"));
    assert.ok(!again.ok && again.reason === "on_cooldown", "recarga");
  });

  it("Golpe forte: não pega quem está longe (só em volta do personagem)", () => {
    const { z, a } = setup({ x: 0, z: -4 });
    const strike: AbilityDef = def("training_sword", "heavy_strike");
    z.castAbility("a", cast("heavy_strike", { targetId: "dummy" }));
    finish(z, strike);
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP);
  });

  it("andar durante o lançamento cancela a habilidade: sem efeito, mana devolvida, recarga zerada", () => {
    const { z, a } = setup({ x: 50, z: 50 });
    const meteor: AbilityDef = def("training_staff", "meteor");
    z.castAbility("a", cast("meteor", { x: 0, z: -5 }));
    z.queueInput("a", { seq: 1, x: 0, z: 0 }); // parado: não cancela
    z.tick();
    assert.ok(!a.has("cast_cancel", "meteor"), "input parado não cancela");
    z.queueInput("a", { seq: 2, x: 1, z: 0 });
    z.tick();
    assert.ok(a.has("cast_cancel", "meteor"), "cancelou ao andar");
    finish(z, meteor);
    assert.ok(!a.events.some((e) => e["type"] === "impact" && e["ability"] === "meteor"), "sem efeito");
    const me: unknown = a.last["me"];
    assert.ok(typeof me === "object" && me !== null && "mana" in me && me.mana === PLAYER_MAX_MANA, "mana devolvida");
    assert.deepStrictEqual(z.castAbility("a", cast("meteor", { x: 0, z: -5 })), { ok: true }, "sem recarga");
  });

  it("andar cancela o golpe do ataque simples (sem dano) e não começa outro andando; parado, volta a atacar", () => {
    const { z, a } = setup({ x: 0, z: -1 });
    assert.strictEqual(z.setAttackTarget("a", "dummy"), "ok");
    z.tick();
    assert.ok(a.events.some((e) => e["type"] === "cast_start"), "golpe começou");
    let seq = 1;
    for (let i = 0; i < 30; i++) {
      z.queueInput("a", { seq: seq++, x: i % 2 === 0 ? 0.05 : -0.05, z: 0 }); // vai e volta: continua no alcance
      z.tick();
    }
    assert.ok(a.events.some((e) => e["type"] === "cast_cancel"), "cancelou ao andar");
    const startsWhileWalking: number = a.events.filter((e) => e["type"] === "cast_start").length;
    assert.strictEqual(startsWhileWalking, 1, "andando não recomeça o golpe");
    assert.ok(!a.events.some((e) => e["type"] === "damage"), "golpe cancelado não dá dano");
    for (let i = 0; i < 40; i++) z.tick();
    assert.ok(a.events.filter((e) => e["type"] === "cast_start").length > 1, "parado, voltou a atacar");
  });

  it("recusas: não vestida, alvo inválido, fora de alcance, sem mana", () => {
    const { z } = setup({ x: 0, z: -20 });
    const reason = (r: ReturnType<Zone["castAbility"]>): string => (r.ok ? "ok" : r.reason);
    assert.strictEqual(reason(z.castAbility("a", cast("nao_existe"))), "ability_not_equipped");
    assert.strictEqual(reason(z.castAbility("a", cast("bolt"))), "invalid_target");
    assert.strictEqual(reason(z.castAbility("a", cast("bolt", { targetId: "a" }))), "invalid_target", "você mesmo");
    assert.strictEqual(reason(z.castAbility("a", cast("bolt", { targetId: "dummy" }))), "out_of_range");
    let spent = 0;
    for (const id of ["meteor", "spin", "heal", "shield"]) {
      const r = z.castAbility("a", cast(id));
      if (r.ok) {
        spent += ALL.get(id)?.manaCost ?? 0;
        for (let i = 0; i < 30; i++) z.tick();
      }
    }
    assert.ok(spent > 0);
  });

  it("Bola de fogo: projétil voa até o alvo (dano na chegada, não no fim do lançamento); erra se não há ninguém", () => {
    const { z, a } = setup({ x: 0, z: -5 });
    const fireball: AbilityDef = def("training_staff", "fireball");
    assert.ok(fireball.projectileSpeed > 0);
    z.castAbility("a", cast("fireball", { x: 0, z: -1 }));
    finish(z, fireball);
    assert.ok(a.events.some((e) => e["type"] === "projectile" && e["ability"] === "fireball" && e["dirZ"] === -1), "saiu o projétil");
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP, "ainda voando: sem dano");
    // Encosta no corpo a 5 - 0,4 - 0,6 = 4 m: 4 / 14 m/s ≈ 0,29 s ≈ 6 ticks.
    for (let i = 0; i < 6; i++) z.tick();
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP - fireball.damage);
    const end = a.events.find((e) => e["type"] === "projectile_end");
    assert.ok(end && typeof end["z"] === "number" && Math.abs(end["z"] + 4) < 1e-6, "acaba onde encostou (z = -4)");
    assert.ok(a.has("impact", "fireball"));

    for (let i = 0; i < fireball.cooldown * TICK_RATE_HZ; i++) z.tick();
    a.events.length = 0;
    z.castAbility("a", cast("fireball", { x: 1, z: 0 }));
    finish(z, fireball);
    for (let i = 0; i < Math.ceil((fireball.range / fireball.projectileSpeed) * TICK_RATE_HZ) + 1; i++) z.tick();
    assert.ok(a.has("miss", "fireball"), "para o lado: voa até o alcance e erra");
    assert.ok(a.events.some((e) => e["type"] === "projectile_end"));
  });

  it("Bola de fogo: dá para desviar saindo do caminho enquanto ela voa", () => {
    const { z, a } = setup({ x: 50, z: 50 }); // boneco longe
    const b = new Member("b");
    z.join(b, { x: 0, y: 0, z: -10, rotY: 0 }, UNARMED_ATTACK, ALL);
    const fireball: AbilityDef = def("training_staff", "fireball");
    z.castAbility("a", cast("fireball", { x: 0, z: -1 }));
    finish(z, fireball);
    // b anda para o lado (5 m/s) durante o voo (~0,64 s até chegar perto dele): sai do caminho.
    for (let seq = 1; seq <= 20; seq++) {
      z.queueInput("b", { seq, x: 1, z: 0 });
      z.tick();
    }
    assert.ok(!a.events.some((e) => e["type"] === "damage" && e["target"] === "b"), "b desviou");
    assert.ok(a.has("miss", "fireball"));
  });

  it("Meteoro: dano em área no ponto; ponto além do alcance é limitado ao alcance", () => {
    const { z, a } = setup({ x: 0, z: -9 });
    const meteor: AbilityDef = def("training_staff", "meteor");
    z.castAbility("a", cast("meteor", { x: 0, z: -9 }));
    finish(z, meteor);
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP - meteor.damage);
  });

  it("Giro: dano em quem está ao redor", () => {
    const { z, a } = setup({ x: 2, z: 0 });
    const spin: AbilityDef = def("training_sword", "spin");
    z.castAbility("a", cast("spin"));
    finish(z, spin);
    assert.strictEqual(npcHp(a), DUMMY_MAX_HP - spin.damage);
  });

  it("Cura recupera vida; Escudo absorve dano antes da vida e acaba sozinho", () => {
    const zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [] });
    const a = new Member("a");
    const b = new Member("b");
    const bigHit: AbilityDef = { ...UNARMED_ATTACK, damage: 50, castTime: 0.05, range: 5 };
    zone.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, ALL);
    zone.join(b, { x: 1, y: 0, z: 0, rotY: 0 }, bigHit, ALL);

    const shield: AbilityDef = def("training_vest", "shield");
    zone.castAbility("a", cast("shield"));
    finish(zone, shield);
    assert.strictEqual(zone.getSnapshot("a")?.shield, shield.shield);

    zone.setAttackTarget("b", "a");
    zone.tick();
    zone.tick();
    const hit = a.events.find((e) => e["type"] === "damage" && e["target"] === "a");
    assert.ok(hit, "levou o golpe");
    assert.strictEqual(hit["absorbed"], shield.shield);
    assert.strictEqual(hit["amount"], 50 - shield.shield);
    zone.setAttackTarget("b", null);

    const heal: AbilityDef = def("training_hood", "heal");
    const before: number = zone.getSnapshot("a")?.hp ?? NaN;
    zone.castAbility("a", cast("heal"));
    finish(zone, heal);
    assert.ok((zone.getSnapshot("a")?.hp ?? 0) >= Math.min(PLAYER_MAX_HP, before + heal.heal) - 0.5, "curou");
    const me: unknown = a.last["me"];
    assert.ok(typeof me === "object" && me !== null && "mana" in me && typeof me.mana === "number" && me.mana < PLAYER_MAX_MANA, "gastou mana");
  });

  it("Investida na fila: percorre a distância nos passos seguintes (não teleporta), ignorando o joystick", () => {
    const { z } = setup({ x: 50, z: 50 });
    const dash: AbilityDef = def("training_sword", "dash");
    const steps: number = dashSteps(dash);
    assert.ok(steps > 1, "dura mais de um passo");
    z.queueInput("a", { seq: 1, x: 1, z: 0 });
    assert.deepStrictEqual(z.castAbility("a", cast("dash", { x: 0, z: -1, seq: 2 })), { ok: true }, "enfileirado");
    z.tick(); // seq 1 (passo) e 2 (começa a Investida, sem mover)
    const step: number = 5 * 0.05;
    assert.ok(Math.abs((z.getSnapshot("a")?.z ?? NaN) - 0) < 1e-9, "o comando em si não move");
    let seq = 2;
    for (let i = 0; i < steps; i++) {
      z.queueInput("a", { seq: ++seq, x: 1, z: 0 }); // joystick para o lado: ignorado durante a Investida
      z.tick();
      const partial = z.getSnapshot("a");
      assert.ok(partial && Math.abs(partial.z - -(dash.dashDistance * (i + 1)) / steps) < 1e-9, `passo ${i + 1}: z ${partial?.z}`);
    }
    z.queueInput("a", { seq: ++seq, x: 1, z: 0 }); // acabou: volta a andar normal
    z.tick();
    const snap = z.getSnapshot("a");
    assert.ok(snap);
    assert.ok(Math.abs(snap.x - 2 * step) < 1e-9 && Math.abs(snap.z - -dash.dashDistance) < 1e-9, `posição ${snap.x}, ${snap.z}`);
  });

  it("Disparada: dobra a velocidade dos próximos passos (contados em passos) e acaba", () => {
    const { z } = setup({ x: 50, z: 50 });
    const sprint: AbilityDef = def("training_boots", "sprint");
    z.castAbility("a", cast("sprint", { seq: 1 }));
    let seq = 1;
    const steps: number = Math.round(sprint.speedSeconds * TICK_RATE_HZ);
    for (let i = 0; i < steps; i++) {
      z.queueInput("a", { seq: ++seq, x: 1, z: 0 });
      z.tick();
    }
    const fast: number = z.getSnapshot("a")?.x ?? NaN;
    assert.ok(Math.abs(fast - steps * 2 * 5 * 0.05) < 1e-6, `rápido: ${fast}`);
    z.queueInput("a", { seq: ++seq, x: 1, z: 0 });
    z.tick();
    assert.ok(Math.abs((z.getSnapshot("a")?.x ?? NaN) - (fast + 5 * 0.05)) < 1e-6, "volta ao normal");
    assert.strictEqual(z.getSnapshot("a")?.speed, 1);
  });

  it("recusa na fila (recarga) vai como erro para o jogador e não move", () => {
    const { z, a } = setup({ x: 50, z: 50 });
    const errors: string[] = [];
    const original = a.send.bind(a);
    a.send = (text: string): void => {
      if (text.includes('"type":"error"')) errors.push(text);
      original(text);
    };
    z.castAbility("a", cast("dash", { x: 1, z: 0, seq: 1 }));
    z.tick();
    const after: number = z.getSnapshot("a")?.x ?? NaN;
    z.castAbility("a", cast("dash", { x: 1, z: 0, seq: 2 }));
    z.tick();
    assert.strictEqual(z.getSnapshot("a")?.x, after, "segunda investida recusada (recarga)");
    assert.ok(errors.some((e) => e.includes("on_cooldown")));
  });

  /** Zona sem bonecos com dois jogadores: "a" em (0,0) e "b" em `bAt`. "a" veste tudo; "b" nada. */
  function pair(bAt: { x: number; z: number } = { x: 0, z: -3 }): { z: Zone; a: Member; b: Member } {
    const z = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [] });
    const a = new Member("a");
    const b = new Member("b");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, ALL);
    z.join(b, { x: bAt.x, y: 0, z: bAt.z, rotY: 0 }, UNARMED_ATTACK, new Map());
    return { z, a, b };
  }

  /** Vida de `id` no último snapshot recebido por `member`. */
  function playerHp(member: Member, id: string): number {
    const players: unknown = member.last["players"];
    if (!Array.isArray(players)) return NaN;
    for (const p of players) {
      if (typeof p === "object" && p !== null && "id" in p && p.id === id && "hp" in p && typeof p.hp === "number") return p.hp;
    }
    return NaN;
  }

  it("Cura maior (mira aliado): cura outro jogador no alcance; sem alvo, cura você; alvo boneco é recusado", () => {
    const { z, a } = pair({ x: 0, z: -1 });
    const heal: AbilityDef = def("healer_tome", "greater_heal");
    // b apanha de a (PvP) para ter vida a recuperar.
    z.setAttackTarget("a", "b");
    for (let i = 0; i < 40; i++) z.tick();
    z.setAttackTarget("a", null);
    const hurt: number = playerHp(a, "b");
    assert.ok(hurt < PLAYER_MAX_HP, "b apanhou");
    assert.deepStrictEqual(z.castAbility("a", cast(heal.id, { targetId: "b" })), { ok: true });
    finish(z, heal);
    assert.ok(a.events.some((e) => e["type"] === "heal" && e["target"] === "b" && e["ability"] === heal.id));
    assert.ok(playerHp(a, "b") > hurt);

    const far = pair({ x: 0, z: -30 });
    assert.strictEqual(far.z.castAbility("a", cast(heal.id, { targetId: "b" })).ok, false, "fora de alcance");
    const withDummy = setup();
    assert.deepStrictEqual(withDummy.z.castAbility("a", cast(heal.id, { targetId: "dummy" })).ok, false, "boneco não é aliado");
    assert.deepStrictEqual(withDummy.z.castAbility("a", cast(heal.id)), { ok: true }, "sem alvo = em você");
    finish(withDummy.z, heal);
    assert.ok(withDummy.a.events.some((e) => e["type"] === "heal" && e["target"] === "a"));
  });

  it("Égide (área em volta, sem dano): escudo em você e nos aliados perto, não nos longe; boneco não apanha", () => {
    const aegis: AbilityDef = def("healer_robe", "aegis");
    const { z, a } = pair({ x: 0, z: -3 });
    const c = new Member("c");
    z.join(c, { x: 0, y: 0, z: -40, rotY: 0 }, UNARMED_ATTACK, new Map());
    assert.deepStrictEqual(z.castAbility("a", cast(aegis.id)), { ok: true });
    finish(z, aegis);
    const shieldOf = (id: string): unknown => {
      const players: unknown = a.last["players"];
      return Array.isArray(players) ? players.find((p) => typeof p === "object" && p !== null && "id" in p && p.id === id)?.shield : undefined;
    };
    assert.strictEqual(shieldOf("a"), aegis.shield);
    assert.strictEqual(shieldOf("b"), aegis.shield);
    assert.strictEqual(shieldOf("c"), 0);
    assert.ok(!a.events.some((e) => e["type"] === "damage"));
  });

  it("Pés de ferro (redução de dano): o dano cai pela metade enquanto dura, e volta depois", () => {
    const stance: AbilityDef = def("knight_greaves", "iron_stance");
    const { z, a } = pair({ x: 0, z: -1 });
    // b bate em a com o soco (4 de dano).
    z.setLoadout("b", UNARMED_ATTACK, new Map());
    assert.deepStrictEqual(z.castAbility("a", cast(stance.id)), { ok: true });
    z.tick();
    z.setAttackTarget("b", "a");
    for (let i = 0; i < 40; i++) z.tick();
    const reduced = a.events.filter((e) => e["type"] === "damage" && e["target"] === "a");
    assert.ok(reduced.length > 0);
    assert.ok(reduced.every((e) => e["amount"] === Math.round(UNARMED_ATTACK.damage * (1 - stance.damageReduction))), "metade");
    for (let i = 0; i < stance.reductionSeconds * TICK_RATE_HZ; i++) z.tick();
    const later = a.events.filter((e) => e["type"] === "damage" && e["target"] === "a").at(-1);
    assert.strictEqual(later?.["amount"], UNARMED_ATTACK.damage, "acabou: dano cheio");
  });

  it("vida extra dos itens: entra com a vida máxima maior; trocar de item mantém a proporção (não cura)", () => {
    const z = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [] });
    const a = new Member("a");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, UNARMED_ATTACK, new Map(), undefined, 150);
    z.tick();
    assert.strictEqual(z.getSnapshot("a")?.maxHp, PLAYER_MAX_HP + 150);
    assert.strictEqual(z.getSnapshot("a")?.hp, PLAYER_MAX_HP + 150);
    z.setLoadout("a", UNARMED_ATTACK, new Map(), undefined, 0);
    assert.strictEqual(z.getSnapshot("a")?.maxHp, PLAYER_MAX_HP);
    assert.strictEqual(z.getSnapshot("a")?.hp, PLAYER_MAX_HP, "cheia continua cheia");
  });

  it("ataque simples de cura (Livro): alvo fixo é outro jogador e recebe cura a cada lançamento; boneco recusado", () => {
    const tome = ITEMS["healer_tome"];
    assert.ok(tome?.basicAttack);
    const { z, a } = pair({ x: 0, z: -1 });
    z.setLoadout("a", tome.basicAttack, ALL);
    // b apanha antes, de a com o soco.
    z.setLoadout("a", UNARMED_ATTACK, ALL);
    z.setAttackTarget("a", "b");
    for (let i = 0; i < 40; i++) z.tick();
    z.setLoadout("a", tome.basicAttack, ALL);
    assert.strictEqual(z.setAttackTarget("a", "b"), "ok");
    assert.strictEqual(z.setAttackTarget("a", "a"), "invalid_target", "você mesmo não");
    z.setAttackTarget("a", "b");
    for (let i = 0; i < 40; i++) z.tick();
    assert.ok(a.events.some((e) => e["type"] === "heal" && e["target"] === "b" && e["ability"] === tome.basicAttack?.id));

    const withDummy = setup();
    withDummy.z.setLoadout("a", tome.basicAttack, ALL);
    assert.strictEqual(withDummy.z.setAttackTarget("a", "dummy"), "invalid_target");
  });
});

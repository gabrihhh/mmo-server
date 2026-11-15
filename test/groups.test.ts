import assert from "assert";

import { GROUP_POSITIONS_EVERY_TICKS, GROUP_XP_RADIUS, Zone, type DummyConfig, type FakePlayerConfig, type ZoneMember } from "../src/zones/Zone.js";
import { GROUP_INVITE_TICKS } from "../src/zones/groups.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { goldReward, groupXp, xpReward, type Progress } from "../src/progression/level.js";
import { GROUP_INVITE_SECONDS, GROUP_MAX_MEMBERS, GROUP_POSITIONS_HZ, type CastData } from "../src/net/protocol.js";
import { TICK_RATE_HZ } from "../src/sim/movement.js";

/** Grupo ([SOC-03]): convite, líder, saída, sem dano entre membros e XP do grupo. */

/** Mensagem recebida (só `type` e `data`). */
interface Received {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** Membro que guarda as mensagens de grupo, o último snapshot e o progresso salvo. */
class Member implements ZoneMember {
  readonly name: string;
  readonly inbox: Received[] = [];
  last: Record<string, unknown> = {};
  saved: Progress | null = null;
  hides: boolean = false;
  constructor(readonly id: string) {
    this.name = id.toUpperCase();
  }
  send(text: string): void {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("type" in decoded) || !("data" in decoded)) return;
    if (typeof decoded.type !== "string" || typeof decoded.data !== "object" || decoded.data === null) return;
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(decoded.data));
    if (decoded.type === "snapshot") this.last = data;
    else this.inbox.push({ type: decoded.type, data });
  }
  onProgress(progress: Progress): void {
    this.saved = progress;
  }
  hidesGroupInvites(): boolean {
    return this.hides;
  }
  /** Mensagens de um tipo recebidas até agora. */
  all(type: string): Received[] {
    return this.inbox.filter((m) => m.type === type);
  }
  /** Códigos dos `group_notice` recebidos. */
  notices(): string[] {
    return this.all("group_notice").map((m) => String(m.data["code"]));
  }
  /** O último `group` recebido: `{ leaderId, members }`, `null` (sem grupo) ou `undefined` (nunca recebeu). */
  group(): { leaderId: string; members: string[] } | null | undefined {
    const list: Received[] = this.all("group");
    const last: Received | undefined = list[list.length - 1];
    if (last === undefined) return undefined;
    const group: unknown = last.data["group"];
    if (group === null || typeof group !== "object") return null;
    const leaderId: unknown = "leaderId" in group ? group.leaderId : "";
    const members: unknown = "members" in group ? group.members : [];
    return {
      leaderId: String(leaderId),
      members: Array.isArray(members) ? members.map((m: unknown) => (typeof m === "object" && m !== null && "id" in m ? String(m.id) : "")) : [],
    };
  }
  /** Vida do jogador `id` no último snapshot. */
  hpOf(id: string): number {
    const list: unknown = this.last["players"];
    if (!Array.isArray(list)) return NaN;
    for (const e of list) if (typeof e === "object" && e !== null && "id" in e && e.id === id && "hp" in e && typeof e.hp === "number") return e.hp;
    return NaN;
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

const SWORD: AbilityDef = ITEMS["training_sword"]?.basicAttack ?? UNARMED_ATTACK;

function abilityOf(itemId: string, abilityId: string): AbilityDef {
  const found: AbilityDef | undefined = ITEMS[itemId]?.abilities.find((a) => a.id === abilityId);
  if (found === undefined) throw new Error(`habilidade ${abilityId} não existe`);
  return found;
}

function zone(dummies: readonly DummyConfig[] = [], pvp: boolean = true): Zone {
  return new Zone({ id: "t", halfSize: 150, maxPlayers: 20, spawnRadius: 0, pvp, dummies, fakePlayers: [ACCEPT, REJECT] });
}

/** Põe jogadores de verdade na zona, um ao lado do outro (x = 0, -1, -2...). */
function players(z: Zone, ...ids: string[]): Member[] {
  return ids.map((id, i) => {
    const member = new Member(id);
    z.join(member, { x: -i, y: 0, z: 0, rotY: 0 }, SWORD);
    return member;
  });
}

/** `leader` convida cada um de `others` e eles aceitam. */
function form(z: Zone, leader: Member, ...others: Member[]): void {
  for (const other of others) {
    assert.deepStrictEqual(z.inviteToGroup(leader.id, other.id), { ok: true });
    assert.deepStrictEqual(z.answerGroupInvite(other.id, leader.id, true), { ok: true });
  }
}

const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? "ok" : (r.reason ?? ""));

describe("grupo ([SOC-03])", () => {
  it("fake que aceita entra no grupo na hora; quem convidou vira líder e recebe 'aceitou'", () => {
    const z = zone();
    const [a] = players(z, "a");
    assert.ok(a !== undefined);
    assert.deepStrictEqual(z.inviteToGroup("a", "fake_accept"), { ok: true });
    assert.ok(a.notices().includes("accepted"));
    assert.match(String(a.all("group_notice")[0]?.data["message"]), /Fake Aceita aceitou o convite/);
    assert.deepStrictEqual(a.group(), { leaderId: "a", members: ["a", "fake_accept"] });
    assert.deepStrictEqual(z.groupOf("fake_accept")?.leaderId, "a");
  });

  it("fake que recusa: aviso 'recusou' e nada de grupo", () => {
    const z = zone();
    const [a] = players(z, "a");
    assert.ok(a !== undefined);
    assert.deepStrictEqual(z.inviteToGroup("a", "fake_reject"), { ok: true });
    assert.deepStrictEqual(a.notices(), ["rejected"]);
    assert.match(String(a.all("group_notice")[0]?.data["message"]), /Fake Recusa recusou o convite/);
    assert.strictEqual(z.groupOf("a"), null);
  });

  it("jogador de verdade: recebe o convite (Aceitar/Recusar), aceita ou recusa", () => {
    const z = zone();
    const [a, b, c] = players(z, "a", "b", "c");
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    z.inviteToGroup("a", "b");
    const invite: Received | undefined = b.all("group_invited")[0];
    assert.deepStrictEqual(invite?.data, { fromId: "a", fromName: "A", expiresIn: GROUP_INVITE_SECONDS });
    assert.strictEqual(z.groupOf("a"), null, "o grupo só nasce quando ele aceita");
    assert.deepStrictEqual(z.answerGroupInvite("b", "a", true), { ok: true });
    assert.deepStrictEqual(b.group(), { leaderId: "a", members: ["a", "b"] });
    assert.deepStrictEqual(a.notices(), ["accepted"]);
    assert.deepStrictEqual(b.notices(), ["joined"]);
    // C recusa.
    z.inviteToGroup("a", "c");
    assert.deepStrictEqual(z.answerGroupInvite("c", "a", false), { ok: true });
    assert.deepStrictEqual(a.notices(), ["accepted", "rejected"]);
    assert.strictEqual(reason(z.answerGroupInvite("c", "a", true)), "invite_not_found", "já respondeu");
  });

  it("convite expira em 30 s: quem convidou recebe 'não respondeu' e a resposta tardia é recusada", () => {
    const z = zone();
    const [a, b] = players(z, "a", "b");
    assert.ok(a !== undefined && b !== undefined);
    z.inviteToGroup("a", "b");
    assert.strictEqual(GROUP_INVITE_TICKS, 30 * TICK_RATE_HZ);
    for (let i = 0; i < GROUP_INVITE_TICKS - 1; i++) z.tick();
    assert.deepStrictEqual(a.notices(), [], "ainda dentro do prazo");
    z.tick();
    assert.deepStrictEqual(a.notices(), ["expired"]);
    assert.match(String(a.all("group_notice")[0]?.data["message"]), /B não respondeu ao convite/);
    assert.strictEqual(reason(z.answerGroupInvite("b", "a", true)), "invite_not_found");
  });

  it("convidado que já tem grupo: aviso 'já está em um grupo'; convidar a si ou quem já é do grupo: recusa", () => {
    const z = zone();
    const [a, b, c] = players(z, "a", "b", "c");
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    form(z, b, c);
    assert.deepStrictEqual(z.inviteToGroup("a", "c"), { ok: true });
    assert.deepStrictEqual(a.notices(), ["in_group"]);
    assert.ok(c.all("group_invited").every((m) => m.data["fromId"] !== "a"), "o convite de A não chega");
    assert.strictEqual(reason(z.inviteToGroup("b", "b")), "invalid_invite");
    assert.strictEqual(reason(z.inviteToGroup("b", "c")), "invalid_invite");
    assert.strictEqual(reason(z.inviteToGroup("b", "ninguem")), "player_not_found");
  });

  it("até 5 membros; só o líder convida", () => {
    const z = zone();
    const [a, b, c, d, e, f] = players(z, "a", "b", "c", "d", "e", "f");
    assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined && e !== undefined && f !== undefined);
    form(z, a, b, c);
    assert.strictEqual(reason(z.inviteToGroup("b", "f")), "not_group_leader");
    form(z, a, d, e);
    assert.strictEqual(z.groupOf("a")?.members.length, GROUP_MAX_MEMBERS);
    assert.strictEqual(reason(z.inviteToGroup("a", "f")), "group_full");
    // Convite pendente quando o grupo encheu: aceitar é recusado.
    const z2 = zone();
    const [p1, p2, p3, p4, p5, p6] = players(z2, "p1", "p2", "p3", "p4", "p5", "p6");
    assert.ok(p1 !== undefined && p2 !== undefined && p3 !== undefined && p4 !== undefined && p5 !== undefined && p6 !== undefined);
    form(z2, p1, p2, p3, p4);
    z2.inviteToGroup("p1", "p5");
    z2.inviteToGroup("p1", "p6");
    z2.answerGroupInvite("p5", "p1", true);
    assert.strictEqual(reason(z2.answerGroupInvite("p6", "p1", true)), "group_full");
  });

  it("o líder sai: o próximo que entrou vira líder; sobrou 1: o grupo acaba", () => {
    const z = zone();
    const [a, b, c] = players(z, "a", "b", "c");
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    form(z, a, b, c);
    assert.deepStrictEqual(z.leaveGroup("a"), { ok: true });
    assert.strictEqual(a.group(), null);
    assert.deepStrictEqual(c.group(), { leaderId: "b", members: ["b", "c"] });
    assert.ok(c.notices().includes("left") && c.notices().includes("leader"));
    assert.deepStrictEqual(z.leaveGroup("c"), { ok: true });
    assert.strictEqual(b.group(), null, "sobrou só B: acabou");
    assert.ok(b.notices().includes("disbanded"));
    assert.strictEqual(z.groupOf("b"), null);
    assert.strictEqual(reason(z.leaveGroup("b")), "not_in_group");
  });

  it("expulsar: só o líder; o expulso recebe 'group: null' e o aviso", () => {
    const z = zone();
    const [a, b, c] = players(z, "a", "b", "c");
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    form(z, a, b, c);
    assert.strictEqual(reason(z.kickFromGroup("b", "c")), "not_group_leader");
    assert.strictEqual(reason(z.kickFromGroup("a", "a")), "not_in_group");
    assert.deepStrictEqual(z.kickFromGroup("a", "b"), { ok: true });
    assert.strictEqual(b.group(), null);
    assert.ok(b.notices().includes("kicked"));
    assert.deepStrictEqual(c.group(), { leaderId: "a", members: ["a", "c"] });
    // O fake pode ser expulso também (ele mesmo nunca sai sozinho).
    z.inviteToGroup("a", "fake_accept");
    assert.deepStrictEqual(z.kickFromGroup("a", "fake_accept"), { ok: true });
    assert.deepStrictEqual(c.group(), { leaderId: "a", members: ["a", "c"] });
  });

  it("sair da zona (deslogar/cair) tira do grupo e apaga os convites dele", () => {
    const z = zone();
    const [a, b, c, d] = players(z, "a", "b", "c", "d");
    assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined);
    form(z, a, b, c);
    z.inviteToGroup("a", "d");
    z.leave("a");
    assert.deepStrictEqual(b.group(), { leaderId: "b", members: ["b", "c"] });
    assert.strictEqual(reason(z.answerGroupInvite("d", "a", true)), "invite_not_found");
    z.leave("c");
    assert.strictEqual(b.group(), null);
  });

  it("ocultar convites (Configuração, SOC-04): recusa sozinho e quem convidou vê 'recusou'", () => {
    const z = zone();
    const [a, b] = players(z, "a", "b");
    assert.ok(a !== undefined && b !== undefined);
    b.hides = true;
    assert.strictEqual(z.groupInviteAutoAnswer("b"), "reject");
    z.inviteToGroup("a", "b");
    assert.deepStrictEqual(a.notices(), ["rejected"]);
    assert.strictEqual(b.all("group_invited").length, 0);
  });

  it("membros não se atacam nem tomam dano de área de membro (com PvP); quem é de fora toma", () => {
    const z = zone();
    const meteor: AbilityDef = abilityOf("training_staff", "meteor");
    const a = new Member("a");
    const b = new Member("b");
    const c = new Member("c");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD, new Map([[meteor.id, meteor]]));
    z.join(b, { x: 0, y: 0, z: -5, rotY: 0 }, SWORD);
    z.join(c, { x: 0.5, y: 0, z: -5, rotY: 0 }, SWORD);
    form(z, a, b);
    assert.strictEqual(z.setAttackTarget("a", "b"), "invalid_target", "membro não é alvo");
    assert.strictEqual(z.setAttackTarget("a", "c"), "ok", "de fora, com PvP, é");
    z.setAttackTarget("a", null);
    const request: CastData = { abilityId: meteor.id, targetId: null, x: 0, z: -5, seq: null };
    assert.deepStrictEqual(z.castAbility("a", request), { ok: true });
    for (let i = 0; i < Math.ceil(meteor.castTime * TICK_RATE_HZ) + 2; i++) z.tick();
    assert.ok(a.hpOf("c") < a.hpOf("b"), `C tomou dano (${a.hpOf("c")}), B não (${a.hpOf("b")})`);
    assert.strictEqual(a.hpOf("b"), z.getSnapshot("b")?.maxHp);
  });

  it("XP: membro perto que não lutou ganha e conta no bônus; longe ou de fora, não; ninguém duplica", () => {
    const zombie: DummyConfig = {
      id: "zombie",
      name: "Zumbi",
      x: 0,
      z: -2,
      level: 1,
      maxHp: 40,
      body: "zombie",
      behavior: { kind: "zombie", attack: "zombie_punch", ability: "zombie_bash", aggroRadius: 8, leashRadius: 20, speed: 3.5 },
    };
    const z = zone([zombie], false);
    const a = new Member("a");
    const near = new Member("near");
    const far = new Member("far");
    const outsider = new Member("outsider");
    z.join(a, { x: 0, y: 0, z: 0, rotY: 0 }, SWORD);
    z.join(near, { x: 20, y: 0, z: 0, rotY: 0 }, SWORD);
    z.join(far, { x: GROUP_XP_RADIUS + 10, y: 0, z: 0, rotY: 0 }, SWORD);
    z.join(outsider, { x: -20, y: 0, z: 0, rotY: 0 }, SWORD);
    form(z, a, near, far);
    z.setAttackTarget("a", "zombie");
    let died = false;
    for (let i = 0; i < 600 && !died; i++) {
      z.tick();
      const events: unknown = a.last["events"];
      died = Array.isArray(events) && events.some((e: unknown) => typeof e === "object" && e !== null && "type" in e && e.type === "death" && "id" in e && e.id === "zombie");
    }
    assert.ok(died, "zumbi morreu");
    const reward: number = groupXp(xpReward(1), 2);
    assert.deepStrictEqual(a.saved, { level: 0, xp: reward, gold: goldReward(1) }, "quem bateu: XP + bônus de 2");
    assert.deepStrictEqual(near.saved, { level: 0, xp: reward, gold: goldReward(1) }, "membro perto: mesma XP, sem ter batido");
    assert.strictEqual(far.saved, null, "membro longe: nada");
    assert.strictEqual(outsider.saved, null, "de fora do grupo: nada");
  });
});

describe("posições do grupo para o mapa (group_positions, [SOC-03]/[CLI-11])", () => {
  /** Põe um jogador de verdade na zona em (x, z). */
  function at(z: Zone, id: string, x: number, zPos: number): Member {
    const member = new Member(id);
    z.join(member, { x, y: 0, z: zPos, rotY: 0 }, SWORD);
    return member;
  }

  /** Os `group_positions` recebidos: cada um vira a lista `id@x,z`. */
  function positions(m: Member): string[][] {
    return m.all("group_positions").map((msg) => {
      const list: unknown = msg.data["members"];
      if (!Array.isArray(list)) return [];
      return list.map((e: unknown) => (typeof e === "object" && e !== null && "id" in e && "x" in e && "z" in e ? `${String(e.id)}@${String(e.x)},${String(e.z)}` : "?"));
    });
  }

  const ticks = (z: Zone, n: number): void => {
    for (let i = 0; i < n; i++) z.tick();
  };

  it("membro longe recebe a posição do outro a 2 Hz; quem está perto não vem; quem não é do grupo não recebe", () => {
    assert.strictEqual(GROUP_POSITIONS_EVERY_TICKS, TICK_RATE_HZ / GROUP_POSITIONS_HZ);
    const z = zone();
    const a = at(z, "a", 0, 0);
    const b = at(z, "b", 100, 0);
    const near = at(z, "near", 10, 0);
    const outsider = at(z, "outsider", 100, 5);
    form(z, a, b, near);
    ticks(z, GROUP_POSITIONS_EVERY_TICKS - 1);
    assert.deepStrictEqual(positions(a), [], "só a cada GROUP_POSITIONS_EVERY_TICKS");
    ticks(z, 1);
    // A (0,0): B está a 100 m (longe); NEAR a 10 m já vem no snapshot. Fakes da zona não são do grupo.
    assert.deepStrictEqual(positions(a), [["b@100,0"]]);
    assert.deepStrictEqual(positions(b), [["a@0,0", "near@10,0"]], "B vê os dois (ambos longe dele)");
    assert.deepStrictEqual(positions(near), [["b@100,0"]]);
    assert.deepStrictEqual(positions(outsider), [], "quem não é do grupo não recebe (mesmo perto de B)");
    ticks(z, GROUP_POSITIONS_EVERY_TICKS * 3);
    assert.strictEqual(positions(a).length, 4, "2 Hz: uma a cada 10 ticks");
  });

  it("sozinho ou com o grupo todo perto: nada é mandado", () => {
    const z = zone();
    const solo = at(z, "solo", 0, 0);
    const a = at(z, "a", 50, 0);
    const b = at(z, "b", 60, 0);
    form(z, a, b);
    ticks(z, GROUP_POSITIONS_EVERY_TICKS * 2);
    assert.deepStrictEqual(positions(solo), []);
    assert.deepStrictEqual(positions(a), []);
    assert.deepStrictEqual(positions(b), []);
  });

  it("sair do grupo (ou o grupo acabar) para de mandar", () => {
    const z = zone();
    const a = at(z, "a", 0, 0);
    const b = at(z, "b", -120, 30);
    const c = at(z, "c", 120, -30);
    form(z, a, b, c);
    ticks(z, GROUP_POSITIONS_EVERY_TICKS);
    assert.deepStrictEqual(positions(a), [["b@-120,30", "c@120,-30"]]);
    assert.deepStrictEqual(z.leaveGroup("c"), { ok: true });
    ticks(z, GROUP_POSITIONS_EVERY_TICKS);
    assert.deepStrictEqual(positions(a)[1], ["b@-120,30"], "C saiu: não vem mais para A");
    assert.strictEqual(positions(c).length, 1, "C não recebe mais nada");
    assert.deepStrictEqual(z.leaveGroup("b"), { ok: true });
    ticks(z, GROUP_POSITIONS_EVERY_TICKS * 2);
    assert.strictEqual(positions(a).length, 2, "o grupo acabou: A para de receber");
    assert.strictEqual(positions(b).length, 2);
  });
});

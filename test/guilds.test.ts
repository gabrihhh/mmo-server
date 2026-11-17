import assert from "assert";

import { GUILD_CREATE_COST, GUILD_MAX_MEMBERS, ServerMessageType, type ServerMessage } from "../src/net/protocol.js";
import {
  GUILD_INVITE_MS,
  GUILD_LEAVE_COOLDOWN_MS,
  Guilds,
  guildNameKey,
  normalizeGuildName,
  normalizeGuildTag,
  readGuildRecord,
  type GuildRecord,
} from "../src/social/guilds.js";
import { SAFE_ZONE_HALF } from "../src/combat/pvp.js";
import { ITEMS, UNARMED_ATTACK, type AbilityDef } from "../src/items/catalog.js";
import { Zone, type ZoneMember } from "../src/zones/Zone.js";

/** Host em memória: jogadores online com moedas; guarda mensagens, gravações e a tag que a zona recebeu. */
function setup(online: string[] = ["a", "b", "c", "d"]): {
  guilds: Guilds;
  sent: Array<{ to: string; message: ServerMessage }>;
  gold: Map<string, number>;
  saved: Map<string, GuildRecord>;
  tags: Map<string, string | null>;
  leftAt: Map<string, number>;
  auto: Map<string, "accept" | "reject">;
} {
  const sent: Array<{ to: string; message: ServerMessage }> = [];
  const gold: Map<string, number> = new Map(online.map((id) => [id, 5000]));
  const saved: Map<string, GuildRecord> = new Map();
  const tags: Map<string, string | null> = new Map();
  const leftAt: Map<string, number> = new Map();
  const auto: Map<string, "accept" | "reject"> = new Map();
  const guilds: Guilds = new Guilds({
    send: (to, message): void => {
      sent.push({ to, message });
    },
    nameOf: (id): string | undefined => (online.includes(id) ? id.toUpperCase() : undefined),
    levelOf: (id): number | null => (online.includes(id) ? 7 : null),
    autoAnswer: (id): "accept" | "reject" | null => auto.get(id) ?? null,
    spendGold: (id, amount): boolean => {
      const have: number = gold.get(id) ?? 0;
      if (have < amount) return false;
      gold.set(id, have - amount);
      return true;
    },
    leftAt: (id): number | null => leftAt.get(id) ?? null,
    setLeftAt: (id, at): void => {
      leftAt.set(id, at);
    },
    save: (guild): void => {
      saved.set(guild.id, guild);
    },
    remove: (id): void => {
      saved.delete(id);
    },
    onMemberGuild: (id, guild): void => {
      tags.set(id, guild?.tag ?? null);
    },
  });
  return { guilds, sent, gold, saved, tags, leftAt, auto };
}

/** Último `guild_notice` mandado a [to]. */
function lastNotice(sent: Array<{ to: string; message: ServerMessage }>, to: string): string | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const entry = sent[i];
    if (entry?.to === to && entry.message.type === ServerMessageType.GuildNotice) return entry.message.data.message;
  }
  return undefined;
}

/** Cria a guilda de "a" e põe [others] dentro (convite + aceite). */
function guildWith(others: string[]): ReturnType<typeof setup> & { id: string } {
  const env = setup(["a", ...others, "x"]);
  assert.deepStrictEqual(env.guilds.create("a", "Ordem da Luz", "odl", 0), { ok: true });
  const id: string = env.guilds.guildOf("a")?.id ?? "";
  others.forEach((other, index) => {
    assert.ok(env.guilds.invite("a", other, 10 + index).ok);
    assert.ok(env.guilds.answer(other, "a", true, 10 + index).ok);
  });
  return { ...env, id };
}

describe("guilda ([SOC-06])", () => {
  it("nome e tag: regras, maiúsculas e nome sem diferença de acento/caixa", () => {
    assert.strictEqual(normalizeGuildName("  Ordem   da Luz "), "Ordem da Luz");
    assert.strictEqual(normalizeGuildName("ab"), null, "curto");
    assert.strictEqual(normalizeGuildName("x".repeat(21)), null, "longo");
    assert.strictEqual(normalizeGuildName("Guilda!"), null, "símbolo");
    assert.strictEqual(normalizeGuildName("Ação 2"), "Ação 2", "acento e número valem");
    assert.strictEqual(normalizeGuildTag("a1b"), "A1B");
    assert.strictEqual(normalizeGuildTag("ab"), null);
    assert.strictEqual(normalizeGuildTag("ãbc"), null);
    assert.strictEqual(guildNameKey("Ordém"), guildNameKey("ORDEM"));
  });

  it("criar custa 1000 moedas, vira líder, tag na zona; nome/tag repetidos e sem moedas são recusados", () => {
    const { guilds, gold, saved, tags } = setup();
    assert.deepStrictEqual(guilds.create("a", "Ordem", "ord", 0), { ok: true });
    assert.strictEqual(gold.get("a"), 5000 - GUILD_CREATE_COST);
    assert.strictEqual(tags.get("a"), "ORD");
    const record: GuildRecord | undefined = [...saved.values()][0];
    assert.deepStrictEqual(record?.members.map((m) => [m.id, m.role]), [["a", "leader"]]);
    assert.strictEqual(guilds.create("a", "Outra", "out", 0).ok, false, "uma guilda por vez");
    assert.strictEqual((guilds.create("b", "ordem", "xyz", 0) as { reason: string }).reason, "guild_name_taken");
    assert.strictEqual((guilds.create("b", "Nova", "ORD", 0) as { reason: string }).reason, "guild_tag_taken");
    gold.set("c", 999);
    assert.strictEqual((guilds.create("c", "Pobres", "pob", 0) as { reason: string }).reason, "not_enough_gold");
    assert.strictEqual(gold.get("c"), 999, "recusado não cobra");
    assert.strictEqual((guilds.create("d", "Bad!", "bad", 0) as { reason: string }).reason, "invalid_guild");
    assert.strictEqual(gold.get("d"), 5000, "nome inválido não cobra");
  });

  it("convite: líder/oficial convidam, membro não; aceitar entra como membro; expira sem resposta", () => {
    const { guilds, sent, tags } = guildWith(["b"]);
    assert.strictEqual((guilds.invite("b", "c", 0) as { reason: string }).reason, "guild_no_permission", "membro não convida");
    assert.ok(guilds.invite("a", "c", 0).ok === false, "c está offline nesse setup");
    assert.ok(guilds.invite("a", "x", 1000).ok);
    assert.ok(guilds.hasInvite("x", "a"));
    guilds.expire(1000 + GUILD_INVITE_MS);
    assert.strictEqual(guilds.hasInvite("x", "a"), false);
    assert.strictEqual(lastNotice(sent, "a"), "X não respondeu ao convite para a guilda.");
    assert.strictEqual((guilds.answer("x", "a", true, 99999) as { reason: string }).reason, "guild_invite_not_found");
    assert.strictEqual(tags.get("b"), "ODL");
    assert.strictEqual(guilds.guildOf("b")?.tag, "ODL");
  });

  it("quem já tem guilda não é convidado; Fake Aceita/quem oculta respondem sozinhos", () => {
    const env = setup(["a", "b", "c", "f"]);
    env.guilds.create("a", "Ordem", "ord", 0);
    env.guilds.create("b", "Caos", "cao", 0);
    assert.strictEqual((env.guilds.invite("a", "b", 0) as { reason: string }).reason, "already_in_guild");
    env.auto.set("c", "reject");
    assert.ok(env.guilds.invite("a", "c", 0).ok);
    assert.strictEqual(lastNotice(env.sent, "a"), "C recusou o convite para a guilda.");
    env.auto.set("f", "accept");
    assert.ok(env.guilds.invite("a", "f", 0).ok);
    assert.ok(env.guilds.sameGuild("a", "f"), "fake aceita na hora");
  });

  it("cargos: líder promove/rebaixa; oficial convida e expulsa só membro; ninguém expulsa o líder", () => {
    const { guilds } = guildWith(["b", "c", "d"]);
    assert.strictEqual((guilds.setRole("b", "c", "officer") as { reason: string }).reason, "guild_no_permission");
    assert.ok(guilds.setRole("a", "b", "officer").ok);
    assert.ok(guilds.setRole("a", "c", "officer").ok);
    assert.strictEqual((guilds.kick("b", "a") as { reason: string }).reason, "guild_no_permission", "oficial não expulsa o líder");
    assert.strictEqual((guilds.kick("b", "c") as { reason: string }).reason, "guild_no_permission", "nem outro oficial");
    assert.ok(guilds.kick("b", "d").ok, "oficial expulsa membro");
    assert.strictEqual(guilds.guildOf("d"), null);
    assert.ok(guilds.invite("b", "x", 0).ok, "oficial convida");
    assert.ok(guilds.kick("a", "c").ok, "líder expulsa oficial");
  });

  it("líder sai → oficial mais antigo; sem oficial → membro mais antigo; o último acaba com a guilda", () => {
    const { guilds, saved, id } = guildWith(["b", "c", "d"]);
    guilds.setRole("a", "d", "officer");
    guilds.setRole("a", "c", "officer");
    guilds.leave("a", 100);
    assert.strictEqual(guilds.get(id)?.members.find((m) => m.role === "leader")?.id, "c", "c entrou antes de d");
    guilds.setRole("c", "d", "member");
    guilds.leave("c", 100);
    assert.strictEqual(guilds.get(id)?.members.find((m) => m.role === "leader")?.id, "b", "sem oficial: o membro mais antigo");
    guilds.leave("d", 100);
    guilds.leave("b", 100);
    assert.strictEqual(guilds.get(id), undefined);
    assert.strictEqual(saved.has(id), false, "apagada do banco");
  });

  it("saiu por vontade própria: 1 h sem aceitar convite; expulso entra na hora", () => {
    const env = guildWith(["b", "c"]);
    env.guilds.leave("b", 1000);
    env.guilds.create("x", "Outra", "out", 0);
    assert.strictEqual((env.guilds.invite("x", "b", 2000) as { reason: string }).reason, "guild_cooldown");
    assert.ok(env.guilds.invite("x", "b", 1000 + GUILD_LEAVE_COOLDOWN_MS).ok, "passou 1 h");
    env.guilds.kick("a", "c");
    assert.ok(env.guilds.invite("x", "c", 3000).ok, "expulso não espera");
  });

  it("cheia: no máximo 50", () => {
    const ids: string[] = Array.from({ length: GUILD_MAX_MEMBERS }, (_, i) => `p${i}`);
    const env = setup(["a", ...ids]);
    env.guilds.create("a", "Grande", "big", 0);
    ids.slice(0, GUILD_MAX_MEMBERS - 1).forEach((id) => env.auto.set(id, "accept"));
    for (const id of ids.slice(0, GUILD_MAX_MEMBERS - 1)) assert.ok(env.guilds.invite("a", id, 0).ok);
    assert.strictEqual((env.guilds.invite("a", ids[GUILD_MAX_MEMBERS - 1] ?? "", 0) as { reason: string }).reason, "guild_full");
  });

  it("carregar do banco: formato estranho fica de fora; guilda sem líder ganha um", () => {
    assert.strictEqual(readGuildRecord({ id: 1 }), null);
    const record: GuildRecord | null = readGuildRecord({
      id: "g1",
      name: "Velha",
      tag: "OLD",
      createdAt: 0,
      members: [{ id: "a", name: "A", role: "member", joinedAt: 5 }, { id: "b", name: "B", role: "officer", joinedAt: 9 }, { lixo: true }],
    });
    assert.ok(record !== null);
    const { guilds } = setup();
    guilds.load([record]);
    assert.strictEqual(guilds.get("g1")?.members.find((m) => m.role === "leader")?.id, "b");
    const loaded: GuildRecord | undefined = guilds.get("g1");
    assert.ok(loaded !== undefined);
    assert.deepStrictEqual(guilds.view(loaded).members.map((m) => [m.id, m.role]), [["b", "leader"], ["a", "member"]], "líder primeiro");
  });

  it("na zona: guildeiros não se batem (mesmo com PvP) e a tag vai no player_joined/player_guild", () => {
    const LETHAL: AbilityDef = { ...(ITEMS["knight_sword"]?.basicAttack ?? UNARMED_ATTACK), damage: 99999, castTime: 0.05, cooldown: 0.05 };
    const texts: string[] = [];
    const member = (id: string): ZoneMember => ({ id, name: id, send: (text: string): void => void texts.push(text) });
    const zone: Zone = new Zone({ id: "t", halfSize: 150, maxPlayers: 10, spawnRadius: 0, pvp: true, dummies: [], safeZoneHalf: SAFE_ZONE_HALF });
    zone.join(member("a"), { x: 30, y: 0, z: 30, rotY: 0 }, LETHAL);
    zone.join(member("b"), { x: 31, y: 0, z: 30, rotY: 0 });
    zone.setGuild("a", { id: "g", tag: "ORD" });
    zone.setGuild("b", { id: "g", tag: "ORD" });
    assert.ok(texts.some((t) => t.includes('"type":"player_guild"') && t.includes('"guildTag":"ORD"')));
    assert.notStrictEqual(zone.setAttackTarget("a", "b"), "ok", "mesma guilda não é alvo");
    zone.setGuild("b", null);
    assert.strictEqual(zone.setAttackTarget("a", "b"), "ok", "saiu da guilda: PvP volta");
    texts.length = 0;
    zone.join(member("c"), { x: 0, y: 0, z: 0, rotY: 0 });
    assert.ok(texts.some((t) => t.includes('"type":"welcome"') === false && t.includes('"player_joined"')));
    assert.strictEqual(zone.spendGold("a", 1), false, "sem moedas");
  });
});

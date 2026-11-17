import { randomBytes } from "node:crypto";

import {
  GUILD_CREATE_COST,
  GUILD_DESCRIPTION_MAX,
  GUILD_LIST_MAX,
  GUILD_REQUEST_DAYS,
  GUILD_INVITE_SECONDS,
  GUILD_LEAVE_COOLDOWN_SECONDS,
  GUILD_MAX_MEMBERS,
  ServerMessageType,
  type GuildInfoView,
  type GuildMemberView,
  type GuildRequestView,
  type GuildSummaryView,
  type GuildNoticeCode,
  type GuildRole,
  type GuildView,
  type ServerMessage,
} from "../net/protocol.js";

/**
 * Guildas (clãs, mmo-docs [SOC-06]): grupo permanente, salvo no banco (coleção `guilds`), diferente do grupo da sessão
 * ([SOC-03]). Todas as guildas ficam na memória (carregadas ao ligar, {@link Guilds.load}); cada mudança é feita aqui
 * na hora (sem corrida entre dois pedidos) e gravada no banco depois ({@link GuildHost.save}). Os convites vivem só na
 * memória e expiram em {@link GUILD_INVITE_SECONDS} s.
 *
 * Regras (decisões do dono, 2026-11-17):
 * - criar custa {@link GUILD_CREATE_COST} moedas; manter não custa nada. Nome único (3 a 20: letras, números,
 *   espaços) e tag única de 3 letras/números (maiúsculas);
 * - uma guilda por vez; até {@link GUILD_MAX_MEMBERS} membros;
 * - cargos: líder (um), oficiais e membros. Líder e oficiais convidam; o líder expulsa qualquer um e promove/rebaixa;
 *   oficial expulsa só membro comum (nunca o líder nem outro oficial);
 * - o líder saiu → vira líder o oficial mais antigo; sem oficial, o membro mais antigo (mais antigo = entrou antes);
 * - o último a sair acaba com a guilda (o líder não desfaz com gente dentro);
 * - saiu por vontade própria → {@link GUILD_LEAVE_COOLDOWN_SECONDS} s sem poder aceitar convite (expulso não pega);
 * - membros da mesma guilda não se batem (a zona olha `guildId`, `Zone.isEnemy`) e não ganham XP a mais;
 * - **Procurar guilda** (2026-11-17): lista as guildas que não estão cheias, da mais cheia para a mais vazia; cada uma
 *   tem uma descrição breve. Quem não tem guilda pede para entrar (uma vez por guilda, em várias ao mesmo tempo); o
 *   pedido fica guardado na guilda (mesmo offline) por {@link GUILD_REQUEST_DAYS} dias e só líder/oficiais aceitam.
 *   Entrou numa guilda (por convite, pedido ou criando) → os outros pedidos dele somem.
 *
 * Separado do `GameServer` (que guarda contas e conexões) para ficar pequeno e testável sem rede.
 */

/** Um membro como fica guardado. */
export interface GuildMemberRecord {
  readonly id: string;
  /** Username (não muda; guardado para a lista mostrar quem está offline sem ir ao banco). */
  readonly name: string;
  readonly role: GuildRole;
  /** Quando entrou (ms de `Date.now()`): decide quem é "o mais antigo". */
  readonly joinedAt: number;
}

/** Um pedido para entrar guardado na guilda. */
export interface GuildRequestRecord {
  readonly id: string;
  readonly name: string;
  /** Quando pediu (ms de `Date.now()`). */
  readonly at: number;
}

/** Uma guilda como fica guardada (coleção `guilds`). */
export interface GuildRecord {
  readonly id: string;
  readonly name: string;
  /** 3 letras/números, maiúsculas. */
  readonly tag: string;
  /** Descrição breve (até {@link GUILD_DESCRIPTION_MAX} caracteres; vazia = sem descrição). */
  readonly description: string;
  readonly createdAt: number;
  readonly members: readonly GuildMemberRecord[];
  /** Pedidos para entrar esperando líder/oficial. */
  readonly requests: readonly GuildRequestRecord[];
}

/** Milissegundos que um pedido para entrar espera. */
export const GUILD_REQUEST_MS: number = GUILD_REQUEST_DAYS * 86_400_000;

/** Descrição arrumada (uma linha, sem espaços repetidos), ou `null` se passar de {@link GUILD_DESCRIPTION_MAX}. */
export function normalizeGuildDescription(raw: string): string | null {
  const text: string = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return text.length > GUILD_DESCRIPTION_MAX ? null : text;
}

/** O que o servidor oferece às guildas. */
export interface GuildHost {
  /** Manda `message` ao jogador (offline/fake: nada). */
  send(playerId: string, message: ServerMessage): void;
  /** Nome de quem está online (em qualquer zona) ou é fake de teste; senão `undefined`. */
  nameOf(playerId: string): string | undefined;
  /** Nível de quem está numa zona agora; `null` = offline. */
  levelOf(playerId: string): number | null;
  /** Resposta automática a convite de guilda (fake de teste; `reject` para quem oculta convites), ou `null`. */
  autoAnswer(playerId: string): "accept" | "reject" | null;
  /** Tira `amount` moedas de quem está numa zona; `false` = não tem (ou não está numa zona). */
  spendGold(playerId: string, amount: number): boolean;
  /** Quando saiu por vontade própria da última guilda (ms), ou `null`. */
  leftAt(playerId: string): number | null;
  /** Guarda (memória + banco) quando saiu por vontade própria. */
  setLeftAt(playerId: string, atMs: number): void;
  /** Grava a guilda no banco (sem esperar). */
  save(guild: GuildRecord): void;
  /** Apaga a guilda do banco (acabou; sem esperar). */
  remove(guildId: string): void;
  /** A guilda do jogador mudou (tag no nome e cor nas zonas): `null` = saiu. */
  onMemberGuild(playerId: string, guild: { readonly id: string; readonly tag: string } | null): void;
}

/** Motivo de recusa (o `GameServer` traduz para o código de erro do protocolo). */
export type GuildFailure =
  | "invalid_guild"
  | "guild_name_taken"
  | "guild_tag_taken"
  | "already_in_guild"
  | "not_in_guild"
  | "guild_no_permission"
  | "guild_full"
  | "guild_invite_not_found"
  | "guild_cooldown"
  | "not_enough_gold"
  | "player_not_found"
  | "invalid_invite";

/** Resultado de um pedido; recusado = `error` só para quem pediu, com `message` pronta. */
export type GuildResult = { readonly ok: true } | { readonly ok: false; readonly reason: GuildFailure; readonly message: string };

const OK: GuildResult = { ok: true };
const refuse = (reason: GuildFailure, message: string): GuildResult => ({ ok: false, reason, message });

/** Tamanho do nome da guilda (letras). */
export const GUILD_NAME_MIN = 3;
export const GUILD_NAME_MAX = 20;
/** Nome: letras (com acento), números e espaços. */
const NAME_PATTERN: RegExp = /^[\p{L}\p{N} ]+$/u;
/** Tag: exatamente 3 letras (sem acento) ou números. */
const TAG_PATTERN: RegExp = /^[A-Za-z0-9]{3}$/;

/** Nome arrumado (sem espaços nas pontas nem repetidos), ou `null` se fora das regras. */
export function normalizeGuildName(raw: string): string | null {
  const name: string = raw.trim().replace(/\s+/g, " ");
  if (name.length < GUILD_NAME_MIN || name.length > GUILD_NAME_MAX || !NAME_PATTERN.test(name)) return null;
  return name;
}

/** Tag em maiúsculas, ou `null` se não tiver exatamente 3 letras/números. */
export function normalizeGuildTag(raw: string): string | null {
  const tag: string = raw.trim();
  return TAG_PATTERN.test(tag) ? tag.toUpperCase() : null;
}

/** Chave para comparar nomes sem ligar para maiúsculas/acentos ("Ordem" = "ordem" = "Ordém"). */
export function guildNameKey(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Ordem da lista: líder, oficiais, membros; dentro de cada cargo, do mais antigo ao mais novo. */
const ROLE_ORDER: Readonly<Record<GuildRole, number>> = { leader: 0, officer: 1, member: 2 };

/** Lê uma guilda guardada no banco; formato estranho = `null` (fica de fora). */
export function readGuildRecord(raw: unknown): GuildRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id: unknown = Reflect.get(raw, "id");
  const name: unknown = Reflect.get(raw, "name");
  const tag: unknown = Reflect.get(raw, "tag");
  const createdAt: unknown = Reflect.get(raw, "createdAt");
  const members: unknown = Reflect.get(raw, "members");
  if (typeof id !== "string" || typeof name !== "string" || typeof tag !== "string" || typeof createdAt !== "number") return null;
  if (!Array.isArray(members)) return null;
  const list: GuildMemberRecord[] = [];
  for (const entry of members) {
    if (typeof entry !== "object" || entry === null) continue;
    const memberId: unknown = Reflect.get(entry, "id");
    const memberName: unknown = Reflect.get(entry, "name");
    const role: unknown = Reflect.get(entry, "role");
    const joinedAt: unknown = Reflect.get(entry, "joinedAt");
    if (typeof memberId !== "string" || typeof memberName !== "string" || typeof joinedAt !== "number") continue;
    if (role !== "leader" && role !== "officer" && role !== "member") continue;
    list.push({ id: memberId, name: memberName, role, joinedAt });
  }
  if (list.length === 0) return null;
  const description: unknown = Reflect.get(raw, "description");
  const rawRequests: unknown = Reflect.get(raw, "requests");
  const requests: GuildRequestRecord[] = [];
  if (Array.isArray(rawRequests)) {
    for (const entry of rawRequests) {
      if (typeof entry !== "object" || entry === null) continue;
      const requestId: unknown = Reflect.get(entry, "id");
      const requestName: unknown = Reflect.get(entry, "name");
      const at: unknown = Reflect.get(entry, "at");
      if (typeof requestId === "string" && typeof requestName === "string" && typeof at === "number") requests.push({ id: requestId, name: requestName, at });
    }
  }
  return { id, name, tag, description: typeof description === "string" ? description : "", createdAt, members: list, requests };
}

/** Milissegundos que um convite espera resposta. */
export const GUILD_INVITE_MS: number = GUILD_INVITE_SECONDS * 1000;
/** Milissegundos da espera depois de sair. */
export const GUILD_LEAVE_COOLDOWN_MS: number = GUILD_LEAVE_COOLDOWN_SECONDS * 1000;

/** Convite pendente: de qual guilda e quando expira (ms). */
interface PendingInvite {
  readonly guildId: string;
  readonly expiresAt: number;
}

/** Todas as guildas do servidor (guilda vale entre zonas). */
export class Guilds {
  private readonly guilds: Map<string, GuildRecord> = new Map();
  /** Jogador → id da guilda dele. */
  private readonly memberOf: Map<string, string> = new Map();
  /** Convites pendentes: quem recebeu → (quem convidou → convite). */
  private readonly pending: Map<string, Map<string, PendingInvite>> = new Map();

  constructor(private readonly host: GuildHost) {}

  /** Põe na memória as guildas lidas do banco (ao ligar o servidor). Membro repetido fica só na primeira. */
  load(records: readonly GuildRecord[]): void {
    for (const record of records) {
      const members: GuildMemberRecord[] = record.members.filter((m) => !this.memberOf.has(m.id));
      if (members.length === 0) continue;
      const fixed: GuildRecord = Guilds.withLeader({ ...record, members });
      this.guilds.set(fixed.id, fixed);
      for (const member of fixed.members) this.memberOf.set(member.id, fixed.id);
    }
  }

  /** Id e tag da guilda de [playerId], ou `null`. */
  guildOf(playerId: string): { readonly id: string; readonly tag: string } | null {
    const guild: GuildRecord | undefined = this.recordOf(playerId);
    return guild === undefined ? null : { id: guild.id, tag: guild.tag };
  }

  /** Todas as guildas (ranking de guilda, [SOC-07]). */
  all(): GuildRecord[] {
    return Array.from(this.guilds.values());
  }

  /** A guilda inteira (testes e diagnóstico). */
  get(guildId: string): GuildRecord | undefined {
    return this.guilds.get(guildId);
  }

  /** `true` se [a] e [b] estão na mesma guilda. */
  sameGuild(a: string, b: string): boolean {
    const guild: string | undefined = this.memberOf.get(a);
    return guild !== undefined && guild === this.memberOf.get(b);
  }

  /** `true` se há convite de [fromId] esperando resposta de [toId]. */
  hasInvite(toId: string, fromId: string): boolean {
    return this.pending.get(toId)?.has(fromId) ?? false;
  }

  /** Cria a guilda [rawName]/[rawTag] com [playerId] de líder (custa {@link GUILD_CREATE_COST} moedas). */
  create(playerId: string, rawName: string, rawTag: string, rawDescription: string, nowMs: number): GuildResult {
    const playerName: string | undefined = this.host.nameOf(playerId);
    if (playerName === undefined) return refuse("player_not_found", "Entre no jogo antes.");
    if (this.memberOf.has(playerId)) return refuse("already_in_guild", "Você já está numa guilda. Saia dela antes de criar outra.");
    const name: string | null = normalizeGuildName(rawName);
    if (name === null) return refuse("invalid_guild", `O nome da guilda precisa ter de ${GUILD_NAME_MIN} a ${GUILD_NAME_MAX} letras, números ou espaços.`);
    const tag: string | null = normalizeGuildTag(rawTag);
    if (tag === null) return refuse("invalid_guild", "A tag precisa ter exatamente 3 letras ou números.");
    const description: string | null = normalizeGuildDescription(rawDescription);
    if (description === null) return refuse("invalid_guild", `A descrição pode ter até ${GUILD_DESCRIPTION_MAX} caracteres.`);
    const key: string = guildNameKey(name);
    for (const guild of this.guilds.values()) {
      if (guildNameKey(guild.name) === key) return refuse("guild_name_taken", `Já existe uma guilda chamada ${guild.name}.`);
      if (guild.tag === tag) return refuse("guild_tag_taken", `A tag [${tag}] já é de outra guilda.`);
    }
    if (!this.host.spendGold(playerId, GUILD_CREATE_COST)) {
      return refuse("not_enough_gold", `Criar uma guilda custa ${GUILD_CREATE_COST} moedas.`);
    }
    const guild: GuildRecord = {
      id: randomBytes(6).toString("hex"),
      name,
      tag,
      description,
      createdAt: nowMs,
      members: [{ id: playerId, name: playerName, role: "leader", joinedAt: nowMs }],
      requests: [],
    };
    this.put(guild);
    this.dropInvitesTo(playerId);
    this.host.onMemberGuild(playerId, { id: guild.id, tag });
    this.sendGuild(playerId);
    this.notice(playerId, "created", `Guilda [${tag}] ${name} criada!`);
    return OK;
  }

  /** [fromId] (líder/oficial) convida [toId] para a guilda dele. */
  invite(fromId: string, toId: string, nowMs: number): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(fromId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    if (Guilds.roleIn(guild, fromId) === "member") return refuse("guild_no_permission", "Só o líder e os oficiais convidam.");
    const toName: string | undefined = this.host.nameOf(toId);
    if (toName === undefined) return refuse("player_not_found", "Esse jogador não está online.");
    if (toId === fromId) return refuse("invalid_invite", "Você já está na guilda.");
    if (this.memberOf.get(toId) === guild.id) return refuse("invalid_invite", `${toName} já é da sua guilda.`);
    if (this.memberOf.has(toId)) return refuse("already_in_guild", `${toName} já está em uma guilda.`);
    if (guild.members.length >= GUILD_MAX_MEMBERS) return refuse("guild_full", `A guilda está cheia (máximo ${GUILD_MAX_MEMBERS}).`);
    const wait: number = this.cooldownLeftMs(toId, nowMs);
    if (wait > 0) return refuse("guild_cooldown", `${toName} saiu de uma guilda há pouco e só pode entrar em outra em ${Guilds.minutes(wait)}.`);
    const auto: "accept" | "reject" | null = this.host.autoAnswer(toId);
    if (auto === "reject") {
      this.notice(fromId, "rejected", `${toName} recusou o convite para a guilda.`);
      return OK;
    }
    if (auto === "accept") return this.join(guild.id, toId, toName, nowMs, fromId);
    let pending: Map<string, PendingInvite> | undefined = this.pending.get(toId);
    if (pending === undefined) {
      pending = new Map();
      this.pending.set(toId, pending);
    }
    pending.set(fromId, { guildId: guild.id, expiresAt: nowMs + GUILD_INVITE_MS });
    this.host.send(toId, {
      type: ServerMessageType.GuildInvited,
      data: { fromId, fromName: this.name(fromId), guildName: guild.name, guildTag: guild.tag, expiresIn: GUILD_INVITE_SECONDS },
    });
    return OK;
  }

  /** [toId] responde ao convite de [fromId]. */
  answer(toId: string, fromId: string, accept: boolean, nowMs: number): GuildResult {
    const invite: PendingInvite | undefined = this.pending.get(toId)?.get(fromId);
    if (invite === undefined) return refuse("guild_invite_not_found", "O convite para a guilda expirou.");
    this.pending.get(toId)?.delete(fromId);
    if (this.pending.get(toId)?.size === 0) this.pending.delete(toId);
    const toName: string = this.name(toId);
    if (!accept) {
      this.notice(fromId, "rejected", `${toName} recusou o convite para a guilda.`);
      return OK;
    }
    const guild: GuildRecord | undefined = this.guilds.get(invite.guildId);
    if (guild === undefined) return refuse("guild_invite_not_found", "Essa guilda não existe mais.");
    if (this.memberOf.has(toId)) return refuse("already_in_guild", "Você já está numa guilda.");
    if (guild.members.length >= GUILD_MAX_MEMBERS) return refuse("guild_full", `A guilda está cheia (máximo ${GUILD_MAX_MEMBERS}).`);
    const wait: number = this.cooldownLeftMs(toId, nowMs);
    if (wait > 0) return refuse("guild_cooldown", `Você saiu de uma guilda há pouco. Pode entrar em outra em ${Guilds.minutes(wait)}.`);
    return this.join(guild.id, toId, toName, nowMs, fromId);
  }

  /** [playerId] sai por vontade própria: espera de 1 h para aceitar convite; líder passa; último acaba com ela. */
  leave(playerId: string, nowMs: number): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(playerId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    this.host.setLeftAt(playerId, nowMs);
    this.removeMember(guild, playerId, "left");
    return OK;
  }

  /** [byId] expulsa [targetId] (sem espera para o expulso). */
  kick(byId: string, targetId: string): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(byId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    const targetRole: GuildRole | undefined = Guilds.roleIn(guild, targetId);
    if (targetRole === undefined) return refuse("not_in_guild", "Esse jogador não é da sua guilda.");
    if (targetId === byId) return refuse("guild_no_permission", "Para sair, use \"Sair da guilda\".");
    const byRole: GuildRole | undefined = Guilds.roleIn(guild, byId);
    const allowed: boolean = byRole === "leader" || (byRole === "officer" && targetRole === "member");
    if (!allowed) return refuse("guild_no_permission", byRole === "officer" ? "Oficial só expulsa membro comum." : "Só o líder e os oficiais expulsam.");
    this.removeMember(guild, targetId, "kicked");
    return OK;
  }

  /** O líder [byId] muda o cargo de [targetId] para oficial ou membro. */
  setRole(byId: string, targetId: string, role: "officer" | "member"): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(byId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    if (Guilds.roleIn(guild, byId) !== "leader") return refuse("guild_no_permission", "Só o líder muda os cargos.");
    const current: GuildRole | undefined = Guilds.roleIn(guild, targetId);
    if (current === undefined) return refuse("not_in_guild", "Esse jogador não é da sua guilda.");
    if (current === "leader") return refuse("guild_no_permission", "O líder não muda de cargo.");
    if (current === role) return OK;
    const updated: GuildRecord = { ...guild, members: guild.members.map((m) => (m.id === targetId ? { ...m, role } : m)) };
    this.put(updated);
    const name: string = Guilds.memberName(guild, targetId);
    this.noticeAll(updated, "role", role === "officer" ? `${name} agora é oficial da guilda.` : `${name} voltou a ser membro da guilda.`);
    this.sendGuildToAll(updated);
    return OK;
  }

  /** Manda a guilda (ou `null`) a [playerId] (após entrar no servidor). */
  sendGuild(playerId: string): void {
    const guild: GuildRecord | undefined = this.recordOf(playerId);
    this.host.send(playerId, { type: ServerMessageType.Guild, data: { guild: guild === undefined ? null : this.view(guild, playerId) } });
  }

  /** Procurar guilda: as que não estão cheias, da mais cheia para a mais vazia (empate: nome), até {@link GUILD_LIST_MAX}. */
  list(): GuildSummaryView[] {
    return Array.from(this.guilds.values())
      .filter((g) => g.members.length < GUILD_MAX_MEMBERS)
      .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name, "pt-BR"))
      .slice(0, GUILD_LIST_MAX)
      .map((g) => ({ id: g.id, name: g.name, tag: g.tag, members: g.members.length }));
  }

  /**
   * Ficha da guilda [guildId] para [viewerId] (`undefined` = não existe). [totals] = soma global da XP de monstros e
   * dos jogadores mortos dos membros (vem do ranking, [SOC-07]).
   */
  info(guildId: string, viewerId: string, totals: { readonly monsterXp: number; readonly kills: number }, nowMs: number): GuildInfoView | undefined {
    const guild: GuildRecord | undefined = this.guilds.get(guildId);
    if (guild === undefined) return undefined;
    return {
      id: guild.id,
      name: guild.name,
      tag: guild.tag,
      description: guild.description,
      leaderName: guild.members.find((m) => m.role === "leader")?.name ?? "",
      members: guild.members.length,
      createdAt: guild.createdAt,
      monsterXp: totals.monsterXp,
      kills: totals.kills,
      requested: Guilds.liveRequests(guild, nowMs).some((r) => r.id === viewerId),
    };
  }

  /** [playerId] (sem guilda) pede para entrar em [guildId]; líder/oficiais online recebem o aviso. */
  request(playerId: string, guildId: string, nowMs: number): GuildResult {
    const playerName: string | undefined = this.host.nameOf(playerId);
    if (playerName === undefined) return refuse("player_not_found", "Entre no jogo antes.");
    if (this.memberOf.has(playerId)) return refuse("already_in_guild", "Você já está numa guilda.");
    const guild: GuildRecord | undefined = this.guilds.get(guildId);
    if (guild === undefined) return refuse("guild_invite_not_found", "Essa guilda não existe mais.");
    if (guild.members.length >= GUILD_MAX_MEMBERS) return refuse("guild_full", `A guilda está cheia (máximo ${GUILD_MAX_MEMBERS}).`);
    const wait: number = this.cooldownLeftMs(playerId, nowMs);
    if (wait > 0) return refuse("guild_cooldown", `Você saiu de uma guilda há pouco. Pode pedir para entrar em outra em ${Guilds.minutes(wait)}.`);
    const live: GuildRequestRecord[] = Guilds.liveRequests(guild, nowMs);
    if (live.some((r) => r.id === playerId)) return refuse("invalid_invite", "Você já pediu para entrar nessa guilda. Aguarde a resposta.");
    if (live.length >= GUILD_MAX_MEMBERS) return refuse("guild_full", "Essa guilda tem pedidos demais esperando. Tente mais tarde.");
    const updated: GuildRecord = { ...guild, requests: [...live, { id: playerId, name: playerName, at: nowMs }] };
    this.put(updated);
    this.notice(playerId, "request_sent", `Pedido enviado para [${guild.tag}] ${guild.name}.`);
    for (const member of updated.members) {
      if (member.role !== "member") this.notice(member.id, "request", `${playerName} pediu para entrar na guilda.`);
    }
    this.sendGuildToAll(updated);
    return OK;
  }

  /** Líder/oficial [byId] aceita ou recusa o pedido de [playerId] (que pode estar offline). */
  answerRequest(byId: string, playerId: string, accept: boolean, nowMs: number): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(byId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    if (Guilds.roleIn(guild, byId) === "member") return refuse("guild_no_permission", "Só o líder e os oficiais aceitam pedidos.");
    const live: GuildRequestRecord[] = Guilds.liveRequests(guild, nowMs);
    const request: GuildRequestRecord | undefined = live.find((r) => r.id === playerId);
    if (request === undefined) return refuse("guild_invite_not_found", "Esse pedido não existe mais.");
    const withoutRequest: GuildRecord = { ...guild, requests: live.filter((r) => r.id !== playerId) };
    if (!accept) {
      this.put(withoutRequest);
      this.notice(playerId, "rejected", `A guilda [${guild.tag}] ${guild.name} recusou seu pedido.`);
      this.sendGuildToAll(withoutRequest);
      return OK;
    }
    if (this.memberOf.has(playerId)) {
      this.put(withoutRequest);
      this.sendGuildToAll(withoutRequest);
      return refuse("already_in_guild", `${request.name} já entrou em outra guilda.`);
    }
    if (guild.members.length >= GUILD_MAX_MEMBERS) return refuse("guild_full", `A guilda está cheia (máximo ${GUILD_MAX_MEMBERS}).`);
    this.put(withoutRequest);
    this.notice(playerId, "accepted", `Seu pedido foi aceito: bem-vindo à guilda [${guild.tag}] ${guild.name}!`);
    return this.join(guild.id, playerId, request.name, nowMs, null);
  }

  /** O líder [byId] troca a descrição. */
  setDescription(byId: string, rawDescription: string): GuildResult {
    const guild: GuildRecord | undefined = this.recordOf(byId);
    if (guild === undefined) return refuse("not_in_guild", "Você não está numa guilda.");
    if (Guilds.roleIn(guild, byId) !== "leader") return refuse("guild_no_permission", "Só o líder muda a descrição.");
    const description: string | null = normalizeGuildDescription(rawDescription);
    if (description === null) return refuse("invalid_guild", `A descrição pode ter até ${GUILD_DESCRIPTION_MAX} caracteres.`);
    const updated: GuildRecord = { ...guild, description };
    this.put(updated);
    this.notice(byId, "description", "Descrição da guilda atualizada.");
    this.sendGuildToAll(updated);
    return OK;
  }

  /** [playerId] entrou/saiu do servidor ou subiu de nível: os membros online recebem a lista nova. */
  refreshMember(playerId: string): void {
    const guild: GuildRecord | undefined = this.recordOf(playerId);
    if (guild !== undefined) this.sendGuildToAll(guild);
  }

  /** O jogador saiu do servidor: os convites dele e para ele somem (sem aviso). */
  removePlayer(playerId: string): void {
    this.pending.delete(playerId);
    for (const [toId, pending] of this.pending) {
      pending.delete(playerId);
      if (pending.size === 0) this.pending.delete(toId);
    }
  }

  /** Convites vencidos até [nowMs] somem; quem convidou recebe `expired`. Chamar periodicamente. */
  expire(nowMs: number): void {
    for (const [toId, pending] of this.pending) {
      for (const [fromId, invite] of pending) {
        if (nowMs < invite.expiresAt) continue;
        pending.delete(fromId);
        this.notice(fromId, "expired", `${this.name(toId)} não respondeu ao convite para a guilda.`);
      }
      if (pending.size === 0) this.pending.delete(toId);
    }
  }

  /** Milissegundos que faltam da espera de [playerId] (0 = pode entrar). */
  cooldownLeftMs(playerId: string, nowMs: number): number {
    const left: number | null = this.host.leftAt(playerId);
    return left === null ? 0 : Math.max(0, left + GUILD_LEAVE_COOLDOWN_MS - nowMs);
  }

  /** A guilda como [viewerId] vê (os pedidos para entrar só para líder/oficiais). */
  view(guild: GuildRecord, viewerId: string): GuildView {
    const members: GuildMemberView[] = [...guild.members]
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joinedAt - b.joinedAt)
      .map((m) => ({ id: m.id, name: m.name, role: m.role, online: this.host.nameOf(m.id) !== undefined, level: this.host.levelOf(m.id) }));
    const canSee: boolean = Guilds.roleIn(guild, viewerId) === "leader" || Guilds.roleIn(guild, viewerId) === "officer";
    const requests: GuildRequestView[] = canSee ? guild.requests.map((r) => ({ id: r.id, name: r.name, at: r.at })) : [];
    return { id: guild.id, name: guild.name, tag: guild.tag, description: guild.description, requests, members };
  }

  // --- internos ---

  /** Põe [playerId] na guilda; [inviterId] = quem convidou (aviso "aceitou"), ou `null` = entrou por pedido aceito. */
  private join(guildId: string, playerId: string, playerName: string, nowMs: number, inviterId: string | null): GuildResult {
    const guild: GuildRecord | undefined = this.guilds.get(guildId);
    if (guild === undefined) return refuse("guild_invite_not_found", "Essa guilda não existe mais.");
    const updated: GuildRecord = {
      ...guild,
      members: [...guild.members, { id: playerId, name: playerName, role: "member", joinedAt: nowMs }],
      requests: guild.requests.filter((r) => r.id !== playerId),
    };
    this.put(updated);
    this.dropInvitesTo(playerId);
    this.host.onMemberGuild(playerId, { id: updated.id, tag: updated.tag });
    if (inviterId !== null) this.notice(inviterId, "accepted", `${playerName} aceitou o convite para a guilda.`);
    this.noticeAll(updated, "joined", `${playerName} entrou na guilda.`);
    this.sendGuildToAll(updated);
    return OK;
  }

  /** Tira [playerId] da guilda ([code] = saiu ou foi expulso): líder passa; sem ninguém, a guilda acaba. */
  private removeMember(guild: GuildRecord, playerId: string, code: "left" | "kicked"): void {
    const name: string = Guilds.memberName(guild, playerId);
    const wasLeader: boolean = Guilds.roleIn(guild, playerId) === "leader";
    const rest: GuildMemberRecord[] = guild.members.filter((m) => m.id !== playerId);
    this.memberOf.delete(playerId);
    this.host.onMemberGuild(playerId, null);
    this.host.send(playerId, { type: ServerMessageType.Guild, data: { guild: null } });
    if (rest.length === 0) {
      this.guilds.delete(guild.id);
      this.host.remove(guild.id);
      this.notice(playerId, "disbanded", `A guilda [${guild.tag}] ${guild.name} acabou.`);
      return;
    }
    this.notice(playerId, code, code === "kicked" ? `Você foi expulso da guilda [${guild.tag}] ${guild.name}.` : `Você saiu da guilda [${guild.tag}] ${guild.name}.`);
    const updated: GuildRecord = Guilds.withLeader({ ...guild, members: rest });
    this.put(updated);
    this.noticeAll(updated, code, code === "kicked" ? `${name} foi expulso da guilda.` : `${name} saiu da guilda.`);
    if (wasLeader) {
      const leader: GuildMemberRecord | undefined = updated.members.find((m) => m.role === "leader");
      if (leader !== undefined) this.noticeAll(updated, "leader", `${leader.name} agora é o líder da guilda.`);
    }
    this.sendGuildToAll(updated);
  }

  /** Garante um líder: se faltar, o oficial mais antigo; sem oficial, o membro mais antigo. */
  private static withLeader(guild: GuildRecord): GuildRecord {
    if (guild.members.some((m) => m.role === "leader")) return guild;
    const byAge = (role: GuildRole): GuildMemberRecord | undefined =>
      guild.members.filter((m) => m.role === role).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    const heir: GuildMemberRecord | undefined = byAge("officer") ?? byAge("member");
    if (heir === undefined) return guild;
    return { ...guild, members: guild.members.map((m) => (m.id === heir.id ? { ...m, role: "leader" } : m)) };
  }

  private put(guild: GuildRecord): void {
    this.guilds.set(guild.id, guild);
    for (const member of guild.members) this.memberOf.set(member.id, guild.id);
    this.host.save(guild);
  }

  private recordOf(playerId: string): GuildRecord | undefined {
    const id: string | undefined = this.memberOf.get(playerId);
    return id === undefined ? undefined : this.guilds.get(id);
  }

  /** Convites para [playerId] e os pedidos dele para entrar em outras guildas somem (ele entrou/criou uma guilda). */
  private dropInvitesTo(playerId: string): void {
    this.pending.delete(playerId);
    for (const guild of this.guilds.values()) {
      if (!guild.requests.some((r) => r.id === playerId)) continue;
      const updated: GuildRecord = { ...guild, requests: guild.requests.filter((r) => r.id !== playerId) };
      this.put(updated);
      this.sendGuildToAll(updated);
    }
  }

  /** Pedidos ainda no prazo ({@link GUILD_REQUEST_MS}). */
  private static liveRequests(guild: GuildRecord, nowMs: number): GuildRequestRecord[] {
    return guild.requests.filter((r) => nowMs - r.at < GUILD_REQUEST_MS);
  }

  private sendGuildToAll(guild: GuildRecord): void {
    for (const member of guild.members) {
      this.host.send(member.id, { type: ServerMessageType.Guild, data: { guild: this.view(guild, member.id) } });
    }
  }

  private notice(playerId: string, code: GuildNoticeCode, message: string): void {
    this.host.send(playerId, { type: ServerMessageType.GuildNotice, data: { code, message } });
  }

  private noticeAll(guild: GuildRecord, code: GuildNoticeCode, message: string): void {
    for (const member of guild.members) this.notice(member.id, code, message);
  }

  private name(playerId: string): string {
    return this.host.nameOf(playerId) ?? this.recordOf(playerId)?.members.find((m) => m.id === playerId)?.name ?? "Jogador";
  }

  private static roleIn(guild: GuildRecord, playerId: string): GuildRole | undefined {
    return guild.members.find((m) => m.id === playerId)?.role;
  }

  private static memberName(guild: GuildRecord, playerId: string): string {
    return guild.members.find((m) => m.id === playerId)?.name ?? "Jogador";
  }

  /** "12 min" (arredondado para cima; mínimo 1). */
  private static minutes(ms: number): string {
    return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
  }
}

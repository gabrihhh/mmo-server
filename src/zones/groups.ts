import {
  GROUP_INVITE_SECONDS,
  GROUP_MAX_MEMBERS,
  ServerMessageType,
  type GroupNoticeCode,
  type GroupView,
  type ServerMessage,
} from "../net/protocol.js";
import { TICK_RATE_HZ } from "../sim/movement.js";

/**
 * Grupos de jogadores de uma zona (mmo-docs [SOC-03]). Só na sessão: nada vai para o banco; sair da zona (deslogar,
 * cair) tira o jogador do grupo.
 *
 * Regras:
 * - até {@link GROUP_MAX_MEMBERS} membros, na ordem em que entraram; o **líder é o primeiro** (quem criou). Saiu o
 *   líder → o seguinte (o que entrou antes) vira líder. Sobrou 1 → o grupo acaba;
 * - quem convida sem grupo cria o grupo quando o convidado **aceitar** (grupo de 1 não existe); com grupo, só o líder
 *   convida e expulsa;
 * - o convite espera {@link GROUP_INVITE_SECONDS} s; sem resposta, expira e quem convidou recebe o aviso `expired`
 *   ("X não respondeu ao convite"). Convidado que já tem grupo: quem convidou recebe `in_group` na hora;
 * - quem responde sozinho ({@link GroupHost.autoAnswer}: jogador fake de teste e quem oculta convites de
 *   grupo) responde na hora, com o MESMO aviso de um jogador de verdade.
 *
 * A zona usa {@link sameGroup} para membros não se atingirem e {@link membersOf} para a XP do grupo ([JOGO-12]).
 * Separado do `Zone.ts` para ficar pequeno e testável; a zona dá o acesso aos jogadores por {@link GroupHost}.
 */

/** O que a zona oferece aos grupos: mandar mensagens e saber de cada jogador. */
export interface GroupHost {
  /** Manda `message` ao jogador `playerId` (fake de teste: não faz nada). */
  send(playerId: string, message: ServerMessage): void;
  /** Nome do jogador, ou `undefined` se ele não está na zona. */
  nameOf(playerId: string): string | undefined;
  /** Nível atual do jogador (vai na lista do grupo). */
  levelOf(playerId: string): number;
  /**
   * Resposta automática do jogador a um convite de grupo: `accept`/`reject` na hora, ou `null` = mostrar o convite
   * para ele decidir. Ver `Zone.groupInviteAutoAnswer` (fakes e "Convites de grupo: Ocultar" da Configuração, [SOC-04]).
   */
  autoAnswer(playerId: string): "accept" | "reject" | null;
}

/** Motivo de recusa de um pedido de grupo (mesmos nomes dos códigos de erro do protocolo). */
export type GroupFailure =
  | "player_not_found"
  | "not_group_leader"
  | "group_full"
  | "invalid_invite"
  | "invite_not_found"
  | "already_in_group"
  | "not_in_group";

/** Resultado de um pedido de grupo; recusado = `error` só para quem pediu, com `message` pronta para mostrar. */
export type GroupResult = { readonly ok: true } | { readonly ok: false; readonly reason: GroupFailure; readonly message: string };

/** Um grupo: membros na ordem em que entraram (o primeiro é o líder). */
interface Group {
  readonly members: string[];
}

/** Ticks que um convite espera resposta ({@link GROUP_INVITE_SECONDS} a {@link TICK_RATE_HZ}). */
export const GROUP_INVITE_TICKS: number = GROUP_INVITE_SECONDS * TICK_RATE_HZ;

const OK: GroupResult = { ok: true };

const refuse = (reason: GroupFailure, message: string): GroupResult => ({ ok: false, reason, message });

/** Grupos e convites pendentes de uma zona. Ver o comentário do arquivo para as regras. */
export class Groups {
  /** Grupo de cada jogador que está num. */
  private readonly groupOf: Map<string, Group> = new Map();
  /** Convites pendentes: convidado → (quem convidou → tick em que expira). */
  private readonly invites: Map<string, Map<string, number>> = new Map();

  constructor(private readonly host: GroupHost) {}

  /** Membros do grupo de `playerId` (líder primeiro), ou lista vazia se ele não está em grupo. */
  membersOf(playerId: string): readonly string[] {
    return this.groupOf.get(playerId)?.members ?? [];
  }

  /** `true` se `a` e `b` (diferentes) estão no mesmo grupo. */
  sameGroup(a: string, b: string): boolean {
    const group: Group | undefined = this.groupOf.get(a);
    return a !== b && group !== undefined && group === this.groupOf.get(b);
  }

  /** O grupo de `playerId` como vai na mensagem `group`, ou `null` sem grupo. */
  view(playerId: string): GroupView | null {
    const group: Group | undefined = this.groupOf.get(playerId);
    if (group === undefined) return null;
    return {
      leaderId: group.members[0] ?? "",
      members: group.members.map((id) => ({ id, name: this.name(id), level: this.host.levelOf(id) })),
    };
  }

  /** `true` se há convite de `fromId` esperando resposta de `toId`. */
  hasInvite(toId: string, fromId: string): boolean {
    return this.invites.get(toId)?.has(fromId) ?? false;
  }

  /**
   * `fromId` convida `toId` (no tick `tick`). Recusa: alguém fora da zona, você mesmo/quem já é do seu grupo, não
   * ser o líder, grupo cheio. Convidado com grupo: aviso `in_group` para quem convidou. Resposta automática: aceita
   * ou recusa na hora. Senão guarda o convite (convidar de novo renova o prazo) e manda `group_invited` ao convidado.
   */
  invite(fromId: string, toId: string, tick: number): GroupResult {
    const toName: string | undefined = this.host.nameOf(toId);
    if (this.host.nameOf(fromId) === undefined || toName === undefined) {
      return refuse("player_not_found", "Esse jogador não está mais por perto.");
    }
    if (fromId === toId) return refuse("invalid_invite", "Você não pode convidar a si mesmo.");
    if (this.sameGroup(fromId, toId)) return refuse("invalid_invite", `${toName} já está no seu grupo.`);
    const group: Group | undefined = this.groupOf.get(fromId);
    if (group !== undefined && group.members[0] !== fromId) return refuse("not_group_leader", "Só o líder do grupo pode convidar.");
    if (group !== undefined && group.members.length >= GROUP_MAX_MEMBERS) {
      return refuse("group_full", `O grupo está cheio (máximo ${GROUP_MAX_MEMBERS}).`);
    }
    if (this.groupOf.has(toId)) {
      this.notice(fromId, "in_group", toName, `${toName} já está em um grupo.`);
      return OK;
    }
    const auto: "accept" | "reject" | null = this.host.autoAnswer(toId);
    if (auto === "accept") return this.join(fromId, toId);
    if (auto === "reject") {
      this.notice(fromId, "rejected", toName, `${toName} recusou o convite.`);
      return OK;
    }
    let pending: Map<string, number> | undefined = this.invites.get(toId);
    if (pending === undefined) {
      pending = new Map();
      this.invites.set(toId, pending);
    }
    pending.set(fromId, tick + GROUP_INVITE_TICKS);
    this.host.send(toId, {
      type: ServerMessageType.GroupInvited,
      data: { fromId, fromName: this.name(fromId), expiresIn: GROUP_INVITE_SECONDS },
    });
    return OK;
  }

  /**
   * `toId` responde ao convite de `fromId`. Recusar: aviso `rejected` para quem convidou. Aceitar: entra no grupo de
   * quem convidou (ou cria o grupo com ele de líder). Recusa: convite inexistente/expirado, já estar em grupo, quem
   * convidou deixou de ser líder ou o grupo encheu.
   */
  answer(toId: string, fromId: string, accept: boolean): GroupResult {
    const pending: Map<string, number> | undefined = this.invites.get(toId);
    if (pending === undefined || !pending.delete(fromId)) return refuse("invite_not_found", "O convite expirou.");
    if (pending.size === 0) this.invites.delete(toId);
    if (this.host.nameOf(fromId) === undefined) return refuse("invite_not_found", "Quem convidou não está mais por perto.");
    if (!accept) {
      this.notice(fromId, "rejected", this.name(toId), `${this.name(toId)} recusou o convite.`);
      return OK;
    }
    if (this.groupOf.has(toId)) return refuse("already_in_group", "Você já está em um grupo.");
    return this.join(fromId, toId);
  }

  /** Líder `leaderId` expulsa `targetId` do grupo. */
  kick(leaderId: string, targetId: string): GroupResult {
    const group: Group | undefined = this.groupOf.get(leaderId);
    if (group === undefined) return refuse("not_in_group", "Você não está em um grupo.");
    if (group.members[0] !== leaderId) return refuse("not_group_leader", "Só o líder do grupo pode expulsar.");
    if (targetId === leaderId || !group.members.includes(targetId)) return refuse("not_in_group", "Esse jogador não está no seu grupo.");
    this.remove(targetId, "kicked");
    return OK;
  }

  /** `playerId` sai do grupo ("Sair do grupo"). */
  leave(playerId: string): GroupResult {
    if (!this.groupOf.has(playerId)) return refuse("not_in_group", "Você não está em um grupo.");
    this.remove(playerId, "left");
    return OK;
  }

  /**
   * O jogador saiu da zona (deslogou, caiu, entrou de novo): sai do grupo (como "Sair do grupo") e os convites dele
   * e para ele somem. Chamar ANTES de tirá-lo da zona (os avisos usam o nome dele).
   */
  removePlayer(playerId: string): void {
    this.invites.delete(playerId);
    for (const [toId, pending] of this.invites) {
      pending.delete(playerId);
      if (pending.size === 0) this.invites.delete(toId);
    }
    if (this.groupOf.has(playerId)) this.remove(playerId, "left");
  }

  /** Convites que venceram até `tick` somem; quem convidou recebe o aviso `expired`. Chamar a cada tick. */
  expire(tick: number): void {
    for (const [toId, pending] of this.invites) {
      for (const [fromId, expiresTick] of pending) {
        if (tick < expiresTick) continue;
        pending.delete(fromId);
        const toName: string = this.name(toId);
        this.notice(fromId, "expired", toName, `${toName} não respondeu ao convite.`);
      }
      if (pending.size === 0) this.invites.delete(toId);
    }
  }

  /** Manda a lista atualizada aos membros do grupo de `playerId` (ex.: ele subiu de nível). Sem grupo: nada. */
  refresh(playerId: string): void {
    const group: Group | undefined = this.groupOf.get(playerId);
    if (group !== undefined) this.broadcastView(group);
  }

  /** `toId` entra no grupo de `fromId` (que é criado se não existir, com `fromId` de líder). */
  private join(fromId: string, toId: string): GroupResult {
    let group: Group | undefined = this.groupOf.get(fromId);
    if (group !== undefined && group.members[0] !== fromId) return refuse("invite_not_found", "O convite não vale mais.");
    if (group !== undefined && group.members.length >= GROUP_MAX_MEMBERS) return refuse("group_full", "O grupo está cheio.");
    if (group === undefined) {
      group = { members: [fromId] };
      this.groupOf.set(fromId, group);
    }
    group.members.push(toId);
    this.groupOf.set(toId, group);
    this.invites.get(toId)?.delete(fromId);
    const toName: string = this.name(toId);
    this.notice(fromId, "accepted", toName, `${toName} aceitou o convite.`);
    this.notice(toId, "joined", toName, `Você entrou no grupo de ${this.name(fromId)}.`);
    for (const id of group.members) {
      if (id !== fromId && id !== toId) this.notice(id, "joined", toName, `${toName} entrou no grupo.`);
    }
    this.broadcastView(group);
    return OK;
  }

  /**
   * Tira `playerId` do grupo (`left` = saiu/caiu, `kicked` = expulso) e avisa: ele recebe `group: null` (e, expulso,
   * o aviso); os outros, o aviso e a lista nova. Era o líder → o seguinte vira líder. Sobrou 1 → o grupo acaba.
   */
  private remove(playerId: string, reason: "left" | "kicked"): void {
    const group: Group | undefined = this.groupOf.get(playerId);
    if (group === undefined) return;
    const wasLeader: boolean = group.members[0] === playerId;
    group.members.splice(group.members.indexOf(playerId), 1);
    this.groupOf.delete(playerId);
    const name: string = this.name(playerId);
    this.host.send(playerId, { type: ServerMessageType.Group, data: { group: null } });
    if (reason === "kicked") this.notice(playerId, "kicked", name, "Você foi expulso do grupo.");
    const what: string = reason === "kicked" ? `${name} foi expulso do grupo.` : `${name} saiu do grupo.`;
    if (group.members.length <= 1) {
      for (const id of group.members) {
        this.groupOf.delete(id);
        this.host.send(id, { type: ServerMessageType.Group, data: { group: null } });
        this.notice(id, "disbanded", name, `${what} O grupo acabou.`);
      }
      group.members.length = 0;
      return;
    }
    for (const id of group.members) this.notice(id, reason, name, what);
    const leader: string | undefined = group.members[0];
    if (wasLeader && leader !== undefined) {
      const leaderName: string = this.name(leader);
      for (const id of group.members) {
        this.notice(id, "leader", leaderName, id === leader ? "Você agora é o líder do grupo." : `${leaderName} agora é o líder do grupo.`);
      }
    }
    this.broadcastView(group);
  }

  /** Manda `group` (a lista atual) a cada membro. */
  private broadcastView(group: Group): void {
    const leader: string | undefined = group.members[0];
    if (leader === undefined) return;
    const view: GroupView | null = this.view(leader);
    for (const id of group.members) this.host.send(id, { type: ServerMessageType.Group, data: { group: view } });
  }

  private notice(playerId: string, code: GroupNoticeCode, name: string, message: string): void {
    this.host.send(playerId, { type: ServerMessageType.GroupNotice, data: { code, name, message } });
  }

  private name(playerId: string): string {
    return this.host.nameOf(playerId) ?? playerId;
  }
}

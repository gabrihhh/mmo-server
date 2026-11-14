import { FRIEND_REQUEST_SECONDS, MAX_FRIENDS, ServerMessageType, type FriendNoticeCode, type ServerMessage } from "../net/protocol.js";

/**
 * Pedidos de amizade (mmo-docs [SOC-04]). A amizade em si é guardada na conta (mútua, `Account.friends`); aqui ficam
 * só as regras do pedido e os pedidos pendentes, que vivem **só na memória** e expiram em {@link FRIEND_REQUEST_SECONDS}
 * s (como o convite de grupo): quem pede e quem recebe precisam estar online.
 *
 * Regras:
 * - pedir a si mesmo, a quem não está online, a quem já é amigo, ou repetir um pedido pendente → recusa;
 * - os dois pediram um ao outro → viram amigos na hora (o segundo pedido vale como aceite);
 * - quem responde sozinho ({@link FriendHost.autoAnswer}: jogador fake de teste e quem oculta pedidos na Configuração)
 *   responde na hora, com o MESMO aviso "X aceitou"/"X recusou" de um jogador de verdade;
 * - sem resposta no prazo: quem pediu recebe `expired` ("X não respondeu ao pedido de amizade").
 *
 * Separado do `GameServer` (que guarda as contas e as conexões) para ficar pequeno e testável sem rede.
 */

/** O que o servidor oferece aos pedidos de amizade: mandar mensagens, saber quem está online e gravar a amizade. */
export interface FriendHost {
  /** Manda `message` ao jogador (fake de teste ou offline: não faz nada). */
  send(playerId: string, message: ServerMessage): void;
  /** Nome de quem pode receber um pedido agora (jogador online em qualquer zona, ou fake de teste); senão `undefined`. */
  nameOf(playerId: string): string | undefined;
  /**
   * Resposta automática a um pedido de amizade: `accept`/`reject` na hora (fake de teste; `reject` para quem oculta
   * pedidos de amizade na Configuração), ou `null` = mostrar o pedido para ele decidir.
   */
  autoAnswer(playerId: string): "accept" | "reject" | null;
  /** `true` se `a` e `b` já são amigos. */
  areFriends(a: string, b: string): boolean;
  /** Quantos amigos o jogador tem (para o limite {@link MAX_FRIENDS}). */
  friendCount(playerId: string): number;
  /** Grava a amizade de `a` e `b` (dos dois lados) e manda as listas novas. */
  befriend(a: string, b: string): void;
}

/** Motivo de recusa de um pedido de amizade (o `GameServer` traduz para o código de erro do protocolo). */
export type FriendFailure =
  | "player_not_found"
  | "invalid_friend_request"
  | "already_friends"
  | "friend_request_pending"
  | "friend_request_not_found"
  | "friend_list_full";

/** Resultado de um pedido de amizade; recusado = `error` só para quem pediu, com `message` pronta para mostrar. */
export type FriendResult = { readonly ok: true } | { readonly ok: false; readonly reason: FriendFailure; readonly message: string };

/** Milissegundos que um pedido espera resposta. */
export const FRIEND_REQUEST_MS: number = FRIEND_REQUEST_SECONDS * 1000;

const OK: FriendResult = { ok: true };

const refuse = (reason: FriendFailure, message: string): FriendResult => ({ ok: false, reason, message });

/** Pedidos de amizade pendentes do servidor inteiro (amizade vale entre zonas). */
export class FriendRequests {
  /** Pedidos pendentes: quem recebeu → (quem pediu → quando expira, ms de `Date.now()`). */
  private readonly pending: Map<string, Map<string, number>> = new Map();

  constructor(private readonly host: FriendHost) {}

  /** `true` se há pedido de `fromId` esperando resposta de `toId`. */
  hasRequest(toId: string, fromId: string): boolean {
    return this.pending.get(toId)?.has(fromId) ?? false;
  }

  /**
   * `fromId` pede a amizade de `toId` no instante `nowMs`. Ver as regras no comentário do arquivo.
   */
  request(fromId: string, toId: string, nowMs: number): FriendResult {
    const toName: string | undefined = this.host.nameOf(toId);
    if (this.host.nameOf(fromId) === undefined || toName === undefined) {
      return refuse("player_not_found", "Esse jogador não está online.");
    }
    if (fromId === toId) return refuse("invalid_friend_request", "Você não pode pedir amizade a si mesmo.");
    if (this.host.areFriends(fromId, toId)) return refuse("already_friends", `${toName} já é seu amigo.`);
    if (this.hasRequest(toId, fromId)) return refuse("friend_request_pending", `Você já pediu a amizade de ${toName}. Aguarde a resposta.`);
    if (this.host.friendCount(fromId) >= MAX_FRIENDS) return refuse("friend_list_full", `Sua lista de amigos está cheia (máximo ${MAX_FRIENDS}).`);
    // O outro já tinha pedido a minha amizade: este pedido vale como aceite.
    if (this.hasRequest(fromId, toId)) return this.answer(fromId, toId, true);
    const auto: "accept" | "reject" | null = this.host.autoAnswer(toId);
    if (auto === "reject") {
      this.notice(fromId, "rejected", toName, `${toName} recusou o pedido de amizade.`);
      return OK;
    }
    if (auto === "accept") return this.accept(fromId, toId);
    let pending: Map<string, number> | undefined = this.pending.get(toId);
    if (pending === undefined) {
      pending = new Map();
      this.pending.set(toId, pending);
    }
    pending.set(fromId, nowMs + FRIEND_REQUEST_MS);
    this.host.send(toId, {
      type: ServerMessageType.FriendRequested,
      data: { fromId, fromName: this.host.nameOf(fromId) ?? fromId, expiresIn: FRIEND_REQUEST_SECONDS },
    });
    return OK;
  }

  /**
   * `toId` responde ao pedido de `fromId`. Recusar: aviso `rejected` para quem pediu. Aceitar: viram amigos (os dois
   * recebem a lista nova; quem pediu, o aviso `accepted`; quem aceitou, `added`).
   */
  answer(toId: string, fromId: string, accept: boolean): FriendResult {
    const pending: Map<string, number> | undefined = this.pending.get(toId);
    if (pending === undefined || !pending.delete(fromId)) return refuse("friend_request_not_found", "O pedido de amizade expirou.");
    if (pending.size === 0) this.pending.delete(toId);
    const fromName: string | undefined = this.host.nameOf(fromId);
    if (fromName === undefined) return refuse("friend_request_not_found", "Quem pediu não está mais online.");
    if (!accept) {
      this.notice(fromId, "rejected", this.name(toId), `${this.name(toId)} recusou o pedido de amizade.`);
      return OK;
    }
    if (this.host.areFriends(fromId, toId)) return OK;
    return this.accept(fromId, toId);
  }

  /** O jogador saiu do servidor: os pedidos dele e para ele somem (sem aviso). */
  removePlayer(playerId: string): void {
    this.pending.delete(playerId);
    for (const [toId, pending] of this.pending) {
      pending.delete(playerId);
      if (pending.size === 0) this.pending.delete(toId);
    }
  }

  /** Pedidos vencidos até `nowMs` somem; quem pediu recebe o aviso `expired`. Chamar periodicamente (a cada tick). */
  expire(nowMs: number): void {
    for (const [toId, pending] of this.pending) {
      for (const [fromId, expiresAt] of pending) {
        if (nowMs < expiresAt) continue;
        pending.delete(fromId);
        const toName: string = this.name(toId);
        this.notice(fromId, "expired", toName, `${toName} não respondeu ao pedido de amizade.`);
      }
      if (pending.size === 0) this.pending.delete(toId);
    }
  }

  /** `toId` aceitou o pedido de `fromId`: grava e avisa os dois. */
  private accept(fromId: string, toId: string): FriendResult {
    if (this.host.friendCount(fromId) >= MAX_FRIENDS || this.host.friendCount(toId) >= MAX_FRIENDS) {
      return refuse("friend_list_full", `A lista de amigos está cheia (máximo ${MAX_FRIENDS}).`);
    }
    this.pending.get(toId)?.delete(fromId);
    this.pending.get(fromId)?.delete(toId);
    this.host.befriend(fromId, toId);
    const toName: string = this.name(toId);
    const fromName: string = this.name(fromId);
    this.notice(fromId, "accepted", toName, `${toName} aceitou o pedido de amizade.`);
    this.notice(toId, "added", fromName, `Agora você e ${fromName} são amigos.`);
    return OK;
  }

  private notice(playerId: string, code: FriendNoticeCode, name: string, message: string): void {
    this.host.send(playerId, { type: ServerMessageType.FriendNotice, data: { code, name, message } });
  }

  private name(playerId: string): string {
    return this.host.nameOf(playerId) ?? playerId;
  }
}

/**
 * Lê a lista de amigos guardada no banco (ids de jogador): ausente (conta antiga) ou estragada vira `[]`; ignora
 * entradas que não são texto e repetidas; no máximo {@link MAX_FRIENDS}.
 */
export function readFriendIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && value.length > 0 && value.length <= 64 && !ids.includes(value)) ids.push(value);
  }
  return ids.slice(0, MAX_FRIENDS);
}

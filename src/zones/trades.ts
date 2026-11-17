import {
  ServerMessageType,
  TRADE_CONFIRM_DELAY_SECONDS,
  TRADE_COUNTDOWN_SECONDS,
  TRADE_RANGE,
  TRADE_REQUEST_SECONDS,
  type ItemView,
  type ServerMessage,
  type TradeNoticeCode,
  type TradeOfferView,
  type TradeStateData,
} from "../net/protocol.js";
import { BAG_CAPACITY, type ItemStack } from "../items/inventory.js";
import { itemView } from "../items/view.js";
import { TICK_RATE_HZ } from "../sim/movement.js";

/**
 * Troca entre jogadores de uma zona (mmo-docs [SOC-05]). Só na sessão: a troca em andamento não vai para o banco; o
 * que vai é o resultado (as duas mochilas e as moedas), aplicado pela zona por {@link TradeHost.apply}.
 *
 * Regras:
 * - pedir/aceitar só a até {@link TRADE_RANGE} m; uma troca por vez por jogador. O pedido espera
 *   {@link TRADE_REQUEST_SECONDS} s (como o convite de grupo); quem responde sozinho ({@link TradeHost.autoAnswer}:
 *   fake de teste e "Pedidos de troca: Ocultar") responde na hora, com o mesmo aviso de um jogador de verdade;
 * - cada lado oferece itens da MOCHILA (vestido não entra) e moedas. Qualquer mudança em qualquer oferta (ou no item
 *   oferecido: melhorado, fundido, vestido, sumiu) zera a confirmação dos dois, para a contagem e recomeça os
 *   {@link TRADE_CONFIRM_DELAY_SECONDS} s;
 * - não deixa confirmar se os itens não cabem na mochila de quem recebe (já descontando o que ele entrega);
 * - os dois confirmados → contagem de {@link TRADE_COUNTDOWN_SECONDS} s → valida tudo de novo e aplica as duas contas
 *   de uma vez (as duas mudam ou nenhuma muda);
 * - cancela sozinha: passou de {@link TRADE_RANGE} m, alguém levou dano (morrer inclui), saiu da zona, fechou a janela.
 *
 * Separado do `Zone.ts` (como `groups.ts`) para ficar pequeno e testável; a zona dá o acesso por {@link TradeHost}.
 */

/** O que a zona oferece à troca. */
export interface TradeHost {
  /** Manda `message` ao jogador (fake de teste: não faz nada). */
  send(playerId: string, message: ServerMessage): void;
  /** Nome do jogador, ou `undefined` se ele não está na zona. */
  nameOf(playerId: string): string | undefined;
  /** Distância (m, no chão) entre os dois, ou `undefined` se algum não está na zona. */
  distance(a: string, b: string): number | undefined;
  /** Mochila atual do jogador (fake: a mochila de mentira dele). */
  bagOf(playerId: string): readonly ItemStack[];
  /** Moedas atuais do jogador. */
  goldOf(playerId: string): number;
  /** Resposta automática a um pedido de troca (`accept`/`reject`), ou `null` = mostrar a janela para ele decidir. */
  autoAnswer(playerId: string): "accept" | "reject" | null;
  /** `true` = confirma sozinho assim que pode (fake "Aceita", para testar sem segundo aparelho). */
  autoConfirms(playerId: string): boolean;
  /** Aplica o resultado: mochila e moedas novas de cada um (chamado uma vez, com os dois lados já validados). */
  apply(changes: readonly TradeChange[]): void;
}

/** Resultado de uma troca para um dos lados. */
export interface TradeChange {
  readonly playerId: string;
  readonly bag: readonly ItemStack[];
  readonly gold: number;
}

/** Motivo de recusa de um pedido de troca (mesmos nomes dos códigos de erro do protocolo). */
export type TradeFailure = "player_not_found" | "invalid_trade" | "trade_too_far" | "trade_busy" | "trade_request_not_found" | "not_in_trade" | "trade_not_ready";

/** Resultado de um pedido; recusado = `error` só para quem pediu, com `message` pronta para mostrar. */
export type TradeResult = { readonly ok: true } | { readonly ok: false; readonly reason: TradeFailure; readonly message: string };

/** Oferta de um lado: os `uid` (na ordem em que vieram) e as moedas. */
interface Offer {
  uids: readonly string[];
  gold: number;
  /** Os itens oferecidos como estavam ao oferecer (JSON): mudou (melhoria, fusão) → conta como mudança na oferta. */
  stamp: string;
}

/** Uma troca aberta entre `a` (quem pediu) e `b`. */
interface Trade {
  readonly a: string;
  readonly b: string;
  readonly offers: Map<string, Offer>;
  readonly confirmed: Set<string>;
  /** Tick da última mudança em qualquer oferta (confirmar só {@link TRADE_CONFIRM_DELAY_TICKS} depois). */
  lastChangeTick: number;
  /** Tick em que a contagem acaba (a troca acontece), ou `null` sem contagem. */
  countdownEndTick: number | null;
}

/** Ticks que um pedido espera. */
export const TRADE_REQUEST_TICKS: number = TRADE_REQUEST_SECONDS * TICK_RATE_HZ;
/** Ticks depois da última mudança até poder confirmar. */
export const TRADE_CONFIRM_DELAY_TICKS: number = TRADE_CONFIRM_DELAY_SECONDS * TICK_RATE_HZ;
/** Ticks da contagem final. */
export const TRADE_COUNTDOWN_TICKS: number = TRADE_COUNTDOWN_SECONDS * TICK_RATE_HZ;

const OK: TradeResult = { ok: true };

const refuse = (reason: TradeFailure, message: string): TradeResult => ({ ok: false, reason, message });

const EMPTY_OFFER = (): Offer => ({ uids: [], gold: 0, stamp: "[]" });

/** Trocas e pedidos de troca de uma zona. Ver o comentário do arquivo para as regras. */
export class Trades {
  /** Pedidos pendentes: pedido a → (quem pediu → tick em que expira). */
  private readonly requests: Map<string, Map<string, number>> = new Map();
  /** Troca aberta de cada jogador que está numa. */
  private readonly tradeOf: Map<string, Trade> = new Map();
  private currentTick: number = 0;

  constructor(private readonly host: TradeHost) {}

  /** `true` se o jogador está numa troca aberta. */
  inTrade(playerId: string): boolean {
    return this.tradeOf.has(playerId);
  }

  /** `true` se há pedido de `fromId` esperando resposta de `toId`. */
  hasRequest(toId: string, fromId: string): boolean {
    return this.requests.get(toId)?.has(fromId) ?? false;
  }

  /**
   * `fromId` pede para trocar com `toId`. Recusa: alguém fora da zona, você mesmo, longe, você já trocando. O outro
   * trocando: aviso `busy`. Resposta automática: abre a troca ou avisa `rejected` na hora. Senão guarda o pedido
   * (pedir de novo renova o prazo) e manda `trade_requested`.
   */
  request(fromId: string, toId: string, tick: number): TradeResult {
    this.currentTick = tick;
    const toName: string | undefined = this.host.nameOf(toId);
    if (this.host.nameOf(fromId) === undefined || toName === undefined) return refuse("player_not_found", "Esse jogador não está mais por perto.");
    if (fromId === toId) return refuse("invalid_trade", "Você não pode trocar com você mesmo.");
    if (this.tradeOf.has(fromId)) return refuse("trade_busy", "Você já está numa troca.");
    if (!this.near(fromId, toId)) return refuse("trade_too_far", `Chegue mais perto de ${toName} (até ${TRADE_RANGE} m) para trocar.`);
    if (this.tradeOf.has(toId)) {
      this.notice(fromId, "busy", toName, `${toName} já está numa troca.`);
      return OK;
    }
    const auto: "accept" | "reject" | null = this.host.autoAnswer(toId);
    if (auto === "accept") {
      this.open(fromId, toId);
      return OK;
    }
    if (auto === "reject") {
      this.notice(fromId, "rejected", toName, `${toName} recusou a troca.`);
      return OK;
    }
    let pending: Map<string, number> | undefined = this.requests.get(toId);
    if (pending === undefined) {
      pending = new Map();
      this.requests.set(toId, pending);
    }
    pending.set(fromId, tick + TRADE_REQUEST_TICKS);
    this.host.send(toId, { type: ServerMessageType.TradeRequested, data: { fromId, fromName: this.name(fromId), expiresIn: TRADE_REQUEST_SECONDS } });
    return OK;
  }

  /** `toId` responde ao pedido de `fromId`. Aceitar abre a troca (confere de novo distância e se alguém já está trocando). */
  answer(toId: string, fromId: string, accept: boolean, tick: number): TradeResult {
    this.currentTick = tick;
    const pending: Map<string, number> | undefined = this.requests.get(toId);
    if (pending === undefined || !pending.delete(fromId)) return refuse("trade_request_not_found", "O pedido de troca expirou.");
    if (pending.size === 0) this.requests.delete(toId);
    const fromName: string | undefined = this.host.nameOf(fromId);
    if (fromName === undefined) return refuse("trade_request_not_found", "Quem pediu não está mais por perto.");
    if (!accept) {
      this.notice(fromId, "rejected", this.name(toId), `${this.name(toId)} recusou a troca.`);
      return OK;
    }
    if (this.tradeOf.has(toId)) return refuse("trade_busy", "Você já está numa troca.");
    if (this.tradeOf.has(fromId)) return refuse("trade_busy", `${fromName} já está numa troca.`);
    if (!this.near(fromId, toId)) return refuse("trade_too_far", `Chegue mais perto de ${fromName} (até ${TRADE_RANGE} m) para trocar.`);
    this.open(fromId, toId);
    return OK;
  }

  /**
   * `playerId` troca a oferta dele inteira: itens da mochila (`uids`, sem repetir) e moedas (até o que tem). Zera as
   * confirmações dos dois e recomeça a espera para confirmar.
   */
  offer(playerId: string, uids: readonly string[], gold: number, tick: number): TradeResult {
    this.currentTick = tick;
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    if (trade === undefined) return refuse("not_in_trade", "Você não está numa troca.");
    const bag: readonly ItemStack[] = this.host.bagOf(playerId);
    if (new Set(uids).size !== uids.length) return refuse("invalid_trade", "Item repetido na oferta.");
    for (const uid of uids) {
      if (!bag.some((stack) => stack.uid === uid)) return refuse("invalid_trade", "Esse item não está mais na sua mochila.");
    }
    if (!Number.isSafeInteger(gold) || gold < 0) return refuse("invalid_trade", "Quantidade de moedas inválida.");
    if (gold > this.host.goldOf(playerId)) return refuse("invalid_trade", "Você não tem essas moedas.");
    trade.offers.set(playerId, { uids: [...uids], gold, stamp: Trades.stampOf(bag, uids) });
    this.changed(trade);
    return OK;
  }

  /**
   * `playerId` confirma a troca como está. Recusa antes da espera depois da última mudança ou se alguma mochila não
   * tem espaço. Os dois confirmados → começa a contagem.
   */
  confirm(playerId: string, tick: number): TradeResult {
    this.currentTick = tick;
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    if (trade === undefined) return refuse("not_in_trade", "Você não está numa troca.");
    if (tick < trade.lastChangeTick + TRADE_CONFIRM_DELAY_TICKS) return refuse("trade_not_ready", "Espere um pouco: a troca acabou de mudar.");
    const problem: string | null = this.problemOf(trade);
    if (problem !== null) return refuse("trade_not_ready", problem);
    this.markConfirmed(trade, playerId);
    return OK;
  }

  /** `playerId` fechou a janela: a troca acaba para os dois (o outro recebe `cancelled`). */
  cancel(playerId: string, tick: number): TradeResult {
    this.currentTick = tick;
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    if (trade === undefined) return refuse("not_in_trade", "Você não está numa troca.");
    const name: string = this.name(playerId);
    this.close(trade, "cancelled", (viewer) => (viewer === playerId ? "Você cancelou a troca." : `${name} cancelou a troca.`));
    return OK;
  }

  /** O jogador levou dano (morrer inclui): a troca dele acaba. */
  damaged(playerId: string): void {
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    if (trade === undefined) return;
    const name: string = this.name(playerId);
    this.close(trade, "damaged", (viewer) => (viewer === playerId ? "Troca cancelada: você levou dano." : `Troca cancelada: ${name} levou dano.`));
  }

  /**
   * A mochila ou as moedas do jogador mudaram por outro caminho (vestiu, melhorou, fundiu, pegou do baú, gastou): itens
   * oferecidos que sumiram saem da oferta, moedas a mais baixam para o que ele tem; se a oferta mudou (ou um item
   * oferecido mudou), conta como mudança (zera as confirmações).
   */
  belongingsChanged(playerId: string, tick: number): void {
    this.currentTick = tick;
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    const offer: Offer | undefined = trade?.offers.get(playerId);
    if (trade === undefined || offer === undefined) return;
    const bag: readonly ItemStack[] = this.host.bagOf(playerId);
    const uids: string[] = offer.uids.filter((uid) => bag.some((stack) => stack.uid === uid));
    const gold: number = Math.min(offer.gold, this.host.goldOf(playerId));
    const stamp: string = Trades.stampOf(bag, uids);
    if (uids.length === offer.uids.length && gold === offer.gold && stamp === offer.stamp) return;
    trade.offers.set(playerId, { uids, gold, stamp });
    this.changed(trade);
  }

  /** O jogador saiu da zona: os pedidos dele e para ele somem, e a troca dele acaba (o outro recebe `left`). */
  removePlayer(playerId: string): void {
    this.requests.delete(playerId);
    for (const [toId, pending] of this.requests) {
      pending.delete(playerId);
      if (pending.size === 0) this.requests.delete(toId);
    }
    const trade: Trade | undefined = this.tradeOf.get(playerId);
    if (trade === undefined) return;
    const name: string = this.name(playerId);
    this.close(trade, "left", () => `Troca cancelada: ${name} saiu.`);
  }

  /**
   * A cada tick: pedidos vencidos somem (quem pediu recebe `expired`); trocas com os dois longe demais acabam
   * (`too_far`); o fake que confirma sozinho confirma quando pode; contagem que acabou → a troca acontece.
   */
  tick(tick: number): void {
    this.currentTick = tick;
    for (const [toId, pending] of this.requests) {
      for (const [fromId, expiresTick] of pending) {
        if (tick < expiresTick) continue;
        pending.delete(fromId);
        const toName: string = this.name(toId);
        this.notice(fromId, "expired", toName, `${toName} não respondeu ao pedido de troca.`);
      }
      if (pending.size === 0) this.requests.delete(toId);
    }
    for (const trade of new Set(this.tradeOf.values())) {
      if (!this.near(trade.a, trade.b)) {
        this.close(trade, "too_far", () => `Troca cancelada: vocês se afastaram (mais de ${TRADE_RANGE} m).`);
        continue;
      }
      if (trade.countdownEndTick === null && tick >= trade.lastChangeTick + TRADE_CONFIRM_DELAY_TICKS && this.problemOf(trade) === null) {
        for (const id of [trade.a, trade.b]) {
          if (!trade.confirmed.has(id) && this.host.autoConfirms(id)) this.markConfirmed(trade, id);
        }
      }
      if (trade.countdownEndTick !== null && tick >= trade.countdownEndTick) this.finish(trade);
    }
  }

  /** Abre a troca entre `a` (quem pediu) e `b`; os pedidos entre os dois somem. */
  private open(a: string, b: string): void {
    this.requests.get(a)?.delete(b);
    this.requests.get(b)?.delete(a);
    const trade: Trade = {
      a,
      b,
      offers: new Map([
        [a, EMPTY_OFFER()],
        [b, EMPTY_OFFER()],
      ]),
      confirmed: new Set(),
      lastChangeTick: this.currentTick,
      countdownEndTick: null,
    };
    this.tradeOf.set(a, trade);
    this.tradeOf.set(b, trade);
    this.broadcastState(trade);
  }

  /** Uma oferta mudou: ninguém confirmado, sem contagem, a espera recomeça; manda o estado aos dois. */
  private changed(trade: Trade): void {
    trade.confirmed.clear();
    trade.countdownEndTick = null;
    trade.lastChangeTick = this.currentTick;
    this.broadcastState(trade);
  }

  private markConfirmed(trade: Trade, playerId: string): void {
    trade.confirmed.add(playerId);
    if (trade.confirmed.has(trade.a) && trade.confirmed.has(trade.b) && trade.countdownEndTick === null) {
      trade.countdownEndTick = this.currentTick + TRADE_COUNTDOWN_TICKS;
    }
    this.broadcastState(trade);
  }

  /**
   * Fim da contagem: confere tudo de novo (itens ainda na mochila, moedas, espaço) e aplica os dois lados de uma vez.
   * Algo não bate → a troca acaba com `failed` e nada muda.
   */
  private finish(trade: Trade): void {
    const changes: TradeChange[] = [];
    for (const [self, other] of [
      [trade.a, trade.b],
      [trade.b, trade.a],
    ] as const) {
      const mine: Offer = trade.offers.get(self) ?? EMPTY_OFFER();
      const theirs: Offer = trade.offers.get(other) ?? EMPTY_OFFER();
      const bag: readonly ItemStack[] = this.host.bagOf(self);
      const otherBag: readonly ItemStack[] = this.host.bagOf(other);
      const given: ItemStack[] = Trades.pick(bag, mine.uids);
      const received: ItemStack[] = Trades.pick(otherBag, theirs.uids);
      const gold: number = this.host.goldOf(self);
      const valid: boolean =
        given.length === mine.uids.length &&
        received.length === theirs.uids.length &&
        Trades.stampOf(bag, mine.uids) === mine.stamp &&
        gold >= mine.gold &&
        this.host.goldOf(other) >= theirs.gold &&
        bag.length - given.length + received.length <= BAG_CAPACITY;
      if (!valid) {
        this.close(trade, "failed", () => "A troca não aconteceu: algo mudou nas ofertas.");
        return;
      }
      const givenUids: Set<string> = new Set(mine.uids);
      changes.push({ playerId: self, bag: [...bag.filter((stack) => !givenUids.has(stack.uid)), ...received], gold: gold - mine.gold + theirs.gold });
    }
    this.tradeOf.delete(trade.a);
    this.tradeOf.delete(trade.b);
    this.host.apply(changes);
    this.host.send(trade.a, { type: ServerMessageType.TradeDone, data: { partnerName: this.name(trade.b) } });
    this.host.send(trade.b, { type: ServerMessageType.TradeDone, data: { partnerName: this.name(trade.a) } });
  }

  /** Acaba a troca sem trocar nada; cada um recebe o aviso `code` com o texto `messageFor(ele)`. */
  private close(trade: Trade, code: TradeNoticeCode, messageFor: (viewer: string) => string): void {
    this.tradeOf.delete(trade.a);
    this.tradeOf.delete(trade.b);
    this.notice(trade.a, code, this.name(trade.b), messageFor(trade.a));
    this.notice(trade.b, code, this.name(trade.a), messageFor(trade.b));
  }

  /** Por que não dá para confirmar (alguma mochila sem espaço para o que recebe), ou `null`. */
  private problemOf(trade: Trade): string | null {
    for (const [self, other] of [
      [trade.a, trade.b],
      [trade.b, trade.a],
    ] as const) {
      const gives: number = trade.offers.get(self)?.uids.length ?? 0;
      const gets: number = trade.offers.get(other)?.uids.length ?? 0;
      if (this.host.bagOf(self).length - gives + gets > BAG_CAPACITY) return `A mochila de ${this.name(self)} não tem espaço.`;
    }
    return null;
  }

  /** Manda `trade_state` aos dois (cada um vê a sua oferta como `mine`). */
  private broadcastState(trade: Trade): void {
    const problem: string | null = this.problemOf(trade);
    const confirmIn: number = Math.max(0, (trade.lastChangeTick + TRADE_CONFIRM_DELAY_TICKS - this.currentTick) / TICK_RATE_HZ);
    const countdown: number | null = trade.countdownEndTick === null ? null : Math.max(0, (trade.countdownEndTick - this.currentTick) / TICK_RATE_HZ);
    for (const [self, other] of [
      [trade.a, trade.b],
      [trade.b, trade.a],
    ] as const) {
      const data: TradeStateData = {
        partnerId: other,
        partnerName: this.name(other),
        mine: this.offerView(self, trade),
        theirs: this.offerView(other, trade),
        myConfirmed: trade.confirmed.has(self),
        theirConfirmed: trade.confirmed.has(other),
        confirmIn,
        countdown,
        problem,
      };
      this.host.send(self, { type: ServerMessageType.TradeState, data });
    }
  }

  private offerView(playerId: string, trade: Trade): TradeOfferView {
    const offer: Offer = trade.offers.get(playerId) ?? EMPTY_OFFER();
    const items: ItemView[] = [];
    for (const stack of Trades.pick(this.host.bagOf(playerId), offer.uids)) {
      const view: ItemView | null = itemView(stack);
      if (view !== null) items.push(view);
    }
    return { items, gold: offer.gold };
  }

  private near(a: string, b: string): boolean {
    const distance: number | undefined = this.host.distance(a, b);
    return distance !== undefined && distance <= TRADE_RANGE;
  }

  private notice(playerId: string, code: TradeNoticeCode, name: string, message: string): void {
    this.host.send(playerId, { type: ServerMessageType.TradeNotice, data: { code, name, message } });
  }

  private name(playerId: string): string {
    return this.host.nameOf(playerId) ?? playerId;
  }

  /** Os itens `uids` da mochila, na ordem de `uids` (os que não estão nela ficam de fora). */
  private static pick(bag: readonly ItemStack[], uids: readonly string[]): ItemStack[] {
    const picked: ItemStack[] = [];
    for (const uid of uids) {
      const stack: ItemStack | undefined = bag.find((s) => s.uid === uid);
      if (stack !== undefined) picked.push(stack);
    }
    return picked;
  }

  /** Retrato dos itens oferecidos (para perceber item melhorado/fundido depois de oferecido). */
  private static stampOf(bag: readonly ItemStack[], uids: readonly string[]): string {
    return JSON.stringify(Trades.pick(bag, uids));
  }
}

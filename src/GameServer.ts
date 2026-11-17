import type { Progress } from "./progression/level.js";
import type { PlayerStats } from "./progression/stats.js";
import { RankingBoards, addToPeriods, secondsUntilReset, type PeriodCounters, type RankRow, type RankingCategory, type RankingPeriod } from "./progression/ranking.js";
import type { AttributeId } from "./items/attributes.js";
import type { UpgradeFailure } from "./items/upgrade.js";
import { buyPrice, shopItems, type ShopFailure } from "./items/shop.js";
import type { StorageFailure } from "./items/storage.js";
import { ChatLimiter, cleanChatText, type ChatCheck } from "./social/chat.js";
import { MARKET_PAGE_SIZE, MAX_LISTINGS, Market, isValidPrice, listingFee, listingStatus, type Listing, type MarketFailure } from "./items/market.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import {
  ClientMessageType,
  CloseCode,
  ErrorCode,
  PROTOCOL_VERSION,
  RANKING_REFRESH_SECONDS,
  ServerMessageType,
  encodeServerMessage,
  parseClientMessage,
  type BodyType,
  type AttributesData,
  type GuildInfoView,
  type ProfileVisibility,
  type AttributesView,
  type ClientBuild,
  type ClientMessage,
  type JoinData,
  type LoginData,
  type PlayerSnapshot,
  type PasswordResetConfirmData,
  type PasswordResetRequestData,
  type RegisterData,
  type ResumeData,
  type EquipSlotName,
  type FriendView,
  type ServerMessage,
  type SocialSettings,
  type DeathItemView,
  type ItemView,
  type ChatSendData,
  type MarketListingView,
  type MarketResultData,
  type ChatRefusedReason,
} from "./net/protocol.js";
import { FriendRequests, type FriendFailure, type FriendResult } from "./social/friends.js";
import { Zone, type CastFailure, type CastResult, type ChestFailure, type DeathInfo, type JoinResult, type NetStats, type SpawnPoint, type TakenLoot, type ZoneConfig } from "./zones/Zone.js";
import type { LootEntry } from "./items/loot.js";
import { levelXp, type FusionFailure } from "./items/fusion.js";
import { breakEquipped, rollDeathItem, type ItemRoll } from "./combat/death.js";
import { PLAYER_RESPAWN_SECONDS } from "./combat/stats.js";
import { ZONE_CONFIGS } from "./zones/zones.js";
import type { GroupFailure, GroupResult } from "./zones/groups.js";
import type { TradeFailure, TradeResult } from "./zones/trades.js";
import { Guilds, type GuildFailure, type GuildResult } from "./social/guilds.js";
import { TICK_RATE_HZ } from "./sim/movement.js";
import type { Account, AccountStore, AuthSuccess, RegisterResult, SavedPosition } from "./accounts/AccountStore.js";
import { PasswordReset, type ResetConfirmResult, type ResetRequestResult } from "./accounts/passwordReset.js";
import { LogMailer, type Mailer } from "./mail/mailer.js";
import { EQUIP_SLOTS, getItem, type EquipSlot } from "./items/catalog.js";
import { isValidEmail, isValidPassword, isValidUsername } from "./accounts/credentials.js";
import { DEFAULT_UPDATES_DIR, UPDATES_ROUTE, serveUpdateFile } from "./http/updates.js";
import { DEFAULT_UPDATE_POLL_MS, UpdateWatcher } from "./http/updateWatcher.js";
import {
  BAG_CAPACITY,
  addToBag,
  attributeEffectsOf,
  basicAttackOf,
  bonusHpOf,
  equip,
  equippedAbilities,
  lookLevelsOf,
  lookOf,
  moveInBag,
  destroyItem,
  unequip,
  type InventoryFailure,
  type InventoryResult,
  type ItemStack,
} from "./items/inventory.js";
import { inventoryView, itemView, lootViews } from "./items/view.js";

/** Opções do {@link GameServer}. Os padrões servem para produção; os testes usam valores menores. */
export interface GameServerOptions {
  /** Onde ficam as contas (MongoDB no jogo, memória nos testes). Obrigatório. */
  readonly accounts: AccountStore;
  /** Zonas criadas ao subir. Padrão: {@link ZONE_CONFIGS}. */
  readonly zones?: readonly ZoneConfig[];
  /** Intervalo do ping de heartbeat, em ms. Quem não responder até o próximo é desconectado. Padrão: 10 000 ms. */
  readonly heartbeatIntervalMs?: number;
  /** Escreve as entradas/saídas no console. Padrão: `true`. */
  readonly log?: boolean;
  /** Pasta servida em `/updates/` (manifesto + pacotes do jogo). Padrão: `updates`. Ver mmo-docs [INFRA-08]. */
  readonly updatesDir?: string;
  /**
   * De quanto em quanto (ms) conferir se um manifesto de `updatesDir` mudou, além do `fs.watch` (ver
   * `src/http/updateWatcher.ts`). Padrão: {@link DEFAULT_UPDATE_POLL_MS}.
   */
  readonly updatePollIntervalMs?: number;
  /** Envio do código de recuperar senha ([INFRA-13]). Padrão: {@link LogMailer} (escreve no log). */
  readonly mailer?: Mailer;
}

/** Tamanho máximo de uma mensagem do cliente, em bytes. Maior que isso, o `ws` fecha a conexão (1009). */
const MAX_MESSAGE_BYTES = 4096;

/**
 * Espera entre mandar a mensagem que explica um fechamento (`error` da recusa, `update_required`) e fechar a conexão,
 * em ms. O `WebSocketPeer` do Godot DESCARTA as mensagens que chegam junto com o close (testado em 2026-11-14): sem a
 * espera o cliente nunca via o motivo. O cliente v16 fecha sozinho ao receber `update_required`; isto é a garantia.
 */
export const CLOSE_DELAY_MS = 1000;

/** Falhas de login/sessão aceitas por conexão antes de fechá-la (freio contra adivinhar senha). */
export const MAX_AUTH_FAILURES = 5;

/**
 * No relógio de ticks ({@link GameServer.startTimers}): quantos ticks atrasados roda de uma vez para alcançar o tempo;
 * mais atrasado que isso (servidor travou), retoma do agora em vez de despejar uma rajada de ticks.
 */
const MAX_TICK_CATCHUP = 5;

/** Uma conexão WebSocket aberta. */
interface Session {
  /** Id da conexão (só para log/diagnóstico; o jogo usa o `playerId`). */
  readonly connectionId: string;
  readonly socket: WebSocket;
  /** Conta autenticada nesta conexão; `null` até `register`/`login`/`resume` darem certo. */
  account: Account | null;
  /** Token de sessão desta conexão (para o `logout` encerrá-lo); `null` sem autenticação. */
  sessionToken: string | null;
  /** Autenticação em andamento (consulta ao banco/hash de senha). */
  authenticating: boolean;
  /** Quantas autenticações falharam nesta conexão. */
  authFailures: number;
  /** Zona em que entrou; `null` até o `join` ser aceito. */
  zone: Zone | null;
  /** Respondeu ao último ping do heartbeat. */
  alive: boolean;
  /** Quando a conexão abriu (ms, `Date.now()`): o log da saída diz quanto tempo durou. */
  readonly openedAt: number;
  /** Por que o servidor derrubou (heartbeat sem resposta, erro do socket); `null` = o outro lado fechou/caiu. */
  dropReason: string | null;
  /** Pacote do jogo que o cliente disse rodar na autenticação ([INFRA-08]); `null` = não disse (dev/antigo). */
  client: ClientBuild | null;
  /** Já foi recusada/mandada atualizar e vai fechar em {@link CLOSE_DELAY_MS}: as mensagens dela são ignoradas. */
  closing: boolean;
  /** Ping de verdade (ms) medido pelo ping/pong do WebSocket desde o último resumo de rede ([INFRA-12]). */
  readonly rttSamples: number[];
}

/** A cada quantos ms o servidor mede o ping de cada um (ping/pong do WebSocket com a hora dentro). */
const RTT_PROBE_MS = 1000;
/** A cada quantos ms vai para o log o resumo de rede de cada jogador na zona ([INFRA-12]). */
const NET_REPORT_MS = 10_000;

/** Como a autenticação aconteceu (só para o log). */
type AuthKind = "cadastro" | "login" | "sessão";

/** Mensagens em português para cada erro de autenticação (o cliente mostra direto). */
const AUTH_MESSAGES = {
  [ErrorCode.InvalidUsername]: "Username deve ter de 3 a 16 caracteres: letras, números ou _.",
  [ErrorCode.InvalidEmail]: "E-mail inválido.",
  [ErrorCode.InvalidPassword]: "A senha deve ter de 8 a 72 caracteres.",
  [ErrorCode.UsernameTaken]: "Esse username já está em uso.",
  [ErrorCode.EmailTaken]: "Esse e-mail já está cadastrado.",
  [ErrorCode.InvalidCredentials]: "Usuário/e-mail ou senha incorretos.",
  [ErrorCode.InvalidSession]: "Sua sessão expirou. Entre novamente.",
  [ErrorCode.InvalidResetCode]: "Código inválido ou vencido. Confira o e-mail ou peça um novo.",
} as const;

/**
 * Servidor do jogo: HTTP (`GET /health`, `GET /updates/*`) + WebSocket na mesma porta.
 *
 * Cada conexão vira uma {@link Session}: primeiro autentica (`register`, `login` ou `resume`,
 * mmo-docs [INFRA-07]), depois entra numa {@link Zone} com `join` (na última posição salva, se houver).
 * Ao sair, a posição é salva. Uma conta tem no máximo uma conexão: entrar de novo derruba a antiga.
 * Protocolo: `src/net/protocol.ts` e mmo-docs [INFRA-04].
 */
export class GameServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly zones: Map<string, Zone> = new Map();
  private readonly sessions: Set<Session> = new Set();
  /** Anti-spam e relógio do Global do chat ([SOC-09]). */
  private readonly chatLimiter: ChatLimiter = new ChatLimiter();
  /** Sessão autenticada de cada jogador. Garante uma conexão por conta. */
  private readonly online: Map<string, Session> = new Map();
  private readonly options: Required<GameServerOptions>;
  /** Recuperar senha por código no e-mail ([INFRA-13]). */
  private readonly passwordReset: PasswordReset;
  /** Pedidos de amizade pendentes (só na memória; amizade vale entre zonas, [SOC-04]). */
  private readonly friendRequests: FriendRequests;
  /** Guildas ([SOC-06]): todas na memória (carregadas em {@link listen}), gravadas no banco a cada mudança. */
  private readonly guilds: Guilds;
  /** Mercado entre jogadores ([JOGO-25]): todos os anúncios na memória, gravados no banco a cada mudança. */
  private readonly market: Market;
  /** Tabelas de ranking calculadas ([SOC-07]); refeitas no máximo a cada {@link RANKING_REFRESH_SECONDS} s. */
  private rankingBoards: RankingBoards | null = null;
  /** Cálculo em andamento (vários pedidos juntos esperam o mesmo). */
  private rankingBuild: Promise<RankingBoards> | null = null;
  /**
   * Amizades com jogadores fake de teste ([SOC-01]): fake não tem conta no banco, então a amizade com ele fica só na
   * memória do servidor (jogador → ids de fake), some quando o servidor reinicia e nunca vai para a conta.
   */
  private readonly fakeFriends: Map<string, Set<string>> = new Map();
  /** Usernames já conhecidos (de quem autenticou ou foi buscado no banco): nome dos amigos offline sem ir ao banco. */
  private readonly knownNames: Map<string, string> = new Map();
  private tickTimer: NodeJS.Timeout | null = null;
  /** O laço de ticks está rodando ({@link startTimers}); `false` depois de parar. */
  private ticking: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Medição de ping e resumo de rede por jogador ([INFRA-12]). */
  private rttTimer: NodeJS.Timeout | null = null;
  private netReportTimer: NodeJS.Timeout | null = null;
  /** Atraso do laço de eventos do Node (servidor travado) e tick mais lento desde o último resumo ([INFRA-12]). */
  private readonly loopDelay: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  private slowestTickMs: number = 0;
  /** Versões publicadas do pacote do jogo por plataforma; versão nova → manda atualizar quem está na velha. */
  private readonly updates: UpdateWatcher;

  constructor(options: GameServerOptions) {
    this.options = {
      accounts: options.accounts,
      zones: options.zones ?? ZONE_CONFIGS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      log: options.log ?? true,
      updatesDir: options.updatesDir ?? DEFAULT_UPDATES_DIR,
      updatePollIntervalMs: options.updatePollIntervalMs ?? DEFAULT_UPDATE_POLL_MS,
      mailer: options.mailer ?? new LogMailer(),
    };
    this.passwordReset = new PasswordReset(this.options.accounts, this.options.mailer);
    this.updates = new UpdateWatcher({
      dir: this.options.updatesDir,
      pollIntervalMs: this.options.updatePollIntervalMs,
      onVersion: (platform, version): void => this.onPackPublished(platform, version),
    });
    for (const config of this.options.zones) this.zones.set(config.id, new Zone(config));
    this.friendRequests = new FriendRequests({
      send: (playerId, message): void => this.sendTo(playerId, message),
      nameOf: (playerId): string | undefined => this.online.get(playerId)?.account?.username ?? this.fakeNameOf(playerId),
      autoAnswer: (playerId): "accept" | "reject" | null => this.friendAutoAnswer(playerId),
      areFriends: (a, b): boolean => this.areFriends(a, b),
      friendCount: (playerId): number => this.friendIdsOf(playerId).length,
      befriend: (a, b): void => this.befriend(a, b),
    });
    this.market = new Market({
      save: (listing): void => {
        this.options.accounts.saveListing(listing).catch((error: unknown) => console.error(`[mercado] falha ao salvar ${listing.id}:`, error));
      },
      remove: (listingId): void => {
        this.options.accounts.deleteListing(listingId).catch((error: unknown) => console.error(`[mercado] falha ao apagar ${listingId}:`, error));
      },
    });
    this.guilds = new Guilds({
      send: (playerId, message): void => this.sendTo(playerId, message),
      nameOf: (playerId): string | undefined => this.online.get(playerId)?.account?.username ?? this.fakeNameOf(playerId),
      levelOf: (playerId): number | null => this.zoneOfPlayer(playerId)?.levelOf(playerId) ?? null,
      autoAnswer: (playerId): "accept" | "reject" | null => this.guildAutoAnswer(playerId),
      spendGold: (playerId, amount): boolean => this.zoneOfPlayer(playerId)?.spendGold(playerId, amount) ?? false,
      leftAt: (playerId): number | null => this.online.get(playerId)?.account?.guildLeftAt ?? null,
      setLeftAt: (playerId, atMs): void => {
        const session: Session | undefined = this.online.get(playerId);
        if (session?.account !== null && session?.account !== undefined) session.account = { ...session.account, guildLeftAt: atMs };
        if (this.fakeNameOf(playerId) !== undefined) return;
        this.options.accounts.saveGuildLeftAt(playerId, atMs).catch((error: unknown) => {
          console.error(`[guilda] falha ao salvar a saída de ${playerId}:`, error);
        });
      },
      save: (guild): void => {
        this.options.accounts.saveGuild(guild).catch((error: unknown) => console.error(`[guilda] falha ao salvar ${guild.id}:`, error));
      },
      remove: (guildId): void => {
        this.options.accounts.deleteGuild(guildId).catch((error: unknown) => console.error(`[guilda] falha ao apagar ${guildId}:`, error));
      },
      onMemberGuild: (playerId, guild): void => this.zoneOfPlayer(playerId)?.setGuild(playerId, guild),
    });

    this.http = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      // Diagnóstico: quem abriu conexão (antes de autenticar), para ver aparelho que conecta e não entra.
      this.log(`[conexão] ${req.socket.remoteAddress ?? "?"} abriu conexão`);
      this.handleConnection(socket);
    });
  }

  /**
   * Lê as versões publicadas do jogo, começa a escutar e liga os timers de tick e heartbeat.
   * @param port porta TCP; `0` escolhe uma livre (útil em testes).
   * @returns a porta efetivamente usada.
   */
  async listen(port: number): Promise<number> {
    await this.updates.start();
    // Guildas na memória ([SOC-06]); os fakes de teste que já estão nas zonas ganham a tag deles.
    this.guilds.load(await this.options.accounts.loadGuilds());
    this.market.load(await this.options.accounts.loadListings());
    this.market.prune(Date.now());
    for (const zone of this.zones.values()) {
      for (const id of zone.fakeIds()) zone.setGuild(id, this.guilds.guildOf(id));
    }
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, () => {
        this.http.off("error", reject);
        this.startTimers();
        const address: string | AddressInfo | null = this.http.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  /** Salva a posição de quem está online, fecha as conexões e o servidor HTTP. */
  async close(): Promise<void> {
    if (this.tickTimer !== null) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.ticking = false;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.rttTimer !== null) clearInterval(this.rttTimer);
    if (this.netReportTimer !== null) clearInterval(this.netReportTimer);
    this.loopDelay.disable();
    this.updates.stop();
    await Promise.all(Array.from(this.sessions, (session) => this.leaveZone(session)));
    for (const session of this.sessions) session.socket.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => this.http.close(() => resolve()));
    });
  }

  /** Zona pelo id (usado nos testes e diagnóstico). */
  getZone(id: string): Zone | undefined {
    return this.zones.get(id);
  }

  private startTimers(): void {
    // Relógio de jogo com passo fixo: o tick N acontece em início + N × 50 ms, e um atraso é compensado no próximo.
    // `setInterval` atrasa um pouco a cada volta (medido: 19,86 Hz em vez de 20): o cliente manda 20 comandos por
    // segundo, então a fila do servidor crescia andando e cada comando a mais era +50 ms de atraso ([INFRA-09]).
    const tickMs: number = 1000 / TICK_RATE_HZ;
    let nextAt: number = performance.now() + tickMs;
    this.ticking = true;
    const loop = (): void => {
      if (!this.ticking) return;
      let now: number = performance.now();
      // Ficou muito para trás (servidor travou, computador dormiu): retoma do agora, sem rodar uma rajada de ticks.
      if (now - nextAt > MAX_TICK_CATCHUP * tickMs) nextAt = now;
      let ran: number = 0;
      while (now >= nextAt && ran < MAX_TICK_CATCHUP) {
        const started: number = performance.now();
        for (const zone of this.zones.values()) zone.tick();
        this.slowestTickMs = Math.max(this.slowestTickMs, performance.now() - started);
        this.friendRequests.expire(Date.now());
        this.guilds.expire(Date.now());
        nextAt += tickMs;
        ran++;
        now = performance.now();
      }
      this.tickTimer = setTimeout(loop, Math.max(0, nextAt - performance.now()));
    };
    this.tickTimer = setTimeout(loop, tickMs);

    // Celular perde rede sem fechar o socket: sem heartbeat, o jogador ficaria "fantasma" na zona.
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.sessions) {
        if (!session.alive) {
          session.dropReason = `heartbeat: sem resposta ao ping em ${this.options.heartbeatIntervalMs / 1000} s`;
          session.socket.close(CloseCode.Timeout, "heartbeat timeout");
          session.socket.terminate();
          continue;
        }
        session.alive = false;
        session.socket.ping();
      }
    }, this.options.heartbeatIntervalMs);

    // Diagnóstico de rede ([INFRA-12]): ping com a hora dentro (o pong devolve) e, a cada 10 s, um resumo por jogador.
    this.rttTimer = setInterval(() => {
      const stamp: Buffer = Buffer.alloc(8);
      stamp.writeDoubleBE(performance.now());
      for (const session of this.sessions) {
        if (session.zone !== null && session.socket.readyState === WebSocket.OPEN) session.socket.ping(stamp);
      }
    }, RTT_PROBE_MS);
    this.rttTimer.unref();
    this.loopDelay.enable();
    this.netReportTimer = setInterval(() => this.logNetReport(), NET_REPORT_MS);
    this.netReportTimer.unref();
  }

  /**
   * Uma linha por jogador na zona: ping médio/pior, passos que chegaram, maior buraco entre eles, buracos de mais de
   * 100 ms, ticks com rajada (2+ passos juntos), maior fila e passos jogados fora ([INFRA-12]).
   */
  private logNetReport(): void {
    // O próprio servidor: se isto é baixo enquanto o ping sobe, quem trava é a rede/aparelho, não o servidor.
    const loopMaxMs: number = this.loopDelay.max / 1e6;
    const anyoneInZone: boolean = Array.from(this.sessions).some((session) => session.zone !== null);
    if (anyoneInZone) {
      this.log(`[servidor] pior atraso do laço ${loopMaxMs.toFixed(0)} ms · tick mais lento ${this.slowestTickMs.toFixed(1)} ms`);
    }
    this.loopDelay.reset();
    this.slowestTickMs = 0;
    for (const session of this.sessions) {
      if (session.zone === null || session.account === null) continue;
      const net: NetStats | undefined = session.zone.takeNetStats(session.account.playerId);
      const rtt: number[] = session.rttSamples.splice(0);
      if (net === undefined || (net.arrivals === 0 && rtt.length === 0)) continue;
      const avg: number = rtt.length > 0 ? rtt.reduce((a, b) => a + b, 0) / rtt.length : -1;
      const worst: number = rtt.length > 0 ? Math.max(...rtt) : -1;
      this.log(
        `[rede] ${session.account.username}: ping ${avg.toFixed(0)} ms (pior ${worst.toFixed(0)}) · ${net.arrivals} passos, ` +
          `maior buraco ${net.maxGapMs.toFixed(0)} ms, ${net.gapsOver100} buracos >100 ms, ${net.bursts} rajadas, ` +
          `fila máx ${net.maxQueue}, ${net.dropped} jogados fora`,
      );
    }
  }

  /**
   * `GET /health`: 200 "ok" se o banco responde; 503 "db down" se não.
   * `GET /updates/<plataforma>/<arquivo>`: arquivos do atualizador (ver `src/http/updates.ts`).
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url: string = req.url ?? "";
    if (req.method === "GET" && url.startsWith(UPDATES_ROUTE)) {
      const relativePath: string = url.slice(UPDATES_ROUTE.length).split("?")[0] ?? "";
      // Diagnóstico ([INFRA-08]): qual aparelho pediu o manifesto/pacote (atualização que não termina).
      await serveUpdateFile(relativePath, this.options.updatesDir, res);
      this.log(`[update] ${req.socket.remoteAddress ?? "?"} ${relativePath}: ${res.statusCode}`);
      return;
    }
    if (req.method === "GET" && url === "/health") {
      const healthy: boolean = await this.options.accounts.isHealthy();
      res.writeHead(healthy ? 200 : 503, { "content-type": "text/plain" }).end(healthy ? "ok" : "db down");
      return;
    }
    res.writeHead(404).end();
  }

  private handleConnection(socket: WebSocket): void {
    const session: Session = {
      connectionId: randomBytes(4).toString("hex"),
      socket,
      account: null,
      sessionToken: null,
      authenticating: false,
      authFailures: 0,
      zone: null,
      alive: true,
      openedAt: Date.now(),
      dropReason: null,
      client: null,
      rttSamples: [],
      closing: false,
    };
    this.sessions.add(session);

    socket.on("pong", (data: Buffer) => {
      session.alive = true;
      // Pong do medidor de ping (traz a hora em que o ping saiu); o do heartbeat vem vazio.
      if (data.length === 8) session.rttSamples.push(performance.now() - data.readDoubleBE(0));
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const message: ClientMessage | null = isBinary ? null : parseClientMessage(data.toString());
      if (message === null) {
        this.sendError(session, ErrorCode.BadMessage, "mensagem inválida");
        return;
      }
      this.handleMessage(session, message);
    });
    socket.on("close", (code: number) => {
      this.sessions.delete(session);
      const account: Account | null = session.account;
      if (account !== null && this.online.get(account.playerId) === session) {
        // Saiu do servidor: os pedidos de amizade pendentes somem e os amigos online o veem offline ([SOC-04]).
        this.online.delete(account.playerId);
        this.chatLimiter.forgetSpam(account.playerId);
        this.friendRequests.removePlayer(account.playerId);
        this.refreshFriendsOf(account.friends);
        // Convites de guilda somem e os guildeiros online o veem offline ([SOC-06]).
        this.guilds.removePlayer(account.playerId);
        this.guilds.refreshMember(account.playerId);
      }
      const zoneId: string | undefined = session.zone?.config.id;
      void this.leaveZone(session).then(() => {
        if (zoneId !== undefined && account !== null) {
          // Diagnóstico de queda: quanto durou e se foi o servidor que derrubou (heartbeat/erro) ou a rede/o cliente.
          const seconds: string = ((Date.now() - session.openedAt) / 1000).toFixed(1);
          const why: string = session.dropReason ?? (code === 1006 ? "caiu sem aviso (rede ou app)" : "fechou");
          this.log(
            `[${zoneId}] ${account.username} saiu (code ${code}, ${why}, conectado ${seconds} s, ${this.zones.get(zoneId)?.size ?? 0} online)`,
          );
        }
      });
    });
    socket.on("error", (error: Error) => {
      // O "close" vem logo depois; registrar o handler evita que o erro derrube o processo.
      session.dropReason = `erro do socket: ${error.message}`;
    });
  }

  private handleMessage(session: Session, message: ClientMessage): void {
    if (session.closing) return;
    switch (message.type) {
      case ClientMessageType.Register:
        void this.handleRegister(session, message.data);
        return;
      case ClientMessageType.Login:
        void this.handleLogin(session, message.data);
        return;
      case ClientMessageType.Resume:
        void this.handleResume(session, message.data);
        return;
      case ClientMessageType.Logout:
        void this.handleLogout(session);
        return;
      case ClientMessageType.PasswordResetRequest:
        void this.handleResetRequest(session, message.data);
        return;
      case ClientMessageType.PasswordResetConfirm:
        void this.handleResetConfirm(session, message.data);
        return;
      case ClientMessageType.KeepAlive:
        // Só mantém o Wi-Fi do celular acordado ([INFRA-12]); nada a fazer.
        return;
      case ClientMessageType.ChooseBody:
        void this.handleChooseBody(session, message.data.body);
        return;
      case ClientMessageType.Join:
        void this.handleJoin(session, message.data);
        return;
      case ClientMessageType.Input:
        if (session.zone !== null && session.account !== null) session.zone.queueInput(session.account.playerId, message.data);
        return;
      case ClientMessageType.Equip:
        void this.changeInventory(session, (inventory) => equip(inventory, message.data.uid));
        return;
      case ClientMessageType.Unequip:
        void this.changeInventory(session, (inventory) => unequip(inventory, GameServer.slotOf(message.data.slot), message.data.index));
        return;
      case ClientMessageType.Upgrade:
        void this.handleUpgrade(session, message.data.uid, message.data.attribute);
        return;
      case ClientMessageType.Respawn:
        if (session.zone !== null && session.account !== null) session.zone.requestRespawn(session.account.playerId);
        return;
      case ClientMessageType.Fuse:
        void this.handleFuse(session, message.data.targetUid, message.data.materialUid);
        return;
      case ClientMessageType.ChestOpen:
        this.handleChestOpen(session, message.data.chestId);
        return;
      case ClientMessageType.ChestTake:
        void this.handleChestTake(session, message.data.chestId, message.data.lootId);
        return;
      case ClientMessageType.BagMove:
        void this.changeInventory(session, (inventory) => moveInBag(inventory, message.data.from, message.data.to));
        return;
      case ClientMessageType.ShopOpen:
        this.sendShop(session);
        return;
      case ClientMessageType.ShopBuy:
        void this.handleShop(session, "buy", message.data.itemId);
        return;
      case ClientMessageType.ShopSell:
        void this.handleShop(session, "sell", message.data.uid);
        return;
      case ClientMessageType.StoragePut:
        void this.handleStorage(session, "put", message.data.uid);
        return;
      case ClientMessageType.StorageTake:
        void this.handleStorage(session, "take", message.data.uid);
        return;
      case ClientMessageType.MarketList:
        this.sendMarketPage(session, message.data.query, message.data.slot, message.data.sort, message.data.page);
        return;
      case ClientMessageType.MarketMine:
        this.sendMarketMine(session);
        return;
      case ClientMessageType.MarketSell:
        void this.handleMarketSell(session, message.data.uid, message.data.price);
        return;
      case ClientMessageType.MarketBuy:
        void this.handleMarketBuy(session, message.data.listingId);
        return;
      case ClientMessageType.MarketCancel:
        void this.handleMarketCancel(session, message.data.listingId);
        return;
      case ClientMessageType.ChatSend:
        this.handleChat(session, message.data);
        return;
      case ClientMessageType.StorageBuyTab:
        void this.handleStorage(session, "buyTab", "");
        return;
      case ClientMessageType.ItemDestroy:
        // Item numa troca aberta: changeInventory avisa a troca (tradeBelongingsChanged), que tira ele da oferta.
        void this.changeInventory(session, (inventory) => destroyItem(inventory, message.data.uid));
        return;
      case ClientMessageType.Attack:
        if (session.zone === null || session.account === null) {
          this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
          return;
        }
        if (session.zone.setAttackTarget(session.account.playerId, message.data.targetId) !== "ok") {
          this.sendError(session, ErrorCode.InvalidTarget, "Esse alvo não pode ser atacado.");
        }
        return;
      case ClientMessageType.Cast: {
        if (session.zone === null || session.account === null) {
          this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
          return;
        }
        const result: CastResult = session.zone.castAbility(session.account.playerId, message.data);
        if (!result.ok) this.sendError(session, GameServer.CAST_ERRORS[result.reason], result.message);
        return;
      }
      case ClientMessageType.Inspect: {
        // Atributos de um jogador da mesma zona ([SOC-02]); o snapshot não leva isso.
        if (session.zone === null || session.account === null) {
          this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
          return;
        }
        const attributes: AttributesView | undefined = session.zone.attributes(message.data.playerId);
        if (attributes === undefined) {
          this.sendError(session, ErrorCode.PlayerNotFound, "Esse jogador não está mais por perto.");
          return;
        }
        // Perfil fechado para quem pediu ([SOC-08]): só quem é, sem os atributos.
        const data: AttributesData = this.canSeeProfile(session.account.playerId, attributes.id)
          ? attributes
          : { id: attributes.id, name: attributes.name, level: attributes.level, hidden: true };
        if (session.socket.readyState === WebSocket.OPEN) {
          session.socket.send(encodeServerMessage({ type: ServerMessageType.Attributes, data }));
        }
        return;
      }
      // Grupo ([SOC-03]): as regras ficam na zona (src/zones/groups.ts); aqui só repassa e devolve a recusa.
      case ClientMessageType.GroupInvite:
        this.groupRequest(session, (zone, id) => zone.inviteToGroup(id, message.data.playerId));
        return;
      case ClientMessageType.GroupAnswer:
        this.groupRequest(session, (zone, id) => zone.answerGroupInvite(id, message.data.fromId, message.data.accept));
        return;
      case ClientMessageType.GroupKick:
        this.groupRequest(session, (zone, id) => zone.kickFromGroup(id, message.data.playerId));
        return;
      case ClientMessageType.GroupLeave:
        this.groupRequest(session, (zone, id) => zone.leaveGroup(id));
        return;
      // Troca ([SOC-05]): as regras ficam na zona (src/zones/trades.ts); aqui só repassa e devolve a recusa.
      case ClientMessageType.TradeRequest:
        this.tradeRequest(session, (zone, id) => zone.requestTrade(id, message.data.playerId));
        return;
      case ClientMessageType.TradeAnswer:
        this.tradeRequest(session, (zone, id) => zone.answerTrade(id, message.data.fromId, message.data.accept));
        return;
      case ClientMessageType.TradeOffer:
        this.tradeRequest(session, (zone, id) => zone.offerTrade(id, message.data.uids, message.data.gold));
        return;
      case ClientMessageType.TradeConfirm:
        this.tradeRequest(session, (zone, id) => zone.confirmTrade(id));
        return;
      case ClientMessageType.TradeCancel:
        this.tradeRequest(session, (zone, id) => zone.cancelTrade(id));
        return;
      // Amizade ([SOC-04]): pedidos em src/social/friends.ts; a amizade em si fica na conta.
      case ClientMessageType.FriendRequest:
        this.friendRequest(session, (id) => this.friendRequests.request(id, message.data.playerId, Date.now()));
        return;
      case ClientMessageType.FriendAnswer:
        this.friendRequest(session, (id) => this.friendRequests.answer(id, message.data.fromId, message.data.accept));
        return;
      case ClientMessageType.FriendRemove:
        this.removeFriend(session, message.data.playerId);
        return;
      case ClientMessageType.SocialSettings:
        void this.changeSocialSettings(session, message.data);
        return;
      // Guilda ([SOC-06]): regras em src/social/guilds.ts; aqui só repassa e devolve a recusa.
      case ClientMessageType.GuildCreate:
        this.guildRequest(session, (id) => this.guilds.create(id, message.data.name, message.data.tag, message.data.description, Date.now()));
        return;
      case ClientMessageType.GuildInvite:
        this.guildRequest(session, (id) => this.guilds.invite(id, message.data.playerId, Date.now()));
        return;
      case ClientMessageType.GuildAnswer:
        this.guildRequest(session, (id) => this.guilds.answer(id, message.data.fromId, message.data.accept, Date.now()));
        return;
      case ClientMessageType.GuildLeave:
        this.guildRequest(session, (id) => this.guilds.leave(id, Date.now()));
        return;
      case ClientMessageType.GuildKick:
        this.guildRequest(session, (id) => this.guilds.kick(id, message.data.playerId));
        return;
      case ClientMessageType.GuildRole:
        this.guildRequest(session, (id) => this.guilds.setRole(id, message.data.playerId, message.data.role));
        return;
      case ClientMessageType.GuildList:
        if (session.account !== null) this.sendTo(session.account.playerId, { type: ServerMessageType.GuildList, data: { query: message.data.query, guilds: this.guilds.list(message.data.query) } });
        return;
      case ClientMessageType.GuildInfo:
        void this.sendGuildInfo(session, message.data.guildId);
        return;
      case ClientMessageType.GuildRequest:
        this.guildRequest(session, (id) => this.guilds.request(id, message.data.guildId, Date.now()));
        return;
      case ClientMessageType.GuildRequestAnswer:
        this.guildRequest(session, (id) => this.guilds.answerRequest(id, message.data.playerId, message.data.accept, Date.now()));
        return;
      case ClientMessageType.GuildDescription:
        this.guildRequest(session, (id) => this.guilds.setDescription(id, message.data.description));
        return;
      case ClientMessageType.RankingRequest:
        void this.sendRanking(session, message.data.category, message.data.period);
        return;
    }
  }

  /**
   * Manda a tabela [category]/[period] ([SOC-07]): top 100 + a linha de quem pediu (ou da guilda dele). As tabelas
   * vêm do cache ({@link rankingBoards}), refeito a partir do banco quando passa de {@link RANKING_REFRESH_SECONDS} s.
   */
  private async sendRanking(session: Session, category: RankingCategory, period: RankingPeriod): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    let boards: RankingBoards;
    try {
      boards = await this.currentRankings();
    } catch (error: unknown) {
      console.error("[ranking] falha ao calcular:", error);
      this.sendError(session, ErrorCode.BadMessage, "Ranking indisponível agora. Tente de novo.");
      return;
    }
    const guildCategory: boolean = category === "guild_monsters" || category === "guild_pvp";
    const ownId: string | null = guildCategory ? (this.guilds.guildOf(account.playerId)?.id ?? null) : account.playerId;
    const me: RankRow | null = ownId === null ? null : boards.rowOf(category, period, ownId);
    const now: number = Date.now();
    this.sendTo(account.playerId, {
      type: ServerMessageType.Ranking,
      data: {
        category,
        period,
        rows: boards.top(category, period),
        me,
        resetsIn: secondsUntilReset(period, now),
        age: Math.max(0, Math.round((now - boards.builtAtMs) / 1000)),
      },
    });
  }

  /** Ficha de uma guilda (Procurar guilda, [SOC-06]) com os totais globais do ranking ([SOC-07]). */
  private async sendGuildInfo(session: Session, guildId: string): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    let totals: { monsterXp: number; kills: number } = { monsterXp: 0, kills: 0 };
    try {
      const boards: RankingBoards = await this.currentRankings();
      totals = {
        monsterXp: boards.rowOf("guild_monsters", "global", guildId)?.value ?? 0,
        kills: boards.rowOf("guild_pvp", "global", guildId)?.value ?? 0,
      };
    } catch (error: unknown) {
      console.error("[guilda] falha ao calcular os totais:", error);
    }
    const info: GuildInfoView | undefined = this.guilds.info(guildId, account.playerId, totals, Date.now());
    if (info === undefined) {
      this.sendError(session, ErrorCode.GuildInviteNotFound, "Essa guilda não existe mais.");
      return;
    }
    this.sendTo(account.playerId, { type: ServerMessageType.GuildInfo, data: info });
  }

  /** As tabelas atuais: o cache se tem menos de {@link RANKING_REFRESH_SECONDS} s, senão recalcula (uma vez só). */
  private currentRankings(): Promise<RankingBoards> {
    const cached: RankingBoards | null = this.rankingBoards;
    if (cached !== null && Date.now() - cached.builtAtMs < RANKING_REFRESH_SECONDS * 1000) return Promise.resolve(cached);
    if (this.rankingBuild !== null) return this.rankingBuild;
    this.rankingBuild = this.options.accounts
      .rankingSources()
      .then((sources) => {
        const guilds = this.guilds.all().map((g) => ({ id: g.id, name: `[${g.tag}] ${g.name}`, memberIds: g.members.map((m) => m.id) }));
        const boards: RankingBoards = new RankingBoards(sources, guilds, Date.now());
        this.rankingBoards = boards;
        return boards;
      })
      .finally(() => {
        this.rankingBuild = null;
      });
    return this.rankingBuild;
  }

  /** Pedido de guilda de quem está autenticado; recusado vira `error` só para ele ([SOC-06]). */
  private guildRequest(session: Session, request: (playerId: string) => GuildResult): void {
    if (session.account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    const result: GuildResult = request(session.account.playerId);
    if (!result.ok) this.sendError(session, GameServer.GUILD_ERRORS[result.reason], result.message);
  }

  /** Código do protocolo para cada recusa de guilda. */
  private static readonly GUILD_ERRORS: Readonly<Record<GuildFailure, ErrorCode>> = {
    invalid_guild: ErrorCode.InvalidGuild,
    guild_name_taken: ErrorCode.GuildNameTaken,
    guild_tag_taken: ErrorCode.GuildTagTaken,
    already_in_guild: ErrorCode.AlreadyInGuild,
    not_in_guild: ErrorCode.NotInGuild,
    guild_no_permission: ErrorCode.GuildNoPermission,
    guild_full: ErrorCode.GuildFull,
    guild_invite_not_found: ErrorCode.GuildInviteNotFound,
    guild_cooldown: ErrorCode.GuildCooldown,
    not_enough_gold: ErrorCode.NotEnoughGold,
    player_not_found: ErrorCode.PlayerNotFound,
    invalid_invite: ErrorCode.InvalidInvite,
  };

  /** A zona em que o jogador (ou fake de teste) está agora, ou `undefined`. */
  private zoneOfPlayer(playerId: string): Zone | undefined {
    const zone: Zone | null | undefined = this.online.get(playerId)?.zone;
    if (zone !== null && zone !== undefined) return zone;
    for (const candidate of this.zones.values()) if (candidate.fakeName(playerId) !== undefined) return candidate;
    return undefined;
  }

  /** Resposta automática a convite de guilda: a do fake de teste, `reject` para quem oculta convites, senão `null`. */
  private guildAutoAnswer(playerId: string): "accept" | "reject" | null {
    for (const zone of this.zones.values()) {
      const auto: "accept" | "reject" | null = zone.autoReplyOf(playerId);
      if (auto !== null) return auto;
    }
    return this.online.get(playerId)?.account?.social.guildInvites === "hide" ? "reject" : null;
  }

  /** Pedido/resposta de amizade de quem está autenticado; recusado vira `error` só para ele ([SOC-04]). */
  private friendRequest(session: Session, request: (playerId: string) => FriendResult): void {
    if (session.account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    const result: FriendResult = request(session.account.playerId);
    if (!result.ok) this.sendError(session, GameServer.FRIEND_ERRORS[result.reason], result.message);
  }

  /** Código do protocolo para cada recusa de pedido de amizade. */
  private static readonly FRIEND_ERRORS: Readonly<Record<FriendFailure, ErrorCode>> = {
    player_not_found: ErrorCode.PlayerNotFound,
    invalid_friend_request: ErrorCode.InvalidFriendRequest,
    already_friends: ErrorCode.AlreadyFriends,
    friend_request_pending: ErrorCode.FriendRequestPending,
    friend_request_not_found: ErrorCode.FriendRequestNotFound,
    friend_list_full: ErrorCode.FriendListFull,
  };

  /** Manda `message` ao jogador se ele está online (fake de teste/offline: nada). */
  private sendTo(playerId: string, message: ServerMessage): void {
    const socket: WebSocket | undefined = this.online.get(playerId)?.socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.send(encodeServerMessage(message));
  }

  /** Nome do jogador fake de teste `playerId` em alguma zona, ou `undefined` se não for um fake ([SOC-01]). */
  private fakeNameOf(playerId: string): string | undefined {
    for (const zone of this.zones.values()) {
      const name: string | undefined = zone.fakeName(playerId);
      if (name !== undefined) return name;
    }
    return undefined;
  }

  /** Resposta automática a pedido de amizade: a do fake de teste, `reject` para quem oculta pedidos, senão `null`. */
  private friendAutoAnswer(playerId: string): "accept" | "reject" | null {
    for (const zone of this.zones.values()) {
      const auto: "accept" | "reject" | null = zone.autoReplyOf(playerId);
      if (auto !== null) return auto;
    }
    return this.online.get(playerId)?.account?.social.friendRequests === "hide" ? "reject" : null;
  }

  /** Amigos de um jogador online: os da conta + os fakes de teste (só na memória). Offline: só os fakes. */
  private friendIdsOf(playerId: string): string[] {
    const saved: readonly string[] = this.online.get(playerId)?.account?.friends ?? [];
    return [...saved, ...(this.fakeFriends.get(playerId) ?? [])];
  }

  /**
   * `true` se [viewerId] pode ver o perfil (tela de Atributos) de [ownerId] — Configuração → Perfil ([SOC-08]): você
   * mesmo sempre; `public` = todos; `friends` = só amigos; `nobody` = ninguém. Fake de teste (sem conta) = público.
   */
  private canSeeProfile(viewerId: string, ownerId: string): boolean {
    if (viewerId === ownerId) return true;
    const visibility: ProfileVisibility = this.online.get(ownerId)?.account?.social.profile ?? "public";
    if (visibility === "public") return true;
    return visibility === "friends" && this.areFriends(viewerId, ownerId);
  }

  /** `true` se `a` e `b` são amigos (olha os dois lados: o fake não tem lista própria). */
  private areFriends(a: string, b: string): boolean {
    return this.friendIdsOf(a).includes(b) || this.friendIdsOf(b).includes(a);
  }

  /** Atualiza a lista de amigos na conta em memória do jogador online (o banco é gravado à parte). */
  private updateFriends(playerId: string, change: (friends: readonly string[]) => string[]): void {
    const session: Session | undefined = this.online.get(playerId);
    if (session !== undefined && session.account !== null) session.account = { ...session.account, friends: change(session.account.friends) };
  }

  /** `a` e `b` viraram amigos: grava (memória + banco; com fake, só memória) e manda as listas novas aos dois. */
  private befriend(a: string, b: string): void {
    const fakeA: boolean = this.fakeNameOf(a) !== undefined;
    const fakeB: boolean = this.fakeNameOf(b) !== undefined;
    if (fakeA || fakeB) {
      const [real, fake] = fakeA ? [b, a] : [a, b];
      const set: Set<string> = this.fakeFriends.get(real) ?? new Set();
      set.add(fake);
      this.fakeFriends.set(real, set);
    } else {
      this.updateFriends(a, (friends) => (friends.includes(b) ? [...friends] : [...friends, b]));
      this.updateFriends(b, (friends) => (friends.includes(a) ? [...friends] : [...friends, a]));
      this.options.accounts.addFriendship(a, b).catch((error: unknown) => {
        console.error(`[amizade] falha ao salvar a amizade ${a} ↔ ${b}:`, error);
      });
    }
    void this.sendFriends(a);
    void this.sendFriends(b);
  }

  /** "Remover amigo": desfaz dos dois lados (memória + banco) e manda as listas novas ([SOC-04]). */
  private removeFriend(session: Session, otherId: string): void {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    const me: string = account.playerId;
    if (!this.areFriends(me, otherId)) {
      this.sendError(session, ErrorCode.NotFriends, "Esse jogador não é seu amigo.");
      return;
    }
    const name: string = this.online.get(otherId)?.account?.username ?? this.fakeNameOf(otherId) ?? this.knownNames.get(otherId) ?? "Jogador";
    this.fakeFriends.get(me)?.delete(otherId);
    this.updateFriends(me, (friends) => friends.filter((id) => id !== otherId));
    this.updateFriends(otherId, (friends) => friends.filter((id) => id !== me));
    if (this.fakeNameOf(otherId) === undefined) {
      this.options.accounts.removeFriendship(me, otherId).catch((error: unknown) => {
        console.error(`[amizade] falha ao desfazer a amizade ${me} ↔ ${otherId}:`, error);
      });
    }
    this.sendTo(me, {
      type: ServerMessageType.FriendNotice,
      data: { code: "removed", name, message: `${name} foi removido dos seus amigos.` },
    });
    void this.sendFriends(me);
    void this.sendFriends(otherId);
  }

  /**
   * Manda `friends` (lista com online/offline) ao jogador, se ele estiver online. Nome de amigo offline desconhecido é
   * buscado no banco uma vez (fica em {@link knownNames}); id sem conta (apagada) não aparece.
   */
  private async sendFriends(playerId: string): Promise<void> {
    if (!this.online.has(playerId)) return;
    const missing: string[] = this.friendIdsOf(playerId).filter((id) => this.nameOfFriend(id) === undefined);
    if (missing.length > 0) {
      try {
        for (const [id, name] of await this.options.accounts.usernamesOf(missing)) this.knownNames.set(id, name);
      } catch (error: unknown) {
        console.error(`[amizade] falha ao buscar nomes dos amigos:`, error);
      }
    }
    // Lista montada DEPOIS da espera: reflete o estado mais novo mesmo que algo tenha mudado no meio.
    const friends: FriendView[] = [];
    for (const id of this.friendIdsOf(playerId)) {
      const name: string | undefined = this.nameOfFriend(id);
      if (name !== undefined) friends.push({ id, name, online: this.online.has(id) || this.fakeNameOf(id) !== undefined });
    }
    friends.sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name, "pt-BR"));
    this.sendTo(playerId, { type: ServerMessageType.Friends, data: { friends } });
  }

  /** Nome de um amigo: online, fake de teste ou já conhecido; `undefined` = buscar no banco. */
  private nameOfFriend(playerId: string): string | undefined {
    return this.online.get(playerId)?.account?.username ?? this.fakeNameOf(playerId) ?? this.knownNames.get(playerId);
  }

  /** Manda a lista de amigos de novo a cada um destes que estiver online (alguém entrou/saiu do servidor). */
  private refreshFriendsOf(playerIds: readonly string[]): void {
    for (const id of playerIds) void this.sendFriends(id);
  }

  /**
   * Configuração social ("Solicitações de amizade" e "Convites de grupo": Sempre/Ocultar, [SOC-04]): guarda na conta
   * em memória (vale na hora: `friendAutoAnswer` e `hidesGroupInvites` leem dali), salva no banco e confirma com
   * `social_settings`.
   */
  private async changeSocialSettings(session: Session, settings: SocialSettings): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    session.account = { ...account, social: settings };
    try {
      await this.options.accounts.saveSocialSettings(account.playerId, settings);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar a configuração social de ${account.username}:`, error);
    }
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(encodeServerMessage({ type: ServerMessageType.SocialSettings, data: settings }));
    }
  }

  /** Pedido de grupo de quem está numa zona; recusado vira `error` só para ele ([SOC-03]). */
  private groupRequest(session: Session, request: (zone: Zone, playerId: string) => GroupResult): void {
    if (session.zone === null || session.account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const result: GroupResult = request(session.zone, session.account.playerId);
    if (!result.ok) this.sendError(session, GameServer.GROUP_ERRORS[result.reason], result.message);
  }

  /** Pedido de troca de quem está numa zona; recusado vira `error` só para ele ([SOC-05]). */
  private tradeRequest(session: Session, request: (zone: Zone, playerId: string) => TradeResult): void {
    if (session.zone === null || session.account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const result: TradeResult = request(session.zone, session.account.playerId);
    if (!result.ok) this.sendError(session, GameServer.TRADE_ERRORS[result.reason], result.message);
  }

  /** Código do protocolo para cada recusa de pedido de troca (mesmos nomes). */
  private static readonly TRADE_ERRORS: Readonly<Record<TradeFailure, ErrorCode>> = {
    player_not_found: ErrorCode.PlayerNotFound,
    invalid_trade: ErrorCode.InvalidTrade,
    trade_too_far: ErrorCode.TradeTooFar,
    trade_busy: ErrorCode.TradeBusy,
    trade_request_not_found: ErrorCode.TradeRequestNotFound,
    not_in_trade: ErrorCode.NotInTrade,
    trade_not_ready: ErrorCode.TradeNotReady,
  };

  /**
   * A troca aconteceu ([SOC-05]): troca a mochila da conta (as moedas já vieram pelo `onProgress`), salva e manda o
   * `inventory`. O vestido não muda, então a zona não precisa refazer arma/cartas/aparência.
   */
  private async applyTradeBag(session: Session, bag: readonly ItemStack[]): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) return;
    const inventory: Account["inventory"] = { ...account.inventory, bag: [...bag] };
    session.account = { ...account, inventory };
    this.sendInventory(session);
    try {
      await this.options.accounts.saveInventory(account.playerId, inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário (troca) de ${account.username}:`, error);
    }
  }

  /** Código do protocolo para cada recusa de pedido de grupo (mesmos nomes). */
  private static readonly GROUP_ERRORS: Readonly<Record<GroupFailure, ErrorCode>> = {
    player_not_found: ErrorCode.PlayerNotFound,
    not_group_leader: ErrorCode.NotGroupLeader,
    group_full: ErrorCode.GroupFull,
    invalid_invite: ErrorCode.InvalidInvite,
    invite_not_found: ErrorCode.InviteNotFound,
    already_in_group: ErrorCode.AlreadyInGroup,
    not_in_group: ErrorCode.NotInGroup,
  };

  /**
   * Checagens comuns antes de autenticar. Devolve `false` (e já respondeu) se não pode seguir.
   * Pacote do jogo desatualizado → `update_required` e fecha (antes da versão do protocolo: um cliente velho com
   * protocolo velho também é mandado atualizar sozinho, em vez de só ver o erro). Versão do protocolo errada fecha a
   * conexão: um cliente desatualizado não deve nem tentar.
   */
  private canAuthenticate(session: Session, data: { readonly version: number; readonly client?: ClientBuild }): boolean {
    const version: number = data.version;
    if (session.account !== null) {
      this.sendError(session, ErrorCode.AlreadyAuthenticated, "já autenticado");
      return false;
    }
    if (session.authenticating) {
      this.sendError(session, ErrorCode.BadMessage, "autenticação em andamento");
      return false;
    }
    session.client = data.client ?? null;
    const published: number | undefined = this.outdatedBy(session.client);
    if (published !== undefined) {
      this.requireUpdate(session, published);
      return false;
    }
    if (version !== PROTOCOL_VERSION) {
      this.reject(session, ErrorCode.VersionMismatch, `protocolo ${version}, servidor usa ${PROTOCOL_VERSION}`);
      return false;
    }
    return true;
  }

  private async handleRegister(session: Session, data: RegisterData): Promise<void> {
    if (!this.canAuthenticate(session, data)) return;
    const username: string = data.username.trim();
    const email: string = data.email.trim();
    if (!isValidUsername(username)) return this.authError(session, ErrorCode.InvalidUsername, false);
    if (!isValidEmail(email)) return this.authError(session, ErrorCode.InvalidEmail, false);
    if (!isValidPassword(data.password)) return this.authError(session, ErrorCode.InvalidPassword, false);

    const result: RegisterResult | undefined = await this.runAuth(session, () =>
      this.options.accounts.register(username, email, data.password),
    );
    if (result === undefined) return;
    if (!result.ok) {
      const code: keyof typeof AUTH_MESSAGES = result.reason === "username_taken" ? ErrorCode.UsernameTaken : ErrorCode.EmailTaken;
      return this.authError(session, code, false);
    }
    this.authenticated(session, result.account, result.sessionToken, "cadastro");
  }

  private async handleLogin(session: Session, data: LoginData): Promise<void> {
    if (!this.canAuthenticate(session, data)) return;
    const result: AuthSuccess | null | undefined = await this.runAuth(session, () =>
      this.options.accounts.login(data.login, data.password),
    );
    if (result === undefined) return;
    if (result === null) return this.authError(session, ErrorCode.InvalidCredentials, true);
    this.authenticated(session, result.account, result.sessionToken, "login");
  }

  /**
   * Esqueci a senha ([INFRA-13]): manda o código se a conta existir, e responde `password_reset_sent` SEMPRE (não diz
   * se a conta existe). Falha do e-mail só vai para o log.
   */
  private async handleResetRequest(session: Session, data: PasswordResetRequestData): Promise<void> {
    if (!this.canAuthenticate(session, data)) return;
    const result: ResetRequestResult | undefined = await this.runAuth(session, async (): Promise<ResetRequestResult> => {
      try {
        return await this.passwordReset.request(data.login.trim());
      } catch (error: unknown) {
        console.error(`[${session.connectionId}] falha ao mandar o e-mail de recuperar senha:`, error);
        return "failed";
      }
    });
    if (result === undefined) return;
    if (this.options.log) console.log(`[${session.connectionId}] recuperar senha: ${result}`);
    session.socket.send(encodeServerMessage({ type: ServerMessageType.PasswordResetSent, data: {} }));
  }

  /** Troca a senha com o código: errado conta como falha de autenticação (freio de {@link MAX_AUTH_FAILURES}). */
  private async handleResetConfirm(session: Session, data: PasswordResetConfirmData): Promise<void> {
    if (!this.canAuthenticate(session, data)) return;
    if (!isValidPassword(data.password)) return this.authError(session, ErrorCode.InvalidPassword, false);
    const result: ResetConfirmResult | undefined = await this.runAuth(session, () =>
      this.passwordReset.confirm(data.login.trim(), data.code, data.password),
    );
    if (result === undefined) return;
    if (!result.ok) return this.authError(session, ErrorCode.InvalidResetCode, true);
    if (this.options.log) console.log(`[${session.connectionId}] senha trocada pelo código do e-mail`);
    // As sessões salvas já caíram no banco; quem estiver jogando com esta conta agora também sai.
    const online: Session | undefined = this.online.get(result.playerId);
    if (online !== undefined) {
      void this.leaveZone(online);
      online.socket.close(CloseCode.Replaced, "senha trocada");
    }
    session.socket.send(encodeServerMessage({ type: ServerMessageType.PasswordResetDone, data: {} }));
  }

  private async handleResume(session: Session, data: ResumeData): Promise<void> {
    if (!this.canAuthenticate(session, data)) return;
    const account: Account | null | undefined = await this.runAuth(session, () =>
      this.options.accounts.resume(data.sessionToken),
    );
    if (account === undefined) return;
    if (account === null) return this.authError(session, ErrorCode.InvalidSession, true);
    this.authenticated(session, account, data.sessionToken, "sessão");
  }

  /**
   * Roda uma operação de conta marcando a sessão como "autenticando". Erro do banco → `server_error`
   * e fecha. Devolve `undefined` se não deve seguir (erro, ou a conexão caiu enquanto esperava).
   */
  private async runAuth<T>(session: Session, operation: () => Promise<T>): Promise<T | undefined> {
    session.authenticating = true;
    try {
      const result: T = await operation();
      return session.socket.readyState === WebSocket.OPEN ? result : undefined;
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao acessar as contas:`, error);
      this.reject(session, ErrorCode.ServerError, "falha ao acessar as contas");
      return undefined;
    } finally {
      session.authenticating = false;
    }
  }

  /**
   * Responde um erro de autenticação. Se `countsAsFailure` (senha/sessão errada), soma uma falha e,
   * passando de {@link MAX_AUTH_FAILURES}, fecha a conexão com `too_many_attempts`.
   */
  private authError(session: Session, code: keyof typeof AUTH_MESSAGES, countsAsFailure: boolean): void {
    if (countsAsFailure) {
      session.authFailures++;
      if (session.authFailures >= MAX_AUTH_FAILURES) {
        this.reject(session, ErrorCode.TooManyAttempts, "Tentativas demais. Tente novamente mais tarde.");
        return;
      }
    }
    this.sendError(session, code, AUTH_MESSAGES[code]);
  }

  /** Autenticação aceita: derruba outra conexão da mesma conta e responde `auth_ok`. */
  private authenticated(session: Session, account: Account, sessionToken: string, kind: AuthKind): void {
    const previous: Session | undefined = this.online.get(account.playerId);
    if (previous !== undefined && previous !== session) {
      // A antiga sai da zona (salvando a posição) e é fechada; a nova assume.
      void this.leaveZone(previous);
      previous.socket.close(CloseCode.Replaced, "entrou em outra conexão");
    }
    const wasOnline: boolean = this.online.has(account.playerId);
    session.account = account;
    session.sessionToken = sessionToken;
    this.online.set(account.playerId, session);
    this.knownNames.set(account.playerId, account.username);
    session.socket.send(
      encodeServerMessage({
        type: ServerMessageType.AuthOk,
        data: { playerId: account.playerId, username: account.username, sessionToken, body: account.body, social: account.social },
      }),
    );
    this.sendInventory(session);
    void this.sendFriends(account.playerId);
    // A guilda dele; os guildeiros online passam a vê-lo online ([SOC-06]).
    this.guilds.sendGuild(account.playerId);
    if (!wasOnline) this.guilds.refreshMember(account.playerId);
    // Os amigos online passam a vê-lo online ([SOC-04]).
    if (!wasOnline) this.refreshFriendsOf(account.friends);
    this.log(`[auth] ${account.username} autenticou (${kind})`);
  }

  /** Manda o inventário da conta desta sessão (vestido + mochila + o que cada item faz). */
  private sendInventory(session: Session): void {
    if (session.account === null || session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(encodeServerMessage({ type: ServerMessageType.Inventory, data: inventoryView(session.account.inventory) }));
  }

  /**
   * Aplica uma troca no inventário (regras em `src/items/inventory.ts`): se aceita, salva no banco e
   * manda o inventário novo; se recusada, manda o erro e nada muda. Ver mmo-docs [JOGO-04].
   */
  private async changeInventory(session: Session, change: (inventory: Account["inventory"]) => InventoryResult): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    const result: InventoryResult = change(account.inventory);
    if (!result.ok) {
      this.sendError(session, GameServer.inventoryError(result.reason), GameServer.INVENTORY_MESSAGES[result.reason]);
      return;
    }
    session.account = { ...account, inventory: result.inventory };
    // A arma, as cartas e a aparência podem ter mudado: a zona acompanha.
    session.zone?.setLoadout(
      account.playerId,
      basicAttackOf(result.inventory),
      equippedAbilities(result.inventory),
      lookOf(result.inventory),
      bonusHpOf(result.inventory),
      attributeEffectsOf(result.inventory),
      lookLevelsOf(result.inventory),
    );
    // Item oferecido numa troca aberta pode ter sido vestido/fundido/movido ([SOC-05]).
    session.zone?.tradeBelongingsChanged(account.playerId);
    try {
      await this.options.accounts.saveInventory(account.playerId, result.inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário de ${account.username}:`, error);
    }
    this.sendInventory(session);
  }

  /**
   * Melhoria no ferreiro ([JOGO-16]): a zona confere a distância, as moedas e sorteia (`Zone.upgradeItem`, que já
   * desconta as moedas e salva o progresso). Responde `upgrade_result`; se subiu de nível, salva o inventário, a zona
   * passa a usar os atributos novos (se o item está vestido) e vai o `inventory` novo.
   */
  private async handleUpgrade(session: Session, uid: string, attribute: AttributeId): Promise<void> {
    const zone: Zone | null = session.zone;
    if (session.account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const playerId: string = session.account.playerId;
    const result = zone.upgradeItem(playerId, session.account.inventory, uid, attribute);
    if (!result.ok) {
      this.sendError(session, GameServer.UPGRADE_ERRORS[result.reason], GameServer.UPGRADE_MESSAGES[result.reason]);
      return;
    }
    const level: number = result.stack.level ?? 0;
    const points: number = result.success ? (result.stack.attrs?.[attribute] ?? 0) - (GameServer.pointsBefore(session.account.inventory, uid, attribute)) : 0;
    // O onProgress da zona já trocou o progresso (moedas) na sessão: lê a conta de novo antes de mexer nela.
    const account: Account | null = session.account;
    if (result.success && account !== null) {
      session.account = { ...account, inventory: result.inventory };
      zone.setLoadout(
        playerId,
        basicAttackOf(result.inventory),
        equippedAbilities(result.inventory),
        lookOf(result.inventory),
        bonusHpOf(result.inventory),
        attributeEffectsOf(result.inventory),
        lookLevelsOf(result.inventory),
      );
      try {
        await this.options.accounts.saveInventory(playerId, result.inventory);
      } catch (error: unknown) {
        console.error(`[${session.connectionId}] falha ao salvar inventário (ferreiro) de ${account.username}:`, error);
      }
    }
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(
        encodeServerMessage({ type: ServerMessageType.UpgradeResult, data: { uid, success: result.success, cost: result.cost, attribute, level, points } }),
      );
    }
    if (result.success) this.sendInventory(session);
    // Moedas gastas e, se subiu, o item mudou: a troca aberta confere a oferta ([SOC-05]).
    zone.tradeBelongingsChanged(playerId);
  }

  /** Manda a lista da Loja do Ferreiro ([JOGO-23]): todas as peças +0 com o preço. */
  private sendShop(session: Session): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    const offers = shopItems().flatMap((def) => {
      const item: ItemView | null = itemView({ uid: `shop-${def.id}`, itemId: def.id });
      return item === null ? [] : [{ item, price: buyPrice(def) }];
    });
    session.socket.send(encodeServerMessage({ type: ServerMessageType.Shop, data: { offers } }));
  }

  /**
   * Compra/venda na Loja do Ferreiro ([JOGO-23]): a zona confere a distância e mexe nas moedas (`Zone.shopTrade`);
   * aqui salva o inventário e responde `shop_result` + `inventory`. Só a mochila muda (nada vestido), então o
   * loadout da zona fica igual.
   */
  private async handleShop(session: Session, action: "buy" | "sell", id: string): Promise<void> {
    const zone: Zone | null = session.zone;
    if (session.account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const playerId: string = session.account.playerId;
    const result = zone.shopTrade(playerId, session.account.inventory, action, id);
    if (!result.ok) {
      this.sendError(session, GameServer.SHOP_ERRORS[result.reason], GameServer.SHOP_MESSAGES[result.reason]);
      return;
    }
    // O onProgress da zona já trocou as moedas na sessão: lê a conta de novo antes de mexer nela.
    const account: Account | null = session.account;
    if (account === null) return;
    session.account = { ...account, inventory: result.inventory };
    try {
      await this.options.accounts.saveInventory(playerId, result.inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário (loja) de ${account.username}:`, error);
    }
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(
        encodeServerMessage({ type: ServerMessageType.ShopResult, data: { action, itemId: result.itemId, gold: Math.abs(result.goldDelta) } }),
      );
    }
    this.sendInventory(session);
    zone.tradeBelongingsChanged(playerId);
  }

  // --- Mercado ([JOGO-25]) ---

  /** Anúncio visto pelo cliente. */
  private static listingView(listing: Listing, nowMs: number): MarketListingView | null {
    const item: ItemView | null = itemView(listing.item);
    if (item === null) return null;
    const status = listingStatus(listing, nowMs);
    return {
      id: listing.id, item, price: listing.price, fee: listing.fee, sellerName: listing.sellerName, status,
      expiresIn: status === "active" ? Math.ceil((listing.expiresAt - nowMs) / 1000) : 0,
      buyerName: listing.buyerName,
    };
  }

  private sendMarketPage(session: Session, query: string, slot: EquipSlotName | null, sort: "price" | "new", page: number): void {
    if (session.account === null || session.socket.readyState !== WebSocket.OPEN) return;
    const now: number = Date.now();
    const found = this.market.search(query, slot, sort, page, now);
    const listings: MarketListingView[] = found.listings.flatMap((l) => GameServer.listingView(l, now) ?? []);
    session.socket.send(encodeServerMessage({ type: ServerMessageType.MarketPage, data: { listings, total: found.total, page, pageSize: MARKET_PAGE_SIZE } }));
  }

  private sendMarketMine(session: Session): void {
    if (session.account === null || session.socket.readyState !== WebSocket.OPEN) return;
    const now: number = Date.now();
    this.market.prune(now);
    const listings: MarketListingView[] = this.market.mine(session.account.playerId, now).flatMap((l) => GameServer.listingView(l, now) ?? []);
    session.socket.send(encodeServerMessage({ type: ServerMessageType.MarketMineList, data: { listings, maxListings: MAX_LISTINGS } }));
  }

  private sendMarketSold(playerId: string, sale: Listing): void {
    this.sendTo(playerId, {
      type: ServerMessageType.MarketSold,
      data: { itemName: getItem(sale.item.itemId)?.name ?? "Item", price: sale.price, buyerName: sale.buyerName ?? "alguém" },
    });
  }

  /** Sessão na zona e perto do Mercador; senão manda o erro e devolve `null`. */
  private marketContext(session: Session): { readonly account: Account; readonly zone: Zone } | null {
    const account: Account | null = session.account;
    const zone: Zone | null = session.zone;
    if (account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return null;
    }
    if (!zone.nearMarket(account.playerId)) {
      this.sendError(session, ErrorCode.TooFar, "Chegue perto do Mercador.");
      return null;
    }
    return { account, zone };
  }

  /** Grava o inventário novo na sessão e no banco e manda ao cliente (Mercado: só a mochila muda). */
  private async saveBag(session: Session, inventory: Account["inventory"], zone: Zone): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) return;
    session.account = { ...account, inventory };
    try {
      await this.options.accounts.saveInventory(account.playerId, inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário (mercado) de ${account.username}:`, error);
    }
    this.sendInventory(session);
    zone.tradeBelongingsChanged(account.playerId);
  }

  private sendMarketResult(session: Session, data: MarketResultData): void {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(encodeServerMessage({ type: ServerMessageType.MarketResult, data }));
  }

  /**
   * Anunciar: item da MOCHILA (vestido não), preço válido, abaixo do limite de anúncios e com moedas para a taxa de 5%
   * (paga agora). O item sai da mochila e fica com o mercado.
   */
  private async handleMarketSell(session: Session, uid: string, price: number): Promise<void> {
    const context = this.marketContext(session);
    if (context === null) return;
    const { account, zone } = context;
    const me: string = account.playerId;
    if (!isValidPrice(price)) return this.sendError(session, ErrorCode.InvalidPrice, "Preço de 1 a 1.000.000.000 moedas.");
    const index: number = account.inventory.bag.findIndex((stack) => stack.uid === uid);
    const stack = account.inventory.bag[index];
    if (stack === undefined) {
      const worn: boolean = Object.values(account.inventory.equipped).some((item) => item?.uid === uid);
      return worn ? this.sendError(session, ErrorCode.ItemEquipped, "Tire o item antes de anunciar.") : this.sendError(session, ErrorCode.ItemNotFound, "Esse item não está na mochila.");
    }
    if (this.market.openCount(me) >= MAX_LISTINGS) return this.sendError(session, ErrorCode.TooManyListings, `Você já tem ${MAX_LISTINGS} anúncios.`);
    const fee: number = listingFee(price);
    if (!zone.spendGold(me, fee)) return this.sendError(session, ErrorCode.NotEnoughGold, `Você precisa de ${fee} moedas para a taxa.`);
    const created: Listing | MarketFailure = this.market.create(me, account.username, stack, price, fee, Date.now());
    if (typeof created === "string") {
      zone.addGold(me, fee);
      return this.sendError(session, ErrorCode.TooManyListings, `Você já tem ${MAX_LISTINGS} anúncios.`);
    }
    // O spendGold trocou as moedas na sessão (onProgress): lê a conta de novo.
    const fresh: Account = session.account ?? account;
    await this.saveBag(session, { ...fresh.inventory, bag: fresh.inventory.bag.filter((item) => item.uid !== uid) }, zone);
    this.sendMarketResult(session, { action: "sell", itemName: getItem(stack.itemId)?.name ?? "Item", price, gold: fee });
    this.sendMarketMine(session);
  }

  /**
   * Comprar: anúncio ativo de outro jogador, espaço na mochila e moedas. Tudo síncrono até marcar como vendido (dois
   * compradores ao mesmo tempo → só um leva). As moedas vão para o vendedor: pela zona se está online, direto no banco
   * se não (o aviso chega quando ele entrar).
   */
  private async handleMarketBuy(session: Session, listingId: string): Promise<void> {
    const context = this.marketContext(session);
    if (context === null) return;
    const { account, zone } = context;
    const me: string = account.playerId;
    const listing: Listing | undefined = this.market.get(listingId);
    if (listing === undefined || listingStatus(listing, Date.now()) !== "active") return this.sendError(session, ErrorCode.ListingGone, "Esse anúncio não está mais à venda.");
    if (listing.sellerId === me) return this.sendError(session, ErrorCode.OwnListing, "Esse anúncio é seu.");
    if (account.inventory.bag.length >= BAG_CAPACITY) return this.sendError(session, ErrorCode.BagFull, "Mochila cheia.");
    if (zone.goldOf(me) < listing.price) return this.sendError(session, ErrorCode.NotEnoughGold, "Moedas insuficientes.");
    const sold: Listing | MarketFailure = this.market.buy(listingId, me, account.username, Date.now());
    if (typeof sold === "string") return this.sendError(session, ErrorCode.ListingGone, "Esse anúncio não está mais à venda.");
    zone.spendGold(me, sold.price);
    const sellerZone: Zone | undefined = this.zoneOfPlayer(sold.sellerId);
    if (sellerZone !== undefined && sellerZone.addGold(sold.sellerId, sold.price)) {
      this.market.takeUnnotifiedSales(sold.sellerId);
      this.sendMarketSold(sold.sellerId, sold);
      const sellerSession: Session | undefined = this.online.get(sold.sellerId);
      if (sellerSession !== undefined) this.sendMarketMine(sellerSession);
    } else {
      this.options.accounts.addGold(sold.sellerId, sold.price).catch((error: unknown) => console.error(`[mercado] falha ao pagar ${sold.sellerId}:`, error));
    }
    const fresh: Account = session.account ?? account;
    await this.saveBag(session, { ...fresh.inventory, bag: [...fresh.inventory.bag, sold.item] }, zone);
    this.sendMarketResult(session, { action: "buy", itemName: getItem(sold.item.itemId)?.name ?? "Item", price: sold.price, gold: sold.price });
  }

  /** Cancelar (ativo) ou retirar (vencido) o seu anúncio: o item volta para a mochila e a taxa volta (decisão do dono). */
  private async handleMarketCancel(session: Session, listingId: string): Promise<void> {
    const context = this.marketContext(session);
    if (context === null) return;
    const { account, zone } = context;
    const found: Listing | MarketFailure = this.market.canWithdraw(listingId, account.playerId);
    if (typeof found === "string") return this.sendError(session, ErrorCode.ListingGone, "Esse anúncio não está mais aí.");
    if (account.inventory.bag.length >= BAG_CAPACITY) return this.sendError(session, ErrorCode.BagFull, "Mochila cheia: libere espaço para o item voltar.");
    this.market.withdraw(listingId);
    zone.addGold(account.playerId, found.fee);
    const fresh: Account = session.account ?? account;
    await this.saveBag(session, { ...fresh.inventory, bag: [...fresh.inventory.bag, found.item] }, zone);
    this.sendMarketResult(session, { action: "cancel", itemName: getItem(found.item.itemId)?.name ?? "Item", price: found.price, gold: found.fee });
    this.sendMarketMine(session);
  }

  /**
   * Chat ([SOC-09]): limpa o texto, acha quem recebe pelo canal e passa no anti-spam (só conta mensagem que tinha para
   * quem ir). Geral = quem está na mesma zona; Grupo = o grupo (zona); Guilda = membros online em qualquer zona;
   * Privado = um jogador pelo nome (fake "aceita" responde com eco, [SOC-01]); Global = todos online numa zona.
   * Quem mandou recebe a própria mensagem (a mesma `chat`), e é assim que ela aparece na tela dele.
   */
  private handleChat(session: Session, data: ChatSendData): void {
    const account: Account | null = session.account;
    const zone: Zone | null = session.zone;
    if (account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const me: string = account.playerId;
    const refuse = (reason: ChatRefusedReason, seconds: number = 0): void => {
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(encodeServerMessage({ type: ServerMessageType.ChatRefused, data: { channel: data.channel, reason, seconds } }));
      }
    };
    const text: string | null = cleanChatText(data.text);
    if (text === null) return refuse("invalid");

    let recipients: string[] = [];
    let to: string | null = null;
    let fakeEcho: { readonly id: string; readonly name: string } | null = null;
    switch (data.channel) {
      case "zone":
        recipients = [...this.online.values()].filter((other) => other.zone === zone && other.account !== null).map((other) => other.account?.playerId ?? "");
        break;
      case "group":
        recipients = [...zone.groupMembersOf(me)];
        if (recipients.length === 0) return refuse("not_in_group");
        break;
      case "guild": {
        const guild = this.guilds.guildOf(me);
        if (guild === null) return refuse("not_in_guild");
        recipients = (this.guilds.get(guild.id)?.members ?? []).map((member) => member.id);
        break;
      }
      case "private": {
        const wanted: string = (data.to ?? "").trim().toLowerCase();
        const target: Session | undefined = [...this.online.values()].find((other) => other.account?.username.toLowerCase() === wanted && other.zone !== null);
        if (target?.account !== undefined && target.account !== null && target.account.playerId !== me) {
          recipients = [me, target.account.playerId];
          to = target.account.username;
          break;
        }
        // Fake de teste ([SOC-01]): "aceita" responde com eco; o outro só recebe calado.
        for (const candidate of this.zones.values()) {
          for (const id of candidate.fakeIds()) {
            const name: string | undefined = candidate.fakeName(id);
            if (name !== undefined && name.toLowerCase() === wanted) {
              to = name;
              recipients = [me];
              if (candidate.autoReplyOf(id) === "accept") fakeEcho = { id, name };
            }
          }
        }
        if (to === null) return refuse("player_not_found");
        break;
      }
      case "global":
        recipients = [...this.online.values()].filter((other) => other.zone !== null && other.account !== null).map((other) => other.account?.playerId ?? "");
        break;
    }

    const check: ChatCheck = this.chatLimiter.check(me, data.channel, text, Date.now());
    if (!check.ok) return refuse(check.reason, check.seconds);
    const message: ServerMessage = {
      type: ServerMessageType.Chat,
      data: { channel: data.channel, fromId: me, from: account.username, level: zone.levelOf(me) ?? 0, guildTag: this.guilds.guildOf(me)?.tag ?? null, text, to },
    };
    for (const id of new Set([me, ...recipients])) this.sendTo(id, message);
    if (fakeEcho !== null) {
      this.sendTo(me, {
        type: ServerMessageType.Chat,
        data: { channel: "private", fromId: fakeEcho.id, from: fakeEcho.name, level: zone.levelOf(fakeEcho.id) ?? 0, guildTag: null, text: `Você disse: ${text}`, to: account.username },
      });
    }
  }

  /**
   * Armazém ([JOGO-26]): a zona confere a distância do baú e, na compra de aba, as moedas (`Zone.storageAction`);
   * aqui salva o inventário (mochila + armazém juntos) e manda o `inventory` novo. Nada vestido muda.
   */
  private async handleStorage(session: Session, action: "put" | "take" | "buyTab", uid: string): Promise<void> {
    const zone: Zone | null = session.zone;
    if (session.account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const playerId: string = session.account.playerId;
    const result = zone.storageAction(playerId, session.account.inventory, action, uid);
    if (!result.ok) {
      this.sendError(session, GameServer.STORAGE_ERRORS[result.reason], GameServer.STORAGE_MESSAGES[result.reason]);
      return;
    }
    // O onProgress da zona pode ter trocado as moedas na sessão: lê a conta de novo antes de mexer nela.
    const account: Account | null = session.account;
    if (account === null) return;
    session.account = { ...account, inventory: result.inventory };
    try {
      await this.options.accounts.saveInventory(playerId, result.inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário (armazém) de ${account.username}:`, error);
    }
    this.sendInventory(session);
    zone.tradeBelongingsChanged(playerId);
  }

  /** Código do protocolo para cada recusa do Armazém. */
  private static readonly STORAGE_ERRORS: Readonly<Record<StorageFailure | "too_far", ErrorCode>> = {
    item_not_found: ErrorCode.ItemNotFound,
    item_equipped: ErrorCode.ItemEquipped,
    storage_full: ErrorCode.StorageFull,
    bag_full: ErrorCode.BagFull,
    not_enough_gold: ErrorCode.NotEnoughGold,
    too_far: ErrorCode.TooFar,
  };

  /** Mensagens (em português) das recusas do Armazém. */
  private static readonly STORAGE_MESSAGES: Readonly<Record<StorageFailure | "too_far", string>> = {
    item_not_found: "Esse item não está aí.",
    item_equipped: "Tire o item antes de guardar.",
    storage_full: "Armazém cheio: compre outra aba.",
    bag_full: "Mochila cheia.",
    not_enough_gold: "Moedas insuficientes.",
    too_far: "Chegue perto do Armazém.",
  };

  /** Código do protocolo para cada recusa da Loja do Ferreiro. */
  private static readonly SHOP_ERRORS: Readonly<Record<ShopFailure | "too_far", ErrorCode>> = {
    item_not_found: ErrorCode.ItemNotFound,
    not_enough_gold: ErrorCode.NotEnoughGold,
    bag_full: ErrorCode.BagFull,
    item_equipped: ErrorCode.ItemEquipped,
    too_far: ErrorCode.TooFar,
  };

  /** Mensagens (em português) das recusas da Loja do Ferreiro. */
  private static readonly SHOP_MESSAGES: Readonly<Record<ShopFailure | "too_far", string>> = {
    item_not_found: "Esse item não existe ou não é seu.",
    not_enough_gold: "Moedas insuficientes.",
    bag_full: "Mochila cheia.",
    item_equipped: "Tire o item antes de vender.",
    too_far: "Chegue perto do ferreiro.",
  };

  /** Pontos que o item `uid` tinha em `attribute` (antes da melhoria). */
  private static pointsBefore(inventory: Account["inventory"], uid: string, attribute: AttributeId): number {
    const stacks = [...Object.values(inventory.equipped), ...inventory.bag];
    return stacks.find((stack) => stack !== null && stack.uid === uid)?.attrs?.[attribute] ?? 0;
  }

  /** Código do protocolo para cada recusa do ferreiro. */
  /**
   * Morte ([JOGO-21]): a zona já tirou moedas/XP. Aqui sorteia uma peça vestida (a roleta); se quebrou ({@link
   * ITEM_BREAK_CHANCE}), ela some do inventário (salva e manda o `inventory`). Depois manda o `death_report`.
   */
  private async handleDeath(session: Session, info: DeathInfo): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) return;
    const before = account.inventory;
    const equipped: DeathItemView[] = [];
    for (const slot of EQUIP_SLOTS) {
      const stack: ItemStack | null = before.equipped[slot];
      const view: ItemView | null = stack === null ? null : itemView(stack);
      if (view !== null) equipped.push({ slot, item: view });
    }
    const roll: ItemRoll = rollDeathItem(before, Math.random);
    const broken: EquipSlot | null = roll.broken ? roll.slot : null;
    if (broken !== null) {
      this.log(`[morte] ${account.username} perdeu ${before.equipped[broken]?.itemId ?? "?"} (quebrou)`);
      await this.changeInventory(session, (inventory) => ({ ok: true, inventory: breakEquipped(inventory, broken) }));
    }
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(
      encodeServerMessage({
        type: ServerMessageType.DeathReport,
        data: {
          killer: info.killer,
          goldLost: info.goldLost,
          xpLost: info.xpLost,
          levelsLost: info.levelsLost,
          equipped,
          pickedSlot: roll.slot,
          broken: roll.broken,
          autoRespawnSeconds: PLAYER_RESPAWN_SECONDS,
        },
      }),
    );
  }

  /**
   * Fusão no ferreiro ([JOGO-20]): perto dele, funde o item igual da mochila no escolhido. Aceita → atualiza a zona
   * (atributos/aparência), salva, manda `fuse_result` e o `inventory`.
   */
  private async handleFuse(session: Session, targetUid: string, materialUid: string): Promise<void> {
    const account: Account | null = session.account;
    const zone: Zone | null = session.zone;
    if (account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const result = zone.fuseItem(account.playerId, account.inventory, targetUid, materialUid);
    if (!result.ok) {
      this.sendError(session, GameServer.FUSE_ERRORS[result.reason], GameServer.FUSE_MESSAGES[result.reason]);
      return;
    }
    await this.changeInventory(session, () => ({ ok: true, inventory: result.inventory }));
    if (session.socket.readyState === WebSocket.OPEN) {
      const level: number = result.stack.level ?? 0;
      session.socket.send(
        encodeServerMessage({
          type: ServerMessageType.FuseResult,
          data: { uid: targetUid, levelsGained: result.levelsGained, xpGained: result.xpGained, level, xp: result.stack.xp ?? 0, xpNext: levelXp(level) },
        }),
      );
    }
  }

  private static readonly FUSE_ERRORS: Readonly<Record<FusionFailure | "too_far", ErrorCode>> = {
    item_not_found: ErrorCode.ItemNotFound,
    not_same_item: ErrorCode.NotSameItem,
    material_equipped: ErrorCode.MaterialEquipped,
    too_far: ErrorCode.TooFar,
  };

  /** Mensagens (em português) das recusas da fusão. */
  private static readonly FUSE_MESSAGES: Readonly<Record<FusionFailure | "too_far", string>> = {
    item_not_found: "Esse item não é seu.",
    not_same_item: "Só dá para fundir itens iguais.",
    material_equipped: "Tire o item antes de fundir.",
    too_far: "Chegue perto do ferreiro.",
  };

  /** Abrir o baú ([JOGO-19]): manda o que sobrou para o jogador (ou a recusa). */
  private handleChestOpen(session: Session, chestId: string): void {
    if (session.account === null || session.zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const loot: readonly LootEntry[] | ChestFailure = session.zone.chestLoot(session.account.playerId, chestId);
    if (typeof loot === "string") {
      this.sendError(session, GameServer.CHEST_ERRORS[loot], GameServer.CHEST_MESSAGES[loot]);
      return;
    }
    this.sendChestLoot(session, chestId, loot);
  }

  /**
   * Pegar do baú ([JOGO-19]): moedas a zona soma (vêm no `me`); item vai para o fim da mochila (salva e manda o
   * `inventory`). Mochila cheia recusa antes de tirar do baú. Depois manda o baú atualizado.
   */
  private async handleChestTake(session: Session, chestId: string, lootId: string): Promise<void> {
    const account: Account | null = session.account;
    const zone: Zone | null = session.zone;
    if (account === null || zone === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na zona antes");
      return;
    }
    const taken: TakenLoot | ChestFailure = zone.takeLoot(account.playerId, chestId, lootId, account.inventory.bag.length < BAG_CAPACITY);
    if (typeof taken === "string") {
      this.sendError(session, GameServer.CHEST_ERRORS[taken], GameServer.CHEST_MESSAGES[taken]);
      return;
    }
    if (taken.kind === "item") {
      const stack: ItemStack = taken.stack;
      await this.changeInventory(session, (inventory) => addToBag(inventory, stack));
    }
    const left: readonly LootEntry[] | ChestFailure = zone.chestLoot(account.playerId, chestId);
    this.sendChestLoot(session, chestId, typeof left === "string" ? [] : left);
  }

  private sendChestLoot(session: Session, chestId: string, entries: readonly LootEntry[]): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(encodeServerMessage({ type: ServerMessageType.ChestLoot, data: { chestId, entries: lootViews(entries) } }));
  }

  private static readonly CHEST_ERRORS: Readonly<Record<ChestFailure, ErrorCode>> = {
    chest_not_found: ErrorCode.ChestNotFound,
    chest_closed: ErrorCode.ChestClosed,
    too_far: ErrorCode.TooFar,
    loot_not_found: ErrorCode.LootNotFound,
    bag_full: ErrorCode.BagFull,
  };

  /** Mensagens (em português) das recusas do baú. */
  private static readonly CHEST_MESSAGES: Readonly<Record<ChestFailure, string>> = {
    chest_not_found: "Esse baú não existe.",
    chest_closed: "O baú está fechado: derrote o acampamento.",
    too_far: "Chegue perto do baú.",
    loot_not_found: "Isso não está mais no baú.",
    bag_full: "Mochila cheia: libere espaço e pegue de novo.",
  };

  private static readonly UPGRADE_ERRORS: Readonly<Record<UpgradeFailure | "too_far", ErrorCode>> = {
    item_not_found: ErrorCode.ItemNotFound,
    invalid_attribute: ErrorCode.InvalidAttribute,
    not_enough_gold: ErrorCode.NotEnoughGold,
    too_far: ErrorCode.TooFar,
  };

  /** Mensagens (em português) das recusas do ferreiro. */
  private static readonly UPGRADE_MESSAGES: Readonly<Record<UpgradeFailure | "too_far", string>> = {
    item_not_found: "Esse item não é seu.",
    invalid_attribute: "Esse item não aceita esse atributo.",
    not_enough_gold: "Moedas insuficientes.",
    too_far: "Chegue perto do ferreiro.",
  };

  /** Código do protocolo para cada recusa de `cast` (mesmos nomes). */
  private static readonly CAST_ERRORS: Readonly<Record<CastFailure, ErrorCode>> = {
    busy: ErrorCode.Busy,
    ability_not_equipped: ErrorCode.AbilityNotEquipped,
    ability_unavailable: ErrorCode.AbilityUnavailable,
    on_cooldown: ErrorCode.OnCooldown,
    not_enough_mana: ErrorCode.NotEnoughMana,
    invalid_target: ErrorCode.InvalidTarget,
    out_of_range: ErrorCode.OutOfRange,
  };

  /** Mensagens (em português) das recusas de inventário. */
  private static readonly INVENTORY_MESSAGES: Readonly<Record<InventoryFailure, string>> = {
    item_not_found: "Esse item não está na mochila.",
    bag_full: "Mochila cheia.",
    slot_empty: "Não há nada nesse slot.",
  };

  private static inventoryError(reason: InventoryFailure): ErrorCode {
    switch (reason) {
      case "item_not_found":
        return ErrorCode.ItemNotFound;
      case "bag_full":
        return ErrorCode.BagFull;
      case "slot_empty":
        return ErrorCode.SlotEmpty;
    }
  }

  /** O nome de slot do protocolo é o mesmo do catálogo (checado em compilação por esta função). */
  private static slotOf(slot: EquipSlotName): EquipSlot {
    return slot;
  }

  /** Encerra a sessão deste aparelho (o token deixa de valer) e fecha a conexão normalmente. */
  private async handleLogout(session: Session): Promise<void> {
    const token: string | null = session.sessionToken;
    if (token !== null) {
      try {
        await this.options.accounts.logout(token);
      } catch (error: unknown) {
        console.error(`[${session.connectionId}] falha no logout:`, error);
      }
    }
    session.socket.close(CloseCode.Normal, "logout");
  }

  /**
   * Escolha do corpo do personagem (uma vez só, antes do primeiro `join`). Salva no banco e responde `body_chosen`;
   * conta que já escolheu recebe `body_already_chosen`. Ver mmo-docs [INFRA-07].
   */
  private async handleChooseBody(session: Session, body: BodyType): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    if (account.body !== null) {
      this.sendError(session, ErrorCode.BodyAlreadyChosen, "O personagem já foi escolhido.");
      return;
    }
    let saved: boolean;
    try {
      saved = await this.options.accounts.chooseBody(account.playerId, body);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar o corpo de ${account.username}:`, error);
      this.reject(session, ErrorCode.ServerError, "erro no servidor");
      return;
    }
    if (!saved) {
      this.sendError(session, ErrorCode.BodyAlreadyChosen, "O personagem já foi escolhido.");
      return;
    }
    session.account = { ...account, body };
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(encodeServerMessage({ type: ServerMessageType.BodyChosen, data: { body } }));
    }
    this.log(`[auth] ${account.username} escolheu o corpo ${body}`);
  }

  private async handleJoin(session: Session, data: JoinData): Promise<void> {
    const account: Account | null = session.account;
    if (account === null) {
      this.sendError(session, ErrorCode.NotAuthenticated, "entre na conta antes");
      return;
    }
    if (account.body === null) {
      this.sendError(session, ErrorCode.BodyNotChosen, "Escolha seu personagem antes de entrar.");
      return;
    }
    const body: BodyType = account.body;
    if (session.zone !== null) {
      this.sendError(session, ErrorCode.AlreadyJoined, "já está numa zona");
      return;
    }
    const zone: Zone | undefined = this.zones.get(data.zone);
    if (zone === undefined) {
      this.reject(session, ErrorCode.UnknownZone, `zona "${data.zone}" não existe`);
      return;
    }

    const socket: WebSocket = session.socket;
    const result: JoinResult = zone.join(
      {
        id: account.playerId,
        name: account.username,
        body,
        send: (text: string): void => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        // Matou um monstro ([JOGO-12]): guarda o nível/XP novo na sessão (próxima entrada) e no banco.
        onProgress: (progress: Progress): void => {
          const levelChanged: boolean = session.account !== null && session.account.progress.level !== progress.level;
          if (session.account !== null) session.account = { ...session.account, progress };
          // Subiu/desceu de nível: a lista da guilda mostra o nível novo ([SOC-06]).
          if (levelChanged) this.guilds.refreshMember(account.playerId);
          this.options.accounts.saveProgress(account.playerId, progress).catch((error: unknown) => {
            console.error(`[${session.connectionId}] falha ao salvar nível/XP de ${account.username}:`, error);
          });
        },
        // Contadores do perfil ([SOC-08]): na sessão (próxima entrada) e no banco.
        onStats: (stats: PlayerStats): void => {
          const current: Account | null = session.account;
          if (current === null) return;
          // Rankings do dia/semana ([SOC-07]): soma só o que aumentou agora (XP de monstros, jogadores mortos).
          const periods: PeriodCounters = addToPeriods(current.periods, stats.monsterXp - current.stats.monsterXp, stats.kills - current.stats.kills, Date.now());
          session.account = { ...current, stats, periods };
          this.options.accounts.saveStats(account.playerId, stats, periods).catch((error: unknown) => {
            console.error(`[${session.connectionId}] falha ao salvar os contadores de ${account.username}:`, error);
          });
        },
        // Morreu ([JOGO-21]): sorteia a peça da roleta (pode quebrar) e manda a tela de morte.
        onDeath: (info: DeathInfo): void => {
          void this.handleDeath(session, info);
        },
        // Configuração → "Convites de grupo: Ocultar" ([SOC-04]): lido a cada convite, então mudar vale na hora.
        hidesGroupInvites: (): boolean => session.account?.social.groupInvites === "hide",
        // Troca ([SOC-05]): "Pedidos de troca: Ocultar", a mochila da conta e o resultado.
        hidesTradeRequests: (): boolean => session.account?.social.tradeRequests === "hide",
        bag: (): readonly ItemStack[] => session.account?.inventory.bag ?? [],
        onTradeBag: (bag: readonly ItemStack[]): void => {
          void this.applyTradeBag(session, bag);
        },
      },
      GameServer.spawnFrom(account.lastPosition, zone),
      basicAttackOf(account.inventory),
      equippedAbilities(account.inventory),
      lookOf(account.inventory),
      bonusHpOf(account.inventory),
      account.progress,
      attributeEffectsOf(account.inventory),
      lookLevelsOf(account.inventory),
      account.stats,
    );
    if (result.status === "full") {
      this.reject(session, ErrorCode.ZoneFull, "zona lotada");
      return;
    }

    session.zone = zone;
    socket.send(
      encodeServerMessage({
        type: ServerMessageType.Welcome,
        data: {
          playerId: account.playerId,
          zone: zone.config.id,
          tick: zone.tickNumber,
          sim: zone.simParams,
          pvp: zone.config.pvp,
          players: result.players,
          npcs: zone.npcSnapshots(),
          chests: zone.chestViews(),
        },
      }),
    );
    void this.sendFriends(account.playerId);
    // Tag da guilda no nome para a zona inteira ([SOC-06]) e o nível dele na lista da guilda.
    zone.setGuild(account.playerId, this.guilds.guildOf(account.playerId));
    this.guilds.refreshMember(account.playerId);
    // Mercado ([JOGO-25]): o que vendeu enquanto estava fora (as moedas já entraram na conta).
    for (const sale of this.market.takeUnnotifiedSales(account.playerId)) this.sendMarketSold(account.playerId, sale);
    this.log(`[${zone.config.id}] ${account.username} entrou (${zone.size} online)`);
  }

  /** Tira a sessão da zona e salva a posição. Pode ser chamada mais de uma vez. */
  private async leaveZone(session: Session): Promise<void> {
    const zone: Zone | null = session.zone;
    const account: Account | null = session.account;
    session.zone = null;
    if (zone === null || account === null) return;

    const playerId: string = account.playerId;
    const snapshot: PlayerSnapshot | undefined = zone.getSnapshot(playerId);
    zone.leave(playerId);
    if (snapshot === undefined) return;

    const position: SavedPosition = { zone: zone.config.id, x: snapshot.x, y: snapshot.y, z: snapshot.z, rotY: snapshot.rotY };
    // A conta em memória da sessão também é atualizada: um `join` na mesma conexão volta aqui.
    session.account = { ...account, lastPosition: position };
    try {
      await this.options.accounts.savePosition(playerId, position);
    } catch (error: unknown) {
      console.error(`[${zone.config.id}] falha ao salvar posição de ${account.username}:`, error);
    }
  }

  /** Volta à última posição se ela for desta zona; senão, spawn padrão (aleatório perto do centro). */
  private static spawnFrom(last: SavedPosition | null, zone: Zone): SpawnPoint | undefined {
    if (last === null || last.zone !== zone.config.id) return undefined;
    return { x: last.x, y: last.y, z: last.z, rotY: last.rotY };
  }

  private sendError(session: Session, code: ErrorCode, message: string): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(encodeServerMessage({ type: ServerMessageType.Error, data: { code, message } }));
  }

  /**
   * Versão publicada do pacote do jogo se `client` está rodando uma MENOR (precisa atualizar); senão `undefined`.
   * Dev (`pack` 0), cliente que não disse o pacote e plataforma sem manifesto nunca precisam ([INFRA-08]).
   */
  private outdatedBy(client: ClientBuild | null): number | undefined {
    if (client === null || client.pack <= 0) return undefined;
    const published: number | undefined = this.updates.latestVersion(client.platform);
    return published !== undefined && client.pack < published ? published : undefined;
  }

  /**
   * Manda o cliente atualizar: `update_required { version }`, sai da zona (salvando a posição) e fecha com
   * {@link CloseCode.UpdateRequired}. O cliente baixa o pacote novo sozinho e entra de novo com a sessão salva.
   */
  private requireUpdate(session: Session, version: number): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(encodeServerMessage({ type: ServerMessageType.UpdateRequired, data: { version } }));
    }
    void this.leaveZone(session);
    session.dropReason = `pacote ${session.client?.pack ?? "?"} desatualizado (publicado ${version})`;
    this.closeSoon(session, CloseCode.UpdateRequired, "update_required");
    const who: string = session.account?.username ?? session.connectionId;
    this.log(`[update] ${who} (${session.client?.platform ?? "?"} pacote ${session.client?.pack ?? "?"}) mandado atualizar para ${version}`);
  }

  /** Versão nova do pacote publicada para `platform`: quem está conectado com uma menor é mandado atualizar. */
  private onPackPublished(platform: string, version: number): void {
    this.log(`[update] ${platform}: versão ${version} publicada`);
    for (const session of this.sessions) {
      if (!session.closing && session.client?.platform === platform && this.outdatedBy(session.client) !== undefined) {
        this.requireUpdate(session, version);
      }
    }
  }

  /** Envia `error` e fecha a conexão com {@link CloseCode.Rejected} (depois de {@link CLOSE_DELAY_MS}). */
  private reject(session: Session, code: ErrorCode, message: string): void {
    this.sendError(session, code, message);
    this.closeSoon(session, CloseCode.Rejected, code);
  }

  /**
   * Fecha a conexão com `code` daqui a {@link CLOSE_DELAY_MS} (dá tempo de o cliente ler a mensagem que explica o
   * motivo) e, até lá, ignora o que ela mandar.
   */
  private closeSoon(session: Session, code: number, reason: string): void {
    session.closing = true;
    setTimeout(() => session.socket.close(code, reason), CLOSE_DELAY_MS).unref();
  }

  /** Escreve no console (se `options.log`), com a hora na frente (para ver quanto tempo passou entre eventos). */
  private log(text: string): void {
    if (this.options.log) console.log(`${new Date().toLocaleTimeString("pt-BR")} ${text}`);
  }
}

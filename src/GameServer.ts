import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import {
  ClientMessageType,
  CloseCode,
  ErrorCode,
  PROTOCOL_VERSION,
  ServerMessageType,
  encodeServerMessage,
  parseClientMessage,
  type BodyType,
  type ClientMessage,
  type JoinData,
  type LoginData,
  type PlayerSnapshot,
  type RegisterData,
  type ResumeData,
  type EquipSlotName,
} from "./net/protocol.js";
import { Zone, type CastFailure, type CastResult, type JoinResult, type SpawnPoint, type ZoneConfig } from "./zones/Zone.js";
import { ZONE_CONFIGS } from "./zones/zones.js";
import { TICK_RATE_HZ } from "./sim/movement.js";
import type { Account, AccountStore, AuthSuccess, RegisterResult, SavedPosition } from "./accounts/AccountStore.js";
import type { EquipSlot } from "./items/catalog.js";
import { isValidEmail, isValidPassword, isValidUsername } from "./accounts/credentials.js";
import { DEFAULT_UPDATES_DIR, UPDATES_ROUTE, serveUpdateFile } from "./http/updates.js";
import { basicAttackOf, equip, equippedAbilities, lookOf, unequip, type InventoryFailure, type InventoryResult } from "./items/inventory.js";
import { inventoryView } from "./items/view.js";

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
}

/** Tamanho máximo de uma mensagem do cliente, em bytes. Maior que isso, o `ws` fecha a conexão (1009). */
const MAX_MESSAGE_BYTES = 4096;

/** Falhas de login/sessão aceitas por conexão antes de fechá-la (freio contra adivinhar senha). */
export const MAX_AUTH_FAILURES = 5;

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
}

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
  /** Sessão autenticada de cada jogador. Garante uma conexão por conta. */
  private readonly online: Map<string, Session> = new Map();
  private readonly options: Required<GameServerOptions>;
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: GameServerOptions) {
    this.options = {
      accounts: options.accounts,
      zones: options.zones ?? ZONE_CONFIGS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      log: options.log ?? true,
      updatesDir: options.updatesDir ?? DEFAULT_UPDATES_DIR,
    };
    for (const config of this.options.zones) this.zones.set(config.id, new Zone(config));

    this.http = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on("connection", (socket: WebSocket) => this.handleConnection(socket));
  }

  /**
   * Começa a escutar e liga os timers de tick e heartbeat.
   * @param port porta TCP; `0` escolhe uma livre (útil em testes).
   * @returns a porta efetivamente usada.
   */
  listen(port: number): Promise<number> {
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
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
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
    this.tickTimer = setInterval(() => {
      for (const zone of this.zones.values()) zone.tick();
    }, 1000 / TICK_RATE_HZ);

    // Celular perde rede sem fechar o socket: sem heartbeat, o jogador ficaria "fantasma" na zona.
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.sessions) {
        if (!session.alive) {
          session.socket.close(CloseCode.Timeout, "heartbeat timeout");
          session.socket.terminate();
          continue;
        }
        session.alive = false;
        session.socket.ping();
      }
    }, this.options.heartbeatIntervalMs);
  }

  /**
   * `GET /health`: 200 "ok" se o banco responde; 503 "db down" se não.
   * `GET /updates/<plataforma>/<arquivo>`: arquivos do atualizador (ver `src/http/updates.ts`).
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url: string = req.url ?? "";
    if (req.method === "GET" && url.startsWith(UPDATES_ROUTE)) {
      const relativePath: string = url.slice(UPDATES_ROUTE.length).split("?")[0] ?? "";
      await serveUpdateFile(relativePath, this.options.updatesDir, res);
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
    };
    this.sessions.add(session);

    socket.on("pong", () => {
      session.alive = true;
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
      if (account !== null && this.online.get(account.playerId) === session) this.online.delete(account.playerId);
      const zoneId: string | undefined = session.zone?.config.id;
      void this.leaveZone(session).then(() => {
        if (zoneId !== undefined && account !== null) {
          this.log(`[${zoneId}] ${account.username} saiu (code ${code}, ${this.zones.get(zoneId)?.size ?? 0} online)`);
        }
      });
    });
    socket.on("error", () => {
      // O "close" vem logo depois; registrar o handler evita que o erro derrube o processo.
    });
  }

  private handleMessage(session: Session, message: ClientMessage): void {
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
        void this.changeInventory(session, (inventory) => unequip(inventory, GameServer.slotOf(message.data.slot)));
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
    }
  }

  /**
   * Checagens comuns antes de autenticar. Devolve `false` (e já respondeu) se não pode seguir.
   * Versão errada fecha a conexão: um cliente desatualizado não deve nem tentar.
   */
  private canAuthenticate(session: Session, version: number): boolean {
    if (session.account !== null) {
      this.sendError(session, ErrorCode.AlreadyAuthenticated, "já autenticado");
      return false;
    }
    if (session.authenticating) {
      this.sendError(session, ErrorCode.BadMessage, "autenticação em andamento");
      return false;
    }
    if (version !== PROTOCOL_VERSION) {
      this.reject(session, ErrorCode.VersionMismatch, `protocolo ${version}, servidor usa ${PROTOCOL_VERSION}`);
      return false;
    }
    return true;
  }

  private async handleRegister(session: Session, data: RegisterData): Promise<void> {
    if (!this.canAuthenticate(session, data.version)) return;
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
    if (!this.canAuthenticate(session, data.version)) return;
    const result: AuthSuccess | null | undefined = await this.runAuth(session, () =>
      this.options.accounts.login(data.login, data.password),
    );
    if (result === undefined) return;
    if (result === null) return this.authError(session, ErrorCode.InvalidCredentials, true);
    this.authenticated(session, result.account, result.sessionToken, "login");
  }

  private async handleResume(session: Session, data: ResumeData): Promise<void> {
    if (!this.canAuthenticate(session, data.version)) return;
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
    session.account = account;
    session.sessionToken = sessionToken;
    this.online.set(account.playerId, session);
    session.socket.send(
      encodeServerMessage({
        type: ServerMessageType.AuthOk,
        data: { playerId: account.playerId, username: account.username, sessionToken, body: account.body },
      }),
    );
    this.sendInventory(session);
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
    );
    try {
      await this.options.accounts.saveInventory(account.playerId, result.inventory);
    } catch (error: unknown) {
      console.error(`[${session.connectionId}] falha ao salvar inventário de ${account.username}:`, error);
    }
    this.sendInventory(session);
  }

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
      },
      GameServer.spawnFrom(account.lastPosition, zone),
      basicAttackOf(account.inventory),
      equippedAbilities(account.inventory),
      lookOf(account.inventory),
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
        },
      }),
    );
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

  /** Envia `error` e fecha a conexão com {@link CloseCode.Rejected}. */
  private reject(session: Session, code: ErrorCode, message: string): void {
    this.sendError(session, code, message);
    session.socket.close(CloseCode.Rejected, code);
  }

  private log(text: string): void {
    if (this.options.log) console.log(text);
  }
}

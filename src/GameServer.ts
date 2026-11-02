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
  type ClientMessage,
  type JoinData,
  type PlayerSnapshot,
} from "./net/protocol.js";
import { Zone, type JoinResult, type SpawnPoint, type ZoneConfig } from "./zones/Zone.js";
import { ZONE_CONFIGS } from "./zones/zones.js";
import type { AccountStore, GuestLogin, SavedPosition } from "./accounts/AccountStore.js";
import { DEFAULT_UPDATES_DIR, UPDATES_ROUTE, serveUpdateFile } from "./http/updates.js";

/** Opções do {@link GameServer}. Os padrões servem para produção; os testes usam valores menores. */
export interface GameServerOptions {
  /** Onde ficam as contas (MongoDB no jogo, memória nos testes). Obrigatório. */
  readonly accounts: AccountStore;
  /** Zonas criadas ao subir. Padrão: {@link ZONE_CONFIGS}. */
  readonly zones?: readonly ZoneConfig[];
  /** Quantas vezes por segundo cada zona envia o lote `positions`. Padrão: 20 Hz. */
  readonly tickRateHz?: number;
  /** Intervalo do ping de heartbeat, em ms. Quem não responder até o próximo é desconectado. Padrão: 10 000 ms. */
  readonly heartbeatIntervalMs?: number;
  /** Escreve as entradas/saídas no console. Padrão: `true`. */
  readonly log?: boolean;
  /** Pasta servida em `/updates/` (manifesto + pacotes do jogo). Padrão: `updates`. Ver mmo-docs [INFRA-08]. */
  readonly updatesDir?: string;
}

/** Tamanho máximo de uma mensagem do cliente, em bytes. Maior que isso, o `ws` fecha a conexão (1009). */
const MAX_MESSAGE_BYTES = 4096;

/** Uma conexão WebSocket aberta. */
interface Session {
  /** Id da conexão (só para log/diagnóstico; o jogo usa o `playerId`). */
  readonly connectionId: string;
  readonly socket: WebSocket;
  /** Id público do jogador; `null` até o `join` ser aceito. */
  playerId: string | null;
  /** Zona em que entrou; `null` até o `join` ser aceito. */
  zone: Zone | null;
  /** Um `join` está sendo processado (consulta ao banco em andamento). */
  joining: boolean;
  /** Respondeu ao último ping do heartbeat. */
  alive: boolean;
}

/**
 * Servidor do jogo: HTTP (`GET /health`, `GET /updates/*`) + WebSocket na mesma porta.
 *
 * Cada conexão vira uma {@link Session}. O `join` faz o login de convidado no
 * {@link AccountStore} e coloca o jogador na {@link Zone} (na última posição salva,
 * se houver). Ao sair, a posição é salva. Protocolo: `src/net/protocol.ts` e mmo-docs [INFRA-04].
 */
export class GameServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly zones: Map<string, Zone> = new Map();
  private readonly sessions: Set<Session> = new Set();
  /** Sessão ativa de cada jogador em jogo. Garante uma conexão por conta. */
  private readonly online: Map<string, Session> = new Map();
  private readonly options: Required<GameServerOptions>;
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: GameServerOptions) {
    this.options = {
      accounts: options.accounts,
      zones: options.zones ?? ZONE_CONFIGS,
      tickRateHz: options.tickRateHz ?? 20,
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
    }, 1000 / this.options.tickRateHz);

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
      playerId: null,
      zone: null,
      joining: false,
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
      const zoneId: string | undefined = session.zone?.config.id;
      const playerId: string | null = session.playerId;
      void this.leaveZone(session).then(() => {
        if (zoneId !== undefined && playerId !== null) {
          this.log(`[${zoneId}] ${playerId} saiu (code ${code}, ${this.zones.get(zoneId)?.size ?? 0} online)`);
        }
      });
    });
    socket.on("error", () => {
      // O "close" vem logo depois; registrar o handler evita que o erro derrube o processo.
    });
  }

  private handleMessage(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case ClientMessageType.Join:
        void this.handleJoin(session, message.data);
        return;
      case ClientMessageType.Move:
        if (session.zone !== null && session.playerId !== null) session.zone.move(session.playerId, message.data);
        return;
    }
  }

  private async handleJoin(session: Session, data: JoinData): Promise<void> {
    if (session.zone !== null || session.joining) {
      this.sendError(session, ErrorCode.AlreadyJoined, "já está numa zona");
      return;
    }
    if (data.version !== PROTOCOL_VERSION) {
      this.reject(session, ErrorCode.VersionMismatch, `protocolo ${data.version}, servidor usa ${PROTOCOL_VERSION}`);
      return;
    }
    const zone: Zone | undefined = this.zones.get(data.zone);
    if (zone === undefined) {
      this.reject(session, ErrorCode.UnknownZone, `zona "${data.zone}" não existe`);
      return;
    }

    session.joining = true;
    let login: GuestLogin;
    try {
      login = await this.options.accounts.loginGuest(data.guestToken);
    } catch (error: unknown) {
      session.joining = false;
      console.error(`[${session.connectionId}] falha no login de convidado:`, error);
      this.reject(session, ErrorCode.ServerError, "falha ao acessar as contas");
      return;
    }
    session.joining = false;
    // A conexão pode ter caído enquanto o banco respondia.
    if (session.socket.readyState !== WebSocket.OPEN) return;

    const playerId: string = login.account.playerId;
    const previous: Session | undefined = this.online.get(playerId);
    if (previous !== undefined) {
      // Mesma conta em outra conexão: a antiga sai (salvando a posição) antes de a nova entrar.
      await this.leaveZone(previous);
      previous.socket.close(CloseCode.Replaced, "entrou em outra conexão");
    }

    const socket: WebSocket = session.socket;
    const result: JoinResult = zone.join(
      {
        id: playerId,
        send: (text: string): void => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
      },
      GameServer.spawnFrom(login.account.lastPosition, zone),
    );
    if (result.status === "full") {
      this.reject(session, ErrorCode.ZoneFull, "zona lotada");
      return;
    }

    session.playerId = playerId;
    session.zone = zone;
    this.online.set(playerId, session);
    const players: PlayerSnapshot[] = result.players;
    socket.send(
      encodeServerMessage({
        type: ServerMessageType.Welcome,
        data: { playerId, guestToken: login.guestToken, zone: zone.config.id, players },
      }),
    );
    this.log(`[${zone.config.id}] ${playerId} entrou${login.created ? " (conta nova)" : ""} (${zone.size} online)`);
  }

  /** Tira a sessão da zona e salva a posição. Pode ser chamada mais de uma vez. */
  private async leaveZone(session: Session): Promise<void> {
    const zone: Zone | null = session.zone;
    const playerId: string | null = session.playerId;
    session.zone = null;
    session.playerId = null;
    if (zone === null || playerId === null) return;

    const snapshot: PlayerSnapshot | undefined = zone.getSnapshot(playerId);
    zone.leave(playerId);
    if (this.online.get(playerId) === session) this.online.delete(playerId);
    if (snapshot === undefined) return;

    const position: SavedPosition = { zone: zone.config.id, x: snapshot.x, y: snapshot.y, z: snapshot.z, rotY: snapshot.rotY };
    try {
      await this.options.accounts.savePosition(playerId, position);
    } catch (error: unknown) {
      console.error(`[${zone.config.id}] falha ao salvar posição de ${playerId}:`, error);
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

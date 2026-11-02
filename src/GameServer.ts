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
} from "./net/protocol.js";
import { Zone, type JoinResult, type ZoneConfig } from "./zones/Zone.js";
import { ZONE_CONFIGS } from "./zones/zones.js";

/** Opções do {@link GameServer}. Os padrões servem para produção; os testes usam valores menores. */
export interface GameServerOptions {
  /** Zonas criadas ao subir. Padrão: {@link ZONE_CONFIGS}. */
  readonly zones?: readonly ZoneConfig[];
  /** Quantas vezes por segundo cada zona envia o lote `positions`. Padrão: 20 Hz. */
  readonly tickRateHz?: number;
  /** Intervalo do ping de heartbeat, em ms. Quem não responder até o próximo é desconectado. Padrão: 10 000 ms. */
  readonly heartbeatIntervalMs?: number;
  /** Escreve as entradas/saídas no console. Padrão: `true`. */
  readonly log?: boolean;
}

/** Tamanho máximo de uma mensagem do cliente, em bytes. Maior que isso, o `ws` fecha a conexão (1009). */
const MAX_MESSAGE_BYTES = 4096;

/** Uma conexão WebSocket aberta. */
interface Session {
  readonly id: string;
  readonly socket: WebSocket;
  /** Zona em que entrou; `null` até o `join` ser aceito. */
  zone: Zone | null;
  /** Respondeu ao último ping do heartbeat. */
  alive: boolean;
}

/**
 * Servidor do jogo: HTTP (`GET /health`) + WebSocket na mesma porta.
 *
 * Cada conexão vira uma {@link Session}. As mensagens são validadas por
 * {@link parseClientMessage} e repassadas à {@link Zone} da sessão.
 * Protocolo: `src/net/protocol.ts` e mmo-docs [INFRA-04].
 */
export class GameServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly zones: Map<string, Zone> = new Map();
  private readonly sessions: Set<Session> = new Set();
  private readonly options: Required<GameServerOptions>;
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: GameServerOptions = {}) {
    this.options = {
      zones: options.zones ?? ZONE_CONFIGS,
      tickRateHz: options.tickRateHz ?? 20,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      log: options.log ?? true,
    };
    for (const config of this.options.zones) this.zones.set(config.id, new Zone(config));

    this.http = createServer((req: IncomingMessage, res: ServerResponse) => this.handleHttp(req, res));
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

  /** Para os timers, fecha todas as conexões e o servidor HTTP. */
  close(): Promise<void> {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    for (const session of this.sessions) session.socket.terminate();
    return new Promise((resolve) => {
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

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  }

  private handleConnection(socket: WebSocket): void {
    const session: Session = { id: randomBytes(6).toString("base64url"), socket, zone: null, alive: true };
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
      if (session.zone !== null) {
        session.zone.leave(session.id);
        this.log(`[${session.zone.config.id}] ${session.id} saiu (code ${code}, ${session.zone.size} online)`);
        session.zone = null;
      }
    });
    socket.on("error", () => {
      // O "close" vem logo depois; registrar o handler evita que o erro derrube o processo.
    });
  }

  private handleMessage(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case ClientMessageType.Join:
        this.handleJoin(session, message.data);
        return;
      case ClientMessageType.Move:
        session.zone?.move(session.id, message.data);
        return;
    }
  }

  private handleJoin(session: Session, data: JoinData): void {
    if (session.zone !== null) {
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
    const socket: WebSocket = session.socket;
    const result: JoinResult = zone.join({
      id: session.id,
      send: (text: string): void => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
    });
    if (result === "full") {
      this.reject(session, ErrorCode.ZoneFull, "zona lotada");
      return;
    }
    session.zone = zone;
    this.log(`[${zone.config.id}] ${session.id} entrou (${zone.size} online)`);
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

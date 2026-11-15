import { WebSocket, type RawData } from "ws";
import type { ZoneConfig } from "../src/zones/Zone.js";
import { TEST_FAKE_PLAYERS, ZONE_CONFIGS } from "../src/zones/zones.js";

/** Mensagem recebida do servidor, decodificada mas sem validação (só para testes). */
export interface ReceivedMessage {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Cliente WebSocket de teste: guarda as mensagens recebidas e permite esperar por um tipo.
 */
export class TestClient {
  private readonly inbox: ReceivedMessage[] = [];
  private readonly waiters: Array<{ type: string; resolve: (m: ReceivedMessage) => void }> = [];
  /** Close code recebido, ou `null` enquanto aberto. */
  closeCode: number | null = null;
  private readonly closed: Promise<number>;

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: RawData) => {
      const decoded: unknown = JSON.parse(raw.toString());
      if (!isRecord(decoded) || typeof decoded["type"] !== "string" || !isRecord(decoded["data"])) {
        throw new Error(`mensagem fora do formato: ${raw.toString()}`);
      }
      const message: ReceivedMessage = { type: decoded["type"], data: decoded["data"] };
      const index: number = this.waiters.findIndex((w) => w.type === message.type);
      const waiter = index >= 0 ? this.waiters.splice(index, 1)[0] : undefined;
      if (waiter !== undefined) waiter.resolve(message);
      else this.inbox.push(message);
    });
    this.closed = new Promise((resolve) => {
      socket.on("close", (code: number) => {
        this.closeCode = code;
        resolve(code);
      });
    });
  }

  /** Abre uma conexão com o servidor local na porta `port`. */
  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.once("open", () => resolve(new TestClient(socket)));
      socket.once("error", reject);
    });
  }

  /** Envia `{type, data}` como JSON. */
  send(type: string, data: unknown): void {
    this.socket.send(JSON.stringify({ type, data }));
  }

  /** Próxima mensagem do tipo `type` (já recebida ou futura). Falha após `timeoutMs`. */
  next(type: string, timeoutMs: number = 2000): Promise<ReceivedMessage> {
    const index: number = this.inbox.findIndex((m) => m.type === type);
    const queued = index >= 0 ? this.inbox.splice(index, 1)[0] : undefined;
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => reject(new Error(`timeout esperando "${type}"`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m: ReceivedMessage) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /**
   * Próxima mensagem do tipo `type` que satisfaz `predicate` (descarta as que não satisfazem).
   * Útil para `snapshot`, que chega a cada tick.
   */
  async nextMatching(
    type: string,
    predicate: (message: ReceivedMessage) => boolean,
    timeoutMs: number = 2000,
  ): Promise<ReceivedMessage> {
    const deadline: number = Date.now() + timeoutMs;
    for (;;) {
      const remaining: number = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout esperando "${type}" que satisfaça a condição`);
      const message: ReceivedMessage = await this.next(type, remaining);
      if (predicate(message)) return message;
    }
  }

  /** `true` se já chegou alguma mensagem do tipo `type` ainda não consumida. */
  hasPending(type: string): boolean {
    return this.inbox.some((m) => m.type === type);
  }

  /** Espera o socket fechar e devolve o close code. */
  waitClose(): Promise<number> {
    return this.closed;
  }

  /** Fecha a conexão normalmente (1000) e espera o fechamento. */
  async close(): Promise<void> {
    this.socket.close(1000);
    await this.closed;
  }
}

/** Espera `ms` milissegundos. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * As zonas do jogo COM os jogadores fake de teste ([SOC-01]): no jogo eles estão desligados (2026-11-14), mas os testes
 * pela rede (inspect, grupo, amizade) usam o "Fake Aceita"/"Fake Recusa" como segundo jogador que responde sozinho.
 */
export const ZONES_WITH_FAKES: readonly ZoneConfig[] = ZONE_CONFIGS.map(
  (zone: ZoneConfig): ZoneConfig => ({ ...zone, fakePlayers: TEST_FAKE_PLAYERS }),
);

/**
 * Monta o estado completo a partir dos snapshots por diferença ([INFRA-11]), como o cliente faz
 * (mmo-client/scripts/network/network.gd): cada entrada de `players`/`npcs` junta os campos que vieram aos já
 * conhecidos; `gone` tira da vista; `me` junta os campos. {@link apply} devolve o snapshot "inteiro" daquele tick
 * (`players`/`npcs` = todos na vista, com todos os campos; `events` = os do tick), no formato de antes da versão 22.
 */
export class SnapshotView {
  private readonly players: Map<string, Record<string, unknown>> = new Map();
  private readonly npcs: Map<string, Record<string, unknown>> = new Map();
  private me: Record<string, unknown> = {};

  /** Aplica o `data` de um snapshot e devolve o estado inteiro. */
  apply(data: Record<string, unknown>): Record<string, unknown> {
    const gone: unknown = data["gone"];
    if (Array.isArray(gone)) {
      for (const id of gone) {
        if (typeof id === "string") {
          this.players.delete(id);
          this.npcs.delete(id);
        }
      }
    }
    for (const [key, map] of [["players", this.players], ["npcs", this.npcs]] as const) {
      const list: unknown = data[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
        map.set(entry["id"], { ...(map.get(entry["id"]) ?? {}), ...entry });
      }
    }
    if (isRecord(data["me"])) this.me = { ...this.me, ...data["me"] };
    return {
      ...data,
      players: Array.from(this.players.values(), (p) => ({ ...p })),
      npcs: Array.from(this.npcs.values(), (n) => ({ ...n })),
      me: { ...this.me },
    };
  }
}

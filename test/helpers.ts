import { WebSocket, type RawData } from "ws";

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

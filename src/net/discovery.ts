/**
 * Descoberta do servidor na rede local ([INFRA-10]). O APK, quando não alcança o endereço gravado nele (IP
 * Tailscale), manda por broadcast UDP a pergunta {@link DISCOVERY_REQUEST} para a porta {@link DISCOVERY_PORT}; este
 * servidor responde, só para quem perguntou, com {@link DiscoveryReply} (JSON). O aparelho usa o IP de onde veio a
 * resposta + a porta do jogo.
 *
 * ATENÇÃO: mesma pergunta, porta e formato de resposta em mmo-client/scripts/boot/updater.gd (o APK).
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

/** Porta UDP onde o servidor escuta a pergunta (a do jogo é TCP 2567; esta é a seguinte). */
export const DISCOVERY_PORT = 2568;

/** Texto exato da pergunta ("tem servidor do jogo aqui?"), com a versão do formato. */
export const DISCOVERY_REQUEST = "MMO_DISCOVER 1";

/** Resposta: identifica o jogo e diz em que porta TCP o servidor (WebSocket + HTTP) está. */
export interface DiscoveryReply {
  /** Sempre `"mmo"`: o aparelho ignora respostas de outros programas. */
  readonly game: "mmo";
  /** Versão do formato (a mesma da pergunta). */
  readonly version: 1;
  /** Porta TCP do jogo (WebSocket e HTTP de atualizações). */
  readonly port: number;
}

/**
 * Resposta para um pacote recebido: o JSON de {@link DiscoveryReply} se for a pergunta certa; `null` para qualquer
 * outra coisa (não responde a lixo nem a outros programas).
 */
export function discoveryReply(message: Buffer, gamePort: number): string | null {
  if (message.length > 64 || message.toString("utf8").trim() !== DISCOVERY_REQUEST) return null;
  const reply: DiscoveryReply = { game: "mmo", version: 1, port: gamePort };
  return JSON.stringify(reply);
}

/**
 * Começa a escutar a pergunta em `port` (todas as interfaces) e responde com a porta do jogo `gamePort`.
 * Falha ao abrir a porta (já em uso) só avisa no log: o jogo funciona sem a descoberta.
 */
export function startDiscovery(gamePort: number, port: number = DISCOVERY_PORT): Promise<Socket> {
  const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message: Buffer, from: RemoteInfo) => {
    const reply: string | null = discoveryReply(message, gamePort);
    if (reply !== null) socket.send(reply, from.port, from.address);
  });
  return new Promise((resolve) => {
    socket.once("error", (error: Error) => {
      console.error(`Descoberta na rede local desligada (UDP ${port}):`, error.message);
      resolve(socket);
    });
    socket.bind(port, () => resolve(socket));
  });
}

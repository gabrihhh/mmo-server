import { Room, Client, CloseCode } from "colyseus";
import { ZoneState, Player } from "./schema/ZoneState.js";
import { MessageType, parseMoveMessage } from "./messages.js";

/** Metade do lado da Zone 1 em metros (terreno 300m x 300m centrado na origem). Ver mmo-docs [MUN-03]. */
export const ZONE_HALF_SIZE = 150;

/** Raio (m) ao redor da origem onde novos jogadores nascem. */
const SPAWN_RADIUS = 5;

/** Máximo de jogadores conectados numa mesma instância de zona. */
const MAX_PLAYERS_PER_ZONE = 50;

/** Limita `value` ao intervalo fechado [min, max]. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Uma zona do mundo (room `"zone"`).
 *
 * MVP: o cliente é autoritativo sobre a própria posição. Ele envia `move` e o
 * servidor só valida o formato e limita às bordas do mapa; o estado é então
 * replicado para todos via patches do Colyseus.
 * Validação de velocidade e anti-cheat ficam para depois (mmo-docs [INFRA-02]).
 */
export class ZoneRoom extends Room<{ state: ZoneState }> {
  override maxClients: number = MAX_PLAYERS_PER_ZONE;
  override state: ZoneState = new ZoneState();

  /** Handlers de mensagens do cliente, indexados pelo tipo da mensagem. */
  override messages = {
    [MessageType.Move]: (client: Client, payload: unknown): void => {
      const player: Player | undefined = this.state.players.get(client.sessionId);
      const move = parseMoveMessage(payload);
      if (player === undefined || move === null) return;

      player.x = clamp(move.x, -ZONE_HALF_SIZE, ZONE_HALF_SIZE);
      player.y = move.y;
      player.z = clamp(move.z, -ZONE_HALF_SIZE, ZONE_HALF_SIZE);
      player.rotY = move.rotY;
    },
  };

  /** Cria o jogador num ponto aleatório perto do centro do mapa. */
  override onJoin(client: Client): void {
    const angle: number = Math.random() * Math.PI * 2;
    const player: Player = new Player();
    player.x = Math.cos(angle) * SPAWN_RADIUS;
    player.z = Math.sin(angle) * SPAWN_RADIUS;

    this.state.players.set(client.sessionId, player);
    console.log(`[zone ${this.roomId}] ${client.sessionId} entrou (${this.clients.length} online)`);
  }

  /** Remove o jogador do estado; os outros clientes recebem o `on_remove`. */
  override onLeave(client: Client, code: CloseCode): void {
    this.state.players.delete(client.sessionId);
    console.log(`[zone ${this.roomId}] ${client.sessionId} saiu (code ${code})`);
  }

  override onDispose(): void {
    console.log(`[zone ${this.roomId}] encerrada`);
  }
}

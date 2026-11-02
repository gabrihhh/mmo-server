/**
 * Ponto de entrada: sobe o servidor do jogo na porta 2567 (ou na variável de ambiente PORT).
 */
import { GameServer } from "./GameServer.js";

/** Porta padrão. ATENÇÃO: o cliente usa ws://localhost:2567 (mmo-client/scripts/network/network_config.gd). */
const DEFAULT_PORT = 2567;

const port: number = Number(process.env["PORT"] ?? DEFAULT_PORT);
const server: GameServer = new GameServer();
const actualPort: number = await server.listen(port);
console.log(`Servidor no ar: ws://localhost:${actualPort} (health: http://localhost:${actualPort}/health)`);

/** Encerra limpo no Ctrl+C / kill (fecha as conexões antes de sair). */
const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

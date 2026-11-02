/**
 * Ponto de entrada: conecta no MongoDB e sobe o servidor do jogo na porta 2567 (ou PORT).
 *
 * Variáveis de ambiente: `PORT` (padrão 2567), `MONGO_URL` (padrão mongodb://localhost:27017/mmo,
 * o banco do docker-compose.yml — subir com `npm run db:up`) e `UPDATES_DIR` (padrão `updates`,
 * a pasta com o manifesto e os pacotes do jogo, mmo-docs [INFRA-08]).
 */
import { GameServer } from "./GameServer.js";
import { DEFAULT_MONGO_URL, MongoAccountStore } from "./accounts/MongoAccountStore.js";

/** Porta padrão. ATENÇÃO: o cliente usa ws://localhost:2567 (mmo-client/scripts/network/network_config.gd). */
const DEFAULT_PORT = 2567;

const port: number = Number(process.env["PORT"] ?? DEFAULT_PORT);
const mongoUrl: string = process.env["MONGO_URL"] ?? DEFAULT_MONGO_URL;

let accounts: MongoAccountStore;
try {
  accounts = await MongoAccountStore.connect(mongoUrl);
} catch (error: unknown) {
  console.error(`Não foi possível conectar no MongoDB (${mongoUrl}). Ele está no ar? Rode: npm run db:up`);
  console.error(error);
  process.exit(1);
}

const updatesDir: string | undefined = process.env["UPDATES_DIR"];
const server: GameServer = new GameServer(updatesDir === undefined ? { accounts } : { accounts, updatesDir });
const actualPort: number = await server.listen(port);
console.log(`Servidor no ar: ws://localhost:${actualPort} (health: http://localhost:${actualPort}/health)`);

/** Encerra limpo no Ctrl+C / kill: salva posições, fecha conexões e o banco. */
const shutdown = (): void => {
  void server
    .close()
    .then(() => accounts.close())
    .then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

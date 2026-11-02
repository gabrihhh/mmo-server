import { defineServer, defineRoom, monitor, playground } from "colyseus";
import { ZoneRoom } from "./rooms/ZoneRoom.js";

/**
 * Configuração do servidor Colyseus.
 * Cada chave de `rooms` é o nome que o cliente usa em `join_or_create("...")`.
 */
const server = defineServer({
  rooms: {
    zone: defineRoom(ZoneRoom),
  },

  express: (app) => {
    /** Health check simples (deploy/monitoramento). */
    app.get("/health", (_req, res) => {
      res.send("ok");
    });

    // Ferramentas de desenvolvimento (nunca expor em produção):
    //   http://localhost:2567/          -> playground (cliente web de teste)
    //   http://localhost:2567/monitor   -> lista de rooms e clientes
    if (process.env["NODE_ENV"] !== "production") {
      app.use("/monitor", monitor());
      app.use("/", playground());
    }
  },
});

export default server;

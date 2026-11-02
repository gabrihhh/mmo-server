/**
 * Ponto de entrada: sobe o servidor na porta 2567 (ou na variável de ambiente PORT).
 */
import { listen } from "@colyseus/tools";
import app from "./app.config.js";

void listen(app);

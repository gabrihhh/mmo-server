# mmo-server

Servidor multiplayer do MMO (Node.js 22 + TypeScript + `ws`, servidor próprio).
Documentação completa em `../mmo-docs` (comece pelo `INDICE.md`).

```bash
nvm use        # Node 22
npm install
npm run db:up  # MongoDB local (Docker); parar com npm run db:down
npm start      # ws://localhost:2567 — health check em http://localhost:2567/health
npm test
```

Zonas: `zone_1` (Zone 1, 300 m × 300 m). Protocolo (JSON sobre WebSocket): ver mmo-docs [INFRA-04].

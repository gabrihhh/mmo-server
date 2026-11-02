# mmo-server

Servidor multiplayer do MMO (Node.js 22 + TypeScript + Colyseus 0.18).
Documentação completa em `../mmo-docs` (comece pelo `INDICE.md`).

```bash
nvm use        # Node 22
npm install
npm start      # ws://localhost:2567 — playground de teste em http://localhost:2567
npm test
```

Rooms: `zone` (Zone 1, 300 m × 300 m). Protocolo: ver mmo-docs [INFRA-04].

#!/usr/bin/env bash
# Liga o MongoDB local (Docker, container mmo-mongo) e espera ele responder. Ver mmo-docs [INFRA-03].
# Uso: comandos/ligar_banco.sh   (de qualquer pasta)
# Os dados ficam no volume mongo-data: ligar/desligar não apaga nada.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "Docker não encontrado. Instale o Docker (mmo-docs [INFRA-03])."; exit 1; }

echo "Ligando o MongoDB (Docker)..."
docker compose up -d mongo >/dev/null
for _ in $(seq 1 30); do
  if docker exec mmo-mongo mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
    echo "MongoDB ligado: mongodb://127.0.0.1:27017"
    exit 0
  fi
  sleep 1
done
echo "O MongoDB não respondeu em 30 s. Veja: docker logs mmo-mongo"
exit 1

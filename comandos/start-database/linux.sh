#!/usr/bin/env bash
# Liga o MongoDB local e espera ele responder em 127.0.0.1:27017. Ver mmo-docs [INFRA-03].
# Uso: comandos/start-database/linux.sh   (de qualquer pasta)
#   - Com Docker: sobe o container mmo-mongo (docker-compose.yml); dados no volume mongo-data.
#   - Sem Docker: liga o serviço nativo `mongod` (systemd), se existir.
# Ligar/desligar não apaga nada. Desligar: comandos/stop-database/linux.sh
# Chamado com `sh` (dash, sem pipefail)? Relança no bash.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail
cd "$(dirname "$0")/../.."

## Porta do MongoDB respondendo? (sem precisar do mongosh)
mongo_up() { (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; }

if mongo_up; then
  echo "MongoDB já está ligado: mongodb://127.0.0.1:27017"
  exit 0
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Ligando o MongoDB (Docker, container mmo-mongo)..."
  docker compose up -d mongo >/dev/null
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files mongod.service >/dev/null 2>&1; then
  echo "Ligando o MongoDB (serviço mongod)..."
  sudo systemctl start mongod
else
  echo "Não achei Docker nem o serviço mongod. Rode primeiro: comandos/setup-linux.sh"
  exit 1
fi

for _ in $(seq 1 30); do
  if mongo_up; then
    echo "MongoDB ligado: mongodb://127.0.0.1:27017"
    exit 0
  fi
  sleep 1
done
echo "O MongoDB não respondeu em 30 s. Veja: docker logs mmo-mongo   (ou: journalctl -u mongod)"
exit 1

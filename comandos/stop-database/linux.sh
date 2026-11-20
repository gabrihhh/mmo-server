#!/usr/bin/env bash
# Desliga o MongoDB local. Ver mmo-docs [INFRA-03].
# Uso: comandos/stop-database/linux.sh   (de qualquer pasta)
#   - Com Docker: para o container mmo-mongo (dados continuam no volume mongo-data).
#   - Sem Docker: para o serviço nativo `mongod` (systemd).
# Nada é apagado. Com o banco desligado o servidor do jogo não funciona.
# Chamado com `sh` (dash, sem pipefail)? Relança no bash.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail
cd "$(dirname "$0")/../.."

if command -v docker >/dev/null 2>&1 && [[ -n "$(docker ps -q --filter name=^mmo-mongo$ 2>/dev/null)" ]]; then
  echo "Desligando o MongoDB (Docker)..."
  docker compose stop mongo >/dev/null
  echo "MongoDB desligado (dados guardados no volume mongo-data)."
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet mongod 2>/dev/null; then
  echo "Desligando o MongoDB (serviço mongod)..."
  sudo systemctl stop mongod
  echo "MongoDB desligado."
else
  echo "O MongoDB já está desligado."
fi

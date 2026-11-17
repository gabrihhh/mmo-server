#!/usr/bin/env bash
# Desliga o MongoDB local (Docker, container mmo-mongo). Ver mmo-docs [INFRA-03].
# Uso: comandos/desligar_banco.sh   (de qualquer pasta)
# Os dados continuam no volume mongo-data (nada é apagado). Com o banco desligado o servidor do jogo não funciona.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "Docker não encontrado."; exit 1; }

if [[ -z "$(docker ps -q --filter name=^mmo-mongo$)" ]]; then
  echo "O MongoDB já está desligado."
  exit 0
fi
echo "Desligando o MongoDB..."
docker compose stop mongo >/dev/null
echo "MongoDB desligado (dados guardados no volume mongo-data)."

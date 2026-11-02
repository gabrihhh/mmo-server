#!/usr/bin/env bash
# Sobe tudo que o servidor do jogo precisa e inicia o servidor. Ver mmo-docs [INFRA-05].
#
# Uso: ./run.sh
#   1. Node 22 (via nvm, se houver)
#   2. npm install (só se faltar node_modules)
#   3. MongoDB local no Docker (npm run db:up) e espera ele responder
#   4. avisa se não há pacote do jogo publicado (o celular não teria o que baixar)
#   5. mostra o endereço na rede local e roda `npm start` (recarrega sozinho ao mudar o código)
# Ctrl+C para parar o servidor (o MongoDB continua rodando; parar: npm run db:down).
set -euo pipefail

cd "$(dirname "$0")"

# --- 1. Node 22 ---
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null || { echo "Node 22 não instalado. Rode: nvm install 22"; exit 1; }
fi
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( node_major < 22 )); then
  echo "Precisa do Node 22 (encontrado: $(node -v 2>/dev/null || echo nenhum)). Instale com: nvm install 22"
  exit 1
fi

# --- 2. Dependências ---
if [[ ! -d node_modules ]]; then
  echo "Instalando dependências (npm install)..."
  npm install
fi

# --- 3. MongoDB ---
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não encontrado. Instale o Docker para rodar o MongoDB local (mmo-docs [INFRA-03])."
  exit 1
fi
echo "Subindo o MongoDB (Docker)..."
npm run --silent db:up >/dev/null
for _ in $(seq 1 30); do
  if docker exec mmo-mongo mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec mmo-mongo mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1 \
  || { echo "O MongoDB não respondeu em 30 s. Veja: docker logs mmo-mongo"; exit 1; }

# --- 4. Pacote do jogo para o celular ---
if [[ ! -f updates/android/manifest.json ]]; then
  echo "AVISO: nenhum pacote Android publicado. O APK vai mostrar 'Sem conexão'/erro ao atualizar."
  echo "       Publique com: ../mmo-client/tools/publish_update.sh android"
else
  echo "Pacote Android publicado: versão $(grep -o '"version": *[0-9]*' updates/android/manifest.json | grep -o '[0-9]*$')"
fi

# --- 5. Endereço e servidor ---
lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
port="${PORT:-2567}"
echo
echo "Servidor do jogo:"
echo "  neste PC:      ws://localhost:${port}"
[[ -n "$lan_ip" ]] && echo "  rede local:    ws://${lan_ip}:${port}   (o APK usa o IP configurado em mmo-client/project.godot: server_url.android)"
echo
exec npm start

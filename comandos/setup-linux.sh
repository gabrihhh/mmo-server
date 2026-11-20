#!/usr/bin/env bash
# Prepara uma máquina Linux para rodar o servidor do jogo (rodar uma vez; pode repetir sem medo).
# Ver mmo-docs [IA-03] e [INFRA-03].
#
# Uso: comandos/setup-linux.sh   (de qualquer pasta; pede sudo para instalar pacotes)
#   1. pacotes básicos (curl, git, ca-certificates) — apt (Ubuntu/Debian)
#   2. nvm + Node 22 (versão do .nvmrc)
#   3. dependências do projeto (npm install)
#   4. Docker + Docker Compose (MongoDB roda no container mmo-mongo)
#   5. liga o MongoDB e confere que responde
# Depois: comandos/start-server/linux.sh
# Chamado com `sh` (dash, sem pipefail)? Relança no bash.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="$(cat .nvmrc 2>/dev/null || echo 22)"
NVM_VERSION="v0.40.3"

step() { echo; echo "=== $* ==="; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! have apt-get; then
  echo "Este setup instala pacotes com apt (Ubuntu/Debian). Em outra distro instale na mão:"
  echo "  curl, git, Node ${NODE_VERSION} (nvm), Docker com o plugin compose. Depois: npm install"
  exit 1
fi

# --- 1. Pacotes básicos ---
step "1/5 Pacotes básicos"
missing=()
for pkg in curl git ca-certificates; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if (( ${#missing[@]} > 0 )); then
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
else
  echo "ok"
fi

# --- 2. nvm + Node ---
step "2/5 Node ${NODE_VERSION} (nvm)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "Instalando o nvm ${NVM_VERSION}..."
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null
nvm use "$NODE_VERSION" >/dev/null
echo "Node $(node -v), npm $(npm -v)"

# --- 3. Dependências do projeto ---
step "3/5 Dependências (npm install)"
npm install

# --- 4. Docker ---
step "4/5 Docker"
if ! have docker; then
  echo "Instalando Docker (docker.io + compose)..."
  sudo apt-get update
  sudo apt-get install -y docker.io
  sudo apt-get install -y docker-compose-v2 2>/dev/null || sudo apt-get install -y docker-compose-plugin
  sudo systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get install -y docker-compose-v2 2>/dev/null || sudo apt-get install -y docker-compose-plugin
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  echo "Seu usuário entrou no grupo docker: saia e entre de novo na sessão para usar docker sem sudo."
fi
echo "$(docker --version)"

# --- 5. MongoDB ---
step "5/5 MongoDB"
if docker info >/dev/null 2>&1; then
  comandos/start-database/linux.sh
else
  # Grupo docker ainda não vale nesta sessão: sobe com sudo só desta vez.
  sudo docker compose up -d mongo >/dev/null
  echo "MongoDB subindo no Docker (container mmo-mongo)."
fi

echo
echo "Pronto! Para iniciar o servidor: comandos/start-server/linux.sh"

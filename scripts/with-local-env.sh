#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MONET_LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat <<EOF
Missing env file: ${ENV_FILE}

Create it from the template:
  cp ${ROOT_DIR}/.env.local-dev.example ${ROOT_DIR}/.env.local-dev
EOF
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

postgres_host="${POSTGRES_HOST:-127.0.0.1}"
postgres_port="${POSTGRES_PORT:-5432}"
postgres_db="${POSTGRES_DB:-monet}"
postgres_user="${POSTGRES_USER:-postgres}"
postgres_password="${POSTGRES_PASSWORD:-postgres}"
api_port="${API_PORT:-3001}"
ollama_port="${OLLAMA_PORT:-11434}"

export DATABASE_URL="${DATABASE_URL:-postgresql://${postgres_user}:${postgres_password}@${postgres_host}:${postgres_port}/${postgres_db}}"
export INTERNAL_API_URL="${INTERNAL_API_URL:-http://127.0.0.1:${api_port}}"
export OLLAMA_BASE_URL="${HOST_OLLAMA_BASE_URL:-http://127.0.0.1:${ollama_port}}"

exec "$@"

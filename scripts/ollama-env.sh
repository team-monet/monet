#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.ollama.yml"
ENV_FILE="${MONET_OLLAMA_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"
PROJECT_NAME_DEFAULT="monet-ollama"
PROJECT_NAME="${PROJECT_NAME_DEFAULT}"

compose_ollama() {
  docker compose \
    --project-name "${PROJECT_NAME}" \
    --env-file "${ENV_FILE}" \
    -f "${COMPOSE_FILE}" \
    "$@"
}

require_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    cat <<EOF
Missing env file: ${ENV_FILE}

Create it from one of the templates:
  cp ${ROOT_DIR}/.env.local-dev.example ${ROOT_DIR}/.env.local-dev
  cp ${ROOT_DIR}/.env.runtime.example ${ROOT_DIR}/.env.runtime
EOF
    exit 1
  fi
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  PROJECT_NAME="${MONET_OLLAMA_COMPOSE_PROJECT:-${PROJECT_NAME_DEFAULT}}"
}

ollama_base_url() {
  local ollama_port="${OLLAMA_PORT:-11434}"
  printf "http://127.0.0.1:%s" "${ollama_port}"
}

wait_for_ready() {
  local url="$1"
  local timeout_seconds="${2:-120}"
  local waited=0

  echo "Waiting for readiness: ${url}"

  until curl --silent --show-error --fail "${url}" > /dev/null; do
    sleep 2
    waited=$((waited + 2))
    if (( waited >= timeout_seconds )); then
      echo "Readiness timed out after ${timeout_seconds}s."
      echo "Check logs:"
      echo "  pnpm ollama:logs"
      exit 1
    fi
  done

  echo "Readiness passed."
}

cmd_up() {
  require_env_file
  load_env_file
  compose_ollama up -d
  wait_for_ready "$(ollama_base_url)/api/tags" 120
}

cmd_down() {
  require_env_file
  load_env_file
  compose_ollama down --remove-orphans
}

cmd_status() {
  require_env_file
  load_env_file
  compose_ollama ps
}

cmd_logs() {
  require_env_file
  load_env_file
  compose_ollama logs --tail 200 ollama ollama-model-pull
}

usage() {
  cat <<'EOF'
Usage: ./scripts/ollama-env.sh <command>

Commands:
  up      Start the shared Ollama stack and wait for readiness
  down    Stop the shared Ollama stack
  status  Show shared Ollama status
  logs    Tail shared Ollama logs
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

case "$1" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *)
    usage
    exit 1
    ;;
esac

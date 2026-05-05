#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.runtime.yml"
ENV_FILE="${MONET_RUNTIME_ENV_FILE:-${ROOT_DIR}/.env.runtime}"
PROJECT_NAME_DEFAULT="monet-runtime"
PROJECT_NAME="${PROJECT_NAME_DEFAULT}"

compose_runtime() {
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

Create it from the template:
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
  PROJECT_NAME="${MONET_RUNTIME_COMPOSE_PROJECT:-${PROJECT_NAME_DEFAULT}}"
}

api_base_url() {
  local api_port="${API_PORT:-4301}"
  printf "http://127.0.0.1:%s" "${api_port}"
}

dashboard_base_url() {
  local dashboard_port="${DASHBOARD_PORT:-4310}"
  printf "http://127.0.0.1:%s" "${dashboard_port}"
}

keycloak_base_url() {
  local keycloak_port="${KEYCLOAK_PORT:-4400}"
  printf "%s" "${KEYCLOAK_BASE_URL:-http://keycloak.localhost:${keycloak_port}}"
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
      echo "  pnpm runtime:logs"
      exit 1
    fi
  done

  echo "Readiness passed."
}

with_ollama_env() {
  MONET_OLLAMA_ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/ollama-env.sh" "$@"
}

ollama_required() {
  local chat_provider="${ENRICHMENT_CHAT_PROVIDER:-}"
  local embedding_provider="${ENRICHMENT_EMBEDDING_PROVIDER:-}"
  local legacy_provider="${ENRICHMENT_PROVIDER:-}"

  if [[ "${chat_provider}" == "ollama" || "${embedding_provider}" == "ollama" ]]; then
    return 0
  fi

  if [[ -n "${legacy_provider}" && ("${legacy_provider}" == "ollama" || "${legacy_provider}" == "onnx") ]]; then
    return 0
  fi

  return 1
}

start_ollama_if_required() {
  if ollama_required; then
    echo "Ollama is required by enrichment provider config; ensuring shared Ollama is running..."
    with_ollama_env up
  else
    echo "Ollama is not required by enrichment provider config; skipping shared Ollama startup."
  fi
}

pull_optional_image() {
  local image="$1"
  local label="$2"

  if [[ "${image}" == *":local" ]]; then
    echo "Skipping ${label} pull for local tag: ${image}"
    return 0
  fi

  docker pull "${image}"
}

cmd_up() {
  require_env_file
  load_env_file
  start_ollama_if_required
  compose_runtime up -d postgres keycloak
  cmd_migrate
  compose_runtime up -d api dashboard
  wait_for_ready "$(api_base_url)/health/ready" 180
  wait_for_ready "$(keycloak_base_url)" 180
  wait_for_ready "$(dashboard_base_url)/login" 180
}

cmd_migrate() {
  require_env_file
  load_env_file
  compose_runtime run --rm migrate
}

cmd_pull() {
  require_env_file
  load_env_file
  start_ollama_if_required
  docker pull pgvector/pgvector:pg16
  docker pull quay.io/keycloak/keycloak:26.1
  pull_optional_image "${MIGRATE_IMAGE:-monet-migrate:local}" "migrate"
  pull_optional_image "${API_IMAGE:-monet-api:local}" "api"
  pull_optional_image "${DASHBOARD_IMAGE:-monet-dashboard:local}" "dashboard"
}

cmd_keycloak_setup() {
  require_env_file
  load_env_file
  LOCAL_KEYCLOAK_OUTPUT="${LOCAL_KEYCLOAK_OUTPUT:-.runtime/keycloak.json}" \
    node "${ROOT_DIR}/scripts/local-keycloak-setup.mjs"
}

cmd_down() {
  require_env_file
  load_env_file
  compose_runtime down --remove-orphans
}

cmd_status() {
  require_env_file
  load_env_file
  echo "Runtime stack:"
  compose_runtime ps

  if ollama_required; then
    echo
    echo "Shared Ollama:"
    with_ollama_env status
  else
    echo
    echo "Shared Ollama: skipped (not required by enrichment provider config)"
  fi
}

cmd_logs() {
  require_env_file
  load_env_file
  echo "Runtime stack logs:"
  compose_runtime logs --tail 200 postgres migrate api keycloak dashboard

  if ollama_required; then
    echo
    echo "Shared Ollama logs:"
    with_ollama_env logs
  else
    echo
    echo "Shared Ollama logs: skipped (not required by enrichment provider config)"
  fi
}

cmd_reset() {
  require_env_file
  load_env_file
  compose_runtime down --volumes --remove-orphans
}

usage() {
  cat <<'EOF'
Usage: ./scripts/runtime-env.sh <command>

Commands:
  up       Start required dependencies, migrate, then start the runtime stack
  migrate  Run platform migrations inside the runtime image
  pull     Pull runtime dependencies and any non-local app images
  keycloak-setup Bootstrap runtime Keycloak realms, clients, and sample users
  down     Stop the runtime stack
  status   Show runtime status and Ollama status when required
  logs     Tail runtime logs and Ollama logs when required
  reset    Destructive reset (removes runtime containers and local runtime volumes)
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

case "$1" in
  up) cmd_up ;;
  migrate) cmd_migrate ;;
  pull) cmd_pull ;;
  keycloak-setup) cmd_keycloak_setup ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  reset) cmd_reset ;;
  *)
    usage
    exit 1
    ;;
esac

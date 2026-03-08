#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.local.yml"
ENV_FILE="${MONET_LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"
PROJECT_NAME_DEFAULT="monet"
PROJECT_NAME="${PROJECT_NAME_DEFAULT}"

compose() {
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
  cp ${ROOT_DIR}/.env.local-dev.example ${ROOT_DIR}/.env.local-dev
EOF
    exit 1
  fi
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  PROJECT_NAME="${MONET_LOCAL_COMPOSE_PROJECT:-${PROJECT_NAME_DEFAULT}}"
}

api_base_url() {
  local api_port="${API_PORT:-3001}"
  printf "http://127.0.0.1:%s" "${api_port}"
}

keycloak_base_url() {
  local keycloak_port="${KEYCLOAK_PORT:-3400}"
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
      echo "  pnpm local:logs"
      exit 1
    fi
  done

  echo "Readiness passed."
}

cmd_up() {
  require_env_file
  load_env_file
  compose --profile dashboard up -d --build
  wait_for_ready "$(api_base_url)/health/ready" 120
  wait_for_ready "$(keycloak_base_url)" 180
  wait_for_ready "$(dashboard_base_url)/login" 180
}

dashboard_base_url() {
  local dashboard_port="${DASHBOARD_PORT:-3310}"
  printf "http://127.0.0.1:%s" "${dashboard_port}"
}

cmd_migrate() {
  require_env_file
  load_env_file
  compose run --rm migrate
}

cmd_build() {
  require_env_file
  load_env_file
  compose --profile dashboard build
}

cmd_down() {
  require_env_file
  load_env_file
  compose --profile dashboard down --remove-orphans
}

cmd_status() {
  require_env_file
  load_env_file
  compose --profile dashboard ps
}

cmd_logs() {
  require_env_file
  load_env_file
  compose --profile dashboard logs --tail 200 postgres ollama ollama-model-pull migrate api keycloak dashboard
}

cmd_reset() {
  require_env_file
  load_env_file
  compose --profile dashboard down --volumes --remove-orphans
}

remove_volume_if_exists() {
  local volume_name="$1"
  if docker volume inspect "${volume_name}" >/dev/null 2>&1; then
    docker volume rm "${volume_name}" >/dev/null
  fi
}

cmd_db_reset() {
  require_env_file
  load_env_file
  compose --profile dashboard down --remove-orphans
  remove_volume_if_exists "${PROJECT_NAME}_postgres_prod_data"
  echo "Removed Postgres volume: ${PROJECT_NAME}_postgres_prod_data"
  echo "Run pnpm local:up to recreate the database and rerun migrations."
}

cmd_metrics() {
  require_env_file
  load_env_file
  pnpm --filter @monet/api exec node scripts/local-usage-metrics.mjs
}

cmd_mcp_smoke() {
  require_env_file
  load_env_file
  pnpm --filter @monet/api exec node scripts/mcp-local-smoke.mjs
}

cmd_keycloak_setup() {
  require_env_file
  load_env_file
  node "${ROOT_DIR}/scripts/local-keycloak-setup.mjs"
}

usage() {
  cat <<'EOF'
Usage: ./scripts/local-env.sh <command>

Commands:
  up         Build images, start postgres + ollama + api + dashboard, and wait for readiness
  build      Build local API and dashboard images
  migrate    Run platform migrations via the migrate service
  down       Stop stack without deleting database volume
  status     Show container status for the local project
  logs       Tail postgres + ollama + api logs
  metrics    Generate local usage metrics snapshot
  mcp-smoke  Run MCP connection smoke test (requires MCP_API_KEY env var)
  keycloak-setup Bootstrap local Keycloak realms, clients, and sample users
  db-reset   Remove the local Postgres volume and force a fresh database
  reset      Destructive reset (removes containers, Postgres data, and Keycloak data)
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

case "$1" in
  up) cmd_up ;;
  build) cmd_build ;;
  migrate) cmd_migrate ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  metrics) cmd_metrics ;;
  mcp-smoke) cmd_mcp_smoke ;;
  keycloak-setup) cmd_keycloak_setup ;;
  db-reset) cmd_db_reset ;;
  reset) cmd_reset ;;
  *)
    usage
    exit 1
    ;;
esac

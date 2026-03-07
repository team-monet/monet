#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
ENV_FILE="${MONET_LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"
PROJECT_NAME_DEFAULT="monet"
PROJECT_NAME="${PROJECT_NAME_DEFAULT}"
LOCAL_BOOTSTRAP_OUTPUT="${ROOT_DIR}/.local-dev/bootstrap.json"

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
  compose up -d
  wait_for_ready "$(api_base_url)/health/ready" 120
}

dashboard_base_url() {
  local dashboard_port="${DASHBOARD_PORT:-3310}"
  printf "http://127.0.0.1:%s" "${dashboard_port}"
}

cmd_up_dashboard() {
  require_env_file
  load_env_file
  compose --profile dashboard up -d
  wait_for_ready "$(api_base_url)/health/ready" 120
  wait_for_ready "$(dashboard_base_url)/login" 180
}

cmd_migrate() {
  require_env_file
  load_env_file
  compose run --rm migrate
}

cmd_bootstrap() {
  require_env_file
  load_env_file
  LOCAL_BOOTSTRAP_OUTPUT="${LOCAL_BOOTSTRAP_OUTPUT:-${ROOT_DIR}/.local-dev/bootstrap.json}" \
    pnpm --filter @monet/api exec node scripts/local-bootstrap.mjs
}

cmd_init() {
  cmd_up
  cmd_bootstrap
}

cmd_init_dashboard() {
  cmd_up_dashboard
  cmd_bootstrap
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
  compose --profile dashboard logs --tail 200 postgres ollama ollama-model-pull migrate api dashboard
}

cmd_reset() {
  require_env_file
  load_env_file
  compose --profile dashboard down --volumes --remove-orphans
  rm -f "${LOCAL_BOOTSTRAP_OUTPUT}"
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

usage() {
  cat <<'EOF'
Usage: ./scripts/local-env.sh <command>

Commands:
  up         Start postgres + ollama + api and wait for /health/ready
  up-dashboard Start postgres + ollama + api + dashboard profile
  migrate    Run platform migrations via the migrate service
  bootstrap  Provision/reuse tenant context and create a local MCP agent API key
  init       up + bootstrap (long-lived local setup)
  init-dashboard up-dashboard + bootstrap (also starts dashboard profile)
  down       Stop stack without deleting database volume
  status     Show container status for the local project
  logs       Tail postgres + ollama + api logs
  metrics    Generate local usage metrics snapshot
  mcp-smoke  Run MCP connection smoke test (requires MCP_API_KEY env var)
  reset      Destructive reset (removes containers + DB volume + local bootstrap output)
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

case "$1" in
  up) cmd_up ;;
  up-dashboard) cmd_up_dashboard ;;
  migrate) cmd_migrate ;;
  bootstrap) cmd_bootstrap ;;
  init) cmd_init ;;
  init-dashboard) cmd_init_dashboard ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  metrics) cmd_metrics ;;
  mcp-smoke) cmd_mcp_smoke ;;
  reset) cmd_reset ;;
  *)
    usage
    exit 1
    ;;
esac

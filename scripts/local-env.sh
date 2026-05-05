#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_COMPOSE_FILE="${ROOT_DIR}/docker-compose.dev.yml"
ENV_FILE="${MONET_LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"
PROJECT_NAME_DEFAULT="monet-dev"
PROJECT_NAME="${PROJECT_NAME_DEFAULT}"

compose_dev() {
  docker compose \
    --project-name "${PROJECT_NAME}" \
    --env-file "${ENV_FILE}" \
    -f "${DEV_COMPOSE_FILE}" \
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

keycloak_base_url() {
  local keycloak_port="${KEYCLOAK_PORT:-3400}"
  printf "%s" "${KEYCLOAK_BASE_URL:-http://keycloak.localhost:${keycloak_port}}"
}

wait_for_ready() {
  local url="$1"
  local timeout_seconds="${2:-120}"
  local waited=0
  local spinner='|/-\\'
  local spin_index=0

  echo "Waiting for readiness: ${url}"

  until curl --silent --fail "${url}" > /dev/null 2>&1; do
    local spin_char="${spinner:spin_index:1}"
    printf "\rStill starting... %s (%ss/%ss)" "${spin_char}" "${waited}" "${timeout_seconds}"
    spin_index=$(((spin_index + 1) % 4))
    sleep 2
    waited=$((waited + 2))
    if (( waited >= timeout_seconds )); then
      echo
      echo "Readiness check timed out after ${timeout_seconds}s."
      echo "URL: ${url}"
      echo "Troubleshooting:"
      echo "  pnpm local:logs"
      echo "  curl -v ${url}"
      exit 1
    fi
  done

  printf "\rReady: %s%*s\n" "${url}" 20 ""
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

build_release_image() {
  local target="$1"
  local tag="$2"

  docker build \
    --file "${ROOT_DIR}/docker/monet.Dockerfile" \
    --target "${target}" \
    --tag "${tag}" \
    "${ROOT_DIR}"
}

cmd_up() {
  require_env_file
  load_env_file
  start_ollama_if_required
  compose_dev up -d
  wait_for_ready "$(keycloak_base_url)" 180
  cat <<EOF
Infrastructure is ready.

Next quickstart step:
  pnpm local:quickstart:init

If enrichment providers require Ollama, shared Ollama remains in its own stack:
  pnpm ollama:status

Run the app processes on the host in separate terminals:
  pnpm local:dev:api
  pnpm local:dev:dashboard
EOF
}

cmd_migrate() {
  "${ROOT_DIR}/scripts/with-local-env.sh" pnpm db:migrate
}

cmd_build() {
  require_env_file
  load_env_file
  build_release_image migrate-runtime "${MIGRATE_IMAGE:-monet-migrate:local}"
  build_release_image api-runtime "${API_IMAGE:-monet-api:local}"
  build_release_image dashboard-runtime "${DASHBOARD_IMAGE:-monet-dashboard:local}"
}

cmd_down() {
  require_env_file
  load_env_file
  compose_dev down --remove-orphans
}

cmd_status() {
  require_env_file
  load_env_file
  echo "Local infrastructure:"
  compose_dev ps
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
  echo "Local infrastructure logs:"
  compose_dev logs --tail 200 postgres pgadmin keycloak
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
  compose_dev down --volumes --remove-orphans
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
  compose_dev down --remove-orphans
  remove_volume_if_exists "${PROJECT_NAME}_postgres_data"
  echo "Removed Postgres volume: ${PROJECT_NAME}_postgres_data"
  echo "Run pnpm local:up to recreate the database."
}

cmd_metrics() {
  "${ROOT_DIR}/scripts/with-local-env.sh" pnpm --filter @monet/api exec node scripts/local-usage-metrics.mjs
}

cmd_mcp_smoke() {
  "${ROOT_DIR}/scripts/with-local-env.sh" pnpm --filter @monet/api exec node scripts/mcp-local-smoke.mjs
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
  up         Start local infrastructure and shared Ollama only when required
  build      Build release images for api, dashboard, and migrate
  migrate    Run platform migrations from the host against the local database
  down       Stop stack without deleting database volume
  status     Show container status for the local project
  logs       Tail local infrastructure and Ollama logs when required
  metrics    Generate local usage metrics snapshot
  mcp-smoke  Run MCP connection smoke test (requires MCP_API_KEY env var)
  keycloak-setup Bootstrap local Keycloak realms, clients, and sample users
  db-reset   Remove the local Postgres volume and force a fresh database
  reset      Destructive reset (removes local infra containers and local volumes)
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

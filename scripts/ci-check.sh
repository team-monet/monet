#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_COMPOSE_FILE="${ROOT_DIR}/docker-compose.dev.yml"
DEFAULT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/monet_test"

export DATABASE_URL="${DATABASE_URL:-${DEFAULT_DATABASE_URL}}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"

log_step() {
  printf '\n==> %s\n' "$1"
}

run_step() {
  local label="$1"
  shift
  log_step "${label}"
  "$@"
}

database_is_ready() {
  MONET_CI_DB_RETRIES=1 \
    MONET_CI_DB_DELAY_MS=250 \
    pnpm --filter @monet/api exec node scripts/prepare-ci-db.mjs >/dev/null 2>&1
}

start_local_postgres() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required to start the local CI database automatically." >&2
    echo "Either start PostgreSQL yourself or rerun with MONET_CI_MANAGED_DB=1 against an existing DATABASE_URL." >&2
    exit 1
  fi

  log_step "Start local CI database"
  POSTGRES_DB=monet_test \
  POSTGRES_PORT=5432 \
  POSTGRES_USER=postgres \
  POSTGRES_PASSWORD=postgres \
    docker compose -f "${DEV_COMPOSE_FILE}" up -d postgres
}

prepare_database() {
  if [[ "${MONET_CI_MANAGED_DB:-0}" != "1" ]] && ! database_is_ready; then
    start_local_postgres
  fi

  run_step "Prepare CI database" pnpm --filter @monet/api exec node scripts/prepare-ci-db.mjs
  run_step "Push database schema" pnpm --filter @monet/db exec drizzle-kit push --force
}

build_release_images() {
  run_step "Build API release image" \
    docker build --file docker/monet.Dockerfile --target api-runtime --tag monet-api:ci "${ROOT_DIR}"
  run_step "Build dashboard release image" \
    docker build --file docker/monet.Dockerfile --target dashboard-runtime --tag monet-dashboard:ci "${ROOT_DIR}"
  run_step "Build migrate release image" \
    docker build --file docker/monet.Dockerfile --target migrate-runtime --tag monet-migrate:ci "${ROOT_DIR}"
}

main() {
  cd "${ROOT_DIR}"

  run_step "Build" pnpm build
  run_step "Typecheck" pnpm typecheck
  run_step "Lint" pnpm lint
  run_step "Unit tests" pnpm test:unit
  prepare_database
  run_step "Integration tests" pnpm test:integration

  if [[ "${MONET_CI_SKIP_IMAGES:-0}" != "1" ]]; then
    build_release_images
  fi
}

main "$@"

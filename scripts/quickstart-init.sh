#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${QUICKSTART_PROFILE:-local}"

ensure_workspace_bootstrap_packages_built() {
  echo "Building workspace packages required by quickstart bootstrap..."
  pnpm install
  pnpm --filter @monet/db... build
}

if [[ "${PROFILE}" == "runtime" ]]; then
  ENV_FILE="${MONET_RUNTIME_ENV_FILE:-${ROOT_DIR}/.env.runtime}"
  if [[ ! -f "${ENV_FILE}" ]]; then
    cat <<EOF
Missing env file: ${ENV_FILE}

Create it from the template:
  cp ${ROOT_DIR}/.env.runtime.example ${ROOT_DIR}/.env.runtime
EOF
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a

  export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@127.0.0.1:${POSTGRES_PORT:-65432}/${POSTGRES_DB:-monet_runtime}}"
  export INTERNAL_API_URL="${INTERNAL_API_URL:-http://127.0.0.1:${API_PORT:-4301}}"

  echo "Ensuring runtime database schema is up to date (migrations)..."
  "${ROOT_DIR}/scripts/runtime-env.sh" migrate

  ensure_workspace_bootstrap_packages_built

  echo "Running runtime quickstart bootstrap..."
  exec pnpm --filter @monet/api exec tsx ../../scripts/quickstart-init.ts
fi

echo "Ensuring local database schema is up to date (migrations)..."
"${ROOT_DIR}/scripts/local-env.sh" migrate

ensure_workspace_bootstrap_packages_built

echo "Running local quickstart bootstrap..."
exec "${ROOT_DIR}/scripts/with-local-env.sh" \
  pnpm --filter @monet/api exec tsx ../../scripts/quickstart-init.ts

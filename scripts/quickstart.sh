#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MONET_RUNTIME_ENV_FILE:-${ROOT_DIR}/.env.runtime}"

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ROOT_DIR}/.env.runtime.example" "${ENV_FILE}"
  echo "Created runtime env file: ${ENV_FILE}"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

quickstart_summary_file="$(mktemp -t monet-runtime-quickstart-summary.XXXXXX.txt)"

cleanup() {
  rm -f "${quickstart_summary_file}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

print_init_summary_block() {
  if [[ -f "${quickstart_summary_file}" ]]; then
    cat "${quickstart_summary_file}"
  fi
}

ensure_shared_network() {
  local network_name="${MONET_SHARED_NETWORK:-monet-shared}"
  if docker network inspect "${network_name}" >/dev/null 2>&1; then
    return 0
  fi

  echo "Creating shared Docker network: ${network_name}"
  docker network create "${network_name}" >/dev/null
}

ensure_local_runtime_images() {
  local image_source="${QUICKSTART_IMAGE_SOURCE:-build}"
  local api_image="${API_IMAGE:-monet-api:local}"
  local dashboard_image="${DASHBOARD_IMAGE:-monet-dashboard:local}"
  local migrate_image="${MIGRATE_IMAGE:-monet-migrate:local}"

  if [[ "${image_source}" == "pull" ]]; then
    echo "Pulling runtime images (QUICKSTART_IMAGE_SOURCE=pull)..."
    "${ROOT_DIR}/scripts/runtime-env.sh" pull
    return 0
  fi

  local needs_build=0
  if [[ "${api_image}" == *":local" ]] && ! docker image inspect "${api_image}" >/dev/null 2>&1; then
    needs_build=1
  fi
  if [[ "${dashboard_image}" == *":local" ]] && ! docker image inspect "${dashboard_image}" >/dev/null 2>&1; then
    needs_build=1
  fi
  if [[ "${migrate_image}" == *":local" ]] && ! docker image inspect "${migrate_image}" >/dev/null 2>&1; then
    needs_build=1
  fi

  if (( needs_build == 1 )); then
    echo "Building local runtime images (missing :local tags)..."
    docker build --file "${ROOT_DIR}/docker/monet.Dockerfile" --target migrate-runtime --tag "${migrate_image}" "${ROOT_DIR}"
    docker build --file "${ROOT_DIR}/docker/monet.Dockerfile" --target api-runtime --tag "${api_image}" "${ROOT_DIR}"
    docker build --file "${ROOT_DIR}/docker/monet.Dockerfile" --target dashboard-runtime --tag "${dashboard_image}" "${ROOT_DIR}"
  else
    echo "Runtime images already available; skipping local build."
  fi
}

echo "[quickstart] Ensuring Docker shared network..."
ensure_shared_network

echo "[quickstart] Ensuring runtime images are available..."
ensure_local_runtime_images

echo "[quickstart] Starting runtime containers (postgres, keycloak, migrate, api, dashboard)..."
"${ROOT_DIR}/scripts/runtime-env.sh" up

echo "[quickstart] Bootstrapping demo tenant and API key..."
QUICKSTART_PROFILE=runtime QUICKSTART_INIT_CAPTURE_ONLY=1 QUICKSTART_INIT_SUMMARY_FILE="${quickstart_summary_file}" "${ROOT_DIR}/scripts/quickstart-init.sh"

api_port="${API_PORT:-4301}"
dashboard_port="${DASHBOARD_PORT:-4310}"
tenant_slug="${QUICKSTART_TENANT_SLUG:-demo}"

cat <<EOF

Quickstart complete. Runtime containers are running.

Dashboard URL: http://127.0.0.1:${dashboard_port}
API URL: http://127.0.0.1:${api_port}
Tenant login slug: ${tenant_slug}
MCP endpoint: http://127.0.0.1:${api_port}/mcp/${tenant_slug}

Useful diagnostics:
  pnpm runtime:status
  pnpm runtime:logs
EOF

echo
echo "[quickstart] Ready-to-copy summary"
echo "--------------------------------"
print_init_summary_block

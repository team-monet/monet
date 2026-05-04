#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MONET_LOCAL_ENV_FILE:-${ROOT_DIR}/.env.local-dev}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

api_port="${API_PORT:-3301}"
dashboard_port="${DASHBOARD_PORT:-3310}"
quickstart_init_log="$(mktemp -t monet-quickstart-init.XXXXXX.log)"

print_init_summary_block() {
  if [[ ! -f "${quickstart_init_log}" ]]; then
    return
  fi

  node -e 'const fs = require("node:fs"); const p = process.argv[1]; const text = fs.readFileSync(p, "utf8"); const start = text.indexOf("Ready-to-copy MCP config"); const marker = "Credentials above are for local development only."; const end = text.indexOf(marker); if (start === -1 || end === -1 || end < start) process.exit(0); process.stdout.write(text.slice(start, end + marker.length).trimEnd() + "\n");' "${quickstart_init_log}"
}

print_tenant_slug_hint() {
  if [[ ! -f "${quickstart_init_log}" ]]; then
    return
  fi

  node -e 'const fs = require("node:fs"); const p = process.argv[1]; const text = fs.readFileSync(p, "utf8"); const match = text.match(/^Tenant:\s+([a-z0-9-]+)\b/m); if (!match) process.exit(0); process.stdout.write(`Tenant login slug: ${match[1]}\n`);' "${quickstart_init_log}"
}

echo "[quickstart] Starting local infrastructure..."
"${ROOT_DIR}/scripts/local-env.sh" up

echo "[quickstart] Running local quickstart initialization..."
"${ROOT_DIR}/scripts/quickstart-init.sh" | tee "${quickstart_init_log}"

echo "[quickstart] Starting API and dashboard (Ctrl-C stops both)..."
echo "[quickstart] Dashboard URL: http://127.0.0.1:${dashboard_port}"
echo "[quickstart] API URL: http://127.0.0.1:${api_port}"
echo "[quickstart] MCP endpoint: http://127.0.0.1:${api_port}/mcp/demo"
echo "[quickstart] Reprinting MCP config/login details below for easy copy."

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "${api_pid:-}" ]]; then
    kill "${api_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${dashboard_pid:-}" ]]; then
    kill "${dashboard_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${quickstart_init_log}" >/dev/null 2>&1 || true
  wait >/dev/null 2>&1 || true
  exit "$code"
}

trap cleanup EXIT INT TERM

"${ROOT_DIR}/scripts/with-local-env.sh" pnpm --filter @monet/api dev:local &
api_pid=$!

"${ROOT_DIR}/scripts/with-local-env.sh" pnpm --filter @monet/dashboard dev:local &
dashboard_pid=$!

sleep 2
echo
echo "[quickstart] Ready-to-copy summary"
echo "--------------------------------"
print_tenant_slug_hint
print_init_summary_block
echo

while true; do
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    wait "$api_pid"
    break
  fi
  if ! kill -0 "$dashboard_pid" >/dev/null 2>&1; then
    wait "$dashboard_pid"
    break
  fi
  sleep 1
done

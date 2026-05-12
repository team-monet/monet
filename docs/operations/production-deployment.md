# Production Deployment Guide

This is the recommended Monet production path for the current open-source release:

- single host
- Docker Compose runtime stack
- one PostgreSQL instance
- one Keycloak instance
- one API container
- one dashboard container
- optional shared Ollama container for local inference

This guide is intentionally opinionated. It optimizes for a setup that is fast to
understand, repeatable to operate, and aligned with the repo's existing runtime
scripts.

For version changes after initial deployment, follow the
[Migration And Upgrade Guide](migration-upgrade.md).
For durability planning and recovery procedures, follow the
[Backup And Restore Guide](backup-restore.md).

## Recommended Topology

Use one Linux host with:

- Docker Engine and Docker Compose v2
- published GHCR images for `api`, `dashboard`, and `migrate`
- a reverse proxy that terminates TLS in front of Monet

Recommended public hostnames:

- `monet.example.com` -> dashboard
- `api.monet.example.com` -> API and MCP
- `auth.monet.example.com` -> Keycloak

Back Monet services with the built-in runtime Compose stack:

- dashboard on host port `4310`
- API on host port `4301`
- Keycloak on host port `4400`
- PostgreSQL on host port `65432`
- Ollama on host port `11434` when enabled

## Prerequisites

Before deploying, make sure you have:

- Docker and Docker Compose v2 installed on the target host
- DNS records for your dashboard, API, and Keycloak hostnames
- a reverse proxy or load balancer that can terminate TLS
- image coordinates for `API_IMAGE`, `DASHBOARD_IMAGE`, and `MIGRATE_IMAGE`
  - recommended production source: GHCR images pinned to a release tag (for example `v0.2.0`)
  - `ghcr.io/team-monet/monet-api`
  - `ghcr.io/team-monet/monet-dashboard`
  - `ghcr.io/team-monet/monet-migrate`
- a strong `NEXTAUTH_SECRET`
- a base64-encoded 32-byte `ENCRYPTION_KEY`
- a plan for persistent Docker volumes and host backups

Generate a 32-byte encryption key with:

```bash
openssl rand -base64 32
```

## Production Runtime Quickstart

Use this path for first deployment on a fresh host.

1. Create runtime env file:

```bash
cp .env.runtime.example .env.runtime
```

2. Set required values in `.env.runtime`:

- `API_IMAGE`
- `DASHBOARD_IMAGE`
- `MIGRATE_IMAGE`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `ENCRYPTION_KEY`
- `PUBLIC_API_URL`
- `MCP_PUBLIC_URL`
- `PUBLIC_OIDC_BASE_URL`
- `KEYCLOAK_BASE_URL`
- `LOCAL_OIDC_BASE_URL`
- `KEYCLOAK_ADMIN`
- `KEYCLOAK_ADMIN_PASSWORD`

For production, set image vars to pinned GHCR release tags (not floating `latest`):

```bash
API_IMAGE=ghcr.io/team-monet/monet-api:v0.2.0
DASHBOARD_IMAGE=ghcr.io/team-monet/monet-dashboard:v0.2.0
MIGRATE_IMAGE=ghcr.io/team-monet/monet-migrate:v0.2.0
```

3. Pull or build images:

```bash
# recommended production path (published GHCR images)
pnpm runtime:pull

# equivalent explicit pulls
docker pull ghcr.io/team-monet/monet-api:v0.2.0
docker pull ghcr.io/team-monet/monet-dashboard:v0.2.0
docker pull ghcr.io/team-monet/monet-migrate:v0.2.0

# or, for local image testing on the same host:
# pnpm local:build
```

If GHCR package visibility is private, authenticate before pulling:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin
```

When the Monet repository and packages are public, GHCR pulls should not require authentication.

4. Start runtime stack and bootstrap Keycloak:

```bash
pnpm runtime:up
pnpm runtime:keycloak:setup
```

5. Complete setup in the dashboard:

- open `${NEXTAUTH_URL}/setup`
- use the one-time bootstrap token from API startup logs
- use `platform.*` values from `.runtime/keycloak.json`
- configure tenant OIDC using `tenant.*` from `.runtime/keycloak.json`

> **For a dedicated end-to-end tenant creation guide, see [Tenant Creation and Management](../admin/tenant-creation.md).**

6. Verify deployment:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
```

7. Optional authenticated API smoke check (after issuing an agent API key):

```bash
TENANT_SLUG="<your-tenant-slug>"
API_BASE_URL="https://api.monet.example.com"
API_KEY="<your-agent-api-key>"
curl -sS "$API_BASE_URL/api/tenants/$TENANT_SLUG/agents/me" \
  -H "Authorization: Bearer $API_KEY"
```

## Network And Firewall

Recommended exposure:

- expose only `80` and `443` publicly on the reverse proxy
- keep PostgreSQL (`65432`) private to the host or private network
- keep the raw dashboard/API/Keycloak host ports private unless you are explicitly using them for evaluation or break-glass access

Reverse proxy upstreams should point to:

- `127.0.0.1:4310` for the dashboard
- `127.0.0.1:4301` for the API
- `127.0.0.1:4400` for Keycloak

If you use Ollama, keep `11434` private. Monet containers talk to Ollama over the shared Docker network.

## TLS Termination

Terminate TLS at the reverse proxy, not inside the Compose services.

Recommended pattern:

- proxy `https://monet.example.com` -> `http://127.0.0.1:4310`
- proxy `https://api.monet.example.com` -> `http://127.0.0.1:4301`
- proxy `https://auth.monet.example.com` -> `http://127.0.0.1:4400`

Set these public URLs in `.env.runtime`:

- `NEXTAUTH_URL=https://monet.example.com`
- `PUBLIC_API_URL=https://api.monet.example.com`
- `MCP_PUBLIC_URL=https://api.monet.example.com`
- `PUBLIC_OIDC_BASE_URL=https://auth.monet.example.com`

Monet MCP connections are tenant-qualified at `/mcp/:tenantSlug`.
If `MCP_PUBLIC_URL` is set to the API origin, dashboard-generated agent
connection configs will resolve to `https://api.monet.example.com/mcp/<tenantSlug>`.

Keep `KEYCLOAK_BASE_URL` and `LOCAL_OIDC_BASE_URL` on a URL the host and dashboard can actually reach during runtime and Keycloak bootstrap. In the simplest deployment, that can be the same Keycloak hostname if the host can resolve and reach it itself.

For the runtime API container, startup validation also checks the public URL
settings passed through the runtime env file. In production, these public URLs
must use `https://`:

- `NEXTAUTH_URL`
- `PUBLIC_API_URL`
- `MCP_PUBLIC_URL`
- `PUBLIC_OIDC_BASE_URL`

For a first internal trial on raw LAN ports, you can opt into insecure private
network HTTP origins by setting `ALLOW_INSECURE_PRIVATE_HTTP_ORIGINS=true` and
using `http://` URLs on RFC1918/private-network IPs such as `192.168.x.x`.
Keep this mode private to your LAN, expect browser security limitations, and
remove the flag before broader rollout.

## Environment File

Create the runtime env file:

```bash
cp .env.runtime.example .env.runtime
```

At minimum, set:

- `API_IMAGE`
- `DASHBOARD_IMAGE`
- `MIGRATE_IMAGE`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `ENCRYPTION_KEY`
- `PUBLIC_API_URL`
- `MCP_PUBLIC_URL`
- `PUBLIC_OIDC_BASE_URL`
- `ALLOW_INSECURE_PRIVATE_HTTP_ORIGINS` only if you are deliberately running an internal HTTP-only trial on private-network IPs
- `KEYCLOAK_BASE_URL`
- `LOCAL_OIDC_BASE_URL`
- `KEYCLOAK_ADMIN`
- `KEYCLOAK_ADMIN_PASSWORD`

Choose one enrichment mode:

- ONNX embeddings only (default):
  - `ENRICHMENT_CHAT_PROVIDER=none`
  - `ENRICHMENT_EMBEDDING_PROVIDER=onnx`
  - agents must provide `summary` and `tags` in `memory_store`

- Ollama for both chat and embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=ollama`
  - `ENRICHMENT_EMBEDDING_PROVIDER=ollama`
- hosted chat plus hosted embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=openai`
  - `ENRICHMENT_EMBEDDING_PROVIDER=openai`
- Ollama chat plus ONNX embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=ollama`
  - `ENRICHMENT_EMBEDDING_PROVIDER=onnx`

Important env notes:

- `ENRICHMENT_CHAT_PROVIDER` and `ENRICHMENT_EMBEDDING_PROVIDER` are the canonical settings.
- `ENRICHMENT_PROVIDER` is still accepted as legacy shorthand, but do not use it for new production configs.
- `EMBEDDING_DIMENSIONS` must match your embedding model before the first migration.
- `AUDIT_PURGE_DATABASE_URL` is optional but recommended when audit retention deletes should run under a restricted DB role.
- in production, set `NEXTAUTH_URL`, `PUBLIC_API_URL`, `MCP_PUBLIC_URL`, and `PUBLIC_OIDC_BASE_URL` to `https://` public origins
- `ALLOW_INSECURE_PRIVATE_HTTP_ORIGINS=true` is an internal-trial escape hatch for raw private-network `http://` origins only; do not use it for internet-facing deployments
- rotate the example `ENCRYPTION_KEY`; do not use the template value in production

The full template is in [`../.env.runtime.example`](../.env.runtime.example).

The runtime template includes local defaults and commented GHCR examples:

- `API_IMAGE`
- `DASHBOARD_IMAGE`
- `MIGRATE_IMAGE`

For production deploys, use pinned release tags (for example `v0.2.0`) rather than `latest`.

## Deploy

1. Pull or build the images.

If you are using published images:

```bash
# pull configured images from .env.runtime
pnpm runtime:pull

# equivalent Docker Compose commands
docker compose --env-file .env.runtime -f docker-compose.runtime.yml pull
```

If you are testing local images on the same host:

```bash
pnpm local:build
```

2. Start the runtime stack:

```bash
pnpm runtime:up
```

What this does:

- optionally ensures the shared Ollama stack is up (only when configured)
- starts PostgreSQL and Keycloak
- runs platform migrations in the `migrate` image
- starts the API and dashboard
- waits for API, Keycloak, and dashboard readiness

3. Bootstrap Keycloak:

```bash
pnpm runtime:keycloak:setup
```

This writes `.runtime/keycloak.json` with the generated platform and tenant OIDC values for setup.

4. Complete Monet setup:

- open `NEXTAUTH_URL + /setup`
- use the one-time bootstrap token emitted by the API on first startup
- use the `platform.*` values from `.runtime/keycloak.json`
- after platform setup, configure tenant OIDC with the `tenant.*` values from `.runtime/keycloak.json`

## Post-Deployment Verification

Run these checks after every deploy:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
```

Expected results:

- API readiness returns `200`
- dashboard login page loads
- Keycloak responds on its configured URL
- `/setup` or normal login flow works, depending on whether the install is already initialized

Operational checks:

- confirm the API startup log shows a validated startup summary
- confirm platform migrations are current
- confirm the dashboard can complete OIDC login
- if semantic search is enabled, store a memory and verify search works

> **For ongoing operational ownership and admin workflows, see [Platform Administration](../admin/platform-administration.md).**

## Security Verification

Transport security checks:

- confirm the public dashboard URL loads over `https://`
- confirm the public API URL responds over `https://`
- confirm the public OIDC issuer is served over `https://`
- confirm `MCP_PUBLIC_URL` uses `https://`
- confirm tenant MCP URLs resolve as `https://api.monet.example.com/mcp/<tenantSlug>`
- keep raw host ports `4301`, `4310`, and `4400` private behind the reverse proxy unless you are intentionally using break-glass access

Example checks:

```bash
curl -I https://monet.example.com/login
curl -I https://api.monet.example.com/healthz
curl -I https://auth.monet.example.com/realms/monet/.well-known/openid-configuration
```

At-rest encryption checks:

- Monet application-level encryption currently protects stored secrets, not every database field
- encrypted-at-rest application secrets include:
  - `tenant_oauth_configs.client_secret_encrypted`
  - `platform_oauth_configs.client_secret_encrypted`
  - `users.dashboard_api_key_encrypted`
- tenant memory content and audit rows are not application-encrypted; rely on your PostgreSQL/storage-layer encryption controls if you need full database-at-rest coverage

Example verification from the runtime database:

```bash
docker compose \
  --project-name monet-runtime \
  --env-file .env.runtime \
  -f docker-compose.runtime.yml \
  exec postgres \
  psql -U postgres -d monet_runtime \
  -c "SELECT left(client_secret_encrypted, 24) AS tenant_secret_sample FROM tenant_oauth_configs LIMIT 3;"
```

Encrypted values should appear as opaque ciphertext, not raw OIDC client secrets
or dashboard API keys.

## Useful Runtime Commands

- `pnpm runtime:status`
- `pnpm runtime:logs`
- `pnpm runtime:migrate`
- `pnpm runtime:keycloak:setup`
- `pnpm runtime:down`
- `pnpm runtime:reset`

## Troubleshooting

If the API is unready:

- check `pnpm runtime:logs`
- verify `DATABASE_URL` connectivity
- verify migrations completed in the `migrate` container
- check `/health/ready` for the failing component

If startup validation fails:

- confirm `ENCRYPTION_KEY` is present and valid base64 for 32 bytes
- confirm the enrichment provider env vars match the keys/models you configured
- confirm numeric envs such as `EMBEDDING_DIMENSIONS`, `RATE_LIMIT_MAX`, and `RATE_LIMIT_WINDOW_MS` are valid integers

If OIDC login fails:

- confirm `NEXTAUTH_URL`, `PUBLIC_OIDC_BASE_URL`, `KEYCLOAK_BASE_URL`, and `LOCAL_OIDC_BASE_URL` are aligned with your proxy and reachable from the right side of the deployment
- re-run `pnpm runtime:keycloak:setup` after changing runtime URLs
- do not reuse `.local-dev/keycloak.json` for runtime

If the dashboard works but API calls fail:

- confirm `PUBLIC_API_URL` points at the public API hostname
- confirm the proxy forwards `/mcp/*` and `/api/tenants/*` paths to `127.0.0.1:4301`
- inspect logs by `requestId`

If enrichment is degraded:

- check the API startup summary and `/health/ready`
- confirm the chat provider and embedding provider are both configured as intended
- if using Ollama, confirm the shared Ollama stack is healthy with `pnpm ollama:status`

## Scope Notes

This guide describes the recommended single-node Compose deployment for the current open-source release.

It does not cover:

- multi-instance deployments with distributed rate limiting
- external managed databases
- Kubernetes manifests as the primary path
- replacing runtime tenant schema provisioning with a different architecture

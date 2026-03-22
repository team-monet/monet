# Monet

Monet is a multi-tenant memory platform for AI agents.
It provides:

- HTTP API for tenant, agent, group, memory, rule, and audit operations.
- MCP endpoint so agents can read and write memory through standard MCP tools.
- Dashboard UI for tenant/admin operations and memory inspection.

## Repository Layout

- `apps/api` - Monet API service (Hono + TypeScript).
- `apps/dashboard` - Monet dashboard (Next.js).
- `packages/db` - Drizzle schema and migrations.
- `packages/mcp-tools` - MCP tool definitions.
- `packages/types` - shared types.

## Documentation

- [Backup and Restore Guide](docs/backup-restore.md)
- [Migration and Upgrade Guide](docs/migration-upgrade.md)
- [Observability Guide](docs/observability.md)
- [Production Deployment Guide](docs/production-deployment.md)
- [User and Agent Group Model](docs/user-and-agent-group-model.md)

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker or Podman

## Quick Start (Local Dev Environment)

1. Install dependencies:

```bash
pnpm install
```

2. Create local environment config:

```bash
cp .env.local-dev.example .env.local-dev
```

3. Start the local infrastructure:

```bash
pnpm local:up
```

`pnpm local:up` starts PostgreSQL, pgAdmin, and Keycloak, and ensures the shared Ollama stack is running. First startup may take several minutes while Ollama models are pulled.

4. Start the API and dashboard on the host in separate terminals:

```bash
pnpm local:dev:api
pnpm local:dev:dashboard
```

5. Bootstrap local Keycloak:

```bash
pnpm local:keycloak:setup
```

This writes `.local-dev/keycloak.json` with the exact local issuers, client IDs,
client secrets, and sample user credentials.

6. Open the setup flow:

- URL: `http://127.0.0.1:3310/setup`
- Retrieve the one-time bootstrap token from the `pnpm local:dev:api` terminal output.

7. Complete `/setup`:

- Keycloak admin console: `http://keycloak.localhost:3400/admin/`
- Default local Keycloak credentials come from `.env.local-dev`:
  `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
- use the `platform.*` values from `.local-dev/keycloak.json`
- sign in as the generated platform admin user
- create a tenant and configure tenant OIDC with the `tenant.*` values from `.local-dev/keycloak.json`
- nominate the generated tenant admin email

8. Sign in through the normal dashboard login for your tenant slug.

9. Generate local usage metrics snapshot:

```bash
pnpm local:metrics
```

Metrics output is written to `.local-dev/metrics.json`.

## Dashboard Login (Local)

- The local infra stack does not auto-seed a default tenant anymore.
- Real local testing should go through `/setup` and the bundled local Keycloak service.
- For fast UI-only development without OIDC, use `pnpm --filter @monet/dashboard dev:seeded` and sign in with `test-org`.

## Shared Ollama

- Ollama now runs in its own shared stack so local dev and the image-based runtime can reuse the same model cache.
- Start it directly with `pnpm ollama:up` or let `pnpm local:up` / `pnpm runtime:up` ensure it is already running.
- Stop it independently with `pnpm ollama:down`.
- By default the shared stack exposes Ollama on `http://127.0.0.1:11434` for host-run processes and `http://ollama-shared:11434` for containerized runtime services.

## Keycloak (Local)

- Local compose includes Keycloak at `http://keycloak.localhost:3400`.
- Run `pnpm local:keycloak:setup` after `pnpm local:up`.
- The script is idempotent and writes `.local-dev/keycloak.json`.
- By default it creates:
  - platform realm `monet`
  - platform client `monet-platform`
  - platform user `platform-admin@example.com` with password `MonetPlatform1!`
  - tenant realm `acme`
  - tenant client `monet-tenant`
  - tenant admin user `tenant-admin@example.com` with password `MonetTenantAdmin1!`
  - tenant user `tenant-user@example.com` with password `MonetTenantUser1!`
- The script also captures the generated confidential client secrets, so you do not need to look them up in the Keycloak admin UI.
- Use the generated issuer values as-is. The local dashboard cannot use `http://127.0.0.1:3400/...` as an OIDC issuer.
- You can override the default realm, client, and user settings with env vars in `.env.local-dev`.

Use the generated values like this:

1. In `/setup`, enter:
   - platform issuer: `platform.issuer`
   - platform client ID: `platform.clientId`
   - platform client secret: `platform.clientSecret`
   - first platform admin email: `platform.adminUser.email`
2. Sign in to platform login with `platform.adminUser.email` and `platform.adminUser.password`.
3. On the tenant detail page, enter:
   - tenant issuer: `tenant.issuer`
   - tenant client ID: `tenant.clientId`
   - tenant client secret: `tenant.clientSecret`
   - nominated tenant admin email: `tenant.adminUser.email`
4. Sign in to the tenant login with `tenant.adminUser.email` and `tenant.adminUser.password`.

## Daily Local Commands

- `pnpm local:up` - start the local infrastructure stack and ensure shared Ollama is running.
- `pnpm local:dev:api` - run the API on the host with `.env.local-dev`-derived settings.
- `pnpm local:dev:dashboard` - run the dashboard on the host with `.env.local-dev`-derived settings.
- `pnpm local:build` - build the release images for `api`, `dashboard`, and `migrate`.
- `pnpm local:keycloak:setup` - create or refresh the local Keycloak realms, clients, and sample users.
- `pnpm local:status` - show local infra and shared Ollama status.
- `pnpm local:logs` - tail local infra and shared Ollama logs.
- `pnpm local:down` - stop local infra services and preserve DB volume.
- `pnpm local:db:reset` - remove only the local Postgres volume and recreate the DB on the next `local:up`.
- `pnpm local:reset` - destructive reset (removes local infra containers and local volumes).
- `pnpm ollama:up` / `pnpm ollama:down` - manage the shared Ollama stack directly.

## Development Workflow

1. Start required infrastructure:

```bash
pnpm local:up
```

2. Run the API:

```bash
pnpm local:dev:api
```

3. Run the dashboard:

```bash
pnpm local:dev:dashboard
```

4. Common quality checks:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
```

## API Runtime Configuration

Required:

- `DATABASE_URL` - PostgreSQL connection string.
- `ENCRYPTION_KEY` - base64-encoded 32-byte key for secret encryption.
- `API_PORT` - API bind port (default `3001`).

Optional:

- `ENRICHMENT_CHAT_PROVIDER` - `anthropic`, `ollama`, or `openai`. Controls summary/tag generation for memory enrichment jobs.
- `ENRICHMENT_EMBEDDING_PROVIDER` - `ollama`, `onnx`, or `openai`. Controls semantic search embeddings and related-memory vectors.
- `ENRICHMENT_PROVIDER` - legacy shorthand fallback. Mappings: `anthropic -> chat=anthropic, embedding=openai`, `onnx -> chat=ollama, embedding=onnx`, `openai -> both openai`, `ollama -> both ollama`.
- `EMBEDDING_DIMENSIONS` - dimensionality of embedding vectors (default `1024`). Set this to match your chosen embedding model (e.g. `1536` for OpenAI `text-embedding-3-small`, `1024` for Ollama `qwen3-embedding` or ONNX `Snowflake/snowflake-arctic-embed-l-v2.0`). Must be set **before** running the first migration, as it defines the database column width.
- `LOG_LEVEL` - structured log threshold: `info`, `warn`, or `error` (default `info`).
- `LOG_REQUESTS` - set to `false` to suppress structured request logs.
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (defaults `100` per `60000ms`).
- `AUDIT_RETENTION_DAYS` (default `90`).
- `AUDIT_PURGE_ENABLED` - set to `true` to enable audit retention deletes. Purge is disabled by default.
- `AUDIT_PURGE_DATABASE_URL` (separate DB role for retention deletes).

Provider-specific:

- Canonical split keys: `ENRICHMENT_CHAT_API_KEY` and `ENRICHMENT_EMBEDDING_API_KEY`.
- Anthropic chat: `ENRICHMENT_CHAT_API_KEY` or legacy `ENRICHMENT_API_KEY`, plus `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`.
- OpenAI-compatible chat/embeddings: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, `OPENAI_EMBEDDING_MODEL`. Supports split overrides via `OPENAI_CHAT_*` and `OPENAI_EMBEDDING_*`, and also respects `ENRICHMENT_CHAT_API_KEY` / `ENRICHMENT_EMBEDDING_API_KEY`.
- Legacy embedding fallbacks for OpenAI-compatible embeddings: `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`.
- ONNX embeddings: `ONNX_EMBEDDING_MODEL`, `ONNX_QUANTIZED`. This is embedding-only; it does not imply a chat provider. If you still use legacy `ENRICHMENT_PROVIDER=onnx`, chat falls back to Ollama.
- Ollama chat/embeddings: `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_MODELS_DIR`.

## API Startup

```bash
pnpm install
pnpm build
pnpm --filter @monet/api start
```

Startup output should include API startup messages and any recovery summaries (enrichment, retention jobs).

## Graceful Shutdown

On SIGINT/SIGTERM, API:

1. Stops accepting new HTTP connections.
2. Stops background jobs (TTL, audit retention, MCP idle sweep).
3. Waits for in-flight requests and queue drain.
4. Closes database connections.

## Database Migrations

Platform migrations:

```bash
pnpm db:migrate
```

CI/test schema sync:

```bash
pnpm --filter @monet/db exec drizzle-kit push --force
```

Tenant schemas are created during provisioning (`createTenantSchema(...)`).

## Tenant Provisioning

Initial platform setup and tenant provisioning now live in the dashboard control plane.

- Fresh installs: use `/setup` with the one-time bootstrap token emitted by the API on first startup.
- Local long-lived dev: start infra with `pnpm local:up`, run `pnpm local:dev:api` and `pnpm local:dev:dashboard`, then complete `/setup`.

## Release Images

Release-style images are built separately from the day-to-day local dev loop.

Build them with:

```bash
pnpm local:build
```

This builds the `api`, `dashboard`, and `migrate` targets from `docker/monet.Dockerfile`.

## Runtime Stack

The runtime stack is image-only and isolated from the host-run local dev workflow.
For the single recommended production path, use the Docker Compose runtime guide at
[docs/production-deployment.md](docs/production-deployment.md).

1. Create runtime config:

```bash
cp .env.runtime.example .env.runtime
```

2. Choose image sources:

- use `pnpm local:build` if you want to run the locally built `monet-*:local` images
- or set `API_IMAGE`, `DASHBOARD_IMAGE`, and `MIGRATE_IMAGE` in `.env.runtime` to registry tags and run `pnpm runtime:pull`

3. Start the runtime stack:

```bash
pnpm runtime:up
```

`pnpm runtime:up` ensures the shared Ollama stack is running, starts Postgres and Keycloak, runs migrations in the dedicated migrate image, then starts the API and dashboard containers.

Useful runtime commands:

- `pnpm runtime:status`
- `pnpm runtime:logs`
- `pnpm runtime:migrate`
- `pnpm runtime:keycloak:setup`
- `pnpm runtime:down`
- `pnpm runtime:reset`

## Remote Access

To sign in from another machine, use the other machine's reachable view of this
host for public URLs and keep the server-side Keycloak URL on an address Monet
itself can reach.

For the runtime stack, set these in `.env.runtime` before rerunning
`pnpm runtime:keycloak:setup`:

- `NEXTAUTH_URL=http://<your-machine-ip>:4310`
- `PUBLIC_API_URL=http://<your-machine-ip>:4301`
- `PUBLIC_OIDC_BASE_URL=http://<your-machine-ip>:4400`
- `KEYCLOAK_BASE_URL=http://keycloak.localhost:4400`
- `LOCAL_OIDC_BASE_URL=http://keycloak.localhost:4400`

For host-run local dev, do the same in `.env.local-dev`, but use the local ports
(`3310`, `3301`, `3400`) and keep `KEYCLOAK_BASE_URL` / `LOCAL_OIDC_BASE_URL`
pointing at a loopback or other machine-local address.

If you run the API or dashboard directly on the host, `API_HOST=0.0.0.0` and
`DASHBOARD_HOST=0.0.0.0` make them listen on the network instead of only
loopback.

`pnpm runtime:keycloak:setup` writes the generated runtime Keycloak details to `.runtime/keycloak.json` by default.
Use the `platform.*` and `tenant.*` values from that file when completing
dashboard OIDC setup in the runtime stack. Do not reuse `.local-dev/keycloak.json`
for the runtime containers.

## Enrichment Provider Swap

Set `ENRICHMENT_CHAT_PROVIDER` and `ENRICHMENT_EMBEDDING_PROVIDER`, configure the matching provider vars, and keep `EMBEDDING_DIMENSIONS` aligned with your embedding model before restarting the API.

Examples:

- `ENRICHMENT_CHAT_PROVIDER=anthropic` with `ENRICHMENT_EMBEDDING_PROVIDER=openai`
- `ENRICHMENT_CHAT_PROVIDER=ollama` with `ENRICHMENT_EMBEDDING_PROVIDER=onnx`
- `ENRICHMENT_CHAT_PROVIDER=openai` with `ENRICHMENT_EMBEDDING_PROVIDER=ollama`

Legacy `ENRICHMENT_PROVIDER` still works, but it is now just shorthand for those explicit pairings.

Pending enrichment jobs are recovered on startup.

For the shared Ollama stack, containerized runtime services should use:

```bash
OLLAMA_BASE_URL=http://ollama-shared:11434
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:4b
OLLAMA_MODELS_DIR=${HOME}/.ollama
```

For host-run API and dashboard processes against the shared Ollama service, the local wrapper scripts map `OLLAMA_BASE_URL` to `http://127.0.0.1:${OLLAMA_PORT}` automatically. To override it explicitly, set:

```bash
HOST_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

## Backup and Restore

For production guidance, use the [Backup and Restore Guide](docs/backup-restore.md).

For a quick local snapshot:

```bash
pg_dump "$DATABASE_URL" > monet_backup.sql
```

For a quick local restore:

```bash
psql "$DATABASE_URL" < monet_backup.sql
```

## Health and Monitoring

Health endpoints:

- `GET /health`
- `GET /health/live`
- `GET /healthz`
- `GET /health/ready`

Readiness returns `200` only when the API can reach PostgreSQL, the platform migrations are current, and the MCP session subsystem is available. Enrichment configuration is reported as a component state, but missing chat or embedding providers only degrade enrichment features and do not make the API unready.

Runtime Docker Compose already uses readiness for the API container:

```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${API_PORT:-4301}/health/ready >/dev/null || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 6
```

Recommended Kubernetes probes:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  periodSeconds: 10
  timeoutSeconds: 5
readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 6
```

Request logs are structured JSON and should not include secrets or token values.

## Troubleshooting

Common failures:

- `401 unauthorized` - invalid or missing API key.
- `403 forbidden` - role mismatch.
- `409 conflict` - optimistic lock conflict or quota exceeded.
- readiness `503` - DB connectivity, pending migrations, or MCP availability issue.

Recommended checks:

- inspect logs by `requestId`
- verify DB connectivity (`SELECT 1`)
- verify `drizzle.__drizzle_migrations` is current
- verify the API booted with MCP enabled

## Audit Retention

- Default retention is `90` days (`AUDIT_RETENTION_DAYS`).
- Purge is disabled by default. Set `AUDIT_PURGE_ENABLED=true` to enable it.
- When enabled, purge runs at startup and every 24h.
- In production, use `AUDIT_PURGE_DATABASE_URL` with a restricted purge role.

Manual check per tenant schema:

```sql
SELECT COUNT(*) FROM tenant_xxx.audit_log
WHERE created_at < NOW() - INTERVAL '90 days';
```

## API Key Management

API keys are one-time issuance.

Rotation:

1. Register replacement key via `POST /api/agents/register`.
2. Update clients.
3. Revoke old key via `agents.revoked_at`.

## Agent Enrollment

Register a new agent in an existing tenant:

```bash
curl -sS -X POST "$API_BASE_URL/api/agents/register" \
  -H "Authorization: Bearer $EXISTING_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "my-new-agent",
    "isAutonomous": true,
    "groupId": "00000000-0000-0000-0000-000000000000"
  }'
```

Response includes:

- `agent` metadata (`id`, `externalId`, `isAutonomous`, `createdAt`)
- one-time `apiKey` for the new agent

Verify a newly issued key:

```bash
curl -sS "$API_BASE_URL/api/agents/me" \
  -H "Authorization: Bearer $NEW_AGENT_API_KEY"
```

## MCP Connection (Local)

`pnpm local:mcp:smoke` is now a targeted debugging tool. It requires an existing tenant agent API key; the standard local setup flow does not auto-issue one.

Use:

- MCP URL: `http://127.0.0.1:${API_PORT}/mcp`
- Header: `Authorization: Bearer <apiKey>`

Smoke test:

```bash
MCP_API_KEY="<apiKey>" pnpm local:mcp:smoke
```

Optional write verification:

```bash
MCP_API_KEY="<apiKey>" MCP_SMOKE_WRITE=true pnpm local:mcp:smoke
```

Manual key check:

```bash
API_KEY="<apiKey>"
curl -sS http://127.0.0.1:${API_PORT:-3301}/api/agents/me \
  -H "Authorization: Bearer $API_KEY"
```

## Local Usage Metrics

Generate a usage snapshot:

```bash
pnpm local:metrics
```

Output file: `.local-dev/metrics.json`.

If your local tenant is not named `Local Dev Org`, set `LOCAL_TENANT_ID` or `LOCAL_TENANT_NAME` before running the command.

Includes totals, scope/type distribution, top tags, write trend, top authors, group membership, and audit action counts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

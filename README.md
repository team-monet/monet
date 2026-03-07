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

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker Desktop (for prod-like local environment)

## Quick Start (Long-Lived Local Environment)

1. Install dependencies:

```bash
pnpm install
```

2. Create local environment config:

```bash
cp .env.local-dev.example .env.local-dev
```

3. Start API stack (Postgres + Ollama + migrations + API):

```bash
pnpm local:up
```

First startup may take several minutes while Ollama models are pulled.

4. Bootstrap local tenant/admin/agent credentials:

```bash
pnpm local:bootstrap
```

5. Optional: start dashboard:

```bash
pnpm local:up:dashboard
```

6. Use bootstrap output:

- File: `.local-dev/bootstrap.json`
- Contains API base URL, MCP URL, tenant/group IDs, and a fresh agent API key.

7. Verify MCP connectivity:

```bash
MCP_API_KEY="<apiKey>" pnpm local:mcp:smoke
```

8. Generate local usage metrics snapshot:

```bash
pnpm local:metrics
```

Metrics output is written to `.local-dev/metrics.json`.

## Dashboard Login (Local)

- Organization: `test-org`
- Local auth mode maps this to `LOCAL_TENANT_NAME` when `DASHBOARD_LOCAL_AUTH=true`.
- If you see `Organization not found`, run `pnpm local:bootstrap` and retry.

## Daily Local Commands

- `pnpm local:status` - show service status.
- `pnpm local:logs` - tail service logs.
- `pnpm local:down` - stop services and preserve DB volume.
- `pnpm local:reset` - destructive reset (removes volume/state).
- `pnpm local:init` - `local:up` + `local:bootstrap`.
- `pnpm local:init:dashboard` - `local:up:dashboard` + `local:bootstrap`.

## Development Workflow

1. Start required infrastructure:

```bash
pnpm local:up
```

2. For full workspace development:

```bash
pnpm dev
```

3. Common quality checks:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
```

## API Runtime Configuration

Required:

- `DATABASE_URL` - PostgreSQL connection string.
- `PLATFORM_ADMIN_SECRET` - platform admin secret for tenant provisioning/bootstrap.
- `API_PORT` - API bind port (default `3001`).
- `ENRICHMENT_PROVIDER` - `anthropic` or `ollama`.

Optional:

- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (defaults `100` per `60000ms`).
- `AUDIT_RETENTION_DAYS` (default `90`).
- `AUDIT_PURGE_DATABASE_URL` (separate DB role for retention deletes).

Provider-specific:

- Anthropic: `ENRICHMENT_API_KEY`, `EMBEDDING_API_KEY`, `ANTHROPIC_MODEL`, `EMBEDDING_MODEL`.
- Ollama: `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_MODELS_DIR`.
  - Monet expects 1536-dimensional embeddings and requests that size from Ollama.

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

```bash
curl -sS -X POST "$API_BASE_URL/api/tenants" \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-org"}'
```

Response includes tenant metadata, initial admin agent, and one-time API key.

## Enrichment Provider Swap

Set `ENRICHMENT_PROVIDER=anthropic` or `ENRICHMENT_PROVIDER=ollama`, configure provider vars, then restart API.

Pending enrichment jobs are recovered on startup.

For local Ollama in the compose stack, keep:

```bash
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:4b
OLLAMA_MODELS_DIR=${HOME}/.ollama
```

For host-installed Ollama instead of compose service:

```bash
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

## Backup and Restore

Backup:

```bash
pg_dump "$DATABASE_URL" > monet_backup.sql
```

Restore:

```bash
psql "$DATABASE_URL" < monet_backup.sql
```

## Health and Monitoring

Health endpoints:

- `GET /health`
- `GET /health/live`
- `GET /health/ready`

Request logs are structured JSON and should not include secrets or token values.

## Troubleshooting

Common failures:

- `401 unauthorized` - invalid or missing API key.
- `403 forbidden` - role mismatch.
- `409 conflict` - optimistic lock conflict or quota exceeded.
- readiness `503` - DB or enrichment provider config issue.

Recommended checks:

- inspect logs by `requestId`
- verify DB connectivity (`SELECT 1`)
- verify enrichment env vars

## Audit Retention

- Default retention is `90` days (`AUDIT_RETENTION_DAYS`).
- Purge runs at startup and every 24h.
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

For platform bootstrap flows (no tenant agent key yet), use the platform secret and tenant header:

```bash
curl -sS -X POST "$API_BASE_URL/api/agents/register" \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "bootstrap-agent",
    "isAutonomous": true
  }'
```

Verify a newly issued key:

```bash
curl -sS "$API_BASE_URL/api/agents/me" \
  -H "Authorization: Bearer $NEW_AGENT_API_KEY"
```

## MCP Connection (Local)

After `pnpm local:bootstrap`, read `.local-dev/bootstrap.json` and use:

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

Includes totals, scope/type distribution, top tags, write trend, top authors, group membership, and audit action counts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

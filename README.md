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

- [User and Agent Group Model](docs/user-and-agent-group-model.md)

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker or Podman

## Quick Start (Long-Lived Local Environment)

1. Install dependencies:

```bash
pnpm install
```

2. Create local environment config:

```bash
cp .env.local-dev.example .env.local-dev
```

3. Start the local stack:

```bash
pnpm local:up
```

`pnpm local:up` rebuilds the local images before starting the stack. First startup may take several minutes while images build and Ollama models are pulled.

4. Open the setup flow:

- URL: `http://127.0.0.1:3310/setup`
- Retrieve the one-time bootstrap token from API logs:

```bash
pnpm local:logs
```

5. Bootstrap local Keycloak:

```bash
pnpm local:keycloak:setup
```

This writes `.local-dev/keycloak.json` with the exact local issuers, client IDs,
client secrets, and sample user credentials.

6. Complete `/setup`:

- Keycloak admin console: `http://keycloak.localhost:3400/admin/`
- Default local Keycloak credentials come from `.env.local-dev`:
  `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
- use the `platform.*` values from `.local-dev/keycloak.json`
- sign in as the generated platform admin user
- create a tenant and configure tenant OIDC with the `tenant.*` values from `.local-dev/keycloak.json`
- nominate the generated tenant admin email

7. Sign in through the normal dashboard login for your tenant slug.

8. Generate local usage metrics snapshot:

```bash
pnpm local:metrics
```

Metrics output is written to `.local-dev/metrics.json`.

## Dashboard Login (Local)

- The compose-based local stack does not auto-seed a default tenant anymore.
- Real local testing should go through `/setup` and the bundled local Keycloak service.
- For fast UI-only development without OIDC, use `pnpm --filter @monet/dashboard dev:seeded` and sign in with `test-org`.

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
- Use the generated issuer values as-is. The local Docker dashboard cannot use `http://127.0.0.1:3400/...` as an OIDC issuer.
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

- `pnpm local:up` - build images, then start the full local stack including dashboard.
- `pnpm local:build` - rebuild the local API and dashboard images without starting the stack.
- `pnpm local:keycloak:setup` - create or refresh the local Keycloak realms, clients, and sample users.
- `pnpm local:status` - show service status.
- `pnpm local:logs` - tail service logs.
- `pnpm local:down` - stop services and preserve DB volume.
- `pnpm local:db:reset` - remove only the local Postgres volume and recreate the DB on the next `local:up`.
- `pnpm local:reset` - destructive reset (removes containers, Postgres data, and Keycloak data).

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

Initial platform setup and tenant provisioning now live in the dashboard control plane.

- Fresh installs: use `/setup` with the one-time bootstrap token emitted by the API on first startup.
- Local long-lived dev: start the stack with `pnpm local:up` and complete `/setup`.

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

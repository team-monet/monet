# Monet API Runbook (M8)

## 1. Startup

Required environment variables:

- `DATABASE_URL` (PostgreSQL connection string)
- `PLATFORM_ADMIN_SECRET` (tenant provisioning/auth bootstrap secret)
- `API_PORT` (default `3001`)
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (optional; defaults `100` per `60000ms`)
- `ENRICHMENT_PROVIDER` (`anthropic` or `ollama`)
- `AUDIT_RETENTION_DAYS` (optional; default `90`)
- `AUDIT_PURGE_DATABASE_URL` (optional; dedicated DB role for audit purge)

Optional provider-specific variables:

- Anthropic: `ENRICHMENT_API_KEY`, `EMBEDDING_API_KEY`, `ANTHROPIC_MODEL`, `EMBEDDING_MODEL`
- Ollama: `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`

Start commands:

```bash
pnpm install
pnpm build
pnpm --filter @monet/api start
```

Expected startup output includes:

- API startup messages
- optional enrichment recovery summary
- optional TTL/audit purge startup summaries

## 2. Shutdown

SIGINT/SIGTERM triggers graceful shutdown:

1. Stop accepting new HTTP connections.
2. Stop TTL and audit-retention background jobs.
3. Stop MCP idle sweep and close active MCP sessions.
4. Wait up to 10s for in-flight HTTP requests.
5. Wait up to 30s for enrichment queue drain.
6. Close database connection(s).

If timeout is reached, shutdown continues to avoid hanging process termination.

## 3. Database Migrations

Platform schema migrations:

```bash
pnpm db:migrate
```

CI/test schema sync:

```bash
pnpm --filter @monet/db exec drizzle-kit push --force
```

Tenant schemas are created during tenant provisioning and are managed by `createTenantSchema(...)`.

## 4. Tenant Provisioning

Create tenant:

```bash
curl -sS -X POST "$API_BASE_URL/api/tenants" \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-org"}'
```

Response includes:

- `tenant` object
- initial admin `agent`
- one-time `apiKey` for that admin agent

## 5. Enrichment Provider Swap

Switch provider by changing environment values and restarting API:

- `ENRICHMENT_PROVIDER=anthropic` or `ENRICHMENT_PROVIDER=ollama`
- provider-specific keys/URLs/models as needed

Pending enrichments are recovered on startup (`pending`, `processing`, `failed` entries are re-queued).

## 6. Backup and Restore

Backup:

```bash
pg_dump "$DATABASE_URL" > monet_backup.sql
```

Restore:

```bash
psql "$DATABASE_URL" < monet_backup.sql
```

Monet stores all state in PostgreSQL for Phase 1.

## 7. Monitoring and Health

Health endpoints:

- `GET /health` (basic process metadata)
- `GET /health/live` (liveness)
- `GET /health/ready` (DB + enrichment config readiness)

Structured request logs (JSON) include:

- `timestamp`, `level`, `message`
- `requestId`, `method`, `path`, `statusCode`, `latencyMs`
- `tenantId`, `agentId` when available

`Authorization` tokens and enrichment payload bodies must not be logged.

## 8. Troubleshooting

Common issues:

- `401 unauthorized`: invalid/missing API key
- `403 forbidden`: role mismatch (tenant/group admin checks)
- `409 conflict`: optimistic lock conflict or quota exceeded
- readiness `503`: DB unreachable or enrichment provider not configured
- MCP session churn: check `/mcp` auth + session headers, and idle sweep behavior

Recommended checks:

- inspect latest structured logs by `requestId`
- validate DB connectivity (`SELECT 1`)
- validate `ENRICHMENT_PROVIDER` and provider-specific env vars

## 9. Audit Log Retention

Retention:

- default `90` days via `AUDIT_RETENTION_DAYS`
- startup purge + recurring purge every 24h

Recommended production setup:

- main app connection remains append-only for routine operations
- use `AUDIT_PURGE_DATABASE_URL` with a dedicated DB role limited to retention deletes

Manual check query (per tenant schema):

```sql
SELECT COUNT(*) FROM tenant_xxx.audit_log
WHERE created_at < NOW() - INTERVAL '90 days';
```

## 10. API Key Management

API keys are one-time issuance.

Rotation process:

1. Register a replacement agent key (`POST /api/agents/register`).
2. Update clients to use the new key.
3. Revoke old key by setting `agents.revoked_at`.

Revoked keys are rejected on subsequent API/MCP requests.

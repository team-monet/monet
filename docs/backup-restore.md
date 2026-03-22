# Backup And Restore Guide

This guide covers the recommended backup and recovery model for the M4
production path:

- single host
- Docker Compose runtime stack
- one PostgreSQL instance
- tenant data isolated by schema inside the shared database

The most important rule is simple:

- full-database backup and restore is the primary supported recovery path

Per-tenant recovery is possible, but it is a guided operator workflow rather
than a one-command product feature.

## What To Back Up

At minimum, protect these assets together:

- PostgreSQL data
- `.env.runtime`
- `.runtime/keycloak.json` after runtime Keycloak bootstrap
- reverse proxy and DNS configuration
- the deployed image tags for `API_IMAGE`, `DASHBOARD_IMAGE`, and `MIGRATE_IMAGE`

The database holds tenant schemas plus shared platform metadata. The runtime env
file and OIDC bootstrap output are required to make a restored deployment usable.

## Recommended Backup Strategy

Use a layered approach:

1. Regular logical backups with `pg_dump`
2. Volume or storage snapshots for the PostgreSQL data disk
3. WAL archiving or managed Postgres point-in-time recovery when you need a low
   RPO

The current Compose stack does not configure WAL archiving for you. If you need
point-in-time recovery, add PostgreSQL archiving outside the default M4 stack or
use a managed PostgreSQL offering with PITR support.

## Full Database Backup

For the M4 runtime stack, take logical backups from the running `postgres`
container.

Example:

```bash
docker compose \
  --project-name monet-runtime \
  --env-file .env.runtime \
  -f docker-compose.runtime.yml \
  exec -T postgres \
  pg_dump -U postgres -d monet_runtime -Fc \
  > monet-$(date +%F-%H%M%S).dump
```

If you changed `MONET_RUNTIME_COMPOSE_PROJECT`, the DB name, or the DB user,
replace the example values with the ones from `.env.runtime`.

Recommended cadence:

- at least daily logical backups for evaluation and low-risk deployments
- more frequent backups plus WAL archiving for production environments with low
  tolerated data loss

## WAL Archiving Guidance

Use WAL archiving when your acceptable data loss is smaller than the interval
between full logical backups.

Recommended approaches:

- managed PostgreSQL with built-in PITR
- self-managed PostgreSQL with WAL archiving to durable object storage
- scheduled base backups plus archived WAL segments

For the M4 Compose path, logical dumps are still useful even when WAL archiving
is enabled:

- they are easy to inspect
- they are easy to restore into scratch environments
- they are useful for tenant-level extraction during recovery work

## Full Environment Restore

This is the primary recovery procedure for production incidents.

1. Stop the runtime stack:

```bash
pnpm runtime:down
```

2. Start PostgreSQL by itself for the restore window:

```bash
docker compose \
  --project-name monet-runtime \
  --env-file .env.runtime \
  -f docker-compose.runtime.yml \
  up -d postgres
```

3. Restore the PostgreSQL backup into a clean database.

Example:

```bash
cat monet-2026-03-22-120000.dump | docker compose \
  --project-name monet-runtime \
  --env-file .env.runtime \
  -f docker-compose.runtime.yml \
  exec -T postgres \
  pg_restore -U postgres -d monet_runtime --clean --if-exists --no-owner --no-privileges
```

4. Start Monet again:

```bash
pnpm runtime:up
```

5. Re-run runtime Keycloak setup only if the runtime URLs or OIDC configuration
   changed as part of the recovery environment:

```bash
pnpm runtime:keycloak:setup
```

6. Verify the restore:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
pnpm runtime:logs
```

Functional checks after restore:

- platform admin login works
- tenant admin login works
- memory search works for a known tenant
- startup validation reports current migrations

## Per-Tenant Recovery

Tenant-level recovery is possible because Monet stores tenant content in a
dedicated PostgreSQL schema per tenant, but tenant state is not isolated to that
schema alone.

Tenant data lives in two places:

- the tenant schema, such as `tenant_1234_...`
- shared platform tables keyed by `tenant_id`

Because of that split, the recommended per-tenant recovery workflow is:

1. Restore the full database backup into a scratch PostgreSQL instance.
2. Identify the tenant ID and derived schema name in the scratch database.
3. Export the tenant schema from scratch.
4. Export the tenant-owned rows from the shared platform tables.
5. Apply the extracted data into the target environment during a maintenance
   window.
6. Verify tenant login, agent access, and memory search before reopening access.

### Tenant Schema Name

The tenant schema name is derived from the tenant UUID by replacing dashes with
underscores and prefixing `tenant_`.

Example:

- tenant ID: `12345678-1234-1234-1234-1234567890ab`
- schema: `tenant_12345678_1234_1234_1234_1234567890ab`

### Shared Platform Tables To Include

At minimum, per-tenant recovery work must account for these shared tables:

- `tenants`
- `users`
- `tenant_oauth_configs`
- `tenant_admin_nominations`
- `user_groups`
- `agents`
- `agent_groups`
- `user_group_members`
- `user_group_agent_group_permissions`
- `agent_group_members`

The tenant schema alone is not enough to recover a working tenant.

### Tenant Schema Export Example

From the scratch restore:

```bash
pg_dump -Fc -d "$SCRATCH_DATABASE_URL" -n "tenant_12345678_1234_1234_1234_1234567890ab" \
  > tenant-schema.dump
```

### Important Limitation

Monet does not currently ship an automated tenant-only export/import tool for
the shared platform rows listed above. Use a scratch restore plus explicit SQL
export/import steps for those tables, and rehearse the process before you need
it in production.

## Recovery Testing

Backups are only useful if restore is rehearsed.

Recommended practice:

- test full restore at least quarterly
- test per-tenant recovery at least once before you promise it operationally
- test after any major migration or deployment topology change

For each recovery test, record:

- backup timestamp used
- restore start and finish times
- restore errors or manual fixes required
- final `/health/ready` result
- whether login, setup state, and memory search worked

## RPO And RTO Guidance

Suggested targets by deployment tier:

- evaluation / internal trial
  - backup model: daily `pg_dump`
  - target RPO: up to 24 hours
  - target RTO: 4 to 8 hours
- standard production
  - backup model: daily logical backup plus WAL archiving or managed PITR
  - target RPO: 15 minutes or better
  - target RTO: 1 to 4 hours
- business-critical production
  - backup model: PITR-capable Postgres, rehearsed restore, off-host backup
    retention, and regular recovery drills
  - target RPO: under 5 minutes
  - target RTO: under 1 hour

These are planning targets, not guarantees. Your actual RPO/RTO depends on
backup frequency, storage durability, operator practice, and how often you test
the procedure.

## Scope Notes

This guide is intentionally aligned with the current M4 architecture.

It does not provide:

- automated tenant-only restore tooling
- built-in WAL archiving configuration in the default Compose stack
- multi-region disaster recovery
- zero-downtime failover between multiple Monet API instances

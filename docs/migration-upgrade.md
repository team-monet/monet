# Migration And Upgrade Guide

This guide covers safe upgrades for the recommended M4 production path:

- single host
- Docker Compose runtime stack
- one PostgreSQL instance
- one API container
- one dashboard container

It is intentionally conservative. The default operating model for M4 upgrades is
"take a maintenance window, stop traffic, migrate, verify, then resume."

## Upgrade Model

For the recommended M4 deployment:

- upgrades are forward-only
- database migrations must succeed before the API is considered ready
- the supported upgrade path is stop -> migrate -> start
- zero-downtime upgrades are not part of the recommended single-node path

If you need rolling or zero-downtime upgrades, treat that as a separate
architecture track rather than an extension of this guide.

## Before You Upgrade

Before every version change:

1. Review the release notes or deployment diff.
2. Check whether new env vars, image tags, or Keycloak settings are required.
3. Take a database backup before applying migrations.
4. Record the currently deployed image tags so you can redeploy the prior
   version if the application rollback path is needed.
5. Plan a short maintenance window.

Minimum pre-upgrade checks:

- `pnpm runtime:status`
- `curl -f http://127.0.0.1:4301/health/ready`
- `pnpm runtime:logs`

Do not start an upgrade while `/health/ready` is already failing unless you have
understood and accepted the existing fault.

## Standard Upgrade Procedure

This is the recommended M4 upgrade sequence.

1. Pull or build the new images.

If you are using published images:

```bash
pnpm runtime:pull
```

If you are using local images on the same host:

```bash
pnpm local:build
```

2. Stop the runtime stack:

```bash
pnpm runtime:down
```

3. Run the database migrations:

```bash
pnpm runtime:migrate
```

This runs the dedicated `migrate` container and starts PostgreSQL as a Compose
dependency if it is not already running.

4. Start the upgraded runtime stack:

```bash
pnpm runtime:up
```

`pnpm runtime:up` runs the migration step again as part of startup. That second
run should be a no-op when the schema is already current, which provides a
useful safety check that the new runtime image and the database are aligned.

## Migration Verification

After every upgrade, verify all of the following:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
pnpm runtime:logs
```

Expected results:

- the API returns `200` on `/healthz`
- the API returns `200` on `/health/ready`
- the startup summary reports current platform migrations
- the `migrate` container exits successfully
- the dashboard login page loads

If you want database-level confirmation, inspect the migration journal table from
PostgreSQL and confirm a recent row exists in `drizzle.__drizzle_migrations`.
Use the values from `.env.runtime` for the DB name and user if you changed the
defaults. If you changed `MONET_RUNTIME_COMPOSE_PROJECT`, replace
`monet-runtime` in the example below with your configured project name.

Example:

```bash
docker compose \
  --project-name monet-runtime \
  --env-file .env.runtime \
  -f docker-compose.runtime.yml \
  exec postgres \
  psql -U postgres -d monet_runtime \
  -c 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;'
```

Also verify one functional path after the upgrade:

- platform admin login works
- tenant admin login works
- a simple memory search succeeds

## Rollback Guidance

There is no automatic down-migration workflow in the recommended M4 path.

Treat database migrations as forward-only. If an upgrade fails, your rollback
options are:

- if the problem is only application config or image wiring, fix the config and
  re-run `pnpm runtime:up`
- if the new application image is bad but the schema is still compatible,
  redeploy the previous image tags
- if the migration introduced an incompatible schema change or left the database
  in a bad state, restore the pre-upgrade database backup and redeploy the
  previous image tags

Do not assume that simply redeploying older images is safe after a schema
change. Restore from backup when compatibility is uncertain.

## Failed Upgrade Triage

If `pnpm runtime:migrate` fails:

- stop and read the migration container logs first
- do not continue to `pnpm runtime:up` until you understand the failure
- confirm database connectivity and credentials
- confirm the database user can read and write the `drizzle` schema

If `pnpm runtime:up` fails after migrations:

- inspect `pnpm runtime:logs`
- check the API startup validation output
- check `/health/ready` for the failing component
- confirm any new required env vars were added to `.env.runtime`

If OIDC login breaks after upgrade:

- confirm `NEXTAUTH_URL`, `PUBLIC_OIDC_BASE_URL`, `KEYCLOAK_BASE_URL`, and
  `LOCAL_OIDC_BASE_URL` still match the deployed hostnames
- re-run `pnpm runtime:keycloak:setup` only when the runtime OIDC values
  changed intentionally

## Breaking Change Policy

For the M4 production path, upgrades should follow these rules:

- new required env vars must be documented before release
- manual upgrade steps must be documented before release
- destructive or incompatible schema changes require an explicit operator note
  and a backup-first maintenance window
- if a release cannot follow the standard stop -> migrate -> start procedure,
  that exception must be called out in the release notes

In practical terms, operators should not assume "just pull and restart" unless
the release notes say so explicitly.

## Zero-Downtime Status

Zero-downtime upgrades are not supported in the recommended M4 deployment.

Reasons:

- the recommended topology uses a single API instance
- migrations run in front of application startup
- distributed rate limiting is not part of the single-node M4 path

If you need zero-downtime or rolling upgrades, treat that as a later milestone
with multi-instance coordination, distributed state, and a separately validated
runbook.

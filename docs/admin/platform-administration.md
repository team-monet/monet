# Platform Administration Guide

This guide is the operational starting point for Monet platform admins.

It consolidates platform-level responsibilities, setup flow, and recurring
operations, then links to the deeper runbooks for deployment, observability,
backup, and upgrades.

If you are new to Monet administration, read this document first, then follow
the linked deep dives.

---

## What platform administration means in Monet

In Monet, platform administration is the control-plane function for a
multi-tenant deployment. Platform admins are responsible for:

- initializing the platform securely
- configuring platform and tenant identity providers (OIDC)
- creating and onboarding tenant organizations
- delegating tenant administration safely
- monitoring platform health and tenant-level operational signals
- operating backup, recovery, and upgrade routines

Platform admin actions happen primarily in:

- dashboard platform routes (`/setup`, `/platform`, `/platform/tenants/:tenantId`)
- bootstrap API routes (`/api/bootstrap/status`, `/api/bootstrap/exchange`)

Tenant runtime actions (agents, memories, tenant admin dashboards) remain
tenant-scoped under `/api/tenants/:tenantSlug/...` and `/mcp/:tenantSlug`.

---

## Access model: platform admin vs tenant admin

Monet has separate administrative contexts.

### Platform admin

Scope: global control plane.

Can:

- run first-time platform setup
- manage tenant registry (create tenants, assign slugs, configure tenant OIDC)
- nominate tenant admin email(s)
- configure platform OIDC

Does not directly manage day-to-day tenant resources (agent groups, user groups,
rules, quotas) unless also operating as a tenant admin inside a tenant context.

### Tenant admin

Scope: one tenant.

Can:

- manage agents, groups, user groups, rules, quotas
- access tenant audit and metrics endpoints
- administer tenant policy and memory governance

Tenant role model details are in:

- [User And Agent Group Model](../architecture/user-and-agent-group-model.md)

---

## Platform bootstrap: first-time initialization

Use this flow for a fresh deployment.

1. Deploy runtime stack and bootstrap Keycloak/OIDC scaffolding:
   - Follow [Production Deployment Guide](../operations/production-deployment.md).
2. Open dashboard setup page:
   - `/setup`
3. Exchange one-time bootstrap token (from API startup logs).
4. Configure platform OIDC:
   - issuer
   - client ID
   - client secret
   - initial platform admin email
5. Continue to `/platform/login` and complete OIDC sign-in.
6. Verify redirect into `/platform` and tenant management access.

Notes:

- Setup is blocked once platform initialization is complete.
- Setup session is cookie-based and time-limited.
- Platform admin binding requires verified email from the IdP.

For local setup specifics, see:

- [Local Development Quickstart](../getting-started/local-development.md)

---

## OIDC and identity configuration

Monet uses two OIDC contexts:

- **Platform OIDC** for platform admin control plane login
- **Tenant OIDC** per tenant for tenant user/admin login

### Platform OIDC

Configured during `/setup`. Treat this as production-critical control-plane
identity.

Recommended controls:

- use a dedicated confidential client for platform login
- require verified email claims
- limit platform-admin nominations to tightly controlled identities

### Tenant OIDC

Configured per tenant in `/platform/tenants/:tenantId`.

Each tenant requires:

- OIDC issuer
- tenant client ID
- tenant client secret

Tenant admin nomination is email-based and is claimed at first verified login.
Email matching is normalized (trim + lowercase) before comparison.
The IdP must assert `email_verified=true`.

Deployment and URL alignment details:

- [Production Deployment Guide](../operations/production-deployment.md)

---

## Tenant lifecycle management

Use this as the default lifecycle.

### 1) Create tenant

From `/platform`:

- set display name
- set stable slug (used in `/login?tenant=<slug>`)
- choose isolation mode (current OSS runtime model is logical schema isolation)

Monet provisions default tenant artifacts automatically:

- tenant schema
- default `Everyone` user group
- default `General` agent group
- default permission edge (`Everyone` -> `General`)
- initial tenant-admin agent in `General`

### 2) Configure tenant auth

In tenant detail page:

- save tenant OIDC configuration
- verify OIDC status changes to configured

### 3) Delegate tenant admin

- add tenant admin nomination by verified email
- confirm nomination status (pending/claimed)
- have nominee sign in through tenant login flow (`/login?tenant=<slug>`)

### 4) Monitor tenant health and usage

Monet OSS provides tenant-scoped metrics and audit (tenant-admin scope), plus
platform-level logs and readiness.

Use:

- tenant metrics: `/api/tenants/:tenantSlug/metrics`
- tenant audit: `/api/tenants/:tenantSlug/audit`
- platform service readiness: `/health/ready`
- structured logs (`http_request`, `mcp_request`) for cross-tenant operations

Monitoring details:

- [Observability Guide](../operations/observability.md)

### 5) Deactivate / offboard tenant (current OSS approach)

Monet does not currently provide a one-click tenant deactivation workflow in the
platform UI.

Recommended operator approach:

- freeze tenant access at IdP level (disable tenant client/users as needed)
- retain tenant data per policy and backup requirements
- if removal is required, treat as a controlled maintenance operation with
  backup-first DB procedures

Use backup/restore and migration runbooks for any destructive change planning.

---

## User and agent group administration boundaries

At platform level, you govern **who can administer** a tenant (through
nomination and identity setup).

Inside each tenant, tenant admins govern:

- user roles (`user`, `group_admin`, `tenant_admin`)
- user groups and memberships
- user-group to agent-group permissions
- agent groups, quotas, and policy assignment

Reference:

- [User And Agent Group Model](../architecture/user-and-agent-group-model.md)

---

## Role delegation workflow (platform admin -> tenant admin)

Use this repeatable handoff:

1. Create tenant and configure tenant OIDC.
2. Save tenant admin nomination using the verified email (matched after normalization: trim + lowercase).
3. Share tenant slug and login route (`/login?tenant=<slug>`).
4. Confirm first successful login claims nomination.
5. Ask tenant admin to verify:
   - agent and group access
   - audit visibility
   - metrics visibility
6. Remove temporary bootstrap/demo access if used.

This keeps platform governance centralized while delegating tenant operations to
tenant owners.

---

## Audit and compliance operations

For ongoing governance, combine:

- tenant audit trails (`memory.*`, `agent.*`, `rule.*`, etc.)
- tenant metrics (usage/benefit/health)
- platform logs and request correlation via `X-Request-Id`

Practical review cadence:

- weekly: tenant usage/health drift checks
- weekly: failed action and auth anomaly review
- monthly: role/access review and admin nomination hygiene
- monthly: backup restore rehearsal status review

Deep dives:

- [Observability Guide](../operations/observability.md)
- [Backup And Restore Guide](../operations/backup-restore.md)

---

## Routine maintenance checklist

### Daily / per deploy

- verify `/health/ready` = `200`
- inspect startup validation output
- confirm API/dashboard/OIDC URLs remain aligned

### Weekly

- review structured logs for elevated 5xx/429 trends
- review tenant operational signals (through tenant admin workflows)
- verify backup job completion and backup artifact accessibility

### Monthly / release

- perform backup restore drill (at least in scratch)
- execute planned upgrades with maintenance window
- validate post-upgrade login, migrations, and memory search path

Canonical procedures:

- backups and recovery: [Backup And Restore Guide](../operations/backup-restore.md)
- upgrades and rollback planning: [Migration And Upgrade Guide](../operations/migration-upgrade.md)
- health checks and alerting: [Observability Guide](../operations/observability.md)

---

## Security considerations for platform admins

### Key and secret rotation

- rotate OIDC client secrets on a defined schedule
- rotate `ENCRYPTION_KEY` only with a planned migration strategy (it protects
  encrypted secret fields)
- rotate Keycloak admin credentials per your internal policy
- never reuse template/default secrets from example env files

### Access control review

- minimize number of platform admins
- periodically verify platform admin email list
- verify tenant admin nominations are intentional and current
- audit tenant role assignments for business-critical tenants

### Tenant isolation verification

- confirm tenant-qualified routes are used (`/api/tenants/:tenantSlug/...`, `/mcp/:tenantSlug`)
- validate tenant schema boundaries in DB operations and recovery rehearsals
- verify no direct cross-tenant data workflows are introduced in custom tooling

Architecture and isolation references:

- [Monet Architecture Overview](../architecture/overview.md)

---

## Troubleshooting platform-level issues

### Setup page loops or setup blocked

Checks:

- `GET /api/bootstrap/status` state
- bootstrap token freshness from API logs
- setup-session cookie and expiry

### Platform login fails after setup

Checks:

- platform OIDC issuer/client values
- callback URL alignment with `NEXTAUTH_URL`
- verified email claim from IdP
- platform admin email nomination correctness

### Tenant login fails

Checks:

- tenant OIDC config exists for target tenant
- tenant slug is correct in `/login?tenant=<slug>`
- `PUBLIC_OIDC_BASE_URL`, `KEYCLOAK_BASE_URL`, and `LOCAL_OIDC_BASE_URL`
  alignment
- re-run Keycloak setup only when runtime OIDC values changed

### API/dashboard healthy but tenant operations fail

Checks:

- tenant-qualified proxy routing for `/api/tenants/*` and `/mcp/*`
- tenant admin permissions and role bindings
- request correlation using `X-Request-Id` in structured logs

### Upgrade/migration readiness failures

Checks:

- migration container success
- `drizzle.__drizzle_migrations` current state
- env variable completeness for new release

Detailed troubleshooting runbooks:

- [Production Deployment Guide](../operations/production-deployment.md)
- [Migration And Upgrade Guide](../operations/migration-upgrade.md)
- [Observability Guide](../operations/observability.md)

---

## Related documentation map

- [README](../../README.md) — high-level product and repo entry point
- [Documentation Index](../README.md) — categorized docs map
- [Local Development Quickstart](../getting-started/local-development.md) — local setup and validation
- [Production Deployment Guide](../operations/production-deployment.md) — runtime deployment and bootstrap
- [Monet Architecture Overview](../architecture/overview.md) — boundaries, auth contexts, data model
- [User And Agent Group Model](../architecture/user-and-agent-group-model.md) — tenant RBAC and group semantics
- [Observability Guide](../operations/observability.md) — logging, health, alerts, investigation
- [Backup And Restore Guide](../operations/backup-restore.md) — backup strategy and recovery procedures
- [Migration And Upgrade Guide](../operations/migration-upgrade.md) — maintenance-window upgrade model

---

## Suggested first-week onboarding plan for a new platform admin

1. Read this guide end-to-end.
2. Run through production/local bootstrap once in a non-production environment.
3. Create a test tenant, configure OIDC, and delegate a tenant admin.
4. Validate tenant audit + metrics visibility with that tenant admin.
5. Rehearse backup restore in scratch.
6. Rehearse an upgrade using the documented maintenance-window flow.

After this sequence, you should be able to run Monet platform administration
confidently and know which deep-dive runbook to use for each operational task.

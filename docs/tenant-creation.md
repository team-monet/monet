# Tenant Creation And Management Guide

This guide is the dedicated tenant lifecycle runbook for Monet operators.

It consolidates the tenant creation flow that is otherwise split across local setup,
runtime deployment, architecture, and access-model docs.

## What A Tenant Is In Monet

In Monet, a tenant is an isolated organization boundary for:

- users and roles
- agents and agent groups
- memories, rules, metrics, and audit data
- tenant-specific OIDC configuration

Tenant context is encoded directly in request paths:

- REST API: `/api/tenants/:tenantSlug/...`
- MCP: `/mcp/:tenantSlug`

Data isolation in the current OSS architecture is **logical schema isolation**:

- shared platform metadata in `public`
- tenant operational data in per-tenant schemas (`tenant_<tenantId>`)

## Prerequisites

Before creating a tenant, confirm:

1. Monet platform bootstrap is complete (or you are ready to complete it at `/setup`).
2. API and dashboard are running and healthy.
3. You have generated Keycloak/OIDC values:
   - local: `.local-dev/keycloak.json`
   - runtime: `.runtime/keycloak.json`
4. You can sign in as a **platform admin**.
5. You know the tenant display name, slug, OIDC issuer/client, and initial tenant-admin email.

Recommended pre-checks:

```bash
curl -f http://127.0.0.1:3301/healthz
curl -f http://127.0.0.1:3301/health/ready
```

## End-To-End Dashboard Flow (Recommended)

This is the primary supported path.

### 1) Complete `/setup` (platform bootstrap)

If Monet is not initialized, open `/setup`:

- local: `http://127.0.0.1:3310/setup`
- runtime: `${NEXTAUTH_URL}/setup`

Then:

1. Paste the one-time bootstrap token from API startup logs.
   - token is one-time use and time-limited
2. Configure platform OIDC (`platform.*` values from keycloak json).
3. Enter the first platform-admin email.
4. Continue to `/platform/login` and sign in with the configured platform IdP.

After first successful platform-admin login, installation is marked initialized.

### 2) Create the tenant in Platform UI

Navigate to `/platform` and use **Create Tenant**.

Required fields:

- **Display name** (for example, `Acme Corporation`)
- **Slug** (for example, `acme`)
- **Isolation mode** (`logical` or `physical`; OSS runtime is logical-schema model)

Slug constraints:

- 3–63 chars
- lowercase letters, numbers, hyphens
- must start with a letter
- no consecutive hyphens
- not one of reserved slugs (`api`, `mcp`, `health`, `setup`, `admin`, `platform`)

On success, Monet redirects to `/platform/tenants/:tenantId`.

### 3) Configure tenant OIDC

On tenant detail page, fill **Tenant OIDC**:

- issuer
- client ID
- client secret

Notes:

- first configuration requires a secret
- later updates can leave secret blank to keep existing secret
- Monet validates issuer discovery and client credentials before saving
- callback path validated by dashboard is:
  - `/api/auth/callback/tenant-oauth`

### 4) Nominate initial tenant admin

On the same page, use **Tenant Admin Nomination** and enter admin email.

At first tenant login, elevation to `tenant_admin` occurs only when:

- login uses that tenant's configured OIDC
- profile email matches nomination after normalization (trim + lowercase)
- IdP provides `email_verified=true`

Nomination state appears as `Pending` then `Claimed` once bound.

### 5) First tenant login

Tenant users sign in at:

`/login?tenant=<tenant-slug>`

On first login, Monet automatically:

1. creates or updates tenant user record
2. ensures default `Everyone` user group
3. adds user to `Everyone` if no memberships exist
4. if no agent groups exist yet, creates baseline `General` and grants `Everyone` -> `General`

The nominated first admin is promoted to `tenant_admin` during this flow.

## API-Based Tenant Creation (Current State)

There is currently **no public platform API route** for tenant creation in
`apps/api`.

Public bootstrap routes exist:

- `GET /api/bootstrap/status`
- `POST /api/bootstrap/exchange`

Tenant provisioning is currently performed by dashboard platform actions (server-side)
and internal service calls (`provisionTenant`) used by scripts.

If you need non-UI automation today, implement it as controlled internal scripting
against Monet services/database code, not as an external public API dependency.

## What Gets Provisioned Automatically

When a tenant is created, Monet provisions:

1. tenant row + tenant schema
2. default user group: `Everyone`
3. default agent group: `General`
4. permission edge: `Everyone` -> `General`
5. initial tenant-admin agent (`external_id = admin@<tenantSlug>`) in `General`
6. default rules seeded as rule set `Default General Guidance` attached to `General`

Seeded default rules include:

- Stay Within Tenant Scope
- Use Least Memory Scope
- Check Memory Before Expensive Work
- Store Durable Knowledge
- Protect Sensitive Information
- Be Clear About Uncertainty
- Avoid Destructive Changes Without Clear Intent
- Keep Shared Memory Actionable
- Escalate High-Risk Work

## Post-Creation Validation Checklist

After creating a tenant:

1. In `/platform`, tenant appears with correct name/slug.
2. Tenant detail page shows **OIDC configured**.
3. Tenant admin nomination is saved.
4. Login works at `/login?tenant=<slug>`.
5. Nominated user becomes `tenant_admin` after verified login.
6. Tenant admin can access admin dashboard pages.
7. Tenant-qualified endpoints resolve with the slug:
   - `/api/tenants/<slug>/...`
   - `/mcp/<slug>`
8. Tenant metrics endpoint is accessible for tenant admin context:
   - `GET /api/tenants/<slug>/metrics`

Optional API smoke check (with a valid tenant agent API key):

```bash
TENANT_SLUG="acme"
API_KEY="<tenant-agent-api-key>"
curl -sS "http://127.0.0.1:3301/api/tenants/$TENANT_SLUG/agents/me" \
  -H "Authorization: Bearer $API_KEY"
```

## Tenant Lifecycle Notes (Deactivation / Deletion)

Current OSS behavior:

- tenant create: supported
- tenant OIDC update: supported
- tenant admin nomination update: supported
- tenant deactivation: no first-class UI/API feature
- tenant deletion: no first-class UI/API feature

For tenant teardown, use a controlled maintenance workflow with backup/restore discipline.
The demo support reset script shows a non-production example of deleting tenant rows
and dropping tenant schema, but it is not a general production lifecycle endpoint.

## Troubleshooting

### Bootstrap token rejected

- ensure token is copied from current API startup logs
- token is one-time and expires; restart/retry setup token exchange as needed
- confirm setup is not already initialized

### Setup session expired during `/setup`

- re-exchange a bootstrap token and repeat platform OIDC form

### Tenant creation fails with slug/name errors

- verify slug format and reserved-slug rules
- ensure slug and name are unique

### Tenant login says organization not found / SSO not configured

- verify tenant slug
- ensure tenant OIDC config exists for that tenant
- confirm OIDC issuer URL is reachable and valid

### Nominated user did not become tenant admin

- confirm nominated email matches IdP email after normalization (trim + lowercase)
- confirm IdP sends `email_verified=true`
- confirm login happened through the same tenant's OIDC provider

### OIDC save fails

- verify issuer metadata (`.well-known/openid-configuration`) is reachable
- verify confidential client ID/secret and callback configuration
- if updating existing config, either provide new secret or keep old one by leaving blank

## Related Documentation

- [Architecture Overview](./architecture.md)
- [Local Development Quickstart](./local-development.md)
- [Production Deployment Guide](./production-deployment.md)
- [User And Agent Group Model](./user-and-agent-group-model.md)
- [Default Agent Group Rules Proposal](./default-agent-group-rules-proposal.md)
- [Demo Support Workflow](./demo-support-workflow.md)
- [Backup And Restore Guide](./backup-restore.md)
- [Observability Guide](./observability.md)
- [Migration And Upgrade Guide](./migration-upgrade.md)

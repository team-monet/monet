# Local Development Quickstart

This guide is the recommended open-source path for running Monet locally on a
new machine.

It is designed to be straightforward for first-time contributors, but first
startup can take longer depending on image/model pulls and local network speed.

## Prerequisites

- Git
- Node.js 22+
- pnpm 10+
- Docker Engine + Docker Compose v2 (or Podman with compose compatibility)
- `curl` (for health checks)

## Quickstart (Clone -> Install -> Run -> Verify)

1. Clone and enter the repository:

```bash
git clone https://github.com/team-monet/monet.git
cd monet
```

2. Install dependencies:

```bash
pnpm install
```

3. Run one-command container quickstart:

```bash
pnpm quickstart
```

This command:

- ensures `.env.runtime` exists (copied from template if missing)
- starts runtime containers (postgres, keycloak, migrate, api, dashboard)
- bootstraps Keycloak + demo tenant + demo API key
- configures platform + tenant OIDC for dashboard login
- prints ready-to-copy MCP config and local login details

The API and dashboard remain running in containers after the command exits.

> ⚠️ Quickstart output includes local bootstrap secrets/API keys.
> `.env.runtime.example` defaults are for local evaluation only and are not production-safe.

4. Verify runtime app URLs:

- Dashboard: `http://127.0.0.1:4310`
- API: `http://127.0.0.1:4301`

The MCP config and demo key are printed by quickstart output.

## Runtime Verification (container quickstart path)

After `pnpm quickstart`, run:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
```

Expected results:

- runtime services are shown as running
- API health endpoints return `200`
- dashboard login loads at `http://127.0.0.1:4310`

## Manual / Advanced Local Flow

If you prefer source-run development (host processes) or step-by-step control, use:

1. Start infrastructure:

```bash
pnpm local:up
```

This local/source path uses ports:

- Dashboard: `http://127.0.0.1:3310`
- API: `http://127.0.0.1:3301`

2. Run init-only bootstrap:

```bash
pnpm local:quickstart:init
```

3. Start API + dashboard yourself (two terminals):

```bash
pnpm local:dev:api
pnpm local:dev:dashboard
```

4. (Optional) Bootstrap local Keycloak realms/clients/users directly:

```bash
pnpm local:keycloak:setup
```

This writes `.local-dev/keycloak.json` with generated `platform.*` and
`tenant.*` values.

Local Keycloak admin console: `http://keycloak.localhost:3400/admin/`

Default local Keycloak admin credentials come from `.env.local-dev`:

- `KEYCLOAK_ADMIN`
- `KEYCLOAK_ADMIN_PASSWORD`

5. (Optional) Complete setup manually in the dashboard:

- Open `http://127.0.0.1:3310/setup`
- Copy the one-time bootstrap token from the API terminal logs
- Use `platform.*` values from `.local-dev/keycloak.json`
- Sign in as the generated platform admin user
- Create a tenant
- Configure tenant OIDC using `tenant.*` values from `.local-dev/keycloak.json`
- Nominate the generated tenant admin email
- Sign in through normal tenant login using the generated tenant admin account

> **For a dedicated end-to-end tenant creation guide, see [Tenant Creation and Management](../admin/tenant-creation.md).**

Optional authenticated API check (after you have an agent API key):

```bash
TENANT_SLUG="acme"
API_KEY="<your-agent-api-key>"
curl -sS "http://127.0.0.1:3301/api/tenants/$TENANT_SLUG/agents/me" \
  -H "Authorization: Bearer $API_KEY"
```

## Common Local Commands

- `pnpm local:status` - show local infra status (plus shared Ollama when enabled)
- `pnpm local:logs` - tail local infra logs (plus shared Ollama when enabled)
- `pnpm local:down` - stop local services, keep volumes
- `pnpm local:db:reset` - reset local Postgres volume only
- `pnpm local:reset` - full destructive local reset

## Common Runtime Commands

- `pnpm runtime:status` - show runtime container status
- `pnpm runtime:logs` - tail runtime logs
- `pnpm runtime:down` - stop runtime stack

## Environment Reference

- Local template: [`../../.env.local-dev.example`](../../.env.local-dev.example)
- Runtime/production template: [`../../.env.runtime.example`](../../.env.runtime.example)

For production deployment, continue with
[Production Deployment Guide](../operations/production-deployment.md).

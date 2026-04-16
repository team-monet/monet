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

3. Create local environment config:

```bash
cp .env.local-dev.example .env.local-dev
```

4. Start local infrastructure:

```bash
pnpm local:up
```

This starts PostgreSQL, pgAdmin, Keycloak, and ensures shared Ollama is running.

5. Start API and dashboard (two terminals):

```bash
pnpm local:dev:api
pnpm local:dev:dashboard
```

6. Bootstrap local Keycloak realms/clients/users:

```bash
pnpm local:keycloak:setup
```

This writes `.local-dev/keycloak.json` with generated `platform.*` and
`tenant.*` values.

Local Keycloak admin console: `http://keycloak.localhost:3400/admin/`

Default local Keycloak admin credentials come from `.env.local-dev`:

- `KEYCLOAK_ADMIN`
- `KEYCLOAK_ADMIN_PASSWORD`

7. Complete initial setup in the dashboard:

- Open `http://127.0.0.1:3310/setup`
- Copy the one-time bootstrap token from the API terminal logs
- Use `platform.*` values from `.local-dev/keycloak.json`
- Sign in as the generated platform admin user
- Create a tenant
- Configure tenant OIDC using `tenant.*` values from `.local-dev/keycloak.json`
- Nominate the generated tenant admin email
- Sign in through normal tenant login using the generated tenant admin account

> **For a dedicated end-to-end tenant creation guide, see [Tenant Creation and Management](tenant-creation.md).**

## Verification

After setup, run these checks:

```bash
pnpm local:status
curl -f http://127.0.0.1:3301/healthz
curl -f http://127.0.0.1:3301/health/ready
```

Expected results:

- local stack services are shown as running
- API health endpoints return `200`
- dashboard login loads at `http://127.0.0.1:3310`

Optional authenticated API check (after you have an agent API key):

```bash
TENANT_SLUG="acme"
API_KEY="<your-agent-api-key>"
curl -sS "http://127.0.0.1:3301/api/tenants/$TENANT_SLUG/agents/me" \
  -H "Authorization: Bearer $API_KEY"
```

## Common Local Commands

- `pnpm local:status` - show local infra + shared Ollama status
- `pnpm local:logs` - tail local infra + shared Ollama logs
- `pnpm local:down` - stop local services, keep volumes
- `pnpm local:db:reset` - reset local Postgres volume only
- `pnpm local:reset` - full destructive local reset

## Environment Reference

- Local template: [`../.env.local-dev.example`](../.env.local-dev.example)
- Runtime/production template: [`../.env.runtime.example`](../.env.runtime.example)

For production deployment, continue with
[Production Deployment Guide](./production-deployment.md).

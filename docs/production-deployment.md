# Production Deployment Guide

This is the recommended Monet production path for M4:

- single host
- Docker Compose runtime stack
- one PostgreSQL instance
- one Keycloak instance
- one API container
- one dashboard container
- optional shared Ollama container for local inference

This guide is intentionally opinionated. It optimizes for a setup that is fast to
understand, repeatable to operate, and aligned with the repo's existing runtime
scripts.

For version changes after initial deployment, follow the
[Migration And Upgrade Guide](migration-upgrade.md).
For durability planning and recovery procedures, follow the
[Backup And Restore Guide](backup-restore.md).

## Recommended Topology

Use one Linux host with:

- Docker Engine and Docker Compose v2
- published images for `api`, `dashboard`, and `migrate`
- a reverse proxy that terminates TLS in front of Monet

Recommended public hostnames:

- `monet.example.com` -> dashboard
- `api.monet.example.com` -> API and MCP
- `auth.monet.example.com` -> Keycloak

Back Monet services with the built-in runtime Compose stack:

- dashboard on host port `4310`
- API on host port `4301`
- Keycloak on host port `4400`
- PostgreSQL on host port `65432`
- Ollama on host port `11434` when enabled

## Prerequisites

Before deploying, make sure you have:

- Docker and Docker Compose v2 installed on the target host
- DNS records for your dashboard, API, and Keycloak hostnames
- a reverse proxy or load balancer that can terminate TLS
- registry images or locally built images for `API_IMAGE`, `DASHBOARD_IMAGE`, and `MIGRATE_IMAGE`
- a strong `NEXTAUTH_SECRET`
- a base64-encoded 32-byte `ENCRYPTION_KEY`
- a plan for persistent Docker volumes and host backups

Generate a 32-byte encryption key with:

```bash
openssl rand -base64 32
```

## Network And Firewall

Recommended exposure:

- expose only `80` and `443` publicly on the reverse proxy
- keep PostgreSQL (`65432`) private to the host or private network
- keep the raw dashboard/API/Keycloak host ports private unless you are explicitly using them for evaluation or break-glass access

Reverse proxy upstreams should point to:

- `127.0.0.1:4310` for the dashboard
- `127.0.0.1:4301` for the API
- `127.0.0.1:4400` for Keycloak

If you use Ollama, keep `11434` private. Monet containers talk to Ollama over the shared Docker network.

## TLS Termination

Terminate TLS at the reverse proxy, not inside the Compose services.

Recommended pattern:

- proxy `https://monet.example.com` -> `http://127.0.0.1:4310`
- proxy `https://api.monet.example.com` -> `http://127.0.0.1:4301`
- proxy `https://auth.monet.example.com` -> `http://127.0.0.1:4400`

Set these public URLs in `.env.runtime`:

- `NEXTAUTH_URL=https://monet.example.com`
- `PUBLIC_API_URL=https://api.monet.example.com`
- `MCP_PUBLIC_URL=https://api.monet.example.com/mcp`
- `PUBLIC_OIDC_BASE_URL=https://auth.monet.example.com`

Keep `KEYCLOAK_BASE_URL` and `LOCAL_OIDC_BASE_URL` on a URL the host and dashboard can actually reach during runtime and Keycloak bootstrap. In the simplest deployment, that can be the same Keycloak hostname if the host can resolve and reach it itself.

## Environment File

Create the runtime env file:

```bash
cp .env.runtime.example .env.runtime
```

At minimum, set:

- `API_IMAGE`
- `DASHBOARD_IMAGE`
- `MIGRATE_IMAGE`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `ENCRYPTION_KEY`
- `PUBLIC_API_URL`
- `MCP_PUBLIC_URL`
- `PUBLIC_OIDC_BASE_URL`
- `KEYCLOAK_BASE_URL`
- `LOCAL_OIDC_BASE_URL`
- `KEYCLOAK_ADMIN`
- `KEYCLOAK_ADMIN_PASSWORD`

Choose one enrichment mode:

- Ollama for both chat and embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=ollama`
  - `ENRICHMENT_EMBEDDING_PROVIDER=ollama`
- hosted chat plus hosted embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=openai`
  - `ENRICHMENT_EMBEDDING_PROVIDER=openai`
- Ollama chat plus ONNX embeddings:
  - `ENRICHMENT_CHAT_PROVIDER=ollama`
  - `ENRICHMENT_EMBEDDING_PROVIDER=onnx`

Important env notes:

- `ENRICHMENT_CHAT_PROVIDER` and `ENRICHMENT_EMBEDDING_PROVIDER` are the canonical settings.
- `ENRICHMENT_PROVIDER` is still accepted as legacy shorthand, but do not use it for new production configs.
- `EMBEDDING_DIMENSIONS` must match your embedding model before the first migration.
- `AUDIT_PURGE_DATABASE_URL` is optional but recommended when audit retention deletes should run under a restricted DB role.

The full template is in [`../.env.runtime.example`](../.env.runtime.example).

## Deploy

1. Pull or build the images.

If you are using published images:

```bash
pnpm runtime:pull
```

If you are testing local images on the same host:

```bash
pnpm local:build
```

2. Start the runtime stack:

```bash
pnpm runtime:up
```

What this does:

- ensures the shared Ollama stack is up
- starts PostgreSQL and Keycloak
- runs platform migrations in the `migrate` image
- starts the API and dashboard
- waits for API, Keycloak, and dashboard readiness

3. Bootstrap Keycloak:

```bash
pnpm runtime:keycloak:setup
```

This writes `.runtime/keycloak.json` with the generated platform and tenant OIDC values for setup.

4. Complete Monet setup:

- open `NEXTAUTH_URL + /setup`
- use the one-time bootstrap token emitted by the API on first startup
- use the `platform.*` values from `.runtime/keycloak.json`
- after platform setup, configure tenant OIDC with the `tenant.*` values from `.runtime/keycloak.json`

## Post-Deployment Verification

Run these checks after every deploy:

```bash
pnpm runtime:status
curl -f http://127.0.0.1:4301/healthz
curl -f http://127.0.0.1:4301/health/ready
```

Expected results:

- API readiness returns `200`
- dashboard login page loads
- Keycloak responds on its configured URL
- `/setup` or normal login flow works, depending on whether the install is already initialized

Operational checks:

- confirm the API startup log shows a validated startup summary
- confirm platform migrations are current
- confirm the dashboard can complete OIDC login
- if semantic search is enabled, store a memory and verify search works

## Useful Runtime Commands

- `pnpm runtime:status`
- `pnpm runtime:logs`
- `pnpm runtime:migrate`
- `pnpm runtime:keycloak:setup`
- `pnpm runtime:down`
- `pnpm runtime:reset`

## Troubleshooting

If the API is unready:

- check `pnpm runtime:logs`
- verify `DATABASE_URL` connectivity
- verify migrations completed in the `migrate` container
- check `/health/ready` for the failing component

If startup validation fails:

- confirm `ENCRYPTION_KEY` is present and valid base64 for 32 bytes
- confirm the enrichment provider env vars match the keys/models you configured
- confirm numeric envs such as `EMBEDDING_DIMENSIONS`, `RATE_LIMIT_MAX`, and `RATE_LIMIT_WINDOW_MS` are valid integers

If OIDC login fails:

- confirm `NEXTAUTH_URL`, `PUBLIC_OIDC_BASE_URL`, `KEYCLOAK_BASE_URL`, and `LOCAL_OIDC_BASE_URL` are aligned with your proxy and reachable from the right side of the deployment
- re-run `pnpm runtime:keycloak:setup` after changing runtime URLs
- do not reuse `.local-dev/keycloak.json` for runtime

If the dashboard works but API calls fail:

- confirm `PUBLIC_API_URL` points at the public API hostname
- confirm the proxy forwards `/mcp` and API paths to `127.0.0.1:4301`
- inspect logs by `requestId`

If enrichment is degraded:

- check the API startup summary and `/health/ready`
- confirm the chat provider and embedding provider are both configured as intended
- if using Ollama, confirm the shared Ollama stack is healthy with `pnpm ollama:status`

## Scope Notes

This guide describes the recommended single-node Compose deployment for M4.

It does not cover:

- multi-instance deployments with distributed rate limiting
- external managed databases
- Kubernetes manifests as the primary path
- replacing runtime tenant schema provisioning with a different architecture

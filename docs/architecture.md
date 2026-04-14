# Monet Architecture Overview

This document is a public, high-level map of Monet's current open-source architecture.
It is written for:

- external contributors who need to orient quickly
- self-hosting operators evaluating deployment and risk boundaries
- technical evaluators comparing capability and isolation assumptions

It focuses on current behavior in this repository and links to deeper docs for operations and setup.

## What Monet Is

Monet is a multi-tenant memory platform for AI agents. It provides:

- a tenant-qualified HTTP API for memory, agent, group, rule, metrics, and audit operations
- a tenant-qualified MCP endpoint so agents can use shared memory through MCP tools
- a dashboard for platform setup, tenant administration, and memory inspection

Monet's architecture is intentionally modular at the package/workspace level, while running as a straightforward service stack (API + dashboard + PostgreSQL + OIDC provider).

## System Components

At runtime, the main components are:

- **API service (`apps/api`)**
  - handles tenant API routes at `/api/tenants/:tenantSlug/...`
  - serves MCP traffic at `/mcp/:tenantSlug`
  - owns memory CRUD/search, auth checks, audit writes, enrichment orchestration, and background jobs
- **Dashboard (`apps/dashboard`)**
  - web control plane for platform bootstrap and tenant admin flows
  - uses OIDC login and role-aware UI flows for platform and tenant contexts
- **PostgreSQL**
  - single cluster with a shared `public` schema plus per-tenant schemas (`tenant_<tenantId>`)
  - includes `pgvector` extension for semantic search embeddings
- **OIDC provider (typically Keycloak in local/runtime guides)**
  - platform auth context (platform admin)
  - tenant auth context (tenant users/admins)

## Repository/Workspace Layout

Core workspace boundaries:

- `apps/api` - HTTP API + MCP transport/session handling + background jobs
- `apps/dashboard` - Next.js dashboard and OIDC-backed web auth
- `packages/db` - Drizzle schema definitions, tenant schema manager, scoped DB helpers
- `packages/mcp-tools` - canonical MCP tool schemas/definitions registered by the API MCP server
- `packages/types` - shared runtime/types for API and dashboard

This split keeps transport/UI concerns in apps while centralizing contract and schema definitions in packages.

## Request and Data Boundaries

Monet encodes tenant context in request paths:

- REST: `/api/tenants/:tenantSlug/...`
- MCP: `/mcp/:tenantSlug`

Request handling (high-level):

1. Resolve `tenantSlug` to tenant ID + derived schema name.
2. Authenticate the caller (agent API key for API/MCP requests).
3. Execute tenant-scoped DB work using transaction-local `SET LOCAL search_path TO "tenant_<id>", public`.

Using `SET LOCAL search_path` inside transaction scope avoids connection-pool leakage between tenants and keeps tenant routing explicit in both API and MCP paths.

## Tenant Isolation Model

Monet OSS currently uses **logical schema isolation** in one PostgreSQL cluster:

- shared `public` schema for platform-level tables (tenant registry, platform setup/bootstrap, OIDC config, nominations)
- tenant operational data in per-tenant schemas (`tenant_<tenantId>`)

Important caveats:

- `isolation_mode` exists in platform metadata (`logical` / `physical`), but current OSS architecture is the logical-schema model.
- this is **not** separate database instances per tenant.
- some tenant-related records intentionally remain in shared `public` tables (for example tenant registry and tenant OIDC config), while tenant operational records live in tenant schemas.

## Identity, Authentication, and Authorization

Monet has two web auth contexts plus agent API-key auth:

- **Platform context (dashboard):** platform admin login and bootstrap/tenant management flows.
- **Tenant context (dashboard):** tenant user/admin login and tenant-scoped management flows.
- **Agent context (API/MCP):** bearer API key authentication for agent operations.

Authorization model highlights:

- user roles include `user`, `group_admin`, `tenant_admin`
- user groups and agent groups are separate control layers
- agents can be **autonomous** or **user-proxy**
- autonomous agents cannot create user-scoped memories

For terminology and operational behavior, see [User and Agent Group Model](./user-and-agent-group-model.md).

## Memory Model and Lifecycle

Memory entries are typed and scoped:

- memory types: `decision`, `pattern`, `issue`, `preference`, `fact`, `procedure`
- memory scopes: `group`, `user`, `private`

Lifecycle characteristics:

- create writes an initial memory row plus version snapshot (`v0`)
- fetch returns full content + version history and increments usefulness metadata
- update uses optimistic concurrency (`expectedVersion`) and creates a new version snapshot
- optional TTL (`ttlSeconds`) computes `expires_at`; background purge removes expired entries
- delete is author-restricted
- semantic fields (summary/auto-tags/embedding/related ids) are populated asynchronously by enrichment

Current OSS caveat: `group` scope is modeled in schema and write paths with group association metadata, but read visibility for group-scoped memories is currently tenant-wide within a tenant schema.

Search combines scope filters, optional lexical matching, and embedding-based ranking when embeddings are available.

## MCP Architecture and Session Lifecycle

MCP endpoint: `/mcp/:tenantSlug`

High-level flow:

1. Agent authenticates with bearer API key.
2. POST without `Mcp-Session-Id` initializes a new session + server transport.
3. Session is stored in-process and reused on subsequent MCP requests by session ID.
4. Idle sessions are swept and closed automatically.

Current implementation characteristics:

- MCP sessions are stored in-process (not externally distributed)
- idle expiry defaults to 30 minutes with periodic sweeps
- per-agent and global session limits are enforced in memory
- session/tenant/agent mismatch checks are enforced on reuse

Tool surface is defined in `packages/mcp-tools` and registered by the API MCP server.

## Background Jobs and Enrichment Pipeline

The API process also runs background jobs:

- TTL expiry purge for expired memories
- audit retention purge (config-gated)
- enrichment recovery/drain for pending memories
- MCP idle session sweep

Enrichment pipeline behavior:

- memory writes enqueue in-process enrichment jobs
- chat provider generates summary/tags; embedding provider generates vectors
- providers are configurable (Anthropic/OpenAI/Ollama for chat; OpenAI/Ollama/ONNX for embeddings)
- queue concurrency is bounded and provider-aware
- on startup, pending enrichment work is recovered from tenant schemas

Caveat: enrichment queue and MCP session state are in-process with bounded limits; multi-instance coordination semantics should not be overstated.

## Storage and Audit Model

Storage model:

- PostgreSQL is the system of record
- per-tenant memory and operational tables live in tenant schemas
- semantic search uses `pgvector` embeddings in tenant memory tables

Audit model:

- memory and related operations emit audit log records
- tenant audit logs are append-only by DB protections (trigger + revoked UPDATE/DELETE)

Encryption caveat:

- Monet application-level encryption protects sensitive stored secrets (for example confidential client secrets)
- it does **not** application-encrypt every field (for example memory content and audit rows)
- use PostgreSQL/storage-layer encryption controls for broader at-rest protection requirements

## Deployment Shape and Operational Constraints

Recommended production shape in current docs is intentionally conservative:

- single-host Docker Compose runtime
- one API instance, one dashboard instance, one PostgreSQL instance, one Keycloak instance

Operational constraints to plan around:

- MCP sessions and enrichment job queue are process-local
- `EMBEDDING_DIMENSIONS` is an architectural setup parameter (defines vector column width at migration/schema creation time), not a casual runtime toggle
- readiness indicates core dependency status, but missing enrichment providers degrade enrichment features rather than blocking API readiness

For deployment procedures and runbooks, see [Production Deployment Guide](./production-deployment.md), [Local Development Quickstart](./local-development.md), and [Observability Guide](./observability.md).

## Extension Points / Integration Surfaces

Current extension surfaces include:

- **HTTP API** for tenant-qualified operations
- **MCP endpoint** for agent memory tooling over MCP
- **Provider abstraction** for enrichment chat/embedding backends
- **Shared packages** (`packages/types`, `packages/mcp-tools`, `packages/db`) for extending contracts and implementations consistently

When extending, keep tenant-qualified routing and tenant-scoped DB execution patterns intact to preserve isolation guarantees.

## Pointers to Deeper Docs

- [Local Development Quickstart](./local-development.md)
- [Production Deployment Guide](./production-deployment.md)
- [Migration and Upgrade Guide](./migration-upgrade.md)
- [Observability Guide](./observability.md)
- [Backup and Restore Guide](./backup-restore.md)
- [User and Agent Group Model](./user-and-agent-group-model.md)

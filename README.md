<div align="center">

# Monet

### Turn your team's AI operational intelligence into a reusable asset.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/team-monet/monet?style=social)](https://github.com/team-monet/monet)

[Getting Started](#getting-started) · [Architecture](#architecture) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

</div>

---

Senior developers get better AI results — not because of better prompts, but because of accumulated operational know-how. **Monet captures that intelligence as shared memory**, so your entire team benefits from the same AI expertise.

Monet is an open-source, multi-tenant memory platform for AI agents. It gives your agent team a shared memory layer that persists across sessions, agents, and team members — with native MCP support and true tenant isolation.

## Why Monet?

| The Problem | How Monet Helps |
|-------------|-----------------|
| Agents lose context between sessions | Memories persist and are searchable across sessions |
| Senior dev AI know-how stays with individuals | Operational intelligence is captured and shared with the team |
| Each agent starts from scratch | Agents inherit accumulated team knowledge from day one |
| No visibility into what agents remember | Dashboard UI for memory inspection and audit trails |

## Key Features

- **🧠 Shared Memory for Agent Teams** — Agents read and write to a shared memory layer scoped by group, user, or private access
- **🔌 Native MCP Support** — Connect any MCP-compatible agent with a single endpoint: `/mcp/:tenantSlug`
- **🏢 True Multi-Tenant Isolation** — PostgreSQL schema-level isolation per tenant, ready for SaaS and MSP use cases
- **📊 Dashboard UI** — Setup, tenant administration, and memory inspection at a glance
- **🔍 Semantic Search** — pgvector-powered embedding search with automatic enrichment (summaries, tags, vectors)
- **📋 Audit Trail** — Append-only audit logs with DB-level protection for compliance and observability
- **🏠 Self-Hosted** — Run on your infrastructure. No cloud lock-in. Your data stays yours.

## Memory That Works Like Your Team

Monet organizes memories by **type** and **scope**, matching how teams actually think:

**Memory Types:** `decision` · `pattern` · `issue` · `preference` · `fact` · `procedure`

**Memory Scopes:**
| Scope | Who Sees It | Use Case |
|-------|-------------|----------|
| `group` | All agents in the group | Shared team knowledge, best practices |
| `user` | Agents serving a specific user | User-specific context and preferences |
| `private` | Only the authoring agent | Agent-specific working notes |

```text
┌─────────────────────────────────────────────┐
│                  Tenant                      │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Agent A   │  │ Agent B   │  │ Agent C   │  │
│  │ (Support) │  │ (Support) │  │ (Billing) │  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
│        │              │              │         │
│        ▼              ▼              ▼         │
│  ┌─────────────────────────────────────────┐  │
│  │           Shared Memory Layer           │  │
│  │                                         │  │
│  │  🔵 group scope   → visible to all     │  │
│  │  🟡 user scope    → per-user context    │  │
│  │  🔴 private scope → agent-only          │  │
│  └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (for local infrastructure)

### Quick Start (Local)

```bash
git clone https://github.com/team-monet/monet.git
cd monet
pnpm install
cp .env.local-dev.example .env.local-dev
pnpm local:up
```

Then follow the full local setup guide:
- **[Local Development Guide →](docs/local-development.md)**

### Connect Your Agent (MCP)

Once Monet is running, connect any MCP-compatible agent:

```json
{
  "mcpServers": {
    "monet": {
      "url": "http://localhost:3301/mcp/your-tenant",
      "headers": {
        "Authorization": "Bearer your-agent-api-key"
      }
    }
  }
}
```

Your agent now has access to these memory tools:

| Tool | What It Does |
|------|-------------|
| `memory_store` | Store a new memory (decision, pattern, issue, preference, fact, procedure) |
| `memory_search` | Search memories by semantic query, tags, or type |
| `memory_fetch` | Fetch full memory content by ID |
| `memory_update` | Update an existing memory with optimistic concurrency |
| `memory_delete` | Delete a memory (author-restricted) |
| `memory_promote_scope` | Promote a memory's visibility (e.g., private → group) |
| `memory_mark_outdated` | Mark a memory as outdated |
| `memory_list_tags` | List all tags used across memories |

### Quick API Example

```bash
# Store a memory
curl -X POST http://localhost:3301/api/tenants/acme/memories \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Always use pagination for list endpoints. Limit default is 50.",
    "memoryType": "pattern",
    "memoryScope": "group",
    "tags": ["api", "best-practice", "pagination"]
  }'

# Search memories
curl "http://localhost:3301/api/tenants/acme/memories?query=pagination+best+practice&limit=5" \
  -H "Authorization: Bearer $API_KEY"
```

## Architecture

Monet runs as a straightforward service stack designed for self-hosted deployment:

```text
┌─────────────┐  ┌──────────────┐
│  Dashboard   │  │  API Service  │── /api/tenants/:slug/...
│  (Next.js)   │  │              │── /mcp/:slug
└─────────────┘  └──────┬───────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼────┐   ┌──────▼──────┐   ┌───▼───┐
   │ PostgreSQL │  │  OIDC Auth  │   │ Enrich │
   │ + pgvector │  │ (Keycloak)  │   │ Pipeline│
   └───────────┘  └─────────────┘   └────────┘
```

**Core design decisions:**
- **Tenant-qualified routing** — every request is scoped to a tenant via URL path
- **Schema isolation** — per-tenant PostgreSQL schemas (`tenant_<id>`) with `SET LOCAL search_path`
- **MCP as a first-class citizen** — dedicated endpoint, session lifecycle management, tool schema registry
- **Enrichment pipeline** — automatic summary, tag extraction, and vector embedding on every memory write

Read the full architecture overview: **[docs/architecture.md →](docs/architecture.md)**

## Production Deployment

Monet is designed for single-host Docker Compose deployment — no Kubernetes required:

```bash
cp .env.runtime.example .env.runtime
docker compose -f docker-compose.runtime.yml up -d
```

- **[Production Deployment Guide →](docs/production-deployment.md)**
- **[Backup and Restore →](docs/backup-restore.md)**
- **[Migration and Upgrade →](docs/migration-upgrade.md)**

## Documentation

| Guide | What You'll Find |
|-------|-----------------|
| [Local Development](docs/local-development.md) | Set up a local dev environment |
| [Production Deployment](docs/production-deployment.md) | Deploy Monet to production |
| [Tenant Management](docs/tenant-creation.md) | Create and manage tenants |
| [Platform Administration](docs/platform-administration.md) | Platform setup and admin workflows |
| [Architecture Overview](docs/architecture.md) | System design, data model, MCP internals |
| [Observability](docs/observability.md) | Monitoring, logging, health checks |
| [Backup & Restore](docs/backup-restore.md) | Data backup and recovery procedures |
| [Migration & Upgrade](docs/migration-upgrade.md) | Version upgrades and schema migrations |

## Contributing

We welcome contributions! Start here:
- **[CONTRIBUTING.md →](CONTRIBUTING.md)**

## Security

Please report vulnerabilities through private GitHub advisories (not public issues/PRs):
- **[SECURITY.md →](SECURITY.md)**

## License

Monet is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE).

---

<div align="center">

**Built with the belief that AI operational intelligence should be a team asset, not an individual advantage.**

[⭐ Star us on GitHub](https://github.com/team-monet/monet) · [🐛 Report a Bug](https://github.com/team-monet/monet/issues) · [💬 Start a Discussion](https://github.com/team-monet/monet/discussions)

</div>

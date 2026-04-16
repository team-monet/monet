# Monet

Monet is a multi-tenant memory platform for AI agents.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## What is Monet?

Monet gives teams a shared memory layer for AI agent systems with:

- **Multi-tenant memory APIs** for agents, groups, memories, rules, and audit data
- **Native MCP support** so agents can read/write memory through MCP tools
- **Dashboard UI** for setup, tenant administration, and memory inspection
- **Local development and self-hosted production paths** with documented quickstarts

If you are evaluating memory infrastructure for agents, Monet is designed to be practical to run, inspect, and extend.

## Quickstart

For the fastest local path:

```bash
git clone https://github.com/team-monet/monet.git
cd monet
pnpm install
cp .env.local-dev.example .env.local-dev
pnpm local:up
```

Then continue with the full local setup guide:
- [docs/local-development.md](docs/local-development.md)

For self-hosted production deployment:
- [docs/production-deployment.md](docs/production-deployment.md)

## Core Architecture (Summary)

- **API service** (`apps/api`) exposes tenant-qualified REST routes: `/api/tenants/:tenantSlug/...`
- **MCP endpoint** is tenant-qualified: `/mcp/:tenantSlug`
- **Dashboard** (`apps/dashboard`) handles platform setup and tenant admin workflows
- **Data model** uses a shared `public` schema + per-tenant schemas in PostgreSQL

Read the full system overview here:
- [docs/architecture.md](docs/architecture.md)

## Documentation

- Local development: [docs/local-development.md](docs/local-development.md)
- Production deployment: [docs/production-deployment.md](docs/production-deployment.md)
- Tenant creation and management: [docs/tenant-creation.md](docs/tenant-creation.md)
- Platform administration: [docs/platform-administration.md](docs/platform-administration.md)
- Architecture overview: [docs/architecture.md](docs/architecture.md)
- Observability: [docs/observability.md](docs/observability.md)
- Backup and restore: [docs/backup-restore.md](docs/backup-restore.md)
- Migration and upgrade: [docs/migration-upgrade.md](docs/migration-upgrade.md)

## Contributing

We welcome contributions from the community.

Start here:
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Security

Please report vulnerabilities through private GitHub advisories (not public issues/PRs):
- [SECURITY.md](SECURITY.md)

## License

Monet is licensed under the **Apache License 2.0**.
See [LICENSE](LICENSE).

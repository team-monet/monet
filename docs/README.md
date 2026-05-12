# Monet Documentation

This directory is the source of truth for Monet documentation. Keeping docs in the
repo means changes can be reviewed with the code they describe, versioned with
releases, and published later through GitHub Pages if needed.

## Getting Started

| Guide | What You'll Find |
|-------|-----------------|
| [Local Development Quickstart](getting-started/local-development.md) | Local setup, quickstart, verification, and common commands |

## Architecture

| Guide | What You'll Find |
|-------|-----------------|
| [Architecture Overview](architecture/overview.md) | System design, data boundaries, MCP internals, and extension points |
| [User And Agent Group Model](architecture/user-and-agent-group-model.md) | Tenant RBAC, user groups, agent groups, and rule scope semantics |
| [Default General Guidance Proposal](architecture/default-agent-group-rules-proposal.md) | Proposed default rules for agent group behavior |

## Administration

| Guide | What You'll Find |
|-------|-----------------|
| [Tenant Creation And Management](admin/tenant-creation.md) | End-to-end tenant creation and lifecycle workflows |
| [Platform Administration](admin/platform-administration.md) | Platform setup, admin operations, delegation, and compliance workflows |

## Operations

| Guide | What You'll Find |
|-------|-----------------|
| [Production Deployment](operations/production-deployment.md) | Runtime topology, environment setup, deployment, and verification |
| [Observability](operations/observability.md) | Logs, health checks, metrics, alerts, and investigation workflows |
| [Backup And Restore](operations/backup-restore.md) | Backup strategy, recovery procedures, and recovery testing |
| [Migration And Upgrade](operations/migration-upgrade.md) | Upgrade model, schema migration flow, rollback, and triage |
| [Main Branch Protection](operations/branch-protection.md) | GitHub branch protection policy and setup |

## Demos

| Guide | What You'll Find |
|-------|-----------------|
| [Support Workflow Demo](demos/demo-support-workflow.md) | Shared-memory demo script, seed data, smoke checks, and reset flow |

## Public Docs And Wiki

For public documentation, prefer publishing these repo docs with GitHub Pages so
the source remains versioned and reviewable. Use the GitHub Wiki for informal
notes, FAQs, or team knowledge that does not need to track a specific release.

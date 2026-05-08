# Monet v0.2.0

Monet v0.2.0 delivers a container-first quickstart experience, hardened MCP session lifecycle management, and significant security and isolation improvements. This release also introduces ONNX embeddings as the default runtime — eliminating the need for an external API key to get started — and includes the first phase of the dashboard UI refactoring.

> **Note:** While Monet is in early development (`0.x.x` series), minor versions may contain breaking changes as the API stabilizes. Please review the breaking changes below carefully before upgrading.

---

## ⚠️ Breaking / Behavioral Changes

### Chat enrichment defaults to `none`

`ENRICHMENT_CHAT_PROVIDER` now defaults to `none`. When chat enrichment is disabled, agents **must** provide a `summary` field in `memory_store` calls. Previously, a missing summary would be auto-generated via the chat provider. If you relied on automatic summary generation, either configure a chat enrichment provider (`ollama` or `openai`) or ensure your agents supply summaries explicitly.

### Group-scoped memory access restricted by agent group membership

Group-scoped memory access is now enforced by the agent's actual group membership rather than granting broad tenant-wide visibility. Agents will only see memories scoped to groups they belong to. If you relied on any agent seeing all group-scoped memories across a tenant, you will need to adjust group memberships accordingly (#169).

### MCP session auth/tenant mismatch returns `404`

MCP session endpoints now return `404 Not Found` instead of `401 Unauthorized` when the session's authenticated tenant does not match the requested tenant. This prevents information leakage about session existence.

### MCP requests may now return timeout errors

MCP tool invocations can now return `504 Gateway Timeout` errors when processing exceeds the configured timeout (`MCP_REQUEST_TIMEOUT_MS`). Agents should handle timeout responses gracefully.

### Keycloak runtime default changed

The default Keycloak hostname for local/runtime containers has changed to `keycloak.localhost` with `--hostname-strict=true`. Existing local environments may need to update their Keycloak configuration or `.env` files to match.

### MCP schema semantics updated for `memory_search` and `memory_update`

The MCP tool schemas for `memory_search` and `memory_update` have been updated to clarify semantics for agents (e.g., scope and type handling). Agents using these tools should be reviewed to ensure compatibility with the updated schemas.

---

## ✨ New Features

### Container-first quickstart bootstrap flow

A new `pnpm quickstart` bootstrap flow provides a streamlined, container-first setup experience. This single command ensures runtime environment configuration, starts all containers (Postgres, Keycloak, migrate, API, dashboard), bootstraps Keycloak and a demo tenant, and prints ready-to-copy MCP configuration and local login details (#177).

### ONNX embeddings as default runtime

ONNX embeddings are now the default, meaning no external API key is required for embedding generation out of the box. Ollama embeddings remain available as an opt-in alternative via environment scripts.

### MCP session lifecycle hardening with tunable limits

MCP session management has been significantly hardened with:

- **Configurable session idle TTL** — `MCP_SESSION_IDLE_TTL_MS` controls how long idle sessions remain active before being swept.
- **Configurable max sessions per agent** — `MCP_MAX_SESSIONS_PER_AGENT` caps the number of concurrent sessions a single agent can hold.
- **Stale-session handling** — Improved detection and cleanup of stale sessions with proper diagnostics logging (#201, #162).

### MCP tool timeout support

A new `MCP_REQUEST_TIMEOUT_MS` environment variable sets a per-request timeout for MCP tool invocations. Requests exceeding this limit return a `504` timeout error to the caller.

### Dashboard UI refactoring — Phase 1

The first phase of the dashboard UI refactoring improves the component architecture and lays groundwork for future enhancements (#173, #165).

### MCP schema documentation for agents

MCP tool descriptions for `memory_search`, `memory_update`, and memory scope/type semantics have been clarified and documented to improve agent compatibility and correctness.

---

## 🐛 Bug Fixes

### Auth & OIDC

- **OIDC issuer discovery fix** — The OIDC well-known discovery endpoint now correctly uses the server-side issuer URL instead of the public-facing URL, preventing issuer mismatch errors.
- **Dashboard auth recovery** — Sessions now recover gracefully after OIDC refresh errors, with proper fallback handling that clears invalid session state instead of leaving the user in a broken state (#164, #195).

### Memory & Data

- **Group-scoped memory isolation** — Fixed enforcement of group-scoped memory access so agents only see memories for groups they are members of (#169).
- **`memory_update` summary persistence** — Caller-supplied summaries are now persisted correctly even when no content changes are detected in the update.
- **pgvector extension creation** — Extension creation now occurs outside transaction boundaries, preventing failures during initial database setup.

### Dashboard

- **Submit flow suspense safety** — The dashboard submit flow now properly handles React suspense boundaries, preventing filter-related UI hangs (#173).
- **Submit button recovery** — Re-enabled the submit button after route-change pending recovery, preventing the UI from getting stuck in a disabled state.

---

## 🔒 Security Fixes

- **Hono upgraded to 4.12.18** — Fixes body limit bypass, cookie validation bypass, and HTML injection CVEs in the Hono web framework.
- **@hono/node-server upgraded to 1.19.14** — Companion security fix for the Node.js server adapter.

---

## 📚 Documentation

- **README rewrite** — Updated with improved positioning, marketing copy, and clearer getting-started instructions (#161).
- **Tenant creation guide** — New guide for creating and managing tenants (`docs/tenant-creation.md`).
- **Platform administration guide** — New guide for platform setup and admin workflows (`docs/platform-administration.md`).

---

## 🐳 Docker Images

| Image | Tag |
|-------|-----|
| `ghcr.io/team-monet/monet-api` | `v0.2.0` |
| `ghcr.io/team-monet/monet-dashboard` | `v0.2.0` |
| `ghcr.io/team-monet/monet-migrate` | `v0.2.0` |

The `latest` tag is also updated to point to this release.

---

## 🔼 Upgrade Guide

For upgrade instructions, including environment variable changes and migration steps, see **[docs/migration-upgrade.md](docs/migration-upgrade.md)**.

Key actions for this upgrade:

1. Review the **breaking changes** above and update your `.env` configuration accordingly.
2. Set `ENRICHMENT_CHAT_PROVIDER` explicitly if you relied on automatic summary generation, or update your agents to provide summaries.
3. Verify that your agents' MCP tool usage is compatible with the updated `memory_search` and `memory_update` schemas.
4. Pull the new Docker images and restart your containers.

---

**Full Changelog**: https://github.com/team-monet/monet/compare/v0.1.0...v0.2.0

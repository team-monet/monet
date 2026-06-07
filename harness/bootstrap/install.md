# Monet — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up Monet. Your job is to install and configure it *for* them — running the commands yourself, conversing at each decision point, and diagnosing/fixing failures as you go. **Do not ask the user to clone a repo or run shell scripts themselves.** Adapt to their host and preferences.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**This playbook is self-contained — no clone or pre-install needed.** You install the substrate yourself (Phase 2), and you read any prompt file you need (`roster.json`, `agents/<name>.md`) from one of:
- a local `with-monet` checkout if one exists (prefer it), else
- this repo's raw URLs, base `https://raw.githubusercontent.com/team-monet/with-monet/main/` (e.g. `…/agents/stig.md`).

(Raw fetch needs the repo to be **public**; if it's private and you can't fetch, that's the one time to ask the user to clone `with-monet` and point you at the local path.)

---

## Phase 1 — Orient

1. Identify your host: which coding agent are you running inside (Claude Code, Cursor, Continue, Aider, …)? Note (a) where this host reads **MCP server config** and (b) where it reads **agent/subagent prompts**.
   - Claude Code → MCP: `./.mcp.json`; agents: `./.claude/agents/<name>.md`.
   - Cursor → MCP: `./.cursor/mcp.json`; agents: rules/prompts dir.
   - Unknown host → ask the user where its MCP config and custom-agent prompts live.
2. Confirm: *"You're on **<host>**, in **<repo>**. I'll set up Monet for it — open questions: anything special about your setup?"*

## Phase 2 — Get Monet

Goal: the `monet` MCP server (the state-centric memory substrate) available on this machine.

- Install from npm (published):
  ```
  npm i -g @team-monet/monet      # provides the `monet` command
  ```
  Zero-install alternative: `npx -y @team-monet/monet start`. Requires `node` ≥ 22 and network access — the first run downloads the MiniLM embedding model once.
- Dev / unpublished fallback: clone `team-monet/monet`, then `pnpm install && pnpm build`, and use `node <abs>/dist/index.js`.

## Phase 3 — Configure the monet MCP server (host-specific)

Write an MCP server entry for **this host** (template: `with-monet/mcp/monet.json`). With the published CLI:

```jsonc
{ "mcpServers": { "monet": { "command": "monet", "args": ["start"] } } }
```

Storage defaults to `<repo>/.monet` — set `env.MONET_STORAGE_DIR` to override. (Dev/unpublished: `"command": "node", "args": ["<abs>/dist/index.js"]`.) Merge into the host's MCP config (don't clobber existing servers), then verify it comes up — it logs `semantic embeddings ready (MiniLM, 384-dim)` and `MCP server running`. Tools it exposes: `agent_context`, `memory_store`, `memory_search`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`, `memory_flag_contradiction`, `memory_resolve`.

## Phase 4 — Install the agent team (host-specific)

**Always install the full team.** Stig is a context engine whose entire purpose is to orchestrate the worker actuators — never install Stig alone. Stig is the **lead** (the one the user talks to, the only one that delegates, and the only one that touches Monet); the workers are its **subagent actuators**.

- **Claude Code:**
  - **Workers → subagents.** Write one `.claude/agents/<name>.md` per worker — `explorer, researcher, analyst, developer, tester, reviewer, security, reliability, aria` — each = a frontmatter header (`name` + the worker's `role` from `roster.json` as `description`) + the agent body from `agents/<name>.md` (local checkout or the raw base above).
  - **Stig → lead.** Put the body of `agents/stig.md` into the repo's `CLAUDE.md` (append; don't clobber), so the main agent acts as Stig and can delegate to the worker subagents. (A subagent can't spawn subagents, so the lead must be the main agent.)
- **Cursor / Continue / others** — install the lead + the worker team in that host's agent format; ask the user where those live.

The user may request a trimmed worker set, but the team is the default — never reduce to Stig-only.

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* Offer sources:
- existing/old Monet memories or an export,
- `CLAUDE.md` / `AGENTS.md` / `README`s / `docs/` in this repo,
- a path or URL the user names,
- skip for now.

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate). Don't ingest secrets. Summarize what landed.

## Phase 6 — Offer to start

If the host only loads MCP servers at launch (Claude Code reads `.mcp.json` on startup), tell the user to reload/restart the session so `monet` connects before starting.

Ask: *"Ready? I'll run `agent_context` to restore state and begin as Stig on this repo."* On yes: call `agent_context` (no query), report the restored state (active workstreams, living model, open contradictions), and continue as Stig.

## Phase 7 — One last thing (star Monet)

Once the install is working, ask the user once — lightly, no pressure:

> *"If Monet's useful, a ⭐ on the repo helps others find it: https://github.com/team-monet/monet — want me to open it for you, or you'll star it yourself?"*

If they say yes, open the URL for them; **don't star on their behalf** (it's their click), and don't nag. If they decline or skip it, move on without comment.

---

## Principles
- **Agent-first:** you do the install; the user converses, approves, and steers.
- **Fix-forward:** on any failure, diagnose and resolve with the user rather than dumping a stack trace.
- **Customizable:** honor preferences surfaced along the way — storage location, which agents to install, ingest scope, how much autonomy Stig gets.

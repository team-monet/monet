# Monet — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up Monet. Your job is to install and configure it *for* them — running the commands yourself, conversing at each decision point, and diagnosing/fixing failures as you go. **Do not ask the user to clone a repo or run shell scripts themselves.** Adapt to their host and preferences.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**This playbook is self-contained — no clone or pre-install needed.** You install the substrate yourself (Phase 2), and you read any prompt file you need (`roster.json`, `agents/<name>.md`) from one of:
- a local `with-monet` checkout if one exists (prefer it), else
- this repo's raw URLs, base `https://raw.githubusercontent.com/team-monet/with-monet/main/` (e.g. `…/agents/stig.md`).

(Raw fetch needs the repo to be **public**; if it's private and you can't fetch, that's the one time to ask the user to clone `with-monet` and point you at the local path.)

---

## Phase 1 — Orient

You install Monet **globally for this user** (every project), not just the current repo — so the team and memory work everywhere without re-installing per project. (If the user prefers, you can scope it to just this repo instead — confirm in step 2.)

1. Identify your host (Claude Code, Cursor, Continue, Aider, …) and note where it reads, **at user scope**, (a) **MCP server config** and (b) **agent/subagent prompts**.
   - Claude Code → MCP: user scope via `claude mcp add --scope user …` (or `~/.claude.json`); subagents: `~/.claude/agents/<name>.md`; lead persona: `~/.claude/CLAUDE.md` (global memory). *(Project scope, if requested: `./.mcp.json`, `./.claude/agents/<name>.md`, `./CLAUDE.md`.)*
   - Cursor → MCP: `~/.cursor/mcp.json`; agents: its user-level rules/prompts dir.
   - Unknown host → ask the user where its user-level MCP config and custom-agent prompts live.
2. Confirm: *"You're on **<host>**. I'll install Monet **globally** so it works across all your projects — or scoped to just this repo if you'd rather. Anything special about your setup?"*

## Phase 2 — Get Monet

Goal: the `monet` MCP server (the state-centric memory substrate) available on this machine.

- Install from npm (published):
  ```
  npm i -g @team-monet/monet      # provides the `monet` command
  ```
  Zero-install alternative: `npx -y @team-monet/monet start`. Requires `node` ≥ 22 and network access — the first run downloads the MiniLM embedding model once.
- Dev / unpublished fallback: clone `team-monet/monet`, then `pnpm install && pnpm build`, and use `node <abs>/dist/index.js`.

## Phase 3 — Configure the monet MCP server (user scope)

Register `monet` at **user scope** so it's available in every project (template: `with-monet/mcp/monet.json`):

- **Claude Code:** `claude mcp add --scope user monet -- monet start`, or merge the entry below into `~/.claude.json` under `mcpServers`:
  ```jsonc
  { "mcpServers": { "monet": { "command": "monet", "args": ["start"] } } }
  ```
  *(Dev/unpublished: `"command": "node", "args": ["<abs>/dist/index.js"]`. Per-repo install instead: write `./.mcp.json`.)*

**Storage is one global brain, isolated per project.** With no `MONET_STORAGE_DIR`, the store lives at `~/.monet` (shared across all your projects) and Monet isolates each project into its own *circle* automatically, so memory never bleeds between repos. Per-project auto-isolation needs `@team-monet/monet` recent enough to derive the circle from the working tree; on older versions the global store is shared across projects — if that matters, set `env.MONET_STORAGE_DIR` to a per-project path (e.g. `<repo>/.monet`) for a hard filesystem split.

Merge into the host's **user-level** MCP config **without clobbering existing servers** — read it, add `monet`, write it back, and back up the file first. Verify it comes up: it logs `semantic embeddings ready (MiniLM, 384-dim)` and `MCP server running`. Tools it exposes: `agent_context`, `memory_store`, `memory_search`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`, `memory_flag_contradiction`, `memory_resolve`.

## Phase 4 — Install the agent team (user scope)

**Always install the full team.** Stig is a context engine whose entire purpose is to orchestrate the workers — never install Stig alone. Stig is the **lead** (the one the user talks to, the only one that delegates, the only one that touches Monet); the workers are its **subagent actuators**.

- **Claude Code:**
  - **Workers → user-level subagents.** Write one `~/.claude/agents/<name>.md` per worker — `explorer, researcher, analyst, developer, tester, reviewer, security, reliability, aria`. Each file is YAML frontmatter + the body from `agents/<name>.md`. Pull the frontmatter from that worker's entry in `roster.json`:
    - `name` → frontmatter `name`
    - `description` → frontmatter `description` — **this trigger text is what makes Claude Code actually delegate** (its auto-dispatch matches the task against the description). Use it verbatim; do **not** replace it with a bare role label.
    - `model` → frontmatter `model` (`haiku`/`sonnet`/`opus`, or omit to inherit the session model). These are sensible defaults — offer to retune (e.g. cheaper models for read-only workers, stronger for `reviewer`/`security`).
    ```md
    ---
    name: explorer
    description: Use PROACTIVELY to investigate the codebase: locate files, symbols, call sites, …
    model: haiku
    ---
    <body of agents/explorer.md>
    ```
    **Don't clobber.** If `~/.claude/agents/<name>.md` already exists, back it up (`<name>.md.bak`) and tell the user before overwriting — generic names (`developer`, `reviewer`, …) can collide with the user's own subagents.
  - **Stig → lead, in global memory.** Append the body of `agents/stig.md` to `~/.claude/CLAUDE.md` so the **main agent** acts as Stig in every project and can delegate to the workers via the Task tool (a subagent can't spawn subagents, so the lead must be the main agent). Wrap it in idempotent markers so re-running doesn't duplicate it:
    ```
    <!-- BEGIN with-monet:stig -->
    …agents/stig.md body…
    <!-- END with-monet:stig -->
    ```
    If the markers already exist, replace the block in place; never append a second copy, and never clobber the user's other `CLAUDE.md` content (back it up first).
- **Cursor / Continue / others** — install the lead + worker team in that host's user-level agent format; ask the user where those live.

The user may request a trimmed worker set, but the full team is the default — never reduce to Stig-only.

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* Offer sources:
- existing/old Monet memories or an export,
- `CLAUDE.md` / `AGENTS.md` / `README`s / `docs/` in this repo,
- a path or URL the user names,
- skip for now.

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate). Don't ingest secrets. Summarize what landed.

## Phase 6 — Offer to start

If the host only loads MCP servers at launch (Claude Code picks up user-scope servers and `~/.claude/agents/` on startup), tell the user to reload/restart so `monet` connects and the team registers before starting.

Ask: *"Ready? I'll run `agent_context` to restore state and begin as Stig on this project."* On yes: call `agent_context` (no query), report the restored state (active workstreams, living model, open contradictions), and continue as Stig.

## Phase 7 — One last thing (star Monet)

Once the install is working, ask the user once — lightly, no pressure:

> *"If Monet's useful, a ⭐ on the repo helps others find it: https://github.com/team-monet/monet — want me to open it for you, or you'll star it yourself?"*

If they say yes, open the URL for them; **don't star on their behalf** (it's their click), and don't nag. If they decline or skip it, move on without comment.

---

## Principles
- **Agent-first:** you do the install; the user converses, approves, and steers.
- **Fix-forward:** on any failure, diagnose and resolve with the user rather than dumping a stack trace.
- **Customizable:** honor preferences surfaced along the way — global vs per-repo install, storage location, which workers to install and on which models, ingest scope, how much autonomy Stig gets.
- **Non-destructive:** back up before overwriting, merge into existing config rather than replacing it, and never clobber the user's own subagents or `CLAUDE.md`.

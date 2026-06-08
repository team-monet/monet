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

Storage defaults to `<repo>/.monet` — set `env.MONET_STORAGE_DIR` to override. (Dev/unpublished: `"command": "node", "args": ["<abs>/dist/index.js"]`.) Merge into the host's MCP config (don't clobber existing servers), then verify it comes up — it logs `semantic embeddings ready (MiniLM, 384-dim)` and `MCP server running`. Tools the published server exposes: `agent_context`, `memory_store`, `memory_search`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`. (Newer runtimes additionally expose `memory_gather`, `memory_overview`, `memory_list`, `memory_reassign_circle`, `memory_flag_contradiction`, `memory_resolve` — the consolidation playbook uses these **when present**; check your actual tool list rather than assuming.)

## Phase 4 — Install the agent team (host-specific)

**Always install the full team.** Stig is a context engine whose entire purpose is to orchestrate the worker actuators — never install Stig alone. Stig is the **lead** (the one the user talks to, the only one that delegates, and the only one that touches Monet); the workers are its **subagent actuators**.

- **Claude Code:**
  - **Workers → subagents.** Write one `.claude/agents/<name>.md` per worker — `explorer, researcher, analyst, developer, tester, reviewer, security, reliability, aria` — each = a frontmatter header (`name` + the worker's `role` from `roster.json` as `description`), then a `<!-- MONET:AGENT -->` sentinel line (right after the frontmatter), then the agent body from `agents/<name>.md` (local checkout or the raw base above). The sentinel lets a later consolidation pass tell Monet's installed workers apart from the user's *own* custom `.claude/agents/*.md`.
  - **Stig → lead.** Append the body of `agents/stig.md` into the repo's `CLAUDE.md` so the main agent acts as Stig and can delegate to the worker subagents (a subagent can't spawn subagents, so the lead must be the main agent). **Wrap the appended prompt in the exact sentinels below** (bare markers — a later memory-consolidation pass keys on them to retire the *user's* knowledge from `CLAUDE.md` without ever touching Stig's prompt; keep the `BEGIN MONET:STIG` / `END MONET:STIG` tokens verbatim):
    ```
    <!-- BEGIN MONET:STIG -->
    <!-- Monet-managed; do not capture, retire, or edit. -->
    …agents/stig.md body…
    <!-- END MONET:STIG -->
    ```
    Append; don't clobber anything already in `CLAUDE.md`.
- **Cursor / Continue / others** — install the lead + the worker team in that host's agent format; ask the user where those live. **Mark every installed prompt file** (lead and workers) with a `<!-- MONET:AGENT -->` sentinel as the file's first line — **but for formats with leading frontmatter (e.g. Cursor `.mdc` rules, whose `---` block sets `description`/`globs`/`alwaysApply`), put the sentinel immediately *after* the closing `---`** so you don't shove a comment ahead of the frontmatter and break activation. On hosts where the team lives in a rules/prompts dir the consolidation pass would otherwise scan (`.cursor/rules`, `.continue/rules`, …), this marker is what stops it from capturing/retiring Monet's own wiring. (Claude Code's workers in `.claude/agents/` carry the same `MONET:AGENT` marker — consolidation recognizes Monet's workers by that marker or their installed names, **not** a blanket `.claude/agents/` path skip, so your own custom subagents there are still treated as user knowledge.)

The user may request a trimmed worker set, but the team is the default — never reduce to Stig-only.

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* Offer sources:
- existing/old Monet memories or an export,
- `CLAUDE.md` / `AGENTS.md` / `README`s / `docs/` in this repo,
- a path or URL the user names,
- skip for now.

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate). Don't ingest secrets. **Skip Monet's own wiring:** when the source is `CLAUDE.md` (which you just appended Stig's prompt to) or any installed agent prompt, do **not** store anything inside the `<!-- BEGIN MONET:STIG -->…<!-- END MONET:STIG -->` block or any `<!-- MONET:AGENT -->`-marked file — that's the lead/worker prompt, not the user's knowledge. Summarize what landed.

If you find a real pile of existing memory — a non-empty legacy `"default"` circle, other agents' rule files (`CLAUDE.md`/`AGENTS.md`/Cursor/Cline/Copilot/Windsurf rules), a tool-managed memory store, or scattered notes/ADRs — offer the fuller **consolidation** flow ([`bootstrap/consolidate-memory.md`](consolidate-memory.md)): capture each source into Monet *and then retire it* (a pointer or archive), so Monet becomes the single place to read from. This Phase-5 pass ingests but never retires; the consolidation playbook does the organize-and-retire, interactively and reversibly.

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

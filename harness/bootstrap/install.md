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

**Storage — one global brain, organized per project.** By default the store lives at `~/.monet` (shared across all the user's projects) and Monet organizes each project into its own *circle* automatically — no config required. If the user prefers a hard filesystem split per repo, offer it: set `env.MONET_STORAGE_DIR` to a per-project path (e.g. `<repo>/.monet`) in the MCP config block you write for them. Default to the shared global store unless they ask.

Merge into the host's **user-level** MCP config **without clobbering existing servers** — read it, add `monet`, write it back, and back up the file first. Verify it comes up: `monet start` logs `semantic embeddings ready (MiniLM, 384-dim)` then `Monet started`, and also prints the active project circle (`Circle: <name>`), confirming per-project organization. The server exposes 14 tools: `agent_context`, `memory_store`, `memory_search`, `memory_overview`, `memory_gather`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`, `memory_flag_contradiction`, `memory_resolve`, `memory_list`, `memory_reassign_circle`, `memory_detach`, `memory_circle_manage`. Recall is store-wide, with each result card carrying its home circle, so reorganizing circles never breaks findability. `memory_detach` splits observations out of a concept for wrong-merge repair — or, given `destConceptId`, folds them into another concept; detaching all observations with `destConceptId` consolidates the source away, carrying its identity as an alias on the keeper so references keep resolving. `memory_fetch` returns observation entries as `{id, content}`, pages with `observationsOffset`, and includes `lastConfirmedAt` (Unix ms of last evidence-based confirmation) as the staleness signal. `memory_store` accepts `resolution: "forceNew"`/`attachTo` for bulk import and directed attach. `memory_overview` surfaces `possibleDuplicates`. `memory_resolve` handles two verdict families: contradiction resolution (retrying an already-closed contradiction returns `alreadyClosed: true` with zero mutations) and duplicate-pair dismissal (pass `conceptAId` + `conceptBId` to assert two concepts are not duplicates, clearing the pair from `possibleDuplicates`; idempotent when no live edge exists). `memory_circle_manage` handles circle lifecycle — rename/merge/archive with stable aliases (the interactive curation ritual lives in [`curate-memory.md`](curate-memory.md)); `memory_reassign_circle` accepts `ids` batching and `resolution: "auto"|"forceNew"`. The consolidation flow uses `memory_list` and `memory_reassign_circle` (see [`consolidate-memory.md`](consolidate-memory.md)). The server also provides an in-band session lifecycle with zero host configuration: on the first successful tool response, it appends a delimited block (`=== MONET SESSION CONTEXT (auto-prewarm) ===`) as an additional content item carrying active workstreams, top concepts, and a curation advisory — suppressed when the first call is `agent_context` (no double-inject), and opt-out server-side via `MONET_NO_AUTOPREWARM`; after 10 mutating calls (then every 20) it appends a checkpoint nudge, silenced by a checkpoint that saves a workstream; and the server's `instructions` field describes the memory loop so an agent without the Stig persona gets the loop on first use.

## Phase 4 — Install the agent team (user scope)

**Always install the full team.** Stig is a context engine whose entire purpose is to orchestrate the workers — never install Stig alone. Stig is the **lead** (the one the user talks to, the only one that delegates, the only one that touches Monet); the workers are its **subagent actuators**.

- **Claude Code:**
  - **Workers → user-level subagents.** Write one `~/.claude/agents/<name>.md` per worker — `explorer, researcher, analyst, developer, tester, reviewer, auditor, security, reliability, aria`. Each file is YAML frontmatter + the body from `agents/<name>.md`. Pull the frontmatter from that worker's entry in `roster.json`:
    - `name` → frontmatter `name`
    - `description` → frontmatter `description` — **this trigger text is what makes Claude Code actually delegate** (its auto-dispatch matches the task against the description). Use it verbatim; do **not** replace it with a bare role label. The descriptions contain colons, so **quote them** in YAML (`description: "…"`) or the frontmatter won't parse.
    - `model` → frontmatter `model` (`haiku`/`sonnet`/`opus`, or omit to inherit the session model). These are sensible defaults — offer to retune (e.g. cheaper models for read-only workers, stronger for `reviewer`/`security`).
    ```md
    ---
    name: explorer
    description: "Use PROACTIVELY to investigate the codebase: locate files, symbols, call sites, …"
    model: haiku
    ---
    <!-- with-monet:agent -->
    <body of agents/explorer.md>
    ```
    Add the `<!-- with-monet:agent -->` marker right after the frontmatter — it lets a later memory-consolidation pass tell Monet's installed workers apart from your *own* custom subagents, so it never captures or retires the team.
    **Write each file transparently, one at a time.** Use your host's file-write tool so the user sees every file's content as it's written; never generate a script that batch-writes the agents directory. Host permission systems treat opaque scripted writes to agent config as suspect and will (rightly) block them — per-file writes the user can read are both the polite and the working path.
    **Don't clobber.** If `~/.claude/agents/<name>.md` already exists, back it up (`<name>.md.bak`) and tell the user before overwriting — generic names (`developer`, `reviewer`, …) can collide with the user's own subagents.
  - **Stig → lead, in global memory — ask first.** This is the install's highest-impact write, so it gets its own decision point. Ask: *"Install Stig as the lead persona in your global `~/.claude/CLAUDE.md`? This changes how every session on this machine starts."* A general "go ahead with the install" doesn't cover this — wait for an explicit yes (your host's permission system will likely insist on the same); on a no, offer to scope Stig to the current repo's `./CLAUDE.md` instead (the per-repo option from Phase 1). On yes, append the body of `agents/stig.md` to `~/.claude/CLAUDE.md` so the **main agent** acts as Stig in every project and can delegate to the workers via the Task tool (a subagent can't spawn subagents, so the lead must be the main agent). Wrap it in idempotent markers so re-running doesn't duplicate it:
    ```
    <!-- BEGIN with-monet:stig -->
    …agents/stig.md body…
    <!-- END with-monet:stig -->
    ```
    If the markers already exist, replace the block in place; never append a second copy, and never clobber the user's other `CLAUDE.md` content (back it up first).
- **Cursor / Continue / others** — install the lead + worker team in that host's user-level agent format; ask the user where those live. **Mark each installed prompt** with a `<!-- with-monet:agent -->` sentinel (after any leading frontmatter — e.g. Cursor `.mdc` rules — so you don't break activation metadata), so a consolidation pass never captures or retires Monet's own wiring.

The user may request a trimmed worker set, but the full team is the default — never reduce to Stig-only.

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* The richest sources are the ones that already capture how you and your team work:

- **Agent reference files** — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Cursor/Cline/Copilot/Windsurf/Continue rules, and any other agent instructions you've written. These often hold the most distilled project knowledge.
- **`README`s and `docs/`** in this repo — architectural decisions, conventions, ADRs.
- **Notes and decision docs** — `NOTES.md`, `TODO`, scratch docs, anything that records *why* decisions were made.
- A path or URL the user names.
- Skip for now.
- (If you're coming from a prior Monet store, say so and I can pull that in too — if it's a *separate* old install with its own MCP server, see the cross-server note in `consolidate-memory.md`.)

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate). Don't ingest secrets. **Skip Monet's own wiring:** when the source is `CLAUDE.md` (which holds Stig's prompt) or an installed agent prompt, don't store the `<!-- BEGIN with-monet:stig -->…<!-- END with-monet:stig -->` block or any `<!-- with-monet:agent -->`-marked file. Summarize what landed.

**Existing knowledge to consolidate?** If you find a meaningful pile — agent reference files (`CLAUDE.md`/`AGENTS.md`/Cursor/Cline/Copilot/Windsurf rules), a tool-managed memory store, scattered notes/ADRs, or an existing Monet store — don't leave it scattered. Offer the interactive consolidation playbook [`bootstrap/consolidate-memory.md`](consolidate-memory.md) (same raw-URL base as above): capture each source into Monet, organize into per-project circles *with* the user, then retire the source (a pointer or archive) so Monet becomes the single place to read from. This Phase-5 pass ingests but never retires; consolidation does the organize-and-retire, interactively and reversibly. Skip if there's nothing meaningful to consolidate.

## Phase 6 — Offer to start

If the host only loads MCP servers at launch (Claude Code picks up user-scope servers and `~/.claude/agents/` on startup), tell the user to reload/restart so `monet` connects and the team registers before starting.

Ask: *"Ready? I'll run `agent_context` to restore state and begin as Stig on this project."* On yes: call `agent_context` (no query), report the restored state (active workstreams, living model, open contradictions), and continue as Stig.

## Phase 7 — One last thing (star with-monet)

Once the install is working, ask the user once — lightly, no pressure:

> *"If Monet's earning its keep: I can ⭐ star **team-monet/with-monet** for you (a quick `gh` command you approve), and point you to the one-time setting for new-release notifications. Want either?"*

If they want to **star**, check `gh` is usable (`gh auth status`); if so, run it with their explicit approval:
- **Star (support / bookmark):** `gh api --method PUT /user/starred/team-monet/with-monet`

For **release notifications**, send them to the UI — GitHub's API can't set a release-only watch, so don't automate it: tell them to open the repo and choose **Watch → Custom → Releases**. (Only if they explicitly want notifications for *everything* — issues, PRs, the lot — is the all-activity `gh api --method PUT /repos/team-monet/with-monet/subscription -F subscribed=true` appropriate; never run it under the banner of "release notifications.")

If `gh` is missing or unauthenticated, fall back to the link: open https://github.com/team-monet/with-monet and let them star/watch manually. Ask once; don't nag; never act without a yes.

Key distinction: starring does **not** create notifications — that's what watching is for. Star = support/bookmark; watch = updates (and release-only is a UI choice, not an API one). Keep these separate in how you describe them.

---

## Principles
- **Agent-first:** you do the install; the user converses, approves, and steers.
- **Fix-forward:** on any failure, diagnose and resolve with the user rather than dumping a stack trace.
- **Permission prompts are checkpoints, not failures:** hosts may challenge writes to agent-config locations (the agents dir, global `CLAUDE.md`) because they change how the agent itself behaves. That's expected — pause, show the user what you're about to write and why, and proceed on their explicit OK. Never work around a denial with a script or an indirect write.
- **Customizable:** honor preferences surfaced along the way — global vs per-repo install, storage location, which workers to install and on which models, ingest scope, how much autonomy Stig gets.
- **Non-destructive:** back up before overwriting, merge into existing config rather than replacing it, and never clobber the user's own subagents or `CLAUDE.md`.

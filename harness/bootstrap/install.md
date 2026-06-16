# Monet — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up Monet. Your job is to install and configure it *for* them — running the commands yourself, conversing at each decision point, and diagnosing/fixing failures as you go. **Do not ask the user to clone a repo or run shell scripts themselves.** Adapt to their host and preferences.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**This playbook is self-contained — no clone or pre-install needed.** You install the substrate yourself (Phase 2), and you read any prompt file you need (`roster.json`, `agents/<name>.md`) from one of:
- a local `with-monet` checkout if one exists (prefer it), else
- this repo's raw URLs, base `https://raw.githubusercontent.com/team-monet/with-monet/main/` (e.g. `…/agents/stig.md`).

(Raw fetch needs the repo to be **public**; if it's private and you can't fetch, that's the one time to ask the user to clone `with-monet` and point you at the local path.)

---

## Updating an existing install (team files only)

Already set up and just want the latest team (Stig + workers)? You don't need to re-run onboarding — re-run **Phase 4 only** against the latest sources:
1. Re-read `roster.json`, `agents/*.md`, and `agents/stig.md` from the raw-URL base (or your local `with-monet` checkout).
2. Re-apply Phase 4's write step **to the same scope the team was installed in** — detect that from where the existing `<!-- BEGIN with-monet:stig -->` / `<!-- with-monet:agent -->` markers already live — in your host's lead-persona file and its worker/subagent locations (the surfaces you found in Phase 1), at whichever scope (user or repo) they were installed. Rewrite the Stig block (between the `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers) and each agent file **in that location** — never silently switch a per-repo install to global. **Reconcile, don't clobber:** preserve your local edits, apply the new changes, guard the invariants, and keep `.bak` (see Phase 4).

Skip Phases 1–3 (substrate + MCP already configured) and 5–7 — except: if your host loads agents/MCP only at startup (most do — you noted this in Phase 1), **reload or restart it afterward** so the updated Stig + workers take effect; a running session keeps the old prompts until you do. Phase 4 is idempotent, so this is safe to repeat.

---

## Phase 1 — Orient

You install Monet **globally for this user** (every project), not just the current repo — so the team and memory work everywhere without re-installing per project. (If the user prefers, you can scope it to just this repo instead — confirm in step 2.)

1. **Identify your host and its install surfaces.** You're the agent running inside it, so you know — or its docs do — where it keeps, at user scope, (a) its **MCP server config**, (b) its **always-on lead-persona / system prompt**, and (c) its **named-subagent definitions** (if it has them). Note two capabilities that gate the rest of the install:
   - **MCP support — required.** Monet is an MCP server and Stig's whole loop is MCP tools (`agent_context`, `memory_store`, `memory_checkpoint`). If the host can't run MCP servers, **stop** and tell the user Monet needs an MCP-capable host.
   - **Real isolated subagents — needed for the worker team.** Each worker must run in its *own fresh context* the lead can delegate into — not an always-on "rule" that bleeds into the main context. If the host has this, you'll install the full team (Phase 4 Tier B); if it doesn't, the harness can't run here and you'll **stop** — Stig is an orchestrator, so with no workers there's nothing to orchestrate. **Feature-detect it from the host's docs — don't infer it from the host's name** (host capabilities change fast).

   Also note whether the host loads MCP/agents only at startup (you'll tell the user to reload afterward). Anything unclear — check the host's docs or ask the user; don't guess.
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

Register `monet` in your host's MCP config at **user scope** so it's available in every project (template: `with-monet/mcp/monet.json`). The entry to merge is:
```jsonc
{ "mcpServers": { "monet": { "command": "monet", "args": ["start"] } } }
```
*(Dev/unpublished fallback: use `"command": "node", "args": ["<abs>/dist/index.js"]` in place of `"command": "monet"`.)*

Merge that entry into your host's user-level MCP config in whatever form the host expects — a CLI command, a JSON config file, or a settings UI — **without clobbering** existing servers. You know your host's MCP setup, or its docs do; if you're unsure, ask the user. (A host with no MCP support → you already stopped at Phase 1.)

**Storage — one global brain, organized per project.** By default the store lives at `~/.monet` (shared across all the user's projects) and Monet organizes each project into its own *circle* automatically — no config required. If the user prefers a hard filesystem split per repo, offer it: set `env.MONET_STORAGE_DIR` to a per-project path (e.g. `<repo>/.monet`) in the MCP config block you write for them. Default to the shared global store unless they ask.

Merge into the host's **user-level** MCP config **without clobbering existing servers** — read it, add `monet`, write it back, and back up the file first. Verify it comes up: `monet start` logs `semantic embeddings ready (MiniLM, 384-dim)` then `Monet started`, and also prints the active project circle (`Circle: <name>`), confirming per-project organization. The server exposes 14 tools: `agent_context`, `memory_store`, `memory_search`, `memory_overview`, `memory_gather`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`, `memory_flag_contradiction`, `memory_resolve`, `memory_list`, `memory_reassign_circle`, `memory_detach`, `memory_circle_manage`. Recall is store-wide, with each result card carrying its home circle, so reorganizing circles never breaks findability. `memory_detach` splits observations out of a concept for wrong-merge repair — or, given `destConceptId`, folds them into another concept; detaching all observations with `destConceptId` consolidates the source away, carrying its identity as an alias on the keeper so references keep resolving. `memory_fetch` returns observation entries as `{id, content}`, pages with `observationsOffset`, and includes `lastConfirmedAt` (Unix ms of last evidence-based confirmation) as the staleness signal. `memory_store` accepts `resolution: "forceNew"`/`attachTo` for bulk import and directed attach. `memory_overview` surfaces `possibleDuplicates`. `memory_resolve` handles two verdict families: contradiction resolution (retrying an already-closed contradiction returns `alreadyClosed: true` with zero mutations) and duplicate-pair dismissal (pass `conceptAId` + `conceptBId` to assert two concepts are not duplicates, clearing the pair from `possibleDuplicates`; idempotent when no live edge exists). `memory_circle_manage` handles circle lifecycle — rename/merge/archive with stable aliases (the interactive curation ritual lives in [`curate-memory.md`](curate-memory.md)); `memory_reassign_circle` accepts `ids` batching and `resolution: "auto"|"forceNew"`. The consolidation flow uses `memory_list` and `memory_reassign_circle` (see [`consolidate-memory.md`](consolidate-memory.md)). The server also provides an in-band session lifecycle with zero host configuration: on the first successful tool response, it appends a delimited block (`=== MONET SESSION CONTEXT (auto-prewarm) ===`) as an additional content item carrying active workstreams, top concepts, and a curation advisory — suppressed when the first call is `agent_context` (no double-inject), and opt-out server-side via `MONET_NO_AUTOPREWARM`; after 10 mutating calls (then every 20) it appends a checkpoint nudge, silenced by a checkpoint that saves a workstream; and the server's `instructions` field describes the memory loop so an agent without the Stig persona gets the loop on first use.

## Phase 4 — Install the agent team (user scope)

**Install the full team wherever the host supports it.** Stig is a context engine whose purpose is to orchestrate the workers, so don't drop the workers by *choice* on a host that can run them. Stig is the **lead** (the one the user talks to, the only one that delegates, the only one that touches Monet); the workers are its **subagent actuators**. (A host that *can't* provide isolated subagents can't run the orchestration team at all — see Tier B.)

**Tier A — Lead persona (ask first, highest-impact write).** This is the install's highest-impact write, so it gets its own decision point. Ask: *"Install Stig as the lead persona in your [host's lead-persona location]? This changes how every session on this machine starts."* A general "go ahead with the install" doesn't cover this — wait for an explicit yes (your host's permission system will likely insist on the same). On a no, offer to scope Stig to the current repo's equivalent per-repo location instead (the per-repo option from Phase 1).

Write the body of `agents/stig.md` (wrapped in the `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers) into your host's lead-persona target so the **main agent** acts as Stig and can delegate to workers. A key constraint that must survive regardless of host: the lead is the only agent that delegates and the only one that touches Monet — sub-contexts cannot spawn further sub-contexts, so the lead must be the main agent.

Write it into your host's **always-on lead-persona location** — the file or setting whose content is injected into every session (you know your host's; its docs or the user can confirm). Honor the global-vs-repo scope choice from Phase 1: if the host exposes both a user-scope and a repo-scope location, use the one chosen — never silently switch one for the other.

Wrap the body in idempotent markers so re-running doesn't duplicate it. If the host's lead-persona file requires frontmatter (some hosts' rule files do), put the markers and body **below** that frontmatter — a leading HTML comment can break the file's activation metadata:
```
<!-- BEGIN with-monet:stig -->
…agents/stig.md body…
<!-- END with-monet:stig -->
```
If the markers already exist, replace the block in place; never append a second copy, and never clobber the user's other content in that file (back it up first).

**Tier B — Workers (only where the host has real isolated subagents).** Install the worker team only if your host has a **true named-subagent primitive** — one that gives each worker its *own fresh, isolated context* the lead delegates into, separate from the lead's context and with its own tool access. An always-on "rules"/"instructions" mechanism is **not** this: it bleeds every persona into the main context, breaking the "workers run separately, never touch Monet" invariant. **Feature-detect** this from the host's docs — don't infer it from the host's name. Confirm too that the host's subagents have the tool access each worker needs (file-edit for `developer`/`tester`, web for `researcher`); if they're read-only, tell the user — those workers can't do their job there.

If the host has it: write one worker prompt per worker — `explorer, researcher, analyst, developer, tester, reviewer, auditor, security, reliability, aria` — into the host's subagent location, mapping each worker's `roster.json` fields to the host's format:
- `name` → the host's agent name.
- `description` → the host's dispatch/trigger text — **use it verbatim, not a bare role label**; it's what routes a task to the right worker. (The descriptions contain colons, so quote them if the host's format needs it.)
- `model` → the roster's `haiku`/`sonnet`/`opus` are a **guidance default**; translate them to your host's own model identifiers, or omit to inherit the session model. Offer to retune (cheaper for read-only workers, stronger for `reviewer`/`security`).

Add the `<!-- with-monet:agent -->` marker right after any leading frontmatter — it lets a later memory-consolidation pass tell Monet's installed workers apart from the user's *own* custom sub-contexts, so it never captures or retires the team.

Example worker file (one common format — adapt the frontmatter to your host):
```md
---
name: explorer
description: "Use PROACTIVELY to investigate the codebase: locate files, symbols, call sites, …"
model: haiku
---
<!-- with-monet:agent -->
<body of agents/explorer.md>
```

**If the host has no real isolated subagents: stop — don't install the team here.** Stig is fundamentally an orchestrator: its whole job is to inject context into delegatable workers, so without real isolated subagents there's no coherent install — workers-as-rules or in-conversation role-play breaks the isolation invariant, and the Stig prompt itself would still tell the lead to delegate to workers that don't exist. Tell the user this host can't run the Stig + worker harness (it needs a real subagent primitive alongside MCP); they can still use the **Monet MCP server standalone** for memory. Both requirements — MCP *and* isolated subagents — gate the install; missing either means stop, same as the no-MCP case in Phase 1.

**Write each file transparently, one at a time.** Use your host's file-write tool so the user sees every file's content as it's written; never generate a script that batch-writes the agents directory. Host permission systems treat opaque scripted writes to agent config as suspect and will (rightly) block them — per-file writes the user can read are both the polite and the working path.

**Don't clobber.** If the target file already exists, back it up (`<name>.md.bak`) and tell the user before overwriting — generic names (`developer`, `reviewer`, …) can collide with the user's own sub-contexts.

**Reconcile, don't clobber — when a prior install exists with local edits.** Don't blindly overwrite a Stig block or agent file the user has changed. Compare the installed version against the new canonical and merge: keep the user's customizations (extra rules, model choices, tone), apply the new changes. Ensure these invariants survive — and warn the user if one of their edits conflicts with them:
- the Stig block's `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers and each worker's `<!-- with-monet:agent -->` marker (lose them and a later update can't find the block),
- the **Git & PR guardrail**,
- "sub-contexts can't spawn sub-contexts — the lead is the only orchestrator",
- the Monet lifecycle (`agent_context` at start; `memory_store` / `memory_checkpoint`),
- the **main-session convergence check** ("Scan before you send" — the structural paragraph immediately after "Spend the return"),
- each worker's `name` + `description` — the `description` drives your host's dispatch trigger; if it's broken, delegation silently stops.

Show the merged result, write only on the user's approval, and keep the `.bak`. A coding agent can do this reconciliation by judgment — no version-pinning or 3-way merge tooling required; `.bak` plus approve-before-write keep it safe.

The user may request a trimmed worker set, but the full team is the default — don't reduce to Stig-only by *choice*. (A host without real isolated subagents can't run the team at all — the install stops there, per Tier B.)

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* The richest sources are the ones that already capture how you and your team work:

- **Agent reference files** — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Cursor/Cline/Copilot/Windsurf/Continue rules, and any other agent instructions you've written. These often hold the most distilled project knowledge.
- **`README`s and `docs/`** in this repo — architectural decisions, conventions, ADRs.
- **Notes and decision docs** — `NOTES.md`, `TODO`, scratch docs, anything that records *why* decisions were made.
- A path or URL the user names.
- Skip for now.
- (If you're coming from a prior Monet store, say so and I can pull that in too — if it's a *separate* old install with its own MCP server, see the cross-server note in `consolidate-memory.md`.)

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate). Don't ingest secrets. **Skip Monet's own wiring:** when the source is `CLAUDE.md` (which holds Stig's prompt) or an installed agent prompt, don't store the `<!-- BEGIN with-monet:stig -->…<!-- END with-monet:stig -->` block or any `<!-- with-monet:agent -->`-marked file. Summarize what landed.

Then capture **how you and your team work**, as two distinct kinds:
- **Team ways of working** — conventions, build/test/lint commands, repo layout, norms. Store as project/reference concepts.
- **Personal preferences** — how *you* like the agent to work: voice (e.g. teammate vs. assistant), autonomy, output format. Store as `user` concepts.

Ask directly for the preferences that aren't written down anywhere — especially how you want the agent to *sound*. These get injected into every briefing and applied to how the agent talks to you.

**Existing knowledge to consolidate?** If you find a meaningful pile — agent reference files (`CLAUDE.md`/`AGENTS.md`/Cursor/Cline/Copilot/Windsurf rules), a tool-managed memory store, scattered notes/ADRs, or an existing Monet store — don't leave it scattered. Offer the interactive consolidation playbook [`bootstrap/consolidate-memory.md`](consolidate-memory.md) (same raw-URL base as above): capture each source into Monet, organize into per-project circles *with* the user, then retire the source (a pointer or archive) so Monet becomes the single place to read from. This Phase-5 pass ingests but never retires; consolidation does the organize-and-retire, interactively and reversibly. Skip if there's nothing meaningful to consolidate.

## Phase 6 — Offer to start

If your host loads MCP servers and agent prompts only at launch (most do — per Phase 1), tell the user to reload/restart so `monet` connects and the team registers before starting.

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

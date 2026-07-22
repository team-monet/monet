# Monet — agent-first install playbook

**You are the user's coding agent.** The user pasted a one-line request to set up Monet. Your job is to install and configure it *for* them — running the commands yourself, conversing at each decision point, and diagnosing/fixing failures as you go. **Do not ask the user to clone a repo or run shell scripts themselves.** Adapt to their host and preferences.

Work through the phases in order. After each, tell the user what happened in one line. If a step fails, show the error, explain the likely cause, propose a fix, and retry — never leave a half-configured state.

**This playbook is self-contained — no clone or pre-install needed.** You install the substrate yourself (Phase 2), and you read any prompt file you need (`roster.json`, `agents/<name>.md`) from one of:
- a local `with-monet` checkout if one exists (prefer it), else
- this repo's raw URLs, base `https://raw.githubusercontent.com/team-monet/with-monet/main/` (e.g. `…/agents/stig.md`).

(Raw fetch needs the repo to be **public**; if it's private and you can't fetch, that's the one time to ask the user to clone `with-monet` and point you at the local path.)

---

## Updating an existing install (Stig + worker files)

Already set up and just want the latest Stig persona and worker files? You don't need to re-run onboarding — re-run **Phase 4 and Phase 7** against the latest sources:
1. Re-read `roster.json`, `agents/*.md`, and `agents/stig.md` from the raw-URL base (or your local `with-monet` checkout).
2. Re-apply Phase 4's write step **to the same scope the team was installed in** — detect that from where the existing `<!-- BEGIN with-monet:stig -->` / `<!-- with-monet:agent -->` markers already live — in your host's lead-persona file and its worker/subagent locations (the surfaces you found in Phase 1), at whichever scope (user or repo) they were installed. Rewrite the Stig block (between the `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers) and each agent file **in that location** — never silently switch a per-repo install to global. **Reconcile, don't clobber:** preserve your local edits, apply the new changes, guard the invariants, and keep `.bak` (see Phase 4). (Read the `with-monet:mode` marker at the top of the installed Stig block — it records team-vs-lead-only and the installed worker list. No marker (an older install)? Infer from what's installed — worker files present means team, and the refresh then covers the Stig block *and* every worker file; absent means lead-only, and the refresh covers the Stig block only — and ADD the marker while you're rewriting the block. Don't re-ask the team question here; Phase 4's live re-offer covers that.)
3. **Reconcile removals too** (team installs only — when the mode marker says `lead-only`, skip this step: there are no worker files, and the host may have no subagent location to scan): diff the agent `name`s in the roster you just re-read against the installed worker files carrying the `<!-- with-monet:agent -->` marker in the host's subagent location. A marker-carrying file whose agent is no longer in the roster is an orphan from an older roster — left in place, it keeps receiving dispatches for a role the team no longer has. Show the user the orphan list and offer to remove them, backing each up first (same `.bak` discipline as Phase 4). After a removal, update the mode marker's `workers=` list to drop the removed names — the marker must never advertise a worker that isn't installed. Never touch a same-named file *without* the marker — that's the user's own custom subagent, not ours.

Skip Phases 1–3 (substrate + MCP already configured), 5–6 (memory-ingest and offer-to-start), and 8 (star) — but **run Phase 7 (verify)**: the agent files were just rewritten, so confirming workers still launch is most needed here (lead-only installs: verify the refreshed Stig block took effect instead — there are no workers). If your host loads agents/MCP only at startup (most do — you noted this in Phase 1), **reload or restart it** before Phase 7 so the updated Stig + workers take effect; a running session keeps the old prompts until you do. Phase 4 is idempotent, so this is safe to repeat.

---

## Phase 1 — Orient

You install Monet **globally for this user** (every project), not just the current repo — so the team and memory work everywhere without re-installing per project. (If the user prefers, you can scope it to just this repo instead — confirm in step 2.)

1. **Identify your host and its install surfaces.** You're the agent running inside it, so you know — or its docs do — where it keeps, at user scope, (a) its **MCP server config**, (b) its **always-on lead-persona / system prompt**, and (c) its **named-subagent definitions** (if it has them). Note two capabilities that gate the rest of the install:
   - **MCP support — required.** Monet is an MCP server and Stig's whole loop is MCP tools (`agent_context`, `memory_store`, `memory_checkpoint`). If the host can't run MCP servers, **stop** and tell the user Monet needs an MCP-capable host.
   - **Real isolated subagents — enable the worker team, but aren't required to install.** Each worker runs in its *own fresh context* the lead delegates into — not an always-on "rule" that bleeds into the main context. If the host has this, you'll offer the full team (Phase 4 Tier B). If it doesn't — or the user would rather the main agent handled everything itself — Stig still installs **lead-only**: the context engine and Monet loop work standalone, without delegation. **Feature-detect subagent support from the host's docs — don't infer it from the host's name** (host capabilities change fast).

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

Merge into the host's **user-level** MCP config **without clobbering existing servers** — read it, add `monet`, write it back, and back up the file first. Verify it comes up: `monet start` logs `semantic embeddings ready (MiniLM, 384-dim)` then `Monet started`, and also prints the active project circle (`Circle: <name>`), confirming per-project organization. Then confirm the tools are live **in this session**: call `agent_context` (no query — on a fresh install expect a near-empty restore, which is fine). If the call isn't available, your host only connects MCP servers at launch: tell the user to reload/restart now, then resume this playbook at Phase 4 in the fresh session — Phases 5 and 6 need Monet callable. Before that reload, hand the user the resume line to paste into the fresh session — it has none of this conversation, so the paste-line is its whole handoff. Include the source: if this install is running from a local checkout, use the absolute path to `bootstrap/install.md` in that checkout; if from a raw URL, use the URL you received it from. The handoff reads: *"Read <absolute local install.md path or raw URL, the exact source for this session> and resume the Monet install at Phase 4. First, re-run the Phase 3 liveness check — call `agent_context` to confirm Monet is live and connected (a config path issue or env var misalignment is only observable after the restart); if the call fails, debug registration before proceeding; if it succeeds, continue with Phase 4. Host: <host>, scope: <global or this repo>."* The server exposes 19 tools: `agent_context`, `memory_store`, `memory_search`, `memory_overview`, `memory_gather`, `memory_fetch`, `memory_synthesize`, `memory_checkpoint`, `memory_flag_contradiction`, `memory_resolve`, `memory_list`, `memory_reassign_circle`, `memory_detach`, `memory_circle_manage`, `memory_first_block`, plus the source-link surface used in Phase 5's linking flow: `source_list`, `source_status`, `source_path`, `source_sync`. Recall is store-wide, with each result card carrying its home circle, so reorganizing circles never breaks findability. `memory_detach` splits observations out of a concept for wrong-merge repair — or, given `destConceptId`, folds them into another concept; detaching all observations with `destConceptId` consolidates the source away, carrying its identity as an alias on the keeper so references keep resolving. `memory_fetch` returns observation entries as `{id, content}`, pages with `observationsOffset`, and includes `lastConfirmedAt` (Unix ms of last evidence-based confirmation) as the staleness signal. `memory_store` accepts `resolution: "forceNew"`/`attachTo` for bulk import and directed attach. `memory_overview` surfaces `possibleDuplicates`. `memory_resolve` handles two verdict families: contradiction resolution (retrying an already-closed contradiction returns `alreadyClosed: true` with zero mutations) and duplicate-pair dismissal (pass `conceptAId` + `conceptBId` to assert two concepts are not duplicates, clearing the pair from `possibleDuplicates`; idempotent when no live edge exists). `memory_circle_manage` handles circle lifecycle — rename/merge/archive with stable aliases (the interactive curation ritual lives in [`curate-memory.md`](curate-memory.md)); `memory_reassign_circle` accepts `ids` batching and `resolution: "auto"|"forceNew"`. The consolidation flow uses `memory_list` and `memory_reassign_circle` (see [`consolidate-memory.md`](consolidate-memory.md)). `memory_first_block(action, ...)` manages the user-curated First Block — a compact high-signal section injected at the top of every `agent_context` response. Actions: `"promote"` (params: `conceptId`, `summary`, optional `circle`) pins a concept with a summary the agent writes (richer than a one-liner; a summary, not a title) — call only on explicit user confirmation; `"remove"` (param: `conceptId`) unpins a concept without deleting the underlying concept; `"list"` returns the ordered set of current pins with their summaries and underlying concept ids; `"reorder"` (param: `orderedConceptIds`) resets the pin order to the supplied id array; `"update_summary"` (params: `conceptId`, `summary`) rewrites a pin's summary in place — used when the underlying concept evolves and the cached summary goes stale.

The server also provides an in-band session lifecycle with zero host configuration: on the first successful tool response, it appends a delimited block (`=== MONET SESSION CONTEXT (auto-prewarm) ===`) as an additional content item carrying active workstreams, top concepts, and a curation advisory — suppressed when the first call is `agent_context` (no double-inject), and opt-out server-side via `MONET_NO_AUTOPREWARM`; after 10 mutating calls (then every 20) it appends a checkpoint nudge, silenced by a checkpoint that saves a workstream; and the server's `instructions` field describes the memory loop so an agent without the Stig persona gets the loop on first use.

## Phase 4 — Install the agent team (user scope)

**Explain the multi-agent approach, then ask.** Before installing anything here, tell the user why Stig normally works with a worker team rather than doing everything itself: *"I can either handle everything myself in this one conversation, or set up a small team of focused workers I delegate to. Each one runs in its own fresh context — that tends to catch more (a reviewer that never saw the design is a better bug-finder than one that did) and keeps this main conversation small since workers spend their own context, not ours. Want the team, or would you rather I just handle things directly?"* Then act on their answer:

- **Team (default recommendation), if the host supports it** — proceed through Tier A to Tier B below.
- **Lead-only**, if the user prefers it, or the host can't run isolated subagents (Phase 1) — Stig installs alone: the context engine and Monet loop, no worker files. `agents/stig.md` carries a lead-only section for this already — nothing extra to author beyond the normal persona install. Say so plainly, then do **Tier A** below — the persona write is unconditional; team or lead-only both get Stig installed — Tier A's mode marker records the choice (`lead-only`), which is how Stig knows not to delegate after a restart — skip Tier B, and continue to Phase 5. (Switching an *existing team install* to lead-only? Order matters: complete Tier A first — the rewritten block with its `lead-only` marker is the source of truth, and its rewrite must reconcile-don't-clobber any local edits inside the old block, same as the update path — and only after that write succeeds remove the installed `<!-- with-monet:agent -->`-marked worker files, backing each up. If Tier A is declined or fails, remove nothing: a `team` marker with missing workers is the worst of both.) Stig can re-offer the team later if a task would clearly benefit (a large refactor, a security-sensitive change) — a live re-offer, not a one-time question; accepting it re-runs this phase's Tier B, which also rewrites the mode marker to `team` with the installed roster.

Stig is the **lead** (the one the user talks to, the only one that delegates, and the only one that *uses* Monet); in team mode the workers are its **subagent actuators**.

**Tier A — Lead persona (ask first, highest-impact write).** This is the install's highest-impact write, so it gets its own decision point. Ask: *"Install Stig as the lead persona in your [host's lead-persona location]? This changes how every session on this machine starts."* A general "go ahead with the install" doesn't cover this — wait for an explicit yes (your host's permission system will likely insist on the same). On a no, offer to scope Stig to the current repo's equivalent per-repo location instead (the per-repo option from Phase 1).

Write the body of `agents/stig.md` (wrapped in the `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers) into your host's lead-persona target so the **main agent** acts as Stig and can delegate to workers. A key constraint that must survive regardless of host: the lead must be the main agent — sub-contexts cannot spawn further sub-contexts, so only the main agent can delegate. The lead is also the only agent that *uses* Monet. Where the host supports a per-subagent tool denylist, Monet access is denied in worker configs at install time (enforced); where it does not, the workers' role prompts are the guarantee (behavioral).

Write it into your host's **always-on lead-persona location** — the file or setting whose content is injected into every session (you know your host's; its docs or the user can confirm). Honor the global-vs-repo scope choice from Phase 1: if the host exposes both a user-scope and a repo-scope location, use the one chosen — never silently switch one for the other.

Wrap the body in idempotent markers so re-running doesn't duplicate it. If the host's lead-persona file requires frontmatter (some hosts' rule files do), put the markers and body **below** that frontmatter — a leading HTML comment can break the file's activation metadata. The block's first line is a **mode marker** — team install:
```
<!-- BEGIN with-monet:stig -->
<!-- with-monet:mode team workers=<comma-separated list of the worker names actually written in Tier B> -->
…agents/stig.md body…
<!-- END with-monet:stig -->
```
— or lead-only install:
```
<!-- BEGIN with-monet:stig -->
<!-- with-monet:mode lead-only -->
…agents/stig.md body…
<!-- END with-monet:stig -->
```
The marker is the persona's durable record of the install-time choice — Stig reads it at runtime; write it accurately and update it whenever the installed worker set changes.

If the markers already exist, replace the block in place; never append a second copy, and never clobber the user's other content in that file (back it up first).

**Tier B — Workers (only where the host has real isolated subagents).** Install the worker team only if your host has a **true named-subagent primitive** — one that gives each worker its *own fresh, isolated context* the lead delegates into, separate from the lead's context and with its own tool access. An always-on "rules"/"instructions" mechanism is **not** this: it bleeds every persona into the main context, breaking the "workers run separately" design — the lead is the only agent that *uses* Monet (the workers' role prompts never involve memory). **Feature-detect** this from the host's docs — don't infer it from the host's name. Confirm too that the host's subagents have the tool access each worker needs (file-edit for `mechanic`/`developer`/`tester`, web for `researcher`); if they're read-only, tell the user — those workers can't do their job there.

If the host has it: write one worker prompt per worker — `explorer, researcher, analyst, mechanic, developer, tester, reviewer, auditor, security` — into the host's subagent location, mapping each worker's `roster.json` fields to the host's format:
- `name` → the host's agent name.
- `description` → the host's dispatch/trigger text — **use it verbatim, not a bare role label**; it's what routes a task to the right worker. (The descriptions contain colons, so quote them if the host's format needs it.)
- `model` → the roster's `haiku`/`sonnet`/`opus` are **capability guidance**, not portable model IDs; translate them to the host's equivalents or omit to inherit the session model. Use the strongest reasoning available for `analyst` and `developer` on complex work so closure and implementation quality happen upstream; use a balanced model for `tester`; use cheaper models for read-only discovery and mechanical edits. Use the strongest reasoning for `reviewer`, `auditor`, and `security` when invoked because of their risk remit, while recognizing that review independence comes from fresh context, not from being stronger than the developer. Offer to retune for cost and task complexity.
- `touchesMonet` (denylist enforcement) → for every worker whose roster entry is NOT `touchesMonet: true` (i.e. all workers — only `stig` carries `touchesMonet: true`): if the host provides a per-subagent tool denylist, deny the Monet MCP server's tools using it. Feature-detected; degrades gracefully:
  - **Claude Code**: add `disallowedTools: mcp__monet` to the generated frontmatter. The `mcp__monet` prefix is server-level and covers all of Monet's tools while leaving every other inherited tool intact. `stig` (the lead) must NOT get this — it needs full Monet access.
  - **Codex**: no reliable per-subagent denylist exists — skip this field entirely and rely on the behavioral guarantee. (Do NOT add `[mcp_servers.monet] enabled = false` — that invalidates the whole sub-agent; see Host notes.)
  - **Other hosts**: apply their equivalent per-subagent tool denylist for `monet` if they expose one; otherwise fall back to the behavioral guarantee.

Add the `<!-- with-monet:agent -->` marker right after any leading frontmatter — it lets a later memory-consolidation pass tell Monet's installed workers apart from the user's *own* custom sub-contexts, so it never captures or retires the team.

Example worker file for **Claude Code** (adapt frontmatter to your host; non-Claude-Code hosts omit `disallowedTools`):
```md
---
name: explorer
description: "Use PROACTIVELY to investigate the codebase: locate files, symbols, call sites, …"
model: haiku
disallowedTools: mcp__monet
---
<!-- with-monet:agent -->
<body of agents/explorer.md>
```

After the worker files are written, update the mode marker's `workers=` list (Tier A, above) to exactly the set just written — full or trimmed — the marker must never advertise a worker that wasn't installed.

**No real isolated subagents on this host: that's lead-only, not a stop.** Without a true subagent primitive, workers-as-rules or in-conversation role-play would break the isolation invariant — so don't install worker files here. This isn't a dead end: Stig still installs as lead-only (see the top of this phase) and the Monet loop works fully standalone. Tell the user plainly this host can't run the worker team specifically (it needs a real subagent primitive alongside MCP) — not that Monet itself doesn't work here.

**Write each file transparently, one at a time.** Use your host's file-write tool so the user sees every file's content as it's written; never generate a script that batch-writes the agents directory. Host permission systems treat opaque scripted writes to agent config as suspect and will (rightly) block them — per-file writes the user can read are both the polite and the working path.

**Don't clobber.** If the target file already exists, back it up (`<name>.md.bak`) and tell the user before overwriting — generic names (`developer`, `reviewer`, …) can collide with the user's own sub-contexts.

**Reconcile, don't clobber — when a prior install exists with local edits.** Don't blindly overwrite a Stig block or agent file the user has changed. Compare the installed version against the new canonical and merge: keep the user's customizations (extra rules, model choices, tone), apply the new changes. Ensure these invariants survive — and warn the user if one of their edits conflicts with them:
- the Stig block's `<!-- BEGIN with-monet:stig -->` / `<!-- END with-monet:stig -->` markers and each worker's `<!-- with-monet:agent -->` marker (lose them and a later update can't find the block),
- "sub-contexts can't spawn sub-contexts — the lead is the only orchestrator",
- the Monet lifecycle (`agent_context` at start; the `memory_store` write discipline),
- the **main-session convergence check** ("Scan before you send" — the structural paragraph immediately after "Spend the return"),
- Stig's compact **evidence-status and synthesis rule**: mark decision-relevant observed evidence as `Fact:`, derived conclusions as `Inference:`, and insufficient evidence as `Unknown:` in substantive diagnoses, decisions, risk calls, and worker briefings; lead user-facing synthesis with the outcome and end with the decision, next action, or approval needed without turning routine updates into ceremony,
- Stig's **product-calibrated disposition and scoped behavioral lessons**: worker findings are technical evidence, not automatic product priority; Stig checks the current user and product outcome, product and work contracts, the supported environment and threat model, reachability and harm, and opportunity cost before blocking or expanding scope, surfaces missing context as `Unknown:` for discussion, lets explicit contracts and safety invariants override stored risk preferences, and stores behavior-changing feedback as scoped lessons with applicability boundaries and an expected behavior change, never as incident logs or one-off ticket state,
- the **bounded-convergence policy**: optional analysis when ambiguity or risk warrants it; one implementation and one combined verification gate per slice; at most one batched correction followed by targeted re-verification; a new blocker class then stops patching and returns to design, and any change to ratified scope or contract waits for explicit user approval. Do not preserve an older recursive same-tier verification rule over this invariant,
- the **model-selection policy**: strongest reasoning upstream for complex analyst/developer work, balanced testing, cheaper read-only/mechanical work, and strongest risk review when invoked; fresh-context independence never requires the reviewer to outrank the developer,
- each worker's `name` + `description` — the `description` drives your host's dispatch trigger; if it's broken, delegation silently stops.

Show the merged result, write only on the user's approval, and keep the `.bak`. A coding agent can do this reconciliation by judgment — no version-pinning or 3-way merge tooling required; `.bak` plus approve-before-write keep it safe.

The user may request a trimmed worker set (e.g. skip `security`) even in team mode — the full team is the default recommendation, not a forced install. A full opt-out is the **lead-only** path above (Phase 4 top), not a silent Stig-only fallback by omission — and on an *existing* team install, opting out means removing the installed `<!-- with-monet:agent -->`-marked worker files too (back each up first, same discipline as the update path's orphan removal) and rewriting the mode marker to `lead-only`. Record any trim in the mode marker (`workers=` lists only what was actually written) — and when a re-run trims a role that was previously installed, remove its marked worker file too (back it up first; the roster-diff orphan scan won't catch a user-chosen trim, only roster-deleted names). Stig degrades gracefully for missing roles, but only if the marker tells the truth and the host carries exactly what it lists.

## Phase 5 — Offer the memory-ingest pipeline

Ask: *"Want me to seed Monet from existing knowledge so you don't start empty?"* The richest sources are the ones that already capture how you and your team work:

- **Agent reference files** — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, Cursor/Cline/Copilot/Windsurf/Continue rules, and any other agent instructions you've written. These often hold the most distilled project knowledge — but if one's still actively edited, linking (below) usually beats a one-time capture.
- **`README`s and `docs/`** in this repo — architectural decisions, conventions, ADRs.
- **Notes and decision docs** — `NOTES.md`, `TODO`, scratch docs, anything that records *why* decisions were made.
- A path or URL the user names.
- Skip for now.
- (If you're coming from a prior Monet store, say so and I can pull that in too — if it's a *separate* old install with its own MCP server, see the cross-server note in `consolidate-memory.md`.)

For each chosen source: read it, and `memory_store` the durable facts/decisions/patterns (the substrate dedups automatically — store liberally, don't pre-curate) — unless it's a still-actively-edited agent-instruction file you're linking instead of capturing (below), which skips this step entirely. Don't ingest secrets. **Skip Monet's own wiring:** when the source is `CLAUDE.md` (which holds Stig's prompt) or an installed agent prompt, don't store the `<!-- BEGIN with-monet:stig -->…<!-- END with-monet:stig -->` block or any `<!-- with-monet:agent -->`-marked file. Summarize what landed.

Then build the first **context profile** — how this project works, and how this user likes to work. Keep these as two separate memory families; don't bury personal style inside a project convention blob. Also capture at the right granularity: store a coherent high-level concept when the future task needs the whole working model, and store detailed scoped facts when exact recall matters.

- **Team ways of working (team-scoped):** conventions, build/test/lint commands, repo layout, review/release norms, deployment/runbook facts, and "how we do things here." Store as project/reference concepts in the relevant project circle. Include the applicability scope ("repo-wide", "frontend only", "release flow", etc.) and the evidence/source.
- **Personal preferences (user-scoped):** how *this user* likes the agent to work: voice (e.g. teammate vs. assistant), autonomy, update cadence, approval boundaries, output format, and risk tolerance. Store as `kind: "user"` concepts, with the body saying whether the preference is global or project-specific.

For both families, prefer a **two-resolution capture** when the source supports it:
- a compact conceptual memory that explains the pattern or preference and why it matters;
- separate precise memories for exact commands, file paths, config keys, model choices, branch/release rules, approval boundaries, output formats, or any wording the agent may need verbatim later. Use `resolution: "forceNew"` for these precise fact memories when they might otherwise collapse into the broader concept; exact recall is the point.

Ask directly for the preferences that aren't written down anywhere — especially how the user wants the agent to *sound* and how much autonomy they want before edits, tests, git actions, or external calls. Store durable answers immediately, and store exact boundaries as their own precise facts instead of only summarizing them into a broad preference. Do not store secrets, one-off moods, or absences like "no preference stated."

Verify the context profile like any other capture: `memory_search` / `memory_fetch` the new ways-of-working and personal-preference concepts, synthesize if needed, and summarize what Monet now knows. These concepts are what Stig gathers at task start, injects into worker briefings under distinct headings, and applies to its own user-facing writing.

**Existing knowledge to consolidate?** If you find a meaningful pile — agent reference files (`CLAUDE.md`/`AGENTS.md`/Cursor/Cline/Copilot/Windsurf rules), a tool-managed memory store, scattered notes/ADRs, or an existing Monet store — don't leave it scattered. Offer the interactive consolidation playbook [`bootstrap/consolidate-memory.md`](consolidate-memory.md) (same raw-URL base as above): capture each source into Monet, organize into per-project circles *with* the user, then retire the source (a pointer or archive) so Monet becomes the single place to read from. This Phase-5 pass ingests but never retires; consolidation does the organize-and-retire, interactively and reversibly. Skip if there's nothing meaningful to consolidate.

### Or link it live, instead of capturing it

Capturing is a snapshot: Monet stores what a file said right now, and if you consolidate, the file gets retired in favor of that snapshot. Some sources are better left live: `CLAUDE.md`, `AGENTS.md`, and similar agent-instruction files are usually edited often, by more than one tool or teammate — freezing them means Monet quietly drifts from what the file actually says.

For those, offer **linking**: Monet registers the file (or a repo's Markdown tree) as a source it keeps in sync, rather than a one-time capture. The file stays exactly where it is, fully live and editable — nothing gets stubbed.

**Don't link Monet's own wiring — decide the scope before you register anything.** `--include` is effectively mandatory: omitting it (without `--auto-detect true`) registers an *empty* selector — the sync publishes 0 files yet still reports healthy, so always pass an explicit glob. And a broad one like `--include "**/*.md"` picks up every Markdown file — including installed worker prompts and, inside `CLAUDE.md`, the `<!-- BEGIN with-monet:stig -->` block. Linking works on whole files (include/exclude globs — no partial-file exclusion), so always scope `--include`/`--exclude` to the user's own content and keep the harness files out. And when the Stig block lives *inside* the user's `CLAUDE.md` (hosts whose lead-persona file *is* `CLAUDE.md`), linking that file pulls the block in too — there, prefer capturing the file's user-authored parts instead (capture can skip the marked block), or suggest the user keep their own conventions in a separate file and link that.

1. Register: `monet source add <name> --type repo-md --allow-caller local-agent --allow-project <project id> --include <the specific file or glob, e.g. CLAUDE.md>`. `--allow-caller` and `--allow-project` are both mandatory, and Monet checks them against the identity its *own* server derives — not whatever you pass. `local-agent` is the right `--allow-caller` value unless the user runs multiple named agents against this store. For `--allow-project`: if this project has a git `origin` remote, it's the canonical `host/owner/repo` form (e.g. `github.com/team-monet/with-monet` — lowercased host, no scheme, no `.git`); with no remote, it's the same folder-hash circle name Phase 3 printed as `Circle: <name>` when the server started. There's no standalone lookup command for either value — `add` always prints a `Server identity: caller … · project …` line showing what the server actually derived, so if your value didn't match, reconcile with `monet source update <source-id> --allow-caller <id> --allow-project <id>`. Use `--type git-md` (with `--remote`, `--branch`, `--allow-scheme`, `--allow-host`) for a source living in a different repo. Run the source CLI against the *same store the MCP server uses*: for a dev-fallback install with no `monet` on PATH, use `node <abs>/dist/cli.js source add …`; for a zero-install user who ran `npx -y @team-monet/monet start`, use `npx -y @team-monet/monet source add …`. If Phase 3 set `MONET_STORAGE_DIR` in the MCP block, export the same value for this call — otherwise the registration lands in a different store and `source_sync` won't find the id.
2. Sync once: call the `source_sync` MCP tool with the new source's id — registration alone doesn't pull content (`monet source show` reports `Status: pending-initial-sync` until you do; the `source_status` MCP tool shows `lastSyncResult: "never"` and `freshness: "unknown"` pre-sync). After the sync completes, verify the files actually landed: call `source_status` with the source id and check `filesIndexed` is > 0 and roughly matches the expected file count; also spot-check with `memory_search` for distinctive content from one of the linked files. If `filesIndexed` is 0 despite a successful sync, re-check the `--include` glob and working directory — an empty-selector registration publishes healthy but transfers nothing.
3. It stays current from there: re-run `source_sync` for the latest, or set `--refresh interval --interval-seconds <n>` at registration for Monet to refresh on its own. `source_list` / `source_status` / `source_path` show what's registered, its sync state, and the sealed snapshot path.

**Default for `CLAUDE.md`/`AGENTS.md`: link, don't capture** — they're exactly the living, multi-consumer file type that shouldn't get frozen or stubbed — but only when `CLAUDE.md` does *not* contain the `<!-- BEGIN with-monet:stig -->` marked block. When the Stig block lives inside the user's `CLAUDE.md`, linking ingests Monet's own wiring; there, prefer capturing the file's user-authored parts instead (the guard earlier in this section explains why), or suggest they keep their own conventions in a separate file and link that. Reserve capture-and-retire for genuinely inert piles (`NOTES.md`, old ADRs, another tool's memory bank) where "Monet becomes the one place to read this from" is actually true. If the user wants their `CLAUDE.md` fully retired anyway, offer it — don't default to it.

### Pin what's load-bearing to the First Block

For anything ingested (captured or linked) that reads as a load-bearing rule or standing preference — not just a convention note, but something that should govern every future session — offer to pin it: *"This looks like a rule you'd want followed every time, not just noted — want it pinned to your First Block?"* One at a time, on explicit yes: `memory_first_block(action: "promote", conceptId, summary)`. For a rule found in *linked* content, first give it a concept of its own — the link skipped `memory_store`, so `memory_store` the rule now (a deliberate one-off, `sourceRefs` pointing at the linked file), then promote that conceptId: you're pinning the distilled rule, not the whole living source concept, whose content churns with every resync. Don't pin everything ingested; ask per-item where genuinely ambiguous rather than defaulting either way.

## Phase 6 — Offer to start

### Capture one live thing before you go

Before wrapping up, ask once: *"One last thing, so next time picks up where this one left off — what are you working on right now, or what's top of mind for this project?"* If they answer, screen it before storing — redact credentials, tokens, customer data, and anything the user marks transient (or ask when unsure) — then store it as a workstream (a `memory_checkpoint` with their screened answer as the open thread — Monet has been live since Phase 3's check). This is what makes the very first restore feel real instead of theoretical. Skip silently if they'd rather not; don't push.

If your host loads agent prompts only at launch (most do — per Phase 1), tell the user to reload/restart so the Stig persona takes effect — and, on a team install, the workers register — before starting. (Monet itself has been live since Phase 3; the reload is about the agent files.)

Ask: *"Ready? I'll run `agent_context` to restore state and begin as Stig on this project."* On yes: call `agent_context` (no query) and report what comes back — **and be precise about provenance, narrating only what the restore actually returned**: if they gave you a workstream in the capture step and it came back, lead with it — it never lived in any file; if Phase 5 ingested their files, name a source and one concrete preference. If either is missing — they skipped the ask, Phase 5 was deferred, or something didn't come back — narrate what *is* there instead, and say so plainly if the store is still near-empty ("this grows as we work"): a real miss you can fix beats a faked memory. This is the first moment the install actually pays off; don't let it read as a generic status line. With both in hand, something like: *"You told me you're [workstream] — that's not in any file, `git log` won't show it, it's just remembered. And from your [CLAUDE.md / notes], I now carry [one concrete preference or convention] — [N] things total."* Then continue as Stig.

(No restart available or practical in this host? Skip the reload framing and run the same `agent_context` call and narration in-band, right now — the demonstration is about what comes back, not about proving a fresh process. Source the narration strictly from what the tool call actually returns, not from what's already in this conversation — if the workstream doesn't come back, say so instead of repeating it from memory; a real miss you can fix beats a convincing fake.)

### Show them their memory — `monet dashboard`

Once Monet is running and has a little memory in it, offer to open the dashboard so the install pays off visibly:

> *"Want to see your memory? `monet dashboard` opens a local graph of everything Monet knows."*

- It's a **local, offline, strictly read-only web view** — `monet dashboard` starts a server on `http://127.0.0.1:7373` and tries to open your browser. The terminal only prints the URL and a `Store:` line; the actual view is in the **browser**. If it doesn't open automatically (some Windows/headless setups), visit the printed URL by hand.
- The **Graph** tab is the main view — the force-directed "second brain" of concepts and their links. The other tabs (Concepts / Entities / Timeline / Health) are **tables** by design, so landing on one looks like a flat data dump; switch to Graph.
- Looks empty or sparse? Two reasons: a brand-new store hasn't accumulated much yet (it fills in across sessions), or the dashboard is reading the wrong store. The banner's `Store:` line shows exactly which DB it opened — if that's not your project's store, point it explicitly: `monet dashboard -d <folder containing monet.db>`. Default port is `7373`; override with `-p <port>`.

## Phase 7 — Verify the install

Confirm both halves before wrapping up:

1. **Memory reaches the lead agent.** Stig (the main agent) should be able to call Monet tools — a quick `agent_context` or `memory_search` that returns confirms the wiring. If those calls fail or time out, the server may be unregistered *or* registered-but-not-starting (missing `monet` binary, PATH/env, a crash, or a startup timeout) — check the host's MCP status/logs and the server's startup, not just the config entry.
2. **Workers launch and run on their own.** Confirm each worker sub-agent still starts and completes a task — a worker that silently fails to start usually means its config got mangled during install (see Host notes). Workers don't use Monet — on hosts that support a per-subagent tool denylist (Claude Code: `disallowedTools: mcp__monet`), this is enforced at config level for every worker whose roster entry lacks `touchesMonet: true`; on hosts without a denylist mechanism, it is a behavioral guarantee (role prompts never call memory tools). On Codex, workers inherit the parent's Monet server and can see its tools but don't use them — this is expected and cannot be prevented at config level (see Host notes). (Lead-only installs: skip the worker check — instead verify the Stig block with its `with-monet:mode` marker is present at the persona surface, and after the reload confirm the session actually opens as Stig: it should introduce itself as Stig and reach for `agent_context`, not behave as the host's default persona. A passing Monet check alone doesn't prove the persona loaded.)
3. **Git/GitHub operations require explicit authorization.** Verify that the installed Stig's persona includes the guardrail: git commit, push, PR open/reply/merge operations must have the user's explicit go-ahead per-action or as a standing First Block instruction; absent that, Stig prepares changes and hands over exact commands rather than executing autonomously. This invariant must be preserved across any future upgrades.

### Host notes

<details>
<summary><strong>Codex</strong></summary>

Codex sub-agents inherit the parent session's `mcp_servers` (Monet included), so workers can see Monet's tools — they just don't use them (their role prompts never call memory). Codex has no reliable per-subagent tool denylist: this is the behavioral-fallback case for the `touchesMonet` enforcement described in Phase 4 — no config-level Monet restriction is applied here. Do not add a `[mcp_servers.monet] enabled = false` block inside a sub-agent config — this has been seen to invalidate the whole sub-agent (Codex silently drops it). If a sub-agent won't start, check for and remove any such block.

</details>

## Phase 8 — One last thing (star with-monet)

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

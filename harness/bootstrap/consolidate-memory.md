# Monet — interactive memory consolidation (capture & retire)

**You are the user's coding agent.** Knowledge about this user's projects is probably scattered — some in Monet's legacy `"default"` circle, some in other agents' rule files (`CLAUDE.md`, `AGENTS.md`, Cursor/Cline/Copilot/Windsurf/Continue/Zed/Aider rules), some in tool-managed memory stores, and a lot in plain `NOTES.md` / `TODO` / decision docs. This playbook **captures each of those sources into Monet and then retires the source**, so Monet becomes the single place your future sessions read from — instead of competing with half a dozen half-stale stores.

The whole point is *how* it feels: not a silent batch importer, but a smart peer helping the user consolidate their own knowledge. Discover, propose *with reasoning*, confirm, capture, verify, retire — in small, reviewable steps.

## Principles
- **Engaging and intelligent.** Explain what you found, propose what to capture and where, show *why*, and let the user steer. They should come away feeling Monet got smarter and more personal — not that they ran an importer.
- **Their structure, their call.** The user picks the granularity: one shared circle, one circle per **project** (which may span several repos), or one per **repo** (handle monorepos sensibly). Default to their mental model, not the filesystem's.
- **Capture before you retire — never the reverse.** A source is *captured* only once its content is stored in Monet **and** reads back coherently (Phase 6). Only then is it eligible to retire.
- **Non-destructive until confirmed, reversible after.** Preview everything; apply only on an explicit go-ahead; work in batches. Retiring is **opt-in per source** and defaults to a **pointer or archive** — never a delete. Hard deletion happens only if the user explicitly asks for that file. Keep anything ambiguous where it is and say so.
- **Idempotent.** Re-running must not duplicate or re-retire. Before capturing, check whether you already captured it (Phase 3); before retiring, check whether it's already a Monet pointer/archive (Phase 1) and skip it.
- **Leave Monet's own wiring alone.** After install, this repo's `CLAUDE.md` holds Stig's prompt (between `<!-- BEGIN MONET:STIG -->` / `<!-- END MONET:STIG -->` sentinels) and `.claude/agents/*` holds the worker prompts. Those are Monet's config, **not** user knowledge — never capture or retire them.

## Phase 0 — When to run this
Run when there's a meaningful pile of existing knowledge to consolidate, or whenever the user asks to organize / migrate / "sort out" their memory. Offer it during onboarding (`install.md` Phase 5) when you detect any of: a non-empty legacy `"default"` circle (`memory_list(circle:"default")`), other agents' rule files in the repo, a tool-managed memory store, or scattered notes/decision docs.

Set expectations in a line: *"I can pull your scattered knowledge — old Monet memory, other agents' rule files, your notes and decision docs — into Monet, then tidy each source so Monet's the one place we read from. I'll show you every step, capture before I touch anything, and never delete something you read at runtime — those become a short pointer. Want to do a pass?"*

## Phase 1 — Discover the sources
With your own file tools (`Glob`/`Read`/`Bash`), build a map of candidate sources. Scan the repo; ask before reaching outside it. Group what you find by **class**:

- **Legacy Monet memory** — the `"default"` circle (gauge with `memory_list(circle:"default")`).
- **Agent-config files (read at runtime).** `CLAUDE.md` (root + nested `{subdir}/CLAUDE.md`, follow `@path` imports ≤5 deep), `.claude/rules/*.md`; `AGENTS.md` (root + nested, `AGENT.md`, `AGENTS.local.md`); `.github/copilot-instructions.md` + `.github/instructions/**/*.instructions.md` (note `applyTo` globs); Cursor (`.cursorrules` legacy **vs** `.cursor/rules/*.mdc`); Cline/Roo (`.clinerules`, `.roo/rules/`); Windsurf (`.windsurfrules`, `.windsurf/rules/`); Continue (`.continue/rules/`); Zed (`.rules`); Aider (`CONVENTIONS.md`, only if `.aider.conf.yml` references it).
- **Tool-managed memory stores (direct analogues, high priority).** Cline `memory-bank/`; also sweep `GEMINI.md`, `.idx/airules.md`, `.junie/guidelines.md`.
- **Inert notes & decision docs.** `NOTES.md` / `TODO.md` / scratch; ADR/RFC dirs (`docs/adr`, `docs/decisions`, `docs/rfcs`); `README` note-sections; `docs/` scratch.

**Exclude — never capture or retire:**
- Monet's own artifacts: the `<!-- BEGIN MONET:STIG -->…<!-- END MONET:STIG -->` block inside `CLAUDE.md`, and `.claude/agents/*.md`.
- **Anything already retired by a prior run** — a file (or section) containing a `<!-- MONET:POINTER … -->` stub, or anything under the archive dir (`.monet-archive/`). Recognize these and skip them, so a re-run never re-captures a pointer's text or re-retires an archived file.

Where a single legacy file is **superseded** by a directory form (e.g. `.cursorrules` vs a populated `.cursor/rules/`), note it. Where both exist and precedence is undefined, capture both and don't remove either.

**Global / out-of-repo sources** (`~/.claude/CLAUDE.md`, global rules, Windsurf Cascade memories under `~/.codeium/…`) have machine-wide blast radius. You may **capture** them with explicit consent (they home to a **shared** circle, not a project circle), but **never retire them** — no pointer, no archive, no delete — unless the user explicitly asks for a specific global file. Default: capture-only.

Present the map and the project shape together: *"I found old Monet memory, an `AGENTS.md`, a `.cursorrules`, a `memory-bank/`, and a `docs/adr/` folder. Under `~/code` I see `acme-api` and `acme-web`. Want one circle per repo, an `acme` circle for both, or something else — and which of these should I pull in?"* Confirm grouping, circle names, and the source list **before touching anything**.

## Phase 2 — Read each source
Read full content (don't capture from titles). Follow `@path` imports. Note metadata worth preserving (Copilot `applyTo` globs, rule frontmatter).

For **legacy Monet memory**, use `memory_list(circle:"default", withProvenance:true)` (and `memory_overview` for a quick shape, if available), then `memory_fetch` the ones you need in full. Each has two signals for where it belongs: its **content** (the files, services, decisions it's about) and its **provenance** (the project path it was created under). *Provenance is the strongest prior for the **legacy-Monet** class only* — those memories were authored under real project working dirs. For **external** sources you capture now, provenance is recorded differently (via `sourceRefs`, see Phase 5), since every capture in this run executes under one working dir.

## Phase 3 — Check what's already captured (idempotency)
Re-runs must not duplicate, and — more importantly — you must not retire a source you only *think* is captured. Verify capture by **reading content back**, not by trusting a single probe:

- `memory_search` for the source's distinctive content, then `memory_fetch` the top candidate and confirm the source's actual facts are present. This is the reliable oracle.
- As a hint, `memory_gather(intent: "<source path/topic>", circle: <target>)` and look at the `sourceRefs` its ranked cards echo — a matching canonical ref means "already captured." Treat this as a *hint only*: gather attaches refs to ranked (not seed) cards and trims by its stop/limit, and some runtimes don't surface refs at all, so a missing ref is **not** proof of "never captured." Always fall back to the content read-back above.

Derive a **canonical source reference** per source for the `sourceRefs` you'll store: the absolute file path (or `path#section` for a chunked doc; the full URL for web). Skip or merge anything already captured.

## Phase 4 — Propose circle + capture, with reasoning
In **digestible batches**, propose what you'll capture and where, and show *why*:

> *"These look like `acme-api`: the `AGENTS.md` build conventions, the 'SQLite over Postgres' ADR, and 8 old Monet memories created under `~/code/acme-api`. I'd capture all of it into the `acme-api` circle. Good — or split any of it out?"*

Let the user correct assignments, merge/split, send something to a shared/global circle, or **exclude a source entirely**. For a memory that genuinely spans projects, say so and offer: home it in the dominant project, copy it into each, or keep it shared. Their preference wins — don't guess silently.

## Phase 5 — Capture into Monet
On confirmation, work batch by batch, reporting progress:

- **External sources (files, notes, other stores):** `memory_store(content, circle: <target>, sourceRefs: ["<canonical ref>"])`. `sourceRefs` records provenance and is your idempotency key. The substrate dedups automatically — store liberally, don't pre-curate. **Never store secrets.** The result's `action` is one of `created` | `attached` | `ambiguous` (see Phase 6).
- **Legacy Monet memory (the `"default"` circle):** `memory_reassign_circle(id, toCircle, circle:"default")` — **moves** the concept, its observations, and its graph membership into the target (no re-embedding; dedupes into a matching target concept). Pass `circle:"default"` as the id's *current* circle or the move is rejected. Its `action` is `moved` | `merged` | `noop`. **Copy into several circles:** reassign to the home circle, then `memory_store` into each additional circle (re-store dedupes within that circle). Reassign *moves*, store *copies*.

Leave anything ambiguous where it is and tell the user what's still unsorted.

## Phase 6 — Verify it landed *and* reads back
A source isn't captured until its content is in Monet **and** coherent. This gate is what authorizes retirement — be strict:

- Check the operation's `action`. For `memory_store`: `created`/`attached` are fine; **`ambiguous` is a yellow flag** — the evidence was attached to a possibly-different concept, so don't trust it blindly. For `memory_reassign_circle`: `moved`/`merged` are fine.
- Independently confirm with `memory_search` / `memory_overview` (it landed) and `memory_fetch` (read it back). Confirm the **source's specific content** is actually represented — not just that *some* coherent body exists. On an `ambiguous` store especially, if the source's facts aren't clearly present, do **not** retire it.
- On **first** capture the concept is unsynthesized: `memory_fetch` returns raw observations plus a `synthesisInstruction`. Write a coherent body with `memory_synthesize`, then `memory_fetch` again to confirm it reads well.

Only sources that pass this are eligible for Phase 7.

## Phase 7 — Retire the source (opt-in, class-appropriate, reversible)
Now — and only now — offer to tidy each captured source. Retiring is **per-source opt-in**; ask before each (or each batch). Preconditions for *every* retire: content **confirmed captured** (Phase 6), the source is **not** a Monet artifact or already-retired, the source is **not** a global/out-of-repo file (capture-only), and the user **explicitly approved** this source.

- **Agent-config files tools read at runtime** (`CLAUDE.md` user-knowledge section, `AGENTS.md`, `.github/copilot-instructions.md`, active rules dirs): **replace with a thin pointer**, never delete — those agents still read the file. Swap the knowledge content for a short stub that carries a detectable sentinel (so re-runs skip it) and preserves any required metadata (e.g. Copilot `applyTo`):
  ```
  <!-- MONET:POINTER circle=acme-api -->
  This project's durable knowledge now lives in Monet (circle: `acme-api`).
  Your agent restores it via `agent_context` / `memory_search`.
  ```
  For `CLAUDE.md`, retire **only** the user's own knowledge — everything **outside** the `<!-- BEGIN MONET:STIG -->…<!-- END MONET:STIG -->` block. **If those sentinels are absent** (e.g. an older install), do **not** guess where Stig's prompt begins — ask the user to point out their own section, or skip the file. For `CONVENTIONS.md`, confirm `.aider.conf.yml` still points at it before stubbing.
- **Tool-managed memory stores** (`memory-bank/`, etc.) and **inert notes** (`NOTES`/`TODO`/scratch, ADR/RFC files, scratch docs): **archive** — move them under `.monet-archive/` (preserving relative paths). For `README`/`docs`, excise only the captured note-section and leave the rest intact; never archive `README` or `docs/` wholesale.
- **Hard delete** is **not** offered by default. Only if the user *explicitly asks* to delete a specific file (e.g. a dead `.cursorrules` already superseded and captured) do you delete it — and only after confirming the content is fetchable from Monet. Any doubt → archive instead.

**Every archive or delete is copy → verify → remove, never a bare `mv`/`rm`:** copy the file to its archive path, re-read the archived copy and confirm its bytes/content match the original, *then* remove the original. For a delete, additionally re-confirm the content is still fetchable from Monet first. If any step fails, **abort that source and leave the original untouched.** Append a one-line entry to a `.monet-archive/manifest.md` for everything you move/stub/delete, so the whole pass is auditable and reversible.

## Phase 8 — Verify and hand off
Show each circle's now-organized memory (`memory_list` / `memory_overview`): *"Here's what each project now knows."* For newly-captured external items, attribute via `memory_fetch`/`sourceRefs` (not `memory_list` provenance, which reflects this run's working dir, not the source's path). Then show the retirement manifest: *"`AGENTS.md` → pointer; `memory-bank/` → archived to `.monet-archive/`; old Monet memory → moved into circles."* Confirm it feels right.

Close the loop plainly: Monet is now the single place to read from; where a runtime tool still expects a file, a pointer remains; everything retired is archived and reversible (see `.monet-archive/manifest.md`). On a runtime that scopes per project, each session now prewarms only its own circle and new memory auto-scopes there. (If the runtime doesn't yet auto-scope, say so: this organized the *existing* knowledge, but new writes still land in `"default"` until per-project circles are configured.)

---

## Tools this playbook relies on
- **Your own file tools** (`Read`/`Glob`/`Bash`) — discover and read sources, follow `@path` imports, and write pointers / move files when retiring. Monet has no file/ingest tool by design (it stays agent-agnostic); you bring the filesystem.
- `memory_store(content, circle, kind, sourceRefs)` — the **capture** primitive. Pass `circle` = the target and `sourceRefs` = the source's canonical path/URL (provenance + idempotency key). Dedups automatically. Returns `action`: `created` | `attached` | `ambiguous`.
- `memory_search(query, circle)` / `memory_fetch(id, circle)` — find and **read back** a memory's content (the reliable capture-verification path).
- `memory_gather(intent, circle)` — context rebuild whose ranked cards echo `sourceRefs` (a *hint* for prior-capture detection; verify with a content read-back).
- `memory_synthesize(id, body, circle)` — write a coherent body for a freshly-captured (unsynthesized) concept.
- `memory_overview(circle)` — quick counts + shape of a circle, if your runtime exposes it.
- `memory_list(circle, withProvenance)` — enumerate every concept in a circle with its card and (for legacy memory) the project path(s) its observations came from. Group legacy memory by provenance + content.
- `memory_reassign_circle(id, toCircle, circle)` — move a concept + observations + graph membership to another circle, deduping into any matching target. Pass the id's *current* circle (`"default"` for legacy memory). Returns `action`: `moved` | `merged` | `noop`.

> If your runtime predates `memory_list` / `memory_reassign_circle`, you can still consolidate legacy memory with `memory_search` + `memory_store` into the target circle — but prefer `memory_reassign_circle` where available, since it *moves* rather than re-creates, so nothing is duplicated or re-embedded.

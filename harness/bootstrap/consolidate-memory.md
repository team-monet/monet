# Monet — interactive memory consolidation (capture & retire)

**You are the user's coding agent.** Knowledge about this user's projects is probably scattered — some in Monet's legacy `"default"` circle, some in other agents' rule files (`CLAUDE.md`, `AGENTS.md`, Cursor/Cline/Copilot/Windsurf/Continue/Zed/Aider rules), some in tool-managed memory stores, and a lot in plain `NOTES.md` / `TODO` / decision docs. This playbook **captures each of those sources into Monet and then retires the source**, so Monet becomes the single place your future sessions read from — instead of competing with half a dozen half-stale stores.

The whole point is *how* it feels: not a silent batch importer, but a smart peer helping the user consolidate their own knowledge. Discover, propose *with reasoning*, confirm, capture, verify, retire — in small, reviewable steps.

## Principles
- **Engaging and intelligent.** Explain what you found, propose what to capture and where, show *why*, and let the user steer. They should come away feeling Monet got smarter and more personal — not that they ran an importer.
- **Their structure, their call.** The user picks the granularity: one shared circle, one circle per **project** (which may span several repos), or one per **repo** (handle monorepos sensibly). Default to their mental model, not the filesystem's.
- **Capture before you retire — never the reverse.** A source is *captured* only once its content is stored in Monet **and** reads back coherently (Phase 6). Only then is it eligible to retire.
- **Non-destructive until confirmed, reversible after.** Preview everything; apply only on an explicit go-ahead; work in batches. Retiring is **opt-in per source** and defaults to a **pointer or archive** — never a delete. Hard deletion happens only if the user explicitly asks for that file. Keep anything ambiguous where it is and say so.
- **Idempotent.** Re-running must not duplicate or re-retire. Before capturing, check whether you already captured it (Phase 3); before retiring, check whether it's already a Monet pointer/archive (Phase 1) and skip it.
- **Leave Monet's own wiring alone — in any host.** Monet's installed lead/worker prompts are config, **not** user knowledge: never capture or retire them. They're marked host-agnostically — Stig's prompt sits between `<!-- BEGIN MONET:STIG -->` / `<!-- END MONET:STIG -->` sentinels in `CLAUDE.md`, and every installed worker prompt carries a `<!-- MONET:AGENT -->` sentinel (plus `.claude/agents/*` for Claude). Recognize those markers wherever the team was installed (`.claude/agents/`, `.cursor/rules/`, `.continue/rules/`, …).

## Phase 0 — When to run this
Run when there's a meaningful pile of existing knowledge to consolidate, or whenever the user asks to organize / migrate / "sort out" their memory. Offer it during onboarding (`install.md` Phase 5) when you detect any of: a non-empty legacy `"default"` circle (`memory_list(circle:"default")` if your runtime exposes it, else `memory_overview` / a broad `memory_search`), other agents' rule files in the repo, a tool-managed memory store, or scattered notes/decision docs.

Set expectations in a line: *"I can pull your scattered knowledge — old Monet memory, other agents' rule files, your notes and decision docs — into Monet, then tidy each source so Monet's the one place we read from. I'll show you every step, capture before I touch anything, and never delete something you read at runtime — those become a short pointer. Want to do a pass?"*

## Phase 1 — Discover the sources
With your own file tools (`Glob`/`Read`/`Bash`), build a map of candidate sources. Scan the repo; ask before reaching outside it. Group what you find by **class**:

- **Legacy Monet memory** — the `"default"` circle (gauge with `memory_list(circle:"default")`, or `memory_overview` / `memory_search` if your runtime lacks `memory_list`).
- **Agent-config files (read at runtime).** `CLAUDE.md` (root + nested `{subdir}/CLAUDE.md`, follow `@path` imports ≤5 deep), `.claude/rules/*.md`; `AGENTS.md` (root + nested, `AGENT.md`, `AGENTS.local.md`); `.github/copilot-instructions.md` + `.github/instructions/**/*.instructions.md` (note `applyTo` globs); Cursor (`.cursorrules` legacy **vs** `.cursor/rules/*.mdc`); Cline/Roo (`.clinerules`, `.roo/rules/`); Windsurf (`.windsurfrules`, `.windsurf/rules/`); Continue (`.continue/rules/`); Zed (`.rules`); Aider (`CONVENTIONS.md`, only if `.aider.conf.yml` references it); Gemini (`GEMINI.md`), Firebase IDX (`.idx/airules.md`), JetBrains Junie (`.junie/guidelines.md`). These are read by their tools at runtime — retire them via the **pointer-stub** flow (Phase 7), never wholesale archive.
- **Tool-managed memory stores (direct analogues, high priority).** Cline `memory-bank/` (a folder the tool maintains as its memory, not a single runtime-read rules file).
- **Inert notes & decision docs.** `NOTES.md` / `TODO.md` / scratch; ADR/RFC dirs (`docs/adr`, `docs/decisions`, `docs/rfcs`); `README` note-sections; `docs/` scratch.

**Exclude — never capture or retire:**
- **Monet's own wiring, host-agnostic — but be section-aware, not file-blunt:**
  - **`MONET:STIG` is a SECTION** inside a possibly-mixed file: `CLAUDE.md` holds Stig's block **and** the user's own knowledge. Exclude only the `<!-- BEGIN MONET:STIG -->…<!-- END MONET:STIG -->` block (match `<!-- BEGIN MONET:STIG…` by prefix; ends at `<!-- END MONET:STIG -->`) — still capture/retire the **rest** of the file as user knowledge. Never skip the whole `CLAUDE.md` just because it contains the Stig block.
  - **`MONET:AGENT`-marked files are whole-file Monet wiring** — a worker/lead prompt Monet installed (`.claude/agents/`, `.cursor/rules/`, `.continue/rules/`, …). Skip the entire file. Recognize Monet's installed workers by the `MONET:AGENT` marker (or, as a fallback, the installed names — `explorer, researcher, analyst, developer, tester, reviewer, security, reliability, aria`). **Do NOT blanket-exclude `.claude/agents/*` by path:** an *unmarked* `.claude/agents/*.md` is the user's OWN custom subagent — treat it as candidate user knowledge, not Monet wiring, so its durable content still gets captured.
- **Anything already retired by a prior run** — skip the pointer region delimited by `<!-- BEGIN MONET:POINTER … -->` … `<!-- END MONET:POINTER -->` (don't re-capture its text), and anything under the archive dir (`.monet-archive/`). Scope this to that delimited region, **not the whole file**: if only a *section* was stubbed (a `README`/`docs` note-section) or fresh content was appended after a prior stub, still process the rest of the file — only the bounded pointer region is already-retired.

Where a single legacy file is **superseded** by a directory form (e.g. `.cursorrules` vs a populated `.cursor/rules/`), note it. Where both exist and precedence is undefined, capture both and don't remove either.

**Global / out-of-repo sources** (`~/.claude/CLAUDE.md`, global rules, Windsurf Cascade memories under `~/.codeium/…`) have machine-wide blast radius. You may **capture** them with explicit consent (they home to a **shared** circle, not a project circle), but **never retire them** — no pointer, no archive, no delete — unless the user explicitly asks for a specific global file. Default: capture-only.

Present the map and the project shape together: *"I found old Monet memory, an `AGENTS.md`, a `.cursorrules`, a `memory-bank/`, and a `docs/adr/` folder. Under `~/code` I see `acme-api` and `acme-web`. Want one circle per repo, an `acme` circle for both, or something else — and which of these should I pull in?"* Confirm grouping, circle names, and the source list **before touching anything**.

## Phase 2 — Read each source
Read full content (don't capture from titles). Follow `@path` imports. Note metadata worth preserving and capture it **as part of the memory**: Copilot `applyTo` globs, rule frontmatter — **and the containing directory of a nested runtime file.** A `frontend/AGENTS.md` or `{subdir}/CLAUDE.md` applies only within that subtree; that path *is* applicability scope. Record it with the memory (in the content and `sourceRefs`), and **don't retire a path-scoped file unless its scope is preserved** in Monet — otherwise `agent_context` could surface `frontend`-only rules during backend work.

For **legacy Monet memory**, use `memory_list(circle:"default", withProvenance:true)` **if available** (else enumerate with `memory_search` / `memory_overview`), then `memory_fetch` the ones you need in full. Each has two signals for where it belongs: its **content** (the files, services, decisions it's about) and its **provenance** (the project path it was created under). *Provenance is the strongest prior for the **legacy-Monet** class only* — those memories were authored under real project working dirs. For **external** sources you capture now, provenance is recorded differently (via `sourceRefs`, see Phase 5), since every capture in this run executes under one working dir.

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

- **External sources (files, notes, other stores):** `memory_store(content, circle: <target>, sourceRefs: ["<canonical ref>"])`. `sourceRefs` records provenance and is your idempotency key. The substrate dedups automatically — store liberally, don't pre-curate. **Never store secrets.** The result's `action` is one of `created` | `attached` | `ambiguous` (see Phase 6). **Chunk large sources** — a long `NOTES.md`, ADR, or rule file — into **section-level** stores (one `memory_store` per coherent section, `sourceRefs: ["path#section"]`), not one giant store: a fetch reads back a **bounded** view, so an oversized single memory can't be fully re-read or synthesized in Phase 6, and you'd end up retiring a source whose tail is only archived, never coherently available from Monet.
- **Legacy Monet memory (the `"default"` circle):** **if your tool list exposes `memory_reassign_circle`**, prefer it — `memory_reassign_circle(id, toCircle, circle:"default")` **moves** the concept + observations + graph membership into the target (no re-embedding; dedupes into a matching target concept; pass `circle:"default"` as the id's *current* circle or the move is rejected; `action` is `moved` | `merged` | `noop`). **Copy into several circles:** reassign to the home circle, then `memory_store` into each additional. — **If `memory_reassign_circle` isn't in your tool list** (currently-published runtimes may not have it yet), use the baseline that always works: `memory_fetch` each legacy concept and `memory_store` its content into the target circle (with the canonical `sourceRefs`; re-store dedupes). The original stays in `"default"`; tell the user that, and offer to finish the *move* once the reassign tool is available.

Leave anything ambiguous where it is and tell the user what's still unsorted.

## Phase 6 — Verify it landed *and* reads back
A source isn't captured until its content is in Monet **and** coherent. This gate is what authorizes retirement — be strict:

- Check the operation's `action`. For `memory_store`: `created`/`attached` are fine; **`ambiguous` is a yellow flag** — the evidence was attached to a possibly-different concept, so don't trust it blindly. For `memory_reassign_circle`: `moved`/`merged` are fine.
- Independently confirm with `memory_search` / `memory_overview` (it landed) and `memory_fetch` (read it back). Confirm the **source's specific content** is actually represented — not just that *some* coherent body exists. On an `ambiguous` store especially, if the source's facts aren't clearly present, do **not** retire it.
- On **first** capture the concept is unsynthesized: `memory_fetch` returns raw observations plus a `synthesisInstruction`. Write a coherent body with `memory_synthesize`, then `memory_fetch` again to confirm it reads well.

Only sources that pass this are eligible for Phase 7.

## Phase 7 — Retire the source (opt-in, class-appropriate, reversible)
Now — and only now — offer to tidy each captured source. Retiring is **per-source opt-in**; ask before each (or each batch). Preconditions for *every* retire: content **confirmed captured** (Phase 6), the source is **not** a Monet artifact or already-retired, the source is **not** a global/out-of-repo file (capture-only), and the user **explicitly approved** this source.

- **Agent-config files tools read at runtime** (`CLAUDE.md` user-knowledge section, `AGENTS.md`, `.github/copilot-instructions.md`, active rules dirs): **replace with a thin pointer**, never delete — those agents still read the file. **Only stub a file whose host can actually read Monet.** Install wired Monet into *this* host's MCP config; a pointer that says "restore via `agent_context` / `memory_search`" is useless to a tool that isn't Monet-connected (you may be running from Claude Code while `.github/copilot-instructions.md` feeds Copilot, or `.cursor/rules` feeds Cursor — neither can reach Monet). For an agent-config file belonging to a host you haven't confirmed is Monet-wired, **don't stub it**: capture its content and leave the file intact, unless the user explicitly confirms they're fine retiring that host's native instructions. When you do stub: **first archive the original** (copy → verify, per the rule below) so the swap is byte-for-byte reversible — Monet's synthesized memory may not preserve every detail verbatim — **then** swap the knowledge content for a short stub that carries a detectable sentinel (so re-runs skip it) and preserves any required metadata (e.g. Copilot `applyTo`):
  ```
  <!-- BEGIN MONET:POINTER circle=acme-api -->
  This project's durable knowledge now lives in Monet (circle: `acme-api`).
  Your agent restores it via `agent_context` / `memory_search`.
  <!-- END MONET:POINTER -->
  ```
  The **paired** `BEGIN`/`END` markers bound the stub exactly — so a section-level retirement (a `README` note-section) and any content appended after it stay distinguishable on re-runs.
  For `CLAUDE.md`, retire **only** the user's own knowledge — everything **outside** the `MONET:STIG` block (match the `<!-- BEGIN MONET:STIG` marker by prefix; the block ends at `<!-- END MONET:STIG -->`). **If that marker is absent** (e.g. an older install), do **not** guess where Stig's prompt begins — ask the user to point out their own section, or skip the file. For `CONVENTIONS.md`, confirm `.aider.conf.yml` still points at it before stubbing.
- **Tool-managed memory stores** (`memory-bank/`, etc.) and genuinely **scratch / untracked notes** (`NOTES`/`TODO`/scratch docs): **archive** (copy under `.monet-archive/` preserving relative paths, verify, then remove the original — see the rule below).
- **Canonical, source-controlled docs** (`docs/adr`, `docs/decisions`, `docs/rfcs`, and `README`/`docs` generally): these are **active project documentation**, not retirable memory. Capturing their decisions into Monet is great, but **leave the files in place** by default — archiving them removes them from the tracked tree, breaks links, and hides decisions from teammates and tooling that don't use Monet. At most excise a clearly-scratch note-section; only remove a canonical doc if the user explicitly agrees.
- **Hard delete** is **not** offered by default. Only if the user *explicitly asks* to delete a specific file (e.g. a dead `.cursorrules` already superseded and captured) do you delete it — and only after confirming the content is fetchable from Monet. Any doubt → archive instead.

**Every retirement — pointer-stub, archive, or delete — backs up the original first: copy → verify → then modify, never a bare overwrite/`mv`/`rm`:** copy the original to its `.monet-archive/` path, re-read the archived copy and confirm its bytes match, *then* (and only then): for a **pointer-stub**, overwrite the file with the stub; for an **archive or delete**, **remove the original** — its verified `.monet-archive/` copy *is* the backup. (Don't `mv` the original onto the archive path you just copied to — that fails or nests, e.g. `memory-bank/memory-bank/`; copy-then-remove.) For a delete, additionally re-confirm the content is still fetchable from Monet first. If any step fails, **abort that source and leave the original untouched.** Append a one-line entry to a `.monet-archive/manifest.md` for everything you stub/move/delete, so the whole pass is auditable and reversible. **Keep the archive local:** before creating `.monet-archive/`, add it to the repo's `.gitignore` — it holds verbatim copies of possibly-private memory, so a later `git add .` must not be able to publish it. (If the user explicitly wants the archive tracked, that's their call — but default to ignored.)

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

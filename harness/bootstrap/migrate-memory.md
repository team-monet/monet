# Monet — interactive memory migration (assigning circles)

**You are the user's coding agent.** Existing Monet memory may all sit in one circle (`"default"`) because earlier versions didn't scope by project. This playbook migrates that memory into per-project **circles** — and the whole point is *how* it feels: not a silent batch job, but a smart peer helping the user organize their own work. Scan, propose, confirm, apply — in small, reviewable steps, showing your reasoning the way a thoughtful colleague would.

## Principles
- **Engaging and intelligent.** Explain what you found, propose a grouping, show *why*, and let the user steer. The user should come away feeling Monet got smarter and more personal — not that they ran a migration tool.
- **Their structure, their call.** The user picks the granularity: one shared circle, one circle per **project** (which may span several repos), or one per **repo** (and you handle monorepos sensibly). Default to their mental model, not the filesystem's.
- **Non-destructive until confirmed.** Preview every reassignment; apply only on an explicit go-ahead; work in batches; keep anything ambiguous in `"default"` and say so.

## Phase 0 — When to run this
Run when `memory_overview(circle:"default")` shows a meaningful pile of legacy, unscoped memory, or whenever the user asks to organize / migrate / "sort out" their memory. Offer it during onboarding (`install.md` Phase 5) when a non-empty `"default"` circle is detected.

## Phase 1 — Map the user's projects
Ask the user for the **root folder** that holds their work (e.g. `~/code`, `~/work`, `~/src`). Scan it (your own file tools):
- find git repos and project roots (`.git`, `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`, workspace files);
- detect **monorepos** (one repo, many packages/apps) so you can offer per-repo *or* per-package circles;
- group what you find into candidate projects, with a sensible default **circle name** per group (the repo/project folder name).

Present the map and ask for the shape: *"Under `~/code` I see `acme-api`, `acme-web`, and a monorepo `platform` (3 packages). Want one circle per repo, group `acme-*` into one `acme` circle, split the monorepo by package, or something else?"* Confirm the grouping and names **before touching any memory**.

## Phase 2 — Read the existing memory
List and read what's in `"default"`: `memory_overview(circle:"default")` for shape, then read concepts. For each memory you have two strong signals for where it belongs:
- its **content** — the files, services, decisions, and conventions it's about; and
- its **provenance** — the project path(s) it was originally created in (Monet recorded the working directory on every session). Provenance is the strongest prior; content disambiguates and catches cross-project facts.

## Phase 3 — Propose circle assignments
Group the memories against the Phase 1 projects and present your proposal in **digestible batches**, with reasoning:

> *"These 12 memories look like `acme-api` — they mention `apps/api`, the auth service, and the 'SQLite over Postgres' decision, and were created under `~/code/acme-api`. Assign them there?"*

Let the user correct, merge, split, or send a memory to a shared/global circle. For a memory that genuinely **spans projects** (only possible because everything shared one circle, so it merged), say so plainly and offer the choice: home it in the dominant project, copy it into each, or keep it shared. The user's preference wins — don't guess silently.

## Phase 4 — Apply
On confirmation, reassign each memory's circle with `memory_reassign_circle` (moves the concept, its observations, and its graph membership into the target circle — no re-embedding, no duplicates; dedupes into an existing target concept if one matches). Work through the confirmed batches, reporting progress. Leave anything the user wasn't sure about in `"default"` and tell them what's still there.

## Phase 5 — Verify and hand off
For each new circle, run `memory_overview` and show the user their memory, now organized: *"Here's what each project now knows."* Confirm it feels right. From here every project session prewarms only its own circle — clean, isolated, and theirs. Note that new memory auto-scopes to the project going forward, so this is a one-time tidy-up.

---

## Tools this playbook relies on
- `memory_overview(circle)` — counts + shape of a circle. *(exists)*
- `memory_search` / `memory_fetch(id)` — read a memory's content. *(exists)*
- **`memory_list(circle, withProvenance)`** — enumerate every concept in a circle with its content card **and** the project path(s) its observations came from (the recorded session scope). *Lets you group by provenance + content.* *(new — substrate work)*
- **`memory_reassign_circle(id, toCircle)`** — move a concept + its observations + graph membership to another circle, deduping into any existing target concept. *(new — substrate work)*

> The two `(new)` primitives ship with the circle work in `@team-monet/core` / `@team-monet/monet`. Until they land, you can still do a lighter migration with today's tools (read from `"default"`, `memory_store` into the target circle), but prefer the reassign primitive once available — it moves rather than re-creates, so nothing is duplicated or re-embedded.

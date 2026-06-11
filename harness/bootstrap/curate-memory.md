# Curate memory — the librarian ritual

Within-store reorganization: synthesize what's dirty, mediate duplicates, and reshape circle topology — deliberately, in user-confirmed batches. This is a different job from [`consolidate-memory.md`](consolidate-memory.md) (cross-source ingestion and retirement); run this one on a store that already holds your memory.

**Requires** a runtime exposing `memory_circle_manage` (`@team-monet/monet` ≥ 0.5.0) for the circle-topology moves in Phase 3. Phases 0–2 need ≥ 0.3.0 (`memory_list`, `memory_detach`, `possibleDuplicates`); on runtimes between 0.3.0 and 0.5.0, run phases 0–2 and skip Phase 3.

**The librarian rule:** reorganizing is safe because recall is store-wide — moving a memory changes its address, never its findability. But reshelve deliberately, at session boundaries, with the user steering — never mid-task, never silently. Circles are write-home/project locality; **topic organization belongs to the entity/edge graph, not to circles** — don't propose topic-taxonomy circles.

## When to run

- At the end of a long session, after `memory_checkpoint`
- On demand, when the user asks to tidy memory
- When `memory_overview` shows signals: open `possibleDuplicates`, several stale concepts, or fragmentation in `otherCircles` (many small circles)

## Phase 0 — Read the state

`memory_overview` (omit `circle` args where supported to see `otherCircles`) for: counts, `possibleDuplicates`, stale, dirty, and the circle list. For any circle that looks fragmented or misplaced, `memory_list` with `withProvenance: true` — the working-dir paths each memory's observations were recorded under are the strongest signal of where it belongs. This evidence base grounds every proposal; no proposal without it.

## Phase 1 — Synthesize dirty concepts

For each dirty concept: `memory_fetch` → reconcile the observations into one coherent body → `memory_synthesize`. Do this BEFORE any reorganization: the synthesized body is what tells you whether two concepts are actually about the same thing.

## Phase 2 — Mediate possible duplicates

For each pair in `possibleDuplicates`: `memory_fetch` BOTH concepts and judge on bodies, never titles. Propose with reasoning: "These look like the same concept — [A] and [B]. Consolidate?" On yes: `memory_detach` the loser's observations into the keeper (`destConceptId`) — the loser is consolidated away and its name survives as an alias on the keeper. Work in batches of 3–5 pairs, pausing for confirmation between batches.

## Phase 3 — Propose circle reorganizations

Evidence first (Phase 0), then propose — each with its reasoning shown:

- **Re-home:** a concept whose provenance is exclusively another project's paths → `memory_reassign_circle` with `ids` (batch) and `resolution: "forceNew"`.
- **Rename:** a derived hash-name circle that's plainly one project → `memory_circle_manage` `rename`. The old name becomes a stable alias; sessions that derive it keep resolving (they'll see `resolvedFrom` in their prewarm).
- **Merge:** two circles that are the same project → `memory_circle_manage` `merge` (default `forceNew`).
- **Archive:** a circle with nothing active and no recent writes → `memory_circle_manage` `archive` (hidden from store-wide recall, not deleted; reversible with `unarchive`).

Rules of the road: `forceNew` is the default for every curation move — near-matches at the destination are kept distinct and linked with a `possible_duplicate_of` edge instead of merged, so **the duplicate count may rise before it falls**; that's by design — re-run Phase 2 on affected circles afterwards. There is no un-merge: a mistaken merge is repaired by archive-and-recreate plus re-homing, so propose merges conservatively. Apply confirmed proposals in batches and report each batch's per-item results.

## Phase 4 — Stale review

For each stale concept the overview surfaced: "Last confirmed [when]: [title] — still true?" Options: the user confirms (store a confirming observation), corrects (store with `kind: "correction"` — opens a dispute to mediate), or retires it (consolidate into a successor concept, or leave archived-by-staleness).

## Phase 5 — Report

Re-run `memory_overview` on affected circles. Report counts: synthesized, duplicate pairs mediated, concepts re-homed, circles renamed/merged/archived, stale concepts addressed, and any new `possibleDuplicates` queued for the next pass.

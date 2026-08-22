# Curate memory — the librarian ritual

Within-store reorganization: synthesize what's dirty, mediate duplicates, and reshape circle topology — deliberately, in user-confirmed batches. This is a different job from [`consolidate-memory.md`](consolidate-memory.md) (cross-source ingestion and retirement); run this one on a store that already holds your memory.

**Requires** a runtime exposing `memory_circle_manage` (`@team-monet/monet` ≥ 0.5.0) for the circle-topology moves in Phase 3. Phases 0–2 need ≥ 0.3.0 (`memory_list`, `memory_detach`, `possibleDuplicates`); on runtimes between 0.3.0 and 0.5.0, run phases 0–2 and skip Phase 3.

**The librarian rule:** reorganizing is safe because recall is store-wide — moving a memory changes its address, never its findability. But reshelve deliberately, at session boundaries, with the user steering — never mid-task, never silently. Circles are write-home/project locality; **topic organization belongs to the entity/edge graph, not to circles** — don't propose topic-taxonomy circles.

**Curation covers the normative layer too, not just concepts.** A store holds principles, rules and
the stages they bind to alongside its facts, and those have their own decay: a stage whose rules have
all died is inert, a rule the counts show read and not followed is a retirement candidate, and a
stage no agent has ever looked up may be aimed at a moment that does not occur. Surface those in the
same pass — they are cheaper to notice here than to discover when a rule turns out to govern nothing.

## When to run

- At the end of a long session
- On demand, when the user asks to tidy memory
- When `memory_overview` shows signals: open `possibleDuplicates`, several stale concepts, or gate exceptions and retirement candidates in the normative layer — or when `memory_circle_manage {action: "list"}` shows fragmentation (many small circles)

## Phase 0 — Read the state

`memory_overview` for: counts, `possibleDuplicates`, stale, and dirty. `memory_circle_manage {action: "list"}` for the circle list (per-circle concept counts and last activity). For any circle that looks fragmented or misplaced, `memory_list` with `withProvenance: true` — the working-dir paths each memory's observations were recorded under are the strongest signal of where it belongs. This evidence base grounds every proposal; no proposal without it.

## Phase 1 — Synthesize dirty concepts

For each dirty concept: `memory_fetch` → reconcile the observations into one coherent body → `memory_synthesize`. Do this BEFORE any reorganization: the synthesized body is what tells you whether two concepts are actually about the same thing.

## Phase 2 — Mediate possible duplicates

For each pair in `possibleDuplicates`: `memory_fetch` BOTH concepts and judge on bodies, never titles. Two verdicts:

- **Same concept (consolidate):** `memory_detach` the loser's observations into the keeper (`destConceptId`) — the loser is consolidated away and its name survives as an alias on the keeper.
- **Distinct concepts (keep both, ≥ 0.6.0):** call `memory_resolve` with `conceptAId` + `conceptBId` (omit `contradictionId` and `decision`) — the pair drains from `memory_overview.possibleDuplicates`; re-dismissing an already-dismissed pair returns `rowsUpdated: 0` (idempotent).

Work in batches of 3–5 pairs, pausing for confirmation between batches.

## Phase 3 — Propose circle reorganizations

Evidence first (Phase 0), then propose — each with its reasoning shown:

- **Re-home:** a concept whose provenance is exclusively another project's paths → `memory_reassign_circle` with `ids` (batch) and `resolution: "forceNew"`.
- **Rename:** a derived hash-name circle that's plainly one project → `memory_circle_manage` `rename`. The old name becomes a stable alias; sessions that derive it keep resolving (they'll see `resolvedFrom` in their prewarm).
- **Merge:** two circles that are the same project → `memory_circle_manage` `merge` (default `forceNew`).
- **Archive:** a circle with nothing active and no recent writes → `memory_circle_manage` `archive` (hidden from store-wide recall, not deleted; reversible with `unarchive`).

Rules of the road: `forceNew` is the default for every curation move — near-matches at the destination are kept distinct and linked with a `possible_duplicate_of` edge instead of merged, so **the duplicate count may rise before it falls**; that's by design — re-run Phase 2 on affected circles afterwards. There is no un-merge: a mistaken merge is repaired by archive-and-recreate plus re-homing, so propose merges conservatively. Apply confirmed proposals in batches and report each batch's per-item results.

## Phase 4 — Stale review

Staleness derives from `lastConfirmedAt` (≥ 0.6.0) — a concept is stale when its last evidence-based confirmation is older than the staleness window (~30 days by default), not merely when it was last edited. `memory_fetch` alone does NOT reset the clock; confirmation requires new evidence. To re-confirm a still-true stale concept, `memory_store` fresh confirming evidence — a cross-session attach refreshes `lastConfirmedAt` and clears the stale signal.

For each stale concept the overview surfaced: "Last confirmed [when]: [title] — still true?" Options: the user confirms (store a confirming observation — this refreshes `lastConfirmedAt`), corrects (store with `kind: "correction"` — opens a dispute to mediate), or retires it (consolidate into a successor concept, or leave archived-by-staleness).

## Phase 5 — Normative layer review

The normative layer decays on its own terms, and none of it shows in the concept counts — `memory_overview`'s gate exceptions and retirement candidates are the entry point. This phase needs a Monet whose `memory_overview` actually exposes that normative layer; if yours reports no such section (older releases don't), skip this phase or upgrade first. Three checks, each producing proposals the user confirms like everything else in this pass:

- **Decay:** conformance is answered per moment and counted per circle (`gate.conformance`), never per rule — cite the counts and let the user name the rule, never attribute. Per-rule evidence is `gate.retirementCandidates` (a model tag other than the one running) and `gate.unexplainedDenies`. A stage in `gate.unreadStages` has never been looked up: propose re-aiming it at a moment that occurs, or retiring it. A stage whose rules have all died is inert.
- **Shape:** a rule body carrying steps, a roster, a tool list, or a copy of another artifact is a procedure wearing a rule's clothes — the copy rots while the original moves on. Propose extraction: the how goes to an artifact the host loads on demand (a skill, a playbook file), and the rule shrinks to its constraint, the reason it exists, and a pointer to that artifact.
- **Pointers:** for every rule that names an artifact, verify the artifact still exists. A dangling pointer is a rule that reaches you pointing at nothing — repair the pointer or retire the rule.

Batch the proposals with their evidence — the counts, the offending rule body, the missing path — and apply only what the user confirms. Apply with the write surface that exists — and for a Shape extraction, order matters: write the procedure into its on-demand artifact and confirm it reads back BEFORE storing the successor, or the steps are gone while the pointer leads nowhere. A successor rule is `memory_store kind:"rule"` at the same stage (the acknowledgement's `ruleSuccession` records what it replaced); a retirement is `kind:"correction"` against the rule, then `memory_resolve` on the contradiction it opens; a re-aim is the successor at the right stage plus that retirement of the misaimed one. Read back with `stage_lookup` on each affected stage — the surviving roster is the check — and for an extraction, open the pointed-at artifact too.

## Phase 6 — Report

Re-run `memory_overview` on affected circles. Report counts: synthesized, duplicate pairs mediated, concepts re-homed, circles renamed/merged/archived, stale concepts addressed, and any new `possibleDuplicates` queued for the next pass.

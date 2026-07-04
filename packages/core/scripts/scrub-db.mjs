#!/usr/bin/env node
/**
 * scrub-db.mjs — Phase 1 corpus derivation, db-scrub parity stage (added after the initial 3-stage
 * pipeline landed via PR #35/bc3a449; hardened in a second round, PR #36, after a cold audit
 * BLOCKED the original 3-column-only version — see "AUDIT FINDINGS, ROUND 2" below).
 *
 * WHY THIS STAGE EXISTS (design decision, locked): the per-size derived stores under
 * eval-corpus/db/<size>/monet.db carry UNSCRUBBED concept/observation text (by design — see
 * eval-corpus/README.md's own layout table, "db/<size>/monet.db  # UNSCRUBBED"), while the A2 arm's
 * md-tree export (eval-corpus/publish/<size>/) IS scrubbed. That asymmetry is fine as long as
 * nothing downstream treats the raw db as publishable — but the eval this corpus feeds runs
 * MULTIPLE ARMS side by side (A2 steelman md-tree, A4 the real Monet engine over a seeded store),
 * and a fair engine-vs-md comparison requires every arm to see IDENTICAL underlying content. If A4
 * were pointed at the raw eval-corpus/db/<size>/monet.db while A2 reads the scrubbed
 * eval-corpus/publish/<size>/ tree, the two arms would not actually be comparing retrieval quality
 * over the same corpus — A4 would have strictly MORE information (unredacted emails/paths/secrets)
 * than A2, which is a confound, not a fair proof. This stage closes that gap: it produces a
 * SCRUBBED COPY of each per-size db (eval-corpus/db-scrubbed/<size>/monet.db) so an A4 run can point
 * MONET_STORAGE_DIR at content that has been through the exact same scrubString pass as the A2
 * arm's md-tree.
 *
 * ============================================================================================
 * AUDIT FINDINGS, ROUND 2 (this version) — the original version of this script scrubbed only
 * concepts.title/body + observations.content and claimed (wrongly — see the old "WHAT IS
 * SCRUBBED, AND WHY ONLY THIS" doc this replaces) that was the full engine read-surface. A cold
 * audit re-read src/engine.ts directly and found FIVE more surfaces with unscrubbed sensitive
 * text, THREE of which are read into a live A4 engine's own MCP-callable output today (not just
 * "exist in the db" — actually returned to a caller / rendered into the agent_context / prewarm
 * text block a real MCP session sees). Full enumeration, with the exact engine.ts/mcp-server.ts
 * read site for each, now lives in this script's "ENGINE READ-SURFACE ENUMERATION" section below
 * (the corrected replacement for this doc's old, false "only 3 columns reach agent context"
 * claim). Summary of what changed in this round:
 *
 *   1. contradictions.detail — SCRUBBED (rows kept; see getOpenContradictions engine.ts:1352-1362,
 *      read by mcp-server.ts:189 straight into the rendered prewarm block's "Open contradictions"
 *      section — a live agent_context reader sees this text verbatim, truncated only at 80 chars,
 *      not redacted; also returned FULL/untruncated in the memory_store and
 *      memory_flag_contradiction MCP tool responses, mcp-server.ts:541/826, and via
 *      flagContradiction's own `SELECT *`, engine.ts:1246).
 *   2. concepts.source_refs + observations.source_refs — JSON-AWARE scrub added: these columns
 *      store a JSON-serialized string[] (`JSON.stringify(sourceRefs)`, engine.ts:837/923/3080), not
 *      free prose — a blind scrubString() pass over the raw JSON text would still work today (JSON
 *      array syntax contains no character scrubString's patterns key off), but relies on that
 *      accidentally being true rather than parsing the structure, and provides no closure guarantee
 *      as the JSON shape evolves. Fixed to JSON.parse → scrubString each array element →
 *      JSON.stringify. Reaches a caller via toGatherCard (engine.ts:3653-3658,
 *      `sourceRefs: refs` on every GatherCard the A4 arm's gather() calls return).
 *   3. entities.surface (+ the matching entities.key / concept_entities.entity_key) — SCRUBBED.
 *      Investigated separately from surface (see ENTITY_KEY INVESTIGATION below): `entity_key` is
 *      NOT a hash/opaque id — for `kind: 'path'` entities it is literally `ref:<raw source ref>`
 *      (deriveEntityEdges, engine.ts:3009-3012) or `path:<raw surface text>` (extractEntities' key
 *      derivation, src/extract-entities.ts — verbatim, case-preserved for path/id/err kinds), so
 *      it carries the identical sensitive substrings `surface` does. It IS reachable independent
 *      of `surface`: topEntityHubs (engine.ts:2150-2176) returns BOTH `key` and `surface` directly
 *      in its `EntityHub[]` result (part of overview()'s "#245 what your agent knows" MCP surface),
 *      and topThread's label derivation (engine.ts:2258-2272, `label = surface` split straight out
 *      of a hub's key) derives a rendered label from the key even if surface alone were scrubbed.
 *      Fixed by scrubbing BOTH entities.key/entities.surface AND every
 *      concept_entities.entity_key row that references it, IN LOCKSTEP (keyed by the OLD key
 *      value, so the join between the two tables — `e.key = ce.entity_key`, a value-equality
 *      join, not a declared FK — is never broken; see this script's scrubEntities() for exactly
 *      how, including the merge-on-collision handling a scrub can introduce). Chose SCRUB over
 *      DELETE (the other option the mission raised) because a direct query shows 4156 of 4463
 *      path-kind entities carry no sensitive prefix at all (ordinary relative paths, version
 *      strings, proof-repo-generalized forms) — deleting every path-kind entity to remove the
 *      ~307-347 sensitive ones would destroy real, non-sensitive graph structure (about-edges,
 *      hub gating, co-membership) for the ~90% of path entities that aren't the problem.
 *      entity_key is used ONLY for exact-equality lookups everywhere in engine.ts (`WHERE key = ?`
 *      / `WHERE entity_key = ?` — grep confirms no LIKE/substring/parse usage anywhere) —
 *      scrubbing the string content is therefore safe for every read path; nothing depends on the
 *      key's literal unredacted bytes, only on row identity and join stability, both of which
 *      lockstep scrubbing preserves exactly.
 *   4. concept_revisions — now EMPTIED (DELETE all rows) in scrubbed copies, not scrubbed in
 *      place. Verified (grep across all of src/) that concept_revisions.body is read ONLY via
 *      `SELECT COUNT(*)` (engine.ts:1064, revision-count display) or DELETE (engine.ts:1896, 2618,
 *      3313 — detach/merge/rename cleanup) — never a body SELECT that returns to an application
 *      caller (the one bulk `SELECT *` elsewhere, src/eval/corpus-sample.ts:431, is the
 *      corpus-SAMPLING step that builds eval-corpus/db/<size>/monet.db in the first place —
 *      upstream of this script's own scrub boundary, not a live-engine read this stage needs to
 *      worry about). A derived eval corpus has no use for prior-version bodies (nothing in this
 *      pipeline or the eval it feeds reads revision history), so the safest and simplest fix is
 *      removing the rows entirely rather than scrubbing 127 rows of content nothing ever reads —
 *      this mirrors the exact precedent already set by this same pipeline: corpus-sample.ts
 *      already drops whole tables/rows it decides are out of scope rather than half-scrubbing
 *      unused columns.
 *   5. Future-proofing: first_block.summary and sessions.summary are 0 rows in the current corpus
 *      (this pipeline's sampling never populates first_block, and no session rows carry a summary
 *      — verified directly: `SELECT COUNT(*) FROM first_block` / `SELECT COUNT(*) FROM sessions
 *      WHERE summary IS NOT NULL` on the current derived dbs both return 0), and neither is read
 *      by any code path in src/engine.ts TODAY that returns it to a caller (first_block.summary
 *      IS read once a row exists — see below, it's the single highest-priority prewarm section;
 *      sessions.summary has no read site at all, write-only via endSession, engine.ts:~3798).
 *      Scrubbed unconditionally alongside the other known-sensitive columns below so a future
 *      corpus-sampling change that starts carrying either table over doesn't silently reopen a
 *      gap this same audit already found once for a sibling column — this is also exactly the
 *      kind of thing the new closure test (src/__tests__/scrub-db-closure.test.ts) exists to catch
 *      even if this list itself goes stale.
 *      IMPORTANT DISTINCTION from sessions.scope_context (also scrubbed, see enumeration below):
 *      scope_context is NOT merely future-proofing — it is ACTIVELY read today by listMemories()'s
 *      `withProvenance` option (engine.ts:1479-1486), a real, currently-documented MCP tool
 *      parameter (`memory_list`'s `withProvenance`, mcp-server.ts:596-602) that surfaces it
 *      verbatim as `MemoryListEntry.provenance`. It is 0 rows in this corpus only because this
 *      sampling pipeline happens not to populate `sessions` at all yet — the read path itself is
 *      live, not dormant, so scope_context is scrubbed on the SAME "this is a real surface" basis
 *      as contradictions.detail/source_refs/entities, not the weaker "just in case" basis
 *      first_block.summary/sessions.summary are scrubbed on.
 * ============================================================================================
 *
 * ============================================================================================
 * AUDIT FINDINGS, ROUND 3 (this version) — round 2 closed the "which COLUMNS leak sensitive text"
 * gap. A second cold audit (Codex, PR #36 review) found FOUR further findings that round 2's own
 * text-column scrub could not close: two are about round 2's OWN mechanism being unsound in ways
 * unrelated to which columns it scrubs (F4: the WAL-fidelity checkpoint itself mutated the input
 * artifact; F1: a raw-bytes scan of the OUTPUT file can still recover pre-scrub text from freed
 * SQLite pages, regardless of which columns were UPDATEd), one is a NEW leaking column round 2
 * never enumerated (F2: concepts.slug, derived from the RAW pre-scrub title and never
 * regenerated), and one is a data-integrity bug in round 2's own pruneStaleEntities fix (F3:
 * entities.df goes stale — too high — after a partial prune). A fifth (F5) is an operational safety
 * gap in argument handling, unrelated to scrub correctness but still a real risk to the
 * "copy-only, source untouched" guarantee this whole script exists to uphold. Summary:
 *
 *   F4. WAL checkpoint mutated the SOURCE (PR comment id 3522405282, P2). Round 2's WAL-fidelity
 *      fix opened `srcDbPath` itself read-write and ran `wal_checkpoint(TRUNCATE)` against it
 *      before copying — this rewrites the source file's own bytes and truncates its `-wal`
 *      sidecar, changing the SOURCE FILE's sha256 hash even though no row's logical content
 *      changed. That is a real violation of this pipeline's "original untouched" artifact-hash
 *      guarantee, not merely a row-content concern. FIXED: reorder so the copy (main file AND its
 *      `-wal`/`-shm` sidecars, if present) happens FIRST, then the CHECKPOINT runs against the
 *      COPY — `srcDbPath` is never opened for write anywhere in this script anymore. See this
 *      doc's "WAL FIDELITY" section above (rewritten for this round) for the full mechanism and
 *      why copying the sidecar files is safe.
 *   F1. Free-page remnants survive in the published file's raw bytes (PR comment id 3522115529,
 *      P1). This script starts from a byte copy of the raw source file, then redacts via in-place
 *      UPDATEs/DELETEs — SQLite never zeroes a page when a row is updated or deleted, so old
 *      payload bytes remain in freelist/overflow pages until something rewrites the file. A
 *      `strings dbfile | grep` (or any raw byte scan) of a pre-round-3 scrubbed output can recover
 *      the original email/path/secret text even though every live-row SELECT looks clean. FIXED:
 *      `VACUUM` the destination after every UPDATE/DELETE-based scrub step runs — VACUUM rebuilds
 *      the entire file from the live b-tree, which is the mechanism that drops freed pages
 *      (chosen over `PRAGMA secure_delete=ON` because secure_delete only prevents FUTURE
 *      free-space leakage from the point it's enabled forward — it does nothing about pages
 *      already freed by scrub operations that ran before it was turned on, and getting its
 *      enable-timing exactly right relative to every scrub function is more fragile than one
 *      unconditional VACUUM at the end). See `vacuumDb()` below and the new raw-bytes closure pass
 *      in scrub-db-closure.test.ts (`findRawByteViolations`) for the enforcement mechanism.
 *   F2. concepts.slug leaks a slugified fragment of the pre-scrub title (PR comment id 3522115532,
 *      P1). This script updates concepts.title but never touched concepts.slug, which the LIVE
 *      engine derives from the RAW title at create time (`slugify(title)`, engine.ts) and which is
 *      returned verbatim by every A4 read surface that returns a concept (toCard/toConcept, both
 *      include `.slug` — see the ENGINE READ-SURFACE ENUMERATION update below). A title containing
 *      an email/path/endpoint/key can leave a recognizable slugified fragment
 *      (`jane-doe-example-com`, `users-dev-...`) in the slug even after the title itself reads
 *      "[redacted-email]". FIXED: new `scrubConceptSlugs()` step regenerates every concept's slug
 *      from its ALREADY-SCRUBBED title, using a byte-verified mirror of engine.ts's own private
 *      `slugify()` (see `src/db-slugify.mjs`), with per-circle collision disambiguation matching
 *      the `md-export-store.ts` precedent (`-${conceptId}` suffix on collision).
 *   F3. entities.df goes stale after a PARTIAL prune (PR comment id 3522405281, P2). Round 2's
 *      `pruneStaleEntities` deletes stale `concept_entities` membership rows and deletes
 *      fully-orphaned `entities` rows, but never adjusts `df` for an entity that had SOME (not
 *      all) of its memberships pruned — e.g. `id:example.com` pruned from one concept (where it
 *      only existed because of a leaked email) but legitimately surviving in another (where it's
 *      genuine non-sensitive prose) ends up with a `df` that's too high relative to its real
 *      remaining membership count. `topEntityHubs()` uses `df` for hub gating/ranking
 *      (engine.ts), so a stale df can mis-rank or hide a surviving entity. FIXED: recompute every
 *      surviving entity's `df` from its ACTUAL remaining `concept_entities` row count, in the same
 *      transaction, after all per-concept pruning is done — reusing the identical
 *      GROUP-BY-then-loop-UPDATE idea `src/eval/corpus-sample.ts`'s `materializeSampledDb` already
 *      established for the same "df must reflect ground truth, not a copied-forward count" reason.
 *   F5. No guard against `--out` overlapping `--db` (PR comment id 3522115534, P2). `main()` runs
 *      `rmSync(outDir, { recursive: true, force: true })` before ever reading `dbDir`, with no
 *      check that the two resolved paths are disjoint. A caller passing an overlapping pair (e.g.
 *      `--out=eval-corpus/db`, a parent of `--db`, or a path INSIDE `--db`) would destroy some or
 *      all of the source derived dbs before this script ever gets to copy them — the exact
 *      opposite of the "copy-only, source untouched" guarantee this whole script exists to uphold.
 *      FIXED: `assertNoOverlap(dbDir, outDir)` runs before any destructive operation, rejecting
 *      equal paths, `outDir` as an ancestor of `dbDir`, AND `outDir` as a descendant of `dbDir`
 *      (the latter direction matters too — see `assertNoOverlap`'s own doc comment for why a
 *      descendant `--out` is a distinct, real correctness bug, not just "suspicious"). Uses the
 *      same `path.relative`-based strict-containment IDIOM `src/eval/corpus-sample.ts`'s
 *      `assertSafeToWipe` already established (NOT that exact function unchanged — `assertSafeToWipe`
 *      checks containment against a fixed `repoRoot/eval-corpus` root, a different invariant than
 *      "these two specific --db/--out paths must not overlap each other").
 * ============================================================================================
 *
 * ============================================================================================
 * AUDIT FINDINGS, ROUND 4 (this version) — a FOURTH cold-audit pass (Codex, PR #36 review) found
 * THREE further findings after round 3 landed (commit 87fa738). Two are new leaking surfaces round 3
 * never enumerated (G1: concepts.aliases carries pre-scrub slug fragments from merge history; G2:
 * observations.author_agent_id is an uncovered TEXT column), one is a correctness bug in round 3's
 * OWN F2 fix (G3: a disambiguated slug can exceed the engine's 60-char slugify() cap and become
 * unresolvable). Summary:
 *
 *   G1. concepts.aliases carries pre-scrub slug fragments from merge history (PR comment id
 *      3522728463, P1). mergeConceptInto (engine.ts, run when reassignCircle's own dedup decides two
 *      concepts should merge) writes the ABSORBED concept's slug (derived from the absorbed
 *      concept's RAW, pre-scrub title) plus its id into the SURVIVOR's `aliases` column:
 *      `[...new Set([...existing, ...src.aliases, src.slug, src.id])]`, JSON-serialized, written
 *      unconditionally once ANY merge has ever happened to that row (never re-nulled). Round 3's
 *      scrubConceptSlugs only regenerates the SURVIVOR's own current `slug` from the survivor's OWN
 *      scrubbed title — it never touches `aliases`, which keeps carrying the absorbed concept's OLD
 *      raw-title-derived slug forever (e.g. "jane-doe-example-com" — a slugified form that dodges
 *      every scrubString pattern, since slugify() has already turned the punctuation those patterns
 *      key off, like `@`/`./`/`, into plain hyphens). This is a LIVE read surface, not dead data:
 *      resolveRef (engine.ts) does an explicit "alias fallback" — `SELECT id, aliases FROM concepts
 *      WHERE circle = ? AND id != ? AND aliases IS NOT NULL`, then checks
 *      `list.includes(ref) || list.includes(slug)` — used by every `supports: #ref`/`resolves: #ref`
 *      resolution a caller can trigger. FIXED: new `clearConceptAliases()` step sets `aliases` to SQL
 *      NULL (the engine's OWN "no aliases" representation — every alias-fallback guard in engine.ts
 *      checks `aliases IS NOT NULL`, never `aliases != '[]'`) in every row that currently has a
 *      non-null value. NULL, not a scrubbed-in-place JSON array, is the parity-correct choice: the
 *      absorbed concepts' scrubbed titles no longer exist anywhere to regenerate a matching alias
 *      from (mergeConceptInto's own `DELETE FROM concepts WHERE id = ?` on the absorbed row already
 *      removed them), and the A2 md-tree arm this scrubbed db must stay in parity with has no
 *      merge-history alias mechanism at all. See `clearConceptAliases()` below for the implementation.
 *   G2. observations.author_agent_id is an uncovered TEXT column (PR comment id 3522728464, P2).
 *      `author_agent_id TEXT NOT NULL` (schema, engine.ts) is written at store time from
 *      `this.agentId` (engine.ts) — a MonetCore CONSTRUCTOR option (`MonetCoreOptions.agentId`,
 *      engine.ts) set ONCE per instance and stamped onto every observation that instance writes, NOT
 *      a per-`store()`-call parameter. This repo's own derived corpus only ever uses the default
 *      (`"local-agent"`, engine.ts), which is benign — but the column has no format constraint
 *      anywhere in the engine, so a caller-supplied `agentId` (an email, a path, a key-shaped string)
 *      would land in every observation row that instance ever writes, and
 *      `scrubConceptsAndObservations`'s SELECT/UPDATE never named this column at all. `getAgentId()`
 *      (engine.ts) only returns the CURRENT instance's own agentId — it does not read historical
 *      `author_agent_id` values back out of the db, so there is no live per-observation READ site
 *      returning this column verbatim today, but this stage's closure guarantee is "every TEXT column
 *      that reaches an agent context", scrubbed defensively regardless of today's exact reachability
 *      (same future-proofing precedent already established for first_block.summary/sessions.summary,
 *      round 2 finding #5). FIXED: `scrubConceptsAndObservations` now also reads/scrubs/writes
 *      `author_agent_id` with `scrubString`, identically to `content`.
 *   G3. A disambiguated slug can exceed the engine's 60-char slugify() cap and become unresolvable
 *      (PR comment id 3522728466, P2). engine.ts's `slugify` (mirrored byte-for-byte in
 *      src/db-slugify.mjs) hard-caps output at 60 chars: `.slice(0, 60)`. resolveRef (engine.ts) does
 *      `const slug = slugify(ref)` THEN looks up `WHERE slug = ?` — every `#ref` a caller passes gets
 *      independently re-slugified through this SAME 60-char truncation before the lookup runs. Round
 *      3's scrubConceptSlugs, on a collision, built `finalSlug = `${baseSlug}-${row.id}`` —
 *      `baseSlug` is already <= 60 chars, but `row.id` is a full randomUUID() (36 chars), so
 *      `finalSlug` could reach 60 + 1 + 36 = 97 chars, written to `concepts.slug` with NO further
 *      truncation. A 97-char value is NOT a fixed point of slugify(): if a caller later did
 *      `supports: #<that-exact-97-char-slug>`, resolveRef's own `slugify(ref)` step would SLICE IT TO
 *      60 CHARS, producing a different string than the 97-char value actually stored — the
 *      `WHERE slug = ?` lookup would never match, permanently unresolvable via the normal ref-lookup
 *      path. FIXED: cap the disambiguator to an 8-char id fragment (`row.id.slice(0, 8)`,
 *      git-short-hash-style) and truncate `baseSlug` itself so `truncatedBase + "-" + fragment` never
 *      exceeds 60 chars total, making `finalSlug` a genuine fixed point of slugify() by construction.
 *      See `scrubConceptSlugs()`'s own doc comment (below) for the exact arithmetic, the empty-base
 *      edge case, and the documented (accepted, not silently ignored) second-order-collision judgment
 *      call.
 * ============================================================================================
 *
 * ============================================================================================
 * AUDIT FINDINGS, ROUND 5 (this version) — a FIFTH cold-audit pass (Codex, PR #36 review, pass 4)
 * found TWO further findings in the SAME "caller-supplied actor identifier" family round 4's G2 fix
 * (observations.author_agent_id) closed defensively: H1 is a column round 4 should have caught
 * alongside author_agent_id but didn't (the identical agentId value lands in TWO columns, only one
 * of which was scrubbed); H2 is a related-but-distinct family of caller-supplied identifiers
 * (audit/resolution labels, not the session-authorship label G2 covers) that this stage never
 * enumerated at all. Summary:
 *
 *   H1. sessions.agent_id carries the SAME caller-supplied agentId as observations.author_agent_id,
 *      uncovered by round 4's G2 fix (PR comment id 3522770783, P2). `sessions.agent_id TEXT NOT
 *      NULL` (schema, engine.ts) is stamped from the identical `this.agentId` constructor option
 *      (`MonetCoreOptions.agentId`, engine.ts) that observations.author_agent_id is stamped from —
 *      the SAME hostile-shaped value (an email, a /Users/ path, a key-shaped string) that G2's fix
 *      scrubbed off the observation copy was, until this fix, left completely untouched on the
 *      session copy, since scrubFutureProofedColumns' own SELECT/UPDATE against `sessions` never
 *      named `agent_id` (only `summary`/`scope_context`). Reachability is identical to G2's own: no
 *      live per-session READ site returns `agent_id` back out of the db verbatim to a caller today
 *      (verified — no `SELECT agent_id FROM sessions` anywhere in src/ outside engine.ts's own
 *      session-lifecycle bookkeeping), and `sessions` itself is 0 rows in every size of this corpus
 *      today (this pipeline has no path that populates it — the materializer never writes session
 *      rows, confirmed directly: `SELECT COUNT(*) FROM sessions` against every real
 *      eval-corpus/db/<size>/monet.db returns 0). This is 0-rows-today defensive closure on the
 *      EXACT same future-proofing basis as this function's existing sessions.summary/
 *      scope_context handling — not a live leak, but the identical column-completeness gap G2 was
 *      supposed to close and didn't, since G2 only extended `scrubConceptsAndObservations` (the
 *      `observations` table), never `scrubFutureProofedColumns` (the `sessions` table). FIXED:
 *      `scrubFutureProofedColumns`'s sessions SELECT/UPDATE now also reads/scrubs/writes `agent_id`
 *      with `scrubString`, identically to `summary`/`scope_context` (no null-guard needed —
 *      `agent_id` is `NOT NULL`, unlike its two siblings).
 *   H2. Caller-provided audit/resolution labels persist unscrubbed in three columns this stage never
 *      enumerated at all (PR comment id 3522770784, P2): contradictions.resolved_by,
 *      memory_edge.dismissed_by, first_block.promoted_by. All three are a DIFFERENT caller-supplied-
 *      identifier family than G2/H1 above (a session-scoped agentId set ONCE at MonetCore
 *      construction and stamped onto every row that instance writes) — these are PER-ACTION labels,
 *      supplied fresh on each individual resolve/dismiss/promote call: `resolvedBy`
 *      (resolveContradiction's `opts.by`, mcp-server.ts's `resolvedBy` tool field, engine.ts),
 *      `dismissedBy` (dismissPossibleDuplicate's own param, engine.ts, same mcp-server.ts
 *      `resolvedBy` field routed through the duplicate-pair-dismissal branch), and `promotedBy`
 *      (promoteToFirstBlock's `opts.promotedBy`, mcp-server.ts's dedicated `promotedBy` tool field).
 *      None of the three has ANY format constraint in the engine — a caller can pass literally any
 *      string. UNLIKE sessions.agent_id/observations.author_agent_id (both 0 rows in this corpus
 *      today), contradictions.resolved_by and memory_edge.dismissed_by are NOT hypothetical: this
 *      repo's own real corpus already carries live, non-placeholder values in both — verified
 *      directly against eval-corpus/db/full/monet.db (56 contradictions, 21546 memory_edge rows):
 *      `resolved_by` has 6 distinct non-null values including "John (standing order, 2026-06-27)",
 *      "John (standing order extended, 2026-06-29)", "Stig", "stig", "local-agent", and
 *      "stig-curation-2026-06-17"; `dismissed_by` has 4, including "stig-curation-2026-06-17",
 *      "Stig", "stig", and "Stig (curate-memory ritual, 2026-06-13)". None of these happen to be
 *      email/path/secret-shaped, so scrubString is a correctly-behaving NO-OP on them today (nothing
 *      in scrubString's pattern set is meant to catch a bare name or a free-text parenthetical
 *      annotation) — but the column itself has no shape constraint, so a future caller-supplied
 *      label of any of those hostile shapes would flow straight through unscrubbed if this column
 *      were left uncovered, exactly the gap this fix closes. `first_block.promoted_by`, by contrast,
 *      IS 0 rows today (first_block itself is 0 rows in this corpus, same basis as
 *      first_block.summary) — grouped with the other two as the third member of the same
 *      caller-supplied-audit-label family, not because it shares their live-data character.
 *      REACHABILITY, verified directly rather than assumed: getOpenContradictions (engine.ts:1352,
 *      the actual prewarm/agent_context read for contradictions) selects only
 *      id/conceptId/conceptTitle/kind/detail — never resolved_by. flagContradiction's own
 *      `toContradiction(contraRow)` return (engine.ts:1248), the one call site that DOES map a
 *      `resolvedBy` field onto a `Contradiction` object, only ever fires on a freshly-INSERTed
 *      'open'-status row (resolved_by is NULL by construction at that point — a contradiction cannot
 *      be resolved before it exists). resolveContradiction's own MCP-visible return (mcp-server.ts:
 *      885) is a concept-shaped object (conceptId/status/version/confidence) — never the
 *      Contradiction/resolvedBy shape. getFirstBlock (engine.ts:2748, the actual prewarm firstBlock
 *      read) selects only id/conceptId/summary/summaryDirty/position/conceptStatus — never
 *      promoted_by. memory_edge is never read by mcp-server.ts at all — topEntityHubs/topThread
 *      (the "#245 what your agent knows" overview surface) read only entities/concept_entities,
 *      never memory_edge rows or its dismissed_at/dismissed_by columns. So, same as G2/H1: no live
 *      verbatim-read-to-caller path today for any of the three, closed defensively on the "no shape
 *      constraint on a caller-suppliable value" basis this stage has used since round 2's
 *      first_block.summary/sessions.summary precedent, not because a live read site returns them.
 *      FIXED: `scrubFutureProofedColumns` now also reads/scrubs/writes contradictions.resolved_by
 *      and memory_edge.dismissed_by (each its own SELECT/UPDATE, since they're different tables from
 *      first_block/sessions), and first_block.promoted_by (folded into that table's existing
 *      SELECT/UPDATE alongside summary).
 * ============================================================================================
 *
 * ENGINE READ-SURFACE ENUMERATION (replaces this doc's old, FALSE "only concepts.title/body +
 * observations.content reach agent context" claim — corrected per audit finding #5 above). Every
 * column an A4-arm MonetCore instance can return to an MCP caller today, with its exact read site:
 *
 *   - concepts.title, concepts.body       → search()/gather() cards (toCard) and the rendered
 *                                            prewarm block's "Top concepts"/workstream lines
 *                                            (mcp-server.ts:167-181).
 *   - concepts.slug                       → toCard (engine.ts:3864-3875, returns `.slug` directly
 *                                            on every SearchCard) and toConcept (engine.ts:3808-
 *                                            3824, returns `.slug` directly on every Concept) —
 *                                            i.e. every search()/getConcept()/listMemories() result.
 *                                            ROUND 3 FINDING (F2): this column is derived from the
 *                                            RAW pre-scrub title at creation time
 *                                            (`slugify(title)`, engine.ts) and round 2 never
 *                                            regenerated it after scrubbing `title` itself — a
 *                                            title containing an email/path/endpoint/key can leave
 *                                            a recognizable slugified fragment in `slug` even
 *                                            after `title` reads "[redacted-email]". Fixed by
 *                                            `scrubConceptSlugs()` (this round) — see "AUDIT
 *                                            FINDINGS, ROUND 3", F2, above. ROUND 4 FINDING (G3): the
 *                                            fixed slug's own DISAMBIGUATED form (on collision) could
 *                                            itself exceed slugify()'s 60-char cap, making it
 *                                            unresolvable via resolveRef's own re-slugify-then-lookup
 *                                            path — fixed by capping the disambiguator to an 8-char
 *                                            id fragment, see "AUDIT FINDINGS, ROUND 4", G3, above.
 *   - concepts.aliases                    → resolveRef's "alias fallback" (engine.ts:3182-3200,
 *                                            `SELECT id, aliases FROM concepts WHERE ... aliases IS
 *                                            NOT NULL`, `JSON.parse` + `list.includes(ref) ||
 *                                            list.includes(slug)`) — used by every `supports: #ref` /
 *                                            `resolves: #ref` resolution. ROUND 4 FINDING (G1):
 *                                            mergeConceptInto (engine.ts:3256-3265) writes the
 *                                            ABSORBED concept's RAW-title-derived slug + id into the
 *                                            survivor's aliases on every merge; round 3's
 *                                            scrubConceptSlugs never touched this column, leaving the
 *                                            absorbed concept's old leaky slug fragment permanently in
 *                                            place. Fixed by `clearConceptAliases()` (this round) — see
 *                                            "AUDIT FINDINGS, ROUND 4", G1, above.
 *   - observations.content                → returned by any observation-listing path and is the
 *                                            literal text `store()` embeds/indexes.
 *   - observations.author_agent_id        → no live per-observation READ site returning this column
 *                                            verbatim today (`getAgentId()`, engine.ts:1510-1512,
 *                                            returns only the CURRENT instance's own agentId, not a
 *                                            historical row read) — scrubbed defensively regardless,
 *                                            same future-proofing basis as first_block.summary/
 *                                            sessions.summary below (ROUND 4 FINDING G2: a
 *                                            constructor-supplied `MonetCoreOptions.agentId`,
 *                                            engine.ts:391/479, has no format constraint and is
 *                                            stamped onto every observation an instance writes,
 *                                            engine.ts:850-853).
 *   - contradictions.detail               → getOpenContradictions (engine.ts:1352-1362), included
 *                                            in PrewarmState.openContradictions, rendered VERBATIM
 *                                            (only .slice(0, 80)) into the prewarm block's "Open
 *                                            contradictions" section (mcp-server.ts:184-192); also
 *                                            returned FULL/untruncated via flagContradiction's own
 *                                            `SELECT *` (engine.ts:1246) in the memory_store and
 *                                            memory_flag_contradiction MCP responses
 *                                            (mcp-server.ts:541, 826). This is a live
 *                                            agent_context/prewarm AND direct-response surface,
 *                                            not an internal-only column.
 *   - concepts.source_refs,
 *     observations.source_refs            → toGatherCard (engine.ts:3653-3658) attaches
 *                                            concepts.source_refs to every GatherCard returned by
 *                                            gather()/memory_gather; store()/backfillGraph read
 *                                            observations.source_refs to recompute the concept-level
 *                                            aggregate (engine.ts:913-929, 3069-3080) which then
 *                                            flows through the same toGatherCard path. Also becomes
 *                                            a synthetic entities.surface/entity_key value verbatim
 *                                            (deriveEntityEdges, engine.ts:3012).
 *   - entities.surface, entities.key,
 *     concept_entities.entity_key         → topEntityHubs (engine.ts:2150-2176, returns `key` AND
 *                                            `surface` directly as EntityHub[]), conceptsForEntity
 *                                            (engine.ts:2277-2286), and topThread's cluster-label
 *                                            derivation (engine.ts:2258-2272, splits a surface back
 *                                            out of a hub's `key`) — all part of the "#245 what your
 *                                            agent knows" overview MCP surface (engine.ts:2142
 *                                            section header, exposed via `overview()`/agent_context
 *                                            and the CLI's render-overview.ts), a real, callable
 *                                            read path.
 *   - first_block.summary                 → getFirstBlock, included in PrewarmState.firstBlock,
 *                                            rendered FIRST and UNTRUNCATED into the prewarm block
 *                                            (mcp-server.ts:133-143) — the single highest-priority
 *                                            section of the entire prewarm surface. 0 rows in this
 *                                            corpus today; scrubbed as future-proofing (finding #5).
 *   - sessions.scope_context              → listMemories()'s `withProvenance` path
 *                                            (engine.ts:1474-1493) joins observations→sessions and
 *                                            surfaces scope_context verbatim as
 *                                            `MemoryListEntry.provenance` — a documented,
 *                                            currently-live memory_list tool parameter
 *                                            (mcp-server.ts:596-602), not dormant. 0 rows in this
 *                                            corpus only because this pipeline doesn't populate
 *                                            `sessions` — the read path itself is active.
 *   - sessions.summary                    → NOT currently read by any path in src/engine.ts that
 *                                            returns it to a caller (write-only via endSession) —
 *                                            0 rows in this corpus; scrubbed purely as
 *                                            future-proofing (finding #5), same basis as
 *                                            first_block.summary.
 *   - sessions.agent_id                   → NOT currently read by any path that returns it to a
 *                                            caller — 0 rows in this corpus (same as above); scrubbed
 *                                            purely as future-proofing, ROUND 5 FINDING (H1): the
 *                                            SAME caller-supplied agentId as
 *                                            observations.author_agent_id (round 4, G2), uncovered
 *                                            because G2 only extended scrubConceptsAndObservations,
 *                                            never this function. Fixed here — see "AUDIT FINDINGS,
 *                                            ROUND 5", H1, above.
 *   - contradictions.resolved_by          → getOpenContradictions (engine.ts:1352-1362, the live
 *                                            prewarm/agent_context read) never selects this column;
 *                                            flagContradiction's toContradiction return
 *                                            (engine.ts:1248) always fires pre-resolution (NULL by
 *                                            construction); resolveContradiction's own MCP return
 *                                            (mcp-server.ts:885) is concept-shaped, never includes
 *                                            resolvedBy. No live verbatim-read-to-caller path today —
 *                                            but ROUND 5 FINDING (H2): unlike sessions.agent_id/
 *                                            author_agent_id, this column is NOT 0 rows — the real
 *                                            corpus already carries live values like "John (standing
 *                                            order, 2026-06-27)" (verified directly, see "AUDIT
 *                                            FINDINGS, ROUND 5" H2 above for the full distinct-value
 *                                            list). Scrubbed defensively regardless — the column has
 *                                            no format constraint, so a future hostile-shaped label
 *                                            would flow straight through if left uncovered.
 *   - memory_edge.dismissed_by            → never read by mcp-server.ts at all — topEntityHubs/
 *                                            topThread (the "#245 what your agent knows" overview
 *                                            surface) read only entities/concept_entities, never
 *                                            memory_edge rows. No live verbatim-read-to-caller path
 *                                            today. ROUND 5 FINDING (H2): same non-zero-today
 *                                            character as contradictions.resolved_by above (real
 *                                            values like "Stig (curate-memory ritual, 2026-06-13)" —
 *                                            see "AUDIT FINDINGS, ROUND 5" H2 for the full list).
 *                                            Scrubbed defensively on the same no-format-constraint
 *                                            basis.
 *   - first_block.promoted_by             → getFirstBlock (engine.ts:2748-2761, the actual prewarm
 *                                            firstBlock read) never selects this column. 0 rows in
 *                                            this corpus (first_block itself is 0 rows today).
 *                                            ROUND 5 FINDING (H2): grouped with resolved_by/
 *                                            dismissed_by as the third member of the same
 *                                            caller-supplied-audit-label family; scrubbed on the
 *                                            same future-proofing basis as first_block.summary.
 *
 *   - concept_revisions.body               → NEVER reaches a caller (COUNT/DELETE only, finding #4
 *                                            above) — EMPTIED rather than scrubbed.
 *
 * WHAT IS SCRUBBED, full list, 3-column (round 1) → round 2's set → round 3's set → round 4's set →
 * this round's (round 5) set:
 *   concepts.title, concepts.body, concepts.source_refs (JSON-aware), concepts.slug (round 3,
 *     regenerated from the scrubbed title — see scrubConceptSlugs), concepts.aliases (round 4, G1,
 *     CLEARED to NULL rather than scrubbed in place — see clearConceptAliases)
 *   observations.content, observations.source_refs (JSON-aware), observations.author_agent_id
 *     (round 4, G2)
 *   contradictions.detail, contradictions.resolved_by (round 5, H2 — future-proofing/audit-label
 *     defensive scrub, see scrubFutureProofedColumns)
 *   memory_edge.dismissed_by (round 5, H2 — same defensive scrub, see scrubFutureProofedColumns)
 *   entities.surface, entities.key (lockstep with concept_entities.entity_key)
 *   first_block.summary, first_block.promoted_by (round 5, H2)
 *   sessions.summary (future-proofing, 0 rows today), sessions.scope_context (actively read today
 *     via withProvenance, 0 rows in this corpus only because sessions isn't populated yet),
 *     sessions.agent_id (round 5, H1 — future-proofing, 0 rows today)
 * EMPTIED (DELETE all rows): concept_revisions.
 * CLEARED TO NULL (round 4, G1): concepts.aliases.
 * VACUUM'd (round 3, F1): the destination db is VACUUM'd after every scrub step above runs, to
 *   remove freed-page remnants of pre-scrub content that a plain UPDATE/DELETE leaves on disk —
 *   see vacuumDb() below and "AUDIT FINDINGS, ROUND 3", F1, above.
 * Everything else (embedding columns, circle_aliases, every other column on the tables above —
 * memory_edge's OWN non-dismissed_by columns: src_id/src_type/dst_id/dst_type/type/weight/origin/
 * count/created_at/last_reinforced_at/scope/dismissed_at) is left byte-for-byte untouched by an
 * explicit UPDATE — a plain file copy already preserves it, and no UPDATE statement below names it.
 * (Note: this repo's real schema — verified directly against src/engine.ts's init()/migrate(), which
 * is the ONLY schema source, there is no separate migrations directory — has no `remote_circle_map`
 * table; an earlier draft of this script's doc comment named one by mistake. It does not exist here
 * and is not part of this script's contract.)
 *
 * WHY NOT MonetCore.store() (explicit, load-bearing constraint from the mission, unchanged from
 * round 1): re-ingesting scrubbed text through the engine's own store() path would re-run
 * dedup/synthesis/contradiction detection against content that no longer matches the
 * embeddings/edges/support_count history already baked into the db — store() is a MUTATION path
 * (new revisions, possible merges, usefulness scoring, re-derived title/slug), not a
 * content-substitution path. Using it here would silently change WHICH concepts exist and how
 * they're connected, not just what their text says — exactly the kind of structural drift this
 * stage must not introduce. Raw UPDATEs of specific TEXT columns, run directly against the sqlite
 * file via better-sqlite3, is the only operation that scrubs content while leaving every
 * structural invariant (row identity, edge graph, revision history, embeddings) untouched. The
 * one exception — concept_revisions — is emptied via DELETE, not UPDATE, exactly because nothing
 * downstream (per finding #4) depends on the presence OR content of those rows; deleting is a
 * structural no-op from the engine's perspective (a fresh MonetCore.init() creates the table
 * empty, and it only ever grows again via writeRevision at store-time — an eval run over a
 * scrubbed copy never calls that path).
 *
 * ENTITY_KEY INVESTIGATION (see audit finding #3 above for the summary; this is the full record).
 * Question: does entity_key carry the same sensitive strings surface does, and if so is it
 * reachable independent of surface? Evidence gathered directly against engine.ts and the schema:
 *   - Schema (engine.ts init(), CREATE TABLE entities / concept_entities): `entities` has PK
 *     (key, scope); `concept_entities` has its own `entity_key` column with PK
 *     (concept_id, entity_key, scope) and NO declared FOREIGN KEY anywhere in the schema
 *     (confirmed: `FOREIGN KEY` does not appear in src/engine.ts at all) — the two tables are
 *     linked by ORDINARY VALUE EQUALITY (`JOIN entities e ON e.key = ce.entity_key AND e.scope =
 *     ce.scope`, e.g. engine.ts:2166), i.e. concept_entities.entity_key is a DENORMALIZED COPY of
 *     entities.key, not a foreign key SQLite enforces — both must be updated together by hand, or
 *     the join silently stops matching, and (separately) concept_entities itself carries its OWN
 *     copy of the raw sensitive text independent of whatever entities.surface says.
 *   - upsertEntity (engine.ts:3139-3151) INSERTs the SAME string into concept_entities.entity_key
 *     and entities.key: `db.prepare('INSERT OR IGNORE INTO concept_entities ... entity_key) VALUES
 *     (?, ?, ?)').run(conceptId, key, scope)` immediately followed by
 *     `INSERT INTO entities (key, ...) VALUES (?, ...)` with the SAME `key` variable — confirms
 *     the two columns are always written as the identical string, by construction.
 *   - deriveEntityEdges (engine.ts:3009-3012): `for (const ref of sourceRefs) ents.push({ key:
 *     `ref:${ref}`, kind: "path", surface: ref, weight: 3 })` — a path-kind entity's `key` is
 *     LITERALLY the raw, unscrubbed source ref with a `ref:` prefix. extractEntities (imported
 *     from ./extract-entities) similarly derives `path:`-prefixed keys directly from raw surface
 *     text, verbatim and case-preserved, for structural path mentions found in body/content.
 *     CONFIRMED by direct query against the current corpus: `entities.key =
 *     'ref:/Users/dev/.claude/CLAUDE.md'` for real rows — the raw absolute path is the key,
 *     verbatim, not any hashed/normalized form.
 *   - Read-time usage, exhaustively grepped: every entity_key/entities.key read in engine.ts is an
 *     EXACT-MATCH lookup (`WHERE key = ?`, `WHERE entity_key = ?` / equi-joins) — coMembers,
 *     isHub, rarity, conceptsForEntity, the rehome/rename paths. None of them pattern-match,
 *     substring-search, or parse the key's content — they only ever compare it for EQUALITY or use
 *     it as an opaque grouping/join key. This means scrubbing the key's TEXT content cannot break
 *     any read path: every lookup that worked before (matching the OLD unscrubbed key) will work
 *     identically after, as long as the SAME scrub is applied consistently to both entities.key
 *     and every concept_entities.entity_key row that pointed at it (which is exactly what
 *     scrubEntities() below does, keyed by old value, in one pass).
 *   - Reachability: topEntityHubs (2150-2176) returns `key` and `surface` DIRECTLY in its
 *     `EntityHub[]` result — a live, callable read path (the "#245 what your agent knows"
 *     overview), not just db-internal bookkeeping. topThread additionally derives a cluster-label
 *     BY SPLITTING A HUB'S KEY (`key.split(':').slice(1).join(':')`, engine.ts:2258-2272) — so even
 *     if `surface` alone were scrubbed and `key` were left raw, the raw key string could still leak
 *     into a rendered label via this exact code path. This is the concrete proof entity_key needed
 *     handling as a FIRST-CLASS surface, not an afterthought to entities.surface.
 *   VERDICT: entity_key is reachable, carries the identical sensitive substrings as surface, is
 *   used only for equality/join (never parsed), and 90%+ of path-kind rows are legitimately
 *   non-sensitive — so the correct fix is SCRUB entities.key + concept_entities.entity_key in
 *   lockstep (never delete), reusing the exact same scrubString the other columns use, keyed by
 *   old-value so every concept_entities row referencing a rescrubbed entities.key is updated to
 *   match. See scrubEntities() below for the implementation, including how a scrub-induced
 *   collision (two distinct raw keys scrubbing to the same string) is merged rather than left to
 *   throw a raw primary-key-violation error.
 *
 * ENTITY FRAGMENT LEAK (a SIXTH finding, beyond the mission's 5 locked directives — found while
 * verifying scrubEntities' own coverage against the real corpus, not something the original audit
 * enumerated; documented in full here rather than silently left uncaught). scrubEntities closes
 * the leak for entities whose SURFACE TEXT is itself pattern-matchable (a full path, a private
 * endpoint). It does NOT close a narrower but real gap: entities.mjs's extractEntities (imported
 * by engine.ts, mirrored here as src/extract-entities.mjs — see that file's own doc comment) runs
 * against RAW body/content text at store time and can split a sensitive multi-token string into
 * SEPARATE single-token entities before any scrub pattern ever sees them. Verified directly, not
 * assumed: `extractEntities("contact jane.doe@example.com about the deploy")` produces TWO
 * separate `id`-kind entities — `id:jane.doe` and `id:example.com` — via the DOTTED regex, NEITHER
 * of which contains an "@" for EMAIL_RE to match individually; `extractEntities("...tenant
 * acme...")` produces a bare `noun:acme` entity with no adjacent IP octets for
 * PRIVATE_ENDPOINT_RE's tenant-clause capture to fire on. Confirmed against the REAL corpus (not
 * just a synthetic example): `entities.surface = "gmail.com"` (kind=id) survives scrubEntities
 * untouched in this repo's actual eval-corpus/db-scrubbed/full/monet.db, because "gmail.com" alone
 * matches no scrub pattern — the sensitivity only existed in the ORIGINAL combined string, which
 * the extractor had already atomized before scrubEntities ever ran.
 *
 * FIX: pruneStaleEntities (below) re-runs the SAME extraction (via the .mjs mirror) against each
 * concept's ALREADY-SCRUBBED text (scrubbed body + scrubbed observation contents, joined — the
 * same text-assembly convention engine.ts's own rederiveConceptGraph uses) plus scrubbed
 * source_refs, and compares the resulting key set against what's still attached in
 * concept_entities. A membership whose key does NOT reappear in the fresh, scrubbed-text
 * extraction is stale (e.g. "[redacted-email]" extracts to harmless generic nouns like
 * `noun:redacted`/`noun:email` instead of `id:jane.doe`/`id:example.com`) and is pruned; an
 * entities row left with zero members after pruning is deleted. This is deliberately narrower than
 * a full re-derivation (deriveEntityEdges/rederiveConceptGraph) — it only PRUNES stale membership,
 * never inserts a new edge/membership, never touches memory_edge or df beyond what pruning
 * naturally implies — keeping it a pure closure-tightening pass, not a structural rebuild (the
 * same "why not MonetCore.store()" concern this script's module doc already raises for the other
 * columns).
 *
 * ACCEPTED, DOCUMENTED LIMITATION: pruneStaleEntities is exact and mechanical (a fresh extraction
 * of the scrubbed text either reproduces a given entity key or it doesn't), not a semantic judgment
 * about which bare words are "sensitive enough" — it cannot and does not try to guess that
 * `id:gmail.com` (still legitimately a possible entity in OTHER, non-leaked contexts — e.g. a
 * concept genuinely discussing "how Gmail's API works") is different in kind from an ordinary code
 * identifier fragment; it only removes what the scrubbed-text re-extraction can no longer justify
 * for THIS concept's own stored text. The closure test (scrub-db-closure.test.ts) checks
 * entities.surface/entities.key/concept_entities.entity_key directly against scrubString's own
 * patterns — it will NOT flag a bare non-pattern-matchable fragment like "gmail.com" as a
 * violation (correctly — "gmail.com" alone is not itself an email/path/secret/endpoint by any of
 * scrubString's defined patterns), so pruneStaleEntities' effectiveness is verified by the
 * dedicated before/after fragment-specific assertions in scrub-db.test.ts instead, not by the
 * schema-driven closure guard (which checks PATTERN matches, not "is this word contextually
 * sensitive").
 *
 * DISCLOSED CAVEAT (unchanged from round 1, documented here, in eval-corpus/README.md, and in
 * scrub-db.test.ts): embeddings (concepts.embedding, observations.embedding) were computed BEFORE
 * this scrub pass ran, against the ORIGINAL unscrubbed text — they are not recomputed here. This
 * means an embedding technically corresponds to a slightly different string than the one now
 * stored in title/body/content (the scrubbed string, with redaction placeholders like
 * "[redacted-email]" substituted in). This drift is accepted as negligible for three reasons,
 * unchanged from round 1's rationale: (1) scrub deltas are SMALL; (2) deltas are UNIFORM in shape
 * (same fixed placeholder forms every time); (3) this mirrors the EXACT same accepted trade the
 * existing publish/ pipeline already makes (scrub-corpus.mjs's corpus.json dump has always had
 * this same embedding/text mismatch). Widening the set of scrubbed columns in this round does not
 * change this trade's shape or size — the same reasoning applies to source_refs/detail/surface
 * text exactly as it did to title/body/content.
 *
 * WAL FIDELITY (new in round 2; FIXED AGAIN in round 3 — see "AUDIT FINDINGS, ROUND 3" below, F4,
 * for why the round-2 approach documented in the paragraphs below this one was itself a bug): the
 * source db is opened WAL-mode (verified: `PRAGMA journal_mode` on eval-corpus/db/<size>/monet.db
 * reports "wal", and a live -shm/-wal sidecar sits next to every derived monet.db). A bare
 * `copyFileSync` of only the main .db file risks copying a file whose most recent committed writes
 * are still sitting in the -wal sidecar and have not yet been checkpointed into the main file — the
 * copy would then be missing rows/updates a caller opening the ORIGINAL db can see, a silent,
 * non-obvious correctness gap.
 *
 * CURRENT FIX (round 3): copy the source's main file AND its `-wal`/`-shm` sidecars (if present)
 * into the destination FIRST, then open the DESTINATION and checkpoint THAT — never the source.
 * This is the well-known SQLite "hot backup by copying the file triple" technique: SQLite's WAL
 * file format does not require the reader to be the connection that produced it — a plain
 * byte-for-byte copy of `main.db` + `main.db-wal` + `main.db-shm`, taken together, and then opened
 * by a FRESH connection, replays the WAL exactly as if it were the original file set (verified
 * directly in this repo, not assumed: a scratch probe wrote a row to a WAL-mode db, copied all
 * three files while the writer connection was STILL OPEN — i.e. before any checkpoint — then opened
 * only the copied triple with a brand-new `better-sqlite3` connection; the row was recovered
 * correctly, confirming the copy-then-replay path works even against an unflushed WAL). This is
 * safe here specifically because eval-corpus/db/<size>/monet.db is an AT-REST derived artifact with
 * NO CONCURRENT WRITER by the time this script runs (scripts/sample-corpus.ts has already finished
 * and closed its own writer) — nothing else is writing to `srcDbPath`/`srcDbPath-wal`/
 * `srcDbPath-shm` between the three `copyFileSync` calls, so "copy all three, together" is
 * effectively atomic for this pipeline's purposes, the same "no concurrent writer" assumption the
 * round-2 doc already relied on for its own (now-replaced) checkpoint-the-source approach.
 *
 * `-wal`/`-shm` sidecars are copied with an `existsSync` guard, not assumed to exist: a source
 * that happens to have been fully checkpointed already (no pending frames at all) may have no
 * sidecar files at all, which is a valid, unremarkable state, not an error.
 *
 * WHY ROUND 2's APPROACH WAS WRONG (Codex finding F4, PR comment id 3522405282): round 2 opened
 * `srcDbPath` itself with a plain read-write handle and ran `PRAGMA wal_checkpoint(TRUNCATE)`
 * against it before copying, reasoning that "a checkpoint never changes any row's LOGICAL content,
 * only its physical WAL/main-file location" — that reasoning is correct as far as it goes, but it
 * misses the actual guarantee this pipeline advertises: not merely "the source's rows are
 * unchanged" but "the source FILE is byte-untouched" (an artifact-hash-stability guarantee, not
 * just a content-equivalence one). A TRUNCATE checkpoint against the source REWRITES srcDbPath's
 * own bytes (moving WAL frames into the main file) and TRUNCATES/empties `srcDbPath-wal` — so the
 * source file's sha256 hash changes, and a previously-existing `-wal` sidecar disappears, even
 * though no row's value changed. That is a real violation of the "original untouched" contract this
 * script's own callers (and this repo's test suite) depend on, not merely a documentation
 * inaccuracy — fixed for real in round 3 by never opening `srcDbPath` for write ANYWHERE in this
 * script: the source is only ever read via `copyFileSync`, never via a `new Database(srcDbPath)`
 * write-capable handle. (Grepped after this fix: `new Database(srcDbPath` — or any variable holding
 * the source path — does not appear write-opened anywhere in this file.)
 *
 * The destination gets the SAME checkpoint discipline round 2 already established, just applied to
 * the COPY instead of the source: after copying the sidecars over, `checkpointWal(db, dstDbPath)`
 * (TRUNCATE, not the default PASSIVE, so the -wal file is guaranteed emptied and the main .db file
 * guaranteed to hold every committed frame — a checkpoint MUST fully succeed, busy=0, or this script
 * throws rather than silently shipping a possibly-incomplete copy) runs against the DESTINATION
 * connection, replaying any frames that were sitting in the copied `-wal` sidecar into the
 * destination's own main file, then truncating that sidecar away. This captures pending-but-
 * uncheckpointed source writes (they arrived via the copied `-wal` file) without ever touching the
 * source's own bytes.
 *
 * The main-file copy itself is a plain synchronous `copyFileSync` (unchanged from round 1/2) —
 * better-sqlite3's `.backup()` API was tried first for this step and rejected on closer inspection:
 * it is ASYNC-ONLY (returns a Promise, confirmed directly from better-sqlite3's own source — no
 * synchronous variant exists), which would force async/await through this function and every
 * caller/test for no real benefit here — `.backup()`'s actual value is safely copying a db that is
 * STILL open/being concurrently written to from ANOTHER process (via SQLite's incremental backup
 * API mid-write), which does not apply to this pipeline's at-rest, no-concurrent-writer situation; a
 * plain synchronous file copy of the three files (main + sidecars) is simpler and exactly as
 * correct here. After scrubbing runs against the destination copy, the SAME TRUNCATE-checkpoint
 * discipline is applied to the destination AGAIN (this time to flush the scrub UPDATEs/DELETEs/
 * VACUUM themselves, not to replay copied-over source frames) before closing, so
 * eval-corpus/db-scrubbed/<size>/monet.db is always shipped as ONE self-contained file with no
 * -shm/-wal sidecars — a caller (or this pipeline's own delivery step) copying just the one file
 * elsewhere can never silently drop pending frames.
 *
 * DETERMINISM (mission requirement: "two runs byte-identical"): scrubString/scrubJson are pure
 * functions of their input (no randomness, no wall-clock reads — see src/eval/scrub-patterns.mjs)
 * and every UPDATE in this script is keyed by primary key, iterated in a fixed `ORDER BY`.
 * Re-running this script twice against the same source db produces byte-identical output because
 * every scrubbed row's new value is a pure function of (a) the source row's unscrubbed CONTENT
 * (fixed — round 3's copy-then-checkpoint-the-copy approach never opens the source for write at
 * all, so its content is trivially stable across runs) and (b) the pattern set. The WAL-checkpoint
 * step on the destination (TRUNCATE, always run, always the last write before close) removes the
 * one other source of possible byte-level nondeterminism a WAL-mode sqlite file could otherwise
 * introduce (a stray -wal/-shm sidecar's exact byte layout is not part of this script's
 * committed-content contract; checkpointing to a single main-file-only artifact before hashing
 * sidesteps that question entirely rather than depending on it never mattering). ROUND 3 ALSO ADDS
 * A VACUUM step (see "AUDIT FINDINGS, ROUND 3", F1, below) — VACUUM rebuilds the destination file
 * page-by-page from the live b-tree, which is a well-defined, non-random packing algorithm for a
 * given input, and this was VERIFIED EMPIRICALLY (not assumed): two independent from-scratch builds
 * of the same schema/content, each VACUUM'd and checkpointed, produced byte-identical sha256 hashes
 * in a scratch probe, and the existing "is deterministic: running scrubSizeDb twice..." test (below,
 * in scrub-db.test.ts) continues to pass with VACUUM added — both the unit-level determinism test
 * AND a real end-to-end double-run against the actual eval-corpus/db/<size>/monet.db files (run as
 * part of this round's validation) confirm byte-identical output, so no nondeterminism from VACUUM
 * was found in practice.
 *
 * Usage:
 *   node scripts/scrub-db.mjs [--db=eval-corpus/db] [--out=eval-corpus/db-scrubbed]
 *
 * Discovers sizes the same way scrub-corpus.mjs does (readdir over --db, one subdir per sweep
 * size), so it automatically tracks whatever sizes sample-corpus.ts most recently derived — never
 * a hardcoded size list.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { scrubString } from "../src/eval/scrub-patterns.mjs";
import { SAMPLED_CIRCLE } from "../src/eval/corpus-scope.mjs";
import { extractEntities } from "../src/extract-entities.mjs";
import { slugify } from "../src/db-slugify.mjs";
import { rewriteAssertedSlugRefs } from "../src/eval/slug-ref-rename.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Same "already scoped upstream" self-check scrub-corpus.mjs's assertScopeAlreadyApplied performs
 * (see that function's doc comment) — every row in a properly-derived per-size db is re-circled to
 * SAMPLED_CIRCLE at sampling time. Reused here for the identical reason: a future edit that
 * accidentally points --db at a raw multi-circle source db instead of a derived per-size one should
 * fail loudly, not silently scrub (and then ship) the wrong db.
 */
function assertScopeAlreadyApplied(rows, dbPath, table) {
  const offending = rows.filter((r) => r.circle !== SAMPLED_CIRCLE);
  if (offending.length > 0) {
    throw new Error(
      `scrub-db.mjs: expected every ${table} row from ${dbPath} to already be circled to ` +
        `"${SAMPLED_CIRCLE}" (monet-circle scoping happens upstream at sampling time, not here) — ` +
        `found ${offending.length} row(s) with a different circle (e.g. "${offending[0].circle}"). ` +
        `This db does not look like a properly-derived per-size corpus db.`,
    );
  }
}

/**
 * Round 5, J4 fix (PR comment id 3522836454) — closure-level invariant proof, callable directly
 * against an OPEN db handle (used by scrub-db-closure.test.ts's own "closure" describe blocks,
 * alongside its schema-driven pattern-scan checks) so a slug-uniqueness regression is caught by the
 * exact same durable-guard mechanism the rest of this pipeline's closure test already establishes,
 * not just by scrubConceptSlugs' own unit tests (which can only prove "this function's OWN
 * disambiguation logic looks right in isolation", not "the FULL real pipeline never actually
 * produces a duplicate").
 *
 * Asserts `concepts.slug` is unique PER CIRCLE (matching resolveRef's own `WHERE circle = ? AND
 * slug = ?` scope — a slug collision across two DIFFERENT circles is not a resolveRef ambiguity,
 * since a ref lookup is always circle-scoped) — throws, naming the offending (circle, slug, count),
 * on any violation. Deliberately a plain `GROUP BY circle, slug HAVING COUNT(*) > 1` query — the
 * simplest possible ground-truth check, independent of and not trusting scrubConceptSlugs'
 * own internal bookkeeping (assignedFinalSlugsByCircle) to have gotten it right; this re-derives the
 * invariant straight from the actual committed column values.
 */
function assertSlugsUniquePerCircle(db) {
  const dupes = db
    .prepare(
      `SELECT circle, slug, COUNT(*) AS n FROM concepts GROUP BY circle, slug HAVING COUNT(*) > 1 ORDER BY circle, slug`,
    )
    .all();
  if (dupes.length > 0) {
    const first = dupes[0];
    throw new Error(
      `scrub-db.mjs: expected concepts.slug to be unique per circle — found ${dupes.length} ` +
        `duplicate (circle, slug) pair(s), e.g. circle="${first.circle}" slug="${first.slug}" ` +
        `appears ${first.n} times. resolveRef()'s "WHERE circle = ? AND slug = ? LIMIT 1" would ` +
        `resolve a #${first.slug} ref to an arbitrary one of these ${first.n} concepts, silently ` +
        `wrong for the others.`,
    );
  }
}

/**
 * Parse a column known to hold a JSON-serialized string[] (concepts.source_refs,
 * observations.source_refs — see engine.ts:837 `JSON.stringify(sourceRefs)` /
 * engine.ts:921/1717/3078 `JSON.parse(...) as string[]` for the exact read/write contract this
 * mirrors), scrub each element, and re-serialize compactly. Returns the ORIGINAL value unchanged
 * for null/undefined/empty input (the column is nullable — engine.ts never writes a JSON array for
 * a concept/observation with no source refs at all, it leaves the column NULL) so this function is
 * safe to call unconditionally over every row without a separate null-guard at each call site.
 *
 * Parses defensively (try/catch) rather than assuming every non-null value is well-formed JSON —
 * a real derived corpus should never have a malformed source_refs value (engine.ts always writes
 * via JSON.stringify), but this is a data-scrubbing script whose whole purpose is closing a
 * correctness gap found by NOT trusting an assumption; failing loudly on a genuinely malformed
 * value (rather than silently passing it through unscrubbed) is the safer failure mode here.
 */
function scrubSourceRefsJson(raw) {
  if (raw === null || raw === undefined || raw === "") return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`scrub-db.mjs: source_refs value is not valid JSON (${err.message}): ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`scrub-db.mjs: expected source_refs to parse to an array, got ${typeof parsed}: ${raw.slice(0, 200)}`);
  }
  const scrubbed = parsed.map((el) => (typeof el === "string" ? scrubString(el) : el));
  return JSON.stringify(scrubbed);
}

/**
 * Scrub concepts.title/body/kind/source_refs and
 * observations.content/kind/source_refs/author_agent_id IN PLACE on `db` (a writable better-sqlite3
 * handle already open on the COPY, never the original — see scrubSizeDb below for the copy-first
 * discipline). Returns per-column hit counts for the human-readable summary this script prints,
 * mirroring scrub-corpus.mjs's own "print what was actually redacted" convention.
 *
 * Every row is touched (UPDATE runs unconditionally), but scrubString/scrubSourceRefsJson are
 * no-ops on input with nothing to redact — so a row with no scrubbable content gets written back
 * with an unchanged value, which is correct (idempotent) but does mean this function's
 * hit-counting must compare old vs new value per row, not just "how many UPDATE statements ran".
 *
 * ROUND 4, G2 FIX (PR comment id 3522728464): observations.author_agent_id (schema: `TEXT NOT NULL`)
 * was previously read/updated nowhere in this function — the SELECT only pulled
 * id/content/source_refs/circle. `author_agent_id` is written at store time from `this.agentId`
 * (engine.ts), which is a MonetCore CONSTRUCTOR option (`MonetCoreOptions.agentId`, engine.ts) set
 * ONCE per instance and applied to every observation that instance writes — NOT a per-`store()`-call
 * parameter. This repo's own derived corpus only ever uses the default (`"local-agent"`, engine.ts),
 * which is benign — but the column has no format constraint anywhere in the engine, so a caller that
 * constructed a MonetCore with a hostile-shaped `agentId` (an email, a /Users/ path, a key-shaped
 * string — nothing validates its shape) would have that value land in every observation row that
 * instance ever writes. `getAgentId()` (engine.ts) only returns the CURRENT instance's own agentId —
 * it does not read historical `author_agent_id` values back out of the db, so there is no live
 * per-observation READ site returning this column verbatim today — but this stage's own stated
 * closure guarantee (see this file's "ENGINE READ-SURFACE ENUMERATION" section) is "every TEXT
 * column that reaches an agent context", scrubbed defensively regardless of today's exact
 * reachability, matching the identical future-proofing precedent already established for
 * first_block.summary/sessions.summary (see scrubFutureProofedColumns below and this file's "AUDIT
 * FINDINGS, ROUND 2" #5) — a column with no shape constraint whose value is caller-suppliable is not
 * something this closure should rely on "nothing reads it today" to justify leaving unscrubbed.
 *
 * ROUND 5, J2 FIX (PR comment id 3522836450): concepts.kind and observations.kind (both `TEXT NOT
 * NULL DEFAULT ...`, engine.ts's own CREATE TABLE — no CHECK constraint, no enum, in either table)
 * were previously read/updated nowhere in this function either — the SAME caller-suppliable-with-no-
 * validation gap as author_agent_id above, verified directly against the MCP tool schema
 * (src/mcp-server.ts's `memory_store` tool: `kind: z.string().optional()` — a bare, unvalidated
 * string, confirmed by reading that schema definition directly, not assumed) which flows straight
 * into `core.store(content, { kind, ... })` -> engine.ts's private `create()` -> `kind ?? "fact"` ->
 * the `INSERT INTO concepts (..., kind, ...) VALUES (..., ?, ...)` bind param, with nothing in
 * between validating or normalizing the value. A hostile-shaped kind (e.g. `kind:
 * "jane.doe@example.com"`, `kind: "/Users/dev/secret"`) lands verbatim in `concepts.kind`, and
 * is then returned verbatim by every card/list/search/gather read surface (toCard, listMemories,
 * overview, etc. — engine.ts's toCard-family functions all pass `kind: row.kind` straight through
 * with no scrub of their own) — the identical "reaches an agent context unscrubbed" class as every
 * other column this stage already closes. Fixed by folding `kind` into the exact same
 * scrubString-then-compare-then-UPDATE loop as every other text column here, for BOTH tables.
 * REAL-CORPUS CHECK (not assumed): queried every distinct kind value across all 4 derived per-size
 * dbs directly (`SELECT kind, COUNT(*) FROM concepts/observations GROUP BY kind`) — every value
 * found is a standard, non-sensitive vocabulary word (fact, project, decision, insight, feedback,
 * architecture, pattern, reference, gotcha, procedure, preference, user, status, policy, issue,
 * constraint, statement, correction) — so this fix is a genuine 0-hit no-op against TODAY's corpus
 * (see this fix's validation section for the exact per-size counts), scrubbed defensively for the
 * same "schema permits arbitrary values even though today's data happens to be clean" reason
 * author_agent_id/first_block.summary/sessions.summary are above, not because today's data needs it.
 */
function scrubConceptsAndObservations(db) {
  let titleHits = 0;
  let bodyHits = 0;
  let conceptKindHits = 0;
  let contentHits = 0;
  let obsKindHits = 0;
  let conceptRefsHits = 0;
  let obsRefsHits = 0;
  let agentIdHits = 0;

  const conceptRows = db.prepare(`SELECT id, title, body, kind, source_refs, circle FROM concepts ORDER BY id`).all();
  assertScopeAlreadyApplied(conceptRows, db.name, "concepts");
  const updateConcept = db.prepare(`UPDATE concepts SET title = ?, body = ?, kind = ?, source_refs = ? WHERE id = ?`);
  const scrubConceptsTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbedTitle = scrubString(row.title);
      const scrubbedBody = scrubString(row.body);
      const scrubbedKind = scrubString(row.kind);
      const scrubbedRefs = scrubSourceRefsJson(row.source_refs);
      if (scrubbedTitle !== row.title) titleHits += 1;
      if (scrubbedBody !== row.body) bodyHits += 1;
      if (scrubbedKind !== row.kind) conceptKindHits += 1;
      if (scrubbedRefs !== row.source_refs) conceptRefsHits += 1;
      updateConcept.run(scrubbedTitle, scrubbedBody, scrubbedKind, scrubbedRefs, row.id);
    }
  });
  scrubConceptsTx(conceptRows);

  const obsRows = db.prepare(`SELECT id, content, kind, source_refs, author_agent_id, circle FROM observations ORDER BY id`).all();
  assertScopeAlreadyApplied(obsRows, db.name, "observations");
  const updateObs = db.prepare(`UPDATE observations SET content = ?, kind = ?, source_refs = ?, author_agent_id = ? WHERE id = ?`);
  const scrubObsTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbedContent = scrubString(row.content);
      const scrubbedKind = scrubString(row.kind);
      const scrubbedRefs = scrubSourceRefsJson(row.source_refs);
      const scrubbedAgentId = scrubString(row.author_agent_id);
      if (scrubbedContent !== row.content) contentHits += 1;
      if (scrubbedKind !== row.kind) obsKindHits += 1;
      if (scrubbedRefs !== row.source_refs) obsRefsHits += 1;
      if (scrubbedAgentId !== row.author_agent_id) agentIdHits += 1;
      updateObs.run(scrubbedContent, scrubbedKind, scrubbedRefs, scrubbedAgentId, row.id);
    }
  });
  scrubObsTx(obsRows);

  return {
    conceptCount: conceptRows.length,
    observationCount: obsRows.length,
    titleHits,
    bodyHits,
    conceptKindHits,
    contentHits,
    obsKindHits,
    conceptRefsHits,
    obsRefsHits,
    agentIdHits,
  };
}

/**
 * Regenerate concepts.slug from the ALREADY-SCRUBBED title (round 3, F2 fix — see this script's
 * module doc, "AUDIT FINDINGS, ROUND 3", F2, for the full leak writeup). MUST run AFTER
 * scrubConceptsAndObservations, since it reads `title` back from the db expecting it to already be
 * scrubbed — a stale/raw title here would silently reintroduce the exact leak this function exists
 * to close.
 *
 * WHY re-derive with a MIRRORED slugify rather than approximate it: engine.ts's own `slugify` is
 * what a live MonetCore uses to derive concepts.slug at creation time
 * (`INSERT INTO concepts ... slugify(title) ...`, engine.ts) — using anything else here (a
 * differently-shaped slugify, or the DIFFERENT slugify src/eval/md-export.ts exports for topic-file
 * NAMES) would produce a slug that doesn't match what a live engine would have produced for the
 * same (scrubbed) title, which is a correctness mismatch independent of the scrubbing question.
 * src/db-slugify.mjs mirrors engine.ts's exact logic (byte-verified — see
 * src/__tests__/db-slugify.test.ts) so this function's output is exactly what a live engine would
 * derive from the scrubbed title, not merely "some slug-shaped string".
 *
 * COLLISION POLICY: a live engine's own slug derivation has no enforced uniqueness constraint at
 * the SQL level (verified: no `UNIQUE`/`CREATE UNIQUE INDEX` on concepts.slug anywhere in
 * engine.ts's schema) — slugs are a soft, logical concern, and two DIFFERENT concepts scrubbing
 * down to the same title (e.g. two concepts both about "Contact [redacted-email]") can legitimately
 * collide on the same regenerated slug. Rather than silently leave a real duplicate (which a human
 * reading the corpus could find confusing, and which diverges from the collision-disambiguation
 * discipline this same pipeline already established at the md-export tier — see
 * src/eval/md-export-store.ts's `usedSlugs` + `--${lead.id}` suffix precedent), a colliding slug
 * here gets a deterministic `-${conceptId}` suffix appended. `conceptId` (not a running counter) is
 * used as the disambiguator because it's already guaranteed unique and stable per concept — a
 * counter based on iteration order would ALSO be deterministic here (iteration is a fixed
 * `ORDER BY id`), but id-based is more self-documenting and matches the existing md-export-store.ts
 * precedent directly, so that's what this function does too.
 *
 * SCOPE: collision tracking is PER CIRCLE, matching the scope a live engine's own slug-collision
 * check uses (`WHERE circle = ? AND slug = ? AND id != ?`, engine.ts's resolveRef) — not a single
 * global scope across the whole db. In practice this corpus is entirely SAMPLED_CIRCLE (per
 * assertScopeAlreadyApplied, enforced by every other scrub function above), so this collapses to a
 * single scope today — but implemented correctly per-circle regardless, so a future multi-circle
 * corpus doesn't silently misbehave just because today's corpus happens to be single-circle.
 *
 * ROUND 4, G3 FIX (PR comment id 3522728466): the disambiguated form used through round 3,
 * `${baseSlug}-${row.id}`, can exceed engine.ts's own 60-char slugify() cap — `baseSlug` is already
 * <= 60 chars (it's slugify()'s own output), but `row.id` is a full randomUUID() (36 chars: 32 hex +
 * 4 hyphens), so `baseSlug + "-" + id` can reach 60 + 1 + 36 = 97 chars. That matters because
 * resolveRef (engine.ts) re-slugifies every incoming `#ref` through the SAME 60-char slice before
 * looking it up (`WHERE slug = ?`) — a 97-char value written to `concepts.slug` is not a FIXED POINT
 * of slugify(): passing that exact 97-char string back in as a ref gets truncated to 60 chars by
 * resolveRef's own `slugify(ref)` call, which no longer equals the 60+ char value actually stored,
 * so the lookup misses and the disambiguated slug is permanently unresolvable via the normal
 * ref-lookup path. FIXED: cap the disambiguator to an 8-char id fragment (`row.id.slice(0, 8)` — the
 * same length git/many systems use as a "practically unique enough" short-hash disambiguator at this
 * corpus's scale) and truncate `baseSlug` itself so `truncatedBase + "-" + fragment` never exceeds 60
 * chars total. This makes `finalSlug` a fixed point of slugify() by construction (already
 * lowercase/alnum/hyphens-only, already <= 60 chars) — re-slugifying it is a provable no-op, which is
 * exactly the invariant resolveRef's own lookup depends on. See
 * src/__tests__/scrub-db.test.ts's "round 4, G3 fix" describe block for the resolveRef round-trip
 * proof (asserts `mirroredSlugify(stored) === stored` on a stored, over-length-forcing collision).
 *
 * EMPTY-BASE EDGE CASE: slugify() CAN produce an empty string (e.g. a title that, after scrubbing,
 * is all punctuation/whitespace with no [a-z0-9] characters at all — verified against slugify()'s
 * own regex: `.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")` reduces a no-alnum input to ""
 * before the `.slice(0, 60)` no-op). `truncatedBase.slice(0, 60 - ID_FRAGMENT_BUDGET)` on an empty
 * `baseSlug` is simply "" (slice of an empty string is always ""), and the fallback below joins as
 * `"" + "-" + fragment` — the leading hyphen this would otherwise produce is stripped explicitly so
 * `finalSlug` never starts with a hyphen (slugify()'s own contract, which this disambiguated value
 * must also honor to remain a genuine fixed point of slugify()).
 *
 * MID-SLUG TRUNCATION EDGE CASE (found and fixed while writing this function's own test — a real
 * bug, not a hypothetical): `baseSlug` is itself hyphen-delimited (slugify() turns every run of
 * non-alnum characters into a single `-`), so an arbitrary `.slice(0, N)` cut can land EXACTLY at an
 * existing internal hyphen boundary, leaving `truncatedBase` itself ENDING in a trailing hyphen (e.g.
 * slicing "...architecture-note-internals..." at length 52 can produce
 * "...architecture-note-" — note the trailing "-"). Naively joining `${truncatedBase}-${idFragment}`
 * in that case produces a DOUBLE hyphen ("...note--fcac91b9"), which is NOT a fixed point of
 * slugify(): `slugify()`'s own `.replace(/[^a-z0-9]+/g, "-")` step collapses a run of "-" characters
 * (of any length) into a SINGLE "-", so re-slugifying "...note--fcac91b9" produces "...note-fcac91b9"
 * — different from the stored double-hyphen value, breaking the exact round-trip invariant this
 * function exists to guarantee. FIXED: strip any trailing hyphen(s) from `truncatedBase` BEFORE
 * joining (`.replace(/-+$/, "")`), so the join point is always alnum-to-hyphen-to-alnum, never
 * hyphen-to-hyphen. Combined with the leading-hyphen strip on the empty-base case above, this makes
 * `finalSlug` a genuine fixed point of slugify() in every case, not just the common one — verified by
 * this function's own test suite using a title long enough to force a truncation cut at an internal
 * hyphen boundary (not a synthetic/contrived string).
 *
 * SECOND-ORDER COLLISION (round 5, J4 fix — PR comment id 3522836454; previously a documented,
 * accepted gap, see git history of this comment block): using only the first 8 UUID hex characters
 * as the disambiguator means two DIFFERENT concepts could in principle share BOTH the same
 * truncated base AND the same 8-char id-fragment prefix (a UUID-prefix collision) — but the REAL,
 * more likely gap this round's audit actually found is simpler and doesn't need a UUID-prefix
 * coincidence at all: `usedSlugs` (below) tracked only each row's BASE slug, never the FINAL
 * (possibly-disambiguated) slug actually written to the column. So a suffixed slug like
 * `truncated-base-abcdef12` (assigned to resolve an earlier base-slug collision) could still
 * collide with a LATER concept whose OWN scrubbed title naturally slugifies to that exact
 * `truncated-base-abcdef12` string — astronomically unlikely to happen by pure chance, but not
 * remotely astronomically unlikely as an ADVERSARIAL/PATHOLOGICAL input (a title literally
 * containing text that slugifies to a shape indistinguishable from this function's own
 * disambiguation suffix), and either way produces a genuine duplicate `concepts.slug` — undetected
 * by the base-slug-only `usedSlugs` check, since a final slug is never itself checked against
 * `usedSlugs` before being written. `resolveRef()`'s `SELECT ... WHERE slug = ? LIMIT 1` (engine.ts)
 * resolves the FIRST matching row by whatever order SQLite returns it in — an unspecified,
 * implementation-detail order for a query with no ORDER BY — so a future `#truncated-base-abcdef12`
 * ref could resolve to either concept, silently and non-deterministically wrong for one of them.
 * FIXED: track a SEPARATE per-circle `Set` of every FINAL slug actually assigned so far this pass
 * (`assignedFinalSlugsByCircle`, alongside the pre-existing `usedSlugsByCircle` base-slug tracker),
 * and disambiguate a newcomer against BOTH sets — if a concept's base slug collides with an
 * assigned-final slug (even one that was itself a disambiguated form), it goes through the exact
 * same truncate-and-suffix path as an ordinary base-slug collision. Iteration order is the same
 * fixed `ORDER BY id` this function already used (deterministic across runs — "assignment order"
 * can never vary run to run), so which of two naturally-colliding concepts gets the base form and
 * which gets suffixed is itself deterministic, not incidental. A per-circle
 * `assertSlugsUniquePerCircle`-style invariant (see src/__tests__/scrub-db-closure.test.ts) is the
 * closure-level proof this can never regress silently.
 *
 * SECOND-ORDER COLLISION, RESIDUAL (still a documented, accepted gap after the J4 fix above): the
 * 8-char id-fragment TRUNCATION-BUDGET disambiguator itself could in extreme theory still produce a
 * final-slug collision between two concepts BOTH being disambiguated in the same pass if their UUID
 * prefixes happened to collide too (a UUID-prefix collision, 32 bits of entropy) — but this is now
 * CAUGHT, not silently accepted, by the very fix above: any such collision is just another
 * assigned-final-slug collision that the newcomer gets disambiguated against exactly like any other
 * (the disambiguation loop is applied uniformly, it doesn't special-case "is this the first or
 * second time this concept is being disambiguated"). What remains a theoretical (not practical)
 * residual is only the vanishingly small chance of an actual assignment LOOP (a slug's own
 * disambiguated form colliding with a THIRD concept's, whose own disambiguated form collides back)
 * — not a concern at this corpus's scale (a few hundred concepts per circle) and would surface
 * immediately as a thrown uniqueness-assertion failure (fail loud) rather than a silent duplicate,
 * if it were ever hit.
 */
const SLUG_MAX_LEN = 60; // must match engine.ts's own slugify() cap exactly (mirrored in src/db-slugify.mjs)
const SLUG_ID_FRAGMENT_LEN = 8; // git-short-hash-style disambiguator length
const SLUG_ID_FRAGMENT_BUDGET = SLUG_ID_FRAGMENT_LEN + 1; // +1 for the joining hyphen

/**
 * Round 5, J1 fix (PR comment id 3522836449): scrubConceptSlugs is the ONE place that knows both a
 * concept's OLD (pre-scrub) slug and its NEW (post-scrub) slug for every regenerated row — so it is
 * also the natural place to build the old-slug -> new-slug rename map that the in-body `#<slug>`
 * ref-rewrite pass (rewriteAssertedSlugRefs, below) needs. Built for EVERY row whose slug actually
 * changed (`finalSlug !== row.slug`), not just collision-disambiguated ones — an ordinary
 * (non-colliding) slug regenerated from a newly-scrubbed title is exactly the J1 leak case PR
 * comment 3522836449 describes (e.g. `jane-doe-example-com` -> `redacted-email`-derived slug), no
 * collision required for the leak to exist.
 *
 * Returned as a plain `Map<oldSlug, newSlug>` (not scoped by circle) — safe because concepts.slug
 * collisions are only possible WITHIN a circle (resolveRef's own lookup is `WHERE circle = ? AND
 * slug = ?`), so two DIFFERENT circles' concepts can legitimately share an old OR new slug string
 * without those being the "same" rename from the ref-rewrite pass's point of view. This is an
 * accepted simplification: rewriteAssertedSlugRefs (scripts/scrub-corpus.mjs / this file) applies
 * the map GLOBALLY across a whole text value, but a `#ref` in one circle's concept body is only
 * ever resolved against that SAME circle's concepts (resolveRef's own circle-scoped query) — so
 * even if circle A's old slug "foo" collided with circle B's new slug "foo" in this global map,
 * rewriting a circle-A body's "#foo" to circle B's differently-cased/differently-suffixed new value
 * would be a no-op in the (extremely unlikely, unverified in the real corpus — see this fix's
 * validation section) worst case, never a cross-circle leak (the ref still wouldn't resolve to the
 * wrong concept, since resolveRef itself is circle-scoped regardless of what the map produced).
 */
function scrubConceptSlugs(db) {
  let slugsChanged = 0;
  let collisionsDisambiguated = 0;
  const renameMap = new Map(); // oldSlug -> newSlug, every row whose slug actually changed

  const rows = db.prepare(`SELECT id, title, slug, circle FROM concepts ORDER BY id`).all();
  const update = db.prepare(`UPDATE concepts SET slug = ? WHERE id = ?`);

  const tx = db.transaction((rows) => {
    // usedSlugsByCircle: circle -> Set<BASE slug> already assigned earlier in THIS pass (fixed
    // `ORDER BY id` above makes "earlier in this pass" deterministic across runs).
    const usedSlugsByCircle = new Map();
    // assignedFinalSlugsByCircle: circle -> Set<FINAL slug actually written to the column so far>
    // (round 5, J4 fix — see this function's doc comment's "SECOND-ORDER COLLISION" section for
    // exactly what gap this closes: a suffixed slug colliding with a LATER concept's natural base
    // slug, which the base-slug-only `usedSlugsByCircle` check alone cannot detect).
    const assignedFinalSlugsByCircle = new Map();
    for (const row of rows) {
      const baseSlug = slugify(row.title);
      let usedSlugs = usedSlugsByCircle.get(row.circle);
      if (!usedSlugs) {
        usedSlugs = new Set();
        usedSlugsByCircle.set(row.circle, usedSlugs);
      }
      let assignedFinalSlugs = assignedFinalSlugsByCircle.get(row.circle);
      if (!assignedFinalSlugs) {
        assignedFinalSlugs = new Set();
        assignedFinalSlugsByCircle.set(row.circle, assignedFinalSlugs);
      }

      let finalSlug = baseSlug;
      // Round 5, J4 fix: disambiguate against EITHER collision source — a base-slug collision
      // (round 3/4 behavior, unchanged) OR a collision against an already-ASSIGNED FINAL slug from
      // an earlier row in this same pass (the new check). Either condition alone is sufficient to
      // require disambiguation, so this is a single `||`, not two separate disambiguation branches.
      if (usedSlugs.has(baseSlug) || assignedFinalSlugs.has(baseSlug)) {
        // Round 4, G3 fix: truncate the BASE portion so `truncatedBase + "-" + idFragment` fits
        // within SLUG_MAX_LEN total, using an 8-char id fragment rather than the full 36-char UUID
        // (see this function's doc comment for the exact leak this closes and why 8 chars is judged
        // sufficient here). `truncatedBase` has its trailing hyphen(s) stripped BEFORE the join
        // (`.replace(/-+$/, "")` — the mid-slug-truncation edge case documented above: an arbitrary
        // slice can land exactly at an internal hyphen boundary, and joining a trailing hyphen
        // straight into the disambiguator's leading hyphen would produce a double "--" that
        // slugify() itself collapses to a single "-" on re-slugify, breaking the fixed-point
        // invariant). The final `.replace(/^-+/, "")` on the joined result additionally strips a
        // leading hyphen for the EMPTY-base case (truncatedBase === "", documented above) — the two
        // strips are independent and both needed (one guards the join seam, the other guards an
        // entirely-empty base), so `finalSlug` never starts OR internally doubles a hyphen at the
        // disambiguation seam, matching slugify()'s own contract exactly in every case.
        const truncatedBase = baseSlug.slice(0, SLUG_MAX_LEN - SLUG_ID_FRAGMENT_BUDGET).replace(/-+$/, "");
        const idFragment = row.id.slice(0, SLUG_ID_FRAGMENT_LEN);
        finalSlug = `${truncatedBase}-${idFragment}`.replace(/^-+/, "");
        collisionsDisambiguated += 1;
      }
      usedSlugs.add(baseSlug); // track the BASE slug for collision detection, not the disambiguated one
      // (two more concepts colliding on the same base each independently get their own -id suffix,
      // rather than the second one colliding against the FIRST one's already-disambiguated slug).
      assignedFinalSlugs.add(finalSlug); // round 5, J4: track the FINAL slug too, so a LATER row's
      // base slug is checked against every slug actually written so far, not just every base slug
      // seen so far.

      if (finalSlug !== row.slug) {
        slugsChanged += 1;
        renameMap.set(row.slug, finalSlug); // round 5, J1: old slug (pre-image) -> new slug
      }
      update.run(finalSlug, row.id);
    }
  });
  tx(rows);

  return { conceptCount: rows.length, slugsChanged, collisionsDisambiguated, renameMap };
}

/**
 * Round 5, J1 fix (PR comment id 3522836449 — see src/eval/slug-ref-rename.mjs's own module doc for
 * the full leak writeup and the shared rewrite/anchoring rationale). Rewrites every asserted-ref
 * token (`verb: #<old-slug>` or `verb: <old-slug>` — see slug-ref-rename.mjs's ASSERTED_REF_RE doc
 * comment for the full 5-verb, optional-#, engine-mirrored anchor) in concepts.body and
 * observations.content that exactly matches an OLD slug in `renameMap`, to that slug's NEW value.
 *
 * MUST RUN AFTER scrubConceptSlugs (needs its renameMap — the old-slug -> new-slug pairs for every
 * regenerated slug this pass) and can run any time relative to the OTHER concepts/entities-tier
 * functions (it only reads/writes concepts.body and observations.content, columns no other function
 * in this file's per-size pipeline reads AFTER this point — pruneStaleEntities re-extracts entities
 * from body/content, so ordering THIS rewrite before pruneStaleEntities is the correct choice made
 * here, though not strictly required for THIS rewrite's own correctness: a stale slug REF token
 * carries no entity-extractable structure of its own that pruneStaleEntities' extractEntities would
 * derive differently before vs. after this rewrite).
 *
 * `renameMap.size === 0` (no slug was ever regenerated this run — e.g. every concept's scrubbed
 * title happened to slugify identically to its stored slug already) short-circuits to a true no-op
 * (0 rows touched, 0 DB writes) — matching this file's existing "hit count reflects genuine changes"
 * convention elsewhere (clearConceptAliases, scrubContradictions, etc.).
 */
function rewriteAssertedSlugRefsInDb(db, renameMap) {
  let bodyHits = 0;
  let contentHits = 0;

  if (renameMap.size === 0) return { bodyRefRewrites: bodyHits, contentRefRewrites: contentHits };

  const conceptRows = db.prepare(`SELECT id, body FROM concepts ORDER BY id`).all();
  const updateConcept = db.prepare(`UPDATE concepts SET body = ? WHERE id = ?`);
  const conceptsTx = db.transaction((rows) => {
    for (const row of rows) {
      const { text, hits } = rewriteAssertedSlugRefs(row.body, renameMap);
      if (hits > 0) {
        bodyHits += hits;
        updateConcept.run(text, row.id);
      }
    }
  });
  conceptsTx(conceptRows);

  const obsRows = db.prepare(`SELECT id, content FROM observations ORDER BY id`).all();
  const updateObs = db.prepare(`UPDATE observations SET content = ? WHERE id = ?`);
  const obsTx = db.transaction((rows) => {
    for (const row of rows) {
      const { text, hits } = rewriteAssertedSlugRefs(row.content, renameMap);
      if (hits > 0) {
        contentHits += hits;
        updateObs.run(text, row.id);
      }
    }
  });
  obsTx(obsRows);

  return { bodyRefRewrites: bodyHits, contentRefRewrites: contentHits };
}

/**
 * Clear concepts.aliases in the scrubbed copy (round 4, G1 fix — PR comment id 3522728463).
 *
 * MECHANISM: mergeConceptInto (engine.ts, run when reassignCircle's own dedup logic decides two
 * concepts should merge) writes the ABSORBED concept's `slug` (derived from the absorbed concept's
 * RAW, pre-scrub title) plus its `id` into the SURVIVING concept's `aliases` column — `[...new
 * Set([...existing aliases, ...src.aliases, src.slug, src.id])]`, JSON-serialized. scrubConceptSlugs
 * (above) only regenerates the SURVIVOR's own current `slug` column from the survivor's OWN
 * (already-scrubbed) title — it never touches `aliases`, which keeps carrying the absorbed concept's
 * OLD raw-title-derived slug forever once any merge has ever happened to that concept row. A
 * slugified fragment (e.g. "jane-doe-example-com") dodges every scrubString pattern, since slugify()
 * has already destroyed the punctuation (`@`, `.`, `/`) those patterns key off into plain hyphens.
 *
 * THIS IS A LIVE READ SURFACE, NOT DEAD DATA: resolveRef (engine.ts) does an explicit "alias
 * fallback" — `SELECT id, aliases FROM concepts WHERE circle = ? AND id != ? AND aliases IS NOT
 * NULL`, then `JSON.parse(aliases)` and checks `list.includes(ref) || list.includes(slug)` — used by
 * every `supports: #ref` / `resolves: #ref` resolution a caller can trigger.
 *
 * FIX: set `aliases` to SQL NULL (not `'[]'`, not a scrubbed-in-place JSON array) in every row that
 * currently has a non-null value. NULL is the engine's OWN representation of "no aliases" — the
 * schema declares `aliases TEXT` nullable, and every alias-fallback guard in engine.ts checks
 * `aliases IS NOT NULL` (never `aliases != '[]'`), so a fresh concept that has never absorbed
 * anything already has `aliases = NULL`, never `'[]'`. Clearing to NULL is the PARITY-correct choice,
 * not merely the safe one: the absorbed concepts' scrubbed titles no longer exist anywhere to
 * regenerate a matching alias from (mergeConceptInto's own `DELETE FROM concepts WHERE id = ?` on the
 * absorbed row already removed them), and the A2 md-tree arm this scrubbed db must stay in parity
 * with has no merge-history alias mechanism at all (md-export has no concept of aliases) — so a
 * derived eval corpus has no legitimate use for historical alias resolution either way.
 *
 * Only rows with a non-null value are touched (`WHERE aliases IS NOT NULL`), matching this file's
 * existing hit-counting convention (compare what actually changed, not "how many UPDATEs ran") so the
 * reported count stays meaningful even though every other scrub function in this file runs an
 * unconditional UPDATE over every row.
 */
function clearConceptAliases(db) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE aliases IS NOT NULL`).get().n;
  db.prepare(`UPDATE concepts SET aliases = NULL WHERE aliases IS NOT NULL`).run();
  return { aliasesCleared: before };
}

/**
 * Scrub contradictions.detail in place. Rows are KEPT (contradiction-surfacing is genuine A4
 * substrate behavior an eval over this corpus should still exercise — see this script's module
 * doc, audit finding #1) — only the text content is scrubbed, identically to every other text
 * column above.
 */
function scrubContradictions(db) {
  let detailHits = 0;
  const rows = db.prepare(`SELECT id, detail FROM contradictions ORDER BY id`).all();
  const update = db.prepare(`UPDATE contradictions SET detail = ? WHERE id = ?`);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbed = scrubString(row.detail);
      if (scrubbed !== row.detail) detailHits += 1;
      update.run(scrubbed, row.id);
    }
  });
  tx(rows);
  return { contradictionCount: rows.length, detailHits };
}

/**
 * Scrub entities.key + entities.surface, and every concept_entities.entity_key row that
 * references a rescrubbed key — IN LOCKSTEP, keyed by the OLD key value, so the value-equality
 * join between the two tables (`entities.key = concept_entities.entity_key`, see this script's
 * module doc's ENTITY_KEY INVESTIGATION section for why this is a denormalized copy, not a
 * declared FK) is never broken.
 *
 * `entities`'s primary key is (key, scope) — scrubbing `key` can in principle produce a
 * COLLISION with another row that scrubs to the same (key, scope) (e.g. two distinct raw paths
 * that both scrub down to the same generalized proof-repo form, or two distinct raw paths that
 * both become the literal string "[redacted-path]"). This is handled explicitly rather than left
 * to throw a raw SQLITE_CONSTRAINT error: when two rows collide on their new key, they are MERGED
 * — `df` (the per-scope concept-frequency/rarity signal) is summed, matching upsertEntity's own
 * "df grows monotonically with membership" invariant (engine.ts:3009-3019's own comment) — and
 * every concept_entities row pointing at either OLD key is repointed to the merged NEW key before
 * the old entities rows are replaced. This preserves the rarity/hub-gating signal's meaning (df
 * still equals the true count of concept memberships) rather than silently dropping one side of
 * the merge's df contribution, and INSERT OR IGNORE on the concept_entities repoint absorbs the
 * case where the collision also causes two distinct old (concept_id, entity_key, scope) rows to
 * repoint onto the identical new triple (a real membership dedup, not an error).
 */
function scrubEntities(db) {
  let surfaceHits = 0;
  let keyHits = 0;
  let mergedCollisions = 0;

  const entityRows = db.prepare(`SELECT key, kind, surface, scope, df FROM entities ORDER BY key, scope`).all();
  const ceRows = db.prepare(`SELECT concept_id, entity_key, scope FROM concept_entities ORDER BY entity_key, scope, concept_id`).all();

  // Group concept_entities rows by (entity_key, scope) so a repoint touches exactly the rows that
  // need it, in one lookup per distinct old key rather than an all-rows scan per key.
  const ceByOldKey = new Map(); // `${entity_key} ${scope}` -> rows
  for (const row of ceRows) {
    const k = `${row.entity_key} ${row.scope}`;
    if (!ceByOldKey.has(k)) ceByOldKey.set(k, []);
    ceByOldKey.get(k).push(row);
  }

  const deleteEntity = db.prepare(`DELETE FROM entities WHERE key = ? AND scope = ?`);
  const insertEntity = db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, ?, ?, ?, ?)`);
  const deleteCe = db.prepare(`DELETE FROM concept_entities WHERE concept_id = ? AND entity_key = ? AND scope = ?`);
  const insertOrIgnoreCe = db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`);

  const tx = db.transaction(() => {
    // Walk every entity row (fixed ORDER BY key, scope from the SELECT above — deterministic
    // regardless of original row order) into a fresh map keyed by the NEW (scrubbed key, scope),
    // so a collision between two DIFFERENT old keys that scrub to the SAME new key is caught and
    // merged deterministically.
    const mergedByNewKey = new Map(); // `${newKey} ${scope}` -> { key, kind, surface, scope, df, oldKeys: [] }

    for (const row of entityRows) {
      const newKey = scrubString(row.key);
      const newSurface = scrubString(row.surface);
      if (newKey !== row.key) keyHits += 1;
      if (newSurface !== row.surface) surfaceHits += 1;

      const mergeId = `${newKey} ${row.scope}`;
      const existing = mergedByNewKey.get(mergeId);
      if (existing) {
        mergedCollisions += 1;
        existing.df += row.df;
        existing.oldKeys.push(row.key);
        // kind/surface: keep the first-seen (rows colliding onto the same scrubbed key are
        // expected to share kind; surface is cosmetic once scrubbed and this is a rare collision
        // path, not a meaningfully-lossy choice — df, the signal actually used for hub-gating
        // math, is what this function is careful to preserve exactly via summation above).
      } else {
        mergedByNewKey.set(mergeId, { key: newKey, kind: row.kind, surface: newSurface, scope: row.scope, df: row.df, oldKeys: [row.key] });
      }
    }

    // Wipe every old entities row, then insert the merged/scrubbed set fresh — simpler and
    // provably correct (no partial-update ordering hazard) than trying to UPDATE rows in place
    // while a later row might still collide with an earlier one's new key.
    for (const row of entityRows) deleteEntity.run(row.key, row.scope);
    for (const merged of mergedByNewKey.values()) {
      insertEntity.run(merged.key, merged.kind, merged.surface, merged.scope, merged.df);
    }

    // Repoint every concept_entities row from each OLD key to its merge target's NEW key.
    for (const merged of mergedByNewKey.values()) {
      for (const oldKey of merged.oldKeys) {
        const rows = ceByOldKey.get(`${oldKey} ${merged.scope}`) ?? [];
        for (const ceRow of rows) {
          deleteCe.run(ceRow.concept_id, oldKey, ceRow.scope);
          insertOrIgnoreCe.run(ceRow.concept_id, merged.key, ceRow.scope);
        }
      }
    }
  });
  tx();

  return { entityCount: entityRows.length, surfaceHits, keyHits, mergedCollisions };
}

/**
 * Prune STALE entity membership — entities that only exist because the extractor split a
 * sensitive multi-token string into individually-unscrubbable fragments BEFORE scrubEntities ever
 * ran. See this script's module doc, "ENTITY FRAGMENT LEAK" section, for the full writeup and
 * verified examples (`id:jane.doe` / `id:example.com` from "jane.doe@example.com";
 * `noun:acme` from "...tenant acme..."). Must run AFTER scrubConceptsAndObservations (needs the
 * already-scrubbed body/content) and AFTER scrubEntities (works against the already-lockstep-
 * scrubbed entities/concept_entities tables, pruning what's left).
 *
 * For each concept: re-extract entities from `[scrubbed body, ...scrubbed observation contents]`
 * (same text-assembly convention engine.ts's own rederiveConceptGraph uses — see its doc comment)
 * plus a `ref:${ref}` synthetic entity per scrubbed source_refs entry (mirroring
 * deriveEntityEdges's own `ref:` derivation). Compare the resulting key set against what
 * concept_entities currently has for that concept: any key attached to the concept but ABSENT
 * from the fresh scrubbed-text extraction is now stale — remove that (concept_id, entity_key)
 * membership row. After all concepts are processed, delete any `entities` row left with zero
 * remaining members (an entity that existed ONLY because of a now-pruned membership).
 *
 * Deliberately narrower than engine.ts's own deriveEntityEdges/rederiveConceptGraph: this
 * function only PRUNES existing concept_entities membership — it never inserts a new
 * concept_entities row, never increments/decrements df beyond what the membership-count naturally
 * implies. This keeps it a pure closure-tightening operation (removing a stale/leaky pointer), not
 * a re-derivation that could change graph structure or reintroduce the "why not MonetCore.store()"
 * concern from this script's module doc.
 *
 * ROUND 5, J3 UPDATE (PR comment id 3522836452): this function's ORIGINAL doc comment (see git
 * history of this exact paragraph) claimed it "never touches memory_edge" — true when written, but
 * an incomplete closure: pruning a concept_entities MEMBERSHIP here does not retroactively un-write
 * the `about`-type memory_edge row(s) deriveEntityEdges (engine.ts) already materialized FROM that
 * membership before scrubbing ever ran. `memory_edge` has NO entity_key column and no stored
 * back-reference at all to which entity justified a given `about` edge (confirmed directly against
 * engine.ts's `CREATE TABLE memory_edge` — src_id/dst_id/type/weight/origin/count/scope, nothing
 * entity-shaped), and `type = 'about'` is written at exactly ONE call site in the whole engine
 * (deriveEntityEdges's own `this.upsertEdgeBoth(conceptId, m, "about", ...)`, itself driven entirely
 * by `coMembers(e.key, ...)` — shared entity membership), so an `about` edge surviving after its
 * justifying membership is pruned is graph STRUCTURE inferred purely from private text that no
 * longer exists anywhere in the scrubbed corpus, reachable via `core.edges()`/`edgeCountsByType()`/
 * the eval's reachability reporting. This function now ALSO removes exactly the `about` edges whose
 * shared-entity justification no longer holds — see pruneOrphanedAboutEdges below, called
 * immediately after this function returns (needs the FINAL, fully-pruned concept_entities state this
 * function itself just produced).
 *
 * ACCEPTED, DOCUMENTED LIMITATION (same "flag it explicitly rather than silently leave it uncaught"
 * discipline scrub-patterns.mjs's own PRIVATE_ENDPOINT_RE doc comment sets as precedent): this
 * prunes entities whose surface text is a SUBSTRING-level fragment of sensitive text once that
 * substring itself contains no pattern-matchable structure. It does NOT and cannot distinguish a
 * genuinely sensitive bare-word fragment (a personal email's local-part, a tenant name) from an
 * ordinary short word that coincidentally matches — it relies entirely on "does re-extracting
 * from the SCRUBBED text still produce this exact entity" as the correctness signal, which is
 * exact and mechanical, not a heuristic judgment call.
 *
 * ROUND 3 ADDITION (F3 fix, PR comment id 3522405281): after ALL per-concept membership pruning
 * above is done, `entities.df` is RECOMPUTED from the surviving concept_entities rows — reusing
 * the exact same idea src/eval/corpus-sample.ts's materializeSampledDb already established for
 * entities.df ("df recomputed from surviving concept_entities rows rather than copied verbatim —
 * copying forward a stale count is dishonest"). WHY THIS WAS A BUG: round 2's prune deleted stale
 * `concept_entities` rows and deleted FULLY orphaned `entities` rows (0 remaining members), but
 * never adjusted `df` for an entity that had SOME (not all) of its memberships pruned — e.g.
 * `id:example.com` legitimately surviving in one concept (ordinary prose) while being pruned from
 * a DIFFERENT concept (where it only existed because of a leaked email) leaves that entity with a
 * `df` that's too high relative to its real remaining membership count. `topEntityHubs()` uses
 * `df` for hub gating/ranking (engine.ts), and the engine's own invariant is `df ==
 * COUNT(concept_entities rows)` — a stale df breaks that invariant and can mis-rank or hide a
 * surviving entity in the scrubbed A4 store.
 *
 * WHY RECOMPUTE EVERY SURVIVING ENTITY UNCONDITIONALLY (not just ones this function's own pruning
 * touched): simplest-and-correct — recomputing every entity's df from ground truth
 * (`COUNT(concept_entities WHERE entity_key = key AND scope = scope)`) is trivially correct
 * regardless of which pruning path caused a discrepancy, is not a hot path at this corpus's scale,
 * and needs no "which entities did I touch" bookkeeping to get right. This also naturally handles
 * the ordering relative to orphan-deletion below: an entity left with 0 remaining memberships gets
 * `df = 0` from this recompute (a fully honest value, since it correctly reflects zero surviving
 * memberships) immediately before the orphan-deletion query removes it — the two operations don't
 * need to be interleaved carefully, since both observe the SAME final, fully-pruned
 * concept_entities state.
 */
function pruneStaleEntities(db) {
  const concepts = db.prepare(`SELECT id, body, source_refs FROM concepts ORDER BY id`).all();
  const deleteMembership = db.prepare(`DELETE FROM concept_entities WHERE concept_id = ? AND entity_key = ? AND scope = ?`);
  let membershipsPruned = 0;
  let conceptsAffected = 0;

  const tx = db.transaction(() => {
    for (const concept of concepts) {
      const obsRows = db.prepare(`SELECT content FROM observations WHERE concept_id = ? ORDER BY created_at`).all(concept.id);
      const text = [concept.body, ...obsRows.map((o) => o.content)].filter(Boolean).join("\n");
      const freshEnts = extractEntities(text);
      const freshKeys = new Set(freshEnts.map((e) => e.key));
      if (concept.source_refs) {
        for (const ref of JSON.parse(concept.source_refs)) freshKeys.add(`ref:${ref}`);
      }

      const currentMemberships = db
        .prepare(`SELECT entity_key, scope FROM concept_entities WHERE concept_id = ?`)
        .all(concept.id);

      let affectedThisConcept = false;
      for (const m of currentMemberships) {
        // Only structural/id/noun/path/err/lib memberships are subject to pruning here — a
        // membership whose key isn't reproducible by a fresh extraction of the SCRUBBED text is
        // stale (it existed only because of unscrubbed content that's now gone).
        if (!freshKeys.has(m.entity_key)) {
          deleteMembership.run(concept.id, m.entity_key, m.scope);
          membershipsPruned += 1;
          affectedThisConcept = true;
        }
      }
      if (affectedThisConcept) conceptsAffected += 1;
    }

    // ROUND 3 (F3 fix): recompute df for EVERY entities row from the now-fully-pruned
    // concept_entities table's ACTUAL remaining membership count — not just the entities this
    // function's own pruning happened to touch (see this function's doc comment for why
    // unconditional recompute is the simpler, more robust choice here). Grouped
    // SELECT-then-loop-UPDATE, matching this file's own established style for multi-row
    // recomputation (mirrors materializeSampledDb's identical df-recompute idea in
    // src/eval/corpus-sample.ts) rather than a correlated-subquery UPDATE, for consistency with
    // this file's existing explicit-JS-loop-inside-a-transaction convention (see scrubEntities).
    const survivingCounts = db
      .prepare(`SELECT entity_key, scope, COUNT(*) AS df FROM concept_entities GROUP BY entity_key, scope`)
      .all();
    const survivingCountByKey = new Map(survivingCounts.map((r) => [`${r.entity_key} ${r.scope}`, r.df]));
    const allEntities = db.prepare(`SELECT key, scope, df FROM entities ORDER BY key, scope`).all();
    const updateDf = db.prepare(`UPDATE entities SET df = ? WHERE key = ? AND scope = ?`);
    let dfRecomputed = 0;
    for (const e of allEntities) {
      const actualDf = survivingCountByKey.get(`${e.key} ${e.scope}`) ?? 0;
      if (actualDf !== e.df) {
        updateDf.run(actualDf, e.key, e.scope);
        dfRecomputed += 1;
      }
    }

    // Any entities row now orphaned (zero remaining concept_entities members — df was just
    // recomputed to 0 for these, immediately above) is deleted — it existed only to back the
    // now-pruned membership(s). Order relative to the df recompute above doesn't matter for
    // correctness (both operations observe the same final, fully-pruned concept_entities state),
    // but running the recompute first means every entities row this DELETE removes was already
    // carrying an honest df=0 the instant before deletion, not a stale positive value.
    const orphaned = db
      .prepare(
        `SELECT e.key AS key, e.scope AS scope FROM entities e
          LEFT JOIN concept_entities ce ON ce.entity_key = e.key AND ce.scope = e.scope
         GROUP BY e.key, e.scope HAVING COUNT(ce.concept_id) = 0`,
      )
      .all();
    const deleteEntity = db.prepare(`DELETE FROM entities WHERE key = ? AND scope = ?`);
    for (const o of orphaned) deleteEntity.run(o.key, o.scope);

    return { orphanedCount: orphaned.length, dfRecomputed };
  });
  const { orphanedCount: entitiesOrphanedAndDeleted, dfRecomputed } = tx();

  return { conceptsScanned: concepts.length, membershipsPruned, conceptsAffected, entitiesOrphanedAndDeleted, dfRecomputed };
}

/**
 * Round 5, J3 fix (PR comment id 3522836452) — remove `memory_edge` rows of type `about` whose
 * shared-entity justification no longer holds after pruneStaleEntities has finished pruning
 * `concept_entities` memberships. MUST run AFTER pruneStaleEntities (needs the FINAL, fully-pruned
 * concept_entities state as the ground truth for "do these two concepts still share a surviving
 * entity") and AFTER scrubEntities (same reason — entity keys must already be in their final,
 * lockstep-scrubbed/merged form before this function's join runs against them).
 *
 * WHY A CO-MEMBERSHIP JOIN, NOT A STORED BACK-REFERENCE: `memory_edge` has no `entity_key` column
 * (confirmed directly against engine.ts's own `CREATE TABLE memory_edge`) and no other stored
 * linkage back to which entity/entities originally justified a given `about` edge — deriveEntityEdges
 * (engine.ts) can in fact accumulate strength across MULTIPLE shared entities before writing a
 * single edge (see that function's own `strength` Map, summed across every co-membership before the
 * final `upsertEdgeBoth` call), so even conceptually there is no single "the" entity to check per
 * edge. The only ground-truth question this function CAN ask, and the one that is actually correct
 * per how deriveEntityEdges derives an `about` edge in the first place, is: "do the two endpoint
 * concepts still share AT LEAST ONE surviving concept_entities membership (same entity_key AND
 * scope), post-prune?" — built from the exact same co-membership shape engine.ts's own coMembers()
 * precedent already uses (`concept_entities a JOIN concept_entities b ON a.entity_key = b.entity_key
 * AND a.scope = b.scope`), just checked for a SPECIFIC pair of concept ids rather than enumerated
 * for one entity key across every co-member.
 *
 * SYMMETRIC EDGES: `about` edges are written via upsertEdgeBoth (engine.ts) — both `(A,B)` and
 * `(B,A)` rows exist for every about-linked pair. This function reads DISTINCT unordered pairs
 * (`src_id < dst_id`, so each pair is considered exactly once regardless of which direction's row
 * is scanned first) and, when a pair fails the co-membership check, deletes BOTH directional rows —
 * never leaving a one-directional "half-edge" that `core.edges()` (which queries by either src_id
 * or dst_id depending on caller) could still surface from one endpoint but not the other.
 *
 * NO DENORMALIZED EDGE-COUNT RECOMPUTATION NEEDED: `edgeCountsByType()` (engine.ts) is a LIVE
 * aggregation query (`SELECT type, COUNT(*) ... GROUP BY type`), not a stored counter — confirmed
 * directly against its definition — so it is self-correcting the instant these DELETEs commit, with
 * no separate recompute step required (unlike entities.df above, which IS a stored, denormalized
 * counter that pruneStaleEntities must explicitly recompute). No other denormalized edge-count
 * exists anywhere in this schema (concepts carries no edge-count column either — confirmed against
 * the full `CREATE TABLE concepts`).
 *
 * SCOPE OF WHAT THIS PRUNES: only `type = 'about'` rows — the only edge type deriveEntityEdges ever
 * writes, and therefore the only edge type whose validity is entirely a function of
 * concept_entities co-membership. Every OTHER edge type (`related`/`nn` origin — vector similarity;
 * `co_occurred` — same-session co-storage; `follows`/`supersedes`/`contradicts`/`resolves`/
 * `derived_from`/`supports`/`part_of` — `origin: "asserted"`, parsed from `#ref` text via
 * deriveAssertedEdges) has a COMPLETELY DIFFERENT justification unrelated to entity membership, so
 * pruning entity memberships has no bearing on whether those edges should survive — narrowing this
 * function's DELETE to `type = 'about'` specifically (not e.g. "every edge touching a concept with
 * ANY pruned membership") is a deliberate precision choice, not an oversight.
 */
function pruneOrphanedAboutEdges(db) {
  const aboutPairs = db
    .prepare(
      `SELECT DISTINCT
         CASE WHEN src_id < dst_id THEN src_id ELSE dst_id END AS a,
         CASE WHEN src_id < dst_id THEN dst_id ELSE src_id END AS b,
         scope
       FROM memory_edge WHERE type = 'about' ORDER BY a, b, scope`,
    )
    .all();

  const coMembershipExists = db.prepare(
    `SELECT 1 FROM concept_entities ce_a
       JOIN concept_entities ce_b ON ce_a.entity_key = ce_b.entity_key AND ce_a.scope = ce_b.scope
      WHERE ce_a.concept_id = ? AND ce_b.concept_id = ? AND ce_a.scope = ?
      LIMIT 1`,
  );
  const deleteEdge = db.prepare(`DELETE FROM memory_edge WHERE src_id = ? AND dst_id = ? AND type = 'about' AND scope = ?`);

  let edgesRemoved = 0;
  let pairsAffected = 0;
  const tx = db.transaction(() => {
    for (const pair of aboutPairs) {
      const stillJustified = coMembershipExists.get(pair.a, pair.b, pair.scope) !== undefined;
      if (!stillJustified) {
        deleteEdge.run(pair.a, pair.b, pair.scope); // A -> B direction
        deleteEdge.run(pair.b, pair.a, pair.scope); // B -> A direction (symmetric edge)
        edgesRemoved += 2;
        pairsAffected += 1;
      }
    }
  });
  tx();

  return { pairsScanned: aboutPairs.length, pairsAffected, edgesRemoved };
}

/** Empty concept_revisions entirely — see this script's module doc, audit finding #4, for why. */
function emptyConceptRevisions(db) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM concept_revisions`).get().n;
  db.prepare(`DELETE FROM concept_revisions`).run();
  return { rowsDeleted: before };
}

/**
 * Scrub first_block.summary, sessions.summary/scope_context/agent_id, contradictions.resolved_by,
 * and memory_edge.dismissed_by. See this script's module doc for why these are grouped together
 * despite different reachability today:
 *   - scope_context is ACTIVELY read (listMemories withProvenance).
 *   - first_block.summary / sessions.summary are pure future-proofing (0 rows in this corpus, no
 *     populating path in this pipeline yet, but first_block.summary in particular is the single
 *     highest-priority prewarm section the instant a row exists).
 *   - sessions.agent_id (round 5, H1 — PR comment id 3522770783) is pure future-proofing on the
 *     SAME basis as sessions.summary: `sessions` is 0 rows in every size of this corpus today (this
 *     pipeline has no path that populates it), but it is a caller-suppliable value with no format
 *     constraint (MonetCoreOptions.agentId, same constructor option round 4's G2 fix scrubbed off
 *     observations.author_agent_id for) — closed for the identical reason, not because a live read
 *     site returns it today.
 *   - contradictions.resolved_by / memory_edge.dismissed_by (round 5, H2 — PR comment id
 *     3522770784) are DIFFERENT from the other four: they are NOT 0 rows today. Both are written by
 *     a caller-suppliable label (`resolvedBy`/`dismissedBy` params on resolveContradiction /
 *     dismissPossibleDuplicate, mcp-server.ts's `resolvedBy` tool field) and this repo's real corpus
 *     already carries live, non-placeholder values in both columns (verified directly against
 *     eval-corpus/db/full/monet.db: contradictions.resolved_by has 6 distinct non-null values
 *     including "John (standing order, 2026-06-27)" and "stig-curation-2026-06-17";
 *     memory_edge.dismissed_by has 4, including "Stig (curate-memory ritual, 2026-06-13)" — none of
 *     which happen to be email/path/secret-shaped, so scrubString is a correctly-behaving no-op on
 *     them today, same as it is on any other non-sensitive-shaped string). Scrubbed defensively
 *     regardless, matching this column family's own "no format constraint on a caller-suppliable
 *     value" closure standard — same standard already applied to author_agent_id (round 4, G2).
 *     Verified NEITHER column has a live verbatim-read-to-caller path today: getOpenContradictions
 *     (engine.ts:1352, the prewarm/agent_context read) selects only
 *     id/conceptId/conceptTitle/kind/detail, never resolved_by; flagContradiction's own
 *     toContradiction(contraRow) return (engine.ts:1248) always fires on a freshly-INSERTed 'open'
 *     row where resolved_by is still NULL by construction (a contradiction cannot be resolved before
 *     it exists); resolveContradiction's own MCP return (mcp-server.ts:885) is a concept-shaped
 *     object (conceptId/status/version/confidence), never the Contradiction/resolvedBy shape at
 *     all. getFirstBlock (engine.ts:2748, the actual prewarm firstBlock read) selects only
 *     id/conceptId/summary/summaryDirty/position/conceptStatus, never promoted_by (first_block also
 *     included below since it's the same audit-label family and shares this function's transaction
 *     already). memory_edge is never read by mcp-server.ts at all (topEntityHubs/topThread read
 *     only entities/concept_entities, never memory_edge rows). All four are closed on the same
 *     "don't rely on today's exact reachability, the column is caller-suppliable text with no shape
 *     constraint" basis as sessions.summary/first_block.summary/author_agent_id before them, not
 *     because of an active read site.
 *   - first_block.promoted_by (round 5, H2) is grouped with resolved_by/dismissed_by as the third
 *     member of the "caller-provided audit label" family the mission named, even though (unlike the
 *     other two) it IS 0 rows today (first_block itself is 0 rows in this corpus — same basis as
 *     first_block.summary above).
 * All seven columns are scrubbed unconditionally on the same "don't rely on today's row
 * count/exact reachability never changing" basis this function has used since round 2.
 */
function scrubFutureProofedColumns(db) {
  let firstBlockHits = 0;
  const fbRows = db.prepare(`SELECT id, summary, promoted_by FROM first_block ORDER BY id`).all();
  const updateFb = db.prepare(`UPDATE first_block SET summary = ?, promoted_by = ? WHERE id = ?`);
  const fbTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbedSummary = scrubString(row.summary);
      const scrubbedPromotedBy = row.promoted_by === null ? null : scrubString(row.promoted_by);
      if (scrubbedSummary !== row.summary || scrubbedPromotedBy !== row.promoted_by) firstBlockHits += 1;
      updateFb.run(scrubbedSummary, scrubbedPromotedBy, row.id);
    }
  });
  fbTx(fbRows);

  let sessionsHits = 0;
  const sessionRows = db.prepare(`SELECT id, summary, scope_context, agent_id FROM sessions ORDER BY id`).all();
  const updateSession = db.prepare(`UPDATE sessions SET summary = ?, scope_context = ?, agent_id = ? WHERE id = ?`);
  const sessionTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbedSummary = row.summary === null ? null : scrubString(row.summary);
      const scrubbedScope = row.scope_context === null ? null : scrubString(row.scope_context);
      // agent_id is `TEXT NOT NULL` (schema, engine.ts) — never null, unlike summary/scope_context —
      // so no null-guard is needed here, unlike the two columns above.
      const scrubbedAgentId = scrubString(row.agent_id);
      if (scrubbedSummary !== row.summary || scrubbedScope !== row.scope_context || scrubbedAgentId !== row.agent_id) {
        sessionsHits += 1;
      }
      updateSession.run(scrubbedSummary, scrubbedScope, scrubbedAgentId, row.id);
    }
  });
  sessionTx(sessionRows);

  let resolvedByHits = 0;
  const contradictionRows = db.prepare(`SELECT id, resolved_by FROM contradictions ORDER BY id`).all();
  const updateContradiction = db.prepare(`UPDATE contradictions SET resolved_by = ? WHERE id = ?`);
  const contradictionTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbed = row.resolved_by === null ? null : scrubString(row.resolved_by);
      if (scrubbed !== row.resolved_by) resolvedByHits += 1;
      updateContradiction.run(scrubbed, row.id);
    }
  });
  contradictionTx(contradictionRows);

  let dismissedByHits = 0;
  // memory_edge has its own TEXT PRIMARY KEY (`id`, engine.ts schema) — use it directly, matching
  // this file's own convention for every other id-keyed table (scrubContradictions, scrubConceptsAndObservations),
  // rather than SQLite's implicit rowid.
  const edgeRows = db.prepare(`SELECT id, dismissed_by FROM memory_edge ORDER BY id`).all();
  const updateEdge = db.prepare(`UPDATE memory_edge SET dismissed_by = ? WHERE id = ?`);
  const edgeTx = db.transaction((rows) => {
    for (const row of rows) {
      const scrubbed = row.dismissed_by === null ? null : scrubString(row.dismissed_by);
      if (scrubbed !== row.dismissed_by) dismissedByHits += 1;
      updateEdge.run(scrubbed, row.id);
    }
  });
  edgeTx(edgeRows);

  return {
    firstBlockCount: fbRows.length,
    firstBlockHits,
    sessionCount: sessionRows.length,
    sessionsHits,
    contradictionCount: contradictionRows.length,
    resolvedByHits,
    memoryEdgeCount: edgeRows.length,
    dismissedByHits,
  };
}

/**
 * Checkpoint a WAL-mode db's pending frames into its main file and force the -wal sidecar empty
 * (TRUNCATE, not the default PASSIVE — PASSIVE only checkpoints what it can without disturbing a
 * concurrent reader/writer and may leave frames behind; TRUNCATE is the mode that guarantees the
 * -wal file is emptied, which this script's determinism/single-file-output guarantee depends on).
 * Throws if the checkpoint doesn't fully succeed (busy=0 frames remaining) rather than silently
 * shipping a possibly-incomplete copy — see this script's module doc's "WAL FIDELITY" section.
 */
function checkpointWal(db, label) {
  const result = db.pragma("wal_checkpoint(TRUNCATE)");
  // better-sqlite3's pragma() returns an array with one row: { busy, log, checkpointed }.
  const row = Array.isArray(result) ? result[0] : result;
  if (row && row.busy !== 0) {
    throw new Error(
      `scrub-db.mjs: wal_checkpoint(TRUNCATE) on ${label} left busy=${row.busy} — the WAL file could ` +
        `not be fully checkpointed (a concurrent connection may be holding a lock). Refusing to treat ` +
        `this as a safe, fully-flushed single-file db.`,
    );
  }
}

/**
 * Rebuild `db`'s ENTIRE file from its live b-tree (round 3, F1 fix — PR comment id 3522115529).
 * SQLite never zeroes a page when a row is UPDATEd/DELETEd — the old bytes sit in freelist/overflow
 * pages until something rewrites the file, so a plain in-place scrub (this script's whole
 * mechanism) can leave pre-scrub email/path/secret text physically recoverable from the published
 * file's RAW BYTES (`strings dbfile | grep`) even though every live-row SELECT looks clean.
 * `VACUUM` is the mechanism that drops those freed pages — it copies every live page into a fresh
 * file, by construction leaving no freed space behind.
 *
 * WHY VACUUM OVER `PRAGMA secure_delete=ON`: secure_delete only prevents FUTURE free-space leakage
 * from the moment it's enabled forward — it does nothing about pages already freed by UPDATE/DELETE
 * operations that ran BEFORE it was turned on. Since every scrub function in this pipeline (in-place
 * UPDATEs on concepts/observations/contradictions/entities/concepts.slug, DELETEs in
 * scrubEntities/pruneStaleEntities/emptyConceptRevisions) already runs before any single vacuum-vs-
 * pragma decision point, correctly enabling secure_delete would require getting its pragma-enable
 * timing exactly right relative to EVERY scrub function (enable it before the FIRST one, and never
 * let any scrub function run before it) — one unconditional VACUUM at the very end, after every
 * scrub step has already run, is more robust because it doesn't depend on that ordering discipline
 * being maintained correctly forever as new scrub steps are added. VACUUM also compacts the file as
 * a side effect (not the primary motivation here, but a reasonable bonus). One correct mechanism is
 * enough — this script does not also enable secure_delete, to avoid two overlapping fixes for the
 * same problem.
 *
 * WHY BARE `VACUUM` (via `db.exec`) RATHER THAN `VACUUM INTO 'other-file'`: both were tried and
 * verified directly against a scratch probe (not assumed). `VACUUM INTO` writes a genuinely fresh
 * file with no journal involvement at all, which reads as conceptually cleaner, but would require
 * this function to VACUUM INTO a temp path and then swap it into place — more moving parts (a temp
 * file, a rename, cleanup on the throw path) for no verified benefit over the simpler alternative:
 * bare `VACUUM` on the open WAL-mode connection, followed by the SAME `checkpointWal()` this
 * function already needs to run afterward anyway (see scrubSizeDb below) to flush VACUUM's own
 * writes out of the WAL and into the main file. VERIFIED EMPIRICALLY: bare `VACUUM` on an open
 * WAL-mode better-sqlite3 connection DOES itself write through the WAL (a scratch probe showed the
 * `-wal` sidecar grow substantially immediately after `db.exec("VACUUM")`, before any checkpoint
 * ran) — so a checkpoint after VACUUM is REQUIRED for the vacuumed content to land in the main
 * file, not optional. Once checkpointing is required either way, bare VACUUM + existing
 * checkpointWal() is simpler than VACUUM INTO + temp-file swap, so that's what this function does.
 * checkpointing is intentionally NOT done inside this function — it stays the caller's
 * responsibility (scrubSizeDb runs vacuumDb() then checkpointWal() explicitly, matching how every
 * other write step in that function is followed by one final checkpoint at the very end, not one
 * per step).
 */
function vacuumDb(db, label) {
  try {
    db.exec("VACUUM");
  } catch (err) {
    throw new Error(`scrub-db.mjs: VACUUM failed on ${label}: ${err.message}`);
  }
}

/**
 * Guard against `--out`/`--db` overlap before ANY destructive operation runs (round 3, F5 fix — PR
 * comment id 3522115534). `main()`'s very first destructive step is `rmSync(outDir, { recursive:
 * true, force: true })` — with no check that `outDir` is disjoint from `dbDir`, a caller passing an
 * overlapping pair (equal paths, `--out` as a PARENT of `--db`, or `--out` NESTED INSIDE `--db`)
 * would destroy some or all of the source derived dbs before this script ever gets to copy them,
 * the exact opposite of the "copy-only, source untouched" guarantee this whole script exists to
 * uphold.
 *
 * NOT the same check as src/eval/corpus-sample.ts's `assertSafeToWipe` — that function checks
 * `outDir` is a strict descendant of a FIXED `repoRoot/eval-corpus` root, a different invariant than
 * "these two specific --db/--out paths, whatever they resolve to, must not overlap each other".
 * Reusing assertSafeToWipe unchanged here would be wrong: it never looks at `dbDir` at all, so it
 * would happily allow `--out=eval-corpus/db` (identical to a `--db=eval-corpus/db` default) straight
 * through, since `eval-corpus/db` genuinely IS a strict descendant of `eval-corpus/`. This function
 * reuses assertSafeToWipe's underlying TECHNIQUE — the `path.relative`-based strict-containment
 * idiom — applied to the actual pair of paths this script needs to compare.
 *
 * Checks three distinct problems, each rejected with its own labeled error:
 *   1. `outDir === dbDir` (identical resolved paths).
 *   2. `outDir` is an ANCESTOR of `dbDir` (`dbDir` is a descendant of `outDir`) — wiping `outDir`
 *      would wipe `dbDir` too. This is Codex's own explicit example ("a parent of --db").
 *   3. `outDir` is a DESCENDANT of `dbDir` (`outDir` is nested inside `dbDir`, e.g.
 *      `--out=eval-corpus/db/25` when `--db=eval-corpus/db`) — this is NOT merely "suspicious", it
 *      is a DIFFERENT, real correctness bug: `main()`'s `readdirSync(dbDir, ...)` sizes-discovery
 *      walk runs AFTER `outDir` has already been wiped-then-recreated (freshly EMPTY) earlier in
 *      `main()` — if `outDir` is literally a subdirectory of `dbDir`, that freshly-emptied
 *      directory would itself be enumerated as a fake, empty "size", which then fails downstream
 *      when the script looks for a `<outDir>/monet.db` as if `outDir` were a SOURCE db under
 *      `dbDir`. Guarded against for that reason, not merely out of caution.
 *
 * Uses `path.relative` in BOTH directions (matching assertSafeToWipe's own idiom): `relative(A, B)`
 * returns a string that does NOT start with `".."` and is not itself absolute exactly when `B` is a
 * descendant of `A` — checking both `relative(outDir, dbDir)` and `relative(dbDir, outDir)` this way
 * (rather than a naive `startsWith()` on the path STRINGS) correctly distinguishes real nesting from
 * a lookalike SIBLING whose name merely starts with the same prefix (e.g. `eval-corpus/db` vs.
 * `eval-corpus/db-backup` — the latter does NOT throw, proven by this function's own test suite,
 * matching the identical "not a string-prefix check" precedent corpus-sample.test.ts already
 * established for assertSafeToWipe).
 */
function assertNoOverlap(dbDir, outDir) {
  if (dbDir === outDir) {
    throw new Error(
      `scrub-db.mjs: --db and --out resolve to the IDENTICAL path (${dbDir}). Refusing to wipe --out ` +
        `before copying, since that would destroy --db too. Pass two disjoint directories.`,
    );
  }

  const relFromOutToDb = relative(outDir, dbDir);
  const outDirIsAncestorOfDbDir = relFromOutToDb !== "" && !relFromOutToDb.startsWith("..") && !isAbsolute(relFromOutToDb);
  if (outDirIsAncestorOfDbDir) {
    throw new Error(
      `scrub-db.mjs: --out (${outDir}) is an ANCESTOR of --db (${dbDir}). Refusing to wipe --out ` +
        `before copying, since that would destroy --db (a parent-of-source --out) too. Pass an --out ` +
        `that does not contain --db.`,
    );
  }

  const relFromDbToOut = relative(dbDir, outDir);
  const outDirIsDescendantOfDbDir = relFromDbToOut !== "" && !relFromDbToOut.startsWith("..") && !isAbsolute(relFromDbToOut);
  if (outDirIsDescendantOfDbDir) {
    throw new Error(
      `scrub-db.mjs: --out (${outDir}) is a DESCENDANT of --db (${dbDir}) — i.e. nested inside it. ` +
        `Refusing: wiping/recreating --out here would leave a spurious empty directory INSIDE --db ` +
        `that the sizes-discovery walk over --db could misidentify as a source size. Pass an --out ` +
        `that is not nested inside --db.`,
    );
  }
}

/**
 * Produce eval-corpus/db-scrubbed/<size>/monet.db from eval-corpus/db/<size>/monet.db:
 *   1. Copy the SOURCE's main file into the destination path via plain synchronous `copyFileSync`
 *      (see this script's module doc's "WAL FIDELITY" section for why a plain file copy, rather
 *      than better-sqlite3's `.backup()` — the latter is async-only and offers no benefit for an
 *      at-rest, no-concurrent-writer source). ALSO copy `srcDbPath-wal`/`srcDbPath-shm` into the
 *      matching destination sidecar paths, IF they exist (existsSync-guarded — a source that
 *      happens to already be fully checkpointed may have no sidecars at all, which is fine). The
 *      SOURCE IS NEVER OPENED FOR WRITE ANYWHERE IN THIS FUNCTION (round 3, F4 fix — round 2 used
 *      to open `srcDbPath` read-write to checkpoint it in place before copying, which rewrote the
 *      source file's own bytes and changed its hash; see module doc's "WAL FIDELITY" + "AUDIT
 *      FINDINGS, ROUND 3" F4 sections for the full history).
 *   2. Open the COPY read-write and CHECKPOINT IT FIRST (TRUNCATE) — this is the step that replays
 *      any committed-but-uncheckpointed frames that arrived via the copied `-wal` sidecar into the
 *      copy's own main file, without the source ever having been touched. This is the ONLY place
 *      `wal_checkpoint(TRUNCATE)` runs against anything derived from `srcDbPath`'s content.
 *   3. Run every scrub function above against the (now fully-flushed) copy: concepts/observations
 *      (title/body/content/author_agent_id + JSON-aware source_refs — round 4, G2 adds
 *      author_agent_id), concepts.slug (regenerated from the scrubbed title — round 3, F2),
 *      concepts.aliases (cleared to NULL — round 4, G1), contradictions.detail,
 *      entities+concept_entities (lockstep), pruneStaleEntities (entity-fragment-leak prune + df
 *      recompute — round 3, F3), concept_revisions (emptied), and the first_block/sessions/
 *      contradictions.resolved_by/memory_edge.dismissed_by columns (round 5, H1/H2 add
 *      sessions.agent_id + contradictions.resolved_by + memory_edge.dismissed_by +
 *      first_block.promoted_by to this last group — see scrubFutureProofedColumns).
 *   4. VACUUM the destination (round 3, F1) — rebuilds the file from the live b-tree, dropping any
 *      freed-page remnants of pre-scrub content the UPDATEs/DELETEs above left on disk.
 *   5. Checkpoint the DESTINATION again (same TRUNCATE discipline) — this time to flush VACUUM's
 *      own WAL writes (verified empirically that bare VACUUM in WAL mode produces WAL frames of its
 *      own — see vacuumDb()'s doc comment) — before closing, so the shipped
 *      eval-corpus/db-scrubbed/<size>/monet.db is one self-contained file with no -shm/-wal
 *      sidecars.
 *   6. Everything not named in an UPDATE/DELETE above (embedding columns, circle_aliases,
 *      memory_edge's own non-dismissed_by columns, every other untouched column on the tables
 *      above) survives byte-for-byte from the copy — no separate preservation step needed.
 */
function scrubSizeDb(srcDbPath, dstDbPath) {
  mkdirSync(dirname(dstDbPath), { recursive: true });

  // Fresh destination every run — if a prior run left a stale dstDbPath (e.g. from a since-changed
  // source), remove it (and any sidecar) first so the copy never appends to/merges with stale
  // content (matching scrub-corpus.mjs's own rmSync-then-mkdirSync "fresh output" discipline one
  // stage up).
  if (existsSync(dstDbPath)) rmSync(dstDbPath, { force: true });
  for (const sidecar of [`${dstDbPath}-wal`, `${dstDbPath}-shm`]) if (existsSync(sidecar)) rmSync(sidecar, { force: true });

  // Step 1 (round 3, F4 fix): copy the source's main file AND its -wal/-shm sidecars (if present)
  // — SOURCE IS NEVER OPENED FOR WRITE. See this function's own doc comment + the module doc's
  // "WAL FIDELITY" section for the full mechanism and why copying the sidecar files together is a
  // safe, well-known SQLite backup technique for an at-rest, no-concurrent-writer source.
  copyFileSync(srcDbPath, dstDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const srcSidecar = `${srcDbPath}${suffix}`;
    if (existsSync(srcSidecar)) copyFileSync(srcSidecar, `${dstDbPath}${suffix}`);
  }

  const db = new Database(dstDbPath);
  try {
    // Step 2 (round 3, F4 fix): checkpoint the COPY — never the source — to replay any frames that
    // arrived via the copied -wal sidecar into the copy's own main file.
    checkpointWal(db, dstDbPath);

    // Step 3: order matters — concepts/observations must be scrubbed FIRST (scrubConceptSlugs
    // needs the scrubbed title; pruneStaleEntities re-extracts from the already-scrubbed
    // body/content), scrubConceptSlugs can run any time after that (independent of the
    // entities-tier functions), and scrubEntities (lockstep key/surface scrub) must run BEFORE
    // pruneStaleEntities (which prunes what's left after the lockstep scrub, working against
    // already-consistent entities/concept_entities rows, and recomputes df from the final,
    // fully-pruned state — round 3, F3). clearConceptAliases (round 4, G1) has no ordering
    // dependency on any other step (it unconditionally nulls a column) — run alongside
    // scrubConceptSlugs since both act on `concepts` and are conceptually linked (slug/alias both
    // derive from — or in alias's case, carry forward — a concept's title-derived identity).
    //
    // Round 5, J1: rewriteAssertedSlugRefsInDb MUST run after scrubConceptSlugs (consumes its
    // renameMap — the old-slug -> new-slug pairs for every regenerated slug this pass). Placed
    // immediately after (before pruneStaleEntities/scrubEntities) is a safe choice, not merely a
    // convenient one: it only reads/writes concepts.body and observations.content, and
    // pruneStaleEntities' own extractEntities pass (see that function's doc comment) never treats
    // a `#ref`-shaped token as extractable entity structure (extractEntities derives
    // email/path/id/noun entities, not asserted-ref tokens) — so whether pruneStaleEntities sees
    // the OLD or NEW slug embedded in a ref token makes no difference to what entities it finds.
    const concepts = scrubConceptsAndObservations(db);
    const slugs = scrubConceptSlugs(db);
    const refRewrites = rewriteAssertedSlugRefsInDb(db, slugs.renameMap);
    const aliases = clearConceptAliases(db);
    const contradictions = scrubContradictions(db);
    const entities = scrubEntities(db);
    const prunedEntities = pruneStaleEntities(db);
    // Round 5, J3: pruneOrphanedAboutEdges MUST run after pruneStaleEntities (needs the FINAL,
    // fully-pruned concept_entities state as ground truth for which about-edges' shared-entity
    // justification still holds — see that function's own doc comment for the full argument).
    const prunedAboutEdges = pruneOrphanedAboutEdges(db);
    const revisions = emptyConceptRevisions(db);
    // scrubContradictions (above) and scrubFutureProofedColumns (below) both touch the
    // `contradictions` table but disjoint columns (detail vs. resolved_by — round 5, H2) — no
    // ordering dependency between them, since neither reads a value the other writes.
    const futureProofed = scrubFutureProofedColumns(db);

    // Round 5, J4: fail loud, immediately, if the disambiguation policy above (scrubConceptSlugs)
    // somehow still let a duplicate (circle, slug) pair through — a real pipeline run should NEVER
    // hit this (see assertSlugsUniquePerCircle's own doc comment for why), so a thrown error here
    // means the disambiguation policy itself has a bug, and this scrub run should not silently ship
    // a scrubbed db with an unresolvable ref-collision baked in.
    assertSlugsUniquePerCircle(db);

    // Step 4 (round 3, F1 fix): VACUUM after every UPDATE/DELETE-based scrub step above has run,
    // to drop freed-page remnants of pre-scrub content — then Step 5, checkpoint again to flush
    // VACUUM's own WAL writes (see vacuumDb()'s doc comment for why a checkpoint is required here,
    // not optional).
    vacuumDb(db, dstDbPath);
    checkpointWal(db, dstDbPath);

    return {
      concepts,
      slugs,
      refRewrites,
      aliases,
      contradictions,
      entities,
      prunedEntities,
      prunedAboutEdges,
      revisions,
      futureProofed,
    };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  let db = "eval-corpus/db";
  let out = "eval-corpus/db-scrubbed";
  for (const arg of argv) {
    if (arg.startsWith("--db=")) db = arg.slice("--db=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
  }
  return { db, out };
}

function main() {
  const { db, out } = parseArgs(process.argv.slice(2));
  const dbDir = resolve(REPO_ROOT, db);
  const outDir = resolve(REPO_ROOT, out);

  if (!existsSync(dbDir)) {
    throw new Error(`derived-db dir not found at ${dbDir}. Run scripts/sample-corpus.ts first.`);
  }

  // Round 3, F5 fix: reject an overlapping --db/--out pair BEFORE any destructive operation runs
  // (the very next line is a recursive rmSync of outDir) — see assertNoOverlap's own doc comment.
  assertNoOverlap(dbDir, outDir);

  // Fresh derivation, same discipline as scrub-corpus.mjs's own outDir handling: wipe any prior
  // run's output so a re-run can't leave stale sibling size-dirs around from a previous, since-
  // changed --db input.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sizes = readdirSync(dbDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`Scrubbing derived dbs for sizes: ${sizes.join(", ")}\n`);

  for (const size of sizes) {
    const srcDbPath = join(dbDir, size, "monet.db");
    if (!existsSync(srcDbPath)) {
      throw new Error(
        `scrub-db.mjs: expected ${srcDbPath} to exist for size "${size}" (every subdirectory of ` +
          `${dbDir} must contain a monet.db, produced by scripts/sample-corpus.ts). Refusing to ` +
          `silently skip a partial size.`,
      );
    }
    const dstDbPath = join(outDir, size, "monet.db");
    const stats = scrubSizeDb(srcDbPath, dstDbPath);
    console.log(
      `[${size}] concepts=${stats.concepts.conceptCount} (title:${stats.concepts.titleHits} body:${stats.concepts.bodyHits} ` +
        `kind:${stats.concepts.conceptKindHits} source_refs:${stats.concepts.conceptRefsHits}) slugs=${stats.slugs.slugsChanged} ` +
        `(collisions:${stats.slugs.collisionsDisambiguated}) ` +
        `refRewrites(body:${stats.refRewrites.bodyRefRewrites} content:${stats.refRewrites.contentRefRewrites}) ` +
        `aliasesCleared=${stats.aliases.aliasesCleared} ` +
        `observations=${stats.concepts.observationCount} ` +
        `(content:${stats.concepts.contentHits} kind:${stats.concepts.obsKindHits} source_refs:${stats.concepts.obsRefsHits} agentId:${stats.concepts.agentIdHits}) ` +
        `contradictions=${stats.contradictions.contradictionCount} (detail:${stats.contradictions.detailHits} ` +
        `resolvedBy:${stats.futureProofed.resolvedByHits}) ` +
        `entities=${stats.entities.entityCount} (surface:${stats.entities.surfaceHits} key:${stats.entities.keyHits} ` +
        `merged:${stats.entities.mergedCollisions}) prunedEntities(memberships:${stats.prunedEntities.membershipsPruned} ` +
        `concepts:${stats.prunedEntities.conceptsAffected} orphanedDeleted:${stats.prunedEntities.entitiesOrphanedAndDeleted} ` +
        `dfRecomputed:${stats.prunedEntities.dfRecomputed}) ` +
        `prunedAboutEdges(pairsScanned:${stats.prunedAboutEdges.pairsScanned} pairsAffected:${stats.prunedAboutEdges.pairsAffected} ` +
        `edgesRemoved:${stats.prunedAboutEdges.edgesRemoved}) ` +
        `concept_revisions deleted=${stats.revisions.rowsDeleted} ` +
        `memory_edge=${stats.futureProofed.memoryEdgeCount}(dismissedBy hits:${stats.futureProofed.dismissedByHits}) ` +
        `first_block=${stats.futureProofed.firstBlockCount}(hits:${stats.futureProofed.firstBlockHits}) ` +
        `sessions=${stats.futureProofed.sessionCount}(hits:${stats.futureProofed.sessionsHits})`,
    );
  }

  console.log(`\nWritten under ${outDir}/<size>/monet.db for sizes: ${sizes.join(", ")}`);
  console.log(
    `\nCAVEAT: embeddings in these scrubbed copies were computed pre-scrub, against the original ` +
      `unscrubbed text (see this script's module doc, "DISCLOSED CAVEAT" section, for the full ` +
      `rationale) — drift is small (short redaction placeholders) and uniform (same fixed ` +
      `placeholder set every time), not recomputed here.`,
  );
}

// Run only when invoked directly (`node scripts/scrub-db.mjs`), never as a side effect of importing
// this module's exported functions elsewhere (same import.meta.url guard scrub-corpus.mjs uses, so
// scrub-db.test.ts can import scrubSizeDb/scrubConceptsAndObservations without running the full
// pipeline as a side effect).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  scrubSizeDb,
  scrubConceptsAndObservations,
  scrubConceptSlugs,
  rewriteAssertedSlugRefsInDb,
  clearConceptAliases,
  scrubContradictions,
  scrubEntities,
  pruneStaleEntities,
  pruneOrphanedAboutEdges,
  emptyConceptRevisions,
  scrubFutureProofedColumns,
  scrubSourceRefsJson,
  checkpointWal,
  vacuumDb,
  assertScopeAlreadyApplied,
  assertSlugsUniquePerCircle,
  assertNoOverlap,
};

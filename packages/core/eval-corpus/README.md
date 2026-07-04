# eval-corpus

Phase 1 corpus derivation pipeline output. **Nothing under this directory is committed to git**
(F8 fix — see PR #35's fix-round history). Every subdirectory here is a derived artifact,
regenerated on demand from a real Monet store copy, and delivered to the eval-runner repo as run
artifacts (CI upload / job output), not tracked in source control.

## Layout

```
eval-corpus/
  source/monet.db          # UNSCRUBBED. A .backup'd, read-only copy of a real store. Never the live store.
  db/<size>/monet.db       # UNSCRUBBED. Derived, self-contained per-size stores (25/50/100/full).
  db-scrubbed/<size>/monet.db  # SCRUBBED COPY of db/<size>/monet.db (see "DB-scrub parity stage" below).
  md/<size>/                # UNSCRUBBED. Steelman md-tree export of each derived store.
  publish/<size>/           # SCRUBBED. Publishable md-tree + corpus.json. The only tier meant to leave this machine.
  SCRUB_MANIFEST.json       # Content-integrity marker for publish/ (sha256 per file + a deterministic contentHash).
```

`source/`, `db/`, and `md/` all hold **unscrubbed** content (real emails, absolute paths, and
whatever secret-shaped strings happen to exist in the source concepts) and must never be
committed or shared as-is — that's what the scrub step exists to fix. Only `publish/` and
`db-scrubbed/` are publishable/deliverable.

## Regenerating

Four commands, run in order from the repo root:

```sh
tsx scripts/sample-corpus.ts        # step 1: subsample source/monet.db -> db/<size>/monet.db
tsx scripts/export-corpus-md.ts     # step 2: export each db/<size>/monet.db -> md/<size>/ (steelman md-tree)
node scripts/scrub-corpus.mjs       # step 3: scrub md/<size>/ -> publish/<size>/, write SCRUB_MANIFEST.json
node scripts/scrub-db.mjs           # step 4: scrub db/<size>/ -> db-scrubbed/<size>/ (db-scrub parity stage)
```

Then verify the scrub marker before treating `publish/` as done:

```sh
node scripts/verify-scrub-marker.mjs
```

This is a hard gate, not a warning — it re-hashes every file under `publish/` and fails loudly
(non-zero exit) on any mismatch, missing file, or missing manifest. (`db-scrubbed/` has no separate
marker file of its own — see "DB-scrub parity stage" below for how its content integrity is instead
verified: byte-identical hashes across repeated runs, plus direct body-text parity against
`publish/<size>/corpus.json`.)

## DB-scrub parity stage (`scripts/scrub-db.mjs`)

**Why this exists:** the eval this corpus feeds runs multiple arms side by side — notably A2 (the
steelman md-tree, sourced from the **scrubbed** `publish/<size>/` tree) and A4 (the real Monet
engine, which would otherwise be pointed at the **unscrubbed** `db/<size>/monet.db`). Without this
stage, A4 would have strictly more information available to it (unredacted emails/paths/secrets)
than A2 — a real confound, not a fair engine-vs-md comparison. `scripts/scrub-db.mjs` closes this by
producing a scrubbed COPY of every per-size db, `db-scrubbed/<size>/monet.db`, so any arm reading
from it sees exactly the same scrubbed content the md-tree arm does.

**ROUND 2 (corrected scope — a prior version of this section was wrong):** the first version of
this stage scrubbed only `concepts.title`/`body` and `observations.content`, and this doc claimed
those were "the only columns that reach agent context." A cold audit re-read `src/engine.ts`
directly and found that claim false — five more surfaces carry unscrubbed text, several of them
reachable through the real MCP surface, not just sitting inertly in the db. The corrected engine
read-surface, with exact `src/engine.ts` / `src/mcp-server.ts` call sites, is enumerated in
`scripts/scrub-db.mjs`'s own module doc ("ENGINE READ-SURFACE ENUMERATION" section) — summary:

| Column(s) | Reaches the engine via | Status |
|---|---|---|
| `concepts.title`/`body`, `observations.content` | search/gather cards, prewarm's top-concepts/workstream lines | scrubbed (round 1) |
| `contradictions.detail` | `getOpenContradictions` → `prewarm()` → rendered into the prewarm block's "Open contradictions" section (only `.slice(0,80)`, not redacted); also full/untruncated via `flagContradiction`'s own response | **scrubbed, round 2** — rows kept, only text scrubbed |
| `concepts.source_refs`, `observations.source_refs` | `toGatherCard` attaches `concepts.source_refs` to every `memory_gather` result | **scrubbed, round 2** — JSON-aware: parse the array, scrub each element, re-serialize (these columns hold a JSON-serialized `string[]`, not free prose) |
| `entities.surface`, `entities.key`, `concept_entities.entity_key` | `topEntityHubs()`/`conceptsForEntity()` (the "#245 what your agent knows" overview, part of `overview()`/`agent_context`) return `key`+`surface` directly | **scrubbed, round 2** — `entities.key` is a denormalized copy joined by value to `concept_entities.entity_key` (no declared FK), so both are scrubbed in lockstep, keyed by old value, with scrub-induced key collisions merged (`df` summed) rather than erroring |
| `first_block.summary` | `getFirstBlock()` → `prewarm()` → rendered FIRST and UNTRUNCATED in the prewarm block | **scrubbed, round 2** — future-proofing (0 rows in this corpus today, since this pipeline never populates `first_block`, but it's the single highest-priority prewarm section the instant a row exists) |
| `sessions.scope_context` | `listMemories()`'s `withProvenance` option (a real, documented `memory_list` MCP parameter) surfaces it verbatim as `provenance` | **scrubbed, round 2** — actively read today, not merely future-proofing; 0 rows in this corpus only because this pipeline doesn't populate `sessions` |
| `sessions.summary` | not currently read by any path that returns it to a caller (write-only) | **scrubbed, round 2** — pure future-proofing, same basis as `first_block.summary` |
| `concept_revisions.body` | never read except `COUNT(*)`/`DELETE` (verified: no `SELECT` anywhere in `src/` returns it to a caller) | **table emptied (`DELETE FROM concept_revisions`) in scrubbed copies, round 2** — not scrubbed in place, since nothing downstream needs prior-version bodies at all |

**A sixth finding, beyond the five above (found while verifying this fix, not part of the original
audit):** the entity *extractor* itself (`extractEntities`, invoked at store time) can split a
sensitive multi-token string into separate single-token entities before any scrub pattern ever sees
them — e.g. `"jane.doe@example.com"` becomes two separate `id`-kind entities, `id:jane.doe` and
`id:example.com`, neither individually email-shaped. `scripts/scrub-db.mjs`'s `pruneStaleEntities`
re-runs the same extraction against each concept's *already-scrubbed* text and prunes any
`concept_entities` membership whose key no longer reproduces (deleting now-orphaned `entities` rows
too) — see that script's own module doc, "ENTITY FRAGMENT LEAK" section, for the full writeup,
verified examples, and the accepted, documented limitation of this fix (it's exact/mechanical, not
a semantic judgment about which bare words are "sensitive enough").

**What it does, full column list:** for each `db/<size>/monet.db`, checkpoints the source (WAL
fidelity, see below), copies the file, then scrubs: `concepts.title`/`body`/`source_refs`,
`observations.content`/`source_refs`, `contradictions.detail`, `entities.surface`/`key` +
`concept_entities.entity_key` (lockstep), `first_block.summary`, `sessions.summary`/`scope_context`
— all through the exact same `scrubString`/`scrubJson` used by `scrub-corpus.mjs` (both import from
the single shared `src/eval/scrub-patterns.mjs`) — then empties `concept_revisions` entirely and
prunes stale entity-fragment membership (see above). Every other column and table — `embedding`,
`memory_edge`, `circle_aliases`, every untouched column on the tables above — is left byte-for-byte
untouched. This remains a targeted column-level scrub, **not** a rebuild: it deliberately does NOT
re-ingest content through `MonetCore.store()`, since that path re-runs dedup/synthesis/contradiction
detection and would silently change which concepts exist and how they're connected, not just what
their text says. (`pruneStaleEntities` is the one operation here that removes rows rather than only
rewriting column values — but it only ever *prunes* existing `concept_entities` membership/orphaned
`entities` rows, never inserts a new edge or membership, so it doesn't carry the same "changes
which concepts exist" risk `MonetCore.store()` would.)

**WAL fidelity:** the source db is WAL-mode. A bare file copy of only the main `.db` file risks
missing rows/updates still sitting in the `-wal` sidecar, uncheckpointed — a silent correctness gap.
`scrub-db.mjs` briefly opens the source read-write, runs `PRAGMA wal_checkpoint(TRUNCATE)`, and
closes it before copying (a checkpoint changes no row's content, only where already-committed bytes
physically live, so this is safe even under the "never mutate the input" discipline this pipeline
follows elsewhere). The same checkpoint runs on the destination before it's closed, so
`db-scrubbed/<size>/monet.db` always ships as one self-contained file with no `-shm`/`-wal`
sidecars.

**Disclosed caveat:** embeddings (`concepts.embedding`, `observations.embedding`) were computed
**before** this scrub pass ran, against the original unscrubbed text — they are not recomputed here.
An embedding therefore corresponds to a slightly different string than what's now stored in the
scrubbed columns (the scrubbed string, with a redaction placeholder substituted in). This is
accepted as negligible: scrub deltas are small (a short substring replaced by a short opaque
placeholder like `[redacted-email]`), uniform in shape (the same handful of fixed placeholder forms
every time), and this mirrors the exact same accepted trade `scrub-corpus.mjs`'s own
`corpus.json` dump already makes (it reads straight from the unscrubbed derived db and scrubs the
*output*, so its embeddings vs. text have always had this same relationship) — this stage extends an
already-accepted trade to a second artifact, not a new risk category.

**Determinism:** verified directly — two full runs of `scripts/scrub-db.mjs` against the same
`db/<size>/monet.db` inputs produce byte-identical `db-scrubbed/<size>/monet.db` output files
(same sha256 per size, both runs). `scrubString`/`scrubJson` are pure functions of their input with
no randomness or wall-clock reads, and every row is scrubbed independently keyed by primary key
(the WAL checkpoint changes no row's content, only its physical location, so it doesn't threaten
this guarantee either), so this holds for any source content, not just the current corpus.

**Parity with `publish/`:** because both `scrub-corpus.mjs`'s `corpus.json` dump and
`scrub-db.mjs`'s in-place update apply the identical `scrubString` to the identical source
`concepts.body` value, a sampled concept's body text in `publish/<size>/corpus.json` is always
byte-identical to the same concept's `body` in `db-scrubbed/<size>/monet.db` — verified directly
against 5 concepts per size (20 total) across all four sizes, 0 mismatches.

**The durable closure guard (`src/__tests__/scrub-db-closure.test.ts`):** rather than trust a
hand-maintained list of "which columns are sensitive" to stay complete, a schema-driven test walks
every table and every TEXT-affinity column in the scrubbed output at runtime (via
`sqlite_master`/`PRAGMA table_info`, not a hardcoded list) and asserts zero of `scrubString`'s
pattern classes match anywhere. It is proven non-vacuous (it correctly *fails* against a
deliberately unscrubbed fixture, and against a reconstruction of this stage's original 3-column-only
behavior, before asserting it passes against the fixed output) and includes a meta-test proving it
would catch a brand-new, never-anticipated column added to the schema in the future. This is meant
to be the one guarantee that survives this doc/script going stale again.

## Scope

Corpus scope is **Monet circles only** (`src/eval/corpus-scope.mjs`'s `CORPUS_CIRCLES`, currently
`["example-circle", "with-monet"]`) — not every circle in the source store. This is the single shared
scope definition every pipeline stage that needs to know "which concepts count" imports from,
rather than three independently-hand-copied WHERE clauses. Sweep sizes are 25/50/100/FULL, where
FULL is whatever `corpusScopeWhereFragment()` resolves to against the real source db at run time
(currently 172 concepts: example-circle=166 + with-monet=6) — never a hardcoded number.

## Requires a source copy

`source/monet.db` must exist before running the pipeline — it is not generated by any script here
(by design: this pipeline never touches the live store, only a caller-provided `.backup`'d
read-only copy). See `scripts/sample-corpus.ts`'s module doc for the safety rule.

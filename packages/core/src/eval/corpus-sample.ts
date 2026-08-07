/**
 * Phase 1 corpus subsampler — derives self-contained, Monet-compatible `.db` files at the
 * scale-sweep sizes (spec §3.4: 25/50/100/200[/FULL]) from a real store copy.
 *
 * WHY THIS EXISTS: the scale sweep needs matched corpora at increasing sizes so the later
 * benchmark (built by a separate, walled-off actor — this module has no visibility into that
 * work and must stay that way) can compare Monet against a steelman md-tree as knowledge volume
 * grows. This module only produces the DATA (sampled `.db` files); it derives NOTHING about how
 * that data will be scored.
 *
 * SAFETY: this module NEVER opens `~/.monet/monet.db` (the live store) — it only ever reads from
 * a caller-supplied SOURCE `.db` path, which by repo convention is a `.backup`'d read-only copy
 * (see eval-corpus/source/monet.db). If a caller passes the live store path here, that is a bug
 * in the CALLER, not something this module tries to detect or guard (detecting "is this the live
 * path" would require hardcoding a path this module has no business knowing).
 *
 * SCOPE DECISION — F4 fix (USER DECISION, superseding this module's original "sample across ALL
 * circles" choice): corpus scope is now MONET CIRCLES ONLY, defined once in corpus-scope.mjs's
 * `CORPUS_CIRCLES` (currently `["example-circle", "with-monet"]`) and consumed here via
 * `corpusScopeWhereFragment()` — never a hand-duplicated circle list or WHERE clause. Verified via
 * direct sqlite3 query against the real source db: example-circle=166 + with-monet=6 = 172 eligible
 * concepts (kind != 'workstream'), out of 323 total across all 11 circles in the store. The sweep
 * sizes are 25/50/100/FULL, where FULL is now 172 (whatever `corpusScopeWhereFragment()` resolves
 * to at run time against the real source db — never a hardcoded 172, same "never hardcode FULL"
 * convention this module already followed for the un-scoped count).
 *
 * WHY THE SCOPE NARROWED (superseding the prior "sample across all circles" rationale, kept here
 * for history): the original decision sampled across the whole store's 323 concepts (11 circles)
 * specifically because scoping to example-circle alone (166) fell short of the previously-proposed
 * 200-size sweep point, and the scale sweep's question — "how does retrieval degrade/improve as
 * RAW CONCEPT VOLUME grows" — was judged to be about corpus SIZE, not topical coherence. That
 * tradeoff (mixing several unrelated projects' concepts into one synthetic circle) is no longer
 * accepted: the user's explicit call is that the corpus must represent Monet's OWN memory
 * (example-circle + with-monet — the circles that describe Monet itself, its build, and its docs) rather
 * than an artificially inflated cross-project mix assembled only to hit a round sweep number. The
 * 200-size sweep point is dropped (172 < 200; the sweep tops out at the real monet-scoped count,
 * per this pipeline's existing "never pad with synthetic content" principle — see
 * scripts/sample-corpus.ts's own console output for the analogous FULL-shortfall notice). Every
 * sampled concept is still RE-CIRCLED to a single fixed output circle (`SAMPLED_CIRCLE` below) in
 * the derived .db, so the derived store behaves exactly like a single-project store to every
 * circle-scoped engine call (allConceptsForExport, edges(), search()) — unchanged from
 * before, this part of the design wasn't scope-dependent.
 *
 * STRATIFICATION — kind × recency, proportional allocation (documented per the mission's request
 * for a precisely-reproducible description):
 *   1. Partition the FULL eligible set (kind != 'workstream', AND circle-scoped per the SCOPE
 *      DECISION above) into buckets by `kind`.
 *   2. Within each kind-bucket, sort by `updated_at` DESCENDING and split into recency TERCILES
 *      (the newest third, middle third, oldest third of that kind's own concepts — NOT global
 *      terciles, so a kind with few members still gets its own newest/middle/oldest spread
 *      rather than being swamped by a numerically bigger kind's age distribution). A bucket with
 *      fewer than 3 members puts all of its members in the newest tercile cell (there's no
 *      meaningful 3-way split of 1-2 items) — this is the only special-case in the split step.
 *   3. This produces up to `3 * (number of distinct kinds)` STRATUM CELLS, each
 *      `(kind, recencyTercile) → concept id list`.
 *   4. TARGET ALLOCATION per cell = `round(cellSize / fullEligibleSize * sampleSize)` — i.e. each
 *      cell is sampled proportionally to its share of the FULL eligible population, so the
 *      sampled sub-corpus preserves the full store's kind distribution AND recency spread rather
 *      than e.g. only ever sampling the newest 25 facts or only ever sampling one kind.
 *   5. Because step 4's per-cell roundings don't sum exactly to `sampleSize` (classic
 *      largest-remainder problem), allocations are corrected deterministically: compute the
 *      floor allocation per cell, then distribute the remaining `sampleSize - sum(floors)` slots
 *      one at a time to the cells with the LARGEST fractional remainder. Ties on remainder are
 *      broken by SMALLEST cell size first (a small cell's raw share is disproportionately likely
 *      to floor to 0 and tie on remainder with a much bigger cell — e.g. a 1-member cell and a
 *      99-member cell can both floor-remainder to exactly 0.5 — so smallest-size-first ensures a
 *      small nonzero-share cell isn't arbitrarily zeroed out by losing a coin-flip to a
 *      capacity-rich cell that doesn't need the rounding help), then by a stable cell key sort
 *      (`${kind}::${tercile}` — never by insertion order, which is not guaranteed stable across
 *      engines) as the final, fully-deterministic tie-break. This is the textbook
 *      Hamilton/largest-remainder apportionment method, applied here to sampling quotas instead
 *      of legislative seats, with the smallest-cell-first tie-break added on top.
 *   6. UNDERSIZED-CELL FALLBACK: if a cell's target allocation exceeds its actual member count
 *      (small kinds, e.g. `user` has only 1 member store-wide), the cell contributes ALL its
 *      members and the shortfall is redistributed: recompute allocations for the remaining
 *      "not yet exhausted" cells using the SAME largest-remainder method against the reduced
 *      target (`sampleSize - alreadyTakenFromExhaustedCells`), restricted to cells with spare
 *      capacity. This can iterate more than once at small sample sizes (e.g. sampleSize=25 with
 *      many singleton kinds) — implemented as a loop that terminates because each iteration
 *      strictly shrinks the set of non-exhausted cells or fully allocates the remaining target.
 *   7. Within each cell, which specific members are chosen (when the cell's target is less than
 *      its member count) is decided by a SEEDED deterministic shuffle (mulberry32 PRNG, fixed
 *      seed constant) of that cell's member-id list, then taking the first N — never
 *      `Math.random()`, so the same source store always produces byte-identical sample id sets.
 *
 * "FULL" = every eligible concept (no sampling at all) — used for the size-4 sweep point. This
 * module does not hardcode 172 (or any other count); it is whatever `SELECT COUNT(*) FROM concepts
 * WHERE kind != 'workstream' AND <corpusScopeWhereFragment()>` returns from the actual source db at
 * run time, so a source db update (or a future CORPUS_CIRCLES change) changes FULL automatically
 * rather than silently going stale against a hardcoded literal.
 */
import Database from "better-sqlite3";
import { isAbsolute, join, relative } from "node:path";
import { MonetCore } from "../engine";
import { corpusScopeWhereFragment, SAMPLED_CIRCLE } from "./corpus-scope.mjs";

/**
 * Every sampled concept is re-circled here in the derived .db (see module doc for why).
 * Re-exported from corpus-scope.mjs (its actual home, alongside CORPUS_CIRCLES — see that file's
 * doc comment) so existing consumers (export-corpus-md.ts, corpus-sample.test.ts) keep importing
 * from this module without needing to change their import source.
 */
export { SAMPLED_CIRCLE };

/**
 * P2-a fix (round 2 review): guards scripts/sample-corpus.ts's `main()` recursive delete of its
 * user-supplied `--out` directory. Lives HERE (not defined inline in the script) rather than in
 * scripts/sample-corpus.ts itself for the same reason materializeSampledDb/deriveAllSizes/etc. all
 * live here instead of in the script: scripts/sample-corpus.ts calls `main()` unconditionally at
 * import time (no import.meta.url-guarded entry point the way scrub-corpus.mjs has), so importing
 * that script directly from a test would execute the full pipeline as a side effect. This module,
 * by contrast, exports pure functions with no top-level side effects and already has its own
 * dedicated test file (corpus-sample.test.ts) — the natural, safely-importable home for this
 * pure/testable check too.
 *
 * Before this fix, `main()` ran `rmSync(outDir, { recursive: true, force: true })` whenever
 * `outDir` already existed, with NO check that the resolved path was actually the expected
 * derived-db location — since `--out` is fully user-supplied, an invocation like
 * `--out=eval-corpus` (the shared PARENT of source/db/md, one level too high) or `--out=.` (the
 * repo root) would wipe the source corpus directory or the entire checkout instead of failing
 * fast. Same "belt-and-suspenders script-level guard" philosophy as the script's own
 * assertNotLiveStore (defense-in-depth for a destructive-write footgun, this time, rather than a
 * destructive-read one).
 *
 * Requires the resolved `outDir` to be a STRICT DESCENDANT of `repoRoot/eval-corpus/` — not equal
 * to it, since `--out=eval-corpus` itself must still be refused (wiping the shared parent of
 * source/db/md would destroy the untouched source corpus alongside the derived db this script
 * actually owns). Uses `path.relative` rather than a string-prefix check so a lookalike sibling
 * directory (e.g. `eval-corpus-backup`) can never be mistaken for a real descendant the way a
 * naive `startsWith("eval-corpus")` check would.
 *
 * @param outDir - already-resolved (absolute) candidate output directory.
 * @param repoRoot - already-resolved (absolute) repository root.
 * @throws if `outDir` is not a strict descendant of `repoRoot/eval-corpus`.
 */
export function assertSafeToWipe(outDir: string, repoRoot: string): void {
  const expectedRoot = join(repoRoot, "eval-corpus");
  const rel = relative(expectedRoot, outDir);
  const isStrictDescendant = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!isStrictDescendant) {
    throw new Error(
      `Refusing to recursively delete ${outDir}: it is not a descendant of the expected ` +
        `derivation root (${expectedRoot}). --out must resolve to a path strictly inside ` +
        `eval-corpus/ (e.g. the default eval-corpus/db) — refusing rather than wiping ` +
        `${outDir === expectedRoot ? "eval-corpus/ itself (the shared parent of source/db/md)" : "an unexpected location"}.`,
    );
  }
}

/** Fixed seed constant — changing this changes every derived sample's exact membership. Never derive from wall-clock time. */
const SAMPLE_SEED = 0x6d6f6e65; // "mone" in hex, arbitrary but fixed and documented

export const SWEEP_SIZES = [25, 50, 100] as const;
/** Directory-name / label used for the FULL (unsampled) sweep point. */
export const FULL_LABEL = "full";

interface RawConceptRow {
  id: string;
  kind: string;
  updated_at: number;
}

export interface StratumCell {
  kind: string;
  tercile: 0 | 1 | 2; // 0 = newest third, 1 = middle third, 2 = oldest third (within this kind)
  memberIds: string[]; // all eligible concept ids in this cell, from the FULL source
}

export interface SampleSelection {
  sampleSize: number;
  /** Requested size vs. what was actually achievable (only differs when sampleSize > full eligible count). */
  achievedSize: number;
  selectedIds: string[]; // sorted for determinism
  /** Per-cell diagnostic: how many were available vs. how many were taken. */
  cellAllocations: Array<{ kind: string; tercile: number; available: number; taken: number }>;
}

// ── Deterministic PRNG (mulberry32) — no Math.random() anywhere in the sampling path ─────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates shuffle driven by the given PRNG — in place, returns the same array for convenience. */
function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Stratification ────────────────────────────────────────────────────────────────────────────

/** Bucket eligible rows by kind, then split each kind-bucket into recency terciles (newest-first). */
export function buildStrata(rows: RawConceptRow[]): StratumCell[] {
  const byKind = new Map<string, RawConceptRow[]>();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(r);
  }

  const cells: StratumCell[] = [];
  for (const [kind, members] of byKind) {
    const sorted = [...members].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? -1 : 1));
    if (sorted.length < 3) {
      // Too few to split meaningfully — all land in the newest tercile cell (documented in module doc, step 2).
      cells.push({ kind, tercile: 0, memberIds: sorted.map((r) => r.id) });
      continue;
    }
    const third = Math.ceil(sorted.length / 3);
    const buckets: RawConceptRow[][] = [sorted.slice(0, third), sorted.slice(third, third * 2), sorted.slice(third * 2)];
    buckets.forEach((bucket, i) => {
      if (bucket.length > 0) cells.push({ kind, tercile: i as 0 | 1 | 2, memberIds: bucket.map((r) => r.id) });
    });
  }
  // Stable, content-derived ordering (never insertion order) so downstream largest-remainder
  // tie-breaking is reproducible regardless of Map iteration order across engines/versions.
  cells.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.tercile - b.tercile));
  return cells;
}

/**
 * Largest-remainder (Hamilton) apportionment with undersized-cell fallback (module doc steps
 * 4-6). Returns, per cell, how many members to take — always <= that cell's available count,
 * and the total taken always equals `min(sampleSize, totalAvailable)`.
 */
export function allocateQuotas(cells: StratumCell[], sampleSize: number): Map<string, number> {
  const cellKey = (c: StratumCell): string => `${c.kind}::${c.tercile}`;
  const totalAvailable = cells.reduce((a, c) => a + c.memberIds.length, 0);
  const target = Math.min(sampleSize, totalAvailable);

  const taken = new Map<string, number>(cells.map((c) => [cellKey(c), 0]));
  const exhausted = new Set<string>();
  let remainingTarget = target;
  let activeCells = cells.filter((c) => c.memberIds.length > 0);

  // Loop terminates because each iteration either fully allocates remainingTarget (checked at
  // the top) or moves at least one cell from active→exhausted (a cell whose floor+remainder
  // share hits its capacity) — and there are finitely many cells to exhaust.
  while (remainingTarget > 0 && activeCells.length > 0) {
    const totalActiveAvailable = activeCells.reduce((a, c) => a + c.memberIds.length, 0);
    const rawShares = activeCells.map((c) => ({
      cell: c,
      raw: totalActiveAvailable > 0 ? (c.memberIds.length / totalActiveAvailable) * remainingTarget : 0,
    }));
    const floors = rawShares.map(({ cell, raw }) => ({ cell, floor: Math.floor(raw), frac: raw - Math.floor(raw) }));
    let allocatedThisRound = floors.reduce((a, f) => a + f.floor, 0);
    let leftover = remainingTarget - allocatedThisRound;

    // Distribute leftover slots to the largest fractional remainders. Tie-break, in order:
    // (1) SMALLER cell (fewer members) wins — a tiny cell's raw share is more likely to floor to
    //     0 in the first place (a 1-member cell with a 0.5 raw share ties on remainder with a
    //     99-member cell that also happens to floor-remainder 0.5), and a plain alphabetical
    //     tie-break would let capacity-rich cells win that coin-flip purely by cellKey ordering,
    //     silently zeroing out a small-but-nonzero-share cell (found via
    //     corpus-sample.test.ts's "caps a cell at its member count and redistributes..." case:
    //     tiny=1/big=99 at target 50 gave tiny=0 under a pure alphabetical tie-break, contradicting
    //     this function's own "undersized-cell fallback" contract, which is about EVERY cell with
    //     spare capacity getting its fair rounding treatment, not just cells that win alphabetically).
    // (2) cellKey (stable, content-derived — never insertion/Map order) as the final tie-break
    //     when member counts also tie, so ordering is still fully deterministic.
    const byFrac = [...floors].sort(
      (a, b) => b.frac - a.frac || a.cell.memberIds.length - b.cell.memberIds.length || (cellKey(a.cell) < cellKey(b.cell) ? -1 : 1),
    );
    const bonus = new Map<string, number>();
    for (let i = 0; i < leftover && i < byFrac.length; i++) {
      const k = cellKey(byFrac[i].cell);
      bonus.set(k, (bonus.get(k) ?? 0) + 1);
    }

    let anyCappedThisRound = false;
    const stillActive: StratumCell[] = [];
    for (const { cell, floor } of floors) {
      const k = cellKey(cell);
      const proposed = floor + (bonus.get(k) ?? 0);
      const capacity = cell.memberIds.length - (taken.get(k) ?? 0);
      const actual = Math.min(proposed, capacity);
      taken.set(k, (taken.get(k) ?? 0) + actual);
      remainingTarget -= actual;
      if (actual < proposed || capacity === actual) {
        // This cell hit its capacity ceiling this round — exhausted, remove from further rounds.
        if (capacity === actual && actual > 0) anyCappedThisRound = true;
        exhausted.add(k);
      } else {
        stillActive.push(cell);
      }
    }
    activeCells = stillActive.filter((c) => !exhausted.has(cellKey(c)));

    // Safety valve: if nothing was capped and nothing remains active but remainingTarget > 0,
    // break rather than loop forever (shouldn't happen given totalAvailable >= target, but
    // guards against a future refactor introducing an infinite loop silently).
    if (!anyCappedThisRound && activeCells.length === 0) break;
  }

  return taken;
}

/** Deterministically select `selected` from `cell.memberIds` via seeded shuffle (module doc step 7). */
function selectFromCell(cell: StratumCell, take: number, rng: () => number): string[] {
  const shuffled = seededShuffle([...cell.memberIds], rng);
  return shuffled.slice(0, take).sort();
}

/**
 * Full stratified sample selection for one sweep size. Deterministic: same source rows + same
 * sampleSize always produce the same selectedIds, in any environment (fixed seed, no wall-clock,
 * no Math.random()).
 */
export function selectSample(rows: RawConceptRow[], sampleSize: number): SampleSelection {
  const cells = buildStrata(rows);
  const quotas = allocateQuotas(cells, sampleSize);
  const rng = mulberry32(SAMPLE_SEED);

  const selectedIds: string[] = [];
  const cellAllocations: SampleSelection["cellAllocations"] = [];
  // Cells are already sorted deterministically by buildStrata (kind, tercile) — iterate in that
  // same order so which cell "consumes" how much of the shared rng stream is itself deterministic
  // and reproducible (rng is a single shared stream across cells, consumed in stable cell order).
  for (const cell of cells) {
    const key = `${cell.kind}::${cell.tercile}`;
    const take = quotas.get(key) ?? 0;
    const picked = selectFromCell(cell, take, rng);
    selectedIds.push(...picked);
    cellAllocations.push({ kind: cell.kind, tercile: cell.tercile, available: cell.memberIds.length, taken: picked.length });
  }
  selectedIds.sort();

  return { sampleSize, achievedSize: selectedIds.length, selectedIds, cellAllocations };
}

// ── Self-contained .db materialization ────────────────────────────────────────────────────────

export interface MaterializeResult {
  outPath: string;
  conceptCount: number;
  edgeCount: number;
  observationCount: number;
  /** Diagnostic only (not written into the derived schema) — which source circles contributed, and how many concepts each. */
  sourceCircleCounts: Record<string, number>;
}

/**
 * Build a fresh, self-contained Monet-compatible .db at `outPath` containing exactly the
 * concepts in `selectedIds` (read from `sourceDbPath`), re-circled to SAMPLED_CIRCLE, plus every
 * dependent row (edges/observations/revisions/contradictions/concept_entities) whose FK targets
 * survive the selection — dropping anything that would otherwise dangle.
 *
 * DROPPED ENTIRELY (not carried into the derived store, and why):
 *   - `sessions`   — session rows aren't FK'd to a circle or a concept set in a way that survives
 *                    a cross-circle re-sample; they describe REAL session history that has no
 *                    honest meaning once concepts are pulled from 11 different original circles
 *                    into one synthetic "sampled" circle.
 *   - `first_block`— a promoted concept may not even be in the sample; carrying a first_block row
 *                    whose concept_id doesn't exist in the derived store would be exactly the
 *                    dangling-reference bug this function exists to avoid, and there is no honest
 *                    way to "re-promote" a first_block entry into a re-circled sample.
 *   - `circle_aliases` — circle-identity plumbing for the SOURCE store's own original circle
 *                    names, meaningless once everything is re-circled to one name.
 *
 * `entities.df` (per-scope concept frequency) is RECOMPUTED from the surviving concept_entities
 * rows rather than copied verbatim — copying the source df would silently carry a frequency count
 * computed against the FULL store's ~323-concept population into a store that might have only 25
 * concepts, which is not an honest df for the derived store.
 */
export function materializeSampledDb(sourceDbPath: string, outPath: string, selectedIds: string[]): MaterializeResult {
  const idSet = new Set(selectedIds);
  const source = new Database(sourceDbPath, { readonly: true });

  try {
    // 1. Fresh empty db with the current engine schema (init() + migrate() are idempotent
    //    CREATE-IF-NOT-EXISTS, so constructing a MonetCore here is the single source of truth for
    //    the target DDL — never a hand-duplicated CREATE TABLE list that could drift from engine.ts).
    const scaffold = new MonetCore(outPath);
    scaffold.close();

    const dest = new Database(outPath);
    try {
      dest.pragma("foreign_keys = OFF"); // no declared FKs in this schema; explicit for clarity, not load-bearing

      const conceptRows = source
        .prepare(`SELECT * FROM concepts WHERE id IN (${idSet.size ? selectedIds.map(() => "?").join(",") : "NULL"})`)
        .all(...selectedIds) as Array<Record<string, unknown>>;

      const sourceCircleCounts: Record<string, number> = {};
      const insertConcept = dest.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding, support_count, version, dirty, usefulness_score, created_at, updated_at, source_refs, aliases, last_confirmed_at, last_confirmed_session_id, usefulness_last_fetched_at, arousal_score, arousal_last_updated_at)
         VALUES (@id, @slug, @title, @body, @kind, @status, @confidence, @circle, @embedding, @support_count, @version, @dirty, @usefulness_score, @created_at, @updated_at, @source_refs, @aliases, @last_confirmed_at, @last_confirmed_session_id, @usefulness_last_fetched_at, @arousal_score, @arousal_last_updated_at)`,
      );
      const insertConceptTx = dest.transaction((rows: Array<Record<string, unknown>>) => {
        for (const r of rows) {
          sourceCircleCounts[r.circle as string] = (sourceCircleCounts[r.circle as string] ?? 0) + 1;
          insertConcept.run({ ...r, circle: SAMPLED_CIRCLE });
        }
      });
      insertConceptTx(conceptRows);

      // 2. Dependent rows, FK-filtered against idSet — never carried verbatim.
      const inClause = idSet.size ? selectedIds.map(() => "?").join(",") : "NULL";

      const edgeRows = source
        .prepare(`SELECT * FROM memory_edge WHERE src_id IN (${inClause}) AND dst_id IN (${inClause})`)
        .all(...selectedIds, ...selectedIds) as Array<Record<string, unknown>>;
      const insertEdge = dest.prepare(
        `INSERT INTO memory_edge (id, src_id, src_type, dst_id, dst_type, type, weight, origin, count, created_at, last_reinforced_at, scope, dismissed_at, dismissed_by)
         VALUES (@id, @src_id, @src_type, @dst_id, @dst_type, @type, @weight, @origin, @count, @created_at, @last_reinforced_at, @scope, @dismissed_at, @dismissed_by)`,
      );
      dest.transaction((rows: Array<Record<string, unknown>>) => {
        for (const r of rows) insertEdge.run({ ...r, scope: SAMPLED_CIRCLE });
      })(edgeRows);

      const obsRows = source
        .prepare(`SELECT * FROM observations WHERE concept_id IN (${inClause}) OR concept_id IS NULL`)
        .all(...selectedIds) as Array<Record<string, unknown>>;
      const insertObs = dest.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, superseded_by, session_id, author_agent_id, created_at, source_refs)
         VALUES (@id, @content, @embedding, @kind, @circle, @concept_id, @superseded_by, @session_id, @author_agent_id, @created_at, @source_refs)`,
      );
      dest.transaction((rows: Array<Record<string, unknown>>) => {
        for (const r of rows) insertObs.run({ ...r, circle: SAMPLED_CIRCLE });
      })(obsRows);

      const revRows = source.prepare(`SELECT * FROM concept_revisions WHERE concept_id IN (${inClause})`).all(...selectedIds) as Array<
        Record<string, unknown>
      >;
      const insertRev = dest.prepare(
        `INSERT INTO concept_revisions (id, concept_id, version, body, trigger_observation_id, created_at) VALUES (@id, @concept_id, @version, @body, @trigger_observation_id, @created_at)`,
      );
      dest.transaction((rows: Array<Record<string, unknown>>) => {
        for (const r of rows) insertRev.run(r);
      })(revRows);

      const contraRows = source.prepare(`SELECT * FROM contradictions WHERE concept_id IN (${inClause})`).all(...selectedIds) as Array<
        Record<string, unknown>
      >;
      const insertContra = dest.prepare(
        `INSERT INTO contradictions (id, concept_id, observation_id, kind, status, detail, resolution_obs_id, contradicted_observation_id, detected_at, resolved_at, resolved_by)
         VALUES (@id, @concept_id, @observation_id, @kind, @status, @detail, @resolution_obs_id, @contradicted_observation_id, @detected_at, @resolved_at, @resolved_by)`,
      );
      dest.transaction((rows: Array<Record<string, unknown>>) => {
        // The destination always carries the current schema (it is scaffolded by MonetCore above),
        // but a SOURCE database written before contradicted_observation_id existed has no such
        // column, so `SELECT *` omits the key and the named parameter would be unbound. Default it
        // here rather than branching the statement on the source's shape.
        for (const r of rows) insertContra.run({ ...r, contradicted_observation_id: r.contradicted_observation_id ?? null });
      })(contraRows);

      const ceRows = source.prepare(`SELECT * FROM concept_entities WHERE concept_id IN (${inClause})`).all(...selectedIds) as Array<
        Record<string, unknown>
      >;
      const insertCe = dest.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (@concept_id, @entity_key, @scope)`);
      dest.transaction((rows: Array<Record<string, unknown>>) => {
        for (const r of rows) insertCe.run({ ...r, scope: SAMPLED_CIRCLE });
      })(ceRows);

      // entities: re-derived, not copied (df recomputed against the SURVIVING concept_entities
      // rows just inserted — see function doc for why copying source df would be dishonest here).
      const survivingEntityKeys = dest.prepare(`SELECT entity_key, COUNT(*) AS df FROM concept_entities WHERE scope = ? GROUP BY entity_key`).all(SAMPLED_CIRCLE) as Array<{
        entity_key: string;
        df: number;
      }>;
      if (survivingEntityKeys.length > 0) {
        const keySet = survivingEntityKeys.map((r) => r.entity_key);
        const entityMeta = source
          .prepare(`SELECT DISTINCT key, kind, surface FROM entities WHERE key IN (${keySet.map(() => "?").join(",")})`)
          .all(...keySet) as Array<{ key: string; kind: string; surface: string }>;
        const metaByKey = new Map(entityMeta.map((m) => [m.key, m]));
        const insertEntity = dest.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (@key, @kind, @surface, @scope, @df)`);
        dest.transaction((rows: Array<{ entity_key: string; df: number }>) => {
          for (const r of rows) {
            const meta = metaByKey.get(r.entity_key);
            if (!meta) continue; // shouldn't happen (every concept_entities row's key exists in entities), but skip rather than crash on a genuinely inconsistent source
            insertEntity.run({ key: meta.key, kind: meta.kind, surface: meta.surface, scope: SAMPLED_CIRCLE, df: r.df });
          }
        })(survivingEntityKeys);
      }

      const conceptCount = dest.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number };
      const edgeCount = dest.prepare(`SELECT COUNT(*) AS n FROM memory_edge`).get() as { n: number };
      const obsCount = dest.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number };

      return {
        outPath,
        conceptCount: conceptCount.n,
        edgeCount: edgeCount.n,
        observationCount: obsCount.n,
        sourceCircleCounts,
      };
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}

// ── Top-level orchestration: derive every sweep size from one source db ──────────────────────

export interface DerivedSize {
  label: string; // "25" | "50" | "100" | "full"
  requestedSize: number | null; // null for "full"
  result: MaterializeResult;
  selection: SampleSelection;
}

/**
 * Read the eligible concept set from `sourceDbPath` ONCE, then derive every sweep size
 * (25/50/100/full) as a self-contained .db under `outDir/<label>/monet.db`.
 */
export function deriveAllSizes(sourceDbPath: string, outDirBuilder: (label: string) => string): DerivedSize[] {
  const source = new Database(sourceDbPath, { readonly: true });
  let rows: RawConceptRow[];
  try {
    // F4 fix: scope is now MONET CIRCLES ONLY (corpus-scope.mjs's CORPUS_CIRCLES), not every
    // circle in the store — see this module's SCOPE DECISION doc comment above.
    const { fragment, params } = corpusScopeWhereFragment();
    rows = source.prepare(`SELECT id, kind, updated_at FROM concepts WHERE kind != 'workstream' AND ${fragment}`).all(...params) as RawConceptRow[];
  } finally {
    source.close();
  }

  const fullEligible = rows.length;
  const results: DerivedSize[] = [];

  for (const size of SWEEP_SIZES) {
    const selection = selectSample(rows, size);
    const outPath = outDirBuilder(String(size));
    const result = materializeSampledDb(sourceDbPath, outPath, selection.selectedIds);
    results.push({ label: String(size), requestedSize: size, result, selection });
  }

  // FULL: every eligible concept, no sampling — selection is the identity set, still routed
  // through the same materialize path so FULL gets the exact same dependent-row filtering logic
  // (a no-op filter here since every id is in idSet, but "same code path" avoids a second,
  // divergent implementation for the one size that happens not to need sampling).
  const fullIds = rows.map((r) => r.id).sort();
  const fullSelection: SampleSelection = {
    sampleSize: fullEligible,
    achievedSize: fullIds.length,
    selectedIds: fullIds,
    cellAllocations: buildStrata(rows).map((c) => ({ kind: c.kind, tercile: c.tercile, available: c.memberIds.length, taken: c.memberIds.length })),
  };
  const fullOutPath = outDirBuilder(FULL_LABEL);
  const fullResult = materializeSampledDb(sourceDbPath, fullOutPath, fullIds);
  results.push({ label: FULL_LABEL, requestedSize: null, result: fullResult, selection: fullSelection });

  return results;
}

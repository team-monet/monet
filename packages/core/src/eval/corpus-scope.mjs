/**
 * Corpus scope — SINGLE SOURCE OF TRUTH for which circles the Phase 1 corpus pipeline draws from.
 *
 * F4 fix (USER DECISION, the centerpiece of this fix round): corpus scope is now MONET CIRCLES
 * ONLY. Before this fix, the circle-free `WHERE kind != 'workstream'` query (no circle filter at
 * all — every one of the source store's 11 circles, 323 eligible concepts total) was DUPLICATED
 * in three places: src/eval/corpus-sample.ts, scripts/sample-corpus.ts, and
 * scripts/scrub-corpus.mjs. Three copies of the same WHERE clause is exactly the kind of
 * duplication that drifts silently — a scope change applied to one copy and missed in the other
 * two would produce a pipeline that samples from one circle set but reports/scrubs against
 * another. This module is the ONE place the scope is defined; every call site imports from here.
 *
 * WHY A PLAIN .mjs FILE (not a .ts module under src/eval/, despite corpus-sample.ts living there):
 * two of the three call sites (src/eval/corpus-sample.ts, scripts/sample-corpus.ts) run under
 * `tsx` and could import a .ts sibling directly. The third (scripts/scrub-corpus.mjs) is invoked
 * with plain `node scripts/scrub-corpus.mjs` (verified empirically — plain Node's ESM loader
 * cannot resolve an extensionless internal import inside a .ts file, e.g. corpus-sample.ts's own
 * `from "../engine"`, without a TS-aware loader like tsx). A plain, self-contained .mjs file with
 * zero repo-internal imports is importable from BOTH runtimes with no build step and no drift risk
 * between a "real" .ts definition and a hand-copied .mjs mirror — confirmed by directly testing
 * that `tsx`-run TypeScript can import a plain .mjs module with ordinary ESM import syntax.
 *
 * REAL NUMBERS (verified via `sqlite3 eval-corpus/source/monet.db`, not assumed): of 323 total
 * eligible concepts (kind != 'workstream') across 11 circles, example-circle=166 and with-monet=6, for
 * 172 combined — NOT the ≈173 that was estimated before checking. The sweep's FULL sweep point
 * becomes whatever CORPUS_CIRCLES resolves to at run time (see corpusScopeWhereFragment below),
 * never a hardcoded 172 — a future circle rename/count change is picked up automatically, exactly
 * like the pre-existing FULL-is-never-hardcoded convention this pipeline already follows for the
 * kind != 'workstream' filter.
 */

/**
 * The exact set of circles the Phase 1 corpus pipeline draws from. Ordering is not semantically
 * meaningful (used only inside an SQL IN (...) list) but is kept stable/alphabetical for readable
 * diffs if this list ever changes.
 */
export const CORPUS_CIRCLES = ["example-circle", "with-monet"];

/**
 * The single fixed OUTPUT circle every sampled concept is re-circled to in a derived per-size
 * `.db` (materializeSampledDb in corpus-sample.ts). Lives here (not corpus-sample.ts) alongside
 * CORPUS_CIRCLES because the two are the input/output halves of the same scope concept — the
 * INPUT scope (which circles to sample FROM) and the OUTPUT scope (what every sampled row's
 * `circle` column becomes) — and because scrub-corpus.mjs (plain-`node`-invoked, cannot import a
 * .ts module) needs this constant too, to assert its own "already scoped upstream" invariant (see
 * this file's corpus-scope usage in scrub-corpus.mjs's module doc). corpus-sample.ts re-exports
 * this for its own existing consumers (export-corpus-md.ts, corpus-sample.test.ts) so neither
 * needed to change its import source.
 */
export const SAMPLED_CIRCLE = "sampled";

/**
 * Build a parameterized `WHERE ... IN (?, ?, ...)` fragment plus its bind params, for the
 * `circle` column specifically. Callers splice `fragment` into their own WHERE clause (typically
 * alongside `kind != 'workstream'`) and spread `params` into their bound-statement call — never
 * string-interpolate circle names directly, so a circle name containing a SQL-special character
 * can never become an injection vector (not a realistic threat here since CORPUS_CIRCLES is a
 * fixed in-repo constant, not user input, but parameterization is the existing convention every
 * other query in this pipeline already follows and there's no reason to special-case this one).
 *
 * @param {string} column - the column name to filter on (always "circle" in current call sites;
 *   parameterized only so a call site can alias it, e.g. "c.circle" behind a JOIN, without this
 *   module needing to know about JOIN structure).
 * @returns {{ fragment: string, params: string[] }}
 */
export function corpusScopeWhereFragment(column = "circle") {
  const placeholders = CORPUS_CIRCLES.map(() => "?").join(", ");
  return { fragment: `${column} IN (${placeholders})`, params: [...CORPUS_CIRCLES] };
}

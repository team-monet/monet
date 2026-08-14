/**
 * Type declarations for corpus-scope.mjs — kept as a plain .mjs (not .ts) because it must be
 * importable from scripts/scrub-corpus.mjs under plain `node` (no TS-aware loader), which cannot
 * resolve an internal .ts import (verified empirically — see corpus-scope.mjs's own module doc
 * for why). This sibling .d.mts gives the two .ts/tsx consumers (corpus-sample.ts,
 * scripts/sample-corpus.ts) real types instead of an implicit `any`.
 */

/** The exact set of circles the Phase 1 corpus pipeline draws from. */
export declare const CORPUS_CIRCLES: readonly string[];

/** The single fixed output circle every sampled concept is re-circled to in a derived per-size `.db`. */
export declare const SAMPLED_CIRCLE: "sampled";

/** Build a parameterized `WHERE ... IN (?, ?, ...)` fragment plus its bind params for the `circle` column. */
export declare function corpusScopeWhereFragment(column?: string): { fragment: string; params: string[] };

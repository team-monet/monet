/**
 * Type declarations for scrub-patterns.mjs — kept as a plain .mjs (not .ts) for the same reason as
 * corpus-scope.d.mts's sibling .mjs: it must be importable both from `tsx`-run TypeScript
 * (src/eval/md-export-store.ts) and from plain-`node`-invoked scripts/scrub-corpus.mjs. This
 * sibling .d.mts gives the .ts consumer real types instead of an implicit `any`.
 */

/** Scrub every recognized sensitive pattern out of a single string. Non-string input is returned unchanged. */
export declare function scrubString(s: unknown): string;

/** Recursively scrub every string value in an arbitrary JSON-shaped value. */
export declare function scrubJson(val: unknown): unknown;

/**
 * scrubString's slug-safe sibling — omits SECRET_RE's vendor-prefix alternation (the one pattern
 * with a confirmed false-positive risk against hyphen-joined slug text). Used only by
 * scrub-corpus.mjs's filename-rename safety net, never for content scrubbing.
 */
export declare function scrubSlugSafe(s: unknown): string;

export declare const EMAIL_RE: RegExp;
export declare const SECRET_RE: RegExp;
export declare const QUERY_PARAM_SECRET_RE: RegExp;
export declare const BARE_KEY_RE: RegExp;
export declare const MONET_REPO_DIRS: readonly string[];
export declare const USERS_PATH_RE: RegExp;
export declare const TILDE_PATH_RE: RegExp;
/**
 * RFC1918 private-endpoint pattern. Capture group 1 (if present) is a tenant identifier from an
 * immediately-following ", tenant <name>" clause — see the .mjs module's doc comment on this
 * pattern for the full design history (a separate TENANT_NAME_RE + whole-string proximity gate was
 * tried and found unsafe against large multi-concept aggregated files; folding the tenant clause
 * into this same combined match is the corrected, syntactically-local design).
 */
export declare const PRIVATE_ENDPOINT_RE: RegExp;

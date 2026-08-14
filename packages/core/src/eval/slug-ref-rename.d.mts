/**
 * Type declarations for slug-ref-rename.mjs — kept as a plain .mjs (not .ts) for the same reason as
 * scrub-patterns.d.mts's sibling .mjs: it must be importable both from scripts/scrub-db.mjs and
 * scripts/scrub-corpus.mjs under plain `node` (no TS-aware loader) AND from `tsx`-run TypeScript
 * test files (src/__tests__/scrub-db.test.ts, scrub-db-closure.test.ts). This sibling .d.mts gives
 * the .ts consumers real types instead of an implicit `any`.
 */

/** Mirrors src/engine.ts's ASSERTED_RE — see the .mjs module's own doc comment for the full quote/citation. */
export declare const ASSERTED_REF_RE: RegExp;

/**
 * Rewrite every asserted-ref token in `text` that exactly matches an OLD slug in `renameMap` to its
 * NEW slug. Non-ref-shaped occurrences of an old-slug substring elsewhere in `text` are left
 * untouched. Returns `{ text, hits }` — `hits` counts every token actually rewritten.
 */
export declare function rewriteAssertedSlugRefs(text: unknown, renameMap: Map<string, string>): { text: string; hits: number };

/**
 * Build the same old-slug -> new-slug rename map scrubConceptSlugs (scrub-db.mjs) computes,
 * independently, from a plain array of `{ id, title, slug, circle }` rows.
 */
export declare function buildSlugRenameMap(
  rows: Array<{ id: string; title: string; slug: string; circle: string }>,
  helpers: { scrubString: (s: unknown) => string; slugify: (s: string) => string },
): Map<string, string>;

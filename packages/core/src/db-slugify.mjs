/**
 * db-slugify.mjs — plain-.mjs MIRROR of src/engine.ts's `slugify`, added so scripts/scrub-db.mjs
 * (invoked with plain `node`, not `tsx` — same portability requirement documented in
 * src/eval/corpus-scope.mjs's own module doc: "plain Node's ESM loader cannot resolve an
 * extensionless internal import inside a .ts file... without a TS-aware loader like tsx") can
 * regenerate a concept's slug using the EXACT SAME derivation the live engine uses at concept-
 * creation time, without introducing a TS-import dependency into a plain-node script.
 *
 * WHY THIS EXISTS (audit finding F2, round 3 — see scrub-db.mjs's own module doc, "AUDIT FINDINGS,
 * ROUND 3" section, for the full writeup): concepts.slug is derived from the RAW, pre-scrub title
 * at creation time (`slugify(title)`, engine.ts) and is returned verbatim by toCard/toConcept —
 * i.e. every search()/getConcept()/listMemories() result. Round 2 scrubbed concepts.title but never
 * regenerated concepts.slug from the newly-scrubbed title, so a title that originally contained an
 * email/path/private-endpoint/key could leave a recognizable slugified fragment
 * (`jane-doe-example-com`, `users-dev-...`) in the slug even after title itself read
 * "[redacted-email]".
 *
 * THE FIX this module enables (implemented in scrub-db.mjs's scrubConceptSlugs): after
 * scrubConceptsAndObservations has already scrubbed every concept's title, re-derive
 * `slugify(scrubbedTitle)` using THIS mirror and write it back to concepts.slug, with a
 * deterministic per-circle collision-disambiguation policy (see scrubConceptSlugs' own doc comment
 * for the exact policy and why).
 *
 * KEPT IN SYNC WITH src/engine.ts: this file's `slugify` is a byte-for-byte mirror of that module's
 * private (well — now also `export`ed, solely for this mirror's own byte-verification test; see
 * engine.ts's doc comment on its `slugify` export) `slugify` function. If engine.ts's slugify logic
 * ever changes, this mirror must change identically — same maintenance discipline this pipeline
 * already accepts for src/extract-entities.mjs (mirrors src/extract-entities.ts) and
 * src/eval/scrub-patterns.mjs / src/eval/corpus-scope.mjs (shared between a .ts consumer and
 * plain-node scripts). This mirror is intentionally tiny (4 chained `.replace()`/`.slice()` calls)
 * specifically so this "small tolerable duplication, LOUDLY documented and tested" tradeoff stays
 * cheap to keep in sync — src/__tests__/db-slugify.test.ts imports BOTH this mirror and the real
 * `slugify` exported from engine.ts and asserts byte-identical output across a broad batch of
 * representative inputs, so any future drift between the two fails a test immediately rather than
 * silently reintroducing the F2 leak class in a different guise.
 *
 * IMPORTANT: this is NOT the same `slugify` as src/eval/md-export.ts's `slugify` (a DIFFERENT
 * function, for topic-file NAMES, not concepts.slug — verified directly by reading both: md-export.ts's
 * version slices to 48 chars and falls back to the literal string "topic" for an empty result; this
 * one slices to 60 chars with no fallback). Do not conflate the two — this mirror exists
 * specifically to match engine.ts's DB-column slug derivation, byte-for-byte.
 */

export function slugify(s) {
  const cleaned = s
    .toLowerCase()
    .normalize("NFC")
    // `\p{L}\p{N}\p{M}` rather than `a-z0-9` (#187; marks added per Codex review on PR #189) —
    // see engine.ts's slugify for why a combining mark is part of the letter, and why the cap
    // below counts code points rather than UTF-16 units.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return [...cleaned].slice(0, 60).join("");
}

/**
 * slug-ref-rename.mjs — SINGLE SOURCE OF TRUTH for rewriting stale `#<slug>` asserted-ref tokens
 * after a concept's slug has been regenerated from a scrubbed title (round 5, J1 fix — PR comment
 * id 3522836449, https://github.com/team-monet/monet-core/pull/36#discussion_r3522836449).
 *
 * THE LEAK THIS CLOSES: scripts/scrub-db.mjs's scrubConceptSlugs regenerates concepts.slug from the
 * ALREADY-SCRUBBED title (round 3, F2 fix) — e.g. a concept titled "jane.doe@example.com's runbook"
 * gets its slug regenerated from "[redacted-email]'s runbook" instead of the raw title. But that
 * fix only ever UPDATEd the `concepts.slug` COLUMN — it never touched any OTHER row's `body`/
 * `content` TEXT that had previously written an asserted reference to the OLD slug, e.g.
 * `supports: #jane-doe-example-com`. A slugified fragment carries NO `@`/`.`/`/` separators (slugify
 * collapses every non-alnum run to a single hyphen), so every one of scrub-patterns.mjs's own
 * patterns (EMAIL_RE, USERS_PATH_RE, etc. — all anchored on a separator character the slug form has
 * already destroyed) silently misses it, exactly the same structural blind spot
 * scrub-patterns.mjs's own module doc already documents for slugified TITLES (see that file's doc
 * comment, "insufficient by construction" section) — this is the identical blind spot, just for a
 * `#ref` token embedded in a DIFFERENT concept's body/content instead of in a topic-file NAME.
 *
 * WHY A SEPARATE MODULE FROM scrub-patterns.mjs: scrub-patterns.mjs's scrubString operates on a
 * FIXED pattern set with no external state. This fix needs a PER-RUN, PER-CORPUS rename map (which
 * slugs actually changed THIS run, and what they changed to) — a fundamentally different shape of
 * input (a `Map<oldSlug,newSlug>` built earlier in the SAME pipeline run, not a fixed regex) that
 * doesn't fit scrubString's "stateless pattern scrub" contract.
 *
 * WHY A PLAIN .mjs FILE (not .ts), same reasoning as scrub-patterns.mjs/corpus-scope.mjs/
 * db-slugify.mjs's own module docs: this must be importable both from scripts/scrub-db.mjs and
 * scripts/scrub-corpus.mjs, both invoked with plain `node`, with zero build step and zero drift
 * risk between two independently-maintained copies of the same rewrite logic. Both scripts need the
 * EXACT SAME rewrite behavior for two INDEPENDENT reasons this file exists to satisfy at once:
 *
 *   1. scripts/scrub-db.mjs applies this to concepts.body/observations.content in the SCRUBBED-DB
 *      pipeline (eval-corpus/db-scrubbed/<size>/monet.db) — see that script's scrubSizeDb, which
 *      calls scrubConceptSlugs to get the rename map, then a new rewriteAssertedSlugRefsInDb pass
 *      (this file's DB-level counterpart, exported below) to apply it.
 *   2. scripts/scrub-corpus.mjs's dumpPublishableCorpus ALSO emits a `body` field into
 *      publish/<size>/corpus.json, independently, from the RAW (unscrubbed) per-size db — see that
 *      function's own doc comment. For db-vs-publish PARITY (this pipeline's own stated purpose —
 *      see scrub-db.mjs's module doc, "WHY THIS STAGE EXISTS" — both arms of the A2-vs-A4 eval must
 *      see IDENTICAL content), corpus.json's `body` field must undergo the IDENTICAL rewrite, using
 *      the IDENTICAL rename map, or the two artifacts diverge on exactly the text this fix touches.
 *      The rename map itself is deterministically reproducible from EITHER db copy (see
 *      buildSlugRenameMap's own doc comment below for why), so both pipelines compute the same map
 *      independently and apply the same rewrite function to their own body/content text — the
 *      REWRITE LOGIC is shared (this module); the map-BUILDING and the db reads are not (each
 *      script builds its own map from its own db handle, since scrub-db.mjs's db-scrubbed copy and
 *      scrub-corpus.mjs's raw db are literally different SQLite files opened by different scripts).
 *
 * THE ENGINE'S REAL REF SYNTAX (src/engine.ts:52, ASSERTED_RE, verified directly against the source
 * — NOT the 2-verb `supports:`/`resolves:`-only assumption an earlier draft of this fix started
 * from):
 *
 *   const ASSERTED_RE = /\b(resolves|supersedes|derived-from|supports|contradicts)\s*:\s*#?([\w:-]+)/gi;
 *
 * Five verbs (resolves|supersedes|derived-from|supports|contradicts), NOT just two — a rewrite
 * anchored on only `supports:`/`resolves:` would silently miss `supersedes: #<old-slug>` etc. The
 * `#` is OPTIONAL (`#?`) — `resolves: my-slug` with no hash is valid engine syntax and must be
 * rewritten identically to `resolves: #my-slug`. The captured token's charset (`[\w:-]+`) is WIDER
 * than slugify()'s own output alphabet (`[a-z0-9-]` only) — this accommodates resolveRef's OTHER two
 * resolution paths (a literal concept id, or an alias) alongside the slug path; see resolveRef's own
 * three-way lookup (engine.ts:3182-3200: slug match -> literal id match -> alias fallback). THIS
 * REWRITE ONLY EVER TOUCHES THE SLUG CASE — a captured token that doesn't exactly equal a KEY in the
 * rename map (a raw UUID, an alias, or a slug this run didn't regenerate) is left completely
 * untouched, which is exactly correct: a raw-id ref is not slug-derived and was never at risk of
 * carrying a stale-slug leak in the first place, and rewriting it would actively break a genuinely
 * resolvable reference for no reason.
 *
 * ANCHORING, PER THIS FIX'S OWN TASK SPEC ("anchored to ref-shaped contexts... to avoid mangling
 * prose that coincidentally contains the string"): REWRITE_RE below mirrors ASSERTED_RE's own
 * verb+colon+optional-hash+token shape exactly (this is deliberate — a rewrite pass that used a
 * LOOSER anchor than the engine's own parser would rewrite text the engine itself would never have
 * treated as a ref in the first place, silently changing ordinary prose that merely happens to
 * contain an old-slug-shaped substring after a colon). A bare, unanchored old-slug substring
 * appearing elsewhere in prose (with no verb: prefix) is NEVER touched by this rewrite — correctly:
 * it was never a functioning `#ref` the engine would resolve, so it isn't the J1 leak vector this
 * fix targets, and blindly rewriting it would risk corrupting genuine prose that happens to share a
 * substring with a slug (this pipeline's own established discipline — see scrub-patterns.mjs's
 * SECRET_RE/PRIVATE_ENDPOINT_RE doc comments for the same "match only genuine structure, verified
 * empirically, not any string that merely looks similar" principle applied throughout this
 * pipeline).
 */

/**
 * Mirrors src/engine.ts's ASSERTED_RE (verified byte-identical against the real source, up to the
 * capture-group structure this rewrite needs — see this module's doc comment for the full
 * verbatim quote and citation). Capture group 1: the verb. Capture group 2: the optional literal
 * "#". Capture group 3: the ref token itself (slug, id, or alias — this rewrite only acts when it
 * exactly equals a renameMap key).
 */
// Unicode ref repertoire, matching engine.ts's ASSERTED_RE and slugify (#187, Codex review on PR
// #189). This module rewrites references when scrubbing renames a slug; with an ASCII-only class a
// scrubbed non-Latin concept keeps references pointing at its PRE-scrub slug, which is a dangling
// reference produced by the privacy pipeline itself.
export const ASSERTED_REF_RE = /\b(resolves|supersedes|derived-from|supports|contradicts)(\s*:\s*)(#?)([\p{L}\p{N}\p{M}_:-]+)/giu;

/**
 * Rewrite every asserted-ref token in `text` that exactly matches an OLD slug in `renameMap` to its
 * NEW slug, preserving the verb/whitespace/optional-hash exactly as found. Non-ref-shaped
 * occurrences of an old-slug substring elsewhere in `text` (no `verb:` prefix) are left untouched —
 * see this module's doc comment, "ANCHORING" section, for why that's correct rather than a gap.
 *
 * `renameMap`: `Map<oldSlug, newSlug>`, as built by scrubConceptSlugs (scrub-db.mjs) or
 * buildSlugRenameMap (this module, for scrub-corpus.mjs's independent raw-db pipeline).
 *
 * Longest-key-first is NOT load-bearing here the way it is for scrub-corpus.mjs's own
 * applyRenameMapToContent (a blind substring `.split().join()` over PATH strings, where one key
 * being a literal prefix of another could cause a partial, wrong replacement) — this function
 * matches whole CAPTURED TOKENS via ASSERTED_REF_RE (a token's end is unambiguous: the regex's
 * `[\w:-]+` char class greedily consumes to the first non-matching character, so two distinct
 * renameMap keys can never partially overlap within a single captured token). `renameMap` lookups
 * are still applied deterministically (insertion order, which callers build in a fixed `ORDER BY
 * id` pass) rather than relying on Map iteration order for anything semantically meaningful — no
 * two token replacements can interact with each other REGARDLESS of processing order, since each
 * match is rewritten independently and matches never overlap (the whole point of anchoring on
 * ASSERTED_REF_RE's own non-overlapping token boundaries).
 *
 * Returns `{ text: string, hits: number }` — `hits` counts every token actually rewritten (0 when
 * `renameMap` is empty or nothing in `text` matches), matching this pipeline's existing "return a
 * hit count alongside the rewritten value" convention (scrubString callers throughout
 * scrub-db.mjs).
 */
export function rewriteAssertedSlugRefs(text, renameMap) {
  if (typeof text !== "string" || text === "" || renameMap.size === 0) return { text, hits: 0 };
  let hits = 0;
  const rewritten = text.replace(ASSERTED_REF_RE, (fullMatch, verb, colonWs, hash, token) => {
    const newSlug = renameMap.get(token);
    if (newSlug === undefined) return fullMatch; // not a renamed slug (raw id / alias / unrenamed) — untouched
    hits += 1;
    return `${verb}${colonWs}${hash}${newSlug}`;
  });
  return { text: rewritten, hits };
}

/**
 * Build the SAME old-slug -> new-slug rename map scrubConceptSlugs (scrub-db.mjs) computes,
 * independently, from a plain array of `{ id, title, slug, circle }` rows — used by
 * scrub-corpus.mjs's dumpPublishableCorpus (which reads the RAW, not-yet-column-updated db) so its
 * emitted corpus.json `body` field can undergo the IDENTICAL rewrite scrub-db.mjs applies to
 * db-scrubbed's `concepts.body` column, for db-vs-publish parity (see this module's doc comment,
 * point 2, for the full parity argument).
 *
 * DETERMINISM / IDENTICAL-OUTPUT ARGUMENT: `finalSlug` for a given row is a pure function of
 * `(scrubString(row.title), row.id, row.circle, the fixed ORDER BY id iteration order, every OTHER
 * row's title/id/circle in the same circle)` — none of which differ between scrub-db.mjs's
 * db-scrubbed copy (post scrubConceptsAndObservations, which has already overwritten `title` to
 * `scrubString(rawTitle)`) and scrub-corpus.mjs's raw db (which still holds `rawTitle` — this
 * function applies `scrubString` itself, below, to reproduce the identical scrubbed-title input).
 * `id`/`circle` are never mutated by any scrub step in either pipeline. So calling this function
 * against the RAW db's rows and calling scrubConceptSlugs against the SCRUBBED db's rows are
 * guaranteed (by construction, not by coincidence) to compute the identical `Map<oldSlug,newSlug>`
 * — both are `slugify(scrubString(rawTitle))` plus the identical, order-dependent disambiguation
 * policy over the identical `(id, circle)` set in the identical `ORDER BY id` order. This is proven
 * directly (not just argued) by this module's own parity test — see
 * src/__tests__/scrub-db-closure.test.ts's "J1 rewrite parity — buildSlugRenameMap produces an
 * IDENTICAL map to scrubConceptSlugs's own" test.
 *
 * Mirrors scrubConceptSlugs's disambiguation policy EXACTLY (including the round 5, J4 fix —
 * per-circle tracking of ASSIGNED FINAL slugs, not just base slugs) — see that function's own doc
 * comment (scripts/scrub-db.mjs) for the full policy rationale; kept in sync deliberately (small,
 * tolerable duplication, LOUDLY documented and tested, matching this pipeline's own established
 * db-slugify.mjs/extract-entities.mjs precedent for "a mirror kept in sync via a dedicated
 * byte-identical-output test" rather than a shared-code abstraction that would require
 * scrub-corpus.mjs to import scrub-db.mjs, an import DIRECTION this pipeline's existing modules
 * never use).
 *
 * `rows`: pre-scrub `{ id: string, title: string, slug: string, circle: string }[]`, ALREADY sorted
 * by id (callers pass `ORDER BY id` query results, matching scrubConceptSlugs's own contract).
 */
export function buildSlugRenameMap(rows, { scrubString, slugify }) {
  const SLUG_MAX_LEN = 60;
  const SLUG_ID_FRAGMENT_LEN = 8;
  const SLUG_ID_FRAGMENT_BUDGET = SLUG_ID_FRAGMENT_LEN + 1;

  const renameMap = new Map();
  const usedSlugsByCircle = new Map();
  const assignedFinalSlugsByCircle = new Map();

  for (const row of rows) {
    const scrubbedTitle = scrubString(row.title);
    const baseSlug = slugify(scrubbedTitle);

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
    if (usedSlugs.has(baseSlug) || assignedFinalSlugs.has(baseSlug)) {
      const truncatedBase = baseSlug.slice(0, SLUG_MAX_LEN - SLUG_ID_FRAGMENT_BUDGET).replace(/-+$/, "");
      const idFragment = row.id.slice(0, SLUG_ID_FRAGMENT_LEN);
      finalSlug = `${truncatedBase}-${idFragment}`.replace(/^-+/, "");
    }
    usedSlugs.add(baseSlug);
    assignedFinalSlugs.add(finalSlug);

    if (finalSlug !== row.slug) renameMap.set(row.slug, finalSlug);
  }

  return renameMap;
}

#!/usr/bin/env node
/**
 * scrub-corpus.mjs — Phase 1 corpus derivation, step 3 (spec §3.6, §6).
 *
 * MANDATORY, NON-SKIPPABLE pipeline stage. Scrubs the derived md-tree exports
 * (eval-corpus/md/<size>/{index.md,topics/*.md,chunks.json}) into a publishable form under
 * eval-corpus/publish/<size>/, and produces a publishable JSON corpus dump
 * (eval-corpus/publish/<size>/corpus.json) directly from each derived .db.
 *
 * Adapted from the precedent at monet-site/apps/monet/demo/scrub-demo-api.mjs (same drop-list
 * philosophy: DROP_KEYS for known-sensitive field names) — but this corpus ALSO needs
 * content-pattern scrubbing within KEPT fields (title/body/text), because that is literally
 * where the leakage lives (verified empirically against this corpus: 73 concepts have
 * @-shaped strings in body, 33 have /Users/ paths in body, per the mission brief — independently
 * re-confirmed against the exported md content below, see the grep counts this script logs).
 *
 * Scrub passes (patterns now live in src/eval/scrub-patterns.mjs — see that module's doc for why
 * they were extracted from here in round 2's P1-b fix; scrubString/scrubJson below are re-exported
 * from there unchanged for this file's own existing consumers, e.g. scrub-corpus.test.ts), applied
 * to every string value found in md files / chunks.json / corpus.json:
 *   1. EMAIL_RE     — anything email-shaped → "[redacted-email]"
 *   2. SECRET_RE    — API-key/token-shaped strings (sk-/ghp_/gho_/ghs_/github_pat_/AKIA/xox?-/
 *                     long Bearer values) → "[redacted-secret]". Deliberately requires a
 *                     minimum trailing-length after the prefix (10-20 chars depending on prefix)
 *                     so ordinary English words that happen to start with a matching prefix
 *                     (e.g. "sk-based", "sk-file" — real false positives found when this script
 *                     was being designed against this exact corpus) are NOT redacted.
 *   3. PATH_RE      — absolute /Users/<anyone>/... paths → redacted, UNLESS the path is under a
 *                     monet-core/example-benchmark REPO directory (the proof's own source, which is
 *                     fine to reference) — this is a narrower allowlist than "anything
 *                     monet-branded": `~/.monet/monet.db` (the LIVE DATA STORE location) is NOT
 *                     on the allowlist and IS redacted, same as any other personal-account path.
 *                     Only `monet-core`/`monet-site`/`example-benchmark` REPO paths are kept, generalized
 *                     to a relative form (stripping the /Users/<user>/code/ prefix) rather than
 *                     fully redacted, since referencing "monet-core/src/engine.ts" in a proof
 *                     repo about monet-core is not a privacy leak.
 *   4. TILDE_PATH_RE (round-2 fix, P1-a) — `~/...`-form home paths (e.g. `~/.monet/monet.db`, the
 *                     LIVE DATA STORE location referenced in prose) survived every prior pass
 *                     because USERS_PATH_RE only matches the `/Users/...` absolute form. Verified
 *                     empirically before fixing: `grep -rl '~/.monet/monet.db' eval-corpus/publish/`
 *                     hit 10 files in the regenerated tree. Same placeholder discipline as
 *                     USERS_PATH_RE ("[redacted-path]") — deliberately NOT proof-repo-generalized
 *                     like USERS_PATH_RE's monet-core exception, since a tilde path is always a
 *                     PERSONAL machine path (nobody writes "~/monet-core" meaning a repo checkout
 *                     the same way `/Users/x/code/monet-core` reads), so there is no legitimate
 *                     "proof's own repo" case to preserve here — always fully redacted.
 *   5. PRIVATE_ENDPOINT_RE (round-2 fix, P1-c) — RFC1918 private-range addresses (10.x, 172.16–31.x,
 *                     192.168.x) with an optional :port and/or /path survive because no
 *                     endpoint/IP pattern existed in scrubString at all. Verified empirically:
 *                     `http://192.168.1.10:9301` (with an adjacent tenant name, "acme") was present
 *                     in 8 files of the regenerated tree. Redacted to "[redacted-private-endpoint]"
 *                     (the whole IP[:port][/path] run, matching the "same placeholder discipline
 *                     as absolute paths" instruction — one opaque token replaces the whole
 *                     sensitive run, not a partial masking that still leaks structure). ALSO
 *                     captures an optional immediately-following ", tenant <name>" clause as part
 *                     of this SAME combined match — an earlier design used a separate
 *                     TENANT_NAME_RE pattern gated on "does this whole string contain a private
 *                     endpoint anywhere," which was found UNSAFE (it corrupted an unrelated
 *                     concept's legitimate "reviews tenant DDL" sentence via index.md, which
 *                     aggregates every concept's one-line summary into one string, once ANY
 *                     concept in that file had a private endpoint). Folding the tenant clause into
 *                     PRIVATE_ENDPOINT_RE's own match keeps the association provably LOCAL (a
 *                     single regex match span, never spanning two unrelated concepts merged into
 *                     one file) — see src/eval/scrub-patterns.mjs's own doc comment on
 *                     PRIVATE_ENDPOINT_RE for the full three-attempt history and the accepted,
 *                     documented limitation (a bare back-reference to the tenant name elsewhere in
 *                     the same document, with no endpoint immediately adjacent, is not caught).
 *
 * FILENAME SCRUBBING (round-2 fix, P1-b): topic FILENAMES (topics/<slug>.md) derive from concept
 * TITLES via slugify(title) (md-export.ts/md-export-store.ts) — scrubbing file CONTENT above never
 * touched file NAMES. The actual fix now lives UPSTREAM, at export time: md-export-store.ts scrubs
 * the title (via this same scrubString, imported from src/eval/scrub-patterns.mjs) BEFORE calling
 * slugify() on it, while the original separators (/Users/, ~/, @, IP-address dots) are still
 * intact — slugify() collapses every non-alphanumeric run into a hyphen, which destroys those
 * separators and, for several pattern classes (tilde paths, emails), leaves no residual signal a
 * post-hoc rename pass over the already-slugified string could ever detect (verified empirically —
 * see scrub-patterns.mjs's own module doc for the exact slugify() outputs that prove this). This
 * script still keeps a rename-map safety net (scrubFilenameIfNeeded/planFilenameRenames below) as
 * defense-in-depth in case a title-scrub-before-slug decision is ever bypassed at a different call
 * site, or a future slug-worthy pattern leaves a residual signal even post-hyphenation the way
 * "users"/"http" happened to for the two originally-reported instances — but it is no longer the
 * PRIMARY mechanism protecting against sensitive filenames.
 *
 * MARKER (spec §3.6's "checked-in 'scrub ran, hash X' marker the publish script verifies"):
 * after scrubbing, writes eval-corpus/SCRUB_MANIFEST.json — sha256 of every file UNDER
 * eval-corpus/publish/, computed AFTER scrubbing. Nothing downstream should treat
 * eval-corpus/publish/ as done without this manifest existing and matching current content;
 * verify-scrub-marker.mjs (a separate, tiny script) re-hashes and compares, and FAILS LOUDLY
 * (non-zero exit) on any mismatch or missing file — this is the "structure the pipeline so scrub
 * MUST run and MUST succeed" requirement, not a step a later call could silently skip.
 *
 * CORPUS SCOPE (F4 fix — why dumpPublishableCorpus's query below does NOT filter by circle,
 * despite corpus scope now being MONET-CIRCLES-ONLY per corpus-scope.mjs): this script's corpus
 * dump reads from the ALREADY-DERIVED per-size `.db` (eval-corpus/db/<size>/monet.db, produced by
 * sample-corpus.ts → corpus-sample.ts's materializeSampledDb), in which EVERY row has already been
 * re-circled to the single fixed `SAMPLED_CIRCLE` ("sampled") — verified empirically
 * (`sqlite3 eval-corpus/db/25/monet.db "SELECT DISTINCT circle FROM concepts"` returns only
 * "sampled"). The monet-circle scoping happened upstream, at SAMPLING time, against the RAW
 * multi-circle source db — by the time this script runs, scope has already been applied and
 * baked into which concept ids exist in the derived db at all. Adding a
 * `circle IN ('example-circle','with-monet')` filter HERE would not be redundant-but-harmless — it would
 * silently match ZERO rows (every row's circle is literally "sampled" at this stage), corrupting
 * corpus.json into an empty dump. `assertScopeAlreadyApplied` below makes this "already scoped
 * upstream" invariant self-checking rather than merely documented in a comment a future edit could
 * violate without noticing.
 *
 * Usage:
 *   node scripts/scrub-corpus.mjs [--md=eval-corpus/md] [--db=eval-corpus/db] [--out=eval-corpus/publish]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SAMPLED_CIRCLE } from "../src/eval/corpus-scope.mjs";
// P1-b fix (round 2): scrubString/scrubJson and every pattern moved to src/eval/scrub-patterns.mjs
// (shared with md-export-store.ts's title-before-slugify scrub — see that module's doc and this
// file's own module doc, "FILENAME SCRUBBING" section, for why). Re-exported below unchanged so
// this file's own existing consumers (scrub-corpus.test.ts's `import { scrubString } from
// "../../scripts/scrub-corpus.mjs"`) keep working without needing to change their import source.
import {
  scrubString,
  scrubJson,
  scrubSlugSafe,
  EMAIL_RE,
  SECRET_RE,
  QUERY_PARAM_SECRET_RE,
  BARE_KEY_RE,
  USERS_PATH_RE,
  TILDE_PATH_RE,
  PRIVATE_ENDPOINT_RE,
} from "../src/eval/scrub-patterns.mjs";

export { scrubString, scrubJson };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ── Diagnostics: count hits BEFORE scrubbing, for the human-readable summary this script prints ──

function countMatches(text, re) {
  const m = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

// ── Scrub the md exports (index.md, topics/*.md, chunks.json) ────────────────────────────────

/**
 * P1-b fix (round 2): topic FILENAMES (topics/<slug>.md) are derived from concept TITLES at
 * export time (slugify(lead.title) in md-export.ts/md-export-store.ts), entirely independently of
 * this script's content scrubbing — scrubbing file CONTENTS never touches file NAMES. Verified
 * empirically before fixing: a title containing "/Users/dev/..." path material slugified to
 * `build-plan-doc-written-2026-06-30-users-dev-.md`, surviving unredacted in all 4 sizes even
 * though the same path string inside that file's body/chunks.json/corpus.json WAS scrubbed.
 *
 * Chosen fix route (one of two the finding sanctions — "add a slug-sanitize pass in scrub with a
 * rename map applied to all referencing artifacts"), rather than the alternative (scrub titles
 * before slug derivation in the export stage): this route stays entirely inside scrub-corpus.mjs,
 * touching neither md-export.ts (shared with Phase 0's exportMdTree(), a protected file this round
 * must leave at zero-diff vs origin/main in the parts Phase 0 depends on) nor md-export-store.ts's
 * slug-derivation call site — minimizing footprint for an already-large fix round.
 *
 * Detection: re-run scrubString over the ORIGINAL filename (stripped of its .md extension so the
 * literal "." isn't treated as path/prose punctuation) — if scrubbing changes it, the filename
 * itself carried scrubbable material and must be renamed. This reuses the exact same patterns
 * (tilde/Users paths, emails, secrets, private endpoints, tenant names) rather than a second,
 * independently-maintained "is this slug sensitive" heuristic — so extending scrubString with a
 * new pattern automatically extends filename protection too, with no separate list to keep in
 * sync.
 *
 * The scrubbed filename is then re-slugified (lowercased, non-alnum runs collapsed to single
 * hyphens, trimmed) so it stays a valid, readable filename rather than embedding a literal
 * "[redacted-path]" token with brackets in a path segment. A numeric suffix disambiguates any
 * collision this introduces (extremely unlikely — two different original filenames would need to
 * scrub-and-reslug to the identical string — but handled the same defensive way exportMdTree's own
 * slug-collision guard handles its rarer collision case, never silently overwriting one file with
 * another).
 */
const RENAMEABLE_EXTENSIONS = [".md"];

function sanitizeScrubbedFilenameStem(stem) {
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "redacted"
  );
}

/**
 * Given an original topic-file basename (e.g. "build-plan-doc-...-users-dev-.md"), return the
 * new basename if the name itself needs scrubbing, or null if it's already clean. `usedNames` is
 * the set of destination basenames already claimed in this directory (mutated on collision
 * disambiguation, same responsibility split as exportMdTree's own usedSlugs Set).
 *
 * Uses scrubSlugSafe (NOT the full scrubString) — see that function's doc comment in
 * scrub-patterns.mjs for why: scrubString's SECRET_RE alternation has a false-positive guard
 * tuned against space-separated prose that does NOT hold against hyphen-joined slug text (found
 * empirically while testing this very function, both directions — "sk-authored the design doc",
 * an existing documented false-positive example, becomes a FALSE match once hyphenated into
 * "sk-authored-design-notes" slug form). scrubSlugSafe omits exactly that one problematic
 * alternation while keeping every other pattern, which remains safe against slug input.
 */
export function scrubFilenameIfNeeded(basename, usedNames) {
  const ext = RENAMEABLE_EXTENSIONS.find((e) => basename.endsWith(e));
  if (!ext) return null; // only topic-file .md basenames are slug-derived; chunks.json/corpus.json/index.md keep their fixed names
  const stem = basename.slice(0, -ext.length);
  const scrubbedStem = scrubSlugSafe(stem);
  if (scrubbedStem === stem) return null; // filename carried nothing scrubSlugSafe would touch
  let candidate = `${sanitizeScrubbedFilenameStem(scrubbedStem)}${ext}`;
  let n = 2;
  while (usedNames.has(candidate)) {
    candidate = `${sanitizeScrubbedFilenameStem(scrubbedStem)}--${n}${ext}`;
    n += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Recursively list every file under `dir`, relative to `dir`, using POSIX separators regardless
 * of platform (relative paths here are also used as literal substring keys against file CONTENT —
 * chunks.json's `file`/`chunkId` fields and index.md's markdown links are always written with `/`
 * — so this must not emit `\` on Windows).
 */
function listFilesRelative(dir, relDir = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRelative(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Pass 1 of the P1-b fix: decide every filename rename up front, BEFORE any content is scrubbed or
 * written. Two passes are required (not one) because index.md/chunks.json can be visited before
 * the topics/ subdirectory that contains the file they reference — readdirSync makes no ordering
 * guarantee that would let a single pass discover a topic-file's new name before needing to
 * rewrite the reference to it. Building the full rename map first means pass 2 can safely rewrite
 * every reference regardless of visitation order.
 *
 * Collision disambiguation (usedNames) is scoped PER DIRECTORY (topics/ has its own namespace,
 * matching how exportMdTree's own usedSlugs collision guard already treats one flat topics/
 * directory as the collision domain) and seeded with every ORIGINAL basename in that directory
 * up front, so a rename can never collide with an unrenamed sibling that hasn't been visited yet
 * either.
 */
function planFilenameRenames(mdSizeDir) {
  const renameMap = new Map(); // relative src path → relative dst path, only entries that changed
  const usedNamesByDir = new Map(); // relDir → Set<basename> already claimed in that directory

  // Determinism fix: readdirSync's ORDER is a filesystem-provided guarantee, not a language-level
  // one — this pipeline's byte-identical-across-runs requirement must not depend on it. On this
  // dev machine (macOS/APFS), readdirSync happens to already return entries alphabetically, so
  // this sort is a no-op in practice here — but a future run on a filesystem WITHOUT that
  // incidental guarantee (e.g. certain Linux ext4 hash-ordered directories) could otherwise
  // process files in a different order across two runs, changing which of two colliding renamed
  // slugs gets the "clean" name vs a numeric `--2` suffix (scrubFilenameIfNeeded's collision
  // disambiguation is order-dependent BY DESIGN — first-come-first-served — so the input order
  // itself must be pinned). Sorting relFiles here removes the platform dependency entirely,
  // independent of whether this exact corpus currently has any colliding renames to trigger it.
  const relFiles = listFilesRelative(mdSizeDir).sort();
  const dirsSeen = new Set(relFiles.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")));
  for (const d of dirsSeen) {
    const abs = d ? join(mdSizeDir, d) : mdSizeDir;
    // Same determinism fix applied to usedNamesByDir's seed set — order doesn't affect a Set's
    // membership semantics here (used only via .has()/.add(), never iterated), but sorting keeps
    // this function's only filesystem-order-sensitive surface (relFiles, iterated in order below)
    // isolated to one place rather than leaving a second unsorted readdirSync call beside it.
    usedNamesByDir.set(
      d,
      new Set(
        readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort(),
      ),
    );
  }

  for (const relPath of relFiles) {
    const slash = relPath.lastIndexOf("/");
    const relDir = slash === -1 ? "" : relPath.slice(0, slash);
    const basename = slash === -1 ? relPath : relPath.slice(slash + 1);
    const renamed = scrubFilenameIfNeeded(basename, usedNamesByDir.get(relDir));
    if (renamed) renameMap.set(relPath, relDir ? `${relDir}/${renamed}` : renamed);
  }
  return renameMap;
}

/**
 * Pass 2: apply the rename map to file CONTENT wherever a renamed relative path appears as a
 * literal substring (chunks.json's `"file": "topics/<slug>.md"` / `"chunkId": "topics/<slug>.md#N"`
 * fields, and index.md's `[title](topics/<slug>.md)` markdown links) — a plain substring
 * replacement is sufficient and exact here because relative topic-file paths are unique, unambiguous
 * tokens (topics/<slug>.md) that don't collide with unrelated prose the way a bare filename might.
 * Longer keys are substituted first so a shorter renamed path can never partially matched inside a
 * longer one first (not actually reachable given the fixed "topics/<basename>" shape every key has,
 * since no key is a prefix of another distinct key, but ordering longest-first costs nothing and
 * removes the need to prove that invariant holds under future changes).
 */
function applyRenameMapToContent(text, renameMap) {
  if (renameMap.size === 0) return text;
  let out = text;
  const keys = [...renameMap.keys()].sort((a, b) => b.length - a.length);
  for (const from of keys) {
    out = out.split(from).join(renameMap.get(from));
  }
  return out;
}

function scrubMdSize(mdSizeDir, outSizeDir) {
  mkdirSync(outSizeDir, { recursive: true });
  let emailHits = 0;
  let secretHits = 0;
  let pathHits = 0;
  let privateEndpointHits = 0;

  const renameMap = planFilenameRenames(mdSizeDir);

  const walk = (dir, outDir, relDir) => {
    mkdirSync(outDir, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const srcPath = join(dir, entry.name);
      const srcRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(srcPath, join(outDir, entry.name), srcRel);
        continue;
      }
      const raw = readFileSync(srcPath, "utf8");
      emailHits += countMatches(raw, EMAIL_RE);
      // F3 fix: secretHits now covers all three secret-shaped patterns (fixed vendor-prefix list
      // + the two additive gap-closing patterns), so the printed summary reflects everything
      // scrubString actually redacts, not just the original vendor-prefix subset.
      secretHits += countMatches(raw, SECRET_RE) + countMatches(raw, QUERY_PARAM_SECRET_RE) + countMatches(raw, BARE_KEY_RE);
      // P1-a fix: pathHits now covers both absolute /Users/ and tilde-form home paths.
      pathHits += countMatches(raw, USERS_PATH_RE) + countMatches(raw, TILDE_PATH_RE);
      // P1-c fix: private-endpoint hits tracked separately (distinct redaction placeholder).
      privateEndpointHits += countMatches(raw, PRIVATE_ENDPOINT_RE);

      // P1-b fix: write at the (possibly renamed) destination basename, and rewrite any reference
      // to a renamed topic-file path inside THIS file's own content (index.md/chunks.json holding
      // links to topics/<old-slug>.md need the reference updated to topics/<new-slug>.md). dstRel
      // is always POSIX-joined (from renameMap/srcRel, both built with literal "/"), and
      // outSizeDir is a real OS path from resolve()/join() upstream — join() below normalizes the
      // two correctly on any platform.
      const dstRel = renameMap.get(srcRel) ?? srcRel;

      if (entry.name.endsWith(".json")) {
        const parsed = JSON.parse(applyRenameMapToContent(raw, renameMap));
        writeFileSync(join(outSizeDir, dstRel), JSON.stringify(scrubJson(parsed), null, 2) + "\n", "utf8");
      } else {
        const scrubbed = scrubString(applyRenameMapToContent(raw, renameMap));
        writeFileSync(join(outSizeDir, dstRel), scrubbed, "utf8");
      }
    }
  };

  walk(mdSizeDir, outSizeDir, "");
  return { emailHits, secretHits, pathHits, privateEndpointHits, filenameRenames: renameMap.size, renameMap };
}

/**
 * P2-b fix (round 2 review, "Fail when a size is missing its derived DB"): a missing derived .db
 * for a size used to only log a "SKIP" line and move on, leaving that size's publish/<size>/ tree
 * WITHOUT a corpus.json while the scrub manifest (written once, at the very end, over whatever's
 * on disk) still hashed and marked that partial tree as "scrubbed and verified" —
 * verify-scrub-marker.mjs has no way to distinguish "this size never needed a db" from "this
 * size's db derivation silently failed upstream", so a partial pipeline run could pass
 * verification while missing a whole artifact. An expected input being absent is a hard pipeline
 * failure, not a skippable size: every size listed under eval-corpus/md/ was, by construction,
 * ALSO derived into eval-corpus/db/<size>/monet.db by the same sample-corpus.ts run (same set of
 * sizes, SWEEP_SIZES + FULL_LABEL) — if the md export for a size exists but its db doesn't, the
 * two pipeline stages have fallen out of sync (e.g. someone re-ran export-corpus-md.ts against a
 * stale md dir without re-running sample-corpus.ts first, or a prior sample-corpus.ts run was
 * interrupted after writing some sizes but not others) and MUST stop the whole run, not silently
 * publish an incomplete corpus.
 */
export function assertDerivedDbExists(dbPath, size, mdSizeDir) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `scrub-corpus.mjs: derived db not found at ${dbPath} for size "${size}", but an md export ` +
        `exists at ${mdSizeDir}. Every size under eval-corpus/md/ must have a matching ` +
        `eval-corpus/db/<size>/monet.db — re-run scripts/sample-corpus.ts to regenerate ALL ` +
        `derived dbs before re-running scrub. Refusing to publish a partial corpus for "${size}".`,
    );
  }
}

// ── Publishable JSON corpus dump, directly from the derived .db (spec: id/title/body/kind/
// circle/timestamps/support_count — NO embedding, NO raw source_refs) ────────────────────────

/**
 * F4 fix's self-checking invariant (see this file's module doc, "CORPUS SCOPE" section): every
 * row read from a derived per-size `.db` MUST already have circle === SAMPLED_CIRCLE, because
 * monet-circle scoping was applied upstream at sampling time. Throws loudly rather than silently
 * producing an empty (or wrongly-scoped) corpus.json if this invariant is ever violated — e.g. by
 * a future edit that points --db at a raw source db instead of a derived one, or a change to
 * materializeSampledDb that stops re-circling.
 */
function assertScopeAlreadyApplied(rows, dbPath) {
  const offending = rows.filter((r) => r.circle !== SAMPLED_CIRCLE);
  if (offending.length > 0) {
    throw new Error(
      `dumpPublishableCorpus: expected every row from ${dbPath} to already be circled to ` +
        `"${SAMPLED_CIRCLE}" (monet-circle scoping happens upstream at sampling time, not here) — ` +
        `found ${offending.length} row(s) with a different circle (e.g. "${offending[0].circle}"). ` +
        `This db does not look like a properly-derived per-size corpus db.`,
    );
  }
}

function dumpPublishableCorpus(dbPath, outPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, title, body, kind, circle, created_at AS createdAt, updated_at AS updatedAt, support_count AS supportCount
         FROM concepts WHERE kind != 'workstream' ORDER BY id`,
      )
      .all();
    assertScopeAlreadyApplied(rows, dbPath);
    const scrubbed = rows.map((r) => scrubJson(r));
    writeFileSync(outPath, JSON.stringify(scrubbed, null, 2) + "\n", "utf8");
    return { count: scrubbed.length };
  } finally {
    db.close();
  }
}

// ── Scrub marker: sha256 of every file under eval-corpus/publish/, computed AFTER scrubbing ───

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * F5 fix (post-review): manifest is fully content-derived — NO wall-clock timestamp field. A
 * `scrubbedAt: new Date().toISOString()` field caused git churn on every regeneration even when
 * every published file's content (and thus every per-file hash below) was byte-identical to the
 * last run — the manifest would still show as "changed" in `git diff`, defeating the point of a
 * content-integrity marker. `contentHash` (sha256 over the JSON-joined, already-sorted per-file
 * hash entries) replaces it: it changes if and only if some file's content actually changed,
 * which is the only thing this marker should ever signal. Human-readable generation info (when/who
 * ran it) belongs in command output or a CI log, never in the tracked file itself.
 */
function writeScrubManifest(publishDir, manifestPath) {
  const files = collectFiles(publishDir);
  const hashes = {};
  for (const f of files) hashes[f] = sha256File(join(publishDir, f));
  // Deterministic content hash: sha256 over the sorted per-file hashes, joined in a fixed,
  // unambiguous shape (`${file}:${hash}` lines) — never over JSON.stringify(hashes) directly,
  // since object key order in JSON.stringify is technically an implementation detail this
  // shouldn't depend on (collectFiles already sorts `files`, but re-deriving from `hashes`
  // insertion order elsewhere would be fragile; this is explicit and self-contained).
  const contentHash = createHash("sha256")
    .update(files.map((f) => `${f}:${hashes[f]}`).join("\n"))
    .digest("hex");
  const manifest = {
    contentHash,
    fileCount: files.length,
    hashes,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let md = "eval-corpus/md";
  let db = "eval-corpus/db";
  let out = "eval-corpus/publish";
  for (const arg of argv) {
    if (arg.startsWith("--md=")) md = arg.slice("--md=".length);
    else if (arg.startsWith("--db=")) db = arg.slice("--db=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
  }
  return { md, db, out };
}

function main() {
  const { md, db, out } = parseArgs(process.argv.slice(2));
  const mdDir = resolve(REPO_ROOT, md);
  const dbDir = resolve(REPO_ROOT, db);
  const outDir = resolve(REPO_ROOT, out);

  if (!existsSync(mdDir)) throw new Error(`md export dir not found at ${mdDir}. Run scripts/export-corpus-md.ts first.`);
  if (!existsSync(dbDir)) throw new Error(`derived-db dir not found at ${dbDir}. Run scripts/sample-corpus.ts first.`);

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sizes = readdirSync(mdDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`Scrubbing corpus for sizes: ${sizes.join(", ")}\n`);

  for (const size of sizes) {
    const mdSizeDir = join(mdDir, size);
    const outSizeDir = join(outDir, size);
    const dbPath = join(dbDir, size, "monet.db");

    const mdStats = scrubMdSize(mdSizeDir, outSizeDir);
    console.log(
      `[${size}] md scrub — email hits found: ${mdStats.emailHits}, secret hits found: ${mdStats.secretHits}, ` +
        `path hits found: ${mdStats.pathHits}, private-endpoint hits found: ${mdStats.privateEndpointHits}, ` +
        `filenames renamed: ${mdStats.filenameRenames}`,
    );

    assertDerivedDbExists(dbPath, size, mdSizeDir);
    const dumpStats = dumpPublishableCorpus(dbPath, join(outSizeDir, "corpus.json"));
    console.log(`[${size}] corpus.json — ${dumpStats.count} concepts (no embedding, no raw source_refs)`);
  }

  const manifestPath = join(REPO_ROOT, "eval-corpus", "SCRUB_MANIFEST.json");
  const manifest = writeScrubManifest(outDir, manifestPath);
  console.log(`\nScrub marker written: ${manifestPath} (${manifest.fileCount} files hashed)`);
  console.log(`\nPublishable output under ${outDir}/<size>/{index.md,topics/*.md,chunks.json,corpus.json}`);
}

// Run only when invoked directly (`node scripts/scrub-corpus.mjs`), never as a side effect of
// importing this module's pure functions elsewhere (F3 fix's test coverage imports `scrubString`
// from src/__tests__/scrub-corpus.test.ts — that import must not also execute the full pipeline).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

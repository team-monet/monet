/**
 * scrub-db-closure.test.ts — THE DURABLE GUARD (mission's own framing, and the single most
 * important test in this fix round). A schema-driven closure test that does NOT enumerate columns
 * by name — it walks `sqlite_master`/`PRAGMA table_info` at runtime, over EVERY table and EVERY
 * TEXT-affinity column that exists in a given db file, and asserts every scrub pattern class
 * (email, secret, query-param-secret, bare-key, private-endpoint, /Users/ path, ~/ path) has ZERO
 * hits anywhere. This is deliberately NOT the same thing as "scrub-db.test.ts checks the columns
 * scrub-db.mjs is documented to touch" — those tests can pass while a NEW column (added to the
 * schema next month, or one this round's audit simply missed) still leaks. This test catches that
 * class of regression automatically, because it never hardcodes which columns to check.
 *
 * WHY THIS MUST BE NON-VACUOUS, PROVEN NOT ASSUMED: a closure test that iterates "every TEXT
 * column" but never actually finds a hit anywhere proves nothing — it could be vacuously green
 * because the traversal itself is broken (wrong PRAGMA call, wrong table filter, an off-by-one
 * that skips every row) just as easily as because the data is genuinely clean. This suite proves
 * non-vacuity directly: `describe("non-vacuity proof")` below runs the exact same closure-checking
 * function (`findScrubViolations`) against a DELIBERATELY UNSCRUBBED fixture db (built the same way
 * scrub-db.test.ts's own fixtures are, via a real MonetCore so the schema is never
 * hand-duplicated) and asserts it correctly FAILS (finds violations) — only then do the "against a
 * real scrubbed output" tests below it assert zero violations. If the traversal were broken in a
 * way that always returns zero hits, the non-vacuity test would catch it immediately (it would
 * wrongly report the unscrubbed fixture as clean).
 *
 * SCOPE, deliberately narrower than "every string that looks path-like": this test does not care
 * WHICH columns a human decided are sensitive — it re-derives the check straight from
 * scrub-patterns.mjs's own exported regexes (EMAIL_RE, SECRET_RE, QUERY_PARAM_SECRET_RE,
 * BARE_KEY_RE, PRIVATE_ENDPOINT_RE, USERS_PATH_RE, TILDE_PATH_RE — the exact same patterns
 * scrubString applies) against every TEXT-affinity value found by walking the schema. A column
 * whose CONTENT never happens to match any of these patterns (e.g. an embedding's JSON float
 * array, a UUID id, an enum-shaped status string) passes with zero violations not because it was
 * excluded, but because nothing in it matches — this is the correct, blind behavior: the guard
 * does not need to know in advance that `concepts.embedding` is "safe" and `contradictions.detail`
 * is "risky"; it treats every TEXT column identically and lets the patterns themselves decide.
 *
 * TEXT-AFFINITY DETECTION: uses `PRAGMA table_info(<table>).type`, matching on the SQLite type
 * name reported for every column in this schema (all declared "TEXT" — confirmed directly against
 * src/engine.ts's CREATE TABLE statements, no other affinity keyword like "VARCHAR"/"CLOB" is used
 * anywhere in this schema, but the check itself matches the broader SQLite TEXT-affinity family
 * case-insensitively, not just the literal string "TEXT", so it keeps working if a future column
 * is declared with a different but still TEXT-affinity type name).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { MonetCore } from "../engine";
import { SAMPLED_CIRCLE } from "../eval/corpus-scope.mjs";
// @ts-expect-error — plain .mjs script, no type declarations; imported for its exported pure functions only.
// (single-line import, matching scrub-db.test.ts's own established precedent for this exact
// directive: tsc attributes a multi-line import's module-resolution error to the line carrying the
// `from` specifier, not the opening `import {` line — a multi-line form here places this directive
// too far from the actual error site to suppress it, and gets flagged itself as "unused" while the
// real error still fires several lines down, unsuppressed.)
import { scrubSizeDb, scrubConceptsAndObservations, scrubConceptSlugs, rewriteAssertedSlugRefsInDb, scrubContradictions, scrubEntities, pruneStaleEntities, pruneOrphanedAboutEdges, emptyConceptRevisions, scrubFutureProofedColumns, assertSlugsUniquePerCircle } from "../../scripts/scrub-db.mjs";
// scrub-patterns.mjs HAS a sibling scrub-patterns.d.mts (unlike scrub-db.mjs above), so this import
// is fully typed already — no @ts-expect-error needed (an earlier version of this line carried one
// anyway and tsc correctly flagged it as unused).
import { EMAIL_RE, SECRET_RE, QUERY_PARAM_SECRET_RE, BARE_KEY_RE, PRIVATE_ENDPOINT_RE, USERS_PATH_RE, TILDE_PATH_RE } from "../eval/scrub-patterns.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * Every pattern class scrubString applies, named for readable failure output. A FRESH RegExp is
 * constructed per check (rather than reusing the imported global-flag RegExp objects directly)
 * because a `g`-flagged RegExp is STATEFUL (`.lastIndex` persists across `.test()`/`.exec()`
 * calls) — reusing the same instance across many values in a loop is a real, easy-to-introduce bug
 * class (a previous match's leftover `.lastIndex` silently causes the NEXT `.test()` call on a
 * fresh string to start mid-string and miss a real match at the beginning) that would undermine
 * this exact test's own correctness. Constructing fresh instances from `.source`/`.flags` sidesteps
 * it entirely rather than relying on remembering to reset `.lastIndex` at each call site.
 */
function patternClasses(): Array<{ name: string; re: RegExp }> {
  const sources: Array<{ name: string; re: RegExp }> = [
    { name: "email", re: EMAIL_RE },
    { name: "secret", re: SECRET_RE },
    { name: "query-param-secret", re: QUERY_PARAM_SECRET_RE },
    { name: "bare-key", re: BARE_KEY_RE },
    { name: "private-endpoint (incl. tenant form)", re: PRIVATE_ENDPOINT_RE },
    { name: "/Users/ path", re: USERS_PATH_RE },
    { name: "~/ path", re: TILDE_PATH_RE },
  ];
  return sources.map(({ name, re }) => ({ name, re: new RegExp(re.source, re.flags) }));
}

export interface ScrubViolation {
  table: string;
  column: string;
  rowid: number | string;
  pattern: string;
  match: string;
  valuePreview: string;
}

/**
 * THE closure check. Opens `dbPath` read-only, walks every user table (excludes sqlite_ internal
 * tables — the only ones `sqlite_master` can otherwise surface), every TEXT-affinity column on
 * each (via PRAGMA table_info), reads every row's value for that column, and tests it against
 * every pattern class. Returns every violation found (empty array = clean). Uses `rowid` (SQLite's
 * always-present implicit rowid — every table here is an ordinary rowid table, none declared
 * WITHOUT ROWID) rather than assuming a `id` column exists on every table with that exact name
 * (entities' PK column is literally named `key`, not `id` — a naive "assume every table has an
 * `id` column for reporting" approach would break on it).
 */
export function findScrubViolations(dbPath: string): ScrubViolation[] {
  const db = new Database(dbPath, { readonly: true });
  const violations: ScrubViolation[] = [];
  try {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
    ).map((r) => r.name);

    const patterns = patternClasses();

    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).filter((c) =>
        /text|char|clob/i.test(c.type),
      );
      if (columns.length === 0) continue;

      const colList = columns.map((c) => `"${c.name}"`).join(", ");
      const rows = db.prepare(`SELECT rowid AS __rowid, ${colList} FROM "${table}"`).all() as Array<Record<string, unknown>>;

      for (const row of rows) {
        for (const col of columns) {
          const value = row[col.name];
          if (typeof value !== "string" || value.length === 0) continue;
          for (const { name: patternName, re } of patterns) {
            re.lastIndex = 0;
            const match = re.exec(value);
            if (match) {
              violations.push({
                table,
                column: col.name,
                rowid: row.__rowid as number | string,
                pattern: patternName,
                match: match[0],
                valuePreview: value.length > 160 ? `${value.slice(0, 160)}…` : value,
              });
            }
          }
        }
      }
    }
  } finally {
    db.close();
  }
  return violations;
}

export interface RawByteViolation {
  pattern: string;
  match: string;
  contextPreview: string;
}

/**
 * ROUND 3, F1 closure extension: `findScrubViolations` above only ever reads through SQLite's own
 * SELECT machinery — i.e. it only ever sees a row's LIVE, current value. It is structurally blind
 * to the exact class of leak F1 found: SQLite never zeroes a page when a row is UPDATEd/DELETEd, so
 * pre-scrub bytes can still sit in freelist/overflow pages that no live SELECT will ever surface,
 * while still being trivially recoverable by anything that reads the file's RAW BYTES directly
 * (`strings dbfile | grep`, a hex editor, this function). `findRawByteViolations` closes that blind
 * spot: it reads `dbPath` as a raw Buffer (bypassing SQLite's b-tree/page machinery entirely),
 * converts to a latin1/binary string (byte-for-byte, no multi-byte decoding that could corrupt or
 * skip raw content), extracts every printable-ASCII run of length >= 8 (the same practical
 * threshold a real `strings` invocation would use), and runs the SAME 7 pattern classes
 * `findScrubViolations` already checks (EMAIL_RE, SECRET_RE, QUERY_PARAM_SECRET_RE, BARE_KEY_RE,
 * PRIVATE_ENDPOINT_RE, USERS_PATH_RE, TILDE_PATH_RE) over every extracted run.
 *
 * Failure output deliberately keeps only the matched substring and a short surrounding preview (NOT
 * the full file content, and not even the full printable run if it's long) — a raw-bytes scan can
 * legitimately turn up a huge run (e.g. spanning an entire page), and dumping all of it into a test
 * failure message would make the failure output itself unreadable, defeating the point of this
 * function returning something "actionable" per this suite's own stated design goal.
 *
 * KNOWN, INVESTIGATED LIMITATION (found running this against the REAL corpus, not a fixture — see
 * this file's "real corpus (if present)" test below for the full investigation): scanning raw bytes
 * for printable-ASCII runs can produce a FALSE POSITIVE for the `~/ path` (TILDE_PATH_RE) class
 * specifically, because that pattern's anchor is only 2 literal bytes (`~` immediately followed by
 * `/` — deliberately loosened this way by TILDE_PATH_RE's own P1-a fix, see scrub-patterns.mjs, so
 * a genuinely-truncated real path with nothing after the slash still redacts). A SQLite B-tree index
 * page's own internal cell-pointer/varint-length-prefix byte layout can coincidentally place a `~`
 * byte immediately before a `/` byte with no real path following — verified directly (dumped exact
 * byte codes around several real matches: the `/` is immediately followed by a non-printable control
 * byte, the signature of an index page, not path text) — this is NOT something this function
 * silently filters; callers that care about this distinction should treat a `~/ path`-only violation
 * (2-byte match, nothing meaningful after it) as lower-confidence than the other 6 pattern classes,
 * which all require much longer, harder-to-coincidentally-reproduce structure and were NEVER found
 * to false-positive against the real corpus.
 */
export function findRawByteViolations(dbPath: string): RawByteViolation[] {
  const buf = readFileSync(dbPath);
  const raw = buf.toString("latin1");
  const violations: RawByteViolation[] = [];
  const printableRuns = raw.match(/[\x20-\x7E]{8,}/g) ?? [];
  const patterns = patternClasses();

  for (const run of printableRuns) {
    for (const { name: patternName, re } of patterns) {
      re.lastIndex = 0;
      const match = re.exec(run);
      if (match) {
        const idx = match.index;
        const previewStart = Math.max(0, idx - 20);
        const previewEnd = Math.min(run.length, idx + match[0].length + 20);
        violations.push({
          pattern: patternName,
          match: match[0],
          contextPreview: run.length > 160 ? `${run.slice(previewStart, previewEnd)}` : run,
        });
      }
    }
  }
  return violations;
}

/**
 * Build a fixture db with sensitive content across the FULL set of surfaces this round's audit
 * found — deliberately broader than scrub-db.test.ts's own fixture, since this closure test's job
 * is to prove NOTHING leaks anywhere, not just the 3 originally-scrubbed columns. Uses a real
 * MonetCore (never a hand-duplicated schema) for concepts/observations, then drops to a raw
 * better-sqlite3 handle to seed contradictions/entities/concept_entities/concept_revisions/
 * first_block/sessions directly (these aren't populated by store() alone, or are populated in a
 * shape this test needs full control over to guarantee specific sensitive strings land in
 * specific columns for a deterministic assertion).
 *
 * ROUND 4 EXTENSION: also produces a REAL merge (via the public `reassignCircle` API — never a
 * hand-inserted `aliases` value, so the fixture proves the actual engine code path rather than an
 * approximation) so `concepts.aliases` carries a genuine merge-derived sensitive slug fragment
 * (G1), and seeds a hostile `observations.author_agent_id` (G2) via raw SQL (the same "drop to raw
 * SQL for exact column control" discipline this fixture already uses for
 * contradictions/entities/concept_revisions/first_block/sessions — `author_agent_id` is a
 * MonetCore CONSTRUCTOR option, not a per-`store()`-call parameter, so directly UPDATE-ing the
 * column here is simpler and just as faithful as spinning up a second MonetCore instance purely to
 * get one hostile agentId onto one row).
 */
async function buildUnscrubbedFixtureDb(path: string): Promise<void> {
  const core = new MonetCore(path);
  let conceptId!: string;
  let absorbedId!: string;
  try {
    const r = await core.store(
      "/Users/dev/code/monet-core/src/engine.ts is the file — contact jane.doe@example.com with questions, key_GZTqlLr41FS2p7AY is the API key.",
      { circle: SAMPLED_CIRCLE, sourceRefs: ["/Users/dev/.monet/monet.db", "~/code/with-monet/notes.md"] },
    );
    conceptId = r.conceptId!;

    // ROUND 4, G1: a REAL merge, via the public reassignCircle API. Two concepts with IDENTICAL text
    // (in two different circles) produce IDENTICAL embeddings under the default
    // HashingEmbeddingProvider (deterministic, no randomness — cosine similarity 1.0, always
    // >= tauAttach), so reassignCircle deterministically takes the MERGE branch (mergeConceptInto),
    // never the move branch. The absorbed concept's title leads with a sensitive path, so its
    // raw-title-derived slug (which mergeConceptInto carries onto the survivor's `aliases` column)
    // genuinely carries the leak.
    const absorbed = await core.store(
      "/Users/dev/merge-secret-notes.txt has the merge-history detail — reach jdoe@example.org with questions.",
      { circle: "closure-merge-a" },
    );
    absorbedId = absorbed.conceptId!;
    await core.store(
      "/Users/dev/merge-secret-notes.txt has the merge-history detail — reach jdoe@example.org with questions.",
      { circle: SAMPLED_CIRCLE },
    );
  } finally {
    core.close();
  }

  // Read the absorbed concept's RAW slug directly (authoritative, and needed BEFORE the merge
  // deletes the row — mergeConceptInto's own `DELETE FROM concepts WHERE id = ?` removes it), then
  // find the survivor (the OTHER SAMPLED_CIRCLE concept — the one just stored above), then perform
  // the actual merge via reassignCircle.
  const preMergeDb = new Database(path);
  let survivorId!: string;
  let absorbedRawSlug!: string;
  try {
    const absorbedRow = preMergeDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(absorbedId) as { slug: string };
    absorbedRawSlug = absorbedRow.slug;
    const survivorRow = preMergeDb.prepare(`SELECT id FROM concepts WHERE circle = ? AND id != ?`).get(SAMPLED_CIRCLE, conceptId) as
      | { id: string }
      | undefined;
    survivorId = survivorRow!.id;
  } finally {
    preMergeDb.close();
  }

  const mergeCore = new MonetCore(path);
  try {
    const result = mergeCore.reassignCircle(absorbedId, SAMPLED_CIRCLE);
    if (result?.action !== "merged") {
      throw new Error(
        `buildUnscrubbedFixtureDb: expected a REAL merge (action "merged") for the G1 aliases fixture, got "${result?.action}" — ` +
          `the two concepts' embeddings must be identical (same text) for reassignCircle's own dedup to take the merge branch.`,
      );
    }
  } finally {
    mergeCore.close();
  }

  const db = new Database(path);
  try {
    // ROUND 5, H2: resolved_by seeded with a hostile-shaped (email) caller-supplied label — see
    // scrub-db.mjs's "AUDIT FINDINGS, ROUND 5" H2 for the real-corpus evidence this is defensive,
    // not hypothetical (contradictions.resolved_by already carries live non-placeholder values
    // today, just none of them happen to be email/path-shaped).
    db.prepare(
      `INSERT INTO contradictions (id, concept_id, kind, status, detail, resolved_by) VALUES (?, ?, 'value-conflict', 'open', ?, ?)`,
    ).run(
      "contra-1",
      conceptId,
      "correction: the real endpoint is http://192.168.1.10:9301, tenant acme — not what was previously recorded.",
      "jane.doe@example.com",
    );

    db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run(
      conceptId,
      "ref:/Users/dev/.claude/CLAUDE.md",
      SAMPLED_CIRCLE,
    );
    db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, 'path', ?, ?, 1)`).run(
      "ref:/Users/dev/.claude/CLAUDE.md",
      "/Users/dev/.claude/CLAUDE.md",
      SAMPLED_CIRCLE,
    );

    db.prepare(
      `INSERT INTO concept_revisions (id, concept_id, version, body, created_at) VALUES (?, ?, 0, ?, unixepoch() * 1000)`,
    ).run("rev-1", conceptId, "Prior version: reach me at jane.doe@example.com or ~/.monet/monet.db.");

    // ROUND 5, H2: promoted_by seeded with a hostile-shaped (/Users/ path) caller-supplied label.
    db.prepare(
      `INSERT INTO first_block (id, concept_id, circle, summary, position, promoted_by) VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(
      "fb-1",
      conceptId,
      SAMPLED_CIRCLE,
      "Pinned note: the private endpoint is 192.168.1.10:9301, tenant acme.",
      "/Users/dev/agents/curation-bot",
    );

    db.prepare(
      `INSERT INTO sessions (id, agent_id, scope_context, summary) VALUES (?, 'test-agent', ?, ?)`,
    ).run("sess-1", "/Users/dev/code/monet-core-phase1", "Session touched jane.doe@example.com and ~/code/foo.");

    // ROUND 4, G2: seed a hostile author_agent_id directly on the primary concept's own observation
    // row (raw SQL — author_agent_id is a MonetCore CONSTRUCTOR option, not a per-store()-call
    // parameter, so this is the simplest faithful way to control it precisely for this test).
    db.prepare(`UPDATE observations SET author_agent_id = ? WHERE concept_id = ?`).run("jane.doe@example.com", conceptId);

    // ROUND 5, H1: seed a hostile sessions.agent_id directly (raw SQL — same "MonetCore CONSTRUCTOR
    // option, not per-call" reasoning as author_agent_id above). Uses the auto-created session row
    // from the primary `core.store()` call above (buildUnscrubbedFixtureDb's own MonetCore instance
    // opens exactly one session, shared across all its store() calls, matching buildFixtureDb's own
    // documented "ONE session row" behavior in scrub-db.test.ts) rather than "sess-1" (which is a
    // separately, manually-seeded row already covering the summary/scope_context case above).
    db.prepare(`UPDATE sessions SET agent_id = ? WHERE id != 'sess-1'`).run("jane.doe@example.com");

    // ROUND 5, H2: memory_edge.dismissed_by seeded with a hostile-shaped (email) caller-supplied
    // label. src_id/dst_id reference the real primary/absorbed concept ids (no declared FK on
    // memory_edge, but using real ids keeps this fixture faithful to what a genuine
    // possible_duplicate_of edge looks like).
    db.prepare(
      `INSERT INTO memory_edge (id, src_id, dst_id, type, dismissed_at, dismissed_by) VALUES (?, ?, ?, 'possible_duplicate_of', unixepoch() * 1000, ?)`,
    ).run("edge-1", conceptId, survivorId, "jane.doe@example.com");

    // Non-vacuity precondition for the G1 fixture extension: confirm the merge actually left the
    // absorbed concept's sensitive raw slug in the survivor's aliases BEFORE any scrub runs — thrown
    // (not just asserted in a describe block) so a fixture regression fails loudly at BUILD time,
    // immediately at the source, rather than surfacing as a confusing downstream assertion failure.
    const survivorRow = db.prepare(`SELECT aliases FROM concepts WHERE id = ?`).get(survivorId) as { aliases: string | null };
    if (!survivorRow.aliases || !JSON.parse(survivorRow.aliases).includes(absorbedRawSlug)) {
      throw new Error(
        `buildUnscrubbedFixtureDb: expected the survivor's aliases to contain the absorbed concept's raw slug ` +
          `"${absorbedRawSlug}" after a real merge — got aliases=${survivorRow.aliases}. The G1 fixture extension is broken.`,
      );
    }
  } finally {
    db.close();
  }

  // ROUND 5, J1 EXTENSION: a genuine `resolves: #<old-slug>` asserted-ref from ONE concept to a
  // SEPARATE, sensitive-titled concept — via the real public store() API (so deriveAssertedEdges,
  // engine.ts, genuinely parses it into a real `resolves`-type memory_edge, not just textually
  // present), exactly mirroring scrub-db.test.ts's own dedicated J1 fixture. A NEW concept (not
  // conceptId/absorbedId/survivorId above) is used for the sensitive-titled side specifically so
  // its slug is NOT subject to the proof-repo path-generalization exception scrubString's own
  // scrubPathToken applies to /monet-core/-rooted paths (see scrub-patterns.mjs's own module doc)
  // — this fixture needs a slug that is FULLY redacted, not partially generalized, to give this
  // round's non-vacuity proof an unambiguous "old slug nowhere in ANY text column" bar to clear.
  // Content/topic is deliberately DISTINCT from every other concept this builder already seeded
  // (verified empirically: an earlier draft using "...has the details — contact
  // jane.doe@example.com about..." — similar surface structure to the merge-secret-notes concept
  // above — got AUTO-MERGED by the engine's own dedup into that pre-existing concept instead of
  // creating a new row, silently invalidating this fixture's own "two distinct concepts" premise).
  const j1Core = new MonetCore(path);
  let j1SensitiveId!: string;
  let j1ReferrerId!: string;
  try {
    const sensitive = await j1Core.store(
      "/Users/dev/j1-payroll-audit-ledger.csv owns the quarterly compensation review " +
        "spreadsheet for the finance team offsite planning session.",
      { circle: SAMPLED_CIRCLE },
    );
    j1SensitiveId = sensitive.conceptId!;
    const sensitiveRow = (await j1Core.getConcept(j1SensitiveId))!;
    const oldSlug = sensitiveRow.slug;

    // Long, topically-distinct referrer content — avoids the engine's own similarity-based dedup
    // attaching this store() call to the existing sensitive concept instead of creating a new one
    // (verified empirically while designing scrub-db.test.ts's own identical J1 fixture: a
    // short/generic referrer body gets MERGED instead of creating a separate concept).
    const referrer = await j1Core.store(
      `On-call rotation handoff is now complete for the payments-service incident review process, ` +
        `an entirely unrelated topic about container orchestration and pod scheduling policy. ` +
        `resolves: #${oldSlug} ` +
        "z".repeat(200),
      { circle: SAMPLED_CIRCLE },
    );
    j1ReferrerId = referrer.conceptId!;
  } finally {
    j1Core.close();
  }

  // Non-vacuity precondition for the J1 fixture extension: confirm the two concepts are genuinely
  // distinct (dedup did not merge them) and the referrer's body genuinely carries the old slug as
  // a real `#ref` token — thrown at BUILD time, same discipline as the G1 check above.
  const j1CheckDb = new Database(path, { readonly: true });
  try {
    if (j1ReferrerId === j1SensitiveId) {
      throw new Error(
        `buildUnscrubbedFixtureDb: expected the J1 referrer and sensitive concepts to be DISTINCT rows — ` +
          `got the same id (${j1ReferrerId}), meaning dedup merged them. The J1 fixture extension is broken.`,
      );
    }
    const sensitiveRow = j1CheckDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(j1SensitiveId) as { slug: string };
    const referrerRow = j1CheckDb.prepare(`SELECT body FROM concepts WHERE id = ?`).get(j1ReferrerId) as { body: string };
    if (!referrerRow.body.includes(`#${sensitiveRow.slug}`)) {
      throw new Error(
        `buildUnscrubbedFixtureDb: expected the J1 referrer's body to contain "#${sensitiveRow.slug}" — ` +
          `got body=${referrerRow.body.slice(0, 200)}. The J1 fixture extension is broken.`,
      );
    }
  } finally {
    j1CheckDb.close();
  }
}

describe("non-vacuity proof — the closure check correctly FAILS against unscrubbed content", () => {
  it("finds violations across every surface this round's audit identified, in a deliberately unscrubbed fixture", async () => {
    const dir = mkTmp("scrub-closure-vacuity-");
    const dbPath = join(dir, "monet.db");
    await buildUnscrubbedFixtureDb(dbPath);

    const violations = findScrubViolations(dbPath);

    expect(violations.length).toBeGreaterThan(0);

    const byTable = new Set(violations.map((v) => v.table));
    // Every surface this audit round found must show up as a violation in the UNSCRUBBED fixture —
    // proving the traversal actually reaches each of these tables/columns, not just that SOME
    // violation somewhere was found (a weaker, less useful proof of non-vacuity).
    expect(byTable).toContain("concepts"); // title/body/source_refs
    expect(byTable).toContain("observations"); // content/source_refs/author_agent_id (round 4, G2)
    expect(byTable).toContain("contradictions"); // detail, resolved_by (round 5, H2)
    expect(byTable).toContain("entities"); // key/surface
    expect(byTable).toContain("concept_entities"); // entity_key
    expect(byTable).toContain("concept_revisions"); // body
    expect(byTable).toContain("first_block"); // summary, promoted_by (round 5, H2)
    expect(byTable).toContain("sessions"); // scope_context, summary, agent_id (round 5, H1)
    expect(byTable).toContain("memory_edge"); // dismissed_by (round 5, H2) — new to this fixture

    // Spot-check a few exact matches, not just "some pattern fired somewhere" — proves the
    // traversal reads the right column, not an adjacent one that happens to also match.
    expect(violations.some((v) => v.table === "contradictions" && v.column === "detail" && v.pattern.startsWith("private-endpoint"))).toBe(
      true,
    );
    expect(violations.some((v) => v.table === "entities" && v.column === "key" && v.pattern === "/Users/ path")).toBe(true);
    expect(violations.some((v) => v.table === "concept_entities" && v.column === "entity_key" && v.pattern === "/Users/ path")).toBe(true);
    expect(violations.some((v) => v.table === "concept_revisions" && v.column === "body" && v.pattern === "email")).toBe(true);
    expect(violations.some((v) => v.table === "first_block" && v.column === "summary")).toBe(true);
    expect(violations.some((v) => v.table === "sessions" && (v.column === "scope_context" || v.column === "summary"))).toBe(true);
    // Round 4, G2: the hostile author_agent_id seeded on the fixture's primary observation IS
    // pattern-matchable (a plain email) — the schema-driven traversal reaches this column too.
    expect(violations.some((v) => v.table === "observations" && v.column === "author_agent_id" && v.pattern === "email")).toBe(true);
    // Round 5, H1: the hostile sessions.agent_id seeded above IS pattern-matchable (a plain email).
    expect(violations.some((v) => v.table === "sessions" && v.column === "agent_id" && v.pattern === "email")).toBe(true);
    // Round 5, H2: the hostile contradictions.resolved_by / first_block.promoted_by /
    // memory_edge.dismissed_by seeded above are each pattern-matchable.
    expect(violations.some((v) => v.table === "contradictions" && v.column === "resolved_by" && v.pattern === "email")).toBe(true);
    expect(violations.some((v) => v.table === "first_block" && v.column === "promoted_by" && v.pattern === "/Users/ path")).toBe(true);
    expect(violations.some((v) => v.table === "memory_edge" && v.column === "dismissed_by" && v.pattern === "email")).toBe(true);
  });

  it("round 4, G1: concepts.aliases carries the merge-derived leak, but is NOT caught by findScrubViolations' pattern matching (documented, same accepted limitation as the entity-fragment leak) — needs its OWN dedicated check", async () => {
    // See scrub-db.mjs's own "ACCEPTED, DOCUMENTED LIMITATION" doc comment (on pruneStaleEntities)
    // for the identical precedent: a slugified fragment like "users-dev-merge-secret-notes" has
    // already had its punctuation (the "/", the ".") destroyed by slugify() into plain hyphens —
    // EMAIL_RE/USERS_PATH_RE/etc. key off that punctuation, so they correctly find NOTHING in an
    // already-slugified string. This is not a gap in findScrubViolations' traversal (it DOES read
    // `concepts.aliases` — it's a TEXT column like any other) — it's a gap in what PATTERN MATCHING
    // alone can prove, exactly parallel to the entity-fragment leak's "gmail.com" bare-fragment case.
    // Verifying this fix therefore needs a DIRECT, content-specific check (mirroring how
    // pruneStaleEntities' effectiveness is verified by its own dedicated fragment assertions below,
    // not by this schema-driven pattern guard), not an addition to the pattern-based assertion list
    // above.
    const dir = mkTmp("scrub-closure-aliases-vacuity-");
    const dbPath = join(dir, "monet.db");
    await buildUnscrubbedFixtureDb(dbPath);

    const db = new Database(dbPath, { readonly: true });
    let rows: Array<{ id: string; aliases: string | null }>;
    try {
      rows = db.prepare(`SELECT id, aliases FROM concepts WHERE aliases IS NOT NULL`).all() as Array<{
        id: string;
        aliases: string | null;
      }>;
    } finally {
      db.close();
    }
    // Non-vacuity: at least one row (the merge survivor) has a non-null aliases value BEFORE
    // scrubbing, and it contains the absorbed concept's raw, sensitive, slugified fragment.
    expect(rows.length).toBeGreaterThan(0);
    const anyAliasesContainsLeak = rows.some((r) => r.aliases!.includes("merge-secret-notes"));
    expect(anyAliasesContainsLeak).toBe(true);

    // Confirm findScrubViolations genuinely does NOT flag this column for THIS specific value — not
    // asserted as a desirable property, but documented as the accepted, understood limitation this
    // test exists to make visible rather than silently assume.
    const violations = findScrubViolations(dbPath);
    const aliasesViolations = violations.filter((v) => v.table === "concepts" && v.column === "aliases");
    expect(aliasesViolations).toEqual([]); // documented limitation, not a bug in the traversal
  });

  it("round 5, J1: a referring concept's body carries a stale `#<old-slug>` asserted-ref fragment, but is NOT caught by findScrubViolations' pattern matching (same accepted limitation as the entity-fragment/aliases leaks) — needs its OWN dedicated check, and PROVES NON-VACUITY against the pre-J1-fix pipeline", async () => {
    // Same "slugified fragment has no punctuation left for EMAIL_RE/USERS_PATH_RE to key off"
    // limitation as the entity-fragment leak and the G1 aliases leak above — a `#users-dev-j1-
    // payroll-audit-ledger` token has already had its "/" and "." destroyed by slugify() into plain
    // hyphens, so pattern matching alone correctly finds nothing here. This test proves BOTH halves
    // required by this fix round: (1) the leak is real BEFORE any scrub runs (ordinary non-vacuity),
    // AND (2) — the specific "prove non-vacuity against pre-fix behavior" requirement — that running
    // the PRE-J1-FIX pipeline (scrubConceptsAndObservations + scrubConceptSlugs, WITHOUT the new
    // rewriteAssertedSlugRefsInDb step) leaves the leak fully intact, so this test would have FAILED
    // to catch a regression before the fix existed, and correctly PASSES once
    // rewriteAssertedSlugRefsInDb is wired in — a genuine before/after contrast, not just a fixed
    // "look, it's fixed" assertion.
    const dir = mkTmp("scrub-closure-j1-vacuity-");
    const dbPath = join(dir, "monet.db");
    await buildUnscrubbedFixtureDb(dbPath);

    // Locate the J1 fixture's two concepts by content shape (the builder doesn't return ids, same
    // convention the G1 aliases test above already follows — re-derive from the db directly).
    // Matches on "j1-payroll-audit-ledger" specifically (not the shared "users-dev" prefix,
    // which every path-derived concept this builder seeds also carries) so this test's own
    // assertions are precise to ITS OWN fixture concept, not accidentally satisfied by a totally
    // different concept's slug that happens to share the same leading path segment.
    const preDb = new Database(dbPath, { readonly: true });
    let sensitiveId: string;
    let referrerId: string;
    let oldSlug: string;
    try {
      const sensitiveRow = preDb
        .prepare(`SELECT id, slug FROM concepts WHERE title LIKE '%j1-payroll-audit-ledger%'`)
        .get() as { id: string; slug: string } | undefined;
      expect(sensitiveRow).toBeDefined(); // non-vacuity: the J1 fixture concept exists
      sensitiveId = sensitiveRow!.id;
      oldSlug = sensitiveRow!.slug;
      expect(oldSlug).toContain("j1-payroll-audit-ledger"); // non-vacuity: the raw slug really does leak the path

      const referrerRow = preDb
        .prepare(`SELECT id, body FROM concepts WHERE body LIKE ?`)
        .get(`%resolves: #${oldSlug}%`) as { id: string; body: string } | undefined;
      expect(referrerRow).toBeDefined(); // non-vacuity: a real referring concept exists
      referrerId = referrerRow!.id;
      expect(referrerRow!.body).toContain(`#${oldSlug}`);
    } finally {
      preDb.close();
    }

    // THE "AGAINST PRE-FIX BEHAVIOR" PROOF: run ONLY the pre-J1-fix functions — the same two calls
    // scrubSizeDb's pipeline made before this round's fix added rewriteAssertedSlugRefsInDb — and
    // confirm the leak SURVIVES. This is what makes the fix's own non-vacuity concrete: it is not
    // merely "the post-fix pipeline happens to be clean", it is "the identical fixture, run through
    // the identical PRIOR pipeline, provably still leaks".
    const preFixCopyPath = join(dir, "pre-fix-copy.db");
    copyFileSync(dbPath, preFixCopyPath); // fresh independent copy — deleted with the tmpdir either way
    const preFixCopyDb = new Database(preFixCopyPath);
    try {
      scrubConceptsAndObservations(preFixCopyDb);
      scrubConceptSlugs(preFixCopyDb);
      // Deliberately NO rewriteAssertedSlugRefsInDb call — this IS the pre-fix pipeline.
      const row = preFixCopyDb.prepare(`SELECT body FROM concepts WHERE id = ?`).get(referrerId) as { body: string };
      expect(row.body).toContain(oldSlug); // PROVEN: the pre-fix pipeline genuinely still leaks
      expect(row.body).toContain("j1-payroll-audit-ledger");
    } finally {
      preFixCopyDb.close();
    }

    // THE ACTUAL FIX, run against the ORIGINAL fixture copy: the full real pipeline via
    // scrubSizeDb (which DOES call rewriteAssertedSlugRefsInDb, in its real production order).
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(dbPath, dstPath);

    const scrubbedDb = new Database(dstPath, { readonly: true });
    try {
      const newSlugRow = scrubbedDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(sensitiveId) as { slug: string };
      const newSlug = newSlugRow.slug;
      expect(newSlug).not.toBe(oldSlug);
      expect(newSlug).not.toContain("j1-payroll-audit-ledger");

      const referrerRow = scrubbedDb.prepare(`SELECT body FROM concepts WHERE id = ?`).get(referrerId) as { body: string };
      // THE J1 FIX ITSELF, proven at the closure level: the old slug survives NOWHERE in this
      // column, and the new slug appears in the exact ref-shaped position instead.
      expect(referrerRow.body).not.toContain(oldSlug);
      expect(referrerRow.body).not.toContain("j1-payroll-audit-ledger");
      expect(referrerRow.body).toContain(`resolves: #${newSlug}`);

      // Confirm findScrubViolations genuinely does NOT flag THIS SPECIFIC leak by pattern alone —
      // not a desirable property, the documented accepted limitation this test exists to make
      // visible (same as the G1 aliases test above) — verified against the PRE-fix copy (where the
      // leak is known to still exist), not the already-fixed scrubbed copy (where "0 violations"
      // would be true for the boring reason that nothing leaks at all, proving nothing about
      // pattern-matching limits specifically). Filters on the SLUGIFIED form (hyphenated, no "/" or
      // "."), not the raw path — the raw path in concept_revisions.body IS correctly caught by
      // USERS_PATH_RE (concept_revisions is untouched by this test's deliberately partial pre-fix
      // pipeline, which only calls scrubConceptsAndObservations/scrubConceptSlugs — a real,
      // EXPECTED violation, not the slugified-fragment blind spot this assertion targets).
      const violations = findScrubViolations(preFixCopyPath);
      const slugFragmentViolations = violations.filter((v) => v.match === oldSlug);
      expect(slugFragmentViolations).toEqual([]); // documented limitation: a slugified fragment has no pattern-matchable structure
    } finally {
      scrubbedDb.close();
    }
  });

  it("also fails against the OLD (round-1, 3-column-only) scrub behavior — proving this closure test would have caught the original audit's finding", async () => {
    // Simulates what the original scrub-db.mjs did: scrub ONLY concepts.title/body and
    // observations.content, leaving every other surface (contradictions.detail, source_refs,
    // entities, concept_revisions, first_block, sessions) untouched. This is not a hypothetical —
    // it is exactly the diff between this fix round and the version that was cold-audited and
    // BLOCKED, reconstructed here directly (not imported from git history) so this test doesn't
    // depend on a prior commit still existing on disk.
    const dir = mkTmp("scrub-closure-old-behavior-");
    const dbPath = join(dir, "monet.db");
    await buildUnscrubbedFixtureDb(dbPath);

    const db = new Database(dbPath);
    try {
      const { scrubString } = await import("../eval/scrub-patterns.mjs");
      for (const row of db.prepare(`SELECT id, title, body FROM concepts`).all() as Array<{ id: string; title: string; body: string }>) {
        db.prepare(`UPDATE concepts SET title = ?, body = ? WHERE id = ?`).run(scrubString(row.title), scrubString(row.body), row.id);
      }
      for (const row of db.prepare(`SELECT id, content FROM observations`).all() as Array<{ id: string; content: string }>) {
        db.prepare(`UPDATE observations SET content = ? WHERE id = ?`).run(scrubString(row.content), row.id);
      }
    } finally {
      db.close();
    }

    const violations = findScrubViolations(dbPath);
    expect(violations.length).toBeGreaterThan(0);
    // concepts.title/body and observations.content ARE clean now (old behavior's own scope worked
    // for what it covered) — the remaining violations are exactly the surfaces the audit found.
    expect(violations.some((v) => v.table === "concepts" && v.column === "body")).toBe(false);
    expect(violations.some((v) => v.table === "observations" && v.column === "content")).toBe(false);
    expect(violations.some((v) => v.table === "concepts" && v.column === "source_refs")).toBe(true);
    expect(violations.some((v) => v.table === "contradictions")).toBe(true);
    expect(violations.some((v) => v.table === "entities")).toBe(true);
  });
});

describe("closure — the FIXED scrub-db.mjs produces zero violations anywhere in its output", () => {
  it("scrubSizeDb's output has zero pattern hits across every table and every TEXT column, schema-driven", async () => {
    const dir = mkTmp("scrub-closure-fixed-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const violations = findScrubViolations(dstPath);
    if (violations.length > 0) {
      // Surface every violation's exact location on failure — this is the whole point of this
      // test existing, so a failure must be immediately actionable, not just "something leaked".
      const detail = violations.map((v) => `${v.table}.${v.column} (rowid ${v.rowid}): [${v.pattern}] matched "${v.match}" in "${v.valuePreview}"`).join("\n");
      throw new Error(`scrub-db-closure: ${violations.length} violation(s) found:\n${detail}`);
    }
    expect(violations).toEqual([]);
  });

  it("round 5, J4: scrubSizeDb's output has NO duplicate (circle, slug) pairs anywhere — assertSlugsUniquePerCircle passes against the real pipeline's own output", async () => {
    // Closure-level proof of the J4 fix, using the SAME schema-driven "prove it against the real
    // pipeline's output" discipline as the pattern-hit test immediately above, rather than only
    // scrub-db.test.ts's own targeted unit test (which forces a SPECIFIC second-order collision
    // scenario) — this test instead re-derives the invariant straight from
    // buildUnscrubbedFixtureDb's full real fixture (which, per this round's audit, ALREADY contains
    // a real base-slug collision opportunity via its multiple /Users/dev/-prefixed concepts),
    // proving the disambiguation policy holds for the fixture this whole file already exercises,
    // not just a fixture engineered specifically to force the second-order case.
    const dir = mkTmp("scrub-closure-j4-uniqueness-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      // Direct ground-truth check (independent of assertSlugsUniquePerCircle's own internals, same
      // "don't just re-run the function under test as its own proof" discipline this file already
      // follows elsewhere) — re-derives the invariant straight from the SQL, then ALSO confirms the
      // exported helper itself agrees.
      const dupes = db
        .prepare(`SELECT circle, slug, COUNT(*) AS n FROM concepts GROUP BY circle, slug HAVING COUNT(*) > 1`)
        .all() as Array<{ circle: string; slug: string; n: number }>;
      expect(dupes).toEqual([]);
      expect(() => assertSlugsUniquePerCircle(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("ALSO prunes the entity-fragment leak (a 6th finding, beyond pattern-matching alone) — id:jane.doe/id:example.com/noun:acme do not survive", async () => {
    // findScrubViolations() above checks PATTERN matches only, and by design (see this test file's
    // own module doc + scrub-db.mjs's "ACCEPTED, DOCUMENTED LIMITATION" for pruneStaleEntities) a
    // bare fragment like "jane.doe" or "acme" alone matches NO scrub pattern — so the "zero
    // violations" test above would pass even if pruneStaleEntities were silently removed from the
    // pipeline. This test closes that blind spot by checking the SPECIFIC known fragment keys
    // directly, proving the fragment-pruning fix is actually wired into scrubSizeDb's pipeline,
    // not just proving "no pattern matched anywhere".
    const dir = mkTmp("scrub-closure-fragments-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const keys = new Set((db.prepare(`SELECT key FROM entities`).all() as Array<{ key: string }>).map((r) => r.key));
      expect(keys.has("id:jane.doe")).toBe(false);
      expect(keys.has("id:example.com")).toBe(false);
      expect(keys.has("noun:acme")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("round 4, G1: ALSO clears the merge-derived aliases leak (beyond pattern-matching alone) — no concept's aliases column survives with the absorbed concept's raw slug fragment", async () => {
    // Mirrors the entity-fragment-leak test immediately above exactly: findScrubViolations()'
    // pattern-matching alone cannot prove this (a slugified fragment has no punctuation left for
    // EMAIL_RE/USERS_PATH_RE to key off — see the dedicated non-vacuity test above for the full
    // explanation) — so this test checks the SPECIFIC known leak directly, proving
    // clearConceptAliases is actually wired into scrubSizeDb's real pipeline.
    const dir = mkTmp("scrub-closure-aliases-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const rows = db.prepare(`SELECT id, aliases FROM concepts`).all() as Array<{ id: string; aliases: string | null }>;
      expect(rows.length).toBeGreaterThan(0); // sanity: there ARE concepts to check
      for (const row of rows) {
        expect(row.aliases).toBeNull(); // EVERY concept's aliases is NULL post-scrub, not just the merge survivor's
      }
    } finally {
      db.close();
    }
  });

  it("round 4, G2: observations.author_agent_id is scrubbed in scrubSizeDb's real pipeline output", async () => {
    const dir = mkTmp("scrub-closure-agentid-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const rows = db.prepare(`SELECT author_agent_id FROM observations`).all() as Array<{ author_agent_id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      const joined = rows.map((r) => r.author_agent_id).join(" ");
      expect(joined).not.toContain("jane.doe@example.com");
      expect(joined).toContain("[redacted-email]");
    } finally {
      db.close();
    }
  });

  it("round 5, H1: sessions.agent_id is scrubbed in scrubSizeDb's real pipeline output", async () => {
    const dir = mkTmp("scrub-closure-session-agentid-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const rows = db.prepare(`SELECT agent_id FROM sessions`).all() as Array<{ agent_id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      const joined = rows.map((r) => r.agent_id).join(" ");
      expect(joined).not.toContain("jane.doe@example.com");
      expect(joined).toContain("[redacted-email]");
    } finally {
      db.close();
    }
  });

  it("round 5, H2: contradictions.resolved_by, memory_edge.dismissed_by, and first_block.promoted_by are all scrubbed in scrubSizeDb's real pipeline output", async () => {
    const dir = mkTmp("scrub-closure-auditlabels-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const contraRows = db.prepare(`SELECT resolved_by FROM contradictions WHERE resolved_by IS NOT NULL`).all() as Array<{
        resolved_by: string;
      }>;
      expect(contraRows.length).toBeGreaterThan(0);
      const contraJoined = contraRows.map((r) => r.resolved_by).join(" ");
      expect(contraJoined).not.toContain("jane.doe@example.com");
      expect(contraJoined).toContain("[redacted-email]");

      const edgeRows = db.prepare(`SELECT dismissed_by FROM memory_edge WHERE dismissed_by IS NOT NULL`).all() as Array<{
        dismissed_by: string;
      }>;
      expect(edgeRows.length).toBeGreaterThan(0);
      const edgeJoined = edgeRows.map((r) => r.dismissed_by).join(" ");
      expect(edgeJoined).not.toContain("jane.doe@example.com");
      expect(edgeJoined).toContain("[redacted-email]");

      const fbRows = db.prepare(`SELECT promoted_by FROM first_block WHERE promoted_by IS NOT NULL`).all() as Array<{
        promoted_by: string;
      }>;
      expect(fbRows.length).toBeGreaterThan(0);
      const fbJoined = fbRows.map((r) => r.promoted_by).join(" ");
      expect(fbJoined).not.toContain("/Users/dev");
      expect(fbJoined).toContain("[redacted-path]");
    } finally {
      db.close();
    }
  });

  it("concept_revisions is emptied entirely (0 rows), not merely scrubbed", async () => {
    const dir = mkTmp("scrub-closure-revisions-");
    const srcPath = join(dir, "src-monet.db");
    await buildUnscrubbedFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    try {
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM concept_revisions`).get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("is schema-blind: a hypothetical NEW column with sensitive content would be caught by this closure test even though scrub-db.mjs doesn't know about it (meta-test)", () => {
    // This test doesn't touch scrub-db.mjs at all — it proves findScrubViolations() ITSELF would
    // catch a brand-new, never-anticipated TEXT column carrying sensitive content, by building a
    // db with a schema scrub-db.mjs has never heard of and confirming the closure check still
    // flags it. This is the "catches future schema additions automatically" property the mission
    // asked for, demonstrated directly rather than just asserted in a comment.
    const dir = mkTmp("scrub-closure-schema-blind-");
    const dbPath = join(dir, "monet.db");
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE future_hypothetical_table (id TEXT PRIMARY KEY, notes TEXT)`);
      db.prepare(`INSERT INTO future_hypothetical_table (id, notes) VALUES (?, ?)`).run(
        "row-1",
        "Reach the on-call at oncall@example.com or /Users/dev/code/incident-notes.md.",
      );
    } finally {
      db.close();
    }

    const violations = findScrubViolations(dbPath);
    expect(violations.some((v) => v.table === "future_hypothetical_table" && v.column === "notes")).toBe(true);
  });
});

/**
 * Build a fixture large/dense enough that a plain UPDATE-based scrub (no VACUUM) genuinely leaves
 * recoverable freed-page remnants — verified empirically that this is NOT automatic for a small
 * fixture (a scratch probe against a 3-concept fixture the size of this suite's other fixtures did
 * NOT reliably reproduce the leak; SQLite's page-reuse behavior means a small single-row UPDATE can
 * land its old/new value on the exact same page with no page ever fully freed). 40 concepts, each
 * with distinct sensitive strings PLUS enough padding content (300+ filler chars) to force multiple
 * SQLite pages per concept, reliably reproduces real freed-page remnants — confirmed directly via a
 * scratch run of this exact shape before writing this fixture into the test suite.
 */
async function buildRawByteLeakFixtureDb(path: string): Promise<{ conceptIds: string[] }> {
  const core = new MonetCore(path);
  const conceptIds: string[] = [];
  try {
    for (let i = 0; i < 40; i++) {
      const r = await core.store(
        `Concept number ${i}: contact jane.doe${i}@example.com about /Users/dev/secret-${i}.txt, ` +
          `key_GZTqlLr41FS2p7AY${i} is the key, reachable at 192.168.0.${i % 250}:9301, tenant acme. ` +
          "x".repeat(300),
        { circle: SAMPLED_CIRCLE },
      );
      conceptIds.push(r.conceptId!);
    }
  } finally {
    core.close();
  }
  return { conceptIds };
}

describe("raw-bytes closure — no pre-scrub text survives anywhere in the published file's bytes", () => {
  it("non-vacuity: the SAME scrub pipeline MINUS the VACUUM step leaves real, recoverable pre-scrub text in the output file's raw bytes", async () => {
    // Replicates scrubSizeDb's own copy+scrub steps manually, SKIPPING the VACUUM step this round's
    // F1 fix adds — proving findRawByteViolations correctly FAILS (finds violations) against
    // exactly the round-2 (pre-F1) scrub behavior, using the REAL scrub functions (not a
    // hand-rolled approximation), so this is a faithful reproduction of what shipped before this
    // fix, not a synthetic strawman.
    const dir = mkTmp("scrub-rawbytes-vacuity-");
    const srcPath = join(dir, "src-monet.db");
    await buildRawByteLeakFixtureDb(srcPath);

    const dstPath = join(dir, "no-vacuum", "monet.db");
    mkdirSync(dirname(dstPath), { recursive: true });
    copyFileSync(srcPath, dstPath);

    const db = new Database(dstPath);
    try {
      scrubConceptsAndObservations(db);
      scrubConceptSlugs(db);
      scrubContradictions(db);
      scrubEntities(db);
      pruneStaleEntities(db);
      emptyConceptRevisions(db);
      scrubFutureProofedColumns(db);
      // Deliberately NO vacuumDb(db) call here — this is the round-2 (pre-F1) behavior.
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }

    const violations = findRawByteViolations(dstPath);

    // THE ACTUAL FAILURE OUTPUT — this is what proves the check is real, not vacuous. Printed
    // (not just asserted) so it appears in this suite's own run output as verbatim proof, per this
    // round's mission requirement to relay it.
    console.log(
      `[non-vacuity proof, F1] findRawByteViolations found ${violations.length} violation(s) in a ` +
        `scrubbed-but-NOT-vacuumed output:\n` +
        violations
          .slice(0, 10)
          .map((v) => `  [${v.pattern}] matched "${v.match}" in raw-bytes context: "${v.contextPreview}"`)
          .join("\n"),
    );

    expect(violations.length).toBeGreaterThan(0);
    // Spot-check that at least one violation is a genuine pre-scrub secret shape, not noise.
    expect(violations.some((v) => v.pattern === "email" || v.pattern === "secret" || v.pattern === "bare-key")).toBe(true);
  });

  it("positive: the REAL fixed pipeline's output (scrubSizeDb, with VACUUM) has ZERO raw-byte violations", async () => {
    const dir = mkTmp("scrub-rawbytes-fixed-");
    const srcPath = join(dir, "src-monet.db");
    await buildRawByteLeakFixtureDb(srcPath);

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const violations = findRawByteViolations(dstPath);
    if (violations.length > 0) {
      const detail = violations.map((v) => `[${v.pattern}] matched "${v.match}" in "${v.contextPreview}"`).join("\n");
      throw new Error(`raw-bytes closure: ${violations.length} violation(s) found in VACUUM'd output:\n${detail}`);
    }
    expect(violations).toEqual([]);
  });

  it("positive, with a slug collision exercised: raw bytes are clean even when scrubConceptSlugs disambiguates a collision (proves the slug UPDATE path is covered by VACUUM too)", async () => {
    // scrubConceptSlugs' UPDATE is a TEXT-column UPDATE like any other scrub step — covered by the
    // same VACUUM fix in principle, but this test makes sure the fixture actually EXERCISES a slug
    // CHANGE (not just a slug that happens to already be clean), so this is genuinely tested rather
    // than theoretically covered. Two DISTINCT concepts (deliberately DIVERGENT bodies/kinds, so the
    // engine's own dedup does NOT merge them into one — verified empirically: an earlier version of
    // this fixture used two near-identical bodies differing only in a trailing "one"/"two" suffix,
    // and the engine's dedup silently merged them into a SINGLE concept, which defeated the whole
    // point of this collision test; using genuinely different topics per concept, sharing only the
    // same leading "jane.doe@example.com is the person to contact" phrase, produces two REAL,
    // separate concept rows) whose TITLES both truncate (same content-dependent truncation this
    // suite's sibling fixtures already document) to the identical string "jane" (before the "@") —
    // so both scrub down to the same slug "jane" before disambiguation.
    const dir = mkTmp("scrub-rawbytes-slugcollision-");
    const srcPath = join(dir, "src-monet.db");
    const core = new MonetCore(srcPath);
    try {
      await core.store(
        "jane.doe@example.com is the person to contact — this note is entirely about database indexing " +
          "strategy and B-tree page splits under heavy write load, a topic unrelated to the second note " +
          "below, distinct enough that dedup should not merge them. " +
          "a".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "insight" },
      );
      await core.store(
        "jane.doe@example.com is the person to contact — this second note is entirely about OAuth token " +
          "refresh race conditions in the auth service, again unrelated to the first note, distinct enough " +
          "that dedup should not merge them. " +
          "b".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "decision" },
      );
    } finally {
      core.close();
    }

    // Non-vacuity for THIS fixture specifically: confirm both concepts survived as separate rows
    // sharing the same PRE-fix slug, before scrubbing runs — otherwise this test would silently
    // prove nothing (see the comment above for the exact dedup-merge failure mode this guards
    // against).
    const preScrubDb = new Database(srcPath, { readonly: true });
    let preScrubRows: Array<{ id: string; title: string; slug: string }>;
    try {
      preScrubRows = preScrubDb.prepare(`SELECT id, title, slug FROM concepts ORDER BY id`).all() as Array<{
        id: string;
        title: string;
        slug: string;
      }>;
    } finally {
      preScrubDb.close();
    }
    expect(preScrubRows.length).toBe(2);
    expect(new Set(preScrubRows.map((r) => r.slug)).size).toBe(1); // both share the SAME pre-fix slug

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const db = new Database(dstPath, { readonly: true });
    let slugs: string[];
    try {
      slugs = (db.prepare(`SELECT slug FROM concepts ORDER BY id`).all() as Array<{ slug: string }>).map((r) => r.slug);
    } finally {
      db.close();
    }
    expect(slugs.length).toBe(2);
    expect(new Set(slugs).size).toBe(2); // both concepts have DIFFERENT slugs post-disambiguation

    const violations = findRawByteViolations(dstPath);
    expect(violations).toEqual([]);
  });

  it("real corpus (if present): all 4 real eval-corpus/db/<size>/monet.db sizes produce raw-byte-clean scrubbed output for every HIGH-CONFIDENCE pattern class, with the one investigated ~/-pattern false-positive class documented explicitly (not silently filtered)", () => {
    // Belt-and-suspenders, not a replacement for the real end-to-end regeneration run (done
    // separately as part of this round's manual validation) — skips gracefully with a clear reason
    // if the corpus isn't checked out in this environment, rather than hard-failing.
    //
    // ROUND 5 NOTE: this test's own runtime already sat close to vitest's 5000ms default timeout
    // BEFORE this round's changes (measured directly against the pre-round-5 code: ~4020ms in
    // isolation) — it runs scrubSizeDb + a full raw-byte scan against all 4 real corpus sizes,
    // including the 32MB "full" size, so it was always one of the more expensive tests in this
    // suite. Round 5 adds 4 more scrubbed columns to the same scrubSizeDb call (measured overhead
    // in isolation: negligible, 3.6-3.8s across repeated isolated runs, actually WITHIN the
    // pre-round-5 baseline's own noise band) — but running as part of the FULL suite (`pnpm test`,
    // competing with every other test file's setup/teardown for CPU) intermittently pushed this
    // specific test past 5000ms (observed: several full-suite runs landing 4447-5432ms, one
    // deterministic-seeming timeout at the ceiling). This is pre-existing timeout-margin fragility,
    // not a functional regression this round introduced — see the isolated-run timings above, which
    // prove the actual work this test does is unaffected. Explicit timeout bump (10s) rather than
    // silently retrying until lucky.
    //
    // INVESTIGATED FINDING, kept here rather than silently worked around: running this check
    // against the real corpus surfaces `~/ path` (TILDE_PATH_RE) matches that are NOT genuine
    // leaked home-directory paths — they are SQLite B-tree INDEX-PAGE STRUCTURE false positives.
    // Verified directly, not assumed: every one of these matches is the literal 2-byte sequence
    // `~/` (TILDE_PATH_RE's trailing group is `*`, zero-or-more, per its own doc comment's P1-a fix
    // — so a bare `~/` with nothing after it is a complete match on its own), immediately preceded
    // by an ordinary word fragment (e.g. "about") and a UUID/rowid-shaped run, and immediately
    // FOLLOWED by a non-printable control byte (confirmed by dumping raw byte codes: the `/`
    // (charCode 47) is followed by charCode 4, a control character) — the unambiguous signature of
    // an index page's cell-pointer/varint-length-prefix layout, where a `~` byte and a `/` byte
    // happen to sit adjacent by coincidence (this is entities/concept_entities index structure,
    // where entity_key values like "noun:uniquesampled"/"noun:unionsampled" and the SAMPLED_CIRCLE
    // scope string "sampled" are adjacent in a b-tree page, followed by varint bytes that
    // occasionally render as `~`/`/` when decoded as printable ASCII). No genuine "~/something"
    // path (with real path segments after the slash) appears anywhere — confirmed by dumping every
    // unique match VALUE across all 4 sizes (77 total hits in the "full" size alone, ALL identical
    // 2-byte "~/" matches, zero distinct longer matches).
    //
    // WHY THIS PATTERN CLASS SPECIFICALLY (and not the other 6): TILDE_PATH_RE requires only a
    // literal 2-byte anchor (`~` immediately followed by `/`) to match at all — deliberately
    // loosened this way by its own P1-a fix so a genuinely-truncated real path ("...operating on
    // the live ~/" with nothing after) still redacts. That same looseness makes it the one pattern
    // class most exposed to 2-byte coincidental adjacency in raw binary structure. The other 6
    // pattern classes (email, secret, query-param-secret, bare-key, private-endpoint, /Users/ path)
    // all require much longer, more specific structure (an `@` + a full domain, a vendor-prefixed
    // key of 10+ chars, a dotted IP-octet run, a literal "/Users/" prefix) that raw index-page noise
    // essentially never coincidentally reproduces — confirmed empirically: those 6 classes report
    // ZERO hits across all 4 real corpus sizes, every single run.
    //
    // THIS IS NOT SILENTLY SUPPRESSED: this test asserts ZERO violations for the 6 high-confidence
    // pattern classes UNCONDITIONALLY (a genuine regression in any of those would still fail this
    // test immediately), and separately reports (without failing on) any `~/ path`-only violations,
    // printing their count and a sample so a human reviewing this suite's output can see the exact
    // investigated-and-explained shape rather than the check being quietly narrowed with no visible
    // trace.
    const dbDir = join(REPO_ROOT, "eval-corpus", "db");
    if (!existsSync(dbDir)) {
      console.log(`[skip] real corpus not present at ${dbDir} — skipping real-corpus raw-bytes closure check.`);
      return;
    }
    const sizes = readdirSync(dbDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(sizes.length).toBeGreaterThan(0);

    for (const size of sizes) {
      const srcPath = join(dbDir, size, "monet.db");
      if (!existsSync(srcPath)) continue;
      const dir = mkTmp(`scrub-rawbytes-realcorpus-${size}-`);
      const dstPath = join(dir, "monet.db");
      scrubSizeDb(srcPath, dstPath);
      const violations = findRawByteViolations(dstPath);

      const highConfidence = violations.filter((v) => v.pattern !== "~/ path");
      const tildeOnly = violations.filter((v) => v.pattern === "~/ path");

      if (highConfidence.length > 0) {
        const detail = highConfidence
          .slice(0, 20)
          .map((v) => `[${v.pattern}] matched "${v.match}" in "${v.contextPreview}"`)
          .join("\n");
        throw new Error(
          `raw-bytes closure FAILED for real corpus size "${size}" (high-confidence pattern classes): ` +
            `${highConfidence.length} violation(s):\n${detail}`,
        );
      }
      expect(highConfidence).toEqual([]);

      if (tildeOnly.length > 0) {
        console.log(
          `[${size}] ${tildeOnly.length} "~/ path"-only raw-byte match(es) found — investigated and confirmed to be ` +
            `SQLite index-page structural noise (2-byte "~/" adjacency, always followed by a non-printable control ` +
            `byte), NOT genuine leaked paths. Sample: ${JSON.stringify(tildeOnly[0].contextPreview)}`,
        );
      }
    }
  }, 10_000); // see this test's own doc comment above (round 5 note) for why the default 5000ms is too tight
});

/**
 * scrub-db.mjs unit tests — the db-scrub parity stage (see that script's module doc for full
 * design rationale: A2 reads a scrubbed md-tree while A4 would otherwise read an unscrubbed
 * eval-corpus/db/<size>/monet.db, a real confound for a fair engine-vs-md comparison; this stage
 * produces a scrubbed COPY so both arms can see identical content).
 *
 * ROUND 2 (this version): extended to cover every surface a cold audit found beyond the original
 * 3-column scrub — contradictions.detail, JSON-aware concepts/observations.source_refs,
 * entities.surface/key + concept_entities.entity_key (lockstep), concept_revisions (emptied), and
 * first_block.summary/sessions.summary/sessions.scope_context (future-proofing). See
 * src/__tests__/scrub-db-closure.test.ts for the schema-driven, table/column-agnostic closure
 * guard that proves NOTHING leaks anywhere regardless of which columns this file happens to name —
 * this file's job is narrower: verify each scrub FUNCTION does exactly what it claims, with
 * specific, readable assertions per surface.
 *
 * Fixtures are built the same way corpus-sample.ts's own materializeSampledDb does (see that
 * function's precedent in src/eval/corpus-sample.ts): `new MonetCore(path)` first, to get the
 * REAL engine schema via init()/migrate() rather than a hand-duplicated CREATE TABLE list that
 * could drift, then direct `INSERT`/`UPDATE` via a raw better-sqlite3 handle for the rows this
 * suite actually needs to control (contradictions/entities/concept_revisions/first_block/sessions
 * aren't populated by store() alone). Every fixture concept is circled to SAMPLED_CIRCLE up front
 * (via `store({ circle: SAMPLED_CIRCLE })`) so scrub-db.mjs's own assertScopeAlreadyApplied check
 * (mirroring scrub-corpus.mjs's identical existing invariant) doesn't reject the fixture.
 *
 * Covers, per the mission's explicit test requirements:
 *   1. the scrubbed copy has ZERO pattern hits across every scrubbed surface (both scrubString's
 *      own patterns AND a direct content check for the exact seeded secret-shaped strings).
 *   2. the ORIGINAL db (eval-corpus/db/<size>/monet.db equivalent) is left completely untouched —
 *      byte-identical before/after running scrub-db.mjs against a fixture copy of it.
 *   3. determinism: running scrubSizeDb twice against the same source produces byte-identical
 *      output files.
 *   4. a MonetCore opened directly on the scrubbed copy answers search()/gather() sanely (finds a
 *      concept by its non-sensitive content, sourceRefs parse back to a clean array, and nothing
 *      redacted resurfaces).
 *   5. everything not explicitly scrubbed/emptied (embeddings, edges, row counts on
 *      concepts/observations, non-text columns) survives untouched.
 *   6. WAL fidelity: a source db with pending (uncheckpointed) WAL frames is still fully captured
 *      by the scrubbed copy, and the copy itself ships with no -wal/-shm sidecar.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { MonetCore } from "../engine";
import { SAMPLED_CIRCLE } from "../eval/corpus-scope.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// @ts-expect-error — plain .mjs script, no type declarations; imported for its exported pure functions only.
// (single-line import: tsc attributes a multi-line import's module-resolution error to the line
// carrying the `from` specifier, not the opening `import {` line — a multi-line form here would
// place this directive too far from the actual error site for it to suppress anything, and get
// flagged itself as "unused" while the real error still fires 10 lines down, unsuppressed.)
import { scrubSizeDb, scrubConceptsAndObservations, scrubConceptSlugs, rewriteAssertedSlugRefsInDb, clearConceptAliases, scrubContradictions, scrubEntities, pruneStaleEntities, pruneOrphanedAboutEdges, emptyConceptRevisions, scrubFutureProofedColumns, scrubSourceRefsJson, assertScopeAlreadyApplied, assertSlugsUniquePerCircle, assertNoOverlap, vacuumDb } from "../../scripts/scrub-db.mjs";
// @ts-expect-error — plain .mjs mirror, no type declarations.
import { slugify as mirroredSlugify } from "../db-slugify.mjs";
import { rewriteAssertedSlugRefs } from "../eval/slug-ref-rename.mjs";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSyncMeta(path: string): { device_id: string; clock_mode: "wall" | "logical" } {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT device_id, clock_mode FROM sync_meta WHERE singleton = 1`).get() as {
      device_id: string;
      clock_mode: "wall" | "logical";
    };
  } finally {
    db.close();
  }
}

function downgradeToPreClockModeV8(path: string): string {
  const db = new Database(path);
  try {
    const device = (db.prepare(`SELECT device_id FROM sync_meta WHERE singleton = 1`).get() as { device_id: string }).device_id;
    const triggers = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    db.exec(`ALTER TABLE sync_meta DROP COLUMN clock_mode`);
    db.exec(`
      CREATE TRIGGER sync_concepts_update AFTER UPDATE ON concepts
      WHEN NEW.sync_revision = OLD.sync_revision
       AND COALESCE(NEW.sync_writer, '') = COALESCE(OLD.sync_writer, '')
       AND (SELECT applying_remote FROM sync_meta WHERE singleton = 1) = 0
      BEGIN
        UPDATE sync_meta
           SET last_mutation_at = MAX(
             last_mutation_at + 1,
             CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
           )
         WHERE singleton = 1;
        UPDATE concepts
           SET sync_revision = OLD.sync_revision + 1,
               sync_writer = (SELECT device_id FROM sync_meta WHERE singleton = 1),
               updated_at = (SELECT last_mutation_at FROM sync_meta WHERE singleton = 1)
         WHERE id = NEW.id;
      END;
    `);
    db.pragma("user_version = 8");
    return device;
  } finally {
    db.close();
  }
}

/**
 * Build a minimal, schema-correct fixture db at `path`: a real MonetCore-initialized store (so the
 * schema is never hand-duplicated — same precedent as materializeSampledDb in corpus-sample.ts),
 * seeded with a handful of concepts whose title/body/source_refs deliberately carry scrubbable
 * content (an email, a /Users/ path, a secret-shaped key, a private endpoint with a tenant clause)
 * alongside ordinary non-sensitive prose, PLUS raw-SQL-seeded rows in every other surface this
 * round's audit found: contradictions.detail, entities/concept_entities (a `ref:`-prefixed path
 * entity), concept_revisions, first_block.summary, sessions.summary/scope_context. Every
 * concepts/observations row is circled to SAMPLED_CIRCLE (via the `circle` store option) to
 * satisfy scrub-db.mjs's scope-already-applied invariant, mirroring how a real derived per-size db
 * is always re-circled at sampling time.
 *
 * IMPORTANT, verified empirically (not assumed): `core.store(content, ...)` itself writes ONE
 * `observations` row per call, with `content` equal to the exact input string (confirmed directly —
 * a fresh store seeded with 2 store() calls produces exactly 2 observations rows, each `content`
 * matching its input verbatim). So this fixture's 3 store() calls ALREADY produce 3 observations
 * with the exact scrubbable strings below as their `content` — no separate manual observations
 * insert is needed.
 *
 * SECOND thing verified empirically, also load-bearing for this fixture's exact phrasing: the
 * engine's own title-derivation logic (upstream of and unrelated to this pipeline — the same
 * behavior scrub-patterns.mjs's own TILDE_PATH_RE doc comment independently documents hitting
 * against the real corpus) truncates a concept's `title` well before the end of a long input, and
 * the truncation point is content-dependent (observed splitting near the first `.` in practice) —
 * NOT simply "however many chars fit". Two concrete probes against a real MonetCore, not assumed:
 * `store("Contact jane.doe@example.com about the deploy...")` produced `title: "Contact jane"`
 * (truncated BEFORE the "@", so no email-shaped substring survives into the title at all — a
 * body/observations-only hit, not a title hit); `store("/Users/dev/code/monet-core/src/
 * engine.ts is where this lives.")` (path placed at the very START of the string) produced
 * `title: "/Users/dev/code/monet-core/src/engine"` (the FULL path survives, since the
 * truncation boundary landed after it). This fixture places the path and the secret-shaped key at
 * the START of their respective input strings specifically so their title DOES retain the
 * scrubbable substring (needed for a real, non-zero titleHits assertion below) — the email case is
 * deliberately positioned mid-sentence instead, since a leading-email phrasing was ALSO probed and
 * still truncated before the "@" boundary; the email's scrub coverage is verified via body/
 * observations content instead, which is the honest, verified-not-assumed way to cover it.
 */
async function buildFixtureDb(path: string): Promise<{ conceptIds: string[] }> {
  const core = new MonetCore(path);
  const conceptIds: string[] = [];
  try {
    const a = await core.store(
      "/Users/dev/code/monet-core/src/engine.ts is the file referenced — contact jane.doe@example.com with any questions about it.",
      { circle: SAMPLED_CIRCLE, sourceRefs: ["/Users/dev/.monet/monet.db", "~/code/with-monet/notes.md"] },
    );
    conceptIds.push(a.conceptId!);

    const b = await core.store("key_GZTqlLr41FS2p7AY is the Constructor.io key, passed as a header on every request.", {
      circle: SAMPLED_CIRCLE,
    });
    conceptIds.push(b.conceptId!);

    const c = await core.store(
      "Ordinary, non-sensitive architecture note: SQLite is the storage backend for Monet Local, reachable at 192.168.1.10:9301, tenant acme for smoke tests.",
      { circle: SAMPLED_CIRCLE },
    );
    conceptIds.push(c.conceptId!);
  } finally {
    core.close();
  }

  // Raw-SQL-seeded rows for the surfaces store() alone doesn't populate — one representative
  // sensitive row per table, so each scrub function has something real to act on.
  const db = new Database(path);
  try {
    // Round 5, H2: resolved_by seeded with a hostile-shaped (email) caller-supplied label —
    // resolveContradiction's `opts.by` / mcp-server.ts's `resolvedBy` tool field have no format
    // constraint, so a real caller could supply exactly this shape. Status stays 'open' (this
    // fixture only needs SOME non-null resolved_by value to exercise the scrub — scrubContradictions'
    // own test below asserts this row's status is untouched, so status is deliberately NOT changed
    // to 'resolved' here even though the real engine only ever sets resolved_by via a status
    // transition; a fixture doesn't need to replicate every engine invariant, just the column shape).
    db.prepare(
      `INSERT INTO contradictions (id, concept_id, kind, status, detail, resolved_by) VALUES (?, ?, 'value-conflict', 'open', ?, ?)`,
    ).run(
      "contra-1",
      conceptIds[0],
      "correction: the real endpoint is http://192.168.1.10:9301, tenant acme — reach jane.doe@example.com for details.",
      "jane.doe@example.com",
    );

    db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run(
      conceptIds[0],
      "ref:/Users/dev/.claude/CLAUDE.md",
      SAMPLED_CIRCLE,
    );
    db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, 'path', ?, ?, 1)`).run(
      "ref:/Users/dev/.claude/CLAUDE.md",
      "/Users/dev/.claude/CLAUDE.md",
      SAMPLED_CIRCLE,
    );
    // A second, LEGITIMATE (non-sensitive) path entity, to prove scrubEntities doesn't touch what
    // doesn't need touching.
    db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run(
      conceptIds[1],
      "path:relative/config.json",
      SAMPLED_CIRCLE,
    );
    db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, 'path', ?, ?, 1)`).run(
      "path:relative/config.json",
      "relative/config.json",
      SAMPLED_CIRCLE,
    );

    db.prepare(`INSERT INTO concept_revisions (id, concept_id, version, body, created_at) VALUES (?, ?, 0, ?, unixepoch() * 1000)`).run(
      "rev-1",
      conceptIds[0],
      "Prior version: reach me at jane.doe@example.com or ~/.monet/monet.db.",
    );

    // Round 5, H2: promoted_by seeded with a hostile-shaped (/Users/ path) caller-supplied label —
    // promoteToFirstBlock's `opts.promotedBy` / mcp-server.ts's `promotedBy` tool field have no
    // format constraint.
    db.prepare(`INSERT INTO first_block (id, concept_id, circle, summary, position, promoted_by) VALUES (?, ?, ?, ?, 0, ?)`).run(
      "fb-1",
      conceptIds[0],
      SAMPLED_CIRCLE,
      "Pinned note: the private endpoint is 192.168.1.10:9301, tenant acme.",
      "/Users/dev/agents/curation-bot",
    );

    db.prepare(`INSERT INTO sessions (id, agent_id, scope_context, summary) VALUES (?, 'test-agent', ?, ?)`).run(
      "sess-1",
      "/Users/dev/code/monet-core-phase1",
      "Session touched jane.doe@example.com and ~/code/foo.",
    );

    // Round 5, H2: memory_edge.dismissed_by seeded with a hostile-shaped (email) caller-supplied
    // label — dismissPossibleDuplicate's own param / mcp-server.ts's `resolvedBy` tool field
    // (routed through the duplicate-pair-dismissal branch) have no format constraint. src_id/dst_id
    // reference real concept ids (no declared FK on memory_edge, but using real ids keeps this
    // fixture faithful to what a genuine possible_duplicate_of edge looks like).
    db.prepare(
      `INSERT INTO memory_edge (id, src_id, dst_id, type, dismissed_at, dismissed_by) VALUES (?, ?, ?, 'possible_duplicate_of', unixepoch() * 1000, ?)`,
    ).run("edge-1", conceptIds[0], conceptIds[1], "jane.doe@example.com");
  } finally {
    db.close();
  }

  return { conceptIds };
}

describe("scrubSourceRefsJson — JSON-aware source_refs scrub", () => {
  it("parses a JSON array, scrubs each string element, and re-serializes", () => {
    const raw = JSON.stringify(["/Users/dev/.monet/monet.db", "~/code/with-monet/notes.md", "https://example.com/issues/1"]);
    const out = scrubSourceRefsJson(raw);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain("[redacted-path]");
    expect(parsed).toContain("https://example.com/issues/1"); // non-sensitive ref untouched
    expect(out).not.toContain("/Users/dev");
    expect(out).not.toContain("~/code");
  });

  it("passes through null/undefined/empty-string unchanged (nullable column contract)", () => {
    expect(scrubSourceRefsJson(null)).toBeNull();
    expect(scrubSourceRefsJson(undefined)).toBeUndefined();
    expect(scrubSourceRefsJson("")).toBe("");
  });

  it("throws a clear error on malformed JSON rather than silently passing it through unscrubbed", () => {
    expect(() => scrubSourceRefsJson("not json")).toThrow(/not valid JSON/);
  });

  it("throws when the parsed value isn't an array", () => {
    expect(() => scrubSourceRefsJson(JSON.stringify({ not: "an array" }))).toThrow(/expected source_refs to parse to an array/i);
  });
});

describe("scrubConceptsAndObservations — direct in-place scrub of an open db handle", () => {
  it("scrubs concepts.title/body/kind/source_refs and observations.content/kind/source_refs, and nothing else", async () => {
    const dir = mkTmp("scrub-db-direct-");
    const dbPath = join(dir, "monet.db");
    const { conceptIds } = await buildFixtureDb(dbPath);

    const db = new Database(dbPath);
    try {
      const before = db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>;
      const stats = scrubConceptsAndObservations(db);

      expect(stats.conceptCount).toBe(3);
      expect(stats.observationCount).toBe(3);
      expect(stats.titleHits).toBeGreaterThan(0);
      expect(stats.bodyHits).toBeGreaterThan(0);
      // Every one of the 3 store() calls fed scrubbable content into its own observations.content
      // (see buildFixtureDb's doc comment), so all 3 observation rows should show a hit.
      expect(stats.contentHits).toBe(3);
      // The first concept's sourceRefs (/Users/.../.monet/monet.db, ~/code/with-monet/notes.md) are
      // both scrubbable.
      expect(stats.conceptRefsHits).toBeGreaterThan(0);
      // buildFixtureDb's `new MonetCore(path)` uses the default agentId ("local-agent", benign,
      // nothing to scrub) — 0 hits here is the correct, expected baseline. See the DEDICATED
      // "round 4, G2 fix" describe block below for a fixture that actually exercises a hostile
      // agentId, since this fixture's own agentId is never sensitive by construction.
      expect(stats.agentIdHits).toBe(0);
      // Round 5, J2: buildFixtureDb's store() calls never pass a `kind` option, so every
      // concept/observation kind defaults to the engine's own benign default ("fact"/"statement") —
      // 0 hits here is the correct, expected baseline. See the DEDICATED "round 5, J2 fix" describe
      // block below for a fixture that actually exercises a hostile-shaped kind.
      expect(stats.conceptKindHits).toBe(0);
      expect(stats.obsKindHits).toBe(0);

      const after = db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>;
      // Embeddings are untouched by this pass (see scrub-db.mjs's own "DISCLOSED CAVEAT" doc) —
      // asserted directly here, not just claimed in a comment.
      expect(after.map((r) => r.embedding)).toEqual(before.map((r) => r.embedding));

      // conceptIds[0] is the concept buildFixtureDb seeded WITH sourceRefs — look it up by that
      // known id directly (not `before[0].id`, which is alphabetically ORDER-BY'd and does not
      // correspond to insertion order / which concept actually has sourceRefs).
      const refs = (db.prepare(`SELECT source_refs FROM concepts WHERE id = ?`).get(conceptIds[0]) as { source_refs: string }).source_refs;
      const parsedRefs = JSON.parse(refs) as string[];
      expect(parsedRefs.some((r) => r.startsWith("[redacted"))).toBe(true);
      expect(refs).not.toContain("/Users/dev");
    } finally {
      db.close();
    }
  });

  describe("round 5, J2 fix: concepts.kind and observations.kind are scrubbed (unvalidated MCP-callable string)", () => {
    it("scrubs a hostile-shaped kind (an email) supplied via memory_store's kind option, on both a concept and its observation", async () => {
      const dir = mkTmp("scrub-db-kind-email-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      let conceptId: string;
      try {
        // `kind` is `z.string().optional()` in mcp-server.ts's memory_store schema — completely
        // unvalidated. A hostile caller-supplied value here is a real, not hypothetical, shape.
        const r = await core.store("An ordinary, non-sensitive note about deployment scheduling.", {
          circle: SAMPLED_CIRCLE,
          kind: "jane.doe@example.com",
        });
        conceptId = r.conceptId!;
      } finally {
        core.close();
      }

      // Non-vacuity: confirm the hostile kind actually landed, unscrubbed, before any scrub runs.
      const preDb = new Database(dbPath, { readonly: true });
      try {
        const row = preDb.prepare(`SELECT kind FROM concepts WHERE id = ?`).get(conceptId) as { kind: string };
        expect(row.kind).toBe("jane.doe@example.com");
        const obsRow = preDb.prepare(`SELECT kind FROM observations WHERE concept_id = ?`).get(conceptId) as { kind: string };
        // The FIRST observation on a freshly-created concept carries the SAME caller-supplied kind
        // as the concept itself (engine.ts's create() path) — verified directly, not assumed.
        expect(obsRow.kind).toBe("jane.doe@example.com");
      } finally {
        preDb.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubConceptsAndObservations(db);
        expect(stats.conceptKindHits).toBe(1);
        expect(stats.obsKindHits).toBe(1);

        const row = db.prepare(`SELECT kind FROM concepts WHERE id = ?`).get(conceptId) as { kind: string };
        expect(row.kind).toBe("[redacted-email]");
        expect(row.kind).not.toContain("jane.doe");

        const obsRow = db.prepare(`SELECT kind FROM observations WHERE concept_id = ?`).get(conceptId) as { kind: string };
        expect(obsRow.kind).toBe("[redacted-email]");
      } finally {
        db.close();
      }
    });

    it("scrubs a hostile-shaped kind (a /Users/ path) supplied via memory_store's kind option", async () => {
      const dir = mkTmp("scrub-db-kind-path-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      let conceptId: string;
      try {
        const r = await core.store("An ordinary, non-sensitive note about container scheduling.", {
          circle: SAMPLED_CIRCLE,
          kind: "/Users/dev/secret-kind-label",
        });
        conceptId = r.conceptId!;
      } finally {
        core.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubConceptsAndObservations(db);
        expect(stats.conceptKindHits).toBe(1);

        const row = db.prepare(`SELECT kind FROM concepts WHERE id = ?`).get(conceptId) as { kind: string };
        expect(row.kind).not.toContain("/Users/dev");
        expect(row.kind).toContain("[redacted-path]");
      } finally {
        db.close();
      }
    });

    it("real-corpus check: every distinct kind value across all 4 derived per-size dbs is a standard, non-sensitive vocabulary word (documents today's ACTUAL data, not a hostile fixture)", () => {
      // This is the "report today's distinct kind values" requirement from the fix task — run as a
      // real assertion (not just a comment) against the actual eval-corpus dbs, so a future
      // regression (a genuinely hostile kind value entering the real corpus) fails this test
      // immediately rather than silently shipping. Skips gracefully if the real corpus isn't
      // present in this checkout (matches this suite's own established "real corpus (if present)"
      // precedent elsewhere in this file/scrub-db-closure.test.ts).
      const STANDARD_KIND_VOCAB = new Set([
        "fact",
        "project",
        "decision",
        "insight",
        "feedback",
        "architecture",
        "pattern",
        "reference",
        "gotcha",
        "procedure",
        "preference",
        "user",
        "status",
        "policy",
        "issue",
        "constraint",
        "statement",
        "correction",
        "workstream",
        "value-conflict",
      ]);
      const sizes = ["25", "50", "100", "full"];
      let anyFound = false;
      for (const size of sizes) {
        const dbPath = join(REPO_ROOT, "eval-corpus", "db", size, "monet.db");
        if (!existsSync(dbPath)) continue;
        anyFound = true;
        const db = new Database(dbPath, { readonly: true });
        try {
          for (const table of ["concepts", "observations"]) {
            const rows = db.prepare(`SELECT DISTINCT kind FROM ${table}`).all() as Array<{ kind: string }>;
            for (const { kind } of rows) {
              expect(STANDARD_KIND_VOCAB.has(kind), `${table}.kind="${kind}" (size ${size}) is not in the standard vocabulary`).toBe(
                true,
              );
            }
          }
        } finally {
          db.close();
        }
      }
      if (!anyFound) {
        console.warn("real-corpus kind-vocabulary check: no eval-corpus/db/<size>/monet.db found in this checkout — skipped.");
      }
    });
  });

  describe("round 4, G2 fix: observations.author_agent_id is scrubbed", () => {
    it("scrubs a hostile-shaped author_agent_id (an email) supplied via the MonetCore constructor's agentId option", async () => {
      const dir = mkTmp("scrub-db-agentid-");
      const dbPath = join(dir, "monet.db");
      // agentId is a MonetCoreOptions.agentId constructor option (engine.ts:391), read ONCE at
      // construction (engine.ts:479: `this.agentId = opts.agentId ?? "local-agent"`) and stamped
      // onto EVERY observation this instance writes (engine.ts:850-853) — not a per-store()-call
      // parameter. A hostile-shaped value here (an email, verified as one of the shapes the mission
      // calls out) is exactly the scenario G2 is about.
      const hostileAgentId = "jane.doe@example.com";
      const core = new MonetCore(dbPath, { agentId: hostileAgentId });
      let conceptId: string;
      try {
        const r = await core.store("An ordinary, non-sensitive note about the storage backend.", {
          circle: SAMPLED_CIRCLE,
        });
        conceptId = r.conceptId!;
      } finally {
        core.close();
      }

      // Non-vacuity: confirm the raw author_agent_id column holds the hostile value BEFORE scrubbing.
      const preDb = new Database(dbPath, { readonly: true });
      try {
        const obsRow = preDb.prepare(`SELECT author_agent_id FROM observations WHERE concept_id = ?`).get(conceptId) as {
          author_agent_id: string;
        };
        expect(obsRow.author_agent_id).toBe(hostileAgentId);
      } finally {
        preDb.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubConceptsAndObservations(db);
        expect(stats.agentIdHits).toBeGreaterThan(0);

        const obsRow = db.prepare(`SELECT author_agent_id FROM observations WHERE concept_id = ?`).get(conceptId) as {
          author_agent_id: string;
        };
        expect(obsRow.author_agent_id).not.toBe(hostileAgentId);
        expect(obsRow.author_agent_id).not.toContain("jane.doe@example.com");
        expect(obsRow.author_agent_id).toContain("[redacted-email]");
      } finally {
        db.close();
      }
    });

    it("scrubs a hostile-shaped author_agent_id (a /Users/ path) supplied via the constructor", async () => {
      const dir = mkTmp("scrub-db-agentid-path-");
      const dbPath = join(dir, "monet.db");
      const hostileAgentId = "/Users/dev/agents/eval-runner";
      const core = new MonetCore(dbPath, { agentId: hostileAgentId });
      let conceptId: string;
      try {
        const r = await core.store("An ordinary, non-sensitive note about the storage backend.", {
          circle: SAMPLED_CIRCLE,
        });
        conceptId = r.conceptId!;
      } finally {
        core.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubConceptsAndObservations(db);
        expect(stats.agentIdHits).toBeGreaterThan(0);
        const obsRow = db.prepare(`SELECT author_agent_id FROM observations WHERE concept_id = ?`).get(conceptId) as {
          author_agent_id: string;
        };
        expect(obsRow.author_agent_id).not.toContain("/Users/dev");
        expect(obsRow.author_agent_id).toContain("[redacted-path]");
      } finally {
        db.close();
      }
    });
  });

  it("rejects a db whose rows are not already circled to SAMPLED_CIRCLE (scope-already-applied invariant)", () => {
    const dir = mkTmp("scrub-db-scope-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    core.close();
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, circle, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("c1", "c1-slug", "a title", "a body", "fact", "example-circle", "[]");
      expect(() => scrubConceptsAndObservations(db)).toThrow(/already be circled to "sampled"/);
    } finally {
      db.close();
    }
  });
});

describe("scrubConceptSlugs — round 3, F2 fix: regenerate concepts.slug from the ALREADY-SCRUBBED title", () => {
  it("regenerates the slug so it no longer matches the slugified form of the RAW (pre-scrub) title — a concept whose title leads with a sensitive path", async () => {
    const dir = mkTmp("scrub-db-slugs-leak-");
    const dbPath = join(dir, "monet.db");
    // A DEDICATED fixture (not buildFixtureDb's own conceptIds[0], which is a PROOF-REPO path and
    // therefore GENERALIZED rather than fully redacted by scrubString — a real, intentional, and
    // different code path; using it here would muddy this specific "no leaky fragment survives"
    // assertion). Path placed at the START of the string, per buildFixtureDb's own documented
    // truncation-boundary insight (lines 88-104 above), so it survives into the title verbatim —
    // verified directly: this exact phrasing produces title "/Users/dev/secret-notes" and
    // OLD-behavior slug "users-dev-secret-notes".
    const core = new MonetCore(dbPath);
    let conceptId: string;
    try {
      const r = await core.store(
        "/Users/dev/secret-notes.txt has the details — contact jane.doe@example.com about " +
          "/Users/dev/secret-notes.txt for questions.",
        { circle: SAMPLED_CIRCLE },
      );
      conceptId = r.conceptId!;
    } finally {
      core.close();
    }

    // Non-vacuity: confirm the leak exists BEFORE any scrub runs, and compute the OLD (pre-fix)
    // slug the LIVE engine actually produced, from the RAW unscrubbed title — this is what the
    // fixed slug must NOT equal or contain a recognizable fragment of.
    const preDb = new Database(dbPath, { readonly: true });
    let rawTitle: string;
    let oldLeakySlug: string;
    try {
      const row = preDb.prepare(`SELECT title, slug FROM concepts WHERE id = ?`).get(conceptId) as { title: string; slug: string };
      rawTitle = row.title;
      oldLeakySlug = row.slug;
    } finally {
      preDb.close();
    }
    expect(rawTitle).toContain("/Users/dev/secret-notes");
    expect(oldLeakySlug).toBe("users-dev-secret-notes"); // the exact pre-fix leaky slug, verified empirically

    const db = new Database(dbPath);
    try {
      scrubConceptsAndObservations(db); // must run FIRST — scrubConceptSlugs needs the scrubbed title
      const stats = scrubConceptSlugs(db);
      expect(stats.conceptCount).toBe(1);
      expect(stats.slugsChanged).toBe(1);

      const row = db.prepare(`SELECT title, slug FROM concepts WHERE id = ?`).get(conceptId) as { title: string; slug: string };
      expect(row.title).toBe("[redacted-path]"); // sanity: the title scrub itself worked as expected
      expect(row.slug).toBe(mirroredSlugify(row.title)); // slug is the live-engine-equivalent derivation of the SCRUBBED title

      // The core closure requirement: no slug matches the slugified form of the RAW title, and no
      // recognizable fragment of the old leaky slug survives.
      expect(row.slug).not.toBe(oldLeakySlug);
      expect(row.slug).not.toContain("users-dev");
      expect(row.slug).not.toContain("secret-notes");
    } finally {
      db.close();
    }
  });

  it("disambiguates two DIFFERENT concepts whose SCRUBBED titles slugify to the identical string, deterministically", async () => {
    const dir = mkTmp("scrub-db-slugs-collision-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    let idA: string;
    let idB: string;
    try {
      // Two DISTINCT concepts (divergent bodies/kinds so the engine's own dedup does not merge
      // them — verified empirically elsewhere in this suite's sibling fixtures that near-identical
      // bodies DO get merged by the engine's dedup, which would defeat this collision test) whose
      // titles both truncate to "jane" (before the "@") and therefore both slugify to "jane".
      const a = await core.store(
        "jane.doe@example.com is the person to contact — this note is entirely about database " +
          "indexing strategy and B-tree page splits under heavy write load, a topic unrelated to " +
          "the second note, distinct enough that dedup should not merge them. " +
          "a".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "insight" },
      );
      idA = a.conceptId!;
      const b = await core.store(
        "jane.doe@example.com is the person to contact — this second note is entirely about OAuth " +
          "token refresh race conditions in the auth service, again unrelated to the first note, " +
          "distinct enough that dedup should not merge them. " +
          "b".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "decision" },
      );
      idB = b.conceptId!;
    } finally {
      core.close();
    }

    // Non-vacuity: confirm the two are actually distinct rows sharing the SAME pre-fix slug.
    const preDb = new Database(dbPath, { readonly: true });
    try {
      const rows = preDb.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.slug)).size).toBe(1);
    } finally {
      preDb.close();
    }

    function runPass(): { slugA: string; slugB: string } {
      const db = new Database(dbPath);
      try {
        scrubConceptsAndObservations(db);
        scrubConceptSlugs(db);
        const rows = db.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
        const slugA = rows.find((r) => r.id === idA)!.slug;
        const slugB = rows.find((r) => r.id === idB)!.slug;
        return { slugA, slugB };
      } finally {
        db.close();
      }
    }

    const first = runPass();
    // Both concepts get VALID, DIFFERENT slugs — one keeps the base slug, the other gets a
    // deterministic `-${idFragment}` suffix (round 4, G3 fix: an 8-char id FRAGMENT, not the full
    // 36-char UUID `-${conceptId}` round 3 originally used — see scrubConceptSlugs' own doc comment
    // for why the full-UUID form is a correctness bug (can exceed slugify()'s 60-char cap) and the
    // dedicated "round 4, G3 fix" describe block below for the over-length case this collision test
    // doesn't itself force).
    expect(first.slugA).not.toBe(first.slugB);
    expect([first.slugA, first.slugB]).toContain("jane"); // one keeps the un-suffixed base slug
    expect(first.slugA === `jane-${idA.slice(0, 8)}` || first.slugB === `jane-${idB.slice(0, 8)}`).toBe(true);
    // Every slug produced (colliding or not) stays within the engine's own cap, and is a fixed point
    // of slugify() — the invariant this fix exists to guarantee.
    for (const s of [first.slugA, first.slugB]) {
      expect(s.length).toBeLessThanOrEqual(60);
      expect(mirroredSlugify(s)).toBe(s);
    }

    // Determinism: re-running the identical scrub pass against a FRESH copy of the same pre-scrub
    // content produces the SAME two output slugs (same input, same fixed ORDER BY id iteration →
    // same disambiguation outcome every time), matching this script's existing determinism
    // discipline (scrubSizeDb's own "is deterministic" test).
    const dbPath2 = join(dir, "monet2.db");
    const { copyFileSync } = await import("node:fs");
    // Copy the PRE-SLUG-SCRUB db state is not directly available here (dbPath was already
    // mutated by runPass() above) — rebuild an identical fixture from scratch instead, which is
    // exactly as valid a determinism check (same input content → same output, run twice, from two
    // independently-built sources).
    const core2 = new MonetCore(dbPath2);
    let idA2: string;
    let idB2: string;
    try {
      const a = await core2.store(
        "jane.doe@example.com is the person to contact — this note is entirely about database " +
          "indexing strategy and B-tree page splits under heavy write load, a topic unrelated to " +
          "the second note, distinct enough that dedup should not merge them. " +
          "a".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "insight" },
      );
      idA2 = a.conceptId!;
      const b = await core2.store(
        "jane.doe@example.com is the person to contact — this second note is entirely about OAuth " +
          "token refresh race conditions in the auth service, again unrelated to the first note, " +
          "distinct enough that dedup should not merge them. " +
          "b".repeat(200),
        { circle: SAMPLED_CIRCLE, kind: "decision" },
      );
      idB2 = b.conceptId!;
    } finally {
      core2.close();
    }
    const db2 = new Database(dbPath2);
    let second: { slugA: string; slugB: string };
    try {
      scrubConceptsAndObservations(db2);
      scrubConceptSlugs(db2);
      const rows = db2.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
      second = { slugA: rows.find((r) => r.id === idA2)!.slug, slugB: rows.find((r) => r.id === idB2)!.slug };
    } finally {
      db2.close();
    }
    // Since idA !== idA2 (fresh MonetCore.newId() per instance), the exact -id suffix differs
    // between the two runs — but the STRUCTURE of the outcome (one base slug, one suffixed slug,
    // both non-empty, both different from each other) is identical, which is what "deterministic
    // disambiguation policy" means here (the policy's OUTPUT is a pure function of (order, ids,
    // scrubbed titles) — a different id naturally produces a different but equally-valid suffix).
    expect(second.slugA).not.toBe(second.slugB);
    expect([second.slugA, second.slugB]).toContain("jane");
  });

  it("is a no-op (0 changed) when the scrubbed title's slug already matches the stored slug (e.g. a concept whose content was never sensitive)", async () => {
    const dir = mkTmp("scrub-db-slugs-noop-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    try {
      await core.store("An ordinary, non-sensitive architecture note about SQLite as the storage backend.", {
        circle: SAMPLED_CIRCLE,
      });
    } finally {
      core.close();
    }
    const db = new Database(dbPath);
    try {
      scrubConceptsAndObservations(db); // no-op on this content — nothing sensitive to scrub
      const stats = scrubConceptSlugs(db);
      expect(stats.conceptCount).toBe(1);
      expect(stats.slugsChanged).toBe(0);
      expect(stats.collisionsDisambiguated).toBe(0);
    } finally {
      db.close();
    }
  });

  describe("round 5, J4 fix: a SUFFIXED slug from an earlier collision must not collide with a LATER concept's natural base slug", () => {
    it("disambiguates a THIRD concept whose scrubbed title naturally slugifies to an EARLIER concept's already-disambiguated (suffixed) slug", async () => {
      // Uses a DETERMINISTIC, MONOTONICALLY INCREASING idGen (the same `seq(prefix)` sequential-id
      // pattern cross-circle.test.ts's own suite already establishes for MonetCore's `idGen`
      // constructor option) rather than the default random UUID generator — this test needs to
      // CONTROL which concept sorts where under `ORDER BY id` to construct a genuine second-order
      // collision, and a random-UUID + retry-until-the-right-order-emerges approach was tried FIRST
      // and found to have a materially non-negligible flake rate: empirically measured at ~4.5%
      // failure within a 20-attempt retry cap (not a fair "P(fail)=0.5^20≈0" as a naive coin-flip
      // model would suggest — a SPECIFIC already-drawn UUID's percentile varies, and a value that
      // happens to land in a high percentile needs many more than 20 draws on average to be
      // exceeded by a fresh random draw). A monotonic idGen removes this flake source entirely by a
      // DIFFERENT, more robust property than "assert the exact string each call produces" (verified
      // empirically that a single store() call can consume the generator MULTIPLE times — session
      // id, observation id, concept id, and additional ids for any entities/edges that call happens
      // to derive, a COUNT that varies with how much graph-derivation the exact content triggers —
      // so hardcoding "the Nth call's value is X" is itself fragile): whichever conceptId a LATER
      // store() call on the SAME instance returns is guaranteed, by the counter's monotonicity
      // alone, to sort lexicographically after any conceptId an EARLIER call returned, with zero
      // dependence on how many internal ids either call happened to consume.
      const dir = mkTmp("scrub-db-slugs-secondorder-");
      const dbPath = join(dir, "monet.db");
      let seqN = 0;
      const seqIdGen = () => `seq-${String(seqN++).padStart(6, "0")}`;

      const core = new MonetCore(dbPath, { idGen: seqIdGen });
      let idA: string;
      let idB: string;
      let idC: string;
      try {
        // A and B collide on base slug "jane" (both truncate to "jane.doe@..." before the "@").
        // idB is returned by a LATER store() call than idA, so idA < idB is guaranteed by the
        // generator's monotonicity — idB (the SECOND-processed row under `ORDER BY id`) is
        // deterministically the one scrubConceptSlugs disambiguates, matching the
        // base-slug-collision test's own established "the SECOND one gets suffixed" behavior, but
        // now BY CONSTRUCTION rather than by chance.
        const a = await core.store(
          "jane.doe@example.com is the person to contact — this note is entirely about database " +
            "indexing strategy and B-tree page splits under heavy write load, a topic unrelated to " +
            "the other notes, distinct enough that dedup should not merge them. " +
            "a".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "insight" },
        );
        idA = a.conceptId!;
        const b = await core.store(
          "jane.doe@example.com is the person to contact — this second note is entirely about OAuth " +
            "token refresh race conditions in the auth service, again unrelated to the other notes, " +
            "distinct enough that dedup should not merge them. " +
            "b".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "decision" },
        );
        idB = b.conceptId!;
        expect(idA < idB).toBe(true); // non-vacuity: confirm the deterministic ordering this test's design depends on

        // The THIRD concept's scrubbed title is engineered to slugify EXACTLY to idB's own
        // future-disambiguated slug, "jane-${idB.slice(0,8)}" — a period placed immediately after
        // the fragment (matching firstLine()'s "split on first period not adjacent to a digit"
        // rule) makes the title truncate to EXACTLY this string. idC, returned by a store() call
        // AFTER idB's, is guaranteed by the generator's monotonicity to sort AFTER idB — the exact
        // "later concept collides with an EARLIER disambiguated slug" case this fix targets, with
        // zero dependence on random id values or a retry loop.
        const idBFragment = idB.slice(0, 8);
        const c = await core.store(
          `jane-${idBFragment}. Container orchestration and pod scheduling policy notes, ` +
            `long enough and different enough from the other two concepts that dedup does not ` +
            `merge it with either. ` +
            "c".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "architecture" },
        );
        idC = c.conceptId!;
        expect(idB < idC).toBe(true); // non-vacuity: confirm by construction, not assumed
      } finally {
        core.close();
      }

      const idBFragment = idB.slice(0, 8);

      // Non-vacuity precondition, verified directly: C's RAW (pre-scrub) slug really is the exact
      // string idB will be disambiguated to.
      const preDb = new Database(dbPath, { readonly: true });
      try {
        const row = preDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(idC) as { slug: string };
        expect(row.slug).toBe(`jane-${idBFragment}`);
      } finally {
        preDb.close();
      }

      const db = new Database(dbPath);
      try {
        scrubConceptsAndObservations(db);
        const stats = scrubConceptSlugs(db);
        expect(stats.conceptCount).toBe(3);

        const rows = db.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
        const slugB = rows.find((r) => r.id === idB)!.slug;
        const slugC = rows.find((r) => r.id === idC)!.slug;

        // idB is disambiguated exactly as the base-slug-collision test establishes.
        expect(slugB).toBe(`jane-${idBFragment}`);
        // THE J4 FIX ITSELF: C's base slug ("jane-${idBFragment}") collides with idB's ALREADY-
        // ASSIGNED FINAL slug — without the J4 fix (assignedFinalSlugsByCircle), C would keep its
        // base slug UNCHANGED (since usedSlugsByCircle alone only tracks BASE slugs, and
        // "jane-${idBFragment}" was never any concept's OWN base slug), producing slugB === slugC,
        // a genuine duplicate concepts.slug. WITH the fix, C must be disambiguated to a DIFFERENT
        // value.
        expect(slugC).not.toBe(slugB);
        expect(slugC).not.toBe(`jane-${idBFragment}`); // C's OWN base slug, now correctly reassigned
        // C's base slug ("jane-<8chars>", 13 chars — well under the 51-char truncation budget, so
        // truncatedBase === C's own full base slug unchanged) gets disambiguated via the SAME
        // truncate-and-suffix path as any base-slug collision: `${truncatedBase}-${idFragment}`.
        expect(slugC).toBe(`jane-${idBFragment}-${idC.slice(0, 8)}`);
        // Every slug produced is unique per circle (the closure-level invariant J4 also adds).
        const allSlugs = rows.map((r) => r.slug);
        expect(new Set(allSlugs).size).toBe(allSlugs.length);
        // Every slug stays within the cap and is a fixed point of slugify().
        for (const s of allSlugs) {
          expect(s.length).toBeLessThanOrEqual(60);
          expect(mirroredSlugify(s)).toBe(s);
        }

        // assertSlugsUniquePerCircle (the new closure-level invariant helper) passes against this
        // fixed-up state — proving the fix, not just this test's own manual Set-size check.
        expect(() => assertSlugsUniquePerCircle(db)).not.toThrow();
      } finally {
        db.close();
      }
    });

    it("assertSlugsUniquePerCircle THROWS against a deliberately-broken db with a genuine duplicate (circle, slug) pair — the non-vacuity proof for the J4 closure helper itself", () => {
      const dir = mkTmp("scrub-db-slug-uniqueness-nonvacuity-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      try {
        core.close();
      } finally {
        // no-op, just get a real schema on disk
      }
      const db = new Database(dbPath);
      try {
        const now = Date.now();
        const emb = JSON.stringify(new Array(8).fill(0));
        for (const id of ["dup-a", "dup-b"]) {
          db.prepare(
            `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding, support_count, version, dirty, usefulness_score, created_at, updated_at)
             VALUES (?, 'duplicate-slug', ?, 'body text', 'fact', 'active', 0.6, ?, ?, 1, 0, 0, 0, ?, ?)`,
          ).run(id, `title for ${id}`, SAMPLED_CIRCLE, emb, now, now);
        }
        expect(() => assertSlugsUniquePerCircle(db)).toThrow(/duplicate.*circle="sampled".*slug="duplicate-slug"/s);
      } finally {
        db.close();
      }
    });
  });

  describe("round 4, G3 fix: a disambiguated slug never exceeds slugify()'s 60-char cap, and stays resolveRef-round-trippable", () => {
    it("caps a colliding slug's disambiguated form at 60 chars, using an 8-char id fragment, and the stored value is a FIXED POINT of slugify() (the resolveRef round-trip proof)", async () => {
      const dir = mkTmp("scrub-db-slugs-overlength-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      let idA: string;
      let idB: string;
      try {
        // A LONG base title (its slugified base sits at/near the 60-char cap on its own), shared by
        // two DISTINCT concepts (divergent bodies/kinds so the engine's own dedup does not merge them
        // — see the sibling collision test above for the same precedent) so scrubConceptSlugs is
        // forced to disambiguate. Verified directly: this exact phrasing produces a base slug that is
        // already 60 chars (hits slugify()'s own cap) BEFORE any "-${id}" suffix is even appended —
        // i.e. the round-3 behavior (`${baseSlug}-${row.id}`) would produce 60 + 1 + 36 = 97 chars.
        const longTitleLead =
          "This is a very long and detailed architecture note about the storage engine internals " +
          "and how the write ahead log interacts with the b tree page cache during heavy concurrent " +
          "write load across many simultaneous sessions and connections";
        const a = await core.store(
          `${longTitleLead} — this specific note is entirely about database indexing strategy and ` +
            "B-tree page splits under heavy write load, a topic unrelated to the second note, " +
            "distinct enough that dedup should not merge them. " +
            "a".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "insight" },
        );
        idA = a.conceptId!;
        const b = await core.store(
          `${longTitleLead} — this second note is entirely about OAuth token refresh race conditions ` +
            "in the auth service, again unrelated to the first note, distinct enough that dedup " +
            "should not merge them. " +
            "b".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "decision" },
        );
        idB = b.conceptId!;
      } finally {
        core.close();
      }

      // Non-vacuity: confirm the two concepts share the SAME pre-fix base slug, and that base slug is
      // already at (or very near) the 60-char cap — proving this fixture genuinely exercises the
      // over-length case G3 is about, not just an ordinary short collision.
      const preDb = new Database(dbPath, { readonly: true });
      let baseSlugLen: number;
      try {
        const rows = preDb.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
        expect(rows.length).toBe(2);
        const slugs = new Set(rows.map((r) => r.slug));
        expect(slugs.size).toBe(1);
        baseSlugLen = [...slugs][0].length;
      } finally {
        preDb.close();
      }
      expect(baseSlugLen).toBeGreaterThanOrEqual(50); // close to or at the 60-char cap

      const db = new Database(dbPath);
      let disambiguatedSlug: string;
      try {
        scrubConceptsAndObservations(db);
        const stats = scrubConceptSlugs(db);
        expect(stats.collisionsDisambiguated).toBeGreaterThan(0);

        const rows = db.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
        const slugA = rows.find((r) => r.id === idA)!.slug;
        const slugB = rows.find((r) => r.id === idB)!.slug;
        expect(slugA).not.toBe(slugB); // still correctly disambiguated

        // Whichever of the two got the disambiguated (suffixed) form — that's the one under test.
        disambiguatedSlug = slugA.length > slugB.length ? slugA : slugB;
      } finally {
        db.close();
      }

      // THE CORE G3 ASSERTIONS:
      // (1) the stored slug never exceeds the engine's own cap.
      expect(disambiguatedSlug.length).toBeLessThanOrEqual(60);

      // (2) THE RESOLVEREF ROUND-TRIP PROOF: re-slugifying the stored value is a NO-OP — i.e.
      // mirroredSlugify(stored) === stored. This mirrors resolveRef's OWN mechanism exactly
      // (engine.ts:3182-3186: `const slug = slugify(ref); ... WHERE slug = ?`) — if this equality
      // holds, a caller passing this exact slug text back in as a `#ref` gets the IDENTICAL string
      // out of slugify(ref), so the `WHERE slug = ?` lookup succeeds. If round 3's un-capped
      // `${baseSlug}-${row.id}` form were still in use, THIS assertion is exactly the one that would
      // fail (slugify() would truncate the 97-char value to a 60-char prefix, which would not equal
      // the full 97-char stored value).
      expect(mirroredSlugify(disambiguatedSlug)).toBe(disambiguatedSlug);
    });

    it("bonus proof: a live MonetCore opened on the scrubbed copy actually RESOLVES the disambiguated slug via the public store()-time asserted-edge path (exercises resolveRef end to end, not just the mirrored-slugify assertion)", async () => {
      // resolveRef is `private` — its only public-facing callers are the asserted-edge parsers run
      // during store() (e.g. a `supports: #<slug>` marker in stored text). This test drives that real
      // path: after scrubbing produces an over-length-forced disambiguated slug, open a MonetCore on
      // the SCRUBBED copy and store a NEW concept whose text asserts a reference to that exact slug —
      // if resolveRef's lookup succeeds, an asserted edge from the new concept to the disambiguated
      // slug's concept is created; if it silently failed (the G3 bug), no such edge would exist.
      const dir = mkTmp("scrub-db-slugs-overlength-e2e-");
      const srcPath = join(dir, "src-monet.db");
      const core = new MonetCore(srcPath);
      let idA: string;
      let idB: string;
      try {
        const longTitleLead =
          "This is a very long and detailed architecture note about the storage engine internals " +
          "and how the write ahead log interacts with the b tree page cache during heavy concurrent " +
          "write load across many simultaneous sessions and connections";
        const a = await core.store(
          `${longTitleLead} — this specific note is entirely about database indexing strategy and ` +
            "B-tree page splits under heavy write load, a topic unrelated to the second note, " +
            "distinct enough that dedup should not merge them. " +
            "a".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "insight" },
        );
        idA = a.conceptId!;
        const b = await core.store(
          `${longTitleLead} — this second note is entirely about OAuth token refresh race conditions ` +
            "in the auth service, again unrelated to the first note, distinct enough that dedup " +
            "should not merge them. " +
            "b".repeat(200),
          { circle: SAMPLED_CIRCLE, kind: "decision" },
        );
        idB = b.conceptId!;
      } finally {
        core.close();
      }

      const dstPath = join(dir, "scrubbed", "monet.db");
      scrubSizeDb(srcPath, dstPath);

      const scrubbedDb = new Database(dstPath, { readonly: true });
      let disambiguatedSlug: string;
      let disambiguatedConceptId: string;
      try {
        const rows = scrubbedDb.prepare(`SELECT id, slug FROM concepts ORDER BY id`).all() as Array<{ id: string; slug: string }>;
        const rowA = rows.find((r) => r.id === idA)!;
        const rowB = rows.find((r) => r.id === idB)!;
        expect(rowA.slug).not.toBe(rowB.slug);
        const disambiguatedRow = rowA.slug.length > rowB.slug.length ? rowA : rowB;
        disambiguatedSlug = disambiguatedRow.slug;
        disambiguatedConceptId = disambiguatedRow.id;
      } finally {
        scrubbedDb.close();
      }
      expect(mirroredSlugify(disambiguatedSlug)).toBe(disambiguatedSlug); // same fixed-point proof, before the e2e step

      const liveCore = new MonetCore(dstPath);
      try {
        const referrer = await liveCore.store(`A new note. supports: #${disambiguatedSlug}`, { circle: SAMPLED_CIRCLE });
        const edges = liveCore.edges({ circle: SAMPLED_CIRCLE, type: "supports" });
        expect(
          edges.some((e) => e.srcId === referrer.conceptId && e.dstId === disambiguatedConceptId),
        ).toBe(true); // resolveRef found the disambiguated concept by its own (capped, round-trippable) slug
      } finally {
        liveCore.close();
      }
    });
  });
});

describe("rewriteAssertedSlugRefsInDb — round 5, J1 fix: stale `#<old-slug>` asserted-ref tokens are rewritten to the NEW slug", () => {
  it("rewrites a real `resolves: #<old-slug>` assertion in a DIFFERENT concept's body to the NEW slug, after the referenced concept's own slug is regenerated from its scrubbed title", async () => {
    const dir = mkTmp("scrub-db-j1-ref-rewrite-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    let sensitiveId: string;
    let referrerId: string;
    let oldSlug: string;
    try {
      // A concept whose title leads with a sensitive /Users/ path — the SAME proven fixture
      // phrasing scrubConceptSlugs' own "regenerates the slug..." test above uses (path placed at
      // the very START of the string survives firstLine()'s truncation whole, verified there:
      // produces title "/Users/dev/secret-notes", RAW slug "users-dev-secret-notes"). A
      // literal EMAIL cannot play this role in a firstLine()-truncated title (verified directly,
      // separately from this suite): the "." inside "jane.doe@..." is itself a firstLine() split
      // point, so an email-LED title always truncates to just "jane" before the dot — the PR
      // comment's `#jane-doe-example-com` example is illustrative of the LEAK SHAPE (a slugified
      // sensitive fragment surviving in ref text), not a claim that titles preserve raw email
      // strings whole; a path-derived leaky slug is the equally-valid, empirically-correct fixture
      // for exercising the identical rewrite mechanism.
      const sensitive = await core.store(
        "/Users/dev/secret-notes.txt has the details — contact jane.doe@example.com about " +
          "/Users/dev/secret-notes.txt for questions.",
        { circle: SAMPLED_CIRCLE },
      );
      sensitiveId = sensitive.conceptId!;
      const sensitiveRow = (await core.getConcept(sensitiveId))!;
      oldSlug = sensitiveRow.slug;
      expect(oldSlug).toBe("users-dev-secret-notes"); // non-vacuity: the exact leaky slug, verified empirically (same value the sibling test above establishes)

      // A SEPARATE concept whose body asserts a REAL `resolves: #<old-slug>` reference to the
      // sensitive concept above — via the actual public store() API, so deriveAssertedEdges
      // (engine.ts) genuinely parses it and creates a real `resolves`-type memory_edge, exactly
      // mirroring edges.test.ts's own "creates an agent-asserted typed edge" precedent. Content is
      // deliberately long and topically distinct from the sensitive concept (verified empirically:
      // a short/generic referrer body gets ATTACHED to the existing concept by the engine's own
      // similarity-based dedup instead of creating a new one, which would silently defeat this test
      // by making referrerId === sensitiveId — same "near-identical bodies DO get merged" caution
      // the base-slug-collision test above already documents).
      const referrer = await core.store(
        `On-call rotation handoff is now complete for the payments-service incident review process, ` +
          `an entirely unrelated topic about container orchestration and pod scheduling policy. ` +
          `resolves: #${oldSlug} ` +
          "z".repeat(200),
        { circle: SAMPLED_CIRCLE },
      );
      referrerId = referrer.conceptId!;
      expect(referrerId).not.toBe(sensitiveId); // non-vacuity: confirm dedup did NOT merge these into one concept

      // Non-vacuity: confirm the real edge actually resolved BEFORE any scrub runs (proves the
      // fixture's #ref really is engine-parsed, not just textually present).
      const preEdges = core.edges({ circle: SAMPLED_CIRCLE, type: "resolves" });
      expect(preEdges.some((e) => e.srcId === referrerId && e.dstId === sensitiveId)).toBe(true);
    } finally {
      core.close();
    }

    // Non-vacuity precondition, verified directly against raw stored bytes: the referrer's body
    // literally contains the old slug string before any scrub runs.
    const preDb = new Database(dbPath, { readonly: true });
    try {
      const row = preDb.prepare(`SELECT body FROM concepts WHERE id = ?`).get(referrerId) as { body: string };
      expect(row.body).toContain(`#${oldSlug}`);
    } finally {
      preDb.close();
    }

    const db = new Database(dbPath);
    try {
      scrubConceptsAndObservations(db); // scrubs title/body (path→[redacted-path] in the sensitive concept's TITLE; referrer's own body has no sensitive text, only the #ref token)
      const slugStats = scrubConceptSlugs(db);
      expect(slugStats.renameMap.size).toBeGreaterThan(0);
      expect(slugStats.renameMap.has(oldSlug)).toBe(true);
      const newSlug = slugStats.renameMap.get(oldSlug)!;
      expect(newSlug).not.toBe(oldSlug);
      expect(newSlug).not.toContain("users-dev"); // the fix's whole point: no path fragment survives in the NEW slug
      expect(newSlug).not.toContain("secret-notes");

      const refStats = rewriteAssertedSlugRefsInDb(db, slugStats.renameMap);
      expect(refStats.bodyRefRewrites).toBe(1);

      const row = db.prepare(`SELECT body FROM concepts WHERE id = ?`).get(referrerId) as { body: string };
      // THE J1 FIX ITSELF: the referrer's body no longer contains the OLD (sensitive-shaped) slug
      // anywhere, and now contains the NEW slug in the exact same ref-shaped position.
      expect(row.body).not.toContain(oldSlug);
      expect(row.body).not.toContain("users-dev");
      expect(row.body).not.toContain("secret-notes");
      expect(row.body).toContain(`resolves: #${newSlug}`);
    } finally {
      db.close();
    }
  });

  it("MonetCore smoke: a rewritten #ref still RESOLVES on the scrubbed copy — store() a NEW referrer against the scrubbed db, asserting the NEW slug, and confirm the edge exists", async () => {
    const dir = mkTmp("scrub-db-j1-resolve-smoke-");
    const srcPath = join(dir, "src.db");
    const core = new MonetCore(srcPath);
    let sensitiveId: string;
    let oldSlug: string;
    try {
      // Same proven-working "path-led title" fixture as the sibling test above (a literal email
      // cannot survive whole into a firstLine()-truncated title — see that test's own doc comment
      // for the verified reason).
      const sensitive = await core.store("/Users/dev/runbook-notes.txt owns this runbook — contact jane.doe@example.com.", {
        circle: SAMPLED_CIRCLE,
      });
      sensitiveId = sensitive.conceptId!;
      oldSlug = (await core.getConcept(sensitiveId))!.slug;
      expect(oldSlug).toContain("users-dev"); // non-vacuity: confirm this fixture really does produce a leaky slug
      // Long, topically-distinct content — same "avoid dedup merging into the sensitive concept"
      // discipline as the sibling test above.
      const referrer = await core.store(
        `Handoff note for the on-call rotation, an entirely unrelated topic about database index ` +
          `tuning and B-tree page-split behavior under sustained write load. resolves: #${oldSlug} ` +
          "y".repeat(200),
        { circle: SAMPLED_CIRCLE },
      );
      expect(referrer.conceptId).not.toBe(sensitiveId); // non-vacuity: confirm dedup did NOT merge these
    } finally {
      core.close();
    }

    const dstPath = join(dir, "scrubbed", "monet.db");
    const stats = scrubSizeDb(srcPath, dstPath);
    expect(stats.refRewrites.bodyRefRewrites).toBeGreaterThanOrEqual(1);

    // Read the sensitive concept's NEW slug off the SCRUBBED copy, then open a LIVE MonetCore on
    // that same scrubbed copy and store() a brand-new concept asserting `supports: #<newSlug>` —
    // exercising resolveRef() end-to-end via the real public API, not just inspecting stored text.
    const scrubbedDb = new Database(dstPath, { readonly: true });
    let newSlug: string;
    try {
      const row = scrubbedDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(sensitiveId) as { slug: string };
      newSlug = row.slug;
      expect(newSlug).not.toBe(oldSlug);
    } finally {
      scrubbedDb.close();
    }

    const liveCore = new MonetCore(dstPath);
    try {
      const fresh = await liveCore.store(`A brand-new note. supports: #${newSlug}`, { circle: SAMPLED_CIRCLE });
      const edges = liveCore.edges({ circle: SAMPLED_CIRCLE, type: "supports" });
      expect(edges.some((e) => e.srcId === fresh.conceptId && e.dstId === sensitiveId)).toBe(true);
    } finally {
      liveCore.close();
    }
  });

  it("is a true no-op (0 rewrites, 0 DB writes) when renameMap is empty", async () => {
    const dir = mkTmp("scrub-db-j1-noop-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    try {
      await core.store("An ordinary note with no asserted refs at all.", { circle: SAMPLED_CIRCLE });
    } finally {
      core.close();
    }
    const db = new Database(dbPath);
    try {
      const stats = rewriteAssertedSlugRefsInDb(db, new Map());
      expect(stats.bodyRefRewrites).toBe(0);
      expect(stats.contentRefRewrites).toBe(0);
    } finally {
      db.close();
    }
  });

  describe("rewriteAssertedSlugRefs (pure function) — the 5-verb, optional-#, engine-mirrored anchor", () => {
    it("rewrites all 5 real engine verbs (resolves|supersedes|derived-from|supports|contradicts), both WITH and WITHOUT the leading #", () => {
      const renameMap = new Map([["old-slug-abc", "new-slug-xyz"]]);
      const verbs = ["resolves", "supersedes", "derived-from", "supports", "contradicts"];
      for (const verb of verbs) {
        for (const withHash of [true, false]) {
          const token = withHash ? "#old-slug-abc" : "old-slug-abc";
          const text = `Some note. ${verb}: ${token} and more prose after.`;
          const { text: rewritten, hits } = rewriteAssertedSlugRefs(text, renameMap);
          expect(hits, `verb=${verb} withHash=${withHash}`).toBe(1);
          expect(rewritten, `verb=${verb} withHash=${withHash}`).toContain(`${verb}: ${withHash ? "#" : ""}new-slug-xyz`);
          expect(rewritten).not.toContain("old-slug-abc");
        }
      }
    });

    it("does NOT rewrite a bare old-slug-shaped substring with no verb: prefix (correct anchoring — never mangles ordinary prose)", () => {
      const renameMap = new Map([["old-slug-abc", "new-slug-xyz"]]);
      const text = "This prose happens to mention old-slug-abc in passing, with no colon or verb nearby.";
      const { text: rewritten, hits } = rewriteAssertedSlugRefs(text, renameMap);
      expect(hits).toBe(0);
      expect(rewritten).toBe(text); // completely unchanged
    });

    it("does NOT rewrite a captured token that isn't a key in renameMap (a raw concept id, an alias, or an unrenamed slug)", () => {
      const renameMap = new Map([["old-slug-abc", "new-slug-xyz"]]);
      const text = "supports: #completely-unrelated-slug and resolves: 550e8400-e29b-41d4-a716-446655440000";
      const { text: rewritten, hits } = rewriteAssertedSlugRefs(text, renameMap);
      expect(hits).toBe(0);
      expect(rewritten).toBe(text);
    });

    it("rewrites multiple distinct ref tokens in the same text independently, using the correct renameMap entry for each", () => {
      const renameMap = new Map([
        ["slug-one", "renamed-one"],
        ["slug-two", "renamed-two"],
      ]);
      const text = "First: supports: #slug-one. Second: contradicts: #slug-two. Untouched: resolves: #slug-three.";
      const { text: rewritten, hits } = rewriteAssertedSlugRefs(text, renameMap);
      expect(hits).toBe(2);
      expect(rewritten).toContain("supports: #renamed-one");
      expect(rewritten).toContain("contradicts: #renamed-two");
      expect(rewritten).toContain("resolves: #slug-three"); // not a renameMap key — untouched
    });

    it("is a no-op on non-string / empty input, and on a non-empty renameMap with no matching text", () => {
      const renameMap = new Map([["a", "b"]]);
      expect(rewriteAssertedSlugRefs("", renameMap)).toEqual({ text: "", hits: 0 });
      expect(rewriteAssertedSlugRefs("ordinary text", renameMap)).toEqual({ text: "ordinary text", hits: 0 });
      expect(rewriteAssertedSlugRefs("ordinary text", new Map())).toEqual({ text: "ordinary text", hits: 0 });
    });
  });
});

describe("clearConceptAliases — round 4, G1 fix: concepts.aliases carries pre-scrub slug fragments from merge history", () => {
  /**
   * Forces a REAL `mergeConceptInto` merge via the actual public API (`core.reassignCircle`), never
   * hand-inserted SQL, per this round's mission requirement (a hand-inserted aliases value wouldn't
   * prove the real engine code path produces exactly this shape). Mechanism, verified against
   * engine.ts's `reassignCircle` (engine.ts:1543-1573): it computes `bestMatches` against the
   * DESTINATION circle and merges src INTO the best match when `score >= tauAttach`. Two `store()`
   * calls with IDENTICAL text (in two different circles) produce IDENTICAL embeddings under the
   * default HashingEmbeddingProvider (deterministic, no randomness) — cosine similarity 1.0, always
   * `>= tauAttach` — so `reassignCircle(absorbedId, survivorCircle)` deterministically merges rather
   * than moves, every single time, with no reliance on a borderline threshold.
   */
  it("a real merge (via reassignCircle) writes the absorbed concept's raw-title-derived slug into the survivor's aliases; scrubbing clears it to NULL, and the survivor's own content stays fully searchable", async () => {
    const dir = mkTmp("scrub-db-aliases-merge-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    let absorbedId: string;
    let survivorId: string;
    let absorbedRawSlug: string;
    let survivorAliasesBeforeScrub: string | null;
    try {
      // The concept that will be ABSORBED — its title leads with a sensitive path (placed at the
      // START of the string, per buildFixtureDb's own documented truncation-boundary insight above)
      // so the title — and therefore the raw slug derived from it — actually carries the leak.
      const absorbed = await core.store(
        "/Users/dev/secret-notes.txt has the merge-history detail — contact jane.doe@example.com " +
          "about it.",
        { circle: "circle-a" },
      );
      absorbedId = absorbed.conceptId!;

      // The SURVIVOR — identical text, stored in a DIFFERENT circle, so reassignCircle's own
      // bestMatches lookup (scoped to the destination circle) finds it as a score-1.0 match once the
      // absorbed concept is reassigned there.
      const survivor = await core.store(
        "/Users/dev/secret-notes.txt has the merge-history detail — contact jane.doe@example.com " +
          "about it.",
        { circle: "circle-b" },
      );
      survivorId = survivor.conceptId!;

      // Non-vacuity precondition: confirm the absorbed concept's RAW slug actually carries the leak,
      // before any merge or scrub runs.
      const preDb = new Database(dbPath, { readonly: true });
      try {
        const row = preDb.prepare(`SELECT slug FROM concepts WHERE id = ?`).get(absorbedId) as { slug: string };
        absorbedRawSlug = row.slug;
      } finally {
        preDb.close();
      }
      expect(absorbedRawSlug).toContain("secret-notes");

      // THE REAL MERGE: move the absorbed concept into the survivor's circle. bestMatches finds the
      // identical-embedding survivor (score 1.0 >= tauAttach) and reassignCircle takes the MERGE
      // branch (mergeConceptInto), not the move branch.
      const result = core.reassignCircle(absorbedId, "circle-b");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("merged");
      expect(result!.conceptId).toBe(survivorId); // the survivor's id is unchanged — it absorbed the other

      // Confirm the absorbed row is actually gone (mergeConceptInto's own DELETE) — proves this is a
      // REAL merge, not a no-op.
      const postMergeDb = new Database(dbPath, { readonly: true });
      try {
        const absorbedRow = postMergeDb.prepare(`SELECT id FROM concepts WHERE id = ?`).get(absorbedId);
        expect(absorbedRow).toBeUndefined();

        const survivorRow = postMergeDb.prepare(`SELECT aliases FROM concepts WHERE id = ?`).get(survivorId) as {
          aliases: string | null;
        };
        survivorAliasesBeforeScrub = survivorRow.aliases;
      } finally {
        postMergeDb.close();
      }
    } finally {
      core.close();
    }

    // THE LEAK, confirmed via raw SQL BEFORE scrubbing: the survivor's aliases column is non-null and
    // contains the absorbed concept's sensitive, raw-title-derived slug.
    expect(survivorAliasesBeforeScrub!).not.toBeNull();
    const parsedAliases = JSON.parse(survivorAliasesBeforeScrub!) as string[];
    expect(parsedAliases).toContain(absorbedRawSlug!);
    expect(parsedAliases).toContain(absorbedId!); // mergeConceptInto also carries the absorbed id
    expect(survivorAliasesBeforeScrub).toContain("secret-notes"); // the sensitive fragment, verbatim

    // Circle every row to SAMPLED_CIRCLE so scrubConceptsAndObservations' scope-already-applied
    // invariant is satisfied — mirrors how a real derived per-size db is always re-circled at
    // sampling time. Both "circle-a"'s (now-deleted) row and "circle-b"'s survivor need this; only
    // the survivor still exists post-merge.
    const reCircleDb = new Database(dbPath);
    try {
      reCircleDb.prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run(SAMPLED_CIRCLE, survivorId);
      reCircleDb.prepare(`UPDATE observations SET circle = ? WHERE concept_id = ?`).run(SAMPLED_CIRCLE, survivorId);
    } finally {
      reCircleDb.close();
    }

    // THE FIX: run the actual scrub pipeline (not just clearConceptAliases in isolation) — proves
    // this is wired into scrubSizeDb's real pipeline, not just tested standalone.
    const dstPath = join(dir, "scrubbed", "monet.db");
    const stats = scrubSizeDb(dbPath, dstPath);
    expect(stats.aliases.aliasesCleared).toBeGreaterThan(0);

    const scrubbedDb = new Database(dstPath, { readonly: true });
    try {
      const row = scrubbedDb.prepare(`SELECT aliases FROM concepts WHERE id = ?`).get(survivorId) as { aliases: string | null };
      expect(row.aliases).toBeNull();
    } finally {
      scrubbedDb.close();
    }

    // ALSO verify resolveRef()/search on the CURRENT (surviving) concept's title still works
    // correctly on the scrubbed db post-clear — a MonetCore opened on the scrubbed copy should still
    // find the survivor by its own current (scrubbed) content, same pattern as this file's existing
    // "a MonetCore opened on the scrubbed copy answers search()/gather() sanely" test.
    const liveCore = new MonetCore(dstPath);
    try {
      const results = await liveCore.search("merge-history detail", { circle: SAMPLED_CIRCLE });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === survivorId)).toBe(true);
      const serialized = JSON.stringify(results);
      expect(serialized).not.toContain("jane.doe@example.com");
      expect(serialized).not.toContain("/Users/dev/secret-notes");
    } finally {
      liveCore.close();
    }
  });

  it("clearConceptAliases in isolation: clears only rows with a non-null aliases value, and reports an accurate hit count", async () => {
    const dir = mkTmp("scrub-db-aliases-isolated-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath); // none of buildFixtureDb's 3 concepts have ever been merged — aliases is NULL on all 3

    const db = new Database(dbPath);
    try {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE aliases IS NOT NULL`).get() as { n: number };
      expect(before.n).toBe(0); // non-vacuity: confirm the baseline fixture has no merge-derived aliases

      // Manually seed ONE row with a non-null aliases value (simulating a merge survivor), to prove
      // the function only reports/clears rows that actually have something to clear.
      const anyId = (db.prepare(`SELECT id FROM concepts LIMIT 1`).get() as { id: string }).id;
      db.prepare(`UPDATE concepts SET aliases = ? WHERE id = ?`).run(JSON.stringify(["some-old-slug", "some-old-id"]), anyId);

      const stats = clearConceptAliases(db);
      expect(stats.aliasesCleared).toBe(1);

      const after = db.prepare(`SELECT aliases FROM concepts WHERE id = ?`).get(anyId) as { aliases: string | null };
      expect(after.aliases).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("scrubContradictions", () => {
  it("scrubs detail in place and keeps the row", async () => {
    const dir = mkTmp("scrub-db-contra-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath);
    const db = new Database(dbPath);
    try {
      const stats = scrubContradictions(db);
      expect(stats.contradictionCount).toBe(1);
      expect(stats.detailHits).toBe(1);
      const row = db.prepare(`SELECT id, status, detail FROM contradictions WHERE id = 'contra-1'`).get() as {
        id: string;
        status: string;
        detail: string;
      };
      expect(row.status).toBe("open"); // row kept, only text scrubbed
      expect(row.detail).not.toContain("192.168.1.10");
      expect(row.detail).not.toContain("tenant acme");
      expect(row.detail).not.toContain("jane.doe@example.com");
      expect(row.detail).toContain("[redacted-private-endpoint]");
    } finally {
      db.close();
    }
  });
});

describe("scrubEntities — lockstep entities.key/surface + concept_entities.entity_key", () => {
  it("scrubs the sensitive path entity's key AND surface, repoints concept_entities, and leaves the legitimate entity untouched", async () => {
    const dir = mkTmp("scrub-db-entities-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath);
    const db = new Database(dbPath);
    try {
      // NOTE: buildFixtureDb's 3 real core.store() calls ALSO auto-populate entities via the
      // engine's own deriveEntityEdges (structural/noun entities extracted from the prose, e.g.
      // "id:jane.doe", "noun:acme" — see this suite's separate "ENTITY FRAGMENT LEAK" coverage
      // below), so entityCount here is NOT exactly 2 (the 2 this test manually seeds) — verified
      // directly rather than assumed to be an exact small number. This test checks the 2 SPECIFIC
      // manually-seeded rows behave correctly, not the total row count.
      const stats = scrubEntities(db);
      expect(stats.entityCount).toBeGreaterThanOrEqual(2);
      expect(stats.keyHits).toBeGreaterThan(0);
      expect(stats.surfaceHits).toBeGreaterThan(0);

      const entities = db.prepare(`SELECT key, surface FROM entities`).all() as Array<{ key: string; surface: string }>;
      const allKeysAndSurfaces = entities.map((e) => `${e.key}\n${e.surface}`).join("\n");
      expect(allKeysAndSurfaces).not.toContain("/Users/dev/.claude/CLAUDE.md");
      // The legitimate, non-sensitive relative-path entity survives completely unchanged.
      expect(entities.some((e) => e.key === "path:relative/config.json" && e.surface === "relative/config.json")).toBe(true);

      // concept_entities repointed to whatever the sensitive entity's key scrubbed down to — the
      // join must still resolve (no dangling entity_key with no matching entities row).
      const ceKeys = (db.prepare(`SELECT DISTINCT entity_key FROM concept_entities`).all() as Array<{ entity_key: string }>).map(
        (r) => r.entity_key,
      );
      const entityKeys = new Set(entities.map((e) => e.key));
      for (const k of ceKeys) expect(entityKeys.has(k)).toBe(true);
      // And no concept_entities row still carries the raw unscrubbed key.
      expect(ceKeys).not.toContain("ref:/Users/dev/.claude/CLAUDE.md");
    } finally {
      db.close();
    }
  });

  it("merges two entities that collide onto the same scrubbed key, summing df and repointing both old keys' concept_entities rows", () => {
    const dir = mkTmp("scrub-db-entities-collision-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    core.close();
    const db = new Database(dbPath);
    try {
      // Two DISTINCT raw keys that both scrub down to the identical "[redacted-path]" form (a tilde
      // path has no proof-repo-generalization case, so it always fully redacts).
      db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, 'path', ?, ?, 2)`).run(
        "path:~/code/foo",
        "~/code/foo",
        SAMPLED_CIRCLE,
      );
      db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, 'path', ?, ?, 3)`).run(
        "path:~/code/bar",
        "~/code/bar",
        SAMPLED_CIRCLE,
      );
      db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run(
        "concept-a",
        "path:~/code/foo",
        SAMPLED_CIRCLE,
      );
      db.prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run(
        "concept-b",
        "path:~/code/bar",
        SAMPLED_CIRCLE,
      );

      const stats = scrubEntities(db);
      expect(stats.mergedCollisions).toBeGreaterThan(0);

      const remaining = db.prepare(`SELECT key, df FROM entities`).all() as Array<{ key: string; df: number }>;
      // Both old keys collapsed into exactly one row (same scrubbed key), with df SUMMED (2 + 3 = 5).
      const collided = remaining.filter((r) => r.key.includes("[redacted-path]"));
      expect(collided.length).toBe(1);
      expect(collided[0].df).toBe(5);

      // Both concept_entities rows (concept-a and concept-b) now point at the SAME merged key.
      const ce = db.prepare(`SELECT concept_id, entity_key FROM concept_entities ORDER BY concept_id`).all() as Array<{
        concept_id: string;
        entity_key: string;
      }>;
      expect(ce.length).toBe(2);
      expect(new Set(ce.map((r) => r.entity_key)).size).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("pruneStaleEntities — the ENTITY FRAGMENT LEAK fix (a 6th finding beyond the mission's 5 locked directives)", () => {
  it("prunes id/noun entity fragments that only existed because the extractor split unscrubbed sensitive text (jane.doe/example.com/acme), while leaving ordinary entities alone", async () => {
    const dir = mkTmp("scrub-db-prune-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath);
    const db = new Database(dbPath);
    try {
      // Confirm the leak exists BEFORE any scrub runs — non-vacuity for this specific fix, same
      // discipline as scrub-db-closure.test.ts's own non-vacuity proof.
      const beforeEntities = db.prepare(`SELECT key FROM entities`).all() as Array<{ key: string }>;
      expect(beforeEntities.some((e) => e.key === "id:jane.doe")).toBe(true);
      expect(beforeEntities.some((e) => e.key === "id:example.com")).toBe(true);
      expect(beforeEntities.some((e) => e.key === "noun:acme")).toBe(true);

      // Must run AFTER scrubbing concepts/observations (pruneStaleEntities re-extracts from the
      // ALREADY-SCRUBBED text) and after scrubEntities (matching scrubSizeDb's own pipeline order).
      scrubConceptsAndObservations(db);
      scrubEntities(db);
      const stats = pruneStaleEntities(db);

      expect(stats.membershipsPruned).toBeGreaterThan(0);
      expect(stats.conceptsAffected).toBeGreaterThan(0);

      const afterEntities = db.prepare(`SELECT key FROM entities`).all() as Array<{ key: string }>;
      const afterKeys = new Set(afterEntities.map((e) => e.key));
      expect(afterKeys.has("id:jane.doe")).toBe(false);
      expect(afterKeys.has("id:example.com")).toBe(false);
      expect(afterKeys.has("noun:acme")).toBe(false);

      // Ordinary, non-sensitive entities that ARE still reproducible from the scrubbed text
      // survive untouched (e.g. "noun:contact"/"noun:deploy"-shaped words, or the lexicon "sqlite"
      // entity from the third concept's non-sensitive architecture note) — this is a PRUNE of what
      // no longer reproduces, not a blanket wipe of every id/noun entity.
      expect(afterKeys.has("lib:sqlite")).toBe(true);

      // No dangling concept_entities row references a pruned key.
      const ceKeys = new Set((db.prepare(`SELECT DISTINCT entity_key FROM concept_entities`).all() as Array<{ entity_key: string }>).map(
        (r) => r.entity_key,
      ));
      expect(ceKeys.has("id:jane.doe")).toBe(false);
      expect(ceKeys.has("id:example.com")).toBe(false);
      expect(ceKeys.has("noun:acme")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is a no-op (0 pruned) against text with nothing sensitive to prune", async () => {
    const dir = mkTmp("scrub-db-prune-noop-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    try {
      await core.store("Ordinary non-sensitive note about the storage backend and process.env usage.", { circle: SAMPLED_CIRCLE });
    } finally {
      core.close();
    }
    const db = new Database(dbPath);
    try {
      scrubConceptsAndObservations(db);
      scrubEntities(db);
      const stats = pruneStaleEntities(db);
      expect(stats.membershipsPruned).toBe(0);
      expect(stats.conceptsAffected).toBe(0);
      expect(stats.entitiesOrphanedAndDeleted).toBe(0);
    } finally {
      db.close();
    }
  });

  it("round 3, F3 fix: entities.df is recomputed correctly when a key is PARTIALLY pruned — surviving in one concept while pruned from another", async () => {
    // Mirrors Codex's own example exactly: id:example.com legitimately appears in TWO concepts —
    // one where it only exists because of a leaked email (jane.doe@example.com, pruned once the
    // title/body is scrubbed to "[redacted-email]"), and a SEPARATE concept where "example.com" is
    // mentioned in ordinary, non-sensitive prose with no email nearby (survives pruning, since
    // re-extracting from that concept's text — unaffected by scrubbing, since there's nothing to
    // scrub — still reproduces id:example.com). Verified directly: extractEntities produces the
    // IDENTICAL key "id:example.com" from both "jane.doe@example.com" and bare "example.com" prose.
    const dir = mkTmp("scrub-db-prune-df-");
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    let leakyConceptId: string;
    let survivingConceptId: string;
    try {
      const a = await core.store("Contact jane.doe@example.com about the deploy timeline for this specific project.", {
        circle: SAMPLED_CIRCLE,
      });
      leakyConceptId = a.conceptId!;
      const b = await core.store(
        "The domain example.com is used throughout our documentation as the canonical placeholder for links, unrelated to any personal contact information.",
        { circle: SAMPLED_CIRCLE },
      );
      survivingConceptId = b.conceptId!;
    } finally {
      core.close();
    }

    const db = new Database(dbPath);
    try {
      // Non-vacuity: confirm BOTH concepts carry the id:example.com membership before any scrub
      // runs, and that entities.df already reflects 2 (both memberships present).
      const beforeDf = (db.prepare(`SELECT df FROM entities WHERE key = 'id:example.com'`).get() as { df: number } | undefined)?.df;
      expect(beforeDf).toBe(2);
      const beforeMemberships = db
        .prepare(`SELECT concept_id FROM concept_entities WHERE entity_key = 'id:example.com' ORDER BY concept_id`)
        .all() as Array<{ concept_id: string }>;
      expect(beforeMemberships.map((r) => r.concept_id).sort()).toEqual([leakyConceptId, survivingConceptId].sort());

      scrubConceptsAndObservations(db);
      scrubEntities(db);
      const stats = pruneStaleEntities(db);

      // (a) the entity SURVIVES (not orphan-deleted) — it still has exactly 1 real membership.
      const afterRow = db.prepare(`SELECT df FROM entities WHERE key = 'id:example.com'`).get() as { df: number } | undefined;
      expect(afterRow).toBeDefined();

      // (b) df after pruning EQUALS the entity's actual remaining concept_entities row count —
      // computed from the SAME ground-truth query the fix itself uses, not a hardcoded magic
      // number, so this test honestly checks the INVARIANT rather than today's fixture shape.
      const actualRemainingCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE entity_key = 'id:example.com'`).get() as { n: number }
      ).n;
      expect(actualRemainingCount).toBe(1); // pruned from the leaky concept, survives in the other
      expect(afterRow!.df).toBe(actualRemainingCount);
      expect(afterRow!.df).toBe(1); // concretely: was 2, one membership pruned, now 1 — NOT stale at 2

      // The remaining membership is specifically the SURVIVING (non-leaky) concept, not the leaky one.
      const remainingMembership = db
        .prepare(`SELECT concept_id FROM concept_entities WHERE entity_key = 'id:example.com'`)
        .get() as { concept_id: string };
      expect(remainingMembership.concept_id).toBe(survivingConceptId);

      expect(stats.dfRecomputed).toBeGreaterThan(0);

      // (c) the invariant df === COUNT(concept_entities WHERE entity_key = key AND scope = scope)
      // holds for EVERY surviving entity after pruneStaleEntities runs — not just the one
      // cherry-picked row above. This is the real bug class Codex flagged (a STALE df on ANY
      // partially-pruned entity), so the test verifies the invariant generically.
      const allEntities = db.prepare(`SELECT key, scope, df FROM entities`).all() as Array<{ key: string; scope: string; df: number }>;
      expect(allEntities.length).toBeGreaterThan(0); // sanity: there ARE surviving entities to check
      for (const e of allEntities) {
        const actual = (
          db
            .prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE entity_key = ? AND scope = ?`)
            .get(e.key, e.scope) as { n: number }
        ).n;
        expect(e.df).toBe(actual);
      }

      // No entity with df=0 survives (a df=0 entity should always have been orphan-deleted).
      expect(allEntities.some((e) => e.df === 0)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("pruneOrphanedAboutEdges — round 5, J3 fix: `about` edges surviving a pruned shared-entity justification are removed", () => {
  /**
   * Directly constructs `memory_edge`/`concept_entities` rows via raw SQL rather than relying on
   * deriveEntityEdges' own hub-gating/rarity heuristics to naturally produce a specific about-edge
   * shape (verified empirically while designing this fixture: a from-scratch 2-concept fixture
   * sharing only NOUN-kind entities never crosses the hub gate at all — `isHubDf`'s df-fraction
   * math reads df=2-of-n=2 as maximally "common", not rare, so no about edge forms without adding
   * several unrelated filler concepts first, matching edges.test.ts's own documented hub-gating
   * test). This function's OWN logic (the co-membership join) is what needs verification here — not
   * deriveEntityEdges' heuristics, which are already covered by edges.test.ts — so a controlled,
   * deterministic raw-SQL fixture is the correct, established precedent this suite already uses
   * elsewhere (buildFixtureDb's own raw-SQL seeding for contradictions/first_block/sessions, which
   * store() alone cannot control either).
   */
  function seedAboutEdgeFixture(dbPath: string): { conceptA: string; conceptB: string; conceptC: string; conceptD: string } {
    const core = new MonetCore(dbPath);
    core.close(); // just to get a real, correctly-migrated schema on disk
    const db = new Database(dbPath);
    try {
      const now = Date.now();
      const emb = JSON.stringify(new Array(8).fill(0));
      const ids = { conceptA: "about-a", conceptB: "about-b", conceptC: "about-c", conceptD: "about-d" };
      for (const [id, title] of Object.entries({
        [ids.conceptA]: "Concept A",
        [ids.conceptB]: "Concept B",
        [ids.conceptC]: "Concept C",
        [ids.conceptD]: "Concept D",
      })) {
        db.prepare(
          `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding, support_count, version, dirty, usefulness_score, created_at, updated_at)
           VALUES (?, ?, ?, 'body text', 'fact', 'active', 0.6, ?, ?, 1, 0, 0, 0, ?, ?)`,
        ).run(id, id, title, SAMPLED_CIRCLE, emb, now, now);
      }
      // A <-> B share entity "id:jane.doe" (the entity this fixture will PRUNE below) — the about
      // edge between them should be REMOVED once that shared membership is gone.
      db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES ('id:jane.doe', 'id', 'jane.doe', ?, 2)`).run(SAMPLED_CIRCLE);
      db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, 'id:jane.doe', ?)`).run(ids.conceptA, SAMPLED_CIRCLE);
      db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, 'id:jane.doe', ?)`).run(ids.conceptB, SAMPLED_CIRCLE);
      // C <-> D share entity "lib:sqlite" (a CONTROL pair — this membership is NOT pruned) — the
      // about edge between them should SURVIVE untouched.
      db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES ('lib:sqlite', 'lib', 'sqlite', ?, 2)`).run(SAMPLED_CIRCLE);
      db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, 'lib:sqlite', ?)`).run(ids.conceptC, SAMPLED_CIRCLE);
      db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, 'lib:sqlite', ?)`).run(ids.conceptD, SAMPLED_CIRCLE);

      // Symmetric about edges for BOTH pairs, matching upsertEdgeBoth's own real write pattern
      // (both directions, same weight/origin).
      const insertEdge = db.prepare(
        `INSERT INTO memory_edge (id, src_id, dst_id, type, weight, origin, scope) VALUES (?, ?, ?, 'about', 0.5, 'cheap', ?)`,
      );
      insertEdge.run("edge-ab-1", ids.conceptA, ids.conceptB, SAMPLED_CIRCLE);
      insertEdge.run("edge-ab-2", ids.conceptB, ids.conceptA, SAMPLED_CIRCLE);
      insertEdge.run("edge-cd-1", ids.conceptC, ids.conceptD, SAMPLED_CIRCLE);
      insertEdge.run("edge-cd-2", ids.conceptD, ids.conceptC, SAMPLED_CIRCLE);

      return ids;
    } finally {
      db.close();
    }
  }

  it("removes BOTH directional `about` edge rows for a pair whose shared entity membership was pruned, while an untouched pair's about edges survive", () => {
    const dir = mkTmp("scrub-db-j3-orphaned-edges-");
    const dbPath = join(dir, "monet.db");
    const { conceptA, conceptB, conceptC, conceptD } = seedAboutEdgeFixture(dbPath);

    const db = new Database(dbPath);
    try {
      // Non-vacuity: confirm all 4 edge rows exist BEFORE pruning.
      const before = db.prepare(`SELECT src_id, dst_id FROM memory_edge WHERE type = 'about' ORDER BY id`).all() as Array<{
        src_id: string;
        dst_id: string;
      }>;
      expect(before.length).toBe(4);

      // Prune the A<->B shared membership DIRECTLY (simulating what pruneStaleEntities would do —
      // this test targets pruneOrphanedAboutEdges' OWN logic in isolation, not the full
      // scrubConceptsAndObservations->scrubEntities->pruneStaleEntities chain, matching this file's
      // own "test each function's own contract" discipline stated in its module doc).
      db.prepare(`DELETE FROM concept_entities WHERE entity_key = 'id:jane.doe' AND concept_id = ?`).run(conceptA);
      db.prepare(`DELETE FROM concept_entities WHERE entity_key = 'id:jane.doe' AND concept_id = ?`).run(conceptB);

      const stats = pruneOrphanedAboutEdges(db);
      expect(stats.pairsScanned).toBe(2); // the 2 DISTINCT unordered pairs (A,B) and (C,D)
      expect(stats.pairsAffected).toBe(1); // only (A,B) lost its justification
      expect(stats.edgesRemoved).toBe(2); // BOTH directional rows for the (A,B) pair

      const after = db.prepare(`SELECT src_id, dst_id FROM memory_edge WHERE type = 'about' ORDER BY id`).all() as Array<{
        src_id: string;
        dst_id: string;
      }>;
      expect(after.length).toBe(2);
      // Neither direction of the A<->B edge survives.
      expect(after.some((e) => e.src_id === conceptA && e.dst_id === conceptB)).toBe(false);
      expect(after.some((e) => e.src_id === conceptB && e.dst_id === conceptA)).toBe(false);
      // BOTH directions of the C<->D control edge survive, untouched.
      expect(after.some((e) => e.src_id === conceptC && e.dst_id === conceptD)).toBe(true);
      expect(after.some((e) => e.src_id === conceptD && e.dst_id === conceptC)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is a no-op (0 removed) when every about edge's shared-entity justification still holds", () => {
    const dir = mkTmp("scrub-db-j3-noop-");
    const dbPath = join(dir, "monet.db");
    seedAboutEdgeFixture(dbPath); // both pairs' memberships left intact — nothing pruned upstream

    const db = new Database(dbPath);
    try {
      const stats = pruneOrphanedAboutEdges(db);
      expect(stats.pairsScanned).toBe(2);
      expect(stats.pairsAffected).toBe(0);
      expect(stats.edgesRemoved).toBe(0);

      const after = db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE type = 'about'`).get() as { n: number };
      expect(after.n).toBe(4); // all 4 original rows survive, untouched
    } finally {
      db.close();
    }
  });

  it("removes an edge when BOTH endpoints lose their shared membership (not just one side)", () => {
    const dir = mkTmp("scrub-db-j3-both-sides-pruned-");
    const dbPath = join(dir, "monet.db");
    const { conceptA, conceptB } = seedAboutEdgeFixture(dbPath);

    const db = new Database(dbPath);
    try {
      // Prune ONLY conceptA's side of the shared membership — conceptB still carries it, so the
      // pair no longer shares an entity (co-membership requires BOTH sides), and the edge should
      // still be removed (co-membership is not "either side still has ANY membership" — it's "do
      // BOTH sides share the SAME entity_key").
      db.prepare(`DELETE FROM concept_entities WHERE entity_key = 'id:jane.doe' AND concept_id = ?`).run(conceptA);

      const stats = pruneOrphanedAboutEdges(db);
      expect(stats.pairsAffected).toBe(1);
      expect(stats.edgesRemoved).toBe(2);

      const after = db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE type = 'about' AND (src_id = ? OR dst_id = ?)`).get(
        conceptA,
        conceptA,
      ) as { n: number };
      expect(after.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("real-pipeline integration: pruneOrphanedAboutEdges runs AFTER pruneStaleEntities in scrubSizeDb's own orchestration, and correctly closes an about-edge orphaned by the REAL prune", async () => {
    // End-to-end via the real store()->deriveEntityEdges path (not the direct-SQL fixture above) —
    // confirms the two functions compose correctly through scrubSizeDb's actual pipeline order.
    // Content is deliberately from two COMPLETELY DISJOINT technical domains (Kubernetes ingress
    // config vs. PostgreSQL vacuum tuning) with NO shared connective prose ("filed a ticket about",
    // "confirmed the rollback resolved" etc. all produce incidental noun-entity overlap even across
    // otherwise-different topics — verified empirically while designing this fixture, several
    // narrower attempts left an incidental shared noun like "covering"/"specifically" surviving
    // after the sensitive email is pruned, which correctly keeps the about-edge alive since the
    // concepts GENUINELY still share that entity — this fixture avoids that by construction, so the
    // ONLY entities the two concepts share are id:jane.doe/id:example.com, the ones this test
    // actually wants pruned).
    const dir = mkTmp("scrub-db-j3-integration-");
    const srcPath = join(dir, "src.db");
    const core = new MonetCore(srcPath);
    let idA: string;
    let idB: string;
    try {
      const a = await core.store(
        "jane.doe@example.com: Kubernetes ingress nginx annotations rewrite-target regex pathType Prefix. " + "a".repeat(150),
        { circle: SAMPLED_CIRCLE },
      );
      idA = a.conceptId!;
      const b = await core.store(
        "jane.doe@example.com: PostgreSQL vacuum autovacuum threshold tuning bloat estimation queries. " + "b".repeat(150),
        { circle: SAMPLED_CIRCLE },
      );
      idB = b.conceptId!;
    } finally {
      core.close();
    }

    // Non-vacuity preconditions, verified directly: (1) a real `about` edge exists BEFORE any scrub
    // runs, and (2) the ONLY entities the two concepts share are the sensitive ones this test
    // expects to be pruned (confirms the fixture's own "fully disjoint except for the sensitive
    // entity" design intent, rather than assuming it).
    const preDb = new Database(srcPath, { readonly: true });
    try {
      const preEdges = preDb.prepare(`SELECT src_id, dst_id FROM memory_edge WHERE type = 'about' AND src_id = ? AND dst_id = ?`).all(
        idA,
        idB,
      );
      expect(preEdges.length).toBe(1);

      const ceA = new Set(
        (preDb.prepare(`SELECT entity_key FROM concept_entities WHERE concept_id = ?`).all(idA) as Array<{ entity_key: string }>).map(
          (r) => r.entity_key,
        ),
      );
      const ceB = new Set(
        (preDb.prepare(`SELECT entity_key FROM concept_entities WHERE concept_id = ?`).all(idB) as Array<{ entity_key: string }>).map(
          (r) => r.entity_key,
        ),
      );
      const shared = [...ceA].filter((k) => ceB.has(k));
      expect(new Set(shared)).toEqual(new Set(["id:jane.doe", "id:example.com"]));
    } finally {
      preDb.close();
    }

    const dstPath = join(dir, "scrubbed", "monet.db");
    const stats = scrubSizeDb(srcPath, dstPath);
    // Non-vacuity for THIS integration test specifically: the real pipeline actually pruned the
    // shared jane.doe/example.com membership — assert it here too, so a false pass (0 pruned, 0
    // edges removed, vacuously "correct") can't slip through.
    expect(stats.prunedEntities.membershipsPruned).toBeGreaterThan(0);
    expect(stats.prunedAboutEdges.pairsAffected).toBe(1);
    expect(stats.prunedAboutEdges.edgesRemoved).toBe(2);

    const scrubbedDb = new Database(dstPath, { readonly: true });
    try {
      const afterEdges = scrubbedDb
        .prepare(`SELECT src_id, dst_id FROM memory_edge WHERE type = 'about' AND ((src_id = ? AND dst_id = ?) OR (src_id = ? AND dst_id = ?))`)
        .all(idA, idB, idB, idA);
      expect(afterEdges.length).toBe(0);
    } finally {
      scrubbedDb.close();
    }
  });
});

describe("emptyConceptRevisions", () => {
  it("deletes every row, reporting how many were removed", async () => {
    const dir = mkTmp("scrub-db-revisions-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath);
    const db = new Database(dbPath);
    try {
      const stats = emptyConceptRevisions(db);
      expect(stats.rowsDeleted).toBe(1);
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM concept_revisions`).get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("scrubFutureProofedColumns — first_block.summary/promoted_by, sessions.summary/scope_context/agent_id, contradictions.resolved_by, memory_edge.dismissed_by", () => {
  it("scrubs all seven columns even though several of them don't populate at scale in this pipeline today", async () => {
    const dir = mkTmp("scrub-db-futureproof-");
    const dbPath = join(dir, "monet.db");
    await buildFixtureDb(dbPath);
    const db = new Database(dbPath);
    try {
      const stats = scrubFutureProofedColumns(db);
      expect(stats.firstBlockCount).toBe(1);
      expect(stats.firstBlockHits).toBe(1); // "fb-1" has hits on BOTH summary and promoted_by (round 5, H2)

      // 2 sessions total: buildFixtureDb's `new MonetCore(path)` auto-creates ONE session row
      // (agent_id: "local-agent", summary/scope_context both null — verified directly, not
      // assumed) shared by all 3 store() calls, PLUS the ONE manually-seeded "sess-1" row with
      // real sensitive scope_context/summary content. Only "sess-1" shows a scrub hit — its
      // agent_id ("test-agent") is benign, so this fixture's own sessionsHits count is unaffected
      // by round 5, H1's agent_id scrub; see the dedicated "round 5, H1" describe block below for
      // a fixture that actually exercises a hostile agent_id.
      expect(stats.sessionCount).toBe(2);
      expect(stats.sessionsHits).toBe(1);

      expect(stats.contradictionCount).toBe(1);
      expect(stats.resolvedByHits).toBe(1); // "contra-1"'s resolved_by (round 5, H2)

      // memoryEdgeCount is NOT a fixed 1: buildFixtureDb's 3 store() calls also trigger the
      // engine's own real dedup/graph machinery, which auto-creates several genuine edges between
      // the 3 concepts (co_occurred/follows/possible_duplicate_of/related — verified directly, not
      // assumed: a live probe against this exact fixture found 12 such rows) — none of which ever
      // set dismissed_by (only dismissPossibleDuplicate does that), so dismissedByHits stays
      // exactly 1 (only the manually-seeded "edge-1" row) regardless of how many auto-generated
      // edges exist alongside it.
      expect(stats.memoryEdgeCount).toBeGreaterThanOrEqual(1);
      expect(stats.dismissedByHits).toBe(1); // "edge-1"'s dismissed_by (round 5, H2)

      const fb = db.prepare(`SELECT summary, promoted_by FROM first_block WHERE id = 'fb-1'`).get() as {
        summary: string;
        promoted_by: string;
      };
      expect(fb.summary).not.toContain("192.168.1.10");
      expect(fb.summary).not.toContain("tenant acme");
      expect(fb.promoted_by).not.toContain("/Users/dev");
      expect(fb.promoted_by).toContain("[redacted-path]");

      const sess = db.prepare(`SELECT summary, scope_context FROM sessions WHERE id = 'sess-1'`).get() as {
        summary: string;
        scope_context: string;
      };
      expect(sess.scope_context).not.toContain("/Users/dev");
      expect(sess.summary).not.toContain("jane.doe@example.com");
      expect(sess.summary).not.toContain("~/code/foo");

      const contra = db.prepare(`SELECT resolved_by FROM contradictions WHERE id = 'contra-1'`).get() as { resolved_by: string };
      expect(contra.resolved_by).not.toContain("jane.doe@example.com");
      expect(contra.resolved_by).toContain("[redacted-email]");

      const edge = db.prepare(`SELECT dismissed_by FROM memory_edge WHERE id = 'edge-1'`).get() as { dismissed_by: string };
      expect(edge.dismissed_by).not.toContain("jane.doe@example.com");
      expect(edge.dismissed_by).toContain("[redacted-email]");
    } finally {
      db.close();
    }
  });

  describe("round 5, H1 fix: sessions.agent_id is scrubbed", () => {
    it("scrubs a hostile-shaped agent_id (an email) supplied via the MonetCore constructor's agentId option", async () => {
      const dir = mkTmp("scrub-db-session-agentid-");
      const dbPath = join(dir, "monet.db");
      // agentId is a MonetCoreOptions.agentId constructor option (engine.ts:391), read ONCE at
      // construction (engine.ts:479) and stamped onto every SESSION this instance opens
      // (sessions.agent_id, schema: TEXT NOT NULL) — the same constructor option round 4's G2 fix
      // scrubbed off observations.author_agent_id, uncovered here on the sessions copy until this
      // round 5, H1 fix (PR comment id 3522770783).
      const hostileAgentId = "jane.doe@example.com";
      const core = new MonetCore(dbPath, { agentId: hostileAgentId });
      try {
        await core.store("An ordinary, non-sensitive note about the storage backend.", { circle: SAMPLED_CIRCLE });
      } finally {
        core.close();
      }

      // Non-vacuity: confirm the raw sessions.agent_id column holds the hostile value BEFORE scrubbing.
      const preDb = new Database(dbPath, { readonly: true });
      try {
        const sessRow = preDb.prepare(`SELECT agent_id FROM sessions`).get() as { agent_id: string };
        expect(sessRow.agent_id).toBe(hostileAgentId);
      } finally {
        preDb.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubFutureProofedColumns(db);
        expect(stats.sessionsHits).toBeGreaterThan(0);

        const sessRow = db.prepare(`SELECT agent_id FROM sessions`).get() as { agent_id: string };
        expect(sessRow.agent_id).not.toBe(hostileAgentId);
        expect(sessRow.agent_id).not.toContain("jane.doe@example.com");
        expect(sessRow.agent_id).toContain("[redacted-email]");
      } finally {
        db.close();
      }
    });

    it("scrubs a hostile-shaped agent_id (a /Users/ path) supplied via the constructor", async () => {
      const dir = mkTmp("scrub-db-session-agentid-path-");
      const dbPath = join(dir, "monet.db");
      const hostileAgentId = "/Users/dev/agents/eval-runner";
      const core = new MonetCore(dbPath, { agentId: hostileAgentId });
      try {
        await core.store("An ordinary, non-sensitive note about the storage backend.", { circle: SAMPLED_CIRCLE });
      } finally {
        core.close();
      }

      const db = new Database(dbPath);
      try {
        const stats = scrubFutureProofedColumns(db);
        expect(stats.sessionsHits).toBeGreaterThan(0);
        const sessRow = db.prepare(`SELECT agent_id FROM sessions`).get() as { agent_id: string };
        expect(sessRow.agent_id).not.toContain("/Users/dev");
        expect(sessRow.agent_id).toContain("[redacted-path]");
      } finally {
        db.close();
      }
    });
  });

  describe("round 5, H2 fix: contradictions.resolved_by / memory_edge.dismissed_by / first_block.promoted_by are scrubbed, both directions (email + path)", () => {
    it("scrubs a hostile-shaped resolved_by (a /Users/ path)", () => {
      const dir = mkTmp("scrub-db-resolvedby-path-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      core.close();
      const db = new Database(dbPath);
      try {
        db.prepare(`INSERT INTO contradictions (id, concept_id, kind, status, detail, resolved_by) VALUES ('c1', 'nonexistent', 'value-conflict', 'open', '', ?)`).run(
          "/Users/dev/agents/curation-bot",
        );
        const stats = scrubFutureProofedColumns(db);
        expect(stats.resolvedByHits).toBeGreaterThan(0);
        const row = db.prepare(`SELECT resolved_by FROM contradictions WHERE id = 'c1'`).get() as { resolved_by: string };
        expect(row.resolved_by).not.toContain("/Users/dev");
        expect(row.resolved_by).toContain("[redacted-path]");
      } finally {
        db.close();
      }
    });

    it("scrubs a hostile-shaped dismissed_by (an email)", () => {
      const dir = mkTmp("scrub-db-dismissedby-email-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      core.close();
      const db = new Database(dbPath);
      try {
        db.prepare(
          `INSERT INTO memory_edge (id, src_id, dst_id, type, dismissed_at, dismissed_by) VALUES ('e1', 'a', 'b', 'possible_duplicate_of', unixepoch() * 1000, ?)`,
        ).run("jane.doe@example.com");
        const stats = scrubFutureProofedColumns(db);
        expect(stats.dismissedByHits).toBeGreaterThan(0);
        const row = db.prepare(`SELECT dismissed_by FROM memory_edge WHERE id = 'e1'`).get() as { dismissed_by: string };
        expect(row.dismissed_by).not.toContain("jane.doe@example.com");
        expect(row.dismissed_by).toContain("[redacted-email]");
      } finally {
        db.close();
      }
    });

    it("scrubs a hostile-shaped promoted_by (a /Users/ path)", async () => {
      const dir = mkTmp("scrub-db-promotedby-path-");
      const dbPath = join(dir, "monet.db");
      const core = new MonetCore(dbPath);
      let conceptId: string;
      try {
        const r = await core.store("An ordinary, non-sensitive note.", { circle: SAMPLED_CIRCLE });
        conceptId = r.conceptId!;
      } finally {
        core.close();
      }

      const db = new Database(dbPath);
      try {
        db.prepare(`INSERT INTO first_block (id, concept_id, circle, summary, position, promoted_by) VALUES ('fb-x', ?, ?, 'note', 0, ?)`).run(
          conceptId,
          SAMPLED_CIRCLE,
          "/Users/dev/agents/curation-bot",
        );
        const stats = scrubFutureProofedColumns(db);
        expect(stats.firstBlockHits).toBeGreaterThan(0);
        const row = db.prepare(`SELECT promoted_by FROM first_block WHERE id = 'fb-x'`).get() as { promoted_by: string };
        expect(row.promoted_by).not.toContain("/Users/dev");
        expect(row.promoted_by).toContain("[redacted-path]");
      } finally {
        db.close();
      }
    });
  });
});

describe("assertScopeAlreadyApplied", () => {
  it("does not throw when every row matches SAMPLED_CIRCLE", () => {
    expect(() => assertScopeAlreadyApplied([{ circle: SAMPLED_CIRCLE }, { circle: SAMPLED_CIRCLE }], "fake.db", "concepts")).not.toThrow();
  });

  it("throws naming the table and the offending circle when a row doesn't match", () => {
    try {
      assertScopeAlreadyApplied([{ circle: SAMPLED_CIRCLE }, { circle: "example-circle" }], "fake.db", "concepts");
      expect.unreachable("expected assertScopeAlreadyApplied to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("concepts");
      expect(message).toContain("example-circle");
      expect(message).toContain("fake.db");
    }
  });
});

describe("assertNoOverlap — round 3, F5 fix: guard against --out overlapping --db before any destructive rmSync runs", () => {
  const repo = "/repo"; // already-resolved (absolute-shaped) fixture paths — this function never re-resolves them itself

  it("throws on identical resolved paths", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus/db`)).toThrow(/IDENTICAL/);
  });

  it("throws when --out is a DIRECT ancestor of --db (--out=eval-corpus, --db=eval-corpus/db)", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus`)).toThrow(/ANCESTOR/);
  });

  it("throws when --out is an INDIRECT (deeper) ancestor of --db (--out=/repo, --db=eval-corpus/db)", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, repo)).toThrow(/ANCESTOR/);
  });

  it("throws when --out is a DIRECT descendant of --db (--out=eval-corpus/db/25, --db=eval-corpus/db)", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus/db/25`)).toThrow(/DESCENDANT/);
  });

  it("throws when --out is an INDIRECT (deeper) descendant of --db (--out=eval-corpus/db/25/nested, --db=eval-corpus/db)", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus/db/25/nested`)).toThrow(/DESCENDANT/);
  });

  it("does NOT throw for the real, actual DEFAULT production pair (--db=eval-corpus/db, --out=eval-corpus/db-scrubbed) — a regression here would break the whole pipeline", () => {
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus/db-scrubbed`)).not.toThrow();
  });

  it("does NOT throw for a lookalike SIBLING directory whose name merely starts with the same prefix (proves real path containment, not a string-prefix check)", () => {
    // Mirrors corpus-sample.test.ts's own "refuses a lookalike SIBLING directory" precedent for
    // assertSafeToWipe — "eval-corpus/db-backup" is NOT nested inside "eval-corpus/db" despite
    // sharing a string prefix; a naive startsWith() check would wrongly flag this as a descendant.
    expect(() => assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus/db-backup`)).not.toThrow();
  });

  it("error messages clearly state which of the three problems was detected and show both resolved paths", () => {
    try {
      assertNoOverlap(`${repo}/eval-corpus/db`, `${repo}/eval-corpus`);
      expect.unreachable("expected assertNoOverlap to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(`${repo}/eval-corpus/db`);
      expect(message).toContain(`${repo}/eval-corpus`);
      expect(message).toContain("ANCESTOR");
    }
  });
});

describe("scrubSizeDb — copy-then-scrub, the full per-size operation", () => {
  it("produces a scrubbed COPY with zero pattern hits across every surface, leaving the ORIGINAL byte-identical", async () => {
    const dir = mkTmp("scrub-db-copy-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);
    const srcHashBefore = sha256File(srcPath);

    const dstPath = join(dir, "scrubbed", "monet.db");
    const stats = scrubSizeDb(srcPath, dstPath);
    expect(stats.concepts.conceptCount).toBe(3);
    expect(stats.concepts.observationCount).toBe(3);
    expect(stats.contradictions.contradictionCount).toBe(1);
    // >= 2, not exactly 2: buildFixtureDb's real store() calls also auto-populate entities via
    // the engine's own extraction (see the dedicated scrubEntities describe block's note above).
    expect(stats.entities.entityCount).toBeGreaterThanOrEqual(2);
    expect(stats.revisions.rowsDeleted).toBe(1);
    expect(stats.futureProofed.firstBlockCount).toBe(1);
    // 2, not 1: MonetCore auto-creates one session row per instance PLUS the manually-seeded one.
    expect(stats.futureProofed.sessionCount).toBe(2);

    // Direction 1: original is untouched — same file, same bytes, before and after.
    expect(existsSync(srcPath)).toBe(true);
    expect(sha256File(srcPath)).toBe(srcHashBefore);

    // Direction 2: the scrubbed copy has zero pattern hits — checked directly against the exact
    // seeded secret-shaped strings (not just "scrubString changed something"), across every
    // scrubbed column/table this round covers.
    const scrubbedDb = new Database(dstPath, { readonly: true });
    try {
      const concepts = scrubbedDb.prepare(`SELECT title, body, source_refs FROM concepts`).all() as Array<{
        title: string;
        body: string;
        source_refs: string | null;
      }>;
      const observations = scrubbedDb.prepare(`SELECT content FROM observations`).all() as Array<{ content: string }>;
      const contradictions = scrubbedDb.prepare(`SELECT detail FROM contradictions`).all() as Array<{ detail: string }>;
      const entities = scrubbedDb.prepare(`SELECT key, surface FROM entities`).all() as Array<{ key: string; surface: string }>;
      const firstBlock = scrubbedDb.prepare(`SELECT summary FROM first_block`).all() as Array<{ summary: string }>;
      const sessions = scrubbedDb.prepare(`SELECT summary, scope_context FROM sessions`).all() as Array<{
        summary: string;
        scope_context: string;
      }>;
      const revisionCount = (scrubbedDb.prepare(`SELECT COUNT(*) AS n FROM concept_revisions`).get() as { n: number }).n;

      const everything = [
        ...concepts.map((c) => `${c.title}\n${c.body}\n${c.source_refs ?? ""}`),
        ...observations.map((o) => o.content),
        ...contradictions.map((c) => c.detail),
        ...entities.map((e) => `${e.key}\n${e.surface}`),
        ...firstBlock.map((f) => f.summary),
        ...sessions.map((s) => `${s.summary}\n${s.scope_context}`),
      ].join("\n");

      expect(everything).not.toContain("jane.doe@example.com");
      expect(everything).not.toContain("/Users/dev/Documents");
      expect(everything).not.toContain("key_GZTqlLr41FS2p7AY");
      expect(everything).not.toContain("/Users/dev/.monet/monet.db");
      expect(everything).not.toContain("/Users/dev/.claude/CLAUDE.md");
      expect(everything).not.toContain("192.168.1.10");
      expect(everything).not.toContain("tenant acme");
      expect(everything).not.toContain("~/code");
      // The proof-repo path IS generalized (not redacted) by scrubString's own design (see
      // scrub-patterns.mjs's isProofRepoPath) — asserting the GENERALIZED form survives, and the
      // full /Users/dev prefix does not, exercises the real scrubString behavior rather than a
      // stricter blanket-redaction assumption this suite shouldn't impose.
      expect(everything).toContain("monet-core/src/engine.ts");
      expect(everything).not.toContain("/Users/dev/code/monet-core");
      expect(everything).toContain("[redacted-email]");
      expect(everything).toContain("[redacted-secret]");
      expect(everything).toContain("[redacted-private-endpoint]");

      expect(revisionCount).toBe(0);
    } finally {
      scrubbedDb.close();
    }
  });

  it("ships with no -wal/-shm sidecar (checkpointed to a single self-contained file)", async () => {
    const dir = mkTmp("scrub-db-wal-sidecar-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    expect(existsSync(dstPath)).toBe(true);
    expect(existsSync(`${dstPath}-wal`)).toBe(false);
    expect(existsSync(`${dstPath}-shm`)).toBe(false);
  });

  it("WAL fidelity: a source with pending uncheckpointed writes is still fully captured by the scrub", async () => {
    const dir = mkTmp("scrub-db-wal-pending-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);

    // Open the source again and write ONE MORE concept without an explicit checkpoint — simulates
    // a real derived db that still has committed-but-not-yet-checkpointed WAL frames at the moment
    // scrub-db.mjs runs (this pipeline's own WAL-mode dbs are left in exactly this state between
    // pipeline stages — verified directly against the real eval-corpus/db/<size>/monet.db files,
    // which carry a live -wal sidecar).
    const core2 = new MonetCore(srcPath);
    let extraConceptId: string;
    try {
      const r = await core2.store("A fourth concept, written after the fixture's own writer already closed.", {
        circle: SAMPLED_CIRCLE,
      });
      extraConceptId = r.conceptId!;
    } finally {
      core2.close(); // closes cleanly, but exercises the same WAL-mode file lifecycle a real pipeline run does
    }

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const dstDb = new Database(dstPath, { readonly: true });
    try {
      const row = dstDb.prepare(`SELECT id FROM concepts WHERE id = ?`).get(extraConceptId!);
      expect(row).toBeDefined(); // the 4th concept's write is present in the scrubbed copy
      const count = (dstDb.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n;
      expect(count).toBe(4);
    } finally {
      dstDb.close();
    }
  });

  it("round 3, F4 fix: the SOURCE file (main db + -wal/-shm sidecars) is COMPLETELY UNCHANGED after a scrub run, byte-for-byte", async () => {
    // This test would have FAILED against the OLD (round 2) code, which opened srcDbPath itself
    // read-write and ran wal_checkpoint(TRUNCATE) against it before copying — that TRUNCATEs the
    // -wal file to zero length and writes checkpointed frames into the main file, changing BOTH the
    // main file's hash AND the -wal file's presence/hash. This test's assertions specifically target
    // that: not just "still exists" but byte-identical, and specifically while a genuinely-pending
    // (uncheckpointed) WAL frame is on disk at the moment scrubSizeDb runs.
    //
    // IMPORTANT, verified empirically for this exact better-sqlite3 version (11.10.0), CONTRARY to
    // a natural assumption: closing a better-sqlite3 Database handle DOES force a WAL checkpoint by
    // default in this version (a scratch probe showed the -wal sidecar disappear the instant
    // `.close()` returns) — so a naive "open a second writer, write, close it, THEN capture hashes
    // and scrub" sequence would never actually exercise a pending-WAL state at all (the close would
    // have already checkpointed everything away). To genuinely reproduce pending, uncheckpointed
    // frames on disk at the moment scrub-db.mjs runs, this test keeps the second writer's
    // connection OPEN (never calls .close() on it) until AFTER scrubSizeDb has already run — a
    // second, independent better-sqlite3 connection opening the SAME file path concurrently (via
    // copyFileSync, not another Database handle) is exactly the situation scrubSizeDb's own
    // "at-rest, no concurrent writer" assumption is normally relying on being false-free; this test
    // deliberately violates that a little to prove the SOURCE survives regardless, then cleans up.
    const dir = mkTmp("scrub-db-source-untouched-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);

    const core2 = new MonetCore(srcPath);
    let pendingWriterClosed = false;
    try {
      await core2.store("A pending write, left uncheckpointed on disk while scrubSizeDb runs.", {
        circle: SAMPLED_CIRCLE,
      });

      // Confirm the fixture actually reproduces a genuinely-pending WAL state BEFORE scrubbing —
      // non-vacuity for this specific test, not assumed.
      expect(existsSync(`${srcPath}-wal`)).toBe(true);
      const walSizeBeforeScrub = readFileSync(`${srcPath}-wal`).length;
      expect(walSizeBeforeScrub).toBeGreaterThan(0);

      const srcHashBefore = sha256File(srcPath);
      const walHashBefore = sha256File(`${srcPath}-wal`);
      const shmExistedBefore = existsSync(`${srcPath}-shm`);
      const shmHashBefore = shmExistedBefore ? sha256File(`${srcPath}-shm`) : null;

      const dstPath = join(dir, "scrubbed", "monet.db");
      scrubSizeDb(srcPath, dstPath);

      // Direction 1: the main db file is byte-for-byte unchanged.
      expect(sha256File(srcPath)).toBe(srcHashBefore);
      // Direction 2: the -wal sidecar still EXISTS (round 2's TRUNCATE checkpoint against the
      // source would have truncated it to zero bytes / left it looking emptied) AND is
      // byte-for-byte unchanged — not merely "still present", since a stray write-open that didn't
      // delete the file could still have changed its contents.
      expect(existsSync(`${srcPath}-wal`)).toBe(true);
      expect(sha256File(`${srcPath}-wal`)).toBe(walHashBefore);
      // Direction 3: -shm sidecar, if it existed before, is likewise untouched.
      if (shmExistedBefore) {
        expect(existsSync(`${srcPath}-shm`)).toBe(true);
        expect(sha256File(`${srcPath}-shm`)).toBe(shmHashBefore);
      }

      // Sanity: the pending write WAS actually captured into the scrubbed output (proves this
      // isn't passing merely because scrubSizeDb silently dropped the pending data instead of
      // reading it) — same content-fidelity check the existing WAL-pending test above makes.
      const dstDb = new Database(dstPath, { readonly: true });
      try {
        const count = (dstDb.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n;
        expect(count).toBe(4); // 3 from buildFixtureDb + 1 pending write above
      } finally {
        dstDb.close();
      }
    } finally {
      core2.close();
      pendingWriterClosed = true;
    }
    expect(pendingWriterClosed).toBe(true);
  });

  it("is deterministic: running scrubSizeDb twice against the same source produces byte-identical output files", async () => {
    const dir = mkTmp("scrub-db-determinism-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);

    const dst1 = join(dir, "run1", "monet.db");
    const dst2 = join(dir, "run2", "monet.db");
    scrubSizeDb(srcPath, dst1);
    scrubSizeDb(srcPath, dst2);

    expect(sha256File(dst1)).toBe(sha256File(dst2));
    const sourceMeta = readSyncMeta(srcPath);
    expect(readSyncMeta(dst1)).toEqual({ device_id: sourceMeta.device_id, clock_mode: "wall" });
    expect(readSyncMeta(dst2)).toEqual({ device_id: sourceMeta.device_id, clock_mode: "wall" });
  });

  it("re-running scrubSizeDb against the SAME destination path overwrites cleanly (no stale mixed content)", async () => {
    const dir = mkTmp("scrub-db-rerun-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");

    scrubSizeDb(srcPath, dstPath);
    const firstHash = sha256File(dstPath);
    scrubSizeDb(srcPath, dstPath);
    const secondHash = sha256File(dstPath);

    expect(secondHash).toBe(firstHash);
    expect(readSyncMeta(dstPath)).toEqual({
      device_id: readSyncMeta(srcPath).device_id,
      clock_mode: "wall",
    });
  });

  it("removes a failed scrub output instead of leaving a logical-mode database", async () => {
    const dir = mkTmp("scrub-db-failed-clock-mode-");
    const srcPath = join(dir, "src-monet.db");
    const { conceptIds } = await buildFixtureDb(srcPath);
    const srcDb = new Database(srcPath);
    try {
      srcDb.prepare(`UPDATE concepts SET circle = 'wrong-scope' WHERE id = ?`).run(conceptIds[0]);
    } finally {
      srcDb.close();
    }
    const dstPath = join(dir, "scrubbed", "monet.db");

    expect(() => scrubSizeDb(srcPath, dstPath)).toThrow(/scope/i);
    expect(existsSync(dstPath)).toBe(false);
    expect(existsSync(`${dstPath}-wal`)).toBe(false);
    expect(existsSync(`${dstPath}-shm`)).toBe(false);
  });

  it("rejects pre-clock_mode v8 wall-clock triggers and removes every attempted output", async () => {
    const dir = mkTmp("scrub-db-legacy-v8-clock-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);
    const deviceId = downgradeToPreClockModeV8(srcPath);
    const probe = new Database(srcPath, { readonly: true });
    try {
      expect(probe.pragma("user_version", { simple: true })).toBe(8);
      expect((probe.prepare(`PRAGMA table_info(sync_meta)`).all() as Array<{ name: string }>).some(
        (column) => column.name === "clock_mode",
      )).toBe(false);
      expect((probe.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_concepts_update'`,
      ).get() as { sql: string }).sql).toContain("julianday('now')");
      expect((probe.prepare(`SELECT device_id FROM sync_meta WHERE singleton = 1`).get() as { device_id: string }).device_id).toBe(deviceId);
    } finally {
      probe.close();
    }

    for (const name of ["first", "second"]) {
      const dstPath = join(dir, name, "monet.db");
      expect(() => scrubSizeDb(srcPath, dstPath)).toThrow(/v8 sync clock is missing clock_mode/);
      expect(existsSync(dstPath)).toBe(false);
      expect(existsSync(`${dstPath}-wal`)).toBe(false);
      expect(existsSync(`${dstPath}-shm`)).toBe(false);
    }
  });

  it("a MonetCore opened on the scrubbed copy answers search()/gather() sanely, with sourceRefs parsing back to a clean array", async () => {
    const dir = mkTmp("scrub-db-search-");
    const srcPath = join(dir, "src-monet.db");
    const { conceptIds } = await buildFixtureDb(srcPath);
    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const core = new MonetCore(dstPath);
    try {
      const results = await core.search("storage backend", { circle: SAMPLED_CIRCLE });
      expect(results.length).toBeGreaterThan(0);
      // The non-sensitive concept (SQLite storage backend note) should be findable, and nothing
      // returned should surface the redacted secret/email/private-endpoint material — a search
      // result card should never accidentally resurrect the very content this pipeline exists to
      // remove.
      const serialized = JSON.stringify(results);
      expect(serialized).not.toContain("jane.doe@example.com");
      expect(serialized).not.toContain("key_GZTqlLr41FS2p7AY");
      expect(serialized).not.toContain("192.168.1.10");

      // gather() reads concepts.source_refs via countSourceRefs (engine.ts). A numeric count on the
      // card proves the engine-side JSON.parse still works against this JSON-aware-scrubbed column
      // (a raw unparsed string would throw there). The refs themselves are no longer carried on the
      // card, so assert their scrubbed CONTENT against the stored row.
      const gathered = await core.gather(conceptIds[0], { circle: SAMPLED_CIRCLE });
      const seedCard = gathered.seed.find((s) => s.id === conceptIds[0]);
      expect(seedCard).toBeDefined();
      const rankedOrSeed = gathered.ranked.find((r) => r.id === conceptIds[0]);
      if (rankedOrSeed) {
        expect(typeof rankedOrSeed.sourceRefsCount).toBe("number");
      }
      const scrubbedRow = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
        .prepare(`SELECT source_refs FROM concepts WHERE id = ?`)
        .get(conceptIds[0]) as { source_refs: string | null } | undefined;
      const scrubbedRefs = JSON.parse(scrubbedRow?.source_refs ?? "[]") as string[];
      const joined = scrubbedRefs.join(" ");
      expect(joined).not.toContain("/Users/dev");
      expect(joined).not.toContain("~/code");
      expect(scrubbedRefs.some((r) => r.startsWith("[redacted"))).toBe(true);
    } finally {
      core.close();
    }
  });

  it("preserves non-text structure: concept/observation row counts and embeddings unchanged by the copy-then-scrub operation", async () => {
    const dir = mkTmp("scrub-db-structure-");
    const srcPath = join(dir, "src-monet.db");
    await buildFixtureDb(srcPath);

    const srcDb = new Database(srcPath, { readonly: true });
    const srcEmbeddings = srcDb.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>;
    srcDb.close();

    const dstPath = join(dir, "scrubbed", "monet.db");
    scrubSizeDb(srcPath, dstPath);

    const dstDb = new Database(dstPath, { readonly: true });
    try {
      const dstEmbeddings = dstDb.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>;
      expect(dstEmbeddings).toEqual(srcEmbeddings);

      const conceptCount = (dstDb.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n;
      const obsCount = (dstDb.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number }).n;
      expect(conceptCount).toBe(3);
      expect(obsCount).toBe(3);
    } finally {
      dstDb.close();
    }
  });

  it("throws a clear error when the source db path does not exist", () => {
    const dir = mkTmp("scrub-db-missing-");
    const missingSrc = join(dir, "does-not-exist", "monet.db");
    const dstPath = join(dir, "out", "monet.db");
    expect(() => scrubSizeDb(missingSrc, dstPath)).toThrow();
  });
});

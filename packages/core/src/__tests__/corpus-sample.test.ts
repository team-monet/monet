/**
 * Phase 1 corpus derivation — subsampler tests (corpus-sample.ts).
 *
 * Covers the pure stratification/allocation/selection algorithms on hand-built fixtures (fast,
 * no real store needed) plus an end-to-end materializeSampledDb() round-trip against a small
 * in-memory-seeded real .db copy, asserting the self-contained-store contract: no dangling
 * memory_edge/observations/concept_entities references, and every concept re-circled to
 * SAMPLED_CIRCLE.
 *
 * Determinism (same source + same sampleSize → byte-identical selectedIds across calls) is
 * asserted directly here; the FULL pipeline byte-identical-file determinism check (spec's
 * "run the full derivation pipeline TWICE... must be byte-identical" requirement) was run
 * manually against the real corpus during implementation — this test asserts the underlying
 * selection primitive is deterministic, which is what makes that pipeline-level property hold.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  buildStrata,
  allocateQuotas,
  selectSample,
  materializeSampledDb,
  SAMPLED_CIRCLE,
  assertSafeToWipe,
  type StratumCell,
} from "../eval/corpus-sample";

describe("buildStrata — kind x recency-tercile bucketing", () => {
  it("splits a kind with >=3 members into three recency terciles, newest-first", () => {
    const rows = [
      { id: "a", kind: "fact", updated_at: 100 },
      { id: "b", kind: "fact", updated_at: 90 },
      { id: "c", kind: "fact", updated_at: 80 },
      { id: "d", kind: "fact", updated_at: 70 },
      { id: "e", kind: "fact", updated_at: 60 },
      { id: "f", kind: "fact", updated_at: 50 },
    ];
    const cells = buildStrata(rows);
    expect(cells).toHaveLength(3); // 6 members / 3 = exactly 2 per tercile
    expect(cells.map((c) => c.tercile)).toEqual([0, 1, 2]);
    expect(cells[0].memberIds).toEqual(["a", "b"]); // newest two
    expect(cells[2].memberIds).toEqual(["e", "f"]); // oldest two
  });

  it("puts a kind with <3 members entirely into tercile 0 (module doc's documented special case)", () => {
    const rows = [
      { id: "x", kind: "gotcha", updated_at: 10 },
      { id: "y", kind: "gotcha", updated_at: 5 },
    ];
    const cells = buildStrata(rows);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({ kind: "gotcha", tercile: 0, memberIds: ["x", "y"] });
  });

  it("orders cells deterministically by (kind, tercile) — never by input/insertion order", () => {
    const rows = [
      { id: "1", kind: "zeta", updated_at: 1 },
      { id: "2", kind: "alpha", updated_at: 1 },
      { id: "3", kind: "alpha", updated_at: 2 },
    ];
    const cells = buildStrata(rows);
    expect(cells.map((c) => c.kind)).toEqual(["alpha", "zeta"]); // alpha before zeta despite zeta appearing first in input
  });
});

describe("allocateQuotas — largest-remainder apportionment with undersized-cell fallback", () => {
  const cell = (kind: string, tercile: 0 | 1 | 2, n: number): StratumCell => ({
    kind,
    tercile,
    memberIds: Array.from({ length: n }, (_, i) => `${kind}-${tercile}-${i}`),
  });

  it("allocates proportionally and sums exactly to the target when capacity allows", () => {
    // 3 cells of equal size (10 each) sampling to 9 total: expect 3/3/3.
    const cells = [cell("a", 0, 10), cell("b", 0, 10), cell("c", 0, 10)];
    const quotas = allocateQuotas(cells, 9);
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(9);
    expect(quotas.get("a::0")).toBe(3);
    expect(quotas.get("b::0")).toBe(3);
    expect(quotas.get("c::0")).toBe(3);
  });

  it("distributes remainder slots to the largest fractional remainders (Hamilton method)", () => {
    // 3 equal cells of 10, target 10: raw share = 10/3 = 3.333 each → floor 3 each = 9, one
    // leftover slot goes to the cell with the largest remainder. All three have an IDENTICAL
    // remainder (0.333) here, so the tie-break (stable cellKey sort) decides — asserted by
    // total, not by WHICH cell wins the tie (implementation detail), since the tie-break itself
    // is just for stability/reproducibility, not a semantic requirement.
    const cells = [cell("a", 0, 10), cell("b", 0, 10), cell("c", 0, 10)];
    const quotas = allocateQuotas(cells, 10);
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(10);
    const vals = [...quotas.values()].sort();
    expect(vals).toEqual([3, 3, 4]); // one cell gets the extra slot
  });

  it("caps a cell at its member count and redistributes the shortfall to other cells (undersized-cell fallback)", () => {
    // A tiny cell (1 member) alongside a big one (99 members), target 50: the tiny cell can
    // contribute at most 1, so ~49 must come from the big cell instead of the proportional ~25.
    const cells = [cell("tiny", 0, 1), cell("big", 0, 99)];
    const quotas = allocateQuotas(cells, 50);
    expect(quotas.get("tiny::0")).toBe(1); // capped at its only member, not truncated to 0
    expect(quotas.get("big::0")).toBe(49); // absorbs the shortfall
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(50);
  });

  it("never allocates more than total available when sampleSize exceeds the full population", () => {
    const cells = [cell("a", 0, 3), cell("b", 0, 2)];
    const quotas = allocateQuotas(cells, 100); // way more than the 5 available
    expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(5); // capped at total available
    expect(quotas.get("a::0")).toBe(3);
    expect(quotas.get("b::0")).toBe(2);
  });

  it("handles many singleton/near-empty cells at a small sample size without infinite-looping (regression shape for sampleSize=25 with many size-1/2/3 kinds)", () => {
    // Mirrors the real corpus's shape at size=25: several kinds with only 1-3 total members
    // (gotcha=3, issue=3, procedure=3, user=1) alongside big kinds (fact=112, project=56).
    const cells = [
      cell("gotcha", 0, 1),
      cell("issue", 0, 1),
      cell("procedure", 0, 1),
      cell("user", 0, 1),
      cell("fact", 0, 40),
      cell("fact", 1, 40),
      cell("fact", 2, 32),
      cell("project", 0, 20),
      cell("project", 1, 20),
      cell("project", 2, 16),
    ];
    const quotas = allocateQuotas(cells, 25);
    const total = [...quotas.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(25);
    // Every cell's allocation must be <= its own capacity — the invariant the fallback loop guarantees.
    for (const c of cells) {
      const key = `${c.kind}::${c.tercile}`;
      expect(quotas.get(key)!).toBeLessThanOrEqual(c.memberIds.length);
    }
  });
});

describe("selectSample — determinism and proportional preservation", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `c${i}`,
    kind: i < 40 ? "fact" : "decision",
    updated_at: 1000 - i,
  }));

  it("is deterministic: repeated calls on identical input produce byte-identical selectedIds", () => {
    const a = selectSample(rows, 20);
    const b = selectSample(rows, 20);
    expect(a.selectedIds).toEqual(b.selectedIds);
  });

  it("achieves the requested size when capacity allows, and preserves kind proportions roughly", () => {
    const sel = selectSample(rows, 30);
    expect(sel.achievedSize).toBe(30);
    const factCount = sel.selectedIds.filter((id) => Number(id.slice(1)) < 40).length;
    // 40/60 = 2/3 of the population is "fact" — expect the sample to land close to 2/3 of 30 = 20,
    // not skewed to 0 or 30 (which would indicate the stratification collapsed to one kind).
    expect(factCount).toBeGreaterThan(10);
    expect(factCount).toBeLessThan(30);
  });

  it("caps achievedSize at the full population when sampleSize exceeds it", () => {
    const sel = selectSample(rows, 1000);
    expect(sel.achievedSize).toBe(60);
    expect(sel.selectedIds).toHaveLength(60);
  });

  it("returns ids in sorted order (a stable, inspectable contract)", () => {
    const sel = selectSample(rows, 15);
    const sorted = [...sel.selectedIds].sort();
    expect(sel.selectedIds).toEqual(sorted);
  });
});

// ── materializeSampledDb — self-contained-store contract on a small hand-built source db ──────

function buildFixtureSourceDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE concepts (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact', status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.6, circle TEXT NOT NULL DEFAULT 'default',
      embedding TEXT NOT NULL, support_count INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 0, usefulness_score INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source_refs TEXT, aliases TEXT, last_confirmed_at INTEGER, last_confirmed_session_id TEXT,
      usefulness_last_fetched_at INTEGER, arousal_score INTEGER NOT NULL DEFAULT 0, arousal_last_updated_at INTEGER
    );
    CREATE TABLE memory_edge (
      id TEXT PRIMARY KEY, src_id TEXT NOT NULL, src_type TEXT NOT NULL DEFAULT 'concept',
      dst_id TEXT NOT NULL, dst_type TEXT NOT NULL DEFAULT 'concept', type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.6, origin TEXT NOT NULL DEFAULT 'cheap', count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, last_reinforced_at INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'default',
      dismissed_at INTEGER, dismissed_by TEXT
    );
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'statement',
      circle TEXT NOT NULL DEFAULT 'default', concept_id TEXT, superseded_by TEXT, session_id TEXT,
      author_agent_id TEXT NOT NULL, created_at INTEGER NOT NULL, source_refs TEXT
    );
    CREATE TABLE concept_revisions (id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, trigger_observation_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE contradictions (id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, observation_id TEXT, kind TEXT NOT NULL DEFAULT 'value-conflict', status TEXT NOT NULL DEFAULT 'open', detail TEXT NOT NULL DEFAULT '', resolution_obs_id TEXT, detected_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT);
    CREATE TABLE entities (key TEXT NOT NULL, kind TEXT NOT NULL, surface TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default', df INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, scope));
    CREATE TABLE concept_entities (concept_id TEXT NOT NULL, entity_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default', PRIMARY KEY (concept_id, entity_key, scope));
  `);

  const insertConcept = db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, circle, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  );
  insertConcept.run("keep-1", "keep-1", "Kept concept 1", "Body 1", "fact", "proj-a", 100, 100);
  insertConcept.run("keep-2", "keep-2", "Kept concept 2", "Body 2", "fact", "proj-a", 100, 100);
  insertConcept.run("drop-3", "drop-3", "Dropped concept 3", "Body 3", "fact", "proj-a", 100, 100);

  // Edge fully inside the sample (both endpoints selected) — must survive.
  db.prepare(`INSERT INTO memory_edge (id, src_id, dst_id, type, created_at, last_reinforced_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "e1",
    "keep-1",
    "keep-2",
    "co_occurred",
    100,
    100,
    "proj-a",
  );
  // Edge with one endpoint (drop-3) NOT in the sample — must be dropped (dangling-reference guard).
  db.prepare(`INSERT INTO memory_edge (id, src_id, dst_id, type, created_at, last_reinforced_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "e2",
    "keep-1",
    "drop-3",
    "related",
    100,
    100,
    "proj-a",
  );

  // Observation attached to a kept concept — must survive.
  db.prepare(`INSERT INTO observations (id, content, embedding, circle, concept_id, author_agent_id, created_at) VALUES (?, ?, '[]', ?, ?, ?, ?)`).run(
    "o1",
    "obs for keep-1",
    "proj-a",
    "keep-1",
    "agent",
    100,
  );
  // Observation attached to the dropped concept — must NOT survive.
  db.prepare(`INSERT INTO observations (id, content, embedding, circle, concept_id, author_agent_id, created_at) VALUES (?, ?, '[]', ?, ?, ?, ?)`).run(
    "o2",
    "obs for drop-3",
    "proj-a",
    "drop-3",
    "agent",
    100,
  );

  // concept_entities: one for a kept concept, one for a dropped concept.
  db.prepare(`INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, ?, ?, ?, ?)`).run("path:x", "path", "x", "proj-a", 2);
  db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run("keep-1", "path:x", "proj-a");
  db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`).run("drop-3", "path:x", "proj-a");

  db.close();
}

describe("materializeSampledDb — self-contained-store contract", () => {
  it("re-circles selected concepts to SAMPLED_CIRCLE and drops every dependent row whose FK target didn't survive the selection", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-sample-test-"));
    try {
      const sourcePath = join(dir, "source.db");
      const outPath = join(dir, "sampled.db");
      buildFixtureSourceDb(sourcePath);

      const result = materializeSampledDb(sourcePath, outPath, ["keep-1", "keep-2"]);
      expect(result.conceptCount).toBe(2);
      expect(result.sourceCircleCounts).toEqual({ "proj-a": 2 });

      const dest = new Database(outPath, { readonly: true });
      try {
        const circles = dest.prepare(`SELECT DISTINCT circle FROM concepts`).all() as Array<{ circle: string }>;
        expect(circles).toEqual([{ circle: SAMPLED_CIRCLE }]);

        // e1 (both endpoints kept) survives; e2 (one endpoint dropped) does not.
        const edges = dest.prepare(`SELECT id FROM memory_edge ORDER BY id`).all() as Array<{ id: string }>;
        expect(edges).toEqual([{ id: "e1" }]);

        // o1 (kept concept) survives; o2 (dropped concept) does not.
        const obs = dest.prepare(`SELECT id FROM observations ORDER BY id`).all() as Array<{ id: string }>;
        expect(obs).toEqual([{ id: "o1" }]);

        // concept_entities: only keep-1's row survives.
        const ce = dest.prepare(`SELECT concept_id FROM concept_entities ORDER BY concept_id`).all() as Array<{ concept_id: string }>;
        expect(ce).toEqual([{ concept_id: "keep-1" }]);

        // entities.df is RECOMPUTED from the surviving concept_entities (1 surviving row → df=1),
        // never copied verbatim from the source's df=2 (which counted a since-dropped concept too).
        const entity = dest.prepare(`SELECT df FROM entities WHERE key = 'path:x'`).get() as { df: number };
        expect(entity.df).toBe(1);

        // Dropped-entirely tables (sessions/first_block/circle_aliases) are empty.
        const sessions = dest.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
        const firstBlock = dest.prepare(`SELECT COUNT(*) AS n FROM first_block`).get() as { n: number };
        expect(sessions.n).toBe(0);
        expect(firstBlock.n).toBe(0);
      } finally {
        dest.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertSafeToWipe — P2-a fix (round 2 review): destructive output-directory wipe guard", () => {
  // A fixed, fake repo root for every case below — never the real REPO_ROOT, so this suite can
  // assert exact expected/rejected paths without depending on where the test happens to run from.
  const REPO_ROOT = resolve("/fake/repo/root");
  const eval_corpus = (rel: string) => join(REPO_ROOT, "eval-corpus", rel);

  describe("direction 1 — legitimate derived-db locations are accepted (no throw)", () => {
    it("accepts the default output location (eval-corpus/db)", () => {
      expect(() => assertSafeToWipe(eval_corpus("db"), REPO_ROOT)).not.toThrow();
    });

    it("accepts an arbitrary strict descendant of eval-corpus/", () => {
      expect(() => assertSafeToWipe(eval_corpus("db/25"), REPO_ROOT)).not.toThrow();
      expect(() => assertSafeToWipe(eval_corpus("some/deeply/nested/custom/out"), REPO_ROOT)).not.toThrow();
    });
  });

  describe("direction 2 — dangerous/misconfigured --out values are refused (throw)", () => {
    it("refuses eval-corpus/ itself (the shared parent of source/db/md) — the review finding's own named example", () => {
      expect(() => assertSafeToWipe(eval_corpus(""), REPO_ROOT)).toThrow(/not a descendant/);
    });

    it("refuses the repo root (--out=.) — the review finding's own named example", () => {
      expect(() => assertSafeToWipe(REPO_ROOT, REPO_ROOT)).toThrow(/not a descendant/);
    });

    it("refuses a path that escapes eval-corpus/ via .. traversal", () => {
      expect(() => assertSafeToWipe(resolve(eval_corpus("db"), "..", "..", "elsewhere"), REPO_ROOT)).toThrow(/not a descendant/);
    });

    it("refuses an ancestor of the repo root entirely", () => {
      expect(() => assertSafeToWipe(resolve(REPO_ROOT, ".."), REPO_ROOT)).toThrow(/not a descendant/);
    });

    it("refuses a lookalike SIBLING directory (e.g. eval-corpus-backup) — proves this is a real path-containment check, not a string-prefix check", () => {
      const lookalike = join(REPO_ROOT, "eval-corpus-backup", "db");
      expect(() => assertSafeToWipe(lookalike, REPO_ROOT)).toThrow(/not a descendant/);
    });

    it("refuses an unrelated absolute path with no relation to the repo at all", () => {
      expect(() => assertSafeToWipe("/etc/important-system-directory", REPO_ROOT)).toThrow(/not a descendant/);
    });
  });
});

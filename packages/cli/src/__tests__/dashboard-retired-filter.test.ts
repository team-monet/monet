import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SQL } from "../dashboard/server.js";

// Runs the REAL query strings from server.ts against a seeded in-memory DB —
// mirrors the approach in dashboard-source-marker.test.ts (real queries, not a
// parallel reimplementation that could drift).
//
// Retired-exclusion default, aligned with the engine's own read convention:
// engine.ts filters `status != 'retired'` in 90+ read paths (e.g. listCircles
// at engine.ts:4536); the dashboard previously didn't filter retired concepts
// at all. Every SQL.* constant below now has an `xIncludeRetired` sibling that
// restores the pre-change, unfiltered query — the /api routes select between
// the pair based on the `includeRetired=1` query param. status='disputed' is a
// different value of the same column and must never be affected by this
// filter (John's ruling: disputed concepts stay visible always).

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE concepts (
      id TEXT PRIMARY KEY,
      slug TEXT, title TEXT, kind TEXT, status TEXT, confidence REAL, circle TEXT,
      support_count INTEGER, version INTEGER, dirty INTEGER, usefulness_score INTEGER,
      created_at INTEGER, updated_at INTEGER, last_confirmed_at INTEGER,
      source_refs TEXT, aliases TEXT, body TEXT,
      source_identity TEXT, active_observation_id TEXT
    );
    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      content TEXT, kind TEXT, circle TEXT, concept_id TEXT, session_id TEXT,
      author_agent_id TEXT, created_at INTEGER, source_refs TEXT
    );
    CREATE TABLE memory_edge (
      id TEXT PRIMARY KEY,
      src_id TEXT, dst_id TEXT, type TEXT, weight REAL, origin TEXT, count INTEGER,
      scope TEXT, created_at INTEGER, last_reinforced_at INTEGER, dismissed_at INTEGER
    );
    CREATE TABLE concept_entities (
      concept_id TEXT NOT NULL, entity_key TEXT NOT NULL, scope TEXT NOT NULL
    );
    CREATE TABLE entities (key TEXT);
    CREATE TABLE sessions (id TEXT);
    CREATE TABLE contradictions (id TEXT, status TEXT);
  `);
});

afterEach(() => {
  db.close();
});

function insertConcept(c: {
  id: string; status?: string; circle?: string; dirty?: number;
}, target = db) {
  target.prepare(`
    INSERT INTO concepts (id, slug, title, kind, status, confidence, circle, support_count,
      version, dirty, usefulness_score, created_at, updated_at)
    VALUES (@id, @id, @id, 'fact', @status, 0.8, @circle, 1, 0, @dirty, 0, 0, 0)
  `).run({
    id: c.id,
    status: c.status ?? "active",
    circle: c.circle ?? "default",
    dirty: c.dirty ?? 0,
  });
}

function insertEdge(e: { id: string; src_id: string; dst_id: string; type?: string; scope?: string; dismissed_at?: number | null }) {
  db.prepare(`
    INSERT INTO memory_edge (id, src_id, dst_id, type, weight, origin, count, scope, created_at, last_reinforced_at, dismissed_at)
    VALUES (@id, @src_id, @dst_id, @type, 1.0, 'test', 1, @scope, 0, 0, @dismissed_at)
  `).run({
    id: e.id, src_id: e.src_id, dst_id: e.dst_id,
    type: e.type ?? "related", scope: e.scope ?? "default",
    dismissed_at: e.dismissed_at ?? null,
  });
}

function insertEntityLink(l: { concept_id: string; entity_key: string; scope?: string }) {
  db.prepare(`INSERT INTO concept_entities (concept_id, entity_key, scope) VALUES (@concept_id, @entity_key, @scope)`)
    .run({ concept_id: l.concept_id, entity_key: l.entity_key, scope: l.scope ?? "default" });
}

function conceptIds(sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ id: string }>).map(r => r.id);
}
function edgeIds(sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ id: string }>).map(r => r.id);
}

describe("SQL.concepts — retired excluded by default", () => {
  it("excludes a retired concept, keeps active and disputed", () => {
    insertConcept({ id: "c-active" });
    insertConcept({ id: "c-disputed", status: "disputed" });
    insertConcept({ id: "c-retired", status: "retired" });
    expect(conceptIds(SQL.concepts).sort()).toEqual(["c-active", "c-disputed"]);
  });

  it("conceptsIncludeRetired restores the retired row", () => {
    insertConcept({ id: "c-active" });
    insertConcept({ id: "c-retired", status: "retired" });
    expect(conceptIds(SQL.conceptsIncludeRetired).sort()).toEqual(["c-active", "c-retired"]);
  });
});

describe("SQL.edges — retired-endpoint edges dropped by default (no dangling endpoints)", () => {
  it("excludes an edge whose src is retired", () => {
    insertConcept({ id: "a", status: "retired" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds(SQL.edges)).toEqual([]);
  });

  it("excludes an edge whose dst is retired", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "retired" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds(SQL.edges)).toEqual([]);
  });

  it("keeps an edge between two non-retired concepts (disputed included)", () => {
    insertConcept({ id: "a", status: "disputed" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds(SQL.edges)).toEqual(["e1"]);
  });

  it("still excludes dismissed edges regardless of endpoint status (pre-existing, orthogonal behavior)", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b", dismissed_at: 123 });
    expect(edgeIds(SQL.edges)).toEqual([]);
  });

  it("edgesIncludeRetired restores edges with a retired endpoint", () => {
    insertConcept({ id: "a", status: "retired" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds(SQL.edgesIncludeRetired)).toEqual(["e1"]);
  });
});

describe("SQL.counts — retired exclusion on concepts/dirty/possibleDuplicatePairs/edgesLive, disputed untouched", () => {
  function counts(sql: string) {
    return db.prepare(sql).get() as Record<string, number>;
  }

  it("concepts total excludes retired by default, includes disputed", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "disputed" });
    insertConcept({ id: "c", status: "retired" });
    expect(counts(SQL.counts).concepts).toBe(2);
    expect(counts(SQL.countsIncludeRetired).concepts).toBe(3);
  });

  it("disputed count is unaffected by the retired filter (mutually exclusive status values)", () => {
    insertConcept({ id: "a", status: "disputed" });
    insertConcept({ id: "b", status: "retired" });
    expect(counts(SQL.counts).disputed).toBe(1);
    expect(counts(SQL.countsIncludeRetired).disputed).toBe(1);
  });

  it("dirty excludes a dirty-but-retired concept by default", () => {
    insertConcept({ id: "a", dirty: 1 });
    insertConcept({ id: "b", dirty: 1, status: "retired" });
    expect(counts(SQL.counts).dirty).toBe(1);
    expect(counts(SQL.countsIncludeRetired).dirty).toBe(2);
  });

  it("possibleDuplicatePairs drops a pair with a retired endpoint by default", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "retired" });
    insertConcept({ id: "c" });
    insertConcept({ id: "d" });
    insertEdge({ id: "dup1", src_id: "a", dst_id: "b", type: "possible_duplicate_of" });
    insertEdge({ id: "dup2", src_id: "c", dst_id: "d", type: "possible_duplicate_of" });
    expect(counts(SQL.counts).possibleDuplicatePairs).toBe(1);
    expect(counts(SQL.countsIncludeRetired).possibleDuplicatePairs).toBe(2);
  });

  it("edgesLive drops an edge with a retired endpoint by default, matching SQL.edges", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "retired" });
    insertConcept({ id: "c" });
    insertConcept({ id: "d" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    insertEdge({ id: "e2", src_id: "c", dst_id: "d" });
    expect(counts(SQL.counts).edgesLive).toBe(1);
    expect(counts(SQL.countsIncludeRetired).edgesLive).toBe(2);
  });
});

describe("SQL.circleConcepts — a circle with every concept retired drops out entirely", () => {
  function circleRows(sql: string) {
    return db.prepare(sql).all() as Array<{ name: string; conceptCount: number }>;
  }

  it("omits a circle whose concepts are all retired (no zero-count row emitted)", () => {
    insertConcept({ id: "a", circle: "alive-circle" });
    insertConcept({ id: "b", circle: "dead-circle", status: "retired" });
    const rows = circleRows(SQL.circleConcepts);
    expect(rows.map(r => r.name).sort()).toEqual(["alive-circle"]);
  });

  it("circleConceptsIncludeRetired restores the all-retired circle", () => {
    insertConcept({ id: "a", circle: "alive-circle" });
    insertConcept({ id: "b", circle: "dead-circle", status: "retired" });
    const rows = circleRows(SQL.circleConceptsIncludeRetired);
    expect(rows.map(r => r.name).sort()).toEqual(["alive-circle", "dead-circle"]);
  });

  it("keeps a circle with a mix of active/disputed/retired, counting only the non-retired rows", () => {
    insertConcept({ id: "a", circle: "mixed" });
    insertConcept({ id: "b", circle: "mixed", status: "disputed" });
    insertConcept({ id: "c", circle: "mixed", status: "retired" });
    const rows = circleRows(SQL.circleConcepts);
    expect(rows).toEqual([{ name: "mixed", conceptCount: 2 }]);
  });
});

describe("SQL.circleEdges — retired-endpoint edges excluded from the per-circle count", () => {
  function circleEdgeRows(sql: string) {
    return db.prepare(sql).all() as Array<{ scope: string; edgeCount: number }>;
  }

  it("drops an edge whose endpoint is retired from its scope's count", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "retired" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b", scope: "circle-x" });
    expect(circleEdgeRows(SQL.circleEdges)).toEqual([]);
    expect(circleEdgeRows(SQL.circleEdgesIncludeRetired)).toEqual([{ scope: "circle-x", edgeCount: 1 }]);
  });
});

describe("SQL.health — avgConfidence/graphDensity computed over non-retired concepts by default", () => {
  function health(sql: string) {
    return db.prepare(sql).get() as { avgConfidence: number | null; graphDensity: number | null };
  }

  it("excludes a retired concept's confidence from the average", () => {
    db.prepare(`
      INSERT INTO concepts (id, slug, title, kind, status, confidence, circle, support_count, version, dirty, usefulness_score, created_at, updated_at)
      VALUES ('a','a','a','fact','active',1.0,'default',1,0,0,0,0,0)
    `).run();
    db.prepare(`
      INSERT INTO concepts (id, slug, title, kind, status, confidence, circle, support_count, version, dirty, usefulness_score, created_at, updated_at)
      VALUES ('b','b','b','fact','retired',0.0,'default',1,0,0,0,0,0)
    `).run();
    expect(health(SQL.health).avgConfidence).toBe(1.0);
    expect(health(SQL.healthIncludeRetired).avgConfidence).toBe(0.5);
  });
});

describe("SQL.entityLinks — links to a retired concept excluded by default", () => {
  function links(sql: string) {
    return db.prepare(sql).all() as Array<{ concept_id: string; entity_key: string; scope: string }>;
  }

  it("drops a link whose concept is retired", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", status: "retired" });
    insertEntityLink({ concept_id: "a", entity_key: "k1" });
    insertEntityLink({ concept_id: "b", entity_key: "k1" });
    expect(links(SQL.entityLinks).map(l => l.concept_id)).toEqual(["a"]);
    expect(links(SQL.entityLinksIncludeRetired).map(l => l.concept_id).sort()).toEqual(["a", "b"]);
  });
});

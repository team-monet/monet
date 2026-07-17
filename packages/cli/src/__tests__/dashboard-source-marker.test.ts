import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SQL, conceptsHasSourceColumns } from "../dashboard/server.js";

// Runs the REAL query strings from server.ts (SQL.concepts / SQL.observations /
// SQL.edges / SQL.counts) against a seeded in-memory DB, rather than a parallel
// reimplementation of the marker-union logic — a reimplementation could drift
// from the actual queries and give false confidence.
//
// Per John's no-hiding ruling, SQL.concepts/observations/edges no longer filter
// out source rows (see SOURCE_MARKER's doc comment in server.ts for the full
// rationale, including the interim/engine-reshape context). This file used to
// be dashboard-source-exclusion.test.ts and asserted the opposite of what it
// asserts now — it locks in that source rows come BACK from these queries, not
// that they're excluded. The one place the marker union still filters is
// SQL.counts.sourceConcepts, which powers the honest header split ("N concepts
// · M from sources"); those tests are kept/repurposed below rather than dropped.
//
// Marker union under test (established rule from the engine's cold audit):
// a concept is "source" content if kind='source' OR source_identity IS NOT NULL
// OR active_observation_id IS NOT NULL — kind alone is not a reliable signal,
// so each marker is exercised independently below.

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  // Minimal schema: the columns SQL.concepts/observations/edges touch, plus
  // empty entities/sessions/contradictions tables so the real SQL.counts
  // string (which sub-selects across all of them) runs unmodified.
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
    CREATE TABLE entities (key TEXT);
    CREATE TABLE sessions (id TEXT);
    CREATE TABLE contradictions (id TEXT, status TEXT);
  `);
});

afterEach(() => {
  db.close();
});

function insertConcept(c: Partial<{
  id: string; kind: string; source_identity: string | null; active_observation_id: string | null;
}>) {
  db.prepare(`
    INSERT INTO concepts (id, slug, title, kind, status, confidence, circle, support_count,
      version, dirty, usefulness_score, created_at, updated_at, source_identity, active_observation_id)
    VALUES (@id, @id, @id, @kind, 'active', 0.8, 'default', 1, 0, 0, 0, 0, 0, @source_identity, @active_observation_id)
  `).run({
    id: c.id,
    kind: c.kind ?? "fact",
    source_identity: c.source_identity ?? null,
    active_observation_id: c.active_observation_id ?? null,
  });
}

function insertObservation(o: { id: string; kind?: string; concept_id?: string | null }) {
  db.prepare(`
    INSERT INTO observations (id, content, kind, circle, concept_id, session_id, author_agent_id, created_at)
    VALUES (@id, 'text', @kind, 'default', @concept_id, 's1', 'agent', 0)
  `).run({ id: o.id, kind: o.kind ?? "statement", concept_id: o.concept_id ?? null });
}

function insertEdge(e: { id: string; src_id: string; dst_id: string; dismissed_at?: number | null }) {
  db.prepare(`
    INSERT INTO memory_edge (id, src_id, dst_id, type, weight, origin, count, scope, created_at, last_reinforced_at, dismissed_at)
    VALUES (@id, @src_id, @dst_id, 'related', 1.0, 'test', 1, 'default', 0, 0, @dismissed_at)
  `).run({ id: e.id, src_id: e.src_id, dst_id: e.dst_id, dismissed_at: e.dismissed_at ?? null });
}

function conceptIds(): string[] {
  return (db.prepare(SQL.concepts).all() as Array<{ id: string }>).map(r => r.id);
}
function observationIds(): string[] {
  return (db.prepare(SQL.observations).all() as Array<{ id: string }>).map(r => r.id);
}
function edgeIds(): string[] {
  return (db.prepare(SQL.edges).all() as Array<{ id: string }>).map(r => r.id);
}
function counts(): { concepts: number; sourceConcepts: number } {
  return db.prepare(SQL.counts).get() as { concepts: number; sourceConcepts: number };
}

describe("SQL.concepts — no-hiding ruling: source rows are first-class", () => {
  it("includes a normal concept with no source markers", () => {
    insertConcept({ id: "c-native" });
    expect(conceptIds()).toEqual(["c-native"]);
  });

  it("includes a concept classified by kind alone", () => {
    insertConcept({ id: "c-kind", kind: "source" });
    expect(conceptIds()).toEqual(["c-kind"]);
  });

  it("includes a concept classified by source_identity alone (kind != 'source')", () => {
    insertConcept({ id: "c-identity", kind: "fact", source_identity: "vault://note.md#3" });
    expect(conceptIds()).toEqual(["c-identity"]);
  });

  it("includes a concept classified by active_observation_id alone (kind != 'source')", () => {
    insertConcept({ id: "c-active-obs", kind: "fact", active_observation_id: "obs-1" });
    expect(conceptIds()).toEqual(["c-active-obs"]);
  });

  it("does NOT filter source rows out of a mixed set — locks in the no-hiding ruling", () => {
    // A prior version of this suite asserted the opposite here (source rows
    // excluded); this is the deliberate reversal that locks in John's ruling
    // that source rows must not be filtered out of SQL.concepts.
    insertConcept({ id: "native-1" });
    insertConcept({ id: "native-2", kind: "decision" });
    insertConcept({ id: "source-1", kind: "source" });
    insertConcept({ id: "source-2", kind: "fact", source_identity: "x" });
    insertConcept({ id: "source-3", kind: "fact", active_observation_id: "y" });
    expect(conceptIds().sort()).toEqual(
      ["native-1", "native-2", "source-1", "source-2", "source-3"].sort()
    );
  });
});

describe("SQL.observations — includes observations belonging to source concepts", () => {
  it("includes an observation linked to a native concept", () => {
    insertConcept({ id: "c1" });
    insertObservation({ id: "o1", concept_id: "c1" });
    expect(observationIds()).toEqual(["o1"]);
  });

  it("includes an observation whose own kind is 'source'", () => {
    insertConcept({ id: "c1" });
    insertObservation({ id: "o1", kind: "source", concept_id: "c1" });
    expect(observationIds()).toEqual(["o1"]);
  });

  it("includes an observation linked to a source concept via concept_id", () => {
    // Previously the join-based half of the exclusion: the observation row
    // itself carries no source_identity/active_observation_id (only concepts
    // do), so it was resolved through its parent concept. That NOT EXISTS
    // join is gone; the observation comes back regardless of its parent.
    insertConcept({ id: "c-source", kind: "fact", source_identity: "vault://x" });
    insertObservation({ id: "o1", kind: "statement", concept_id: "c-source" });
    expect(observationIds()).toEqual(["o1"]);
  });

  it("includes an orphaned observation (NULL concept_id)", () => {
    insertObservation({ id: "o1", concept_id: null });
    expect(observationIds()).toEqual(["o1"]);
  });
});

describe("SQL.edges — no longer excludes edges touching a source concept", () => {
  it("includes an edge between two native concepts", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds()).toEqual(["e1"]);
  });

  it("includes an edge whose src is a source concept", () => {
    insertConcept({ id: "a", kind: "source" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds()).toEqual(["e1"]);
  });

  it("includes an edge whose dst is a source concept (classified by active_observation_id, not kind)", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b", kind: "fact", active_observation_id: "obs-9" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b" });
    expect(edgeIds()).toEqual(["e1"]);
  });

  it("still excludes dismissed edges (pre-existing behavior, unrelated to source visibility)", () => {
    insertConcept({ id: "a" });
    insertConcept({ id: "b" });
    insertEdge({ id: "e1", src_id: "a", dst_id: "b", dismissed_at: 12345 });
    expect(edgeIds()).toEqual([]);
  });
});

describe("SQL.counts.sourceConcepts — honest header split via the marker union", () => {
  // SOURCE_MARKER's one remaining consumer. These tests are what the original
  // SQL.concepts marker-union tests effectively become once filtering moves
  // from "which rows come back" to "how the total is disclosed."
  it("counts a concept classified by kind alone", () => {
    insertConcept({ id: "c-kind", kind: "source" });
    const row = counts();
    expect(row.concepts).toBe(1);
    expect(row.sourceConcepts).toBe(1);
  });

  it("counts a concept classified by source_identity alone (kind != 'source') — never kind alone", () => {
    insertConcept({ id: "c-identity", kind: "fact", source_identity: "vault://note.md#3" });
    expect(counts().sourceConcepts).toBe(1);
  });

  it("counts a concept classified by active_observation_id alone (kind != 'source') — never kind alone", () => {
    insertConcept({ id: "c-active-obs", kind: "fact", active_observation_id: "obs-1" });
    expect(counts().sourceConcepts).toBe(1);
  });

  it("does not count a native concept with no markers", () => {
    insertConcept({ id: "c-native" });
    expect(counts().sourceConcepts).toBe(0);
  });

  it("splits a mixed set correctly: total includes everyone, sourceConcepts only the marked rows", () => {
    insertConcept({ id: "native-1" });
    insertConcept({ id: "native-2", kind: "decision" });
    insertConcept({ id: "source-1", kind: "source" });
    insertConcept({ id: "source-2", kind: "fact", source_identity: "x" });
    insertConcept({ id: "source-3", kind: "fact", active_observation_id: "y" });
    const row = counts();
    expect(row.concepts).toBe(5);
    expect(row.sourceConcepts).toBe(3);
  });
});

describe("conceptsHasSourceColumns — full (modern) schema", () => {
  it("returns true when both source_identity and active_observation_id are present", () => {
    // Reuses the shared full-schema `db` from the outer beforeEach.
    expect(conceptsHasSourceColumns(db)).toBe(true);
  });
});

// Review finding: SQL.counts unconditionally references c.source_identity /
// c.active_observation_id via SOURCE_MARKER. Stores created before the
// source-ingestion schema migration don't have those two columns, so that
// query throws "no such column" -- which was taking down /api/graph entirely
// (a 500, so the whole dashboard fails to load) for any such store. This
// block seeds a genuinely legacy-shaped concepts table (everything else
// SQL.counts/countsLegacy touch is present; only source_identity and
// active_observation_id are absent) against a SEPARATE db fixture, since the
// suites above all assume the full/modern schema.
describe("SQL.countsLegacy — legacy-schema stores (no source-ingestion columns)", () => {
  let legacyDb: InstanceType<typeof Database>;

  beforeEach(() => {
    legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY,
        slug TEXT, title TEXT, kind TEXT, status TEXT, confidence REAL, circle TEXT,
        support_count INTEGER, version INTEGER, dirty INTEGER, usefulness_score INTEGER,
        created_at INTEGER, updated_at INTEGER, last_confirmed_at INTEGER,
        source_refs TEXT, aliases TEXT, body TEXT
      );
      CREATE TABLE observations (id TEXT PRIMARY KEY);
      CREATE TABLE memory_edge (id TEXT PRIMARY KEY, type TEXT, dismissed_at INTEGER);
      CREATE TABLE entities (key TEXT);
      CREATE TABLE sessions (id TEXT);
      CREATE TABLE contradictions (id TEXT, status TEXT);
    `);
  });

  afterEach(() => {
    legacyDb.close();
  });

  function insertLegacyConcept(c: { id: string; kind?: string; status?: string; dirty?: number }) {
    legacyDb.prepare(`
      INSERT INTO concepts (id, slug, title, kind, status, confidence, circle, support_count,
        version, dirty, usefulness_score, created_at, updated_at)
      VALUES (@id, @id, @id, @kind, @status, 0.8, 'default', 1, 0, @dirty, 0, 0, 0)
    `).run({
      id: c.id,
      kind: c.kind ?? "fact",
      status: c.status ?? "active",
      dirty: c.dirty ?? 0,
    });
  }

  it("conceptsHasSourceColumns returns false on a legacy-schema store", () => {
    expect(conceptsHasSourceColumns(legacyDb)).toBe(false);
  });

  it("SQL.counts throws on a legacy-schema store -- the exact bug this fallback exists for", () => {
    insertLegacyConcept({ id: "c1" });
    expect(() => legacyDb.prepare(SQL.counts).get()).toThrow(/no such column/i);
  });

  it("SQL.countsLegacy runs on a legacy-schema store and falls back to a kind-only sourceConcepts count", () => {
    insertLegacyConcept({ id: "native-1", kind: "fact" });
    insertLegacyConcept({ id: "native-2", kind: "decision" });
    insertLegacyConcept({ id: "source-1", kind: "source" });
    const row = legacyDb.prepare(SQL.countsLegacy).get() as { concepts: number; sourceConcepts: number };
    expect(row.concepts).toBe(3);
    expect(row.sourceConcepts).toBe(1);
  });

  it("SQL.countsLegacy still computes the other aggregate fields correctly (dirty/disputed/edges)", () => {
    insertLegacyConcept({ id: "c1", status: "disputed", dirty: 1 });
    insertLegacyConcept({ id: "c2" });
    const row = legacyDb.prepare(SQL.countsLegacy).get() as Record<string, number>;
    expect(row.concepts).toBe(2);
    expect(row.disputed).toBe(1);
    expect(row.dirty).toBe(1);
    expect(row.observations).toBe(0);
    expect(row.edgesLive).toBe(0);
  });
});

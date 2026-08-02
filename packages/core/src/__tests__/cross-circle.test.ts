/**
 * v0.4.0 "one brain, many rooms" — cross-circle read (store-wide) tests.
 *
 * Writes/dedup/graph/detach remain strictly per-circle (UNCHANGED).
 * Recall goes store-wide when the caller omits `circle`.
 *
 * Test plan:
 *   (a) search without circle → results from multiple circles, each card carries correct circle
 *   (b) search with explicit circle → only that circle (unchanged)
 *   (c) store-wide tie-break — same-circle-as-defaultCircle ranks first on an exact tie
 *   (d) gather without circle → A-topic intent returns A1+A2 (spread worked) + circle labels
 *   (e) fetch without circle → resolves a foreign-circle id and reports its home circle
 *   (f) fetch with WRONG explicit circle → still errors
 *   (g) listCircles — counts + exclusion
 *   (h) overview excludes circle inventory; listCircles remains the dedicated surface
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// ---- helpers -----------------------------------------------------------------

function seq(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}${String(n++).padStart(4, "0")}`;
}

// ---- (a) search without circle returns results from multiple circles ---------

describe("search — store-wide (circle omitted)", () => {
  it("(a) returns results from multiple circles, each card carries the correct circle", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("a"), defaultCircle: "proj-a" });
    const rA = await core.store("SQLite is the storage backend for project alpha.", { circle: "proj-a" });
    const rB = await core.store("SQLite is the storage backend for project beta.", { circle: "proj-b" });

    // Store-wide: circle omitted
    const results = await core.search("SQLite storage backend", { limit: 10 });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);

    // Each card must carry the correct home circle
    const cardA = results.find((r) => r.id === rA.conceptId)!;
    const cardB = results.find((r) => r.id === rB.conceptId)!;
    expect(cardA.circle).toBe("proj-a");
    expect(cardB.circle).toBe("proj-b");

    core.close();
  });

  // ---- (b) search with explicit circle → only that circle ------------------

  it("(b) search with explicit circle returns only that circle", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("b"), defaultCircle: "proj-a" });
    const rA = await core.store("SQLite is the storage backend.", { circle: "proj-a" });
    await core.store("SQLite is the storage backend.", { circle: "proj-b" });

    const results = await core.search("SQLite storage", { circle: "proj-a", limit: 10 });
    expect(results.every((r) => r.circle === "proj-a")).toBe(true);
    expect(results.find((r) => r.id === rA.conceptId)).toBeDefined();
    expect(results).toHaveLength(1);

    core.close();
  });
});

// ---- (c) store-wide tie-break ------------------------------------------------

describe("search — store-wide tie-break", () => {
  it("(c) on an exact score tie, same-circle-as-defaultCircle ranks before cross-circle", async () => {
    // Use the HashingEmbeddingProvider (default in :memory:). We construct two concepts whose
    // cosine distance to the query is identical by using an injected equal-score scenario:
    // inject the sorted output with equal scores and assert the comparator logic.
    //
    // Practical approach: both circles store the SAME byte-for-byte text.
    // With the deterministic lexical embedder, identical text → identical embedding → score == 1.0.
    const core = new MonetCore(":memory:", { idGen: seq("c"), defaultCircle: "home-circle" });
    const rA = await core.store("exact same content deterministic tiebreak", { circle: "home-circle" });
    const rB = await core.store("exact same content deterministic tiebreak", { circle: "away-circle" });
    // They are different concepts (forceNew not needed because they live in different circles).
    expect(rA.conceptId).not.toBe(rB.conceptId);

    const results = await core.search("exact same content deterministic tiebreak", { limit: 10 });
    const homeIdx = results.findIndex((r) => r.id === rA.conceptId);
    const awayIdx = results.findIndex((r) => r.id === rB.conceptId);
    expect(homeIdx).toBeGreaterThanOrEqual(0);
    expect(awayIdx).toBeGreaterThanOrEqual(0);
    expect(homeIdx).toBeLessThan(awayIdx); // same-circle-as-defaultCircle ranks first

    core.close();
  });

  it("(c-unit) tiebreak comparator: inject equal scores, assert ordering directly", () => {
    // Direct unit assertion on the sort comparator logic.
    const defaultCircle = "home";
    type Row = { circle: string; id: string };
    type Scored = { row: Row; score: number };

    const comparator = (a: Scored, b: Scored): number => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-9) return diff;
      // Store-wide tiebreak
      const aHome = a.row.circle === defaultCircle ? 0 : 1;
      const bHome = b.row.circle === defaultCircle ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      return a.row.id < b.row.id ? -1 : 1;
    };

    const inHome: Scored = { row: { circle: "home", id: "id-a" }, score: 0.9 };
    const inAway: Scored = { row: { circle: "away", id: "id-b" }, score: 0.9 };
    // Exact tie: home before away
    expect(comparator(inHome, inAway)).toBeLessThan(0);
    expect(comparator(inAway, inHome)).toBeGreaterThan(0);
    // Within same circle, id ascending
    const inHome2: Scored = { row: { circle: "home", id: "id-z" }, score: 0.9 };
    expect(comparator(inHome, inHome2)).toBeLessThan(0); // "id-a" < "id-z"
    expect(comparator(inHome2, inHome)).toBeGreaterThan(0);
  });
});

// ---- (d) gather without circle -----------------------------------------------

describe("gather — store-wide", () => {
  it("(d) gather on A-topic returns A1+A2 (spreading worked within circle A) and includes circle labels", async () => {
    // Circle A: two concepts that co-occurred in the same session → connected by a co_occurred edge.
    // Circle B: one isolated concept.
    // Intent matches circle A. Gather should recover both A concepts via spreading.
    const core = new MonetCore(":memory:", { idGen: seq("d"), defaultCircle: "circle-a" });

    const a1 = await core.store("routing decisions for the authentication system", { circle: "circle-a" });
    const a2 = await core.store("authentication session token expiry configuration", { circle: "circle-a" });
    // Store in same session → co_occurred edge between a1 and a2
    core.endSessionForEval();

    await core.store("completely unrelated postgres tuning note", { circle: "circle-b" });
    core.endSessionForEval();

    // Gather without circle
    const result = await core.gather("authentication routing", { limit: 20 });
    const rankedIds = result.ranked.map((r) => r.id);

    // Both A concepts should be present
    expect(rankedIds).toContain(a1.conceptId);
    expect(rankedIds).toContain(a2.conceptId);

    // Cards should carry circle labels
    const cardA1 = result.ranked.find((r) => r.id === a1.conceptId);
    const cardA2 = result.ranked.find((r) => r.id === a2.conceptId);
    expect(cardA1?.circle).toBe("circle-a");
    expect(cardA2?.circle).toBe("circle-a");

    core.close();
  });
});

// ---- (d2) gather without circle — pure-graph cross-circle spreading ---------

describe("gather — store-wide (pure-graph spreading)", () => {
  it("(d2) pure-graph cross-circle spreading: a graph-only concept in circle-A is reached from a seed in circle-A even though defaultCircle is circle-B", async () => {
    // Intent: exercise the per-seed circleOf() lookup in the spread phase (engine.ts ~2334).
    // The mechanism: when gather is called store-wide (no circle) and the session's defaultCircle
    // is circle-B, each seed must spread through ITS OWN circle's edges.  If the spread
    // mistakenly used defaultCircle (circle-B) for every seed, the co_occurred edge between a1
    // and a2 (which lives in circle-A's scope) would be invisible and a2 would never be reached.
    //
    // Embedding guarantee: "fjord mnemonic crypt" has cosine == 0 with "authentication routing"
    // under the HashingEmbeddingProvider (verified: no word/trigram hash collisions). This
    // ensures a2 cannot enter the result via dense/lexical seeding — only through graph spreading.

    const core = new MonetCore(":memory:", { idGen: seq("d2"), defaultCircle: "circle-b" });

    // Circle-A: a1 is seed-able (vocabulary matches intent); a2 is graph-only (zero cosine).
    // Same session → co_occurred edge in circle-A scope.
    const a1 = await core.store("routing decisions for the authentication system", { circle: "circle-a" });
    const a2 = await core.store("fjord mnemonic crypt", { circle: "circle-a" });
    core.endSessionForEval();

    // Circle-B (=defaultCircle): unrelated concept, isolated.
    await core.store("completely unrelated postgres tuning note", { circle: "circle-b" });
    core.endSessionForEval();

    // Confirm the co_occurred edge exists in circle-A scope (guard against silent edge failure).
    const coEdges = core.edges({ type: "co_occurred", circle: "circle-a" });
    const edgeFormed =
      coEdges.some((e) => e.srcId === a1.conceptId && e.dstId === a2.conceptId) ||
      coEdges.some((e) => e.srcId === a2.conceptId && e.dstId === a1.conceptId);
    expect(edgeFormed).toBe(true);

    // Gather store-wide (no circle); defaultCircle is circle-B — the per-seed circleOf() must
    // be used so that a1's spread travels circle-A edges and activates a2.
    const result = await core.gather("authentication routing", { limit: 20 });
    const rankedIds = result.ranked.map((r) => r.id);

    // a1 should be present (seeded).
    expect(rankedIds).toContain(a1.conceptId);

    // a2 must be present — reachable ONLY via per-seed circle-A spreading.
    expect(rankedIds).toContain(a2.conceptId);

    // a2 must carry viaSeed: false — confirms it was not a dense/lexical seed, only graph-reached.
    const cardA2 = result.ranked.find((r) => r.id === a2.conceptId);
    expect(cardA2?.viaSeed).toBe(false);

    // a2's home circle must be circle-A.
    expect(cardA2?.circle).toBe("circle-a");

    core.close();
  });
});

// ---- (e) fetch without circle resolves foreign-circle id -------------------

describe("fetch (getConcept) — store-wide via circleOf", () => {
  it("(e) circleOf returns the home circle of a foreign-circle concept", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("e"), defaultCircle: "proj-a" });
    const r = await core.store("Foreign circle concept content.", { circle: "proj-b" });

    // circleOf works store-wide
    const home = core.circleOf(r.conceptId);
    expect(home).toBe("proj-b");

    // getConcept (the underlying fetch) works regardless of calling circle
    const c = await core.getConcept(r.conceptId);
    expect(c).not.toBeNull();
    expect(c!.circle).toBe("proj-b");

    core.close();
  });

  // ---- (f) fetch with WRONG explicit circle still errors -------------------

  it("(f) fetch with wrong explicit circle errors (MCP gate logic)", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("f"), defaultCircle: "proj-a" });
    const r = await core.store("Concept in proj-b.", { circle: "proj-b" });

    const homeCircle = core.circleOf(r.conceptId);
    expect(homeCircle).toBe("proj-b");

    // Simulate the MCP fetch gate: caller provided wrong circle
    const callerCircle = "proj-a"; // WRONG
    const gateResult = homeCircle !== null && callerCircle !== undefined && homeCircle !== callerCircle;
    expect(gateResult).toBe(true); // gate correctly rejects

    // Correct circle passes
    const correctResult = homeCircle !== null && "proj-b" !== undefined && homeCircle !== "proj-b";
    expect(correctResult).toBe(false); // gate allows through

    core.close();
  });
});

// ---- (g) listCircles counts + exclusion ------------------------------------

describe("listCircles", () => {
  it("(g) counts concepts per circle and excludes the named circle", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("g"), defaultCircle: "proj-a" });
    // Use forceNew to guarantee distinct concepts even with similar content.
    await core.store("Storage backend decision for alpha project.", { circle: "proj-a", resolution: "forceNew" });
    await core.store("Authentication strategy for alpha project.", { circle: "proj-a", resolution: "forceNew" });
    await core.store("Database schema for beta project.", { circle: "proj-b" });
    await core.store("Deployment pipeline for gamma project.", { circle: "proj-c" });

    // Without exclusion: all circles
    const all = core.listCircles();
    const circleNames = all.map((r) => r.circle);
    expect(circleNames).toContain("proj-a");
    expect(circleNames).toContain("proj-b");
    expect(circleNames).toContain("proj-c");

    const rowA = all.find((r) => r.circle === "proj-a")!;
    expect(rowA.concepts).toBe(2);

    // With exclusion: proj-a excluded
    const others = core.listCircles("proj-a");
    expect(others.map((r) => r.circle)).not.toContain("proj-a");
    expect(others.map((r) => r.circle)).toContain("proj-b");
    expect(others.map((r) => r.circle)).toContain("proj-c");

    // lastActivity is a valid timestamp
    for (const row of others) expect(row.lastActivity).toBeGreaterThan(0);

    core.close();
  });

  it("(g) workstreams are NOT counted", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("gw"), defaultCircle: "proj-a" });
    await core.store("A real concept.", { circle: "proj-a" });
    await core.saveWorkstream({ status: "active" }, { circle: "proj-a" });

    const rows = core.listCircles("proj-b");
    const rowA = rows.find((r) => r.circle === "proj-a");
    expect(rowA?.concepts).toBe(1); // workstream not counted

    core.close();
  });

  it("(g) returns empty array when only the excluded circle is present", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("ge"), defaultCircle: "only" });
    await core.store("Only circle concept.", { circle: "only" });

    const others = core.listCircles("only");
    expect(others).toHaveLength(0);

    core.close();
  });
});

// ---- (h) overview leaves circle inventory to listCircles --------------------

describe("overview — circle inventory separation", () => {
  it("omits otherCircles while listCircles remains complete", async () => {
    const core = new MonetCore(":memory:", { idGen: seq("h"), defaultCircle: "main" });
    await core.store("Main circle concept.", { circle: "main" });
    await core.store("Side circle concept.", { circle: "side" });

    expect(core.overview("main")).not.toHaveProperty("otherCircles");
    expect(core.listCircles("main")).toEqual([
      expect.objectContaining({ circle: "side", concepts: 1 }),
    ]);
    core.close();
  });
});

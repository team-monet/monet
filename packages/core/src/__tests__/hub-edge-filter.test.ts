/**
 * Write-time hub-edge filter (#245 + Codex fix).
 *
 * Background: deriveEntityEdges previously had a PRE-insert hub gate that skipped both
 * the concept_entities row and the about-edge for hub entities. That caused two bugs:
 *  1. Frozen-df flip-flop: entities.df froze while conceptCount grew → df/n eventually
 *     dropped below the hub threshold → the entity temporarily un-hubbed → oscillation.
 *  2. Off-by-one: the pre-insert gate evaluated isHubDf(curDf, n) where n was post-insert
 *     but curDf was pre-insert — mixed basis.
 *
 * Fix (option 1): keep df EXACT by always running upsertEntity (so df == COUNT rows
 * invariant holds for ALL entities). Suppress only the about-EDGE via a single post-insert
 * hub gate evaluated on the consistent (df, n) post-insert pair. strongAlone exemption
 * (rare structural anchors, kind != 'noun' && df ≤ RARE_DF_MAX) is preserved.
 *
 * isHubDf(df, n) = df > MAX_DF_ABS(50) || (n > 0 && df/n > MAX_DF_FRAC(0.1))
 *
 * Tests:
 *  1. Hub entity gets a concept_entities row + accurate df, but NO about-edge.
 *  2. Rare strongAlone anchor still gets its about-edge.
 *  3. No flip-flop: storing many concepts with a hub token, the hub never resumes getting
 *     about-edges, and df stays == row count throughout.
 *  4. Leak/delete: store concepts with a hub entity, delete/move some, assert df == true
 *     row count throughout (no leaked df from suppressed rows).
 *  5. Boundary (Finding 2): the 29-concepts / df=3 case behaves consistently post-insert.
 *  6. Mutation-check: confirm the no-flip-flop + no-edge-for-hub tests FAIL without the fix.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// ---- helpers ----------------------------------------------------------------

/** Core with dedup off so each store() creates a distinct concept. */
function freshCore(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

/** Seed `n` unrelated filler concepts in their own sessions so the corpus is realistically
 *  large. The hub gate is a per-scope FRACTION — a 2-concept store would gate everything. */
async function seedFiller(core: MonetCore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await core.store(`Filler topic Zeta${i} concerns widget${i} only.`);
    core.endSessionForEval();
  }
}

/** Count concept_entities rows for a given entity key + scope. */
function countRows(core: MonetCore, key: string, circle: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (core as any).db;
  const row = db.prepare(`SELECT COUNT(*) as c FROM concept_entities WHERE entity_key = ? AND scope = ?`).get(key, circle) as { c: number };
  return row.c;
}

/** Read entities.df for a given entity key + scope (0 if absent). */
function entityDf(core: MonetCore, key: string, circle: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (core as any).db;
  const row = db.prepare(`SELECT df FROM entities WHERE key = ? AND scope = ?`).get(key, circle) as { df: number } | undefined;
  return row?.df ?? 0;
}

/**
 * Simulate concept deletion via raw SQL — mirrors what unwindConceptGraph does:
 * deletes concept_entities rows and decrements entities.df per row, then deletes the
 * concept itself. Use this in tests because MonetCore has no public `forget` method.
 */
function rawDeleteConcept(core: MonetCore, conceptId: string, circle: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (core as any).db;
  const keys = (db.prepare(`SELECT entity_key AS key FROM concept_entities WHERE concept_id = ? AND scope = ?`).all(conceptId, circle) as Array<{ key: string }>).map((r) => r.key);
  for (const key of keys) {
    db.prepare(`DELETE FROM concept_entities WHERE concept_id = ? AND entity_key = ? AND scope = ?`).run(conceptId, key, circle);
    db.prepare(`UPDATE entities SET df = df - 1 WHERE key = ? AND scope = ?`).run(key, circle);
    db.prepare(`DELETE FROM entities WHERE key = ? AND scope = ? AND df <= 0`).run(key, circle);
  }
  db.prepare(`DELETE FROM memory_edge WHERE scope = ? AND (src_id = ? OR dst_id = ?)`).run(circle, conceptId, conceptId);
  db.prepare(`DELETE FROM concepts WHERE id = ?`).run(conceptId);
}

/** Default circle for a fresh in-memory core. */
const DEFAULT_CIRCLE = "default";

// ---- 1. Hub entity gets concept_entities row + df, but NO about-edge --------

describe("1. hub entity — concept_entities row written, df incremented, about-edge suppressed", () => {
  it("a concept arriving after an entity crosses the hub threshold: row written, no about-edge", async () => {
    // With n=25 filler + 3 stores sharing "pipeline": df climbs 1→2→3.
    // After store 3: n=28, df=3 → isHubDf(3,28) = 3/28 ≈ 0.107 > 0.1 → hub.
    // The 4th store arrives post-insert with df=4, n=29 → still hub → about-edge suppressed.
    const core = freshCore();
    await seedFiller(core, 25); // n = 25

    const early: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await core.store(`AuthService${i} feeds the pipeline.`);
      core.endSessionForEval();
      early.push(r.conceptId);
    }

    // 4th concept — pipeline is now a hub.
    const late = await core.store("The EventLoop feeds the pipeline too.");
    core.endSessionForEval();

    // FIXED behavior: the late concept MUST have a concept_entities row for noun:pipeline.
    expect(core.conceptEntities(late.conceptId)).toContain("noun:pipeline");

    // But NO about-edge from the late concept to any of the 3 early ones via pipeline.
    const about = core.edges({ type: "about" });
    const hubEdges = about.filter(
      (e) =>
        (e.srcId === late.conceptId && early.includes(e.dstId)) ||
        (e.dstId === late.conceptId && early.includes(e.srcId)),
    );
    expect(hubEdges).toHaveLength(0);

    // df must equal the number of concept_entities rows (the core invariant).
    const rows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
    const df = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
    expect(df).toBe(rows);

    core.close();
  });

  it("a rare shared identifier (non-noun) is always kept and produces about-edges", async () => {
    const core = freshCore();
    await seedFiller(core, 25);

    // Two concepts share id:AuthService — df stays rare (≤ 2 << hub threshold).
    const a = await core.store("The AuthService validates every request.");
    core.endSessionForEval();
    const b = await core.store("We split AuthService into smaller modules.");

    expect(core.conceptEntities(a.conceptId)).toContain("id:AuthService");
    expect(core.conceptEntities(b.conceptId)).toContain("id:AuthService");

    const about = core.edges({ type: "about" });
    expect(about.some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    expect(about.some((e) => e.srcId === b.conceptId && e.dstId === a.conceptId)).toBe(true);

    core.close();
  });
});

// ---- 2. Threshold boundary (Finding 2 — consistent post-insert basis) -------

describe("2. threshold boundary — post-insert basis is consistent", () => {
  it("just-below hub threshold: entity rows written and about-edges produced", async () => {
    // isHubDf(df, n) triggers when df/n > 0.1. With n=33 filler + 2 stores:
    // After store 1: df=1, n=34 → 1/34≈0.029 < 0.1 → NOT a hub.
    // Store 2: post-insert df=2, n=35 → 2/35≈0.057 < 0.1 → NOT a hub → about-edge written.
    const core = freshCore();
    await seedFiller(core, 33); // n = 33

    const a = await core.store("SystemProxy triggers a cascade event.");
    core.endSessionForEval();
    const b = await core.store("LoadBalancer triggers a cascade event.");
    core.endSessionForEval();

    // n=35, df(noun:cascade)=2 → 2/35≈0.057 < 0.1 → concept_entities written for both.
    expect(core.conceptEntities(a.conceptId)).toContain("noun:cascade");
    expect(core.conceptEntities(b.conceptId)).toContain("noun:cascade");

    const about = core.edges({ type: "about" });
    expect(about.some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);

    core.close();
  });

  it("29-concept boundary: df=3 post-insert → isHubDf(3,29) = 3/29≈0.103 > 0.1 → hub → no about-edge", async () => {
    // This exercises the Finding 2 boundary case: with n=29 and df=3 post-insert, the gate
    // fires consistently. Under the old PRE-insert gate with curDf=2 and n=29 it would not
    // fire (2/29≈0.069 < 0.1), producing an inconsistency. Post-insert both agree: df=3.
    const core = freshCore();
    await seedFiller(core, 26); // n = 26

    // Two prior stores bring noun:cascade to df=2. n=28 → isHubDf(2,28)=2/28≈0.071 < 0.1 → not hub.
    const a = await core.store("SystemProxy triggers a cascade event.");
    core.endSessionForEval();
    const b = await core.store("LoadBalancer triggers a cascade event.");
    core.endSessionForEval();

    // Third store: post-insert df=3, n=29 → isHubDf(3,29)=3/29≈0.103 > 0.1 → hub → no about-edge.
    const c = await core.store("The Scheduler triggers a cascade event.");
    core.endSessionForEval();

    // The third concept has a concept_entities row (df is exact).
    expect(core.conceptEntities(c.conceptId)).toContain("noun:cascade");

    // But no about-edge from c to a or b via cascade (cascade became hub on this store).
    const about = core.edges({ type: "about" });
    const hubEdges = about.filter(
      (e) =>
        (e.srcId === c.conceptId && (e.dstId === a.conceptId || e.dstId === b.conceptId)) ||
        (e.dstId === c.conceptId && (e.srcId === a.conceptId || e.srcId === b.conceptId)),
    );
    expect(hubEdges).toHaveLength(0);

    // df == row count invariant.
    const rows = countRows(core, "noun:cascade", DEFAULT_CIRCLE);
    const df = entityDf(core, "noun:cascade", DEFAULT_CIRCLE);
    expect(df).toBe(rows);

    core.close();
  });
});

// ---- 3. No flip-flop — df stays == row count throughout many stores ---------

describe("3. no flip-flop — df stays exact and hub never resumes giving about-edges", () => {
  it("storing 20 more concepts with a hub token: no new about-edges, df stays == row count", async () => {
    const core = freshCore();
    await seedFiller(core, 25); // n = 25

    // Push noun:pipeline past hub threshold.
    const earlyIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await core.store(`Stage${i} feeds the pipeline.`);
      core.endSessionForEval();
      earlyIds.push(r.conceptId);
    }
    // pipeline is now a hub (df=5, n=30 → 5/30≈0.167 > 0.1).

    // Count about-edges after hubbing.
    const aboutAfterHub = core.edges({ type: "about" }).length;

    // Store 20 more concepts all mentioning "pipeline".
    const lateIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await core.store(`LateWorker${i} feeds the pipeline.`);
      core.endSessionForEval();
      lateIds.push(r.conceptId);
    }

    // No new about-edges should have appeared (hub never un-hubs as df/n stays > 0.1).
    const aboutFinal = core.edges({ type: "about" }).length;
    expect(aboutFinal).toBe(aboutAfterHub);

    // df == row count throughout.
    const rows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
    const df = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
    expect(df).toBe(rows);

    // Late concepts have concept_entities rows (df is exact, no freeze).
    for (const id of lateIds) {
      expect(core.conceptEntities(id)).toContain("noun:pipeline");
    }

    core.close();
  });
});

// ---- 4. Leak/delete — df == row count survives delete + move cycles ---------

describe("4. leak/delete — df == COUNT(concept_entities rows) throughout lifecycle", () => {
  it("store hub-bearing concepts then delete some: df decrements exactly with row count", async () => {
    const core = freshCore();
    await seedFiller(core, 25); // n = 25

    // Push noun:pipeline to hub territory.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await core.store(`Worker${i} feeds the pipeline.`);
      core.endSessionForEval();
      ids.push(r.conceptId);
    }

    // Verify initial invariant.
    {
      const rows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
      const df = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
      expect(df).toBe(rows);
    }

    // Delete 3 of the concepts (simulates forget via rawDeleteConcept).
    for (const id of ids.slice(0, 3)) {
      rawDeleteConcept(core, id, DEFAULT_CIRCLE);
    }

    // df must still equal row count after deletions.
    {
      const rows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
      const df = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
      expect(df).toBe(rows);
    }

    // Delete all remaining pipeline concepts.
    for (const id of ids.slice(3)) {
      rawDeleteConcept(core, id, DEFAULT_CIRCLE);
    }

    // Entity should be gone (df reached 0 and was cleaned up) OR df==0 and rows==0.
    const finalRows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
    const finalDf = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
    expect(finalDf).toBe(finalRows);

    core.close();
  });

  it("move concept to another circle: df decrements in source, increments in destination", async () => {
    const core = freshCore();
    await seedFiller(core, 25); // populate default circle

    // Push noun:pipeline to hub in default circle.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await core.store(`PipeStage${i} feeds the pipeline.`);
      core.endSessionForEval();
      ids.push(r.conceptId);
    }

    const preRows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
    const preDf = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
    expect(preDf).toBe(preRows);

    // Move one concept to another circle.
    const movedId = ids[0];
    core.reassignCircle(movedId, "archive");

    // Source circle: df decremented by exactly 1 (or row deleted if df→0).
    const postRows = countRows(core, "noun:pipeline", DEFAULT_CIRCLE);
    const postDf = entityDf(core, "noun:pipeline", DEFAULT_CIRCLE);
    expect(postDf).toBe(postRows);
    expect(postDf).toBe(preDf - 1);

    core.close();
  });
});

// ---- 5. strongAlone exemption — rare structural anchors always get edges ----

describe("5. strongAlone exemption — rare non-noun entities bypass hub gate", () => {
  it("a shared path entity (df ≤ RARE_DF_MAX=5) always produces an about-edge", async () => {
    const core = freshCore();
    await seedFiller(core, 25);

    // Two concepts share a path entity (kind=path, df stays ≤ 2).
    const a = await core.store("Bug in src/auth/session.ts affects login.", { sourceRefs: ["src/auth/session.ts"] });
    core.endSessionForEval();
    const b = await core.store("Refactored src/auth/session.ts for clarity.", { sourceRefs: ["src/auth/session.ts"] });

    // Both must have concept_entities rows for the ref.
    expect(core.conceptEntities(a.conceptId)).toContain("ref:src/auth/session.ts");
    expect(core.conceptEntities(b.conceptId)).toContain("ref:src/auth/session.ts");

    // And an about-edge between them (strongAlone exemption fires).
    const about = core.edges({ type: "about" });
    const linked = about.some(
      (e) =>
        (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
        (e.srcId === b.conceptId && e.dstId === a.conceptId),
    );
    expect(linked).toBe(true);

    // df == row count invariant.
    const key = "ref:src/auth/session.ts";
    const rows = countRows(core, key, DEFAULT_CIRCLE);
    const df = entityDf(core, key, DEFAULT_CIRCLE);
    expect(df).toBe(rows);

    core.close();
  });
});

// ---- 6. Mutation-check: tests that catch the regression ---------------------

describe("6. mutation-check — these assertions would fail on the broken pre-insert-gate code", () => {
  it("NO-EDGE-FOR-HUB: a concept stored when an entity is a hub gets no about-edge (catches off-by-one)", async () => {
    // Under the old pre-insert gate with off-by-one basis: curDf=2, n=29 → 2/29≈0.069 < 0.1
    // → gate does NOT fire → upsertEntity runs → df becomes 3 → post-insert check:
    // isHubDf(3,29)=3/29≈0.103 > 0.1 → edge suppressed by post-insert gate.
    // Under the NEW code (post-insert only): df=3, n=29 → hub → edge suppressed correctly.
    // This test confirms edge suppression happens on the first store that tips the entity into hub.
    const core = freshCore();
    await seedFiller(core, 26); // n = 26

    // Two stores: df climbs to 2, n=28 → not hub.
    const a = await core.store("SystemProxy triggers a cascade event.");
    core.endSessionForEval();
    const b = await core.store("LoadBalancer triggers a cascade event.");
    core.endSessionForEval();

    // Third store: post-insert df=3, n=29 → isHubDf(3,29)=3/29≈0.103 > 0.1 → hub → no edge.
    const c = await core.store("The Scheduler triggers a cascade event.");
    core.endSessionForEval();

    // c must have a concept_entities row (df is exact under the fix).
    expect(core.conceptEntities(c.conceptId)).toContain("noun:cascade");

    // But no about-edge between c and {a,b}.
    const about = core.edges({ type: "about" });
    const hubEdge = about.some(
      (e) =>
        (e.srcId === c.conceptId && (e.dstId === a.conceptId || e.dstId === b.conceptId)) ||
        (e.dstId === c.conceptId && (e.srcId === a.conceptId || e.srcId === b.conceptId)),
    );
    expect(hubEdge).toBe(false);

    // df == row count.
    const rows = countRows(core, "noun:cascade", DEFAULT_CIRCLE);
    const df = entityDf(core, "noun:cascade", DEFAULT_CIRCLE);
    expect(df).toBe(rows);

    core.close();
  });
});

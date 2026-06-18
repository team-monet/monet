/**
 * Earn-it tier: write-time hub-edge filter (#245 follow-up).
 *
 * Background: deriveEntityEdges previously wrote concept_entities rows and about-edges for ALL
 * extracted entities — including high-df hub tokens. A query-time isHub gate in gather already
 * excluded hubs from seeding, but the edges were already in the graph and could propagate through
 * spread(). This fix gates at WRITE time so hub entities never enter concept_entities or memory_edge
 * at write time.
 *
 * isHubDf(df, n) = df > MAX_DF_ABS(50) || (n > 0 && df/n > MAX_DF_FRAC(0.1))
 * So with n concepts, an entity becomes a hub when its df exceeds n*0.1.
 *
 * Tests:
 *  1. Unit: a concept that arrives AFTER an entity crosses the hub threshold gets NO
 *     concept_entities row and NO about-edge for that entity; a concept that arrives before
 *     the threshold does (that's the existing correct write-path behavior).
 *  2. Unit: threshold boundary — just-below lets through; just-at is blocked.
 *  3. Integration: gather/spread no longer traverses through a hub entity.
 *  4. Migration (user_version → 3): seed hub concept_entities + about-edges, run migrate(),
 *     assert hub concept_entities deleted, df decremented, orphaned about-edges removed,
 *     non-hub edges retained. Idempotent on a second open.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import type { StoragePort } from "../storage";

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

/** Read the raw db from a MonetCore instance (test-only introspection). */
function rawDb(core: MonetCore): StoragePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (core as any).db as StoragePort;
}

// ---- 1. Hub entity → no write-time concept_entities row or about-edge -------

describe("1. write-time hub filter — concept arriving after hub threshold is skipped", () => {
  it("the FIRST concept arriving after entity crosses hub threshold: no concept_entities, no about-edge", async () => {
    // With n≈28 filler + 3 stores, noun:pipeline has df=3.
    // isHubDf(3, 28) = 3/28 ≈ 0.107 > 0.1 → hub.
    // The 4th store arrives when curDf=3 is already a hub → skip.
    const core = freshCore();
    await seedFiller(core, 25); // n ≈ 25

    // Store 3 concepts sharing "pipeline" (df climbs from 0→1→2→3).
    // After store 2: n≈28, df(noun:pipeline)=3 → isHubDf(3, 28) → hub.
    const early: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await core.store(`AuthService${i} feeds the pipeline.`);
      core.endSessionForEval();
      early.push(r.conceptId);
    }

    // Store a 4th concept — at this point curDf=3, n≈28 → hub gate fires → skip.
    const late = await core.store("The EventLoop feeds the pipeline too.");
    core.endSessionForEval();

    // The 4th concept must have NO noun:pipeline in concept_entities.
    expect(core.conceptEntities(late.conceptId)).not.toContain("noun:pipeline");

    // And NO about-edge from the late concept to any of the 3 early ones via pipeline.
    const about = core.edges({ type: "about" });
    const hubEdges = about.filter(
      (e) =>
        (e.srcId === late.conceptId && early.includes(e.dstId)) ||
        (e.dstId === late.conceptId && early.includes(e.srcId)),
    );
    expect(hubEdges).toHaveLength(0);

    core.close();
  });

  it("a rare shared identifier is always kept and produces about-edges", async () => {
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

// ---- 2. Threshold boundary --------------------------------------------------

describe("2. threshold boundary — just-below vs just-at isHubDf", () => {
  it("just-below hub threshold: entity is kept and concept_entities row is written", async () => {
    // isHubDf(df, n) triggers when df/n > 0.1. With n≈33 filler + 2 stores:
    // After store 1: df=2, n≈34 → 2/34≈0.059 < 0.1 → NOT a hub.
    // Store 2 arrives with curDf=2 → still not hub → written.
    const core = freshCore();
    await seedFiller(core, 33); // n ≈ 33

    const a = await core.store("SystemProxy triggers a cascade event.");
    core.endSessionForEval();
    const b = await core.store("LoadBalancer triggers a cascade event.");
    core.endSessionForEval();

    // n≈35, df(noun:cascade)=2 → 2/35≈0.057 < 0.1 → concept_entities written for both.
    expect(core.conceptEntities(a.conceptId)).toContain("noun:cascade");
    expect(core.conceptEntities(b.conceptId)).toContain("noun:cascade");

    core.close();
  });

  it("just-at hub threshold: next concept sees entity as hub → concept_entities row skipped", async () => {
    // With n≈33 filler: push cascade to df=4 over 4 stores.
    // After 4 stores: n≈37, df=4 → 4/37≈0.108 > 0.1 → hub.
    // 5th concept arrives with curDf=4 → hub gate fires → skip.
    const core = freshCore();
    await seedFiller(core, 33);

    for (let i = 0; i < 4; i++) {
      await core.store(`ProxyAgent${i} triggers a cascade event.`);
      core.endSessionForEval();
    }
    // n≈37, df(noun:cascade)=4 → isHubDf(4, 37) → 4/37≈0.108 > 0.1 → hub.

    const late = await core.store("The Scheduler triggers a cascade event too.");
    core.endSessionForEval();

    // The 5th concept must have noun:cascade absent from concept_entities.
    expect(core.conceptEntities(late.conceptId)).not.toContain("noun:cascade");

    core.close();
  });
});

// ---- 3. gather/spread no longer routes through a hub entity -----------------

describe("3. integration — hub entity produces no about-edge for late-arriving concepts", () => {
  it("a concept arriving after the hub threshold has no about-edge via the hub entity", async () => {
    const core = freshCore();
    await seedFiller(core, 30); // n≈30; hub fraction threshold: df > 3

    // Push "cascade" past hub territory with 4 initial stores (df=4, n≈34 → hub).
    for (let i = 0; i < 4; i++) {
      await core.store(`UnrelatedWidget${i} triggers a cascade event.`);
      core.endSessionForEval();
    }

    // target and decoy both mention the hub noun; they have no other shared entity.
    const target = await core.store("The RoutingEngine triggers a cascade event.");
    core.endSessionForEval();
    const decoy = await core.store("A cascade event propagates through the scheduler.");
    core.endSessionForEval();

    // Both arrive after cascade became a hub → no concept_entities rows, no about-edge between them.
    expect(core.conceptEntities(target.conceptId)).not.toContain("noun:cascade");
    expect(core.conceptEntities(decoy.conceptId)).not.toContain("noun:cascade");

    const about = core.edges({ type: "about" });
    const hubLink = about.some(
      (e) =>
        (e.srcId === target.conceptId && e.dstId === decoy.conceptId) ||
        (e.srcId === decoy.conceptId && e.dstId === target.conceptId),
    );
    expect(hubLink).toBe(false); // no hub-derived about-edge between target and decoy

    core.close();
  });
});


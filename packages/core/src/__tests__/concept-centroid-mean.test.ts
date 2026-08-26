/**
 * EVERY CENTROID WRITER WRITES THE TRUE MEAN OF THE CONCEPT'S LIVE EVIDENCE.
 *
 * `concepts.embedding` had two definitions. `recomputeNativeConceptProjection` (since #90),
 * `repairNativeProjections` and the 1.8.0 one-time reprojection wrote the normalized ARITHMETIC MEAN
 * of the live observation vectors. `attach()`, `detach()`'s two rebuilds and `mergeConceptInto`
 * wrote a RUNNING BLEND instead — folding one vector in at a time, re-inflating the accumulated
 * direction to full integer weight at every step as if every prior member had agreed with it
 * perfectly. A running blend is not a mean: it depends on the ORDER the evidence arrived in, and it
 * sits off the mean of the very set it was built from.
 *
 * THE DIRECTION OF THE ERROR IS ONE-WAY, which is what made it worth fixing rather than merely
 * noting. Among unit vectors the normalized mean is the one MAXIMIZING summed cosine to the members,
 * so any other choice can only LOWER a concept's self-similarity to its own evidence — and that
 * quantity is read directly by the identity half of the attach decision (`centroidScore` against
 * tauAmbiguous) and by `rankByCentroid`'s edge scan.
 *
 * WHAT THESE TESTS PIN, in the order they appear:
 *
 *   1. PREMISE — the running blend really is path-dependent on this fixture, so the tests below are
 *      about something. Asserted, never assumed: if `blend` ever stopped drifting, every green here
 *      would be a green that could not have failed.
 *   2. attach() writes the true mean, at every step and not merely at the end.
 *   3. Two arrival orders of the SAME evidence produce the SAME stored centroid.
 *   4. attach()'s write is BYTE-identical to what a later recompute writes — "converged" in this
 *      codebase means a subsequent real recompute finds nothing to change.
 *   5. detach()'s two rebuilds converge, on both the surviving source and a freshly created
 *      destination.
 *   6. mergeConceptInto converges on the union's own mean, and the weighted blend it replaced was
 *      materially different — quantified here rather than asserted.
 *
 * THE INDEPENDENT QUANTITY IS COMPUTED IN THIS FILE, from `rawMean` + `normalizeVector`, and NOT by
 * importing the engine's `centroidOf`. Two reasons, both load-bearing: a test that calls the code
 * under test to compute its own expectation proves only that the function is deterministic; and
 * this file has to be COMPILABLE AGAINST THE PRE-FIX TREE so the red-before run is a real failure of
 * the assertions rather than an import error.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, blend, blendWeighted, jsonToEmb, normalizeVector } from "../embedding";
import type { StoragePort } from "../storage";

const CIRCLE = "centroid-mean";

/** Same convention as concept-centroid-norm.test.ts: reach the store directly to read raw vectors. */
const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

/** Dedup OFF (thresholds above max cosine) so every store() creates a DISTINCT concept and
 *  `attachTo` is the only way observations pile onto one. */
function newCore(): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

/** Dedup still off for store(), but tauAttach low enough that reassignCircle's dedup scan MERGES.
 *  Every write below names its own destination (`forceNew` / `attachTo`), so the low bar reaches
 *  only the merge decision — which is the one this fixture is about. */
function newMergeCore(): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    embedder: new HashingEmbeddingProvider(), tauAttach: 0, tauAmbiguous: 0,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

const l2 = (v: Float32Array): number => {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i]! * v[i]!;
  return Math.sqrt(mag);
};

const cos = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (l2(a) * l2(b));
};

const conceptVector = (db: StoragePort, conceptId: string): Float32Array => {
  const row = db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string };
  return jsonToEmb(row.embedding);
};

/** The live observation vectors the engine itself centroids — same predicate, same ORDER BY. */
const liveObservationVectors = (db: StoragePort, conceptId: string): Float32Array[] =>
  (db.prepare(
    `SELECT embedding FROM observations
      WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL ORDER BY id ASC`,
  ).all(conceptId) as Array<{ embedding: string }>).map((r) => jsonToEmb(r.embedding));

const rawMean = (vectors: Float32Array[]): Float32Array => {
  const out = new Float32Array(vectors[0]!.length);
  for (let d = 0; d < out.length; d++) {
    let sum = 0;
    for (const v of vectors) sum += v[d] ?? 0;
    out[d] = sum / vectors.length;
  }
  return out;
};

/** The true normalized mean of a concept's live evidence, computed HERE and not by the engine. */
const trueMean = (db: StoragePort, conceptId: string): Float32Array =>
  normalizeVector(rawMean(liveObservationVectors(db, conceptId)));

const TEXTS = [
  "The scheduler retries failed jobs with exponential backoff.",
  "Postgres connection pooling uses pgbouncer in transaction mode.",
  "Rolling deploys drain each node for sixty seconds before restart.",
  "Feature flags are evaluated once per request and cached per session.",
  "The ingest queue shards by tenant id and rebalances hourly.",
];

/** One concept carrying `order.length` observations, attached in that arrival order. */
async function buildConcept(core: MonetCore, order: number[]): Promise<string> {
  const first = await core.store(TEXTS[order[0]!]!, { circle: CIRCLE });
  for (const i of order.slice(1)) await core.store(TEXTS[i]!, { circle: CIRCLE, attachTo: first.conceptId });
  return first.conceptId;
}

describe("attach() writes the true mean of the concept's live evidence", () => {
  it("PREMISE: a running blend over these five vectors is NOT their mean, and depends on their order", () => {
    const e = new HashingEmbeddingProvider();
    const v = TEXTS.map((t) => e.embed(t));
    const runningBlend = (vectors: Float32Array[]): Float32Array => {
      let acc = vectors[0]!;
      for (let n = 1; n < vectors.length; n++) acc = blend(acc, vectors[n]!, n);
      return acc;
    };
    const forward = runningBlend(v);
    const backward = runningBlend([...v].reverse());
    const mean = normalizeVector(rawMean(v));

    // Unit-length while drifting — which is why a norm check could never have caught this.
    expect(l2(forward)).toBeCloseTo(1, 5);
    // Off the mean by far more than float noise, in BOTH directions of arrival...
    expect(cos(forward, mean)).toBeLessThan(0.999);
    expect(cos(backward, mean)).toBeLessThan(0.999);
    // ...and off EACH OTHER, which is the path-dependence itself. If this ever stops holding, every
    // convergence assertion below becomes a green that could not have failed.
    expect(cos(forward, backward)).toBeLessThan(0.999);
    // The mean of a set has no arrival order to depend on — stated as the contrast.
    expect(Array.from(mean)).toEqual(Array.from(normalizeVector(rawMean([...v].reverse()))));
  });

  it("converges after EVERY attach, not merely at the end", async () => {
    const core = newCore();
    try {
      const first = await core.store(TEXTS[0]!, { circle: CIRCLE });
      const db = dbOf(core);
      // One observation: the mean of one unit vector is itself. True before AND after the change,
      // so this pins that single-observation concepts are untouched by it.
      expect(Array.from(conceptVector(db, first.conceptId))).toEqual(Array.from(trueMean(db, first.conceptId)));

      for (const i of [1, 2, 3, 4]) {
        await core.store(TEXTS[i]!, { circle: CIRCLE, attachTo: first.conceptId });
        expect(liveObservationVectors(db, first.conceptId)).toHaveLength(i + 1);
        // FLOAT-IDENTICAL, not close: the incoming observation is merged in at the position
        // `ORDER BY id ASC` will read it from once the row is repointed, so attach sums the same
        // values in the same order the recompute will.
        expect(Array.from(conceptVector(db, first.conceptId))).toEqual(Array.from(trueMean(db, first.conceptId)));
      }
      expect(l2(conceptVector(db, first.conceptId))).toBeCloseTo(1, 5);
    } finally {
      core.close();
    }
  });

  it("is ORDER-INDEPENDENT: the same five observations in two arrival orders give the same stored centroid", async () => {
    const a = newCore();
    const b = newCore();
    try {
      const idA = await buildConcept(a, [0, 1, 2, 3, 4]);
      const idB = await buildConcept(b, [4, 3, 2, 1, 0]);
      const storedA = conceptVector(dbOf(a), idA);
      const storedB = conceptVector(dbOf(b), idB);

      // The two stores hold the same five vectors and summed them in opposite orders (each store's
      // own ids ascend with its own arrival order), so this is the path-dependence the PREMISE
      // measured, asked of the real engine.
      expect(Array.from(storedA)).toEqual(Array.from(storedB));
      // And it is the MEAN they agree on, not merely each other — an order-independent WRONG answer
      // would satisfy the line above on its own.
      expect(Array.from(storedA)).toEqual(Array.from(trueMean(dbOf(a), idA)));
      expect(Array.from(storedB)).toEqual(Array.from(trueMean(dbOf(b), idB)));
    } finally {
      a.close();
      b.close();
    }
  });

  it("agrees BYTE-FOR-BYTE with a later recompute of the same evidence", async () => {
    const core = newCore();
    try {
      const conceptId = await buildConcept(core, [0, 1, 2, 3, 4]);
      const db = dbOf(core);
      const afterAttach = Array.from(conceptVector(db, conceptId));

      // The engine's own recompute, run over exactly the same live set. "Converged" means it finds
      // nothing to change — anything less makes attach and the recompute two definitions again.
      expect(core.repairNativeProjections([conceptId])).toBe(1);
      expect(Array.from(conceptVector(db, conceptId))).toEqual(afterAttach);
    } finally {
      core.close();
    }
  });

  it("re-converges over the LIVE set after a supersession removes a member", async () => {
    const core = newCore();
    try {
      const first = await core.store(TEXTS[0]!, { circle: CIRCLE });
      await core.store(TEXTS[1]!, { circle: CIRCLE, attachTo: first.conceptId });
      const doomed = await core.store(TEXTS[2]!, { circle: CIRCLE, attachTo: first.conceptId });
      const db = dbOf(core);

      core.supersedeObservation(doomed.observationId, null);
      expect(liveObservationVectors(db, first.conceptId)).toHaveLength(2);

      // A further attach must mean the LIVE two plus the newcomer — never the dead one. The blend
      // could not have honoured this at all: it read the stored vector, which still carried the
      // superseded member's contribution.
      await core.store(TEXTS[3]!, { circle: CIRCLE, attachTo: first.conceptId });
      expect(liveObservationVectors(db, first.conceptId)).toHaveLength(3);
      expect(Array.from(conceptVector(db, first.conceptId))).toEqual(Array.from(trueMean(db, first.conceptId)));
    } finally {
      core.close();
    }
  });
});

describe("detach() rebuilds both sides as true means", () => {
  it("converges the SURVIVING SOURCE and a NEWLY CREATED destination on their own evidence", async () => {
    const core = newCore();
    try {
      const conceptId = await buildConcept(core, [0, 1, 2, 3, 4]);
      const db = dbOf(core);
      const obsIds = (db.prepare(
        `SELECT id FROM observations WHERE concept_id = ? ORDER BY created_at, rowid`,
      ).all(conceptId) as Array<{ id: string }>).map((r) => r.id);
      expect(obsIds).toHaveLength(5);

      // Two moved, three left behind: both rebuild loops run with more than one member, which is
      // the only shape in which a running blend and a mean can disagree at all.
      const moved = obsIds.slice(3);
      const result = await core.detach(conceptId, moved, { circle: CIRCLE });
      expect(result.destConceptId).not.toBe(conceptId);

      expect(liveObservationVectors(db, conceptId)).toHaveLength(3);
      expect(liveObservationVectors(db, result.destConceptId)).toHaveLength(2);
      expect(Array.from(conceptVector(db, conceptId))).toEqual(Array.from(trueMean(db, conceptId)));
      expect(Array.from(conceptVector(db, result.destConceptId))).toEqual(Array.from(trueMean(db, result.destConceptId)));
    } finally {
      core.close();
    }
  });

  it("converges an EXISTING destination that the moved evidence is re-attached onto", async () => {
    const core = newCore();
    try {
      const source = await buildConcept(core, [0, 1, 2]);
      const dest = await buildConcept(core, [3, 4]);
      const db = dbOf(core);
      const sourceObs = (db.prepare(
        `SELECT id FROM observations WHERE concept_id = ? ORDER BY created_at, rowid`,
      ).all(source) as Array<{ id: string }>).map((r) => r.id);

      // The reattach path: each moved observation goes through attach() one at a time, against a
      // destination whose row already carries them (they are bulk-repointed first). That is the case
      // attach's pending-observation handling has to count ONCE, not twice.
      await core.detach(source, sourceObs.slice(1), { destConceptId: dest, circle: CIRCLE });

      expect(liveObservationVectors(db, dest)).toHaveLength(4);
      expect(Array.from(conceptVector(db, dest))).toEqual(Array.from(trueMean(db, dest)));
      expect(liveObservationVectors(db, source)).toHaveLength(1);
      expect(Array.from(conceptVector(db, source))).toEqual(Array.from(trueMean(db, source)));
    } finally {
      core.close();
    }
  });
});

describe("mergeConceptInto converges on the union's own mean", () => {
  it("PREMISE: a support-weighted blend of two converged centroids is NOT the union's mean", async () => {
    const core = newMergeCore();
    try {
      const db = dbOf(core);
      const a = await core.store(TEXTS[0]!, { circle: "merge-a", resolution: "forceNew" });
      for (const i of [1, 2]) await core.store(TEXTS[i]!, { circle: "merge-a", attachTo: a.conceptId });
      const b = await core.store(TEXTS[3]!, { circle: "merge-b", resolution: "forceNew" });
      await core.store(TEXTS[4]!, { circle: "merge-b", attachTo: b.conceptId });

      const cA = conceptVector(db, a.conceptId);
      const cB = conceptVector(db, b.conceptId);
      const weighted = blendWeighted(cA, 3, cB, 2);
      const union = normalizeVector(rawMean([
        ...liveObservationVectors(db, a.conceptId),
        ...liveObservationVectors(db, b.conceptId),
      ]));
      // Both sides are already converged, so this is not drift being carried in — it is the mean of
      // two MEANS, which is a different quantity because normalizing each side first discards the
      // length that would have carried its weight. Measured, so the next reader does not have to
      // take "materially different" on faith.
      expect(cos(weighted, union)).toBeLessThan(0.999);
      console.log(`[merge] cos(blendWeighted(3,2), unionMean) = ${cos(weighted, union).toFixed(6)}`);
    } finally {
      core.close();
    }
  });

  it("writes the union's true mean when a merge folds one concept into another", async () => {
    const core = newMergeCore();
    try {
      const db = dbOf(core);
      const a = await core.store(TEXTS[0]!, { circle: "merge-a", resolution: "forceNew" });
      for (const i of [1, 2]) await core.store(TEXTS[i]!, { circle: "merge-a", attachTo: a.conceptId });
      const b = await core.store(TEXTS[3]!, { circle: "merge-b", resolution: "forceNew" });
      await core.store(TEXTS[4]!, { circle: "merge-b", attachTo: b.conceptId });

      const weightedWouldBe = blendWeighted(conceptVector(db, b.conceptId), 2, conceptVector(db, a.conceptId), 3);

      // Moving A into B's circle finds B as the dedup target and merges A into it.
      const result = core.reassignCircle(a.conceptId, "merge-b");
      expect(result?.action).toBe("merged");
      expect(result?.mergedIntoId).toBe(b.conceptId);

      expect(liveObservationVectors(db, b.conceptId)).toHaveLength(5);
      const stored = conceptVector(db, b.conceptId);
      expect(Array.from(stored)).toEqual(Array.from(trueMean(db, b.conceptId)));
      // And it is NOT what the weighted blend would have written — the fixture exhibits the change.
      expect(Array.from(stored)).not.toEqual(Array.from(weightedWouldBe));
    } finally {
      core.close();
    }
  });
});

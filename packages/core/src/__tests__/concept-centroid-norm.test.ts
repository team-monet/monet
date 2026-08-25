/**
 * A RECOMPUTED CONCEPT CENTROID IS A UNIT VECTOR (findings 2026-08-25 §3.1).
 *
 * `cosine()` (embedding.ts) is a bare dot product whose contract is "both vectors are
 * L2-normalized", and every other path that writes `concepts.embedding` honours it: `create` stores
 * the provider's own output, `attach` goes through `blend`, `mergeConceptInto` through
 * `blendWeighted` — all three normalize. `recomputeNativeConceptProjection` did not: it wrote a
 * plain arithmetic mean of the live observation vectors, because `normalize` was module-private and
 * the engine could not reach it.
 *
 * The consequence is not a wrong direction but a SHORT one, and every centroid read is a dot
 * product that scales with length: `nominateByObservation`'s `centroidScore` (engine.ts) against
 * `tauAmbiguous`, and `rankByCentroid`'s edge-neighbour scan. A mean of two distinct unit vectors
 * separated by 60° is only 0.87 long, so a true 1.00 cosine reads as 0.87 — deflation applied to
 * the identity half of the attach decision, on exactly the concepts with the most evidence.
 *
 * THE FIXTURE MUST BE ABLE TO EXHIBIT IT. A mean is short only when the vectors averaged actually
 * disagree, so the premise — two distinct hashing vectors' mean has norm < 1 — is ASSERTED here
 * before anything else is measured, rather than assumed. It also fixes the shape of the scenario:
 * the recompute must land on TWO OR MORE surviving members, so the concept starts with three
 * observations and loses one. Superseding one of two would leave a single survivor, whose mean is
 * itself and therefore already unit-length — a green that could never have failed.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, isZeroVector, jsonToEmb, normalizeVector } from "../embedding";
import type { StoragePort } from "../storage";

const CIRCLE = "centroid-norm";

/** Same convention as recall-unit-split.test.ts: reach the store directly to read raw vectors and
 *  to set up states no public API produces (an all-placeholder concept). */
const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

/** Dedup OFF (thresholds above max cosine) so every store() creates a DISTINCT concept and
 *  `attachTo` is the only way observations pile onto one. */
function newCore(embedder = new HashingEmbeddingProvider()): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    embedder, tauAttach: 1.1, tauAmbiguous: 1.1,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

const l2 = (v: Float32Array): number => {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i]! * v[i]!;
  return Math.sqrt(mag);
};

const conceptVector = (db: StoragePort, conceptId: string): Float32Array => {
  const row = db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string };
  return jsonToEmb(row.embedding);
};

/** The live observation vectors the recompute itself centroids — same predicate, same order. */
const liveObservationVectors = (db: StoragePort, conceptId: string): Float32Array[] =>
  (db.prepare(
    `SELECT embedding FROM observations
      WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL ORDER BY id ASC`,
  ).all(conceptId) as Array<{ embedding: string }>).map((r) => jsonToEmb(r.embedding));

/** The arithmetic mean the recompute computes, WITHOUT the normalization under test. */
const rawMean = (vectors: Float32Array[]): Float32Array => {
  const out = new Float32Array(vectors[0]!.length);
  for (let d = 0; d < out.length; d++) {
    let sum = 0;
    for (const v of vectors) sum += v[d] ?? 0;
    out[d] = sum / vectors.length;
  }
  return out;
};

const setObservationVector = (db: StoragePort, observationId: string, embeddingJson: string): void => {
  db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(embeddingJson, observationId);
  db.prepare(`UPDATE observation_segments SET embedding = ? WHERE observation_id = ?`).run(embeddingJson, observationId);
};

describe("recomputeNativeConceptProjection — the stored centroid is L2-normalized", () => {
  it("PREMISE: two distinct hashing vectors are each unit-length, and their arithmetic mean is NOT", () => {
    const embedder = new HashingEmbeddingProvider();
    const a = embedder.embed("The scheduler retries failed jobs with exponential backoff.");
    const b = embedder.embed("Postgres connection pooling uses pgbouncer in transaction mode.");
    expect(l2(a)).toBeCloseTo(1, 5);
    expect(l2(b)).toBeCloseTo(1, 5);
    // If this ever stops holding, every assertion below passes vacuously — so it fails loudly here.
    expect(l2(rawMean([a, b]))).toBeLessThan(0.999);
  });

  it("normalizes the centroid after a supersede leaves TWO distinct members behind", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs with exponential backoff.", { circle: CIRCLE });
      await core.store("Postgres connection pooling uses pgbouncer in transaction mode.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });
      const doomed = await core.store("Rolling deploys drain each node for sixty seconds before restart.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });

      // Terminal supersession: the evidence is gone, and the concept is reprojected over what is left.
      core.supersedeObservation(doomed.observationId, null);

      const db = dbOf(core);
      const survivors = liveObservationVectors(db, concept.conceptId);
      expect(survivors).toHaveLength(2);
      // The defect, priced on this exact fixture: the mean the recompute computes is short.
      expect(l2(rawMean(survivors))).toBeLessThan(0.999);

      const stored = conceptVector(db, concept.conceptId);
      expect(l2(stored)).toBeCloseTo(1, 5);
      // Direction unchanged — normalization scales, it does not steer.
      expect(Array.from(stored)).toEqual(Array.from(normalizeVector(rawMean(survivors))));
    } finally {
      core.close();
    }
  });

  it("leaves the centroid unit-length when the recompute lands on exactly ONE member (mean of one unit vector)", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs with exponential backoff.", { circle: CIRCLE });
      const doomed = await core.store("Postgres connection pooling uses pgbouncer in transaction mode.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });

      core.supersedeObservation(doomed.observationId, null);

      const db = dbOf(core);
      const survivors = liveObservationVectors(db, concept.conceptId);
      expect(survivors).toHaveLength(1);
      // This case was ALWAYS correct — a one-member mean is the member — so it pins that the fix
      // changes nothing here rather than that the fix is working.
      expect(l2(rawMean(survivors))).toBeCloseTo(1, 5);
      expect(l2(conceptVector(db, concept.conceptId))).toBeCloseTo(1, 5);
      expect(Array.from(conceptVector(db, concept.conceptId))).toEqual(Array.from(survivors[0]!));
    } finally {
      core.close();
    }
  });

  it("is a no-op when every surviving member carries the SAME vector (the mean is already unit-length)", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs with exponential backoff.", { circle: CIRCLE });
      const twin = await core.store("Postgres connection pooling uses pgbouncer in transaction mode.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });
      const doomed = await core.store("Rolling deploys drain each node for sixty seconds before restart.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });

      const db = dbOf(core);
      // Identical vectors on both survivors: their mean is that vector, already unit-length. Written
      // by hand because store() dedups identical CONTENT rather than attaching it twice.
      const shared = db.prepare(`SELECT embedding FROM observations WHERE id = ?`)
        .get(concept.observationId) as { embedding: string };
      setObservationVector(db, twin.observationId, shared.embedding);

      core.supersedeObservation(doomed.observationId, null);

      const survivors = liveObservationVectors(db, concept.conceptId);
      expect(survivors).toHaveLength(2);
      expect(l2(rawMean(survivors))).toBeCloseTo(1, 5);
      const stored = conceptVector(db, concept.conceptId);
      expect(l2(stored)).toBeCloseTo(1, 5);
      expect(Array.from(stored)).toEqual(Array.from(jsonToEmb(shared.embedding)));
    } finally {
      core.close();
    }
  });

  it("leaves an all-placeholder concept's centroid at ZERO — normalization must not manufacture a measurement", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs with exponential backoff.", { circle: CIRCLE });
      const other = await core.store("Postgres connection pooling uses pgbouncer in transaction mode.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });
      const doomed = await core.store("Rolling deploys drain each node for sixty seconds before restart.", {
        circle: CIRCLE, attachTo: concept.conceptId,
      });

      const db = dbOf(core);
      // Both survivors reduced to the zero PLACEHOLDER (what storeSourceChunk wrote pre-chunk-
      // embedding, and what create() leaves before the first real projection). Reached by hand
      // because no public write produces it on a native concept.
      const zeros = JSON.stringify(Array.from(new Float32Array(256)));
      setObservationVector(db, concept.observationId, zeros);
      setObservationVector(db, other.observationId, zeros);

      core.supersedeObservation(doomed.observationId, null);

      const stored = conceptVector(db, concept.conceptId);
      // `mag || 1` divides by 1, so the placeholder survives as a placeholder. Scaling it to unit
      // length would make isZeroVector false and let retrieval score a "not measured" as evidence.
      expect(isZeroVector(stored)).toBe(true);
      expect(l2(stored)).toBe(0);
    } finally {
      core.close();
    }
  });
});

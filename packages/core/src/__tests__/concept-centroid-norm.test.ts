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
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, embToJson, isZeroVector, jsonToEmb, normalizeVector } from "../embedding";
import { BetterSqlitePort, type Statement, type StoragePort } from "../storage";

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

/**
 * THE ONE-TIME PASS THAT CONVERGES WHAT EARLIER WRITES LEFT BEHIND (slice 3, FIX 2).
 *
 * Two defect classes reach the same column, and one write repairs both:
 *
 *   SHORT CENTROIDS — what the block above fixed going forward, unrepaired on any store whose
 *   concepts were last recomputed by a pre-#90 build.
 *
 *   BLEND DRIFT — `attach()` folds each observation in with a RUNNING `blend()`, which re-inflates
 *   the accumulated direction to full integer weight at every step as if all priors agreed. The
 *   stored centroid therefore depends on the ORDER the evidence arrived in and drifts off the true
 *   normalized mean. Crucially it stays UNIT-LENGTH while drifting, which is why the norm-only
 *   repair could not have caught it — the PREMISE test below asserts exactly that, so the wider
 *   pass is justified by the fixture rather than by assertion.
 *
 * HOW THE PRE-PASS STATE IS REACHED: a genuine legacy store has no `centroids_reprojected` column
 * at all and `migrate()`'s guarded ALTER backfills it to 0. These tests set the gate back to 0,
 * which is byte-for-byte the state that ALTER leaves behind.
 */
const dirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-centroid-repair-"));
  dirs.push(dir);
  return join(dir, "monet-core.db");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const TEXTS = [
  "The scheduler retries failed jobs with exponential backoff.",
  "Postgres connection pooling uses pgbouncer in transaction mode.",
  "Rolling deploys drain each node for sixty seconds before restart.",
  "Feature flags are evaluated once per request and cached per session.",
  "The ingest queue shards by tenant id and rebalances hourly.",
];

function openFileCore(path: string, port?: StoragePort): MonetCore {
  let seq = 0;
  return new MonetCore(port ?? path, {
    embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

const gateOf = (db: StoragePort): number =>
  (db.prepare(`SELECT centroids_reprojected AS value FROM sync_meta WHERE singleton = 1`).get() as { value: number }).value;

/** Put the store back in the state migrate()'s ALTER leaves a genuine pre-pass store in. */
const reopenPending = (db: StoragePort): void => {
  db.prepare(`UPDATE sync_meta SET centroids_reprojected = 0 WHERE singleton = 1`).run();
};

const setConceptVector = (db: StoragePort, conceptId: string, v: Float32Array): void => {
  db.prepare(`UPDATE concepts SET embedding = ? WHERE id = ?`).run(embToJson(v), conceptId);
};

const cos = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (l2(a) * l2(b));
};

/** The true normalized mean of a concept's live evidence, computed here rather than by the engine,
 *  so "converged" is checked against an INDEPENDENT quantity and not against the code under test. */
const trueMean = (db: StoragePort, conceptId: string): Float32Array =>
  normalizeVector(rawMean(liveObservationVectors(db, conceptId)));

/** Build one concept carrying `order.length` observations, attached in that arrival order. */
async function buildDrifted(core: MonetCore, order: number[]): Promise<string> {
  const first = await core.store(TEXTS[order[0]!]!, { circle: CIRCLE });
  for (const i of order.slice(1)) await core.store(TEXTS[i]!, { circle: CIRCLE, attachTo: first.conceptId });
  return first.conceptId;
}

/** A StoragePort that counts the centroid writes the pass makes. */
function countingPort(inner: StoragePort, sqlNeedle: string): { port: StoragePort; runs: () => number } {
  let runs = 0;
  const port: StoragePort = {
    prepare(sql: string): Statement {
      const stmt = inner.prepare(sql);
      if (!sql.includes(sqlNeedle)) return stmt;
      return {
        run: (...p: unknown[]) => { runs += 1; return stmt.run(...p); },
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
      };
    },
    exec: (sql) => inner.exec(sql),
    pragma: (source, options) => inner.pragma(source, options),
    transaction: (fn) => inner.transaction(fn),
    immediateTransaction: (fn) => inner.immediateTransaction(fn),
    inTransaction: inner.inTransaction ? () => inner.inTransaction!() : undefined,
    acquireExclusiveOwnership: () => inner.acquireExclusiveOwnership(),
    releaseExclusiveOwnership: () => inner.releaseExclusiveOwnership(),
    close: () => inner.close(),
  };
  return { port, runs: () => runs };
}

describe("repairDriftedConceptCentroids — the one-time convergence pass", () => {
  it("PREMISE: attach() leaves a UNIT-LENGTH but DRIFTED centroid, so a norm-only pass would find nothing", async () => {
    const path = tempStore();
    const core = openFileCore(path);
    try {
      const conceptId = await buildDrifted(core, [0, 1, 2, 3, 4]);
      const db = dbOf(core);
      expect(liveObservationVectors(db, conceptId)).toHaveLength(5);
      const stored = conceptVector(db, conceptId);
      // Unit — the whole point. A norm check cannot see this defect.
      expect(l2(stored)).toBeCloseTo(1, 5);
      // Drifted — off the true mean by far more than float noise.
      expect(cos(stored, trueMean(db, conceptId))).toBeLessThan(0.999);
    } finally {
      core.close();
    }
  });

  it("PREMISE: the same evidence in two arrival orders gives two different stored centroids", async () => {
    const a = openFileCore(tempStore());
    const b = openFileCore(tempStore());
    try {
      const idA = await buildDrifted(a, [0, 1, 2, 3, 4]);
      const idB = await buildDrifted(b, [4, 3, 2, 1, 0]);
      // Path-dependence, stated as a fixture fact: if this ever stops holding, the convergence
      // tests below stop being about anything.
      expect(cos(conceptVector(dbOf(a), idA), conceptVector(dbOf(b), idB))).toBeLessThan(0.999);
    } finally {
      a.close();
      b.close();
    }
  });

  it("converges a drifted centroid onto the true mean of its own evidence", async () => {
    const path = tempStore();
    let conceptId = "";
    let expected: number[] = [];
    let driftBefore = 0;
    {
      const core = openFileCore(path);
      conceptId = await buildDrifted(core, [0, 1, 2, 3, 4]);
      const db = dbOf(core);
      driftBefore = cos(conceptVector(db, conceptId), trueMean(db, conceptId));
      expect(driftBefore).toBeLessThan(0.999); // the fixture really is drifted
      expected = Array.from(trueMean(db, conceptId));
      reopenPending(db);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      const stored = conceptVector(dbOf(reopened), conceptId);
      // FLOATING-POINT IDENTICAL to the independently computed mean, not merely close. That is what
      // makes a later real recompute a no-op, which is what "converged" has to mean.
      expect(Array.from(stored)).toEqual(expected);
      expect(l2(stored)).toBeCloseTo(1, 5);
      expect(gateOf(dbOf(reopened))).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("makes the stored centroid ORDER-INDEPENDENT: two arrival orders converge to the same vector", async () => {
    const pathA = tempStore();
    const pathB = tempStore();
    let idA = "";
    let idB = "";
    for (const [path, order] of [[pathA, [0, 1, 2, 3, 4]], [pathB, [4, 3, 2, 1, 0]]] as Array<[string, number[]]>) {
      const core = openFileCore(path);
      const id = await buildDrifted(core, order);
      if (path === pathA) idA = id; else idB = id;
      reopenPending(dbOf(core));
      core.close();
    }

    const a = openFileCore(pathA);
    const b = openFileCore(pathB);
    try {
      // The mean of a set does not depend on the order it was inserted in, so after the pass the
      // two stores agree — the path-dependence the second PREMISE test measured is gone.
      expect(cos(conceptVector(dbOf(a), idA), conceptVector(dbOf(b), idB))).toBeCloseTo(1, 6);
    } finally {
      a.close();
      b.close();
    }
  });

  it("also fixes the #90 short-centroid case, which reprojection subsumes", async () => {
    const path = tempStore();
    let conceptId = "";
    let expected: number[] = [];
    {
      const core = openFileCore(path);
      conceptId = await buildDrifted(core, [0, 1, 2]);
      const db = dbOf(core);
      // Exactly what a pre-#90 recompute persisted: the mean, unnormalized.
      const short = rawMean(liveObservationVectors(db, conceptId));
      expect(l2(short)).toBeLessThan(0.999);
      setConceptVector(db, conceptId, short);
      expect(l2(conceptVector(db, conceptId))).toBeLessThan(0.999);
      expected = Array.from(trueMean(db, conceptId));
      reopenPending(db);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      expect(l2(conceptVector(dbOf(reopened), conceptId))).toBeCloseTo(1, 5);
      expect(Array.from(conceptVector(dbOf(reopened), conceptId))).toEqual(expected);
    } finally {
      reopened.close();
    }
  });

  it("leaves an all-placeholder concept at ZERO — the pass must not manufacture a measurement", async () => {
    const path = tempStore();
    let placeholderId = "";
    let driftedId = "";
    {
      const core = openFileCore(path);
      const placeholder = await core.store(TEXTS[0]!, { circle: CIRCLE });
      placeholderId = placeholder.conceptId;
      const other = await core.store(TEXTS[1]!, { circle: CIRCLE, attachTo: placeholderId });
      // Every live observation reduced to the zero PLACEHOLDER: the mean is zero and must stay so.
      const width = conceptVector(dbOf(core), placeholderId).length;
      const zeros = JSON.stringify(Array.from(new Float32Array(width)));
      setObservationVector(dbOf(core), placeholder.observationId, zeros);
      setObservationVector(dbOf(core), other.observationId, zeros);
      setConceptVector(dbOf(core), placeholderId, new Float32Array(width));
      // A drifted concept alongside it, so a pass that did nothing at all cannot pass this test.
      driftedId = await buildDrifted(core, [2, 3, 4]);
      reopenPending(dbOf(core));
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      const db = dbOf(reopened);
      expect(isZeroVector(conceptVector(db, placeholderId))).toBe(true);
      expect(l2(conceptVector(db, placeholderId))).toBe(0);
      expect(Array.from(conceptVector(db, driftedId))).toEqual(Array.from(trueMean(db, driftedId))); // the pass DID run
    } finally {
      reopened.close();
    }
  });

  it("falls back to a norm-only repair on a concept with no live evidence to reproject from", async () => {
    const path = tempStore();
    let orphanId = "";
    let shortDirection: number[] = [];
    {
      const core = openFileCore(path);
      const concept = await core.store(TEXTS[0]!, { circle: CIRCLE });
      orphanId = concept.conceptId;
      const db = dbOf(core);
      const short = rawMean([conceptVector(db, orphanId), new HashingEmbeddingProvider().embed(TEXTS[1]!)]);
      expect(l2(short)).toBeLessThan(0.999);
      setConceptVector(db, orphanId, short);
      shortDirection = Array.from(normalizeVector(Float32Array.from(short)));
      // Strip the evidence, leaving a concept the reprojection cannot serve. Done by hand: no
      // public path produces a live concept with zero live observations and a stale centroid.
      db.prepare(`DELETE FROM observations WHERE concept_id = ?`).run(orphanId);
      expect(liveObservationVectors(db, orphanId)).toHaveLength(0);
      reopenPending(db);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      const stored = conceptVector(dbOf(reopened), orphanId);
      expect(l2(stored)).toBeCloseTo(1, 5);
      // Rescaled, not steered — with no evidence, direction is all there is to preserve.
      expect(Array.from(stored)).toEqual(shortDirection);
    } finally {
      reopened.close();
    }
  });

  it("does not touch support_count, confidence or status — it is a centroid write, not a reprojection of the read-model", async () => {
    const path = tempStore();
    let conceptId = "";
    let before: { support_count: number; confidence: number; status: string; last_confirmed_at: number | null };
    {
      const core = openFileCore(path);
      conceptId = await buildDrifted(core, [0, 1, 2]);
      const db = dbOf(core);
      // Desynchronize support_count from the live count on purpose. The engine's own recompute
      // would reconcile it to observations.length; this pass must NOT, because nothing asked it to
      // and a store-wide reconciliation is a visible semantic change of its own.
      db.prepare(`UPDATE concepts SET support_count = 99 WHERE id = ?`).run(conceptId);
      before = db.prepare(
        `SELECT support_count, confidence, status, last_confirmed_at FROM concepts WHERE id = ?`,
      ).get(conceptId) as typeof before;
      expect(before.support_count).toBe(99);
      reopenPending(db);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      const db = dbOf(reopened);
      expect(Array.from(conceptVector(db, conceptId))).toEqual(Array.from(trueMean(db, conceptId))); // the pass ran
      expect(db.prepare(`SELECT support_count, confidence, status, last_confirmed_at FROM concepts WHERE id = ?`).get(conceptId)).toEqual(before);
    } finally {
      reopened.close();
    }
  });

  it("does not run a second time: a centroid clobbered AFTER the pass stays clobbered (the gate is spent)", async () => {
    const path = tempStore();
    let conceptId = "";
    {
      const core = openFileCore(path);
      conceptId = await buildDrifted(core, [0, 1, 2]);
      core.close();
    }
    { // one open with the pass pending: it runs and stamps the gate
      const core = openFileCore(path);
      reopenPending(dbOf(core));
      core.close();
    }
    {
      const core = openFileCore(path);
      expect(gateOf(dbOf(core))).toBe(1);
      core.close();
    }

    let planted: number[] = [];
    {
      const core = openFileCore(path);
      const db = dbOf(core);
      const short = rawMean(liveObservationVectors(db, conceptId));
      expect(l2(short)).toBeLessThan(0.999);
      setConceptVector(db, conceptId, short);
      planted = Array.from(short);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      expect(gateOf(dbOf(reopened))).toBe(1);
      // A pass that re-ran would silently fix this. The gate means it must survive, which is what
      // "one-time" actually asserts.
      expect(Array.from(conceptVector(dbOf(reopened), conceptId))).toEqual(planted);
    } finally {
      reopened.close();
    }
  });

  it("is a LOCAL repair: it advances no sync clock and bumps no concept's revision", async () => {
    const path = tempStore();
    let conceptId = "";
    let revisionBefore = 0;
    let clockBefore = 0;
    {
      const core = openFileCore(path);
      conceptId = await buildDrifted(core, [0, 1, 2]);
      core.close();
    }
    // A SETTLING REOPEN, and it is not padding. The FIRST reopen after a write advances
    // last_mutation_at by exactly 1 on its own — measured: 845 -> 846 on the first reopen, then 846
    // on every reopen after it, with the pass pending or not. That tick belongs to the ordinary open
    // path, and taking the baseline before it would charge this test's subject with someone else's write.
    openFileCore(path).close();

    {
      const core = openFileCore(path);
      const db = dbOf(core);
      revisionBefore = (db.prepare(`SELECT sync_revision AS v FROM concepts WHERE id = ?`).get(conceptId) as { v: number }).v;
      clockBefore = (db.prepare(`SELECT last_mutation_at AS v FROM sync_meta WHERE singleton = 1`).get() as { v: number }).v;
      reopenPending(db);
      core.close();
    }

    const reopened = openFileCore(path);
    try {
      const db = dbOf(reopened);
      expect(Array.from(conceptVector(db, conceptId))).toEqual(Array.from(trueMean(db, conceptId))); // the pass ran
      // `embedding` is in the trigger's semantic-change list, so an unsuppressed pass would tick the
      // clock and bump the revision on every row it touched — and then export all of it.
      expect((db.prepare(`SELECT sync_revision AS v FROM concepts WHERE id = ?`).get(conceptId) as { v: number }).v).toBe(revisionBefore);
      expect((db.prepare(`SELECT last_mutation_at AS v FROM sync_meta WHERE singleton = 1`).get() as { v: number }).v).toBe(clockBefore);
      // And the suppression flag it borrowed is put back, not leaked.
      expect((db.prepare(`SELECT applying_remote AS v FROM sync_meta WHERE singleton = 1`).get() as { v: number }).v).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("writes NOTHING on an already-converged store of ~900 concepts (idempotent, and that is the cheap case)", async () => {
    const path = tempStore();
    {
      const core = openFileCore(path);
      const seedId = await buildDrifted(core, [0, 1, 2]);
      const db = dbOf(core);
      // Clone the seed concept AND its observations to ~900 concepts, so the scan does the real
      // work — read every live vector, mean it, normalize — rather than skipping evidence-less rows.
      const conceptCols = (db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((c) => c.name);
      const conceptRest = conceptCols.filter((c) => c !== "id" && c !== "slug").join(", ");
      const cloneConcept = db.prepare(`INSERT INTO concepts (id, slug, ${conceptRest}) SELECT ?, ?, ${conceptRest} FROM concepts WHERE id = ?`);
      const obsCols = (db.prepare(`PRAGMA table_info(observations)`).all() as Array<{ name: string }>).map((c) => c.name);
      const obsRest = obsCols.filter((c) => c !== "id" && c !== "concept_id").join(", ");
      const cloneObs = db.prepare(
        `INSERT INTO observations (id, concept_id, ${obsRest}) SELECT ? || o.id, ?, ${obsRest} FROM observations o WHERE o.concept_id = ?`,
      );
      for (let i = 0; i < 899; i++) {
        cloneConcept.run(`bulk${i}`, `bulk-${i}`, seedId);
        cloneObs.run(`b${i}-`, `bulk${i}`, seedId);
      }
      expect((db.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n).toBe(900);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number }).n).toBe(2700);
      reopenPending(db);
      core.close();
    }

    // First pass: converges every one of them.
    const first = countingPort(new BetterSqlitePort(path), `UPDATE concepts SET embedding = ?`);
    const startedFirst = performance.now();
    const a = openFileCore(path, first.port);
    const firstMs = performance.now() - startedFirst;
    const firstWrites = first.runs();
    reopenPending(dbOf(a));
    a.close();
    expect(firstWrites).toBeGreaterThan(0); // it really had work to do

    // Second pass over the SAME, now-converged store. A wall-clock bound would be a green that
    // passes on any fast enough machine; count the WRITES instead — a converged store must produce
    // exactly zero, which is both the idempotence proof and the cheap-case proof.
    const second = countingPort(new BetterSqlitePort(path), `UPDATE concepts SET embedding = ?`);
    const startedSecond = performance.now();
    const b = openFileCore(path, second.port);
    const secondMs = performance.now() - startedSecond;
    try {
      expect(second.runs()).toBe(0);
      expect(gateOf(dbOf(b))).toBe(1);
      // Reported, not asserted — whole-constructor wall time, pass included.
      console.log(`[cost] 900 concepts / 2700 observations — first pass ${firstMs.toFixed(0)}ms (${firstWrites} writes), converged re-run ${secondMs.toFixed(0)}ms (0 writes)`);
    } finally {
      b.close();
    }
  }, 60_000);
});

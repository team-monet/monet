/**
 * STORE-TIME RESOLUTION: FIND BY EVIDENCE, CONFIRM BY IDENTITY (design of record; src/resolution.ts
 * carries the full rationale). Observation-level matches NOMINATE the candidate concept — the same
 * architecture the recall unit split gave query ranking — and the CENTROID CONFIRMS coherence,
 * which is that centroid's second life after retiring from ranking.
 *
 * These tests pin the two live defects the hybrid kills, and they pin them by CONSTRUCTION rather
 * than by assertion: each integration test first MEASURES the geometry it depends on (the concept's
 * centroid cosine and its best observation cosine against the incoming text) and asserts that the
 * defect's precondition genuinely holds in this embedding space, and only then asserts the store's
 * behavior. A fixture that stopped producing the geometry — a changed embedder, a changed blend()
 * — would fail loudly on the premise instead of passing vacuously on an outcome that no longer
 * tests anything.
 *
 *   DEFECT 1, THE BLUR ATTRACTOR (a misfile class). A consolidated concept's centroid is the mean
 *   of everything it has absorbed, so it sits near the middle of a region no member occupies. Text
 *   aimed at that middle scored >= tauAttach against the mean while agreeing with NO member — and
 *   the old rule absorbed it. Evidence-free absorption, strongest on the biggest concepts.
 *
 *   DEFECT 2, THE SILENT SPLIT. Its mirror: text that strongly matches a concept's member
 *   observations while that concept's centroid has drifted below tauAmbiguous (a bimodal concept —
 *   the mean of two clusters sits between them, near neither). The old rule read the low centroid
 *   score, created a new concept, and recorded NOTHING: the duplicate pair never reached curation.
 *   Now that disagreement is the FORK SIGNAL and it forks WITH a possible_duplicate_of edge.
 *
 * Thresholds are set per fixture. That is not tuning-to-pass: the defects are GEOMETRIC relations
 * (centroid above the attach line while no observation clears the ambiguous one, and its inverse),
 * every embedder carries its own band pair (0.55/0.4 lexical, 0.72/0.5 MiniLM —
 * recommendedThresholds), and the tests assert the relation numerically before asserting behavior.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, cosine, jsonToEmb } from "../embedding";
import { resolveIncoming, type ResolutionThresholds } from "../resolution";
import type { StoragePort } from "../storage";

const CIRCLE = "resolution";

/** Same convention as recall-unit-split.test.ts / contradiction.test.ts: reach the store directly
 *  to read raw rows the public API deliberately does not project. */
const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

/** Deterministic ids so tie-breaks are reproducible; thresholds chosen per fixture (see header). */
function newCore(thresholds: ResolutionThresholds): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    embedder: new HashingEmbeddingProvider(),
    tauAttach: thresholds.tauAttach,
    tauAmbiguous: thresholds.tauAmbiguous,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

const embedder = new HashingEmbeddingProvider();

/** The two scores the hybrid weighs, measured directly off the store — the tests' premise check. */
function geometry(core: MonetCore, conceptId: string, text: string): { centroid: number; bestObservation: number } {
  const db = dbOf(core);
  const emb = embedder.embed(text);
  const concept = db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string };
  const observations = db
    .prepare(`SELECT embedding FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`)
    .all(conceptId) as Array<{ embedding: string }>;
  return {
    centroid: cosine(emb, jsonToEmb(concept.embedding)),
    bestObservation: observations.reduce((best, row) => Math.max(best, cosine(emb, jsonToEmb(row.embedding))), 0),
  };
}

/** Seed a concept whose members are FORCED together — how consolidation actually happens, and the
 *  only way to build a store's geometry without the resolution rule under test deciding it. */
async function seedConcept(core: MonetCore, members: string[]): Promise<string> {
  const first = await core.store(members[0], { circle: CIRCLE, resolution: "forceNew" });
  for (const member of members.slice(1)) await core.store(member, { circle: CIRCLE, attachTo: first.conceptId });
  return first.conceptId;
}

const duplicateEdges = (core: MonetCore, conceptId: string): Array<{ srcId: string; dstId: string; weight: number }> =>
  core.edges({ circle: CIRCLE, type: "possible_duplicate_of" }).filter((e) => e.srcId === conceptId || e.dstId === conceptId);

interface ResolutionEventRow {
  circle: string;
  observation_id: string;
  action: string;
  mode: string;
  nominated_concept_id: string | null;
  obs_score: number | null;
  matched_observation_id: string | null;
  centroid_score: number | null;
}

const eventFor = (core: MonetCore, observationId: string): ResolutionEventRow | undefined =>
  dbOf(core).prepare(`SELECT * FROM resolution_events WHERE observation_id = ?`).get(observationId) as ResolutionEventRow | undefined;

// ---------------------------------------------------------------------------------------------
// FIXTURES. Both are real geometries in the shipping lexical embedding space, verified in-test.
// ---------------------------------------------------------------------------------------------

/** A heavily-consolidated concept: one carrier phrase, ten different specifics. Its centroid keeps
 *  the carrier (every member has it) and averages the specifics away, so it points at a middle no
 *  member occupies — the blur attractor's exact shape. */
const CARRIER = "the release deploy pipeline";
const BLURRED = [
  `${CARRIER} validates artifact checksums against the signed manifest before promotion`,
  `${CARRIER} rotates the signing key every ninety days using the vault rotation job`,
  `${CARRIER} drains each node for sixty seconds ahead of the rolling restart sequence`,
  `${CARRIER} publishes audit events to the compliance ledger for every promotion`,
  `${CARRIER} blocks promotion whenever the canary error budget is already exhausted`,
  `${CARRIER} stages build artifacts in the regional bucket before any rollout begins`,
  `${CARRIER} keeps the prior artifact generation addressable so rollback is a pointer move`,
  `${CARRIER} schedules windows away from the nightly ingest peak to limit queued work`,
  `${CARRIER} requires two approvals recorded in the change record before any promotion`,
  `${CARRIER} tags each promotion with the originating commit and the reviewer handle`,
];

/** A BIMODAL concept: one observation about connection pooling, five about design tokens. Nothing
 *  in the store says these belong together — that is the point. Its centroid sits between two
 *  clusters and is near neither, so evidence and identity are set up to disagree. */
const POOLING = "postgres connection pooling uses pgbouncer in transaction mode for every service";
const THEMING = [
  "the frontend design tokens ship as a css custom property bundle per theme",
  "theme switching swaps the css custom property bundle emitted by design tokens",
  "design token naming follows the component slot convention in the css bundle",
  "dark theme overrides only the surface and text colour tokens in that bundle",
  "the css bundle is generated at build time from the design token source of truth",
];
/** A near-restatement of POOLING: what a second session writes about the same fact. */
const POOLING_AGAIN = "postgres connection pooling uses pgbouncer in transaction mode for each service tier";

/** A COHERENT pooling concept — every member on one topic, so its centroid stays pointed. */
const POOLING_COHERENT = [
  POOLING,
  "pgbouncer transaction mode keeps the postgres connection count under the pool ceiling",
  "postgres pool sizing is derived from the pgbouncer transaction mode budget per service",
];

describe("resolution decision — the pure function", () => {
  const thresholds: ResolutionThresholds = { tauAttach: 0.8, tauAmbiguous: 0.5 };
  const nominate = (obsScore: number, centroidScore: number, conceptId = "c1") => ({
    conceptId, obsScore, centroidScore, observationId: "o1",
  });

  it("creates when nothing was nominated at all", () => {
    expect(resolveIncoming({ nomination: null, thresholds })).toEqual({ action: "created", mode: "new", score: 0 });
  });

  it("attaches when evidence matches AND identity confirms", () => {
    const decision = resolveIncoming({ nomination: nominate(0.9, 0.6), thresholds });
    expect(decision).toMatchObject({ action: "attached", mode: "attach", attachToConceptId: "c1", score: 0.9 });
    expect(decision.duplicateEdge).toBeUndefined();
  });

  it("FORK SIGNAL: evidence matches but the centroid has drifted below tauAmbiguous", () => {
    const decision = resolveIncoming({ nomination: nominate(0.9, 0.49), thresholds });
    expect(decision).toEqual({
      action: "ambiguous", mode: "fork-signal", duplicateEdge: { conceptId: "c1", weight: 0.9 },
      nearMatchId: "c1", nearMatchScore: 0.9, score: 0.9,
    });
    // Reported as "ambiguous" — the public action vocabulary is unchanged by this slice.
    expect(decision.attachToConceptId).toBeUndefined();
  });

  it("BLUR-ATTRACTOR KILL: a perfect centroid match with no evidence support never attaches", () => {
    // The centroid has NO nomination power, whether or not it is also offered as a pairing
    // candidate: 1.0 identity with sub-band evidence is a new concept either way.
    expect(resolveIncoming({ nomination: nominate(0.49, 1.0), thresholds }))
      .toMatchObject({ action: "created", mode: "new", score: 0.49 });
    const paired = resolveIncoming({
      nomination: nominate(0.49, 1.0),
      centroidTop: { conceptId: "c1", centroidScore: 1.0 },
      thresholds,
    });
    expect(paired).toMatchObject({ action: "ambiguous", mode: "blur-duplicate" });
    expect(paired.attachToConceptId).toBeUndefined();
  });

  it("forks in the ambiguous band, and exempts a correction there", () => {
    expect(resolveIncoming({ nomination: nominate(0.6, 0.6), thresholds })).toMatchObject({
      action: "ambiguous", mode: "ambiguous-fork", duplicateEdge: { conceptId: "c1", weight: 0.6 }, nearMatchScore: 0.6,
    });
    expect(resolveIncoming({ nomination: nominate(0.6, 0.6), kind: "correction", thresholds })).toMatchObject({
      action: "ambiguous", mode: "correction-attach", attachToConceptId: "c1", nearMatchScore: 0.6,
    });
  });

  it("scopes the correction exemption to the ambiguous band ONLY", () => {
    // In the fork-signal band the doubt is about the TARGET'S COHERENCE, which no assertion of
    // intent resolves: a correction cannot fix a concept by being absorbed into its incoherence.
    expect(resolveIncoming({ nomination: nominate(0.9, 0.2), kind: "correction", thresholds }).mode).toBe("fork-signal");
    // And below the band there is nothing to correct.
    expect(resolveIncoming({ nomination: nominate(0.3, 0.9), kind: "correction", thresholds }).mode).toBe("new");
  });

  it("treats both band edges as inclusive, exactly as the pre-split engine did", () => {
    expect(resolveIncoming({ nomination: nominate(0.8, 0.5), thresholds }).mode).toBe("attach");
    expect(resolveIncoming({ nomination: nominate(0.8, 0.4999999), thresholds }).mode).toBe("fork-signal");
    expect(resolveIncoming({ nomination: nominate(0.7999999, 0.9), thresholds }).mode).toBe("ambiguous-fork");
    expect(resolveIncoming({ nomination: nominate(0.5, 0.9), thresholds }).mode).toBe("ambiguous-fork");
    expect(resolveIncoming({ nomination: nominate(0.4999999, 0.9), thresholds }).mode).toBe("new");
  });

  it("never returns both an attach target and a duplicate edge", () => {
    for (const [obs, centroid] of [[0.9, 0.9], [0.9, 0.1], [0.6, 0.6], [0.1, 0.9]]) {
      for (const kind of [undefined, "correction", "fact"]) {
        for (const centroidTop of [null, { conceptId: "c2", centroidScore: 0.95 }]) {
          const d = resolveIncoming({ nomination: nominate(obs, centroid), centroidTop, kind, thresholds });
          expect(d.attachToConceptId !== undefined && d.duplicateEdge !== undefined).toBe(false);
          // Every pairing mode names its near match; no attach-or-create decision invents one.
          expect(d.nearMatchId !== undefined).toBe(d.action === "ambiguous");
          // The near match and the edge are always the same concept, at the same score.
          if (d.duplicateEdge) {
            expect(d.duplicateEdge.conceptId).toBe(d.nearMatchId);
            expect(d.duplicateEdge.weight).toBe(d.nearMatchScore);
          }
        }
      }
    }
  });
});

/**
 * THE SYMMETRIC SIGNAL (the slice's second interpretive addition, alongside the band mapping).
 * Killing the blur attractor's ABSORPTION is only half of it: without a pairing, the two concepts
 * end up with no edge of any kind, because `related` derivation deliberately stops at tauAttach —
 * a neighbour scoring at or above it used to be an attach and so needed no edge. The result was an
 * orphan pair, invisible to exactly the curation the fork signal exists to trigger.
 */
describe("resolution decision — blur-duplicate, the mirror of the fork signal", () => {
  const thresholds: ResolutionThresholds = { tauAttach: 0.8, tauAmbiguous: 0.5 };
  const top = (centroidScore: number, conceptId = "c9") => ({ conceptId, centroidScore });
  const nominate = (obsScore: number, centroidScore: number, conceptId = "c1") => ({
    conceptId, obsScore, centroidScore, observationId: "o1",
  });

  it("pairs a create with the concept whose centroid claimed identity, when NOTHING was nominated", () => {
    expect(resolveIncoming({ nomination: null, centroidTop: top(0.9), thresholds })).toEqual({
      action: "ambiguous", mode: "blur-duplicate", duplicateEdge: { conceptId: "c9", weight: 0.9 },
      nearMatchId: "c9", nearMatchScore: 0.9, score: 0,
    });
  });

  it("pairs when a nomination exists but scored below tauAmbiguous", () => {
    const decision = resolveIncoming({
      nomination: { conceptId: "c1", obsScore: 0.3, observationId: "o1", centroidScore: 0.9 },
      centroidTop: top(0.9, "c1"), thresholds,
    });
    // `score` stays the EVIDENCE score — that is what declined to attach — while the pairing is
    // reported at the centroid score that produced it. The two deliberately differ here.
    expect(decision).toMatchObject({ mode: "blur-duplicate", score: 0.3, nearMatchScore: 0.9 });
  });

  it("pairs at tauAttach exactly, and not one step below it", () => {
    // The pairing line is tauAttach, NOT tauAmbiguous: a centroid merely near is already served by
    // `related` edges, and pairing there would flood curation with every topical neighbour.
    expect(resolveIncoming({ nomination: null, centroidTop: top(0.8), thresholds }).mode).toBe("blur-duplicate");
    expect(resolveIncoming({ nomination: null, centroidTop: top(0.7999999), thresholds }).mode).toBe("new");
    expect(resolveIncoming({ nomination: null, centroidTop: top(0.6), thresholds }).mode).toBe("new");
  });

  it("gives kind=correction NO exemption here — intent cannot manufacture evidence", () => {
    const decision = resolveIncoming({
      nomination: { conceptId: "c1", obsScore: 0.2, observationId: "o1", centroidScore: 0.9 },
      centroidTop: top(0.9, "c1"), kind: "correction", thresholds,
    });
    expect(decision.mode).toBe("blur-duplicate");
    expect(decision.attachToConceptId).toBeUndefined(); // so no contradiction can be opened
  });

  it("leaves every other sub-band case a plain create", () => {
    expect(resolveIncoming({ nomination: null, thresholds }).mode).toBe("new");
    expect(resolveIncoming({ nomination: null, centroidTop: null, thresholds }).mode).toBe("new");
    expect(resolveIncoming({ nomination: nominate(0.3, 0.1), centroidTop: top(0.4), thresholds }).mode).toBe("new");
  });
});

describe("resolution — defect 1: the blur attractor", () => {
  it("refuses to absorb evidence no member observation agrees with, however well the centroid scores", async () => {
    // Bands placed either side of the measured geometry: the centroid clears tauAttach, no single
    // observation clears even tauAmbiguous.
    const core = newCore({ tauAttach: 0.78, tauAmbiguous: 0.75 });
    try {
      const blurred = await seedConcept(core, BLURRED);
      const { centroid, bestObservation } = geometry(core, blurred, CARRIER);

      // THE PREMISE, asserted not assumed: this is a real blur attractor in this embedding space.
      expect(centroid).toBeGreaterThanOrEqual(0.78);
      expect(bestObservation).toBeLessThan(0.75);
      expect(centroid).toBeGreaterThan(bestObservation); // the mean out-scores every member

      const result = await core.store(CARRIER, { circle: CIRCLE });

      // The old rule ABSORBED here. Evidence-free absorption is dead: the observation lands on a
      // new concept, and the 0.8+ centroid buys the old concept no claim on it.
      expect(result.conceptId).not.toBe(blurred);
      // The score reported is the one that DROVE the decision — evidence, not the 0.8+ centroid.
      expect(result.score).toBeCloseTo(bestObservation, 6);
      expect(result.score).toBeLessThan(centroid);

      // ...and because that centroid claimed outright identity (>= tauAttach), the pair is SURFACED
      // rather than orphaned. See the orphan-class regression below for why this half is load-bearing.
      expect(result.action).toBe("ambiguous");
      expect(result.resolutionMode).toBe("blur-duplicate");
      expect(result.nearMatchId).toBe(blurred);
      expect(result.nearMatchScore).toBeCloseTo(centroid, 6); // the CENTROID score triggered the pairing
      const edges = duplicateEdges(core, result.conceptId);
      expect(edges).toHaveLength(2);
      expect(edges[0].weight).toBeCloseTo(centroid, 6); // weight = the score that produced the pairing
    } finally {
      core.close();
    }
  });

  /**
   * THE ORPHAN CLASS, pinned. Before the blur-duplicate pairing, the kill above left the two
   * concepts with NO edge at all: `related` derivation covers [edgeSimMin, tauAttach) and skips a
   * neighbour at or above tauAttach (which used to mean "attach, no edge needed"), so nothing
   * linked them and no curation surface showed anything. This is the A/B, asserted on the exact
   * geometry: possibleDuplicates went 0 -> 1, and the pair is the right pair.
   */
  it("surfaces the pair in curation instead of orphaning it", async () => {
    const core = newCore({ tauAttach: 0.78, tauAmbiguous: 0.75 });
    try {
      const blurred = await seedConcept(core, BLURRED);
      expect(core.overview(CIRCLE).counts.possibleDuplicates).toBe(0); // BEFORE

      const result = await core.store(CARRIER, { circle: CIRCLE });

      const overview = core.overview(CIRCLE);
      expect(overview.counts.possibleDuplicates).toBe(1); // AFTER
      expect(overview.possibleDuplicates.map((p) => [p.conceptAId, p.conceptBId].sort().join("|")))
        .toContain([blurred, result.conceptId].sort().join("|"));
      // The `related` band could not have covered it: that derivation stops below tauAttach.
      expect(core.edges({ circle: CIRCLE, type: "related" })
        .some((e) => (e.srcId === result.conceptId && e.dstId === blurred) || (e.srcId === blurred && e.dstId === result.conceptId)))
        .toBe(false);
    } finally {
      core.close();
    }
  });

  it("opens no contradiction when a CORRECTION blur-duplicates, and does not absorb it", async () => {
    // A correction's only kinship here is centroid-level. Intent disambiguates a weak EVIDENCE
    // match (the ambiguous-band exemption); it cannot manufacture evidence that is not there.
    const core = newCore({ tauAttach: 0.78, tauAmbiguous: 0.75 });
    try {
      const blurred = await seedConcept(core, BLURRED);
      const before = (await core.getConcept(blurred))!.status;

      const corrected = await core.store(CARRIER, { circle: CIRCLE, kind: "correction" });

      expect(corrected.resolutionMode).toBe("blur-duplicate");
      expect(corrected.conceptId).not.toBe(blurred);
      expect(corrected.contradiction).toBeUndefined();
      expect((await core.getConcept(blurred))!.status).toBe(before);
      expect(duplicateEdges(core, corrected.conceptId)).toHaveLength(2); // but the pair IS surfaced
    } finally {
      core.close();
    }
  });

  it("still attaches to a COHERENT concept, where evidence and identity agree", async () => {
    // The control: the kill must not cost ordinary consolidation. Same store shape, coherent members.
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const coherent = await seedConcept(core, POOLING_COHERENT);
      const { centroid, bestObservation } = geometry(core, coherent, POOLING_AGAIN);
      expect(bestObservation).toBeGreaterThanOrEqual(0.85);
      expect(centroid).toBeGreaterThanOrEqual(0.5);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      expect(result.action).toBe("attached");
      expect(result.resolutionMode).toBe("attach");
      expect(result.conceptId).toBe(coherent);
    } finally {
      core.close();
    }
  });
});

describe("resolution — defect 2: the silent split", () => {
  it("forks a bimodal concept WITH a duplicate edge instead of creating in silence", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.6 });
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]);
      const { centroid, bestObservation } = geometry(core, bimodal, POOLING_AGAIN);

      // THE PREMISE: evidence says "same" (>= tauAttach), identity says "far" (< tauAmbiguous).
      expect(bestObservation).toBeGreaterThanOrEqual(0.85);
      expect(centroid).toBeLessThan(0.6);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });

      // Old behavior: action "created", no edge, pair invisible forever. New: the pair is surfaced.
      expect(result.action).toBe("ambiguous");
      expect(result.resolutionMode).toBe("fork-signal");
      expect(result.conceptId).not.toBe(bimodal);
      expect(result.nearMatchId).toBe(bimodal);
      expect(result.nearMatchScore).toBeCloseTo(bestObservation, 6); // the EVIDENCE score, not the centroid

      const edges = duplicateEdges(core, result.conceptId);
      expect(edges).toHaveLength(2); // upsertEdgeBoth: the relation is symmetric
      expect(edges.every((e) => e.srcId === bimodal || e.dstId === bimodal)).toBe(true);

      // And it reaches curation through the machinery that already mediates duplicates.
      const overview = core.overview(CIRCLE);
      expect(overview.counts.possibleDuplicates).toBe(1);
      expect(overview.possibleDuplicates.map((p) => [p.conceptAId, p.conceptBId].sort().join("|")))
        .toContain([bimodal, result.conceptId].sort().join("|"));
    } finally {
      core.close();
    }
  });
});

/**
 * ALL FOUR BANDS, one fresh store each. Deliberately NOT one shared store: every one of these
 * writes mutates the geometry the next would be measured against (an attach re-blends the target's
 * centroid; a fork adds a concept that the next input could nominate instead), so a shared fixture
 * would make each case depend on the order of the ones before it. Same threshold pair throughout —
 * only the incoming text changes, which is what makes this a band sweep rather than four anecdotes.
 */
describe("resolution — all four bands through store()", () => {
  const BANDS: ResolutionThresholds = { tauAttach: 0.85, tauAmbiguous: 0.6 };

  it("band 1 — ATTACH: evidence clears tauAttach and identity confirms", async () => {
    const core = newCore(BANDS);
    try {
      const coherent = await seedConcept(core, POOLING_COHERENT);
      const { centroid, bestObservation } = geometry(core, coherent, POOLING_AGAIN);
      expect(bestObservation).toBeGreaterThanOrEqual(0.85);
      expect(centroid).toBeGreaterThanOrEqual(0.6);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      expect([result.action, result.resolutionMode]).toEqual(["attached", "attach"]);
      expect(result.conceptId).toBe(coherent);
    } finally {
      core.close();
    }
  });

  it("band 2 — FORK SIGNAL: evidence clears tauAttach but identity is below tauAmbiguous", async () => {
    const core = newCore(BANDS);
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]);
      const { centroid, bestObservation } = geometry(core, bimodal, POOLING_AGAIN);
      expect(bestObservation).toBeGreaterThanOrEqual(0.85);
      expect(centroid).toBeLessThan(0.6);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      expect([result.action, result.resolutionMode]).toEqual(["ambiguous", "fork-signal"]);
      expect(result.nearMatchId).toBe(bimodal);
    } finally {
      core.close();
    }
  });

  it("band 3 — AMBIGUOUS FORK: evidence is merely suggestive", async () => {
    const core = newCore(BANDS);
    try {
      const coherent = await seedConcept(core, POOLING_COHERENT);
      const suggestive = "pgbouncer keeps the postgres connection count under a ceiling per service";
      const { bestObservation } = geometry(core, coherent, suggestive);
      expect(bestObservation).toBeGreaterThanOrEqual(0.6);
      expect(bestObservation).toBeLessThan(0.85);

      const result = await core.store(suggestive, { circle: CIRCLE });
      expect([result.action, result.resolutionMode]).toEqual(["ambiguous", "ambiguous-fork"]);
      expect(result.nearMatchId).toBe(coherent);
      expect(result.conceptId).not.toBe(coherent);
      expect(duplicateEdges(core, result.conceptId)).toHaveLength(2);
    } finally {
      core.close();
    }
  });

  it("band 4 — NEW: nothing in the store's evidence supports it", async () => {
    const core = newCore(BANDS);
    try {
      const coherent = await seedConcept(core, POOLING_COHERENT);
      const novel = "the sourdough starter is fed twice daily at a one to one hydration ratio";
      expect(geometry(core, coherent, novel).bestObservation).toBeLessThan(0.6);

      const result = await core.store(novel, { circle: CIRCLE });
      expect([result.action, result.resolutionMode]).toEqual(["created", "new"]);
      expect(result.nearMatchId).toBeUndefined();
      expect(duplicateEdges(core, result.conceptId)).toHaveLength(0);
    } finally {
      core.close();
    }
  });
});

describe("resolution — corrections follow the nomination", () => {
  /**
   * A correction must land on the concept whose EVIDENCE it corrects. The store here is built so
   * the two rules point at different concepts: the bimodal concept holds the matching observation
   * (evidence), while a decoy's single observation out-scores that bimodal concept's blurred
   * CENTROID (identity). The old rule sent the correction to the decoy.
   */
  it("attaches an ambiguous-band correction to the evidence match, not the nearest centroid", async () => {
    const core = newCore({ tauAttach: 0.95, tauAmbiguous: 0.5 });
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]);
      const decoy = await seedConcept(core, ["connection pooling for each service tier is reviewed quarterly by the platform team"]);

      const bimodalGeom = geometry(core, bimodal, POOLING_AGAIN);
      const decoyGeom = geometry(core, decoy, POOLING_AGAIN);
      // THE PREMISE: the two rules disagree about the target.
      expect(bimodalGeom.bestObservation).toBeGreaterThan(decoyGeom.bestObservation); // evidence -> bimodal
      expect(decoyGeom.centroid).toBeGreaterThan(bimodalGeom.centroid); // centroid -> decoy
      expect(bimodalGeom.bestObservation).toBeGreaterThanOrEqual(0.5);
      expect(bimodalGeom.bestObservation).toBeLessThan(0.95); // ambiguous band, where the exemption lives

      const corrected = await core.store(POOLING_AGAIN, { circle: CIRCLE, kind: "correction" });

      expect(corrected.action).toBe("ambiguous");
      expect(corrected.resolutionMode).toBe("correction-attach");
      expect(corrected.conceptId).toBe(bimodal);
      expect(corrected.conceptId).not.toBe(decoy);
      // The contradiction machinery is untouched and still opens on the concept it landed on.
      expect(corrected.contradiction).toBeDefined();
      expect((await core.getConcept(bimodal))!.status).toBe("disputed");
    } finally {
      core.close();
    }
  });

  it("opens NO contradiction when a correction fork-signals, because it created its own concept", async () => {
    // action="ambiguous" no longer implies "attached to something existing" — a correction whose
    // target is bimodal forks. Flagging a contradiction there would dispute a concept this very
    // call just wrote, against nothing.
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.6 });
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]);
      const before = (await core.getConcept(bimodal))!.status;

      const corrected = await core.store(POOLING_AGAIN, { circle: CIRCLE, kind: "correction" });

      expect(corrected.resolutionMode).toBe("fork-signal");
      expect(corrected.contradiction).toBeUndefined();
      expect(corrected.conceptId).not.toBe(bimodal);
      expect((await core.getConcept(bimodal))!.status).toBe(before); // the bimodal concept is untouched
      expect(duplicateEdges(core, corrected.conceptId)).toHaveLength(2); // but the pair IS surfaced
    } finally {
      core.close();
    }
  });
});

describe("resolution — what cannot be nominated", () => {
  it("does not nominate a concept with no live evidence, however near its stored centroid", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const emptied = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      // Superseded by DIRECT WRITE (the convention this suite's siblings use for states no public
      // API produces): supersedeObservation also re-projects the concept, which zeroes the centroid
      // of an evidence-less native concept and would make the premise below vacuous. Setting only
      // the supersession columns leaves the pathological pairing the design's rule 4 is about — a
      // stored centroid still pointing at a topic the store no longer holds any evidence for.
      dbOf(core).prepare(`UPDATE observations SET superseded_at = ? WHERE id = ?`).run(Date.now(), emptied.observationId);

      // THE PREMISE: an attach-strength match by IDENTITY alone, with nothing behind it.
      const { centroid, bestObservation } = geometry(core, emptied.conceptId, POOLING_AGAIN);
      expect(centroid).toBeGreaterThanOrEqual(0.85);
      expect(bestObservation).toBe(0); // nothing live left to match

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      // NOT nominated, NOT attached — the evidence-less concept has no claim on this observation.
      expect(result.conceptId).not.toBe(emptied.conceptId);
      expect(eventFor(core, result.observationId)!.nominated_concept_id).toBeNull();
      expect(result.score).toBe(0); // nothing nominated ⇒ no evidence score at all
      // Its stale centroid does still PAIR the two (blur-duplicate) — correctly: an identity vector
      // claiming an exact match with no evidence behind it is precisely what a human should look at.
      expect(result.resolutionMode).toBe("blur-duplicate");
      expect(result.nearMatchId).toBe(emptied.conceptId);
    } finally {
      core.close();
    }
  });

  it("creates rather than reviving a concept emptied through the public supersede path", async () => {
    // The same rule reached the way a real store reaches it: terminal supersession re-projects the
    // concept, so its centroid collapses too — belt and braces, and the outcome must be identical.
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const emptied = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      core.supersedeObservation(emptied.observationId, null);

      const result = await core.store(POOLING, { circle: CIRCLE });
      expect(result.conceptId).not.toBe(emptied.conceptId);
      expect(result.resolutionMode).toBe("new");
    } finally {
      core.close();
    }
  });

  it("nominates the lower concept id when two concepts hold identically-scoring evidence", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      // Same text, two concepts (forceNew asserts distinctness): a genuine, reachable tie.
      const first = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      const second = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      expect(first.conceptId < second.conceptId).toBe(true); // deterministic ids, ascending

      const result = await core.store(POOLING, { circle: CIRCLE });
      expect(result.conceptId).toBe(first.conceptId);
      expect(eventFor(core, result.observationId)!.nominated_concept_id).toBe(first.conceptId);
    } finally {
      core.close();
    }
  });
});

describe("resolution — the instrumentation log", () => {
  it("records the measured nomination on every auto-resolution mode, including the ones that lost", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.6 });
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]);

      const forked = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      const forkEvent = eventFor(core, forked.observationId)!;
      expect(forkEvent).toMatchObject({ circle: CIRCLE, action: "ambiguous", mode: "fork-signal", nominated_concept_id: bimodal });
      // Both sides of the disagreement are recorded — the log has to be able to answer "was this
      // band the right place to cut?", which needs the vetoing centroid score, not just the winner.
      expect(forkEvent.obs_score!).toBeGreaterThanOrEqual(0.85);
      expect(forkEvent.centroid_score!).toBeLessThan(0.6);
      // The specific evidence that nominated: re-examinable after the fact.
      const matched = dbOf(core)
        .prepare(`SELECT concept_id, content FROM observations WHERE id = ?`)
        .get(forkEvent.matched_observation_id!) as { concept_id: string; content: string };
      expect(matched.concept_id).toBe(bimodal);
      expect(matched.content).toBe(POOLING);

      // A "new" row still carries the sub-threshold nomination that lost.
      const novel = await core.store("the sourdough starter is fed twice daily at one to one hydration", { circle: CIRCLE });
      const novelEvent = eventFor(core, novel.observationId)!;
      expect(novelEvent.mode).toBe("new");
      expect(novelEvent.action).toBe("created");
      expect(novelEvent.obs_score!).toBeLessThan(0.6);
    } finally {
      core.close();
    }
  });

  it("records the scoring bypasses with their own modes and no scores", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const target = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      const forceNewEvent = eventFor(core, target.observationId)!;
      expect(forceNewEvent).toMatchObject({
        action: "created", mode: "force-new",
        nominated_concept_id: null, obs_score: null, matched_observation_id: null, centroid_score: null,
      });

      // attachTo bypasses scoring even though a nomination would obviously have succeeded here.
      const attached = await core.store(POOLING_AGAIN, { circle: CIRCLE, attachTo: target.conceptId });
      expect(attached.action).toBe("attached");
      expect(attached.resolutionMode).toBe("direct-attach");
      expect(attached.conceptId).toBe(target.conceptId);
      expect(eventFor(core, attached.observationId)!).toMatchObject({
        action: "attached", mode: "direct-attach",
        nominated_concept_id: null, obs_score: null, matched_observation_id: null, centroid_score: null,
      });

      // Completeness is what makes the log a RATE: one row per write, no exceptions.
      const rows = dbOf(core).prepare(`SELECT COUNT(*) AS n FROM resolution_events`).get() as { n: number };
      const observations = dbOf(core).prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number };
      expect(rows.n).toBe(observations.n);
    } finally {
      core.close();
    }
  });

  it("consumes no id generator draws of its own", async () => {
    // INSTRUMENTATION MUST NOT PERTURB WHAT IT INSTRUMENTS. An event row taking an id from the
    // engine's generator shifted every downstream concept id by one — harmless to behavior, but it
    // turned a "nothing changed" eval diff into 100+ id hunks that no longer proved anything. The
    // log takes SQLite's free rowid instead, so a store() draws exactly the ids it drew before.
    let drawn = 0;
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1,
      idGen: () => `id${(drawn++).toString().padStart(4, "0")}`,
    });
    try {
      const first = await core.store("first memory about postgres pooling", { circle: CIRCLE });
      expect(drawn).toBe(3); // observation, session, concept — the pre-instrumentation count
      expect(first.observationId).toBe("id0000");
      expect(first.conceptId).toBe("id0002");
      // And the event exists all the same, keyed by a rowid the generator never saw.
      const event = eventFor(core, first.observationId)!;
      expect(event.mode).toBe("new");
      expect(dbOf(core).prepare(`SELECT id FROM resolution_events WHERE observation_id = ?`).get(first.observationId))
        .toEqual({ id: 1 });
    } finally {
      core.close();
    }
  });

  it("replays the original mode on an idempotent retry", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const first = await core.store(POOLING, { circle: CIRCLE, operationId: "op-1" });
      const retry = await core.store("a completely different body", { circle: CIRCLE, operationId: "op-1" });
      expect(retry).toEqual(first); // a retry must be indistinguishable from the original call
      expect(retry.resolutionMode).toBe("new");
    } finally {
      core.close();
    }
  });

  it("surfaces the rates in overview, scoped to the circle", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.6 });
    try {
      const bimodal = await seedConcept(core, [POOLING, ...THEMING]); // 1 force-new + 5 direct-attach
      await core.store(POOLING_AGAIN, { circle: CIRCLE }); // fork-signal
      await core.store("the ferry to the island leaves at quarter past every hour", { circle: CIRCLE }); // new
      await core.store("a memory in another circle entirely", { circle: "elsewhere" });

      const stats = core.overview(CIRCLE).resolutionStats;
      expect(stats.windowDays).toBe(30);
      expect(Object.fromEntries(stats.byMode.map((m) => [m.mode, m.count]))).toEqual({
        "force-new": 1, "direct-attach": 5, "fork-signal": 1, new: 1,
      });
      expect(stats.windowTotal).toBe(8); // every write, bypasses included — activity, not a rate
      // THE RATE DENOMINATOR: only the writes that actually ran the rule. The six seeding writes
      // named their own target, so counting them would report a fork rate of 1/8 for a store where
      // one of the two decisions it was allowed to make forked.
      expect(stats.decidedTotal).toBe(2);
      expect(stats.total).toBe(8); // the other circle's write is not counted here
      expect(stats.byMode.map((m) => m.count)).toEqual([...stats.byMode.map((m) => m.count)].sort((a, b) => b - a));
      expect(core.overview("elsewhere").resolutionStats.total).toBe(1);
      expect(bimodal).toBeDefined();
    } finally {
      core.close();
    }
  });

  it("counts only inside its window", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const old = await core.store(POOLING, { circle: CIRCLE });
      dbOf(core).prepare(`UPDATE resolution_events SET ts = ? WHERE observation_id = ?`)
        .run(Date.now() - 40 * 24 * 60 * 60 * 1000, old.observationId);
      await core.store("the ferry to the island leaves at quarter past every hour", { circle: CIRCLE });

      const stats = core.resolutionStats(CIRCLE);
      expect(stats.windowTotal).toBe(1); // the 40-day-old row is out of the window...
      expect(stats.total).toBe(2); //     ...but never out of the log
    } finally {
      core.close();
    }
  });
});

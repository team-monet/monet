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
import { AmbiguousNominationError, MonetCore } from "../engine";
import { HashingEmbeddingProvider, cosine, jsonToEmb } from "../embedding";
import { scoreNativeConceptsByObservation } from "../retrieval";
import { LEXICAL_COVERAGE_MIN, lexicalCoverage } from "../lexical-overlap";
import { resolveIncoming, type ResolutionThresholds } from "../resolution";
import { lexicalTokens } from "../lexical-overlap";
import { NON_LATIN_LETTER_TOLERANCE, nonLatinLetterShare } from "../script-gate";
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
    tauMargin: thresholds.tauMargin,
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

/** Live (non-superseded) observations on a concept — the "did anything get absorbed" check. */
const liveObservations = (core: MonetCore, conceptId: string): number =>
  (dbOf(core)
    .prepare(`SELECT COUNT(*) AS n FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`)
    .get(conceptId) as { n: number }).n;

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

/**
 * THE #52 PAIR: two texts with NO shared topic, vocabulary or domain, whose evidence cosine lands
 * in the ambiguous band anyway. This is the fixture for the misfile the correction exemption used
 * to execute — a coherent, healthy concept about caching, and a correction about a CLI pagination
 * bug that has nothing to do with it. The measured obs-level score here is ~0.57, within a hair of
 * the 0.556 the field report carried, which is the point: in the ambiguous band the score does not
 * distinguish a weak match from no match at all, so nothing built on top of it may ATTACH.
 */
const CACHING_COHERENT = [
  "generated per-user content is cached in the regional edge store for one hour",
  "the per-user cache key includes the account tier and the rendered locale",
  "cache entries for generated content are evicted when the account tier changes",
];
const UNRELATED_CORRECTION =
  "the command line tool reports the wrong thread count when paginating past the first page";

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

  it("forks in the ambiguous band, for a correction exactly as for anything else (#52)", () => {
    const plain = resolveIncoming({ nomination: nominate(0.6, 0.6), thresholds });
    expect(plain).toMatchObject({
      action: "ambiguous", mode: "ambiguous-fork", duplicateEdge: { conceptId: "c1", weight: 0.6 }, nearMatchScore: 0.6,
    });
    // The exemption that used to attach here is gone: intent disambiguates WHAT a correction
    // asserts, never WHICH concept a weak evidence cosine points at.
    const correction = resolveIncoming({ nomination: nominate(0.6, 0.6), kind: "correction", thresholds });
    expect(correction).toEqual(plain); // byte-identical: the decision is kind-blind in this band
    expect(correction.attachToConceptId).toBeUndefined();
  });

  it("never attaches a correction below tauAttach, in ANY band", () => {
    // The whole point of #52: no band under the attach line may absorb a correction, whatever the
    // centroid is doing and whatever the caller intended.
    expect(resolveIncoming({ nomination: nominate(0.9, 0.2), kind: "correction", thresholds }).mode).toBe("fork-signal");
    expect(resolveIncoming({ nomination: nominate(0.3, 0.9), kind: "correction", thresholds }).mode).toBe("new");
    // ...and across the whole ambiguous band, including both of its edges.
    for (const obsScore of [0.5, 0.5000001, 0.556, 0.604, 0.637, 0.7, 0.7999999]) {
      const decision = resolveIncoming({ nomination: nominate(obsScore, 0.6), kind: "correction", thresholds });
      expect(decision.mode).toBe("ambiguous-fork");
      expect(decision.attachToConceptId).toBeUndefined();
      expect(decision.duplicateEdge).toEqual({ conceptId: "c1", weight: obsScore });
    }
    // The FIRST score that may attach a correction is tauAttach itself, with identity confirming.
    expect(resolveIncoming({ nomination: nominate(0.8, 0.6), kind: "correction", thresholds }))
      .toMatchObject({ action: "attached", mode: "attach", attachToConceptId: "c1" });
  });

  it("resolves identically with and without a kind, at every band boundary", () => {
    // `kind` no longer influences the decision anywhere. Pinned as an equivalence rather than as a
    // list of modes, so a future kind-specific branch cannot be added here unnoticed.
    for (const [obs, centroid] of [
      [0.4999999, 0.9], [0.5, 0.9], [0.6, 0.6], [0.7999999, 0.9], [0.8, 0.5], [0.8, 0.4999999], [0.9, 0.2],
    ]) {
      const base = resolveIncoming({ nomination: nominate(obs, centroid), thresholds });
      for (const kind of ["correction", "rule", "fact", "principle", undefined]) {
        expect(resolveIncoming({ nomination: nominate(obs, centroid), kind, thresholds })).toEqual(base);
      }
    }
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
   * A correction's near match must be the concept whose EVIDENCE it corrects. The store here is
   * built so the two rules point at different concepts: the bimodal concept holds the matching
   * observation (evidence), while a decoy's single observation out-scores that bimodal concept's
   * blurred CENTROID (identity). The pre-hybrid rule sent the correction to the decoy.
   *
   * Since #52 this band FORKS rather than attaching, so what the test pins is the surviving half:
   * nomination still follows evidence, and the pair the fork surfaces names the evidence match.
   */
  it("pairs an ambiguous-band correction with the evidence match, not the nearest centroid", async () => {
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
      expect(bimodalGeom.bestObservation).toBeLessThan(0.95); // the ambiguous band

      const corrected = await core.store(POOLING_AGAIN, { circle: CIRCLE, kind: "correction" });

      expect([corrected.action, corrected.resolutionMode]).toEqual(["ambiguous", "ambiguous-fork"]);
      // The NEAR MATCH follows the evidence — the decoy's winning centroid buys it nothing.
      expect(corrected.nearMatchId).toBe(bimodal);
      expect(corrected.nearMatchId).not.toBe(decoy);
      expect(corrected.nearMatchScore).toBeCloseTo(bimodalGeom.bestObservation, 6);
      // Nothing was absorbed, so nothing was disputed: both concepts are exactly as they were.
      expect(corrected.conceptId).not.toBe(bimodal);
      expect(corrected.contradiction).toBeUndefined();
      expect((await core.getConcept(bimodal))!.status).toBe("active");
      expect((await core.getConcept(decoy))!.status).toBe("active");
      // ...but the pair IS in front of curation, one memory_resolve from merged.
      expect(duplicateEdges(core, corrected.conceptId)).toHaveLength(2);
    } finally {
      core.close();
    }
  });

  /**
   * ISSUE #52, the field report, pinned end to end: a correction lands in the ambiguous band
   * against a concept it shares no topic with, and the store must not absorb it. The old exemption
   * attached here and — because the attach set `landedOnExisting` — opened a value-conflict
   * contradiction, flipping a healthy, unrelated concept to `disputed` and appending an unrelated
   * paragraph to its body. Four calls to undo one store, all of them needing someone to notice.
   */
  it("does not absorb an ambiguous-band correction into a topically unrelated concept", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const caching = await seedConcept(core, CACHING_COHERENT);
      const before = (await core.getConcept(caching))!;
      const { bestObservation } = geometry(core, caching, UNRELATED_CORRECTION);

      // THE PREMISE, asserted not assumed: this really is an ambiguous-band score between two
      // texts with nothing in common — the exact band the exemption used to attach in.
      expect(bestObservation).toBeGreaterThanOrEqual(0.5);
      expect(bestObservation).toBeLessThan(0.85);

      const corrected = await core.store(UNRELATED_CORRECTION, { circle: CIRCLE, kind: "correction" });

      // It forks like every other kind in this band.
      expect(corrected.conceptId).not.toBe(caching);
      expect([corrected.action, corrected.resolutionMode]).toEqual(["ambiguous", "ambiguous-fork"]);
      // And the innocent concept is untouched: no contradiction, no dispute, no appended body.
      expect(corrected.contradiction).toBeUndefined();
      const after = (await core.getConcept(caching))!;
      expect(after.status).toBe("active");
      expect(after.status).toBe(before.status);
      expect(after.body).toBe(before.body); // the unrelated sentence is NOT appended
      expect(liveObservations(core, caching)).toBe(CACHING_COHERENT.length); // 3, not 4
      // Nothing is LOST, either — the near match is still named and the pair reaches curation.
      expect(corrected.nearMatchId).toBe(caching);
      expect(corrected.nearMatchScore).toBeCloseTo(bestObservation, 6);
      expect(duplicateEdges(core, corrected.conceptId)).toHaveLength(2);
    } finally {
      core.close();
    }
  });

  /**
   * THE CONTROL FOR #52 — what the fix must NOT have cost. A correction whose evidence clears
   * tauAttach against a COHERENT concept still attaches, still absorbs, and still opens its
   * contradiction. The fix moved the evidence bar for disputing a concept; it did not touch the
   * contradiction machinery, and a genuine correction must still be able to reach it.
   */
  it("still attaches a strong correction to a coherent concept, and still disputes it", async () => {
    const core = newCore({ tauAttach: 0.85, tauAmbiguous: 0.5 });
    try {
      const coherent = await seedConcept(core, POOLING_COHERENT);
      const { centroid, bestObservation } = geometry(core, coherent, POOLING_AGAIN);
      // THE PREMISE: evidence clears tauAttach and identity confirms — the one band that attaches.
      expect(bestObservation).toBeGreaterThanOrEqual(0.85);
      expect(centroid).toBeGreaterThanOrEqual(0.5);

      const corrected = await core.store(POOLING_AGAIN, { circle: CIRCLE, kind: "correction" });

      expect([corrected.action, corrected.resolutionMode]).toEqual(["attached", "attach"]);
      expect(corrected.conceptId).toBe(coherent);
      expect(liveObservations(core, coherent)).toBe(POOLING_COHERENT.length + 1); // absorbed
      // The contradiction machinery is untouched: a well-evidenced correction still contests.
      expect(corrected.contradiction).toBeDefined();
      expect(corrected.contradiction!.status).toBe("open");
      expect((await core.getConcept(coherent))!.status).toBe("disputed");
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

      const stats = core.resolutionStats(CIRCLE);
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
      expect(core.resolutionStats("elsewhere").total).toBe(1);
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

/**
 * THE MARGIN GATE (#86): "similar enough" and "sure it is THIS one" are different questions, and
 * only the first was ever asked. These pin the SECOND, and they pin the middle of the band rather
 * than its two ends — an ask that fires only on a lone perfect match and a lone total miss would
 * be green over the entire population the gate exists for.
 *
 * The unit tests below drive resolveIncoming directly because the gate is a property of the
 * DECISION, not of any geometry: the margin arrives pre-computed from the nomination scan (the one
 * place every candidate's rank exists at once), so a fixture that had to manufacture two
 * near-equally-ranked concepts would be testing the scorer instead.
 */
describe("the margin gate", () => {
  const BANDS = { tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1 };
  const nominate = (margin?: number) => ({
    conceptId: "c0001",
    obsScore: 0.9, // clears tauAttach comfortably — this band is not what is under test
    observationId: "o1",
    centroidScore: 0.8, // clears tauAmbiguous — so the attach branch is genuinely reached
    ...(margin === undefined ? {} : { margin }),
  });

  it("asks instead of attaching when the winner is not separated from the runner-up", () => {
    const d = resolveIncoming({ nomination: nominate(0.05), thresholds: BANDS });
    expect(d.action).toBe("ask");
    expect(d.mode).toBe("ambiguous-ask");
    // It DOES name the winner — not as a destination, but because the engine has to settle whether
    // landing there was even legal (blocking rule / superseded / wrong species / another stage)
    // before it may raise the ask. Asking about a concept the write would have forked away from
    // spends a round-trip to reach the same fork.
    expect(d.attachToConceptId).toBe("c0001");
    expect(d.score).toBe(0.9);
  });

  it("attaches when the winner IS separated", () => {
    const d = resolveIncoming({ nomination: nominate(0.2), thresholds: BANDS });
    expect(d.action).toBe("attached");
    expect(d.attachToConceptId).toBe("c0001");
  });

  it("attaches exactly ON the bar — inclusive at the bottom, like every other band here", () => {
    const d = resolveIncoming({ nomination: nominate(0.1), thresholds: BANDS });
    expect(d.action).toBe("attached");
  });

  it("never asks when there was no runner-up to be separated from", () => {
    // One nominatable concept in the circle. Not ambiguity — there is nothing to choose BETWEEN —
    // and treating a missing margin as zero would refuse every write into a one-concept circle.
    const d = resolveIncoming({ nomination: nominate(undefined), thresholds: BANDS });
    expect(d.action).toBe("attached");
  });

  it("is off entirely for an embedder nobody measured it in", () => {
    const d = resolveIncoming({ nomination: nominate(0.001), thresholds: { tauAttach: 0.5, tauAmbiguous: 0.3 } });
    expect(d.action).toBe("attached"); // pre-#86 behaviour, not a borrowed number
  });

  it("does not reach into the bands below it — a sub-tauAttach score still forks on its own terms", () => {
    // The gate lives INSIDE the attach branch. A tiny margin down here must not turn a fork into an
    // ask: the decision not to attach was already made on evidence, and asking would offer the
    // caller a concept the evidence just rejected.
    const d = resolveIncoming({
      nomination: { conceptId: "c0001", obsScore: 0.4, observationId: "o1", centroidScore: 0.35, margin: 0.001 },
      thresholds: BANDS,
    });
    expect(d.action).not.toBe("ask");
    expect(d.mode).toBe("ambiguous-fork");
  });

  it("does not reach into the fork signal either", () => {
    // Evidence says attach, identity says the concept has drifted. That disagreement IS the answer;
    // a margin question on top of it would ask the caller to arbitrate a fork it cannot see.
    const d = resolveIncoming({
      nomination: { conceptId: "c0001", obsScore: 0.9, observationId: "o1", centroidScore: 0.1, margin: 0.001 },
      thresholds: BANDS,
    });
    expect(d.action).not.toBe("ask");
    expect(d.mode).toBe("fork-signal");
  });
});

/**
 * THE ASK, THROUGH THE REAL ENGINE. The unit suite above pins the decision; this pins the thing the
 * decision exists to guarantee — that an ambiguous store leaves the database exactly as it found it.
 * That invariant cannot be unit-tested: it is a property of where the refusal happens relative to
 * the write transaction, not of what resolveIncoming returns.
 *
 * Geometry first, as everywhere in this file: the fixture asserts that its two concepts really are
 * near-equally ranked before asserting that the store refuses to choose between them. A fixture that
 * drifted apart would fail on its premise instead of passing vacuously.
 */
describe("an ambiguous store writes nothing", () => {
  const rows = (core: MonetCore) => ({
    concepts: (dbOf(core).prepare(`SELECT COUNT(*) n FROM concepts`).get() as { n: number }).n,
    observations: (dbOf(core).prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n,
    events: (dbOf(core).prepare(`SELECT COUNT(*) n FROM resolution_events`).get() as { n: number }).n,
  });

  /** Two concepts about the same thing, plus a probe that belongs to neither more than the other. */
  const A = "the ferry to the island leaves at quarter past every hour";
  const B = "the ferry to the island leaves at quarter past the hour on weekends";
  const PROBE = "the ferry to the island leaves at quarter past";

  async function fixture(tauMargin?: number) {
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin });
    const a = await seedConcept(core, [A]);
    const b = await seedConcept(core, [B]);
    return { core, a, b };
  }

  it("refuses, names the candidates, and leaves every table untouched", async () => {
    const { core, a, b } = await fixture(0.1);
    try {
      // PREMISE: both clear tauAttach and nothing separates them by more than the gate.
      const ga = geometry(core, a, PROBE), gb = geometry(core, b, PROBE);
      expect(ga.bestObservation).toBeGreaterThanOrEqual(0.5);
      expect(gb.bestObservation).toBeGreaterThanOrEqual(0.5);
      expect(Math.abs(ga.bestObservation - gb.bestObservation)).toBeLessThan(0.1);

      const before = rows(core);
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);

      // THE INVARIANT. Not just "no concept" — no observation, and no resolution_event either: an
      // ask resolved nothing, so counting it would charge one store twice once the caller retries.
      expect(rows(core)).toEqual(before);

      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toMatchObject({
        candidates: expect.arrayContaining([
          expect.objectContaining({ conceptId: a }),
          expect.objectContaining({ conceptId: b }),
        ]),
      });
    } finally {
      core.close();
    }
  });

  /**
   * THE SHORTLIST IS CAPPED, AND THE CAP IS APPLIED TO THE RANKING. Two separate claims, and the
   * two-concept fixture above can prove neither: it can never overflow the cap, and any order a
   * pair comes out in is trivially sorted. So this seeds SEVEN near-tied concepts and reads both
   * claims off one ask — the payload must be the top AMBIGUOUS_CANDIDATES_MAX by rank, not the
   * first N rows the scan happened to visit and not every concept it could not choose between.
   *
   * Geometry first, as everywhere in this file, and here it does double duty: the expected ordering
   * is DERIVED from measured cosines rather than restated from the engine. That is sound only
   * because `HashingEmbeddingProvider` leaves `needsLexicalArm` unset, so the scorer defines rank as
   * the raw cosine for every input (retrieval.ts: "With it off, `rank` is a copy of `score`"). Under
   * an arm-on embedder rank and score are different quantities and this derivation would not hold.
   */
  it("offers the top AMBIGUOUS_CANDIDATES_MAX by rank — capped at five, and capped on the ordering", async () => {
    const VARIANTS = [
      A,
      B,
      "the ferry to the island leaves at quarter past on public holidays",
      "the ferry to the island leaves at quarter past during the summer",
      "the ferry to the island leaves at quarter past outside the winter",
      "the ferry to the island leaves at quarter past except on Sundays",
      "the ferry to the island leaves at quarter past unless the weather closes it",
    ];
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1 });
    try {
      const ids: string[] = [];
      for (const variant of VARIANTS) ids.push(await seedConcept(core, [variant]));

      const measured = ids
        .map((id) => ({ id, score: geometry(core, id, PROBE).bestObservation }))
        .sort((a2, b2) => b2.score - a2.score);

      // PREMISE 1: the legal set is genuinely BIGGER than the cap, and every member of it is a real
      // candidate — otherwise a length-5 payload would prove nothing about capping.
      expect(measured.length).toBeGreaterThan(5);
      for (const m of measured) expect(m.score).toBeGreaterThanOrEqual(0.5);

      // PREMISE 2: the top two sit inside the gate, so what fires below is the ambiguity ask and
      // not some other branch that also happens to refuse the write.
      expect(measured[0]!.score - measured[1]!.score).toBeLessThan(0.1);

      // PREMISE 3: the 5/6 boundary is not a tie, so "the top five" names ONE set and this test
      // cannot start flipping on a tie-break it is not about.
      expect(measured[4]!.score).toBeGreaterThan(measured[5]!.score);

      let thrown: unknown;
      try {
        await core.store(PROBE, { circle: CIRCLE });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AmbiguousNominationError);
      const { candidates } = thrown as AmbiguousNominationError;

      // THE CAP: five of the seven it could not choose between.
      expect(candidates).toHaveLength(5);
      // THE ORDERING: those five are the five highest-ranked, in rank order. Asserted as one exact
      // sequence rather than as membership — a cap applied before the sort would still be length 5
      // and would still hold "some" of the right ids.
      expect(candidates.map((c) => c.conceptId)).toEqual(measured.slice(0, 5).map((m) => m.id));
    } finally {
      core.close();
    }
  });

  it("attaches on the retry once the caller names one — the ask is answerable, not a dead end", async () => {
    const { core, a } = await fixture(0.1);
    try {
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
      const r = await core.store(PROBE, { circle: CIRCLE, attachTo: a });
      expect(r.action).toBe("attached");
      expect(r.conceptId).toBe(a);
      expect(liveObservations(core, a)).toBe(2);
    } finally {
      core.close();
    }
  });

  it("creates an UNLINKED concept on forceNew — the price of the assertion, asserted not assumed", async () => {
    // This test replaces one whose title claimed a possible_duplicate_of edge and whose assertion
    // never looked for it (`nearMatchId ?? score` is always defined). Codex caught it on PR #87.
    // forceNew records no such edge — engine.ts's forceNew branch says so — so the honest pin is
    // that the edge is ABSENT, which is what a reader needs to know before choosing this retry.
    const { core } = await fixture(0.1);
    try {
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
      const before = (dbOf(core).prepare(
        `SELECT COUNT(*) n FROM memory_edge WHERE type = 'possible_duplicate_of'`,
      ).get() as { n: number }).n;

      const r = await core.store(PROBE, { circle: CIRCLE, resolution: "forceNew" });
      expect(r.action).toBe("created");

      const after = (dbOf(core).prepare(
        `SELECT COUNT(*) n FROM memory_edge WHERE type = 'possible_duplicate_of'`,
      ).get() as { n: number }).n;
      expect(after).toBe(before); // no pairing edge — the new concept stands alone
      expect(r.nearMatchId).toBeUndefined();
    } finally {
      core.close();
    }
  });

  it("stores the same content silently when the gate is off — the fixture is not ambiguous by accident", async () => {
    // The control. Same two concepts, same probe, gate disarmed: if this ALSO refused, the tests
    // above would be pinning something other than the margin.
    const { core } = await fixture(undefined);
    try {
      const r = await core.store(PROBE, { circle: CIRCLE });
      expect(r.action).toBe("attached");
    } finally {
      core.close();
    }
  });
});

/**
 * WHAT THE REVIEW OF PR #87 ADDED. Both are cases where the gate must NOT fire, and both were
 * shipped wrong in the first draft: one refused writes on a number that never described them, the
 * other asked about a concept the write would have refused anyway.
 */
describe("the margin gate declines to fire", () => {
  const rows = (core: MonetCore) =>
    (dbOf(core).prepare(`SELECT COUNT(*) n FROM observations`).get() as { n: number }).n;

  /** Same vectors, lexical arm ON — the shipping configuration's shape, which the plain hashing
   *  provider does not have (its `needsLexicalArm` is undefined). */
  class LexicalArmProvider extends HashingEmbeddingProvider {
    readonly needsLexicalArm = true;
  }
  const armedCore = (tauMargin: number): MonetCore => {
    let seq = 0;
    return new MonetCore(":memory:", {
      embedder: new LexicalArmProvider(),
      tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin,
      idGen: () => `k${(seq++).toString().padStart(4, "0")}`,
    });
  };
  const KO_A = "페리는 매시 십오분에 섬으로 출발한다";
  const KO_B = "페리는 주말에는 매시 십오분에 섬으로 출발한다";
  const KO_PROBE = "페리는 매시 십오분에 섬으로";

  it("but NOT when the arm is off — there the raw-rank margin is exactly what was calibrated", async () => {
    // The complement, and the reason the suppression is conditional rather than blanket (Codex P2,
    // round 2). With no lexical arm the scorer defines rank as the raw cosine for EVERY input, so a
    // caller-supplied tauMargin lives in that same space and a tokenless probe is not a special case.
    // Suppressing here would silently discard an explicit override.
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1 });
    try {
      await seedConcept(core, [KO_A]);
      await seedConcept(core, [KO_B]);
      await expect(core.store(KO_PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
    } finally {
      core.close();
    }
  });

  it("when the write is a DECLARATION — the human settling a norm is already the answer", async () => {
    // declare() writes through store(), but neither DeclareInput nor the memory_declare schema
    // carries attachTo or forceNew, so an ask here aborted the declaration outright with no way to
    // answer it — and declaration is the only door a norm enters through (Codex P1, round 3; John
    // ruled exemption over extending the declare contract).
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.9 }); // ask on nearly anything
    try {
      const TEXT = "batch questions and ask them once rather than one at a time";
      await core.store(TEXT, { circle: CIRCLE, kind: "principle", resolution: "forceNew" });
      await core.store("batch questions and ask them once rather than one by one", {
        circle: CIRCLE, kind: "principle", resolution: "forceNew",
      });

      // The same content through the DECLARATION entrance must land, not refuse.
      const r = await core.declare({
        species: "principle",
        content: "batch questions and ask them once rather than one at a time",
        circle: CIRCLE,
        declaredBy: "john",
      });
      expect(r).toBeDefined();
    } finally {
      core.close();
    }
  });

  /** Did the lexical arm actually move this ranking? The engine's own test, restated for the fixture:
   *  a boosted rank differs from its raw score. */
  const armContributed = (core: MonetCore, probe: string): boolean => {
    const ids = (dbOf(core).prepare(`SELECT id FROM concepts WHERE circle = ? AND status != 'retired'`)
      .all(CIRCLE) as Array<{ id: string }>).map((r) => r.id);
    const scored = scoreNativeConceptsByObservation(dbOf(core), ids, embedder.embed(probe), probe, true);
    return [...scored.values()].some((m) => m.rank !== m.score);
  };

  it("when the lexical arm did not move the ranking — CJK, emoji, and a two-concept circle alike", async () => {
    // THREE PROXIES FAILED BEFORE THIS ONE (Codex rounds 3-6): token presence let `API` plus Korean
    // through, the SCRIPT share cannot see accented Latin, and tokenizer coverage called emoji-only
    // text fully readable. None of them could see the last case at all — in a two-concept circle
    // `tokenIdf(2, df)` clamps every weight to zero, so the arm cannot boost anything however English
    // the text is, and the margin is a raw-cosine gap that 0.12 was never calibrated against.
    for (const [label, a, b, probe] of [
      ["CJK", "페리는 매시 십오분에 섬으로 출발한다", "페리는 주말에 매시 십오분에 출발한다", "페리는 매시 십오분에 섬으로"],
      ["mixed script", "API 페리는 매시 십오분에 섬으로 출발한다", "API 페리는 주말에 십오분에 출발한다", "API 페리는 매시 십오분에"],
      ["emoji only", "🚢⏰🏝️🚢⏰", "🚢⏰🏝️🚢⏰⛵", "🚢⏰🏝️"],
    ] as Array<[string, string, string, string]>) {
      // Bar above every reachable margin (rank <= 2), so a live gate WOULD refuse these — which is
      // what makes the pass mean the guard disarmed it, rather than the geometry being generous.
      const core = armedCore(5);
      try {
        await seedConcept(core, [a]);
        await seedConcept(core, [b]);
        expect(armContributed(core, probe), `${label}: premise — the arm must be silent here`).toBe(false);
        const before = rows(core);
        const r = await core.store(probe, { circle: CIRCLE });
        expect(["attached", "created", "ambiguous"], label).toContain(r.action);
        expect(rows(core), label).toBe(before + 1);
      } finally {
        core.close();
      }
    }
  });

  it("nor in a two-concept circle, however English the text — tokenIdf clamps every weight to zero", async () => {
    // Codex's own case (P2, round 6), and the one no input-shape proxy could ever have seen: with
    // N=2 every token present in a candidate has df >= 1, so tokenIdf(2, df) = max(0, log(2/2)) = 0
    // and the arm cannot boost anything. Ordinary English, and still a raw-cosine gap.
    const core = armedCore(0.1);
    try {
      const A = "the ferry to the island leaves at quarter past every hour";
      const PROBE = "the ferry to the island leaves at quarter past";
      await seedConcept(core, [A]);
      await seedConcept(core, [A + " on weekdays"]);
      expect(armContributed(core, PROBE)).toBe(false); // premise: English, yet silent
      const before = rows(core);
      const r = await core.store(PROBE, { circle: CIRCLE });
      expect(["attached", "created", "ambiguous"]).toContain(r.action);
      expect(rows(core)).toBe(before + 1);
    } finally {
      core.close();
    }
  });

  it("nor when a shared ASCII token is the ONLY thing the arm can read", async () => {
    // Movement alone re-admits the case it was meant to close (Codex P1, round 7): a mostly-Korean
    // probe sharing one identifier with its candidates gets a positive IDF boost, so `rank !== score`
    // goes true while the Korean carries no lexical signal at all. Coverage and movement are
    // independent necessary conditions, and the second arriving was not a reason to drop the first.
    const core = armedCore(5);
    try {
      // `api` must sit in exactly ONE concept or tokenIdf clamps it: at N=3 a term in two or three
      // concepts weighs log(3/3) or less, which is zero after the clamp.
      const A = "API 페리는 매시 십오분에 섬으로 출발한다";
      const B = "페리는 주말에 매시 십오분에 출발한다";
      const C = "트램은 항구에서 다른 시간표로 운행한다";
      const PROBE = "API 페리는 매시 십오분에 섬으로";
      await seedConcept(core, [A]);
      await seedConcept(core, [B]);
      await seedConcept(core, [C]); // three concepts, so tokenIdf does not clamp to zero
      // PREMISE: the arm DOES move a rank here — movement alone would call this comparable...
      expect(armContributed(core, PROBE)).toBe(true);
      // ...while the tokenizer reads almost none of it.
      expect(lexicalCoverage(PROBE)).toBeLessThan(LEXICAL_COVERAGE_MIN);

      const before = rows(core);
      const r = await core.store(PROBE, { circle: CIRCLE });
      expect(["attached", "created", "ambiguous"]).toContain(r.action);
      expect(rows(core)).toBe(before + 1);
    } finally {
      core.close();
    }
  });

  it("but DOES fire once the arm can move a rank — the shipping configuration", async () => {
    // The complement, and the case the suite was missing: every armed fixture above has exactly two
    // concepts, where the arm is structurally silent, so none of them exercised an ask with the arm
    // ON. Three concepts give tokenIdf something to weigh.
    //
    // The bar is above every reachable margin on purpose. `rank` is `cosine * (1 + 1.0 * overlap)`
    // with both factors <= 1 and <= 2, so no gap can reach 5 — which makes this assert that the gate
    // is LIVE here, without depending on the fixture's geometry. At a realistic 0.1 this same fixture
    // attaches, because the arm separates the winner, and that is correct behaviour rather than a
    // counterexample.
    const core = armedCore(5);
    try {
      const PROBE = "the ferry to the island leaves at quarter past";
      // The probe must carry a token that lives in exactly ONE candidate, or tokenIdf zeroes it:
      // at N=3 a term in two concepts still weighs log(3/3) = 0. "leaves"/"quarter"/"past" are in
      // the first concept only, which is what gives the arm something to move.
      await seedConcept(core, ["the ferry to the island leaves at quarter past every hour"]);
      await seedConcept(core, ["the ferry to the island departs on weekends only"]);
      await seedConcept(core, ["the tram to the harbour runs on a different timetable entirely"]);
      expect(armContributed(core, PROBE)).toBe(true); // premise: the arm really does move a rank here
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
    } finally {
      core.close();
    }
  });

  it("ignores an ineligible near-tie — one legal destination is not an ambiguous choice", async () => {
    // The scan is kind-blind by design, so for a principle the runner-up can be an ordinary
    // statement that legally cannot receive it. Counting that as competition refused an eligible
    // winner, and the shortlist then offered a concept whose `attachTo` retry the same guard
    // rejects. The margin is re-derived over legal landings only (Codex P2, round 2).
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.9 }); // ask on nearly anything
    try {
      const TEXT = "the ferry to the island leaves at quarter past every hour";
      // An eligible destination for a principle...
      const home = await core.store(TEXT, { circle: CIRCLE, kind: "principle", resolution: "forceNew" });
      // ...and a near-tied statement, which is not one.
      await seedConcept(core, ["the ferry to the island leaves at quarter past every hour on weekdays"]);

      const r = await core.store("the ferry to the island leaves at quarter past every hour", {
        circle: CIRCLE,
        kind: "principle",
      });
      // Attached rather than asked: the statement was never a destination, so nothing competed.
      expect(r.action).toBe("attached");
      expect(r.conceptId).toBe(home.conceptId);
    } finally {
      core.close();
    }
  });

  it("when the winner was never a legal landing — an ineligible match forks instead of asking", async () => {
    // A principle whose top semantic match is an ordinary observation cannot attach there: the
    // cross-species guard forks it. Raising the ask first would put that concept in front of the
    // caller, who would choose it, and the retry would fork anyway — a round-trip that changes
    // nothing. So eligibility settles before the ask does.
    const core = newCore({ tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.9 }); // 0.9 = ask on nearly anything
    try {
      const A = "the ferry to the island leaves at quarter past every hour";
      const B = "the ferry to the island leaves at quarter past the hour on weekends";
      await seedConcept(core, [A]);
      await seedConcept(core, [B]);

      // Same probe, but stored as a principle: resolution nominates one of the two statements above,
      // and the species guard refuses that landing.
      const r = await core.store("the ferry to the island leaves at quarter past", {
        circle: CIRCLE,
        kind: "principle",
      });
      expect(r.action).toBe("created");
      expect(r.resolutionMode).toBe("species-fork");
    } finally {
      core.close();
    }
  });
});

/**
 * STORE-TIME RESOLUTION at the SHIPPING threshold pair — the counterpart to the mechanical band
 * tests in resolution-hybrid.test.ts, and the same argument recall-floor.onnx.test.ts makes for the
 * retrieval floor.
 *
 * WHY THIS FILE HAS TO EXIST: tauAttach/tauAmbiguous are ABSOLUTE cosines and their distributions
 * differ by model — which is exactly why this codebase keeps thresholds WITH the embedder
 * (EmbeddingProvider.recommendedThresholds). CI runs the lexical HashingEmbeddingProvider, whose
 * char-trigram overlap gives ANY two English prose texts a high similarity floor: measured here,
 * a concept holding one pooling observation and eight design-token observations still scores 0.519
 * against a pooling restatement. In that space the shipping tauAmbiguous of 0.5 is structurally
 * unreachable from below, so the lexical suite CANNOT exercise the fork signal at shipped bands —
 * every hashing band test has to place its own thresholds around the geometry it built. This file
 * closes that gap: real MiniLM, real recommendedThresholds, nothing placed by hand.
 *
 * SKIPPED by default so `pnpm test` stays offline and fast, exactly like eval.onnx.test.ts and
 * recall-floor.onnx.test.ts; the nightly job sets MONET_EVAL_ONNX=1.
 *
 * It asserts the DECISIONS, and asserts the geometry that produced them first — a fixture whose
 * bands moved under a model change must fail on the premise, not silently stop testing the case.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLocalEmbedder } from "../embedding-onnx";
import { cosine, jsonToEmb, type EmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";
import type { StoragePort } from "../storage";

const ENABLED = process.env.MONET_EVAL_ONNX === "1";
const CIRCLE = "resolution-onnx";

/**
 * A concept that has OVER-ABSORBED: one pooling observation buried under twelve unrelated ones.
 *
 * Twelve, and mutually unrelated, for a measured reason — MiniLM centroids sit HIGH. Averaging
 * pulls a vector toward the corpus mean direction, which correlates with almost any English
 * technical sentence, so a bimodal concept's centroid falls slowly: measured here, one pooling
 * observation diluted by six design-token observations still scores 0.553 against a pooling
 * restatement, and 0.545 at eight. It takes a genuinely heterogeneous majority (0.524 at six,
 * 0.480 at nine, 0.437 at twelve) to push the centroid under the shipped tauAmbiguous of 0.5.
 * That slowness is itself the finding this file exists to record: at shipped bands the fork signal
 * fires only on real drift, not on ordinary topical breadth.
 */
const POOLING = "postgres connection pooling uses pgbouncer in transaction mode for every service";
const POOLING_AGAIN = "postgres connection pooling uses pgbouncer in transaction mode for each service tier";
const UNRELATED = [
  "the sourdough starter is fed twice daily at a one to one hydration ratio",
  "arctic terns migrate from pole to pole each year following the summer",
  "prune tomato suckers in midsummer to concentrate growth in the main stem",
  "the cable stitch pattern repeats every eight rows across the wool scarf",
  "the ferry to the island leaves at quarter past every hour until dusk",
  "municipal bond funds report their dividend yield each quarter",
  "the fresco was restored using reversible pigments over three seasons",
  "the tide tables are recomputed each spring for the estuary channel",
  "a kiln is soaked at cone six for twenty minutes before the cool down",
  "the choir rehearses the descant separately from the main melody line",
  "the vineyard harvests by block according to sugar readings each morning",
  "the trail closes above the treeline once the snowpack becomes unstable",
];

describe.skipIf(!ENABLED)("store-time resolution — real MiniLM, shipped thresholds", () => {
  let embedder: EmbeddingProvider;
  let priorEmbedderEnv: string | undefined;

  beforeAll(async () => {
    priorEmbedderEnv = process.env.MONET_EMBEDDER;
    process.env.MONET_EMBEDDER = "onnx"; // require MiniLM; a broken model must fail loudly
    embedder = await createLocalEmbedder();
    expect(embedder.constructor.name).toBe("OnnxEmbeddingProvider");
  }, 240_000);

  afterAll(() => {
    if (priorEmbedderEnv === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedderEnv;
  });

  /** No tauAttach/tauAmbiguous opts anywhere: the engine derives them from the embedder itself. */
  const shippedCore = (): MonetCore => {
    let seq = 0;
    return new MonetCore(":memory:", { embedder, idGen: () => `c${(seq++).toString().padStart(4, "0")}` });
  };

  const geometry = (core: MonetCore, conceptId: string, emb: Float32Array): { centroid: number; bestObservation: number } => {
    const db = (core as unknown as { db: StoragePort }).db;
    const concept = db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string };
    const rows = db
      .prepare(`SELECT embedding FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`)
      .all(conceptId) as Array<{ embedding: string }>;
    return {
      centroid: cosine(emb, jsonToEmb(concept.embedding)),
      bestObservation: rows.reduce((best, row) => Math.max(best, cosine(emb, jsonToEmb(row.embedding))), 0),
    };
  };

  it("uses the embedder's own recommended bands", () => {
    // The premise of this whole file: nothing here places a threshold by hand.
    // PER-MODEL, DELIBERATELY PINNED. This must be updated whenever DEFAULT_MODEL changes — that is
    // the point of the assertion, not a maintenance cost. bge-small-en-v1.5 carries 0.78 from its own
    // sweep (MODEL_PROFILES, embedding-onnx.ts); the 0.72 this replaced was the legacy unmeasured
    // fallback and was never derived on any model. NOTE tauAmbiguous is 0.5 in EVERY profile, which
    // means no per-model measurement has ever produced it — tracked separately.
    expect(embedder.recommendedThresholds).toEqual({ tauAttach: 0.78, tauAmbiguous: 0.5 });
  });

  // SKIPPED — STALE FIXTURE, not a stale number (monet-core#170). This fixture was hand-sized to
  // MiniLM geometry: its own comment records "0.553 at six ... 0.437 at twelve", i.e. twelve
  // unrelated members were needed to drag the centroid just under 0.5. Under bge-small-en-v1.5 the
  // same fixture measures centroid 0.676 at n=12, 0.644 at n=24, 0.626 at n=40 — it cannot reach
  // the premise at any practical size, because bge places unrelated text at 0.26-0.51 where MiniLM
  // placed it near 0.02. Raising the number to match would produce a test that cannot fail, which
  // is what the ratified fixture principle forbids. Un-skip when the fixture is rebuilt from text
  // that genuinely produces a low centroid in THIS space.
  it.skip("FORK SIGNAL on an over-absorbed concept, at the shipped bands", async () => {
    const core = shippedCore();
    try {
      const bimodal = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      for (const member of UNRELATED) {
        await core.store(member, { circle: CIRCLE, attachTo: bimodal.conceptId });
      }

      // THE PREMISE, in the shipped space: evidence says "same", identity says "far".
      const { centroid, bestObservation } = geometry(core, bimodal.conceptId, await embedder.embed(POOLING_AGAIN));
      expect(bestObservation).toBeGreaterThanOrEqual(0.72);
      expect(centroid).toBeLessThan(0.5);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });

      expect(result.action).toBe("ambiguous");
      expect(result.resolutionMode).toBe("fork-signal");
      expect(result.conceptId).not.toBe(bimodal.conceptId);
      expect(result.nearMatchId).toBe(bimodal.conceptId);
      expect(core.overview(CIRCLE).counts.possibleDuplicates).toBe(1);
    } finally {
      core.close();
    }
  }, 120_000);

  it("still attaches a restatement to a COHERENT concept, at the same bands", async () => {
    // The control the fork signal has to survive: consolidation must still work at shipped bands,
    // or the rule would just be an expensive way to never merge anything.
    const core = shippedCore();
    try {
      const coherent = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      for (const member of [
        "pgbouncer transaction mode keeps the postgres connection count under the pool ceiling",
        "postgres pool sizing is derived from the pgbouncer transaction mode budget per service",
      ]) {
        await core.store(member, { circle: CIRCLE, attachTo: coherent.conceptId });
      }

      const { centroid, bestObservation } = geometry(core, coherent.conceptId, await embedder.embed(POOLING_AGAIN));
      expect(bestObservation).toBeGreaterThanOrEqual(0.72);
      expect(centroid).toBeGreaterThanOrEqual(0.5);

      const result = await core.store(POOLING_AGAIN, { circle: CIRCLE });
      expect(result.action).toBe("attached");
      expect(result.resolutionMode).toBe("attach");
      expect(result.conceptId).toBe(coherent.conceptId);
      expect(core.overview(CIRCLE).counts.possibleDuplicates).toBe(0);
    } finally {
      core.close();
    }
  }, 120_000);

  it("creates, and pairs nothing, for genuinely novel evidence at the same bands", async () => {
    const core = shippedCore();
    try {
      const existing = await core.store(POOLING, { circle: CIRCLE, resolution: "forceNew" });
      const novel = "the sourdough starter is fed twice daily at a one to one hydration ratio";
      const { centroid, bestObservation } = geometry(core, existing.conceptId, await embedder.embed(novel));
      expect(bestObservation).toBeLessThan(0.5);
      expect(centroid).toBeLessThan(0.72); // so no blur-duplicate pairing either

      const result = await core.store(novel, { circle: CIRCLE });
      expect(result.action).toBe("created");
      expect(result.resolutionMode).toBe("new");
      expect(core.overview(CIRCLE).counts.possibleDuplicates).toBe(0);
    } finally {
      core.close();
    }
  }, 120_000);

  /**
   * BLUR-DUPLICATE IS RARE AT SHIPPED BANDS, and this pins why rather than leaving it to be
   * rediscovered. The mode needs centroid >= 0.72 with no member observation reaching 0.5 — but in
   * MiniLM a centroid only climbs that high on genuine topical agreement, which drags its own
   * members up with it. The classic carrier fixture (eight members sharing one phrase, queried with
   * that phrase alone) reaches centroid 0.760 with best-observation 0.679: an ambiguous-band fork,
   * not a blur-duplicate. Consistent with the corpus measurement
   * (scripts/measure-resolution-bands.ts): zero >=tauAttach blur attractors observed, five
   * near-misses one band down.
   *
   * So blur-duplicate is a real geometry (exercised exhaustively in the pure-function tests and at
   * placed bands in resolution-hybrid.test.ts) that the SHIPPED configuration keeps rare — which is
   * the conservative direction, and worth knowing before anyone reads a production
   * `resolutionStats` and wonders why the count is low.
   */
  // SKIPPED — STALE FIXTURE (monet-core#170). Same cause. The eight-observation shared-carrier
  // construction reached bestObservation 0.679 under MiniLM, inside the [tauAmbiguous, tauAttach)
  // window the scenario needs. Under bge it measures 0.8032, above even the new 0.78 — so the case
  // lands in attach and the ambiguous band is never exercised. The preconditions this test asserts
  // (centroid >= 0.72, bestObservation >= 0.5) both still pass; they simply do not bound the window
  // from above, which is why the scenario moved bands silently.
  it.skip("records that a carrier-blurred concept lands in the ambiguous band, not blur-duplicate", async () => {
    const core = shippedCore();
    try {
      const carrier = "the release deploy pipeline";
      const specifics = [
        "validates artifact checksums against the signed manifest before promotion",
        "rotates the signing key every ninety days using the vault rotation job",
        "drains each node for sixty seconds ahead of the rolling restart sequence",
        "publishes audit events to the compliance ledger for every promotion",
        "blocks promotion whenever the canary error budget is already exhausted",
        "stages build artifacts in the regional bucket before any rollout begins",
        "keeps the prior artifact generation addressable so rollback is a pointer move",
        "schedules windows away from the nightly ingest peak to limit queued work",
      ];
      const blurred = await core.store(`${carrier} ${specifics[0]}`, { circle: CIRCLE, resolution: "forceNew" });
      for (const s of specifics.slice(1)) {
        await core.store(`${carrier} ${s}`, { circle: CIRCLE, attachTo: blurred.conceptId });
      }

      const { centroid, bestObservation } = geometry(core, blurred.conceptId, await embedder.embed(carrier));
      expect(centroid).toBeGreaterThanOrEqual(0.72); // identity DOES claim a match...
      expect(bestObservation).toBeGreaterThanOrEqual(0.5); // ...and the members do not disagree enough

      const result = await core.store(carrier, { circle: CIRCLE });
      expect(result.resolutionMode).toBe("ambiguous-fork");
      // Either way the pair surfaces — which is the property that actually matters.
      expect(core.overview(CIRCLE).counts.possibleDuplicates).toBe(1);
    } finally {
      core.close();
    }
  }, 120_000);
});

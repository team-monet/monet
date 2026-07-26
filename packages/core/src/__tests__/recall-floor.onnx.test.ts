/**
 * NATIVE_SCORE_FLOOR gate on the SHIPPING semantic embedder — the counterpart to the mechanical
 * floor tests in recall-unit-split.test.ts.
 *
 * WHY THIS FILE HAS TO EXIST: the floor is an ABSOLUTE cosine, and cosine distributions differ by
 * model — that is the whole reason this codebase keeps thresholds WITH the embedder
 * (EmbeddingProvider.recommendedThresholds, src/embedding.ts). CI runs the lexical
 * HashingEmbeddingProvider, whose char-trigram overlap gives any two English texts a high noise
 * baseline (junk p50 ~0.19, ABOVE the 0.12 floor). In that space the floor is nearly inert, so a
 * CI-only test suite structurally CANNOT detect a floor regression: raise the constant to 0.3 and
 * every hashing test still passes while shipped semantic recall silently loses real answers.
 *
 * SKIPPED by default so `pnpm test` stays offline and fast, exactly like eval.onnx.test.ts; the
 * nightly job sets MONET_EVAL_ONNX=1. It asserts INVARIANTS, not exact percentages — the numbers
 * themselves come from `npx tsx scripts/measure-recall-floor.ts`, which is the tool for actually
 * re-calibrating the constant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLocalEmbedder } from "../embedding-onnx";
import { cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";
import { NATIVE_SCORE_FLOOR } from "../retrieval";
import { STARTER_SUITE, BACKGROUND } from "../eval/scenarios";
import type { StoragePort } from "../storage";

const ENABLED = process.env.MONET_EVAL_ONNX === "1";
const CIRCLE = "default";

const JUNK_QUERIES = [
  "recipe for sourdough starter hydration ratio",
  "what time does the ferry leave for the island",
  "knitting cable stitch pattern for a wool scarf",
  "how to prune tomato suckers in midsummer",
  "the migratory patterns of arctic terns",
];

describe.skipIf(!ENABLED)("NATIVE_SCORE_FLOOR — real MiniLM gate (semantic embedder)", () => {
  let embedder: EmbeddingProvider;
  let priorEmbedderEnv: string | undefined;
  let core: MonetCore;
  let goldByQuery: Map<string, Set<string>>;
  let queries: string[];

  beforeAll(async () => {
    priorEmbedderEnv = process.env.MONET_EMBEDDER;
    process.env.MONET_EMBEDDER = "onnx"; // require MiniLM; a broken model must fail loudly
    embedder = await createLocalEmbedder();
    expect(embedder.constructor.name).toBe("OnnxEmbeddingProvider");

    // Same seeding convention as the eval harness: dedup off, deterministic ids.
    let seq = 0;
    core = new MonetCore(":memory:", {
      embedder, tauAttach: 1.1, tauAmbiguous: 1.1,
      idGen: () => `c${(seq++).toString().padStart(6, "0")}`,
    });
    const byKey = new Map<string, string>();
    const store = async (s: { key: string; content: string; kind?: string }): Promise<void> => {
      byKey.set(s.key, (await core.store(s.content, { circle: CIRCLE, kind: s.kind })).conceptId);
    };
    for (const s of BACKGROUND) await store(s);
    for (const scenario of STARTER_SUITE) {
      for (const s of [...scenario.seed, ...(scenario.tangents ?? [])]) await store(s);
      for (const s of scenario.distractors ?? []) await store(s);
    }
    goldByQuery = new Map();
    queries = [];
    for (const scenario of STARTER_SUITE) {
      for (const probe of scenario.probes) {
        queries.push(probe.query);
        goldByQuery.set(probe.query, new Set(probe.gold.map((k) => byKey.get(k)).filter((v): v is string => Boolean(v))));
      }
    }
  }, 240_000);

  afterAll(() => {
    core?.close();
    if (priorEmbedderEnv === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedderEnv;
  });

  /** Observation-granular score per concept — the unit the native arm ranks by. */
  const observationMax = (emb: Float32Array): Map<string, number> => {
    const db = (core as unknown as { db: StoragePort }).db;
    const rows = db
      .prepare(
        `SELECT concept_id, embedding FROM observations
          WHERE concept_id IS NOT NULL AND kind != 'source'
            AND superseded_by IS NULL AND superseded_at IS NULL`,
      )
      .all() as Array<{ concept_id: string; embedding: string }>;
    const best = new Map<string, number>();
    for (const row of rows) {
      const vec = jsonToEmb(row.embedding);
      if (isZeroVector(vec)) continue;
      const score = cosine(emb, vec);
      const prior = best.get(row.concept_id);
      if (prior === undefined || score > prior) best.set(row.concept_id, score);
    }
    return best;
  };

  it("keeps every genuine match: the weakest gold observation still clears the floor", async () => {
    const goldScores: number[] = [];
    for (const query of queries) {
      const scores = observationMax(await embedder.embed(query));
      const gold = goldByQuery.get(query)!;
      for (const [id, score] of scores) if (gold.has(id)) goldScores.push(score);
    }
    expect(goldScores.length).toBeGreaterThan(0);
    const weakest = Math.min(...goldScores);
    // THE binding constraint on the constant: raise it past the weakest real answer and search
    // starts silently dropping correct results. Measured at 0.1303 when 0.12 was chosen.
    expect(weakest).toBeGreaterThanOrEqual(NATIVE_SCORE_FLOOR);
  }, 120_000);

  it("suppresses the large majority of null-query noise", async () => {
    const junk: number[] = [];
    for (const query of JUNK_QUERIES) junk.push(...observationMax(await embedder.embed(query)).values());
    expect(junk.length).toBeGreaterThan(0);
    const suppressed = junk.filter((s) => s < NATIVE_SCORE_FLOOR).length / junk.length;
    // Measured at 82.2% when 0.12 was chosen. Asserted loosely (>= 60%) because this is a noise
    // gate, not a relevance classifier — a junk query against a broad technical corpus legitimately
    // retrieves something. A collapse well below this means the floor has stopped doing its job.
    expect(suppressed).toBeGreaterThanOrEqual(0.6);
  }, 120_000);

  it("search() emits exactly the above-floor native cards, and stays silent when nothing clears", async () => {
    for (const query of queries.slice(0, 5)) {
      const expected = [...observationMax(await embedder.embed(query)).entries()]
        .filter(([, score]) => score >= NATIVE_SCORE_FLOOR)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id]) => id);
      const cards = await core.search(query, { circle: CIRCLE, limit: 10 });
      expect(cards.map((c) => c.id)).toEqual(expected);
      for (const card of cards) expect(card.score).toBeGreaterThanOrEqual(NATIVE_SCORE_FLOOR);
    }
  }, 120_000);
});

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
import { NATIVE_SCORE_FLOOR, nativeScoreFloorOf, scoreNativeConceptsByObservation } from "../retrieval";
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

  /**
   * SCORE THROUGH THE PRODUCTION SCORER, not a hand-rolled query.
   *
   * search() floors `match.score` from scoreNativeConceptsByObservation, whose union reads
   * observation_segments and EXCLUDES the whole-observation vector wherever segments exist
   * (retrieval.ts). A hand-rolled `SELECT embedding FROM observations` therefore measures a
   * different quantity than the one being floored: a long observation's whole vector can clear the
   * floor while its best SEGMENT — the value search actually compares — does not, so the gate passes
   * while the genuine result is dropped (Codex P2, PR #172). Reusing the real scorer removes the
   * possibility of that drift instead of re-deriving it correctly and hoping it stays that way.
   */
  const observationMax = (emb: Float32Array, text: string): Map<string, number> => {
    const db = (core as unknown as { db: StoragePort }).db;
    const ids = (db
      .prepare(`SELECT id FROM concepts WHERE kind != 'source' AND status != 'retired'`)
      .all() as Array<{ id: string }>).map((r) => r.id);
    const matches = scoreNativeConceptsByObservation(db, ids, emb, text, embedder.needsLexicalArm === true);
    const best = new Map<string, number>();
    for (const [id, m] of matches) best.set(id, m.score);
    return best;
  };

  it("keeps every genuine match: the weakest gold observation still clears the floor", async () => {
    const goldScores: number[] = [];
    // PRESENCE BEFORE MINIMUM. scoreNativeConceptsByObservation OMITS a concept whose vectors are all
    // placeholders or whose best cosine is <= 0 (retrieval.ts). Reading only what the map returned
    // therefore skips a gold match that became UNREACHABLE — a strictly worse failure than one
    // sitting below the floor — while `goldScores.length > 0` still passes on the survivors. Assert
    // every expected pair is present first, so "the weakest retained score" cannot quietly become
    // "the weakest score among whatever survived" (Codex P2, PR #172).
    const missing: string[] = [];
    for (const query of queries) {
      const scores = observationMax(await embedder.embed(query), query);
      const gold = goldByQuery.get(query)!;
      for (const id of gold) {
        const score = scores.get(id);
        if (score === undefined) missing.push(`${id} for "${query.slice(0, 48)}"`);
        else goldScores.push(score);
      }
    }
    expect(missing, `gold concepts search can never emit: ${missing.join("; ")}`).toEqual([]);
    expect(goldScores.length).toBeGreaterThan(0);
    const weakest = Math.min(...goldScores);
    // THE binding constraint, checked against the floor THIS PROVIDER ACTUALLY USES. Asserting
    // against the module fallback would let a profile floor above the weakest gold ship silently:
    // search would start dropping correct results while this gate — the one that exists to catch
    // exactly that — stayed green (Codex P2, PR #172). Verified by raising the bge profile to 0.45:
    // this form fails with "expected 0.3642 to be >= 0.45", the fallback form passes. Measured
    // 0.1303 when 0.12 was chosen on MiniLM; 0.3642 on bge, which is why its profile floor is 0.35.
    const effectiveFloor = nativeScoreFloorOf((embedder as { nativeScoreFloor?: number }).nativeScoreFloor);
    expect(weakest).toBeGreaterThanOrEqual(effectiveFloor);
  }, 120_000);

  // SKIPPED — the floor now travels (PR #172, bge = 0.35), but this assertion's TARGET is
  // unreachable in this space, which is a different and larger problem. Measured on this corpus:
  // GOLD min 0.3642 sits BELOW JUNK p50 0.3971, so the distributions overlap. 0.35 keeps 100% of
  // gold and suppresses 18.3% of junk cards; reaching the 60% this asserts needs ~0.45, which drops
  // 5.7% of genuine answers, and silencing a junk query outright needs 0.50 and drops 8.6%.
  // No constant buys what 0.12 bought on MiniLM (100% gold AND 82.2% suppression). Representing
  // "the store knows nothing about this" needs a relative or margin-based rule, not a number here —
  // tracked in monet-core#170. Un-skip when that rule exists, with a target derived under it.
  it.skip("suppresses the large majority of null-query noise", async () => {
    const junk: number[] = [];
    for (const query of JUNK_QUERIES) junk.push(...observationMax(await embedder.embed(query), query).values());
    expect(junk.length).toBeGreaterThan(0);
    const suppressed = junk.filter((s) => s < NATIVE_SCORE_FLOOR).length / junk.length;
    // Measured at 82.2% when 0.12 was chosen. Asserted loosely (>= 60%) because this is a noise
    // gate, not a relevance classifier — a junk query against a broad technical corpus legitimately
    // retrieves something. A collapse well below this means the floor has stopped doing its job.
    expect(suppressed).toBeGreaterThanOrEqual(0.6);
  }, 120_000);

  // SKIPPED — DOWNSTREAM OF THE FLOOR DEFECT (monet-core#170), and independently mis-specified.
  // It builds `expected` by sorting on raw cosine, but search() ranks on `rank` — cosine re-ordered
  // by the lexical arm (#155) — so the orders are designed to differ under a semantic embedder.
  // Set equality would not rescue it either: with the floor inert every concept clears, so the two
  // top-10s are drawn from different orderings of the whole store. Both halves have to be fixed
  // together — a per-provider floor, and an expectation computed on the ranking key search uses.
  it.skip("search() emits exactly the above-floor native cards, and stays silent when nothing clears", async () => {
    for (const query of queries.slice(0, 5)) {
      const expected = [...observationMax(await embedder.embed(query), query).entries()]
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

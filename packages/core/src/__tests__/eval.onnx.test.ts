/**
 * MiniLM eval gate — the REAL-recall counterpart to eval.test.ts.
 *
 * SKIPPED by default so `pnpm test` stays offline, deterministic, and fast: it requires the
 * optional @huggingface/transformers model, which downloads on first use. The nightly CI job
 * sets MONET_EVAL_ONNX=1 to require the semantic model and run this gate.
 *
 * It asserts the same SHAPE as the deterministic gate, but on real embeddings — so a future
 * change that quietly regresses semantic recall is caught against the actual shipping path, not
 * just the lexical fallback. Numbers themselves live in `pnpm eval`; this guards value over the
 * empty baseline, not exact percentages.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLocalEmbedder } from "../embedding-onnx";
import type { EmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "../eval/scenarios";
import { noMemoryArm, monetSearchArm } from "../eval/strategies";
import { runSuite, K_LADDER } from "../eval/harness";

const ENABLED = process.env.MONET_EVAL_ONNX === "1";

describe.skipIf(!ENABLED)("memory eval — real MiniLM recall gate (semantic embedder)", () => {
  let embedder: EmbeddingProvider;
  let priorEmbedderEnv: string | undefined;

  beforeAll(async () => {
    // Require MiniLM (createLocalEmbedder throws on load failure when pref==="onnx"), so a broken
    // model fails loudly instead of silently grading the lexical fallback. Restored in afterAll so
    // the mutation can't leak even under a non-default (non-isolated) vitest pool.
    priorEmbedderEnv = process.env.MONET_EMBEDDER;
    process.env.MONET_EMBEDDER = "onnx";
    embedder = await createLocalEmbedder();
    expect(embedder.constructor.name).toBe("OnnxEmbeddingProvider");
    // 300s, not 120s: model load on a nightly runner whose CPU throughput swings ~3.5x between nights.
  }, 300_000);

  afterAll(() => {
    if (priorEmbedderEnv === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedderEnv;
  });

  it("memory beats no-memory on real embeddings", async () => {
    const report = await runSuite(STARTER_SUITE, [noMemoryArm, monetSearchArm], embedder, {
      embedderName: "MiniLM (semantic)",
    });
    const base = report.arms.find((a) => a.arm === "no-memory")!.metrics!;
    const search = report.arms.find((a) => a.arm === "monet-search")!.metrics!;

    // Baseline: an agent with no memory restores nothing and repeats everything.
    expect(base.byK[5]).toEqual({ repeatedMistakeRate: 1, reExplainRate: 1, restorationRecall: 0 });

    for (const k of K_LADDER) {
      // Value: real recall pulls back thread context the empty baseline never has.
      expect(search.byK[k].restorationRecall).toBeGreaterThan(0);
    }

    // And memory clearly helps on single-fact recall at a reasonable budget.
    expect(search.byK[5].repeatedMistakeRate).toBeLessThan(1);
    expect(search.byK[5].reExplainRate).toBeLessThan(1);
    // 600s, not 180s: THIS test completed at 166s on a red night — 14s under the old cap — and nightly runner throughput swings ~3.5x. It asserts recall, not speed.
  }, 600_000);
});

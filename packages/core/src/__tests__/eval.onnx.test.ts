/**
 * MiniLM eval gate — the REAL-recall counterpart to eval.test.ts.
 *
 * SKIPPED by default so `pnpm test` stays offline, deterministic, and fast: it requires the
 * optional @huggingface/transformers model, which downloads on first use. The nightly CI job
 * sets MONET_EVAL_ONNX=1 to require the semantic model and run this gate.
 *
 * It asserts the same SHAPE as the deterministic gate, but on real embeddings — so a future
 * change that quietly regresses semantic recall (or makes gather worse than plain search) is
 * caught against the actual shipping path, not just the lexical fallback. Numbers themselves
 * live in `pnpm eval`; this guards the invariants (value over baseline, gather completes
 * threads, no single-fact regression), not exact percentages.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLocalEmbedder } from "../embedding-onnx";
import type { EmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "../eval/scenarios";
import { noMemoryArm, monetSearchArm, monetGatherArm } from "../eval/strategies";
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
  }, 120_000);

  afterAll(() => {
    if (priorEmbedderEnv === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedderEnv;
  });

  it("memory beats no-memory, and gather completes threads without single-fact regression", async () => {
    const report = await runSuite(STARTER_SUITE, [noMemoryArm, monetSearchArm, monetGatherArm], embedder, {
      embedderName: "MiniLM (semantic)",
    });
    const base = report.arms.find((a) => a.arm === "no-memory")!.metrics!;
    const search = report.arms.find((a) => a.arm === "monet-search")!.metrics!;
    const gather = report.arms.find((a) => a.arm === "monet-gather")!.metrics!;

    // Baseline: an agent with no memory restores nothing and repeats everything.
    expect(base.byK[5]).toEqual({ repeatedMistakeRate: 1, reExplainRate: 1, restorationRecall: 0 });

    for (const k of K_LADDER) {
      // Value: real recall pulls back thread context the empty baseline never has.
      expect(search.byK[k].restorationRecall).toBeGreaterThan(0);
      // No single-fact regression from gather, at any budget.
      expect(gather.byK[k].repeatedMistakeRate).toBeLessThanOrEqual(search.byK[k].repeatedMistakeRate);
      expect(gather.byK[k].reExplainRate).toBeLessThanOrEqual(search.byK[k].reExplainRate);
      // Thread restoration: gather is never worse than plain similarity.
      expect(gather.byK[k].restorationRecall).toBeGreaterThanOrEqual(search.byK[k].restorationRecall);
    }

    // The headline #245 win on real embeddings: gather completes strictly more of a thread
    // within budget than similarity alone (the divergent member similarity plateaus short of).
    expect(gather.byK[5].restorationRecall).toBeGreaterThan(search.byK[5].restorationRecall);
    expect(gather.mrr.restoration).toBeGreaterThan(search.mrr.restoration);
    expect(gather.mrr.overall).toBeGreaterThan(search.mrr.overall);

    // And memory clearly helps on single-fact recall at a reasonable budget.
    expect(search.byK[5].repeatedMistakeRate).toBeLessThan(1);
    expect(search.byK[5].reExplainRate).toBeLessThan(1);
  }, 180_000);
});

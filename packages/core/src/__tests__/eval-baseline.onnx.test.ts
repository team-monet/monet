/**
 * md-baseline MiniLM eval gate — the REAL-recall counterpart to eval-baseline.test.ts, mirroring
 * eval.onnx.test.ts's relationship to eval.test.ts exactly (spec §2.6: slot into the EXISTING
 * two-tier pattern, don't invent a new one).
 *
 * SKIPPED by default (MONET_EVAL_ONNX=1 required) so `pnpm test` stays offline/deterministic —
 * the nightly CI job sets this env var to require the semantic model and run this gate.
 *
 * Guards invariants on REAL embeddings for the two semantic-adjacent new arms: chunk-cosine-rag
 * (an independent embedding pipeline — the whole point of spec §2.3 is that this should behave
 * SENSIBLY on real semantics, not just "not crash" the way the hashing-embedder test already
 * guards) and md-tree (still lexical/BM25 underneath, but re-run here so its numbers are
 * reported under the SAME embedder pass as the onnx artifact capture below, avoiding a second,
 * differently-seeded MiniLM run). bm25 is intentionally NOT re-verified here — it has no
 * embedding dependency, so eval-baseline.test.ts's hashing-embedder coverage already exercises
 * its only code path; a second onnx-gated run of a lexical-only arm would test nothing new.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLocalEmbedder } from "../embedding-onnx";
import type { EmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "../eval/scenarios";
import { runBaselineSuite } from "../eval/harness-baseline";
import { K_LADDER } from "../eval/harness";

const ENABLED = process.env.MONET_EVAL_ONNX === "1";

describe.skipIf(!ENABLED)("md-baseline eval — real MiniLM recall gate (semantic embedder)", () => {
  let embedder: EmbeddingProvider;
  let priorEmbedderEnv: string | undefined;

  beforeAll(async () => {
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

  it("chunk-cosine-rag (independent embedding pipeline) and md-tree find gold on real semantics, and gold-containing-file@k never drops below strict chunk-recall", async () => {
    const report = await runBaselineSuite(STARTER_SUITE, embedder, { embedderName: "MiniLM (semantic)" });
    // "md-tree (topic-files-only)" per the A3 fix — see strategies-baseline.ts's arm comment.
    expect(report.chunkArms.map((a) => a.arm)).toEqual(["chunk-cosine-rag", "md-tree (topic-files-only)"]);

    for (const arm of report.chunkArms) {
      expect(arm.available).toBe(true);
      // Real semantic recall should clear the same non-degenerate bar the hashing embedder
      // already does (this isn't a strength claim — Phase 0's crossover-curve write-up owns
      // that — just a "did real embeddings actually get exercised and find SOMETHING" gate).
      expect(arm.metrics!.mrr.overall).toBeGreaterThan(0);
      const overallChunkRecallAtK = (k: number): number => (arm.probes.length === 0 ? 0 : arm.probes.reduce((acc, p) => acc + p.recallByK[k], 0) / arm.probes.length);
      for (const k of K_LADDER) expect(arm.goldContainingFileByK[k]).toBeGreaterThanOrEqual(overallChunkRecallAtK(k) - 1e-9);
    }

    // chunk-cosine-rag specifically: on the deploy-gate PARAPHRASE probe (spec's own example of
    // where lexical retrieval fails and a real embedder should not), the independent embedding
    // pipeline should surface the gold chunk within a reasonable budget — the semantic-gap case
    // this arm exists to characterize, on real embeddings rather than the hashing fallback.
    const chunkCosineRag = report.chunkArms.find((a) => a.arm === "chunk-cosine-rag")!;
    const deployGateProbe = chunkCosineRag.probes.find((p) => p.scenarioId === "deploy-gate");
    expect(deployGateProbe).toBeDefined();
    expect(deployGateProbe!.recallByK[5]).toBeGreaterThan(0);
    // 600s, not 180s: this gate was TRUNCATED at the old 180s cap on red nights, so its true cost is unknown; eval.onnx completed at 166s on the same runner, whose throughput swings ~3.5x. It asserts recall, not speed.
  }, 600_000);
});

/**
 * Eval regression gate. Runs the suite on the DETERMINISTIC
 * lexical embedder — no network, no model download — so CI gets stable invariants:
 *   1. integrity: no gold seed merges into the background corpus (a corrupted denominator),
 *   2. value: memory strictly beats no-memory at every k and on rank quality (MRR),
 *   3. headroom: monet-search is NOT already perfect, so the eval can still gate #245.
 * The real (MiniLM) numbers come from `pnpm eval`; this test guards the shape, not the model.
 */
import { describe, it, expect } from "vitest";
import { HashingEmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "../eval/scenarios";
import { noMemoryArm, monetSearchArm, monetGatherArm } from "../eval/strategies";
import { runSuite, auditScenarios, K_LADDER } from "../eval/harness";

const embedder = (): HashingEmbeddingProvider => new HashingEmbeddingProvider();

describe("memory eval — integrity, value, and headroom (deterministic lexical embedder)", () => {
  it("keeps gold distinct from the background corpus (no merge corrupts the denominator)", async () => {
    const warnings = await auditScenarios(STARTER_SUITE, embedder());
    expect(warnings.filter((w) => w.kind === "gold-into-background")).toEqual([]);
  });

  it("covers all three metric categories with a non-trivial number of probes", async () => {
    const report = await runSuite(STARTER_SUITE, [monetSearchArm], embedder());
    const c = report.arms[0].metrics!.counts;
    expect(c).toEqual({ mistake: 6, reexplain: 8, restoration: 6 });
  });

  it("monet-search strictly improves every metric over no-memory at every k", async () => {
    const report = await runSuite(STARTER_SUITE, [noMemoryArm, monetSearchArm], embedder());
    const base = report.arms.find((a) => a.arm === "no-memory")!.metrics!;
    const search = report.arms.find((a) => a.arm === "monet-search")!.metrics!;

    for (const k of K_LADDER) {
      const b = base.byK[k];
      const s = search.byK[k];
      // Baseline sanity: no memory ⇒ repeats every mistake, re-explains every fact, restores nothing.
      expect(b).toEqual({ repeatedMistakeRate: 1, reExplainRate: 1, restorationRecall: 0 });
      // Value: memory helps on all three axes.
      expect(s.repeatedMistakeRate).toBeLessThan(1);
      expect(s.reExplainRate).toBeLessThan(1);
      expect(s.restorationRecall).toBeGreaterThan(0);
    }
    // Rank quality strictly beats the empty baseline, and isn't trivially small.
    expect(base.mrr.overall).toBe(0);
    expect(search.mrr.overall).toBeGreaterThanOrEqual(0.4);
    for (const cat of ["mistake", "reexplain", "restoration"] as const) {
      expect(search.mrr[cat]).toBeGreaterThan(0);
    }
  });

  it("leaves headroom — the eval can still gate #245", async () => {
    // If monet-search were already perfect there'd be nothing for graph-backed gather to add.
    const report = await runSuite(STARTER_SUITE, [monetSearchArm], embedder());
    const m = report.arms[0].metrics!;
    expect(m.byK[1].repeatedMistakeRate).toBeGreaterThan(0); // misses some top cards
    expect(m.byK[5].restorationRecall).toBeLessThan(1); // never fully restores a thread
    expect(m.mrr.overall).toBeLessThan(1);
  });

  it("retrieves the corrected concept within budget (port-correction)", async () => {
    const report = await runSuite(STARTER_SUITE, [monetSearchArm], embedder());
    const probe = report.arms[0].probes.find((p) => p.scenarioId === "port-correction")!;
    expect(probe.goldIds).toHaveLength(1);
    expect(probe.recallByK[3]).toBe(1);
  });

  it("graph-backed gather completes restoration threads without single-fact regression (#245)", async () => {
    // Eval-suite-level guard that the #245 win holds across the WHOLE scenario suite; the
    // function-level byte-identical precision gate lives in gather.test.ts. gather must close
    // more of a divergent thread than plain similarity, while never ranking a lone gotcha/fact
    // worse than search. Structural invariants, not magic numbers, so the suite can grow freely.
    const report = await runSuite(STARTER_SUITE, [monetSearchArm, monetGatherArm], embedder());
    const search = report.arms.find((a) => a.arm === "monet-search")!.metrics!;
    const gather = report.arms.find((a) => a.arm === "monet-gather")!.metrics!;

    for (const k of K_LADDER) {
      // No single-fact regression at any budget.
      expect(gather.byK[k].repeatedMistakeRate).toBeLessThanOrEqual(search.byK[k].repeatedMistakeRate);
      expect(gather.byK[k].reExplainRate).toBeLessThanOrEqual(search.byK[k].reExplainRate);
      // Thread restoration: gather is never worse than similarity at any budget.
      expect(gather.byK[k].restorationRecall).toBeGreaterThanOrEqual(search.byK[k].restorationRecall);
    }
    // The headline #245 result: gather completes strictly more of a thread within budget.
    expect(gather.byK[5].restorationRecall).toBeGreaterThan(search.byK[5].restorationRecall);

    // Rank quality: gather lifts restoration and overall, and never drops single-fact MRR.
    expect(gather.mrr.restoration).toBeGreaterThan(search.mrr.restoration);
    expect(gather.mrr.overall).toBeGreaterThan(search.mrr.overall);
    expect(gather.mrr.mistake).toBeGreaterThanOrEqual(search.mrr.mistake);
    expect(gather.mrr.reexplain).toBeGreaterThanOrEqual(search.mrr.reexplain);
  });
});

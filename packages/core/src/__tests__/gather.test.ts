/**
 * #245 gather tests: the pure graph functions on hand-built fixtures (decay, the precision
 * floor, the stop), gather() determinism, and the two GATES that justify the build —
 *   1. monet-gather beats monet-search on restoration (the connectivity gap), and
 *   2. it does NOT regress single-fact recall@1 (mistake / re-explain).
 * Both gates run on the deterministic lexical embedder so CI is stable.
 */
import { describe, it, expect } from "vitest";
import { spread, fuse, evidenceGapStop, DEFAULT_GRAPH_PARAMS, type Adj } from "../graph";
import { cosine } from "../embedding";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "../eval/scenarios";
import { monetSearchArm, monetGatherArm } from "../eval/strategies";
import { runSuite, K_LADDER } from "../eval/harness";

const P = DEFAULT_GRAPH_PARAMS;

describe("graph core — spread", () => {
  it("decays activation per hop and respects the hop limit", () => {
    const adj: Record<string, Adj[]> = {
      s: [{ dst: "a", type: "co_occurred", weight: 1 }],
      a: [{ dst: "b", type: "co_occurred", weight: 1 }],
      b: [{ dst: "c", type: "co_occurred", weight: 1 }],
    };
    const act = spread(new Map([["s", 1]]), (id) => adj[id] ?? [], P);
    // a is 1 hop, b is 2 hops; with gamma 0.5 and co_occurred weight 0.85: a=0.425, b=a*0.425.
    expect(act.get("a")).toBeCloseTo(0.425, 3);
    expect(act.get("b")).toBeCloseTo(0.180625, 3);
    expect(act.has("c")).toBe(false); // 3 hops away — beyond hopLimit=2
  });
});

describe("graph core — fuse (precision floor)", () => {
  it("ranks a sharp similarity hit above a swarm of weak graph neighbours", () => {
    const sim = new Map([["g", 0.9]]);
    const seedStrength = new Map([["g", 1]]);
    const activationGraph = new Map<string, number>([["g", 1]]);
    const priors = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      activationGraph.set(`n${i}`, 0.5);
      priors.set(`n${i}`, 1);
    }
    const ranked = fuse(activationGraph, sim, seedStrength, priors, P);
    expect(ranked[0].id).toBe("g"); // never demoted by breadth
    expect(ranked.find((r) => r.id === "g")!.score).toBeCloseTo(0.9, 5); // its own similarity, untouched
  });

  it("admits a pure-graph node above the floor and drops one below it", () => {
    const sim = new Map<string, number>();
    const seedStrength = new Map<string, number>();
    const priors = new Map([["hi", 1], ["lo", 1]]);
    const ranked = fuse(new Map([["hi", 0.4], ["lo", 0.1]]), sim, seedStrength, priors, P);
    const ids = ranked.map((r) => r.id);
    expect(ids).toContain("hi"); // 0.6*0.4*1 = 0.24 >= includeFloor 0.10
    expect(ids).not.toContain("lo"); // 0.6*0.1*1 = 0.06 < 0.10
  });
});

describe("graph core — evidenceGapStop", () => {
  const noEmb = (): Float32Array | null => null;
  it("stops at the seed-relative floor once past the minimum", () => {
    const ranked = [1, 0.05, 0.05, 0.05, 0.05].map((score, i) => ({ id: `n${i}`, score, viaSeed: true }));
    const { accepted, stopReason } = evidenceGapStop(ranked, 1, noEmb, cosine, P);
    expect(accepted.length).toBe(P.minNodes); // belowMin admits 3, then the tail is below floor
    expect(stopReason).toBe("floor");
  });

  it("caps at the node budget when everything stays above the floor", () => {
    const ranked = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, score: 1, viaSeed: true }));
    const { accepted, stopReason } = evidenceGapStop(ranked, 3, noEmb, cosine, P);
    expect(accepted.length).toBe(P.nodeBudget);
    expect(stopReason).toBe("budget");
  });
});

describe("gather() — determinism", () => {
  it("returns byte-identical results across repeated calls on one store", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("The AuthService validates sessions.");
    await core.store("We standardized on jose for token verification.");
    const q = "how does auth session validation work";
    expect(await core.gatherIds(q, { limit: 5 })).toEqual(await core.gatherIds(q, { limit: 5 }));
    core.close();
  });
});

describe("GATE — gather beats search on restoration without regressing single-fact", () => {
  it("lifts restoration recall and MRR, and never regresses mistake/re-explain at any k", async () => {
    const report = await runSuite(STARTER_SUITE, [monetSearchArm, monetGatherArm], new HashingEmbeddingProvider());
    const search = report.arms.find((a) => a.arm === "monet-search")!.metrics!;
    const gather = report.arms.find((a) => a.arm === "monet-gather")!.metrics!;

    // The win: more of a thread is recovered, and ranked higher.
    expect(gather.byK[5].restorationRecall).toBeGreaterThan(search.byK[5].restorationRecall);
    expect(gather.mrr.restoration).toBeGreaterThan(search.mrr.restoration);
    expect(gather.mrr.overall).toBeGreaterThanOrEqual(search.mrr.overall);

    // The guard: single-fact precision is held at every k (parity is the contract).
    for (const k of K_LADDER) {
      expect(gather.byK[k].repeatedMistakeRate).toBeLessThanOrEqual(search.byK[k].repeatedMistakeRate);
      expect(gather.byK[k].reExplainRate).toBeLessThanOrEqual(search.byK[k].reExplainRate);
      expect(gather.byK[k].restorationRecall).toBeGreaterThanOrEqual(search.byK[k].restorationRecall);
    }
  });

  it("the precision guard FIRES: gather's single-fact ranking is byte-identical to search (not just rate-parity)", async () => {
    // Rates being equal could hide an inert guard. This asserts the fuse "incoming-only, never
    // about/related, never self-seed" boost leaves the top-3 of every single-fact probe untouched.
    const report = await runSuite(STARTER_SUITE, [monetSearchArm, monetGatherArm], new HashingEmbeddingProvider());
    const probesOf = (arm: string): Map<string, string[]> =>
      new Map(
        report.arms
          .find((a) => a.arm === arm)!
          .probes.filter((p) => p.category === "mistake" || p.category === "reexplain")
          .map((p) => [p.scenarioId, p.retrievedIds.slice(0, 3)]),
      );
    const s = probesOf("monet-search");
    const g = probesOf("monet-gather");
    expect(g.size).toBeGreaterThan(0);
    for (const [scenarioId, top3] of s) expect(g.get(scenarioId)).toEqual(top3); // identical top-3, every single-fact probe
  });

  it("still retrieves the corrected concept within budget (port-correction)", async () => {
    const report = await runSuite(STARTER_SUITE, [monetGatherArm], new HashingEmbeddingProvider());
    const probe = report.arms[0].probes.find((p) => p.scenarioId === "port-correction")!;
    expect(probe.recallByK[3]).toBe(1);
  });
});

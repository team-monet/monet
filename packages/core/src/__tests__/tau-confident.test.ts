/**
 * THE MARGIN GATE'S UPPER BOUND (tauConfident).
 *
 * #86 put a SEPARATION test inside the attach branch: an above-tauAttach nomination is only taken
 * silently when the winner stands `tauMargin` clear of the runner-up, and otherwise the store
 * refuses and hands the caller the candidates. That test reads exactly one quantity — the gap
 * between two ranks — so a genuine near-tie makes it ask no matter what else is known about the
 * winner.
 *
 * But something else IS known about the winner, and this branch has already read it: `centroidScore`,
 * how well the incoming evidence agrees with everything that concept already holds. The branch
 * consults it once, to establish coherence at all (`>= tauAmbiguous`), and then never again. A
 * near-tie between a coherent home and some neighbour is not the same situation as a near-tie
 * between two neighbours the evidence sits inside neither of; the margin alone cannot tell those
 * apart, and a second witness can. tauConfident is that bound: at or above it, coherence is
 * confirmed emphatically enough that the separation question is not worth a round-trip.
 *
 * WHAT MUST NOT MOVE, and is pinned below as hard as what does:
 *
 *   - IT SITS INSIDE THE ATTACH BRANCH, after the tauAmbiguous check and never instead of it. A high
 *     centroid cannot rescue a fork signal or reach into the ambiguous band; those decisions are
 *     about evidence, and nothing here may turn the ABSENCE of coherence into an attach.
 *   - A PROFILE WITHOUT IT BEHAVES EXACTLY AS BEFORE. Undefined means no upper bound — the same
 *     honest default tauMargin itself takes rather than borrowing a number from another cosine space.
 *   - THE DECLARATION EXEMPTION IS UNTOUCHED. A declaration never asks, with or without this bound.
 *
 * The band-boundary tests drive `resolveIncoming` directly, for the reason the margin-gate suite in
 * resolution-hybrid.test.ts gives: the gate is a property of the DECISION, and the centroid score
 * arrives pre-computed from the nomination scan. Manufacturing a fixture whose geometry happens to
 * land on a chosen centroid would test the scorer instead. The engine tests below then prove the
 * plumbing — MonetCoreOptions and the embedder profile both reach the decision.
 */
import { describe, it, expect } from "vitest";
import { AmbiguousNominationError, MonetCore } from "../engine";
import { HashingEmbeddingProvider, cosine, jsonToEmb } from "../embedding";
import { OnnxEmbeddingProvider, DEFAULT_MODEL } from "../embedding-onnx";
import { resolveIncoming, type ResolutionThresholds } from "../resolution";
import type { StoragePort } from "../storage";

const CIRCLE = "tau-confident";
const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

describe("tauConfident — the decision", () => {
  // tauMargin 0.1 with every nomination below it: the margin gate is ARMED and would ask on all of
  // these. Whatever attaches here, attaches because of the bound under test and nothing else.
  const BANDS: ResolutionThresholds = { tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1, tauConfident: 0.81 };
  const nominate = (centroidScore: number, margin = 0.01) => ({
    conceptId: "c0001",
    obsScore: 0.9, // clears tauAttach comfortably — that band is not what is under test
    observationId: "o1",
    centroidScore,
    margin,
  });

  it("PREMISE: with no upper bound these nominations all ASK — every green below is a change, not a default", () => {
    const { tauConfident, ...noBound } = BANDS;
    expect(tauConfident).toBe(0.81);
    for (const centroid of [0.80, 0.81, 0.95]) {
      expect(resolveIncoming({ nomination: nominate(centroid), thresholds: noBound }).action).toBe("ask");
    }
  });

  it("attaches without consulting the margin when the centroid clears the bound", () => {
    const d = resolveIncoming({ nomination: nominate(0.95), thresholds: BANDS });
    expect(d).toMatchObject({ action: "attached", mode: "attach", attachToConceptId: "c0001", score: 0.9 });
    expect(d.duplicateEdge).toBeUndefined();
  });

  it("still asks when the centroid does NOT clear the bound", () => {
    const d = resolveIncoming({ nomination: nominate(0.80), thresholds: BANDS });
    expect(d.action).toBe("ask");
    expect(d.mode).toBe("ambiguous-ask");
    expect(d.attachToConceptId).toBe("c0001"); // still names its winner — the engine settles legality first
  });

  it("attaches exactly ON the bound — `>=`, like every other band boundary in resolution.ts", () => {
    expect(resolveIncoming({ nomination: nominate(0.81), thresholds: BANDS }).action).toBe("attached");
    // And the value one float below it does not, so the boundary is pinned from both sides rather
    // than merely satisfied from one.
    expect(resolveIncoming({ nomination: nominate(0.8099999), thresholds: BANDS }).action).toBe("ask");
  });

  it("is OFF for a profile nobody measured it in — no bound rather than a borrowed one", () => {
    const unmeasured: ResolutionThresholds = { tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1 };
    // A centroid of 1.0 — perfect agreement — still asks, because no one has said where the bound
    // belongs in this space. That is the same rule tauMargin follows for its own absence.
    expect(resolveIncoming({ nomination: nominate(1.0), thresholds: unmeasured }).action).toBe("ask");
  });

  it("changes nothing when the margin was already clear — it removes asks, it does not create attaches", () => {
    const wide = resolveIncoming({ nomination: nominate(0.95, 0.5), thresholds: BANDS });
    const wideNoBound = resolveIncoming({
      nomination: nominate(0.95, 0.5),
      thresholds: { tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1 },
    });
    expect(wide).toEqual(wideNoBound);
  });

  it("does NOT rescue a fork signal — a high centroid is impossible there, and a bypass must not invent one", () => {
    // Belt and braces on the ORDERING. The fork-signal branch is `centroidScore < tauAmbiguous`, so
    // a score at or above tauConfident cannot reach it while tauConfident > tauAmbiguous. This pins
    // that the bound is evaluated INSIDE the coherence-confirmed branch, so a future edit that moved
    // it above the tauAmbiguous check — where a misconfigured tauConfident BELOW tauAmbiguous would
    // start attaching drifted concepts — fails here instead of shipping.
    const inverted: ResolutionThresholds = { tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.1, tauConfident: 0.2 };
    const d = resolveIncoming({
      nomination: { conceptId: "c0001", obsScore: 0.9, observationId: "o1", centroidScore: 0.25, margin: 0.01 },
      thresholds: inverted,
    });
    expect(d.action).toBe("ambiguous");
    expect(d.mode).toBe("fork-signal");
  });

  it("does not reach into the ambiguous band below tauAttach", () => {
    // Evidence never cleared tauAttach, so no attach was on the table for a bound to take. A
    // confident centroid down here is the blur attractor's own signature and must still fork.
    const d = resolveIncoming({
      nomination: { conceptId: "c0001", obsScore: 0.4, observationId: "o1", centroidScore: 0.99, margin: 0.01 },
      thresholds: BANDS,
    });
    expect(d.action).toBe("ambiguous");
    expect(d.mode).toBe("ambiguous-fork");
  });
});

/**
 * THROUGH THE REAL ENGINE. The unit suite pins the decision; this pins that the number reaches it —
 * from an explicit MonetCoreOptions override and from the embedder's own profile — and that the one
 * caller-facing behaviour anyone would notice (the ask, which aborts the write) actually stops.
 *
 * Geometry first, as everywhere in this area: the fixture MEASURES the winner's centroid score
 * before placing a bound either side of it. A fixture whose geometry drifted would otherwise stop
 * testing the case while still passing.
 */
describe("tauConfident — through store()", () => {
  const A = "the ferry to the island leaves at quarter past every hour";
  const B = "the ferry to the island leaves at quarter past the hour on weekends";
  const PROBE = "the ferry to the island leaves at quarter past";

  const newCore = (tauConfident?: number): MonetCore => {
    let seq = 0;
    return new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(),
      tauAttach: 0.5, tauAmbiguous: 0.3, tauMargin: 0.9, // 0.9 = ask on nearly anything
      tauConfident,
      idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
    });
  };

  const seed = async (core: MonetCore, text: string): Promise<string> =>
    (await core.store(text, { circle: CIRCLE, resolution: "forceNew" })).conceptId;

  /** cosine(probe, concept centroid) — the exact quantity the bound is compared against. */
  const centroidScore = (core: MonetCore, conceptId: string, text: string): number => {
    const emb = new HashingEmbeddingProvider().embed(text);
    const row = dbOf(core).prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string };
    return cosine(emb, jsonToEmb(row.embedding));
  };

  it("PREMISE + RED: with no bound, this store ASKS and writes nothing", async () => {
    const core = newCore();
    try {
      const a = await seed(core, A);
      await seed(core, B);
      // The winner's centroid is high — which is exactly the situation the bound is about, and the
      // situation in which the margin gate nonetheless refuses today.
      expect(centroidScore(core, a, PROBE)).toBeGreaterThan(0.81);
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
    } finally {
      core.close();
    }
  });

  it("GREEN: the same store attaches once a bound below that centroid is supplied", async () => {
    const core = newCore(0.81);
    try {
      const a = await seed(core, A);
      await seed(core, B);
      const winnerCentroid = centroidScore(core, a, PROBE);
      expect(winnerCentroid).toBeGreaterThanOrEqual(0.81); // the bound really is cleared here

      const r = await core.store(PROBE, { circle: CIRCLE });
      expect(r.action).toBe("attached");
      expect(r.resolutionMode).toBe("attach");
    } finally {
      core.close();
    }
  });

  it("a bound ABOVE the winner's centroid leaves the ask exactly where it was", async () => {
    const core = newCore(0.999);
    try {
      const a = await seed(core, A);
      await seed(core, B);
      expect(centroidScore(core, a, PROBE)).toBeLessThan(0.999); // premise: the bound is out of reach
      await expect(core.store(PROBE, { circle: CIRCLE })).rejects.toThrow(AmbiguousNominationError);
    } finally {
      core.close();
    }
  });

  it("the DECLARATION exemption is unchanged — a declaration lands whether or not the bound fires", async () => {
    // Two cores, one bound out of reach and one absent, so the declaration path is exercised in the
    // state where the ask WOULD be pending. If tauConfident had displaced the exemption rather than
    // sitting beside it, one of these would refuse.
    for (const bound of [undefined, 0.999]) {
      const core = newCore(bound);
      try {
        const TEXT = "batch questions and ask them once rather than one at a time";
        await core.store(TEXT, { circle: CIRCLE, kind: "principle", resolution: "forceNew" });
        await core.store("batch questions and ask them once rather than one by one", {
          circle: CIRCLE, kind: "principle", resolution: "forceNew",
        });
        const r = await core.declare({
          species: "principle",
          content: TEXT,
          circle: CIRCLE,
          declaredBy: "john",
        });
        expect(r).toBeDefined();
      } finally {
        core.close();
      }
    }
  });
});

describe("tauConfident — the shipped profile carries it", () => {
  it("the default model recommends 0.81, and an unprofiled model recommends no bound at all", () => {
    // Offline: OnnxEmbeddingProvider reads its profile at construction and loads the model lazily.
    const shipped = new OnnxEmbeddingProvider({});
    expect(shipped.modelId).toBe(DEFAULT_MODEL);
    expect(shipped.recommendedThresholds?.tauConfident).toBe(0.81);

    // PER-MODEL AND NOT BORROWED. A model nobody swept gets `undefined` here, which the decision
    // reads as "no upper bound" — the same rule tauMargin follows. If this ever starts returning a
    // number, a default has leaked into a space it was never derived in.
    const unprofiled = new OnnxEmbeddingProvider({ model: "Xenova/some-model-nobody-measured" });
    expect(unprofiled.recommendedThresholds?.tauConfident).toBeUndefined();
  });
});

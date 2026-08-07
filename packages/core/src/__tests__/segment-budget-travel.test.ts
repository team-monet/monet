/**
 * DOES THE SEGMENT BUDGET ACTUALLY TRAVEL?
 *
 * `reliableSegmentTokens` is declared on the provider, populated from MODEL_PROFILES, and read by
 * `segmentTokenBudget`. Every one of those three links can be present while the value still never
 * arrives — a field declared but never assigned reads `undefined`, falls back to the module constant,
 * and behaves exactly like a working travel mechanism until someone measures the space.
 *
 * That is not a hypothetical failure mode. It is the one this whole change exists to fix:
 * `tauAmbiguous` sits inside MODEL_PROFILES with a per-model-looking value of 0.5 in every single
 * profile, which means no per-model measurement has ever produced it. Presence in the mechanism is
 * not evidence of travel. So this test asserts the value ARRIVES, and that a provider without a
 * profile falls back rather than inheriting another model's number.
 *
 * Runs on no model: `segmentTokenBudget` only needs `inputWindow`/`countTokens`, so the providers
 * here are plain objects.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { segmentTokenBudget } from "../observation-segmenter";
import { RELIABLE_EMBED_TOKENS } from "../embed-budget";
import { NATIVE_SCORE_FLOOR, nativeScoreFloorOf } from "../retrieval";
import { OnnxEmbeddingProvider, DEFAULT_MODEL } from "../embedding-onnx";

const WIDE_WINDOW = 100_000; // never the binding constraint here

describe("segment budget travels with the model", () => {
  it("delivers the profile's value, not the module fallback, for the shipping default", async () => {
    const onnx = new OnnxEmbeddingProvider({});
    expect(onnx.modelId).toBe(DEFAULT_MODEL);
    expect(onnx.reliableSegmentTokens).toBeDefined();

    const budget = await segmentTokenBudget({
      inputWindow: () => WIDE_WINDOW,
      countTokens: (t) => t.length,
      reliableSegmentTokens: onnx.reliableSegmentTokens,
    });
    expect(budget).toBe(onnx.reliableSegmentTokens);

    // The point of the whole change: the shipped default must NOT be silently taking the constant
    // that was derived for a different model. If these ever coincide, the assertion below is the one
    // that has gone vacuous, not the mechanism.
    expect(onnx.reliableSegmentTokens).not.toBe(RELIABLE_EMBED_TOKENS);
  });

  it("falls back to the module constant for a provider with no profile", async () => {
    const unprofiled = new OnnxEmbeddingProvider({ model: "Xenova/some-model-nobody-measured" });
    expect(unprofiled.reliableSegmentTokens).toBeUndefined();

    const budget = await segmentTokenBudget({
      inputWindow: () => WIDE_WINDOW,
      countTokens: (t) => t.length,
      reliableSegmentTokens: unprofiled.reliableSegmentTokens,
    });
    expect(budget).toBe(RELIABLE_EMBED_TOKENS);
  });

  it("still yields to a window narrower than the budget — data loss outranks ranking quality", async () => {
    const narrow = 64;
    const budget = await segmentTokenBudget({
      inputWindow: () => narrow,
      countTokens: (t) => t.length,
      reliableSegmentTokens: 380,
    });
    expect(budget).toBe(narrow);
  });

  // A DECLARED-BUT-INVALID budget must be treated as not declared. `??` only catches null/undefined,
  // so an unguarded 0 reaches hardCut, whose binary search cannot satisfy `count(prefix) <= 0` for any
  // non-empty prefix — `fit` stays 1 and the text is emitted one CHARACTER at a time, one embedding
  // call each. Codex P2 on PR #171.
  it.each([
    ["zero", 0],
    ["negative", -380],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    // Token counts are non-negative INTEGERS, so a fractional budget under 1 is unsatisfiable by any
    // non-empty prefix and degenerates exactly like 0 (Codex P2, PR #171, second round).
    ["fractional 0.5", 0.5],
    ["just under one", 0.999],
  ])("falls back when a provider declares a %s budget", async (_label, bad) => {
    const budget = await segmentTokenBudget({
      inputWindow: () => WIDE_WINDOW,
      countTokens: (t) => t.length,
      reliableSegmentTokens: bad as number,
    });
    expect(budget).toBe(RELIABLE_EMBED_TOKENS);
  });

  it("returns null for a provider that declares no window — never guess one", async () => {
    expect(await segmentTokenBudget({ countTokens: (t) => t.length })).toBeNull();
    expect(await segmentTokenBudget({ inputWindow: () => null, countTokens: (t) => t.length })).toBeNull();
  });
});

describe("card-emission floor travels with the model", () => {
  it("delivers the profile's value, not the module fallback, for the shipping default", () => {
    const onnx = new OnnxEmbeddingProvider({});
    expect(onnx.nativeScoreFloor).toBeDefined();
    expect(nativeScoreFloorOf(onnx.nativeScoreFloor)).toBe(onnx.nativeScoreFloor);
    // 0.12 was derived on MiniLM and sits below bge's entire junk distribution. If these ever
    // coincide it is this assertion that has gone vacuous, not the mechanism.
    expect(onnx.nativeScoreFloor).not.toBe(NATIVE_SCORE_FLOOR);
  });

  it("falls back for a provider with no profile", () => {
    const unprofiled = new OnnxEmbeddingProvider({ model: "Xenova/some-model-nobody-measured" });
    expect(unprofiled.nativeScoreFloor).toBeUndefined();
    expect(nativeScoreFloorOf(unprofiled.nativeScoreFloor)).toBe(NATIVE_SCORE_FLOOR);
  });

  // A cosine floor outside [0, 1) cannot gate anything, and a NaN compares false against every score
  // — which silently disables emission filtering rather than failing loudly.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -0.5],
    ["one", 1],
    ["above one", 1.5],
  ])("falls back on a %s floor", (_label, bad) => {
    expect(nativeScoreFloorOf(bad as number)).toBe(NATIVE_SCORE_FLOOR);
  });

  it("honours a legitimate zero — silence filtering off is a choice, not an error", () => {
    expect(nativeScoreFloorOf(0)).toBe(0);
  });
});

// THE ENGINE MUST APPLY THE TRAVELLING FLOOR, not the module constant. Comparing the normalizer to
// itself cannot observe a stranded read — that mistake was made once already on PR #171. This drives
// search() through MonetCore with a provider whose declared floor is high enough to suppress
// everything, and asserts the emission actually goes silent.
describe("card-emission floor reaches search()", () => {
  class FlooredProvider implements EmbeddingProvider {
    readonly dim = 8;
    readonly modelId = "fake/floored-8";
    constructor(readonly nativeScoreFloor: number | undefined) {}
    embed(text: string): Float32Array {
      const v = new Float32Array(this.dim);
      for (let i = 0; i < text.length; i++) v[i % this.dim] += text.charCodeAt(i) % 7;
      const mag = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / mag);
    }
  }

  const withCore = async (floor: number | undefined, fn: (c: MonetCore) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "monet-floor-travel-"));
    const core = new MonetCore(join(dir, "monet.db"), { embedder: new FlooredProvider(floor) });
    try {
      await core.ensureEmbedderPin();
      await core.store("the retrieval floor is an absolute cosine and travels with the embedder");
      await fn(core);
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("emits nothing when the provider declares a floor above every score", async () => {
    await withCore(0.999, async (core) => {
      expect(await core.search("retrieval floor cosine embedder")).toEqual([]);
    });
  });

  it("emits normally when the same provider declares no floor", async () => {
    await withCore(undefined, async (core) => {
      expect((await core.search("retrieval floor cosine embedder")).length).toBeGreaterThan(0);
    });
  });
});

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
import { segmentTokenBudget } from "../observation-segmenter";
import { RELIABLE_EMBED_TOKENS } from "../embed-budget";
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

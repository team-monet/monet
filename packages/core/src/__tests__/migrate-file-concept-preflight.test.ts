/**
 * scripts/migrate-file-concept.ts — preflightEmbedder unit tests. The thin harness still validates
 * the selected target embedder before any MonetCore construction or optional source refresh. Core's
 * migrateEmbeddings repeats the preflight internally; this outer check protects the stronger CLI
 * invariant that a broken target causes no database or source-content write at all.
 *
 * Imports preflightEmbedder directly from the script (exported for testability). main() is guarded
 * behind an import.meta.url entry-point check so importing this module never triggers a real CLI
 * run as a side effect — same established pattern as scrub-corpus.mjs/scrub-db.mjs (see
 * scrub-corpus.test.ts). Unlike those .mjs scripts, migrate-file-concept.ts is a real .ts file, so
 * this import gets full type-checking, no @ts-expect-error needed.
 */
import { describe, it, expect } from "vitest";
import { preflightEmbedder } from "../../scripts/migrate-file-concept";
import { HashingEmbeddingProvider } from "../embedding";
import type { EmbeddingProvider } from "../embedding";

/** Stands in for an ONNX model that can't load (network unreachable, model not cached, etc.) —
 *  real embed() failure without touching the network or @huggingface/transformers. */
class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 384;
  readonly modelId = "fake-unloadable-model";
  async embed(_text: string): Promise<Float32Array> {
    throw new Error("mock: model unavailable (network unreachable)");
  }
}

describe("preflightEmbedder (Codex review, PR #51 round 6, FIX P)", () => {
  it("a working embedder (hashing — real, no network) resolves without throwing", async () => {
    await expect(preflightEmbedder(new HashingEmbeddingProvider(), "hashing")).resolves.toBeUndefined();
  });

  it("a failing embedder's preflight rejects with a clear, actionable message and preserves the original error as .cause", async () => {
    let caught: unknown;
    try {
      await preflightEmbedder(new ThrowingEmbeddingProvider(), "onnx");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toMatch(/preflight failed/i);
    expect(err.message).toMatch(/--embedder onnx/);
    expect(err.message).toMatch(/nothing was written/i);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toMatch(/model unavailable/);
  });
});

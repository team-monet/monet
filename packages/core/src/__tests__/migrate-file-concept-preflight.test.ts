/**
 * scripts/migrate-file-concept.ts — preflightEmbedder unit tests (Codex review, PR #51 round 6,
 * FIX P; ordering corrected round 7, FIX X). The direct consequence of round 5's stamp-early
 * ordering (adoptEmbedderPin runs BEFORE any re-embed work): without a preflight check, an
 * --embedder onnx run on a host where the model/transformers.js can't load would stamp the pin,
 * then have every per-item re-embed attempt fail silently (each caught individually by
 * migrateOneSource/reembedNativeConcepts' own per-item try/catch, never aborting the run) —
 * leaving a non-empty store permanently pinned to a model that can never produce a vector.
 *
 * ROUND 7 UPDATE (FIX X): round 6 called preflightEmbedder AFTER constructing MonetCore — a bug for
 * a vector-free target DB, since construction's OWN fresh-store branch could mint a 'created' pin
 * naming an embedder preflight hadn't verified yet. main() now calls preflightEmbedder BEFORE
 * constructing anything; preflightEmbedder ITSELF is unchanged (still a standalone function with no
 * MonetCore dependency at all) — this file's tests below were already agnostic to WHERE in main()
 * the function gets called, so they need no code change, only this docstring update for accuracy.
 * The stronger, ordering-specific claim ("the core is never constructed on a failing preflight") is
 * NOT something a unit test of preflightEmbedder alone can prove — it's a property of main()'s own
 * sequencing, which isn't independently exported/testable without contorting the script (main()
 * does real argv/fs/console work). That claim is verified via the manual-verification protocol
 * instead: a real disposable, NEVER-before-existing db path, preflighted with a genuinely throwing
 * embedder in main()'s exact round-7 order (preflight, then construction) — the target file is
 * proven to never even get CREATED, not merely "pin unchanged" (round 6's weaker manual-verification
 * claim, which required an already-existing seeded store).
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

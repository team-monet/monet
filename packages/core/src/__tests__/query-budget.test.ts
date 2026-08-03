/**
 * The read side of the window guard (#137).
 *
 * A query past the embedder's window has its tail discarded before scoring, so the terms that were
 * cut do not participate at all — and the miss they cause is indistinguishable from the memory not
 * existing. That is the one failure this line of work exists to remove, arriving on reads instead of
 * writes.
 *
 * Refusing rather than truncating for the same reason the write path refuses: a caller is present.
 * Unlike a write there is nothing to split, so the remedy differs and the message says so.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentExceedsEmbedderWindowError, MonetCore } from "../index";
import { HashingEmbeddingProvider } from "../embedding";
import type { EmbeddingProvider } from "../embedding";

class BoundedProvider implements EmbeddingProvider {
  readonly dim = 8;
  readonly modelId = "fake/bounded-8";
  embedCalls = 0;
  inputWindow(): number | null {
    return 10;
  }
  countTokens(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }
  embed(text: string): Float32Array {
    this.embedCalls++;
    const v = new Float32Array(this.dim);
    for (let i = 0; i < text.length; i++) v[i % this.dim] += text.charCodeAt(i) % 7;
    const mag = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / mag);
  }
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("query budget — an over-window query is refused, not truncated", () => {
  let dir: string;
  let embedder: BoundedProvider;
  let core: MonetCore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "monet-query-budget-"));
    embedder = new BoundedProvider();
    core = new MonetCore(join(dir, "monet.db"), { embedder });
    await core.ensureEmbedderPin();
    await core.store(words(5));
    embedder.embedCalls = 0;
  });

  afterEach(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an over-window search", async () => {
    await expect(core.search(words(25))).rejects.toBeInstanceOf(ContentExceedsEmbedderWindowError);
  });

  it("refuses an over-window gather", async () => {
    await expect(core.gather(words(25))).rejects.toBeInstanceOf(ContentExceedsEmbedderWindowError);
  });

  // Same reason the write path checks before touching the store: counting tokens needs no database
  // and no model load. If the guard ever moves below the embed, this fails.
  it("refuses without invoking the embedder", async () => {
    await expect(core.search(words(25))).rejects.toThrow();
    expect(embedder.embedCalls).toBe(0);
  });

  // The diagnosis is the same on both sides; the remedy is not, and an error naming the wrong
  // remedy wastes the one moment the caller is reading it.
  it("gives a query the query remedy, not the write remedy", async () => {
    const err = (await core.search(words(25)).catch((e: unknown) => e)) as ContentExceedsEmbedderWindowError;
    expect(err.subject).toBe("query");
    expect(err.message).toContain("This query");
    expect(err.message).toContain("narrower question");
    expect(err.message).not.toContain("separate observations");

    const writeErr = (await core.store(words(25)).catch((e: unknown) => e)) as ContentExceedsEmbedderWindowError;
    expect(writeErr.subject).toBe("content");
    expect(writeErr.message).toContain("separate observations");
  });

  it("leaves an in-window query working", async () => {
    await expect(core.search(words(5))).resolves.toBeInstanceOf(Array);
    await expect(core.gather(words(5))).resolves.toHaveProperty("ranked");
  });
});

describe("query budget — a provider with no window is unbounded on reads too", () => {
  let dir: string;
  let core: MonetCore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-query-budget-lexical-"));
    core = new MonetCore(join(dir, "monet.db"), { embedder: new HashingEmbeddingProvider() });
  });

  afterEach(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("searches with a query of any length under the lexical embedder", async () => {
    await expect(core.search(words(5000))).resolves.toBeInstanceOf(Array);
  });
});

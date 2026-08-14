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
import { RELIABLE_EMBED_TOKENS } from "../embed-budget";
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

/** Same bounds, but declares a per-model segment budget — the shape a profiled provider has. */
class ProfiledBoundedProvider extends BoundedProvider {
  readonly reliableSegmentTokens = 7;
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

  // THE ADVISORY MUST TRAVEL TOO (Codex P2, PR #171). The engine segments at the provider's declared
  // budget, so a refusal that quotes the global RELIABLE_EMBED_TOKENS tells the caller to aim at a
  // number this embedder never uses — the same stranded-constant failure the field exists to fix,
  // one layer out where the user can actually see it.
  it("quotes the provider's own reliable budget in the refusal, not the global fallback", async () => {
    const profiled = new ProfiledBoundedProvider();
    const d = mkdtempSync(join(tmpdir(), "monet-query-budget-profiled-"));
    const c = new MonetCore(join(d, "monet.db"), { embedder: profiled });
    try {
      await c.ensureEmbedderPin();
      const err = (await c.search(words(25)).catch((e: unknown) => e)) as ContentExceedsEmbedderWindowError;
      expect(err).toBeInstanceOf(ContentExceedsEmbedderWindowError);
      expect(err.reliableTokens).toBe(profiled.reliableSegmentTokens);
      expect(err.message).toContain(String(profiled.reliableSegmentTokens));
    } finally {
      c.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  // THE ADVISORY MUST APPLY THE SAME VALIDATION THE SEGMENTER DOES. These read the declared budget at
  // two different call sites; when each did its own `?? RELIABLE_EMBED_TOKENS` the validation drifted,
  // and a declaration the segmenter rejected was still quoted to the user — Infinity told a refused
  // caller to stay under Infinity tokens. Goes through MonetCore on purpose: comparing the normalizer
  // to itself cannot observe the drift (Codex P2, PR #171, second round).
  it.each([
    ["zero", 0],
    ["negative", -8],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["fractional 0.5", 0.5],
  ])("falls back in the refusal when a provider declares a %s budget", async (_label, bad) => {
    class BadBudgetProvider extends BoundedProvider {
      readonly reliableSegmentTokens = bad as number;
    }
    const p = new BadBudgetProvider();
    const d = mkdtempSync(join(tmpdir(), "monet-query-budget-bad-"));
    const c = new MonetCore(join(d, "monet.db"), { embedder: p });
    try {
      await c.ensureEmbedderPin();
      const err = (await c.search(words(25)).catch((e: unknown) => e)) as ContentExceedsEmbedderWindowError;
      expect(err).toBeInstanceOf(ContentExceedsEmbedderWindowError);
      expect(err.reliableTokens).toBe(RELIABLE_EMBED_TOKENS);
    } finally {
      c.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses an over-window search", async () => {
    await expect(core.search(words(25))).rejects.toBeInstanceOf(ContentExceedsEmbedderWindowError);
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
    await expect(core.search(words(5))).resolves.toBeInstanceOf(Array);
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

/**
 * Refusing content the embedder cannot fully read (#132).
 *
 * A transformer embedder discards everything past its window and returns a vector anyway, so the
 * write succeeds and the tail is stored, served on fetch, and unreachable by search — measured at
 * 19.2% of all text on a real store. These tests pin the refusal, and pin the property that makes
 * refusing worth doing: it is cheap. No model load, no store write, nothing to undo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentExceedsEmbedderWindowError,
  MonetCore,
  RELIABLE_EMBED_TOKENS,
} from "../index";
import { HashingEmbeddingProvider } from "../embedding";
import type { EmbeddingProvider } from "../embedding";

/** Stands in for a real transformer: declares a window, counts words, and records every embed. */
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

describe("write budget — content past the embedder's window is refused", () => {
  let dir: string;
  let dbPath: string;
  let embedder: BoundedProvider;
  let core: MonetCore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "monet-write-budget-"));
    dbPath = join(dir, "monet.db");
    embedder = new BoundedProvider();
    core = new MonetCore(dbPath, { embedder });
    await core.ensureEmbedderPin();
    embedder.embedCalls = 0; // the pin preflight embeds once; start counting from the tests
  });

  afterEach(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an over-window write and names the counts the caller needs to fix it", async () => {
    const err = await core.store(words(25)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentExceedsEmbedderWindowError);
    const typed = err as ContentExceedsEmbedderWindowError;
    expect(typed.tokens).toBe(25);
    expect(typed.maxInputTokens).toBe(10);
    expect(typed.reliableTokens).toBe(RELIABLE_EMBED_TOKENS);
    expect(typed.message).toContain("25");
    expect(typed.message).toContain("10");
  });

  // THE point of refusing here rather than downstream: it costs a tokenizer lookup and nothing else.
  // If the check ever moves below the embed call, this fails — which is the regression worth pinning,
  // because a refusal that first pays for a model load is barely better than the silent truncation.
  it("refuses without invoking the embedder at all", async () => {
    await expect(core.store(words(25))).rejects.toBeInstanceOf(ContentExceedsEmbedderWindowError);
    expect(embedder.embedCalls).toBe(0);
  });

  it("leaves the store completely untouched after a refusal", async () => {
    await expect(core.store(words(25))).rejects.toThrow();
    expect(core.stats().observations).toBe(0);
    expect(core.stats().concepts).toBe(0);
  });

  it("accepts content at the window and stores it normally", async () => {
    const r = await core.store(words(10));
    expect(r.conceptId).toBeTruthy();
    expect(core.stats().observations).toBe(1);
    expect(embedder.embedCalls).toBeGreaterThan(0);
  });

  // Codex review, PR #134 (P2). storeInternal looks up the idempotency receipt before every guard,
  // deliberately: a retry of an already-committed operationId is a no-op success. A window check in
  // front of that lookup would turn the replay of a body that was accepted and stored into an error.
  it("still replays a committed operationId, even when the retry body is over the window", async () => {
    const first = await core.store(words(5), { operationId: "op-replay-1" });
    const replay = await core.store(words(25), { operationId: "op-replay-1" });
    expect(replay.conceptId).toBe(first.conceptId);
    expect(core.stats().observations).toBe(1);
  });

  // A source chunk is materialized from a file, which cannot be asked to write differently. Its
  // budget belongs to the chunker that produces it, not to a refusal handed to a connector with no
  // author to relay it to — so this path stays open deliberately.
  it("does not refuse source ingest, which has no author to retry", async () => {
    const r = await core.storeSource(words(25), {
      sourceRefs: ["source://budget-test/NOTES.md#section~1"],
      resolution: "forceNew",
    });
    expect(r.conceptId).toBeTruthy(); // committed rather than refused — the property under test
  });
});

// Codex review, PR #134 (P1). The window belongs to the SELECTED MODEL, not the provider class: an
// ONNX provider takes any hub id or local path, and a class constant would accept content a
// smaller-window model truncates and refuse valid writes to a larger one. A provider that cannot
// determine its window reports null, and null must mean unbounded — refusing against an invented
// number is the same silent wrongness the guard exists to remove.
describe("write budget — the window comes from the provider, per instance", () => {
  let dir: string;
  const withWindow = (window: number | null) => {
    const p = new BoundedProvider();
    p.inputWindow = () => window;
    return p;
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "monet-write-budget-window-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("respects a smaller window than another instance would report", async () => {
    const core = new MonetCore(join(dir, "small.db"), { embedder: withWindow(5) });
    await expect(core.store(words(8))).rejects.toBeInstanceOf(ContentExceedsEmbedderWindowError);
    core.close();
  });

  it("respects a larger window, accepting what a smaller one would refuse", async () => {
    const core = new MonetCore(join(dir, "large.db"), { embedder: withWindow(100) });
    const r = await core.store(words(80));
    expect(r.conceptId).toBeTruthy();
    core.close();
  });

  it("treats an undeterminable window as unbounded rather than guessing one", async () => {
    const core = new MonetCore(join(dir, "unknown.db"), { embedder: withWindow(null) });
    const r = await core.store(words(5000));
    expect(r.conceptId).toBeTruthy();
    core.close();
  });
});

describe("write budget — a provider that declares no window is unbounded", () => {
  let dir: string;
  let core: MonetCore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-write-budget-lexical-"));
    core = new MonetCore(join(dir, "monet.db"), { embedder: new HashingEmbeddingProvider() });
  });

  afterEach(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The lexical provider hashes every token it is handed, so it has no window to exceed. Declaring
  // none must mean "unbounded", never "assume some default" — a guessed limit here would refuse
  // writes that would have been indexed perfectly.
  it("stores content of any length under the lexical embedder", async () => {
    const r = await core.store(words(5000));
    expect(r.conceptId).toBeTruthy();
    expect(core.stats().observations).toBe(1);
  });
});

// Codex review, PR #134: the 280-token target is calibrated on this corpus, not derived from the
// model, so a provider whose window is TIGHTER must not be told to aim above it — otherwise the
// error recommends a size the same model will reject on the retry.
describe("write budget — the advisory never exceeds the selected model's window", () => {
  let dir: string;
  const withWindow = (window: number) => {
    const p = new BoundedProvider();
    p.inputWindow = () => window;
    return p;
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "monet-write-budget-advice-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the calibrated target when it is below the window", async () => {
    const core = new MonetCore(join(dir, "wide.db"), { embedder: withWindow(RELIABLE_EMBED_TOKENS + 100) });
    const err = (await core.store(words(RELIABLE_EMBED_TOKENS + 200)).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(`below about ${RELIABLE_EMBED_TOKENS} tokens`);
    core.close();
  });

  it("falls back to the window when the window is tighter", async () => {
    const core = new MonetCore(join(dir, "narrow.db"), { embedder: withWindow(128) });
    const err = (await core.store(words(200)).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(`below about ${RELIABLE_EMBED_TOKENS}`);
    expect(err.message).toContain("binding constraint");
    core.close();
  });
});

import { describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, cosine } from "../embedding";

// Item 9 (multilingual swap): HashingEmbeddingProvider is the zero-dependency fallback used
// whenever the real ONNX model is unavailable, so its tokenizer must not privilege Latin/ASCII
// text. Its regex moved from the ASCII-only /[^a-z0-9\s]/g to the Unicode-aware /[^\p{L}\p{N}\s]/gu
// (embedding.ts) — under the old class, any non-Latin script was stripped down to nothing,
// collapsing every non-Latin document to the same degenerate all-zero vector.
describe("HashingEmbeddingProvider Unicode tokenization (item 9 fallback tokenizer)", () => {
  it("produces a non-degenerate, unit-length vector for non-Latin scripts", () => {
    const embedder = new HashingEmbeddingProvider();
    for (const text of ["こんにちは世界", "Привет мир", "안녕하세요 세계"]) {
      const v = embedder.embed(text);
      const magnitude = Math.sqrt(Array.from(v).reduce((sum, x) => sum + x * x, 0));
      // normalizeVector() divides by (mag || 1) — an all-zero vector (the old ASCII-only bug) would
      // stay all-zero and report magnitude 0, not 1.
      expect(magnitude).toBeCloseTo(1, 5);
    }
  });

  it("gives two unrelated non-Latin texts distinct vectors instead of collapsing both to zero", () => {
    const embedder = new HashingEmbeddingProvider();
    const ja = embedder.embed("こんにちは世界、これは日本語のテキストです");
    const ru = embedder.embed("Совершенно другой текст на русском языке");
    expect(ja).not.toEqual(ru);
    expect(cosine(ja, ru)).toBeLessThan(0.9);
  });

  it("scores overlapping non-Latin text higher than unrelated non-Latin text", () => {
    const embedder = new HashingEmbeddingProvider();
    const base = embedder.embed("Привет мир, это тестовый текст на русском языке");
    const similar = embedder.embed("Привет мир, это другой тестовый текст на русском языке");
    const unrelated = embedder.embed("こんにちは世界、これは日本語のテキストです");
    expect(cosine(base, similar)).toBeGreaterThan(cosine(base, unrelated));
  });

  it("extracts trigram overlap from unsegmented CJK text lacking whitespace word boundaries", () => {
    const embedder = new HashingEmbeddingProvider();
    // No spaces at all, so the whole string is one "word" token to the tokenizer — but character
    // trigram windowing (^...$ wrapped) still surfaces the shared "東京都" prefix.
    const shibuya = embedder.embed("東京都渋谷区");
    const shinjuku = embedder.embed("東京都新宿区");
    const osaka = embedder.embed("大阪府大阪市");
    expect(cosine(shibuya, shinjuku)).toBeGreaterThan(cosine(shibuya, osaka));
  });

  it("still strips cross-script punctuation, keeping only letters/numbers/whitespace as separators", () => {
    const embedder = new HashingEmbeddingProvider();
    const withPunctuation = embedder.embed("Hola, ¿cómo estás? ¡Bien!");
    const withoutPunctuation = embedder.embed("Hola cómo estás Bien");
    expect(cosine(withPunctuation, withoutPunctuation)).toBeCloseTo(1, 5);
  });

  it("keeps ASCII/Latin tokenization behavior unchanged (no regression for the common case)", () => {
    const embedder = new HashingEmbeddingProvider();
    const a = embedder.embed("the quick brown fox jumps over the lazy dog");
    const b = embedder.embed("the quick brown fox jumps over the lazy cat");
    const unrelated = embedder.embed("completely different sentence about something else entirely");
    expect(cosine(a, b)).toBeGreaterThan(0.8);
    expect(cosine(a, unrelated)).toBeLessThan(cosine(a, b));
  });
});

// ---- embedder-pin ADR, slice 1: resurrected tok=1 tokenizer -------------------------------
//
// v0.8.1 shipped one hashing tokenizer (ASCII-only [a-z0-9]); item 9 (multilingual swap) replaced
// it IN PLACE with the Unicode-aware \p{L}\p{N} version above. That in-place replacement is exactly
// the anti-pattern the embedder-pin ADR forbids going forward (see the standing principle in
// embedding.ts): a store PINNED to the old tokenizer must be able to re-instantiate it forever.
// HashingEmbeddingProvider's constructor now takes an explicit tokenizerVersion, defaulting to the
// current build's default (tok=2) but able to resurrect tok=1 exactly.
//
// v081Hash32/v081Normalize/v081Embed below are a verbatim, INDEPENDENT port of v0.8.1's
// HashingEmbeddingProvider.embed() (`git show v0.8.1:src/embedding.ts`) — not imported from
// embedding.ts (hash32/normalize are module-private there), so this is a true external oracle for
// "does tok=1 match published pre-item-9 behavior exactly", not a tautology against the same code
// under test.
function v081Hash32(s: string): number {
  // FNV-1a — unchanged between v0.8.1 and the current build; duplicated here only so this oracle
  // has zero dependency on embedding.ts's (unexported) implementation.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function v081Normalize(v: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

function v081Embed(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // v0.8.1's ASCII-only tokenizer regex, pre-item-9
    .split(/\s+/)
    .filter(Boolean);

  const add = (feature: string, weight: number): void => {
    const h = v081Hash32(feature);
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1;
    v[idx] += sign * weight;
  };

  for (const w of words) {
    add("w:" + w, 1);
    const s = "^" + w + "$";
    for (let i = 0; i + 3 <= s.length; i++) add("t:" + s.slice(i, i + 3), 0.5);
  }

  return v081Normalize(v);
}

describe("HashingEmbeddingProvider tokenizer versioning (embedder-pin ADR)", () => {
  it("a tok=1 instance's output matches v0.8.1 behavior exactly, for both ASCII and non-ASCII text", () => {
    const tok1 = new HashingEmbeddingProvider(256, 1);
    for (const text of [
      "the quick brown fox jumps over the lazy dog",
      "Widget42 costs $19.99 — order #A-100!",
      "Café résumé, naïve façade",
      "こんにちは世界",
      "Привет мир, это тестовый текст",
    ]) {
      const actual = Array.from(tok1.embed(text));
      const expected = Array.from(v081Embed(text, 256));
      expect(actual).toEqual(expected);
    }
  });

  it("gives each instance a modelId that reflects ITS OWN tokenizer version, not the build default", () => {
    expect(new HashingEmbeddingProvider().modelId).toBe("hashing:dim=256:tok=2"); // default unchanged
    expect(new HashingEmbeddingProvider(256, 2).modelId).toBe("hashing:dim=256:tok=2");
    expect(new HashingEmbeddingProvider(256, 1).modelId).toBe("hashing:dim=256:tok=1");
    expect(new HashingEmbeddingProvider(128, 1).modelId).toBe("hashing:dim=128:tok=1");
  });

  it("produces IDENTICAL vectors across tok=1/tok=2 for pure-ASCII input (known property: the two tokenizer regexes only diverge on non-ASCII characters)", () => {
    for (const text of [
      "the quick brown fox jumps over the lazy dog",
      "Widget42 costs $19.99, order #A-100! (urgent)",
      "",
    ]) {
      const tok1 = Array.from(new HashingEmbeddingProvider(256, 1).embed(text));
      const tok2 = Array.from(new HashingEmbeddingProvider(256, 2).embed(text));
      expect(tok1).toEqual(tok2);
    }
  });

  it("produces DIFFERENT vectors across tok=1/tok=2 for non-ASCII input (tok=1 strips it to nothing; tok=2 keeps it — the item-9 bug tok=2 exists to fix)", () => {
    for (const text of ["こんにちは世界", "Привет мир, это тестовый текст", "안녕하세요 세계", "Café résumé"]) {
      const tok1 = Array.from(new HashingEmbeddingProvider(256, 1).embed(text));
      const tok2 = Array.from(new HashingEmbeddingProvider(256, 2).embed(text));
      expect(tok1).not.toEqual(tok2);
    }
  });

  it("fails closed (throws) on an unknown tokenizer version instead of silently guessing", () => {
    expect(() => new HashingEmbeddingProvider(256, 99)).toThrow(/unknown tokenizer version 99/i);
    expect(() => new HashingEmbeddingProvider(256, 0)).toThrow(/unknown tokenizer version 0/i);
  });
});

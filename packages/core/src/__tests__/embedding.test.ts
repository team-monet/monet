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
      // normalize() divides by (mag || 1) — an all-zero vector (the old ASCII-only bug) would
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

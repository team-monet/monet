/**
 * Embedding provider — the model-adapter seam (ADR 0001 §6).
 *
 * The substrate never depends on *how* text becomes a vector. Swap this interface
 * for a real semantic model (e.g. MiniLM/BGE-small via transformers.js, or a local
 * Ollama embed endpoint) and nothing else in the engine changes.
 *
 * The default `HashingEmbeddingProvider` is a no-dependency, no-download lexical
 * embedder: it catches near-duplicate and lexically-similar text well enough to
 * prove the resolve-or-create mechanism today. It does NOT capture paraphrase-level
 * semantics — that is exactly what swapping in a real model buys (next step).
 */
/**
 * Resolve-or-create thresholds (ADR §4.1), calibrated PER embedding space:
 *   score ≥ tauAttach            → attach (confident same concept)
 *   tauAmbiguous ≤ score < attach → ambiguous (likely same; surfaced, still attached)
 *   score < tauAmbiguous          → create a new concept
 * Cosine distributions differ by model, so thresholds belong WITH the embedder, not
 * as global constants. The engine uses these unless overridden via MonetCoreOptions.
 */
export interface EmbeddingThresholds {
  tauAttach: number;
  tauAmbiguous: number;
}

export interface EmbeddingProvider {
  readonly dim: number;
  /** Thresholds calibrated for this embedder's cosine distribution (see above). */
  readonly recommendedThresholds?: EmbeddingThresholds;
  /** May be sync (lexical) or async (a real model). The engine always awaits it. */
  embed(text: string): Float32Array | Promise<Float32Array>;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  // Calibrated for the lexical (token/trigram) cosine distribution — looser than a
  // semantic model because lexical overlap saturates lower. (Preserved spike defaults.)
  readonly recommendedThresholds: EmbeddingThresholds = { tauAttach: 0.55, tauAmbiguous: 0.4 };

  constructor(dim = 256) {
    this.dim = dim;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    const add = (feature: string, weight: number): void => {
      const h = hash32(feature);
      const idx = h % this.dim;
      const sign = (h & 1) === 0 ? 1 : -1; // sign hashing reduces collision bias
      v[idx] += sign * weight;
    };

    for (const w of words) {
      add("w:" + w, 1);
      const s = "^" + w + "$"; // char trigrams for fuzzy / morphological overlap
      for (let i = 0; i + 3 <= s.length; i++) add("t:" + s.slice(i, i + 3), 0.5);
    }

    return normalize(v);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Both vectors are L2-normalized, so cosine == dot product.
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Running-mean blend of a concept's vector with a new supporting observation. */
export function blend(current: Float32Array, next: Float32Array, currentCount: number): Float32Array {
  const out = new Float32Array(current.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (current[i] * currentCount + next[i]) / (currentCount + 1);
  }
  return normalize(out);
}

function normalize(v: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

function hash32(s: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

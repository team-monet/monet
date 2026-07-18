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
  /**
   * A stable string identifier for this embedder's model and configuration (e.g.
   * "hashing:dim=256" or "Xenova/all-MiniLM-L6-v2"). Used by the sync layer to reject
   * cross-machine grafts where the vector spaces are incompatible.
   */
  readonly modelId?: string;
  /** May be sync (lexical) or async (a real model). The engine always awaits it. */
  embed(text: string): Float32Array | Promise<Float32Array>;
}

// REVIEW FIX (round 4, Codex thread 14): bumped when TOKENIZATION changes the hashing vector
// space, even though `dim` (and the model's "shape") stays the same — modelId is the ONLY signal
// engine.ts's graft rejection (assertCompatibleGraft, embedderModelId mismatch → EmbedderMismatchError)
// has to tell two hashing stores' vector spaces apart. Before this constant existed, EVERY
// HashingEmbeddingProvider advertised the same "hashing:dim=256" regardless of tokenizer version,
// so old-tokenizer and new-tokenizer vectors were indistinguishable to that check: a graft from an
// old-tokenizer store would be silently ACCEPTED into a new-tokenizer one (and vice versa),
// mixing incompatible vector spaces exactly the way the modelId check exists to prevent. Bump this
// whenever `embed()`'s tokenization (not just its output dimension) changes. A store still holding
// the OLD modelId is not hard-failed anywhere on open (no code path compares a persisted "this
// store's model" against the live embedder at construction time) — it simply needs its native
// concepts (and, per thread 11, their observations) re-embedded, exactly like an ONNX default
// swap; migrate-file-concept.ts's re-embed pass covers this identically either way.
const HASHING_TOKENIZER_VERSION = 2; // 2: Unicode-aware \p{L}\p{N} tokenizer (item 9, multilingual swap); 1 (implicit, pre-existing): ASCII-only [a-z0-9]

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  // Calibrated for the lexical (token/trigram) cosine distribution — looser than a
  // semantic model because lexical overlap saturates lower. (Preserved spike defaults.)
  readonly recommendedThresholds: EmbeddingThresholds = { tauAttach: 0.55, tauAmbiguous: 0.4 };
  readonly modelId: string;

  constructor(dim = 256) {
    this.dim = dim;
    this.modelId = `hashing:dim=${dim}:tok=${HASHING_TOKENIZER_VERSION}`;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    // Unicode-aware tokenizer (item 9, multilingual swap): \p{L}\p{N} (with the `u` flag) keeps
    // any script's letters/digits — Korean, CJK, Cyrillic, etc. — instead of the old ASCII-only
    // [a-z0-9] class, which silently stripped non-Latin text down to zero features.
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
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

/**
 * Support-weighted blend of two concept centroids — for MERGING two concepts (each already an
 * average of its own evidence). Weighting each vector by its support keeps a heavily-supported
 * source from being underweighted as if it were a single new observation.
 */
export function blendWeighted(a: Float32Array, wa: number, b: Float32Array, wb: number): Float32Array {
  const out = new Float32Array(a.length);
  const total = wa + wb || 1;
  for (let i = 0; i < out.length; i++) out[i] = (a[i] * wa + b[i] * wb) / total;
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

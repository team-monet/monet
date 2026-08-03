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
   * cross-machine grafts where the vector spaces are incompatible. It may be omitted for a
   * provider used only against truly vector-free/read-only state; persisting any semantic vector
   * requires a non-empty, non-synthetic modelId before the first write.
   */
  readonly modelId?: string;
  /**
   * How much text this provider actually reads, in its own tokens; null when it reads everything.
   *
   * A transformer embedder reads a fixed window and DISCARDS the rest without erroring — the vector
   * for a 700-token input is byte-identical to the vector for its first 512 tokens (measured; see
   * scripts/repros/tail-blindness.mjs). Nothing downstream can detect that, so text past the window
   * is stored, served on fetch, and unreachable by search, with no signal anywhere. Reporting the
   * window is what lets a caller refuse the write instead of accepting a silent hole.
   *
   * A METHOD, not a constant, and asynchronous — because the window is a property of the SELECTED
   * MODEL, not of the provider class. An ONNX provider accepts any hub id or local path, and those
   * models' windows differ; a class-level constant would accept content a smaller-window model
   * truncates (the exact bug this exists to prevent) and refuse valid writes to a larger one.
   */
  inputWindow?(): number | null | Promise<number | null>;
  /**
   * Token count under THIS provider's tokenizer — the only count that predicts truncation. Callers
   * must not estimate from character length: the ratio moves with script (Korean and CJK tokenize
   * far denser than English), so a byte or character budget is a different limit wearing this one's
   * name. Omitted whenever `inputWindow` is.
   */
  countTokens?(text: string): number | Promise<number>;
  /** May be sync (lexical) or async (a real model). The engine always awaits it. */
  embed(text: string): Float32Array | Promise<Float32Array>;
}

/** A provider's runtime output disagreed with its declared vector contract. */
export class EmbedderOutputDimensionError extends Error {
  constructor(
    public readonly declaredWidth: number,
    public readonly actualWidth: number | null,
    public readonly population?: "native" | "source",
    public readonly actualType = "Float32Array",
  ) {
    super(
      actualWidth === null
        ? `Embedding provider returned ${actualType}; expected Float32Array of declared dimension ${declaredWidth}.`
        : `Embedding provider returned dimension ${actualWidth}; expected its declared dimension ${declaredWidth}.`,
    );
    this.name = "EmbedderOutputDimensionError";
  }
}

/** A provider returned the right container and width, but at least one unusable component. */
export class EmbedderOutputNonFiniteError extends Error {
  constructor(
    public readonly index: number,
    public readonly value: number,
    public readonly population?: "native" | "source",
  ) {
    super(`Embedding provider returned a non-finite component at index ${index}; every component must be finite.`);
    this.name = "EmbedderOutputNonFiniteError";
  }
}

/** Runtime-check a provider result before it is persisted or used for similarity scoring. */
export function validateEmbeddingProviderOutput(
  provider: Pick<EmbeddingProvider, "dim">,
  output: unknown,
  population?: "native" | "source",
): Float32Array {
  if (!(output instanceof Float32Array)) {
    const actualType = output === null ? "null" : Array.isArray(output) ? "Array" : typeof output;
    throw new EmbedderOutputDimensionError(provider.dim, null, population, actualType);
  }
  if (output.length !== provider.dim) {
    throw new EmbedderOutputDimensionError(provider.dim, output.length, population);
  }
  for (let index = 0; index < output.length; index++) {
    const value = output[index]!;
    if (!Number.isFinite(value)) throw new EmbedderOutputNonFiniteError(index, value, population);
  }
  return output;
}

// REVIEW FIX (round 4, Codex thread 14): bumped when TOKENIZATION changes the hashing vector
// space, even though `dim` (and the model's "shape") stays the same — modelId is the ONLY signal
// engine.ts's graft rejection (assertCompatibleGraft, embedderModelId mismatch → EmbedderMismatchError)
// has to tell two hashing stores' vector spaces apart. Before this constant existed, EVERY
// HashingEmbeddingProvider advertised the same "hashing:dim=256" regardless of tokenizer version,
// so old-tokenizer and new-tokenizer vectors were indistinguishable to that check: a graft from an
// old-tokenizer store would be silently ACCEPTED into a new-tokenizer one (and vice versa),
// mixing incompatible vector spaces exactly the way the modelId check exists to prevent. Bump this
// whenever `embed()`'s tokenization (not just its output dimension) changes.
//
// UPDATE (embedder-pin ADR, slice 1): the next sentence used to end this comment: "A store still
// holding the OLD modelId is not hard-failed anywhere on open (no code path compares a persisted
// 'this store's model' against the live embedder at construction time)." That is no longer true —
// see MonetCore.ensureEmbedderPin (engine.ts) and the `sync_meta.embedder_model_id` pin it
// enforces. A store pinned to "hashing:dim=256:tok=1" now gets tokenizer v1 re-instantiated (via
// instantiateEmbedderForPin, embedding-onnx.ts) at open time rather than silently drifting onto
// whatever HASHING_TOKENIZER_VERSION this build defaults to. Re-embedding (migrate-file-concept.ts)
// is still how a store VOLUNTARILY moves its pin to a new tokenizer version — it is just no longer
// the only thing standing between an old store and a silent vector-space mismatch.
const HASHING_TOKENIZER_VERSION = 2; // default for FRESH instances; HASHING_TOKENIZERS below lists every version this build can still instantiate

/**
 * Tokenizers keyed by version — each produces the word list `embed()` hashes into features.
 *
 * Standing principle (embedder-pin ADR): an embed-affecting change ADDS a new entry here behind a
 * new version number. NEVER edit an existing entry's implementation in place. A store may be
 * PINNED to an old version indefinitely (see the embedder-pin ADR / instantiateEmbedderForPin in
 * embedding-onnx.ts), so old versions must stay instantiable, byte-identical, forever — the same
 * rule the ONNX side follows by never reusing a model string for a changed model. The version
 * number IS the vector space's identity.
 */
const HASHING_TOKENIZERS: Record<number, (text: string) => string[]> = {
  // 1 (pre-existing; resurrected from v0.8.1 for the embedder-pin ADR so old hashing stores stay
  // instantiable): ASCII-only — silently stripped any non-Latin script down to nothing (the item-9
  // bug tokenizer v2, below, exists to fix).
  1: (text) => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
  // 2 (item 9, multilingual swap; current default): Unicode-aware \p{L}\p{N} (with the `u` flag)
  // keeps any script's letters/digits — Korean, CJK, Cyrillic, etc. — instead of the old ASCII-only
  // [a-z0-9] class, which silently stripped non-Latin text down to zero features.
  2: (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean),
};

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  // Calibrated for the lexical (token/trigram) cosine distribution — looser than a
  // semantic model because lexical overlap saturates lower. (Preserved spike defaults.)
  readonly recommendedThresholds: EmbeddingThresholds = { tauAttach: 0.55, tauAmbiguous: 0.4 };
  readonly modelId: string;
  private readonly tokenize: (text: string) => string[];

  /**
   * `tokenizerVersion` defaults to this build's current default (HASHING_TOKENIZER_VERSION) but
   * accepts any version this build still knows how to instantiate (HASHING_TOKENIZERS above) — the
   * embedder-pin loader (instantiateEmbedderForPin, embedding-onnx.ts) uses this to resurrect the
   * EXACT tokenizer an older store was pinned to. Fails closed (throws) on an unrecognized version:
   * guessing would silently mix vector spaces, exactly what modelId versioning exists to prevent.
   */
  constructor(dim = 256, tokenizerVersion: number = HASHING_TOKENIZER_VERSION) {
    this.dim = dim;
    const tokenize = HASHING_TOKENIZERS[tokenizerVersion];
    if (!tokenize) {
      throw new Error(
        `HashingEmbeddingProvider: unknown tokenizer version ${tokenizerVersion}. ` +
          `Known versions: ${Object.keys(HASHING_TOKENIZERS).join(", ")}.`,
      );
    }
    this.tokenize = tokenize;
    this.modelId = `hashing:dim=${dim}:tok=${tokenizerVersion}`;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const words = this.tokenize(text);

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

/** Serialize a vector for the `embedding` TEXT column (concepts and observations both). */
export function embToJson(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}

/** Inverse of embToJson. (Moved here from engine.ts with the retrieval extraction — it is an
 *  embedding-serialization helper, and src/retrieval.ts needs it without depending on the engine.) */
export function jsonToEmb(s: string): Float32Array {
  return Float32Array.from(JSON.parse(s) as number[]);
}

/** True iff every component is exactly 0 — the pre-chunk-embedding placeholder storeSourceChunk
 *  used to write for every source chunk observation (chunk-granular source retrieval,
 *  scoreSourceConcepts's zero-vector exclusion, src/retrieval.ts), or the create-time concept
 *  placeholder before recomputeSourceConceptBody's first real write. A zero vector is a
 *  PLACEHOLDER, not a measurement: retrieval excludes it rather than scoring it as 0. */
export function isZeroVector(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
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

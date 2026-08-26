/**
 * Embedding provider — the model-adapter seam.
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
  /**
   * NEAR-INERT BY CONSTRUCTION, and identical in every profile for that reason — not because it
   * travels badly, but because nothing lands under it. It is compared against a nomination ARGMAX
   * over every concept in the circle, and a max of hundreds of draws concentrates just below
   * whatever tauAttach is calibrated to. Measured on the live bge store (931 replays, 118 forks):
   * the LOWEST fork scored 0.6953, so every candidate up to 0.65 left 100% of forks in the
   * ambiguous band and 0.70 separated exactly one. Raising it toward tauAttach is the only way to
   * give it work, and that trades a possible-duplicate edge for an orphan concept — a worse trade
   * than the fork it is deciding about. Treat a change here as a design change, not a tuning knob.
   */
  tauAmbiguous: number;
  /**
   * How far the nomination's winner must stand ABOVE the runner-up before the attach is taken
   * without asking. A separate question from tauAttach, and the one that actually discriminates:
   * `score >= tauAttach` asks "is this similar enough", never "am I sure it is THIS one".
   *
   * WHY A SECOND GATE RATHER THAN A HIGHER FIRST ONE. Because it asks a different question:
   * tauAttach asks "is this similar enough", the margin asks "am I sure it is THIS one", and only
   * the second is a statement about identity. That is the whole case, and it is an argument about
   * which question is being answered — not a claim about any number.
   *
   * THE NUMERIC CASE THAT USED TO STAND HERE IS REFUTED (2026-08-26), and it inverted rather than
   * merely weakened. It read: "The margin separates where tauAttach does not: among misfiles its
   * median is 0.0335, below the p10 of 0.0346 for correct decisions. Below this bar the winner is
   * wrong ~64% of the time, which is worse than a coin flip." Re-derived by a legality-aware,
   * engine-driven replay on the bge-m3 monet-hq store (2026-08-26), over the LEGAL winner-runner-up
   * gap — the same quantity the engine actually gates on, `legalMargin`, not the raw all-candidates
   * gap the original script measured:
   *
   *   misfile median   0.0537   (n=682)      <- ABOVE, not below
   *   correct p10      0.0481   (n=682)
   *   winner wrong at tauMargin = 0.12       41.7%  (n=266), not ~64%
   *
   * So in this space the misfile median sits ABOVE the correct-decision p10: the separation the
   * sentence claimed runs the other way, and the gate's band is not "worse than a coin flip" — it
   * is wrong about two times in five. Every site that quoted 0.0335 / 0.0346 / ~64% was quoting
   * this one derivation, never an independent measurement, and all of them were corrected together
   * (resolution.ts's ASK branch, engine.ts's AmbiguousNominationError doc, mcp-server.ts's
   * ambiguous-write envelope).
   *
   * WHAT SURVIVES AND WHAT DOES NOT. The identity-vs-similarity case survives untouched — it never
   * rested on these numbers. The numeric case does not survive, and no number here should be quoted
   * as evidence that the band is uniquely bad. `tauMargin` DOES NOT MOVE on this: 0.12 is unchanged.
   *
   * 0.12 IS A CHOSEN OPERATING POINT, NOT A DERIVED PEAK. The same replay swept tauMargin across
   * this space and found a smooth trade-off with NO interior optimum — nothing to maximize, no
   * knee, just more catching bought with more exchanging as the bar rises. At 0.12 it catches 79.3%
   * of misfiles and exchanges 1.40 correct decisions per misfile caught. Anyone re-tuning it is
   * picking a point on a monotone curve according to what an unnecessary ASK costs against what a
   * misfile costs, and should say which they weighted — there is no measurement that will pick it
   * for them.
   *
   * SPACE PROVENANCE (#90's discipline): every figure above is `bge-m3` on the live `monet-hq`
   * store, legality-aware engine-driven replay, 2026-08-26, n=682 over the legal gap and n=266 at
   * the 0.12 bar. None of it travels to another embedder — see PER-MODEL below.
   *
   * THE FLATNESS ARGUMENT THAT ORIGINALLY MADE THIS CASE IS SUPERSEDED (2026-08-25). It read:
   * "Precision of attaches is FLAT at ~74% across the whole tauAttach range (measured 0.50 -> 0.75
   * on the live monet-hq corpus, n=788): raising tauAttach trades correct attaches for forks
   * without improving which concept wins." That sweep is a `Xenova/bge-small-en-v1.5` 384-dim
   * measurement — scripts/measure-attach-thresholds.ts imports no embedder and reads the store's
   * stored vectors, and monet-hq did not migrate to bge-m3 until 2026-08-24. On bge-small it
   * reproduces (73.9% -> 76.9%, near-flat until the top). Re-run on the bge-m3 store 2026-08-25,
   * same script, same n=788, precision RISES across the sweep:
   *
   *   0.50 -> 76.3%   0.55 -> 76.3%   0.58 -> 76.3%   0.60 -> 76.3%   0.62 -> 76.2%
   *   0.65 -> 76.9%   0.68 -> 77.9%   0.70 -> 79.6%   0.72 -> 81.3%   0.75 -> 86.2%
   *
   * So in the space that ships, raising tauAttach DOES buy precision — nearly 10 points of it — and
   * "flat, therefore pointless" is no longer a reason to prefer the margin gate. What survives is
   * the reason above, which never depended on flatness: tauAttach asks "similar enough", the margin
   * asks "sure it is THIS one", and only the second is a statement about identity. The two are not
   * alternatives, and no constant here moves on this measurement — but anyone reaching for the
   * flatness claim to argue against a tauAttach change should know it was never measured in this
   * space. (resolution.ts's ASK branch carried a copy of the same sentence — never a second
   * measurement — and was retired with it on the same day.)
   *
   * PER-MODEL, AND NOT OPTIONAL-BY-ACCIDENT: this is a gap between two `rank` values, and `rank` is
   * `cosine * (1 + LEXICAL_BOOST * overlap)` — so it scales with the space AND with how much
   * lexical signal the space's tokenizer can see. Omitted means no margin gate at all (every
   * above-tau nomination attaches, the pre-#86 behaviour), which is the honest default for a model
   * nobody has measured: a borrowed margin would gate a space it was never derived in.
   */
  tauMargin?: number;
  /**
   * UPPER BOUND ON THE MARGIN GATE'S BAND: a centroid cosine at or above this takes the attach
   * WITHOUT consulting the margin. Defined only where it has been measured; omitted means no upper
   * bound at all and the margin gate runs on every above-tau nomination, exactly as before.
   *
   * WHAT IT ANSWERS THAT tauMargin CANNOT. The margin asks "am I sure it is THIS one" by comparing
   * the winner to the runner-up — a question about SEPARATION, which goes quiet the moment two
   * candidates are genuinely close. But the identity half of the decision has a second, independent
   * witness the gate never consults once it has decided to ask: the winner's own centroid score,
   * i.e. how well the incoming evidence agrees with everything that concept already holds. A
   * near-tie between a coherent home and some neighbour is not the same situation as a near-tie
   * between two neighbours neither of which the evidence sits inside, and the margin alone cannot
   * tell them apart. This says: above a high enough centroid, coherence is already confirmed and the
   * separation question stops being worth a round-trip.
   *
   * WHY AN UPPER BOUND RATHER THAN A LOWER tauMargin. Lowering the margin buys the same ask-rate
   * reduction by discarding the separation test everywhere, including where it is doing its work.
   * This discards it only where a second signal already answers the question, so the asks it removes
   * are the ones with an independent reason to be safe.
   *
   * IT ASSUMES THE STORED CENTROID IS THE TRUE MEAN OF THE CONCEPT'S LIVE EVIDENCE. That is what
   * "coherence is already confirmed" rests on, and it was not true of every store until the centroid
   * writers converged on `centroidOf` and the 1.8.0 one-time reprojection repaired the backlog. A
   * value derived against drifted centroids would be calibrated against a deflated quantity — see
   * the profile's own note for what that did to the derivation. RE-DERIVE IF THE CENTROID DEFINITION
   * EVER CHANGES AGAIN.
   *
   * PER-MODEL, like every other number here: it is a raw cosine against a concept centroid and
   * cosine scales differ by space. The derivation, the numbers, and the honest magnitude live with
   * the profile that carries it (MODEL_PROFILES, embedding-onnx.ts). A borrowed value would bypass
   * the margin gate in a space nobody measured it in, which is strictly worse than not having it.
   */
  tauConfident?: number;
  /**
   * Lower bound of the `related` edge band, `edgeSimMin <= cos < tauAttach`. Per-model because it
   * is a raw cosine and cosine scales differ by space; omitted means the engine's embedder-class
   * fallback, which is a guess about the class rather than a measurement of the model.
   */
  edgeSimMin?: number;
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
  /**
   * Whether this provider's space needs the LEXICAL ARM (#155, src/lexical-overlap.ts).
   *
   * A SEMANTIC embedder maps a technical corpus into a narrow region — on the live store, max-cosine
   * alone returns an observation to its own concept 46.3% of the time and short-query search recall
   * is R 14.9% — and IDF-weighted token overlap is what tells those neighbours apart. A LEXICAL
   * embedder already scores trigram overlap, so the arm double-counts there: wired in globally it
   * regressed three eval gates that run on HashingEmbeddingProvider, while on the shipping semantic
   * model it lifts read-side R by 22-28 points.
   *
   * So this is a property of the SPACE, not a global switch, which is the same shape
   * recommendedThresholds already has. Omitted means false: a provider that says nothing gets the
   * pre-#155 behaviour, and `rank` then equals `score` everywhere.
   */
  readonly needsLexicalArm?: boolean;
  /**
   * The segment token budget this provider's space stays RELIABLE at (#155, src/embed-budget.ts).
   *
   * Same shape and same reason as recommendedThresholds: it is a property of the SPACE, measured in
   * that space, not a global. RELIABLE_EMBED_TOKENS is the documented fallback for a provider that
   * says nothing — it is a real measurement, but of a model this may not be. Omitting it is honest
   * for an unprofiled provider; carrying another model's number silently is not.
   *
   * MUST be a positive finite number when present. A 0, a negative, or a NaN is treated as absent
   * rather than honoured — see segmentTokenBudget for why an unguarded 0 degenerates to one segment
   * per character.
   */
  readonly reliableSegmentTokens?: number;
  /**
   * The card-emission floor for search() in this provider's space (src/retrieval.ts).
   *
   * An absolute cosine, so it is a property of the SPACE like the bands and the segment budget.
   * NATIVE_SCORE_FLOOR is the documented fallback; must be finite and in [0, 1) when present.
   */
  readonly nativeScoreFloor?: number;

  /**
   * Whether this provider reads ONLY Latin-script text (#155).
   *
   * An English-only model maps text in a script it never saw to essentially arbitrary directions.
   * Nothing errors: the write is accepted, the row is fetchable, and it is unreachable by search
   * forever — the same silent hole the window guard exists to close, in a different dimension. And it
   * is worse than the window case, because the store is PINNED to one embedder: content written in
   * Korean under a multilingual model cannot be rescued by re-embedding once the pin moves to an
   * English one. The commitment has to be enforced BEFORE the content accumulates, not discovered at
   * migration.
   *
   * OMITTED MEANS UNKNOWN, AND UNKNOWN MEANS PERMISSIVE. A provider that says nothing gets no gate —
   * refusing writes on a guess would be the same invented-limit failure the window guard refuses to
   * make. Only a provider that positively declares its restriction gets it enforced.
   */
  readonly readsOnlyLatinScript?: boolean;
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

    return normalizeVector(v);
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

/**
 * THE CONCEPT CENTROID: the L2-normalized arithmetic mean of a concept's live evidence vectors.
 * ONE definition, shared by every writer of `concepts.embedding` that has evidence in hand —
 * `recomputeNativeConceptProjection`, `attach`, `detach`'s two rebuilds and `mergeConceptInto`
 * (engine.ts) — so that the vector any one of them writes is the vector a later recompute would
 * write for the same set, and no two of them can disagree about what the column means.
 *
 * IT REPLACED A RUNNING BLEND, and the difference is not cosmetic. Folding each observation in with
 * `blend()` re-inflates the accumulated direction to full integer weight at every step, as if every
 * prior member had agreed perfectly with it; the result depends on the ORDER the evidence arrived
 * in and drifts off the mean of the same set (measured through the engine: five observations in two
 * arrival orders, cos 0.9968). A mean has neither property — it is order-free and path-free by
 * construction — which is why this, and not the blend, is what "the concept's vector" means.
 *
 * ORDER STILL MATTERS TO THE LAST ULP, and callers owe that. Float addition is not associative, so
 * the summation order fixes the low bits; every engine caller sums its evidence in `ORDER BY id
 * ASC`, which is what makes attach's write and a later recompute BYTE-identical rather than merely
 * close. A caller summing the same set in another order gets the same centroid to ~7 digits and a
 * different one to `toEqual`.
 *
 * `vector[d] ?? 0` on a short member, matching the recompute this was extracted from: a width
 * mismatch is a store-level defect the width assertions exist to catch, and silently reading past
 * the end of one member is not this function's error to raise.
 *
 * A ZERO VECTOR STAYS ZERO — the mean of placeholders is the zero placeholder, and `normalizeVector`
 * divides by `mag || 1` rather than manufacturing a measurement out of "not measured".
 *
 * Callers must not pass an empty set: the mean of nothing is not a vector, and a width would have to
 * be invented to return one. Every caller has its own answer for "no live evidence" (the recompute
 * writes an explicit `embedder.dim` placeholder; the merge keeps the vector it already had), and
 * those answers differ, so this function refuses rather than picking one for them.
 */
export function centroidOf(vectors: readonly Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("centroidOf: no vectors to average");
  const out = new Float32Array(vectors[0]!.length);
  for (let d = 0; d < out.length; d++) {
    let sum = 0;
    for (const vector of vectors) sum += vector[d] ?? 0;
    out[d] = sum / vectors.length;
  }
  return normalizeVector(out);
}

/**
 * Running-mean blend of a concept's vector with a new supporting observation.
 *
 * NO LONGER A CENTROID WRITER. Every `concepts.embedding` path that used to call this — `attach`,
 * `detach`'s two rebuilds — now goes through `centroidOf` above, because this one is
 * path-dependent (see that comment). Retained as an exported vector primitive; nothing in the
 * engine calls it.
 */
export function blend(current: Float32Array, next: Float32Array, currentCount: number): Float32Array {
  const out = new Float32Array(current.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (current[i] * currentCount + next[i]) / (currentCount + 1);
  }
  return normalizeVector(out);
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
  return normalizeVector(out);
}

/**
 * L2-normalize IN PLACE, returning the same array.
 *
 * EXPORTED because `cosine()` above is a bare dot product that asserts "both vectors are
 * L2-normalized", and every path that persists a vector therefore owes that invariant. It was
 * module-private, so a caller outside this file that built a vector arithmetically — the concept
 * centroid in engine.ts's recomputeNativeConceptProjection — could not honour it and wrote a
 * short vector that every centroid comparison then read as a low cosine.
 *
 * A ZERO VECTOR STAYS ZERO (`mag || 1` divides by 1, not by 0). That is load-bearing, not an
 * accident: an all-zero embedding is the PLACEHOLDER isZeroVector exists to detect, and scaling it
 * to unit length would turn a "not measured" into a measurement. Callers relying on that contract:
 * HashingEmbeddingProvider.embed (a text that tokenizes to nothing), and the concept centroid of a
 * concept whose every live observation is still a placeholder.
 */
export function normalizeVector(v: Float32Array): Float32Array {
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

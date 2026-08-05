import { homedir } from "node:os";
import { resolve } from "node:path";

import type { EmbeddingProvider, EmbeddingThresholds } from "./embedding";
import { HashingEmbeddingProvider, validateEmbeddingProviderOutput } from "./embedding";

/**
 * Where the ONNX model files are cached on disk (#90).
 *
 * transformers.js defaults `env.cacheDir` to `<the library's own directory>/.cache`, which for a
 * global install resolves INSIDE node_modules. The model is then part of the install rather than
 * part of the user's data, so every reinstall deletes ~480MB that took minutes to acquire and the
 * next start has to fetch it again. It belongs next to the store, in ~/.monet, where a reinstall
 * cannot reach it.
 *
 * This is not merely a slow-start annoyance. A store that has minted an embedder pin does not serve
 * at all while the pinned model is unloadable (instantiateEmbedderForPin refuses to substitute; see
 * MonetCore.ensureEmbedderPin), so on a machine that is offline or behind a slow link, a wiped cache
 * is an outage. Keeping the cache outside the install is what makes reinstall a no-op for it.
 *
 * `MONET_MODEL_CACHE` overrides the location (shared cache, non-standard home, read-only ~).
 */
/**
 * A model id that transformers.js will load straight off disk rather than fetch and cache. Kept
 * deliberately loose, matching the loader's own recognizer: a hub id is "owner/repo" with no leading
 * or absolute path shape, and everything else path-flavoured — relative, POSIX-absolute, Windows,
 * UNC — is local. Wrong in the harmless direction if a future id shape fools it: the caller is told
 * to check a path instead of a cache, not told to delete something.
 */
export function isLocalModelPath(modelId: string): boolean {
  return modelId.startsWith(".") || modelId.startsWith("/") || modelId.startsWith("~")
    || modelId.includes("\\") || /^[A-Za-z]:/.test(modelId);
}

export function resolveModelCacheDir(): string {
  const override = process.env.MONET_MODEL_CACHE?.trim();
  return override ? resolve(override) : resolve(homedir(), ".monet", "models");
}

// NOT DONE, deliberately: adopting an existing in-install cache instead of re-downloading it once.
// It would be dead code on the only path that matters. The new location ships inside a new package
// version, and installing that version is what deletes node_modules — so by the time this code first
// runs, the cache it would adopt is already gone. It would fire only for a developer who swaps source
// without reinstalling deps. Not worth carrying a renameSync, whose blast radius is a directory move,
// for that. The upgrade therefore pays one final download; every reinstall after it pays none.

/**
 * Real semantic embeddings via a bundled ONNX model (transformers.js) — in-process,
 * no external service, no Ollama. The model loads lazily on first `embed()` and is
 * cached on disk after the first download.
 *
 * Default: DEFAULT_MODEL — see its own note for what it is and why. Every default this class has
 * carried has been 384-dim, so a store's vector WIDTH survives a change of default; the vectors
 * themselves never do, which is what embedder_migration exists for. Per-checkpoint properties
 * (bands, script restriction) live in MODEL_PROFILES rather than on this class, because they are
 * facts about a space and not about a provider. This is async by nature — which is exactly why the
 * engine's write path (`store`/`search`) is async.
 *
 * `@huggingface/transformers` is an OPTIONAL dependency, imported dynamically through a
 * non-literal specifier so (a) the default lexical provider never pulls it in and
 * (b) typecheck passes without it installed. Selecting this provider without the package
 * installed throws from `embed()` with an install hint.
 */
interface FeatureExtractor {
  (text: string, opts: { pooling: "mean"; normalize: boolean }): Promise<{ data: Float32Array }>;
}

interface Tokenizer {
  encode: (text: string) => unknown[];
  /** The selected model's own declared window; absent or non-finite on checkpoints that omit it. */
  model_max_length?: number;
}

interface TransformersModule {
  pipeline: (task: string, model: string, opts: { cache_dir: string }) => Promise<unknown>;
  AutoTokenizer: { from_pretrained: (model: string, opts: { cache_dir: string }) => Promise<Tokenizer> };
}

/**
 * A tokenizer that refuses everything, used when a model ships no usable `model_max_length`. Better
 * to report "unknown window" than to invent one: a guessed number is exactly the failure mode this
 * whole guard exists to prevent, one layer up.
 */
const UNKNOWN_WINDOW = null;

/**
 * What is known about a specific checkpoint, as opposed to about this provider CLASS.
 *
 * The class accepts any hub id, so nothing here can be a class constant. A threshold is a property of
 * the SPACE, and carrying one model's bands into another is the precise mistake #155 exists to
 * document — it is how the shipping tauAttach came to sit under its own corpus's noise floor.
 *
 * Every band below was derived the same way: replay the live corpus through the REAL nomination
 * decision in that model's own space (scripts/measure-attach-thresholds.ts), sweep candidate
 * thresholds, and stop where the exchange rate between a recoverable fork and an unrecoverable wrong
 * attach stops paying. Not from a cosine distribution, and not by scaling another model's number.
 */
interface ModelProfile {
  thresholds: EmbeddingThresholds;
  /** Declared only where the model genuinely cannot read other scripts; see EmbeddingProvider. */
  readsOnlyLatinScript?: boolean;
}

/**
 * KNOWN GUESS, and labelled as one. Any checkpoint without a profile gets these — the values the
 * codebase carried before #155, themselves derived for a different model and a different quantity.
 * They are kept so an unmeasured model still runs; they are not evidence about it.
 */
const LEGACY_UNMEASURED_THRESHOLDS: EmbeddingThresholds = { tauAttach: 0.72, tauAmbiguous: 0.5 };

/**
 * The checkpoint a NEW store pins to (#155).
 *
 * bge-small-en-v1.5 over the multilingual MiniLM it replaces, measured on the live corpus at every
 * layer that matters: concept-level search R@1 56.0% -> 65.8% on short queries and 56.4% -> 75.5%
 * on long ones, nomination argmax 67.1% -> 72.8%, exact-observation recall 90.4% -> 97.4%. It is a
 * QUARTER the parameters and keeps the same 384 width, so it costs less to run and a migration is a
 * re-embed rather than a width change.
 *
 * The two 768-dim candidates measured alongside it (bge-base-en, multilingual-e5-base) land within
 * 1.6 points on both query shapes — inside the standard error at n=739. The choice is therefore a
 * cost decision, not a quality one, and that is only visible because the comparison was run at the
 * layer the decision affects rather than on the near-saturated one.
 *
 * ENGLISH-ONLY, and that is a real constraint rather than a footnote: this checkpoint declares
 * readsOnlyLatinScript, so a store pinned to it REFUSES non-Latin content at write and query time.
 * The store's content is English by ratified preference and the multilingual reason (an Obsidian
 * vault reached through the source pipeline) no longer applies, but any EXISTING store holding
 * non-Latin content must deal with that content before migrating — a pinned store's vectors cannot
 * be rescued after the fact.
 *
 * CHANGING THIS DOES NOT MOVE AN EXISTING STORE. A store that has minted a pin keeps it until an
 * explicit embedder migration; this only decides what a fresh store adopts.
 */
export const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

const MODEL_PROFILES: Record<string, ModelProfile> = {
  /*
   * Measured on example-circle, 739 replays, at LEXICAL_BOOST = 1.0:
   *   0.65 -> 70.5% correct / 27.2% wrong / 2.3% fork
   *   0.70 -> 67.7% / 24.4% /  8.0%   <- chosen
   *   0.72 -> 63.9% / 22.6% / 13.5%
   * From 0.65 to 0.70 the trade is one-for-one (2.8 correct for 2.8 wrong), which the recoverable/
   * unrecoverable asymmetry settles in favour of the higher bar. Past 0.70 it costs two correct
   * attaches per wrong one removed, and the asymmetry no longer carries it. The 0.72 this replaces
   * was never derived on this model at all.
   */
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": { thresholds: { tauAttach: 0.70, tauAmbiguous: 0.5 } },
  /*
   * Measured the same way, same corpus, same blend weight:
   *   0.72 -> 73.3% correct / 25.2% wrong /  1.5% fork   (threshold nearly inert here)
   *   0.75 -> 70.6% / 22.1% /  7.3%
   *   0.78 -> 63.3% / 16.2% / 20.4%   <- chosen
   *   0.80 -> 51.3% / 11.5% / 37.2%
   * This space runs HIGHER than the multilingual one, so the old 0.72 would have been almost inert —
   * carrying it across is exactly the failure this file's profile table exists to prevent. 0.72->0.75
   * removes more wrong than correct outright; 0.75->0.78 costs 7.3 correct for 5.9 wrong and is
   * justified by the asymmetry; 0.78->0.80 costs 2.6 correct per wrong and is not.
   *
   * tauAmbiguous stays 0.5 deliberately: nothing on this corpus nominates below 0.65, so every fork
   * lands in the ambiguous band and earns a possible-duplicate edge. Raising it would start creating
   * concepts with no link back, and no measurement here says where that line belongs.
   */
  "Xenova/bge-small-en-v1.5": {
    thresholds: { tauAttach: 0.78, tauAmbiguous: 0.5 },
    readsOnlyLatinScript: true,
  },
};

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  /** From MODEL_PROFILES for a known checkpoint; the labelled legacy guess otherwise. */
  readonly recommendedThresholds: EmbeddingThresholds;
  /** Semantic space: neighbours are close and the lexical arm is what separates them (#155). */
  readonly needsLexicalArm = true;
  readonly readsOnlyLatinScript?: boolean;
  readonly modelId: string;
  private readonly model: string;
  private extractor: Promise<FeatureExtractor> | null = null;
  private tokenizer: Promise<Tokenizer> | null = null;

  constructor(opts: { model?: string; dim?: number } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? 384;
    this.modelId = this.model;
    const profile = MODEL_PROFILES[this.model];
    this.recommendedThresholds = profile?.thresholds ?? LEGACY_UNMEASURED_THRESHOLDS;
    this.readsOnlyLatinScript = profile?.readsOnlyLatinScript;
  }

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const specifier = "@huggingface/transformers";
        let mod: TransformersModule;
        try {
          mod = (await import(specifier)) as TransformersModule;
        } catch {
          throw new Error(
            "OnnxEmbeddingProvider requires '@huggingface/transformers'. " +
              "Install it (`pnpm --filter @monet/core add @huggingface/transformers`) " +
              "or use the default HashingEmbeddingProvider.",
          );
        }
        // #90: transformers.js otherwise caches into a path derived from its OWN directory, i.e.
        // inside node_modules, where the next reinstall deletes it. `cache_dir` is passed per call
        // rather than set on the module's `env` global, because monet-core is a library: a host
        // that embeds it may have configured transformers for its own models, and overwriting a
        // process-wide setting would silently redirect that host's unrelated loads into ~/.monet
        // (Codex review, PR #130).
        //
        // Verified against 3.8.1, not assumed: pipeline() forwards its options to loadItems(),
        // which hands the SAME pretrainedOptions to every class it constructs — tokenizer, model
        // and processor alike (pipelines.js `loadItems(classes, model, pretrainedOptions)`). A
        // probe confirmed the behavior end to end: with the global left at its package default
        // (which does not hold the model) and `allowRemoteModels` disabled, a load with only
        // `cache_dir` set succeeded, so no sub-fetch silently fell back to the global. Being an
        // argument rather than a global also removes the ordering hazard entirely — there is no
        // "set it too late" state to get wrong.
        return (await mod.pipeline("feature-extraction", this.model, {
          cache_dir: resolveModelCacheDir(),
        })) as FeatureExtractor;
      })();
    }
    return this.extractor;
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Float32Array.from(output.data);
  }

  /**
   * Loads the tokenizer ALONE — a few hundred KB of vocab, not the ~480MB model. That separation is
   * what makes refusing a write cheap: the budget check never pays for a model load, so a caller can
   * be told its content is too long without the store ever warming an embedder. It also serves
   * `inputWindow`, so both answers come from one lazy load of the SELECTED model's own files.
   */
  private loadTokenizer(): Promise<Tokenizer> {
    if (!this.tokenizer) {
      this.tokenizer = (async () => {
        // Non-literal specifier, same as load() above and for the same reason (Codex review, PR
        // #134): `@huggingface/transformers` is an OPTIONAL dependency, and TypeScript resolves a
        // string-literal dynamic import at compile time — so a literal here reports TS2307 and
        // breaks typecheck in exactly the dependency-free, hashing-only configuration this file
        // goes out of its way to support.
        const specifier = "@huggingface/transformers";
        const mod = (await import(specifier)) as TransformersModule;
        return mod.AutoTokenizer.from_pretrained(this.model, { cache_dir: resolveModelCacheDir() });
      })();
    }
    return this.tokenizer;
  }

  async countTokens(text: string): Promise<number> {
    return (await this.loadTokenizer()).encode(text).length;
  }

  /**
   * The window of the model THIS instance was constructed for, read from that model's own tokenizer
   * config (`model_max_length`) rather than assumed. `model` is caller-supplied — any hub id or
   * local path — so a class constant would be right only for the default checkpoint and silently
   * wrong for every other one, in both directions.
   *
   * A non-finite or absent value reports unknown rather than a guess, which callers treat as
   * unbounded: refusing writes against an invented number would be the same silent-wrongness this
   * guard exists to remove.
   */
  async inputWindow(): Promise<number | null> {
    const declared = (await this.loadTokenizer()).model_max_length;
    return typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? declared
      : UNKNOWN_WINDOW;
  }
}

/**
 * The local-runtime embedder selector (ADR §6 "local embeddings from day one").
 *
 * Prefers real semantic MiniLM embeddings, but DEGRADES GRACEFULLY to the lexical
 * HashingEmbeddingProvider if the optional model can't load (dependency not installed,
 * not bundled in a publish build, offline on first run). It warms the model once at
 * startup so the cost (and any failure) surfaces predictably here rather than mid-request.
 *
 *   MONET_EMBEDDER=onnx     → require MiniLM (throw if it can't load)
 *   MONET_EMBEDDER=hashing  → force the lexical embedder (fast, no model, deterministic)
 *   (unset)                 → MiniLM if available, else lexical
 *
 * Logs go to stderr so they never corrupt the stdio MCP channel.
 */
export type LocalEmbedderSelection = "onnx" | "explicit-hashing" | "implicit-hashing-fallback";

export interface LocalEmbedderWithProvenance {
  provider: EmbeddingProvider;
  selection: LocalEmbedderSelection;
}

/**
 * Selects the local embedder exactly like createLocalEmbedder(), while preserving whether hashing
 * was an explicit operator choice or an automatic fallback. Store-aware startup needs that
 * distinction before a fresh store permanently records its first embedder pin.
 */
export async function createLocalEmbedderWithProvenance(
  opts: { model?: string } = {},
): Promise<LocalEmbedderWithProvenance> {
  const pref = process.env.MONET_EMBEDDER?.toLowerCase();
  if (pref === "hashing" || pref === "lexical") {
    return { provider: new HashingEmbeddingProvider(), selection: "explicit-hashing" };
  }

  const onnx = new OnnxEmbeddingProvider(opts);
  try {
    console.error("[monet-core] loading local embedding model (paraphrase-multilingual-MiniLM-L12-v2; first run downloads once)…");
    const warmup: unknown = await onnx.embed("warmup"); // forces model load + native init now, not on the first store
    validateEmbeddingProviderOutput(onnx, warmup);
    console.error("[monet-core] semantic embeddings ready (multilingual MiniLM, 384-dim).");
    return { provider: onnx, selection: "onnx" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (pref === "onnx") throw new Error(`MONET_EMBEDDER=onnx but MiniLM failed to load: ${why}`);
    console.error(`[monet-core] MiniLM unavailable (${why}); falling back to lexical embedder.`);
    console.error("[monet-core] recall will be lexical, not semantic. Set MONET_EMBEDDER=onnx to require MiniLM.");
    return { provider: new HashingEmbeddingProvider(), selection: "implicit-hashing-fallback" };
  }
}

export async function createLocalEmbedder(opts: { model?: string } = {}): Promise<EmbeddingProvider> {
  return (await createLocalEmbedderWithProvenance(opts)).provider;
}

/**
 * The ONNX default before the item 9 multilingual swap (English-only, 384-dim). Not used by
 * `createLocalEmbedder` (which always names today's default) — kept as a named identity for the
 * embedder-pin backfill: a pre-pin store found holding 384-dim vectors necessarily predates the
 * swap, so THIS is the only model that could have produced them (see MonetCore.ensureEmbedderPin,
 * engine.ts).
 */
export const LEGACY_ONNX_DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// INVARIANT (Codex review, PR #51, FIX F, widened by FIX L, widened again by FIX Q): the loader's
// recognized-format space MUST cover at least every model-id shape the provider constructors
// accept, or this build can mint a pin (source='created', via a fresh store's constructor-provided
// embedder) that its OWN loader then refuses to satisfy. OnnxEmbeddingProvider passes `model`
// straight through to transformers.js's pipeline() with zero validation or transformation (see
// `mod.pipeline("feature-extraction", this.model)` below) — confirmed by reading the call site, not
// assumed: this.model is whatever opts.model ?? the class default was, untouched. transformers.js's
// pipeline() natively accepts a local filesystem path — relative ("./models/foo"), POSIX-absolute
// ("/opt/models/foo"), or WINDOWS-absolute/UNC ("C:\models\foo", "\\host\share\models\foo") — in
// addition to a Hugging Face hub "<owner>/<repo>" id. OnnxEmbeddingProvider places no restriction
// narrower than that, and no platform check: a Windows host can pass a backslash-separated path
// exactly as freely as a POSIX host passes a forward-slash one. FIX L widened the recognizer from
// owner/repo-only to "any forward slash", closing the POSIX-path gap — but a Windows path like
// `C:\models\foo` contains ZERO forward slashes, so it still fell through to the unrecognized-format
// branch and the same "this build minted a pin its own loader refuses" bug FIX L closed reopened for
// exactly the platform FIX L didn't test on.
//
// The recognizer is now deliberately "anything with a forward slash OR a backslash, anywhere" — not
// a platform-specific path grammar — for the same reason FIX L gave for its own widening: the
// constructor's own accepted space is that broad and un-validated, so a narrower regex here would
// just reintroduce the same class of bug for whatever shape (or platform) it excludes next. Ordered
// AFTER the hashing:... match (checked first, below) so a hashing pin never falls through to an
// attempted (and certain-to-fail) ONNX load. Strings with neither separator (no owner/repo, no path
// of either flavor) still fall through to the unrecognized-format branch with no instantiation
// attempt at all. Separator-CONTAINING garbage (a malformed path, a nonexistent hub id) fails at an
// actual load attempt, wrapped as UnsatisfiableEmbedderError below, rather than being rejected
// instantly by format alone — the same closed outcome (this store still does not serve), just a
// slower path to it. This was already true for owner/repo- and POSIX-path-shaped garbage since FIX F
// and FIX L respectively; backslash-shaped garbage now joins them for the same reason.
const RECOGNIZED_ONNX_PIN_FORMAT = /[/\\]/;
const HASHING_PIN_FORMAT = /^hashing:dim=(\d+):tok=(\d+)$/;

/** Parse the width/version identity encoded by a canonical hashing embedder pin. */
export function parseHashingEmbedderPin(modelId: string): { dimension: number; tokenizerVersion: number } | null {
  const match = modelId.match(HASHING_PIN_FORMAT);
  if (!match) return null;
  const dimension = Number(match[1]);
  const tokenizerVersion = Number(match[2]);
  if (!Number.isSafeInteger(dimension) || !Number.isSafeInteger(tokenizerVersion)) return null;
  return { dimension, tokenizerVersion };
}

/**
 * Thrown by instantiateEmbedderForPin when a store's pinned embedder cannot be satisfied: the pin
 * names a hashing tokenizer version this build doesn't implement, an ONNX model that failed to
 * load, or a modelId format this build has never seen. `modelId` is always the pin that could not
 * be satisfied (never the fallback the caller might have been using instead — there is no
 * fallback: see instantiateEmbedderForPin's doc comment).
 *
 * Styled after engine.ts's EmbedderMismatchError: constructor args become public readonly fields,
 * `name` is set explicitly so `instanceof` and `.name` both identify it after serialization.
 */
export class UnsatisfiableEmbedderError extends Error {
  constructor(
    public readonly modelId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UnsatisfiableEmbedderError";
  }
}

/**
 * Strictly instantiate the embedder named by a store's pin (`sync_meta.embedder_model_id`) —
 * the enforcement half of the embedder-pin ADR. Called by MonetCore.ensureEmbedderPin whenever the
 * constructor-provided embedder doesn't already satisfy the pin.
 *
 * NEVER substitutes another embedder. There is no fallback of any kind here — that silent
 * ONNX→hashing degrade is exactly what createLocalEmbedder does for a FRESH store's initial
 * choice, and exactly what a PINNED store must never do (a fallback would silently write a
 * different vector space into a store that already committed to one). Any failure — an unknown
 * hashing tokenizer version, an ONNX model that won't load, a modelId this build doesn't
 * recognize — throws UnsatisfiableEmbedderError and the store must not serve.
 */
export async function instantiateEmbedderForPin(modelId: string): Promise<EmbeddingProvider> {
  const hashingPin = parseHashingEmbedderPin(modelId);
  if (hashingPin) {
    try {
      return new HashingEmbeddingProvider(hashingPin.dimension, hashingPin.tokenizerVersion);
    } catch (e) {
      throw new UnsatisfiableEmbedderError(
        modelId,
        `This store is pinned to '${modelId}', but this Monet build does not implement that hashing ` +
          `tokenizer version. The store may have been created by a NEWER version of Monet — upgrade ` +
          `the shipped \`@team-monet/monet\` package and try again.`,
        { cause: e },
      );
    }
  }

  if (RECOGNIZED_ONNX_PIN_FORMAT.test(modelId)) {
    const onnx = new OnnxEmbeddingProvider({ model: modelId });
    let warmup: Float32Array;
    try {
      warmup = await onnx.embed("warmup"); // forces model load now, same discipline as createLocalEmbedder
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new UnsatisfiableEmbedderError(
        modelId,
        `This store is pinned to '${modelId}', but this Monet instance could not load that model ` +
          `(${why}). The store may have been created by a NEWER version of Monet, or the model failed ` +
          `to download — upgrade the shipped \`@team-monet/monet\` package and/or check network access. ` +
          // Naming the path is what makes an interrupted download recoverable: the cache records a
          // hit by path existence alone (no temp-file rename upstream), so a truncated file stays a
          // hit forever, and this store does not serve until someone deletes it. Before #90 a
          // reinstall cleared it by accident; now nothing does.
          //
          // THIS MODEL's directory, never the cache root (Codex review, PR #130 — landed after that
          // PR merged and carried here). MONET_MODEL_CACHE may point at a cache shared with other
          // consumers, which this provider's own documentation offers as a supported setup; telling
          // an operator to delete the root would destroy every other model there to recover one
          // truncated file.
          // Only for a HUB id (Codex review, PR #134). transformers.js loads a local path — "./models/foo",
          // "/opt/models/foo", a Windows path — directly from disk and never caches it here, so the
          // cleanup line would name a directory that does not exist and cannot recover anything. The
          // recognizer is the same forward-or-back-slash test the loader itself uses, inverted: a bare
          // "owner/repo" is a hub id, anything path-shaped is not.
          (isLocalModelPath(modelId)
            ? `'${modelId}' is a local path, so nothing was cached for it — check that the path exists ` +
              `and holds a complete model.`
            : `This model is cached in ${resolveModelCacheDir()}/${modelId} — if its download was ` +
              `interrupted, delete that model's directory (not the cache root, which may be shared) to ` +
              `force a clean re-fetch.`),
        { cause: e },
      );
    }
    // Codex review (PR #51, FIX B, superseded by FIX J below): OnnxEmbeddingProvider.dim is a
    // class-declared constant (`opts.dim ?? 384`), NOT measured from the model's actual output — a
    // pin naming a model this build has never hardcoded a dim for (e.g. a future non-384-dim
    // Xenova release, or any custom model FIX F's widened recognizer now accepts) would otherwise
    // load "successfully" while this.embedder.dim silently disagrees with what embed() actually
    // produces.
    //
    // FIX J (PR #51): verified by reading embed() (above) — it is PURELY DECLARATIVE. embed() never
    // references this.dim at all; it returns Float32Array.from(output.data) straight from the
    // model's own pooled output, with no slicing/padding/resizing to match a declared width. So the
    // declared dim can never make embed()'s output correct or incorrect — it can only DESCRIBE that
    // output correctly or incorrectly. Since the pin (modelId) alone fully determines the vector
    // space regardless of what dim anyone declared, the right fix is measure-and-adopt, not reject:
    // if the warmup's real width differs from the class default, re-instantiate with the MEASURED
    // width as the declared dim and return THAT — the declaration follows reality. This makes
    // FIX B's mismatch rejection unnecessary (removed); UnsatisfiableEmbedderError below still
    // covers actual load failures. The one cost: a mismatched-default model pays a second lazy
    // model load on its first REAL embed() call (a fresh instance's own this.extractor starts
    // null) — bounded and one-time, and not a re-download: the model is already cached on disk
    // from the warmup just above, so this is a re-init of the runtime session, not a network hit.
    if (warmup.length === onnx.dim) return onnx;
    const measured = new OnnxEmbeddingProvider({ model: modelId, dim: warmup.length });
    const measuredWarmup: unknown = await measured.embed("warmup");
    validateEmbeddingProviderOutput(measured, measuredWarmup);
    return measured;
  }

  throw new UnsatisfiableEmbedderError(
    modelId,
    `This store is pinned to an unrecognized embedder '${modelId}'. The store may have been created ` +
      `by a NEWER version of Monet — upgrade the shipped \`@team-monet/monet\` package to open it.`,
  );
}

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { EmbeddingProvider, EmbeddingThresholds } from "./embedding";
import { HashingEmbeddingProvider, validateEmbeddingProviderOutput } from "./embedding";

/**
 * Where the ONNX model files are cached on disk (#90).
 *
 * transformers.js defaults `env.cacheDir` to `<the library's own directory>/.cache`, which for a
 * global install resolves INSIDE node_modules. The model is then part of the install rather than
 * part of the user's data, so every reinstall deletes ~590MB that took minutes to acquire and the
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
 * Default: DEFAULT_MODEL — see its own note for what it is and why. Every default before this one was
 * 384-dim, so a store's vector WIDTH used to survive a change of default; at 1024 it no longer does,
 * and the vectors never did either — which is what embedder_migration exists for. Per-space
 * properties (width, pooling, dtype, bands, script restriction) live in MODEL_PROFILES rather than on
 * this class, because they are facts about a space and not about a provider. This is async by nature
 * — which is exactly why the engine's write path (`store`/`search`) is async.
 *
 * `@huggingface/transformers` is an OPTIONAL dependency, imported dynamically through a
 * non-literal specifier so (a) the default lexical provider never pulls it in and
 * (b) typecheck passes without it installed. Selecting this provider without the package
 * installed throws from `embed()` with an install hint.
 */
interface FeatureExtractor {
  (text: string, opts: { pooling: Pooling; normalize: boolean }): Promise<{ data: Float32Array }>;
}

/**
 * How a checkpoint turns token states into ONE vector. Not a preference: each model was TRAINED
 * with one of these, and its published cosine behaviour is a fact about that choice. bge-small and
 * the MiniLMs are mean-pooled; the bge-m3 family reads its dense vector off the CLS token. Pooling a
 * model the other way still returns 1024 finite floats, so nothing downstream can catch it — it just
 * silently measures a space the model was never trained to produce.
 */
export type Pooling = "mean" | "cls";

interface Tokenizer {
  encode: (text: string) => unknown[];
  /** The selected model's own declared window; absent or non-finite on checkpoints that omit it. */
  model_max_length?: number;
}

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    opts: {
      cache_dir: string;
      dtype?: string;
      local_files_only?: boolean;
      progress_callback?: (event: ModelLoadProgressEvent) => void;
    },
  ) => Promise<unknown>;
  AutoTokenizer: {
    from_pretrained: (
      model: string,
      opts: { cache_dir: string; local_files_only?: boolean },
    ) => Promise<Tokenizer>;
  };
}

/**
 * A tokenizer that refuses everything, used when a model ships no usable `model_max_length`. Better
 * to report "unknown window" than to invent one: a guessed number is exactly the failure mode this
 * whole guard exists to prevent, one layer up.
 */
const UNKNOWN_WINDOW = null;

/**
 * What transformers.js loads when no dtype is asked for, on the only runtime this package supports.
 * Its own mapping assigns q8 to wasm and falls through to fp32 everywhere else; monet-core is
 * Node-only by construction (better-sqlite3), so "everywhere else" is the only branch reachable here.
 * Named so an omitted profile dtype and an explicitly-stated fp32 compare as the same space rather
 * than as a departure from it.
 */
const EFFECTIVE_DEFAULT_DTYPE = "fp32";

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
  /**
   * Output width of THIS checkpoint. Omitted means the class default (384), which every model this
   * file has ever named happens to share — so no entry declares it yet and nothing changes by its
   * absence. A checkpoint of another width MUST declare it: the declared width is what
   * validateEmbeddingProviderOutput checks embed() against, so a fresh store on an undeclared
   * non-384 model fails its own warmup and never opens. (A PINNED store survives that gap by
   * measuring the real width off the warmup — see instantiateEmbedderForPin's FIX J — which is why
   * a hand-pinned wide model works today while a fresh one would not.)
   */
  dim?: number;
  /**
   * How this checkpoint was TRAINED to reduce token states to one vector; omitted means "mean", the
   * pooling every model named here until now was trained with. Never a preference — see Pooling.
   */
  pooling?: Pooling;
  /**
   * Weight precision to load at; omitted leaves transformers.js's own default (fp32 off the browser).
   * Declared here rather than passed by a caller because it is a property of the SPACE, exactly like
   * pooling: two dtypes of one checkpoint produce different vectors.
   *
   * A PROFILE THAT DECLARES A NON-DEFAULT POOLING OR DTYPE MUST BE KEYED BY A SPACE ID, not by the
   * bare hub id — see `checkpoint`. Otherwise the store's pin would name the checkpoint while the
   * build silently decided the rest of the space, and changing this field would move every pinned
   * store's vectors without changing anything the migration machinery can see.
   */
  dtype?: string;
  /**
   * The hub id (or path) to actually LOAD, when this profile's key is a space id rather than a
   * checkpoint id. Omitted means the key is itself what gets loaded, which is the case for every
   * profile whose space is fully described by its checkpoint alone.
   *
   * WHY SPACE IDS EXIST. A store's pin is its entire record of which space its vectors occupy, and
   * equality on that string is what the migration machinery, the graft check, and repair all reason
   * with. A checkpoint id under-describes the space as soon as pooling or dtype is a choice: one id,
   * several incompatible vector sets. The hashing provider solved this long ago by naming the
   * tokenizer version in the pin itself (`hashing:dim=256:tok=1`); this is the same move for ONNX.
   * So `Xenova/bge-m3:cls:q8` is a KEY here, not a string anyone parses — the profile it selects
   * carries the pooling, the dtype and the checkpoint to load, which is why no id-parsing exists (and
   * why a Windows path full of colons cannot be mistaken for a decorated id).
   *
   * WHAT IT BUYS AT AN UPGRADE, which is the point. A store pinned to the bare `Xenova/bge-m3` was
   * written in the hand-pinned mean space; a build that now ships `Xenova/bge-m3:cls:q8` does NOT
   * match that pin, so it keeps serving the old space through the old profile and the operator has a
   * real `monet repair --target Xenova/bge-m3:cls:q8` to run. Without the decoration the pin would
   * match, and the new build would start writing CLS vectors into a mean store with nothing anywhere
   * able to notice. Fail-closed on the way down, too: an OLDER build handed a decorated pin cannot
   * load it and refuses to serve, rather than guessing at a checkpoint.
   *
   * DECORATE ONLY WHERE THE SPACE NEEDS IT. Every profile whose pooling is the default and whose
   * dtype is unset stays keyed by its bare hub id, so no store pinned before this existed moves.
   */
  checkpoint?: string;
  /** Declared only where the model genuinely cannot read other scripts; see EmbeddingProvider. */
  readsOnlyLatinScript?: boolean;
  /** Segment budget measured IN THIS SPACE; omitted means fall back to RELIABLE_EMBED_TOKENS. */
  reliableSegmentTokens?: number;
  /** search() card-emission floor measured IN THIS SPACE; omitted means fall back to NATIVE_SCORE_FLOOR. */
  nativeScoreFloor?: number;
}

/**
 * KNOWN GUESS, and labelled as one. Any checkpoint without a profile gets these — the values the
 * codebase carried before #155, themselves derived for a different model and a different quantity.
 * They are kept so an unmeasured model still runs; they are not evidence about it.
 */
const LEGACY_UNMEASURED_THRESHOLDS: EmbeddingThresholds = { tauAttach: 0.72, tauAmbiguous: 0.5 };

/**
 * The space a NEW store pins to.
 *
 * bge-m3 at CLS/q8 over the bge-small-en-v1.5 it replaces — and the case for it is NOT that it
 * retrieves better, because on English it does not. Measured as the nomination decision, it is a tie
 * there (74.2% vs 74.4% on example-circle, 1 replay of 745) while costing 3x the embed latency and 2.4x the
 * resident memory. On a Korean-heavy corpus it wins by 4.1 points, and that gap is the entire
 * quality argument. See its profile entry for every table behind those numbers.
 *
 * WHAT DECIDES IT IS THE ASYMMETRY, not the average. A pin is permanent until an explicit migration,
 * and bge-small declares readsOnlyLatinScript — so a fresh store that adopts it REFUSES non-Latin
 * content at write and query time, forever, and a store that later needs Korean has to be migrated
 * with content already stranded. The reverse error costs latency and memory on a store that turns
 * out to be all English. One of those is recoverable by paying more; the other is recoverable only by
 * rewriting every vector, and only if the content was never refused in the first place. A default is
 * exactly the decision that should be made under that asymmetry, because it is the decision made
 * BEFORE anyone knows what the store will hold.
 *
 * The runtime price is real and is not hidden: ~570MB on disk, ~840MB resident, ~30ms per embed
 * against bge-small's ~130MB / ~490MB / ~10ms. An operator who knows their store is English-only and
 * wants the cheaper space can still pin it explicitly.
 *
 * CHANGING THIS DOES NOT MOVE AN EXISTING STORE. A store that has minted a pin keeps it until an
 * explicit embedder migration; this only decides what a fresh store adopts.
 */
export const DEFAULT_MODEL = "Xenova/bge-m3:cls:q8";

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
  /*
   * The pre-multilingual default, still instantiated for legacy 384-dim pins. English-only, so it is
   * script-restricted — without an entry here a legacy-pinned store bypassed every guard added in
   * #155 (Codex P2, post-merge on PR #156). It carries no measured band because it has never been
   * replayed on this corpus; it takes the labelled legacy pair rather than borrowing another model's.
   */
  "Xenova/all-MiniLM-L6-v2": { thresholds: LEGACY_UNMEASURED_THRESHOLDS, readsOnlyLatinScript: true },
  /*
   * SEGMENT BUDGET, re-derived for this model. Swept by re-segmenting and re-embedding a copy of the
   * live store at each budget, then replaying the DECISION the budget governs — leave-one-out
   * nomination, argmax over every concept in the circle, scored at tauAttach 0.78:
   *
   *   budget   segs/obs   correct   WRONG    fork   attach precision
   *      140       4.17     58.1%   15.5%   26.5%           79.0%
   *      210       2.82     62.5%   16.9%   20.6%           78.7%
   *      280       2.16     63.2%   16.0%   20.8%           79.8%   <- the multilingual-MiniLM value
   *      380       1.69     66.1%   15.6%   18.3%           80.9%   <- chosen
   *      512       1.35     65.5%   18.5%   16.0%           77.9%
   *
   * 380 dominates the inherited 280 on every column — more correct attaches, marginally fewer wrong
   * ones, higher precision, and fewer segments to embed. It reverses the premise the 280 was chosen
   * under: that doc measured longer text collapsing into the zone where unrelated pairs clear
   * tauAttach 64.5% of the time, and in THIS space that collapse is milder and starts later. Past 380
   * it does bite — 512 costs 2.9 points of precision.
   *
   * Two honest limits. This is one user's corpus, so the number is as corpus-bound as any other here;
   * and the harness is deterministic (fixed stride, no RNG), so re-running reproduces rather than
   * estimating variance — the 2.9-point gap over 280 is ~21 of 739 replays and carries no error bar.
   * Raw argmax barely moves across the sweep (67.0-68.7% excluding blobs); what the budget moves is
   * behaviour near the threshold.
   *
   * Existing stores stay segmented at whatever budget wrote them. Re-run
   * scripts/backfill-observation-segments.ts to make a store uniform at the current value.
   */
  "Xenova/bge-small-en-v1.5": {
    /*
     * RELATED-EDGE FLOOR, measured in this space with scripts/measure-fork-and-edge-bands.ts on the
     * live store (284 active concepts, 40,186 pairs). The inherited 0.45 comes from engine.ts's
     * `semantic ? 0.45 : 0.4` — one number for the whole class of semantic models, which is the
     * carried-over-constant failure this table exists to prevent. In THIS space it sits well below
     * the concept-pair median of 0.6000, so it admits most of the corpus:
     *
     *   edgeSimMin   related edges   density   max degree   concepts with no edge
     *         0.45          39,168     97.5%      283/283                       0   <- inherited
     *         0.50          36,912     91.9%          281                       0
     *         0.55          30,873     76.8%          276                       0
     *         0.60          19,949     49.6%          243                       1   <- the pair median
     *         0.65           8,357     20.8%          174                       9
     *         0.70           2,092      5.2%           86                      32   <- chosen
     *
     * At 0.45 the graph is COMPLETE: one concept is linked to all 283 others, so "most connected"
     * is not a fact about the corpus. 0.70 is the first point where the population is a minority of
     * pairs and degree spreads.
     *
     * WHAT THIS NUMBER IS NOT. It is not decision-derived like tauAttach or the segment budget,
     * because after gather's removal (#168) no ranking reads these edges — topConnectedConcepts
     * excludes `related`/`about` by design, topThread uses `co_occurred`, and both curation queues
     * use their own edge types. What remains is the overview's per-type count and the dashboard's
     * force graph, and neither yields an accuracy metric to optimize. So this is a stated display
     * judgement backed by a density sweep, deliberately not dressed up as a derivation. If these
     * edges regain a ranking consumer, re-derive it against THAT decision.
     *
     * Existing stores keep the edges written under the old floor until rederiveAllConceptGraphs
     * rebuilds them.
     */
    thresholds: { tauAttach: 0.78, tauAmbiguous: 0.5, edgeSimMin: 0.70 },
    readsOnlyLatinScript: true,
    reliableSegmentTokens: 380,
    /*
     * CARD-EMISSION FLOOR, re-derived for this model with scripts/measure-recall-floor.ts on the same
     * STARTER_SUITE corpus the 0.12 came from — 20 probe queries, 9 junk queries, observation
     * granularity. Read the way that script says to: take the highest floor still keeping 100% of
     * GOLD, then see what it suppresses.
     *
     *   floor   gold kept   junk cards suppressed   junk queries fully silent
     *    0.12       100.0%                   0.0%                       0.0%   <- MiniLM's value
     *    0.35       100.0%                  18.3%                       0.0%   <- chosen
     *    0.40        97.1%                  52.5%                       0.0%
     *    0.50        91.4%                  97.4%                      22.2%
     *    0.60        54.3%                 100.0%                     100.0%
     *
     * GOLD min is 0.3642 and that is the binding constraint, exactly as it was for 0.12.
     *
     * WHAT THIS DOES NOT RESTORE. On MiniLM 0.12 bought 100% gold AND 82.2% junk suppression. No bge
     * floor buys both: GOLD min (0.3642) sits BELOW JUNK p50 (0.3971), so the distributions overlap
     * and silence on an unanswerable query costs real answers — 0.50 is the first floor that silences
     * any junk query at all, and it drops 8.6% of gold. Representing "the store knows nothing about
     * this" is therefore not a constant problem in this space; it needs a relative or margin-based
     * rule. Tracked in #170.
     */
    nativeScoreFloor: 0.35,
  },
  /*
   * MULTILINGUAL, 1024-dim, CLS-pooled, loaded at q8. Adopted because a store whose content is
   * substantially Korean had already been hand-pinned to it and was being served with every band
   * borrowed from a model it is not — see each field below for what was measured and where.
   *
   * WHAT THIS CHECKPOINT ACTUALLY BUYS, measured as the nomination DECISION (leave-one-out argmax,
   * scripts/measure-attach-thresholds.ts) on two corpora rather than one, because a profile governs
   * every store and the two disagree:
   *
   *   corpus                          bge-small-en-v1.5   bge-m3 (cls, q8)
   *   coda      (56% Korean, n=293)              63.5%              67.6%
   *     └ excluding blob concepts                51.1%              56.1%
   *   example-circle  (English,    n=745)              74.4%              74.2%
   *     └ excluding blob concepts                68.8%              68.3%
   *
   * So it is not a better model, it is a model that reads the content. On English it is a TIE — 1
   * replay of 745, well inside the noise this corpus can resolve — and it costs 3x the embed latency
   * (10ms -> 30ms) and 2.4x the resident memory (491MB -> 839MB) to hold that tie. The English number
   * is the honest reason NOT to reach for this on an English store, and the Korean number is the
   * whole reason it is here. bge-small was never a legal option on that store anyway: it declares
   * readsOnlyLatinScript, so its 63.5% is what a Latin-only model scores when made to read Korean
   * regardless, not an alternative anyone could ship there.
   *
   * NO readsOnlyLatinScript, DELIBERATELY. XLM-RoBERTa vocabulary, 100+ languages. Its ABSENCE is
   * what has been letting Korean writes through on the hand-pinned store, which was luck rather than
   * policy; declared here, the same permission is a decision. Storage language is a ratified
   * preference enforced elsewhere, and this field was never the mechanism for it — it says what the
   * model can READ, and refusing content it reads fine would be a lie about the space.
   */
  /*
   * THE HAND-PINNED SPACE, named so it stops being an accident. Before this table knew the checkpoint
   * at all, a store was pinned to the bare id by hand and served with every band borrowed: mean
   * pooling (the class default, and NOT what this model was trained for), the labelled legacy
   * thresholds, MiniLM's card floor, multilingual-MiniLM's segment budget. Its vectors are real and
   * self-consistent, so this entry describes that space rather than condemning it — the width and the
   * pooling are what those vectors actually are, and the thresholds stay the legacy pair because
   * nothing was ever measured here.
   *
   * IT IS NOT AN OPTION ANYONE SHOULD CHOOSE. `Xenova/bge-m3:cls:q8` below is the measured space; this
   * exists so a store already holding these vectors keeps serving, and keeps serving under a profile
   * that says out loud what it is, until `monet repair --target Xenova/bge-m3:cls:q8` moves it.
   *
   * ONE MEASURED FACT ABOUT IT, from the same replay that chose the pooling: tauAttach is inert in
   * this space. Every candidate from 0.40 to 0.72 scored identically with 0.0% forks, so a store here
   * attaches 100% of arriving observations and 35.2% of them land on the wrong concept.
   */
  "Xenova/bge-m3": {
    dim: 1024,
    pooling: "mean",
    thresholds: LEGACY_UNMEASURED_THRESHOLDS,
  },
  "Xenova/bge-m3:cls:q8": {
    checkpoint: "Xenova/bge-m3",
    dim: 1024,
    /*
     * CLS, from the checkpoint's own model card, and confirmed to matter here rather than taken on
     * faith. Same corpus, same segments, same lexical arm — only the pooling differs (n=293, coda):
     *
     *            argmax   excluding blobs   size 2-4   size 5-9   size 20+
     *   mean      64.8%             52.3%      53.6%       9.5%      81.8%
     *   cls       67.9%             56.1%      57.1%      14.3%      84.5%
     *
     * +3.1 points overall and +3.8 excluding blobs is 9 and 5 replays — small, and it is the SIGN
     * holding across every size bin that carries this, not the margin in any one of them.
     *
     * The larger finding is not in the accuracy column at all: under mean pooling tauAttach is INERT
     * on this corpus. Every candidate from 0.40 to 0.72 produced an identical row and 0.0% forks —
     * every nomination scored above the bar — so a mean-pooled store attaches 100% of incoming
     * observations and 35.2% of them land on the wrong concept, which resolution.ts's own asymmetry
     * calls the unrecoverable direction. Pooling the model the way it was trained is what gives the
     * threshold a live range back (0.65 -> 3.4% fork, 0.70 -> 8.2%, 0.75 -> 15.0%).
     */
    pooling: "cls",
    /*
     * q8, not fp32. Same replay, same corpus, both pooled CLS (n=293, coda):
     *
     *           argmax   excluding blobs   ms/embed   process RSS   on disk
     *   fp32     67.9%             56.1%       49ms        1757MB     2.1GB
     *   q8       67.6%             56.1%       30ms         839MB     570MB
     *
     * One replay apart overall and identical once blobs are excluded, while costing 40% less time and
     * 918MB less memory — on a local always-on server that is not a close call. The int8 kernels are
     * FASTER than fp32 on CPU, so this is not the usual accuracy-for-speed trade; there is no
     * measurable accuracy to trade.
     */
    dtype: "q8",
    /*
     * SEGMENT BUDGET 768, and it REVERSES the finding it inherits. bge-small chose 380 and measured
     * 512 as worse; this model's window is 8192 rather than 512, and the sweep runs the other way.
     * Same method as that one: re-segment a copy of the corpus at each budget through the engine's
     * own resegmentObservations, then replay leave-one-out nomination over it.
     *
     *   example-circle, 745 replays          segs/obs   argmax   correct@0.70   WRONG   fork
     *      280 (the current fallback)      2.38    68.6%          64.2%   18.0%  17.9%
     *      380 (bge-small's value)         1.82    71.1%          67.5%   16.9%  15.6%
     *      512                             1.45    70.5%          68.2%   15.8%  16.0%
     *      768                             1.11    72.3%          71.1%   16.9%  11.9%   <- chosen
     *     1024                             1.04    71.9%          70.3%   18.1%  11.5%
     *
     * (argmax = threshold-independent, excluding blob concepts.) It rises to 768 and flattens; 1024
     * buys nothing because by then there is almost nothing left to split.
     *
     * READ WHAT 768 ACTUALLY MEANS HERE: 1.11 segments per observation. The best budget for this
     * model is the one where the bounded retrieval unit mostly stops dividing — #155 built that
     * apparatus for a 512-token window, and a model with sixteen times the window does better when it
     * is allowed to see the observation whole. That is a statement about this corpus's observation
     * lengths as much as about the model, and it should be re-run if either changes.
     *
     * coda CANNOT DECIDE THIS, and the honest record says so rather than averaging it in: its
     * observations are short enough that every budget lands within 1.5 points (56.1% at 280 down to
     * 55.0% at 768 — one or two replays), and 768 and 1024 produce byte-identical output because
     * nothing splits at either. A corpus that cannot exhibit the effect is not evidence about it.
     */
    reliableSegmentTokens: 768,
    /*
     * tauAttach 0.70, re-derived AT the budget above rather than left where the earlier pass put it —
     * the budget moves behaviour near the threshold, so a tau measured at another budget is a tau
     * measured somewhere else. It did not move, which is worth stating plainly: the same 0.70 chosen
     * at the inherited 280/380 segmentation survives the sweep that replaced it.
     *
     * Swept at LEXICAL_BOOST 1.0, reading DOWN the wrong-attach column and stopping where a
     * recoverable fork stops paying for an unrecoverable wrong attach (resolution.ts's asymmetry):
     *
     *   example-circle @768 (n=745)                    coda @768 (n=293)
     *   tau    correct  WRONG   fork             tau    correct  WRONG   fork
     *   0.64     77.2%  22.3%   0.5%             0.64     66.2%  30.7%   3.1%
     *   0.66     76.2%  21.2%   2.6%             0.66     66.2%  29.0%   4.8%
     *   0.68     74.1%  19.9%   6.0%             0.68     65.5%  28.3%   6.1%
     *   0.70     71.1%  16.9%  11.9%   <-        0.70     63.5%  27.3%   9.2%   <- chosen
     *   0.72     64.2%  13.6%  22.3%             0.72     62.5%  26.3%  11.3%
     *
     * example-circle is the corpus that discriminates, and its exchange rate (correct lost per wrong
     * removed) reads 0.91 at 0.64->0.66, 1.62 at 0.66->0.68, 1.00 at 0.68->0.70, then 2.09 at
     * 0.70->0.72. The precedent this file already set on bge-small took 1.24 and refused 2.6, which
     * puts the stop exactly at 0.70. coda's curve is flat enough that 0.68 through 0.72 are all
     * defensible on it (its own rate is 2.0 at 0.68->0.70), so it neither picks nor contradicts.
     *
     * tauAmbiguous stays 0.5 and is INERT here, on both corpora and for the same reason it is inert
     * on bge-small (#174): the lowest score any fork reached was 0.6298 on example-circle and 0.5296 on
     * coda, so every fork already clears 0.5 and earns its possible-duplicate edge. Nothing measured
     * says where a different line belongs, so nothing here invents one.
     *
     * edgeSimMin 0.60, measured with scripts/measure-fork-and-edge-bands.ts on stores whose CONCEPT
     * vectors are in this space — which is the whole trick, and a first pass got it wrong. Concept
     * vectors are rewritten by migrateEmbeddings' reembedConcept phase and NOT by the re-embed fixture
     * script, so a corpus prepared that way answers this question with its OLD concept vectors while
     * looking entirely healthy. Measured that way this space appeared compressed high (pair median
     * 0.7082, complete graph at every candidate floor) and the honest-looking conclusion was that no
     * selective floor exists here. Both were artefacts of mean-pooled concept vectors.
     *
     *   coda (271 concepts, 36,585 pairs)      example-circle (286 concepts, 40,755 pairs)
     *   pair median 0.4217                     pair median 0.5246
     *   floor  density  maxdeg  isolated       floor  density  maxdeg  isolated
     *    0.45    35.2%     217      0.0%        0.45    87.3%     282      0.0%   <- the class guess
     *    0.50    17.5%     132      0.7%        0.50    64.6%     269      0.0%
     *    0.55     8.7%      67      1.5%        0.55    34.9%     219      0.3%
     *    0.60     4.7%      45      8.1%        0.60    13.6%     134      2.4%   <- chosen
     *    0.65     2.4%      39     24.0%        0.65     4.6%      71     11.5%
     *    0.70     0.8%      29     49.8%        0.70     1.3%      32     44.4%
     *
     * bge-small's rule was "the first point where the population is a minority of pairs and degree
     * spreads", and it accepted 11% of concepts left with no edge at all. 0.60 satisfies that on BOTH
     * corpora; 0.65 would satisfy it on example-circle while isolating a quarter of coda's concepts. The
     * inherited 0.45 is what the class guess would give, and on example-circle it links 87.3% of all pairs
     * with one concept touching 282 of 285 — "most connected" would not be a fact about the corpus.
     *
     * SAME STANDING AS bge-small's, deliberately: this is a display judgement backed by a density
     * sweep, not a decision-derived band, because after gather's removal (#168) no ranking reads these
     * edges. If they regain a ranking consumer, re-derive against THAT decision — and #175 is asking
     * the prior question of whether they should be written at all.
     */
    /*
     * MARGIN GATE 0.12, derived here and nowhere else (#86). scripts/measure-gate.ts replays every
     * live monet-hq observation withheld from its own concept, and separately every SINGLETON-home
     * observation — where withholding removes the home entirely, so the store's own answer was
     * CREATE. At tauAttach 0.70 with no margin gate the second population is absorbed 87.9% of the
     * time; the first misfiles 26.1% raw, ~17% after blinded adjudication of 60 disagreements.
     *
     * Swept together, unrecoverable merges (wrong home + absorbed new topic) run 39.6% at d=0,
     * 25.7% at 0.02, 16.9% at 0.05, 11.4% at 0.08, 6.6% at 0.12. 0.12 is where the ASK path takes
     * 54.7% of stores and the silent band still files 42.3% — past it the asks dominate without
     * buying much (0.20 -> 4.2% unrecoverable but only 23.6% still filed correctly).
     *
     * WHY NOT JUST RAISE tauAttach: at MATCHED risk the margin gate keeps far more correct
     * attaches — 16.9% unrecoverable at d=0.05 leaves 62.7% filed to the right home, where
     * tauAttach 0.80 reaches 16.3% but files only 52.2%.
     *
     * UNVALIDATED FOR CJK, and this corpus cannot validate it: monet-hq holds ZERO CJK-heavy
     * observations (every durable artifact here is English by project convention). lexicalTokens'
     * TOKEN regex scores a near-identical Korean pair at overlap 0.0 where its English equivalent
     * scores 0.714, so a CJK `rank` IS its cosine while a Latin one is cosine * (1 + overlap) and
     * can run up to twice as large. Those are not the same quantity and 0.12 was measured on only
     * one of them. #38 is the prerequisite for any store that holds CJK content.
     */
    thresholds: { tauAttach: 0.70, tauAmbiguous: 0.5, tauMargin: 0.12, edgeSimMin: 0.60 },
    /*
     * CARD-EMISSION FLOOR 0.40, from scripts/measure-recall-floor.ts on the same STARTER_SUITE corpus
     * every other floor here came from — 20 probe queries, 9 junk queries, observation granularity.
     * Read as that script says: take the highest floor still keeping 100% of GOLD, then see what it
     * suppresses.
     *
     *   floor   gold kept   junk cards suppressed   junk queries fully silent
     *    0.12       100.0%                   0.0%                       0.0%   <- the fallback
     *    0.35       100.0%                  82.7%                       0.0%
     *    0.40       100.0%                  98.2%                      33.3%   <- chosen
     *    0.45        94.3%                  99.8%                      77.8%
     *    0.50        80.0%                 100.0%                     100.0%
     *
     * GOLD min is 0.4285 and is the binding constraint, leaving 0.028 of margin — wider than the
     * 0.014 bge-small's own floor was chosen with.
     *
     * THIS SPACE CAN SAY "I KNOW NOTHING ABOUT THAT", AND bge-small's COULD NOT. That is the finding,
     * not the number. On bge-small the GOLD minimum (0.3642) sits BELOW the JUNK median (0.3971), so
     * the two populations overlap and no constant separates them — its note says silence costs real
     * answers, and #170 tracks the consequence. Here GOLD min (0.4285) clears JUNK p95 (0.3847) and
     * even JUNK max is only 0.4697, so one constant keeps every real answer while silencing a third of
     * the unanswerable queries outright. #170 asked for a relative or margin-based rule because a
     * constant could not work in THAT space; in this one a constant does.
     *
     * WHAT THIS FIXTURE CANNOT SHOW, and it is the same limit its own predecessors carried:
     * STARTER_SUITE is 20 English probes. For a checkpoint whose entire reason for being here is that
     * it reads Korean, an English-only fixture cannot exhibit the behaviour that matters most, so
     * this floor is derived where it is derivable and is not evidence about cross-lingual queries.
     */
    nativeScoreFloor: 0.40,
  },
};

/**
 * Every space id this build DESCRIBES, which is not the same set as every id it can LOAD.
 *
 * The gap is the point. `OnnxEmbeddingProvider` accepts any string and falls back silently when no
 * profile matches — mean pooling, the labelled legacy thresholds, no script restriction, global
 * budget and floor — so an unregistered id still produces vectors, and nothing downstream can tell
 * a described space from a merely loadable one. That is tolerable when SERVING a pin a store
 * already carries, and not tolerable when MINTING one: `repair --target` writes a permanent pin,
 * and everything the registry carries beyond the checkpoint is unrecoverable after the rewrite.
 *
 * So this exists for the minting surface to check against (#15). It is a key list rather than a
 * predicate because the list is short by construction and a caller refusing an unknown target
 * should be able to say what the alternatives are — the operator's actual question at that moment.
 * A `readonly` array, not the map: the profiles themselves stay private, since exporting them would
 * invite a second consumer to re-derive behaviour the provider already resolves.
 */
export function knownModelProfileIds(): readonly string[] {
  return Object.keys(MODEL_PROFILES);
}

/**
 * One transformers.js `progress_callback` event. Verified against 3.8.1, not assumed
 * (`src/utils/hub.js`): `initiate` fires per file before the cache is consulted (line 417),
 * `download` after it (571), `progress` while the body is read (597/607/630), `done` at the end
 * (650). `loaded`/`total` ride only on `progress`, and `total` can be absent when the response
 * carries no length.
 */
export interface ModelLoadProgressEvent {
  status: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface ModelLoadReporterOptions {
  /** Stay silent until the load has run this long. Default 3000ms. */
  quietMs?: number;
  /** At most one line per interval once reporting has started. Default 5000ms. */
  intervalMs?: number;
  /** Deterministic test seams. */
  now?: () => number;
  write?: (line: string) => void;
}

/**
 * Report a slow first-run model download to stderr, so a normal wait stops being indistinguishable
 * from a hang.
 *
 * WHY THIS EXISTS AT ALL (#185). The download is the longest thing startup does and it emitted
 * nothing: one line before `pipeline()` and then minutes of silence. A user watching that has no
 * way to tell a working download from a wedged process, and Ctrl-C is the reasonable response —
 * which is how a partial file ends up at the cache's final path, where transformers.js's
 * existence-only `match()` treats it as a hit forever. Progress does not fix the cache (that is
 * #185's options 1 and 2); it removes the reason to interrupt.
 *
 * SILENCE IS THE HEALTHY STATE, so the reporter is gated on TIME, not on event type. The obvious
 * gate — report only on `status: "download"` — does not work: verified in 3.8.1, that event is
 * dispatched at hub.js:571, OUTSIDE the `if (response === undefined)` block that closes at 568, so
 * it fires for a cache hit exactly as it does for a real fetch. A warm load finishes well inside
 * `quietMs` and therefore prints nothing at all, which is what today's users already experience.
 *
 * NO AGGREGATE PERCENTAGE, EVER — bytes read, and nothing else (Codex review, PR #208). A percentage
 * needs a denominator, and the complete file set is not known until the load has finished: several
 * files load per pipeline (tokenizer, config, weights) and `files` holds only those that have
 * already emitted a `progress` event. A small config completing first therefore yields a confident
 * "0.5 MB / 0.5 MB (100%)" minutes before the weights are even requested — an apparent completion
 * followed by a long silence, which is precisely the hang signal this reporter exists to remove. A
 * denominator that can only be known in retrospect is not reported at all.
 *
 * "LOADING", NOT "DOWNLOADING", for the same reason one layer up (Codex review, PR #208). This gate
 * separates slow loads from fast ones; it cannot separate a network fetch from a cache read. A local
 * model path, or a warm cache on a network-mounted home, streams through this same callback, so
 * calling it a download would state as fact something the gate cannot establish.
 */
export function createModelLoadReporter(
  opts: ModelLoadReporterOptions = {},
): (event: ModelLoadProgressEvent) => void {
  const quietMs = opts.quietMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 5000;
  // MONOTONIC, not the wall clock (Codex review, PR #208). A load runs for minutes, and `Date.now()`
  // can step BACKWARDS mid-load on an NTP correction or a VM clock adjustment. Both gates below are
  // "has enough time passed", so a backward step holds them shut until wall time catches up —
  // silence for the rest of the download, which is the hang signal this reporter exists to remove.
  const now = opts.now ?? (() => performance.now());
  const write = opts.write ?? ((line: string) => console.error(line));

  const startedAt = now();
  let lastReportAt = 0;
  const bytesByFile = new Map<string, number>();

  return (event: ModelLoadProgressEvent): void => {
    if (event.status !== "progress") return;
    // Keyed per file, and kept at its HIGH-WATER MARK. `loaded` is that file's running total, so
    // summing every event would count each byte once per chunk — but a plain overwrite is wrong in
    // the other direction (Codex review, PR #208): more than one pipeline component can request the
    // same file (a tokenizer fallback and the model loader both reading `config.json`), and those
    // requests share this key. A second request restarting from a smaller `loaded` would then make
    // the reported total go DOWN, contradicting the monotonicity claimed below.
    const key = `${event.name ?? ""}/${event.file ?? ""}`;
    const loaded = Number.isFinite(event.loaded) ? (event.loaded as number) : 0;
    bytesByFile.set(key, Math.max(bytesByFile.get(key) ?? 0, loaded));

    const at = now();
    if (at - startedAt < quietMs) return; // a warm cache never gets here
    if (lastReportAt !== 0 && at - lastReportAt < intervalMs) return;
    lastReportAt = at;

    let loadedBytes = 0;
    for (const bytes of bytesByFile.values()) loadedBytes += bytes;
    // Monotonic and always true — a number that only ever climbs is the whole signal a waiting user
    // needs, and it cannot mislead the way a retrospective denominator can.
    write(`[monet-core] loading model files… ${(loadedBytes / 1_000_000).toFixed(1)} MB read`);
  };
}

/** Prefix for a download in flight; never a cache hit, because it is not under the checkpoint's own path. */
const STAGING_PREFIX = ".staging-";
/** Scratch whose newest file is older than this belonged to a process that died. */
const STALE_SCRATCH_MS = 24 * 60 * 60 * 1000;

export interface StagedLoadOptions<T> {
  /** Hub id, e.g. "Xenova/bge-m3". Also the cache-relative path transformers.js fetches into. */
  checkpoint: string;
  /** The cache root that `<checkpoint>` sits under, and that staging happens inside. */
  cacheRoot: string;
  /**
   * Performs the real load. `localOnly` is passed straight to transformers.js as
   * `local_files_only`, which makes a load PHYSICALLY unable to fetch — see the warm probe below.
   */
  run: (cacheDir: string, localOnly: boolean) => Promise<T>;
  /** Deterministic test seams. */
  now?: () => number;
  staleMs?: number;
  write?: (line: string) => void;
}

/**
 * Load a model so that dying mid-download cannot poison the cache (#185).
 *
 * THE DEFECT. transformers.js's `FileCache.put()` streams straight into the file's FINAL path, with
 * no temp file and no rename, and its `match()` accepts a file by EXISTENCE alone. So at every
 * instant of a download, a partial file sits exactly where a later start will accept it as complete.
 * `put()`'s own catch unlinks on a rejection, so a network error is fine; what is fatal is the
 * process dying — no catch runs, and the truncated file is a cache hit forever after.
 *
 * WHY THAT IS NOT A RARE ACCIDENT. `monet start` is what an MCP host spawns (monet-client's
 * config-cli.ts writes `{ command: "monet", args: ["start"] }`), and the first-run download takes
 * minutes during which the server cannot answer `initialize` — it has not reached `server.connect()`
 * yet. Whether a host kills a server that silent is host-specific and NOT in the MCP spec, so it has
 * to be assumed: a first install can brick itself with no user action at all.
 *
 * THE INVARIANT THIS ESTABLISHES, and it is per FILE rather than per directory: no file exists at
 * its final path unless it is complete. Everything below follows from that one sentence.
 *
 * THE WARM PROBE CANNOT FETCH (Codex review, PR #210). The first attempt runs with
 * `local_files_only: true`, so transformers.js throws rather than reaching the network — it cannot
 * write anything anywhere. An earlier version instead tested `existsSync(<cacheRoot>/<checkpoint>)`,
 * which is not the same question: `loadTokenizer()` caches tokenizer/config under that very
 * directory without the ONNX weights, so calling `countTokens()` first made the directory exist,
 * the next `embed()` read it as warm, and the missing weights streamed to their final path — the
 * defect, rebuilt. A probe that cannot fetch has no such gap: it either finds everything already
 * there, or it fails and the staged path runs.
 *
 * STAGING LIVES INSIDE THE CACHE ROOT deliberately, not in the OS temp dir: rename is atomic only
 * within one filesystem, and `os.tmpdir()` guarantees nothing (on Linux it is frequently tmpfs).
 * A copy fallback would be non-atomic, would double the I/O for a ~500 MB model, and a copy
 * interrupted at the destination would recreate this very bug. `mkdtemp` names it, so a restarted
 * container reusing pid 1 cannot inherit another run's scratch.
 *
 * A POISONED CACHE HEALS HERE FOR FREE. The probe fails on an unusable cached file exactly as it
 * fails on a missing one, so the staged path runs and its per-file renames replace what was there.
 */
export async function loadThroughStagingCache<T>(opts: StagedLoadOptions<T>): Promise<T> {
  const { checkpoint, cacheRoot, run } = opts;
  const now = opts.now ?? (() => Date.now());
  const staleMs = opts.staleMs ?? STALE_SCRATCH_MS;
  const write = opts.write ?? ((line: string) => console.error(line));

  sweepStaleScratch(cacheRoot, now(), staleMs);

  const modelDir = join(cacheRoot, checkpoint);
  const hadCachedFiles = existsSync(modelDir);
  let probeError: unknown;
  try {
    return await run(cacheRoot, true); // cannot reach the network, so cannot write a partial file
  } catch (error) {
    probeError = error;
    // Not diagnosed, deliberately. `match()` is existence-only, so a failure here is evidence of A
    // failure — missing files, or a truncated one — never of truncation specifically. Nothing is
    // deleted on that guess: the staged attempt below either replaces the files it fetched, or
    // fails and leaves everything exactly where it was.
    if (hadCachedFiles) write(`[monet-core] cached model at ${modelDir} is incomplete; re-fetching.`);
  }

  let stagingDir: string;
  try {
    mkdirSync(cacheRoot, { recursive: true });
  } catch {
    // The cache root itself cannot exist. The real load cannot write anything either, so it will
    // fail on its own terms — with the loader's diagnosis naming the model and the path, rather
    // than an fs error here about a directory the operator never asked for.
    return await run(cacheRoot, false);
  }
  try {
    stagingDir = mkdtempSync(join(cacheRoot, STAGING_PREFIX));
  } catch (error) {
    // THE ROOT EXISTS BUT WILL NOT TAKE A NEW CHILD — a shared cache whose root ACL forbids
    // creating entries while an existing checkpoint subtree stays writable (Codex review, PR #210).
    // Falling through to a direct load here would be the one case where the fallback actually
    // matters: transformers.js COULD still write, straight into the final paths, and a kill
    // mid-fetch would recreate exactly the state this function exists to prevent. Refuse instead,
    // and name the cause — a load that cannot be made safe is not quietly made unsafe.
    // The probe's own diagnosis rides along (Codex review, PR #210). This is a second exit that
    // discards it: a populated but read-only shared cache reaches here, and if the probe failed for
    // a runtime reason — OOM, an unsupported operator — that is the ACTIONABLE cause, while the
    // staging failure is only why we could not work around it.
    const probeNote = probeError === undefined
      ? ""
      : ` The cached model also failed to load: ` +
        `${probeError instanceof Error ? probeError.message : String(probeError)}.`;
    throw new Error(
      `Cannot stage the model download: ${cacheRoot} exists but a staging directory could not be ` +
        `created in it (${error instanceof Error ? error.message : String(error)}). Downloading ` +
        `directly would leave a partial file that every later start accepts as a complete cache ` +
        `entry (#185). Make the cache root writable, or point MONET_MODEL_CACHE somewhere that is.` +
        probeNote,
      { cause: probeError ?? error },
    );
  }

  let loaded: T;
  try {
    loaded = await run(stagingDir, false);
  } catch (error) {
    // DISCARD THE STAGING DIRECTORY, and this supersedes an earlier round of this same review.
    //
    // Round 2 asked for the completed files to be promoted here, because throwing them away is a
    // regression against the pre-staging behaviour. That was implemented and is now reverted, for a
    // reason round 3 surfaced: transformers.js fetches the checkpoint's files CONCURRENTLY —
    // `loadItems` builds an array of promises and awaits `Promise.all` (pipelines.js:3523-3572,
    // their own comment says "in parallel"). `Promise.all` rejects on the FIRST rejection while the
    // other writes are still streaming, so "everything left in staging is whole" is false at this
    // instant: a sibling fetch may be mid-file. Promoting then renames a partial file to its final
    // path, and that fetch's own cleanup afterwards unlinks the staging path it no longer occupies,
    // so the truncated file stays in the cache forever — #185, reintroduced by its own fix.
    //
    // The bandwidth this gives up is small and was measured, not assumed (#211): the shipped
    // default `Xenova/bge-m3:cls:q8` is ~587MB of which `model_quantized.onnx` is 570MB, so ~97% of
    // a retry sits in ONE file that transformers.js re-fetches from zero regardless (it issues no
    // range requests). Keeping the other ~3% is not worth a path that can poison the cache.
    removeQuietly(stagingDir);
    if (probeError !== undefined) {
      // The staged attempt does not get to erase the probe's diagnosis. A fully cached model that
      // fails to initialise for an unrelated reason — OOM, an unsupported ONNX operator — would
      // otherwise surface as a download failure, which is neither the cause nor actionable.
      try {
        if ((error as { cause?: unknown }).cause === undefined) (error as { cause?: unknown }).cause = probeError;
      } catch { /* frozen error object; the line below still carries it */ }
      write(
        `[monet-core] the cached model also failed to load: ` +
          `${probeError instanceof Error ? probeError.message : String(probeError)}`,
      );
    }
    throw error; // the real reason (offline, unknown model, …) — the store must not serve
  }
  promoteStagedFiles({ stagingDir, cacheRoot, write });
  return loaded;
}

/**
 * Move each fetched file to its final path with its own rename, then drop the staging directory.
 *
 * PER FILE, NOT PER DIRECTORY (Codex review, PR #210). One checkpoint directory holds the artifacts
 * of SEVERAL spaces — `~/.monet/models/Xenova/bge-m3/onnx/` really does hold `model.onnx`,
 * `model.onnx_data` and `model_quantized.onnx` side by side, because the bare fp32 profile and the
 * `:cls:q8` profile resolve to the same checkpoint. Replacing the directory wholesale would delete
 * the variants this load did not fetch, and a store pinned to one of them would have to re-download
 * and could not serve offline. Renaming file by file writes only what was actually fetched.
 *
 * It is also strictly safer: each rename is atomic, so the per-file invariant holds at every instant
 * and a death part-way through leaves a mix of complete files rather than a half-moved tree. There
 * is no directory to displace, so the interrupted-quarantine window a directory swap needs does not
 * exist. And on Windows it is renaming a DIRECTORY whose files are open that fails, not a file.
 *
 * NEVER FAILS THE LOAD. The model is already loaded and serving by the time this runs; promotion is
 * an optimisation for the NEXT start. Whatever could not be moved is simply re-fetched next time.
 *
 * KNOWN LIMITATION — REVISIONS CAN MIX ACROSS DTYPE VARIANTS (Codex review, PR #210). Staging starts
 * empty, so a staged fetch re-downloads the checkpoint's SHARED files (config.json, tokenizer) even
 * when a copy is already cached, and promotion overwrites them. If upstream changed those files
 * between two variants' fetches, the variant that is not being loaded keeps its old weights beside
 * the new shared files. Today that cannot happen, because `match()` is existence-only and never
 * re-fetches a file it can see — which is the same property that makes a truncated file permanent.
 *
 * It is not fixable by promoting only absent files: overwriting is precisely how a poisoned file is
 * healed, and healing is what this whole path exists for. Nor by the directory swap this replaced,
 * which "solved" it by deleting the other variant outright. A real fix needs revision awareness the
 * cache does not carry. The exposure is narrow — Monet ships one default profile, so two variants
 * coexist only when an operator has explicitly pinned another — and the failure is bounded: the
 * stale variant either still loads, or fails its probe and is re-fetched whole on next use.
 */
function promoteStagedFiles(args: { stagingDir: string; cacheRoot: string; write: (line: string) => void }): void {
  const { stagingDir, cacheRoot, write } = args;
  let moved = 0;
  let failure: unknown;
  for (const relative of listFilesRecursively(stagingDir)) {
    const destination = join(cacheRoot, relative);
    try {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(join(stagingDir, relative), destination);
      moved++;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    write(
      `[monet-core] could not move ${moved === 0 ? "the" : "every"} fetched model file into ${cacheRoot} ` +
        `(${failure instanceof Error ? failure.message : String(failure)}); serving this process and ` +
        `re-fetching on the next start.`,
    );
  }
  removeQuietly(stagingDir);
}

/** Every file under `root`, as paths relative to it. Depth-first; symlinks are not followed. */
function listFilesRecursively(root: string, prefix = ""): string[] {
  const out: string[] = [];
  // Structural rather than `Dirent[]`: node's typings make Dirent generic over the name encoding,
  // and only these three members are used here.
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursively(root, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/**
 * Delete staging directories left by processes that died. Age is the liveness test rather than the
 * pid: a pid check is not portable and pids are reused.
 *
 * AGE IS READ FROM THE NEWEST FILE INSIDE, not from the directory itself (Codex review, PR #210).
 * transformers.js writes into nested descendants, which does not touch the staging root's own
 * mtime — so a root's mtime is its creation time, and a genuinely slow or suspended download would
 * look stale and be deleted out from under a live process.
 */
function sweepStaleScratch(cacheRoot: string, nowMs: number, staleMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return; // no cache root yet, or unreadable — a sweep must never block a load
  }
  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const path = join(cacheRoot, entry);
    try {
      if (nowMs - newestMtimeMs(path) > staleMs) rmSync(path, { recursive: true, force: true });
    } catch { /* another process may have just removed it; nothing to do */ }
  }
}

/** The most recent mtime anywhere in the tree, including the root itself. */
function newestMtimeMs(root: string): number {
  let newest = statSync(root).mtimeMs;
  for (const relative of listFilesRecursively(root)) {
    try {
      newest = Math.max(newest, statSync(join(root, relative)).mtimeMs);
    } catch { /* vanished mid-scan; the remaining entries still bound it */ }
  }
  return newest;
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* scratch only — the sweep will get it */ }
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  /** From MODEL_PROFILES for a known checkpoint; the labelled legacy guess otherwise. */
  readonly recommendedThresholds: EmbeddingThresholds;
  /** Semantic space: neighbours are close and the lexical arm is what separates them (#155). */
  readonly needsLexicalArm = true;
  readonly readsOnlyLatinScript?: boolean;
  /** From MODEL_PROFILES for a known checkpoint; undefined otherwise, so the fallback applies. */
  readonly reliableSegmentTokens?: number;
  /** From MODEL_PROFILES for a known checkpoint; undefined otherwise, so the fallback applies. */
  readonly nativeScoreFloor?: number;
  /**
   * The SPACE this instance produces — the store's pin. A space id where one is needed; see
   * ModelProfile.checkpoint.
   *
   * UNDEFINED WHEN AN OVERRIDE MOVED THE SPACE OFF ITS PROFILE, which is the honest answer rather
   * than a missing feature. `pooling` and `dtype` can be passed per instance so a candidate space can
   * be measured before any profile adopts it — but such an instance produces vectors that NO id
   * names, and reporting the undecorated model id would be a lie a store could persist: a fresh store
   * would pin to it, and the next process would reconstruct that pin from the profile, load the
   * declared pooling, and write a second space into the same table with nothing able to notice
   * (Codex review, PR #178, P1). An absent modelId is already a state this codebase handles
   * deliberately — the engine calls it an anonymous embedder and refuses to persist it as a pin (see
   * backfillEmbedderPin's "EMPTY STORE + ANONYMOUS EMBEDDER"), so a measurement provider simply
   * cannot back a store. Overriding `dim` alone does NOT anonymize: it is declarative only, and
   * instantiateEmbedderForPin's measure-and-adopt path re-declares it while satisfying a real pin.
   */
  readonly modelId: string | undefined;
  private readonly model: string;
  /** What transformers.js is asked to load — and therefore what is CACHED, which recovery advice must name. */
  readonly checkpoint: string;
  /** From MODEL_PROFILES for a known checkpoint; "mean" otherwise — see Pooling for why it matters. */
  private readonly pooling: Pooling;
  /**
   * Weight precision, from MODEL_PROFILES for a known checkpoint and overridable per instance so a
   * candidate dtype can be measured before any profile adopts it. See ModelProfile.dtype for why the
   * profile — not the caller — is where a SHIPPING dtype belongs, and what that leaves unclosed.
   */
  private readonly dtype?: string;
  private extractor: Promise<FeatureExtractor> | null = null;
  private tokenizer: Promise<Tokenizer> | null = null;

  constructor(opts: { model?: string; dim?: number; pooling?: Pooling; dtype?: string } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    const profile = MODEL_PROFILES[this.model];
    this.checkpoint = profile?.checkpoint ?? this.model;
    this.dim = opts.dim ?? profile?.dim ?? 384;
    this.pooling = opts.pooling ?? profile?.pooling ?? "mean";
    this.dtype = opts.dtype ?? profile?.dtype;
    // Identity survives an override that AGREES with the profile — passing the value already in
    // force names the same space and is how a measurement script pins one arm explicitly — and is
    // surrendered by one that disagrees. See modelId's own note for why silence beats a wrong name.
    // Both comparisons run against the EFFECTIVE value, not the declared one, so naming a default
    // explicitly is never mistaken for departing from it (Codex review, PR #178 round 3). An omitted
    // profile pooling is "mean" and an omitted dtype is what transformers.js loads off the browser,
    // which is fp32 — true here because monet-core is Node-only by construction (better-sqlite3), so
    // the wasm default this would otherwise have to reason about cannot arise.
    const movedOffProfile =
      (opts.pooling !== undefined && opts.pooling !== (profile?.pooling ?? "mean"))
      || (opts.dtype !== undefined && opts.dtype !== (profile?.dtype ?? EFFECTIVE_DEFAULT_DTYPE));
    this.modelId = movedOffProfile ? undefined : this.model;
    // AND THE CALIBRATED NUMBERS GO WITH IT (Codex review, PR #178 round 2). tauAttach, edgeSimMin,
    // the segment budget and the card floor were each measured by replaying a corpus in the space
    // this instance has just been moved out of, so keeping them would drive resolution and retrieval
    // with another space's bands — and would corrupt the candidate measurement these overrides exist
    // to make in the first place. An unmeasured space gets what every unmeasured space gets: the
    // labelled legacy guess, and fallbacks for the rest. `dim` and `readsOnlyLatinScript` stay:
    // neither is a calibration, they are facts about the checkpoint's output width and its
    // vocabulary, and pooling and precision move neither.
    this.recommendedThresholds = movedOffProfile
      ? LEGACY_UNMEASURED_THRESHOLDS
      : profile?.thresholds ?? LEGACY_UNMEASURED_THRESHOLDS;
    this.readsOnlyLatinScript = profile?.readsOnlyLatinScript;
    this.reliableSegmentTokens = movedOffProfile ? undefined : profile?.reliableSegmentTokens;
    this.nativeScoreFloor = movedOffProfile ? undefined : profile?.nativeScoreFloor;
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
        // #185: the download is the longest thing startup does, and it used to emit nothing after
        // the single "first run downloads once" line — so a normal wait looked exactly like a hang,
        // and Ctrl-C is what a reasonable person does to a hang. See createModelLoadReporter
        // for why the gate is time-based and why a warm cache still prints nothing.
        const run = (cacheDir: string, localOnly: boolean): Promise<FeatureExtractor> =>
          mod.pipeline("feature-extraction", this.checkpoint, {
            cache_dir: cacheDir,
            ...(localOnly ? { local_files_only: true } : {}),
            ...(this.dtype ? { dtype: this.dtype } : {}),
            progress_callback: createModelLoadReporter(),
          }) as Promise<FeatureExtractor>;

        // A LOCAL PATH IS NOT A CACHE ENTRY, so it never goes through staging (#185). transformers.js
        // reads "./models/foo", "/opt/models/foo" or "C:\models\foo" straight off disk and caches
        // nothing under `cache_dir`, so there would be nothing staged to promote — and the model
        // directory being pointed at is the operator's own, never ours to rename.
        if (isLocalModelPath(this.checkpoint)) return await run(resolveModelCacheDir(), false);

        return await loadThroughStagingCache({
          checkpoint: this.checkpoint,
          cacheRoot: resolveModelCacheDir(),
          run,
        });
      })();
    }
    return this.extractor;
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: this.pooling, normalize: true });
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
        const run = (cacheDir: string, localOnly: boolean): Promise<Tokenizer> =>
          mod.AutoTokenizer.from_pretrained(this.checkpoint, {
            cache_dir: cacheDir,
            ...(localOnly ? { local_files_only: true } : {}),
          });
        if (isLocalModelPath(this.checkpoint)) return await run(resolveModelCacheDir(), false);
        // THE TOKENIZER STAGES TOO (Codex review, PR #210). It fetches into the SAME checkpoint
        // directory the weights live in, so leaving it on the direct path meant a `countTokens()`
        // call could populate that directory with tokenizer files alone — after which a load could
        // stream the missing weights straight to their final path. Every writer into the cache has
        // to go through here, or the invariant is only true of some of them.
        return await loadThroughStagingCache({
          checkpoint: this.checkpoint,
          cacheRoot: resolveModelCacheDir(),
          run,
        });
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
    console.error(`[monet-core] loading local embedding model (${onnx.modelId}; first run downloads once)…`);
    const warmup: unknown = await onnx.embed("warmup"); // forces model load + native init now, not on the first store
    validateEmbeddingProviderOutput(onnx, warmup);
    console.error(`[monet-core] semantic embeddings ready (${onnx.modelId}, ${onnx.dim}-dim).`);
    return { provider: onnx, selection: "onnx" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (pref === "onnx") throw new Error(`MONET_EMBEDDER=onnx but ${onnx.modelId} failed to load: ${why}`);
    console.error(`[monet-core] ${onnx.modelId} unavailable (${why}); falling back to lexical embedder.`);
    console.error("[monet-core] recall will be lexical, not semantic. Set MONET_EMBEDDER=onnx to require the semantic model.");
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
          // THE ADVICE NAMES THE CHECKPOINT, THE ERROR NAMES THE PIN, and they are not always the
          // same string (Codex review, PR #178). A space id resolves through its profile to the
          // checkpoint transformers.js actually fetches, so that is what sits on disk — advice built
          // from the pin would send an operator to delete `…/Xenova/bge-m3:cls:q8`, a directory that
          // never existed, leaving the truncated download in place and the store still unserveable.
          // The classification follows the same value for the same reason: whether anything was
          // cached at all is a fact about what was loaded, not about what the store recorded.
          (isLocalModelPath(onnx.checkpoint)
            ? `'${onnx.checkpoint}' is a local path, so nothing was cached for it — check that the path ` +
              `exists and holds a complete model.`
            : `This model is cached in ${resolveModelCacheDir()}/${onnx.checkpoint} — if its download ` +
              `was interrupted, delete that model's directory (not the cache root, which may be ` +
              `shared) to force a clean re-fetch.`),
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

import type { EmbeddingProvider, EmbeddingThresholds } from "./embedding";
import { HashingEmbeddingProvider } from "./embedding";

/**
 * Real semantic embeddings via a bundled ONNX model (transformers.js) — in-process,
 * no external service, no Ollama. The model loads lazily on first `embed()` and is
 * cached on disk after the first download.
 *
 * Default: all-MiniLM-L6-v2 (384-dim). For a smaller install, point `model` at a
 * quantized build. This is async by nature — which is exactly why the engine's write
 * path (`store`/`search`) is async.
 *
 * `@huggingface/transformers` is an OPTIONAL dependency, imported dynamically through a
 * non-literal specifier so (a) the default lexical provider never pulls it in and
 * (b) typecheck passes without it installed. Selecting this provider without the package
 * installed throws from `embed()` with an install hint.
 */
interface FeatureExtractor {
  (text: string, opts: { pooling: "mean"; normalize: boolean }): Promise<{ data: Float32Array }>;
}

interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<unknown>;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  // Calibrated on all-MiniLM-L6-v2 via `embed:check` (real cosine distribution):
  // near-dup ≈ 0.95, paraphrase ≈ 0.78, related ≈ 0.38, unrelated ≈ 0.18.
  // tauAttach sits just under paraphrase (so true restatements attach); tauAmbiguous
  // sits well above "related" (so merely-related evidence forks rather than wrongly
  // merging — the ADR's conservative-dedup rule: prefer a duplicate over a bad merge).
  readonly recommendedThresholds: EmbeddingThresholds = { tauAttach: 0.72, tauAmbiguous: 0.5 };
  private readonly model: string;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(opts: { model?: string; dim?: number } = {}) {
    this.model = opts.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dim = opts.dim ?? 384;
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
        return (await mod.pipeline("feature-extraction", this.model)) as FeatureExtractor;
      })();
    }
    return this.extractor;
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Float32Array.from(output.data);
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
export async function createLocalEmbedder(opts: { model?: string } = {}): Promise<EmbeddingProvider> {
  const pref = process.env.MONET_EMBEDDER?.toLowerCase();
  if (pref === "hashing" || pref === "lexical") {
    return new HashingEmbeddingProvider();
  }

  const onnx = new OnnxEmbeddingProvider(opts);
  try {
    console.error("[monet-core] loading local embedding model (all-MiniLM-L6-v2; first run downloads once)…");
    await onnx.embed("warmup"); // forces model load + native init now, not on the first store
    console.error("[monet-core] semantic embeddings ready (MiniLM, 384-dim).");
    return onnx;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (pref === "onnx") throw new Error(`MONET_EMBEDDER=onnx but MiniLM failed to load: ${why}`);
    console.error(`[monet-core] MiniLM unavailable (${why}); falling back to lexical embedder.`);
    console.error("[monet-core] recall will be lexical, not semantic. Set MONET_EMBEDDER=onnx to require MiniLM.");
    return new HashingEmbeddingProvider();
  }
}

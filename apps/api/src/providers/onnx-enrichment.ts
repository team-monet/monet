import type { EmbeddingEnrichmentProvider, EnrichmentConfig } from "./enrichment";
import { EMBEDDING_DIMENSIONS } from "./enrichment";

const DEFAULT_EMBEDDING_MODEL = "Snowflake/snowflake-arctic-embed-l-v2.0";
const DEFAULT_QUANTIZED = true;

type FeatureExtractionOutput = {
  data?: ArrayLike<number>;
};

type FeatureExtractionPipeline = (
  input: string,
  options?: {
    pooling?: "mean";
    normalize?: boolean;
  },
) => Promise<FeatureExtractionOutput>;

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let embeddingPipelineKey: string | null = null;
let embeddingPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

export class OnnxEnrichmentProvider implements EmbeddingEnrichmentProvider {
  private readonly embeddingModel: string;
  private readonly quantized: boolean;

  constructor(config: EnrichmentConfig = {}) {
    this.embeddingModel =
      config.onnxEmbeddingModel ?? process.env.ONNX_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.quantized = config.onnxQuantized ?? parseBoolean(process.env.ONNX_QUANTIZED, DEFAULT_QUANTIZED);
  }

  async computeEmbedding(content: string): Promise<number[]> {
    const extractor = await getEmbeddingPipeline(this.embeddingModel, this.quantized);
    const output = await extractor(content, {
      pooling: "mean",
      normalize: true,
    });
    const embedding = output.data ? Array.from(output.data) : null;

    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `ONNX embedding response was not a ${EMBEDDING_DIMENSIONS}-dimensional vector` +
          (Array.isArray(embedding) ? ` (got ${embedding.length})` : ""),
      );
    }

    return embedding;
  }
}

async function getEmbeddingPipeline(
  model: string,
  quantized: boolean,
): Promise<FeatureExtractionPipeline> {
  const key = `${model}::${quantized}`;

  if (embeddingPipeline && embeddingPipelineKey === key) {
    return embeddingPipeline;
  }

  if (embeddingPipelinePromise && embeddingPipelineKey === key) {
    return embeddingPipelinePromise;
  }

  const pipelinePromise = loadEmbeddingPipeline(model, quantized)
    .then((loadedPipeline) => {
      if (embeddingPipelinePromise === pipelinePromise) {
        embeddingPipeline = loadedPipeline;
        embeddingPipelineKey = key;
        embeddingPipelinePromise = null;
      }
      return loadedPipeline;
    })
    .catch((error: unknown) => {
      if (embeddingPipelinePromise === pipelinePromise) {
        embeddingPipeline = null;
        embeddingPipelineKey = null;
        embeddingPipelinePromise = null;
      }
      throw error;
    });

  embeddingPipeline = null;
  embeddingPipelineKey = key;
  embeddingPipelinePromise = pipelinePromise;
  return pipelinePromise;
}

async function loadEmbeddingPipeline(
  model: string,
  quantized: boolean,
): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline("feature-extraction", model, { quantized }) as Promise<FeatureExtractionPipeline>;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

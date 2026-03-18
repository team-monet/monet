import type { EnrichmentConfig, EnrichmentProvider } from "./enrichment";
import { EMBEDDING_DIMENSIONS } from "./enrichment";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_CHAT_MODEL = "llama3.1:8b";
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

export class OnnxEnrichmentProvider implements EnrichmentProvider {
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly embeddingModel: string;
  private readonly quantized: boolean;

  constructor(config: EnrichmentConfig = {}) {
    this.baseUrl = config.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
    this.chatModel = config.ollamaChatModel ?? process.env.OLLAMA_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
    this.embeddingModel =
      config.onnxEmbeddingModel ?? process.env.ONNX_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.quantized = config.onnxQuantized ?? parseBoolean(process.env.ONNX_QUANTIZED, DEFAULT_QUANTIZED);
  }

  async generateSummary(content: string): Promise<string> {
    const text = await this.generateText(
      "Summarize the memory in 200 characters or less. Return plain text only.",
      content,
    );
    return text.trim().slice(0, 200);
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

  async extractTags(content: string): Promise<string[]> {
    const text = await this.generateText(
      "Extract 3 to 8 concise keyword tags. Return a comma-separated list only.",
      content,
    );
    return normalizeTags(text.split(","));
  }

  private async generateText(system: string, content: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.chatModel,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat request failed: ${response.status}`);
    }

    const body = await response.json() as {
      message?: { content?: string };
    };
    const text = body.message?.content?.trim();

    if (!text) {
      throw new Error("Ollama chat response did not include text content");
    }

    return text;
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

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

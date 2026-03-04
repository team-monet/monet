import type { EnrichmentConfig, EnrichmentProvider } from "./enrichment.js";
import { EMBEDDING_DIMENSIONS } from "./enrichment.js";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export class AnthropicEnrichmentProvider implements EnrichmentProvider {
  private readonly anthropicApiKey: string;
  private readonly anthropicBaseUrl: string;
  private readonly anthropicModel: string;
  private readonly embeddingApiKey: string;
  private readonly embeddingBaseUrl: string;
  private readonly embeddingModel: string;

  constructor(config: EnrichmentConfig = {}) {
    this.anthropicApiKey =
      config.anthropicApiKey ?? process.env.ENRICHMENT_API_KEY ?? "";
    this.anthropicBaseUrl =
      config.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
    this.anthropicModel =
      config.anthropicModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    this.embeddingApiKey =
      config.embeddingApiKey ?? process.env.EMBEDDING_API_KEY ?? this.anthropicApiKey;
    this.embeddingBaseUrl =
      config.embeddingBaseUrl ?? process.env.EMBEDDING_BASE_URL ?? DEFAULT_EMBEDDING_BASE_URL;
    this.embeddingModel =
      config.embeddingModel ?? process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;

    if (!this.anthropicApiKey) {
      throw new Error("ENRICHMENT_API_KEY is required for anthropic enrichment");
    }
    if (!this.embeddingApiKey) {
      throw new Error("EMBEDDING_API_KEY is required for embeddings (defaults to ENRICHMENT_API_KEY)");
    }
  }

  async generateSummary(content: string): Promise<string> {
    const text = await this.createMessage(
      "Summarize the memory in 200 characters or less. Return plain text only.",
      content,
    );
    return text.trim().slice(0, 200);
  }

  async computeEmbedding(content: string): Promise<number[]> {
    const response = await fetch(`${this.embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: content,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = body.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding response was not a ${EMBEDDING_DIMENSIONS}-dimensional vector` +
          (Array.isArray(embedding) ? ` (got ${embedding.length})` : ""),
      );
    }

    return embedding;
  }

  async extractTags(content: string): Promise<string[]> {
    const text = await this.createMessage(
      "Extract 3 to 8 concise keyword tags. Return a comma-separated list only.",
      content,
    );
    return normalizeTags(text.split(","));
  }

  private async createMessage(system: string, content: string): Promise<string> {
    const response = await fetch(`${this.anthropicBaseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.anthropicModel,
        system,
        max_tokens: 256,
        messages: [{ role: "user", content }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic message request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = body.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join(" ")
      .trim();

    if (!text) {
      throw new Error("Anthropic message response did not include text content");
    }

    return text;
  }
}

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

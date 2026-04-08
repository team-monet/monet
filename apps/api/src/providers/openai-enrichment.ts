import type {
  EmbeddingMode,
  EnrichmentConfig,
  EnrichmentProvider,
} from "./enrichment";
import { EMBEDDING_DIMENSIONS } from "./enrichment";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * OpenAI-compatible enrichment provider.
 *
 * Works with any service that implements the OpenAI chat completions and
 * embeddings API: OpenAI, Ollama (/v1), Groq, Together, OpenRouter, vLLM,
 * LM Studio, etc.
 */
export class OpenAICompatibleEnrichmentProvider implements EnrichmentProvider {
  private readonly chatBaseUrl: string;
  private readonly chatApiKey: string;
  private readonly chatModel: string;
  private readonly embeddingBaseUrl: string;
  private readonly embeddingApiKey: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;

  constructor(config: EnrichmentConfig = {}) {
    const genericApiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || "";
    const baseUrl = (
      config.openaiBaseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL
    ).replace(/\/+$/, "");

    this.chatBaseUrl = (
      config.openaiChatBaseUrl || process.env.OPENAI_CHAT_BASE_URL || baseUrl
    ).replace(/\/+$/, "");
    this.chatApiKey =
      config.openaiChatApiKey ||
      process.env.OPENAI_CHAT_API_KEY ||
      process.env.ENRICHMENT_CHAT_API_KEY ||
      genericApiKey;
    this.chatModel =
      config.openaiChatModel || process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL;

    this.embeddingBaseUrl = (
      config.openaiEmbeddingBaseUrl ||
      process.env.OPENAI_EMBEDDING_BASE_URL ||
      process.env.EMBEDDING_BASE_URL ||
      baseUrl
    ).replace(/\/+$/, "");
    this.embeddingApiKey =
      config.openaiEmbeddingApiKey ||
      process.env.OPENAI_EMBEDDING_API_KEY ||
      process.env.ENRICHMENT_EMBEDDING_API_KEY ||
      process.env.EMBEDDING_API_KEY ||
      genericApiKey;
    this.embeddingModel =
      config.openaiEmbeddingModel ||
      process.env.OPENAI_EMBEDDING_MODEL ||
      process.env.EMBEDDING_MODEL ||
      DEFAULT_EMBEDDING_MODEL;
    this.embeddingDimensions = EMBEDDING_DIMENSIONS;
  }

  async generateSummary(content: string): Promise<string> {
    const text = await this.chatCompletion(
      "Summarize the memory in 200 characters or less. Return plain text only.",
      content,
    );
    return text.trim().slice(0, 200);
  }

  async computeEmbedding(
    content: string,
    _options?: { mode?: EmbeddingMode },
  ): Promise<number[]> {
    const response = await fetch(`${this.embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: this.buildHeaders(this.embeddingApiKey),
      body: JSON.stringify({
        model: this.embeddingModel,
        input: content,
        ...(this.embeddingDimensions ? { dimensions: this.embeddingDimensions } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding request failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = body.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Embedding response did not include a valid vector");
    }

    return embedding;
  }

  async extractTags(content: string): Promise<string[]> {
    const text = await this.chatCompletion(
      "Extract 3 to 8 concise keyword tags. Return a comma-separated list only.",
      content,
    );
    return normalizeTags(text.split(","));
  }

  private async chatCompletion(system: string, content: string): Promise<string> {
    const response = await fetch(`${this.chatBaseUrl}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(this.chatApiKey),
      body: JSON.stringify({
        model: this.chatModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        max_tokens: 256,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Chat completion request failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new Error("Chat completion response did not include text content");
    }

    return text;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
      h.authorization = `Bearer ${apiKey}`;
    }
    return h;
  }
}

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

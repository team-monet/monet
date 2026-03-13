import type { EnrichmentConfig, EnrichmentProvider } from "./enrichment";
import { EMBEDDING_DIMENSIONS } from "./enrichment";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_CHAT_MODEL = "llama3.1:8b";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

export class OllamaEnrichmentProvider implements EnrichmentProvider {
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly embeddingModel: string;

  constructor(config: EnrichmentConfig = {}) {
    this.baseUrl = config.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
    this.chatModel = config.ollamaChatModel ?? process.env.OLLAMA_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
    this.embeddingModel =
      config.ollamaEmbeddingModel ?? process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  async generateSummary(content: string): Promise<string> {
    const text = await this.generateText(
      "Summarize the memory in 200 characters or less. Return plain text only.",
      content,
    );
    return text.trim().slice(0, 200);
  }

  async computeEmbedding(content: string): Promise<number[]> {
    let response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: content,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    // Fallback for older Ollama versions that only expose /api/embeddings.
    if (response.status === 404) {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: content,
        }),
      });
    }

    if (!response.ok) {
      throw new Error(`Ollama embedding request failed: ${response.status}`);
    }

    const body = await response.json() as { embeddings?: number[][]; embedding?: number[] };
    const embedding = Array.isArray(body.embeddings?.[0]) ? body.embeddings[0] : body.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Ollama embedding response was not a ${EMBEDDING_DIMENSIONS}-dimensional vector` +
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

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

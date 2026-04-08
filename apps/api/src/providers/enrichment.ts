export interface ChatEnrichmentProvider {
  generateSummary(content: string): Promise<string>;
  extractTags(content: string): Promise<string[]>;
}

export type EmbeddingMode = "document" | "query";

export interface EmbeddingEnrichmentProvider {
  computeEmbedding(
    content: string,
    options?: {
      mode?: EmbeddingMode;
    },
  ): Promise<number[]>;
}

export interface EnrichmentProvider
  extends ChatEnrichmentProvider, EmbeddingEnrichmentProvider {}

export interface EnrichmentConfig {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  ollamaBaseUrl?: string;
  ollamaChatModel?: string;
  ollamaEmbeddingModel?: string;
  onnxEmbeddingModel?: string;
  onnxQuantized?: boolean;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiChatBaseUrl?: string;
  openaiChatApiKey?: string;
  openaiChatModel?: string;
  openaiEmbeddingBaseUrl?: string;
  openaiEmbeddingApiKey?: string;
  openaiEmbeddingModel?: string;
}

export const EMBEDDING_DIMENSIONS = parseInt(
  process.env.EMBEDDING_DIMENSIONS || "1024",
  10,
);

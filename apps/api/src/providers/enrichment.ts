export interface EnrichmentProvider {
  generateSummary(content: string): Promise<string>;
  computeEmbedding(content: string): Promise<number[]>;
  extractTags(content: string): Promise<string[]>;
}

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
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiChatBaseUrl?: string;
  openaiChatApiKey?: string;
  openaiChatModel?: string;
  openaiEmbeddingBaseUrl?: string;
  openaiEmbeddingApiKey?: string;
  openaiEmbeddingModel?: string;
}

export const EMBEDDING_DIMENSIONS = 1024;

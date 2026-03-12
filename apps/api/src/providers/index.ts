import { AnthropicEnrichmentProvider } from "./anthropic-enrichment.js";
import type { EnrichmentProvider } from "./enrichment.js";
import { OllamaEnrichmentProvider } from "./ollama-enrichment.js";
import { OpenAICompatibleEnrichmentProvider } from "./openai-enrichment.js";

export interface EnrichmentProviderConfigStatus {
  configured: boolean;
  provider: string | null;
  reason?: string;
}

export function createEnrichmentProvider(): EnrichmentProvider {
  const provider = process.env.ENRICHMENT_PROVIDER;

  if (provider === "anthropic") {
    return new AnthropicEnrichmentProvider();
  }

  if (provider === "ollama") {
    return new OllamaEnrichmentProvider();
  }

  if (provider === "openai") {
    return new OpenAICompatibleEnrichmentProvider();
  }

  if (!provider) {
    throw new Error("ENRICHMENT_PROVIDER is required (anthropic | ollama | openai)");
  }

  throw new Error(`Unknown ENRICHMENT_PROVIDER: ${provider}`);
}

export function getEnrichmentProviderConfigStatus(): EnrichmentProviderConfigStatus {
  const provider = process.env.ENRICHMENT_PROVIDER ?? null;
  try {
    createEnrichmentProvider();
    return {
      configured: true,
      provider,
    };
  } catch (error) {
    return {
      configured: false,
      provider,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

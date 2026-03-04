import { AnthropicEnrichmentProvider } from "./anthropic-enrichment.js";
import type { EnrichmentProvider } from "./enrichment.js";
import { OllamaEnrichmentProvider } from "./ollama-enrichment.js";

export function createEnrichmentProvider(): EnrichmentProvider {
  const provider = process.env.ENRICHMENT_PROVIDER;

  if (provider === "anthropic") {
    return new AnthropicEnrichmentProvider();
  }

  if (provider === "ollama") {
    return new OllamaEnrichmentProvider();
  }

  if (!provider) {
    throw new Error("ENRICHMENT_PROVIDER is required (anthropic | ollama)");
  }

  throw new Error(`Unknown ENRICHMENT_PROVIDER: ${provider}`);
}

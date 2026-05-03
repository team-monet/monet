import type { ChatEnrichmentProvider } from "./enrichment";

export class NoneEnrichmentProvider implements ChatEnrichmentProvider {
  async generateSummary(): Promise<string> {
    return "";
  }

  async extractTags(): Promise<string[]> {
    return [];
  }
}

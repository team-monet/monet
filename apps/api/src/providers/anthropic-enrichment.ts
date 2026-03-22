import type { ChatEnrichmentProvider, EnrichmentConfig } from "./enrichment";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";

export class AnthropicEnrichmentProvider implements ChatEnrichmentProvider {
  private readonly anthropicApiKey: string;
  private readonly anthropicBaseUrl: string;
  private readonly anthropicModel: string;

  constructor(config: EnrichmentConfig = {}) {
    this.anthropicApiKey =
      config.anthropicApiKey ??
      process.env.ENRICHMENT_CHAT_API_KEY ??
      process.env.ENRICHMENT_API_KEY ??
      "";
    this.anthropicBaseUrl =
      config.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
    this.anthropicModel =
      config.anthropicModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

    if (!this.anthropicApiKey) {
      throw new Error(
        "ENRICHMENT_CHAT_API_KEY is required for anthropic chat (or use legacy ENRICHMENT_API_KEY)",
      );
    }
  }

  async generateSummary(content: string): Promise<string> {
    const text = await this.createMessage(
      "Summarize the memory in 200 characters or less. Return plain text only.",
      content,
    );
    return text.trim().slice(0, 200);
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

import { AnthropicEnrichmentProvider } from "./anthropic-enrichment";
import type {
  ChatEnrichmentProvider,
  EmbeddingEnrichmentProvider,
  EnrichmentProvider,
} from "./enrichment";
import { OnnxEnrichmentProvider } from "./onnx-enrichment";
import { NoneEnrichmentProvider } from "./none-enrichment";
import { OllamaEnrichmentProvider } from "./ollama-enrichment";
import { OpenAICompatibleEnrichmentProvider } from "./openai-enrichment";

export const CHAT_PROVIDERS = ["anthropic", "none", "ollama", "openai"] as const;
export const EMBEDDING_PROVIDERS = ["ollama", "onnx", "openai"] as const;
export const LEGACY_ENRICHMENT_PROVIDERS = ["anthropic", "ollama", "onnx", "openai"] as const;

export type ChatProviderName = (typeof CHAT_PROVIDERS)[number];
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
export type LegacyEnrichmentProviderName = (typeof LEGACY_ENRICHMENT_PROVIDERS)[number];

export interface EnrichmentProviderConfigStatus {
  configured: boolean;
  status: "configured" | "degraded";
  chatProvider: ChatProviderName | null;
  embeddingProvider: EmbeddingProviderName | null;
  features: {
    backgroundEnrichment: boolean;
    semanticSearch: boolean;
  };
  reasons: string[];
}

export function isBackgroundEnrichmentEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBooleanEnv(env.ENRICHMENT_BACKGROUND_ENABLED, "ENRICHMENT_BACKGROUND_ENABLED", true);
}

const LEGACY_PROVIDER_MAP: Record<
  LegacyEnrichmentProviderName,
  {
    chatProvider: ChatProviderName;
    embeddingProvider: EmbeddingProviderName;
  }
> = {
  anthropic: {
    chatProvider: "anthropic",
    embeddingProvider: "openai",
  },
  ollama: {
    chatProvider: "ollama",
    embeddingProvider: "ollama",
  },
  onnx: {
    chatProvider: "ollama",
    embeddingProvider: "onnx",
  },
  openai: {
    chatProvider: "openai",
    embeddingProvider: "openai",
  },
};

export function resolveConfiguredProviders(
  env: NodeJS.ProcessEnv = process.env,
): {
  chatProvider: ChatProviderName | null;
  embeddingProvider: EmbeddingProviderName | null;
} {
  const explicitChat = env.ENRICHMENT_CHAT_PROVIDER?.trim();
  const explicitEmbedding = env.ENRICHMENT_EMBEDDING_PROVIDER?.trim();
  const legacyProvider = env.ENRICHMENT_PROVIDER?.trim();

  return {
    chatProvider: explicitChat
      ? parseChatProvider(explicitChat, "ENRICHMENT_CHAT_PROVIDER")
      : resolveLegacyChatProvider(legacyProvider),
    embeddingProvider: explicitEmbedding
      ? parseEmbeddingProvider(explicitEmbedding, "ENRICHMENT_EMBEDDING_PROVIDER")
      : resolveLegacyEmbeddingProvider(legacyProvider),
  };
}

export function createChatEnrichmentProvider(
  env: NodeJS.ProcessEnv = process.env,
): ChatEnrichmentProvider {
  const explicitChat = env.ENRICHMENT_CHAT_PROVIDER?.trim();
  const legacyProvider = env.ENRICHMENT_PROVIDER?.trim();
  const provider = explicitChat
    ? parseChatProvider(explicitChat, "ENRICHMENT_CHAT_PROVIDER")
    : resolveLegacyChatProvider(legacyProvider);

  if (!provider) {
    throw new Error(
      "No chat enrichment provider configured. Set ENRICHMENT_CHAT_PROVIDER or legacy ENRICHMENT_PROVIDER.",
    );
  }

  switch (provider) {
    case "anthropic":
      return new AnthropicEnrichmentProvider(chatConfigFromEnv(env));
    case "ollama":
      return new OllamaEnrichmentProvider(chatConfigFromEnv(env));
    case "openai":
      return new OpenAICompatibleEnrichmentProvider(openAiConfigFromEnv(env));
    case "none":
      return new NoneEnrichmentProvider();
  }
}

export function createEmbeddingEnrichmentProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingEnrichmentProvider {
  const explicitEmbedding = env.ENRICHMENT_EMBEDDING_PROVIDER?.trim();
  const legacyProvider = env.ENRICHMENT_PROVIDER?.trim();
  const provider = explicitEmbedding
    ? parseEmbeddingProvider(explicitEmbedding, "ENRICHMENT_EMBEDDING_PROVIDER")
    : resolveLegacyEmbeddingProvider(legacyProvider);

  if (!provider) {
    throw new Error(
      "No embedding provider configured. Set ENRICHMENT_EMBEDDING_PROVIDER or legacy ENRICHMENT_PROVIDER.",
    );
  }

  switch (provider) {
    case "ollama":
      return new OllamaEnrichmentProvider(embeddingConfigFromEnv(env));
    case "onnx":
      return new OnnxEnrichmentProvider(embeddingConfigFromEnv(env));
    case "openai":
      return new OpenAICompatibleEnrichmentProvider(openAiConfigFromEnv(env));
  }
}

export function createEnrichmentProvider(
  env: NodeJS.ProcessEnv = process.env,
): EnrichmentProvider {
  const chatProvider = createChatEnrichmentProvider(env);
  const embeddingProvider = createEmbeddingEnrichmentProvider(env);

  return {
    generateSummary: (content: string) => chatProvider.generateSummary(content),
    extractTags: (content: string) => chatProvider.extractTags(content),
    computeEmbedding: (content: string, options) => embeddingProvider.computeEmbedding(content, options),
  };
}

export function getEnrichmentProviderConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): EnrichmentProviderConfigStatus {
  let chatProvider: ChatProviderName | null = null;
  let embeddingProvider: EmbeddingProviderName | null = null;
  const reasons: string[] = [];
  let backgroundEnabled = true;
  let chatConfigured = false;
  let embeddingConfigured = false;

  try {
    backgroundEnabled = isBackgroundEnrichmentEnabled(env);
  } catch (error) {
    backgroundEnabled = false;
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const resolved = resolveConfiguredProviders(env);
    chatProvider = resolved.chatProvider;
    embeddingProvider = resolved.embeddingProvider;
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  if (backgroundEnabled) {
    try {
      if (chatProvider) {
        createChatEnrichmentProvider(env);
        chatConfigured = true;
      } else {
        reasons.push("Chat enrichment is not configured.");
      }
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    reasons.push("Background enrichment is disabled by ENRICHMENT_BACKGROUND_ENABLED=false.");
  }

  try {
    if (embeddingProvider) {
      createEmbeddingEnrichmentProvider(env);
      embeddingConfigured = true;
    } else if (backgroundEnabled) {
      reasons.push("Embedding provider is not configured.");
    } else {
      reasons.push("Embedding provider is not configured; semantic search will run in degraded mode.");
    }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  const backgroundEnrichment = backgroundEnabled && chatConfigured && embeddingConfigured;
  const semanticSearch = embeddingConfigured;

  return {
    configured: backgroundEnrichment,
    status: backgroundEnrichment ? "configured" : "degraded",
    chatProvider,
    embeddingProvider,
    features: {
      backgroundEnrichment,
      semanticSearch,
    },
    reasons,
  };
}

function parseBooleanEnv(
  value: string | undefined,
  envName: string,
  defaultValue: boolean,
): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(trimmed)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(trimmed)) {
    return false;
  }

  throw new Error(`${envName} must be a boolean: true or false.`);
}

function parseChatProvider(value: string, envName: string): ChatProviderName {
  if (value === "anthropic" || value === "none" || value === "ollama" || value === "openai") {
    return value;
  }

  throw new Error(`Unknown ${envName}: ${value}. Expected one of ${CHAT_PROVIDERS.join(", ")}.`);
}

function parseEmbeddingProvider(value: string, envName: string): EmbeddingProviderName {
  if (value === "ollama" || value === "onnx" || value === "openai") {
    return value;
  }

  throw new Error(`Unknown ${envName}: ${value}. Expected one of ${EMBEDDING_PROVIDERS.join(", ")}.`);
}

function resolveLegacyChatProvider(
  legacyProvider: string | undefined,
): ChatProviderName | null {
  if (!legacyProvider) {
    return null;
  }

  return LEGACY_PROVIDER_MAP[parseLegacyProvider(legacyProvider)].chatProvider;
}

function resolveLegacyEmbeddingProvider(
  legacyProvider: string | undefined,
): EmbeddingProviderName | null {
  if (!legacyProvider) {
    return null;
  }

  return LEGACY_PROVIDER_MAP[parseLegacyProvider(legacyProvider)].embeddingProvider;
}

function parseLegacyProvider(value: string): LegacyEnrichmentProviderName {
  if (value === "anthropic" || value === "ollama" || value === "onnx" || value === "openai") {
    return value;
  }

  throw new Error(
    `Unknown ENRICHMENT_PROVIDER: ${value}. Expected one of ${LEGACY_ENRICHMENT_PROVIDERS.join(", ")}.`,
  );
}

function chatConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ConstructorParameters<typeof AnthropicEnrichmentProvider>[0] {
  return {
    anthropicApiKey: env.ENRICHMENT_CHAT_API_KEY || env.ENRICHMENT_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    anthropicModel: env.ANTHROPIC_MODEL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaChatModel: env.OLLAMA_CHAT_MODEL,
  };
}

function embeddingConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ConstructorParameters<typeof OpenAICompatibleEnrichmentProvider>[0] {
  return {
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaEmbeddingModel: env.OLLAMA_EMBEDDING_MODEL,
    onnxEmbeddingModel: env.ONNX_EMBEDDING_MODEL,
    onnxQuantized: parseOptionalBoolean(env.ONNX_QUANTIZED),
    openaiEmbeddingBaseUrl: env.OPENAI_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL,
    openaiEmbeddingApiKey:
      env.OPENAI_EMBEDDING_API_KEY ||
      env.ENRICHMENT_EMBEDDING_API_KEY ||
      env.EMBEDDING_API_KEY ||
      env.OPENAI_API_KEY,
    openaiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL || env.EMBEDDING_MODEL,
    openaiBaseUrl: env.OPENAI_BASE_URL,
    openaiApiKey: env.OPENAI_API_KEY,
  };
}

function openAiConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ConstructorParameters<typeof OpenAICompatibleEnrichmentProvider>[0] {
  return {
    openaiBaseUrl: env.OPENAI_BASE_URL,
    openaiApiKey: env.OPENAI_API_KEY || env.ENRICHMENT_API_KEY,
    openaiChatBaseUrl: env.OPENAI_CHAT_BASE_URL,
    openaiChatApiKey:
      env.OPENAI_CHAT_API_KEY ||
      env.ENRICHMENT_CHAT_API_KEY ||
      env.OPENAI_API_KEY,
    openaiChatModel: env.OPENAI_CHAT_MODEL,
    openaiEmbeddingBaseUrl: env.OPENAI_EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL,
    openaiEmbeddingApiKey:
      env.OPENAI_EMBEDDING_API_KEY ||
      env.ENRICHMENT_EMBEDDING_API_KEY ||
      env.EMBEDDING_API_KEY ||
      env.OPENAI_API_KEY,
    openaiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL || env.EMBEDDING_MODEL,
  };
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
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
      return undefined;
  }
}

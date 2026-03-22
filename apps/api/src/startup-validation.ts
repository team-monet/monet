import type { SqlClient } from "@monet/db";
import {
  CHAT_PROVIDERS,
  EMBEDDING_PROVIDERS,
  LEGACY_ENRICHMENT_PROVIDERS,
  type ChatProviderName,
  type EmbeddingProviderName,
  type LegacyEnrichmentProviderName,
} from "./providers/index";
import migrationJournal from "../../../packages/db/drizzle/meta/_journal.json";

const DEFAULT_API_HOST = "0.0.0.0";
const DEFAULT_API_PORT = 3001;
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_RATE_LIMIT_MAX = 100;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_OPENAI_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_CHAT_MODEL = "llama3.1:8b";
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_ONNX_EMBEDDING_MODEL = "Snowflake/snowflake-arctic-embed-l-v2.0";
const DEFAULT_EXAMPLE_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

type MigrationJournal = {
  entries: Array<{
    tag: string;
    when: number;
  }>;
};

type StartupSummaryValue =
  | boolean
  | number
  | string
  | null
  | StartupSummaryValue[]
  | { [key: string]: StartupSummaryValue };

export interface StartupConfigSummary {
  nodeEnv: string;
  api: {
    host: string;
    port: number;
  };
  database: {
    primary: string;
    auditPurge: string;
  };
  enrichment: {
    chatProvider: ChatProviderName | null;
    embeddingProvider: EmbeddingProviderName | null;
    details: { [key: string]: StartupSummaryValue };
  };
  security: {
    encryptionKeyConfigured: boolean;
    devBypassAuth: boolean;
    dashboardLocalAuth: boolean;
  };
  logging: {
    level: "info" | "warn" | "error";
    requestLogging: boolean;
  };
  rateLimit: {
    max: number;
    windowMs: number;
  };
  auditRetentionDays: number;
  embeddingDimensions: number;
}

export interface ValidatedStartupConfig {
  nodeEnv: string;
  databaseUrl: string;
  auditPurgeDatabaseUrl: string | null;
  apiHost: string;
  apiPort: number;
  auditRetentionDays: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  embeddingDimensions: number;
  warnings: string[];
  summary: StartupConfigSummary;
}

export interface StartupDependencyStatus {
  database: "connected";
  auditPurgeDatabase: "connected" | "shared-primary";
  migrations: {
    status: "current";
    latestExpectedTag: string | null;
    latestAppliedTag: string | null;
  };
}

export const PLATFORM_MIGRATIONS = (migrationJournal as MigrationJournal).entries;
export const LATEST_PLATFORM_MIGRATION = PLATFORM_MIGRATIONS.at(-1) ?? null;

export class StartupValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(["Startup validation failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
    this.name = "StartupValidationError";
  }
}

export function validateStartupConfig(env: NodeJS.ProcessEnv): ValidatedStartupConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodeEnv = env.NODE_ENV?.trim() || "development";
  const databaseUrl = requirePostgresUrl("DATABASE_URL", env.DATABASE_URL, errors);
  const auditPurgeDatabaseUrl = optionalPostgresUrl(
    "AUDIT_PURGE_DATABASE_URL",
    env.AUDIT_PURGE_DATABASE_URL,
    errors,
  );
  const apiHost = requireNonEmptyString("API_HOST", env.API_HOST, DEFAULT_API_HOST, errors);
  const apiPort = parseIntegerEnv("API_PORT", env.API_PORT, DEFAULT_API_PORT, { min: 1, max: 65535 }, errors);
  const auditRetentionDays = parseIntegerEnv(
    "AUDIT_RETENTION_DAYS",
    env.AUDIT_RETENTION_DAYS,
    DEFAULT_AUDIT_RETENTION_DAYS,
    { min: 1 },
    errors,
  );
  const rateLimitMax = parseIntegerEnv(
    "RATE_LIMIT_MAX",
    env.RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX,
    { min: 1 },
    errors,
  );
  const rateLimitWindowMs = parseIntegerEnv(
    "RATE_LIMIT_WINDOW_MS",
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    { min: 1 },
    errors,
  );
  const embeddingDimensions = parseIntegerEnv(
    "EMBEDDING_DIMENSIONS",
    env.EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_DIMENSIONS,
    { min: 1 },
    errors,
  );

  validateEncryptionKey(env.ENCRYPTION_KEY, errors);
  validateTransportSecurityConfig(env, nodeEnv, errors, warnings);

  const devBypassAuth = parseOptionalBooleanEnv("DEV_BYPASS_AUTH", env.DEV_BYPASS_AUTH, errors) ?? false;
  const dashboardLocalAuth =
    parseOptionalBooleanEnv("DASHBOARD_LOCAL_AUTH", env.DASHBOARD_LOCAL_AUTH, errors) ?? false;
  const logLevel = parseLogLevelEnv("LOG_LEVEL", env.LOG_LEVEL, DEFAULT_LOG_LEVEL, errors);
  const requestLogging = parseOptionalBooleanEnv("LOG_REQUESTS", env.LOG_REQUESTS, errors) ?? true;
  const enrichment = validateEnrichmentConfig(env, errors, warnings);

  if (nodeEnv === "production" && devBypassAuth) {
    warnings.push("DEV_BYPASS_AUTH=true in production allows local auth bypass.");
  }

  if (nodeEnv === "production" && dashboardLocalAuth) {
    warnings.push("DASHBOARD_LOCAL_AUTH=true in production enables dashboard local auth.");
  }

  if (nodeEnv === "production" && env.ENCRYPTION_KEY === DEFAULT_EXAMPLE_ENCRYPTION_KEY) {
    warnings.push("ENCRYPTION_KEY matches the example default and should be rotated before production use.");
  }

  if (errors.length > 0) {
    throw new StartupValidationError(errors);
  }

  return {
    nodeEnv,
    databaseUrl,
    auditPurgeDatabaseUrl,
    apiHost,
    apiPort,
    auditRetentionDays,
    rateLimitMax,
    rateLimitWindowMs,
    embeddingDimensions,
    warnings,
    summary: {
      nodeEnv,
      api: {
        host: apiHost,
        port: apiPort,
      },
      database: {
        primary: redactPostgresUrl(databaseUrl),
        auditPurge: auditPurgeDatabaseUrl
          ? redactPostgresUrl(auditPurgeDatabaseUrl)
          : "shared-primary",
      },
      enrichment,
      security: {
        encryptionKeyConfigured: true,
        devBypassAuth,
        dashboardLocalAuth,
      },
      logging: {
        level: logLevel,
        requestLogging,
      },
      rateLimit: {
        max: rateLimitMax,
        windowMs: rateLimitWindowMs,
      },
      auditRetentionDays,
      embeddingDimensions,
    },
  };
}

export async function probeStartupDependencies(
  sql: SqlClient,
  options: {
    auditPurgeSql?: SqlClient | null;
  } = {},
): Promise<StartupDependencyStatus> {
  await probeDatabase("DATABASE_URL", sql);

  if (options.auditPurgeSql) {
    await probeDatabase("AUDIT_PURGE_DATABASE_URL", options.auditPurgeSql);
  }

  const migrations = await verifyPlatformMigrations(sql);

  return {
    database: "connected",
    auditPurgeDatabase: options.auditPurgeSql ? "connected" : "shared-primary",
    migrations,
  };
}

export function formatStartupSummary(
  summary: StartupConfigSummary,
  dependencies: StartupDependencyStatus,
): string {
  return JSON.stringify(
    {
      ...summary,
      dependencies,
    },
    null,
    2,
  );
}

export function formatStartupFailure(error: unknown): string {
  if (error instanceof StartupValidationError) {
    return error.message;
  }

  if (error instanceof Error) {
    return `Startup failed: ${error.message}`;
  }

  return `Startup failed: ${String(error)}`;
}

function validateEnrichmentConfig(
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): StartupConfigSummary["enrichment"] {
  const explicitChatProvider = parseChatProviderEnv(env.ENRICHMENT_CHAT_PROVIDER, errors);
  const explicitEmbeddingProvider = parseEmbeddingProviderEnv(
    env.ENRICHMENT_EMBEDDING_PROVIDER,
    errors,
  );
  const legacyProvider = parseLegacyEnrichmentProviderEnv(env.ENRICHMENT_PROVIDER, errors);
  const chatProvider = explicitChatProvider ?? resolveLegacyChatProvider(legacyProvider);
  const embeddingProvider =
    explicitEmbeddingProvider ?? resolveLegacyEmbeddingProvider(legacyProvider);

  if (legacyProvider && !explicitChatProvider && !explicitEmbeddingProvider) {
    warnings.push(
      "ENRICHMENT_PROVIDER is legacy shorthand. Prefer ENRICHMENT_CHAT_PROVIDER and ENRICHMENT_EMBEDDING_PROVIDER.",
    );
  }

  if (!chatProvider && !embeddingProvider) {
    warnings.push(
      "ENRICHMENT_CHAT_PROVIDER and ENRICHMENT_EMBEDDING_PROVIDER are not configured; memory enrichment and semantic search will run in degraded mode.",
    );
  } else {
    if (!chatProvider) {
      warnings.push(
        "ENRICHMENT_CHAT_PROVIDER is not configured; summary and tag enrichment will run in degraded mode.",
      );
    }
    if (!embeddingProvider) {
      warnings.push(
        "ENRICHMENT_EMBEDDING_PROVIDER is not configured; semantic search and related-memory enrichment will run in degraded mode.",
      );
    }
  }

  return {
    chatProvider,
    embeddingProvider,
    details: {
      configured: Boolean(chatProvider && embeddingProvider),
      backgroundEnrichment: Boolean(chatProvider && embeddingProvider),
      semanticSearch: Boolean(embeddingProvider),
      legacyProvider,
      chat: chatProvider
        ? validateChatProviderConfig(env, chatProvider, errors)
        : { configured: false },
      embedding: embeddingProvider
        ? validateEmbeddingProviderConfig(env, embeddingProvider, errors)
        : { configured: false },
    },
  };
}

function validateChatProviderConfig(
  env: NodeJS.ProcessEnv,
  provider: ChatProviderName,
  errors: string[],
): StartupSummaryValue {
  if (provider === "anthropic") {
    if (!env.ENRICHMENT_CHAT_API_KEY?.trim() && !env.ENRICHMENT_API_KEY?.trim()) {
      errors.push(
        "ENRICHMENT_CHAT_API_KEY is required when ENRICHMENT_CHAT_PROVIDER=anthropic (or use legacy ENRICHMENT_API_KEY).",
      );
    }

    validateHttpUrl("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL, errors);

    return {
      configured: true,
      provider,
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL,
      model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
      apiKeyConfigured: Boolean(
        env.ENRICHMENT_CHAT_API_KEY?.trim() || env.ENRICHMENT_API_KEY?.trim(),
      ),
    };
  }

  if (provider === "openai") {
    validateHttpUrl("OPENAI_BASE_URL", env.OPENAI_BASE_URL, errors);
    validateHttpUrl("OPENAI_CHAT_BASE_URL", env.OPENAI_CHAT_BASE_URL, errors);

    return {
      configured: true,
      provider,
      baseUrl: env.OPENAI_CHAT_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
      model: env.OPENAI_CHAT_MODEL?.trim() || DEFAULT_OPENAI_CHAT_MODEL,
      apiKeyConfigured: Boolean(
        env.OPENAI_CHAT_API_KEY?.trim() ||
          env.ENRICHMENT_CHAT_API_KEY?.trim() ||
          env.OPENAI_API_KEY?.trim(),
      ),
    };
  }

  validateHttpUrl("OLLAMA_BASE_URL", env.OLLAMA_BASE_URL, errors);

  return {
    configured: true,
    provider,
    baseUrl: env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL,
    model: env.OLLAMA_CHAT_MODEL?.trim() || DEFAULT_OLLAMA_CHAT_MODEL,
  };
}

function validateEmbeddingProviderConfig(
  env: NodeJS.ProcessEnv,
  provider: EmbeddingProviderName,
  errors: string[],
): StartupSummaryValue {
  if (provider === "openai") {
    validateHttpUrl("OPENAI_BASE_URL", env.OPENAI_BASE_URL, errors);
    validateHttpUrl("OPENAI_EMBEDDING_BASE_URL", env.OPENAI_EMBEDDING_BASE_URL, errors);
    validateHttpUrl("EMBEDDING_BASE_URL", env.EMBEDDING_BASE_URL, errors);

    return {
      configured: true,
      provider,
      baseUrl:
        env.OPENAI_EMBEDDING_BASE_URL?.trim() ||
        env.EMBEDDING_BASE_URL?.trim() ||
        env.OPENAI_BASE_URL?.trim() ||
        DEFAULT_OPENAI_BASE_URL,
      model:
        env.OPENAI_EMBEDDING_MODEL?.trim() ||
        env.EMBEDDING_MODEL?.trim() ||
        DEFAULT_OPENAI_EMBEDDING_MODEL,
      apiKeyConfigured: Boolean(
        env.OPENAI_EMBEDDING_API_KEY?.trim() ||
          env.ENRICHMENT_EMBEDDING_API_KEY?.trim() ||
          env.EMBEDDING_API_KEY?.trim() ||
          env.OPENAI_API_KEY?.trim(),
      ),
    };
  }

  if (provider === "onnx") {
    const quantized = parseOptionalBooleanEnv("ONNX_QUANTIZED", env.ONNX_QUANTIZED, errors);

    return {
      configured: true,
      provider,
      model: env.ONNX_EMBEDDING_MODEL?.trim() || DEFAULT_ONNX_EMBEDDING_MODEL,
      quantized: quantized ?? true,
    };
  }

  validateHttpUrl("OLLAMA_BASE_URL", env.OLLAMA_BASE_URL, errors);

  return {
    configured: true,
    provider,
    baseUrl: env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL,
    model: env.OLLAMA_EMBEDDING_MODEL?.trim() || DEFAULT_OLLAMA_EMBEDDING_MODEL,
  };
}

function parseChatProviderEnv(
  value: string | undefined,
  errors: string[],
): ChatProviderName | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if ((CHAT_PROVIDERS as readonly string[]).includes(trimmed)) {
    return trimmed as ChatProviderName;
  }

  errors.push(
    `Unknown ENRICHMENT_CHAT_PROVIDER: ${trimmed}. Expected one of ${CHAT_PROVIDERS.join(", ")}.`,
  );
  return null;
}

function parseEmbeddingProviderEnv(
  value: string | undefined,
  errors: string[],
): EmbeddingProviderName | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if ((EMBEDDING_PROVIDERS as readonly string[]).includes(trimmed)) {
    return trimmed as EmbeddingProviderName;
  }

  errors.push(
    `Unknown ENRICHMENT_EMBEDDING_PROVIDER: ${trimmed}. Expected one of ${EMBEDDING_PROVIDERS.join(", ")}.`,
  );
  return null;
}

function parseLegacyEnrichmentProviderEnv(
  value: string | undefined,
  errors: string[],
): LegacyEnrichmentProviderName | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if ((LEGACY_ENRICHMENT_PROVIDERS as readonly string[]).includes(trimmed)) {
    return trimmed as LegacyEnrichmentProviderName;
  }

  errors.push(
    `Unknown ENRICHMENT_PROVIDER: ${trimmed}. Expected one of ${LEGACY_ENRICHMENT_PROVIDERS.join(", ")}.`,
  );
  return null;
}

function resolveLegacyChatProvider(
  provider: LegacyEnrichmentProviderName | null,
): ChatProviderName | null {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "onnx":
    case "ollama":
      return "ollama";
    case "openai":
      return "openai";
    default:
      return null;
  }
}

function resolveLegacyEmbeddingProvider(
  provider: LegacyEnrichmentProviderName | null,
): EmbeddingProviderName | null {
  switch (provider) {
    case "anthropic":
    case "openai":
      return "openai";
    case "onnx":
      return "onnx";
    case "ollama":
      return "ollama";
    default:
      return null;
  }
}

async function probeDatabase(label: string, sql: SqlClient) {
  try {
    await sql`SELECT 1`;
  } catch (error) {
    throw new StartupValidationError([
      `${label} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

export async function verifyPlatformMigrations(
  sql: SqlClient,
): Promise<StartupDependencyStatus["migrations"]> {
  const latestExpected = LATEST_PLATFORM_MIGRATION;

  if (!latestExpected) {
    return {
      status: "current",
      latestExpectedTag: null,
      latestAppliedTag: null,
    };
  }

  let rows: Array<{ created_at: number | string | null }> = [];
  try {
    rows = await sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1
    `;
  } catch (error) {
    throw new StartupValidationError([
      "Could not verify platform migration state via drizzle.__drizzle_migrations. Run `pnpm db:migrate` and ensure the database user can read the drizzle schema.",
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const latestApplied = rows[0]?.created_at;
  if (latestApplied === null || latestApplied === undefined) {
    throw new StartupValidationError([
      `No platform migrations have been applied. Expected latest migration ${latestExpected.tag}. Run \`pnpm db:migrate\`.`,
    ]);
  }

  const latestAppliedMillis = Number(latestApplied);
  if (!Number.isFinite(latestAppliedMillis)) {
    throw new StartupValidationError([
      `Platform migration state is unreadable because created_at=${String(latestApplied)} is not numeric.`,
    ]);
  }

  if (latestAppliedMillis < latestExpected.when) {
    throw new StartupValidationError([
      `Pending platform migrations detected. Latest expected migration is ${latestExpected.tag}. Run \`pnpm db:migrate\` before starting the API.`,
    ]);
  }

  return {
    status: "current",
    latestExpectedTag: latestExpected.tag,
    latestAppliedTag: findMigrationTagByTimestamp(latestAppliedMillis),
  };
}

function findMigrationTagByTimestamp(createdAt: number): string {
  for (let index = PLATFORM_MIGRATIONS.length - 1; index >= 0; index -= 1) {
    const entry = PLATFORM_MIGRATIONS[index];
    if (entry.when === createdAt) {
      return entry.tag;
    }
  }

  return `created_at=${createdAt}`;
}

function requirePostgresUrl(name: string, value: string | undefined, errors: string[]): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    errors.push(`${name} is required.`);
    return "";
  }

  return validatePostgresUrl(name, trimmed, errors);
}

function optionalPostgresUrl(name: string, value: string | undefined, errors: string[]): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return validatePostgresUrl(name, trimmed, errors);
}

function validatePostgresUrl(name: string, value: string, errors: string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      errors.push(`${name} must use a postgres:// or postgresql:// URL.`);
    }
  } catch {
    errors.push(`${name} must be a valid URL.`);
  }

  return value;
}

function validateHttpUrl(name: string, value: string | undefined, errors: string[]) {
  parseOptionalHttpUrl(name, value, errors);
}

function parseOptionalHttpUrl(name: string, value: string | undefined, errors: string[]): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${name} must use an http:// or https:// URL.`);
      return null;
    }
    return url;
  } catch {
    errors.push(`${name} must be a valid URL.`);
    return null;
  }
}

function validateTransportSecurityConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  errors: string[],
  warnings: string[],
) {
  const nextauthUrl = parseOptionalHttpUrl("NEXTAUTH_URL", env.NEXTAUTH_URL, errors);
  const publicApiUrl = parseOptionalHttpUrl("PUBLIC_API_URL", env.PUBLIC_API_URL, errors);
  const mcpPublicUrl = parseOptionalHttpUrl("MCP_PUBLIC_URL", env.MCP_PUBLIC_URL, errors);
  const publicOidcBaseUrl = parseOptionalHttpUrl(
    "PUBLIC_OIDC_BASE_URL",
    env.PUBLIC_OIDC_BASE_URL,
    errors,
  );

  if (nodeEnv !== "production") {
    return;
  }

  requireHttpsUrl("NEXTAUTH_URL", nextauthUrl, errors);
  requireHttpsUrl("PUBLIC_API_URL", publicApiUrl, errors);
  requireHttpsUrl("MCP_PUBLIC_URL", mcpPublicUrl, errors);
  requireHttpsUrl("PUBLIC_OIDC_BASE_URL", publicOidcBaseUrl, errors);

  if (!nextauthUrl) {
    warnings.push(
      "NEXTAUTH_URL is not configured; production TLS verification cannot confirm the dashboard public origin.",
    );
  }

  if (!publicApiUrl) {
    warnings.push(
      "PUBLIC_API_URL is not configured; production TLS verification cannot confirm the API public origin.",
    );
  }

  if (!mcpPublicUrl) {
    warnings.push(
      "MCP_PUBLIC_URL is not configured; ensure the public MCP endpoint is published over https:// and ends with /mcp.",
    );
  } else if (mcpPublicUrl.pathname !== "/mcp") {
    warnings.push("MCP_PUBLIC_URL should usually end with /mcp in production deployments.");
  }

  if (!publicOidcBaseUrl) {
    warnings.push(
      "PUBLIC_OIDC_BASE_URL is not configured; production TLS verification cannot confirm the public OIDC issuer origin.",
    );
  }
}

function requireHttpsUrl(name: string, url: URL | null, errors: string[]) {
  if (!url) {
    return;
  }

  if (url.protocol !== "https:" && !isLoopbackTlsException(url)) {
    errors.push(`${name} must use https:// in production.`);
  }
}

function isLoopbackTlsException(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function requireNonEmptyString(
  name: string,
  value: string | undefined,
  defaultValue: string,
  errors: string[],
): string {
  if (value === undefined) {
    return defaultValue;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    errors.push(`${name} cannot be empty.`);
    return defaultValue;
  }

  return trimmed;
}

function parseIntegerEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
  options: { min?: number; max?: number },
  errors: string[],
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    errors.push(`${name} cannot be empty.`);
    return defaultValue;
  }

  if (!/^-?\d+$/.test(trimmed)) {
    errors.push(`${name} must be an integer.`);
    return defaultValue;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (options.min !== undefined && parsed < options.min) {
    errors.push(`${name} must be >= ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    errors.push(`${name} must be <= ${options.max}.`);
  }

  return parsed;
}

function parseOptionalBooleanEnv(
  name: string,
  value: string | undefined,
  errors: string[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
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
      errors.push(`${name} must be a boolean-like value (true/false, 1/0, yes/no, on/off).`);
      return undefined;
  }
}

function parseLogLevelEnv(
  name: string,
  value: string | undefined,
  fallback: "info" | "warn" | "error",
  errors: string[],
): "info" | "warn" | "error" {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  switch (value.trim().toLowerCase()) {
    case "info":
    case "warn":
    case "error":
      return value.trim().toLowerCase() as "info" | "warn" | "error";
    default:
      errors.push(`${name} must be one of: info, warn, error.`);
      return fallback;
  }
}

function validateEncryptionKey(value: string | undefined, errors: string[]) {
  const trimmed = value?.trim();
  if (!trimmed) {
    errors.push("ENCRYPTION_KEY is required.");
    return;
  }

  try {
    const buffer = Buffer.from(trimmed, "base64");
    if (buffer.length !== 32) {
      errors.push("ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }
  } catch {
    errors.push("ENCRYPTION_KEY must be valid base64.");
  }
}

function redactPostgresUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid-postgres-url]";
  }
}

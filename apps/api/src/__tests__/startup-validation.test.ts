import { describe, expect, it, vi } from "vitest";
import {
  LATEST_PLATFORM_MIGRATION,
  StartupValidationError,
  formatStartupSummary,
  probeStartupDependencies,
  validateStartupConfig,
} from "../startup-validation";

const VALID_ENCRYPTION_KEY = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";

function createBaseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/monet",
    ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    ENRICHMENT_CHAT_PROVIDER: "ollama",
    ENRICHMENT_EMBEDDING_PROVIDER: "ollama",
  };
}

function createSqlMock(options: {
  migrateCreatedAt?: number | string | null;
  connectivityError?: string;
  migrationError?: string;
}) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("").replace(/\s+/g, " ").trim().toLowerCase();

    if (query.includes("select 1")) {
      if (options.connectivityError) {
        throw new Error(options.connectivityError);
      }
      return [{ "?column?": 1 }];
    }

    if (query.includes("from drizzle.__drizzle_migrations")) {
      if (options.migrationError) {
        throw new Error(options.migrationError);
      }

      if (options.migrateCreatedAt === null) {
        return [];
      }

      return [{ created_at: options.migrateCreatedAt ?? LATEST_PLATFORM_MIGRATION?.when ?? null }];
    }

    throw new Error(`Unexpected query in test double: ${query}`);
  }) as never;
}

describe("validateStartupConfig", () => {
  it("accepts a valid minimal startup configuration", () => {
    const result = validateStartupConfig(createBaseEnv());

    expect(result.apiPort).toBe(3001);
    expect(result.summary.database.primary).toBe("postgresql://db.internal:5432/monet");
    expect(result.summary.enrichment.chatProvider).toBe("ollama");
    expect(result.summary.enrichment.embeddingProvider).toBe("ollama");
    expect(result.summary.logging).toEqual({
      level: "info",
      requestLogging: true,
    });
    expect(result.warnings).toEqual([]);
  });

  it("allows startup without enrichment providers and records degraded mode", () => {
    const env = createBaseEnv();
    delete env.ENRICHMENT_CHAT_PROVIDER;
    delete env.ENRICHMENT_EMBEDDING_PROVIDER;

    const result = validateStartupConfig(env);

    expect(result.summary.enrichment.chatProvider).toBeNull();
    expect(result.summary.enrichment.embeddingProvider).toBeNull();
    expect(result.summary.enrichment.details).toEqual({
      configured: false,
      backgroundEnrichment: false,
      semanticSearch: false,
      legacyProvider: null,
      chat: {
        configured: false,
      },
      embedding: {
        configured: false,
      },
    });
    expect(result.warnings).toContain(
      "ENRICHMENT_CHAT_PROVIDER and ENRICHMENT_EMBEDDING_PROVIDER are not configured; memory enrichment and semantic search will run in degraded mode.",
    );
  });

  it("fails when required config is missing or malformed", () => {
    try {
      validateStartupConfig({
        ENRICHMENT_CHAT_PROVIDER: "anthropic",
        API_PORT: "abc",
        RATE_LIMIT_MAX: "0",
        LOG_LEVEL: "debug",
        ENCRYPTION_KEY: "too-short",
      });
      throw new Error("Expected validateStartupConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupValidationError);
      expect((error as StartupValidationError).errors).toContain(
        "LOG_LEVEL must be one of: info, warn, error.",
      );
    }
  });

  it("adds production warnings for insecure shared auth defaults", () => {
    const result = validateStartupConfig({
      ...createBaseEnv(),
      NODE_ENV: "production",
      DEV_BYPASS_AUTH: "true",
      DASHBOARD_LOCAL_AUTH: "true",
    });

    expect(result.warnings).toEqual([
      "DEV_BYPASS_AUTH=true in production allows local auth bypass.",
      "DASHBOARD_LOCAL_AUTH=true in production enables dashboard local auth.",
    ]);
  });

  it("requires anthropic credentials when anthropic enrichment is enabled", () => {
    expect(() =>
      validateStartupConfig({
        ...createBaseEnv(),
        ENRICHMENT_CHAT_PROVIDER: "anthropic",
        ENRICHMENT_API_KEY: "",
      }),
    ).toThrow(
      "ENRICHMENT_CHAT_API_KEY is required when ENRICHMENT_CHAT_PROVIDER=anthropic",
    );
  });

  it("accepts canonical chat api key for anthropic chat", () => {
    const result = validateStartupConfig({
      ...createBaseEnv(),
      ENRICHMENT_CHAT_PROVIDER: "anthropic",
      ENRICHMENT_EMBEDDING_PROVIDER: "onnx",
      ENRICHMENT_CHAT_API_KEY: "anthropic-key",
      ENRICHMENT_API_KEY: "",
    });

    expect(result.summary.enrichment.chatProvider).toBe("anthropic");
    expect(result.summary.enrichment.embeddingProvider).toBe("onnx");
  });

  it("maps legacy onnx shorthand to ollama chat plus onnx embeddings", () => {
    const env = createBaseEnv();
    delete env.ENRICHMENT_CHAT_PROVIDER;
    delete env.ENRICHMENT_EMBEDDING_PROVIDER;
    env.ENRICHMENT_PROVIDER = "onnx";

    const result = validateStartupConfig(env);

    expect(result.summary.enrichment.chatProvider).toBe("ollama");
    expect(result.summary.enrichment.embeddingProvider).toBe("onnx");
    expect(result.warnings).toContain(
      "ENRICHMENT_PROVIDER is legacy shorthand. Prefer ENRICHMENT_CHAT_PROVIDER and ENRICHMENT_EMBEDDING_PROVIDER.",
    );
  });

  it("does not treat legacy anthropic chat key as an embedding credential", () => {
    const env = createBaseEnv();
    delete env.ENRICHMENT_CHAT_PROVIDER;
    delete env.ENRICHMENT_EMBEDDING_PROVIDER;
    env.ENRICHMENT_PROVIDER = "anthropic";
    env.ENRICHMENT_API_KEY = "anthropic-key";
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_EMBEDDING_API_KEY;
    delete env.ENRICHMENT_EMBEDDING_API_KEY;
    delete env.EMBEDDING_API_KEY;

    const result = validateStartupConfig(env);

    expect(result.summary.enrichment.details).toMatchObject({
      embedding: {
        provider: "openai",
        apiKeyConfigured: false,
      },
    });
  });

  it("records LOG_REQUESTS=false in the startup summary", () => {
    const result = validateStartupConfig({
      ...createBaseEnv(),
      LOG_REQUESTS: "false",
    });

    expect(result.summary.logging).toEqual({
      level: "info",
      requestLogging: false,
    });
  });

  it("fails when LOG_REQUESTS is not a boolean", () => {
    try {
      validateStartupConfig({
        ...createBaseEnv(),
        LOG_REQUESTS: "maybe",
      });
      throw new Error("Expected validateStartupConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupValidationError);
      expect((error as StartupValidationError).errors).toContain(
        "LOG_REQUESTS must be a boolean-like value (true/false, 1/0, yes/no, on/off).",
      );
    }
  });
});

describe("probeStartupDependencies", () => {
  it("passes when the database is reachable and migrations are current", async () => {
    const result = await probeStartupDependencies(
      createSqlMock({ migrateCreatedAt: LATEST_PLATFORM_MIGRATION?.when ?? null }),
    );

    expect(result).toEqual({
      database: "connected",
      auditPurgeDatabase: "shared-primary",
      migrations: {
        status: "current",
        latestExpectedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
        latestAppliedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
      },
    });
  });

  it("fails fast when the primary database is unreachable", async () => {
    await expect(
      probeStartupDependencies(createSqlMock({ connectivityError: "connection refused" })),
    ).rejects.toThrow("DATABASE_URL is not reachable");
  });

  it("fails when platform migrations are pending", async () => {
    await expect(
      probeStartupDependencies(
        createSqlMock({
          migrateCreatedAt: (LATEST_PLATFORM_MIGRATION?.when ?? 1) - 1,
        }),
      ),
    ).rejects.toThrow("Pending platform migrations detected");
  });

  it("fails when the migration table is unreadable", async () => {
    await expect(
      probeStartupDependencies(
        createSqlMock({
          migrationError: 'relation "drizzle.__drizzle_migrations" does not exist',
        }),
      ),
    ).rejects.toThrow("Could not verify platform migration state");
  });
});

describe("formatStartupSummary", () => {
  it("emits a redacted JSON summary", () => {
    const config = validateStartupConfig(createBaseEnv());
    const rendered = formatStartupSummary(config.summary, {
      database: "connected",
      auditPurgeDatabase: "shared-primary",
      migrations: {
        status: "current",
        latestExpectedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
        latestAppliedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
      },
    });

    expect(rendered).toContain('"primary": "postgresql://db.internal:5432/monet"');
    expect(rendered).not.toContain("secret@");
    expect(rendered).toContain('"latestExpectedTag"');
  });
});

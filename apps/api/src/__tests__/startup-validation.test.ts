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
    ENRICHMENT_PROVIDER: "ollama",
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
    expect(result.summary.enrichment.provider).toBe("ollama");
    expect(result.warnings).toEqual([]);
  });

  it("fails when required config is missing or malformed", () => {
    expect(() =>
      validateStartupConfig({
        ENRICHMENT_PROVIDER: "anthropic",
        API_PORT: "abc",
        RATE_LIMIT_MAX: "0",
        ENCRYPTION_KEY: "too-short",
      }),
    ).toThrowError(StartupValidationError);
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
        ENRICHMENT_PROVIDER: "anthropic",
        ENRICHMENT_API_KEY: "",
      }),
    ).toThrow("ENRICHMENT_API_KEY is required when ENRICHMENT_PROVIDER=anthropic.");
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { LATEST_PLATFORM_MIGRATION } from "../startup-validation";

function createSqlMock(options?: {
  dbError?: string;
  migrationError?: string;
  latestAppliedMigrationWhen?: number | null;
}) {
  const latestAppliedMigrationWhen =
    options?.latestAppliedMigrationWhen ?? LATEST_PLATFORM_MIGRATION?.when ?? Date.now();

  return vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();

    if (query.includes("select 1")) {
      if (options?.dbError) {
        throw new Error(options.dbError);
      }
      return [{ "?column?": 1 }];
    }

    if (query.includes("from drizzle.__drizzle_migrations")) {
      if (options?.migrationError) {
        throw new Error(options.migrationError);
      }

      if (latestAppliedMigrationWhen === null) {
        return [];
      }

      return [{ created_at: latestAppliedMigrationWhen }];
    }

    throw new Error(`Unexpected query: ${query}`);
  });
}

describe("health endpoints", () => {
  const originalChatProvider = process.env.ENRICHMENT_CHAT_PROVIDER;
  const originalEmbeddingProvider = process.env.ENRICHMENT_EMBEDDING_PROVIDER;
  const originalLegacyProvider = process.env.ENRICHMENT_PROVIDER;
  const originalBackgroundEnabled = process.env.ENRICHMENT_BACKGROUND_ENABLED;
  const sessionStore = {
    count: vi.fn(() => 0),
  };

  beforeEach(() => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "ollama";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "ollama";
    delete process.env.ENRICHMENT_PROVIDER;
    delete process.env.ENRICHMENT_BACKGROUND_ENABLED;
    sessionStore.count.mockClear();
  });

  afterEach(() => {
    if (originalChatProvider === undefined) {
      delete process.env.ENRICHMENT_CHAT_PROVIDER;
    } else {
      process.env.ENRICHMENT_CHAT_PROVIDER = originalChatProvider;
    }

    if (originalEmbeddingProvider === undefined) {
      delete process.env.ENRICHMENT_EMBEDDING_PROVIDER;
    } else {
      process.env.ENRICHMENT_EMBEDDING_PROVIDER = originalEmbeddingProvider;
    }

    if (originalLegacyProvider === undefined) {
      delete process.env.ENRICHMENT_PROVIDER;
    } else {
      process.env.ENRICHMENT_PROVIDER = originalLegacyProvider;
    }

    if (originalBackgroundEnabled === undefined) {
      delete process.env.ENRICHMENT_BACKGROUND_ENABLED;
    } else {
      process.env.ENRICHMENT_BACKGROUND_ENABLED = originalBackgroundEnabled;
    }
  });

  it("GET /health returns status ok", async () => {
    const app = createApp(null, null);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("version");
  });

  it("GET /health/live returns status ok", async () => {
    const app = createApp(null, null);
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /healthz returns status ok", async () => {
    const app = createApp(null, null);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns status ok when database is reachable", async () => {
    const sql = createSqlMock();
    const app = createApp(null, sql as never, sessionStore as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
      components: {
        database: {
          status: "connected",
        },
        migrations: {
          status: "current",
          latestExpectedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
          latestAppliedTag: LATEST_PLATFORM_MIGRATION?.tag ?? null,
        },
        mcp: {
          status: "ready",
          activeSessions: 0,
        },
        enrichment: {
          status: "configured",
          configured: true,
          chatProvider: "ollama",
          embeddingProvider: "ollama",
          features: {
            backgroundEnrichment: true,
            semanticSearch: true,
          },
          reasons: [],
        },
        audit: {
          status: "healthy",
          consecutiveFailures: 0,
          totalFailures: 0,
        },
      },
    });
  });

  it("GET /health/ready returns 503 when database is unreachable", async () => {
    const sql = createSqlMock({ dbError: "db down" });
    const app = createApp(null, sql as never, sessionStore as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      components: {
        database: {
          status: "disconnected",
          reason: "db down",
        },
        migrations: {
          status: "unknown",
          reason: "Database is not connected.",
        },
        mcp: {
          status: "ready",
        },
      },
    });
  });

  it("GET /health/ready stays ready when only the embedding provider is configured", async () => {
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";
    const sql = createSqlMock();
    const app = createApp(null, sql as never, sessionStore as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      components: {
        enrichment: {
          status: "degraded",
          configured: false,
          chatProvider: null,
          embeddingProvider: "onnx",
          features: {
            backgroundEnrichment: false,
            semanticSearch: true,
          },
        },
      },
    });
  });

  it("GET /health/ready reports disabled background enrichment", async () => {
    process.env.ENRICHMENT_BACKGROUND_ENABLED = "false";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";
    const sql = createSqlMock();
    const app = createApp(null, sql as never, sessionStore as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      components: {
        enrichment: {
          status: "degraded",
          configured: false,
          embeddingProvider: "onnx",
          features: {
            backgroundEnrichment: false,
            semanticSearch: true,
          },
        },
      },
    });
  });

  it("GET /health/ready returns 503 when MCP is unavailable", async () => {
    const sql = createSqlMock();
    const app = createApp(null, sql as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      components: {
        mcp: {
          status: "not_ready",
          reason: "Session store unavailable.",
        },
      },
    });
  });

  it("GET /health/ready returns 503 when platform migrations are pending", async () => {
    const sql = createSqlMock({
      latestAppliedMigrationWhen: (LATEST_PLATFORM_MIGRATION?.when ?? Date.now()) - 1,
    });
    const app = createApp(null, sql as never, sessionStore as never);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      components: {
        migrations: {
          status: "not_current",
        },
      },
    });
  });
});

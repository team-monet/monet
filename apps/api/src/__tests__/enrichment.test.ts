import type { SqlClient } from "@monet/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatEnrichmentProvider,
  createEmbeddingEnrichmentProvider,
  createEnrichmentProvider,
  getEnrichmentProviderConfigStatus,
  resolveConfiguredProviders,
} from "../providers/index";

const { drizzleMock, withTenantDrizzleScopeMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
  withTenantDrizzleScopeMock: vi.fn(),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual<typeof import("@monet/db")>("@monet/db");
  return {
    ...actual,
    withTenantDrizzleScope: (...args: unknown[]) =>
      withTenantDrizzleScopeMock(...args),
  };
});

import {
  computeQueryEmbedding,
  enqueueEnrichment,
  getActiveEnrichmentCount,
  getQueuedEnrichmentCount,
  markShuttingDown,
  recoverPendingEnrichments,
  resetEnrichmentStateForTests,
  resolveMaxConcurrentEnrichments,
  setEnrichmentProviderForTests,
  waitForEnrichmentDrain,
} from "../services/enrichment.service";

describe("createEnrichmentProvider", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_PROVIDER;
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
    delete process.env.ENRICHMENT_EMBEDDING_PROVIDER;
    delete process.env.ENRICHMENT_API_KEY;
    resetEnrichmentStateForTests();
  });

  it("creates split providers from explicit env", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "openai";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    const provider = createEnrichmentProvider();

    expect(provider).toBeDefined();
    expect(resolveConfiguredProviders()).toEqual({
      chatProvider: "openai",
      embeddingProvider: "onnx",
    });
  });

  it("maps legacy onnx config to ollama chat plus onnx embeddings", () => {
    process.env.ENRICHMENT_PROVIDER = "onnx";

    const chatProvider = createChatEnrichmentProvider();
    const embeddingProvider = createEmbeddingEnrichmentProvider();

    expect(chatProvider).toBeDefined();
    expect(embeddingProvider).toBeDefined();
    expect(resolveConfiguredProviders()).toEqual({
      chatProvider: "ollama",
      embeddingProvider: "onnx",
    });
  });

  it("creates anthropic chat from canonical split api key", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "anthropic";
    process.env.ENRICHMENT_CHAT_API_KEY = "anthropic-key";

    const chatProvider = createChatEnrichmentProvider();

    expect(chatProvider).toBeDefined();
  });

  it("honors an explicit env object instead of relying on process.env", () => {
    const chatProvider = createChatEnrichmentProvider({
      ENRICHMENT_CHAT_PROVIDER: "anthropic",
      ENRICHMENT_CHAT_API_KEY: "anthropic-key",
    });

    expect(chatProvider).toBeDefined();
  });

  it("allows embedding-only configuration for semantic search", () => {
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    const embeddingProvider = createEmbeddingEnrichmentProvider();

    expect(embeddingProvider).toBeDefined();
    expect(resolveConfiguredProviders()).toEqual({
      chatProvider: null,
      embeddingProvider: "onnx",
    });
  });

  it("supports ENRICHMENT_CHAT_PROVIDER=none while keeping embedding provider", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    const chatProvider = createChatEnrichmentProvider();
    const embeddingProvider = createEmbeddingEnrichmentProvider();

    expect(chatProvider).toBeDefined();
    expect(embeddingProvider).toBeDefined();
    expect(resolveConfiguredProviders()).toEqual({
      chatProvider: "none",
      embeddingProvider: "onnx",
    });
  });

  it("throws for an unknown explicit provider", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "unknown";
    expect(() => createChatEnrichmentProvider()).toThrow("Unknown ENRICHMENT_CHAT_PROVIDER");
  });

  it("reports invalid explicit config as degraded instead of throwing", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "unknown";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    expect(getEnrichmentProviderConfigStatus()).toMatchObject({
      status: "degraded",
      chatProvider: null,
      reasons: expect.arrayContaining([
        expect.stringContaining("Unknown ENRICHMENT_CHAT_PROVIDER"),
      ]),
    });
  });
});

describe("computeQueryEmbedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetEnrichmentStateForTests();
  });

  it("returns the provider embedding when available", async () => {
    setEnrichmentProviderForTests({
      generateSummary: async () => "summary",
      computeEmbedding: async () => [1, 2, 3],
      extractTags: async () => ["a"],
    });

    await expect(computeQueryEmbedding("test")).resolves.toEqual([1, 2, 3]);
  });

  it("falls back to null when provider embedding fails", async () => {
    setEnrichmentProviderForTests({
      generateSummary: async () => "summary",
      computeEmbedding: async () => {
        throw new Error("boom");
      },
      extractTags: async () => ["a"],
    });

    await expect(computeQueryEmbedding("test")).resolves.toBeNull();
  });
});

describe("resolveMaxConcurrentEnrichments", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
    delete process.env.ENRICHMENT_EMBEDDING_PROVIDER;
    delete process.env.ENRICHMENT_MAX_CONCURRENT_JOBS;
  });

  it("uses a safer single-job limit when Ollama is configured", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "ollama";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    expect(resolveMaxConcurrentEnrichments()).toBe(1);
  });

  it("keeps the general default for non-Ollama providers", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "openai";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";

    expect(resolveMaxConcurrentEnrichments()).toBe(5);
  });

  it("honors an explicit concurrency override", () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "ollama";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "ollama";
    process.env.ENRICHMENT_MAX_CONCURRENT_JOBS = "3";

    expect(resolveMaxConcurrentEnrichments()).toBe(3);
  });
});

describe("shutdown drain semantics", () => {
  afterEach(() => {
    resetEnrichmentStateForTests();
  });

  it("enqueueEnrichment is a no-op after markShuttingDown", () => {
    // Set a provider that would throw if any enrichment work ran —
    // this proves the job never reaches drainQueue.
    let providerCalled = false;
    setEnrichmentProviderForTests({
      generateSummary: async () => { providerCalled = true; return "s"; },
      computeEmbedding: async () => { providerCalled = true; return [1]; },
      extractTags: async () => { providerCalled = true; return []; },
    });

    const fakeSql = {} as Parameters<typeof enqueueEnrichment>[0];

    markShuttingDown();
    enqueueEnrichment(fakeSql, "tenant_a", "entry-1");

    // Queue stays empty because the job was rejected before entering it
    expect(getQueuedEnrichmentCount()).toBe(0);
    expect(getActiveEnrichmentCount()).toBe(0);
    expect(providerCalled).toBe(false);
  });

  it("markShuttingDown prevents all subsequent enqueues", () => {
    setEnrichmentProviderForTests(null);
    const fakeSql = {} as Parameters<typeof enqueueEnrichment>[0];

    markShuttingDown();

    enqueueEnrichment(fakeSql, "tenant_b", "entry-2");
    enqueueEnrichment(fakeSql, "tenant_b", "entry-3");

    expect(getQueuedEnrichmentCount()).toBe(0);
    expect(getActiveEnrichmentCount()).toBe(0);
  });
});

describe("recoverPendingEnrichments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetEnrichmentStateForTests();
  });

  it("reads tenant schemas via Drizzle and derives schema names from tenant ids", async () => {
    setEnrichmentProviderForTests({
      generateSummary: async () => "summary",
      computeEmbedding: async () => [1, 2, 3],
      extractTags: async () => ["ops"],
    });

    const orderByMock = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000010" },
    ]);
    const fromMock = vi.fn(() => ({
      orderBy: orderByMock,
    }));
    const selectMock = vi.fn(() => ({
      from: fromMock,
    }));
    drizzleMock.mockReturnValue({
      select: selectMock,
    });

    const tenantEntryOrderByMock = vi.fn().mockResolvedValue([]);
    const tenantEntryWhereMock = vi.fn(() => ({
      orderBy: tenantEntryOrderByMock,
    }));
    const tenantEntryFromMock = vi.fn(() => ({
      where: tenantEntryWhereMock,
    }));
    const tenantEntrySelectMock = vi.fn(() => ({
      from: tenantEntryFromMock,
    }));

    withTenantDrizzleScopeMock.mockImplementation(
      async (_sql, _schemaName, fn) => fn({ select: tenantEntrySelectMock }),
    );

    const sql = {} as SqlClient;
    await recoverPendingEnrichments(sql);

    expect(drizzleMock).toHaveBeenCalledWith(sql);
    expect(selectMock).toHaveBeenCalled();
    expect(withTenantDrizzleScopeMock).toHaveBeenCalledWith(
      sql,
      "tenant_00000000_0000_0000_0000_000000000010",
      expect.any(Function),
    );
  });
});

describe("enqueueEnrichment", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_CHAT_PROVIDER;
    delete process.env.ENRICHMENT_EMBEDDING_PROVIDER;
    resetEnrichmentStateForTests();
  });

  it("runs provider work sequentially within a single job", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const trackCall = async <T>(result: T): Promise<T> => {
      activeCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
      return result;
    };

    setEnrichmentProviderForTests({
      generateSummary: async () => trackCall("summary"),
      extractTags: async () => trackCall(["ops"]),
      computeEmbedding: async () => trackCall([0.1, 0.2, 0.3]),
    });

    let scopeCallCount = 0;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => {
      scopeCallCount += 1;

      if (scopeCallCount === 1) {
        return fn({
          update: () => ({
            set: () => ({
              where: () => ({
                returning: async () => [
                  {
                    id: "entry-1",
                    content: "sequential enrichment test",
                    summary: null,
                    tags: ["existing"],
                  },
                ],
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 2) {
        return fn({
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [],
                }),
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 3) {
        const writeReturningMock = vi.fn().mockResolvedValue([{ id: "entry-1" }]);
        return fn({
          update: () => ({
            set: () => ({
              where: () => ({
                returning: writeReturningMock,
              }),
            }),
          }),
        });
      }

      throw new Error(`Unexpected withTenantDrizzleScope call #${scopeCallCount}`);
    });

    enqueueEnrichment({} as SqlClient, "tenant_test", "entry-1");
    await waitForEnrichmentDrain(1000);

    expect(maxConcurrentCalls).toBe(1);
  });

  it("skips summary generation when the entry already has summary", async () => {
    const generateSummary = vi.fn(async () => "generated");
    const extractTags = vi.fn(async () => ["ops"]);
    const computeEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);
    setEnrichmentProviderForTests({ generateSummary, extractTags, computeEmbedding });

    let scopeCallCount = 0;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => {
      scopeCallCount += 1;
      if (scopeCallCount === 1) {
        return fn({ update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "entry-1", content: "x", summary: "existing summary", tags: ["t"], version: 1, memoryScope: "group", groupId: "g", userId: null, authorAgentId: "a" }] }) }) }) });
      }
      if (scopeCallCount === 2) {
        return fn({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) });
      }
      return fn({ update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "entry-1" }] }) }) }) });
    });

    enqueueEnrichment({} as SqlClient, "tenant_test", "entry-1");
    await waitForEnrichmentDrain(1000);

    expect(generateSummary).not.toHaveBeenCalled();
    expect(extractTags).toHaveBeenCalledTimes(1);
    expect(computeEmbedding).toHaveBeenCalledTimes(1);
  });

  it("skips chat operations when chat provider is none but still computes embedding", async () => {
    process.env.ENRICHMENT_CHAT_PROVIDER = "none";
    process.env.ENRICHMENT_EMBEDDING_PROVIDER = "onnx";
    const generateSummary = vi.fn(async () => "generated");
    const extractTags = vi.fn(async () => ["ops"]);
    const computeEmbedding = vi.fn(async () => [0.1, 0.2, 0.3]);
    setEnrichmentProviderForTests({ generateSummary, extractTags, computeEmbedding });

    let scopeCallCount = 0;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => {
      scopeCallCount += 1;
      if (scopeCallCount === 1) {
        return fn({ update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "entry-1", content: "x", summary: null, tags: ["t"], version: 1, memoryScope: "group", groupId: "g", userId: null, authorAgentId: "a" }] }) }) }) });
      }
      if (scopeCallCount === 2) {
        return fn({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) });
      }
      return fn({ update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "entry-1" }] }) }) }) });
    });

    enqueueEnrichment({} as SqlClient, "tenant_test", "entry-1");
    await waitForEnrichmentDrain(1000);

    expect(generateSummary).not.toHaveBeenCalled();
    expect(extractTags).not.toHaveBeenCalled();
    expect(computeEmbedding).toHaveBeenCalledTimes(1);
  });

  it("requeues stale enrichment write-back when memory version changed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    setEnrichmentProviderForTests({
      generateSummary: async () => "summary",
      extractTags: async () => ["ops"],
      computeEmbedding: async () => [0.1, 0.2, 0.3],
    });

    const staleWriteReturningMock = vi.fn().mockResolvedValue([]);
    const staleResetReturningMock = vi.fn().mockResolvedValue([{ id: "entry-1" }]);
    const freshWriteReturningMock = vi.fn().mockResolvedValue([{ id: "entry-1" }]);
    let scopeCallCount = 0;
    withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) => {
      scopeCallCount += 1;

      if (scopeCallCount === 1) {
        return fn({
          update: () => ({
            set: () => ({
              where: () => ({
                returning: async () => [
                  {
                    id: "entry-1",
                    content: "stale test",
                    tags: ["existing"],
                    version: 1,
                  },
                ],
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 2) {
        return fn({
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [],
                }),
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 3) {
        const updateMock = vi
          .fn()
          .mockImplementationOnce(() => ({
            set: () => ({
              where: () => ({
                returning: staleWriteReturningMock,
              }),
            }),
          }))
          .mockImplementationOnce(() => ({
            set: () => ({
              where: () => ({
                returning: staleResetReturningMock,
              }),
            }),
          }));

        return fn({
          update: updateMock,
        });
      }

      if (scopeCallCount === 4) {
        return fn({
          update: () => ({
            set: () => ({
              where: () => ({
                returning: async () => [
                  {
                    id: "entry-1",
                    content: "fresh test",
                    tags: ["existing"],
                    version: 2,
                  },
                ],
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 5) {
        return fn({
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [],
                }),
              }),
            }),
          }),
        });
      }

      if (scopeCallCount === 6) {
        return fn({
          update: () => ({
            set: () => ({
              where: () => ({
                returning: freshWriteReturningMock,
              }),
            }),
          }),
        });
      }

      throw new Error(`Unexpected withTenantDrizzleScope call #${scopeCallCount}`);
    });

    enqueueEnrichment({} as SqlClient, "tenant_test", "entry-1");
    await waitForEnrichmentDrain(1000);

    expect(staleWriteReturningMock).toHaveBeenCalledTimes(1);
    expect(staleResetReturningMock).toHaveBeenCalledTimes(1);
    expect(freshWriteReturningMock).toHaveBeenCalledTimes(1);
    expect(scopeCallCount).toBe(6);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Memory enrichment failed"));
  });
});

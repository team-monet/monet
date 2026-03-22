import type { SqlClient } from "@monet/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnrichmentProvider } from "../providers/index";

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
  setEnrichmentProviderForTests,
} from "../services/enrichment.service";

describe("createEnrichmentProvider", () => {
  afterEach(() => {
    delete process.env.ENRICHMENT_PROVIDER;
    delete process.env.ENRICHMENT_API_KEY;
    resetEnrichmentStateForTests();
  });

  it("creates an ollama provider from env", () => {
    process.env.ENRICHMENT_PROVIDER = "ollama";
    const provider = createEnrichmentProvider();
    expect(provider).toBeDefined();
  });

  it("creates an openai provider from env", () => {
    process.env.ENRICHMENT_PROVIDER = "openai";
    const provider = createEnrichmentProvider();
    expect(provider).toBeDefined();
  });

  it("creates an onnx provider from env", () => {
    process.env.ENRICHMENT_PROVIDER = "onnx";
    const provider = createEnrichmentProvider();
    expect(provider).toBeDefined();
  });

  it("throws for an unknown provider", () => {
    process.env.ENRICHMENT_PROVIDER = "unknown";
    expect(() => createEnrichmentProvider()).toThrow("Unknown ENRICHMENT_PROVIDER");
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

import { afterEach, describe, expect, it } from "vitest";
import { createEnrichmentProvider } from "../providers/index.js";
import {
  computeQueryEmbedding,
  resetEnrichmentStateForTests,
  setEnrichmentProviderForTests,
} from "../services/enrichment.service.js";

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

  it("throws for an unknown provider", () => {
    process.env.ENRICHMENT_PROVIDER = "unknown";
    expect(() => createEnrichmentProvider()).toThrow("Unknown ENRICHMENT_PROVIDER");
  });
});

describe("computeQueryEmbedding", () => {
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../providers/enrichment";
import { OnnxEnrichmentProvider } from "../providers/onnx-enrichment";

const { pipelineMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
}));

vi.mock("@xenova/transformers", () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

function makeEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
}

describe("OnnxEnrichmentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Arctic query prefix and CLS pooling for query mode", async () => {
    const extractorMock = vi.fn().mockResolvedValue({ data: makeEmbedding() });
    pipelineMock.mockResolvedValue(extractorMock);

    const provider = new OnnxEnrichmentProvider({
      onnxEmbeddingModel: "Snowflake/snowflake-arctic-embed-l-v2.0",
    });

    await provider.computeEmbedding("hello world", { mode: "query" });

    expect(extractorMock).toHaveBeenCalledWith("query: hello world", {
      pooling: "cls",
      normalize: true,
    });
  });

  it("uses mean pooling and no query prefix for non-Arctic models", async () => {
    const extractorMock = vi.fn().mockResolvedValue({ data: makeEmbedding() });
    pipelineMock.mockResolvedValue(extractorMock);

    const provider = new OnnxEnrichmentProvider({
      onnxEmbeddingModel: "Xenova/all-MiniLM-L6-v2",
    });

    await provider.computeEmbedding("hello world", { mode: "query" });

    expect(extractorMock).toHaveBeenCalledWith("hello world", {
      pooling: "mean",
      normalize: true,
    });
  });
});

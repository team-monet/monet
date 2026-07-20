import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FreshStoreEmbedderUnavailableError,
  MonetCore,
  chooseStoreEmbedder,
  readStoredEmbedderPin,
} from "../index";
import { HashingEmbeddingProvider } from "../embedding";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    if (process.env.MONET_TEST_ONNX_FAILURE === "1") {
      throw new Error("injected ONNX startup failure");
    }
    return async () => ({ data: new Float32Array(384) });
  }),
}));

describe("chooseStoreEmbedder — first-boot hard requirement", () => {
  let dir: string;
  let dbPath: string;
  let priorEmbedder: string | undefined;
  let priorFailure: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-store-embedder-"));
    dbPath = join(dir, "monet.db");
    priorEmbedder = process.env.MONET_EMBEDDER;
    priorFailure = process.env.MONET_TEST_ONNX_FAILURE;
    delete process.env.MONET_EMBEDDER;
    delete process.env.MONET_TEST_ONNX_FAILURE;
  });

  afterEach(() => {
    if (priorEmbedder === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedder;
    if (priorFailure === undefined) delete process.env.MONET_TEST_ONNX_FAILURE;
    else process.env.MONET_TEST_ONNX_FAILURE = priorFailure;
    rmSync(dir, { recursive: true, force: true });
  });

  it("fresh + ONNX available proceeds with the semantic provider", async () => {
    const provider = await chooseStoreEmbedder(dbPath);
    expect(provider.constructor.name).toBe("OnnxEmbeddingProvider");
    expect(provider.modelId).toBe("Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("fresh + implicit fallback throws the typed error before a DB file or pin can be created", async () => {
    process.env.MONET_TEST_ONNX_FAILURE = "1";

    await expect(chooseStoreEmbedder(dbPath)).rejects.toBeInstanceOf(FreshStoreEmbedderUnavailableError);
    await expect(chooseStoreEmbedder(dbPath)).rejects.toThrow(/NEW store.*permanently degrade recall/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("fresh + explicit hashing proceeds and can be pinned by construction", async () => {
    process.env.MONET_EMBEDDER = "hashing";
    const provider = await chooseStoreEmbedder(dbPath);
    expect(provider.modelId).toBe("hashing:dim=256:tok=2");

    const core = new MonetCore(dbPath, { embedder: provider });
    core.close();
    expect(existsSync(dbPath)).toBe(true);
    expect(readStoredEmbedderPin(dbPath)).toBe("hashing:dim=256:tok=2");
  });

  it("legacy unpinned vectors preserve automatic lexical fallback", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
    await seed.store("legacy vector evidence", { resolution: "forceNew" });
    (seed as any).db
      .prepare(
        `UPDATE sync_meta SET embedder_model_id = NULL, embedder_pin_source = NULL, embedder_pinned_at = NULL WHERE singleton = 1`,
      )
      .run();
    seed.close();

    process.env.MONET_TEST_ONNX_FAILURE = "1";
    const provider = await chooseStoreEmbedder(dbPath);
    expect(provider.constructor.name).toBe("HashingEmbeddingProvider");
  });

  it("a pinned store honors its pin without consulting a failing default ONNX path", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(128, 1) });
    seed.close();

    process.env.MONET_TEST_ONNX_FAILURE = "1";
    process.env.MONET_EMBEDDER = "onnx";
    const provider = await chooseStoreEmbedder(dbPath);
    expect(provider.modelId).toBe("hashing:dim=128:tok=1");
  });
});

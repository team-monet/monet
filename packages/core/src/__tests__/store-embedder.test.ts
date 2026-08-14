import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FreshStoreEmbedderUnavailableError,
  MonetCore,
  chooseStoreEmbedder,
  readStoredEmbedderPin,
  readStoredVectorPresence,
} from "../index";
import { HashingEmbeddingProvider } from "../embedding";
import { DEFAULT_MODEL } from "../embedding-onnx";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    if (process.env.MONET_TEST_ONNX_FAILURE === "1") {
      throw new Error("injected ONNX startup failure");
    }
    // The width follows whatever the DEFAULT space declares, read from the provider rather than
    // written as a literal: a fresh store validates its warmup against that declaration, so a mock
    // pinned to one checkpoint's width fails every future default of another width — for a reason
    // that has nothing to do with what these tests are about.
    const { OnnxEmbeddingProvider } = await import("../embedding-onnx");
    const width = new OnnxEmbeddingProvider().dim;
    return async () => ({ data: new Float32Array(width) });
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
    // Whatever DEFAULT_MODEL is, not a literal: this test is about the CHOICE being the semantic
    // provider on a fresh store, not about which checkpoint that provider currently defaults to.
    expect(provider.modelId).toBe(DEFAULT_MODEL);
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

  it("legacy unpinned vectors keep the auto-fallback — the engine infers their model from vector DIMENSION, and only reaching it can", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
    await seed.store("legacy content written before pinning existed");
    (seed as any).db.prepare(`UPDATE sync_meta SET embedder_model_id = NULL WHERE singleton = 1`).run();
    seed.close();
    expect(readStoredEmbedderPin(dbPath)).toBeNull(); // the premise: unpinned, but NOT empty

    // NOT the fresh-store case, and the difference is load-bearing. backfillEmbedderPin maps 384 ->
    // LEGACY_ONNX_DEFAULT_MODEL_ID and 256 -> hashing tok=1 from the vectors themselves, inside
    // ensureEmbedderPin — after construction. Refusing here would mean a legacy store whose own
    // model is cached becomes unopenable because an unrelated current default cannot download.
    process.env.MONET_TEST_ONNX_FAILURE = "1";
    const provider = await chooseStoreEmbedder(dbPath);
    expect(provider.constructor.name).toBe("HashingEmbeddingProvider");
    expect(readStoredEmbedderPin(dbPath)).toBeNull(); // still unpinned — the engine decides, not this
  });

  it("an UNREADABLE unpinned store does not take the legacy path — unknown is not evidence of vectors", async () => {
    /*
     * The three states of readStoredVectorPresence are true / false / null, and null means the store
     * could not be read at all. Folding null into the legacy branch let an unreadable unpinned store
     * reach createLocalEmbedder(), silently take the lexical fallback, and get PERMANENTLY pinned to
     * it by ensureEmbedderPin — the exact silent degradation this module exists to prevent, entered
     * through the one state that proves nothing.
     */
    writeFileSync(dbPath, "this is not a SQLite database");
    expect(readStoredEmbedderPin(dbPath)).toBeNull();
    expect(readStoredVectorPresence(dbPath)).toBeNull(); // the premise: unknown, not false

    process.env.MONET_TEST_ONNX_FAILURE = "1";
    await expect(chooseStoreEmbedder(dbPath)).rejects.toBeInstanceOf(FreshStoreEmbedderUnavailableError);

    // And it is not a blanket refusal: an EXPLICIT lexical opt-in still proceeds.
    process.env.MONET_EMBEDDER = "hashing";
    await expect(chooseStoreEmbedder(dbPath)).resolves.toBeDefined();
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

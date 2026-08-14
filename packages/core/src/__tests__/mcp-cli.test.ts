/**
 * scripts/mcp-cli.ts — chooseStartupEmbedder unit tests (Codex review, PR #51 round 7, FIX U;
 * extended round 8, FIX Z).
 *
 * Previously this CLI unconditionally awaited createLocalEmbedder() (honoring MONET_EMBEDDER)
 * BEFORE ever constructing a MonetCore or reading the store's own persisted pin — so a store
 * already pinned to hashing would still pay (and could fail) an ONNX warmup it was never going to
 * keep, with MONET_EMBEDDER=onnx. chooseStartupEmbedder reads the pin FIRST (readStoredEmbedderPin,
 * storage.ts) and only falls back to createLocalEmbedder's MONET_EMBEDDER-driven guess when there
 * is no persisted pin to honor instead.
 *
 * ROUND 8 UPDATE (FIX Z): FIX U's strict pre-construction load regressed FIX O (round 5)'s empty-
 * store recovery — a stale/unloadable pin on a genuinely EMPTY store used to be RECOVERABLE
 * (ensureEmbedderPin re-pins to the live constructor embedder and serves, since an empty store has
 * no committed space to protect), but FIX U's strict load now throws right here, before MonetCore
 * is even constructed, before ensureEmbedderPin ever gets a chance to run that recovery.
 * chooseStartupEmbedder now catches ONLY UnsatisfiableEmbedderError and falls back to
 * createLocalEmbedder(), letting construction proceed — ensureEmbedderPin (called later, inside
 * createMonetCoreMcpServer) does the actual empty-vs-non-empty deciding, exactly as it always has.
 *
 * Imports chooseStartupEmbedder directly from the script; main() is guarded behind an
 * import.meta.url entry-point check so importing this module never starts a real stdio MCP server
 * as a side effect — same established pattern as scripts/migrate-file-concept.ts's preflightEmbedder
 * (round 6) and scrub-corpus.mjs/scrub-db.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseStartupEmbedder } from "../../scripts/mcp-cli";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { UnsatisfiableEmbedderError } from "../embedding-onnx";

// Hoisted by vitest above these imports — same mock shape as embedding-onnx.test.ts, so the ONNX
// pin-dispatch branch runs its real code (instantiateEmbedderForPin -> OnnxEmbeddingProvider) with
// no network and no real model.
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async (_task: string, model: string) => {
    if (model === "Xenova/mock-cli-ok-model") {
      return async (_text: string, _opts: unknown) => ({ data: new Float32Array(384) });
    }
    throw new Error(`mocked transformers.js: no such model '${model}'`);
  }),
}));

describe("chooseStartupEmbedder (Codex review, PR #51 round 7, FIX U)", () => {
  let dir: string;
  let dbPath: string;
  let priorEmbedderEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-cli-startup-embedder-"));
    dbPath = join(dir, "monet.db");
    priorEmbedderEnv = process.env.MONET_EMBEDDER;
  });

  afterEach(() => {
    if (priorEmbedderEnv === undefined) delete process.env.MONET_EMBEDDER;
    else process.env.MONET_EMBEDDER = priorEmbedderEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("pin present (hashing): dispatches through instantiateEmbedderForPin, ignoring MONET_EMBEDDER entirely", async () => {
    // Seed a store pinned to hashing tok=1 (real, no network).
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
    seed.close();

    process.env.MONET_EMBEDDER = "onnx"; // deliberately the OPPOSITE of the pin — must be ignored
    const embedder = await chooseStartupEmbedder(dbPath);
    expect(embedder.modelId).toBe("hashing:dim=256:tok=1"); // the PIN's identity, not MONET_EMBEDDER's
    expect(embedder.constructor.name).toBe("HashingEmbeddingProvider"); // real instantiation, not a stub
  });

  it("pin present (ONNX-shaped): dispatches into the ONNX path (mocked, no network) — never reaches createLocalEmbedder's MONET_EMBEDDER branch", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
    (seed as any).db
      .prepare(`UPDATE sync_meta SET embedder_model_id = 'Xenova/mock-cli-ok-model', embedder_pin_source = 'migrated' WHERE singleton = 1`)
      .run();
    seed.close();

    const embedder = await chooseStartupEmbedder(dbPath);
    expect(embedder.modelId).toBe("Xenova/mock-cli-ok-model");
    expect(embedder.dim).toBe(384);
  });

  it("pin absent (a genuinely nonexistent db path — no store yet): falls back to createLocalEmbedder, honoring MONET_EMBEDDER exactly as before", async () => {
    const neverCreated = join(dir, "does-not-exist-yet.db");
    process.env.MONET_EMBEDDER = "hashing"; // avoid any real ONNX load in this branch
    const embedder = await chooseStartupEmbedder(neverCreated);
    expect(embedder.constructor.name).toBe("HashingEmbeddingProvider");
  });

  it("pin absent (a real store, but genuinely pre-pin — NULL in sync_meta): falls back to createLocalEmbedder, same as the nonexistent-path case", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
    (seed as any).db
      .prepare(`UPDATE sync_meta SET embedder_model_id = NULL, embedder_pin_source = NULL, embedder_pinned_at = NULL WHERE singleton = 1`)
      .run();
    seed.close();

    process.env.MONET_EMBEDDER = "hashing";
    const embedder = await chooseStartupEmbedder(dbPath);
    expect(embedder.constructor.name).toBe("HashingEmbeddingProvider");
  });

  it("(round 8, FIX Z) pin present but unloadable, EMPTY store: chooseStartupEmbedder falls back to createLocalEmbedder instead of throwing — construction can proceed so ensureEmbedderPin's own empty-store recovery (FIX O) gets a chance to run", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() }); // genuinely empty — no store()/search() call ever happened
    (seed as any).db
      .prepare(`UPDATE sync_meta SET embedder_model_id = 'Xenova/mock-cli-broken-model', embedder_pin_source = 'migrated' WHERE singleton = 1`)
      .run(); // ONNX-shaped, but NOT one of the mock's recognized model ids above — instantiateEmbedderForPin's real dispatch/load-attempt code wraps the resulting failure as UnsatisfiableEmbedderError, exactly like a real unreachable model would
    seed.close();

    process.env.MONET_EMBEDDER = "hashing"; // must be IGNORED here too — the fallback is createLocalEmbedder's own MONET_EMBEDDER read, not a hardcoded choice
    const embedder = await chooseStartupEmbedder(dbPath);
    expect(embedder.constructor.name).toBe("HashingEmbeddingProvider"); // the fallback, not a thrown error
  });

  it("pin present but unloadable, NON-EMPTY store: refuses BEFORE construction — its vectors live in a space nothing available can read", async () => {
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
    await seed.store("real content making this store genuinely non-empty", { circle: "fix-z" });
    (seed as any).db
      .prepare(`UPDATE sync_meta SET embedder_model_id = 'Xenova/mock-cli-broken-model', embedder_pin_source = 'migrated' WHERE singleton = 1`)
      .run();
    seed.close();

    // SUPERSEDES FIX Z's non-empty half. That round asserted chooseStartupEmbedder "can't see store
    // contents", fell back to lexical, and left the loud failure to ensureEmbedderPin. It does read
    // them now, and refuses here — because between those two points the server would have been
    // constructed on a provider whose space does not match the stored vectors. FIX Z's own comment
    // called the two "the same loud failure, just at ensure instead of pre-construction"; this is
    // that failure at the earlier of the two points, before anything can serve from it.
    //
    // MONET_EMBEDDER=hashing does NOT rescue it: an explicit lexical opt-in chooses a provider, it
    // does not re-space vectors that are already written.
    process.env.MONET_EMBEDDER = "hashing";
    await expect(chooseStartupEmbedder(dbPath)).rejects.toMatchObject({
      name: "PinnedStoreEmbedderUnavailableError",
      pin: "Xenova/mock-cli-broken-model",
    });
  });
});

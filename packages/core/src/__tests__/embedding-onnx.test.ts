// embedder-pin ADR, slice 1: instantiateEmbedderForPin is the strict pin-satisfaction loader
// (Task 3). Per the ADR's test discipline, ONNX model download/warmup must never run in unit
// tests — these tests exercise the hashing branch for real (no network, no dependency), the
// format-dispatch/failure logic for the unrecognized-format branch (also no network: an
// unrecognized modelId is rejected before any instantiation is attempted), and the recognized-
// ONNX-shaped branch's dispatch/failure-wrapping logic against a MOCKED `@huggingface/transformers`
// (no network, no real model load — "constructor/dispatch logic and injected fakes", per the
// brief). MonetCore.ensureEmbedderPin's own ONNX-satisfying path is additionally covered at the
// engine level via an injected fake loader (see embedder-pin.test.ts, Shape 2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createLocalEmbedderWithProvenance,
  instantiateEmbedderForPin,
  resolveModelCacheDir,
  isLocalModelPath,
  UnsatisfiableEmbedderError,
  LEGACY_ONNX_DEFAULT_MODEL_ID,
} from "../embedding-onnx";
import { HashingEmbeddingProvider } from "../embedding";

// Hoisted by vitest above these imports — intercepts OnnxEmbeddingProvider's dynamic
// `import("@huggingface/transformers")` (embedding-onnx.ts's `load()`) so the ONNX branch's real
// dispatch/warmup/error-wrapping code runs unmodified, but never touches the network or a real
// model. `pipeline` is the ONLY export transformers.js's feature-extraction path actually uses —
// deliberately, including for #90's cache location, which is passed as a pipeline() option rather
// than set on the module's `env` global (see the model-cache describe block at the bottom).
// Hoisted so the mock factory (itself hoisted above the imports) can close over it: it records the
// `cache_dir` production actually passed to pipeline(), which is what #90's fix consists of.
const transformers = vi.hoisted(() => ({ cacheDirPassedToPipeline: undefined as string | undefined }));

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async (_task: string, model: string, opts?: { cache_dir?: string }) => {
    transformers.cacheDirPassedToPipeline = opts?.cache_dir;
    if (model === "Xenova/mock-ok-model") {
      // 384-long (matching OnnxEmbeddingProvider's declared default dim — the ordinary, no-mismatch
      // case): a distinctive first three values, zero-padded, so tests can still assert on real
      // content without hand-writing 384 numbers.
      const vec = new Float32Array(384);
      vec[0] = 0.1;
      vec[1] = 0.2;
      vec[2] = 0.3;
      return async (_text: string, _opts: unknown) => ({ data: vec });
    }
    // FIX J (Codex review, PR #51 round 3 — supersedes FIX B's reject-on-mismatch): a model that
    // loads successfully but emits a vector width OTHER than OnnxEmbeddingProvider's class-default
    // declared dim (384). dim is purely declarative (verified by reading embed()), so this must be
    // measure-and-adopted, not rejected. Stands in for a future, wider-than-384 Xenova release, or
    // any custom-dim model FIX F's widened recognizer now accepts.
    if (model === "Xenova/mock-wrong-dim-model") {
      return async (_text: string, _opts: unknown) => ({ data: new Float32Array(768) });
    }
    // FIX F (Codex review, PR #51): a non-Xenova, owner/repo-shaped model — stands in for a real
    // HF model this build's constructors accept but the OLD Xenova-only recognizer would have
    // rejected outright, before ever reaching this mock.
    if (model === "onnx-community/mock-ok-model") {
      return async (_text: string, _opts: unknown) => ({ data: new Float32Array(384) });
    }
    // FIX L (Codex review, PR #51 round 4): a local filesystem path (relative), passed straight
    // through to pipeline() exactly like a hub id — stands in for a real local model directory the
    // OLD leading-alphanumeric-only regex rejected outright, before ever reaching this mock.
    if (model === "./models/mock-local-ok") {
      return async (_text: string, _opts: unknown) => ({ data: new Float32Array(384) });
    }
    // FIX Q (Codex review, PR #51 round 6): a Windows-style backslash-separated local path — stands
    // in for a real Windows model directory the OLD forward-slash-only regex rejected outright
    // (zero forward slashes in "C:\models\..."), before ever reaching this mock.
    if (model === "C:\\models\\mock-local-ok") {
      return async (_text: string, _opts: unknown) => ({ data: new Float32Array(384) });
    }
    throw new Error(`mocked transformers.js: no such model '${model}'`);
  }),
}));

describe("LEGACY_ONNX_DEFAULT_MODEL_ID", () => {
  it("names the pre-item-9 English ONNX default exactly", () => {
    expect(LEGACY_ONNX_DEFAULT_MODEL_ID).toBe("Xenova/all-MiniLM-L6-v2");
  });
});

describe("fresh ONNX selection output contract", () => {
  it("rejects a warmup whose real width disagrees with the fresh provider declaration", async () => {
    const prior = process.env.MONET_EMBEDDER;
    process.env.MONET_EMBEDDER = "onnx";
    try {
      await expect(createLocalEmbedderWithProvenance({ model: "Xenova/mock-wrong-dim-model" }))
        .rejects.toThrow(/declared dimension 384/);
    } finally {
      if (prior === undefined) delete process.env.MONET_EMBEDDER;
      else process.env.MONET_EMBEDDER = prior;
    }
  });
});

describe("instantiateEmbedderForPin — hashing dispatch (real instantiation, no network)", () => {
  it("hashing:dim=256:tok=1 resurrects the exact old tokenizer", async () => {
    const provider = await instantiateEmbedderForPin("hashing:dim=256:tok=1");
    expect(provider.modelId).toBe("hashing:dim=256:tok=1");
    expect(provider.dim).toBe(256);
    // Genuinely tok=1 behavior (ASCII-only), not merely a matching modelId string: a non-Latin
    // input collapses under tok=1 but not under tok=2 (see embedding.test.ts for the full case).
    const nonAscii = "こんにちは世界";
    const tok2Reference = new HashingEmbeddingProvider(256, 2).embed(nonAscii);
    expect(Array.from(await provider.embed(nonAscii))).not.toEqual(Array.from(tok2Reference));
  });

  it("hashing:dim=256:tok=2 dispatches to the current default tokenizer", async () => {
    const provider = await instantiateEmbedderForPin("hashing:dim=256:tok=2");
    expect(provider.modelId).toBe("hashing:dim=256:tok=2");
  });

  it("hashing:dim=<other>:tok=<v> respects an arbitrary dimension", async () => {
    const provider = await instantiateEmbedderForPin("hashing:dim=128:tok=1");
    expect(provider.modelId).toBe("hashing:dim=128:tok=1");
    expect(provider.dim).toBe(128);
  });

  it("an unknown hashing tokenizer version throws UnsatisfiableEmbedderError (fail closed, no guessing)", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("hashing:dim=256:tok=99");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.name).toBe("UnsatisfiableEmbedderError");
    expect(err.modelId).toBe("hashing:dim=256:tok=99");
    expect(err.message).toMatch(/newer version of monet/i);
    expect(err.cause).toBeInstanceOf(Error); // wraps HashingEmbeddingProvider's own "unknown version" throw
  });
});

describe("instantiateEmbedderForPin — ONNX dispatch (mocked @huggingface/transformers, no network)", () => {
  it("a recognized Xenova-shaped pin that loads successfully (and whose emitted width matches the declared dim) returns a working provider named exactly by the pin", async () => {
    const provider = await instantiateEmbedderForPin("Xenova/mock-ok-model");
    expect(provider.modelId).toBe("Xenova/mock-ok-model");
    expect(provider.dim).toBe(384);
    const vec = await provider.embed("hello");
    expect(vec.length).toBe(384);
    // Compare as float32 (not raw JS number literals) — avoids a float64-vs-float32 precision mismatch.
    expect(Array.from(vec.slice(0, 3))).toEqual(Array.from(Float32Array.from([0.1, 0.2, 0.3]))); // real content flowed through, not a stub
  });

  it("a recognized Xenova-shaped pin whose model fails to load throws UnsatisfiableEmbedderError — never substitutes another embedder", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("Xenova/does-not-exist");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.modelId).toBe("Xenova/does-not-exist");
    expect(err.message).toMatch(/newer version of monet|network access/i);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("FIX J (supersedes FIX B): a model that loads but emits a vector width OTHER than the class-default declared dim measures-and-adopts the real width, instead of rejecting a working model", async () => {
    // Ground truth this fix depends on (see embedding-onnx.ts's own comment at the call site):
    // OnnxEmbeddingProvider.embed() never reads this.dim — it returns Float32Array.from(output.data)
    // straight from the model's pooled output. dim is purely declarative, so a mismatch between the
    // class default and the model's real output is a DECLARATION bug, not a vector-space violation —
    // the fix is to correct the declaration, not refuse a model that works fine.
    const provider = await instantiateEmbedderForPin("Xenova/mock-wrong-dim-model");
    expect(provider.modelId).toBe("Xenova/mock-wrong-dim-model"); // the pin (model id) is unaffected — it alone determines the space
    expect(provider.dim).toBe(768); // declared dim now follows the MEASURED width, not the class default (384)
  });
});

describe("instantiateEmbedderForPin — ONNX dispatch widened to any owner/repo shape (Codex review, PR #51, FIX F)", () => {
  // The recognizer used to be Xenova-only; OnnxEmbeddingProvider/createLocalEmbedder accept ANY HF
  // model id (MONET_EMBEDDER or an explicit opts.model), so a store could be created — and its
  // pin, source='created', written — against a non-Xenova model this same build's loader then
  // rejected. "onnx-community/some-model" stands in for that: not Xenova, but a plausible real HF
  // owner/repo id this build's constructors would happily accept.
  it("a non-Xenova owner/repo-shaped pin that loads successfully dispatches into the ONNX path (not rejected as unrecognized)", async () => {
    const provider = await instantiateEmbedderForPin("onnx-community/mock-ok-model");
    expect(provider.modelId).toBe("onnx-community/mock-ok-model");
    expect(provider.dim).toBe(384);
  });

  it("a non-Xenova owner/repo-shaped pin whose model fails to load throws UnsatisfiableEmbedderError (dispatched into the ONNX path, not the unrecognized-format path — cause is set)", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("onnx-community/does-not-exist");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.modelId).toBe("onnx-community/does-not-exist");
    expect(err.cause).toBeInstanceOf(Error); // dispatched into the ONNX try/catch (a real load attempt), not the immediate-reject branch
  });
});

describe("instantiateEmbedderForPin — ONNX dispatch widened to local filesystem paths (Codex review, PR #51 round 4, FIX L)", () => {
  // OnnxEmbeddingProvider passes `model` straight through to transformers.js's pipeline() with no
  // validation (embedding-onnx.ts:64) — confirmed by reading the call site — and pipeline() accepts
  // a local path natively, same as a hub id. FIX F's owner/repo regex still rejected these (leading
  // '.' or '/' failed its `^[A-Za-z0-9]` class), so a store legitimately pinned to a local model
  // path was unsatisfiable by its own build's loader. A relative and an absolute path both stand in
  // here for "any local-path-shaped pin".
  it("a relative local-path pin ('./models/...') that loads successfully dispatches into the ONNX path", async () => {
    const provider = await instantiateEmbedderForPin("./models/mock-local-ok");
    expect(provider.modelId).toBe("./models/mock-local-ok");
    expect(provider.dim).toBe(384);
  });

  it("an absolute local-path pin ('/abs/...') whose model fails to load throws UnsatisfiableEmbedderError (dispatched into the ONNX path, not the unrecognized-format path — cause is set)", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("/abs/mock-local-missing");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.modelId).toBe("/abs/mock-local-missing");
    // Same closed outcome as owner/repo-shaped garbage (FIX F) and slash-less garbage (below) —
    // just reached via an attempted (mocked) load rather than an instant format rejection.
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("instantiateEmbedderForPin — ONNX dispatch widened to backslash (Windows) local paths (Codex review, PR #51 round 6, FIX Q)", () => {
  // Same transformers.js pipeline() call site as FIX L (embedding-onnx.ts:64), which accepts a
  // Windows-style absolute/UNC path (backslash-separated) exactly as freely as a POSIX one — but
  // FIX L's regex only recognized forward slashes, so "C:\models\foo" (zero forward slashes)
  // still fell through to the unrecognized-format branch and was unsatisfiable by its own build's
  // loader. Mirrors FIX L's two-test shape exactly: one success, one load failure.
  it("a Windows-style backslash-path pin ('C:\\models\\...') that loads successfully dispatches into the ONNX path", async () => {
    const provider = await instantiateEmbedderForPin("C:\\models\\mock-local-ok");
    expect(provider.modelId).toBe("C:\\models\\mock-local-ok");
    expect(provider.dim).toBe(384);
  });

  it("a Windows-style backslash-path pin whose model fails to load throws UnsatisfiableEmbedderError (dispatched into the ONNX path, not the unrecognized-format path — cause is set)", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("C:\\models\\mock-local-missing");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.modelId).toBe("C:\\models\\mock-local-missing");
    // Same closed outcome as owner/repo-shaped garbage (FIX F), POSIX-path garbage (FIX L), and
    // slash-less garbage (below) — just reached via an attempted (mocked) load rather than an
    // instant format rejection.
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("instantiateEmbedderForPin — unrecognized format (no instantiation attempted, no network)", () => {
  // "some/garbage-future-model" no longer belongs here post-FIX-F: it's owner/repo-shaped, so it's
  // now legitimately dispatched into the ONNX path (see the widened-recognition describe block
  // above) rather than instant-rejected. A genuinely unrecognized format has no slash at all.
  it("a modelId with no slash at all throws UnsatisfiableEmbedderError naming a newer Monet version, without attempting any instantiation", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("some-garbage-future-model-no-slash");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.modelId).toBe("some-garbage-future-model-no-slash");
    expect(err.message).toMatch(/newer version of monet/i);
    expect(err.message).toMatch(/upgrade/i);
    expect(err.cause).toBeUndefined(); // rejected before any instantiation attempt — nothing to wrap
  });

  it("garbage with no recognizable structure at all is also unsatisfiable", async () => {
    for (const modelId of ["", "???", "not-a-model-id", "hashing:dim=abc:tok=2"]) {
      await expect(instantiateEmbedderForPin(modelId)).rejects.toThrow(UnsatisfiableEmbedderError);
    }
  });
});

// #90: the model cache must not live inside the install. transformers.js defaults its cache to a
// path derived from its OWN directory (node_modules/@huggingface/transformers/.cache), so a global
// reinstall deletes a ~480MB download. On a store that has minted an embedder pin, a missing model
// is not a slow start but a refusal to serve (instantiateEmbedderForPin never substitutes), so the
// cache surviving reinstall is what keeps `npm i -g` from being an outage on a slow or offline link.
describe("model cache location (#90)", () => {
  const priorOverride = process.env.MONET_MODEL_CACHE;
  afterEach(() => {
    if (priorOverride === undefined) delete process.env.MONET_MODEL_CACHE;
    else process.env.MONET_MODEL_CACHE = priorOverride;
  });

  it("defaults to ~/.monet/models — beside the store, not inside the install", () => {
    delete process.env.MONET_MODEL_CACHE;
    expect(resolveModelCacheDir()).toBe(resolve(homedir(), ".monet", "models"));
    expect(resolveModelCacheDir()).not.toContain("node_modules");
  });

  it("MONET_MODEL_CACHE overrides it, resolved to an absolute path", () => {
    process.env.MONET_MODEL_CACHE = "./relative-cache";
    expect(resolveModelCacheDir()).toBe(resolve("./relative-cache"));
    process.env.MONET_MODEL_CACHE = "/srv/shared/models";
    expect(resolveModelCacheDir()).toBe("/srv/shared/models");
  });

  it("a whitespace-only override is ignored rather than caching into the process cwd", () => {
    process.env.MONET_MODEL_CACHE = "   ";
    expect(resolveModelCacheDir()).toBe(resolve(homedir(), ".monet", "models"));
  });

  // THE load-bearing property: the resolved directory reaches the actual load. Delete the
  // `cache_dir` argument in load() and only these two fail — the helper still returns the right
  // string while every download goes back into node_modules, which is #90 reopened.
  it("passes the resolved cache dir to pipeline() on the real load path", async () => {
    delete process.env.MONET_MODEL_CACHE;
    transformers.cacheDirPassedToPipeline = undefined;
    await instantiateEmbedderForPin("Xenova/mock-ok-model");
    expect(transformers.cacheDirPassedToPipeline).toBe(resolve(homedir(), ".monet", "models"));
  });

  it("honors MONET_MODEL_CACHE on the real load path, not just in the helper", async () => {
    process.env.MONET_MODEL_CACHE = "/srv/shared/models";
    transformers.cacheDirPassedToPipeline = undefined;
    await instantiateEmbedderForPin("Xenova/mock-ok-model");
    expect(transformers.cacheDirPassedToPipeline).toBe("/srv/shared/models");
  });

  // "Never touches the shared global" is asserted by this file's MOCK, not by a case here: it
  // declares `pipeline` and nothing else, and vitest throws on any access to an undeclared export.
  // So if production ever read or wrote `env`, every ONNX test above would fail with that error —
  // which is exactly what happened while the fix did use the global. A case cannot restate it,
  // because reaching for `mod.env` to prove its absence is itself the throwing access.
});

// Codex review, PR #134 — twice over. transformers.js loads a local path straight off disk and never
// caches it under MONET_MODEL_CACHE, so pointing an operator at a cache directory names something
// that does not exist. And these assertions live HERE, not in write-budget.test.ts, because this
// file already mocks the transformers module: the same tests against the real loader would reach the
// network for a deliberately nonexistent hub id, making a unit test depend on connectivity — the
// exact failure mode the committed probes were just fixed for.
describe("unsatisfiable-pin recovery advice (mocked, no network)", () => {
  it("classifies hub ids and local paths apart", () => {
    expect(isLocalModelPath("Xenova/all-MiniLM-L6-v2")).toBe(false);
    expect(isLocalModelPath("./models/foo")).toBe(true);
    expect(isLocalModelPath("/opt/models/foo")).toBe(true);
    expect(isLocalModelPath("~/models/foo")).toBe(true);
    expect(isLocalModelPath("C:\\models\\foo")).toBe(true);
  });

  it("offers cache cleanup for a hub id, and a path check for a local one", async () => {
    const hub = (await instantiateEmbedderForPin("Xenova/mock-missing-model").catch((e: Error) => e)) as Error;
    expect(hub.message).toMatch(/cached in .*mock-missing-model/);
    expect(hub.message).toContain("delete that model's directory");

    const local = (await instantiateEmbedderForPin("/opt/models/mock-missing").catch((e: Error) => e)) as Error;
    expect(local.message).toContain("is a local path, so nothing was cached");
    expect(local.message).not.toContain("delete that model's directory");
  });
});

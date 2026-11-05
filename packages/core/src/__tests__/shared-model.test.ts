import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  chmodSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseStoreEmbedder, PinnedStoreEmbedderUnavailableError } from "../store-embedder";
import {
  DEFAULT_MODEL,
  createLocalEmbedderWithProvenance,
  instantiateEmbedderForPin,
  OnnxEmbeddingProvider,
  SharedModelUnavailableError,
  UnsatisfiableEmbedderError,
  type ModelHost,
  type ModelSpec,
} from "../embedding-onnx";
import { MonetCore, readStoredEmbedderPin } from "../index";
import { createSharedModelHost, LocalModelHost } from "../shared-model";

const pipelineLoads = vi.hoisted(() => ({ count: 0, fail: false }));
const fsBehaviour = vi.hoisted(() => ({ chmodDoesNothing: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (!fsBehaviour.chmodDoesNothing) actual.chmodSync(...args);
    },
  };
});

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => {
    pipelineLoads.count += 1;
    if (pipelineLoads.fail) throw new Error("injected download failure");
    return async () => ({ data: new Float32Array([0.25, 0.5]) });
  }),
}));

const FIXTURE = resolve(import.meta.dirname, "fixtures/fake-model-host.ts");
const CLIENT_ONCE = resolve(import.meta.dirname, "fixtures/shared-model-client-once.ts");
const TSX = createRequire(import.meta.url).resolve("tsx");
const SPEC: ModelSpec = { model: "owner/model", pooling: "cls" };

function pidOf(vector: Float32Array): number {
  return vector[0]!;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

describe.skipIf(process.platform === "win32")("shared model host", () => {
  let dir: string;
  let runtimeDir: string;
  const started = new Set<number>();
  const priorEnv = process.env.FAKE_HOST_IDLE_EXIT_MS;

  beforeEach(() => {
    // realpath, and short: the socket path has a hard length limit, and tmpdir may be a symlink.
    dir = mkdtempSync(join(realpathSync(tmpdir()), "msm-"));
    runtimeDir = join(dir, "rt");
  });

  afterEach(() => {
    for (const pid of started) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    started.clear();
    if (priorEnv === undefined) delete process.env.FAKE_HOST_IDLE_EXIT_MS;
    else process.env.FAKE_HOST_IDLE_EXIT_MS = priorEnv;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function client(
    overrides: Partial<Parameters<typeof createSharedModelHost>[0]> = {},
  ): ModelHost {
    return createSharedModelHost({
      version: "test",
      hostEntry: FIXTURE,
      nodeArgs: ["--import", TSX],
      runtimeDir,
      ...overrides,
    });
  }

  async function hostPid(host: ModelHost): Promise<number> {
    const pid = pidOf(await host.embed(SPEC, "who"));
    started.add(pid);
    return pid;
  }

  function basePath(): string {
    const lock = readdirSync(runtimeDir).find((name) => name.endsWith(".lock"));
    if (!lock) throw new Error("no host has started yet");
    return join(runtimeDir, lock.replace(/\.lock$/, ""));
  }

  function winners(): number[] {
    return readFileSync(`${basePath()}.winners`, "utf8").trim().split("\n").map(Number);
  }

  it("ten sessions starting at once elect exactly one host and all reach it", async () => {
    const clients = Array.from({ length: 10 }, () => client());
    const pids = await Promise.all(clients.map(hostPid));

    expect(new Set(pids).size).toBe(1);
    // Answers alone would not catch an orphan: a second winner whose socket was overwritten answers
    // nobody and still holds a model. Only the record each winner leaves can show there was none.
    expect(winners()).toEqual([pids[0]]);
  }, 60_000);

  it("a host killed in the middle of a call costs that call a retry, not an error", async () => {
    const host = client();
    const first = await hostPid(host);

    const inFlight = host.embed(SPEC, "__slow__");
    await new Promise((settle) => setTimeout(settle, 200));
    process.kill(first, "SIGKILL");

    const replacement = pidOf(await inFlight);
    started.add(replacement);
    expect(replacement).not.toBe(first);
    // Answered by the replacement, not a private copy: the record shows the same process.
    expect(winners()).toContain(replacement);
  }, 60_000);

  it("a host that keeps dying ends in that call failing, and the next call still works", async () => {
    const host = client();
    await hostPid(host);

    const call = host.embed(SPEC, "__slow__").catch((error: unknown) => error);
    let settled = false;
    void call.finally(() => {
      settled = true;
    });
    const killed = new Set<number>();
    while (!settled) {
      for (const pid of winners()) {
        if (killed.has(pid)) continue;
        started.add(pid);
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (alive(pid)) process.kill(pid, "SIGKILL");
        killed.add(pid);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await call).toBeInstanceOf(SharedModelUnavailableError);
    expect(killed.size).toBeGreaterThanOrEqual(3);
    expect(killed.has(await hostPid(host))).toBe(false);
  }, 60_000);

  it("ten sessions racing to replace a killed host still elect exactly one", async () => {
    const first = await hostPid(client());
    process.kill(first, "SIGKILL");
    await waitUntil(() => !alive(first), "the kill");

    const pids = await Promise.all(Array.from({ length: 10 }, () => hostPid(client())));
    expect(new Set(pids).size).toBe(1);
    expect(winners()).toEqual([first, pids[0]]);
  }, 60_000);

  it("a socket left behind by a killed host does not stop the next one", async () => {
    const host = client();
    const first = await hostPid(host);
    process.kill(first, "SIGKILL");
    await waitUntil(() => !alive(first), "the kill");
    expect(existsSync(`${basePath()}.sock`)).toBe(true);

    const second = await hostPid(client());
    expect(second).not.toBe(first);
    // The session that was connected to the dead host recovers too.
    expect(await hostPid(host)).toBe(second);
  }, 60_000);

  it("an idle host exits and the next call brings one back, with the session none the wiser", async () => {
    process.env.FAKE_HOST_IDLE_EXIT_MS = "300";
    const host = client();
    const first = await hostPid(host);

    await waitUntil(() => !alive(first), "the idle exit");
    expect(existsSync(`${basePath()}.sock`)).toBe(false);

    const second = await hostPid(host);
    expect(second).not.toBe(first);
  }, 60_000);

  it("work keeps a host from idling out", async () => {
    process.env.FAKE_HOST_IDLE_EXIT_MS = "2000";
    const host = client();
    const first = await hostPid(host);
    for (let round = 0; round < 6; round += 1) {
      await new Promise((settle) => setTimeout(settle, 500));
      expect(await hostPid(host)).toBe(first);
    }
  }, 60_000);

  it("a host entry that does not exist means a private copy, quickly", async () => {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const fallback: ModelHost = {
      embed: vi.fn(async () => Float32Array.of(42)),
      countTokens: vi.fn(async () => 7),
      inputWindow: vi.fn(async () => 8),
    };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = client({ hostEntry: join(dir, "does-not-exist.js"), createFallback: () => fallback });

    const startedAt = performance.now();
    await expect(host.embed(SPEC, "x")).resolves.toEqual(Float32Array.of(42));
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await expect(host.countTokens(SPEC, "x")).resolves.toBe(7);
    expect(stderr.mock.calls.flat().join(" ")).toContain("loads its own copy");
  }, 30_000);

  it("a host that exits non-zero on start falls back at once rather than waiting out the deadline", async () => {
    const entry = join(dir, "exits-one.mjs");
    writeFileSync(entry, "process.exit(1);\n");
    const fallback: ModelHost = {
      embed: async () => Float32Array.of(9),
      countTokens: async () => 0,
      inputWindow: async () => null,
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host = client({ hostEntry: entry, nodeArgs: [], createFallback: () => fallback });

    const startedAt = performance.now();
    await expect(host.embed(SPEC, "x")).resolves.toEqual(Float32Array.of(9));
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);

  it("once sharing has worked, a dead host fails the call and never loads a private copy", async () => {
    // Ten sessions all falling back to a private model after a host death would recreate the memory
    // spike that may have killed the host, at the worst possible moment.
    const createFallback = vi.fn<() => ModelHost>();
    const host = client({ createFallback });
    const first = await hostPid(host);

    writeFileSync(`${basePath()}.refuse`, "");
    process.kill(first, "SIGKILL");
    await waitUntil(() => !alive(first), "the kill");

    const failure = await host.embed(SPEC, "x").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SharedModelUnavailableError);
    expect((failure as Error).message).toContain("no other embedder was used");
    expect(createFallback).not.toHaveBeenCalled();

    rmSync(`${basePath()}.refuse`);
    expect(await hostPid(host)).not.toBe(first);
    expect(createFallback).not.toHaveBeenCalled();
  }, 60_000);

  it("a host that is alive but answers nothing is ended, and the call lands on its replacement", async () => {
    const host = client({ stallLimitMs: 500 });
    const first = await hostPid(host);
    process.kill(first, "SIGSTOP");

    const second = pidOf(await host.embed(SPEC, "after the freeze"));
    started.add(second);
    expect(second).not.toBe(first);
    await waitUntil(() => !alive(first), "the stuck host to be gone");
  }, 60_000);

  it("a new session is not trapped by a stuck host either", async () => {
    const first = await hostPid(client());
    process.kill(first, "SIGSTOP");

    const second = await hostPid(client({ stallLimitMs: 500 }));
    expect(second).not.toBe(first);
  }, 60_000);

  it("a call that wedges every host it lands on fails after its attempts, and other work resumes", async () => {
    const host = client({ stallLimitMs: 400 });
    started.add(await hostPid(host));

    const failure = await host.embed(SPEC, "__hang__").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SharedModelUnavailableError);
    for (const pid of winners()) started.add(pid);

    const after = await hostPid(host);
    expect(alive(after)).toBe(true);
  }, 60_000);

  it("a long queue is not mistaken for a stall", async () => {
    const stallLimitMs = 800;
    const busy = client({ stallLimitMs });
    const waiting = client({ stallLimitMs });
    const first = await hostPid(busy);

    // Six ticks ahead of it take far longer than the limit, and every one of them finishes.
    const ticks = Array.from({ length: 6 }, () => busy.embed(SPEC, "__tick__"));
    await new Promise((settle) => setTimeout(settle, 50));
    const startedWaiting = performance.now();
    const answered = pidOf(await waiting.embed(SPEC, "behind the queue"));

    expect(performance.now() - startedWaiting).toBeGreaterThan(stallLimitMs);
    expect(answered).toBe(first);
    expect((await Promise.all(ticks)).map(pidOf)).toEqual(Array(6).fill(first));
    expect(winners()).toEqual([first]);
  }, 60_000);

  it("a host stuck on a call nobody is waiting for still gives its memory back", async () => {
    process.env.FAKE_HOST_IDLE_EXIT_MS = "600";
    const pid = await hostPid(client());

    await new Promise<void>((settle) => {
      const raw = connect(`${basePath()}.sock`, () => {
        raw.write(`${JSON.stringify({ id: 1, op: "embed", spec: SPEC, text: "__hang__" })}\n`);
        setTimeout(() => raw.destroy(), 100);
      });
      raw.on("close", () => settle());
    });

    await waitUntil(() => !alive(pid), "the wedged host to exit");
  }, 60_000);

  it("a host that never starts listening fails the call: no private copy, no pile of hosts", async () => {
    // Too slow to start one host is too slow to load a private model too, and that load is the
    // memory spike this whole mechanism exists to avoid.
    const spawns = join(dir, "spawns");
    const entry = join(dir, "never-listens.mjs");
    writeFileSync(
      entry,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");\nsetInterval(() => {}, 1000);\n`,
    );
    const createFallback = vi.fn<() => ModelHost>();
    const host = client({ hostEntry: entry, nodeArgs: [], connectDeadlineMs: 2_500, createFallback });

    await expect(host.embed(SPEC, "x")).rejects.toBeInstanceOf(SharedModelUnavailableError);
    const pids = readFileSync(spawns, "utf8").trim().split("\n").map(Number);
    for (const pid of pids) started.add(pid);

    expect(createFallback).not.toHaveBeenCalled();
    expect(pids).toHaveLength(1);
  }, 30_000);

  it("frames that are valid JSON but not messages cost a retry, not the session", async () => {
    const host = client();
    const pid = await hostPid(host);
    const socketPath = `${basePath()}.sock`;
    process.kill(pid, "SIGKILL");
    await waitUntil(() => !alive(pid), "the kill");
    rmSync(socketPath, { force: true });

    const frames = ["null\n", "7\n"];
    const impostor = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        const { id } = JSON.parse(chunk) as { id: number };
        const bad = frames.shift();
        connection.write(bad ?? `{}\n{"progress":true}\n${JSON.stringify({ id, ok: true, value: 5 })}\n`);
      });
    });
    await new Promise<void>((settle) => impostor.listen(socketPath, () => settle()));
    try {
      await expect(client().countTokens(SPEC, "x")).resolves.toBe(5);
    } finally {
      impostor.close();
    }
  }, 60_000);

  it("a frame that is not an object closes that connection and leaves the host running", async () => {
    const host = client();
    const pid = await hostPid(host);
    await new Promise<void>((settle) => {
      const raw = connect(`${basePath()}.sock`, () => raw.write("null\n"));
      raw.on("close", () => settle());
    });
    expect(await hostPid(host)).toBe(pid);
  }, 60_000);

  it("vectors and text cross the channel byte for byte", async () => {
    const host = client();
    started.add(await hostPid(host));

    // NaN payload, infinity, negative zero, a subnormal, one: every value a number array in JSON
    // would change or drop. Validation downstream relies on seeing a NaN as a NaN.
    const exact = await host.embed(SPEC, "__exact__");
    expect(exact).toBeInstanceOf(Float32Array);
    expect(Array.from(new Uint32Array(exact.buffer))).toEqual([0x7fc00001, 0x7f800000, 0x80000000, 0x00000001, 0x3f800000]);

    for (const text of ["기억을 저장한다", "emoji 🧠 mix", "line\nbreak\r\n", "lone \ud800 surrogate", "sep arator", ""]) {
      const echoed = await host.embed(SPEC, text);
      const codeUnits = Array.from(echoed.subarray(1));
      expect(codeUnits).toEqual(Array.from(text, (_, index) => text.charCodeAt(index)).slice(0, 64));
    }
  }, 60_000);

  it("a frame larger than one socket read arrives whole", async () => {
    const host = client();
    started.add(await hostPid(host));
    const text = "한".repeat(800_000);
    await expect(host.countTokens(SPEC, text)).resolves.toBe(text.length);
  }, 60_000);

  it("a model error reaches the caller as itself, and the channel keeps working", async () => {
    const host = client();
    const pid = await hostPid(host);
    await expect(host.embed(SPEC, "__fail__")).rejects.toThrow("injected model failure");
    expect(await hostPid(host)).toBe(pid);
  }, 60_000);

  it("garbage on one connection closes that connection and nothing else", async () => {
    const host = client();
    const pid = await hostPid(host);
    const socketPath = `${basePath()}.sock`;

    const closed = await new Promise<boolean>((settle) => {
      const raw = connect(socketPath, () => raw.write("this is not json\n"));
      raw.on("close", () => settle(true));
      raw.on("error", () => settle(true));
    });
    expect(closed).toBe(true);

    // The middle case: a frame cut off by a client that went away, with no newline ever arriving.
    await new Promise<void>((settle) => {
      const raw = connect(socketPath, () => raw.end('{"id":1,"op":"embed"'));
      raw.on("close", () => settle());
    });
    const unknown = await new Promise<string>((settle) => {
      const raw = connect(socketPath, () => raw.write('{"id":7,"op":"steal","spec":{}}\n'));
      raw.setEncoding("utf8");
      raw.once("data", (chunk: string) => {
        raw.destroy();
        settle(chunk);
      });
    });
    expect(JSON.parse(unknown)).toMatchObject({ id: 7, ok: false });

    expect(await hostPid(host)).toBe(pid);
  }, 60_000);

  it("a process with only a pending call waits for the answer and then ends by itself", () => {
    const result = spawnSync(process.execPath, ["--import", TSX, CLIENT_ONCE, FIXTURE, runtimeDir, TSX], {
      encoding: "utf8",
      timeout: 30_000,
    });
    for (const pid of winners()) started.add(pid);

    expect(result.stdout).toContain("answered");
    expect(result.status).toBe(0);
    // Ended by itself rather than by the timeout: the idle connection did not hold it open.
    expect(result.signal).toBeNull();
  }, 60_000);

  it("hands the host the cache this session resolved, since it runs from another directory", async () => {
    const prior = process.env.MONET_MODEL_CACHE;
    process.env.MONET_MODEL_CACHE = "relative/cache";
    try {
      started.add(await hostPid(client()));
      expect(readFileSync(`${basePath()}.cache`, "utf8")).toBe(resolve("relative/cache"));
    } finally {
      if (prior === undefined) delete process.env.MONET_MODEL_CACHE;
      else process.env.MONET_MODEL_CACHE = prior;
    }
  }, 60_000);

  it("different releases do not share a host", async () => {
    const [one, two] = await Promise.all([hostPid(client({ version: "1" })), hostPid(client({ version: "2" }))]);
    expect(one).not.toBe(two);
  }, 60_000);

  describe("privacy of the runtime directory", () => {
    it("is created for this user alone, and so is everything reachable through it", async () => {
      const host = client();
      started.add(await hostPid(host));
      expect(lstatSync(runtimeDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(`${basePath()}.log`).mode & 0o077).toBe(0);
    }, 60_000);

    it("is tightened when it already exists with looser permissions", async () => {
      mkdirSync(runtimeDir, { recursive: true });
      chmodSync(runtimeDir, 0o755);
      const host = client();
      started.add(await hostPid(host));
      expect(lstatSync(runtimeDir).mode & 0o777).toBe(0o700);
    }, 60_000);

    it("refuses a directory whose mode cannot be tightened, as on a filesystem that ignores chmod", async () => {
      // The middle case between private and refused: it exists, it is ours, and the fix silently did
      // nothing. A Windows drive mounted into WSL behaves like this, so the check has to re-read.
      mkdirSync(runtimeDir, { recursive: true });
      chmodSync(runtimeDir, 0o755);
      fsBehaviour.chmodDoesNothing = true;
      try {
        const fallback: ModelHost = {
          embed: async () => Float32Array.of(4),
          countTokens: async () => 0,
          inputWindow: async () => null,
        };
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(client({ createFallback: () => fallback }).embed(SPEC, "x")).resolves.toEqual(Float32Array.of(4));
        expect(stderr.mock.calls.flat().join(" ")).toContain("not a directory only this user can reach");
      } finally {
        fsBehaviour.chmodDoesNothing = false;
      }
    });

    it("refuses a symlink, and the session keeps working on its own copy", async () => {
      const real = join(dir, "elsewhere");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, runtimeDir);
      const fallback: ModelHost = {
        embed: async () => Float32Array.of(5),
        countTokens: async () => 0,
        inputWindow: async () => null,
      };
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client({ createFallback: () => fallback }).embed(SPEC, "x")).resolves.toEqual(Float32Array.of(5));
      expect(stderr.mock.calls.flat().join(" ")).toContain("not a directory only this user can reach");
      expect(readdirSync(real)).toEqual([]);
    });

    it("a socket path too long for the platform falls back rather than failing", async () => {
      const fallback: ModelHost = {
        embed: async () => Float32Array.of(6),
        countTokens: async () => 0,
        inputWindow: async () => null,
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deep = join(dir, "x".repeat(120));
      await expect(client({ runtimeDir: deep, createFallback: () => fallback }).embed(SPEC, "x")).resolves.toEqual(
        Float32Array.of(6),
      );
      expect(existsSync(deep)).toBe(false);
    });

    it("native Windows stays on a private copy until a private channel exists there", async () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const fallback: ModelHost = {
          embed: async () => Float32Array.of(3),
          countTokens: async () => 0,
          inputWindow: async () => null,
        };
        vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(client({ createFallback: () => fallback }).embed(SPEC, "x")).resolves.toEqual(Float32Array.of(3));
        expect(existsSync(runtimeDir)).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });
  });
});

describe("LocalModelHost", () => {
  beforeEach(() => {
    pipelineLoads.count = 0;
    pipelineLoads.fail = false;
  });

  it("does not stay broken after a failed load", async () => {
    const host = new LocalModelHost();
    pipelineLoads.fail = true;
    await expect(host.embed({ model: DEFAULT_MODEL, pooling: "cls" }, "x")).rejects.toThrow("injected download failure");
    pipelineLoads.fail = false;
    await expect(host.embed({ model: DEFAULT_MODEL, pooling: "cls" }, "x")).resolves.toBeInstanceOf(Float32Array);
  });

  it("holds one loaded model per spec", async () => {
    const host = new LocalModelHost();
    await host.embed({ model: DEFAULT_MODEL, pooling: "cls" }, "a");
    await host.embed({ model: DEFAULT_MODEL, pooling: "cls" }, "b");
    expect(pipelineLoads.count).toBe(1);
  });
});

describe("the provider's seam", () => {
  function recordingHost(): ModelHost & { calls: Array<[string, ModelSpec, string?]> } {
    const calls: Array<[string, ModelSpec, string?]> = [];
    const width = new OnnxEmbeddingProvider().dim;
    return {
      calls,
      embed: async (spec, text) => {
        calls.push(["embed", spec, text]);
        const vector = new Float32Array(width);
        vector[0] = 1;
        return vector;
      },
      countTokens: async (spec, text) => {
        calls.push(["countTokens", spec, text]);
        return 11;
      },
      inputWindow: async (spec) => {
        calls.push(["inputWindow", spec]);
        return 512;
      },
    };
  }

  beforeEach(() => {
    pipelineLoads.count = 0;
  });

  it("describes the same space with or without a host, and loads nothing in this process", async () => {
    const host = recordingHost();
    const hosted = new OnnxEmbeddingProvider({ modelHost: host });
    const plain = new OnnxEmbeddingProvider();

    expect(hosted.modelId).toBe(plain.modelId);
    expect(hosted.dim).toBe(plain.dim);
    expect(hosted.recommendedThresholds).toEqual(plain.recommendedThresholds);
    expect(hosted.reliableSegmentTokens).toBe(plain.reliableSegmentTokens);
    expect(hosted.nativeScoreFloor).toBe(plain.nativeScoreFloor);
    expect(hosted.readsOnlyLatinScript).toBe(plain.readsOnlyLatinScript);

    await hosted.embed("text");
    await expect(hosted.countTokens("text")).resolves.toBe(11);
    await expect(hosted.inputWindow()).resolves.toBe(512);
    expect(host.calls.map(([op]) => op)).toEqual(["embed", "countTokens", "inputWindow"]);
    expect(pipelineLoads.count).toBe(0);
  });

  it("leaves a local-path model in this process, where its relative path means what it says", async () => {
    const host = recordingHost();
    const provider = new OnnxEmbeddingProvider({ model: "./models/foo", modelHost: host });
    await provider.embed("text");
    expect(host.calls).toEqual([]);
    expect(pipelineLoads.count).toBe(1);
  });

  it("a pin loads through the host and keeps its identity", async () => {
    const host = recordingHost();
    const provider = await instantiateEmbedderForPin(DEFAULT_MODEL, { modelHost: host });
    expect(provider.modelId).toBe(DEFAULT_MODEL);
    expect(host.calls[0]?.[0]).toBe("embed");
    expect(pipelineLoads.count).toBe(0);
  });

  it("a store pinned through a host stays pinned, and a host that cannot serve it is refused", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "msm-pin-"));
    try {
      const dbPath = join(dir, "monet.db");
      const seeded = new MonetCore(dbPath, { embedder: new OnnxEmbeddingProvider({ modelHost: recordingHost() }) });
      await seeded.store("content that gives this store vectors in the pinned space");
      seeded.close();
      expect(readStoredEmbedderPin(dbPath)).toBe(DEFAULT_MODEL);

      const reopened = await chooseStoreEmbedder(dbPath, { modelHost: recordingHost() });
      expect(reopened.modelId).toBe(DEFAULT_MODEL);

      const broken: ModelHost = {
        embed: async () => {
          throw new Error("host down");
        },
        countTokens: async () => 0,
        inputWindow: async () => null,
      };
      await expect(instantiateEmbedderForPin(DEFAULT_MODEL, { modelHost: broken })).rejects.toBeInstanceOf(
        UnsatisfiableEmbedderError,
      );
      await expect(chooseStoreEmbedder(dbPath, { modelHost: broken })).rejects.toBeInstanceOf(
        PinnedStoreEmbedderUnavailableError,
      );
      expect(readStoredEmbedderPin(dbPath)).toBe(DEFAULT_MODEL);
      expect(pipelineLoads.count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("a channel failure is not a load failure", () => {
    const unreachable: ModelHost = {
      embed: async () => {
        throw new SharedModelUnavailableError("the model process went away during a call", "the.log");
      },
      countTokens: async () => 0,
      inputWindow: async () => null,
    };

    it("leaves an empty pinned store's pin alone, where a load failure would re-pin it for good", async () => {
      const dir = mkdtempSync(join(realpathSync(tmpdir()), "msm-pin-"));
      try {
        const dbPath = join(dir, "monet.db");
        // Pinned, and no vectors: every new store is in this state until its first write.
        const seeded = new MonetCore(dbPath, { embedder: new OnnxEmbeddingProvider({ modelHost: recordingHost() }) });
        await seeded.ensureEmbedderPin();
        seeded.close();
        expect(readStoredEmbedderPin(dbPath)).toBe(DEFAULT_MODEL);

        await expect(chooseStoreEmbedder(dbPath, { modelHost: unreachable })).rejects.toBeInstanceOf(
          SharedModelUnavailableError,
        );
        expect(readStoredEmbedderPin(dbPath)).toBe(DEFAULT_MODEL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reaches a store with vectors as itself, not as advice to rewrite the store", async () => {
      // `PinnedStoreEmbedderUnavailableError` tells the reader to run a one-way migration, which is
      // wrong advice for a process that will probably be back on the next attempt.
      const dir = mkdtempSync(join(realpathSync(tmpdir()), "msm-pin-"));
      try {
        const dbPath = join(dir, "monet.db");
        const seeded = new MonetCore(dbPath, { embedder: new OnnxEmbeddingProvider({ modelHost: recordingHost() }) });
        await seeded.store("content that gives this store vectors in the pinned space");
        seeded.close();

        await expect(instantiateEmbedderForPin(DEFAULT_MODEL, { modelHost: unreachable })).rejects.toBeInstanceOf(
          SharedModelUnavailableError,
        );
        const failure = await chooseStoreEmbedder(dbPath, { modelHost: unreachable }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SharedModelUnavailableError);
        expect((failure as Error).message).not.toContain("monet repair");
        expect(readStoredEmbedderPin(dbPath)).toBe(DEFAULT_MODEL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("never selects the lexical embedder", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(createLocalEmbedderWithProvenance({ modelHost: unreachable })).rejects.toBeInstanceOf(
        SharedModelUnavailableError,
      );
    });

    it("still lets a real load failure take the path it always took", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const failing: ModelHost = {
        ...unreachable,
        embed: async () => {
          throw new Error("the model files are corrupt");
        },
      };
      const selected = await createLocalEmbedderWithProvenance({ modelHost: failing });
      expect(selected.selection).toBe("implicit-hashing-fallback");
    });
  });
});

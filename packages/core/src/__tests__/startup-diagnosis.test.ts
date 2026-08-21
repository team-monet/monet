/**
 * The startup failure record (#13) — a server that dies before the transport connects still has to
 * say why.
 *
 * WHAT THESE TESTS ARE ABOUT, and it is not "startup works" or "startup fails". Both ends of that
 * range were already covered by the existing suites and neither is where the diagnosis is hard. The
 * hard cases are the MIDDLE ones: a step that fails with the process already half-alive, and a
 * failure on the far side of the protocol boundary. Those are the two a single `Connection closed`
 * flattens together, and they are what this file pins.
 *
 * No test here connects a real StdioServerTransport: every factory call is one that rejects BEFORE
 * `new StdioServerTransport()` is reached (the same property the pin choke-point test in
 * embedder-pin.test.ts relies on), so nothing in this file can seize the test runner's own stdio.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { UnsatisfiableEmbedderError } from "../embedding-onnx";
import { createMonetCoreMcpServer } from "../mcp-server";
import {
  STARTUP_FAILURE_FILENAME,
  STARTUP_FAILURE_FORMAT,
  inStartupPhase,
  markStartupPhase,
  readStartupFailure,
  recordStartupFailure,
  startupFailurePath,
  startupPhaseOf,
} from "../startup-diagnosis";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "monet-startup-diagnosis-"));
}

/** White-box pin writes, matching embedder-pin.test.ts's own established convention. */
function writePin(core: MonetCore, modelId: string): void {
  (core as any).db
    .prepare(`UPDATE sync_meta SET embedder_model_id = ?, embedder_pin_source = ?, embedder_pinned_at = ? WHERE singleton = 1`)
    .run(modelId, "backfilled", Date.now());
}

function insertFakeObservation(core: MonetCore, dim: number): void {
  (core as any).db
    .prepare(`INSERT INTO observations (id, content, embedding, author_agent_id, kind, concept_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("fake-obs", "legacy content", JSON.stringify(new Array(dim).fill(0.01)), "legacy-agent", "statement", null);
}

describe("startup phase tagging", () => {
  it("tags the error object itself, so every downstream instanceof check still holds", () => {
    const error = new UnsatisfiableEmbedderError("some/model", "not cached");
    const returned = markStartupPhase(error, "embedder-selection");

    expect(returned).toBe(error); // the SAME object, never a wrapper
    expect(returned).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect(startupPhaseOf(error)).toBe("embedder-selection");
  });

  it("the tag is invisible to every ordinary view of the error", () => {
    // The entry points' existing handlers print and serialize these errors. A tag that showed up in
    // JSON.stringify or Object.keys would change output nobody asked to change.
    const error = markStartupPhase(new Error("boom"), "store-open");
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify({ ...error })).toBe("{}");
  });

  it("INNERMOST wins: an outer boundary never overwrites the specific phase with its own", async () => {
    // openServedCore's shape: a store-open failure inside a wider region that also tags. The
    // specific answer must survive, because "store-open" is actionable and the outer one is not.
    const error = new Error("database is locked");
    await expect(
      inStartupPhase("post-connect", async () => {
        await inStartupPhase("store-open", () => {
          throw error;
        });
      }),
    ).rejects.toBe(error);
    expect(startupPhaseOf(error)).toBe("store-open");
  });

  it("a non-object throw carries no tag and is returned untouched", () => {
    expect(markStartupPhase("just a string", "store-open")).toBe("just a string");
    expect(startupPhaseOf("just a string")).toBeNull();
    expect(startupPhaseOf(undefined)).toBeNull();
  });

  it("a frozen error costs a phase, never the error: tagging fails silently and the original still propagates", async () => {
    // This tagging runs inside a catch that is on its way to rethrowing. A TypeError raised here
    // would REPLACE the startup fault with a complaint about a property nobody asked for — the
    // instrument destroying the fault it exists to describe.
    const frozen = Object.freeze(new Error("unfreezable"));
    expect(() => markStartupPhase(frozen, "store-open")).not.toThrow();
    expect(startupPhaseOf(frozen)).toBeNull(); // honestly untagged → recorded as "unknown"
    await expect(
      inStartupPhase("store-open", () => {
        throw frozen;
      }),
    ).rejects.toBe(frozen);
  });

  it("inStartupPhase passes a success straight through, sync or async", async () => {
    await expect(inStartupPhase("store-open", () => 41 + 1)).resolves.toBe(42);
    await expect(inStartupPhase("store-open", async () => "ok")).resolves.toBe("ok");
  });
});

describe("the startup failure record", () => {
  it("records the tagged phase, the store, and the error's own code", () => {
    const dir = tempDir();
    try {
      const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      markStartupPhase(error, "store-open");

      const written = recordStartupFailure({ dir, store: join(dir, "monet.db"), error });
      expect(written).toBe(join(dir, STARTUP_FAILURE_FILENAME));

      const read = readStartupFailure(dir);
      expect(read.status).toBe("found");
      if (read.status !== "found") return;
      expect(read.record).toMatchObject({
        v: STARTUP_FAILURE_FORMAT,
        phase: "store-open",
        pid: process.pid,
        store: join(dir, "monet.db"),
        error: { name: "Error", message: "database is locked", code: "SQLITE_BUSY" },
      });
      expect(typeof read.record.at).toBe("string");
      expect(read.record.stack).toContain("database is locked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fallback phase applies ONLY to an untagged error — a tag always wins", () => {
    const dir = tempDir();
    try {
      // The post-connect case: the entry point knows the transport went live, so an untagged
      // failure after that point is post-connect, not unknown.
      recordStartupFailure({ dir, store: "s", error: new Error("late"), fallbackPhase: "post-connect" });
      const untagged = readStartupFailure(dir);
      expect(untagged.status === "found" && untagged.record.phase).toBe("post-connect");

      // But a boundary that already claimed the throw is more specific than the caller's guess.
      const tagged = markStartupPhase(new Error("early"), "embedder-pin");
      recordStartupFailure({ dir, store: "s", error: tagged, fallbackPhase: "post-connect" });
      const after = readStartupFailure(dir);
      expect(after.status === "found" && after.record.phase).toBe("embedder-pin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unclaimed throw is recorded as 'unknown' rather than guessed into a phase", () => {
    const dir = tempDir();
    try {
      recordStartupFailure({ dir, store: "s", error: "a bare string throw" });
      const read = readStartupFailure(dir);
      expect(read.status === "found" && read.record.phase).toBe("unknown");
      expect(read.status === "found" && read.record.error.message).toBe("a bare string throw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the most recent failure — a record is a diagnosis, not a log", () => {
    const dir = tempDir();
    try {
      recordStartupFailure({ dir, store: "s", error: new Error("first") });
      recordStartupFailure({ dir, store: "s", error: new Error("second") });
      const read = readStartupFailure(dir);
      expect(read.status === "found" && read.record.error.message).toBe("second");
      expect(readFileSync(startupFailurePath(dir), "utf8").trimEnd().split("\n").at(-1)).toBe("}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never masks the failure it is recording: an unwritable location returns null and throws nothing", () => {
    const dir = tempDir();
    const notADirectory = join(dir, "occupied");
    try {
      // A FILE where the directory should be: mkdirSync, openSync and renameSync all fail against
      // it. The contract is that recordStartupFailure absorbs that and reports by returning null —
      // a second exception here would replace the original startup fault with an I/O one, which is
      // the failure mode that makes instrumentation worse than none.
      writeFileSync(notADirectory, "not a directory");
      expect(recordStartupFailure({ dir: notADirectory, store: "s", error: new Error("original") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temp file behind after a successful write", () => {
    const dir = tempDir();
    try {
      recordStartupFailure({ dir, store: "s", error: new Error("boom") });
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(readdirSync(dir)).toEqual([STARTUP_FAILURE_FILENAME]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reading the record distinguishes absence from illegibility", () => {
  it("no file at all is 'none' — silence is the healthy state", () => {
    const dir = tempDir();
    try {
      expect(readStartupFailure(dir)).toEqual({ status: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file that cannot be parsed is 'unreadable', never folded into 'none'", () => {
    const dir = tempDir();
    try {
      writeFileSync(startupFailurePath(dir), "{ this is not json");
      const read = readStartupFailure(dir);
      expect(read.status).toBe("unreadable");
      expect(read.status === "unreadable" && read.reason).toBe("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a record from a format this build does not know is 'unreadable', not silently trusted", () => {
    const dir = tempDir();
    try {
      writeFileSync(startupFailurePath(dir), JSON.stringify({ v: STARTUP_FAILURE_FORMAT + 1, at: "now", error: {} }));
      const read = readStartupFailure(dir);
      expect(read.status === "unreadable" && read.reason).toContain("unsupported record format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── THE MIDDLE CASES ─────────────────────────────────────────────────────────────────────────────

describe("MIDDLE CASE: a step that fails with the store already open", () => {
  it("an unsatisfiable pin fails INSIDE the factory, and is recorded as 'embedder-pin' — not as the store open that already succeeded", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet.db");
    try {
      // Partial init, for real: this constructor runs the whole SQLite open, WAL setup, init() and
      // every migration. By the time the factory is entered the process is half-alive — a store on
      // disk with a schema in it — which is exactly the state a bare `Connection closed` cannot
      // distinguish from "it never opened anything".
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      insertFakeObservation(core, 256); // non-empty: the empty-store recovery path must not apply
      writePin(core, "hashing:dim=256:tok=99"); // a pin the live embedder cannot satisfy

      const schemaVersion = new Database(dbPath, { readonly: true });
      expect(schemaVersion.pragma("user_version", { simple: true })).not.toBe(0); // the store IS initialized
      schemaVersion.close();

      let caught: unknown;
      try {
        // Rejects at core.ensureEmbedderPin(), before `new StdioServerTransport()` — see this
        // file's header, and embedder-pin.test.ts's own choke-point test.
        await createMonetCoreMcpServer(core);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
      expect(startupPhaseOf(caught)).toBe("embedder-pin");

      // And what the user is left holding names that step, rather than the whole of startup.
      const written = recordStartupFailure({ dir, store: dbPath, error: caught });
      expect(written).not.toBeNull();
      const read = readStartupFailure(dir);
      expect(read.status === "found" && read.record.phase).toBe("embedder-pin");
      expect(read.status === "found" && read.record.error.name).toBe("UnsatisfiableEmbedderError");
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MIDDLE CASE: a failure on the far side of the protocol boundary", () => {
  /*
   * WHAT IS AND IS NOT PROVEN HERE, stated rather than implied.
   *
   * The factory tracks whether `server.connect()` returned and tags accordingly, so a post-connect
   * throw can never be reported as a failure to connect. That branch is NOT exercised end-to-end,
   * because in the current wiring nothing between `await server.connect(transport)` and the
   * factory's return can throw: the one statement there is settleGracefulShutdownOnExplicitClose,
   * which only rebinds server.close. Forcing it would mean faking the transport, and a test that
   * has to break the code to reach a branch proves the fake, not the code.
   *
   * What IS reachable and does matter is the entry points' half of the same boundary: after the
   * factory returns, the transport is live and the process keeps running, and every entry point
   * carries a flag saying so. This is that contract.
   */
  it("a failure once the transport is live is recorded as 'post-connect', never flattened into 'unknown'", () => {
    const dir = tempDir();
    try {
      const beforeConnect = recordStartupFailure({
        dir,
        store: "s",
        error: new Error("died"),
        fallbackPhase: "unknown", // what an entry point passes before the factory returns
      });
      expect(beforeConnect).not.toBeNull();
      const before = readStartupFailure(dir);
      expect(before.status === "found" && before.record.phase).toBe("unknown");

      recordStartupFailure({
        dir,
        store: "s",
        error: new Error("died"),
        fallbackPhase: "post-connect", // what it passes once createMonetCoreMcpServer has returned
      });
      const after = readStartupFailure(dir);
      expect(after.status === "found" && after.record.phase).toBe("post-connect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the factory's own post-connect branch is wired to the connected flag, not to where the throw came from", () => {
    // A source check, deliberately — see this describe block's own comment for why the branch has
    // no reachable runtime trigger today. What this guards is that the branch cannot silently
    // regress into reporting every factory failure as a transport-connect failure.
    const source = readFileSync(join(import.meta.dirname, "../mcp-server.ts"), "utf8");
    expect(source).toContain("let transportConnected = false;");
    expect(source).toContain('markStartupPhase(error, transportConnected ? "post-connect" : "transport-connect")');
  });
});

describe("the record's location is the one a reader can find from the store alone", () => {
  it("sits beside the store file, under the documented filename", () => {
    const dir = tempDir();
    try {
      expect(startupFailurePath(dir)).toBe(join(dir, "startup-failure.json"));
      expect(STARTUP_FAILURE_FILENAME).toBe("startup-failure.json");
      recordStartupFailure({ dir, store: join(dir, "monet.db"), error: new Error("x") });
      expect(existsSync(join(dir, "startup-failure.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

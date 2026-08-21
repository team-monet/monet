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
 * The second half of the file is the round-1 review's findings, each with the property it broke
 * stated in its own name: a record must belong to exactly one database, must never throw out of the
 * recorder, must never be published half-written or out of order, and must never be presented as a
 * verdict when it is only a fragment.
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
  STARTUP_FAILURE_FORMAT,
  STARTUP_FAILURE_SUFFIX,
  inStartupPhase,
  markStartupPhase,
  readStartupFailure,
  recordStartupFailure,
  startupFailurePath,
  startupPhaseOf,
  type StartupFailureRecord,
} from "../startup-diagnosis";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "monet-startup-diagnosis-"));
}

/** The store a record is about. Every API in this module is keyed on this, never on its directory. */
function storeIn(dir: string, name = "monet.db"): string {
  return join(dir, name);
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

/** A whole, valid record, as the writer produces one — for tests that then break exactly one field. */
function validRecord(store: string): StartupFailureRecord {
  return {
    v: STARTUP_FAILURE_FORMAT,
    at: "2026-08-21T00:00:00.000Z",
    pid: 4242,
    phase: "store-open",
    store,
    error: { name: "SqliteError", message: "database is locked", code: "SQLITE_BUSY" },
    stack: "SqliteError: database is locked\n    at ...",
  };
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
    const store = storeIn(dir);
    try {
      const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      markStartupPhase(error, "store-open");

      const written = recordStartupFailure({ store, error });
      expect(written).toBe(startupFailurePath(store));

      const read = readStartupFailure(store);
      expect(read.status).toBe("found");
      if (read.status !== "found") return;
      expect(read.record).toMatchObject({
        v: STARTUP_FAILURE_FORMAT,
        phase: "store-open",
        pid: process.pid,
        store,
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
    const store = storeIn(dir);
    try {
      // The post-connect case: the entry point knows the transport went live, so an untagged
      // failure after that point is post-connect, not unknown.
      recordStartupFailure({ store, error: new Error("late"), fallbackPhase: "post-connect" });
      const untagged = readStartupFailure(store);
      expect(untagged.status === "found" && untagged.record.phase).toBe("post-connect");

      // But a boundary that already claimed the throw is more specific than the caller's guess.
      const tagged = markStartupPhase(new Error("early"), "embedder-pin");
      recordStartupFailure({ store, error: tagged, fallbackPhase: "post-connect" });
      const after = readStartupFailure(store);
      expect(after.status === "found" && after.record.phase).toBe("embedder-pin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unclaimed throw is recorded as 'unknown' rather than guessed into a phase", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      recordStartupFailure({ store, error: "a bare string throw" });
      const read = readStartupFailure(store);
      expect(read.status === "found" && read.record.phase).toBe("unknown");
      expect(read.status === "found" && read.record.error.message).toBe("a bare string throw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the most recent failure — a record is a diagnosis, not a log", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      recordStartupFailure({ store, error: new Error("first") });
      recordStartupFailure({ store, error: new Error("second") });
      const read = readStartupFailure(store);
      expect(read.status === "found" && read.record.error.message).toBe("second");
      expect(readFileSync(startupFailurePath(store), "utf8").trimEnd().split("\n").at(-1)).toBe("}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never masks the failure it is recording: an unwritable location returns null and throws nothing", () => {
    const dir = tempDir();
    try {
      // A FILE where the directory should be: mkdirSync, openSync and renameSync all fail against
      // it. The contract is that recordStartupFailure absorbs that and reports by returning null —
      // a second exception here would replace the original startup fault with an I/O one, which is
      // the failure mode that makes instrumentation worse than none.
      writeFileSync(join(dir, "occupied"), "not a directory");
      const store = join(dir, "occupied", "monet.db");
      expect(recordStartupFailure({ store, error: new Error("original") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temp file behind after a successful write", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      recordStartupFailure({ store, error: new Error("boom") });
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(readdirSync(dir)).toEqual([`monet.db${STARTUP_FAILURE_SUFFIX}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reading the record distinguishes absence from illegibility", () => {
  it("no file at all is 'none' — silence is the healthy state", () => {
    const dir = tempDir();
    try {
      expect(readStartupFailure(storeIn(dir))).toEqual({ status: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file that cannot be parsed is 'unreadable', never folded into 'none'", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      writeFileSync(startupFailurePath(store), "{ this is not json");
      const read = readStartupFailure(store);
      expect(read.status).toBe("unreadable");
      expect(read.status === "unreadable" && read.reason).toBe("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a record from a format this build does not know is 'unreadable', not silently trusted", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      writeFileSync(startupFailurePath(store), JSON.stringify({ ...validRecord(store), v: STARTUP_FAILURE_FORMAT + 1 }));
      const read = readStartupFailure(store);
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
    const dbPath = storeIn(dir);
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
      expect(recordStartupFailure({ store: dbPath, error: caught })).not.toBeNull();
      const read = readStartupFailure(dbPath);
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
    const store = storeIn(dir);
    try {
      recordStartupFailure({ store, error: new Error("died"), fallbackPhase: "unknown" });
      const before = readStartupFailure(store);
      expect(before.status === "found" && before.record.phase).toBe("unknown");

      recordStartupFailure({ store, error: new Error("died"), fallbackPhase: "post-connect" });
      const after = readStartupFailure(store);
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

// ── ROUND 1 REVIEW (PR #79): properties the first cut of this machinery did not hold ──────────────

describe("a record belongs to exactly ONE database", () => {
  it("two stores in one directory keep two records — neither can overwrite or be mistaken for the other", () => {
    // THE DEFECT THIS FIXES, reproduced: a `.monet` directory routinely holds the shipped CLI's
    // `monet.db` AND core's own dev-server `monet-core.db`. With one record per DIRECTORY, the dev
    // server's failure landed in the shipped server's record — and a reader asking about a
    // perfectly healthy `monet.db` was handed the other file's error as its own.
    const dir = tempDir();
    const shipped = storeIn(dir, "monet.db");
    const dev = storeIn(dir, "monet-core.db");
    try {
      recordStartupFailure({ store: dev, error: new Error("the DEV server's failure") });
      expect(readStartupFailure(shipped)).toEqual({ status: "none" }); // the healthy store says nothing

      recordStartupFailure({ store: shipped, error: new Error("the SHIPPED server's failure") });
      const devRead = readStartupFailure(dev);
      const shippedRead = readStartupFailure(shipped);
      expect(devRead.status === "found" && devRead.record.error.message).toBe("the DEV server's failure");
      expect(shippedRead.status === "found" && shippedRead.record.error.message).toBe("the SHIPPED server's failure");

      // Two files, each named after its own database, both still present.
      expect(readdirSync(dir).sort()).toEqual(
        [`monet-core.db${STARTUP_FAILURE_SUFFIX}`, `monet.db${STARTUP_FAILURE_SUFFIX}`].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the path is derived from the store, so the record's location and its `store` field cannot disagree", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      expect(startupFailurePath(store)).toBe(join(dir, `monet.db${STARTUP_FAILURE_SUFFIX}`));
      recordStartupFailure({ store, error: new Error("x") });
      const read = readStartupFailure(store);
      expect(read.status === "found" && read.record.store).toBe(store);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the recorder is TOTAL — it can never replace the fault it was called to record", () => {
  it("an error whose fields throw when read is absorbed, not re-thrown", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      const poisoned = new Error("unreadable");
      Object.defineProperty(poisoned, "message", {
        get() {
          throw new TypeError("poisoned getter");
        },
      });
      // Before this fix the getter fired outside the try and escaped, so the LAST thing a dying
      // startup did was throw a TypeError about a property nobody asked for — losing the original
      // error in the one code path that exists to preserve it.
      let result: string | null | undefined;
      expect(() => {
        result = recordStartupFailure({ store, error: poisoned });
      }).not.toThrow();
      expect(result).toBeNull(); // nothing describable to write; reported by returning, never by throwing
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throw that cannot even be converted to a string is absorbed", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      // `String(Object.create(null))` throws — a null-prototype object has no toString.
      let result: string | null | undefined;
      expect(() => {
        result = recordStartupFailure({ store, error: Object.create(null) });
      }).not.toThrow();
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a store path that is not a usable path is absorbed too", () => {
    // The path arithmetic that decides WHERE the record goes is inside the try for the same reason
    // the field reads are: it runs on a failure path that is already reporting something else.
    expect(() => recordStartupFailure({ store: undefined as unknown as string, error: new Error("x") })).not.toThrow();
    expect(recordStartupFailure({ store: undefined as unknown as string, error: new Error("x") })).toBeNull();
  });
});

describe("a published record is whole, and never older than the one it replaces", () => {
  it("a record far larger than one write is written in full, not truncated", () => {
    // fs.writeSync does not loop — measured: asked for 1 MiB against a bounded pipe, it returned
    // 8192. The writer must therefore loop itself, and a payload well past a page proves the loop
    // rather than a single lucky write.
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      const error = new Error("x".repeat(3900));
      error.stack = `Error: big\n${"    at somewhere::deep::in::the::stack\n".repeat(200)}`;
      const written = recordStartupFailure({ store, error });
      expect(written).not.toBeNull();

      const raw = readFileSync(startupFailurePath(store), "utf8");
      expect(raw.length).toBeGreaterThan(8192); // past a single pipe-buffer write, and past a page
      expect(raw.endsWith("}\n")).toBe(true); // whole, not cut off
      const read = readStartupFailure(store);
      expect(read.status).toBe("found");
      if (read.status !== "found") return;
      expect(read.record.error.message.startsWith("xxx")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an OLDER record never buries a NEWER one — the losing writer leaves the newer diagnosis in place", () => {
    // TWO SERVERS FAILING AGAINST ONE STORE IS THE ORDINARY SHAPE, not an exotic one: a contended
    // store means a second process by definition, and a host retrying a failed connection makes
    // overlapping startups routine. `renameSync` replaces whatever is at the destination, so the
    // SLOWER writer's older record used to land last and bury the newer one — in exactly the
    // scenario the record exists to explain. The injected clock is what makes the ordering
    // deterministic here instead of a race the test would have to hope for.
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      const newer = new Date("2026-08-21T12:00:00.000Z");
      const older = new Date("2026-08-21T11:00:00.000Z");

      expect(recordStartupFailure({ store, error: new Error("the NEWER failure"), now: () => newer })).not.toBeNull();
      // The straggler: same store, an older instant, publishing second.
      const stragglerPath = recordStartupFailure({ store, error: new Error("the OLDER failure"), now: () => older });

      const read = readStartupFailure(store);
      expect(read.status === "found" && read.record.error.message).toBe("the NEWER failure");
      expect(read.status === "found" && read.record.at).toBe(newer.toISOString());
      // It still returns the path: the file holds the most recent startup diagnosis, which is what
      // the caller's pointer line directs a reader to. It just is not this process's copy.
      expect(stragglerPath).toBe(startupFailurePath(store));
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]); // no litter left behind
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an equally-timed or newer record still publishes — only a strictly newer one blocks", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      const at = new Date("2026-08-21T12:00:00.000Z");
      recordStartupFailure({ store, error: new Error("first"), now: () => at });
      recordStartupFailure({ store, error: new Error("same instant"), now: () => at });
      const same = readStartupFailure(store);
      expect(same.status === "found" && same.record.error.message).toBe("same instant");

      recordStartupFailure({ store, error: new Error("later"), now: () => new Date("2026-08-21T12:00:01.000Z") });
      const later = readStartupFailure(store);
      expect(later.status === "found" && later.record.error.message).toBe("later");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable destination does not block a new record — absence of evidence is not evidence of a newer one", () => {
    // Otherwise one corrupt file would wedge the mechanism permanently, and every later startup
    // failure would go unrecorded because of a byte that could not be parsed.
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      writeFileSync(startupFailurePath(store), "{ truncated");
      recordStartupFailure({ store, error: new Error("a real failure") });
      const read = readStartupFailure(store);
      expect(read.status === "found" && read.record.error.message).toBe("a real failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a fragment is never presented as a verdict", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["at", { at: 17 }],
    ["pid", { pid: undefined }],
    ["phase", { phase: undefined }],
    ["phase", { phase: "a phase this build has never heard of" }],
    ["store", { store: undefined }],
    ["stack", { stack: 42 }],
    ["error", { error: null }],
    ["error.name", { error: { message: "m" } }],
    ["error.message", { error: { name: "SqliteError" } }],
    ["error.code", { error: { name: "n", message: "m", code: 500 } }],
  ];

  it.each(cases)("a record missing or malforming %s reads as 'unreadable', naming the field", (field, override) => {
    // THE DEFECT THIS FIXES: the reader checked only `v` and `at`, so `{"v":1,"at":"…","error":{}}`
    // came back `found` and `monet doctor` printed `pid undefined, phase 'undefined': undefined:
    // undefined` — a fragment wearing the confidence of a complete answer, on both the human and
    // the --json surface.
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      writeFileSync(startupFailurePath(store), JSON.stringify({ ...validRecord(store), ...override }));
      const read = readStartupFailure(store);
      expect(read.status).toBe("unreadable");
      expect(read.status === "unreadable" && read.reason).toBe(`record is missing or malformed: ${field}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a whole record still reads as 'found' — the validation refuses fragments, not records", () => {
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      writeFileSync(startupFailurePath(store), JSON.stringify(validRecord(store)));
      expect(readStartupFailure(store).status).toBe("found");
      // `code` is genuinely optional; a record without one is whole.
      const noCode = validRecord(store);
      noCode.error = { name: "Error", message: "no code here" };
      writeFileSync(startupFailurePath(store), JSON.stringify(noCode));
      expect(readStartupFailure(store).status).toBe("found");
      // As is a record with no stack at all.
      const noStack = validRecord(store);
      noStack.stack = null;
      writeFileSync(startupFailurePath(store), JSON.stringify(noStack));
      expect(readStartupFailure(store).status).toBe("found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every record this writer produces passes this reader's own validation", () => {
    // The two halves must agree by construction, not by both being edited carefully.
    const dir = tempDir();
    const store = storeIn(dir);
    try {
      for (const error of [new Error("plain"), Object.assign(new Error("coded"), { code: "ENOENT" }), "a string throw"]) {
        recordStartupFailure({ store, error });
        expect(readStartupFailure(store).status).toBe("found");
      }
      expect(existsSync(startupFailurePath(store))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

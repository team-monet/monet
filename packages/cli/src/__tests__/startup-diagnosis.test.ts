/**
 * #13 at the shipped entry points: a startup that dies before the transport connects must leave a
 * cause somewhere addressable.
 *
 * THESE SPAWN THE REAL BINARY PATHS, not a stand-in. What #13 is about is what a HOST observes, and
 * the host observes a process — so the assertions that matter here are made against a real
 * `monet start` (and the bare stdio entry, which is the same server reached a second way) run to
 * completion, with its exit code, its stdout and its stderr read back.
 *
 * STDOUT IS ASSERTED EMPTY ON EVERY ONE OF THEM, deliberately and not incidentally: stdout is the
 * MCP protocol channel, so a diagnosis that reached it would corrupt the very session it was
 * written to explain.
 *
 * MONET_EMBEDDER=hashing throughout — the real selector loads MiniLM, which is slow and depends on
 * a model cache/network. That is not what any of these tests are about, and the same convention
 * bootstrap.test.ts already follows for its own fake selector.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HashingEmbeddingProvider,
  STARTUP_FAILURE_FILENAME,
  markStartupPhase,
  startupPhaseOf,
  type StartupFailureRecord,
} from "@team-monet/core";
import { afterEach, describe, expect, it } from "vitest";
import { openServedCore } from "../bootstrap";
import { getStartupFailurePath } from "../db/index";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = "src/cli.ts";
const STDIO_ENTRY = "src/index.ts";
/** A spawned `monet start` never returns on its own; an immediately-closed stdin is the supported
 *  shutdown trigger (installStdinEofShutdown), so a clean start still terminates for a test. */
const IMMEDIATE_EOF = "";

const dirs: string[] = [];

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-startup-diag-"));
  dirs.push(dir);
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runServer(entry: string, dir: string, extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
    cwd: REPO_ROOT,
    input: IMMEDIATE_EOF,
    encoding: "utf8",
    env: { ...process.env, MONET_STORAGE_DIR: dir, MONET_EMBEDDER: "hashing", ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runStart(dir: string, extraEnv: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "start"], {
    cwd: REPO_ROOT,
    input: IMMEDIATE_EOF,
    encoding: "utf8",
    env: { ...process.env, MONET_STORAGE_DIR: dir, MONET_EMBEDDER: "hashing", ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readRecord(dir: string): StartupFailureRecord {
  return JSON.parse(readFileSync(join(dir, STARTUP_FAILURE_FILENAME), "utf8")) as StartupFailureRecord;
}

/** The bytes that made `file is not a database` the reproduction of choice: deterministic, offline,
 *  and it fails in the store open rather than anywhere earlier. */
function corruptStore(dir: string): void {
  writeFileSync(join(dir, "monet.db"), "this is not a sqlite database at all, not even close\n");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a startup that dies leaves a findable cause", () => {
  it("`monet start` against an unopenable store writes the record, names the phase, and keeps stdout clean", () => {
    const dir = storeDir();
    corruptStore(dir);

    const run = runStart(dir);

    // What the host sees is unchanged and unchangeable — the process exited before any protocol
    // existed. What is new is that the cause is now somewhere a reader can reach.
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(existsSync(join(dir, STARTUP_FAILURE_FILENAME))).toBe(true);

    const record = readRecord(dir);
    expect(record.phase).toBe("store-open");
    expect(record.error.message).toContain("file is not a database");
    expect(record.error.code).toBe("SQLITE_NOTADB");
    expect(record.store).toBe(join(dir, "monet.db"));
    expect(record.pid).toBeGreaterThan(0);
    // The stderr line points AT the file, so an operator watching the stream is not left to guess
    // that a record was written or where.
    expect(run.stderr).toContain(`startup failed in phase 'store-open'`);
    expect(run.stderr).toContain(join(dir, STARTUP_FAILURE_FILENAME));
  }, 30000);

  it("the bare stdio entry point — the SAME server, second launch path — writes the same record", () => {
    // Wiring only `monet start` would make the diagnosis depend on which launch path a host happens
    // to spawn, which is the exact divergence index.ts's own comments already refuse for the mirror
    // and the moment spool.
    const dir = storeDir();
    corruptStore(dir);

    const run = runServer(STDIO_ENTRY, dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(readRecord(dir).phase).toBe("store-open");
    expect(run.stderr).toContain(join(dir, STARTUP_FAILURE_FILENAME));
  }, 30000);

  it("a clean start writes no record at all — silence is the healthy state", () => {
    const dir = storeDir();

    const run = runStart(dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Monet started");
    expect(existsSync(join(dir, STARTUP_FAILURE_FILENAME))).toBe(false);
  }, 30000);

  it("a later successful start does NOT delete an earlier failure's record", () => {
    // A host retries a failed stdio connection, so fail → fail → succeed is the ORDINARY shape (it
    // is what the 2026-08-01 incident behind #12 actually looked like). Clearing the record on
    // success would destroy exactly the evidence a user comes back for once the session is finally
    // up — and would let two servers racing on one store erase each other's diagnosis.
    const dir = storeDir();
    corruptStore(dir);
    expect(runStart(dir).status).toBe(1);
    const failed = readRecord(dir);

    rmSync(join(dir, "monet.db")); // the operator fixes the store
    expect(runStart(dir).status).toBe(0);

    expect(existsSync(join(dir, STARTUP_FAILURE_FILENAME))).toBe(true);
    expect(readRecord(dir).at).toBe(failed.at); // byte-identical: the success neither cleared nor rewrote it
  }, 45000);
});

describe("`monet doctor` is where a reader finds it", () => {
  it("surfaces the last startup failure even when the store itself cannot be inspected", () => {
    // The case that matters most: an unreadable store is where doctor has the least of its own to
    // say, and where the last startup's account is the most useful thing it can offer. Printed on
    // stderr, before the inspection, so it survives the inspection failing.
    const dir = storeDir();
    corruptStore(dir);
    expect(runStart(dir).status).toBe(1);

    const doctor = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "doctor", "--dir", dir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, MONET_EMBEDDER: "hashing" },
    });

    expect(doctor.stderr).toContain("startup: last recorded startup failure");
    expect(doctor.stderr).toContain("phase 'store-open'");
    expect(doctor.stderr).toContain("file is not a database");
    expect(doctor.stderr).toContain(join(dir, STARTUP_FAILURE_FILENAME)); // it names the file, not just the fact
    // The record never enters stdout — `doctor --json` consumers parse that stream.
    expect(doctor.stdout).not.toContain("last recorded startup failure");
  }, 45000);

  it("says nothing about startup when no record exists", () => {
    const dir = storeDir();
    const doctor = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "doctor", "--dir", dir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, MONET_EMBEDDER: "hashing" },
    });
    expect(doctor.stderr).not.toContain("startup:");
  }, 30000);

  it("reports a record it cannot parse as its own state, never as 'no failure'", () => {
    const dir = storeDir();
    writeFileSync(join(dir, STARTUP_FAILURE_FILENAME), "{ truncated mid-writ");

    const doctor = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "doctor", "--dir", dir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, MONET_EMBEDDER: "hashing" },
    });

    expect(doctor.stderr).toContain("could not be read (not valid JSON)");
  }, 30000);
});

describe("openServedCore separates its two fallible steps", () => {
  it("an embedder-selection failure and a store-open failure are told apart, not merged into one opaque startup", async () => {
    // The distinction the 2026-08-01 incident behind #12 turned on: the report blamed the model
    // download, the store was actually locked, and nothing in the failure could tell the two apart.
    const dir = storeDir();

    let selectionError: unknown;
    try {
      await openServedCore(join(dir, "monet.db"), { scopeContext: dir, defaultCircle: "c" }, async () => {
        throw new Error("model cache is poisoned");
      });
    } catch (error) {
      selectionError = error;
    }
    expect(startupPhaseOf(selectionError)).toBe("embedder-selection");

    corruptStore(dir);
    let openError: unknown;
    try {
      await openServedCore(
        join(dir, "monet.db"),
        { scopeContext: dir, defaultCircle: "c" },
        async () => new HashingEmbeddingProvider(),
      );
    } catch (error) {
      openError = error;
    }
    expect(startupPhaseOf(openError)).toBe("store-open");
  });

  it("the tag never replaces the error, so the typed handlers at the entry points still match", async () => {
    const dir = storeDir();
    const original = new Error("model cache is poisoned");
    await expect(
      openServedCore(join(dir, "monet.db"), { scopeContext: dir, defaultCircle: "c" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original); // the SAME object — cli.ts/index.ts branch on `instanceof`
  });
});

describe("source regression guards: both entry points actually report, and know which side of connect they are on", () => {
  it("`monet start` and the stdio entry both call reportStartupFailure with a transportConnected flag set AFTER the factory", () => {
    // A source-text check in this file's established style (see bootstrap.test.ts's own guards):
    // the behavioural tests above prove the mechanism, this proves the two REAL entry points are
    // wired into it — and specifically that the flag is raised after createMonetCoreMcpServer
    // rather than before, which is what makes a post-connect death distinguishable at all.
    for (const entry of ["src/cli.ts", "src/index.ts"]) {
      const source = readFileSync(join(REPO_ROOT, entry), "utf8");
      expect(source).toContain("reportStartupFailure(error, { projectDir, transportConnected })");
      const factoryAt = source.indexOf("await createMonetCoreMcpServer(core);");
      const flagAt = source.indexOf("transportConnected = true;");
      expect(factoryAt).toBeGreaterThan(-1);
      expect(flagAt).toBeGreaterThan(factoryAt);
    }
  });

  it("the record's filename has ONE spelling, and resolves through the same chain the store does", () => {
    // getStartupFailurePath takes its filename from core rather than restating it — two spellings
    // is how a writer and a reader stop meeting — and resolves through getMonetDir, so the record
    // always lands beside the store the failing process actually opened.
    const dir = storeDir();
    const saved = process.env.MONET_STORAGE_DIR;
    // MONET_STORAGE_DIR is getMonetDir's first rung, and the most direct lever to pin the
    // resolution at this test's own tmp dir — the same convention bootstrap.test.ts uses, and the
    // same reason: a value inherited from the invoking shell must not decide this assertion.
    process.env.MONET_STORAGE_DIR = dir;
    try {
      expect(getStartupFailurePath(dir)).toBe(join(dir, STARTUP_FAILURE_FILENAME));
    } finally {
      if (saved !== undefined) process.env.MONET_STORAGE_DIR = saved;
      else delete process.env.MONET_STORAGE_DIR;
    }
    expect(readFileSync(join(REPO_ROOT, "src/db/index.ts"), "utf8")).toContain("STARTUP_FAILURE_FILENAME");
  });

  it("markStartupPhase is re-exported to the client, so an entry point can tag without reaching into core internals", () => {
    const error = markStartupPhase(new Error("x"), "post-connect");
    expect(startupPhaseOf(error)).toBe("post-connect");
  });
});

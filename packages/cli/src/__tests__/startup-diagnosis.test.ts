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
  STARTUP_FAILURE_SUFFIX,
  markStartupPhase,
  startupFailurePath,
  startupPhaseOf,
  type StartupFailureRecord,
} from "@team-monet/core";
import { afterEach, describe, expect, it } from "vitest";
import { openServedCore } from "../bootstrap";
import { getStartupFailurePath } from "../db/index";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CORE_ROOT = resolve(REPO_ROOT, "../core");
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

/** The store `monet start` serves out of `dir`, and the record that belongs to it. */
const dbIn = (dir: string): string => join(dir, "monet.db");
const recordIn = (dir: string): string => startupFailurePath(dbIn(dir));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnNode(args: string[], cwd: string, env: Record<string, string>, input = IMMEDIATE_EOF): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, MONET_EMBEDDER: "hashing", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const runStart = (dir: string, extra: string[] = [], env: Record<string, string> = {}): Run =>
  spawnNode([CLI_ENTRY, "start", ...extra], REPO_ROOT, { MONET_STORAGE_DIR: dir, ...env });

const runStdioEntry = (dir: string): Run => spawnNode([STDIO_ENTRY], REPO_ROOT, { MONET_STORAGE_DIR: dir });

const runDoctor = (dir: string, extra: string[] = []): Run =>
  spawnNode([CLI_ENTRY, "doctor", "--dir", dir, ...extra], REPO_ROOT, {});

function readRecord(dir: string): StartupFailureRecord {
  return JSON.parse(readFileSync(recordIn(dir), "utf8")) as StartupFailureRecord;
}

/** The bytes that made `file is not a database` the reproduction of choice: deterministic, offline,
 *  and it fails in the store open rather than anywhere earlier. */
function corruptStore(dir: string, name = "monet.db"): void {
  writeFileSync(join(dir, name), "this is not a sqlite database at all, not even close\n");
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
    expect(existsSync(recordIn(dir))).toBe(true);

    const record = readRecord(dir);
    expect(record.phase).toBe("store-open");
    expect(record.error.message).toContain("file is not a database");
    expect(record.error.code).toBe("SQLITE_NOTADB");
    expect(record.store).toBe(dbIn(dir));
    expect(record.pid).toBeGreaterThan(0);
    // The stderr line points AT the file, so an operator watching the stream is not left to guess
    // that a record was written or where.
    expect(run.stderr).toContain(`startup failed in phase 'store-open'`);
    expect(run.stderr).toContain(recordIn(dir));
  }, 30000);

  it("the bare stdio entry point — the SAME server, second launch path — writes the same record", () => {
    // Wiring only `monet start` would make the diagnosis depend on which launch path a host happens
    // to spawn, which is the exact divergence index.ts's own comments already refuse for the mirror
    // and the moment spool.
    const dir = storeDir();
    corruptStore(dir);

    const run = runStdioEntry(dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(readRecord(dir).phase).toBe("store-open");
    expect(run.stderr).toContain(recordIn(dir));
  }, 30000);

  it("a clean start writes no record at all — silence is the healthy state", () => {
    const dir = storeDir();

    const run = runStart(dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Monet started");
    expect(existsSync(recordIn(dir))).toBe(false);
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

    rmSync(dbIn(dir)); // the operator fixes the store
    expect(runStart(dir).status).toBe(0);

    expect(existsSync(recordIn(dir))).toBe(true);
    expect(readRecord(dir).at).toBe(failed.at); // the success neither cleared nor rewrote it
  }, 45000);
});

// ── ROUND 1 REVIEW (PR #79) ──────────────────────────────────────────────────────────────────────

describe("a storage path that cannot be created is a startup failure like any other", () => {
  it("`monet start --dir <uncreatable>` reports, instead of dying with a bare errno and nothing else", () => {
    // THE DEFECT THIS FIXES: `ensureMonetDir` ran ABOVE the try, so the one failure class #13 names
    // outright — an unusable storage path — produced no record AND no word about the record, while
    // the very same failure through the stdio entry point (whose whole `main` sits inside its
    // handler) reported it properly. One server, two launch paths, two behaviours.
    //
    // The record itself cannot be written here — the directory it would live in is the directory
    // that could not be created — so what must not be silent is THAT. A reader who checks the
    // expected path, finds nothing, and is told nothing concludes no startup ever failed.
    const dir = storeDir();
    writeFileSync(join(dir, "blocker"), "a regular file, so nothing can be created beneath it");
    const target = join(dir, "blocker", "nested", ".monet");

    const run = runStart(dir, ["--dir", target], { MONET_STORAGE_DIR: "" });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ENOTDIR"); // the original cause still reaches stderr, unchanged
    expect(run.stderr).toContain("monet: startup failed in phase 'unknown'");
    expect(run.stderr).toContain("could not write the diagnosis to");
    expect(run.stderr).toContain(join(target, `monet.db${STARTUP_FAILURE_SUFFIX}`));
  }, 30000);
});

describe("a record is never attributed to the wrong database", () => {
  it("core's dev server failing on monet-core.db leaves `monet doctor` on the healthy monet.db saying nothing", () => {
    // THE DEFECT THIS FIXES, end to end: one `.monet` directory holds BOTH databases — the shipped
    // CLI's `monet.db` and `packages/core/scripts/mcp-cli.ts`'s `monet-core.db`. With one record per
    // directory, the dev server's `file is not a database` was read back by `doctor` as the
    // shipped store's own startup failure. A diagnostic confidently naming the wrong store's fault
    // is worse than one that says nothing.
    const dir = storeDir();
    // A healthy monet.db, and a corrupt monet-core.db beside it.
    expect(spawnNode([CLI_ENTRY, "status"], REPO_ROOT, { MONET_STORAGE_DIR: dir }).status).toBe(0);
    corruptStore(dir, "monet-core.db");

    const dev = spawnNode(["scripts/mcp-cli.ts"], CORE_ROOT, { MONET_STORAGE_DIR: dir });
    expect(dev.status).toBe(1);
    // The dev server's own record exists, under ITS store's name.
    const devRecord = startupFailurePath(join(dir, "monet-core.db"));
    expect(existsSync(devRecord)).toBe(true);
    expect((JSON.parse(readFileSync(devRecord, "utf8")) as StartupFailureRecord).store).toBe(join(dir, "monet-core.db"));

    // And the healthy store is untouched by it, on both of doctor's surfaces.
    expect(existsSync(recordIn(dir))).toBe(false);
    const doctor = runDoctor(dir);
    expect(doctor.stderr).not.toContain("last recorded startup failure");
    const json = JSON.parse(runDoctor(dir, ["--json"]).stdout) as { startupFailure: { status: string } };
    expect(json.startupFailure).toEqual({ status: "none" });
  }, 60000);
});

describe("`monet doctor` is where a reader finds it", () => {
  it("surfaces the last startup failure even when the store itself cannot be inspected", () => {
    // The case that matters most: an unreadable store is where doctor has the least of its own to
    // say, and where the last startup's account is the most useful thing it can offer. Printed on
    // stderr, before the inspection, so it survives the inspection failing.
    const dir = storeDir();
    corruptStore(dir);
    expect(runStart(dir).status).toBe(1);

    const doctor = runDoctor(dir);

    expect(doctor.stderr).toContain("startup: last recorded startup failure");
    expect(doctor.stderr).toContain("phase 'store-open'");
    expect(doctor.stderr).toContain("file is not a database");
    expect(doctor.stderr).toContain(recordIn(dir)); // it names the file, not just the fact
    // The record never enters stdout — `doctor --json` consumers parse that stream.
    expect(doctor.stdout).not.toContain("last recorded startup failure");
  }, 45000);

  it("says nothing about startup when no record exists", () => {
    expect(runDoctor(storeDir()).stderr).not.toContain("startup:");
  }, 30000);

  it("a record it cannot fully vouch for is reported as unreadable, naming the field — never as a verdict", () => {
    // A fragment used to come back as `found`, and doctor printed `pid undefined, phase
    // 'undefined': undefined: undefined`. Both surfaces must now say they could not read it.
    const dir = storeDir();
    writeFileSync(recordIn(dir), JSON.stringify({ v: 1, at: "2026-08-21T00:00:00.000Z", error: {} }));

    const doctor = runDoctor(dir);
    expect(doctor.stderr).toContain("could not be read (record is missing or malformed: pid)");
    expect(doctor.stderr).not.toContain("undefined");

    const json = JSON.parse(runDoctor(dir, ["--json"]).stdout) as { startupFailure: { status: string } };
    expect(json.startupFailure.status).toBe("unreadable");
  }, 45000);

  it("reports a truncated record as unreadable rather than absent", () => {
    const dir = storeDir();
    writeFileSync(recordIn(dir), "{ truncated mid-writ");
    expect(runDoctor(dir).stderr).toContain("could not be read (not valid JSON)");
  }, 30000);
});

describe("openServedCore separates its two fallible steps", () => {
  it("an embedder-selection failure and a store-open failure are told apart, not merged into one opaque startup", async () => {
    // The distinction the 2026-08-01 incident behind #12 turned on: the report blamed the model
    // download, the store was actually locked, and nothing in the failure could tell the two apart.
    const dir = storeDir();

    let selectionError: unknown;
    try {
      await openServedCore(dbIn(dir), { scopeContext: dir, defaultCircle: "c" }, async () => {
        throw new Error("model cache is poisoned");
      });
    } catch (error) {
      selectionError = error;
    }
    expect(startupPhaseOf(selectionError)).toBe("embedder-selection");

    corruptStore(dir);
    let openError: unknown;
    try {
      await openServedCore(dbIn(dir), { scopeContext: dir, defaultCircle: "c" }, async () => new HashingEmbeddingProvider());
    } catch (error) {
      openError = error;
    }
    expect(startupPhaseOf(openError)).toBe("store-open");
  });

  it("the tag never replaces the error, so the typed handlers at the entry points still match", async () => {
    const dir = storeDir();
    const original = new Error("model cache is poisoned");
    await expect(
      openServedCore(dbIn(dir), { scopeContext: dir, defaultCircle: "c" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original); // the SAME object — cli.ts/index.ts branch on `instanceof`
  });
});

describe("source regression guards: both entry points report, and know which side of connect they are on", () => {
  it("`monet start` and the stdio entry both call reportStartupFailure with a transportConnected flag set AFTER the factory", () => {
    // A source-text check in this file's established style (see bootstrap.test.ts's own guards):
    // the behavioural tests above prove the mechanism, this proves the two REAL entry points are
    // wired into it — and specifically that the flag is raised after createMonetCoreMcpServer
    // rather than before, which is what makes a post-connect death distinguishable at all.
    for (const entry of [CLI_ENTRY, STDIO_ENTRY]) {
      const source = readFileSync(join(REPO_ROOT, entry), "utf8");
      expect(source).toContain("reportStartupFailure(error, { projectDir, transportConnected })");
      const factoryAt = source.indexOf("await createMonetCoreMcpServer(core);");
      const flagAt = source.indexOf("transportConnected = true;");
      expect(factoryAt).toBeGreaterThan(-1);
      expect(flagAt).toBeGreaterThan(factoryAt);
    }
  });

  it("`monet start`'s try opens ABOVE ensureMonetDir, so a storage-path failure is inside it", () => {
    // The behavioural test above proves the reporting; this pins the ORDER that makes it reachable,
    // which is the whole of the round-1 finding and the easiest thing to undo by accident.
    const source = readFileSync(join(REPO_ROOT, CLI_ENTRY), "utf8");
    const tryAt = source.indexOf("    let transportConnected = false;\n    try {");
    const ensureAt = source.indexOf("ensureMonetDir(projectDir);");
    expect(tryAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeGreaterThan(tryAt);
  });

  it("the record's path has ONE derivation, shared by the writer and every reader", () => {
    // getStartupFailurePath composes getDbPath with core's own startupFailurePath, so the client
    // cannot spell the sidecar differently from the package that writes it.
    const dir = storeDir();
    const saved = process.env.MONET_STORAGE_DIR;
    // MONET_STORAGE_DIR is getMonetDir's first rung, and the most direct lever to pin the
    // resolution at this test's own tmp dir — the same convention bootstrap.test.ts uses, and the
    // same reason: a value inherited from the invoking shell must not decide this assertion.
    process.env.MONET_STORAGE_DIR = dir;
    try {
      expect(getStartupFailurePath(dir)).toBe(join(dir, `monet.db${STARTUP_FAILURE_SUFFIX}`));
    } finally {
      if (saved !== undefined) process.env.MONET_STORAGE_DIR = saved;
      else delete process.env.MONET_STORAGE_DIR;
    }
    expect(readFileSync(join(REPO_ROOT, "src/db/index.ts"), "utf8")).toContain("startupFailurePath(getDbPath(baseDir))");
  });

  it("markStartupPhase is re-exported to the client, so an entry point can tag without reaching into core internals", () => {
    expect(startupPhaseOf(markStartupPhase(new Error("x"), "post-connect"))).toBe("post-connect");
  });
});

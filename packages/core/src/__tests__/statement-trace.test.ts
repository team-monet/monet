/**
 * The claim under test is narrow and it is the whole reason the module exists (#145): while a
 * statement is running, the marker file NAMES IT — and it keeps naming it if the statement
 * never returns. A test that only checked the marker after the call would prove the opposite
 * of what matters, so the in-flight assertions here read the file from inside the call.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStatementTracer,
  statementTraceEnabled,
  SLOW_LOG_FILENAME,
  STATEMENT_TRACE_SQL_MAX_CHARS,
} from "../statement-trace";
import type { StatementMethod } from "../statement-trace";
import { BetterSqlitePort } from "../storage";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-trace-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const readMarker = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("statementTraceEnabled", () => {
  it("is off unless explicitly set to 1", () => {
    expect(statementTraceEnabled({})).toBe(false);
    expect(statementTraceEnabled({ MONET_TRACE_SQL: "0" })).toBe(false);
    expect(statementTraceEnabled({ MONET_TRACE_SQL: "true" })).toBe(false);
    expect(statementTraceEnabled({ MONET_TRACE_SQL: "1" })).toBe(true);
  });
});

describe("in-flight marker", () => {
  it("names the running statement before it returns, and clears after", () => {
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 4242 });

    expect(readMarker(tracer.inflightPath)).toBe("");

    const startedAt = tracer.begin("all", "SELECT * FROM concepts WHERE circle = ?");
    // THE ASSERTION THAT MATTERS: mid-flight, from outside the call, the record exists.
    const midFlight = JSON.parse(readMarker(tracer.inflightPath));
    expect(midFlight).toMatchObject({
      v: 1,
      pid: 4242,
      method: "all",
      sql: "SELECT * FROM concepts WHERE circle = ?",
    });
    expect(typeof midFlight.startedAt).toBe("number");

    tracer.end(startedAt, "all", "SELECT * FROM concepts WHERE circle = ?", 3);
    expect(readMarker(tracer.inflightPath)).toBe("");
    tracer.close();
  });

  it("leaves no tail of a longer previous statement", () => {
    // Rewriting at offset 0 without truncating first would leave the old statement's tail
    // appended to the new one — unparseable JSON exactly when it is read to diagnose a hang.
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 7 });
    const long = `SELECT ${"x".repeat(400)} FROM t`;
    tracer.end(tracer.begin("all", long), "all", long);
    tracer.begin("get", "SELECT 1");
    expect(() => JSON.parse(readMarker(tracer.inflightPath))).not.toThrow();
    expect(JSON.parse(readMarker(tracer.inflightPath)).sql).toBe("SELECT 1");
    tracer.close();
  });

  it("clips SQL so one pathological statement cannot unbound the record", () => {
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 8 });
    tracer.begin("all", "S".repeat(STATEMENT_TRACE_SQL_MAX_CHARS + 500));
    const sql = JSON.parse(readMarker(tracer.inflightPath)).sql as string;
    expect(sql.length).toBe(STATEMENT_TRACE_SQL_MAX_CHARS + 1); // clipped + the ellipsis
    expect(sql.endsWith("…")).toBe(true);
    tracer.close();
  });

  it("close() clears the marker, so a clean exit does not read as a hang", () => {
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 9 });
    tracer.begin("all", "SELECT 1");
    expect(readMarker(tracer.inflightPath)).not.toBe("");
    tracer.close();
    expect(readMarker(tracer.inflightPath)).toBe("");
    tracer.close(); // idempotent
  });
});

describe("file permissions", () => {
  it("creates both trace files 0600, and tightens one it inherits", () => {
    // Codex round 5: these sit beside the store and carry statement text and backup paths. The
    // live store had a 0644 inflight marker next to a 0600 gate-journal.jsonl — the convention
    // already existed in gate-journal.ts and this module was not following it.
    const dir = tempDir();
    let clock = 0;
    const first = createStatementTracer({ dir, pid: 30, connectionSeq: 0, slowThresholdMs: 1, now: () => clock });
    const firstStart = first.begin("all", "SELECT secret");
    clock += 10;
    first.end(firstStart, "all", "SELECT secret");
    expect(statSync(first.inflightPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, SLOW_LOG_FILENAME)).mode & 0o777).toBe(0o600);
    first.close();

    // A file left behind by an earlier, looser run must not keep its mode: the create-time mode
    // argument does nothing when the file already exists.
    chmodSync(first.inflightPath, 0o644);
    chmodSync(join(dir, SLOW_LOG_FILENAME), 0o644);
    const second = createStatementTracer({ dir, pid: 30, connectionSeq: 0, slowThresholdMs: 1, now: () => clock });
    const secondStart = second.begin("all", "SELECT secret");
    clock += 10;
    second.end(secondStart, "all", "SELECT secret");
    expect(statSync(second.inflightPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, SLOW_LOG_FILENAME)).mode & 0o777).toBe(0o600);
    second.close();
  });
});

describe("slow log", () => {
  it("records only statements over the threshold", () => {
    const dir = tempDir();
    let clock = 1_000;
    const tracer = createStatementTracer({ dir, pid: 11, slowThresholdMs: 50, now: () => clock });

    const fastStart = tracer.begin("get", "SELECT fast");
    clock += 10;
    tracer.end(fastStart, "get", "SELECT fast");

    const slowStart = tracer.begin("all", "SELECT slow");
    clock += 900;
    tracer.end(slowStart, "all", "SELECT slow", 42);

    const lines = readFileSync(join(dir, SLOW_LOG_FILENAME), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ method: "all", elapsedMs: 900, rows: 42, sql: "SELECT slow" });
    tracer.close();
  });

  it("writes nothing at all when no statement is slow", () => {
    const dir = tempDir();
    let clock = 0;
    const tracer = createStatementTracer({ dir, pid: 12, slowThresholdMs: 50, now: () => clock });
    tracer.end(tracer.begin("run", "INSERT"), "run", "INSERT");
    expect(existsSync(join(dir, SLOW_LOG_FILENAME))).toBe(false);
    tracer.close();
  });
});

describe("BetterSqlitePort wiring", () => {
  it("traces through the port and clears the marker even when a statement throws", () => {
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 13 });
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer });
    port.exec("CREATE TABLE t (a INTEGER)");
    port.prepare("INSERT INTO t (a) VALUES (?)").run(1);
    expect(port.prepare("SELECT a FROM t").all()).toEqual([{ a: 1 }]);
    expect(readMarker(tracer.inflightPath)).toBe("");

    // A throwing statement must still clear: otherwise one bad query leaves a stale marker
    // that reads as a permanent hang.
    expect(() => port.prepare("SELECT a FROM t").get(1, 2, 3)).toThrow();
    expect(readMarker(tracer.inflightPath)).toBe("");

    port.close();
    tracer.close();
  });

  it("traces exec() and pragma(), not only prepared statements", () => {
    // Codex P2 on PR #147: 97 exec() call sites in core bypass prepare() entirely, and pragma
    // runs checkpoint/integrity work that is unbounded on a large store. An instrument blind to
    // two of the three SQL mouths cannot name the culprit it exists to name.
    const dir = tempDir();
    let clock = 0;
    const tracer = createStatementTracer({ dir, pid: 15, slowThresholdMs: 10, now: () => clock });
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer });

    const seen: string[] = [];
    const spy = { ...tracer, begin: (m: StatementMethod, sql: string) => (seen.push(`${m}:${sql.slice(0, 12)}`), tracer.begin(m, sql)) };
    const spied = new BetterSqlitePort(join(dir, "u.db"), { tracer: spy as typeof tracer });
    spied.exec("CREATE TABLE t (a INTEGER)");
    spied.pragma("user_version");
    // The first two are the constructor's own setup pragmas: the tracer is built BEFORE them
    // (Codex round 3) precisely because `journal_mode = WAL` takes locks and can stall against a
    // busy store, which is startup — the path #148 is about.
    expect(seen).toEqual([
      "pragma:PRAGMA journ",
      "pragma:PRAGMA busy_",
      "exec:CREATE TABLE",
      "pragma:PRAGMA user_",
    ]);
    spied.close();

    // And a slow one lands in the log under its own method name.
    const start = tracer.begin("exec", "CREATE TABLE slow (a)");
    clock += 500;
    tracer.end(start, "exec", "CREATE TABLE slow (a)");
    const logged = readFileSync(join(dir, SLOW_LOG_FILENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged.some((e) => e.method === "exec")).toBe(true);

    port.close();
    tracer.close();
  });

  it("marks BEGIN before the callback runs, and falls back to it afterwards", () => {
    // Codex round 2: better-sqlite3 runs BEGIN when the transaction function is INVOKED. If it
    // blocks on the write lock the callback never starts, so nothing inside can mark anything.
    // And if `end` merely cleared, the last inner statement would blank the marker — leaving a
    // hang in COMMIT invisible. The stack is what makes both cases visible.
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 16 });
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer });
    port.exec("CREATE TABLE t (a INTEGER)");

    const seen: Array<{ method: string; depth: number }> = [];
    port.immediateTransaction(() => {
      // Inside the callback, BEGIN IMMEDIATE has already been marked.
      seen.push(JSON.parse(readMarker(tracer.inflightPath)));
      port.prepare("INSERT INTO t (a) VALUES (?)").run(1);
      // ...and after the inner statement finishes, the marker falls BACK to the transaction
      // rather than going empty. This is the COMMIT-hang case.
      seen.push(JSON.parse(readMarker(tracer.inflightPath)));
    })();

    expect(seen[0]).toMatchObject({ method: "immediateTransaction", depth: 1 });
    expect(seen[1]).toMatchObject({ method: "immediateTransaction", depth: 1 });
    expect(readMarker(tracer.inflightPath)).toBe("");
    port.close();
    tracer.close();
  });

  it("traces the exclusive-ownership path, which used to reach around the port", () => {
    // Codex round 2: acquire/release issued nine this.db.* calls directly — locking_mode
    // switches, the warm schema read, and the BEGIN IMMEDIATE probe. A hang in any of them left
    // the marker empty. They route through the traced helper now.
    const dir = tempDir();
    const seen: string[] = [];
    const base = createStatementTracer({ dir, pid: 17 });
    const spy = { ...base, begin: (m: StatementMethod, sql: string) => (seen.push(m), base.begin(m, sql)) };
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer: spy as typeof base });
    port.exec("CREATE TABLE t (a INTEGER)");
    seen.length = 0;

    port.acquireExclusiveOwnership();
    port.releaseExclusiveOwnership();

    expect(seen).toContain("pragma"); // locking_mode switches
    expect(seen).toContain("get"); // the warm schema read
    expect(seen).toContain("exec"); // the BEGIN IMMEDIATE probe
    expect(readMarker(base.inflightPath)).toBe("");
    port.close();
    base.close();
  });

  it("gives each connection its own marker, so one cannot truncate another's", () => {
    // Codex round 3: sharing `inflight-<pid>.json` across two ports in one process meant the
    // inner connection's `end` popped ITS empty stack and truncated the shared file — so an outer
    // transaction, or its COMMIT, could wedge with an empty marker.
    const dir = tempDir();
    const outer = createStatementTracer({ dir, pid: 20 });
    const inner = createStatementTracer({ dir, pid: 20 });
    expect(outer.inflightPath).not.toBe(inner.inflightPath);

    outer.begin("immediateTransaction", "BEGIN IMMEDIATE");
    const innerStart = inner.begin("all", "SELECT 1");
    inner.end(innerStart, "all", "SELECT 1");

    // The inner connection finishing must leave the outer transaction still named.
    expect(readMarker(inner.inflightPath)).toBe("");
    expect(JSON.parse(readMarker(outer.inflightPath))).toMatchObject({ method: "immediateTransaction" });
    outer.close();
    inner.close();
  });

  it("keeps tracing through close(), so shutdown SQL that blocks is still named", () => {
    // Codex round 3, and a regression this PR introduced: round 2 routed
    // releaseExclusiveOwnership through the traced helpers, so closing the tracer first blinded
    // exactly the shutdown SQL most able to block.
    const dir = tempDir();
    const seen: string[] = [];
    const base = createStatementTracer({ dir, pid: 21 });
    const spy = { ...base, begin: (m: StatementMethod, sql: string) => (seen.push(m), base.begin(m, sql)) };
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer: spy as typeof base });
    port.acquireExclusiveOwnership();
    seen.length = 0;

    port.close(); // release runs INSIDE close, and must still be traced

    expect(seen).toContain("pragma");
    expect(seen).toContain("get");
    expect(readMarker(base.inflightPath)).toBe(""); // ...and the marker is cleared on the way out
    base.close();
  });

  it("marks the prepare phase, not only the statement it builds", () => {
    // Codex round 4: sqlite3_prepare_v2 reads schema and can block before run/get/all is reached.
    const dir = tempDir();
    const seen: string[] = [];
    const base = createStatementTracer({ dir, pid: 22 });
    const spy = { ...base, begin: (m: StatementMethod, sql: string) => (seen.push(m), base.begin(m, sql)) };
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer: spy as typeof base });
    port.exec("CREATE TABLE t (a INTEGER)");
    seen.length = 0;

    const stmt = port.prepare("SELECT a FROM t");
    expect(seen).toEqual(["prepare"]); // building it is its own frame...
    stmt.all();
    expect(seen).toEqual(["prepare", "all"]); // ...and running it is another
    expect(readMarker(base.inflightPath)).toBe("");
    port.close();
    base.close();
  });

  it("marks the verified backup, which runs while this connection holds exclusive ownership", async () => {
    // Codex round 4, and the worst place to be blind: the backup stalls with every other client
    // locked out, which is #145 exactly. It is also the one asynchronous SQLite path, so it cannot
    // use the synchronous helper and is bracketed at its own call site.
    const dir = tempDir();
    const seen: string[] = [];
    const base = createStatementTracer({ dir, pid: 23 });
    const spy = { ...base, begin: (m: StatementMethod, sql: string) => (seen.push(m), base.begin(m, sql)) };
    const port = new BetterSqlitePort(join(dir, "t.db"), { tracer: spy as typeof base });
    port.exec("CREATE TABLE t (a INTEGER)");
    seen.length = 0;

    await port.createVerifiedBackup(join(dir, "backup.db"));

    expect(seen).toContain("backup");
    expect(seen).toContain("backupVerify");
    expect(readMarker(base.inflightPath)).toBe("");
    port.close();
    base.close();
  });

  it("is a pass-through when untraced — no wrapper, no records", () => {
    const dir = tempDir();
    const port = new BetterSqlitePort(join(dir, "t.db"));
    port.exec("CREATE TABLE t (a INTEGER)");
    port.prepare("INSERT INTO t (a) VALUES (?)").run(5);
    expect(port.prepare("SELECT a FROM t").all()).toEqual([{ a: 5 }]);
    expect(existsSync(join(dir, SLOW_LOG_FILENAME))).toBe(false);
    port.close();
  });

  it("never traces :memory: — there is no outside to read the record from", () => {
    const dir = tempDir();
    const tracer = createStatementTracer({ dir, pid: 14 });
    const port = new BetterSqlitePort(":memory:", { tracer });
    port.exec("CREATE TABLE t (a INTEGER)");
    // An explicitly injected tracer is honoured (tests need it); what must not happen is the
    // constructor CREATING one for an in-memory database off the env switch.
    port.prepare("INSERT INTO t (a) VALUES (?)").run(1);
    expect(readMarker(tracer.inflightPath)).toBe("");
    port.close();
  });
});

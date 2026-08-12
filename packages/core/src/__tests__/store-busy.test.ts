/**
 * #148: a startup that cannot take the store's write lock used to fail with SQLite's own
 * `database is locked`, on a stderr an MCP host does not display. Diagnosing one occurrence cost
 * `lsof`, `ps`, a stack sample and three hand-run SQLite probes. These tests cover the two halves
 * of making that unnecessary: reading the markers a lock-holder writes, and turning a real
 * contention failure into a sentence naming the holder and the wait.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInflightStatements } from "../statement-trace";
import { BetterSqlitePort, StoreBusyError } from "../storage";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "monet-busy-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("readInflightStatements — the reader this module's JSDoc has pointed at all along", () => {
  it("recovers what another process recorded, newest statement first", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "inflight-111-0.json"), JSON.stringify({ v: 1, pid: 111, method: "run", startedAt: 1000, depth: 2, sql: "INSERT INTO a" }));
    writeFileSync(join(dir, "inflight-222-0.json"), JSON.stringify({ v: 1, pid: 222, method: "immediateTransaction", startedAt: 5000, depth: 1, sql: "BEGIN IMMEDIATE" }));

    expect(readInflightStatements(dir)).toEqual([
      { pid: 222, startedAt: 5000, method: "immediateTransaction", depth: 1, sql: "BEGIN IMMEDIATE" },
      { pid: 111, startedAt: 1000, method: "run", depth: 2, sql: "INSERT INTO a" },
    ]);
  });

  it("never throws while diagnosing: a missing directory, an idle marker, a half-written one, and a stranger are all skipped", () => {
    expect(readInflightStatements(join(tmpdir(), "monet-does-not-exist-4a7f"))).toEqual([]);

    const dir = tempDir();
    writeFileSync(join(dir, "inflight-1-0.json"), "");                       // idle connection truncates its own
    writeFileSync(join(dir, "inflight-2-0.json"), '{"v":1,"pid":2,"meth');   // caught mid-write
    writeFileSync(join(dir, "inflight-3-0.json"), JSON.stringify({ v: 1, pid: "not-a-number", method: "run", startedAt: 1, sql: "x" }));
    writeFileSync(join(dir, "slow-queries.jsonl"), "not an inflight marker");
    writeFileSync(join(dir, "inflight-5-0.json"), "null"); // valid JSON, and not an object
    writeFileSync(join(dir, "inflight-4-0.json"), JSON.stringify({ v: 1, pid: 4, method: "run", startedAt: 9, depth: 1, sql: "SELECT 1" }));

    expect(readInflightStatements(dir)).toEqual([
      { pid: 4, startedAt: 9, method: "run", depth: 1, sql: "SELECT 1" },
    ]);
  });

  it("an empty result is not evidence that nothing holds the lock — it is an absent record", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    // Tracing off: the holder exists, but wrote nothing. The caller must say so, and the
    // StoreBusyError message below is what proves it does.
    expect(readInflightStatements(dir)).toEqual([]);
  });
});

describe("a startup blocked by another process says so, and names it (#148)", () => {
  it("reports contention, the wait, and the holder recorded beside the store", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const holder = new BetterSqlitePort(dbPath);
    try {
      holder.acquireExclusiveOwnership(); // a real exclusive lock, not a simulated one
      // Stand in for what a traced holder writes while it works.
      writeFileSync(
        join(dir, `inflight-4242-0.json`),
        JSON.stringify({ v: 1, pid: 4242, dbPath, method: "immediateTransaction", startedAt: Date.now() - 30_000, depth: 1, sql: "BEGIN IMMEDIATE" }),
      );
      // Two distractors that must NOT be named: another database in the same directory, and a
      // marker predating the dbPath field, where "cannot tell" must not read as "this one".
      writeFileSync(
        join(dir, `inflight-9999-0.json`),
        JSON.stringify({ v: 1, pid: 9999, dbPath: join(dir, "other.db"), method: "run", startedAt: Date.now(), depth: 1, sql: "INSERT INTO other" }),
      );
      writeFileSync(
        join(dir, `inflight-7777-0.json`),
        JSON.stringify({ v: 1, pid: 7777, method: "run", startedAt: Date.now(), depth: 1, sql: "legacy marker, no dbPath" }),
      );

      let caught: unknown;
      try {
        new BetterSqlitePort(dbPath);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StoreBusyError);
      const busy = caught as StoreBusyError;
      expect(busy.dbPath).toBe(dbPath);
      expect(busy.waitedMs).toBeGreaterThan(0);
      expect(busy.holders.map((h) => h.pid)).toEqual([4242]);
      // The three questions the #148 afternoon was spent answering by hand.
      expect(busy.message).toMatch(/is busy/);
      expect(busy.message).toMatch(/after \d+ms/);
      expect(busy.message).toMatch(/pid 4242/);
      expect(busy.message).toMatch(/BEGIN IMMEDIATE/);
      expect(busy.message).not.toMatch(/pid 9999|pid 7777/); // wrong store, and unattributable
      // Evidence about the holder, not a claim of ownership: a marker is a record, not a lock.
      expect(busy.message).toMatch(/in flight against this store/);
      expect(busy.message).not.toMatch(/^Held by|\. Held by/);
    } finally {
      holder.close();
    }
  });

  /**
   * Codex review, PR #216. Reaching the failure means the instance never exists, so nothing else can
   * ever close what the constructor already took. An auto-created tracer owns a raw descriptor with
   * no finalizer, so a process retrying startup against a contended store leaks one per attempt —
   * which is precisely the situation this path exists for.
   */
  it("releases the connection and the tracer when setup fails, instead of leaking them per retry", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const holder = new BetterSqlitePort(dbPath);
    try {
      holder.acquireExclusiveOwnership();
      let closed = 0;
      const tracer = {
        begin: () => 0,
        end: () => {},
        close: () => { closed++; },
        inflightPath: join(dir, "inflight-fake.json"),
      };
      expect(() => new BetterSqlitePort(dbPath, { tracer })).toThrow(StoreBusyError);
      expect(closed).toBe(1);
    } finally {
      holder.close();
    }
  });

  it("with tracing off it says the RECORD is absent, not that no holder exists", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const holder = new BetterSqlitePort(dbPath);
    try {
      holder.acquireExclusiveOwnership();
      let caught: unknown;
      try {
        new BetterSqlitePort(dbPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StoreBusyError);
      const busy = caught as StoreBusyError;
      expect(busy.holders).toEqual([]);
      expect(busy.message).toMatch(/absent RECORD/);
      expect(busy.message).toMatch(/MONET_TRACE_SQL=1/);
      expect(busy.message).not.toMatch(/no holder\b/i);
      // An empty list has more than one cause, so the message must not settle on one of them:
      // a holder idle BETWEEN statements truncates its own marker while still holding the lock.
      expect(busy.message).toMatch(/idle between statements/);
      expect(busy.message).not.toMatch(/tracing is off, so/i);
    } finally {
      holder.close();
    }
  });
});

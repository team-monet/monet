/**
 * MIGRATE()'S SUPPRESSION FLAG MUST NOT LATCH (slice 3, FIX 1).
 *
 * `migrate()` sets `sync_meta.applying_remote = 1` while it adds the temporal columns, so the
 * sync-clock triggers do not treat a migration's own writes as user mutations. The old shape read
 * the prior value, set 1, worked, and restored THE VALUE IT READ in a `finally`. That is a
 * read-modify-write on a row every process sharing the store also writes, and it latches:
 *
 *   A reads prior = 0, sets 1
 *   B reads prior = 1        <- A's TRANSIENT, adopted as B's own "prior"
 *   B sets 1, works
 *   A restores 0
 *   B restores 1             <- B lands last. The store is stuck at 1 permanently: every later
 *                               open reads 1 as ITS prior and writes it straight back.
 *
 * A latched 1 silently disables sync-clock advancement for the store's whole remaining life, and no
 * crash is required to produce it — only two opens overlapping, which is ordinary for an MCP server
 * and a `monet` CLI call sharing one store (three processes were observed on one store in the
 * field).
 *
 * WHY TWO OS PROCESSES. better-sqlite3 is synchronous, so an engine constructed from inside another
 * engine's window necessarily finishes FIRST — the one ordering that does NOT latch. Only real
 * concurrency can put B's restore after A's. The overlap is forced with marker files rather than
 * sleeps, so neither branch depends on how fast the machine is.
 *
 * NO PRODUCTION SEAM. `MonetCore(db: string | StoragePort)` is already the documented injection
 * point ("a pre-built StoragePort to run the engine on an alternative backend / an in-test fake");
 * both sides wrap a real `BetterSqlitePort` in test code and run the shipped engine unmodified.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { BetterSqlitePort, type Statement, type StoragePort } from "../storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
const HOLDER = join(HERE, "fixtures", "applying-remote-holder.ts");

const READ_FLAG_SQL = `SELECT applying_remote AS value FROM sync_meta WHERE singleton = 1`;
const RESTORE_FLAG_SQL = `UPDATE sync_meta SET applying_remote = ? WHERE singleton = 1`;

/** A holder process pauses inside its window for this long when nothing signals it. Well under
 *  BetterSqlitePort's 5000ms busy timeout, so a blocked peer waits it out instead of failing. */
const HOLD_MS = 1200;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "monet-applying-remote-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const newCore = (db: string | StoragePort): MonetCore =>
  new MonetCore(db, { embedder: new HashingEmbeddingProvider() });

/** Read the flag on a connection of its own, so nothing about the engine's state can colour it. */
function flagOnDisk(dbPath: string): number {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare(`SELECT applying_remote AS value FROM sync_meta WHERE singleton = 1`).get() as { value: number }).value;
  } finally {
    raw.close();
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    sleepSync(10);
  }
  return false;
}

describe("migrate()'s applying_remote window", () => {
  it("an ordinary single-process open leaves the flag at 0", async () => {
    const dbPath = join(tempDir(), "monet-core.db");
    const core = newCore(dbPath);
    try {
      await core.store("The scheduler retries failed jobs with exponential backoff.", { circle: "latch" });
    } finally {
      core.close();
    }
    expect(flagOnDisk(dbPath)).toBe(0);

    // And on every reopen after it — the flag is not something an open is allowed to accumulate.
    for (let i = 0; i < 3; i++) newCore(dbPath).close();
    expect(flagOnDisk(dbPath)).toBe(0);
  });

  it("the transient 1 is never visible to another connection while the window is open", async () => {
    const dbPath = join(tempDir(), "monet-core.db");
    newCore(dbPath).close();

    // A reader opened BEFORE the window, so the observation costs nothing but a SELECT and cannot
    // be confused with contention over opening a connection.
    const observer = new Database(dbPath, { readonly: true });
    const readFlag = observer.prepare(`SELECT applying_remote AS value FROM sync_meta WHERE singleton = 1`);
    const seenMidWindow: number[] = [];

    const inner = new BetterSqlitePort(dbPath);
    const port: StoragePort = {
      prepare(sql: string): Statement {
        const stmt = inner.prepare(sql);
        if (sql !== `UPDATE sync_meta SET applying_remote = 1 WHERE singleton = 1`) return stmt;
        return {
          run: (...p: unknown[]) => {
            const result = stmt.run(...p);
            // What a CONCURRENT migrate() would adopt as its own "prior" if it read right now.
            seenMidWindow.push((readFlag.get() as { value: number }).value);
            return result;
          },
          get: (...p: unknown[]) => stmt.get(...p),
          all: (...p: unknown[]) => stmt.all(...p),
        };
      },
      exec: (sql) => inner.exec(sql),
      pragma: (source, options) => inner.pragma(source, options),
      transaction: (fn) => inner.transaction(fn),
      immediateTransaction: (fn) => inner.immediateTransaction(fn),
      inTransaction: inner.inTransaction ? () => inner.inTransaction!() : undefined,
      acquireExclusiveOwnership: () => inner.acquireExclusiveOwnership(),
      releaseExclusiveOwnership: () => inner.releaseExclusiveOwnership(),
      close: () => inner.close(),
    };

    const core = newCore(port);
    try {
      // The window really opened — otherwise the assertion below is about nothing.
      expect(seenMidWindow.length).toBeGreaterThan(0);
      // Under WAL a reader sees the last COMMITTED value. Inside a transaction the 1 is not
      // committed, so there is no instant at which another process could adopt it. This is the
      // whole race: kill the visibility and the latch has nothing to latch onto.
      expect(seenMidWindow).toEqual(seenMidWindow.map(() => 0));
    } finally {
      core.close();
      observer.close();
    }
    expect(flagOnDisk(dbPath)).toBe(0);
  }, 20_000);

  it("two real opens overlapping on one store leave the flag at 0, not latched at 1", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    {
      const seed = newCore(dbPath);
      await seed.store("The scheduler retries failed jobs with exponential backoff.", { circle: "latch" });
      seed.close();
    }
    expect(flagOnDisk(dbPath)).toBe(0);

    // A: a second process, paused inside its own applying_remote window.
    const holder = spawn(TSX, [HOLDER, dbPath, dir, String(HOLD_MS)], { stdio: ["ignore", "pipe", "pipe"] });
    let holderErr = "";
    holder.stderr.on("data", (c: Buffer) => { holderErr += c.toString(); });
    const holderExit = new Promise<number>((resolve) => holder.on("exit", (code) => resolve(code ?? -1)));

    expect(waitForFile(join(dir, "a-in-window"), 20_000)).toBe(true);

    // B: this process. Its port announces the moment it has read its own prior, and holds its
    // RESTORE until A has finished — which is what puts B's write last, the ordering that latches.
    let announced = false;
    let priorSeenByB: number | undefined;
    const inner = new BetterSqlitePort(dbPath);
    const port: StoragePort = {
      prepare(sql: string): Statement {
        const stmt = inner.prepare(sql);
        if (sql === READ_FLAG_SQL) {
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            all: (...p: unknown[]) => stmt.all(...p),
            get: (...p: unknown[]) => {
              const row = stmt.get(...p);
              if (!announced) { // first read only: the centroid repair reads the same flag later
                announced = true;
                priorSeenByB = (row as { value: number }).value;
                writeFileSync(join(dir, "b-read"), "1");
              }
              return row;
            },
          };
        }
        if (sql === RESTORE_FLAG_SQL) {
          let held = false;
          return {
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
            run: (...p: unknown[]) => {
              if (!held) { held = true; waitForFile(join(dir, "a-done"), 20_000); }
              return stmt.run(...p);
            },
          };
        }
        return stmt;
      },
      exec: (sql) => inner.exec(sql),
      pragma: (source, options) => inner.pragma(source, options),
      transaction: (fn) => inner.transaction(fn),
      immediateTransaction: (fn) => inner.immediateTransaction(fn),
      inTransaction: inner.inTransaction ? () => inner.inTransaction!() : undefined,
      acquireExclusiveOwnership: () => inner.acquireExclusiveOwnership(),
      releaseExclusiveOwnership: () => inner.releaseExclusiveOwnership(),
      close: () => inner.close(),
    };

    const b = newCore(port);
    b.close();
    expect(await holderExit).toBe(0);
    expect(holderErr).toBe("");

    // THE VERDICT. Pre-fix, B's read landed inside A's window, saw the transient 1, and wrote it
    // back last — the store ended latched at 1. Serialized, B's read cannot happen until A has
    // committed, so the only value B can adopt is the committed 0.
    // Asserted as ONE object so a failure prints both halves: what B adopted, and what the store
    // was left holding. Against the un-fixed engine this reads `{ priorSeenByB: 1, flagAfter: 1 }`
    // — the transient adopted, and the latch it produced.
    expect({ priorSeenByB, flagAfter: flagOnDisk(dbPath) }).toEqual({ priorSeenByB: 0, flagAfter: 0 });
  }, 30_000);
});

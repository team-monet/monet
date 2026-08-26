/**
 * A SECOND PROCESS that opens a store and PAUSES inside migrate()'s applying_remote window.
 *
 * Not a test itself — spawned by applying-remote-latch.test.ts (`tsx <this file> <dbPath>
 * <signalDir> <holdMs>`) because the interleaving under test cannot be produced in one thread.
 * better-sqlite3 is synchronous, so a second engine constructed from inside the first one's window
 * always finishes FIRST, and the latch needs the second engine to restore LAST. Two OS processes
 * are the only instrument that can order it either way.
 *
 * NO PRODUCTION SEAM IS INVOLVED. `MonetCore`'s constructor already accepts a pre-built
 * `StoragePort` — its own doc comment offers that for "an alternative backend / an in-test fake" —
 * so the pause is installed by wrapping the port here, in test code, and the engine under test is
 * the unmodified shipped one.
 *
 * Protocol, all via marker files in signalDir (a filesystem handshake rather than a sleep, so the
 * overlap is forced rather than hoped for):
 *   writes `a-in-window`  the moment migrate() has set applying_remote = 1
 *   waits  `b-read`       until the other process has read its own prior, or holdMs elapses
 *   writes `a-done`       once the engine is fully constructed and its window has closed
 *
 * The holdMs timeout is what the POST-FIX run needs, and it is now the ONLY way the wait ends:
 * with the window wrapped in a transaction the other process cannot reach it until this one
 * commits, and migrate() no longer reads the flag at all (it closes its window at a literal 0
 * rather than at whatever it found), so `b-read` is never written by anyone. It is deliberately
 * shorter than the 5000ms busy timeout so the blocked process waits rather than failing.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MonetCore } from "../../engine";
import { HashingEmbeddingProvider } from "../../embedding";
import { BetterSqlitePort, type Statement, type StoragePort } from "../../storage";

const SET_FLAG_SQL = `UPDATE sync_meta SET applying_remote = 1 WHERE singleton = 1`;

/** Block this thread without an event loop turn — the engine constructor is synchronous. */
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

/** Wraps `inner` so the FIRST `applying_remote = 1` write pauses after running. */
function pausingPort(inner: StoragePort, signalDir: string, holdMs: number): StoragePort {
  let paused = false;
  return {
    prepare(sql: string): Statement {
      const stmt = inner.prepare(sql);
      if (sql !== SET_FLAG_SQL) return stmt;
      return {
        run: (...params: unknown[]) => {
          const result = stmt.run(...params);
          // FIRST occurrence only: the centroid repair sets the same flag later in the same
          // constructor, and pausing there would time the handshake against the wrong window.
          if (!paused) {
            paused = true;
            writeFileSync(join(signalDir, "a-in-window"), "1");
            waitForFile(join(signalDir, "b-read"), holdMs);
          }
          return result;
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
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
}

const [dbPath, signalDir, holdMsRaw] = process.argv.slice(2);
if (dbPath === undefined || signalDir === undefined || holdMsRaw === undefined) {
  console.error("usage: applying-remote-holder <dbPath> <signalDir> <holdMs>");
  process.exit(2);
}

const core = new MonetCore(pausingPort(new BetterSqlitePort(dbPath), signalDir, Number(holdMsRaw)), {
  embedder: new HashingEmbeddingProvider(),
});
core.close();
writeFileSync(join(signalDir, "a-done"), "1");

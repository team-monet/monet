/**
 * THE FIXTURE PREPARATION HOLDS ONE WRITE LOCK FOR ITS WHOLE DURATION (scripts/fixture-lock.ts).
 *
 * The defect this closes is laundering, not corruption. scripts/reembed-store.ts rewrites every
 * observation and segment, and each rewrite must wait on an `await provider.embed(...)` — so the
 * writes cannot be one synchronous `db.transaction()`. As a sequence of short transactions, another
 * writer commits in one of the gaps and the baseline `MAX(created_at, updated_at)` taken at the end
 * absorbs it, recording a foreign write as part of the preparation. Every later check then passes,
 * because the marker itself certifies the contaminated state.
 *
 * TWO REAL CONNECTIONS ON A REAL FILE, because that is the only thing that proves exclusion. A
 * stub cannot: SQLITE_BUSY comes from SQLite's locking, not from any code here. The database is a
 * temp file in WAL mode — the journal mode a `.backup` of the live store inherits — since the two
 * candidate mechanisms differ precisely in how they behave under WAL.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireExclusiveWriteLock, releaseExclusiveWriteLock } from "../../scripts/fixture-lock";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A WAL database with one row, plus the short busy timeout that turns a block into a visible error. */
function makeDb(): { path: string; open: (opts?: { readonly?: boolean }) => Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), "fixture-lock-"));
  dirs.push(dir);
  const path = join(dir, "copy.db");
  const setup = new Database(path);
  setup.pragma("journal_mode = WAL");
  setup.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, embedding TEXT, updated_at INTEGER)");
  setup.prepare("INSERT INTO observations VALUES (1, 'old', 100)").run();
  setup.close();
  // 200ms: long enough that a lock genuinely free is acquired, short enough that a held one fails fast.
  return { path, open: (opts = {}) => new Database(path, { ...opts, timeout: 200 }) };
}

const writeAsSomeoneElse = (path: string): { ok: boolean; code?: string } => {
  const other = new Database(path, { timeout: 200 });
  try {
    other.prepare("INSERT INTO observations VALUES (2, 'intruder', 999)").run();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code };
  } finally {
    other.close();
  }
};

describe("fixture-lock — a second writer is excluded for the whole preparation", () => {
  it("PREMISE: without the lock, a second connection writes freely mid-preparation", async () => {
    // If this ever stops holding, every assertion below passes vacuously.
    const { path, open } = makeDb();
    const db = open();
    try {
      db.prepare("UPDATE observations SET embedding = 'new' WHERE id = 1").run();
      await new Promise((r) => setTimeout(r, 10)); // the await gap an embed call opens
      expect(writeAsSomeoneElse(path).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("holds across await gaps and refuses a second writer with SQLITE_BUSY", async () => {
    const { path, open } = makeDb();
    const db = open();
    try {
      acquireExclusiveWriteLock(db, "test preparation");
      db.prepare("UPDATE observations SET embedding = 'new' WHERE id = 1").run();
      // The gap that made short per-row transactions unsafe. better-sqlite3 is synchronous and
      // nothing else runs on this connection, so the transaction is still open on the far side.
      await new Promise((r) => setTimeout(r, 10));
      expect(db.inTransaction).toBe(true);

      const intruder = writeAsSomeoneElse(path);
      expect(intruder.ok).toBe(false);
      expect(intruder.code).toBe("SQLITE_BUSY");
    } finally {
      releaseExclusiveWriteLock(db);
      db.close();
    }
  });

  it("still lets a second connection READ — the contract excludes writers, not observers", () => {
    // This is why BEGIN IMMEDIATE was chosen over `PRAGMA locking_mode = EXCLUSIVE`, which blocks
    // readers too and would stop a measure-* header from inspecting the copy.
    const { path, open } = makeDb();
    const db = open();
    try {
      acquireExclusiveWriteLock(db, "test preparation");
      db.prepare("UPDATE observations SET embedding = 'new' WHERE id = 1").run();
      const reader = new Database(path, { readonly: true, timeout: 200 });
      try {
        expect(reader.prepare("SELECT embedding AS e FROM observations WHERE id = 1").get())
          .toEqual({ e: "old" }); // pre-commit: the reader sees the last committed state
      } finally {
        reader.close();
      }
    } finally {
      releaseExclusiveWriteLock(db);
      db.close();
    }
  });

  it("the baseline read under the lock cannot contain a foreign write", async () => {
    // The finding, end to end: a writer trying to interleave fails, so MAX(updated_at) taken before
    // release sees only what the preparation itself wrote.
    const { path, open } = makeDb();
    const db = open();
    try {
      acquireExclusiveWriteLock(db, "test preparation");
      db.prepare("UPDATE observations SET embedding = 'new', updated_at = 500 WHERE id = 1").run();
      await new Promise((r) => setTimeout(r, 10));
      expect(writeAsSomeoneElse(path).ok).toBe(false); // would have landed updated_at = 999

      const baseline = (db.prepare("SELECT MAX(updated_at) AS t FROM observations").get() as { t: number }).t;
      expect(baseline).toBe(500);
    } finally {
      releaseExclusiveWriteLock(db);
      db.close();
    }
  });

  it("releases on COMMIT, and everything written under it lands at once", () => {
    const { path, open } = makeDb();
    const db = open();
    try {
      acquireExclusiveWriteLock(db, "test preparation");
      db.prepare("UPDATE observations SET embedding = 'new' WHERE id = 1").run();
      releaseExclusiveWriteLock(db);
      expect(db.inTransaction).toBe(false);
      expect(writeAsSomeoneElse(path).ok).toBe(true);
      const after = new Database(path, { readonly: true });
      try {
        expect(after.prepare("SELECT embedding AS e FROM observations WHERE id = 1").get()).toEqual({ e: "new" });
      } finally {
        after.close();
      }
    } finally {
      db.close();
    }
  });

  it("an interrupt rolls the rewrites back and leaks no lock — the next writer proceeds", () => {
    // A killed process never reaches COMMIT. Closing without one is the same state SQLite recovers
    // to when the OS closes the fd: the transaction is discarded and the lock is gone.
    const { path, open } = makeDb();
    const db = open();
    acquireExclusiveWriteLock(db, "test preparation");
    db.prepare("UPDATE observations SET embedding = 'half-written' WHERE id = 1").run();
    db.close(); // no COMMIT — the interrupt

    expect(writeAsSomeoneElse(path).ok).toBe(true);
    const after = new Database(path, { readonly: true });
    try {
      expect(after.prepare("SELECT embedding AS e FROM observations WHERE id = 1").get()).toEqual({ e: "old" });
    } finally {
      after.close();
    }
  });

  it("refuses with a directive message rather than waiting when someone else holds the lock", () => {
    const { path, open } = makeDb();
    const holder = open();
    const second = open();
    try {
      acquireExclusiveWriteLock(holder, "the first preparation");
      holder.prepare("UPDATE observations SET embedding = 'new' WHERE id = 1").run();
      expect(() => acquireExclusiveWriteLock(second, "a second preparation"))
        .toThrow(/exactly one writer while it is prepared/);
      expect(() => acquireExclusiveWriteLock(second, "a second preparation"))
        .toThrow(/SQLITE_BUSY/);
    } finally {
      releaseExclusiveWriteLock(holder);
      holder.close();
      second.close();
    }
  });
});

/**
 * The ORDER inside reembed-store.ts is load-bearing and invisible to any unit test of the lock
 * itself, so it is asserted on the source — the same technique the measure-* classification uses.
 */
describe("reembed-store — what happens inside the lock, and what deliberately does not", () => {
  const source = (): string =>
    readFileSync(new URL("../../scripts/reembed-store.ts", import.meta.url), "utf8");

  const indexOfAll = (src: string, needles: string[]): number[] =>
    needles.map((n) => {
      const i = src.indexOf(n);
      expect(i, `expected to find ${n}`).toBeGreaterThan(-1);
      return i;
    });

  it("opens the marker BEFORE taking the lock, so an interrupted run still reads as interrupted", () => {
    const [markerInsert, acquire] = indexOfAll(source(), [
      "INSERT INTO reembed_provenance", "acquireExclusiveWriteLock(",
    ]);
    expect(markerInsert).toBeLessThan(acquire);
  });

  it("snapshots the populations INSIDE the lock, so no row can appear that it will not rewrite", () => {
    const [acquire, segSnapshot, obsSnapshot] = indexOfAll(source(), [
      "acquireExclusiveWriteLock(",
      "FROM observation_segments s",
      "SELECT id, content FROM observations WHERE kind != 'source'",
    ]);
    expect(acquire).toBeLessThan(segSnapshot);
    expect(acquire).toBeLessThan(obsSnapshot);
  });

  it("reads the baseline and publishes the marker BEFORE releasing", () => {
    const [baseline, publish, release] = indexOfAll(source(), [
      "const rowsMaxAt = ",
      "UPDATE reembed_provenance SET completed_at = ?, rows_max_at = ?",
      "releaseExclusiveWriteLock(",
    ]);
    expect(baseline).toBeLessThan(release);
    expect(publish).toBeLessThan(release);
  });

  it("no longer wraps individual rewrites in their own transactions", () => {
    // Per-row `db.transaction(...)` is what allowed the interleaving; under the enclosing lock it
    // would only add a savepoint per write, and its presence would suggest the lock is not there.
    expect(source()).not.toMatch(/db\.transaction\(\(\) => upd(Seg|Obs)\.run/);
  });
});

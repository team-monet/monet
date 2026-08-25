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
import { acquireExclusiveWriteLock, publishFixtureMarker, releaseExclusiveWriteLock } from "../../scripts/fixture-lock";

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
 * TWO PREPARATIONS STARTING TOGETHER — the gap the write lock structurally cannot close.
 *
 * The opening marker is committed BEFORE the lock so an interrupted run stays visible as one. That
 * leaves a window: A and B both run phase-1, B's `ON CONFLICT DO UPDATE` overwrites A's identity
 * columns, and only then does one of them win the lock and rewrite. A completion keyed on
 * `singleton = 1` alone would stamp "valid" onto B's description of a store A had just written with
 * a different model — a fixture that passes every downstream check while naming the wrong model.
 */
describe("fixture-lock — a run publishes only onto the marker it opened", () => {
  const MARKER_DDL = `
    CREATE TABLE reembed_provenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      candidate_model_id TEXT, requested_model TEXT NOT NULL, pooling TEXT, dtype TEXT,
      measured_dim INTEGER NOT NULL, populations TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER, rows_max_at INTEGER, run_token TEXT NOT NULL)`;

  /** Exactly reembed-store.ts's phase-1 statement, including its ON CONFLICT clause. */
  const openMarker = (db: Database.Database, model: string, token: string, startedAt: number): void => {
    db.prepare(
      `INSERT INTO reembed_provenance
         (singleton, candidate_model_id, requested_model, pooling, dtype, measured_dim, populations,
          started_at, completed_at, run_token)
       VALUES (1, ?, ?, NULL, NULL, 384, 'obs+segs', ?, NULL, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         candidate_model_id = excluded.candidate_model_id, requested_model = excluded.requested_model,
         measured_dim = excluded.measured_dim, started_at = excluded.started_at,
         completed_at = NULL, run_token = excluded.run_token`,
    ).run(model, model, startedAt, token);
  };

  const makeMarkerDb = (): Database.Database => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-marker-"));
    dirs.push(dir);
    const db = new Database(join(dir, "copy.db"));
    db.pragma("journal_mode = WAL");
    db.exec(MARKER_DDL);
    return db;
  };

  it("REFUSES to publish onto a marker another preparation replaced, and leaves it incomplete", () => {
    const db = makeMarkerDb();
    try {
      const tokenA = "run-A";
      const tokenB = "run-B";
      openMarker(db, "model-A", tokenA, 1000);            // A opens
      openMarker(db, "model-B", tokenB, 2000);            // B starts and overwrites A's row

      // A wins the lock, rewrites with model A, and tries to complete.
      const result = publishFixtureMarker(db, tokenA, 3000, 9999);
      expect(result.published).toBe(false);
      expect(result.changes).toBe(0);

      // The marker is untouched: still B's identity, still incomplete. A copy in this state reads as
      // an interrupted preparation, which is exactly what it is.
      const row = db.prepare(
        `SELECT candidate_model_id AS m, completed_at AS c, rows_max_at AS r, run_token AS t
           FROM reembed_provenance WHERE singleton = 1`,
      ).get() as { m: string; c: number | null; r: number | null; t: string };
      expect(row).toEqual({ m: "model-B", c: null, r: null, t: tokenB });
    } finally {
      db.close();
    }
  });

  it("PREMISE: a completion keyed on singleton alone would have published onto B's marker", () => {
    // The pre-fix statement, verbatim. If this ever stops succeeding, the test above proves nothing.
    const db = makeMarkerDb();
    try {
      openMarker(db, "model-A", "run-A", 1000);
      openMarker(db, "model-B", "run-B", 2000);
      const legacy = db.prepare(
        `UPDATE reembed_provenance SET completed_at = ?, rows_max_at = ? WHERE singleton = 1`,
      ).run(3000, 9999);
      expect(legacy.changes).toBe(1);
      const row = db.prepare(
        `SELECT candidate_model_id AS m, completed_at AS c FROM reembed_provenance WHERE singleton = 1`,
      ).get() as { m: string; c: number };
      // A's rewrite, certified valid, attributed to B. The defect, reproduced.
      expect(row).toEqual({ m: "model-B", c: 3000 });
    } finally {
      db.close();
    }
  });

  it("publishes normally for a single run — the ordinary path is unchanged", () => {
    const db = makeMarkerDb();
    try {
      openMarker(db, "model-A", "run-A", 1000);
      const result = publishFixtureMarker(db, "run-A", 3000, 9999);
      expect(result).toEqual({ published: true, changes: 1 });
      expect(db.prepare(
        `SELECT completed_at AS c, rows_max_at AS r FROM reembed_provenance WHERE singleton = 1`,
      ).get()).toEqual({ c: 3000, r: 9999 });
    } finally {
      db.close();
    }
  });

  it("a re-run by the same script mints a NEW token, so a stale one cannot publish afterwards", () => {
    const db = makeMarkerDb();
    try {
      openMarker(db, "model-A", "run-A", 1000);
      expect(publishFixtureMarker(db, "run-A", 3000, 9999).published).toBe(true);
      openMarker(db, "model-A", "run-A2", 4000);  // same model, second run
      // The first run's token no longer owns the row, even though nothing else changed.
      expect(publishFixtureMarker(db, "run-A", 5000, 1).published).toBe(false);
      expect(publishFixtureMarker(db, "run-A2", 5000, 1).published).toBe(true);
    } finally {
      db.close();
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
      "publishFixtureMarker(db, RUN_TOKEN,",
      "releaseExclusiveWriteLock(",
    ]);
    expect(baseline).toBeLessThan(release);
    expect(publish).toBeLessThan(release);
    // And the publish is guarded: an unchecked result would republish onto whatever marker is there.
    expect(source()).toMatch(/if \(!published\.published\)/);
  });

  it("normalizes the copy's sync triggers UNDER the lock and BEFORE the rewrites", () => {
    // The trigger counter is what detects a later engine write. It only counts while the triggers
    // are on, and it must be on before this run's own writes so the baseline contains them.
    const [acquire, normalize, firstRewrite] = indexOfAll(source(), [
      "acquireExclusiveWriteLock(",
      "UPDATE sync_meta SET applying_remote = 0",
      "updSeg.run(",
    ]);
    expect(acquire).toBeLessThan(normalize);
    expect(normalize).toBeLessThan(firstRewrite);
  });

  it("refuses to prepare anything inside a .monet directory", () => {
    // The normalization writes sync_meta, not just vectors, so "point it at a copy" needed to stop
    // being prose. The guard is a heuristic and the comment beside it says so.
    const src = source();
    expect(src).toMatch(/\/\(\^\|\\\/\)\\\.monet\\\/\/\.test\(DB\)/);
    expect(src).toMatch(/Refusing to prepare/);
  });

  it("records the normalization in the marker rather than still claiming sync_meta is untouched", () => {
    const src = source();
    expect(src).toMatch(/sync_meta\.applying_remote normalized to 0/);
    expect(src).not.toMatch(/concepts and sync_meta UNTOUCHED/);
  });

  it("opens the marker with a run token, so the publish has something to verify ownership against", () => {
    const src = source();
    expect(src).toMatch(/const RUN_TOKEN = randomUUID\(\);/);
    expect(src).toMatch(/run_token TEXT NOT NULL/);
    // The ON CONFLICT path must claim the token too, or a second run would inherit the first's.
    expect(src).toMatch(/run_token = excluded\.run_token/);
  });

  it("no longer wraps individual rewrites in their own transactions", () => {
    // Per-row `db.transaction(...)` is what allowed the interleaving; under the enclosing lock it
    // would only add a savepoint per write, and its presence would suggest the lock is not there.
    expect(source()).not.toMatch(/db\.transaction\(\(\) => upd(Seg|Obs)\.run/);
  });
});

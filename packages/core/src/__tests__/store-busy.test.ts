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
import { BetterSqlitePort, StoreBusyError, schemaRegionContentionError, storeContentionError } from "../storage";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";

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

/**
 * #82: the two halves above are the ENDS of startup — no contention, and contention on the very
 * first connection open (BetterSqlitePort's own constructor, which has translated since #148).
 * This describe covers the MIDDLE: contention that is already present, or arrives, while
 * MonetCore's constructor runs its schema/migration statements — after the connection is open.
 *
 * WHY THAT WINDOW EXISTS AT ALL, and why it is not exotic. In WAL mode a writer does not block
 * readers, so opening a second connection against a store whose write lock is held succeeds:
 * `new Database()` executes no SQL, and `journal_mode = WAL` against an already-WAL file is a read.
 * The first thing that actually needs the write lock is `init()`'s `CREATE TABLE IF NOT EXISTS`
 * — the first statement of the constructor's schema region. So the ordinary supported topology
 * (an MCP server and a `monet` CLI call sharing one `.monet` DB) reaches the region, not the open.
 *
 * These tests do not simulate the lock: a second BetterSqlitePort holds a real `BEGIN IMMEDIATE`
 * write reservation, and the statements under test fail against it for real.
 */
describe("contention DURING the constructor's schema region, not at the open (#82)", () => {
  it("translates on the path branch: a write lock held while the schema statements run", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const holder = new BetterSqlitePort(dbPath); // creates the file and puts it in WAL
    try {
      holder.exec("BEGIN IMMEDIATE"); // a real write reservation, held for the whole construction
      let caught: unknown;
      try {
        new MonetCore(dbPath);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StoreBusyError);
      const busy = caught as StoreBusyError;
      expect(busy.dbPath).toBe(dbPath);
      expect(busy.waitedMs).toBeGreaterThan(0);
      expect(busy.message).toMatch(/is busy/);
      // A DURATION IS STILL REPORTED, but as the region's elapsed time rather than as a wait: this
      // line read /after \d+ms/ until the review of this PR showed the region cannot honestly make
      // the open path's claim. The wording distinction itself is pinned by its own test below.
      expect(busy.message).toMatch(/running for \d+ms/);
      // The original is kept, not replaced: the SQLite code stays reachable for anyone who wants it.
      expect((busy.cause as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");
    } finally {
      try { holder.exec("ROLLBACK"); } catch { /* the assertions above are the news */ }
      holder.close();
    }
  });

  /**
   * KNOWN UNFIXED, asserted deliberately so the gap is pinned rather than forgotten (#82 stays
   * open for it). `storeContentionError` needs the store's path; a caller-supplied StoragePort
   * exposes none (`BetterSqlitePort.dbPath` is private, and the interface has no path member), so
   * this branch cannot produce the translated message and still surfaces SQLite's own text.
   * `packages/cli/src/repair-cli.ts` builds MonetCore this way, which is why `monet doctor` and
   * `monet repair` keep the bare behaviour. When that is closed, this test flips.
   */
  it("KNOWN UNFIXED — the StoragePort branch still surfaces the bare SQLite error", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const holder = new BetterSqlitePort(dbPath);
    // Opened BEFORE the lock is taken, so the port's own constructor (which does translate) is not
    // what fails here — the failure lands in the region, exactly as in the test above.
    const port = new BetterSqlitePort(dbPath);
    // The default is 5000ms and this test does not measure the wait, only what is thrown.
    port.pragma("busy_timeout = 200");
    try {
      holder.exec("BEGIN IMMEDIATE");
      let caught: unknown;
      try {
        new MonetCore(port);
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeInstanceOf(StoreBusyError);
      expect((caught as Error).message).toMatch(/database is locked/);
      expect((caught as { code?: string }).code).toBe("SQLITE_BUSY");
    } finally {
      try { holder.exec("ROLLBACK"); } catch { /* same */ }
      port.close();
      holder.close();
    }
  });

  /**
   * The catch must be a translator, not a net. `initSyncIdentity` throws a plain Error from inside
   * the region on a device-id mismatch — an ordinary failure with nothing to do with contention.
   */
  it("re-throws a non-contention failure from inside the region unchanged", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    const first = new MonetCore(dbPath, { syncDeviceId: "device-alpha" });
    first.close();

    let caught: unknown;
    try {
      new MonetCore(dbPath, { syncDeviceId: "device-beta" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StoreBusyError);
    expect((caught as Error).message).toBe("syncDeviceId mismatch: store is 'device-alpha', requested 'device-beta'");
  });
});

/**
 * FINDING A, from the review of this PR. `storeContentionError` is SHARED with the connection open,
 * where its number genuinely is a measured wait — but the region reuses it for a number that is not
 * one, and the sentence said "could not take its write lock after 8035ms" for a wait of 5000ms.
 *
 * WHY THAT NUMBER CANNOT BE A WAIT, structurally rather than by measurement: `busy_timeout = 5000`
 * (storage.ts) caps ONE statement's wait at 5000ms, so anything above that is prefix work inside the
 * region. `repairDriftedConceptCentroids()` supplies it — a grouped scan of every live observation,
 * holding the whole live vector population in memory before it writes — and #95 and #97 re-armed the
 * centroid and lexical gates, so both passes run on the first open of every existing store.
 *
 * WHY IT IS HARMFUL rather than merely imprecise: the message's own closing sentence tells an
 * operator that a wait which never ends means the holder is WEDGED rather than busy. An inflated
 * number argues for that conclusion about a holder that behaved perfectly normally.
 *
 * The two paths are asserted AGAINST EACH OTHER on purpose. Asserting that the region produces some
 * message is not coverage of a fix whose whole content is that the two callers must say different
 * things — and the open path's wording has to survive intact, because for the open path it is true.
 */
describe("the region's elapsed time is not a lock wait, and the message must not say it is", () => {
  it("says 'had been running for' on the region path and keeps 'wait' for the OPEN path only", () => {
    // SEPARATE STORES for the two halves, not one. The region half leaves MonetCore's connection
    // open when it throws (a pre-existing leak this PR did not introduce and does not close), and an
    // exclusive-ownership acquisition in the open half must not have to race that leftover handle.
    const regionDir = tempDir();
    const regionPath = join(regionDir, "monet-core.db");
    const openDir = tempDir();
    const openPath = join(openDir, "monet-core.db");

    // THE REGION PATH. In WAL mode the open does NOT block, so the connection is established and the
    // first statement needing the write lock — init()'s CREATE TABLE — is what meets the holder.
    const regionHolder = new BetterSqlitePort(regionPath);
    let region: StoreBusyError;
    try {
      regionHolder.exec("BEGIN IMMEDIATE"); // a real write reservation, held across the construction
      let caught: unknown;
      try {
        new MonetCore(regionPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StoreBusyError);
      region = caught as StoreBusyError;
    } finally {
      try { regionHolder.exec("ROLLBACK"); } catch { /* the assertions below are the news */ }
      regionHolder.close();
    }

    // THE OPEN PATH, for comparison: an exclusive lock, so the connection setup itself is what waits.
    const openHolder = new BetterSqlitePort(openPath);
    let open: StoreBusyError;
    try {
      openHolder.acquireExclusiveOwnership();
      let caught: unknown;
      try {
        new BetterSqlitePort(openPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StoreBusyError);
      open = caught as StoreBusyError;
    } finally {
      openHolder.close();
    }

    // UNCHANGED where it was already true. The open path measured an actual wait, and still says so.
    expect(open.message).toMatch(/could not take its write lock after \d+ms/);
    expect(open.message).not.toMatch(/had been running for/);

    // The region path must never make the open path's claim about a number that cannot support it.
    expect(region.message).not.toMatch(/could not take its write lock after \d+ms/);
    // What the number actually is...
    expect(region.message).toMatch(/had been running for \d+ms/);
    // ...said as elapsed rather than as waiting, in words and not only by omission...
    expect(region.message).toMatch(/elapsed time, not a wait/);
    // ...and the one bound that makes the real wait knowable from the message alone.
    expect(region.message).toMatch(/bounded by this connection's 5000ms busy_timeout/);

    // Both are still the same diagnosis about the same kind of trouble, and still name their store.
    expect(open.message).toMatch(/is busy/);
    expect(open.message).toContain(openPath);
    expect(region.message).toMatch(/is busy/);
    expect(region.message).toContain(regionPath);
  });
});

/**
 * FINDING A, from the SECOND review round of this PR. Widening the translated window from the
 * connection open to the whole schema region also widened what the contention predicate is exposed
 * to, and the predicate has a bare `/database is locked/i` message arm.
 *
 * WHY THAT ARM IS SAFE WHERE IT WAS WRITTEN AND NOT HERE. The open path's catch wraps
 * `new Database()` and two pragmas — a driver error is the only thing that can reach it. The region
 * runs MonetCore's entire construction: ~10 statements plus every migration and repair pass, each
 * free to throw anything. `initSyncIdentity` quotes a device id the CALLER supplied, so the phrase
 * can arrive inside an error that has nothing to do with SQLite.
 *
 * WHAT THE MISTRANSLATION COSTS is not a wording nit: the operator is told a write lock could not be
 * taken, sent to look for the holder, and advised to retry — for a device-id mismatch that will fail
 * identically forever. The reproduction below is the review's own.
 *
 * NARROWED ON THIS PATH ONLY. The message arm still exists for contention SQLite reports without a
 * code, and startup-diagnosis.test.ts depends on the open path admitting exactly that shape. The
 * last test here pins the open path's message against its own bytes for the very input the region
 * now rejects.
 */
describe("the region translates SQLite's contention and nothing else (#102 review, finding A)", () => {
  const FIXED = "/nonexistent-monet-region-predicate-dir/monet.db";

  it("a genuine SQLITE_BUSY still translates", () => {
    // The end-to-end proof against a real held lock is "translates on the path branch", above; this
    // is the same case at the predicate, so the narrowing cannot quietly take the code path with it.
    const busy = schemaRegionContentionError(FIXED, Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), 8035);
    expect(busy).toBeInstanceOf(StoreBusyError);
    expect(busy?.message).toMatch(/had been running for 8035ms/);

    const locked = schemaRegionContentionError(FIXED, Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED" }), 10);
    expect(locked).toBeInstanceOf(StoreBusyError);
  });

  it("a codeless lock report from SQLite still translates — the case the message arm exists for", () => {
    // No code anywhere, identified only by the class that threw it. Measured on this driver, a real
    // contended statement carries name "SqliteError"; the arm exists because #148 recorded SQLite
    // reporting contention without a code, and narrowing must not delete that case.
    const bare = Object.assign(new Error("database is locked"), { name: "SqliteError" });
    expect((bare as { code?: unknown }).code).toBeUndefined();
    expect(schemaRegionContentionError(FIXED, bare, 42)).toBeInstanceOf(StoreBusyError);
  });

  it("a non-SQLite error carrying the phrase is NOT contention — the review's repro, end to end", () => {
    const dir = tempDir();
    const dbPath = join(dir, "monet-core.db");
    // The phrase reaches the region inside an ordinary error, through a value the CALLER chose.
    const first = new MonetCore(dbPath, { syncDeviceId: "device-a" });
    first.close();

    let caught: unknown;
    try {
      new MonetCore(dbPath, { syncDeviceId: "database is locked" });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(StoreBusyError);
    expect((caught as Error).message).toBe("syncDeviceId mismatch: store is 'device-a', requested 'database is locked'");
    // Nothing about a lock survives into what the operator reads: no wait, no holder, no retry.
    expect((caught as Error).message).not.toMatch(/is busy|write lock|retry/);
  });

  it("an error whose code accessor throws is left alone, not replaced by the inspection", () => {
    // THE GATE RUNS INSIDE THE CONSTRUCTOR'S CATCH, so a throw from classifying does not fall
    // through to `?? error` — it replaces the constructor's real failure with a TypeError raised by
    // the inspection itself. The caller-supplied read that once made this reachable is gone (the
    // embedder identity is resolved before the region opens, #102's root-cause round); this stays
    // because the errors our OWN statements raise are still not ours to assume inspectable.
    const poisoned = new Error("the failure the caller actually needs to see");
    Object.defineProperty(poisoned, "code", {
      get() {
        throw new TypeError("poisoned code getter");
      },
    });

    // Classification refuses rather than throwing: an uninspectable code is not SQLite's code.
    expect(() => schemaRegionContentionError(FIXED, poisoned, 5000)).not.toThrow();
    expect(schemaRegionContentionError(FIXED, poisoned, 5000)).toBeUndefined();

    // And a poisoned code must not cost an error that IS SQLite's — the name arm still answers.
    const named = new Error("database is locked");
    named.name = "SqliteError";
    Object.defineProperty(named, "code", {
      get() {
        throw new TypeError("poisoned code getter");
      },
    });
    expect(schemaRegionContentionError(FIXED, named, 5000)).toBeInstanceOf(StoreBusyError);
  });

  it("a throwing name or message accessor is a no, not a throw — the whole classification is guarded", () => {
    // THE SAME HAZARD AS THE code GETTER, one property along. `name` is read by the region gate and
    // `message` by the contention predicate, and both run inside the constructor's catch, so an
    // unreadable one used to replace the failure being classified. Every arm is guarded now; a
    // partial guard just moves the throw to the next read, which is how the code arm's fix went.
    const poisonedName = new Error("the failure the caller actually needs to see");
    Object.defineProperty(poisonedName, "name", {
      get() {
        throw new TypeError("poisoned name getter");
      },
    });
    expect(() => schemaRegionContentionError(FIXED, poisonedName, 5000)).not.toThrow();
    expect(schemaRegionContentionError(FIXED, poisonedName, 5000)).toBeUndefined();

    // A readable SqliteError name gets past the gate, and then the message arm must not throw either.
    const poisonedMessage = new Error("readable at construction");
    poisonedMessage.name = "SqliteError";
    Object.defineProperty(poisonedMessage, "message", {
      get() {
        throw new TypeError("poisoned message getter");
      },
    });
    expect(() => schemaRegionContentionError(FIXED, poisonedMessage, 5000)).not.toThrow();
    expect(schemaRegionContentionError(FIXED, poisonedMessage, 5000)).toBeUndefined();

    // And the open path, which shares the contention predicate, is equally unable to throw.
    expect(() => storeContentionError(FIXED, poisonedMessage, 5000)).not.toThrow();
  });

  it("the OPEN path still admits that same error, byte for byte", () => {
    const carrier = new Error("syncDeviceId mismatch: store is 'device-a', requested 'database is locked'");
    // THE INPUT THE REGION NOW REJECTS, asserted against the open path's own pre-change bytes rather
    // than a regex — a narrowing that leaked into the shared predicate would change this string, and
    // a pattern loose enough to keep matching is exactly what would hide it.
    expect(storeContentionError(FIXED, carrier, 5000)?.message).toBe(
      "The store at /nonexistent-monet-region-predicate-dir/monet.db is busy: could not take its write lock after 5000ms. " +
      "Nothing beside the store records who holds it. That happens when statement tracing is off (set MONET_TRACE_SQL=1 on " +
      "every monet process sharing this store and reproduce), and also when the holder is idle between statements while " +
      "keeping the lock — an absent RECORD either way, never an absent holder. One MCP server and one `monet` CLI call " +
      "sharing a store is the supported topology, so this is usually transient — retry once the other process finishes. If " +
      "nothing ever finishes, the holder is wedged rather than busy.",
    );
    // And the two paths now disagree about it, which is the whole content of this fix.
    expect(schemaRegionContentionError(FIXED, carrier, 5000)).toBeUndefined();
  });
});

/**
 * ROUND 5, AND THE ROOT CAUSE UNDER ALL THREE ROUNDS OF THIS PR. The first two findings were a
 * poisoned `code` getter and a poisoned `name`/`message`; both were answered by guarding the reads
 * inside the classifier. The third was different in kind: a GENUINE SQLite error — `name:
 * "SqliteError"`, `code: "SQLITE_BUSY"`, `message: "database is locked"` — raised from a DIFFERENT
 * database, which every guard above admits because it is, byte for byte, what our own contention
 * looks like. No inspection of an error can decide whether it belongs to THIS connection, so the
 * classifier cannot be made sound by asking it better questions.
 *
 * THE PROPERTY THESE TESTS PIN, and the reason they exist as a group: `this.embedder` is read ZERO
 * times inside the constructor's guarded schema region. The fix is not a smarter classifier — it is
 * that caller-supplied code does not run in there at all, so nothing it raises ever reaches the
 * catch. The embedder identity is resolved into locals before the region opens and threaded to the
 * sites that used to re-read it (see the capture's comment in engine.ts).
 *
 * WHY BOTH PATHS BELOW, when they look like the same test twice. The getter was read from FOUR
 * places in the region, and which one throws first depends on the store: a FRESH store reaches
 * `initSyncIdentity`'s stable-identity check first, while a REOPEN of a pinned store early-returns
 * out of `initSyncIdentity` entirely and meets `migrate()`'s graph-backfill check instead. A test
 * covering one path leaves the other's read site free to come back.
 *
 * The last two tests are the other half of the contract. Translation of REAL contention is the whole
 * point of #82 and must survive; and the captured identity must be the SAME value the region's sites
 * read before, `dim:N` fallback included, or the capture has quietly changed what the pin means.
 */
describe("the guarded schema region runs no caller-supplied code (#102, root cause)", () => {
  /** The only caller-supplied surface the region ever read: `this.embedder`'s own `modelId` getter. */
  function embedderWhoseModelIdThrows(raise: () => unknown): EmbeddingProvider {
    const base = new HashingEmbeddingProvider(256);
    return new Proxy(base, {
      get(target, prop) {
        if (prop === "modelId") throw raise();
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as EmbeddingProvider;
  }

  /** A real modelId-less provider: `embedderModelId` falls back to `dim:${dim}` for it. */
  function anonymousEmbedder(): EmbeddingProvider {
    const base = new HashingEmbeddingProvider(256);
    return new Proxy(base, {
      get(target, prop) {
        if (prop === "modelId") return undefined;
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as EmbeddingProvider;
  }

  /**
   * SQLite's contention, exactly as this driver reports it — measured on a real contended CREATE
   * TABLE (see isSqliteError). Raised here by a caller's getter against a database that is not this
   * store, which is precisely the error no classifier can tell from our own.
   */
  function foreignSqliteBusy(): Error {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    error.name = "SqliteError";
    return error;
  }

  function expectPropagatedUntouched(caught: unknown): void {
    // NOT translated: the operator must not be sent after a holder of a lock nobody took.
    expect(caught).not.toBeInstanceOf(StoreBusyError);
    // And not replaced by the inspection either — the caller's own error arrives whole.
    expect((caught as Error).name).toBe("SqliteError");
    expect((caught as { code?: unknown }).code).toBe("SQLITE_BUSY");
    expect((caught as Error).message).toBe("database is locked");
  }

  it("FRESH store: a foreign SQLITE_BUSY from the caller's modelId getter is not this store's contention", () => {
    const dbPath = join(tempDir(), "monet-core.db");
    let caught: unknown;
    try {
      new MonetCore(dbPath, { embedder: embedderWhoseModelIdThrows(foreignSqliteBusy) });
    } catch (error) {
      caught = error;
    }
    expectPropagatedUntouched(caught);
  });

  it("REOPEN of a pinned store: the same error, arriving at the region's OTHER read site", () => {
    const dbPath = join(tempDir(), "monet-core.db");
    // The pin makes this a reopen rather than a fresh store: initSyncIdentity early-returns, so the
    // read that used to fire is migrate()'s graph-backfill trustworthiness check, not the pin write.
    new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256) }).close();

    let caught: unknown;
    try {
      new MonetCore(dbPath, { embedder: embedderWhoseModelIdThrows(foreignSqliteBusy) });
    } catch (error) {
      caught = error;
    }
    expectPropagatedUntouched(caught);
  });

  it("REAL contention still translates — the half of the contract the two tests above must not cost", () => {
    // Here to be read beside them: a change that "fixed" the foreign case by narrowing translation
    // away, rather than by moving the foreign code out of the region, fails right here.
    const dbPath = join(tempDir(), "monet-core.db");
    const holder = new BetterSqlitePort(dbPath);
    let caught: unknown;
    try {
      holder.exec("BEGIN IMMEDIATE"); // a real write reservation, held across the construction
      try {
        new MonetCore(dbPath);
      } catch (error) {
        caught = error;
      }
    } finally {
      try { holder.exec("ROLLBACK"); } catch { /* the assertions below are the news */ }
      holder.close();
    }

    expect(caught).toBeInstanceOf(StoreBusyError);
    expect((caught as StoreBusyError).message).toMatch(/had been running for \d+ms/);
    expect((caught as StoreBusyError).message).toContain(dbPath);
  });

  it("the identity captured before the region is the same value its sites read before — dim:N fallback included", () => {
    // WHAT THIS CATCHES that the tests above cannot: a capture that resolves something subtly
    // different from `this.embedderModelId` — the raw `modelId`, an empty string, a stale pin —
    // would move the region's foreign reads out just as well and quietly change what the pin means.
    //
    // The discriminator is the `dim:${dim}` fallback, because a store is never pinned to one by the
    // engine itself (an anonymous provider does not get to mint a pin — see initSyncIdentity), so a
    // pin written here BY HAND can only be matched by a capture that computes the identical string.
    function pinnedTo(dbPath: string, modelId: string): void {
      const port = new BetterSqlitePort(dbPath);
      try {
        port
          .prepare(`UPDATE sync_meta SET embedder_model_id = ?, embedder_pin_source = 'created', embedder_pinned_at = ? WHERE singleton = 1`)
          .run(modelId, Date.now());
      } finally {
        port.close();
      }
    }
    function reopenAnonymousAndReadPinFlag(dbPath: string): boolean {
      const core = new MonetCore(dbPath, { embedder: anonymousEmbedder() });
      // The constructor's own pin comparison, which is one of the sites the captured value feeds.
      const unsatisfied = (core as unknown as { pinUnsatisfied: boolean }).pinUnsatisfied;
      core.close();
      return unsatisfied;
    }

    const matching = join(tempDir(), "monet-core.db");
    new MonetCore(matching, { embedder: new HashingEmbeddingProvider(256) }).close();
    pinnedTo(matching, "dim:256");
    // Satisfied ONLY if the captured identity is exactly `dim:256` for a 256-dim anonymous provider.
    expect(reopenAnonymousAndReadPinFlag(matching)).toBe(false);

    const otherDim = join(tempDir(), "monet-core.db");
    new MonetCore(otherDim, { embedder: new HashingEmbeddingProvider(256) }).close();
    pinnedTo(otherDim, "dim:999");
    // Still discriminating: a capture that matched everything would pass the assertion above too.
    expect(reopenAnonymousAndReadPinFlag(otherDim)).toBe(true);

    // And the value a normal construction PERSISTS is unchanged: the pin is the embedder's own
    // modelId, written from the captured local rather than from a re-read of the getter.
    const named = join(tempDir(), "monet-core.db");
    const embedder = new HashingEmbeddingProvider(256);
    new MonetCore(named, { embedder }).close();
    const port = new BetterSqlitePort(named);
    try {
      expect(
        (port.prepare(`SELECT embedder_model_id FROM sync_meta WHERE singleton = 1`).get() as { embedder_model_id: string | null }).embedder_model_id,
      ).toBe(embedder.modelId);
    } finally {
      port.close();
    }
  });
});

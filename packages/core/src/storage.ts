/**
 * StoragePort — the narrow persistence seam the engine talks to.
 *
 * MonetCore depends ONLY on this synchronous, statement-oriented surface, never on a
 * concrete database driver. The seam keeps the engine's logic (resolve-or-create, the
 * connection graph, synthesis) independent of where the bytes live, so the driver can be
 * swapped — for a different store, or an in-test fake — without touching engine code.
 *
 * The shipped implementation is `BetterSqlitePort` (better-sqlite3, a single local file).
 * The surface deliberately mirrors better-sqlite3's synchronous statement API: the engine
 * stays synchronous (no async ripple through prewarm/overview/contradiction paths), and the
 * default adapter is a thin pass-through with no behavioural change.
 *
 * Note: this decouples the engine from a concrete DRIVER, not from SQL itself — the engine
 * still issues SQLite-dialect SQL/pragmas through the port. An alternative backend supplies
 * its own port AND its own schema setup; that is out of scope for the shipped engine.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, lstat, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createStatementTracer, readInflightStatements, statementTraceEnabled } from "./statement-trace";
import type { InflightStatement, StatementMethod, StatementTracer } from "./statement-trace";

/** The result of a write (INSERT/UPDATE/DELETE) — mirrors better-sqlite3's RunResult. */
export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

/** A prepared statement, parameterised positionally on each call (better-sqlite3 shape). */
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface PragmaOptions {
  /** Return the bare value instead of a row (e.g. `pragma("user_version", { simple: true })`). */
  simple?: boolean;
}

/** A SQLite connection could not establish exclusive store ownership within its busy timeout. */
export class StorageExclusiveLockError extends Error {
  constructor(
    message: string,
    options: { cause: unknown; cleanupError?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "StorageExclusiveLockError";
    this.cleanupError = options.cleanupError;
  }

  /** Present when cleanup could not verify restored shared access after the acquisition failure. */
  readonly cleanupError?: unknown;
}

/**
 * The busy timeout this port arms on every connection it opens, and therefore the ceiling on how
 * long ONE statement can wait for the write lock before SQLite gives up with SQLITE_BUSY.
 *
 * NAMED because a message quotes it (schemaRegionContentionError, below). A hard-coded 5000 in that
 * sentence would keep claiming a bound after someone changed the pragma, and a diagnostic that
 * describes a bound which is no longer set is worse than one that describes none.
 *
 * NOT the budget the connection OPEN runs under: better-sqlite3 arms `sqlite3_busy_timeout` from its
 * own `timeout` option before this pragma is ever reached (see the constructor's comment on that).
 * The two happen to agree at 5000; this constant governs only statements that run after the pragma,
 * which is every statement outside BetterSqlitePort's own constructor.
 */
export const STORE_BUSY_TIMEOUT_MS = 5000;

/**
 * The store could not be opened because another process holds its write lock (#148).
 *
 * Distinct from StorageExclusiveLockError, which is about a lock this process asked for and could
 * not keep. This one is ordinary contention on the SHARED topology the WAL + busy_timeout setup
 * exists for — an MCP server and a `monet` CLI call on one `.monet` DB — and it is transient by
 * nature: the remedy is usually to retry once the other process finishes.
 */
export class StoreBusyError extends Error {
  constructor(
    readonly dbPath: string,
    readonly waitedMs: number,
    /** Empty when tracing was off, which is NOT the same as "nothing holds it" — see the message. */
    readonly holders: InflightStatement[],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StoreBusyError";
  }
}

/** SQLite reports contention two ways, and the second is not a code (see diagnostics.ts on WSL2). */
function isStoreContention(error: unknown): boolean {
  // GUARDED FOR THE SAME REASON isSqliteError IS (PR #102 review): the `in` test and the property
  // read both run arbitrary third-party code, and every caller of this predicate is already inside
  // a catch, where a throw from classifying REPLACES the failure being classified. An uninspectable
  // code falls through to the message arm rather than deciding anything, so an error that answers
  // neither question propagates untouched instead of becoming a TypeError from the inspection.
  //
  // This costs the open path nothing it was getting right: for any error whose code is readable the
  // answer is unchanged, and for a poisoned one it previously threw here rather than returning.
  let code = "";
  try {
    code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  } catch {
    /* fall through to the message arm */
  }
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  // `message` is a property read like any other and can throw for the same reasons `code` can. Here
  // the catch answers false rather than falling through, because this IS the last arm: an error
  // whose message cannot be read has answered neither question, and not-contention is what leaves
  // the original failure to propagate untouched.
  try {
    return error instanceof Error && /database is locked/i.test(error.message);
  } catch {
    return false;
  }
}

/**
 * Did this error come from SQLite at all? Asked ONLY by the region path, and this is why.
 *
 * `isStoreContention`'s second arm is a bare message match, which is safe exactly where it was
 * written: the open path's catch (BetterSqlitePort's constructor, below) wraps `new Database()` and
 * two pragmas, so a driver error is the only thing that can arrive and the arm cannot meet anything
 * else. The schema region is the opposite — MonetCore's whole construction runs inside it, ~10
 * statements plus every migration and repair pass, all free to throw whatever they like. Measured:
 * `initSyncIdentity` raises a plain Error quoting a device id the CALLER chose, so reopening a store
 * with `syncDeviceId: "database is locked"` produced a StoreBusyError blaming a write lock, naming a
 * holder and advising a retry, for a mismatch with no lock anywhere in it.
 *
 * WHY THE MESSAGE ARM IS NARROWED HERE RATHER THAN DELETED. It exists for contention SQLite reports
 * WITHOUT a code (`isStoreContention`'s own comment, #148), and something still depends on that
 * shape: startup-diagnosis.test.ts drives `storeContentionError` with a codeless `database is
 * locked` to prove the record leaves `code` ABSENT rather than fabricating `SQLITE_BUSY`. Requiring
 * the error to be SQLite's keeps every case the arm was written for and drops only the errors that
 * were never SQLite's — which is the whole population this region added to it.
 *
 * WHAT COUNTS AS SQLITE'S: a `SQLITE_`-prefixed code, or the driver's own error class name. Measured
 * on this driver: a real contended `CREATE TABLE` throws `name: "SqliteError"`, `code:
 * "SQLITE_BUSY"`, `message: "database is locked"`. The name arm is what carries a codeless report —
 * matching on the class that threw rather than on a code that is not there.
 */
function isSqliteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // THE CODE READ IS GUARDED, for the reason startup-diagnosis.ts guards its own (PR #102 review).
  // Both the `in` test and the property read run arbitrary third-party code — a getter, a Proxy
  // trap — and this gate runs INSIDE the constructor's catch, where a throw does not fall through
  // to `?? error` but replaces the constructor's real failure with a TypeError from the inspection.
  // THE CALLER-SUPPLIED READ THIS ONCE CITED IS GONE (#102, root-cause round): `initSyncIdentity`
  // and `migrate()` used to read `this.embedderModelId` inside the guarded region, and the embedder
  // is caller-supplied, so a third-party `modelId` getter could raise the very error this gate then
  // destroyed while classifying it. That identity is now resolved BEFORE the region opens (see the
  // constructor's capture in engine.ts) — the root-cause fix, because no inspection of an error can
  // tell a foreign SqliteError from one of ours, so the foreign code moved out instead of the
  // classifier learning to guess. These guards stay as defence in depth for what our OWN statements
  // raise: a driver error's own properties are not ours to assume readable either.
  //
  // AN UNINSPECTABLE CODE IS AN ABSENT CODE, NOT A VERDICT ON THE ERROR. The catch falls through to
  // the name arm rather than returning false: a poisoned `code` on an error that IS SQLite's must
  // not cost the classification, which is exactly the codeless-report case the name arm exists to
  // carry. Only an error that answers neither question is left to propagate untouched.
  try {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
  } catch {
    /* fall through to the name arm */
  }
  // Same for `name`, and the same reasoning as the message arm below: this is the last question
  // this gate asks, so an unreadable name is a no rather than a throw.
  try {
    return error instanceof Error && error.name === "SqliteError";
  } catch {
    return false;
  }
}

/**
 * Turn a contention failure into a sentence an operator can act on, or return undefined so the
 * original error propagates untouched.
 *
 * WHAT THE MESSAGE HAS TO CARRY, because these are the three questions the afternoon in #148 was
 * spent answering by hand: that this is contention rather than a broken binary or a bad path; how
 * long was actually waited; and WHO holds it. SQLite answers only the first, and only in a code.
 *
 * The holder comes from the markers the lock-holder itself wrote (readInflightStatements). When
 * tracing is off there are none, and the message leads with THAT rather than with "no holder" — an absent
 * record and an absent holder are different facts, and reporting the first as the second is how a
 * diagnostic starts lying.
 *
 * `lead` is the caller's own first sentence, because the callers do not measure the same thing: see
 * schemaRegionContentionError, which is why this split exists at all. Everything after it — the
 * holder evidence and what to do next — is identical whoever asked, so it lives here once.
 */
function contentionError(
  dbPath: string,
  error: unknown,
  elapsedMs: number,
  lead: string,
): StoreBusyError | undefined {
  if (!isStoreContention(error)) return undefined;
  // ONLY MARKERS THAT NAME THIS STORE (Codex review, PR #216). A marker carries no proof that its
  // process owns the lock, and a directory can hold several databases — so an unfiltered list can
  // point at an unrelated process, and sending an operator after the wrong pid is worse than saying
  // nothing. Markers written before the field existed have no dbPath; those are dropped rather than
  // assumed to match, because "cannot tell" must not read as "this one".
  const holders = readInflightStatements(dirname(dbPath)).filter((h) => h.dbPath === dbPath);
  const now = Date.now();
  const held = holders.length === 0
    // NOT "tracing is off" (Codex review, PR #216). An empty list has more than one cause: tracing
    // may be off, OR a process may hold the lock while idle BETWEEN statements, which truncates its
    // own marker by design. Inferring the cause here would repeat, one level up, exactly the
    // mistake this message exists to avoid — reporting an absence as the thing that explains it.
    ? `Nothing beside the store records who holds it. That happens when statement tracing is off ` +
      `(set MONET_TRACE_SQL=1 on every monet process sharing this store and reproduce), and also ` +
      `when the holder is idle between statements while keeping the lock — an absent RECORD either ` +
      `way, never an absent holder.`
    // "In flight against", not "held by": what was observed is a statement running against this
    // store, which is evidence about the holder rather than proof of ownership. A crashed process
    // can also leave a stale marker behind.
    : `Statements in flight against this store: ${holders.map((h) =>
        `pid ${h.pid} (${h.method}, ${Math.round((now - h.startedAt) / 1000)}s so far: ${h.sql})`,
      ).join("; ")}. One of those is the likely holder; a marker is what a process recorded, not ` +
      `proof it still runs.`;
  return new StoreBusyError(
    dbPath,
    elapsedMs,
    holders,
    `${lead} ${held} ` +
      `One MCP server and one \`monet\` CLI call sharing a store is the supported topology, so this ` +
      `is usually transient — retry once the other process finishes. If nothing ever finishes, the ` +
      `holder is wedged rather than busy.`,
    { cause: error },
  );
}

/**
 * Contention met while TAKING the connection — BetterSqlitePort's own constructor. Here `waitedMs`
 * is a measured wait and nothing else: the interval it times contains the open and the setup
 * pragmas, which is SQLite work and no work of ours, so the number is exactly what it says.
 */
export function storeContentionError(dbPath: string, error: unknown, waitedMs: number): StoreBusyError | undefined {
  return contentionError(
    dbPath,
    error,
    waitedMs,
    `The store at ${dbPath} is busy: could not take its write lock after ${waitedMs}ms.`,
  );
}

/**
 * Contention met INSIDE MonetCore's schema region, after the connection is already open (#82).
 *
 * WHY THIS CANNOT REUSE THE SENTENCE ABOVE. The region's clock starts before `init()` and stops on
 * the throw, so its elapsed time is prefix work PLUS whatever waiting happened — and the prefix is
 * not small: `repairDriftedConceptCentroids()` scans every live observation and holds the whole live
 * vector population in memory before it writes, and #95 and #97 re-armed the centroid and lexical
 * gates so both passes run on the first open of every existing store. Measured: a holder taking the
 * lock 3828ms into the region produced 8035, which the shared sentence reported as a 8035ms wait for
 * a wait of 5000ms.
 *
 * THAT IS NOT A ROUNDING ERROR, because of what the closing sentence then tells the operator: a wait
 * that never ends means the holder is WEDGED rather than busy. An inflated number argues for that
 * conclusion about a holder that behaved normally, and sends the reader after a hang that is not
 * there.
 *
 * WHAT IS SAID INSTEAD is only what is true and free at this point. The elapsed number is named as
 * elapsed. The actual wait is not measured — per-statement timing would mean a wrapper on a hot path
 * that `prepare`/`transaction`/`immediateTransaction` deliberately leave unwrapped when tracing is
 * off — so it is BOUNDED instead: one statement failed, and one statement's wait cannot exceed this
 * connection's busy timeout. A bound the reader can check beats a measurement that costs an
 * allocation on every statement to obtain.
 */
export function schemaRegionContentionError(
  dbPath: string,
  error: unknown,
  regionElapsedMs: number,
): StoreBusyError | undefined {
  // NOT EVERY FAILURE IN THIS REGION IS SQLITE'S (PR #102 review, finding A). The open path can hand
  // `isStoreContention` nothing but driver errors; this one hands it the whole constructor. See
  // isSqliteError for what the difference costs and why the narrowing lands here and not there.
  if (!isSqliteError(error)) return undefined;
  return contentionError(
    dbPath,
    error,
    regionElapsedMs,
    `The store at ${dbPath} is busy: a statement in the startup's schema region could not take its ` +
      `write lock. That region had been running for ${regionElapsedMs}ms when it failed, but that is ` +
      `the region's own elapsed time, not a wait — schema, migration and index-repair passes run ` +
      `inside it before any statement blocks. The failing statement's wait is bounded by this ` +
      `connection's ${STORE_BUSY_TIMEOUT_MS}ms busy_timeout, so do not read the number above as time ` +
      `the holder has held anything.`,
  );
}

export interface VerifiedBackupResult {
  sourcePath: string;
  path: string;
  createdAt: number;
  bytes: number;
  quickCheck: "ok";
}

export class VerifiedBackupDestinationExistsError extends Error {
  constructor(public readonly destinationPath: string) {
    super(`Refusing to overwrite existing backup destination '${destinationPath}'.`);
    this.name = "VerifiedBackupDestinationExistsError";
  }
}

export class VerifiedBackupVerificationError extends Error {
  constructor(
    public readonly partialPath: string,
    public readonly check: string[],
  ) {
    super(`SQLite backup verification failed for '${partialPath}': PRAGMA quick_check returned ${check.join("; ") || "no result"}.`);
    this.name = "VerifiedBackupVerificationError";
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The persistence surface MonetCore is written against. Statement-oriented and synchronous:
 * `prepare(sql)` returns a reusable `Statement`; `transaction(fn)` returns a function that
 * runs `fn` atomically when called.
 */
export interface StoragePort {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(source: string, options?: PragmaOptions): unknown;
  /** Wrap `fn` so invoking the returned function runs it in a single atomic transaction. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  /** Acquire SQLite's write reservation before `fn` reads; serializes registry/circle identity changes. */
  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  /** Optional best-effort cache hint: whether this connection is inside a transaction/savepoint. */
  inTransaction?(): boolean;
  /**
   * Retain connection-level exclusive ownership until releaseExclusiveOwnership() or close().
   * `:memory:` databases have no cross-process identity, so adapters may implement this as a no-op.
   */
  acquireExclusiveOwnership(): void;
  /** Restore shared access after exclusive ownership. Safe to call when ownership is not held. */
  releaseExclusiveOwnership(): void;
  close(): void;
}

/**
 * The default StoragePort: better-sqlite3 over a single file (or `:memory:`). Owns the
 * SQLite-specific connection setup (WAL + a busy timeout so the MCP server and a `monet`
 * CLI call can share one `.monet` DB without an immediate SQLITE_BUSY on the WAL lock).
 */
export class BetterSqlitePort implements StoragePort {
  private db: Database.Database;
  private readonly memoryOnly: boolean;
  private readonly dbPath: string;
  private ownsExclusiveLock = false;
  private uncertainExclusiveLockError?: StorageExclusiveLockError;
  private readonly tracer?: StatementTracer;

  constructor(path = ":memory:", options?: { tracer?: StatementTracer }) {
    this.memoryOnly = path === ":memory:";
    this.dbPath = this.memoryOnly ? path : resolve(path);
    // WHEN THIS BLOCKS, SAY SO IN WORDS (#148). Until now a contended store failed with SQLite's own
    // `database is locked`, on a stderr an MCP host does not display, which is why one occurrence
    // cost an afternoon of `lsof`, `ps` and hand-run probes.
    //
    // WHERE IT ACTUALLY BLOCKS, measured rather than assumed: `new Database(path)` executes no SQL
    // and returns in ~0ms even against an exclusively-locked file; `journal_mode = WAL` below is the
    // first statement and is what waits, observed at 5246ms. The guard around the open is therefore
    // DEFENSIVE — kept because a different build or option could move where the first lock is taken,
    // not because it is expected to fire.
    //
    // And the budget that wait runs under is NOT the pragma two lines below it: better-sqlite3 arms
    // `sqlite3_busy_timeout` from its own `timeout` option at open, which defaults to 5000
    // (lib/database.js). Our explicit `busy_timeout = STORE_BUSY_TIMEOUT_MS` runs AFTER the wait it
    // looks like it governs. Separating a real boot budget therefore has to go through `new
    // Database(path, { timeout })`, which is #215, not through editing that constant.
    //
    // The wait is timed from here so the message can say how long was actually spent, rather than
    // quoting a configured number and hoping the two match.
    const startedAt = Date.now();
    try {
      this.db = new Database(this.dbPath);
    } catch (error) {
      throw storeContentionError(this.dbPath, error, Date.now() - startedAt) ?? error;
    }
    // TRACER FIRST, THEN THE SETUP PRAGMAS (Codex round 3). `journal_mode = WAL` takes real locks
    // and can stall against a busy store — which is startup, the exact path #148 is about. Built
    // after them, the marker would not even be open when the thing worth naming blocked.
    //
    // A `:memory:` connection has no cross-process identity and cannot wedge a shared store, so it
    // is never traced even when the switch is on — the records exist to be read from OUTSIDE a
    // stuck process, and there is no outside for an in-process database.
    this.tracer = options?.tracer
      ?? (!this.memoryOnly && statementTraceEnabled()
        ? createStatementTracer({ dir: dirname(this.dbPath), dbPath: this.dbPath })
        : undefined);
    try {
      this.pragma("journal_mode = WAL");
      this.pragma(`busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    } catch (error) {
      // RELEASE WHAT THIS CONSTRUCTOR ALREADY TOOK (Codex review, PR #216). Reaching here means the
      // instance will never exist, so nothing else can ever close these: the SQLite handle would be
      // left to nondeterministic GC, and an auto-created tracer owns a raw descriptor with no
      // finalizer at all — so a process that retries startup against a contended store leaks one
      // descriptor per attempt, which is exactly the situation this path exists for.
      try {
        this.tracer?.close();
      } catch { /* the throw below is the news; cleanup failing is not */ }
      try {
        this.db.close();
      } catch { /* same */ }
      throw storeContentionError(this.dbPath, error, Date.now() - startedAt) ?? error;
    }
  }

  prepare(sql: string): Statement {
    // PREPARING IS SQLite WORK TOO (Codex round 4). `sqlite3_prepare_v2` reads schema and can
    // block on a schema lock before run/get/all is ever reached, so building the statement
    // outside a frame left the marker empty for that window.
    const stmt = this.traced("prepare", sql, () => this.db.prepare(sql));
    const tracer = this.tracer;
    if (tracer === undefined) return stmt; // untraced: the raw statement, no wrapper allocated
    // The wrapper records around the call rather than inside it, because better-sqlite3
    // offers no hook inside a running statement. `end` is in a `finally` so a statement that
    // THROWS still clears the in-flight marker — otherwise one failed query would leave a
    // stale marker that reads as a hang forever after.
    return {
      run: (...params: unknown[]) => {
        const startedAt = tracer.begin("run", sql);
        try {
          return stmt.run(...params);
        } finally {
          tracer.end(startedAt, "run", sql);
        }
      },
      get: (...params: unknown[]) => {
        const startedAt = tracer.begin("get", sql);
        try {
          return stmt.get(...params);
        } finally {
          tracer.end(startedAt, "get", sql);
        }
      },
      all: (...params: unknown[]) => {
        const startedAt = tracer.begin("all", sql);
        let rows: unknown[] | undefined;
        try {
          rows = stmt.all(...params);
          return rows;
        } finally {
          tracer.end(startedAt, "all", sql, rows?.length);
        }
      },
    };
  }

  /**
   * THE ONLY PLACE SQL IS ISSUED IN THIS CLASS (Codex round 2, P2 on the exclusive-ownership
   * path). Round 1 traced `prepare`/`exec`/`pragma` one method at a time, and round 2 found two
   * more mouths that bypassed them — the transaction entry points, and nine `this.db.*` calls
   * inside acquire/release that never went through the public methods at all. Patching those two
   * would have invited a round 3.
   *
   * So the bypass is closed structurally instead: every SYNCHRONOUS SQL call in this class routes
   * through `traced`, and `this.db.prepare/exec/pragma` appears nowhere else below.
   *
   * The claim was originally written as "no `this.db.<sql-method>` anywhere else" and that was
   * FALSE (Codex round 4): it was scoped to three method names, while SQLite work also happens
   * through `db.backup()` — asynchronous, so it cannot use this helper at all — and inside
   * `db.prepare()` before any statement runs. Both are traced now, explicitly, at their own call
   * sites. The invariant that actually matters is "no SQLite work outside a frame", which is a
   * claim about the work, not about a list of method names; four rounds of review each found one
   * more mouth because the earlier phrasings were about the names.
   */
  private traced<R>(method: StatementMethod, sql: string, run: () => R): R {
    const tracer = this.tracer;
    if (tracer === undefined) return run();
    const startedAt = tracer.begin(method, sql);
    try {
      return run();
    } finally {
      tracer.end(startedAt, method, sql);
    }
  }

  /**
   * The real-page touch that acquire/release both depend on (see their FIX comments). It is a
   * statement like any other and can block like any other, so it goes through `traced` rather
   * than reaching for `this.db` — that is the whole point of the helper above.
   */
  private warmSchemaRead(): void {
    const sql = "SELECT name FROM sqlite_schema LIMIT 1";
    this.traced("get", sql, () => this.db.prepare(sql).get());
  }

  exec(sql: string): void {
    this.traced("exec", sql, () => this.db.exec(sql));
  }

  pragma(source: string, options?: PragmaOptions): unknown {
    // `wal_checkpoint`, `quick_check`, and the locking_mode switches below are unbounded on a
    // large store and hold real locks while they run. `PRAGMA ` is prefixed so the record reads
    // as SQL rather than as a bare keyword.
    return this.traced("pragma", `PRAGMA ${source}`, () => this.db.pragma(source, options));
  }

  /**
   * The trace brackets the RETURNED function, not this call: better-sqlite3 runs `BEGIN` when the
   * transaction function is invoked, not when it is built. That is the case worth catching — if
   * BEGIN blocks on the write lock the callback never starts, so no statement inside can mark
   * anything, and without this the marker would be empty precisely when the store is wedged.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const wrapped = this.db.transaction(fn);
    if (this.tracer === undefined) return wrapped;
    return (...args: A): R => this.traced("transaction", "BEGIN", () => wrapped(...args));
  }

  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const wrapped = this.db.transaction(fn).immediate;
    if (this.tracer === undefined) return wrapped;
    return (...args: A): R => this.traced("immediateTransaction", "BEGIN IMMEDIATE", () => wrapped(...args));
  }

  inTransaction(): boolean {
    return this.db.inTransaction;
  }

  /** Atomically publish without replacing any directory entry created by another actor. */
  private async publishVerifiedBackup(partialPath: string, destinationPath: string): Promise<void> {
    try {
      await link(partialPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new VerifiedBackupDestinationExistsError(destinationPath);
      }
      throw error;
    }
    await unlink(partialPath);
  }

  /**
   * Create a WAL-consistent repair backup while retaining exclusive ownership for the caller's
   * subsequent MonetCore construction/mutation. Every failure removes only this call's unique
   * partial file and releases ownership; an existing destination is never overwritten.
   */
  async createVerifiedBackup(destination: string): Promise<VerifiedBackupResult> {
    if (this.memoryOnly) throw new Error("Verified repair backups require a file-backed SQLite store.");
    const destinationPath = resolve(destination);
    const partialPath = join(
      dirname(destinationPath),
      `.${basename(destinationPath)}.partial-${process.pid}-${randomUUID()}`,
    );
    let primaryError: unknown;
    try {
      this.acquireExclusiveOwnership();
      if (await pathEntryExists(destinationPath)) throw new VerifiedBackupDestinationExistsError(destinationPath);

      // better-sqlite3's online backup reads through this same connection and includes committed WAL
      // frames while the connection's retained EXCLUSIVE ownership prevents external mutation.
      //
      // TRACED EXPLICITLY, NOT THROUGH `traced` (Codex round 4): this is the one SQLite path that
      // is asynchronous, and the synchronous helper would end its frame when the promise is
      // created rather than when it settles. It is also the worst possible place to be blind — the
      // backup runs while this connection HOLDS exclusive ownership, so a stall here blocks every
      // other client with an empty marker, which is #145 exactly.
      const backupStartedAt = this.tracer?.begin("backup", `BACKUP TO ${partialPath}`);
      try {
        await this.db.backup(partialPath);
      } finally {
        if (backupStartedAt !== undefined) this.tracer?.end(backupStartedAt, "backup", `BACKUP TO ${partialPath}`);
      }
      const verification = new Database(partialPath, { readonly: true, fileMustExist: true });
      let check: string[];
      const verifyStartedAt = this.tracer?.begin("backupVerify", "PRAGMA quick_check");
      try {
        check = (verification.pragma("quick_check") as Array<{ quick_check: string }>).map((row) => row.quick_check);
      } finally {
        if (verifyStartedAt !== undefined) this.tracer?.end(verifyStartedAt, "backupVerify", "PRAGMA quick_check");
        verification.close();
      }
      // A readonly open of a WAL-mode backup can materialize empty sidecars beside the unique
      // partial. They belong to this partial, not the final backup, and must not leak past rename.
      for (const sidecarPath of [`${partialPath}-wal`, `${partialPath}-shm`]) {
        try {
          await unlink(sidecarPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
      if (check.length !== 1 || check[0] !== "ok") {
        throw new VerifiedBackupVerificationError(partialPath, check);
      }
      await chmod(partialPath, 0o600);
      const { size: bytes } = await stat(partialPath);
      // Hard-link publication is atomic and no-clobber: unlike POSIX rename(), it fails with EEXIST
      // if a file, symlink, or directory wins the race after the initial refusal check.
      await this.publishVerifiedBackup(partialPath, destinationPath);
      return {
        sourcePath: this.dbPath,
        path: destinationPath,
        createdAt: Date.now(),
        bytes,
        quickCheck: "ok",
      };
    } catch (error) {
      primaryError = error;
      const partialCleanupErrors: unknown[] = [];
      for (const ownedPath of [partialPath, `${partialPath}-wal`, `${partialPath}-shm`]) {
        try {
          await unlink(ownedPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") partialCleanupErrors.push(cleanupError);
        }
      }
      let releaseError: unknown;
      try {
        this.releaseExclusiveOwnership();
      } catch (cleanupError) {
        releaseError = cleanupError;
      }
      const cleanupErrors = [...partialCleanupErrors, releaseError].filter((value) => value !== undefined);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "Verified SQLite backup failed and cleanup could not be completed.",
          { cause: primaryError },
        );
      }
      throw error;
    }
  }

  acquireExclusiveOwnership(): void {
    if (this.memoryOnly) return;
    if (this.uncertainExclusiveLockError !== undefined) throw this.uncertainExclusiveLockError;
    if (this.ownsExclusiveLock) return;
    try {
      // FIX: SQLite's EXCLUSIVE→NORMAL downgrade is lazy and only works if this connection's
      // WAL/shm was materialized by a REAL page access before entering EXCLUSIVE mode. The
      // constructor's `journal_mode = WAL` pragma alone does NOT do that on a fresh database file
      // (the -shm appears only on a real read/write) — an unwarmed connection that goes straight
      // to EXCLUSIVE holds its lock until close, no matter what release statement follows
      // (empirical: 9/9 unwarmed failures vs warmed success; see also releaseExclusiveOwnership's
      // real-page-touch requirement). This read makes acquire self-sufficient regardless of the
      // connection's history.
      this.warmSchemaRead();
      // FIX: locking_mode is connection state, but SQLite does not actually retain the exclusive
      // file lock until a transaction performs a real write. Reversibly toggling user_version in one
      // transaction is schema-independent, leaves the committed logical value unchanged, and makes
      // the lock effective against non-cooperating readers/writers after COMMIT.
      this.pragma("locking_mode = EXCLUSIVE");
      const currentUserVersion = this.pragma("user_version", { simple: true }) as number;
      const probeUserVersion = currentUserVersion === 2_147_483_647 ? currentUserVersion - 1 : currentUserVersion + 1;
      this.exec(
        `BEGIN IMMEDIATE; PRAGMA user_version = ${probeUserVersion}; PRAGMA user_version = ${currentUserVersion}; COMMIT;`,
      );
      this.ownsExclusiveLock = true;
    } catch (cause) {
      let cleanupError: unknown;
      try {
        if (this.db.inTransaction) this.exec("ROLLBACK");
        this.pragma("locking_mode = NORMAL");
        this.warmSchemaRead();
      } catch (error) {
        cleanupError = error;
      }
      const acquisitionError = new StorageExclusiveLockError(
        "SQLite exclusive ownership could not be acquired within the configured busy timeout.",
        { cause, cleanupError },
      );
      if (cleanupError !== undefined) {
        // FIX: a failed cleanup leaves SQLite's actual lock state unknowable. Preserve that exact
        // evidence and reject further acquisition without touching SQLite until release explicitly
        // reconciles the connection, rather than treating an unverified state as shared or owned.
        this.uncertainExclusiveLockError = acquisitionError;
      }
      throw acquisitionError;
    }
  }

  releaseExclusiveOwnership(): void {
    if (this.memoryOnly || (!this.ownsExclusiveLock && this.uncertainExclusiveLockError === undefined)) return;
    try {
      // FIX: switching back to NORMAL only changes the requested mode; one subsequent access is
      // required before SQLite drops the connection-level exclusive lock and restores shared access.
      this.pragma("locking_mode = NORMAL");
      this.warmSchemaRead();
      this.ownsExclusiveLock = false;
      this.uncertainExclusiveLockError = undefined;
    } catch (cause) {
      this.ownsExclusiveLock = false;
      this.uncertainExclusiveLockError ??= new StorageExclusiveLockError(
        "SQLite exclusive ownership could not be released.",
        { cause },
      );
      throw cause;
    }
  }

  close(): void {
    // TRACER CLOSES LAST (Codex round 3, and a regression this PR introduced itself): round 2
    // routed releaseExclusiveOwnership through the traced helpers, so closing the tracer first
    // blinded exactly the shutdown SQL most able to block — the locking_mode switch and its warm
    // read. It still clears on the way out, in a `finally`, so a clean exit leaves no stale marker.
    try {
      let releaseError: unknown;
      try {
        this.releaseExclusiveOwnership();
      } catch (error) {
        releaseError = error;
      }

      try {
        this.db.close();
        this.ownsExclusiveLock = false;
        this.uncertainExclusiveLockError = undefined;
      } catch (closeError) {
        if (releaseError !== undefined) {
          throw new AggregateError(
            [releaseError, closeError],
            "SQLite exclusive-lock release and connection close both failed.",
            { cause: releaseError },
          );
        }
        throw closeError;
      }
      if (releaseError !== undefined) throw releaseError;
    } finally {
      this.tracer?.close();
    }
  }
}

/**
 * Lightweight, read-only peek at a store's persisted embedder pin (sync_meta.embedder_model_id),
 * WITHOUT constructing a MonetCore — no schema creation, no migration, no sync-identity write, no
 * WAL-mode pragma side effects on the file (Codex review, PR #51 round 7, FIX U —
 * scripts/mcp-cli.ts's startup sequencing is the motivating, and so far only, caller: it needs to
 * know what a store is ALREADY pinned to before choosing which embedder to construct and warm up,
 * not after paying that embedder's own load cost). Lives here, not engine.ts: it never touches
 * MonetCore's schema/migration logic, only the raw driver — the same reason BetterSqlitePort, the
 * only other direct better-sqlite3 consumer in this codebase, lives here too.
 *
 * Tolerant by design — returns null (never throws) for every "nothing to read yet" shape: the file
 * doesn't exist (a genuinely first-ever run — better-sqlite3's readonly mode can't create one, so
 * this checks existence first rather than let that surface as a thrown error), the file exists but
 * isn't a monet-core database, the sync_meta table doesn't exist (pre-v8), the singleton row
 * doesn't exist yet, or the pin columns themselves don't exist (pre-embedder-pin-ADR schema, before
 * MonetCore's own init()-time guard has ever run against this file — see engine.ts's FIX T). A
 * caller sees "no persisted pin" in every one of those cases and falls back to whatever it would
 * have done before this helper existed — this function only ever NARROWS a caller's choice, never
 * widens what "no pin" means beyond what MonetCore's own pin machinery already treats as unpinned.
 */
export function readStoredEmbedderPin(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT embedder_model_id FROM sync_meta WHERE singleton = 1`).get() as
      | { embedder_model_id: string | null }
      | undefined;
    return row?.embedder_model_id ?? null;
  } catch {
    // Missing table, missing column, a file that isn't actually a sqlite db, a locked file, etc. —
    // every failure mode collapses to "we don't know the pin", never a thrown error upward. The
    // caller's normal (pre-pin-aware) fallback path already handles "unknown pin" correctly.
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Read-only startup peek for whether a store has committed any semantic vector. `false` includes a
 * nonexistent file and a valid SQLite file with neither vector table yet; `null` means the existing
 * file could not be inspected, so callers must conservatively preserve legacy startup behavior
 * rather than treating it as genuinely fresh. Like readStoredEmbedderPin, this never creates or
 * migrates a database and does not change its journal mode.
 */
export function readStoredVectorPresence(dbPath: string): boolean | null {
  if (!existsSync(dbPath)) return false;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = new Set(
      (db
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('observations', 'concepts')`)
        .all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (tables.has("observations") && db.prepare(`SELECT 1 FROM observations LIMIT 1`).get() !== undefined) {
      return true;
    }
    if (
      tables.has("concepts") &&
      db.prepare(`SELECT 1 FROM concepts WHERE embedding IS NOT NULL LIMIT 1`).get() !== undefined
    ) {
      return true;
    }
    return false;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

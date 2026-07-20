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
import { existsSync } from "node:fs";

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
  private ownsExclusiveLock = false;
  private uncertainExclusiveLockError?: StorageExclusiveLockError;

  constructor(path = ":memory:") {
    this.memoryOnly = path === ":memory:";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(source: string, options?: PragmaOptions): unknown {
    return this.db.pragma(source, options);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.db.transaction(fn);
  }

  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.db.transaction(fn).immediate;
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
      this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
      // FIX: locking_mode is connection state, but SQLite does not actually retain the exclusive
      // file lock until a transaction performs a real write. Reversibly toggling user_version in one
      // transaction is schema-independent, leaves the committed logical value unchanged, and makes
      // the lock effective against non-cooperating readers/writers after COMMIT.
      this.db.pragma("locking_mode = EXCLUSIVE");
      const currentUserVersion = this.db.pragma("user_version", { simple: true }) as number;
      const probeUserVersion = currentUserVersion === 2_147_483_647 ? currentUserVersion - 1 : currentUserVersion + 1;
      this.db.exec(
        `BEGIN IMMEDIATE; PRAGMA user_version = ${probeUserVersion}; PRAGMA user_version = ${currentUserVersion}; COMMIT;`,
      );
      this.ownsExclusiveLock = true;
    } catch (cause) {
      let cleanupError: unknown;
      try {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        this.db.pragma("locking_mode = NORMAL");
        this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
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
      this.db.pragma("locking_mode = NORMAL");
      this.db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
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

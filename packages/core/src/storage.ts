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
  close(): void;
}

/**
 * The default StoragePort: better-sqlite3 over a single file (or `:memory:`). Owns the
 * SQLite-specific connection setup (WAL + a busy timeout so the MCP server and a `monet`
 * CLI call can share one `.monet` DB without an immediate SQLITE_BUSY on the WAL lock).
 */
export class BetterSqlitePort implements StoragePort {
  private db: Database.Database;

  constructor(path = ":memory:") {
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

  close(): void {
    this.db.close();
  }
}

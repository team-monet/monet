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

  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.db.transaction(fn).immediate;
  }

  close(): void {
    this.db.close();
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

/**
 * Statement tracing — so a wedged store can name the statement that wedged it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SLOW-QUERY LOG (monet-core#145): a `monet start`
 * server has been observed three times in ~24 hours pegged at ~100% CPU inside a single
 * `Statement::JS_all` that never returns, holding SQLite's write lock and locking every
 * other client out of the shared store. The obvious instrument — time the call, log it if
 * it was slow — CANNOT SEE THAT AT ALL. "If it was slow" runs after the call returns, and
 * the call never returns. Every post-hoc timer is structurally blind to the exact failure
 * it would be built to find.
 *
 * So the primary record is written BEFORE the statement runs, not after:
 *
 *   IN-FLIGHT MARKER  one fixed-size file per CONNECTION, rewritten at offset 0 before every
 *                     statement and cleared after it returns. While a statement is running
 *                     the file names it; when the process is wedged the file keeps naming
 *                     it, and any outside reader — a shell, another server, a human — can
 *                     read the culprit and how long it has been stuck. This is the whole
 *                     point: the diagnosis must survive the process being unable to answer.
 *                     A reader globs `inflight-*.json`: one process can hold several
 *                     connections, and each keeps its own nesting stack.
 *
 *   SLOW LOG          appended after a statement returns, when it took longer than the
 *                     threshold. This covers the OTHER axis — retrieval that still answers
 *                     but degrades as the corpus grows — which the in-flight marker cannot
 *                     see because each individual statement completes.
 *
 * The two are not redundant: one catches what never finishes, the other catches what
 * finishes too late. #145 needs the first; the "search gets worse as it accumulates"
 * complaint needs the second.
 *
 * COST WHEN OFF is one boolean test in `prepare()` and no wrapper object — tracing is
 * env-gated and off by default, because this is a hunting instrument, not telemetry. Cost
 * when ON is one `writeSync` to an already-open descriptor per statement (no open/close,
 * no allocation beyond the marker buffer), which is affordable enough to leave running
 * through real sessions — and it has to be, because the trigger is still unidentified and
 * the only way to catch it is to be recording when it happens.
 *
 * TRACING MUST NEVER BREAK A QUERY. Every write is best-effort inside a try/catch: an
 * instrument that can fail the thing it observes is worse than no instrument.
 */

import { closeSync, fchmodSync, ftruncateSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Longer than this and a completed statement is recorded in the slow log. */
export const STATEMENT_SLOW_THRESHOLD_MS = 1_000;

/**
 * SQL is clipped in the record. The marker file is rewritten in place at offset 0, so an
 * unbounded statement would leave a tail of the previous, longer one behind it; a fixed
 * clip plus the explicit truncate below keeps the file honest.
 */
export const STATEMENT_TRACE_SQL_MAX_CHARS = 2_000;

/**
 * Both trace files are created 0600, matching `gate-journal.ts`'s own `openSync(path, "a", 0o600)`
 * (Codex round 5). They sit beside the store in `~/.monet` and carry statement text and backup
 * paths; under a common 022 umask Node's default create mode leaves them world-readable, which is
 * how the live store came to hold a 0644 `inflight-*.json` next to a 0600 `gate-journal.jsonl`.
 * An explicit chmod follows the open because a mode argument only applies when the file is created,
 * and these files outlive the process that made them.
 */
export const TRACE_FILE_MODE = 0o600;

export const INFLIGHT_FILENAME_PREFIX = "inflight-";
export const SLOW_LOG_FILENAME = "slow-queries.jsonl";

/**
 * Every SQL entry point on StoragePort, not just the prepared-statement ones (Codex P2 on
 * PR #147, accepted). `exec` has 97 call sites in core outside this module, `pragma` runs
 * checkpoint and integrity work that is unbounded on a large store, and either can hold the
 * write lock. An instrument that watches one mouth of three is the defect it was built to
 * find — the same shape as #146, where three of five journal mouths record nothing.
 */
export type StatementMethod =
  | "prepare" | "run" | "get" | "all"
  | "exec" | "pragma"
  | "transaction" | "immediateTransaction"
  | "backup" | "backupVerify";

/**
 * Two ports in one process would otherwise write the same `inflight-<pid>.json` with two
 * independent frame stacks (Codex round 3): the inner connection's `end` pops ITS stack, finds it
 * empty, and truncates the shared file — so an outer transaction, or its COMMIT, can wedge with an
 * empty marker. One file per connection is the honest shape, because two connections genuinely have
 * two independent stacks; a reader globs `inflight-*.json` rather than naming one.
 */
let nextConnectionSeq = 0;

export interface StatementTraceOptions {
  /** Directory the records are written to — the store's own directory. */
  dir: string;
  /** Distinguishes connections within one process. Defaults to a per-process counter. */
  connectionSeq?: number;
  /** Defaults to STATEMENT_SLOW_THRESHOLD_MS. */
  slowThresholdMs?: number;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests. Defaults to `process.pid`. */
  pid?: number;
  /**
   * Absolute path of the store these statements run against. Recorded in each marker so a reader
   * can tell one store's markers from another's when several share a directory (Codex review,
   * PR #216) — without it, an unrelated database's in-flight statement reads as this one's holder.
   */
  dbPath?: string;
}

export interface StatementTracer {
  /** Called immediately before a statement runs. Returns a token for `end`. */
  begin(method: StatementMethod, sql: string): number;
  /** Called after the statement returns — including when it threw. */
  end(startedAt: number, method: StatementMethod, sql: string, rows?: number): void;
  /** Release the marker descriptor. Safe to call more than once. */
  close(): void;
  /** Absolute path of this process's in-flight marker, for tests and for the reader tool. */
  readonly inflightPath: string;
}

/**
 * `MONET_TRACE_SQL=1` turns tracing on. Any other value — including unset — leaves it off.
 *
 * Deliberately a single switch rather than a level: the two records answer two different
 * questions and there is no case for wanting one without the other. A knob nobody can
 * describe the use of is a knob that ships wrong.
 */
export function statementTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MONET_TRACE_SQL === "1";
}

function clipSql(sql: string): string {
  return sql.length <= STATEMENT_TRACE_SQL_MAX_CHARS ? sql : `${sql.slice(0, STATEMENT_TRACE_SQL_MAX_CHARS)}…`;
}

export function createStatementTracer(options: StatementTraceOptions): StatementTracer {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const markerDbPath = options.dbPath;
  const slowThresholdMs = options.slowThresholdMs ?? STATEMENT_SLOW_THRESHOLD_MS;
  const connectionSeq = options.connectionSeq ?? nextConnectionSeq++;
  const inflightPath = join(options.dir, `${INFLIGHT_FILENAME_PREFIX}${pid}-${connectionSeq}.json`);
  const slowPath = join(options.dir, SLOW_LOG_FILENAME);

  // Opened once and held. A per-statement open/close would dominate the cost and, worse,
  // could itself block on a loaded filesystem — an instrument that adds a stall to the path
  // it is measuring reports its own latency as the subject's.
  let inflightFd: number | undefined;
  try {
    inflightFd = openSync(inflightPath, "w", TRACE_FILE_MODE);
    fchmodSync(inflightFd, TRACE_FILE_MODE); // a pre-existing file keeps its old, possibly 0644, mode
  } catch {
    inflightFd = undefined; // tracing degrades to the slow log alone rather than failing
  }

  const writeMarker = (payload: string | null): void => {
    if (inflightFd === undefined) return;
    try {
      if (payload === null) {
        ftruncateSync(inflightFd, 0);
        return;
      }
      const buf = Buffer.from(payload, "utf8");
      // Truncate FIRST, then write at offset 0: the reverse order leaves a longer previous
      // marker's tail appended to a shorter new one, which parses as corrupt JSON exactly
      // when it is being read to diagnose a hang.
      ftruncateSync(inflightFd, 0);
      writeSync(inflightFd, buf, 0, buf.length, 0);
    } catch {
      /* best effort — never break the query being observed */
    }
  };

  // A STACK, NOT A SINGLE SLOT (Codex round 2, P2 on transaction entry points). Frames nest:
  // `immediateTransaction` runs BEGIN IMMEDIATE, then the callback's statements, then COMMIT.
  // If `end` simply cleared the marker, the last inner statement would blank it and a hang in
  // COMMIT — a real way to block on the write lock — would show an empty file while the store
  // is wedged. Popping to the enclosing frame instead means the marker always names the
  // innermost SQL still executing, and falls back to "BEGIN IMMEDIATE" once the body is done.
  const frames: Array<{ method: StatementMethod; sql: string; startedAt: number }> = [];
  const writeTop = (): void => {
    const top = frames[frames.length - 1];
    writeMarker(
      top === undefined
        ? null
        : JSON.stringify({
            v: 1,
            pid,
            ...(markerDbPath === undefined ? {} : { dbPath: markerDbPath }),
            method: top.method,
            startedAt: top.startedAt,
            depth: frames.length,
            sql: clipSql(top.sql),
          }),
    );
  };

  return {
    inflightPath,

    begin(method, sql) {
      const startedAt = now();
      frames.push({ method, sql, startedAt });
      writeTop();
      return startedAt;
    },

    end(startedAt, method, sql, rows) {
      frames.pop();
      writeTop();
      const elapsedMs = now() - startedAt;
      if (elapsedMs < slowThresholdMs) return;
      try {
        const line = `${JSON.stringify({
          v: 1,
          at: new Date(startedAt).toISOString(),
          pid,
          method,
          elapsedMs,
          ...(rows === undefined ? {} : { rows }),
          sql: clipSql(sql),
        })}\n`;
        const fd = openSync(slowPath, "a", TRACE_FILE_MODE);
        try {
          fchmodSync(fd, TRACE_FILE_MODE); // the slow log persists across runs; enforce, do not assume
          writeSync(fd, line);
        } finally {
          closeSync(fd);
        }
      } catch {
        /* best effort */
      }
    },

    close() {
      frames.length = 0;
      if (inflightFd === undefined) return;
      const fd = inflightFd;
      inflightFd = undefined;
      try {
        ftruncateSync(fd, 0);
      } catch {
        /* best effort */
      }
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    },
  };
}

/** One in-flight statement, as recovered from another process's marker file. */
export interface InflightStatement {
  /** The process holding it. */
  pid: number;
  /** Epoch ms when that statement started. */
  startedAt: number;
  method: StatementMethod;
  /** Nesting depth at the time — 1 is a bare statement, higher is inside a transaction. */
  depth: number;
  /** Clipped to STATEMENT_TRACE_SQL_MAX_CHARS by the writer. */
  sql: string;
  /**
   * The store this statement runs against. Absent on markers written before this field existed —
   * which is why a reader filtering on it must treat "absent" as "cannot tell", never as "not this
   * store".
   */
  dbPath?: string;
}

/**
 * Read every live in-flight marker beside a store — the reader this module's own JSDoc has been
 * pointing at ("a reader globs `inflight-*.json` rather than naming one", and `inflightPath` exists
 * "for tests and for the reader tool"). Nothing consumed these records until #148: they were
 * written and never read.
 *
 * WHAT IT IS FOR. When a startup cannot take the store's write lock, the one thing that turns
 * "database is locked" into an actionable sentence is WHO holds it and since when. SQLite will not
 * say — it reports contention, never the holder — so the only source is what the holder itself
 * wrote down. This returns exactly that, newest statement first.
 *
 * TOTAL, NEVER THROWING. This runs on a failure path that is already reporting something else. A
 * missing directory, a marker half-written at the instant it is read, a foreign file matching the
 * glob — each is skipped, because a diagnostic that fails while diagnosing tells the operator less
 * than the error it was decorating.
 *
 * An empty result does NOT mean nothing holds the lock. It usually means tracing was off
 * (`MONET_TRACE_SQL=1`), which callers must say rather than reporting "no holder".
 */
export function readInflightStatements(dir: string): InflightStatement[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InflightStatement[] = [];
  for (const name of names) {
    if (!name.startsWith(INFLIGHT_FILENAME_PREFIX) || !name.endsWith(".json")) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (raw.trim() === "") continue; // an idle connection truncates its own marker
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // caught mid-write; the next reader gets it whole
    }
    // `JSON.parse("null")` is valid JSON and would reach the field reads below as null, throwing a
    // TypeError from a reader whose whole contract is that it never throws (Codex review, PR #216).
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Partial<InflightStatement> & { v?: number };
    if (
      typeof record.pid !== "number" || typeof record.startedAt !== "number" ||
      typeof record.method !== "string" || typeof record.sql !== "string"
    ) continue;
    out.push({
      pid: record.pid,
      startedAt: record.startedAt,
      method: record.method as StatementMethod,
      depth: typeof record.depth === "number" ? record.depth : 1,
      sql: record.sql,
      ...(typeof record.dbPath === "string" ? { dbPath: record.dbPath } : {}),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * ONE WRITER FOR THE WHOLE OF A FIXTURE PREPARATION.
 *
 * THE CONTRACT. A copy being prepared by scripts/reembed-store.ts has exactly one writer for the
 * duration. A second writer gets SQLITE_BUSY and fails loudly; it never interleaves silently.
 *
 * WHY IT HAS TO BE HELD ACROSS THE WHOLE RUN, not per row. The preparation rewrites every
 * observation and segment, and each rewrite needs an `await provider.embed(...)` before it — so the
 * writes cannot be one synchronous `db.transaction()`. Left as a sequence of short transactions,
 * anything else writing to the copy commits in one of the gaps, and the baseline MAX taken at the
 * end absorbs that foreign write as if the preparation had made it. The marker then certifies a
 * store containing a write nobody accounted for, and on a same-width swap every later check passes.
 * Laundering, not corruption — which is why nothing downstream could catch it.
 *
 * BEGIN IMMEDIATE, NOT `PRAGMA locking_mode = EXCLUSIVE`. Both exclude a second WRITER (probed on a
 * WAL database with two connections: both yield SQLITE_BUSY). They differ on readers — under
 * `locking_mode = EXCLUSIVE` a second connection cannot even READ, which is stricter than this
 * contract needs and would block a `measure-*` header from inspecting the copy. BEGIN IMMEDIATE
 * takes the write lock at once (rather than deferring to first write, which is the race) and leaves
 * readers alone. It also survives the `await` gaps: better-sqlite3 is synchronous and nothing else
 * runs on this connection, so `db.inTransaction` stays true across them (probed).
 *
 * ON INTERRUPT. The lock lives in the connection; if the process dies the OS closes it and the next
 * opener rolls the transaction back, so nothing is left half-written and no lock leaks. What must
 * NOT be inside the transaction is the marker's opening row — see reembed-store.ts, which commits
 * that first precisely so an interrupted preparation is still visible as one.
 */
interface LockableDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  readonly inTransaction: boolean;
}

/**
 * Take the copy's write lock for this connection and hold it until release.
 *
 * Throws with a directive message when someone else already holds it — better than waiting, because
 * the other holder is either a second preparation or a live process, and both mean the operator is
 * pointed at the wrong file.
 */
export function acquireExclusiveWriteLock(db: LockableDatabase, what: string): void {
  try {
    db.prepare("BEGIN IMMEDIATE").run();
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error);
    throw new Error(
      `Cannot take the write lock on this copy (${code}), so ${what} would have to interleave with ` +
      `another writer. A fixture copy must have exactly one writer while it is prepared. Close ` +
      `whatever else has it open — or point this at a copy nobody else is using — and re-run.`,
    );
  }
}

/** Publish everything written under the lock, and release it. */
export function releaseExclusiveWriteLock(db: LockableDatabase): void {
  if (db.inTransaction) db.prepare("COMMIT").run();
}

interface PublishableDatabase {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

/**
 * Mark the preparation complete — but ONLY on the marker this run opened.
 *
 * THE ONE GAP THE LOCK CANNOT CLOSE. The opening marker is committed BEFORE the lock, deliberately,
 * so an interrupted run stays visible as one (see reembed-store.ts). That leaves a window in which
 * two preparations starting together both run their phase-1 INSERT, and the second's
 * `ON CONFLICT DO UPDATE` overwrites the first's identity columns — candidate model, pooling, dtype,
 * width. Only afterwards does one of them win the lock and rewrite. A completion written as
 * `SET completed_at = ?, rows_max_at = ? WHERE singleton = 1` touches neither identity nor
 * ownership, so it would stamp "valid" onto the OTHER run's description of a store this run had just
 * written with a different model. Every downstream check then passes, because the marker itself
 * certifies the wrong answer.
 *
 * The token is checked IN the UPDATE rather than read first and compared: a read-then-write would
 * have a race of its own. Zero rows changed means someone else's marker is in place, and the caller
 * must publish nothing and fail — leaving its own rewrites to roll back with the uncommitted
 * transaction, and the copy reading as the interrupted preparation it now is.
 */
export function publishFixtureMarker(
  db: PublishableDatabase,
  runToken: string,
  completedAt: number,
  rowsMaxAt: number | null,
): { published: boolean; changes: number } {
  const result = db.prepare(
    `UPDATE reembed_provenance SET completed_at = ?, rows_max_at = ? WHERE singleton = 1 AND run_token = ?`,
  ).run(completedAt, rowsMaxAt, runToken);
  return { published: result.changes === 1, changes: result.changes };
}

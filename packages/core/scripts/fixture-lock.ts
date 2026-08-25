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

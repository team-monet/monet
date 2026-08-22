import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { deriveCircle as deriveFolderCircle } from "@team-monet/core";
import { getDbPath } from "./db/index.js";
import { canonicalRemoteKey, defaultNameFromRemote, getOriginRemote } from "./remote-circle.js";

// Re-exported for backward compatibility: these two were public API of this module before the P1
// fix (Codex round 2 on PR #40) extracted all three pure remote helpers into remote-circle.ts, so
// a store-less caller could depend on them without dragging `better-sqlite3` into its
// graph. `getOriginRemote` was already module-private here and stays internal-only from this
// file's own point of view (imported above, not re-exported) — remote-circle.ts is its new public
// home for callers that need it directly.
export { canonicalRemoteKey, defaultNameFromRemote };

/**
 * remote → circle resolution, layered on top of the engine's folder-hash deriveCircle.
 *
 * WHY THIS EXISTS — the engine's `deriveCircle` (circle.ts in @team-monet/core) derives a
 * per-folder slug like `code-6849de25` and the engine's `circle_aliases` table maps that slug
 * to a friendly name like `example-circle`. That couples a project's circle to the *local path* the
 * repo happens to be checked out at — so the same repo, checked out at a different path on a
 * second machine (or after a `mv`), derives a DIFFERENT folder-hash and silently routes to a
 * fresh empty circle, orphaning every concept already stored under the old slug.
 *
 * Resolving from the git REMOTE instead of the folder makes a project's circle stable across
 * machines and paths — which is what makes the shared `~/.monet` store actually live up to
 * "syncs across the user's machines." The map is stored in the same SQLite store so it syncs
 * with the rest of the brain.
 *
 * INVARIANTS PRESERVED (hard constraints — see the engine's circle.ts):
 *  (1) `scopeContext ≠ defaultCircle` — the engine must never start deriving the circle from
 *      the folder/scopeContext itself. This module STILL returns a concrete string and passes
 *      it to MonetCore as `defaultCircle`; the engine never derives. Unchanged.
 *  (2) read/write circle symmetry — every circle-accepting engine op filters `circle = ?`.
 *      The map table here is client-owned metadata the engine never reads; engine code is
 *      untouched, so its symmetry is untouched.
 *
 * BACKWARD COMPAT / ANTI-ORPHAN — the old folder-hash slug (e.g. `code-6849de25`) may already
 * be aliased in the engine's `circle_aliases` table to a friendly name (e.g. `example-circle`) that
 * already holds the user's memory. If the new remote-based resolution silently returned a
 * fresh repo-name circle, that memory would be orphaned. So when we derive a candidate from a
 * remote, we FIRST check whether the folder-hash slug for the same dir already aliases
 * somewhere — if it does, we follow the alias to its `to_name` and record the remote against
 * THAT. This makes remote-based resolution backward-compatible by construction for every repo
 * that already has stored memory.
 *
 * PER-USER CONSOLIDATION — to collapse multiple repos into one circle (e.g. map both
 * `team-monet/monet-core` and `team-monet/monet-client` to `example-circle`), insert rows directly
 * into `remote_circle_map`. That is DATA — user configuration — and belongs in the store, not
 * as a hard-coded list in this module. This resolver has no knowledge of any specific project.
 */

/**
 * Derive a circle for the project at `projectDir`. Resolution order:
 *   1. `MONET_CIRCLE` env override (explicit force; mirrors the engine's mcp-cli escape hatch).
 *   2. git remote `origin` of projectDir, looked up in the remote→circle map. Hit → use it.
 *   3. Remote exists but unmapped → FIRST follow any existing folder-hash alias (Class A) or
 *      keep the raw slug if it already holds memory — concepts or observations — (Class B) so we
 *      don't orphan memory. Class A/B: record the mapping (depends on local store state; must
 *      sync). Genuinely-new repo (no alias, no memory): return the deterministic host/org/repo
 *      name WITHOUT writing
 *      a map row — the default is already stable across machines and not persisting avoids
 *      locking in a mapping before the pre-publish migration can seed the correct one.
 *   4. No remote / no git → fall back to the engine's folder-hash deriveCircle (today's
 *      behavior), recorded under a synthetic local key.
 *
 * Never throws — any store/git failure degrades to the folder-hash fallback so the MCP server
 * still starts.
 *
 * `opts.readOnly` — FIX 4 (Codex round 2 on PR #42), for a caller that must resolve a circle
 * WITHOUT writing anything. A plain call here opens the store READ-WRITE (CREATE TABLE IF NOT
 * EXISTS remote_circle_map on a store that doesn't have it yet) and can INSERT a mapping via the
 * Class A/B `writeMap` path — a real, persistent side effect from a caller that may promise it
 * makes none. The caller this was built for was `monet install --dry-run`'s preview, which no
 * longer exists; no in-tree caller passes the flag today. `readOnly: true` instead:
 *   (a) skips the store connection ENTIRELY when the db file does not exist yet (no directory or
 *       file gets created just to answer a preview) — falls straight to the same pure fallback
 *       chain (remote-derived default, or folder-hash with no remote) a genuinely fresh repo with
 *       no store would resolve to either way.
 *   (b) when the file DOES exist, opens it with better-sqlite3's `{ readonly: true, fileMustExist:
 *       true }` and never issues `CREATE TABLE IF NOT EXISTS` — verified empirically (this fix's
 *       own report cites the exact probe) that a DDL write against a readonly connection throws
 *       "attempt to write a readonly database" (SQLITE_READONLY), so this is not optional. Every
 *       downstream read (`readMap`, `resolveAlias`, `hasMemoryInCircle`) already tolerates — or,
 *       for `readMap`, now ALSO tolerates, see that function's own comment — a table that does not
 *       exist yet by treating it as the benign "nothing mapped/aliased/stored" case, which is
 *       exactly what CREATE TABLE IF NOT EXISTS would have produced anyway on a truly fresh table.
 *   (c) skips `writeMap` — the preview never persists a Class A/B mapping.
 * THE RESOLUTION VALUE ITSELF is identical to a real, non-readonly call in every case above — the
 * ONLY difference `readOnly` makes is whether a Class A/B mapping gets PERSISTED. Verified: the
 * fallback-chain logic below runs unchanged either way; only the final `writeMap` call is gated.
 */
/**
 * P1-2 (Codex round 3 on PR #42) `opts.storeDir` — the follow-on to last round's P1-B audit, which
 * found (but did not yet fix) that `source add --path /other/repo` derives the circle against the
 * WORKTREE's own store (P1-B's own `projectDir`-rooted `openMapStore`) while `createSource` writes
 * the resulting row into the INVOKING project's store — circle resolved from store B, row written
 * into store A. `projectDir` stays the GIT-IDENTITY root (what the remote lookup and the
 * folder-hash are computed FROM — this must always be the WORKTREE, since that is the repo whose
 * identity is actually being registered); `storeDir` (defaults to `projectDir` — behavior-identical
 * for every EXISTING caller that never passes it) roots the SQLITE CONSULTATION instead (the
 * `remote_circle_map`/`circle_aliases`/`concepts`/`observations` reads and the Class A/B write) —
 * see source-cli.ts's own two worktree call sites, which now pass `storeDir` explicitly to restore
 * consistency with where `createSource` actually writes, and this function's own updated AUDITED
 * comment below (openMapStore) for the full final matrix across every caller.
 */
export function deriveCircle(projectDir: string, opts: { readOnly?: boolean; storeDir?: string } = {}): string {
  // 1. Explicit override wins outright.
  const override = process.env.MONET_CIRCLE;
  if (override && override.trim()) return override.trim();

  const readOnly = opts.readOnly === true;
  const storeDir = opts.storeDir ?? projectDir;
  if (readOnly && !existsSync(getDbPath(storeDir))) {
    // No store to consult at all, and readOnly forbids creating one just to look. Same answer a
    // genuinely fresh repo (no alias, no memory — both require a store that already holds
    // something) would get from the real, non-readonly path below: the remote-derived default, or
    // the pure folder-hash with no remote. IDENTITY (remote/folder-hash) still comes from
    // `projectDir`, never `storeDir` — only the store-existence check itself moved.
    const remote = getOriginRemote(projectDir);
    return remote ? defaultNameFromRemote(remote) : deriveFolderCircle(projectDir);
  }

  // Open a brief raw connection to the STORE (storeDir, which caller and identity, projectDir,
  // agree on for every existing caller and DELIBERATELY diverge from for source-cli's worktree
  // sites — see this function's own {storeDir} comment above). WAL + busy_timeout (set in
  // BetterSqlitePort) make this concurrent read/write safe. Failures here degrade to the
  // folder-hash fallback — the MCP server must still start.
  let raw: Database.Database | null = null;
  try {
    raw = openMapStore(storeDir, readOnly);
    const remote = getOriginRemote(projectDir);

    if (remote) {
      const key = canonicalRemoteKey(remote);
      const mapped = readMap(raw, key);
      if (mapped) return mapped;

      // Unmapped remote. Resolve a circle WITHOUT orphaning existing memory. Three cases:
      //   (Class A) the folder-hash slug for this dir is aliased to a friendly name in the
      //             engine's circle_aliases table → follow the alias (renamed-circle case).
      //   (Class B) no alias, BUT memory (concepts or observations) already lives under the raw
      //             folder-hash slug → keep using that slug so we don't orphan it.
      //             defaultNameFromRemote would return the org-repo name and strand every concept
      //             or observation already stored.
      //   (genuinely-new repo) no alias and no stored concepts → a stable cross-machine
      //             org-repo circle.
      const folderSlug = deriveFolderCircle(projectDir);
      let circle: string;
      const aliased = resolveAlias(raw, folderSlug);
      if (aliased) {
        circle = aliased; // Class A: renamed circle
      } else if (hasMemoryInCircle(raw, folderSlug)) {
        circle = folderSlug; // Class B: existing memory (concepts or observations) under raw slug → NO ORPHAN
      } else {
        // Genuinely-new repo: return the deterministic default WITHOUT persisting the mapping.
        // Rationale: the default is a pure function of the remote (host/org/repo), so it is
        // already stable across machines without a persisted row. Not writing avoids locking in
        // a mapping before a pre-publish migration can seed the correct one — on a second machine
        // where folderSlug differs from the original checkout, the Class-B probe would miss the
        // old memory and lock in a repo-name circle that the migration would then have to fight.
        // Full rescue of memory under an old folder-hash on a fresh machine is inherently the
        // pre-publish migration's job; this path just provides the deterministic interim name.
        return defaultNameFromRemote(remote);
      }
      // Class A or Class B: mapping depends on local store state and must sync across machines.
      // FIX 4: readOnly never persists — the resolution VALUE above is
      // identical either way; only whether it gets WRITTEN differs.
      if (!readOnly) writeMap(raw, key, circle);
      return circle;
    }

    // No remote / no git → folder-hash fallback (today's behavior). The engine resolves this
    // slug via circle_aliases at write time, so return it directly; no map write is needed
    // (a synthetic local key was never read back, and a later `git remote add origin` re-
    // resolves via the real remote because the remote-present branch above takes precedence).
    return deriveFolderCircle(projectDir);
  } catch (err) {
    // Never block startup — degrade to the pure folder-hash derivation, no store writes.
    console.error(`[monet] deriveCircle: remote-map resolution failed, using folder fallback: ${(err as Error).message}`);
    return deriveFolderCircle(projectDir);
  } finally {
    if (raw) {
      try {
        raw.close();
      } catch {
        // best-effort close
      }
    }
  }
}

/**
 * Open the store at getDbPath(storeDir) with WAL + busy_timeout, matching the engine's setup.
 * `storeDir` — not `projectDir` — deliberately: this function only ever answers "which SQLITE
 * FILE", never "whose git identity"; see deriveCircle's own {storeDir} comment for why the two can
 * diverge (source-cli's worktree sites) and why they don't for every other caller.
 *
 * P1-B FIX (Codex round 1 on PR #42): this used to call the bare, argument-less `getDbPath()`,
 * which resolves via `getMonetDir()`'s OWN internal `process.cwd()` default — a SEPARATE "which
 * project" notion from the directory this function's caller (`deriveCircle`) was given. `monet
 * install --project /other/repo` exposed the divergence: the pinned circle came from resolving
 * `/other/repo`'s remote/folder-hash, but the STORE consulted to resolve it (the alias table, the
 * remote_circle_map) was whatever `.monet` sat under the INVOKING process's cwd (or `~/.monet`) —
 * the target repo's own project-local store, if it had one, was never looked at. `MONET_STORAGE_DIR`
 * still wins over `storeDir` by construction (see `getMonetDir`'s own resolution order) — that rung
 * is an explicit env override, not a cwd guess, and stays the escape hatch it always was.
 *
 * THE FINAL MATRIX (P1-2, Codex round 3 on PR #42, updated from P1-B's own audit above after
 * finding — not yet fixing, last round — that the two worktree call sites below still diverged
 * from where `createSource` actually writes) — every caller of `deriveCircle` in this codebase,
 * its IDENTITY root (`projectDir` — what the remote lookup and folder-hash are computed FROM) and
 * its STORE root (`storeDir`, defaulting to `projectDir` when omitted):
 *   - `cli.ts`'s `start` action and `index.ts`'s stdio entry: both roots = the SAME resolved
 *     `projectDir` (`resolveProjectDir()`) — unchanged, no divergence exists for either (the
 *     process being identified IS the process whose store it opens).
 *   - `source-cli.ts`'s two git-md branches: both roots = `projectDir` (the invoking project) —
 *     unchanged; a git-md source has no separate worktree concept to diverge from.
 *   - `source-cli.ts`'s two repo-md/worktree branches (`resolveGitWorktreeRoot`-derived
 *     `localPath`): identity root = `localPath` (the WORKTREE's own remote/folder-hash — this
 *     MUST stay the worktree's, since that is the repo whose identity is actually being
 *     registered as a source); store root = `projectDir` (the INVOKING project) — deliberately
 *     DIFFERENT from identity, because `createSource` (via `withCore`/`dependencies.openCore`)
 *     always writes the resulting source row into the invoking project's own store, never the
 *     worktree's. Before this fix, both roots were `localPath`: the circle NAME got resolved by
 *     consulting the WORKTREE's `remote_circle_map`/alias table, then the SOURCE ROW landed in a
 *     DIFFERENT store (the invoking project's) that was never consulted — a custom mapping row
 *     living in the invoking project's own store (the one `createSource` actually writes to) could
 *     never be found, and a Class A/B write from the worktree's store could never be seen by
 *     anything reading the invoking project's store afterward either.
 *
 * ROUND 4 CLOSURE (P1-B + P2-D, Codex round 4 on PR #42) — the matrix above audits every CALLER OF
 * `deriveCircle`, but a related gap sat one layer out, in what each caller's OWN store-opening
 * call (independent of anything routed through this function) actually resolved to:
 *   - `source-cli.ts`'s `withCore` opens its store via `dependencies.openCore(storageDir)` —
 *     `cli.ts`'s own implementation of that callback — NOT through `deriveCircle` at all. Before
 *     this round, it called `ensureMonetDir()`/`getDbPath()` BARE (cwd-rooted) when no explicit
 *     `--dir` was given, independent of `projectDir` above. So even after P1-2 made `deriveCircle`
 *     itself consult `storeDir: projectDir` correctly, the store `createSource` actually WROTE TO
 *     (via `openCore`, never through `deriveCircle`) could still diverge from it under a
 *     MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR override — P1-2 fixed what `deriveCircle` consults, not
 *     what its caller separately opens. `cli.ts`'s `openCore`/`dbPath` callbacks now root their own
 *     bare branch at `resolveProjectDir()` too — the identical value `source-cli.ts`'s own
 *     `projectDir` local already holds (a pure function of env/cwd, so two independent calls can
 *     never disagree) — closing the loop: the store `deriveCircle`'s `{storeDir: projectDir}`
 *     argument consults and the store `openCore` opens are now the same resolved directory.
 *   - Several commands that never call `deriveCircle` at all had the identical bare-cwd shape on
 *     their OWN store-opening calls: `cli.ts`'s `status` and `dashboard` actions, and
 *     `repair-cli.ts`'s `doctor`/`repair` (via `defaultRecoveryDependencies`'s `dbPath` fallback).
 *     All now root at `resolveProjectDir()` the same way — see each call site's own comment. An
 *     explicit `-d/--dir`/`--project` flag still wins outright wherever one exists, automatically,
 *     via `MONET_STORAGE_DIR`'s higher precedence in `getMonetDir`'s own resolution chain (above) —
 *     no new branching needed anywhere for that.
 * The store OPENED and the store CONSULTED are now the same object in every command in this
 * codebase, not only the ones that route through `deriveCircle`.
 *
 * `readOnly` (FIX 4, Codex round 2 on PR #42) — EMPIRICALLY VERIFIED against this exact
 * better-sqlite3/SQLite build (see that fix's own report for the probe script and raw output):
 *   - `db.pragma("journal_mode = WAL")` on a `{readonly: true}` connection: silent no-op, no
 *     throw — but also pointless (a reader cannot change the file's journal mode), so skipped
 *     rather than called for no effect.
 *   - `db.pragma("busy_timeout = ...")` on a readonly connection: no throw, and NOT pointless — a
 *     reader can still be blocked by a concurrent writer's lock; this is what makes it wait the
 *     lock out instead of erroring immediately. Kept unconditionally.
 *   - `db.exec("CREATE TABLE IF NOT EXISTS ...")` on a readonly connection, table absent: THROWS
 *     "attempt to write a readonly database" (SQLITE_READONLY) — DDL is a write regardless of
 *     "IF NOT EXISTS". Skipped entirely when readOnly; see readMap's own comment for how a
 *     genuinely-missing table is still handled safely without this having run.
 */
function openMapStore(storeDir: string, readOnly: boolean): Database.Database {
  const db = new Database(getDbPath(storeDir), readOnly ? { readonly: true, fileMustExist: true } : undefined);
  if (!readOnly) db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  if (!readOnly) {
    // Client-owned metadata table. The engine never reads or writes this; it lives in the same
    // DB file so it syncs with the rest of the store. CREATE IF NOT EXISTS is idempotent.
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_circle_map (
        remote_url TEXT PRIMARY KEY,
        circle     TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
  }
  return db;
}

function readMap(db: Database.Database, key: string): string | null {
  try {
    const row = db
      .prepare(`SELECT circle FROM remote_circle_map WHERE remote_url = ?`)
      .get(key) as { circle: string } | undefined;
    return row ? row.circle : null;
  } catch (err) {
    // FIX 4: only reachable in readOnly mode, where openMapStore deliberately skips CREATE TABLE
    // IF NOT EXISTS — EMPIRICALLY VERIFIED this throws "no such table: remote_circle_map"
    // (SQLITE_ERROR), matching isMissingTable's own check exactly. Same benign-empty treatment
    // resolveAlias/hasMemoryInCircle already give a missing table: nothing mapped, not a failure.
    if (isMissingTable(err)) return null;
    throw err; // real error → let deriveCircle degrade to the folder-hash fallback
  }
}

function writeMap(db: Database.Database, key: string, circle: string): void {
  db.prepare(
    `INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)
     ON CONFLICT(remote_url) DO UPDATE SET circle = excluded.circle`,
  ).run(key, circle);
}

/**
 * Follow the engine's circle_aliases table: from_name → to_name (active only). Read-only.
 *
 * The `circle_aliases` table is created by the ENGINE on first MonetCore construction. But
 * deriveCircle runs BEFORE the engine is constructed in the launch flow (cli.ts/index.ts call
 * deriveCircle, then `new MonetCore(...)`), so on a brand-new store the table may not exist
 * yet. That's fine — no aliases means no backward-compat routing to follow, so return null
 * and let the caller use the repo-name default.
 *
 * ERROR HANDLING: only a MISSING TABLE is the benign empty case (the engine simply hasn't
 * created the table yet). Any OTHER error (e.g. SQLITE_BUSY beyond busy_timeout, a corrupt
 * page, a schema mismatch) is real and is RE-THROWN so deriveCircle's outer catch degrades to
 * the SAFE folder-hash fallback — instead of being swallowed here as "no alias", which would
 * let the Class-B orphan guard misfire to the repo-name default and orphan memory.
 */
function resolveAlias(db: Database.Database, name: string): string | null {
  try {
    const row = db
      .prepare(`SELECT to_name FROM circle_aliases WHERE from_name = ? AND status = 'active'`)
      .get(name) as { to_name: string } | undefined;
    return row ? row.to_name : null;
  } catch (err) {
    if (isMissingTable(err)) return null; // engine hasn't opened the store yet → no aliases
    throw err; // real error → let deriveCircle degrade to the folder-hash fallback
  }
}

/**
 * Read-only probe of the engine-owned `concepts` AND `observations` tables: is there ANY memory
 * stored under `circle`? Used by the unmapped-remote resolution (Class B) to avoid orphaning
 * memory that lives under the raw folder-hash slug when there's no alias row.
 *
 * BOTH tables are checked because `observations` has its own `circle` column (engine.ts
 * `CREATE TABLE observations … circle TEXT NOT NULL DEFAULT 'default'`) and CAN hold
 * circle-scoped rows without a corresponding concept row in that circle — e.g. an observation
 * written before synthesis has run, or after a partial migration that moved concepts but left
 * observations behind. Checking only `concepts` would miss this case and incorrectly let the
 * orphan guard fall through to the repo-name default, stranding those observations.
 *
 * Like resolveAlias, this runs BEFORE the engine is constructed (deriveCircle is called in
 * cli.ts/index.ts before `new MonetCore(...)`), so on a brand-new store the tables may not
 * exist yet. WAL + busy_timeout make the reads safe even once the engine has the store open
 * concurrently.
 *
 * ERROR HANDLING: only a MISSING TABLE is benign (return false — nothing to orphan). Any OTHER
 * error is RE-THROWN. This matters for the Class-B guard: if this function swallowed a
 * transient SQLITE_BUSY as "no memory", deriveCircle would fall through to the repo-name
 * default and orphan every concept/observation actually living under the slug. Rethrowing
 * routes the failure to deriveCircle's outer catch, which degrades to the folder-hash slug —
 * the SAFE fallback that preserves any memory under the slug.
 */
function hasMemoryInCircle(db: Database.Database, circle: string): boolean {
  // Check concepts first — the common case.
  try {
    const row = db
      .prepare(`SELECT 1 FROM concepts WHERE circle = ? LIMIT 1`)
      .get(circle) as { 1: number } | undefined | null;
    if (row != null) return true;
  } catch (err) {
    if (isMissingTable(err)) return false; // engine hasn't init'd yet → no tables → no memory
    throw err; // real error → let deriveCircle degrade to the folder-hash fallback
  }
  // Also check observations — they carry their own circle column and can exist without a
  // concept row in the same circle (see docstring above).
  try {
    const row = db
      .prepare(`SELECT 1 FROM observations WHERE circle = ? LIMIT 1`)
      .get(circle) as { 1: number } | undefined | null;
    return row != null;
  } catch (err) {
    if (isMissingTable(err)) return false; // no observations table yet → no observations
    throw err; // real error → let deriveCircle degrade to the folder-hash fallback
  }
}

/**
 * Does this error represent "the table doesn't exist yet"? SQLite/better-sqlite3 raises this
 * for a SELECT against a table that was never created. We key on the message text (stable
 * across better-sqlite3 versions) rather than the numeric code, because better-sqlite3 does
 * not always surface a reliable `.code` for prepar errors. Only this case is treated as the
 * benign empty-by-construction case in the probes above; everything else is a real failure.
 */
function isMissingTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("no such table");
}

/**
 * ── Source-authorization context (caller ID / project ID) ──────────────────────────────────
 *
 * A DISTINCT concern from circle derivation above. `@team-monet/core`'s
 * `createMonetCoreMcpServer` reads its source-authorization context ONLY from the
 * `MONET_CALLER_ID` / `MONET_PROJECT_ID` env vars (see `deriveOptsFromEnv` in the core's
 * `mcp-server.ts`) — `CreateMonetCoreMcpServerOptions` has no options-object seam for it.
 * Without BOTH vars set, `sourceAuthorizationContext` stays undefined and every `source_*` tool
 * fails closed with "trusted source authorization context is unavailable" (engine.ts), even for
 * sources registered with ACLs that would otherwise permit this caller/project. src/index.ts and
 * src/cli.ts's `start` action wire these in by UNCONDITIONALLY assigning
 * `process.env.MONET_CALLER_ID = deriveCallerId()` / `process.env.MONET_PROJECT_ID =
 * deriveProjectId(projectDir)` before constructing the server. deriveCallerId/deriveProjectId
 * already implement the full precedence (a non-blank override wins, TRIMMED; blank/unset falls
 * back to the derived default), so reassigning process.env through them also NORMALIZES a
 * whitespace-padded operator override (e.g. `" codex "`) in place — @team-monet/core's
 * `deriveOptsFromEnv` reads these env vars verbatim with no trimming of its own, so leaving a
 * padded value raw would make every ACL comparison miss.
 */

/**
 * Default caller ID when MONET_CALLER_ID is unset. This is a CONVENTION matching
 * `monet source add --allow-caller local-agent` (the default ACL an operator would grant a
 * local, unauthenticated agent) — not an engine contract. The engine treats callerId as an
 * opaque string.
 */
export const DEFAULT_CALLER_ID = "local-agent";

/**
 * Resolve the caller ID for source authorization. `MONET_CALLER_ID` override wins if non-blank
 * (trimmed); otherwise `DEFAULT_CALLER_ID`. Never throws.
 */
export function deriveCallerId(): string {
  const override = process.env.MONET_CALLER_ID;
  return override && override.trim() ? override.trim() : DEFAULT_CALLER_ID;
}

/**
 * Source-authorization projectId — DISTINCT from deriveCircle's memory-partition slug above.
 * Resolution order:
 *   1. `MONET_PROJECT_ID` env override (explicit force), if non-blank (trimmed).
 *   2. Git remote present → `canonicalRemoteKey`'s slash form (host/owner/repo, e.g.
 *      `github.com/team-monet/monet-core`), matching how `--allow-project` values are written
 *      (see source-cli.ts's `--allow-project`).
 *   3. No remote → the same folder-hash form deriveCircle produces for pathless dirs (e.g.
 *      `code-6849de25` for `/Users/dev/code`).
 *
 * The no-remote fallback deliberately calls the engine's pure `deriveFolderCircle` rather than
 * THIS file's `deriveCircle`: `deriveCircle` opens (and, on a fresh store, creates the schema
 * for) the `remote_circle_map` SQLite store on every call — including the no-remote path — which
 * is I/O this derivation doesn't need for a value that's a pure function of the path. Both
 * ultimately produce the identical string on the no-remote path (deriveCircle's own no-remote
 * branch returns `deriveFolderCircle(projectDir)` directly), so using the pure function here
 * changes no output, only removes the unnecessary store I/O.
 *
 * Never throws — any git failure degrades to the folder-hash fallback.
 */
export function deriveProjectId(projectDir: string): string {
  const override = process.env.MONET_PROJECT_ID;
  if (override && override.trim()) return override.trim();
  try {
    const remote = getOriginRemote(projectDir);
    if (remote) return canonicalRemoteKey(remote);
  } catch {
    // fall through to folder-hash
  }
  return deriveFolderCircle(projectDir);
}

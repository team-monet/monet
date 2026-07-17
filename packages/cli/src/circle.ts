import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { deriveCircle as deriveFolderCircle } from "@team-monet/core";
import { getDbPath } from "./db/index.js";

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
 */
export function deriveCircle(projectDir: string): string {
  // 1. Explicit override wins outright.
  const override = process.env.MONET_CIRCLE;
  if (override && override.trim()) return override.trim();

  // Open a brief raw connection to the same store the engine will use. WAL + busy_timeout
  // (set in BetterSqlitePort) make this concurrent read/write safe. Failures here degrade to
  // the folder-hash fallback — the MCP server must still start.
  let raw: Database.Database | null = null;
  try {
    raw = openMapStore();
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
      writeMap(raw, key, circle);
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

/** Open the store at getDbPath() with WAL + busy_timeout, matching the engine's setup. */
function openMapStore(): Database.Database {
  const db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // Client-owned metadata table. The engine never reads or writes this; it lives in the same
  // DB file so it syncs with the rest of the store. CREATE IF NOT EXISTS is idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_circle_map (
      remote_url TEXT PRIMARY KEY,
      circle     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  return db;
}

function readMap(db: Database.Database, key: string): string | null {
  const row = db
    .prepare(`SELECT circle FROM remote_circle_map WHERE remote_url = ?`)
    .get(key) as { circle: string } | undefined;
  return row ? row.circle : null;
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

/** `git -C <dir> remote get-url origin` — empty string on any failure (no throw). */
function getOriginRemote(projectDir: string): string {
  try {
    const url = execFileSync("git", ["-C", projectDir, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return url;
  } catch {
    return "";
  }
}

/**
 * Canonicalize a remote URL to a `host/path` key. Rules:
 *   - Host is always lowercased; path case is PRESERVED (Team/Repo ≠ team/repo).
 *   - Userinfo (user@ or user:pass@) is STRIPPED — must never appear in the key, the
 *     derived circle name, the map row, or any log output (security requirement).
 *   - Scheme, leading/trailing slashes, and trailing .git are stripped. Trailing slashes are
 *     stripped BEFORE .git so `repo.git/` canonicalizes correctly.
 *   - Default ports (ssh 22, https 443, http 80, git 9418) are stripped. Non-default ports
 *     are KEPT in the host segment (e.g. `host:2222/org/repo`) so distinct self-hosted services
 *     at different ports don't collapse to the same key. Port stripping applies ONLY to
 *     URL-schemed forms; the SCP colon is a path separator, not a port.
 *   - SSH, HTTPS, ssh://, and git:// forms of the same repo collapse to one key.
 *   - Repos at different hosts with the same path stay distinct.
 *
 * Supported forms:
 *   SCP-like:    [user@]host:org/repo(.git)           → host/org/repo
 *   ssh://       [user@]host[:port]/org/repo(.git)    → host/org/repo  (default port stripped; non-default kept as host:port)
 *   https?://    [user[:pass]@]host[:port]/org/repo.. → host/org/repo
 *   git://       host/org/repo(.git)                  → host/org/repo
 *
 * Fallback: anything unparseable → lowercase the host segment only, preserve path case,
 * strip any userinfo, never crash.
 *
 * Examples:
 *   git@github.com:team-monet/monet-core.git        → github.com/team-monet/monet-core
 *   https://github.com/team-monet/monet-core        → github.com/team-monet/monet-core
 *   ssh://git@github.com/team-monet/monet-core.git  → github.com/team-monet/monet-core
 *   ssh://github.com/team-monet/monet-core.git      → github.com/team-monet/monet-core
 *   https://user:pass@github.com/acme/w.git         → github.com/acme/w  (no credentials)
 *   git@gitlab.company.com:acme/widgets.git         → gitlab.company.com/acme/widgets
 *   git.example.com:Team/Repo                       → git.example.com/Team/Repo
 */
export function canonicalRemoteKey(remote: string): string {
  const r = remote.trim();
  if (!r) return r;

  // Strip trailing slashes FIRST, then .git. Order matters: `repo.git/` (trailing slash after
  // .git, which `git remote add` accepts) would not match /\.git$/ while the slash is present,
  // leaving .git in the key. Stripping slashes first makes `repo.git/` → `repo.git` → `repo`.
  const stripped = r.replace(/\/+$/, "").replace(/\.git$/, "");

  // ── URL-schemed forms: ssh://, https?://, git:// ──────────────────────────
  const schemeMatch = stripped.match(/^(ssh|https?|git):\/\/([^/]+)(\/.*)?$/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    let hostPart = schemeMatch[2]; // may include userinfo (user:pass@) and/or port (:443)
    const rawPath = schemeMatch[3] ?? "";

    // Strip userinfo: user@ or user:pass@ before the host.
    hostPart = hostPart.replace(/^[^@]+@/, "");
    // Strip only THIS scheme's default port; keep any other port. Stripping default ports
    // scheme-independently would collapse e.g. `ssh://host:443` (443 is non-default for ssh)
    // onto the default-ssh service on that host and mix distinct self-hosted repos. Non-default
    // ports (e.g. :2222) stay in the host segment so distinct services get distinct keys.
    // NOTE: URL-schemed forms only; the SCP form `git@host:path` uses the colon as a path
    // separator and never reaches this branch.
    const defaultPort: Record<string, string> = { ssh: "22", http: "80", https: "443", git: "9418" };
    const dp = defaultPort[scheme];
    if (dp) hostPart = hostPart.replace(new RegExp(`:${dp}$`), "");

    const host = hostPart.toLowerCase();
    const path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!path) return host;
    return `${host}/${path}`;
  }

  // ── SCP-like form: [user@]host:path ───────────────────────────────────────
  // Guard: must not contain :// (those forms were handled above; re-entering here would
  // mis-parse e.g. "https" as the host and the rest as the path).
  if (!stripped.includes("://")) {
    const scpMatch = stripped.match(/^(?:[^@:]+@)?([^:]+):(.+)$/);
    if (scpMatch) {
      const host = scpMatch[1].toLowerCase();
      const path = scpMatch[2].replace(/^\/+/, "").replace(/\/+$/, "");
      if (!path) return host;
      return `${host}/${path}`;
    }
  }

  // ── Fallback: bare host/path or anything else ──────────────────────────────
  // Strip any user@ prefix to keep credentials out even in the fallback.
  let fallback = stripped.replace(/^[^@]+@/, "");
  // Lowercase only the host (everything before the first slash), preserve path case.
  const slashIdx = fallback.indexOf("/");
  if (slashIdx >= 0) {
    return fallback.slice(0, slashIdx).toLowerCase() + "/" + fallback.slice(slashIdx + 1);
  }
  return fallback.toLowerCase();
}

/**
 * Default circle name from a remote URL — the FULL canonical `host/path` key from
 * canonicalRemoteKey with every slash turned into a hyphen. The host is included so that repos
 * at DIFFERENT hosts with the same `org/repo` path get DISTINCT circle names (circles are
 * identified by name in the engine, so name collisions would mix memory).
 *
 * Case: the host is already lowercase in the canonical key; path case is PRESERVED — so
 * `Team/Repo` and `team/repo` produce distinct names (`host-Team-Repo` vs `host-team-repo`)
 * and are correctly routed to distinct circles. Do NOT add `.toLowerCase()` here.
 *
 *   git@github.com:team-monet/monet-core.git   → github.com-team-monet-monet-core
 *   https://github.com/team-monet/with-monet    → github.com-team-monet-with-monet
 *   git@github.com:acme/widgets.git             → github.com-acme-widgets
 *   git@gitlab.company.com:acme/widgets.git     → gitlab.company.com-acme-widgets
 *   git.example.com:Team/Repo                   → git.example.com-Team-Repo
 *
 * For a remote that doesn't canonicalize to a `host/path` (no slash in the canonical key),
 * sanitize to a legal slug so the name is stable rather than a raw URL.
 */
export function defaultNameFromRemote(remote: string): string {
  const key = canonicalRemoteKey(remote);
  if (!key) return "project";
  // host/org/repo → host-org-repo. Case is inherited from canonicalRemoteKey: host is
  // lowercase, path is preserved. Do NOT add .toLowerCase() — it would collapse Team/Repo
  // and team/repo to the same name and re-introduce the memory-mixing the key prevents.
  const slug = key.includes("/")
    ? key.replace(/\//g, "-")
    : key.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "project";
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

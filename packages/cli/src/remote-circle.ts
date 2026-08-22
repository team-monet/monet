import { execFileSync } from "node:child_process";

/**
 * Pure git-remote helpers, with NO sqlite/db imports in this module's graph — the project-dir.ts
 * precedent, extended. Extracted from circle.ts (P1 fix, Codex round 2 on PR #40) so that a
 * store-less caller could compute the SAME remote-derived circle name a live session would, without
 * dragging `better-sqlite3` into its dependency graph (circle.ts's own `deriveCircle` opens the
 * store directly). That store-less caller — the offline gate resolver — no longer exists, and
 * circle.ts is this module's only importer today, so the separation currently buys nothing; it
 * costs nothing either, and the boundary is worth keeping the next time something must resolve a
 * circle name without a store. circle.ts re-imports these three and re-exports
 * `canonicalRemoteKey`/`defaultNameFromRemote` from itself unchanged, so this stays a pure
 * extraction: ONE implementation, no behavior change. Moved, not rewritten — every doc comment
 * below is verbatim from circle.ts.
 */

/** `git -C <dir> remote get-url origin` — empty string on any failure (no throw). */
export function getOriginRemote(projectDir: string): string {
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  deriveCircle,
  canonicalRemoteKey,
  defaultNameFromRemote,
  deriveCallerId,
  deriveProjectId,
  DEFAULT_CALLER_ID,
} from "../circle";
import { MonetCore, deriveCircle as coreDeriveCircle } from "@team-monet/core";

// A self-contained temp HOME so getDbPath() resolves under it, never touching the real ~/.monet.
let tmpHome: string;
let tmpStorage: string;
let savedHome: string | undefined;
let savedMonetStorage: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "monet-circle-test-"));
  tmpStorage = join(tmpHome, ".monet");
  mkdirSync(tmpStorage, { recursive: true });
  savedHome = process.env.HOME;
  savedMonetStorage = process.env.MONET_STORAGE_DIR;
  // getDbPath() checks MONET_STORAGE_DIR first, then cwd/.monet, then HOME/.monet.
  // Setting MONET_STORAGE_DIR is the most direct lever.
  process.env.MONET_STORAGE_DIR = tmpStorage;
  delete process.env.MONET_CIRCLE;
});

afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  if (savedMonetStorage !== undefined) process.env.MONET_STORAGE_DIR = savedMonetStorage;
  else delete process.env.MONET_STORAGE_DIR;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Build a throwaway git repo with the given origin URL (or no origin if url is null). */
function makeRepo(url: string | null, name = "fixture"): string {
  const dir = mkdtempSync(join(tmpdir(), `monet-${name}-`));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "--quiet"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  g(["add", "."]);
  g(["commit", "--quiet", "-m", "init"]);
  if (url) g(["remote", "add", "origin", url]);
  return dir;
}

/** Open a raw connection to the temp store (same path deriveCircle uses) for direct inspection. */
function openStore(): Database.Database {
  const db = new Database(join(tmpStorage, "monet.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

describe("deriveCircle — pure helpers", () => {
  it("canonicalRemoteKey normalizes SSH and HTTPS of the same host/repo to the same host/org/repo key", () => {
    const ssh = canonicalRemoteKey("git@github.com:team-monet/monet-core.git");
    const https = canonicalRemoteKey("https://github.com/team-monet/monet-core");
    const sshProto = canonicalRemoteKey("ssh://git@github.com/team-monet/monet-core.git");
    expect(ssh).toBe("github.com/team-monet/monet-core");
    expect(https).toBe("github.com/team-monet/monet-core");
    expect(sshProto).toBe("github.com/team-monet/monet-core");
  });

  it("canonicalRemoteKey: same org/repo on different hosts → different keys (no cross-host collision)", () => {
    const github = canonicalRemoteKey("git@github.com:acme/widgets.git");
    const gitlab = canonicalRemoteKey("git@gitlab.company.com:acme/widgets.git");
    expect(github).toBe("github.com/acme/widgets");
    expect(gitlab).toBe("gitlab.company.com/acme/widgets");
    expect(github).not.toBe(gitlab);
    // HTTPS form of the same host collapses to the same key (parity preserved)
    expect(canonicalRemoteKey("https://github.com/acme/widgets")).toBe("github.com/acme/widgets");
  });

  it("defaultNameFromRemote returns the lowercased host-org-repo slug (full key, no last-segment collision)", () => {
    // Full host/org/repo key → host-org-repo, so distinct repos sharing a repo name don't collide.
    expect(defaultNameFromRemote("git@github.com:team-monet/monet-core.git")).toBe("github.com-team-monet-monet-core");
    expect(defaultNameFromRemote("https://github.com/team-monet/with-monet")).toBe("github.com-team-monet-with-monet");
    expect(defaultNameFromRemote("git@github.com:acme/widgets.git")).toBe("github.com-acme-widgets");
    expect(defaultNameFromRemote("https://github.com/beta/widgets")).toBe("github.com-beta-widgets");
    // Same org/repo on the same host → same circle name (parity preserved).
    expect(defaultNameFromRemote("git@github.com:acme/widgets.git")).toBe(
      defaultNameFromRemote("https://github.com/acme/widgets"),
    );
  });

  it("defaultNameFromRemote: same org/repo on different hosts → different circle names", () => {
    const github = defaultNameFromRemote("git@github.com:acme/widgets.git");
    const gitlab = defaultNameFromRemote("git@gitlab.company.com:acme/widgets.git");
    expect(github).toBe("github.com-acme-widgets");
    expect(gitlab).toBe("gitlab.company.com-acme-widgets");
    expect(github).not.toBe(gitlab);
  });

  // ── Codex findings: credential strip, path-case preservation, ssh:// no-user ──

  it("finding 1 — credentials stripped: https://user:pat@... never leaks into key or name", () => {
    const key = canonicalRemoteKey("https://user:pat@github.com/acme/widgets.git");
    expect(key).toBe("github.com/acme/widgets");
    expect(key).not.toMatch(/@/);
    expect(key).not.toMatch(/user/);
    expect(key).not.toMatch(/pat/);
    const name = defaultNameFromRemote("https://user:pat@github.com/acme/widgets.git");
    expect(name).toBe("github.com-acme-widgets");
    expect(name).not.toMatch(/@/);
    expect(name).not.toMatch(/user/);
    expect(name).not.toMatch(/pat/);
  });

  it("finding 3 — ssh:// with no user collapses to the same key as all other forms of the same repo", () => {
    // All five forms must produce the identical canonical key.
    const noUser   = canonicalRemoteKey("ssh://github.com/acme/widgets.git");
    const sshUser  = canonicalRemoteKey("ssh://git@github.com/acme/widgets.git");
    const scp      = canonicalRemoteKey("git@github.com:acme/widgets.git");
    const https    = canonicalRemoteKey("https://github.com/acme/widgets");
    const httpsGit = canonicalRemoteKey("https://github.com/acme/widgets.git");
    expect(noUser).toBe("github.com/acme/widgets");
    expect(sshUser).toBe("github.com/acme/widgets");
    expect(scp).toBe("github.com/acme/widgets");
    expect(https).toBe("github.com/acme/widgets");
    expect(httpsGit).toBe("github.com/acme/widgets");
  });

  it("finding 2 — path case preserved: Team/Repo and team/repo are DISTINCT keys and DISTINCT names", () => {
    const upper = canonicalRemoteKey("git.example.com:Team/Repo");
    const lower = canonicalRemoteKey("git.example.com:team/repo");
    expect(upper).toBe("git.example.com/Team/Repo");
    expect(lower).toBe("git.example.com/team/repo");
    expect(upper).not.toBe(lower);
    // Names must also be distinct (no extra lowercasing in defaultNameFromRemote).
    expect(defaultNameFromRemote("git.example.com:Team/Repo")).toBe("git.example.com-Team-Repo");
    expect(defaultNameFromRemote("git.example.com:team/repo")).toBe("git.example.com-team-repo");
    expect(defaultNameFromRemote("git.example.com:Team/Repo")).not.toBe(
      defaultNameFromRemote("git.example.com:team/repo"),
    );
  });

  it("host casing is normalized but path case is preserved (e.g. GitHub.com/acme/Widgets)", () => {
    // Host segment is lowercased; path segment is left as-is.
    const key = canonicalRemoteKey("GitHub.com/acme/Widgets");
    expect(key).toBe("github.com/acme/Widgets");
  });

  it("live re-verify — canonicalizer produces the stored map key for monet-client", () => {
    // The production map row is `github.com/team-monet/monet-client → example-circle`.
    // The new parser must produce exactly that key for the actual remote of this repo.
    expect(canonicalRemoteKey("git@github.com:team-monet/monet-client.git")).toBe(
      "github.com/team-monet/monet-client",
    );
  });

  it("non-default ports are kept: ssh://git@host:2222/a/b ≠ ssh://git@host:2223/a/b", () => {
    // Two distinct self-hosted services at different ports must not collapse to the same key.
    const port2222 = canonicalRemoteKey("ssh://git@host:2222/a/b");
    const port2223 = canonicalRemoteKey("ssh://git@host:2223/a/b");
    expect(port2222).toBe("host:2222/a/b");
    expect(port2223).toBe("host:2223/a/b");
    expect(port2222).not.toBe(port2223);
  });

  it("default-port stripping is scheme-specific (ssh:443 and https:22 are non-default → kept)", () => {
    // 443 is https's default, NOT ssh's: ssh://host:443 must keep the port so it doesn't
    // collide with the default-ssh service on that host. Likewise https://host:22.
    expect(canonicalRemoteKey("ssh://git@host:443/a/b")).toBe("host:443/a/b");
    expect(canonicalRemoteKey("https://host:22/a/b")).toBe("host:22/a/b");
    // And each scheme still drops its OWN default:
    expect(canonicalRemoteKey("https://host:443/a/b")).toBe("host/a/b");
    expect(canonicalRemoteKey("ssh://git@host:22/a/b")).toBe("host/a/b");
    // ssh:443 (kept) and the default-ssh service on the same host must not collapse together:
    expect(canonicalRemoteKey("ssh://git@host:443/a/b")).not.toBe(canonicalRemoteKey("ssh://git@host/a/b"));
  });

  it("default ssh port 22 is dropped and equals the SCP form of the same repo", () => {
    // ssh://git@github.com:22/a/b has the same meaning as git@github.com:a/b — they must
    // produce the same canonical key. The SCP colon is a path separator, not a port.
    const defaultPort = canonicalRemoteKey("ssh://git@github.com:22/a/b");
    const scpForm = canonicalRemoteKey("git@github.com:a/b");
    expect(defaultPort).toBe("github.com/a/b");
    expect(scpForm).toBe("github.com/a/b");
    expect(defaultPort).toBe(scpForm);
  });

  it(".git/ trailing slash canonicalizes the same as the plain form (no .git, no slash)", () => {
    // `git remote add origin https://github.com/acme/widgets.git/` is accepted by git.
    // The trailing slash must not prevent .git from being stripped.
    const withTrailingSlash = canonicalRemoteKey("https://github.com/acme/widgets.git/");
    const plain = canonicalRemoteKey("https://github.com/acme/widgets");
    expect(withTrailingSlash).toBe("github.com/acme/widgets");
    expect(withTrailingSlash).toBe(plain);
  });
});

describe("deriveCircle — resolution order", () => {
  it("MONET_CIRCLE env override wins outright and skips store access entirely", () => {
    const repo = makeRepo("git@github.com:team-monet/monet-core.git");
    process.env.MONET_CIRCLE = "forced-circle";
    expect(deriveCircle(repo)).toBe("forced-circle");
    // The override returns before any store access, so the map table isn't even created —
    // that IS the proof no write happened. A missing table is correct here.
    const db = openStore();
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_circle_map'").get() as { name: string } | undefined;
    if (hasTable) {
      const rows = db.prepare("SELECT * FROM remote_circle_map").all();
      expect(rows).toHaveLength(0);
    }
    // else: no table → no write → correct.
    db.close();
  });

  it("remote → map HIT returns the mapped circle (no write)", () => {
    const repo = makeRepo("git@github.com:some-org/some-repo.git");
    // Prime the map with a known mapping using the canonical host/org/repo key.
    const db = openStore();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_circle_map (remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run("github.com/some-org/some-repo", "my-circle");
    db.close();

    const circle = deriveCircle(repo);
    expect(circle).toBe("my-circle");
    // Hit path does NOT write.
    const db2 = openStore();
    const row = db2.prepare("SELECT circle FROM remote_circle_map WHERE remote_url = ?").get("github.com/some-org/some-repo") as { circle: string };
    db2.close();
    expect(row.circle).toBe("my-circle");
  });

  it("unmapped genuinely-new remote → returns host/org/repo name but writes NO remote_circle_map row", () => {
    // The default circle name is a pure deterministic function of the remote (host/org/repo),
    // so it is stable across machines without a persisted row. Not writing avoids locking in
    // a mapping before a pre-publish migration can seed the correct one — on a second machine
    // where folderSlug differs, the Class-B probe would miss the old memory and lock in a
    // repo-name circle the migration would then have to fight.
    const repo = makeRepo("git@github.com:acme/widgets.git");
    const circle = deriveCircle(repo);
    expect(circle).toBe("github.com-acme-widgets"); // host/org/repo, slashes → hyphens

    const db = openStore();
    const row = db.prepare("SELECT circle FROM remote_circle_map WHERE remote_url = ?").get("github.com/acme/widgets") as { circle: string } | undefined;
    db.close();
    // Genuinely-new branch does NOT persist — the default is already stable across machines.
    expect(row).toBeUndefined();
  });

  it("no-remote / not-a-git-repo → folder-hash fallback (today's behavior), no map write", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-folder-"));
    const circle = deriveCircle(plain);
    // The engine's folder-hash deriveCircle produces <basename>-<8-hex>. The basename may
    // itself contain hyphens (mkdtemp prefixes them), so anchor only on the 8-hex suffix.
    expect(circle).toMatch(/-[0-9a-f]{8}$/);

    // The no-remote branch no longer writes a synthetic local: row (it was never read back).
    // The table may not even be created; if it is, it must be empty of local: rows.
    const db = openStore();
    const rows = db.prepare("SELECT remote_url, circle FROM remote_circle_map").all() as Array<{ remote_url: string; circle: string }>;
    db.close();
    const localRow = rows.find((r) => r.remote_url.startsWith("local:"));
    expect(localRow).toBeUndefined();
  });

  it("git unavailable / repo without origin → folder-hash fallback, no throw", () => {
    const repo = makeRepo(null); // a git repo with NO origin remote
    const circle = deriveCircle(repo);
    expect(circle).toMatch(/-[0-9a-f]{8}$/);
  });

  it("map-hit with a hermetic fixture repo → returns the mapped circle", () => {
    // Full end-to-end coverage of the map-hit path using a temp repo whose remote
    // canonicalizes to a known key. No absolute paths, no real store, no live git.
    const repo = makeRepo("git@github.com:team-monet/monet-client.git");
    const db = openStore();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_circle_map (remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run(
      "github.com/team-monet/monet-client",
      "example-circle",
    );
    db.close();

    const circle = deriveCircle(repo);
    expect(circle).toBe("example-circle");
  });
});

describe("deriveCircle — which store answers (P1-2's surviving half, Codex round 3 on PR #42)", () => {
  /**
   * WHAT THIS USED TO ASSERT, and why it now asserts less: P1-2 added an `opts.storeDir` that let a
   * caller root the SQLITE CONSULTATION somewhere other than the git-identity root, for source-cli's
   * `--path /other/repo` (circle resolved from the worktree's store, source row written into the
   * invoking project's). Both that option and its only two call sites are gone, so the divergence
   * itself is no longer reachable and asserting on it would be asserting on a parameter this
   * function does not have.
   *
   * THE FIXTURE STILL PROVES SOMETHING REAL, which is why it is kept rather than deleted: two REAL,
   * separate project-local stores carry DIFFERENT circles for the SAME remote key (so the lookup key
   * is identical and "which store" is the only variable), and the directory this function is given
   * is the one whose store answers. A neighbouring project's row must not leak in. That is the
   * property a future caller reintroducing the split would be building on top of.
   */
  it("consults the project-local store of the directory it was given — never a different project's store carrying its own row for the same remote", async () => {
    const REMOTE_URL = "git@github.com:acme/p1-2-fixture.git";
    const otherProjectDir = makeRepo(REMOTE_URL, "p1-2-invoking"); // "store A"'s own identity dir
    const worktreeDir = makeRepo(REMOTE_URL, "p1-2-worktree"); // "store B"'s own identity dir

    // MONET_STORAGE_DIR (this file's own global beforeEach override) would force every directory
    // onto the SAME single tmpHome store, masking the divergence under test — cleared here so each
    // directory's own project-local .monet is what actually gets consulted.
    const savedStorageDir = process.env.MONET_STORAGE_DIR;
    delete process.env.MONET_STORAGE_DIR;
    try {
      const key = canonicalRemoteKey(REMOTE_URL);
      const seedStore = (projectDir: string, circle: string): void => {
        const storeDir = join(projectDir, ".monet");
        mkdirSync(storeDir, { recursive: true });
        const db = new Database(join(storeDir, "monet.db"));
        db.pragma("journal_mode = WAL");
        db.exec(`
          CREATE TABLE remote_circle_map (
            remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
          );
        `);
        db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run(key, circle);
        db.close();
      };
      seedStore(otherProjectDir, "circle-from-A-the-other-store");
      seedStore(worktreeDir, "circle-from-B-the-given-store");

      const result = deriveCircle(worktreeDir);
      expect(result).toBe("circle-from-B-the-given-store");
      // NOT vacuous: A really does hold a different circle for the identical key, and it stays out.
      expect(result).not.toBe("circle-from-A-the-other-store");
      expect(deriveCircle(otherProjectDir)).toBe("circle-from-A-the-other-store");
    } finally {
      if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
      else delete process.env.MONET_STORAGE_DIR;
    }
  });
});

describe("deriveCircle — backward-compat (anti-orphan)", () => {
  it("SSH and HTTPS checkouts of the same repo (same host) derive the same circle", () => {
    const sshRepo = makeRepo("git@github.com:acme/widgets.git", "aw-ssh");
    const httpsRepo = makeRepo("https://github.com/acme/widgets", "aw-https");
    // First call: genuinely-new, no map write (P1: no-persist for genuinely-new).
    const sshCircle = deriveCircle(sshRepo);
    // The HTTPS repo's canonical key is identical (same host), so both return the same default.
    const httpsCircle = deriveCircle(httpsRepo);
    expect(sshCircle).toBe("github.com-acme-widgets");
    expect(httpsCircle).toBe("github.com-acme-widgets");
  });

  it("two different remotes pre-mapped to example-circle both return example-circle (consolidation via remote_circle_map)", () => {
    const repoA = makeRepo("git@github.com:team-monet/monet-core.git", "mc-core");
    const repoB = makeRepo("https://github.com/team-monet/monet-client", "mc-client");
    // Pre-seed the map using the canonical host/org/repo keys.
    const db = openStore();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_circle_map (remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run("github.com/team-monet/monet-core", "example-circle");
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run("github.com/team-monet/monet-client", "example-circle");
    db.close();

    expect(deriveCircle(repoA)).toBe("example-circle");
    expect(deriveCircle(repoB)).toBe("example-circle");
  });

  it("Class B orphan guard: remote + concepts under the raw folder-hash slug + NO alias → returns the slug (NOT the repo name)", () => {
    // THE REGRESSION THIS TEST EXISTS TO CATCH: a repo WITH a remote, whose folder-hash slug
    // already has concepts stored under it (the common "never renamed a circle" case) but has
    // NO circle_aliases row. The old code returned defaultNameFromRemote (the repo name) and
    // orphaned every concept under the slug. The Class-B branch must return the slug instead.
    const repo = makeRepo("git@github.com:acme/widgets.git", "widgets");

    // Discover the folder-hash slug the engine would produce for this path (same trick as the
    // alias-following test: momentarily drop origin, derive, restore).
    const slug = (() => {
      execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      const s = deriveCircle(repo);
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      return s;
    })();
    expect(slug).toMatch(/-[0-9a-f]{8}$/);

    // Plant a concept directly under the raw slug (NO alias row — that's the point). The
    // engine creates the concepts table on first construction.
    const core = new MonetCore(join(tmpStorage, "monet.db"), { defaultCircle: slug });
    core.close();
    const db = openStore();
    db.prepare(
      `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding, support_count) VALUES (?, ?, ?, ?, 'fact', 'active', ?, '', 1)`,
    ).run("c-widgets-1", slug, "widgets fact", "a durable widgets fact", slug);
    db.close();

    // With the remote present, no alias, but concepts under the slug → must return the slug,
    // NOT "github.com-acme-widgets" (the host/org/repo default, which would orphan the planted concept).
    const circle = deriveCircle(repo);
    expect(circle).toBe(slug);
    expect(circle).not.toBe("github.com-acme-widgets");

    // Class B: the mapping IS recorded so the second call is a pure map hit.
    const db2 = openStore();
    const row = db2.prepare("SELECT circle FROM remote_circle_map WHERE remote_url = ?").get("github.com/acme/widgets") as { circle: string } | undefined;
    db2.close();
    expect(row).toBeDefined();
    expect(row!.circle).toBe(slug);
  });

  it("probe hardening: a non-missing-table error from hasConceptsInCircle → degrade to folder slug (NOT the repo name)", () => {
    // REFINEMENT 2 REGRESSION: the Class-B orphan guard calls hasConceptsInCircle to decide
    // whether to keep the folder-hash slug. If that probe swallowed a REAL error (e.g.
    // SQLITE_BUSY beyond busy_timeout, a schema mismatch) as "no concepts", deriveCircle would
    // fall through to the repo-name default and orphan memory actually living under the slug.
    // The hardened probe must RETHROW any non-missing-table error so the OUTER catch degrades
    // to the SAFE folder-hash fallback — never the less-safe repo-name path.
    //
    // We simulate a non-missing-table error by creating a `concepts` table that EXISTS but
    // lacks the `circle` column, so `SELECT 1 FROM concepts WHERE circle = ?` throws
    // SqliteError("no such column: circle") — a real error that isMissingTable must NOT treat
    // as the benign empty case. (The `circle_aliases` table is intentionally NOT created, so
    // resolveAlias hits a genuine missing-table → returns null → Class-A path skipped, landing
    // us on the Class-B probe, which is what we want to exercise.)
    const repo = makeRepo("git@github.com:acme/widgets.git", "probe");

    // The map must be empty so we reach the unmapped-remote resolution (not a hit).
    const db = openStore();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_circle_map (remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    // A `concepts` table that exists but is missing the `circle` column → probe throws a
    // non-missing-table error.
    db.exec(`CREATE TABLE concepts (id TEXT PRIMARY KEY, kind TEXT)`);
    db.close();

    // Silence the expected console.error from the outer catch so the run output stays clean.
    const origError = console.error;
    let logged: string | null = null;
    console.error = (...a: unknown[]) => { logged = a.map(String).join(" "); };
    try {
      const circle = deriveCircle(repo);
      // SAFE degradation: the folder-hash slug, NOT the repo-name default "github.com-acme-widgets".
      expect(circle).toMatch(/-[0-9a-f]{8}$/);
      expect(circle).not.toBe("github.com-acme-widgets");
      // The outer catch must have fired (proving the probe rethrew rather than swallowing).
      expect(logged).toMatch(/deriveCircle: remote-map resolution failed/);
    } finally {
      console.error = origError;
    }

    // No mapping was recorded — the outer catch skips the writeMap call, so a later re-run
    // re-resolves cleanly once the transient condition clears (here: never, by construction).
    const db2 = openStore();
    const row = db2.prepare("SELECT circle FROM remote_circle_map WHERE remote_url = ?").get("github.com/acme/widgets") as { circle: string } | undefined;
    db2.close();
    expect(row).toBeUndefined();
  });

  it("observations-only circle: observation under folder-slug but no concept → orphan guard keeps the slug (not repo name)", () => {
    // COVERAGE FOR #4 (hasMemoryInCircle): the observations table has its own `circle` column,
    // so a circle can hold observations without ANY concept row. The orphan guard must treat
    // such a circle as non-empty — otherwise it would fall through to the repo-name default
    // and strand those observations.
    const repo = makeRepo("git@github.com:acme/obs-only.git", "obs-only");

    // Discover the folder-hash slug (same trick as Class B: remove origin, derive, restore).
    const slug = (() => {
      execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      const s = deriveCircle(repo);
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/obs-only.git"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      return s;
    })();
    expect(slug).toMatch(/-[0-9a-f]{8}$/);

    // Initialize the engine so both `concepts` and `observations` tables are created.
    const core = new MonetCore(join(tmpStorage, "monet.db"), { defaultCircle: slug });
    core.close();

    // Plant an observation under the slug — but NO concept row. This simulates a legacy store
    // where observations were written before synthesis, or after a partial migration.
    const db = openStore();
    db.prepare(
      `INSERT INTO observations (id, content, embedding, kind, circle, author_agent_id) VALUES (?, ?, '', 'statement', ?, 'test-agent')`,
    ).run("obs-only-1", "an orphan-risk observation", slug);
    db.close();

    // With the remote present, no alias, and only an observation (no concept) under the slug,
    // hasMemoryInCircle returns true → keeps the slug, NOT "github.com-acme-obs-only".
    const circle = deriveCircle(repo);
    expect(circle).toBe(slug);
    expect(circle).not.toBe("github.com-acme-obs-only");
  });

  it("folder-hash backward-compat: an existing circle_aliases row routes a folder-hash fallback to its friendly name", () => {
    // Simulate a store that already has memory under `code-6849de25` aliased to `example-circle`,
    // and a repo whose folder-hash matches that slug but which has NO git remote (so it takes
    // the folder fallback path). The alias must still route it to example-circle, not strand it.
    //
    // We can't easily reproduce the exact `code-6849de25` hash without the real /Users/dev/code
    // path, so we use a fresh repo: give it no origin, let deriveCircle produce its folder-hash
    // slug, then manually plant a circle_aliases row from that slug → "my-friendly" and call
    // deriveCircle AGAIN — the alias-following in the unmapped-remote path is for remotes, but
    // the folder-fallback path returns the raw slug; the engine's resolveCircle is what maps it.
    // So the backward-compat guarantee is: the engine's resolveCircle still honors circle_aliases.
    // Verify that directly with a real MonetCore.
    const repo = makeRepo(null, "compat");
    const slug = deriveCircle(repo); // folder-hash, e.g. compat-<hash>
    expect(slug).toMatch(/-[0-9a-f]{8}$/);

    // Plant a circle_aliases row in the engine's table (the engine creates it on first open).
    const core = new MonetCore(join(tmpStorage, "monet.db"), { defaultCircle: slug });
    core.close();
    const db = openStore();
    db.prepare(`INSERT OR REPLACE INTO circle_aliases (from_name, to_name, status) VALUES (?, ?, 'active')`).run(slug, "my-friendly");
    db.close();

    // Re-open: the engine's resolveCircle must follow the alias.
    const core2 = new MonetCore(join(tmpStorage, "monet.db"), { defaultCircle: slug });
    const resolved = core2.resolveCircleName(slug);
    core2.close();
    expect(resolved).toBe("my-friendly");
  });

  it("unmapped remote FOLLOWS an existing folder-hash alias instead of orphaning memory (Class A → writes row)", () => {
    // A repo with a remote whose folder-hash slug is already aliased to a friendly name with
    // stored memory. The new deriveCircle must record remote → friendly-name, NOT remote →
    // repo-name, so existing memory isn't orphaned. Class A persists the mapping.
    const repo = makeRepo("git@github.com:acme/legacy.git", "legacy");
    // First, capture the folder-hash slug the engine would produce for this path.
    const slug = (() => {
      // Temporarily make the repo look remote-less so the folder fallback runs, to discover
      // the slug. We do this by reading what deriveFolderCircle produces via the no-origin
      // branch: remove the origin temporarily.
      execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      const s = deriveCircle(repo);
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/legacy.git"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      return s;
    })();
    expect(slug).toMatch(/-[0-9a-f]{8}$/);

    // Plant a circle_aliases row slug → "legacy-friendly" (simulating existing memory).
    const core = new MonetCore(join(tmpStorage, "monet.db"), { defaultCircle: slug });
    core.close();
    const db = openStore();
    db.prepare(`INSERT OR REPLACE INTO circle_aliases (from_name, to_name, status) VALUES (?, ?, 'active')`).run(slug, "legacy-friendly");
    db.close();

    // Now deriveCircle with the remote present. It should follow the alias → "legacy-friendly",
    // NOT derive "github.com-acme-legacy" (the host/org/repo default) and orphan the aliased memory.
    const circle = deriveCircle(repo);
    expect(circle).toBe("legacy-friendly");

    // Class A: the mapping IS persisted so the second call is a pure map hit.
    const db2 = openStore();
    const row = db2.prepare("SELECT circle FROM remote_circle_map WHERE remote_url = ?").get("github.com/acme/legacy") as { circle: string } | undefined;
    db2.close();
    expect(row).toBeDefined();
    expect(row!.circle).toBe("legacy-friendly");
  });
});

describe("deriveCircle — end-to-end with the engine (invariants)", () => {
  it("the circle deriveCircle returns lands memory in the same circle the engine resolves", async () => {
    // The whole point: the string deriveCircle returns, passed as defaultCircle, must be the
    // circle the engine actually writes to.
    const repo = makeRepo("git@github.com:acme/widgets.git", "e2e");
    const circle = deriveCircle(repo);
    expect(circle).toBe("github.com-acme-widgets");

    const core = new MonetCore(join(tmpStorage, "monet.db"), {
      defaultCircle: circle,
      scopeContext: repo,
    });
    await core.store("a durable acme-widgets fact");
    const stats = core.stats(circle);
    expect(stats.circle).toBe("github.com-acme-widgets");
    expect(stats.observations).toBeGreaterThanOrEqual(1);
    core.close();
  });

  it("scopeContext ≠ defaultCircle (invariant 1): the engine never derives circle from the folder", () => {
    const repo = makeRepo("git@github.com:acme/fixtures.git", "sc");
    const circle = deriveCircle(repo);
    expect(circle).toBe("github.com-acme-fixtures"); // from remote, NOT the folder slug
    // The folder-hash for this temp path would be sc-<hash>; confirm we did NOT return that.
    expect(circle).not.toMatch(/-[0-9a-f]{8}$/);
  });
});

describe("deriveCallerId / deriveProjectId — source-authorization context", () => {
  // Distinct from the outer beforeEach/afterEach (which manages HOME/MONET_STORAGE_DIR/
  // MONET_CIRCLE) — these tests only touch MONET_CALLER_ID/MONET_PROJECT_ID, saved/restored
  // independently so a real value in the ambient environment is never leaked or clobbered.
  let savedCallerId: string | undefined;
  let savedProjectId: string | undefined;

  beforeEach(() => {
    savedCallerId = process.env.MONET_CALLER_ID;
    savedProjectId = process.env.MONET_PROJECT_ID;
    delete process.env.MONET_CALLER_ID;
    delete process.env.MONET_PROJECT_ID;
  });

  afterEach(() => {
    if (savedCallerId !== undefined) process.env.MONET_CALLER_ID = savedCallerId;
    else delete process.env.MONET_CALLER_ID;
    if (savedProjectId !== undefined) process.env.MONET_PROJECT_ID = savedProjectId;
    else delete process.env.MONET_PROJECT_ID;
  });

  describe("deriveCallerId", () => {
    it("defaults to DEFAULT_CALLER_ID ('local-agent') when MONET_CALLER_ID is unset", () => {
      expect(deriveCallerId()).toBe(DEFAULT_CALLER_ID);
      expect(deriveCallerId()).toBe("local-agent");
    });

    it("a non-blank MONET_CALLER_ID override wins", () => {
      process.env.MONET_CALLER_ID = "ci-runner";
      expect(deriveCallerId()).toBe("ci-runner");
    });

    it("a blank/whitespace-only MONET_CALLER_ID falls back to the default, not the blank value", () => {
      process.env.MONET_CALLER_ID = "   ";
      expect(deriveCallerId()).toBe(DEFAULT_CALLER_ID);
    });

    it("trims surrounding whitespace from a non-blank override", () => {
      process.env.MONET_CALLER_ID = "  ci-runner  ";
      expect(deriveCallerId()).toBe("ci-runner");
    });
  });

  describe("deriveProjectId", () => {
    it("git remote present → the exact canonicalRemoteKey slash form (host/owner/repo)", () => {
      const repo = makeRepo("git@github.com:team-monet/monet-core.git", "projectid-remote");
      expect(deriveProjectId(repo)).toBe("github.com/team-monet/monet-core");
      // Must match canonicalRemoteKey directly — this is the contract --allow-project relies on.
      expect(deriveProjectId(repo)).toBe(canonicalRemoteKey("git@github.com:team-monet/monet-core.git"));
    });

    it("HTTPS and SSH remotes of the same repo derive the same projectId (parity with canonicalRemoteKey)", () => {
      const sshRepo = makeRepo("git@github.com:acme/widgets.git", "projectid-ssh");
      const httpsRepo = makeRepo("https://github.com/acme/widgets", "projectid-https");
      expect(deriveProjectId(sshRepo)).toBe("github.com/acme/widgets");
      expect(deriveProjectId(httpsRepo)).toBe("github.com/acme/widgets");
    });

    it("non-git temp dir → the identical folder-hash form the core's deriveCircle produces", () => {
      const plain = mkdtempSync(join(tmpdir(), "projectid-plain-"));
      expect(deriveProjectId(plain)).toBe(coreDeriveCircle(plain));
      expect(deriveProjectId(plain)).toMatch(/-[0-9a-f]{8}$/);
    });

    it("git repo without an origin remote → folder-hash fallback (no throw), matching core deriveCircle", () => {
      const repo = makeRepo(null, "projectid-noremote");
      expect(deriveProjectId(repo)).toBe(coreDeriveCircle(repo));
      expect(deriveProjectId(repo)).toMatch(/-[0-9a-f]{8}$/);
    });

    it("MONET_PROJECT_ID override wins outright, even with a remote present", () => {
      const repo = makeRepo("git@github.com:team-monet/monet-core.git", "projectid-override");
      process.env.MONET_PROJECT_ID = "forced-project-id";
      expect(deriveProjectId(repo)).toBe("forced-project-id");
    });

    it("whitespace is trimmed from a non-blank MONET_PROJECT_ID override", () => {
      process.env.MONET_PROJECT_ID = "  forced-project-id  ";
      expect(deriveProjectId("/irrelevant/unused/path")).toBe("forced-project-id");
    });

    it("a blank/whitespace-only MONET_PROJECT_ID override falls through to remote resolution, not the blank value", () => {
      const repo = makeRepo("git@github.com:team-monet/monet-core.git", "projectid-blank-override");
      process.env.MONET_PROJECT_ID = "   ";
      expect(deriveProjectId(repo)).toBe("github.com/team-monet/monet-core");
    });

    it("is side-effect-free: never opens the remote_circle_map store, unlike deriveCircle", () => {
      // deriveCircle opens/creates the remote_circle_map SQLite store on every call, even on
      // the no-remote path. deriveProjectId's fallback deliberately calls the engine's pure
      // deriveFolderCircle instead specifically to avoid that I/O — prove the table is never
      // created by deriveProjectId alone (this test's beforeEach never calls deriveCircle).
      const repo = makeRepo("git@github.com:some-org/some-repo-nostore.git", "projectid-nostore");
      deriveProjectId(repo);
      const plain = mkdtempSync(join(tmpdir(), "projectid-nostore-plain-"));
      deriveProjectId(plain);
      const db = openStore();
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_circle_map'")
        .get() as { name: string } | undefined;
      db.close();
      expect(hasTable).toBeUndefined();
    });
  });
});

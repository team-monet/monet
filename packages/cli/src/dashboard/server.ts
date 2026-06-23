/**
 * Monet Dashboard — embedded HTTP server for `monet dashboard`.
 *
 * Ported from the standalone ~/code/monet-dashboard/server.mjs.
 * Changes from the original:
 *   1. Store path resolved via getDbPath() (honours MONET_STORAGE_DIR / --dir) instead of hardcoded ~/.monet.
 *   2. Snapshot produced via better-sqlite3's online backup API instead of shelling to /usr/bin/sqlite3.
 *   3. Static assets served from dist/dashboard/ (resolve via import.meta.url) so they ship in the tarball.
 *   4. avgConfidence/graphDensity guard uses `!= null` (nullable-safe) instead of truthy `?:`.
 *   5. Access-Control-Allow-Origin header removed — UI is same-origin; CORS is unnecessary and a privacy risk.
 *   6. --dir flag added to CLI; startDashboard() accepts an optional monetDir override so the banner
 *      reflects the actual resolved store path.
 *
 * READ-ONLY guarantee (preserved from original):
 *   - Live DB is opened with {readonly:true} only to drive the backup API.
 *   - The backup produces a plain (non-WAL) single-file snapshot in tmp.
 *   - All SQL queries run against the snapshot, opened {readonly:true}.
 *   - The embedding column is never selected.
 *   - Snapshot files are removed in a finally/exit handler.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
// better-sqlite3 is externalized by esbuild and provided by the runtime node_modules.
import Database from "better-sqlite3";

import { getDbPath } from "../db/index.js";

// ── Asset directory (resolved at runtime relative to the bundled cli.js) ────
// dist/cli.js lives at <pkg_root>/dist/cli.js.
// dist/dashboard/ lives at <pkg_root>/dist/dashboard/.
// So __dirname points at dist/ and we go directly to dashboard/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the built bundle import.meta.url refers to dist/cli.js, so __dirname = dist/.
// At dev time (tsx) import.meta.url refers to src/dashboard/server.ts, __dirname = src/dashboard/.
// We detect which case we're in by trying dist/dashboard first, then falling back to the
// sibling directory that tsx would use (built during dev by build.mjs targeting dashboard/).
function resolveAssetDir(): string {
  // Production: dist/dashboard (sibling of dist/cli.js means __dirname is dist/)
  const prod = path.resolve(__dirname, "dashboard");
  if (fs.existsSync(path.join(prod, "index.html"))) return prod;
  // Dev / tsx: src/dashboard/../../../dist/dashboard (go up two from src/dashboard)
  const dev = path.resolve(__dirname, "..", "..", "dist", "dashboard");
  if (fs.existsSync(path.join(dev, "index.html"))) return dev;
  // Fallback: return prod path and let serveStatic return a 404 with a useful message.
  return prod;
}

const ASSET_DIR = resolveAssetDir();

// ── Snapshot dir ─────────────────────────────────────────────────────────────

// Use mkdtempSync so each run gets a unique, unpredictable directory name.
// A fixed /tmp/monet-dash-<pid> path could be pre-created as a symlink by
// another process on a shared machine before this process starts, redirecting
// snapshot files to an attacker-controlled location.
const SNAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "monet-dash-"));

// Remove stale dirs from prior crashed runs so tmp doesn't accumulate.
(function cleanStaleDirs() {
  try {
    const tmp = os.tmpdir();
    for (const entry of fs.readdirSync(tmp)) {
      if (/^monet-dash-/.test(entry) && entry !== path.basename(SNAP_DIR)) {
        // Remove if the directory's mtime is older than 1 hour.  This catches
        // dirs left behind by crashed runs; a running instance updates its SNAP_DIR
        // mtime continuously as it writes snapshots, so it will not be removed.
        const entPath = path.join(tmp, entry);
        try {
          const stat = fs.statSync(entPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > 60 * 60 * 1000) {
            fs.rmSync(entPath, { recursive: true, force: true });
          }
        } catch { /* non-fatal */ }
      }
    }
  } catch { /* non-fatal */ }
})();

// ── Snapshot helper ──────────────────────────────────────────────────────────

/**
 * makeSnapshot(): uses better-sqlite3's online backup API to produce an atomic,
 * WAL-safe, single-file snapshot of the live DB.
 *
 * Why backup() instead of VACUUM INTO via a writable connection:
 *   - Opening the live WAL DB with a writable better-sqlite3 connection silently
 *     triggers a WAL checkpoint, which can drop writes that are only in the -wal
 *     file from the concurrently-running MCP server — producing a stale read
 *     (we observed 157 vs 158 concepts in the standalone tool before fixing this).
 *   - backup() accepts a {readonly:true} source, so the live DB is never written
 *     and the WAL is never checkpointed by us.
 *   - The resulting snapshot is a plain (non-WAL) file; queries against it run
 *     without any -wal/-shm dependency.
 *
 * Returns the path to the snapshot. Throws on failure — no silent fallback.
 */
async function makeSnapshot(): Promise<string> {
  // Recreate SNAP_DIR if a concurrent instance's GC removed it.
  // mkdirSync with recursive:true is a no-op when the directory already exists.
  fs.mkdirSync(SNAP_DIR, { recursive: true, mode: 0o700 });

  const liveDbPath = getDbPath();
  const snapName = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const snapPath = path.join(SNAP_DIR, snapName);

  // .backup() from a {readonly:true} source is already a consistent point-in-time
  // snapshot — no second live-DB open or count comparison needed.  A concept written
  // between the backup call and a hypothetical re-read of the live DB would cause a
  // spurious mismatch and an intermittent 500 during active MCP writes.
  const liveDb = new Database(liveDbPath, { readonly: true, fileMustExist: true });
  try {
    await liveDb.backup(snapPath);
  } finally {
    liveDb.close();
  }

  return snapPath;
}

/**
 * querySnap(snapPath, sql): run one prepared SQL statement against the snapshot.
 * Returns all rows as plain objects.
 * The snapshot is a plain DB (no WAL) so concurrent reads are fine; we still
 * open readonly for defence-in-depth.
 */
function querySnap(snapPath: string, sql: string): Record<string, unknown>[] {
  const db = new Database(snapPath, { readonly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

// ── SQL Definitions ──────────────────────────────────────────────────────────

const SQL = {
  concepts: `
    SELECT id, slug, title, kind, status, confidence, circle,
           support_count, version, dirty, usefulness_score,
           created_at, updated_at, last_confirmed_at, source_refs, aliases, body
    FROM concepts
    ORDER BY updated_at DESC
  `,

  observations: `
    SELECT id, content, kind, circle, concept_id, session_id,
           author_agent_id, created_at, source_refs
    FROM observations
    ORDER BY created_at DESC
  `,

  edges: `
    SELECT id, src_id, dst_id, type, weight, origin, count, scope,
           created_at, last_reinforced_at
    FROM memory_edge
    WHERE dismissed_at IS NULL
    ORDER BY weight DESC
  `,

  contradictions: `
    SELECT id, concept_id, observation_id, kind, status, detail,
           detected_at, resolved_at
    FROM contradictions
    ORDER BY detected_at DESC
  `,

  sessions: `
    SELECT id, agent_id, scope_context, started_at, ended_at, status, summary
    FROM sessions
    ORDER BY started_at DESC
  `,

  revisionsCount: `
    SELECT concept_id, COUNT(*) as n, MAX(version) as maxVersion
    FROM concept_revisions
    GROUP BY concept_id
  `,

  aliases: `SELECT from_name, to_name, status FROM circle_aliases`,

  counts: `
    SELECT
      (SELECT COUNT(*) FROM concepts) as concepts,
      (SELECT COUNT(*) FROM observations) as observations,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NULL) as edgesLive,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NOT NULL) as edgesDismissed,
      (SELECT COUNT(*) FROM entities) as entities,
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM contradictions WHERE status='open') as contradictionsOpen,
      (SELECT COUNT(*) FROM contradictions WHERE status='resolved') as contradictionsResolved,
      (SELECT COUNT(*) FROM concepts WHERE status='disputed') as disputed,
      (SELECT COUNT(*) FROM concepts WHERE dirty=1) as dirty,
      (SELECT COUNT(*) FROM memory_edge WHERE type='possible_duplicate_of' AND dismissed_at IS NULL) as possibleDuplicatePairs
  `,

  health: `
    SELECT
      AVG(CASE WHEN confidence IS NOT NULL THEN confidence END) as avgConfidence,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NULL) * 1.0 /
        NULLIF((SELECT COUNT(*) FROM concepts), 0) as graphDensity
    FROM concepts
  `,

  circles: `
    SELECT
      c.circle as name,
      COUNT(DISTINCT c.id) as conceptCount,
      COUNT(DISTINCT o.id) as observationCount
    FROM concepts c
    LEFT JOIN observations o ON o.circle = c.circle
    GROUP BY c.circle
  `,

  circleEdges: `
    SELECT scope, COUNT(*) as edgeCount
    FROM memory_edge
    WHERE dismissed_at IS NULL
    GROUP BY scope
  `,

  // Returns raw (scope, key) pairs so the JS aggregation can map each raw scope
  // to its canonical circle name before counting, avoiding double-counting of
  // entity keys that appear under both aliased scopes (e.g. code-6849de25 and
  // example-circle both holding the same key would be counted once, not twice).
  circleEntities: `
    SELECT DISTINCT scope, key
    FROM entities
  `,

  entities: `
    SELECT key, kind, surface, scope, df
    FROM entities
    ORDER BY df DESC
  `,

  entityLinks: `
    SELECT concept_id, entity_key, scope
    FROM concept_entities
  `,

  // first_block rows joined to their concept for title + status.
  // The table may not exist in stores not yet migrated by the new engine;
  // the caller guards with an existence check before running this query.
  firstBlock: `
    SELECT
      fb.concept_id   AS conceptId,
      fb.circle,
      fb.summary,
      fb.summary_dirty AS summaryDirty,
      fb.position,
      c.title         AS title,
      c.status        AS conceptStatus
    FROM first_block fb
    LEFT JOIN concepts c ON c.id = fb.concept_id
    ORDER BY fb.position ASC
  `,
} as const;

// ── API handlers ─────────────────────────────────────────────────────────────

/** Empty-but-valid graph payload for a fresh/empty store directory. */
function emptyGraphPayload(): unknown {
  return {
    generatedAt: Date.now(),
    counts: {
      concepts: 0, observations: 0, edgesLive: 0, edgesDismissed: 0,
      entities: 0, sessions: 0, contradictionsOpen: 0, contradictionsResolved: 0,
      disputed: 0, dirty: 0, possibleDuplicatePairs: 0,
    },
    health: { avgConfidence: null, graphDensity: null },
    circles: [], aliases: [], concepts: [], observations: [], edges: [],
    contradictions: [], sessions: [], revisionsCount: [],
  };
}

async function handleGraph(): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return emptyGraphPayload();
  const snap = await makeSnapshot();
  try {
    const concepts           = querySnap(snap, SQL.concepts);
    const observations       = querySnap(snap, SQL.observations);
    const edges              = querySnap(snap, SQL.edges);
    const contradictions     = querySnap(snap, SQL.contradictions);
    const sessions           = querySnap(snap, SQL.sessions);
    const revisionsCount     = querySnap(snap, SQL.revisionsCount);
    const aliases            = querySnap(snap, SQL.aliases);
    const [counts]           = querySnap(snap, SQL.counts) as [Record<string, number>];
    const [health]           = querySnap(snap, SQL.health) as [Record<string, number | null>];
    const circlesRaw         = querySnap(snap, SQL.circles) as Array<Record<string, unknown>>;
    const circleEdgesRaw     = querySnap(snap, SQL.circleEdges) as Array<{ scope: string; edgeCount: number }>;
    const circleEntitiesRaw  = querySnap(snap, SQL.circleEntities) as Array<{ scope: string; key: string }>;

    const aliasMap: Record<string, string> = {};
    for (const a of aliases as Array<{ from_name: string; to_name: string }>) {
      aliasMap[a.from_name] = a.to_name;
    }

    const edgesByScope: Record<string, number> = {};
    for (const r of circleEdgesRaw) edgesByScope[r.scope] = r.edgeCount;

    // Build per-canonical-circle Sets of entity keys so that a key present under
    // both a raw scope and its alias target is counted exactly once.
    const entityKeysByCanon: Record<string, Set<string>> = {};
    for (const r of circleEntitiesRaw) {
      const canon = aliasMap[r.scope] || r.scope;
      if (!entityKeysByCanon[canon]) entityKeysByCanon[canon] = new Set();
      entityKeysByCanon[canon].add(r.key);
    }

    // Aggregate raw circles by canonical name so aliased circles (e.g.
    // code-6849de25 → example-circle) appear as ONE row with summed counts,
    // rather than duplicate buttons in the circle selector each showing
    // only the raw-side count.
    const circlesByCanon: Record<string, {
      canonicalName: string;
      conceptCount: number;
      observationCount: number;
      edgeCount: number;
      entityCount: number;
    }> = {};
    for (const c of circlesRaw) {
      const rawName = c["name"] as string;
      const canon = aliasMap[rawName] || rawName;
      if (circlesByCanon[canon]) {
        circlesByCanon[canon].conceptCount     += (c["conceptCount"] as number) || 0;
        circlesByCanon[canon].observationCount += (c["observationCount"] as number) || 0;
        circlesByCanon[canon].edgeCount        += edgesByScope[rawName] || 0;
        // entityCount is set once from the canonical Set; no per-raw accumulation needed.
      } else {
        circlesByCanon[canon] = {
          canonicalName:     canon,
          conceptCount:      (c["conceptCount"] as number) || 0,
          observationCount:  (c["observationCount"] as number) || 0,
          edgeCount:         edgesByScope[rawName] || 0,
          entityCount:       entityKeysByCanon[canon]?.size ?? 0,
        };
      }
    }
    const circles = Object.values(circlesByCanon);

    const avgConf = health["avgConfidence"];
    const graphDens = health["graphDensity"];

    return {
      generatedAt: Date.now(),
      counts: {
        concepts: counts["concepts"],
        observations: counts["observations"],
        edgesLive: counts["edgesLive"],
        edgesDismissed: counts["edgesDismissed"],
        entities: counts["entities"],
        sessions: counts["sessions"],
        contradictionsOpen: counts["contradictionsOpen"],
        contradictionsResolved: counts["contradictionsResolved"],
        disputed: counts["disputed"],
        dirty: counts["dirty"],
        possibleDuplicatePairs: counts["possibleDuplicatePairs"],
      },
      health: {
        avgConfidence: avgConf != null ? +Number(avgConf).toFixed(4) : null,
        graphDensity: graphDens != null ? +Number(graphDens).toFixed(4) : null,
      },
      circles,
      aliases,
      concepts,
      observations,
      edges,
      contradictions,
      sessions,
      revisionsCount,
    };
  } finally {
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
  }
}

async function handleEntities(): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return { entities: [], links: [] };
  const snap = await makeSnapshot();
  try {
    const entities = querySnap(snap, SQL.entities);
    const links    = querySnap(snap, SQL.entityLinks);
    return { entities, links };
  } finally {
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
  }
}

async function handleFirstBlock(circle: string | null): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return { rows: [] };
  const snap = await makeSnapshot();
  try {
    // The first_block table only exists in stores migrated by the new engine.
    // Check for its existence before querying so the endpoint returns an empty
    // payload (rather than a 500) when pointed at an older store.
    const db = new Database(snap, { readonly: true });
    let tableExists = false;
    try {
      const row = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='first_block'`
      ).get();
      tableExists = !!row;
    } finally {
      db.close();
    }
    if (!tableExists) return { rows: [] };

    let rows = querySnap(snap, SQL.firstBlock);
    // Filter by circle when requested.  Resolve aliases so that a caller passing
    // a canonical name (e.g. "example-circle") matches rows stored under the raw alias
    // (e.g. "code-6849de25"), mirroring the alias aggregation in handleGraph().
    if (circle) {
      const aliases = querySnap(snap, SQL.aliases) as Array<{ from_name: string; to_name: string }>;
      const aliasMap: Record<string, string> = {};
      for (const a of aliases) aliasMap[a.from_name] = a.to_name;
      // Accept both the raw name and the canonical (aliased) name so callers can
      // pass either form.  A row's circle field holds the raw DB value; resolve it
      // to canonical before comparing against the requested circle.
      rows = rows.filter(r => {
        const rawCircle = r["circle"] as string;
        const canonCircle = aliasMap[rawCircle] || rawCircle;
        return rawCircle === circle || canonCircle === circle;
      });
    }
    return { rows };
  } finally {
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
  }
}

// ── Static file serving ──────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Hardcoded allowlist — prevents any path-traversal: only these three filenames
// are ever served from ASSET_DIR regardless of the request URL.
const STATIC_ALLOWLIST = new Set(["index.html", "app.js", "style.css"]);

function serveStatic(res: http.ServerResponse, filename: string): void {
  if (!STATIC_ALLOWLIST.has(filename)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: filename }));
    return;
  }
  const filePath = path.join(ASSET_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: filename }));
    return;
  }
  const ext = path.extname(filename);
  const ct = MIME[ext] || "text/plain";
  res.writeHead(200, {
    "Content-Type": ct,
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  fs.createReadStream(filePath).pipe(res);
}

// ── Server bootstrap ─────────────────────────────────────────────────────────

/** Accepted Host header values for DNS-rebinding protection. */
function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return true; // HTTP/1.0 requests have no Host header — allow
  // Strip any port suffix for the hostname comparison
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') return true;
  // Also accept host:port forms that include the configured port
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`) return true;
  return false;
}

export function startDashboard(port: number): void {
  const server = http.createServer(async (req, res) => {
    // DNS-rebinding protection: reject requests with non-loopback Host headers.
    // This runs first, before URL parsing, so a crafted Host can't bypass the guard.
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: invalid Host header" }));
      return;
    }

    // Parse the request target. A malformed target (e.g. '////') throws in some
    // Node versions; catch it here so a bad request returns 400 instead of an
    // unhandled throw that reaches the uncaughtException handler and exits the process.
    let pathname: string;
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      pathname = url.pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request: malformed request target" }));
      return;
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        return serveStatic(res, "index.html");
      }
      if (pathname === "/app.js") return serveStatic(res, "app.js");
      if (pathname === "/style.css") return serveStatic(res, "style.css");

      if (pathname === "/api/graph") {
        const data = await handleGraph();
        const json = JSON.stringify(data);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(json);
        return;
      }

      if (pathname === "/api/entities") {
        const data = await handleEntities();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === "/api/firstblock") {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const circle = url.searchParams.get("circle");
        const data = await handleFirstBlock(circle);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", pathname }));
    } catch (err) {
      console.error("Handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const serverUrl = `http://127.0.0.1:${port}`;
    console.log(`\n  Monet Dashboard  ${serverUrl}\n`);
    console.log(`  Store:  ${getDbPath()}`);
    console.log(`  Press Ctrl-C to stop.\n`);
    // Best-effort open in browser (macOS/Linux/Windows).
    try {
      if (process.platform === "darwin") {
        execFile("open", [serverUrl], () => {});
      } else if (process.platform === "win32") {
        // `start` is a cmd.exe builtin, not an executable — execFile("start", ...)
        // silently fails on Windows.  Route through cmd /c instead.
        // The empty string '' is a required title argument for `start`.
        execFile("cmd", ["/c", "start", "", serverUrl], () => {});
      } else {
        execFile("xdg-open", [serverUrl], () => {});
      }
    } catch { /* ignore */ }
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function cleanup(): void {
    try { fs.rmSync(SNAP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    cleanup();
    process.exit(1);
  });
}

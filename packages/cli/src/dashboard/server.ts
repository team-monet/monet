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

// Marker union that classifies a concept row as raw ingested "source" content
// (e.g. an Obsidian vault chunk) rather than a synthesized concept.
// Established rule (engine cold audit): kind alone is NOT reliable as the sole
// signal, so source_identity / active_observation_id must also be checked —
// classify by the full union, never kind alone.
//
// Per John's no-hiding ruling, source rows are NOT excluded from any query
// below — concepts/observations/edges/graph all include them as first-class
// rows, same as any other concept (this constant previously drove a WHERE NOT
// / NOT EXISTS filter on concepts/observations/edges; that filtering has been
// removed). SOURCE_MARKER's only remaining consumer is SQL.counts.sourceConcepts,
// which powers the honest header split ("N concepts · M from sources") so the
// UI is explicit about how much of the total is raw source content — a
// disclosure, not an exclusion.
//
// This is a deliberate interim, not the end state: an upcoming engine reshape
// (file=concept) will shrink the store to ~640 concepts and collapse the
// source/native distinction at the row level, making this marker (and the
// split it powers) moot. Until then, GRAPH_NODE_LIMIT in app.js is the only
// scale guard on the graph — a visible, neutral rendering cap, not a content
// filter.
const SOURCE_MARKER = `(c.kind = 'source' OR c.source_identity IS NOT NULL OR c.active_observation_id IS NOT NULL)`;

// Retired-exclusion default, aligned with the engine's own read convention:
// engine.ts filters `status != 'retired'` in 90+ read paths (e.g. listCircles
// at engine.ts:4536), and the dashboard previously didn't mirror that at all —
// every retired concept (82% of a mature store) rendered as a first-class
// node/row right alongside live ones. Unlike SOURCE_MARKER/kind='source' (which
// stays visible per John's no-hiding ruling), retired concepts are excluded by
// default here; `includeRetired=1` on the affected /api routes restores the
// unfiltered query below. status='disputed' is a different value of the same
// column and is never touched by this filter — disputed concepts stay visible
// in both modes, matching John's ruling that disputed must always show.
const RETIRED_FILTER = `status != 'retired'`;

// Exported so dashboard-source-marker.test.ts can run the real query strings
// against a seeded test DB, rather than testing a parallel reimplementation of
// the marker-union logic that could silently drift from what actually runs.
export const SQL = {
  // Full concepts table, minus retired rows by default (see RETIRED_FILTER) —
  // including raw ingested "source" content (e.g. Obsidian vault chunks), which
  // stays first-class per John's no-hiding ruling (unaffected by this filter).
  // This is also the array that becomes graph nodes AND the Concepts tab's
  // rows. Scale is bounded client-side (GRAPH_NODE_LIMIT on the Graph tab,
  // simple pagination on the Concepts tab if needed) rather than by excluding
  // rows here.
  concepts: `
    SELECT id, slug, title, kind, status, confidence, circle,
           support_count, version, dirty, usefulness_score,
           created_at, updated_at, last_confirmed_at, source_refs, aliases, body
    FROM concepts c
    WHERE c.${RETIRED_FILTER}
    ORDER BY updated_at DESC
  `,

  // includeRetired=1 variant — every concept row, retired included. Identical
  // to `concepts` above minus the WHERE clause.
  conceptsIncludeRetired: `
    SELECT id, slug, title, kind, status, confidence, circle,
           support_count, version, dirty, usefulness_score,
           created_at, updated_at, last_confirmed_at, source_refs, aliases, body
    FROM concepts c
    ORDER BY updated_at DESC
  `,

  // Full observations table — every row, including observations belonging to
  // source concepts (the chunk text itself). No longer filtered by kind='source'
  // or by parent-concept marker per John's no-hiding ruling; see SOURCE_MARKER
  // above.
  observations: `
    SELECT id, content, kind, circle, concept_id, session_id,
           author_agent_id, created_at, source_refs
    FROM observations o
    ORDER BY created_at DESC
  `,

  // Full edge table, still excluding dismissed edges (unrelated to source
  // visibility — dismissal is a separate, deliberate user action). Previously
  // also excluded edges touching a source concept on either end; per John's
  // no-hiding ruling that filter is removed. In the audited store the engine
  // never links source/chunk concepts into the graph anyway (0 of 39,196 live
  // edges touch a source concept), so this is a no-op on today's data and a
  // correctness fix for whenever that invariant stops holding.
  //
  // Retired-exclusion default: joined to concepts on BOTH endpoints so an edge
  // with either endpoint retired is dropped entirely — a graph node that
  // doesn't render (retired, excluded from SQL.concepts) must never leave a
  // dangling edge pointing at it. Mirrors the engine's own edges() query
  // (engine.ts ~4187-4197: `JOIN concepts src ... JOIN concepts dst ...
  // src.status != 'retired' AND dst.status != 'retired'`) — src_id/dst_id are
  // always concept ids in this schema (memory_edge.src_type/dst_type are both
  // 'concept' for every row in the audited store), matching that convention.
  // The INNER JOIN on concepts for both endpoints also drops any edge whose
  // endpoint is not a live concept row (orphaned or non-'concept'-typed endpoint),
  // consistent with the client's getFilteredEdges behavior and harmless (0 such
  // rows in the audited store).
  edges: `
    SELECT e.id, e.src_id, e.dst_id, e.type, e.weight, e.origin, e.count, e.scope,
           e.created_at, e.last_reinforced_at
    FROM memory_edge e
    JOIN concepts src ON src.id = e.src_id
    JOIN concepts dst ON dst.id = e.dst_id
    WHERE e.dismissed_at IS NULL
      AND src.${RETIRED_FILTER}
      AND dst.${RETIRED_FILTER}
    ORDER BY e.weight DESC
  `,

  // includeRetired=1 variant — the original ungenerated query, no concepts join.
  edgesIncludeRetired: `
    SELECT id, src_id, dst_id, type, weight, origin, count, scope,
           created_at, last_reinforced_at
    FROM memory_edge e
    WHERE e.dismissed_at IS NULL
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

  // Aggregate counts across the store, retired concepts excluded by default
  // (see RETIRED_FILTER) so the header stat bar's "All (N)" / "N concepts · M
  // from sources" numbers match what's actually rendered elsewhere in the
  // default view. `disputed` deliberately does NOT get an added retired
  // exclusion: status is a single column, 'disputed' and 'retired' are
  // mutually exclusive values of it, so the disputed count is already
  // unaffected — disputed concepts stay visible in both modes. `edgesLive` and
  // `possibleDuplicatePairs` are joined to concepts on both endpoints (mirrors
  // SQL.edges) so these header counts match the length of the actual
  // (retired-filtered) edges/dup-pair arrays the UI renders and filters
  // against. `observations`, `edgesDismissed`, `entities`, `sessions`,
  // `contradictionsOpen/Resolved` are left unfiltered — none of them touch the
  // concepts table, and (contradictions specifically) are safe because the
  // engine's retireConcept (monet-core/src/engine.ts:unwindConceptGraph) sets
  // a retired concept's open contradictions to status='dismissed' when retiring
  // the concept, so openContras (Health view's contradictions.filter(status===
  // 'open') in app.js renderHealth) can never reference a retired/absent concept.
  // That engine invariant ensures the Health view's concept-map dereference is safe.
  // NOTE: references c.source_identity / c.active_observation_id via
  // SOURCE_MARKER, which don't exist on stores predating the source-ingestion
  // schema. handleGraph() checks conceptsHasSourceColumns() before running
  // this and falls back to countsLegacy below when they're absent.
  counts: `
    SELECT
      (SELECT COUNT(*) FROM concepts WHERE ${RETIRED_FILTER}) as concepts,
      (SELECT COUNT(*) FROM concepts c WHERE ${SOURCE_MARKER} AND c.${RETIRED_FILTER}) as sourceConcepts,
      (SELECT COUNT(*) FROM observations) as observations,
      (SELECT COUNT(*) FROM memory_edge e
         JOIN concepts esrc ON esrc.id = e.src_id AND esrc.${RETIRED_FILTER}
         JOIN concepts edst ON edst.id = e.dst_id AND edst.${RETIRED_FILTER}
        WHERE e.dismissed_at IS NULL) as edgesLive,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NOT NULL) as edgesDismissed,
      (SELECT COUNT(*) FROM entities) as entities,
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM contradictions WHERE status='open') as contradictionsOpen,
      (SELECT COUNT(*) FROM contradictions WHERE status='resolved') as contradictionsResolved,
      (SELECT COUNT(*) FROM concepts WHERE status='disputed') as disputed,
      (SELECT COUNT(*) FROM concepts WHERE dirty=1 AND ${RETIRED_FILTER}) as dirty,
      (SELECT COUNT(*) FROM memory_edge e
         JOIN concepts esrc ON esrc.id = e.src_id AND esrc.${RETIRED_FILTER}
         JOIN concepts edst ON edst.id = e.dst_id AND edst.${RETIRED_FILTER}
        WHERE e.type='possible_duplicate_of' AND e.dismissed_at IS NULL) as possibleDuplicatePairs
  `,

  // includeRetired=1 variant — identical to `counts` minus every retired
  // exclusion (the original, pre-this-change query).
  countsIncludeRetired: `
    SELECT
      (SELECT COUNT(*) FROM concepts) as concepts,
      (SELECT COUNT(*) FROM concepts c WHERE ${SOURCE_MARKER}) as sourceConcepts,
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

  // Legacy-schema fallback for stores created before the source-ingestion
  // columns (source_identity / active_observation_id) existed on concepts —
  // the full SOURCE_MARKER union in `counts` above throws "no such column" on
  // them, which was breaking /api/graph entirely for those stores (findings
  // review). sourceConcepts here uses kind='source' alone: the only marker
  // such a store CAN carry (kind always exists; the other two columns don't
  // on this schema, and NOT their absence being silently miscounted as 0 —
  // kind-only is what these rows' actual data supports, not an approximation).
  // Otherwise identical to `counts` (including the same retired-exclusion
  // default). Selected by conceptsHasSourceColumns().
  countsLegacy: `
    SELECT
      (SELECT COUNT(*) FROM concepts WHERE ${RETIRED_FILTER}) as concepts,
      (SELECT COUNT(*) FROM concepts WHERE kind = 'source' AND ${RETIRED_FILTER}) as sourceConcepts,
      (SELECT COUNT(*) FROM observations) as observations,
      (SELECT COUNT(*) FROM memory_edge e
         JOIN concepts esrc ON esrc.id = e.src_id AND esrc.${RETIRED_FILTER}
         JOIN concepts edst ON edst.id = e.dst_id AND edst.${RETIRED_FILTER}
        WHERE e.dismissed_at IS NULL) as edgesLive,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NOT NULL) as edgesDismissed,
      (SELECT COUNT(*) FROM entities) as entities,
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM contradictions WHERE status='open') as contradictionsOpen,
      (SELECT COUNT(*) FROM contradictions WHERE status='resolved') as contradictionsResolved,
      (SELECT COUNT(*) FROM concepts WHERE status='disputed') as disputed,
      (SELECT COUNT(*) FROM concepts WHERE dirty=1 AND ${RETIRED_FILTER}) as dirty,
      (SELECT COUNT(*) FROM memory_edge e
         JOIN concepts esrc ON esrc.id = e.src_id AND esrc.${RETIRED_FILTER}
         JOIN concepts edst ON edst.id = e.dst_id AND edst.${RETIRED_FILTER}
        WHERE e.type='possible_duplicate_of' AND e.dismissed_at IS NULL) as possibleDuplicatePairs
  `,

  // includeRetired=1 variant of countsLegacy.
  countsLegacyIncludeRetired: `
    SELECT
      (SELECT COUNT(*) FROM concepts) as concepts,
      (SELECT COUNT(*) FROM concepts WHERE kind = 'source') as sourceConcepts,
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

  // avgConfidence/graphDensity restricted to non-retired concepts by default so
  // the stat-bar numbers describe what's actually on screen, not a metric
  // dominated by an 82%-retired store. graphDensity's edge subquery is joined
  // to concepts on both endpoints, mirroring SQL.edges/counts.edgesLive.
  health: `
    SELECT
      AVG(CASE WHEN confidence IS NOT NULL THEN confidence END) as avgConfidence,
      (SELECT COUNT(*) FROM memory_edge e
         JOIN concepts esrc ON esrc.id = e.src_id AND esrc.${RETIRED_FILTER}
         JOIN concepts edst ON edst.id = e.dst_id AND edst.${RETIRED_FILTER}
        WHERE e.dismissed_at IS NULL) * 1.0 /
        NULLIF((SELECT COUNT(*) FROM concepts WHERE ${RETIRED_FILTER}), 0) as graphDensity
    FROM concepts
    WHERE ${RETIRED_FILTER}
  `,

  // includeRetired=1 variant — the original ungenerated query.
  healthIncludeRetired: `
    SELECT
      AVG(CASE WHEN confidence IS NOT NULL THEN confidence END) as avgConfidence,
      (SELECT COUNT(*) FROM memory_edge WHERE dismissed_at IS NULL) * 1.0 /
        NULLIF((SELECT COUNT(*) FROM concepts), 0) as graphDensity
    FROM concepts
  `,

  // Split into two independent GROUP BYs (mirroring the circleEdges/circleEntities
  // pattern just below) rather than one query that LEFT JOINs concepts to
  // observations ON circle. circle is low-cardinality (~16 distinct values), so
  // that join produces a conceptsInCircle x observationsInCircle cross-product
  // per circle before COUNT(DISTINCT) dedupes it back down — measured at ~2.1s
  // of a ~2.6s total /api/graph response on the live store (3,278 concepts /
  // 4,535 observations), the single largest server-side cost by far. Same
  // output, computed the cheap way.
  //
  // Retired-exclusion default: a circle whose visible count drops to 0 (every
  // concept in it retired) simply produces no GROUP BY row here — handleGraph's
  // canonical-circle fold only ever iterates rows this query returns, so that
  // circle naturally disappears from the circle list/selector with no extra
  // logic needed.
  circleConcepts: `
    SELECT circle as name, COUNT(*) as conceptCount
    FROM concepts
    WHERE ${RETIRED_FILTER}
    GROUP BY circle
  `,

  // includeRetired=1 variant — the original ungenerated query.
  circleConceptsIncludeRetired: `
    SELECT circle as name, COUNT(*) as conceptCount
    FROM concepts
    GROUP BY circle
  `,

  // Observations carry no status of their own and aren't joined to concepts
  // here (see the cross-product comment above) — a retired concept's prior
  // observations are historical record, not something retiring the concept
  // retroactively hides. Left unfiltered in both modes.
  circleObservations: `
    SELECT circle as scope, COUNT(*) as observationCount
    FROM observations
    GROUP BY circle
  `,

  // Joined to concepts on both endpoints (mirrors SQL.edges) so per-circle edge
  // counts (shown in the circle picker / cluster tooltips) match the actual
  // retired-filtered edges array rather than overcounting edges that don't render.
  circleEdges: `
    SELECT e.scope as scope, COUNT(*) as edgeCount
    FROM memory_edge e
    JOIN concepts src ON src.id = e.src_id AND src.${RETIRED_FILTER}
    JOIN concepts dst ON dst.id = e.dst_id AND dst.${RETIRED_FILTER}
    WHERE e.dismissed_at IS NULL
    GROUP BY e.scope
  `,

  // includeRetired=1 variant — the original ungenerated query.
  circleEdgesIncludeRetired: `
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

  // Joined to concepts and retired-filtered by default so the Entities tab's
  // "# Concepts" column (derived client-side by counting these link rows per
  // entity) doesn't count links to concepts that are no longer visible
  // anywhere else in the default view — the same "entity joins" trace the
  // concept-node/edge/dup-pair queries above got.
  entityLinks: `
    SELECT ce.concept_id as concept_id, ce.entity_key as entity_key, ce.scope as scope
    FROM concept_entities ce
    JOIN concepts c ON c.id = ce.concept_id
    WHERE c.${RETIRED_FILTER}
  `,

  // includeRetired=1 variant — the original ungenerated query, no concepts join.
  entityLinksIncludeRetired: `
    SELECT concept_id, entity_key, scope
    FROM concept_entities
  `,

  // Knowledge-source registry. The tables may not exist in stores not yet
  // migrated by an engine with the source pipeline; the caller guards with an
  // existence check before running these queries.
  sources: `
    SELECT id, type, name, remote_url, local_path, branch,
           circle, auto_detect, refresh_mode, refresh_interval_seconds,
           config_version, applied_config_version, active_run_id,
           lease_fence, lifecycle, created_at, updated_at, tombstoned_at
    FROM knowledge_sources
    ORDER BY created_at ASC, id ASC
  `,

  // The run each source currently has published (registry pin → run row).
  sourceActiveRuns: `
    SELECT r.id, r.source_id, r.state, r.result, r.file_count, r.chunk_count,
           r.published_at, r.finished_at, r.created_at
    FROM source_sync_runs r
    JOIN knowledge_sources s ON s.active_run_id = r.id
  `,

  // Durable success marker per source: latest published_at among successful runs.
  sourceLastSuccess: `
    SELECT source_id, MAX(published_at) AS last_success_at
    FROM source_sync_runs
    WHERE result = 'success' AND published_at IS NOT NULL
    GROUP BY source_id
  `,

  // At most one live (non-terminal) run per source — enforced by
  // uq_source_sync_runs_live in the engine schema.
  sourceLiveRuns: `
    SELECT id, source_id, state, created_at, updated_at
    FROM source_sync_runs
    WHERE state IN ('scanning','staging','activating','cleaning')
  `,

  // Immutable attempt receipts joined to their run rows — the same shape as the
  // engine's scheduleBasisSnapshot query (source-ledger). The window matches the
  // engine's per-source event retention (128) so streak math sees everything the
  // engine sees; the display list is sliced to 20 afterwards in JS.
  sourceAttemptEvents: `
    SELECT e.source_id, e.sequence, e.kind, e.run_id, e.attempted_at,
           e.failure_reason, e.invocation_result, e.config_version, e.lease_fence,
           r.state AS run_state, r.result AS run_result, r.reason AS run_reason,
           r.file_count AS run_file_count, r.chunk_count AS run_chunk_count,
           r.published_at AS run_published_at, r.finished_at AS run_finished_at
    FROM (
      SELECT ev.*, ROW_NUMBER() OVER (
        PARTITION BY source_id ORDER BY sequence DESC
      ) AS rn
      FROM source_attempt_events ev
    ) e
    LEFT JOIN source_sync_runs r ON r.id = e.run_id AND r.source_id = e.source_id
    WHERE e.rn <= 128
    ORDER BY e.source_id, e.sequence DESC
  `,

  // first_block rows joined to their concept for title + status. Retired joined
  // concepts are hidden by default, while orphan rows remain visible so a
  // missing concept record does not silently erase the stored First Block slot.
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
    WHERE fb.deleted_at IS NULL
      AND (c.status IS NULL OR c.status != 'retired')
    ORDER BY fb.position ASC
  `,

  // includeRetired=1 variant — preserves the previous unfiltered semantics.
  firstBlockIncludeRetired: `
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
    WHERE fb.deleted_at IS NULL
    ORDER BY fb.position ASC
  `,

  // Legacy-schema variants for stores whose first_block table predates the
  // deleted_at column. The standalone dashboard opens stores read-only and does
  // not run engine migrations, so these must not reference the missing column.
  firstBlockLegacy: `
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
    WHERE c.status IS NULL OR c.status != 'retired'
    ORDER BY fb.position ASC
  `,

  firstBlockLegacyIncludeRetired: `
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

/**
 * Column-presence guard for SOURCE_MARKER. Stores created before the
 * source-ingestion schema lack source_identity / active_observation_id on
 * concepts; running SQL.counts (which references both via SOURCE_MARKER)
 * against such a store throws "no such column", which was breaking
 * /api/graph entirely for legacy stores. handleGraph() calls this to pick
 * SQL.counts (full marker) vs SQL.countsLegacy (kind-only) -- mirrors the
 * sqlite_master table-existence guards in handleFirstBlock/handleSources,
 * which exist for the identical reason (older stores predate newer schema).
 * Exported so it can be unit-tested directly against both schema shapes
 * rather than only indirectly through handleGraph().
 */
export function conceptsHasSourceColumns(db: InstanceType<typeof Database>): boolean {
  const cols = db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  return names.has("source_identity") && names.has("active_observation_id");
}

/** Select a current- or legacy-schema First Block query without migrating the read-only store. */
export function selectFirstBlockSql(
  db: InstanceType<typeof Database>,
  includeRetired: boolean,
): string {
  const cols = db.prepare(`PRAGMA table_info(first_block)`).all() as Array<{ name: string }>;
  const hasDeletedAt = cols.some((c) => c.name === "deleted_at");
  if (hasDeletedAt) return includeRetired ? SQL.firstBlockIncludeRetired : SQL.firstBlock;
  return includeRetired ? SQL.firstBlockLegacyIncludeRetired : SQL.firstBlockLegacy;
}

// ── API handlers ─────────────────────────────────────────────────────────────

/** Empty-but-valid graph payload for a fresh/empty store directory. */
function emptyGraphPayload(): unknown {
  return {
    generatedAt: Date.now(),
    counts: {
      concepts: 0, sourceConcepts: 0, observations: 0, edgesLive: 0, edgesDismissed: 0,
      entities: 0, sessions: 0, contradictionsOpen: 0, contradictionsResolved: 0,
      disputed: 0, dirty: 0, possibleDuplicatePairs: 0,
    },
    health: { avgConfidence: null, graphDensity: null },
    circles: [], aliases: [], concepts: [], observations: [], edges: [],
    contradictions: [], sessions: [], revisionsCount: [],
  };
}

async function handleGraph(includeRetired: boolean): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return emptyGraphPayload();
  const snap = await makeSnapshot();
  try {
    const concepts           = querySnap(snap, includeRetired ? SQL.conceptsIncludeRetired : SQL.concepts);
    const observations       = querySnap(snap, SQL.observations);
    const edges              = querySnap(snap, includeRetired ? SQL.edgesIncludeRetired : SQL.edges);
    const contradictions     = querySnap(snap, SQL.contradictions);
    const sessions           = querySnap(snap, SQL.sessions);
    const revisionsCount     = querySnap(snap, SQL.revisionsCount);
    const aliases            = querySnap(snap, SQL.aliases);

    // Detect legacy schema (pre-source-ingestion) before running SQL.counts --
    // see conceptsHasSourceColumns() and SQL.countsLegacy above for why.
    const colsDb = new Database(snap, { readonly: true });
    let hasSourceColumns: boolean;
    try {
      hasSourceColumns = conceptsHasSourceColumns(colsDb);
    } finally {
      colsDb.close();
    }
    const countsSql = hasSourceColumns
      ? (includeRetired ? SQL.countsIncludeRetired : SQL.counts)
      : (includeRetired ? SQL.countsLegacyIncludeRetired : SQL.countsLegacy);
    const [counts]           = querySnap(snap, countsSql) as [Record<string, number>];
    const [health]           = querySnap(snap, includeRetired ? SQL.healthIncludeRetired : SQL.health) as [Record<string, number | null>];
    const circleConceptsRaw     = querySnap(snap, includeRetired ? SQL.circleConceptsIncludeRetired : SQL.circleConcepts) as Array<{ name: string; conceptCount: number }>;
    const circleObservationsRaw = querySnap(snap, SQL.circleObservations) as Array<{ scope: string; observationCount: number }>;
    const circleEdgesRaw     = querySnap(snap, includeRetired ? SQL.circleEdgesIncludeRetired : SQL.circleEdges) as Array<{ scope: string; edgeCount: number }>;
    const circleEntitiesRaw  = querySnap(snap, SQL.circleEntities) as Array<{ scope: string; key: string }>;

    const aliasMap: Record<string, string> = {};
    for (const a of aliases as Array<{ from_name: string; to_name: string }>) {
      aliasMap[a.from_name] = a.to_name;
    }

    const edgesByScope: Record<string, number> = {};
    for (const r of circleEdgesRaw) edgesByScope[r.scope] = r.edgeCount;

    const observationsByScope: Record<string, number> = {};
    for (const r of circleObservationsRaw) observationsByScope[r.scope] = r.observationCount;

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
    for (const c of circleConceptsRaw) {
      const rawName = c.name;
      const canon = aliasMap[rawName] || rawName;
      if (circlesByCanon[canon]) {
        circlesByCanon[canon].conceptCount     += c.conceptCount || 0;
        circlesByCanon[canon].observationCount += observationsByScope[rawName] || 0;
        circlesByCanon[canon].edgeCount        += edgesByScope[rawName] || 0;
        // entityCount is set once from the canonical Set; no per-raw accumulation needed.
      } else {
        circlesByCanon[canon] = {
          canonicalName:     canon,
          conceptCount:      c.conceptCount || 0,
          observationCount:  observationsByScope[rawName] || 0,
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
        sourceConcepts: counts["sourceConcepts"],
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

async function handleEntities(includeRetired: boolean): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return { entities: [], links: [] };
  const snap = await makeSnapshot();
  try {
    const entities = querySnap(snap, SQL.entities);
    const links    = querySnap(snap, includeRetired ? SQL.entityLinksIncludeRetired : SQL.entityLinks);
    return { entities, links };
  } finally {
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
  }
}

async function handleFirstBlock(circle: string | null, includeRetired: boolean): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return { rows: [] };
  const snap = await makeSnapshot();
  try {
    // The first_block table only exists in stores migrated by the new engine.
    // Check for its existence before querying so the endpoint returns an empty
    // payload (rather than a 500) when pointed at an older store.
    const db = new Database(snap, { readonly: true });
    let tableExists = false;
    let firstBlockSql: string | null = null;
    try {
      const row = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='first_block'`
      ).get();
      tableExists = !!row;
      if (tableExists) firstBlockSql = selectFirstBlockSql(db, includeRetired);
    } finally {
      db.close();
    }
    if (!tableExists) return { rows: [] };

    let rows = querySnap(snap, firstBlockSql!);
    // Filter by circle when requested.  Resolve aliases so that a caller passing
    // a canonical name (e.g. "example-circle") matches rows stored under the raw alias
    // (e.g. "code-6849de25"), mirroring the alias aggregation in handleGraph().
    if (circle) {
      const aliases = querySnap(snap, SQL.aliases) as Array<{ from_name: string; to_name: string }>;
      const aliasMap: Record<string, string> = {};
      for (const a of aliases) aliasMap[a.from_name] = a.to_name;
      const canonical = (name: string): string => {
        const seen = new Set<string>();
        let current = name;
        while (aliasMap[current] && !seen.has(current)) {
          seen.add(current);
          current = aliasMap[current];
        }
        return current;
      };
      // Normalize both sides so a requested raw alias and its canonical target
      // select the same rows, including rows stored under another equivalent raw
      // alias. Comparing only the row side made raw-alias requests asymmetric.
      const requestedCircle = canonical(circle);
      rows = rows.filter(r => {
        const rawCircle = r["circle"] as string;
        return canonical(rawCircle) === requestedCircle;
      });
    }
    return { rows };
  } finally {
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
  }
}

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * Registry status derivation — mirrors deriveStatus() in monet-core's
 * source-registry (the status is not a stored column). One deliberate
 * divergence: a corrupt applied>config row displays as pending-replacement
 * instead of throwing — a read-only view must not 500 on a corrupt store.
 */
export function deriveSourceStatus(row: {
  lifecycle: string;
  config_version: number;
  applied_config_version: number | null;
}): string {
  if (row.lifecycle === "tombstoned") return "tombstoned";
  if (row.applied_config_version == null) return "pending-initial-sync";
  if (row.applied_config_version === row.config_version) return "active";
  return "pending-replacement";
}

/** Failure backoff — mirrors cappedBackoff() in monet-core's source-scheduler. */
export function sourceBackoffMs(intervalMs: number, streak: number): number {
  let value = 30_000;
  for (let i = 1; i < streak && value < intervalMs; i += 1) value = Math.min(intervalMs, value * 2);
  return Math.min(intervalMs, value);
}

export interface SourceAttemptOutcome {
  attemptedAt: number;
  result: string | null;
}

/** The event-row shape terminalOutcomes consumes (attempt event + joined run). */
export interface SourceAttemptEventRow {
  kind: string;
  runId: string | null;
  attemptedAt: number;
  invocationResult: string | null;
  configVersion: number | null;
  leaseFence: number | null;
  runResult: string | null;
  runPublishedAt: number | null;
  runFinishedAt: number | null;
}

/**
 * Terminal-outcome projection — mirrors the engine's scheduleBasisSnapshot loop
 * (source-ledger) over fence-scoped events, newest first:
 *   - events outside the source's CURRENT config_version/lease_fence are
 *     ignored (a config update bumps both and resets the failure streak);
 *   - verification counts as success (it breaks a failure streak);
 *   - pre-pin-failure counts as failed;
 *   - invocation carries its own result and always marks its run seen;
 *   - a run event counts only if not already covered by its invocation receipt,
 *     anchored at max(attempted_at, published_at, finished_at).
 */
export function terminalOutcomes(
  events: SourceAttemptEventRow[], // newest first
  configVersion: number,
  leaseFence: number,
): SourceAttemptOutcome[] {
  const seenRuns = new Set<string>();
  const terminals: SourceAttemptOutcome[] = [];
  for (const row of events) {
    if (row.configVersion !== configVersion || row.leaseFence !== leaseFence) continue;
    let result: string | null = null;
    let attemptedAt = row.attemptedAt;
    if (row.kind === "verification") result = "success";
    else if (row.kind === "pre-pin-failure") result = "failed";
    else if (row.kind === "invocation") {
      result = row.invocationResult;
      if (row.runId) seenRuns.add(row.runId);
    } else if (row.runId && !seenRuns.has(row.runId) && row.runResult !== null) {
      result = row.runResult;
      attemptedAt = Math.max(attemptedAt, row.runPublishedAt ?? -1, row.runFinishedAt ?? -1);
      seenRuns.add(row.runId);
    }
    if (result) terminals.push({ attemptedAt, result });
  }
  return terminals;
}

/**
 * Approximate the engine scheduler's next-attempt plan from durable state only.
 * The engine adds a deterministic jitter (≤30s or 10% of the interval) and a
 * recovery branch driven by ledger internals; this read-only view anchors on the
 * latest terminal attempt and skips the jitter, so nextAttemptAt is approximate.
 */
export function computeSourceSchedule(
  src: { lifecycle: string; refresh_mode: string; refresh_interval_seconds: number | null },
  outcomes: SourceAttemptOutcome[], // newest first, terminal outcomes only
  hasLiveRun: boolean,
  now: number,
): { state: string; nextAttemptAt: number | null; consecutiveFailures: number } {
  if (hasLiveRun) return { state: "syncing", nextAttemptAt: null, consecutiveFailures: 0 };
  if (src.lifecycle !== "active" || src.refresh_mode !== "interval" || !src.refresh_interval_seconds) {
    return { state: "manual", nextAttemptAt: null, consecutiveFailures: 0 };
  }
  const intervalMs = src.refresh_interval_seconds * 1000;
  if (outcomes.length === 0) {
    // Never attempted: the engine schedules the initial sync within a short
    // startup spread, so "due" is the honest display state.
    return { state: "due", nextAttemptAt: now, consecutiveFailures: 0 };
  }
  const latest = outcomes[0];
  let failures = 0;
  for (const o of outcomes) {
    if (o.result !== "success") failures += 1;
    else break;
  }
  const failed = latest.result !== "success";
  const delay = failed ? sourceBackoffMs(intervalMs, Math.max(1, failures)) : intervalMs;
  const nextAttemptAt = latest.attemptedAt + delay;
  const state = nextAttemptAt <= now ? "due" : failed ? "backoff" : "scheduled";
  return { state, nextAttemptAt, consecutiveFailures: failures };
}

async function handleSources(): Promise<unknown> {
  if (!fs.existsSync(getDbPath())) return { sources: [], generatedAt: Date.now() };
  const snap = await makeSnapshot();
  try {
    // Stores written by engines without the source pipeline lack these tables;
    // return an empty payload rather than a 500 (mirrors the first_block guard).
    // The ledger tables can also be missing INDEPENDENTLY of the registry
    // (registry-only stores from older engines): still list registered sources
    // and treat run/attempt data as empty rather than hiding the registry.
    const db = new Database(snap, { readonly: true });
    const present = new Set<string>();
    try {
      const rows = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name IN ('knowledge_sources','source_sync_runs','source_attempt_events')`
      ).all() as Array<{ name: string }>;
      for (const r of rows) present.add(r.name);
    } finally {
      db.close();
    }
    if (!present.has("knowledge_sources")) return { sources: [], generatedAt: Date.now() };
    const hasRuns   = present.has("source_sync_runs");
    const hasEvents = present.has("source_attempt_events");

    const sources       = querySnap(snap, SQL.sources);
    const activeRuns    = hasRuns ? querySnap(snap, SQL.sourceActiveRuns) : [];
    const lastSuccess   = hasRuns ? querySnap(snap, SQL.sourceLastSuccess) : [];
    const liveRuns      = hasRuns ? querySnap(snap, SQL.sourceLiveRuns) : [];
    const attemptEvents = (hasEvents && hasRuns) ? querySnap(snap, SQL.sourceAttemptEvents) : [];

    const activeBySource: Record<string, Record<string, unknown>> = {};
    for (const r of activeRuns) activeBySource[r["source_id"] as string] = r;
    const successBySource: Record<string, number> = {};
    for (const r of lastSuccess) successBySource[r["source_id"] as string] = r["last_success_at"] as number;
    const liveBySource: Record<string, Record<string, unknown>> = {};
    for (const r of liveRuns) liveBySource[r["source_id"] as string] = r;
    const eventsBySource: Record<string, Record<string, unknown>[]> = {};
    for (const e of attemptEvents) {
      const sid = e["source_id"] as string;
      (eventsBySource[sid] ||= []).push(e);
    }

    const now = Date.now();
    const out = sources.map((s) => {
      const sid = s["id"] as string;
      const active = activeBySource[sid] || null;
      const live = liveBySource[sid] || null;
      const events = eventsBySource[sid] || [];

      const eventRows: SourceAttemptEventRow[] = events.map((e) => ({
        kind: e["kind"] as string,
        runId: (e["run_id"] as string | null) ?? null,
        attemptedAt: e["attempted_at"] as number,
        invocationResult: (e["invocation_result"] as string | null) ?? null,
        configVersion: (e["config_version"] as number | null) ?? null,
        leaseFence: (e["lease_fence"] as number | null) ?? null,
        runResult: (e["run_result"] as string | null) ?? null,
        runPublishedAt: (e["run_published_at"] as number | null) ?? null,
        runFinishedAt: (e["run_finished_at"] as number | null) ?? null,
      }));

      const outcomes = terminalOutcomes(
        eventRows,
        s["config_version"] as number,
        s["lease_fence"] as number,
      );

      // Display rows for the 20 newest events; run-backed rows resolve result,
      // reason, and counts through the joined run columns.
      const attempts = events.slice(0, 20).map((e) => {
        const kind = e["kind"] as string;
        let result: string | null = null;
        let reason: string | null = (e["failure_reason"] as string | null) ?? null;
        if (kind === "run") {
          result = (e["run_result"] as string | null) ?? null;
          reason = reason ?? ((e["run_reason"] as string | null) ?? null);
        } else if (kind === "invocation") {
          result = (e["invocation_result"] as string | null) ?? null;
        } else if (kind === "pre-pin-failure") {
          result = "failed";
        }
        return {
          sequence: e["sequence"] as number,
          kind,
          attemptedAt: e["attempted_at"] as number,
          result,
          reason,
          runState: (e["run_state"] as string | null) ?? null,
          fileCount: (e["run_file_count"] as number | null) ?? null,
          chunkCount: (e["run_chunk_count"] as number | null) ?? null,
        };
      });

      const schedule = computeSourceSchedule(
        {
          lifecycle: s["lifecycle"] as string,
          refresh_mode: s["refresh_mode"] as string,
          refresh_interval_seconds: s["refresh_interval_seconds"] as number | null,
        },
        outcomes,
        live != null,
        now,
      );

      return {
        id: sid,
        type: s["type"],
        name: s["name"],
        circle: s["circle"],
        status: deriveSourceStatus({
          lifecycle: s["lifecycle"] as string,
          config_version: s["config_version"] as number,
          applied_config_version: s["applied_config_version"] as number | null,
        }),
        lifecycle: s["lifecycle"],
        remoteUrl: s["remote_url"],
        localPath: s["local_path"],
        branch: s["branch"],
        autoDetect: s["auto_detect"] === 1,
        refreshMode: s["refresh_mode"],
        refreshIntervalSeconds: s["refresh_interval_seconds"],
        createdAt: s["created_at"],
        updatedAt: s["updated_at"],
        tombstonedAt: s["tombstoned_at"],
        lastSuccessAt: successBySource[sid] ?? null,
        publishedAt: (active?.["published_at"] as number | null) ?? null,
        publishedFileCount: (active?.["file_count"] as number | null) ?? null,
        publishedChunkCount: (active?.["chunk_count"] as number | null) ?? null,
        liveRunState: (live?.["state"] as string | null) ?? null,
        schedule,
        attempts,
      };
    });

    return { sources: out, generatedAt: now };
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
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const includeRetired = url.searchParams.get("includeRetired") === "1";
        const data = await handleGraph(includeRetired);
        const json = JSON.stringify(data);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(json);
        return;
      }

      if (pathname === "/api/entities") {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const includeRetired = url.searchParams.get("includeRetired") === "1";
        const data = await handleEntities(includeRetired);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === "/api/sources") {
        const data = await handleSources();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === "/api/firstblock") {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const circle = url.searchParams.get("circle");
        const includeRetired = url.searchParams.get("includeRetired") === "1";
        const data = await handleFirstBlock(circle, includeRetired);
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

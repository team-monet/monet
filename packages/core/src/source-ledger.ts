import { randomUUID } from "node:crypto";
import type { StoragePort } from "./storage";
import { rowToSource, type SourceRow } from "./source-registry";
import {
  SOURCE_SCANNER_VERSION,
  computeSourceIngestConfigHash,
  computeSourceManifestHash,
  effectiveSourceScanConfig,
} from "./source-scanner";
import {
  SOURCE_CHUNKER_VERSION,
  canonicalizeSourceChunkMetadata,
  computeSourceContentHash,
  computeSourceIngestFingerprint,
  computeSourceOperationId,
  computeSourceRefOccurrences,
  sourceHeadingAnchor,
  sourceHeadingIdentityKey,
} from "./source-chunker";
import type { SourceChunkMetadata } from "./source-chunker";
import { sanitizeSourceError } from "./source-errors";
import type {
  BeginSourceRunInput,
  BeginSourceRunResult,
  PublishSourceRunInput,
  RecordSourceBindingReceiptInput,
  SourceChunkRecord,
  SourceCleanupItem,
  SourceFileRecord,
  SourceManifestChunkInput,
  SourceManifestFileInput,
  SourcePublishedManifest,
  SourceRemoval,
  SourceRemovalItem,
  SourceSyncRun,
  SourceSyncRunResult,
  StageSourceManifestInput,
} from "./source-types";

/** Active sources retain only the newest immutable attempt receipts. */
export const SOURCE_ATTEMPT_EVENT_RETENTION = 128;

interface SourceLedgerOptions {
  idGen?: () => string;
  now?: () => number;
}

interface RunRow {
  id: string; source_id: string; snapshot_id: string; ingest_config_hash: string;
  scan_config_version: string; effective_config_json: string; config_version: number; lease_fence: number; complete: number;
  state: SourceSyncRun["state"]; result: SourceSyncRunResult | null; reason: string | null;
  activation_token: string | null; manifest_hash: string | null; file_count: number; chunk_count: number;
  created_at: number; updated_at: number; published_at: number | null; finished_at: number | null;
}

interface RawSourceOperation {
  conceptId: string;
  observationId: string;
  predecessorObservationId: string | null;
  action: string;
}

interface DurableSourceReceipt extends RawSourceOperation {
  activeObservationId: string | null;
}

interface OperationOwnership {
  authorized: boolean;
  hasActiveOwner: boolean;
}

export interface SourcePublicationView {
  run: SourceSyncRun;
  filesIndexed: number;
  chunksIndexed: number;
}

export interface SourceAttemptView {
  latest: SourceSyncRun | null;
  lastResult: SourceSyncRun | null;
  lastSuccess: SourceSyncRun | null;
  latestVerificationAt: number | null;
  latestVerificationRunCount: number | null;
  runCount: number;
  dirtyFiles: number;
  prePinFailure: { attemptedAt: number; reason: string } | null;
  latestAttempt: {
    sequence: number; kind: "run" | "verification" | "pre-pin-failure" | "invocation"; runId: string | null; attemptedAt: number;
    runResult: SourceSyncRunResult | null; runReason: string | null; invocationResult: SourceSyncRunResult | null;
    failureReason: string | null; configVersion: number | null; leaseFence: number | null;
  } | null;
}

export interface SourceScheduleBasis {
  attemptSequence: number;
  latestTerminal: { sequence: number; attemptedAt: number; result: SourceSyncRunResult } | null;
  consecutiveFailures: number;
  resumable: boolean;
  removalIncomplete: boolean;
}

export interface SourceStatusScheduleView {
  attempt: SourceAttemptView;
  scheduleBasis: SourceScheduleBasis;
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a nonempty string`);
  return value;
};

const requireSchedulerOwner = (value: unknown): string => {
  const owner = requireString(value, "scheduler owner");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(owner)) throw new Error("scheduler owner must be an opaque token");
  return owner;
};

const requireInteger = (value: unknown, field: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${field} must be an integer >= ${minimum}`);
  return value as number;
};

const SOURCE_PATH_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Validate one canonical POSIX source-relative path without normalizing caller bytes. */
const requireSourceRelativePath = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a canonical POSIX source-relative path`);
  }
  const path = value;
  if (SOURCE_PATH_CONTROL_RE.test(path) || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${field} must be a canonical POSIX source-relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must be a canonical POSIX source-relative path`);
  }
  return path;
};

const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => compareUtf8(a, b)).map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
};

const parseStringArray = (value: unknown, field: string): string[] => {
  if (typeof value !== "string") throw new Error(`${field} must be a JSON string array`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${field} must be a JSON string array`); }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be a JSON string array`);
  }
  return parsed as string[];
};

const sourceIdentityAuthority = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "source:" || !url.host || url.username || url.password || url.pathname !== "") return null;
    return `source://${url.host}`;
  } catch {
    return null;
  }
};

function rowToRun(row: RunRow): SourceSyncRun {
  return {
    id: row.id, sourceId: row.source_id, snapshotId: row.snapshot_id,
    ingestConfigHash: row.ingest_config_hash, scanConfigVersion: row.scan_config_version,
    effectiveConfig: JSON.parse(row.effective_config_json),
    configVersion: row.config_version, leaseFence: row.lease_fence, complete: row.complete === 1,
    state: row.state, result: row.result, reason: row.reason, activationToken: row.activation_token,
    manifestHash: row.manifest_hash, fileCount: row.file_count, chunkCount: row.chunk_count,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at, finishedAt: row.finished_at,
  };
}

/** Durable scanner/materializer hand-off. This class records intent and receipts; it never calls the engine. */
export class SourceLedger {
  private readonly idGen: () => string;
  private readonly now: () => number;
  /** Test-only concurrency seam; production leaves this undefined. */
  private attemptReadFault?: () => void;
  /** Test-only seam immediately after BEGIN IMMEDIATE and before the source fence read. */
  private beginRunFault?: () => void;

  constructor(private readonly db: StoragePort, options: SourceLedgerOptions = {}) {
    this.idGen = options.idGen ?? randomUUID;
    this.now = options.now ?? (() => Date.now());
  }

  ensureSchema(): void {
    this.db.immediateTransaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_sync_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        ingest_config_hash TEXT NOT NULL,
        scan_config_version TEXT NOT NULL,
        effective_config_json TEXT NOT NULL,
        config_version INTEGER NOT NULL CHECK (config_version > 0),
        lease_fence INTEGER NOT NULL CHECK (lease_fence > 0),
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        state TEXT NOT NULL CHECK (state IN ('scanning','staging','activating','published','cleaning','cleaned','aborted')),
        result TEXT CHECK (result IS NULL OR result IN ('success','failed','partial')),
        reason TEXT,
        activation_token TEXT,
        manifest_hash TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        published_at INTEGER,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS source_pre_pin_attempts (
        source_id TEXT PRIMARY KEY,
        attempted_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        lease_fence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_attempt_events (
        source_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        kind TEXT NOT NULL CHECK (kind IN ('run','verification','pre-pin-failure','invocation')),
        ref_id TEXT NOT NULL,
        run_id TEXT,
        attempted_at INTEGER NOT NULL,
        failure_reason TEXT,
        invocation_result TEXT CHECK (invocation_result IS NULL OR invocation_result IN ('success','failed','partial')),
        config_version INTEGER,
        lease_fence INTEGER,
        PRIMARY KEY (source_id, sequence),
        UNIQUE (source_id, kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_attempt_events_latest ON source_attempt_events(source_id,sequence DESC);
      CREATE TABLE IF NOT EXISTS source_scheduler_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner TEXT NOT NULL,
        renewed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_sync_runs_live
        ON source_sync_runs(source_id) WHERE state IN ('scanning','staging','activating','cleaning');
      CREATE INDEX IF NOT EXISTS idx_source_sync_runs_source_created ON source_sync_runs(source_id, created_at, id);

      CREATE TABLE IF NOT EXISTS source_verification_checks (
        source_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        ingest_config_hash TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        lease_fence INTEGER NOT NULL,
        observed_run_count INTEGER NOT NULL,
        checked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_snapshots (
        source_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        ingest_config_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('staged','active','superseded','aborted')),
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        superseded_at INTEGER,
        PRIMARY KEY (run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_snapshots_lookup ON source_snapshots(source_id, snapshot_id, config_version);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_snapshots_active
        ON source_snapshots(source_id) WHERE state = 'active';

      CREATE TABLE IF NOT EXISTS source_staged_files (
        run_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type = 'file'),
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        PRIMARY KEY (run_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS source_files (
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type = 'file'),
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        PRIMARY KEY (run_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_source_files_source_snapshot ON source_files(source_id, snapshot_id, config_version);

      CREATE TABLE IF NOT EXISTS source_staged_chunks (
        run_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
        operation_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        heading_path_json TEXT NOT NULL,
        occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
        segment_index INTEGER NOT NULL CHECK (segment_index >= 1),
        content_hash TEXT NOT NULL,
        ingest_fingerprint TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        content TEXT NOT NULL,
        concept_id TEXT,
        observation_id TEXT,
        predecessor_observation_id TEXT,
        write_state TEXT NOT NULL DEFAULT 'intent' CHECK (write_state IN ('intent','engine-written','committed','skipped')),
        PRIMARY KEY (run_id, binding_id),
        UNIQUE (run_id, relative_path, heading_path_json, occurrence, segment_index),
        UNIQUE (run_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS source_chunks (
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        binding_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
        operation_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        heading_path_json TEXT NOT NULL,
        occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
        segment_index INTEGER NOT NULL CHECK (segment_index >= 1),
        content_hash TEXT NOT NULL,
        ingest_fingerprint TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        content TEXT NOT NULL,
        concept_id TEXT,
        observation_id TEXT,
        predecessor_observation_id TEXT,
        write_state TEXT NOT NULL CHECK (write_state IN ('committed','skipped')),
        lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','superseded','deleted')),
        PRIMARY KEY (run_id, binding_id),
        UNIQUE (run_id, relative_path, heading_path_json, occurrence, segment_index)
      );
      CREATE INDEX IF NOT EXISTS idx_source_chunks_source_snapshot ON source_chunks(source_id, snapshot_id, config_version);

      CREATE TABLE IF NOT EXISTS source_cleanup_items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        target_run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('retire-absent','reconcile-orphan','quarantine-non-authorizing')),
        binding_id TEXT NOT NULL,
        operation_id TEXT,
        concept_id TEXT,
        observation_id TEXT,
        predecessor_observation_id TEXT,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        UNIQUE (run_id, binding_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_cleanup_run ON source_cleanup_items(run_id, acknowledged_at, id);

      CREATE TABLE IF NOT EXISTS source_removals (
        source_id TEXT PRIMARY KEY,
        run_id TEXT,
        snapshot_id TEXT,
        ingest_config_hash TEXT,
        state TEXT NOT NULL CHECK (state IN ('retiring','files-revoked','complete')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS source_removal_items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        acknowledged_at INTEGER,
        UNIQUE (source_id,binding_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_removal_items_pending
        ON source_removal_items(source_id,acknowledged_at,id);
    `);
    let attemptEventColumns = this.db.prepare(`PRAGMA table_info(source_attempt_events)`).all() as Array<{ name: string }>;
    const attemptEventSchema = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='source_attempt_events'`,
    ).get() as { sql: string };
    const attemptEventSql = attemptEventSchema.sql;
    if (!attemptEventSql.includes("'invocation'")
        || !["failure_reason", "invocation_result", "config_version", "lease_fence"]
          .every((name) => attemptEventColumns.some((column) => column.name === name))) {
      const names = new Set(attemptEventColumns.map((column) => column.name));
      this.db.exec(`DROP INDEX IF EXISTS idx_source_attempt_events_latest;
        ALTER TABLE source_attempt_events RENAME TO source_attempt_events_legacy;
        CREATE TABLE source_attempt_events (
          source_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK (sequence > 0),
          kind TEXT NOT NULL CHECK (kind IN ('run','verification','pre-pin-failure','invocation')),
          ref_id TEXT NOT NULL,run_id TEXT,attempted_at INTEGER NOT NULL,failure_reason TEXT,
          invocation_result TEXT CHECK (invocation_result IS NULL OR invocation_result IN ('success','failed','partial')),
          config_version INTEGER,lease_fence INTEGER,
          PRIMARY KEY (source_id,sequence),UNIQUE (source_id,kind,ref_id)
        );`);
      const optional = (name: string): string => names.has(name) ? name : `NULL AS ${name}`;
      this.db.exec(`INSERT INTO source_attempt_events
        (source_id,sequence,kind,ref_id,run_id,attempted_at,failure_reason,invocation_result,config_version,lease_fence)
        SELECT source_id,sequence,kind,ref_id,run_id,attempted_at,${optional("failure_reason")},
          ${optional("invocation_result")},${optional("config_version")},${optional("lease_fence")}
        FROM source_attempt_events_legacy;
        DROP TABLE source_attempt_events_legacy;
        CREATE INDEX idx_source_attempt_events_latest ON source_attempt_events(source_id,sequence DESC);`);
      attemptEventColumns = this.db.prepare(`PRAGMA table_info(source_attempt_events)`).all() as Array<{ name: string }>;
    }
    // An interrupted upgrade may have sequenced failure events from the pre-payload
    // schema. Only the exact durable failure receipt may hydrate an event; older
    // same-source failures stay null rather than inheriting a newer reason.
    this.db.prepare(`UPDATE source_attempt_events AS event SET failure_reason=(
        SELECT attempt.reason FROM source_pre_pin_attempts attempt
        WHERE attempt.source_id=event.source_id AND attempt.attempted_at=event.attempted_at
      ) WHERE event.kind='pre-pin-failure' AND event.failure_reason IS NULL
        AND event.sequence=(SELECT MAX(candidate.sequence) FROM source_attempt_events candidate
          WHERE candidate.source_id=event.source_id AND candidate.kind='pre-pin-failure'
            AND candidate.attempted_at=event.attempted_at)
        AND EXISTS (SELECT 1 FROM source_pre_pin_attempts attempt
          WHERE attempt.source_id=event.source_id AND attempt.attempted_at=event.attempted_at)`).run();
    // Reconcile every surviving verification layout under this enclosing IMMEDIATE transaction.
    // A prior non-atomic migrator could leave legacy alone, an auto-created current beside legacy,
    // or both populated. Read and validate all copies before replacing either one.
    {
      type VerificationMigrationRow = {
        source_id: string; run_id: string; snapshot_id: string; ingest_config_hash: string;
        config_version: number; lease_fence: number; observed_run_count: number; checked_at: number;
      };
      const tableExists = (name: string): boolean => !!this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(name);
      const required = ["source_id", "run_id", "snapshot_id", "ingest_config_hash", "config_version", "lease_fence", "observed_run_count", "checked_at"];
      const layouts: Array<{ table: string; target: boolean }> = [];
      for (const table of ["source_verification_checks", "source_verification_checks_legacy", "source_verification_checks_rebuild"]) {
        if (!tableExists(table)) continue;
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>;
        const names = columns.map((column) => column.name);
        const target = names.length === required.length && required.every((name) => names.includes(name))
          && columns.find((column) => column.name === "source_id")?.pk === 1;
        const legacy = names.length === required.length + 1 && names.includes("id")
          && required.every((name) => names.includes(name))
          && columns.find((column) => column.name === "id")?.pk === 1;
        if (!target && !legacy) throw new Error(`source verification migration found incompatible schema in ${table}`);
        if (columns.some((column) => column.type.toUpperCase() !== (required.slice(0, 4).includes(column.name) || column.name === "id" ? "TEXT" : "INTEGER"))) {
          throw new Error(`source verification migration found incompatible column types in ${table}`);
        }
        layouts.push({ table, target });
      }
      const candidates: VerificationMigrationRow[] = [];
      for (const { table } of layouts) {
        for (const raw of this.db.prepare(`SELECT ${required.join(",")} FROM ${table}`).all() as Array<Record<string, unknown>>) {
          if (required.slice(0, 4).some((field) => typeof raw[field] !== "string" || (raw[field] as string).length === 0)
              || !Number.isSafeInteger(raw.config_version) || (raw.config_version as number) < 1
              || !Number.isSafeInteger(raw.lease_fence) || (raw.lease_fence as number) < 1
              || !Number.isSafeInteger(raw.observed_run_count) || (raw.observed_run_count as number) < 0
              || !Number.isSafeInteger(raw.checked_at) || (raw.checked_at as number) < 0) {
            throw new Error(`source verification migration found corrupt row in ${table}`);
          }
          candidates.push(raw as unknown as VerificationMigrationRow);
        }
      }
      const bySource = new Map<string, VerificationMigrationRow>();
      const payload = (row: VerificationMigrationRow): string => canonicalJson(row);
      for (const row of candidates) {
        const valid = this.db.prepare(`SELECT 1 FROM knowledge_sources source
          JOIN source_sync_runs run ON run.id=source.active_run_id AND run.source_id=source.id
          JOIN source_snapshots snapshot ON snapshot.run_id=run.id AND snapshot.source_id=source.id
          WHERE source.id=? AND source.lifecycle='active' AND source.active_run_id=? AND source.active_snapshot_id=?
            AND source.active_ingest_config_hash=? AND source.applied_config_version=?
            AND ? <= source.lease_fence
            AND ? <= (SELECT COUNT(*) FROM source_sync_runs counted WHERE counted.source_id=source.id)
            AND run.result='success' AND run.state IN ('published','cleaning','cleaned') AND snapshot.state='active'
            AND NOT EXISTS (SELECT 1 FROM source_removals removal WHERE removal.source_id=source.id AND removal.state='complete')`
        ).get(row.source_id, row.run_id, row.snapshot_id, row.ingest_config_hash, row.config_version, row.lease_fence, row.observed_run_count);
        if (!valid) continue;
        const prior = bySource.get(row.source_id);
        if (!prior || row.checked_at > prior.checked_at) bySource.set(row.source_id, row);
        else if (row.checked_at === prior.checked_at && payload(row) !== payload(prior)) {
          throw new Error(`source verification migration collision for source '${row.source_id}' at ${row.checked_at}`);
        }
      }
      const needsRebuild = layouts.some((layout) => layout.table !== "source_verification_checks" || !layout.target);
      if (needsRebuild) {
        this.db.exec(`
          DROP TABLE IF EXISTS source_verification_checks_rebuild;
          CREATE TABLE source_verification_checks_rebuild (
            source_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
            ingest_config_hash TEXT NOT NULL,config_version INTEGER NOT NULL,lease_fence INTEGER NOT NULL,
            observed_run_count INTEGER NOT NULL,checked_at INTEGER NOT NULL
          );
        `);
        const insert = this.db.prepare(`INSERT INTO source_verification_checks_rebuild VALUES (?,?,?,?,?,?,?,?)`);
        for (const row of [...bySource.values()].sort((a, b) => compareUtf8(a.source_id, b.source_id))) {
          insert.run(row.source_id, row.run_id, row.snapshot_id, row.ingest_config_hash,
            row.config_version, row.lease_fence, row.observed_run_count, row.checked_at);
        }
        this.db.exec(`
          DROP INDEX IF EXISTS idx_source_verification_checks_source_time;
          DROP TABLE source_verification_checks;
          DROP TABLE IF EXISTS source_verification_checks_legacy;
          ALTER TABLE source_verification_checks_rebuild RENAME TO source_verification_checks;
        `);
      } else {
        // Even target-layout databases may retain a row for a source removed by an older release.
        this.db.prepare(`DELETE FROM source_verification_checks WHERE source_id NOT IN (${[...bySource.keys()].map(() => "?").join(",") || "SELECT '' WHERE 0"})`)
          .run(...bySource.keys());
      }
    }
    const emptyMetadata = canonicalJson({ tags: [], scope: null, frontmatter: {} });
    for (const table of ["source_staged_chunks", "source_chunks"]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "metadata_json")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '${emptyMetadata.replaceAll("'", "''")}'`);
      }
      if (!columns.some((column) => column.name === "binding_generation")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1)`);
      }
    }
    // Reconstruct the cleanup table under an IMMEDIATE transaction. Older releases could crash
    // between RENAME and DROP, leaving `_legacy` alone or alongside an empty/current table. Read
    // every surviving copy first, merge exact duplicates idempotently, and reject either primary-
    // key or natural-key collisions rather than silently choosing one side.
    {
      const tableExists = (name: string): boolean => !!this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
        .get(name);
      const currentSql = (this.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='source_cleanup_items'`)
        .get() as { sql: string } | undefined)?.sql ?? "";
      const currentColumns = tableExists("source_cleanup_items")
        ? this.db.prepare(`PRAGMA table_info(source_cleanup_items)`).all() as Array<{ name: string }>
        : [];
      const currentIsTarget = currentSql.includes("quarantine-non-authorizing")
        && currentColumns.some((column) => column.name === "operation_id");
      const needsCleanupReconstruction = !currentIsTarget || tableExists("source_cleanup_items_legacy");
      if (needsCleanupReconstruction) {

      type CleanupMigrationRow = {
        id: string; source_id: string; run_id: string; target_run_id: string; kind: string;
        binding_id: string; operation_id: string | null; concept_id: string | null;
        observation_id: string | null; predecessor_observation_id: string | null;
        created_at: number; acknowledged_at: number | null;
      };
      const rows: CleanupMigrationRow[] = [];
      for (const table of ["source_cleanup_items", "source_cleanup_items_legacy"]) {
        if (!tableExists(table)) continue;
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const operation = columns.some((column) => column.name === "operation_id") ? "operation_id" : "NULL AS operation_id";
        rows.push(...this.db.prepare(
          `SELECT id,source_id,run_id,target_run_id,kind,binding_id,${operation},concept_id,observation_id,predecessor_observation_id,created_at,acknowledged_at FROM ${table}`,
        ).all() as CleanupMigrationRow[]);
      }
      const byId = new Map<string, CleanupMigrationRow>();
      const byBinding = new Map<string, CleanupMigrationRow>();
      const same = (a: CleanupMigrationRow, b: CleanupMigrationRow): boolean => JSON.stringify(a) === JSON.stringify(b);
      for (const row of rows) {
        const naturalKey = `${row.run_id}\u0000${row.binding_id}`;
        const idPrior = byId.get(row.id);
        const bindingPrior = byBinding.get(naturalKey);
        if ((idPrior && !same(idPrior, row)) || (bindingPrior && !same(bindingPrior, row))) {
          throw new Error(`source cleanup migration collision for id '${row.id}' or binding '${row.run_id}/${row.binding_id}'`);
        }
        byId.set(row.id, row);
        byBinding.set(naturalKey, row);
      }

      this.db.exec(`
        DROP INDEX IF EXISTS idx_source_cleanup_run;
        DROP TABLE IF EXISTS source_cleanup_items;
        DROP TABLE IF EXISTS source_cleanup_items_legacy;
        CREATE TABLE source_cleanup_items (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          target_run_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('retire-absent','reconcile-orphan','quarantine-non-authorizing')),
          binding_id TEXT NOT NULL,
          operation_id TEXT,
          concept_id TEXT,
          observation_id TEXT,
          predecessor_observation_id TEXT,
          created_at INTEGER NOT NULL,
          acknowledged_at INTEGER,
          UNIQUE (run_id, binding_id)
        );
        CREATE INDEX idx_source_cleanup_run ON source_cleanup_items(run_id, acknowledged_at, id);
      `);
      const insert = this.db.prepare(`INSERT INTO source_cleanup_items
        (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,predecessor_observation_id,created_at,acknowledged_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of [...byId.values()].sort((a, b) => compareUtf8(a.id, b.id))) {
        insert.run(row.id, row.source_id, row.run_id, row.target_run_id, row.kind, row.binding_id,
          row.operation_id, row.concept_id, row.observation_id, row.predecessor_observation_id,
          row.created_at, row.acknowledged_at);
      }
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_source_cleanup_run
        ON source_cleanup_items(run_id, acknowledged_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_staged_chunks_concept
        ON source_staged_chunks(run_id, concept_id) WHERE concept_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_staged_chunks_observation
        ON source_staged_chunks(run_id, observation_id) WHERE observation_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_chunks_active_concept
        ON source_chunks(source_id, concept_id) WHERE lifecycle='active' AND concept_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_chunks_active_observation
        ON source_chunks(source_id, observation_id) WHERE lifecycle='active' AND observation_id IS NOT NULL;
    `);
    // Crash-safe legacy repair: sources with no sequenced events are assigned a
    // deterministic order from their durable attempt records. New writes always
    // append in the same transaction as the corresponding attempt.
    for (const source of this.db.prepare(`SELECT source.id FROM knowledge_sources source
      WHERE source.lifecycle='active'
        AND NOT EXISTS (SELECT 1 FROM source_removals removal
          WHERE removal.source_id=source.id AND removal.state='complete')
      ORDER BY source.id`).all() as Array<{ id: string }>) {
      const exists = this.db.prepare(`SELECT 1 FROM source_attempt_events WHERE source_id=? LIMIT 1`).get(source.id);
      if (exists) continue;
      const legacy: Array<{
        kind: "run" | "verification" | "pre-pin-failure"; ref: string; runId: string | null; at: number; reason?: string;
        configVersion: number; leaseFence: number;
      }> = [];
      const runs = this.db.prepare(`SELECT id,created_at,config_version,lease_fence FROM source_sync_runs
        WHERE source_id=? ORDER BY rowid,id`).all(source.id) as Array<{
          id: string; created_at: number; config_version: number; lease_fence: number;
        }>;
      const verification = this.db.prepare(`SELECT run_id,checked_at,observed_run_count,config_version,lease_fence
        FROM source_verification_checks WHERE source_id=?`).get(source.id) as {
          run_id: string; checked_at: number; observed_run_count: number; config_version: number; lease_fence: number;
        } | undefined;
      // Clocks are advisory only. The durable observed count is the causal fence:
      // exactly that many runs precede verification and every later run follows it.
      const observed = verification ? Math.min(verification.observed_run_count, runs.length) : runs.length;
      const runEvent = (run: typeof runs[number]) => ({
        kind: "run" as const, ref: run.id, runId: run.id, at: run.created_at,
        configVersion: run.config_version, leaseFence: run.lease_fence,
      });
      legacy.push(...runs.slice(0, observed).map(runEvent));
      if (verification) legacy.push({
        kind: "verification", ref: `legacy:${verification.run_id}`, runId: verification.run_id,
        at: verification.checked_at, configVersion: verification.config_version, leaseFence: verification.lease_fence,
      });
      legacy.push(...runs.slice(observed).map(runEvent));
      const failure = this.db.prepare(`SELECT attempted_at,reason,config_version,lease_fence FROM source_pre_pin_attempts WHERE source_id=?`).get(source.id) as
        { attempted_at: number; reason: string; config_version: number; lease_fence: number } | undefined;
      if (failure) {
        const event = {
          kind: "pre-pin-failure" as const, ref: "legacy", runId: null, at: failure.attempted_at, reason: failure.reason,
          configVersion: failure.config_version, leaseFence: failure.lease_fence,
        };
        // Insert non-run evidence by its clock without disturbing the causal
        // run/verification spine. Equal clocks use stable kind/ref byte order.
        const index = legacy.findIndex((candidate) => candidate.at > event.at
          || (candidate.at === event.at && (compareUtf8(candidate.kind, event.kind) > 0
            || (candidate.kind === event.kind && compareUtf8(candidate.ref, event.ref) > 0))));
        legacy.splice(index < 0 ? legacy.length : index, 0, event);
      }
      const insertAttempt = this.db.prepare(`INSERT INTO source_attempt_events
        (source_id,sequence,kind,ref_id,run_id,attempted_at,failure_reason,invocation_result,config_version,lease_fence)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      legacy.forEach((event, index) => insertAttempt.run(
        source.id, index + 1, event.kind, event.ref, event.runId, event.at, event.reason ?? null,
        null, event.configVersion, event.leaseFence,
      ));
    }
    this.db.prepare(`DELETE FROM source_attempt_events WHERE (source_id,sequence) IN (
      SELECT source_id,sequence FROM (
        SELECT source_id,sequence,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY sequence DESC) AS retained_rank
        FROM source_attempt_events
      ) WHERE retained_rank > ?
    )`).run(SOURCE_ATTEMPT_EVENT_RETENTION);
    })();
  }

  private compactAttempts(sourceId: string): void {
    this.db.prepare(`DELETE FROM source_attempt_events WHERE source_id=? AND sequence < COALESCE((
      SELECT sequence FROM source_attempt_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?
    ),0)`).run(sourceId, sourceId, SOURCE_ATTEMPT_EVENT_RETENTION - 1);
  }

  private appendAttempt(
    sourceId: string, kind: "run" | "verification" | "pre-pin-failure" | "invocation",
    refId: string, runId: string | null, attemptedAt: number, failureReason: string | null = null,
    invocationResult: SourceSyncRunResult | null = null, configVersion: number | null = null, leaseFence: number | null = null,
  ): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM source_attempt_events WHERE source_id=?`).get(sourceId) as { sequence: number };
    this.db.prepare(`INSERT INTO source_attempt_events
      (source_id,sequence,kind,ref_id,run_id,attempted_at,failure_reason,invocation_result,config_version,lease_fence)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(sourceId, row.sequence, kind, refId, runId, attemptedAt, failureReason, invocationResult, configVersion, leaseFence);
    this.compactAttempts(sourceId);
    return row.sequence;
  }

  beginRun(input: BeginSourceRunInput): BeginSourceRunResult {
    return this.db.immediateTransaction((): BeginSourceRunResult => {
      const sourceId = requireString(input.sourceId, "sourceId");
      const snapshotId = requireString(input.snapshotId, "snapshotId");
      const hasExpectedConfig = input.expectedConfigVersion !== undefined;
      const hasExpectedLease = input.expectedLeaseFence !== undefined;
      if (hasExpectedConfig !== hasExpectedLease) throw new Error("source run fence must include both configVersion and leaseFence");
      const expectedConfigVersion = hasExpectedConfig ? requireInteger(input.expectedConfigVersion, "expectedConfigVersion", 1) : null;
      const expectedLeaseFence = hasExpectedLease ? requireInteger(input.expectedLeaseFence, "expectedLeaseFence", 1) : null;
      this.beginRunFault?.();
      const source = this.db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(sourceId) as SourceRow | undefined;
      if (!source || source.lifecycle !== "active") throw new Error("source not found or tombstoned");
      if (expectedConfigVersion !== null && (source.config_version !== expectedConfigVersion || source.lease_fence !== expectedLeaseFence)) {
        throw new Error("source run fence is stale");
      }
      const pendingReconciliation = this.db.prepare(`SELECT run.id FROM source_sync_runs run
        WHERE run.source_id=? AND run.state='aborted' AND EXISTS (
          SELECT 1 FROM source_cleanup_items item WHERE item.run_id=run.id
            AND item.kind IN ('reconcile-orphan','quarantine-non-authorizing') AND item.acknowledged_at IS NULL
        ) ORDER BY run.created_at DESC,run.id DESC LIMIT 1`).get(sourceId) as { id: string } | undefined;
      if (pendingReconciliation) throw new Error(`source has pending orphan reconciliation: ${pendingReconciliation.id}`);
      const effectiveConfig = effectiveSourceScanConfig({
        autoDetect: source.auto_detect === 1,
        include: JSON.parse(source.include_json),
        exclude: JSON.parse(source.exclude_json),
      });
      const ingestConfigHash = computeSourceIngestConfigHash(effectiveConfig);
      const scanConfigVersion = `${SOURCE_SCANNER_VERSION}/${SOURCE_CHUNKER_VERSION}`;
      const configVersion = source.config_version;
      const leaseFence = source.lease_fence;
      const live = this.db.prepare(`SELECT * FROM source_sync_runs WHERE source_id = ? AND state IN ('scanning','staging','activating','cleaning')`).get(sourceId) as RunRow | undefined;
      if (live) {
        if (live.snapshot_id === snapshotId && live.ingest_config_hash === ingestConfigHash && live.config_version === configVersion &&
            live.lease_fence === leaseFence && live.scan_config_version === scanConfigVersion &&
            live.effective_config_json === canonicalJson(effectiveConfig)) {
          return { kind: "started", run: rowToRun(live) };
        }
        throw new Error(`source already has a conflicting nonterminal run: ${live.id}`);
      }
      if (source.applied_config_version === source.config_version &&
          source.active_snapshot_id === snapshotId && source.active_ingest_config_hash === ingestConfigHash) {
        return { kind: "noop", source: rowToSource(source) };
      }
      const id = this.idGen();
      const now = this.now();
      this.db.prepare(`INSERT INTO source_sync_runs
        (id,source_id,snapshot_id,ingest_config_hash,scan_config_version,effective_config_json,config_version,lease_fence,complete,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'scanning',?,?)`).run(
        id, sourceId, snapshotId, ingestConfigHash, scanConfigVersion, canonicalJson(effectiveConfig), configVersion, leaseFence,
        0, now, now,
      );
      this.db.prepare(`INSERT INTO source_snapshots
        (source_id,snapshot_id,config_version,run_id,ingest_config_hash,state,created_at) VALUES (?,?,?,?,?,'staged',?)`).run(
        sourceId, snapshotId, configVersion, id, ingestConfigHash, now,
      );
      this.appendAttempt(sourceId, "run", id, id, now, null, null, configVersion, leaseFence);
      this.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(sourceId);
      return { kind: "started", run: this.getRun(id)! };
    })();
  }

  stageManifest(input: StageSourceManifestInput): SourceSyncRun {
    return this.db.immediateTransaction(() => {
      const run = this.requireRun(input.runId);
      if (run.state !== "scanning" && run.state !== "staging") throw new Error(`cannot stage manifest while run is ${run.state}`);
      this.validateManifest(run, input.files, input.chunks);
      if (input.manifestHash !== computeSourceManifestHash(input.files)) {
        throw new Error("manifestHash does not match the staged file manifest");
      }
      for (const chunk of input.chunks) this.validateBindingProof(run, chunk);
      const replay = canonicalJson(this.manifestShape(input.scanStatus, input.manifestHash, input.files, input.chunks));
      if (run.state === "staging") {
        const stored = this.readStagedManifest(run.id, run.complete ? "complete" : "partial", run.manifestHash!);
        if (canonicalJson(stored) !== replay) throw new Error("staged manifest conflicts with existing run contents");
        return run;
      }
      const now = this.now();
      for (const file of input.files) {
        this.db.prepare(`INSERT INTO source_staged_files (run_id,relative_path,type,content_hash,byte_length) VALUES (?,?,?,?,?)`).run(
          run.id, file.relativePath, file.type, file.contentHash, file.byteLength,
        );
      }
      for (const chunk of input.chunks) {
        this.db.prepare(`INSERT INTO source_staged_chunks
          (run_id,binding_id,binding_generation,operation_id,relative_path,heading_path_json,occurrence,segment_index,content_hash,ingest_fingerprint,metadata_json,source_ref,content)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          run.id, chunk.bindingId, chunk.bindingGeneration, chunk.operationId, chunk.relativePath, JSON.stringify(chunk.headingPath), chunk.occurrence,
          chunk.segmentIndex, chunk.contentHash, chunk.ingestFingerprint,
          canonicalJson(canonicalizeSourceChunkMetadata(chunk.metadata)), chunk.sourceRef, chunk.content,
        );
      }
      this.db.prepare(`UPDATE source_sync_runs SET state='staging', complete=?, manifest_hash=?, file_count=?, chunk_count=?, updated_at=? WHERE id=?`).run(
        input.scanStatus === "complete" ? 1 : 0, requireString(input.manifestHash, "manifestHash"), input.files.length, input.chunks.length, now, run.id,
      );
      return this.requireRun(run.id);
    })();
  }

  recordBindingReceipt(input: RecordSourceBindingReceiptInput): SourceChunkRecord {
    return this.db.immediateTransaction(() => {
      const run = this.requireRun(input.runId);
      if (run.state !== "staging") throw new Error(`cannot record a binding receipt while run is ${run.state}`);
      if (!run.complete) throw new Error("partial manifests may only be aborted");
      const existing = this.db.prepare(`SELECT * FROM source_staged_chunks WHERE run_id=? AND binding_id=?`).get(run.id, input.bindingId) as Record<string, unknown> | undefined;
      if (!existing) throw new Error("binding is not staged for this run");
      if (!(["engine-written", "committed", "skipped"] as string[]).includes(input.writeState)) throw new Error("invalid binding writeState");
      const previous = {
        concept: existing.concept_id ?? null, observation: existing.observation_id ?? null,
        predecessor: existing.predecessor_observation_id ?? null, state: existing.write_state ?? "intent",
      };
      let next: { concept: unknown; observation: unknown; predecessor: unknown; state: string };
      if (input.writeState === "skipped") {
        const prior = this.db.prepare(`SELECT old.concept_id,old.observation_id,old.predecessor_observation_id,
            old.relative_path,old.heading_path_json,old.occurrence,old.segment_index,old.content_hash,old.ingest_fingerprint,old.metadata_json,old.source_ref,old.content
          FROM knowledge_sources source JOIN source_chunks old ON old.run_id=source.active_run_id
          WHERE source.id=? AND old.binding_id=? AND old.lifecycle='active'`).get(run.sourceId, input.bindingId) as
          | { concept_id: string | null; observation_id: string | null; predecessor_observation_id: string | null;
              relative_path: string; heading_path_json: string; occurrence: number; segment_index: number;
              content_hash: string; ingest_fingerprint: string; metadata_json: string; source_ref: string; content: string }
          | undefined;
        if (!prior?.concept_id || !prior.observation_id) throw new Error("skipped requires a prior active binding with complete concept and observation receipts");
        const unchanged = prior.relative_path === existing.relative_path && prior.heading_path_json === existing.heading_path_json &&
          prior.occurrence === existing.occurrence && prior.segment_index === existing.segment_index &&
          prior.content_hash === existing.content_hash && prior.ingest_fingerprint === existing.ingest_fingerprint &&
          prior.metadata_json === existing.metadata_json && prior.source_ref === existing.source_ref && prior.content === existing.content;
        if (!unchanged) throw new Error("skipped requires an unchanged prior active binding");
        if ((input.conceptId !== undefined && input.conceptId !== prior.concept_id) ||
            (input.observationId !== undefined && input.observationId !== prior.observation_id) ||
            (input.predecessorObservationId !== undefined && input.predecessorObservationId !== prior.predecessor_observation_id)) {
          throw new Error("skipped receipt IDs must match the prior active binding");
        }
        next = { concept: prior.concept_id, observation: prior.observation_id, predecessor: prior.predecessor_observation_id, state: "skipped" };
      } else {
        next = {
          concept: input.conceptId === undefined ? previous.concept : input.conceptId,
          observation: input.observationId === undefined ? previous.observation : input.observationId,
          predecessor: input.predecessorObservationId === undefined ? previous.predecessor : input.predecessorObservationId,
          state: input.writeState,
        };
        requireString(next.concept, "conceptId");
        requireString(next.observation, "observationId");
        if (next.predecessor !== null) requireString(next.predecessor, "predecessorObservationId");
        this.validateEngineReceipt(run, existing, next, input.writeState);
        const collision = this.db.prepare(`SELECT binding_id FROM source_staged_chunks
          WHERE run_id=? AND binding_id<>? AND (concept_id=? OR observation_id=?) LIMIT 1`).get(
          run.id, input.bindingId, next.concept, next.observation,
        ) as { binding_id: string } | undefined;
        if (collision) throw new Error(`binding receipt collides with staged binding ${collision.binding_id}`);
      }
      const legalAdvance = previous.state === "intent" || (previous.state === "engine-written" && input.writeState === "committed");
      const sameIds = previous.concept === next.concept && previous.observation === next.observation && previous.predecessor === next.predecessor;
      const exactReplay = previous.state === next.state && sameIds;
      if (!exactReplay && (!legalAdvance || (previous.state === "engine-written" && !sameIds))) {
        throw new Error("binding receipt conflicts with the recorded receipt or is not a monotone transition");
      }
      if (!exactReplay) {
        this.db.prepare(`UPDATE source_staged_chunks SET concept_id=?, observation_id=?, predecessor_observation_id=?, write_state=? WHERE run_id=? AND binding_id=?`).run(
          next.concept, next.observation, next.predecessor, next.state, run.id, input.bindingId,
        );
        this.db.prepare(`UPDATE source_sync_runs SET updated_at=? WHERE id=?`).run(this.now(), run.id);
      }
      return this.stagedChunkToRecord(run, this.db.prepare(`SELECT * FROM source_staged_chunks WHERE run_id=? AND binding_id=?`).get(run.id, input.bindingId) as Record<string, unknown>);
    })();
  }

  beginActivation(runId: string): string {
    return this.db.immediateTransaction(() => {
      const run = this.requireRun(runId);
      if (run.state === "activating" && run.activationToken) return run.activationToken;
      if (run.state !== "staging") throw new Error(`cannot activate while run is ${run.state}`);
      if (!run.complete) throw new Error("partial manifests cannot activate or drive deletions");
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM source_staged_chunks WHERE run_id=? AND (write_state IS NULL OR write_state NOT IN ('committed','skipped'))`).get(run.id) as { count: number };
      if (pending.count !== 0) throw new Error("every staged chunk must have a committed or skipped receipt before activation");
      this.assertFence(run);
      const token = this.idGen();
      this.db.prepare(`UPDATE source_sync_runs SET state='activating', activation_token=?, updated_at=? WHERE id=?`).run(token, this.now(), run.id);
      return token;
    })();
  }

  publishRun(input: PublishSourceRunInput): SourceSyncRun {
    return this.db.immediateTransaction(() => {
      const run = this.requireRun(input.runId);
      if (run.activationToken !== input.activationToken) throw new Error("activation token does not match");
      if (input.expectedManifestHash !== undefined && input.expectedManifestHash !== run.manifestHash) throw new Error("manifest hash changed before publish");
      if (["published", "cleaning", "cleaned"].includes(run.state)) return run;
      if (run.state !== "activating") throw new Error(`cannot publish while run is ${run.state}`);
      this.assertFence(run);
      const counts = this.db.prepare(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT binding_id) AS bindings FROM source_staged_chunks WHERE run_id=?`).get(run.id) as { chunks: number; bindings: number };
      const files = this.db.prepare(`SELECT COUNT(*) AS count FROM source_staged_files WHERE run_id=?`).get(run.id) as { count: number };
      if (counts.chunks !== run.chunkCount || counts.bindings !== run.chunkCount || files.count !== run.fileCount) throw new Error("staged manifest counts changed before publish");
      const stagedFiles = this.listFiles(run.id).map(({ sourceId: _sourceId, runId: _runId, snapshotId: _snapshotId, configVersion: _configVersion, ...file }) => file);
      if (computeSourceManifestHash(stagedFiles) !== run.manifestHash) throw new Error("staged manifest hash changed before publish");
      const source = this.db.prepare(`SELECT active_run_id FROM knowledge_sources WHERE id=?`).get(run.sourceId) as { active_run_id: string | null };
      const priorRunId = source.active_run_id;
      this.revalidateReceiptsForPublication(run);
      const now = this.now();
      this.db.prepare(`INSERT INTO source_files SELECT ?,run_id,?, ?,relative_path,type,content_hash,byte_length FROM source_staged_files WHERE run_id=?`).run(
        run.sourceId, run.snapshotId, run.configVersion, run.id,
      );
      if (priorRunId) this.db.prepare(`UPDATE source_chunks SET lifecycle='superseded' WHERE run_id=? AND lifecycle='active'`).run(priorRunId);
      this.db.prepare(`INSERT INTO source_chunks
        (source_id,run_id,snapshot_id,config_version,binding_id,binding_generation,operation_id,relative_path,heading_path_json,occurrence,segment_index,content_hash,ingest_fingerprint,metadata_json,source_ref,content,concept_id,observation_id,predecessor_observation_id,write_state)
        SELECT ?,run_id,?, ?,binding_id,binding_generation,operation_id,relative_path,heading_path_json,occurrence,segment_index,content_hash,ingest_fingerprint,metadata_json,source_ref,content,concept_id,observation_id,predecessor_observation_id,write_state
        FROM source_staged_chunks WHERE run_id=?`).run(run.sourceId, run.snapshotId, run.configVersion, run.id);
      this.db.prepare(`UPDATE source_snapshots SET state='superseded', superseded_at=? WHERE source_id=? AND state='active'`).run(now, run.sourceId);
      this.db.prepare(`UPDATE source_snapshots SET state='active', published_at=? WHERE run_id=?`).run(now, run.id);
      this.db.prepare(`UPDATE knowledge_sources SET active_run_id=?,active_snapshot_id=?,active_ingest_config_hash=?,applied_config_version=?,updated_at=? WHERE id=?`).run(
        run.id, run.snapshotId, run.ingestConfigHash, run.configVersion, now, run.sourceId,
      );
      if (priorRunId) {
        const absent = this.db.prepare(`SELECT old.binding_id,old.operation_id,old.concept_id,old.observation_id,old.predecessor_observation_id
          FROM source_chunks old LEFT JOIN source_staged_chunks next ON next.run_id=? AND next.binding_id=old.binding_id
          WHERE old.run_id=? AND next.binding_id IS NULL`).all(run.id, priorRunId) as Array<{ binding_id: string; operation_id: string; concept_id: string | null; observation_id: string | null; predecessor_observation_id: string | null }>;
        for (const item of absent) {
          this.db.prepare(`INSERT INTO source_cleanup_items (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,predecessor_observation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
            this.idGen(), run.sourceId, run.id, priorRunId, "retire-absent", item.binding_id, item.operation_id, item.concept_id, item.observation_id, item.predecessor_observation_id, now,
          );
        }
      }
      this.db.prepare(`UPDATE source_sync_runs SET state='published',result='success',published_at=?,updated_at=? WHERE id=?`).run(now, now, run.id);
      const cleanup = this.db.prepare(`SELECT COUNT(*) AS count FROM source_cleanup_items WHERE run_id=?`).get(run.id) as { count: number };
      if (cleanup.count > 0) this.db.prepare(`UPDATE source_sync_runs SET state='cleaning',updated_at=? WHERE id=?`).run(now, run.id);
      else {
        this.db.prepare(`UPDATE source_sync_runs SET state='cleaning',updated_at=? WHERE id=?`).run(now, run.id);
        this.db.prepare(`UPDATE source_sync_runs SET state='cleaned',updated_at=?,finished_at=? WHERE id=?`).run(now, now, run.id);
      }
      return this.requireRun(run.id);
    })();
  }

  abortRun(runId: string, result: "failed" | "partial", reason?: string): SourceSyncRun {
    return this.db.immediateTransaction(() => {
      if (result !== "failed" && result !== "partial") throw new Error("aborted run result must be failed or partial");
      const safeReason = reason === undefined ? null : sanitizeSourceError(reason);
      const run = this.requireRun(runId);
      if (run.state === "aborted") {
        if (run.result !== result || run.reason !== safeReason) throw new Error("abort conflicts with the recorded result");
        this.ensureOrphanCleanup(run);
        return run;
      }
      if (!(["scanning", "staging", "activating"] as string[]).includes(run.state)) throw new Error(`cannot abort while run is ${run.state}`);
      if (result === "partial" && run.complete) throw new Error("partial result requires a partial manifest/run");
      const now = this.now();
      this.ensureOrphanCleanup(run, now);
      this.db.prepare(`UPDATE source_sync_runs SET state='aborted',result=?,reason=?,updated_at=?,finished_at=? WHERE id=?`).run(result, safeReason, now, now, run.id);
      this.db.prepare(`UPDATE source_snapshots SET state='aborted' WHERE run_id=?`).run(run.id);
      return this.requireRun(run.id);
    })();
  }

  acknowledgeCleanup(itemId: string): SourceCleanupItem {
    return this.db.immediateTransaction(() => {
      const item = this.db.prepare(`SELECT * FROM source_cleanup_items WHERE id=?`).get(itemId) as Record<string, unknown> | undefined;
      if (!item) throw new Error("cleanup item not found");
      const now = this.now();
      if (item.acknowledged_at === null) {
        if (item.kind !== "quarantine-non-authorizing") {
          if (typeof item.concept_id !== "string" || typeof item.observation_id !== "string") {
            throw new Error("authorized cleanup cannot be acknowledged without concept and observation evidence");
          }
          const observation = this.db.prepare(
            `SELECT concept_id,superseded_by,superseded_at FROM observations WHERE id=?`,
          ).get(item.observation_id) as { concept_id: string | null; superseded_by: string | null; superseded_at: number | null } | undefined;
          if (!observation || observation.concept_id !== item.concept_id
              || observation.superseded_by !== null || observation.superseded_at === null) {
            throw new Error("authorized cleanup observation is not terminally superseded");
          }
          const concept = this.db.prepare(
            `SELECT kind,status,active_observation_id FROM concepts WHERE id=?`,
          ).get(item.concept_id) as { kind: string; status: string; active_observation_id: string | null } | undefined;
          if (!concept || concept.kind !== "source") throw new Error("authorized cleanup owner is not a source concept");

          const predecessor = typeof item.predecessor_observation_id === "string"
            ? item.predecessor_observation_id
            : null;
          if (item.kind === "retire-absent" || predecessor === null) {
            if (concept.status !== "retired" || concept.active_observation_id !== null) {
              throw new Error("authorized cleanup source concept is not retired with a null active pointer");
            }
          } else {
            const prior = this.db.prepare(`SELECT concept_id,superseded_at FROM observations WHERE id=?`).get(predecessor) as
              | { concept_id: string | null; superseded_at: number | null }
              | undefined;
            if (concept.status === "retired" || concept.active_observation_id !== predecessor
                || !prior || prior.concept_id !== item.concept_id || prior.superseded_at !== null) {
              throw new Error("orphan cleanup did not preserve the active predecessor projection");
            }
          }
        }
        this.db.prepare(`UPDATE source_cleanup_items SET acknowledged_at=? WHERE id=?`).run(now, itemId);
        if (item.kind === "retire-absent") {
          this.db.prepare(`UPDATE source_chunks SET lifecycle='deleted' WHERE run_id=? AND binding_id=? AND lifecycle='superseded'`).run(item.target_run_id, item.binding_id);
        }
      }
      const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM source_cleanup_items WHERE run_id=? AND acknowledged_at IS NULL`).get(item.run_id) as { count: number };
      if (remaining.count === 0) this.db.prepare(`UPDATE source_sync_runs SET state='cleaned',updated_at=?,finished_at=? WHERE id=? AND state='cleaning'`).run(now, now, item.run_id);
      return this.cleanupRow(this.db.prepare(`SELECT * FROM source_cleanup_items WHERE id=?`).get(itemId) as Record<string, unknown>);
    })();
  }

  getRun(runId: string): SourceSyncRun | null {
    const row = this.db.prepare(`SELECT * FROM source_sync_runs WHERE id=?`).get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(sourceId: string): SourceSyncRun[] {
    return (this.db.prepare(`SELECT * FROM source_sync_runs WHERE source_id=? ORDER BY created_at,id`).all(sourceId) as RunRow[]).map(rowToRun);
  }

  /** Read-only validation of the registry's exact active publication tuple. */
  activePublication(sourceId: string, runId: string, snapshotId: string, ingestConfigHash: string): SourcePublicationView {
    const run = this.getRun(runId);
    if (!run || run.sourceId !== sourceId || run.snapshotId !== snapshotId
        || run.ingestConfigHash !== ingestConfigHash || run.result !== "success"
        || !(run.state === "published" || run.state === "cleaning" || run.state === "cleaned")) {
      throw new Error("source active publication ledger tuple is inconsistent");
    }
    const snapshot = this.db.prepare(
      `SELECT state FROM source_snapshots WHERE source_id=? AND run_id=? AND snapshot_id=? AND ingest_config_hash=?`,
    ).get(sourceId, runId, snapshotId, ingestConfigHash) as { state: string } | undefined;
    if (!snapshot || snapshot.state !== "active") throw new Error("source active snapshot is not published");
    const files = this.db.prepare(`SELECT COUNT(*) AS count FROM source_files WHERE source_id=? AND run_id=? AND snapshot_id=?`).get(sourceId, runId, snapshotId) as { count: number };
    const chunks = this.db.prepare(`SELECT COUNT(*) AS count FROM source_chunks WHERE source_id=? AND run_id=? AND snapshot_id=? AND lifecycle='active'`).get(sourceId, runId, snapshotId) as { count: number };
    return { run, filesIndexed: files.count, chunksIndexed: chunks.count };
  }

  /** Exact published file manifest used to authenticate offline active-pointer repair. */
  publishedManifest(sourceId: string, runId: string, snapshotId: string, ingestConfigHash: string): SourcePublishedManifest {
    const publication = this.activePublication(sourceId, runId, snapshotId, ingestConfigHash);
    if (!publication.run.manifestHash) throw new Error("source active publication has no durable manifest hash");
    const files = this.listFiles({ runId, published: true }).map(
      ({ sourceId: _sourceId, runId: _runId, snapshotId: _snapshotId, configVersion: _configVersion, ...file }) => file,
    );
    if (computeSourceManifestHash(files) !== publication.run.manifestHash) {
      throw new Error("source active publication file manifest is corrupt");
    }
    return {
      sourceId, runId, snapshotId, ingestConfigHash,
      configVersion: publication.run.configVersion, leaseFence: publication.run.leaseFence,
      manifestHash: publication.run.manifestHash, files,
    };
  }

  /** Record a successful unchanged-source verification only while the exact publication fence is still current. */
  recordVerification(input: {
    sourceId: string; runId: string; snapshotId: string; ingestConfigHash: string;
    configVersion: number; leaseFence: number;
  }): number {
    return this.db.immediateTransaction(() => {
      const row = this.db.prepare(`SELECT source.lifecycle,source.config_version,source.lease_fence,
          source.active_run_id,source.active_snapshot_id,source.active_ingest_config_hash,
          run.state AS run_state,run.result AS run_result,snapshot.state AS snapshot_state
        FROM knowledge_sources source
        JOIN source_sync_runs run ON run.id=source.active_run_id AND run.source_id=source.id
        JOIN source_snapshots snapshot ON snapshot.run_id=run.id AND snapshot.source_id=source.id
        WHERE source.id=?`).get(input.sourceId) as Record<string, unknown> | undefined;
      if (!row || row.lifecycle !== "active" || row.config_version !== input.configVersion
          || row.lease_fence !== input.leaseFence || row.active_run_id !== input.runId
          || row.active_snapshot_id !== input.snapshotId || row.active_ingest_config_hash !== input.ingestConfigHash
          || row.run_result !== "success" || !(row.run_state === "published" || row.run_state === "cleaning" || row.run_state === "cleaned")
          || row.snapshot_state !== "active") throw new Error("source verification publication fence is stale");
      const checkedAt = this.now();
      const observed = this.db.prepare(`SELECT COUNT(*) AS count FROM source_sync_runs WHERE source_id=?`).get(input.sourceId) as { count: number };
      this.db.prepare(`INSERT INTO source_verification_checks
        (source_id,run_id,snapshot_id,ingest_config_hash,config_version,lease_fence,observed_run_count,checked_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
          run_id=excluded.run_id,snapshot_id=excluded.snapshot_id,ingest_config_hash=excluded.ingest_config_hash,
          config_version=excluded.config_version,lease_fence=excluded.lease_fence,
          observed_run_count=excluded.observed_run_count,checked_at=excluded.checked_at`).run(input.sourceId, input.runId, input.snapshotId,
          input.ingestConfigHash, input.configVersion, input.leaseFence, observed.count, checkedAt);
      const next = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM source_attempt_events WHERE source_id=?`).get(input.sourceId) as { sequence: number };
      this.appendAttempt(input.sourceId, "verification", `${input.runId}:${next.sequence}`, input.runId, checkedAt,
        null, null, input.configVersion, input.leaseFence);
      this.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(input.sourceId);
      return checkedAt;
    })();
  }

  recordPrePinFailure(input: { sourceId: string; reason: string; configVersion: number; leaseFence: number }): number {
    const safeReason = sanitizeSourceError(input.reason);
    return this.db.immediateTransaction(() => {
      const source = this.db.prepare(`SELECT config_version,lease_fence,lifecycle FROM knowledge_sources WHERE id=?`).get(input.sourceId) as
        | { config_version: number; lease_fence: number; lifecycle: string }
        | undefined;
      if (!source || source.lifecycle !== "active" || source.config_version !== input.configVersion || source.lease_fence !== input.leaseFence) {
        throw new Error("source pre-pin attempt fence is stale");
      }
      const attemptedAt = this.now();
      this.db.prepare(`INSERT INTO source_pre_pin_attempts(source_id,attempted_at,reason,config_version,lease_fence)
        VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET attempted_at=excluded.attempted_at,reason=excluded.reason,
        config_version=excluded.config_version,lease_fence=excluded.lease_fence`)
        .run(input.sourceId, attemptedAt, safeReason, source.config_version, source.lease_fence);
      const next = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM source_attempt_events WHERE source_id=?`).get(input.sourceId) as { sequence: number };
      this.appendAttempt(input.sourceId, "pre-pin-failure", `failure:${next.sequence}`, null, attemptedAt, safeReason,
        null, input.configVersion, input.leaseFence);
      return attemptedAt;
    })();
  }

  /** Immutable invocation outcome for a retry of an already-durable run. */
  recordRunInvocation(input: {
    sourceId: string; runId: string; result: "success" | "failed" | "partial";
    reason?: string; configVersion: number; leaseFence: number;
  }): number {
    return this.db.immediateTransaction(() => {
      const authority = this.db.prepare(`SELECT source.lifecycle,removal.state AS removal_state
        FROM knowledge_sources source
        LEFT JOIN source_removals removal ON removal.source_id=source.id
        WHERE source.id=?`).get(input.sourceId) as { lifecycle: string; removal_state: string | null } | undefined;
      if (authority?.lifecycle === "tombstoned" && authority.removal_state === "complete") {
        throw new Error("source run invocation is closed by completed removal");
      }
      const run = this.requireRun(input.runId);
      if (run.sourceId !== input.sourceId
          || run.configVersion !== input.configVersion || run.leaseFence !== input.leaseFence) {
        throw new Error("source run invocation fence is stale");
      }
      const attemptedAt = this.now();
      const reason = input.result === "failed"
        ? sanitizeSourceError(input.reason ?? run.reason ?? "source sync invocation failed")
        : null;
      const next = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM source_attempt_events WHERE source_id=?`)
        .get(input.sourceId) as { sequence: number };
      this.appendAttempt(input.sourceId, "invocation", `${input.runId}:${next.sequence}`, input.runId, attemptedAt, reason,
        input.result, input.configVersion, input.leaseFence);
      if (input.result !== "failed") this.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(input.sourceId);
      return attemptedAt;
    })();
  }

  /** Crash-safe schedule basis. Attempt events are authoritative; no parallel scheduler cursor exists. */
  private scheduleBasisSnapshot(sourceId: string, configVersion: number, leaseFence: number): SourceScheduleBasis {
      const rows = this.db.prepare(`SELECT event.sequence,event.kind,event.run_id,event.attempted_at,
          event.invocation_result,event.config_version,event.lease_fence,
          run.result AS run_result,run.published_at,run.finished_at
        FROM source_attempt_events event
        LEFT JOIN source_sync_runs run ON run.id=event.run_id AND run.source_id=event.source_id
        WHERE event.source_id=? AND event.config_version=? AND event.lease_fence=?
        ORDER BY event.sequence DESC`).all(sourceId, configVersion, leaseFence) as Array<{
          sequence: number; kind: "run" | "verification" | "pre-pin-failure" | "invocation";
          run_id: string | null; attempted_at: number; invocation_result: SourceSyncRunResult | null;
          config_version: number; lease_fence: number; run_result: SourceSyncRunResult | null;
          published_at: number | null; finished_at: number | null;
        }>;
      const seenRuns = new Set<string>();
      const terminals: Array<{ sequence: number; attemptedAt: number; result: SourceSyncRunResult }> = [];
      for (const row of rows) {
        let result: SourceSyncRunResult | null = null;
        let attemptedAt = row.attempted_at;
        if (row.kind === "verification") result = "success";
        else if (row.kind === "pre-pin-failure") result = "failed";
        else if (row.kind === "invocation") {
          result = row.invocation_result;
          if (row.run_id) seenRuns.add(row.run_id);
        } else if (row.run_id && !seenRuns.has(row.run_id) && row.run_result !== null) {
          // A terminal run is the crash-safe fallback when the process died after the
          // durable outcome but before appending its invocation receipt.
          result = row.run_result;
          attemptedAt = Math.max(attemptedAt, row.published_at ?? -1, row.finished_at ?? -1);
          seenRuns.add(row.run_id);
        }
        if (result) terminals.push({ sequence: row.sequence, attemptedAt, result });
      }
      let consecutiveFailures = 0;
      for (const terminal of terminals) {
        if (terminal.result === "success") break;
        consecutiveFailures += 1;
      }
      const resumable = this.resumeRun(sourceId) !== null;
      const removal = this.db.prepare(`SELECT source.lifecycle,removal.state FROM knowledge_sources source
        LEFT JOIN source_removals removal ON removal.source_id=source.id WHERE source.id=?`).get(sourceId) as
        | { lifecycle: string; state: string | null }
        | undefined;
      return {
        attemptSequence: rows[0]?.sequence ?? 0,
        latestTerminal: terminals[0] ?? null,
        consecutiveFailures,
        resumable,
        removalIncomplete: removal?.lifecycle === "tombstoned" && removal.state !== "complete",
      };
  }

  scheduleBasis(sourceId: string, configVersion: number, leaseFence: number): SourceScheduleBasis {
    return this.db.transaction(() => this.scheduleBasisSnapshot(sourceId, configVersion, leaseFence))();
  }

  acquireSchedulerLease(owner: string, now: number, leaseMs: number): boolean {
    owner = requireSchedulerOwner(owner);
    requireInteger(now, "scheduler clock");
    requireInteger(leaseMs, "scheduler lease duration", 1);
    if (!Number.isSafeInteger(now + leaseMs)) throw new Error("scheduler lease expiry is out of range");
    return this.db.immediateTransaction(() => {
      const current = this.db.prepare(`SELECT owner,expires_at FROM source_scheduler_lease WHERE singleton=1`).get() as
        | { owner: string; expires_at: number }
        | undefined;
      if (current && current.owner !== owner && current.expires_at > now) return false;
      this.db.prepare(`INSERT INTO source_scheduler_lease(singleton,owner,renewed_at,expires_at) VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`)
        .run(owner, now, now + leaseMs);
      return true;
    })();
  }

  renewSchedulerLease(owner: string, now: number, leaseMs: number): boolean {
    owner = requireSchedulerOwner(owner);
    requireInteger(now, "scheduler clock");
    requireInteger(leaseMs, "scheduler lease duration", 1);
    if (!Number.isSafeInteger(now + leaseMs)) throw new Error("scheduler lease expiry is out of range");
    const result = this.db.prepare(`UPDATE source_scheduler_lease SET renewed_at=?,expires_at=?
      WHERE singleton=1 AND owner=? AND expires_at>?`).run(now, now + leaseMs, owner, now);
    return result.changes === 1;
  }

  assertSchedulerLease(owner: string, now: number): boolean {
    owner = requireSchedulerOwner(owner);
    requireInteger(now, "scheduler clock");
    const current = this.db.prepare(`SELECT owner,expires_at FROM source_scheduler_lease WHERE singleton=1`).get() as
      | { owner: string; expires_at: number }
      | undefined;
    return current?.owner === owner && current.expires_at > now;
  }

  releaseSchedulerLease(owner: string): boolean {
    owner = requireSchedulerOwner(owner);
    return this.db.prepare(`DELETE FROM source_scheduler_lease WHERE singleton=1 AND owner=?`).run(owner).changes === 1;
  }

  /** Attempt metadata plus a conservative dirty count from only the latest complete staged manifest. */
  private attemptViewSnapshot(sourceId: string, activeRunId: string | null): SourceAttemptView {
    const runs = this.listRuns(sourceId);
    this.attemptReadFault?.();
    const latest = runs.at(-1) ?? null;
    const lastResult = [...runs].reverse().find((run) => run.result !== null) ?? null;
    const lastSuccess = [...runs].reverse().find((run) => run.result === "success" && run.publishedAt !== null) ?? null;
    const complete = [...runs].reverse().find((run) => run.complete) ?? null;
    const verification = this.db.prepare(`SELECT checked_at,observed_run_count FROM source_verification_checks
      WHERE source_id=?`).get(sourceId) as { checked_at: number; observed_run_count: number } | undefined;
    const prePin = this.db.prepare(`SELECT attempted_at,reason FROM source_pre_pin_attempts WHERE source_id=?`).get(sourceId) as
      | { attempted_at: number; reason: string }
      | undefined;
    const latestAttempt = this.db.prepare(`SELECT event.sequence,event.kind,event.run_id,event.attempted_at,event.failure_reason,
        event.invocation_result,event.config_version,event.lease_fence,run.result AS run_result,run.reason AS run_reason
      FROM source_attempt_events event LEFT JOIN source_sync_runs run ON run.id=event.run_id AND run.source_id=event.source_id
      WHERE event.source_id=? ORDER BY event.sequence DESC LIMIT 1`).get(sourceId) as
      | { sequence: number; kind: "run" | "verification" | "pre-pin-failure" | "invocation"; run_id: string | null;
          attempted_at: number; failure_reason: string | null; invocation_result: SourceSyncRunResult | null;
          config_version: number | null; lease_fence: number | null; run_result: SourceSyncRunResult | null; run_reason: string | null }
      | undefined;
    let dirtyFiles = 0;
    if (complete && activeRunId && complete.id !== activeRunId) {
      const row = this.db.prepare(`SELECT COUNT(DISTINCT relative_path) AS count FROM (
        SELECT relative_path FROM (
          SELECT relative_path,content_hash FROM source_staged_files WHERE run_id=?
          EXCEPT SELECT relative_path,content_hash FROM source_files WHERE run_id=?
        )
        UNION
        SELECT relative_path FROM (
          SELECT relative_path,content_hash FROM source_files WHERE run_id=?
          EXCEPT SELECT relative_path,content_hash FROM source_staged_files WHERE run_id=?
        )
      )`).get(complete.id, activeRunId, activeRunId, complete.id) as { count: number };
      dirtyFiles = row.count;
    }
    return {
      latest, lastResult, lastSuccess, latestVerificationAt: verification?.checked_at ?? null,
      latestVerificationRunCount: verification?.observed_run_count ?? null, runCount: runs.length, dirtyFiles,
      prePinFailure: prePin ? { attemptedAt: prePin.attempted_at, reason: prePin.reason } : null,
      latestAttempt: latestAttempt ? {
        sequence: latestAttempt.sequence, kind: latestAttempt.kind, runId: latestAttempt.run_id, attemptedAt: latestAttempt.attempted_at,
        runResult: latestAttempt.run_result, runReason: latestAttempt.run_reason, invocationResult: latestAttempt.invocation_result,
        configVersion: latestAttempt.config_version, leaseFence: latestAttempt.lease_fence,
        failureReason: latestAttempt.failure_reason
          ?? (prePin?.attempted_at === latestAttempt.attempted_at ? prePin.reason : null),
      } : null,
    };
  }

  attemptView(sourceId: string, activeRunId: string | null): SourceAttemptView {
    return this.db.transaction(() => this.attemptViewSnapshot(sourceId, activeRunId))();
  }

  statusScheduleView(
    sourceId: string,
    activeRunId: string | null,
    configVersion: number,
    leaseFence: number,
  ): SourceStatusScheduleView {
    return this.db.transaction(() => ({
      attempt: this.attemptViewSnapshot(sourceId, activeRunId),
      scheduleBasis: this.scheduleBasisSnapshot(sourceId, configVersion, leaseFence),
    }))();
  }

  resumeRun(sourceId: string): SourceSyncRun | null {
    const row = this.db.prepare(`SELECT * FROM source_sync_runs run WHERE source_id=? AND (
      state IN ('scanning','staging','activating','cleaning') OR
      (state='aborted' AND EXISTS (SELECT 1 FROM source_cleanup_items item WHERE item.run_id=run.id
        AND item.kind IN ('reconcile-orphan','quarantine-non-authorizing') AND item.acknowledged_at IS NULL))
    ) ORDER BY created_at DESC,id DESC LIMIT 1`).get(sourceId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  beginRemoval(sourceId: string): SourceRemoval {
    return this.db.immediateTransaction(() => {
      const source = this.db.prepare(`SELECT id,lifecycle,active_run_id,active_snapshot_id,active_ingest_config_hash
        FROM knowledge_sources WHERE id=?`).get(sourceId) as {
          id: string; lifecycle: string; active_run_id: string | null;
          active_snapshot_id: string | null; active_ingest_config_hash: string | null;
        } | undefined;
      if (!source || source.lifecycle !== "tombstoned") throw new Error("source removal requires a tombstoned lineage");
      const existing = this.getRemoval(sourceId);
      if (existing) return existing;
      if (source.active_run_id) {
        const snapshot = this.db.prepare(`SELECT snapshot_id,ingest_config_hash,state FROM source_snapshots WHERE run_id=? AND source_id=?`)
          .get(source.active_run_id, sourceId) as { snapshot_id: string; ingest_config_hash: string; state: string } | undefined;
        if (!snapshot || snapshot.state !== "active" || snapshot.snapshot_id !== source.active_snapshot_id
            || snapshot.ingest_config_hash !== source.active_ingest_config_hash) {
          throw new Error("tombstoned source active publication metadata is inconsistent");
        }
      } else if (source.active_snapshot_id !== null || source.active_ingest_config_hash !== null) {
        throw new Error("tombstoned source has partial active publication metadata");
      }
      const now = this.now();
      this.db.prepare(`INSERT INTO source_removals
        (source_id,run_id,snapshot_id,ingest_config_hash,state,created_at,updated_at)
        VALUES (?,?,?,?, 'retiring',?,?)`).run(
        sourceId, source.active_run_id, source.active_snapshot_id, source.active_ingest_config_hash, now, now,
      );
      if (source.active_run_id) {
        const chunks = this.db.prepare(`SELECT chunk.binding_id,chunk.concept_id,chunk.observation_id,chunk.source_ref,
            concept.kind AS concept_kind,concept.status AS concept_status,concept.source_identity,concept.active_observation_id,
            observation.concept_id AS observation_concept,observation.kind AS observation_kind,
            observation.source_refs AS observation_refs,observation.superseded_by,observation.superseded_at
          FROM source_chunks chunk
          LEFT JOIN concepts concept ON concept.id=chunk.concept_id
          LEFT JOIN observations observation ON observation.id=chunk.observation_id
          WHERE chunk.source_id=? AND chunk.run_id=? AND chunk.lifecycle='active' ORDER BY chunk.binding_id`).all(sourceId, source.active_run_id) as Array<{
            binding_id: string; concept_id: string | null; observation_id: string | null; source_ref: string;
            concept_kind: string | null; concept_status: string | null; source_identity: string | null; active_observation_id: string | null;
            observation_concept: string | null; observation_kind: string | null; observation_refs: string | null;
            superseded_by: string | null; superseded_at: number | null;
          }>;
        for (const chunk of chunks) {
          if (!chunk.concept_id || !chunk.observation_id) throw new Error("active source binding lacks exact engine evidence");
          const refs = parseStringArray(chunk.observation_refs, "source removal observation refs");
          if (chunk.concept_kind !== "source" || chunk.concept_status !== "active"
              || chunk.source_identity !== `source://${sourceId}` || chunk.active_observation_id !== chunk.observation_id
              || chunk.observation_concept !== chunk.concept_id || chunk.observation_kind !== "source"
              || refs.length !== 1 || refs[0] !== chunk.source_ref || !chunk.source_ref.startsWith(`source://${sourceId}/`)
              || chunk.superseded_by !== null || chunk.superseded_at !== null) {
            throw new Error("active source binding does not exactly own its published engine evidence");
          }
          this.db.prepare(`INSERT INTO source_removal_items
            (id,source_id,run_id,binding_id,concept_id,observation_id) VALUES (?,?,?,?,?,?)`).run(
            this.idGen(), sourceId, source.active_run_id, chunk.binding_id, chunk.concept_id, chunk.observation_id,
          );
        }
      }
      return this.getRemoval(sourceId)!;
    })();
  }

  getRemoval(sourceId: string): SourceRemoval | null {
    const row = this.db.prepare(`SELECT * FROM source_removals WHERE source_id=?`).get(sourceId) as Record<string, unknown> | undefined;
    return row ? this.removalRow(row) : null;
  }

  listRemovalItems(sourceId: string): SourceRemovalItem[] {
    return (this.db.prepare(`SELECT * FROM source_removal_items WHERE source_id=? ORDER BY id`).all(sourceId) as Array<Record<string, unknown>>)
      .map((row) => this.removalItemRow(row));
  }

  acknowledgeRemovalItem(itemId: string): SourceRemovalItem {
    return this.db.immediateTransaction(() => {
      const item = this.db.prepare(`SELECT item.*,removal.state AS removal_state,source.lifecycle,
          chunk.source_id AS chunk_source,chunk.run_id AS chunk_run,chunk.binding_id AS chunk_binding,
          chunk.concept_id AS chunk_concept,chunk.observation_id AS chunk_observation,chunk.lifecycle AS chunk_lifecycle
        FROM source_removal_items item
        JOIN source_removals removal ON removal.source_id=item.source_id
        JOIN knowledge_sources source ON source.id=item.source_id
        JOIN source_chunks chunk ON chunk.run_id=item.run_id AND chunk.binding_id=item.binding_id
        WHERE item.id=?`).get(itemId) as Record<string, unknown> | undefined;
      if (!item) throw new Error("source removal item not found or has no exact published binding");
      if (item.lifecycle !== "tombstoned" || item.removal_state !== "retiring") throw new Error("source removal authorization is not active");
      if (item.acknowledged_at === null) {
        if (item.chunk_source !== item.source_id || item.chunk_run !== item.run_id || item.chunk_binding !== item.binding_id
            || item.chunk_concept !== item.concept_id || item.chunk_observation !== item.observation_id
            || item.chunk_lifecycle !== "active") throw new Error("source removal binding authorization is stale");
        const observation = this.db.prepare(`SELECT concept_id,superseded_by,superseded_at FROM observations WHERE id=?`)
          .get(item.observation_id) as { concept_id: string | null; superseded_by: string | null; superseded_at: number | null } | undefined;
        const concept = this.db.prepare(`SELECT kind,status,active_observation_id,source_identity FROM concepts WHERE id=?`)
          .get(item.concept_id) as { kind: string; status: string; active_observation_id: string | null; source_identity: string | null } | undefined;
        if (!observation || observation.concept_id !== item.concept_id || observation.superseded_by !== null || observation.superseded_at === null
            || !concept || concept.kind !== "source" || concept.status !== "retired" || concept.active_observation_id !== null
            || concept.source_identity !== `source://${item.source_id}`) {
          throw new Error("source removal evidence is not terminally retired");
        }
        const now = this.now();
        this.db.prepare(`UPDATE source_chunks SET lifecycle='deleted' WHERE run_id=? AND binding_id=? AND lifecycle='active'`)
          .run(item.run_id, item.binding_id);
        this.db.prepare(`UPDATE source_removal_items SET acknowledged_at=? WHERE id=?`).run(now, itemId);
        this.db.prepare(`UPDATE source_removals SET updated_at=? WHERE source_id=?`).run(now, item.source_id);
      }
      return this.removalItemRow(this.db.prepare(`SELECT * FROM source_removal_items WHERE id=?`).get(itemId) as Record<string, unknown>);
    })();
  }

  markRemovalFilesRevoked(sourceId: string): SourceRemoval {
    return this.db.immediateTransaction(() => {
      const removal = this.getRemoval(sourceId);
      if (!removal) throw new Error("source removal has not begun");
      if (removal.state === "complete" || removal.state === "files-revoked") return removal;
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM source_removal_items WHERE source_id=? AND acknowledged_at IS NULL`)
        .get(sourceId) as { count: number };
      if (pending.count !== 0) throw new Error("source removal still has active evidence");
      this.db.prepare(`UPDATE source_removals SET state='files-revoked',updated_at=? WHERE source_id=?`).run(this.now(), sourceId);
      return this.getRemoval(sourceId)!;
    })();
  }

  completeRemoval(sourceId: string): SourceRemoval {
    return this.db.immediateTransaction(() => {
      const removal = this.getRemoval(sourceId);
      if (!removal) throw new Error("source removal has not begun");
      if (removal.state === "complete") {
        this.db.prepare(`DELETE FROM source_verification_checks WHERE source_id=?`).run(sourceId);
        this.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(sourceId);
        this.db.prepare(`DELETE FROM source_attempt_events WHERE source_id=?`).run(sourceId);
        return removal;
      }
      if (removal.state !== "files-revoked") throw new Error("source removal files have not been revoked");
      const source = this.db.prepare(`SELECT lifecycle FROM knowledge_sources WHERE id=?`).get(sourceId) as { lifecycle: string } | undefined;
      if (!source || source.lifecycle !== "tombstoned") throw new Error("source removal lineage is no longer tombstoned");
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM source_removal_items WHERE source_id=? AND acknowledged_at IS NULL`)
        .get(sourceId) as { count: number };
      if (pending.count !== 0) throw new Error("source removal still has active evidence");
      const now = this.now();
      if (removal.runId) {
        this.db.prepare(`UPDATE source_snapshots SET state='superseded',superseded_at=? WHERE run_id=? AND state='active'`)
          .run(now, removal.runId);
      }
      this.db.prepare(`UPDATE knowledge_sources SET active_run_id=NULL,active_snapshot_id=NULL,
        active_ingest_config_hash=NULL,applied_config_version=NULL,updated_at=? WHERE id=? AND lifecycle='tombstoned'`).run(now, sourceId);
      this.db.prepare(`UPDATE source_removals SET state='complete',updated_at=?,completed_at=? WHERE source_id=?`).run(now, now, sourceId);
      this.db.prepare(`DELETE FROM source_verification_checks WHERE source_id=?`).run(sourceId);
      this.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(sourceId);
      this.db.prepare(`DELETE FROM source_attempt_events WHERE source_id=?`).run(sourceId);
      return this.getRemoval(sourceId)!;
    })();
  }

  listFiles(runOrOptions: string | { runId: string; published?: boolean }, published = false): SourceFileRecord[] {
    const runId = typeof runOrOptions === "string" ? runOrOptions : runOrOptions.runId;
    const usePublished = typeof runOrOptions === "string" ? published : (runOrOptions.published ?? false);
    const run = this.requireRun(runId);
    const table = usePublished ? "source_files" : "source_staged_files";
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE run_id=? ORDER BY relative_path`).all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ sourceId: run.sourceId, runId, snapshotId: run.snapshotId, configVersion: run.configVersion, relativePath: row.relative_path as string, type: "file", contentHash: row.content_hash as string, byteLength: row.byte_length as number }));
  }

  listChunks(runOrOptions: string | { runId: string; published?: boolean }, published = false): SourceChunkRecord[] {
    const runId = typeof runOrOptions === "string" ? runOrOptions : runOrOptions.runId;
    const usePublished = typeof runOrOptions === "string" ? published : (runOrOptions.published ?? false);
    const run = this.requireRun(runId);
    const table = usePublished ? "source_chunks" : "source_staged_chunks";
    return (this.db.prepare(`SELECT * FROM ${table} WHERE run_id=? ORDER BY relative_path,heading_path_json,occurrence,segment_index`).all(runId) as Array<Record<string, unknown>>)
      .map((row) => this.stagedChunkToRecord(run, row));
  }

  listCleanupItems(runId: string): SourceCleanupItem[] {
    return (this.db.prepare(`SELECT * FROM source_cleanup_items WHERE run_id=? ORDER BY id`).all(runId) as Array<Record<string, unknown>>).map((row) => this.cleanupRow(row));
  }

  nextBindingGeneration(sourceId: string, bindingId: string): number {
    requireString(sourceId, "sourceId");
    requireString(bindingId, "bindingId");
    const source = this.db.prepare(`SELECT id FROM knowledge_sources WHERE id=? AND lifecycle='active'`).get(sourceId);
    if (!source) throw new Error("source not found or tombstoned");
    return this.maxBindingGeneration(sourceId, bindingId) + 1;
  }

  private maxBindingGeneration(sourceId: string, bindingId: string, excludeRunId?: string): number {
    const row = this.db.prepare(`SELECT MAX(binding_generation) AS value FROM (
      SELECT binding_generation FROM source_chunks WHERE source_id=? AND binding_id=?
      UNION ALL
      SELECT staged.binding_generation FROM source_staged_chunks staged
      JOIN source_sync_runs run ON run.id=staged.run_id
      WHERE run.source_id=? AND staged.binding_id=? AND (? IS NULL OR run.id<>?)
    )`).get(sourceId, bindingId, sourceId, bindingId, excludeRunId ?? null, excludeRunId ?? null) as { value: number | null };
    return row.value ?? 0;
  }

  private requireRun(runId: string): SourceSyncRun {
    const run = this.getRun(requireString(runId, "runId"));
    if (!run) throw new Error("source sync run not found");
    return run;
  }

  private assertFence(run: SourceSyncRun): void {
    const source = this.db.prepare(`SELECT lifecycle,config_version,lease_fence FROM knowledge_sources WHERE id=?`).get(run.sourceId) as { lifecycle: string; config_version: number; lease_fence: number } | undefined;
    if (!source || source.lifecycle !== "active" || source.config_version !== run.configVersion || source.lease_fence !== run.leaseFence) {
      throw new Error("source run fence is stale");
    }
  }

  private validateEngineReceipt(
    run: SourceSyncRun,
    staged: Record<string, unknown>,
    receipt: { concept: unknown; observation: unknown; predecessor: unknown },
    writeState: "engine-written" | "committed",
  ): void {
    const operation = this.validateDurableEngineReceipt(run, staged);
    if (!operation) throw new Error("binding receipt has no matching durable engine operation");
    if (operation.conceptId !== receipt.concept || operation.observationId !== receipt.observation ||
        operation.predecessorObservationId !== receipt.predecessor) {
      throw new Error("binding receipt does not match its source-domain engine operation and predecessor");
    }
    if (writeState === "committed" && operation.activeObservationId !== receipt.observation) {
      throw new Error("committed binding receipt is not the engine concept's active observation");
    }
  }

  /** Final in-transaction proof immediately before publication copies staged rows. */
  private revalidateReceiptsForPublication(run: SourceSyncRun): void {
    const stagedRows = this.db.prepare(`SELECT * FROM source_staged_chunks WHERE run_id=? ORDER BY binding_id`).all(run.id) as Array<Record<string, unknown>>;
    for (const staged of stagedRows) {
      if (staged.write_state === "committed") {
        this.validateEngineReceipt(run, staged, {
          concept: staged.concept_id,
          observation: staged.observation_id,
          predecessor: staged.predecessor_observation_id,
        }, "committed");
        continue;
      }
      if (staged.write_state !== "skipped") throw new Error("publication contains a non-final binding receipt");
      const current = this.db.prepare(
        `SELECT source.circle AS source_circle,old.concept_id,old.observation_id,old.predecessor_observation_id,
                old.relative_path,old.heading_path_json,old.occurrence,old.segment_index,old.content_hash,
                old.ingest_fingerprint,old.metadata_json,old.source_ref,old.content,
                concept.kind AS concept_kind,concept.status AS concept_status,concept.circle AS concept_circle,
                concept.source_identity,concept.active_observation_id,
                observation.kind AS observation_kind,observation.circle AS observation_circle,
                observation.content AS observation_content,observation.source_refs,
                observation.superseded_by,observation.superseded_at
           FROM knowledge_sources source
           JOIN source_chunks old ON old.run_id=source.active_run_id AND old.binding_id=? AND old.lifecycle='active'
           JOIN concepts concept ON concept.id=old.concept_id
           JOIN observations observation ON observation.id=old.observation_id AND observation.concept_id=old.concept_id
          WHERE source.id=?`,
      ).get(staged.binding_id, run.sourceId) as Record<string, unknown> | undefined;
      if (!current || current.concept_id !== staged.concept_id || current.observation_id !== staged.observation_id
          || current.predecessor_observation_id !== staged.predecessor_observation_id
          || current.relative_path !== staged.relative_path || current.heading_path_json !== staged.heading_path_json
          || current.occurrence !== staged.occurrence || current.segment_index !== staged.segment_index
          || current.content_hash !== staged.content_hash || current.ingest_fingerprint !== staged.ingest_fingerprint
          || current.metadata_json !== staged.metadata_json || current.source_ref !== staged.source_ref
          || current.content !== staged.content || current.concept_kind !== "source" || current.concept_status !== "active"
          || current.source_identity !== `source://${run.sourceId}` || current.active_observation_id !== staged.observation_id
          || current.concept_circle !== current.source_circle || current.observation_circle !== current.source_circle
          || current.observation_kind !== "source" || current.observation_content !== staged.content
          || current.superseded_by !== null || current.superseded_at !== null) {
        throw new Error("skipped binding receipt is no longer the current active source projection");
      }
      const refs = parseStringArray(current.source_refs, "source observation refs");
      if (refs.length !== 1 || refs[0] !== staged.source_ref) {
        throw new Error("skipped binding receipt provenance is no longer current");
      }
    }
  }

  private readRawSourceOperation(run: SourceSyncRun, staged: Record<string, unknown>): RawSourceOperation | null {
    const operation = this.db.prepare(`SELECT concept_id,observation_id,writer_domain,source_concept_id,action
      FROM ingest_operations WHERE operation_id=?`).get(staged.operation_id) as {
        concept_id: string; observation_id: string; writer_domain: string; source_concept_id: string | null; action: string;
      } | undefined;
    if (!operation) return null;
    if (operation.writer_domain !== "source" || operation.source_concept_id !== operation.concept_id ||
        !operation.concept_id || !operation.observation_id) {
      throw new Error("durable engine operation is not a valid source-domain receipt");
    }
    const prior = this.db.prepare(`SELECT observation_id FROM source_chunks
      WHERE source_id=? AND binding_id=? AND lifecycle='active'`).get(run.sourceId, staged.binding_id) as
      { observation_id: string | null } | undefined;
    return {
      conceptId: operation.concept_id,
      observationId: operation.observation_id,
      predecessorObservationId: prior?.observation_id ?? null,
      action: operation.action,
    };
  }

  private classifyOperationOwnership(run: SourceSyncRun, staged: Record<string, unknown>, raw: RawSourceOperation): OperationOwnership {
    const concept = this.db.prepare(`SELECT source_identity FROM concepts WHERE id=?`).get(raw.conceptId) as
      { source_identity: string | null } | undefined;
    const owners = this.db.prepare(`SELECT source_id,binding_id FROM source_chunks
      WHERE lifecycle='active' AND (concept_id=? OR observation_id=?)`).all(raw.conceptId, raw.observationId) as
      Array<{ source_id: string; binding_id: string }>;
    const expectedAuthority = `source://${run.sourceId}`;
    const authorityMatches = sourceIdentityAuthority(concept?.source_identity) === expectedAuthority;
    const ownersMatch = owners.every((owner) => owner.source_id === run.sourceId && owner.binding_id === staged.binding_id);
    return { authorized: authorityMatches && ownersMatch, hasActiveOwner: owners.length > 0 };
  }

  private validateDurableEngineReceipt(run: SourceSyncRun, staged: Record<string, unknown>): DurableSourceReceipt | null {
    const raw = this.readRawSourceOperation(run, staged);
    if (!raw) return null;
    const ownership = this.classifyOperationOwnership(run, staged, raw);
    if (!ownership.authorized) throw new Error("durable engine receipt ownership conflicts with another source or binding");
    if (!ownership.hasActiveOwner && raw.action !== "created") {
      throw new Error("a new binding must use an unowned newly created source concept and observation");
    }
    const operation = this.db.prepare(`SELECT source.circle AS source_circle,
        concept.kind AS concept_kind,concept.status AS concept_status,concept.source_identity,concept.active_observation_id,concept.circle AS concept_circle,
        observation.kind AS observation_kind,observation.source_refs,observation.superseded_by,observation.superseded_at,
        observation.content AS observation_content,observation.circle AS observation_circle
      FROM knowledge_sources source
      LEFT JOIN concepts concept ON concept.id=?
      LEFT JOIN observations observation ON observation.id=? AND observation.concept_id=?
      WHERE source.id=?`).get(raw.conceptId, raw.observationId, raw.conceptId, run.sourceId) as {
        source_circle: string;
        concept_kind: string | null; concept_status: string | null; source_identity: string | null; active_observation_id: string | null; concept_circle: string | null;
        observation_kind: string | null; source_refs: string | null; superseded_by: string | null; superseded_at: number | null;
        observation_content: string | null; observation_circle: string | null;
      } | undefined;
    if (!operation) throw new Error("durable engine receipt has no registry source");
    if (operation.concept_kind !== "source" || operation.concept_status !== "active" ||
        operation.source_identity !== `source://${run.sourceId}`) {
      throw new Error("durable engine receipt concept does not belong to this active source");
    }
    const refs = parseStringArray(operation.source_refs, "source observation refs");
    if (operation.observation_kind !== "source" || operation.superseded_by !== null || operation.superseded_at !== null ||
        refs.length !== 1 || refs[0] !== staged.source_ref) {
      throw new Error("durable engine receipt observation is stale or has mismatched provenance");
    }
    if (operation.observation_content !== staged.content) {
      throw new Error("durable engine receipt observation content does not match the staged normalized content");
    }
    if (operation.concept_circle !== operation.source_circle || operation.observation_circle !== operation.source_circle) {
      throw new Error("durable engine receipt circle does not match the registry source circle");
    }
    const prior = this.db.prepare(`SELECT concept_id,observation_id FROM source_chunks
      WHERE source_id=? AND binding_id=? AND lifecycle='active'`).get(run.sourceId, staged.binding_id) as
      { concept_id: string | null; observation_id: string | null } | undefined;
    if (prior) {
      if (!prior.concept_id || !prior.observation_id || prior.concept_id !== raw.conceptId || prior.observation_id === raw.observationId) {
        throw new Error("durable engine receipt does not advance its exact active predecessor");
      }
    }
    return {
      ...raw,
      activeObservationId: operation.active_observation_id,
    };
  }

  private ensureOrphanCleanup(run: SourceSyncRun, at = this.now()): void {
    const stagedRows = this.db.prepare(`SELECT * FROM source_staged_chunks WHERE run_id=?`).all(run.id) as Array<{
      binding_id: string; operation_id: string; source_ref: string; content: string; write_state: string;
      concept_id: string | null; observation_id: string | null; predecessor_observation_id: string | null;
    }>;
    for (const staged of stagedRows) {
      if (staged.write_state === "skipped") continue;
      const existing = this.db.prepare(`SELECT id FROM source_cleanup_items WHERE run_id=? AND binding_id=?`).get(run.id, staged.binding_id);
      if (existing) continue;
      const durable = this.readRawSourceOperation(run, staged as unknown as Record<string, unknown>);
      if (!durable) {
        if (staged.write_state === "intent") continue;
        throw new Error("written receipt is missing its durable engine operation");
      }
      if (staged.write_state !== "intent" &&
          (staged.concept_id !== durable.conceptId || staged.observation_id !== durable.observationId ||
           staged.predecessor_observation_id !== durable.predecessorObservationId)) {
        throw new Error("written receipt conflicts with its durable engine operation");
      }
      const ownership = this.classifyOperationOwnership(run, staged as unknown as Record<string, unknown>, durable);
      const cleanupKind = ownership.authorized ? "reconcile-orphan" : "quarantine-non-authorizing";
      const activeSource = this.db.prepare(`SELECT active_run_id FROM knowledge_sources WHERE id=?`).get(run.sourceId) as
        | { active_run_id: string | null }
        | undefined;
      const targetRunId = cleanupKind === "reconcile-orphan" && durable.predecessorObservationId !== null
        ? activeSource?.active_run_id
        : run.id;
      if (!targetRunId) throw new Error("authorized update orphan has no active predecessor run");
      this.db.prepare(`INSERT INTO source_cleanup_items
        (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,predecessor_observation_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,binding_id) DO NOTHING`).run(
        this.idGen(), run.sourceId, run.id, targetRunId, cleanupKind, staged.binding_id, staged.operation_id, durable.conceptId,
        durable.observationId, durable.predecessorObservationId, at,
      );
    }
  }

  private validateBindingProof(run: SourceSyncRun, chunk: SourceManifestChunkInput): void {
    const expectedGeneration = this.maxBindingGeneration(run.sourceId, chunk.bindingId, run.id) + 1;
    if (chunk.bindingGeneration !== expectedGeneration) {
      throw new Error(`chunk.bindingGeneration must be ${expectedGeneration} for this binding`);
    }
    const priorBinding = this.db.prepare(`SELECT run_id,relative_path,heading_path_json,occurrence,segment_index FROM source_chunks
      WHERE source_id=? AND lifecycle='active' AND binding_id=?`).all(run.sourceId, chunk.bindingId) as Array<{
      run_id: string; relative_path: string; heading_path_json: string; occurrence: number; segment_index: number;
    }>;
    if (priorBinding.length > 1) throw new Error("bindingIdHint is ambiguous across active bindings");
    const exact = this.db.prepare(`SELECT run_id,binding_id FROM source_chunks
      WHERE source_id=? AND lifecycle='active' AND relative_path=? AND heading_path_json=? AND occurrence=? AND segment_index=?`).all(
      run.sourceId, chunk.relativePath, JSON.stringify(chunk.headingPath), chunk.occurrence, chunk.segmentIndex,
    ) as Array<{ run_id: string; binding_id: string }>;
    if (exact.length > 1) throw new Error("natural chunk identity is ambiguous across active bindings");
    const prior = exact[0];
    if (prior && prior.binding_id !== chunk.bindingId) throw new Error("bindingId must remain stable for an exact natural chunk identity");
    if (prior) {
      if (chunk.bindingIdHint && (chunk.bindingIdHint.bindingId !== prior.binding_id || chunk.bindingIdHint.priorRunId !== prior.run_id)) {
        throw new Error("bindingIdHint does not prove the exact active binding");
      }
      return;
    }
    const moved = priorBinding[0];
    if (moved) {
      if (!chunk.bindingIdHint || chunk.bindingIdHint.bindingId !== chunk.bindingId || chunk.bindingIdHint.priorRunId !== moved.run_id) {
        throw new Error("changed natural identity requires a bindingIdHint for the one prior active binding");
      }
    } else if (chunk.bindingIdHint) {
      throw new Error("bindingIdHint does not identify a prior active binding");
    }
  }

  private requireChunkMetadata(value: unknown): SourceChunkMetadata {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("chunk.metadata must be an object");
    const metadata = value as Partial<SourceChunkMetadata> & Record<string, unknown>;
    if (Object.keys(metadata).some((key) => !["tags", "scope", "frontmatter"].includes(key))) {
      throw new Error("chunk.metadata contains an unknown field");
    }
    if (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== "string")) {
      throw new Error("chunk.metadata.tags must be a string array");
    }
    if (metadata.scope !== null && typeof metadata.scope !== "string") {
      throw new Error("chunk.metadata.scope must be a string or null");
    }
    if (!metadata.frontmatter || typeof metadata.frontmatter !== "object" || Array.isArray(metadata.frontmatter) ||
        Object.values(metadata.frontmatter).some((entry) => typeof entry !== "string")) {
      throw new Error("chunk.metadata.frontmatter must contain only string values");
    }
    const canonical = canonicalizeSourceChunkMetadata({
      tags: metadata.tags,
      scope: metadata.scope,
      frontmatter: metadata.frontmatter as Record<string, string>,
    });
    if (canonicalJson(value) !== canonicalJson(canonical)) throw new Error("chunk.metadata must be canonical");
    return canonical;
  }

  private requireCanonicalSourceRef(run: SourceSyncRun, chunk: SourceManifestChunkInput): void {
    const encodedPath = chunk.relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const encodedAnchor = encodeURIComponent(sourceHeadingAnchor(chunk.headingPath));
    const prefix = `source://${run.sourceId}/${encodedPath}#${encodedAnchor}~`;
    if (!chunk.sourceRef.startsWith(prefix)) throw new Error("chunk.sourceRef must match its source authority, path, and heading slug");
    const occurrence = chunk.sourceRef.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(occurrence) || !Number.isSafeInteger(Number(occurrence))) {
      throw new Error("chunk.sourceRef must end in a positive safe occurrence");
    }
  }

  private validateManifest(run: SourceSyncRun, files: SourceManifestFileInput[], chunks: SourceManifestChunkInput[]): void {
    if (!Array.isArray(files) || !Array.isArray(chunks)) throw new Error("manifest files and chunks must be arrays");
    if (files.length > run.effectiveConfig.limits.maxFiles) throw new Error("manifest exceeds the run maxFiles limit");
    if (chunks.length > run.effectiveConfig.limits.maxChunks) throw new Error("manifest exceeds the run maxChunks limit");
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      requireSourceRelativePath(file.relativePath, "file.relativePath"); requireString(file.contentHash, "file.contentHash");
      if (file.type !== "file") throw new Error("manifest file type must be file");
      requireInteger(file.byteLength, "file.byteLength");
      if (file.byteLength > run.effectiveConfig.limits.maxFileBytes) throw new Error("manifest file exceeds the run maxFileBytes limit");
      totalBytes += file.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > run.effectiveConfig.limits.maxTotalBytes) {
        throw new Error("manifest exceeds the run maxTotalBytes limit");
      }
      if (paths.has(file.relativePath)) throw new Error("manifest contains a duplicate file path");
      paths.add(file.relativePath);
    }
    const bindings = new Set<string>(); const operations = new Set<string>(); const identities = new Set<string>();
    const headingIdentities = new Map<string, { relativePath: string; headingPath: string[]; occurrence: number }>();
    for (const chunk of chunks) {
      for (const [field, value] of [["bindingId", chunk.bindingId], ["operationId", chunk.operationId], ["contentHash", chunk.contentHash], ["ingestFingerprint", chunk.ingestFingerprint], ["sourceRef", chunk.sourceRef]] as const) requireString(value, `chunk.${field}`);
      requireSourceRelativePath(chunk.relativePath, "chunk.relativePath");
      if (!Array.isArray(chunk.headingPath) || chunk.headingPath.some((part) => typeof part !== "string")) throw new Error("chunk.headingPath must be a string array");
      requireInteger(chunk.bindingGeneration, "chunk.bindingGeneration", 1);
      requireInteger(chunk.occurrence, "chunk.occurrence", 1); requireInteger(chunk.segmentIndex, "chunk.segmentIndex", 1);
      if (typeof chunk.content !== "string") throw new Error("chunk.content must be a string");
      if (Buffer.byteLength(chunk.content, "utf8") > run.effectiveConfig.limits.maxChunkBytes) {
        throw new Error("chunk.content exceeds the run maxChunkBytes limit");
      }
      if (!paths.has(chunk.relativePath)) throw new Error("every chunk relativePath must identify a staged file");
      const metadata = this.requireChunkMetadata(chunk.metadata);
      if (chunk.contentHash !== computeSourceContentHash(Buffer.from(chunk.content, "utf8"))) {
        throw new Error("chunk.contentHash does not match chunk.content");
      }
      const expectedFingerprint = computeSourceIngestFingerprint({
        contentHash: chunk.contentHash,
        headingPath: chunk.headingPath,
        metadata,
        ingestConfigHash: run.ingestConfigHash,
      });
      if (chunk.ingestFingerprint !== expectedFingerprint) {
        throw new Error("chunk.ingestFingerprint does not match chunk content, heading, metadata, and ingest config");
      }
      this.requireCanonicalSourceRef(run, chunk);
      if (chunk.operationId !== computeSourceOperationId(run.sourceId, chunk.bindingId, chunk.ingestFingerprint, run.snapshotId, chunk.bindingGeneration)) {
        throw new Error("chunk.operationId does not match the source binding fingerprint, snapshot, and generation");
      }
      if (chunk.bindingIdHint) {
        requireString(chunk.bindingIdHint.bindingId, "chunk.bindingIdHint.bindingId");
        requireString(chunk.bindingIdHint.priorRunId, "chunk.bindingIdHint.priorRunId");
        if (chunk.bindingIdHint.bindingId !== chunk.bindingId) throw new Error("bindingIdHint.bindingId must equal chunk.bindingId");
      }
      const identity = canonicalJson([chunk.relativePath, chunk.headingPath, chunk.occurrence, chunk.segmentIndex]);
      if (bindings.has(chunk.bindingId) || operations.has(chunk.operationId) || identities.has(identity)) throw new Error("manifest contains a duplicate chunk identity");
      const headingIdentity = { relativePath: chunk.relativePath, headingPath: chunk.headingPath, occurrence: chunk.occurrence };
      headingIdentities.set(sourceHeadingIdentityKey(headingIdentity), headingIdentity);
      bindings.add(chunk.bindingId); operations.add(chunk.operationId); identities.add(identity);
    }
    const expectedRefOccurrences = computeSourceRefOccurrences([...headingIdentities.values()]);
    for (const chunk of chunks) {
      const expectedOccurrence = expectedRefOccurrences.get(sourceHeadingIdentityKey(chunk))!;
      const separator = chunk.sourceRef.lastIndexOf("~");
      if (Number(chunk.sourceRef.slice(separator + 1)) !== expectedOccurrence) {
        throw new Error("chunk.sourceRef occurrence does not match its canonical heading identity");
      }
    }
  }

  private readStagedManifest(runId: string, scanStatus: "complete" | "partial", manifestHash: string): unknown {
    const files = this.listFiles(runId).map(({ sourceId: _s, runId: _r, snapshotId: _n, configVersion: _c, ...file }) => file);
    const chunks = this.listChunks(runId).map(({ sourceId: _s, runId: _r, snapshotId: _n, configVersion: _c, conceptId: _ci, observationId: _oi, predecessorObservationId: _pi, writeState: _w, lifecycle: _l, ...chunk }) => chunk);
    return this.manifestShape(scanStatus, manifestHash, files, chunks);
  }

  private manifestShape(scanStatus: "complete" | "partial", manifestHash: string, files: SourceManifestFileInput[], chunks: SourceManifestChunkInput[]): unknown {
    return {
      scanStatus,
      manifestHash,
      files: [...files].sort((a, b) => compareUtf8(a.relativePath, b.relativePath)),
      chunks: chunks.map(({ bindingIdHint: _hint, ...chunk }) => chunk).sort((a, b) => compareUtf8(
        canonicalJson([a.relativePath, a.headingPath, a.occurrence, a.segmentIndex]),
        canonicalJson([b.relativePath, b.headingPath, b.occurrence, b.segmentIndex]),
      )),
    };
  }

  private stagedChunkToRecord(run: SourceSyncRun, row: Record<string, unknown>): SourceChunkRecord {
    return {
      sourceId: run.sourceId, runId: run.id, snapshotId: run.snapshotId, configVersion: run.configVersion,
      bindingId: row.binding_id as string, bindingGeneration: row.binding_generation as number,
      operationId: row.operation_id as string, relativePath: row.relative_path as string,
      headingPath: JSON.parse(row.heading_path_json as string), occurrence: row.occurrence as number, segmentIndex: row.segment_index as number,
      contentHash: row.content_hash as string, ingestFingerprint: row.ingest_fingerprint as string,
      metadata: JSON.parse(row.metadata_json as string) as SourceChunkMetadata, sourceRef: row.source_ref as string,
      content: row.content as string, conceptId: (row.concept_id as string | null) ?? null, observationId: (row.observation_id as string | null) ?? null,
      predecessorObservationId: (row.predecessor_observation_id as string | null) ?? null,
      writeState: (row.write_state as SourceChunkRecord["writeState"]) ?? "intent",
      lifecycle: (row.lifecycle as SourceChunkRecord["lifecycle"]) ?? null,
    };
  }

  private cleanupRow(row: Record<string, unknown>): SourceCleanupItem {
    return { id: row.id as string, sourceId: row.source_id as string, runId: row.run_id as string,
      kind: row.kind as SourceCleanupItem["kind"], bindingId: row.binding_id as string,
      operationId: (row.operation_id as string | null) ?? null,
      conceptId: (row.concept_id as string | null) ?? null, observationId: (row.observation_id as string | null) ?? null,
      predecessorObservationId: (row.predecessor_observation_id as string | null) ?? null,
      createdAt: row.created_at as number, acknowledgedAt: (row.acknowledged_at as number | null) ?? null };
  }

  private removalRow(row: Record<string, unknown>): SourceRemoval {
    return {
      sourceId: row.source_id as string, runId: (row.run_id as string | null) ?? null,
      snapshotId: (row.snapshot_id as string | null) ?? null,
      ingestConfigHash: (row.ingest_config_hash as string | null) ?? null,
      state: row.state as SourceRemoval["state"], createdAt: row.created_at as number,
      updatedAt: row.updated_at as number, completedAt: (row.completed_at as number | null) ?? null,
    };
  }

  private removalItemRow(row: Record<string, unknown>): SourceRemovalItem {
    return {
      id: row.id as string, sourceId: row.source_id as string, runId: row.run_id as string,
      bindingId: row.binding_id as string, conceptId: row.concept_id as string,
      observationId: row.observation_id as string, acknowledgedAt: (row.acknowledged_at as number | null) ?? null,
    };
  }
}

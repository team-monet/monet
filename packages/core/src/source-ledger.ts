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
  SourceSyncRun,
  SourceSyncRunResult,
  StageSourceManifestInput,
} from "./source-types";

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

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a nonempty string`);
  return value;
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

  constructor(private readonly db: StoragePort, options: SourceLedgerOptions = {}) {
    this.idGen = options.idGen ?? randomUUID;
    this.now = options.now ?? Date.now;
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
      CREATE UNIQUE INDEX IF NOT EXISTS uq_source_sync_runs_live
        ON source_sync_runs(source_id) WHERE state IN ('scanning','staging','activating','cleaning');
      CREATE INDEX IF NOT EXISTS idx_source_sync_runs_source_created ON source_sync_runs(source_id, created_at, id);

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
    `);
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
    })();
  }

  beginRun(input: BeginSourceRunInput): BeginSourceRunResult {
    return this.db.immediateTransaction((): BeginSourceRunResult => {
      const sourceId = requireString(input.sourceId, "sourceId");
      const snapshotId = requireString(input.snapshotId, "snapshotId");
      const source = this.db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(sourceId) as SourceRow | undefined;
      if (!source || source.lifecycle !== "active") throw new Error("source not found or tombstoned");
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
      const run = this.requireRun(runId);
      if (run.state === "aborted") {
        if (run.result !== result || run.reason !== (reason ?? null)) throw new Error("abort conflicts with the recorded result");
        this.ensureOrphanCleanup(run);
        return run;
      }
      if (!(["scanning", "staging", "activating"] as string[]).includes(run.state)) throw new Error(`cannot abort while run is ${run.state}`);
      if (result === "partial" && run.complete) throw new Error("partial result requires a partial manifest/run");
      const now = this.now();
      this.ensureOrphanCleanup(run, now);
      this.db.prepare(`UPDATE source_sync_runs SET state='aborted',result=?,reason=?,updated_at=?,finished_at=? WHERE id=?`).run(result, reason ?? null, now, now, run.id);
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

  resumeRun(sourceId: string): SourceSyncRun | null {
    const row = this.db.prepare(`SELECT * FROM source_sync_runs run WHERE source_id=? AND (
      state IN ('scanning','staging','activating','cleaning') OR
      (state='aborted' AND EXISTS (SELECT 1 FROM source_cleanup_items item WHERE item.run_id=run.id
        AND item.kind IN ('reconcile-orphan','quarantine-non-authorizing') AND item.acknowledged_at IS NULL))
    ) ORDER BY created_at DESC,id DESC LIMIT 1`).get(sourceId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
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
}

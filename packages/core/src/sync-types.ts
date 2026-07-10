/**
 * Sync types for multi-machine delta export/import (slice 1a).
 *
 * Row types mirror the actual SQLite column names of each table — verified against the
 * CREATE TABLE statements in engine.ts. Columns added via ALTER TABLE (migration path)
 * are marked nullable (? | null) since old rows may carry NULL before backfill.
 *
 * The payload carries all evidence-layer tables; the receiving engine grafts them in via
 * graftRows(), then batchDedup() closes cross-machine possible_duplicate_of links.
 */

// ---- per-table row types (column names match the DB schema exactly) --------

export interface SyncConceptRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  kind: string;
  status: string;
  confidence: number;
  version: number;
  circle: string;
  embedding: string; // JSON float array
  support_count: number;
  dirty: number;
  updated_at: number;
  created_at: number;
  usefulness_score: number;
  usefulness_last_fetched_at: number | null;
  arousal_score: number;
  arousal_last_updated_at: number | null;
  source_refs: string | null; // JSON string[]
  aliases: string | null; // JSON string[]
  last_confirmed_at: number | null;
  last_confirmed_session_id: string | null;
}

export interface SyncObservationRow {
  id: string;
  content: string;
  embedding: string; // JSON float array
  kind: string;
  circle: string;
  concept_id: string | null;
  superseded_by: string | null;
  /** Null means current; non-null records both successor and terminal (successor=null) supersession. */
  superseded_at: number | null;
  session_id: string | null;
  author_agent_id: string;
  source_refs: string | null; // JSON string[]
  created_at: number;
}

export interface SyncRevisionRow {
  id: string;
  concept_id: string;
  version: number;
  body: string;
  trigger_observation_id: string | null;
  created_at: number;
}

export interface SyncContradictionRow {
  id: string;
  concept_id: string;
  observation_id: string | null;
  kind: string;
  status: string;
  detail: string;
  resolution_obs_id: string | null;
  detected_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export interface SyncEdgeRow {
  id: string;
  src_id: string;
  src_type: string;
  dst_id: string;
  dst_type: string;
  type: string;
  weight: number;
  origin: string;
  count: number;
  created_at: number;
  last_reinforced_at: number;
  scope: string;
  dismissed_at: number | null;
  dismissed_by: string | null;
}

export interface SyncFirstBlockRow {
  id: string;
  concept_id: string;
  circle: string;
  summary: string;
  summary_dirty: number;
  position: number;
  promoted_at: number;
  promoted_by: string | null;
}

export interface SyncCircleAliasRow {
  from_name: string;
  to_name: string;
  status: string;
  created_at: number;
}

export interface SyncEntityRow {
  key: string;
  kind: string;
  surface: string;
  scope: string;
  df: number;
}

export interface SyncConceptEntityRow {
  concept_id: string;
  entity_key: string;
  scope: string;
}

export interface SyncSessionRow {
  id: string;
  agent_id: string;
  scope_context: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  summary: string | null;
}

/** Content-free lifecycle event: a replica must hide this concept and reject stale re-ingest. */
export interface SyncConceptTombstoneRow {
  concept_id: string;
  retired_at: number;
}

/** Later lifecycle event that un-tombstones a concept without erasing the retirement record. */
export interface SyncConceptRestorationRow {
  concept_id: string;
  restored_at: number;
}

// ---- the payload and result -----------------------------------------------

export interface GraftPayload {
  /** Unix ms when the export was created on the source machine. */
  exportedAt: number;
  /** Watermark: only rows modified after this epoch ms are included (0 = full export). */
  since: number;
  /** Stable identifier for the source machine/agent. */
  deviceId: string;
  /** The embedding model id of the exporting engine — must match the receiving engine or graft is rejected. */
  embedderModelId: string;
  observations: SyncObservationRow[];
  concepts: SyncConceptRow[];
  conceptRevisions: SyncRevisionRow[];
  contradictions: SyncContradictionRow[];
  edges: SyncEdgeRow[];
  firstBlock: SyncFirstBlockRow[];
  circleAliases: SyncCircleAliasRow[];
  entities: SyncEntityRow[];
  conceptEntities: SyncConceptEntityRow[];
  tombstones: SyncConceptTombstoneRow[];
  restorations: SyncConceptRestorationRow[];
  sessions?: SyncSessionRow[];
}

export interface GraftResult {
  /** Per-table count of rows that were newly inserted. */
  inserted: Record<string, number>;
  /** Per-table count of rows that already existed and were skipped or merged. */
  skipped: Record<string, number>;
  /** Concept ids that gained at least one new observation and were marked dirty=1 for re-synthesis. */
  conceptsMarkedDirty: string[];
}

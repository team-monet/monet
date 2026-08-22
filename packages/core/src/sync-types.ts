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
  /** Connector ownership markers. Generic sync accepts only rows where both are null/absent. */
  aliases: string | null; // JSON string[]
  /** Where a skeleton member delivers. Absent on payloads from before global skeleton breadth. */
  skeleton_breadth?: "local" | "global";
  last_confirmed_at: number | null;
  last_confirmed_session_id: string | null;
  /** v8 row-convergence clock. Missing on legacy payloads. */
  sync_revision?: number;
  /** Stable per-store writer id used to break equal-revision ties. */
  sync_writer?: string | null;
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
  /** v8 mutable binding/supersession state clock. */
  sync_revision?: number;
  sync_writer?: string | null;
  updated_at?: number;
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
  /** The observation the correction contradicted, as named by the resolver — non-null
   * resolution_obs_id (accept-new) means this observation lost; null (keep-current) means it won.
   * Always paired with a real, predating correcting observation. Added via ALTER TABLE —
   * absent/null on rows from before that migration. */
  contradicted_observation_id?: string | null;
  detected_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  updated_at?: number;
  sync_revision?: number;
  sync_writer?: string | null;
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
  /** v8 unprovenanced pre-component count retained for backward-compatible migration. */
  legacy_count?: number;
  /** v8 relay watermark for mutable aggregate state such as dismissal. */
  sync_updated_at?: number;
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
  updated_at?: number;
  sync_revision?: number;
  sync_writer?: string | null;
  deleted_at?: number | null;
}

export interface SyncCircleAliasRow {
  from_name: string;
  to_name: string;
  status: string;
  created_at: number;
  updated_at?: number;
  sync_revision?: number;
  sync_writer?: string | null;
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
  updated_at?: number;
  sync_revision?: number;
  sync_writer?: string | null;
}

/** v8 grow-only per-writer contribution to one materialized memory_edge row. */
export interface SyncEdgeComponentRow {
  src_id: string;
  dst_id: string;
  type: string;
  scope: string;
  writer_id: string;
  count: number;
  weight: number;
  origin: string;
  created_at: number;
  last_reinforced_at: number;
  revision: number;
  updated_at: number;
}

/** Durable hard deletion; unlike retirement, this concept id can never be restored by sync. */
export interface SyncConceptDeletionRow {
  concept_id: string;
  deleted_at: number;
  updated_at: number;
  /** Stable writer domain that authored the deletion. Required by v8 generic sync. */
  writer_id: string;
  /** Authority provenance. Generic sync accepts only explicit native deletions. */
  concept_kind: "native";
}

/** Replay-safe per-writer activity contribution materialized onto a concept row. */
export interface SyncConceptActivityRow {
  concept_id: string;
  writer_id: string;
  usefulness_count: number;
  usefulness_last_at: number | null;
  arousal_count: number;
  arousal_last_at: number | null;
  revision: number;
  updated_at: number;
}

/** Content-free lifecycle event: a replica must hide this concept and reject stale re-ingest. */
export interface SyncConceptTombstoneRow {
  concept_id: string;
  retired_at: number;
  /** Relay watermark; distinct from the semantic lifecycle time. */
  updated_at?: number;
}

/** Later lifecycle event that un-tombstones a concept without erasing the retirement record. */
export interface SyncConceptRestorationRow {
  concept_id: string;
  restored_at: number;
  /** Relay watermark; distinct from the semantic lifecycle time. */
  updated_at?: number;
}

/**
 * A normative relation (derivation / provenance / supersession). Unlike `resolution_events`, which
 * is deliberately local-only because it logs one device's embedder decisions, this is substrate
 * truth: a machine that failed to receive it would disagree about what governs.
 */
export interface SyncLifecycleEdgeRow {
  id: string;
  family: string;
  src_concept_id: string;
  dst_concept_id: string | null;
  dst_span: string | null;
  born_of: string;
  event_ref: string | null;
  circle: string;
  created_at: number;
  sync_updated_at: number;
  /** Convergence clock for `circle`, the sole mutable column (a circle rename rewrites it). */
  sync_revision?: number;
  sync_writer?: string | null;
}

/** A human ratification verdict over a concept, with the evidence packet it was ruled on. */
export interface SyncRatificationRow {
  id: string;
  subject_concept_id: string;
  verdict: string;
  packet: string | null;
  /**
   * Added by ALTER (monet-core#142), so nullable per this file's own header rule: rows written
   * before the column existed carry NULL, and NULL is never backfilled — it means "how this entered
   * was never recorded", which is the truthful answer for those rows.
   */
  entrance?: string | null;
  /** JSON BatteryVerdict[]; same ALTER, same nullability reasoning. */
  battery?: string | null;
  ratified_by: string | null;
  circle: string;
  created_at: number;
  sync_updated_at: number;
  sync_revision?: number;
  sync_writer?: string | null;
}

/**
 * A stage — the named address a corrected action creates. STORE-GLOBAL and therefore circle-less:
 * `git push --force` is the same action in every project, so the registry replicates whole while
 * the RULES bound to it stay in their own circles.
 *
 * A PRE-2026-08-22 PEER STILL SENDS `verified`, and that is fine: the field went with the
 * mechanical matcher that was the only thing able to set it, the graft's INSERT names its columns
 * explicitly, and an extra property on the wire is simply not read. Nothing rejects it and nothing
 * needs it.
 */
export interface SyncStageRow {
  id: string;
  name: string;
  trigger_patterns: string; // JSON array of {tool, tokens}
  origin: string;
  created_at: number;
  sync_updated_at: number;
  /** Convergence clock for the mutable columns (trigger_patterns, origin). */
  sync_revision?: number;
  sync_writer?: string | null;
}

/** A rule's address: which stage it fires at, how hard, and for whom. */
export interface SyncRuleBindingRow {
  concept_id: string;
  stage_id: string;
  severity: string;
  scope: string;
  model_tag: string | null;
  origin: string;
  declared_by: string | null;
  reason: string | null;
  /**
   * OPTIONAL, not version-gated: absent means a pre-breadth peer's payload, and the receiver
   * defaults it to the binding's own concept's circle (the same value it would have carried, had
   * the field existed, since breadth ("*") could not have been declared before this shipped
   * anywhere). Present and equal to the breadth marker means the sender is relaying a legitimately
   * global rule VERBATIM — relay is not a second way to mint breadth (the receiver's own
   * declaration-origin check still applies), but a peer that already holds one must not lose it on
   * sync. See gates.ts's BREADTH_CIRCLE and RuleBindingRow.circle for the full story.
   */
  circle?: string;
  created_at: number;
  sync_updated_at: number;
  sync_revision?: number;
  sync_writer?: string | null;
}

// ---- the payload and result -----------------------------------------------

export interface GraftPayload {
  /** Payload protocol version. Absent means the legacy v7 aggregate-row protocol. */
  schemaVersion?: number;
  /** Unix ms when the export was created on the source machine. */
  exportedAt: number;
  /** Inclusive watermark: rows modified at or after this epoch ms are included (0 = full export). */
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
  /** v8 multi-writer edge contributions; aggregate `edges` remains for legacy consumers. */
  edgeComponents?: SyncEdgeComponentRow[];
  /** v8 hard-deletion events. */
  deletions?: SyncConceptDeletionRow[];
  /** v8 commutative activity inputs. */
  conceptActivity?: SyncConceptActivityRow[];
  /** Legacy protocol field. Schema-12 receivers convert eligible rows to observations without reviving pins. */
  firstBlock?: SyncFirstBlockRow[];
  circleAliases: SyncCircleAliasRow[];
  entities: SyncEntityRow[];
  conceptEntities: SyncConceptEntityRow[];
  tombstones: SyncConceptTombstoneRow[];
  restorations: SyncConceptRestorationRow[];
  sessions?: SyncSessionRow[];
  /** Normative substrate. Optional: a payload from before this slice simply carries none. */
  lifecycleEdges?: SyncLifecycleEdgeRow[];
  ratifications?: SyncRatificationRow[];
  /** Gate substrate. The governed-moment tables — `governed_moments`, `moment_reads`,
   *  `moment_runs`, `moment_losses`, `moment_fold_cursor` — are deliberately absent, like
   *  `resolution_events`: replicating a local action stream would merge two machines' timelines
   *  under one clock and make every rate computed from it a lie. Their per-run sequence is scoped
   *  to one process on one machine, so a merged stream could not even be checked for completeness. */
  stages?: SyncStageRow[];
  ruleBindings?: SyncRuleBindingRow[];
}

export interface GraftResult {
  /** Per-table count of rows that were newly inserted. */
  inserted: Record<string, number>;
  /** Count of legacy rows converted into their retired-surface replacement. */
  converted: Record<string, number>;
  /** Per-table count of rows that already existed and were skipped or merged. */
  skipped: Record<string, number>;
  /** Active native endpoint ids whose winning observation binding changed and were marked dirty. */
  conceptsMarkedDirty: string[];
}

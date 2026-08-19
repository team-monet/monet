/**
 * Schema 12 → 13: the source subsystem's retirement (#16).
 *
 * The destructive half lives HERE rather than in the engine's constructor migrations, and the
 * split is the whole point. A connector-owned row is a materialized copy of a file outside the
 * store; with the connector gone nothing can read it, re-sync it, or repair it, so retirement
 * means deleting it. But deleting a user's rows is not something an ordinary `new MonetCore(path)`
 * may do behind their back, and a verified backup is asynchronous while the constructor is not.
 *
 * So the work is cut in two:
 *
 *   - `dropRetiredSourceResidue` — non-destructive. Drops the subsystem's own (empty) tables and
 *     the two marker columns. Safe from the constructor: nothing a query could still ask for is
 *     lost, because there are no rows left to describe.
 *   - `purgeConnectorPopulation` — destructive. Deletes the rows and everything keyed to them.
 *     The CALLER owns the backup; `monet retire-source` takes a verified one first.
 *
 * A store that still holds a connector population therefore refuses to open until that command
 * has run. Refusing is the honest failure: the alternative is either destroying rows silently or
 * serving them as ordinary memories now that every native query has stopped excluding them.
 */
import type { StoragePort } from "./storage";

/** Every table the retired source subsystem owned. Dropped whole; none is read any more. */
export const RETIRED_SOURCE_TABLES = [
  "source_attempt_events", "source_chunks", "source_cleanup_items", "source_files",
  "source_pre_pin_attempts", "source_recompute_pending", "source_removal_items", "source_removals",
  "source_scheduler_lease", "source_skipped_files", "source_snapshots", "source_staged_chunks",
  "source_staged_files", "source_sync_runs", "source_verification_checks", "knowledge_sources",
] as const;

const RETIRED_SOURCE_COLUMNS = ["source_identity", "active_observation_id"] as const;

export interface ConnectorPopulation {
  conceptIds: string[];
  observationIds: string[];
}

/** Thrown when a store cannot be served because its connector rows have not been disposed of yet. */
export class SourceRetirementRequiredError extends Error {
  constructor(
    readonly dbPath: string,
    readonly population: { concepts: number; observations: number },
  ) {
    super(
      `this store still holds ${population.concepts} connector-owned concept(s) and ` +
        `${population.observations} observation(s) from the source subsystem, retired in #16. ` +
        `They are a materialized copy of files outside the store, and no surface in this build can ` +
        `read, re-sync, or repair them — but removing them is irreversible, so this build will not ` +
        `do it implicitly. Run \`monet retire-source --apply --yes\` (it takes a verified backup ` +
        `first), or stay on a 1.6.x build if you still need that content.`,
    );
    this.name = "SourceRetirementRequiredError";
  }
}

function conceptColumns(db: StoragePort): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

/**
 * The rows the retired subsystem owned. A store old enough to predate the marker columns can only
 * carry them as `kind='source'`, which is why the predicate is assembled rather than fixed.
 */
export function connectorPopulation(db: StoragePort): ConnectorPopulation {
  const columns = conceptColumns(db);
  const marker = RETIRED_SOURCE_COLUMNS.every((column) => columns.has(column))
    ? `kind = 'source' OR source_identity IS NOT NULL OR active_observation_id IS NOT NULL`
    : `kind = 'source'`;
  const conceptIds = (db.prepare(`SELECT id FROM concepts WHERE ${marker}`).all() as Array<{ id: string }>)
    .map((row) => row.id);
  const observationIds = (db.prepare(
    `SELECT id FROM observations
      WHERE kind = 'source' OR concept_id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(conceptIds)) as Array<{ id: string }>).map((row) => row.id);
  return { conceptIds, observationIds };
}

/**
 * Drop the subsystem's own tables and marker columns. Non-destructive by construction: it is only
 * ever correct once `connectorPopulation` is empty, and every surviving row has NULL in both
 * columns because the rows that could hold a value are exactly the ones that had to go first.
 */
export function dropRetiredSourceResidue(db: StoragePort): void {
  const columns = conceptColumns(db);
  for (const table of RETIRED_SOURCE_TABLES) {
    if ((db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length > 0) {
      db.exec(`DROP TABLE ${table}`);
    }
  }
  for (const column of RETIRED_SOURCE_COLUMNS) {
    if (columns.has(column)) db.exec(`ALTER TABLE concepts DROP COLUMN ${column}`);
  }
}

/**
 * Delete the connector population and everything keyed to it, in one transaction.
 *
 * THE CALLER OWNS THE BACKUP. This function does not take one and cannot: a verified backup is
 * asynchronous, and this runs inside a synchronous transaction so the store cannot be mutated
 * between the count and the delete.
 */
export function purgeConnectorPopulation(db: StoragePort): { concepts: number; observations: number } {
  return db.immediateTransaction((): { concepts: number; observations: number } => {
    const { conceptIds, observationIds } = connectorPopulation(db);
    if (conceptIds.length === 0 && observationIds.length === 0) return { concepts: 0, observations: 0 };

    const c = JSON.stringify(conceptIds);
    const o = JSON.stringify(observationIds);
    const inSet = `IN (SELECT value FROM json_each(?))`;
    // Entity rows are counted BEFORE their memberships go, so the df recount below sees the exact
    // set that lost a member; reversing the order loses the list of what to recount.
    const affectedEntities = db.prepare(
      `SELECT DISTINCT entity_key AS key, scope FROM concept_entities WHERE concept_id ${inSet}`,
    ).all(c) as Array<{ key: string; scope: string }>;

    for (const [sql, params] of [
      [`DELETE FROM observation_tokens WHERE observation_id ${inSet}`, [o]],
      [`DELETE FROM observation_segments WHERE observation_id ${inSet}`, [o]],
      [`DELETE FROM contradictions WHERE concept_id ${inSet} OR observation_id ${inSet}`, [c, o]],
      [`DELETE FROM ingest_operations WHERE concept_id ${inSet} OR observation_id ${inSet}`, [c, o]],
      [`DELETE FROM concept_revisions WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM concept_tombstones WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM concept_restorations WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM concept_deletions WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM concept_activity_components WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM concept_entities WHERE concept_id ${inSet}`, [c]],
      [`DELETE FROM memory_edge_components WHERE src_id ${inSet} OR dst_id ${inSet}`, [c, c]],
      [`DELETE FROM memory_edge WHERE src_id ${inSet} OR dst_id ${inSet}`, [c, c]],
      [`DELETE FROM lifecycle_edges WHERE src_concept_id ${inSet} OR dst_concept_id ${inSet}`, [c, c]],
      [`DELETE FROM ratifications WHERE subject_concept_id ${inSet}`, [c]],
      [`DELETE FROM resolution_events WHERE observation_id ${inSet} OR nominated_concept_id ${inSet}
          OR matched_observation_id ${inSet}`, [o, c, o]],
      [`UPDATE observations SET superseded_by = NULL WHERE superseded_by ${inSet}`, [o]],
      [`DELETE FROM observations WHERE id ${inSet}`, [o]],
      [`DELETE FROM concepts WHERE id ${inSet}`, [c]],
    ] as Array<[string, string[]]>) {
      db.prepare(sql).run(...params);
    }

    for (const entity of affectedEntities) {
      db.prepare(
        `UPDATE entities SET df = (
           SELECT COUNT(*) FROM concept_entities ce JOIN concepts cc ON cc.id = ce.concept_id
            WHERE ce.entity_key = ? AND ce.scope = ? AND cc.kind != 'workstream' AND cc.status != 'retired'
         ) WHERE key = ? AND scope = ?`,
      ).run(entity.key, entity.scope, entity.key, entity.scope);
      db.prepare(`DELETE FROM entities WHERE key = ? AND scope = ? AND df <= 0`)
        .run(entity.key, entity.scope);
    }
    return { concepts: conceptIds.length, observations: observationIds.length };
  })();
}

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

/**
 * The subsystem's tables as the code that created them named them. Kept for tests and for the
 * documentation value — but NOT what the runtime enumerates, because a hand-maintained list is
 * exactly what goes stale: the ledger also produced `*_legacy` and `*_rebuild` tables by RENAME
 * during its own interrupted migrations, and a list built by reading CREATE statements missed
 * every one of them. `discoverRetiredTables` finds those too.
 */
export const RETIRED_SOURCE_TABLES = [
  "source_attempt_events", "source_chunks", "source_cleanup_items", "source_files",
  "source_pre_pin_attempts", "source_recompute_pending", "source_removal_items", "source_removals",
  "source_scheduler_lease", "source_skipped_files", "source_snapshots", "source_staged_chunks",
  "source_staged_files", "source_sync_runs", "source_verification_checks", "knowledge_sources",
] as const;

/**
 * Every retired table actually present, found by name rather than recited from a list.
 *
 * The `source_` prefix is unambiguous: no native table in this schema uses it (verified against
 * every CREATE TABLE in the engine, gates and lifecycle-edges), and `knowledge_sources` is the one
 * retired table that does not carry the prefix. Discovering rather than listing is what makes an
 * interrupted-migration leftover — `source_attempt_events_legacy` and its siblings — reachable by
 * the disposal path instead of stranded past schema 13 with no command able to remove it.
 */
export function discoverRetiredTables(db: StoragePort): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name = 'knowledge_sources' OR name LIKE 'source\\_%' ESCAPE '\\')
      ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

const RETIRED_SOURCE_COLUMNS = ["source_identity", "active_observation_id"] as const;

export interface ConnectorPopulation {
  conceptIds: string[];
  observationIds: string[];
}

export interface RetirementData extends ConnectorPopulation {
  /** Retired tables that still hold rows — registry entries, ledger runs, attempt history. */
  nonemptyTables: string[];
  /**
   * Native concepts that own one of the doomed observations. Reported from the READ-ONLY reading
   * so a caller can tell, before deleting anything, whether disposal will owe a reprojection —
   * and therefore whether it needs the store's pinned embedder at all.
   */
  staleNativeOwners: string[];
}

function conceptColumns(db: StoragePort): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

/**
 * The contradictions cleanup, assembled from the pointer columns this store actually has.
 *
 * `resolution_obs_id` and `contradicted_observation_id` are additive — a store old enough to
 * predate them reaches the purge without them, and `monet retire-source` opens a raw port that
 * runs no migrations. Naming a column unconditionally would fail with `no such column` and roll
 * the whole purge back, which is the same class as the missing-table failure one rung up.
 */
function contradictionCleanup(db: StoragePort, conceptIds: string, observationIds: string): Array<[string, string[]]> {
  if (!tableExists(db, "contradictions")) return [];
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(contradictions)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const inSet = `IN (SELECT value FROM json_each(?))`;
  const clauses: string[] = [`concept_id ${inSet}`];
  const params: string[] = [conceptIds];
  for (const column of ["observation_id", "resolution_obs_id", "contradicted_observation_id"]) {
    if (!columns.has(column)) continue;
    clauses.push(`${column} ${inSet}`);
    params.push(observationIds);
  }
  return [[`DELETE FROM contradictions WHERE ${clauses.join(" OR ")}`, params]];
}

function tableExists(db: StoragePort, table: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length > 0;
}

/**
 * The rows the retired subsystem owned. A store old enough to predate the marker columns can only
 * carry them as `kind='source'`, which is why the predicate is assembled rather than fixed.
 */
export function connectorPopulation(db: StoragePort): ConnectorPopulation {
  // EVERY MARKER THAT IS ACTUALLY PRESENT, not all-or-nothing. The two columns were added by
  // separate ALTER statements, so an interrupted upgrade can leave exactly one — and requiring
  // both would fall back to `kind` alone, miss the rows the surviving column marks, and let the
  // residue drop remove that column and turn them into ordinary memories.
  const columns = conceptColumns(db);
  const marker = [
    `kind = 'source'`,
    ...RETIRED_SOURCE_COLUMNS.filter((column) => columns.has(column)).map((column) => `${column} IS NOT NULL`),
  ].join(" OR ");
  const conceptIds = (db.prepare(`SELECT id FROM concepts WHERE ${marker}`).all() as Array<{ id: string }>)
    .map((row) => row.id);
  // CONNECTOR EVIDENCE, NOT "EVERYTHING THAT CONCEPT OWNS". Retained rows are served as ordinary
  // memories after the upgrade, so a user can legitimately attach new native observations to one —
  // and taking the whole parent population would delete what they wrote themselves, months after
  // the connector that made the rest of it stopped existing. `kind` is what marks connector
  // evidence; ownership is not.
  const observationIds = (db.prepare(`SELECT id FROM observations WHERE kind = 'source'`).all() as Array<{ id: string }>)
    .map((row) => row.id);
  return { conceptIds, observationIds };
}

/**
 * Everything the retirement has to dispose of: the connector rows, and any retired table that
 * still holds data.
 *
 * THE TABLES ARE NOT AUTOMATICALLY RESIDUE. `monet source add` wrote a `knowledge_sources` row
 * before any sync succeeded, and a failed attempt could fill ledger tables without ever creating a
 * concept — so a zero concept/observation count does not mean there is nothing to lose. Counting
 * rows alone would report "nothing to retire", skip the backup, and let the next ordinary open
 * drop a registered source's configuration and attempt history for good.
 */
/** Native concepts owning one of these observations — the link identifying them dies with the delete. */
export function staleNativeOwnersOf(db: StoragePort, population: ConnectorPopulation): string[] {
  if (population.observationIds.length === 0) return [];
  const inSet = `IN (SELECT value FROM json_each(?))`;
  return (db.prepare(
    `SELECT DISTINCT o.concept_id AS id
       FROM observations o
       JOIN concepts c ON c.id = o.concept_id
      WHERE o.id ${inSet} AND c.id NOT ${inSet} AND c.kind != 'workstream'`,
  ).all(JSON.stringify(population.observationIds), JSON.stringify(population.conceptIds)) as Array<{ id: string }>)
    .map((row) => row.id);
}

export function retirementData(db: StoragePort): RetirementData {
  const population = connectorPopulation(db);
  const nonemptyTables = discoverRetiredTables(db).filter(
    (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n > 0,
  );
  return { ...population, nonemptyTables, staleNativeOwners: staleNativeOwnersOf(db, population) };
}

/** True when nothing is left to dispose of and the residue drop is safe to run unattended. */
export function isRetirementDisposed(data: RetirementData): boolean {
  return data.conceptIds.length === 0 && data.observationIds.length === 0 && data.nonemptyTables.length === 0;
}

/**
 * Drop the subsystem's own tables and marker columns. Non-destructive by construction: it is only
 * ever correct once `isRetirementDisposed` holds, so every table it drops is empty and every
 * surviving row has NULL in the columns it removes.
 */
export function dropRetiredSourceResidue(db: StoragePort): void {
  // ONE WRITE TRANSACTION, AND EACH OBJECT RE-CHECKED INSIDE IT. Concurrent first opens are a
  // supported topology (several `monet start` servers against one store), and a presence check
  // taken outside the write lock is stale by the time the drop runs: both processes see the table,
  // one drops it, the other fails with `no such table` and takes an ordinary open down with it.
  // The transaction serializes the two, and the re-read inside makes the loser a no-op rather than
  // an error. `IF EXISTS` alone would not cover the column half — SQLite has no such form for
  // ALTER TABLE ... DROP COLUMN.
  db.immediateTransaction((): void => {
    for (const table of discoverRetiredTables(db)) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    const columns = conceptColumns(db);
    for (const column of RETIRED_SOURCE_COLUMNS) {
      if (columns.has(column)) db.exec(`ALTER TABLE concepts DROP COLUMN ${column}`);
    }
  })();
}

/**
 * Delete the connector population and everything keyed to it, in one transaction.
 *
 * THE CALLER OWNS THE BACKUP. This function does not take one and cannot: a verified backup is
 * asynchronous, and this runs inside a synchronous transaction so the store cannot be mutated
 * between the count and the delete.
 */
export interface PurgeResult {
  concepts: number;
  observations: number;
  /**
   * Native concepts that OWNED one of the deleted observations, so their projection —
   * support_count, centroid, confidence, confirmation stamps — now describes evidence that is
   * gone. Grafting can legitimately produce this shape (see retrieval.ts's own note), so the purge
   * reports them rather than leaving a phantom or mis-ranked native memory behind. Reprojecting
   * them needs the engine's own helper, not a copy of it: see `MonetCore.repairNativeProjections`.
   */
  staleNativeOwners: string[];
}

export function purgeConnectorPopulation(db: StoragePort): PurgeResult {
  return db.immediateTransaction((): PurgeResult => {
    const { conceptIds, observationIds } = connectorPopulation(db);
    if (conceptIds.length === 0 && observationIds.length === 0) {
      return { concepts: 0, observations: 0, staleNativeOwners: [] };
    }

    const c = JSON.stringify(conceptIds);
    const o = JSON.stringify(observationIds);
    const inSet = `IN (SELECT value FROM json_each(?))`;
    // Entity rows are counted BEFORE their memberships go, so the df recount below sees the exact
    // set that lost a member; reversing the order loses the list of what to recount.
    // Read BEFORE the delete — afterwards the link that identifies them is gone.
    const staleNativeOwners = staleNativeOwnersOf(db, { conceptIds, observationIds });

    const affectedEntities = tableExists(db, "concept_entities")
      ? db.prepare(
          `SELECT DISTINCT entity_key AS key, scope FROM concept_entities WHERE concept_id ${inSet}`,
        ).all(c) as Array<{ key: string; scope: string }>
      : [];

    // TABLE-PRESENCE GUARDED, EVERY ONE. `monet retire-source` opens a raw port and never runs the
    // engine's migrations, so a store old enough to predate an additive table (observation_tokens
    // and observation_segments are the recent ones) reaches here without it. An unguarded DELETE
    // would raise `no such table`, roll the purge back, and leave the operator holding a fresh
    // backup and no way to finish the migration it was taken for.
    for (const [sql, params] of [
      [`DELETE FROM observation_tokens WHERE observation_id ${inSet}`, [o]],
      [`DELETE FROM observation_segments WHERE observation_id ${inSet}`, [o]],
      // ALL FOUR OBSERVATION POINTERS, not just `observation_id`. A resolved contradiction names
      // its losing evidence in `contradicted_observation_id` and its winning evidence in
      // `resolution_obs_id`; either can be a purged source observation while the row's own
      // `observation_id` is native, leaving an audit row that points at evidence no longer in the
      // store — and the reprojection below would keep counting it toward confidence.
      ...contradictionCleanup(db, c, o),
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
      // BOTH HALVES, as detach's own cleanup does (engine.ts). Liveness is `superseded_by IS NULL
      // AND superseded_at IS NULL` everywhere that reads it, so clearing only the pointer leaves
      // the native predecessor terminally hidden — superseded by nothing, yet never live — and its
      // concept can end up with no live evidence at all after the successor is purged.
      [`UPDATE observations SET superseded_by = NULL, superseded_at = NULL WHERE superseded_by ${inSet}`, [o]],
      [`DELETE FROM observations WHERE id ${inSet}`, [o]],
      // A concept the user has since written on SURVIVES, as an ordinary one — only the concepts
      // left with no evidence at all go.
      [`DELETE FROM concepts WHERE id ${inSet}
          AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.concept_id = concepts.id)`, [c]],
    ] as Array<[string, string[]]>) {
      const table = /(?:DELETE FROM|UPDATE) ([a-z_]+)/.exec(sql)?.[1];
      if (table && !tableExists(db, table)) continue;
      db.prepare(sql).run(...params);
    }

    if (!tableExists(db, "entities")) {
      return { concepts: conceptIds.length, observations: observationIds.length, staleNativeOwners };
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
    return { concepts: conceptIds.length, observations: observationIds.length, staleNativeOwners };
  })();
}

/** Shared live-vector inventory used by both engine enforcement and raw store diagnosis. */
export const MALFORMED_EMBEDDING_SAMPLE_LIMIT = 20;

export type EmbeddingPopulationName =
  | "nativeObservations"
  | "nativeConcepts"
  | "sourceObservations"
  | "sourceConcepts";

export interface MalformedEmbeddingPopulation {
  count: number;
  /** Deterministic, bounded diagnostic sample; `count` remains exact. */
  sampleIds: string[];
}

export interface MalformedEmbeddingInventory {
  nativeObservations: MalformedEmbeddingPopulation;
  nativeConcepts: MalformedEmbeddingPopulation;
  sourceObservations: MalformedEmbeddingPopulation;
  sourceConcepts: MalformedEmbeddingPopulation;
}

export interface EmbeddingWidthInventory {
  observationDims: number[];
  conceptDims: number[];
  sourceObservationDims: number[];
  sourceConceptDims: number[];
  malformed: MalformedEmbeddingInventory;
}

export interface LiveEmbeddingPopulationInspection {
  /** Every row selected by the canonical liveness predicate, including malformed rows. */
  liveRowCount: number;
  /** Finite vectors that participate in the shared scored space. */
  scoredVectorCount: number;
  /** Legacy all-zero source placeholders excluded from scoring and width enforcement. */
  ignoredZeroVectorCount: number;
  dimensions: number[];
  malformed: MalformedEmbeddingPopulation;
}

export type StoredEmbeddingPopulationInspection =
  | ({ status: "known" } & LiveEmbeddingPopulationInspection)
  | { status: "unknown"; reason: string };

export type StoredEmbeddingPopulations = Record<EmbeddingPopulationName, StoredEmbeddingPopulationInspection>;

interface StatementReader {
  all(...params: unknown[]): unknown[];
}

export interface EmbeddingStateReader {
  prepare(sql: string): StatementReader;
}

export interface StoredEmbeddingRow {
  id: string;
  embedding: unknown;
}

const LIVE_EMBEDDING_SQL: Record<EmbeddingPopulationName, string> = {
  // Keep these predicates byte-for-byte aligned with the merged #56 native/source ownership
  // boundary. The marker-only stale-kind connector P2 is intentionally deferred to its own slice.
  nativeObservations: `
    SELECT id, embedding
      FROM observations
     WHERE kind != 'source'
     ORDER BY id`,
  nativeConcepts: `
    SELECT id, embedding
      FROM concepts
     WHERE kind != 'source'
       AND embedding IS NOT NULL
     ORDER BY id`,
  sourceObservations: `
    SELECT o.id AS id, o.embedding AS embedding
      FROM observations o
     WHERE o.kind = 'source'
       AND (
         NOT EXISTS (SELECT 1 FROM source_chunks any_sc WHERE any_sc.observation_id = o.id)
         OR EXISTS (
           SELECT 1 FROM source_chunks live_sc
           LEFT JOIN concepts live_c ON live_c.id = live_sc.concept_id
            WHERE live_sc.observation_id = o.id AND live_sc.lifecycle = 'active'
              AND (live_c.id IS NULL OR live_c.status = 'active')
         )
       )
     ORDER BY o.id`,
  sourceConcepts: `
    SELECT id, embedding
      FROM concepts
     WHERE kind = 'source'
       AND status = 'active'
       AND embedding IS NOT NULL
     ORDER BY id`,
};

const SOURCE_POPULATIONS = new Set<EmbeddingPopulationName>(["sourceObservations", "sourceConcepts"]);

/** Strict persisted-vector parser shared by diagnosis, enforcement, and hostile payload validation. */
export function parseFiniteEmbeddingJson(value: unknown): Float32Array | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((element) => typeof element === "number" && Number.isFinite(element))) {
    return null;
  }
  const converted = Float32Array.from(parsed);
  if (converted.length !== parsed.length) return null;
  for (const element of converted) if (!Number.isFinite(element)) return null;
  return converted;
}

function isZeroVector(vector: Float32Array): boolean {
  for (const value of vector) if (value !== 0) return false;
  return true;
}

/** Read one canonical live population. Callers may preflight old/partial schemas before invoking. */
export function readLiveEmbeddingRows(
  db: EmbeddingStateReader,
  population: EmbeddingPopulationName,
): StoredEmbeddingRow[] {
  return db.prepare(LIVE_EMBEDDING_SQL[population]).all() as StoredEmbeddingRow[];
}

export function inspectStoredEmbeddingRows(
  rows: StoredEmbeddingRow[],
  excludeZero: boolean,
): LiveEmbeddingPopulationInspection {
  const dimensions = new Set<number>();
  const malformedIds: string[] = [];
  let scoredVectorCount = 0;
  let ignoredZeroVectorCount = 0;
  for (const row of rows) {
    const embedding = parseFiniteEmbeddingJson(row.embedding);
    if (embedding === null) {
      malformedIds.push(row.id);
      continue;
    }
    if (excludeZero && isZeroVector(embedding)) {
      ignoredZeroVectorCount++;
      continue;
    }
    scoredVectorCount++;
    dimensions.add(embedding.length);
  }
  malformedIds.sort();
  return {
    liveRowCount: rows.length,
    scoredVectorCount,
    ignoredZeroVectorCount,
    dimensions: [...dimensions].sort((a, b) => a - b),
    malformed: {
      count: malformedIds.length,
      sampleIds: malformedIds.slice(0, MALFORMED_EMBEDDING_SAMPLE_LIMIT),
    },
  };
}

export function inspectLiveEmbeddingPopulation(
  db: EmbeddingStateReader,
  population: EmbeddingPopulationName,
): LiveEmbeddingPopulationInspection {
  return inspectStoredEmbeddingRows(readLiveEmbeddingRows(db, population), SOURCE_POPULATIONS.has(population));
}

export function inspectLiveEmbeddingPopulations(
  db: EmbeddingStateReader,
): Record<EmbeddingPopulationName, LiveEmbeddingPopulationInspection> {
  return {
    nativeObservations: inspectLiveEmbeddingPopulation(db, "nativeObservations"),
    nativeConcepts: inspectLiveEmbeddingPopulation(db, "nativeConcepts"),
    sourceObservations: inspectLiveEmbeddingPopulation(db, "sourceObservations"),
    sourceConcepts: inspectLiveEmbeddingPopulation(db, "sourceConcepts"),
  };
}

export function toEmbeddingWidthInventory(
  populations: Record<EmbeddingPopulationName, LiveEmbeddingPopulationInspection>,
): EmbeddingWidthInventory {
  return {
    observationDims: populations.nativeObservations.dimensions,
    conceptDims: populations.nativeConcepts.dimensions,
    sourceObservationDims: populations.sourceObservations.dimensions,
    sourceConceptDims: populations.sourceConcepts.dimensions,
    malformed: {
      nativeObservations: populations.nativeObservations.malformed,
      nativeConcepts: populations.nativeConcepts.malformed,
      sourceObservations: populations.sourceObservations.malformed,
      sourceConcepts: populations.sourceConcepts.malformed,
    },
  };
}

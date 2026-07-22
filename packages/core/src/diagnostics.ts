import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  inspectLiveEmbeddingPopulation,
  type EmbeddingPopulationName,
  type StoredEmbeddingPopulationInspection,
  type StoredEmbeddingPopulations,
} from "./embedding-state";
import { parseHashingEmbedderPin } from "./embedding-onnx";
import { MONET_SCHEMA_VERSION } from "./schema-version";

export type StoredEmbedderDiagnosticFailureReason = "locked" | "not-sqlite" | "unreadable";

/** Existing store bytes could not be diagnosed safely through a read-only SQLite connection. */
export class StoredEmbedderStateDiagnosticError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly reason: StoredEmbedderDiagnosticFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoredEmbedderStateDiagnosticError";
  }
}

export type StoredDatabaseIntegrity =
  | { status: "ok"; check: "ok" }
  | { status: "failed"; check: string[] }
  | { status: "unknown"; reason: string };

export type StoredEmbedderPin =
  | {
      status: "known";
      modelId: string | null;
      source: string | null;
      pinnedAt: number | null;
    }
  | { status: "unknown"; reason: string };

export type StoredEmbedderMigration =
  | { status: "none" }
  | { status: "unknown"; reason: string }
  | {
      status: "active";
      targetModelId: string;
      startedAt: number;
      priorPin: {
        captured: boolean;
        modelId: string | null;
        source: string | null;
        pinnedAt: number | null;
      };
      rewriteProgress: "not-started" | "started-or-unknown";
      abandon: {
        classification: "safe" | "refused" | "unsupported" | "unknown";
        reason: string;
      };
    };

export type StoredEmbedderSafetyAssessment = "missing" | "safe" | "unsafe" | "unknown";

export interface StoredEmbedderStateInspection {
  dbPath: string;
  exists: boolean;
  schemaVersion: number | null;
  supportedSchemaVersion: number;
  integrity: StoredDatabaseIntegrity;
  pin: StoredEmbedderPin;
  populations: StoredEmbeddingPopulations;
  migration: StoredEmbedderMigration;
  assessment: StoredEmbedderSafetyAssessment;
}

type SchemaMap = Map<string, Set<string>>;

const POPULATION_SCHEMA: Record<EmbeddingPopulationName, Record<string, string[]>> = {
  nativeObservations: { observations: ["id", "kind", "embedding"] },
  nativeConcepts: { concepts: ["id", "kind", "embedding"] },
  sourceObservations: {
    observations: ["id", "kind", "embedding"],
    source_chunks: ["observation_id", "concept_id", "lifecycle"],
    concepts: ["id", "status"],
  },
  sourceConcepts: { concepts: ["id", "kind", "status", "embedding"] },
};

const POPULATION_NAMES: EmbeddingPopulationName[] = [
  "nativeObservations",
  "nativeConcepts",
  "sourceObservations",
  "sourceConcepts",
];

const PIN_SOURCES = new Set(["created", "backfilled", "migrated"]);

function unknownPopulations(reason: string): StoredEmbeddingPopulations {
  return {
    nativeObservations: { status: "unknown", reason },
    nativeConcepts: { status: "unknown", reason },
    sourceObservations: { status: "unknown", reason },
    sourceConcepts: { status: "unknown", reason },
  };
}

function readSchema(db: Database.Database): SchemaMap {
  const presentTables = new Set(db
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name));
  const schema: SchemaMap = new Map();
  // Fixed literals only: diagnosis never interpolates a possibly-hostile sqlite_schema identifier.
  for (const name of ["observations", "concepts", "source_chunks", "sync_meta", "embedder_migration"]) {
    if (!presentTables.has(name)) continue;
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    schema.set(name, new Set(columns.map((column) => column.name)));
  }
  return schema;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function missingSchemaReason(schema: SchemaMap, requirements: Record<string, string[]>): string | null {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(requirements)) {
    const present = schema.get(table);
    if (!present) {
      missing.push(`table ${table}`);
      continue;
    }
    for (const column of columns) if (!present.has(column)) missing.push(`column ${table}.${column}`);
  }
  return missing.length === 0 ? null : `schema does not prove this population's liveness (${missing.join(", ")})`;
}

function inspectPopulations(db: Database.Database, schema: SchemaMap): StoredEmbeddingPopulations {
  const result = {} as StoredEmbeddingPopulations;
  for (const population of POPULATION_NAMES) {
    const reason = missingSchemaReason(schema, POPULATION_SCHEMA[population]);
    result[population] = reason
      ? { status: "unknown", reason }
      : { status: "known", ...inspectLiveEmbeddingPopulation(db, population) };
  }
  return result;
}

function inspectPin(db: Database.Database, schema: SchemaMap): StoredEmbedderPin {
  const reason = missingSchemaReason(schema, {
    sync_meta: ["singleton", "embedder_model_id", "embedder_pin_source", "embedder_pinned_at"],
  });
  if (reason) return { status: "unknown", reason };
  const row = db
    .prepare(
      `SELECT embedder_model_id, embedder_pin_source, embedder_pinned_at
         FROM sync_meta
        WHERE singleton = 1`,
    )
    .get() as
    | { embedder_model_id: unknown; embedder_pin_source: unknown; embedder_pinned_at: unknown }
    | undefined;
  if (!row) return { status: "unknown", reason: "sync_meta singleton row is missing" };
  if (
    !(row.embedder_model_id === null || typeof row.embedder_model_id === "string") ||
    !(row.embedder_pin_source === null || typeof row.embedder_pin_source === "string") ||
    !(row.embedder_pinned_at === null || (typeof row.embedder_pinned_at === "number" && Number.isSafeInteger(row.embedder_pinned_at))) ||
    (typeof row.embedder_model_id === "string" &&
      (row.embedder_model_id.length === 0 || row.embedder_model_id !== row.embedder_model_id.trim())) ||
    (row.embedder_model_id === null && (row.embedder_pin_source !== null || row.embedder_pinned_at !== null)) ||
    (row.embedder_model_id !== null &&
      (!PIN_SOURCES.has(row.embedder_pin_source as string) || row.embedder_pinned_at === null))
  ) {
    return { status: "unknown", reason: "persisted embedder pin metadata is malformed" };
  }
  return {
    status: "known",
    modelId: row.embedder_model_id,
    source: row.embedder_pin_source,
    pinnedAt: row.embedder_pinned_at,
  };
}

function allKnownPopulations(
  populations: StoredEmbeddingPopulations,
): populations is Record<EmbeddingPopulationName, Extract<StoredEmbeddingPopulationInspection, { status: "known" }>> {
  return POPULATION_NAMES.every((name) => populations[name].status === "known");
}

function inspectMigration(
  db: Database.Database,
  schema: SchemaMap,
  populations: StoredEmbeddingPopulations,
): StoredEmbedderMigration {
  const reason = missingSchemaReason(schema, {
    embedder_migration: [
      "singleton",
      "target_model_id",
      "started_at",
      "prior_model_id",
      "prior_pin_source",
      "prior_pinned_at",
      "prior_pin_captured",
      "vectors_rewritten",
    ],
  });
  if (reason) return { status: "unknown", reason };
  const row = db.prepare(`SELECT * FROM embedder_migration WHERE singleton = 1`).get() as
    | Record<string, unknown>
    | undefined;
  if (!row) return { status: "none" };
  if (
    typeof row.target_model_id !== "string" || row.target_model_id.length === 0 || row.target_model_id !== row.target_model_id.trim() ||
    typeof row.started_at !== "number" || !Number.isSafeInteger(row.started_at) ||
    !(row.prior_model_id === null || typeof row.prior_model_id === "string") ||
    !(row.prior_pin_source === null || typeof row.prior_pin_source === "string") ||
    !(row.prior_pinned_at === null || (typeof row.prior_pinned_at === "number" && Number.isSafeInteger(row.prior_pinned_at))) ||
    !(row.prior_pin_captured === 0 || row.prior_pin_captured === 1) ||
    !(row.vectors_rewritten === 0 || row.vectors_rewritten === 1) ||
    (typeof row.prior_model_id === "string" &&
      (row.prior_model_id.length === 0 || row.prior_model_id !== row.prior_model_id.trim())) ||
    (row.prior_pin_source !== null && !PIN_SOURCES.has(row.prior_pin_source as string)) ||
    (row.prior_pin_captured === 0 &&
      (row.prior_model_id !== null || row.prior_pin_source !== null || row.prior_pinned_at !== null)) ||
    (row.prior_pin_captured === 1 && row.prior_model_id === null &&
      (row.prior_pin_source !== null || row.prior_pinned_at !== null)) ||
    (row.prior_pin_captured === 1 && row.prior_model_id !== null &&
      (row.prior_pin_source === null || row.prior_pinned_at === null))
  ) {
    return { status: "unknown", reason: "embedder migration sentinel metadata is malformed" };
  }

  let classification: "safe" | "refused" | "unsupported" | "unknown";
  let abandonReason: string;
  if (row.vectors_rewritten !== 0) {
    classification = "refused";
    abandonReason = "the durable sentinel says vector rewriting started or cannot be disproved";
  } else if (!allKnownPopulations(populations)) {
    classification = "unknown";
    abandonReason = "one or more live vector populations cannot be proven from this schema";
  } else {
    const widths = new Set(POPULATION_NAMES.flatMap((name) => populations[name].dimensions));
    if (widths.size > 1) {
      classification = "refused";
      abandonReason = "the live store contains more than one vector width";
    } else if (row.prior_pin_captured === 0) {
      classification = "unsupported";
      abandonReason = "the sentinel predates durable prior-pin capture";
    } else {
      classification = "safe";
      abandonReason = "no rewrite is recorded, live widths are consistent, and the exact prior pin was captured";
    }
  }

  return {
    status: "active",
    targetModelId: row.target_model_id,
    startedAt: row.started_at,
    priorPin: {
      captured: row.prior_pin_captured === 1,
      modelId: row.prior_model_id,
      source: row.prior_pin_source,
      pinnedAt: row.prior_pinned_at,
    },
    rewriteProgress: row.vectors_rewritten === 0 ? "not-started" : "started-or-unknown",
    abandon: { classification, reason: abandonReason },
  };
}

function assess(
  schemaVersion: number,
  integrity: StoredDatabaseIntegrity,
  pin: StoredEmbedderPin,
  populations: StoredEmbeddingPopulations,
  migration: StoredEmbedderMigration,
): StoredEmbedderSafetyAssessment {
  if (integrity.status === "failed") return "unsafe";
  if (migration.status === "active") return "unsafe";
  if (integrity.status !== "ok" || migration.status === "unknown" || !allKnownPopulations(populations)) return "unknown";
  const malformed = POPULATION_NAMES.some((name) => populations[name].malformed.count > 0);
  const widths = new Set(POPULATION_NAMES.flatMap((name) => populations[name].dimensions));
  if (malformed || widths.size > 1) return "unsafe";
  if (schemaVersion !== MONET_SCHEMA_VERSION || pin.status === "unknown") return "unknown";
  const storedVectorCount = POPULATION_NAMES.reduce((sum, name) => sum + populations[name].scoredVectorCount, 0);
  if (storedVectorCount > 0 && pin.modelId === null) return "unknown";
  if (storedVectorCount > 0 && pin.modelId !== null) {
    const hashingPin = parseHashingEmbedderPin(pin.modelId);
    // Only hashing pins encode a width that can be proven without loading the provider. An
    // arbitrary ONNX/model/path identity remains unknown here even if its stored vectors are
    // uniform; doctor must not call that combination compatible from shape alone.
    if (hashingPin === null) return "unknown";
    const storedWidth = [...widths][0];
    if (storedWidth !== hashingPin.dimension) return "unsafe";
  }
  return "safe";
}

function classifyFailure(dbPath: string, error: unknown): StoredEmbedderStateDiagnosticError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const reason: StoredEmbedderDiagnosticFailureReason =
    code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
      ? "locked"
      : code === "SQLITE_NOTADB"
        ? "not-sqlite"
        : "unreadable";
  const detail = error instanceof Error ? error.message : String(error);
  return new StoredEmbedderStateDiagnosticError(
    dbPath,
    reason,
    `Cannot inspect Monet store '${dbPath}' (${reason}): ${detail}`,
    { cause: error },
  );
}

/**
 * Inspect persisted embedder state without constructing MonetCore or issuing any write-capable
 * connection/schema pragma. Missing files are ordinary results; unreadable/non-SQLite/locked files
 * throw a typed failure so a CLI cannot accidentally report them as empty or healthy.
 */
export function inspectStoredEmbedderState(dbPath: string): StoredEmbedderStateInspection {
  const absolutePath = resolve(dbPath);
  if (!existsSync(absolutePath)) {
    const reason = "database does not exist";
    return {
      dbPath: absolutePath,
      exists: false,
      schemaVersion: null,
      supportedSchemaVersion: MONET_SCHEMA_VERSION,
      integrity: { status: "unknown", reason },
      pin: { status: "unknown", reason },
      populations: unknownPopulations(reason),
      migration: { status: "unknown", reason },
      assessment: "missing",
    };
  }

  const walExists = existsSync(`${absolutePath}-wal`);
  const shmExists = existsSync(`${absolutePath}-shm`);
  if (walExists !== shmExists) {
    throw new StoredEmbedderStateDiagnosticError(
      absolutePath,
      "unreadable",
      `Cannot inspect Monet store '${absolutePath}' without creating a missing WAL sidecar; ` +
        "the existing -wal/-shm pair is incomplete.",
    );
  }
  if (!walExists && existsSync(`${absolutePath}-journal`)) {
    throw new StoredEmbedderStateDiagnosticError(
      absolutePath,
      "locked",
      `Cannot inspect Monet store '${absolutePath}' while a rollback journal is active.`,
    );
  }

  // Opening a closed WAL-mode database directly causes SQLite to create fresh -wal/-shm files even
  // through a readonly handle. Diagnose an isolated byte-for-byte main-file copy in that shape so
  // source bytes and sidecar existence remain untouched. When a WAL+SHM pair already exists, the
  // real readonly connection is required to observe committed WAL frames and SQLite lock failures.
  let snapshotDir: string | undefined;
  let inspectionPath = absolutePath;
  if (!walExists) {
    try {
      snapshotDir = mkdtempSync(join(tmpdir(), "monet-readonly-diagnostic-"));
      inspectionPath = join(snapshotDir, basename(absolutePath));
      const beforeHash = hashFile(absolutePath);
      copyFileSync(absolutePath, inspectionPath);
      const afterHash = hashFile(absolutePath);
      const snapshotHash = hashFile(inspectionPath);
      if (
        beforeHash !== afterHash || afterHash !== snapshotHash ||
        existsSync(`${absolutePath}-journal`) || existsSync(`${absolutePath}-wal`) || existsSync(`${absolutePath}-shm`)
      ) {
        throw new StoredEmbedderStateDiagnosticError(
          absolutePath,
          "locked",
          `Cannot inspect Monet store '${absolutePath}': its bytes or journal state changed during the readonly snapshot.`,
        );
      }
    } catch (error) {
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
      if (error instanceof StoredEmbedderStateDiagnosticError) throw error;
      throw classifyFailure(absolutePath, error);
    }
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(inspectionPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    const checkRows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    const check = checkRows.map((row) => row.quick_check);
    const integrity: StoredDatabaseIntegrity = check.length === 1 && check[0] === "ok"
      ? { status: "ok", check: "ok" }
      : { status: "failed", check };
    const schema = readSchema(db);
    const populations = inspectPopulations(db, schema);
    const pin = inspectPin(db, schema);
    const migration = inspectMigration(db, schema, populations);
    return {
      dbPath: absolutePath,
      exists: true,
      schemaVersion,
      supportedSchemaVersion: MONET_SCHEMA_VERSION,
      integrity,
      pin,
      populations,
      migration,
      assessment: assess(schemaVersion, integrity, pin, populations, migration),
    };
  } catch (error) {
    if (error instanceof StoredEmbedderStateDiagnosticError) throw error;
    throw classifyFailure(absolutePath, error);
  } finally {
    db?.close();
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
  }
}

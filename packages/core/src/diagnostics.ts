import Database from "better-sqlite3";
import { nonLatinLetterShare, NON_LATIN_LETTER_TOLERANCE } from "./script-gate";
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
import type { LifecycleEdgeFamily } from "./lifecycle-edges";

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
  /** Live observations a Latin-only pin would strand. Reported whatever the CURRENT pin is. */
  nonLatin: StoredNonLatinContent;
  assessment: StoredEmbedderSafetyAssessment;
}

/**
 * WHY THIS IS REPORTED EVEN ON A MULTILINGUAL PIN.
 *
 * The count exists to be read BEFORE a move to a Latin-only checkpoint, which is exactly when the
 * current pin is still multilingual. Gating the count on the current pin would answer only after the
 * answer stopped mattering — the migration is one-way for content.
 *
 * Measured with engine's nonLatinLetterShare against NON_LATIN_LETTER_TOLERANCE, the same threshold
 * the write gate enforces, so this cannot clear a row the write path would refuse.
 */
export type StoredNonLatinContent =
  | {
      status: "known";
      tolerance: number;
      /** Observations the migration re-embeds — native (including superseded) and live source. */
      observationCount: number;
      /**
       * Concept BODIES it re-embeds. Counted separately because a body is derived from its
       * observations, so one piece of non-English content appears in both populations — summing
       * them would double-report it, and an operator reads these to size a rewrite, not to total it.
       */
      conceptCount: number;
      sampleIds: string[];
    }
  | { status: "unknown"; reason: string };

type SchemaMap = Map<string, Set<string>>;

const POPULATION_SCHEMA: Record<EmbeddingPopulationName, Record<string, string[]>> = {
  nativeObservations: { observations: ["id", "kind", "embedding"] },
  nativeConcepts: { concepts: ["id", "kind", "embedding"] },
};

const POPULATION_NAMES: EmbeddingPopulationName[] = [
  "nativeObservations",
  "nativeConcepts",
];

const PIN_SOURCES = new Set(["created", "backfilled", "migrated"]);

function unknownPopulations(reason: string): StoredEmbeddingPopulations {
  return {
    nativeObservations: { status: "unknown", reason },
    nativeConcepts: { status: "unknown", reason },
  };
}

/**
 * The narrow read capability the non-Latin scan needs — satisfied by both `StoragePort` and a raw
 * better-sqlite3 handle, exactly like `LifecycleEdgeReadDb` below.
 *
 * IT EXISTS SO THE SCAN CAN RUN ON A CONNECTION THAT ALREADY HOLDS THE STORE (#14). `repair`
 * re-reads this count after `createVerifiedBackup` has taken exclusive ownership, and any reader
 * that opens its own handle is excluded by the very lock that makes the re-read trustworthy. The
 * two requirements — read under ownership, and read at all — cannot both be met by a second
 * connection, so the scan has to be expressible against the owning one.
 */
export interface NonLatinReadDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * Rows held in memory at once by the non-Latin scan. Only the count and five sample ids outlive a
 * page, so this is the scan's whole memory ceiling; it is a paging bound, not a calibrated number.
 */
const NON_LATIN_SCAN_PAGE_ROWS = 500;

function readSchema(db: NonLatinReadDb): SchemaMap {
  const presentTables = new Set(db
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name));
  const schema: SchemaMap = new Map();
  // Fixed literals only: diagnosis never interpolates a possibly-hostile sqlite_schema identifier.
  for (const name of ["observations", "concepts", "sync_meta", "embedder_migration"]) {
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
/**
 * Count everything a migration would re-embed into a model that cannot read it.
 *
 * SCANS EXACTLY WHAT THE MIGRATION REWRITES, which is four populations, not one:
 *
 *   enforcedNativeObservationRows   every observation row, NO supersession filter
 *   enforcedSourceObservationRows   source rows whose chunks are live (or which have none)
 *   enforcedNativeConceptRows       every concept — its BODY is re-embedded,
 *                                   which is `SELECT * FROM concepts` and so
 *                                   takes workstream concepts along with ordinary ones
 *
 * A narrower scan reports zero while the rewrite strands content. Two of these were missed in
 * earlier rounds and each hid a distinct failure: source chunks feed scoreSourceConcepts against
 * live queries, and concept BODIES are written by applySynthesis, which accepts arbitrary text
 * WITHOUT the write path's script gate — so a store of English observations can hold a non-Latin
 * body, and migrateEmbeddings' reembedConcept phase then persists an unusable concept vector and
 * rebuilds `related` edges from it (Codex P1, PR #173).
 *
 * PAGED, not materialized. The diagnostic needs a count and five sample ids; one unbounded `.all()`
 * on a large source-backed store would hold every row's content in memory at once and could exhaust
 * it while producing the warning that was supposed to prevent a loss (Codex P2).
 *
 * The bound used to come from `.iterate()`, which only a raw better-sqlite3 handle offers — the
 * `Statement` a `StoragePort` returns has run/get/all and nothing else, and widening that interface
 * would reach every implementer including the test ports. Keyset pagination over the `id` primary
 * key holds the same memory ceiling using only `.all()`, which is what lets this scan run on a
 * connection that already owns the store (#14; see NonLatinReadDb).
 *
 * The predicates are duplicated here rather than imported because diagnostics reads a raw
 * better-sqlite3 handle on a possibly-unopenable store, before any MonetCore exists.
 */
function inspectNonLatin(db: NonLatinReadDb, schema: SchemaMap): StoredNonLatinContent {
  const observationColumns = schema.get("observations");
  if (!observationColumns || !observationColumns.has("content") || !observationColumns.has("id") || !observationColumns.has("kind")) {
    return { status: "unknown", reason: "observations table lacks id/kind/content" };
  }
  const conceptColumns = schema.get("concepts");
  if (!conceptColumns || !conceptColumns.has("body") || !conceptColumns.has("id") || !conceptColumns.has("kind")) {
    return { status: "unknown", reason: "concepts table lacks id/kind/body" };
  }
  try {
    // Each page carries `WHERE id > ?` so the cursor is the last id of the previous page. Fixed
    // literals only, exactly as in readSchema: nothing from the store is ever interpolated.
    const observationQueries = [
      `SELECT id, content AS text FROM observations WHERE id > ? ORDER BY id LIMIT ?`,
    ];
    // Concept bodies. applySynthesis writes these WITHOUT the script gate, so this is the one
    // population that can be non-English in a store whose every observation is English.
    const conceptQuery = `SELECT id, body AS text FROM concepts WHERE id > ? AND body IS NOT NULL ORDER BY id LIMIT ?`;

    /*
     * SAMPLES ARE PER-POPULATION, not first-come. A shared five-slot buffer filled in query order
     * means a store with five non-English OBSERVATIONS reports `conceptCount: 3` and hands the
     * operator no id for any body — which is precisely the invisibility this scan was widened to
     * fix, reproduced one level up. Bodies are the hard population to find by browsing, so each
     * gets its own quota and they are concatenated.
     */
    const scan = (sql: string, into: string[], quota: number): number => {
      const statement = db.prepare(sql);
      let n = 0;
      // The empty string sorts below every generated id, so the first page starts at the beginning.
      let cursor = "";
      for (;;) {
        const rows = statement.all(cursor, NON_LATIN_SCAN_PAGE_ROWS) as Array<{ id: string; text: string | null }>;
        for (const row of rows) {
          if (typeof row.text !== "string") continue;
          if (nonLatinLetterShare(row.text) > NON_LATIN_LETTER_TOLERANCE) {
            n++;
            if (into.length < quota) into.push(row.id);
          }
        }
        // A short page means the LIMIT was never reached, so the table is exhausted under this
        // predicate — SQLite applies LIMIT after filtering, so this holds for the body filter too.
        if (rows.length < NON_LATIN_SCAN_PAGE_ROWS) return n;
        cursor = rows[rows.length - 1]!.id;
      }
    };
    const observationSamples: string[] = [];
    const conceptSamples: string[] = [];
    const observationCount = observationQueries.reduce((total, sql) => total + scan(sql, observationSamples, 3), 0);
    const conceptCount = scan(conceptQuery, conceptSamples, 2);
    const offenders = [...observationSamples, ...conceptSamples];
    return { status: "known", tolerance: NON_LATIN_LETTER_TOLERANCE, observationCount, conceptCount, sampleIds: offenders };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The non-Latin content count alone, read through a connection the caller already holds.
 *
 * `inspectStoredEmbedderState` opens its own handle, which is right for diagnosis and wrong for a
 * check that has to observe the store WHILE the caller holds exclusive ownership of it: that second
 * handle is excluded by the caller's own lock and fails SQLITE_BUSY after the busy timeout (#14).
 * Pass the owning `StoragePort` here instead. Nothing else about the inspection is available this
 * way, and deliberately so — the rest of it needs a schema and integrity read this cannot promise
 * on an arbitrary connection.
 */
export function inspectNonLatinContent(db: NonLatinReadDb): StoredNonLatinContent {
  try {
    return inspectNonLatin(db, readSchema(db));
  } catch (error) {
    // readSchema is outside inspectNonLatin's own try, and a caller passing a live port can hit a
    // real SQLite error here. An unreadable schema is "not known", never a zero.
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

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
      nonLatin: { status: "unknown", reason },
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
    // READONLY ONLY FOR THE REAL FILE (#188). The comment above states that a readonly handle on a
    // closed WAL database makes SQLite create fresh -wal/-shm — true on macOS, verified directly,
    // and NOT true everywhere: on Linux/WSL2 the same open fails with a raw `database is locked`.
    //
    // WHY IT IS SQLITE_BUSY AND NOT A CANNOT-CREATE ERROR: SQLite runs WAL *recovery* whenever the
    // number of connected clients goes from ZERO TO ONE, and recovery takes an exclusive WRITER
    // lock before it starts (SQLite's own wal-lock.md). A readonly connection cannot hold that
    // lock, so the very first reader of an unheld WAL store loses a race against SQLite's own
    // startup step — no other process is involved, which is why a process listing shows nothing.
    //
    // The consequence is inverted from how it reads: `monet doctor` and `monet repair` fail
    // precisely when NOTHING else is running, because that is what makes the open a zero-to-one
    // transition. #188 was first filed against the filesystem for exactly that reason.
    //
    // The snapshot branch already exists to keep the source bytes untouched, and `inspectionPath`
    // there is a throwaway copy in a temp directory that is removed below. Nothing is protected by
    // opening THAT readonly, so it opens read-write and SQLite is free to build the sidecars it
    // needs beside the copy. The real file keeps the readonly handle it always had, and keeps it for
    // a reason: the walExists branch inspects the live store in place.
    db = new Database(inspectionPath, {
      readonly: snapshotDir === undefined,
      fileMustExist: true,
      timeout: 5_000,
    });
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
      nonLatin: inspectNonLatin(db, schema),
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

// ---- lifecycle-edge integrity ----------------------------------------------

/** The narrow read capability the sweep needs — satisfied by both `StoragePort` and a raw handle. */
export interface LifecycleEdgeReadDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** One normative row whose endpoint concept no longer resolves. */
export interface DanglingLifecycleEdge {
  id: string;
  family: LifecycleEdgeFamily;
  circle: string;
  srcConceptId: string;
  dstConceptId: string | null;
  /** Which endpoint(s) went missing. A provenance edge can only ever report `src`. */
  missing: Array<"src" | "dst">;
}

/** One ratification whose subject concept no longer resolves. */
export interface DanglingRatification {
  id: string;
  subjectConceptId: string;
  circle: string;
}

export interface LifecycleEdgeIntegrityReport {
  /** False when the store predates these tables; both lists are then trivially empty. */
  tablesPresent: boolean;
  edgesChecked: number;
  ratificationsChecked: number;
  dangling: DanglingLifecycleEdge[];
  danglingRatifications: DanglingRatification[];
}

/**
 * REPORT-ONLY sweep for normative rows pointing at concepts that no longer exist.
 *
 * Lifecycle edges are append-only and graph maintenance never deletes them, so the ordinary
 * unwind/rederive/detach/reassign path cannot orphan one. The residual way it can happen is
 * concept deletion: a full-consolidation `detach` deletes the source concept row outright, and a
 * hard deletion removes an id permanently. No producer of lifecycle edges exists yet (rule capture
 * arrives with a later slice), so no LIVE orphan is currently possible — which is exactly why this
 * reports rather than repairs.
 *
 * REPAIR SEMANTICS ARE DELIBERATELY NOT DEFINED HERE. Whether an orphaned derivation edge should be
 * dropped, re-pointed at the surviving consolidation target, or preserved as evidence that the rule
 * once existed is a question about what impeachment and audit need, and those consumers do not
 * exist yet. Guessing now would bake in an answer that the consuming slice would have to unpick.
 */
export function inspectLifecycleEdgeIntegrity(db: LifecycleEdgeReadDb): LifecycleEdgeIntegrityReport {
  const present = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lifecycle_edges','ratifications')`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (!present.has("lifecycle_edges") || !present.has("ratifications")) {
    return { tablesPresent: false, edgesChecked: 0, ratificationsChecked: 0, dangling: [], danglingRatifications: [] };
  }

  const edges = db
    .prepare(
      `SELECT e.id AS id, e.family AS family, e.circle AS circle,
              e.src_concept_id AS src_concept_id, e.dst_concept_id AS dst_concept_id,
              (SELECT 1 FROM concepts c WHERE c.id = e.src_concept_id) AS src_ok,
              (SELECT 1 FROM concepts c WHERE c.id = e.dst_concept_id) AS dst_ok
         FROM lifecycle_edges e
        ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all() as Array<{
      id: string;
      family: LifecycleEdgeFamily;
      circle: string;
      src_concept_id: string;
      dst_concept_id: string | null;
      src_ok: number | null;
      dst_ok: number | null;
    }>;

  const dangling: DanglingLifecycleEdge[] = [];
  for (const edge of edges) {
    const missing: Array<"src" | "dst"> = [];
    if (edge.src_ok === null) missing.push("src");
    // A null dst_concept_id is a provenance edge addressing a span, not a missing concept.
    if (edge.dst_concept_id !== null && edge.dst_ok === null) missing.push("dst");
    if (missing.length === 0) continue;
    dangling.push({
      id: edge.id,
      family: edge.family,
      circle: edge.circle,
      srcConceptId: edge.src_concept_id,
      dstConceptId: edge.dst_concept_id,
      missing,
    });
  }

  const ratifications = db
    .prepare(
      `SELECT r.id AS id, r.subject_concept_id AS subject_concept_id, r.circle AS circle,
              (SELECT 1 FROM concepts c WHERE c.id = r.subject_concept_id) AS subject_ok
         FROM ratifications r
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all() as Array<{ id: string; subject_concept_id: string; circle: string; subject_ok: number | null }>;

  const danglingRatifications: DanglingRatification[] = ratifications
    .filter((row) => row.subject_ok === null)
    .map((row) => ({ id: row.id, subjectConceptId: row.subject_concept_id, circle: row.circle }));

  return {
    tablesPresent: true,
    edgesChecked: edges.length,
    ratificationsChecked: ratifications.length,
    dangling,
    danglingRatifications,
  };
}

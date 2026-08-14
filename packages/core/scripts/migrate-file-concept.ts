/**
 * Operator harness for the file=concept source refresh and embedder migration.
 *
 * These are now two explicitly separate operations:
 *
 *   1. `--refresh-sources` re-reads registered sources from their network/filesystem origins, runs
 *      the ordinary source-sync path, and retires abandoned file=concept orphans. It uses the
 *      store's CURRENT pinned embedder and can change content independently of vector migration.
 *      On recovery from an existing migration sentinel it is skipped, so source content stays fixed
 *      while the same target vector migration converges.
 *   2. Embedder migration always delegates the complete persisted-vector lifecycle to
 *      `MonetCore.migrateEmbeddings({ targetModelId, dryRun, onProgress })`. With no `--apply` this
 *      is a dry-run inventory; with `--apply` it rewrites native concepts and observations, source
 *      concepts, workstreams, and finally the native graph. It never implicitly refreshes sources.
 *
 * Stamp ordering: core.migrateEmbeddings writes a durable `embedder_migration` sentinel under held
 * SQLite-exclusive ownership, then stamps the target pin early before rewriting vectors. The pin is
 * therefore never the sole proof of consistency: a crash leaves the sentinel in place, and every
 * served path fails closed while it exists. Re-running the SAME target reacquires the lock and
 * converges idempotently; a different target is rejected until the backup is restored or the active
 * migration is completed.
 *
 * Exclusivity: core.migrateEmbeddings now enforces this mechanically with SQLite-native exclusive
 * ownership and a 5-second busy timeout. If another MCP server, CLI, dashboard, backup, or indexer
 * holds the store open, migration stops before touching migration state and prints operator
 * remediation. Close every process using the database, wait for exit, and re-run; do not inspect the
 * same store with another Monet command while migration is active.
 *
 * Preflight: under `--apply`, the chosen target embedder must produce a vector BEFORE any source
 * refresh or MonetCore construction. migrateEmbeddings repeats this validation internally; the
 * redundancy is intentional and cheap. A failed preflight creates no DB, stamps no pin, and writes
 * no source data.
 *
 * Fail-hard behavior: source refresh and core vector phases remain per-item resilient so one bad
 * item does not prevent progress on siblings. Any recorded failure still makes the command exit
 * non-zero after rendering the full report. Core migration failures retain the durable sentinel, so
 * served paths stay closed until the same target succeeds or a verified backup is restored.
 *
 * `--apply` requires an explicit `--embedder hashing|onnx`; report-only defaults to hashing. A real
 * production migration uses `--embedder onnx`. Always run against a tested, disposable backup copy.
 *
 * Usage:
 *   tsx scripts/migrate-file-concept.ts <db-path> --embedder hashing|onnx --apply
 *   tsx scripts/migrate-file-concept.ts <db-path> [--embedder hashing|onnx]              # dry-run
 *   tsx scripts/migrate-file-concept.ts <db-path> --refresh-sources --storage-dir <dir>
 *     [--source <sourceId>] [--embedder hashing|onnx --apply]
 */
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../src/embedding";
import { OnnxEmbeddingProvider } from "../src/embedding-onnx";
import {
  EmbedderMigrationFailedError,
  EmbedderMigrationIncompleteError,
  MonetCore,
  type EmbeddingMigrationProgress,
  type EmbeddingMigrationReport,
} from "../src/engine";
import { chooseStoreEmbedder } from "../src/store-embedder";
import type { KnowledgeSource } from "../src/source-types";
import type { StoragePort } from "../src/storage";

/** Confirm the target can embed before constructing or mutating anything. */
export async function preflightEmbedder(embedder: EmbeddingProvider, label: string): Promise<void> {
  try {
    await embedder.embed("preflight");
  } catch (error) {
    throw new Error(
      `Embedder preflight failed for --embedder ${label}: this model cannot produce an embedding ` +
        `right now (network unreachable, model not cached locally, or a genuine load failure). ` +
        `Aborting before constructing MonetCore or touching any data — nothing was written. Fix the ` +
        `underlying issue (or choose a different --embedder) and re-run.`,
      { cause: error },
    );
  }
}

interface OrphanConcept {
  id: string;
  title: string;
}

export interface SourceRefreshReport {
  sourceId: string;
  type: KnowledgeSource["type"];
  lifecycle: KnowledgeSource["lifecycle"];
  syncStatus: string;
  filesPublished: number | null;
  chunksPublished: number | null;
  conceptsBefore: number;
  conceptsAfterSync: number;
  conceptsAfterSweep: number;
  orphansRetired: OrphanConcept[];
  durationMs: number;
  error: string | null;
}

type MigrationCore = Pick<MonetCore, "migrateEmbeddings">;

/** Thin, testable delegation seam: all vector and graph mechanics stay in MonetCore. */
export function runEmbeddingMigration(
  core: MigrationCore,
  targetModelId: string,
  apply: boolean,
  onProgress?: (event: EmbeddingMigrationProgress) => void,
): Promise<EmbeddingMigrationReport> {
  return core.migrateEmbeddings({ targetModelId, dryRun: !apply, onProgress });
}

export function formatEmbeddingMigrationReport(report: EmbeddingMigrationReport): string {
  const lines = [
    "",
    `=== embedding migration report (${report.dryRun ? "DRY-RUN" : "APPLIED"}, target=${report.targetModelId}) ===`,
  ];
  for (const [phase, result] of Object.entries(report.phases)) {
    lines.push(
      `${phase.padEnd(20)} completed=${String(result.completed).padStart(5)}/${String(result.total).padEnd(5)} failed=${result.failed}`,
    );
  }
  if (report.failures.length > 0) {
    lines.push("", "FAILURES:");
    for (const failure of report.failures) {
      lines.push(`  - [${failure.phase}] ${failure.id}: ${failure.message}`);
    }
  }
  return lines.join("\n");
}

export function anySourceRefreshFailure(reports: SourceRefreshReport[]): boolean {
  return reports.some((report) => report.error !== null);
}

function activeSourceConceptCount(core: MonetCore, sourceId: string): number {
  const db = (core as unknown as { db: StoragePort }).db;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source' AND source_identity = ? AND status = 'active'`)
    .get(`source://${sourceId}`) as { n: number };
  return row.n;
}

function findOrphanConcepts(core: MonetCore, sourceId: string): OrphanConcept[] {
  const db = (core as unknown as { db: StoragePort }).db;
  const candidates = db
    .prepare(`SELECT id, title FROM concepts WHERE kind = 'source' AND source_identity = ? AND status = 'active'`)
    .all(`source://${sourceId}`) as OrphanConcept[];
  return candidates.filter((candidate) => !core.hasActiveSourceChunks(candidate.id));
}

async function refreshOneSource(core: MonetCore, source: KnowledgeSource): Promise<SourceRefreshReport> {
  const startedAt = Date.now();
  const conceptsBefore = activeSourceConceptCount(core, source.id);
  let syncStatus = `skipped (lifecycle=${source.lifecycle})`;
  let filesPublished: number | null = null;
  let chunksPublished: number | null = null;
  let error: string | null = null;
  const orphansRetired: OrphanConcept[] = [];

  if (source.lifecycle === "active") {
    try {
      const result = source.type === "git-md"
        ? await core.syncGitMdSource(source.id)
        : await core.syncRepoMdSource(source.id);
      syncStatus = result.status;
      if (result.runId) {
        filesPublished = core.listSourceFiles(result.runId, true).length;
        chunksPublished = core.listSourceChunks(result.runId, true).length;
      }
    } catch (cause) {
      syncStatus = "FAILED";
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const conceptsAfterSync = activeSourceConceptCount(core, source.id);
  if (error === null) {
    for (const orphan of findOrphanConcepts(core, source.id)) {
      try {
        core.retireConcept(orphan.id);
        orphansRetired.push(orphan);
      } catch (cause) {
        error = `orphan retirement failed for ${orphan.id}: ${cause instanceof Error ? cause.message : String(cause)}`;
        break;
      }
    }
  }

  return {
    sourceId: source.id,
    type: source.type,
    lifecycle: source.lifecycle,
    syncStatus,
    filesPublished,
    chunksPublished,
    conceptsBefore,
    conceptsAfterSync,
    conceptsAfterSweep: activeSourceConceptCount(core, source.id),
    orphansRetired,
    durationMs: Date.now() - startedAt,
    error,
  };
}

function printSourceRefreshReport(reports: SourceRefreshReport[]): void {
  console.log("\n=== explicit source refresh report ===\n");
  if (reports.length === 0) {
    console.log("No matching sources found.");
    return;
  }
  for (const report of reports) {
    console.log(`source ${report.sourceId} (${report.type}, lifecycle=${report.lifecycle})`);
    console.log(`  sync status: ${report.syncStatus}${report.error ? ` [ERROR: ${report.error}]` : ""}`);
    console.log(`  files/chunks published: ${report.filesPublished ?? "n/a"}/${report.chunksPublished ?? "n/a"}`);
    console.log(
      `  active source concepts: ${report.conceptsBefore} -> ${report.conceptsAfterSync} -> ${report.conceptsAfterSweep}`,
    );
    console.log(`  orphans retired: ${report.orphansRetired.length}`);
    console.log(`  duration: ${report.durationMs}ms\n`);
  }
}

function printMigrationProgress(event: EmbeddingMigrationProgress): void {
  const current = event.currentId === undefined ? "" : ` current=${event.currentId}`;
  console.log(
    `[migration:${event.phase}] ${event.completed}/${event.total} completed; ${event.failed} failed${current}`,
  );
}

/**
 * Run a report-only operation against a SQLite snapshot. MonetCore always upgrades an older store on
 * open, so a dry-run must never construct it over the operator's original database.
 */
export async function withReportOnlyStore<T>(dbPath: string, operation: (copyPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "monet-migration-report-"));
  const copyPath = join(directory, basename(dbPath));
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(copyPath);
  } finally {
    source.close();
  }
  try {
    return await operation(copyPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function refreshSources(
  dbPath: string,
  storageDir: string | undefined,
  onlySourceId: string | undefined,
): Promise<SourceRefreshReport[]> {
  const core = new MonetCore(dbPath, {
    embedder: await chooseStoreEmbedder(dbPath),
    ...(storageDir ? { sourceStorageDir: storageDir } : {}),
  });
  try {
    await core.ensureEmbedderPin();
    const sources = core
      .listSources({ includeTombstoned: true })
      .filter((source) => !onlySourceId || source.id === onlySourceId);
    const reports: SourceRefreshReport[] = [];
    for (const source of sources) reports.push(await refreshOneSource(core, source));
    return reports;
  } finally {
    core.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dbPath = args.find(
    (arg, index) => !arg.startsWith("--") && !["--storage-dir", "--source", "--embedder"].includes(args[index - 1] ?? ""),
  );
  const applyFlag = args.includes("--apply");
  const refreshSourcesFlag = args.includes("--refresh-sources");
  const storageDir = flagValue("--storage-dir");
  const onlySourceId = flagValue("--source");
  const embedderArg = flagValue("--embedder");

  if (!dbPath) {
    console.error("Usage: tsx scripts/migrate-file-concept.ts <db-path> [--embedder hashing|onnx] [--apply]");
    console.error("       [--refresh-sources] [--storage-dir <dir>] [--source <sourceId>]");
    process.exit(1);
  }
  if (onlySourceId !== undefined && !refreshSourcesFlag) {
    console.error("--source only scopes the explicit --refresh-sources operation.");
    process.exit(1);
  }
  if (applyFlag && embedderArg === undefined) {
    console.error("--apply requires --embedder onnx|hashing explicitly; this decides the store's semantic model.");
    process.exit(1);
  }
  const embedderChoice = embedderArg ?? "hashing";
  if (embedderChoice !== "hashing" && embedderChoice !== "onnx") {
    console.error(`--embedder must be "hashing" or "onnx", got "${embedderChoice}"`);
    process.exit(1);
  }

  if (applyFlag || refreshSourcesFlag) {
    console.log("WARNING: this command can rewrite source content and/or every persisted semantic vector.");
    console.log("Run it only against a disposable COPY backed by a tested, verified backup.");
    console.log(`Target db: ${dbPath}`);
  } else {
    console.log("DRY-RUN: inventories and validates the embedding migration without changing durable state.");
  }

  const targetEmbedder: EmbeddingProvider = embedderChoice === "onnx"
    ? new OnnxEmbeddingProvider()
    : new HashingEmbeddingProvider();
  if (applyFlag) await preflightEmbedder(targetEmbedder, embedderChoice);

  let sourceReports: SourceRefreshReport[] = [];
  if (refreshSourcesFlag) {
    try {
      sourceReports = await refreshSources(dbPath, storageDir, onlySourceId);
      printSourceRefreshReport(sourceReports);
    } catch (error) {
      if (!(error instanceof EmbedderMigrationIncompleteError)) throw error;
      console.error(
        "Source refresh skipped because this store already has an incomplete embedder migration; " +
          "source content must remain unchanged until the same target migration converges.",
      );
    }
  }

  const targetModelId = targetEmbedder.modelId;
  if (targetModelId === undefined) throw new Error("The selected migration embedder has no persistable modelId.");
  const runAgainst = async (migrationDbPath: string): Promise<void> => {
    const core = new MonetCore(migrationDbPath, {
      embedder: targetEmbedder,
      ...(storageDir ? { sourceStorageDir: storageDir } : {}),
      deferCreatedPin: !applyFlag,
    });
    try {
      try {
        const report = await runEmbeddingMigration(core, targetModelId, applyFlag, printMigrationProgress);
        console.log(formatEmbeddingMigrationReport(report));
      } catch (error) {
        if (error instanceof EmbedderMigrationFailedError) {
          console.error(formatEmbeddingMigrationReport(error.report));
        }
        throw error;
      }
    } finally {
      core.close();
    }
  };
  if (applyFlag || refreshSourcesFlag) await runAgainst(dbPath);
  else await withReportOnlyStore(dbPath, runAgainst);

  if (anySourceRefreshFailure(sourceReports)) {
    throw new Error(
      "SOURCE REFRESH INCOMPLETE: one or more sources failed, but sibling refreshes and the requested " +
        "embedding migration were allowed to finish. Fix the reported source failures and re-run " +
        "--refresh-sources, or restore the verified backup.",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

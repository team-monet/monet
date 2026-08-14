import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anySourceRefreshFailure,
  formatEmbeddingMigrationReport,
  runEmbeddingMigration,
  withReportOnlyStore,
  type SourceRefreshReport,
} from "../../scripts/migrate-file-concept";
import { EmbedderMigrationFailedError, MonetCore, type EmbeddingMigrationReport } from "../engine";
import type { StoragePort } from "../storage";

function sourceReport(error: string | null): SourceRefreshReport {
  return {
    sourceId: "source-1",
    type: "repo-md",
    lifecycle: "active",
    syncStatus: error ? "FAILED" : "published",
    filesPublished: error ? null : 1,
    chunksPublished: error ? null : 1,
    conceptsBefore: 1,
    conceptsAfterSync: 1,
    conceptsAfterSweep: 1,
    orphansRetired: [],
    durationMs: 1,
    error,
  };
}

function migrationReport(failures = 0): EmbeddingMigrationReport {
  const phase = { total: 1, completed: 1, failed: failures };
  return {
    targetModelId: "target/model",
    dryRun: false,
    phases: {
      preflight: { ...phase, failed: 0 },
      lock: { ...phase, failed: 0 },
      "native-concepts": phase,
      "native-observations": { total: 0, completed: 0, failed: 0 },
      "source-concepts": { total: 0, completed: 0, failed: 0 },
      "source-chunk-observations": { total: 0, completed: 0, failed: 0 },
      workstreams: { total: 0, completed: 0, failed: 0 },
      "native-graph": { total: 0, completed: 0, failed: 0 },
      complete: { total: 1, completed: failures === 0 ? 1 : 0, failed: 0 },
    },
    failures: failures === 0
      ? []
      : [{ phase: "native-concepts", id: "concept-1", message: "injected failure" }],
  };
}

describe("migrate-file-concept thin migration harness", () => {
  it("delegates the complete operation to core.migrateEmbeddings with dry-run and progress intact", async () => {
    const report = migrationReport();
    const onProgress = vi.fn();
    const migrateEmbeddings = vi.fn().mockResolvedValue(report);

    await expect(
      runEmbeddingMigration({ migrateEmbeddings }, "target/model", false, onProgress),
    ).resolves.toBe(report);
    expect(migrateEmbeddings).toHaveBeenCalledOnce();
    expect(migrateEmbeddings).toHaveBeenCalledWith({
      targetModelId: "target/model",
      dryRun: true,
      onProgress,
    });
  });

  it("preserves core's fail-hard report after its per-item-resilient pass", async () => {
    const failure = new EmbedderMigrationFailedError(migrationReport(1));
    const migrateEmbeddings = vi.fn().mockRejectedValue(failure);
    let caught: unknown;
    try {
      await runEmbeddingMigration({ migrateEmbeddings }, "target/model", true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect((caught as EmbedderMigrationFailedError).report.failures).toEqual([
      { phase: "native-concepts", id: "concept-1", message: "injected failure" },
    ]);
    expect(migrateEmbeddings).toHaveBeenCalledWith({
      targetModelId: "target/model",
      dryRun: false,
      onProgress: undefined,
    });
  });

  it("renders phase and item failures from the core report", () => {
    const rendered = formatEmbeddingMigrationReport(migrationReport(1));
    expect(rendered).toMatch(/native-concepts.*failed=1/);
    expect(rendered).toMatch(/\[native-concepts\] concept-1: injected failure/);
  });

  it("source refresh remains per-item resilient but produces a fail-hard end decision", () => {
    expect(anySourceRefreshFailure([sourceReport(null)])).toBe(false);
    expect(anySourceRefreshFailure([sourceReport(null), sourceReport("ENOENT")])).toBe(true);
  });

  it("opens report-only schema-11 stores through a disposable backup and leaves the original byte-identical", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monet-report-only-copy-"));
    const dbPath = join(directory, "monet.db");
    try {
      const seed = new MonetCore(dbPath);
      const stored = await seed.store("Report-only migration target.", { resolution: "forceNew" });
      const db = (seed as unknown as { db: StoragePort }).db;
      db.prepare(
        `INSERT INTO first_block
           (id, concept_id, circle, summary, summary_dirty, position, promoted_at, promoted_by,
            updated_at, sync_revision, sync_writer, deleted_at)
         VALUES ('report-pin', ?, 'default', 'Report-only pin.', 0, 0, 1700000000000, NULL,
                 1700000000000, 1, 'schema-11-fixture', NULL)`,
      ).run(stored.conceptId);
      db.pragma("user_version = 11");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("journal_mode = DELETE");
      seed.close();
      const before = readFileSync(dbPath);

      await withReportOnlyStore(dbPath, async (copyPath) => {
        const reportCore = new MonetCore(copyPath);
        const reportDb = (reportCore as unknown as { db: StoragePort }).db;
        expect(reportDb.pragma("user_version", { simple: true })).toBe(12);
        reportCore.close();
      });

      expect(readFileSync(dbPath)).toEqual(before);
      const verify = new Database(dbPath, { readonly: true });
      expect(verify.pragma("user_version", { simple: true })).toBe(11);
      verify.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

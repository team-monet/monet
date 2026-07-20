import { describe, expect, it, vi } from "vitest";
import {
  anySourceRefreshFailure,
  formatEmbeddingMigrationReport,
  runEmbeddingMigration,
  type SourceRefreshReport,
} from "../../scripts/migrate-file-concept";
import { EmbedderMigrationFailedError, type EmbeddingMigrationReport } from "../engine";

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
});

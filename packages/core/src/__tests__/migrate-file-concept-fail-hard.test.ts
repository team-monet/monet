/**
 * scripts/migrate-file-concept.ts — anyMigrationFailure / migrationIncompleteMessage unit tests
 * (Codex review, PR #51 round 8, FIX Y).
 *
 * Every loop in the migration script (source sync/orphan retirement, native re-embed, native
 * observation re-embed, graph rebuild) is deliberately per-item resilient — one bad item is
 * recorded and skipped, never aborting the rest of that run. That resilience means a --apply run
 * can complete and exit 0 with the pin ALREADY stamped to the target embedder while some vectors
 * are still stranded under the OLD model — a half-migrated store that looks like a clean success
 * from the exit code alone. main() now fails hard on any recorded failure under --apply.
 *
 * anyMigrationFailure is a pure predicate over the three report shapes — exported for testability,
 * since main() itself (real argv/fs/console work, guarded behind an import.meta.url entry-point
 * check) isn't independently testable without a real MonetCore and real (or deliberately poisoned)
 * sources. The full end-to-end claim — a real --apply run against a real disposable store with a
 * genuinely poisoned source exits non-zero with this exact warning block, and a healed re-run exits
 * 0 — is verified via the manual-verification protocol instead (documented in the implementation
 * return, not repeated here): a real repo-md source synced once successfully, then its local
 * directory deleted so the next sync fails naturally with no mocks of any kind.
 */
import { describe, it, expect } from "vitest";
import {
  anyMigrationFailure,
  migrationIncompleteMessage,
  type SourceMigrationReport,
  type NativeReembedReport,
  type GraphRebuildReport,
} from "../../scripts/migrate-file-concept";

function emptySourceReport(overrides: Partial<SourceMigrationReport> = {}): SourceMigrationReport {
  return {
    sourceId: "s1", type: "repo-md", lifecycle: "active", syncStatus: "published",
    filesPublished: 1, chunksPublished: 1, conceptsBefore: 1, conceptsAfterSync: 1,
    conceptsAfterSweep: 1, orphansRetired: [], durationMs: 1, error: null,
    ...overrides,
  };
}

function emptyNativeReport(overrides: Partial<NativeReembedReport> = {}): NativeReembedReport {
  return {
    attempted: 0, succeeded: 0, succeededIds: [], failed: [],
    observationsReembedded: 0, observationReembedFailed: [], durationMs: 0,
    ...overrides,
  };
}

function emptyGraphReport(overrides: Partial<GraphRebuildReport> = {}): GraphRebuildReport {
  return { attempted: 0, succeeded: 0, failed: [], durationMs: 0, edgesBefore: 0, edgesAfter: 0, ...overrides };
}

describe("anyMigrationFailure (Codex review, PR #51 round 8, FIX Y)", () => {
  it("all-clean reports (the report-only shape, and a fully successful --apply run) -> false", () => {
    expect(anyMigrationFailure([emptySourceReport()], emptyNativeReport(), emptyGraphReport())).toBe(false);
    expect(anyMigrationFailure([], emptyNativeReport(), emptyGraphReport())).toBe(false); // no sources at all
  });

  it("a source sync/orphan-retirement error alone -> true", () => {
    expect(
      anyMigrationFailure([emptySourceReport({ error: "sync failed: ENOENT" })], emptyNativeReport(), emptyGraphReport()),
    ).toBe(true);
  });

  it("a native concept re-embed failure alone -> true", () => {
    expect(
      anyMigrationFailure([emptySourceReport()], emptyNativeReport({ failed: [{ id: "c1", error: "boom" }] }), emptyGraphReport()),
    ).toBe(true);
  });

  it("a native OBSERVATION re-embed failure alone -> true (tracked separately from the concept-level failed list, per reembedNativeConcepts' own docstring — must not be missed)", () => {
    expect(
      anyMigrationFailure(
        [emptySourceReport()],
        emptyNativeReport({ observationReembedFailed: [{ id: "c1", error: "boom" }] }),
        emptyGraphReport(),
      ),
    ).toBe(true);
  });

  it("a graph rebuild failure alone -> true", () => {
    expect(
      anyMigrationFailure([emptySourceReport()], emptyNativeReport(), emptyGraphReport({ failed: [{ id: "c1", error: "boom" }] })),
    ).toBe(true);
  });

  it("multiple simultaneous failure kinds -> still just true (no double-counting concern, it's a predicate not a count)", () => {
    expect(
      anyMigrationFailure(
        [emptySourceReport({ error: "x" })],
        emptyNativeReport({ failed: [{ id: "c1", error: "y" }] }),
        emptyGraphReport({ failed: [{ id: "c2", error: "z" }] }),
      ),
    ).toBe(true);
  });
});

describe("migrationIncompleteMessage (Codex review, PR #51 round 8, FIX Y)", () => {
  it("names the chosen embedder, and covers every required point: mid-migration, pin stamped, do-not-serve, re-run-to-converge, backup fallback", () => {
    const msg = migrationIncompleteMessage("onnx");
    expect(msg).toMatch(/onnx/);
    expect(msg).toMatch(/MID-MIGRATION/i);
    expect(msg).toMatch(/pin already points/i);
    expect(msg).toMatch(/DO NOT open this store/i);
    expect(msg).toMatch(/served path/i);
    expect(msg).toMatch(/re-run this script/i);
    expect(msg).toMatch(/idempotent/i);
    expect(msg).toMatch(/backup/i);
  });
});

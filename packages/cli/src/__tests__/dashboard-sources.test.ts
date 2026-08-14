import { describe, expect, it } from "vitest";
import {
  computeSourceSchedule,
  deriveSourceStatus,
  sourceBackoffMs,
  terminalOutcomes,
} from "../dashboard/server.js";

// Parity fixtures for the pure logic ported from monet-core (source-registry
// deriveStatus, source-scheduler cappedBackoff/planSourceDue, source-ledger
// scheduleBasisSnapshot fence scoping). These encode the engine's semantics so
// silent drift in the dashboard's read-only reimplementation fails loudly.

describe("deriveSourceStatus", () => {
  it("mirrors the engine's derivation", () => {
    expect(deriveSourceStatus({ lifecycle: "tombstoned", config_version: 3, applied_config_version: 3 }))
      .toBe("tombstoned");
    expect(deriveSourceStatus({ lifecycle: "active", config_version: 1, applied_config_version: null }))
      .toBe("pending-initial-sync");
    expect(deriveSourceStatus({ lifecycle: "active", config_version: 2, applied_config_version: 2 }))
      .toBe("active");
    expect(deriveSourceStatus({ lifecycle: "active", config_version: 3, applied_config_version: 2 }))
      .toBe("pending-replacement");
  });

  it("degrades a corrupt applied>config row instead of throwing (read-only view)", () => {
    expect(deriveSourceStatus({ lifecycle: "active", config_version: 1, applied_config_version: 2 }))
      .toBe("pending-replacement");
  });
});

describe("sourceBackoffMs", () => {
  it("matches the engine's cappedBackoff: 30s doubling, capped at the interval", () => {
    const interval = 900_000; // the live obsidian-vault 900s case
    expect(sourceBackoffMs(interval, 1)).toBe(30_000);
    expect(sourceBackoffMs(interval, 2)).toBe(60_000);
    expect(sourceBackoffMs(interval, 5)).toBe(480_000);
    expect(sourceBackoffMs(interval, 6)).toBe(900_000); // 960s doubles past the cap
    expect(sourceBackoffMs(interval, 15)).toBe(900_000);
  });

  it("caps below the 30s floor when the interval itself is shorter", () => {
    expect(sourceBackoffMs(10_000, 1)).toBe(10_000);
    expect(sourceBackoffMs(10_000, 4)).toBe(10_000);
    expect(sourceBackoffMs(30_000, 1)).toBe(30_000);
  });
});

describe("terminalOutcomes", () => {
  const ev = (over: Partial<{
    kind: string; runId: string | null; attemptedAt: number;
    invocationResult: string | null; configVersion: number | null; leaseFence: number | null;
    runResult: string | null; runPublishedAt: number | null; runFinishedAt: number | null;
  }>) => ({
    kind: "run", runId: "r1", attemptedAt: 1000, invocationResult: null,
    configVersion: 2, leaseFence: 2, runResult: "failed" as string | null,
    runPublishedAt: null, runFinishedAt: null, ...over,
  });

  it("drops in-flight runs and NULL-fence events", () => {
    const outcomes = terminalOutcomes([
      ev({ runResult: null }),                            // live run, no outcome yet
      ev({ configVersion: null, leaseFence: null }),      // never matches, as in the engine
      ev({ attemptedAt: 500, runId: "r2" }),
    ], 2, 2);
    expect(outcomes).toEqual([{ attemptedAt: 500, result: "failed" }]);
  });

  it("counts verification as success — it breaks a failure streak, as in the engine", () => {
    const outcomes = terminalOutcomes([
      ev({ kind: "verification", runId: "r9", runResult: null, attemptedAt: 900 }),
      ev({ kind: "pre-pin-failure", runId: null, runResult: null, attemptedAt: 800 }),
    ], 2, 2);
    expect(outcomes).toEqual([
      { attemptedAt: 900, result: "success" },
      { attemptedAt: 800, result: "failed" },
    ]);
  });

  it("dedups a run against its invocation receipt — one logical attempt, counted once", () => {
    const outcomes = terminalOutcomes([
      ev({ kind: "invocation", runId: "r1", invocationResult: "failed", attemptedAt: 900 }),
      ev({ kind: "run", runId: "r1", runResult: "failed", attemptedAt: 850 }),
      ev({ kind: "run", runId: "r0", runResult: "success", attemptedAt: 700 }),
    ], 2, 2);
    expect(outcomes).toEqual([
      { attemptedAt: 900, result: "failed" },
      { attemptedAt: 700, result: "success" },
    ]);
  });

  it("marks the run seen even when the invocation carries no result", () => {
    const outcomes = terminalOutcomes([
      ev({ kind: "invocation", runId: "r1", invocationResult: null, attemptedAt: 900 }),
      ev({ kind: "run", runId: "r1", runResult: "failed", attemptedAt: 850 }),
    ], 2, 2);
    expect(outcomes).toEqual([]);
  });

  it("anchors run outcomes at max(attempted_at, published_at, finished_at)", () => {
    const outcomes = terminalOutcomes([
      ev({ kind: "run", runId: "r1", runResult: "success", attemptedAt: 500, runPublishedAt: 620, runFinishedAt: 610 }),
    ], 2, 2);
    expect(outcomes).toEqual([{ attemptedAt: 620, result: "success" }]);
  });

  it("scopes to the current config_version/lease_fence — a config update resets the streak", () => {
    // Pre-update failures under fences (1,1); the source was then updated to (2,2).
    const outcomes = terminalOutcomes([
      ev({ attemptedAt: 900, runId: "r4", configVersion: 2, leaseFence: 2 }),
      ev({ attemptedAt: 800, runId: "r3", configVersion: 1, leaseFence: 1 }),
      ev({ attemptedAt: 700, runId: "r2", configVersion: 1, leaseFence: 1 }),
      ev({ attemptedAt: 600, runId: "r1", configVersion: 1, leaseFence: 1 }),
    ], 2, 2);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].attemptedAt).toBe(900);
  });
});

describe("computeSourceSchedule", () => {
  const intervalSrc = { lifecycle: "active", refresh_mode: "interval", refresh_interval_seconds: 900 };
  const NOW = 10_000_000;

  it("reports manual for manual-mode and non-active sources", () => {
    expect(computeSourceSchedule({ ...intervalSrc, refresh_mode: "manual" }, [], false, NOW).state).toBe("manual");
    expect(computeSourceSchedule({ ...intervalSrc, lifecycle: "tombstoned" }, [], false, NOW).state).toBe("manual");
  });

  it("reports syncing while a live run exists", () => {
    expect(computeSourceSchedule(intervalSrc, [], true, NOW).state).toBe("syncing");
  });

  it("reports due for a never-attempted interval source", () => {
    const s = computeSourceSchedule(intervalSrc, [], false, NOW);
    expect(s.state).toBe("due");
    expect(s.nextAttemptAt).toBe(NOW);
  });

  it("schedules anchor+interval after a success", () => {
    const s = computeSourceSchedule(intervalSrc, [{ attemptedAt: NOW - 60_000, result: "success" }], false, NOW);
    expect(s.state).toBe("scheduled");
    expect(s.nextAttemptAt).toBe(NOW - 60_000 + 900_000);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("backs off after failures with the engine's capped delay and streak", () => {
    const outcomes = [
      { attemptedAt: NOW - 10_000, result: "failed" },
      { attemptedAt: NOW - 40_000, result: "failed" },
      { attemptedAt: NOW - 70_000, result: "success" },
      { attemptedAt: NOW - 100_000, result: "failed" }, // pre-success failure must not count
    ];
    const s = computeSourceSchedule(intervalSrc, outcomes, false, NOW);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.nextAttemptAt).toBe(NOW - 10_000 + 60_000); // cappedBackoff(900s, 2) = 60s
    expect(s.state).toBe("backoff");
  });

  it("reports due once the (approximate) next attempt time has passed", () => {
    const s = computeSourceSchedule(intervalSrc, [{ attemptedAt: NOW - 1_000_000, result: "success" }], false, NOW);
    expect(s.state).toBe("due");
  });
});

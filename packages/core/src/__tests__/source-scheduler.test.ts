import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MonetCore } from "../engine";
import {
  attachSourceSchedulerLifecycle,
  getInFlightTracker,
  installProcessShutdownHandlers,
  installStdinEofShutdown,
  settleGracefulShutdownOnExplicitClose,
  settleGracefulShutdownOnStartupFailure,
  withShutdownBarrier,
} from "../mcp-server";
import type { EofStream, ShutdownSignal, ShutdownSignalProcess } from "../mcp-server";
import { createSourceScheduler, planSourceDue } from "../source-scheduler";
import { syncScheduledRepoMdSource } from "../source-sync";
import { withRepoMdMaterializerLock } from "../source-materializer";
import type { ScheduledSourceCore, SourceDuePlan } from "../source-scheduler";
import type { SourceScheduleBasis } from "../source-ledger";
import type { KnowledgeSource, SourceSyncRunResult } from "../source-types";
import type { RepoMdSyncResult } from "../source-sync";
import type { StoragePort } from "../storage";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function source(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: "source-a", type: "repo-md", name: "source-a", repositoryIdentity: "repo:source-a",
    localPath: "/tmp/source-a", circle: "source-a", autoDetect: false, include: [], exclude: [], repoMappings: [],
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none",
    refresh: { mode: "interval", intervalSeconds: 600 }, configVersion: 3, appliedConfigVersion: 3,
    activeRunId: null, activeSnapshotId: null, activeIngestConfigHash: null, leaseFence: 4,
    lifecycle: "active", status: "pending-initial-sync", createdAt: 1_000, updatedAt: 1_000, tombstonedAt: null,
    ...overrides,
  };
}

function basis(
  result: SourceSyncRunResult | null = null,
  overrides: Partial<SourceScheduleBasis> = {},
): SourceScheduleBasis {
  return {
    attemptSequence: result ? 7 : 0,
    latestTerminal: result ? { sequence: 7, attemptedAt: 100_000, result } : null,
    consecutiveFailures: result === "success" || result === null ? 0 : 1,
    resumable: false,
    removalIncomplete: false,
    ...overrides,
  };
}

function makeWritable(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) { chmodSync(path, 0o600); return; }
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } catch { /* cleanup */ }
}

function repoFixture(label: string, clock = { now: 100_000 }) {
  const root = mkdtempSync(join(tmpdir(), `monet-scheduler-${label}-`));
  const repo = join(root, "repo");
  const db = join(root, "monet.db");
  const storage = join(root, "managed");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Intro\n\nbody\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "initial");
  const core = new MonetCore(db, { sourceStorageDir: storage, sourceClock: () => clock.now });
  core.createSource({
    id: "repo-source", type: "repo-md", name: "repo", localPath: repo, circle: "repo",
    include: ["README.md"], exclude: [], autoDetect: false,
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none",
    refresh: { mode: "interval", intervalSeconds: 60 },
  });
  return {
    root, repo, db, storage, core, clock,
    cleanup() { try { core.close(); } catch { /* closed */ } makeWritable(root); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("source due planner", () => {
  it("covers manual, initial, success/no-op, failed/partial, and recovery priority", () => {
    const now = 1_000_000;
    expect(planSourceDue({ source: source({ refresh: { mode: "manual" } }), basis: basis(), now, startupAt: now }).state).toBe("manual");
    const initial = planSourceDue({ source: source(), basis: basis(), now, startupAt: now });
    expect(initial).toMatchObject({ state: "scheduled", due: false, consecutiveFailures: 0 });
    expect(initial.nextAttemptAt).toBeGreaterThanOrEqual(now);
    expect(initial.nextAttemptAt).toBeLessThanOrEqual(now + 30_000);

    for (const terminal of ["success", "failed", "partial"] as const) {
      const planned = planSourceDue({ source: source(), basis: basis(terminal), now, startupAt: 0 });
      expect(planned.due).toBe(true);
      expect(planned.state).toBe("due");
    }
    for (const recovery of [
      basis(null, { resumable: true }),
      basis(null, { removalIncomplete: true }),
    ]) {
      expect(planSourceDue({ source: source({ refresh: { mode: "manual" } }), basis: recovery, now, startupAt: now }))
        .toMatchObject({ state: "recovering", due: true, nextAttemptAt: now });
    }
  });

  it("is deterministic, caps jitter/backoff, and handles backward/forward clock jumps", () => {
    const current = source({ refresh: { mode: "interval", intervalSeconds: 10_000 } });
    const failed = basis("failed", { consecutiveFailures: 99 });
    const first = planSourceDue({ source: current, basis: failed, now: 110_000, startupAt: 0 });
    const second = planSourceDue({ source: current, basis: failed, now: 110_000, startupAt: 0 });
    expect(second).toEqual(first);
    expect(first.nextAttemptAt! - 100_000).toBeGreaterThanOrEqual(10_000_000);
    expect(first.nextAttemptAt! - 100_000).toBeLessThanOrEqual(11_000_000);

    const future = basis("success", { latestTerminal: { sequence: 7, attemptedAt: 999_999, result: "success" } });
    const backwardSource = source({ refresh: { mode: "interval", intervalSeconds: 60 } });
    for (const wakeNow of [10_000, 20_000, 30_000, 40_000]) {
      expect(planSourceDue({ source: backwardSource, basis: basis(), now: wakeNow, startupAt: 999_999 }))
        .toMatchObject({ due: true, state: "due", nextAttemptAt: 0 });
    }
    const backward = planSourceDue({ source: backwardSource, basis: future, now: 10_000, startupAt: 0 });
    expect(backward).toMatchObject({ due: true, state: "due", nextAttemptAt: 0 });
    for (const wakeNow of [20_000, 30_000, 40_000]) {
      expect(planSourceDue({ source: backwardSource, basis: future, now: wakeNow, startupAt: 0 }))
        .toMatchObject({ due: true, state: "due", nextAttemptAt: 0 });
    }
    expect(planSourceDue({ source: source(), basis: basis("success"), now: 10_000_000, startupAt: 0 }).due).toBe(true);
  });

  it("treats the supplied current-fence basis independently from old-fence attempts", () => {
    const now = 1_000_000;
    const oldFenceSuccess = planSourceDue({ source: source({ configVersion: 4, leaseFence: 5 }), basis: basis(), now, startupAt: 0 });
    expect(oldFenceSuccess).toMatchObject({ due: true, attemptSequence: 0, configVersion: 4, leaseFence: 5 });
  });
});

describe("durable scheduler lease and admission", () => {
  it("keeps the public sync result union free of the scheduler-only skip sentinel", () => {
    const excludesSkipped: "skipped" extends RepoMdSyncResult["status"] ? false : true = true;
    expect(excludesSkipped).toBe(true);
  });

  it("allows one owner, expiry takeover, renewal, and release only by the owner", () => {
    const root = mkdtempSync(join(tmpdir(), "monet-scheduler-lease-"));
    const db = join(root, "monet.db");
    const a = new MonetCore(db);
    const b = new MonetCore(db);
    try {
      expect(a.acquireSourceSchedulerLease("owner-a", 100, 90)).toBe(true);
      expect(b.acquireSourceSchedulerLease("owner-b", 150, 90)).toBe(false);
      expect(a.renewSourceSchedulerLease("owner-a", 160, 90)).toBe(true);
      expect(b.acquireSourceSchedulerLease("owner-b", 251, 90)).toBe(true);
      expect(a.renewSourceSchedulerLease("owner-a", 252, 90)).toBe(false);
      expect(a.releaseSourceSchedulerLease("owner-a")).toBe(false);
      expect(b.releaseSourceSchedulerLease("owner-b")).toBe(true);
    } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("skips a stale queued decision when a manual sync wins before locked admission", async () => {
    const f = repoFixture("manual-wins");
    try {
      const registered = f.core.getSource("repo-source")!;
      const queued = planSourceDue({
        source: registered,
        basis: f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence),
        now: f.clock.now,
        startupAt: 0,
      });
      expect(queued.due).toBe(true);
      await f.core.syncRepoMdSource("repo-source");
      const attempts = f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence).attemptSequence;
      await expect(f.core.syncScheduledSource(queued, 0, () => f.clock.now, () => true)).resolves.toBeNull();
      expect(f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence).attemptSequence).toBe(attempts);
    } finally { f.cleanup(); }
  });

  it("skips queued work after config fence changes without creating a fake attempt", async () => {
    const f = repoFixture("config-wins");
    try {
      const registered = f.core.getSource("repo-source")!;
      const queued = planSourceDue({ source: registered, basis: basis(), now: f.clock.now, startupAt: 0 });
      f.core.updateSource("repo-source", { refresh: { mode: "manual" } });
      await expect(f.core.syncScheduledSource(queued, 0, () => f.clock.now, () => true)).resolves.toBeNull();
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events`).get() as { count: number }).count).toBe(0);
    } finally { f.cleanup(); }
  });

  it("skips queued work after removal wins and does not disclose scheduler lease internals", async () => {
    const f = repoFixture("removal-wins");
    try {
      const registered = f.core.getSource("repo-source")!;
      const queued = planSourceDue({ source: registered, basis: basis(), now: f.clock.now, startupAt: 0 });
      f.core.removeSource("repo-source");
      await expect(f.core.syncScheduledSource(queued, 0, () => f.clock.now, () => true)).resolves.toBeNull();
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events`).get() as { count: number }).count).toBe(0);
    } finally { f.cleanup(); }
  });

  it("durably records and sanitizes repo-md failures before run creation for backoff", async () => {
    const f = repoFixture("pre-pin");
    try {
      makeWritable(f.repo); rmSync(f.repo, { recursive: true, force: true });
      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow();
      const registered = f.core.getSource("repo-source")!;
      const durable = f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence);
      expect(durable).toMatchObject({ consecutiveFailures: 1, latestTerminal: { result: "failed" } });
      const status = f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" }, f.clock.now);
      expect(status.schedule.state).toBe("backoff");
      expect(Object.keys(status.schedule).sort()).toEqual(["consecutiveFailures", "nextAttemptAt", "state"]);
      expect(status.lastError).not.toContain(f.root);
      await expect(Promise.resolve().then(() => f.core.sourceStatus("repo-source", { callerId: "denied", projectId: "project" })))
        .rejects.toThrow(/unavailable/);
    } finally { f.cleanup(); }
  });

  it("does not duplicate a pre-pin receipt when a fault follows durable begin", async () => {
    const f = repoFixture("after-begin");
    try {
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-begin") throw new Error("fault after durable begin"); },
      })).rejects.toThrow(/fault after durable begin/);
      const registered = f.core.getSource("repo-source")!;
      expect(f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence))
        .toMatchObject({ consecutiveFailures: 1, latestTerminal: { result: "failed" } });
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='pre-pin-failure'`).get() as { count: number }).count).toBe(0);
    } finally { f.cleanup(); }
  });

  it("fences stale queued and in-flight scheduled work after lease loss", async () => {
    const f = repoFixture("lease-loss");
    let contender: MonetCore | null = null;
    try {
      const registered = f.core.getSource("repo-source")!;
      const queued = planSourceDue({ source: registered, basis: basis(), now: f.clock.now, startupAt: 0 });
      expect(f.core.acquireSourceSchedulerLease("owner-a", f.clock.now, 90)).toBe(true);
      contender = new MonetCore(f.db, { sourceStorageDir: f.storage, sourceClock: () => f.clock.now });
      f.clock.now += 91;
      expect(contender.acquireSourceSchedulerLease("owner-b", f.clock.now, 90)).toBe(true);
      await expect(f.core.syncScheduledSource(
        queued, 0, () => f.clock.now, () => f.core.assertSourceSchedulerLease("owner-a", f.clock.now),
      )).resolves.toBeNull();
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events`).get() as { count: number }).count).toBe(0);

      let ownsLease = true;
      await expect(syncScheduledRepoMdSource(f.core, "repo-source", {
        sourceStorageDir: f.storage,
        scheduledAdmission: () => true,
        scheduledAssertLeaseOwner: () => ownsLease,
        fault: (point) => {
          if (point === "after-begin") {
            ownsLease = false;
            throw new Error("failure after scheduler lease loss");
          }
        },
      })).rejects.toThrow(/failure after scheduler lease loss/);
      expect(f.core.resumeSourceRun("repo-source")).toMatchObject({ state: "scanning" });
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='invocation'`).get() as { count: number }).count).toBe(0);
    } finally { contender?.close(); f.cleanup(); }
  });

  it("does not write a success receipt after the scheduler lease is lost at completion", async () => {
    const f = repoFixture("lease-loss-success");
    try {
      let ownsLease = true;
      await expect(syncScheduledRepoMdSource(f.core, "repo-source", {
        sourceStorageDir: f.storage,
        scheduledAdmission: () => true,
        scheduledAssertLeaseOwner: () => ownsLease,
        fault: (point) => { if (point === "after-current") ownsLease = false; },
      })).resolves.toBeNull();
      expect(f.core.getSource("repo-source")?.activeRunId).not.toBeNull();
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='invocation'`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='pre-pin-failure'`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts`).get() as { count: number }).count).toBe(0);
    } finally { f.cleanup(); }
  });

  it("does not write the outer fallback receipt after lease loss before lock admission", async () => {
    const f = repoFixture("lease-loss-fallback");
    let release!: () => void;
    let entered!: () => void;
    let held: Promise<void> | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    try {
      held = withRepoMdMaterializerLock("repo-source", { sourceStorageDir: f.storage }, async () => {
        entered();
        await pending;
      });
      await acquired;
      await expect(syncScheduledRepoMdSource(f.core, "repo-source", {
        sourceStorageDir: f.storage,
        scheduledAdmission: () => true,
        scheduledAssertLeaseOwner: () => false,
      })).rejects.toThrow(/locked/);
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='invocation'`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE kind='pre-pin-failure'`).get() as { count: number }).count).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts`).get() as { count: number }).count).toBe(0);
      release();
      await held;
    } finally {
      release();
      await held?.catch(() => undefined);
      f.cleanup();
    }
  });

  it("uses the durable no-op verification as success if the process faults immediately afterward", async () => {
    const f = repoFixture("verified-crash");
    try {
      await f.core.syncRepoMdSource("repo-source");
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-noop-verification") throw new Error("simulated process fault"); },
      })).rejects.toThrow(/simulated process fault/);
      const registered = f.core.getSource("repo-source")!;
      expect(f.core.sourceScheduleBasis(registered.id, registered.configVersion, registered.leaseFence))
        .toMatchObject({ consecutiveFailures: 0, latestTerminal: { result: "success" } });
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect((db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts`).get() as { count: number }).count).toBe(0);
    } finally { f.cleanup(); }
  });
});

class FakeSchedulerCore implements ScheduledSourceCore {
  leaseOwner: string | null = null;
  expiresAt = 0;
  calls: string[] = [];
  plans = new Map<string, SourceScheduleBasis>();
  sync: (plan: SourceDuePlan) => Promise<unknown> = async (plan) => { this.calls.push(plan.sourceId); };
  constructor(public sources: KnowledgeSource[], private readonly clock: () => number) {
    for (const item of sources) this.plans.set(item.id, basis("failed", {
      latestTerminal: { sequence: 7, attemptedAt: 0, result: "failed" },
    }));
  }
  listSources(): KnowledgeSource[] { return this.sources; }
  sourceScheduleBasis(sourceId: string): SourceScheduleBasis { return this.plans.get(sourceId)!; }
  acquireSourceSchedulerLease(owner: string, now: number, leaseMs: number): boolean {
    if (this.leaseOwner && this.leaseOwner !== owner && this.expiresAt > now) return false;
    this.leaseOwner = owner; this.expiresAt = now + leaseMs; return true;
  }
  renewSourceSchedulerLease(owner: string, now: number, leaseMs: number): boolean {
    if (this.leaseOwner !== owner || this.expiresAt <= now) return false;
    this.expiresAt = now + leaseMs; return true;
  }
  assertSourceSchedulerLease(owner: string, now: number): boolean {
    return this.leaseOwner === owner && this.expiresAt > now;
  }
  releaseSourceSchedulerLease(owner: string): boolean {
    if (this.leaseOwner !== owner) return false;
    this.leaseOwner = null; return true;
  }
  async syncScheduledSource(plan: SourceDuePlan): Promise<unknown> { return this.sync(plan); }
}

describe("source scheduler handle", () => {
  it("isolates source failures and continues later due sources", async () => {
    let now = 100_000;
    const fake = new FakeSchedulerCore([source({ id: "a" }), source({ id: "b" })], () => now);
    fake.sync = async (plan) => { fake.calls.push(plan.sourceId); if (plan.sourceId === "a") throw new Error("broken"); };
    const errors: string[] = [];
    const scheduler = createSourceScheduler(fake, { owner: "owner", now: () => now, onError: (id) => errors.push(id!) });
    await scheduler.runOnce();
    expect(fake.calls).toEqual(["a", "b"]);
    expect(errors).toEqual(["a"]);
    await scheduler.stop();
  });

  it("fully drains recovery before starting ordinary interval work", async () => {
    let releaseRecovery!: () => void;
    const recoveryPending = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const fake = new FakeSchedulerCore([source({ id: "ordinary" }), source({ id: "recovery", refresh: { mode: "manual" } })], () => 100_000);
    fake.plans.set("recovery", basis(null, { removalIncomplete: true }));
    fake.sync = async (plan) => {
      fake.calls.push(plan.sourceId);
      if (plan.sourceId === "recovery") await recoveryPending;
    };
    const scheduler = createSourceScheduler(fake, { owner: "owner", now: () => 100_000 });
    const cycle = scheduler.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.calls).toEqual(["recovery"]);
    releaseRecovery();
    await cycle;
    expect(fake.calls).toEqual(["recovery", "ordinary"]);
    await scheduler.stop();
  });

  it("contains heartbeat exceptions, clears ownership, and tolerates an onError failure", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeSchedulerCore([source({ id: "a" })], () => 100_000);
    fake.sync = async () => { await pending; };
    let renewals = 0;
    const renew = fake.renewSourceSchedulerLease.bind(fake);
    fake.renewSourceSchedulerLease = (owner, now, leaseMs) => {
      renewals += 1;
      if (renewals > 1) throw new Error("heartbeat database failure");
      return renew(owner, now, leaseMs);
    };
    let heartbeat: (() => void) | null = null;
    const errors: unknown[] = [];
    const scheduler = createSourceScheduler(fake, {
      owner: "owner", now: () => 100_000,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      onError: (_sourceId, error) => { errors.push(error); throw new Error("reporting failed"); },
    });
    const cycle = scheduler.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat).not.toBeNull();
    expect(() => heartbeat!()).not.toThrow();
    expect(errors).toHaveLength(1);
    release();
    await cycle;
    await scheduler.stop();
    // The failed heartbeat cleared local ownership, so shutdown does not issue
    // a stale release against the durable row.
    expect(fake.leaseOwner).toBe("owner");
  });

  it("stops new work, awaits the in-flight bounded sync, releases its own lease, and unrefs timers", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = new FakeSchedulerCore([source({ id: "a" }), source({ id: "b" })], () => 100_000);
    fake.sync = async (plan) => { fake.calls.push(plan.sourceId); await pending; };
    let unrefCalled = false;
    const fakeTimer = { unref: () => { unrefCalled = true; } } as unknown as ReturnType<typeof setTimeout>;
    const scheduler = createSourceScheduler(fake, {
      owner: "owner", now: () => 100_000,
      setTimer: (() => fakeTimer) as unknown as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    scheduler.start();
    expect(unrefCalled).toBe(true);
    const cycle = scheduler.runOnce();
    await Promise.resolve();
    const stopped = scheduler.stop();
    const stoppedAgain = scheduler.stop();
    expect(stoppedAgain).toBe(stopped);
    await Promise.resolve();
    scheduler.start();
    expect(scheduler.running).toBe(false);
    expect(fake.calls).toEqual(["a"]);
    expect(fake.leaseOwner).toBe("owner");
    release();
    await cycle; await stopped; await stoppedAgain;
    expect(fake.calls).toEqual(["a"]);
    expect(fake.leaseOwner).toBeNull();
    expect(scheduler.running).toBe(false);
  });
});

describe("MCP scheduler lifecycle", () => {
  it("starts after attachment, stops before server close, and honors explicit/environment opt-out", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("close"); } } as unknown as McpServer;
    const fakeHandle = {
      running: false,
      start: () => { events.push("start"); },
      stop: async () => { events.push("stop"); },
      runOnce: async () => undefined,
    };
    const core = {} as MonetCore;
    expect(attachSourceSchedulerLifecycle(server, core, {
      sourceSchedulerFactory: () => fakeHandle,
    }, {})).toBe(fakeHandle);
    expect(events).toEqual(["start"]);
    await server.close();
    expect(events).toEqual(["start", "stop", "close"]);

    const disabled = { close: async () => undefined } as unknown as McpServer;
    expect(attachSourceSchedulerLifecycle(disabled, core, { sourceScheduler: false }, {})).toBeNull();
    expect(attachSourceSchedulerLifecycle(disabled, core, {}, { MONET_NO_SOURCE_SCHEDULER: "1" })).toBeNull();
  });

  it("stops once on peer transport close while preserving the installed close handler", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("close"); } } as unknown as McpServer;
    const transport = { onclose: () => { events.push("protocol-close"); } } as Transport;
    const fakeHandle = {
      running: false,
      start: () => { events.push("start"); },
      stop: async () => { events.push("stop"); },
      runOnce: async () => undefined,
    };
    attachSourceSchedulerLifecycle(server, {} as MonetCore, {
      sourceSchedulerFactory: () => fakeHandle,
    }, {}, transport);
    transport.onclose?.();
    await Promise.resolve();
    expect(events).toEqual(["start", "protocol-close", "stop"]);
    await server.close();
    expect(events).toEqual(["start", "protocol-close", "stop", "close"]);
  });
});

/**
 * Graceful-shutdown regression coverage (scheduler-lease liveness fix, 2026-07-16).
 *
 * A live two-process restart probe showed the replacement process picked up automatically only
 * after the FULL lease TTL + wake cadence (~120s worst case) following a graceful client.close(),
 * even though fencing/admission were already correct — the prior process exited before its lease
 * release committed. Root causes: (1) transport.onclose invoked stopOnce() fire-and-forget, and
 * nothing kept the event loop alive until it settled; (2) the executable entry path had no
 * SIGINT/SIGTERM shutdown hooks at all. These tests cover the fix for both.
 */
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * Fake setTimer/clearTimer pair for withShutdownBarrier, tracking every created/cleared handle.
 * Used by the double-barrier regression tests to assert deterministically that a barrier's timer
 * was created AND cleared, instead of a flaky wall-clock "it was prompt" measurement.
 */
function fakeBarrierTimers(): {
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  created: unknown[];
  cleared: unknown[];
} {
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  let nextId = 0;
  const setTimer = ((_cb: () => void) => {
    const handle = { id: nextId };
    nextId += 1;
    created.push(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((handle: unknown) => { cleared.push(handle); }) as unknown as typeof clearTimeout;
  return { setTimer, clearTimer, created, cleared };
}

/** Shared fake `process`-like object for the SIGINT/SIGTERM installer tests below. */
function fakeShutdownProcess(): {
  proc: ShutdownSignalProcess;
  exitCodes: number[];
  send: (signal: ShutdownSignal) => void;
} {
  const listeners: Record<ShutdownSignal, Array<() => void>> = { SIGINT: [], SIGTERM: [] };
  const exitCodes: number[] = [];
  const proc: ShutdownSignalProcess = {
    on: (event, listener) => { listeners[event].push(listener); },
    off: (event, listener) => { listeners[event] = listeners[event].filter((l) => l !== listener); },
    exit: (code) => { exitCodes.push(code ?? 0); },
  };
  return { proc, exitCodes, send: (signal) => { for (const listener of [...listeners[signal]]) listener(); } };
}

/** Shared fake stdin-like stream for the installStdinEofShutdown tests below. */
function fakeEofStream(): { stdin: EofStream; emit: (event: "end" | "close") => void } {
  const listeners: Record<"end" | "close", Array<() => void>> = { end: [], close: [] };
  const stdin: EofStream = {
    on: (event, listener) => { listeners[event].push(listener); },
    off: (event, listener) => { listeners[event] = listeners[event].filter((l) => l !== listener); },
  };
  return { stdin, emit: (event) => { for (const listener of [...listeners[event]]) listener(); } };
}

describe("withShutdownBarrier", () => {
  it("creates one referenced-timer handle, waits for work to settle, then clears that same handle", async () => {
    const created: Array<{ handle: { id: number }; ms: number }> = [];
    const cleared: unknown[] = [];
    let nextId = 0;
    const fakeSetTimer = ((cb: () => void, ms?: number) => {
      const handle = { id: nextId };
      nextId += 1;
      created.push({ handle, ms: ms ?? 0 });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimer = ((handle: unknown) => { cleared.push(handle); }) as unknown as typeof clearTimeout;

    let releaseWork!: () => void;
    const work = new Promise<void>((resolve) => { releaseWork = resolve; });
    let barrierSettled = false;
    void withShutdownBarrier(work, { deadlineMs: 30_000, setTimer: fakeSetTimer, clearTimer: fakeClearTimer })
      .then(() => { barrierSettled = true; });

    await flushMicrotasks();
    expect(created).toHaveLength(1);
    expect(created[0]!.ms).toBe(30_000); // the documented deadline, forwarded verbatim
    expect(cleared).toHaveLength(0); // work hasn't settled yet — must not clear (or resolve) early
    expect(barrierSettled).toBe(false);

    releaseWork();
    await flushMicrotasks();
    expect(cleared).toEqual([created[0]!.handle]); // cleared with the SAME handle setTimer returned
    expect(barrierSettled).toBe(true);
  });

  it("bounds the wait at the deadline when work never settles, and ignores the work settling afterward", async () => {
    let deadlineCb: (() => void) | null = null;
    const cleared: unknown[] = [];
    const fakeSetTimer = ((cb: () => void) => {
      deadlineCb = cb;
      return { id: "barrier" } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimer = ((handle: unknown) => { cleared.push(handle); }) as unknown as typeof clearTimeout;

    let releaseWork!: () => void;
    const work = new Promise<void>((resolve) => { releaseWork = resolve; });
    let barrierSettled = false;
    void withShutdownBarrier(work, { deadlineMs: 1, setTimer: fakeSetTimer, clearTimer: fakeClearTimer })
      .then(() => { barrierSettled = true; });

    await flushMicrotasks();
    expect(barrierSettled).toBe(false); // work is still pending; the fake deadline hasn't fired yet
    expect(deadlineCb).not.toBeNull();

    deadlineCb!(); // simulate the deadline elapsing — must not hang forever waiting on `work`
    await flushMicrotasks();
    expect(barrierSettled).toBe(true); // bounded — resolved even though `work` never settled
    expect(cleared).toHaveLength(1); // the deadline path itself clears its own (already-fired) timer

    // Late settlement of the underlying work (the drain finishing in the background after the
    // deadline gave up on it) must be a no-op: no throw, no double-resolve, no extra clear.
    expect(() => releaseWork()).not.toThrow();
    await flushMicrotasks();
    expect(cleared).toHaveLength(1);
  });
});

describe("installProcessShutdownHandlers", () => {
  it("SIGINT runs server.close() then core.close(), then exits with the conventional code 130", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server, core, { proc });
    send("SIGINT");
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]);
    expect(exitCodes).toEqual([130]); // 128 + SIGINT(2) — conventional signal exit status
  });

  it("SIGTERM runs server.close() then core.close(), then exits with the conventional code 143", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server, core, { proc });
    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]);
    expect(exitCodes).toEqual([143]); // 128 + SIGTERM(15) — conventional signal exit status
  });

  it("defers exit until an in-flight graceful shutdown (drain) resolves — never exits mid-drain", async () => {
    const events: string[] = [];
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const server = {
      close: async () => {
        events.push("drain start");
        await drainGate; // stands in for "scheduler drain + lease release still in flight"
        events.push("drain done");
      },
    } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server, core, { proc });
    send("SIGTERM");
    await flushMicrotasks();
    expect(events).toEqual(["drain start"]);
    expect(exitCodes).toEqual([]); // must NOT exit while the drain is still in flight

    releaseDrain();
    await flushMicrotasks();
    expect(events).toEqual(["drain start", "drain done", "core.close"]);
    expect(exitCodes).toEqual([143]); // exits only after drain (and core.close) complete
  });

  it("a second signal while shutdown is in flight forces an immediate exit without waiting", async () => {
    const events: string[] = [];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const server = {
      close: async () => {
        events.push("server.close start");
        await closeGate;
        events.push("server.close done");
      },
    } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server, core, { proc });
    send("SIGINT");
    await flushMicrotasks();
    expect(events).toEqual(["server.close start"]); // first shutdown in flight, waiting on the gate
    expect(exitCodes).toEqual([]); // not exited yet

    send("SIGTERM"); // impatient second signal — must force exit NOW rather than wait
    expect(exitCodes).toEqual([143]); // forced exit uses the SECOND signal's conventional code
    expect(events).toEqual(["server.close start"]); // core.close from the first sequence never ran

    // Let the original (abandoned) shutdown finish in the background — must not throw and must
    // not fire a second, redundant proc.exit() once it eventually settles.
    releaseClose();
    await flushMicrotasks();
    expect(events).toEqual(["server.close start", "server.close done", "core.close"]);
    expect(exitCodes).toEqual([143]); // still exactly one exit call
  });

  it("still closes core even if server.close() rejects (finally, not sequential) — audit nit", async () => {
    const events: string[] = [];
    const server = {
      close: async () => { events.push("server.close"); throw new Error("boom"); },
    } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server, core, { proc });
    send("SIGINT");
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]); // core.close ran despite the rejection
    expect(exitCodes).toEqual([130]); // withShutdownBarrier absorbs the rejection; still exits
  });

  it("a second install with the same proc is a no-op — no duplicate listeners, no duplicate exit (Review Major 2.1)", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server1, core1, { proc });
    installProcessShutdownHandlers(server2, core2, { proc }); // same proc — must be a no-op

    send("SIGINT");
    await flushMicrotasks();

    // Only the FIRST install's pair reacted — the second got no listeners at all.
    expect(events).toEqual(["server1.close", "core1.close"]);
    expect(exitCodes).toEqual([130]);
  });

  it("detaches its listeners once shutdown completes, so a fresh install on the same proc works again (Review Major 2.2)", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();

    installProcessShutdownHandlers(server1, core1, { proc });
    send("SIGINT");
    await flushMicrotasks();
    expect(events).toEqual(["server1.close", "core1.close"]);
    expect(exitCodes).toEqual([130]);

    // Fresh pair, same proc object — the idempotency guard must have been cleared by detach.
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installProcessShutdownHandlers(server2, core2, { proc });
    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "core1.close", "server2.close", "core2.close"]);
    expect(exitCodes).toEqual([130, 143]);
  });
});

describe("attachSourceSchedulerLifecycle transport-close barrier (durable lease)", () => {
  it("does not release the real scheduler lease until the in-flight stop settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-scheduler-shutdown-"));
    const db = join(root, "monet.db");
    const core = new MonetCore(db);
    let contender: MonetCore | null = null;
    // Declared outside the try so `finally` can always release it — a failed assertion above
    // must not leave the real (default 30s) barrier timer as the only thing keeping this test's
    // worker process from moving on (test-hygiene nit).
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    try {
      expect(core.acquireSourceSchedulerLease("owner-a", 1_000, 90_000)).toBe(true);

      const fakeHandle = {
        running: true,
        start: () => {},
        runOnce: async () => undefined,
        stop: async () => {
          await drainGate; // stands in for an in-flight sync cycle draining before release
          expect(core.releaseSourceSchedulerLease("owner-a")).toBe(true);
        },
      };
      const server = { close: async () => undefined } as unknown as McpServer;
      const transport = {} as Transport;

      attachSourceSchedulerLifecycle(server, core, { sourceSchedulerFactory: () => fakeHandle }, {}, transport);
      transport.onclose?.();
      await flushMicrotasks();

      // Drain hasn't settled — the durable lease must still be held (the analogue of "the
      // process is not yet free to exit").
      contender = new MonetCore(db);
      expect(contender.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(false);
      contender.close();
      contender = null;

      releaseDrain();
      await flushMicrotasks();

      // Released — a fresh contender can now acquire it immediately.
      contender = new MonetCore(db);
      expect(contender.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(true);
    } finally {
      releaseDrain(); // always release — safe to call twice (resolving an already-resolved promise is a no-op)
      contender?.close();
      core.close();
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * installStdinEofShutdown regression coverage (probe finding, 2026-07-16 round 2).
 *
 * A real two-process restart probe (6/6 runs) proved transport.onclose NEVER fires on a graceful
 * client stdio disconnect: the MCP SDK's StdioServerTransport only listens for 'data'/'error' on
 * process.stdin, so nothing ever calls transport.close() in reaction to stdin EOF. The child
 * exited from natural event-loop drain (code 0, ~7ms) with the durable lease row untouched, well
 * before the client's own SIGTERM/SIGKILL escalation (2s/4s) could ever land. installStdinEofShutdown
 * is the actual fix: it listens for stdin 'end'/'close' directly and drives the SAME memoized
 * graceful shutdown as the signal path.
 */
describe("installStdinEofShutdown", () => {
  it("stdin 'end' releases the real scheduler lease before the loop would be free to exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-scheduler-eof-"));
    const db = join(root, "monet.db");
    const core = new MonetCore(db);
    let contender: MonetCore | null = null;
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    try {
      expect(core.acquireSourceSchedulerLease("owner-a", 1_000, 90_000)).toBe(true);

      const fakeHandle = {
        running: true,
        start: () => {},
        runOnce: async () => undefined,
        stop: async () => {
          await drainGate; // stands in for an in-flight sync cycle draining before release
          expect(core.releaseSourceSchedulerLease("owner-a")).toBe(true);
        },
      };
      const server = { close: async () => undefined } as unknown as McpServer;
      const transport = {} as Transport;
      attachSourceSchedulerLifecycle(server, core, { sourceSchedulerFactory: () => fakeHandle }, {}, transport);

      const { stdin, emit } = fakeEofStream();
      installStdinEofShutdown(server, core, { stdin });

      emit("end"); // the graceful-disconnect trigger transport.onclose never gets
      await flushMicrotasks();

      // Drain hasn't settled — the durable lease must still be held.
      contender = new MonetCore(db);
      expect(contender.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(false);
      contender.close();
      contender = null;

      releaseDrain();
      await flushMicrotasks();

      // Released — a fresh contender can now acquire it immediately.
      contender = new MonetCore(db);
      expect(contender.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(true);
    } finally {
      releaseDrain();
      contender?.close();
      // installStdinEofShutdown's shared shutdown already closed `core` once the drain settled.
      try { core.close(); } catch { /* already closed by the EOF shutdown flow */ }
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stdin 'close' without a preceding 'end' also triggers shutdown (destroyed stream)", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { stdin, emit } = fakeEofStream();

    installStdinEofShutdown(server, core, { stdin });
    emit("close"); // no 'end' at all — mirrors an abnormally destroyed stream
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]);
  });

  it("a second install with the same stdin is a no-op", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    const { stdin, emit } = fakeEofStream();

    installStdinEofShutdown(server1, core1, { stdin });
    installStdinEofShutdown(server2, core2, { stdin }); // same stdin — must be a no-op

    emit("end");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "core1.close"]);
  });

  it("detaches its listeners once shutdown completes, so a fresh install on the same stdin works again", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const { stdin, emit } = fakeEofStream();

    installStdinEofShutdown(server1, core1, { stdin });
    emit("end");
    await flushMicrotasks();
    expect(events).toEqual(["server1.close", "core1.close"]);

    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installStdinEofShutdown(server2, core2, { stdin });
    emit("close");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "core1.close", "server2.close", "core2.close"]);
  });

  it("stdin EOF and a signal racing both converge on exactly one server.close()/core.close() execution", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    try {
      const closeCalls: string[] = [];
      const server = {
        close: async () => {
          closeCalls.push("server.close");
          await closeGate;
        },
      } as unknown as McpServer;
      let coreCloseCalls = 0;
      const core = { close: () => { coreCloseCalls += 1; } } as unknown as MonetCore;
      const { stdin, emit } = fakeEofStream();
      const { proc, exitCodes, send } = fakeShutdownProcess();

      installStdinEofShutdown(server, core, { stdin });
      installProcessShutdownHandlers(server, core, { proc });

      emit("end"); // EOF fires first...
      send("SIGTERM"); // ...then a signal races in before the shared close settles
      await flushMicrotasks();

      expect(closeCalls).toEqual(["server.close"]); // server.close() itself only ever ran once
      expect(coreCloseCalls).toBe(0); // still gated — nothing has settled yet
      expect(exitCodes).toEqual([]); // signal path hasn't exited yet either — same shared gate

      releaseClose();
      await flushMicrotasks();

      expect(closeCalls).toEqual(["server.close"]); // still exactly once
      expect(coreCloseCalls).toBe(1); // core.close() ran exactly once too
      expect(exitCodes).toEqual([143]); // the signal path still exits once the shared work settles
    } finally {
      releaseClose();
    }
  });
});

/**
 * Cross-installer detach coordination (Review round-3 Required 1 — reviewer's exact empirical
 * repro). Before this fix, detach() was per-installer but getGracefulShutdown was shared: if pair
 * 1 shut down via EOF only, installedEofStreams cleared but installedShutdownProcs still held
 * `process` (pair 1's signal-side detach never ran — its trigger never fired). A fresh
 * installProcessShutdownHandlers(server2, core2, {proc: same process}) for pair 2 would then
 * silently no-op, and a later SIGTERM would re-fire pair 1's memoized, already-settled shutdown
 * and exit the process — server2/core2 would never close. Symmetric the other way. Fixed by
 * registering each installer's detach via the shared shutdown's onSettled at INSTALL time, so it
 * runs for every installer sharing a (server, core) pair once ANY of them settles the shared work.
 */
describe("cross-installer detach coordination (Review round-3 Required 1)", () => {
  it("EOF-only shutdown of pair 1 does not leave the signal guard stuck — a fresh signal install for pair 2 on the same proc works", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();
    const { stdin, emit } = fakeEofStream();

    // Mirrors createMonetCoreMcpServer's automatic wiring: pair 1 gets BOTH installers, but is
    // shut down via EOF ONLY — its own signal installer's trigger never fires below.
    installProcessShutdownHandlers(server1, core1, { proc });
    installStdinEofShutdown(server1, core1, { stdin });

    emit("end");
    await flushMicrotasks();
    expect(events).toEqual(["server1.close", "core1.close"]);

    // Pair 2: a fresh install on the SAME proc, as would happen if a second
    // createMonetCoreMcpServer() ran in this process. Before the fix this would silently no-op
    // (the guard was still held by pair 1's never-triggered signal installer), and a later
    // SIGTERM would re-exit via pair 1's stale memoized shutdown without pair 2 ever closing.
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installProcessShutdownHandlers(server2, core2, { proc });

    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "core1.close", "server2.close", "core2.close"]);
    expect(exitCodes).toEqual([143]);
  });

  it("mirror: signal-only shutdown of pair 1 does not leave the EOF guard stuck — a fresh EOF install for pair 2 on the same stdin works", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const { proc, send } = fakeShutdownProcess();
    const { stdin, emit } = fakeEofStream();

    installProcessShutdownHandlers(server1, core1, { proc });
    installStdinEofShutdown(server1, core1, { stdin }); // its own trigger never fires below

    send("SIGINT"); // pair 1 shuts down via signal ONLY — never via EOF
    await flushMicrotasks();
    expect(events).toEqual(["server1.close", "core1.close"]);

    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installStdinEofShutdown(server2, core2, { stdin });

    emit("end");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "core1.close", "server2.close", "core2.close"]);
  });
});

describe("server/core pairing guard (Review round-3 Required 2)", () => {
  it("throws at install time if the same server is paired with a mismatched core", () => {
    const server = { close: async () => undefined } as unknown as McpServer;
    const coreA = { close: () => {} } as unknown as MonetCore;
    const coreB = { close: () => {} } as unknown as MonetCore;
    const { proc } = fakeShutdownProcess();
    const { stdin } = fakeEofStream();

    installProcessShutdownHandlers(server, coreA, { proc });
    // Cross-installer, same server, DIFFERENT core — must fail fast rather than silently keeping
    // coreA and never closing coreB.
    expect(() => installStdinEofShutdown(server, coreB, { stdin })).toThrow(/different MonetCore/);
  });
});

/**
 * Guard-pollution-on-throw regression (final micro-round). Both installers used to add to their
 * guard WeakSet BEFORE calling getGracefulShutdown, which can throw on a mismatched core. A
 * throwing call left installedShutdownProcs/installedEofStreams permanently holding that
 * proc/stdin with no listeners and no onSettled detach ever registered — so a SUBSEQUENT, CORRECT
 * install attempt on that same proc/stdin would silently no-op forever, and a real SIGTERM/EOF
 * would do nothing. Fixed by calling getGracefulShutdown before the WeakSet add.
 */
describe("guard is not polluted by a throwing install (final micro-round)", () => {
  it("a throwing install (mismatched core) does not leave the proc guard stuck — a subsequent correct install on the same proc still works", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const coreA = { close: () => { events.push("coreA.close"); } } as unknown as MonetCore;
    const coreB = { close: () => { events.push("coreB.close"); } } as unknown as MonetCore;

    // Establish server ↔ coreA pairing via a throwaway proc — only the pairing matters here, not
    // this installation's own listeners.
    const { proc: throwawayProc } = fakeShutdownProcess();
    installProcessShutdownHandlers(server, coreA, { proc: throwawayProc });

    // THE proc under test: fresh, not yet in any guard. Reusing `server` (already paired with
    // coreA) with a mismatched `coreB` makes getGracefulShutdown throw. Before the fix, `proc`
    // would already have been added to installedShutdownProcs by this point, permanently.
    const { proc, exitCodes, send } = fakeShutdownProcess();
    expect(() => installProcessShutdownHandlers(server, coreB, { proc })).toThrow(/different MonetCore/);

    // A CORRECT install on the SAME proc — a fresh, properly-paired server/core — must still
    // succeed (not be silently blocked by a guard the throwing call polluted).
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installProcessShutdownHandlers(server2, core2, { proc });

    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server2.close", "core2.close"]);
    expect(exitCodes).toEqual([143]);
  });

  it("a throwing install (mismatched core) does not leave the stdin guard stuck — a subsequent correct install on the same stdin still works", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const coreA = { close: () => { events.push("coreA.close"); } } as unknown as MonetCore;
    const coreB = { close: () => { events.push("coreB.close"); } } as unknown as MonetCore;

    const { stdin: throwawayStdin } = fakeEofStream();
    installStdinEofShutdown(server, coreA, { stdin: throwawayStdin });

    const { stdin, emit } = fakeEofStream();
    expect(() => installStdinEofShutdown(server, coreB, { stdin })).toThrow(/different MonetCore/);

    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installStdinEofShutdown(server2, core2, { stdin });

    emit("end");
    await flushMicrotasks();

    expect(events).toEqual(["server2.close", "core2.close"]);
  });
});

/**
 * Double-barrier regression coverage (Review Major 1).
 *
 * server.close() -> SDK Protocol.close() -> StdioServerTransport.close() SYNCHRONOUSLY
 * re-invokes the wrapped onclose (verified against @modelcontextprotocol/sdk@1.29.0
 * dist/esm/server/stdio.js:61), creating a SECOND withShutdownBarrier(stopOnce()) call. This is
 * safe only because stopOnce() is memoized (stopPromise ??= scheduler.stop()) — these tests
 * enforce that explicitly, for both ways into the close chain.
 */
describe("double-barrier regression — re-entrant onclose during a close chain (Review Major 1)", () => {
  it("explicit server.close(): the redundant re-entrant-onclose barrier creates and clears its own timer, and stops the scheduler exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-scheduler-double-close-"));
    const db = join(root, "monet.db");
    const core = new MonetCore(db);
    try {
      expect(core.acquireSourceSchedulerLease("owner-a", 1_000, 90_000)).toBe(true);
      let stopCalls = 0;
      const fakeHandle = {
        running: true,
        start: () => {},
        runOnce: async () => undefined,
        stop: async () => {
          stopCalls += 1;
          core.releaseSourceSchedulerLease("owner-a");
        },
      };
      const transport = {} as Transport;
      // Mirrors the real SDK: transport.close() synchronously re-invokes the wrapped onclose.
      transport.close = async () => { transport.onclose?.(); };
      const server = { close: async () => { await transport.close!(); } } as unknown as McpServer;
      const { setTimer, clearTimer, created, cleared } = fakeBarrierTimers();

      attachSourceSchedulerLifecycle(server, core, {
        sourceSchedulerFactory: () => fakeHandle,
        onCloseBarrier: { setTimer, clearTimer },
      }, {}, transport);

      await server.close(); // the OVERRIDDEN server.close() — the explicit-close path

      expect(stopCalls).toBe(1); // stopOnce() memoization absorbed the re-entrant onclose call
      // Deterministic in place of a wall-clock "it was prompt" measurement: the re-entrant
      // onclose's redundant barrier created its own timer (proving it actually ran) and cleared
      // that SAME timer once the already-resolved stopOnce() settled — nothing left dangling.
      expect(created).toHaveLength(1);
      expect(cleared).toHaveLength(created.length);
      expect(created.every((handle) => cleared.includes(handle))).toBe(true);
      expect(core.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(true); // released exactly once
    } finally {
      core.close();
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("EOF-entered equivalent: both the EOF path's own barrier and the redundant re-entrant-onclose barrier create and fully clear their timers, and stop the scheduler exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-scheduler-double-close-eof-"));
    const db = join(root, "monet.db");
    const core = new MonetCore(db);
    let contender: MonetCore | null = null;
    try {
      expect(core.acquireSourceSchedulerLease("owner-a", 1_000, 90_000)).toBe(true);
      let stopCalls = 0;
      const fakeHandle = {
        running: true,
        start: () => {},
        runOnce: async () => undefined,
        stop: async () => {
          stopCalls += 1;
          core.releaseSourceSchedulerLease("owner-a");
        },
      };
      const transport = {} as Transport;
      transport.close = async () => { transport.onclose?.(); };
      const server = { close: async () => { await transport.close!(); } } as unknown as McpServer;
      const { setTimer, clearTimer, created, cleared } = fakeBarrierTimers();

      attachSourceSchedulerLifecycle(server, core, {
        sourceSchedulerFactory: () => fakeHandle,
        onCloseBarrier: { setTimer, clearTimer },
      }, {}, transport);
      const { stdin, emit } = fakeEofStream();
      installStdinEofShutdown(server, core, { stdin, barrier: { setTimer, clearTimer } });

      emit("end"); // enters via the stdin-EOF seam instead of calling server.close() directly
      await flushMicrotasks();

      expect(stopCalls).toBe(1);
      // Two barrier layers are in play here — installStdinEofShutdown's own, and the re-entrant
      // onclose's redundant one — both must create AND fully clear their timers.
      expect(created).toHaveLength(2);
      expect(cleared).toHaveLength(created.length);
      expect(created.every((handle) => cleared.includes(handle))).toBe(true);
      // installStdinEofShutdown's shared shutdown already closed `core`'s own db handle by now
      // (getGracefulShutdown's finally) — check the release with a fresh handle on the same file.
      contender = new MonetCore(db);
      expect(contender.acquireSourceSchedulerLease("owner-b", 1_000, 90_000)).toBe(true);
    } finally {
      contender?.close();
      // installStdinEofShutdown's shared shutdown already closed `core` once settled.
      try { core.close(); } catch { /* already closed by the EOF shutdown flow */ }
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Codex P2 #1 — stale hooks on explicit close. If nothing ever calls getGracefulShutdown's
 * run() (e.g. an embedded host or test calls `await server.close()` directly, without a signal
 * or stdin EOF ever firing), the onSettled callbacks (each installer's detach) never ran — so the
 * real process/stdin kept their listeners registered against the now-closed server/core, and
 * installedShutdownProcs/installedEofStreams stayed stuck "installed" forever. A later factory
 * call for a FRESH server/core on the same proc/stdin would then silently skip installing
 * anything, and a subsequent real signal/EOF would target the STALE server/core instead of the
 * new one. Fixed by settleGracefulShutdownOnExplicitClose, wired automatically (outermost) in
 * createMonetCoreMcpServer.
 */
describe("settleGracefulShutdownOnExplicitClose (Codex P2 #1)", () => {
  it("explicit server.close() detaches both installers' listeners and clears their guards — a fresh install on the same proc/stdin targets the new pair", async () => {
    const events: string[] = [];
    const server1 = { close: async () => { events.push("server1.close"); } } as unknown as McpServer;
    const core1 = { close: () => { events.push("core1.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();
    const { stdin } = fakeEofStream();

    // Mirrors createMonetCoreMcpServer's automatic wiring order: both installers, then the
    // explicit-close settlement wrapper installed LAST/outermost.
    installProcessShutdownHandlers(server1, core1, { proc });
    installStdinEofShutdown(server1, core1, { stdin });
    settleGracefulShutdownOnExplicitClose(server1);

    // An embedder/test closes the server directly — no signal, no EOF ever fires.
    await server1.close();
    await flushMicrotasks();

    expect(events).toEqual(["server1.close"]); // core1.close must NOT run — the embedder owns that lifecycle

    // A fresh factory-style pair on the SAME proc/stdin: before the fix, both guards would still
    // be stuck "installed" (nothing ever detached), so these installs would silently no-op.
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installProcessShutdownHandlers(server2, core2, { proc });
    installStdinEofShutdown(server2, core2, { stdin });

    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server1.close", "server2.close", "core2.close"]); // targets the NEW pair
    expect(exitCodes).toEqual([143]);
  });

  it("explicit close during an in-flight trigger-driven run() does not double-fire onSettled or early-settle — run()'s own settle wins", async () => {
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    try {
      const events: string[] = [];
      let closePromise: Promise<void> | null = null;
      const server = {
        close: (): Promise<void> => {
          // Memoized, mirroring the REAL attachSourceSchedulerLifecycle-patched close (via
          // stopOnce()) — a second concurrent caller joins the SAME in-flight close rather than
          // re-running it.
          closePromise ??= (async () => {
            events.push("server.close start");
            await drainGate;
            events.push("server.close done");
          })();
          return closePromise;
        },
      } as unknown as McpServer;
      const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
      const { stdin, emit } = fakeEofStream();

      installStdinEofShutdown(server, core, { stdin });
      settleGracefulShutdownOnExplicitClose(server);

      emit("end"); // triggers run() — its internal server.close() call starts the (memoized) close
      await flushMicrotasks();
      expect(events).toEqual(["server.close start"]);

      // An explicit close call races in WHILE run() is still in flight — it joins the SAME
      // memoized close, and its own settle-wrapper must defer to run()'s (entry.promise is set).
      const explicitCloseSettled = server.close();
      await flushMicrotasks();
      expect(events).toEqual(["server.close start"]); // still gated on drainGate

      releaseDrain();
      await explicitCloseSettled;
      await flushMicrotasks();

      // run()'s OWN settle path won: core.close() DID run (contrast with a pure explicit-close
      // settle, which never closes core) — and it ran exactly once.
      expect(events).toEqual(["server.close start", "server.close done", "core.close"]);
    } finally {
      releaseDrain();
    }
  });

  it("explicit-close settlement does not close core — the embedder owns that lifecycle", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { stdin } = fakeEofStream();

    installStdinEofShutdown(server, core, { stdin }); // establishes the pairing; its own EOF never fires
    settleGracefulShutdownOnExplicitClose(server);

    await server.close();
    await flushMicrotasks();

    expect(events).toEqual(["server.close"]); // core.close must NOT have run
  });
});

/**
 * Codex P2 #2 — core.close() under in-flight tool calls. When SIGTERM/SIGINT or stdin EOF arrives
 * during a long-running MCP request (e.g. source_sync), server.close() only closes the transport
 * — it does not wait for active tool handlers to finish, so core.close() could close the SQLite
 * handle while that request continues after an await and later touches the database. Fixed by
 * getInFlightTracker: registerMonetCoreTools wraps every tool handler to increment/decrement it,
 * and getGracefulShutdown's run() awaits its bounded quiesce() between server.close() and
 * core.close().
 */
describe("in-flight MCP tool-call quiescence before core.close() (Codex P2 #2)", () => {
  it("defers core.close() until an in-flight tool handler finishes", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const tracker = getInFlightTracker(server);

    tracker.increment(); // simulates an in-flight tool call (e.g. source_sync) started before shutdown

    const { proc, send } = fakeShutdownProcess();
    installProcessShutdownHandlers(server, core, { proc });
    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server.close"]); // core.close must NOT run yet — the handler is still in flight
    expect(tracker.count).toBe(1);

    tracker.decrement(); // the handler finishes
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]);
  });

  it("a wedged handler: quiesce times out at the bound and core.close proceeds anyway", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const tracker = getInFlightTracker(server);
    tracker.increment(); // never decremented — simulates a wedged handler that never returns

    let deadlineCb: (() => void) | null = null;
    const fakeSetTimer = ((cb: () => void) => {
      deadlineCb = cb;
      return { id: "quiesce" } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimer = (() => undefined) as unknown as typeof clearTimeout;

    const { proc, send } = fakeShutdownProcess();
    installProcessShutdownHandlers(server, core, {
      proc,
      quiesce: { setTimer: fakeSetTimer, clearTimer: fakeClearTimer },
    });
    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server.close"]); // still waiting on the wedged handler
    expect(deadlineCb).not.toBeNull();

    deadlineCb!(); // simulate the quiesce deadline elapsing
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]); // proceeds despite the still-in-flight handler
  });

  it("no in-flight calls adds no delay — quiesce resolves without ever creating a timer", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    let setTimerCalls = 0;
    const fakeSetTimer = (() => {
      setTimerCalls += 1;
      return { id: "unused" } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const { proc, send } = fakeShutdownProcess();
    installProcessShutdownHandlers(server, core, {
      proc,
      quiesce: { setTimer: fakeSetTimer },
    });
    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server.close", "core.close"]);
    expect(setTimerCalls).toBe(0); // the quiesce fast path never touches the timer at all
  });
});

/**
 * Codex pass-3 P2 — the third settle-family member. Moving both installers before connect()
 * (round 2) means a failed createMonetCoreMcpServer() startup (e.g. server.connect() rejects)
 * leaves the installers already registered against a server that is never returned to the caller
 * — and since attachSourceSchedulerLifecycle and settleGracefulShutdownOnExplicitClose both run
 * AFTER connect(), neither ever got a chance to run either. Without a settle path for this case,
 * the real process/stdin listeners and their guards (installedShutdownProcs/installedEofStreams)
 * would stay stuck "installed" forever: a retry's fresh createMonetCoreMcpServer() call on the
 * same proc/stdin would silently skip installing anything, and a later real signal/EOF would
 * target the failed server/core instead of the retry. Fixed by
 * settleGracefulShutdownOnStartupFailure, called from createMonetCoreMcpServer's own catch block.
 */
describe("settleGracefulShutdownOnStartupFailure (Codex pass-3 P2 — third settle-family member)", () => {
  it("detaches both installers' listeners and clears both guards — a fresh install on the same proc/stdin targets the new pair, and the failed server's coordinator entry is genuinely gone", async () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { proc, exitCodes, send } = fakeShutdownProcess();
    const { stdin } = fakeEofStream();

    // Mirrors createMonetCoreMcpServer's automatic wiring: both installers ran, but startup never
    // reached connect()/attachSourceSchedulerLifecycle/settleGracefulShutdownOnExplicitClose.
    installProcessShutdownHandlers(server, core, { proc });
    installStdinEofShutdown(server, core, { stdin });

    settleGracefulShutdownOnStartupFailure(server);

    expect(events).toEqual([]); // core.close must NOT run — the caller still owns core

    // Both guards must be clear: a fresh, DIFFERENT server/core pair installs on the SAME
    // proc/stdin without being silently skipped, and it's what actually fires.
    const server2 = { close: async () => { events.push("server2.close"); } } as unknown as McpServer;
    const core2 = { close: () => { events.push("core2.close"); } } as unknown as MonetCore;
    installProcessShutdownHandlers(server2, core2, { proc });
    installStdinEofShutdown(server2, core2, { stdin });

    send("SIGTERM");
    await flushMicrotasks();

    expect(events).toEqual(["server2.close", "core2.close"]); // targets the NEW pair, not the failed one
    expect(exitCodes).toEqual([143]);

    // The coordinator entry for the FAILED server is genuinely gone, not just guard-cleared: a
    // fresh install on the SAME (failed) server object with a DIFFERENT core does not throw the
    // round-3 mismatch guard — proving getGracefulShutdown created a brand-new entry rather than
    // finding a stale one still paired with the original core.
    const { proc: proc3 } = fakeShutdownProcess();
    const mismatchedCore = { close: () => {} } as unknown as MonetCore;
    expect(() => installProcessShutdownHandlers(server, mismatchedCore, { proc: proc3 })).not.toThrow();
  });

  it("defers to an already-in-flight trigger-driven run() instead of double-firing", async () => {
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    try {
      const events: string[] = [];
      const server = {
        close: async () => {
          events.push("server.close start");
          await drainGate;
          events.push("server.close done");
        },
      } as unknown as McpServer;
      const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
      const { stdin, emit } = fakeEofStream();

      installStdinEofShutdown(server, core, { stdin });

      emit("end"); // a trigger fires WHILE startup is still (hypothetically) in flight
      await flushMicrotasks();
      expect(events).toEqual(["server.close start"]); // run() has started and is gated

      // The startup-failure cleanup runs while that trigger-driven run() is still in flight —
      // must defer to run()'s own settle rather than pre-empting or double-firing it.
      settleGracefulShutdownOnStartupFailure(server);
      await flushMicrotasks();
      expect(events).toEqual(["server.close start"]); // unaffected — still gated

      releaseDrain();
      await flushMicrotasks();

      // run()'s own path completed normally, including core.close() — proving the startup-failure
      // cleanup deferred rather than early-settling or double-firing.
      expect(events).toEqual(["server.close start", "server.close done", "core.close"]);
    } finally {
      releaseDrain();
    }
  });

  it("does not close core — the caller owns that lifecycle on the failure path", () => {
    const events: string[] = [];
    const server = { close: async () => { events.push("server.close"); } } as unknown as McpServer;
    const core = { close: () => { events.push("core.close"); } } as unknown as MonetCore;
    const { stdin } = fakeEofStream();

    installStdinEofShutdown(server, core, { stdin }); // establishes the pairing; its own EOF never fires
    settleGracefulShutdownOnStartupFailure(server);

    expect(events).toEqual([]); // core.close must NOT have run
  });
});

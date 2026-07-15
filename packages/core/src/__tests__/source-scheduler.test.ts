import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MonetCore } from "../engine";
import { attachSourceSchedulerLifecycle } from "../mcp-server";
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

import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeSource, SourceScheduleStatus, SourceSyncRunResult } from "./source-types";
import type { SourceScheduleBasis } from "./source-ledger";

export const SOURCE_SCHEDULER_MAX_WAKE_MS = 30_000;
export const SOURCE_SCHEDULER_DEFAULT_LEASE_MS = 90_000;

export interface SourceDuePlan extends SourceScheduleStatus {
  sourceId: string;
  due: boolean;
  attemptSequence: number;
  configVersion: number;
  leaseFence: number;
  recovery: boolean;
}

export interface PlanSourceDueInput {
  source: Pick<KnowledgeSource, "id" | "lifecycle" | "refresh" | "configVersion" | "leaseFence">;
  basis: SourceScheduleBasis;
  now: number;
  startupAt: number;
}

function deterministicOffset(key: string, maximumInclusive: number): number {
  if (maximumInclusive <= 0) return 0;
  const bytes = createHash("sha256").update(key).digest();
  const value = bytes.readUInt32BE(0);
  return value % (maximumInclusive + 1);
}

function cappedBackoff(intervalMs: number, streak: number): number {
  let value = 30_000;
  for (let index = 1; index < streak && value < intervalMs; index += 1) value = Math.min(intervalMs, value * 2);
  return Math.min(intervalMs, value);
}

/** Pure deterministic planner. Old-fence events never enter the supplied durable basis. */
export function planSourceDue(input: PlanSourceDueInput): SourceDuePlan {
  const { source, basis, now } = input;
  const recovery = basis.resumable || basis.removalIncomplete;
  const base = {
    sourceId: source.id,
    attemptSequence: basis.attemptSequence,
    configVersion: source.configVersion,
    leaseFence: source.leaseFence,
    consecutiveFailures: basis.consecutiveFailures,
    recovery,
  };
  if (recovery) return { ...base, state: "recovering", due: true, nextAttemptAt: now };
  if (source.lifecycle !== "active" || source.refresh.mode === "manual") {
    return { ...base, state: "manual", due: false };
  }
  const intervalMs = source.refresh.intervalSeconds! * 1000;
  const key = `${source.id}\0${source.configVersion}\0${source.leaseFence}\0${basis.attemptSequence}`;
  if (!basis.latestTerminal) {
    if (input.startupAt > now) {
      return { ...base, state: "due", due: true, nextAttemptAt: 0 };
    }
    const spread = Math.min(30_000, Math.floor(intervalMs * 0.1));
    const nextAttemptAt = input.startupAt + deterministicOffset(`${key}\0initial`, spread);
    return { ...base, state: nextAttemptAt <= now ? "due" : "scheduled", due: nextAttemptAt <= now, nextAttemptAt };
  }
  const failed = basis.latestTerminal.result !== "success";
  // A durable wall-clock value ahead of the current clock cannot be used as a
  // moving anchor: clamping it to `now` on every wake would postpone forever.
  // Zero is a fixed, deterministic sentinel and is immediately due for every
  // valid scheduler clock.
  if (basis.latestTerminal.attemptedAt > now) {
    return { ...base, state: "due", due: true, nextAttemptAt: 0 };
  }
  const delay = failed ? cappedBackoff(intervalMs, Math.max(1, basis.consecutiveFailures)) : intervalMs;
  const jitterMaximum = failed ? Math.floor(delay * 0.1) : Math.min(30_000, Math.floor(intervalMs * 0.1));
  const anchor = basis.latestTerminal.attemptedAt;
  const nextAttemptAt = anchor + delay + deterministicOffset(`${key}\0${failed ? "retry" : "normal"}`, jitterMaximum);
  const due = nextAttemptAt <= now;
  return { ...base, state: due ? "due" : failed ? "backoff" : "scheduled", due, nextAttemptAt };
}

export interface ScheduledSourceCore {
  listSources(options: { includeTombstoned: true }): KnowledgeSource[];
  sourceScheduleBasis(sourceId: string, configVersion: number, leaseFence: number): SourceScheduleBasis;
  acquireSourceSchedulerLease(owner: string, now: number, leaseMs: number): boolean;
  renewSourceSchedulerLease(owner: string, now: number, leaseMs: number): boolean;
  assertSourceSchedulerLease(owner: string, now: number): boolean;
  releaseSourceSchedulerLease(owner: string): boolean;
  syncScheduledSource(
    plan: SourceDuePlan,
    startupAt: number,
    now: () => number,
    assertLeaseOwner: () => boolean,
  ): Promise<unknown>;
}

export interface SourceSchedulerOptions {
  owner?: string;
  now?: () => number;
  leaseMs?: number;
  wakeMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  onError?: (sourceId: string | null, error: unknown) => void;
}

export interface SourceSchedulerHandle {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
  readonly running: boolean;
}

export function createSourceScheduler(core: ScheduledSourceCore, options: SourceSchedulerOptions = {}): SourceSchedulerHandle {
  const owner = options.owner ?? randomUUID();
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? SOURCE_SCHEDULER_DEFAULT_LEASE_MS;
  const wakeMs = Math.min(SOURCE_SCHEDULER_MAX_WAKE_MS, Math.max(1, options.wakeMs ?? SOURCE_SCHEDULER_MAX_WAKE_MS));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const setHeartbeat = options.setInterval ?? setInterval;
  const clearHeartbeat = options.clearInterval ?? clearInterval;
  const startupAt = now();
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cycle: Promise<void> | null = null;
  let ownsLease = false;
  let stopPromise: Promise<void> | null = null;

  const report = (sourceId: string | null, error: unknown): void => {
    try { options.onError?.(sourceId, error); } catch { /* Error reporting must never crash the scheduler. */ }
  };
  const assertLeaseOwner = (): boolean => {
    if (!ownsLease) return false;
    try {
      const owned = core.assertSourceSchedulerLease(owner, now());
      if (!owned) ownsLease = false;
      return owned;
    } catch (error) {
      ownsLease = false;
      report(null, error);
      return false;
    }
  };
  const acquire = (): boolean => {
    try {
      if (ownsLease && core.renewSourceSchedulerLease(owner, now(), leaseMs)) return true;
      ownsLease = false;
      ownsLease = core.acquireSourceSchedulerLease(owner, now(), leaseMs);
      return ownsLease;
    } catch (error) {
      ownsLease = false;
      report(null, error);
      return false;
    }
  };
  const renew = (): boolean => {
    if (!assertLeaseOwner()) return false;
    try {
      const renewed = core.renewSourceSchedulerLease(owner, now(), leaseMs);
      if (!renewed) ownsLease = false;
      return renewed;
    } catch (error) {
      ownsLease = false;
      report(null, error);
      return false;
    }
  };
  const schedule = (): void => {
    if (!started || stopping || timer) return;
    timer = setTimer(() => { timer = null; void kick(); }, wakeMs);
    timer.unref?.();
  };
  const execute = async (): Promise<void> => {
    if (!acquire()) return;
    const plans = core.listSources({ includeTombstoned: true }).map((source) => planSourceDue({
      source,
      basis: core.sourceScheduleBasis(source.id, source.configVersion, source.leaseFence),
      now: now(),
      startupAt,
    })).filter((plan) => plan.due).sort((left, right) =>
      Number(right.recovery) - Number(left.recovery)
      || (left.nextAttemptAt ?? 0) - (right.nextAttemptAt ?? 0)
      || left.sourceId.localeCompare(right.sourceId),
    );
    const heartbeat = setHeartbeat(() => {
      if (ownsLease) renew();
    }, Math.max(1, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    const drain = async (selected: SourceDuePlan[]): Promise<boolean> => {
      for (const plan of selected) {
        if (stopping || !renew()) return false;
        try { await core.syncScheduledSource(plan, startupAt, now, assertLeaseOwner); }
        catch (error) { report(plan.sourceId, error); }
        if (!assertLeaseOwner()) return false;
      }
      return true;
    };
    try {
      // Recovery/removal is a true barrier: ordinary interval work starts only
      // after every recovery plan has settled.
      if (await drain(plans.filter((plan) => plan.recovery))) {
        await drain(plans.filter((plan) => !plan.recovery));
      }
    }
    finally { clearHeartbeat(heartbeat); }
  };
  const kick = async (): Promise<void> => {
    if (cycle) return cycle;
    cycle = execute().catch((error) => report(null, error)).finally(() => {
      cycle = null;
      schedule();
    });
    return cycle;
  };
  return {
    get running() { return started && !stopping; },
    start() {
      if (started || stopping || stopPromise) return;
      started = true;
      // A zero-delay timer starts the first cycle after MCP connect returns.
      timer = setTimer(() => { timer = null; void kick(); }, 0);
      timer.unref?.();
    },
    async runOnce() {
      if (stopping) { if (stopPromise) await stopPromise; return; }
      await kick();
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      started = false;
      if (timer) { clearTimer(timer); timer = null; }
      stopPromise = (async () => {
        try {
          // Yield once so `stopPromise` is installed before a no-work drain can settle.
          await Promise.resolve();
          if (cycle) await cycle;
          if (ownsLease) {
            try { core.releaseSourceSchedulerLease(owner); }
            catch (error) { report(null, error); }
            ownsLease = false;
          }
        } finally {
          ownsLease = false;
          stopping = false;
          stopPromise = null;
        }
      })();
      return stopPromise;
    },
  };
}

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";

interface SlidingWindowEntry {
  timestamps: number[];
}

const windows = new Map<string, SlidingWindowEntry>();

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 300_000;
let lastCleanup = Date.now();

function cleanup(now: number, windowMs: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of windows) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
    if (entry.timestamps.length === 0) {
      windows.delete(key);
    }
  }
}

function currentRateLimitConfig() {
  return {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  };
}

export function checkRateLimit(
  agentId: string,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const { maxRequests, windowMs } = currentRateLimitConfig();
  const now = Date.now();

  cleanup(now, windowMs);

  let entry = windows.get(agentId);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(agentId, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((oldestInWindow + windowMs - now) / 1000),
    };
  }

  entry.timestamps.push(now);
  return { allowed: true };
}

export const rateLimitMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const agent = c.get("agent");
  if (!agent) {
    await next();
    return;
  }

  const result = checkRateLimit(agent.id);
  if (!result.allowed) {
    c.header("Retry-After", String(result.retryAfterSeconds));
    return c.json(
      { error: "rate_limited", message: "Too many requests" },
      429,
    );
  }

  await next();
});

/**
 * Reset all rate limit state. Used in tests.
 */
export function resetRateLimits(): void {
  windows.clear();
}

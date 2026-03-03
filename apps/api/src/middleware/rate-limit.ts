import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.js";

interface SlidingWindowEntry {
  timestamps: number[];
}

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

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

export const rateLimitMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const agent = c.get("agent");
  if (!agent) {
    await next();
    return;
  }

  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
  const now = Date.now();

  cleanup(now, windowMs);

  // Key by agent ID (unique per API key holder)
  const key = agent.id;

  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= maxRequests) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);

    c.header("Retry-After", String(retryAfterSeconds));
    return c.json(
      { error: "rate_limited", message: "Too many requests" },
      429,
    );
  }

  entry.timestamps.push(now);

  await next();
});

/**
 * Reset all rate limit state. Used in tests.
 */
export function resetRateLimits(): void {
  windows.clear();
}

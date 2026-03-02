import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimitMiddleware, resetRateLimits } from "../middleware/rate-limit.js";
import type { AppEnv } from "../middleware/context.js";

function createTestApp(agentId: string) {
  const app = new Hono<AppEnv>();

  // Inject mock agent context
  app.use("*", async (c, next) => {
    c.set("agent", {
      id: agentId,
      externalId: "test",
      tenantId: "tenant-1",
      isAutonomous: false,
      userId: null,
      role: null,
    });
    await next();
  });

  app.use("*", rateLimitMiddleware);

  app.get("/test", (c) => c.json({ ok: true }));

  return app;
}

describe("rate-limit middleware", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows requests under the limit", async () => {
    const app = createTestApp("agent-1");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("returns 429 when rate limit exceeded", async () => {
    const app = createTestApp("agent-1");

    // Send 100 requests (the limit)
    for (let i = 0; i < 100; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }

    // 101st should be rate limited
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("includes Retry-After header on 429", async () => {
    const app = createTestApp("agent-1");

    for (let i = 0; i < 100; i++) {
      await app.request("/test");
    }

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("tracks limits independently per agent", async () => {
    const app1 = createTestApp("agent-1");
    const app2 = createTestApp("agent-2");

    // Exhaust agent-1's limit
    for (let i = 0; i < 100; i++) {
      await app1.request("/test");
    }
    const res1 = await app1.request("/test");
    expect(res1.status).toBe(429);

    // agent-2 should still be fine
    const res2 = await app2.request("/test");
    expect(res2.status).toBe(200);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  closeTestDb,
  getTestApp,
  provisionTestTenant,
} from "./helpers/setup.js";

describe("rate limit integration", () => {
  const app = getTestApp();
  let apiKey: string;

  beforeEach(async () => {
    await cleanupTestData();
    process.env.RATE_LIMIT_MAX = "100";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const { body } = await provisionTestTenant({ name: "rate-limit-test" });
    apiKey = body.apiKey as string;
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await cleanupTestData();
    await closeTestDb();
  });

  it("returns 429 on the 101st authenticated request", async () => {
    for (let i = 0; i < 100; i += 1) {
      const res = await app.request("/api/agents/me", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.status).toBe(200);
    }

    const limited = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTestData,
  closeTestDb,
  getTestApp,
  provisionTestTenant,
} from "./helpers/setup.js";

const ADMIN_SECRET = "test-admin-secret-for-ci";

describe("logging integration", () => {
  const app = getTestApp();
  let apiKey: string;

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
  });

  beforeEach(async () => {
    await cleanupTestData();
    const { body } = await provisionTestTenant(app, "logging-test", ADMIN_SECRET);
    apiKey = body.apiKey as string;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("does not log the raw Authorization bearer token", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const output = spy.mock.calls.flat().join("\n");
    expect(output).not.toContain(apiKey);

    spy.mockRestore();
  });
});

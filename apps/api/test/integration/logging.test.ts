import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTestData,
  closeTestDb,
  getTestApp,
  provisionTestTenant,
} from "./helpers/setup";

describe("logging integration", () => {
  const app = getTestApp();
  let apiKey: string;

  beforeEach(async () => {
    await cleanupTestData();
    const { body } = await provisionTestTenant({ name: "logging-test" });
    apiKey = body.apiKey as string;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("does not log the raw Authorization bearer token", async () => {
    const previousForceLogs = process.env.FORCE_REQUEST_LOGS;
    process.env.FORCE_REQUEST_LOGS = "true";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.headers.get("x-request-id")).toBeTruthy();

    const output = spy.mock.calls.flat().join("\n");
    expect(output).not.toContain(apiKey);

    const requestLogLine = output
      .split("\n")
      .find((line) => line.includes("\"path\":\"/api/agents/me\""));
    expect(requestLogLine).toBeDefined();

    const parsed = JSON.parse(requestLogLine ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "info",
      message: "http_request",
      method: "GET",
      path: "/api/agents/me",
      statusCode: 200,
    });
    expect(typeof parsed.requestId).toBe("string");
    expect(typeof parsed.latencyMs).toBe("number");
    expect(typeof parsed.tenantId).toBe("string");
    expect(typeof parsed.agentId).toBe("string");

    spy.mockRestore();
    if (previousForceLogs === undefined) {
      delete process.env.FORCE_REQUEST_LOGS;
    } else {
      process.env.FORCE_REQUEST_LOGS = previousForceLogs;
    }
  });
});

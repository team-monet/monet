import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup.js";

const ADMIN_SECRET = "test-admin-secret-for-ci";

describe("auth flow integration", () => {
  const app = getTestApp();

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("provisions a tenant and returns a working API key", async () => {
    const { res, body } = await provisionTestTenant(app, "test-org", ADMIN_SECRET);
    expect(res.status).toBe(201);
    expect(body.tenant).toBeDefined();
    expect(body.apiKey).toBeDefined();

    const apiKey = body.apiKey as string;
    expect(apiKey.startsWith("mnt_")).toBe(true);

    // Use the API key to access /api/agents/me
    const meRes = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.externalId).toBe("admin@test-org");
    expect(meBody.tenantId).toBeDefined();
  });

  it("registers a second agent using the first agent's key", async () => {
    const { body } = await provisionTestTenant(app, "test-org-2", ADMIN_SECRET);
    const firstKey = body.apiKey as string;

    // Register second agent
    const registerRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${firstKey}`,
      },
      body: JSON.stringify({ externalId: "agent-2" }),
    });
    expect(registerRes.status).toBe(201);
    const registerBody = await registerRes.json();
    expect(registerBody.agent.externalId).toBe("agent-2");
    expect(registerBody.apiKey).toBeDefined();

    // Second agent can authenticate
    const meRes = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${registerBody.apiKey}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.externalId).toBe("agent-2");
  });

  it("returns 401 for an invalid API key", async () => {
    const res = await app.request("/api/agents/me", {
      headers: { Authorization: "Bearer mnt_invalid.key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing Authorization header", async () => {
    const res = await app.request("/api/agents/me");
    expect(res.status).toBe(401);
  });

  it("returns 403 for wrong admin secret on tenant creation", async () => {
    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-secret",
      },
      body: JSON.stringify({ name: "bad-tenant" }),
    });
    expect(res.status).toBe(403);
  });
});

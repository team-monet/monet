import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup";

describe("auth flow integration", () => {
  const app = getTestApp();

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("provisions a tenant and returns a working API key", async () => {
    const { res, body } = await provisionTestTenant({ name: "test-org" });
    expect(res.status).toBe(201);
    expect(body.tenant).toBeDefined();
    expect(body.tenant.slug).toBe("test-org");
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

  it("accepts a custom tenant slug and uses it for the bootstrap admin", async () => {
    const { res, body } = await provisionTestTenant({
      name: "Acme Corporation",
      slug: "acme",
    });
    expect(res.status).toBe(201);
    expect(body.tenant.slug).toBe("acme");

    const meRes = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${body.apiKey}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.externalId).toBe("admin@acme");
  });

  it("registers a second agent using the first agent's key", async () => {
    const { body } = await provisionTestTenant({ name: "test-org-2" });
    const firstKey = body.apiKey as string;
    const defaultGroupId = body.defaultGroupId as string;

    // Register second agent
    const registerRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${firstKey}`,
      },
      body: JSON.stringify({ externalId: "agent-2", groupId: defaultGroupId }),
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
    const { body } = await provisionTestTenant({ name: "invalid-key-tenant" });
    const tenantSlug = (body.tenant as { slug: string }).slug;

    const res = await app.request(`/api/tenants/${tenantSlug}/agents/me`, {
      headers: { Authorization: "Bearer mnt_invalid.key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing Authorization header", async () => {
    const { body } = await provisionTestTenant({ name: "missing-auth-tenant" });
    const tenantSlug = (body.tenant as { slug: string }).slug;

    const res = await app.request(`/api/tenants/${tenantSlug}/agents/me`);
    expect(res.status).toBe(401);
  });

  it("does not expose the deprecated tenant provisioning route", async () => {
    const { body } = await provisionTestTenant({ name: "tenant-with-auth" });
    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${body.apiKey as string}`,
      },
      body: JSON.stringify({ name: "bad-tenant" }),
    });
    expect(res.status).toBe(404);
  });
});

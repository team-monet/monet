import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup.js";

const ADMIN_SECRET = "test-admin-secret-for-ci";

describe("groups integration", () => {
  const app = getTestApp();
  let adminKey: string;
  let tenantId: string;

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
  });

  beforeEach(async () => {
    await cleanupTestData();
    const { body } = await provisionTestTenant(app, "group-test", ADMIN_SECRET);
    adminKey = body.apiKey as string;
    tenantId = (body.tenant as { id: string }).id;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  function authHeaders(key = adminKey) {
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  it("tenant admin can create a group", async () => {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "engineering", description: "Engineering team" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("engineering");
    expect(body.id).toBeDefined();
  });

  it("non-admin agent cannot create a group", async () => {
    // Register a second (non-admin) agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "regular-agent" }),
    });
    const regBody = await regRes.json();
    const regularKey = regBody.apiKey as string;

    const res = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(regularKey),
      body: JSON.stringify({ name: "forbidden-group" }),
    });
    expect(res.status).toBe(403);
  });

  it("admin can add and remove members", async () => {
    // Create group
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "team" }),
    });
    const group = await groupRes.json();
    const groupId = group.id as string;

    // Register an agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "member-agent" }),
    });
    const regBody = await regRes.json();
    const memberId = regBody.agent.id as string;

    // Add member
    const addRes = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId: memberId }),
    });
    expect(addRes.status).toBe(201);

    // List members
    const listRes = await app.request(`/api/groups/${groupId}/members`, {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.members).toHaveLength(1);
    expect(listBody.members[0].externalId).toBe("member-agent");

    // Remove member
    const removeRes = await app.request(
      `/api/groups/${groupId}/members/${memberId}`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(removeRes.status).toBe(200);

    // Verify removed
    const listRes2 = await app.request(`/api/groups/${groupId}/members`, {
      headers: authHeaders(),
    });
    const listBody2 = await listRes2.json();
    expect(listBody2.members).toHaveLength(0);
  });

  it("adding duplicate member returns 409", async () => {
    // Create group
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "dup-test" }),
    });
    const group = await groupRes.json();

    // Register agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "dup-agent" }),
    });
    const regBody = await regRes.json();

    // Add member twice
    await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId: regBody.agent.id }),
    });

    const dupRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId: regBody.agent.id }),
    });
    expect(dupRes.status).toBe(409);
  });

  it("list groups returns all tenant groups", async () => {
    await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "group-a" }),
    });
    await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "group-b" }),
    });

    const res = await app.request("/api/groups", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2);
  });
});

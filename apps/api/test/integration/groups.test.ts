import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup";

describe("groups integration", () => {
  const app = getTestApp();
  let adminKey: string;
  let tenantId: string;
  let defaultGroupId: string;

  beforeEach(async () => {
    await cleanupTestData();
    const { body } = await provisionTestTenant({ name: "group-test" });
    adminKey = body.apiKey as string;
    tenantId = (body.tenant as { id: string }).id;
    defaultGroupId = body.defaultGroupId as string;
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
      body: JSON.stringify({ externalId: "regular-agent", groupId: defaultGroupId }),
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

  it("admin can move members and cannot remove the final group", async () => {
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
      body: JSON.stringify({ externalId: "member-agent", groupId: defaultGroupId }),
    });
    const regBody = await regRes.json();
    const memberId = regBody.agent.id as string;

    // Add member
    const addRes = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId: memberId }),
    });
    expect(addRes.status).toBe(200);

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
    expect(removeRes.status).toBe(409);

    // Verify the agent still has a group assignment
    const listRes2 = await app.request(`/api/groups/${groupId}/members`, {
      headers: authHeaders(),
    });
    const listBody2 = await listRes2.json();
    expect(listBody2.members).toHaveLength(1);
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
      body: JSON.stringify({ externalId: "dup-agent", groupId: defaultGroupId }),
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
    expect(body.groups).toHaveLength(3);
  });

  it("tenant admin can promote a user to group_admin", async () => {
    const sql = getTestSql();
    const [user] = await sql`
      INSERT INTO human_users (external_id, tenant_id, role)
      VALUES ('user-promote', ${tenantId}, 'user')
      RETURNING id
    `;

    const res = await app.request(`/api/groups/users/${user.id}/admin`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ role: "group_admin" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("group_admin");
  });

  it("non-admin cannot promote a user", async () => {
    const sql = getTestSql();
    const [user] = await sql`
      INSERT INTO human_users (external_id, tenant_id, role)
      VALUES ('user-no-promote', ${tenantId}, 'user')
      RETURNING id
    `;

    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "regular-agent", groupId: defaultGroupId }),
    });
    const regBody = await regRes.json();
    const regularKey = regBody.apiKey as string;

    const res = await app.request(`/api/groups/users/${user.id}/admin`, {
      method: "POST",
      headers: authHeaders(regularKey),
      body: JSON.stringify({ role: "group_admin" }),
    });
    expect(res.status).toBe(403);
  });
});

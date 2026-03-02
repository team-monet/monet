import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup.js";
import { withTenantScope } from "@monet/db";

const ADMIN_SECRET = "test-admin-secret-for-ci";

describe("memories integration", () => {
  const app = getTestApp();
  let apiKey: string;
  let agentId: string;
  let tenantId: string;
  let schemaName: string;

  beforeAll(() => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_SECRET;
  });

  beforeEach(async () => {
    await cleanupTestData();
    // Provision a fresh tenant for each test
    const { body } = await provisionTestTenant(app, "mem-test", ADMIN_SECRET);
    apiKey = body.apiKey as string;
    agentId = (body.agent as { id: string }).id;
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  function authHeaders(key = apiKey) {
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  async function storeMemory(
    input: Record<string, unknown>,
    key = apiKey,
  ) {
    const res = await app.request("/api/memories", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(input),
    });
    return { res, body: await res.json() };
  }

  // ---------- Full CRUD lifecycle ----------

  it("full lifecycle: store → search → fetch → update → fetch → delete → search", async () => {
    // Store
    const { res: createRes, body: created } = await storeMemory({
      content: "Always use UTC for timestamps",
      memoryType: "decision",
      tags: ["time", "standards"],
    });
    expect(createRes.status).toBe(201);
    expect(created.id).toBeDefined();
    expect(created.version).toBe(0);

    const memId = created.id as string;

    // Search
    const searchRes = await app.request("/api/memories?tags=time", {
      headers: authHeaders(),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0].id).toBe(memId);

    // Fetch
    const fetchRes = await app.request(`/api/memories/${memId}`, {
      headers: authHeaders(),
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    expect(fetchBody.entry.content).toBe("Always use UTC for timestamps");
    expect(fetchBody.versions).toHaveLength(1);
    expect(fetchBody.versions[0].version).toBe(0);

    // Update
    const updateRes = await app.request(`/api/memories/${memId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        content: "Always use UTC (ISO 8601) for timestamps",
        expectedVersion: 0,
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.version).toBe(1);

    // Fetch again — version should be incremented, two version snapshots
    const fetchRes2 = await app.request(`/api/memories/${memId}`, {
      headers: authHeaders(),
    });
    const fetchBody2 = await fetchRes2.json();
    expect(fetchBody2.versions).toHaveLength(2);
    expect(fetchBody2.versions[1].version).toBe(1);

    // Delete
    const deleteRes = await app.request(`/api/memories/${memId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(200);

    // Search — should be gone
    const searchRes2 = await app.request("/api/memories?tags=time", {
      headers: authHeaders(),
    });
    const searchBody2 = await searchRes2.json();
    expect(searchBody2.items).toHaveLength(0);
  });

  // ---------- Scope visibility ----------

  it("private memory is invisible to another agent", async () => {
    // Store a private memory as first agent
    const { body: created } = await storeMemory({
      content: "my secret",
      memoryType: "fact",
      memoryScope: "private",
      tags: ["secret"],
    });
    expect(created.id).toBeDefined();

    // Register a second agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "agent-2" }),
    });
    const regBody = await regRes.json();
    const key2 = regBody.apiKey as string;

    // Second agent searches — private memory should not appear
    const searchRes = await app.request(
      "/api/memories?includePrivate=true",
      { headers: authHeaders(key2) },
    );
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(0);

    // Second agent fetches by ID — should be forbidden
    const fetchRes = await app.request(`/api/memories/${created.id}`, {
      headers: authHeaders(key2),
    });
    expect(fetchRes.status).toBe(403);
  });

  // ---------- Version conflict ----------

  it("concurrent update returns 409", async () => {
    const { body: created } = await storeMemory({
      content: "original",
      memoryType: "fact",
      tags: ["test"],
    });
    const memId = created.id as string;

    // First update succeeds
    const res1 = await app.request(`/api/memories/${memId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "update-1", expectedVersion: 0 }),
    });
    expect(res1.status).toBe(200);

    // Second update with stale version fails
    const res2 = await app.request(`/api/memories/${memId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "update-2", expectedVersion: 0 }),
    });
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.currentVersion).toBe(1);
  });

  // ---------- Audit log verification ----------

  it("creates audit log entries for store, update, delete", async () => {
    const { body: created } = await storeMemory({
      content: "auditable",
      memoryType: "fact",
      tags: ["audit"],
    });
    const memId = created.id as string;

    // Update
    await app.request(`/api/memories/${memId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "auditable-v2", expectedVersion: 0 }),
    });

    // Delete
    await app.request(`/api/memories/${memId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    // Query audit_log directly
    const sql = getTestSql();
    const logs = await withTenantScope(sql, schemaName, async (txSql) => {
      return txSql`
        SELECT action, target_id, outcome FROM audit_log
        WHERE target_id = ${memId}
        ORDER BY created_at ASC
      `;
    });

    expect(logs).toHaveLength(3);
    expect(logs[0].action).toBe("memory.create");
    expect(logs[1].action).toBe("memory.update");
    expect(logs[2].action).toBe("memory.delete");
  });

  // ---------- Tags endpoint ----------

  it("returns distinct union of all tags", async () => {
    await storeMemory({
      content: "mem1",
      memoryType: "fact",
      tags: ["alpha", "beta"],
    });
    await storeMemory({
      content: "mem2",
      memoryType: "fact",
      tags: ["beta", "gamma"],
    });

    const res = await app.request("/api/memories/tags", {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  // ---------- Expired memories excluded ----------

  it("excludes expired memories from search", async () => {
    // Store with ttlSeconds=1
    await storeMemory({
      content: "ephemeral",
      memoryType: "fact",
      tags: ["ttl"],
      ttlSeconds: 1,
    });

    // Manually expire it by setting expires_at in the past
    const sql = getTestSql();
    await withTenantScope(sql, schemaName, async (txSql) => {
      await txSql`
        UPDATE memory_entries SET expires_at = NOW() - interval '1 minute'
        WHERE content = 'ephemeral'
      `;
    });

    // Search should exclude it
    const searchRes = await app.request("/api/memories?tags=ttl", {
      headers: authHeaders(),
    });
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(0);
  });

  // ---------- Validation ----------

  it("returns 400 for missing required fields", async () => {
    const { res } = await storeMemory({ content: "", tags: [] });
    expect(res.status).toBe(400);
  });

  // ---------- 404 for non-existent memory ----------

  it("returns 404 for fetch of non-existent memory", async () => {
    const res = await app.request(
      "/api/memories/00000000-0000-0000-0000-ffffffffffff",
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  // ---------- Delete by non-author ----------

  it("returns 403 when non-author tries to delete", async () => {
    const { body: created } = await storeMemory({
      content: "owned by first",
      memoryType: "fact",
      tags: ["test"],
    });

    // Register second agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "agent-del-test" }),
    });
    const regBody = await regRes.json();
    const key2 = regBody.apiKey as string;

    const deleteRes = await app.request(`/api/memories/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key2}` },
    });
    expect(deleteRes.status).toBe(403);
  });

  // ---------- Mark outdated ----------

  it("marks a memory as outdated and excludes from search", async () => {
    const { body: created } = await storeMemory({
      content: "old info",
      memoryType: "fact",
      tags: ["outdated-test"],
    });

    // Mark outdated
    const markRes = await app.request(
      `/api/memories/${created.id}/outdated`,
      { method: "PATCH", headers: authHeaders() },
    );
    expect(markRes.status).toBe(200);

    // Search should exclude outdated
    const searchRes = await app.request(
      "/api/memories?tags=outdated-test",
      { headers: authHeaders() },
    );
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(0);
  });

  // ---------- Scope promotion ----------

  it("promotes scope from private to group", async () => {
    const { body: created } = await storeMemory({
      content: "originally private",
      memoryType: "fact",
      memoryScope: "private",
      tags: ["scope-test"],
    });

    // Promote to group
    const promoteRes = await app.request(
      `/api/memories/${created.id}/scope`,
      {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ scope: "group" }),
      },
    );
    expect(promoteRes.status).toBe(200);
    const promoteBody = await promoteRes.json();
    expect(promoteBody.scope).toBe("group");

    // Verify scope change audited
    const sql = getTestSql();
    const logs = await withTenantScope(sql, schemaName, async (txSql) => {
      return txSql`
        SELECT action FROM audit_log
        WHERE target_id = ${created.id} AND action = 'memory.scope_change'
      `;
    });
    expect(logs).toHaveLength(1);
  });

  it("rejects scope demotion by non-author", async () => {
    const { body: created } = await storeMemory({
      content: "group memory",
      memoryType: "fact",
      tags: ["scope-test-2"],
    });

    // Register second agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "scope-demote-agent" }),
    });
    const regBody = await regRes.json();
    const key2 = regBody.apiKey as string;

    // Second agent tries to demote to private — should fail (not the author)
    const demoteRes = await app.request(
      `/api/memories/${created.id}/scope`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key2}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "private" }),
      },
    );
    expect(demoteRes.status).toBe(403);
  });

  // ---------- Autonomous agent restriction ----------

  it("rejects user-scoped memory from autonomous agent", async () => {
    // Register an autonomous agent
    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "auto-agent", isAutonomous: true }),
    });
    const regBody = await regRes.json();
    const autoKey = regBody.apiKey as string;

    const res = await app.request("/api/memories", {
      method: "POST",
      headers: { Authorization: `Bearer ${autoKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "should fail",
        memoryType: "fact",
        memoryScope: "user",
        tags: ["auto-test"],
      }),
    });
    expect(res.status).toBe(400);
  });
});

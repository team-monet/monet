import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup.js";
import { withTenantScope } from "@monet/db";
import {
  resetEnrichmentStateForTests,
  setEnrichmentProviderForTests,
} from "../../src/services/enrichment.service.js";
import type { EnrichmentProvider } from "../../src/providers/enrichment.js";

const ADMIN_SECRET = "test-admin-secret-for-ci";
const EMBEDDING_DIMENSIONS = 1536;

function embedding(fill: number) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

function makeProvider(overrides: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    generateSummary: async (content) => `summary:${content.slice(0, 24)}`,
    computeEmbedding: async (content) => {
      if (content.includes("banana")) return embedding(0.9);
      if (content.includes("apple")) return embedding(0.2);
      return embedding(0.5);
    },
    extractTags: async (content) =>
      content
        .split(/\s+/)
        .map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter(Boolean)
        .slice(0, 4),
    ...overrides,
  };
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 50,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

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
    resetEnrichmentStateForTests();
    await cleanupTestData();
    // Provision a fresh tenant for each test
    const { body } = await provisionTestTenant(app, "mem-test", ADMIN_SECRET);
    apiKey = body.apiKey as string;
    agentId = (body.agent as { id: string }).id;
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;

    // Create a group and add the agent so it can store group-scoped memories
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-group" }),
    });
    const group = (await groupRes.json()) as { id: string };
    await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
  });

  afterAll(async () => {
    resetEnrichmentStateForTests();
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

  it("search returns Tier 1 entries with summary fallback and fetch returns Tier 2 content", async () => {
    const content = "This memory should expose only its summary in Tier 1 search responses.";
    const { body: created } = await storeMemory({
      content,
      memoryType: "fact",
      tags: ["tier1-tier2"],
    });

    const searchRes = await app.request("/api/memories?tags=tier1-tier2", {
      headers: authHeaders(),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0].summary).toBe(content);
    expect(searchBody.items[0].content).toBeUndefined();
    expect(searchBody.items[0].version).toBeUndefined();

    const fetchRes = await app.request(`/api/memories/${created.id}`, {
      headers: authHeaders(),
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    expect(fetchBody.entry.content).toBe(content);
    expect(fetchBody.entry.summary).toBeNull();
    expect(fetchBody.entry.version).toBe(0);
  });

  it("fetch increments usefulness_score for Tier 2 retrieval", async () => {
    const { body: created } = await storeMemory({
      content: "Track fetch usefulness",
      memoryType: "fact",
      tags: ["usefulness"],
    });

    const fetchRes = await app.request(`/api/memories/${created.id}`, {
      headers: authHeaders(),
    });
    expect(fetchRes.status).toBe(200);

    const sql = getTestSql();
    const [row] = await withTenantScope(sql, schemaName, async (txSql) => txSql`
      SELECT usefulness_score
      FROM memory_entries
      WHERE id = ${created.id}
    `);
    expect(row.usefulness_score).toBe(1);
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

  it("includePrivate exposes the author's private memories in search", async () => {
    await storeMemory({
      content: "my private note",
      memoryType: "fact",
      memoryScope: "private",
      tags: ["private-only"],
    });

    const hiddenRes = await app.request("/api/memories?tags=private-only", {
      headers: authHeaders(),
    });
    const hiddenBody = await hiddenRes.json();
    expect(hiddenBody.items).toHaveLength(0);

    const visibleRes = await app.request("/api/memories?tags=private-only&includePrivate=true", {
      headers: authHeaders(),
    });
    const visibleBody = await visibleRes.json();
    expect(visibleBody.items).toHaveLength(1);
    expect(visibleBody.items[0].summary).toBe("my private note");
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
        SELECT action, target_id, outcome, tenant_id FROM audit_log
        WHERE target_id = ${memId}
        ORDER BY created_at ASC
      `;
    });

    expect(logs).toHaveLength(3);
    expect(logs[0].action).toBe("memory.create");
    expect(logs[1].action).toBe("memory.update");
    expect(logs[2].action).toBe("memory.delete");
    expect(logs[0].tenant_id).toBe(tenantId);
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

  it("returns 409 when group quota is exceeded", async () => {
    const sql = getTestSql();
    await sql`
      UPDATE agent_groups
      SET memory_quota = 2
      WHERE tenant_id = ${tenantId}
    `;

    const first = await storeMemory({
      content: "mem-1",
      memoryType: "fact",
      tags: ["quota"],
    });
    expect(first.res.status).toBe(201);

    const second = await storeMemory({
      content: "mem-2",
      memoryType: "fact",
      tags: ["quota"],
    });
    expect(second.res.status).toBe(201);

    const third = await storeMemory({
      content: "mem-3",
      memoryType: "fact",
      tags: ["quota"],
    });
    expect(third.res.status).toBe(409);
    expect(third.body.error).toBe("quota_exceeded");
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

  it("marks a memory as outdated and keeps it searchable", async () => {
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

    // Search should still return the entry, but flagged as outdated
    const searchRes = await app.request(
      "/api/memories?tags=outdated-test",
      { headers: authHeaders() },
    );
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0].outdated).toBe(true);
  });

  it("ranks outdated entries below fresh entries", async () => {
    const fresh = await storeMemory({
      content: "apple fresh memory",
      memoryType: "fact",
      tags: ["ranking"],
    });
    const stale = await storeMemory({
      content: "apple stale memory",
      memoryType: "fact",
      tags: ["ranking"],
    });

    const staleMarkRes = await app.request(`/api/memories/${stale.body.id}/outdated`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    expect(staleMarkRes.status).toBe(200);

    const searchRes = await app.request("/api/memories?query=apple&tags=ranking", {
      headers: authHeaders(),
    });
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(2);
    expect(searchBody.items[0].id).toBe(fresh.body.id);
    expect(searchBody.items[1].id).toBe(stale.body.id);
    expect(searchBody.items[1].outdated).toBe(true);
  });

  it("applies temporal and memoryType filters to search", async () => {
    const oldFact = await storeMemory({
      content: "old fact",
      memoryType: "fact",
      tags: ["temporal"],
    });
    const recentDecision = await storeMemory({
      content: "recent decision",
      memoryType: "decision",
      tags: ["temporal"],
    });

    const sql = getTestSql();
    await withTenantScope(sql, schemaName, async (txSql) => {
      await txSql`
        UPDATE memory_entries
        SET created_at = '2026-02-01T00:00:00.000Z', last_accessed_at = '2026-02-01T00:00:00.000Z'
        WHERE id = ${oldFact.body.id}
      `;
      await txSql`
        UPDATE memory_entries
        SET created_at = '2026-03-03T00:00:00.000Z', last_accessed_at = '2026-03-03T00:00:00.000Z'
        WHERE id = ${recentDecision.body.id}
      `;
    });

    const searchRes = await app.request(
      "/api/memories?tags=temporal&memoryType=decision&createdAfter=2026-03-01T00:00:00.000Z&accessedAfter=2026-03-01T00:00:00.000Z",
      { headers: authHeaders() },
    );
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0].id).toBe(recentDecision.body.id);
  });

  it("lists only group memories for the requested agent via /agent/:agentId", async () => {
    const groupOne = await storeMemory({
      content: "agent one group memory",
      memoryType: "fact",
      tags: ["agent-list"],
    });
    await storeMemory({
      content: "agent one private memory",
      memoryType: "fact",
      memoryScope: "private",
      tags: ["agent-list"],
    });

    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ externalId: "agent-list-2" }),
    });
    const regBody = await regRes.json();
    const key2 = regBody.apiKey as string;
    const agentId2 = (regBody.agent as { id: string }).id;

    const groupsRes = await app.request("/api/groups", { headers: authHeaders() });
    const groupsBody = await groupsRes.json();
    const groupId = groupsBody.groups[0].id as string;
    await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agentId: agentId2 }),
    });

    await storeMemory({
      content: "agent two group memory",
      memoryType: "fact",
      tags: ["agent-list"],
    }, key2);

    const listRes = await app.request(`/api/memories/agent/${agentId}`, {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].id).toBe(groupOne.body.id);
    expect(listBody.items[0].summary).toBe("agent one group memory");
  });

  it("falls back to text search when query embedding is unavailable", async () => {
    setEnrichmentProviderForTests(null);
    await storeMemory({
      content: "semantic fallback works via plain text",
      memoryType: "fact",
      tags: ["fallback"],
    });

    const searchRes = await app.request("/api/memories?query=plain%20text", {
      headers: authHeaders(),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0].summary).toContain("semantic fallback");
  });

  it("completes enrichment asynchronously and records completed status", async () => {
    setEnrichmentProviderForTests(makeProvider());
    const { body: created } = await storeMemory({
      content: "banana roadmap planning memory",
      memoryType: "decision",
      tags: ["async-enrichment"],
    });

    const sql = getTestSql();
    await waitFor(async () => {
      const [row] = await withTenantScope(sql, schemaName, async (txSql) => txSql`
        SELECT enrichment_status
        FROM memory_entries
        WHERE id = ${created.id}
      `);
      return row.enrichment_status === "completed";
    }, 3000);

    const [enriched] = await withTenantScope(sql, schemaName, async (txSql) => txSql`
      SELECT summary, auto_tags, embedding, related_memory_ids
      FROM memory_entries
      WHERE id = ${created.id}
    `);
    expect(typeof enriched.summary).toBe("string");
    expect(enriched.summary).toContain("summary:");
    expect(enriched.auto_tags).toBeTruthy();
    expect(enriched.embedding).not.toBeNull();
    expect(enriched.related_memory_ids).toBeTruthy();
  });

  it("marks enrichment as failed when the provider errors", async () => {
    setEnrichmentProviderForTests(makeProvider({
      computeEmbedding: async () => {
        throw new Error("embedding failure");
      },
    }));
    const { body: created } = await storeMemory({
      content: "failed enrichment memory",
      memoryType: "fact",
      tags: ["enrichment-failed"],
    });

    const sql = getTestSql();
    await waitFor(async () => {
      const [row] = await withTenantScope(sql, schemaName, async (txSql) => txSql`
        SELECT enrichment_status
        FROM memory_entries
        WHERE id = ${created.id}
      `);
      return row.enrichment_status === "failed";
    });
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

  it("rejects audit log update and delete operations", async () => {
    const { body: created } = await storeMemory({
      content: "append-only",
      memoryType: "fact",
      tags: ["audit-append-only"],
    });

    const sql = getTestSql();

    await expect(withTenantScope(sql, schemaName, async (txSql) => {
      await txSql`
        UPDATE audit_log
        SET action = 'tampered'
        WHERE target_id = ${created.id}
      `;
    })).rejects.toThrow();

    await expect(withTenantScope(sql, schemaName, async (txSql) => {
      await txSql`
        DELETE FROM audit_log
        WHERE target_id = ${created.id}
      `;
    })).rejects.toThrow();
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

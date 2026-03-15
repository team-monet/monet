import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup";
import { withTenantScope } from "@monet/db";
import {
  resetEnrichmentStateForTests,
} from "../../src/services/enrichment.service";
import {
  EMBEDDING_DIMENSIONS,
} from "../../src/providers/enrichment";

function embedding(fill: number) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

describe("metrics integration", () => {
  const app = getTestApp();
  let apiKey: string;
  let agentId: string;
  let tenantId: string;
  let schemaName: string;
  let groupId: string;

  beforeEach(async () => {
    resetEnrichmentStateForTests();
    await cleanupTestData();

    const { body } = await provisionTestTenant({ name: "metrics-test" });
    apiKey = body.apiKey as string;
    agentId = (body.agent as { id: string }).id;
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;

    // Create a group and add the agent
    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "test-group", memoryQuota: 500 }),
    });
    const group = (await groupRes.json()) as { id: string };
    groupId = group.id;
    await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: authHeaders(),
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

  async function storeMemory(input: Record<string, unknown>) {
    const res = await app.request("/api/memories", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    return { res, body: await res.json() };
  }

  async function seedTestData() {
    // Store several memories with different types and tags
    await storeMemory({
      content: "Always use UTC timestamps",
      memoryType: "decision",
      tags: ["time", "standards"],
    });
    await storeMemory({
      content: "Prefer PostgreSQL for OLTP workloads",
      memoryType: "decision",
      tags: ["database", "standards"],
    });
    await storeMemory({
      content: "Auth token rotation issue found",
      memoryType: "issue",
      tags: ["auth", "security"],
    });

    // Insert audit log entries for reads/searches via direct SQL
    const sql = getTestSql();
    await withTenantScope(sql, schemaName, async (tx) => {
      // Simulate search and get actions over multiple days
      for (let daysAgo = 0; daysAgo < 3; daysAgo++) {
        await tx.unsafe(
          `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, outcome, created_at)
           VALUES ($1, $2, 'agent', 'memory.search', 'success', NOW() - make_interval(days => $3))`,
          [tenantId, agentId, daysAgo],
        );
        await tx.unsafe(
          `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, outcome, created_at)
           VALUES ($1, $2, 'agent', 'memory.get', 'success', NOW() - make_interval(days => $3))`,
          [tenantId, agentId, daysAgo],
        );
      }

      // Mark one memory as outdated
      await tx.unsafe(`
        UPDATE memory_entries SET outdated = true
        WHERE id = (SELECT id FROM memory_entries LIMIT 1)
      `);

      // Set varied usefulness scores
      const memRows = await tx.unsafe(`SELECT id FROM memory_entries ORDER BY created_at`);
      if (memRows.length >= 3) {
        await tx.unsafe(`UPDATE memory_entries SET usefulness_score = 0 WHERE id = $1`, [memRows[0].id]);
        await tx.unsafe(`UPDATE memory_entries SET usefulness_score = 3 WHERE id = $1`, [memRows[1].id]);
        await tx.unsafe(`UPDATE memory_entries SET usefulness_score = 8 WHERE id = $1`, [memRows[2].id]);
      }

      // Simulate enrichment: mark one as completed with summary + embedding
      await tx.unsafe(
        `UPDATE memory_entries
         SET enrichment_status = 'completed',
             summary = 'A summary',
             embedding = $1::vector,
             auto_tags = ARRAY['generated-tag']
         WHERE id = $2`,
        [`[${embedding(0.5).join(",")}]`, memRows[0].id],
      );
      // Mark one as failed
      await tx.unsafe(
        `UPDATE memory_entries SET enrichment_status = 'failed' WHERE id = $1`,
        [memRows[1].id],
      );
    });
  }

  it("returns all metric sections with correct shapes", async () => {
    // Provisioned agent is already tenant_admin
    await seedTestData();

    const res = await app.request("/api/metrics", { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    // Usage section
    expect(body).toHaveProperty("usage");
    const usage = body.usage as Record<string, unknown>;
    expect(usage).toHaveProperty("readWriteFrequency");
    expect(usage).toHaveProperty("activeAgents");
    expect(usage).toHaveProperty("enrichmentThroughput");

    const frequency = usage.readWriteFrequency as Array<Record<string, unknown>>;
    expect(frequency).toHaveLength(14);
    expect(frequency[0]).toHaveProperty("date");
    expect(frequency[0]).toHaveProperty("reads");
    expect(frequency[0]).toHaveProperty("writes");
    expect(frequency[0]).toHaveProperty("searches");

    const agents = usage.activeAgents as Record<string, number>;
    expect(agents.period7d).toBeGreaterThan(0);
    expect(agents.total).toBeGreaterThan(0);

    const enrichment = usage.enrichmentThroughput as Record<string, number>;
    expect(enrichment.completed).toBe(1);
    expect(enrichment.failed).toBe(1);
    expect(enrichment.pending).toBe(1);

    // Benefit section
    expect(body).toHaveProperty("benefit");
    const benefit = body.benefit as Record<string, unknown>;
    expect(benefit).toHaveProperty("usefulnessDistribution");
    expect(benefit).toHaveProperty("memoryReuseRate");
    expect(benefit).toHaveProperty("tagDiversityByGroup");
    expect(benefit).toHaveProperty("enrichmentQuality");

    const usefulness = benefit.usefulnessDistribution as Array<Record<string, unknown>>;
    expect(usefulness.length).toBeGreaterThan(0);

    const quality = benefit.enrichmentQuality as Record<string, number>;
    expect(quality.total).toBe(3);
    expect(quality.withSummary).toBe(1);
    expect(quality.withEmbedding).toBe(1);

    // Health section
    expect(body).toHaveProperty("health");
    const health = body.health as Record<string, unknown>;
    expect(health).toHaveProperty("memoryLifecycle");
    expect(health).toHaveProperty("quotaUtilization");

    const lifecycle = health.memoryLifecycle as Record<string, number>;
    expect(lifecycle.avgAgeDays).toBeGreaterThanOrEqual(0);
    expect(lifecycle.outdatedPct).toBeGreaterThan(0);

    const quotas = health.quotaUtilization as Array<Record<string, unknown>>;
    expect(quotas.length).toBeGreaterThan(0);
    // Our group has a quota of 500 and 3 memories
    const ourGroup = quotas.find((q) => q.groupId === groupId);
    expect(ourGroup).toBeDefined();
    expect(ourGroup!.quota).toBe(500);
  });

  it("returns 403 for non-admin agents", async () => {
    // Downgrade the provisioned agent to 'user' role
    const sql = getTestSql();
    await sql`UPDATE agents SET role = 'user' WHERE id = ${agentId}`;

    const res = await app.request("/api/metrics", { headers: authHeaders() });
    expect(res.status).toBe(403);

    // Restore role for other tests
    await sql`UPDATE agents SET role = 'tenant_admin' WHERE id = ${agentId}`;
  });

  it("handles tenant with no data gracefully", async () => {
    // Provisioned agent is already tenant_admin
    const res = await app.request("/api/metrics", { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    const agents = usage.activeAgents as Record<string, number>;
    expect(agents.period7d).toBe(0);

    const benefit = body.benefit as Record<string, unknown>;
    const quality = benefit.enrichmentQuality as Record<string, number>;
    expect(quality.total).toBe(0);
  });
});

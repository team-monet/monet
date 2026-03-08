import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  getTestApp,
  getTestSql,
  provisionTestTenant,
  cleanupTestData,
  closeTestDb,
} from "./helpers/setup.js";
import { withTenantScope } from "@monet/db";

describe("tenant isolation integration", () => {
  const app = getTestApp();

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("two tenants have separate schemas with no cross-access", async () => {
    // Provision tenant A
    const { body: bodyA } = await provisionTestTenant({ name: "tenant-a" });
    const keyA = bodyA.apiKey as string;
    const tenantA = bodyA.tenant as { id: string };

    // Provision tenant B
    const { body: bodyB } = await provisionTestTenant({ name: "tenant-b" });
    const keyB = bodyB.apiKey as string;
    const tenantB = bodyB.tenant as { id: string };

    const sql = getTestSql();

    // Insert a memory entry in tenant A's schema
    const schemaA = `tenant_${tenantA.id.replace(/-/g, "_")}`;
    await withTenantScope(sql, schemaA, async (txSql) => {
      await txSql`
        INSERT INTO memory_entries (content, memory_type, memory_scope, author_agent_id)
        VALUES ('secret-data-A', 'fact', 'group', ${(bodyA.agent as { id: string }).id})
      `;
    });
    const [{ id: memoryIdA }] = await withTenantScope(sql, schemaA, async (txSql) => {
      return txSql`SELECT id FROM memory_entries WHERE content = 'secret-data-A'`;
    }) as Array<{ id: string }>;

    // Insert a memory entry in tenant B's schema
    const schemaB = `tenant_${tenantB.id.replace(/-/g, "_")}`;
    await withTenantScope(sql, schemaB, async (txSql) => {
      await txSql`
        INSERT INTO memory_entries (content, memory_type, memory_scope, author_agent_id)
        VALUES ('secret-data-B', 'fact', 'group', ${(bodyB.agent as { id: string }).id})
      `;
    });

    // Verify tenant A can only see its own data
    const dataA = await withTenantScope(sql, schemaA, async (txSql) => {
      return txSql`SELECT content FROM memory_entries`;
    });
    expect(dataA).toHaveLength(1);
    expect(dataA[0].content).toBe("secret-data-A");

    // Verify tenant B can only see its own data
    const dataB = await withTenantScope(sql, schemaB, async (txSql) => {
      return txSql`SELECT content FROM memory_entries`;
    });
    expect(dataB).toHaveLength(1);
    expect(dataB[0].content).toBe("secret-data-B");

    // Agent from tenant A authenticates and sees their tenant ID
    const meA = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(meA.status).toBe(200);
    const meABody = await meA.json();
    expect(meABody.tenantId).toBe(tenantA.id);

    // Agent from tenant B has a different tenant ID
    const meB = await app.request("/api/agents/me", {
      headers: { Authorization: `Bearer ${keyB}` },
    });
    expect(meB.status).toBe(200);
    const meBBody = await meB.json();
    expect(meBBody.tenantId).toBe(tenantB.id);
    expect(meBBody.tenantId).not.toBe(meABody.tenantId);

    const crossFetch = await app.request(`/api/memories/${memoryIdA}`, {
      headers: { Authorization: `Bearer ${keyB}` },
    });
    expect(crossFetch.status).toBe(404);
  });
});

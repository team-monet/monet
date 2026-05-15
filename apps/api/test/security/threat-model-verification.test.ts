import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTestData,
  closeTestDb,
  getTestApp,
  getTestSql,
  provisionTestTenant,
} from "../integration/helpers/setup";
import {
  resetEnrichmentStateForTests,
  setBackgroundEnrichmentEnabledForTests,
  setEnrichmentProviderForTests,
} from "../../src/services/enrichment.service";
import type { EnrichmentProvider } from "../../src/providers/enrichment";

function tenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("threat model verification", () => {
  const app = getTestApp();
  const sql = getTestSql();

  beforeEach(async () => {
    resetEnrichmentStateForTests();
    await cleanupTestData();
  });

  afterAll(async () => {
    resetEnrichmentStateForTests();
    await cleanupTestData();
    await closeTestDb();
  });

  it("does not leak authorization token or memory content in log output", async () => {
    const previousForceLogs = process.env.FORCE_REQUEST_LOGS;
    process.env.FORCE_REQUEST_LOGS = "true";
    setBackgroundEnrichmentEnabledForTests(true);
    const failingProvider: EnrichmentProvider = {
      generateSummary: async () => {
        throw new Error("summary failure");
      },
      computeEmbedding: async () => {
        throw new Error("embedding failure");
      },
      extractTags: async () => [],
    };
    setEnrichmentProviderForTests(failingProvider);

    const { body } = await provisionTestTenant({ name: "security-logs" });
    const apiKey = body.apiKey as string;
    const sensitiveContent = "TOP_SECRET_VALUE_12345";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await app.request("/api/memories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        content: sensitiveContent,
        memoryType: "fact",
        memoryScope: "private",
        tags: ["security"],
      }),
    });

    expect(res.status).toBe(201);

    // Enrichment runs in the background; allow warning logs to flush.
    for (let i = 0; i < 20; i += 1) {
      if (warnSpy.mock.calls.length > 0) break;
      await sleep(10);
    }

    const output = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].join("\n");

    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(sensitiveContent);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    if (previousForceLogs === undefined) {
      delete process.env.FORCE_REQUEST_LOGS;
    } else {
      process.env.FORCE_REQUEST_LOGS = previousForceLogs;
    }
  });

  it("audit_log does not grant UPDATE or DELETE to PUBLIC", async () => {
    const { body } = await provisionTestTenant({ name: "security-audit" });
    const tenantId = (body.tenant as { id: string }).id;
    const schemaName = tenantSchemaName(tenantId);
    const auditTableName = `${schemaName}.audit_log`;

    const [row] = await sql<{ hasUpdate: boolean; hasDelete: boolean }[]>`
      SELECT
        has_table_privilege('public', ${auditTableName}, 'UPDATE') AS "hasUpdate",
        has_table_privilege('public', ${auditTableName}, 'DELETE') AS "hasDelete"
    `;

    expect(row.hasUpdate).toBe(false);
    expect(row.hasDelete).toBe(false);
  });

  it("authenticated tenant identity is not overridden by request headers", async () => {
    const first = await provisionTestTenant({ name: "security-tenant-a" });
    const second = await provisionTestTenant({ name: "security-tenant-b" });

    const firstApiKey = first.body.apiKey as string;
    const secondTenantId = (second.body.tenant as { id: string }).id;

    const meRes = await app.request("/api/agents/me", {
      headers: {
        Authorization: `Bearer ${firstApiKey}`,
        "X-Tenant-Id": secondTenantId,
      },
    });

    expect(meRes.status).toBe(200);
    const meBody = await meRes.json() as { tenantId: string };
    const firstTenantId = (first.body.tenant as { id: string }).id;
    expect(meBody.tenantId).toBe(firstTenantId);
    expect(meBody.tenantId).not.toBe(secondTenantId);
  });
});

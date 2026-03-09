import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../src/app.js";
import { createMcpHandler } from "../../src/mcp/handler.js";
import { SessionStore } from "../../src/mcp/session-store.js";
import type { AgentContext } from "../../src/middleware/context.js";
import {
  cleanupTestData,
  closeTestDb,
  getTestDb,
  getTestSql,
  provisionTestTenant,
} from "./helpers/setup.js";

describe("Rules integration", () => {
  const db = getTestDb();
  const sql = getTestSql();
  const sessionStore = new SessionStore();
  const app = createApp(db as never, sql, sessionStore);
  const mcpHandler = createMcpHandler({ db, sql, sessionStore });
  const honoListener = getRequestListener(app.fetch);

  let server: Server;
  let tenantId: string;
  let schemaName: string;
  let adminApiKey: string;
  let adminAgentId: string;
  let defaultGroupId: string;

  beforeAll(async () => {
    console.log("TEST_DB_URL:", process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/monet_test");

    server = createServer((req, res) => {
      if (req.url?.startsWith("/mcp")) {
        void mcpHandler.handle(req, res);
        return;
      }
      honoListener(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    void address;
  });

  beforeEach(async () => {
    await cleanupTestData();

    const { body } = await provisionTestTenant({ name: "rules-integration" });
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;
    adminApiKey = body.apiKey as string;
    adminAgentId = (body.agent as { id: string }).id;
    defaultGroupId = body.defaultGroupId as string;
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  async function registerAgent(externalId: string) {
    const res = await app.request("/api/agents/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ externalId, groupId: defaultGroupId }),
    });
    const body = await res.json();
    return {
      id: (body.agent as { id: string }).id,
      apiKey: body.apiKey as string,
    };
  }

  function addMockSession(agentId: string) {
    const notify = vi.fn().mockResolvedValue(undefined);
    const sessionId = `session-${Math.random().toString(16).slice(2)}`;

    const agentContext: AgentContext = {
      id: agentId,
      externalId: "worker",
      tenantId,
      isAutonomous: false,
      userId: null,
      role: null,
    };

    sessionStore.add(sessionId, {
      transport: {
        close: async () => {},
        handleRequest: async () => {},
      } as never,
      server: {
        server: {
          notification: notify,
        },
        close: async () => {},
      } as never,
      agentContext,
      tenantSchemaName: schemaName,
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    });

    return { sessionId, notify };
  }

  it("Tenant_Admin creates a rule", async () => {
    const res = await app.request("/api/rules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Rule A", description: "Do not leak keys" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/[0-9a-f-]{36}/i);
  });

  it("Non-admin agent cannot create a rule", async () => {
    const nonAdmin = await registerAgent("worker-non-admin");

    const res = await app.request("/api/rules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nonAdmin.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Rule A", description: "blocked" }),
    });

    expect(res.status).toBe(403);
  });

  it("Tenant_Admin creates rule set and associates rules", async () => {
    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rule A", description: "Desc A" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Set A" }),
    });
    const ruleSet = await setRes.json() as { id: string };

    const assocRes = await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    expect(assocRes.status).toBe(201);
  });

  it("Tenant_Admin associates rule set with agent and GET returns active rules", async () => {
    const agent = await registerAgent("worker-active-rules");

    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rule A", description: "Desc A" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Set A" }),
    });
    const ruleSet = await setRes.json() as { id: string };

    await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    await app.request(`/api/agents/${agent.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });

    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(activeRes.status).toBe(200);
    const active = await activeRes.json() as { rules: Array<{ id: string }> };
    expect(active.rules.map((r) => r.id)).toContain(rule.id);
  });

  it("Removing a rule from set pushes updated rules to active session", async () => {
    const agent = await registerAgent("worker-rules-update");
    const { notify } = addMockSession(agent.id);

    const createRuleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rule Push", description: "Will be removed" }),
    });
    const rule = await createRuleRes.json() as { id: string };

    const createSetRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Set Push" }),
    });
    const ruleSet = await createSetRes.json() as { id: string };

    await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    await app.request(`/api/agents/${agent.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });

    notify.mockClear();

    const removeRes = await app.request(`/api/rule-sets/${ruleSet.id}/rules/${rule.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(removeRes.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      method: "notifications/rules/updated",
      params: { rules: [] },
    });
  });

  it("Multiple rule sets on same agent do not duplicate active rules", async () => {
    const agent = await registerAgent("worker-dedup");

    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rule Dedup", description: "Only once" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setARes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Set A" }),
    });
    const setA = await setARes.json() as { id: string };

    const setBRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Set B" }),
    });
    const setB = await setBRes.json() as { id: string };

    await app.request(`/api/rule-sets/${setA.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    await app.request(`/api/rule-sets/${setB.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    await app.request(`/api/agents/${agent.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: setA.id }),
    });

    await app.request(`/api/agents/${agent.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: setB.id }),
    });

    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    const active = await activeRes.json() as { rules: Array<{ id: string }> };
    expect(active.rules).toHaveLength(1);
    expect(active.rules[0].id).toBe(rule.id);
  });

  it("Audit log contains entries for rule mutations", async () => {
    const createRuleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rule Audit", description: "Audit me" }),
    });
    const rule = await createRuleRes.json() as { id: string };

    await app.request(`/api/rules/${rule.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated" }),
    });

    await app.request(`/api/rules/${rule.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    let actions: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const rows = await sql.unsafe(`
        SELECT action
        FROM "${schemaName}".audit_log
        WHERE actor_id = '${adminAgentId}'
        ORDER BY created_at ASC
      `);
      actions = (rows as Array<{ action: string }>).map((row) => row.action);
      if (actions.includes("rule.delete")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(actions).toContain("rule.create");
    expect(actions).toContain("rule.update");
    expect(actions).toContain("rule.delete");
  });
});

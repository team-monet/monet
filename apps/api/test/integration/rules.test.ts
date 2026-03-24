import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../src/app";
import { createMcpHandler } from "../../src/mcp/handler";
import { SessionStore } from "../../src/mcp/session-store";
import type { AgentContext } from "../../src/middleware/context";
import {
  DEFAULT_GENERAL_GUIDANCE_RULE_SET_NAME,
  DEFAULT_GENERAL_GUIDANCE_RULES,
} from "../../src/services/default-rule-seed.service";
import {
  cleanupTestData,
  closeTestDb,
  getTestDb,
  getTestSql,
  provisionTestTenant,
} from "./helpers/setup";

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
  const defaultRuleNames = DEFAULT_GENERAL_GUIDANCE_RULES.map((rule) => rule.name).sort();

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

  async function registerAgent(
    externalId: string,
    options?: { apiKey?: string; userId?: string; isAutonomous?: boolean },
  ) {
    const res = await app.request("/api/agents/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options?.apiKey ?? adminApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        externalId,
        groupId: defaultGroupId,
        userId: options?.userId,
        isAutonomous: options?.isAutonomous,
      }),
    });
    const body = await res.json();
    return {
      id: (body.agent as { id: string }).id,
      apiKey: body.apiKey as string,
    };
  }

  async function createUser(externalId: string, email: string) {
    const [user] = await sql`
      INSERT INTO users (external_id, tenant_id, role, email)
      VALUES (${externalId}, ${tenantId}, 'user', ${email})
      RETURNING id
    `;
    return user.id as string;
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

  it("New tenants seed default guidance and General agents inherit it", async () => {
    const rulesRes = await app.request("/api/rules", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(rulesRes.status).toBe(200);
    const rulesBody = await rulesRes.json() as { rules: Array<{ name: string }> };
    expect(rulesBody.rules).toHaveLength(DEFAULT_GENERAL_GUIDANCE_RULES.length);
    expect(rulesBody.rules.map((rule) => rule.name).sort()).toEqual(defaultRuleNames);

    const ruleSetsRes = await app.request("/api/rule-sets", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(ruleSetsRes.status).toBe(200);
    const ruleSetsBody = await ruleSetsRes.json() as { ruleSets: Array<{ name: string }> };
    expect(ruleSetsBody.ruleSets).toHaveLength(1);
    expect(ruleSetsBody.ruleSets[0].name).toBe(DEFAULT_GENERAL_GUIDANCE_RULE_SET_NAME);

    const agent = await registerAgent("worker-default-guidance");
    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(activeRes.status).toBe(200);
    const active = await activeRes.json() as { rules: Array<{ name: string }> };
    expect(active.rules).toHaveLength(DEFAULT_GENERAL_GUIDANCE_RULES.length);
    expect(active.rules.map((rule) => rule.name).sort()).toEqual(defaultRuleNames);
  });

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

  it("Non-admin agent can view shared rules and rule sets", async () => {
    const nonAdmin = await registerAgent("worker-rule-reader");

    const [rulesRes, ruleSetsRes] = await Promise.all([
      app.request("/api/rules", {
        method: "GET",
        headers: { Authorization: `Bearer ${nonAdmin.apiKey}` },
      }),
      app.request("/api/rule-sets", {
        method: "GET",
        headers: { Authorization: `Bearer ${nonAdmin.apiKey}` },
      }),
    ]);

    expect(rulesRes.status).toBe(200);
    expect(ruleSetsRes.status).toBe(200);

    const rulesBody = await rulesRes.json() as { rules: Array<{ name: string }> };
    const ruleSetsBody = await ruleSetsRes.json() as { ruleSets: Array<{ name: string }> };

    expect(rulesBody.rules.map((rule) => rule.name).sort()).toEqual(defaultRuleNames);
    expect(ruleSetsBody.ruleSets.map((ruleSet) => ruleSet.name)).toContain(
      DEFAULT_GENERAL_GUIDANCE_RULE_SET_NAME,
    );
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

  it("Owning user can attach a shared rule set to their own agent", async () => {
    const userId = await createUser("owner-user", "owner@example.com");

    const ownerAgent = await registerAgent("owner-agent", { userId });

    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Owner Rule", description: "Owner Desc" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Owner Set" }),
    });
    const ruleSet = await setRes.json() as { id: string };

    const addRuleRes = await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });
    expect(addRuleRes.status).toBe(201);

    const attachRes = await app.request(`/api/agents/${ownerAgent.id}/rule-sets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });

    expect(attachRes.status).toBe(201);

    const detailRes = await app.request(`/api/agents/${ownerAgent.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ownerAgent.apiKey}` },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json() as { ruleSets: Array<{ name: string }> };
    expect(detailBody.ruleSets.map((ruleSetEntry) => ruleSetEntry.name)).toContain("Owner Set");
  });

  it("Owning user can manage personal rules and attach them to their own agent", async () => {
    const ownerUserId = await createUser("personal-owner", "personal-owner@example.com");
    const ownerAgent = await registerAgent("personal-owner-agent", { userId: ownerUserId });

    const createRuleRes = await app.request("/api/me/rules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "My Personal Rule", description: "Only for my agents" }),
    });

    expect(createRuleRes.status).toBe(201);
    const personalRule = await createRuleRes.json() as { id: string; ownerUserId: string | null };
    expect(personalRule.ownerUserId).toBe(ownerUserId);

    const createRuleSetRes = await app.request("/api/me/rule-sets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "My Personal Set" }),
    });

    expect(createRuleSetRes.status).toBe(201);
    const personalRuleSet = await createRuleSetRes.json() as { id: string; ownerUserId: string | null };
    expect(personalRuleSet.ownerUserId).toBe(ownerUserId);

    const addToSetRes = await app.request(`/api/me/rule-sets/${personalRuleSet.id}/rules`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleId: personalRule.id }),
    });

    expect(addToSetRes.status).toBe(201);

    const attachRes = await app.request(`/api/agents/${ownerAgent.id}/rule-sets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleSetId: personalRuleSet.id }),
    });

    expect(attachRes.status).toBe(201);

    const listPersonalRulesRes = await app.request("/api/me/rules", {
      method: "GET",
      headers: { Authorization: `Bearer ${ownerAgent.apiKey}` },
    });

    expect(listPersonalRulesRes.status).toBe(200);
    const personalRulesBody = await listPersonalRulesRes.json() as { rules: Array<{ name: string }> };
    expect(personalRulesBody.rules.map((rule) => rule.name)).toContain("My Personal Rule");

    const activeRes = await app.request(`/api/agents/${ownerAgent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ownerAgent.apiKey}` },
    });

    expect(activeRes.status).toBe(200);
    const activeBody = await activeRes.json() as { rules: Array<{ name: string }> };
    expect(activeBody.rules.map((rule) => rule.name)).toContain("My Personal Rule");
  });

  it("A personal rule set cannot be attached to another user's agent", async () => {
    const ownerUserId = await createUser("personal-owner-2", "owner-two@example.com");
    const otherUserId = await createUser("personal-other", "other-user@example.com");
    const ownerAgent = await registerAgent("personal-owner-two-agent", { userId: ownerUserId });
    const otherAgent = await registerAgent("personal-other-agent", { userId: otherUserId });

    const createRuleRes = await app.request("/api/me/rules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Private Rule", description: "Not for other users" }),
    });
    const personalRule = await createRuleRes.json() as { id: string };

    const createRuleSetRes = await app.request("/api/me/rule-sets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Private Set" }),
    });
    const personalRuleSet = await createRuleSetRes.json() as { id: string };

    await app.request(`/api/me/rule-sets/${personalRuleSet.id}/rules`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleId: personalRule.id }),
    });

    const forbiddenAttachRes = await app.request(`/api/agents/${otherAgent.id}/rule-sets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherAgent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ruleSetId: personalRuleSet.id }),
    });

    expect(forbiddenAttachRes.status).toBe(403);

    const otherPersonalRulesRes = await app.request("/api/me/rules", {
      method: "GET",
      headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
    });
    const otherPersonalRules = await otherPersonalRulesRes.json() as { rules: Array<{ name: string }> };
    expect(otherPersonalRules.rules.map((rule) => rule.name)).not.toContain("Private Rule");
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
    const notification = notify.mock.calls[0]?.[0] as {
      method: string;
      params: { rules: Array<{ name: string }> };
    };
    expect(notification.method).toBe("notifications/rules/updated");
    expect(notification.params.rules).toHaveLength(DEFAULT_GENERAL_GUIDANCE_RULES.length);
    expect(notification.params.rules.map((activeRule) => activeRule.name).sort()).toEqual(
      defaultRuleNames,
    );
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
    expect(active.rules).toHaveLength(DEFAULT_GENERAL_GUIDANCE_RULES.length + 1);
    expect(active.rules.filter((activeRule) => activeRule.id === rule.id)).toHaveLength(1);
  });

  it("Moving an agent out of General removes inherited default guidance and pushes an update", async () => {
    const agent = await registerAgent("worker-group-move");
    const { notify } = addMockSession(agent.id);

    const createGroupRes = await app.request("/api/groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Guidance", description: "Fresh group" }),
    });
    const group = await createGroupRes.json() as { id: string };

    notify.mockClear();

    const moveRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });

    expect(moveRes.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);

    const notification = notify.mock.calls[0]?.[0] as {
      method: string;
      params: { rules: Array<{ id: string }> };
    };
    expect(notification.method).toBe("notifications/rules/updated");
    expect(notification.params.rules).toEqual([]);

    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });

    expect(activeRes.status).toBe(200);
    const active = await activeRes.json() as { rules: Array<{ id: string }> };
    expect(active.rules).toEqual([]);
  });

  it("Tenant_Admin associates a rule set with a group and agents inherit it", async () => {
    // Create a fresh group and move an agent into it
    const createGroupRes = await app.request("/api/groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group Rules Test", description: "Test group" }),
    });
    const group = await createGroupRes.json() as { id: string };

    const agent = await registerAgent("worker-group-rules");
    await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });

    // Create a rule and rule set
    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group Rule", description: "Inherited via group" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group Set" }),
    });
    const ruleSet = await setRes.json() as { id: string };

    await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    // Associate rule set with the group
    const assocRes = await app.request(`/api/groups/${group.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });
    expect(assocRes.status).toBe(201);

    // Agent should now inherit the rule
    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });
    expect(activeRes.status).toBe(200);
    const active = await activeRes.json() as { rules: Array<{ id: string }> };
    expect(active.rules.map((r) => r.id)).toContain(rule.id);

    // Duplicate association returns 409
    const dupRes = await app.request(`/api/groups/${group.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });
    expect(dupRes.status).toBe(409);
  });

  it("Dissociating a rule set from a group removes inherited rules and pushes MCP update", async () => {
    const createGroupRes = await app.request("/api/groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group Dissoc Test" }),
    });
    const group = await createGroupRes.json() as { id: string };

    const agent = await registerAgent("worker-group-dissoc");
    const { notify } = addMockSession(agent.id);
    await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });

    // Create rule + set and associate with group
    const ruleRes = await app.request("/api/rules", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dissoc Rule", description: "Will be removed" }),
    });
    const rule = await ruleRes.json() as { id: string };

    const setRes = await app.request("/api/rule-sets", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dissoc Set" }),
    });
    const ruleSet = await setRes.json() as { id: string };

    await app.request(`/api/rule-sets/${ruleSet.id}/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id }),
    });

    await app.request(`/api/groups/${group.id}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: ruleSet.id }),
    });

    notify.mockClear();

    // Dissociate rule set from group
    const dissocRes = await app.request(`/api/groups/${group.id}/rule-sets/${ruleSet.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });
    expect(dissocRes.status).toBe(200);

    // MCP push should have fired
    expect(notify).toHaveBeenCalledTimes(1);
    const notification = notify.mock.calls[0]?.[0] as {
      method: string;
      params: { rules: Array<{ id: string }> };
    };
    expect(notification.method).toBe("notifications/rules/updated");
    expect(notification.params.rules.map((r) => r.id)).not.toContain(rule.id);

    // Agent should no longer inherit the rule
    const activeRes = await app.request(`/api/agents/${agent.id}/rules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });
    const active = await activeRes.json() as { rules: Array<{ id: string }> };
    expect(active.rules.map((r) => r.id)).not.toContain(rule.id);
  });

  it("Non-admin cannot associate or dissociate group rule sets", async () => {
    const nonAdmin = await registerAgent("worker-no-group-rules");

    const assocRes = await app.request(`/api/groups/${defaultGroupId}/rule-sets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nonAdmin.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(assocRes.status).toBe(403);

    const dissocRes = await app.request(`/api/groups/${defaultGroupId}/rule-sets/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${nonAdmin.apiKey}` },
    });
    expect(dissocRes.status).toBe(403);
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

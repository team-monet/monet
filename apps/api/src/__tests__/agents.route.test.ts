import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, AgentContext } from "../middleware/context";
import { resetRateLimits } from "../middleware/rate-limit";
import { agentsRouter } from "../routes/agents";
import { parseApiKey } from "../services/api-key.service";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const GROUP_ID = "00000000-0000-0000-0000-000000000088";
const AGENT_ID = "00000000-0000-0000-0000-000000000077";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sqlMock = vi.fn();
const addMemberMock = vi.fn();
const resolveAgentRoleMock = vi.fn();
const userCanSelectAgentGroupMock = vi.fn();
const logAuditEventMock = vi.fn();
const listRuleSetsForAgentMock = vi.fn();
const associateRuleSetWithAgentMock = vi.fn();
const dissociateRuleSetFromAgentMock = vi.fn();
const getActiveRulesForAgentMock = vi.fn();

vi.mock("../services/group.service.js", () => ({
  addMember: (...args: unknown[]) => addMemberMock(...args),
  resolveAgentRole: (...args: unknown[]) => resolveAgentRoleMock(...args),
  isTenantAdmin: (role: string | null) => role === "tenant_admin",
}));

vi.mock("../services/user-group.service.js", () => ({
  userCanSelectAgentGroup: (...args: unknown[]) => userCanSelectAgentGroupMock(...args),
}));

vi.mock("../services/audit.service.js", () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEventMock(...args),
}));

vi.mock("../services/rule.service.js", () => ({
  associateRuleSetWithAgent: (...args: unknown[]) => associateRuleSetWithAgentMock(...args),
  dissociateRuleSetFromAgent: (...args: unknown[]) => dissociateRuleSetFromAgentMock(...args),
  getActiveRulesForAgent: (...args: unknown[]) => getActiveRulesForAgentMock(...args),
  listRuleSetsForAgent: (...args: unknown[]) => listRuleSetsForAgentMock(...args),
}));

function makeAgent(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    externalId: "admin@test",
    tenantId: TENANT_ID,
    isAutonomous: false,
    userId: null,
    role: "tenant_admin",
    ...overrides,
  };
}

function createTestApp(
  agentOverrides: Partial<AgentContext> = {},
  sessionStore?: {
    closeSessionsForAgent?: (agentId: string) => Promise<number>;
    getByAgentId?: (agentId: string) => unknown[];
  },
) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("agent", makeAgent(agentOverrides));
    c.set("sql", sqlMock as unknown as AppEnv["Variables"]["sql"]);
    c.set("tenantId", TENANT_ID);
    c.set("tenantSchemaName", `tenant_${TENANT_ID.replace(/-/g, "_")}`);
    if (sessionStore) {
      c.set("sessionStore", sessionStore as AppEnv["Variables"]["sessionStore"]);
    }
    await next();
  });

  app.route("/agents", agentsRouter);
  return app;
}

describe("agents route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    addMemberMock.mockResolvedValue({ success: true });
    resolveAgentRoleMock.mockImplementation(async (_sql: unknown, agent: AgentContext) => agent.role);
    userCanSelectAgentGroupMock.mockResolvedValue(true);
    logAuditEventMock.mockResolvedValue({ success: true });
    listRuleSetsForAgentMock.mockResolvedValue([]);
    associateRuleSetWithAgentMock.mockResolvedValue({ success: true });
    dissociateRuleSetFromAgentMock.mockResolvedValue({ success: true });
    getActiveRulesForAgentMock.mockResolvedValue([]);
    sqlMock.mockReset();
  });

  it("registers an autonomous agent", async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: "00000000-0000-0000-0000-000000000002",
        external_id: "worker",
        user_id: null,
        is_autonomous: true,
        created_at: "2026-03-03T00:00:00.000Z",
      },
    ]);

    const app = createTestApp();
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "worker", isAutonomous: true, groupId: GROUP_ID }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.isAutonomous).toBe(true);
    expect(body.agent.id).toMatch(UUID_RE);
    expect(parseApiKey(body.apiKey)?.agentId).toBe(body.agent.id);
  });

  it("registers with userId after validating tenant ownership", async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: USER_ID, external_id: "bound-user", email: "bound@example.com" }])
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000002",
          external_id: "user-bound",
          user_id: USER_ID,
          is_autonomous: false,
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ]);

    const app = createTestApp();
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "user-bound", userId: USER_ID, groupId: GROUP_ID }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.userId).toBe(USER_ID);
  });

  it("forces normal-user registrations to bind to the requester", async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: USER_ID, external_id: "test-user", email: "test@example.com" }])
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000002",
          external_id: "self-bound",
          user_id: USER_ID,
          role: null,
          is_autonomous: false,
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ]);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "self-bound", groupId: GROUP_ID }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.userId).toBe(USER_ID);
    expect(body.agent.isAutonomous).toBe(false);
  });

  it("requires group selection for registrations", async () => {
    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "missing-group" }),
    });

    expect(res.status).toBe(400);
  });

  it("requires group selection for tenant-admin registrations", async () => {
    const app = createTestApp();
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "missing-group-admin", isAutonomous: true }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects normal-user registration into unauthorized groups", async () => {
    userCanSelectAgentGroupMock.mockResolvedValue(false);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "forbidden-group", groupId: GROUP_ID }),
    });

    expect(res.status).toBe(403);
  });

  it("registers with groupId and adds the agent to the group", async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: "00000000-0000-0000-0000-000000000002",
        external_id: "grouped",
        user_id: null,
        is_autonomous: false,
        created_at: "2026-03-03T00:00:00.000Z",
      },
    ]);

    const app = createTestApp();
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "grouped", groupId: GROUP_ID }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(addMemberMock).toHaveBeenCalledWith(
      sqlMock,
      TENANT_ID,
      GROUP_ID,
      body.agent.id,
    );
    expect(parseApiKey(body.apiKey)?.agentId).toBe(body.agent.id);
  });

  it("returns 400 for missing externalId", async () => {
    const app = createTestApp();
    const res = await app.request("/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("allows an owning user to regenerate an agent token", async () => {
    const closeSessionsForAgent = vi.fn().mockResolvedValue(1);
    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "self-bound",
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role: "user",
          is_autonomous: false,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: USER_ID,
          owner_external_id: "bound-user",
          owner_email: "bound@example.com",
        },
      ])
      .mockResolvedValueOnce([]);

    const app = createTestApp(
      { role: "user", userId: USER_ID },
      { closeSessionsForAgent },
    );
    const res = await app.request(`/agents/${AGENT_ID}/regenerate-token`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^mnt_/);
    expect(parseApiKey(body.apiKey)?.agentId).toBe(AGENT_ID);
    expect(closeSessionsForAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sqlMock,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      expect.objectContaining({
        actorId: USER_ID,
        actorType: "user",
        action: "agent.token_regenerate",
        targetId: AGENT_ID,
        outcome: "success",
      }),
    );
  });

  it("hides regenerate token for agents owned by another user", async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: AGENT_ID,
        external_id: "other-user-agent",
        tenant_id: TENANT_ID,
        user_id: "00000000-0000-0000-0000-000000000123",
        role: "user",
        is_autonomous: false,
        revoked_at: null,
        created_at: "2026-03-03T00:00:00.000Z",
        owner_id: "00000000-0000-0000-0000-000000000123",
        owner_external_id: "other-user",
        owner_email: "other@example.com",
      },
    ]);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request(`/agents/${AGENT_ID}/regenerate-token`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  it("rejects non-admin agents without a user binding from regenerating a token", async () => {
    const app = createTestApp({ role: "user", userId: null, isAutonomous: true });
    const res = await app.request(`/agents/${AGENT_ID}/regenerate-token`, {
      method: "POST",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "forbidden",
      message: "User-bound agent access required",
    });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("rate limits regenerate-token requests", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";

    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "self-bound",
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role: "user",
          is_autonomous: false,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: USER_ID,
          owner_external_id: "bound-user",
          owner_email: "bound@example.com",
        },
      ])
      .mockResolvedValueOnce([]);

    const app = createTestApp({ role: "user", userId: USER_ID });

    const firstRes = await app.request(`/agents/${AGENT_ID}/regenerate-token`, {
      method: "POST",
    });
    const secondRes = await app.request(`/agents/${AGENT_ID}/regenerate-token`, {
      method: "POST",
    });

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(429);
  });

  it("allows a tenant admin to revoke an agent and terminate sessions", async () => {
    const closeSessionsForAgent = vi.fn().mockResolvedValue(2);
    const revokedAt = "2026-03-09T10:00:00.000Z";
    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "worker",
          tenant_id: TENANT_ID,
          user_id: null,
          role: null,
          is_autonomous: true,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: null,
          owner_external_id: null,
          owner_email: null,
        },
      ])
      .mockResolvedValueOnce([{ revoked_at: revokedAt }]);

    const app = createTestApp({}, { closeSessionsForAgent });
    const res = await app.request(`/agents/${AGENT_ID}/revoke`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.revokedAt).toBe(revokedAt);
    expect(closeSessionsForAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sqlMock,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      expect.objectContaining({
        actorType: "agent",
        action: "agent.revoke",
        targetId: AGENT_ID,
        outcome: "success",
      }),
    );
  });

  it("rejects revoke requests from non-admin users", async () => {
    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request(`/agents/${AGENT_ID}/revoke`, {
      method: "POST",
    });

    expect(res.status).toBe(403);
  });

  it("rate limits revoke requests", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";

    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "worker",
          tenant_id: TENANT_ID,
          user_id: null,
          role: null,
          is_autonomous: true,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: null,
          owner_external_id: null,
          owner_email: null,
        },
      ])
      .mockResolvedValueOnce([{ revoked_at: "2026-03-09T10:00:00.000Z" }]);

    const app = createTestApp();
    const firstRes = await app.request(`/agents/${AGENT_ID}/revoke`, {
      method: "POST",
    });
    const secondRes = await app.request(`/agents/${AGENT_ID}/revoke`, {
      method: "POST",
    });

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(429);
  });

  it("allows a tenant admin to unrevoke an agent", async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "worker",
          tenant_id: TENANT_ID,
          user_id: null,
          role: null,
          is_autonomous: true,
          revoked_at: "2026-03-08T10:00:00.000Z",
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: null,
          owner_external_id: null,
          owner_email: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const app = createTestApp();
    const res = await app.request(`/agents/${AGENT_ID}/unrevoke`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, revokedAt: null });
    expect(logAuditEventMock).toHaveBeenCalledWith(
      sqlMock,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      expect.objectContaining({
        actorType: "agent",
        action: "agent.unrevoke",
        targetId: AGENT_ID,
        outcome: "success",
      }),
    );
  });

  it("rate limits unrevoke requests", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";

    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "worker",
          tenant_id: TENANT_ID,
          user_id: null,
          role: null,
          is_autonomous: true,
          revoked_at: "2026-03-08T10:00:00.000Z",
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: null,
          owner_external_id: null,
          owner_email: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const app = createTestApp();
    const firstRes = await app.request(`/agents/${AGENT_ID}/unrevoke`, {
      method: "POST",
    });
    const secondRes = await app.request(`/agents/${AGENT_ID}/unrevoke`, {
      method: "POST",
    });

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(429);
  });

  it("returns direct rule sets for non-admin agent detail requests", async () => {
    listRuleSetsForAgentMock.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000111",
        name: "Sensitive Set",
        ruleIds: [],
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    ]);
    sqlMock
      .mockResolvedValueOnce([
        {
          id: AGENT_ID,
          external_id: "self-bound",
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role: "user",
          is_autonomous: false,
          revoked_at: null,
          created_at: "2026-03-03T00:00:00.000Z",
          owner_id: USER_ID,
          owner_external_id: "bound-user",
          owner_email: "bound@example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: GROUP_ID,
          name: "General",
          description: "",
          memory_quota: null,
          created_at: "2026-03-01T00:00:00.000Z",
        },
      ]);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleSets).toHaveLength(1);
    expect(body.ruleSets[0]).toMatchObject({ name: "Sensitive Set" });
    expect(listRuleSetsForAgentMock).toHaveBeenCalledWith(
      sqlMock,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      AGENT_ID,
    );
  });

  it("allows an owning user to attach a rule set to their agent", async () => {
    const sessionStore = { getByAgentId: vi.fn().mockReturnValue([]) };
    sqlMock.mockResolvedValueOnce([
      {
        id: AGENT_ID,
        external_id: "self-bound",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role: "user",
        is_autonomous: false,
        revoked_at: null,
        created_at: "2026-03-03T00:00:00.000Z",
        owner_id: USER_ID,
        owner_external_id: "bound-user",
        owner_email: "bound@example.com",
      },
    ]);

    const app = createTestApp({ role: "user", userId: USER_ID }, sessionStore);
    const res = await app.request(`/agents/${AGENT_ID}/rule-sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: "00000000-0000-0000-0000-000000000222" }),
    });

    expect(res.status).toBe(201);
    expect(associateRuleSetWithAgentMock).toHaveBeenCalledWith(
      sqlMock,
      TENANT_ID,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      {
        actorId: USER_ID,
        actorType: "user",
      },
      AGENT_ID,
      "00000000-0000-0000-0000-000000000222",
    );
  });

  it("returns forbidden when a personal rule set does not belong to the target agent owner", async () => {
    const sessionStore = { getByAgentId: vi.fn().mockReturnValue([]) };
    sqlMock.mockResolvedValueOnce([
      {
        id: AGENT_ID,
        external_id: "self-bound",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role: "user",
        is_autonomous: false,
        revoked_at: null,
        created_at: "2026-03-03T00:00:00.000Z",
        owner_id: USER_ID,
        owner_external_id: "bound-user",
        owner_email: "bound@example.com",
      },
    ]);
    associateRuleSetWithAgentMock.mockResolvedValueOnce({ error: "forbidden" });

    const app = createTestApp({ role: "user", userId: USER_ID }, sessionStore);
    const res = await app.request(`/agents/${AGENT_ID}/rule-sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleSetId: "00000000-0000-0000-0000-000000000333" }),
    });

    expect(res.status).toBe(403);
  });

  it("allows an owning user to view active rules for their agent", async () => {
    getActiveRulesForAgentMock.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000333",
        name: "Rule A",
        description: "Desc A",
        createdAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      },
    ]);
    sqlMock.mockResolvedValueOnce([
      {
        id: AGENT_ID,
        external_id: "self-bound",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role: "user",
        is_autonomous: false,
        revoked_at: null,
        created_at: "2026-03-03T00:00:00.000Z",
        owner_id: USER_ID,
        owner_external_id: "bound-user",
        owner_email: "bound@example.com",
      },
    ]);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request(`/agents/${AGENT_ID}/rules`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toHaveLength(1);
    expect(getActiveRulesForAgentMock).toHaveBeenCalledWith(
      sqlMock,
      `tenant_${TENANT_ID.replace(/-/g, "_")}`,
      AGENT_ID,
    );
  });
});

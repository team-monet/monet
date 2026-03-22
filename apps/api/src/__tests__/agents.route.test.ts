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
const loadPlatformAgentRecordMock = vi.fn();
const loadPlatformUserOwnerMock = vi.fn();
const deletePlatformAgentMock = vi.fn();
const rotatePlatformAgentTokenMock = vi.fn();
const revokePlatformAgentMock = vi.fn();
const unrevokePlatformAgentMock = vi.fn();
const listPlatformAgentsMock = vi.fn();
const listPlatformAgentGroupsMock = vi.fn();
const drizzleMock = vi.fn();
const insertMock = vi.fn();
const valuesMock = vi.fn();
const returningMock = vi.fn();
const sqlClientMock = Object.assign(sqlMock, {
  options: {
    parsers: {},
    serializers: {},
  },
});

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: unknown[]) => drizzleMock(...args),
}));

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

vi.mock("../services/platform-agent.service.js", () => ({
  loadPlatformAgentRecord: (...args: unknown[]) => loadPlatformAgentRecordMock(...args),
  loadPlatformUserOwner: (...args: unknown[]) => loadPlatformUserOwnerMock(...args),
  deletePlatformAgent: (...args: unknown[]) => deletePlatformAgentMock(...args),
  rotatePlatformAgentToken: (...args: unknown[]) => rotatePlatformAgentTokenMock(...args),
  revokePlatformAgent: (...args: unknown[]) => revokePlatformAgentMock(...args),
  unrevokePlatformAgent: (...args: unknown[]) => unrevokePlatformAgentMock(...args),
  listPlatformAgents: (...args: unknown[]) => listPlatformAgentsMock(...args),
  listPlatformAgentGroups: (...args: unknown[]) => listPlatformAgentGroupsMock(...args),
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

function makePlatformAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: AGENT_ID,
    externalId: "worker",
    tenantId: TENANT_ID,
    userId: null,
    role: null,
    isAutonomous: true,
    revokedAt: null,
    createdAt: new Date("2026-03-03T00:00:00.000Z"),
    ownerId: null,
    ownerExternalId: null,
    ownerDisplayName: null,
    ownerEmail: null,
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
    c.set("db", {} as AppEnv["Variables"]["db"]);
    c.set("sql", sqlClientMock as unknown as AppEnv["Variables"]["sql"]);
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
    loadPlatformAgentRecordMock.mockResolvedValue(null);
    loadPlatformUserOwnerMock.mockResolvedValue(null);
    deletePlatformAgentMock.mockResolvedValue(undefined);
    rotatePlatformAgentTokenMock.mockResolvedValue(undefined);
    revokePlatformAgentMock.mockResolvedValue(null);
    unrevokePlatformAgentMock.mockResolvedValue(undefined);
    listPlatformAgentsMock.mockResolvedValue([]);
    listPlatformAgentGroupsMock.mockResolvedValue([]);
    returningMock.mockResolvedValue([
      {
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    valuesMock.mockReturnValue({
      returning: returningMock,
    });
    insertMock.mockReturnValue({
      values: valuesMock,
    });
    drizzleMock.mockReturnValue({
      insert: insertMock,
    });
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
    loadPlatformUserOwnerMock.mockResolvedValueOnce({
      id: USER_ID,
      externalId: "bound-user",
      displayName: null,
      email: "bound@example.com",
    });
    sqlMock
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
    loadPlatformUserOwnerMock.mockResolvedValueOnce({
      id: USER_ID,
      externalId: "test-user",
      displayName: null,
      email: "test@example.com",
    });
    sqlMock
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

  it("cleans up the provisioned agent when group assignment fails", async () => {
    addMemberMock.mockResolvedValueOnce({
      error: "not_found",
      message: "Group not found",
    });
    sqlMock.mockResolvedValueOnce([
      {
        id: AGENT_ID,
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

    expect(res.status).toBe(404);
    expect(deletePlatformAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.stringMatching(UUID_RE),
    );
  });

  it("lists all tenant agents for admins", async () => {
    listPlatformAgentsMock.mockResolvedValueOnce([
      makePlatformAgentRow(),
    ]);

    const app = createTestApp();
    const res = await app.request("/agents");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({
        id: AGENT_ID,
        externalId: "worker",
      }),
    ]);
    expect(listPlatformAgentsMock).toHaveBeenCalledWith(expect.anything(), TENANT_ID, {
      isAdmin: true,
    });
  });

  it("lists only user-bound agents for non-admin callers", async () => {
    listPlatformAgentsMock.mockResolvedValueOnce([
      makePlatformAgentRow({
        userId: USER_ID,
        externalId: "self-bound",
        isAutonomous: false,
        ownerId: USER_ID,
        ownerExternalId: "bound-user",
        ownerEmail: "bound@example.com",
      }),
    ]);

    const app = createTestApp({ role: "user", userId: USER_ID });
    const res = await app.request("/agents");

    expect(res.status).toBe(200);
    expect(listPlatformAgentsMock).toHaveBeenCalledWith(expect.anything(), TENANT_ID, {
      isAdmin: false,
      requesterUserId: USER_ID,
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({
        userId: USER_ID,
        externalId: "self-bound",
      }),
    ]);
  });

  it("returns an empty list for non-admin callers without a user binding", async () => {
    const app = createTestApp({ role: "user", userId: null, isAutonomous: true });
    const res = await app.request("/agents");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(listPlatformAgentsMock).not.toHaveBeenCalled();
  });

  it("allows an owning user to regenerate an agent token", async () => {
    const closeSessionsForAgent = vi.fn().mockResolvedValue(1);
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });

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
    expect(rotatePlatformAgentTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      AGENT_ID,
      expect.any(String),
      expect.any(String),
    );
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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "other-user-agent",
      tenantId: TENANT_ID,
      userId: "00000000-0000-0000-0000-000000000123",
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: "00000000-0000-0000-0000-000000000123",
      ownerExternalId: "other-user",
      ownerDisplayName: null,
      ownerEmail: "other@example.com",
    });

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

    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });

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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "worker",
      tenantId: TENANT_ID,
      userId: null,
      role: null,
      isAutonomous: true,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: null,
      ownerExternalId: null,
      ownerDisplayName: null,
      ownerEmail: null,
    });
    revokePlatformAgentMock.mockResolvedValueOnce(revokedAt);

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

    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "worker",
      tenantId: TENANT_ID,
      userId: null,
      role: null,
      isAutonomous: true,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: null,
      ownerExternalId: null,
      ownerDisplayName: null,
      ownerEmail: null,
    });
    revokePlatformAgentMock.mockResolvedValueOnce("2026-03-09T10:00:00.000Z");

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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "worker",
      tenantId: TENANT_ID,
      userId: null,
      role: null,
      isAutonomous: true,
      revokedAt: new Date("2026-03-08T10:00:00.000Z"),
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: null,
      ownerExternalId: null,
      ownerDisplayName: null,
      ownerEmail: null,
    });

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

    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "worker",
      tenantId: TENANT_ID,
      userId: null,
      role: null,
      isAutonomous: true,
      revokedAt: new Date("2026-03-08T10:00:00.000Z"),
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: null,
      ownerExternalId: null,
      ownerDisplayName: null,
      ownerEmail: null,
    });

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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });
    listPlatformAgentGroupsMock.mockResolvedValueOnce([
      {
        id: GROUP_ID,
        name: "General",
        description: "",
        memoryQuota: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });

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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });
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
    loadPlatformAgentRecordMock.mockResolvedValueOnce({
      id: AGENT_ID,
      externalId: "self-bound",
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "user",
      isAutonomous: false,
      revokedAt: null,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      ownerId: USER_ID,
      ownerExternalId: "bound-user",
      ownerDisplayName: null,
      ownerEmail: "bound@example.com",
    });

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

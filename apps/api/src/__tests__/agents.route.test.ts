import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, AgentContext } from "../middleware/context.js";
import { agentsRouter } from "../routes/agents.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const GROUP_ID = "00000000-0000-0000-0000-000000000088";

const sqlMock = vi.fn();
const addMemberMock = vi.fn();
const resolveAgentRoleMock = vi.fn();

vi.mock("../services/group.service.js", () => ({
  addMember: (...args: unknown[]) => addMemberMock(...args),
  resolveAgentRole: (...args: unknown[]) => resolveAgentRoleMock(...args),
  isTenantAdmin: (role: string | null) => role === "tenant_admin",
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

function createTestApp(agentOverrides: Partial<AgentContext> = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("agent", makeAgent(agentOverrides));
    c.set("sql", sqlMock as unknown as AppEnv["Variables"]["sql"]);
    c.set("tenantSchemaName", `tenant_${TENANT_ID.replace(/-/g, "_")}`);
    await next();
  });

  app.route("/agents", agentsRouter);
  return app;
}

describe("agents route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMemberMock.mockResolvedValue({ success: true });
    resolveAgentRoleMock.mockImplementation(async (_sql: unknown, agent: AgentContext) => agent.role);
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
      body: JSON.stringify({ externalId: "worker", isAutonomous: true }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.isAutonomous).toBe(true);
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
      body: JSON.stringify({ externalId: "user-bound", userId: USER_ID }),
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
      body: JSON.stringify({ externalId: "self-bound" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.userId).toBe(USER_ID);
    expect(body.agent.isAutonomous).toBe(false);
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
    expect(addMemberMock).toHaveBeenCalledWith(
      sqlMock,
      TENANT_ID,
      GROUP_ID,
      "00000000-0000-0000-0000-000000000002",
    );
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
});

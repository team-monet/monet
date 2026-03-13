import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, AgentContext } from "../middleware/context";
import { userGroupsRouter } from "../routes/user-groups";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";

const listUserGroupsMock = vi.fn();
const getUserGroupDetailMock = vi.fn();
const createUserGroupMock = vi.fn();
const updateUserGroupMock = vi.fn();
const addUserGroupMemberMock = vi.fn();
const removeUserGroupMemberMock = vi.fn();
const saveUserGroupAgentGroupPermissionsMock = vi.fn();

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

vi.mock("../services/group.service.js", async () => {
  const actual = await vi.importActual("../services/group.service.js");
  return {
    ...actual,
    resolveAgentRole: vi.fn(async (_sql: unknown, agent: AgentContext) => agent.role),
    isTenantAdmin: (role: string | null) => role === "tenant_admin",
  };
});

vi.mock("../services/user-group.service.js", () => ({
  listUserGroups: (...args: unknown[]) => listUserGroupsMock(...args),
  getUserGroupDetail: (...args: unknown[]) => getUserGroupDetailMock(...args),
  createUserGroup: (...args: unknown[]) => createUserGroupMock(...args),
  updateUserGroup: (...args: unknown[]) => updateUserGroupMock(...args),
  addUserGroupMember: (...args: unknown[]) => addUserGroupMemberMock(...args),
  removeUserGroupMember: (...args: unknown[]) => removeUserGroupMemberMock(...args),
  saveUserGroupAgentGroupPermissions: (...args: unknown[]) =>
    saveUserGroupAgentGroupPermissionsMock(...args),
}));

function createTestApp(agent: AgentContext) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("agent", agent);
    c.set("sql", {} as AppEnv["Variables"]["sql"]);
    c.set("tenantSchemaName", `tenant_${TENANT_ID.replace(/-/g, "_")}`);
    await next();
  });

  app.route("/user-groups", userGroupsRouter);
  return app;
}

describe("user groups route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUserGroupsMock.mockResolvedValue([]);
    getUserGroupDetailMock.mockResolvedValue(null);
    createUserGroupMock.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000200",
      name: "Everyone",
      description: "",
      createdAt: "2026-03-09T00:00:00.000Z",
    });
    updateUserGroupMock.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000200",
      name: "Everyone",
      description: "",
      createdAt: "2026-03-09T00:00:00.000Z",
    });
    addUserGroupMemberMock.mockResolvedValue({ success: true });
    removeUserGroupMemberMock.mockResolvedValue({ success: true });
    saveUserGroupAgentGroupPermissionsMock.mockResolvedValue({ success: true });
  });

  it("requires tenant admin for list", async () => {
    const app = createTestApp(makeAgent({ role: "user" }));
    const res = await app.request("/user-groups");
    expect(res.status).toBe(403);
  });

  it("lists user groups for tenant admin", async () => {
    listUserGroupsMock.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000200",
        name: "Everyone",
        description: "",
        createdAt: "2026-03-09T00:00:00.000Z",
        memberCount: 1,
        allowedAgentGroupCount: 1,
      },
    ]);

    const app = createTestApp(makeAgent());
    const res = await app.request("/user-groups");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
  });

  it("creates a user group", async () => {
    const app = createTestApp(makeAgent());
    const res = await app.request("/user-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Support" }),
    });

    expect(res.status).toBe(201);
  });

  it("returns 404 for missing user-group detail", async () => {
    const app = createTestApp(makeAgent());
    const res = await app.request(
      "/user-groups/00000000-0000-0000-0000-000000000200",
    );

    expect(res.status).toBe(404);
  });

  it("adds a user-group member", async () => {
    const app = createTestApp(makeAgent());
    const res = await app.request(
      "/user-groups/00000000-0000-0000-0000-000000000200/members",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "00000000-0000-0000-0000-000000000300",
        }),
      },
    );

    expect(res.status).toBe(201);
  });

  it("validates agent-group permission payloads", async () => {
    const app = createTestApp(makeAgent());
    const res = await app.request(
      "/user-groups/00000000-0000-0000-0000-000000000200/agent-groups",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentGroupIds: ["bad-id"] }),
      },
    );

    expect(res.status).toBe(400);
  });
});

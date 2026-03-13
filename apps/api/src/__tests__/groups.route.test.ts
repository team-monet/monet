import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv, AgentContext } from "../middleware/context";
import { groupsRouter } from "../routes/groups";

const TENANT_ID = "00000000-0000-0000-0000-000000000010";

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

// Mock resolveAgentRole to return the agent's role directly
vi.mock("../services/group.service.js", async () => {
  const actual = await vi.importActual("../services/group.service.js");
  return {
    ...actual,
    resolveAgentRole: vi.fn(async (_sql: unknown, agent: AgentContext) => agent.role),
    createGroup: vi.fn(async () => ({
      id: "group-1",
      tenantId: TENANT_ID,
      name: "test-group",
      description: "",
      memoryQuota: null,
      createdAt: "2025-01-01",
    })),
    addMember: vi.fn(async () => ({ success: true, operation: "created" })),
    removeMember: vi.fn(async () => ({ success: true })),
    listGroups: vi.fn(async () => []),
    listGroupMembers: vi.fn(async () => ({ members: [] })),
  };
});

function createTestApp(agent: AgentContext) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("agent", agent);
    c.set("sql", {} as AppEnv["Variables"]["sql"]);
    c.set("tenantSchemaName", `tenant_${TENANT_ID.replace(/-/g, "_")}`);
    await next();
  });

  app.route("/groups", groupsRouter);
  return app;
}

describe("groups route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /groups", () => {
    it("returns 201 for tenant admin", async () => {
      const app = createTestApp(makeAgent());
      const res = await app.request("/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-group" }),
      });
      expect(res.status).toBe(201);
    });

    it("returns 403 for non-admin", async () => {
      const app = createTestApp(makeAgent({ role: null }));
      const res = await app.request("/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-group" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 for missing name", async () => {
      const app = createTestApp(makeAgent());
      const res = await app.request("/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid memoryQuota", async () => {
      const app = createTestApp(makeAgent());
      const res = await app.request("/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-group", memoryQuota: "2" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /:id/members", () => {
    it("returns 403 for regular agent", async () => {
      const app = createTestApp(makeAgent({ role: "user" }));
      const res = await app.request("/groups/group-1/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "00000000-0000-0000-0000-000000000002" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 201 for group admin", async () => {
      const app = createTestApp(makeAgent({ role: "group_admin" }));
      const res = await app.request("/groups/group-1/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "00000000-0000-0000-0000-000000000002" }),
      });
      expect(res.status).toBe(201);
    });

    it("returns 200 when reassigning an agent to a new group", async () => {
      const groupService = await import("../services/group.service.js");
      vi.mocked(groupService.addMember).mockResolvedValueOnce({
        success: true,
        operation: "moved",
      });

      const app = createTestApp(makeAgent({ role: "group_admin" }));
      const res = await app.request("/groups/group-1/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "00000000-0000-0000-0000-000000000002" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /:id/members", () => {
    it("returns 200 for tenant admin", async () => {
      const app = createTestApp(makeAgent());
      const res = await app.request("/groups/group-1/members");
      expect(res.status).toBe(200);
    });

    it("returns 403 for group admin", async () => {
      const app = createTestApp(makeAgent({ role: "group_admin" }));
      const res = await app.request("/groups/group-1/members");
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:id/members/:agentId", () => {
    it("returns 403 for regular agent", async () => {
      const app = createTestApp(makeAgent({ role: null }));
      const res = await app.request(
        "/groups/group-1/members/00000000-0000-0000-0000-000000000002",
        { method: "DELETE" },
      );
      expect(res.status).toBe(403);
    });

    it("returns 409 when removing the agent's final group", async () => {
      const groupService = await import("../services/group.service.js");
      vi.mocked(groupService.removeMember).mockResolvedValueOnce({
        error: "conflict",
        message:
          "Agents must remain assigned to a group. Move the agent to a new group instead.",
      });

      const app = createTestApp(makeAgent({ role: "group_admin" }));
      const res = await app.request(
        "/groups/group-1/members/00000000-0000-0000-0000-000000000002",
        { method: "DELETE" },
      );
      expect(res.status).toBe(409);
    });
  });

  describe("POST /users/:userId/admin", () => {
    it("returns 403 for non-admin", async () => {
      const app = createTestApp(makeAgent({ role: null }));
      const res = await app.request(
        "/groups/users/00000000-0000-0000-0000-000000000099/admin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "group_admin" }),
        },
      );
      expect(res.status).toBe(403);
    });
  });
});

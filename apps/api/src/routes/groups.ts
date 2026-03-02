import { Hono } from "hono";
import type { AppEnv } from "../middleware/context.js";
import {
  resolveAgentRole,
  isTenantAdmin,
  isGroupAdminOrAbove,
  createGroup,
  addMember,
  removeMember,
  listGroups,
  listGroupMembers,
} from "../services/group.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PROMOTE_ROLES = ["group_admin", "user"] as const;

function parseCreateGroupInput(body: unknown): { data: { name: string; description?: string; memoryQuota?: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.name !== "string" || b.name.length === 0) {
    return { error: "Name is required" };
  }
  return {
    data: {
      name: b.name,
      description: typeof b.description === "string" ? b.description : undefined,
      memoryQuota: typeof b.memoryQuota === "string" ? b.memoryQuota : undefined,
    },
  };
}

function parseAddMemberInput(body: unknown): { data: { agentId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.agentId !== "string" || !UUID_RE.test(b.agentId)) {
    return { error: "Valid agentId (UUID) is required" };
  }
  return { data: { agentId: b.agentId } };
}

function parsePromoteUserInput(body: unknown): { data: { role: "group_admin" | "user" } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || !VALID_PROMOTE_ROLES.includes(b.role as typeof VALID_PROMOTE_ROLES[number])) {
    return { error: "Role must be one of: group_admin, user" };
  }
  return { data: { role: b.role as "group_admin" | "user" } };
}

export const groupsRouter = new Hono<AppEnv>();

// POST / — create a group (Tenant_Admin only)
groupsRouter.post("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  const body = await c.req.json();
  const parsed = parseCreateGroupInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const group = await createGroup(sql, agent.tenantId, parsed.data);
  return c.json(group, 201);
});

// GET / — list groups in tenant
groupsRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const groups = await listGroups(sql, agent.tenantId);
  return c.json({ groups });
});

// GET /:id/members — list members of a group
groupsRouter.get("/:id/members", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const groupId = c.req.param("id");

  const result = await listGroupMembers(sql, agent.tenantId, groupId);
  if ("error" in result) {
    return c.json({ error: "not_found", message: "Group not found" }, 404);
  }

  return c.json(result);
});

// POST /:id/members — add agent to group (Group_Admin or Tenant_Admin)
groupsRouter.post("/:id/members", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const groupId = c.req.param("id");

  const role = await resolveAgentRole(sql, agent);
  if (!isGroupAdminOrAbove(role)) {
    return c.json({ error: "forbidden", message: "Group admin role required" }, 403);
  }

  const body = await c.req.json();
  const parsed = parseAddMemberInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const result = await addMember(sql, agent.tenantId, groupId, parsed.data.agentId);
  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: result.message }, 404);
    }
    return c.json({ error: "conflict", message: result.message }, 409);
  }

  return c.json({ success: true }, 201);
});

// POST /users/:userId/admin — promote user to Group_Admin (Tenant_Admin only)
groupsRouter.post("/users/:userId/admin", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const userId = c.req.param("userId");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  const body = await c.req.json();
  const parsed = parsePromoteUserInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  // Verify user belongs to this tenant
  const [user] = await sql`
    SELECT id, role FROM human_users WHERE id = ${userId} AND tenant_id = ${agent.tenantId}
  `;
  if (!user) {
    return c.json({ error: "not_found", message: "User not found" }, 404);
  }

  await sql`
    UPDATE human_users SET role = ${parsed.data.role} WHERE id = ${userId}
  `;

  return c.json({ success: true, userId, role: parsed.data.role });
});

// DELETE /:id/members/:agentId — remove agent from group (Group_Admin or Tenant_Admin)
groupsRouter.delete("/:id/members/:agentId", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const groupId = c.req.param("id");
  const agentId = c.req.param("agentId");

  const role = await resolveAgentRole(sql, agent);
  if (!isGroupAdminOrAbove(role)) {
    return c.json({ error: "forbidden", message: "Group admin role required" }, 403);
  }

  const result = await removeMember(sql, agent.tenantId, groupId, agentId);
  if ("error" in result) {
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  return c.json({ success: true });
});

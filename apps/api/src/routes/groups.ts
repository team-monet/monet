import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import {
  resolveAgentRole,
  isTenantAdmin,
  isGroupAdminOrAbove,
  createGroup,
  updateGroup,
  addMember,
  removeMember,
  listGroups,
  listGroupMembers,
} from "../services/group.service";
import { listRuleSetsForGroup } from "../services/rule.service";
import { pushRulesToAgent } from "../services/rule-notification.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PROMOTE_ROLES = ["group_admin", "user"] as const;

function parseCreateGroupInput(body: unknown): { data: { name: string; description?: string; memoryQuota?: number } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.name !== "string" || b.name.length === 0) {
    return { error: "Name is required" };
  }
  if (b.memoryQuota !== undefined && (!Number.isInteger(b.memoryQuota) || Number(b.memoryQuota) <= 0)) {
    return { error: "memoryQuota must be a positive integer" };
  }
  return {
    data: {
      name: b.name,
      description: typeof b.description === "string" ? b.description : undefined,
      memoryQuota: typeof b.memoryQuota === "number" ? b.memoryQuota : undefined,
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

function parseUpdateGroupInput(body: unknown): { data: { name?: string; description?: string; memoryQuota?: number } } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const b = body as Record<string, unknown>;
  if (b.memoryQuota !== undefined && b.memoryQuota !== null && (!Number.isInteger(b.memoryQuota) || Number(b.memoryQuota) <= 0)) {
    return { error: "memoryQuota must be a positive integer" };
  }
  return {
    data: {
      name: typeof b.name === "string" ? b.name : undefined,
      description: typeof b.description === "string" ? b.description : undefined,
      memoryQuota: typeof b.memoryQuota === "number" ? b.memoryQuota : undefined,
    },
  };
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

// PATCH /:id — update group (Tenant_Admin only)
groupsRouter.patch("/:id", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const groupId = c.req.param("id");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  const body = await c.req.json();
  const parsed = parseUpdateGroupInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const result = await updateGroup(sql, agent.tenantId, groupId, parsed.data);
  if ("error" in result) {
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  return c.json(result);
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
  const role = await resolveAgentRole(sql, agent);

  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  const result = await listGroupMembers(sql, agent.tenantId, groupId);
  if ("error" in result) {
    return c.json({ error: "not_found", message: "Group not found" }, 404);
  }

  return c.json(result);
});

// GET /:id/rule-sets — list rule sets applied to a group (Tenant_Admin only)
groupsRouter.get("/:id/rule-sets", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const groupId = c.req.param("id");
  const role = await resolveAgentRole(sql, agent);

  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  const groups = await listGroups(sql, agent.tenantId);
  if (!groups.some((group) => group.id === groupId)) {
    return c.json({ error: "not_found", message: "Group not found" }, 404);
  }

  const ruleSets = await listRuleSetsForGroup(sql, schemaName, groupId);
  return c.json({ ruleSets });
});

// POST /:id/members — add agent to group (Group_Admin or Tenant_Admin)
groupsRouter.post("/:id/members", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const schemaName = c.get("tenantSchemaName");
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

  if (sessionStore) {
    await pushRulesToAgent(parsed.data.agentId, sessionStore, sql, schemaName);
  }

  return c.json(
    { success: true, operation: result.operation },
    result.operation === "created" ? 201 : 200,
  );
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
    SELECT id, role FROM users WHERE id = ${userId} AND tenant_id = ${agent.tenantId}
  `;
  if (!user) {
    return c.json({ error: "not_found", message: "User not found" }, 404);
  }

  await sql`
    UPDATE users SET role = ${parsed.data.role} WHERE id = ${userId}
  `;

  return c.json({ success: true, userId, role: parsed.data.role });
});

// DELETE /:id/members/:agentId — remove agent from group (Group_Admin or Tenant_Admin)
groupsRouter.delete("/:id/members/:agentId", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const schemaName = c.get("tenantSchemaName");
  const groupId = c.req.param("id");
  const agentId = c.req.param("agentId");

  const role = await resolveAgentRole(sql, agent);
  if (!isGroupAdminOrAbove(role)) {
    return c.json({ error: "forbidden", message: "Group admin role required" }, 403);
  }

  const result = await removeMember(sql, agent.tenantId, groupId, agentId);
  if ("error" in result) {
    if (result.error === "conflict") {
      return c.json({ error: "conflict", message: result.message }, 409);
    }
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  if (sessionStore) {
    await pushRulesToAgent(agentId, sessionStore, sql, schemaName);
  }

  return c.json({ success: true });
});

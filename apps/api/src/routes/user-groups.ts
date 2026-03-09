import { Hono, type Context } from "hono";
import type { AppEnv } from "../middleware/context.js";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service.js";
import {
  addUserGroupMember,
  createUserGroup,
  getUserGroupDetail,
  listUserGroups,
  removeUserGroupMember,
  saveUserGroupAgentGroupPermissions,
  updateUserGroup,
} from "../services/user-group.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCreateUserGroupInput(
  body: unknown,
): { data: { name: string; description?: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.name !== "string" || b.name.trim().length === 0) {
    return { error: "Name is required" };
  }

  return {
    data: {
      name: b.name.trim(),
      description: typeof b.description === "string" ? b.description.trim() : undefined,
    },
  };
}

function parseUpdateUserGroupInput(
  body: unknown,
): { data: { name?: string; description?: string } } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }

  const b = body as Record<string, unknown>;
  return {
    data: {
      name: typeof b.name === "string" ? b.name.trim() : undefined,
      description: typeof b.description === "string" ? b.description.trim() : undefined,
    },
  };
}

function parseUserGroupMemberInput(
  body: unknown,
): { data: { userId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.userId !== "string" || !UUID_RE.test(b.userId)) {
    return { error: "Valid userId (UUID) is required" };
  }

  return { data: { userId: b.userId } };
}

function parseUserGroupPermissionsInput(
  body: unknown,
): { data: { agentGroupIds: string[] } } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }

  const b = body as Record<string, unknown>;
  if (
    !Array.isArray(b.agentGroupIds) ||
    !b.agentGroupIds.every((value) => typeof value === "string" && UUID_RE.test(value))
  ) {
    return { error: "agentGroupIds must be an array of UUIDs" };
  }

  return { data: { agentGroupIds: [...new Set(b.agentGroupIds)] as string[] } };
}

async function requireTenantAdmin(c: Context<AppEnv>) {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, agent);

  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  return null;
}

export const userGroupsRouter = new Hono<AppEnv>();

userGroupsRouter.get("/", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const groups = await listUserGroups(sql, agent.tenantId);
  return c.json({ groups });
});

userGroupsRouter.get("/:id", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const detail = await getUserGroupDetail(sql, agent.tenantId, c.req.param("id"));

  if (!detail) {
    return c.json({ error: "not_found", message: "User group not found" }, 404);
  }

  return c.json(detail);
});

userGroupsRouter.post("/", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const body = await c.req.json();
  const parsed = parseCreateUserGroupInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const group = await createUserGroup(sql, agent.tenantId, parsed.data);
  return c.json(group, 201);
});

userGroupsRouter.patch("/:id", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const body = await c.req.json();
  const parsed = parseUpdateUserGroupInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const result = await updateUserGroup(sql, agent.tenantId, c.req.param("id"), parsed.data);
  if ("error" in result) {
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  return c.json(result);
});

userGroupsRouter.post("/:id/members", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const body = await c.req.json();
  const parsed = parseUserGroupMemberInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const result = await addUserGroupMember(
    sql,
    agent.tenantId,
    c.req.param("id"),
    parsed.data.userId,
  );
  if ("error" in result) {
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  return c.json({ success: true }, 201);
});

userGroupsRouter.delete("/:id/members/:userId", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const result = await removeUserGroupMember(
    sql,
    agent.tenantId,
    c.req.param("id"),
    c.req.param("userId"),
  );
  if ("error" in result) {
    return c.json({ error: "not_found", message: result.message }, 404);
  }

  return c.json({ success: true });
});

userGroupsRouter.put("/:id/agent-groups", async (c) => {
  const adminResponse = await requireTenantAdmin(c);
  if (adminResponse) {
    return adminResponse;
  }

  const agent = c.get("agent");
  const sql = c.get("sql");
  const body = await c.req.json();
  const parsed = parseUserGroupPermissionsInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const result = await saveUserGroupAgentGroupPermissions(
    sql,
    agent.tenantId,
    c.req.param("id"),
    parsed.data.agentGroupIds,
  );

  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    const code = result.error === "not_found" ? "not_found" : "validation_error";
    return c.json({ error: code, message: result.message }, status);
  }

  return c.json({ success: true });
});

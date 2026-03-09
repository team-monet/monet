import { Hono, type Context } from "hono";
import { RegisterAgentApiInput } from "@monet/types";
import { addMember, resolveAgentRole, isTenantAdmin } from "../services/group.service.js";
import {
  associateRuleSetWithAgent,
  dissociateRuleSetFromAgent,
  getActiveRulesForAgent,
  listRuleSetsForAgent,
} from "../services/rule.service.js";
import { pushRulesToAgent } from "../services/rule-notification.service.js";
import type { AppEnv } from "../middleware/context.js";
import { provisionAgentWithApiKey } from "../services/agent-provisioning.service.js";
import { userCanSelectAgentGroup } from "../services/human-group.service.js";

export const agentsRouter = new Hono<AppEnv>();
const DASHBOARD_AGENT_PREFIX = "dashboard:";

type AgentRow = {
  id: string;
  external_id: string;
  tenant_id: string;
  user_id: string | null;
  role: "user" | "group_admin" | "tenant_admin" | null;
  is_autonomous: boolean;
  revoked_at: Date | null;
  created_at: Date;
  owner_id: string | null;
  owner_external_id: string | null;
  owner_email: string | null;
};

function ownerLabel(row: AgentRow) {
  return row.owner_email ?? row.owner_external_id ?? null;
}

function displayName(row: AgentRow) {
  if (row.is_autonomous) {
    return `${row.external_id} (Autonomous)`;
  }

  const label = ownerLabel(row);
  return label ? `${row.external_id} · ${label}` : row.external_id;
}

function mapAgent(row: AgentRow) {
  const label = ownerLabel(row);

  return {
    id: row.id,
    externalId: row.external_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    isAutonomous: row.is_autonomous,
    role: row.role,
    revokedAt: row.revoked_at,
    displayName: displayName(row),
    owner:
      row.owner_id && label
        ? {
            id: row.owner_id,
            externalId: row.owner_external_id ?? label,
            email: row.owner_email,
            label,
          }
        : null,
    createdAt: row.created_at,
  };
}

async function loadAgentRow(
  sql: AppEnv["Variables"]["sql"],
  tenantId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const [row] = await sql`
    SELECT
      a.id,
      a.external_id,
      a.tenant_id,
      a.user_id,
      a.role,
      a.is_autonomous,
      a.revoked_at,
      a.created_at,
      u.id AS owner_id,
      u.external_id AS owner_external_id,
      u.email AS owner_email
    FROM agents a
    LEFT JOIN human_users u ON u.id = a.user_id
    WHERE a.id = ${agentId}
      AND a.tenant_id = ${tenantId}
      AND a.external_id NOT LIKE ${`${DASHBOARD_AGENT_PREFIX}%`}
    LIMIT 1
  `;

  return (row as AgentRow | undefined) ?? null;
}

async function loadAccessibleAgentRow(
  c: Context<AppEnv>,
  agentId: string,
): Promise<{ row: AgentRow; isAdmin: boolean } | { response: Response }> {
  const requester = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, requester);
  const admin = isTenantAdmin(role);
  const row = await loadAgentRow(sql, requester.tenantId, agentId);

  if (!row) {
    return {
      response: c.json({ error: "not_found", message: "Agent not found" }, 404),
    };
  }

  if (!admin && (!requester.userId || row.user_id !== requester.userId)) {
    return {
      response: c.json({ error: "not_found", message: "Agent not found" }, 404),
    };
  }

  return { row, isAdmin: admin };
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

async function ensureAgentInTenant(sql: AppEnv["Variables"]["sql"], tenantId: string, agentId: string) {
  const [row] = await sql`
    SELECT id FROM agents WHERE id = ${agentId} AND tenant_id = ${tenantId}
  `;
  return Boolean(row);
}

function parseAgentRuleSetAssociationInput(
  body: unknown,
): { data: { ruleSetId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!b || typeof b.ruleSetId !== "string" || !UUID_RE.test(b.ruleSetId)) {
    return { error: "Valid ruleSetId (UUID) is required" };
  }
  return { data: { ruleSetId: b.ruleSetId } };
}

/**
 * POST /api/agents/register — register a new agent in the current tenant.
 */
agentsRouter.post("/register", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, agent);
  const admin = isTenantAdmin(role);

  const body = await c.req.json();
  const parsed = RegisterAgentApiInput.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        message: "Invalid input",
        details: parsed.error.flatten().fieldErrors,
      },
      400,
    );
  }

  if (!admin && !agent.userId) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  if (!admin && parsed.data.isAutonomous) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can register autonomous agents" },
      403,
    );
  }

  if (!admin && parsed.data.userId && parsed.data.userId !== agent.userId) {
    return c.json(
      { error: "forbidden", message: "Normal users can only register agents bound to themselves" },
      403,
    );
  }

  if (parsed.data.isAutonomous && parsed.data.userId) {
    return c.json(
      { error: "validation_error", message: "Autonomous agents cannot have a user binding" },
      400,
    );
  }

  if (!admin && !parsed.data.groupId) {
    return c.json(
      { error: "validation_error", message: "Group selection is required for normal users" },
      400,
    );
  }

  const userId = admin ? (parsed.data.isAutonomous ? null : (parsed.data.userId ?? null)) : agent.userId;
  const isAutonomous = admin ? parsed.data.isAutonomous : false;

  if (!admin && !isAutonomous && !userId) {
    return c.json(
      { error: "validation_error", message: "User binding is required for Human Proxy agents" },
      400,
    );
  }

  if (!admin && userId && parsed.data.groupId) {
    const canSelectGroup = await userCanSelectAgentGroup(
      sql,
      agent.tenantId,
      userId,
      parsed.data.groupId,
    );

    if (!canSelectGroup) {
      return c.json(
        { error: "forbidden", message: "You do not have access to register agents in that group" },
        403,
      );
    }
  }

  let owner: { id: string; externalId: string; email: string | null; label: string } | null = null;
  if (userId) {
    const [user] = await sql`
      SELECT id, external_id, email
      FROM human_users
      WHERE id = ${userId} AND tenant_id = ${agent.tenantId}
    `;
    if (!user) {
      return c.json({ error: "not_found", message: "User not found" }, 404);
    }

    const label = (user.email as string | null) ?? (user.external_id as string);
    owner = {
      id: user.id as string,
      externalId: user.external_id as string,
      email: (user.email as string | null) ?? null,
      label,
    };
  }

  const provisionedAgent = await provisionAgentWithApiKey(sql, {
    externalId: parsed.data.externalId,
    tenantId: agent.tenantId,
    userId,
    isAutonomous,
  });
  const { agent: newAgent, rawApiKey } = provisionedAgent;

  if (parsed.data.groupId) {
    const membershipResult = await addMember(
      sql,
      agent.tenantId,
      parsed.data.groupId,
      newAgent.id,
    );

    if ("error" in membershipResult) {
      await sql`DELETE FROM agents WHERE id = ${newAgent.id}`;
      if (membershipResult.error === "not_found") {
        return c.json({ error: "not_found", message: membershipResult.message }, 404);
      }
      return c.json({ error: "conflict", message: membershipResult.message }, 409);
    }
  }

  return c.json(
    {
      agent: {
        id: newAgent.id,
        externalId: newAgent.externalId,
        tenantId: agent.tenantId,
        userId: newAgent.userId,
        isAutonomous: newAgent.isAutonomous,
        role: newAgent.role,
        revokedAt: null,
        displayName: newAgent.isAutonomous
          ? `${newAgent.externalId} (Autonomous)`
          : owner
            ? `${newAgent.externalId} · ${owner.label}`
            : newAgent.externalId,
        owner,
        createdAt: newAgent.createdAt,
      },
      apiKey: rawApiKey,
    },
    201,
  );
});

/**
 * POST /api/agents/:id/rule-sets — associate a rule set with an agent.
 */
agentsRouter.post("/:id/rule-sets", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const body = await c.req.json();
  const parsed = parseAgentRuleSetAssociationInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");

  const exists = await ensureAgentInTenant(sql, tenantId, targetAgentId);
  if (!exists) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  const result = await associateRuleSetWithAgent(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, targetAgentId, parsed.data.ruleSetId);

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Rule set not found" }, 404);
    }
    return c.json({ error: "conflict", message: "Rule set is already associated with this agent" }, 409);
  }

  await pushRulesToAgent(targetAgentId, sessionStore, sql, schemaName);
  return c.json({ success: true }, 201);
});

/**
 * DELETE /api/agents/:id/rule-sets/:ruleSetId — dissociate a rule set from an agent.
 */
agentsRouter.delete("/:id/rule-sets/:ruleSetId", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");
  const ruleSetId = c.req.param("ruleSetId");

  const exists = await ensureAgentInTenant(sql, tenantId, targetAgentId);
  if (!exists) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  const result = await dissociateRuleSetFromAgent(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, targetAgentId, ruleSetId);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Agent/rule-set association not found" }, 404);
  }

  await pushRulesToAgent(targetAgentId, sessionStore, sql, schemaName);
  return c.json({ success: true });
});

/**
 * GET /api/agents/:id/rules — get all active rules for an agent.
 */
agentsRouter.get("/:id/rules", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");

  // Allow if it's the agent themselves OR if they are a tenant admin
  if (agent.id !== targetAgentId) {
    const forbidden = await requireTenantAdmin(c);
    if (forbidden) return forbidden;
  }

  const exists = await ensureAgentInTenant(sql, tenantId, targetAgentId);
  if (!exists) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  const rules = await getActiveRulesForAgent(sql, schemaName, targetAgentId);
  return c.json({ rules });
});

/**
 * GET /api/agents — list all agents in the current tenant.
 */
agentsRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, agent);
  const admin = isTenantAdmin(role);

  if (!admin && !agent.userId) {
    return c.json([]);
  }

  const rows = admin
    ? await sql`
        SELECT
          a.id,
          a.external_id,
          a.tenant_id,
          a.user_id,
          a.role,
          a.is_autonomous,
          a.revoked_at,
          a.created_at,
          u.id AS owner_id,
          u.external_id AS owner_external_id,
          u.email AS owner_email
        FROM agents a
        LEFT JOIN human_users u ON u.id = a.user_id
        WHERE a.tenant_id = ${agent.tenantId}
          AND a.external_id NOT LIKE ${`${DASHBOARD_AGENT_PREFIX}%`}
        ORDER BY a.created_at DESC
      `
    : await sql`
        SELECT
          a.id,
          a.external_id,
          a.tenant_id,
          a.user_id,
          a.role,
          a.is_autonomous,
          a.revoked_at,
          a.created_at,
          u.id AS owner_id,
          u.external_id AS owner_external_id,
          u.email AS owner_email
        FROM agents a
        LEFT JOIN human_users u ON u.id = a.user_id
        WHERE a.tenant_id = ${agent.tenantId}
          AND a.user_id = ${agent.userId}
          AND a.external_id NOT LIKE ${`${DASHBOARD_AGENT_PREFIX}%`}
        ORDER BY a.created_at DESC
      `;

  return c.json((rows as unknown as AgentRow[]).map(mapAgent));
});

/**
 * GET /api/agents/me — return the current authenticated agent's info.
 */
agentsRouter.get("/me", async (c) => {
  const agent = c.get("agent");

  return c.json({
    id: agent.id,
    externalId: agent.externalId,
    tenantId: agent.tenantId,
    isAutonomous: agent.isAutonomous,
  });
});

/**
 * GET /api/agents/:id/status — get an agent's connection status.
 */
agentsRouter.get("/:id/status", async (c) => {
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const targetId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetId);

  if ("response" in access) {
    return access.response;
  }

  const activeSessions = sessionStore ? sessionStore.getByAgentId(targetId).length : 0;

  return c.json({
    activeSessions,
    revoked: Boolean(access.row.revoked_at),
  });
});

/**
 * GET /api/agents/:id — get an agent detail record.
 */
agentsRouter.get("/:id", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const targetId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetId);

  if ("response" in access) {
    return access.response;
  }

  const [groups, ruleSets] = await Promise.all([
    sql`
      SELECT
        g.id,
        g.name,
        g.description,
        g.memory_quota,
        g.created_at
      FROM agent_group_members gm
      JOIN agent_groups g ON g.id = gm.group_id
      WHERE gm.agent_id = ${targetId}
      ORDER BY g.name ASC, g.created_at ASC
    `,
    listRuleSetsForAgent(sql, schemaName, targetId),
  ]);

  return c.json({
    ...mapAgent(access.row),
    groups: (groups as Record<string, unknown>[]).map((group) => ({
      id: group.id as string,
      name: group.name as string,
      description: (group.description as string) ?? "",
      memoryQuota: (group.memory_quota as number | null) ?? null,
      createdAt: group.created_at as Date,
    })),
    ruleSets,
  });
});

import { Hono, type Context } from "hono";
import { RegisterAgentApiInput } from "@monet/types";
import { addMember, resolveAgentRole, isTenantAdmin } from "../services/group.service.js";
import {
  associateRuleSetWithAgent,
  dissociateRuleSetFromAgent,
  getActiveRulesForAgent,
} from "../services/rule.service.js";
import { pushRulesToAgent } from "../services/rule-notification.service.js";
import type { AppEnv } from "../middleware/context.js";
import { provisionAgentWithApiKey } from "../services/agent-provisioning.service.js";

export const agentsRouter = new Hono<AppEnv>();

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

  if (parsed.data.userId) {
    const [user] = await sql`
      SELECT id FROM human_users WHERE id = ${parsed.data.userId} AND tenant_id = ${agent.tenantId}
    `;
    if (!user) {
      return c.json({ error: "not_found", message: "User not found" }, 404);
    }
  }

  const provisionedAgent = await provisionAgentWithApiKey(sql, {
    externalId: parsed.data.externalId,
    tenantId: agent.tenantId,
    userId: parsed.data.userId ?? null,
    isAutonomous: parsed.data.isAutonomous,
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
        userId: newAgent.userId,
        isAutonomous: newAgent.isAutonomous,
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

  const rows = await sql`
    SELECT id, external_id as "externalId", tenant_id as "tenantId", user_id as "userId", is_autonomous as "isAutonomous", role, created_at as "createdAt"
    FROM agents
    WHERE tenant_id = ${agent.tenantId}
    ORDER BY created_at DESC
  `;

  return c.json(rows);
});

/**
 * GET /api/agents/:id/status — get an agent's connection status.
 */
agentsRouter.get("/:id/status", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const targetId = c.req.param("id");

  // Check if agent exists in this tenant
  const [target] = await sql`
    SELECT id, revoked_at FROM agents WHERE id = ${targetId} AND tenant_id = ${agent.tenantId}
  `;

  if (!target) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  const activeSessions = sessionStore ? sessionStore.getByAgentId(targetId).length : 0;

  return c.json({
    activeSessions,
    revoked: !!target.revoked_at,
  });
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

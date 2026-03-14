import { Hono, type Context } from "hono";
import {
  CreateRuleInput,
  UpdateRuleInput,
  CreateRuleSetInput,
} from "@monet/types";
import type { AppEnv } from "../middleware/context";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service";
import {
  addRuleToSet,
  createRule,
  createRuleSet,
  deleteRule,
  deleteRuleSet,
  getAgentIdsForRule,
  getAgentIdsForRuleSet,
  getRule,
  listPersonalRuleSetsForUser,
  listPersonalRulesForUser,
  listRuleSets,
  listRules,
  removeRuleFromSet,
  updateRule,
} from "../services/rule.service";
import { pushRulesToAgent } from "../services/rule-notification.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRuleSetMembershipInput(body: unknown): { data: { ruleId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.ruleId !== "string" || !UUID_RE.test(b.ruleId)) {
    return { error: "Valid ruleId (UUID) is required" };
  }
  return { data: { ruleId: b.ruleId } };
}

function ruleMutationActor(agent: AppEnv["Variables"]["agent"]) {
  if (agent.userId) {
    return { actorId: agent.userId, actorType: "user" as const };
  }

  return { actorId: agent.id, actorType: "agent" as const };
}

async function pushRulesToAgents(
  c: Context<AppEnv>,
  agentIds: string[],
) {
  const sessionStore = c.get("sessionStore");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  await Promise.all(agentIds.map((id) => pushRulesToAgent(id, sessionStore, sql, schemaName)));
}

export const rulesRouter = new Hono<AppEnv>();

async function requireTenantAdmin(c: Context<AppEnv>) {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  return null;
}

function requireUserBoundAgent(c: Context<AppEnv>) {
  const agent = c.get("agent");
  if (!agent.userId) {
    return { response: c.json({ error: "forbidden", message: "User-bound agent access required" }, 403) };
  }
  return { userId: agent.userId };
}

rulesRouter.post("/rules", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const body = await c.req.json();
  const parsed = CreateRuleInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");

  const rule = await createRule(sql, tenantId, schemaName, ruleMutationActor(agent), parsed.data);
  return c.json(rule, 201);
});

rulesRouter.get("/rules", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const rules = await listRules(sql, schemaName);
  return c.json({ rules });
});

rulesRouter.get("/rule-sets", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const ruleSets = await listRuleSets(sql, schemaName);
  return c.json({ ruleSets });
});

rulesRouter.get("/rules/:id", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const rule = await getRule(sql, schemaName, c.req.param("id"));

  if (!rule) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  return c.json(rule);
});

rulesRouter.patch("/rules/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const body = await c.req.json();
  const parsed = UpdateRuleInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "validation_error", message: "At least one field is required" }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);
  const result = await updateRule(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleId,
    parsed.data,
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json(result);
});

rulesRouter.delete("/rules/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);
  const result = await deleteRule(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleId,
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

rulesRouter.post("/rule-sets", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const body = await c.req.json();
  const parsed = CreateRuleSetInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");

  const ruleSet = await createRuleSet(sql, tenantId, schemaName, ruleMutationActor(agent), parsed.data);
  return c.json(ruleSet, 201);
});

rulesRouter.delete("/rule-sets/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  const result = await deleteRuleSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule set not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

rulesRouter.post("/rule-sets/:id/rules", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const body = await c.req.json();
  const parsed = parseRuleSetMembershipInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const result = await addRuleToSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
    parsed.data.ruleId,
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Rule or rule set not found" }, 404);
    }
    return c.json({ error: "conflict", message: "Rule is already in this rule set" }, 409);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true }, 201);
});

rulesRouter.delete("/rule-sets/:id/rules/:ruleId", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");
  const ruleId = c.req.param("ruleId");

  const result = await removeRuleFromSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
    ruleId,
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule is not in this rule set" }, 404);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

rulesRouter.get("/me/rules", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const rules = await listPersonalRulesForUser(sql, schemaName, access.userId);
  return c.json({ rules });
});

rulesRouter.post("/me/rules", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const body = await c.req.json();
  const parsed = CreateRuleInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");

  const rule = await createRule(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    parsed.data,
    { ownerUserId: access.userId },
  );

  return c.json(rule, 201);
});

rulesRouter.patch("/me/rules/:id", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const body = await c.req.json();
  const parsed = UpdateRuleInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "validation_error", message: "At least one field is required" }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);
  const result = await updateRule(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleId,
    parsed.data,
    { ownerUserId: access.userId },
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json(result);
});

rulesRouter.delete("/me/rules/:id", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);
  const result = await deleteRule(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleId,
    { ownerUserId: access.userId },
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

rulesRouter.get("/me/rule-sets", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const ruleSets = await listPersonalRuleSetsForUser(sql, schemaName, access.userId);
  return c.json({ ruleSets });
});

rulesRouter.post("/me/rule-sets", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const body = await c.req.json();
  const parsed = CreateRuleSetInput.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: "validation_error",
      message: "Invalid input",
      details: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");

  const ruleSet = await createRuleSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    parsed.data,
    { ownerUserId: access.userId },
  );

  return c.json(ruleSet, 201);
});

rulesRouter.delete("/me/rule-sets/:id", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  const result = await deleteRuleSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
    { ownerUserId: access.userId },
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule set not found" }, 404);
  }

  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

rulesRouter.post("/me/rule-sets/:id/rules", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const body = await c.req.json();
  const parsed = parseRuleSetMembershipInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const result = await addRuleToSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
    parsed.data.ruleId,
    { ownerUserId: access.userId },
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Rule or rule set not found" }, 404);
    }
    return c.json({ error: "conflict", message: "Rule is already in this rule set" }, 409);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true }, 201);
});

rulesRouter.delete("/me/rule-sets/:id/rules/:ruleId", async (c) => {
  const access = requireUserBoundAgent(c);
  if ("response" in access) return access.response;

  const sql = c.get("sql");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");
  const ruleId = c.req.param("ruleId");

  const result = await removeRuleFromSet(
    sql,
    tenantId,
    schemaName,
    ruleMutationActor(agent),
    ruleSetId,
    ruleId,
    { ownerUserId: access.userId },
  );

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule is not in this rule set" }, 404);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await pushRulesToAgents(c, affectedAgentIds);
  return c.json({ success: true });
});

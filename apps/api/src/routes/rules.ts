import { Hono, type Context } from "hono";
import {
  CreateRuleInput,
  UpdateRuleInput,
  CreateRuleSetInput,
} from "@monet/types";
import type { AppEnv } from "../middleware/context.js";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service.js";
import {
  addRuleToSet,
  createRule,
  createRuleSet,
  deleteRule,
  deleteRuleSet,
  getAgentIdsForRule,
  getAgentIdsForRuleSet,
  getRule,
  listRuleSets,
  listRules,
  removeRuleFromSet,
  updateRule,
} from "../services/rule.service.js";
import { pushRulesToAgent } from "../services/rule-notification.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRuleSetMembershipInput(body: unknown): { data: { ruleId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.ruleId !== "string" || !UUID_RE.test(b.ruleId)) {
    return { error: "Valid ruleId (UUID) is required" };
  }
  return { data: { ruleId: b.ruleId } };
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

  const rule = await createRule(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, parsed.data);

  return c.json(rule, 201);
});

rulesRouter.get("/rules", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const rules = await listRules(sql, schemaName);
  return c.json({ rules });
});

rulesRouter.get("/rule-sets", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const ruleSets = await listRuleSets(sql, schemaName);
  return c.json({ ruleSets });
});

rulesRouter.get("/rules/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

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
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);
  const result = await updateRule(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, ruleId, parsed.data);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await Promise.all(affectedAgentIds.map((id) =>
    pushRulesToAgent(id, sessionStore, sql, schemaName)
  ));

  return c.json(result);
});

rulesRouter.delete("/rules/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRule(sql, schemaName, ruleId);

  const result = await deleteRule(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, ruleId);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule not found" }, 404);
  }

  await Promise.all(affectedAgentIds.map((id) =>
    pushRulesToAgent(id, sessionStore, sql, schemaName)
  ));

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

  const ruleSet = await createRuleSet(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, parsed.data);

  return c.json(ruleSet, 201);
});

rulesRouter.delete("/rule-sets/:id", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  const result = await deleteRuleSet(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, ruleSetId);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule set not found" }, 404);
  }

  await Promise.all(affectedAgentIds.map((id) =>
    pushRulesToAgent(id, sessionStore, sql, schemaName)
  ));

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
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");

  const result = await addRuleToSet(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, ruleSetId, parsed.data.ruleId);

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Rule or rule set not found" }, 404);
    }
    return c.json({ error: "conflict", message: "Rule is already in this rule set" }, 409);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await Promise.all(affectedAgentIds.map((id) =>
    pushRulesToAgent(id, sessionStore, sql, schemaName)
  ));

  return c.json({ success: true }, 201);
});

rulesRouter.delete("/rule-sets/:id/rules/:ruleId", async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const agent = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const ruleSetId = c.req.param("id");
  const ruleId = c.req.param("ruleId");

  const result = await removeRuleFromSet(sql, tenantId, schemaName, {
    actorId: agent.id,
    actorType: "agent",
  }, ruleSetId, ruleId);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Rule is not in this rule set" }, 404);
  }

  const affectedAgentIds = await getAgentIdsForRuleSet(sql, schemaName, ruleSetId);
  await Promise.all(affectedAgentIds.map((id) =>
    pushRulesToAgent(id, sessionStore, sql, schemaName)
  ));

  return c.json({ success: true });
});

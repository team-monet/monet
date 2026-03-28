import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service";
import { getMonetGuidance, updateMonetGuidance } from "../services/settings.service";
import { logAuditEvent } from "../services/audit.service";

const MAX_GUIDANCE_LENGTH = 100_000;

export const settingsRouter = new Hono<AppEnv>();

/**
 * GET /api/settings/monet-guidance — retrieve current Monet guidance text.
 * Only accessible by tenant_admin.
 */
settingsRouter.get("/monet-guidance", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const tenantSchemaName = c.get("tenantSchemaName");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can view settings" },
      403,
    );
  }

  const guidance = await getMonetGuidance(sql, tenantSchemaName);
  return c.json({ monetGuidance: guidance });
});

/**
 * PUT /api/settings/monet-guidance — update Monet guidance text.
 * Only accessible by tenant_admin.
 */
settingsRouter.put("/monet-guidance", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const tenantSchemaName = c.get("tenantSchemaName");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can update settings" },
      403,
    );
  }

  const body = await c.req.json<{ monetGuidance?: string }>().catch(() => null);
  if (!body?.monetGuidance || typeof body.monetGuidance !== "string") {
    return c.json(
      { error: "bad_request", message: "monetGuidance is required and must be a string" },
      400,
    );
  }

  if (body.monetGuidance.length > MAX_GUIDANCE_LENGTH) {
    return c.json(
      { error: "bad_request", message: `monetGuidance exceeds maximum length of ${MAX_GUIDANCE_LENGTH}` },
      400,
    );
  }

  await updateMonetGuidance(sql, tenantSchemaName, body.monetGuidance);
  await logAuditEvent(sql, tenantSchemaName, {
    tenantId: agent.tenantId,
    actorId: agent.id,
    actorType: "agent",
    action: "settings.update_guidance",
    outcome: "success",
  });
  return c.json({ ok: true });
});

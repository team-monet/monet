import { Hono } from "hono";
import { queryAuditLogs } from "../services/audit-query.service.js";
import type { AppEnv } from "../middleware/context.js";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service.js";

export const auditRouter = new Hono<AppEnv>();

/**
 * GET /api/audit — query audit logs for the current tenant.
 * Only accessible by tenant_admin.
 */
auditRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can view audit logs" },
      403,
    );
  }

  const query = c.req.query();
  try {
    const result = await queryAuditLogs(sql!, agent.tenantId, {
      actorId: query.actorId,
      action: query.action,
      startDate: query.startDate,
      endDate: query.endDate,
      cursor: query.cursor,
      limit: query.limit ? parseInt(query.limit) : 100,
    });

    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "internal_error", message }, 500);
  }
});

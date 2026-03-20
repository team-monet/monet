import { Hono } from "hono";
import { queryAuditLogs } from "../services/audit-query.service";
import type { AppEnv } from "../middleware/context";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service";

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
      limit: (() => {
        const MAX_LIMIT = 100;
        return query.limit ? Math.min(Math.max(1, parseInt(query.limit) || 20), MAX_LIMIT) : 100;
      })(),
    });

    return c.json(result);
  } catch (err: unknown) {
    console.error("Failed to query audit logs", err);
    return c.json({ error: "internal_error", message: "An internal error occurred" }, 500);
  }
});

import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import { resolveAgentRole, isTenantAdmin } from "../services/group.service";
import {
  getUsageMetrics,
  getBenefitMetrics,
  getHealthMetrics,
} from "../services/metrics.service";

export const metricsRouter = new Hono<AppEnv>();

/**
 * GET /api/metrics — usage, benefit, and health metrics for the current tenant.
 * Only accessible by tenant_admin.
 */
metricsRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can view metrics" },
      403,
    );
  }

  if (!sql) {
    return c.json({ error: "internal_error", message: "Database connection unavailable" }, 500);
  }

  try {
    const [usage, benefit, health] = await Promise.all([
      getUsageMetrics(sql, agent.tenantId),
      getBenefitMetrics(sql, agent.tenantId),
      getHealthMetrics(sql, agent.tenantId),
    ]);

    return c.json({ usage, benefit, health });
  } catch (err: unknown) {
    console.error("Failed to fetch metrics:", err);
    return c.json({ error: "internal_error", message: "Failed to fetch metrics" }, 500);
  }
});

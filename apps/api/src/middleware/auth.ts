import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.js";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service.js";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const authHeader = c.req.header("Authorization");

  // Allow platform admin secret for dashboard/system requests
  const adminSecret = process.env.PLATFORM_ADMIN_SECRET;
  const tenantIdHeader = c.req.header("X-Tenant-Id");

  if (adminSecret && authHeader === `Bearer ${adminSecret}` && tenantIdHeader) {
    // Only allow platform secret for agent registration (bootstrap)
    const url = new URL(c.req.url);
    if (url.pathname === "/api/agents/register") {
      c.set("agent", {
        id: "00000000-0000-0000-0000-000000000000", // System dummy ID
        externalId: "system",
        tenantId: tenantIdHeader,
        isAutonomous: false,
        userId: null,
        role: "user", // Non-tenant-admin synthetic role
      });
      return await next();
    }
  }

  const auth = await authenticateAgentFromBearerToken(db, authHeader);
  if (!auth.ok) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  c.set("agent", auth.agent);

  await next();
});

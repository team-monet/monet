import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

/**
 * Derives the tenant schema name from the authenticated agent's tenantId.
 * Never uses request input — always derived from the agent context set by auth middleware.
 */
export function tenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

export const tenantMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const agent = c.get("agent");
  if (!agent) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const schemaName = tenantSchemaName(agent.tenantId);

  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    return c.json({ error: "internal", message: "Invalid tenant schema derivation" }, 500);
  }

  c.set("tenantId", agent.tenantId);
  c.set("tenantSchemaName", schemaName);

  await next();
});

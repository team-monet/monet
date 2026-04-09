import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const sql = c.get("sql") ?? (c.get("db") as { $client?: AppEnv["Variables"]["sql"] }).$client ?? (c.get("db") as unknown as AppEnv["Variables"]["sql"]);
  const authHeader = c.req.header("Authorization");
  const tenantId = c.get("tenantId");
  const tenantSchemaName = c.get("tenantSchemaName");
  const tenant = tenantId && tenantSchemaName
    ? { tenantId, tenantSchemaName }
    : undefined;

  const auth = await authenticateAgentFromBearerToken(sql, authHeader, tenant);
  if (!auth.ok) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  c.set("agent", auth.agent);

  await next();
});

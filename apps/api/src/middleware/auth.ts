import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const authHeader = c.req.header("Authorization");

  const auth = await authenticateAgentFromBearerToken(db, authHeader);
  if (!auth.ok) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  c.set("agent", auth.agent);

  await next();
});

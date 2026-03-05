import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context.js";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service.js";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const auth = await authenticateAgentFromBearerToken(
    db,
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  c.set("agent", auth.agent);

  await next();
});

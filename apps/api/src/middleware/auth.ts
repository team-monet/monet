import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { agents } from "@monet/db/schema";
import { parseApiKey, validateApiKey } from "../services/api-key.service.js";
import type { AppEnv } from "./context.js";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "unauthorized", message: "Missing Authorization header" }, 401);
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return c.json({ error: "unauthorized", message: "Invalid Authorization header format" }, 401);
  }

  const rawKey = parts[1];
  const parsed = parseApiKey(rawKey);
  if (!parsed) {
    return c.json({ error: "unauthorized", message: "Invalid API key format" }, 401);
  }

  const db = c.get("db");
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.externalId, parsed.agentId))
    .limit(1);

  if (agentRows.length === 0) {
    return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
  }

  const agent = agentRows[0];

  const isValid = validateApiKey(rawKey, agent.apiKeyHash, agent.apiKeySalt);
  if (!isValid) {
    return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
  }

  c.set("agent", {
    id: agent.id,
    externalId: agent.externalId,
    tenantId: agent.tenantId,
    isAutonomous: agent.isAutonomous,
  });

  await next();
});

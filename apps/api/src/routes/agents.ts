import { Hono } from "hono";
import { RegisterAgentApiInput } from "@monet/types";
import {
  generateApiKey,
  hashApiKey,
} from "../services/api-key.service.js";
import { addMember } from "../services/group.service.js";
import type { AppEnv } from "../middleware/context.js";

export const agentsRouter = new Hono<AppEnv>();

/**
 * POST /api/agents/register — register a new agent in the current tenant.
 * Requires authentication (the calling agent must already belong to the tenant).
 */
agentsRouter.post("/register", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const body = await c.req.json();
  const parsed = RegisterAgentApiInput.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        message: "Invalid input",
        details: parsed.error.flatten().fieldErrors,
      },
      400,
    );
  }

  const rawApiKey = generateApiKey(parsed.data.externalId);
  const { hash, salt } = hashApiKey(rawApiKey);

  if (parsed.data.userId) {
    const [user] = await sql`
      SELECT id FROM human_users WHERE id = ${parsed.data.userId} AND tenant_id = ${agent.tenantId}
    `;
    if (!user) {
      return c.json({ error: "not_found", message: "User not found" }, 404);
    }
  }

  const [newAgent] = await sql`
    INSERT INTO agents (external_id, tenant_id, user_id, api_key_hash, api_key_salt, is_autonomous)
    VALUES (${parsed.data.externalId}, ${agent.tenantId}, ${parsed.data.userId ?? null}, ${hash}, ${salt}, ${parsed.data.isAutonomous})
    RETURNING id, external_id, user_id, is_autonomous, created_at
  `;

  if (parsed.data.groupId) {
    const membershipResult = await addMember(
      sql,
      agent.tenantId,
      parsed.data.groupId,
      newAgent.id as string,
    );

    if ("error" in membershipResult) {
      await sql`DELETE FROM agents WHERE id = ${newAgent.id}`;
      if (membershipResult.error === "not_found") {
        return c.json({ error: "not_found", message: membershipResult.message }, 404);
      }
      return c.json({ error: "conflict", message: membershipResult.message }, 409);
    }
  }

  return c.json(
    {
      agent: {
        id: newAgent.id,
        externalId: newAgent.external_id,
        userId: newAgent.user_id,
        isAutonomous: newAgent.is_autonomous,
        createdAt: newAgent.created_at,
      },
      apiKey: rawApiKey,
    },
    201,
  );
});

/**
 * GET /api/agents/me — return the current authenticated agent's info.
 */
agentsRouter.get("/me", async (c) => {
  const agent = c.get("agent");

  return c.json({
    id: agent.id,
    externalId: agent.externalId,
    tenantId: agent.tenantId,
    isAutonomous: agent.isAutonomous,
  });
});

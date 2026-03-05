import { eq } from "drizzle-orm";
import type { Database } from "@monet/db";
import { agents } from "@monet/db/schema";
import type { AgentContext } from "../middleware/context.js";
import { parseApiKey, validateApiKey } from "./api-key.service.js";

export type AuthenticationResult =
  | { ok: true; agent: AgentContext; rawKey: string }
  | { ok: false; status: 401; error: string; message: string };

export function extractBearerToken(
  authHeader: string | undefined,
): { ok: true; token: string } | { ok: false; status: 401; error: string; message: string } {
  if (!authHeader) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Missing Authorization header",
    };
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid Authorization header format",
    };
  }

  return { ok: true, token: parts[1] };
}

export async function authenticateAgentFromBearerToken(
  db: Database,
  authHeader: string | undefined,
): Promise<AuthenticationResult> {
  const token = extractBearerToken(authHeader);
  if (!token.ok) {
    return token;
  }

  const parsed = parseApiKey(token.token);
  if (!parsed) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key format",
    };
  }

  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.externalId, parsed.agentId))
    .limit(1);

  if (agentRows.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    };
  }

  const agent = agentRows[0];

  if (agent.revokedAt) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "API key has been revoked",
    };
  }

  const isValid = validateApiKey(token.token, agent.apiKeyHash, agent.apiKeySalt);
  if (!isValid) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    };
  }

  return {
    ok: true,
    rawKey: token.token,
    agent: {
      id: agent.id,
      externalId: agent.externalId,
      tenantId: agent.tenantId,
      isAutonomous: agent.isAutonomous,
      userId: agent.userId ?? null,
      role: agent.role ?? null,
    },
  };
}

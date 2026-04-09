import { eq } from "drizzle-orm";
import type { SqlClient } from "@monet/db";
import { agents, withTenantDrizzleScope } from "@monet/db";
import type { AgentContext } from "../middleware/context";
import { parseApiKey, validateApiKey } from "./api-key.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  sql: SqlClient,
  authHeader: string | undefined,
  tenant?: { tenantId: string; tenantSchemaName: string },
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

  if (!UUID_RE.test(parsed.agentId)) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    };
  }

  if (!tenant) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Tenant context is required",
    };
  }

  const agentRows = await withTenantDrizzleScope(
    sql,
    tenant.tenantSchemaName,
    async (tenantDb) =>
      tenantDb
        .select()
        .from(agents)
        .where(eq(agents.id, parsed.agentId))
        .limit(1),
  );

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
      tenantId: tenant?.tenantId ?? agent.tenantId,
      isAutonomous: agent.isAutonomous,
      userId: agent.userId ?? null,
      role: agent.role ?? null,
    },
  };
}

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { generateApiKey, hashApiKey } from "./api-key.service.js";

type ProvisionAgentInput = {
  externalId: string;
  tenantId: string;
  userId?: string | null;
  role?: "user" | "group_admin" | "tenant_admin" | null;
  isAutonomous?: boolean;
};

export type ProvisionAgentResult = {
  agent: {
    id: string;
    externalId: string;
    userId: string | null;
    isAutonomous: boolean;
    role: "user" | "group_admin" | "tenant_admin" | null;
    createdAt: Date;
  };
  rawApiKey: string;
};

export async function provisionAgentWithApiKey(
  sql: postgres.Sql,
  input: ProvisionAgentInput,
): Promise<ProvisionAgentResult> {
  const agentId = randomUUID();
  const rawApiKey = generateApiKey(agentId);
  const { hash, salt } = hashApiKey(rawApiKey);

  const [agent] = await sql`
    INSERT INTO agents (
      id,
      external_id,
      tenant_id,
      user_id,
      role,
      api_key_hash,
      api_key_salt,
      is_autonomous
    )
    VALUES (
      ${agentId},
      ${input.externalId},
      ${input.tenantId},
      ${input.userId ?? null},
      ${input.role ?? null},
      ${hash},
      ${salt},
      ${input.isAutonomous ?? false}
    )
    RETURNING id, external_id, user_id, role, is_autonomous, created_at
  `;

  return {
    agent: {
      id: agentId,
      externalId: input.externalId,
      userId: input.userId ?? null,
      role: input.role ?? null,
      isAutonomous: input.isAutonomous ?? false,
      createdAt: agent.created_at as Date,
    },
    rawApiKey,
  };
}

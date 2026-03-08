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
  const rawApiKey = generateApiKey(input.externalId);
  const { hash, salt } = hashApiKey(rawApiKey);

  const [agent] = await sql`
    INSERT INTO agents (
      external_id,
      tenant_id,
      user_id,
      role,
      api_key_hash,
      api_key_salt,
      is_autonomous
    )
    VALUES (
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
      id: agent.id as string,
      externalId: agent.external_id as string,
      userId: (agent.user_id as string | null) ?? null,
      role: (agent.role as ProvisionAgentResult["agent"]["role"]) ?? null,
      isAutonomous: agent.is_autonomous as boolean,
      createdAt: agent.created_at as Date,
    },
    rawApiKey,
  };
}

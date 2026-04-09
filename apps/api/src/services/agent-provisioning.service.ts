import { randomUUID } from "node:crypto";
import {
  agents,
  tenantSchemaNameFromId,
  type SqlClient,
  type TransactionClient,
  withTenantDrizzleScope,
} from "@monet/db";
import { generateApiKey, hashApiKey } from "./api-key.service";

type AgentSqlClient = SqlClient | TransactionClient;

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
  sql: AgentSqlClient,
  input: ProvisionAgentInput,
): Promise<ProvisionAgentResult> {
  const agentId = randomUUID();
  const rawApiKey = generateApiKey(agentId);
  const { hash, salt } = hashApiKey(rawApiKey);
  const schemaName = tenantSchemaNameFromId(input.tenantId);

  const [agent] = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .insert(agents)
    .values({
      id: agentId,
      externalId: input.externalId,
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      role: input.role ?? null,
      apiKeyHash: hash,
      apiKeySalt: salt,
      isAutonomous: input.isAutonomous ?? false,
    })
    .returning({
      createdAt: agents.createdAt,
    }));

  return {
    agent: {
      id: agentId,
      externalId: input.externalId,
      userId: input.userId ?? null,
      role: input.role ?? null,
      isAutonomous: input.isAutonomous ?? false,
      createdAt: agent.createdAt,
    },
    rawApiKey,
  };
}

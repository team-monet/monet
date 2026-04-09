import {
  agentGroupMembers,
  agentGroups,
  agents,
  tenantUsers,
  tenantSchemaNameFromId,
  type SqlClient,
  withTenantDrizzleScope,
} from "@monet/db";
import { and, asc, desc, eq, notLike, sql as drizzleSql } from "drizzle-orm";

const DASHBOARD_AGENT_PREFIX = "dashboard:";

export type PlatformAgentRecord = {
  id: string;
  externalId: string;
  tenantId: string;
  userId: string | null;
  role: "user" | "group_admin" | "tenant_admin" | null;
  isAutonomous: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  ownerId: string | null;
  ownerExternalId: string | null;
  ownerDisplayName: string | null;
  ownerEmail: string | null;
};

export type PlatformAgentOwner = {
  id: string;
  externalId: string;
  displayName: string | null;
  email: string | null;
};

export type PlatformAgentGroup = {
  id: string;
  name: string;
  description: string | null;
  memoryQuota: number | null;
  createdAt: Date;
};

type ListPlatformAgentsOptions =
  | {
      isAdmin: true;
    }
  | {
      isAdmin: false;
      requesterUserId: string;
    };

function agentRecordSelection() {
  return {
    id: agents.id,
    externalId: agents.externalId,
    tenantId: agents.tenantId,
    userId: agents.userId,
    role: agents.role,
    isAutonomous: agents.isAutonomous,
    revokedAt: agents.revokedAt,
    createdAt: agents.createdAt,
    ownerId: tenantUsers.id,
    ownerExternalId: tenantUsers.externalId,
    ownerDisplayName: tenantUsers.displayName,
    ownerEmail: tenantUsers.email,
  };
}

export async function loadPlatformAgentRecord(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
): Promise<PlatformAgentRecord | null> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const rows = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .select(agentRecordSelection())
    .from(agents)
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(
      and(
        eq(agents.id, agentId),
        notLike(agents.externalId, `${DASHBOARD_AGENT_PREFIX}%`),
      ),
    )
    .limit(1));

  return rows[0] ?? null;
}

export async function loadPlatformUserOwner(
  sql: SqlClient,
  tenantId: string,
  userId: string,
): Promise<PlatformAgentOwner | null> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const rows = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .select({
      id: tenantUsers.id,
      externalId: tenantUsers.externalId,
      displayName: tenantUsers.displayName,
      email: tenantUsers.email,
    })
    .from(tenantUsers)
    .where(eq(tenantUsers.id, userId))
    .limit(1));

  return rows[0] ?? null;
}

export async function deletePlatformAgent(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
): Promise<void> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  await withTenantDrizzleScope(sql, schemaName, async (db) => {
    await db.delete(agents).where(eq(agents.id, agentId));
  });
}

export async function rotatePlatformAgentToken(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
  hash: string,
  salt: string,
): Promise<void> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  await withTenantDrizzleScope(sql, schemaName, async (db) => {
    await db
      .update(agents)
      .set({
        apiKeyHash: hash,
        apiKeySalt: salt,
      })
      .where(eq(agents.id, agentId));
  });
}

export async function revokePlatformAgent(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
): Promise<Date | null> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const [updated] = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .update(agents)
    .set({
      revokedAt: drizzleSql`COALESCE(${agents.revokedAt}, now())`,
    })
    .where(eq(agents.id, agentId))
    .returning({
      revokedAt: agents.revokedAt,
    }));

  return updated?.revokedAt ?? null;
}

export async function unrevokePlatformAgent(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
): Promise<void> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  await withTenantDrizzleScope(sql, schemaName, async (db) => {
    await db
      .update(agents)
      .set({ revokedAt: null })
      .where(eq(agents.id, agentId));
  });
}

export async function listPlatformAgents(
  sql: SqlClient,
  tenantId: string,
  options: ListPlatformAgentsOptions,
): Promise<PlatformAgentRecord[]> {
  if (!options.isAdmin && !options.requesterUserId) {
    throw new TypeError("requesterUserId is required when listing platform agents as a non-admin");
  }

  const baseWhere = [
    notLike(agents.externalId, `${DASHBOARD_AGENT_PREFIX}%`),
  ];

  const whereClause = options.isAdmin
    ? and(...baseWhere)
    : and(...baseWhere, eq(agents.userId, options.requesterUserId));

  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => db
    .select(agentRecordSelection())
    .from(agents)
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(whereClause)
    .orderBy(desc(agents.createdAt)));
}

export async function listPlatformAgentGroups(
  sql: SqlClient,
  tenantId: string,
  agentId: string,
): Promise<PlatformAgentGroup[]> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => db
    .select({
      id: agentGroups.id,
      name: agentGroups.name,
      description: agentGroups.description,
      memoryQuota: agentGroups.memoryQuota,
      createdAt: agentGroups.createdAt,
    })
    .from(agentGroupMembers)
    .innerJoin(agentGroups, eq(agentGroups.id, agentGroupMembers.groupId))
    .where(eq(agentGroupMembers.agentId, agentId))
    .orderBy(asc(agentGroups.name), asc(agentGroups.createdAt)));
}

import type { Database } from "@monet/db";
import {
  agentGroupMembers,
  agentGroups,
  agents,
  tenantUsers,
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
  db: Database,
  tenantId: string,
  agentId: string,
): Promise<PlatformAgentRecord | null> {
  const rows = await db
    .select(agentRecordSelection())
    .from(agents)
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.tenantId, tenantId),
        notLike(agents.externalId, `${DASHBOARD_AGENT_PREFIX}%`),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function loadPlatformUserOwner(
  db: Database,
  tenantId: string,
  userId: string,
): Promise<PlatformAgentOwner | null> {
  const rows = await db
    .select({
      id: tenantUsers.id,
      externalId: tenantUsers.externalId,
      displayName: tenantUsers.displayName,
      email: tenantUsers.email,
    })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.id, userId), eq(tenantUsers.tenantId, tenantId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function deletePlatformAgent(
  db: Database,
  tenantId: string,
  agentId: string,
): Promise<void> {
  await db.delete(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
}

export async function rotatePlatformAgentToken(
  db: Database,
  tenantId: string,
  agentId: string,
  hash: string,
  salt: string,
): Promise<void> {
  await db
    .update(agents)
    .set({
      apiKeyHash: hash,
      apiKeySalt: salt,
    })
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
}

export async function revokePlatformAgent(
  db: Database,
  tenantId: string,
  agentId: string,
): Promise<Date | null> {
  const [updated] = await db
    .update(agents)
    .set({
      revokedAt: drizzleSql`COALESCE(${agents.revokedAt}, now())`,
    })
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
    .returning({
      revokedAt: agents.revokedAt,
    });

  return updated?.revokedAt ?? null;
}

export async function unrevokePlatformAgent(
  db: Database,
  tenantId: string,
  agentId: string,
): Promise<void> {
  await db
    .update(agents)
    .set({ revokedAt: null })
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
}

export async function listPlatformAgents(
  db: Database,
  tenantId: string,
  options: ListPlatformAgentsOptions,
): Promise<PlatformAgentRecord[]> {
  if (!options.isAdmin && !options.requesterUserId) {
    throw new TypeError("requesterUserId is required when listing platform agents as a non-admin");
  }

  const baseWhere = [
    eq(agents.tenantId, tenantId),
    notLike(agents.externalId, `${DASHBOARD_AGENT_PREFIX}%`),
  ];

  const whereClause = options.isAdmin
    ? and(...baseWhere)
    : and(...baseWhere, eq(agents.userId, options.requesterUserId));

  return db
    .select(agentRecordSelection())
    .from(agents)
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(whereClause)
    .orderBy(desc(agents.createdAt));
}

export async function listPlatformAgentGroups(
  db: Database,
  agentId: string,
): Promise<PlatformAgentGroup[]> {
  return db
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
    .orderBy(asc(agentGroups.name), asc(agentGroups.createdAt));
}

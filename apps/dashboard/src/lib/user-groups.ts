import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
} from "@monet/types";
import {
  agentGroups,
  tenantSchemaNameFromId,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  tenantUsers,
  withTenantDrizzleScope,
  type Database,
  type TransactionClient,
} from "@monet/db";
import { getSqlClient } from "./db";

async function withTenantDb<T>(
  tenantId: string,
  fn: (db: Database, sql: TransactionClient) => Promise<T>,
): Promise<T> {
  return withTenantDrizzleScope(getSqlClient(), tenantSchemaNameFromId(tenantId), fn);
}

export type UserGroupSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  memberCount: number;
  allowedAgentGroupCount: number;
};

export async function listUserGroupsForTenant(
  tenantId: string,
): Promise<UserGroupSummary[]> {
  const groups = await withTenantDb(tenantId, async (db) => db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
    })
    .from(userGroups)
    .where(eq(userGroups.tenantId, tenantId))
    .orderBy(asc(userGroups.name)));

  if (groups.length === 0) {
    return [];
  }

  const groupIds = groups.map((group) => group.id);
  const [memberCounts, permissionCounts] = await withTenantDb(tenantId, async (db) => Promise.all([
    db
      .select({
        userGroupId: userGroupMembers.userGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(userGroupMembers)
      .where(inArray(userGroupMembers.userGroupId, groupIds))
      .groupBy(userGroupMembers.userGroupId),
    db
      .select({
        userGroupId: userGroupAgentGroupPermissions.userGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(userGroupAgentGroupPermissions)
      .where(inArray(userGroupAgentGroupPermissions.userGroupId, groupIds))
      .groupBy(userGroupAgentGroupPermissions.userGroupId),
  ]));

  const memberCountMap = new Map(
    memberCounts.map((row) => [row.userGroupId, Number(row.count)]),
  );
  const permissionCountMap = new Map(
    permissionCounts.map((row) => [row.userGroupId, Number(row.count)]),
  );

  return groups.map((group) => ({
    ...group,
    memberCount: memberCountMap.get(group.id) ?? 0,
    allowedAgentGroupCount: permissionCountMap.get(group.id) ?? 0,
  }));
}

export async function getUserGroupDetail(tenantId: string, userGroupId: string) {
  return withTenantDb(tenantId, async (db) => {
    const [group] = await db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
    })
    .from(userGroups)
    .where(
      and(eq(userGroups.id, userGroupId), eq(userGroups.tenantId, tenantId)),
    )
    .limit(1);

    if (!group) {
      return null;
    }

  const userSortOrder = sql`coalesce(${tenantUsers.displayName}, ${tenantUsers.email}, ${tenantUsers.externalId})`;

    const [members, tenantUserRows, tenantAgentGroups, permissionRows] = await Promise.all([
      db
      .select({
        id: tenantUsers.id,
        externalId: tenantUsers.externalId,
        displayName: tenantUsers.displayName,
        email: tenantUsers.email,
        role: tenantUsers.role,
        joinedAt: userGroupMembers.joinedAt,
      })
      .from(userGroupMembers)
      .innerJoin(tenantUsers, eq(tenantUsers.id, userGroupMembers.userId))
      .where(eq(userGroupMembers.userGroupId, userGroupId))
      .orderBy(userSortOrder, asc(tenantUsers.externalId)),
    db
      .select({
        id: tenantUsers.id,
        externalId: tenantUsers.externalId,
        displayName: tenantUsers.displayName,
        email: tenantUsers.email,
        role: tenantUsers.role,
      })
      .from(tenantUsers)
      .where(eq(tenantUsers.tenantId, tenantId))
      .orderBy(userSortOrder, asc(tenantUsers.externalId)),
    db
      .select({
        id: agentGroups.id,
        name: agentGroups.name,
        description: agentGroups.description,
      })
      .from(agentGroups)
      .where(eq(agentGroups.tenantId, tenantId))
      .orderBy(asc(agentGroups.name)),
    db
      .select({
        agentGroupId: userGroupAgentGroupPermissions.agentGroupId,
      })
      .from(userGroupAgentGroupPermissions)
      .where(eq(userGroupAgentGroupPermissions.userGroupId, userGroupId)),
  ]);

    return {
      group,
      members,
      tenantUsers: tenantUserRows,
      tenantAgentGroups,
      allowedAgentGroupIds: new Set(
        permissionRows.map((row) => row.agentGroupId),
      ),
    };
  });
}

export async function ensureDefaultUserGroupMembership(
  tenantId: string,
  userId: string,
) {
  const existingMemberships = await withTenantDb(tenantId, async (db) => db
    .select({ userGroupId: userGroupMembers.userGroupId })
    .from(userGroupMembers)
    .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.userGroupId))
    .where(
      and(
        eq(userGroupMembers.userId, userId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .limit(1));

  if (existingMemberships.length > 0) {
    return;
  }

  await withTenantDb(tenantId, async (db) => db.transaction(async (tx) => {
    let [defaultGroup] = await tx
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(
        and(
          eq(userGroups.tenantId, tenantId),
          eq(userGroups.name, DEFAULT_USER_GROUP_NAME),
        ),
      )
      .limit(1);

    if (!defaultGroup) {
      [defaultGroup] = await tx
        .insert(userGroups)
        .values({
          tenantId,
          name: DEFAULT_USER_GROUP_NAME,
          description: DEFAULT_USER_GROUP_DESCRIPTION,
        })
        .onConflictDoNothing()
        .returning({ id: userGroups.id });

      if (!defaultGroup) {
        [defaultGroup] = await tx
          .select({ id: userGroups.id })
          .from(userGroups)
          .where(
            and(
              eq(userGroups.tenantId, tenantId),
              eq(userGroups.name, DEFAULT_USER_GROUP_NAME),
            ),
          )
          .limit(1);
      }
    }

    if (!defaultGroup) {
      throw new Error("Failed to resolve default user group");
    }

    const [existingAgentGroup] = await tx
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(eq(agentGroups.tenantId, tenantId))
      .limit(1);

    if (!existingAgentGroup) {
      const [defaultAgentGroup] = await tx
        .insert(agentGroups)
        .values({
          tenantId,
          name: DEFAULT_AGENT_GROUP_NAME,
          description: DEFAULT_AGENT_GROUP_DESCRIPTION,
        })
        .returning({ id: agentGroups.id });

      await tx
        .insert(userGroupAgentGroupPermissions)
        .values({
          userGroupId: defaultGroup.id,
          agentGroupId: defaultAgentGroup.id,
        })
        .onConflictDoNothing();
    }

    await tx
      .insert(userGroupMembers)
      .values({
        userGroupId: defaultGroup.id,
        userId,
      })
      .onConflictDoNothing();
  }));
}

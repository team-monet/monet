import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
} from "@monet/types";
import {
  agentGroups,
  humanGroupAgentGroupPermissions,
  humanGroupMembers,
  humanGroups,
  humanUsers,
} from "@monet/db";
import { db } from "./db";

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
  const groups = await db
    .select({
      id: humanGroups.id,
      name: humanGroups.name,
      description: humanGroups.description,
      createdAt: humanGroups.createdAt,
    })
    .from(humanGroups)
    .where(eq(humanGroups.tenantId, tenantId))
    .orderBy(asc(humanGroups.name));

  if (groups.length === 0) {
    return [];
  }

  const groupIds = groups.map((group) => group.id);
  const [memberCounts, permissionCounts] = await Promise.all([
    db
      .select({
        humanGroupId: humanGroupMembers.humanGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(humanGroupMembers)
      .where(inArray(humanGroupMembers.humanGroupId, groupIds))
      .groupBy(humanGroupMembers.humanGroupId),
    db
      .select({
        humanGroupId: humanGroupAgentGroupPermissions.humanGroupId,
        count: sql<number>`count(*)::int`,
      })
      .from(humanGroupAgentGroupPermissions)
      .where(inArray(humanGroupAgentGroupPermissions.humanGroupId, groupIds))
      .groupBy(humanGroupAgentGroupPermissions.humanGroupId),
  ]);

  const memberCountMap = new Map(
    memberCounts.map((row) => [row.humanGroupId, Number(row.count)]),
  );
  const permissionCountMap = new Map(
    permissionCounts.map((row) => [row.humanGroupId, Number(row.count)]),
  );

  return groups.map((group) => ({
    ...group,
    memberCount: memberCountMap.get(group.id) ?? 0,
    allowedAgentGroupCount: permissionCountMap.get(group.id) ?? 0,
  }));
}

export async function getUserGroupDetail(tenantId: string, userGroupId: string) {
  const [group] = await db
    .select({
      id: humanGroups.id,
      name: humanGroups.name,
      description: humanGroups.description,
      createdAt: humanGroups.createdAt,
    })
    .from(humanGroups)
    .where(
      and(eq(humanGroups.id, userGroupId), eq(humanGroups.tenantId, tenantId)),
    )
    .limit(1);

  if (!group) {
    return null;
  }

  const [members, tenantUsers, tenantAgentGroups, permissionRows] = await Promise.all([
    db
      .select({
        id: humanUsers.id,
        externalId: humanUsers.externalId,
        email: humanUsers.email,
        role: humanUsers.role,
        joinedAt: humanGroupMembers.joinedAt,
      })
      .from(humanGroupMembers)
      .innerJoin(humanUsers, eq(humanUsers.id, humanGroupMembers.userId))
      .where(eq(humanGroupMembers.humanGroupId, userGroupId))
      .orderBy(asc(humanUsers.email), asc(humanUsers.externalId)),
    db
      .select({
        id: humanUsers.id,
        externalId: humanUsers.externalId,
        email: humanUsers.email,
        role: humanUsers.role,
      })
      .from(humanUsers)
      .where(eq(humanUsers.tenantId, tenantId))
      .orderBy(asc(humanUsers.email), asc(humanUsers.externalId)),
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
        agentGroupId: humanGroupAgentGroupPermissions.agentGroupId,
      })
      .from(humanGroupAgentGroupPermissions)
      .where(eq(humanGroupAgentGroupPermissions.humanGroupId, userGroupId)),
  ]);

  return {
    group,
    members,
    tenantUsers,
    tenantAgentGroups,
    allowedAgentGroupIds: new Set(
      permissionRows.map((row) => row.agentGroupId),
    ),
  };
}

export async function ensureDefaultUserGroupMembership(
  tenantId: string,
  userId: string,
) {
  const existingMemberships = await db
    .select({ humanGroupId: humanGroupMembers.humanGroupId })
    .from(humanGroupMembers)
    .innerJoin(humanGroups, eq(humanGroups.id, humanGroupMembers.humanGroupId))
    .where(
      and(
        eq(humanGroupMembers.userId, userId),
        eq(humanGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (existingMemberships.length > 0) {
    return;
  }

  await db.transaction(async (tx) => {
    let [defaultGroup] = await tx
      .select({ id: humanGroups.id })
      .from(humanGroups)
      .where(
        and(
          eq(humanGroups.tenantId, tenantId),
          eq(humanGroups.name, DEFAULT_USER_GROUP_NAME),
        ),
      )
      .limit(1);

    if (!defaultGroup) {
      [defaultGroup] = await tx
        .insert(humanGroups)
        .values({
          tenantId,
          name: DEFAULT_USER_GROUP_NAME,
          description: DEFAULT_USER_GROUP_DESCRIPTION,
        })
        .onConflictDoNothing()
        .returning({ id: humanGroups.id });

      if (!defaultGroup) {
        [defaultGroup] = await tx
          .select({ id: humanGroups.id })
          .from(humanGroups)
          .where(
            and(
              eq(humanGroups.tenantId, tenantId),
              eq(humanGroups.name, DEFAULT_USER_GROUP_NAME),
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
        .insert(humanGroupAgentGroupPermissions)
        .values({
          humanGroupId: defaultGroup.id,
          agentGroupId: defaultAgentGroup.id,
        })
        .onConflictDoNothing();
    }

    await tx
      .insert(humanGroupMembers)
      .values({
        humanGroupId: defaultGroup.id,
        userId,
      })
      .onConflictDoNothing();
  });
}

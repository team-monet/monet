import {
  agentGroups,
  asDrizzleSqlClient,
  tenantUsers,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  type SqlClient,
  type TransactionClient,
} from "@monet/db";
import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

type UserGroupRecord = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
};

export type UserGroupSummary = UserGroupRecord & {
  memberCount: number;
  allowedAgentGroupCount: number;
};

export type UserGroupDetail = {
  group: UserGroupRecord;
  members: Array<{
    id: string;
    externalId: string;
    displayName: string | null;
    email: string | null;
    role: "user" | "group_admin" | "tenant_admin";
    joinedAt: Date;
  }>;
  tenantUsers: Array<{
    id: string;
    externalId: string;
    displayName: string | null;
    email: string | null;
    role: "user" | "group_admin" | "tenant_admin";
  }>;
  tenantAgentGroups: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  allowedAgentGroupIds: string[];
};

type UserGroupSqlClient = SqlClient | TransactionClient;
type UserGroupDrizzleOptions = NonNullable<SqlClient["options"]>;

function createUserGroupDb(
  sql: UserGroupSqlClient,
  options?: UserGroupDrizzleOptions,
) {
  return drizzle(asDrizzleSqlClient(sql, options));
}

function mapUserGroupRecord(group: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}): UserGroupRecord {
  return {
    id: group.id,
    name: group.name,
    description: group.description ?? "",
    createdAt: group.createdAt,
  };
}

function userSortExpression() {
  return drizzleSql`COALESCE(${tenantUsers.displayName}, ${tenantUsers.email}, ${tenantUsers.externalId}) ASC NULLS LAST`;
}

export async function listAllowedAgentGroupIdsForUser(
  sql: SqlClient,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  const db = createUserGroupDb(sql);
  const rows = await db
    .selectDistinct({
      id: agentGroups.id,
    })
    .from(userGroupMembers)
    .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.userGroupId))
    .innerJoin(
      userGroupAgentGroupPermissions,
      eq(userGroupAgentGroupPermissions.userGroupId, userGroupMembers.userGroupId),
    )
    .innerJoin(
      agentGroups,
      eq(agentGroups.id, userGroupAgentGroupPermissions.agentGroupId),
    )
    .where(
      and(
        eq(userGroupMembers.userId, userId),
        eq(userGroups.tenantId, tenantId),
        eq(agentGroups.tenantId, tenantId),
      ),
    );

  return rows.map((row) => row.id);
}

export async function userCanSelectAgentGroup(
  sql: SqlClient,
  tenantId: string,
  userId: string,
  groupId: string,
): Promise<boolean> {
  const db = createUserGroupDb(sql);
  const [group] = await db
    .select({ id: agentGroups.id })
    .from(agentGroups)
    .where(
      and(
        eq(agentGroups.id, groupId),
        eq(agentGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!group) {
    return false;
  }

  const allowedGroupIds = await listAllowedAgentGroupIdsForUser(
    sql,
    tenantId,
    userId,
  );

  return allowedGroupIds.includes(groupId);
}

export async function listUserGroups(
  sql: SqlClient,
  tenantId: string,
): Promise<UserGroupSummary[]> {
  const db = createUserGroupDb(sql);

  const [groups, memberCounts, permissionCounts] = await Promise.all([
    db
      .select()
      .from(userGroups)
      .where(eq(userGroups.tenantId, tenantId))
      .orderBy(asc(userGroups.name)),
    db
      .select({
        userGroupId: userGroupMembers.userGroupId,
        count: drizzleSql<number>`COUNT(*)::int`,
      })
      .from(userGroupMembers)
      .groupBy(userGroupMembers.userGroupId),
    db
      .select({
        userGroupId: userGroupAgentGroupPermissions.userGroupId,
        count: drizzleSql<number>`COUNT(*)::int`,
      })
      .from(userGroupAgentGroupPermissions)
      .groupBy(userGroupAgentGroupPermissions.userGroupId),
  ]);

  const memberCountByGroupId = new Map(
    memberCounts.map((row) => [row.userGroupId, Number(row.count ?? 0)]),
  );
  const permissionCountByGroupId = new Map(
    permissionCounts.map((row) => [row.userGroupId, Number(row.count ?? 0)]),
  );

  return groups.map((group) => ({
    ...mapUserGroupRecord(group),
    memberCount: memberCountByGroupId.get(group.id) ?? 0,
    allowedAgentGroupCount: permissionCountByGroupId.get(group.id) ?? 0,
  }));
}

export async function getUserGroupDetail(
  sql: SqlClient,
  tenantId: string,
  userGroupId: string,
): Promise<UserGroupDetail | null> {
  const db = createUserGroupDb(sql);
  const [group] = await db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
    })
    .from(userGroups)
    .where(
      and(
        eq(userGroups.id, userGroupId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!group) {
    return null;
  }

  const [members, tenantUserRows, tenantAgentGroups, permissions] = await Promise.all([
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
      .orderBy(userSortExpression(), asc(tenantUsers.externalId)),
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
      .orderBy(userSortExpression(), asc(tenantUsers.externalId)),
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
    group: mapUserGroupRecord(group),
    members: members.map((row) => ({
      id: row.id,
      externalId: row.externalId,
      displayName: row.displayName ?? null,
      email: row.email ?? null,
      role: row.role,
      joinedAt: row.joinedAt,
    })),
    tenantUsers: tenantUserRows.map((row) => ({
      id: row.id,
      externalId: row.externalId,
      displayName: row.displayName ?? null,
      email: row.email ?? null,
      role: row.role,
    })),
    tenantAgentGroups: tenantAgentGroups.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
    })),
    allowedAgentGroupIds: permissions.map((row) => row.agentGroupId),
  };
}

export async function createUserGroup(
  sql: SqlClient,
  tenantId: string,
  input: { name: string; description?: string },
) {
  const db = createUserGroupDb(sql);
  const [group] = await db
    .insert(userGroups)
    .values({
      tenantId,
      name: input.name,
      description: input.description ?? "",
    })
    .returning({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
    });

  return mapUserGroupRecord(group);
}

export async function updateUserGroup(
  sql: SqlClient,
  tenantId: string,
  userGroupId: string,
  input: { name?: string; description?: string },
) {
  const db = createUserGroupDb(sql);
  const [existing] = await db
    .select()
    .from(userGroups)
    .where(
      and(
        eq(userGroups.id, userGroupId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!existing) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  const [group] = await db
    .update(userGroups)
    .set({
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
    })
    .where(
      and(
        eq(userGroups.id, userGroupId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .returning({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
    });

  return mapUserGroupRecord(group);
}

export async function addUserGroupMember(
  sql: SqlClient,
  tenantId: string,
  userGroupId: string,
  userId: string,
) {
  const db = createUserGroupDb(sql);
  const [[group], [user]] = await Promise.all([
    db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(
        and(
          eq(userGroups.id, userGroupId),
          eq(userGroups.tenantId, tenantId),
        ),
      )
      .limit(1),
    db
      .select({ id: tenantUsers.id })
      .from(tenantUsers)
      .where(
        and(
          eq(tenantUsers.id, userId),
          eq(tenantUsers.tenantId, tenantId),
        ),
      )
      .limit(1),
  ]);

  if (!group || !user) {
    return { error: "not_found" as const, message: "User group or user not found" };
  }

  await db
    .insert(userGroupMembers)
    .values({ userGroupId, userId })
    .onConflictDoNothing();

  return { success: true };
}

export async function removeUserGroupMember(
  sql: SqlClient,
  tenantId: string,
  userGroupId: string,
  userId: string,
) {
  const db = createUserGroupDb(sql);
  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(
      and(
        eq(userGroups.id, userGroupId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!group) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  await db
    .delete(userGroupMembers)
    .where(
      and(
        eq(userGroupMembers.userGroupId, userGroupId),
        eq(userGroupMembers.userId, userId),
      ),
    );

  return { success: true };
}

export async function saveUserGroupAgentGroupPermissions(
  sql: SqlClient,
  tenantId: string,
  userGroupId: string,
  agentGroupIds: string[],
) {
  const db = createUserGroupDb(sql);
  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(
      and(
        eq(userGroups.id, userGroupId),
        eq(userGroups.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!group) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  if (agentGroupIds.length > 0) {
    const validGroups = await db
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(
        and(
          eq(agentGroups.tenantId, tenantId),
          inArray(agentGroups.id, agentGroupIds),
        ),
      );

    if (validGroups.length !== agentGroupIds.length) {
      return {
        error: "validation" as const,
        message: "One or more agent groups were invalid",
      };
    }
  }

  await sql.begin(async (txSql) => {
    const tx = createUserGroupDb(txSql, sql.options);

    await tx
      .delete(userGroupAgentGroupPermissions)
      .where(eq(userGroupAgentGroupPermissions.userGroupId, userGroupId));

    if (agentGroupIds.length > 0) {
      await tx
        .insert(userGroupAgentGroupPermissions)
        .values(
          agentGroupIds.map((agentGroupId) => ({
            userGroupId,
            agentGroupId,
          })),
        );
    }
  });

  return { success: true };
}

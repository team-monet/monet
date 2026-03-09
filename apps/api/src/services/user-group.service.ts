import type postgres from "postgres";

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
    email: string | null;
    role: "user" | "group_admin" | "tenant_admin";
    joinedAt: Date;
  }>;
  tenantUsers: Array<{
    id: string;
    externalId: string;
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

export async function listAllowedAgentGroupIdsForUser(
  sql: postgres.Sql,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT ag.id
    FROM human_group_members hgm
    JOIN human_groups hg ON hg.id = hgm.human_group_id
    JOIN human_group_agent_group_permissions hgagp
      ON hgagp.human_group_id = hgm.human_group_id
    JOIN agent_groups ag ON ag.id = hgagp.agent_group_id
    WHERE hgm.user_id = ${userId}
      AND hg.tenant_id = ${tenantId}
      AND ag.tenant_id = ${tenantId}
  `;

  return (rows as unknown as Array<{ id: string }>).map((row) => row.id);
}

export async function userCanSelectAgentGroup(
  sql: postgres.Sql,
  tenantId: string,
  userId: string,
  groupId: string,
): Promise<boolean> {
  const [group] = await sql`
    SELECT id
    FROM agent_groups
    WHERE id = ${groupId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

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
  sql: postgres.Sql,
  tenantId: string,
): Promise<UserGroupSummary[]> {
  const rows = await sql`
    SELECT
      hg.id,
      hg.name,
      hg.description,
      hg.created_at,
      COALESCE(member_counts.count, 0)::int AS member_count,
      COALESCE(permission_counts.count, 0)::int AS allowed_agent_group_count
    FROM human_groups hg
    LEFT JOIN (
      SELECT human_group_id, COUNT(*)::int AS count
      FROM human_group_members
      GROUP BY human_group_id
    ) member_counts ON member_counts.human_group_id = hg.id
    LEFT JOIN (
      SELECT human_group_id, COUNT(*)::int AS count
      FROM human_group_agent_group_permissions
      GROUP BY human_group_id
    ) permission_counts ON permission_counts.human_group_id = hg.id
    WHERE hg.tenant_id = ${tenantId}
    ORDER BY hg.name ASC
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    createdAt: row.created_at as Date,
    memberCount: Number(row.member_count ?? 0),
    allowedAgentGroupCount: Number(row.allowed_agent_group_count ?? 0),
  }));
}

export async function getUserGroupDetail(
  sql: postgres.Sql,
  tenantId: string,
  userGroupId: string,
): Promise<UserGroupDetail | null> {
  const [group] = await sql`
    SELECT id, name, description, created_at
    FROM human_groups
    WHERE id = ${userGroupId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (!group) {
    return null;
  }

  const [members, tenantUsers, tenantAgentGroups, permissions] = await Promise.all([
    sql`
      SELECT
        u.id,
        u.external_id,
        u.email,
        u.role,
        hgm.joined_at
      FROM human_group_members hgm
      JOIN human_users u ON u.id = hgm.user_id
      WHERE hgm.human_group_id = ${userGroupId}
      ORDER BY u.email ASC NULLS LAST, u.external_id ASC
    `,
    sql`
      SELECT
        id,
        external_id,
        email,
        role
      FROM human_users
      WHERE tenant_id = ${tenantId}
      ORDER BY email ASC NULLS LAST, external_id ASC
    `,
    sql`
      SELECT
        id,
        name,
        description
      FROM agent_groups
      WHERE tenant_id = ${tenantId}
      ORDER BY name ASC
    `,
    sql`
      SELECT agent_group_id
      FROM human_group_agent_group_permissions
      WHERE human_group_id = ${userGroupId}
    `,
  ]);

  return {
    group: {
      id: group.id as string,
      name: group.name as string,
      description: group.description as string,
      createdAt: group.created_at as Date,
    },
    members: (members as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      externalId: row.external_id as string,
      email: (row.email as string | null) ?? null,
      role: row.role as "user" | "group_admin" | "tenant_admin",
      joinedAt: row.joined_at as Date,
    })),
    tenantUsers: (tenantUsers as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      externalId: row.external_id as string,
      email: (row.email as string | null) ?? null,
      role: row.role as "user" | "group_admin" | "tenant_admin",
    })),
    tenantAgentGroups: (tenantAgentGroups as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? "",
    })),
    allowedAgentGroupIds: (permissions as Array<Record<string, unknown>>).map(
      (row) => row.agent_group_id as string,
    ),
  };
}

export async function createUserGroup(
  sql: postgres.Sql,
  tenantId: string,
  input: { name: string; description?: string },
) {
  const [group] = await sql`
    INSERT INTO human_groups (tenant_id, name, description)
    VALUES (${tenantId}, ${input.name}, ${input.description ?? ""})
    RETURNING id, name, description, created_at
  `;

  return {
    id: group.id as string,
    name: group.name as string,
    description: group.description as string,
    createdAt: group.created_at as Date,
  };
}

export async function updateUserGroup(
  sql: postgres.Sql,
  tenantId: string,
  userGroupId: string,
  input: { name?: string; description?: string },
) {
  const [existing] = await sql`
    SELECT id
    FROM human_groups
    WHERE id = ${userGroupId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (!existing) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  const [group] = await sql`
    UPDATE human_groups
    SET
      name = ${input.name ?? sql`name`},
      description = ${input.description ?? sql`description`}
    WHERE id = ${userGroupId}
      AND tenant_id = ${tenantId}
    RETURNING id, name, description, created_at
  `;

  return {
    id: group.id as string,
    name: group.name as string,
    description: group.description as string,
    createdAt: group.created_at as Date,
  };
}

export async function addUserGroupMember(
  sql: postgres.Sql,
  tenantId: string,
  userGroupId: string,
  userId: string,
) {
  const [[group], [user]] = await Promise.all([
    sql`
      SELECT id
      FROM human_groups
      WHERE id = ${userGroupId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `,
    sql`
      SELECT id
      FROM human_users
      WHERE id = ${userId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `,
  ]);

  if (!group || !user) {
    return { error: "not_found" as const, message: "User group or user not found" };
  }

  await sql`
    INSERT INTO human_group_members (human_group_id, user_id)
    VALUES (${userGroupId}, ${userId})
    ON CONFLICT DO NOTHING
  `;

  return { success: true };
}

export async function removeUserGroupMember(
  sql: postgres.Sql,
  tenantId: string,
  userGroupId: string,
  userId: string,
) {
  const [group] = await sql`
    SELECT id
    FROM human_groups
    WHERE id = ${userGroupId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (!group) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  await sql`
    DELETE FROM human_group_members
    WHERE human_group_id = ${userGroupId}
      AND user_id = ${userId}
  `;

  return { success: true };
}

export async function saveUserGroupAgentGroupPermissions(
  sql: postgres.Sql,
  tenantId: string,
  userGroupId: string,
  agentGroupIds: string[],
) {
  const [group] = await sql`
    SELECT id
    FROM human_groups
    WHERE id = ${userGroupId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (!group) {
    return { error: "not_found" as const, message: "User group not found" };
  }

  if (agentGroupIds.length > 0) {
    const validGroups = await Promise.all(
      agentGroupIds.map((agentGroupId) =>
        sql`
          SELECT id
          FROM agent_groups
          WHERE tenant_id = ${tenantId}
            AND id = ${agentGroupId}
          LIMIT 1
        `,
      ),
    );

    if (validGroups.some((rows) => rows.length === 0)) {
      return {
        error: "validation" as const,
        message: "One or more agent groups were invalid",
      };
    }
  }

  await sql.begin(async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;

    await tx`
      DELETE FROM human_group_agent_group_permissions
      WHERE human_group_id = ${userGroupId}
    `;

    if (agentGroupIds.length > 0) {
      for (const agentGroupId of agentGroupIds) {
        await tx`
          INSERT INTO human_group_agent_group_permissions (human_group_id, agent_group_id)
          VALUES (${userGroupId}, ${agentGroupId})
        `;
      }
    }
  });

  return { success: true };
}

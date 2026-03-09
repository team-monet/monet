import type postgres from "postgres";

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

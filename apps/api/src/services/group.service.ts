import type postgres from "postgres";
import type { AgentContext } from "../middleware/context.js";

// ---------- Role helpers ----------

/**
 * Resolve the effective role for an agent.
 * Checks agent.role first, then falls back to linked humanUser.role.
 * Roles are always resolved from the database, never from request claims (threat model E1).
 */
export async function resolveAgentRole(
  sql: postgres.Sql,
  agent: AgentContext,
): Promise<string | null> {
  // Agent has a direct role (e.g., provisioning admin)
  if (agent.role) return agent.role;

  // Fall back to the linked user's role
  if (agent.userId) {
    const [user] = await sql`
      SELECT role FROM human_users WHERE id = ${agent.userId}
    `;
    if (user) return user.role as string;
  }

  return null;
}

export function isTenantAdmin(role: string | null): boolean {
  return role === "tenant_admin";
}

export function isGroupAdminOrAbove(role: string | null): boolean {
  return role === "tenant_admin" || role === "group_admin";
}

// ---------- Group CRUD ----------

export async function createGroup(
  sql: postgres.Sql,
  tenantId: string,
  input: { name: string; description?: string; memoryQuota?: number },
) {
  const [group] = await sql`
    INSERT INTO agent_groups (tenant_id, name, description, memory_quota)
    VALUES (${tenantId}, ${input.name}, ${input.description ?? ""}, ${input.memoryQuota ?? null})
    RETURNING id, tenant_id, name, description, memory_quota, created_at
  `;

  return {
    id: group.id as string,
    tenantId: group.tenant_id as string,
    name: group.name as string,
    description: group.description as string,
    memoryQuota: (group.memory_quota as number) ?? null,
    createdAt: group.created_at as string,
  };
}

export async function updateGroup(
  sql: postgres.Sql,
  tenantId: string,
  groupId: string,
  input: { name?: string; description?: string; memoryQuota?: number },
) {
  // Verify group belongs to this tenant
  const [existing] = await sql`
    SELECT id FROM agent_groups WHERE id = ${groupId} AND tenant_id = ${tenantId}
  `;
  if (!existing) {
    return { error: "not_found" as const, message: "Group not found" };
  }

  const [group] = await sql`
    UPDATE agent_groups
    SET
      name = ${input.name ?? sql`name`},
      description = ${input.description ?? sql`description`},
      memory_quota = ${input.memoryQuota !== undefined ? input.memoryQuota : sql`memory_quota`}
    WHERE id = ${groupId} AND tenant_id = ${tenantId}
    RETURNING id, tenant_id, name, description, memory_quota, created_at
  `;

  return {
    id: group.id as string,
    tenantId: group.tenant_id as string,
    name: group.name as string,
    description: group.description as string,
    memoryQuota: (group.memory_quota as number) ?? null,
    createdAt: group.created_at as string,
  };
}

export async function addMember(
  sql: postgres.Sql,
  tenantId: string,
  groupId: string,
  agentId: string,
) {
  // Verify group belongs to this tenant
  const [group] = await sql`
    SELECT id FROM agent_groups WHERE id = ${groupId} AND tenant_id = ${tenantId}
  `;
  if (!group) {
    return { error: "not_found" as const, message: "Group not found" };
  }

  // Verify agent belongs to this tenant
  const [agent] = await sql`
    SELECT id FROM agents WHERE id = ${agentId} AND tenant_id = ${tenantId}
  `;
  if (!agent) {
    return { error: "not_found" as const, message: "Agent not found" };
  }

  const existingMemberships = await sql`
    SELECT group_id FROM agent_group_members
    WHERE agent_id = ${agentId}
    ORDER BY joined_at ASC, group_id ASC
  `;

  const alreadyInTargetGroup = existingMemberships.some(
    (membership) => membership.group_id === groupId,
  );

  if (alreadyInTargetGroup && existingMemberships.length === 1) {
    return { error: "conflict" as const, message: "Agent is already a member of this group" };
  }

  if (existingMemberships.length > 0) {
    await sql`
      DELETE FROM agent_group_members
      WHERE agent_id = ${agentId}
    `;
  }

  if (!alreadyInTargetGroup || existingMemberships.length > 1) {
    await sql`
      INSERT INTO agent_group_members (agent_id, group_id)
      VALUES (${agentId}, ${groupId})
    `;
  }

  return {
    success: true,
    operation:
      existingMemberships.length > 0
        ? ("moved" as const)
        : ("created" as const),
  };
}

export async function removeMember(
  sql: postgres.Sql,
  tenantId: string,
  groupId: string,
  agentId: string,
) {
  // Verify group belongs to this tenant
  const [group] = await sql`
    SELECT id FROM agent_groups WHERE id = ${groupId} AND tenant_id = ${tenantId}
  `;
  if (!group) {
    return { error: "not_found" as const, message: "Group not found" };
  }

  // Check membership exists
  const [membership] = await sql`
    SELECT agent_id FROM agent_group_members
    WHERE agent_id = ${agentId} AND group_id = ${groupId}
  `;
  if (!membership) {
    return { error: "not_found" as const, message: "Agent is not a member of this group" };
  }

  const memberships = await sql`
    SELECT group_id FROM agent_group_members
    WHERE agent_id = ${agentId}
  `;

  if (memberships.length <= 1) {
    return {
      error: "conflict" as const,
      message: "Agents must remain assigned to a group. Move the agent to a new group instead.",
    };
  }

  // Remove membership only — authored entries are retained (M2 spec)
  await sql`
    DELETE FROM agent_group_members
    WHERE agent_id = ${agentId} AND group_id = ${groupId}
  `;

  return { success: true };
}

export async function listGroups(
  sql: postgres.Sql,
  tenantId: string,
) {
  const groups = await sql`
    SELECT id, tenant_id, name, description, memory_quota, created_at
    FROM agent_groups
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at ASC
  `;

  return (groups as Record<string, unknown>[]).map((g) => ({
    id: g.id as string,
    tenantId: g.tenant_id as string,
    name: g.name as string,
    description: g.description as string,
    memoryQuota: (g.memory_quota as number) ?? null,
    createdAt: g.created_at as string,
  }));
}

export async function listGroupMembers(
  sql: postgres.Sql,
  tenantId: string,
  groupId: string,
) {
  // Verify group belongs to tenant
  const [group] = await sql`
    SELECT id FROM agent_groups WHERE id = ${groupId} AND tenant_id = ${tenantId}
  `;
  if (!group) {
    return { error: "not_found" as const };
  }

  const members = await sql`
    SELECT
      a.id,
      a.external_id,
      a.tenant_id,
      a.user_id,
      a.role,
      a.is_autonomous,
      a.revoked_at,
      a.created_at,
      u.id AS owner_id,
      u.external_id AS owner_external_id,
      u.email AS owner_email
    FROM agents a
    LEFT JOIN human_users u ON u.id = a.user_id
    JOIN agent_group_members m ON m.agent_id = a.id
    WHERE m.group_id = ${groupId}
    ORDER BY m.joined_at ASC
  `;

  return {
    members: (members as Record<string, unknown>[]).map((m) => {
      const label =
        (m.owner_email as string | null) ?? (m.owner_external_id as string | null);

      return {
        id: m.id as string,
        externalId: m.external_id as string,
        tenantId: m.tenant_id as string,
        userId: (m.user_id as string | null) ?? null,
        isAutonomous: m.is_autonomous as boolean,
        role: (m.role as "user" | "group_admin" | "tenant_admin" | null) ?? null,
        revokedAt: (m.revoked_at as string | Date | null) ?? null,
        displayName: m.is_autonomous
          ? `${m.external_id as string} (Autonomous)`
          : label
            ? `${m.external_id as string} · ${label}`
            : (m.external_id as string),
        owner:
          (m.owner_id as string | null) && label
            ? {
                id: m.owner_id as string,
                externalId: (m.owner_external_id as string | null) ?? label,
                email: (m.owner_email as string | null) ?? null,
                label,
              }
            : null,
        createdAt: m.created_at as string,
      };
    }),
  };
}

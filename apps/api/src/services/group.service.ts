import {
  agentGroupMembers,
  agentGroups,
  agents,
  tenantSchemaNameFromId,
  tenantUsers,
  type SqlClient,
  withTenantDrizzleScope,
} from "@monet/db";
import { and, asc, eq } from "drizzle-orm";
import type { AgentContext } from "../middleware/context";

// ---------- Role helpers ----------

/**
 * Resolve the effective role for an agent.
 * Checks agent.role first, then falls back to the linked user role.
 * Roles are always resolved from the database, never from request claims (threat model E1).
 */
export async function resolveAgentRole(
  sql: SqlClient,
  agent: AgentContext,
): Promise<string | null> {
  // Agent has a direct role (e.g., provisioning admin)
  if (agent.role) return agent.role;

  // Fall back to the linked user's role
  if (agent.userId) {
    const schemaName = tenantSchemaNameFromId(agent.tenantId);
    const [user] = await withTenantDrizzleScope(sql, schemaName, async (db) => db
      .select({ role: tenantUsers.role })
      .from(tenantUsers)
      .where(eq(tenantUsers.id, agent.userId!))
      .limit(1));
    if (user) return user.role;
  }

  return null;
}

export function isTenantAdmin(role: string | null): boolean {
  return role === "tenant_admin";
}

export function isGroupAdminOrAbove(role: string | null): boolean {
  return role === "tenant_admin" || role === "group_admin";
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapGroupRecord(group: {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  memoryQuota: number | null;
  createdAt: Date | string;
}) {
  return {
    id: group.id,
    tenantId: group.tenantId,
    name: group.name,
    description: group.description ?? "",
    memoryQuota: group.memoryQuota ?? null,
    createdAt: formatTimestamp(group.createdAt),
  };
}

// ---------- Group CRUD ----------

export async function createGroup(
  sql: SqlClient,
  tenantId: string,
  input: { name: string; description?: string; memoryQuota?: number },
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const [group] = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .insert(agentGroups)
    .values({
      tenantId,
      name: input.name,
      description: input.description ?? "",
      memoryQuota: input.memoryQuota ?? null,
    })
    .returning());

  return mapGroupRecord(group);
}

export async function updateGroup(
  sql: SqlClient,
  tenantId: string,
  groupId: string,
  input: { name?: string; description?: string; memoryQuota?: number | null },
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [existing] = await db
      .select()
      .from(agentGroups)
      .where(
        and(
          eq(agentGroups.id, groupId),
          eq(agentGroups.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!existing) {
      return { error: "not_found" as const, message: "Group not found" };
    }

    const [group] = await db
      .update(agentGroups)
      .set({
        name: input.name ?? existing.name,
        description: input.description ?? existing.description ?? "",
        memoryQuota:
          input.memoryQuota !== undefined
            ? input.memoryQuota
            : existing.memoryQuota,
      })
      .where(
        and(
          eq(agentGroups.id, groupId),
          eq(agentGroups.tenantId, tenantId),
        ),
      )
      .returning();

    return mapGroupRecord(group);
  });
}

export async function addMember(
  sql: SqlClient,
  tenantId: string,
  groupId: string,
  agentId: string,
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => {

    // Verify group belongs to this tenant.
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
      return { error: "not_found" as const, message: "Group not found" };
    }

    // Verify agent belongs to this tenant.
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!agent) {
      return { error: "not_found" as const, message: "Agent not found" };
    }

    const existingMemberships = await db
      .select({ groupId: agentGroupMembers.groupId })
      .from(agentGroupMembers)
      .where(eq(agentGroupMembers.agentId, agentId))
      .orderBy(
        asc(agentGroupMembers.joinedAt),
        asc(agentGroupMembers.groupId),
      );

    const alreadyInTargetGroup = existingMemberships.some(
      (membership) => membership.groupId === groupId,
    );

    if (alreadyInTargetGroup && existingMemberships.length === 1) {
      return { error: "conflict" as const, message: "Agent is already a member of this group" };
    }

    if (existingMemberships.length > 0) {
      await db
        .delete(agentGroupMembers)
        .where(eq(agentGroupMembers.agentId, agentId));
    }

    if (!alreadyInTargetGroup || existingMemberships.length > 1) {
      await db
        .insert(agentGroupMembers)
        .values({ agentId, groupId });
    }

    return {
      success: true,
      operation:
        existingMemberships.length > 0
          ? ("moved" as const)
          : ("created" as const),
    };
  });
}

export async function removeMember(
  sql: SqlClient,
  tenantId: string,
  groupId: string,
  agentId: string,
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => {

  // Verify group belongs to this tenant
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
    return { error: "not_found" as const, message: "Group not found" };
  }

  // Check membership exists
  const [membership] = await db
    .select({ agentId: agentGroupMembers.agentId })
    .from(agentGroupMembers)
    .where(
      and(
        eq(agentGroupMembers.agentId, agentId),
        eq(agentGroupMembers.groupId, groupId),
      ),
    )
    .limit(1);

  if (!membership) {
    return { error: "not_found" as const, message: "Agent is not a member of this group" };
  }

  const memberships = await db
    .select({ groupId: agentGroupMembers.groupId })
    .from(agentGroupMembers)
    .where(eq(agentGroupMembers.agentId, agentId));

  if (memberships.length <= 1) {
    return {
      error: "conflict" as const,
      message: "Agents must remain assigned to a group. Move the agent to a new group instead.",
    };
  }

  // Remove membership only — authored entries are retained (M2 spec)
  await db
    .delete(agentGroupMembers)
    .where(
      and(
        eq(agentGroupMembers.agentId, agentId),
        eq(agentGroupMembers.groupId, groupId),
      ),
    );

    return { success: true };
  });
}

export async function listGroups(
  sql: SqlClient,
  tenantId: string,
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const groups = await withTenantDrizzleScope(sql, schemaName, async (db) => db
    .select()
    .from(agentGroups)
    .where(eq(agentGroups.tenantId, tenantId))
    .orderBy(asc(agentGroups.createdAt)));

  return groups.map(mapGroupRecord);
}

export async function listGroupMembers(
  sql: SqlClient,
  tenantId: string,
  groupId: string,
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  return withTenantDrizzleScope(sql, schemaName, async (db) => {

  // Verify group belongs to tenant
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
    return { error: "not_found" as const };
  }

  const members = await db
    .select({
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
    })
    .from(agentGroupMembers)
    .innerJoin(agents, eq(agents.id, agentGroupMembers.agentId))
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(eq(agentGroupMembers.groupId, groupId))
    .orderBy(asc(agentGroupMembers.joinedAt));

    return {
      members: members.map((member) => {
      const ownerLabel =
        member.ownerDisplayName ??
        member.ownerEmail ??
        member.ownerExternalId ??
        null;

      return {
        id: member.id,
        externalId: member.externalId,
        tenantId: member.tenantId,
        userId: member.userId ?? null,
        isAutonomous: member.isAutonomous,
        role: member.role ?? null,
        revokedAt: member.revokedAt ?? null,
        displayName: member.isAutonomous
          ? `${member.externalId} (Autonomous)`
          : ownerLabel
            ? `${member.externalId} · ${ownerLabel}`
            : member.externalId,
        owner:
          member.ownerId && ownerLabel
            ? {
                id: member.ownerId,
                externalId: member.ownerExternalId ?? ownerLabel,
                displayName: member.ownerDisplayName ?? null,
                email: member.ownerEmail ?? null,
                label: ownerLabel,
              }
            : null,
        createdAt: formatTimestamp(member.createdAt),
      };
      }),
    };
  });
}

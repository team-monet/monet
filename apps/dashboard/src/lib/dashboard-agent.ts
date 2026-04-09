import { randomUUID } from "node:crypto";
import { db } from "./db";
import {
  agentGroupMembers,
  agentGroups,
  agents,
  tenantSchemaNameFromId,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  tenantUsers,
  withTenantDrizzleScope,
  type Database,
  type TransactionClient,
} from "@monet/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { encrypt } from "./crypto";
import { generateApiKey, hashApiKey } from "./api-key";
import { getSqlClient } from "./db";

async function withTenantDb<T>(
  tenantId: string,
  fn: (db: Database, sql: TransactionClient) => Promise<T>,
): Promise<T> {
  return withTenantDrizzleScope(getSqlClient(), tenantSchemaNameFromId(tenantId), fn);
}

export async function ensureDashboardAgent(
  userId: string,
  _externalId: string, // Unused now that we have a standard format
  tenantId: string,
) {
  return withTenantDb(tenantId, async (tenantDb) => {
  // 1. Load user and existing dashboard agent metadata.
  const userRows = await tenantDb
    .select({ 
      id: tenantUsers.id,
      role: tenantUsers.role,
      dashboardApiKeyEncrypted: tenantUsers.dashboardApiKeyEncrypted 
    })
    .from(tenantUsers)
    .where(eq(tenantUsers.id, userId))
    .limit(1);

  const user = userRows[0];
  if (!user) {
    throw new Error("User not found for dashboard agent sync");
  }

  const dashboardExternalId = `dashboard:${userId}`;
  const desiredRole = user.role ?? "user";

  const [existingAgent] = await tenantDb
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.externalId, dashboardExternalId)))
    .limit(1);

  let encryptedApiKey = user.dashboardApiKeyEncrypted;
  let dashboardAgentId: string | null = null;

  if (existingAgent) {
    dashboardAgentId = existingAgent.id;
    if (existingAgent.role !== desiredRole) {
      await tenantDb
        .update(agents)
        .set({ role: desiredRole })
        .where(eq(agents.id, existingAgent.id));
    }
  }

  // 2. If missing dashboard API key or missing dashboard agent, create/repair both together.
  if (!dashboardAgentId || !encryptedApiKey) {
    const targetAgentId = dashboardAgentId ?? randomUUID();
    const apiKey = generateApiKey(targetAgentId);
    const { hash, salt } = hashApiKey(apiKey);

    encryptedApiKey = await tenantDb.transaction(async (tx) => {
      if (!dashboardAgentId) {
        const [newAgent] = await tx
          .insert(agents)
          .values({
            id: targetAgentId,
            externalId: dashboardExternalId,
            tenantId,
            userId,
            apiKeyHash: hash,
            apiKeySalt: salt,
            isAutonomous: false,
            role: desiredRole,
          })
          .returning();
        dashboardAgentId = newAgent.id;
      } else {
        await tx
          .update(agents)
          .set({
            apiKeyHash: hash,
            apiKeySalt: salt,
            role: desiredRole,
          })
          .where(eq(agents.id, dashboardAgentId));
      }

      const encrypted = encrypt(apiKey);

      await tx
        .update(tenantUsers)
        .set({ dashboardApiKeyEncrypted: encrypted })
        .where(eq(tenantUsers.id, userId));

      return encrypted;
    });
  }

  // 3. Sync group memberships
  if (dashboardAgentId) {
    await syncAgentGroups(tenantDb, userId, dashboardAgentId, tenantId);
  }

  return encryptedApiKey!;
  });
}

/**
 * Lightweight 1-query role sync for the hot path.  Only updates when the
 * dashboard agent's role diverges from the user's current role.
 */
export async function syncDashboardAgentRole(userId: string, tenantId: string) {
  return withTenantDb(tenantId, async (tenantDb) => {
    const dashboardExternalId = `dashboard:${userId}`;
    const rows = await tenantDb
      .select({
        agentId: agents.id,
        agentRole: agents.role,
        userRole: tenantUsers.role,
      })
      .from(agents)
      .innerJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
      .where(and(eq(agents.userId, userId), eq(agents.externalId, dashboardExternalId)))
      .limit(1);

    if (rows.length === 1 && rows[0].agentRole !== (rows[0].userRole ?? "user")) {
      await tenantDb
        .update(agents)
        .set({ role: rows[0].userRole ?? "user" })
        .where(eq(agents.id, rows[0].agentId));
    }
  });
}

async function syncAgentGroups(
  tenantDb: typeof db,
  userId: string,
  dashboardAgentId: string,
  tenantId: string,
) {
  // Find the preferred group from the user's other agents first.
  const userAgents = await tenantDb
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), ne(agents.id, dashboardAgentId)));

  let preferredGroupId: string | null = null;
  if (userAgents.length > 0) {
    const agentIds = userAgents.map((a) => a.id);
    const memberships = await tenantDb
      .select({
        groupId: agentGroupMembers.groupId,
        joinedAt: agentGroupMembers.joinedAt,
      })
      .from(agentGroupMembers)
      .where(inArray(agentGroupMembers.agentId, agentIds))
      .orderBy(asc(agentGroupMembers.joinedAt), asc(agentGroupMembers.groupId));

    const orderedGroupIds = [...new Set(memberships.map((membership) => membership.groupId))];
    preferredGroupId = orderedGroupIds[0] ?? null;
  }

  // Fall back to the first agent group the user's user-group memberships allow.
  if (!preferredGroupId) {
    const allowedGroups = await tenantDb
      .selectDistinct({
        id: agentGroups.id,
        name: agentGroups.name,
      })
      .from(userGroupMembers)
      .innerJoin(
        userGroups,
        eq(userGroups.id, userGroupMembers.userGroupId),
      )
      .innerJoin(
        userGroupAgentGroupPermissions,
        eq(
          userGroupAgentGroupPermissions.userGroupId,
          userGroupMembers.userGroupId,
        ),
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
      )
      .orderBy(asc(agentGroups.name));

    preferredGroupId = allowedGroups[0]?.id ?? null;
  }

  // Current memberships for dashboard agent
  const currentMemberships = await tenantDb
    .select({ groupId: agentGroupMembers.groupId })
    .from(agentGroupMembers)
    .where(eq(agentGroupMembers.agentId, dashboardAgentId));

  if (!preferredGroupId) {
    if (currentMemberships.length > 0) {
      await tenantDb
        .delete(agentGroupMembers)
        .where(eq(agentGroupMembers.agentId, dashboardAgentId));
    }
    return;
  }

  if (
    currentMemberships.length === 1 &&
    currentMemberships[0].groupId === preferredGroupId
  ) {
    return;
  }

  await tenantDb.transaction(async (tx) => {
    await tx
      .delete(agentGroupMembers)
      .where(eq(agentGroupMembers.agentId, dashboardAgentId));

    await tx.insert(agentGroupMembers).values({
      agentId: dashboardAgentId,
      groupId: preferredGroupId,
    });
  });
}

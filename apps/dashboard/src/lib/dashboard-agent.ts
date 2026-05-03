import { randomUUID } from "node:crypto";
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
import { and, eq, inArray, ne } from "drizzle-orm";
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

/**
 * Sync dashboard agent group memberships for the hot path.
 * Resolves the dashboard agent by externalId, computes the desired
 * memberships from the user's other agents and user-group permissions,
 * then performs a set-diff sync inside a DB transaction.
 */
export async function syncDashboardAgentGroups(userId: string, tenantId: string) {
  return withTenantDb(tenantId, async (tenantDb) => {
    const dashboardExternalId = `dashboard:${userId}`;
    const [agentRow] = await tenantDb
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.externalId, dashboardExternalId)))
      .limit(1);

    if (!agentRow) {
      return;
    }

    await syncAgentGroups(tenantDb, userId, agentRow.id, tenantId);
  });
}

export async function updateDashboardCredentialIfOwnedAgent(
  userId: string,
  tenantId: string,
  agentId: string,
  apiKey: string,
) {
  return withTenantDb(tenantId, async (tenantDb) => {
    const dashboardExternalId = `dashboard:${userId}`;
    const rows = await tenantDb
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.userId, userId),
          eq(agents.externalId, dashboardExternalId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return false;
    }

    await tenantDb
      .update(tenantUsers)
      .set({ dashboardApiKeyEncrypted: encrypt(apiKey) })
      .where(eq(tenantUsers.id, userId));

    return true;
  });
}

async function syncAgentGroups(
  tenantDb: Database,
  userId: string,
  dashboardAgentId: string,
  tenantId: string,
) {
  await tenantDb.transaction(async (tx) => {
    // 1. Find all groups from the user's other agents.
    const userAgents = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), ne(agents.id, dashboardAgentId)));

    const groupIdsFromOtherAgents = new Set<string>();
    if (userAgents.length > 0) {
      const agentIds = userAgents.map((a) => a.id);
      const memberships = await tx
        .select({
          groupId: agentGroupMembers.groupId,
        })
        .from(agentGroupMembers)
        .where(inArray(agentGroupMembers.agentId, agentIds));

      for (const membership of memberships) {
        groupIdsFromOtherAgents.add(membership.groupId);
      }
    }

    // 2. Find all groups from user-group permission chain.
    const allowedGroups = await tx
      .selectDistinct({
        id: agentGroups.id,
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
      );

    const groupIdsFromPermissions = new Set(allowedGroups.map((g) => g.id));

    // 3. Combine both sources into desired memberships.
    const desiredGroupIds = new Set([...groupIdsFromOtherAgents, ...groupIdsFromPermissions]);

    // 4. Current memberships for dashboard agent.
    const currentMemberships = await tx
      .select({ groupId: agentGroupMembers.groupId })
      .from(agentGroupMembers)
      .where(eq(agentGroupMembers.agentId, dashboardAgentId));

    const currentGroupIds = new Set(currentMemberships.map((m) => m.groupId));

    // 5. If already exactly matched, skip.
    if (
      currentGroupIds.size === desiredGroupIds.size &&
      [...currentGroupIds].every((id) => desiredGroupIds.has(id))
    ) {
      return;
    }

    // 6. Delete stale, insert missing.
    const toDelete = [...currentGroupIds].filter((id) => !desiredGroupIds.has(id));
    const toInsert = [...desiredGroupIds].filter((id) => !currentGroupIds.has(id));

    if (toDelete.length === 0 && toInsert.length === 0) {
      return;
    }

    if (toDelete.length > 0) {
      await tx
        .delete(agentGroupMembers)
        .where(
          and(
            eq(agentGroupMembers.agentId, dashboardAgentId),
            inArray(agentGroupMembers.groupId, toDelete),
          ),
        );
    }

    if (toInsert.length > 0) {
      const values = toInsert.map((groupId) => ({
        agentId: dashboardAgentId,
        groupId,
      }));

      try {
        await tx
          .insert(agentGroupMembers)
          .values(values)
          .onConflictDoNothing({
            target: [agentGroupMembers.agentId, agentGroupMembers.groupId],
          });
      } catch {
        // Fallback for tenants where the composite PK upgrade has not run yet.
        await tx.insert(agentGroupMembers).values(values);
      }
    }
  });
}

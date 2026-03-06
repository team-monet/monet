import { db } from "./db";
import { humanUsers, agents, agentGroupMembers } from "@monet/db";
import { eq, inArray, and, ne } from "drizzle-orm";
import { encrypt } from "./crypto";
import { generateApiKey, hashApiKey } from "./api-key";

export async function ensureDashboardAgent(
  userId: string,
  _externalId: string, // Unused now that we have a standard format
  tenantId: string,
) {
  // 1. Load user and existing dashboard agent metadata.
  const userRows = await db
    .select({ 
      id: humanUsers.id,
      role: humanUsers.role,
      dashboardApiKeyEncrypted: humanUsers.dashboardApiKeyEncrypted 
    })
    .from(humanUsers)
    .where(eq(humanUsers.id, userId))
    .limit(1);

  const user = userRows[0];
  if (!user) {
    throw new Error("Human user not found for dashboard agent sync");
  }

  const dashboardExternalId = `dashboard:${userId}`;
  const desiredRole = user.role ?? "user";

  const [existingAgent] = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.externalId, dashboardExternalId)))
    .limit(1);

  let encryptedApiKey = user.dashboardApiKeyEncrypted;
  let dashboardAgentId: string | null = null;

  if (existingAgent) {
    dashboardAgentId = existingAgent.id;
    if (existingAgent.role !== desiredRole) {
      await db
        .update(agents)
        .set({ role: desiredRole })
        .where(eq(agents.id, existingAgent.id));
    }
  }

  // 2. If missing dashboard API key or missing dashboard agent, create/repair both together.
  if (!dashboardAgentId || !encryptedApiKey) {
    const apiKey = generateApiKey(dashboardExternalId);
    const { hash, salt } = hashApiKey(apiKey);

    encryptedApiKey = await db.transaction(async (tx) => {
      if (!dashboardAgentId) {
        const [newAgent] = await tx
          .insert(agents)
          .values({
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
        .update(humanUsers)
        .set({ dashboardApiKeyEncrypted: encrypted })
        .where(eq(humanUsers.id, userId));

      return encrypted;
    });
  }

  // 3. Sync group memberships
  if (dashboardAgentId) {
    await syncAgentGroups(userId, dashboardAgentId);
  }

  return encryptedApiKey!;
}

async function syncAgentGroups(userId: string, dashboardAgentId: string) {
  // Find all groups user's other agents belong to
  const userAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), ne(agents.id, dashboardAgentId)));

  let targetGroups: string[] = [];
  if (userAgents.length > 0) {
    const agentIds = userAgents.map((a) => a.id);
    const memberships = await db
      .select({ groupId: agentGroupMembers.groupId })
      .from(agentGroupMembers)
      .where(inArray(agentGroupMembers.agentId, agentIds));
    targetGroups = [...new Set(memberships.map((m) => m.groupId))];
  }

  // Current memberships for dashboard agent
  const currentMemberships = await db
    .select({ groupId: agentGroupMembers.groupId })
    .from(agentGroupMembers)
    .where(eq(agentGroupMembers.agentId, dashboardAgentId));

  if (targetGroups.length === 0) {
    if (currentMemberships.length > 0) {
      await db
        .delete(agentGroupMembers)
        .where(eq(agentGroupMembers.agentId, dashboardAgentId));
    }
    return;
  }

  const currentGroups = new Set(currentMemberships.map((m) => m.groupId));
  const targetGroupSet = new Set(targetGroups);
  const groupsToAdd = targetGroups.filter((id) => !currentGroups.has(id));
  const groupsToRemove = [...currentGroups].filter((id) => !targetGroupSet.has(id));

  if (groupsToAdd.length > 0) {
    await db.insert(agentGroupMembers).values(
      groupsToAdd.map((groupId) => ({
        agentId: dashboardAgentId,
        groupId,
      }))
    );
  }

  if (groupsToRemove.length > 0) {
    await db
      .delete(agentGroupMembers)
      .where(
        and(
          eq(agentGroupMembers.agentId, dashboardAgentId),
          inArray(agentGroupMembers.groupId, groupsToRemove),
        ),
      );
  }
}

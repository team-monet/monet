import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  agentGroupMembers,
  agentGroups as agentGroupsTable,
  tenantSchemaNameFromId,
  tenantUsers,
  withTenantDrizzleScope,
  type Database,
  type TransactionClient,
} from "@monet/db";
import type { Agent } from "@monet/types";
import { getApiClient } from "@/lib/api-client";
import { listAllowedAgentGroupsForUserByUserGroups } from "@/lib/agent-group-access";
import { requireAuth } from "@/lib/auth";
import { getSqlClient } from "@/lib/db";
import AgentList from "./agent-list";
import RegisterAgentDialog from "./register-agent-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

interface ExtendedUser {
  id?: string;
  role?: string | null;
  tenantId?: string;
}

async function withTenantDb<T>(
  tenantId: string,
  fn: (db: Database, sql: TransactionClient) => Promise<T>,
): Promise<T> {
  return withTenantDrizzleScope(getSqlClient(), tenantSchemaNameFromId(tenantId), fn);
}

export default async function AgentsPage() {
  const session = await requireAuth();
  const sessionUser = session.user as ExtendedUser;
  const isAdmin = sessionUser.role === "tenant_admin";
  const tenantId = sessionUser.tenantId;
  const userId = sessionUser.id;

  let agents: Agent[] = [];
  const groupMemberships: Record<string, string[]> = {};
  let availableGroups: Array<{ id: string; name: string }> = [];
  let bindableUsers: Array<{
    id: string;
    externalId: string;
    displayName: string | null;
    email: string | null;
  }> = [];
  let error = "";

  try {
    if (!tenantId || !userId) {
      throw new Error("Session is missing tenant or user information.");
    }

    const client = await getApiClient();
    agents = await client.listAgents();

    const [availableGroupsForSession, userRows, membershipRows] = await Promise.all([
      isAdmin
        ? withTenantDb(tenantId, async (db) => db
            .selectDistinct({
              id: agentGroupsTable.id,
              name: agentGroupsTable.name,
            })
            .from(agentGroupsTable)
            .where(eq(agentGroupsTable.tenantId, tenantId))
            .orderBy(asc(agentGroupsTable.name)))
        : listAllowedAgentGroupsForUserByUserGroups(tenantId, userId),
      isAdmin
        ? withTenantDb(tenantId, async (db) => db
            .select({
              id: tenantUsers.id,
              externalId: tenantUsers.externalId,
              displayName: tenantUsers.displayName,
              email: tenantUsers.email,
            })
            .from(tenantUsers)
            .where(eq(tenantUsers.tenantId, tenantId))
            .orderBy(
              sql`coalesce(${tenantUsers.displayName}, ${tenantUsers.email}, ${tenantUsers.externalId})`,
              asc(tenantUsers.externalId),
            ))
        : Promise.resolve([]),
      agents.length === 0
        ? Promise.resolve([])
        : withTenantDb(tenantId, async (db) => db
            .select({
              agentId: agentGroupMembers.agentId,
              groupName: agentGroupsTable.name,
            })
            .from(agentGroupMembers)
            .innerJoin(
              agentGroupsTable,
              eq(agentGroupsTable.id, agentGroupMembers.groupId),
            )
            .where(inArray(agentGroupMembers.agentId, agents.map((agent) => agent.id)))
            .orderBy(asc(agentGroupsTable.name))),
    ]);

    availableGroups = availableGroupsForSession;
    bindableUsers = userRows;

    for (const membership of membershipRows) {
      groupMemberships[membership.agentId] = [
        ...(groupMemberships[membership.agentId] ?? []),
        membership.groupName,
      ];
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">
            {isAdmin
              ? "Register and manage all AI agents in your tenant."
              : "Register and manage the AI agents bound to your account."}
          </p>
        </div>

        <RegisterAgentDialog
          availableGroups={availableGroups}
          bindableUsers={bindableUsers}
          isAdmin={isAdmin}
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading agents</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <AgentList
          initialAgents={agents}
          initialGroupMemberships={groupMemberships}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}

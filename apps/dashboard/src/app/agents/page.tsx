import { getApiClient } from "@/lib/api-client";
import AgentList from "./agent-list";
import type { Agent } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

export default async function AgentsPage() {
  let agents: Agent[] = [];
  let groupMemberships: Record<string, string[]> = {};
  let error = "";

  try {
    const client = await getApiClient();
    const [allAgents, groupsResult] = await Promise.all([
      client.listAgents(),
      client.listGroups(),
    ]);
    agents = allAgents;

    const membershipRows = await Promise.all(
      groupsResult.groups.map(async (group) => {
        const result = await client.listGroupMembers(group.id);
        return { groupName: group.name, members: result.members };
      }),
    );

    const membershipMap: Record<string, string[]> = {};
    for (const row of membershipRows) {
      for (const member of row.members) {
        membershipMap[member.id] = [...(membershipMap[member.id] ?? []), row.groupName];
      }
    }
    groupMemberships = membershipMap;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
        <p className="text-muted-foreground mt-1">
          Monitor and manage your organization's AI agents.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading agents</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <AgentList initialAgents={agents} initialGroupMemberships={groupMemberships} />
      )}
    </div>
  );
}

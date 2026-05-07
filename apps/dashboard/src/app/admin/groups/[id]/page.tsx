import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { Agent, AgentGroup, RuleSet } from "@monet/types";
import { GroupMembersManager } from "./group-members-manager";
import { GroupRuleSetsManager } from "./group-rule-sets-manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, ArrowLeft, Users } from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function GroupMembersPage({ params }: PageProps) {
  const { id: groupId } = await params;
  await requireAdmin();

  let group: AgentGroup | undefined;
  let members: Agent[] = [];
  let availableAgents: Agent[] = [];
  let appliedRuleSets: RuleSet[] = [];
  let availableRuleSets: RuleSet[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const [groupsResult, agentsResult] = await Promise.all([
      client.listGroups(),
      client.listAgents(),
    ]);

    group = groupsResult.groups.find((g) => g.id === groupId);
    if (!group) {
      error = "Group not found.";
    } else {
      const [membersResult, groupRuleSetsResult, allRuleSetsResult] = await Promise.all([
        client.listGroupMembers(groupId),
        client.listGroupRuleSets(groupId),
        client.listRuleSets(),
      ]);
      members = membersResult.members;
      appliedRuleSets = groupRuleSetsResult.ruleSets;
      const appliedIds = new Set(appliedRuleSets.map((rs) => rs.id));
      availableRuleSets = allRuleSetsResult.ruleSets.filter((rs) => !appliedIds.has(rs.id));
      const memberIds = new Set(members.map((m) => m.id));
      availableAgents = agentsResult.filter((agent) => !memberIds.has(agent.id));
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Group Details</h1>
          <p className="text-muted-foreground mt-1">
            Review applied rule sets and manage agents in this group.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/admin/groups">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Groups
          </Link>
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load group members</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" />
                  {group?.name}
                </CardTitle>
                <CardDescription>
                  {group?.description || "No group description provided yet."}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Memory quota
                  </p>
                  <p className="text-sm font-medium">
                    {group?.memoryQuota ? `${group.memoryQuota} entries` : group?.memoryQuota === 0 ? "Unlimited" : "Default"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Current members
                  </p>
                  <p className="text-sm font-medium">
                    {members.length} {members.length === 1 ? "agent" : "agents"}
                  </p>
                </div>
              </CardContent>
            </Card>

            <GroupRuleSetsManager groupId={groupId} appliedRuleSets={appliedRuleSets} availableRuleSets={availableRuleSets} />
          </div>

          <GroupMembersManager groupId={groupId} members={members} availableAgents={availableAgents} />
        </>
      )}
    </div>
  );
}

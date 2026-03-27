import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { Agent, AgentGroup, RuleSet } from "@monet/types";
import { formatAgentDisplayName } from "@/lib/agent-display";
import {
  addGroupMemberAction,
  removeGroupMemberAction,
  addGroupRuleSetAction,
  removeGroupRuleSetAction,
} from "../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ArrowLeft, Bot, Layers, User, Users } from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function GroupMembersPage({ params, searchParams }: PageProps) {
  const [{ id: groupId }, query] = await Promise.all([params, searchParams]);
  await requireAdmin();

  const memberAdded = getSingleParam(query.memberAdded) === "1";
  const memberRemoved = getSingleParam(query.memberRemoved) === "1";
  const memberError = getSingleParam(query.memberError);
  const ruleSetAdded = getSingleParam(query.ruleSetAdded) === "1";
  const ruleSetRemoved = getSingleParam(query.ruleSetRemoved) === "1";
  const ruleSetError = getSingleParam(query.ruleSetError);

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

      {memberAdded && (
        <Alert>
          <AlertTitle>Member added</AlertTitle>
          <AlertDescription>The agent was added to the group.</AlertDescription>
        </Alert>
      )}

      {memberRemoved && (
        <Alert>
          <AlertTitle>Member removed</AlertTitle>
          <AlertDescription>The agent was removed from the group.</AlertDescription>
        </Alert>
      )}

      {memberError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Member update failed</AlertTitle>
          <AlertDescription>{memberError}</AlertDescription>
        </Alert>
      )}

      {ruleSetAdded && (
        <Alert>
          <AlertTitle>Rule set added</AlertTitle>
          <AlertDescription>The rule set was applied to this group.</AlertDescription>
        </Alert>
      )}

      {ruleSetRemoved && (
        <Alert>
          <AlertTitle>Rule set removed</AlertTitle>
          <AlertDescription>The rule set was removed from this group.</AlertDescription>
        </Alert>
      )}

      {ruleSetError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Rule set update failed</AlertTitle>
          <AlertDescription>{ruleSetError}</AlertDescription>
        </Alert>
      )}

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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="h-4 w-4" />
                  Applied Rule Sets
                </CardTitle>
                <CardDescription>
                  These rule sets are inherited automatically by agents in this group.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {appliedRuleSets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No rule sets are attached to this group.</p>
                ) : (
                  appliedRuleSets.map((ruleSet) => (
                    <div key={ruleSet.id} className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <Link href={`/admin/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">
                          {ruleSet.name}
                        </Link>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"}
                        </p>
                      </div>
                      <form action={removeGroupRuleSetAction}>
                        <input type="hidden" name="groupId" value={groupId} />
                        <input type="hidden" name="ruleSetId" value={ruleSet.id} />
                        <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" />
                      </form>
                    </div>
                  ))
                )}
                {availableRuleSets.length > 0 && (
                  <form action={addGroupRuleSetAction} className="flex flex-col gap-2 pt-2 border-t">
                    <input type="hidden" name="groupId" value={groupId} />
                    <label htmlFor="ruleSetId" className="text-xs font-medium text-muted-foreground">
                      Add a rule set
                    </label>
                    <div className="flex gap-2">
                      <select
                        id="ruleSetId"
                        name="ruleSetId"
                        required
                        className="h-9 flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm"
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Select a rule set
                        </option>
                        {availableRuleSets.map((rs) => (
                          <option key={rs.id} value={rs.id}>
                            {rs.name}
                          </option>
                        ))}
                      </select>
                      <SubmitButton label="Add" pendingLabel="Adding..." size="sm" />
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Add Agent</CardTitle>
              <CardDescription>Move an agent into this group.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={addGroupMemberAction} className="flex flex-col gap-3 md:flex-row md:items-end">
                <input type="hidden" name="groupId" value={groupId} />
                <div className="grid gap-2 flex-1">
                  <label htmlFor="agentId" className="text-sm font-medium">
                    Add Agent
                  </label>
                  <select
                    id="agentId"
                    name="agentId"
                    required
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Select an agent
                    </option>
                    {availableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {formatAgentDisplayName(agent)}
                      </option>
                    ))}
                  </select>
                </div>
                <SubmitButton label="Add Member" pendingLabel="Adding..." disabled={availableAgents.length === 0} />
              </form>
              {availableAgents.length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  No additional agents are available to add.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Members</CardTitle>
              <CardDescription>Agents currently assigned to this group.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                        This group has no members yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{formatAgentDisplayName(member)}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{member.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-normal text-[10px] uppercase">
                            {member.isAutonomous ? (
                              <>
                                <Bot className="mr-1 h-3 w-3" />
                                Autonomous
                              </>
                            ) : (
                              <>
                                <User className="mr-1 h-3 w-3" />
                                User Proxy
                              </>
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <form action={removeGroupMemberAction}>
                            <input type="hidden" name="groupId" value={groupId} />
                            <input type="hidden" name="agentId" value={member.id} />
                            <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" />
                          </form>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

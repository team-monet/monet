import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { Agent, AgentGroup } from "@monet/types";
import { formatAgentDisplayName } from "@/lib/agent-display";
import { addGroupMemberAction, removeGroupMemberAction } from "../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ArrowLeft, Bot, User, Users } from "lucide-react";

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

  let group: AgentGroup | undefined;
  let members: Agent[] = [];
  let availableAgents: Agent[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const [groupsResult, agentsResult, membersResult] = await Promise.all([
      client.listGroups(),
      client.listAgents(),
      client.listGroupMembers(groupId),
    ]);

    group = groupsResult.groups.find((g) => g.id === groupId);
    if (!group) {
      error = "Group not found.";
    } else {
      members = membersResult.members;
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
          <h1 className="text-3xl font-bold tracking-tight">Manage Group Members</h1>
          <p className="text-muted-foreground mt-1">
            Add or remove agents from this group.
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

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load group members</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" />
                {group?.name}
              </CardTitle>
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
                <Button type="submit" disabled={availableAgents.length === 0}>
                  Add Member
                </Button>
              </form>
              {availableAgents.length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  No additional agents are available to add.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
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
                                Human Proxy
                              </>
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <form action={removeGroupMemberAction}>
                            <input type="hidden" name="groupId" value={groupId} />
                            <input type="hidden" name="agentId" value={member.id} />
                            <Button type="submit" variant="outline" size="sm">
                              Remove
                            </Button>
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

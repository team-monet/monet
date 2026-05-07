"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Bot, User } from "lucide-react";
import type { Agent } from "@monet/types";
import { formatAgentDisplayName } from "@/lib/agent-display";
import { addGroupMemberAction, removeGroupMemberAction } from "../actions";
import type { GroupMemberActionState } from "../actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const initialState: GroupMemberActionState = { status: "idle" };

interface GroupMembersManagerProps {
  groupId: string;
  members: Agent[];
  availableAgents: Agent[];
}

export function GroupMembersManager({ groupId, members, availableAgents }: GroupMembersManagerProps) {
  const [addState, setAddState] = useState<GroupMemberActionState>(initialState);
  const [removeState, setRemoveState] = useState<GroupMemberActionState>(initialState);
  const [addPending, startAddTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();

  const addAction = (formData: FormData) => {
    startAddTransition(async () => {
      try {
        const result = await addGroupMemberAction(formData);
        setAddState(result);
      } catch (error) {
        setAddState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const removeAction = (formData: FormData) => {
    startRemoveTransition(async () => {
      try {
        const result = await removeGroupMemberAction(formData);
        setRemoveState(result);
      } catch (error) {
        setRemoveState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const feedbackState = removeState.status !== "idle" ? removeState : addState;

  return (
    <>
      {feedbackState.status === "success" && feedbackState.message && (
        <Alert>
          <AlertTitle>{feedbackState.action === "remove" ? "Member removed" : "Member added"}</AlertTitle>
          <AlertDescription>{feedbackState.message}</AlertDescription>
        </Alert>
      )}

      {feedbackState.status === "error" && feedbackState.message && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Member update failed</AlertTitle>
          <AlertDescription>{feedbackState.message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add Agent</CardTitle>
          <CardDescription>Move an agent into this group.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={addAction} className="flex flex-col gap-3 md:flex-row md:items-end">
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
            <SubmitButton label="Add Member" pendingLabel="Adding..." disabled={availableAgents.length === 0} pending={addPending}/>
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
                      <form action={removeAction}>
                        <input type="hidden" name="groupId" value={groupId} />
                        <input type="hidden" name="agentId" value={member.id} />
                        <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" pending={removePending} />
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
  );
}

"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, User, Users } from "lucide-react";
import { getUserOptionLabel, getUserPrimaryLabel, getUserSecondaryLabel } from "@/lib/user-display";
import {
  addUserGroupMemberAction,
  removeUserGroupMemberAction,
} from "../actions";
import type { MemberActionState } from "../actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface GroupMember {
  id: string;
  role: string;
  joinedAt: string | Date;
  email?: string | null;
  displayName?: string | null;
  externalId?: string;
}

interface TenantUser {
  id: string;
  role: string;
  email?: string | null;
  displayName?: string | null;
  externalId?: string;
}

interface UserGroupMembersManagerProps {
  userGroupId: string;
  members: GroupMember[];
  availableUsers: TenantUser[];
}

const initialState: MemberActionState = { status: "idle" };

export function UserGroupMembersManager({ userGroupId, members, availableUsers }: UserGroupMembersManagerProps) {
  const [addState, setAddState] = useState<MemberActionState>(initialState);
  const [removeState, setRemoveState] = useState<MemberActionState>(initialState);
  const [addPending, startAddTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const addAction = (formData: FormData) => {
    startAddTransition(async () => {
      try {
        setAddState(await addUserGroupMemberAction(formData));
      } catch (error) {
        setAddState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  const removeAction = (formData: FormData) => {
    startRemoveTransition(async () => {
      try {
        setRemoveState(await removeUserGroupMemberAction(formData));
      } catch (error) {
        setRemoveState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  const feedbackState = removeState.status !== "idle" ? removeState : addState;

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          Members
        </CardTitle>
        <CardDescription>Add or remove users from this access group.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedbackState.status === "success" && feedbackState.message && (
          <Alert>
            <AlertTitle>{feedbackState.action === "remove" ? "Member removed" : "Member added"}</AlertTitle>
            <AlertDescription>{feedbackState.message}</AlertDescription>
          </Alert>
        )}

        {feedbackState.status === "error" && feedbackState.message && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not update members</AlertTitle>
            <AlertDescription>{feedbackState.message}</AlertDescription>
          </Alert>
        )}

        <form action={addAction} className="flex flex-col gap-3 md:flex-row md:items-end">
          <input type="hidden" name="userGroupId" value={userGroupId} />
          <div className="grid flex-1 gap-2">
            <Label htmlFor="userId">Add User</Label>
            <select
              id="userId"
              name="userId"
              required
              disabled={availableUsers.length === 0}
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              defaultValue=""
            >
              <option value="" disabled>
                Select a user
              </option>
              {availableUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {getUserOptionLabel(user)}
                </option>
              ))}
            </select>
          </div>
          <SubmitButton label="Add Member" pendingLabel="Adding..." disabled={availableUsers.length === 0} pending={addPending} />
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No users belong to this group yet.
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{getUserPrimaryLabel(member)}</span>
                      {getUserSecondaryLabel(member) && (
                        <span className="text-xs text-muted-foreground">{getUserSecondaryLabel(member)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal">
                      <User className="mr-1 h-3 w-3" />
                      {member.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <form action={removeAction}>
                      <input type="hidden" name="userGroupId" value={userGroupId} />
                      <input type="hidden" name="userId" value={member.id} />
                      <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" pending={removePending}/>
                    </form>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

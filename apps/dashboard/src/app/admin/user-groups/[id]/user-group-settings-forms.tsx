"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Settings2 } from "lucide-react";
import {
  saveUserGroupAgentPermissionsAction,
  updateUserGroupAction,
} from "../actions";
import { initialUserGroupActionState } from "../actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ActionMessage({ title, status, message }: { title: string; status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle" || !message) return null;
  return (
    <Alert variant={status === "error" ? "destructive" : "default"}>
      {status === "error" && <AlertTriangle className="h-4 w-4" />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function EditUserGroupDialog({ userGroupId, name, description }: { userGroupId: string; name: string; description: string }) {
  const [state, setState] = useState(initialUserGroupActionState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await updateUserGroupAction(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Settings2 className="mr-2 h-4 w-4" />
          Edit Group
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit User Group</DialogTitle>
          <DialogDescription>Update the name and description used for access management.</DialogDescription>
        </DialogHeader>
        <ActionMessage
          title={state.status === "success" ? "User group updated" : "Could not update user group"}
          status={state.status}
          message={state.message}
        />
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="userGroupId" value={userGroupId} />
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required defaultValue={name} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" defaultValue={description} />
          </div>
          <DialogFooter>
            <SubmitButton label="Save changes" pendingLabel="Saving..." pending={pending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type TenantAgentGroup = { id: string; name: string; description: string | null };

export function UserGroupPermissionsForm({ userGroupId, tenantAgentGroups, allowedAgentGroupIds }: { userGroupId: string; tenantAgentGroups: TenantAgentGroup[]; allowedAgentGroupIds: Set<string> }) {
  const [state, setState] = useState(initialUserGroupActionState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await saveUserGroupAgentPermissionsAction(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  return (
    <>
      <ActionMessage
        title={state.status === "success" ? "Permissions saved" : "Could not update permissions"}
        status={state.status}
        message={state.message}
      />
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="userGroupId" value={userGroupId} />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tenantAgentGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent groups exist yet. Create agent groups first.</p>
          ) : (
            tenantAgentGroups.map((agentGroup) => (
              <label key={agentGroup.id} className="flex items-start gap-3 rounded-md border p-3 text-sm">
                <input
                  type="checkbox"
                  name="agentGroupId"
                  value={agentGroup.id}
                  defaultChecked={allowedAgentGroupIds.has(agentGroup.id)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span className="font-medium">{agentGroup.name}</span>
                  <span className="text-xs text-muted-foreground">{agentGroup.description || "No description"}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <SubmitButton label="Save Permissions" pendingLabel="Saving..." disabled={tenantAgentGroups.length === 0} pending={pending} />
      </form>
    </>
  );
}

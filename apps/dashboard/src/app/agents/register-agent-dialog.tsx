"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, KeyRound, Plus, User } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AgentCredentialHandoff } from "./agent-credential-handoff";
import { registerAgentAction } from "./actions";
import {
  initialRegisterAgentFormState,
  type RegisterAgentFormState,
} from "./actions-shared";

type GroupOption = {
  id: string;
  name: string;
};

type UserOption = {
  id: string;
  externalId: string;
  email: string | null;
};

function RegistrationSuccess({
  state,
  onRegisterAnother,
  onClose,
}: {
  state: Extract<RegisterAgentFormState, { status: "success" }>;
  onRegisterAnother: () => void;
  onClose: () => void;
}) {
  return (
    <AgentCredentialHandoff
      apiKey={state.apiKey}
      mcpUrl={state.mcpUrl}
      mcpConfig={state.mcpConfig}
      footer={(
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onRegisterAnother}>
              Register Another
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link href={`/agents/${state.agentId}`}>View Agent</Link>
            </Button>
          </div>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      )}
    />
  );
}

function RegisterAgentForm({
  availableGroups,
  bindableUsers,
  isAdmin,
  onClose,
  onReset,
}: {
  availableGroups: GroupOption[];
  bindableUsers: UserOption[];
  isAdmin: boolean;
  onClose: () => void;
  onReset: () => void;
}) {
  const router = useRouter();
  const [agentType, setAgentType] = useState<"human_proxy" | "autonomous">("human_proxy");
  const [state, formAction] = useActionState(registerAgentAction, initialRegisterAgentFormState);
  const hasGroupOptions = availableGroups.length > 0;
  const requiresUserBinding = isAdmin && agentType === "human_proxy";
  const missingUserOptions = requiresUserBinding && bindableUsers.length === 0;

  useEffect(() => {
    if (state.status === "success") {
      startTransition(() => {
        router.refresh();
      });
    }
  }, [router, state.status]);

  if (state.status === "success") {
    return (
      <RegistrationSuccess
        state={state}
        onRegisterAnother={onReset}
        onClose={onClose}
      />
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Registration failed</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" name="name" required placeholder="e.g. Claude, Cursor" />
      </div>

      {isAdmin && (
        <div className="grid gap-2">
          <Label htmlFor="agent-type">Type</Label>
          <select
            id="agent-type"
            name="type"
            className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={agentType}
            onChange={(event) => {
              const nextType = event.target.value === "autonomous" ? "autonomous" : "human_proxy";
              setAgentType(nextType);
            }}
          >
            <option value="human_proxy">Human Proxy</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </div>
      )}

      {requiresUserBinding && (
        <div className="grid gap-2">
          <Label htmlFor="agent-user">User Binding</Label>
          <select
            id="agent-user"
            name="userId"
            required
            disabled={bindableUsers.length === 0}
            className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            defaultValue=""
          >
            <option value="" disabled>
              Select a user
            </option>
            {bindableUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email ?? user.externalId}
              </option>
            ))}
          </select>
          {missingUserOptions && (
            <p className="text-xs text-muted-foreground">
              No tenant users are available to bind. Have a user sign in first.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="agent-group">Group</Label>
        <select
          id="agent-group"
          name="groupId"
          required
          disabled={!hasGroupOptions}
          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          defaultValue=""
        >
          <option value="" disabled>
            Select a group
          </option>
          {availableGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        {!hasGroupOptions && (
          <p className="text-xs text-muted-foreground">
            No groups are available. Create a group first or ask a tenant admin to assign one.
          </p>
        )}
      </div>

      <DialogFooter>
        <SubmitButton 
          label="Register Agent" 
          pendingLabel="Registering..." 
          disabled={!hasGroupOptions || missingUserOptions} 
        />
      </DialogFooter>
    </form>
  );
}

export default function RegisterAgentDialog({
  availableGroups,
  bindableUsers,
  isAdmin,
}: {
  availableGroups: GroupOption[];
  bindableUsers: UserOption[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  function closeDialog() {
    setOpen(false);
    setFormKey((current) => current + 1);
  }

  function resetForm() {
    setFormKey((current) => current + 1);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setFormKey((current) => current + 1);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          Register Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Register Agent</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? "Create a Human Proxy or Autonomous agent and issue a new API key."
              : "Create a Human Proxy agent bound to your account and issue a new API key."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 text-sm md:grid-cols-2">
          <div className="flex items-start gap-2">
            {isAdmin ? <Bot className="mt-0.5 h-4 w-4" /> : <User className="mt-0.5 h-4 w-4" />}
            <div>
              <p className="font-medium">Role-aware registration</p>
              <p className="text-muted-foreground">
                {isAdmin
                  ? "Tenant admins can create both Human Proxy and Autonomous agents."
                  : "Normal users can only create Human Proxy agents bound to themselves."}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <KeyRound className="mt-0.5 h-4 w-4" />
            <div>
              <p className="font-medium">One-time key delivery</p>
              <p className="text-muted-foreground">
                The raw API key is returned once after registration and will not be shown again.
              </p>
            </div>
          </div>
        </div>

        <RegisterAgentForm
          key={formKey}
          availableGroups={availableGroups}
          bindableUsers={bindableUsers}
          isAdmin={isAdmin}
          onClose={closeDialog}
          onReset={resetForm}
        />
      </DialogContent>
    </Dialog>
  );
}

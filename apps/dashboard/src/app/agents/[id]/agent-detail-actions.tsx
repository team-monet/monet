"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { AgentCredentialHandoff } from "@/app/agents/agent-credential-handoff";
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
import {
  regenerateAgentTokenAction,
  revokeAgentAction,
  unrevokeAgentAction,
} from "./actions";
import {
  initialAgentMutationActionState,
  initialAgentTokenActionState,
  type AgentMutationActionState,
  type AgentTokenActionState,
} from "./actions-shared";

function MutationError({ state }: { state: AgentMutationActionState | AgentTokenActionState }) {
  if (state.status !== "error") {
    return null;
  }

  return (
    <Alert variant="destructive">
      <AlertTitle>Action failed</AlertTitle>
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  );
}

function RegenerateTokenDialogInner({
  agentId,
  isRevoked,
  onReset,
}: {
  agentId: string;
  isRevoked: boolean;
  onReset: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(
    regenerateAgentTokenAction,
    initialAgentTokenActionState,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          if (state.status === "success") {
            startTransition(() => {
              router.refresh();
            });
          }
          onReset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <KeyRound className="h-4 w-4" />
          Regenerate Token
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Regenerate Token</DialogTitle>
          <DialogDescription>
            Rotate the API key for this agent and invalidate all current MCP sessions.
          </DialogDescription>
        </DialogHeader>

        {state.status === "success" ? (
          <AgentCredentialHandoff
            apiKey={state.apiKey}
            mcpUrl={state.mcpUrl}
            mcpConfig={state.mcpConfig}
            title="API key rotated"
            description="This replacement key is shown once. Existing sessions were disconnected."
            footer={(
              <DialogFooter>
                <Button type="button" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            )}
          />
        ) : (
          <form action={formAction} className="grid gap-4">
            <input type="hidden" name="agentId" value={agentId} />
            <Alert>
              <AlertTitle>One-time credential handoff</AlertTitle>
              <AlertDescription>
                The current token stops working immediately. Store the replacement key before closing this dialog.
              </AlertDescription>
            </Alert>
            {isRevoked && (
              <Alert>
                <AlertTitle>Agent is currently revoked</AlertTitle>
                <AlertDescription>
                  Regenerating the token does not restore access. A tenant admin still needs to unrevoke this agent.
                </AlertDescription>
              </Alert>
            )}
            <MutationError state={state} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton label="Regenerate Token" pendingLabel="Regenerating..." />
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RegenerateTokenDialog(props: {
  agentId: string;
  isRevoked: boolean;
}) {
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <RegenerateTokenDialogInner
      key={instanceKey}
      {...props}
      onReset={() => setInstanceKey((current) => current + 1)}
    />
  );
}

function AdminMutationDialogInner({
  agentId,
  triggerLabel,
  title,
  description,
  confirmLabel,
  pendingLabel,
  action,
  triggerVariant,
  confirmVariant,
  onReset,
}: {
  agentId: string;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  action: (
    previousState: AgentMutationActionState,
    formData: FormData,
  ) => Promise<AgentMutationActionState>;
  triggerVariant: "destructive" | "outline";
  confirmVariant: "destructive" | "default";
  onReset: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, initialAgentMutationActionState);

  useEffect(() => {
    if (state.status === "success") {
      setOpen(false);
      onReset();
      startTransition(() => {
        router.refresh();
      });
    }
  }, [onReset, router, state.status]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          onReset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant}>
          {triggerLabel === "Revoke Agent" ? (
            <ShieldAlert className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="agentId" value={agentId} />
          <MutationError state={state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton
              label={confirmLabel}
              pendingLabel={pendingLabel}
              variant={confirmVariant}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AdminMutationDialog(
  props: Omit<Parameters<typeof AdminMutationDialogInner>[0], "onReset">,
) {
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <AdminMutationDialogInner
      key={instanceKey}
      {...props}
      onReset={() => setInstanceKey((current) => current + 1)}
    />
  );
}

export default function AgentDetailActions({
  agentId,
  canRegenerate,
  isAdmin,
  isRevoked,
}: {
  agentId: string;
  canRegenerate: boolean;
  isAdmin: boolean;
  isRevoked: boolean;
}) {
  if (!canRegenerate && !isAdmin) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canRegenerate && <RegenerateTokenDialog agentId={agentId} isRevoked={isRevoked} />}
      {isAdmin && (
        isRevoked ? (
          <AdminMutationDialog
            agentId={agentId}
            triggerLabel="Restore Agent"
            title="Restore Agent"
            description="Clear the revoked state for this agent so it can connect again with a valid token."
            confirmLabel="Restore Agent"
            pendingLabel="Restoring..."
            action={unrevokeAgentAction}
            triggerVariant="outline"
            confirmVariant="default"
          />
        ) : (
          <AdminMutationDialog
            agentId={agentId}
            triggerLabel="Revoke Agent"
            title="Revoke Agent"
            description="This immediately disconnects active MCP sessions and blocks future requests until the agent is restored."
            confirmLabel="Revoke Agent"
            pendingLabel="Revoking..."
            action={revokeAgentAction}
            triggerVariant="destructive"
            confirmVariant="destructive"
          />
        )
      )}
    </div>
  );
}

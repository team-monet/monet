"use client";

import { useState, useTransition } from "react";
import { updateTenantSettingsAction } from "./actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";

type ActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

const initialState: ActionState = {
  status: "idle",
  message: "",
};

const MAX_INSTRUCTIONS_LENGTH = 4000;
const WARNING_THRESHOLD = 3500;

export function SettingsForm({
  initialTenantAgentInstructions,
}: {
  initialTenantAgentInstructions: string | null;
}) {
  const [instructions, setInstructions] = useState(
    initialTenantAgentInstructions ?? "",
  );
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();

  const characterCount = instructions.length;
  const showBudgetWarning = characterCount > WARNING_THRESHOLD;

  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await updateTenantSettingsAction(formData));
      } catch (error) {
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred",
        });
      }
    });
  };

  return (
    <div className="grid gap-4">
      {state.status !== "idle" && state.message ? (
        <Alert variant={state.status === "error" ? "destructive" : "default"}>
          {state.status === "error" && <AlertTriangle className="h-4 w-4" />}
          <AlertTitle>
            {state.status === "success"
              ? "Instructions saved"
              : "Could not save instructions"}
          </AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <form action={formAction} className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="tenantAgentInstructions">Tenant agent instructions</Label>
          <Textarea
            id="tenantAgentInstructions"
            name="tenantAgentInstructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            rows={12}
            placeholder="Add optional instructions for all agents in this tenant including introduction of the tenant."
          />
          <p className="text-xs text-muted-foreground">
            {characterCount} / {MAX_INSTRUCTIONS_LENGTH} characters
          </p>
          {showBudgetWarning ? (
            <p className="text-xs text-muted-foreground">
              Instructions may be truncated if the total handshake budget is
              exceeded by base governance instructions and active rules.
            </p>
          ) : null}
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

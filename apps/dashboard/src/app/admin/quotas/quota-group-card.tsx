"use client";

import { useState, useTransition } from "react";
import { AgentGroup, QuotaUtilization } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { AlertTriangle, Database, Save, Users, Zap } from "lucide-react";
import {
  clearGroupQuotaAction,
  updateGroupQuotaAction,
} from "./actions";
import { initialQuotaActionState } from "./actions-shared";

type QuotaGroupCardProps = {
  group: AgentGroup;
  usage?: QuotaUtilization;
};

export function QuotaGroupCard({ group, usage }: QuotaGroupCardProps) {
  const [updateState, setUpdateState] = useState(initialQuotaActionState);
  const [clearState, setClearState] = useState(initialQuotaActionState);
  const [updatePending, startUpdateTransition] = useTransition();
  const [clearPending, startClearTransition] = useTransition();
  const updateAction = (formData: FormData) => {
    startUpdateTransition(async () => {
      try {
        setUpdateState(await updateGroupQuotaAction(formData));
      } catch (error) {
        setUpdateState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  const clearAction = (formData: FormData) => {
    startClearTransition(async () => {
      try {
        setClearState(await clearGroupQuotaAction(formData));
      } catch (error) {
        setClearState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  const state = clearState.status !== "idle" ? clearState : updateState;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-primary mb-1">
          <Users className="h-4 w-4" />
          <span className="text-xs font-bold uppercase tracking-wider">Agent Group</span>
        </div>
        <CardTitle>{group.name}</CardTitle>
        <CardDescription className="line-clamp-1">{group.description || "No description provided."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status !== "idle" ? (
          <Alert variant={state.status === "error" ? "destructive" : "default"}>
            {state.status === "error" ? <AlertTriangle className="h-4 w-4" /> : null}
            <AlertTitle>{state.status === "error" ? "Could not update quota" : "Quota updated"}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5" />
              Current Quota
            </span>
            <span className="font-medium">
              {group.memoryQuota === null
                ? "Default (10,000 per agent)"
                : group.memoryQuota === 0
                  ? "Unlimited"
                  : `${group.memoryQuota.toLocaleString()} Entries`}
            </span>
          </div>
          {usage ? (
            <p className="text-[11px] text-muted-foreground">
              Busiest agent: <span className="font-medium">{usage.maxAgentCurrent.toLocaleString()}</span>
              {usage.effectiveQuotaPerAgent === 0
                ? " entries (unlimited)"
                : ` / ${usage.effectiveQuotaPerAgent.toLocaleString()} entries (${Math.round((usage.maxAgentCurrent / usage.effectiveQuotaPerAgent) * 100)}%)`}
              {" · "}
              {usage.current.toLocaleString()} total in group
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">Usage data loading...</p>
          )}
        </div>

        <form action={updateAction} className="space-y-3 pt-2">
          <input type="hidden" name="groupId" value={group.id} />
          <div className="grid gap-1.5">
            <Label htmlFor={`quota-${group.id}`} className="text-xs">Update Quota (Entries)</Label>
            <div className="flex gap-2">
              <Input
                id={`quota-${group.id}`}
                type="number"
                name="quota"
                min={1}
                step={1}
                required
                defaultValue={group.memoryQuota || ""}
                placeholder={group.memoryQuota != null ? "Enter a new quota" : "e.g. 1000"}
                className="h-9"
              />
              <SubmitButton size="sm" type="submit" className="h-9 px-3" pending={updatePending}>
                <Save className="h-4 w-4" />
                <span className="sr-only">Save</span>
              </SubmitButton>
            </div>
          </div>
        </form>

        {group.memoryQuota !== 0 ? (
          <form action={clearAction} className="pt-1">
            <input type="hidden" name="groupId" value={group.id} />
            <SubmitButton
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              label="Clear quota (unlimited)"
              pendingLabel="Clearing..."
              pending={clearPending}
            />
          </form>
        ) : null}
      </CardContent>
      <CardFooter className="bg-muted/30 border-t py-3 flex justify-between">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3" />
          Quota changes apply immediately
        </div>
      </CardFooter>
    </Card>
  );
}

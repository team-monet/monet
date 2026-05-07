"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { RuleSet } from "@monet/types";
import { addGroupRuleSetAction, removeGroupRuleSetAction } from "../actions";
import { initialGroupActionState } from "../actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Layers } from "lucide-react";

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

function RemoveRuleSetForm({ groupId, ruleSet }: { groupId: string; ruleSet: RuleSet }) {
  const [state, setState] = useState(initialGroupActionState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await removeGroupRuleSetAction(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  return (
    <div key={ruleSet.id} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/admin/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">
            {ruleSet.name}
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">
            {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"}
          </p>
        </div>
        <form action={formAction}>
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="ruleSetId" value={ruleSet.id} />
          <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" pending={pending} />
        </form>
      </div>
      <ActionMessage
        title={state.status === "success" ? "Rule set removed" : "Rule set update failed"}
        status={state.status}
        message={state.message}
      />
    </div>
  );
}

function AddRuleSetForm({ groupId, availableRuleSets }: { groupId: string; availableRuleSets: RuleSet[] }) {
  const [state, setState] = useState(initialGroupActionState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await addGroupRuleSetAction(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  return (
    <>
      <ActionMessage
        title={state.status === "success" ? "Rule set added" : "Rule set update failed"}
        status={state.status}
        message={state.message}
      />
      <form action={formAction} className="flex flex-col gap-2 pt-2 border-t">
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
          <SubmitButton label="Add" pendingLabel="Adding..." size="sm" pending={pending} />
        </div>
      </form>
    </>
  );
}

export function GroupRuleSetsManager({ groupId, appliedRuleSets, availableRuleSets }: { groupId: string; appliedRuleSets: RuleSet[]; availableRuleSets: RuleSet[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4" />
          Applied Rule Sets
        </CardTitle>
        <CardDescription>These rule sets are inherited automatically by agents in this group.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {appliedRuleSets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rule sets are attached to this group.</p>
        ) : (
          appliedRuleSets.map((ruleSet) => <RemoveRuleSetForm key={ruleSet.id} groupId={groupId} ruleSet={ruleSet} />)
        )}
        {availableRuleSets.length > 0 && <AddRuleSetForm groupId={groupId} availableRuleSets={availableRuleSets} />}
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import type { Rule, RuleSet } from "@monet/types";
import { addRuleToSetAction, deleteRuleSetAction, removeRuleFromSetAction } from "../../actions";
import { initialActionState } from "../../actions-shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Layers, Plus, Trash2 } from "lucide-react";

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

function useFormActionState<T extends { status: "idle" | "success" | "error"; message: string }>(action: (formData: FormData) => Promise<T>, initialState: T) {
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await action(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" } as T);
      }
    });
  };
  return [state, pending, formAction] as const;
}

function RemoveRuleForm({ ruleSetId, ruleId, returnTo }: { ruleSetId: string; ruleId: string; returnTo: string }) {
  const [state, pending, formAction] = useFormActionState(removeRuleFromSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule removed" : "Rule set update failed"} status={state.status} message={state.message} />
      <form action={formAction}>
        <input type="hidden" name="ruleSetId" value={ruleSetId} />
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <SubmitButton label="Remove" pendingLabel="Removing..." variant="ghost" size="sm" pending={pending} />
      </form>
    </>
  );
}

function AddRuleForm({ ruleSetId, returnTo, availableRules }: { ruleSetId: string; returnTo: string; availableRules: Rule[] }) {
  const [state, pending, formAction] = useFormActionState(addRuleToSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule added" : "Rule set update failed"} status={state.status} message={state.message} />
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="ruleSetId" value={ruleSetId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div className="grid gap-2">
          <Label htmlFor="ruleId">Available Rules</Label>
          <select
            id="ruleId"
            name="ruleId"
            className="h-10 rounded-md border bg-background px-3 text-sm"
            defaultValue={availableRules[0]?.id ?? ""}
            disabled={availableRules.length === 0}
          >
            {availableRules.length === 0 ? (
              <option value="">No available rules</option>
            ) : (
              availableRules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))
            )}
          </select>
        </div>
        <SubmitButton label="Add Rule" pendingLabel="Adding..." disabled={availableRules.length === 0} pending={pending} />
      </form>
    </>
  );
}

function DeleteRuleSetForm({ ruleSetId }: { ruleSetId: string }) {
  const [state, pending,formAction] = useFormActionState(deleteRuleSetAction, initialActionState);
  return (
    <>
      <ActionMessage title={state.status === "success" ? "Rule set deleted" : "Rule set operation failed"} status={state.status} message={state.message} />
      <form action={formAction}>
        <input type="hidden" name="ruleSetId" value={ruleSetId} />
        <input type="hidden" name="returnTo" value="/admin/rules" />
        <SubmitButton pendingLabel="Deleting..." variant="destructive" pending={pending}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete Rule Set
        </SubmitButton>
      </form>
    </>
  );
}

export function RuleSetDetailClient({ ruleSet, includedRules, availableRules, isAdmin }: { ruleSet: RuleSet; includedRules: Rule[]; availableRules: Rule[]; isAdmin: boolean }) {
  const returnTo = `/admin/rules/sets/${ruleSet.id}`;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            {ruleSet.name}
          </CardTitle>
          <CardDescription>
            {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"} currently assigned.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-muted-foreground font-mono">{ruleSet.id}</div>
          <div className="space-y-2">
            {includedRules.length === 0 ? (
              <p className="text-sm text-muted-foreground">This set does not contain any rules yet.</p>
            ) : (
              includedRules.map((rule) => (
                <div key={rule.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">{rule.name}</p>
                    <p className="text-xs leading-5 whitespace-normal break-words text-muted-foreground line-clamp-3">{rule.description}</p>
                    <Badge variant="outline" className="text-[10px]">
                      Updated {new Date(rule.updatedAt).toLocaleDateString()}
                    </Badge>
                  </div>
                  {isAdmin && <RemoveRuleForm ruleSetId={ruleSet.id} ruleId={rule.id} returnTo={returnTo} />}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Add Rule to Set
              </CardTitle>
              <CardDescription>Select an existing rule to add to this rule set.</CardDescription>
            </CardHeader>
            <CardContent>
              <AddRuleForm ruleSetId={ruleSet.id} returnTo={returnTo} availableRules={availableRules} />
            </CardContent>
          </Card>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Delete Rule Set</CardTitle>
              <CardDescription>This removes the set and its rule associations.</CardDescription>
            </CardHeader>
            <CardFooter>
              <DeleteRuleSetForm ruleSetId={ruleSet.id} />
            </CardFooter>
          </Card>
        </>
      )}
    </>
  );
}

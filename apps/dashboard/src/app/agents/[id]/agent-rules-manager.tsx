"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle, Scale } from "lucide-react";
import type { RuleSet } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { attachRuleSetToAgentAction, detachRuleSetFromAgentAction } from "./actions";
import { initialRuleSetMutationActionState } from "./actions-shared";

interface AgentRulesManagerProps {
  agentId: string;
  sessionUserId?: string;
  canManageRuleSets: boolean;
  isOwnedBySessionUser: boolean;
  attachedRuleSets: RuleSet[];
  availableRuleSets: RuleSet[];
}

export function AgentRulesManager({
  agentId,
  sessionUserId,
  canManageRuleSets,
  isOwnedBySessionUser,
  attachedRuleSets,
  availableRuleSets,
}: AgentRulesManagerProps) {
  const [attachState, setAttachState] = useState(initialRuleSetMutationActionState);
  const [detachState, setDetachState] = useState(initialRuleSetMutationActionState);
  const [attachPending, startAttachTransition] = useTransition();
  const [detachPending, startDetachTransition] = useTransition();
  const attachAction = (formData: FormData) => {
    startAttachTransition(async () => {
      try {
        setAttachState(await attachRuleSetToAgentAction(formData));
      } catch (error) {
        setAttachState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };
  const detachAction = (formData: FormData) => {
    startDetachTransition(async () => {
      try {
        setDetachState(await detachRuleSetFromAgentAction(formData));
      } catch (error) {
        setDetachState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const feedbackState = detachState.status !== "idle" ? detachState : attachState;

  return (
    <>
      {feedbackState.status === "success" && feedbackState.message && (
        <Alert>
          <AlertTitle>Rule set updated</AlertTitle>
          <AlertDescription>{feedbackState.message}</AlertDescription>
        </Alert>
      )}

      {feedbackState.status === "error" && feedbackState.message && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Rule set update failed</AlertTitle>
          <AlertDescription>{feedbackState.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              Direct Rule Sets
            </CardTitle>
            <CardDescription>
              Rule sets currently attached directly to this agent. Group-inherited guidance is applied separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {attachedRuleSets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No direct rule sets are attached to this agent.</p>
            ) : (
              attachedRuleSets.map((ruleSet) => (
                <div key={ruleSet.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div className="space-y-1">
                    {ruleSet.ownerUserId ? (
                      ruleSet.ownerUserId === sessionUserId ? (
                        <Link href={`/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">
                          {ruleSet.name}
                        </Link>
                      ) : (
                        <p className="font-medium">{ruleSet.name}</p>
                      )
                    ) : (
                      <Link href={`/admin/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">
                        {ruleSet.name}
                      </Link>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"} · {ruleSet.ownerUserId ? "Personal" : "Shared"}
                    </p>
                  </div>
                  {canManageRuleSets && (
                    <form action={detachAction}>
                      <input type="hidden" name="agentId" value={agentId} />
                      <input type="hidden" name="ruleSetId" value={ruleSet.id} />
                      <SubmitButton label="Detach" pendingLabel="Detaching..." variant="outline" size="sm" pending={detachPending} />
                    </form>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attach Rule Set</CardTitle>
            <CardDescription>
              {canManageRuleSets
                ? isOwnedBySessionUser
                  ? "Apply either a shared rule set or one of your personal rule sets to this agent."
                  : "Apply a shared rule set from the tenant catalog to this agent."
                : "Only tenant admins or the agent owner can modify direct rule sets."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManageRuleSets ? (
              <>
                <form action={attachAction} className="space-y-3">
                  <input type="hidden" name="agentId" value={agentId} />
                  <div className="grid gap-2">
                    <label htmlFor="ruleSetId" className="text-sm font-medium">
                      Available rule sets
                    </label>
                    <select
                      id="ruleSetId"
                      name="ruleSetId"
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                      defaultValue={availableRuleSets[0]?.id ?? ""}
                      disabled={availableRuleSets.length === 0}
                    >
                      {availableRuleSets.length === 0 ? (
                        <option value="">No more rule sets available</option>
                      ) : (
                        availableRuleSets.map((ruleSet) => (
                          <option key={ruleSet.id} value={ruleSet.id}>
                            {ruleSet.name} {ruleSet.ownerUserId ? "(Personal)" : "(Shared)"}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <SubmitButton
                    label="Attach Rule Set"
                    pendingLabel="Attaching..."
                    className="w-full"
                    disabled={availableRuleSets.length === 0}
                    pending={attachPending}
                  />
                </form>
                <div className="flex flex-col items-start gap-2">
                  {isOwnedBySessionUser && (
                    <Button asChild variant="ghost" className="px-0">
                      <Link href="/rules">Manage personal rules</Link>
                    </Button>
                  )}
                  <Button asChild variant="ghost" className="px-0">
                    <Link href="/admin/rules">Browse shared rules</Link>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Rule sets can be reviewed in the shared rules catalog.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

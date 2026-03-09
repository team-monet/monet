import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { Rule, RuleSet } from "@monet/types";
import { addRuleToSetAction, deleteRuleSetAction, removeRuleFromSetAction } from "../../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ArrowLeft, AlertTriangle, Layers, Plus, Trash2 } from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RuleSetDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  await requireAdmin();

  const returnTo = `/admin/rules/sets/${id}`;
  const setError = getSingleParam(query.setError);
  const ruleAdded = getSingleParam(query.ruleAdded) === "1";
  const ruleRemoved = getSingleParam(query.ruleRemoved) === "1";

  let rules: Rule[] = [];
  let ruleSet: RuleSet | null = null;
  let error = "";

  try {
    const client = await getApiClient();
    const [rulesResult, ruleSetsResult] = await Promise.all([
      client.listRules(),
      client.listRuleSets(),
    ]);
    rules = rulesResult.rules;
    ruleSet = ruleSetsResult.ruleSets.find((candidate) => candidate.id === id) ?? null;
    if (!ruleSet) {
      error = "Rule set not found.";
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "Failed to load rule set";
  }

  const includedRules = ruleSet ? rules.filter((rule) => ruleSet.ruleIds.includes(rule.id)) : [];
  const availableRules = ruleSet ? rules.filter((rule) => !ruleSet.ruleIds.includes(rule.id)) : [];

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/rules">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Rules
          </Link>
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load rule set</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <>
          {ruleAdded && (
            <Alert>
              <AlertTitle>Rule added</AlertTitle>
              <AlertDescription>The rule was added to this set.</AlertDescription>
            </Alert>
          )}

          {ruleRemoved && (
            <Alert>
              <AlertTitle>Rule removed</AlertTitle>
              <AlertDescription>The rule was removed from this set.</AlertDescription>
            </Alert>
          )}

          {setError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Rule set update failed</AlertTitle>
              <AlertDescription>{setError}</AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                {ruleSet!.name}
              </CardTitle>
              <CardDescription>
                {ruleSet!.ruleIds.length} {ruleSet!.ruleIds.length === 1 ? "rule" : "rules"} currently assigned.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground font-mono">{ruleSet!.id}</div>

              <div className="space-y-2">
                {includedRules.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This set does not contain any rules yet.</p>
                ) : (
                  includedRules.map((rule) => (
                    <div key={rule.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">{rule.name}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2">{rule.description}</p>
                        <Badge variant="outline" className="text-[10px]">Updated {new Date(rule.updatedAt).toLocaleDateString()}</Badge>
                      </div>
                      <form action={removeRuleFromSetAction}>
                        <input type="hidden" name="ruleSetId" value={ruleSet!.id} />
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton label="Remove" pendingLabel="Removing..." variant="ghost" size="sm" />
                      </form>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Add Rule to Set
              </CardTitle>
              <CardDescription>Select an existing rule to add to this rule set.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={addRuleToSetAction} className="space-y-3">
                <input type="hidden" name="ruleSetId" value={ruleSet!.id} />
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
                <SubmitButton label="Add Rule" pendingLabel="Adding..." disabled={availableRules.length === 0} />
              </form>
            </CardContent>
          </Card>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Delete Rule Set</CardTitle>
              <CardDescription>This removes the set and its rule associations.</CardDescription>
            </CardHeader>
            <CardFooter>
              <form action={deleteRuleSetAction}>
                <input type="hidden" name="ruleSetId" value={ruleSet!.id} />
                <input type="hidden" name="returnTo" value="/admin/rules" />
                <SubmitButton pendingLabel="Deleting..." variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Rule Set
                </SubmitButton>
              </form>
            </CardFooter>
          </Card>
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Rule, RuleSet } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { RuleSetDetailClient } from "./rule-set-detail-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PersonalRuleSetDetailPage({ params }: PageProps) {
  await requireAuth();
  const { id } = await params;

  let rules: Rule[] = [];
  let ruleSet: RuleSet | null = null;
  let error = "";

  try {
    const client = await getApiClient();
    const [rulesResult, ruleSetsResult] = await Promise.all([client.listPersonalRules(), client.listPersonalRuleSets()]);
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
          <Link href="/rules">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to My Rules
          </Link>
        </Button>
      </div>

      {error || !ruleSet ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load rule set</AlertTitle>
          <AlertDescription>{error || "Rule set not found."}</AlertDescription>
        </Alert>
      ) : (
        <RuleSetDetailClient ruleSet={ruleSet} includedRules={includedRules} availableRules={availableRules} />
      )}
    </div>
  );
}

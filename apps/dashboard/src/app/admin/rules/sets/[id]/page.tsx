import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Rule, RuleSet } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { RuleSetDetailClient } from "./rule-set-detail-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RuleSetDetailPage({ params }: PageProps) {
  const [{ id }, session] = await Promise.all([params, requireAuth()]);
  const sessionUser = session.user as { role?: string | null };
  const isAdmin = sessionUser.role === "tenant_admin";

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
        <RuleSetDetailClient
          ruleSet={ruleSet!}
          includedRules={includedRules}
          availableRules={availableRules}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}

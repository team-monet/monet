import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Rule, RuleSet } from "@monet/types";
import { RulesClient } from "./rules-client";

export default async function AdminRulesPage() {
  const session = await requireAuth();
  const sessionUser = session.user as { role?: string | null };
  const isAdmin = sessionUser.role === "tenant_admin";
  
  let rules: Rule[] = [];
  let ruleSets: RuleSet[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const [rulesResult, ruleSetsResult] = await Promise.all([
      client.listRules(),
      client.listRuleSets(),
    ]);
    rules = rulesResult.rules;
    ruleSets = ruleSetsResult.ruleSets;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <RulesClient rules={rules} ruleSets={ruleSets} isAdmin={isAdmin} error={error} />
    </div>
  );
}

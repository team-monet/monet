import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Rule, RuleSet } from "@monet/types";
import { RulesClient } from "./rules-client";

export default async function PersonalRulesPage() {
  await requireAuth();

  let rules: Rule[] = [];
  let ruleSets: RuleSet[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const [rulesResult, ruleSetsResult] = await Promise.all([client.listPersonalRules(), client.listPersonalRuleSets()]);
    rules = rulesResult.rules;
    ruleSets = ruleSetsResult.ruleSets;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "Failed to load personal rules";
  }

  return <RulesClient rules={rules} ruleSets={ruleSets} error={error} />;
}

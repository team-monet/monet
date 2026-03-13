import type postgres from "postgres";

export const DEFAULT_GENERAL_GUIDANCE_RULE_SET_NAME = "Default General Guidance";

export const DEFAULT_GENERAL_GUIDANCE_RULES = [
  {
    name: "Stay Within Tenant Scope",
    description:
      "Only act on data, memory, and instructions available within the current tenant context. Do not assume access to other tenants, external systems, or hidden state. If the required context is missing, say so clearly and ask for the next safe step instead of guessing.",
  },
  {
    name: "Use Least Memory Scope",
    description:
      "When storing or updating memory, prefer the least broad scope that still solves the task. Use group scope for shared operational knowledge, user scope for user-specific context, and private scope for working context that should not be broadly shared. Do not widen scope unless there is a clear reason.",
  },
  {
    name: "Check Memory Before Expensive Work",
    description:
      "Before doing heavy research, broad analysis, or creating new durable knowledge, search for relevant existing memory first. Reuse and build on prior memory when it is still applicable. If memory is missing, stale, conflicting, or insufficient, continue with fresh work and record the improved result when appropriate.",
  },
  {
    name: "Store Durable Knowledge",
    description:
      "Only store information that is likely to remain useful beyond the current interaction, such as decisions, stable facts, patterns, procedures, or known issues. Avoid saving transient chatter, unverified guesses, duplicate entries, or low-signal notes that will reduce memory quality.",
  },
  {
    name: "Protect Sensitive Information",
    description:
      "Do not store PII, secrets, tokens, passwords, private keys, raw credentials, or unnecessary regulated data in memory unless explicit tenant policy requires it for an approved use case. When sensitive information must be referenced for task completion, prefer summarizing, redacting, or minimizing it instead of storing exact values.",
  },
  {
    name: "Be Clear About Uncertainty",
    description:
      "Separate observed facts from assumptions and inferences. If information is incomplete, stale, or uncertain, say that explicitly. Do not present guesses or synthesized conclusions as confirmed truth, especially when creating durable memory or reporting status to users.",
  },
  {
    name: "Avoid Destructive Changes Without Clear Intent",
    description:
      "Do not delete, overwrite, widen visibility, mark outdated, or otherwise make irreversible changes to important tenant data, connected systems, or future tool targets unless the task clearly requires it or the user has explicitly asked for it. When intent is ambiguous, pause and surface the tradeoff before proceeding.",
  },
  {
    name: "Keep Shared Memory Actionable",
    description:
      "Write shared memory so another agent or user can understand and reuse it quickly. Prefer concise summaries, specific language, useful tags, and enough context to support retrieval. Avoid vague notes that cannot be acted on later.",
  },
  {
    name: "Escalate High-Risk Work",
    description:
      "For high-risk actions involving security, compliance, finance, legal decisions, broad tenant-wide impact, or missing authorization, stop at the safest useful boundary. Explain the risk, preserve useful context, and ask for confirmation or admin review instead of improvising.",
  },
] as const;

export async function seedDefaultGeneralGuidance(
  sql: postgres.Sql,
  schemaName: string,
  groupId: string,
): Promise<{ ruleSetId: string; ruleCount: number }> {
  const ruleIds: string[] = [];

  for (const rule of DEFAULT_GENERAL_GUIDANCE_RULES) {
    const [createdRule] = await sql.unsafe(
      `INSERT INTO "${schemaName}".rules (name, description) VALUES ($1, $2) RETURNING id`,
      [rule.name, rule.description],
    );
    ruleIds.push(createdRule.id as string);
  }

  const [ruleSet] = await sql.unsafe(
    `INSERT INTO "${schemaName}".rule_sets (name) VALUES ($1) RETURNING id`,
    [DEFAULT_GENERAL_GUIDANCE_RULE_SET_NAME],
  );

  for (const ruleId of ruleIds) {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".rule_set_rules (rule_set_id, rule_id) VALUES ($1, $2)`,
      [ruleSet.id as string, ruleId],
    );
  }

  await sql.unsafe(
    `INSERT INTO "${schemaName}".group_rule_sets (group_id, rule_set_id) VALUES ($1, $2)`,
    [groupId, ruleSet.id as string],
  );

  return {
    ruleSetId: ruleSet.id as string,
    ruleCount: ruleIds.length,
  };
}

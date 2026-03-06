import { withTenantScope } from "@monet/db";
import type { CreateRuleInput, CreateRuleSetInput, UpdateRuleInput } from "@monet/types";
import type postgres from "postgres";
import { logAuditEvent, type AuditEntry } from "./audit.service.js";

interface RuleMutationActor {
  actorId: string;
  actorType: AuditEntry["actorType"];
}

export interface RuleRecord {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  createdAt: string;
}

export interface RuleSetRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface RuleSetWithRulesRecord extends RuleSetRecord {
  ruleIds: string[];
}

function mapRule(row: Record<string, unknown>): RuleRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    updatedAt: row.updated_at as string,
    createdAt: row.created_at as string,
  };
}

function mapRuleSet(row: Record<string, unknown>): RuleSetRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
  };
}

export async function createRule(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  input: CreateRuleInput,
): Promise<RuleRecord> {
  const created = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [rule] = await tx`
      INSERT INTO rules (name, description)
      VALUES (${input.name}, ${input.description})
      RETURNING id, name, description, updated_at, created_at
    `;
    return mapRule(rule as Record<string, unknown>);
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.create",
    targetId: created.id,
    outcome: "success",
  });

  return created;
}

export async function updateRule(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleId: string,
  input: UpdateRuleInput,
): Promise<RuleRecord | { error: "not_found" }> {
  const updated = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [rule] = await tx`
      UPDATE rules
      SET
        name = COALESCE(${input.name ?? null}, name),
        description = COALESCE(${input.description ?? null}, description),
        updated_at = NOW()
      WHERE id = ${ruleId}
      RETURNING id, name, description, updated_at, created_at
    `;
    return rule ? mapRule(rule as Record<string, unknown>) : null;
  });

  if (!updated) {
    void logAuditEvent(sql, schemaName, {
      tenantId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "rule.update",
      targetId: ruleId,
      outcome: "failure",
      reason: "not_found",
    });
    return { error: "not_found" };
  }

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.update",
    targetId: updated.id,
    outcome: "success",
  });

  return updated;
}

export async function deleteRule(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      DELETE FROM rules
      WHERE id = ${ruleId}
      RETURNING id
    `;
    return row ? (row.id as string) : null;
  });

  if (!deleted) {
    void logAuditEvent(sql, schemaName, {
      tenantId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "rule.delete",
      targetId: ruleId,
      outcome: "failure",
      reason: "not_found",
    });
    return { error: "not_found" };
  }

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.delete",
    targetId: deleted,
    outcome: "success",
  });

  return { success: true };
}

export async function listRules(
  sql: postgres.Sql,
  schemaName: string,
): Promise<RuleRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT id, name, description, updated_at, created_at
      FROM rules
      ORDER BY created_at ASC, id ASC
    `;
    return (rows as Record<string, unknown>[]).map(mapRule);
  });
}

export async function getRule(
  sql: postgres.Sql,
  schemaName: string,
  ruleId: string,
): Promise<RuleRecord | null> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      SELECT id, name, description, updated_at, created_at
      FROM rules
      WHERE id = ${ruleId}
    `;
    return row ? mapRule(row as Record<string, unknown>) : null;
  });
}

export async function createRuleSet(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  input: CreateRuleSetInput,
): Promise<RuleSetRecord> {
  const created = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      INSERT INTO rule_sets (name)
      VALUES (${input.name})
      RETURNING id, name, created_at
    `;
    return mapRuleSet(row as Record<string, unknown>);
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set.create",
    targetId: created.id,
    outcome: "success",
  });

  return created;
}

export async function listRuleSets(
  sql: postgres.Sql,
  schemaName: string,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT
        rs.id,
        rs.name,
        rs.created_at,
        COALESCE(
          ARRAY_AGG(rsr.rule_id ORDER BY rsr.rule_id)
            FILTER (WHERE rsr.rule_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS rule_ids
      FROM rule_sets rs
      LEFT JOIN rule_set_rules rsr ON rsr.rule_set_id = rs.id
      GROUP BY rs.id, rs.name, rs.created_at
      ORDER BY rs.created_at ASC, rs.id ASC
    `;

    return (rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      createdAt: row.created_at as string,
      ruleIds: Array.isArray(row.rule_ids) ? (row.rule_ids as string[]) : [],
    }));
  });
}

export async function deleteRuleSet(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      DELETE FROM rule_sets
      WHERE id = ${ruleSetId}
      RETURNING id
    `;
    return row ? (row.id as string) : null;
  });

  if (!deleted) {
    void logAuditEvent(sql, schemaName, {
      tenantId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "rule_set.delete",
      targetId: ruleSetId,
      outcome: "failure",
      reason: "not_found",
    });
    return { error: "not_found" };
  }

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set.delete",
    targetId: deleted,
    outcome: "success",
  });

  return { success: true };
}

export async function addRuleToSet(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  ruleId: string,
): Promise<{ success: true } | { error: "not_found" | "conflict" }> {
  const result = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [ruleSetExists] = await tx`SELECT id FROM rule_sets WHERE id = ${ruleSetId}`;
    if (!ruleSetExists) return { error: "not_found" as const };

    const [ruleExists] = await tx`SELECT id FROM rules WHERE id = ${ruleId}`;
    if (!ruleExists) return { error: "not_found" as const };

    const [inserted] = await tx`
      INSERT INTO rule_set_rules (rule_set_id, rule_id)
      VALUES (${ruleSetId}, ${ruleId})
      ON CONFLICT DO NOTHING
      RETURNING rule_set_id
    `;

    if (!inserted) return { error: "conflict" as const };

    return { success: true as const };
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set_rule.add",
    targetId: `${ruleSetId}:${ruleId}`,
    outcome: "error" in result ? "failure" : "success",
    reason: "error" in result ? result.error : undefined,
  });

  return result;
}

export async function removeRuleFromSet(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  ruleId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      DELETE FROM rule_set_rules
      WHERE rule_set_id = ${ruleSetId} AND rule_id = ${ruleId}
      RETURNING rule_set_id
    `;
    return Boolean(row);
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set_rule.remove",
    targetId: `${ruleSetId}:${ruleId}`,
    outcome: removed ? "success" : "failure",
    reason: removed ? undefined : "not_found",
  });

  return removed ? { success: true } : { error: "not_found" };
}

export async function associateRuleSetWithAgent(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  agentId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" | "conflict" }> {
  const result = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [ruleSetExists] = await tx`SELECT id FROM rule_sets WHERE id = ${ruleSetId}`;
    if (!ruleSetExists) return { error: "not_found" as const };

    const [inserted] = await tx`
      INSERT INTO agent_rule_sets (agent_id, rule_set_id)
      VALUES (${agentId}, ${ruleSetId})
      ON CONFLICT DO NOTHING
      RETURNING agent_id
    `;

    if (!inserted) return { error: "conflict" as const };
    return { success: true as const };
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "agent_rule_set.associate",
    targetId: `${agentId}:${ruleSetId}`,
    outcome: "error" in result ? "failure" : "success",
    reason: "error" in result ? result.error : undefined,
  });

  return result;
}

export async function dissociateRuleSetFromAgent(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  agentId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      DELETE FROM agent_rule_sets
      WHERE agent_id = ${agentId} AND rule_set_id = ${ruleSetId}
      RETURNING agent_id
    `;
    return Boolean(row);
  });

  void logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "agent_rule_set.dissociate",
    targetId: `${agentId}:${ruleSetId}`,
    outcome: removed ? "success" : "failure",
    reason: removed ? undefined : "not_found",
  });

  return removed ? { success: true } : { error: "not_found" };
}

export async function getActiveRulesForAgent(
  sql: postgres.Sql,
  schemaName: string,
  agentId: string,
): Promise<RuleRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT DISTINCT r.id, r.name, r.description, r.updated_at, r.created_at
      FROM agent_rule_sets ars
      JOIN rule_set_rules rsr ON rsr.rule_set_id = ars.rule_set_id
      JOIN rules r ON r.id = rsr.rule_id
      WHERE ars.agent_id = ${agentId}
      ORDER BY r.created_at ASC, r.id ASC
    `;

    return (rows as Record<string, unknown>[]).map(mapRule);
  });
}

export async function getAgentIdsForRuleSet(
  sql: postgres.Sql,
  schemaName: string,
  ruleSetId: string,
): Promise<string[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT agent_id
      FROM agent_rule_sets
      WHERE rule_set_id = ${ruleSetId}
    `;
    return (rows as Record<string, unknown>[]).map((row) => row.agent_id as string);
  });
}

export async function getAgentIdsForRule(
  sql: postgres.Sql,
  schemaName: string,
  ruleId: string,
): Promise<string[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT DISTINCT ars.agent_id
      FROM agent_rule_sets ars
      JOIN rule_set_rules rsr ON rsr.rule_set_id = ars.rule_set_id
      WHERE rsr.rule_id = ${ruleId}
    `;
    return (rows as Record<string, unknown>[]).map((row) => row.agent_id as string);
  });
}

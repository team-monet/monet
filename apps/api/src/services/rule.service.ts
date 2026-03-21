import { withTenantScope } from "@monet/db";
import type { CreateRuleInput, CreateRuleSetInput, UpdateRuleInput } from "@monet/types";
import type postgres from "postgres";
import { logAuditEvent, type AuditEntry } from "./audit.service";

interface RuleMutationActor {
  actorId: string;
  actorType: AuditEntry["actorType"];
}

interface RuleOwnerScope {
  ownerUserId: string | null;
}

export interface RuleRecord {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface RuleSetRecord {
  id: string;
  name: string;
  ownerUserId: string | null;
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
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    updatedAt: row.updated_at as string,
    createdAt: row.created_at as string,
  };
}

function mapRuleSet(row: Record<string, unknown>): RuleSetRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapRuleSetWithRules(row: Record<string, unknown>): RuleSetWithRulesRecord {
  return {
    ...mapRuleSet(row),
    ruleIds: Array.isArray(row.rule_ids) ? (row.rule_ids as string[]) : [],
  };
}

async function listRuleSetsByOwner(
  sql: postgres.Sql,
  schemaName: string,
  ownerUserId: string | null,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = ownerUserId === null
      ? await tx`
          SELECT
            rs.id,
            rs.name,
            rs.owner_user_id,
            rs.created_at,
            COALESCE(
              ARRAY_AGG(rsr.rule_id ORDER BY rsr.rule_id)
                FILTER (WHERE rsr.rule_id IS NOT NULL),
              ARRAY[]::uuid[]
            ) AS rule_ids
          FROM rule_sets rs
          LEFT JOIN rule_set_rules rsr ON rsr.rule_set_id = rs.id
          WHERE rs.owner_user_id IS NULL
          GROUP BY rs.id, rs.name, rs.owner_user_id, rs.created_at
          ORDER BY rs.created_at ASC, rs.id ASC
        `
      : await tx`
          SELECT
            rs.id,
            rs.name,
            rs.owner_user_id,
            rs.created_at,
            COALESCE(
              ARRAY_AGG(rsr.rule_id ORDER BY rsr.rule_id)
                FILTER (WHERE rsr.rule_id IS NOT NULL),
              ARRAY[]::uuid[]
            ) AS rule_ids
          FROM rule_sets rs
          LEFT JOIN rule_set_rules rsr ON rsr.rule_set_id = rs.id
          WHERE rs.owner_user_id = ${ownerUserId}
          GROUP BY rs.id, rs.name, rs.owner_user_id, rs.created_at
          ORDER BY rs.created_at ASC, rs.id ASC
        `;

    return (rows as Record<string, unknown>[]).map(mapRuleSetWithRules);
  });
}

export async function createRule(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  input: CreateRuleInput,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleRecord> {
  const created = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [rule] = await tx`
      INSERT INTO rules (name, description, owner_user_id)
      VALUES (${input.name}, ${input.description}, ${scope.ownerUserId})
      RETURNING id, name, description, owner_user_id, updated_at, created_at
    `;
    return mapRule(rule as Record<string, unknown>);
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.create",
    targetId: created.id,
    outcome: "success",
    metadata: { name: created.name, description: created.description, scope: scope.ownerUserId ? "personal" : "shared" },
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
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleRecord | { error: "not_found" }> {
  const { updated, previous } = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;

    // Fetch current values for audit diff
    const [existing] = scope.ownerUserId === null
      ? await tx`SELECT name, description FROM rules WHERE id = ${ruleId} AND owner_user_id IS NULL`
      : await tx`SELECT name, description FROM rules WHERE id = ${ruleId} AND owner_user_id = ${scope.ownerUserId}`;
    const prev = existing ? { name: existing.name as string, description: existing.description as string } : null;

    const [rule] = scope.ownerUserId === null
      ? await tx`
          UPDATE rules
          SET
            name = COALESCE(${input.name ?? null}, name),
            description = COALESCE(${input.description ?? null}, description),
            updated_at = NOW()
          WHERE id = ${ruleId}
            AND owner_user_id IS NULL
          RETURNING id, name, description, owner_user_id, updated_at, created_at
        `
      : await tx`
          UPDATE rules
          SET
            name = COALESCE(${input.name ?? null}, name),
            description = COALESCE(${input.description ?? null}, description),
            updated_at = NOW()
          WHERE id = ${ruleId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING id, name, description, owner_user_id, updated_at, created_at
        `;
    return { updated: rule ? mapRule(rule as Record<string, unknown>) : null, previous: prev };
  });

  if (!updated) {
    await logAuditEvent(sql, schemaName, {
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

  const changes: Record<string, { from: string; to: string }> = {};
  if (previous && updated.name !== previous.name) {
    changes.name = { from: previous.name, to: updated.name };
  }
  if (previous && updated.description !== previous.description) {
    changes.description = { from: previous.description, to: updated.description };
  }

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.update",
    targetId: updated.id,
    outcome: "success",
    metadata: { changes, scope: scope.ownerUserId ? "personal" : "shared" },
  });

  return updated;
}

export async function deleteRule(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = scope.ownerUserId === null
      ? await tx`
          DELETE FROM rules
          WHERE id = ${ruleId}
            AND owner_user_id IS NULL
          RETURNING id, name
        `
      : await tx`
          DELETE FROM rules
          WHERE id = ${ruleId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING id, name
        `;
    return row ? { id: row.id as string, name: row.name as string } : null;
  });

  if (!deleted) {
    await logAuditEvent(sql, schemaName, {
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

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule.delete",
    targetId: deleted.id,
    outcome: "success",
    metadata: { name: deleted.name, scope: scope.ownerUserId ? "personal" : "shared" },
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
      SELECT id, name, description, owner_user_id, updated_at, created_at
      FROM rules
      WHERE owner_user_id IS NULL
      ORDER BY created_at ASC, id ASC
    `;
    return (rows as Record<string, unknown>[]).map(mapRule);
  });
}

export async function listPersonalRulesForUser(
  sql: postgres.Sql,
  schemaName: string,
  ownerUserId: string,
): Promise<RuleRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT id, name, description, owner_user_id, updated_at, created_at
      FROM rules
      WHERE owner_user_id = ${ownerUserId}
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
      SELECT id, name, description, owner_user_id, updated_at, created_at
      FROM rules
      WHERE id = ${ruleId}
        AND owner_user_id IS NULL
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
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleSetRecord> {
  const created = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = await tx`
      INSERT INTO rule_sets (name, owner_user_id)
      VALUES (${input.name}, ${scope.ownerUserId})
      RETURNING id, name, owner_user_id, created_at
    `;
    return mapRuleSet(row as Record<string, unknown>);
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set.create",
    targetId: created.id,
    outcome: "success",
    metadata: { name: created.name, scope: scope.ownerUserId ? "personal" : "shared" },
  });

  return created;
}

export async function listRuleSets(
  sql: postgres.Sql,
  schemaName: string,
): Promise<RuleSetWithRulesRecord[]> {
  return listRuleSetsByOwner(sql, schemaName, null);
}

export async function listPersonalRuleSetsForUser(
  sql: postgres.Sql,
  schemaName: string,
  ownerUserId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return listRuleSetsByOwner(sql, schemaName, ownerUserId);
}

export async function listRuleSetsForAgent(
  sql: postgres.Sql,
  schemaName: string,
  agentId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT
        rs.id,
        rs.name,
        rs.owner_user_id,
        rs.created_at,
        COALESCE(
          ARRAY_AGG(rsr.rule_id ORDER BY rsr.rule_id)
            FILTER (WHERE rsr.rule_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS rule_ids
      FROM agent_rule_sets ars
      JOIN rule_sets rs ON rs.id = ars.rule_set_id
      LEFT JOIN rule_set_rules rsr ON rsr.rule_set_id = rs.id
      WHERE ars.agent_id = ${agentId}
      GROUP BY rs.id, rs.name, rs.owner_user_id, rs.created_at
      ORDER BY rs.created_at ASC, rs.id ASC
    `;

    return (rows as Record<string, unknown>[]).map(mapRuleSetWithRules);
  });
}

export async function listRuleSetsForGroup(
  sql: postgres.Sql,
  schemaName: string,
  groupId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const rows = await tx`
      SELECT
        rs.id,
        rs.name,
        rs.owner_user_id,
        rs.created_at,
        COALESCE(
          ARRAY_AGG(rsr.rule_id ORDER BY rsr.rule_id)
            FILTER (WHERE rsr.rule_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS rule_ids
      FROM group_rule_sets grs
      JOIN rule_sets rs ON rs.id = grs.rule_set_id
      LEFT JOIN rule_set_rules rsr ON rsr.rule_set_id = rs.id
      WHERE grs.group_id = ${groupId}
        AND rs.owner_user_id IS NULL
      GROUP BY rs.id, rs.name, rs.owner_user_id, rs.created_at
      ORDER BY rs.created_at ASC, rs.id ASC
    `;

    return (rows as Record<string, unknown>[]).map(mapRuleSetWithRules);
  });
}

export async function deleteRuleSet(
  sql: postgres.Sql,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = scope.ownerUserId === null
      ? await tx`
          DELETE FROM rule_sets
          WHERE id = ${ruleSetId}
            AND owner_user_id IS NULL
          RETURNING id, name
        `
      : await tx`
          DELETE FROM rule_sets
          WHERE id = ${ruleSetId}
            AND owner_user_id = ${scope.ownerUserId}
          RETURNING id, name
        `;
    return row ? { id: row.id as string, name: row.name as string } : null;
  });

  if (!deleted) {
    await logAuditEvent(sql, schemaName, {
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

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set.delete",
    targetId: deleted.id,
    outcome: "success",
    metadata: { name: deleted.name, scope: scope.ownerUserId ? "personal" : "shared" },
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
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" | "conflict" }> {
  const result = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [ruleSetExists] = scope.ownerUserId === null
      ? await tx`
          SELECT id
          FROM rule_sets
          WHERE id = ${ruleSetId}
            AND owner_user_id IS NULL
        `
      : await tx`
          SELECT id
          FROM rule_sets
          WHERE id = ${ruleSetId}
            AND owner_user_id = ${scope.ownerUserId}
        `;
    if (!ruleSetExists) return { error: "not_found" as const };

    const [ruleExists] = scope.ownerUserId === null
      ? await tx`
          SELECT id
          FROM rules
          WHERE id = ${ruleId}
            AND owner_user_id IS NULL
        `
      : await tx`
          SELECT id
          FROM rules
          WHERE id = ${ruleId}
            AND owner_user_id = ${scope.ownerUserId}
        `;
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

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set_rule.add",
    targetId: `${ruleSetId}:${ruleId}`,
    outcome: "error" in result ? "failure" : "success",
    reason: "error" in result ? result.error : undefined,
    metadata: { ruleSetId, ruleId },
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
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const [row] = scope.ownerUserId === null
      ? await tx`
          DELETE FROM rule_set_rules rsr
          USING rule_sets rs
          WHERE rsr.rule_set_id = rs.id
            AND rs.id = ${ruleSetId}
            AND rsr.rule_id = ${ruleId}
            AND rs.owner_user_id IS NULL
          RETURNING rsr.rule_set_id
        `
      : await tx`
          DELETE FROM rule_set_rules rsr
          USING rule_sets rs
          WHERE rsr.rule_set_id = rs.id
            AND rs.id = ${ruleSetId}
            AND rsr.rule_id = ${ruleId}
            AND rs.owner_user_id = ${scope.ownerUserId}
          RETURNING rsr.rule_set_id
        `;
    return Boolean(row);
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "rule_set_rule.remove",
    targetId: `${ruleSetId}:${ruleId}`,
    outcome: removed ? "success" : "failure",
    reason: removed ? undefined : "not_found",
    metadata: { ruleSetId, ruleId },
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
): Promise<{ success: true } | { error: "not_found" | "conflict" | "forbidden" }> {
  const result = await withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;

    // Validate agent exists and belongs to this tenant (use tx for transactional consistency)
    const [agent] = await tx`
      SELECT user_id FROM public.agents
      WHERE id = ${agentId} AND tenant_id = ${tenantId}
    `;
    if (!agent) return { error: "not_found" as const };

    const agentOwnerUserId = (agent.user_id as string | null) ?? null;

    const [ruleSet] = await tx`
      SELECT owner_user_id
      FROM rule_sets
      WHERE id = ${ruleSetId}
    `;
    if (!ruleSet) return { error: "not_found" as const };

    const ownerUserId = (ruleSet.owner_user_id as string | null) ?? null;
    if (ownerUserId && ownerUserId !== agentOwnerUserId) {
      return { error: "forbidden" as const };
    }

    const [inserted] = await tx`
      INSERT INTO agent_rule_sets (agent_id, rule_set_id)
      VALUES (${agentId}, ${ruleSetId})
      ON CONFLICT DO NOTHING
      RETURNING agent_id
    `;

    if (!inserted) return { error: "conflict" as const };
    return { success: true as const };
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "agent_rule_set.associate",
    targetId: `${agentId}:${ruleSetId}`,
    outcome: "error" in result ? "failure" : "success",
    reason: "error" in result ? result.error : undefined,
    metadata: { agentId, ruleSetId },
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

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "agent_rule_set.dissociate",
    targetId: `${agentId}:${ruleSetId}`,
    outcome: removed ? "success" : "failure",
    reason: removed ? undefined : "not_found",
    metadata: { agentId, ruleSetId },
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
      WITH effective_rule_sets AS (
        SELECT rule_set_id
        FROM agent_rule_sets
        WHERE agent_id = ${agentId}
        UNION
        SELECT grs.rule_set_id
        FROM agent_group_members agm
        JOIN group_rule_sets grs ON grs.group_id = agm.group_id
        WHERE agm.agent_id = ${agentId}
      )
      SELECT DISTINCT r.id, r.name, r.description, r.owner_user_id, r.updated_at, r.created_at
      FROM effective_rule_sets ers
      JOIN rule_set_rules rsr ON rsr.rule_set_id = ers.rule_set_id
      JOIN rules r ON r.id = rsr.rule_id
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
      SELECT DISTINCT agent_id
      FROM (
        SELECT agent_id
        FROM agent_rule_sets
        WHERE rule_set_id = ${ruleSetId}
        UNION
        SELECT agm.agent_id
        FROM group_rule_sets grs
        JOIN agent_group_members agm ON agm.group_id = grs.group_id
        WHERE grs.rule_set_id = ${ruleSetId}
      ) AS effective_agents
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
      SELECT DISTINCT agent_id
      FROM (
        SELECT ars.agent_id
        FROM agent_rule_sets ars
        JOIN rule_set_rules rsr ON rsr.rule_set_id = ars.rule_set_id
        WHERE rsr.rule_id = ${ruleId}
        UNION
        SELECT agm.agent_id
        FROM group_rule_sets grs
        JOIN rule_set_rules rsr ON rsr.rule_set_id = grs.rule_set_id
        JOIN agent_group_members agm ON agm.group_id = grs.group_id
        WHERE rsr.rule_id = ${ruleId}
      ) AS effective_agents
    `;
    return (rows as Record<string, unknown>[]).map((row) => row.agent_id as string);
  });
}

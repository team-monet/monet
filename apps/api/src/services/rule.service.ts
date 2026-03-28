import {
  agents,
  agentGroups,
  agentGroupMembers,
  agentRuleSets,
  groupRuleSets,
  ruleSetRules as ruleSetRuleTable,
  ruleSets as ruleSetTable,
  rules as ruleTable,
  withTenantDrizzleScope,
} from "@monet/db";
import { and, asc, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import type { CreateRuleInput, CreateRuleSetInput, UpdateRuleInput } from "@monet/types";
import type { SqlClient } from "@monet/db";
import { logAuditEvent, type AuditEntry } from "./audit.service";

function isDuplicateNameError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: string }).code === "23505";
}

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

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  throw new TypeError(`Unexpected timestamp value: ${String(value)}`);
}

type RuleRowLike = {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  updatedAt: Date | string;
  createdAt: Date | string;
};

function mapRuleRow(row: RuleRowLike): RuleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerUserId: row.ownerUserId,
    updatedAt: normalizeTimestamp(row.updatedAt),
    createdAt: normalizeTimestamp(row.createdAt),
  };
}

function ownerScopeCondition(ownerUserId: string | null) {
  return ownerUserId === null
    ? isNull(ruleTable.ownerUserId)
    : eq(ruleTable.ownerUserId, ownerUserId);
}

function ruleSetOwnerScopeCondition(ownerUserId: string | null) {
  return ownerUserId === null
    ? isNull(ruleSetTable.ownerUserId)
    : eq(ruleSetTable.ownerUserId, ownerUserId);
}

type RuleSetRowLike = {
  id: string;
  name: string;
  ownerUserId: string | null;
  createdAt: Date | string;
};

function mapRuleSetRow(row: RuleSetRowLike): RuleSetRecord {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    createdAt: normalizeTimestamp(row.createdAt),
  };
}

type RuleSetWithRulesRowLike = RuleSetRowLike & {
  ruleIds: string[] | null;
};

function mapRuleSetWithRulesRow(row: RuleSetWithRulesRowLike): RuleSetWithRulesRecord {
  return {
    ...mapRuleSetRow(row),
    ruleIds: row.ruleIds ?? [],
  };
}

function ruleIdsSelection() {
  return drizzleSql<string[]>`
    COALESCE(
      ARRAY_AGG(${ruleSetRuleTable.ruleId} ORDER BY ${ruleSetRuleTable.ruleId})
        FILTER (WHERE ${ruleSetRuleTable.ruleId} IS NOT NULL),
      ARRAY[]::uuid[]
    )
  `;
}

async function listRuleSetsByOwner(
  sql: SqlClient,
  schemaName: string,
  ownerUserId: string | null,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({
        id: ruleSetTable.id,
        name: ruleSetTable.name,
        ownerUserId: ruleSetTable.ownerUserId,
        createdAt: ruleSetTable.createdAt,
        ruleIds: ruleIdsSelection(),
      })
      .from(ruleSetTable)
      .leftJoin(ruleSetRuleTable, eq(ruleSetRuleTable.ruleSetId, ruleSetTable.id))
      .where(ruleSetOwnerScopeCondition(ownerUserId))
      .groupBy(
        ruleSetTable.id,
        ruleSetTable.name,
        ruleSetTable.ownerUserId,
        ruleSetTable.createdAt,
      )
      .orderBy(asc(ruleSetTable.createdAt), asc(ruleSetTable.id));

    return rows.map(mapRuleSetWithRulesRow);
  });
}

export async function createRule(
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  input: CreateRuleInput,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleRecord | { error: "conflict"; message: string }> {
  let created: RuleRecord;
  try {
    created = await withTenantDrizzleScope(sql, schemaName, async (db) => {
      const [rule] = await db
        .insert(ruleTable)
        .values({
          name: input.name,
          description: input.description,
          ownerUserId: scope.ownerUserId,
        })
        .returning({
          id: ruleTable.id,
          name: ruleTable.name,
          description: ruleTable.description,
          ownerUserId: ruleTable.ownerUserId,
          updatedAt: ruleTable.updatedAt,
          createdAt: ruleTable.createdAt,
        });

      return mapRuleRow(rule);
    });
  } catch (err: unknown) {
    if (isDuplicateNameError(err)) {
      return { error: "conflict", message: `A rule named "${input.name}" already exists` };
    }
    throw err;
  }

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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleId: string,
  input: UpdateRuleInput,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleRecord | { error: "not_found" } | { error: "conflict"; message: string }> {
  let result: { updated: RuleRecord | null; previous: { name: string; description: string } | null };
  try {
    result = await withTenantDrizzleScope(sql, schemaName, async (db) => {
      const [existing] = await db
        .select({
          name: ruleTable.name,
          description: ruleTable.description,
        })
        .from(ruleTable)
        .where(
          and(eq(ruleTable.id, ruleId), ownerScopeCondition(scope.ownerUserId)),
        )
        .limit(1);

      if (!existing) {
        return { updated: null, previous: null };
      }

      const previous = {
        name: existing.name,
        description: existing.description,
      };

      const updateValues: {
        name?: string;
        description?: string;
        updatedAt: ReturnType<typeof drizzleSql>;
      } = {
        updatedAt: drizzleSql`NOW()`,
      };

      if (input.name !== undefined) {
        updateValues.name = input.name;
      }
      if (input.description !== undefined) {
        updateValues.description = input.description;
      }

      const [rule] = await db
        .update(ruleTable)
        .set(updateValues)
        .where(
          and(eq(ruleTable.id, ruleId), ownerScopeCondition(scope.ownerUserId)),
        )
        .returning({
          id: ruleTable.id,
          name: ruleTable.name,
          description: ruleTable.description,
          ownerUserId: ruleTable.ownerUserId,
          updatedAt: ruleTable.updatedAt,
          createdAt: ruleTable.createdAt,
        });

      return { updated: rule ? mapRuleRow(rule) : null, previous };
    });
  } catch (err: unknown) {
    if (isDuplicateNameError(err)) {
      return { error: "conflict", message: `A rule named "${input.name}" already exists` };
    }
    throw err;
  }

  const { updated, previous } = result;

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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [row] = await db
      .delete(ruleTable)
      .where(
        and(eq(ruleTable.id, ruleId), ownerScopeCondition(scope.ownerUserId)),
      )
      .returning({
        id: ruleTable.id,
        name: ruleTable.name,
      });

    return row ?? null;
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
  sql: SqlClient,
  schemaName: string,
): Promise<RuleRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({
        id: ruleTable.id,
        name: ruleTable.name,
        description: ruleTable.description,
        ownerUserId: ruleTable.ownerUserId,
        updatedAt: ruleTable.updatedAt,
        createdAt: ruleTable.createdAt,
      })
      .from(ruleTable)
      .where(isNull(ruleTable.ownerUserId))
      .orderBy(asc(ruleTable.createdAt), asc(ruleTable.id));

    return rows.map(mapRuleRow);
  });
}

export async function listPersonalRulesForUser(
  sql: SqlClient,
  schemaName: string,
  ownerUserId: string,
): Promise<RuleRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({
        id: ruleTable.id,
        name: ruleTable.name,
        description: ruleTable.description,
        ownerUserId: ruleTable.ownerUserId,
        updatedAt: ruleTable.updatedAt,
        createdAt: ruleTable.createdAt,
      })
      .from(ruleTable)
      .where(eq(ruleTable.ownerUserId, ownerUserId))
      .orderBy(asc(ruleTable.createdAt), asc(ruleTable.id));

    return rows.map(mapRuleRow);
  });
}

export async function getRule(
  sql: SqlClient,
  schemaName: string,
  ruleId: string,
): Promise<RuleRecord | null> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [row] = await db
      .select({
        id: ruleTable.id,
        name: ruleTable.name,
        description: ruleTable.description,
        ownerUserId: ruleTable.ownerUserId,
        updatedAt: ruleTable.updatedAt,
        createdAt: ruleTable.createdAt,
      })
      .from(ruleTable)
      .where(
        and(eq(ruleTable.id, ruleId), isNull(ruleTable.ownerUserId)),
      )
      .limit(1);

    return row ? mapRuleRow(row) : null;
  });
}

export async function createRuleSet(
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  input: CreateRuleSetInput,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<RuleSetRecord | { error: "conflict"; message: string }> {
  let created: RuleSetRecord;
  try {
    created = await withTenantDrizzleScope(sql, schemaName, async (db) => {
      const [row] = await db
        .insert(ruleSetTable)
        .values({
          name: input.name,
          ownerUserId: scope.ownerUserId,
        })
        .returning({
          id: ruleSetTable.id,
          name: ruleSetTable.name,
          ownerUserId: ruleSetTable.ownerUserId,
          createdAt: ruleSetTable.createdAt,
        });

      return mapRuleSetRow(row);
    });
  } catch (err: unknown) {
    if (isDuplicateNameError(err)) {
      return { error: "conflict", message: `A rule set named "${input.name}" already exists` };
    }
    throw err;
  }

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
  sql: SqlClient,
  schemaName: string,
): Promise<RuleSetWithRulesRecord[]> {
  return listRuleSetsByOwner(sql, schemaName, null);
}

export async function listPersonalRuleSetsForUser(
  sql: SqlClient,
  schemaName: string,
  ownerUserId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return listRuleSetsByOwner(sql, schemaName, ownerUserId);
}

export async function listRuleSetsForAgent(
  sql: SqlClient,
  schemaName: string,
  agentId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({
        id: ruleSetTable.id,
        name: ruleSetTable.name,
        ownerUserId: ruleSetTable.ownerUserId,
        createdAt: ruleSetTable.createdAt,
        ruleIds: ruleIdsSelection(),
      })
      .from(agentRuleSets)
      .innerJoin(ruleSetTable, eq(ruleSetTable.id, agentRuleSets.ruleSetId))
      .leftJoin(ruleSetRuleTable, eq(ruleSetRuleTable.ruleSetId, ruleSetTable.id))
      .where(eq(agentRuleSets.agentId, agentId))
      .groupBy(
        ruleSetTable.id,
        ruleSetTable.name,
        ruleSetTable.ownerUserId,
        ruleSetTable.createdAt,
      )
      .orderBy(asc(ruleSetTable.createdAt), asc(ruleSetTable.id));

    return rows.map(mapRuleSetWithRulesRow);
  });
}

export async function listRuleSetsForGroup(
  sql: SqlClient,
  schemaName: string,
  groupId: string,
): Promise<RuleSetWithRulesRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .select({
        id: ruleSetTable.id,
        name: ruleSetTable.name,
        ownerUserId: ruleSetTable.ownerUserId,
        createdAt: ruleSetTable.createdAt,
        ruleIds: ruleIdsSelection(),
      })
      .from(groupRuleSets)
      .innerJoin(ruleSetTable, eq(ruleSetTable.id, groupRuleSets.ruleSetId))
      .leftJoin(ruleSetRuleTable, eq(ruleSetRuleTable.ruleSetId, ruleSetTable.id))
      .where(and(eq(groupRuleSets.groupId, groupId), isNull(ruleSetTable.ownerUserId)))
      .groupBy(
        ruleSetTable.id,
        ruleSetTable.name,
        ruleSetTable.ownerUserId,
        ruleSetTable.createdAt,
      )
      .orderBy(asc(ruleSetTable.createdAt), asc(ruleSetTable.id));

    return rows.map(mapRuleSetWithRulesRow);
  });
}

export async function deleteRuleSet(
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const deleted = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [row] = await db
      .delete(ruleSetTable)
      .where(
        and(eq(ruleSetTable.id, ruleSetId), ruleSetOwnerScopeCondition(scope.ownerUserId)),
      )
      .returning({
        id: ruleSetTable.id,
        name: ruleSetTable.name,
      });

    return row ?? null;
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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  ruleId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" | "conflict" }> {
  const result = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [ruleSetExists] = await db
      .select({
        id: ruleSetTable.id,
      })
      .from(ruleSetTable)
      .where(
        and(eq(ruleSetTable.id, ruleSetId), ruleSetOwnerScopeCondition(scope.ownerUserId)),
      )
      .limit(1);
    if (!ruleSetExists) return { error: "not_found" as const };

    const [ruleExists] = await db
      .select({
        id: ruleTable.id,
      })
      .from(ruleTable)
      .where(and(eq(ruleTable.id, ruleId), ownerScopeCondition(scope.ownerUserId)))
      .limit(1);
    if (!ruleExists) return { error: "not_found" as const };

    const [inserted] = await db
      .insert(ruleSetRuleTable)
      .values({
        ruleSetId,
        ruleId,
      })
      .onConflictDoNothing()
      .returning({
        ruleSetId: ruleSetRuleTable.ruleSetId,
      });

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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  ruleSetId: string,
  ruleId: string,
  scope: RuleOwnerScope = { ownerUserId: null },
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [ruleSetExists] = await db
      .select({
        id: ruleSetTable.id,
      })
      .from(ruleSetTable)
      .where(
        and(eq(ruleSetTable.id, ruleSetId), ruleSetOwnerScopeCondition(scope.ownerUserId)),
      )
      .limit(1);
    if (!ruleSetExists) return false;

    const [row] = await db
      .delete(ruleSetRuleTable)
      .where(
        and(
          eq(ruleSetRuleTable.ruleSetId, ruleSetId),
          eq(ruleSetRuleTable.ruleId, ruleId),
        ),
      )
      .returning({
        ruleSetId: ruleSetRuleTable.ruleSetId,
      });

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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  agentId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" | "conflict" | "forbidden" }> {
  const result = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [agent] = await db
      .select({
        userId: agents.userId,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
      .limit(1);
    if (!agent) return { error: "not_found" as const };

    const agentOwnerUserId = agent.userId ?? null;

    const [ruleSet] = await db
      .select({
        ownerUserId: ruleSetTable.ownerUserId,
      })
      .from(ruleSetTable)
      .where(eq(ruleSetTable.id, ruleSetId))
      .limit(1);
    if (!ruleSet) return { error: "not_found" as const };

    if (ruleSet.ownerUserId && ruleSet.ownerUserId !== agentOwnerUserId) {
      return { error: "forbidden" as const };
    }

    const [inserted] = await db
      .insert(agentRuleSets)
      .values({
        agentId,
        ruleSetId,
      })
      .onConflictDoNothing()
      .returning({
        agentId: agentRuleSets.agentId,
      });

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
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  agentId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [row] = await db
      .delete(agentRuleSets)
      .where(
        and(
          eq(agentRuleSets.agentId, agentId),
          eq(agentRuleSets.ruleSetId, ruleSetId),
        ),
      )
      .returning({
        agentId: agentRuleSets.agentId,
      });

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

export async function associateRuleSetWithGroup(
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  groupId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" | "conflict" }> {
  const result = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [group] = await db
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.id, groupId), eq(agentGroups.tenantId, tenantId)))
      .limit(1);
    if (!group) return { error: "not_found" as const };

    const [ruleSet] = await db
      .select({ id: ruleSetTable.id })
      .from(ruleSetTable)
      .where(and(eq(ruleSetTable.id, ruleSetId), isNull(ruleSetTable.ownerUserId)))
      .limit(1);
    if (!ruleSet) return { error: "not_found" as const };

    const [inserted] = await db
      .insert(groupRuleSets)
      .values({ groupId, ruleSetId })
      .onConflictDoNothing()
      .returning({ groupId: groupRuleSets.groupId });

    if (!inserted) return { error: "conflict" as const };
    return { success: true as const };
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "group_rule_set.associate",
    targetId: `${groupId}:${ruleSetId}`,
    outcome: "error" in result ? "failure" : "success",
    reason: "error" in result ? result.error : undefined,
    metadata: { groupId, ruleSetId },
  });

  return result;
}

export async function dissociateRuleSetFromGroup(
  sql: SqlClient,
  tenantId: string,
  schemaName: string,
  actor: RuleMutationActor,
  groupId: string,
  ruleSetId: string,
): Promise<{ success: true } | { error: "not_found" }> {
  const removed = await withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [row] = await db
      .delete(groupRuleSets)
      .where(
        and(
          eq(groupRuleSets.groupId, groupId),
          eq(groupRuleSets.ruleSetId, ruleSetId),
        ),
      )
      .returning({ groupId: groupRuleSets.groupId });

    return Boolean(row);
  });

  await logAuditEvent(sql, schemaName, {
    tenantId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: "group_rule_set.dissociate",
    targetId: `${groupId}:${ruleSetId}`,
    outcome: removed ? "success" : "failure",
    reason: removed ? undefined : "not_found",
    metadata: { groupId, ruleSetId },
  });

  return removed ? { success: true } : { error: "not_found" };
}

export async function getActiveRulesForAgent(
  sql: SqlClient,
  schemaName: string,
  agentId: string,
): Promise<RuleRecord[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [directRuleSetRows, groupRuleSetRows] = await Promise.all([
      db
        .select({
          ruleSetId: agentRuleSets.ruleSetId,
        })
        .from(agentRuleSets)
        .where(eq(agentRuleSets.agentId, agentId)),
      db
        .select({
          ruleSetId: groupRuleSets.ruleSetId,
        })
        .from(agentGroupMembers)
        .innerJoin(groupRuleSets, eq(groupRuleSets.groupId, agentGroupMembers.groupId))
        .where(eq(agentGroupMembers.agentId, agentId)),
    ]);

    const ruleSetIds = dedupeStrings([
      ...directRuleSetRows.map((row) => row.ruleSetId),
      ...groupRuleSetRows.map((row) => row.ruleSetId),
    ]);

    if (ruleSetIds.length === 0) {
      return [];
    }

    const rows = await db
      .selectDistinct({
        id: ruleTable.id,
        name: ruleTable.name,
        description: ruleTable.description,
        ownerUserId: ruleTable.ownerUserId,
        updatedAt: ruleTable.updatedAt,
        createdAt: ruleTable.createdAt,
      })
      .from(ruleSetRuleTable)
      .innerJoin(ruleTable, eq(ruleTable.id, ruleSetRuleTable.ruleId))
      .where(inArray(ruleSetRuleTable.ruleSetId, ruleSetIds))
      .orderBy(asc(ruleTable.createdAt), asc(ruleTable.id));

    return rows.map(mapRuleRow);
  });
}

export async function getAgentIdsForRuleSet(
  sql: SqlClient,
  schemaName: string,
  ruleSetId: string,
): Promise<string[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [directAgentRows, groupAgentRows] = await Promise.all([
      db
        .select({
          agentId: agentRuleSets.agentId,
        })
        .from(agentRuleSets)
        .where(eq(agentRuleSets.ruleSetId, ruleSetId)),
      db
        .select({
          agentId: agentGroupMembers.agentId,
        })
        .from(groupRuleSets)
        .innerJoin(agentGroupMembers, eq(agentGroupMembers.groupId, groupRuleSets.groupId))
        .where(eq(groupRuleSets.ruleSetId, ruleSetId)),
    ]);

    return dedupeStrings([
      ...directAgentRows.map((row) => row.agentId),
      ...groupAgentRows.map((row) => row.agentId),
    ]);
  });
}

export async function getAgentIdsForGroup(
  sql: SqlClient,
  schemaName: string,
  groupId: string,
): Promise<string[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const rows = await db
      .selectDistinct({ agentId: agentGroupMembers.agentId })
      .from(agentGroupMembers)
      .where(eq(agentGroupMembers.groupId, groupId));
    return rows.map((row) => row.agentId);
  });
}

export async function getAgentIdsForRule(
  sql: SqlClient,
  schemaName: string,
  ruleId: string,
): Promise<string[]> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [directAgentRows, groupAgentRows] = await Promise.all([
      db
        .select({
          agentId: agentRuleSets.agentId,
        })
        .from(agentRuleSets)
        .innerJoin(ruleSetRuleTable, eq(ruleSetRuleTable.ruleSetId, agentRuleSets.ruleSetId))
        .where(eq(ruleSetRuleTable.ruleId, ruleId)),
      db
        .select({
          agentId: agentGroupMembers.agentId,
        })
        .from(groupRuleSets)
        .innerJoin(ruleSetRuleTable, eq(ruleSetRuleTable.ruleSetId, groupRuleSets.ruleSetId))
        .innerJoin(agentGroupMembers, eq(agentGroupMembers.groupId, groupRuleSets.groupId))
        .where(eq(ruleSetRuleTable.ruleId, ruleId)),
    ]);

    return dedupeStrings([
      ...directAgentRows.map((row) => row.agentId),
      ...groupAgentRows.map((row) => row.agentId),
    ]);
  });
}

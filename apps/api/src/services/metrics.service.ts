import type { SqlClient } from "@monet/db";
import {
  agents,
  agentGroupMembers,
  agentGroups,
  auditLog,
  memoryEntries,
  tenantSchemaNameFromId,
  withTenantDrizzleScope,
} from "@monet/db";
import { aliasedTable, and, eq, isNotNull, notLike, sql as drizzleSql } from "drizzle-orm";
import type {
  UsageMetrics,
  BenefitMetrics,
  HealthMetrics,
} from "@monet/types";

// Must match DEFAULT_MEMORY_QUOTA in memory.service.ts (enforcement fallback)
const DEFAULT_MEMORY_QUOTA = 10000;

function formatDateOnly(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : String(value)).split("T")[0];
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  return Number(value ?? 0);
}

// ---------- Usage metrics ----------

export async function getUsageMetrics(
  sql: SqlClient,
  tenantId: string,
  timezone: string = "UTC",
): Promise<UsageMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const liveMemoryCondition = drizzleSql`${memoryEntries.expiresAt} IS NULL OR ${memoryEntries.expiresAt} > NOW()`;

    const [
      frequencyRows,
      activeAgentRows,
      totalAgentRows,
      enrichmentRows,
      searchHitRows,
      semanticRows,
    ] = await Promise.all([
      db.execute<{
        date: Date | string;
        writes: number | string;
        reads: number | string;
        searches: number | string;
      }>(drizzleSql`
        SELECT
          d::date AS date,
          COALESCE(SUM(CASE WHEN al.action = 'memory.create' THEN 1 ELSE 0 END), 0)::int AS writes,
          COALESCE(SUM(CASE WHEN al.action = 'memory.get' THEN 1 ELSE 0 END), 0)::int AS reads,
          COALESCE(SUM(CASE WHEN al.action = 'memory.search' THEN 1 ELSE 0 END), 0)::int AS searches
        FROM generate_series(
          (NOW() AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::date - INTERVAL '13 days',
          (NOW() AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::date,
          '1 day'::interval
        ) AS d
        LEFT JOIN audit_log al
          ON DATE(al.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}) = d::date
          AND al.action IN ('memory.create', 'memory.get', 'memory.search')
        GROUP BY d::date
        ORDER BY d::date ASC
      `),
      db
        .select({
          period7d: drizzleSql<number>`COUNT(DISTINCT CASE WHEN ${auditLog.createdAt} > NOW() - INTERVAL '7 days' THEN ${auditLog.actorId} END)::int`,
          period30d: drizzleSql<number>`COUNT(DISTINCT CASE WHEN ${auditLog.createdAt} > NOW() - INTERVAL '30 days' THEN ${auditLog.actorId} END)::int`,
        })
        .from(auditLog)
        .innerJoin(agents, eq(agents.id, auditLog.actorId))
        .where(
          and(
            drizzleSql`${auditLog.createdAt} > NOW() - INTERVAL '30 days'`,
            eq(auditLog.actorType, "agent"),
            notLike(agents.externalId, "dashboard:%"),
          ),
        ),
      db
        .select({
          total: drizzleSql<number>`COUNT(*)::int`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.tenantId, tenantId),
            notLike(agents.externalId, "dashboard:%"),
          ),
        ),
      db
        .select({
          pending: drizzleSql<number>`COUNT(*) FILTER (WHERE ${memoryEntries.enrichmentStatus} = 'pending')::int`,
          processing: drizzleSql<number>`COUNT(*) FILTER (WHERE ${memoryEntries.enrichmentStatus} = 'processing')::int`,
          completed: drizzleSql<number>`COUNT(*) FILTER (WHERE ${memoryEntries.enrichmentStatus} = 'completed')::int`,
          failed: drizzleSql<number>`COUNT(*) FILTER (WHERE ${memoryEntries.enrichmentStatus} = 'failed')::int`,
        })
        .from(memoryEntries)
        .where(liveMemoryCondition),
      db
        .select({
          total: drizzleSql<number>`COUNT(*)::int`,
          withResults: drizzleSql<number>`COUNT(*) FILTER (WHERE (${auditLog.metadata}->>'resultCount')::int > 0)::int`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "memory.search"),
            drizzleSql`${auditLog.metadata} IS NOT NULL`,
            drizzleSql`${auditLog.metadata} ? 'resultCount'`,
          ),
        ),
      db
        .select({
          total: drizzleSql<number>`COUNT(*)::int`,
          vectorCount: drizzleSql<number>`COUNT(*) FILTER (WHERE ${auditLog.metadata}->>'searchType' = 'vector')::int`,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "memory.search"),
            drizzleSql`${auditLog.metadata} IS NOT NULL`,
            drizzleSql`${auditLog.metadata} ? 'searchType'`,
          ),
        ),
    ]);

    const [activeAgents = { period7d: 0, period30d: 0 }] = activeAgentRows;
    const [totalAgents = { total: 0 }] = totalAgentRows;
    const [enrichment = { pending: 0, processing: 0, completed: 0, failed: 0 }] = enrichmentRows;
    const [searchHitData = { total: 0, withResults: 0 }] = searchHitRows;
    const [semanticData = { total: 0, vectorCount: 0 }] = semanticRows;
    const searchTotal = toNumber(searchHitData.total);
    const searchWithResults = toNumber(searchHitData.withResults);
    const semanticTotal = toNumber(semanticData.total);
    const vectorCount = toNumber(semanticData.vectorCount);

    return {
      readWriteFrequency: frequencyRows.map((row) => ({
        date: formatDateOnly(row.date),
        reads: toNumber(row.reads),
        writes: toNumber(row.writes),
        searches: toNumber(row.searches),
      })),
      activeAgents: {
        period7d: toNumber(activeAgents.period7d),
        period30d: toNumber(activeAgents.period30d),
        total: toNumber(totalAgents.total),
      },
      enrichmentThroughput: {
        pending: toNumber(enrichment.pending),
        processing: toNumber(enrichment.processing),
        completed: toNumber(enrichment.completed),
        failed: toNumber(enrichment.failed),
      },
      searchHitRate: searchTotal > 0
        ? {
            total: searchTotal,
            withResults: searchWithResults,
            rate: Math.round((searchWithResults / searchTotal) * 1000) / 10,
          }
        : null,
      semanticSearchPct: semanticTotal > 0
        ? Math.round((vectorCount / semanticTotal) * 1000) / 10
        : null,
    };
  });
}

// ---------- Benefit metrics ----------

export async function getBenefitMetrics(
  sql: SqlClient,
  tenantId: string,
): Promise<BenefitMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const liveMemoryCondition = drizzleSql`${memoryEntries.expiresAt} IS NULL OR ${memoryEntries.expiresAt} > NOW()`;
    const readerAgents = aliasedTable(agents, "reader_agents");
    const writerAgents = aliasedTable(agents, "writer_agents");

    const [
      usefulnessRows,
      reuseRows,
      tagDiversityRows,
      enrichmentQualityRows,
      crossAgentTotalRows,
      crossAgentPairRows,
    ] = await Promise.all([
      db.execute<{
        bucket: string;
        count: number | string;
      }>(drizzleSql`
        SELECT
          CASE
            WHEN ${memoryEntries.usefulnessScore} = 0 THEN '0'
            WHEN ${memoryEntries.usefulnessScore} = 1 THEN '1'
            WHEN ${memoryEntries.usefulnessScore} BETWEEN 2 AND 3 THEN '2-3'
            WHEN ${memoryEntries.usefulnessScore} BETWEEN 4 AND 6 THEN '4-6'
            ELSE '7+'
          END AS bucket,
          COUNT(*)::int AS count
        FROM ${memoryEntries}
        WHERE ${liveMemoryCondition}
        GROUP BY 1
        ORDER BY MIN(${memoryEntries.usefulnessScore}) ASC
      `),
      db.execute<{
        bucket: string;
        count: number | string;
      }>(drizzleSql`
        SELECT
          CASE
            WHEN ${memoryEntries.usefulnessScore} = 0 THEN 'Never accessed'
            WHEN ${memoryEntries.usefulnessScore} BETWEEN 1 AND 3 THEN '1-3 times'
            WHEN ${memoryEntries.usefulnessScore} BETWEEN 4 AND 10 THEN '4-10 times'
            ELSE '10+ times'
          END AS bucket,
          COUNT(*)::int AS count
        FROM ${memoryEntries}
        WHERE ${liveMemoryCondition}
        GROUP BY 1
        ORDER BY MIN(${memoryEntries.usefulnessScore}) ASC
      `),
      db.execute<{
        groupId: string;
        groupName: string;
        tagCount: number | string;
        topTags: string[] | null;
      }>(drizzleSql`
        SELECT
          me.group_id AS "groupId",
          ag.name AS "groupName",
          COUNT(DISTINCT t.tag)::int AS "tagCount",
          COALESCE(
            (
              SELECT array_agg(top_tag ORDER BY top_cnt DESC, top_tag ASC)
              FROM (
                SELECT unnest(me2.tags) AS top_tag, COUNT(*) AS top_cnt
                FROM ${memoryEntries} me2
                WHERE me2.group_id = me.group_id
                  AND (me2.expires_at IS NULL OR me2.expires_at > NOW())
                GROUP BY top_tag
                ORDER BY top_cnt DESC, top_tag ASC
                LIMIT 5
              ) sub
            ),
            '{}'::text[]
          ) AS "topTags"
        FROM ${memoryEntries} me
        CROSS JOIN LATERAL unnest(me.tags) AS t(tag)
        JOIN ${agentGroups} ag ON ag.id = me.group_id
        WHERE me.group_id IS NOT NULL
          AND (me.expires_at IS NULL OR me.expires_at > NOW())
        GROUP BY me.group_id, ag.name
        ORDER BY "tagCount" DESC, ag.name ASC
      `),
      db.execute<{
        withSummary: number | string;
        withEmbedding: number | string;
        withAutoTags: number | string;
        total: number | string;
      }>(drizzleSql`
        SELECT
          COUNT(*) FILTER (WHERE ${memoryEntries.summary} IS NOT NULL AND ${memoryEntries.summary} != '')::int AS "withSummary",
          COUNT(*) FILTER (WHERE ${memoryEntries.embedding} IS NOT NULL)::int AS "withEmbedding",
          COUNT(*) FILTER (WHERE array_length(${memoryEntries.autoTags}, 1) > 0)::int AS "withAutoTags",
          COUNT(*)::int AS total
        FROM ${memoryEntries}
        WHERE ${liveMemoryCondition}
      `),
      db
        .select({
          total: drizzleSql<number>`COUNT(*)::int`,
        })
        .from(auditLog)
        .innerJoin(
          memoryEntries,
          drizzleSql`${memoryEntries.id}::text = ${auditLog.targetId}`,
        )
        .innerJoin(readerAgents, eq(readerAgents.id, auditLog.actorId))
        .innerJoin(writerAgents, eq(writerAgents.id, memoryEntries.authorAgentId))
        .where(
          and(
            eq(auditLog.action, "memory.get"),
            drizzleSql`${auditLog.actorId} != ${memoryEntries.authorAgentId}`,
            notLike(readerAgents.externalId, "dashboard:%"),
            notLike(writerAgents.externalId, "dashboard:%"),
          ),
        ),
      db
        .select({
          writerAgentId: memoryEntries.authorAgentId,
          readerAgentId: auditLog.actorId,
          count: drizzleSql<number>`COUNT(*)::int`,
        })
        .from(auditLog)
        .innerJoin(
          memoryEntries,
          drizzleSql`${memoryEntries.id}::text = ${auditLog.targetId}`,
        )
        .innerJoin(readerAgents, eq(readerAgents.id, auditLog.actorId))
        .innerJoin(writerAgents, eq(writerAgents.id, memoryEntries.authorAgentId))
        .where(
          and(
            eq(auditLog.action, "memory.get"),
            drizzleSql`${auditLog.actorId} != ${memoryEntries.authorAgentId}`,
            notLike(readerAgents.externalId, "dashboard:%"),
            notLike(writerAgents.externalId, "dashboard:%"),
          ),
        )
        .groupBy(memoryEntries.authorAgentId, auditLog.actorId)
        .orderBy(
          drizzleSql`COUNT(*) DESC`,
          memoryEntries.authorAgentId,
          auditLog.actorId,
        )
        .limit(10),
    ]);
    const usefulnessDistribution = usefulnessRows.map((row) => ({
      bucket: row.bucket,
      count: toNumber(row.count),
    }));
    const memoryReuseRate = reuseRows.map((row) => ({
      bucket: row.bucket,
      count: toNumber(row.count),
    }));
    const tagDiversityByGroup = tagDiversityRows.map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      tagCount: toNumber(row.tagCount),
      topTags: row.topTags ?? [],
    }));
    const [quality = { withSummary: 0, withEmbedding: 0, withAutoTags: 0, total: 0 }] = enrichmentQualityRows;
    const enrichmentQuality = {
      withSummary: toNumber(quality.withSummary),
      withEmbedding: toNumber(quality.withEmbedding),
      withAutoTags: toNumber(quality.withAutoTags),
      total: toNumber(quality.total),
    };

    const [crossAgentTotal = { total: 0 }] = crossAgentTotalRows;
    const totalShared = toNumber(crossAgentTotal.total);

    return {
      usefulnessDistribution,
      memoryReuseRate,
      tagDiversityByGroup,
      enrichmentQuality,
      crossAgentSharing: totalShared > 0
        ? {
            totalShared,
            topPairs: crossAgentPairRows.map((row) => ({
              writerAgentId: row.writerAgentId,
              readerAgentId: row.readerAgentId,
              count: toNumber(row.count),
            })),
          }
        : null,
    };
  });
}

// ---------- Health metrics ----------

export async function getHealthMetrics(
  sql: SqlClient,
  tenantId: string,
): Promise<HealthMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const liveMemoryCondition = drizzleSql`${memoryEntries.expiresAt} IS NULL OR ${memoryEntries.expiresAt} > NOW()`;

    const [
      liveLifecycleRows,
      allEntryLifecycleRows,
      groupRows,
      groupCurrentRows,
      groupMemberRows,
    ] = await Promise.all([
      db
        .select({
          avgAgeDays: drizzleSql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - ${memoryEntries.createdAt})) / 86400), 0)::float`,
          outdatedPct: drizzleSql<number>`CASE WHEN COUNT(*) = 0 THEN 0 ELSE (COUNT(*) FILTER (WHERE ${memoryEntries.outdated} = true)::float / COUNT(*)::float * 100) END`,
        })
        .from(memoryEntries)
        .where(liveMemoryCondition),
      db
        .select({
          expiryRate: drizzleSql<number>`CASE WHEN COUNT(*) = 0 THEN 0 ELSE (COUNT(*) FILTER (WHERE ${memoryEntries.expiresAt} IS NOT NULL AND ${memoryEntries.expiresAt} <= NOW())::float / COUNT(*)::float * 100) END`,
        })
        .from(memoryEntries),
      db
        .select({
          groupId: agentGroups.id,
          groupName: agentGroups.name,
          quota: agentGroups.memoryQuota,
        })
        .from(agentGroups)
        .where(eq(agentGroups.tenantId, tenantId))
        .orderBy(agentGroups.name),
      db
        .select({
          groupId: memoryEntries.groupId,
          current: drizzleSql<number>`COUNT(*)::int`,
        })
        .from(memoryEntries)
        .where(and(isNotNull(memoryEntries.groupId), liveMemoryCondition))
        .groupBy(memoryEntries.groupId),
      db
        .select({
          groupId: agentGroupMembers.groupId,
          agentId: agentGroupMembers.agentId,
          agentCount: drizzleSql<number>`COUNT(${memoryEntries.id})::int`,
        })
        .from(agentGroupMembers)
        .innerJoin(agentGroups, eq(agentGroups.id, agentGroupMembers.groupId))
        .leftJoin(
          memoryEntries,
          and(
            eq(memoryEntries.authorAgentId, agentGroupMembers.agentId),
            liveMemoryCondition,
          ),
        )
        .where(eq(agentGroups.tenantId, tenantId))
        .groupBy(agentGroupMembers.groupId, agentGroupMembers.agentId),
    ]);

    const [liveLifecycle = { avgAgeDays: 0, outdatedPct: 0 }] = liveLifecycleRows;
    const [allEntryLifecycle = { expiryRate: 0 }] = allEntryLifecycleRows;
    const currentByGroupId = new Map(
      groupCurrentRows.map((row) => [row.groupId, toNumber(row.current)]),
    );
    const maxAgentCurrentByGroupId = new Map<string, number>();

    for (const row of groupMemberRows) {
      const previous = maxAgentCurrentByGroupId.get(row.groupId) ?? 0;
      maxAgentCurrentByGroupId.set(
        row.groupId,
        Math.max(previous, toNumber(row.agentCount)),
      );
    }

    return {
      memoryLifecycle: {
        avgAgeDays: Math.round(toNumber(liveLifecycle.avgAgeDays) * 10) / 10,
        outdatedPct: Math.round(toNumber(liveLifecycle.outdatedPct) * 10) / 10,
        expiryRate: Math.round(toNumber(allEntryLifecycle.expiryRate) * 10) / 10,
      },
      quotaUtilization: groupRows.map((row) => {
          const quota = row.quota ?? null;

          return {
            groupId: row.groupId,
            groupName: row.groupName,
            current: currentByGroupId.get(row.groupId) ?? 0,
            quota,
            effectiveQuotaPerAgent: quota !== null && quota > 0
              ? quota
              : DEFAULT_MEMORY_QUOTA,
            maxAgentCurrent: maxAgentCurrentByGroupId.get(row.groupId) ?? 0,
          };
        }),
    };
  });
}

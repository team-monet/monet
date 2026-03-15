import type postgres from "postgres";
import { tenantSchemaNameFromId, withTenantScope } from "@monet/db";
import type {
  UsageMetrics,
  BenefitMetrics,
  HealthMetrics,
} from "@monet/types";

// ---------- Usage metrics ----------

export async function getUsageMetrics(
  sql: postgres.Sql,
  tenantId: string,
): Promise<UsageMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantScope(sql, schemaName, async (tx) => {
    // 14-day read/write/search frequency from audit_log
    const frequencyRows = await tx.unsafe(`
      SELECT
        d::date AS date,
        COALESCE(SUM(CASE WHEN al.action = 'memory.create' THEN 1 ELSE 0 END), 0)::int AS writes,
        COALESCE(SUM(CASE WHEN al.action = 'memory.get' THEN 1 ELSE 0 END), 0)::int AS reads,
        COALESCE(SUM(CASE WHEN al.action = 'memory.search' THEN 1 ELSE 0 END), 0)::int AS searches
      FROM generate_series(
        (CURRENT_DATE - INTERVAL '13 days')::date,
        CURRENT_DATE::date,
        '1 day'::interval
      ) AS d
      LEFT JOIN audit_log al
        ON al.created_at::date = d::date
        AND al.action IN ('memory.create', 'memory.get', 'memory.search')
      GROUP BY d::date
      ORDER BY d::date ASC
    `);

    // Active agents (7d / 30d) from audit_log + total from platform
    const [activeAgents] = await tx.unsafe(
      `
      SELECT
        COUNT(DISTINCT CASE WHEN al.created_at > NOW() - INTERVAL '7 days' THEN al.actor_id END)::int AS period_7d,
        COUNT(DISTINCT CASE WHEN al.created_at > NOW() - INTERVAL '30 days' THEN al.actor_id END)::int AS period_30d,
        (SELECT COUNT(*)::int FROM public.agents WHERE tenant_id = $1) AS total
      FROM audit_log al
      WHERE al.created_at > NOW() - INTERVAL '30 days'
    `,
      [tenantId],
    );

    // Enrichment throughput from memory_entries
    const [enrichment] = await tx.unsafe(`
      SELECT
        COUNT(*) FILTER (WHERE enrichment_status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE enrichment_status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE enrichment_status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE enrichment_status = 'failed')::int AS failed
      FROM memory_entries
      WHERE expires_at IS NULL OR expires_at > NOW()
    `);

    // Tier 2: Search hit rate (from metadata JSONB)
    const searchHitRows = await tx.unsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (metadata->>'resultCount')::int > 0)::int AS with_results
      FROM audit_log
      WHERE action = 'memory.search'
        AND metadata IS NOT NULL
        AND metadata ? 'resultCount'
    `);
    const searchHitData = searchHitRows[0] as Record<string, unknown> | undefined;
    const searchTotal = (searchHitData?.total as number) ?? 0;
    const searchWithResults = (searchHitData?.with_results as number) ?? 0;

    // Tier 2: Semantic search percentage
    const semanticRows = await tx.unsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'searchType' = 'vector')::int AS vector_count
      FROM audit_log
      WHERE action = 'memory.search'
        AND metadata IS NOT NULL
        AND metadata ? 'searchType'
    `);
    const semanticData = semanticRows[0] as Record<string, unknown> | undefined;
    const semanticTotal = (semanticData?.total as number) ?? 0;
    const vectorCount = (semanticData?.vector_count as number) ?? 0;

    return {
      readWriteFrequency: (frequencyRows as Record<string, unknown>[]).map(
        (r) => {
          const raw = r.date;
          const dateStr =
            raw instanceof Date
              ? raw.toISOString().split("T")[0]
              : String(raw).split("T")[0];
          return {
            date: dateStr,
            reads: r.reads as number,
            writes: r.writes as number,
            searches: r.searches as number,
          };
        },
      ),
      activeAgents: {
        period7d: activeAgents.period_7d as number,
        period30d: activeAgents.period_30d as number,
        total: activeAgents.total as number,
      },
      enrichmentThroughput: {
        pending: enrichment.pending as number,
        processing: enrichment.processing as number,
        completed: enrichment.completed as number,
        failed: enrichment.failed as number,
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
  sql: postgres.Sql,
  tenantId: string,
): Promise<BenefitMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantScope(sql, schemaName, async (tx) => {
    // Usefulness score distribution (bucketed)
    const usefulnessRows = await tx.unsafe(`
      SELECT
        CASE
          WHEN usefulness_score = 0 THEN '0'
          WHEN usefulness_score = 1 THEN '1'
          WHEN usefulness_score BETWEEN 2 AND 3 THEN '2-3'
          WHEN usefulness_score BETWEEN 4 AND 6 THEN '4-6'
          ELSE '7+'
        END AS bucket,
        COUNT(*)::int AS count
      FROM memory_entries
      WHERE expires_at IS NULL OR expires_at > NOW()
      GROUP BY bucket
      ORDER BY MIN(usefulness_score) ASC
    `);

    // Memory reuse rate (bucketed by usefulness_score as access proxy)
    const reuseRows = await tx.unsafe(`
      SELECT
        CASE
          WHEN usefulness_score = 0 THEN 'Never accessed'
          WHEN usefulness_score BETWEEN 1 AND 3 THEN '1-3 times'
          WHEN usefulness_score BETWEEN 4 AND 10 THEN '4-10 times'
          ELSE '10+ times'
        END AS bucket,
        COUNT(*)::int AS count
      FROM memory_entries
      WHERE expires_at IS NULL OR expires_at > NOW()
      GROUP BY bucket
      ORDER BY MIN(usefulness_score) ASC
    `);

    // Tag diversity per group
    const tagDiversityRows = await tx.unsafe(
      `
      SELECT
        me.group_id,
        ag.name AS group_name,
        COUNT(DISTINCT t.tag)::int AS tag_count,
        COALESCE(
          (SELECT array_agg(top_tag ORDER BY top_cnt DESC)
           FROM (
             SELECT unnest(me2.tags) AS top_tag, COUNT(*) AS top_cnt
             FROM memory_entries me2
             WHERE me2.group_id = me.group_id
               AND (me2.expires_at IS NULL OR me2.expires_at > NOW())
             GROUP BY top_tag
             ORDER BY top_cnt DESC
             LIMIT 5
           ) sub),
          '{}'::text[]
        ) AS top_tags
      FROM memory_entries me
      CROSS JOIN LATERAL unnest(me.tags) AS t(tag)
      JOIN public.agent_groups ag ON ag.id = me.group_id
      WHERE me.group_id IS NOT NULL
        AND (me.expires_at IS NULL OR me.expires_at > NOW())
      GROUP BY me.group_id, ag.name
      ORDER BY tag_count DESC
    `,
    );

    // Enrichment quality
    const [quality] = await tx.unsafe(`
      SELECT
        COUNT(*) FILTER (WHERE summary IS NOT NULL AND summary != '')::int AS with_summary,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_embedding,
        COUNT(*) FILTER (WHERE array_length(auto_tags, 1) > 0)::int AS with_auto_tags,
        COUNT(*)::int AS total
      FROM memory_entries
      WHERE expires_at IS NULL OR expires_at > NOW()
    `);

    // Tier 2: Cross-agent sharing — memories written by one agent, read by another
    const [[crossAgentTotal], crossAgentRows] = await Promise.all([
      tx.unsafe(`
        SELECT COUNT(*)::int AS total
        FROM audit_log al
        JOIN memory_entries me ON me.id = al.target_id::uuid
        WHERE al.action = 'memory.get'
          AND al.actor_id != me.author_agent_id
      `),
      tx.unsafe(`
        SELECT
          me.author_agent_id AS writer_agent_id,
          al.actor_id AS reader_agent_id,
          COUNT(*)::int AS count
        FROM audit_log al
        JOIN memory_entries me ON me.id = al.target_id::uuid
        WHERE al.action = 'memory.get'
          AND al.actor_id != me.author_agent_id
        GROUP BY me.author_agent_id, al.actor_id
        ORDER BY count DESC
        LIMIT 10
      `),
    ]);
    const crossAgentPairs = crossAgentRows as Record<string, unknown>[];
    const totalShared = (crossAgentTotal?.total as number) ?? 0;

    return {
      usefulnessDistribution: (
        usefulnessRows as Record<string, unknown>[]
      ).map((r) => ({
        bucket: r.bucket as string,
        count: r.count as number,
      })),
      memoryReuseRate: (reuseRows as Record<string, unknown>[]).map((r) => ({
        bucket: r.bucket as string,
        count: r.count as number,
      })),
      tagDiversityByGroup: (
        tagDiversityRows as Record<string, unknown>[]
      ).map((r) => ({
        groupId: r.group_id as string,
        groupName: r.group_name as string,
        tagCount: r.tag_count as number,
        topTags: (r.top_tags as string[]) ?? [],
      })),
      enrichmentQuality: {
        withSummary: quality.with_summary as number,
        withEmbedding: quality.with_embedding as number,
        withAutoTags: quality.with_auto_tags as number,
        total: quality.total as number,
      },
      crossAgentSharing: totalShared > 0
        ? {
            totalShared,
            topPairs: crossAgentPairs.map((r) => ({
              writerAgentId: r.writer_agent_id as string,
              readerAgentId: r.reader_agent_id as string,
              count: r.count as number,
            })),
          }
        : null,
    };
  });
}

// ---------- Health metrics ----------

export async function getHealthMetrics(
  sql: postgres.Sql,
  tenantId: string,
): Promise<HealthMetrics> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  return withTenantScope(sql, schemaName, async (tx) => {
    // Memory lifecycle stats (exclude already-expired entries for avg age / outdated)
    const [lifecycle] = await tx.unsafe(`
      SELECT
        COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400), 0)::float AS avg_age_days,
        CASE WHEN COUNT(*) = 0 THEN 0
          ELSE (COUNT(*) FILTER (WHERE outdated = true)::float / COUNT(*)::float * 100)
        END AS outdated_pct,
        CASE WHEN COUNT(*) = 0 THEN 0
          ELSE (COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::float / COUNT(*)::float * 100)
        END AS expiry_rate
      FROM memory_entries
      WHERE expires_at IS NULL OR expires_at > NOW()
    `);

    // Quota utilization per group (null quota = unlimited)
    const quotaRows = await tx.unsafe(
      `
      SELECT
        ag.id AS group_id,
        ag.name AS group_name,
        COUNT(me.id)::int AS current,
        ag.memory_quota::int AS quota
      FROM public.agent_groups ag
      LEFT JOIN memory_entries me
        ON me.group_id = ag.id
        AND (me.expires_at IS NULL OR me.expires_at > NOW())
      WHERE ag.tenant_id = $1
      GROUP BY ag.id, ag.name, ag.memory_quota
      ORDER BY ag.name ASC
    `,
      [tenantId],
    );

    return {
      memoryLifecycle: {
        avgAgeDays: Math.round((lifecycle.avg_age_days as number) * 10) / 10,
        outdatedPct:
          Math.round((lifecycle.outdated_pct as number) * 10) / 10,
        expiryRate:
          Math.round((lifecycle.expiry_rate as number) * 10) / 10,
      },
      quotaUtilization: (quotaRows as Record<string, unknown>[]).map(
        (r) => ({
          groupId: r.group_id as string,
          groupName: r.group_name as string,
          current: r.current as number,
          quota: r.quota as number,
        }),
      ),
    };
  });
}

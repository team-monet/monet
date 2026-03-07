#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = process.env.POSTGRES_USER ?? "postgres";
  const password = process.env.POSTGRES_PASSWORD ?? "postgres";
  const host = process.env.POSTGRES_HOST ?? "127.0.0.1";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const db = process.env.POSTGRES_DB ?? "monet";

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
}

function tenantSchema(tenantId) {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const tenantName = process.env.LOCAL_TENANT_NAME ?? "Local Dev Org";
  const providedTenantId = process.env.LOCAL_TENANT_ID;
  const configuredOutput = process.env.LOCAL_METRICS_OUTPUT ?? ".local-dev/metrics.json";
  const outputPath = path.isAbsolute(configuredOutput)
    ? configuredOutput
    : path.resolve(repoRoot, configuredOutput);

  const sql = postgres(buildDatabaseUrl(), { max: 1 });
  try {
    let tenantId = providedTenantId;
    if (!tenantId) {
      const rows = await sql`
        SELECT id
        FROM tenants
        WHERE name = ${tenantName}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!rows[0]?.id) {
        throw new Error(`Tenant not found: ${tenantName}`);
      }
      tenantId = rows[0].id;
    }

    const schema = tenantSchema(tenantId);

    const [{ agentsCount }] = await sql`
      SELECT COUNT(*)::int AS "agentsCount"
      FROM agents
      WHERE tenant_id = ${tenantId}
    `;

    const [{ groupsCount }] = await sql`
      SELECT COUNT(*)::int AS "groupsCount"
      FROM agent_groups
      WHERE tenant_id = ${tenantId}
    `;

    const [memoryTotals] = await sql.unsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE outdated)::int AS outdated,
        COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < NOW())::int AS expired
      FROM "${schema}".memory_entries
    `);

    const memoriesByScope = await sql.unsafe(`
      SELECT memory_scope AS scope, COUNT(*)::int AS count
      FROM "${schema}".memory_entries
      GROUP BY memory_scope
      ORDER BY count DESC
    `);

    const memoriesByType = await sql.unsafe(`
      SELECT memory_type AS type, COUNT(*)::int AS count
      FROM "${schema}".memory_entries
      GROUP BY memory_type
      ORDER BY count DESC
    `);

    const topTags = await sql.unsafe(`
      SELECT tag, COUNT(*)::int AS count
      FROM "${schema}".memory_entries, LATERAL unnest(tags) AS tag
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT 15
    `);

    const dailyWrites = await sql.unsafe(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS count
      FROM "${schema}".memory_entries
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY day
      ORDER BY day ASC
    `);

    const topAuthors = await sql.unsafe(`
      SELECT
        a.id AS "agentId",
        a.external_id AS "externalId",
        COUNT(m.id)::int AS count
      FROM agents a
      JOIN "${schema}".memory_entries m ON m.author_agent_id = a.id
      WHERE a.tenant_id = $1
      GROUP BY a.id, a.external_id
      ORDER BY count DESC, a.external_id ASC
      LIMIT 10
    `, [tenantId]);

    const groupMembership = await sql`
      SELECT
        g.id AS "groupId",
        g.name AS "groupName",
        COUNT(m.agent_id)::int AS "memberCount"
      FROM agent_groups g
      LEFT JOIN agent_group_members m ON m.group_id = g.id
      WHERE g.tenant_id = ${tenantId}
      GROUP BY g.id, g.name
      ORDER BY g.name ASC
    `;

    const recentAuditActions = await sql.unsafe(`
      SELECT action, COUNT(*)::int AS count
      FROM "${schema}".audit_log
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY action
      ORDER BY count DESC, action ASC
      LIMIT 20
    `);

    const report = {
      generatedAt: new Date().toISOString(),
      tenant: { id: tenantId, name: tenantName },
      totals: {
        agents: agentsCount,
        groups: groupsCount,
        memories: memoryTotals.total,
        outdatedMemories: memoryTotals.outdated,
        expiredMemories: memoryTotals.expired,
      },
      memoriesByScope,
      memoriesByType,
      topTags,
      dailyWritesLast14Days: dailyWrites,
      topAuthorAgents: topAuthors,
      groupMembership,
      auditActionsLast30Days: recentAuditActions,
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    console.log(`Usage metrics written: ${outputPath}`);
    console.log(
      `tenant=${tenantId} agents=${report.totals.agents} groups=${report.totals.groups} memories=${report.totals.memories}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error("Usage metrics generation failed", error);
  process.exit(1);
});

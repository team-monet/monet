import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, tenantSchemaNameFromId } from "@monet/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function help() {
  console.log(`Reset support-agent workflow demo data (M6 #87).

Usage:
  pnpm demo:support:reset

Environment:
  DATABASE_URL         Required
  DEMO_TENANT_SLUG     Default: demo-support-org
  DEMO_STATE_FILE      Default: .local-dev/demo-support-workflow.json
`);
}

function env(name: string, fallback?: string) {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  const databaseUrl = env("DATABASE_URL");
  const tenantSlug = env("DEMO_TENANT_SLUG", "demo-support-org");
  const stateFile = env(
    "DEMO_STATE_FILE",
    path.resolve(__dirname, "../../../../.local-dev/demo-support-workflow.json"),
  );

  const { sql } = createClient(databaseUrl);

  try {
    const tenantRows = await sql<{ id: string; slug: string }[]>`
      SELECT id, slug
      FROM tenants
      WHERE slug = ${tenantSlug}
      LIMIT 1
    `;

    if (tenantRows.length === 0) {
      console.log(`Tenant ${tenantSlug} not found. Nothing to reset.`);
      await rm(stateFile, { force: true });
      return;
    }

    const tenantId = tenantRows[0].id;
    const schemaName = tenantSchemaNameFromId(tenantId);

    await sql.begin(async (tx) => {
      await tx`DELETE FROM user_group_agent_group_permissions
        WHERE user_group_id IN (SELECT id FROM user_groups WHERE tenant_id = ${tenantId})
           OR agent_group_id IN (SELECT id FROM agent_groups WHERE tenant_id = ${tenantId})`;

      await tx`DELETE FROM user_group_members
        WHERE user_group_id IN (SELECT id FROM user_groups WHERE tenant_id = ${tenantId})
           OR user_id IN (SELECT id FROM users WHERE tenant_id = ${tenantId})`;

      await tx`DELETE FROM agent_group_members
        WHERE group_id IN (SELECT id FROM agent_groups WHERE tenant_id = ${tenantId})
           OR agent_id IN (SELECT id FROM agents WHERE tenant_id = ${tenantId})`;

      await tx`DELETE FROM tenant_admin_nominations WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM tenant_oauth_configs WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM users WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM agents WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM user_groups WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM agent_groups WHERE tenant_id = ${tenantId}`;
      await tx`DELETE FROM tenants WHERE id = ${tenantId}`;

      await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    });

    await rm(stateFile, { force: true });
    console.log(`Reset complete for tenant ${tenantSlug} (${tenantId}).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error("reset-support-workflow failed", error);
  process.exit(1);
});

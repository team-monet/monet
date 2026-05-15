import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantSchema } from "@monet/db";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupTestData,
  closeTestDb,
  getTestSql,
  provisionTestTenant,
} from "./helpers/setup";

describe("tenant schema manager integration", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeTestDb();
  });

  it("deduplicates agent_group_members and restores composite PK for existing tables", async () => {
    const { body } = await provisionTestTenant({ name: "schema-upgrade-test" });
    const tenantId = (body.tenant as { id: string }).id;
    const agentId = (body.agent as { id: string }).id;
    const groupId = body.defaultGroupId as string;
    const schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;

    const sql = getTestSql();

    await sql.unsafe(
      `ALTER TABLE "${schemaName}".agent_group_members DROP CONSTRAINT IF EXISTS agent_group_members_pkey`,
    );

    await sql.unsafe(
      `INSERT INTO "${schemaName}".agent_group_members (agent_id, group_id, joined_at)
       VALUES ($1, $2, now() - interval '1 day')`,
      [agentId, groupId],
    );

    const [beforeUpgrade] = await sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM "${schemaName}".agent_group_members
       WHERE agent_id = $1
         AND group_id = $2`,
      [agentId, groupId],
    );
    expect(Number(beforeUpgrade.count)).toBe(2);

    await createTenantSchema(sql, tenantId);

    const [afterUpgrade] = await sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM "${schemaName}".agent_group_members
       WHERE agent_id = $1
         AND group_id = $2`,
      [agentId, groupId],
    );
    expect(Number(afterUpgrade.count)).toBe(1);

    const [constraintRow] = await sql.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.table_constraints
       WHERE table_schema = $1
         AND table_name = 'agent_group_members'
         AND constraint_type = 'PRIMARY KEY'`,
      [schemaName],
    );
    expect(Number(constraintRow.count)).toBe(1);
  });

  it("backfills user memory metadata without ordering UUID group IDs", async () => {
    const { body } = await provisionTestTenant({ name: "memory-backfill-migration-test" });
    const tenantId = (body.tenant as { id: string }).id;
    const agentId = (body.agent as { id: string }).id;
    const groupId = body.defaultGroupId as string;
    const schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;

    const sql = getTestSql();
    const [user] = await sql.unsafe<{ id: string }[]>(
      `INSERT INTO "${schemaName}".users (external_id, tenant_id, display_name, email)
       VALUES ('migration-test-user', $1, 'Migration Test User', 'migration-test@example.com')
       RETURNING id`,
      [tenantId],
    );

    await sql.unsafe(
      `UPDATE "${schemaName}".agents
       SET user_id = $1
       WHERE id = $2`,
      [user.id, agentId],
    );

    const [memory] = await sql.unsafe<{ id: string }[]>(
      `INSERT INTO "${schemaName}".memory_entries (
         content,
         memory_type,
         memory_scope,
         tags,
         auto_tags,
         author_agent_id
       )
       VALUES (
         'legacy user memory',
         'fact',
         'user',
         ARRAY[]::text[],
         ARRAY[]::text[],
         $1
       )
       RETURNING id`,
      [agentId],
    );

    const migrationSql = await readFile(
      path.resolve(
        process.cwd(),
        "../../packages/db/drizzle/0002_backfill_user_scoped_memory_group_metadata.sql",
      ),
      "utf8",
    );
    await sql.unsafe(migrationSql);

    const [updatedMemory] = await sql.unsafe<
      { user_id: string | null; group_id: string | null }[]
    >(
      `SELECT user_id, group_id
       FROM "${schemaName}".memory_entries
       WHERE id = $1`,
      [memory.id],
    );
    expect(updatedMemory.user_id).toBe(user.id);
    expect(updatedMemory.group_id).toBe(groupId);
  });
});

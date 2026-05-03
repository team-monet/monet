import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantSchema } from "@monet/db";
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
});

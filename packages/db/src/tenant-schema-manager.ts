import postgres from "postgres";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

/**
 * Derive the PostgreSQL schema name for a tenant.
 */
export function tenantSchemaNameFromId(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

/**
 * Ensure the pgvector extension is installed.
 * Must be called with a non-transactional client because PostgreSQL
 * does not allow CREATE EXTENSION inside a transaction block.
 */
export async function ensureVectorExtension(
  sql: postgres.Sql,
): Promise<void> {
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (error) {
    throw new Error(
      `pgvector extension is not available on this PostgreSQL server. Install pgvector before provisioning tenants.\n` +
        `See: https://github.com/pgvector/pgvector#installation`,
      { cause: error },
    );
  }
}

/**
 * Create a new tenant schema with all required tables, indexes, and security constraints.
 * The schema contains: users, agents, agent_groups, agent_group_members, user_groups,
 * user_group_members, user_group_agent_group_permissions, memory_entries, memory_versions,
 * audit_log, rules, rule_sets, rule_set_rules, agent_rule_sets, group_rule_sets.
 *
 * Audit log has UPDATE and DELETE revoked to ensure append-only behavior.
 */
export async function createTenantSchema(
  sql: postgres.Sql | postgres.TransactionSql,
  tenantId: string,
): Promise<string> {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const embeddingDimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || "1024", 10);

  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // Tenant-owned identity/access tables
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id VARCHAR(255) NOT NULL,
      tenant_id UUID NOT NULL,
      display_name VARCHAR(255),
      email VARCHAR(255),
      role public.user_role NOT NULL DEFAULT 'user',
      dashboard_api_key_encrypted VARCHAR(1024),
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT users_tenant_id_external_id_unique UNIQUE (tenant_id, external_id)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id VARCHAR(255) NOT NULL,
      tenant_id UUID NOT NULL,
      user_id UUID REFERENCES "${schemaName}".users(id),
      role public.user_role,
      api_key_hash VARCHAR(255) NOT NULL,
      api_key_salt VARCHAR(255) NOT NULL,
      is_autonomous BOOLEAN NOT NULL DEFAULT false,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".agent_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(1024) DEFAULT '',
      memory_quota INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".agent_group_members (
      agent_id UUID NOT NULL REFERENCES "${schemaName}".agents(id),
      group_id UUID NOT NULL REFERENCES "${schemaName}".agent_groups(id),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, group_id)
    )
  `);

  // Upgrade step for pre-existing tenant schemas created before
  // agent_group_members had a composite primary key.
  // 1) Deduplicate rows so a PK can be safely added.
  // 2) Ensure the PK exists (idempotent across repeated schema initialization).
  await sql.unsafe(`
    WITH ranked AS (
      SELECT
        ctid,
        row_number() OVER (
          PARTITION BY agent_id, group_id
          ORDER BY joined_at ASC, ctid ASC
        ) AS row_num
      FROM "${schemaName}".agent_group_members
    )
    DELETE FROM "${schemaName}".agent_group_members agm
    USING ranked
    WHERE agm.ctid = ranked.ctid
      AND ranked.row_num > 1
  `);

  const existingAgentGroupMembersPrimaryKey = await sql.unsafe<{ constraint_name: string }[]>(
    `SELECT tc.constraint_name
       FROM information_schema.table_constraints tc
      WHERE tc.table_schema = $1
        AND tc.table_name = 'agent_group_members'
        AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1`,
    [schemaName],
  );

  if (existingAgentGroupMembersPrimaryKey.length === 0) {
    await sql.unsafe(
      `ALTER TABLE "${schemaName}".agent_group_members ADD CONSTRAINT agent_group_members_pkey PRIMARY KEY (agent_id, group_id)`,
    );
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".user_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(1024) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT user_groups_tenant_id_name_unique UNIQUE (tenant_id, name)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".user_group_members (
      user_group_id UUID NOT NULL REFERENCES "${schemaName}".user_groups(id),
      user_id UUID NOT NULL REFERENCES "${schemaName}".users(id),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_group_id, user_id)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".user_group_agent_group_permissions (
      user_group_id UUID NOT NULL REFERENCES "${schemaName}".user_groups(id),
      agent_group_id UUID NOT NULL REFERENCES "${schemaName}".agent_groups(id),
      PRIMARY KEY (user_group_id, agent_group_id)
    )
  `);

  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON "${schemaName}".users (tenant_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_agents_tenant_id ON "${schemaName}".agents (tenant_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_agents_user_id ON "${schemaName}".agents (user_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_agent_groups_tenant_id ON "${schemaName}".agent_groups (tenant_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_agent_group_members_agent_id ON "${schemaName}".agent_group_members (agent_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_agent_group_members_group_id ON "${schemaName}".agent_group_members (group_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_user_groups_tenant_id ON "${schemaName}".user_groups (tenant_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_user_group_members_user_id ON "${schemaName}".user_group_members (user_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_user_group_agent_permissions_agent_group_id ON "${schemaName}".user_group_agent_group_permissions (agent_group_id)`);

  // Create enum types in the tenant schema
  await sql.unsafe(`
    DO $$ BEGIN
      CREATE TYPE "${schemaName}".memory_scope AS ENUM ('group', 'user', 'private');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      CREATE TYPE "${schemaName}".memory_type AS ENUM ('decision', 'pattern', 'issue', 'preference', 'fact', 'procedure');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$
  `);

  await sql.unsafe(`
    DO $$ BEGIN
      CREATE TYPE "${schemaName}".enrichment_status AS ENUM ('pending', 'processing', 'completed', 'failed');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$
  `);

  // Memory entries table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".memory_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      summary VARCHAR(200),
      enrichment_status "${schemaName}".enrichment_status NOT NULL DEFAULT 'pending',
      memory_type "${schemaName}".memory_type NOT NULL,
      memory_scope "${schemaName}".memory_scope NOT NULL DEFAULT 'group',
      tags TEXT[] NOT NULL DEFAULT '{}',
      auto_tags TEXT[] NOT NULL DEFAULT '{}',
      embedding vector(${embeddingDimensions}),
      related_memory_ids UUID[] NOT NULL DEFAULT '{}',
      usefulness_score INTEGER NOT NULL DEFAULT 0,
      outdated BOOLEAN NOT NULL DEFAULT false,
      ttl_seconds INTEGER,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      author_agent_id UUID NOT NULL,
      group_id UUID,
      user_id UUID,
      version INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Memory entries indexes
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON "${schemaName}".memory_entries (memory_scope)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_type ON "${schemaName}".memory_entries (memory_type)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_author ON "${schemaName}".memory_entries (author_agent_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_group ON "${schemaName}".memory_entries (group_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_user ON "${schemaName}".memory_entries (user_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_memory_expires ON "${schemaName}".memory_entries (expires_at)`);

  // Memory versions table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".memory_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_entry_id UUID NOT NULL REFERENCES "${schemaName}".memory_entries(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      author_agent_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_memory_versions_entry_version ON "${schemaName}".memory_versions (memory_entry_id, version)`,
  );

  // Audit log table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      actor_id UUID NOT NULL,
      actor_type VARCHAR(20) NOT NULL,
      action VARCHAR(50) NOT NULL,
      target_id VARCHAR(255),
      outcome VARCHAR(20) NOT NULL,
      reason TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Ensure metadata column exists on pre-existing audit_log tables
  await sql.unsafe(`ALTER TABLE "${schemaName}".audit_log ADD COLUMN IF NOT EXISTS metadata JSONB`);

  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION "${schemaName}".prevent_audit_log_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only';
    END;
    $$ LANGUAGE plpgsql
  `);

  await sql.unsafe(`DROP TRIGGER IF EXISTS audit_log_append_only ON "${schemaName}".audit_log`);
  await sql.unsafe(`
    CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON "${schemaName}".audit_log
    FOR EACH ROW
    EXECUTE FUNCTION "${schemaName}".prevent_audit_log_mutation()
  `);

  // Rules table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      owner_user_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    ALTER TABLE IF EXISTS "${schemaName}".rules
    ADD COLUMN IF NOT EXISTS owner_user_id UUID
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_rules_owner_user
    ON "${schemaName}".rules (owner_user_id)
  `);
  // Deduplicate existing rule names before adding unique constraint (only on first run).
  const [rulesIdx] = await sql.unsafe(`
    SELECT 1 FROM pg_indexes WHERE schemaname = '${schemaName}' AND indexname = 'uq_rules_name_owner'
  `);
  if (!rulesIdx) {
    await sql.unsafe(`
      UPDATE "${schemaName}".rules r
      SET name = LEFT(r.name, 216) || ' (' || gen_random_uuid()::text || ')'
      FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY name, owner_user_id ORDER BY created_at ASC, id ASC) AS rn
        FROM "${schemaName}".rules
      ) dups
      WHERE r.id = dups.id AND dups.rn > 1
    `);
    await sql.unsafe(`
      CREATE UNIQUE INDEX uq_rules_name_owner
      ON "${schemaName}".rules (name, owner_user_id) NULLS NOT DISTINCT
    `);
  }

  // Rule sets table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".rule_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      owner_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    ALTER TABLE IF EXISTS "${schemaName}".rule_sets
    ADD COLUMN IF NOT EXISTS owner_user_id UUID
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_rule_sets_owner_user
    ON "${schemaName}".rule_sets (owner_user_id)
  `);
  // Deduplicate existing rule set names before adding unique constraint (only on first run).
  const [ruleSetsIdx] = await sql.unsafe(`
    SELECT 1 FROM pg_indexes WHERE schemaname = '${schemaName}' AND indexname = 'uq_rule_sets_name_owner'
  `);
  if (!ruleSetsIdx) {
    await sql.unsafe(`
      UPDATE "${schemaName}".rule_sets rs
      SET name = LEFT(rs.name, 216) || ' (' || gen_random_uuid()::text || ')'
      FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY name, owner_user_id ORDER BY created_at ASC, id ASC) AS rn
        FROM "${schemaName}".rule_sets
      ) dups
      WHERE rs.id = dups.id AND dups.rn > 1
    `);
    await sql.unsafe(`
      CREATE UNIQUE INDEX uq_rule_sets_name_owner
      ON "${schemaName}".rule_sets (name, owner_user_id) NULLS NOT DISTINCT
    `);
  }

  // Rule set rules join table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".rule_set_rules (
      rule_set_id UUID NOT NULL REFERENCES "${schemaName}".rule_sets(id) ON DELETE CASCADE,
      rule_id UUID NOT NULL REFERENCES "${schemaName}".rules(id) ON DELETE CASCADE,
      PRIMARY KEY (rule_set_id, rule_id)
    )
  `);

  // Agent rule sets join table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".agent_rule_sets (
      agent_id UUID NOT NULL,
      rule_set_id UUID NOT NULL REFERENCES "${schemaName}".rule_sets(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, rule_set_id)
    )
  `);

  // Group rule sets join table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".group_rule_sets (
      group_id UUID NOT NULL,
      rule_set_id UUID NOT NULL REFERENCES "${schemaName}".rule_sets(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, rule_set_id)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".tenant_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_agent_instructions TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Append-only audit log: revoke UPDATE and DELETE from public role
  await sql.unsafe(`REVOKE UPDATE, DELETE ON "${schemaName}".audit_log FROM PUBLIC`);

  return schemaName;
}

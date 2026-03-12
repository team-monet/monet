import postgres from "postgres";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

/**
 * Derive the PostgreSQL schema name for a tenant.
 */
export function tenantSchemaNameFromId(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

/**
 * Create a new tenant schema with all required tables, indexes, and security constraints.
 * The schema contains: memory_entries, memory_versions, audit_log, rules, rule_sets,
 * rule_set_rules, agent_rule_sets.
 *
 * Audit log has UPDATE and DELETE revoked to ensure append-only behavior.
 */
export async function createTenantSchema(
  sql: postgres.Sql | postgres.TransactionSql,
  tenantId: string,
): Promise<string> {
  const schemaName = tenantSchemaNameFromId(tenantId);

  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  // Ensure shared extensions exist before creating tenant tables that depend on them.
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

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
      embedding vector(1024),
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Rule sets table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".rule_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

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

  // Append-only audit log: revoke UPDATE and DELETE from public role
  await sql.unsafe(`REVOKE UPDATE, DELETE ON "${schemaName}".audit_log FROM PUBLIC`);

  return schemaName;
}

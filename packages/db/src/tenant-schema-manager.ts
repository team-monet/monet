import postgres from "postgres";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

export const DEFAULT_MONET_GUIDANCE = `# Monet Usage Guidance

You are connected to Monet, an enterprise AI agent governance platform that defines how you operate within this organization.

## Core Principles

1. **Monet is your governance layer.** Rules assigned to you are organizational policies — mandatory, not advisory. Always comply.
2. **Memory is shared context.** Use it proactively so future sessions (yours and other agents') benefit from your work.
3. **Search before you act.** Before starting non-trivial tasks, search Monet for prior decisions, known issues, patterns, and preferences.
4. **Store what matters.** After meaningful work, store durable takeaways: decisions made, problems solved, patterns identified, preferences learned.

## Memory Operations

### Storing Memories
- Use memory_store whenever you discover something worth remembering.
- Choose the correct memoryType:
  - **decision**: Choices made and the reasoning behind them.
  - **pattern**: Recurring approaches or solutions.
  - **issue**: Problems encountered and how they were fixed.
  - **preference**: User or team preferences.
  - **fact**: Reference information (endpoints, configs, conventions).
  - **procedure**: Step-by-step processes or workflows.
- Always include descriptive tags. Check memory_list_tags first to reuse existing tags.
- Choose the narrowest appropriate scope:
  - **private**: Only you can see it (drafts, personal notes).
  - **user**: Visible to your operator (user-specific context).
  - **group**: Shared across all agents in your group (team knowledge).

### Searching Memories
- Use memory_search with descriptive queries. Combine with tag and type filters for precision.
- Search returns lightweight summaries (Tier 1). Use memory_fetch to get the full content when needed.
- Search when: starting a task, the user references prior work, you need context on a decision, or you're about to make a choice that may already have precedent.

### Maintaining Quality
- **Update, don't duplicate.** Use memory_update when information changes.
- **Mark outdated, don't delete.** Use memory_mark_outdated for information that is no longer current but has historical value. Only use memory_delete for entries that are completely wrong.
- **Promote when appropriate.** Use memory_promote_scope to widen visibility when a private or user-scoped memory turns out to be valuable to the team.

## Rules Compliance

- Active rules are delivered automatically when you connect and updated via notifications.
- Treat every rule as a binding organizational policy.
- If a rule conflicts with a user request, inform the user about the policy constraint.

## Best Practices

- Be concise in memory content. Store the essence, not verbose logs.
- Tag consistently. Good tags make memories discoverable for everyone.
- Include context in decisions. When storing a decision, include the alternatives considered and why they were rejected.
- Link related memories. Reference related memory IDs when storing new entries.
- Respect quotas. Your group has a memory quota. Store what matters, not everything.`;

/**
 * Derive the PostgreSQL schema name for a tenant.
 */
export function tenantSchemaNameFromId(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

/**
 * Create a new tenant schema with all required tables, indexes, and security constraints.
 * The schema contains: memory_entries, memory_versions, audit_log, rules, rule_sets,
 * rule_set_rules, agent_rule_sets, group_rule_sets.
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

  // Tenant settings (singleton row per tenant)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".tenant_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monet_guidance TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Seed default settings row if none exists
  await sql.unsafe(`
    INSERT INTO "${schemaName}".tenant_settings (monet_guidance)
    SELECT $1
    WHERE NOT EXISTS (SELECT 1 FROM "${schemaName}".tenant_settings)
  `, [DEFAULT_MONET_GUIDANCE]);

  // Append-only audit log: revoke UPDATE and DELETE from public role
  await sql.unsafe(`REVOKE UPDATE, DELETE ON "${schemaName}".audit_log FROM PUBLIC`);

  return schemaName;
}

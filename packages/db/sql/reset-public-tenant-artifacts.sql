-- One-time cleanup for tenant-schema consolidation.
-- Safe for clean-slate environments where no data must be preserved.

BEGIN;

-- Reset migration history so Drizzle can start from a new baseline.
DROP TABLE IF EXISTS drizzle.__drizzle_migrations;

-- Legacy migration tracker from older Prisma-based setup.
DROP TABLE IF EXISTS public._prisma_migrations;

-- Remove tenant-scoped tables that should never live in public.
DROP TABLE IF EXISTS public.agent_rule_sets CASCADE;
DROP TABLE IF EXISTS public.group_rule_sets CASCADE;
DROP TABLE IF EXISTS public.rule_set_rules CASCADE;
DROP TABLE IF EXISTS public.rule_sets CASCADE;
DROP TABLE IF EXISTS public.rules CASCADE;
DROP TABLE IF EXISTS public.memory_versions CASCADE;
DROP TABLE IF EXISTS public.memory_entries CASCADE;
DROP TABLE IF EXISTS public.audit_log CASCADE;
DROP TABLE IF EXISTS public.user_group_agent_group_permissions CASCADE;
DROP TABLE IF EXISTS public.user_group_members CASCADE;
DROP TABLE IF EXISTS public.user_groups CASCADE;
DROP TABLE IF EXISTS public.agent_group_members CASCADE;
DROP TABLE IF EXISTS public.agent_groups CASCADE;
DROP TABLE IF EXISTS public.agents CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;

-- Remove tenant-scoped enums that should only exist per tenant schema.
DROP TYPE IF EXISTS public.enrichment_status;
DROP TYPE IF EXISTS public.memory_type;
DROP TYPE IF EXISTS public.memory_scope;

-- Keep public.user_role and public.isolation_mode because they are platform-owned.

COMMIT;

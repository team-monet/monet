DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_groups'
      AND column_name = 'memory_quota'
      AND data_type <> 'integer'
  ) THEN
    EXECUTE '
      ALTER TABLE "agent_groups"
      ALTER COLUMN "memory_quota" TYPE integer
      USING NULLIF("memory_quota", '''')::integer
    ';
  END IF;
END $$;

ALTER TABLE "audit_log"
ADD COLUMN IF NOT EXISTS "tenant_id" uuid;

UPDATE "audit_log"
SET "tenant_id" = '00000000-0000-0000-0000-000000000000'
WHERE "tenant_id" IS NULL;

ALTER TABLE "audit_log"
ALTER COLUMN "tenant_id" SET NOT NULL;

CREATE OR REPLACE FUNCTION "public"."prevent_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";
CREATE TRIGGER "audit_log_append_only"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW
EXECUTE FUNCTION "public"."prevent_audit_log_mutation"();

DO $$
DECLARE
  schema_name TEXT;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant_%'
  LOOP
    EXECUTE format('ALTER TABLE %I.audit_log ADD COLUMN IF NOT EXISTS metadata JSONB', schema_name);
  END LOOP;
END $$;

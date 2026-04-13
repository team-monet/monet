DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name ~ '^tenant_'
  LOOP
    IF to_regclass(format('%I.memory_versions', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS idx_memory_versions_entry_version ON %I.memory_versions (memory_entry_id, version)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

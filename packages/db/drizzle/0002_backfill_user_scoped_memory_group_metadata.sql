DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name ~ '^tenant_'
  LOOP
    IF to_regclass(format('%I.memory_entries', tenant_schema)) IS NOT NULL
       AND to_regclass(format('%I.agents', tenant_schema)) IS NOT NULL
       AND to_regclass(format('%I.agent_group_members', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          WITH author_groups AS (
            SELECT
              agent_id,
              MIN(group_id) AS group_id,
              COUNT(*) AS group_count
            FROM %I.agent_group_members
            GROUP BY agent_id
          ),
          author_metadata AS (
            SELECT
              agents.id AS agent_id,
              agents.user_id AS user_id,
              author_groups.group_id AS group_id,
              author_groups.group_count AS group_count
            FROM %I.agents AS agents
            LEFT JOIN author_groups ON author_groups.agent_id = agents.id
          )
          UPDATE %I.memory_entries AS memory_entries
          SET
            user_id = COALESCE(memory_entries.user_id, author_metadata.user_id),
            group_id = CASE
              WHEN memory_entries.group_id IS NULL
                   AND author_metadata.group_count = 1
                THEN author_metadata.group_id
              ELSE memory_entries.group_id
            END
          FROM author_metadata
          WHERE memory_entries.memory_scope = 'user'
            AND memory_entries.author_agent_id = author_metadata.agent_id
            AND author_metadata.user_id IS NOT NULL
            AND (
              memory_entries.user_id IS NULL
              OR (
                memory_entries.group_id IS NULL
                AND author_metadata.group_count = 1
              )
            )
        $sql$,
        tenant_schema,
        tenant_schema,
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;

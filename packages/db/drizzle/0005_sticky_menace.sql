ALTER TABLE "rules"
ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rule_set_rules_rule_set_id_rule_id_pk'
  ) THEN
    ALTER TABLE "rule_set_rules"
    ADD CONSTRAINT "rule_set_rules_rule_set_id_rule_id_pk" PRIMARY KEY ("rule_set_id", "rule_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_rule_sets_agent_id_rule_set_id_pk'
  ) THEN
    ALTER TABLE "agent_rule_sets"
    ADD CONSTRAINT "agent_rule_sets_agent_id_rule_set_id_pk" PRIMARY KEY ("agent_id", "rule_set_id");
  END IF;
END $$;

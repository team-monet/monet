ALTER TABLE "rule_sets" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rule_sets_owner_user" ON "rule_sets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rules_owner_user" ON "rules" USING btree ("owner_user_id");

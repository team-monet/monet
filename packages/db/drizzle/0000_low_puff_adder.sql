CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."isolation_mode" AS ENUM('logical', 'physical');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'group_admin', 'tenant_admin');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('group', 'user', 'private');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('decision', 'pattern', 'issue', 'preference', 'fact', 'procedure');--> statement-breakpoint
CREATE TYPE "public"."enrichment_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_group_members" (
	"agent_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(1024) DEFAULT '',
	"memory_quota" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"api_key_hash" varchar(255) NOT NULL,
	"api_key_salt" varchar(255) NOT NULL,
	"is_autonomous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"isolation_mode" "isolation_mode" DEFAULT 'logical' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "agent_rule_sets" (
	"agent_id" uuid NOT NULL,
	"rule_set_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"action" varchar(50) NOT NULL,
	"target_id" varchar(255),
	"outcome" varchar(20) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."prevent_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_audit_log_mutation"();
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"summary" varchar(200),
	"enrichment_status" "enrichment_status" DEFAULT 'pending' NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"memory_scope" "memory_scope" DEFAULT 'group' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"auto_tags" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1536),
	"related_memory_ids" uuid[] DEFAULT '{}' NOT NULL,
	"usefulness_score" integer DEFAULT 0 NOT NULL,
	"outdated" boolean DEFAULT false NOT NULL,
	"ttl_seconds" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_agent_id" uuid NOT NULL,
	"group_id" uuid,
	"user_id" uuid,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_entry_id" uuid NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"author_agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_set_rules" (
	"rule_set_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_group_members" ADD CONSTRAINT "agent_group_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_members" ADD CONSTRAINT "agent_group_members_group_id_agent_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_human_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."human_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_users" ADD CONSTRAINT "human_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_rule_sets" ADD CONSTRAINT "agent_rule_sets_rule_set_id_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_entry_id_memory_entries_id_fk" FOREIGN KEY ("memory_entry_id") REFERENCES "public"."memory_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_set_rules" ADD CONSTRAINT "rule_set_rules_rule_set_id_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_set_rules" ADD CONSTRAINT "rule_set_rules_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_scope" ON "memory_entries" USING btree ("memory_scope");--> statement-breakpoint
CREATE INDEX "idx_memory_type" ON "memory_entries" USING btree ("memory_type");--> statement-breakpoint
CREATE INDEX "idx_memory_author" ON "memory_entries" USING btree ("author_agent_id");--> statement-breakpoint
CREATE INDEX "idx_memory_group" ON "memory_entries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_memory_user" ON "memory_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_memory_expires" ON "memory_entries" USING btree ("expires_at");

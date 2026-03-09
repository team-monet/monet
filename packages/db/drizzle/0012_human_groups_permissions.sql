CREATE TABLE "human_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(1024) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_groups_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "human_group_members" (
	"human_group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_group_members_human_group_id_user_id_pk" PRIMARY KEY("human_group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "human_group_agent_group_permissions" (
	"human_group_id" uuid NOT NULL,
	"agent_group_id" uuid NOT NULL,
	CONSTRAINT "human_group_agent_group_permissions_human_group_id_agent_group_id_pk" PRIMARY KEY("human_group_id","agent_group_id")
);
--> statement-breakpoint
ALTER TABLE "human_groups" ADD CONSTRAINT "human_groups_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "human_group_members" ADD CONSTRAINT "human_group_members_group_fk" FOREIGN KEY ("human_group_id") REFERENCES "public"."human_groups"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "human_group_members" ADD CONSTRAINT "human_group_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."human_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "human_group_agent_group_permissions" ADD CONSTRAINT "human_group_agent_group_permissions_group_fk" FOREIGN KEY ("human_group_id") REFERENCES "public"."human_groups"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "human_group_agent_group_permissions" ADD CONSTRAINT "human_group_agent_group_permissions_agent_group_fk" FOREIGN KEY ("agent_group_id") REFERENCES "public"."agent_groups"("id") ON DELETE no action ON UPDATE no action;

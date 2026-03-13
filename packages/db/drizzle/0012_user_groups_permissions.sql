CREATE TABLE "user_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(1024) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_groups_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "user_group_members" (
	"user_group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_group_members_user_group_id_user_id_pk" PRIMARY KEY("user_group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_group_agent_group_permissions" (
	"user_group_id" uuid NOT NULL,
	"agent_group_id" uuid NOT NULL,
	CONSTRAINT "user_group_agent_group_permissions_user_group_id_agent_group_id_pk" PRIMARY KEY("user_group_id","agent_group_id")
);
--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_fk" FOREIGN KEY ("user_group_id") REFERENCES "public"."user_groups"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_group_agent_group_permissions" ADD CONSTRAINT "user_group_agent_group_permissions_group_fk" FOREIGN KEY ("user_group_id") REFERENCES "public"."user_groups"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_group_agent_group_permissions" ADD CONSTRAINT "user_group_agent_group_permissions_agent_group_fk" FOREIGN KEY ("agent_group_id") REFERENCES "public"."agent_groups"("id") ON DELETE no action ON UPDATE no action;

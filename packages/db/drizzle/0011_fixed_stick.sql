CREATE TABLE "tenant_admin_nominations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"claimed_by_human_user_id" uuid,
	"created_by_platform_admin_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_admin_nominations_tenant_id_email_unique" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "human_users" ADD COLUMN "email" varchar(255);--> statement-breakpoint
ALTER TABLE "human_users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_admin_nominations" ADD CONSTRAINT "tenant_admin_nominations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_admin_nominations" ADD CONSTRAINT "tenant_admin_nominations_claimed_user_fk" FOREIGN KEY ("claimed_by_human_user_id") REFERENCES "public"."human_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_admin_nominations" ADD CONSTRAINT "tenant_admin_nominations_created_admin_fk" FOREIGN KEY ("created_by_platform_admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_users" ADD CONSTRAINT "human_users_tenant_id_external_id_unique" UNIQUE("tenant_id","external_id");

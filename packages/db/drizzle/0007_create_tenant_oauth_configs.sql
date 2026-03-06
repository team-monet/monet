CREATE TABLE IF NOT EXISTS "tenant_oauth_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(50) DEFAULT 'oidc' NOT NULL,
	"issuer" varchar(255) NOT NULL,
	"issuer_url" varchar(512),
	"client_id" varchar(255) NOT NULL,
	"client_secret_encrypted" varchar(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenant_oauth_configs_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "tenant_oauth_configs"
    ADD CONSTRAINT "tenant_oauth_configs_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenant_oauth_configs_tenant_id_unique'
  ) THEN
    ALTER TABLE "tenant_oauth_configs"
    ADD CONSTRAINT "tenant_oauth_configs_tenant_id_unique" UNIQUE("tenant_id");
  END IF;
END $$;

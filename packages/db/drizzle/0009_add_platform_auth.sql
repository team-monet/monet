CREATE TABLE IF NOT EXISTS "platform_oauth_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) DEFAULT 'oidc' NOT NULL,
	"issuer" varchar(255) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret_encrypted" varchar(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"external_id" varchar(255),
	"display_name" varchar(255),
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'platform_admins_email_unique'
  ) THEN
    ALTER TABLE "platform_admins"
    ADD CONSTRAINT "platform_admins_email_unique" UNIQUE("email");
  END IF;
END $$;

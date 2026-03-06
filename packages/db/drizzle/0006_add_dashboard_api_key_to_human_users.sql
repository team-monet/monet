ALTER TABLE "human_users"
ADD COLUMN IF NOT EXISTS "dashboard_api_key_encrypted" varchar(1024);

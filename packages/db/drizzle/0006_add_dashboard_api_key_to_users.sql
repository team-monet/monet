ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "dashboard_api_key_encrypted" varchar(1024);

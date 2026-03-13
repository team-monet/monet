ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "display_name" varchar(255);

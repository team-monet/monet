DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'enrichment_status'
      AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE "public"."enrichment_status" AS ENUM ('pending', 'processing', 'completed', 'failed');
  END IF;
END $$;

ALTER TABLE "memory_entries"
ADD COLUMN IF NOT EXISTS "enrichment_status" "enrichment_status";

UPDATE "memory_entries"
SET "enrichment_status" = CASE
  WHEN "embedding" IS NULL THEN 'pending'::"enrichment_status"
  ELSE 'completed'::"enrichment_status"
END
WHERE "enrichment_status" IS NULL;

ALTER TABLE "memory_entries"
ALTER COLUMN "enrichment_status" SET DEFAULT 'pending';

ALTER TABLE "memory_entries"
ALTER COLUMN "enrichment_status" SET NOT NULL;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" varchar(63);
--> statement-breakpoint
WITH normalized AS (
  SELECT
    id,
    COALESCE(
      NULLIF(
        LEFT(
          REGEXP_REPLACE(
            TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g')),
            '-{2,}',
            '-',
            'g'
          ),
          63
        ),
        ''
      ),
      'tenant'
    ) AS base_slug,
    created_at
  FROM "tenants"
),
ranked AS (
  SELECT
    id,
    base_slug,
    ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY created_at, id) AS slug_rank
  FROM normalized
)
UPDATE "tenants" AS tenants
SET "slug" = CASE
  WHEN ranked.slug_rank = 1 THEN ranked.base_slug
  ELSE LEFT(ranked.base_slug, 54) || '-' || SUBSTRING(tenants.id::text, 1, 8)
END
FROM ranked
WHERE tenants.id = ranked.id
  AND tenants.slug IS NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_slug_unique'
  ) THEN
    ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_slug_unique" UNIQUE("slug");
  END IF;
END $$;

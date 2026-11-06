-- ============================================================================
-- Migration 026: Case-insensitive serial uniqueness (owner-scoped)
--
-- PHASE 7G — LOCAL DRAFT ONLY.
-- This migration has NOT been applied to any database and has NOT been tested
-- against PostgreSQL. Do not apply to production without review.
--
-- CONTEXT
--   Migration 000 created a case-sensitive unique index on
--   (owner_id, serial_number), and only when no legacy duplicates existed.
--   Migration 022/025 detect group-serial duplicates with LOWER(TRIM(...)),
--   so `ABC001` and `abc001` are treated as duplicates by the application while
--   the database index alone would allow both.
--
-- THIS MIGRATION
--   1. Fails loudly if any owner already has serials that differ only by case
--      (or surrounding whitespace). It never merges, rewrites, or deletes data.
--   2. Creates a unique index on (owner_id, lower(btrim(serial_number))).
--   3. Removes the now-redundant case-sensitive unique index, if it exists.
--
-- PREREQUISITES: 000 -> 022 -> 024 -> 025.
-- ============================================================================

-- 1. Pre-flight: refuse to continue if legacy case-only duplicates exist.
DO $$
DECLARE
  v_duplicate_groups bigint;
BEGIN
  SELECT count(*) INTO v_duplicate_groups
  FROM (
    SELECT 1
    FROM public.product_serials
    GROUP BY owner_id, lower(btrim(serial_number))
    HAVING count(*) > 1
  ) AS duplicates;

  IF v_duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'DUPLICATE_SERIAL_CASE_INSENSITIVE: % owner/serial group(s) contain serials that differ only by case or surrounding whitespace. Reconcile them manually before applying migration 026.',
      v_duplicate_groups
      USING errcode = 'P0007';
  END IF;
END $$;

-- 2. Owner-scoped, case-insensitive uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS product_serials_owner_lower_serial_number_key
  ON public.product_serials (owner_id, lower(btrim(serial_number)));

-- 3. Drop the superseded case-sensitive unique index (created by migration 000).
--    Safe to skip on databases where the legacy guard skipped it.
DROP INDEX IF EXISTS public.product_serials_owner_serial_number_key;

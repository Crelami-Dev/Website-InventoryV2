-- ============================================================================
-- Script: Audit Case-Insensitive Serial Duplicates (Pre-flight for Migration 026)
--
-- PURPOSE:
--   Before applying migration 026 (product_serials_owner_lower_serial_number_key),
--   verify whether any tenant has serial numbers that differ only by letter case
--   or surrounding whitespace (e.g. 'SN-001' vs 'sn-001' or 'SN-001 ').
--
-- SAFETY:
--   READ-ONLY. This script never modifies, updates, or deletes any data.
-- ============================================================================

-- 1. Count duplicate groups
SELECT 
  count(*) AS total_duplicate_groups
FROM (
  SELECT 
    owner_id, 
    lower(btrim(serial_number)) AS normalized_serial_number
  FROM public.product_serials
  GROUP BY owner_id, lower(btrim(serial_number))
  HAVING count(*) > 1
) AS duplicate_groups;

-- 2. Detailed list of conflicting serial records (if any)
SELECT 
  owner_id,
  lower(btrim(serial_number)) AS normalized_serial_number,
  count(*) AS occurrence_count,
  array_agg(id) AS serial_ids,
  array_agg(serial_number) AS distinct_representations,
  array_agg(status) AS serial_statuses,
  array_agg(created_at ORDER BY created_at ASC) AS creation_timestamps
FROM public.product_serials
GROUP BY owner_id, lower(btrim(serial_number))
HAVING count(*) > 1
ORDER BY occurrence_count DESC, normalized_serial_number ASC;

-- 3. Remediation instructions if duplicate groups > 0:
--    If duplicates are found:
--    a. Inspect which serial is active ('available', 'reserved', 'out') vs 'dissolved'.
--    b. If historical duplicates exist from old unconstrained inputs, rename or reconcile
--       the inactive duplicates manually with tenant approval before applying Migration 026.
--    c. If duplicate_groups = 0, Migration 026 can be applied safely with zero friction.

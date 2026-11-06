-- ============================================================================
-- 023_daily_report_email_logs_idempotency.sql
-- Penambahan kolom identitas tenant & tanggal laporan pada public.email_logs
-- serta unique partial index untuk atomic claim & lease concurrency Daily Report.
--
-- Dibuat untuk DocuFlow Phase 2A (Idempotensi Per-Owner & Atomic Claim).
-- AMAN & NON-BLOCKING:
-- 1. Seluruh kolom baru bersifat NULLABLE agar kompatibel dengan data historis.
-- 2. Index bersifat PARTIAL sehingga hanya mengunci daily_report resmi (bukan test).
-- 3. Tidak memblokir email PO, Goods In, Goods Out, maupun Retur.
-- ============================================================================

-- 1. Penambahan kolom identitas terstruktur
ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS owner_id UUID;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS report_date DATE;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS trigger_source TEXT;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- 2. Komentar kolom untuk dokumentasi schema
COMMENT ON COLUMN public.email_logs.owner_id IS
  'ID tenant pemilik email laporan atau dokumen. NULL untuk log sistem lama.';

COMMENT ON COLUMN public.email_logs.report_date IS
  'Tanggal operasional laporan harian (YYYY-MM-DD). NULL untuk non-daily-report.';

COMMENT ON COLUMN public.email_logs.trigger_source IS
  'Sumber pemicu pengiriman email: cron, manual, test, retry.';

COMMENT ON COLUMN public.email_logs.idempotency_key IS
  'Kunci idempotensi deterministik untuk mencegah duplikasi (daily_report:owner_id:date).';

-- 3. Backfill data historis PO dan Dokumen (Hanya jika relasi tersedia)
-- A. Backfill owner_id untuk log Purchase Order lama
UPDATE public.email_logs el
SET owner_id = po.owner_id
FROM public.purchase_orders po
WHERE el.purchase_order_id = po.id
  AND el.owner_id IS NULL;

-- B. Backfill owner_id untuk log Dokumen Goods In / Goods Out / Return lama
UPDATE public.email_logs el
SET owner_id = doc.owner_id
FROM public.documents doc
WHERE el.document_id = doc.id
  AND el.owner_id IS NULL;

-- 4. Pembuatan Index Bersyarat (Partial Unique Index)
-- Menjamin tepat 1 klaim aktif atau selesai per (owner_id, report_date) untuk Daily Report resmi.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_daily_report_claim_unique
  ON public.email_logs (owner_id, report_date)
  WHERE email_type = 'daily_report'
    AND owner_id IS NOT NULL
    AND report_date IS NOT NULL
    AND (trigger_source IS NULL OR trigger_source != 'test');

-- Index pencarian riwayat email tenant cepat di UI workspace
CREATE INDEX IF NOT EXISTS idx_email_logs_owner_history
  ON public.email_logs (owner_id, email_type, created_at DESC)
  WHERE owner_id IS NOT NULL;

-- Index pencarian idempotency key deterministik
CREATE INDEX IF NOT EXISTS idx_email_logs_idempotency_lookup
  ON public.email_logs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

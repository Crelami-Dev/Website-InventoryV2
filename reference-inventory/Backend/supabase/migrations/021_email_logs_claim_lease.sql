-- ============================================================================
-- 021_email_logs_claim_lease.sql
-- Production hardening untuk email_logs:
-- 1. Menambahkan kolom retry_count/last_retry_at jika migrasi 007 belum jalan.
-- 2. Menambahkan last_attempt_at sebagai lease klaim worker.
-- 3. Menandai log pending lama agar bisa dipulihkan tanpa mengirim ulang
--    email yang mungkin sudah terkirim (status menjadi 'uncertain').
-- 4. Index untuk retry dan pemulihan lease.
--
-- Catatan: migration ini TIDAK mengubah transaksi retur/stok. Hanya metadata
-- pengiriman email. Aman dijalankan berulang kali (idempotent).
-- ============================================================================

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Log pending yang sudah ada diberi lease dari created_at. Statusnya tidak
-- diubah di sini; worker akan menandainya 'uncertain' setelah lease kedaluwarsa.
UPDATE public.email_logs
SET last_attempt_at = created_at
WHERE status = 'pending'
  AND last_attempt_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_logs_retry_pending
  ON public.email_logs (created_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_email_logs_pending_lease
  ON public.email_logs (last_attempt_at)
  WHERE status = 'pending';

COMMENT ON COLUMN public.email_logs.retry_count IS
  'Jumlah percobaan retry yang sudah dilakukan cron worker.';

COMMENT ON COLUMN public.email_logs.last_attempt_at IS
  'Waktu klaim terakhir worker. Dipakai sebagai lease agar dua worker tidak mengirim email yang sama.';

COMMENT ON COLUMN public.email_logs.last_retry_at IS
  'Waktu retry gagal terakhir yang dicatat cron worker.';

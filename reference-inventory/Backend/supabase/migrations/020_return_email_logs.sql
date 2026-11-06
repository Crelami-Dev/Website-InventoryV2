-- ============================================================================
-- 020_return_email_logs.sql
-- Menambahkan penanda email khusus retur pada public.email_logs agar:
-- 1. Notifikasi retur tidak bercampur dengan status email dokumen asli
--    (Goods In / Goods Out).
-- 2. Retry worker tidak mengirim ulang email retur yang sudah sukses.
-- 3. Satu retur hanya boleh memiliki satu baris log (idempoten).
-- ============================================================================

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS return_id UUID;

ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS email_type TEXT;

-- Satu log per retur. return_id berasal dari documents.metadata->'returns',
-- sehingga tidak memakai foreign key (bukan tabel mandiri).
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_return_unique
  ON public.email_logs (document_id, return_id)
  WHERE return_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_logs_type_status
  ON public.email_logs (email_type, status, created_at DESC);

COMMENT ON COLUMN public.email_logs.return_id IS
  'ID retur dari documents.metadata->returns[].id; NULL untuk email dokumen biasa.';
COMMENT ON COLUMN public.email_logs.email_type IS
  'Jenis email: document (default lama), return, daily_report, dan sebagainya.';

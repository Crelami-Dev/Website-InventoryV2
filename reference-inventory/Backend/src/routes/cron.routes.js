import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { resendPOEmail } from './purchase-order.routes.js';
import { resendDocumentEmail, resendReturnEmail } from './workspace.routes.js';
import { sendDailyReportEmail } from '../services/dailyReport.service.js';
import { recoverStalePendingReturnEmails } from '../services/email.service.js';

const router = Router();
const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// GET|POST /api/cron/retry-emails — retry worker untuk email_logs yang gagal.
//
// Dirancang khusus untuk Vercel Serverless Free Tier:
// - TIDAK ada proses background/daemon (setInterval dsb). Endpoint ini dipicu
//   dari luar (Vercel Cron, atau cron eksternal seperti cron-job.org) dan
//   menyelesaikan SELURUH pekerjaannya dalam satu request/response.
// - Batch kecil (maks 3 baris per run) + penjaga waktu (TIME_BUDGET_MS) agar
//   selesai jauh di bawah limit 10 detik Vercel Free — begitu mendekati
//   budget waktu, loop dihentikan lebih awal dan progress yang sudah
//   diproses tetap dikembalikan (bukan all-or-nothing).
// - Proteksi: wajib header `Authorization: Bearer <CRON_SECRET>`. Tanpa
//   CRON_SECRET ter-konfigurasi di environment, endpoint menolak SEMUA
//   request (fail closed, bukan fail open).
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 3; // maksimal email gagal yang diproses per run
const PENDING_RECOVERY_LIMIT = 20; // update DB saja, tidak mengirim email
const MAX_RETRY_COUNT = 3; // jangan retry lagi setelah retry_count mencapai ini
const EXPIRY_HOURS = 24; // abaikan email gagal yang sudah lebih tua dari ini
const TIME_BUDGET_MS = 7000; // hard stop internal (Vercel Free hard-kill di 10s)

function readBearerToken(header) {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

function requireCronSecret(req, res, next) {
  // Fail closed: jika CRON_SECRET belum di-set di environment, tolak semua
  // request tanpa terkecuali — jangan pernah membuat endpoint ini "terbuka".
  if (!env.CRON_SECRET) {
    return res.status(503).json({
      success: false,
      error: 'CRON_SECRET is not configured on the server. Set it in environment variables to enable this endpoint.',
    });
  }

  const token = readBearerToken(req.headers.authorization);
  if (!token || token !== env.CRON_SECRET) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid or missing cron secret.' });
  }

  next();
}

/**
 * Deteksi kolom retry (retry_count / last_retry_at) belum ada di database
 * (migrasi 007 belum dijalankan). Supabase/PostgREST mengembalikan kode
 * error '42703' (undefined_column) untuk kasus ini.
 */
function isMissingColumnError(error) {
  const message = error?.message || '';
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the .*column/i.test(message)
  );
}

/**
 * Ambil batch baris email_logs yang gagal & layak di-retry.
 * Mencoba select dengan kolom retry_count/last_retry_at terlebih dahulu;
 * jika kolom belum ada (migrasi belum jalan), fallback ke select tanpa
 * kolom tsb dan anggap retry_count = 0 untuk semua baris (aman: hanya
 * berarti guard "retry_count < 3" tidak aktif sampai migrasi dijalankan).
 */
async function fetchRetryBatch(cutoffIso) {
  const withRetryCols = await supabaseAdmin
    .from('email_logs')
    .select('id, purchase_order_id, document_id, return_id, email_type, retry_count, created_at')
    .eq('status', 'failed')
    .or('purchase_order_id.not.is.null,document_id.not.is.null')
    .lt('retry_count', MAX_RETRY_COUNT)
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (!withRetryCols.error) {
    return { rows: withRetryCols.data || [], hasRetryColumns: true };
  }

  if (!isMissingColumnError(withRetryCols.error)) {
    throw withRetryCols.error;
  }

  // Fallback: kolom retry_count/last_retry_at belum ada di database.
  const fallback = await supabaseAdmin
    .from('email_logs')
    .select('id, purchase_order_id, document_id, return_id, email_type, created_at')
    .eq('status', 'failed')
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (!fallback.error) {
    return {
      rows: (fallback.data || []).map((row) => ({ ...row, retry_count: 0 })),
      hasRetryColumns: false,
    };
  }

  if (!isMissingColumnError(fallback.error)) {
    throw fallback.error;
  }

  // Fallback terakhir: database lama tanpa kolom retur maupun retry.
  const minimalFallback = await supabaseAdmin
    .from('email_logs')
    .select('id, purchase_order_id, document_id, created_at')
    .eq('status', 'failed')
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (minimalFallback.error) throw minimalFallback.error;
  return {
    rows: (minimalFallback.data || []).map((row) => ({
      ...row,
      return_id: null,
      email_type: null,
      retry_count: 0,
    })),
    hasRetryColumns: false,
  };
}

/**
 * Simpan hasil retry ke email_logs. Jika kolom retry_count/last_retry_at
 * belum ada (migrasi belum jalan), update hanya kolom dasar (status,
 * sent_at, error_message) agar tetap tidak crash.
 */
async function persistRetryOutcome({ logId, hasRetryColumns, currentRetryCount, sendResult }) {
  const nowIso = new Date().toISOString();
  const succeeded = sendResult?.status === 'sent';

  const basePatch = succeeded
    ? { status: 'sent', sent_at: nowIso, error_message: null }
    : { status: 'failed', error_message: sendResult?.error ?? 'Unknown error during retry.' };

  const patch = hasRetryColumns
    ? {
        ...basePatch,
        retry_count: currentRetryCount + 1,
        ...(succeeded ? {} : { last_retry_at: nowIso }),
      }
    : basePatch;

  const { error } = await supabaseAdmin.from('email_logs').update(patch).eq('id', logId);
  if (error && hasRetryColumns && isMissingColumnError(error)) {
    // Race/edge case: kolom hilang di antara fetch & update. Fallback ke basePatch saja.
    await supabaseAdmin.from('email_logs').update(basePatch).eq('id', logId);
    return;
  }
  if (error) throw error;
}

/**
 * Proses satu baris email_logs yang gagal: resolve PO/dokumen terkait,
 * generate ulang PDF, dan kirim ulang via sendPOEmail/sendGoodsInEmail/
 * sendGoodsOutEmail (yang masing-masing sudah memakai sendMailWithRetry
 * dengan exponential backoff di dalamnya).
 */
async function retryOneLog(log) {
  if (log.purchase_order_id) {
    const po = await getPOByIdForOwnerSafe(log.purchase_order_id);
    if (!po) {
      return { status: 'failed', error: 'Purchase order not found (mungkin sudah dihapus).' };
    }
    return resendPOEmail(po, { ownerId: po.owner_id });
  }

  if (log.document_id) {
    const doc = await getDocumentRowSafe(log.document_id);
    if (!doc) {
      return { status: 'failed', error: 'Document not found (mungkin sudah dihapus).' };
    }

    if (log.email_type === 'return' || log.return_id) {
      const returnRecord = (doc.metadata?.returns || []).find((ret) => ret?.id === log.return_id);
      if (!returnRecord) {
        return { status: 'failed', error: 'Data retur tidak ditemukan (mungkin sudah dibatalkan/dipulihkan).' };
      }
      return resendReturnEmail(doc, returnRecord, {
        ownerId: doc.owner_id,
        existingLogId: log.id,
      });
    }

    return resendDocumentEmail(doc, { ownerId: doc.owner_id });
  }

  return { status: 'failed', error: 'email_logs row has neither purchase_order_id nor document_id.' };
}

// Cron worker belum tahu owner_id di muka (baru diketahui dari baris email_logs
// -> PO/dokumen terkait), jadi ambil row langsung by id tanpa owner filter.
// Ini tetap aman: cron berjalan dengan supabaseAdmin (service role), dan
// resendPOEmail/resendDocumentEmail dipanggil dengan ownerId hasil row ini
// (bukan input dari luar), sehingga tidak ada jalur untuk cross-tenant leakage.
async function getPOByIdForOwnerSafe(id) {
  const { data, error } = await supabaseAdmin
    .from('purchase_orders')
    .select('id, po_number, po_date, vendor_name, sales_person_id, status, notes, owner_id, created_at, updated_at, items:purchase_order_items(id, item_name, sku, qty)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data;
}

async function getDocumentRowSafe(id) {
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('*, items:document_items(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data;
}

router.get('/retry-emails', requireCronSecret, handleRetryEmails);
router.post('/retry-emails', requireCronSecret, handleRetryEmails);

async function handleRetryEmails(req, res) {
  const startedAt = Date.now();
  const cutoffIso = new Date(startedAt - EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let pendingRecovery = { supported: false, scanned: 0, recovered: 0 };
  const details = [];

  try {
    // Pulihkan log pending yang lease-nya kedaluwarsa. Ini TIDAK mengirim
    // ulang email, hanya menandai `uncertain` agar retry otomatis tidak
    // berpotensi membuat duplikat.
    try {
      pendingRecovery = await recoverStalePendingReturnEmails({ limit: PENDING_RECOVERY_LIMIT });
    } catch (recoveryError) {
      console.error(
        '[cron/retry-emails] pending recovery failed:',
        recoveryError?.message ?? recoveryError
      );
    }

    const { rows, hasRetryColumns } = await fetchRetryBatch(cutoffIso);

    for (const log of rows) {
      // Safety/timeout guard: berhenti lebih awal jika mendekati budget waktu,
      // agar tidak terkena hard-kill 10 detik Vercel Free. Progress yang sudah
      // diproses sejauh ini tetap disimpan & dikembalikan di response.
      if (Date.now() - startedAt >= TIME_BUDGET_MS) {
        details.push({ logId: log.id, skipped: true, reason: 'time_budget_exceeded' });
        break;
      }

      processed += 1;
      try {
        const sendResult = await retryOneLog(log);

        // Return email yang ternyata sudah terkirim / sedang dikirim worker lain
        // tidak boleh diubah menjadi failed dan tidak boleh dikirim ulang.
        if (sendResult?.status === 'skipped') {
          details.push({ logId: log.id, status: 'skipped', reason: sendResult.reason ?? null });
          continue;
        }

        await persistRetryOutcome({
          logId: log.id,
          hasRetryColumns,
          currentRetryCount: log.retry_count ?? 0,
          sendResult,
        });

        if (sendResult?.status === 'sent') {
          succeeded += 1;
          details.push({ logId: log.id, status: 'sent' });
        } else {
          failed += 1;
          details.push({ logId: log.id, status: 'failed', error: sendResult?.error ?? null });
        }
      } catch (rowErr) {
        // Kegagalan tak terduga (mis. PDF generation throw, DB error) tetap
        // dicatat ke email_logs sebagai failed agar retry_count naik dan baris
        // ini tidak diambil lagi tanpa batas oleh run berikutnya.
        failed += 1;
        const errorMessage = rowErr?.message ?? String(rowErr);
        details.push({ logId: log.id, status: 'failed', error: errorMessage });
        try {
          await persistRetryOutcome({
            logId: log.id,
            hasRetryColumns,
            currentRetryCount: log.retry_count ?? 0,
            sendResult: { status: 'failed', error: errorMessage },
          });
        } catch (persistErr) {
          console.error('[cron/retry-emails] failed to persist error outcome:', persistErr?.message ?? persistErr);
        }
      }
    }

    res.json({
      success: true,
      processed,
      succeeded,
      failed,
      pendingRecovery,
      durationMs: Date.now() - startedAt,
      ...(env.NODE_ENV !== 'production' ? { details } : {}),
    });
  } catch (error) {
    // Kegagalan di level batch (mis. query awal gagal) — jangan pernah crash
    // function Vercel; selalu kembalikan JSON yang jelas.
    console.error('[cron/retry-emails] fatal error:', error?.message ?? error);
    res.status(500).json({
      success: false,
      error: error?.message ?? 'Unknown error while retrying failed emails.',
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// GET|POST /api/cron/daily-report — cron worker untuk laporan harian otomatis
// ---------------------------------------------------------------------------

router.get('/daily-report', requireCronSecret, handleDailyReportCron);
router.post('/daily-report', requireCronSecret, handleDailyReportCron);

async function handleDailyReportCron(req, res) {
  const startedAt = Date.now();
  try {
    const force = req.query.force === 'true';
    const dryRun = req.query.dryRun === 'true';
    const dateStr = req.query.date || null;
    const targetOwnerQuery = req.query.ownerId || null;

    // Current time in Asia/Jakarta
    const now = new Date();
    const wibFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const currentWibTime = wibFormatter.format(now); // e.g. "12:00"
    const [currH, currM] = currentWibTime.split(':').map(Number);
    const currMinutes = (currH || 0) * 60 + (currM || 0);

    // 1. Verifikasi Super Admin aktif di database (Otorisasi ketat)
    const { data: activeSuperAdmins, error: saError } = await supabaseAdmin
      .from('profiles')
      .select('id, owner_id, role, status')
      .eq('role', 'super_admin')
      .neq('status', 'disabled');

    if (saError || !activeSuperAdmins || activeSuperAdmins.length === 0) {
      return res.json({
        success: true,
        executed: false,
        reason: 'Tidak ada akun Super Admin aktif yang berwenang untuk menjalankan laporan harian otomatis.',
        durationMs: Date.now() - startedAt,
      });
    }

    // 2. Evaluasi jadwal pengiriman global DocuFlow (19:00 WIB)
    const scheduleTime = '19:00';
    const [schH, schM] = scheduleTime.split(':').map(Number);
    const schedMinutes = (schH || 0) * 60 + (schM || 0);

    if (currMinutes < schedMinutes && !force) {
      return res.json({
        success: true,
        executed: false,
        status: 'skipped',
        reason: `Jadwal belum tercapai. Waktu saat ini: ${currentWibTime} WIB, Jadwal: ${scheduleTime} WIB.`,
        scheduleTime,
        durationMs: Date.now() - startedAt,
      });
    }

    // 3. Ambil seluruh profil tenant owner aktif
    let ownersQuery = supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, status, owner_id')
      .in('role', ['owner', 'super_admin'])
      .neq('status', 'disabled');

    if (targetOwnerQuery) {
      ownersQuery = ownersQuery.eq('owner_id', targetOwnerQuery);
    }

    const { data: rawProfiles, error: ownersError } = await ownersQuery.order('full_name');
    if (ownersError) {
      throw new Error(`Gagal memuat profiles owner: ${ownersError.message}`);
    }

    // Deduplikasi owner berdasarkan owner_id (kecualikan tenant Super Admin placeholder)
    const owners = [];
    const seenOwnerIds = new Set();
    for (const p of rawProfiles || []) {
      if (p.owner_id && !seenOwnerIds.has(p.owner_id) && p.owner_id !== SUPER_ADMIN_TENANT_ID) {
        seenOwnerIds.add(p.owner_id);
        owners.push(p);
      }
    }

    if (owners.length === 0) {
      return res.json({
        success: true,
        executed: false,
        reason: 'Tidak ada tenant owner aktif yang ditemukan.',
        durationMs: Date.now() - startedAt,
      });
    }

    // 4. Ambil pengaturan daily_report_settings per owner (termasuk legacy setting Super Admin)
    const allOwnerIds = owners.map((o) => o.owner_id);
    const { data: dbSettings, error: settingError } = await supabaseAdmin
      .from('workspace_settings')
      .select('owner_id, value')
      .in('owner_id', [...allOwnerIds, SUPER_ADMIN_TENANT_ID])
      .eq('key', 'daily_report_settings');

    if (settingError) {
      throw new Error(`Failed to load daily report settings: ${settingError.message}`);
    }

    const settingsByOwner = new Map();
    let legacySuperAdminSetting = null;
    for (const row of dbSettings || []) {
      if (row.owner_id === SUPER_ADMIN_TENANT_ID) {
        legacySuperAdminSetting = row.value;
      } else {
        settingsByOwner.set(row.owner_id, row.value);
      }
    }

    // 5. Proses setiap owner secara independen
    const results = [];

    for (const owner of owners) {
      const ownerId = owner.owner_id;
      const ownerName = owner.full_name || 'Owner';

      // Settings per owner, dengan fallback ke legacy setting jika sebelumnya dikonfigurasi sebagai authorizedOwnerId
      let settings = settingsByOwner.get(ownerId);
      if (!settings && legacySuperAdminSetting && legacySuperAdminSetting.authorizedOwnerId === ownerId) {
        settings = legacySuperAdminSetting;
      }

      const isEnabled = Boolean(settings?.enabled);

      // Keamanan Phase 1: Owner berstatus OFF TIDAK BOLEH dikirimi email otomatis,
      // sekalipun endpoint cron dipanggil dengan query parameter force=true.
      if (!isEnabled) {
        results.push({
          ownerId,
          ownerName,
          executed: false,
          status: 'skipped',
          reason: 'Laporan harian dinonaktifkan (OFF) untuk tenant ini.',
        });
        continue;
      }

      const includeGoodsIn = settings?.includeGoodsIn !== false;
      const includeGoodsOut = settings?.includeGoodsOut !== false;
      const includeReturns = settings?.includeReturns !== false;
      const useCompanyEmail = settings?.useCompanyEmail !== false;
      const recipients = settings?.customRecipients ? settings.customRecipients : null;

      try {
        const sendResult = await sendDailyReportEmail({
          ownerId,
          dateStr,
          recipients,
          useCompanyEmail,
          includeGoodsIn,
          includeGoodsOut,
          includeReturns,
          isTest: false,
          force: false, // Cron otomatis wajib menjaga idempotensi harian (jangan bypass idempotensi via force)
          dryRun,
          triggerSource: 'cron',
        });

        results.push({
          ownerId,
          ownerName,
          executed: sendResult.status === 'sent',
          status: sendResult.status,
          subject: sendResult.subject,
          primaryRecipient: sendResult.primaryRecipient,
          targetDate: sendResult.targetDate,
          message: sendResult.message || null,
          error: sendResult.error || null,
        });
      } catch (sendErr) {
        results.push({
          ownerId,
          ownerName,
          executed: false,
          status: 'failed',
          error: sendErr.message,
        });
      }
    }

    const totalOwners = results.length;
    const sentCount = results.filter((r) => r.status === 'sent').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    const anyExecuted = sentCount > 0;

    res.json({
      success: true,
      executed: anyExecuted,
      scheduleTime,
      totalOwners,
      sentCount,
      failedCount,
      skippedCount,
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[cron/daily-report] fatal error:', error?.message ?? error);
    res.status(500).json({
      success: false,
      error: error?.message ?? 'Unknown error in daily report cron.',
      durationMs: Date.now() - startedAt,
    });
  }
}

export default router;

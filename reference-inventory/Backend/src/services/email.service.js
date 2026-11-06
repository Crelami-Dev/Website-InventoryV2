import nodemailer from 'nodemailer';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { generateReturnPdfCompact } from './pdf.service.js';
import { resolveDocumentItemQuantity } from '../utils/documentQuantity.js';

const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Transporter reusable untuk semua email, dengan auto-reconnect.
 * Jika SMTP env tidak ter-set, return null
 * sehingga pengirim email di-skip (status: failed, error tercatat).
 *
 * Catatan stabilitas koneksi:
 * - Pool tetap dipakai untuk efisiensi, namun `resetTransporter()` disediakan
 *   untuk membuang transporter yang socket-nya sudah basi/mati (mis. setelah
 *   idle lama dan diputus paksa oleh server SMTP), sehingga percobaan kirim
 *   berikutnya membuat koneksi baru alih-alih memakai socket yang sudah mati.
 * - Timeout diatur secara eksplisit agar kegagalan koneksi terdeteksi cepat
 *   (bukan menggantung tanpa batas) sehingga retry bisa segera dilakukan.
 */
let _transporter = null;

function readSmtpEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Konfigurasi SMTP dibaca langsung dari environment process, sehingga nilai
 * yang di-set di Vercel Project Settings (Production/Preview) otomatis dipakai
 * tanpa file .env lokal. Nilai di-trim agar spasi tidak sengaja dari dashboard
 * tidak membuat autentikasi gagal.
 */
export function getSmtpConfig() {
  const host = readSmtpEnv('SMTP_HOST');
  const user = readSmtpEnv('SMTP_USER');
  const pass = readSmtpEnv('SMTP_PASS');
  const port = Number(readSmtpEnv('SMTP_PORT')) || 587;
  const secure = readSmtpEnv('SMTP_SECURE').toLowerCase() === 'true' || port === 465;

  return {
    host,
    user,
    pass,
    port,
    secure,
    from: readSmtpEnv('SMTP_FROM') || user,
    tlsRejectUnauthorized: readSmtpEnv('SMTP_TLS_REJECT_UNAUTHORIZED').toLowerCase() !== 'false',
  };
}

export function getSmtpFromAddress() {
  return getSmtpConfig().from || 'no-reply@docuflow.app';
}

function buildTransporter() {
  const config = getSmtpConfig();
  if (!config.host || !config.user || !config.pass) return null;

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // TLS: pastikan sertifikat divalidasi (default aman), tapi izinkan
    // override via env untuk host SMTP internal/self-signed bila memang perlu.
    tls: {
      rejectUnauthorized: config.tlsRejectUnauthorized,
      minVersion: 'TLSv1.2',
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    rateDelta: 1000,
    rateLimit: 2,
    // Timeout eksplisit agar socket yang basi/hang tidak menggantung lama
    // dan gagal cepat sehingga sendMailWithRetry bisa segera mencoba ulang.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

export function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = buildTransporter();
  return _transporter;
}

/**
 * Buang transporter yang sedang aktif (mis. karena error socket seperti
 * ECONNRESET/ETIMEDOUT/socket hang up). Panggilan getTransporter() berikutnya
 * akan membuat koneksi baru dari awal, sehingga tidak ada percobaan memakai
 * socket TCP yang sudah diputus oleh server SMTP.
 */
function resetTransporter() {
  if (_transporter) {
    try {
      _transporter.close();
    } catch (_) {}
    _transporter = null;
  }
}

export function closeTransporter() {
  resetTransporter();
}

/**
 * Error yang bersifat sementara (jaringan/socket) dan layak di-retry.
 * Bukan error permanen seperti auth gagal atau alamat email invalid.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENOTFOUND',
]);

function isTransientMailError(err) {
  if (!err) return false;
  const code = err.code || err.errno;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = String(err.message || '').toLowerCase();
  return (
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('esockettimedout') ||
    message.includes('epipe') ||
    message.includes('eai_again') ||
    message.includes('connection closed') ||
    message.includes('connection timeout') ||
    message.includes('greeting never received')
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper pengiriman email dengan retry otomatis + exponential backoff.
 * - Percobaan gagal karena error sementara (socket/koneksi) akan me-reset
 *   transporter (agar tidak memakai socket basi) lalu mencoba ulang setelah
 *   jeda 1s, 2s, 4s, ... hingga maxRetries.
 * - Error non-transient (mis. auth gagal, alamat invalid secara permanen)
 *   langsung dilempar tanpa retry karena mengulang tidak akan membantu.
 *
 * @param {Object} mailOptions - opsi sendMail milik Nodemailer
 * @param {number} maxRetries - jumlah maksimum percobaan (default 3)
 * @returns {Promise<Object>} info hasil sendMail jika sukses
 * @throws akan melempar error terakhir jika seluruh percobaan gagal
 */
export async function sendMailWithRetry(mailOptions, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const transporter = getTransporter();
    if (!transporter) {
      throw new Error('SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing).');
    }

    try {
      const info = await transporter.sendMail(mailOptions);
      return info;
    } catch (err) {
      lastError = err;
      const transient = isTransientMailError(err);

      // Selalu reset transporter pada error agar koneksi/pool yang mungkin
      // rusak tidak terus dipakai di percobaan berikutnya.
      resetTransporter();

      if (!transient || attempt === maxRetries) {
        break;
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, ...
      await delay(backoffMs);
    }
  }

  throw lastError;
}

/**
 * Validasi sederhana alamat email penerima.
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed) return false;
  // Validasi format dasar, cukup untuk mencegah nilai kosong/rusak terkirim ke SMTP.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Ambil email Finance dari workspace_settings (key: 'finance_email').
 * Pertama cari workspace-specific (owner_id); fallback ke global (owner_id = SUPER_ADMIN).
 */
export async function resolveFinanceEmail(ownerId) {
  if (!ownerId) return null;

  if (ownerId && ownerId !== SUPER_ADMIN_TENANT_ID) {
    const { data: rows } = await supabaseAdmin
      .from('workspace_settings')
      .select('key, value, updated_at')
      .eq('owner_id', ownerId)
      .in('key', ['app', 'company', 'finance_email']);

    let appEmail = null;
    let appUpdated = 0;
    let compEmail = null;
    let compUpdated = 0;

    for (const r of rows || []) {
      const updatedTime = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      if (r.key === 'app') {
        const val = r.value?.company || r.value;
        appEmail = val?.companyEmail || val?.email || null;
        appUpdated = updatedTime;
      }
      if (r.key === 'company') {
        const val = r.value?.company || r.value;
        compEmail = val?.companyEmail || val?.email || null;
        compUpdated = updatedTime;
      }
    }

    if (appEmail && compEmail) {
      return appUpdated >= compUpdated ? appEmail : compEmail;
    }
    if (appEmail) return appEmail;
    if (compEmail) return compEmail;

    // Fallback ke key 'finance_email'
    const finSetting = (rows || []).find((s) => s.key === 'finance_email');
    if (finSetting?.value?.email) return finSetting.value.email;
    if (typeof finSetting?.value === 'string') return finSetting.value;
  }

  // 4. Fallback global
  const { data: globalComp } = await supabaseAdmin
    .from('workspace_settings')
    .select('value')
    .eq('owner_id', SUPER_ADMIN_TENANT_ID)
    .eq('key', 'company')
    .maybeSingle();
  if (globalComp?.value) {
    const email =
      globalComp.value.companyEmail ||
      globalComp.value.email ||
      globalComp.value.company?.companyEmail ||
      globalComp.value.company?.email;
    if (email) return email;
  }

  const { data: globalFin } = await supabaseAdmin
    .from('workspace_settings')
    .select('value')
    .eq('owner_id', SUPER_ADMIN_TENANT_ID)
    .eq('key', 'finance_email')
    .maybeSingle();
  return globalFin?.value?.email ?? (typeof globalFin?.value === 'string' ? globalFin.value : null);
}

const PALETTE_COLORS = {
  indigo: { primary: '#6366F1', hover: '#4F46E5', light: 'rgba(99, 102, 241, 0.08)', shadow: 'rgba(99, 102, 241, 0.25)' },
  emerald: { primary: '#10B981', hover: '#059669', light: 'rgba(16, 185, 129, 0.08)', shadow: 'rgba(16, 185, 129, 0.25)' },
  rose: { primary: '#F43F5E', hover: '#E11D48', light: 'rgba(244, 63, 94, 0.08)', shadow: 'rgba(244, 63, 94, 0.25)' },
  amber: { primary: '#F59E0B', hover: '#D97706', light: 'rgba(245, 158, 11, 0.08)', shadow: 'rgba(245, 158, 11, 0.25)' },
  sky: { primary: '#0EA5E9', hover: '#0284C7', light: 'rgba(14, 165, 233, 0.08)', shadow: 'rgba(14, 165, 233, 0.25)' },
  violet: { primary: '#8B5CF6', hover: '#7C3AED', light: 'rgba(139, 92, 246, 0.08)', shadow: 'rgba(139, 92, 246, 0.25)' },
};

/**
 * Kirim email PO lengkap dengan attachment PDF.
 * Recipient = email sales yang submit. CC = email finance (opsional).
 *
 * @param {Object} params
 * @param {Object} params.po - PO object (po_number, po_date, vendor_name)
 * @param {Buffer} params.pdfBuffer - PDF attachment buffer
 * @param {string} params.salesEmail - email sales yang submit
 * @param {string|null} params.salesName - nama sales yang submit
 * @param {string|null} params.financeEmail - email finance untuk CC
 * @param {string|null} params.accentColor - warna aksen dari workspace setting
 * @returns {Promise<{status: 'sent'|'failed', error?: string, messageId?: string, subject: string}>}
 */
export async function sendPOEmail({ po, pdfBuffer, salesEmail, salesName, financeEmail, accentColor }) {
  const subject = `[New PO] - ${po.po_number} dari ${salesName ?? 'Sales'}`;
  const fromAddress = getSmtpFromAddress();

  const shouldCcSales = financeEmail && salesEmail && financeEmail.toLowerCase() !== salesEmail.toLowerCase();
  const recipientEmail = financeEmail || salesEmail;

  const baseLog = {
    purchase_order_id: po.id,
    sender_email: fromAddress || 'no-reply@docuflow.app',
    recipient_email: recipientEmail,
    cc_email: shouldCcSales ? salesEmail : null,
    subject,
    status: 'pending',
  };

  if (!isValidEmail(recipientEmail)) {
    const errorMessage = 'Recipient email is empty or invalid.';
    await supabaseAdmin.from('email_logs').insert({
      ...baseLog,
      status: 'failed',
      error_message: errorMessage,
    });
    return { status: 'failed', error: errorMessage, subject };
  }

  const transporter = getTransporter();
  if (!transporter) {
    const errorMessage = 'SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing).';
    await supabaseAdmin.from('email_logs').insert({
      ...baseLog,
      status: 'failed',
      error_message: errorMessage,
    });
    return { status: 'failed', error: errorMessage, subject };
  }

  // Determine frontend URL
  const rawFrontendUrl = env.FRONTEND_URL || (env.FRONTEND_ORIGIN ? env.FRONTEND_ORIGIN.split(',')[0] : 'http://localhost:5173');
  const cleanFrontendUrl = rawFrontendUrl.replace(/\/+$/, '');
  const poLink = `${cleanFrontendUrl}/purchase-orders/${po.id}`;

  // Resolve palette colors matching workspace accent color
  const cleanAccent = String(accentColor || 'indigo').toLowerCase();
  const colors = PALETTE_COLORS[cleanAccent] || PALETTE_COLORS.indigo;

  // Format items list
  const items = Array.isArray(po.items) ? po.items : [];
  
  const itemLines = items.map((item, index) => {
    const name = item.item_name ?? item.name ?? '-';
    let sku = item.sku ?? '-';
    let unit = item.unit || item.metadata?.unit || 'lusin';
    if (sku.includes('|')) {
      const parts = sku.split('|');
      sku = parts[0];
      unit = parts[1];
    }
    return `${index + 1}. ${name} (SKU: ${sku}) - ${item.qty ?? '-'} ${unit}`;
  }).join('\n');

  const plainText = [
    `Purchase Order baru telah dibuat oleh ${salesName ?? 'Sales'} (${salesEmail}).`,
    '',
    `No. PO        : ${po.po_number}`,
    `Tanggal       : ${po.po_date}`,
    `Vendor        : ${po.vendor_name}`,
    `Sales Person  : ${salesName ?? 'Sales'}`,
    po.notes ? `Catatan       : ${po.notes}` : '',
    '',
    'Daftar Barang:',
    itemLines,
    '',
    `Lihat Purchase Order selengkapnya di: ${poLink}`,
    '',
    'Terlampir dokumen PDF Purchase Order (hanya berisi Nama Item, SKU, dan Kuantitas).',
  ].filter(Boolean).join('\n');

  const htmlTableRows = items.map((item) => {
    const name = item.item_name ?? item.name ?? '-';
    let sku = item.sku ?? '-';
    let unit = item.unit || item.metadata?.unit || 'lusin';
    if (sku.includes('|')) {
      const parts = sku.split('|');
      sku = parts[0];
      unit = parts[1];
    }
    const qtyStr = `${item.qty ?? '-'} ${unit}`;
    return `
      <tr>
        <td style="padding: 10px 12px; font-size: 13px; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; line-height: 1.4;">
          <div style="font-weight: 600;">${name}</div>
          <div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">SKU: ${sku}</div>
        </td>
        <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; white-space: nowrap;">
          ${qtyStr}
        </td>
      </tr>
    `;
  }).join('');

  const htmlItemsTable = `
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin-top: 24px; margin-bottom: 32px; border: 1px solid #E4E4E9; border-radius: 8px; overflow: hidden;">
      <thead>
        <tr style="background-color: #F8F9FA; border-bottom: 1px solid #E4E4E9;">
          <th align="left" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Item</th>
          <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Qty</th>
        </tr>
      </thead>
      <tbody>
        ${htmlTableRows}
      </tbody>
    </table>
  `;

  const notesRowHtml = po.notes ? `
    <tr>
      <td width="30%" valign="top" style="font-size: 13px; font-weight: 500; color: #6C6C78;">Catatan</td>
      <td width="70%" valign="top" style="font-size: 13px; color: #0D0D0F;">${po.notes}</td>
    </tr>
  ` : '';

  const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Purchase Order Baru</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F7F7F8; font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F7F7F8; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 12px; border: 1px solid #E4E4E9; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03); overflow: hidden;">
          
          <!-- Decorative Header Accent -->
          <tr>
            <td height="6" style="background-color: ${colors.primary};"></td>
          </tr>
          
          <tr>
            <td style="padding: 40px 32px;">
              <!-- Header / Logo -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 700; color: #0D0D0F; letter-spacing: -0.02em;">Docuflow</span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: ${colors.light}; color: ${colors.primary}; padding: 6px 12px; border-radius: 9999px;">Purchase Order</span>
                  </td>
                </tr>
              </table>

              <!-- Greeting & Subject -->
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #0D0D0F; letter-spacing: -0.02em; line-height: 1.3;">
                Purchase Order Baru Dibuat
              </h1>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #6C6C78;">
                Halo Team,
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #0D0D0F;">
                Purchase Order baru telah dibuat oleh <strong>${salesName ?? 'Sales'}</strong> (<a href="mailto:${salesEmail}" style="color: ${colors.primary}; text-decoration: none;">${salesEmail}</a>) dengan rincian berikut:
              </p>

              <!-- PO Details Box -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F9FA; border: 1px solid #E4E4E9; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">No. PO</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${po.po_number}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Tanggal</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; color: #0D0D0F;">${po.po_date}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: ${po.notes ? '12px' : '0'}; font-size: 13px; font-weight: 500; color: #6C6C78;">Vendor</td>
                        <td width="70%" valign="top" style="padding-bottom: ${po.notes ? '12px' : '0'}; font-size: 13px; color: #0D0D0F; font-weight: 500;">${po.vendor_name}</td>
                      </tr>
                      ${notesRowHtml}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- PO Items Table -->
              ${htmlItemsTable}

              <!-- Call to Action Button -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td align="center">
                    <a href="${poLink}" target="_blank" style="display: inline-block; background-color: ${colors.primary}; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 6px; box-shadow: 0 4px 14px ${colors.shadow}; text-align: center; border: 1px solid ${colors.hover};">
                      Lihat Purchase Order
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 1.5; color: #6C6C78;">
                <em>*Terlampir dokumen PDF Purchase Order (hanya berisi Nama Item, SKU, dan Kuantitas).</em>
              </p>

              <!-- Divider -->
              <hr style="border: 0; border-top: 1px solid #E4E4E9; margin: 32px 0 24px 0;">

              <!-- Footer info -->
              <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #A1A1AA;">
                Email ini dikirim secara otomatis oleh sistem <strong>Docuflow</strong>. Harap tidak membalas email ini secara langsung. Untuk menyetujui atau menolak PO ini, silakan klik tombol di atas untuk masuk to sistem.
              </p>
              
              <p style="margin: 0; font-size: 11px; color: #A1A1AA;">
                &copy; 2026 Docuflow. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const info = await sendMailWithRetry({
      from: fromAddress,
      to: recipientEmail,
      cc: shouldCcSales ? salesEmail : undefined,
      subject,
      text: plainText,
      html: htmlContent,
      attachments: [
        {
          filename: `PO-${po.po_number}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    await supabaseAdmin.from('email_logs').insert({
      ...baseLog,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    return { status: 'sent', messageId: info.messageId, subject };
  } catch (err) {
    const errorMessage = err?.message ?? String(err);
    await supabaseAdmin.from('email_logs').insert({
      ...baseLog,
      status: 'failed',
      error_message: errorMessage,
    });
    return { status: 'failed', error: errorMessage, subject };
  }
}

// ── Parser & Unit Multipliers (dipakai Goods Out & Goods In) ────────────────
const MULTIPLIERS = {
  pcs: 1,
  piece: 1,
  pack3: 3,
  pack6: 6,
  lusin: 12,
  dozen: 12,
  pack: 60,
  bal5: 60,   // 5 Lusin
  bal10: 120, // 10 Lusin
  bal15: 180, // 15 Lusin
  bal20: 240, // 20 Lusin
  bal25: 300, // 25 Lusin
  bal: 300,   // Fallback & Legacy compatibility
};

const LUSIN_UNITS = new Set([
  'lusin', 'dozen', 'pack', 'bal5', 'bal10', 'bal15', 'bal20', 'bal25', 'bal',
]);

function isLusinUnit(unit) {
  if (!unit) return false;
  const u = String(unit).toLowerCase().trim();
  if (u === 'pack3' || u === 'pk3' || u === 'pack6' || u === 'pk6' || u === 'pcs' || u === 'piece') {
    return false;
  }
  if (LUSIN_UNITS.has(u)) return true;
  if (u.includes('lusin') || u.includes('doz') || u.includes('bal')) return true;
  if (u === 'pack' || u === 'pk') return true;
  return false;
}

function parseUnitFromSn(sn, fallbackUnit = 'pcs') {
  if (!sn) return fallbackUnit;
  const s = String(sn).toLowerCase();
  if (s.includes('bl25') || s.includes('25bl') || s.includes('bal25') || s.includes('25bal')) return 'bal25';
  if (s.includes('bl20') || s.includes('20bl') || s.includes('bal20') || s.includes('20bal')) return 'bal20';
  if (s.includes('bl15') || s.includes('15bl') || s.includes('bal15') || s.includes('15bal')) return 'bal15';
  if (s.includes('bl10') || s.includes('10bl') || s.includes('bal10') || s.includes('10bal')) return 'bal10';
  if (s.includes('bl5') || s.includes('5bl') || s.includes('bal5') || s.includes('5bal')) return 'bal5';
  if (s.includes('pack6') || s.includes('pk6') || s.includes('6pk')) return 'pack6';
  if (s.includes('pack3') || s.includes('pk3') || s.includes('3pk')) return 'pack3';
  if (s.includes('pack5') || s.includes('pk5') || s.includes('5pk')) return 'pack';
  if (s.includes('lusin') || s.includes('doz') || s.includes('-ls-') || s.includes('_ls_') || s.endsWith('-ls')) return 'lusin';
  if (s.includes('bal') || s.includes('bl')) return 'bal';
  if (s.includes('pack') || s.includes('pk')) return 'pack';
  return fallbackUnit;
}

function getUnitHelpers(customUnits) {
  const multipliers = { ...MULTIPLIERS };
  const lusinUnitsSet = new Set(LUSIN_UNITS);

  if (Array.isArray(customUnits) && customUnits.length > 0) {
    for (const u of customUnits) {
      if (u.key) {
        const k = String(u.key).toLowerCase().trim();
        const mult = Number(u.multiplier || (u.baseType === 'lusin' ? u.baseValue * 12 : u.baseValue) || 1);
        multipliers[k] = mult;
        if (u.baseType === 'lusin') {
          lusinUnitsSet.add(k);
        } else if (u.baseType === 'pcs') {
          lusinUnitsSet.delete(k);
        }
      }
    }
  }

  const isLusin = (unit) => {
    if (!unit) return false;
    const clean = String(unit).toLowerCase().trim();
    if (Array.isArray(customUnits)) {
      const found = customUnits.find((u) => u.key && String(u.key).toLowerCase().trim() === clean);
      if (found) return found.baseType === 'lusin';
    }
    if (clean === 'pack3' || clean === 'pk3' || clean === 'pack6' || clean === 'pk6' || clean === 'pcs' || clean === 'piece') {
      return false;
    }
    if (lusinUnitsSet.has(clean)) return true;
    if (clean.includes('lusin') || clean.includes('doz') || clean.includes('bal')) return true;
    return false;
  };

  const parseSn = (sn, fallbackUnit = 'pcs') => {
    if (!sn) return fallbackUnit;
    const clean = String(sn).toLowerCase().trim();
    if (Array.isArray(customUnits)) {
      const sorted = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
      for (const u of sorted) {
        const k = String(u.key).toLowerCase().trim();
        if (!k || k === 'pcs') continue;
        if (clean.includes(k)) return k;
      }
    }
    return parseUnitFromSn(clean, fallbackUnit);
  };

  return { multipliers, isLusin, parseSn };
}

function formatDocumentQty(totalLusin, totalPcs) {
  let lusin = totalLusin || 0;
  let pcs = totalPcs || 0;

  if (lusin % 1 !== 0) {
    const extraPcs = Math.round((lusin % 1) * 12);
    lusin = Math.floor(lusin);
    pcs += extraPcs;
  }

  lusin = Math.round(lusin);
  pcs = Math.round(pcs);

  if (lusin > 0 && pcs > 0) {
    return `${lusin} lusin ${pcs} pcs`;
  }
  if (lusin > 0) {
    return `${lusin} lusin`;
  }
  if (pcs > 0) {
    return `${pcs} pcs`;
  }
  return '0 pcs';
}

function formatLusinPcs(totalPcs) {
  const count = Math.max(0, Math.round(totalPcs || 0));
  const lusin = Math.floor(count / 12);
  const pcs = count % 12;

  if (lusin > 0 && pcs > 0) {
    return `${lusin} lusin ${pcs} pcs`;
  }
  if (lusin > 0) {
    return `${lusin} lusin`;
  }
  return `${pcs} pcs`;
}

function getGroupedProductItems(items, doc = null, customUnits = null) {
  let docObj = null;
  let unitsData = null;
  if (doc && (Array.isArray(doc) || doc.key || doc.baseType)) {
    // Legacy signature: getGroupedProductItems(items, customUnits)
    unitsData = doc;
  } else {
    docObj = doc;
    unitsData = customUnits || doc?.metadata?.custom_units || doc?.custom_units;
  }
  const helpers = getUnitHelpers(unitsData);
  const groupMap = new Map();

  // Parse active return transactions from doc metadata
  const activeReturns = Array.isArray(docObj?.metadata?.returns)
    ? docObj.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];

  const returnedSerialSet = new Set();
  const returnedNonSerialQtyByItem = new Map();

  activeReturns.forEach((r) => {
    (r.items || []).forEach((ri) => {
      const isSerial = ri.isSerial === true || !!ri.serialNumber;
      if (isSerial && ri.serialNumber) {
        returnedSerialSet.add(String(ri.serialNumber).trim().toLowerCase());
      } else {
        const idKey = String(ri.itemId || ri.productId || '').trim();
        if (idKey) {
          const retQty = Number(ri.returnedQty ?? ri.quantity ?? 1) || 0;
          returnedNonSerialQtyByItem.set(idKey, (returnedNonSerialQtyByItem.get(idKey) || 0) + retQty);
        }
      }
    });
  });

  (items || []).forEach((item) => {
    const productId = item.product_id ?? item.productId ?? item.sku ?? item.item_name ?? item.productName ?? 'default';
    const itemId = item.id || item.itemId || productId;
    const name = item.item_name || item.itemName || item.product_name || item.name || 'Produk';
    let sku = item.sku || '—';
    if (sku.includes('|')) {
      sku = sku.split('|')[0];
    }
    const itemInfo = resolveDocumentItemQuantity(item, {
      multipliers: helpers.multipliers,
      parseSn: helpers.parseSn,
    });

    if (!groupMap.has(productId)) {
      groupMap.set(productId, {
        productId,
        name,
        sku,
        totalPcs: 0,
        totalLusin: 0,
        totalPcsOnly: 0,
        returnedPcs: 0,
        returnedLusin: 0,
        returnedPcsOnly: 0,
        serials: [],
        returnedSerials: [],
        unitCounts: {},
        returnedUnitCounts: {},
      });
    }

    const current = groupMap.get(productId);
    current.totalPcs += itemInfo.pcs;
    if (helpers.isLusin(itemInfo.unit)) {
      const mult = helpers.multipliers[itemInfo.unit] || 12;
      current.totalLusin += (itemInfo.qty * mult) / 12;
    } else {
      current.totalPcsOnly += itemInfo.pcs;
    }

    // Check return for this item
    let itemReturnedQty = 0;
    if (itemInfo.isSerial && itemInfo.serialNumber) {
      if (returnedSerialSet.has(itemInfo.serialNumber.toLowerCase())) {
        itemReturnedQty = itemInfo.qty;
        if (!current.returnedSerials.includes(itemInfo.serialNumber)) {
          current.returnedSerials.push(itemInfo.serialNumber);
        }
      }
    } else {
      const retFromId = returnedNonSerialQtyByItem.get(String(itemId)) || returnedNonSerialQtyByItem.get(String(productId)) || 0;
      if (retFromId > 0) {
        itemReturnedQty = Math.min(itemInfo.qty, retFromId);
      }
    }

    if (itemReturnedQty > 0) {
      const retMult = helpers.multipliers[itemInfo.unit] || (helpers.isLusin(itemInfo.unit) ? 12 : 1);
      const retPcs = itemReturnedQty * retMult;
      current.returnedPcs += retPcs;
      if (helpers.isLusin(itemInfo.unit)) {
        current.returnedLusin += retPcs / 12;
      } else {
        current.returnedPcsOnly += retPcs;
      }
      current.returnedUnitCounts[itemInfo.unit] = (current.returnedUnitCounts[itemInfo.unit] || 0) + itemReturnedQty;
    }

    if (itemInfo.isSerial && itemInfo.serialNumber) {
      if (!current.serials.includes(itemInfo.serialNumber)) {
        current.serials.push(itemInfo.serialNumber);
      }
    }
    if (Array.isArray(item.serials)) {
      item.serials.forEach((s) => {
        if (s && !current.serials.includes(s)) current.serials.push(s);
      });
    }
    if (Array.isArray(item.metadata?.serials)) {
      item.metadata.serials.forEach((s) => {
        if (s && !current.serials.includes(s)) current.serials.push(s);
      });
    }
    current.unitCounts[itemInfo.unit] = (current.unitCounts[itemInfo.unit] || 0) + itemInfo.qty;
  });

  // Extract from doc level serials if present
  const docSerials = docObj?.serials || docObj?.productSerials || docObj?.metadata?.serials || [];
  if (Array.isArray(docSerials)) {
    docSerials.forEach((s) => {
      const sn = typeof s === 'string' ? s : (s.serialNumber || s.serial_number);
      if (!sn) return;
      const sProdId = s.productId || s.product_id;
      const sDocItemId = s.goodsInItemId || s.goods_in_item_id;
      let matched = null;
      if (sProdId && groupMap.has(sProdId)) {
        matched = groupMap.get(sProdId);
      } else {
        for (const g of groupMap.values()) {
          if (g.productId === sProdId || g.productId === sDocItemId || (s.sku && g.sku === s.sku)) {
            matched = g;
            break;
          }
        }
      }
      if (matched) {
        if (!matched.serials.includes(sn)) {
          matched.serials.push(sn);
        }
        if (returnedSerialSet.has(String(sn).trim().toLowerCase()) && !matched.returnedSerials.includes(sn)) {
          matched.returnedSerials.push(sn);
        }
      }
    });
  }

  return Array.from(groupMap.values()).map((g) => {
    g.serials.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    g.returnedSerials.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const unitEntries = Object.entries(g.unitCounts);
    const breakdown = unitEntries.map(([u, q]) => `${q} ${u}`).join(', ');
    const formattedQty = formatDocumentQty(g.totalLusin, g.totalPcsOnly);

    const netLusin = Math.max(0, g.totalLusin - g.returnedLusin);
    const netPcsOnly = Math.max(0, g.totalPcsOnly - g.returnedPcsOnly);
    const netFormattedQty = formatDocumentQty(netLusin, netPcsOnly);
    const returnedFormattedQty = formatDocumentQty(g.returnedLusin, g.returnedPcsOnly);
    const hasReturns = (g.returnedLusin > 0 || g.returnedPcsOnly > 0 || g.returnedSerials.length > 0);
    const isFullyReturned = hasReturns && netLusin === 0 && netPcsOnly === 0;

    return {
      ...g,
      breakdown,
      formattedQty,
      netLusin,
      netPcsOnly,
      netFormattedQty,
      returnedFormattedQty,
      hasReturns,
      isFullyReturned,
    };
  });
}

/**
 * Kirim email Bukti Barang Keluar (Goods Out) lengkap dengan attachment PDF.
 * Recipient = email Finance/Owner. CC = Creator (Gudang/Sales) & Kontak Penerima (jika ada).
 *
 * @param {Object} params
 * @param {Object} params.doc - Document object (id, document_number, issue_date, contact_name, notes, items)
 * @param {Buffer} params.pdfBuffer - PDF attachment buffer
 * @param {string} params.creatorEmail - email user pembuat barang keluar
 * @param {string|null} params.creatorName - nama user pembuat barang keluar
 * @param {string|null} params.financeEmail - email finance / owner untuk penerima
 * @param {string|null} params.contactEmail - email kontak tujuan jika ada
 * @param {string|null} params.accentColor - warna aksen dari workspace setting
 * @param {string|null} params.warehouseName - nama gudang asal pengeluaran
 * @param {Array|null} params.customUnits - custom unit configurations
 * @returns {Promise<{status: 'sent'|'failed', error?: string, messageId?: string, subject: string}>}
 */
export async function sendGoodsOutEmail({
  doc,
  pdfBuffer,
  creatorEmail,
  creatorName,
  financeEmail,
  contactEmail,
  accentColor,
  warehouseName = 'Gudang Utama',
  customUnits = null,
}) {
  const destination = doc.contact_name || 'Customer';
  const whTag = warehouseName ? ` [${warehouseName}]` : '';

  const rawItems = Array.isArray(doc.items) ? doc.items : (doc.metadata?.items || []);
  const groupedItems = getGroupedProductItems(rawItems, doc, customUnits || doc.metadata?.custom_units);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalDocumentFormatted = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const grandReturnedLusin = groupedItems.reduce((sum, g) => sum + (g.returnedLusin || 0), 0);
  const grandReturnedPcsOnly = groupedItems.reduce((sum, g) => sum + (g.returnedPcsOnly || 0), 0);
  const totalReturnedFormatted = formatDocumentQty(grandReturnedLusin, grandReturnedPcsOnly);

  const grandNetLusin = groupedItems.reduce((sum, g) => sum + (g.netLusin || 0), 0);
  const grandNetPcsOnly = groupedItems.reduce((sum, g) => sum + (g.netPcsOnly || 0), 0);
  const totalNetFormatted = formatDocumentQty(grandNetLusin, grandNetPcsOnly);

  const activeReturns = Array.isArray(doc.metadata?.returns)
    ? doc.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];
  const hasReturns = activeReturns.length > 0;
  const isFullReturn = hasReturns && (grandNetLusin <= 0 && grandNetPcsOnly <= 0);

  const returnSubjectPrefix = isFullReturn
    ? ' - RETUR TOTAL'
    : (hasReturns ? ' - RETUR SEBAGIAN' : '');
  const subject = `[Goods Out${returnSubjectPrefix}] - ${doc.document_number} ke ${destination}${whTag}`;
  const fromAddress = getSmtpFromAddress();

  const recipientEmail = financeEmail || creatorEmail || contactEmail;

  const ccSet = new Set();
  if (creatorEmail && recipientEmail && creatorEmail.toLowerCase() !== recipientEmail.toLowerCase()) {
    ccSet.add(creatorEmail);
  }
  if (contactEmail && recipientEmail && contactEmail.toLowerCase() !== recipientEmail.toLowerCase()) {
    ccSet.add(contactEmail);
  }
  const ccArray = Array.from(ccSet);

  const baseLog = {
    sender_email: fromAddress || 'no-reply@docuflow.app',
    recipient_email: recipientEmail || null,
    cc_email: ccArray.length > 0 ? ccArray.join(', ') : null,
    subject,
    status: 'pending',
  };
  if (doc.id) {
    baseLog.document_id = doc.id;
  }

  if (!isValidEmail(recipientEmail)) {
    const errorMessage = 'Recipient email is empty or invalid.';
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }

  const transporter = getTransporter();
  if (!transporter) {
    const errorMessage = 'SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing).';
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }

  // Determine frontend URL
  const rawFrontendUrl = process.env.FRONTEND_URL || (process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : 'http://localhost:5173');
  const cleanFrontendUrl = rawFrontendUrl.replace(/\/+$/, '');
  const docLink = `${cleanFrontendUrl}/goods-out`;

  // Resolve palette colors matching workspace accent color
  const cleanAccent = String(accentColor || 'indigo').toLowerCase();
  const colors = PALETTE_COLORS[cleanAccent] || PALETTE_COLORS.indigo;

  const itemLines = groupedItems.map((group, index) => {
    let serialInfo = '';
    if (group.serials.length > 0) {
      const serialTokens = group.serials.map((s) => {
        const isRet = Array.isArray(group.returnedSerials) && group.returnedSerials.includes(s);
        return isRet ? `${s} [RETUR]` : s;
      });
      serialInfo = `\n   No. Seri (${group.serials.length}): ${serialTokens.join(', ')}`;
    }
    const breakdownInfo = group.breakdown ? ` (${group.breakdown})` : '';
    if (group.hasReturns) {
      return `${index + 1}. ${group.name} (SKU: ${group.sku})\n   Qty Awal: ${group.formattedQty}${breakdownInfo} | Diretur: -${group.returnedFormattedQty} | Net: ${group.netFormattedQty}${serialInfo}`;
    }
    return `${index + 1}. ${group.name} (SKU: ${group.sku}) - ${group.formattedQty}${breakdownInfo}${serialInfo}`;
  }).join('\n');

  const issueDateFormatted = doc.issue_date || new Date().toISOString().slice(0, 10);

  const returnHistoryPlainText = hasReturns
    ? [
        '',
        'Riwayat Retur Dokumen Ini:',
        ...activeReturns.map((r) => {
          const retNum = r.returnNumber || 'RET-DOKUMEN';
          const retDate = r.returnedAt || r.date ? new Date(r.returnedAt || r.date).toLocaleDateString('id-ID') : '-';
          const reason = r.reason ? ` - ${r.reason}` : '';
          const retItems = (r.items || []).map((it) => `${it.returnedQty || 1} ${it.qtyUnit || 'pcs'} ${it.productName || it.name || ''}`).join(', ');
          return `- ${retNum} (${retDate})${reason}${retItems ? `: ${retItems}` : ''}`;
        }),
      ].join('\n')
    : '';

  const totalSummaryPlainText = hasReturns
    ? `Total Awal    : ${totalDocumentFormatted}\nTotal Diretur : -${totalReturnedFormatted}\nNet Terkirim  : ${totalNetFormatted}`
    : `Total Keseluruhan: ${totalDocumentFormatted}`;

  const plainText = [
    hasReturns ? `STATUS PENGIRIMAN: ${isFullReturn ? 'DIRETUR TOTAL' : 'DIRETUR SEBAGIAN'}\n` : '',
    `Catatan Barang Keluar telah dibuat oleh ${creatorName ?? 'Petugas'} (${creatorEmail || '-'}).`,
    '',
    `No. Referensi : ${doc.document_number}`,
    `Gudang Asal   : ${warehouseName}`,
    `Tanggal       : ${issueDateFormatted}`,
    `Tujuan        : ${destination}`,
    `Petugas       : ${creatorName ?? 'Petugas'}`,
    doc.notes ? `Catatan       : ${doc.notes}` : '',
    '',
    'Daftar Barang Keluar:',
    itemLines,
    '',
    totalSummaryPlainText,
    returnHistoryPlainText,
    '',
    `Lihat Barang Keluar selengkapnya di: ${docLink}`,
    '',
    'Terlampir dokumen PDF Surat Jalan / Bukti Barang Keluar.',
  ].filter(Boolean).join('\n');

  const htmlTableRows = groupedItems.map((group) => {
    let serialSubtitle = '';
    if (group.serials.length > 0) {
      const serialTokens = group.serials.map((s) => {
        const isRet = Array.isArray(group.returnedSerials) && group.returnedSerials.includes(s);
        if (isRet) {
          return `<span style="text-decoration: line-through; color: #DC2626;">${escapeEmailHtml(s)}</span> <span style="color: #DC2626; font-size: 9px; font-weight: 700; border: 1px solid #DC2626; padding: 0 2px; border-radius: 2px;">RETUR</span>`;
        }
        return `<span>${escapeEmailHtml(s)}</span>`;
      });
      serialSubtitle = `<div style="font-size: 11px; color: ${colors.primary}; font-weight: 500; margin-top: 4px; word-break: break-all;">No. Seri (${group.serials.length}): ${serialTokens.join(', ')}</div>`;
    }

    const breakdownSubtitle = group.breakdown
      ? `<span style="font-size: 11px; color: #6C6C78; font-weight: normal; display: block; margin-top: 2px;">${escapeEmailHtml(group.breakdown)}</span>`
      : '';

    if (hasReturns) {
      return `
        <tr>
          <td style="padding: 10px 12px; font-size: 13px; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; line-height: 1.4; vertical-align: top;">
            <div style="font-weight: 600;">${escapeEmailHtml(group.name)}</div>
            <div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">SKU: ${escapeEmailHtml(group.sku)}</div>
            ${serialSubtitle}
          </td>
          <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
            <div>${escapeEmailHtml(group.formattedQty)}</div>
            ${breakdownSubtitle}
          </td>
          <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #DC2626; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
            ${group.hasReturns ? `-${escapeEmailHtml(group.returnedFormattedQty)}` : '—'}
          </td>
          <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #16A34A; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
            ${escapeEmailHtml(group.netFormattedQty)}
          </td>
        </tr>
      `;
    }

    return `
      <tr>
        <td style="padding: 10px 12px; font-size: 13px; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; line-height: 1.4; vertical-align: top;">
          <div style="font-weight: 600;">${escapeEmailHtml(group.name)}</div>
          <div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">SKU: ${escapeEmailHtml(group.sku)}</div>
          ${serialSubtitle}
        </td>
        <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
          <div>${escapeEmailHtml(group.formattedQty)}</div>
          ${breakdownSubtitle}
        </td>
      </tr>
    `;
  }).join('');

  const htmlItemsTable = `
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin-top: 24px; margin-bottom: 24px; border: 1px solid #E4E4E9; border-radius: 8px; overflow: hidden;">
      <thead>
        <tr style="background-color: #F8F9FA; border-bottom: 1px solid #E4E4E9;">
          <th align="left" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Item</th>
          ${hasReturns ? `
            <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Qty Awal</th>
            <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #DC2626;">Diretur</th>
            <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #16A34A;">Net Terkirim</th>
          ` : `
            <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Jumlah</th>
          `}
        </tr>
      </thead>
      <tbody>
        ${htmlTableRows}
      </tbody>
      <tfoot>
        ${hasReturns ? `
          <tr style="background-color: #F8F9FA; border-top: 2px solid #E4E4E9;">
            <td style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #0D0D0F;">Total</td>
            <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; white-space: nowrap;">${escapeEmailHtml(totalDocumentFormatted)}</td>
            <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #DC2626; white-space: nowrap;">-${escapeEmailHtml(totalReturnedFormatted)}</td>
            <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #16A34A; white-space: nowrap;">${escapeEmailHtml(totalNetFormatted)}</td>
          </tr>
        ` : `
          <tr style="background-color: #F8F9FA; border-top: 2px solid #E4E4E9;">
            <td style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #0D0D0F;">Total Keseluruhan</td>
            <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: ${colors.primary}; white-space: nowrap;">${escapeEmailHtml(totalDocumentFormatted)}</td>
          </tr>
        `}
      </tfoot>
    </table>
  `;

  let returnHistoryHtml = '';
  if (hasReturns) {
    const returnItemsList = activeReturns.map((r) => {
      const retNum = r.returnNumber || 'RET-DOKUMEN';
      const retDate = r.returnedAt || r.date ? new Date(r.returnedAt || r.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
      const reason = r.reason ? ` - Alasan: <em>${escapeEmailHtml(r.reason)}</em>` : '';
      const notes = r.notes ? ` (${escapeEmailHtml(r.notes)})` : '';
      const itemsList = (r.items || []).map((it) => `${escapeEmailHtml(it.returnedQty || 1)} ${escapeEmailHtml(it.qtyUnit || 'pcs')} ${escapeEmailHtml(it.productName || it.name || '')}`).join(', ');
      return `
        <li style="margin-bottom: 6px;">
          <strong>${escapeEmailHtml(retNum)}</strong> (${retDate})${reason}${notes}
          ${itemsList ? `<div style="font-size: 12px; color: #92400E; margin-top: 2px;">Barang: ${itemsList}</div>` : ''}
        </li>
      `;
    }).join('');

    returnHistoryHtml = `
      <div style="background-color: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <div style="font-size: 13px; font-weight: 700; color: #92400E; margin-bottom: 8px;">
          RIWAYAT RETUR PENGIRIMAN:
        </div>
        <ul style="margin: 0; padding-left: 20px; font-size: 12px; color: #78350F; line-height: 1.5;">
          ${returnItemsList}
        </ul>
      </div>
    `;
  }

  let returnBannerHtml = '';
  if (isFullReturn) {
    returnBannerHtml = `
      <div style="background-color: #FEF2F2; border: 1px solid #F87171; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;">
        <strong style="color: #991B1B; font-size: 13px;">⚠️ STATUS DOKUMEN: DIRETUR TOTAL</strong>
        <div style="color: #B91C1C; font-size: 12px; margin-top: 2px;">Seluruh barang pada pengeluaran ini telah berhasil diretur kembali ke inventori.</div>
      </div>
    `;
  } else if (hasReturns) {
    returnBannerHtml = `
      <div style="background-color: #FFFBEB; border: 1px solid #FBBF24; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;">
        <strong style="color: #92400E; font-size: 13px;">⚠️ STATUS DOKUMEN: DIRETUR SEBAGIAN</strong>
        <div style="color: #B45309; font-size: 12px; margin-top: 2px;">Terdapat barang yang telah diretur pada pengeluaran ini. Silakan periksa rincian net terkirim di bawah.</div>
      </div>
    `;
  }

  const notesRowHtml = doc.notes ? `
    <tr>
      <td width="30%" valign="top" style="font-size: 13px; font-weight: 500; color: #6C6C78;">Catatan</td>
      <td width="70%" valign="top" style="font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(doc.notes)}</td>
    </tr>
  ` : '';

  const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bukti Barang Keluar</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F7F7F8; font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F7F7F8; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 12px; border: 1px solid #E4E4E9; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03); overflow: hidden;">
          
          <!-- Decorative Header Accent -->
          <tr>
            <td height="6" style="background-color: ${isFullReturn ? '#DC2626' : (hasReturns ? '#D97706' : colors.primary)};"></td>
          </tr>
          
          <tr>
            <td style="padding: 40px 32px;">
              <!-- Header / Logo -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 700; color: #0D0D0F; letter-spacing: -0.02em;">Docuflow</span>
                  </td>
                  <td align="right">
                    ${isFullReturn ? `
                      <span style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; background-color: #FEF2F2; color: #DC2626; border: 1px solid #F87171; padding: 6px 12px; border-radius: 9999px;">Diretur Total</span>
                    ` : (hasReturns ? `
                      <span style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; background-color: #FFFBEB; color: #D97706; border: 1px solid #FBBF24; padding: 6px 12px; border-radius: 9999px;">Diretur Sebagian</span>
                    ` : `
                      <span style="display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: ${colors.light}; color: ${colors.primary}; padding: 6px 12px; border-radius: 9999px;">Barang Keluar</span>
                    `)}
                  </td>
                </tr>
              </table>

              ${returnBannerHtml}

              <!-- Greeting & Subject -->
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #0D0D0F; letter-spacing: -0.02em; line-height: 1.3;">
                ${isFullReturn ? 'Bukti Pengeluaran Barang (Diretur Total)' : (hasReturns ? 'Bukti Pengeluaran Barang (Diretur Sebagian)' : 'Bukti Pengeluaran Barang')}
              </h1>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #6C6C78;">
                Halo Team,
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #0D0D0F;">
                Catatan Barang Keluar (Goods Out) untuk referensi <strong>${escapeEmailHtml(doc.document_number)}</strong> dibuat oleh <strong>${escapeEmailHtml(creatorName ?? 'Petugas')}</strong>${creatorEmail ? ` (<a href="mailto:${creatorEmail}" style="color: ${colors.primary}; text-decoration: none;">${escapeEmailHtml(creatorEmail)}</a>)` : ''} dengan rincian berikut:
              </p>

              <!-- Document Details Box -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F9FA; border: 1px solid #E4E4E9; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">No. Referensi</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${escapeEmailHtml(doc.document_number)}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Gudang Asal</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${escapeEmailHtml(warehouseName)}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Tanggal</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(issueDateFormatted)}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: ${doc.notes ? '12px' : '0'}; font-size: 13px; font-weight: 500; color: #6C6C78;">Tujuan / Penerima</td>
                        <td width="70%" valign="top" style="padding-bottom: ${doc.notes ? '12px' : '0'}; font-size: 13px; color: #0D0D0F; font-weight: 600;">${escapeEmailHtml(destination)}</td>
                      </tr>
                      ${notesRowHtml}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Document Items Table -->
              ${htmlItemsTable}

              <!-- Return History Box if any -->
              ${returnHistoryHtml}

              <!-- Call to Action Button -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td align="center">
                    <a href="${docLink}" target="_blank" style="display: inline-block; background-color: ${colors.primary}; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 6px; box-shadow: 0 4px 14px ${colors.shadow}; text-align: center; border: 1px solid ${colors.hover};">
                      Lihat Barang Keluar
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 1.5; color: #6C6C78;">
                <em>*Terlampir dokumen PDF Surat Jalan / Bukti Barang Keluar.</em>
              </p>

              <!-- Divider -->
              <hr style="border: 0; border-top: 1px solid #E4E4E9; margin: 32px 0 24px 0;">

              <!-- Footer info -->
              <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #A1A1AA;">
                Email ini dikirim secara otomatis oleh sistem <strong>Docuflow</strong> sebagai bukti pencatatan barang keluar. Harap tidak membalas email ini secara langsung.
              </p>
              
              <p style="margin: 0; font-size: 11px; color: #A1A1AA;">
                &copy; 2026 Docuflow. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const cleanDocNumber = (doc.document_number || 'dokumen').replace(/[/\\?%*:|"<>]/g, '_');

  try {
    const info = await sendMailWithRetry({
      from: fromAddress,
      to: recipientEmail,
      cc: ccArray.length > 0 ? ccArray : undefined,
      subject,
      text: plainText,
      html: htmlContent,
      attachments: [
        {
          filename: `GoodsOut-${cleanDocNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
    } catch (_) {}

    return { status: 'sent', messageId: info.messageId, subject };
  } catch (err) {
    const errorMessage = err?.message ?? String(err);
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }
}

/**
 * Kirim email Bukti Barang Masuk (Goods In) lengkap dengan attachment PDF.
 * Recipient = email Finance/Owner. CC = Creator (Petugas) & Vendor (jika ada).
 *
 * @param {Object} params
 * @param {Object} params.doc - Document object (id, document_number, issue_date, contact_name, notes, items)
 * @param {Buffer} params.pdfBuffer - PDF attachment buffer
 * @param {string} params.creatorEmail - email user pembuat barang masuk
 * @param {string} params.creatorName - nama user pembuat barang masuk
 * @param {string} params.financeEmail - email finance / owner untuk penerima
 * @param {string|null} params.vendorEmail - email vendor / supplier untuk CC (jika ada)
 * @param {string|null} params.accentColor - warna aksen dari workspace setting
 * @param {string|null} params.warehouseName - nama gudang tujuan penerimaan
 * @returns {Promise<{status: 'sent'|'failed', error?: string, messageId?: string, subject: string}>}
 */
export async function sendGoodsInEmail({
  doc,
  pdfBuffer,
  creatorEmail,
  creatorName,
  financeEmail,
  vendorEmail,
  accentColor,
  warehouseName = 'Gudang Utama',
  customUnits = null,
}) {
  const vendorName = doc.contact_name || doc.contactName || 'Vendor';
  const whTag = warehouseName ? ` [${warehouseName}]` : '';
  const subject = `[Goods In] - ${doc.document_number} dari ${vendorName}${whTag}`;
  const fromAddress = getSmtpFromAddress();

  const recipientEmail = financeEmail || creatorEmail;

  const ccSet = new Set();
  if (creatorEmail && recipientEmail && creatorEmail.toLowerCase() !== recipientEmail.toLowerCase()) {
    ccSet.add(creatorEmail);
  }
  if (vendorEmail && recipientEmail && vendorEmail.toLowerCase() !== recipientEmail.toLowerCase()) {
    ccSet.add(vendorEmail);
  }
  const ccArray = Array.from(ccSet);

  const baseLog = {
    sender_email: fromAddress || 'no-reply@docuflow.app',
    recipient_email: recipientEmail || null,
    cc_email: ccArray.length > 0 ? ccArray.join(', ') : null,
    subject,
    status: 'pending',
  };
  if (doc.id) {
    baseLog.document_id = doc.id;
  }

  if (!isValidEmail(recipientEmail)) {
    const errorMessage = 'Recipient email is empty or invalid.';
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }

  const transporter = getTransporter();
  if (!transporter) {
    const errorMessage = 'SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing).';
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }

  // Determine frontend URL
  const rawFrontendUrl = process.env.FRONTEND_URL || (process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : 'http://localhost:5173');
  const cleanFrontendUrl = rawFrontendUrl.replace(/\/+$/, '');
  const docLink = `${cleanFrontendUrl}/goods-out`;

  // Resolve palette colors matching workspace accent color
  const cleanAccent = String(accentColor || 'indigo').toLowerCase();
  const colors = PALETTE_COLORS[cleanAccent] || PALETTE_COLORS.indigo;

  const rawItems = Array.isArray(doc.items) ? doc.items : (doc.metadata?.items || []);
  const groupedItems = getGroupedProductItems(rawItems, customUnits || doc.metadata?.custom_units);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalDocumentFormatted = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const itemLines = groupedItems.map((group, index) => {
    const serialInfo = group.serials.length > 0
      ? `\n   No. Seri (${group.serials.length}): ${group.serials.join(', ')}`
      : '';
    const breakdownInfo = group.breakdown ? ` (${group.breakdown})` : '';
    return `${index + 1}. ${group.name} (SKU: ${group.sku}) - ${group.formattedQty}${breakdownInfo}${serialInfo}`;
  }).join('\n');

  const issueDateFormatted = doc.issue_date
    ? new Date(doc.issue_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('id-ID');

  const cleanDocNumber = (doc.document_number || 'dokumen').replace(/[/\\?%*:|"<>]/g, '_');

  const itemRowsHtml = groupedItems.map((g, idx) => {
    const serialSubtitle = g.serials.length > 0
      ? `<div style="font-size: 11px; color: ${colors.primary}; font-weight: 500; margin-top: 4px; word-break: break-all;">No. Seri (${g.serials.length}): ${g.serials.join(', ')}</div>`
      : '';
    const breakdownSubtitle = g.breakdown
      ? `<span style="font-size: 11px; color: #6C6C78; font-weight: normal; display: block; margin-top: 2px;">${g.breakdown}</span>`
      : '';
    return `
      <tr>
        <td style="padding: 10px 12px; font-size: 13px; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; line-height: 1.4; vertical-align: top;">
          <div style="font-weight: 600;">${g.name}</div>
          <div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">SKU: ${g.sku}</div>
          ${serialSubtitle}
        </td>
        <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
          <div>${g.formattedQty}</div>
          ${breakdownSubtitle}
        </td>
      </tr>
    `;
  }).join('');

  const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bukti Barang Masuk</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F7F7F8; font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F7F7F8; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 12px; border: 1px solid #E4E4E9; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03); overflow: hidden;">
          <tr>
            <td height="6" style="background-color: ${colors.primary};"></td>
          </tr>
          <tr>
            <td style="padding: 40px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 700; color: #0D0D0F;">Docuflow</span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: ${colors.light}; color: ${colors.primary}; padding: 6px 12px; border-radius: 9999px;">Barang Masuk</span>
                  </td>
                </tr>
              </table>

              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #0D0D0F; letter-spacing: -0.02em; line-height: 1.3;">
                Bukti Penerimaan Barang Baru
              </h1>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #6C6C78;">
                Halo Team,
              </p>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #0D0D0F;">
                Catatan Barang Masuk (Goods In) baru telah dibuat oleh <strong>${creatorName ?? 'Petugas'}</strong>${creatorEmail ? ` (<a href="mailto:${creatorEmail}" style="color: ${colors.primary}; text-decoration: none;">${creatorEmail}</a>)` : ''} dengan rincian berikut:
              </p>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F9FA; border: 1px solid #E4E4E9; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">No. Referensi</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${doc.document_number}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Dari / Vendor</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${doc.contact_name || '—'}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Gudang Tujuan</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${warehouseName || '—'}</td>
                      </tr>
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Tanggal</td>
                        <td width="70%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${issueDateFormatted}</td>
                      </tr>
                      ${doc.notes ? `
                      <tr>
                        <td width="30%" valign="top" style="padding-bottom: 0; font-size: 13px; font-weight: 500; color: #6C6C78;">Catatan</td>
                        <td width="70%" valign="top" style="padding-bottom: 0; font-size: 13px; font-weight: 500; color: #0D0D0F;">${doc.notes}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding: 12px 0; border-bottom: 2px solid #0D0D0F;">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #0D0D0F;">Item Diterima</span>
                  </td>
                </tr>
              </table>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding: 0;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <thead>
                        <tr>
                          <th align="left" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78; background-color: #F8F9FA;">Item</th>
                          <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78; background-color: #F8F9FA;">Jumlah</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${itemRowsHtml}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #0D0D0F; border-top: 2px solid #E4E4E9;">Total Keseluruhan</td>
                          <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: ${colors.primary}; border-top: 2px solid #E4E4E9; white-space: nowrap;">${totalDocumentFormatted}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </td>
                </tr>
              </table>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${docLink}" target="_blank" style="display: inline-block; background-color: ${colors.primary}; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 6px;">Lihat Barang Masuk</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 1.5; color: #6C6C78;">
                <em>*Terlampir dokumen PDF Bukti Penerimaan Barang.</em>
              </p>

              <hr style="border: 0; border-top: 1px solid #E4E4E9; margin: 32px 0 24px 0;">

              <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #A1A1AA;">
                Email ini dikirim atas konfirmasi petugas sebagai bukti pencatatan barang masuk. Balasan langsung ke email ini mungkin tidak terbaca.
              </p>
              <p style="margin: 0; font-size: 11px; color: #A1A1AA;">
                &copy; 2026 Docuflow. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const plainText = [
    `Bukti Penerimaan Barang (Goods In) baru telah dibuat oleh ${creatorName ?? 'Petugas'} (${creatorEmail || '-'}).`,
    '',
    `No. Referensi : ${doc.document_number}`,
    `Dari / Vendor : ${doc.contact_name || '—'}`,
    `Gudang Tujuan : ${warehouseName || '—'}`,
    `Tanggal       : ${issueDateFormatted}`,
    doc.notes ? `Catatan       : ${doc.notes}` : '',
    '',
    'Daftar Barang Masuk:',
    itemLines,
    '',
    `Total Keseluruhan: ${totalDocumentFormatted}`,
    '',
    `Lihat Barang Masuk selengkapnya di: ${docLink}`,
    '',
    'Terlampir dokumen PDF Bukti Penerimaan Barang.',
  ].filter(Boolean).join('\n');

  try {
    const info = await sendMailWithRetry({
      from: fromAddress,
      to: recipientEmail,
      cc: ccArray.length > 0 ? ccArray : undefined,
      subject,
      text: plainText,
      html: htmlContent,
      attachments: [
        {
          filename: `GoodsIn-${cleanDocNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
    } catch (_) {}

    return { status: 'sent', messageId: info.messageId, subject };
  } catch (err) {
    const errorMessage = err?.message ?? String(err);
    try {
      await supabaseAdmin.from('email_logs').insert({
        ...baseLog,
        status: 'failed',
        error_message: errorMessage,
      });
    } catch (_) {}
    return { status: 'failed', error: errorMessage, subject };
  }
}

// ============================================================================
// EMAIL NOTIFIKASI RETUR
// ============================================================================

const RETURN_REASON_LABELS = {
  salah_produk: 'Salah Produk',
  cacat_produk: 'Cacat / Rusak',
  batal_beli: 'Batal Beli / Gak Jadi',
  cacat_supplier: 'Cacat / Rusak Supplier',
  salah_kirim: 'Salah Kirim Supplier',
  batal_masuk: 'Batal Masuk Gudang',
  lainnya: 'Lainnya',
};

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatReturnDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return `${date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} WIB`;
}

function getReturnDocumentLabel(documentType) {
  return documentType === 'goods_in' ? 'Barang Masuk' : 'Barang Keluar';
}

function resolveReturnItems(returnRecord, doc) {
  const docItems = Array.isArray(doc?.items) ? doc.items : [];
  const items = Array.isArray(returnRecord?.items) ? returnRecord.items : [];

  const rawList = items.map((item) => {
    const matchedDocItem =
      docItems.find((di) => item.itemId && di.id === item.itemId) ||
      docItems.find((di) => item.productId && (di.product_id ?? di.productId) === item.productId) ||
      docItems.find(
        (di) =>
          item.serialNumber &&
          di.metadata?.isSerial === true &&
          String(di.metadata?.serialNumber || '').trim().toLowerCase() ===
            String(item.serialNumber).trim().toLowerCase()
      ) ||
      null;

    const returnedQty = Number(item.returnedQty || 1) || 1;
    const qtyUnit = item.qtyUnit || matchedDocItem?.metadata?.qtyUnit || 'pcs';
    const baseQty = Number(item.baseQuantityPcs || 0);
    const condition = item.condition || item.targetStatus || 'available';
    const serialNumber = item.serialNumber ? String(item.serialNumber).trim() : null;
    const serialNumbers = Array.isArray(item.serialNumbers)
      ? item.serialNumbers.map((s) => String(s).trim()).filter(Boolean)
      : (serialNumber ? [serialNumber] : []);

    return {
      name: item.productName || matchedDocItem?.item_name || 'Barang',
      sku: item.sku || matchedDocItem?.sku || '',
      productId: item.productId || matchedDocItem?.product_id || matchedDocItem?.productId || '',
      qty: returnedQty,
      unit: qtyUnit,
      baseQty: Number.isFinite(baseQty) ? baseQty : 0,
      serialNumber,
      serialNumbers,
      condition,
      isSerial: Boolean(item.isSerial) || Boolean(serialNumber) || serialNumbers.length > 0,
    };
  });

  const grouped = [];
  const map = new Map();

  rawList.forEach((item) => {
    const key = `${item.productId || item.name}::${item.sku}::${item.unit}::${item.condition}`;
    if (!map.has(key)) {
      const copy = { ...item, serialNumbers: [...item.serialNumbers] };
      map.set(key, copy);
      grouped.push(copy);
    } else {
      const existing = map.get(key);
      existing.qty += item.qty;
      existing.baseQty += item.baseQty;
      item.serialNumbers.forEach((sn) => {
        if (!existing.serialNumbers.includes(sn)) {
          existing.serialNumbers.push(sn);
        }
      });
      if (existing.serialNumbers.length === 1) {
        existing.serialNumber = existing.serialNumbers[0];
      } else if (existing.serialNumbers.length > 1) {
        existing.serialNumber = null;
      }
    }
  });

  return grouped;
}

function isMissingEmailLogColumn(error) {
  const message = error?.message || '';
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the .*column/i.test(message)
  );
}

// Lease harus lebih panjang dari total waktu SMTP internal (3 percobaan +
// backoff + timeout socket). 10 menit memberi ruang aman di serverless.
const PENDING_EMAIL_LEASE_MS = 10 * 60 * 1000;
const UNCERTAIN_PENDING_MESSAGE =
  'Status pengiriman tidak pasti: worker berhenti setelah email diklaim. Email mungkin sudah terkirim. Periksa kotak masuk/outbox sebelum mengirim ulang secara manual.';

function isStalePendingLog(log, hasLeaseColumns) {
  if (!hasLeaseColumns || !log?.last_attempt_at) return false;
  const startedAt = Date.parse(log.last_attempt_at);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt >= PENDING_EMAIL_LEASE_MS;
}

async function selectReturnEmailLog({ documentId, returnId, existingLogId = null }) {
  const buildQuery = (columns) => {
    let query = supabaseAdmin.from('email_logs').select(columns);
    if (existingLogId) {
      query = query.eq('id', existingLogId);
    } else {
      query = query
        .eq('document_id', documentId)
        .eq('return_id', returnId)
        .eq('email_type', 'return');
    }
    return query.maybeSingle();
  };

  const withLease = await buildQuery('id, status, last_attempt_at, created_at');
  if (!withLease.error) return { ...withLease, hasLeaseColumns: true };

  if (!isMissingEmailLogColumn(withLease.error)) return { ...withLease, hasLeaseColumns: false };

  // Migration 021 belum dijalankan: tetap bisa kirim, tetapi recovery log
  // pending tidak diaktifkan agar tidak ada klaim palsu terhadap worker lain.
  const withoutLease = await buildQuery('id, status, created_at');
  if (!withoutLease.error) return { ...withoutLease, hasLeaseColumns: false };

  if (isMissingEmailLogColumn(withoutLease.error)) {
    throw new Error(
      'Migration 020_return_email_logs.sql belum dijalankan (kolom return_id/email_type belum ada).'
    );
  }
  throw withoutLease.error;
}

async function markStalePendingAsUncertain(logId) {
  const { data, error } = await supabaseAdmin
    .from('email_logs')
    .update({ status: 'uncertain', error_message: UNCERTAIN_PENDING_MESSAGE })
    .eq('id', logId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

async function claimKnownReturnEmailLog(log, { manualRetry, hasLeaseColumns }) {
  if (!log?.id) return { skipped: true, reason: 'log_not_found' };

  if (log.status === 'sent') return { skipped: true, reason: 'already_sent' };

  if (log.status === 'pending') {
    if (isStalePendingLog(log, hasLeaseColumns)) {
      const marked = await markStalePendingAsUncertain(log.id);
      return {
        skipped: true,
        reason: marked ? 'stale_pending_marked_uncertain' : 'pending_claim_race',
      };
    }
    return { skipped: true, reason: 'in_progress' };
  }

  const canClaimFailed = log.status === 'failed';
  const canClaimUncertain = manualRetry && log.status === 'uncertain';
  if (!canClaimFailed && !canClaimUncertain) {
    return { skipped: true, reason: 'not_retryable' };
  }

  const claimPatch = {
    status: 'pending',
    error_message: null,
    ...(hasLeaseColumns ? { last_attempt_at: new Date().toISOString() } : {}),
  };
  const { data, error } = await supabaseAdmin
    .from('email_logs')
    .update(claimPatch)
    .eq('id', log.id)
    .eq('status', log.status)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data?.id ? { logId: data.id } : { skipped: true, reason: 'claim_lost' };
}

async function insertReturnEmailLog(fullBaseLog) {
  const nowIso = new Date().toISOString();
  const insertWithLease = () =>
    supabaseAdmin
      .from('email_logs')
      .insert({ ...fullBaseLog, status: 'pending', last_attempt_at: nowIso })
      .select('id')
      .single();

  let { data, error } = await insertWithLease();
  if (!error) return { logId: data?.id ?? null, hasLeaseColumns: true, error: null };

  // Migration 021 belum jalan: email tetap boleh dikirim, hanya lease yang
  // tidak tersedia. Jangan fallback untuk kolom retur yang hilang (020).
  if (isMissingEmailLogColumn(error) && /last_attempt_at/i.test(error?.message || '')) {
    ({ data, error } = await supabaseAdmin
      .from('email_logs')
      .insert({ ...fullBaseLog, status: 'pending' })
      .select('id')
      .single());
    if (!error) return { logId: data?.id ?? null, hasLeaseColumns: false, error: null };
  }

  return { logId: null, hasLeaseColumns: false, error };
}

/**
 * Klaim idempoten satu baris email_logs per retur.
 * - Return yang sudah punya log `sent` tidak akan dikirim ulang.
 * - Log `pending` yang masih dalam lease dilewati (worker lain sedang kirim).
 * - Log `pending` yang lease-nya kedaluwarsa ditandai `uncertain`, TIDAK
 *   dikirim ulang otomatis karena email bisa saja sudah sampai ke penerima.
 * - Log `failed` boleh diklaim ulang oleh retry worker.
 * - Log `uncertain` hanya boleh diklaim lewat aksi manual (manualRetry).
 */
async function claimReturnEmailLog({
  fullBaseLog,
  documentId,
  returnId,
  subject,
  existingLogId = null,
  manualRetry = false,
}) {
  if (existingLogId) {
    const current = await selectReturnEmailLog({ documentId, returnId, existingLogId });
    if (current.data) {
      return claimKnownReturnEmailLog(current.data, {
        manualRetry,
        hasLeaseColumns: current.hasLeaseColumns,
      });
    }
  }

  if (returnId) {
    const current = await selectReturnEmailLog({ documentId, returnId });
    if (current.data) {
      return claimKnownReturnEmailLog(current.data, {
        manualRetry,
        hasLeaseColumns: current.hasLeaseColumns,
      });
    }
  } else {
    const { data: sentLog, error } = await supabaseAdmin
      .from('email_logs')
      .select('id')
      .eq('document_id', documentId)
      .eq('subject', subject)
      .eq('status', 'sent')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (sentLog?.id) return { skipped: true, reason: 'already_sent' };
  }

  const inserted = await insertReturnEmailLog(fullBaseLog);
  if (!inserted.error) return { logId: inserted.logId };

  if (inserted.error.code === '23505' && returnId) {
    const current = await selectReturnEmailLog({ documentId, returnId });
    if (current.data) {
      return claimKnownReturnEmailLog(current.data, {
        manualRetry,
        hasLeaseColumns: current.hasLeaseColumns,
      });
    }
  }

  if (isMissingEmailLogColumn(inserted.error)) {
    throw new Error('Migration 020_return_email_logs.sql belum dijalankan (kolom return_id/email_type belum ada).');
  }
  throw inserted.error;
}

/**
 * Pulihkan log retur `pending` yang lease-nya sudah kedaluwarsa.
 * Sengaja hanya menandai `uncertain`, bukan `failed` atau mengirim ulang:
 * SMTP tidak punya idempotency key, jadi email bisa sudah terkirim sebelum
 * worker mati. Retry otomatis pada kondisi ini berisiko mengirim duplikat.
 *
 * @returns {Promise<{supported:boolean, scanned:number, recovered:number}>}
 */
export async function recoverStalePendingReturnEmails({ limit = 3 } = {}) {
  const staleBefore = new Date(Date.now() - PENDING_EMAIL_LEASE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('email_logs')
    .select('id')
    .eq('status', 'pending')
    .eq('email_type', 'return')
    .not('return_id', 'is', null)
    .lt('last_attempt_at', staleBefore)
    .limit(limit);

  if (error) {
    if (isMissingEmailLogColumn(error)) return { supported: false, scanned: 0, recovered: 0 };
    throw error;
  }

  let recovered = 0;
  for (const row of data || []) {
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('email_logs')
      .update({ status: 'uncertain', error_message: UNCERTAIN_PENDING_MESSAGE })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (updateError) {
      if (isMissingEmailLogColumn(updateError)) return { supported: false, scanned: data.length, recovered };
      throw updateError;
    }
    if (updated?.id) recovered += 1;
  }

  return { supported: true, scanned: (data || []).length, recovered };
}

async function updateReturnEmailLog(logId, patch) {
  if (!logId) return;
  const { error } = await supabaseAdmin.from('email_logs').update(patch).eq('id', logId);
  if (error) {
    console.error('[Return Email] Failed to update email_logs:', error.message);
  }
}

/**
 * Kirim notifikasi retur (Goods In / Goods Out) ke penerima yang sudah
 * dikonfigurasi, lengkap dengan lampiran PDF retur format rangkap.
 *
 * @param {Object} params
 * @param {Object} params.doc - Dokumen asal (id, document_number, document_type, contact_name, items)
 * @param {Object} params.returnRecord - Record retur dari documents.metadata.returns
 * @param {string} params.returnNumber - Nomor retur yang ditampilkan ke pengguna
 * @param {string} params.creatorEmail - Email petugas yang memproses retur
 * @param {string} params.creatorName - Nama petugas yang memproses retur
 * @param {string} params.financeEmail - Email finance/owner/gudang dari konfigurasi workspace
 * @param {string} [params.accentColor]
 * @param {string} [params.warehouseName]
 * @param {Object} [params.companySettings] - Settings workspace untuk header PDF
 * @param {Object} [params.contactData] - Data kontak asal untuk header PDF
 * @param {string} [params.existingLogId] - Dipakai retry worker agar baris log yang sama di-update
 * @param {boolean} [params.manualRetry] - Izinkan klaim ulang log `uncertain` (aksi manual)
 * @returns {Promise<{status:'sent'|'failed'|'skipped', error?:string, messageId?:string, subject:string}>}
 */
export async function sendReturnEmail({
  doc,
  returnRecord,
  returnNumber,
  creatorEmail,
  creatorName,
  financeEmail,
  accentColor,
  warehouseName = 'Gudang Utama',
  companySettings = {},
  contactData = {},
  existingLogId = null,
  manualRetry = false,
}) {
  const documentLabel = getReturnDocumentLabel(doc?.document_type);
  const destination = doc?.contact_name || '—';
  const resolvedReturnNumber =
    returnNumber || returnRecord?.returnNumber || `RET-${doc?.document_number || 'DOKUMEN'}`;
  const whTag = warehouseName ? ` [${warehouseName}]` : '';
  const subject = `[Return] - ${resolvedReturnNumber} - ${doc?.document_number || '-'}${whTag}`;
  const fromAddress = getSmtpFromAddress();
  const recipientEmail = financeEmail || creatorEmail;

  const ccSet = new Set();
  if (creatorEmail && recipientEmail && creatorEmail.toLowerCase() !== recipientEmail.toLowerCase()) {
    ccSet.add(creatorEmail);
  }
  const ccArray = Array.from(ccSet);

  const fullBaseLog = {
    sender_email: fromAddress || 'no-reply@docuflow.app',
    recipient_email: recipientEmail || null,
    cc_email: ccArray.length > 0 ? ccArray.join(', ') : null,
    subject,
    document_id: doc?.id || null,
    return_id: returnRecord?.id || null,
    email_type: 'return',
  };

  let claim;
  try {
    claim = await claimReturnEmailLog({
      fullBaseLog,
      documentId: doc?.id || null,
      returnId: returnRecord?.id || null,
      subject,
      existingLogId,
      manualRetry,
    });
  } catch (claimError) {
    console.error('[Return Email] Failed to claim email_logs:', claimError?.message ?? claimError);
    return {
      status: 'failed',
      error: claimError?.message ?? 'Gagal menyiapkan log email retur.',
      subject,
    };
  }

  if (claim.skipped) {
    return {
      status: 'skipped',
      reason: claim.reason || 'already_sent_or_in_progress',
      subject,
    };
  }

  const logId = claim.logId || null;

  if (!isValidEmail(recipientEmail)) {
    const errorMessage = 'Recipient email is empty or invalid.';
    await updateReturnEmailLog(logId, { status: 'failed', error_message: errorMessage });
    return { status: 'failed', error: errorMessage, subject };
  }

  const transporter = getTransporter();
  if (!transporter) {
    const errorMessage = 'SMTP credentials not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing).';
    await updateReturnEmailLog(logId, { status: 'failed', error_message: errorMessage });
    return { status: 'failed', error: errorMessage, subject };
  }

  let pdfBuffer;
  try {
    pdfBuffer = generateReturnPdfCompact(
      {
        ...(returnRecord || {}),
        documentNumber: doc?.document_number || returnRecord?.documentNumber || '-',
        documentType: doc?.document_type || returnRecord?.documentType || returnRecord?.document_type,
        contactName: doc?.contact_name || returnRecord?.contactName,
        warehouseName,
      },
      companySettings || {},
      contactData || {},
      doc || {}
    );
  } catch (pdfError) {
    const errorMessage = `Gagal membuat PDF retur: ${pdfError?.message || String(pdfError)}`;
    await updateReturnEmailLog(logId, { status: 'failed', error_message: errorMessage });
    return { status: 'failed', error: errorMessage, subject };
  }

  const rawFrontendUrl =
    process.env.FRONTEND_URL ||
    (process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : 'http://localhost:5173');
  const cleanFrontendUrl = rawFrontendUrl.replace(/\/+$/, '');
  const docLink = `${cleanFrontendUrl}/returns`;

  const cleanAccent = String(accentColor || 'indigo').toLowerCase();
  const colors = PALETTE_COLORS[cleanAccent] || PALETTE_COLORS.indigo;

  const returnDate = formatReturnDateTime(returnRecord?.returnedAt || returnRecord?.date);
  const reason = RETURN_REASON_LABELS[returnRecord?.reason] || returnRecord?.reason || '-';
  const notes = returnRecord?.notes || null;
  const items = resolveReturnItems(returnRecord, doc);
  const conditionLabel = (condition) => (condition === 'damaged' ? 'Rusak' : 'Baik');

  const itemLines = items.map((item, index) => {
    let serialInfo = '';
    if (item.serialNumbers && item.serialNumbers.length > 1) {
      serialInfo = ` | No. Seri (${item.serialNumbers.length}): ${item.serialNumbers.join(', ')}`;
    } else if (item.serialNumber || (item.serialNumbers && item.serialNumbers.length === 1)) {
      serialInfo = ` | No. Seri: ${item.serialNumber || item.serialNumbers[0]}`;
    }
    const baseInfo = item.baseQty > 0 && item.baseQty !== item.qty ? ` (${item.baseQty} pcs)` : '';
    const skuInfo = item.sku ? ` | SKU: ${item.sku}` : '';
    return `${index + 1}. ${item.name}${skuInfo} - ${item.qty} ${item.unit}${baseInfo} | Kondisi: ${conditionLabel(item.condition)}${serialInfo}`;
  });

  const plainText = [
    `Notifikasi retur ${documentLabel} telah diproses.`,
    '',
    `No. Retur       : ${resolvedReturnNumber}`,
    `Dokumen Asal    : ${doc?.document_number || '-'} (${documentLabel})`,
    `Tanggal / Waktu : ${returnDate}`,
    `Gudang          : ${warehouseName || '-'}`,
    `Petugas         : ${creatorName || 'Petugas'}${creatorEmail ? ` (${creatorEmail})` : ''}`,
    doc?.contact_name ? `Pihak Terkait   : ${destination}` : '',
    `Alasan          : ${reason}`,
    notes ? `Catatan         : ${notes}` : '',
    '',
    'Barang yang diretur:',
    itemLines.length > 0 ? itemLines.join('\n') : '-',
    '',
    `Total jenis item: ${items.length}`,
    '',
    'Terlampir dokumen PDF Bukti Retur (format rangkap 21 x 12 cm).',
    '',
    `Lihat daftar retur di: ${docLink}`,
    '',
    'Email ini dikirim otomatis oleh DocuFlow.',
  ]
    .filter(Boolean)
    .join('\n');

  const itemRowsHtml = items
    .map((item) => {
      let serialHtml = '';
      if (item.serialNumbers && item.serialNumbers.length > 1) {
        serialHtml = `<div style="font-size: 11px; color: ${colors.primary}; margin-top: 4px; word-break: break-all;">No. Seri (${item.serialNumbers.length}): ${escapeEmailHtml(item.serialNumbers.join(', '))}</div>`;
      } else if (item.serialNumber || (item.serialNumbers && item.serialNumbers.length === 1)) {
        serialHtml = `<div style="font-size: 11px; color: ${colors.primary}; margin-top: 4px; word-break: break-all;">No. Seri: ${escapeEmailHtml(item.serialNumber || item.serialNumbers[0])}</div>`;
      }
      const baseHtml =
        item.baseQty > 0 && item.baseQty !== item.qty
          ? `<div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">${escapeEmailHtml(item.baseQty)} pcs</div>`
          : '';
      return `
        <tr>
          <td style="padding: 10px 12px; font-size: 13px; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; vertical-align: top;">
            <div style="font-weight: 600;">${escapeEmailHtml(item.name)}</div>
            ${item.sku ? `<div style="font-size: 11px; color: #6C6C78; margin-top: 2px;">SKU: ${escapeEmailHtml(item.sku)}</div>` : ''}
            ${serialHtml}
          </td>
          <td align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0D0D0F; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
            <div>${escapeEmailHtml(item.qty)} ${escapeEmailHtml(item.unit)}</div>
            ${baseHtml}
          </td>
          <td align="right" style="padding: 10px 12px; font-size: 12px; color: ${item.condition === 'damaged' ? '#E11D48' : '#059669'}; border-bottom: 1px solid #EEEEEF; white-space: nowrap; vertical-align: top;">
            ${conditionLabel(item.condition)}
          </td>
        </tr>
      `;
    })
    .join('');

  const htmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notifikasi Retur</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F7F7F8; font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F7F7F8; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 12px; border: 1px solid #E4E4E9; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03); overflow: hidden;">
          <tr>
            <td height="6" style="background-color: ${colors.primary};"></td>
          </tr>
          <tr>
            <td style="padding: 40px 32px;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 700; color: #0D0D0F; letter-spacing: -0.02em;">Docuflow</span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; background-color: ${colors.light}; color: ${colors.primary}; padding: 6px 12px; border-radius: 9999px;">Retur ${escapeEmailHtml(documentLabel)}</span>
                  </td>
                </tr>
              </table>

              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #0D0D0F; letter-spacing: -0.02em; line-height: 1.3;">
                Retur ${escapeEmailHtml(documentLabel)} Berhasil Diproses
              </h1>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #6C6C78;">
                Halo Team,
              </p>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #0D0D0F;">
                Retur untuk dokumen <strong>${escapeEmailHtml(doc?.document_number || '-')}</strong> telah diproses oleh <strong>${escapeEmailHtml(creatorName || 'Petugas')}</strong>${creatorEmail ? ` (<a href="mailto:${escapeEmailHtml(creatorEmail)}" style="color: ${colors.primary}; text-decoration: none;">${escapeEmailHtml(creatorEmail)}</a>)` : ''}. Berikut rinciannya:
              </p>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F9FA; border: 1px solid #E4E4E9; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">No. Retur</td>
                        <td width="68%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${escapeEmailHtml(resolvedReturnNumber)}</td>
                      </tr>
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Dokumen Asal</td>
                        <td width="68%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 600; color: #0D0D0F;">${escapeEmailHtml(doc?.document_number || '-')} (${escapeEmailHtml(documentLabel)})</td>
                      </tr>
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Tanggal / Waktu</td>
                        <td width="68%" valign="top" style="padding-bottom: 12px; font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(returnDate)}</td>
                      </tr>
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Gudang</td>
                        <td width="68%" valign="top" style="padding-bottom: 12px; font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(warehouseName || '-')}</td>
                      </tr>
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: 12px; font-size: 13px; font-weight: 500; color: #6C6C78;">Pihak Terkait</td>
                        <td width="68%" valign="top" style="padding-bottom: 12px; font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(destination)}</td>
                      </tr>
                      <tr>
                        <td width="32%" valign="top" style="padding-bottom: ${notes ? '12px' : '0'}; font-size: 13px; font-weight: 500; color: #6C6C78;">Alasan</td>
                        <td width="68%" valign="top" style="padding-bottom: ${notes ? '12px' : '0'}; font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(reason)}</td>
                      </tr>
                      ${notes ? `
                      <tr>
                        <td width="32%" valign="top" style="font-size: 13px; font-weight: 500; color: #6C6C78;">Catatan</td>
                        <td width="68%" valign="top" style="font-size: 13px; color: #0D0D0F;">${escapeEmailHtml(notes)}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; margin-bottom: 28px; border: 1px solid #E4E4E9; border-radius: 8px; overflow: hidden;">
                <thead>
                  <tr style="background-color: #F8F9FA; border-bottom: 1px solid #E4E4E9;">
                    <th align="left" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Item</th>
                    <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Jumlah</th>
                    <th align="right" style="padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6C6C78;">Kondisi</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRowsHtml || '<tr><td colspan="3" style="padding: 12px; font-size: 13px; color: #6C6C78;">Tidak ada item.</td></tr>'}
                </tbody>
              </table>

              <p style="margin: 0 0 20px 0; font-size: 13px; line-height: 1.5; color: #6C6C78;">
                <em>*Terlampir dokumen PDF Bukti Retur (format rangkap 21 x 12 cm).</em>
              </p>

              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 32px;">
                <tr>
                  <td align="center">
                    <a href="${docLink}" target="_blank" style="display: inline-block; background-color: ${colors.primary}; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 6px; box-shadow: 0 4px 14px ${colors.shadow};">
                      Lihat Daftar Retur
                    </a>
                  </td>
                </tr>
              </table>

              <hr style="border: 0; border-top: 1px solid #E4E4E9; margin: 32px 0 24px 0;">

              <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #A1A1AA;">
                Email ini dikirim secara otomatis oleh sistem <strong>Docuflow</strong> setelah transaksi retur berhasil disimpan. Harap tidak membalas email ini secara langsung.
              </p>
              <p style="margin: 0; font-size: 11px; color: #A1A1AA;">
                &copy; 2026 Docuflow. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const cleanReturnNumber = String(resolvedReturnNumber || 'retur')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_');

  try {
    const info = await sendMailWithRetry({
      from: fromAddress,
      to: recipientEmail,
      cc: ccArray.length > 0 ? ccArray : undefined,
      subject,
      text: plainText,
      html: htmlContent,
      attachments: [
        {
          filename: `Return-${cleanReturnNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    await updateReturnEmailLog(logId, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      error_message: null,
    });

    return { status: 'sent', messageId: info.messageId, subject };
  } catch (err) {
    const errorMessage = err?.message || String(err);
    await updateReturnEmailLog(logId, { status: 'failed', error_message: errorMessage });
    return { status: 'failed', error: errorMessage, subject };
  }
}

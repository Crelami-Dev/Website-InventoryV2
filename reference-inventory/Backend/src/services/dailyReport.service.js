import { supabaseAdmin } from '../lib/supabase.js';
import {
  getTransporter,
  sendMailWithRetry,
  resolveFinanceEmail,
  isValidEmail,
  getSmtpFromAddress,
} from './email.service.js';
import { generateDailyReportPdf } from './dailyReportPdf.service.js';
import { generateDailyReportExcel } from './dailyReportExcel.service.js';
import { z } from 'zod';
import { resolveDocumentItemQuantity } from '../utils/documentQuantity.js';

export const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// ============================================================================
// 1. PALETTES AKSEN OWNER & RESOLUSI TEMA
// ============================================================================

export const OWNER_PALETTES = {
  indigo: {
    name: 'Indigo',
    primary: '#4F46E5',
    hover: '#4338CA',
    lightBg: '#EEF2FF',
    borderColor: '#C7D2FE',
    darkText: '#3730A3',
    rgb: [79, 70, 229],
    lightRgb: [238, 242, 255],
    darkRgb: [55, 48, 163],
    hexFill: 'FF4F46E5',
    lightHexFill: 'FFEEF2FF',
  },
  emerald: {
    name: 'Emerald',
    primary: '#059669',
    hover: '#047857',
    lightBg: '#ECFDF5',
    borderColor: '#A7F3D0',
    darkText: '#065F46',
    rgb: [5, 150, 105],
    lightRgb: [236, 253, 245],
    darkRgb: [6, 95, 70],
    hexFill: 'FF059669',
    lightHexFill: 'FFECFDF5',
  },
  rose: {
    name: 'Rose',
    primary: '#E11D48',
    hover: '#BE123C',
    lightBg: '#FFF1F2',
    borderColor: '#FECDD3',
    darkText: '#9F1239',
    rgb: [225, 29, 72],
    lightRgb: [255, 241, 242],
    darkRgb: [159, 18, 57],
    hexFill: 'FFE11D48',
    lightHexFill: 'FFFFF1F2',
  },
  amber: {
    name: 'Amber',
    primary: '#D97706',
    hover: '#B45309',
    lightBg: '#FFFBEB',
    borderColor: '#FDE68A',
    darkText: '#92400E',
    rgb: [217, 119, 6],
    lightRgb: [255, 251, 235],
    darkRgb: [146, 64, 14],
    hexFill: 'FFD97706',
    lightHexFill: 'FFFFFBEB',
  },
  sky: {
    name: 'Sky',
    primary: '#0284C7',
    hover: '#0369A1',
    lightBg: '#F0F9FF',
    borderColor: '#BAE6FD',
    darkText: '#075985',
    rgb: [2, 132, 199],
    lightRgb: [240, 249, 255],
    darkRgb: [7, 89, 133],
    hexFill: 'FF0284C7',
    lightHexFill: 'FFF0F9FF',
  },
  violet: {
    name: 'Violet',
    primary: '#7C3AED',
    hover: '#6D28D9',
    lightBg: '#F5F3FF',
    borderColor: '#DDD6FE',
    darkText: '#5B21B6',
    rgb: [124, 58, 237],
    lightRgb: [245, 243, 255],
    darkRgb: [91, 33, 182],
    hexFill: 'FF7C3AED',
    lightHexFill: 'FFF5F3FF',
  },
};

/**
 * Resolusi palet warna aksen berdasarkan pengaturan Owner.
 * Fallback aman ke Indigo jika null, tidak ditemukan, atau tidak valid.
 */
export function resolveOwnerAccentPalette(rawAccent) {
  if (!rawAccent) return OWNER_PALETTES.indigo;
  const key = String(rawAccent).toLowerCase().trim();
  return OWNER_PALETTES[key] || OWNER_PALETTES.indigo;
}

// ============================================================================
// 1. MULTIPLIERS & PARSER SATUAN (AGENTS.md & BACKWARD COMPATIBILITY)
// ============================================================================

export const REPORT_MULTIPLIERS = {
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
  bal: 300,   // Fallback & Legacy compatibility per Rule 1 in AGENTS.md
};

/**
 * Parser satuan dari string nomor seri (serial number)
 * Terurut dari yang paling spesifik ke yang paling umum sesuai Rule 3 AGENTS.md.
 */
export function parseUnitFromSn(sn) {
  if (!sn) return 'pcs';
  const clean = String(sn).toLowerCase().trim();

  if (clean.includes('bl25') || clean.includes('25bl') || clean.includes('bal25') || clean.includes('25bal')) return 'bal25';
  if (clean.includes('bl20') || clean.includes('20bl') || clean.includes('bal20') || clean.includes('20bal')) return 'bal20';
  if (clean.includes('bl15') || clean.includes('15bl') || clean.includes('bal15') || clean.includes('15bal')) return 'bal15';
  if (clean.includes('bl10') || clean.includes('10bl') || clean.includes('bal10') || clean.includes('10bal')) return 'bal10';
  if (clean.includes('bl5') || clean.includes('5bl') || clean.includes('bal5') || clean.includes('5bal')) return 'bal5';
  if (clean.includes('pack6') || clean.includes('pk6') || clean.includes('6pk')) return 'pack6';
  if (clean.includes('pack3') || clean.includes('pk3') || clean.includes('3pk')) return 'pack3';
  if (clean.includes('pack5') || clean.includes('pk5') || clean.includes('5pk')) return 'pack';
  if (clean.includes('lusin') || clean.includes('doz') || clean.includes('-ls-') || clean.includes('_ls_') || clean.endsWith('-ls')) return 'lusin';
  if (clean.includes('bal') || clean.includes('bl')) return 'bal25';
  if (clean.includes('pack') || clean.includes('pk')) return 'pack';

  return 'pcs';
}

/**
 * Sanitasi nama gudang untuk nama file lampiran PDF dan Excel yang aman di berbagai OS.
 * Contoh hasil: Laporan_Gudang_1_2026-10-20.pdf
 */
export function sanitizeWarehouseFileName(warehouseName, targetDate, ext = '.pdf') {
  let cleanName = String(warehouseName || 'Gudang')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '_');
  if (!cleanName) cleanName = 'Gudang';
  const extension = ext.startsWith('.') ? ext : `.${ext}`;
  return `Laporan_${cleanName}_${targetDate}${extension}`;
}

/**
 * Helper pencocokan dokumen ke gudang spesifik untuk isolasi data antargudang
 */
export function docBelongsToWarehouse(d, wh, allWhs = []) {
  if (d.warehouse_id && d.warehouse_id !== 'default') {
    return d.warehouse_id === wh.id;
  }
  if (d.metadata?.warehouseId && d.metadata.warehouseId !== 'default') {
    return d.metadata.warehouseId === wh.id;
  }
  if (d.metadata?.warehouse) {
    const metaWh = String(d.metadata.warehouse).trim().toLowerCase();
    if (wh.name && metaWh === wh.name.toLowerCase()) return true;
    if (wh.code && metaWh === wh.code.toLowerCase()) return true;
    const matchesOther = allWhs.some((other) => {
      if (other.id === wh.id) return false;
      if (other.name && metaWh === other.name.toLowerCase()) return true;
      if (other.code && metaWh === other.code.toLowerCase()) return true;
      return false;
    });
    if (matchesOther) return false;
  }
  const isDefaultWh = Boolean(wh.is_default) || (allWhs.length > 0 && allWhs[0]?.id === wh.id);
  return isDefaultWh;
}

/**
 * Helper pencocokan retur ke gudang spesifik
 */
export function returnBelongsToWarehouse(ret, doc, wh, allWhs = []) {
  const retWhId = ret.warehouseId || ret.warehouse_id;
  if (retWhId && retWhId !== 'default') {
    return retWhId === wh.id;
  }
  return docBelongsToWarehouse(doc || {}, wh, allWhs);
}

/**
 * Konversi kuantitas item ke Pcs (Satuan Dasar) dengan pengamanan anti-double conversion.
 * 1. Jika metadata.baseQuantity ada dan valid, gunakan langsung (sudah berupa pcs).
 * 2. Jika item serial, kuantitas kemasan adalah 1 x multiplier satuan yang terdeteksi.
 * 3. Jika non-serial, gunakan qtyInput (atau fallback quantity) x multiplier satuan.
 */
export function resolveItemBaseQty(item) {
  if (item?.metadata?.baseQuantity != null && !isNaN(Number(item.metadata.baseQuantity))) {
    return Number(item.metadata.baseQuantity);
  }

  if (item?.metadata?.isGroup === true || item?.isGroup === true) {
    return resolveDocumentItemQuantity(item, { multipliers: REPORT_MULTIPLIERS }).pcs;
  }

  const isSerial = item?.metadata?.isSerial === true || !!item?.metadata?.serialNumber || item?.isSerial === true || !!item?.serialNumber;
  let unit = String(item?.metadata?.qtyUnit || item?.qtyUnit || item?.unit || 'pcs').toLowerCase().trim();

  const serialNum = item?.metadata?.serialNumber || item?.serialNumber;
  if (isSerial && serialNum && (!unit || unit === 'pcs' || unit === 'piece')) {
    unit = parseUnitFromSn(serialNum);
  }

  const mult = REPORT_MULTIPLIERS[unit] || 1;
  const rawCandidate = Number(item?.returnedQty ?? item?.metadata?.qtyInput ?? item?.quantity ?? 0);
  const rawInput = isSerial ? 1 : (isNaN(rawCandidate) || rawCandidate < 0 ? 0 : rawCandidate);
  return rawInput * mult;
}

/**
 * Format rincian satuan asli untuk tampilan ringkasan (misal: "2 bal25, 4 pack, 12 pcs")
 */
export function formatItemUnitBreakdown(items) {
  const map = {};
  for (const it of items) {
    if (it?.metadata?.isGroup === true || it?.isGroup === true) {
      const resolved = resolveDocumentItemQuantity(it, { multipliers: REPORT_MULTIPLIERS });
      map[resolved.unit] = (map[resolved.unit] || 0) + resolved.qty;
      continue;
    }

    const isSerial = it?.metadata?.isSerial === true || !!it?.metadata?.serialNumber || it?.isSerial === true || !!it?.serialNumber;
    let unit = String(it?.metadata?.qtyUnit || it?.qtyUnit || it?.unit || 'pcs').toLowerCase().trim();
    const sn = it?.metadata?.serialNumber || it?.serialNumber;
    if (isSerial && sn && (!unit || unit === 'pcs' || unit === 'piece')) {
      unit = parseUnitFromSn(sn);
    }
    const qty = Number(it?.returnedQty ?? it?.metadata?.qtyInput ?? (isSerial ? 1 : it?.quantity) ?? 1);
    map[unit] = (map[unit] || 0) + qty;
  }
  const entries = Object.entries(map);
  if (entries.length === 0) return '0 pcs';
  return entries.map(([u, q]) => `${q} ${u}`).join(', ');
}

// ============================================================================
// 1.1 VALIDASI ALAMAT EMAIL DUMMY / DOMAIN CONTOH
// ============================================================================

export function isDummyOrExampleEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const lower = email.trim().toLowerCase();
  const dummySuffixes = ['.test', '.example', '.invalid', '.localhost'];
  const atParts = lower.split('@');
  if (atParts.length !== 2) return true;
  const domain = atParts[1];
  if (dummySuffixes.some((suffix) => domain.endsWith(suffix))) {
    return true;
  }
  if (['example.com', 'example.org', 'example.net', 'domain.com'].includes(domain)) {
    return true;
  }
  return false;
}

// ============================================================================
// 2. TIMEZONE & BATAS HARI ASIA/JAKARTA (WIB)
// ============================================================================

export function getWibDayBoundaries(dateStr = null) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  
  // Format ISO UTC yang merepresentasikan 00:00:00.000 hingga 23:59:59.999 di WIB (UTC+7)
  const startOfDayIso = new Date(`${targetDate}T00:00:00.000+07:00`).toISOString();
  const endOfDayIso = new Date(`${targetDate}T23:59:59.999+07:00`).toISOString();

  return {
    targetDate,
    startOfDayIso,
    endOfDayIso,
  };
}

export function isDateInWibTarget(dateValue, targetDate) {
  if (!dateValue) return false;
  try {
    const wibDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(dateValue));
    return wibDate === targetDate;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// 3. SCHEMA VALIDASI KONFIGURASI
// ============================================================================

export const dailyReportSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Format jam harus HH:mm (00:00 - 23:59)').default('19:00'),
  timeZone: z.literal('Asia/Jakarta').default('Asia/Jakarta'),
  includeGoodsIn: z.boolean().default(true),
  includeGoodsOut: z.boolean().default(true),
  includeReturns: z.boolean().default(true),
  reportType: z.enum(['goods_in', 'goods_out', 'both']).optional(),
  authorizedOwnerId: z.string().uuid('ID Owner / Workspace harus berupa UUID yang valid'),
  useCompanyEmail: z.boolean().default(true),
  customRecipients: z.union([
    z.string(),
    z.array(z.string()),
  ]).optional().default(''),
}).refine((data) => data.includeGoodsIn || data.includeGoodsOut || data.includeReturns, {
  message: 'Setidaknya salah satu jenis laporan (Goods In, Goods Out, atau Return) harus diaktifkan.',
});

// ============================================================================
// 4. SERVICE AGREGASI LAPORAN (READ-ONLY)
// ============================================================================

export async function buildDailyReportData({
  ownerId,
  dateStr = null,
  includeGoodsIn = true,
  includeGoodsOut = true,
  includeReturns = true,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) {
    throw new Error('Owner ID is required to build daily report data.');
  }

  const { targetDate, startOfDayIso, endOfDayIso } = getWibDayBoundaries(dateStr);

  // 1. Ambil Data Perusahaan & Pengaturan Tampilan Workspace dari workspace_settings
  const { data: compSettings } = await supabaseClient
    .from('workspace_settings')
    .select('key, value, updated_at')
    .eq('owner_id', ownerId)
    .in('key', ['company', 'app']);

  let companyName = 'DocuFlow Workspace';
  let companyEmail = null;
  let rawAccentColor = 'Indigo';

  let appData = null;
  let compData = null;
  let appUpdated = 0;
  let compUpdated = 0;

  for (const s of compSettings || []) {
    const updatedTime = s.updated_at ? new Date(s.updated_at).getTime() : 0;
    if (s.key === 'app') {
      appData = s.value;
      appUpdated = updatedTime;
    }
    if (s.key === 'company') {
      compData = s.value;
      compUpdated = updatedTime;
    }
  }

  const appComp = appData?.company || appData;
  const directComp = compData?.company || compData;

  const appEmail = appComp?.companyEmail || appComp?.email || null;
  const appName = appComp?.companyName || appComp?.name || null;

  const compEmail = directComp?.companyEmail || directComp?.email || null;
  const compName = directComp?.companyName || directComp?.name || null;

  if (appEmail && compEmail) {
    companyEmail = appUpdated >= compUpdated ? appEmail : compEmail;
    companyName = appUpdated >= compUpdated ? (appName || compName) : (compName || appName);
  } else if (appEmail) {
    companyEmail = appEmail;
    companyName = appName || compName || companyName;
  } else if (compEmail) {
    companyEmail = compEmail;
    companyName = compName || appName || companyName;
  } else {
    companyName = appName || compName || companyName;
  }

  if (appData?.appearance?.accentColor) {
    rawAccentColor = appData.appearance.accentColor;
  }

  // Resolusi warna aksen milik Owner spesifik ini (tenant-isolated)
  const palette = resolveOwnerAccentPalette(rawAccentColor);

  // 2. Ambil Master Data Gudang untuk pemetaan dan pemisahan data per gudang
  let whQuery = supabaseClient
    .from('warehouses')
    .select('id, name, code, is_default, status')
    .eq('owner_id', ownerId);

  if (typeof whQuery?.neq === 'function') {
    whQuery = whQuery.neq('status', 'archived');
  }
  if (typeof whQuery?.order === 'function') {
    whQuery = whQuery.order('is_default', { ascending: false });
  }

  const { data: rawWarehouses } = await whQuery;
  const activeWarehouses = (Array.isArray(rawWarehouses) && rawWarehouses.length > 0)
    ? rawWarehouses
    : [{ id: 'default', name: 'Gudang Utama', code: null, is_default: true, status: 'active' }];

  const whMap = new Map(activeWarehouses.map((w) => [w.id, w.code ? `${w.name} (${w.code})` : w.name]));

  // 3. Ambil Dokumen Transaksi (Goods In & Goods Out)
  const types = [];
  if (includeGoodsIn) types.push('goods_in');
  if (includeGoodsOut) types.push('goods_out');
  if (types.length === 0) types.push('goods_in', 'goods_out');

  const { data: rawDocs, error: docError } = await supabaseClient
    .from('documents')
    .select('id, document_type, document_number, contact_id, contact_name, status, issue_date, notes, metadata, warehouse_id, created_at, items:document_items(id, product_id, item_name, sku, quantity, metadata)')
    .eq('owner_id', ownerId)
    .in('document_type', types)
    .neq('status', 'cancelled')
    .or(`issue_date.eq.${targetDate},and(created_at.gte.${startOfDayIso},created_at.lte.${endOfDayIso})`);

  if (docError) throw docError;

  // Filter ketat zona waktu Asia/Jakarta dan hilangkan duplikasi ID
  const seenIds = new Set();
  const docs = (rawDocs || []).filter((d) => {
    if (seenIds.has(d.id)) return false;
    const isMatch = d.issue_date === targetDate || isDateInWibTarget(d.created_at, targetDate);
    if (isMatch) {
      seenIds.add(d.id);
      return true;
    }
    return false;
  });

  const processDocGroup = (docList) => {
    return docList.map((d) => {
      const items = Array.isArray(d.items) ? d.items : [];
      let totalPcs = 0;
      for (const item of items) {
        totalPcs += resolveItemBaseQty(item);
      }
      const unitSummary = formatItemUnitBreakdown(items);
      const whName = whMap.get(d.warehouse_id) || d.metadata?.warehouse || 'Gudang Utama';

      let timeFormatted = '—';
      try {
        timeFormatted = new Intl.DateTimeFormat('id-ID', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(d.created_at)).replace('.', ':');
      } catch (_) {}

      return {
        id: d.id,
        documentNumber: d.document_number,
        contactName: d.contact_name || '—',
        warehouseName: whName,
        time: timeFormatted,
        status: d.status,
        itemCount: items.length,
        totalPcs,
        unitSummary: unitSummary || `${totalPcs} pcs`,
        notes: d.notes || null,
        items,
      };
    });
  };

  const goodsInDocs = docs.filter((d) => d.document_type === 'goods_in');
  const goodsOutDocs = docs.filter((d) => d.document_type === 'goods_out');

  // Pisahkan strictly: completed (sah) vs pending (draft / processing)
  const goodsInCompleted = processDocGroup(goodsInDocs.filter((d) => d.status === 'completed'));
  const goodsInPending = processDocGroup(goodsInDocs.filter((d) => d.status !== 'completed' && d.status !== 'cancelled'));

  const goodsOutCompleted = processDocGroup(goodsOutDocs.filter((d) => d.status === 'completed'));
  const goodsOutPending = processDocGroup(goodsOutDocs.filter((d) => d.status !== 'completed' && d.status !== 'cancelled'));

  const totalGoodsInPcs = goodsInCompleted.reduce((acc, d) => acc + d.totalPcs, 0);
  const totalGoodsOutPcs = goodsOutCompleted.reduce((acc, d) => acc + d.totalPcs, 0);

  // 4. Ambil Dokumen yang Memiliki Catatan Retur (metadata->returns) pada targetDate
  let returnsList = [];
  if (includeReturns !== false) {
    try {
      let returnQuery = supabaseClient
        .from('documents')
        .select('id, document_type, document_number, contact_id, contact_name, warehouse_id, metadata, created_at, status, items:document_items(id, product_id, item_name, sku, quantity, metadata)')
        .eq('owner_id', ownerId);

      if (typeof returnQuery?.neq === 'function') {
        returnQuery = returnQuery.neq('status', 'cancelled');
      }
      if (typeof returnQuery?.not === 'function') {
        returnQuery = returnQuery.not('metadata->returns', 'is', null);
      }

    const { data: rawReturnDocs } = await returnQuery;

    // Set pelacak untuk mencegah retur yang sama dihitung berulang kali
    const seenReturnIds = new Set();

    for (const doc of rawReturnDocs || []) {
      if (doc?.status === 'cancelled') continue;
      const rets = Array.isArray(doc.metadata?.returns) ? doc.metadata.returns : [];
      for (const ret of rets) {
        if (!ret || typeof ret !== 'object') continue;
        if (ret.status === 'restored') continue;

        // Tanggal retur hanya menggunakan returnedAt atau date yang tercatat secara nyata
        // JANGAN fallback ke doc.created_at karena itu adalah tanggal transaksi asal, bukan tanggal retur!
        const retDate = ret.returnedAt || ret.date;
        if (!retDate) continue;

        const isMatch = (typeof retDate === 'string' && retDate.slice(0, 10) === targetDate) || isDateInWibTarget(retDate, targetDate);
        if (!isMatch) continue;

        // Cegah retur yang sama dihitung berulang kali
        const returnUniqueKey = ret.id || `${doc.id}_${ret.returnNumber || ''}_${retDate}`;
        if (seenReturnIds.has(returnUniqueKey)) continue;
        seenReturnIds.add(returnUniqueKey);

        let retTotalPcs = 0;
        const items = Array.isArray(ret.items) ? ret.items : [];
        for (const it of items) {
          retTotalPcs += resolveItemBaseQty(it);
        }

        let retTimeFormatted = '—';
        try {
          retTimeFormatted = new Intl.DateTimeFormat('id-ID', {
            timeZone: 'Asia/Jakarta',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(retDate)).replace('.', ':');
        } catch (_) {}

        returnsList.push({
          id: ret.id,
          returnNumber: ret.returnNumber || '—',
          documentNumber: doc.document_number,
          documentType: doc.document_type,
          contactName: doc.contact_name || '—',
          warehouseId: ret.warehouseId || ret.warehouse_id || doc.warehouse_id || null,
          warehouseName: whMap.get(ret.warehouseId || ret.warehouse_id || doc.warehouse_id) || doc.metadata?.warehouse || 'Gudang Utama',
          time: retTimeFormatted,
          status: ret.status || 'completed',
          condition: ret.condition || 'available',
          reason: ret.reason || '—',
          totalPcs: retTotalPcs,
          itemCount: items.length,
          notes: ret.notes || null,
          items,
          parentDoc: doc,
        });
      }
    }
    } catch (err) {
      console.warn('[dailyReport] Peringatan pengambilan data retur:', err?.message || err);
    }
  }

  const totalReturnPcs = returnsList.reduce((acc, r) => acc + r.totalPcs, 0);

  // Top 5 Produk per kuantitas dasar (Pcs)
  const aggregateTopProducts = (completedDocGroup) => {
    const prodMap = {};
    for (const d of completedDocGroup) {
      for (const it of d.items) {
        const key = it.sku || it.item_name || 'unknown';
        if (!prodMap[key]) {
          prodMap[key] = {
            sku: it.sku || '—',
            name: it.item_name || '—',
            totalPcs: 0,
          };
        }
        prodMap[key].totalPcs += resolveItemBaseQty(it);
      }
    }
    return Object.values(prodMap).sort((a, b) => b.totalPcs - a.totalPcs).slice(0, 5);
  };

  const topGoodsInProducts = aggregateTopProducts(goodsInCompleted);
  const topGoodsOutProducts = aggregateTopProducts(goodsOutCompleted);

  // Format tanggal Indonesia
  let dateFormattedIndo = targetDate;
  try {
    const [y, m, day] = targetDate.split('-').map(Number);
    const dObj = new Date(y, m - 1, day);
    dateFormattedIndo = dObj.toLocaleDateString('id-ID', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch (_) {}

  const generatedAtWib = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace('.', ':') + ' WIB';

  // Konstruksi laporan per gudang (data terisolasi secara aman per gudang)
  const warehouseReports = activeWarehouses.map((wh) => {
    const whDocs = docs.filter((d) => docBelongsToWarehouse(d, wh, activeWarehouses));
    const whGoodsInDocs = whDocs.filter((d) => d.document_type === 'goods_in');
    const whGoodsOutDocs = whDocs.filter((d) => d.document_type === 'goods_out');

    const whGoodsInCompleted = processDocGroup(whGoodsInDocs.filter((d) => d.status === 'completed'));
    const whGoodsInPending = processDocGroup(whGoodsInDocs.filter((d) => d.status !== 'completed' && d.status !== 'cancelled'));

    const whGoodsOutCompleted = processDocGroup(whGoodsOutDocs.filter((d) => d.status === 'completed'));
    const whGoodsOutPending = processDocGroup(whGoodsOutDocs.filter((d) => d.status !== 'completed' && d.status !== 'cancelled'));

    const whTotalGoodsInPcs = whGoodsInCompleted.reduce((acc, d) => acc + d.totalPcs, 0);
    const whTotalGoodsOutPcs = whGoodsOutCompleted.reduce((acc, d) => acc + d.totalPcs, 0);

    const whReturnsList = returnsList.filter((r) =>
      returnBelongsToWarehouse(r, r.parentDoc || { warehouse_id: r.warehouseId }, wh, activeWarehouses)
    );
    const whTotalReturnPcs = whReturnsList.reduce((acc, r) => acc + r.totalPcs, 0);

    const whTopGoodsInProducts = aggregateTopProducts(whGoodsInCompleted);
    const whTopGoodsOutProducts = aggregateTopProducts(whGoodsOutCompleted);

    return {
      warehouseId: wh.id,
      warehouseName: wh.name,
      warehouseCode: wh.code || null,
      isDefault: Boolean(wh.is_default),
      ownerId,
      companyName,
      companyEmail,
      accentColor: palette.name,
      palette,
      targetDate,
      dateFormattedIndo,
      generatedAtWib,
      includeGoodsIn,
      includeGoodsOut,
      includeReturns,
      goodsIn: {
        completedCount: whGoodsInCompleted.length,
        totalPcs: whTotalGoodsInPcs,
        completedDocs: whGoodsInCompleted,
        pendingCount: whGoodsInPending.length,
        pendingDocs: whGoodsInPending,
        topProducts: whTopGoodsInProducts,
      },
      goodsOut: {
        completedCount: whGoodsOutCompleted.length,
        totalPcs: whTotalGoodsOutPcs,
        completedDocs: whGoodsOutCompleted,
        pendingCount: whGoodsOutPending.length,
        pendingDocs: whGoodsOutPending,
        topProducts: whTopGoodsOutProducts,
      },
      returns: {
        completedCount: whReturnsList.length,
        totalPcs: whTotalReturnPcs,
        completedDocs: whReturnsList,
      },
    };
  });

  return {
    ownerId,
    companyName,
    companyEmail,
    accentColor: palette.name,
    palette,
    targetDate,
    dateFormattedIndo,
    generatedAtWib,
    includeGoodsIn,
    includeGoodsOut,
    includeReturns,
    goodsIn: {
      completedCount: goodsInCompleted.length,
      totalPcs: totalGoodsInPcs,
      completedDocs: goodsInCompleted,
      pendingCount: goodsInPending.length,
      pendingDocs: goodsInPending,
      topProducts: topGoodsInProducts,
    },
    goodsOut: {
      completedCount: goodsOutCompleted.length,
      totalPcs: totalGoodsOutPcs,
      completedDocs: goodsOutCompleted,
      pendingCount: goodsOutPending.length,
      pendingDocs: goodsOutPending,
      topProducts: topGoodsOutProducts,
    },
    returns: {
      completedCount: returnsList.length,
      totalPcs: totalReturnPcs,
      completedDocs: returnsList,
    },
    warehouses: activeWarehouses,
    warehouseReports,
  };
}

// ============================================================================
// 5. TEMPLATE EMAIL HTML (RINGKASAN EKSEKUTIF BERSIH & FORMAL DENGAN AKSEN OWNER)
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generateDailyReportHtml(report) {
  const {
    companyName = 'Perusahaan',
    dateFormattedIndo = report.targetDate || 'Hari Ini',
    includeGoodsIn = true,
    includeGoodsOut = true,
    includeReturns = true,
    goodsIn = { completedCount: 0, totalPcs: 0 },
    goodsOut = { completedCount: 0, totalPcs: 0 },
    returns = { completedCount: 0, totalPcs: 0 },
  } = report;

  const palette = report.palette || resolveOwnerAccentPalette(report.accentColor || 'indigo');

  const goodsInCount = goodsIn?.completedCount ?? 0;
  const goodsInQty = (goodsIn?.totalPcs ?? 0).toLocaleString('id-ID');

  const goodsOutCount = goodsOut?.completedCount ?? 0;
  const goodsOutQty = (goodsOut?.totalPcs ?? 0).toLocaleString('id-ID');

  const returnCount = returns?.completedCount ?? 0;
  const returnQty = (returns?.totalPcs ?? 0).toLocaleString('id-ID');

  const warehouseReports = report.warehouseReports;
  const isMultiWarehouse = Array.isArray(warehouseReports) && warehouseReports.length > 1;

  let summaryListHtml = '';
  if (isMultiWarehouse) {
    summaryListHtml = `
              <ul style="margin: 0 0 20px 0; padding-left: 20px; line-height: 1.8;">
                ${warehouseReports.map((wh) => {
                  const inC = wh.goodsIn?.completedCount ?? 0;
                  const inQ = (wh.goodsIn?.totalPcs ?? 0).toLocaleString('id-ID');
                  const outC = wh.goodsOut?.completedCount ?? 0;
                  const outQ = (wh.goodsOut?.totalPcs ?? 0).toLocaleString('id-ID');
                  const retC = wh.returns?.completedCount ?? 0;
                  const retQ = (wh.returns?.totalPcs ?? 0).toLocaleString('id-ID');

                  const parts = [];
                  if (includeGoodsIn) parts.push(`<strong>Goods In:</strong> ${inC} dokumen selesai, total ${inQ} pcs`);
                  if (includeGoodsOut) parts.push(`<strong>Goods Out:</strong> ${outC} dokumen selesai, total ${outQ} pcs`);
                  if (includeReturns) parts.push(`<strong>Return:</strong> ${retC} transaksi, total ${retQ} pcs`);

                  return `<li style="margin-bottom: 8px;"><strong>${escapeHtml(wh.warehouseName)}</strong> &mdash; ${parts.join('; ')}.</li>`;
                }).join('')}
              </ul>
              <p style="margin: 0 0 24px 0; color: #4B5563;">Laporan lengkap setiap gudang tersedia pada lampiran PDF dan Excel.</p>`;
  } else {
    summaryListHtml = `
              <ul style="margin: 0 0 20px 0; padding-left: 20px; line-height: 1.8;">
                ${includeGoodsIn ? `<li><strong>Goods In:</strong> ${goodsInCount} dokumen selesai, total ${goodsInQty} pcs.</li>` : ''}
                ${includeGoodsOut ? `<li><strong>Goods Out:</strong> ${goodsOutCount} dokumen selesai, total ${goodsOutQty} pcs.</li>` : ''}
                ${includeReturns ? `<li><strong>Return:</strong> ${returnCount} transaksi, total ${returnQty} pcs.</li>` : ''}
              </ul>
              <p style="margin: 0 0 24px 0; color: #4B5563;">Laporan lengkap tersedia pada lampiran PDF dan Excel.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Laporan Harian Gudang &mdash; ${escapeHtml(companyName)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1F2937;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #FFFFFF; padding: 24px 16px;">
    <tr>
      <td align="left">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0; text-align: left;">
          <!-- Garis aksen tipis milik Owner -->
          <tr>
            <td height="3" style="background-color: ${palette.primary}; line-height: 3px; font-size: 1px;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 24px 0 0 0; font-size: 15px; line-height: 1.6; color: #1F2937;">
              <h2 style="margin: 0 0 20px 0; font-size: 18px; font-weight: 600; color: #111827; border-left: 3px solid ${palette.primary}; padding-left: 10px;">
                Laporan Harian Gudang &mdash; ${escapeHtml(companyName)}
              </h2>

              <p style="margin: 0 0 16px 0;">Halo,</p>

              <p style="margin: 0 0 16px 0;">Berikut ringkasan aktivitas gudang untuk <strong>${escapeHtml(dateFormattedIndo)}</strong>:</p>

              ${summaryListHtml}

              <p style="margin: 0; color: #374151; line-height: 1.5;">
                Terima kasih,<br>
                <strong>${escapeHtml(companyName)}</strong><br>
                <span style="color: #6B7280; font-size: 13px;">DocuFlow</span>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ============================================================================
// 6. SCHEDULER & EVALUASI WAKTU (STATELESS / SERVERLESS)
// ============================================================================

export async function evaluateDailyReportDue({
  currentTimeWib = null,
  force = false,
  supabaseClient = supabaseAdmin,
}) {
  // 1. Ambil setting daily report dari Super Admin
  const { data: dbSetting, error: settingErr } = await supabaseClient
    .from('workspace_settings')
    .select('value')
    .eq('owner_id', SUPER_ADMIN_TENANT_ID)
    .eq('key', 'daily_report_settings')
    .maybeSingle();

  if (settingErr) throw settingErr;
  const settings = dbSetting?.value || null;

  if (!settings || settings.enabled !== true) {
    return {
      isDue: false,
      reason: 'daily_report_disabled',
      settings,
    };
  }

  const authorizedOwnerId = settings.authorizedOwnerId;
  if (!authorizedOwnerId) {
    return {
      isDue: false,
      reason: 'no_authorized_owner_configured',
      settings,
    };
  }

  // 2. Evaluasi Waktu (WIB)
  const currentWibTime = currentTimeWib || new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()).replace('.', ':');

  const scheduleTime = settings.scheduleTime || '19:00';
  const targetDateWib = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

  // 3. Cek Idempotensi Hari Ini (Apakah sudah terkirim)
  const { startOfDayIso, endOfDayIso } = getWibDayBoundaries(targetDateWib);
  let query = supabaseClient
    .from('email_logs')
    .select('id, sent_at, created_at, subject')
    .ilike('subject', `%${targetDateWib}%`)
    .eq('status', 'sent')
    .gte('created_at', startOfDayIso)
    .lte('created_at', endOfDayIso);

  if (typeof query?.not === 'function') {
    query = query.not('subject', 'ilike', '%[TEST PREVIEW]%');
  }

  const { data: rawLogs } = await query.limit(5);
  const existingLogs = (rawLogs || []).filter((log) => !log.subject || !log.subject.includes('[TEST PREVIEW]'));

  const alreadySent = existingLogs && existingLogs.length > 0;

  if (alreadySent && !force) {
    return {
      isDue: false,
      reason: 'already_sent_today',
      existingLog: existingLogs[0],
      targetDate: targetDateWib,
      settings,
    };
  }

  // Jika force=true, abaikan kecocokan jam
  if (force) {
    return {
      isDue: true,
      reason: 'forced_run',
      targetDate: targetDateWib,
      settings,
    };
  }

  // Cek apakah jam saat ini sudah mencapai atau melewati jadwal yang ditentukan
  const [curH, curM] = currentWibTime.split(':').map(Number);
  const curMinutes = (curH || 0) * 60 + (curM || 0);
  const [schH, schM] = scheduleTime.split(':').map(Number);
  const schMinutes = (schH || 0) * 60 + (schM || 0);

  // Toleransi eksekusi: saat cron memanggil di jam jadwal atau setelahnya di hari yang sama
  const isTimeReached = curMinutes >= schMinutes;

  return {
    isDue: isTimeReached,
    reason: isTimeReached ? 'time_reached' : 'scheduled_time_not_yet_reached',
    targetDate: targetDateWib,
    currentTimeWib: currentWibTime,
    scheduleTime,
    settings,
  };
}

// ============================================================================
// 7. PENGIRIMAN EMAIL & AUDIT LOG (EMAIL_LOGS)
// ============================================================================

// ============================================================================
// 10. ATOMIC CLAIM & LEASE CONCURRENCY DAILY REPORT (PHASE 2A)
// ============================================================================

export const PENDING_DAILY_REPORT_LEASE_MS = 5 * 60 * 1000; // 5 menit

/**
 * Klaim atomik baris email_logs untuk Daily Report per-owner.
 * Menjamin:
 * 1. Tidak ada pengiriman duplikat untuk (owner_id, report_date) yang sudah sent.
 * 2. Tidak ada dua worker yang memproses (owner_id, report_date) secara bersamaan (lease pending).
 * 3. Baris pending kedaluwarsa (> 5 menit) ditandai 'uncertain' dan TIDAK di-retry buta.
 * 4. Baris failed dapat diklaim ulang secara atomik melalui conditional update.
 */
export async function claimDailyReportLease({
  ownerId,
  targetDate,
  triggerSource = 'cron',
  force = false,
  isTest = false,
  dryRun = false,
  baseLog = {},
  supabaseClient = supabaseAdmin,
}) {
  if (isTest || dryRun) {
    return { claimed: true, logId: null };
  }

  const nowIso = new Date().toISOString();

  // 1. Kueri terstruktur: Cek apakah sudah ada log untuk (owner_id, report_date, email_type='daily_report')
  try {
    let structuredQuery = supabaseClient
      .from('email_logs')
      .select('id, status, last_attempt_at, created_at, sent_at, trigger_source, subject')
      .eq('owner_id', ownerId)
      .eq('report_date', targetDate)
      .eq('email_type', 'daily_report');

    if (typeof structuredQuery?.neq === 'function') {
      structuredQuery = structuredQuery.neq('trigger_source', 'test');
    }

    const { data: structuredList, error: structErr } = await structuredQuery.limit(5);

    if (structErr) {
      if (structErr.code === '42703' || /column .* does not exist/i.test(structErr.message || '')) {
        throw new Error(
          `Gagal klaim Daily Report: Skema database belum dimigrasi (kolom owner_id/report_date pada email_logs belum tersedia). Jalankan migration 023_daily_report_email_logs_idempotency.sql.`
        );
      }
      throw structErr;
    }

    let existing = null;
    if (Array.isArray(structuredList) && structuredList.length > 0) {
      existing = structuredList.find((l) => l.trigger_source !== 'test') || structuredList[0];
    }

    if (existing) {
      // Skenario A: Sudah pernah berhasil terkirim
      if (existing.status === 'sent' && !force) {
        return {
          claimed: false,
          reason: 'already_sent',
          message: `Laporan harian untuk tanggal ${targetDate} sudah pernah berhasil dikirim pada ${existing.sent_at || existing.created_at}. Gunakan force=true jika ingin mengirim ulang.`,
          existing,
        };
      }

      // Skenario B: Sedang dalam proses (status pending)
      if (existing.status === 'pending') {
        const attemptTime = existing.last_attempt_at
          ? new Date(existing.last_attempt_at).getTime()
          : new Date(existing.created_at).getTime();
        const elapsedMs = Date.now() - attemptTime;

        if (elapsedMs < PENDING_DAILY_REPORT_LEASE_MS && !force) {
          return {
            claimed: false,
            reason: 'in_progress',
            message: `Pengiriman laporan harian untuk tanggal ${targetDate} sedang berlangsung oleh proses lain.`,
            existing,
          };
        }

        // Skenario C: Lease kedaluwarsa (> 5 menit) -> tandai 'uncertain' demi keamanan pengiriman (at-most-once)
        if (!force) {
          try {
            await supabaseClient
              .from('email_logs')
              .update({
                status: 'uncertain',
                error_message: 'Proses pengiriman sebelumnya menggantung atau melebihi lease 5 menit. Ditandai uncertain untuk mencegah pengiriman ganda.',
              })
              .eq('id', existing.id)
              .eq('status', 'pending');
          } catch (_) {}

          return {
            claimed: false,
            reason: 'lease_expired_uncertain',
            message: `Pengiriman laporan harian sebelumnya menggantung dan telah ditandai 'uncertain'. Hubungi Super Admin atau gunakan force=true untuk pengiriman ulang aman.`,
            existing,
          };
        }
      }

      // Skenario D: Status 'failed' (atau force=true) -> klaim atomik ulang dengan update conditional
      if (existing.status === 'failed' || force) {
        const { data: updated, error: updateErr } = await supabaseClient
          .from('email_logs')
          .update({
            status: 'pending',
            last_attempt_at: nowIso,
            error_message: null,
          })
          .eq('id', existing.id)
          .eq('status', existing.status)
          .select('id')
          .maybeSingle();

        if (!updateErr && updated?.id) {
          return { claimed: true, logId: updated.id };
        }

        return {
          claimed: false,
          reason: 'claim_lost',
          message: `Klaim pengiriman laporan harian untuk tanggal ${targetDate} diambil oleh worker lain.`,
        };
      }
    }
  } catch (_) {}

  // 2. Belum ada log sama sekali: coba atomic INSERT dengan last_attempt_at
  try {
    const payload = {
      ...baseLog,
      status: 'pending',
      last_attempt_at: nowIso,
    };

    const { data: inserted, error: insertErr } = await supabaseClient
      .from('email_logs')
      .insert(payload)
      .select('id')
      .maybeSingle();

    if (!insertErr && inserted?.id) {
      return { claimed: true, logId: inserted.id };
    }

    // Jika terjadi error 23505 (unique constraint violation), berarti worker lain baru saja menginsert!
    if (insertErr && (insertErr.code === '23505' || /unique/i.test(insertErr.message || ''))) {
      return {
        claimed: false,
        reason: 'concurrency_collision',
        message: `Pengiriman laporan harian untuk tanggal ${targetDate} sedang diproses oleh proses lain (unique claim locked).`,
      };
    }

    // Jika database belum memiliki kolom baru (42703 / column does not exist), hentikan dengan error jelas
    if (insertErr && (insertErr.code === '42703' || /column .* does not exist/i.test(insertErr.message || ''))) {
      throw new Error(
        `Gagal klaim Daily Report: Skema database belum dimigrasi (kolom baru pada email_logs belum tersedia). Jalankan migration 023_daily_report_email_logs_idempotency.sql.`
      );
    }
  } catch (_) {}

  return { claimed: true, logId: null };
}

export async function sendDailyReportEmail({
  ownerId,
  dateStr = null,
  recipients = null,
  useCompanyEmail = true,
  includeGoodsIn = true,
  includeGoodsOut = true,
  includeReturns = true,
  isTest = false,
  force = false,
  dryRun = false,
  triggerSource = 'cron',
  supabaseClient = supabaseAdmin,
}) {
  const report = await buildDailyReportData({
    ownerId,
    dateStr,
    includeGoodsIn,
    includeGoodsOut,
    includeReturns,
    supabaseClient,
  });

  const fromAddress = getSmtpFromAddress();

  // 1. Tentukan Penerima (Strict Tenant Scoping, Sesuai Pengaturan Email Perusahaan & Prioritas)
  let primaryRecipient = null;
  let ccRecipients = [];

  const rawRecipientsList = (Array.isArray(recipients) ? recipients : String(recipients || '').split(','))
    .map((e) => String(e).trim())
    .filter(isValidEmail);

  if (isTest) {
    // Mode uji coba: langsung kirim ke alamat email uji coba
    primaryRecipient = rawRecipientsList[0] || null;
    ccRecipients = rawRecipientsList.slice(1);
  } else {
    const hasCompanyEmail = Boolean(report.companyEmail && isValidEmail(report.companyEmail));

    if (useCompanyEmail && hasCompanyEmail) {
      // 1. Jika Email Perusahaan dicentang, kirim ke Email Perusahaan sebagai To
      primaryRecipient = report.companyEmail;
      // 2. Email tambahan / kustom menjadi CC
      ccRecipients = rawRecipientsList.filter((e) => e.toLowerCase() !== report.companyEmail.toLowerCase());
    } else if (rawRecipientsList.length > 0) {
      // 3. Jika Email Perusahaan tidak dicentang (atau kosong), alamat kustom pertama menjadi To
      primaryRecipient = rawRecipientsList[0];
      ccRecipients = rawRecipientsList.slice(1);
    } else if (hasCompanyEmail) {
      primaryRecipient = report.companyEmail;
    }
  }

  const subjectPrefix = isTest ? '[TEST PREVIEW] ' : '';
  const subject = `${subjectPrefix}Laporan Harian Gudang — ${report.companyName} — ${report.targetDate}`;

  const idempotencyKey = `daily_report:${ownerId}:${report.targetDate}`;
  const baseLog = {
    purchase_order_id: null,
    document_id: null,
    email_type: 'daily_report',
    owner_id: ownerId,
    report_date: report.targetDate,
    trigger_source: isTest ? 'test' : (triggerSource || 'cron'),
    idempotency_key: idempotencyKey,
    sender_email: fromAddress,
    recipient_email: primaryRecipient || 'no-recipient@docuflow.app',
    cc_email: ccRecipients.length > 0 ? ccRecipients.join(', ') : null,
    subject,
    status: 'pending',
  };

  if (!primaryRecipient || !isValidEmail(primaryRecipient)) {
    const errorMessage = 'Alamat email penerima laporan harian tidak ditemukan untuk tenant ini. Pastikan email perusahaan terisi di Pengaturan Workspace atau atur Email Penerima Tambahan.';
    if (!dryRun) {
      try {
        await supabaseClient.from('email_logs').insert({
          ...baseLog,
          status: 'failed',
          error_message: errorMessage,
        });
      } catch (_) {}
    }
    return { status: 'failed', error: errorMessage, subject, primaryRecipient, report };
  }

  const targetWarehouseReports = (Array.isArray(report.warehouseReports) && report.warehouseReports.length > 0)
    ? report.warehouseReports
    : [{ ...report, warehouseName: report.warehouseName || 'Gudang Utama' }];

  // 2. Mode DRY RUN (Pengujian aman tanpa menyentuh SMTP maupun menulis ke database)
  if (dryRun) {
    const attachments = [];
    try {
      for (const whReport of targetWarehouseReports) {
        const whPdfBuffer = generateDailyReportPdf(whReport);
        const whExcelBuffer = generateDailyReportExcel(whReport);
        if (!Buffer.isBuffer(whPdfBuffer) || whPdfBuffer.length === 0) {
          throw new Error(`Pembuatan lampiran PDF gagal untuk gudang "${whReport.warehouseName}".`);
        }
        if (!Buffer.isBuffer(whExcelBuffer) || whExcelBuffer.length === 0) {
          throw new Error(`Pembuatan lampiran Excel (.xlsx) gagal untuk gudang "${whReport.warehouseName}".`);
        }
        attachments.push({
          filename: sanitizeWarehouseFileName(whReport.warehouseName, report.targetDate, '.pdf'),
          content: whPdfBuffer,
          contentType: 'application/pdf',
        });
        attachments.push({
          filename: sanitizeWarehouseFileName(whReport.warehouseName, report.targetDate, '.xlsx'),
          content: whExcelBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
    } catch (attachErr) {
      return {
        status: 'failed',
        error: `Simulasi gagal karena pembuatan lampiran: ${attachErr.message}`,
        subject,
        primaryRecipient,
        report,
      };
    }
    return {
      status: 'simulated',
      dryRun: true,
      subject,
      primaryRecipient,
      ccRecipients,
      targetDate: report.targetDate,
      report,
      attachments,
      pdfBuffer: attachments[0]?.content,
      excelBuffer: attachments[1]?.content,
    };
  }

  // 3. Proteksi Idempotensi & Atomic Claim Lease SEBELUM Attachment & SMTP
  let claimResult = { claimed: true, logId: null };
  if (!isTest) {
    claimResult = await claimDailyReportLease({
      ownerId,
      targetDate: report.targetDate,
      triggerSource: triggerSource || 'cron',
      force,
      isTest,
      dryRun,
      baseLog,
      supabaseClient,
    });

    if (!claimResult.claimed) {
      return {
        status: 'skipped',
        message: claimResult.message,
        reason: claimResult.reason,
        subject,
        primaryRecipient,
        report,
        existing: claimResult.existing,
      };
    }
  }

  let insertedLogId = claimResult.logId;

  // 4. Verifikasi Transporter SMTP
  const transporter = getTransporter();
  if (!transporter) {
    const errorMessage = 'Layanan SMTP belum dikonfigurasi di environment ini (SMTP_HOST/SMTP_USER/SMTP_PASS belum disetel). Gunakan fitur Kirim Simulasi (Dry Run) untuk menguji kalkulasi dan format laporan tanpa SMTP.';
    if (insertedLogId) {
      try {
        await supabaseClient.from('email_logs').update({
          status: 'failed',
          error_message: errorMessage,
        }).eq('id', insertedLogId);
      } catch (_) {}
    } else {
      try {
        await supabaseClient.from('email_logs').insert({
          ...baseLog,
          status: 'failed',
          error_message: errorMessage,
        });
      } catch (_) {}
    }
    return { status: 'failed', error: errorMessage, subject, primaryRecipient, report };
  }

  // 5. Pembuatan Lampiran Wajib (Atomic Attachment: Batalkan pengiriman jika PDF atau Excel salah satu gudang gagal dibuat)
  const attachments = [];
  try {
    for (const whReport of targetWarehouseReports) {
      const whPdfBuffer = generateDailyReportPdf(whReport);
      const whExcelBuffer = generateDailyReportExcel(whReport);
      if (!Buffer.isBuffer(whPdfBuffer) || whPdfBuffer.length === 0) {
        throw new Error(`Berkas PDF kosong atau gagal dibuat untuk gudang "${whReport.warehouseName}".`);
      }
      if (!Buffer.isBuffer(whExcelBuffer) || whExcelBuffer.length === 0) {
        throw new Error(`Berkas Excel (.xlsx) kosong atau gagal dibuat untuk gudang "${whReport.warehouseName}".`);
      }
      attachments.push({
        filename: sanitizeWarehouseFileName(whReport.warehouseName, report.targetDate, '.pdf'),
        content: whPdfBuffer,
        contentType: 'application/pdf',
      });
      attachments.push({
        filename: sanitizeWarehouseFileName(whReport.warehouseName, report.targetDate, '.xlsx'),
        content: whExcelBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }
  } catch (attachErr) {
    const errorMessage = `Pengiriman dibatalkan demi integritas laporan: Gagal membuat lampiran (${attachErr.message}). Email tidak dikirim sebagian.`;
    if (insertedLogId) {
      try {
        await supabaseClient.from('email_logs').update({
          status: 'failed',
          error_message: errorMessage,
        }).eq('id', insertedLogId);
      } catch (_) {}
    } else {
      try {
        await supabaseClient.from('email_logs').insert({
          ...baseLog,
          status: 'failed',
          error_message: errorMessage,
        });
      } catch (_) {}
    }
    return { status: 'failed', error: errorMessage, subject, primaryRecipient, report };
  }

  const htmlContent = generateDailyReportHtml(report);
  const plainText = [
    `LAPORAN HARIAN OPERASIONAL GUDANG - ${report.companyName.toUpperCase()}`,
    `Tanggal: ${report.dateFormattedIndo} (Cut-off: ${report.generatedAtWib})`,
    `Warna Aksen Laporan: ${report.accentColor || 'Indigo'}`,
    '',
    '=== RINGKASAN AKTIVITAS PER GUDANG ===',
    ...targetWarehouseReports.map((wh) => {
      const parts = [];
      if (includeGoodsIn) parts.push(`Goods In: ${wh.goodsIn?.completedCount ?? 0} dokumen selesai, total ${(wh.goodsIn?.totalPcs ?? 0).toLocaleString('id-ID')} pcs`);
      if (includeGoodsOut) parts.push(`Goods Out: ${wh.goodsOut?.completedCount ?? 0} dokumen selesai, total ${(wh.goodsOut?.totalPcs ?? 0).toLocaleString('id-ID')} pcs`);
      if (includeReturns) parts.push(`Return: ${wh.returns?.completedCount ?? 0} transaksi, total ${(wh.returns?.totalPcs ?? 0).toLocaleString('id-ID')} pcs`);
      return `• ${wh.warehouseName}: ${parts.join('; ')}`;
    }),
    '',
    'Lampiran resmi format PDF dan spreadsheet Excel (.xlsx) untuk masing-masing gudang telah disertakan pada email ini.',
    'Laporan ini dibuat otomatis oleh DocuFlow.',
  ].filter(Boolean).join('\n');

  try {
    const info = await sendMailWithRetry({
      from: fromAddress,
      to: primaryRecipient,
      cc: ccRecipients.length > 0 ? ccRecipients : undefined,
      subject,
      text: plainText,
      html: htmlContent,
      attachments,
    });

    if (insertedLogId) {
      try {
        await supabaseClient.from('email_logs').update({
          status: 'sent',
          sent_at: new Date().toISOString(),
        }).eq('id', insertedLogId);
      } catch (_) {}
    } else {
      try {
        await supabaseClient.from('email_logs').insert({
          ...baseLog,
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
      } catch (_) {}
    }

    return {
      status: 'sent',
      messageId: info.messageId,
      subject,
      primaryRecipient,
      ccRecipients,
      targetDate: report.targetDate,
      report,
      attachments,
      pdfBuffer: attachments[0]?.content,
      excelBuffer: attachments[1]?.content,
    };
  } catch (err) {
    const errorMessage = err?.message ?? String(err);
    if (insertedLogId) {
      try {
        await supabaseClient.from('email_logs').update({
          status: 'failed',
          error_message: errorMessage,
        }).eq('id', insertedLogId);
      } catch (_) {}
    } else {
      try {
        await supabaseClient.from('email_logs').insert({
          ...baseLog,
          status: 'failed',
          error_message: errorMessage,
        });
      } catch (_) {}
    }
    return { status: 'failed', error: errorMessage, subject, primaryRecipient, report };
  }
}

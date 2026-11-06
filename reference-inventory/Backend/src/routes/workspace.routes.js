import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { httpError } from '../utils/httpError.js';
import { writeActivityLog } from '../utils/activityLog.js';
import { loadTenant } from '../middleware/loadTenant.js';
import {
  sendGoodsOutEmail,
  sendGoodsInEmail,
  sendReturnEmail,
  resolveFinanceEmail,
  isValidEmail,
} from '../services/email.service.js';
import {
  buildDailyReportData,
  generateDailyReportHtml,
  sendDailyReportEmail,
  dailyReportSettingsSchema,
} from '../services/dailyReport.service.js';
import {
  createSerialGroup,
  ungroupSerial,
  getSerialCompositionHierarchy,
  previewSerialGroup,
  getSerialGroupingDetails,
  listSerialGroupings,
  getAvailableSerialsForGrouping,
  verifyScanSerialForGrouping,
  processMultiSerialGroups,
  generateGroupSerialNumber,
  createGroupingSession,
  confirmGroupingSession,
  cancelGroupingSession,
  listGroupingSessions,
  getGroupingSessionDetails,
} from '../services/serialGroup.service.js';
import { generateDocumentPdf } from '../services/pdf.service.js';

const router = Router();
const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function isMissingEmailLogColumn(error) {
  const message = error?.message || '';
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the .*column/i.test(message)
  );
}

/**
 * Ambil log email dokumen terakhir, mengecualikan notifikasi retur.
 * Fallback otomatis jika migration 020 belum dijalankan agar endpoint lama
 * tetap berfungsi saat backend di-deploy lebih dulu.
 */
async function fetchLatestDocumentEmailLog(documentId, columns) {
  const buildQuery = (withTypeFilter) => {
    let query = supabaseAdmin
      .from('email_logs')
      .select(columns)
      .eq('document_id', documentId);
    if (withTypeFilter) {
      query = query.or('email_type.is.null,email_type.eq.document');
    }
    return query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  };

  const result = await buildQuery(true);
  if (result.error && isMissingEmailLogColumn(result.error)) {
    return buildQuery(false);
  }
  return result;
}

// ---------------------------------------------------------------------------
// In-memory serial lookup cache — eliminates 2-3s Supabase round-trip on
// repeated scans of the same serial within a session.
//   key  : `${ownerId}:${warehouseId ?? 'all'}:${serial.toLowerCase()}`
//   value: { data, product, cachedAt }
// TTL: 30s for found serials, 5s for not-found (to pick up newly received items)
// ---------------------------------------------------------------------------
const SERIAL_CACHE = new Map();
const SERIAL_CACHE_TTL_HIT  = 60_000; // 60 seconds
const SERIAL_CACHE_TTL_MISS = 10_000; // 10 seconds

// In-memory cache for full warehouse serial index (0ms response time)
const WAREHOUSE_SERIAL_INDEX_CACHE = new Map();
const WAREHOUSE_SERIAL_INDEX_TTL_MS = 60_000; // 60 seconds

export function invalidateWarehouseSerialIndex(ownerId) {
  if (!ownerId) {
    WAREHOUSE_SERIAL_INDEX_CACHE.clear();
    SERIAL_CACHE.clear();
    return;
  }
  for (const key of WAREHOUSE_SERIAL_INDEX_CACHE.keys()) {
    if (key.startsWith(`${ownerId}:`)) {
      WAREHOUSE_SERIAL_INDEX_CACHE.delete(key);
    }
  }
  for (const key of SERIAL_CACHE.keys()) {
    if (key.startsWith(`${ownerId}:`)) {
      SERIAL_CACHE.delete(key);
    }
  }
}

function serialCacheKey(ownerId, warehouseId, serial) {
  return `${ownerId}:${warehouseId ?? 'all'}:${String(serial).toLowerCase()}`;
}

// Case variants for exact-match serial lookups. Using .in() with these hits the
// (owner_id, serial_number) B-tree index, whereas ILIKE forces a full table scan.
function serialVariants(serial) {
  const s = String(serial).trim();
  return Array.from(new Set([s, s.toUpperCase(), s.toLowerCase()]));
}

function serialCacheGet(key) {
  const entry = SERIAL_CACHE.get(key);
  if (!entry) return undefined;
  const ttl = entry.miss ? SERIAL_CACHE_TTL_MISS : SERIAL_CACHE_TTL_HIT;
  if (Date.now() - entry.cachedAt > ttl) {
    SERIAL_CACHE.delete(key);
    return undefined;
  }
  return entry;
}

function serialCacheSet(key, data, product, miss = false) {
  SERIAL_CACHE.set(key, { data, product, miss, cachedAt: Date.now() });
  // Prune stale entries if cache grows large (> 10000 unique serials)
  if (SERIAL_CACHE.size > 10000) {
    const now = Date.now();
    for (const [k, v] of SERIAL_CACHE) {
      const ttl = v.miss ? SERIAL_CACHE_TTL_MISS : SERIAL_CACHE_TTL_HIT;
      if (now - v.cachedAt > ttl) SERIAL_CACHE.delete(k);
    }
  }
}



export const DEFAULT_CUSTOM_UNITS = [
  { key: 'pcs', name: 'Pcs', baseType: 'pcs', baseValue: 1, multiplier: 1, isLocked: true, description: '1 Pcs' },
  { key: 'lusin', name: 'Lusin', baseType: 'pcs', baseValue: 12, multiplier: 12, isLocked: true, description: '12 Pcs' },
  { key: 'pack', name: 'Pack', baseType: 'lusin', baseValue: 5, multiplier: 60, isLocked: false, description: '5 Lusin (60 Pcs)' },
  { key: 'bal10', name: 'Bal 10', baseType: 'lusin', baseValue: 10, multiplier: 120, isLocked: false, description: '10 Lusin (120 Pcs)' },
  { key: 'bal15', name: 'Bal 15', baseType: 'lusin', baseValue: 15, multiplier: 180, isLocked: false, description: '15 Lusin (180 Pcs)' },
  { key: 'bal20', name: 'Bal 20', baseType: 'lusin', baseValue: 20, multiplier: 240, isLocked: false, description: '20 Lusin (240 Pcs)' },
  { key: 'bal25', name: 'Bal 25', baseType: 'lusin', baseValue: 25, multiplier: 300, isLocked: false, description: '25 Lusin (300 Pcs)' },
];

export const ONLINE_CUSTOM_UNITS = [
  { key: 'pcs', name: 'Pcs', baseType: 'pcs', baseValue: 1, multiplier: 1, isLocked: true, description: '1 Pcs' },
  { key: 'pack3', name: 'Pack 3', baseType: 'pcs', baseValue: 3, multiplier: 3, isLocked: false, description: '3 Pcs' },
  { key: 'pack6', name: 'Pack 6', baseType: 'pcs', baseValue: 6, multiplier: 6, isLocked: false, description: '6 Pcs' },
  { key: 'lusin', name: 'Lusin', baseType: 'pcs', baseValue: 12, multiplier: 12, isLocked: true, description: '12 Pcs' },
];

export async function getWorkspaceUnits(ownerId, warehouseId = null) {
  const fallbackMultipliers = {
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

  let units = [...DEFAULT_CUSTOM_UNITS];

  if (ownerId) {
    try {
      // Cek apakah warehouseId adalah gudang online
      if (warehouseId) {
        const { data: wh } = await supabaseAdmin
          .from('warehouses')
          .select('code, name')
          .eq('id', warehouseId)
          .maybeSingle();
        if (wh && (wh.code?.toUpperCase() === 'ONLINE' || wh.name?.toLowerCase().includes('online'))) {
          units = [...ONLINE_CUSTOM_UNITS];
        }
      }

      const keysToFetch = ['custom_units'];
      if (warehouseId) {
        keysToFetch.push(`custom_units_${warehouseId}`);
      }

      const { data: dbSettings } = await supabaseAdmin
        .from('workspace_settings')
        .select('key, value')
        .eq('owner_id', ownerId)
        .in('key', keysToFetch);

      if (dbSettings && dbSettings.length > 0) {
        const whSetting = warehouseId ? dbSettings.find((s) => s.key === `custom_units_${warehouseId}`) : null;
        const mainSetting = dbSettings.find((s) => s.key === 'custom_units');
        const rawUnits = whSetting?.value || mainSetting?.value;
        if (Array.isArray(rawUnits) && rawUnits.length > 0) {
          units = rawUnits;
        }
      }
    } catch (err) {
      console.error('[getWorkspaceUnits] Error fetching custom_units from DB:', err?.message || err);
    }
  }

  // Build dynamic multiplier map
  const multipliers = { ...fallbackMultipliers };
  for (const u of units) {
    if (u.key) {
      const k = String(u.key).toLowerCase().trim();
      const mult = Number(u.multiplier || (u.baseType === 'lusin' ? u.baseValue * 12 : u.baseValue) || 1);
      multipliers[k] = mult;
    }
  }

  const isLusinUnit = (unitKey) => {
    if (!unitKey) return false;
    const clean = String(unitKey).toLowerCase().trim();
    const found = units.find((u) => u.key && String(u.key).toLowerCase().trim() === clean);
    if (found) {
      return found.baseType === 'lusin';
    }
    if (clean === 'pcs' || clean === 'piece' || clean.includes('pack3') || clean.includes('pack6')) {
      return false;
    }
    if (['lusin', 'dozen', 'pack', 'bal', 'bal5', 'bal10', 'bal15', 'bal20', 'bal25'].includes(clean)) {
      return true;
    }
    if (clean.includes('lusin') || clean.includes('doz') || clean.includes('bal')) return true;
    return false;
  };

  const parseUnitFromSn = (sn) => {
    if (!sn) return 'pcs';
    const clean = String(sn).toLowerCase().trim();
    const allowedKeys = new Set((units || []).map((u) => String(u.key).toLowerCase().trim()));

    // 1. Cek dari daftar units aktif gudang
    const sortedUnits = [...units].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
    for (const u of sortedUnits) {
      const k = String(u.key).toLowerCase().trim();
      if (!k || k === 'pcs') continue;
      if (clean.includes(k)) return k;
    }

    // 2. Deteksi berdasarkan pola nomor seri lengkap (bl10/bl15/bl20/bl25)
    let resUnit = 'pcs';
    if (clean.includes('bl25') || clean.includes('25bl') || clean.includes('bal25') || clean.includes('25bal')) resUnit = 'bal25';
    else if (clean.includes('bl20') || clean.includes('20bl') || clean.includes('bal20') || clean.includes('20bal')) resUnit = 'bal20';
    else if (clean.includes('bl15') || clean.includes('15bl') || clean.includes('bal15') || clean.includes('15bal')) resUnit = 'bal15';
    else if (clean.includes('bl10') || clean.includes('10bl') || clean.includes('bal10') || clean.includes('10bal')) resUnit = 'bal10';
    else if (clean.includes('bl5') || clean.includes('5bl') || clean.includes('bal5') || clean.includes('5bal')) resUnit = 'bal5';
    else if (clean.includes('pack6') || clean.includes('pk6') || clean.includes('6pk')) resUnit = 'pack6';
    else if (clean.includes('pack3') || clean.includes('pk3') || clean.includes('3pk')) resUnit = 'pack3';
    else if (clean.includes('pack5') || clean.includes('pk5') || clean.includes('5pk')) resUnit = 'pack';
    else if (clean.includes('lusin') || clean.includes('doz') || clean.includes('-ls-') || clean.includes('_ls_') || clean.endsWith('-ls')) resUnit = 'lusin';
    else if (clean.includes('bal') || clean.includes('bl')) resUnit = 'bal25';
    else if (clean.includes('pack') || clean.includes('pk')) resUnit = 'pack';

    // 3. Batasi hasil deteksi hanya pada unit yang sah di gudang aktif
    if (allowedKeys.size > 0 && !allowedKeys.has(resUnit)) {
      if ((resUnit === 'pack3' || resUnit === 'pack6' || resUnit === 'pack5') && allowedKeys.has('pack')) {
        resUnit = 'pack';
      } else if (resUnit === 'bal5' && allowedKeys.has('pack')) {
        resUnit = 'pack';
      } else if (resUnit === 'bal' && allowedKeys.has('bal25')) {
        resUnit = 'bal25';
      } else if (resUnit === 'bal25' && allowedKeys.has('bal')) {
        resUnit = 'bal';
      } else if (resUnit.startsWith('bal') && allowedKeys.has('bal25')) {
        resUnit = 'bal25';
      } else {
        resUnit = 'pcs';
      }
    }

    return resUnit;
  };

  return { units, multipliers, isLusinUnit, parseUnitFromSn };
}

async function getCompanySettings(ownerId, warehouseId = null) {
  const { data: appSetting } = await supabaseAdmin
    .from('workspace_settings')
    .select('value')
    .eq('owner_id', ownerId)
    .eq('key', 'app')
    .maybeSingle();

  let companyData = appSetting?.value?.company;
  if (!companyData) {
    const compKey = warehouseId ? `company_${warehouseId}` : 'company';
    const { data: compSetting } = await supabaseAdmin
      .from('workspace_settings')
      .select('value')
      .eq('owner_id', ownerId)
      .eq('key', compKey)
      .maybeSingle();
    companyData = compSetting?.value;
    if (!companyData && warehouseId) {
      const { data: fallbackComp } = await supabaseAdmin
        .from('workspace_settings')
        .select('value')
        .eq('owner_id', ownerId)
        .eq('key', 'company')
        .maybeSingle();
      companyData = fallbackComp?.value;
    }
  }

  const { units, multipliers, isLusinUnit, parseUnitFromSn } = await getWorkspaceUnits(ownerId, warehouseId);

  return {
    companyName: companyData?.companyName || companyData?.name || 'Docuflow Company',
    companyAddress: companyData?.companyAddress || companyData?.address || '',
    companyPhone: companyData?.companyPhone || companyData?.phone || '',
    companyLogo: companyData?.companyLogo || companyData?.logoUrl || '',
    companyEmail: companyData?.companyEmail || companyData?.email || null,
    accentColor: appSetting?.value?.appearance?.accentColor || 'Indigo',
    custom_units: units,
    customUnits: units,
    multipliers,
    isLusinUnit,
    parseUnitFromSn,
  };
}

const idSchema = z.string().uuid();
const pagingSchema = z.object({
  search: z.string().trim().max(255).optional(),
  status: z.string().trim().max(50).optional(),
  type: z.string().trim().max(50).optional(),
  category: z.string().trim().max(255).optional(),
  productId: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  goodsInDocumentId: z.string().uuid().optional(),
  goods_in_document_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(10000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).passthrough();

const warehouseSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50),
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'archived']).default('active'),
});

const productSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().max(255).optional().nullable(),
  stock: z.coerce.number().int().default(0),
  stockNonSerial: z.coerce.number().int().optional(),
  unitCost: z.coerce.number().nonnegative().default(0),
  sellingPrice: z.coerce.number().nonnegative().default(0),
  discountType: z.enum(['none', 'percentage', 'fixed']).default('none'),
  discountValue: z.coerce.number().nonnegative().default(0),
  status: z.enum(['active', 'disabled']).default('active'),
  metadata: z.record(z.unknown()).default({}),
});

const uuidOrNullSchema = z.preprocess(
  (val) => {
    if (!val) return null;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return UUID_RE.test(String(val)) ? String(val) : null;
  },
  z.string().uuid().nullable()
);

const productSerialSchema = z.object({
  productId: z.string().uuid(),
  serialNumber: z.string().trim().min(1).max(255),
  status: z.enum(['available', 'reserved', 'out', 'damaged']).default('available'),
  goodsInDocumentId: z.string().uuid().optional().nullable(),
  goodsInItemId: uuidOrNullSchema.optional(),
  goodsOutDocumentId: z.string().uuid().optional().nullable(),
  goodsOutItemId: uuidOrNullSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

const contactSchema = z.object({
  type: z.literal('customer').default('customer'),
  name: z.string().trim().min(1).max(255),
  email: z.string().email().optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(255).optional().nullable(),
  province: z.string().trim().max(255).optional().nullable(),
  status: z.enum(['active', 'pending', 'archived']).default('active'),
  metadata: z.record(z.unknown()).default({}),
});

const adjustPointSchema = z.object({
  amount: z.coerce.number(),
  description: z.string().trim().min(1).max(500),
  pointValue: z.coerce.number().nonnegative().optional(),
});

async function getContactPointBalance(contactId, ownerId) {
  if (!contactId || !ownerId) return 0;
  try {
    const { data, error } = await supabaseAdmin
      .from('contact_points')
      .select('balance_after')
      .eq('contact_id', contactId)
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[Points] Error fetching balance:', error.message);
      return 0;
    }
    return data?.balance_after ?? 0;
  } catch (err) {
    console.error('[Points] Unexpected error fetching balance:', err);
    return 0;
  }
}

const templateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.enum(['invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'custom', 'sample']),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  isDefault: z.boolean().default(false),
  isCustom: z.boolean().default(false),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  paperSize: z.string().trim().max(50).default('a4'),
  layout: z.record(z.unknown()).default({}),
});

const documentItemSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  itemName: z.string().trim().min(1).max(255),
  sku: z.string().trim().max(100).optional().nullable(),
  quantity: z.coerce.number().positive().default(1),
  unitPrice: z.coerce.number().nonnegative().default(0),
  discountType: z.enum(['none', 'percentage', 'fixed']).default('none'),
  discountValue: z.coerce.number().nonnegative().default(0),
  amount: z.coerce.number().nonnegative().default(0),
  sortOrder: z.coerce.number().int().default(0),
  metadata: z.record(z.unknown()).default({}),
});

const documentSchema = z.object({
  documentType: z.enum(['invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'sample']),
  documentNumber: z.string().trim().min(1).max(255),
  contactId: z.string().uuid().optional().nullable(),
  contactName: z.string().trim().max(255).optional().nullable(),
  status: z.enum(['draft', 'processing', 'ready', 'completed', 'exported', 'cancelled']).default('draft'),
  issueDate: z.string().trim().max(50).optional(),
  dueDate: z.string().trim().max(50).optional().nullable(),
  paymentTerms: z.string().trim().max(255).optional().nullable(),
  subtotal: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  tax: z.coerce.number().nonnegative().default(0),
  total: z.coerce.number().nonnegative().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
  metadata: z.record(z.unknown()).default({}),
  items: z.array(documentItemSchema).default([]),
});

const settingsSchema = z.object({
  value: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean()]),
});

function productPayload(payload) {
  const data = {};
  if ('sku' in payload) data.sku = payload.sku;
  if ('name' in payload) data.name = payload.name;
  if ('category' in payload) data.category = payload.category ?? null;
  if ('stock' in payload) data.stock = payload.stock;
  if ('unitCost' in payload) data.unit_cost = payload.unitCost;
  if ('sellingPrice' in payload) data.selling_price = payload.sellingPrice;
  if ('discountType' in payload) data.discount_type = payload.discountType;
  if ('discountValue' in payload) data.discount_value = payload.discountValue;
  if ('status' in payload) data.status = payload.status;
  if ('metadata' in payload) data.metadata = payload.metadata;
  if ('stockNonSerial' in payload) {
    data.metadata = { ...(data.metadata || {}), stockNonSerial: payload.stockNonSerial };
  }
  return data;
}

function contactPayload(payload) {
  const data = {};
  if ('type' in payload) data.type = payload.type;
  if ('name' in payload) data.name = payload.name;
  if ('email' in payload) data.email = payload.email ?? null;
  if ('phone' in payload) data.phone = payload.phone ?? null;
  if ('address' in payload) data.address = payload.address ?? null;
  if ('city' in payload) data.city = payload.city ?? null;
  if ('province' in payload) data.province = payload.province ?? null;
  if ('status' in payload) data.status = payload.status;
  if ('metadata' in payload) data.metadata = payload.metadata;
  return data;
}

function productSerialPayload(payload) {
  const data = {};
  if ('productId' in payload) data.product_id = payload.productId;
  if ('serialNumber' in payload) data.serial_number = payload.serialNumber;
  if ('status' in payload) data.status = payload.status;
  if ('goodsInDocumentId' in payload) data.goods_in_document_id = payload.goodsInDocumentId ?? null;
  if ('goodsInItemId' in payload) data.goods_in_item_id = payload.goodsInItemId ?? null;
  if ('goodsOutDocumentId' in payload) data.goods_out_document_id = payload.goodsOutDocumentId ?? null;
  if ('goodsOutItemId' in payload) data.goods_out_item_id = payload.goodsOutItemId ?? null;
  if ('metadata' in payload) data.metadata = payload.metadata;
  return data;
}

function templatePayload(payload) {
  const data = {};
  if ('name' in payload) data.name = payload.name;
  if ('category' in payload) data.category = payload.category;
  if ('status' in payload) data.status = payload.status;
  if ('isDefault' in payload) data.is_default = payload.isDefault;
  if ('isCustom' in payload) data.is_custom = payload.isCustom;
  if ('orientation' in payload) data.orientation = payload.orientation;
  if ('paperSize' in payload) data.paper_size = payload.paperSize;
  if ('layout' in payload) data.layout = payload.layout;
  return data;
}

function documentPayload(payload) {
  const data = {};
  if ('documentType' in payload) data.document_type = payload.documentType;
  if ('documentNumber' in payload) data.document_number = payload.documentNumber;
  if ('contactId' in payload) data.contact_id = (payload.contactId && typeof payload.contactId === 'string' && payload.contactId.trim() !== '') ? payload.contactId.trim() : null;
  if ('contactName' in payload) data.contact_name = payload.contactName ?? null;
  if ('status' in payload) data.status = payload.status;
  if ('issueDate' in payload) data.issue_date = payload.issueDate ? String(payload.issueDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  if ('dueDate' in payload) data.due_date = (payload.dueDate && typeof payload.dueDate === 'string' && payload.dueDate.trim() !== '') ? String(payload.dueDate).slice(0, 10) : null;
  if ('paymentTerms' in payload) data.payment_terms = payload.paymentTerms ?? null;
  if ('subtotal' in payload) data.subtotal = payload.subtotal ?? 0;
  if ('discount' in payload) data.discount = payload.discount ?? 0;
  if ('tax' in payload) data.tax = payload.tax ?? 0;
  if ('total' in payload) data.total = payload.total ?? 0;
  if ('notes' in payload) data.notes = payload.notes ?? null;
  if ('metadata' in payload) data.metadata = payload.metadata ?? {};
  return data;
}

function documentItemPayload(documentId, item) {
  const isValidProductId = item.productId && typeof item.productId === 'string' && item.productId.trim() !== '' && item.productId !== '__new__';
  const isUnrecorded = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
  return {
    document_id: documentId,
    product_id: isUnrecorded ? null : (isValidProductId ? item.productId.trim() : null),
    item_name: item.itemName,
    sku: item.sku ?? null,
    quantity: item.quantity,
    unit_price: item.unitPrice ?? 0,
    discount_type: item.discountType ?? 'none',
    discount_value: item.discountValue ?? 0,
    amount: item.amount ?? 0,
    sort_order: item.sortOrder ?? 0,
    metadata: {
      ...(item.metadata ?? {}),
      ...(isUnrecorded && isValidProductId ? { originalProductId: item.productId.trim() } : {}),
      isUnrecorded: Boolean(isUnrecorded),
      isUnrecordedStock: Boolean(isUnrecorded),
      stockDeducted: false,
    },
  };
}

async function getRow(table, id, ownerId, select = '*') {
  const { data, error } = await supabaseAdmin.from(table).select(select).eq('id', id).eq('owner_id', ownerId).maybeSingle();
  if (error) throw httpError(500, `Failed to load ${table}`, error.message);
  if (!data) throw httpError(404, `${table} record not found`);
  return data;
}

function applyListFilters(query, params, searchColumns = []) {
  if (params.status) query = query.eq('status', params.status);
  if (params.type) query = query.eq('type', params.type);
  if (params.category) query = query.eq('category', params.category);
  const pId = params.productId || params.product_id;
  if (pId) query = query.eq('product_id', pId);
  const gId = params.goodsInDocumentId || params.goods_in_document_id;
  if (gId) query = query.eq('goods_in_document_id', gId);
  if (params.search && searchColumns.length) {
    query = query.or(searchColumns.map((column) => `${column}.ilike.%${params.search}%`).join(','));
  }
  return query.range(params.offset, params.offset + params.limit - 1);
}

function stripProductPriceFields(item) {
  if (!item) return item;
  const { unit_cost, selling_price, discount_type, discount_value, ...rest } = item;
  return rest;
}

function crudRouter({ table, entityType, schema, toPayload, searchColumns, filterColumns = [], selectFields = '*' }) {
  const itemRouter = Router();

  // Role sales_person tidak boleh melihat field harga pada modul products.
  // Stripping dilakukan di backend sebagai defense-in-depth (meskipun akses sudah diblokir di loadTenant).
  const isProductsTable = table === 'products';

  itemRouter.get('/', async (req, res, next) => {
    try {
      const params = pagingSchema.parse(req.query);
      let query = supabaseAdmin.from(table).select(selectFields, { count: 'exact' }).eq('owner_id', req.auth.ownerId).order('created_at', { ascending: false });
      const isOwnerOrSuperAdmin = req.auth.role === 'owner' || req.auth.role === 'super_admin';
      const queryWhId = req.query.warehouse_id || req.query.warehouseId;
      const targetWhId = isOwnerOrSuperAdmin
        ? ((queryWhId && queryWhId !== 'all') ? queryWhId : req.auth.warehouseId)
        : req.auth.warehouseId;
      if ((table === 'product_serials' || table === 'documents' || table === 'contacts') && targetWhId) {
        query = query.eq('warehouse_id', targetWhId);
      }
      if (table === 'contacts' && req.auth.role === 'sales_person') {
        query = query.eq('created_by', req.auth.user.id);
      }
      query = applyListFilters(query, {
        ...params,
        type: filterColumns.includes('type') ? params.type : undefined,
        category: filterColumns.includes('category') ? params.category : undefined,
      }, searchColumns);
      const { data, error, count } = await query;
      if (error) throw httpError(500, `Failed to load ${table}`, error.message);
      let result = data;

      // Supabase PostgREST hard-caps single requests to 1000 rows.
      // If client requested limit > 1000 and total count exceeds 1000, paginate remaining chunks automatically.
      if (params.limit > 1000 && count > 1000 && Array.isArray(data)) {
        let allData = [...data];
        let currentOffset = params.offset + allData.length;
        const targetTotal = Math.min(count, params.offset + params.limit);

        while (currentOffset < targetTotal) {
          const chunkSize = Math.min(1000, targetTotal - currentOffset);
          let chunkQuery = supabaseAdmin.from(table).select(selectFields).eq('owner_id', req.auth.ownerId).order('created_at', { ascending: false });
          if ((table === 'product_serials' || table === 'documents' || table === 'contacts') && targetWhId) {
            chunkQuery = chunkQuery.eq('warehouse_id', targetWhId);
          }
          if (table === 'contacts' && req.auth.role === 'sales_person') {
            chunkQuery = chunkQuery.eq('created_by', req.auth.user.id);
          }
          chunkQuery = applyListFilters(chunkQuery, {
            ...params,
            offset: currentOffset,
            limit: chunkSize,
            type: filterColumns.includes('type') ? params.type : undefined,
            category: filterColumns.includes('category') ? params.category : undefined,
          }, searchColumns);

          const { data: chunkData, error: chunkErr } = await chunkQuery;
          if (chunkErr || !chunkData || chunkData.length === 0) break;
          allData.push(...chunkData);
          currentOffset += chunkData.length;
          if (chunkData.length < chunkSize) break;
        }
        result = allData;
      }

      if (isProductsTable && req.auth.role === 'sales_person') {
        result = (result || []).map(stripProductPriceFields);
      }
      res.json({ data: result, count });
    } catch (error) {
      next(error);
    }
  });

  itemRouter.get('/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const data = await getRow(table, id, req.auth.ownerId);
      if (table === 'contacts' && req.auth.role === 'sales_person' && data.created_by !== req.auth.user.id) {
        throw httpError(403, 'Access denied: You do not own this contact.');
      }
      let result = data;
      if (isProductsTable && req.auth.role === 'sales_person') {
        result = stripProductPriceFields(data);
      }
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  itemRouter.post('/', async (req, res, next) => {
    try {
      const payload = schema.parse(req.body);
      if (table === 'templates' && payload.category !== 'custom') {
        const nextTemplate = {
          ...toPayload({
            ...payload,
            status: 'active',
            isDefault: true,
            isCustom: false,
          }),
          created_by: req.auth.user.id,
          owner_id: req.auth.ownerId,
        };
        const { data: existingRows, error: existingError } = await supabaseAdmin
          .from(table)
          .select('*')
          .eq('owner_id', req.auth.ownerId)
          .eq('category', payload.category)
          .limit(1);
        if (existingError) throw httpError(500, `Failed to check ${table}`, existingError.message);
        const existing = existingRows?.[0];

        if (existing) {
          const { data, error } = await supabaseAdmin
            .from(table)
            .update(nextTemplate)
            .eq('id', existing.id)
            .eq('owner_id', req.auth.ownerId)
            .select('*')
            .single();
          if (error) throw httpError(500, `Failed to update ${table}`, error.message);
          await writeActivityLog(req, { action: 'updated', entityType, entityId: data.id, entityName: data.name, beforeData: existing, afterData: data });
          return res.json({ data });
        }

        const { data, error } = await supabaseAdmin
          .from(table)
          .insert(nextTemplate)
          .select('*')
          .single();
        if (error) throw httpError(500, `Failed to create ${table}`, error.message);
        await writeActivityLog(req, { action: 'created', entityType, entityId: data.id, entityName: data.name, afterData: data });
        return res.status(201).json({ data });
      }
      let insertPayload = { ...toPayload(payload), created_by: req.auth.user.id, owner_id: req.auth.ownerId };
      if ((table === 'products' || table === 'product_serials' || table === 'documents' || table === 'contacts') && req.auth.warehouseId) {
        insertPayload.warehouse_id = req.auth.warehouseId;
      }
      if (table === 'contacts' && req.auth.role === 'sales_person') {
        const salesName = req.auth.user.user_metadata?.full_name ?? req.auth.user.email;
        insertPayload.metadata = {
          ...(insertPayload.metadata || {}),
          picSales: salesName
        };
      }
      const { data, error } = await supabaseAdmin
        .from(table)
        .insert(insertPayload)
        .select('*')
        .single();
      if (error) {
        if (table === 'products' && (error.code === '23505' || String(error.message).toLowerCase().includes('unique') || String(error.message).toLowerCase().includes('duplicate'))) {
          let query = supabaseAdmin.from('products').select('*').eq('owner_id', req.auth.ownerId);
          if (insertPayload.sku) {
            query = query.eq('sku', insertPayload.sku);
          } else if (insertPayload.name) {
            query = query.eq('name', insertPayload.name);
          }
          const { data: existingRows } = await query.limit(1);
          if (existingRows && existingRows[0]) {
            return res.status(200).json({ data: existingRows[0] });
          }
        }
        throw httpError(500, `Failed to create ${table}`, error.message);
      }
      await writeActivityLog(req, { action: 'created', entityType, entityId: data.id, entityName: data.name ?? data.sku ?? data.serial_number, afterData: data });
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  });

  itemRouter.patch('/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const beforeData = await getRow(table, id, req.auth.ownerId);
      if (table === 'contacts' && req.auth.role === 'sales_person' && beforeData.created_by !== req.auth.user.id) {
        throw httpError(403, 'Access denied: You do not own this contact.');
      }
      const payload = schema.partial().parse(req.body);
      const nextPayload = table === 'templates' && beforeData.category !== 'custom'
        ? {
          ...payload,
          status: 'active',
          isDefault: true,
          isCustom: false,
        }
        : payload;

      let updatePayload = toPayload(nextPayload);
      if (table === 'products') {
        updatePayload.metadata = {
          ...(beforeData.metadata || {}),
          ...(updatePayload.metadata || {}),
        };
      }

      const { data, error } = await supabaseAdmin
        .from(table)
        .update(updatePayload)
        .eq('id', id)
        .eq('owner_id', req.auth.ownerId)
        .select('*')
      if (error) throw httpError(500, `Failed to update ${table}`, error.message);

      // If product name or sku is updated, synchronize historical document items and PO items
      if (table === 'products') {
        const itemUpdates = {};
        if (updatePayload.name && updatePayload.name !== beforeData.name) {
          itemUpdates.item_name = updatePayload.name;
        }
        if (updatePayload.sku && updatePayload.sku !== beforeData.sku) {
          itemUpdates.sku = updatePayload.sku;
        }

        if (Object.keys(itemUpdates).length > 0) {
          try {
            // 1. Update document_items matching product_id
            await supabaseAdmin
              .from('document_items')
              .update(itemUpdates)
              .eq('product_id', id);

            // 2. Also update document_items where product_id might be null but SKU matches
            if (beforeData.sku) {
              await supabaseAdmin
                .from('document_items')
                .update(itemUpdates)
                .eq('sku', beforeData.sku)
                .is('product_id', null);

              // 3. Update purchase_order_items by SKU
              await supabaseAdmin
                .from('purchase_order_items')
                .update(itemUpdates)
                .eq('sku', beforeData.sku);
            }
          } catch (syncErr) {
            console.error('Failed to cascade product name/sku updates to transactions:', syncErr);
          }
        }
      }

      await writeActivityLog(req, { action: 'updated', entityType, entityId: id, entityName: data.name ?? data.sku ?? data.serial_number, beforeData, afterData: data });
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  itemRouter.delete('/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const beforeData = await getRow(table, id, req.auth.ownerId);
      if (table === 'contacts' && req.auth.role === 'sales_person' && beforeData.created_by !== req.auth.user.id) {
        throw httpError(403, 'Access denied: You do not own this contact.');
      }
      if (table === 'products') {
        await supabaseAdmin
          .from('product_serials')
          .delete()
          .eq('product_id', id)
          .eq('owner_id', req.auth.ownerId);
      }
      const { error } = await supabaseAdmin.from(table).delete().eq('id', id).eq('owner_id', req.auth.ownerId);
      if (error) throw httpError(500, `Failed to delete ${table}`, error.message);
      await writeActivityLog(req, { action: 'deleted', entityType, entityId: id, entityName: beforeData.name ?? beforeData.sku ?? beforeData.serial_number, beforeData });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return itemRouter;
}

router.use(requireAuth);
router.use(loadTenant);

// ── Warehouses Endpoints ────────────────────────────────────────
router.get('/warehouses', async (req, res, next) => {
  try {
    let query = supabaseAdmin
      .from('warehouses')
      .select('*')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (req.auth.role === 'super_admin') {
      if (req.query.owner_id) {
        query = query.eq('owner_id', req.query.owner_id);
      } else {
        query = query.eq('owner_id', req.auth.ownerId);
      }
    } else if (req.auth.role === 'owner') {
      query = query.eq('owner_id', req.auth.ownerId);
    } else if (req.auth.role === 'staff' || req.auth.role === 'sales_person') {
      if (req.auth.warehouseId) {
        query = query.eq('id', req.auth.warehouseId);
      } else {
        query = query.eq('owner_id', req.auth.ownerId);
      }
    }

    const { data, error } = await query;
    if (error) throw httpError(500, 'Failed to fetch warehouses', error.message);
    res.json({ data: data || [], activeWarehouseId: req.auth.warehouseId });
  } catch (error) {
    next(error);
  }
});

router.post('/warehouses', async (req, res, next) => {
  try {
    if (req.auth.role !== 'owner' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Hanya Owner atau Super Admin yang dapat menambahkan gudang baru.');
    }
    const payload = warehouseSchema.parse(req.body);
    const ownerId = req.auth.ownerId;

    const { data, error } = await supabaseAdmin
      .from('warehouses')
      .insert({
        owner_id: ownerId,
        name: payload.name,
        code: payload.code.toUpperCase(),
        address: payload.address ?? null,
        phone: payload.phone ?? null,
        is_default: !!payload.isDefault,
        status: payload.status,
      })
      .select()
      .single();

    if (error) throw httpError(500, 'Failed to create warehouse', error.message);

    // Initialize default units (only Pcs and Lusin) for the new warehouse
    await supabaseAdmin
      .from('workspace_settings')
      .upsert({
        owner_id: ownerId,
        key: `custom_units_${data.id}`,
        value: DEFAULT_CUSTOM_UNITS,
        updated_by: req.auth.user.id,
      }, { onConflict: 'owner_id,key' });

    res.status(201).json({ data });
  } catch (error) {
    next(error);
  }
});

router.patch('/warehouses/:id', async (req, res, next) => {
  try {
    if (req.auth.role !== 'owner' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Hanya Owner atau Super Admin yang dapat mengubah profil gudang.');
    }
    const id = idSchema.parse(req.params.id);
    const payload = warehouseSchema.partial().parse(req.body);

    const updateData = {};
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.code !== undefined) updateData.code = payload.code.toUpperCase();
    if (payload.address !== undefined) updateData.address = payload.address;
    if (payload.phone !== undefined) updateData.phone = payload.phone;
    if (payload.status !== undefined) updateData.status = payload.status;
    if (payload.isDefault !== undefined) updateData.is_default = payload.isDefault;
    updateData.updated_at = new Date().toISOString();

    let query = supabaseAdmin.from('warehouses').update(updateData).eq('id', id);
    if (req.auth.role !== 'super_admin') {
      query = query.eq('owner_id', req.auth.ownerId);
    }
    const { data, error } = await query.select().single();
    if (error) throw httpError(500, 'Failed to update warehouse', error.message);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.delete('/warehouses/:id', async (req, res, next) => {
  try {
    if (req.auth.role !== 'owner' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Hanya Owner atau Super Admin yang dapat mengarsipkan gudang.');
    }
    const id = idSchema.parse(req.params.id);

    const { data: wh } = await supabaseAdmin.from('warehouses').select('is_default').eq('id', id).maybeSingle();
    if (wh?.is_default) {
      throw httpError(400, 'Gudang utama default tidak dapat diarsipkan.');
    }

    let query = supabaseAdmin.from('warehouses').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id);
    if (req.auth.role !== 'super_admin') {
      query = query.eq('owner_id', req.auth.ownerId);
    }
    const { data, error } = await query.select().single();
    if (error) throw httpError(500, 'Failed to archive warehouse', error.message);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ── Batch Product Creation Endpoint ─────────────────────────────
router.post('/products/batch', async (req, res, next) => {
  try {
    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    if (rawProducts.length === 0) {
      return res.json({ data: [] });
    }

    // 1. Fetch existing products for this owner to avoid duplicate insertion
    const skus = Array.from(new Set(rawProducts.map((p) => (p.sku || '').trim()).filter(Boolean)));
    const names = Array.from(new Set(rawProducts.map((p) => (p.name || '').trim()).filter(Boolean)));

    let existingProducts = [];
    if (skus.length > 0 || names.length > 0) {
      let query = supabaseAdmin
        .from('products')
        .select('id, sku, name, category, stock, unit_cost, selling_price, discount_type, discount_value, status, created_at')
        .eq('owner_id', req.auth.ownerId);

      // Check across entire catalog for this owner so we never try to insert a duplicate SKU
      const conditions = [];
      if (skus.length > 0) {
        conditions.push(`sku.in.(${skus.map((s) => `"${s.replace(/"/g, '""')}"`).join(',')})`);
      }
      if (names.length > 0) {
        conditions.push(`name.in.(${names.map((n) => `"${n.replace(/"/g, '""')}"`).join(',')})`);
      }

      if (conditions.length > 0) {
        query = query.or(conditions.join(','));
      }

      const { data: found, error: findErr } = await query;
      if (!findErr && Array.isArray(found)) {
        existingProducts = found;
      }
    }

    // 2. Filter out products that already exist, and deduplicate within batch
    const recordsToInsert = [];
    const seenBatchKeys = new Set();

    for (const p of rawProducts) {
      const sku = (p.sku || '').trim();
      const name = (p.name || '').trim();
      if (!name) continue;

      const dedupKey = sku ? `sku:${sku.toLowerCase()}` : `name:${name.toLowerCase()}`;
      if (seenBatchKeys.has(dedupKey)) continue;
      seenBatchKeys.add(dedupKey);

      // Check if already in existingProducts
      const matchExisting = existingProducts.find(
        (ep) =>
          (sku && ep.sku && ep.sku.toLowerCase() === sku.toLowerCase()) ||
          (name && ep.name && ep.name.toLowerCase() === name.toLowerCase())
      );
      if (matchExisting) continue;

      const payloadData = productPayload(p);
      recordsToInsert.push({
        ...payloadData,
        sku: sku || `SKU-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        name: name,
        owner_id: req.auth.ownerId,
        created_by: req.auth.user.id,
        warehouse_id: req.auth.warehouseId || p.warehouseId || null,
        status: payloadData.status || 'active',
        stock: payloadData.stock ?? 0,
        unit_cost: payloadData.unit_cost ?? 0,
        selling_price: payloadData.selling_price ?? 0,
        discount_type: payloadData.discount_type || 'none',
        discount_value: payloadData.discount_value ?? 0,
      });
    }

    let insertedProducts = [];
    if (recordsToInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('products')
        .insert(recordsToInsert)
        .select('id, sku, name, category, stock, unit_cost, selling_price, discount_type, discount_value, status, created_at');

      if (insertError) {
        if (insertError.code === '23505' || insertError.message?.includes('duplicate key') || insertError.message?.includes('unique')) {
          const { data: refetched } = await supabaseAdmin
            .from('products')
            .select('id, sku, name, category, stock, unit_cost, selling_price, discount_type, discount_value, status, created_at')
            .eq('owner_id', req.auth.ownerId);
          return res.status(200).json({ data: refetched || [] });
        }
        throw httpError(500, 'Gagal menyimpan produk secara batch: ' + insertError.message);
      }

      insertedProducts = inserted || [];

      writeActivityLog(req, {
        action: 'created',
        entityType: 'Products',
        entityName: `${insertedProducts.length} Produk (Batch)`,
        metadata: { count: insertedProducts.length },
      });
    }

    const allProducts = [...existingProducts, ...insertedProducts];
    return res.status(201).json({ data: allProducts, insertedCount: insertedProducts.length });
  } catch (error) {
    next(error);
  }
});

router.use('/products', crudRouter({
  table: 'products',
  entityType: 'Products',
  schema: productSchema,
  toPayload: productPayload,
  searchColumns: ['sku', 'name', 'category'],
  filterColumns: ['category'],
  selectFields: 'id, sku, name, category, stock, unit_cost, selling_price, discount_type, discount_value, status, created_at',
}));

// ── Product Serial Specialized Endpoints ─────────────────────────
router.get('/product-serial-counts/goods-in', async (req, res, next) => {
  try {
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('goods_in_serial_counts', {
      p_owner_id: req.auth.ownerId,
      p_warehouse_id: null,
    });

    if (!rpcError && Array.isArray(rpcData)) {
      return res.json({ data: rpcData });
    }

    const { data, error } = await supabaseAdmin
      .from('product_serials')
      .select('goods_in_document_id')
      .eq('owner_id', req.auth.ownerId)
      .not('goods_in_document_id', 'is', null)
      .limit(50000);

    if (error) throw httpError(500, 'Failed to load serial counts', error.message);

    const countsMap = {};
    (data || []).forEach((row) => {
      const docId = row.goods_in_document_id;
      if (docId) countsMap[docId] = (countsMap[docId] || 0) + 1;
    });

    const result = Object.entries(countsMap).map(([document_id, serial_count]) => ({
      document_id,
      serial_count,
    }));

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/product-serial-lookup', async (req, res, next) => {
  try {
    const serial = String(req.query.serial || '').trim();
    const documentId = req.query.documentId ? String(req.query.documentId).trim() : null;
    const allowAnyStatus = req.query.allowAnyStatus === 'true' || req.query.purpose === 'stock_opname';

    if (!serial) {
      throw httpError(400, 'Parameter serial harus disertakan.');
    }

    const targetWarehouseId = req.query.warehouse_id || req.query.warehouseId || req.auth.warehouseId || null;
    const cacheKey = serialCacheKey(req.auth.ownerId, targetWarehouseId, serial);

    // ── Cache hit ── serve from memory instantly (0ms)
    const cached = serialCacheGet(cacheKey);
    if (cached) {
      if (cached.miss) {
        throw httpError(404, `Nomor seri ${serial} tidak ditemukan.`);
      }
      const { data, product } = cached;
      const isAvailable = allowAnyStatus || data.status === 'available' || (documentId && data.goods_out_document_id === documentId);
      if (!isAvailable) {
        throw httpError(400, `Nomor seri ${serial} tidak tersedia (status: ${data.status}).`);
      }
      if (!allowAnyStatus && (data.metadata?.isGrouped || data.metadata?.parentGroupId)) {
        throw httpError(400, `Nomor seri "${serial}" sedang berada di dalam group "${data.metadata?.parentGroupSerialNumber || 'Group'}". Group induk paling atas harus dibongkar (ungroup) terlebih dahulu sebelum dapat dikeluarkan.`);
      }
      if (!allowAnyStatus && data.metadata?.isDissolved) {
        throw httpError(400, `Nomor seri "${serial}" adalah group yang sudah dibongkar (dissolved) dan tidak aktif lagi.`);
      }
      if (data.metadata?.isGroup && data.metadata?.resultProductName && product) {
        product.name = data.metadata.resultProductName;
      }
      return res.json({ data: { ...data, product } });
    }

    // Single joined query: resolves serial + product in 1 database roundtrip
    let query = supabaseAdmin
      .from('product_serials')
      .select('id, product_id, serial_number, status, goods_in_document_id, goods_in_item_id, goods_out_document_id, goods_out_item_id, metadata, warehouse_id, created_at, product:products(id, name, sku, category, unit_cost, selling_price, metadata)')
      .eq('owner_id', req.auth.ownerId)
      .in('serial_number', serialVariants(serial));

    if (targetWarehouseId && !allowAnyStatus) {
      query = query.or(`warehouse_id.eq.${targetWarehouseId},warehouse_id.is.null`);
    }

    const { data: foundSerial, error: queryError } = await query.limit(1).maybeSingle();
    if (queryError) throw httpError(500, 'Failed to lookup serial', queryError.message);

    if (!foundSerial) {
      // Cache miss to prevent rapid repeat calls from hammering DB
      serialCacheSet(cacheKey, null, null, true);
      throw httpError(404, `Nomor seri ${serial} tidak ditemukan.`);
    }

    const isAvailable = allowAnyStatus || foundSerial.status === 'available' || (documentId && foundSerial.goods_out_document_id === documentId);
    if (!isAvailable) {
      throw httpError(400, `Nomor seri ${serial} tidak tersedia (status: ${foundSerial.status}).`);
    }

    if (!allowAnyStatus && (foundSerial.metadata?.isGrouped || foundSerial.metadata?.parentGroupId)) {
      throw httpError(400, `Nomor seri "${serial}" sedang berada di dalam group "${foundSerial.metadata?.parentGroupSerialNumber || 'Group'}". Group induk paling atas harus dibongkar (ungroup) terlebih dahulu sebelum dapat dikeluarkan.`);
    }
    if (!allowAnyStatus && foundSerial.metadata?.isDissolved) {
      throw httpError(400, `Nomor seri "${serial}" adalah group yang sudah dibongkar (dissolved) dan tidak aktif lagi.`);
    }

    const product = foundSerial.product || null;
    if (foundSerial.metadata?.isGroup && foundSerial.metadata?.resultProductName && product) {
      product.name = foundSerial.metadata.resultProductName;
    }
    const serialData = { ...foundSerial };
    delete serialData.product;

    serialCacheSet(cacheKey, serialData, product, false);

    res.json({ data: { ...serialData, product } });
  } catch (error) {
    next(error);
  }
});


// Ultra-fast compact index of warehouse serials with memory caching and auto-chunking (overcoming 1000 row cap)
router.get('/product-serial-index', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const queryWarehouseId = req.query.warehouse_id || req.query.warehouseId || null;
    const isAllWarehouses = queryWarehouseId === 'all';
    const warehouseId = isAllWarehouses ? null : (queryWarehouseId || req.auth.warehouseId || null);
    const allowAllStatus = req.query.allStatus === 'true' || req.query.purpose === 'stock_opname';
    const documentId = req.query.documentId ? String(req.query.documentId).trim() : null;

    const cacheKey = `${ownerId}:${warehouseId || 'all'}:${allowAllStatus ? 'all' : 'available'}:${documentId || 'none'}`;
    const cached = WAREHOUSE_SERIAL_INDEX_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < WAREHOUSE_SERIAL_INDEX_TTL_MS) {
      return res.json(cached.payload);
    }

    // Auto-paginating chunks to fetch 100% of warehouse serials (no 1000 cap cutoff)
    let allData = [];
    let offset = 0;
    const CHUNK_SIZE = 1000;

    while (true) {
      let pageQuery = supabaseAdmin
        .from('product_serials')
        .select('serial_number, product_id, status, goods_out_document_id, goods_in_document_id, created_at, metadata, warehouse_id')
        .eq('owner_id', ownerId)
        .order('id', { ascending: true })
        .range(offset, offset + CHUNK_SIZE - 1);

      if (warehouseId) {
        // Sertakan serial milik gudang ini dan serial warisan (null)
        pageQuery = pageQuery.or(`warehouse_id.eq.${warehouseId},warehouse_id.is.null`);
      }

      if (allowAllStatus) {
        // No status filter for Stock Opname reconciliation
      } else if (documentId) {
        pageQuery = pageQuery.or(`status.eq.available,goods_out_document_id.eq.${documentId}`);
      } else {
        pageQuery = pageQuery.eq('status', 'available');
      }

      const { data, error } = await pageQuery;
      if (error) throw httpError(500, 'Failed to load serial index', error.message);
      if (!data || data.length === 0) break;

      allData.push(...data);
      if (data.length < CHUNK_SIZE) break;
      offset += CHUNK_SIZE;
    }

    // Filter out grouped serials and dissolved serials if not allowAllStatus (e.g. for Goods Out)
    const eligibleData = allowAllStatus
      ? allData
      : allData.filter((r) => !r.metadata?.isGrouped && !r.metadata?.parentGroupId && !r.metadata?.isDissolved);

    // Array-of-arrays keeps the payload small: [serial, productId, unit, status, warehouseId, goodsInDocId, createdAt, isGrouped, isGroup, isDissolved, targetQty]
    const rows = eligibleData.map((r) => [
      r.serial_number,
      r.product_id,
      r.metadata?.targetUnit || r.metadata?.serialUnit || r.metadata?.unit || r.metadata?.qtyUnit || null,
      r.status,
      r.warehouse_id || null,
      r.goods_in_document_id || null,
      r.created_at || null,
      Boolean(r.metadata?.isGrouped || r.metadata?.parentGroupId),
      Boolean(r.metadata?.isGroup),
      Boolean(r.metadata?.isDissolved),
      Number(r.metadata?.targetQty ?? r.metadata?.unitQty ?? 1),
    ]);

    // Pre-populate SERIAL_CACHE for instant subsequent single scans
    for (const r of eligibleData) {
      if (r.serial_number) {
        const itemCacheKey = serialCacheKey(ownerId, warehouseId, r.serial_number);
        if (!SERIAL_CACHE.has(itemCacheKey)) {
          serialCacheSet(itemCacheKey, r, null, false);
        }
      }
    }

    const payload = { data: rows, count: rows.length };
    WAREHOUSE_SERIAL_INDEX_CACHE.set(cacheKey, {
      payload,
      timestamp: Date.now(),
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});


router.post('/product-serial-lookup/batch', async (req, res, next) => {
  try {
    const rawSerials = Array.isArray(req.body?.serials) ? req.body.serials.map(s => String(s).trim()).filter(Boolean) : [];
    if (rawSerials.length === 0) {
      return res.json({ data: [] });
    }

    // Build variations so uppercase / lowercase from Excel match instantly via B-Tree index
    const serialVariations = Array.from(new Set([
      ...rawSerials,
      ...rawSerials.map(s => s.toUpperCase()),
      ...rawSerials.map(s => s.toLowerCase()),
    ]));

    let query = supabaseAdmin
      .from('product_serials')
      .select('id, product_id, serial_number, status, goods_in_document_id, goods_in_item_id, goods_out_document_id, goods_out_item_id, metadata, warehouse_id, created_at')
      .eq('owner_id', req.auth.ownerId)
      .in('serial_number', serialVariations);

    if (req.auth.warehouseId) {
      query = query.eq('warehouse_id', req.auth.warehouseId);
    }

    const { data: serialData, error: serialErr } = await query;
    if (serialErr) throw httpError(500, 'Failed to batch lookup serials', serialErr.message);

    const foundSerials = serialData || [];
    const productIds = Array.from(new Set(foundSerials.map(s => s.product_id).filter(Boolean)));

    let productsMap = {};
    if (productIds.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, name, sku, category, unit_cost, selling_price, metadata')
        .in('id', productIds);
      (prods || []).forEach(p => { productsMap[p.id] = p; });
    }

    const result = foundSerials.map(s => ({
      ...s,
      product: productsMap[s.product_id] || null,
      isGrouped: Boolean(s.metadata?.isGrouped || s.metadata?.parentGroupId),
      parentGroupSerialNumber: s.metadata?.parentGroupSerialNumber || null,
      isGroup: Boolean(s.metadata?.isGroup),
      isDissolved: Boolean(s.metadata?.isDissolved),
    }));

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/product-serials/batch', async (req, res, next) => {
  try {
    const serials = Array.isArray(req.body?.serials) ? req.body.serials : [];
    if (serials.length === 0) {
      return res.json({ data: [] });
    }

    let targetWarehouseId = req.auth.warehouseId || null;
    const firstDocId = serials[0]?.goodsInDocumentId || serials[0]?.goods_in_document_id;
    if (!targetWarehouseId && firstDocId) {
      const { data: docWh } = await supabaseAdmin
        .from('documents')
        .select('warehouse_id')
        .eq('id', firstDocId)
        .maybeSingle();
      if (docWh?.warehouse_id) {
        targetWarehouseId = docWh.warehouse_id;
      }
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const toUuidOrNull = (val) => (val && UUID_RE.test(String(val)) ? String(val) : null);

    const records = serials.map((s) => ({
      product_id: s.productId || s.product_id,
      serial_number: s.serialNumber || s.serial_number,
      status: s.status || 'available',
      goods_in_document_id: toUuidOrNull(s.goodsInDocumentId || s.goods_in_document_id),
      goods_in_item_id: toUuidOrNull(s.goodsInItemId || s.goods_in_item_id),
      goods_out_document_id: toUuidOrNull(s.goodsOutDocumentId || s.goods_out_document_id),
      goods_out_item_id: toUuidOrNull(s.goodsOutItemId || s.goods_out_item_id),
      metadata: s.metadata || {},
      owner_id: req.auth.ownerId,
      created_by: req.auth.user.id,
      warehouse_id: toUuidOrNull(targetWarehouseId || s.warehouseId || s.warehouse_id),
    }));

    const { data, error } = await supabaseAdmin
      .from('product_serials')
      .insert(records)
      .select();

    if (error) {
      if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('unique')) {
        throw httpError(400, 'Terdapat nomor seri yang duplikat atau sudah pernah terdaftar di sistem.');
      }
      throw httpError(500, 'Gagal menyimpan serial numbers secara batch: ' + error.message);
    }

    writeActivityLog(req, {
      action: 'created',
      entityType: 'Product Serials',
      entityName: `${records.length} Serial Numbers Batch`,
      metadata: { count: records.length, goodsInDocumentId: firstDocId },
    });

    invalidateWarehouseSerialIndex(req.auth.ownerId);

    res.status(201).json({ data });
  } catch (error) {
    next(error);
  }
});

// ── Serial Number Grouping Endpoints ──────────────────────────────
const emptyToNullUuid = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().uuid().optional().nullable()
);

const groupMemberIdsSchema = z.array(z.string().uuid()).max(200, 'Maksimal 200 nomor seri per batch.').optional();
const groupMemberSNsSchema = z.array(z.string().trim().min(1).max(200)).max(200, 'Maksimal 200 nomor seri per batch.').optional();

const groupSerialSchema = z.object({
  memberSerialIds: groupMemberIdsSchema,
  memberSerialNumbers: groupMemberSNsSchema,
  groupSerialNumber: z.string().trim().max(160).optional().nullable(),
  resultProductName: z.string().trim().max(255).optional().nullable(),
  resultProductSku: z.string().trim().max(120).optional().nullable(),
  resultProductId: emptyToNullUuid,
  targetUnit: z.string().trim().max(50).optional().nullable(),
  createNewMasterProduct: z.boolean().optional().default(false),
  warehouseId: emptyToNullUuid,
  notes: z.string().trim().max(1000).optional().nullable(),
  idempotencyKey: z.string().trim().max(200).optional().nullable(),
});

const multiGroupSerialSchema = z.object({
  warehouseId: emptyToNullUuid,
  batches: z.array(z.object({
    batchId: z.string().trim().max(120).optional(),
    name: z.string().trim().max(255).optional(),
    memberSerialIds: groupMemberIdsSchema,
    memberSerialNumbers: groupMemberSNsSchema,
    groupSerialNumber: z.string().trim().max(160).optional().nullable(),
    resultProductName: z.string().trim().max(255).optional().nullable(),
    resultProductSku: z.string().trim().max(120).optional().nullable(),
    resultProductId: emptyToNullUuid,
    targetUnit: z.string().trim().max(50).optional().nullable(),
    createNewMasterProduct: z.boolean().optional().default(false),
    warehouseId: emptyToNullUuid,
    notes: z.string().trim().max(1000).optional().nullable(),
    idempotencyKey: z.string().trim().max(200).optional().nullable(),
  })).min(1, 'Daftar batch grouping tidak boleh kosong.').max(50, 'Maksimal 50 batch per request.'),
});

const verifyScanSchema = z.object({
  serialNumber: z.string().trim().min(1, 'Nomor seri wajib diisi.').max(200),
  warehouseId: emptyToNullUuid,
});

router.post('/product-serials/group/verify-scan', async (req, res, next) => {
  try {
    const { serialNumber, warehouseId } = verifyScanSchema.parse(req.body || {});
    const resolvedWarehouseId = warehouseId || req.auth.warehouseId || null;
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, resolvedWarehouseId);
    const result = await verifyScanSerialForGrouping({
      ownerId: req.auth.ownerId,
      warehouseId: resolvedWarehouseId,
      serialNumber,
      customUnits: unitsCtx.units,
      unitMultipliers: unitsCtx.multipliers,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (!error.status) error.status = 400;
    next(error);
  }
});

router.post('/product-serials/group/multi', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan melakukan grouping serial number.');
    }

    const payload = multiGroupSerialSchema.parse(req.body);
    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';
    const resolvedWarehouseId = payload.warehouseId || req.auth.warehouseId;
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, resolvedWarehouseId);

    const result = await processMultiSerialGroups({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      userName,
      warehouseId: resolvedWarehouseId,
      batches: payload.batches,
      customUnits: unitsCtx.units,
      unitMultipliers: unitsCtx.multipliers,
    });

    writeActivityLog(req, {
      action: 'created',
      entityType: 'Serial Group Multi',
      entityName: `${result.summary.succeeded}/${result.summary.total} Batches Processed`,
      metadata: {
        summary: result.summary,
      },
    });

    invalidateWarehouseSerialIndex(req.auth.ownerId);

    res.json({
      success: result.summary.failed === 0,
      status: result.summary.status,
      partial: result.summary.partial,
      data: result,
    });
  } catch (error) {
    if (!error.status) error.status = 400;
    next(error);
  }
});

router.post('/product-serials/group/preview', async (req, res, next) => {
  try {
    const payload = groupSerialSchema.parse(req.body);
    const resolvedWarehouseId = payload.warehouseId || req.auth.warehouseId;
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, resolvedWarehouseId);

    const result = await previewSerialGroup({
      ownerId: req.auth.ownerId,
      memberSerialIds: payload.memberSerialIds,
      memberSerialNumbers: payload.memberSerialNumbers,
      groupSerialNumber: payload.groupSerialNumber,
      resultProductName: payload.resultProductName,
      resultProductSku: payload.resultProductSku,
      resultProductId: payload.resultProductId,
      createNewMasterProduct: payload.createNewMasterProduct,
      targetUnit: payload.targetUnit,
      warehouseId: resolvedWarehouseId,
      customUnits: unitsCtx.units,
      multipliers: unitsCtx.multipliers,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    if (!error.status) {
      error.status = 400;
    }
    next(error);
  }
});

router.post('/product-serials/group', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan melakukan grouping serial number.');
    }

    const payload = groupSerialSchema.parse(req.body);
    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';
    const resolvedWarehouseId = payload.warehouseId || req.auth.warehouseId;
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, resolvedWarehouseId);

    const result = await createSerialGroup({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      userName,
      memberSerialIds: payload.memberSerialIds,
      memberSerialNumbers: payload.memberSerialNumbers,
      groupSerialNumber: payload.groupSerialNumber,
      resultProductName: payload.resultProductName,
      resultProductSku: payload.resultProductSku,
      resultProductId: payload.resultProductId,
      targetUnit: payload.targetUnit,
      createNewMasterProduct: payload.createNewMasterProduct,
      warehouseId: resolvedWarehouseId,
      notes: payload.notes,
      idempotencyKey: payload.idempotencyKey,
      customUnits: unitsCtx.units,
      unitMultipliers: unitsCtx.multipliers,
    });

    writeActivityLog(req, {
      action: 'created',
      entityType: 'Serial Group',
      entityId: result.group?.id,
      entityName: result.group?.serial_number,
      metadata: {
        isCrossProduct: result.isCrossProduct,
        resultProductName: result.resultProductName,
        totalPcs: result.totalPcs,
        directMemberCount: result.directMemberCount,
        leafMemberCount: result.leafMemberCount,
        unitBreakdown: result.unitBreakdown,
        documentId: result.documentId,
        documentNumber: result.documentNumber,
        isReplay: result.isReplay,
      },
    });

    invalidateWarehouseSerialIndex(req.auth.ownerId);

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (!error.status) {
      const isBiz = error.code === 'UNIT_MISMATCH' ||
        error.code === 'UNIT_CONVERSION_UNSUPPORTED' ||
        error.code === 'DUPLICATE_MEMBERS' ||
        (error.message && (
          error.message.includes('Minimal') ||
          error.message.includes('tidak dapat') ||
          error.message.includes('sudah') ||
          error.message.includes('tidak memiliki relasi') ||
          error.message.includes('gudang yang sama')
        ));
      if (isBiz) error.status = 400;
    }
    next(error);
  }
});

const ungroupSerialSchema = z.object({
  groupId: z.string().uuid().optional().nullable(),
  groupSerialNumber: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

router.post('/product-serials/ungroup', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan membongkar group serial number.');
    }

    const payload = ungroupSerialSchema.parse(req.body);
    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';

    const result = await ungroupSerial({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      userName,
      groupId: payload.groupId,
      groupSerialNumber: payload.groupSerialNumber,
      notes: payload.notes,
    });

    writeActivityLog(req, {
      action: 'deleted',
      entityType: 'Serial Group',
      entityId: result.unpackedGroup?.id,
      entityName: result.unpackedGroup?.serial_number,
      metadata: {
        releasedCount: result.releasedCount,
        releasedSerials: result.releasedSerials,
        documentId: result.documentId,
        documentNumber: result.documentNumber,
      },
    });

    invalidateWarehouseSerialIndex(req.auth.ownerId);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/product-serials/composition/:serialNumber', async (req, res, next) => {
  try {
    const serialNumber = req.params.serialNumber;
    const result = await getSerialCompositionHierarchy({
      ownerId: req.auth.ownerId,
      serialNumber,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/product-serials/groupings', async (req, res, next) => {
  try {
    const { status, limit, offset, warehouseId } = req.query;
    const result = await listSerialGroupings({
      ownerId: req.auth.ownerId,
      warehouseId: warehouseId || null,
      status: status || null,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/product-serials/groupings/:id', async (req, res, next) => {
  try {
    const result = await getSerialGroupingDetails({
      ownerId: req.auth.ownerId,
      groupingId: req.params.id,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// PHASE 7K — Grouping Sessions & Pending Confirmation Endpoints

const createGroupingSessionSchema = z.object({
  warehouseId: z.string().uuid().optional().nullable(),
  sessionName: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  isPending: z.boolean().default(true),
  batches: z.array(z.object({
    batchId: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    memberSerialIds: z.array(z.string().uuid()).optional(),
    memberSerialNumbers: z.array(z.string().trim()).optional(),
    serials: z.array(z.any()).optional(),
    groupSerialNumber: z.string().trim().optional().nullable(),
    targetProductName: z.string().trim().optional().nullable(),
    targetProductSku: z.string().trim().optional().nullable(),
    targetProductId: z.string().uuid().optional().nullable(),
    resultProductName: z.string().trim().optional().nullable(),
    resultProductSku: z.string().trim().optional().nullable(),
    resultProductId: z.string().uuid().optional().nullable(),
    createNewMasterProduct: z.boolean().optional(),
    newProductName: z.string().trim().optional().nullable(),
    newProductSku: z.string().trim().optional().nullable(),
    targetUnit: z.string().trim().optional().nullable(),
    targetQty: z.number().optional().nullable(),
    notes: z.string().trim().optional().nullable(),
    idempotencyKey: z.string().trim().optional().nullable(),
  })).min(1, 'Sesi grouping memerlukan minimal 1 batch.'),
});

router.post('/product-serials/grouping-sessions', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan membuat sesi grouping.');
    }

    const payload = createGroupingSessionSchema.parse(req.body);
    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';
    const resolvedWarehouseId = payload.warehouseId || req.auth.warehouseId;
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, resolvedWarehouseId);

    const result = await createGroupingSession({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      userName,
      warehouseId: resolvedWarehouseId,
      sessionName: payload.sessionName,
      notes: payload.notes,
      batches: payload.batches,
      isPending: payload.isPending !== false,
      customUnits: unitsCtx.units,
      unitMultipliers: unitsCtx.multipliers,
    });

    res.status(201).json({ success: true, data: result.data, isPending: result.isPending });
  } catch (error) {
    if (!error.status) error.status = 400;
    next(error);
  }
});

router.get('/product-serials/grouping-sessions', async (req, res, next) => {
  try {
    const { status, limit, offset, warehouseId } = req.query;
    const result = await listGroupingSessions({
      ownerId: req.auth.ownerId,
      warehouseId: warehouseId || null,
      status: status || null,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/product-serials/grouping-sessions/:id', async (req, res, next) => {
  try {
    const result = await getGroupingSessionDetails({
      ownerId: req.auth.ownerId,
      sessionId: req.params.id,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/product-serials/grouping-sessions/:id/confirm', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan mengonfirmasi grouping.');
    }

    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';
    const unitsCtx = await getWorkspaceUnits(req.auth.ownerId, req.auth.warehouseId);

    const result = await confirmGroupingSession({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      userName,
      sessionId: req.params.id,
      customUnits: unitsCtx.units,
      unitMultipliers: unitsCtx.multipliers,
    });

    invalidateWarehouseSerialIndex(req.auth.ownerId);

    res.json({ success: true, data: result.session, summary: result.summary, results: result.results });
  } catch (error) {
    if (!error.status) error.status = 400;
    next(error);
  }
});

router.post('/product-serials/grouping-sessions/:id/cancel', async (req, res, next) => {
  try {
    const role = (req.auth.role || '').toLowerCase();
    if (role === 'sales_person') {
      throw httpError(403, 'Akses ditolak: Sales person tidak diizinkan membatalkan sesi grouping.');
    }

    const { notes } = req.body || {};
    const result = await cancelGroupingSession({
      ownerId: req.auth.ownerId,
      userId: req.auth.user.id,
      sessionId: req.params.id,
      notes,
    });

    res.json({ success: true, data: result.data });
  } catch (error) {
    if (!error.status) error.status = 400;
    next(error);
  }
});

router.get('/product-serials/group/available', async (req, res, next) => {
  try {
    const { warehouseId, productId, search, limit } = req.query;
    const result = await getAvailableSerialsForGrouping({
      ownerId: req.auth.ownerId,
      warehouseId: warehouseId || null,
      productId: productId || null,
      search: search || null,
      limit: limit ? Number(limit) : 1000,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.use('/product-serials', crudRouter({
  table: 'product_serials',
  entityType: 'Product Serials',
  schema: productSerialSchema,
  toPayload: productSerialPayload,
  searchColumns: ['serial_number'],
  filterColumns: ['status', 'warehouse_id'],
  selectFields: 'id, product_id, serial_number, status, warehouse_id, goods_in_document_id, goods_in_item_id, goods_out_document_id, goods_out_item_id, metadata, created_at, product:products(id, name, sku, category, unit_cost, selling_price, status, metadata)',
}));

// ── Contact Points & Loyalty Endpoints ─────────────────────────
router.get('/contacts/points/balances', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('contact_points')
      .select('contact_id, balance_after, created_at')
      .eq('owner_id', req.auth.ownerId)
      .order('created_at', { ascending: false });

    if (error) throw httpError(500, 'Failed to load point balances', error.message);

    const balances = {};
    for (const row of (data || [])) {
      if (balances[row.contact_id] === undefined) {
        balances[row.contact_id] = row.balance_after;
      }
    }

    res.json({ data: balances });
  } catch (error) {
    next(error);
  }
});

router.get('/contacts/:id/points/balance', async (req, res, next) => {
  try {
    const contactId = idSchema.parse(req.params.id);
    const balance = await getContactPointBalance(contactId, req.auth.ownerId);
    res.json({
      data: {
        contactId,
        balance,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/contacts/:id/points', async (req, res, next) => {
  try {
    const contactId = idSchema.parse(req.params.id);
    const params = pagingSchema.parse(req.query);

    let query = supabaseAdmin
      .from('contact_points')
      .select('id, contact_id, document_id, type, amount, point_value, balance_after, description, metadata, created_at', { count: 'exact' })
      .eq('contact_id', contactId)
      .eq('owner_id', req.auth.ownerId)
      .order('created_at', { ascending: false });

    const { data, error, count } = await query.range(params.offset, params.offset + params.limit - 1);
    if (error) throw httpError(500, 'Failed to load contact points', error.message);

    const balance = await getContactPointBalance(contactId, req.auth.ownerId);

    res.json({
      data,
      count,
      balance,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/contacts/:id/points/adjust', async (req, res, next) => {
  try {
    const contactId = idSchema.parse(req.params.id);
    const payload = adjustPointSchema.parse(req.body);

    if (req.auth.role !== 'owner' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Hanya Owner atau Super Admin yang dapat mengubah point secara manual.');
    }

    const contact = await getRow('contacts', contactId, req.auth.ownerId);

    const currentBalance = await getContactPointBalance(contactId, req.auth.ownerId);
    const newBalance = Math.max(0, currentBalance + payload.amount);

    const { data, error } = await supabaseAdmin
      .from('contact_points')
      .insert({
        contact_id: contactId,
        type: 'adjust',
        amount: payload.amount,
        point_value: payload.pointValue ?? Math.abs(payload.amount),
        balance_after: newBalance,
        description: payload.description,
        owner_id: req.auth.ownerId,
        created_by: req.auth.user.id,
      })
      .select('*')
      .single();

    if (error) throw httpError(500, 'Failed to adjust points', error.message);

    await writeActivityLog(req, {
      action: 'adjusted_points',
      entityType: 'Contacts',
      entityId: contactId,
      entityName: contact.name,
      afterData: { adjustment: payload.amount, newBalance, reason: payload.description },
    });

    res.status(201).json({ data, balance: newBalance });
  } catch (error) {
    next(error);
  }
});

router.use('/contacts', crudRouter({
  table: 'contacts',
  entityType: 'Contacts',
  schema: contactSchema,
  toPayload: contactPayload,
  searchColumns: ['name', 'email', 'phone'],
  filterColumns: ['type'],
  selectFields: 'id, type, name, email, phone, address, city, province, status, metadata, created_at',
}));

router.use('/templates', crudRouter({
  table: 'templates',
  entityType: 'Templates',
  schema: templateSchema,
  toPayload: templatePayload,
  searchColumns: ['name', 'category'],
  filterColumns: ['category'],
  selectFields: 'id, name, category, status, is_default, is_custom, orientation, paper_size, created_at',
}));

router.get('/documents', async (req, res, next) => {
  try {
    const params = pagingSchema.parse(req.query);
    let query = supabaseAdmin
      .from('documents')
      .select('id, document_type, document_number, contact_id, contact_name, status, issue_date, due_date, payment_terms, subtotal, discount, tax, total, notes, metadata, created_at, items:document_items(*)', { count: 'exact' })
    const isOwnerOrSuperAdmin = req.auth.role === 'owner' || req.auth.role === 'super_admin';
    const queryWhId = req.query.warehouse_id || req.query.warehouseId;
    const targetWhId = isOwnerOrSuperAdmin
      ? ((queryWhId && queryWhId !== 'all') ? queryWhId : req.auth.warehouseId)
      : req.auth.warehouseId;
    if (targetWhId) {
      query = query.eq('warehouse_id', targetWhId);
    }
    query = query.order('issue_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
    if (params.status) query = query.eq('status', params.status);
    if (params.type) query = query.eq('document_type', params.type);
    if (params.search) query = query.or(`document_number.ilike.%${params.search}%,contact_name.ilike.%${params.search}%`);
    const { data, error, count } = await query.range(params.offset, params.offset + params.limit - 1);
    if (error) throw httpError(500, 'Failed to load documents', error.message);
    let result = data;

    // Supabase PostgREST hard-caps single requests to 1000 rows.
    // If client requested limit > 1000 and total count exceeds 1000, paginate remaining chunks automatically.
    if (params.limit > 1000 && count > 1000 && Array.isArray(data)) {
      let allData = [...data];
      let currentOffset = params.offset + allData.length;
      const targetTotal = Math.min(count, params.offset + params.limit);

      while (currentOffset < targetTotal) {
        const chunkSize = Math.min(1000, targetTotal - currentOffset);
        let chunkQuery = supabaseAdmin
          .from('documents')
          .select('id, document_type, document_number, contact_id, contact_name, status, issue_date, due_date, payment_terms, subtotal, discount, tax, total, notes, metadata, created_at, items:document_items(*)')
          .eq('owner_id', req.auth.ownerId);

        if (targetWhId) {
          chunkQuery = chunkQuery.eq('warehouse_id', targetWhId);
        }
        chunkQuery = chunkQuery.order('issue_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
        if (params.status) chunkQuery = chunkQuery.eq('status', params.status);
        if (params.type) chunkQuery = chunkQuery.eq('document_type', params.type);
        if (params.search) chunkQuery = chunkQuery.or(`document_number.ilike.%${params.search}%,contact_name.ilike.%${params.search}%`);

        const { data: chunkData, error: chunkErr } = await chunkQuery.range(currentOffset, currentOffset + chunkSize - 1);
        if (chunkErr || !chunkData || chunkData.length === 0) break;
        allData.push(...chunkData);
        currentOffset += chunkData.length;
        if (chunkData.length < chunkSize) break;
      }
      result = allData;
    }

    res.json({ data: result, count });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const data = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/pdf', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const data = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
    const settings = await getCompanySettings(req.auth.ownerId, data.warehouse_id || data.metadata?.warehouseId);

    let contact = {};
    if (data.contact_id) {
      try {
        contact = (await getRow('contacts', data.contact_id, req.auth.ownerId)) || {};
      } catch (_) {}
    }
    if (!contact.id && data.contact_name) {
      try {
        const { data: foundContact } = await supabaseAdmin
          .from('contacts')
          .select('*')
          .eq('owner_id', req.auth.ownerId)
          .ilike('name', data.contact_name)
          .maybeSingle();
        if (foundContact) contact = foundContact;
      } catch (_) {}
    }

    if (data.document_type === 'goods_in' || data.document_type === 'goods_out') {
      try {
        const col = data.document_type === 'goods_in' ? 'goods_in_document_id' : 'goods_out_document_id';
        const { data: serials } = await supabaseAdmin
          .from('product_serials')
          .select('id, product_id, serial_number, metadata')
          .eq('owner_id', req.auth.ownerId)
          .eq(col, data.id);
        if (serials && serials.length > 0) {
          data.serials = serials;
        }
      } catch (_) {}
    }

    const paperMode = req.query.paperMode === 'compact' ? 'compact' : 'a4';
    const pdfBuffer = generateDocumentPdf(data, settings, contact, paperMode);
    const cleanNumber = (data.document_number || 'dokumen').replace(/[/\\?%*:|"<>]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /documents/:id/email-status — status pengiriman email dokumen terakhir
// (Barang Masuk / Barang Keluar). Super ringan: 1 query indexed
// (idx_email_logs_doc: document_id, created_at DESC), select kolom minimal, limit 1.
// ---------------------------------------------------------------------------
router.get('/documents/:id/email-status', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);

    // Pastikan dokumen ada & milik tenant ini.
    await getRow('documents', id, req.auth.ownerId, 'id');

    const { data: log, error } = await fetchLatestDocumentEmailLog(
      id,
      'status, recipient_email, sent_at, error_message'
    );
    if (error) throw httpError(500, 'Failed to load email status', error.message);

    res.json({
      data: {
        status: log?.status ?? 'not_sent',
        recipient: log?.recipient_email ?? null,
        sentAt: log?.sent_at ?? null,
        errorMessage: log?.error_message ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Resolve konteks email Goods In (penerima, CC, gudang, item, subject) tanpa mengirim.
 * Dipakai bersama oleh endpoint preview & kirim manual.
 */
async function buildGoodsInEmailContext(doc, ownerId, auth) {
  const creatorEmail = auth.user?.email ?? null;
  let creatorName = auth.user?.user_metadata?.full_name || auth.user?.full_name || null;
  if (!creatorName) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', auth.user?.id)
        .maybeSingle();
      creatorName = profile?.full_name ?? creatorEmail;
    } catch (_) {}
  }

  const warehouseId = doc.warehouse_id || doc.metadata?.warehouseId;
  const companySettings = await getCompanySettings(ownerId, warehouseId);

  const financeEmail = await resolveFinanceEmail(ownerId);
  const vendorEmail = doc.contact_id
    ? await resolveContactEmailForGoodsIn(doc, ownerId)
    : doc.contact_email || null;

  let warehouseName = doc.metadata?.warehouse || 'Gudang Utama';
  if (warehouseId && (doc.metadata?.warehouse ? !doc.metadata.warehouse.startsWith('Gudang') : true)) {
    try {
      const { data: wh } = await supabaseAdmin
        .from('warehouses')
        .select('id, name, code')
        .eq('id', warehouseId)
        .maybeSingle();
      if (wh) {
        warehouseName = wh.code ? `${wh.name} (${wh.code})` : wh.name;
      }
    } catch (_) {}
  }

  const vendorName = doc.contact_name || doc.contact_id ? (doc.contact_id && (await resolveContactName(doc))) : 'Vendor';
  const subject = `[Goods In] - ${doc.document_number} dari ${vendorName}${warehouseName && warehouseName !== 'Gudang Utama' ? ` [${warehouseName}]` : ''}`;

  return {
    creatorEmail,
    creatorName,
    financeEmail,
    vendorEmail,
    vendorName,
    warehouseName,
    subject,
    companySettings,
  };
}

async function resolveContactEmailForGoodsIn(doc, ownerId) {
  try {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('id, name, email')
      .eq('id', doc.contact_id)
      .eq('owner_id', ownerId)
      .maybeSingle();
    return contact?.email ?? null;
  } catch (_) {
    return null;
  }
}

async function resolveContactName(doc) {
  try {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('name')
      .eq('id', doc.contact_id)
      .maybeSingle();
    return contact?.name ?? doc.contact_name ?? 'Vendor';
  } catch (_) {
    return doc.contact_name ?? 'Vendor';
  }
}

router.get('/documents/:id/email-preview', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const doc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
    if (doc.document_type !== 'goods_in') {
      return next(httpError(400, 'Email preview hanya tersedia untuk dokumen Barang Masuk (Goods In).'));
    }

    const ctx = await buildGoodsInEmailContext(doc, req.auth.ownerId, req.auth);
    res.json({
      data: {
        document_number: doc.document_number,
        recipient_email: ctx.financeEmail,
        cc_emails: [ctx.creatorEmail, ctx.vendorEmail].filter(Boolean),
        subject: ctx.subject,
        warehouse_name: ctx.warehouseName,
        vendor_name: ctx.vendorName,
        total_items: (doc.items || []).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Resolve konteks email Goods Out (penerima, CC, gudang, contact, subject) tanpa mengirim.
 * Duplikasi ringan dari logika di triggerGoodsOutEmailBackground, dipisah agar endpoint
 * manual resend tidak perlu menyentuh alur background existing (yang dipakai saat dokumen
 * auto-completed) dan tetap bisa di-await penuh secara sinkron oleh handler HTTP.
 */
async function buildGoodsOutEmailContext(doc, ownerId, auth) {
  const creatorEmail = auth.user?.email ?? null;
  let creatorName = auth.user?.user_metadata?.full_name || auth.user?.full_name || null;
  if (!creatorName) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', auth.user?.id)
        .maybeSingle();
      creatorName = profile?.full_name ?? creatorEmail;
    } catch (_) {}
  }

  let contactEmail = null;
  let contactData = {};
  if (doc.contact_id) {
    try {
      contactData = (await getRow('contacts', doc.contact_id, ownerId)) || {};
      contactEmail = contactData?.email ?? null;
    } catch (_) {}
  }
  if (!contactData.id && doc.contact_name) {
    try {
      const { data: foundContact } = await supabaseAdmin
        .from('contacts')
        .select('*')
        .eq('owner_id', ownerId)
        .ilike('name', doc.contact_name)
        .maybeSingle();
      if (foundContact) {
        contactData = foundContact;
        contactEmail = contactData?.email ?? null;
      }
    } catch (_) {}
  }

  const targetWarehouseId = doc.warehouse_id || doc.metadata?.warehouseId;
  let warehouseName = 'Gudang Utama';
  if (targetWarehouseId) {
    try {
      const { data: wh } = await supabaseAdmin
        .from('warehouses')
        .select('id, name, code')
        .eq('id', targetWarehouseId)
        .maybeSingle();
      if (wh) {
        warehouseName = wh.code ? `${wh.name} (${wh.code})` : wh.name;
      }
    } catch (_) {}
  } else if (doc.metadata?.warehouse) {
    warehouseName = doc.metadata.warehouse;
  }

  const companySettings = await getCompanySettings(ownerId, targetWarehouseId);
  const financeEmail = (await resolveFinanceEmail(ownerId)) || companySettings.companyEmail || null;

  return {
    creatorEmail,
    creatorName,
    financeEmail,
    contactEmail,
    contactData,
    warehouseName,
    companySettings,
  };
}

// ---------------------------------------------------------------------------
// POST /documents/:id/send-email — kirim ulang email dokumen secara manual.
// Mendukung Barang Masuk (goods_in) & Barang Keluar (goods_out).
// Vercel serverless: seluruh proses (PDF + kirim email) WAJIB di-await sebelum
// res.json() dikirim — tidak ada fire-and-forget di sini.
// Debounce: tolak resend jika email terakhir berhasil terkirim < 30 detik lalu.
// ---------------------------------------------------------------------------
/**
 * Bangun ulang PDF + kirim email dokumen (goods_in atau goods_out). Dipakai
 * bersama oleh endpoint manual resend (POST /documents/:id/send-email) dan
 * cron retry worker (GET/POST /api/cron/retry-emails), agar logika resolve
 * recipient/PDF tidak terduplikasi.
 *
 * @param {Object} doc - baris dokumen lengkap (*, items:document_items(*))
 * @param {Object} opts
 * @param {string} opts.ownerId
 * @param {string} [opts.actorUserId] - id user pemicu resend (untuk resolve nama/email creator)
 * @param {string} [opts.actorEmail]
 * @param {Object} [opts.actorMetadata]
 * @returns {Promise<{status:'sent'|'failed', error?:string, messageId?:string, subject:string}>}
 */
async function resendDocumentEmail(doc, { ownerId, actorUserId = null, actorEmail = null, actorMetadata = null } = {}) {
  const authLike = {
    user: {
      id: actorUserId,
      email: actorEmail,
      user_metadata: actorMetadata,
    },
  };

  if (doc.document_type === 'goods_in') {
    const ctx = await buildGoodsInEmailContext(doc, ownerId, authLike);

    let pdfBuffer = null;
    let contactData = {};
    if (doc.contact_id) {
      try {
        contactData = (await getRow('contacts', doc.contact_id, ownerId)) || {};
      } catch (_) {}
    }
    try {
      pdfBuffer = generateDocumentPdf(doc, ctx.companySettings, contactData);
    } catch (pdfErr) {
      console.error('[GoodsIn send-email] PDF generation failed:', pdfErr?.message ?? pdfErr);
    }

    return sendGoodsInEmail({
      doc,
      pdfBuffer,
      creatorEmail: ctx.creatorEmail,
      creatorName: ctx.creatorName,
      financeEmail: ctx.financeEmail,
      vendorEmail: ctx.vendorEmail,
      accentColor: ctx.companySettings?.accentColor,
      warehouseName: ctx.warehouseName,
      customUnits: ctx.companySettings?.custom_units,
    });
  }

  // goods_out
  const ctx = await buildGoodsOutEmailContext(doc, ownerId, authLike);

  let pdfBuffer = null;
  try {
    const docForPdf = {
      ...doc,
      metadata: {
        ...(doc.metadata || {}),
        warehouse: ctx.warehouseName,
      },
    };
    pdfBuffer = generateDocumentPdf(docForPdf, ctx.companySettings, ctx.contactData);
  } catch (pdfErr) {
    console.error('[GoodsOut send-email] PDF generation failed:', pdfErr?.message ?? pdfErr);
  }

  return sendGoodsOutEmail({
    doc,
    pdfBuffer,
    creatorEmail: ctx.creatorEmail,
    creatorName: ctx.creatorName,
    financeEmail: ctx.financeEmail,
    contactEmail: ctx.contactEmail,
    accentColor: ctx.companySettings?.accentColor,
    warehouseName: ctx.warehouseName,
    customUnits: ctx.companySettings?.custom_units,
  });
}

router.post('/documents/:id/send-email', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const doc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    if (doc.document_type !== 'goods_in' && doc.document_type !== 'goods_out') {
      return next(httpError(400, 'Kirim email hanya tersedia untuk dokumen Barang Masuk atau Barang Keluar.'));
    }
    if (doc.status !== 'completed') {
      return next(httpError(400, 'Hanya dokumen berstatus Selesai yang dapat dikirim emailnya.'));
    }

    // Debounce: cek log email terakhir untuk dokumen ini (1 query ringan, index idx_email_logs_doc).
    const { data: lastLog, error: lastLogError } = await fetchLatestDocumentEmailLog(
      id,
      'status, sent_at'
    );
    if (lastLogError) throw httpError(500, 'Failed to check last email status', lastLogError.message);

    const DEBOUNCE_MS = 30_000;
    if (lastLog?.status === 'sent' && lastLog.sent_at) {
      const elapsedMs = Date.now() - new Date(lastLog.sent_at).getTime();
      if (elapsedMs >= 0 && elapsedMs < DEBOUNCE_MS) {
        const retryAfterSec = Math.ceil((DEBOUNCE_MS - elapsedMs) / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        return next(
          httpError(429, `Email dokumen ini baru saja berhasil dikirim. Coba lagi dalam ${retryAfterSec} detik.`)
        );
      }
    }

    // WAJIB di-await: Vercel membekukan container segera setelah response
    // dikirim, jadi pengiriman email harus tuntas sebelum res.json().
    const result = await resendDocumentEmail(doc, {
      ownerId: req.auth.ownerId,
      actorUserId: req.auth.user.id,
      actorEmail: req.auth.user.email,
      actorMetadata: req.auth.user.user_metadata,
    });

    if (result.status === 'failed') {
      return res.status(502).json({ success: false, error: result.error || 'Gagal mengirim email dokumen.', data: result });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

async function triggerGoodsOutEmailBackground({ doc, ownerId, userId, userEmail, userMetadata }) {
  try {
    const creatorEmail = userEmail;
    let creatorName = userMetadata?.full_name;
    if (!creatorName) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .maybeSingle();
      creatorName = profile?.full_name ?? creatorEmail;
    }

    console.log('[GoodsOut Email] Resolving finance email for ownerId:', ownerId);
    const companyEmail = await resolveFinanceEmail(ownerId);
    console.log('[GoodsOut Email] Resolved companyEmail:', companyEmail);

    let contactEmail = null;
    let contactData = {};
    if (doc.contact_id) {
      try {
        contactData = (await getRow('contacts', doc.contact_id, ownerId)) || {};
        contactEmail = contactData?.email ?? null;
      } catch (_) {}
    }
    if (!contactData.id && doc.contact_name) {
      try {
        const { data: foundContact } = await supabaseAdmin
          .from('contacts')
          .select('*')
          .eq('owner_id', ownerId)
          .ilike('name', doc.contact_name)
          .maybeSingle();
        if (foundContact) {
          contactData = foundContact;
          contactEmail = contactData?.email ?? null;
        }
      } catch (_) {}
    }

    // Resolve Warehouse Name and Settings
    let warehouseName = 'Gudang Utama';
    const targetWarehouseId = doc.warehouse_id || doc.metadata?.warehouseId;
    if (targetWarehouseId) {
      try {
        const { data: wh } = await supabaseAdmin
          .from('warehouses')
          .select('id, name, code')
          .eq('id', targetWarehouseId)
          .maybeSingle();
        if (wh) {
          warehouseName = wh.code ? `${wh.name} (${wh.code})` : wh.name;
        }
      } catch (_) {}
    } else {
      try {
        const { data: defaultWh } = await supabaseAdmin
          .from('warehouses')
          .select('id, name, code')
          .eq('owner_id', ownerId)
          .eq('is_default', true)
          .maybeSingle();
        if (defaultWh) {
          warehouseName = defaultWh.code ? `${defaultWh.name} (${defaultWh.code})` : defaultWh.name;
        } else if (doc.metadata?.warehouse) {
          warehouseName = doc.metadata.warehouse;
        }
      } catch (_) {}
    }

    const companySettings = await getCompanySettings(ownerId, targetWarehouseId);
    console.log('[GoodsOut Email] companySettings.companyEmail:', companySettings.companyEmail);

    const finalFinanceEmail = companyEmail || companySettings.companyEmail;
    if (!finalFinanceEmail) {
      console.warn('[GoodsOut Email] WARNING: No finance/company email found for ownerId:', ownerId, '- email will not be sent.');
    }

    // Ensure doc metadata has resolved warehouse name for PDF generation
    const docForPdf = {
      ...doc,
      metadata: {
        ...(doc.metadata || {}),
        warehouse: warehouseName,
      },
    };

    let pdfBuffer = null;
    try {
      pdfBuffer = generateDocumentPdf(docForPdf, companySettings, contactData);
    } catch (pdfErr) {
      console.error('[GoodsOut bg email] PDF generation failed:', pdfErr?.message ?? pdfErr);
    }

    const emailResult = await sendGoodsOutEmail({
      doc,
      pdfBuffer,
      creatorEmail,
      creatorName,
      financeEmail: finalFinanceEmail,
      contactEmail,
      accentColor: companySettings.accentColor,
      warehouseName,
      customUnits: companySettings.custom_units,
    });

    console.log('[GoodsOut Completed Email]', emailResult?.status, 'Subject:', emailResult?.subject, 'To:', finalFinanceEmail, 'Warehouse:', warehouseName);

    // In-app notification to Owner (if submitter is not the owner)
    if (userId !== ownerId) {
      const { error: notifErr } = await supabaseAdmin.from('notifications').insert({
        owner_id: ownerId,
        user_id: ownerId,
        type: 'goods_out_completed',
        title: 'Barang Keluar Selesai',
        message: `Pengeluaran barang ${doc.document_number} dari ${warehouseName} telah diselesaikan oleh ${creatorName}.`,
        reference_id: doc.id,
        reference_type: 'document',
        is_read: false,
      });
      if (notifErr) {
        console.error('[GoodsOut notification to owner] failed to insert:', notifErr.message);
      }
    }
  } catch (bgErr) {
    console.error('[GoodsOut background email/notif] error:', bgErr?.message ?? bgErr);
  }
}

async function triggerGoodsInEmailBackground({ doc, ownerId, userId, userEmail, userMetadata }) {
  try {
    const authMock = {
      user: {
        id: userId,
        email: userEmail,
        user_metadata: userMetadata,
      },
    };
    const ctx = await buildGoodsInEmailContext(doc, ownerId, authMock);

    console.log('[GoodsIn Email] Resolving finance email for ownerId:', ownerId, ':', ctx.financeEmail);
    if (!ctx.financeEmail && !ctx.creatorEmail) {
      console.warn('[GoodsIn Email] WARNING: No finance or creator email found for ownerId:', ownerId, '- email will not be sent.');
    }

    // Attach serials if any exist in product_serials
    let docWithSerials = { ...doc };
    try {
      const { data: serials } = await supabaseAdmin
        .from('product_serials')
        .select('id, product_id, serial_number, metadata')
        .eq('owner_id', ownerId)
        .eq('goods_in_document_id', doc.id);
      if (serials && serials.length > 0) {
        docWithSerials.serials = serials;
      }
    } catch (_) {}

    // Generate PDF Bukti Barang Masuk untuk lampiran
    let pdfBuffer = null;
    let contactData = {};
    if (doc.contact_id) {
      try {
        contactData = (await getRow('contacts', doc.contact_id, ownerId)) || {};
      } catch (_) {}
    }
    if (!contactData.id && doc.contact_name) {
      try {
        const { data: foundContact } = await supabaseAdmin
          .from('contacts')
          .select('*')
          .eq('owner_id', ownerId)
          .ilike('name', doc.contact_name)
          .maybeSingle();
        if (foundContact) {
          contactData = foundContact;
        }
      } catch (_) {}
    }

    try {
      // Ensure doc metadata has resolved warehouse name for PDF generation
      const docForPdf = {
        ...docWithSerials,
        metadata: {
          ...(docWithSerials.metadata || {}),
          warehouse: ctx.warehouseName,
        },
      };
      pdfBuffer = generateDocumentPdf(docForPdf, ctx.companySettings, contactData);
    } catch (pdfErr) {
      console.error('[GoodsIn bg email] PDF generation failed:', pdfErr?.message ?? pdfErr);
    }

    const emailResult = await sendGoodsInEmail({
      doc: docWithSerials,
      pdfBuffer,
      creatorEmail: ctx.creatorEmail,
      creatorName: ctx.creatorName,
      financeEmail: ctx.financeEmail,
      vendorEmail: ctx.vendorEmail,
      accentColor: ctx.companySettings?.accentColor,
      warehouseName: ctx.warehouseName,
      customUnits: ctx.companySettings?.custom_units,
    });

    console.log('[GoodsIn Completed Email]', emailResult?.status, 'Subject:', emailResult?.subject, 'To:', ctx.financeEmail || ctx.creatorEmail, 'Warehouse:', ctx.warehouseName);

    // In-app notification to Owner (if submitter is not the owner)
    if (userId !== ownerId) {
      const { error: notifErr } = await supabaseAdmin.from('notifications').insert({
        owner_id: ownerId,
        user_id: ownerId,
        type: 'goods_in_completed',
        title: 'Barang Masuk Selesai',
        message: `Penerimaan barang ${doc.document_number} di ${ctx.warehouseName} telah diselesaikan oleh ${ctx.creatorName}.`,
        reference_id: doc.id,
        reference_type: 'document',
        is_read: false,
      });
      if (notifErr) {
        console.error('[GoodsIn notification to owner] failed to insert:', notifErr.message);
      }
    }
  } catch (bgErr) {
    console.error('[GoodsIn background email/notif] error:', bgErr?.message ?? bgErr);
  }
}

// ---------------------------------------------------------------------------
// Email notifikasi retur. Dipanggil setelah transaksi retur benar-benar
// tersimpan (commit), tidak di dalam transaksi. Status pengiriman dicatat di
// email_logs dengan email_type='return' + return_id unik agar retry tidak
// mengirim ulang email yang sudah sukses.
// ---------------------------------------------------------------------------
async function resolveReturnActorIdentity({ returnedBy, fallbackUserId, fallbackEmail, fallbackMetadata }) {
  const userId = returnedBy || fallbackUserId || null;
  let email = fallbackEmail || null;
  let name = fallbackMetadata?.full_name || null;

  if (userId) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .maybeSingle();
      if (!name && profile?.full_name) name = profile.full_name;
    } catch (_) {}

    if (!email) {
      try {
        const { data: authData, error } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (!error && authData?.user) {
          email = authData.user.email || email;
          name = name || authData.user.user_metadata?.full_name || null;
        }
      } catch (_) {}
    }
  }

  return { email, name };
}

async function buildReturnEmailContext(doc, ownerId, actor) {
  const targetWarehouseId = doc.warehouse_id || doc.metadata?.warehouseId || null;
  const companySettings = await getCompanySettings(ownerId, targetWarehouseId);
  const financeEmail = (await resolveFinanceEmail(ownerId)) || companySettings.companyEmail || null;

  let warehouseName = doc.metadata?.warehouse || 'Gudang Utama';
  if (targetWarehouseId) {
    try {
      const { data: wh } = await supabaseAdmin
        .from('warehouses')
        .select('id, name, code')
        .eq('id', targetWarehouseId)
        .maybeSingle();
      if (wh) {
        warehouseName = wh.code ? `${wh.name} (${wh.code})` : wh.name;
      }
    } catch (_) {}
  }

  let contactData = {};
  if (doc.contact_id) {
    try {
      contactData = (await getRow('contacts', doc.contact_id, ownerId)) || {};
    } catch (_) {}
  }

  return {
    financeEmail,
    creatorEmail: actor?.email || null,
    creatorName: actor?.name || actor?.email || 'Petugas',
    warehouseName,
    companySettings,
    contactData,
  };
}

/**
 * Kirim ulang / retry email retur memakai baris email_logs yang sama.
 * Diekspor untuk dipakai cron retry worker.
 */
export async function resendReturnEmail(
  doc,
  returnRecord,
  {
    ownerId,
    actorEmail = null,
    actorMetadata = null,
    existingLogId = null,
    manualRetry = false,
  } = {}
) {
  const actor = await resolveReturnActorIdentity({
    returnedBy: returnRecord?.returnedBy,
    fallbackUserId: null,
    fallbackEmail: actorEmail,
    fallbackMetadata: actorMetadata,
  });
  const ctx = await buildReturnEmailContext(doc, ownerId, actor);

  return sendReturnEmail({
    doc,
    returnRecord,
    returnNumber: returnRecord?.returnNumber || `RET-${doc.document_number || 'DOKUMEN'}`,
    creatorEmail: ctx.creatorEmail,
    creatorName: ctx.creatorName,
    financeEmail: ctx.financeEmail,
    accentColor: ctx.companySettings?.accentColor,
    warehouseName: ctx.warehouseName,
    companySettings: ctx.companySettings,
    contactData: ctx.contactData,
    existingLogId,
    manualRetry,
  });
}

async function triggerReturnEmailBackground({
  doc,
  returnRecord,
  ownerId,
  userId,
  userEmail,
  userMetadata,
}) {
  try {
    const actor = await resolveReturnActorIdentity({
      returnedBy: returnRecord?.returnedBy,
      fallbackUserId: userId,
      fallbackEmail: userEmail,
      fallbackMetadata: userMetadata,
    });
    const ctx = await buildReturnEmailContext(doc, ownerId, actor);

    if (!ctx.financeEmail && !ctx.creatorEmail) {
      console.warn('[Return Email] No finance/actor email found for ownerId:', ownerId, '- email will not be sent.');
    }

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      returnNumber: returnRecord?.returnNumber || `RET-${doc.document_number || 'DOKUMEN'}`,
      creatorEmail: ctx.creatorEmail,
      creatorName: ctx.creatorName,
      financeEmail: ctx.financeEmail,
      accentColor: ctx.companySettings?.accentColor,
      warehouseName: ctx.warehouseName,
      companySettings: ctx.companySettings,
      contactData: ctx.contactData,
    });

    console.log(
      '[Return Email]',
      result?.status,
      'Return:',
      returnRecord?.returnNumber || returnRecord?.id,
      'To:',
      ctx.financeEmail || ctx.creatorEmail,
      'Warehouse:',
      ctx.warehouseName
    );
  } catch (bgErr) {
    console.error('[Return background email] error:', bgErr?.message ?? bgErr);
  }
}

router.post('/documents', async (req, res, next) => {
  try {
    const payload = documentSchema.parse(req.body);

    // Strict Validation for Goods Out serial numbers (only when finalizing / not draft)
    if (payload.documentType === 'goods_out' && payload.status !== 'draft') {
      const seenSerials = new Set();
      for (const item of payload.items || []) {
        const isSerial = item.metadata?.isSerial === true;
        const sn = String(item.metadata?.serialNumber || '').trim();
        if (isSerial && sn) {
          const snKey = sn.toLowerCase();
          if (seenSerials.has(snKey)) {
            throw httpError(400, `Nomor seri "${sn}" duplikat! Tidak boleh mengeluarkan nomor seri yang sama lebih dari satu kali.`);
          }
          seenSerials.add(snKey);

          // Check DB for serial status
          const { data: foundSerial } = await supabaseAdmin
            .from('product_serials')
            .select('id, status, serial_number, metadata')
            .eq('owner_id', req.auth.ownerId)
            .in('serial_number', serialVariants(sn))
            .maybeSingle();

          if (!foundSerial) {
            throw httpError(400, `Nomor seri "${sn}" tidak ditemukan dalam sistem.`);
          }
          if (foundSerial.metadata?.isGrouped || foundSerial.metadata?.parentGroupId) {
            throw httpError(400, `Nomor seri "${sn}" sedang berada di dalam group "${foundSerial.metadata?.parentGroupSerialNumber || 'Group'}". Group induk paling atas harus dibongkar (ungroup) terlebih dahulu sebelum dapat dikeluarkan.`);
          }
          if (foundSerial.metadata?.isDissolved) {
            throw httpError(400, `Nomor seri "${sn}" adalah group yang sudah dibongkar (dissolved) dan tidak dapat dikeluarkan.`);
          }
          if (foundSerial.status !== 'available') {
            throw httpError(400, `Nomor seri "${sn}" tidak tersedia atau sudah pernah dikeluarkan (status: ${foundSerial.status}).`);
          }
        }
      }
    }

    let docNumber = payload.documentNumber;
    let insertResult = await supabaseAdmin
      .from('documents')
      .insert({
        ...documentPayload({ ...payload, documentNumber: docNumber }),
        created_by: req.auth.user.id,
        owner_id: req.auth.ownerId,
        warehouse_id: req.auth.warehouseId,
      })
      .select('*')
      .single();

    // If duplicate document number, query max sequence for prefix and auto-increment
    if (insertResult.error && (insertResult.error.code === '23505' || String(insertResult.error.message).includes('unique'))) {
      const match = docNumber.match(/^(.*?)(\d+)$/);
      if (match) {
        let prefix = match[1];
        let numStr = match[2];
        let padLen = numStr.length;

        // If numStr is a combined Date+Seq (e.g. 202610200001 with 8-digit YYYYMMDD or 6-digit YYMMDD):
        // split into actual prefix (including date) and trailing sequence (last 3-4 digits)
        if (numStr.length > 5) {
          if (/^20\d{6}/.test(numStr)) {
            prefix = prefix + numStr.slice(0, 8);
            numStr = numStr.slice(8);
            padLen = numStr.length;
          } else if (/^\d{6}/.test(numStr) && numStr.length <= 10) {
            prefix = prefix + numStr.slice(0, 6);
            numStr = numStr.slice(6);
            padLen = numStr.length;
          }
        }

        // Query documents matching this prefix for the owner to find the true max sequence
        const { data: existingRows } = await supabaseAdmin
          .from('documents')
          .select('document_number')
          .eq('owner_id', req.auth.ownerId)
          .ilike('document_number', `${prefix}%`)
          .order('document_number', { ascending: false })
          .limit(100);

        let maxSeq = parseInt(numStr, 10) || 0;
        if (maxSeq >= 100000) maxSeq = 0;

        if (existingRows && existingRows.length > 0) {
          for (const row of existingRows) {
            const rowNum = String(row.document_number || '').trim();
            if (!rowNum.startsWith(prefix) || rowNum.includes('e+') || rowNum.includes('NaN')) continue;
            const suffix = rowNum.slice(prefix.length).trim();
            const m = suffix.match(/^(\d+)/);
            if (m) {
              const val = parseInt(m[1], 10);
              if (!isNaN(val) && val < 100000 && val > maxSeq) {
                maxSeq = val;
              }
            }
          }
        }

        for (let attempt = 1; attempt <= 30; attempt++) {
          const nextSeq = maxSeq + attempt;
          docNumber = `${prefix}${String(nextSeq).padStart(padLen, '0')}`;

          insertResult = await supabaseAdmin
            .from('documents')
            .insert({
              ...documentPayload({ ...payload, documentNumber: docNumber }),
              created_by: req.auth.user.id,
              owner_id: req.auth.ownerId,
              warehouse_id: req.auth.warehouseId,
            })
            .select('*')
            .single();

          if (!insertResult.error) break;
        }
      } else {
        for (let attempt = 1; attempt <= 10; attempt++) {
          docNumber = `${payload.documentNumber}-${attempt}`;
          insertResult = await supabaseAdmin
            .from('documents')
            .insert({
              ...documentPayload({ ...payload, documentNumber: docNumber }),
              created_by: req.auth.user.id,
              owner_id: req.auth.ownerId,
              warehouse_id: req.auth.warehouseId,
            })
            .select('*')
            .single();

          if (!insertResult.error) break;
        }
      }

      // Final safety net if still unique collision
      if (insertResult.error && (insertResult.error.code === '23505' || String(insertResult.error.message).includes('unique'))) {
        docNumber = `${payload.documentNumber}-${Date.now().toString(36).toUpperCase()}`;
        insertResult = await supabaseAdmin
          .from('documents')
          .insert({
            ...documentPayload({ ...payload, documentNumber: docNumber }),
            created_by: req.auth.user.id,
            owner_id: req.auth.ownerId,
            warehouse_id: req.auth.warehouseId,
          })
          .select('*')
          .single();
      }
    }

    if (insertResult.error) {
      throw httpError(400, `Gagal membuat dokumen (${payload.documentNumber}): ${insertResult.error.message}`);
    }
    const document = insertResult.data;

    let insertedItems = [];
    if (payload.items.length) {
      // Reconcile grouped result serial quantities & units authoritatively from DB metadata for goods_out
      if (payload.documentType === 'goods_out') {
        const { multipliers: wsUnitsMultipliers } = await getWorkspaceUnits(req.auth.ownerId, payload.warehouse_id || payload.metadata?.warehouseId);
        for (const item of payload.items) {
          if (item.metadata?.isSerial === true && item.metadata?.serialNumber) {
            const sn = String(item.metadata.serialNumber).trim();
            const { data: sRec } = await supabaseAdmin
              .from('product_serials')
              .select('id, metadata')
              .eq('owner_id', req.auth.ownerId)
              .in('serial_number', serialVariants(sn))
              .maybeSingle();

            if (sRec?.metadata?.isGroup) {
              const groupTargetQty = Number(sRec.metadata.targetQty ?? sRec.metadata.unitQty ?? 1);
              const groupTargetUnit = sRec.metadata.targetUnit || item.metadata?.qtyUnit || 'pcs';
              const groupMult = wsUnitsMultipliers[groupTargetUnit] || 1;
              const groupTotalPcs = Number(sRec.metadata.totalPcs ?? (groupTargetQty * groupMult));

              item.metadata = {
                ...(item.metadata || {}),
                isGroup: true,
                targetQty: groupTargetQty,
                targetUnit: groupTargetUnit,
                totalPcs: groupTotalPcs,
                qtyInput: item.metadata?.qtyInput && item.metadata.qtyInput > 1 ? item.metadata.qtyInput : groupTargetQty,
                qtyUnit: item.metadata?.qtyUnit && item.metadata.qtyUnit !== 'pcs' ? item.metadata.qtyUnit : groupTargetUnit,
                unitMultiplier: groupMult,
                baseQuantity: item.quantity && item.quantity > 1 ? item.quantity : groupTotalPcs,
                resultProductId: sRec.metadata?.resultProductId ?? item.metadata?.resultProductId ?? null,
                resultProductName: sRec.metadata?.resultProductName ?? item.metadata?.resultProductName ?? null,
                resultProductSku: sRec.metadata?.resultProductSku ?? item.metadata?.resultProductSku ?? null,
              };
              if (!item.quantity || item.quantity === 1) {
                item.quantity = groupTotalPcs;
              }
            }
          }
        }
      }

      const { data: createdItems, error: itemsError } = await supabaseAdmin
        .from('document_items')
        .insert(payload.items.map((item) => documentItemPayload(document.id, item)))
        .select('*');
      if (itemsError) throw httpError(500, 'Failed to create document items', itemsError.message);
      insertedItems = createdItems || [];
    }

    // Update serial status and deduct non-serial stock for goods_out documents (only when completed, not draft)
    if (payload.documentType === 'goods_out' && payload.status === 'completed') {
      try {
        // 1. Link serials to document and document_items
        for (const item of insertedItems) {
          const isSerial = item.metadata?.isSerial === true;
          const sn = String(item.metadata?.serialNumber || '').trim();
          if (isSerial && sn) {
            const { data: updatedSerials } = await supabaseAdmin
              .from('product_serials')
              .update({
                status: 'out',
                goods_out_document_id: document.id,
                goods_out_item_id: item.id,
              })
              .eq('owner_id', req.auth.ownerId)
              .in('serial_number', serialVariants(sn))
              .select('id, metadata');

            // Jika serial yang dikeluarkan adalah group, perbarui seluruh leaf serials & direct members di dalamnya menjadi out
            if (updatedSerials && updatedSerials.length > 0) {
              for (const s of updatedSerials) {
                if (s.metadata?.isGroup) {
                  const memberIds = [
                    ...(Array.isArray(s.metadata?.composition) ? s.metadata.composition.map((c) => c.serialId || c.id) : []),
                    ...(Array.isArray(s.metadata?.directMembers) ? s.metadata.directMembers.map((m) => m.serialId || m.id) : []),
                  ].filter(Boolean);
                  if (memberIds.length > 0) {
                    await supabaseAdmin
                      .from('product_serials')
                      .update({
                        status: 'out',
                        goods_out_document_id: document.id,
                        goods_out_item_id: item.id,
                      })
                      .eq('owner_id', req.auth.ownerId)
                      .in('id', memberIds);
                  }
                }
              }
            }
          }
        }

        // 2. Deduct non-serial stock
        const { multipliers } = await getWorkspaceUnits(req.auth.ownerId, payload.warehouse_id || payload.metadata?.warehouseId);

        for (const item of payload.items || []) {
          const isUnrec = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
          if (item.productId && item.metadata?.isSerial !== true && !isUnrec) {
            const unit = item.metadata?.qtyUnit || item.unit || 'pcs';
            const mult = multipliers[unit] || 1;
            const deductedQty = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;

            const { data: prod } = await supabaseAdmin
              .from('products')
              .select('metadata, stock')
              .eq('id', item.productId)
              .eq('owner_id', req.auth.ownerId)
              .maybeSingle();

            if (prod) {
              const currentNonSerial = Number(prod.metadata?.stockNonSerial ?? prod.stock ?? 0);
              const currentTotal = Number(prod.stock ?? 0);
              await supabaseAdmin
                .from('products')
                .update({
                  stock: Math.max(0, currentTotal - deductedQty),
                  metadata: {
                    ...(prod.metadata || {}),
                    stockNonSerial: Math.max(0, currentNonSerial - deductedQty),
                  },
                })
                .eq('id', item.productId)
                .eq('owner_id', req.auth.ownerId);
            }
          }
        }

        // 3. If this Goods Out is fulfilling a Purchase Order, update PO status to 'fulfilled' ONLY if document status is 'completed'
        const sourcePoId = payload.metadata?.source_po_id || payload.metadata?.sourcePoId;
        if (sourcePoId && payload.status === 'completed') {
          const { data: updatedPo, error: updatePoErr } = await supabaseAdmin
            .from('purchase_orders')
            .update({
              status: 'fulfilled',
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourcePoId)
            .eq('owner_id', req.auth.ownerId)
            .select('id, po_number, sales_person_id')
            .maybeSingle();

          if (!updatePoErr && updatedPo && updatedPo.sales_person_id) {
            await supabaseAdmin.from('notifications').insert({
              owner_id: req.auth.ownerId,
              user_id: updatedPo.sales_person_id,
              type: 'po_fulfilled',
              title: 'Barang PO Telah Dikeluarkan',
              message: `Barang untuk Purchase Order ${updatedPo.po_number} telah berhasil dikeluarkan dengan Surat Jalan ${document.document_number}.`,
              reference_id: updatedPo.id,
              reference_type: 'purchase_order',
              is_read: false,
            });
          }
        }
      } catch (postProcessErr) {
        console.error('[GoodsOut POST /documents] Post-processing error:', postProcessErr);
      }
    }

    const data = await getRow('documents', document.id, req.auth.ownerId, '*, items:document_items(*)');
    await writeActivityLog(req, { action: 'created', entityType: 'Documents', entityId: data.id, entityName: data.document_number, afterData: data });
    
    // Process Points Loyalty (Earn / Redeem) jika ada contactId dan dokumen invoice
    if (payload.contactId && payload.documentType === 'invoice') {
      try {
        const metaPoints = payload.metadata?.points || {};
        const earnPoints = Number(metaPoints.earned?.amount || payload.metadata?.earnPoints || 0);
        const earnVal = Number(metaPoints.earned?.pointValue || earnPoints);

        if (earnPoints > 0) {
          const currentBal = await getContactPointBalance(payload.contactId, req.auth.ownerId);
          const newBal = currentBal + earnPoints;
          await supabaseAdmin.from('contact_points').insert({
            contact_id: payload.contactId,
            document_id: document.id,
            type: 'earn',
            amount: earnPoints,
            point_value: earnVal,
            balance_after: newBal,
            description: `Cashback Point dari ${document.document_number}`,
            metadata: metaPoints.earned || {},
            owner_id: req.auth.ownerId,
            created_by: req.auth.user.id,
          });
        }

        const redeemPoints = Number(metaPoints.redeemed?.amount || payload.metadata?.redeemPoints || 0);
        const redeemVal = Number(metaPoints.redeemed?.pointValue || redeemPoints);

        if (redeemPoints > 0) {
          const currentBal = await getContactPointBalance(payload.contactId, req.auth.ownerId);
          const newBal = Math.max(0, currentBal - redeemPoints);
          await supabaseAdmin.from('contact_points').insert({
            contact_id: payload.contactId,
            document_id: document.id,
            type: 'redeem',
            amount: -redeemPoints,
            point_value: -redeemVal,
            balance_after: newBal,
            description: `Penggunaan ${redeemPoints} Point pada ${document.document_number}`,
            metadata: metaPoints.redeemed || {},
            owner_id: req.auth.ownerId,
            created_by: req.auth.user.id,
          });
        }
      } catch (ptErr) {
        console.error('[Points] Failed to process points on create document:', ptErr);
      }
    }

    // Hanya kirim email jika dokumen langsung berstatus 'completed' (tidak dikirim saat 'processing' / draft)
    if (payload.documentType === 'goods_out' && data.status === 'completed') {
      try {
        await triggerGoodsOutEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsOut POST /documents] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    } else if (payload.documentType === 'goods_in' && data.status === 'completed') {
      try {
        await triggerGoodsInEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsIn POST /documents] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    }

    res.status(201).json({ data });
  } catch (error) {
    next(error);
  }
});

async function revertDocumentStockAndSerials(doc, ownerId) {
  if (!doc) return;
  const { multipliers } = await getWorkspaceUnits(ownerId, doc.warehouse_id || doc.metadata?.warehouseId);
  const items = doc.items ?? [];

  if (doc.document_type === 'goods_in') {
    // Determine serial items from product_serials
    const { data: docSerials } = await supabaseAdmin
      .from('product_serials')
      .select('id, goods_in_item_id, product_id')
      .eq('goods_in_document_id', doc.id)
      .eq('owner_id', ownerId);

    const serialItemIds = new Set((docSerials || []).map((s) => s.goods_in_item_id).filter(Boolean));
    const serialProductIds = new Set((docSerials || []).map((s) => s.product_id).filter(Boolean));

    // Revert non-serial stock received (subtract stock)
    for (const item of items) {
      if (item.product_id) {
        const isSerial = item.metadata?.isSerial === true ||
          item.metadata?.trackingMode === 'serial' ||
          serialItemIds.has(item.id) ||
          serialProductIds.has(item.product_id);
        if (!isSerial) {
          const unit = item.metadata?.qtyUnit || item.unit || 'pcs';
          const mult = multipliers[unit] || 1;
          const qtyInPcs = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;

          const { data: prod } = await supabaseAdmin
            .from('products')
            .select('metadata, stock')
            .eq('id', item.product_id)
            .eq('owner_id', ownerId)
            .maybeSingle();

          if (prod) {
            const currentStock = Number(prod.metadata?.stockNonSerial ?? prod.stock ?? 0);
            await supabaseAdmin
              .from('products')
              .update({
                metadata: {
                  ...(prod.metadata || {}),
                  stockNonSerial: Math.max(0, currentStock - qtyInPcs),
                },
              })
              .eq('id', item.product_id)
              .eq('owner_id', ownerId);
          }
        }
      }
    }

    // Delete serials created by this Goods In document (if not already dispatched)
    await supabaseAdmin
      .from('product_serials')
      .delete()
      .eq('goods_in_document_id', doc.id)
      .eq('owner_id', ownerId)
      .neq('status', 'out');
  } else if (doc.document_type === 'goods_out') {
    // Revert stock dispatched (add stock back)
    for (const item of items) {
      if (item.product_id) {
        const isSerial = item.metadata?.isSerial === true;
        const unit = item.metadata?.qtyUnit || item.unit || 'pcs';
        const mult = multipliers[unit] || 1;
        const qtyInPcs = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;

        const { data: prod } = await supabaseAdmin
          .from('products')
          .select('metadata, stock')
          .eq('id', item.product_id)
          .eq('owner_id', ownerId)
          .maybeSingle();

        if (prod) {
          const currentTotal = Number(prod.stock ?? 0);
          const currentNonSerial = Number(prod.metadata?.stockNonSerial ?? prod.stock ?? 0);
          const currentSerials = Number(prod.metadata?.stockSerials ?? 0);

          await supabaseAdmin
            .from('products')
            .update({
              stock: currentTotal + qtyInPcs,
              metadata: {
                ...(prod.metadata || {}),
                stockNonSerial: !isSerial ? currentNonSerial + qtyInPcs : currentNonSerial,
                stockSerials: isSerial ? currentSerials + qtyInPcs : currentSerials,
              },
            })
            .eq('id', item.product_id)
            .eq('owner_id', ownerId);
        }
      }
    }

    // Restore serials released by this Goods Out document back to 'available'
    // 1. By goods_out_document_id
    await supabaseAdmin
      .from('product_serials')
      .update({
        status: 'available',
        goods_out_document_id: null,
        goods_out_item_id: null,
      })
      .eq('goods_out_document_id', doc.id)
      .eq('owner_id', ownerId);

    // 2. Also check serial numbers in document items in case goods_out_document_id link was unset
    const serialNumbers = items
      .filter((it) => it.metadata?.isSerial === true && it.metadata?.serialNumber)
      .map((it) => String(it.metadata.serialNumber).trim());

    if (serialNumbers.length > 0) {
      const { data: matchedSerials } = await supabaseAdmin
        .from('product_serials')
        .select('id, metadata')
        .in('serial_number', serialNumbers)
        .eq('owner_id', ownerId)
        .eq('status', 'out');

      const allIdsToRestore = new Set((matchedSerials || []).map((s) => s.id));
      for (const s of matchedSerials || []) {
        if (s.metadata?.isGroup) {
          const memberIds = [
            ...(Array.isArray(s.metadata?.composition) ? s.metadata.composition.map((c) => c.serialId || c.id) : []),
            ...(Array.isArray(s.metadata?.directMembers) ? s.metadata.directMembers.map((m) => m.serialId || m.id) : []),
          ].filter(Boolean);
          memberIds.forEach((mId) => allIdsToRestore.add(mId));
        }
      }

      if (allIdsToRestore.size > 0) {
        await supabaseAdmin
          .from('product_serials')
          .update({
            status: 'available',
            goods_out_document_id: null,
            goods_out_item_id: null,
          })
          .in('id', Array.from(allIdsToRestore))
          .eq('owner_id', ownerId)
          .eq('status', 'out');
      }
    }

    // Invalidate in-memory serial lookup cache
    SERIAL_CACHE.clear();
  }
}

router.patch('/documents/:id', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const beforeData = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
    const payload = documentSchema.partial({ items: true }).parse(req.body);

    // Revert stock and release serial numbers if document is being cancelled
    if (payload.status === 'cancelled' && beforeData.status !== 'cancelled') {
      try {
        await revertDocumentStockAndSerials(beforeData, req.auth.ownerId);
      } catch (revErr) {
        console.error('[Revert Stock/Serials] Failed to revert on cancel:', revErr);
      }
    }

    // Reconcile serials for Goods Out documents when items are updated
    if (beforeData.document_type === 'goods_out' && payload.items && payload.status !== 'cancelled') {
      const newSerialNumbers = new Set();
      for (const item of payload.items || []) {
        const isSerial = item.metadata?.isSerial === true;
        const sn = String(item.metadata?.serialNumber || '').trim();
        if (isSerial && sn) {
          const snKey = sn.toLowerCase();
          if (newSerialNumbers.has(snKey)) {
            throw httpError(400, `Nomor seri "${sn}" duplikat! Tidak boleh mengeluarkan nomor seri yang sama lebih dari satu kali.`);
          }
          newSerialNumbers.add(snKey);
        }
      }

      // 1. Fetch serials currently assigned to this goods_out document
      const { data: currentLinkedSerials } = await supabaseAdmin
        .from('product_serials')
        .select('id, serial_number, status')
        .eq('goods_out_document_id', id)
        .eq('owner_id', req.auth.ownerId);

      const currentLinkedMap = new Map();
      (currentLinkedSerials || []).forEach((s) => {
        if (s.serial_number) currentLinkedMap.set(s.serial_number.trim().toLowerCase(), s);
      });

      // Also ensure serials recorded in beforeData.items are recognized as belonging to this doc
      const beforeSerialNumbers = (beforeData.items || [])
        .filter((it) => it.metadata?.isSerial === true && it.metadata?.serialNumber)
        .map((it) => String(it.metadata.serialNumber).trim().toLowerCase());

      const unmappedBeforeSerials = beforeSerialNumbers.filter((sn) => !currentLinkedMap.has(sn));
      if (unmappedBeforeSerials.length > 0) {
        const { data: dbBeforeSerials } = await supabaseAdmin
          .from('product_serials')
          .select('id, serial_number, status')
          .eq('owner_id', req.auth.ownerId)
          .in('serial_number', unmappedBeforeSerials);
        (dbBeforeSerials || []).forEach((s) => {
          if (s.serial_number) currentLinkedMap.set(s.serial_number.trim().toLowerCase(), s);
        });
      }

      // 2. Serials to release (in currentLinkedMap but NOT in newSerialNumbers)
      const serialsToRelease = [];
      currentLinkedMap.forEach((s, snKey) => {
        if (!newSerialNumbers.has(snKey)) {
          serialsToRelease.push(s.id);
        }
      });

      if (serialsToRelease.length > 0) {
        const { data: relSerials } = await supabaseAdmin
          .from('product_serials')
          .select('id, metadata')
          .in('id', serialsToRelease)
          .eq('owner_id', req.auth.ownerId);

        const allIdsToRelease = new Set(serialsToRelease);
        for (const s of relSerials || []) {
          if (s.metadata?.isGroup) {
            const memberIds = [
              ...(Array.isArray(s.metadata?.composition) ? s.metadata.composition.map((c) => c.serialId || c.id) : []),
              ...(Array.isArray(s.metadata?.directMembers) ? s.metadata.directMembers.map((m) => m.serialId || m.id) : []),
            ].filter(Boolean);
            memberIds.forEach((mId) => allIdsToRelease.add(mId));
          }
        }

        await supabaseAdmin
          .from('product_serials')
          .update({
            status: 'available',
            goods_out_document_id: null,
            goods_out_item_id: null,
          })
          .in('id', Array.from(allIdsToRelease))
          .eq('owner_id', req.auth.ownerId);
      }

      // 3. Serials to assign (in newSerialNumbers but NOT in currentLinkedMap)
      for (const snKey of newSerialNumbers) {
        if (!currentLinkedMap.has(snKey)) {
          const { data: foundSerial } = await supabaseAdmin
            .from('product_serials')
            .select('id, status, serial_number, goods_out_document_id, metadata')
            .eq('owner_id', req.auth.ownerId)
            .in('serial_number', serialVariants(snKey))
            .maybeSingle();

          if (!foundSerial) {
            throw httpError(400, `Nomor seri "${snKey}" tidak ditemukan dalam sistem.`);
          }
          if (foundSerial.metadata?.isGrouped || foundSerial.metadata?.parentGroupId) {
            throw httpError(400, `Nomor seri "${snKey}" sedang berada di dalam group "${foundSerial.metadata?.parentGroupSerialNumber || 'Group'}". Group induk paling atas harus dibongkar (ungroup) terlebih dahulu sebelum dapat dikeluarkan.`);
          }
          if (foundSerial.metadata?.isDissolved) {
            throw httpError(400, `Nomor seri "${snKey}" adalah group yang sudah dibongkar (dissolved) dan tidak dapat dikeluarkan.`);
          }
          if (foundSerial.status !== 'available' && foundSerial.goods_out_document_id !== id) {
            throw httpError(400, `Nomor seri "${snKey}" tidak tersedia atau sudah pernah dikeluarkan (status: ${foundSerial.status}).`);
          }

          await supabaseAdmin
            .from('product_serials')
            .update({
              status: 'out',
              goods_out_document_id: id,
            })
            .eq('id', foundSerial.id)
            .eq('owner_id', req.auth.ownerId);

          if (foundSerial.metadata?.isGroup) {
            const memberIds = [
              ...(Array.isArray(foundSerial.metadata?.composition) ? foundSerial.metadata.composition.map((c) => c.serialId || c.id) : []),
              ...(Array.isArray(foundSerial.metadata?.directMembers) ? foundSerial.metadata.directMembers.map((m) => m.serialId || m.id) : []),
            ].filter(Boolean);
            if (memberIds.length > 0) {
              await supabaseAdmin
                .from('product_serials')
                .update({
                  status: 'out',
                  goods_out_document_id: id,
                })
                .eq('owner_id', req.auth.ownerId)
                .in('id', memberIds);
            }
          }
        }
      }

      // 4. Reconcile non-serial stock difference
      const { multipliers } = await getWorkspaceUnits(req.auth.ownerId, beforeData.warehouse_id || beforeData.metadata?.warehouseId);

      const oldStockDeductions = {};
      for (const item of beforeData.items || []) {
        if (item.product_id && item.metadata?.isSerial !== true) {
          const unit = item.metadata?.qtyUnit || item.unit || 'pcs';
          const mult = multipliers[unit] || 1;
          const qtyInPcs = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;
          oldStockDeductions[item.product_id] = (oldStockDeductions[item.product_id] || 0) + qtyInPcs;
        }
      }

      const newStockDeductions = {};
      for (const item of payload.items || []) {
        if (item.productId && item.metadata?.isSerial !== true) {
          const unit = item.metadata?.qtyUnit || 'pcs';
          const mult = multipliers[unit] || 1;
          const qtyInPcs = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;
          newStockDeductions[item.productId] = (newStockDeductions[item.productId] || 0) + qtyInPcs;
        }
      }

      const allProductIds = new Set([
        ...Object.keys(oldStockDeductions),
        ...Object.keys(newStockDeductions),
      ]);

      for (const prodId of allProductIds) {
        const oldQty = oldStockDeductions[prodId] || 0;
        const newQty = newStockDeductions[prodId] || 0;
        const diff = newQty - oldQty;

        if (diff !== 0) {
          const { data: prod } = await supabaseAdmin
            .from('products')
            .select('metadata, stock')
            .eq('id', prodId)
            .eq('owner_id', req.auth.ownerId)
            .maybeSingle();

          if (prod) {
            const currentNonSerial = Number(prod.metadata?.stockNonSerial ?? prod.stock ?? 0);
            const currentTotal = Number(prod.stock ?? 0);
            const newNonSerial = Math.max(0, currentNonSerial - diff);
            const newTotal = Math.max(0, currentTotal - diff);

            await supabaseAdmin
              .from('products')
              .update({
                stock: newTotal,
                metadata: {
                  ...(prod.metadata || {}),
                  stockNonSerial: newNonSerial,
                },
              })
              .eq('id', prodId)
              .eq('owner_id', req.auth.ownerId);
          }
        }
      }
    }

    const mergedMetadata = {
      ...(beforeData.metadata || {}),
      ...(payload.metadata || {}),
    };

    const { data: document, error } = await supabaseAdmin
      .from('documents')
      .update(documentPayload({ ...payload, metadata: mergedMetadata }))
      .eq('id', id)
      .eq('owner_id', req.auth.ownerId)
      .select('*')
      .single();
    if (error) throw httpError(500, 'Failed to update document', error.message);

    if (payload.items) {
      // Reconcile grouped result serial quantities & units authoritatively from DB metadata for goods_out
      if (beforeData.document_type === 'goods_out') {
        const { multipliers: wsUnitsMultipliers } = await getWorkspaceUnits(req.auth.ownerId, beforeData.warehouse_id || beforeData.metadata?.warehouseId);
        for (const item of payload.items) {
          if (item.metadata?.isSerial === true && item.metadata?.serialNumber) {
            const sn = String(item.metadata.serialNumber).trim();
            const { data: sRec } = await supabaseAdmin
              .from('product_serials')
              .select('id, metadata')
              .eq('owner_id', req.auth.ownerId)
              .in('serial_number', serialVariants(sn))
              .maybeSingle();

            if (sRec?.metadata?.isGroup) {
              const groupTargetQty = Number(sRec.metadata.targetQty ?? sRec.metadata.unitQty ?? 1);
              const groupTargetUnit = sRec.metadata.targetUnit || item.metadata?.qtyUnit || 'pcs';
              const groupMult = wsUnitsMultipliers[groupTargetUnit] || 1;
              const groupTotalPcs = Number(sRec.metadata.totalPcs ?? (groupTargetQty * groupMult));

              item.metadata = {
                ...(item.metadata || {}),
                isGroup: true,
                targetQty: groupTargetQty,
                targetUnit: groupTargetUnit,
                totalPcs: groupTotalPcs,
                qtyInput: item.metadata?.qtyInput && item.metadata.qtyInput > 1 ? item.metadata.qtyInput : groupTargetQty,
                qtyUnit: item.metadata?.qtyUnit && item.metadata.qtyUnit !== 'pcs' ? item.metadata.qtyUnit : groupTargetUnit,
                unitMultiplier: groupMult,
                baseQuantity: item.quantity && item.quantity > 1 ? item.quantity : groupTotalPcs,
                resultProductId: sRec.metadata?.resultProductId ?? item.metadata?.resultProductId ?? null,
                resultProductName: sRec.metadata?.resultProductName ?? item.metadata?.resultProductName ?? null,
                resultProductSku: sRec.metadata?.resultProductSku ?? item.metadata?.resultProductSku ?? null,
              };
              if (!item.quantity || item.quantity === 1) {
                item.quantity = groupTotalPcs;
              }
            }
          }
        }
      }

      const { error: deleteError } = await supabaseAdmin.from('document_items').delete().eq('document_id', id);
      if (deleteError) throw httpError(500, 'Failed to replace document items', deleteError.message);
      if (payload.items.length) {
        const { data: insertedItems, error: insertError } = await supabaseAdmin
          .from('document_items')
          .insert(payload.items.map((item) => documentItemPayload(id, item)))
          .select('*');
        if (insertError) throw httpError(500, 'Failed to save document items', insertError.message);

        // Link goods_out_item_id to product_serials
        if (beforeData.document_type === 'goods_out' && payload.status !== 'cancelled') {
          for (const item of insertedItems || []) {
            if (item.metadata?.isSerial === true && item.metadata?.serialNumber) {
              const sn = String(item.metadata.serialNumber).trim();
              const { data: updatedSerials } = await supabaseAdmin
                .from('product_serials')
                .update({
                  status: 'out',
                  goods_out_document_id: id,
                  goods_out_item_id: item.id,
                })
                .eq('owner_id', req.auth.ownerId)
                .in('serial_number', serialVariants(sn))
                .select('id, metadata');

              if (updatedSerials && updatedSerials.length > 0) {
                for (const s of updatedSerials) {
                  if (s.metadata?.isGroup) {
                    const memberIds = [
                      ...(Array.isArray(s.metadata?.composition) ? s.metadata.composition.map((c) => c.serialId || c.id) : []),
                      ...(Array.isArray(s.metadata?.directMembers) ? s.metadata.directMembers.map((m) => m.serialId || m.id) : []),
                    ].filter(Boolean);
                    if (memberIds.length > 0) {
                      await supabaseAdmin
                        .from('product_serials')
                        .update({
                          status: 'out',
                          goods_out_document_id: id,
                          goods_out_item_id: item.id,
                        })
                        .eq('owner_id', req.auth.ownerId)
                        .in('id', memberIds);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    const data = await getRow('documents', document.id, req.auth.ownerId, '*, items:document_items(*)');
    await writeActivityLog(req, { action: 'updated', entityType: 'Documents', entityId: id, entityName: data.document_number, beforeData, afterData: data });
    
    // Process points (earn cashback / redeem points) reconciliation on update
    if (payload.metadata?.points !== undefined || payload.contactId) {
      try {
        const activeContactId = payload.contactId || beforeData.contact_id;
        const metaPoints = payload.metadata?.points || {};
        const earnPoints = Number(metaPoints.earned?.amount || 0);
        const earnVal = Number(metaPoints.earned?.pointValue || earnPoints);
        const redeemPoints = Number(metaPoints.redeemed?.amount || 0);
        const redeemVal = Number(metaPoints.redeemed?.pointValue || redeemPoints);

        // Delete existing points for this document
        await supabaseAdmin
          .from('contact_points')
          .delete()
          .eq('document_id', id);

        if (activeContactId) {
          if (earnPoints > 0) {
            const currentBal = await getContactPointBalance(activeContactId, req.auth.ownerId);
            const newBal = currentBal + earnPoints;
            await supabaseAdmin.from('contact_points').insert({
              contact_id: activeContactId,
              document_id: id,
              type: 'earn',
              amount: earnPoints,
              point_value: earnVal,
              balance_after: newBal,
              description: `Cashback dari ${data.document_number}`,
              metadata: metaPoints.earned || {},
              owner_id: req.auth.ownerId,
              created_by: req.auth.user.id,
            });
          }

          if (redeemPoints > 0) {
            const currentBal = await getContactPointBalance(activeContactId, req.auth.ownerId);
            const newBal = Math.max(0, currentBal - redeemPoints);
            await supabaseAdmin.from('contact_points').insert({
              contact_id: activeContactId,
              document_id: id,
              type: 'redeem',
              amount: -redeemPoints,
              point_value: -redeemVal,
              balance_after: newBal,
              description: `Penggunaan Saldo Cashback pada ${data.document_number}`,
              metadata: metaPoints.redeemed || {},
              owner_id: req.auth.ownerId,
              created_by: req.auth.user.id,
            });
          }
        }
      } catch (ptErr) {
        console.error('[Points] Error reconciling points on patch document:', ptErr);
      }
    }

    res.json({ data });

    // Update PO status to 'fulfilled' when Goods Out document is marked as 'completed'
    if (data.document_type === 'goods_out' && data.status === 'completed' && beforeData.status !== 'completed') {
      const sourcePoId = data.metadata?.source_po_id || data.metadata?.sourcePoId || beforeData.metadata?.source_po_id || beforeData.metadata?.sourcePoId;
      if (sourcePoId) {
        try {
          const { data: updatedPo, error: updatePoErr } = await supabaseAdmin
            .from('purchase_orders')
            .update({
              status: 'fulfilled',
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourcePoId)
            .eq('owner_id', req.auth.ownerId)
            .select('id, po_number, sales_person_id')
            .maybeSingle();

          if (!updatePoErr && updatedPo && updatedPo.sales_person_id) {
            await supabaseAdmin.from('notifications').insert({
              owner_id: req.auth.ownerId,
              user_id: updatedPo.sales_person_id,
              type: 'po_fulfilled',
              title: 'Barang PO Telah Dikeluarkan',
              message: `Barang untuk Purchase Order ${updatedPo.po_number} telah berhasil dikeluarkan dengan Surat Jalan ${data.document_number}.`,
              reference_id: updatedPo.id,
              reference_type: 'purchase_order',
              is_read: false,
            });
          }
        } catch (poErr) {
          console.error('[GoodsOut PATCH /documents] Error updating source PO to fulfilled:', poErr);
        }
      }

      // Kirim email saat status Barang Keluar diubah menjadi 'completed' (saat klik "Selesaikan Pengeluaran")
      try {
        await triggerGoodsOutEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsOut PATCH /documents/:id] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    }

    // Kirim email saat status Barang Masuk diubah menjadi 'completed' (saat klik "Selesaikan Penerimaan")
    if (data.document_type === 'goods_in' && data.status === 'completed' && beforeData.status !== 'completed') {
      try {
        await triggerGoodsInEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsIn PATCH /documents/:id] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    }

    // Revert PO status back to 'approved' if a completed Goods Out is cancelled
    if (beforeData.document_type === 'goods_out' && payload.status === 'cancelled' && beforeData.status === 'completed') {
      const sourcePoId = beforeData.metadata?.source_po_id || beforeData.metadata?.sourcePoId;
      if (sourcePoId) {
        await supabaseAdmin
          .from('purchase_orders')
          .update({
            status: 'approved',
            updated_at: new Date().toISOString(),
          })
          .eq('id', sourcePoId)
          .eq('owner_id', req.auth.ownerId);
      }
    }
  } catch (error) {
    next(error);
  }
});

router.post('/documents/:id/complete', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const beforeData = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    if (beforeData.document_type === 'goods_in' || beforeData.document_type === 'goods_out') {
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Anda tidak memiliki izin untuk menyelesaikan dokumen ini.');
      }
    }

    if (beforeData.status === 'completed') {
      return res.json({ data: beforeData });
    }

    if (beforeData.status === 'cancelled') {
      throw httpError(400, 'Dokumen yang sudah dibatalkan tidak dapat diselesaikan.');
    }

    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('complete_inventory_document', {
      p_owner_id: req.auth.ownerId,
      p_document_id: id,
    });

    if (rpcError) {
      console.error('[POST /documents/:id/complete] RPC error:', rpcError);
      if (rpcError.code === 'P0002') {
        throw httpError(404, 'Dokumen atau produk tidak ditemukan');
      }
      if (rpcError.message?.includes('INSUFFICIENT_STOCK')) {
        throw httpError(400, 'Stok produk tidak mencukupi untuk menyelesaikan transaksi Barang Keluar ini.');
      }
      if (rpcError.message?.includes('SERIAL_NOT_AVAILABLE')) {
        const sn = rpcError.message.split(':')[1] || '';
        throw httpError(400, `Nomor seri "${sn}" tidak tersedia atau sudah pernah dikeluarkan.`);
      }
      if (rpcError.message?.includes('SERIAL_NOT_FOUND')) {
        const sn = rpcError.message.split(':')[1] || '';
        throw httpError(400, `Nomor seri "${sn}" tidak ditemukan dalam sistem.`);
      }
      throw httpError(400, rpcError.message || 'Gagal menyelesaikan dokumen');
    }

    const data = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    await writeActivityLog(req, {
      action: 'completed',
      entityType: 'Documents',
      entityId: id,
      entityName: data.document_number,
      beforeData,
      afterData: data,
    });

    // If goods_out completes and fulfills a purchase order
    if (data.document_type === 'goods_out') {
      const sourcePoId = data.metadata?.source_po_id || data.metadata?.sourcePoId || beforeData.metadata?.source_po_id || beforeData.metadata?.sourcePoId;
      if (sourcePoId) {
        try {
          const { data: updatedPo, error: updatePoErr } = await supabaseAdmin
            .from('purchase_orders')
            .update({
              status: 'fulfilled',
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourcePoId)
            .eq('owner_id', req.auth.ownerId)
            .select('id, po_number, sales_person_id')
            .maybeSingle();

          if (!updatePoErr && updatedPo && updatedPo.sales_person_id) {
            await supabaseAdmin.from('notifications').insert({
              owner_id: req.auth.ownerId,
              user_id: updatedPo.sales_person_id,
              type: 'po_fulfilled',
              title: 'Barang PO Telah Dikeluarkan',
              message: `Barang untuk Purchase Order ${updatedPo.po_number} telah berhasil dikeluarkan dengan Surat Jalan ${data.document_number}.`,
              reference_id: updatedPo.id,
              reference_type: 'purchase_order',
              is_read: false,
            });
          }
        } catch (poErr) {
          console.error('[GoodsOut POST /documents/:id/complete] Error updating source PO to fulfilled:', poErr);
        }
      }

      // Kirim email saat status Barang Keluar diubah menjadi 'completed'
      try {
        await triggerGoodsOutEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsOut POST /documents/:id/complete] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    }

    // Kirim email saat status Barang Masuk diubah menjadi 'completed'
    if (data.document_type === 'goods_in') {
      try {
        await triggerGoodsInEmailBackground({
          doc: data,
          ownerId: req.auth.ownerId,
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          userMetadata: req.auth.user.user_metadata,
        });
      } catch (emailErr) {
        console.error('[GoodsIn POST /documents/:id/complete] Email trigger failed:', emailErr?.message ?? emailErr);
      }
    }

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.delete('/documents/:id', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const beforeData = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    // Role check for Goods In deletion
    if (beforeData.document_type === 'goods_in') {
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Hanya owner, super_admin, dan staff yang diizinkan menghapus dokumen Barang Masuk.');
      }

      // Check if serials or stock from this Goods In have already been dispatched
      if (beforeData.status !== 'cancelled') {
        const { data: allDocSerials } = await supabaseAdmin
          .from('product_serials')
          .select('id, serial_number, goods_out_document_id, status, goods_in_item_id, product_id')
          .eq('goods_in_document_id', id)
          .eq('owner_id', req.auth.ownerId);

        const outSerials = (allDocSerials || []).filter(
          (s) => s.status === 'out' || s.goods_out_document_id != null
        );

        if (outSerials && outSerials.length > 0) {
          const goIds = [...new Set(outSerials.map((s) => s.goods_out_document_id).filter(Boolean))];
          let goDocMap = {};
          if (goIds.length > 0) {
            const { data: goDocs } = await supabaseAdmin
              .from('documents')
              .select('id, document_number')
              .in('id', goIds);
            (goDocs || []).forEach((d) => {
              goDocMap[d.id] = d.document_number;
            });
          }

          const details = outSerials.map((s) => {
            const docNum = goDocMap[s.goods_out_document_id] || 'Barang Keluar terkait';
            return `${s.serial_number} (keluar di ${docNum})`;
          });

          const detailsMsg = details.slice(0, 5).join(', ') + (details.length > 5 ? ` dan ${details.length - 5} serial lainnya` : '');

          throw httpError(
            409,
            `Barang Masuk tidak dapat dihapus karena nomor seri sudah dikeluarkan pada transaksi Barang Keluar: ${detailsMsg}. Batalkan transaksi Barang Keluar terkait terlebih dahulu jika ingin menghapus.`
          );
        }

        const serialItemIds = new Set((allDocSerials || []).map((s) => s.goods_in_item_id).filter(Boolean));
        const serialProductIds = new Set((allDocSerials || []).map((s) => s.product_id).filter(Boolean));

        // Check non-serial stock ONLY for items that are not serial-tracked
        const { multipliers } = await getWorkspaceUnits(req.auth.ownerId, beforeData.warehouse_id || beforeData.metadata?.warehouseId);
        for (const item of beforeData.items || []) {
          const isSerialItem = item.metadata?.isSerial === true ||
            item.metadata?.trackingMode === 'serial' ||
            serialItemIds.has(item.id) ||
            serialProductIds.has(item.product_id);

          if (item.product_id && !isSerialItem) {
            const unit = item.metadata?.qtyUnit || item.unit || 'pcs';
            const mult = multipliers[unit] || 1;
            const qtyInPcs = (item.metadata?.qtyInput ?? item.quantity ?? 1) * mult;
            const { data: prod } = await supabaseAdmin
              .from('products')
              .select('stock, metadata, name')
              .eq('id', item.product_id)
              .eq('owner_id', req.auth.ownerId)
              .maybeSingle();
            const availableNonSerial = Number(prod?.metadata?.stockNonSerial ?? prod?.stock ?? 0);
            if (prod && availableNonSerial < qtyInPcs) {
              throw httpError(
                409,
                `Barang Masuk tidak dapat dihapus karena sebagian stok non-serial untuk "${prod.name || 'produk'}" sudah terpakai atau dikeluarkan. Batalkan transaksi Barang Keluar terkait terlebih dahulu jika ingin menghapus.`
              );
            }
          }
        }
      }
    }
    
    // Revert stock and serial numbers if document was not already cancelled
    if (beforeData.status !== 'cancelled') {
      try {
        await revertDocumentStockAndSerials(beforeData, req.auth.ownerId);
      } catch (revErr) {
        console.error('[Revert Stock/Serials] Failed to revert on delete:', revErr);
      }
    } else {
      // If already cancelled, ensure any lingering serial links are cleared
      if (beforeData.document_type === 'goods_out') {
        await supabaseAdmin
          .from('product_serials')
          .update({
            status: 'available',
            goods_out_document_id: null,
            goods_out_item_id: null,
          })
          .eq('goods_out_document_id', id)
          .eq('owner_id', req.auth.ownerId);
      }
    }

    // If deleted Goods Out fulfilled a PO, revert PO status to 'approved'
    if (beforeData.document_type === 'goods_out' && beforeData.status === 'completed') {
      const sourcePoId = beforeData.metadata?.source_po_id || beforeData.metadata?.sourcePoId;
      if (sourcePoId) {
        await supabaseAdmin
          .from('purchase_orders')
          .update({
            status: 'approved',
            updated_at: new Date().toISOString(),
          })
          .eq('id', sourcePoId)
          .eq('owner_id', req.auth.ownerId);
      }
    }

    // Rollback linked contact loyalty points if any
    try {
      const { data: linkedPoints } = await supabaseAdmin
        .from('contact_points')
        .select('*')
        .eq('document_id', id)
        .eq('owner_id', req.auth.ownerId);

      if (linkedPoints && linkedPoints.length > 0) {
        for (const pt of linkedPoints) {
          const currentBal = await getContactPointBalance(pt.contact_id, req.auth.ownerId);
          const reverseAmount = -pt.amount;
          const newBal = Math.max(0, currentBal + reverseAmount);
          await supabaseAdmin
            .from('contact_points')
            .insert({
              contact_id: pt.contact_id,
              document_id: null,
              type: 'refund',
              amount: reverseAmount,
              point_value: pt.point_value,
              balance_after: newBal,
              description: `Pembatalan ${pt.type === 'earn' ? 'Cashback' : 'Penggunaan'} Point karena invoice ${beforeData.document_number} dihapus`,
              owner_id: req.auth.ownerId,
              created_by: req.auth.user.id,
            });
        }
      }
    } catch (ptRevErr) {
      console.error('[Points] Failed to reverse points on document delete:', ptRevErr);
    }

    const { error } = await supabaseAdmin.from('documents').delete().eq('id', id).eq('owner_id', req.auth.ownerId);
    if (error) throw httpError(500, 'Failed to delete document', error.message);
    
    await writeActivityLog(req, { action: 'deleted', entityType: 'Documents', entityId: id, entityName: beforeData.document_number, beforeData });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ── Error Mapping Helper for Atomic Return & Restore RPCs ─────────
function mapReturnRpcError(rpcError) {
  const msg = rpcError?.message || '';
  if (rpcError?.code === 'P0002' || msg.includes('DOCUMENT_NOT_FOUND')) {
    throw httpError(404, 'Dokumen tidak ditemukan atau bukan milik workspace ini');
  }
  if (msg.includes('RETURN_RECORD_NOT_FOUND')) {
    throw httpError(404, 'Data retur tidak ditemukan');
  }
  if (msg.includes('RETURN_ALREADY_RESTORED')) {
    throw httpError(400, 'Transaksi retur ini sudah pernah dibatalkan sebelumnya');
  }
  if (msg.includes('DOCUMENT_NOT_COMPLETED')) {
    throw httpError(400, 'Hanya dokumen berstatus completed yang dapat diretur');
  }
  if (msg.includes('INVALID_DOC_TYPE')) {
    throw httpError(400, 'Hanya dokumen surat jalan (Goods Out) yang dapat diretur melalui fungsi ini');
  }
  if (msg.includes('EMPTY_RETURN_ITEMS')) {
    throw httpError(400, 'Daftar barang yang diretur tidak boleh kosong');
  }
  if (msg.includes('REASON_REQUIRED')) {
    throw httpError(400, 'Alasan retur wajib diisi');
  }
  if (msg.includes('NOTES_REQUIRED_FOR_REASON_LAINNYA')) {
    throw httpError(400, 'Catatan wajib diisi minimal 3 karakter saat alasan memilih "Lainnya"');
  }
  if (msg.includes('INVALID_TARGET_STATUS') || msg.includes('INVALID_ITEM_CONDITION')) {
    throw httpError(400, 'Kondisi barang harus bernilai "available" (tersedia) atau "damaged" (rusak/cacat)');
  }
  if (msg.includes('SERIAL_NUMBER_REQUIRED')) {
    throw httpError(400, 'Baris barang bertipe serial wajib menyertakan nomor seri yang valid');
  }
  if (msg.includes('DUPLICATE_SERIAL_IN_PAYLOAD')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Nomor seri "${sn.trim()}" diinput berulang kali dalam pengajuan ini`);
  }
  if (msg.includes('SERIAL_ALREADY_RETURNED')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Nomor seri "${sn.trim()}" sudah pernah diretur sebelumnya pada surat jalan ini`);
  }
  if (msg.includes('SERIAL_NOT_FOUND')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Nomor seri "${sn.trim()}" tidak ditemukan dalam sistem inventory`);
  }
  if (msg.includes('SERIAL_NOT_DISPATCHED_IN_THIS_DOC')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Nomor seri "${sn.trim()}" tidak dikeluarkan oleh surat jalan ini`);
  }
  if (msg.includes('SERIAL_INVALID_STATUS')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Status nomor seri "${sn.trim()}" saat ini tidak valid untuk diretur (bukan berstatus "out")`);
  }
  if (msg.includes('SERIAL_WAREHOUSE_MISMATCH')) {
    throw httpError(400, 'Gudang penyimpanan nomor seri tidak sesuai dengan gudang surat jalan ini');
  }
  if (msg.includes('CANNOT_IDENTIFY_SOURCE_DOCUMENT_ITEM_FOR_SERIAL')) {
    const sn = msg.split(':')[1] || '';
    throw httpError(400, `Barang sumber tidak dapat diidentifikasi untuk nomor seri "${sn.trim()}". Silakan pilih item dokumen secara manual.`);
  }
  if (msg.includes('ITEM_IS_SERIAL_USE_SERIAL_RETURN')) {
    throw httpError(400, 'Barang ini memiliki nomor seri, wajib diretur melalui pemindaian nomor seri');
  }
  if (msg.includes('RETURN_QTY_EXCEEDS_REMAINING')) {
    throw httpError(400, 'Kuantitas retur melebihi sisa barang yang dapat diretur pada surat jalan ini');
  }
  if (msg.includes('HISTORICAL_RETURN_EXCEEDS_ORIGINAL_QTY')) {
    throw httpError(400, 'Inkonsistensi riwayat retur terdeteksi melebihi kuantitas pengiriman asal. Diperlukan rekonsiliasi manual.');
  }
  if (msg.includes('FRACTIONAL_BASE_PCS_NOT_ALLOWED')) {
    throw httpError(400, 'Kuantitas retur dalam satuan dasar pcs menghasilkan nilai pecahan. Gudang hanya menerima satuan utuh.');
  }
  if (msg.includes('STOCK_INTEGER_OVERFLOW')) {
    throw httpError(400, 'Penambahan stok melebihi kapasitas maksimum penyimpanan database');
  }
  if (msg.includes('INSUFFICIENT_STOCK_FOR_RESTORE')) {
    throw httpError(400, 'Stok produk di gudang tidak mencukupi untuk membatalkan retur ini');
  }
  if (msg.includes('INSUFFICIENT_SERIAL_STOCK_FOR_RESTORE')) {
    throw httpError(400, 'Stok nomor seri tersedia di gudang tidak mencukupi untuk membatalkan retur ini');
  }
  if (msg.includes('INSUFFICIENT_DAMAGED_STOCK_FOR_RESTORE')) {
    throw httpError(400, 'Stok barang rusak tidak mencukupi untuk membatalkan retur ini');
  }
  if (msg.includes('SERIAL_STATUS_CONFLICT_FOR_RESTORE')) {
    throw httpError(400, 'Status nomor seri saat ini tidak sesuai untuk dibatalkan (mungkin telah dipindahkan atau diubah)');
  }
  if (msg.includes('SERIAL_ALREADY_ATTACHED_TO_ANOTHER_DOC')) {
    throw httpError(400, 'Nomor seri telah dikeluarkan oleh surat jalan lain dan tidak dapat dipulihkan otomatis');
  }
  if (msg.includes('CORRUPTED_PRODUCT_METADATA') || msg.includes('CORRUPTED_RETURNS_METADATA')) {
    throw httpError(500, 'Inkonsistensi integritas metadata terdeteksi di database. Hubungi administrator.');
  }
  throw httpError(400, msg || 'Gagal memproses transaksi retur');
}

// ── GET /api/workspace/returns ─────────────────────────────────────
router.get('/returns', async (req, res, next) => {
  try {
    const allowedRoles = ['owner', 'super_admin', 'staff'];
    if (!allowedRoles.includes(req.auth.role)) {
      throw httpError(403, 'Akses ditolak. Anda tidak memiliki izin untuk melihat daftar retur.');
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim().toLowerCase();
    const type = req.query.type; // 'goods_out', 'goods_in', or 'all'
    const status = req.query.status; // 'active', 'restored', or 'all'
    const reason = req.query.reason;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = supabaseAdmin
      .from('documents')
      .select('id, document_type, document_number, contact_id, contact_name, warehouse_id, metadata, created_at, items:document_items(*)')
      .eq('owner_id', req.auth.ownerId)
      .not('metadata->returns', 'is', null);

    if (req.auth.warehouseId) {
      query = query.eq('warehouse_id', req.auth.warehouseId);
    } else if (req.query.warehouseId) {
      query = query.eq('warehouse_id', req.query.warehouseId);
    }

    if (type && type !== 'all') {
      query = query.eq('document_type', type);
    } else {
      query = query.in('document_type', ['goods_out', 'goods_in']);
    }

    const { data: docs, error } = await query;
    if (error) throw httpError(500, 'Gagal mengambil data retur', error.message);

    // Flatten returns across all documents
    let allReturns = [];
    for (const doc of docs || []) {
      const returns = Array.isArray(doc.metadata?.returns) ? doc.metadata.returns : [];
      for (const ret of returns) {
        if (!ret || typeof ret !== 'object') continue;
        allReturns.push({
          id: ret.id,
          returnNumber: ret.returnNumber || `RET-${doc.document_number}`,
          documentId: doc.id,
          documentNumber: doc.document_number,
          documentType: doc.document_type,
          contactId: doc.contact_id || null,
          contactName: doc.contact_name,
          warehouseId: doc.warehouse_id,
          returnedAt: ret.returnedAt || ret.date || doc.created_at,
          returnedBy: ret.returnedBy,
          reason: ret.reason,
          notes: ret.notes,
          status: ret.status || 'active',
          condition: ret.condition || (ret.items?.some((i) => i.condition === 'damaged' || i.targetStatus === 'damaged') ? 'damaged' : 'available'),
          restoredAt: ret.restoredAt,
          restoredBy: ret.restoredBy,
          restoreNotes: ret.restoreNotes,
          items: (ret.items || []).map((item) => {
            const matchedDocItem = (doc.items || []).find((di) => di.id === item.itemId);
            const isGroup = item.isGroup === true || matchedDocItem?.metadata?.isGroup === true;
            const targetQty = isGroup
              ? Number(matchedDocItem?.metadata?.targetQty ?? item.targetQty ?? item.returnedQty ?? 1)
              : Number(item.returnedQty ?? 1);
            const targetUnit = isGroup
              ? (matchedDocItem?.metadata?.targetUnit ?? item.targetUnit ?? item.qtyUnit ?? matchedDocItem?.metadata?.qtyUnit ?? 'pcs')
              : (item.qtyUnit || matchedDocItem?.metadata?.qtyUnit || 'pcs');

            return {
              ...item,
              isGroup,
              returnedQty: targetQty,
              targetQty,
              qtyUnit: targetUnit,
              targetUnit,
              productName: item.productName || matchedDocItem?.item_name || 'Barang',
              sku: item.sku || matchedDocItem?.sku || '',
            };
          }),
        });
      }
    }

    // Apply filters in memory
    if (status && status !== 'all') {
      allReturns = allReturns.filter((r) => r.status === status);
    }
    if (reason) {
      allReturns = allReturns.filter((r) => r.reason === reason);
    }
    if (startDate) {
      allReturns = allReturns.filter((r) => (r.returnedAt || '').slice(0, 10) >= startDate);
    }
    if (endDate) {
      allReturns = allReturns.filter((r) => (r.returnedAt || '').slice(0, 10) <= endDate);
    }
    if (search) {
      allReturns = allReturns.filter((r) => {
        const retNum = (r.returnNumber || '').toLowerCase();
        const docNum = (r.documentNumber || '').toLowerCase();
        const contact = (r.contactName || '').toLowerCase();
        const itemsMatch = (r.items || []).some((i) =>
          (i.productName || '').toLowerCase().includes(search) ||
          (i.sku || '').toLowerCase().includes(search) ||
          (i.serialNumber || '').toLowerCase().includes(search)
        );
        return retNum.includes(search) || docNum.includes(search) || contact.includes(search) || itemsMatch;
      });
    }

    // Sort by returnedAt descending
    allReturns.sort((a, b) => new Date(b.returnedAt || 0) - new Date(a.returnedAt || 0));

    const totalCount = allReturns.length;
    const paginated = allReturns.slice(offset, offset + limit);

    res.json({
      data: paginated,
      meta: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── Document Return (Goods Out & Goods In) ──────────────────────
const returnItemSchema = z.object({
  productId: z.string().trim().optional().nullable().transform((val) => (val && val.length > 0 ? val : null)),
  itemId: z.string().trim().optional().nullable().transform((val) => (val && val.length > 0 ? val : null)),
  isSerial: z.boolean().default(false),
  serialNumber: z.string().trim().optional().nullable().transform((val) => (val && val.length > 0 ? val : null)),
  returnedQty: z.coerce.number().positive().default(1),
  qtyUnit: z.string().trim().max(50).default('pcs'),
  targetStatus: z.enum(['available', 'damaged']).optional().default('available'),
});

const returnSchema = z.object({
  reason: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(2000).optional().nullable(),
  targetStatus: z.enum(['available', 'damaged']).optional().default('available'),
  markAsDamaged: z.boolean().optional().default(false),
  items: z.array(returnItemSchema).min(1),
});

router.post('/documents/:id/return', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const doc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    // Warehouse isolation check
    if (req.auth.warehouseId && doc.warehouse_id && doc.warehouse_id !== req.auth.warehouseId) {
      throw httpError(403, 'Akses ditolak. Anda tidak berwenang memproses retur untuk dokumen gudang lain.');
    }

    // Only completed goods_out or goods_in documents can be returned
    if (doc.document_type !== 'goods_out' && doc.document_type !== 'goods_in') {
      throw httpError(400, 'Only goods_out and goods_in documents can be returned');
    }
    if (doc.status !== 'completed') {
      throw httpError(400, 'Only completed documents can be returned');
    }

    // Role check for Goods In return
    if (doc.document_type === 'goods_in') {
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Hanya owner, super_admin, dan staff yang diizinkan melakukan retur Barang Masuk.');
      }
    }

    const payload = returnSchema.parse(req.body);

    // If reason is 'lainnya', notes is required
    if (payload.reason === 'lainnya' && (!payload.notes || payload.notes.length < 3)) {
      throw httpError(400, 'Catatan wajib diisi saat alasan memilih "Lainnya" (minimal 3 karakter)');
    }

    const { multipliers, parseUnitFromSn } = await getWorkspaceUnits(req.auth.ownerId, doc.warehouse_id || doc.metadata?.warehouseId);

    const isGoodsIn = doc.document_type === 'goods_in';
    const existingReturns = doc.metadata?.returns ?? [];
    const returnItemsToRecord = [];

    if (isGoodsIn) {
      // ── BATCH GOODS IN RETURN / DELETION ──
      const serialItems = payload.items.filter((item) => item.isSerial && item.serialNumber);
      const nonSerialItems = payload.items.filter((item) => !item.isSerial);

      const allSNs = serialItems.map((item) => String(item.serialNumber).trim());

      // 1. Check if any serial is already returned
      for (const sn of allSNs) {
        const alreadyReturned = existingReturns.some((r) =>
          (r.items ?? []).some(
            (ri) => ri.isSerial && String(ri.serialNumber || '').trim().toLowerCase() === sn.toLowerCase()
          )
        );
        if (alreadyReturned) {
          throw httpError(400, `Nomor seri "${sn}" sudah pernah diretur/dihapus sebelumnya`);
        }
      }

      // 2. Fetch all serials in 1 batch query
      let matchedSerials = [];
      if (allSNs.length > 0) {
        const { data: serList, error: serErr } = await supabaseAdmin
          .from('product_serials')
          .select('*')
          .eq('owner_id', req.auth.ownerId)
          .in('serial_number', allSNs);
        if (serErr) throw httpError(500, 'Gagal mencari nomor seri di database', serErr.message);
        matchedSerials = serList ?? [];

        // Check if any serial is already out
        for (const s of matchedSerials) {
          if (s.status === 'out' || s.goods_out_document_id) {
            throw httpError(400, `Nomor seri "${s.serial_number}" telah keluar/terjual dan tidak dapat diretur/dihapus`);
          }
        }

        // Delete all matching serials in 1 batch query
        const serialIdsToDelete = matchedSerials.map((s) => s.id);
        if (serialIdsToDelete.length > 0) {
          const { error: delErr } = await supabaseAdmin
            .from('product_serials')
            .delete()
            .eq('owner_id', req.auth.ownerId)
            .in('id', serialIdsToDelete);
          if (delErr) throw httpError(500, 'Gagal menghapus nomor seri dari inventory', delErr.message);
        }
      }

      // 3. Aggregate deductions for Products & Document Items
      const stockDeductionByProduct = {};
      const nonSerialDeductionByProduct = {};
      const qtyDeductionByDocItem = {};

      // Process serial items
      for (const item of serialItems) {
        const cleanSN = String(item.serialNumber).trim();
        const matchedSerial = matchedSerials.find(
          (s) => s.serial_number.toLowerCase() === cleanSN.toLowerCase()
        );
        const matchedDocItem = (doc.items ?? []).find(
          (di) =>
            (item.itemId && di.id === item.itemId) ||
            (di.metadata?.isSerial === true && String(di.metadata?.serialNumber || '').trim().toLowerCase() === cleanSN.toLowerCase()) ||
            (matchedSerial && di.product_id === matchedSerial.product_id) ||
            (item.productId && di.product_id === item.productId)
        );

        const prodId = item.productId || matchedSerial?.product_id || matchedDocItem?.product_id;
        const sUnit = parseUnitFromSn(cleanSN) || item.qtyUnit || 'pcs';

        const sMultiplier = multipliers[sUnit] || multipliers[item.qtyUnit] || 1;

        if (prodId) {
          stockDeductionByProduct[prodId] = (stockDeductionByProduct[prodId] || 0) + sMultiplier;
        }

        if (matchedDocItem) {
          qtyDeductionByDocItem[matchedDocItem.id] = (qtyDeductionByDocItem[matchedDocItem.id] || 0) + 1;
        }

        returnItemsToRecord.push({
          itemId: matchedDocItem?.id || item.itemId || null,
          productId: prodId || null,
          isSerial: true,
          serialNumber: cleanSN,
          returnedQty: 1,
          qtyUnit: sUnit,
        });
      }

      // Process non-serial items
      for (const item of nonSerialItems) {
        const unit = item.qtyUnit || 'pcs';
        const multiplier = multipliers[unit] || 1;
        const returnedQty = Number(item.returnedQty || 1);
        const stockDelta = returnedQty * multiplier;

        const docItem = (doc.items ?? []).find((di) => {
          if (item.itemId && di.id === item.itemId) return true;
          if (item.productId && (di.product_id ?? di.productId) === item.productId) return true;
          return false;
        }) ?? (doc.items ?? [])[0];

        if (!docItem) throw httpError(400, `Barang tidak ditemukan dalam dokumen ini`);

        const originalQtyInput = Number(docItem.metadata?.qtyInput ?? docItem.quantity ?? 1);
        const targetProdId = item.productId ?? docItem.product_id ?? docItem.productId;
        const targetItemId = item.itemId ?? docItem.id;

        const previouslyReturned = existingReturns.reduce((sum, r) => {
          return sum + (r.items ?? [])
            .filter((ri) => !ri.isSerial && (ri.itemId === targetItemId || ri.productId === targetProdId))
            .reduce((s, ri) => s + (ri.returnedQty || 0), 0);
        }, 0);

        if (returnedQty + previouslyReturned > originalQtyInput) {
          throw httpError(400, `Jumlah retur melebihi sisa barang yang tersedia (${previouslyReturned}/${originalQtyInput} sudah diretur)`);
        }

        if (targetProdId) {
          stockDeductionByProduct[targetProdId] = (stockDeductionByProduct[targetProdId] || 0) + stockDelta;
          nonSerialDeductionByProduct[targetProdId] = (nonSerialDeductionByProduct[targetProdId] || 0) + stockDelta;
        }

        if (targetItemId) {
          qtyDeductionByDocItem[targetItemId] = (qtyDeductionByDocItem[targetItemId] || 0) + returnedQty;
        }

        returnItemsToRecord.push({
          itemId: targetItemId || null,
          productId: targetProdId || null,
          isSerial: false,
          serialNumber: null,
          returnedQty,
          qtyUnit: unit,
        });
      }

      // 4. Update Product Stocks in parallel
      await Promise.all(
        Object.entries(stockDeductionByProduct).map(async ([prodId, delta]) => {
          const { data: prodData } = await supabaseAdmin
            .from('products')
            .select('stock, metadata')
            .eq('id', prodId)
            .eq('owner_id', req.auth.ownerId)
            .maybeSingle();

          if (prodData) {
            const currentTotal = Number(prodData.stock || 0);
            const currentNonSerial = Number(prodData.metadata?.stockNonSerial ?? prodData.stock ?? 0);
            const newTotal = Math.max(0, currentTotal - delta);
            const nonSerialDelta = nonSerialDeductionByProduct[prodId] || 0;
            const newNonSerial = nonSerialDelta > 0 ? Math.max(0, currentNonSerial - nonSerialDelta) : currentNonSerial;

            await supabaseAdmin
              .from('products')
              .update({
                stock: newTotal,
                metadata: { ...(prodData.metadata || {}), stockNonSerial: newNonSerial },
              })
              .eq('id', prodId)
              .eq('owner_id', req.auth.ownerId);
          }
        })
      );

      // 5. Update / Delete document_items in parallel
      await Promise.all(
        Object.entries(qtyDeductionByDocItem).map(async ([itemId, delta]) => {
          const docItem = (doc.items ?? []).find((di) => di.id === itemId);
          if (docItem) {
            const currentQty = Number(docItem.quantity ?? 1);
            const currentQtyInput = Number(docItem.metadata?.qtyInput ?? currentQty);
            const newQty = Math.max(0, currentQty - delta);
            const newQtyInput = Math.max(0, currentQtyInput - delta);

            if (newQty <= 0 || newQtyInput <= 0) {
              await supabaseAdmin.from('document_items').delete().eq('id', docItem.id);
            } else {
              const updatedItemMeta = {
                ...(docItem.metadata || {}),
                qtyInput: newQtyInput,
              };
              await supabaseAdmin
                .from('document_items')
                .update({
                  quantity: newQty,
                  metadata: updatedItemMeta,
                })
                .eq('id', docItem.id);
            }
          }
        })
      );
    } else {
      // ── GOODS OUT RETURN VIA ATOMIC DATABASE RPC ──
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Hanya owner, super_admin, dan staff yang diizinkan melakukan retur Barang Keluar.');
      }

      let rpcResult = null;
      let rpcError = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const { data, error } = await supabaseAdmin.rpc('process_goods_out_return', {
          p_document_id: id,
          p_payload: payload,
          p_owner_id: req.auth.ownerId,
          p_actor_id: req.auth.user.id,
        });

        if (!error) {
          rpcResult = data;
          rpcError = null;
          break;
        }

        rpcError = error;
        // Retry only on deadlock (40P01) or serialization failure (40001)
        if ((error.code === '40P01' || error.code === '40001') && attempt < maxRetries) {
          const delay = Math.floor(Math.random() * 100) + attempt * 50;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }

      if (rpcError) {
        console.error('[GoodsOut Return] RPC error:', rpcError);
        mapReturnRpcError(rpcError);
      }

      SERIAL_CACHE.clear();

      // Cascade restore leaf serials if any of the returned items is a Group Serial
      if (rpcResult && Array.isArray(payload.items)) {
        for (const it of payload.items) {
          if (it.serialNumber) {
            const snClean = String(it.serialNumber).trim();
            const { data: retGroup } = await supabaseAdmin
              .from('product_serials')
              .select('id, metadata')
              .eq('owner_id', req.auth.ownerId)
              .in('serial_number', serialVariants(snClean))
              .maybeSingle();

            if (retGroup?.metadata?.isGroup) {
              const memberIds = [
                ...(Array.isArray(retGroup.metadata?.composition) ? retGroup.metadata.composition.map((c) => c.serialId || c.id) : []),
                ...(Array.isArray(retGroup.metadata?.directMembers) ? retGroup.metadata.directMembers.map((m) => m.serialId || m.id) : []),
              ].filter(Boolean);
              if (memberIds.length > 0) {
                const targetCond = it.targetStatus || (it.markAsDamaged ? 'damaged' : 'available');
                await supabaseAdmin
                  .from('product_serials')
                  .update({
                    status: targetCond,
                    goods_out_document_id: null,
                    goods_out_item_id: null,
                  })
                  .eq('owner_id', req.auth.ownerId)
                  .in('id', memberIds);
              }
            }
          }
        }
      }

      const updatedDoc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
      const latestReturn = (updatedDoc?.metadata?.returns || []).find((r) => r.id === rpcResult?.returnId) || rpcResult;

      if (latestReturn?.id) {
        try {
          await triggerReturnEmailBackground({
            doc: updatedDoc,
            returnRecord: latestReturn,
            ownerId: req.auth.ownerId,
            userId: req.auth.user.id,
            userEmail: req.auth.user.email,
            userMetadata: req.auth.user.user_metadata,
          });
        } catch (emailErr) {
          console.error('[Return POST /documents/:id/return] Email trigger failed:', emailErr?.message ?? emailErr);
        }
      }

      return res.json({ data: updatedDoc, returnRecord: latestReturn });
    }

    // Invalidate in-memory serial lookup cache so new scans reflect returned serials immediately
    SERIAL_CACHE.clear();

    // Save return record to document metadata
    const returnSequence = existingReturns.length + 1;
    const returnRecord = {
      id: crypto.randomUUID(),
      returnNumber: `RET-${doc.document_number}-R${String(returnSequence).padStart(2, '0')}`,
      returnedAt: new Date().toISOString(),
      date: new Date().toISOString(),
      reason: payload.reason,
      notes: payload.notes || null,
      returnedBy: req.auth.user.id,
      status: 'active',
      items: returnItemsToRecord,
    };

    const updatedReturns = [...existingReturns, returnRecord];
    const updatedMetadata = {
      ...(doc.metadata || {}),
      items: doc.metadata?.items ?? (doc.items ?? []),
      returns: updatedReturns,
    };

    const { error: metaErr } = await supabaseAdmin
      .from('documents')
      .update({ metadata: updatedMetadata })
      .eq('id', id)
      .eq('owner_id', req.auth.ownerId);
    if (metaErr) throw httpError(500, 'Gagal menyimpan riwayat retur', metaErr.message);

    // Fetch updated document
    const updatedDoc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    // Write activity log
    await writeActivityLog(req, {
      action: isGoodsIn ? 'goods_in_returned' : 'goods_out_returned',
      entityType: 'Documents',
      entityId: id,
      entityName: doc.document_number,
      beforeData: doc,
      afterData: updatedDoc,
    });

    try {
      await triggerReturnEmailBackground({
        doc: updatedDoc,
        returnRecord,
        ownerId: req.auth.ownerId,
        userId: req.auth.user.id,
        userEmail: req.auth.user.email,
        userMetadata: req.auth.user.user_metadata,
      });
    } catch (emailErr) {
      console.error('[Return POST /documents/:id/return legacy] Email trigger failed:', emailErr?.message ?? emailErr);
    }

    res.json({ data: updatedDoc, returnRecord });
  } catch (error) {
    next(error);
  }
});

// ── Undo / Restore Return Endpoint ─────────────────────────
// POST /documents/:id/returns/:returnId/send-email
// Kirim ulang email retur secara manual. Wajib manual karena log `uncertain`
// tidak boleh dikirim ulang otomatis (SMTP tidak punya idempotency key).
router.post('/documents/:id/returns/:returnId/send-email', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const returnId = req.params.returnId;
    const doc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    if (req.auth.warehouseId && doc.warehouse_id && doc.warehouse_id !== req.auth.warehouseId) {
      throw httpError(403, 'Akses ditolak. Anda tidak berwenang mengirim email retur untuk dokumen gudang lain.');
    }

    const returnRecord = (doc.metadata?.returns || []).find((ret) => ret?.id === returnId);
    if (!returnRecord) {
      throw httpError(404, 'Data retur tidak ditemukan. Retur mungkin sudah dibatalkan/dipulihkan.');
    }
    if (returnRecord.status && returnRecord.status !== 'active') {
      throw httpError(400, 'Email hanya dapat dikirim untuk retur yang masih aktif.');
    }

    const result = await resendReturnEmail(doc, returnRecord, {
      ownerId: req.auth.ownerId,
      actorEmail: req.auth.user.email,
      actorMetadata: req.auth.user.user_metadata,
      manualRetry: true,
    });

    if (result.status === 'skipped') {
      return res.status(409).json({
        success: false,
        error: 'Email retur tidak dikirim karena sudah terkirim, sedang diproses, atau menunggu konfirmasi manual.',
        reason: result.reason || null,
      });
    }
    if (result.status === 'failed') {
      return res.status(502).json({
        success: false,
        error: result.error || 'Gagal mengirim email retur.',
        data: result,
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/documents/:id/returns/:returnId/restore', async (req, res, next) => {
  try {
    const { id, returnId } = req.params;
    const doc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
    if (!doc) throw httpError(404, 'Dokumen tidak ditemukan');

    // Warehouse isolation check
    if (req.auth.warehouseId && doc.warehouse_id && doc.warehouse_id !== req.auth.warehouseId) {
      throw httpError(403, 'Akses ditolak. Anda tidak berwenang membatalkan retur untuk dokumen gudang lain.');
    }

    const existingReturns = doc.metadata?.returns ?? [];
    const returnRecord = existingReturns.find((r) => r.id === returnId);
    if (!returnRecord) {
      throw httpError(404, 'Data retur tidak ditemukan');
    }

    // Role check for Goods In restore return
    if (doc.document_type === 'goods_in') {
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Hanya owner, super_admin, dan staff yang diizinkan membatalkan retur Barang Masuk.');
      }
    }

    const { multipliers, parseUnitFromSn } = await getWorkspaceUnits(req.auth.ownerId, doc.warehouse_id || doc.metadata?.warehouseId);

    const isGoodsIn = doc.document_type === 'goods_in';
    const returnItems = returnRecord.items ?? [];

    if (isGoodsIn) {
      // 1. Calculate stock addition for products
      const stockAdditionByProduct = {};
      const nonSerialAdditionByProduct = {};
      const qtyAdditionByItem = {};

      const serialItems = returnItems.filter((i) => i.isSerial && i.serialNumber);
      const nonSerialItems = returnItems.filter((i) => !i.isSerial);

      for (const item of serialItems) {
        const cleanSN = String(item.serialNumber).trim();
        const sUnit = parseUnitFromSn(cleanSN) || item.qtyUnit || 'pcs';

        const sMult = multipliers[sUnit] || multipliers[item.qtyUnit] || 1;
        const prodId = item.productId;
        if (prodId) {
          stockAdditionByProduct[prodId] = (stockAdditionByProduct[prodId] || 0) + sMult;
        }

        const targetKey = item.itemId || prodId;
        if (targetKey) {
          if (!qtyAdditionByItem[targetKey]) {
            qtyAdditionByItem[targetKey] = {
              itemId: item.itemId || null,
              productId: prodId,
              qty: 0,
              qtyUnit: sUnit,
              isSerial: true,
            };
          }
          qtyAdditionByItem[targetKey].qty += (Number(item.returnedQty) || 1);
        }
      }

      for (const item of nonSerialItems) {
        const unit = item.qtyUnit || 'pcs';
        const mult = multipliers[unit] || 1;
        const returnedQty = Number(item.returnedQty || 1);
        const delta = returnedQty * mult;
        const prodId = item.productId;

        if (prodId) {
          stockAdditionByProduct[prodId] = (stockAdditionByProduct[prodId] || 0) + delta;
          nonSerialAdditionByProduct[prodId] = (nonSerialAdditionByProduct[prodId] || 0) + delta;
        }

        const targetKey = item.itemId || prodId;
        if (targetKey) {
          if (!qtyAdditionByItem[targetKey]) {
            qtyAdditionByItem[targetKey] = {
              itemId: item.itemId || null,
              productId: prodId,
              qty: 0,
              qtyUnit: unit,
              isSerial: false,
            };
          }
          qtyAdditionByItem[targetKey].qty += returnedQty;
        }
      }

      // 2. Update Product Stocks
      await Promise.all(
        Object.entries(stockAdditionByProduct).map(async ([prodId, addTotal]) => {
          const { data: prodData } = await supabaseAdmin
            .from('products')
            .select('stock, metadata')
            .eq('id', prodId)
            .eq('owner_id', req.auth.ownerId)
            .maybeSingle();

          if (prodData) {
            const currentTotal = Number(prodData.stock || 0);
            const currentNonSerial = Number(prodData.metadata?.stockNonSerial ?? prodData.stock ?? 0);
            const addNonSerial = nonSerialAdditionByProduct[prodId] || 0;

            await supabaseAdmin
              .from('products')
              .update({
                stock: currentTotal + addTotal,
                metadata: {
                  ...(prodData.metadata || {}),
                  stockNonSerial: currentNonSerial + addNonSerial,
                },
              })
              .eq('id', prodId)
              .eq('owner_id', req.auth.ownerId);
          }
        })
      );

      // 3. Restore document_items
      const metaItems = doc.metadata?.items ?? [];
      const currentItems = doc.items ?? [];

      for (const group of Object.values(qtyAdditionByItem)) {
        const existingItem = currentItems.find(
          (di) => (group.itemId && di.id === group.itemId) || (group.productId && di.product_id === group.productId)
        );

        if (existingItem) {
          // Increment existing document_item
          const curQty = Number(existingItem.quantity || 0);
          const curQtyInput = Number(existingItem.metadata?.qtyInput ?? curQty);
          await supabaseAdmin
            .from('document_items')
            .update({
              quantity: curQty + group.qty,
              metadata: {
                ...(existingItem.metadata || {}),
                qtyInput: curQtyInput + group.qty,
              },
            })
            .eq('id', existingItem.id);
        } else {
          // Find original item details from doc.metadata.items
          const orig = metaItems.find(
            (mi) => (group.itemId && mi.id === group.itemId) || (group.productId && mi.product_id === group.productId)
          );

          if (orig) {
            await supabaseAdmin.from('document_items').insert({
              id: orig.id,
              document_id: doc.id,
              product_id: orig.product_id,
              item_name: orig.item_name,
              sku: orig.sku || null,
              quantity: group.qty,
              unit_price: orig.unit_price ?? 0,
              discount_type: orig.discount_type ?? 'none',
              discount_value: orig.discount_value ?? 0,
              amount: orig.amount ?? 0,
              sort_order: orig.sort_order ?? 0,
              metadata: {
                ...(orig.metadata || {}),
                qtyInput: group.qty,
              },
            });
          } else {
            // Fallback: look up product details
            const { data: prod } = await supabaseAdmin
              .from('products')
              .select('id, name, sku, selling_price')
              .eq('id', group.productId)
              .eq('owner_id', req.auth.ownerId)
              .maybeSingle();

            await supabaseAdmin.from('document_items').insert({
              id: group.itemId || crypto.randomUUID(),
              document_id: doc.id,
              product_id: group.productId,
              item_name: prod?.name || 'Item',
              sku: prod?.sku || null,
              quantity: group.qty,
              unit_price: prod?.selling_price ?? 0,
              discount_type: 'none',
              discount_value: 0,
              amount: 0,
              sort_order: 0,
              metadata: {
                qtyInput: group.qty,
                qtyUnit: group.qtyUnit,
                isSerial: group.isSerial,
              },
            });
          }
        }
      }

      // 4. Restore Product Serials
      if (serialItems.length > 0) {
        const allSNs = serialItems.map((i) => String(i.serialNumber).trim());

        // Check which serials already exist
        const { data: existingSerials } = await supabaseAdmin
          .from('product_serials')
          .select('id, serial_number, status')
          .eq('owner_id', req.auth.ownerId)
          .in('serial_number', allSNs);

        const existingSNSet = new Set((existingSerials || []).map((s) => s.serial_number.toLowerCase()));

        // For any existing serials, update status to available and attach to this doc
        if (existingSerials && existingSerials.length > 0) {
          const existingIds = existingSerials.map((s) => s.id);
          await supabaseAdmin
            .from('product_serials')
            .update({
              status: 'available',
              goods_in_document_id: doc.id,
            })
            .eq('owner_id', req.auth.ownerId)
            .in('id', existingIds);
        }

        // For serials that were deleted, re-insert them
        const serialsToInsert = serialItems
          .filter((item) => !existingSNSet.has(String(item.serialNumber).trim().toLowerCase()))
          .map((item) => {
            const cleanSN = String(item.serialNumber).trim();
            const sUnit = parseUnitFromSn(cleanSN) || item.qtyUnit || 'pcs';

            return {
              owner_id: req.auth.ownerId,
              warehouse_id: doc.warehouse_id || req.auth.warehouseId || null,
              product_id: item.productId,
              serial_number: cleanSN,
              status: 'available',
              goods_in_document_id: doc.id,
              goods_in_item_id: item.itemId || null,
              metadata: {
                source: 'goods_in_return_reversal',
                serialUnit: sUnit,
                unitQty: multipliers[sUnit] || 1,
                restoredAt: new Date().toISOString(),
                restoredFromReturnId: returnId,
              },
            };
          });

        if (serialsToInsert.length > 0) {
          for (let i = 0; i < serialsToInsert.length; i += 100) {
            const chunk = serialsToInsert.slice(i, i + 100);
            const { error: insErr } = await supabaseAdmin.from('product_serials').insert(chunk);
            if (insErr) throw httpError(500, 'Gagal mengembalikan nomor seri ke inventory', insErr.message);
          }
        }
      }
    } else {
      // ── GOODS OUT RESTORE VIA ATOMIC DATABASE RPC ──
      const allowedRoles = ['owner', 'super_admin', 'staff'];
      if (!allowedRoles.includes(req.auth.role)) {
        throw httpError(403, 'Akses ditolak. Hanya owner, super_admin, dan staff yang diizinkan membatalkan retur Barang Keluar.');
      }

      let rpcResult = null;
      let rpcError = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const { data, error } = await supabaseAdmin.rpc('restore_goods_out_return', {
          p_document_id: id,
          p_return_id: returnId,
          p_owner_id: req.auth.ownerId,
          p_actor_id: req.auth.user.id,
          p_notes: req.body?.notes || null,
        });

        if (!error) {
          rpcResult = data;
          rpcError = null;
          break;
        }

        rpcError = error;
        // Retry only on deadlock (40P01) or serialization failure (40001)
        if ((error.code === '40P01' || error.code === '40001') && attempt < maxRetries) {
          const delay = Math.floor(Math.random() * 100) + attempt * 50;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }

      if (rpcError) {
        console.error('[GoodsOut Restore] RPC error:', rpcError);
        mapReturnRpcError(rpcError);
      }

      SERIAL_CACHE.clear();

      const updatedDoc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');
      return res.json({
        data: updatedDoc,
        restoredReturnId: returnId,
        message: 'Retur Surat Jalan berhasil dibatalkan dan status serial/stok berhasil dipulihkan',
      });
    }

    // Invalidate in-memory serial lookup cache
    SERIAL_CACHE.clear();

    // 5. Remove return entry from document metadata
    const updatedReturns = existingReturns.filter((r) => r.id !== returnId);
    const updatedMetadata = {
      ...(doc.metadata || {}),
      returns: updatedReturns,
    };

    const { error: metaErr } = await supabaseAdmin
      .from('documents')
      .update({ metadata: updatedMetadata })
      .eq('id', id)
      .eq('owner_id', req.auth.ownerId);
    if (metaErr) throw httpError(500, 'Gagal memperbarui riwayat retur dokumen', metaErr.message);

    // 6. Fetch updated document
    const updatedDoc = await getRow('documents', id, req.auth.ownerId, '*, items:document_items(*)');

    // 7. Write activity log
    await writeActivityLog(req, {
      action: isGoodsIn ? 'goods_in_return_restored' : 'goods_out_return_restored',
      entityType: 'Documents',
      entityId: id,
      entityName: doc.document_number,
      beforeData: doc,
      afterData: updatedDoc,
    });

    res.json({
      data: updatedDoc,
      restoredReturnId: returnId,
      message: 'Retur berhasil dibatalkan dan barang berhasil dipulihkan ke stok gudang',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const params = pagingSchema.parse(req.query);
    let query = supabaseAdmin
      .from('activity_logs')
      .select('id, actor_name, action, entity_type, entity_id, entity_name, before_data, after_data, created_at', { count: 'exact' })
      .eq('owner_id', req.auth.ownerId);

    if (req.auth.warehouseId) {
      query = query.eq('warehouse_id', req.auth.warehouseId);
    }
    query = query.order('created_at', { ascending: false });
    if (params.type) query = query.eq('entity_type', params.type);
    if (params.search) query = query.or(`action.ilike.%${params.search}%,entity_name.ilike.%${params.search}%,actor_name.ilike.%${params.search}%`);
    const { data, error, count } = await query.range(params.offset, params.offset + params.limit - 1);
    if (error) throw httpError(500, 'Failed to load history', error.message);
    res.json({ data, count });
  } catch (error) {
    next(error);
  }
});

// ── Helper functions for Bagian/Area Gudang & Stock Opname ──────────────────
function getAreasSettingKey(warehouseId) {
  return `warehouse_areas_${warehouseId || 'default'}`;
}

function getSessionsSettingKey(warehouseId) {
  return `stock_opname_sessions_${warehouseId || 'default'}`;
}

async function fetchWorkspaceSettingValue(ownerId, key) {
  const { data, error } = await supabaseAdmin
    .from('workspace_settings')
    .select('value')
    .eq('owner_id', ownerId)
    .eq('key', key)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data?.value ?? null;
}

async function saveWorkspaceSettingValue(ownerId, key, value, userId) {
  const { error } = await supabaseAdmin
    .from('workspace_settings')
    .upsert({
      owner_id: ownerId,
      key,
      value,
      updated_by: userId || null,
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
}

// ── Master Bagian / Area Gudang Endpoints ────────────────────────────────────

router.get('/inventory/areas', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const key = getAreasSettingKey(warehouseId);
    const rawAreas = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const includeArchived = req.query.includeArchived === 'true';

    let areas = Array.isArray(rawAreas) ? rawAreas : [];
    if (!includeArchived) {
      areas = areas.filter((a) => a.status !== 'archived');
    }

    res.json({ data: areas, total: areas.length });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/areas', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const { name, description = '', items = [] } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw httpError(400, 'Nama Bagian / Area wajib diisi.');
    }

    const cleanName = name.trim();
    const key = getAreasSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const areas = Array.isArray(existing) ? existing : [];

    // Cek duplikasi nama pada area aktif
    const isDuplicate = areas.some(
      (a) => a.status !== 'archived' && a.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (isDuplicate) {
      throw httpError(409, `Bagian / Area dengan nama "${cleanName}" sudah ada.`);
    }

    const newArea = {
      id: crypto.randomUUID(),
      name: cleanName,
      description: String(description || '').trim(),
      status: 'active',
      items: Array.isArray(items) ? items : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    areas.push(newArea);
    await saveWorkspaceSettingValue(ownerId, key, areas, req.auth.user?.id);

    await writeActivityLog(req, {
      action: 'created',
      entityType: 'warehouse_area',
      entityId: newArea.id,
      entityName: newArea.name,
      metadata: { warehouseId, description: newArea.description, itemCount: newArea.items.length },
    });

    res.status(201).json({ data: newArea });
  } catch (error) {
    next(error);
  }
});

router.patch('/inventory/areas/:id', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const areaId = req.params.id;
    const { name, description, items, status } = req.body || {};

    const key = getAreasSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const areas = Array.isArray(existing) ? existing : [];

    const idx = areas.findIndex((a) => a.id === areaId);
    if (idx === -1) {
      throw httpError(404, 'Bagian / Area tidak ditemukan.');
    }

    const current = areas[idx];
    if (name && typeof name === 'string') {
      const cleanName = name.trim();
      const duplicate = areas.some(
        (a) => a.id !== areaId && a.status !== 'archived' && a.name.toLowerCase() === cleanName.toLowerCase()
      );
      if (duplicate) {
        throw httpError(409, `Nama Bagian / Area "${cleanName}" sudah digunakan.`);
      }
      current.name = cleanName;
    }

    if (description !== undefined) {
      current.description = String(description || '').trim();
    }

    if (Array.isArray(items)) {
      current.items = items;
    }

    if (status && ['active', 'archived'].includes(status)) {
      current.status = status;
    }

    current.updatedAt = new Date().toISOString();
    areas[idx] = current;

    await saveWorkspaceSettingValue(ownerId, key, areas, req.auth.user?.id);

    await writeActivityLog(req, {
      action: 'updated',
      entityType: 'warehouse_area',
      entityId: current.id,
      entityName: current.name,
      metadata: { warehouseId, status: current.status, itemCount: current.items.length },
    });

    res.json({ data: current });
  } catch (error) {
    next(error);
  }
});

router.patch('/inventory/areas/:id/status', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const areaId = req.params.id;
    const { status } = req.body || {};

    if (!['active', 'archived'].includes(status)) {
      throw httpError(400, 'Status harus "active" atau "archived".');
    }

    const key = getAreasSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const areas = Array.isArray(existing) ? existing : [];

    const idx = areas.findIndex((a) => a.id === areaId);
    if (idx === -1) {
      throw httpError(404, 'Bagian / Area tidak ditemukan.');
    }

    areas[idx].status = status;
    areas[idx].updatedAt = new Date().toISOString();

    await saveWorkspaceSettingValue(ownerId, key, areas, req.auth.user?.id);

    await writeActivityLog(req, {
      action: status === 'archived' ? 'deactivated' : 'activated',
      entityType: 'warehouse_area',
      entityId: areas[idx].id,
      entityName: areas[idx].name,
      metadata: { warehouseId, newStatus: status },
    });

    res.json({ data: areas[idx] });
  } catch (error) {
    next(error);
  }
});

router.delete('/inventory/areas/:id', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const areaId = req.params.id;

    const key = getAreasSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const areas = Array.isArray(existing) ? existing : [];

    const idx = areas.findIndex((a) => a.id === areaId);
    if (idx === -1) {
      throw httpError(404, 'Bagian / Area tidak ditemukan.');
    }

    // Soft delete / archive agar histori SO masa lampau tetap aman
    const deletedArea = areas[idx];
    deletedArea.status = 'archived';
    deletedArea.updatedAt = new Date().toISOString();
    areas[idx] = deletedArea;

    await saveWorkspaceSettingValue(ownerId, key, areas, req.auth.user?.id);

    await writeActivityLog(req, {
      action: 'archived',
      entityType: 'warehouse_area',
      entityId: deletedArea.id,
      entityName: deletedArea.name,
      metadata: { warehouseId },
    });

    res.json({ success: true, message: `Bagian "${deletedArea.name}" berhasil dinonaktifkan.` });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/areas/seed-samples', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const key = getAreasSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const areas = Array.isArray(existing) ? existing : [];

    // Ambil daftar file JSON stok rak di root project
    const rootDir = path.resolve(process.cwd(), '..');
    const knownFiles = [
      { file: 'stok_produk_Rak1.json', name: 'Rak 1' },
      { file: 'stok_produk_Rak2.json', name: 'Rak 2' },
      { file: 'stok_produk_Rak3.json', name: 'Rak 3' },
      { file: 'stok_produk_Rak4.json', name: 'Rak 4' },
      { file: 'stok_produk_Rak5.json', name: 'Rak 5' },
      { file: 'stok_produk_Rak6.json', name: 'Rak 6' },
      { file: 'stok_produk_Rak7.json', name: 'Rak 7' },
      { file: 'stok_produk_Rak8.json', name: 'Rak 8' },
      { file: 'stok_produk_Rak9.json', name: 'Rak 9' },
      { file: 'stok_produk_RakBedong.json', name: 'Rak Bedong' },
      { file: 'stok_produk_PK5.json', name: 'PK 5' },
    ];

    // Ambil katalog produk untuk mapping productId
    const { data: dbProducts } = await supabaseAdmin
      .from('products')
      .select('id, name, sku')
      .eq('owner_id', ownerId)
      .limit(2000);

    const productBySku = new Map();
    (dbProducts || []).forEach((p) => {
      if (p.sku) productBySku.set(p.sku.toUpperCase(), p);
    });

    let addedCount = 0;
    for (const kf of knownFiles) {
      const filePath = path.join(rootDir, kf.file);
      if (!fs.existsSync(filePath)) continue;

      // Cek apakah nama area ini sudah ada
      const alreadyHas = areas.some((a) => a.name.toLowerCase() === kf.name.toLowerCase());
      if (alreadyHas) continue;

      try {
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(rawContent);
        if (!Array.isArray(parsed)) continue;

        const items = parsed.map((it) => {
          const sku = String(it.sku || '').trim();
          const dbProd = productBySku.get(sku.toUpperCase());
          return {
            id: crypto.randomUUID(),
            productId: dbProd?.id || null,
            sku,
            name: it.name || dbProd?.name || sku,
            unit: it.unit || 'pcs',
            allocatedQty: Number(it.total ?? it.qty ?? 0),
          };
        });

        areas.push({
          id: crypto.randomUUID(),
          name: kf.name,
          description: `Diimpor otomatis dari berkas ${kf.file}`,
          status: 'active',
          items,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        addedCount++;
      } catch (err) {
        console.error(`[seed-samples] Gagal membaca ${kf.file}:`, err.message);
      }
    }

    if (addedCount > 0) {
      await saveWorkspaceSettingValue(ownerId, key, areas, req.auth.user?.id);
      await writeActivityLog(req, {
        action: 'seeded',
        entityType: 'warehouse_area',
        entityName: 'Seed Sample Areas',
        metadata: { warehouseId, addedCount },
      });
    }

    res.json({ data: areas, addedCount });
  } catch (error) {
    next(error);
  }
});

// ── Sesi Stock Opname (SO) Endpoints ─────────────────────────────────────────

router.get('/inventory/stock-opname/sessions', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const key = getSessionsSettingKey(warehouseId);
    const rawSessions = (await fetchWorkspaceSettingValue(ownerId, key)) || [];
    const sessions = Array.isArray(rawSessions) ? rawSessions : [];

    // Sort descending by createdAt
    sessions.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    // Hitung ringkasan metrik untuk setiap sesi
    const data = sessions.map((s) => {
      let totalAreas = s.areas?.length || 0;
      let completedAreas = 0;
      let totalItems = 0;
      let matchedItems = 0;
      let shortageItems = 0;
      let overageItems = 0;
      let notFoundItems = 0;
      let unlistedItems = 0;
      let totalSystemQty = 0;
      let totalPhysicalQty = 0;

      (s.areas || []).forEach((area) => {
        if (area.status === 'completed') completedAreas++;
        (area.items || []).forEach((it) => {
          totalItems++;
          const sys = Number(it.systemQty) || 0;
          const phys = it.physicalQty !== null && it.physicalQty !== undefined ? Number(it.physicalQty) : null;
          totalSystemQty += sys;

          if (phys !== null) {
            totalPhysicalQty += phys;
            if (it.isUnlisted) unlistedItems++;
            else if (it.status === 'not_found' || (phys === 0 && sys > 0)) notFoundItems++;
            else if (it.status === 'matched') matchedItems++;
            else if (it.status === 'shortage') shortageItems++;
            else if (it.status === 'overage') overageItems++;
          }
        });
      });

      const totalDiscrepancy = shortageItems + overageItems + notFoundItems + unlistedItems;
      const isBalanced = completedAreas === totalAreas && totalDiscrepancy === 0;

      return {
        id: s.id,
        sessionNumber: s.sessionNumber,
        warehouseId: s.warehouseId,
        title: s.title,
        notes: s.notes,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        finalizedAt: s.finalizedAt,
        finalizedByName: s.finalizedByName,
        summary: {
          totalAreas,
          completedAreas,
          pendingAreas: totalAreas - completedAreas,
          totalItems,
          matchedItems,
          shortageItems,
          overageItems,
          notFoundItems,
          unlistedItems,
          totalDiscrepancy,
          totalSystemQty,
          totalPhysicalQty,
          netDifference: totalPhysicalQty - totalSystemQty,
          isBalanced,
        },
      };
    });

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/stock-opname/sessions', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const { title, notes = '', products = [] } = req.body || {};

    const areasKey = getAreasSettingKey(warehouseId);
    const rawAreas = (await fetchWorkspaceSettingValue(ownerId, areasKey)) || [];
    const activeAreas = (Array.isArray(rawAreas) ? rawAreas : []).filter((a) => a.status !== 'archived');

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existingSessions = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existingSessions) ? existingSessions : [];

    // Generate Session Number: SO/YYYYMMDD/XXXX
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const datePrefix = `SO/${yyyy}${mm}${dd}`;

    const todayMatches = sessions.filter((s) => s.sessionNumber?.startsWith(datePrefix));
    const nextSeq = String(todayMatches.length + 1).padStart(4, '0');
    const sessionNumber = `${datePrefix}/${nextSeq}`;

    // Snapshot master areas ke dalam sesi jika sudah ada
    const sessionAreas = activeAreas.map((area) => ({
      areaId: area.id,
      areaName: area.name,
      status: 'pending', // 'pending' | 'in_progress' | 'completed'
      checkedAt: null,
      checkedBy: null,
      items: (area.items || []).map((it) => ({
        id: crypto.randomUUID(),
        productId: it.productId || null,
        sku: it.sku || '',
        name: it.name || it.sku,
        unit: it.unit || 'pcs',
        systemQty: Number(it.allocatedQty ?? it.systemQty ?? it.total ?? 0),
        physicalQty: null, // belum dicek
        difference: 0,
        status: 'pending',
        isUnlisted: false,
        notes: '',
      })),
    }));

    // Baseline seluruh produk gudang saat sesi ini dibuat
    const normalizedBaseline = (Array.isArray(products) ? products : []).map((p) => ({
      productId: p.id || p.productId || null,
      sku: p.sku || '',
      name: p.name || p.sku || 'Item',
      unit: p.unitKey || p.unit || 'pcs',
      systemQty: Math.max(0, Number(p.stock ?? p.systemQty ?? 0)),
    }));

    const newSession = {
      id: crypto.randomUUID(),
      sessionNumber,
      warehouseId: warehouseId || null,
      title: String(title || '').trim() || `Stock Opname - ${now.toLocaleDateString('id-ID')}`,
      notes: String(notes || '').trim(),
      status: 'in_progress', // 'draft', 'in_progress', 'review', 'finalized'
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      finalizedAt: null,
      finalizedBy: null,
      finalizedByName: null,
      baselineProducts: normalizedBaseline,
      areas: sessionAreas,
    };

    sessions.unshift(newSession);
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    await writeActivityLog(req, {
      action: 'created',
      entityType: 'stock_opname',
      entityId: newSession.id,
      entityName: newSession.sessionNumber,
      metadata: { warehouseId, title: newSession.title, totalAreas: sessionAreas.length, totalProducts: normalizedBaseline.length },
    });

    res.status(201).json({ data: newSession });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/stock-opname/sessions/:id/sync-baseline', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { products = [] } = req.body || {};

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) {
      throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');
    }

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diperbarui baseline-nya.');
    }

    session.baselineProducts = (Array.isArray(products) ? products : []).map((p) => ({
      productId: p.id || p.productId || null,
      sku: p.sku || '',
      name: p.name || p.sku || 'Item',
      unit: p.unitKey || p.unit || 'pcs',
      systemQty: Math.max(0, Number(p.stock ?? p.systemQty ?? 0)),
    }));
    session.updatedAt = new Date().toISOString();

    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.json({ message: 'Baseline produk sesi berhasil disinkronkan.', data: session });
  } catch (error) {
    next(error);
  }
});

router.get('/inventory/stock-opname/sessions/:id', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');
    }

    // 1. Rekapitulasi per Produk (Multi-Area Aggregator)
    const productMap = new Map();

    // Inisialisasi dari baseline seluruh produk gudang jika ada
    (session.baselineProducts || []).forEach((base) => {
      const skuKey = (base.sku || base.productId || 'UNKNOWN').toUpperCase();
      productMap.set(skuKey, {
        productId: base.productId || null,
        sku: base.sku || '',
        name: base.name || base.sku || 'Item',
        unit: base.unit || 'pcs',
        totalSystemQty: Number(base.systemQty) || 0,
        totalPhysicalQty: 0,
        hasBeenCounted: false,
        locations: [],
      });
    });

    // Jika sesi belum difinalisasi, sinkronkan totalSystemQty dengan pergerakan stok live gudang terkini
    if (session.status !== 'finalized') {
      try {
        const activeWhId = session.warehouseId || req.query.warehouse_id || warehouseId;
        let docQuery = supabaseAdmin
          .from('documents')
          .select('id, document_type, status, items:document_items(product_id, quantity, metadata)')
          .eq('owner_id', ownerId)
          .eq('status', 'completed')
          .in('document_type', ['goods_in', 'goods_out']);
        if (activeWhId) {
          docQuery = docQuery.eq('warehouse_id', activeWhId);
        }
        const { data: liveDocs } = await docQuery;

        const { multipliers } = await getWorkspaceUnits(ownerId, activeWhId);
        const liveStockByProductId = new Map();

        if (Array.isArray(liveDocs)) {
          liveDocs.forEach((doc) => {
            const isGoodsIn = doc.document_type === 'goods_in';
            (doc.items || []).forEach((di) => {
              const pId = di.product_id;
              if (!pId) return;
              const rawQty = di.metadata?.qtyInput ?? di.quantity ?? 1;
              const unit = di.metadata?.qtyUnit || 'pcs';
              const mult = multipliers[unit] || multipliers[String(unit).toLowerCase()] || 1;
              const pcs = Number(rawQty) * mult;
              const curr = liveStockByProductId.get(pId) || 0;
              liveStockByProductId.set(pId, curr + (isGoodsIn ? pcs : -pcs));
            });
          });
        }

        // Query status nomor seri aktif di gudang ini untuk produk ber-seri
        let serialQuery = supabaseAdmin
          .from('product_serials')
          .select('product_id, metadata, warehouse_id')
          .eq('owner_id', ownerId)
          .eq('status', 'available');
        if (activeWhId) {
          serialQuery = serialQuery.eq('warehouse_id', activeWhId);
        }
        const { data: dbAvailableSerials } = await serialQuery;
        const serialStockByProductId = new Map();
        const hasSerialsProductIdSet = new Set();
        if (Array.isArray(dbAvailableSerials)) {
          dbAvailableSerials.forEach((s) => {
            if (!s.product_id) return;
            hasSerialsProductIdSet.add(s.product_id);
            const u = s.metadata?.serialUnit || s.metadata?.unit || 'pcs';
            const mult = multipliers[u] || multipliers[String(u).toLowerCase()] || (u.startsWith('bal10') ? 120 : u.startsWith('bal15') ? 180 : u.startsWith('bal20') ? 240 : u.startsWith('bal') ? 300 : u.startsWith('pack') ? 60 : 1);
            serialStockByProductId.set(s.product_id, (serialStockByProductId.get(s.product_id) || 0) + mult);
          });
        }

        const { data: dbProducts } = await supabaseAdmin
          .from('products')
          .select('id, sku, name, unit, stock')
          .eq('owner_id', ownerId);

        const dbProdBySku = new Map();
        (dbProducts || []).forEach((dp) => {
          if (dp.sku) dbProdBySku.set(dp.sku.toUpperCase(), dp);
        });

        // Update productMap dengan stok live (prioritas: serial number aktif jika produk ber-seri)
        for (const [skuKey, p] of productMap.entries()) {
          const prodId = p.productId || dbProdBySku.get(skuKey)?.id;
          let liveStock = null;

          if (prodId && hasSerialsProductIdSet.has(prodId)) {
            liveStock = serialStockByProductId.get(prodId) || 0;
          } else if (p.productId && liveStockByProductId.has(p.productId)) {
            liveStock = Math.max(0, liveStockByProductId.get(p.productId));
          } else if (dbProdBySku.has(skuKey)) {
            const dp = dbProdBySku.get(skuKey);
            if (dp.id && hasSerialsProductIdSet.has(dp.id)) {
              liveStock = serialStockByProductId.get(dp.id) || 0;
            } else if (dp.id && liveStockByProductId.has(dp.id)) {
              liveStock = Math.max(0, liveStockByProductId.get(dp.id));
            } else if (dp.stock !== undefined && dp.stock !== null) {
              liveStock = activeWhId ? 0 : Math.max(0, Number(dp.stock));
            }
          }

          if (liveStock !== null) {
            p.totalSystemQty = liveStock;
          }
        }

        // Tambahkan produk baru yang ada di katalog/dokumen jika belum ada di baseline
        (dbProducts || []).forEach((dp) => {
          const skuKey = (dp.sku || dp.id).toUpperCase();
          if (!productMap.has(skuKey)) {
            let liveStock;
            if (hasSerialsProductIdSet.has(dp.id)) {
              liveStock = serialStockByProductId.get(dp.id) || 0;
            } else if (liveStockByProductId.has(dp.id)) {
              liveStock = Math.max(0, liveStockByProductId.get(dp.id));
            } else {
              liveStock = activeWhId ? 0 : Math.max(0, Number(dp.stock) || 0);
            }

            productMap.set(skuKey, {
              productId: dp.id,
              sku: dp.sku || '',
              name: dp.name || dp.sku || 'Item',
              unit: dp.unit || 'pcs',
              totalSystemQty: liveStock,
              totalPhysicalQty: 0,
              hasBeenCounted: false,
              locations: [],
            });
          }
        });
      } catch (syncErr) {
        console.warn('[SO Session Detail] Error synchronizing live stock:', syncErr);
      }
    }

    let completedAreasCount = 0;
    const totalAreasCount = session.areas?.length || 0;

    // Loop semua area yang diperiksa di sesi ini
    (session.areas || []).forEach((area) => {
      if (area.status === 'completed') completedAreasCount++;

      (area.items || []).forEach((item) => {
        const skuKey = (item.sku || item.productId || 'UNKNOWN').toUpperCase();
        const phys = item.physicalQty !== null && item.physicalQty !== undefined ? Number(item.physicalQty) : null;

        if (!productMap.has(skuKey)) {
          // Produk temuan baru di area yang tidak ada di baseline awal
          productMap.set(skuKey, {
            productId: item.productId || null,
            sku: item.sku || '',
            name: item.name || item.sku || 'Item',
            unit: item.unit || 'pcs',
            totalSystemQty: Number(item.systemQty) || 0,
            totalPhysicalQty: 0,
            hasBeenCounted: false,
            locations: [],
          });
        }

        const prodGroup = productMap.get(skuKey);
        if (!prodGroup.scannedSerials) prodGroup.scannedSerials = [];

        if (phys !== null) {
          if (Array.isArray(item.scannedSerials)) {
            prodGroup.scannedSerials.push(...item.scannedSerials);
          }
          prodGroup.totalPhysicalQty += phys;
          prodGroup.hasBeenCounted = true;
          prodGroup.locations.push({
            areaId: area.areaId,
            areaName: area.areaName,
            physicalQty: phys,
            difference: item.difference ?? (phys - (Number(item.systemQty) || 0)),
            status: item.status,
            isUnlisted: item.isUnlisted || false,
            notes: item.notes || '',
            scannedSerials: item.scannedSerials || [],
          });
        }
      });
    });

    let totalSystemQty = 0;
    let totalPhysicalQty = 0;
    const discrepancyItems = [];

    const productSummary = Array.from(productMap.values()).map((p) => {
      totalSystemQty += p.totalSystemQty;
      totalPhysicalQty += p.totalPhysicalQty;

      const diff = p.hasBeenCounted ? p.totalPhysicalQty - p.totalSystemQty : 0;
      let status = 'pending';

      if (!p.hasBeenCounted) {
        status = 'pending';
      } else if (diff === 0) {
        status = 'matched';
      } else if (diff < 0) {
        status = 'shortage';
      } else {
        status = 'overage';
      }

      const itemSummary = {
        ...p,
        scannedSerials: Array.from(new Set(p.scannedSerials || [])),
        difference: diff,
        status,
      };

      // Catat sebagai barang bermasalah jika ada selisih atau belum ditemukan
      if (status === 'shortage' || status === 'overage' || (status === 'pending' && p.totalSystemQty > 0)) {
        discrepancyItems.push({
          productId: p.productId,
          sku: p.sku,
          name: p.name,
          unit: p.unit,
          systemQty: p.totalSystemQty,
          physicalQty: p.totalPhysicalQty,
          difference: diff,
          status,
          locations: p.locations,
          scannedSerials: Array.from(new Set(p.scannedSerials || [])),
        });
      }

      return itemSummary;
    });

    // Urutkan discrepancyItems berdasarkan keparahan (shortage dulu, overage, pending)
    discrepancyItems.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name));

    const netDifference = totalPhysicalQty - totalSystemQty;
    const isBalanced = discrepancyItems.length === 0;

    const warehouseReconciliation = {
      isBalanced,
      totalSystemQty,
      totalPhysicalQty,
      netDifference,
      discrepancyCount: discrepancyItems.length,
      completedAreasCount,
      totalAreasCount,
      completionPercent: totalAreasCount > 0 ? Math.round((completedAreasCount / totalAreasCount) * 100) : 0,
    };

    res.json({
      data: session,
      productSummary,
      discrepancyItems,
      warehouseReconciliation,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/inventory/stock-opname/sessions/:id/area-count', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { areaId, items = [], markCompleted = false, replaceItems = false } = req.body || {};

    if (!areaId) {
      throw httpError(400, 'areaId wajib disertakan.');
    }

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) {
      throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');
    }

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diubah.');
    }

    const areaIdx = (session.areas || []).findIndex((a) => a.areaId === areaId || a.id === areaId);
    if (areaIdx === -1) {
      throw httpError(404, 'Bagian / Area tidak ditemukan dalam sesi ini.');
    }

    const targetArea = session.areas[areaIdx];

    let updatedItems = [];

    if (replaceItems) {
      // Modus ganti penuh (misalnya saat SO ulang / reset area)
      updatedItems = items.map((it) => {
        const sys = Number(it.systemQty) || 0;
        const rawPhys = it.physicalQty;
        const phys = rawPhys === null || rawPhys === undefined || rawPhys === '' ? null : Number(rawPhys);
        let diff = 0;
        let status = 'pending';
        if (phys !== null && !isNaN(phys)) {
          diff = phys - sys;
          if (it.isUnlisted) status = 'unlisted';
          else if (diff === 0) status = 'matched';
          else if (diff < 0) status = 'shortage';
          else status = 'overage';
        }
        return {
          id: it.id || crypto.randomUUID(),
          productId: it.productId || null,
          sku: it.sku || '',
          name: it.name || it.sku || 'Item',
          unit: it.unit || 'pcs',
          systemQty: sys,
          physicalQty: phys,
          difference: diff,
          status,
          isUnlisted: Boolean(it.isUnlisted),
          notes: String(it.notes || '').trim(),
          scannedSerials: phys !== null && Array.isArray(it.scannedSerials) ? it.scannedSerials : [],
          serialUnits: phys !== null && it.serialUnits ? it.serialUnits : {},
          manualQty: phys !== null && it.manualQty !== undefined && it.manualQty !== null ? it.manualQty : null,
          manualUnit: it.manualUnit || 'pcs',
          manualEntries: phys !== null && Array.isArray(it.manualEntries) ? it.manualEntries : [],
        };
      });
    } else {
      // Modus inkremental normal
      const inputMap = new Map();
      items.forEach((it) => {
        if (it.id) inputMap.set(it.id, it);
        if (it.sku) inputMap.set(it.sku.toUpperCase(), it);
      });

      const handledIds = new Set();
      const handledSkus = new Set();

      updatedItems = (targetArea.items || [])
        .filter((existingItem) => {
          // Jika unlisted dan tidak ada di inputMap, hapus item tersebut
          if (existingItem.isUnlisted) {
            return inputMap.has(existingItem.id) || (existingItem.sku && inputMap.has(existingItem.sku.toUpperCase()));
          }
          return true;
        })
        .map((existingItem) => {
          const input = inputMap.get(existingItem.id) || (existingItem.sku ? inputMap.get(existingItem.sku.toUpperCase()) : null);
          if (existingItem.id) handledIds.add(existingItem.id);
          if (existingItem.sku) handledSkus.add(existingItem.sku.toUpperCase());

          if (!input) return existingItem;

          const sys = Number(existingItem.systemQty) || 0;
          const rawPhys = input.physicalQty;
          const phys = rawPhys === null || rawPhys === undefined || rawPhys === '' ? null : Number(rawPhys);

          let diff = 0;
          let status = 'pending';

          if (phys !== null && !isNaN(phys)) {
            diff = phys - sys;
            if (existingItem.isUnlisted) {
              status = 'unlisted';
            } else if (phys === 0 && sys > 0) {
              status = 'not_found';
            } else if (diff === 0) {
              status = 'matched';
            } else if (diff < 0) {
              status = 'shortage';
            } else {
              status = 'overage';
            }
          }

          return {
            ...existingItem,
            physicalQty: phys,
            difference: diff,
            status,
            notes: input.notes !== undefined ? String(input.notes).trim() : existingItem.notes,
            scannedSerials: phys !== null && Array.isArray(input.scannedSerials)
              ? input.scannedSerials
              : (phys !== null ? (existingItem.scannedSerials || []) : []),
            serialUnits: phys !== null && input.serialUnits
              ? input.serialUnits
              : (phys !== null ? (existingItem.serialUnits || {}) : {}),
            manualQty: phys !== null && input.manualQty !== undefined && input.manualQty !== null
              ? input.manualQty
              : (phys !== null ? (existingItem.manualQty ?? null) : null),
            manualUnit: input.manualUnit || existingItem.manualUnit || 'pcs',
            manualEntries: phys !== null && Array.isArray(input.manualEntries)
              ? input.manualEntries
              : (phys !== null ? (Array.isArray(existingItem.manualEntries) ? existingItem.manualEntries : []) : []),
          };
        });

      // Tambahkan item-item baru yang ditambahkan di area ini selama penghitungan
      items.forEach((it) => {
        const isAlreadyHandled = (it.id && handledIds.has(it.id)) || (it.sku && handledSkus.has(it.sku.toUpperCase()));
        if (isAlreadyHandled) return;

        const rawPhys = it.physicalQty;
        const phys = rawPhys === null || rawPhys === undefined || rawPhys === '' ? null : Number(rawPhys);
        const sys = Number(it.systemQty) || 0;
        const diff = phys !== null ? phys - sys : 0;
        let status = 'pending';
        if (phys !== null && !isNaN(phys)) {
          if (it.isUnlisted) status = 'unlisted';
          else if (diff === 0) status = 'matched';
          else if (diff < 0) status = 'shortage';
          else status = 'overage';
        }

        updatedItems.push({
          id: it.id || crypto.randomUUID(),
          productId: it.productId || null,
          sku: it.sku || '',
          name: it.name || it.sku || 'Item',
          unit: it.unit || 'pcs',
          systemQty: sys,
          physicalQty: phys,
          difference: diff,
          status,
          isUnlisted: Boolean(it.isUnlisted),
          notes: String(it.notes || '').trim(),
          scannedSerials: phys !== null && Array.isArray(it.scannedSerials) ? it.scannedSerials : [],
          serialUnits: phys !== null && it.serialUnits ? it.serialUnits : {},
          manualQty: phys !== null && it.manualQty !== undefined && it.manualQty !== null ? it.manualQty : null,
          manualUnit: it.manualUnit || 'pcs',
          manualEntries: phys !== null && Array.isArray(it.manualEntries) ? it.manualEntries : [],
        });
      });
    }

    targetArea.items = updatedItems;
    const hasAnyPhysicalCount = updatedItems.some((it) => it.physicalQty !== null && it.physicalQty !== undefined);

    if (markCompleted) {
      targetArea.status = 'completed';
      targetArea.checkedAt = new Date().toISOString();
      targetArea.checkedBy = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'Petugas';
    } else if (hasAnyPhysicalCount) {
      targetArea.status = 'in_progress';
      targetArea.checkedAt = null;
      targetArea.checkedBy = null;
    } else {
      targetArea.status = 'pending';
      targetArea.checkedAt = null;
      targetArea.checkedBy = null;
    }

    session.areas[areaIdx] = targetArea;
    session.updatedAt = new Date().toISOString();

    // Jika seluruh area selesai, ubah status sesi ke review otomatis; jika tidak, kembalikan ke in_progress
    const allCompleted = session.areas.length > 0 && session.areas.every((a) => a.status === 'completed');
    if (allCompleted && session.status === 'in_progress') {
      session.status = 'review';
    } else if (!allCompleted && session.status === 'review') {
      session.status = 'in_progress';
    }

    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.json({ data: session, area: targetArea });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/stock-opname/sessions/:id/add-unlisted-item', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { areaId, productId, sku, name, unit = 'pcs', systemQty = 0, physicalQty = 1, notes = '', manualQty, manualUnit, manualEntries } = req.body || {};

    if (!areaId) throw httpError(400, 'areaId wajib disertakan.');
    if (!sku && !name) throw httpError(400, 'SKU atau Nama Barang wajib diisi.');

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat ditambah temuan.');
    }

    const areaIdx = (session.areas || []).findIndex((a) => a.areaId === areaId);
    if (areaIdx === -1) throw httpError(404, 'Area tidak ditemukan dalam sesi ini.');

    const sQty = Number(systemQty) || 0;
    const pQty = Number(physicalQty) || 0;
    const diff = pQty - sQty;
    const isUnlisted = sQty === 0;
    const itemStatus = isUnlisted
      ? 'unlisted'
      : (pQty === sQty ? 'match' : (pQty < sQty ? (pQty === 0 ? 'not_found' : 'shortage') : 'overage'));

    const unlistedItem = {
      id: crypto.randomUUID(),
      productId: productId || null,
      sku: String(sku || '').trim(),
      name: String(name || sku || 'Barang').trim(),
      unit: unit || 'pcs',
      systemQty: sQty,
      physicalQty: pQty,
      difference: diff,
      status: itemStatus,
      isUnlisted: isUnlisted,
      notes: String(notes || (isUnlisted ? 'Temuan fisik tidak terdaftar di lokasi ini' : '')).trim(),
      manualQty: manualQty !== undefined && manualQty !== null ? manualQty : String(pQty),
      manualUnit: manualUnit || unit || 'pcs',
      manualEntries: Array.isArray(manualEntries)
        ? manualEntries
        : [{ id: crypto.randomUUID(), qty: String(pQty), unit: manualUnit || unit || 'pcs' }],
    };

    session.areas[areaIdx].items.push(unlistedItem);
    session.updatedAt = new Date().toISOString();

    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.status(201).json({ data: session, item: unlistedItem });
  } catch (error) {
    next(error);
  }
});

// Tambah Bagian / Area baru langsung dari dalam sesi SO aktif
router.post('/inventory/stock-opname/sessions/:id/areas', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { name, description = '', items = [] } = req.body || {};

    if (!name || !String(name).trim()) {
      throw httpError(400, 'Nama Bagian / Area wajib diisi.');
    }

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existingSessions = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existingSessions) ? existingSessions : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diubah.');
    }

    const cleanName = String(name).trim();

    // 1. Sinkronkan ke Master Area gudang permanen
    const areasKey = getAreasSettingKey(warehouseId);
    const rawAreas = (await fetchWorkspaceSettingValue(ownerId, areasKey)) || [];
    let masterAreas = Array.isArray(rawAreas) ? rawAreas : [];

    let targetMasterArea = masterAreas.find((a) => a.name?.toLowerCase() === cleanName.toLowerCase());
    if (!targetMasterArea) {
      targetMasterArea = {
        id: crypto.randomUUID(),
        name: cleanName,
        description: String(description || '').trim(),
        status: 'active',
        items: (items || []).map((it) => ({
          productId: it.productId || null,
          sku: it.sku || '',
          name: it.name || it.sku,
          unit: it.unit || 'pcs',
          allocatedQty: Number(it.systemQty ?? it.allocatedQty ?? 0),
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      masterAreas.push(targetMasterArea);
    } else {
      targetMasterArea.status = 'active';
      const existingProductIds = new Set((targetMasterArea.items || []).map((it) => it.productId).filter(Boolean));
      (items || []).forEach((it) => {
        if (it.productId && !existingProductIds.has(it.productId)) {
          targetMasterArea.items.push({
            productId: it.productId,
            sku: it.sku || '',
            name: it.name || it.sku,
            unit: it.unit || 'pcs',
            allocatedQty: Number(it.systemQty ?? it.allocatedQty ?? 0),
          });
          existingProductIds.add(it.productId);
        }
      });
      targetMasterArea.updatedAt = new Date().toISOString();
    }
    await saveWorkspaceSettingValue(ownerId, areasKey, masterAreas, req.auth.user?.id);

    // 2. Tambahkan ke sesi SO
    if (!session.areas) session.areas = [];
    const existingInSession = session.areas.find((a) => a.areaName?.toLowerCase() === cleanName.toLowerCase());
    if (existingInSession) {
      throw httpError(400, `Area "${cleanName}" sudah ada dalam sesi Stock Opname ini.`);
    }

    const newSessionArea = {
      areaId: targetMasterArea.id,
      areaName: cleanName,
      status: 'pending',
      checkedAt: null,
      checkedBy: null,
      items: (items && items.length > 0 ? items : targetMasterArea.items || []).map((it) => ({
        id: crypto.randomUUID(),
        productId: it.productId || null,
        sku: it.sku || '',
        name: it.name || it.sku,
        unit: it.unit || 'pcs',
        systemQty: Number(it.systemQty ?? it.allocatedQty ?? 0),
        physicalQty: null,
        difference: 0,
        status: 'pending',
        isUnlisted: false,
        notes: '',
      })),
    };

    session.areas.push(newSessionArea);
    session.updatedAt = new Date().toISOString();

    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.status(201).json({ success: true, data: session, area: newSessionArea });
  } catch (error) {
    next(error);
  }
});

// Hapus Bagian / Area dari sesi SO
router.delete('/inventory/stock-opname/sessions/:id/areas/:areaId', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const areaId = req.params.areaId;

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existingSessions = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existingSessions) ? existingSessions : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diubah.');
    }

    session.areas = (session.areas || []).filter((a) => a.areaId !== areaId && a.id !== areaId);
    session.updatedAt = new Date().toISOString();

    const allCompleted = session.areas.length > 0 && session.areas.every((a) => a.status === 'completed');
    if (!allCompleted && session.status === 'review') {
      session.status = 'in_progress';
    }

    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
});

router.patch('/inventory/stock-opname/sessions/:id/status', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { status } = req.body || {};

    if (!['draft', 'in_progress', 'review'].includes(status)) {
      throw httpError(400, 'Status tidak valid.');
    }

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    if (sessions[sessionIdx].status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diubah statusnya.');
    }

    sessions[sessionIdx].status = status;
    sessions[sessionIdx].updatedAt = new Date().toISOString();

    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.json({ data: sessions[sessionIdx] });
  } catch (error) {
    next(error);
  }
});

// Keluarkan barang & serial number yang tidak terdeteksi fisik saat SO (Write-Off Ghost Serials & Shortages)
router.post('/inventory/stock-opname/sessions/:id/write-off-missing', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const {
      items = [],
      defaultReason = 'missing_physical_so',
      createGoodsOutDoc = true,
      notes = '',
      force = false,
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'Daftar barang yang akan dikeluarkan (items) tidak boleh kosong.');
    }

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat diubah.');
    }

    // Safety guard: periksa apakah seluruh area telah berstatus 'completed'
    const uncompletedAreas = (session.areas || []).filter((a) => a.status !== 'completed');
    if (uncompletedAreas.length > 0 && !force) {
      return res.status(400).json({
        error: {
          code: 'UNCOMPLETED_AREAS',
          message: `Masih ada ${uncompletedAreas.length} Bagian / Area yang belum selesai diperiksa fisik. Selesaikan seluruh area terlebih dahulu sebelum mengeluarkan barang hilang.`,
          uncompletedAreas: uncompletedAreas.map((a) => ({ id: a.areaId || a.id, name: a.areaName || a.name })),
        },
      });
    }

    const now = new Date().toISOString();
    const userId = req.auth.user?.id;
    const userName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'Petugas Gudang';
    const { multipliers, parseUnitFromSn } = await getWorkspaceUnits(ownerId, warehouseId);

    // Kumpulkan ID Dokumen Goods In yang merupakan temuan sesi SO ini agar serial barunya tidak sengaja dikeluarkan
    const { data: soGiDocs } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('document_type', 'goods_in')
      .or(`metadata->>stock_opname_session_id.eq.${sessionId},metadata->>stock_opname_session_number.eq.${session.sessionNumber || ''}`);
    const protectedGiDocIds = new Set((soGiDocs || []).map((d) => d.id));

    const processedProducts = [];
    const allWrittenOffSerials = [];
    let totalWrittenOffPcs = 0;

    // 1. Loop per item dan kumpulkan serial & kuantitas non-seri
    for (const item of items) {
      const serialNumbers = (item.serialNumbers || []).map((s) => String(s).trim()).filter(Boolean);
      const nonSerialQty = Math.max(0, Number(item.nonSerialQty) || 0);
      const unit = item.unit || 'pcs';
      const nonSerialMult = multipliers[unit] || 1;
      const nonSerialPcs = nonSerialQty * nonSerialMult;
      const itemReason = item.reason || defaultReason;

      let productId = item.productId || null;
      let prodRecord = null;

      if (productId) {
        const { data: p } = await supabaseAdmin
          .from('products')
          .select('id, name, sku, stock, metadata')
          .eq('id', productId)
          .eq('owner_id', ownerId)
          .maybeSingle();
        prodRecord = p;
      } else if (item.sku) {
        const { data: p } = await supabaseAdmin
          .from('products')
          .select('id, name, sku, stock, metadata')
          .eq('owner_id', ownerId)
          .ilike('sku', String(item.sku).trim())
          .maybeSingle();
        if (p) {
          prodRecord = p;
          productId = p.id;
        }
      }

      let serialsDeductedPcs = 0;
      const validSerialsInItem = [];

      if (serialNumbers.length > 0) {
        // Ambil data nomor seri dari database
        const { data: foundSerials } = await supabaseAdmin
          .from('product_serials')
          .select('id, serial_number, product_id, metadata, status, goods_in_document_id')
          .eq('owner_id', ownerId)
          .in('serial_number', serialNumbers);

        for (const sRec of foundSerials || []) {
          // Proteksi: Jangan keluarkan nomor seri yang baru dibuat dari temuan Goods In sesi SO ini!
          if (sRec.goods_in_document_id && protectedGiDocIds.has(sRec.goods_in_document_id)) {
            continue;
          }

          const cleanSN = sRec.serial_number;
          const sUnit = parseUnitFromSn(cleanSN) || sRec.metadata?.serialUnit || 'pcs';
          const sMult = multipliers[sUnit] || 1;
          serialsDeductedPcs += sMult;
          validSerialsInItem.push({
            id: sRec.id,
            serialNumber: cleanSN,
            unit: sUnit,
            pcs: sMult,
          });
          allWrittenOffSerials.push({
            id: sRec.id,
            serialNumber: cleanSN,
            productId: sRec.product_id || productId,
            unit: sUnit,
            pcs: sMult,
            reason: itemReason,
          });

          // Update status nomor seri di DB menjadi 'damaged' atau 'out'
          const serialTargetStatus = itemReason === 'damaged' ? 'damaged' : 'out';
          await supabaseAdmin
            .from('product_serials')
            .update({
              status: serialTargetStatus,
              metadata: {
                ...(sRec.metadata || {}),
                writtenOffBySO: session.sessionNumber || session.id,
                writtenOffAt: now,
                writtenOffBy: userId,
                writtenOffByName: userName,
                writeOffReason: itemReason,
              },
              updated_at: now,
            })
            .eq('id', sRec.id)
            .eq('owner_id', ownerId);
        }
      }

      const totalItemDeductedPcs = serialsDeductedPcs + nonSerialPcs;
      totalWrittenOffPcs += totalItemDeductedPcs;

      // Update stok pada tabel products jika produk ditemukan
      if (prodRecord && totalItemDeductedPcs > 0) {
        const curStock = Number(prodRecord.stock || 0);
        const curSerials = Number(prodRecord.metadata?.stockSerials ?? 0);
        const curNonSerial = Number(prodRecord.metadata?.stockNonSerial ?? prodRecord.stock ?? 0);

        const newStock = Math.max(0, curStock - totalItemDeductedPcs);
        const newSerials = Math.max(0, curSerials - serialsDeductedPcs);
        const newNonSerial = Math.max(0, curNonSerial - nonSerialPcs);

        await supabaseAdmin
          .from('products')
          .update({
            stock: newStock,
            metadata: {
              ...(prodRecord.metadata || {}),
              stockSerials: newSerials,
              stockNonSerial: newNonSerial,
              lastStockOpnameWriteOff: now,
            },
            updated_at: now,
          })
          .eq('id', prodRecord.id)
          .eq('owner_id', ownerId);
      }

      processedProducts.push({
        productId,
        sku: item.sku || prodRecord?.sku || '',
        name: item.name || prodRecord?.name || 'Barang',
        serials: validSerialsInItem,
        serialsCount: validSerialsInItem.length,
        nonSerialQty,
        nonSerialUnit: unit,
        nonSerialPcs,
        totalDeductedPcs: totalItemDeductedPcs,
        reason: itemReason,
      });
    }

    let createdDoc = null;

    // 2. Jika opsi penerbitan dokumen Goods Out aktif, buat dokumen resmi bertipe write-off
    if (createGoodsOutDoc && totalWrittenOffPcs > 0) {
      const todayISO = now.slice(0, 10);
      const todayFormatted = todayISO.replace(/-/g, '');
      let docNumber = `GO/${todayFormatted}/${String(Math.floor(Math.random() * 9000) + 1000)}`;

      const docPayload = {
        documentType: 'goods_out',
        documentNumber: docNumber,
        contactId: null,
        contactName: `Stock Opname Write-Off (${session.sessionNumber || 'SO'})`,
        status: 'completed',
        issueDate: todayISO,
        notes: `Penghapusan / Write-Off barang hilang hasil Stock Opname Sesi ${session.sessionNumber || ''} (${session.title || ''}). ${notes}`.trim(),
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 0,
        metadata: {
          source: 'stock_opname_write_off',
          stock_opname_session_id: session.id,
          stock_opname_session_number: session.sessionNumber,
          writtenOffBy: userName,
          writtenOffAt: now,
        },
      };

      let insertDocRes = await supabaseAdmin
        .from('documents')
        .insert({
          ...documentPayload(docPayload),
          created_by: userId,
          owner_id: ownerId,
          warehouse_id: warehouseId,
        })
        .select('*')
        .single();

      // Retry suffix jika bentrok nomor dokumen
      if (insertDocRes.error && (insertDocRes.error.code === '23505' || String(insertDocRes.error.message).includes('unique'))) {
        for (let att = 1; att <= 5; att++) {
          docNumber = `GO/${todayFormatted}/${String(Math.floor(Math.random() * 9000) + 1000)}-${att}`;
          insertDocRes = await supabaseAdmin
            .from('documents')
            .insert({
              ...documentPayload({ ...docPayload, documentNumber: docNumber }),
              created_by: userId,
              owner_id: ownerId,
              warehouse_id: warehouseId,
            })
            .select('*')
            .single();
          if (!insertDocRes.error) break;
        }
      }

      if (!insertDocRes.error && insertDocRes.data) {
        createdDoc = insertDocRes.data;

        // Insert document items
        const docItemsPayload = [];
        let sortIdx = 0;

        for (const p of processedProducts) {
          // Item untuk tiap serial
          for (const s of p.serials) {
            docItemsPayload.push(
              documentItemPayload(createdDoc.id, {
                productId: p.productId,
                itemName: `${p.name} (SN: ${s.serialNumber})`,
                sku: p.sku,
                quantity: 1,
                unitPrice: 0,
                sortOrder: sortIdx++,
                metadata: {
                  isSerial: true,
                  serialNumber: s.serialNumber,
                  qtyUnit: s.unit,
                  unitMultiplier: multipliers[s.unit] || 1,
                  qtyInput: 1,
                  baseQuantity: s.pcs,
                  reason: p.reason,
                },
              })
            );
          }
          // Item untuk non-seri jika ada
          if (p.nonSerialQty > 0) {
            docItemsPayload.push(
              documentItemPayload(createdDoc.id, {
                productId: p.productId,
                itemName: `${p.name} (Non-Seri)`,
                sku: p.sku,
                quantity: p.nonSerialQty,
                unitPrice: 0,
                sortOrder: sortIdx++,
                metadata: {
                  isSerial: false,
                  qtyUnit: p.nonSerialUnit,
                  unitMultiplier: p.nonSerialPcs / p.nonSerialQty,
                  qtyInput: p.nonSerialQty,
                  baseQuantity: p.nonSerialPcs,
                  reason: p.reason,
                },
              })
            );
          }
        }

        if (docItemsPayload.length > 0) {
          const { data: createdItems } = await supabaseAdmin.from('document_items').insert(docItemsPayload).select('*');
          // Link serials ke document_id & document_item_id
          if (createdItems && createdItems.length > 0) {
            for (const ci of createdItems) {
              const sn = ci.metadata?.serialNumber;
              if (sn) {
                await supabaseAdmin
                  .from('product_serials')
                  .update({
                    goods_out_document_id: createdDoc.id,
                    goods_out_item_id: ci.id,
                  })
                  .eq('owner_id', ownerId)
                  .eq('serial_number', sn);
              }
            }
          }
        }
      }
    }

    // 3. Simpan riwayat write-off ke dalam session SO
    session.metadata = session.metadata || {};
    const writeOffRecord = {
      id: crypto.randomUUID(),
      executedAt: now,
      executedBy: userId,
      executedByName: userName,
      documentId: createdDoc?.id || null,
      documentNumber: createdDoc?.document_number || null,
      defaultReason,
      notes,
      totalSerialsCount: allWrittenOffSerials.length,
      totalPcs: totalWrittenOffPcs,
      products: processedProducts,
    };

    session.metadata.writtenOffSummary = Array.isArray(session.metadata.writtenOffSummary)
      ? [...session.metadata.writtenOffSummary, writeOffRecord]
      : [writeOffRecord];

    session.updatedAt = now;
    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, userId);

    // Invalidate serial cache
    invalidateWarehouseSerialIndex(ownerId);

    res.json({
      data: session,
      summary: writeOffRecord,
      document: createdDoc,
      message: `Berhasil mengeluarkan ${allWrittenOffSerials.length} nomor seri (${totalWrittenOffPcs} pcs) yang tidak ditemukan saat Stock Opname.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory/stock-opname/sessions/:id/finalize', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;
    const { applyAdjustment = false, force = false, notes = '' } = req.body || {};

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) throw httpError(404, 'Sesi Stock Opname tidak ditemukan.');

    const session = sessions[sessionIdx];
    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi ini sudah difinalisasi sebelumnya.');
    }

    // Periksa apakah masih ada area yang belum selesai diperiksa
    const uncompletedAreas = (session.areas || []).filter((a) => a.status !== 'completed');
    if (uncompletedAreas.length > 0 && !force) {
      return res.status(400).json({
        error: {
          code: 'UNCOMPLETED_AREAS',
          message: `Masih ada ${uncompletedAreas.length} Bagian / Area yang belum selesai diperiksa.`,
          uncompletedAreas: uncompletedAreas.map((a) => ({ id: a.areaId, name: a.areaName })),
        },
      });
    }

    const now = new Date().toISOString();
    session.status = 'finalized';
    session.finalizedAt = now;
    session.finalizedBy = req.auth.user?.id;
    session.finalizedByName = req.auth.user?.user_metadata?.full_name || req.auth.user?.email || 'User';
    session.finalNotes = String(notes || '').trim();
    session.updatedAt = now;

    let appliedAdjustmentsCount = 0;
    const adjustmentsList = [];

    // Jika user menyetujui penerapan Stock Adjustment ke database
    if (applyAdjustment) {
      // 1. Inisialisasi dari baseline seluruh produk gudang
      const productTotals = new Map();
      (session.baselineProducts || []).forEach((base) => {
        const key = (base.productId || base.sku || '').toLowerCase();
        if (!key) return;
        productTotals.set(key, {
          productId: base.productId,
          sku: base.sku,
          name: base.name,
          beforeStock: Number(base.systemQty || 0),
          totalPhysical: 0,
          locations: [],
        });
      });

      // 2. Kumpulkan total fisik per produk dari seluruh area yang diperiksa
      (session.areas || []).forEach((area) => {
        (area.items || []).forEach((item) => {
          if (item.physicalQty === null || item.physicalQty === undefined) return;
          const phys = Number(item.physicalQty);
          const key = (item.productId || item.sku || '').toLowerCase();
          if (!key) return;

          if (!productTotals.has(key)) {
            productTotals.set(key, {
              productId: item.productId,
              sku: item.sku,
              name: item.name,
              beforeStock: Number(item.systemQty || 0),
              totalPhysical: 0,
              locations: [],
            });
          }

          const entry = productTotals.get(key);
          entry.totalPhysical += phys;
          entry.locations.push({
            areaName: area.areaName,
            physicalQty: phys,
          });
        });
      });

      // 2. Update stok produk pada database jika ada selisih
      // Pre-fetch seluruh produk sekaligus untuk menghindari ratusan sequential roundtrips ke Supabase
      const { data: dbProducts } = await supabaseAdmin
        .from('products')
        .select('id, sku, stock')
        .eq('owner_id', ownerId);

      const dbProductsById = new Map();
      const dbProductsBySku = new Map();
      (dbProducts || []).forEach((p) => {
        if (p.id) dbProductsById.set(p.id, p);
        if (p.sku) dbProductsBySku.set(String(p.sku).trim().toUpperCase(), p);
      });

      const updatesToPerform = [];
      for (const [key, pData] of productTotals.entries()) {
        const prod =
          (pData.productId && dbProductsById.get(pData.productId)) ||
          (pData.sku && dbProductsBySku.get(String(pData.sku).trim().toUpperCase()));

        if (!prod) continue;

        const before = Number(prod.stock ?? pData.beforeStock ?? 0);
        const after = Math.max(0, pData.totalPhysical);

        if (before !== after) {
          updatesToPerform.push({
            id: prod.id,
            sku: pData.sku || prod.sku,
            name: pData.name,
            beforeStock: before,
            afterStock: after,
            difference: after - before,
            locations: pData.locations,
          });
        }
      }

      // Jalankan update secara concurrent dalam chunk kecil (15 paralel)
      const CHUNK_SIZE = 15;
      for (let i = 0; i < updatesToPerform.length; i += CHUNK_SIZE) {
        const chunk = updatesToPerform.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (u) => {
            await supabaseAdmin
              .from('products')
              .update({ stock: u.afterStock, updated_at: now })
              .eq('id', u.id)
              .eq('owner_id', ownerId);

            adjustmentsList.push(u);
            appliedAdjustmentsCount++;
          })
        );
      }

      // 3. Update master warehouse_areas dengan alokasi fisik terverifikasi
      const areasKey = getAreasSettingKey(warehouseId);
      const rawAreas = (await fetchWorkspaceSettingValue(ownerId, areasKey)) || [];
      const masterAreas = Array.isArray(rawAreas) ? rawAreas : [];

      (session.areas || []).forEach((sessionArea) => {
        const mIdx = masterAreas.findIndex((m) => m.id === sessionArea.areaId);
        if (mIdx !== -1) {
          masterAreas[mIdx].items = (sessionArea.items || []).map((it) => ({
            id: it.id,
            productId: it.productId,
            sku: it.sku,
            name: it.name,
            unit: it.unit,
            allocatedQty: it.physicalQty !== null && it.physicalQty !== undefined ? it.physicalQty : it.systemQty,
          }));
          masterAreas[mIdx].updatedAt = now;
        }
      });

      await saveWorkspaceSettingValue(ownerId, areasKey, masterAreas, req.auth.user?.id);
    }

    // 4. Catat Audit Log Permanen ke tabel activity_logs
    await writeActivityLog(req, {
      action: 'finalized',
      entityType: 'stock_opname',
      entityId: session.id,
      entityName: session.sessionNumber,
      beforeData: { status: 'in_progress', totalAreas: session.areas?.length },
      afterData: {
        status: 'finalized',
        applyAdjustment,
        adjustmentsCount: appliedAdjustmentsCount,
        finalizedAt: session.finalizedAt,
        finalizedByName: session.finalizedByName,
      },
      metadata: {
        sessionNumber: session.sessionNumber,
        title: session.title,
        notes: session.finalNotes,
        adjustments: adjustmentsList,
      },
    });

    sessions[sessionIdx] = session;
    await saveWorkspaceSettingValue(ownerId, sessionsKey, sessions, req.auth.user?.id);

    res.json({
      success: true,
      data: session,
      appliedAdjustment,
      appliedAdjustmentsCount,
      adjustments: adjustmentsList,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/inventory/stock-opname/sessions/:id', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const sessionId = req.params.id;

    const sessionsKey = getSessionsSettingKey(warehouseId);
    const existing = (await fetchWorkspaceSettingValue(ownerId, sessionsKey)) || [];
    const sessions = Array.isArray(existing) ? existing : [];

    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      return res.json({ success: true, message: 'Sesi Stock Opname sudah dihapus.' });
    }

    if (session.status === 'finalized') {
      throw httpError(400, 'Sesi yang sudah difinalisasi tidak dapat dihapus demi integritas audit trail.');
    }

    const filtered = sessions.filter((s) => s.id !== sessionId);
    await saveWorkspaceSettingValue(ownerId, sessionsKey, filtered, req.auth.user?.id);

    await writeActivityLog(req, {
      action: 'deleted',
      entityType: 'stock_opname',
      entityId: session.id,
      entityName: session.sessionNumber,
      metadata: { warehouseId, title: session.title },
    });

    res.json({ success: true, message: `Sesi ${session.sessionNumber} berhasil dihapus.` });
  } catch (error) {
    next(error);
  }
});

router.get('/inventory/movements', (req, res) => {
  res.json({ data: [], count: 0 });
});

router.post('/inventory/adjustments', (req, res) => {
  res.status(201).json({ data: null });
});

router.get('/inventory/summary', (req, res) => {
  res.json({ data: { totalProducts: 0, lowStockCount: 0, movementsToday: 0 } });
});

router.get('/inventory/low-stock', async (req, res, next) => {
  try {
    const threshold = Number(req.query.threshold) || 10;
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, stock, status')
      .eq('owner_id', req.auth.ownerId)
      .eq('status', 'active')
      .lte('stock', threshold)
      .order('stock', { ascending: true })
      .limit(50);
    if (error) throw httpError(500, 'Failed to load low-stock products', error.message);
    res.json({ data: data || [], count: data?.length || 0 });
  } catch (error) {
    next(error);
  }
});


router.get('/settings', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const { data, error } = await supabaseAdmin.from('workspace_settings').select('key, value').eq('owner_id', ownerId).order('key');
    if (error) throw httpError(500, 'Failed to load settings', error.message);

    let finalData = [...(data || [])];

    // If warehouseId is present, override company and custom_units with warehouse-specific settings if they exist
    if (warehouseId) {
      const whCompanyKey = `company_${warehouseId}`;
      const whUnitsKey = `custom_units_${warehouseId}`;
      const whSerialKey = `serial_number_settings_${warehouseId}`;

      const whCompany = finalData.find((item) => item.key === whCompanyKey);
      if (whCompany) {
        const cIdx = finalData.findIndex((item) => item.key === 'company');
        if (cIdx !== -1) finalData[cIdx] = { key: 'company', value: whCompany.value };
        else finalData.push({ key: 'company', value: whCompany.value });
      }

      const whUnits = finalData.find((item) => item.key === whUnitsKey);
      if (whUnits) {
        const uIdx = finalData.findIndex((item) => item.key === 'custom_units');
        if (uIdx !== -1) finalData[uIdx] = { key: 'custom_units', value: whUnits.value };
        else finalData.push({ key: 'custom_units', value: whUnits.value });
      } else {
        // Branch / new warehouse without custom units -> fresh default
        const uIdx = finalData.findIndex((item) => item.key === 'custom_units');
        if (uIdx !== -1) finalData[uIdx] = { key: 'custom_units', value: DEFAULT_CUSTOM_UNITS };
        else finalData.push({ key: 'custom_units', value: DEFAULT_CUSTOM_UNITS });
      }

      const whSerial = finalData.find((item) => item.key === whSerialKey);
      if (whSerial) {
        const sIdx = finalData.findIndex((item) => item.key === 'serial_number_settings');
        if (sIdx !== -1) finalData[sIdx] = { key: 'serial_number_settings', value: whSerial.value };
        else finalData.push({ key: 'serial_number_settings', value: whSerial.value });
      }
    }

    const { data: globalModules, error: modulesError } = await supabaseAdmin
      .from('workspace_settings')
      .select('key, value')
      .eq('owner_id', SUPER_ADMIN_TENANT_ID)
      .eq('key', 'modules')
      .maybeSingle();

    if (!modulesError && globalModules) {
      const index = finalData.findIndex((item) => item.key === 'modules');
      if (index !== -1) {
        finalData[index] = globalModules;
      } else {
        finalData.push(globalModules);
      }
    }

    // Default custom_units fallback if not yet set
    const hasCustomUnits = finalData.some((item) => item.key === 'custom_units');
    if (!hasCustomUnits) {
      finalData.push({ key: 'custom_units', value: DEFAULT_CUSTOM_UNITS });
    }

    res.json({ data: finalData });
  } catch (error) {
    next(error);
  }
});

router.patch('/settings/:key', async (req, res, next) => {
  try {
    const key = z.string().trim().min(1).max(255).parse(req.params.key);
    if (key === 'modules' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Access denied: Only Super Admin can modify module settings.');
    }
    if (key === 'daily_report_settings' && req.auth.role !== 'super_admin') {
      throw httpError(403, 'Akses ditolak: Pengaturan laporan harian hanya dapat diubah oleh Super Admin.');
    }
    if (key === 'custom_units' && req.auth.role !== 'owner' && req.auth.role !== 'super_admin' && req.auth.role !== 'staff') {
      throw httpError(403, 'Access denied: Only Owner, Super Admin, or Staff can modify units settings.');
    }

    const payload = settingsSchema.parse(req.body);
    let valueToSave = payload.value;

    if (key === 'custom_units') {
      if (!Array.isArray(valueToSave)) {
        throw httpError(400, 'Format pengaturan satuan tidak valid (harus berupa array).');
      }

      // Ensure pcs and lusin are always present
      const hasPcs = valueToSave.some((u) => String(u.key).toLowerCase() === 'pcs');
      const hasLusin = valueToSave.some((u) => String(u.key).toLowerCase() === 'lusin');

      if (!hasPcs || !hasLusin) {
        throw httpError(400, 'Satuan dasar "pcs" dan "lusin" wajib ada dan tidak boleh dihapus.');
      }

      // Sanitize and compute multipliers
      const cleanUnits = [];
      const seenKeys = new Set();

      for (const u of valueToSave) {
        const rawKey = String(u.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!rawKey) continue;
        if (seenKeys.has(rawKey)) continue;
        seenKeys.add(rawKey);

        const isLocked = rawKey === 'pcs' || rawKey === 'lusin';
        const name = String(u.name || rawKey).trim();
        const baseType = rawKey === 'pcs' ? 'pcs' : (rawKey === 'lusin' ? 'pcs' : (u.baseType === 'pcs' ? 'pcs' : 'lusin'));
        const baseValue = isLocked ? (rawKey === 'pcs' ? 1 : 12) : Math.max(1, Number(u.baseValue || 1));
        const multiplier = isLocked
          ? (rawKey === 'pcs' ? 1 : 12)
          : (baseType === 'lusin' ? baseValue * 12 : baseValue);

        const description = isLocked
          ? (rawKey === 'pcs' ? '1 Pcs' : '12 Pcs')
          : (baseType === 'lusin' ? `${baseValue} Lusin (${multiplier} Pcs)` : `${baseValue} Pcs`);

        cleanUnits.push({
          key: rawKey,
          name,
          baseType,
          baseValue,
          multiplier,
          isLocked,
          description,
        });
      }

      valueToSave = cleanUnits;
    }

    if (key === 'daily_report_settings' && valueToSave && typeof valueToSave === 'object') {
      valueToSave = { ...valueToSave, scheduleTime: '19:00' };
    }

    const ownerId = (key === 'modules' || key === 'daily_report_settings') ? SUPER_ADMIN_TENANT_ID : req.auth.ownerId;
    const warehouseId = req.auth.warehouseId;
    const dbKey = (warehouseId && (key === 'company' || key === 'custom_units')) ? `${key}_${warehouseId}` : key;

    const { data, error } = await supabaseAdmin
      .from('workspace_settings')
      .upsert({ owner_id: ownerId, key: dbKey, value: valueToSave, updated_by: req.auth.user.id }, { onConflict: 'owner_id,key' })
      .select('key, value')
      .single();
    if (error) throw httpError(500, 'Failed to save setting', error.message);

    // Sync company and app.company bidirectionally so they never drift
    if (!warehouseId && key === 'app' && valueToSave?.company && typeof valueToSave.company === 'object') {
      try {
        await supabaseAdmin
          .from('workspace_settings')
          .upsert({
            owner_id: ownerId,
            key: 'company',
            value: valueToSave.company,
            updated_by: req.auth.user.id,
          }, { onConflict: 'owner_id,key' });
      } catch (_) {}
    } else if (!warehouseId && key === 'company' && valueToSave && typeof valueToSave === 'object') {
      try {
        const { data: currentApp } = await supabaseAdmin
          .from('workspace_settings')
          .select('value')
          .eq('owner_id', ownerId)
          .eq('key', 'app')
          .maybeSingle();
        if (currentApp?.value) {
          await supabaseAdmin
            .from('workspace_settings')
            .update({
              value: { ...currentApp.value, company: valueToSave },
              updated_by: req.auth.user.id,
            })
            .eq('owner_id', ownerId)
            .eq('key', 'app');
        }
      } catch (_) {}
    }

    await writeActivityLog(req, { action: 'updated', entityType: 'Settings', entityName: key, afterData: data });
    res.json({ data: { key, value: valueToSave } });
  } catch (error) {
    next(error);
  }
});

// ── SUPER ADMIN & OWNER DAILY REPORT ROUTES ──────────────────────────────────

router.get('/daily-report/settings', async (req, res, next) => {
  try {
    if (req.auth.role !== 'super_admin' && req.auth.role !== 'owner') {
      throw httpError(403, 'Akses ditolak: Hanya Super Admin dan Owner yang dapat mengakses pengaturan laporan harian.');
    }

    const isOwner = req.auth.role === 'owner';
    const targetTenantId = isOwner ? req.auth.ownerId : SUPER_ADMIN_TENANT_ID;

    const { data: legacySuperAdminSettingRow } = await supabaseAdmin
      .from('workspace_settings')
      .select('value')
      .eq('owner_id', SUPER_ADMIN_TENANT_ID)
      .eq('key', 'daily_report_settings')
      .maybeSingle();
    const legacySetting = legacySuperAdminSettingRow?.value || null;

    if (isOwner) {
      // Ambil informasi perusahaan milik owner ini saja
      const { data: compSettings } = await supabaseAdmin
        .from('workspace_settings')
        .select('key, value')
        .eq('owner_id', req.auth.ownerId)
        .in('key', ['company', 'app']);

      let companyName = null;
      let companyEmail = null;
      for (const s of compSettings || []) {
        const val = s.value || {};
        if (s.key === 'company') {
          companyName = val.companyName || val.name || companyName;
          companyEmail = val.companyEmail || val.email || val.company?.companyEmail || val.company?.email || companyEmail;
        } else if (s.key === 'app') {
          companyName = companyName || val.company?.companyName || val.company?.name || val.companyName || val.name;
          companyEmail = companyEmail || val.company?.companyEmail || val.company?.email || val.companyEmail || val.email;
        }
      }

      // Ambil setting khusus owner ini dari database
      const { data: ownerDbSetting } = await supabaseAdmin
        .from('workspace_settings')
        .select('value')
        .eq('owner_id', req.auth.ownerId)
        .eq('key', 'daily_report_settings')
        .maybeSingle();

      const ownerVal = ownerDbSetting?.value || (legacySetting && legacySetting.authorizedOwnerId === req.auth.ownerId ? legacySetting : null);
      const isSuperAdminEnabled = Boolean(ownerVal?.enabled);

      const defaultSettings = {
        enabled: isSuperAdminEnabled,
        scheduleTime: '19:00',
        timeZone: 'Asia/Jakarta',
        includeGoodsIn: ownerVal?.includeGoodsIn !== false,
        includeGoodsOut: ownerVal?.includeGoodsOut !== false,
        includeReturns: ownerVal?.includeReturns !== false,
        reportType: 'both',
        authorizedOwnerId: req.auth.ownerId,
        useCompanyEmail: ownerVal?.useCompanyEmail !== false,
        customRecipients: ownerVal?.customRecipients || '',
      };

      return res.json({
        settings: defaultSettings,
        rawSettings: ownerVal || defaultSettings,
        owners: [
          {
            id: req.auth.ownerId,
            name: req.auth.user?.full_name || 'Owner',
            role: 'owner',
            companyName: companyName || req.auth.user?.full_name || 'Perusahaan Anda',
            companyEmail: companyEmail || null,
            enabled: isSuperAdminEnabled,
          },
        ],
        companyEmail,
        companyName,
        isOwner: true,
        isSuperAdmin: false,
        canToggleEnabled: false,
        statusMessage: isSuperAdminEnabled
          ? 'Laporan harian aktif dan dijadwalkan otomatis setiap pukul 19.00 WIB oleh Super Admin.'
          : 'Laporan harian dinonaktifkan oleh Super Admin. Hubungi Super Admin untuk mengaktifkannya.',
      });
    }

    // Role Super Admin: dapat mengelola dan memilih semua tenant
    const { data: rawProfiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, status, owner_id')
      .in('role', ['owner', 'super_admin'])
      .neq('status', 'disabled')
      .order('full_name');

    // Deduplikasi berdasarkan owner_id (kecualikan placeholder super_admin)
    const owners = [];
    const seenOwnerIds = new Set();
    for (const p of rawProfiles || []) {
      if (p.owner_id && !seenOwnerIds.has(p.owner_id) && p.owner_id !== SUPER_ADMIN_TENANT_ID) {
        seenOwnerIds.add(p.owner_id);
        owners.push(p);
      }
    }

    // Batch fetch settings daily report untuk seluruh owner aktif
    const ownerIds = owners.map((o) => o.owner_id).filter(Boolean);
    const { data: allReportSettings } = await supabaseAdmin
      .from('workspace_settings')
      .select('owner_id, key, value')
      .in('owner_id', ownerIds)
      .eq('key', 'daily_report_settings');

    const reportSettingsMap = new Map((allReportSettings || []).map((s) => [s.owner_id, s.value]));

    // Batch fetch company settings for all active owners
    const { data: allCompSettings } = await supabaseAdmin
      .from('workspace_settings')
      .select('owner_id, key, value, updated_at')
      .in('owner_id', ownerIds)
      .in('key', ['company', 'app']);

    const ownerCompanyMap = new Map();
    for (const s of allCompSettings || []) {
      const existing = ownerCompanyMap.get(s.owner_id) || { appUpdated: 0, compUpdated: 0 };
      const val = s.value || {};
      const updatedTime = s.updated_at ? new Date(s.updated_at).getTime() : 0;

      if (s.key === 'app') {
        const name = val.company?.companyName || val.company?.name || val.companyName || val.name || null;
        const email = val.company?.companyEmail || val.company?.email || val.companyEmail || val.email || null;
        existing.appName = name;
        existing.appEmail = email;
        existing.appUpdated = updatedTime;
      }
      if (s.key === 'company') {
        const name = val.companyName || val.name || val.company?.companyName || val.company?.name || null;
        const email = val.companyEmail || val.email || val.company?.companyEmail || val.company?.email || null;
        existing.compName = name;
        existing.compEmail = email;
        existing.compUpdated = updatedTime;
      }
      ownerCompanyMap.set(s.owner_id, existing);
    }

    const ownersWithSettings = owners.map((o) => {
      const compInfo = ownerCompanyMap.get(o.owner_id) || {};
      let cName = null;
      let cEmail = null;

      if (compInfo.appEmail && compInfo.compEmail) {
        if (compInfo.appUpdated >= compInfo.compUpdated) {
          cEmail = compInfo.appEmail;
          cName = compInfo.appName || compInfo.compName;
        } else {
          cEmail = compInfo.compEmail;
          cName = compInfo.compName || compInfo.appName;
        }
      } else if (compInfo.appEmail) {
        cEmail = compInfo.appEmail;
        cName = compInfo.appName || compInfo.compName;
      } else if (compInfo.compEmail) {
        cEmail = compInfo.compEmail;
        cName = compInfo.compName || compInfo.appName;
      } else {
        cName = compInfo.appName || compInfo.compName;
      }

      const ownerSetting = reportSettingsMap.get(o.owner_id) || (legacySetting && legacySetting.authorizedOwnerId === o.owner_id ? legacySetting : null);
      const isEnabled = Boolean(ownerSetting?.enabled);

      return {
        id: o.owner_id,
        name: o.full_name || 'Owner',
        role: o.role,
        companyName: cName || o.full_name || 'DocuFlow Workspace',
        companyEmail: cEmail || null,
        enabled: isEnabled,
        settings: {
          enabled: isEnabled,
          scheduleTime: '19:00',
          timeZone: 'Asia/Jakarta',
          includeGoodsIn: ownerSetting?.includeGoodsIn !== false,
          includeGoodsOut: ownerSetting?.includeGoodsOut !== false,
          includeReturns: ownerSetting?.includeReturns !== false,
          reportType: 'both',
          authorizedOwnerId: o.owner_id,
          useCompanyEmail: ownerSetting?.useCompanyEmail !== false,
          customRecipients: ownerSetting?.customRecipients || '',
        },
      };
    });

    const selectedOwnerId = req.query.ownerId || (legacySetting?.authorizedOwnerId) || ownersWithSettings[0]?.id || null;
    const activeOwnerData = ownersWithSettings.find((o) => o.id === selectedOwnerId) || ownersWithSettings[0] || null;

    const defaultSelectedSettings = activeOwnerData?.settings || {
      enabled: false,
      scheduleTime: '19:00',
      timeZone: 'Asia/Jakarta',
      includeGoodsIn: true,
      includeGoodsOut: true,
      includeReturns: true,
      reportType: 'both',
      authorizedOwnerId: selectedOwnerId,
      useCompanyEmail: true,
      customRecipients: '',
    };

    res.json({
      settings: defaultSelectedSettings,
      selectedOwnerId,
      owners: ownersWithSettings,
      companyEmail: activeOwnerData?.companyEmail || null,
      companyName: activeOwnerData?.companyName || null,
      isOwner: false,
      isSuperAdmin: true,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/daily-report/settings', async (req, res, next) => {
  try {
    if (req.auth.role !== 'super_admin' && req.auth.role !== 'owner') {
      throw httpError(403, 'Akses ditolak: Hanya Super Admin dan Owner yang dapat mengubah pengaturan laporan harian.');
    }

    const isOwner = req.auth.role === 'owner';
    const isSuperAdmin = req.auth.role === 'super_admin';

    // Tentukan target owner
    let targetOwnerId = isOwner ? req.auth.ownerId : (req.body.ownerId || req.body.authorizedOwnerId);

    if (!targetOwnerId) {
      throw httpError(400, 'Pilih owner / workspace yang ingin diatur.');
    }

    // Owner tidak boleh mengubah pengaturan milik owner lain (Strict Isolation)
    if (isOwner && targetOwnerId !== req.auth.ownerId) {
      throw httpError(403, 'Akses ditolak: Anda tidak memiliki izin untuk mengubah pengaturan tenant lain.');
    }

    // Verifikasi targetOwnerId benar-benar ada dan aktif
    const { data: ownerProfile, error: ownerErr } = await supabaseAdmin
      .from('profiles')
      .select('id, owner_id, status, role')
      .eq('owner_id', targetOwnerId)
      .in('role', ['owner', 'super_admin'])
      .maybeSingle();

    if (ownerErr || !ownerProfile || ownerProfile.status === 'disabled') {
      throw httpError(400, 'Owner tenant yang dipilih tidak valid atau akun dinonaktifkan.');
    }

    // Ambil setting yang tersimpan saat ini untuk target owner
    const { data: currentOwnerSettingRow } = await supabaseAdmin
      .from('workspace_settings')
      .select('value')
      .eq('owner_id', targetOwnerId)
      .eq('key', 'daily_report_settings')
      .maybeSingle();

    const isCurrentlyEnabled = Boolean(currentOwnerSettingRow?.value?.enabled);

    // Aturan Otorisasi: Owner tidak boleh mengaktifkan sendiri laporan yang dinonaktifkan oleh Super Admin
    if (isOwner && !isCurrentlyEnabled && (req.body.enabled === true || req.body.enabled === 'true')) {
      throw httpError(403, 'Akses ditolak: Fitur laporan harian untuk akun Owner hanya dapat diaktifkan oleh Super Admin.');
    }

    // Tentukan status enabled final
    const finalEnabled = isSuperAdmin
      ? Boolean(req.body.enabled)
      : (isCurrentlyEnabled ? Boolean(req.body.enabled) : false);

    const existingVal = currentOwnerSettingRow?.value || {};
    const validatedPayload = dailyReportSettingsSchema.parse({
      ...existingVal,
      ...req.body,
      enabled: finalEnabled,
      scheduleTime: '19:00',
      timeZone: 'Asia/Jakarta',
      authorizedOwnerId: targetOwnerId,
    });

    const { data, error } = await supabaseAdmin
      .from('workspace_settings')
      .upsert({
        owner_id: targetOwnerId,
        key: 'daily_report_settings',
        value: validatedPayload,
        updated_by: req.auth.user.id,
      }, { onConflict: 'owner_id,key' })
      .select('key, value')
      .single();

    if (error) throw httpError(500, 'Gagal menyimpan pengaturan laporan harian', error.message);

    await writeActivityLog(req, {
      action: 'updated',
      entityType: 'Settings',
      entityName: 'daily_report_settings',
      afterData: data,
    });

    res.json({ success: true, settings: data.value, targetOwnerId });
  } catch (err) {
    next(err);
  }
});

router.get('/daily-report/preview', async (req, res, next) => {
  try {
    if (req.auth.role !== 'super_admin' && req.auth.role !== 'owner') {
      throw httpError(403, 'Akses ditolak: Hanya Super Admin dan Owner yang dapat melihat pratinjau laporan.');
    }

    const isOwner = req.auth.role === 'owner';
    const ownerId = isOwner ? req.auth.ownerId : (req.query.ownerId || req.auth.ownerId);

    if (!ownerId) {
      throw httpError(400, 'Belum ada owner / workspace yang dipilih untuk membuat laporan.');
    }

    // Ambil setting khusus owner ini, dengan fallback ke legacy setting
    const { data: dbSetting } = await supabaseAdmin
      .from('workspace_settings')
      .select('value')
      .eq('owner_id', ownerId)
      .eq('key', 'daily_report_settings')
      .maybeSingle();

    let settings = dbSetting?.value;
    if (!settings) {
      const { data: legacyRow } = await supabaseAdmin
        .from('workspace_settings')
        .select('value')
        .eq('owner_id', SUPER_ADMIN_TENANT_ID)
        .eq('key', 'daily_report_settings')
        .maybeSingle();
      if (legacyRow?.value?.authorizedOwnerId === ownerId) {
        settings = legacyRow.value;
      }
    }
    settings = settings || {};

    // Validasi isolasi tenant: pastikan ownerId adalah owner aktif yang sah
    const { data: previewOwnerProfile, error: previewOwnerErr } = await supabaseAdmin
      .from('profiles')
      .select('id, owner_id, status, role')
      .eq('owner_id', ownerId)
      .in('role', ['owner', 'super_admin'])
      .maybeSingle();

    if (previewOwnerErr || !previewOwnerProfile || previewOwnerProfile.status === 'disabled') {
      throw httpError(400, 'Tenant yang dipilih tidak valid atau akun dinonaktifkan.');
    }

    const dateStr = req.query.date || null;
    const includeGoodsIn = req.query.includeGoodsIn !== 'false' && (settings.includeGoodsIn !== false);
    const includeGoodsOut = req.query.includeGoodsOut !== 'false' && (settings.includeGoodsOut !== false);
    const includeReturns = req.query.includeReturns !== 'false' && (settings.includeReturns !== false);

    const reportData = await buildDailyReportData({
      ownerId,
      dateStr,
      includeGoodsIn,
      includeGoodsOut,
      includeReturns,
    });

    const html = generateDailyReportHtml(reportData);

    res.json({
      success: true,
      report: reportData,
      html,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/daily-report/send', async (req, res, next) => {
  try {
    if (req.auth.role !== 'super_admin' && req.auth.role !== 'owner') {
      throw httpError(403, 'Akses ditolak: Hanya Super Admin dan Owner yang dapat memicu pengiriman laporan.');
    }

    const isOwner = req.auth.role === 'owner';

    const {
      isTest = false,
      testRecipient = null,
      dateStr = null,
      force = false,
      dryRun = false,
      ownerId: customOwnerId = null,
      useCompanyEmail: customUseCompanyEmail = null,
      customRecipients: customRecipientsOverride = null,
    } = req.body || {};

    // Pembatasan Sementara: Owner biasa tidak diizinkan mengirim email laporan nyata (manual send maupun test send)
    if (isOwner && !dryRun) {
      throw httpError(403, 'Akses ditolak: Pengiriman email laporan harian dinonaktifkan sementara untuk akun Owner.');
    }

    const ownerId = isOwner ? req.auth.ownerId : (customOwnerId || req.auth.ownerId);

    if (!ownerId) {
      throw httpError(400, 'Belum ada owner / workspace yang diotorisasi untuk laporan harian.');
    }

    const { data: dbSetting } = await supabaseAdmin
      .from('workspace_settings')
      .select('value')
      .eq('owner_id', ownerId)
      .eq('key', 'daily_report_settings')
      .maybeSingle();

    let settings = dbSetting?.value;
    if (!settings) {
      const { data: legacyRow } = await supabaseAdmin
        .from('workspace_settings')
        .select('value')
        .eq('owner_id', SUPER_ADMIN_TENANT_ID)
        .eq('key', 'daily_report_settings')
        .maybeSingle();
      if (legacyRow?.value?.authorizedOwnerId === ownerId) {
        settings = legacyRow.value;
      }
    }
    settings = settings || {};

    // Validasi isolasi tenant: pastikan ownerId adalah owner aktif yang sah
    const { data: sendOwnerProfile, error: sendOwnerErr } = await supabaseAdmin
      .from('profiles')
      .select('id, owner_id, status, role')
      .eq('owner_id', ownerId)
      .in('role', ['owner', 'super_admin'])
      .maybeSingle();

    if (sendOwnerErr || !sendOwnerProfile || sendOwnerProfile.status === 'disabled') {
      throw httpError(400, 'Tenant yang dipilih tidak valid atau akun dinonaktifkan.');
    }

    // Keamanan Phase 1: Pengiriman manual resmi hanya boleh diproses jika tenant berstatus ON
    if (!isTest && !dryRun && !Boolean(settings.enabled)) {
      throw httpError(400, 'Laporan harian untuk tenant ini sedang dinonaktifkan (OFF). Pengiriman resmi dibatalkan demi keamanan. Aktifkan terlebih dahulu status laporan tenant di pengaturan.');
    }

    const includeGoodsIn = settings.includeGoodsIn !== false;
    const includeGoodsOut = settings.includeGoodsOut !== false;
    const includeReturns = settings.includeReturns !== false;
    const useCompanyEmail = customUseCompanyEmail !== null ? Boolean(customUseCompanyEmail) : (settings.useCompanyEmail !== false);

    let recipients = null;
    if (isTest) {
      if (!testRecipient || !isValidEmail(testRecipient)) {
        throw httpError(400, 'Alamat email uji coba wajib diisi dan harus berupa email yang valid.');
      }
      recipients = [testRecipient];
    } else {
      recipients = customRecipientsOverride !== null ? customRecipientsOverride : (settings.customRecipients || null);
    }

    const sendResult = await sendDailyReportEmail({
      ownerId,
      dateStr,
      recipients,
      useCompanyEmail,
      includeGoodsIn,
      includeGoodsOut,
      includeReturns,
      isTest: Boolean(isTest),
      force: Boolean(force),
      dryRun: Boolean(dryRun),
      triggerSource: isTest ? 'test' : 'manual',
    });

    if (!dryRun) {
      await writeActivityLog(req, {
        action: isTest ? 'daily_report_test_sent' : 'daily_report_manual_sent',
        entityType: 'DailyReport',
        entityName: sendResult.subject || 'Daily Report',
        afterData: { status: sendResult.status, recipient: sendResult.primaryRecipient },
      });
    }

    res.json({
      success: sendResult.status === 'sent' || sendResult.status === 'skipped' || sendResult.status === 'simulated',
      result: sendResult,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/daily-report/history', async (req, res, next) => {
  try {
    if (req.auth.role !== 'super_admin' && req.auth.role !== 'owner') {
      throw httpError(403, 'Akses ditolak: Hanya Super Admin dan Owner yang dapat melihat riwayat laporan.');
    }

    const isOwner = req.auth.role === 'owner';

    // Phase 2A: Ambil riwayat dengan identitas terstruktur jika ada
    let query = supabaseAdmin
      .from('email_logs')
      .select('id, owner_id, report_date, trigger_source, sender_email, recipient_email, cc_email, subject, status, sent_at, error_message, created_at')
      .or('email_type.eq.daily_report,subject.ilike.%Laporan Harian Gudang%,subject.ilike.%[Daily Report]%')
      .order('created_at', { ascending: false })
      .limit(30);

    if (isOwner) {
      // Prioritas 1: Filter langsung by owner_id (Phase 2A)
      // Fallback: Jika baris log lama belum memiliki owner_id, filter by companyName
      const { data: compSettings } = await supabaseAdmin
        .from('workspace_settings')
        .select('key, value')
        .eq('owner_id', req.auth.ownerId)
        .in('key', ['company', 'app']);

      let compName = '';
      let compEmail = '';
      for (const s of compSettings || []) {
        const v = s.value || {};
        if (s.key === 'company') {
          compName = v.companyName || v.name || compName;
          compEmail = v.companyEmail || v.email || compEmail;
        } else if (s.key === 'app') {
          compName = compName || v.company?.companyName || v.company?.name || v.companyName || v.name;
          compEmail = compEmail || v.company?.companyEmail || v.company?.email || v.companyEmail || v.email;
        }
      }

      if (compName) {
        query = query.or(`owner_id.eq.${req.auth.ownerId},and(owner_id.is.null,subject.ilike.%${compName}%)`);
      } else if (compEmail) {
        query = query.or(`owner_id.eq.${req.auth.ownerId},and(owner_id.is.null,or(recipient_email.eq.${compEmail},cc_email.ilike.%${compEmail}%))`);
      } else {
        query = query.eq('owner_id', req.auth.ownerId);
      }
    }

    const { data: logs, error } = await query;

    if (error) throw httpError(500, 'Gagal memuat riwayat pengiriman email', error.message);

    res.json({
      logs: logs || [],
    });
  } catch (err) {
    next(err);
  }
});

const STOCK_EXPORT_COLUMNS = [
  'Tipe',
  'Nama Produk',
  'SKU',
  'Nomor Serial',
  'Satuan',
  'Jumlah',
  'Keterangan Unit',
  'Total Lusin',
  'Total Pcs',
  'Status',
];

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function csvNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0';
}

router.post('/inventory/export', async (req, res, next) => {
  try {
    const {
      format = 'csv',
      filename = 'stock_position',
      generatedAt = null,
      totals = null,
      products = [],
    } = req.body ?? {};

    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_') || 'stock_position';
    const rows = Array.isArray(products) ? products : [];

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${safeFilename}.json`);
      res.send(
        JSON.stringify(
          { generatedAt: generatedAt || new Date().toISOString(), totals: totals ?? {}, products: rows },
          null,
          2
        )
      );
      return;
    }

    const lines = [STOCK_EXPORT_COLUMNS.join(',')];

    rows.forEach((p) => {
      lines.push(
        [
          'PRODUK',
          csvCell(p.name),
          csvCell(p.sku),
          csvCell(''),
          csvCell(p.unitKey),
          csvNumber(p.nonSerialQty),
          csvCell(p.nonSerialText),
          csvNumber(p.totalLusin),
          csvNumber(p.totalPcs),
          csvCell(p.status),
        ].join(',')
      );

      (Array.isArray(p.serials) ? p.serials : []).forEach((s) => {
        lines.push(
          [
            'SERIAL',
            csvCell(p.name),
            csvCell(p.sku),
            csvCell(s.serialNumber),
            csvCell(s.unitKey),
            csvNumber(1),
            csvCell(s.qtyText),
            csvNumber(s.qtyLusin),
            csvNumber(s.qtyPcs),
            csvCell(s.status),
          ].join(',')
        );
      });
    });

    if (totals) {
      lines.push(
        [
          'TOTAL',
          csvCell('TOTAL'),
          csvCell(''),
          csvCell(''),
          csvCell(''),
          csvNumber(totals.serialCount),
          csvCell(''),
          csvNumber(totals.totalLusin),
          csvNumber(totals.totalPcs),
          csvCell(''),
        ].join(',')
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${safeFilename}.csv`);
    res.send(`\uFEFF${lines.join('\n')}\n`);
  } catch (error) {
    next(error);
  }
});

// ── Notifications ────────────────────────────────────────────

router.get('/notifications', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id, type, title, message, reference_id, reference_type, is_read, created_at')
      .eq('user_id', req.auth.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw httpError(500, 'Failed to load notifications', error.message);
    const unreadCount = (data || []).filter((n) => !n.is_read).length;
    res.json({ data: data || [], unreadCount });
  } catch (error) {
    next(error);
  }
});

router.patch('/notifications/:id/read', async (req, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', req.auth.user.id)
      .select('id, type, title, message, reference_id, reference_type, is_read, created_at')
      .single();
    if (error) throw httpError(500, 'Failed to mark notification as read', error.message);
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.post('/notifications/mark-all-read', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.auth.user.id)
      .eq('is_read', false);
    if (error) throw httpError(500, 'Failed to mark all as read', error.message);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/notifications/generate-stock-alerts', async (req, res, next) => {
  try {
    const LOW_STOCK_THRESHOLD = 10;
    const userId = req.auth.user.id;
    const ownerId = req.auth.ownerId;

    // 1. Get all active products with low/zero stock, including updated_at
    const { data: lowProducts, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, stock, updated_at')
      .eq('owner_id', ownerId)
      .eq('status', 'active')
      .lte('stock', LOW_STOCK_THRESHOLD)
      .order('stock', { ascending: true });
    if (prodErr) throw httpError(500, 'Failed to check stock levels', prodErr.message);
    if (!lowProducts || lowProducts.length === 0) {
      return res.json({ generated: 0 });
    }

    // 2. Get existing notifications (both read and unread) for this user to evaluate refresh duplicates
    const { data: existing, error: existErr } = await supabaseAdmin
      .from('notifications')
      .select('reference_id, type, created_at')
      .eq('user_id', userId)
      .in('type', ['out_of_stock', 'low_stock']);
    if (existErr) throw httpError(500, 'Failed to check existing notifications', existErr.message);

    // Group and find the latest notification for each product
    const latestNotifMap = new Map();
    if (existing && existing.length > 0) {
      for (const notif of existing) {
        const prodId = notif.reference_id;
        if (!prodId) continue;
        const currentLatest = latestNotifMap.get(prodId);
        if (!currentLatest || new Date(notif.created_at) > new Date(currentLatest.created_at)) {
          latestNotifMap.set(prodId, notif);
        }
      }
    }

    // 3. Build new notifications
    const newNotifs = [];
    for (const product of lowProducts) {
      const latestNotif = latestNotifMap.get(product.id);
      const isOutOfStock = product.stock <= 0;
      const expectedType = isOutOfStock ? 'out_of_stock' : 'low_stock';

      if (latestNotif) {
        // Only generate a new notification if:
        // a. The product was updated/modified AFTER the last notification was created (e.g. restocked and dropped back down)
        // b. OR, it transitioned from low_stock to out_of_stock (alert escalation)
        const productUpdatedTime = new Date(product.updated_at);
        const notifCreatedTime = new Date(latestNotif.created_at);

        const isUpdated = productUpdatedTime > notifCreatedTime;
        const isEscalated = expectedType === 'out_of_stock' && latestNotif.type === 'low_stock';

        if (!isUpdated && !isEscalated) {
          continue; // Skip generating notification
        }
      }

      newNotifs.push({
        owner_id: ownerId,
        user_id: userId,
        type: expectedType,
        title: isOutOfStock
          ? `Stok Habis: ${product.name}`
          : `Stok Rendah: ${product.name}`,
        message: isOutOfStock
          ? `Produk "${product.name}" (${product.sku}) sudah habis (stok: 0).`
          : `Produk "${product.name}" (${product.sku}) stoknya tinggal ${product.stock} unit.`,
        reference_id: product.id,
        reference_type: 'product',
        is_read: false,
      });
    }

    if (newNotifs.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from('notifications')
        .insert(newNotifs);
      if (insertErr) throw httpError(500, 'Failed to create notifications', insertErr.message);
    }

    res.json({ generated: newNotifs.length });
  } catch (error) {
    next(error);
  }
});

// ── Sales Dashboard Stats ────────────────────────────────────
router.get('/sales-dashboard/stats', async (req, res, next) => {
  try {
    const userId = req.auth.user.id;
    const ownerId = req.auth.ownerId;

    // Get start of today (local time)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfTodayISO = today.toISOString();

    // 1. Get count of new customers today
    const { count: customersCount, error: customerErr } = await supabaseAdmin
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('created_by', userId)
      .eq('type', 'customer')
      .gte('created_at', startOfTodayISO);

    if (customerErr) throw httpError(500, 'Failed to fetch customer stats', customerErr.message);

    // 2. Get weekly traffic: count POs for last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const startOf7DaysISO = sevenDaysAgo.toISOString();

    const { data: poData, error: poErr } = await supabaseAdmin
      .from('purchase_orders')
      .select('created_at')
      .eq('owner_id', ownerId)
      .eq('sales_person_id', userId)
      .gte('created_at', startOf7DaysISO);

    if (poErr) throw httpError(500, 'Failed to fetch purchase orders stats', poErr.message);

    // Get total POs created by this sales person
    const { count: totalPOsCount, error: totalPOErr } = await supabaseAdmin
      .from('purchase_orders')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('sales_person_id', userId);

    if (totalPOErr) throw httpError(500, 'Failed to fetch total PO stats', totalPOErr.message);

    // Group POs by day for chart
    const dailyCounts = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateString = d.toISOString().split('T')[0];
      dailyCounts[dateString] = 0;
    }

    if (poData && poData.length > 0) {
      poData.forEach((po) => {
        const dateStr = new Date(po.created_at).toISOString().split('T')[0];
        if (dailyCounts[dateStr] !== undefined) {
          dailyCounts[dateStr] += 1;
        }
      });
    }

    // Convert to sorted array for the chart
    const chartData = Object.keys(dailyCounts)
      .sort()
      .map((dateStr) => ({
        date: dateStr,
        count: dailyCounts[dateStr],
      }));

    res.json({
      data: {
        newCustomersToday: customersCount || 0,
        totalPOs: totalPOsCount || 0,
        weeklyTraffic: chartData,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── General Workspace Dashboard Stats ────────────────────────
router.get('/dashboard/stats', async (req, res, next) => {
  try {
    const ownerId = req.auth.ownerId;
    const isOwnerOrSuperAdmin = req.auth.role === 'owner' || req.auth.role === 'super_admin';
    const queryWarehouseId = req.query.warehouse_id || req.query.warehouseId;
    const targetWhId = isOwnerOrSuperAdmin
      ? ((queryWarehouseId && queryWarehouseId !== 'all') ? queryWarehouseId : null)
      : (queryWarehouseId || req.auth.warehouseId || null);

    // Fetch invoices to aggregate paid & unpaid income
    let docQuery = supabaseAdmin
      .from('documents')
      .select('id, document_type, document_number, total, payment_terms, status, issue_date, created_at')
      .eq('owner_id', ownerId)
      .neq('status', 'cancelled');

    if (targetWhId) {
      docQuery = docQuery.eq('warehouse_id', targetWhId);
    }

    // Fetch products across owner catalog
    let prodQuery = supabaseAdmin
      .from('products')
      .select('id, stock, metadata, status')
      .eq('owner_id', ownerId);

    const [{ data: docs, error: docErr }, { data: prods, error: prodErr }] = await Promise.all([
      docQuery,
      prodQuery,
    ]);

    if (docErr) throw httpError(500, 'Failed to fetch dashboard document stats', docErr.message);
    if (prodErr) throw httpError(500, 'Failed to fetch dashboard product stats', prodErr.message);

    const isDocPaid = (d) => {
      const terms = d.payment_terms || 'unpaid:0';
      const [payStatus] = terms.split(':');
      return payStatus === 'paid';
    };

    const valuedDocs = (docs || []).filter((d) => Number(d.total ?? 0) > 0 && d.document_type === 'invoice');
    const paidDocs = valuedDocs.filter((d) => isDocPaid(d));
    const unpaidDocs = valuedDocs.filter((d) => !isDocPaid(d));

    const paidAmount = paidDocs.reduce((sum, d) => sum + Number(d.total ?? 0), 0);
    const unpaidAmount = unpaidDocs.reduce((sum, d) => sum + Number(d.total ?? 0), 0);

    let totalStock = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    (prods || []).forEach((p) => {
      const s = Number(p.stock ?? 0);
      const minS = Number(p.metadata?.minStock ?? 10);
      totalStock += s;
      if (s === 0) outOfStockCount++;
      else if (s <= minS) lowStockCount++;
    });

    res.json({
      data: {
        paidAmount,
        paidCount: paidDocs.length,
        unpaidAmount,
        unpaidCount: unpaidDocs.length,
        totalRevenue: paidAmount + unpaidAmount,
        totalInvoices: valuedDocs.length,
        totalProducts: (prods || []).length,
        totalStock,
        lowStockCount,
        outOfStockCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
export { resendDocumentEmail, getRow as getDocumentRowForOwner };

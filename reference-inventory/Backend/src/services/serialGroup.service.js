/**
 * Serial Grouping Service for DocuFlow
 * 
 * Supports:
 * - Single-product & cross-product serial grouping (Barang 1 + Barang 2 -> Barang 3 or mixed product)
 * - Result product naming (auto-default, existing product selection, or new/mixed product name)
 * - Strict parent-child relationship & nested multi-level grouping traceability down to leaf SNs
 * - Nesting depth control (max 3 levels: Satuan Dasar -> Box/Karton -> Pallet/Koli)
 * - Warehouse isolation: all members must belong to the exact same warehouse
 * - Concurrency protection & atomic transactions (PostgreSQL RPC + Node.js rollback compensation)
 * - Accurate quantity conversion using AGENTS.md canonical multipliers
 * - Stock safety: zero double-counting, physical inventory integrity
 * - Guard against direct Goods Out of grouped items without unpacking parent group
 * - Unpacking (ungrouping) preserves full historical composition and marks group as dissolved
 */

import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase.js';

// Canonical multipliers per AGENTS.md Rule 2
export const CANONICAL_MULTIPLIERS = {
  pcs: 1,
  piece: 1,
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
 * Maximum hierarchy nesting depth allowed
 * Level 1: Base serial (Pcs/Lusin/Bal)
 * Level 2: Inner Box / Bundle / Karton
 * Level 3: Master Pallet / Koli
 */
export const MAX_GROUP_NESTING_DEPTH = 3;

/**
 * Escapes PostgreSQL LIKE/ILIKE wildcard characters.
 * Prevents user/SN input containing '%' or '_' from turning into a wildcard lookup.
 */
export function escapeLikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, (char) => `\\${char}`);
}

const GROUPING_MEMBER_SELECT = 'id, product_id, serial_number, status, warehouse_id, goods_out_document_id, metadata, product:products(id, name, sku, category, unit_cost, metadata)';

/**
 * PHASE 7G — Case-insensitive member lookup.
 * Serial numbers are unique per owner regardless of letter case. PostgREST
 * `.in()` is case-sensitive, so we resolve exact matches first and then fetch
 * any remaining serials with an escaped ILIKE. Legacy rows that differ only by
 * case make `.maybeSingle()` fail safely instead of silently picking one.
 */
async function fetchGroupingMembers({ ownerId, memberSerialIds, memberSerialNumbers, supabaseClient }) {
  const base = () => supabaseClient
    .from('product_serials')
    .select(GROUPING_MEMBER_SELECT)
    .eq('owner_id', ownerId);

  if (Array.isArray(memberSerialIds) && memberSerialIds.length > 0) {
    return base().in('id', memberSerialIds);
  }

  const numbers = (Array.isArray(memberSerialNumbers) ? memberSerialNumbers : [])
    .map((sn) => String(sn).trim())
    .filter(Boolean);

  const { data: exactRows, error: exactErr } = await base().in('serial_number', numbers);
  if (exactErr) return { data: null, error: exactErr };

  const found = new Set((exactRows || []).map((row) => String(row.serial_number || '').toLowerCase()));
  const missing = [];
  for (const sn of numbers) {
    if (!found.has(sn.toLowerCase()) && !missing.some((m) => m.toLowerCase() === sn.toLowerCase())) {
      missing.push(sn);
    }
  }

  const extra = [];
  for (const sn of missing) {
    const { data: row, error } = await base()
      .ilike('serial_number', escapeLikePattern(sn))
      .maybeSingle();
    if (error) return { data: null, error };
    if (row) extra.push(row);
  }

  return { data: [...(exactRows || []), ...extra], error: null };
}

/**
 * Stable SHA-256 hash of the grouping request identity.
 * Used to detect the same idempotency key being replayed with a different payload.
 */
export function buildGroupingPayloadHash({
  memberIds = [],
  memberSerialNumbers = [],
  resultProductId = null,
  resultProductName = null,
  resultProductSku = null,
  targetUnit = null,
  warehouseId = null,
  groupSerialNumber = null,
  createNewMasterProduct = false,
} = {}) {
  const memberKey = (Array.isArray(memberIds) && memberIds.length > 0
    ? memberIds.map(String)
    : memberSerialNumbers.map((sn) => String(sn).trim().toUpperCase())
  ).slice().sort();

  const canonical = JSON.stringify({
    members: memberKey,
    resultProductId: resultProductId ? String(resultProductId) : null,
    resultProductName: createNewMasterProduct && resultProductName ? String(resultProductName).trim() : null,
    resultProductSku: createNewMasterProduct && resultProductSku ? String(resultProductSku).trim().toUpperCase() : null,
    groupSerialNumber: groupSerialNumber ? String(groupSerialNumber).trim().toUpperCase() : null,
    createNewMasterProduct: Boolean(createNewMasterProduct),
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function buildGroupingDocumentNumber(prefix, dateCode, groupSerialNumber, extra = '') {
  const cleanGroup = String(groupSerialNumber || 'GRP')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 90);
  const cleanExtra = String(extra || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return `${prefix}-${dateCode}-${cleanGroup}${cleanExtra ? `-${cleanExtra}` : ''}`;
}

function buildGroupingComponentsPayload(enrichedDirectMembers = []) {
  return enrichedDirectMembers.map((d, idx) => ({
    component_serial_id: d.serialId,
    component_serial_number: d.serialNumber,
    component_product_id: d.productId,
    snapshot_product_name: d.productName || 'Produk',
    snapshot_sku: d.sku || '',
    unit: d.unit || 'pcs',
    unit_qty: d.unitQty || 1,
    base_qty_pcs: d.pcs || 1,
    unit_cost: d.unitCost || 0,
    total_cost: d.totalCost || 0,
    is_sub_group: Boolean(d.isGroup),
    nested_depth: d.nestedDepth || (d.isGroup ? 2 : 1),
    sort_order: idx + 1,
    metadata: {
      batchNumber: d.batchNumber || null,
      preGroupStatus: d.preStatus || 'available',
    },
  }));
}

/**
 * Parses unit from serial number string per AGENTS.md Rule 3
 */
export function parseUnitFromSerialNumber(serialNumber, customUnits = []) {
  if (!serialNumber || typeof serialNumber !== 'string') return 'pcs';
  const clean = serialNumber.toLowerCase().trim();

  // 1. Check custom units if available
  if (Array.isArray(customUnits) && customUnits.length > 0) {
    const sortedUnits = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
    for (const u of sortedUnits) {
      const k = String(u.key).toLowerCase().trim();
      if (!k || k === 'pcs') continue;
      if (clean.includes(k)) return k;
    }
  }

  // 2. Ordered detection per AGENTS.md Rule 3
  if (clean.includes('10bl') || clean.includes('bal10')) return 'bal10';
  if (clean.includes('15bl') || clean.includes('bal15')) return 'bal15';
  if (clean.includes('20bl') || clean.includes('bal20')) return 'bal20';
  if (clean.includes('25bl') || clean.includes('bal25')) return 'bal25';
  if (clean.includes('5bl') || clean.includes('bal5')) return 'bal5';
  if (clean.includes('bal') || clean.includes('bl')) return 'bal';
  if (clean.includes('pack3') || clean.includes('pk3') || clean.includes('3pk')) return 'pack3';
  if (clean.includes('pack6') || clean.includes('pk6') || clean.includes('6pk')) return 'pack6';
  if (clean.includes('pack5') || clean.includes('pk5')) return 'pack';
  if (clean.includes('pack') || clean.includes('pk')) return 'pack';
  if (clean.includes('lusin') || clean.includes('doz') || clean.includes('dozen')) return 'lusin';

  return 'pcs';
}

/**
 * Resolves the multiplier for a unit, preferring the owner/warehouse configured
 * multipliers (custom units can differ per owner) and falling back to the
 * canonical AGENTS.md multipliers.
 */
export function resolveUnitMultiplier(unit, unitMultipliers = null) {
  const clean = String(unit || 'pcs').toLowerCase().trim();
  if (unitMultipliers && typeof unitMultipliers === 'object') {
    const custom = Number(unitMultipliers[clean]);
    if (!isNaN(custom) && custom > 0) return custom;
  }
  return CANONICAL_MULTIPLIERS[clean] || 1;
}

/**
 * Resolves base quantity in pcs.
 * @param {object|null} unitMultipliers owner/warehouse multiplier map (optional)
 */
export function resolveSerialBaseQty(serialNumber, explicitUnit = null, explicitQty = null, unitMultipliers = null) {
  const unit = (explicitUnit || parseUnitFromSerialNumber(serialNumber)).toLowerCase().trim();
  const mult = resolveUnitMultiplier(unit, unitMultipliers);
  const count = typeof explicitQty === 'number' && !isNaN(explicitQty) && explicitQty > 0 ? explicitQty : 1;
  return count * mult;
}

/**
 * Resolves how many units a single serial record represents.
 *
 * Goods In stores `metadata.unitQty` as the unit multiplier (e.g. lusin = 12),
 * not as a unit count. A physical base serial always represents one unit.
 * Group serials are different: their `metadata.unitQty`/`targetQty` is the
 * resulting unit count and their `metadata.totalPcs` is the base quantity.
 */
export function resolveSerialUnitCount(metadata = {}) {
  if (metadata?.isGroup) {
    const groupQty = Number(metadata.targetQty ?? metadata.unitQty);
    if (Number.isFinite(groupQty) && groupQty > 0) return groupQty;
  }
  return 1;
}

/**
 * PHASE 7E — Resolve the source-product composition of a batch.
 * The identity MUST come from the verified serial records (`product_id`),
 * never from the serial number text or a guessed SKU.
 *
 * When every serial belongs to the SAME source product, the result product is
 * locked to that product (auto-detect). Mixed batches remain selectable.
 */
export function resolveSourceProductPolicy(members = []) {
  const byProduct = new Map();

  for (const m of members || []) {
    const productId = m?.product_id || m?.productId || null;
    if (!productId) continue;

    const productName = m?.product?.name || m?.productName || 'Produk';
    const sku = m?.product?.sku || m?.sku || '';

    if (!byProduct.has(productId)) {
      byProduct.set(productId, { productId, productName, sku, serialCount: 0, totalPcs: 0 });
    }

    const entry = byProduct.get(productId);
    const meta = m?.metadata || {};
    const serialNumber = m?.serial_number || m?.serialNumber || '';
    const unit = meta.unit || m?.unit || parseUnitFromSerialNumber(serialNumber);
    const unitQty = resolveSerialUnitCount(meta);
    const pcs = Number(meta.totalPcs ?? m?.pcs) || resolveSerialBaseQty(serialNumber, unit, unitQty);

    entry.serialCount += 1;
    entry.totalPcs += pcs;
  }

  const sourceProducts = Array.from(byProduct.values()).sort((a, b) => {
    if (b.serialCount !== a.serialCount) return b.serialCount - a.serialCount;
    return String(a.productName).localeCompare(String(b.productName));
  });

  const distinctProductCount = sourceProducts.length;
  const productSelectionLocked = distinctProductCount === 1;

  return {
    sourceProducts,
    distinctProductCount,
    isSingleSourceProduct: productSelectionLocked,
    productSelectionLocked,
    lockedResultProductId: productSelectionLocked ? sourceProducts[0].productId : null,
  };
}

/**
 * PHASE 7E — Build a business validation error with a stable code.
 */
export function buildGroupingPolicyError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Calculates item hierarchy nesting depth
 */
export function calculateItemNestingDepth(item) {
  if (!item || !item.isGroup) return 1;
  const children = Array.isArray(item.directMembers) && item.directMembers.length > 0
    ? item.directMembers
    : (Array.isArray(item.composition) ? item.composition : []);
  if (children.length === 0) return 1;
  const childDepths = children.map((c) => calculateItemNestingDepth(c));
  return 1 + Math.max(...childDepths);
}

/**
 * Flattens nested groups recursively to leaf-level serial items
 */
export function extractLeafComposition(items) {
  const leaves = [];

  function traverse(item) {
    if (item.isGroup && Array.isArray(item.composition) && item.composition.length > 0) {
      for (const child of item.composition) {
        traverse(child);
      }
    } else {
      leaves.push({
        serialId: item.serialId || item.id,
        serialNumber: item.serialNumber,
        productId: item.productId,
        productName: item.productName,
        sku: item.sku,
        unit: item.unit,
        unitQty: item.unitQty || 1,
        pcs: item.pcs || resolveSerialBaseQty(item.serialNumber, item.unit, item.unitQty),
        warehouseId: item.warehouseId || null,
        batchNumber: item.batchNumber || null,
      });
    }
  }

  for (const it of items) {
    traverse(it);
  }

  return leaves;
}

/**
 * Formats business date as DDMMYYYY using consistent business timezone (default Asia/Jakarta)
 */
export function getBusinessDateDDMMYYYY(date = new Date(), timeZone = 'Asia/Jakarta') {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const parts = formatter.formatToParts(d);
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const year = parts.find((p) => p.type === 'year')?.value || '2026';
  return `${day}${month}${year}`;
}

/**
 * Normalizes unit string to uppercase canonical form for serial number code
 * E.g. pcs -> PCS, lusin -> LUSIN, pack -> PACK, bal10 -> BAL10, bal25 / bal -> BAL25
 */
export function normalizeSerialUnitCode(unit) {
  if (!unit) return 'PCS';
  const clean = String(unit).toLowerCase().trim();
  if (clean === 'pcs' || clean === 'piece') return 'PCS';
  if (clean === 'lusin' || clean === 'dozen' || clean === 'doz') return 'LUSIN';
  if (clean === 'pack' || clean === 'pk') return 'PACK';
  if (clean === 'bal10' || clean === '10bl') return 'BAL10';
  if (clean === 'bal15' || clean === '15bl') return 'BAL15';
  if (clean === 'bal20' || clean === '20bl') return 'BAL20';
  if (clean === 'bal25' || clean === '25bl' || clean === 'bal' || clean === 'bl') return 'BAL25';
  if (clean === 'bal5' || clean === '5bl') return 'BAL5';
  return clean.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PCS';
}

/**
 * Formats prefix for grouped serial number:
 * [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY]
 * E.g. BUNDLE01-G-3LUSIN-23102026
 */
export function formatGroupSerialPrefix({
  sku,
  targetQty,
  targetUnit,
  date = new Date(),
  timeZone = 'Asia/Jakarta',
}) {
  const cleanSku = (sku || 'GRP').toUpperCase().replace(/[^A-Z0-9_-]/g, '').trim() || 'GRP';
  const cleanUnit = normalizeSerialUnitCode(targetUnit);
  const numQty = Number(targetQty) || 1;
  const qtyStr = Number.isInteger(numQty) ? String(numQty) : String(Math.round(numQty * 100) / 100);
  const dateStr = getBusinessDateDDMMYYYY(date, timeZone);
  return `${cleanSku}-G-${qtyStr}${cleanUnit}-${dateStr}`;
}

/**
 * Formats full serial number from prefix and sequence:
 * [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY][NOMOR URUT]
 * E.g. BUNDLE01-G-3LUSIN-231020260001
 */
export function formatGroupSerialNumber({ prefix, sequence = 1, seqLength = 4 }) {
  const seqNum = Number(sequence) || 1;
  const seqStr = String(seqNum).padStart(seqLength, '0');
  return `${prefix}${seqStr}`;
}

/**
 * Generates unique serial number with concurrency protection:
 * [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY][NOMOR URUT]
 * Queries existing serials starting with prefix to find max sequence and increments atomically.
 */
export async function generateGroupSerialNumber({
  ownerId,
  sku,
  targetQty,
  targetUnit,
  date = new Date(),
  timeZone = 'Asia/Jakarta',
  sequence = null,
  seqLength = 4,
  supabaseClient = supabaseAdmin,
}) {
  const prefix = formatGroupSerialPrefix({ sku, targetQty, targetUnit, date, timeZone });
  const dateStr = getBusinessDateDDMMYYYY(date, timeZone);

  if (sequence !== null && sequence !== undefined) {
    const seqNum = Number(sequence) || 1;
    const seqStr = String(seqNum).padStart(seqLength, '0');
    return {
      serialNumber: `${prefix}${seqStr}`,
      prefix,
      sequence: seqNum,
      sequenceStr: seqStr,
      dateStr,
    };
  }

  // Find existing sequences in product_serials and serial_groupings
  const existingSeqs = [];

  const escapedPrefix = escapeLikePattern(prefix);
  const [psRes, sgRes] = await Promise.all([
    supabaseClient
      .from('product_serials')
      .select('serial_number')
      .eq('owner_id', ownerId)
      .ilike('serial_number', `${escapedPrefix}%`),
    supabaseClient
      .from('serial_groupings')
      .select('grouping_number')
      .eq('owner_id', ownerId)
      .ilike('grouping_number', `${escapedPrefix}%`),
  ]);

  const pSerials = psRes?.data || [];
  const gSerials = sgRes?.data || [];

  const allStrings = [
    ...pSerials.map((s) => s.serial_number),
    ...gSerials.map((s) => s.grouping_number),
  ].filter(Boolean);

  for (const sn of allStrings) {
    if (sn.startsWith(prefix)) {
      const suffix = sn.slice(prefix.length);
      const match = suffix.match(/^(\d+)/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (!isNaN(val) && val > 0) {
          existingSeqs.push(val);
        }
      }
    }
  }

  const maxSeq = existingSeqs.length > 0 ? Math.max(...existingSeqs) : 0;
  const nextSeq = maxSeq + 1;
  const seqStr = String(nextSeq).padStart(seqLength, '0');

  return {
    serialNumber: `${prefix}${seqStr}`,
    prefix,
    sequence: nextSeq,
    sequenceStr: seqStr,
    dateStr,
  };
}

/**
 * Generates formatted breakdown text (e.g. "1 bal25, 2 lusin, 5 pcs")
 */
export function formatCompositionBreakdown(leaves) {
  const unitMap = {};
  for (const leaf of leaves) {
    const u = leaf.unit || 'pcs';
    const q = leaf.unitQty || 1;
    unitMap[u] = (unitMap[u] || 0) + q;
  }
  const parts = Object.entries(unitMap).map(([u, q]) => `${q} ${u}`);
  return parts.length > 0 ? parts.join(', ') : '0 pcs';
}

/**
 * Validates unit compatibility and enforces exact divisible quantity matching.
 * Rejects conversions if target unit is unknown or base quantities leave a remainder.
 */
export function validateGroupingUnitAndQuantity({
  leafComposition = [],
  components = [],
  targetUnit = 'pcs',
  customUnits = [],
  multipliers = {},
}) {
  const items = leafComposition.length > 0 ? leafComposition : components;
  const cleanTargetUnit = String(targetUnit || 'pcs').toLowerCase().trim();
  const effectiveMultipliers = { ...CANONICAL_MULTIPLIERS, ...(multipliers || {}) };

  // Support custom units key lookup
  if (Array.isArray(customUnits)) {
    for (const cu of customUnits) {
      if (cu.key && cu.multiplier) {
        effectiveMultipliers[String(cu.key).toLowerCase().trim()] = Number(cu.multiplier);
      }
    }
  }

  const targetMultiplier = effectiveMultipliers[cleanTargetUnit];
  if (typeof targetMultiplier !== 'number' || isNaN(targetMultiplier) || targetMultiplier <= 0) {
    const err = new Error(`UNIT_CONVERSION_UNSUPPORTED: Satuan target "${cleanTargetUnit}" tidak didukung atau tidak memiliki rasio konversi baku.`);
    err.code = 'UNIT_CONVERSION_UNSUPPORTED';
    err.status = 400;
    throw err;
  }

  // Validate all component units
  for (const item of items) {
    const compUnit = String(item.unit || item.productUnit || item.product?.unit || 'pcs').toLowerCase().trim();
    const compMult = item.unitMultiplier || effectiveMultipliers[compUnit];
    if (!compMult || compMult <= 0) {
      const err = new Error(`UNIT_CONVERSION_UNSUPPORTED: Satuan komponen "${compUnit}" tidak didukung atau tidak memiliki rasio konversi baku.`);
      err.code = 'UNIT_CONVERSION_UNSUPPORTED';
      err.status = 400;
      throw err;
    }
  }

  const totalBaseQtyPcs = items.reduce((sum, item) => sum + (Number(item.pcs ?? item.effectivePcs) || 0), 0);
  if (totalBaseQtyPcs <= 0) {
    const err = new Error('UNIT_MISMATCH: Total kuantitas dasar serial anggota harus lebih besar dari 0 pcs.');
    err.code = 'UNIT_MISMATCH';
    err.status = 400;
    throw err;
  }

  const remainder = totalBaseQtyPcs % targetMultiplier;
  if (remainder !== 0) {
    const err = new Error(
      `UNIT_MISMATCH: Total kuantitas serial anggota (${totalBaseQtyPcs} pcs) tidak dapat dibagi genap menjadi satuan target "${cleanTargetUnit}" (1 ${cleanTargetUnit} = ${targetMultiplier} pcs). Sisa tidak terbagi: ${remainder} pcs.`
    );
    err.code = 'UNIT_MISMATCH';
    err.status = 400;
    err.totalBaseQtyPcs = totalBaseQtyPcs;
    err.targetMultiplier = targetMultiplier;
    err.remainder = remainder;
    throw err;
  }

  const targetQty = totalBaseQtyPcs / targetMultiplier;
  return {
    isValid: true,
    targetUnit: cleanTargetUnit,
    targetMultiplier,
    totalBaseQtyPcs,
    targetQty,
  };
}

/**
 * Calculates COGS / HPP for serial grouping based on component product unit costs.
 * Preserves historical costing snapshots for audit integrity.
 */
export function calculateGroupingCosts({
  directMembers = [],
  components = [],
  targetQty = 1,
  multipliers = {},
}) {
  const effectiveMultipliers = { ...CANONICAL_MULTIPLIERS, ...(multipliers || {}) };
  const members = directMembers.length > 0 ? directMembers : components;

  const enrichedMembers = members.map((d) => {
    let compUnitCost = 0;
    let compTotalCost = 0;
    let costPerPcs = 0;

    if (d.isGroup && (d.totalCost !== undefined || d.metadata?.totalCost !== undefined)) {
      compTotalCost = Number(d.totalCost ?? d.metadata?.totalCost ?? 0);
      const pcs = Number(d.pcs ?? d.effectivePcs ?? 1);
      costPerPcs = pcs > 0 ? Math.round((compTotalCost / pcs) * 100) / 100 : compTotalCost;
      const unitQty = d.unitQty || 1;
      compUnitCost = unitQty > 0 ? Math.round((compTotalCost / unitQty) * 100) / 100 : compTotalCost;
    } else {
      const rawProdCost = Number(d.productUnitCost ?? d.product?.unit_cost ?? 0);
      const prodUnit = String(d.productUnit || d.product?.unit || d.product?.metadata?.unit || 'pcs').toLowerCase().trim();
      const prodMultiplier = d.unitMultiplier || effectiveMultipliers[prodUnit] || 1;

      // Base cost per pcs of component
      costPerPcs = prodMultiplier > 0 ? (rawProdCost / prodMultiplier) : rawProdCost;
      const effectiveQty = Number(d.pcs ?? d.effectivePcs ?? 0);
      compTotalCost = Math.round(effectiveQty * costPerPcs * 100) / 100;
      const compUnit = String(d.unit || d.productUnit || d.product?.unit || 'pcs').toLowerCase().trim();
      const compUnitMult = d.unitMultiplier || effectiveMultipliers[compUnit] || 1;
      compUnitCost = Math.round(costPerPcs * compUnitMult * 100) / 100;
    }

    return {
      ...d,
      costPerPcs,
      unitCost: compUnitCost,
      totalCost: compTotalCost,
    };
  });

  const totalCost = Math.round(enrichedMembers.reduce((sum, c) => sum + (c.totalCost || 0), 0) * 100) / 100;
  const resultUnitCost = targetQty > 0 ? Math.round((totalCost / targetQty) * 100) / 100 : 0;

  const componentSnapshots = enrichedMembers.map((m) => ({
    serialId: m.serialId || m.id,
    serialNumber: m.serialNumber || m.serial_number,
    productId: m.productId || m.product_id,
    productName: m.productName || m.product?.name,
    sku: m.sku || m.product?.sku,
    unit: m.unit || m.productUnit || m.product?.unit || 'pcs',
    unitQty: m.unitQty || 1,
    costPerPcs: m.costPerPcs,
    unitCost: m.unitCost,
    totalCost: m.totalCost,
  }));

  return {
    enrichedMembers,
    componentSnapshots,
    totalCost,
    resultUnitCost,
  };
}

/**
 * Determines strictly whether an error indicates that the PostgreSQL RPC function
 * is not deployed or not found in the PostgREST schema cache.
 * All other errors (constraint violations, custom exceptions, validation errors, auth failures)
 * are genuine execution failures and MUST NOT trigger fallback execution.
 */
export function isRpcNotAvailableError(error) {
  if (!error) return false;
  const code = String(error.code || '').trim().toUpperCase();
  const message = String(error.message || '').toLowerCase();

  // Explicitly reject errors that are execution / constraint / logic errors:
  if (
    code === '23505' || // Unique constraint
    code === '23503' || // Foreign key constraint
    code === '23514' || // Check constraint
    code === 'PGRST204' || // Signature / parameter mismatch
    code === '42501' || // Insufficient privilege
    code.startsWith('P0') || // PL/pgSQL custom exception (P0001-P0004)
    code.startsWith('23') || // All integrity constraint violations
    message.includes('duplicate key') ||
    message.includes('violates foreign key') ||
    message.includes('violates check') ||
    message.includes('signature mismatch') ||
    message.includes('signature')
  ) {
    return false;
  }

  // Explicit check for undefined function in PostgreSQL
  if (code === '42883') return true;

  // PostgREST: function not found in schema cache
  if (code === 'PGRST202') return true;

  // Standard PostgREST 404 message for missing RPC function
  if (message.includes('could not find the function') && message.includes('schema cache')) {
    return true;
  }
  if (message.includes('function') && message.includes('does not exist')) {
    return true;
  }
  if (message.includes('rpc not implemented')) {
    return true;
  }

  return false;
}

/**
 * Formats a PostgreSQL / PostgREST RPC error into a safe, human-readable Error
 * without exposing internal connection strings or secrets.
 */
export function handleRpcExecutionError(error, defaultMessage = 'Operasi database gagal.') {
  if (!error) throw new Error(defaultMessage);
  const code = String(error.code || '').trim().toUpperCase();
  const message = String(error.message || '').trim();
  const details = String(error.details || '').trim();

  // Unique constraint violation (23505)
  if (code === '23505' || message.includes('duplicate key') || message.includes('DUPLICATE_GROUP_SERIAL')) {
    throw new Error('Nomor seri group sudah pernah digunakan. Masukkan nomor seri yang unik.');
  }

  // Foreign key constraint violation (23503)
  if (code === '23503') {
    if (details.includes('product_id') || message.includes('product_id')) {
      throw new Error('Produk hasil group tidak valid atau tidak ditemukan dalam sistem.');
    }
    if (details.includes('warehouse_id') || message.includes('warehouse_id')) {
      throw new Error('Gudang yang ditentukan tidak valid atau tidak ditemukan.');
    }
    throw new Error('Referensi relasi data tidak valid (Foreign Key Constraint).');
  }

  // Check constraint violation (23514)
  if (code === '23514') {
    throw new Error('Nilai kolom tidak memenuhi batasan status atau kuantitas database (Check Constraint).');
  }

  // Signature mismatch or parameter error (PGRST204)
  if (code === 'PGRST204' || message.toLowerCase().includes('searched for the function') || message.toLowerCase().includes('signature mismatch')) {
    throw new Error('Format atau tipe parameter pemanggilan RPC tidak sesuai dengan database.');
  }

  if (message.includes('IDEMPOTENCY_PAYLOAD_MISMATCH')) {
    throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key yang sama digunakan dengan payload grouping yang berbeda. Gunakan key baru untuk transaksi yang berbeda.');
  }

  // PHASE 7G — RPC-level product lock (defense-in-depth). Preserve the stable
  // business code so API clients see the same contract as the service check.
  if (message.includes('PRODUCT_LOCKED_SINGLE_SOURCE') || code === 'P0006') {
    const policyError = new Error(
      'PRODUCT_LOCKED_SINGLE_SOURCE: Semua serial berasal dari satu produk sumber; produk hasil wajib mengikuti produk sumber dan tidak dapat diganti atau dibuat sebagai master baru.'
    );
    policyError.code = 'PRODUCT_LOCKED_SINGLE_SOURCE';
    policyError.status = 400;
    throw policyError;
  }

  // Custom PL/pgSQL exceptions (errcode P0001, P0002, P0003, P0004, etc.)
  if (code.startsWith('P0') || code.startsWith('P')) {
    throw new Error(message || defaultMessage);
  }

  // Insufficient privilege (42501)
  if (code === '42501') {
    throw new Error('Akses database ditolak: Hak akses tidak mencukupi untuk menjalankan fungsi RPC.');
  }

  throw new Error(message || defaultMessage);
}

/**
 * Helper to revert member locks in case of mid-operation failures
 */
async function rollbackMemberLocks(memberIds, originalMetas, ownerId, supabaseClient) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) return;
  for (const id of memberIds) {
    const orig = originalMetas.get(id);
    if (orig) {
      await supabaseClient
        .from('product_serials')
        .update({
          metadata: orig,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('owner_id', ownerId);
    }
  }
}

/**
 * Helper to record official goods_assembly ledger document and serial_groupings tables
 */
async function recordGroupingLedgerAndHeader({
  ownerId,
  userId,
  targetWarehouseId,
  createdGroup,
  finalGroupSN,
  finalResultProductId,
  finalResultProductName,
  finalResultProductSku,
  resolvedTargetUnit,
  targetQty,
  totalBaseQtyPcs,
  totalCost,
  resultUnitCost,
  enrichedDirectMembers,
  groupMetadata,
  isCrossProduct,
  idempotencyKey,
  notes,
  nowIso,
  supabaseClient,
}) {
  const dateCode = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(new Date())
    .replace(/-/g, '');
  const assemblyDocNumber = buildGroupingDocumentNumber('ASM', dateCode, finalGroupSN);

  let assemblyDoc = null;
  let groupingRecord = null;

  try {
    const { data: docRow, error: docErr } = await supabaseClient
      .from('documents')
      .insert({
        owner_id: ownerId,
        warehouse_id: targetWarehouseId,
        document_type: 'goods_assembly',
        document_number: assemblyDocNumber,
        status: 'completed',
        issue_date: nowIso.split('T')[0],
        subtotal: totalCost,
        total: totalCost,
        created_by: userId,
        notes: notes || (isCrossProduct ? 'Assembly penggabungan serial lintas produk' : 'Assembly serial group produk sejenis'),
        metadata: {
          groupingNumber: finalGroupSN,
          resultProductId: finalResultProductId,
          resultProductName: finalResultProductName,
          resultProductSku: finalResultProductSku,
          resultSerialId: createdGroup.id,
          targetUnit: resolvedTargetUnit,
          targetQty,
          totalBaseQtyPcs,
          totalCost,
          resultUnitCost,
          isCrossProduct,
          idempotencyKey: idempotencyKey || null,
        },
      })
      .select()
      .single();

    if (docErr || !docRow) {
      throw new Error(`Gagal membuat dokumen ledger goods_assembly: ${docErr?.message || 'dokumen tidak terbentuk'}`);
    }
    assemblyDoc = docRow;

    const docItemsPayload = [];

    for (let i = 0; i < enrichedDirectMembers.length; i++) {
      const d = enrichedDirectMembers[i];
      const componentUnit = d.unit || 'pcs';
      const componentQty = d.unitQty || 1;
      docItemsPayload.push({
        document_id: docRow.id,
        product_id: d.productId,
        item_name: d.productName || 'Komponen Group',
        sku: d.sku || '',
        quantity: componentQty,
        unit_price: d.unitCost || 0,
        amount: d.totalCost || 0,
        sort_order: i + 1,
        metadata: {
          assemblyRole: 'component',
          movementType: 'out',
          serialId: d.serialId,
          serialNumber: d.serialNumber,
          unit: componentUnit,
          qtyUnit: componentUnit,
          qtyInput: componentQty,
          baseQtyPcs: d.pcs || 1,
          isGroup: Boolean(d.isGroup),
        },
      });
    }

    docItemsPayload.push({
      document_id: docRow.id,
      product_id: finalResultProductId,
      item_name: finalResultProductName || 'Produk Hasil Grouping',
      sku: finalResultProductSku || '',
      quantity: targetQty,
      unit_price: resultUnitCost,
      amount: totalCost,
      sort_order: enrichedDirectMembers.length + 1,
      metadata: {
        assemblyRole: 'result',
        movementType: 'in',
        serialId: createdGroup.id,
        serialNumber: finalGroupSN,
        unit: resolvedTargetUnit,
        targetUnit: resolvedTargetUnit,
        qtyUnit: resolvedTargetUnit,
        qtyInput: targetQty,
        baseQtyPcs: totalBaseQtyPcs,
      },
    });

    const { error: itemsErr } = await supabaseClient
      .from('document_items')
      .insert(docItemsPayload);

    if (itemsErr) {
      throw new Error(`Gagal membuat item ledger goods_assembly: ${itemsErr.message}`);
    }

    const { data: grpRow, error: grpErr } = await supabaseClient
      .from('serial_groupings')
      .insert({
        owner_id: ownerId,
        grouping_number: finalGroupSN,
        warehouse_id: targetWarehouseId,
        status: 'active',
        group_type: isCrossProduct ? 'mixed' : 'single_product',
        result_product_id: finalResultProductId,
        result_serial_id: createdGroup.id,
        result_serial_number: finalGroupSN,
        target_unit: resolvedTargetUnit,
        target_qty: targetQty,
        total_base_qty_pcs: totalBaseQtyPcs,
        total_cost: totalCost,
        result_unit_cost: resultUnitCost,
        source_document_id: assemblyDoc.id,
        reverse_document_id: null,
        idempotency_key: idempotencyKey || null,
        notes: notes || null,
        metadata: groupMetadata,
        created_by: userId,
      })
      .select()
      .single();

    if (grpErr || !grpRow) {
      throw new Error(`Gagal membuat header serial_groupings: ${grpErr?.message || 'header tidak terbentuk'}`);
    }
    groupingRecord = grpRow;

    const componentsPayload = buildGroupingComponentsPayload(enrichedDirectMembers).map((component) => ({
      ...component,
      grouping_id: grpRow.id,
      owner_id: ownerId,
    }));

    const { error: componentsErr } = await supabaseClient
      .from('serial_grouping_components')
      .insert(componentsPayload);

    if (componentsErr) {
      throw new Error(`Gagal membuat komponen serial_grouping_components: ${componentsErr.message}`);
    }

    return { assemblyDoc, groupingRecord };
  } catch (err) {
    if (groupingRecord?.id) {
      try {
        await supabaseClient
          .from('serial_groupings')
          .delete()
          .eq('id', groupingRecord.id)
          .eq('owner_id', ownerId);
      } catch (cleanupErr) {
        console.error('Gagal membersihkan serial_groupings parsial:', cleanupErr?.message || cleanupErr);
      }
    }
    if (assemblyDoc?.id) {
      try {
        await supabaseClient
          .from('documents')
          .delete()
          .eq('id', assemblyDoc.id)
          .eq('owner_id', ownerId);
      } catch (cleanupErr) {
        console.error('Gagal membersihkan dokumen ledger parsial:', cleanupErr?.message || cleanupErr);
      }
    }
    throw err;
  }
}

/**
 * Best-effort compensation for a group that was atomically claimed by the legacy
 * RPC (022) but whose ledger/header write failed afterwards.
 */
async function rollbackCommittedGrouping({ ownerId, group, groupingRecord, assemblyDoc, supabaseClient }) {
  const cleanupErrors = [];

  try {
    if (typeof supabaseClient.rpc === 'function' && group?.id) {
      await supabaseClient.rpc('ungroup_serial_atomic', {
        p_owner_id: ownerId,
        p_user_id: null,
        p_user_name: 'System Rollback',
        p_group_id: group.id,
        p_group_serial_number: group.serial_number,
        p_notes: 'Automatic rollback: ledger grouping gagal ditulis',
      });
    }
  } catch (err) {
    cleanupErrors.push(`ungroup: ${err?.message || err}`);
  }

  try {
    if (groupingRecord?.id) {
      await supabaseClient.from('serial_groupings').delete().eq('id', groupingRecord.id).eq('owner_id', ownerId);
    }
  } catch (err) {
    cleanupErrors.push(`grouping: ${err?.message || err}`);
  }

  try {
    if (assemblyDoc?.id) {
      await supabaseClient.from('documents').delete().eq('id', assemblyDoc.id).eq('owner_id', ownerId);
    }
  } catch (err) {
    cleanupErrors.push(`document: ${err?.message || err}`);
  }

  try {
    if (group?.id) {
      await supabaseClient.from('product_serials').delete().eq('id', group.id).eq('owner_id', ownerId);
    }
  } catch (err) {
    cleanupErrors.push(`result_serial: ${err?.message || err}`);
  }

  if (cleanupErrors.length > 0) {
    console.error('Rollback grouping parsial tidak sepenuhnya bersih:', cleanupErrors.join(' | '));
  }
}

/**
 * Main Service: Group Serial Numbers
 * All-or-nothing execution with concurrency protection & rollback safety
 */
export async function createSerialGroup({
  ownerId,
  userId,
  userName = 'System User',
  memberSerialIds = [],
  memberSerialNumbers = [],
  groupSerialNumber = null,
  resultProductName = null,
  resultProductSku = null,
  resultProductId = null,
  createNewMasterProduct = false,
  targetUnit = null,
  warehouseId = null,
  idempotencyKey = null,
  notes = null,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  const payloadHash = buildGroupingPayloadHash({
    memberIds: memberSerialIds,
    memberSerialNumbers,
    resultProductId,
    resultProductName,
    resultProductSku,
    targetUnit,
    warehouseId,
    groupSerialNumber,
    createNewMasterProduct,
  });

  // 0. Idempotency Check
  if (idempotencyKey) {
    const { data: existingGroupTx } = await supabaseClient
      .from('serial_groupings')
      .select('*, result_serial:product_serials(*)')
      .eq('owner_id', ownerId)
      .eq('idempotency_key', idempotencyKey)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (existingGroupTx) {
      const storedHash = existingGroupTx.metadata?.idempotencyHash;
      if (storedHash && storedHash !== payloadHash) {
        throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key yang sama digunakan dengan payload grouping yang berbeda.');
      }
      return {
        success: true,
        isReplay: true,
        group: existingGroupTx.result_serial || {
          id: existingGroupTx.result_serial_id,
          serial_number: existingGroupTx.result_serial_number,
        },
        groupingRecord: existingGroupTx,
        totalPcs: existingGroupTx.total_base_qty_pcs,
        targetUnit: existingGroupTx.target_unit,
        targetQty: existingGroupTx.target_qty,
        totalCost: existingGroupTx.total_cost,
        resultUnitCost: existingGroupTx.result_unit_cost,
        executionEngine: 'idempotent_replay',
      };
    }
  }

  // 1. Validasi duplikat dan jumlah pada input request
  const rawInputList = (Array.isArray(memberSerialIds) && memberSerialIds.length > 0)
    ? memberSerialIds
    : (Array.isArray(memberSerialNumbers) && memberSerialNumbers.length > 0 ? memberSerialNumbers : []);

  if (rawInputList.length === 0) {
    throw new Error('Pilih minimal 2 nomor seri untuk digabungkan menjadi group.');
  }

  if (rawInputList.length === 1) {
    throw new Error('Minimal harus memilih 2 nomor seri yang valid untuk membuat group.');
  }

  if (new Set(rawInputList.map((value) => String(value).trim().toLowerCase())).size !== rawInputList.length) {
    throw new Error('DUPLICATE_MEMBERS: Ditemukan nomor seri duplikat dalam request grouping.');
  }

  // 2. Ambil data serial anggota (serial number dibandingkan case-insensitive)
  const { data: rawMembers, error: memberErr } = await fetchGroupingMembers({
    ownerId,
    memberSerialIds,
    memberSerialNumbers,
    supabaseClient,
  });
  if (memberErr) throw new Error(`Gagal memuat serial anggota: ${memberErr.message}`);

  const members = rawMembers || [];
  if (members.length < 2) {
    throw new Error('Minimal harus memilih 2 nomor seri yang valid untuk membuat group.');
  }

  // 3. Validasi keseragaman gudang (Warehouse Isolation)
  const warehouseIds = Array.from(new Set(members.map((m) => m.warehouse_id).filter(Boolean)));
  if (warehouseIds.length > 1) {
    throw new Error(`Semua nomor seri dalam satu group harus berasal dari gudang yang sama. Ditemukan nomor seri dari ${warehouseIds.length} gudang berbeda.`);
  }

  const targetWarehouseId = warehouseId || warehouseIds[0] || members[0].warehouse_id || null;
  if (warehouseId && warehouseIds.length > 0 && String(warehouseId) !== String(warehouseIds[0])) {
    throw new Error(`Nomor seri yang dipilih berada di gudang yang berbeda dari gudang target (${warehouseId} vs ${warehouseIds[0]}).`);
  }

  // 4. Validasi status, ketersediaan, dan integritas anggota
  const originalMetaMap = new Map();
  for (const m of members) {
    originalMetaMap.set(m.id, m.metadata || {});

    if (!m.product) {
      throw new Error(`Nomor seri "${m.serial_number}" tidak memiliki relasi produk yang valid atau produk telah dinonaktifkan.`);
    }
    if (m.goods_out_document_id) {
      throw new Error(`Nomor seri "${m.serial_number}" sudah dikeluarkan (tercatat pada dokumen keluar) dan tidak dapat digabungkan.`);
    }
    if (m.status !== 'available') {
      throw new Error(`Nomor seri "${m.serial_number}" tidak dapat di-group karena berstatus "${m.status}". Hanya serial "available" yang dapat digabungkan.`);
    }
    if (m.metadata?.isGrouped || m.metadata?.parentGroupId) {
      throw new Error(`Nomor seri "${m.serial_number}" sudah berada di dalam group "${m.metadata?.parentGroupSerialNumber || 'Group lain'}". Bongkar group induk terlebih dahulu jika ingin mengelompokkan ulang.`);
    }
    if (m.metadata?.isDissolved) {
      throw new Error(`Nomor seri "${m.serial_number}" adalah group yang sudah dibongkar (dissolved) dan tidak dapat digabungkan.`);
    }

    if (m.metadata?.isGroup) {
      const currentDepth = calculateItemNestingDepth({ isGroup: true, directMembers: m.metadata?.directMembers || m.metadata?.composition });
      if (currentDepth >= MAX_GROUP_NESTING_DEPTH) {
        throw new Error(`Batas kedalaman hierarki group tercapai (maksimal ${MAX_GROUP_NESTING_DEPTH} level: Satuan Dasar -> Box/Karton -> Pallet/Koli). Serial group "${m.serial_number}" sudah memiliki kedalaman ${currentDepth}.`);
      }
    }
  }

  // 5. Evaluasi Produk Anggota (Single-product vs Cross-product)
  const productIds = Array.from(new Set(members.map((m) => m.product_id)));
  const isCrossProduct = productIds.length > 1;

  // PHASE 7E — Auto-detect & product lock.
  // Bila SEMUA serial berasal dari produk master yang sama, produk hasil WAJIB
  // mengikuti produk sumber. Divalidasi di backend, bukan hanya di frontend.
  const sourceProductPolicy = resolveSourceProductPolicy(members);
  if (sourceProductPolicy.productSelectionLocked) {
    const lockedName = sourceProductPolicy.sourceProducts[0]?.productName || 'produk sumber';

    if (createNewMasterProduct) {
      throw buildGroupingPolicyError(
        'PRODUCT_LOCKED_SINGLE_SOURCE',
        `Semua serial berasal dari produk yang sama ("${lockedName}"). Produk hasil dikunci mengikuti produk sumber, sehingga pembuatan master produk baru tidak diizinkan.`
      );
    }

    if (resultProductId && String(resultProductId) !== String(sourceProductPolicy.lockedResultProductId)) {
      throw buildGroupingPolicyError(
        'PRODUCT_LOCKED_SINGLE_SOURCE',
        `Semua serial berasal dari produk yang sama ("${lockedName}"). Produk hasil tidak dapat diganti ke produk lain.`
      );
    }
  }

  let finalResultProductName = resultProductName ? String(resultProductName).trim() : null;
  let finalResultProductId = resultProductId || null;
  let finalResultProductSku = resultProductSku ? String(resultProductSku).trim() : null;
  let targetProduct = null;

  if (finalResultProductId) {
    const { data: prodData } = await supabaseClient
      .from('products')
      .select('id, name, sku, unit_cost, metadata')
      .eq('id', finalResultProductId)
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (prodData) {
      targetProduct = prodData;
      finalResultProductName = finalResultProductName || prodData.name;
      finalResultProductSku = finalResultProductSku || prodData.sku;
    }
  } else if (!isCrossProduct && !createNewMasterProduct) {
    targetProduct = members[0].product || {};
    finalResultProductId = targetProduct.id || members[0].product_id;
    finalResultProductName = finalResultProductName || targetProduct.name || 'Produk Group';
    finalResultProductSku = finalResultProductSku || targetProduct.sku || null;
  } else {
    if (!finalResultProductName && !createNewMasterProduct) {
      throw new Error('Grouping lintas produk memerlukan penentuan nama produk hasil grouping atau memilih produk hasil yang sudah ada.');
    }

    if (finalResultProductName) {
      const { data: existingProd } = await supabaseClient
        .from('products')
        .select('id, name, sku, unit_cost, metadata')
        .eq('owner_id', ownerId)
        .ilike('name', escapeLikePattern(finalResultProductName))
        .maybeSingle();

      if (existingProd) {
        targetProduct = existingProd;
        finalResultProductId = existingProd.id;
        finalResultProductSku = finalResultProductSku || existingProd.sku;
      }
    }
  }

  // 6. Susun Komposisi & Anggota Langsung
  const directMembers = [];
  for (const m of members) {
    const meta = m.metadata || {};
    const isSubGroup = Boolean(meta.isGroup);
    const unit = meta.unit || parseUnitFromSerialNumber(m.serial_number, customUnits);
    const unitQty = resolveSerialUnitCount(meta);
    const pcs = isSubGroup && meta.totalPcs ? meta.totalPcs : resolveSerialBaseQty(m.serial_number, unit, unitQty, unitMultipliers);

    directMembers.push({
      serialId: m.id,
      serialNumber: m.serial_number,
      productId: m.product_id,
      productName: m.product?.name || 'Produk',
      sku: m.product?.sku || '',
      unit,
      unitQty,
      pcs,
      isGroup: isSubGroup,
      nestedDepth: isSubGroup ? calculateItemNestingDepth({ isGroup: true, directMembers: meta.directMembers || meta.composition }) : 1,
      composition: isSubGroup ? (meta.composition || meta.directMembers || []) : null,
      warehouseId: m.warehouse_id,
      batchNumber: meta.batchNumber || null,
      preStatus: m.status || 'available',
      productUnitCost: m.product?.unit_cost || 0,
      productUnit: m.product?.metadata?.unit || 'pcs',
      product: m.product,
      metadata: meta,
    });
  }

  const leafComposition = extractLeafComposition(directMembers);
  const resolvedTargetUnit = targetUnit || targetProduct?.metadata?.unit || targetProduct?.unit || 'pcs';

  // 7. Validasi Kompatibilitas Satuan & Kuantitas Eksak
  const unitValidation = validateGroupingUnitAndQuantity({
    leafComposition,
    targetUnit: resolvedTargetUnit,
  });

  const targetQty = unitValidation.targetQty;
  const totalBaseQtyPcs = unitValidation.totalBaseQtyPcs;
  const unitBreakdown = formatCompositionBreakdown(leafComposition);

  // 8. Hitung HPP / Costing Snapshot
  const costResult = calculateGroupingCosts({
    directMembers,
    targetQty,
  });
  const totalCost = costResult.totalCost;
  const resultUnitCost = costResult.resultUnitCost;
  const enrichedDirectMembers = costResult.enrichedMembers;

  // 9. Jika membuat master produk baru
  if (!finalResultProductId && createNewMasterProduct && finalResultProductName) {
    const finalSku = (resultProductSku && String(resultProductSku).trim()) || `GRP-${Date.now().toString(36).toUpperCase()}`;
    const { data: createdProd, error: createProdErr } = await supabaseClient
      .from('products')
      .insert({
        owner_id: ownerId,
        name: finalResultProductName,
        sku: finalSku,
        category: 'Grouping',
        tracking_mode: 'serial',
        status: 'active',
        unit_cost: resultUnitCost,
        metadata: {
          isGroupResultProduct: true,
          createdVia: 'serial_grouping',
          unit: resolvedTargetUnit,
        },
        created_by: userId,
      })
      .select()
      .single();

    if (!createProdErr && createdProd) {
      finalResultProductId = createdProd.id;
      finalResultProductSku = createdProd.sku;
      targetProduct = createdProd;
    }
  }

  // 10. Tentukan Nomor Seri Group Unik sesuai format [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY][NOMOR URUT]
  let finalGroupSN = groupSerialNumber ? String(groupSerialNumber).trim() : null;
  let isAutoGeneratedSN = false;
  let autoGenData = null;

  if (!finalGroupSN) {
    isAutoGeneratedSN = true;
    const targetSku = finalResultProductSku || targetProduct?.sku || 'GRP';
    autoGenData = await generateGroupSerialNumber({
      ownerId,
      sku: targetSku,
      targetQty,
      targetUnit: resolvedTargetUnit,
      date: new Date(),
      supabaseClient,
    });
    finalGroupSN = autoGenData.serialNumber;
  }

  // Validasi keunikan nomor seri group
  const { data: existingSn } = await supabaseClient
    .from('product_serials')
    .select('id')
    .eq('owner_id', ownerId)
    .ilike('serial_number', escapeLikePattern(finalGroupSN))
    .maybeSingle();

  if (existingSn) {
    if (isAutoGeneratedSN) {
      // Re-generate dengan sequence berikutnya
      const targetSku = finalResultProductSku || targetProduct?.sku || 'GRP';
      autoGenData = await generateGroupSerialNumber({
        ownerId,
        sku: targetSku,
        targetQty,
        targetUnit: resolvedTargetUnit,
        date: new Date(),
        sequence: (autoGenData?.sequence || 1) + 1,
        supabaseClient,
      });
      finalGroupSN = autoGenData.serialNumber;
    } else {
      throw new Error(`Nomor seri group "${finalGroupSN}" sudah pernah digunakan. Masukkan nomor seri group yang unik.`);
    }
  }

  const nowIso = new Date().toISOString();

  // Susun metadata group
  const groupMetadata = {
    isGroup: true,
    groupType: isCrossProduct ? 'mixed' : 'single_product',
    resultProductName: finalResultProductName,
    resultProductSku: finalResultProductSku,
    resultProductId: finalResultProductId,
    unit: resolvedTargetUnit,
    serialUnit: resolvedTargetUnit,
    targetUnit: resolvedTargetUnit,
    targetQty,
    unitQty: targetQty,
    totalPcs: totalBaseQtyPcs,
    totalCost,
    resultUnitCost,
    unitCost: resultUnitCost,
    unitBreakdown,
    directMemberCount: directMembers.length,
    leafMemberCount: leafComposition.length,
    idempotencyHash: idempotencyKey ? payloadHash : null,
    composition: leafComposition,
    directMembers: enrichedDirectMembers.map((d) => ({
      serialId: d.serialId,
      serialNumber: d.serialNumber,
      productId: d.productId,
      productName: d.productName,
      sku: d.sku,
      unit: d.unit,
      pcs: d.pcs,
      isGroup: d.isGroup,
      unitCost: d.unitCost,
      totalCost: d.totalCost,
      preStatus: d.preStatus || 'available',
    })),
    history: [
      {
        action: 'grouped',
        timestamp: nowIso,
        userId,
        userName,
        notes: notes || (isCrossProduct ? 'Penggabungan lintas produk' : 'Penggabungan serial produk sejenis'),
      },
    ],
  };

  // 11. ATTEMPT 1: Full PostgreSQL atomic RPC (document + items + grouping + components + members)
  if (typeof supabaseClient.rpc === 'function') {
    let fullRpcRes = null;
    let fullRpcErr = null;
    const maxFullRpcAttempts = isAutoGeneratedSN ? 5 : 1;

    for (let attempt = 1; attempt <= maxFullRpcAttempts; attempt++) {
      fullRpcRes = null;
      fullRpcErr = null;
      try {
        const res = await supabaseClient.rpc('create_serial_group_full_atomic_v1', {
          p_owner_id: ownerId,
          p_user_id: userId,
          p_user_name: userName,
          p_member_ids: members.map((m) => m.id),
          p_group_serial_number: finalGroupSN,
          p_product_id: finalResultProductId || members[0].product_id,
          p_warehouse_id: targetWarehouseId,
          p_metadata: groupMetadata,
          p_target_unit: resolvedTargetUnit,
          p_target_qty: targetQty,
          p_total_base_qty_pcs: totalBaseQtyPcs,
          p_total_cost: totalCost,
          p_result_unit_cost: resultUnitCost,
          p_is_cross_product: isCrossProduct,
          p_idempotency_key: idempotencyKey || null,
          p_payload_hash: idempotencyKey ? payloadHash : null,
          p_notes: notes || null,
          p_components: buildGroupingComponentsPayload(enrichedDirectMembers),
        });
        fullRpcRes = res?.data;
        fullRpcErr = res?.error;
      } catch (fullRpcEx) {
        fullRpcErr = fullRpcEx;
      }

      if (!fullRpcErr && fullRpcRes?.success) break;

      const errorCode = String(fullRpcErr?.code || fullRpcRes?.code || '');
      const errorMessage = String(fullRpcErr?.message || fullRpcRes?.message || '');
      const isDuplicateSerial = errorCode === '23505' ||
        /duplicate key|DUPLICATE_GROUP_SERIAL|unique constraint/i.test(errorMessage);

      if (isDuplicateSerial && isAutoGeneratedSN && attempt < maxFullRpcAttempts) {
        const targetSku = finalResultProductSku || targetProduct?.sku || 'GRP';
        autoGenData = await generateGroupSerialNumber({
          ownerId,
          sku: targetSku,
          targetQty,
          targetUnit: resolvedTargetUnit,
          date: new Date(),
          sequence: (autoGenData?.sequence || 1) + attempt,
          supabaseClient,
        });
        finalGroupSN = autoGenData.serialNumber;
        continue;
      }
      break;
    }

    if (!fullRpcErr && fullRpcRes?.success) {
      const resultGroup = fullRpcRes.group || fullRpcRes.result_serial || null;
      const groupingRecord = fullRpcRes.grouping || null;
      const assemblyDoc = fullRpcRes.document || null;

      if (fullRpcRes.isReplay) {
        return {
          success: true,
          isReplay: true,
          group: resultGroup,
          groupingRecord,
          assemblyDoc,
          documentId: assemblyDoc ? assemblyDoc.id : (groupingRecord?.source_document_id || null),
          documentNumber: assemblyDoc ? assemblyDoc.document_number : null,
          totalPcs: groupingRecord?.total_base_qty_pcs ?? totalBaseQtyPcs,
          targetUnit: groupingRecord?.target_unit ?? resolvedTargetUnit,
          targetQty: groupingRecord?.target_qty ?? targetQty,
          totalCost: groupingRecord?.total_cost ?? totalCost,
          resultUnitCost: groupingRecord?.result_unit_cost ?? resultUnitCost,
          ...sourceProductPolicy,
          executionEngine: 'idempotent_replay',
        };
      }

      return {
        success: true,
        group: resultGroup,
        groupingRecord,
        assemblyDoc,
        documentId: assemblyDoc ? assemblyDoc.id : (groupingRecord?.source_document_id || null),
        documentNumber: assemblyDoc ? assemblyDoc.document_number : null,
        totalPcs: totalBaseQtyPcs,
        targetUnit: resolvedTargetUnit,
        targetQty,
        totalCost,
        resultUnitCost,
        unitBreakdown,
        directMemberCount: directMembers.length,
        leafMemberCount: leafComposition.length,
        ...sourceProductPolicy,
        isCrossProduct,
        resultProductName: finalResultProductName,
        executionEngine: 'rpc_full_atomic',
      };
    }

    const fullRpcEffectiveError = fullRpcErr || (fullRpcRes && !fullRpcRes.success ? fullRpcRes : null);
    if (fullRpcEffectiveError && !isRpcNotAvailableError(fullRpcEffectiveError)) {
      handleRpcExecutionError(fullRpcEffectiveError, 'Gagal membuat group serial number secara atomik.');
    }
  }

  // 12. ATTEMPT 2: Legacy atomic claim RPC (022) + compensating ledger writer
  if (typeof supabaseClient.rpc === 'function') {
    let rpcRes = null;
    let rpcErr = null;
    try {
      const res = await supabaseClient.rpc('create_serial_group_atomic', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_member_ids: members.map((m) => m.id),
        p_group_serial_number: finalGroupSN,
        p_product_id: finalResultProductId || members[0].product_id,
        p_warehouse_id: targetWarehouseId,
        p_metadata: groupMetadata,
      });
      rpcRes = res?.data;
      rpcErr = res?.error;
    } catch (rpcEx) {
      rpcErr = rpcEx;
    }

    if (!rpcErr && rpcRes?.success) {
      let ledger = null;
      try {
        ledger = await recordGroupingLedgerAndHeader({
          ownerId,
          userId,
          targetWarehouseId,
          createdGroup: rpcRes.group,
          finalGroupSN,
          finalResultProductId: finalResultProductId || members[0].product_id,
          finalResultProductName,
          finalResultProductSku,
          resolvedTargetUnit,
          targetQty,
          totalBaseQtyPcs,
          totalCost,
          resultUnitCost,
          enrichedDirectMembers,
          groupMetadata,
          isCrossProduct,
          idempotencyKey,
          notes,
          nowIso,
          supabaseClient,
        });
      } catch (ledgerErr) {
        await rollbackCommittedGrouping({
          ownerId,
          group: rpcRes.group,
          groupingRecord: null,
          assemblyDoc: null,
          supabaseClient,
        });
        throw ledgerErr;
      }

      const { assemblyDoc, groupingRecord } = ledger;

      return {
        success: true,
        group: rpcRes.group,
        groupingRecord,
        assemblyDoc,
        documentId: assemblyDoc ? assemblyDoc.id : null,
        documentNumber: assemblyDoc ? assemblyDoc.document_number : null,
        totalPcs: totalBaseQtyPcs,
        targetUnit: resolvedTargetUnit,
        targetQty,
        totalCost,
        resultUnitCost,
        unitBreakdown,
        directMemberCount: directMembers.length,
        leafMemberCount: leafComposition.length,
        ...sourceProductPolicy,
        isCrossProduct,
        resultProductName: finalResultProductName,
        executionEngine: 'rpc_atomic_with_compensating_ledger',
      };
    }

    const effectiveError = rpcErr || (rpcRes && !rpcRes.success ? rpcRes : null);
    if (effectiveError) {
      if (!isRpcNotAvailableError(effectiveError)) {
        handleRpcExecutionError(effectiveError, 'Gagal membuat group serial number secara atomik.');
      }
    }
  }

  // 13. ATTEMPT 3: Hardened Application-level Transaction Pipeline (compare-and-swap claim)
  const lockedIds = [];
  const lockedMetaMap = new Map();
  let createdGroupRecord = null;
  try {
    for (const m of members) {
      const updatedMeta = {
        ...(m.metadata || {}),
        isGrouped: true,
        parentGroupId: 'pending_lock',
        parentGroupSerialNumber: finalGroupSN,
        groupedAt: nowIso,
        groupedBy: userId,
        groupedByName: userName,
      };

      let lockQuery = supabaseClient
        .from('product_serials')
        .update({ metadata: updatedMeta, updated_at: nowIso })
        .eq('id', m.id)
        .eq('owner_id', ownerId)
        .eq('status', 'available');

      if (m.goods_out_document_id === null || m.goods_out_document_id === undefined) {
        lockQuery = lockQuery.is('goods_out_document_id', null);
      } else {
        lockQuery = lockQuery.eq('goods_out_document_id', m.goods_out_document_id);
      }

      if (m.metadata === null || m.metadata === undefined) {
        lockQuery = lockQuery.is('metadata', null);
      } else {
        lockQuery = lockQuery.eq('metadata', m.metadata);
      }

      const { data: updatedRows, error: lockErr } = await lockQuery.select('id');

      if (lockErr || !updatedRows || updatedRows.length === 0) {
        throw new Error(`Konflik konkurensi: Nomor seri "${m.serial_number}" sedang diproses atau sudah dikelompokkan oleh proses lain.`);
      }
      lockedIds.push(m.id);
      lockedMetaMap.set(m.id, updatedMeta);
    }

    let createdGroup = null;
    let groupInsertErr = null;
    let insertAttempts = 0;

    while (insertAttempts < 5) {
      insertAttempts++;
      const insRes = await supabaseClient
        .from('product_serials')
        .insert({
          owner_id: ownerId,
          product_id: finalResultProductId || members[0].product_id,
          serial_number: finalGroupSN,
          status: 'available',
          warehouse_id: targetWarehouseId,
          created_by: userId,
          metadata: groupMetadata,
        })
        .select()
        .single();

      createdGroup = insRes.data;
      groupInsertErr = insRes.error;

      if (!groupInsertErr && createdGroup) {
        break;
      }

      const isDup = groupInsertErr?.code === '23505' ||
        groupInsertErr?.message?.includes('duplicate key') ||
        groupInsertErr?.message?.includes('unique');

      if (isDup && isAutoGeneratedSN && insertAttempts < 5) {
        const targetSku = finalResultProductSku || targetProduct?.sku || 'GRP';
        autoGenData = await generateGroupSerialNumber({
          ownerId,
          sku: targetSku,
          targetQty,
          targetUnit: resolvedTargetUnit,
          date: new Date(),
          sequence: (autoGenData?.sequence || 1) + insertAttempts,
          supabaseClient,
        });
        finalGroupSN = autoGenData.serialNumber;
        continue;
      }
      break;
    }

    if (groupInsertErr) {
      throw new Error(`Gagal membuat record group serial: ${groupInsertErr.message}`);
    }
    createdGroupRecord = createdGroup;

    // Record ledger & grouping header
    const { assemblyDoc, groupingRecord } = await recordGroupingLedgerAndHeader({
      ownerId,
      userId,
      targetWarehouseId,
      createdGroup,
      finalGroupSN,
      finalResultProductId: finalResultProductId || members[0].product_id,
      finalResultProductName,
      finalResultProductSku,
      resolvedTargetUnit,
      targetQty,
      totalBaseQtyPcs,
      totalCost,
      resultUnitCost,
      enrichedDirectMembers,
      groupMetadata,
      isCrossProduct,
      idempotencyKey,
      notes,
      nowIso,
      supabaseClient,
    });

    for (const m of members) {
      const existingHist = Array.isArray(m.metadata?.groupHistory) ? m.metadata.groupHistory : [];
      const finalizedMeta = {
        ...(m.metadata || {}),
        isGrouped: true,
        parentGroupId: createdGroup.id,
        parentGroupSerialNumber: createdGroup.serial_number,
        groupedAt: nowIso,
        groupedBy: userId,
        groupedByName: userName,
        groupHistory: [
          ...existingHist,
          {
            action: 'joined_group',
            parentGroupId: createdGroup.id,
            parentGroupSerialNumber: createdGroup.serial_number,
            timestamp: nowIso,
            userId,
            userName,
          },
        ],
      };

      let finalizeQuery = supabaseClient
        .from('product_serials')
        .update({ metadata: finalizedMeta, updated_at: nowIso })
        .eq('id', m.id)
        .eq('owner_id', ownerId);

      const pendingMeta = lockedMetaMap.get(m.id);
      if (pendingMeta === null || pendingMeta === undefined) {
        finalizeQuery = finalizeQuery.is('metadata', null);
      } else {
        finalizeQuery = finalizeQuery.eq('metadata', pendingMeta);
      }

      const { data: finalizedRows } = await finalizeQuery.select('id');
      if (!finalizedRows || finalizedRows.length === 0) {
        throw new Error(`Konflik konkurensi saat finalisasi: metadata nomor seri "${m.serial_number}" berubah oleh proses lain.`);
      }
    }

    return {
      success: true,
      group: createdGroup,
      groupingRecord,
      assemblyDoc,
      totalPcs: totalBaseQtyPcs,
      targetUnit: resolvedTargetUnit,
      targetQty,
      totalCost,
      resultUnitCost,
      unitBreakdown,
      directMemberCount: directMembers.length,
      leafMemberCount: leafComposition.length,
      ...sourceProductPolicy,
      isCrossProduct,
      resultProductName: finalResultProductName,
      executionEngine: 'application_rollback_safe',
    };
  } catch (err) {
    if (createdGroupRecord) {
      try {
        await supabaseClient.from('product_serials').delete().eq('id', createdGroupRecord.id).eq('owner_id', ownerId);
      } catch (cleanErr) {
        console.error('Failed to clean up created group on error:', cleanErr);
      }
    }
    await rollbackMemberLocks(lockedIds, originalMetaMap, ownerId, supabaseClient);
    throw err;
  }
}

/**
 * Main Service: Ungroup / Bongkar Group Serial Number
 * All-or-nothing execution with concurrency protection & rollback safety
 */
export async function ungroupSerial({
  ownerId,
  userId,
  userName = 'System User',
  groupId = null,
  groupSerialNumber = null,
  notes = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  let query = supabaseClient
    .from('product_serials')
    .select('id, serial_number, status, warehouse_id, metadata, product_id')
    .eq('owner_id', ownerId);

  if (groupId) {
    query = query.eq('id', groupId);
  } else if (groupSerialNumber) {
    query = query.ilike('serial_number', escapeLikePattern(String(groupSerialNumber).trim()));
  } else {
    throw new Error('Tentukan ID atau nomor seri group yang ingin dibongkar.');
  }

  let { data: groupRecord, error: fetchErr } = await query.maybeSingle();

  // Fallback: Jika tidak ditemukan dengan ID product_serials, periksa apakah groupId merujuk ke tabel serial_groupings
  if (!groupRecord && groupId) {
    const { data: grpTx } = await supabaseClient
      .from('serial_groupings')
      .select('result_serial_id, result_serial_number, grouping_number')
      .eq('id', groupId)
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (grpTx) {
      const fbQuery = supabaseClient
        .from('product_serials')
        .select('id, serial_number, status, warehouse_id, metadata, product_id')
        .eq('owner_id', ownerId);

      if (grpTx.result_serial_id) {
        const { data: row } = await fbQuery.eq('id', grpTx.result_serial_id).maybeSingle();
        groupRecord = row;
      } else if (grpTx.result_serial_number || grpTx.grouping_number) {
        const sn = grpTx.result_serial_number || grpTx.grouping_number;
        const { data: row } = await fbQuery
          .ilike('serial_number', escapeLikePattern(String(sn).trim()))
          .maybeSingle();
        groupRecord = row;
      }
    }
  }

  if (!groupRecord) {
    throw new Error('Data group serial tidak ditemukan.');
  }

  if (!groupRecord.metadata?.isGroup) {
    throw new Error(`Nomor seri "${groupRecord.serial_number}" bukan merupakan group serial.`);
  }

  // Aturan: Hanya group induk paling atas yang boleh dibongkar langsung
  if (groupRecord.metadata?.parentGroupId || groupRecord.metadata?.isGrouped) {
    throw new Error(`Group "${groupRecord.serial_number}" sedang berada di dalam group induk "${groupRecord.metadata?.parentGroupSerialNumber || 'Lain'}". Bongkar group induk paling atas terlebih dahulu.`);
  }

  if (groupRecord.status === 'out' && !groupRecord.metadata?.isDissolved) {
    throw new Error(`Group "${groupRecord.serial_number}" sudah berstatus "out" (sudah dikeluarkan dari gudang) dan tidak dapat dibongkar.`);
  }

  // NOTE: A group that is already dissolved is NOT rejected here. The reversal
  // pipeline below detects the terminal grouping state and returns an idempotent
  // replay instead of a partial/duplicate reversal.

async function recordUngroupDisassemblyLedger({
  ownerId,
  userId,
  userName,
  groupRecord,
  groupingRow = null,
  components = [],
  directChildren = [],
  notes = null,
  nowIso,
  supabaseClient,
}) {
  let grpTx = groupingRow;

  if (!grpTx) {
    const { data: grpTxData } = await supabaseClient
      .from('serial_groupings')
      .select('*')
      .eq('owner_id', ownerId)
      .or(`result_serial_id.eq.${groupRecord.id},grouping_number.eq.${groupRecord.serial_number}`)
      .maybeSingle();
    grpTx = grpTxData || null;
  }

  if (grpTx && (grpTx.status === 'dissolved' || grpTx.status === 'cancelled')) {
    throw new Error(`Transaksi grouping "${groupRecord.serial_number}" sudah pernah dibongkar atau dibatalkan sebelumnya.`);
  }

  // Snapshot of the original component relations (authoritative product identity).
  const componentById = new Map();
  for (const c of components || []) {
    if (c?.component_serial_id) componentById.set(c.component_serial_id, c);
  }

  const dateCode = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date()).replace(/-/g, '');
  const disassemblyDocNumber = buildGroupingDocumentNumber(
    'GD',
    dateCode,
    groupRecord.serial_number,
    String(groupRecord.id || '').slice(0, 8)
  );

  const resultUnit = grpTx?.target_unit || groupRecord.metadata?.targetUnit || groupRecord.metadata?.unit || 'pcs';
  const resultQty = grpTx ? grpTx.target_qty : (groupRecord.metadata?.targetQty || 1);
  const resultBasePcs = grpTx ? grpTx.total_base_qty_pcs : (groupRecord.metadata?.totalPcs || resultQty);

  let disassemblyDoc = null;
  let groupingUpdated = false;

  try {
    const { data: disDocRow, error: disDocErr } = await supabaseClient
      .from('documents')
      .insert({
        owner_id: ownerId,
        warehouse_id: groupRecord.warehouse_id,
        document_type: 'goods_disassembly',
        document_number: disassemblyDocNumber,
        status: 'completed',
        issue_date: nowIso.split('T')[0],
        subtotal: grpTx ? grpTx.total_cost : 0,
        total: grpTx ? grpTx.total_cost : 0,
        created_by: userId,
        notes: notes || `Pembongkaran serial grouping ${groupRecord.serial_number}`,
        metadata: {
          originalGroupingId: grpTx ? grpTx.id : null,
          originalGroupingNumber: groupRecord.serial_number,
          originalAssemblyDocumentId: grpTx ? grpTx.source_document_id : null,
          originalResultSerialId: groupRecord.id,
          unpackedBy: userId,
          unpackedByName: userName,
        },
      })
      .select()
      .single();

    if (disDocErr || !disDocRow) {
      throw new Error(`Gagal membuat dokumen ledger goods_disassembly: ${disDocErr?.message || 'dokumen tidak terbentuk'}`);
    }
    disassemblyDoc = disDocRow;

    const disItems = [];
    disItems.push({
      document_id: disDocRow.id,
      product_id: groupRecord.product_id,
      item_name: groupRecord.metadata?.resultProductName || 'Produk Jadi (Dibongkar)',
      sku: groupRecord.metadata?.resultProductSku || '',
      quantity: resultQty,
      unit_price: grpTx ? grpTx.result_unit_cost : 0,
      amount: grpTx ? grpTx.total_cost : 0,
      sort_order: 1,
      metadata: {
        assemblyRole: 'result',
        movementType: 'out',
        serialNumber: groupRecord.serial_number,
        unit: resultUnit,
        qtyUnit: resultUnit,
        qtyInput: resultQty,
        baseQtyPcs: resultBasePcs,
      },
    });

    for (let i = 0; i < (directChildren || []).length; i++) {
      const child = directChildren[i];
      const childMeta = child.metadata || {};
      const snapshot = componentById.get(child.id) || null;
      const snapshotMeta = snapshot?.metadata || {};

      // Prefer the immutable component snapshot captured at grouping time; fall
      // back to live serial metadata only for legacy groups without components.
      const childUnit =
        snapshot?.unit ||
        childMeta.unit ||
        childMeta.serialUnit ||
        parseUnitFromSerialNumber(child.serial_number) ||
        'pcs';
      const childQty = Number(snapshot?.unit_qty) || childMeta.unitQty || 1;
      const childBasePcs =
        Number(snapshot?.base_qty_pcs) || childMeta.totalPcs || childMeta.pcs || childMeta.pcsCount || childQty;
      const childProductId = snapshot?.component_product_id || child.product_id;

      disItems.push({
        document_id: disDocRow.id,
        product_id: childProductId,
        item_name: snapshot?.snapshot_product_name || childMeta.productName || 'Komponen Dikembalikan',
        sku: snapshot?.snapshot_sku || childMeta.sku || '',
        quantity: childQty,
        unit_price: Number(snapshot?.unit_cost) || childMeta.unitCost || 0,
        amount: Number(snapshot?.total_cost) || childMeta.totalCost || 0,
        sort_order: i + 2,
        metadata: {
          assemblyRole: 'component',
          movementType: 'in',
          serialId: child.id,
          serialNumber: child.serial_number,
          productId: childProductId,
          unit: childUnit,
          qtyUnit: childUnit,
          qtyInput: childQty,
          baseQtyPcs: childBasePcs,
          preGroupStatus: snapshotMeta.preGroupStatus || childMeta.preGroupStatus || 'available',
        },
      });
    }

    const { error: disItemsErr } = await supabaseClient.from('document_items').insert(disItems);
    if (disItemsErr) {
      throw new Error(`Gagal membuat item ledger goods_disassembly: ${disItemsErr.message}`);
    }

    if (grpTx) {
      const { data: updatedGroupingRows, error: groupingErr } = await supabaseClient
        .from('serial_groupings')
        .update({
          status: 'dissolved',
          reverse_document_id: disDocRow.id,
          dissolved_at: nowIso,
          dissolved_by: userId,
          updated_at: nowIso,
        })
        .eq('id', grpTx.id)
        .eq('owner_id', ownerId)
        .select('id');

      if (groupingErr || !updatedGroupingRows || updatedGroupingRows.length === 0) {
        throw new Error(`Gagal menandai serial_groupings sebagai dissolved: ${groupingErr?.message || 'tidak ada baris terupdate'}`);
      }
      groupingUpdated = true;
    }

    return { disassemblyDoc, grpTx };
  } catch (err) {
    if (!groupingUpdated && disassemblyDoc?.id) {
      try {
        await supabaseClient.from('documents').delete().eq('id', disassemblyDoc.id).eq('owner_id', ownerId);
      } catch (cleanupErr) {
        console.error('Gagal membersihkan dokumen disassembly parsial:', cleanupErr?.message || cleanupErr);
      }
    }
    throw err;
  }
}

  const nowIso = new Date().toISOString();

  // --- Grouping header: authoritative relation + idempotency state ---------
  const { data: groupingRow } = await supabaseClient
    .from('serial_groupings')
    .select('*')
    .eq('owner_id', ownerId)
    .or(`result_serial_id.eq.${groupRecord.id},grouping_number.eq.${groupRecord.serial_number}`)
    .maybeSingle();

  const alreadyDissolved =
    (groupingRow && (groupingRow.status === 'dissolved' || groupingRow.status === 'cancelled')) ||
    groupRecord.metadata?.isDissolved === true;

  // Idempotent replay: never reverse twice, never leave partial state.
  if (alreadyDissolved) {
    let reverseDoc = null;
    if (groupingRow?.reverse_document_id) {
      const { data: doc } = await supabaseClient
        .from('documents')
        .select('*')
        .eq('id', groupingRow.reverse_document_id)
        .eq('owner_id', ownerId)
        .maybeSingle();
      reverseDoc = doc || null;
    }
    return {
      success: true,
      isReplay: true,
      unpackedGroup: groupRecord,
      groupingRecord: groupingRow || null,
      reverseDocument: reverseDoc,
      documentId: groupingRow?.reverse_document_id || null,
      documentNumber: reverseDoc?.document_number || null,
      releasedCount: 0,
      releasedSerials: [],
      executionEngine: 'idempotent_replay',
    };
  }

  // --- Resolve original component relations (authoritative) ---------------
  // The persistent `serial_grouping_components` relation is the source of truth
  // for original product identity. Group metadata is only a legacy fallback.
  let components = [];
  if (groupingRow?.id) {
    const { data: compRows, error: compErr } = await supabaseClient
      .from('serial_grouping_components')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('grouping_id', groupingRow.id)
      .order('sort_order', { ascending: true });
    if (!compErr && Array.isArray(compRows)) {
      components = compRows;
    }
  }

  const preStatusBySerial = new Map();
  for (const c of components) {
    if (c?.component_serial_id) {
      preStatusBySerial.set(c.component_serial_id, c.metadata?.preGroupStatus || null);
    }
  }

  const componentSerialIds = components.map((c) => c.component_serial_id).filter(Boolean);
  const metadataMemberIds = Array.isArray(groupRecord.metadata?.directMembers)
    ? groupRecord.metadata.directMembers.map((m) => m.serialId).filter(Boolean)
    : [];
  const lookupIds = componentSerialIds.length > 0 ? componentSerialIds : metadataMemberIds;

  let directChildren = [];
  if (lookupIds.length > 0) {
    const { data: memberRows, error: memberErr } = await supabaseClient
      .from('product_serials')
      .select('id, serial_number, product_id, metadata, status, warehouse_id')
      .eq('owner_id', ownerId)
      .in('id', lookupIds);
    if (memberErr) {
      throw new Error(`Gagal memuat serial komponen group: ${memberErr.message}`);
    }
    if (Array.isArray(memberRows)) {
      directChildren = memberRows;
    }
  }

  if (directChildren.length === 0) {
    const { data: fallbackChildren, error: fallbackErr } = await supabaseClient
      .from('product_serials')
      .select('id, serial_number, product_id, metadata, status, warehouse_id')
      .eq('owner_id', ownerId)
      .contains('metadata', { parentGroupId: groupRecord.id });
    if (fallbackErr) {
      throw new Error(`Gagal melacak serial komponen group: ${fallbackErr.message}`);
    }
    if (Array.isArray(fallbackChildren)) {
      directChildren = fallbackChildren;
    }
  }

  // ATTEMPT 1: Full PostgreSQL atomic ungroup RPC (release members + disassembly ledger in one transaction)
  if (typeof supabaseClient.rpc === 'function') {
    let fullRpcRes = null;
    let fullRpcErr = null;
    try {
      const res = await supabaseClient.rpc('ungroup_serial_full_atomic_v1', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_group_id: groupRecord.id,
        p_group_serial_number: groupRecord.serial_number,
        p_notes: notes || 'Group dibongkar kembali menjadi item anggota',
      });
      fullRpcRes = res?.data;
      fullRpcErr = res?.error;
    } catch (fullRpcEx) {
      fullRpcErr = fullRpcEx;
    }

    if (!fullRpcErr && fullRpcRes?.success) {
      const disassemblyDoc = fullRpcRes.document || null;
      return {
        success: true,
        unpackedGroup: fullRpcRes.unpackedGroup,
        reverseDocument: disassemblyDoc,
        documentId: disassemblyDoc ? disassemblyDoc.id : (fullRpcRes.documentId || null),
        documentNumber: disassemblyDoc ? disassemblyDoc.document_number : null,
        groupingRecord: fullRpcRes.grouping || null,
        releasedCount: fullRpcRes.releasedCount,
        releasedSerials: fullRpcRes.releasedSerials,
        executionEngine: 'rpc_full_atomic',
      };
    }

    const fullUngroupError = fullRpcErr || (fullRpcRes && !fullRpcRes.success ? fullRpcRes : null);
    if (fullUngroupError && !isRpcNotAvailableError(fullUngroupError)) {
      handleRpcExecutionError(fullUngroupError, 'Gagal membongkar group serial number secara atomik.');
    }
  }

  // ATTEMPT 2: PostgreSQL Atomic RPC (Row-level Locking with FOR UPDATE)
  if (typeof supabaseClient.rpc === 'function') {
    let rpcRes = null;
    let rpcErr = null;
    try {
      const res = await supabaseClient.rpc('ungroup_serial_atomic', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_group_id: groupRecord.id,
        p_group_serial_number: groupRecord.serial_number,
        p_notes: notes || 'Group dibongkar kembali menjadi item anggota',
      });
      rpcRes = res?.data;
      rpcErr = res?.error;
    } catch (rpcEx) {
      rpcErr = rpcEx;
    }

    if (!rpcErr && rpcRes?.success) {
      // The legacy RPC released members and deactivated the group in its own
      // transaction. We MUST still write the disassembly ledger + dissolve the
      // grouping header; if that fails we surface an explicit error instead of
      // silently leaving an un-ledgered reversal.
      let ledger = null;
      try {
        ledger = await recordUngroupDisassemblyLedger({
          ownerId,
          userId,
          userName,
          groupRecord,
          groupingRow,
          components,
          directChildren,
          notes,
          nowIso,
          supabaseClient,
        });
      } catch (ledgerErr) {
        const wrapped = new Error(
          `UNGROUP_LEDGER_FAILED: Serial group sudah dibongkar tetapi penulisan ledger goods_disassembly gagal (${ledgerErr.message}). Lakukan rekonsiliasi manual.`
        );
        wrapped.code = 'UNGROUP_LEDGER_FAILED';
        wrapped.cause = ledgerErr;
        throw wrapped;
      }

      const { disassemblyDoc, grpTx } = ledger;

      return {
        success: true,
        unpackedGroup: rpcRes.unpackedGroup,
        reverseDocument: disassemblyDoc,
        documentId: disassemblyDoc ? disassemblyDoc.id : null,
        documentNumber: disassemblyDoc ? disassemblyDoc.document_number : null,
        groupingRecord: grpTx,
        releasedCount: rpcRes.releasedCount,
        releasedSerials: rpcRes.releasedSerials,
        executionEngine: 'rpc_atomic_with_compensating_ledger',
      };
    }

    const effectiveError = rpcErr || (rpcRes && !rpcRes.success ? rpcRes : null);
    if (effectiveError) {
      if (!isRpcNotAvailableError(effectiveError)) {
        handleRpcExecutionError(effectiveError, 'Gagal membongkar group serial number secara atomik.');
      }
    }
  }

  // ================= ATTEMPT 3: Application fallback (ordered + compensable) =====
  // Strict ordering so the dangerous partial state can never persist:
  //   1. Restore every component serial back to its ORIGINAL product/status.
  //   2. Deactivate the result serial (terminal `dissolved`, auditable).
  //   3. Write the disassembly ledger and dissolve the grouping header LAST.
  // On any failure the earlier steps are rolled back best-effort; a partial
  // "grouping dissolved but serials still active" state is never produced.
  const restoredChildren = [];
  const rollbackRestoredChildren = async () => {
    for (let i = restoredChildren.length - 1; i >= 0; i--) {
      const r = restoredChildren[i];
      try {
        await supabaseClient
          .from('product_serials')
          .update({ metadata: r.prevMeta, status: r.prevStatus, updated_at: nowIso })
          .eq('id', r.id)
          .eq('owner_id', ownerId);
      } catch (rollbackErr) {
        console.error('Gagal rollback serial komponen:', rollbackErr?.message || rollbackErr);
      }
    }
    restoredChildren.length = 0;
  };

  try {
    // (1) Restore components to original product identity & availability.
    for (const child of directChildren || []) {
      const prevMeta = child.metadata || {};
      const prevStatus = child.status || 'available';
      const existingHist = Array.isArray(prevMeta.groupHistory) ? prevMeta.groupHistory : [];
      const restoreStatus = preStatusBySerial.get(child.id) || prevMeta.preGroupStatus || 'available';
      const updatedChildMeta = {
        ...prevMeta,
        isGrouped: false,
        parentGroupId: null,
        parentGroupSerialNumber: null,
        unpackedAt: nowIso,
        unpackedBy: userId,
        unpackedByName: userName,
        groupHistory: [
          ...existingHist,
          {
            action: 'unpacked_from_group',
            parentGroupId: groupRecord.id,
            parentGroupSerialNumber: groupRecord.serial_number,
            timestamp: nowIso,
            userId,
            userName,
            notes: notes || 'Dibongkar dari group',
          },
        ],
      };

      const { error: childErr } = await supabaseClient
        .from('product_serials')
        .update({ metadata: updatedChildMeta, status: restoreStatus, updated_at: nowIso })
        .eq('id', child.id)
        .eq('owner_id', ownerId);

      if (childErr) {
        await rollbackRestoredChildren();
        throw new Error(`Gagal memulihkan serial komponen "${child.serial_number}": ${childErr.message}`);
      }
      restoredChildren.push({ id: child.id, prevMeta, prevStatus });
    }

    // (2) Deactivate the result serial with a terminal, auditable status.
    const prevGroupStatus = groupRecord.status || 'available';
    const prevGroupMeta = groupRecord.metadata || {};
    const existingGroupHist = Array.isArray(prevGroupMeta.history) ? prevGroupMeta.history : [];
    const updatedGroupMeta = {
      ...prevGroupMeta,
      isGrouped: false,
      parentGroupId: null,
      isDissolved: true,
      dissolvedAt: nowIso,
      dissolvedBy: userId,
      dissolvedByName: userName,
      history: [
        ...existingGroupHist,
        {
          action: 'ungrouped',
          timestamp: nowIso,
          userId,
          userName,
          notes: notes || 'Group dibongkar kembali menjadi item anggota',
        },
      ],
    };

    const { data: updatedGroup, error: updateErr } = await supabaseClient
      .from('product_serials')
      .update({ status: 'dissolved', metadata: updatedGroupMeta, updated_at: nowIso })
      .eq('id', groupRecord.id)
      .eq('owner_id', ownerId)
      .select()
      .single();

    if (updateErr || !updatedGroup) {
      await rollbackRestoredChildren();
      throw new Error(`Gagal menonaktifkan serial hasil group: ${updateErr?.message || 'tidak ada baris terupdate'}`);
    }

    // (3) Ledger + dissolve grouping header (last, compensable).
    let ledger = null;
    try {
      ledger = await recordUngroupDisassemblyLedger({
        ownerId,
        userId,
        userName,
        groupRecord,
        groupingRow,
        components,
        directChildren,
        notes,
        nowIso,
        supabaseClient,
      });
    } catch (ledgerErr) {
      await supabaseClient
        .from('product_serials')
        .update({ status: prevGroupStatus, metadata: prevGroupMeta, updated_at: nowIso })
        .eq('id', groupRecord.id)
        .eq('owner_id', ownerId);
      await rollbackRestoredChildren();
      throw ledgerErr;
    }

    const { disassemblyDoc, grpTx } = ledger;

    return {
      success: true,
      unpackedGroup: updatedGroup,
      reverseDocument: disassemblyDoc,
      documentId: disassemblyDoc ? disassemblyDoc.id : null,
      documentNumber: disassemblyDoc ? disassemblyDoc.document_number : null,
      groupingRecord: grpTx,
      releasedCount: (directChildren || []).length,
      releasedSerials: (directChildren || []).map((c) => c.serial_number),
      executionEngine: 'application_rollback_safe',
    };
  } catch (err) {
    await rollbackRestoredChildren();
    throw err;
  }
}

/**
 * Main Service: Preview Serial Group
 * Validates availability, unit conversion, and estimates HPP without DB mutation
 */
export async function previewSerialGroup({
  ownerId,
  memberSerialIds = [],
  memberSerialNumbers = [],
  resultProductId = null,
  resultProductName = null,
  resultProductSku = null,
  createNewMasterProduct = false,
  targetUnit = null,
  customUnits = [],
  multipliers = {},
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  const rawList = (Array.isArray(memberSerialIds) && memberSerialIds.length > 0)
    ? memberSerialIds
    : (Array.isArray(memberSerialNumbers) && memberSerialNumbers.length > 0 ? memberSerialNumbers : []);

  if (rawList.length < 2) {
    throw new Error('Minimal harus memilih 2 nomor seri untuk melihat preview grouping.');
  }

  if (new Set(rawList.map((value) => String(value).trim().toLowerCase())).size !== rawList.length) {
    throw new Error('DUPLICATE_MEMBERS: Ditemukan nomor seri duplikat dalam request grouping.');
  }

  const { data: rawMembers, error: memberErr } = await fetchGroupingMembers({
    ownerId,
    memberSerialIds,
    memberSerialNumbers,
    supabaseClient,
  });
  if (memberErr) throw new Error(`Gagal memuat serial anggota: ${memberErr.message}`);

  const members = rawMembers || [];
  if (members.length < 2) {
    throw new Error('Minimal harus memilih 2 nomor seri yang valid untuk membuat group.');
  }

  // Cek gudang
  const warehouseIds = Array.from(new Set(members.map((m) => m.warehouse_id).filter(Boolean)));
  if (warehouseIds.length > 1) {
    throw new Error(`Semua nomor seri dalam satu group harus berasal dari gudang yang sama. Ditemukan nomor seri dari ${warehouseIds.length} gudang berbeda.`);
  }

  // Cek status & integritas produk
  for (const m of members) {
    if (!m.product) {
      throw new Error(`Nomor seri "${m.serial_number}" tidak memiliki relasi produk yang valid atau produk telah dinonaktifkan.`);
    }
    if (m.goods_out_document_id) {
      throw new Error(`Nomor seri "${m.serial_number}" sudah dikeluarkan (tercatat pada dokumen keluar) dan tidak dapat digabungkan.`);
    }
    if (m.status !== 'available') {
      throw new Error(`Nomor seri "${m.serial_number}" tidak dapat di-group karena berstatus "${m.status}".`);
    }
    if (m.metadata?.isGrouped || m.metadata?.parentGroupId) {
      throw new Error(`Nomor seri "${m.serial_number}" sudah berada di dalam group lain.`);
    }
    if (m.metadata?.isDissolved) {
      throw new Error(`Nomor seri "${m.serial_number}" adalah group yang sudah dibongkar.`);
    }
  }

  // PHASE 7E — Auto-detect & product lock (same rule as createSerialGroup).
  const sourceProductPolicy = resolveSourceProductPolicy(members);
  if (sourceProductPolicy.productSelectionLocked) {
    const lockedName = sourceProductPolicy.sourceProducts[0]?.productName || 'produk sumber';

    if (createNewMasterProduct) {
      throw buildGroupingPolicyError(
        'PRODUCT_LOCKED_SINGLE_SOURCE',
        `Semua serial berasal dari produk yang sama ("${lockedName}"). Produk hasil dikunci mengikuti produk sumber, sehingga pembuatan master produk baru tidak diizinkan.`
      );
    }

    if (resultProductId && String(resultProductId) !== String(sourceProductPolicy.lockedResultProductId)) {
      throw buildGroupingPolicyError(
        'PRODUCT_LOCKED_SINGLE_SOURCE',
        `Semua serial berasal dari produk yang sama ("${lockedName}"). Produk hasil tidak dapat diganti ke produk lain.`
      );
    }
  }

  // Evaluasi produk tujuan & satuan
  let targetProduct = null;
  if (resultProductId) {
    const { data: pData } = await supabaseClient
      .from('products')
      .select('id, name, sku, unit_cost, metadata')
      .eq('id', resultProductId)
      .eq('owner_id', ownerId)
      .maybeSingle();
    targetProduct = pData;
  } else if (members[0]?.product && members.every((m) => m.product_id === members[0].product_id)) {
    targetProduct = members[0].product;
  }

  const resolvedTargetUnit = targetUnit || targetProduct?.metadata?.unit || targetProduct?.metadata?.targetUnit || targetProduct?.unit || 'pcs';

  // Hitung komposisi
  const directMembers = [];
  for (const m of members) {
    const meta = m.metadata || {};
    const isSubGroup = Boolean(meta.isGroup);
    const unit = meta.unit || parseUnitFromSerialNumber(m.serial_number, customUnits);
    const unitQty = resolveSerialUnitCount(meta);
    const pcs = isSubGroup && meta.totalPcs ? meta.totalPcs : resolveSerialBaseQty(m.serial_number, unit, unitQty, multipliers);

    directMembers.push({
      serialId: m.id,
      serialNumber: m.serial_number,
      productId: m.product_id,
      productName: m.product?.name || 'Produk',
      sku: m.product?.sku || '',
      unit,
      unitQty,
      pcs,
      isGroup: isSubGroup,
      nestedDepth: isSubGroup ? calculateItemNestingDepth({ isGroup: true, directMembers: meta.directMembers || meta.composition }) : 1,
      productUnitCost: m.product?.unit_cost || 0,
      productUnit: m.product?.metadata?.unit || 'pcs',
      product: m.product,
      metadata: meta,
    });
  }

  const leafComposition = extractLeafComposition(directMembers);
  const unitValidation = validateGroupingUnitAndQuantity({
    leafComposition,
    targetUnit: resolvedTargetUnit,
    customUnits,
    multipliers,
  });

  const costResult = calculateGroupingCosts({
    directMembers,
    targetQty: unitValidation.targetQty,
    multipliers,
  });

  const isCrossProduct = sourceProductPolicy.distinctProductCount > 1;

  let candidateGen = null;
  try {
    const candidateSku = targetProduct?.sku ||
      (createNewMasterProduct && resultProductSku ? String(resultProductSku).trim() : null) ||
      'GRP';
    candidateGen = await generateGroupSerialNumber({
      ownerId,
      sku: candidateSku,
      targetQty: unitValidation.targetQty,
      targetUnit: resolvedTargetUnit,
      date: new Date(),
      supabaseClient,
    });
  } catch (_) {}

  return {
    valid: true,
    isValid: true,
    ...sourceProductPolicy,
    productLockReason: sourceProductPolicy.productSelectionLocked
      ? `Semua serial berasal dari produk yang sama (${sourceProductPolicy.sourceProducts[0]?.productName || 'produk sumber'}). Produk hasil dikunci mengikuti produk sumber.`
      : null,
    isCrossProduct,
    targetUnit: unitValidation.targetUnit,
    targetMultiplier: unitValidation.targetMultiplier,
    totalBaseQtyPcs: unitValidation.totalBaseQtyPcs,
    totalPcs: unitValidation.totalBaseQtyPcs,
    targetQty: unitValidation.targetQty,
    totalCost: costResult.totalCost,
    resultUnitCost: costResult.resultUnitCost,
    directMemberCount: directMembers.length,
    leafMemberCount: leafComposition.length,
    unitBreakdown: formatCompositionBreakdown(leafComposition),
    members: costResult.enrichedMembers,
    directMembers,
    targetProduct: targetProduct ? { id: targetProduct.id, name: targetProduct.name, sku: targetProduct.sku } : null,
    candidateSerialNumber: candidateGen?.serialNumber || null,
    candidateGroupSerialNumber: candidateGen?.serialNumber || null,
    candidateSequence: candidateGen?.sequence || 1,
    candidatePrefix: candidateGen?.prefix || null,
    isCandidate: true,
  };
}

/**
 * Main Service: Get Serial Grouping Details (Header + Components + Documents)
 */
export async function getSerialGroupingDetails(arg1, arg2, arg3) {
  let groupingId;
  let ownerId;
  let supabaseClient = supabaseAdmin;

  if (typeof arg1 === 'object' && arg1 !== null) {
    groupingId = arg1.groupingId || arg1.id;
    ownerId = arg1.ownerId;
    if (arg1.supabaseClient) supabaseClient = arg1.supabaseClient;
  } else {
    groupingId = arg1;
    ownerId = arg2;
    if (arg3) supabaseClient = arg3;
  }

  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!groupingId) throw new Error('groupingId wajib disertakan.');

  const { data: grouping, error: grpErr } = await supabaseClient
    .from('serial_groupings')
    .select('*, result_product:products(id, name, sku), source_document:documents!source_document_id(*), reverse_document:documents!reverse_document_id(*)')
    .eq('id', groupingId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (grpErr || !grouping) {
    throw new Error('Data transaksi grouping tidak ditemukan.');
  }

  const { data: components } = await supabaseClient
    .from('serial_grouping_components')
    .select('*')
    .eq('grouping_id', groupingId)
    .eq('owner_id', ownerId)
    .order('sort_order', { ascending: true });

  return {
    ...grouping,
    components: components || [],
    // PHASE 7E — explicit, backward-compatible reference fields.
    reference_number: grouping.source_document?.document_number || null,
    assembly_document_id: grouping.source_document?.id || grouping.source_document_id || null,
    assembly_document_number: grouping.source_document?.document_number || null,
    assembly_document_type: grouping.source_document?.document_type || null,
    reversal_document_id: grouping.reverse_document?.id || grouping.reverse_document_id || null,
    reversal_document_number: grouping.reverse_document?.document_number || null,
    reversal_document_type: grouping.reverse_document?.document_type || null,
  };
}

/**
 * Main Service: List Serial Groupings
 */
export async function listSerialGroupings({
  ownerId,
  warehouseId = null,
  status = null,
  limit = 50,
  offset = 0,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  let query = supabaseClient
    .from('serial_groupings')
    .select(`
      *,
      result_product:products(id, name, sku),
      source_document:documents!source_document_id(id, document_number, document_type, issue_date, status),
      reverse_document:documents!reverse_document_id(id, document_number, document_type, issue_date, status)
    `)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (warehouseId) query = query.eq('warehouse_id', warehouseId);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`Gagal memuat daftar grouping: ${error.message}`);

  // PHASE 7E — Expose the official goods_assembly reference explicitly.
  // Never synthesise it from dates/serials: if no assembly document is linked,
  // the reference stays null (legacy-safe).
  return (data || []).map((row) => ({
    ...row,
    reference_number: row.source_document?.document_number || null,
    assembly_document_id: row.source_document?.id || row.source_document_id || null,
    assembly_document_number: row.source_document?.document_number || null,
    assembly_document_type: row.source_document?.document_type || null,
    reversal_document_id: row.reverse_document?.id || row.reverse_document_id || null,
    reversal_document_number: row.reverse_document?.document_number || null,
    reversal_document_type: row.reverse_document?.document_type || null,
  }));
}

/**
 * Main Service: Get Serial Composition & Lineage Hierarchy
 */
export async function getSerialCompositionHierarchy({
  ownerId,
  serialNumber,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId || !serialNumber) throw new Error('ownerId dan serialNumber wajib diisi.');

  const { data: serialRecord, error } = await supabaseClient
    .from('product_serials')
    .select('id, serial_number, product_id, status, warehouse_id, metadata, product:products(id, name, sku, category)')
    .eq('owner_id', ownerId)
    .ilike('serial_number', escapeLikePattern(serialNumber.trim()))
    .maybeSingle();

  if (error || !serialRecord) {
    throw new Error(`Nomor seri "${serialNumber}" tidak ditemukan.`);
  }

  const meta = serialRecord.metadata || {};
  const isGroup = Boolean(meta.isGroup);

  return {
    serialId: serialRecord.id,
    serialNumber: serialRecord.serial_number,
    productId: serialRecord.product_id,
    productName: serialRecord.product?.name || 'Produk',
    sku: serialRecord.product?.sku || '',
    status: serialRecord.status,
    warehouseId: serialRecord.warehouse_id,
    isGroup,
    isGrouped: Boolean(meta.isGrouped),
    parentGroupId: meta.parentGroupId || null,
    parentGroupSerialNumber: meta.parentGroupSerialNumber || null,
    resultProductName: meta.resultProductName || serialRecord.product?.name || null,
    totalPcs: meta.totalPcs || resolveSerialBaseQty(serialRecord.serial_number, meta.unit),
    unitBreakdown: meta.unitBreakdown || '1 pcs',
    directMembers: meta.directMembers || [],
    leafComposition: meta.composition || [],
    history: meta.history || meta.groupHistory || [],
    isDissolved: Boolean(meta.isDissolved),
  };
}

/**
 * Main Service: List Available Serials for Grouping
 * Returns strictly valid, active, available serials enriched with product metadata
 */
export async function getAvailableSerialsForGrouping({
  ownerId,
  warehouseId = null,
  productId = null,
  search = null,
  limit = 1000,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  let query = supabaseClient
    .from('product_serials')
    .select(`
      id,
      product_id,
      serial_number,
      status,
      warehouse_id,
      goods_in_document_id,
      goods_out_document_id,
      metadata,
      created_at,
      product:products!inner(
        id,
        name,
        sku,
        category,
        unit_cost,
        selling_price,
        status,
        metadata
      )
    `)
    .eq('owner_id', ownerId)
    .eq('status', 'available')
    .is('goods_out_document_id', null);

  if (warehouseId && warehouseId !== 'all') {
    query = query.eq('warehouse_id', warehouseId);
  }

  if (productId) {
    query = query.eq('product_id', productId);
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) {
    throw new Error(`Gagal memuat nomor seri tersedia: ${error.message}`);
  }

  let list = data || [];

  // Filter out any serials that are already grouped, dissolved, or belong to inactive products
  list = list.filter((s) => {
    // 1. Must have valid active product
    if (!s.product || s.product.status === 'disabled') {
      return false;
    }

    // 2. Must not be inside an active group
    if (s.metadata?.isGrouped || s.metadata?.parentGroupId) {
      return false;
    }

    // 3. Must not be dissolved
    if (s.metadata?.isDissolved || s.status === 'dissolved') {
      return false;
    }

    // 4. If existing group, check nesting depth
    if (s.metadata?.isGroup) {
      const depth = calculateItemNestingDepth({
        isGroup: true,
        directMembers: s.metadata?.directMembers || s.metadata?.composition,
      });
      if (depth >= MAX_GROUP_NESTING_DEPTH) {
        return false;
      }
    }

    return true;
  });

  // Client search term if passed
  if (search && String(search).trim()) {
    const q = String(search).trim().toLowerCase();
    list = list.filter((s) => {
      const sn = String(s.serial_number || '').toLowerCase();
      const pName = String(s.product?.name || '').toLowerCase();
      const sku = String(s.product?.sku || '').toLowerCase();
      return sn.includes(q) || pName.includes(q) || sku.includes(q);
    });
  }

  return list.map((s) => {
    const unit = s.metadata?.unit || s.metadata?.serialUnit || s.product?.metadata?.unit || s.product?.unit || parseUnitFromSerialNumber(s.serial_number, customUnits) || 'pcs';
    const cleanUnit = String(unit).toLowerCase();
    const unitQty = resolveSerialUnitCount(s.metadata);
    const unitMultiplier = resolveUnitMultiplier(cleanUnit, unitMultipliers);
    const pcs = s.metadata?.isGroup && s.metadata?.totalPcs
      ? Number(s.metadata.totalPcs)
      : resolveSerialBaseQty(s.serial_number, cleanUnit, unitQty, unitMultipliers);

    return {
      id: s.id,
      productId: s.product_id,
      product_id: s.product_id,
      serialNumber: s.serial_number,
      serial_number: s.serial_number,
      status: s.status,
      warehouseId: s.warehouse_id,
      warehouse_id: s.warehouse_id,
      productName: s.product?.name || 'Produk',
      product_name: s.product?.name || 'Produk',
      sku: s.product?.sku || '',
      category: s.product?.category || '',
      unit: cleanUnit,
      unitQty,
      unitMultiplier,
      pcs,
      unitCost: Number(s.product?.unit_cost) || 0,
      unit_cost: Number(s.product?.unit_cost) || 0,
      isGroup: Boolean(s.metadata?.isGroup),
      metadata: s.metadata || {},
      product: s.product,
    };
  });
}

/**
 * Scan Verification Service for Serial Grouping
 * Verifies single scanned serial number with strict real-time backend validation
 */
export async function verifyScanSerialForGrouping({
  ownerId,
  warehouseId = null,
  serialNumber,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!serialNumber || typeof serialNumber !== 'string' || !serialNumber.trim()) {
    const err = new Error('Nomor seri wajib diisi.');
    err.code = 'INVALID_SERIAL';
    err.status = 400;
    throw err;
  }

  const cleanSN = serialNumber.trim();

  // Search product_serials for this owner
  const { data: foundSerial, error } = await supabaseClient
    .from('product_serials')
    .select(`
      id,
      product_id,
      serial_number,
      status,
      warehouse_id,
      goods_in_document_id,
      goods_out_document_id,
      metadata,
      created_at,
      product:products(
        id,
        name,
        sku,
        category,
        unit_cost,
        selling_price,
        status,
        metadata
      )
    `)
    .eq('owner_id', ownerId)
    .ilike('serial_number', escapeLikePattern(cleanSN))
    .maybeSingle();

  if (error) {
    const err = new Error(`Gagal memverifikasi nomor seri: ${error.message}`);
    err.status = 500;
    throw err;
  }

  if (!foundSerial) {
    const err = new Error(`SERIAL_NOT_FOUND: Nomor seri "${cleanSN}" tidak ditemukan di database.`);
    err.code = 'SERIAL_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  // 1. Valid active product check
  if (!foundSerial.product || foundSerial.product.status === 'disabled') {
    const err = new Error(`PRODUCT_DISABLED: Produk dari nomor seri "${cleanSN}" tidak valid atau telah dinonaktifkan.`);
    err.code = 'PRODUCT_DISABLED';
    err.status = 400;
    throw err;
  }

  // 2. Warehouse check
  if (warehouseId && foundSerial.warehouse_id && String(foundSerial.warehouse_id) !== String(warehouseId)) {
    const err = new Error(`WAREHOUSE_MISMATCH: Nomor seri "${cleanSN}" berada di gudang yang berbeda dari sesi aktif.`);
    err.code = 'WAREHOUSE_MISMATCH';
    err.status = 400;
    throw err;
  }

  // 3. Status check
  if (foundSerial.goods_out_document_id || foundSerial.status !== 'available') {
    const err = new Error(`SERIAL_NOT_AVAILABLE: Nomor seri "${cleanSN}" tidak tersedia (status: "${foundSerial.status}").`);
    err.code = 'SERIAL_NOT_AVAILABLE';
    err.status = 400;
    throw err;
  }

  // 4. Grouped check
  if (foundSerial.metadata?.isGrouped || foundSerial.metadata?.parentGroupId) {
    const parent = foundSerial.metadata?.parentGroupSerialNumber || 'Group lain';
    const err = new Error(`ALREADY_GROUPED: Nomor seri "${cleanSN}" sudah berada di dalam group "${parent}". Bongkar group terlebih dahulu.`);
    err.code = 'ALREADY_GROUPED';
    err.status = 400;
    throw err;
  }

  // 5. Dissolved check
  if (foundSerial.metadata?.isDissolved || foundSerial.status === 'dissolved') {
    const err = new Error(`SERIAL_DISSOLVED: Nomor seri "${cleanSN}" adalah group yang sudah dibongkar dan tidak aktif.`);
    err.code = 'SERIAL_DISSOLVED';
    err.status = 400;
    throw err;
  }

  // 6. Max depth check
  if (foundSerial.metadata?.isGroup) {
    const depth = calculateItemNestingDepth({
      isGroup: true,
      directMembers: foundSerial.metadata?.directMembers || foundSerial.metadata?.composition,
    });
    if (depth >= MAX_GROUP_NESTING_DEPTH) {
      const err = new Error(`MAX_DEPTH_EXCEEDED: Batas kedalaman hierarki group tercapai (maksimal ${MAX_GROUP_NESTING_DEPTH} level). Serial group "${cleanSN}" sudah memiliki level ${depth}.`);
      err.code = 'MAX_DEPTH_EXCEEDED';
      err.status = 400;
      throw err;
    }
  }

  const unit = foundSerial.metadata?.unit || foundSerial.metadata?.serialUnit || foundSerial.product?.metadata?.unit || foundSerial.product?.unit || parseUnitFromSerialNumber(foundSerial.serial_number, customUnits) || 'pcs';
  const cleanUnit = String(unit).toLowerCase();
  const unitQty = resolveSerialUnitCount(foundSerial.metadata);
  const unitMultiplier = resolveUnitMultiplier(cleanUnit, unitMultipliers);
  const pcs = foundSerial.metadata?.isGroup && foundSerial.metadata?.totalPcs
    ? Number(foundSerial.metadata.totalPcs)
    : resolveSerialBaseQty(foundSerial.serial_number, cleanUnit, unitQty, unitMultipliers);

  return {
    eligible: true,
    serial: {
      id: foundSerial.id,
      productId: foundSerial.product_id,
      product_id: foundSerial.product_id,
      serialNumber: foundSerial.serial_number,
      serial_number: foundSerial.serial_number,
      status: foundSerial.status,
      warehouseId: foundSerial.warehouse_id,
      warehouse_id: foundSerial.warehouse_id,
      productName: foundSerial.product?.name || 'Produk',
      product_name: foundSerial.product?.name || 'Produk',
      sku: foundSerial.product?.sku || '',
      category: foundSerial.product?.category || '',
      unit: cleanUnit,
      unitQty,
      unitMultiplier,
      pcs,
      unitCost: Number(foundSerial.product?.unit_cost) || 0,
      unit_cost: Number(foundSerial.product?.unit_cost) || 0,
      isGroup: Boolean(foundSerial.metadata?.isGroup),
      metadata: foundSerial.metadata || {},
      product: foundSerial.product,
    },
  };
}

/**
 * Main Service: Process Multiple Serial Groupings Independently
 * Each batch is executed in its own isolated transaction.
 * A failure in one batch does NOT rollback other successful batches.
 */
export async function processMultiSerialGroups({
  ownerId,
  userId,
  userName = 'System User',
  warehouseId = null,
  batches = [],
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error('Daftar batch grouping tidak boleh kosong.');
  }

  const results = [];

  for (const batch of batches) {
    const batchId = batch.batchId || batch.id || `batch-${results.length + 1}`;
    try {
      const memberIds = batch.memberSerialIds || (batch.members ? batch.members.map((m) => m.id) : []);
      const memberSNs = batch.memberSerialNumbers || (batch.members ? batch.members.map((m) => m.serial_number || m.serialNumber) : []);

      if (memberIds.length < 2 && memberSNs.length < 2) {
        throw new Error(`Batch "${batch.name || batchId}" memerlukan minimal 2 nomor seri.`);
      }

      const res = await createSerialGroup({
        ownerId,
        userId,
        userName,
        memberSerialIds: memberIds.length > 0 ? memberIds : undefined,
        memberSerialNumbers: memberIds.length === 0 ? memberSNs : undefined,
        groupSerialNumber: batch.groupSerialNumber || null,
        resultProductName: batch.resultProductName || null,
        resultProductSku: batch.resultProductSku || null,
        resultProductId: batch.resultProductId || null,
        createNewMasterProduct: Boolean(batch.createNewMasterProduct),
        targetUnit: batch.targetUnit || null,
        warehouseId: batch.warehouseId || warehouseId || null,
        idempotencyKey: batch.idempotencyKey || null,
        notes: batch.notes || null,
        customUnits,
        unitMultipliers,
        supabaseClient,
      });

      results.push({
        batchId,
        batchName: batch.name || batchId,
        success: true,
        status: res?.isReplay ? 'replayed' : 'created',
        data: res,
      });
    } catch (batchErr) {
      results.push({
        batchId,
        batchName: batch.name || batchId,
        success: false,
        status: 'failed',
        error: {
          code: batchErr.code || 'BATCH_PROCESS_FAILED',
          message: batchErr.message || 'Gagal memproses batch grouping.',
          status: batchErr.status || 400,
        },
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    results,
    summary: {
      total: batches.length,
      succeeded,
      failed,
      allSucceeded: failed === 0,
      partial: succeeded > 0 && failed > 0,
      status: failed === 0 ? 'success' : (succeeded === 0 ? 'failed' : 'partial'),
    },
  };
}

// ============================================================================
// PHASE 7K — GROUPING SESSION HEADER & PENDING CONFIRMATION SERVICES
// ============================================================================

function isUniqueViolation(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key') || message.includes('unique constraint');
}

function sessionPersistenceError(operation, error) {
  const detail = String(error?.message || error || 'Unknown database error').trim();
  return buildGroupingPolicyError(
    'GROUPING_SESSION_PERSISTENCE_FAILED',
    `Gagal ${operation} sesi grouping: ${detail}`,
    500,
  );
}

function normalizeSessionBatchSerials(batch) {
  const serials = Array.isArray(batch?.serials) ? batch.serials : [];
  const memberSerialIds = (Array.isArray(batch?.memberSerialIds) && batch.memberSerialIds.length > 0)
    ? batch.memberSerialIds.filter(Boolean)
    : serials.map((serial) => serial?.id).filter(Boolean);
  const memberSerialNumbers = (Array.isArray(batch?.memberSerialNumbers) && batch.memberSerialNumbers.length > 0)
    ? batch.memberSerialNumbers.filter(Boolean)
    : serials.map((serial) => serial?.serialNumber || serial?.serial_number).filter(Boolean);

  return { serials, memberSerialIds, memberSerialNumbers };
}

async function assertCustomGroupSerialAvailable({ ownerId, groupSerialNumber, supabaseClient }) {
  if (!groupSerialNumber) return;
  const { data, error } = await supabaseClient
    .from('product_serials')
    .select('id')
    .eq('owner_id', ownerId)
    .ilike('serial_number', escapeLikePattern(groupSerialNumber))
    .maybeSingle();

  if (error) {
    throw buildGroupingPolicyError(
      'GROUPING_SERIAL_LOOKUP_FAILED',
      `Gagal memeriksa ketersediaan nomor seri group "${groupSerialNumber}": ${error.message}`,
      500,
    );
  }
  if (data) {
    throw buildGroupingPolicyError(
      'DUPLICATE_GROUP_SERIAL',
      `Nomor seri group "${groupSerialNumber}" sudah pernah digunakan. Masukkan nomor seri group yang unik.`,
    );
  }
}

async function validatePendingSessionBatches({
  ownerId,
  batches = [],
  warehouseId = null,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  const seenMemberIds = new Set();
  const seenMemberSerials = new Set();
  const seenGroupSerials = new Set();
  const validatedBatches = [];

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const batchName = batch.name || `Batch ${index + 1}`;
    const { memberSerialIds, memberSerialNumbers, serials } = normalizeSessionBatchSerials(batch);

    if (memberSerialIds.length < 2 && memberSerialNumbers.length < 2) {
      throw new Error(`Batch "${batchName}" memerlukan minimal 2 nomor seri.`);
    }

    const preview = await previewSerialGroup({
      ownerId,
      memberSerialIds: memberSerialIds.length > 0 ? memberSerialIds : undefined,
      memberSerialNumbers: memberSerialIds.length === 0 ? memberSerialNumbers : undefined,
      resultProductId: batch.resultProductId || batch.targetProductId || null,
      resultProductName: batch.resultProductName || batch.targetProductName || batch.newProductName || null,
      resultProductSku: batch.resultProductSku || batch.targetProductSku || batch.newProductSku || null,
      createNewMasterProduct: Boolean(batch.createNewMasterProduct || batch.isNewProduct),
      targetUnit: batch.targetUnit || null,
      customUnits,
      multipliers: unitMultipliers || {},
      supabaseClient,
    });

    for (const member of preview.directMembers || []) {
      const idKey = String(member.serialId || '');
      const snKey = String(member.serialNumber || '').trim().toLowerCase();
      if ((idKey && seenMemberIds.has(idKey)) || (snKey && seenMemberSerials.has(snKey))) {
        throw buildGroupingPolicyError(
          'DUPLICATE_SESSION_MEMBER',
          `Nomor seri "${member.serialNumber || member.serialId}" digunakan lebih dari sekali dalam sesi grouping.`,
        );
      }
      if (idKey) seenMemberIds.add(idKey);
      if (snKey) seenMemberSerials.add(snKey);

      if (warehouseId && member.warehouseId && String(member.warehouseId) !== String(warehouseId)) {
        throw buildGroupingPolicyError(
          'CROSS_WAREHOUSE_FORBIDDEN',
          `Nomor seri "${member.serialNumber}" berada di gudang berbeda dari gudang sesi.`,
        );
      }
    }

    const hasExplicitResultProduct = Boolean(
      batch.resultProductId
      || batch.targetProductId
      || batch.resultProductName
      || batch.targetProductName
      || batch.newProductName,
    );
    if (preview.isCrossProduct && !preview.productSelectionLocked && !hasExplicitResultProduct && !batch.createNewMasterProduct && !batch.isNewProduct) {
      throw buildGroupingPolicyError(
        'RESULT_PRODUCT_REQUIRED',
        `Batch "${batchName}" memerlukan produk hasil grouping untuk komposisi lintas produk.`,
      );
    }

    const customGroupSerial = String(batch.groupSerialNumber || '').trim();
    let effectiveGroupSerial = customGroupSerial || preview.candidateSerialNumber || null;

    if (customGroupSerial && effectiveGroupSerial) {
      const groupKey = effectiveGroupSerial.toLowerCase();
      if (seenGroupSerials.has(groupKey)) {
        throw buildGroupingPolicyError(
          'DUPLICATE_GROUP_SERIAL',
          `Nomor seri group "${effectiveGroupSerial}" digunakan lebih dari sekali dalam sesi.`,
        );
      }
    } else if (effectiveGroupSerial && preview.candidatePrefix) {
      let sequence = Number(preview.candidateSequence) || 1;
      while (seenGroupSerials.has(effectiveGroupSerial.toLowerCase())) {
        sequence += 1;
        effectiveGroupSerial = `${preview.candidatePrefix}${String(sequence).padStart(4, '0')}`;
      }
    } else if (effectiveGroupSerial && seenGroupSerials.has(effectiveGroupSerial.toLowerCase())) {
      throw buildGroupingPolicyError(
        'DUPLICATE_GROUP_SERIAL',
        `Nomor seri group "${effectiveGroupSerial}" digunakan lebih dari sekali dalam sesi.`,
      );
    }

    if (effectiveGroupSerial) {
      seenGroupSerials.add(effectiveGroupSerial.toLowerCase());
    }
    if (customGroupSerial) {
      await assertCustomGroupSerialAvailable({ ownerId, groupSerialNumber: customGroupSerial, supabaseClient });
    }

    validatedBatches.push({
      id: batch.id || batch.batchId || `batch-${index + 1}`,
      name: batchName,
      memberSerialIds,
      memberSerialNumbers,
      serials,
      groupSerialNumber: effectiveGroupSerial,
      groupSerialNumberSource: customGroupSerial ? 'custom' : 'auto',
    });
  }

  return validatedBatches;
}

async function prepareSessionBatchPayload({
  ownerId,
  userId,
  userName,
  sessionId,
  batch,
  warehouseId = null,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  const batchId = batch.id || batch.batchId;
  const batchName = batch.name || `Batch ${batchId}`;
  const { memberSerialIds, memberSerialNumbers } = normalizeSessionBatchSerials(batch);

  const preview = await previewSerialGroup({
    ownerId,
    memberSerialIds: memberSerialIds.length > 0 ? memberSerialIds : undefined,
    memberSerialNumbers: memberSerialIds.length === 0 ? memberSerialNumbers : undefined,
    resultProductId: batch.resultProductId || batch.targetProductId || null,
    resultProductName: batch.resultProductName || batch.targetProductName || batch.newProductName || null,
    resultProductSku: batch.resultProductSku || batch.targetProductSku || batch.newProductSku || null,
    createNewMasterProduct: Boolean(batch.createNewMasterProduct || batch.isNewProduct),
    targetUnit: batch.targetUnit || null,
    customUnits,
    multipliers: unitMultipliers || {},
    supabaseClient,
  });

  const members = preview.directMembers || [];
  const targetWarehouseId = warehouseId || members[0]?.warehouseId || null;
  const warehouseIds = Array.from(new Set(members.map((m) => m.warehouseId).filter(Boolean)));
  if (warehouseIds.length > 1) {
    throw buildGroupingPolicyError(
      'CROSS_WAREHOUSE_FORBIDDEN',
      'Semua nomor seri dalam satu batch harus berasal dari gudang yang sama.',
    );
  }
  if (warehouseId && warehouseIds.length > 0 && String(warehouseIds[0]) !== String(warehouseId)) {
    throw buildGroupingPolicyError(
      'CROSS_WAREHOUSE_FORBIDDEN',
      `Nomor seri batch "${batchName}" berada di gudang berbeda dari gudang sesi.`,
    );
  }

  let finalProductId = preview.productSelectionLocked
    ? preview.lockedResultProductId
    : (batch.resultProductId || batch.targetProductId || preview.targetProduct?.id || null);
  let finalProductName = batch.resultProductName || batch.targetProductName || preview.targetProduct?.name
    || preview.sourceProducts?.[0]?.productName || members[0]?.productName || null;
  let finalProductSku = batch.resultProductSku || batch.targetProductSku || preview.targetProduct?.sku
    || members[0]?.sku || null;
  let newProduct = null;

  if (!finalProductId) {
    if (!preview.isCrossProduct) {
      finalProductId = members[0]?.productId || null;
    } else {
      if (!finalProductName) {
        throw buildGroupingPolicyError(
          'RESULT_PRODUCT_REQUIRED',
          `Batch "${batchName}" memerlukan nama atau produk hasil untuk grouping lintas produk.`,
        );
      }

      const { data: existingProduct, error: productLookupError } = await supabaseClient
        .from('products')
        .select('id, name, sku')
        .eq('owner_id', ownerId)
        .ilike('name', escapeLikePattern(finalProductName))
        .maybeSingle();

      if (productLookupError) {
        throw buildGroupingPolicyError(
          'RESULT_PRODUCT_LOOKUP_FAILED',
          `Gagal memuat produk hasil grouping: ${productLookupError.message}`,
          500,
        );
      }

      if (existingProduct) {
        finalProductId = existingProduct.id;
        finalProductSku = finalProductSku || existingProduct.sku;
      } else if (batch.createNewMasterProduct || batch.isNewProduct) {
        newProduct = {
          name: finalProductName,
          sku: finalProductSku || `GRP-${Date.now().toString(36).toUpperCase()}`,
          unit_cost: preview.resultUnitCost,
          unit: preview.targetUnit,
        };
      } else {
        throw buildGroupingPolicyError(
          'RESULT_PRODUCT_REQUIRED',
          `Produk hasil "${finalProductName}" tidak ditemukan. Pilih produk yang ada atau aktifkan pembuatan produk baru.`,
        );
      }
    }
  }

  const finalGroupSN = String(batch.groupSerialNumber || '').trim() || preview.candidateSerialNumber;
  if (!finalGroupSN) {
    throw buildGroupingPolicyError(
      'GROUP_SERIAL_REQUIRED',
      `Nomor seri hasil untuk batch "${batchName}" tidak dapat ditentukan.`,
    );
  }

  const idempotencyKey = batch.idempotencyKey || `${sessionId}:${batchId}`;
  const payloadHash = buildGroupingPayloadHash({
    memberIds: memberSerialIds,
    memberSerialNumbers,
    resultProductId: finalProductId,
    resultProductName: finalProductName,
    resultProductSku: finalProductSku,
    targetUnit: preview.targetUnit,
    warehouseId: targetWarehouseId,
    groupSerialNumber: finalGroupSN,
    createNewMasterProduct: Boolean(newProduct),
  });

  const nowIso = new Date().toISOString();
  const groupMetadata = {
    isGroup: true,
    groupType: preview.isCrossProduct ? 'mixed' : 'single_product',
    sessionId,
    batchId,
    batchName,
    resultProductName: finalProductName,
    resultProductSku: finalProductSku,
    resultProductId: finalProductId,
    unit: preview.targetUnit,
    serialUnit: preview.targetUnit,
    targetUnit: preview.targetUnit,
    targetQty: preview.targetQty,
    unitQty: preview.targetQty,
    totalPcs: preview.totalBaseQtyPcs,
    totalCost: preview.totalCost,
    resultUnitCost: preview.resultUnitCost,
    unitCost: preview.resultUnitCost,
    unitBreakdown: preview.unitBreakdown,
    directMemberCount: members.length,
    leafMemberCount: preview.leafMemberCount,
    idempotencyHash: payloadHash,
    composition: extractLeafComposition(members),
    directMembers: members.map((member) => ({
      serialId: member.serialId,
      serialNumber: member.serialNumber,
      productId: member.productId,
      productName: member.productName,
      sku: member.sku,
      unit: member.unit,
      pcs: member.pcs,
      isGroup: member.isGroup,
      unitCost: member.unitCost,
      totalCost: member.totalCost,
      preStatus: member.preStatus || 'available',
    })),
    history: [{
      action: 'grouped',
      timestamp: nowIso,
      userId,
      userName,
      notes: batch.notes || (preview.isCrossProduct ? 'Penggabungan lintas produk' : 'Penggabungan serial produk sejenis'),
    }],
  };

  return {
    batch_id: batchId,
    batch_name: batchName,
    warehouse_id: targetWarehouseId,
    member_ids: memberSerialIds,
    group_serial_number: finalGroupSN,
    product_id: finalProductId,
    new_product: newProduct,
    metadata: groupMetadata,
    target_unit: preview.targetUnit,
    target_qty: preview.targetQty,
    total_base_qty_pcs: preview.totalBaseQtyPcs,
    total_cost: preview.totalCost,
    result_unit_cost: preview.resultUnitCost,
    is_cross_product: Boolean(preview.isCrossProduct),
    idempotency_key: idempotencyKey,
    payload_hash: payloadHash,
    notes: batch.notes || null,
    components: buildGroupingComponentsPayload(members),
  };
}

/**
 * Generates a unique grouping session reference number: GRP-SES-YYYYMMDD-XXXX
 */
export async function generateGroupingSessionNumber({
  ownerId,
  date = new Date(),
  timeZone = 'Asia/Jakarta',
  sequenceOffset = 0,
  supabaseClient = supabaseAdmin,
}) {
  const d = date instanceof Date ? date : new Date(date);
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone })
    .format(d)
    .replace(/-/g, '');
  const prefix = `GRP-SES-${dateStr}-`;

  const { data, error } = await supabaseClient
    .from('serial_grouping_sessions')
    .select('session_number')
    .eq('owner_id', ownerId)
    .ilike('session_number', `${escapeLikePattern(prefix)}%`);

  if (error) {
    throw sessionPersistenceError('membuat nomor sesi', error);
  }

  let maxSeq = 0;
  for (const row of Array.isArray(data) ? data : []) {
    const numPart = String(row.session_number || '').slice(prefix.length);
    const parsed = parseInt(numPart, 10);
    if (!isNaN(parsed) && parsed > maxSeq) {
      maxSeq = parsed;
    }
  }

  const nextSeq = maxSeq + 1 + Math.max(0, Number(sequenceOffset) || 0);
  const seqStr = String(nextSeq).padStart(4, '0');
  return `${prefix}${seqStr}`;
}

/**
 * Creates a Grouping Session (Pending or Confirmed).
 * When isPending=true: validates member serial existence without mutating stock,
 * serials, or ledger. Stores session header and associated batch details.
 */
export async function createGroupingSession({
  ownerId,
  userId,
  userName = 'System User',
  warehouseId = null,
  sessionName = null,
  notes = null,
  batches = [],
  isPending = true,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error('Sesi grouping memerlukan minimal 1 batch.');
  }

  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();

  const validatedBatches = await validatePendingSessionBatches({
    ownerId,
    batches,
    warehouseId,
    customUnits,
    unitMultipliers,
    supabaseClient,
  });

  let resolvedSessionName = String(sessionName || '').trim();
  if (!resolvedSessionName) {
    const firstProductName = batches[0]?.targetProductName || batches[0]?.resultProductName || 'Produk';
    resolvedSessionName = batches.length === 1
      ? `Grouping ${firstProductName}`
      : `Grouping Multi-Batch (${batches.length} Batch)`;
  }

  const enrichedBatches = [];
  const sessionSerials = new Set();

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const validated = validatedBatches[i];
    const bId = validated.id;
    const bName = validated.name;
    const serialsList = validated.serials.length > 0
      ? validated.serials
      : validated.memberSerialIds.map((id) => ({ id }));

    for (const id of validated.memberSerialIds) {
      sessionSerials.add(String(id));
    }

    enrichedBatches.push({
      id: bId,
      batchId: bId,
      name: bName,
      targetProductId: b.targetProductId || b.resultProductId || null,
      targetProductName: b.targetProductName || b.resultProductName || 'Produk Grouping',
      targetProductSku: b.targetProductSku || b.resultProductSku || '',
      isNewProduct: Boolean(b.isNewProduct || b.createNewMasterProduct),
      newProductName: b.newProductName || '',
      newProductSku: b.newProductSku || '',
      targetUnit: b.targetUnit || 'pcs',
      targetQty: Number(b.targetQty || b.previewData?.targetQty || 1),
      groupSerialNumber: validated.groupSerialNumber,
      groupSerialNumberSource: validated.groupSerialNumberSource,
      notes: b.notes || '',
      memberSerialIds: validated.memberSerialIds,
      memberSerialNumbers: validated.memberSerialNumbers,
      serials: serialsList,
      status: 'pending',
      idempotencyKey: b.idempotencyKey || bId,
    });
  }

  let insertedSession = null;
  let lastInsertError = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const sessionNumber = await generateGroupingSessionNumber({
      ownerId,
      date: new Date(),
      sequenceOffset: attempt,
      supabaseClient,
    });

    const sessionRecord = {
      id: sessionId,
      owner_id: ownerId,
      warehouse_id: warehouseId || null,
      session_number: sessionNumber,
      session_name: resolvedSessionName,
      status: 'pending',
      total_batches: batches.length,
      total_serials: sessionSerials.size,
      notes: notes || null,
      metadata: {
        batches: enrichedBatches,
        customUnits,
        unitMultipliers,
        validation: {
          databaseValidated: true,
          validatedAt: nowIso,
          mode: 'pending_database_snapshot',
        },
      },
      created_by: userId || null,
      created_at: nowIso,
      updated_at: nowIso,
      confirmed_at: null,
      confirmed_by: null,
    };

    const { data: inserted, error: insertError } = await supabaseClient
      .from('serial_grouping_sessions')
      .insert(sessionRecord)
      .select()
      .single();

    if (!insertError && inserted) {
      insertedSession = inserted;
      lastInsertError = null;
      break;
    }

    lastInsertError = insertError || new Error('Insert sesi grouping tidak mengembalikan data.');
    if (!isUniqueViolation(lastInsertError) || attempt === 4) {
      break;
    }
  }

  if (!insertedSession) {
    throw sessionPersistenceError('menyimpan', lastInsertError);
  }

  const persistedSession = {
    ...insertedSession,
    batches: insertedSession.metadata?.batches || enrichedBatches,
  };

  if (!isPending) {
    const confirmRes = await confirmGroupingSession({
      ownerId,
      userId,
      userName,
      sessionId,
      customUnits,
      unitMultipliers,
      supabaseClient,
    });
    return {
      success: true,
      isPending: false,
      data: confirmRes.session,
      results: confirmRes.results,
      summary: confirmRes.summary,
    };
  }

  return {
    success: true,
    isPending: true,
    data: persistedSession,
  };
}

/**
 * Confirms a Pending Grouping Session.
 * Re-validates every component serial across all batches (availability, warehouse, rules),
 * then atomically processes and posts all batches. Updates session status to 'completed'.
 */
export async function confirmGroupingSession({
  ownerId,
  userId,
  userName = 'System User',
  sessionId,
  customUnits = [],
  unitMultipliers = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!sessionId) throw new Error('sessionId wajib disertakan.');

  const { data: session, error: sessionError } = await supabaseClient
    .from('serial_grouping_sessions')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionError) {
    throw sessionPersistenceError('memuat', sessionError);
  }
  if (!session) {
    throw buildGroupingPolicyError(
      'GROUPING_SESSION_NOT_FOUND',
      `Sesi grouping dengan ID "${sessionId}" tidak ditemukan.`,
      404,
    );
  }

  if (session.status === 'completed') {
    const existingResult = session.metadata?.processResult || {};
    return {
      success: true,
      alreadyConfirmed: true,
      session,
      results: existingResult.results || [],
      summary: existingResult.summary || {
        total: session.total_batches || 0,
        succeeded: session.total_batches || 0,
        failed: 0,
        allSucceeded: true,
        partial: false,
        status: 'success',
      },
    };
  }

  if (session.status !== 'pending') {
    throw buildGroupingPolicyError(
      'GROUPING_SESSION_NOT_PENDING',
      `Sesi grouping tidak dapat dikonfirmasi karena status saat ini adalah "${session.status}".`,
      409,
    );
  }

  const batches = session.metadata?.batches || [];
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error('Sesi grouping tidak memiliki data batch yang valid.');
  }

  const seenMemberIds = new Set();
  const seenGroupSerials = new Set();
  const preparedBatches = [];

  for (const batch of batches) {
    const { memberSerialIds } = normalizeSessionBatchSerials(batch);
    for (const memberId of memberSerialIds) {
      const key = String(memberId);
      if (seenMemberIds.has(key)) {
        throw buildGroupingPolicyError(
          'DUPLICATE_SESSION_MEMBER',
          'Sesi grouping mengandung nomor seri yang sama pada lebih dari satu batch.',
        );
      }
      seenMemberIds.add(key);
    }

    const prepared = await prepareSessionBatchPayload({
      ownerId,
      userId,
      userName,
      sessionId,
      batch,
      warehouseId: session.warehouse_id || null,
      customUnits: customUnits.length > 0 ? customUnits : (session.metadata?.customUnits || []),
      unitMultipliers: unitMultipliers || session.metadata?.unitMultipliers,
      supabaseClient,
    });

    const groupSerialKey = String(prepared.group_serial_number || '').trim().toLowerCase();
    if (groupSerialKey && seenGroupSerials.has(groupSerialKey)) {
      throw buildGroupingPolicyError(
        'DUPLICATE_GROUP_SERIAL',
        `Nomor seri group "${prepared.group_serial_number}" digunakan lebih dari sekali dalam sesi.`,
      );
    }
    if (groupSerialKey) seenGroupSerials.add(groupSerialKey);
    preparedBatches.push(prepared);
  }

  if (typeof supabaseClient.rpc !== 'function') {
    throw buildGroupingPolicyError(
      'ATOMIC_SESSION_CONFIRM_UNAVAILABLE',
      'Konfirmasi sesi grouping memerlukan RPC atomik yang belum tersedia di server.',
      503,
    );
  }

  const { data: rpcData, error: rpcError } = await supabaseClient.rpc(
    'confirm_serial_grouping_session_atomic_v1',
    {
      p_owner_id: ownerId,
      p_session_id: sessionId,
      p_user_id: userId,
      p_user_name: userName,
      p_batches: preparedBatches,
    },
  );

  if (rpcError) {
    if (isRpcNotAvailableError(rpcError)) {
      throw buildGroupingPolicyError(
        'ATOMIC_SESSION_CONFIRM_UNAVAILABLE',
        'Konfirmasi sesi grouping memerlukan migration RPC atomik yang belum diterapkan.',
        503,
      );
    }
    handleRpcExecutionError(rpcError, 'Gagal mengonfirmasi sesi grouping secara atomik.');
  }

  if (!rpcData?.success) {
    const rpcMessage = rpcData?.message || rpcData?.error || 'RPC konfirmasi sesi tidak mengembalikan status sukses.';
    throw new Error(`Konfirmasi grouping gagal: ${rpcMessage}`);
  }

  const confirmedSession = rpcData.session || {
    ...session,
    status: 'completed',
  };
  const processResult = confirmedSession.metadata?.processResult || {
    results: rpcData.results || [],
    summary: rpcData.summary || {},
  };

  return {
    success: true,
    alreadyConfirmed: Boolean(rpcData.alreadyConfirmed),
    session: confirmedSession,
    results: rpcData.results || processResult.results || [],
    summary: rpcData.summary || processResult.summary || {},
  };
}

/**
 * Cancels a Pending Grouping Session.
 */
export async function cancelGroupingSession({
  ownerId,
  userId,
  sessionId,
  notes = null,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');
  if (!sessionId) throw new Error('sessionId wajib disertakan.');

  const nowIso = new Date().toISOString();
  const { data: updatedSession, error: updateError } = await supabaseClient
    .from('serial_grouping_sessions')
    .update({
      status: 'cancelled',
      cancelled_at: nowIso,
      cancelled_by: userId || null,
      updated_at: nowIso,
      ...(notes ? { notes } : {}),
    })
    .eq('owner_id', ownerId)
    .eq('id', sessionId)
    .eq('status', 'pending')
    .select()
    .single();

  if (updateError) {
    if (String(updateError.code || '') === 'PGRST116') {
      throw buildGroupingPolicyError(
        'GROUPING_SESSION_NOT_PENDING',
        'Sesi grouping tidak dapat dibatalkan karena sudah diproses atau statusnya berubah.',
        409,
      );
    }
    throw sessionPersistenceError('membatalkan', updateError);
  }

  return { success: true, data: updatedSession };
}

/**
 * Main Service: List Grouping Sessions
 * Returns one primary row per grouping session, with expandable nested batches and component SNs.
 * Includes historical completed groupings mapped gracefully as sessions.
 */
export async function listGroupingSessions({
  ownerId,
  warehouseId = null,
  status = null,
  limit = 50,
  offset = 0,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId) throw new Error('ownerId wajib disertakan.');

  const sessionMap = new Map();
  const sessionAttachments = new Map();
  const normalizedStatus = status && status !== 'all' ? String(status).toLowerCase() : null;
  const legacyStatusMatches = (groupingStatus) => {
    if (!normalizedStatus) return true;
    const current = String(groupingStatus || '').toLowerCase();
    if (normalizedStatus === 'completed') return current === 'active' || current === 'completed';
    return current === normalizedStatus;
  };

  let q = supabaseClient
    .from('serial_grouping_sessions')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (warehouseId) q = q.eq('warehouse_id', warehouseId);

  const { data: dbSessions, error: sessionError } = await q;
  if (sessionError) {
    throw sessionPersistenceError('memuat daftar', sessionError);
  }

  for (const s of Array.isArray(dbSessions) ? dbSessions : []) {
    const currentStatus = String(s.status || '').toLowerCase();
    if (normalizedStatus === 'pending' && currentStatus !== 'pending') continue;
    if (normalizedStatus === 'completed' && currentStatus !== 'completed' && currentStatus !== 'partial' && currentStatus !== 'active') continue;
    if ((normalizedStatus === 'dissolved' || normalizedStatus === 'cancelled') && currentStatus !== 'dissolved' && currentStatus !== 'cancelled') continue;

    const metadataBatches = Array.isArray(s.metadata?.batches) ? s.metadata.batches : [];
    sessionMap.set(s.id, {
      id: s.id,
      sessionNumber: s.session_number,
      reference: s.session_number,
      name: s.session_name || `Sesi Grouping (${s.session_number})`,
      status: s.status,
      warehouseId: s.warehouse_id,
      notes: s.notes,
      createdAt: s.created_at,
      confirmedAt: s.confirmed_at,
      totalBatches: s.total_batches || metadataBatches.length || 1,
      totalSerials: s.total_serials || 0,
      batches: metadataBatches,
      metadataBatches,
      isPendingSession: s.status === 'pending',
    });
    sessionAttachments.set(s.id, []);
  }

  const historicalGroupings = normalizedStatus === 'pending'
    ? []
    : await listSerialGroupings({
      ownerId,
      warehouseId,
      status: null,
      limit: 500,
      offset: 0,
      supabaseClient,
    });

  for (const grp of historicalGroupings) {
    const sessionId = grp.session_id || grp.metadata?.sessionId;
    const directMembers = Array.isArray(grp.metadata?.directMembers) ? grp.metadata.directMembers : [];

    const batchObj = {
      id: grp.id,
      batchId: grp.metadata?.batchId || grp.id,
      name: grp.metadata?.batchName || grp.metadata?.batchId || 'Batch 1',
      groupingNumber: grp.grouping_number,
      resultProductId: grp.result_product_id,
      resultProductName: grp.result_product?.name || grp.metadata?.resultProductName || 'Produk Grouping',
      resultProductSku: grp.result_product?.sku || grp.metadata?.resultProductSku || '',
      resultSerialNumber: grp.result_serial_number,
      targetUnit: grp.target_unit,
      targetQty: Number(grp.target_qty || 1),
      totalBaseQtyPcs: Number(grp.total_base_qty_pcs || 1),
      status: grp.status || 'completed',
      assemblyDocumentNumber: grp.assembly_document_number,
      reversalDocumentNumber: grp.reversal_document_number,
      createdAt: grp.created_at,
      memberSerialIds: directMembers.map((member) => member.serialId).filter(Boolean),
      serials: directMembers.map((member) => ({
        id: member.serialId,
        serialNumber: member.serialNumber,
        productName: member.productName,
        sku: member.sku,
        unit: member.unit,
        pcs: member.pcs,
      })),
      components: undefined,
    };

    if (sessionId && sessionMap.has(sessionId)) {
      const attached = sessionAttachments.get(sessionId);
      if (!attached.some((batch) => batch.id === batchObj.id)) {
        attached.push(batchObj);
      }
    } else if (sessionId && !sessionMap.has(sessionId) && !normalizedStatus) {
      const sessionRef = grp.metadata?.sessionNumber || `GRP-SES-${String(sessionId).slice(0, 8)}`;
      sessionMap.set(sessionId, {
        id: sessionId,
        sessionNumber: sessionRef,
        reference: sessionRef,
        name: `Sesi Grouping (${sessionRef})`,
        status: grp.status || 'completed',
        warehouseId: grp.warehouse_id,
        createdAt: grp.created_at,
        confirmedAt: grp.created_at,
        totalBatches: 1,
        totalSerials: batchObj.memberSerialIds.length || Number(grp.total_base_qty_pcs || 1),
        batches: [],
        metadataBatches: [],
        isLegacy: false,
      });
      sessionAttachments.set(sessionId, [batchObj]);
    } else if (!sessionId && legacyStatusMatches(grp.status)) {
      const legacySessionId = `legacy-${grp.id}`;
      if (!sessionMap.has(legacySessionId)) {
        const sessionRef = grp.assembly_document_number || grp.grouping_number || `GRP-${String(grp.id).slice(0, 8)}`;
        const pName = grp.result_product?.name || 'Produk Grouping';

        sessionMap.set(legacySessionId, {
          id: grp.id,
          sessionNumber: sessionRef,
          reference: sessionRef,
          name: `Grouping ${pName}`,
          status: grp.status || 'completed',
          warehouseId: grp.warehouse_id,
          createdAt: grp.created_at,
          confirmedAt: grp.created_at,
          totalBatches: 1,
          totalSerials: batchObj.memberSerialIds.length || Number(grp.total_base_qty_pcs || 1),
          batches: [batchObj],
          metadataBatches: [],
          isLegacy: true,
        });
      }
    }
  }

  for (const [sessionId, attachedBatches] of sessionAttachments.entries()) {
    const session = sessionMap.get(sessionId);
    if (!session || attachedBatches.length === 0) continue;
    session.batches = attachedBatches;
    session.totalBatches = attachedBatches.length;
    session.totalSerials = attachedBatches.reduce(
      (sum, batch) => sum + (batch.memberSerialIds?.length || batch.serials?.length || 0),
      0,
    ) || session.totalSerials;
  }

  for (const session of sessionMap.values()) {
    delete session.metadataBatches;
  }

  const allSessions = Array.from(sessionMap.values()).sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  return allSessions.slice(safeOffset, safeOffset + safeLimit);
}

/**
 * Returns single session details with batches and component serials.
 */
export async function getGroupingSessionDetails({
  ownerId,
  sessionId,
  supabaseClient = supabaseAdmin,
}) {
  if (!ownerId || !sessionId) throw new Error('ownerId dan sessionId wajib disertakan.');

  const sessions = await listGroupingSessions({
    ownerId,
    limit: 500,
    supabaseClient,
  });

  const session = sessions.find((s) => s.id === sessionId || s.sessionNumber === sessionId);
  if (!session) {
    throw buildGroupingPolicyError(
      'GROUPING_SESSION_NOT_FOUND',
      `Sesi grouping dengan ID "${sessionId}" tidak ditemukan.`,
      404,
    );
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  for (const batch of session.batches) {
    if (uuidPattern.test(String(batch.id || '')) && !batch.components) {
      const details = await getSerialGroupingDetails({
        ownerId,
        groupingId: batch.id,
        supabaseClient,
      });
      batch.components = details?.components || [];
    }
  }

  return session;
}



import { DEFAULT_UNITS, formatDocumentQty } from '../hooks/useUnits.js';

export const LUSIN_IN_PCS = 12;

export function normalizeUnitKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().trim();
}

export function getUnitDefs(customUnits) {
  return Array.isArray(customUnits) && customUnits.length > 0 ? customUnits : DEFAULT_UNITS;
}

export function findUnitDef(unitKey, customUnits) {
  const key = normalizeUnitKey(unitKey);
  if (!key) return null;
  return getUnitDefs(customUnits).find((u) => normalizeUnitKey(u?.key) === key) || null;
}

export function resolveMultiplier(unitKey, multipliers = {}, customUnits = []) {
  const key = normalizeUnitKey(unitKey);
  if (!key) return 1;

  // Protect standard primary keys per AGENTS.md rules
  if (key === 'bal' || key === 'bal25') return 300;
  if (key === 'pack') return 60;
  if (key === 'pack3') return 3;
  if (key === 'pack6') return 6;
  if (key === 'pcs' || key === 'piece') return 1;
  if (key === 'lusin' || key === 'dozen') return 12;

  const fromMap = Number(multipliers?.[key]);
  if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;

  const def = findUnitDef(key, customUnits);
  if (def) {
    const fallback = normalizeUnitKey(def.baseType) === 'lusin'
      ? Number(def.baseValue) * LUSIN_IN_PCS
      : Number(def.baseValue);
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    if (Number.isFinite(Number(def.multiplier)) && Number(def.multiplier) > 0) return Number(def.multiplier);
  }

  return 1;
}

export function isLusinBasedUnit(unitKey, customUnits = []) {
  const key = normalizeUnitKey(unitKey);
  if (!key) return false;

  const def = findUnitDef(key, customUnits);
  if (def) {
    if (key === 'lusin' || key === 'dozen') return true;
    return normalizeUnitKey(def.baseType) === 'lusin';
  }

  if (key === 'pcs' || key === 'piece' || key === 'pack3' || key === 'pk3' || key === 'pack6' || key === 'pk6') return false;
  if (key.includes('lusin') || key.includes('doz') || key.includes('bal')) return true;
  return false;
}

export function formatUnitNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 1000) / 1000).toLocaleString('id-ID');
}

// Satu unit dari `unitKey` ditulis dalam satuan paling wajar untuk pembaca:
// pack/bal -> lusin, pcs/pack3 -> pcs, lusin tetap lusin.
export function describeUnitQty(unitKey, { multipliers = {}, customUnits = [] } = {}) {
  const key = normalizeUnitKey(unitKey) || 'pcs';
  const multiplier = resolveMultiplier(key, multipliers, customUnits);

  if (isLusinBasedUnit(key, customUnits)) {
    const qty = multiplier / LUSIN_IN_PCS;
    return { unit: 'lusin', qty, text: `${formatUnitNumber(qty)} lusin` };
  }
  return { unit: 'pcs', qty: multiplier, text: `${formatUnitNumber(multiplier)} pcs` };
}

// Jumlah pcs ditulis mengikuti keluarga satuan acuan.
export function describePcs(pcs, unitKey, { customUnits = [] } = {}) {
  const total = Number(pcs) || 0;
  if (isLusinBasedUnit(unitKey, customUnits)) {
    return { unit: 'lusin', qty: total / LUSIN_IN_PCS, text: formatDocumentQty(total / LUSIN_IN_PCS, 0) };
  }
  return { unit: 'pcs', qty: total, text: formatDocumentQty(0, total) };
}

export function formatPcsAsLusinAndPcs(pcs) {
  const total = Math.max(0, Number(pcs) || 0);
  const lusin = Math.floor(total / LUSIN_IN_PCS);
  return formatDocumentQty(lusin, total % LUSIN_IN_PCS);
}

export function getProductUnitKey(product) {
  const meta = product?.metadata ?? {};
  const candidates = [
    product?.unit,
    product?.unitKey,
    product?.baseUnit,
    meta.unit,
    meta.qtyUnit,
    meta.stockUnit,
    meta.serialUnit,
  ];
  for (const candidate of candidates) {
    const key = normalizeUnitKey(candidate);
    if (key) return key;
  }
  return 'pcs';
}

// Sumber kebenaran unit serial: metadata di DB, lalu penanda di nomor seri.
export function detectSerialUnitKey(serial, { multipliers = {}, customUnits = [] } = {}) {
  const meta = serial?.metadata ?? {};
  const stored = normalizeUnitKey(
    serial?.serialUnit ?? meta.serialUnit ?? meta.unit ?? meta.qtyUnit ?? serial?.unit ?? serial?.qtyUnit
  );
  if (stored && stored !== 'pcs' && stored !== 'piece') return stored;

  const sn = String(serial?.serialNumber ?? serial?.serial_number ?? '').toLowerCase();

  const defs = [...getUnitDefs(customUnits)].sort(
    (a, b) => String(b?.key ?? '').length - String(a?.key ?? '').length
  );
  for (const def of defs) {
    const key = normalizeUnitKey(def?.key);
    if (!key || key === 'pcs' || key === 'piece' || key.length < 3) continue;
    if (sn.includes(key)) return key;
  }

  if (sn.includes('10bl') || sn.includes('bal10')) return 'bal10';
  if (sn.includes('15bl') || sn.includes('bal15')) return 'bal15';
  if (sn.includes('20bl') || sn.includes('bal20')) return 'bal20';
  if (sn.includes('25bl') || sn.includes('bal25')) return 'bal25';
  if (sn.includes('bal5') || sn.includes('5bl')) return 'bal5';
  if (sn.includes('pack6') || sn.includes('pk6') || sn.includes('6pk')) return 'pack6';
  if (sn.includes('pack3') || sn.includes('pk3') || sn.includes('3pk')) return 'pack3';
  if (sn.includes('pack5') || sn.includes('pk5') || sn.includes('5pk')) return 'pack';
  if (sn.includes('bal') || sn.includes('bl')) return 'bal';
  if (sn.includes('pack') || sn.includes('pk')) return 'pack';
  if (sn.includes('lusin') || sn.includes('doz')) return 'lusin';

  return stored || 'pcs';
}

function isSerialStockRelevant(serial) {
  if (String(serial?.status || '').toLowerCase() !== 'available') return false;
  if (!serial?.productId && !serial?.product_id) return false;
  return Boolean(serial?.goodsInDocumentId ?? serial?.goods_in_document_id);
}

// Map: productId -> { totalPcs, lines: [{ id, serialNumber, status, unitKey, displayUnit, qtyPcs, qtyText }] }
export function buildSerialStockIndex({ serials = [], documents = [], multipliers = {}, customUnits = [] } = {}) {
  const index = new Map();
  const docMap = new Map((documents ?? []).map((doc) => [doc.id, doc]));

  (serials ?? []).forEach((serial) => {
    if (!isSerialStockRelevant(serial)) return;

    const productId = serial.productId ?? serial.product_id;
    const goodsInDocId = serial.goodsInDocumentId ?? serial.goods_in_document_id;
    const linkedDoc = docMap.get(goodsInDocId);
    const docType = linkedDoc?.document_type || linkedDoc?.type;

    if (!linkedDoc || docType !== 'goods_in' || linkedDoc.status === 'cancelled') return;

    const meta = serial?.metadata ?? {};
    const isGroup = meta.isGroup === true;
    let unitKey;
    let multiplier;
    let described;

    if (isGroup) {
      unitKey = normalizeUnitKey(meta.targetUnit || meta.serialUnit || meta.unit) || 'pcs';
      const targetQty = Number(meta.targetQty ?? meta.unitQty);
      const unitMultiplier = resolveMultiplier(unitKey, multipliers, customUnits);
      const totalPcs = Number(meta.totalPcs ?? meta.totalBaseQtyPcs);
      multiplier = Number.isFinite(totalPcs) && totalPcs > 0
        ? totalPcs
        : (Number.isFinite(targetQty) && targetQty > 0 ? targetQty * unitMultiplier : unitMultiplier);
      const displayQty = Number.isFinite(targetQty) && targetQty > 0 ? targetQty : multiplier;
      described = { unit: unitKey, qty: displayQty, text: `${formatUnitNumber(displayQty)} ${unitKey}` };
    } else {
      unitKey = detectSerialUnitKey(serial, { multipliers, customUnits });
      multiplier = resolveMultiplier(unitKey, multipliers, customUnits);
      described = describeUnitQty(unitKey, { multipliers, customUnits });
    }

    const bucket = index.get(productId) ?? { totalPcs: 0, lines: [] };
    bucket.totalPcs += multiplier;
    bucket.lines.push({
      id: serial.id ?? serial.serialNumber ?? serial.serial_number,
      serialNumber: serial.serialNumber ?? serial.serial_number ?? '—',
      status: serial.status ?? 'available',
      unitKey,
      displayUnit: described.unit,
      qtyPcs: multiplier,
      qtyText: described.text,
    });
    index.set(productId, bucket);
  });

  return index;
}

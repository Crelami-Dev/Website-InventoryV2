export const DOCUMENT_UNIT_MULTIPLIERS = {
  pcs: 1,
  piece: 1,
  pack3: 3,
  pack6: 6,
  lusin: 12,
  dozen: 12,
  pack: 60,
  bal5: 60,
  bal10: 120,
  bal15: 180,
  bal20: 240,
  bal25: 300,
  bal: 300,
};

export function parseDocumentSerialUnit(serialNumber, fallbackUnit = 'pcs') {
  if (!serialNumber) return fallbackUnit;
  const s = String(serialNumber).toLowerCase();
  if (s.includes('bl25') || s.includes('25bl') || s.includes('bal25') || s.includes('25bal')) return 'bal25';
  if (s.includes('bl20') || s.includes('20bl') || s.includes('bal20') || s.includes('20bal')) return 'bal20';
  if (s.includes('bl15') || s.includes('15bl') || s.includes('bal15') || s.includes('15bal')) return 'bal15';
  if (s.includes('bl10') || s.includes('10bl') || s.includes('bal10') || s.includes('10bal')) return 'bal10';
  if (s.includes('bl5') || s.includes('5bl') || s.includes('bal5') || s.includes('5bal')) return 'bal5';
  if (s.includes('pack6') || s.includes('pk6') || s.includes('6pk')) return 'pack6';
  if (s.includes('pack3') || s.includes('pk3') || s.includes('3pk')) return 'pack3';
  if (s.includes('bal') || s.includes('bl')) return 'bal';
  if (s.includes('pack') || s.includes('pk')) return 'pack';
  if (s.includes('lusin') || s.includes('doz')) return 'lusin';
  return fallbackUnit;
}

function isLusinLike(unit) {
  const u = String(unit || '').toLowerCase();
  return u.includes('lusin') || u.includes('doz') || u.includes('bal') || u === 'pack' || u === 'pk';
}

/**
 * Single authoritative quantity resolver for document items.
 *
 * - Grouped result serial: targetQty/targetUnit, totalPcs is the base pcs.
 * - Regular serial: 1 packaging unit (legacy behavior is preserved).
 * - Non-serial: qtyInput/quantity in the stored unit.
 */
export function resolveDocumentItemQuantity(item, { multipliers = DOCUMENT_UNIT_MULTIPLIERS, parseSn = null } = {}) {
  const metadata = item?.metadata ?? {};
  const isSerial = metadata.isSerial === true || !!metadata.serialNumber || item?.isSerial === true || !!item?.serialNumber;
  const isGroup = metadata.isGroup === true || item?.isGroup === true;
  const serialNumber = metadata.serialNumber || item?.serialNumber || '';

  const rawGroupQty = Number(
    metadata.targetQty
    ?? metadata.unitQty
    ?? item?.targetQty
    ?? item?.unitQty
  );
  const groupQty = Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : null;

  const groupUnit = metadata.targetUnit ?? item?.targetUnit ?? null;
  let unit = String(
    (isGroup ? groupUnit : null)
    || metadata.qtyUnit
    || item?.qtyUnit
    || metadata.unit
    || item?.unit
    || 'pcs'
  ).toLowerCase().trim() || 'pcs';

  if (isSerial && !isGroup && serialNumber && (!unit || unit === 'pcs' || unit === 'piece')) {
    unit = parseSn
      ? parseSn(serialNumber, unit)
      : parseDocumentSerialUnit(serialNumber, unit);
  }

  const serialGroupQty = Number(metadata.qtyInput ?? item?.qtyInput ?? item?.quantity ?? 1);
  const qty = isGroup
    ? (groupQty ?? (Number.isFinite(serialGroupQty) && serialGroupQty > 0 ? serialGroupQty : 1))
    : isSerial
      ? 1
      : Number(metadata.qtyInput ?? item?.qtyInput ?? item?.quantity ?? item?.qty ?? 1);

  const normalizedQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const multiplier = Number(multipliers[unit]) || (isLusinLike(unit) ? 12 : 1);
  const rawTotalPcs = Number(metadata.totalPcs ?? metadata.totalBaseQtyPcs ?? metadata.baseQuantity);
  const pcs = isGroup && Number.isFinite(rawTotalPcs) && rawTotalPcs > 0
    ? rawTotalPcs
    : normalizedQty * multiplier;

  return {
    isSerial,
    isGroup,
    serialNumber,
    unit,
    qty: normalizedQty,
    pcs,
    totalPcs: pcs,
  };
}

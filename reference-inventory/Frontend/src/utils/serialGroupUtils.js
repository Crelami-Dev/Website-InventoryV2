/**
 * Serial Group Utilities for Frontend
 * Conforms to AGENTS.md canonical multipliers & unit parsing
 */

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
  bal: 300,   // Fallback & Legacy compatibility per AGENTS.md Rule 1
};

export function parseUnitFromSerialNumber(serialNumber, customUnits = []) {
  if (!serialNumber || typeof serialNumber !== 'string') return 'pcs';
  const clean = serialNumber.toLowerCase().trim();

  if (Array.isArray(customUnits) && customUnits.length > 0) {
    const sortedUnits = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
    for (const u of sortedUnits) {
      const k = String(u.key).toLowerCase().trim();
      if (!k || k === 'pcs') continue;
      if (clean.includes(k)) return k;
    }
  }

  // Ordered detection per AGENTS.md Rule 3
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

export function resolveSerialBaseQty(serialNumber, explicitUnit = null, explicitQty = null) {
  const unit = (explicitUnit || parseUnitFromSerialNumber(serialNumber)).toLowerCase().trim();
  const mult = CANONICAL_MULTIPLIERS[unit] || 1;
  const count = typeof explicitQty === 'number' && !isNaN(explicitQty) && explicitQty > 0 ? explicitQty : 1;
  return count * mult;
}

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

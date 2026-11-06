import { getAssemblyReference, getReversalReference } from './serialGroupingReference.js';

/**
 * PHASE 7H — Display mapping for the grouping list.
 *
 * One grouping record produces exactly one display row. The row intentionally
 * contains no price/HPP fields: the UI shows identity and workflow metadata
 * only, while the backend keeps its costing ledger untouched.
 *
 * `reference` is the official assembly document number. It is never
 * synthesised; legacy rows keep `null` so the UI can show an honest "—".
 */
export function getGroupingDisplayRow(item) {
  if (!item) return null;

  return {
    id: item.id ?? null,
    reference: getAssemblyReference(item),
    reversalReference: getReversalReference(item),
    groupingNumber: item.grouping_number || item.group_number || null,
    resultSerialNumber: item.result_serial_number || item.group_serial_number || null,
    resultProductName: item.result_product?.name || item.result_product_name || null,
    resultProductSku: item.result_product?.sku || item.result_product_sku || null,
    unit: item.target_unit || null,
    status: item.status || null,
    createdAt: item.created_at || null,
    warehouseId: item.warehouse_id || null,
    warehouseName: item.warehouse_name || null,
  };
}

export function getGroupingDisplayRows(items) {
  if (!Array.isArray(items)) return [];
  return items.map(getGroupingDisplayRow).filter(Boolean);
}

/**
 * Maps persisted `serial_grouping_components` rows to the four-column detail
 * table. Names/SKUs are snapshots taken at grouping time, so historical rows
 * stay accurate even if the source master product changes later.
 */
export function getGroupingComponentRow(component) {
  if (!component) return null;

  return {
    id: component.id ?? null,
    serialNumber: component.component_serial_number || component.serial_number || null,
    productName: component.snapshot_product_name || component.product_name || null,
    sku: component.snapshot_sku || component.sku || null,
    unit: component.unit || null,
    isSubGroup: Boolean(component.is_sub_group),
  };
}

export function getGroupingComponentRows(components) {
  if (!Array.isArray(components)) return [];
  return components.map(getGroupingComponentRow).filter(Boolean);
}

/**
 * PHASE 7K — Display mapping for Grouping Session header row.
 * Displays one primary row per session. Expands to show batches and components.
 */
export function getGroupingSessionRow(session) {
  if (!session) return null;

  const rawBatches = Array.isArray(session.batches) ? session.batches : [];
  const totalBatches = session.totalBatches ?? rawBatches.length ?? 1;
  const totalSerials = session.totalSerials ?? rawBatches.reduce((sum, b) => {
    const bSerials = Array.isArray(b.serials) ? b.serials.length : 0;
    const bIds = Array.isArray(b.memberSerialIds) ? b.memberSerialIds.length : 0;
    return sum + (bSerials || bIds || Number(b.totalBaseQtyPcs || 1));
  }, 0);

  return {
    id: session.id ?? null,
    sessionNumber: session.sessionNumber || session.session_number || session.reference || '—',
    reference: session.reference || session.sessionNumber || session.session_number || '—',
    name: session.name || session.session_name || 'Sesi Grouping',
    status: (session.status || 'pending').toLowerCase(),
    warehouseId: session.warehouseId || session.warehouse_id || null,
    warehouseName: session.warehouseName || session.warehouse_name || null,
    createdAt: session.createdAt || session.created_at || null,
    confirmedAt: session.confirmedAt || session.confirmed_at || null,
    totalBatches,
    totalSerials,
    batches: rawBatches,
    isPending: (session.status || '').toLowerCase() === 'pending',
    isLegacy: Boolean(session.isLegacy),
  };
}

export function getGroupingSessionRows(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.map(getGroupingSessionRow).filter(Boolean);
}


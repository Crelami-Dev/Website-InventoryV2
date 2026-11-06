/**
 * PHASE 7E — Grouping reference helpers.
 *
 * The reference MUST come from the official `goods_assembly` document stored in
 * the database. Legacy rows without a linked document stay empty; nothing is
 * ever synthesised from dates or serial numbers.
 */

export function getAssemblyReference(item) {
  return (
    item?.assembly_document_number ||
    item?.reference_number ||
    item?.source_document?.document_number ||
    item?.source_document_number ||
    null
  );
}

export function getReversalReference(item) {
  return (
    item?.reversal_document_number ||
    item?.reverse_document?.document_number ||
    item?.reverse_document_number ||
    null
  );
}

/**
 * Multi-field client-side search for the grouping list.
 * Keeps the reference (assembly + reversal) searchable.
 */
export function matchesGroupingSearch(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;

  const fields = [
    item?.grouping_number || item?.group_number,
    item?.result_serial_number || item?.group_serial_number,
    item?.result_product?.name || item?.result_product_name,
    item?.result_product?.sku || item?.result_product_sku,
    getAssemblyReference(item),
    getReversalReference(item),
  ];

  return fields.some((value) => String(value || '').toLowerCase().includes(q));
}

/**
 * Multi-field client-side search for grouping sessions.
 * Searches session reference, session name, batch products, SKUs, result serials, and component SNs.
 */
export function matchesGroupingSessionSearch(session, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;

  if (
    String(session?.sessionNumber || '').toLowerCase().includes(q) ||
    String(session?.session_number || '').toLowerCase().includes(q) ||
    String(session?.reference || '').toLowerCase().includes(q) ||
    String(session?.name || '').toLowerCase().includes(q) ||
    String(session?.session_name || '').toLowerCase().includes(q) ||
    String(session?.notes || '').toLowerCase().includes(q)
  ) {
    return true;
  }

  const batches = Array.isArray(session?.batches) ? session.batches : [];
  for (const b of batches) {
    if (
      String(b.name || '').toLowerCase().includes(q) ||
      String(b.resultProductName || b.targetProductName || '').toLowerCase().includes(q) ||
      String(b.resultProductSku || b.targetProductSku || '').toLowerCase().includes(q) ||
      String(b.resultSerialNumber || b.groupSerialNumber || '').toLowerCase().includes(q) ||
      String(b.assemblyDocumentNumber || '').toLowerCase().includes(q)
    ) {
      return true;
    }
    const serials = Array.isArray(b.serials) ? b.serials : (Array.isArray(b.memberSerialNumbers) ? b.memberSerialNumbers : []);
    for (const s of serials) {
      const sn = typeof s === 'string' ? s : (s.serialNumber || s.serial_number || '');
      const pName = typeof s === 'object' ? (s.productName || s.product_name || '') : '';
      if (sn.toLowerCase().includes(q) || pName.toLowerCase().includes(q)) {
        return true;
      }
    }
  }

  return false;
}


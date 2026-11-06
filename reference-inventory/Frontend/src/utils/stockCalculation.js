/**
 * Shared Inventory & Stock Calculation Logic for DocuFlow
 *
 * Ensures consistent stock calculation across ProductsPage, ProductDetailPage,
 * ProductTable, ProductCard, and Reports.
 */

/**
 * Normalizes SKU string for robust fallback comparison
 */
export function normalizeSku(sku) {
  if (!sku) return '';
  return String(sku).trim().toLowerCase();
}

/**
 * Parses the unit multiplier of a serial number safely based on metadata,
 * custom units, or serial number syntax per AGENTS.md rules.
 */
export function parseSerialUnit(serial, { customUnits = [], multipliers = {} } = {}) {
  let unit = serial?.metadata?.serialUnit || serial?.serialUnit || serial?.unit;
  const sn = String(serial?.serialNumber ?? serial?.serial_number ?? '').toLowerCase();

  if (!unit || unit === 'piece' || unit === 'pcs') {
    if (Array.isArray(customUnits) && customUnits.length > 0) {
      const sorted = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
      for (const u of sorted) {
        const k = String(u.key).toLowerCase().trim();
        if (!k || k === 'pcs') continue;
        if (sn.includes(k)) {
          unit = k;
          break;
        }
      }
    }
    if (!unit || unit === 'piece' || unit === 'pcs') {
      if (sn.includes('10bl') || sn.includes('bal10')) unit = 'bal10';
      else if (sn.includes('15bl') || sn.includes('bal15')) unit = 'bal15';
      else if (sn.includes('20bl') || sn.includes('bal20')) unit = 'bal20';
      else if (sn.includes('25bl') || sn.includes('bal25')) unit = 'bal25';
      else if (sn.includes('bal5') || sn.includes('5bl')) unit = 'bal5';
      else if (sn.includes('pack3') || sn.includes('pk3') || sn.includes('3pk')) unit = 'pack3';
      else if (sn.includes('pack6') || sn.includes('pk6') || sn.includes('6pk')) unit = 'pack6';
      else if (sn.includes('bal') || sn.includes('bl')) unit = 'bal';
      else if (sn.includes('pack') || sn.includes('pk')) unit = 'pack';
      else if (sn.includes('lusin') || sn.includes('doz')) unit = 'dozen';
    }
  }

  // Serial Group: use totalPcs directly if defined on metadata
  if (serial?.metadata?.isGroup && Number(serial?.metadata?.totalPcs) > 0) {
    return { unit: 'pcs', multiplier: Number(serial.metadata.totalPcs) };
  }

  const cleanUnit = String(unit || 'pcs').toLowerCase();
  const mult = Number(serial?.metadata?.unitQty) || multipliers[cleanUnit] || 1;
  return { unit: cleanUnit, multiplier: mult };
}

/**
 * Calculates net stock movements from documents for a collection of products.
 * Supports warehouse filtering, return deductions, SKU matching fallback,
 * and valid completed/processing/ready document states.
 */
export function calculateDocumentStockMovements(args = {}) {
  // Support both object param ({ documents, multipliers, ... }) and direct array (documents, multipliers)
  const isDirectArray = Array.isArray(args);
  const documents = isDirectArray ? args : (args.documents || []);
  const products = isDirectArray ? [] : (args.products || []);
  const multipliers = isDirectArray ? (arguments[1] || {}) : (args.multipliers || {});
  const activeWarehouseId = isDirectArray ? null : (args.activeWarehouseId || null);

  const movementByProductId = new Map();

  // Pre-build SKU-to-productId map for robust matching
  const productBySku = new Map();
  (products || []).forEach((p) => {
    if (p.sku) {
      productBySku.set(normalizeSku(p.sku), p.id);
    }
  });

  (documents ?? []).forEach((doc) => {
    const status = doc.status || 'draft';
    // Active stock-affecting statuses in DocuFlow workflow
    if (status !== 'completed' && status !== 'processing' && status !== 'ready' && status !== 'approved') return;

    const docType = doc.document_type || doc.type;
    const isGoodsIn = docType === 'goods_in';
    const isGoodsOut = docType === 'goods_out';
    const isAssembly = docType === 'goods_assembly';
    const isDisassembly = docType === 'goods_disassembly';
    if (!isGoodsIn && !isGoodsOut && !isAssembly && !isDisassembly) return;

    const docWh = doc.warehouse_id || doc.warehouseId;
    if (activeWarehouseId && docWh && String(docWh) !== String(activeWarehouseId)) {
      return;
    }

    const items = doc.items ?? doc.document_items ?? [];
    items.forEach((item) => {
      let productId = item.productId ?? item.product_id;
      if (!productId && item.sku) {
        productId = productBySku.get(normalizeSku(item.sku));
      }
      if (!productId) return;

      const rawQty = item.metadata?.qtyInput ?? item.quantity ?? item.qty ?? 1;
      const unit = item.metadata?.qtyUnit || item.qtyUnit || item.unit || 'pcs';
      const mult = multipliers[unit] || 1;
      const qtyInPcs = rawQty * mult;

      const current = movementByProductId.get(productId) ?? { in: 0, out: 0, net: 0 };
      if (isGoodsIn) current.in += qtyInPcs;
      if (isGoodsOut) current.out += qtyInPcs;

      if (isAssembly) {
        const role = item.assembly_role || item.metadata?.assemblyRole || (item.movement_type === 'in' || item.metadata?.movementType === 'in' ? 'result' : 'component');
        if (role === 'result') {
          current.in += qtyInPcs;
        } else {
          current.out += qtyInPcs;
        }
      }

      if (isDisassembly) {
        const role = item.assembly_role || item.metadata?.assemblyRole || (item.movement_type === 'in' || item.metadata?.movementType === 'in' ? 'component' : 'result');
        if (role === 'component') {
          current.in += qtyInPcs;
        } else {
          current.out += qtyInPcs;
        }
      }

      movementByProductId.set(productId, current);
    });

    // Deduct returned items from Goods Out to accurately restore stock
    if (isGoodsOut && Array.isArray(doc.metadata?.returns)) {
      doc.metadata.returns.forEach((r) => {
        (r.items || []).forEach((ri) => {
          let rProdId = ri.productId ?? ri.product_id;
          if (!rProdId && ri.sku) {
            rProdId = productBySku.get(normalizeSku(ri.sku));
          }
          if (!rProdId) return;

          const rQty = Number(ri.returnedQty || 1);
          const rUnit = ri.qtyUnit || ri.unit || 'pcs';
          const rMult = multipliers[rUnit] || 1;
          const returnedPcs = rQty * rMult;

          const current = movementByProductId.get(rProdId) ?? { in: 0, out: 0, net: 0 };
          current.out = Math.max(0, current.out - returnedPcs);
          movementByProductId.set(rProdId, current);
        });
      });
    }
  });

  // Calculate net = Math.max(0, in - out) for all entries
  for (const [prodId, mov] of movementByProductId.entries()) {
    mov.net = Math.max(0, mov.in - mov.out);
  }

  return movementByProductId;
}

/**
 * Calculates physical available serials per product.
 * Filters by warehouse scope and excludes serials tied to cancelled Goods In documents.
 */
export function calculateAvailableSerialsByProduct({
  serials = [],
  documents = [],
  multipliers = {},
  customUnits = [],
  activeWarehouseId = null,
} = {}) {
  const docMap = new Map((documents ?? []).map((d) => [d.id, d]));
  const serialCountByProduct = new Map();

  (serials ?? []).forEach((serial) => {
    const prodId = serial.product_id || serial.productId;
    if (!prodId || serial.status !== 'available') return;

    // Do not count serials that are currently packed inside a group (avoid double-counting)
    if (serial.metadata?.isGrouped || serial.metadata?.parentGroupId) return;

    // Do not count dissolved groups
    if (serial.metadata?.isDissolved) return;

    // Check warehouse isolation for serial
    const serialWh = serial.warehouse_id || serial.warehouseId;
    if (activeWarehouseId && serialWh && String(serialWh) !== String(activeWarehouseId)) {
      return;
    }

    // Check tied document status if document is found
    const goodsInDocId = serial.goodsInDocumentId || serial.goods_in_document_id;
    if (goodsInDocId) {
      const linkedDoc = docMap.get(goodsInDocId);
      if (linkedDoc && (linkedDoc.status === 'cancelled' || (linkedDoc.document_type !== 'goods_in' && linkedDoc.type !== 'goods_in'))) {
        return;
      }
    }

    const { multiplier } = parseSerialUnit(serial, { customUnits, multipliers });
    serialCountByProduct.set(prodId, (serialCountByProduct.get(prodId) ?? 0) + multiplier);
  });

  return serialCountByProduct;
}

/**
 * Computes canonical effective stock for a product in pcs.
 * For serial tracked products: prioritizes physical available serials, falling back to net movements.
 * For non-serial products: uses net document movements.
 */
export function getProductEffectiveStockInPcs({
  product,
  availableSerialPcs = 0,
  netMovementPcs = 0,
  hasSerials = false,
}) {
  const isSerial = product.trackingMode === 'serial' || hasSerials;
  if (isSerial) {
    return availableSerialPcs > 0 ? availableSerialPcs : netMovementPcs;
  }
  return netMovementPcs;
}

/**
 * Filters serial numbers for display in the main Serial Number table.
 * 
 * Rules:
 * 1. Shows active standalone serials and top-level active groups.
 * 2. Strictly hides all grouped children (both direct members and leaf items in nested groups).
 * 3. Hides dissolved groups.
 * 4. Hides serials dispatched via Goods Out / Invoice / Delivery.
 * 5. Restores returned serials to display.
 */
export function filterDisplaySerials(serials = [], rawDocuments = []) {
  if (!Array.isArray(serials) || serials.length === 0) return [];

  const outSerialSet = new Set();
  (rawDocuments || []).forEach((doc) => {
    const status = doc.status || 'draft';
    const docType = doc.document_type || doc.type;
    if (
      (docType === 'goods_out' || docType === 'invoice' || docType === 'delivery_note') &&
      (status === 'completed' || status === 'processing')
    ) {
      (doc.items || []).forEach((item) => {
        const sn = item.metadata?.serialNumber || item.serialNumber || item.serial_number;
        if (sn) {
          outSerialSet.add(String(sn).trim().toLowerCase());
        }
      });
    }
  });

  return serials.filter((s) => {
    // 1. Sembunyikan semua serial yang masih menjadi anggota group aktif
    if (s.metadata?.isGrouped || s.metadata?.parentGroupId) {
      return false;
    }

    // 2. Sembunyikan group yang sudah dibongkar (dissolved)
    if (s.metadata?.isDissolved || s.status === 'dissolved') {
      return false;
    }

    // 3. Group Serials aktif
    if (s.metadata?.isGroup) {
      const statusClean = String(s.status || '').toLowerCase();
      if (statusClean === 'out' || statusClean === 'dispatched' || statusClean === 'sold') return false;
      if (s.goodsOutDocumentId || s.goods_out_document_id) return false;
      const snStr = String(s.serialNumber || s.serial_number || '').trim().toLowerCase();
      if (snStr && outSerialSet.has(snStr)) {
        if (s.metadata?.returnedAt) return true;
        return false;
      }
      return true;
    }

    // 4. Standard Serials
    const goodsInDocId = s.goodsInDocumentId || s.goods_in_document_id;
    if (goodsInDocId && Array.isArray(rawDocuments) && rawDocuments.length > 0) {
      const linkedDoc = rawDocuments.find((d) => d.id === goodsInDocId);
      if (linkedDoc && ((linkedDoc.document_type !== 'goods_in' && linkedDoc.type !== 'goods_in') || linkedDoc.status === 'cancelled')) {
        return false;
      }
    }

    const statusClean = String(s.status || '').toLowerCase();
    if (statusClean === 'out' || statusClean === 'dispatched' || statusClean === 'sold') {
      return false;
    }
    if (s.goodsOutDocumentId || s.goods_out_document_id) {
      return false;
    }
    const snStr = String(s.serialNumber || s.serial_number || '').trim().toLowerCase();
    if (snStr && outSerialSet.has(snStr)) {
      if (s.metadata?.returnedAt) {
        return true;
      }
      return false;
    }

    return true;
  });
}


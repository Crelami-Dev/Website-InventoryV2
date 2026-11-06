/**
 * PHASE 7E — Pure helpers for scan-first multi-grouping product policy.
 *
 * Kept framework-free so the business rules can be unit tested without React.
 */

/**
 * Derive the source-product composition from VERIFIED serial records.
 * The identity comes from `product_id` returned by the backend, never from
 * the serial number text or a guessed SKU.
 */
export function computeSourceProductPolicy(serials = []) {
  const byProduct = new Map();

  for (const s of serials || []) {
    const productId = s?.productId || s?.product_id;
    if (!productId) continue;

    if (!byProduct.has(productId)) {
      byProduct.set(productId, {
        productId,
        productName: s?.productName || s?.product_name || 'Produk',
        sku: s?.sku || '',
        serialCount: 0,
      });
    }
    byProduct.get(productId).serialCount += 1;
  }

  const sourceProducts = Array.from(byProduct.values()).sort(
    (a, b) => b.serialCount - a.serialCount
      || String(a.productName).localeCompare(String(b.productName))
  );

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
 * Apply the source-product policy atomically with a composition change.
 * - single source  -> lock result product to the source product
 * - empty batch    -> reset selection
 * - mixed batch    -> release the lock, keep the current (valid) selection
 *
 * Preview output is invalidated because the composition changed.
 */
export function withSourceProductPolicy(batch, serials) {
  const previousPolicy = computeSourceProductPolicy(batch?.serials || []);
  const policy = computeSourceProductPolicy(serials);
  const next = { ...batch, serials, previewData: null, previewError: null };

  if (policy.productSelectionLocked) {
    next.targetProductId = policy.lockedResultProductId;
    next.isNewProduct = false;
    next.newProductName = '';
    next.newProductSku = '';
  } else if (policy.distinctProductCount === 0) {
    next.targetProductId = '';
    next.isNewProduct = false;
    next.newProductName = '';
    next.newProductSku = '';
  } else if (
    previousPolicy.productSelectionLocked
    && next.targetProductId === previousPolicy.lockedResultProductId
  ) {
    // Mixed composition must be an explicit choice, not a silent carry-over
    // of the product that was auto-locked while the batch was single-source.
    next.targetProductId = '';
    next.isNewProduct = false;
    next.newProductName = '';
    next.newProductSku = '';
  }

  return next;
}

/**
 * Decide whether an async preview/verification result is stale and must NOT
 * be written to the current state.
 */
export function isStalePreviewResult({
  requestSeq,
  currentSeq,
  requestBatchId,
  currentBatchId,
  snapshotMembershipKey,
  currentMembershipKey,
}) {
  if (requestSeq !== currentSeq) return true;
  if (requestBatchId !== currentBatchId) return true;
  return snapshotMembershipKey !== currentMembershipKey;
}

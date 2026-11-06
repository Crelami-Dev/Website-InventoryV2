// SerialGroupModal.jsx - Unified adapter to SerialGroupingCreateModal
import React from 'react';
import SerialGroupingCreateModal from '../SerialGrouping/SerialGroupingCreateModal';

export default function SerialGroupModal({
  isOpen,
  onClose,
  initialSelectedSerials = [],
  product = null,
  productId = null,
  warehouseId = null,
  onSuccess,
}) {
  return (
    <SerialGroupingCreateModal
      isOpen={isOpen}
      onClose={onClose}
      initialSelectedSerials={initialSelectedSerials}
      contextProduct={product}
      initialProductId={productId || product?.id || null}
      initialWarehouseId={warehouseId || product?.warehouseId || product?.warehouse_id || null}
      onSuccess={onSuccess}
    />
  );
}


/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Kontrak Domain Ledger, Saldo, Reservasi, dan Serial Number (Fase 4 Fondasi)
 * Berdasarkan RPD §7.4, §10, Desain Database Tahap 3, dan AUDIT_FINALISASI_DATABASE
 */

export type TrackingMode = 'SERIAL' | 'NON_SERIAL';

export type LedgerEntryType =
  | 'GOODS_IN_POSTED'
  | 'GOODS_OUT_COMPLETED'
  | 'STOCK_ADJUSTMENT_POSTED'
  | 'RETURN_IN_POSTED'
  | 'RETURN_OUT_POSTED'
  | 'RETURN_REVERSAL_POSTED';

export type ReservationStatus =
  | 'ACTIVE'
  | 'RELEASED_COMPLETED'
  | 'RELEASED_CANCELLED';

export type SerialLifecycleStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'QUARANTINE'
  | 'CONSUMED_OUT'
  | 'DECOMMISSIONED'
  | 'GROUPED'
  | 'RETURNED_TO_SUPPLIER';

export type ReturnType = 'CUSTOMER_RETURN' | 'SUPPLIER_RETURN';

export type InventoryReturnStatus = 'DRAFT' | 'RECEIVED' | 'REJECTED' | 'CANCELLED';

export type GroupReturnMode = 'WHOLE_GROUP' | 'ECERAN_DISSOLVE';

export type DocumentReturnStatus = 'NONE' | 'PARTIAL' | 'FULL';

export const RETURN_ERROR_CODES = {
  DOC_NOT_FOUND: 'RETURN_ERR_DOC_NOT_FOUND',
  INVALID_DOC_STATUS: 'RETURN_ERR_INVALID_DOC_STATUS',
  INVALID_RETURN_TYPE: 'RETURN_ERR_INVALID_RETURN_TYPE',
  SERIAL_NOT_AVAILABLE: 'RETURN_ERR_SERIAL_NOT_AVAILABLE',
  SERIAL_IN_ACTIVE_GROUP: 'RETURN_ERR_SERIAL_IN_ACTIVE_GROUP',
  SERIAL_ALREADY_CONSUMED: 'RETURN_ERR_SERIAL_ALREADY_CONSUMED',
  QUANTITY_EXCEEDED: 'RETURN_ERR_QUANTITY_EXCEEDED',
  SERIAL_NOT_IN_SOURCE: 'RETURN_ERR_SERIAL_NOT_IN_SOURCE',
  ALREADY_RECEIVED: 'RETURN_ERR_ALREADY_RECEIVED',
  CANNOT_REVERT: 'RETURN_ERR_CANNOT_REVERT',
  CANNOT_CANCEL: 'RETURN_ERR_CANNOT_CANCEL',
} as const;

export type ReturnErrorCode = typeof RETURN_ERROR_CODES[keyof typeof RETURN_ERROR_CODES];

export interface ReturnLineItemInput {
  productId: string;
  quantity: number;
  unit?: string;
  condition: 'BAIK' | 'RUSAK';
  returnedSerials?: string[];
  groupId?: string | null;
  groupReturnMode?: GroupReturnMode;
}

export interface CreateInventoryReturnInput {
  warehouseId: string;
  returnType?: ReturnType;
  customerId?: string;
  supplierId?: string;
  goodsOutId?: string;
  goodsInId?: string;
  returnNumber: string;
  returnDate: string;
  reason: 'SALAH_KIRIM' | 'PEMBATALAN' | 'SALAH_INPUT' | 'CACAT' | 'LAINNYA';
  notes?: string;
  lines: ReturnLineItemInput[];
}

export interface RevertInventoryReturnInput {
  returnId: string;
  reason?: string;
}

/**
 * Entri Buku Besar (Inventory Ledger) — Sumber Tunggal Kebenaran Pergerakan Stok
 * Sifat: Append-Only, Immutable. Saldo fisik direkonstruksi dari SUM(quantityDeltaBase).
 */
export interface LedgerEntry {
  id: string;
  sequenceNumber: number;
  ownerId: string;
  warehouseId: string;
  productId: string;
  locationId: string | null;
  entryType: LedgerEntryType;
  sourceDocType: 'GOODS_IN' | 'GOODS_OUT' | 'STOCK_OPNAME_ADJUSTMENT' | 'RETURN';
  sourceDocId: string;
  sourceLineId: string;
  quantityDeltaBase: number; // Positif untuk penambahan stok, negatif untuk pengurangan stok. Harus integer untuk SERIAL.
  serialIds?: string[];      // Daftar ID unit serial jika trackingMode === 'SERIAL'
  actorUserId: string;
  occurredAt: string;        // ISO DateTime
  notes?: string;
}

/**
 * Entri Reservasi Stok (Goods Out Pending & PO Fulfillment)
 * Menahan kuota kuantitas atau unit serial tanpa memotong saldo fisik.
 */
export interface ReservationEntry {
  id: string;
  ownerId: string;
  warehouseId: string;
  productId: string;
  sourceDocType: 'GOODS_OUT_PENDING' | 'PURCHASE_ORDER_ALLOCATION';
  sourceDocId: string;
  sourceLineId: string;
  reservedBaseQty: number;   // Kuantitas dasar yang ditahan
  serialIds?: string[];      // Daftar SN unik yang ditahan jika SERIAL
  status: ReservationStatus;
  createdAt: string;
  releasedAt: string | null;
  releasedReason?: 'COMPLETED' | 'CANCELLED_SOFT_DELETE' | 'EXPIRED';
}

/**
 * Registry Serial Number Aktif (Owner-Wide Guard)
 * Menegakkan invariant: SN aktif tidak boleh ada di dua gudang dalam satu Owner.
 */
export interface ActiveSerialRecord {
  serialId: string;
  serialNumberNormalized: string;
  ownerId: string;
  warehouseId: string;
  productId: string;
  status: SerialLifecycleStatus;
  isGroup?: boolean;
  parentGroupId?: string | null;
  registeredAt: string;
}

/**
 * Entri Grouping Serial Number
 */
export type SerialGroupingStatus = 'AVAILABLE' | 'RESERVED' | 'CONSUMED_OUT' | 'DISSOLVED';

export interface SerialGroupingRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  groupNumber: string;
  groupName: string | null;
  productId: string | null;
  unit: 'pcs' | 'lusin';
  unitQuantity: number;
  totalBaseQtyPcs: number;
  status: SerialGroupingStatus;
  notes?: string | null;
  createdBy: string;
  createdAt: string;
  dissolvedBy?: string | null;
  dissolvedAt?: string | null;
}

export interface CreateSerialGroupItemInput {
  groupName?: string | null;
  unit: "pcs" | "lusin";
  unitQty?: number;
  notes?: string | null;
  serialIds: string[]; // Minimal 2 serial id
}

export interface CreateSerialGroupsBatchInput {
  warehouseId: string;
  groups: CreateSerialGroupItemInput[];
}

export interface SerialGroupDetailResult {
  group: SerialGroupingRecord;
  components: Array<{
    id: string;
    serialId: string;
    serialNumber: string;
    productId: string;
    productName: string;
    sku: string;
    baseQtyPcs: number;
    unit: string;
    unitQuantity: number;
  }>;
}

/**
 * Proyeksi Saldo Stok Gudang
 * Hanyalah proyeksi (cache/rekonstruksi) dari ledger dan reservasi aktif.
 */
export interface ReconstructedStockBalance {
  ownerId: string;
  warehouseId: string;
  productId: string;
  physicalStock: number;   // Dari SUM(ledger.quantityDeltaBase)
  reservedStock: number;   // Dari SUM(active_reservations.reservedBaseQty)
  availableStock: number;  // physicalStock - reservedStock (tidak boleh negatif)
}

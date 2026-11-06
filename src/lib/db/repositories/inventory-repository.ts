/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Inventory Database Repository (TASK-013 & TASK-014)
 * Menegakkan:
 * 1. Isolasi Owner & Warehouse pada level Server Database.
 * 2. Immutable Ledger sebagai satu-satunya sumber kebenaran stok fisik.
 * 3. Reservasi stok untuk Goods Out Pending tanpa memotong stok fisik.
 * 4. Pelepasan reservasi via Soft-Delete Tombstone (TIDAK ADA HARD DELETE).
 * 5. Guard Serial Number aktif lintas gudang dalam satu Owner.
 * 6. Audit Trail untuk setiap mutasi sensitif.
 */

import crypto from "node:crypto";
import { getDatabaseClient, type DatabaseClient } from "../sqlite-client.ts";
import type { ActiveSecurityContext } from "../../types/auth.ts";
import { AppError } from "../../errors/app-error.ts";
import {
  calculateDocumentTotals,
  type DocumentLineDiscountType,
} from "../../inventory/document-calc.ts";
import { getUnitMultiplier, resolveSerialUnitRepresentation } from "../../inventory/units.ts";
import {
  evaluateCrossWarehouseSerialGuard,
  normalizeSerialNumber,
  reconstructStockBalance,
  reconcileStockOpnameItem,
} from "../../inventory/ledger-engine.ts";
import type {
  ActiveSerialRecord,
  LedgerEntry,
  ReservationEntry,
  ReconstructedStockBalance,
  SerialGroupingRecord,
  SerialGroupingStatus,
  CreateSerialGroupsBatchInput,
  SerialGroupDetailResult,
  ReturnType,
  InventoryReturnStatus,
  GroupReturnMode,
  DocumentReturnStatus,
  ReturnLineItemInput,
  CreateInventoryReturnInput,
  RevertInventoryReturnInput,
} from "../../types/inventory-domain.ts";
import { RETURN_ERROR_CODES } from "../../types/inventory-domain.ts";

export interface ProductRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  sku: string;
  name: string;
  barcode: string | null;
  category: string;
  trackingMode: "SERIAL" | "NON_SERIAL";
  unit: string;
  minStock: number;
  description: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  // Proyeksi saldo hasil kalkulasi ledger & reservasi
  physicalStock?: number;
  reservedStock?: number;
  availableStock?: number;
  availableStandaloneStock?: number; // Stok yang tersedia mandiri (AVAILABLE & bukan anggota group)
  groupedStock?: number; // Kuantitas fisik yang sedang berada di dalam group (GROUPED)
}

export interface SerialRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  productId: string;
  serialNumber: string;
  normalizedSerialNumber: string;
  status: "AVAILABLE" | "RESERVED" | "QUARANTINE" | "CONSUMED_OUT" | "DECOMMISSIONED";
  unit?: string;
  unitQuantity?: number;
  baseQuantity?: number;
  sourceGoodsInId?: string | null;
  sourceLineId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterGoodsInSerialsInput {
  goodsInId: string;
  lineId: string;
  serialNumbers: string[];
}

export interface GoodsInLineSerialStatus {
  lineId: string;
  productId: string;
  productName: string;
  sku: string;
  warehouseId: string;
  receivedQuantity: number;
  unit: string;
  conversionMultiplier: number;
  totalBaseQuantity: number;
  requiredUnits: number;
  registeredCount: number;
  remainingCount: number;
  status: "BELUM_DIREGISTRASIKAN" | "SEBAGIAN_DIREGISTRASIKAN" | "LENGKAP";
  serials: Array<{
    id: string;
    serialNumber: string;
    unit: string;
    unitQuantity: number;
    baseQuantity: number;
    status: string;
    createdAt: string;
  }>;
}

export interface GoodsInSerialsStatusResult {
  goodsInId: string;
  documentNumber: string;
  documentDate: string;
  status: string;
  warehouseId: string;
  lines: GoodsInLineSerialStatus[];
}

export interface AvailableSerialItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  warehouseId: string;
  serialNumber: string;
  unit: string;
  unitQuantity: number;
  baseQuantity: number;
  status: string;
  createdAt: string;
}

export interface CreateProductInput {
  warehouseId: string;
  sku: string;
  name: string;
  barcode?: string;
  category: string;
  trackingMode: "SERIAL" | "NON_SERIAL";
  unit?: string;
  minStock?: number;
  description?: string;
}

export interface UpdateProductInput {
  productId: string;
  name?: string;
  barcode?: string | null;
  category?: string;
  trackingMode?: "SERIAL" | "NON_SERIAL";
  minStock?: number;
  description?: string | null;
  status?: "ACTIVE" | "INACTIVE" | "ARCHIVED";
}

export interface GoodsInLineInput {
  productId: string;
  quantity: number;
  unit?: string;
  serials?: string[];
  note?: string;
}

export interface CreateGoodsInInput {
  warehouseId: string;
  supplierId?: string;
  supplierName?: string;
  documentNumber: string;
  documentDate: string;
  note?: string;
  lines: GoodsInLineInput[];
}

export interface GoodsOutLineInput {
  productId: string;
  quantity: number;
  unit?: string;
  serials?: string[];
  poLineId?: string;
  groupId?: string;
  groupSerialsSnapshotJson?: string;
}

export interface CreateGoodsOutPendingInput {
  warehouseId: string;
  customerId?: string;
  customerName?: string;
  customerAddress?: string;
  poId?: string;
  documentNumber: string;
  documentDate: string;
  note?: string;
  lines: GoodsOutLineInput[];
}

export interface UpdateGoodsInPendingInput {
  goodsInId: string;
  documentNumber?: string;
  supplierId?: string;
  supplierName?: string;
  documentDate?: string;
  note?: string;
  lines: GoodsInLineInput[];
}

export interface UpdateGoodsOutPendingInput {
  goodsOutId: string;
  documentNumber?: string;
  customerId?: string;
  customerName?: string;
  customerAddress?: string;
  poId?: string;
  documentDate?: string;
  note?: string;
  lines: GoodsOutLineInput[];
}

export interface WarehouseRecord {
  id: string;
  ownerId: string;
  code: string;
  name: string;
  address: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  conversionDisplayUnit?: "pcs" | "lusin";
  createdAt: string;
  updatedAt: string;
}

export interface StockOpnameSessionRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  warehouseName?: string;
  sessionNumber: string;
  title?: string | null;
  scope: "ALL" | "CATEGORY" | "LOCATION";
  scopeConfig?: string | null;
  status: "DRAFT" | "COUNTING" | "REVIEW" | "ADJUSTED" | "COMPLETED" | "CANCELLED";
  startedAt: string;
  snapshotAt?: string | null;
  reviewedAt: string | null;
  adjustedAt: string | null;
  createdBy: string;
  finalizedBy?: string | null;
  note: string | null;
  itemCount: number;
  varianceCount: number;
}

export interface StockOpnameAreaRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  sessionId: string;
  name: string;
  locationCode?: string | null;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  assignedUserId?: string | null;
  assignedUserEmail?: string | null;
  itemCount?: number;
  totalCountedQtyBase?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StockOpnameAreaCountRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  sessionId: string;
  areaId: string;
  productId: string;
  productName?: string;
  sku?: string;
  countedQtyBase: number;
  unit: string;
  unitQuantity: number;
  scannedSerialsJson?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockOpnameScanResult {
  success: boolean;
  resultType:
    | "SUCCESS"
    | "DUPLICATE_IN_AREA"
    | "DUPLICATE_CROSS_AREA"
    | "UNREGISTERED_SERIAL"
    | "INVALID_UNIT"
    | "INACTIVE_SESSION"
    | "INACTIVE_AREA";
  message: string;
  serialNumber: string;
  areaId: string;
  areaName?: string;
  productId?: string;
  productName?: string;
  sku?: string;
  baseQuantity?: number;
  unit?: string;
  duplicateAreaName?: string;
  timestamp: string;
}

export interface StockOpnameSerialSnapshotRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  sessionId: string;
  productId: string;
  productName?: string;
  sku?: string;
  serialNumber: string;
  normalizedSerialNumber: string;
  unit: string;
  unitQuantity: number;
  baseQuantity: number;
  statusAtSnapshot: string;
  snapshotAt: string;
  isUnitValid?: boolean;
}

export interface StockOpnameLineRecord {
  id: string;
  sessionId: string;
  productId: string;
  productName: string;
  sku: string;
  trackingMode: "SERIAL" | "NON_SERIAL";
  unit: string;
  snapshotQty: number;
  dynamicBookQty?: number | null;
  countedQty: number;
  varianceQty: number;
  reconciliationStatus?: string | null;
  discrepancyReason?: string | null;
  investigationNotes?: string | null;
  scannedSerials?: string[];
}

export interface StockOpnameSerialDetail {
  matchedSerials: Array<{
    serialNumber: string;
    normalized: string;
    unit: string;
    baseQuantity: number;
    scannedInArea?: string;
  }>;
  missingSerials: Array<{
    serialNumber: string;
    normalized: string;
    unit: string;
    baseQuantity: number;
    dispatchedPostSnapshot?: boolean;
    postSnapshotDocNumber?: string;
  }>;
  surplusSerials: Array<{
    serialNumber: string;
    normalized: string;
    unit: string;
    baseQuantity: number;
    receivedPostSnapshot?: boolean;
    postSnapshotDocNumber?: string;
    source: "SCANNED" | "SCAN_ERROR";
  }>;
}

export interface StockOpnameReconciliationItem extends StockOpnameLineRecord {
  deltaIn: number;
  deltaOut: number;
  netDelta: number;
  dynamicBookQty: number;
  hasConcurrentMovement: boolean;
  recommendation: "READY_FOR_ADJUSTMENT" | "REQUIRES_RE_EVALUATION" | "REQUIRES_INVESTIGATION";
  areaBreakdown: Array<{
    areaId: string;
    areaName: string;
    countedQtyBase: number;
  }>;
  serialDetail?: StockOpnameSerialDetail;
  concurrentTransactions: Array<{
    entryType: string;
    sourceDocType: string;
    sourceDocId: string;
    quantityDeltaBase: number;
    occurredAt: string;
    createdAt: string;
  }>;
}

export interface StockOpnameReconciliationSummary {
  session: StockOpnameSessionRecord;
  totalSku: number;
  matchCount: number;
  surplusCount: number;
  shortageCount: number;
  investigationCount: number;
  netDiscrepancyQty: number;
  items: StockOpnameReconciliationItem[];
}

export interface SubmitStockOpnameForReviewResult {
  success: true;
  sessionId: string;
  status: "REVIEW";
  reviewedAt: string;
}

export interface ApproveAndPostStockOpnameAdjustmentInput {
  sessionId: string;
  notes?: string;
  autoCompletePendingAreas?: boolean;
}

export interface ApproveAndPostStockOpnameAdjustmentResult {
  success: true;
  sessionId: string;
  sessionNumber: string;
  status: "ADJUSTED" | "COMPLETED";
  totalLines: number;
  totalAdjustedLines: number;
  totalVarianceQty: number;
  ledgerEntriesCreated: number;
  approvedAt: string;
  approvedByUserId: string;
}

export interface StockOpnameSessionDetail {
  session: StockOpnameSessionRecord;
  lines: StockOpnameLineRecord[];
  areas: StockOpnameAreaRecord[];
  serialSnapshotsCount: number;
}

export type PoMappingStatus = "UNMAPPED" | "CATALOG_MATCHED" | "MAPPED" | "CONVERTED_TO_CATALOG";
export type PoOrderedUnit = "PCS" | "Lusin" | "pcs" | "lusin" | "unit";
export type PurchaseOrderStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "CONFIRMED"
  | "PARTIALLY_FULFILLED"
  | "FULFILLED"
  | "CANCELLED"
  | "REJECTED";

export interface PurchaseOrderLineRecord {
  id: string;
  productId?: string | null;
  productName?: string;
  rawProductName: string;
  sku?: string;
  orderedQty: number;
  orderedUnit: PoOrderedUnit;
  conversionFactor: number;
  mappingStatus: PoMappingStatus;
  targetQty: number;
  fulfilledQty: number;
  unitPrice: number;
  discountAmount: number;
}

export interface PurchaseOrderRecord {
  id: string;
  ownerId: string;
  warehouseId?: string | null;
  customerId: string;
  customerName?: string;
  poNumber: string;
  orderDate: string;
  status: PurchaseOrderStatus;
  totalAmount: number;
  notes: string | null;
  salesPic?: string | null;
  createdByUserId: string;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
  rejectedByUserId?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  lines: PurchaseOrderLineRecord[];
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceStatus?: string | null;
}

export interface CreatePurchaseOrderInput {
  customerId?: string;
  newCustomerName?: string;
  newCustomerOwnerName?: string;
  newCustomerPhone?: string;
  newCustomerEmail?: string;
  newCustomerAddress?: string;
  warehouseId?: string;
  poNumber: string;
  orderDate: string;
  notes?: string;
  salesPic?: string;
  status?: PurchaseOrderStatus;
  lines: Array<{
    productId?: string | null;
    rawProductName?: string;
    orderedQty?: number;
    orderedUnit?: PoOrderedUnit;
    targetQty?: number;
    unitPrice?: number;
    discountAmount?: number;
  }>;
}

export interface CommercialDocumentRecord {
  id: string;
  ownerId: string;
  warehouseId?: string | null;
  customerId: string;
  customerName?: string;
  poId: string | null;
  poNumber?: string | null;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  documentType: "INVOICE" | "SAMPLE" | "SURAT_JALAN" | "RECEIPT";
  status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
  subtotal: number;
  itemDiscount: number;
  docNominalDiscount: number;
  docPercentageDiscount: number;
  shopDiscountNote?: string | null;
  pointsRedeemed: number;
  cashbackType?: "PERCENTAGE" | "NOMINAL" | "NONE";
  cashbackValue?: number;
  cashbackAmount?: number;
  totalAmount: number;
  paidAmount: number;
  printCount: number;
  notes: string | null;
}

export interface CommercialDocumentLineRecord {
  id: string;
  documentId: string;
  productId?: string | null;
  productName: string;
  sku: string;
  tracking: "SERIAL" | "NON_SERIAL";
  unit: string;
  quantity: number;
  unitPrice: number;
  discountType: "NOMINAL" | "PERCENTAGE" | "NONE";
  discountValue: number;
  lineTotal: number;
  descriptionSnapshot?: string | null;
}

export interface CommercialDocumentDetailRecord extends CommercialDocumentRecord {
  customerCode?: string;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerOwnerName?: string | null;
  customerPicSales?: string | null;
  customerEmail?: string | null;
  customerAvailablePoints?: number;
  customerPendingPoints?: number;
  lines: CommercialDocumentLineRecord[];
  payments: Array<{
    id: string;
    documentId: string;
    paymentNumber: string;
    paymentDate: string;
    amount: number;
    paymentMethod: string;
    referenceNumber: string | null;
    notes: string | null;
    receivedByName: string;
    proofMimeType?: string | null;
    proofBase64?: string | null;
    proofFileName?: string | null;
    proofFileSize?: number | null;
    createdAt: string;
  }>;
}

export interface CreateCommercialDocumentLineInput {
  productId?: string;
  productName?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  discountType?: DocumentLineDiscountType;
  discountValue?: number;
  note?: string | null;
}

export interface CreateNewCustomerDraft {
  name: string;
  ownerName?: string;
  picSales?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface CreateCommercialDocumentInput {
  customerId?: string;
  newCustomer?: CreateNewCustomerDraft;
  poId?: string;
  documentNumber?: string;
  documentDate: string;
  dueDate: string;
  documentType?: "INVOICE" | "SAMPLE" | "SURAT_JALAN" | "RECEIPT";
  paymentStatus?: "UNPAID" | "PAID";
  subtotal?: number;
  itemDiscount?: number;
  docNominalDiscount?: number;
  docPercentageDiscount?: number;
  shopDiscountNote?: string;
  pointsRedeemed?: number;
  cashbackType?: "PERCENTAGE" | "NOMINAL" | "NONE";
  cashbackValue?: number;
  cashbackAmount?: number;
  notes?: string;
  lines?: CreateCommercialDocumentLineInput[];
}

export interface UpdateCommercialDocumentLineInput {
  /** ID baris yang sudah ada; kosong untuk baris baru. */
  id?: string;
  productId?: string | null;
  productName?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  discountType: DocumentLineDiscountType;
  discountValue: number;
  /** Catatan/deskripsi item (disimpan sebagai description_snapshot). */
  note?: string | null;
}

/**
 * Input edit dokumen. Nomor dokumen, tipe, status, pembayaran, poin, dan PO sumber
 * sengaja TIDAK dapat diubah melalui jalur ini.
 */
export interface UpdateCommercialDocumentInput {
  documentId: string;
  customerId: string;
  documentDate: string;
  dueDate: string;
  notes?: string | null;
  docNominalDiscount: number;
  docPercentageDiscount: number;
  shopDiscountNote?: string | null;
  shopDiscountType?: "NOMINAL" | "PERCENTAGE";
  shopDiscountValue?: number;
  cashbackType?: "PERCENTAGE" | "NOMINAL" | "NONE";
  cashbackValue?: number;
  cashbackAmount?: number;
  pointsRedeemed?: number;
  lines: UpdateCommercialDocumentLineInput[];
}

export interface DocumentEditCustomerOption {
  id: string;
  code: string;
  name: string;
  ownerName?: string;
  picSales?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  availablePoints?: number;
  pendingPoints?: number;
}

export interface DocumentEditOptions {
  customers: DocumentEditCustomerOption[];
  products: Array<{ id: string; sku: string; name: string; unit: string }>;
  purchaseOrders?: Array<{ id: string; poNumber: string; customerId: string; customerName?: string }>;
}

export type {
  ReturnType,
  InventoryReturnStatus,
  GroupReturnMode,
  DocumentReturnStatus,
  ReturnLineItemInput,
  CreateInventoryReturnInput,
  RevertInventoryReturnInput,
};
export { RETURN_ERROR_CODES };

export interface InventoryReturnRecord {
  id: string;
  ownerId: string;
  warehouseId: string;
  warehouseName?: string;
  returnType: ReturnType;
  customerId: string | null;
  customerName?: string | null;
  supplierId: string | null;
  supplierName?: string | null;
  goodsOutId: string | null;
  goodsInId: string | null;
  returnNumber: string;
  returnDate: string;
  reason: "SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA";
  status: InventoryReturnStatus;
  reopenSourceQty: boolean;
  notes: string | null;
  lines: Array<{
    id: string;
    productId: string;
    productName?: string;
    sku?: string;
    quantity: number;
    unit: string;
    condition: "BAIK" | "RUSAK";
    returnedSerials?: string[];
    groupId?: string | null;
    groupReturnMode?: GroupReturnMode | null;
  }>;
}



// ====================================================================
// REPOSITORY IMPLEMENTATION
// ====================================================================

export class InventoryRepository {
  private db: DatabaseClient;

  constructor(customDb?: DatabaseClient) {
    this.db = customDb ?? getDatabaseClient();
  }

  /**
   * Mengambil nomor group berikutnya dengan format 'G-0001' (auto-increment dan tidak dipakai ulang)
   */
  getNextGroupNumber(ownerId?: string, warehouseId?: string): string {
    const lastRow = this.db.prepare(`
      SELECT group_number FROM serial_groupings
      ORDER BY rowid DESC LIMIT 1
    `).get() as { group_number: string } | undefined;

    let nextIndex = 1;
    if (lastRow?.group_number && lastRow.group_number.startsWith("G-")) {
      const parsed = parseInt(lastRow.group_number.replace("G-", ""), 10);
      if (!isNaN(parsed) && parsed >= 1) {
        nextIndex = parsed + 1;
      }
    }

    // Pastikan nomor benar-benar belum pernah terpakai
    while (true) {
      const candidate = `G-${String(nextIndex).padStart(4, "0")}`;
      const exists = this.db.prepare(`
        SELECT 1 FROM serial_groupings WHERE group_number = ?
      `).get(candidate);
      if (!exists) {
        return candidate;
      }
      nextIndex++;
    }
  }

  /**
   * Service: createGrouping (Mendukung Batch Form Multi-Baris, 1 Transaksi Atomik)
   * Aturan:
   * 1. Minimal 2 SN per group.
   * 2. SN harus AVAILABLE, 1 owner + gudang, belum jadi anggota group lain, tidak dobel di batch.
   * 3. Semua SN 1 produk: nama group terkunci = nama produk, product_id terisi.
   *    Ada >1 produk: group_name WAJIB diisi manual, product_id = null.
   * 4. Satuan Pcs atau Lusin (1 lusin = 12 pcs). Total pcs harus kelipatan satuan; jika tidak lempar UNIT_MISMATCH ("Kurang X pcs").
   * 5. Anggota diubah ke status GROUPED & parent_group_id terisi.
   * 6. Header didaftarkan juga di product_serials sebagai is_group = 1 status AVAILABLE.
   * 7. Ledger TIDAK bergerak saat create/ungroup.
   */
  createSerialGroupsBatch(
    context: ActiveSecurityContext,
    input: CreateSerialGroupsBatchInput
  ): { createdGroups: SerialGroupingRecord[] } {
    this.assertContext(context, input.warehouseId);

    if (!input.groups || input.groups.length === 0) {
      throw new AppError("ERR_VALIDATION", "Daftar grouping tidak boleh kosong.", 400);
    }

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const allBatchSerialIds = new Set<string>();
      const createdGroups: SerialGroupingRecord[] = [];

      for (let gIdx = 0; gIdx < input.groups.length; gIdx++) {
        const item = input.groups[gIdx];
        const gLabel = `Baris ke-${gIdx + 1}`;

        if (!item.serialIds || item.serialIds.length < 2) {
          throw new AppError(
            "ERR_VALIDATION",
            `${gLabel}: Minimal 2 nomor seri untuk digabungkan menjadi group.`,
            400
          );
        }

        // Cek duplikasi di batch
        for (const sId of item.serialIds) {
          if (allBatchSerialIds.has(sId)) {
            throw new AppError(
              "ERR_CONFLICT",
              `${gLabel}: Nomor seri '${sId}' dipilih lebih dari satu kali dalam batch grouping.`,
              409
            );
          }
          allBatchSerialIds.add(sId);
        }

        // Ambil data detail serial anggota
        const memberSerials: Array<{
          id: string;
          owner_id: string;
          warehouse_id: string;
          product_id: string;
          serial_number: string;
          status: string;
          is_group: number;
          parent_group_id: string | null;
          base_quantity: number;
          product_name: string;
          sku: string;
        }> = [];

        for (const sId of item.serialIds) {
          const row = this.db.prepare(`
            SELECT ps.id, ps.owner_id, ps.warehouse_id, ps.product_id,
                   ps.serial_number, ps.status, ps.is_group, ps.parent_group_id,
                   ps.unit, ps.unit_quantity, ps.base_quantity, p.name AS product_name, p.sku
            FROM product_serials ps
            JOIN products p ON p.id = ps.product_id
            WHERE ps.id = ? AND ps.owner_id = ?
          `).get(sId, context.ownerId) as (typeof memberSerials)[0] | undefined;

          if (!row) {
            throw new AppError(
              "ERR_NOT_FOUND",
              `${gLabel}: Nomor seri '${sId}' tidak ditemukan di sistem.`,
              404
            );
          }

          if (row.warehouse_id !== input.warehouseId) {
            throw new AppError(
              "ERR_FORBIDDEN_WAREHOUSE",
              `${gLabel}: Nomor seri '${row.serial_number}' berada di gudang lain. Seluruh nomor seri dalam group wajib berasal dari gudang yang sama.`,
              403
            );
          }

          if (row.is_group === 1) {
            throw new AppError(
              "ERR_CONFLICT",
              `${gLabel}: Nomor seri '${row.serial_number}' adalah group. Group bertingkat (nested) tidak diperbolehkan.`,
              409
            );
          }

          if (row.status === "GROUPED" || row.parent_group_id) {
            throw new AppError(
              "ERR_CONFLICT",
              `${gLabel}: Nomor seri '${row.serial_number}' sudah menjadi anggota group lain.`,
              409
            );
          }

          if (row.status !== "AVAILABLE") {
            throw new AppError(
              "ERR_CONFLICT",
              `${gLabel}: Nomor seri '${row.serial_number}' tidak berstatus AVAILABLE (status: ${row.status}).`,
              409
            );
          }

          memberSerials.push(row);
        }

        // Hitung total base qty dalam PCS berdasarkan base_quantity masing-masing serial
        const totalBaseQtyPcs = memberSerials.reduce((sum, m) => {
          const uQty = Number((m as any).unit_quantity || 1);
          const bQty = Number(m.base_quantity) > 0 ? Number(m.base_quantity) : uQty * getUnitMultiplier((m as any).unit || "pcs");
          return sum + bQty;
        }, 0);

        // Validasi aturan kelipatan satuan
        const targetUnit = item.unit === "lusin" ? "lusin" : "pcs";
        const unitMultiplier = targetUnit === "lusin" ? 12 : 1;

        if (totalBaseQtyPcs % unitMultiplier !== 0) {
          const remainder = totalBaseQtyPcs % unitMultiplier;
          const kurangPcs = unitMultiplier - remainder;
          throw new AppError(
            "UNIT_MISMATCH",
            `${gLabel}: Total kuantitas (${totalBaseQtyPcs} pcs) tidak pas dengan satuan '${targetUnit}'. Kurang ${kurangPcs} pcs.`,
            400,
            { totalBaseQtyPcs, targetUnit, kurangPcs }
          );
        }

        const calculatedUnitQty = totalBaseQtyPcs / unitMultiplier;

        // Evaluasi apakah single-product atau multi-product
        const distinctProductIds = Array.from(new Set(memberSerials.map((m) => m.product_id)));
        const isSingleProduct = distinctProductIds.length === 1;

        let finalProductName: string | null = null;
        let finalProductId: string | null = null;

        if (isSingleProduct) {
          finalProductId = distinctProductIds[0];
          finalProductName = memberSerials[0].product_name;
        } else {
          finalProductId = null;
          const trimmedName = item.groupName?.trim();
          if (!trimmedName) {
            throw new AppError(
              "ERR_VALIDATION",
              `${gLabel}: Group lintas produk (>1 macam produk) WAJIB mengisi nama group secara manual.`,
              400
            );
          }
          finalProductName = trimmedName;
        }

        const groupingId = crypto.randomUUID();
        const groupNumber = this.getNextGroupNumber(context.ownerId, input.warehouseId);

        // 1. Simpan Header serial_groupings
        this.db.prepare(`
          INSERT INTO serial_groupings (
            id, owner_id, warehouse_id, group_number, group_name, product_id,
            unit, unit_qty, total_base_qty_pcs, status, notes, created_by,
            created_at, dissolved_by, dissolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, NULL, NULL)
        `).run(
          groupingId,
          context.ownerId,
          input.warehouseId,
          groupNumber,
          finalProductName,
          finalProductId,
          targetUnit,
          calculatedUnitQty,
          totalBaseQtyPcs,
          item.notes?.trim() || null,
          context.userId,
          now
        );

        // 2. Daftarkan header group sebagai entri baru di product_serials agar bisa di-scan/dipilih saat Goods Out
        // Jika single product, pakai product_id tersebut. Jika campur, kaitkan ke produk pertama sebagai anchor fisik
        const anchorProductId = finalProductId || memberSerials[0].product_id;
        const groupSerialId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO product_serials (
            id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
            status, unit, unit_quantity, base_quantity, is_group, parent_group_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, 1, NULL, ?, ?)
        `).run(
          groupSerialId,
          context.ownerId,
          input.warehouseId,
          anchorProductId,
          groupNumber,
          groupNumber,
          targetUnit,
          calculatedUnitQty,
          totalBaseQtyPcs,
          now,
          now
        );

        // 3. Simpan detail komponen & perbarui status anggota menjadi GROUPED
        for (const m of memberSerials) {
          const compId = crypto.randomUUID();
          const uQty = Number((m as any).unit_quantity || 1);
          const bQty = Number(m.base_quantity) > 0 ? Number(m.base_quantity) : uQty * getUnitMultiplier((m as any).unit || "pcs");
          this.db.prepare(`
            INSERT INTO serial_grouping_components (
              id, grouping_id, serial_id, product_id, snapshot_product_name,
              snapshot_sku, base_qty_pcs, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            compId,
            groupingId,
            m.id,
            m.product_id,
            m.product_name,
            m.sku,
            bQty,
            now
          );

          // Update status anggota
          this.db.prepare(`
            UPDATE product_serials
            SET status = 'GROUPED', parent_group_id = ?, updated_at = ?
            WHERE id = ?
          `).run(groupingId, now, m.id);
        }

        createdGroups.push({
          id: groupingId,
          ownerId: context.ownerId,
          warehouseId: input.warehouseId,
          groupNumber,
          groupName: finalProductName,
          productId: finalProductId,
          unit: targetUnit,
          unitQuantity: calculatedUnitQty,
          totalBaseQtyPcs,
          status: "AVAILABLE",
          notes: item.notes?.trim() || null,
          createdBy: context.userId,
          createdAt: now,
          dissolvedBy: null,
          dissolvedAt: null,
        });

        // Audit log per group
        this.recordAudit(
          context.ownerId,
          input.warehouseId,
          context.userId,
          "CREATE_SERIAL_GROUP",
          "SERIAL_GROUP",
          groupingId,
          {
            groupNumber,
            groupName: finalProductName,
            memberCount: memberSerials.length,
            totalBaseQtyPcs,
            unit: targetUnit,
          }
        );
      }

      return { createdGroups };
    });
  }

  /**
   * Service: dissolveGrouping (Ungroup Serial)
   * Aturan:
   * - Status AVAILABLE: Boleh. Group jadi DISSOLVED, anggota AVAILABLE, parent_group_id null.
   * - Status RESERVED: Ditolak / diblokir: "Keluarkan dulu dari dokumen DO-xxx".
   * - Status CONSUMED_OUT: Ditolak (hanya lewat retur).
   * - Ledger TIDAK bergerak saat ungroup.
   */
  dissolveGrouping(
    context: ActiveSecurityContext,
    groupingId: string,
    notes?: string
  ): { dissolved: boolean; groupNumber: string; restoredCount: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      const grp = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, group_number, status
        FROM serial_groupings
        WHERE id = ? AND owner_id = ?
      `).get(groupingId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        group_number: string;
        status: string;
      } | undefined;

      if (!grp) {
        throw new AppError("ERR_NOT_FOUND", "Data Grouping Serial tidak ditemukan.", 404);
      }

      this.assertContext(context, grp.warehouse_id);

      if (grp.status === "DISSOLVED") {
        throw new AppError("ERR_CONFLICT", `Group '${grp.group_number}' sudah pernah dibongkar (DISSOLVED).`, 409);
      }

      if (grp.status === "RESERVED") {
        // Cari dokumen DO yang sedang mereservasi group ini
        const activeRes = this.db.prepare(`
          SELECT go.document_number
          FROM reservations r
          JOIN goods_out go ON go.id = r.goods_out_id
          JOIN product_serials ps ON ps.id = r.product_id OR r.serial_ids_json LIKE '%' || ps.id || '%'
          WHERE ps.serial_number = ? AND r.status = 'ACTIVE'
          LIMIT 1
        `).get(grp.group_number) as { document_number: string } | undefined;

        const docRef = activeRes?.document_number || "Goods Out";
        throw new AppError("ERR_CONFLICT", `Keluarkan dulu dari dokumen ${docRef}. Group berstatus RESERVED tidak dapat dibongkar.`, 409);
      }

      if (grp.status === "CONSUMED_OUT") {
        throw new AppError(
          "ERR_CONFLICT",
          `Group '${grp.group_number}' sudah keluar dari gudang (CONSUMED_OUT). Pembongkaran hanya dapat diproses melalui alur Retur.`,
          409
        );
      }

      if (grp.status !== "AVAILABLE") {
        throw new AppError("ERR_CONFLICT", `Hanya group berstatus AVAILABLE yang dapat dibongkar (status saat ini: ${grp.status}).`, 409);
      }

      // Ambil seluruh komponen serial
      const components = this.db.prepare(`
        SELECT serial_id FROM serial_grouping_components
        WHERE grouping_id = ?
      `).all(groupingId) as Array<{ serial_id: string }>;

      // 1. Kembalikan seluruh anggota serial ke status AVAILABLE & hapus parent_group_id
      for (const c of components) {
        this.db.prepare(`
          UPDATE product_serials
          SET status = 'AVAILABLE', parent_group_id = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, c.serial_id);
      }

      // 2. Update status header serial_groupings ke DISSOLVED
      this.db.prepare(`
        UPDATE serial_groupings
        SET status = 'DISSOLVED', dissolved_by = ?, dissolved_at = ?, notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(context.userId, now, notes?.trim() || null, groupingId);

      // 3. Update entri group di product_serials menjadi DECOMMISSIONED / CONSUMED_OUT agar tidak bisa di-scan lagi
      this.db.prepare(`
        UPDATE product_serials
        SET status = 'DECOMMISSIONED', updated_at = ?
        WHERE owner_id = ? AND serial_number = ? AND is_group = 1
      `).run(now, context.ownerId, grp.group_number);

      // 4. Audit Log
      this.recordAudit(
        context.ownerId,
        grp.warehouse_id,
        context.userId,
        "DISSOLVE_SERIAL_GROUP",
        "SERIAL_GROUP",
        groupingId,
        {
          groupNumber: grp.group_number,
          restoredCount: components.length,
          reason: notes || "Pembongkaran group manual oleh pengguna",
        }
      );

      return {
        dissolved: true,
        groupNumber: grp.group_number,
        restoredCount: components.length,
      };
    });
  }

  /**
   * Mengambil daftar riwayat Grouping Serial Number
   */
  getSerialGroupings(
    context: ActiveSecurityContext,
    filterWarehouseId?: string,
    statusFilter?: string
  ): SerialGroupingRecord[] {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT id, owner_id, warehouse_id, group_number, group_name, product_id,
             unit, unit_qty, total_base_qty_pcs, status, notes, created_by,
             created_at, dissolved_by, dissolved_at
      FROM serial_groupings
      WHERE owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (targetWh) {
      query += ` AND warehouse_id = ?`;
      params.push(targetWh);
    }

    if (statusFilter && statusFilter !== "ALL") {
      query += ` AND status = ?`;
      params.push(statusFilter);
    }

    query += ` ORDER BY created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      group_number: string;
      group_name: string | null;
      product_id: string | null;
      unit: string;
      unit_qty: number;
      total_base_qty_pcs: number;
      status: string;
      notes: string | null;
      created_by: string;
      created_at: string;
      dissolved_by: string | null;
      dissolved_at: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      groupNumber: r.group_number,
      groupName: r.group_name,
      productId: r.product_id,
      unit: r.unit as "pcs" | "lusin",
      unitQuantity: Number(r.unit_qty),
      totalBaseQtyPcs: Number(r.total_base_qty_pcs),
      status: r.status as SerialGroupingStatus,
      notes: r.notes,
      createdBy: r.created_by,
      createdAt: r.created_at,
      dissolvedBy: r.dissolved_by,
      dissolvedAt: r.dissolved_at,
    }));
  }

  /**
   * Mengambil detail lengkap suatu group termasuk komponen di dalamnya
   */
  getSerialGroupDetail(
    context: ActiveSecurityContext,
    groupingId: string
  ): SerialGroupDetailResult | null {
    this.assertContext(context);

    const grp = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, group_number, group_name, product_id,
             unit, unit_qty, total_base_qty_pcs, status, notes, created_by,
             created_at, dissolved_by, dissolved_at
      FROM serial_groupings
      WHERE id = ? AND owner_id = ?
    `).get(groupingId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      group_number: string;
      group_name: string | null;
      product_id: string | null;
      unit: string;
      unit_qty: number;
      total_base_qty_pcs: number;
      status: string;
      notes: string | null;
      created_by: string;
      created_at: string;
      dissolved_by: string | null;
      dissolved_at: string | null;
    } | undefined;

    if (!grp) return null;

    const components = this.db.prepare(`
      SELECT sgc.id, sgc.serial_id, sgc.product_id, sgc.snapshot_product_name,
             sgc.snapshot_sku, sgc.base_qty_pcs, ps.serial_number, ps.unit, ps.unit_quantity
      FROM serial_grouping_components sgc
      JOIN product_serials ps ON ps.id = sgc.serial_id
      WHERE sgc.grouping_id = ?
      ORDER BY sgc.created_at ASC
    `).all(groupingId) as Array<{
      id: string;
      serial_id: string;
      product_id: string;
      snapshot_product_name: string;
      snapshot_sku: string;
      base_qty_pcs: number;
      serial_number: string;
      unit: string;
      unit_quantity: number;
    }>;

    return {
      group: {
        id: grp.id,
        ownerId: grp.owner_id,
        warehouseId: grp.warehouse_id,
        groupNumber: grp.group_number,
        groupName: grp.group_name,
        productId: grp.product_id,
        unit: grp.unit as "pcs" | "lusin",
        unitQuantity: Number(grp.unit_qty),
        totalBaseQtyPcs: Number(grp.total_base_qty_pcs),
        status: grp.status as SerialGroupingStatus,
        notes: grp.notes,
        createdBy: grp.created_by,
        createdAt: grp.created_at,
        dissolvedBy: grp.dissolved_by,
        dissolvedAt: grp.dissolved_at,
      },
      components: components.map((c) => ({
        id: c.id,
        serialId: c.serial_id,
        serialNumber: c.serial_number,
        productId: c.product_id,
        productName: c.snapshot_product_name,
        sku: c.snapshot_sku,
        baseQtyPcs: Number(c.base_qty_pcs),
        unit: c.unit || "pcs",
        unitQuantity: Number(c.unit_quantity || 1),
      })),
    };
  }

  /**
   * Helper: Resolusi pemindaian barcode Group untuk Goods Out
   * Scan barcode group: validasi AVAILABLE, owner/gudang cocok.
   * Mengembalikan rincian pemecahan baris per produk (qty = jumlah base_qty_pcs per produk).
   */
  resolveGroupForGoodsOut(
    context: ActiveSecurityContext,
    groupNumber: string,
    warehouseId: string
  ): {
    group: SerialGroupingRecord;
    lines: Array<{
      productId: string;
      productName: string;
      sku: string;
      unit: string;
      quantity: number;
      serials: string[];
      groupId: string;
      groupSerialsSnapshotJson: string;
    }>;
  } {
    this.assertContext(context, warehouseId);

    const grp = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, group_number, group_name, product_id,
             unit, unit_qty, total_base_qty_pcs, status, notes, created_by, created_at
      FROM serial_groupings
      WHERE owner_id = ? AND warehouse_id = ? AND group_number = ?
    `).get(context.ownerId, warehouseId, groupNumber.trim()) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      group_number: string;
      group_name: string | null;
      product_id: string | null;
      unit: string;
      unit_qty: number;
      total_base_qty_pcs: number;
      status: string;
      notes: string | null;
      created_by: string;
      created_at: string;
    } | undefined;

    if (!grp) {
      throw new AppError("ERR_NOT_FOUND", `Group Serial '${groupNumber}' tidak ditemukan di gudang ini.`, 404);
    }

    if (grp.status !== "AVAILABLE") {
      throw new AppError("ERR_CONFLICT", `Group Serial '${groupNumber}' tidak dapat dikeluarkan (status: ${grp.status}).`, 409);
    }

    const components = this.db.prepare(`
      SELECT sgc.serial_id, sgc.product_id, sgc.snapshot_product_name,
             sgc.snapshot_sku, sgc.base_qty_pcs, ps.serial_number, p.unit
      FROM serial_grouping_components sgc
      JOIN product_serials ps ON ps.id = sgc.serial_id
      JOIN products p ON p.id = sgc.product_id
      WHERE sgc.grouping_id = ?
    `).all(grp.id) as Array<{
      serial_id: string;
      product_id: string;
      snapshot_product_name: string;
      snapshot_sku: string;
      base_qty_pcs: number;
      serial_number: string;
      unit: string;
    }>;

    // Kelompokkan per produk
    const productMap = new Map<string, {
      productId: string;
      productName: string;
      sku: string;
      unit: string;
      quantity: number;
      serials: string[];
    }>();

    for (const c of components) {
      const existing = productMap.get(c.product_id);
      if (existing) {
        existing.quantity += Number(c.base_qty_pcs);
        existing.serials.push(c.serial_number);
      } else {
        productMap.set(c.product_id, {
          productId: c.product_id,
          productName: c.snapshot_product_name,
          sku: c.snapshot_sku,
          unit: "pcs", // kuantitas dasar selalu pcs
          quantity: Number(c.base_qty_pcs),
          serials: [c.serial_number],
        });
      }
    }

    const allSerialIds = components.map((c) => c.serial_id);
    const snapshotJson = JSON.stringify(allSerialIds);

    const lines = Array.from(productMap.values()).map((p) => ({
      ...p,
      groupId: grp.id,
      groupSerialsSnapshotJson: snapshotJson,
    }));

    return {
      group: {
        id: grp.id,
        ownerId: grp.owner_id,
        warehouseId: grp.warehouse_id,
        groupNumber: grp.group_number,
        groupName: grp.group_name,
        productId: grp.product_id,
        unit: grp.unit as "pcs" | "lusin",
        unitQuantity: Number(grp.unit_qty),
        totalBaseQtyPcs: Number(grp.total_base_qty_pcs),
        status: grp.status as SerialGroupingStatus,
        notes: grp.notes,
        createdBy: grp.created_by,
        createdAt: grp.created_at,
      },
      lines,
    };
  }
  private assertContext(
    context: ActiveSecurityContext,
    targetWarehouseId?: string
  ): void {
    if (!context || !context.ownerId) {
      throw new AppError("ERR_UNAUTHORIZED", "Konteks Owner tidak sah atau belum ditentukan.", 401);
    }

    if (targetWarehouseId) {
      // Pastikan gudang tersebut benar-benar milik owner aktif (mencegah manipulasi ID gudang lintas-owner)
      const wh = this.db.prepare(`
        SELECT id, owner_id FROM warehouses WHERE id = ?
      `).get(targetWarehouseId) as { id: string; owner_id: string } | undefined;

      if (!wh || wh.owner_id !== context.ownerId) {
        throw new AppError(
          "ERR_FORBIDDEN_WAREHOUSE",
          `Gudang '${targetWarehouseId}' bukan milik Owner aktif (${context.ownerId}).`,
          403
        );
      }
    }

    // Jika user adalah STAFF/SALES, pastikan target gudang sesuai dengan penugasan
    if (targetWarehouseId && (context.role === "STAFF" || context.role === "SALES")) {
      if (context.warehouseId !== targetWarehouseId) {
        throw new AppError(
          "ERR_FORBIDDEN_WAREHOUSE",
          `Pengguna tidak memiliki wewenang untuk mengakses gudang '${targetWarehouseId}'.`,
          403
        );
      }
    }
  }

  /**
   * Mengambil daftar produk terisolasi per-Owner dengan rekonsiliasi saldo ledger
   */
  getProductsByOwner(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): ProductRecord[] {
    this.assertContext(context, filterWarehouseId);

    const warehouseIdToQuery = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT p.id, p.owner_id, p.warehouse_id, p.sku, p.name, p.barcode,
             p.category, p.tracking_mode, p.unit, p.min_stock, p.description,
             p.status, p.created_at, p.updated_at
      FROM products p
      WHERE p.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (warehouseIdToQuery) {
      query += ` AND p.warehouse_id = ?`;
      params.push(warehouseIdToQuery);
    }

    query += ` ORDER BY p.name ASC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      sku: string;
      name: string;
      barcode: string | null;
      category: string;
      tracking_mode: "SERIAL" | "NON_SERIAL";
      unit: string;
      min_stock: number;
      description: string | null;
      status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => {
      const balance = this.calculateStockBalance(context.ownerId, r.warehouse_id, r.id);

      // Hitung stok mandiri vs stok tergroup (GROUPED) jika barang bertipe SERIAL
      let groupedStock = 0;
      let availableStandaloneStock = balance.availableStock;

      if (r.tracking_mode === "SERIAL") {
        const grpRow = this.db.prepare(`
          SELECT COALESCE(SUM(base_quantity), 0) AS grouped_qty
          FROM product_serials
          WHERE owner_id = ? AND warehouse_id = ? AND product_id = ? AND status = 'GROUPED'
        `).get(context.ownerId, r.warehouse_id, r.id) as { grouped_qty: number };

        groupedStock = Number(grpRow?.grouped_qty || 0);

        const standaloneRow = this.db.prepare(`
          SELECT COALESCE(SUM(base_quantity), 0) AS standalone_qty
          FROM product_serials
          WHERE owner_id = ? AND warehouse_id = ? AND product_id = ? AND status = 'AVAILABLE' AND (is_group = 0 OR is_group IS NULL)
        `).get(context.ownerId, r.warehouse_id, r.id) as { standalone_qty: number };

        availableStandaloneStock = Number(standaloneRow?.standalone_qty || 0);
      }

      return {
        id: r.id,
        ownerId: r.owner_id,
        warehouseId: r.warehouse_id,
        sku: r.sku,
        name: r.name,
        barcode: r.barcode,
        category: r.category,
        trackingMode: r.tracking_mode,
        unit: r.unit,
        minStock: Number(r.min_stock),
        description: r.description,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        physicalStock: balance.physicalStock,
        reservedStock: balance.reservedStock,
        availableStock: balance.availableStock,
        availableStandaloneStock,
        groupedStock,
      };
    });
  }

  /**
   * Menghitung saldo fisik dan reservasi secara deterministik dari database
   */
  calculateStockBalance(
    ownerId: string,
    warehouseId: string,
    productId: string
  ): ReconstructedStockBalance {
    // 1. Ambil seluruh pergerakan ledger untuk produk ini
    const ledgerRows = this.db.prepare(`
      SELECT id, sequence_number, owner_id, warehouse_id, product_id,
             entry_type, source_doc_type, source_doc_id, source_line_id,
             quantity_delta_base, actor_user_id, occurred_at, created_at
      FROM inventory_ledger
      WHERE owner_id = ? AND warehouse_id = ? AND product_id = ?
      ORDER BY sequence_number ASC
    `).all(ownerId, warehouseId, productId) as Array<{
      id: string;
      sequence_number: number;
      owner_id: string;
      warehouse_id: string;
      product_id: string;
      entry_type: string;
      source_doc_type: string;
      source_doc_id: string;
      source_line_id: string;
      quantity_delta_base: number;
      actor_user_id: string;
      occurred_at: string;
      created_at: string;
    }>;

    const ledgerEntries: LedgerEntry[] = ledgerRows.map((row) => ({
      id: row.id,
      sequenceNumber: row.sequence_number,
      ownerId: row.owner_id,
      warehouseId: row.warehouse_id,
      productId: row.product_id,
      locationId: null,
      entryType: row.entry_type as LedgerEntry["entryType"],
      sourceDocType: row.source_doc_type as LedgerEntry["sourceDocType"],
      sourceDocId: row.source_doc_id,
      sourceLineId: row.source_line_id,
      quantityDeltaBase: Number(row.quantity_delta_base),
      actorUserId: row.actor_user_id,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    }));

    // 2. Ambil seluruh reservasi aktif
    const resRows = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, product_id, goods_out_id,
             goods_out_line_id, reserved_base_qty, serial_ids_json,
             status, created_at
      FROM reservations
      WHERE owner_id = ? AND warehouse_id = ? AND product_id = ? AND status = 'ACTIVE'
    `).all(ownerId, warehouseId, productId) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      product_id: string;
      goods_out_id: string;
      goods_out_line_id: string;
      reserved_base_qty: number;
      serial_ids_json: string | null;
      status: "ACTIVE" | "RELEASED_COMPLETED" | "RELEASED_CANCELLED";
      created_at: string;
    }>;

    const activeReservations: ReservationEntry[] = resRows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      warehouseId: row.warehouse_id,
      productId: row.product_id,
      sourceDocType: "GOODS_OUT_PENDING",
      sourceDocId: row.goods_out_id,
      sourceLineId: row.goods_out_line_id,
      reservedBaseQty: Number(row.reserved_base_qty),
      serialIds: row.serial_ids_json ? JSON.parse(row.serial_ids_json) : undefined,
      status: row.status,
      createdAt: row.created_at,
      releasedAt: null,
    }));

    return reconstructStockBalance(
      ledgerEntries,
      activeReservations,
      ownerId,
      warehouseId,
      productId
    );
  }

  /**
   * Membuat produk baru dengan isolasi Owner dan Warehouse
   */
  createProduct(
    context: ActiveSecurityContext,
    input: CreateProductInput
  ): ProductRecord {
    this.assertContext(context, input.warehouseId);

    const trimmedName = (input.name || "").trim();
    if (!trimmedName) {
      throw new AppError("ERR_VALIDATION", "Nama produk wajib diisi.", 400);
    }

    const trimmedSku = (input.sku || "").trim().toUpperCase();
    if (!trimmedSku) {
      throw new AppError("ERR_VALIDATION", "SKU produk wajib diisi.", 400);
    }

    // Periksa keunikan SKU dalam cakupan Owner dan Gudang yang sama
    const existing = this.db.prepare(`
      SELECT id FROM products
      WHERE owner_id = ? AND warehouse_id = ? AND UPPER(sku) = ?
    `).get(context.ownerId, input.warehouseId, trimmedSku);

    if (existing) {
      throw new AppError(
        "ERR_CONFLICT",
        `SKU '${trimmedSku}' sudah digunakan di gudang ini. Harap gunakan SKU lain.`,
        409
      );
    }

    const now = new Date().toISOString();
    const productId = crypto.randomUUID();

    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO products (
          id, owner_id, warehouse_id, sku, name, barcode, category,
          tracking_mode, unit, min_stock, description, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `);

      insertStmt.run(
        productId,
        context.ownerId,
        input.warehouseId,
        trimmedSku,
        trimmedName,
        input.barcode ? input.barcode.trim() : null,
        (input.category || "General").trim(),
        input.trackingMode || "NON_SERIAL",
        input.unit ?? "pcs",
        input.minStock ?? 0,
        input.description ?? null,
        now,
        now
      );
    } catch (dbErr: unknown) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      if (msg.includes("UNIQUE constraint failed")) {
        throw new AppError(
          "ERR_CONFLICT",
          `SKU '${trimmedSku}' sudah digunakan di gudang ini. Harap gunakan SKU lain.`,
          409
        );
      }
      throw dbErr;
    }

    // Audit log
    this.recordAudit(
      context.ownerId,
      input.warehouseId,
      context.userId,
      "CREATE_PRODUCT",
      "PRODUCT",
      productId,
      { sku: input.sku, trackingMode: input.trackingMode }
    );

    return {
      id: productId,
      ownerId: context.ownerId,
      warehouseId: input.warehouseId,
      sku: input.sku.trim().toUpperCase(),
      name: input.name.trim(),
      barcode: input.barcode ?? null,
      category: input.category.trim(),
      trackingMode: input.trackingMode,
      unit: input.unit ?? "pcs",
      minStock: input.minStock ?? 0,
      description: input.description ?? null,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      physicalStock: 0,
      reservedStock: 0,
      availableStock: 0,
    };
  }

  /**
   * Mengupdate metadata produk (nama, barcode, kategori, min stock, status, deskripsi)
   */
  updateProduct(
    context: ActiveSecurityContext,
    input: UpdateProductInput
  ): ProductRecord {
    this.assertContext(context);

    const existing = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, sku, name, barcode, category,
             tracking_mode, unit, min_stock, description, status, created_at, updated_at
      FROM products
      WHERE id = ? AND owner_id = ?
    `).get(input.productId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      sku: string;
      name: string;
      barcode: string | null;
      category: string;
      tracking_mode: "SERIAL" | "NON_SERIAL";
      unit: string;
      min_stock: number;
      description: string | null;
      status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Produk tidak ditemukan atau akses ditolak.", 404);
    }

    const now = new Date().toISOString();
    const updatedName = input.name !== undefined ? input.name.trim() : existing.name;
    const updatedBarcode = input.barcode !== undefined ? (input.barcode ? input.barcode.trim() : null) : existing.barcode;
    const updatedCategory = input.category !== undefined ? input.category.trim() : existing.category;
    const updatedTrackingMode = input.trackingMode !== undefined ? input.trackingMode : existing.tracking_mode;
    const updatedMinStock = input.minStock !== undefined ? Math.max(0, Number(input.minStock)) : existing.min_stock;
    const updatedDescription = input.description !== undefined ? (input.description ? input.description.trim() : null) : existing.description;
    const updatedStatus = input.status !== undefined ? input.status : existing.status;

    this.db.prepare(`
      UPDATE products
      SET name = ?, barcode = ?, category = ?, tracking_mode = ?, min_stock = ?,
          description = ?, status = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(
      updatedName,
      updatedBarcode,
      updatedCategory,
      updatedTrackingMode,
      updatedMinStock,
      updatedDescription,
      updatedStatus,
      now,
      input.productId,
      context.ownerId
    );

    this.recordAudit(
      context.ownerId,
      existing.warehouse_id,
      context.userId,
      "UPDATE_PRODUCT",
      "PRODUCT",
      input.productId,
      {
        previous: { name: existing.name, status: existing.status, minStock: existing.min_stock },
        updated: { name: updatedName, status: updatedStatus, minStock: updatedMinStock }
      }
    );

    const balance = this.calculateStockBalance(context.ownerId, existing.warehouse_id, existing.id);

    return {
      id: existing.id,
      ownerId: existing.owner_id,
      warehouseId: existing.warehouse_id,
      sku: existing.sku,
      name: updatedName,
      barcode: updatedBarcode,
      category: updatedCategory,
      trackingMode: existing.tracking_mode,
      unit: existing.unit,
      minStock: updatedMinStock,
      description: updatedDescription,
      status: updatedStatus,
      createdAt: existing.created_at,
      updatedAt: now,
      physicalStock: balance.physicalStock,
      reservedStock: balance.reservedStock,
      availableStock: balance.availableStock,
    };
  }

  /**
   * Mencari atau membuat Supplier baru berdasarkan nama.
   * Digunakan saat user mengetik nama pemasok baru langsung di form transaksi barang masuk.
   */
  findOrCreateSupplierByName(
    context: ActiveSecurityContext,
    rawName: string
  ): { id: string; code: string; name: string; isNew: boolean } {
    this.assertContext(context);
    const trimmed = rawName.trim();
    if (!trimmed) {
      throw new AppError("ERR_VALIDATION", "Nama pemasok tidak boleh kosong.", 400);
    }

    // Bersihkan format "Nama Pemasok (SUP-XXX)" jika ada suffix kode di dalam kurung
    const cleanedName = trimmed.replace(/\s*\([A-Z0-9-]+\)$/i, "").trim() || trimmed;

    // Cek apakah supplier sudah ada berdasarkan nama (case-insensitive) atau kode
    const existing = this.db.prepare(`
      SELECT id, code, name FROM suppliers
      WHERE owner_id = ? AND (LOWER(TRIM(name)) = LOWER(?) OR LOWER(TRIM(code)) = LOWER(?))
      LIMIT 1
    `).get(context.ownerId, cleanedName, trimmed) as { id: string; code: string; name: string } | undefined;

    if (existing) {
      return { id: existing.id, code: existing.code, name: existing.name, isNew: false };
    }

    // Generate unique supplier code
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM suppliers WHERE owner_id = ?
    `).get(context.ownerId) as { count: number };

    let nextSeq = (countRow?.count ?? 0) + 1;
    let generatedCode = `SUP-${String(nextSeq).padStart(3, "0")}`;

    while (
      this.db.prepare(`SELECT 1 FROM suppliers WHERE owner_id = ? AND code = ?`).get(context.ownerId, generatedCode)
    ) {
      nextSeq++;
      generatedCode = `SUP-${String(nextSeq).padStart(3, "0")}`;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO suppliers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(id, context.ownerId, generatedCode, cleanedName, now, now);

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "CREATE_SUPPLIER_AUTO",
      "SUPPLIER",
      id,
      { code: generatedCode, name: cleanedName, source: "GOODS_IN_PENDING" }
    );

    return { id, code: generatedCode, name: cleanedName, isNew: true };
  }

  /**
   * Membuat transaksi Goods In dengan status PENDING (Draft Penerimaan).
   * Tidak mencatat ke inventory_ledger dan tidak mendaftarkan SN ke registry AVAILABLE.
   */
  createGoodsInPendingTransaction(
    context: ActiveSecurityContext,
    input: CreateGoodsInInput
  ): { goodsInId: string; supplierId?: string; newSupplier?: { id: string; code: string; name: string } } {
    this.assertContext(context, input.warehouseId);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const goodsInId = crypto.randomUUID();

      let resolvedSupplierId = input.supplierId ?? null;
      let newSupplierCreated: { id: string; code: string; name: string } | undefined = undefined;

      if (!resolvedSupplierId && input.supplierName && input.supplierName.trim()) {
        const foundOrCreated = this.findOrCreateSupplierByName(context, input.supplierName);
        resolvedSupplierId = foundOrCreated.id;
        if (foundOrCreated.isNew) {
          newSupplierCreated = {
            id: foundOrCreated.id,
            code: foundOrCreated.code,
            name: foundOrCreated.name,
          };
        }
      }

      this.db.prepare(`
        INSERT INTO goods_in (
          id, owner_id, warehouse_id, supplier_id, document_number,
          document_date, status, note, created_by_user_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
      `).run(
        goodsInId,
        context.ownerId,
        input.warehouseId,
        resolvedSupplierId,
        input.documentNumber.trim(),
        input.documentDate,
        input.note ?? null,
        context.userId,
        now,
        now
      );

      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas barang masuk harus lebih besar dari 0.", 400);
        }

        const prod = this.db.prepare(`
          SELECT id, tracking_mode FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.productId, context.ownerId, input.warehouseId) as {
          id: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
        } | undefined;

        if (!prod) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `Produk '${line.productId}' tidak ditemukan di gudang ini.`,
            404
          );
        }

        const lineId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO goods_in_lines (
            id, goods_in_id, product_id, quantity, unit,
            received_serials_json, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          goodsInId,
          line.productId,
          line.quantity,
          line.unit ?? "pcs",
          line.serials && line.serials.length > 0 ? JSON.stringify(line.serials) : null,
          line.note ?? null,
          now
        );
      }

      this.recordAudit(
        context.ownerId,
        input.warehouseId,
        context.userId,
        "CREATE_GOODS_IN_PENDING",
        "GOODS_IN",
        goodsInId,
        { documentNumber: input.documentNumber, totalLines: input.lines.length }
      );

      return { goodsInId, supplierId: resolvedSupplierId ?? undefined, newSupplier: newSupplierCreated };
    });
  }

  /**
   * Mengubah transaksi Goods In yang berstatus PENDING
   */
  updateGoodsInPendingTransaction(
    context: ActiveSecurityContext,
    input: UpdateGoodsInPendingInput
  ): { goodsInId: string; updatedLinesCount: number; supplierId?: string; newSupplier?: { id: string; code: string; name: string } } {
    this.assertContext(context);

    return this.db.transaction(() => {
      const gi = this.db.prepare(`
        SELECT id, document_number, warehouse_id, status FROM goods_in
        WHERE id = ? AND owner_id = ?
      `).get(input.goodsInId, context.ownerId) as {
        id: string;
        document_number: string;
        warehouse_id: string;
        status: string;
      } | undefined;

      if (!gi) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods In tidak ditemukan.", 404);
      }

      if (gi.status !== "PENDING") {
        throw new AppError("ERR_CONFLICT", `Hanya transaksi PENDING yang dapat diubah (status saat ini: '${gi.status}').`, 409);
      }

      let resolvedSupplierId = input.supplierId;
      let newSupplierCreated: { id: string; code: string; name: string } | undefined = undefined;

      if (!resolvedSupplierId && input.supplierName && input.supplierName.trim()) {
        const foundOrCreated = this.findOrCreateSupplierByName(context, input.supplierName);
        resolvedSupplierId = foundOrCreated.id;
        if (foundOrCreated.isNew) {
          newSupplierCreated = {
            id: foundOrCreated.id,
            code: foundOrCreated.code,
            name: foundOrCreated.name,
          };
        }
      }

      const now = new Date().toISOString();

      // Update header
      this.db.prepare(`
        UPDATE goods_in
        SET supplier_id = COALESCE(?, supplier_id),
            document_number = COALESCE(?, document_number),
            document_date = COALESCE(?, document_date),
            note = ?,
            updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        resolvedSupplierId ?? null,
        input.documentNumber?.trim() ?? null,
        input.documentDate ?? null,
        input.note ?? null,
        now,
        input.goodsInId,
        context.ownerId
      );

      // Hapus baris lama
      this.db.prepare(`DELETE FROM goods_in_lines WHERE goods_in_id = ?`).run(input.goodsInId);

      // Masukkan baris baru
      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas barang masuk harus lebih besar dari 0.", 400);
        }

        const prod = this.db.prepare(`
          SELECT id, tracking_mode FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.productId, context.ownerId, gi.warehouse_id) as {
          id: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
        } | undefined;

        if (!prod) {
          throw new AppError("ERR_NOT_FOUND", `Produk '${line.productId}' tidak ditemukan di gudang ini.`, 404);
        }

        const lineId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO goods_in_lines (
            id, goods_in_id, product_id, quantity, unit,
            received_serials_json, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          input.goodsInId,
          line.productId,
          line.quantity,
          line.unit ?? "pcs",
          line.serials && line.serials.length > 0 ? JSON.stringify(line.serials) : null,
          line.note ?? null,
          now
        );
      }

      this.recordAudit(
        context.ownerId,
        gi.warehouse_id,
        context.userId,
        "UPDATE_GOODS_IN_PENDING",
        "GOODS_IN",
        input.goodsInId,
        { documentNumber: gi.document_number, totalLines: input.lines.length }
      );

      return {
        goodsInId: input.goodsInId,
        updatedLinesCount: input.lines.length,
        supplierId: resolvedSupplierId ?? undefined,
        newSupplier: newSupplierCreated,
      };
    });
  }

  /**
   * Memposting Goods In yang berstatus PENDING menjadi POSTED secara atomik.
   * Mendaftarkan SN ke registry, mencatat ke inventory_ledger, dan mengubah status ke POSTED.
   */
  postPendingGoodsInTransaction(
    context: ActiveSecurityContext,
    goodsInId: string
  ): { goodsInId: string; ledgerEntriesCount: number } {
    this.assertContext(context);

    if (!goodsInId) {
      throw new AppError("ERR_VALIDATION", "ID dokumen Goods In wajib diberikan.", 400);
    }

    return this.db.transaction(() => {
      const now = new Date().toISOString();

      const gi = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, document_number, status
        FROM goods_in
        WHERE id = ? AND owner_id = ?
      `).get(goodsInId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        document_number: string;
        status: string;
      } | undefined;

      if (!gi) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods In tidak ditemukan atau akses ditolak.", 404);
      }

      if (gi.status !== "PENDING") {
        throw new AppError("ERR_CONFLICT", `Dokumen ini sudah berstatus ${gi.status} dan tidak dapat diposting lagi.`, 409);
      }

      const lines = this.db.prepare(`
        SELECT id, product_id, quantity, unit, received_serials_json
        FROM goods_in_lines
        WHERE goods_in_id = ?
      `).all(goodsInId) as Array<{
        id: string;
        product_id: string;
        quantity: number;
        unit: string;
        received_serials_json: string | null;
      }>;

      if (lines.length === 0) {
        throw new AppError("ERR_VALIDATION", "Dokumen Goods In tidak memiliki baris item untuk diposting.", 400);
      }

      const existingSerials = this.getAllActiveSerialsForOwner(context.ownerId);
      let ledgerEntriesCount = 0;

      for (const line of lines) {
        const prod = this.db.prepare(`
          SELECT id, tracking_mode FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.product_id, context.ownerId, gi.warehouse_id) as {
          id: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
        } | undefined;

        if (!prod) {
          throw new AppError("ERR_NOT_FOUND", `Produk '${line.product_id}' tidak ditemukan di gudang ini.`, 404);
        }

        const receivedSerials: string[] = [];
        const rawSerialsList: string[] = line.received_serials_json ? JSON.parse(line.received_serials_json) : [];

        const lineMultiplier = getUnitMultiplier(line.unit);
        // 1 SN mewakili 1 unit operasional sesuai satuan penerimaan Goods In (misal 5 lusin = 5 SN)
        const requiredSnCount = Math.round(Number(line.quantity));

        if (rawSerialsList.length > 0) {
          if (rawSerialsList.length > requiredSnCount) {
            throw new AppError(
              "ERR_VALIDATION",
              `Produk '${line.product_id}' maksimal membutuhkan ${requiredSnCount} Serial Number (diberikan: ${rawSerialsList.length}).`,
              400
            );
          }

          for (const rawSn of rawSerialsList) {
            const guardResult = evaluateCrossWarehouseSerialGuard(existingSerials, {
              ownerId: context.ownerId,
              warehouseId: gi.warehouse_id,
              serialNumber: rawSn,
            });

            if (!guardResult.isAllowed) {
              throw new AppError("ERR_CONFLICT", guardResult.errorMessage ?? "Konflik SN terdeteksi.", 409);
            }

            const snId = crypto.randomUUID();
            const normalizedSn = normalizeSerialNumber(rawSn);

            this.db.prepare(`
              INSERT INTO product_serials (
                id, owner_id, warehouse_id, product_id, serial_number,
                normalized_serial_number, status, unit, unit_quantity, base_quantity,
                source_goods_in_id, source_line_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 1, ?, ?, ?, ?, ?)
            `).run(
              snId,
              context.ownerId,
              gi.warehouse_id,
              line.product_id,
              rawSn.trim(),
              normalizedSn,
              line.unit ?? "pcs",
              lineMultiplier,
              goodsInId,
              line.id,
              now,
              now
            );

            receivedSerials.push(snId);

            existingSerials.push({
              serialId: snId,
              ownerId: context.ownerId,
              warehouseId: gi.warehouse_id,
              productId: line.product_id,
              serialNumberNormalized: normalizedSn,
              status: "AVAILABLE",
              registeredAt: now,
            });
          }
        }

        // Tulis entri ke inventory_ledger
        const nextSeq = this.getNextLedgerSequence(context.ownerId);
        const ledgerId = crypto.randomUUID();

        this.db.prepare(`
          INSERT INTO inventory_ledger (
            id, sequence_number, owner_id, warehouse_id, product_id,
            location_id, entry_type, source_doc_type, source_doc_id,
            source_line_id, quantity_delta_base, serial_ids_json,
            actor_user_id, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId,
          nextSeq,
          context.ownerId,
          gi.warehouse_id,
          line.product_id,
          goodsInId,
          line.id,
          Number(line.quantity) * getUnitMultiplier(line.unit),
          receivedSerials.length > 0 ? JSON.stringify(receivedSerials) : null,
          context.userId,
          now,
          now
        );

        ledgerEntriesCount++;
      }

      // Update status goods_in menjadi POSTED
      this.db.prepare(`
        UPDATE goods_in
        SET status = 'POSTED', posted_by_user_id = ?, posted_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(context.userId, now, now, goodsInId, context.ownerId);

      this.recordAudit(
        context.ownerId,
        gi.warehouse_id,
        context.userId,
        "POST_PENDING_GOODS_IN",
        "GOODS_IN",
        goodsInId,
        { documentNumber: gi.document_number, ledgerEntriesCount }
      );

      return { goodsInId, ledgerEntriesCount };
    });
  }

  /**
   * Menghapus transaksi Goods In (Khusus Owner).
   * Jika PENDING: Hapus draft penerimaan barang beserta barisnya.
   * Jika POSTED: Batalkan / hapus dari daftar dengan me-revert status dan mencatat jejak audit.
   */
  deleteGoodsInTransaction(
    context: ActiveSecurityContext,
    goodsInId: string
  ): { success: boolean; documentNumber: string } {
    this.assertContext(context);

    if (context.role !== "OWNER") {
      throw new AppError(
        "ERR_FORBIDDEN_ROLE",
        "Hanya pengguna dengan peran Owner yang diizinkan menghapus transaksi barang masuk.",
        403
      );
    }

    return this.db.transaction(() => {
      const gi = this.db
        .prepare(
          `
        SELECT id, document_number, status, warehouse_id
        FROM goods_in
        WHERE id = ? AND owner_id = ?
      `
        )
        .get(goodsInId, context.ownerId) as
        | {
            id: string;
            document_number: string;
            status: "PENDING" | "POSTED" | "CANCELLED";
            warehouse_id: string;
          }
        | undefined;

      if (!gi) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods In tidak ditemukan.", 404);
      }

      const now = new Date().toISOString();

      if (gi.status === "PENDING") {
        this.db.prepare("DELETE FROM goods_in_lines WHERE goods_in_id = ?").run(goodsInId);
        this.db.prepare("DELETE FROM goods_in WHERE id = ? AND owner_id = ?").run(goodsInId, context.ownerId);
      } else {
        this.db
          .prepare(
            `
          UPDATE goods_in
          SET status = 'CANCELLED', updated_at = ?
          WHERE id = ? AND owner_id = ?
        `
          )
          .run(now, goodsInId, context.ownerId);
      }

      this.recordAudit(
        context.ownerId,
        gi.warehouse_id,
        context.userId,
        "DELETE_GOODS_IN",
        "GOODS_IN",
        goodsInId,
        {
          documentNumber: gi.document_number,
          previousStatus: gi.status,
          deletedAt: now,
        }
      );

      return { success: true, documentNumber: gi.document_number };
    });
  }

  /**
   * Transaksi Atomik: Posting Goods In (Barang Masuk)
   * Mengupdate serial registry jika produk serial, mencatat immutable ledger, dan audit trail.
   */
  postGoodsInTransaction(
    context: ActiveSecurityContext,
    input: CreateGoodsInInput
  ): { goodsInId: string; ledgerEntriesCount: number } {
    this.assertContext(context, input.warehouseId);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const goodsInId = crypto.randomUUID();

      // 1. Simpan Header Goods In
      this.db.prepare(`
        INSERT INTO goods_in (
          id, owner_id, warehouse_id, supplier_id, document_number,
          document_date, status, note, created_by_user_id, posted_by_user_id,
          posted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?)
      `).run(
        goodsInId,
        context.ownerId,
        input.warehouseId,
        input.supplierId ?? null,
        input.documentNumber.trim(),
        input.documentDate,
        input.note ?? null,
        context.userId,
        context.userId,
        now,
        now,
        now
      );

      let ledgerEntriesCount = 0;

      // 2. Ambil snapshot serial yang aktif pada Owner ini untuk guard cross-warehouse
      const existingSerials = this.getAllActiveSerialsForOwner(context.ownerId);

      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas barang masuk harus lebih besar dari 0.", 400);
        }

        // Ambil info produk
        const prod = this.db.prepare(`
          SELECT id, tracking_mode FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.productId, context.ownerId, input.warehouseId) as {
          id: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
        } | undefined;

        if (!prod) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `Produk '${line.productId}' tidak ditemukan di gudang ini.`,
            404
          );
        }

        const lineId = crypto.randomUUID();
        const receivedSerials: string[] = [];

        const lineMultiplier = getUnitMultiplier(line.unit);
        // 1 SN mewakili 1 unit operasional sesuai satuan penerimaan Goods In (misal 5 lusin = 5 SN)
        const requiredSnCount = Math.round(Number(line.quantity));

        if (line.serials && line.serials.length > 0) {
          if (line.serials.length !== requiredSnCount) {
            throw new AppError(
              "ERR_VALIDATION",
              `Produk '${line.productId}' membutuhkan tepat ${requiredSnCount} Serial Number (diberikan: ${line.serials.length}).`,
              400
            );
          }
        }

        // 1. Simpan baris Goods In terlebih dahulu agar lineId valid sebagai Foreign Key
        this.db.prepare(`
          INSERT INTO goods_in_lines (
            id, goods_in_id, product_id, quantity, unit,
            received_serials_json, note, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          lineId,
          goodsInId,
          line.productId,
          line.quantity,
          line.unit ?? "pcs",
          line.note ?? null,
          now
        );

        if (line.serials && line.serials.length > 0) {
          for (const rawSn of line.serials) {
            const guardResult = evaluateCrossWarehouseSerialGuard(existingSerials, {
              ownerId: context.ownerId,
              warehouseId: input.warehouseId,
              serialNumber: rawSn,
            });

            if (!guardResult.isAllowed) {
              throw new AppError("ERR_CONFLICT", guardResult.errorMessage ?? "Konflik SN terdeteksi.", 409);
            }

            const snId = crypto.randomUUID();
            const normalizedSn = normalizeSerialNumber(rawSn);

            this.db.prepare(`
              INSERT INTO product_serials (
                id, owner_id, warehouse_id, product_id, serial_number,
                normalized_serial_number, status, unit, unit_quantity, base_quantity,
                source_goods_in_id, source_line_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 1, ?, ?, ?, ?, ?)
            `).run(
              snId,
              context.ownerId,
              input.warehouseId,
              line.productId,
              rawSn.trim(),
              normalizedSn,
              line.unit ?? "pcs",
              lineMultiplier,
              goodsInId,
              lineId,
              now,
              now
            );

            receivedSerials.push(snId);

            // Tambahkan ke in-memory snapshot serial yang baru ditambahkan
            existingSerials.push({
              serialId: snId,
              ownerId: context.ownerId,
              warehouseId: input.warehouseId,
              productId: line.productId,
              serialNumberNormalized: normalizedSn,
              status: "AVAILABLE",
              registeredAt: now,
            });
          }

          // Update received_serials_json jika serials didaftarkan
          if (receivedSerials.length > 0) {
            this.db.prepare(`
              UPDATE goods_in_lines SET received_serials_json = ? WHERE id = ?
            `).run(JSON.stringify(receivedSerials), lineId);

            // Pastikan produk di Master Produk berstatus tracking_mode = 'SERIAL'
            this.db.prepare(`
              UPDATE products
              SET tracking_mode = 'SERIAL', updated_at = ?
              WHERE id = ? AND owner_id = ? AND tracking_mode != 'SERIAL'
            `).run(now, line.productId, context.ownerId);
          }
        }

        // 3. Tulis Entri Immutable ke Inventory Ledger
        const nextSeq = this.getNextLedgerSequence(context.ownerId);
        const ledgerId = crypto.randomUUID();

        this.db.prepare(`
          INSERT INTO inventory_ledger (
            id, sequence_number, owner_id, warehouse_id, product_id,
            location_id, entry_type, source_doc_type, source_doc_id,
            source_line_id, quantity_delta_base, serial_ids_json,
            actor_user_id, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId,
          nextSeq,
          context.ownerId,
          input.warehouseId,
          line.productId,
          goodsInId,
          lineId,
          Number(line.quantity) * getUnitMultiplier(line.unit), // Positif dikonversi ke unit dasar
          receivedSerials.length > 0 ? JSON.stringify(receivedSerials) : null,
          context.userId,
          now,
          now
        );

        ledgerEntriesCount++;
      }

      // 4. Audit Log
      this.recordAudit(
        context.ownerId,
        input.warehouseId,
        context.userId,
        "POST_GOODS_IN",
        "GOODS_IN",
        goodsInId,
        { documentNumber: input.documentNumber, totalLines: input.lines.length }
      );

      return { goodsInId, ledgerEntriesCount };
    });
  }

  /**
   * Mengambil status registrasi Serial Number per baris untuk dokumen Goods In berstatus POSTED.
   * RPD & Revisi V2: SN merepresentasikan unit operasional sesuai satuan penerimaan (misal 5 lusin = 5 SN).
   */
  getGoodsInSerialsStatus(
    context: ActiveSecurityContext,
    goodsInId: string
  ): GoodsInSerialsStatusResult {
    this.assertContext(context);

    const gi = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, document_number, document_date, status
      FROM goods_in
      WHERE id = ? AND owner_id = ?
    `).get(goodsInId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      document_number: string;
      document_date: string;
      status: string;
    } | undefined;

    if (!gi) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen Goods In tidak ditemukan atau akses ditolak.", 404);
    }

    // Ambil seluruh baris item Goods In beserta info produk
    const lines = this.db.prepare(`
      SELECT gil.id, gil.product_id, gil.quantity, gil.unit,
             p.name AS product_name, p.sku, p.tracking_mode
      FROM goods_in_lines gil
      JOIN products p ON p.id = gil.product_id
      WHERE gil.goods_in_id = ?
      ORDER BY gil.created_at ASC
    `).all(goodsInId) as Array<{
      id: string;
      product_id: string;
      quantity: number;
      unit: string;
      product_name: string;
      sku: string;
      tracking_mode: string;
    }>;

    // Ambil seluruh SN yang terdaftar dengan source_goods_in_id = goodsInId
    const serialRows = this.db.prepare(`
      SELECT id, product_id, serial_number, unit, unit_quantity, base_quantity,
             status, source_line_id, created_at
      FROM product_serials
      WHERE owner_id = ? AND source_goods_in_id = ?
      ORDER BY created_at ASC
    `).all(context.ownerId, goodsInId) as Array<{
      id: string;
      product_id: string;
      serial_number: string;
      unit: string;
      unit_quantity: number;
      base_quantity: number;
      status: string;
      source_line_id: string | null;
      created_at: string;
    }>;

    const lineStatuses: GoodsInLineSerialStatus[] = lines.map((line) => {
      const mult = getUnitMultiplier(line.unit);
      const receivedQty = Number(line.quantity);
      // 1 SN mewakili 1 unit operasional sesuai satuan penerimaan
      const requiredUnits = Math.round(receivedQty);
      const totalBaseQuantity = receivedQty * mult;

      const serialsForLine = serialRows
        .filter((s) => s.source_line_id === line.id || (!s.source_line_id && s.product_id === line.product_id))
        .map((s) => ({
          id: s.id,
          serialNumber: s.serial_number,
          unit: s.unit || line.unit,
          unitQuantity: Number(s.unit_quantity || 1),
          baseQuantity: Number(s.base_quantity || mult),
          status: s.status,
          createdAt: s.created_at,
        }));

      const registeredCount = serialsForLine.length;
      const remainingCount = Math.max(0, requiredUnits - registeredCount);

      let status: GoodsInLineSerialStatus["status"] = "BELUM_DIREGISTRASIKAN";
      if (registeredCount >= requiredUnits && requiredUnits > 0) {
        status = "LENGKAP";
      } else if (registeredCount > 0) {
        status = "SEBAGIAN_DIREGISTRASIKAN";
      }

      return {
        lineId: line.id,
        productId: line.product_id,
        productName: line.product_name,
        sku: line.sku,
        warehouseId: gi.warehouse_id,
        receivedQuantity: receivedQty,
        unit: line.unit,
        conversionMultiplier: mult,
        totalBaseQuantity,
        requiredUnits,
        registeredCount,
        remainingCount,
        status,
        serials: serialsForLine,
      };
    });

    return {
      goodsInId: gi.id,
      documentNumber: gi.document_number,
      documentDate: gi.document_date,
      status: gi.status,
      warehouseId: gi.warehouse_id,
      lines: lineStatuses,
    };
  }

  /**
   * Mendaftarkan Serial Number untuk unit yang diterima pada baris Goods In yang sudah berstatus POSTED.
   * Aturan Penting V2.4.1:
   * 1. 1 SN = 1 unit operasional sesuai satuan penerimaan (misal 5 lusin = butuh 5 SN, tiap SN mewakili 1 lusin).
   * 2. Idempoten: SN yang sudah terdaftar pada baris ini tidak diduplikasi.
   * 3. TIDAK MENULIS ke inventory_ledger untuk mencegah double-counting stok (karena stok sudah dicatat saat Goods In POSTED).
   * 4. Menolak pendaftaran jika dokumen belum POSTED (misal PENDING).
   */
  registerGoodsInSerials(
    context: ActiveSecurityContext,
    input: RegisterGoodsInSerialsInput
  ): { registeredCount: number; totalRegistered: number; remainingCount: number; status: string } {
    this.assertContext(context);

    if (!input.goodsInId || !input.lineId) {
      throw new AppError("ERR_VALIDATION", "ID Goods In dan ID baris penerimaan wajib diberikan.", 400);
    }

    if (!input.serialNumbers || !Array.isArray(input.serialNumbers) || input.serialNumbers.length === 0) {
      throw new AppError("ERR_VALIDATION", "Daftar Serial Number yang akan didaftarkan tidak boleh kosong.", 400);
    }

    return this.db.transaction(() => {
      const now = new Date().toISOString();

      // 1. Ambil dokumen Goods In
      const gi = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, document_number, status
        FROM goods_in
        WHERE id = ? AND owner_id = ?
      `).get(input.goodsInId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        document_number: string;
        status: string;
      } | undefined;

      if (!gi) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods In tidak ditemukan atau akses ditolak.", 404);
      }

      // Validasi status: Harus sudah berstatus final (POSTED)!
      if (gi.status !== "POSTED") {
        throw new AppError(
          "ERR_CONFLICT",
          `Serial Number hanya dapat didaftarkan pada dokumen yang sudah berstatus lengkap/final (POSTED). Status saat ini: ${gi.status}.`,
          409
        );
      }

      // 2. Ambil baris Goods In
      const line = this.db.prepare(`
        SELECT id, product_id, quantity, unit
        FROM goods_in_lines
        WHERE id = ? AND goods_in_id = ?
      `).get(input.lineId, input.goodsInId) as {
        id: string;
        product_id: string;
        quantity: number;
        unit: string;
      } | undefined;

      if (!line) {
        throw new AppError("ERR_NOT_FOUND", "Baris penerimaan Goods In tidak ditemukan.", 404);
      }

      const mult = getUnitMultiplier(line.unit);
      const requiredUnits = Math.round(Number(line.quantity));

      // 3. Ambil serial yang SUDAH terdaftar untuk baris ini
      const existingLineSerials = this.db.prepare(`
        SELECT id, serial_number, normalized_serial_number
        FROM product_serials
        WHERE owner_id = ? AND source_line_id = ?
      `).all(context.ownerId, input.lineId) as Array<{
        id: string;
        serial_number: string;
        normalized_serial_number: string;
      }>;

      const existingNormalizedSet = new Set(existingLineSerials.map((s) => s.normalized_serial_number));
      const existingAllActive = this.getAllActiveSerialsForOwner(context.ownerId);

      // Filter input serial: buang kosong dan duplikat input
      const sanitizedInputs: string[] = [];
      const seenInBatch = new Set<string>();

      for (const raw of input.serialNumbers) {
        const clean = raw.trim();
        if (!clean) continue;
        const norm = normalizeSerialNumber(clean);
        // Jika sudah ada di baris ini, abaikan (idempoten)
        if (existingNormalizedSet.has(norm)) continue;
        if (seenInBatch.has(norm)) continue;
        seenInBatch.add(norm);
        sanitizedInputs.push(clean);
      }

      // Cek apakah penambahan ini melampaui kuota unit yang dibutuhkan
      const remainingQuota = requiredUnits - existingLineSerials.length;
      if (sanitizedInputs.length > remainingQuota) {
        throw new AppError(
          "ERR_VALIDATION",
          `Jumlah Serial Number baru (${sanitizedInputs.length}) melebihi sisa unit yang dapat didaftarkan (${remainingQuota}). Dibutuhkan: ${requiredUnits}, Sudah terdaftar: ${existingLineSerials.length}.`,
          400
        );
      }

      let newRegisteredCount = 0;

      // 4. Daftarkan SN baru ke product_serials
      for (const rawSn of sanitizedInputs) {
        const guardResult = evaluateCrossWarehouseSerialGuard(existingAllActive, {
          ownerId: context.ownerId,
          warehouseId: gi.warehouse_id,
          serialNumber: rawSn,
        });

        if (!guardResult.isAllowed) {
          throw new AppError("ERR_CONFLICT", guardResult.errorMessage ?? `Serial Number '${rawSn}' konflik.`, 409);
        }

        const snId = crypto.randomUUID();
        const normSn = normalizeSerialNumber(rawSn);

        this.db.prepare(`
          INSERT INTO product_serials (
            id, owner_id, warehouse_id, product_id, serial_number,
            normalized_serial_number, status, unit, unit_quantity, base_quantity,
            source_goods_in_id, source_line_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 1, ?, ?, ?, ?, ?)
        `).run(
          snId,
          context.ownerId,
          gi.warehouse_id,
          line.product_id,
          rawSn.trim(),
          normSn,
          line.unit ?? "pcs",
          mult,
          input.goodsInId,
          input.lineId,
          now,
          now
        );

        existingAllActive.push({
          serialId: snId,
          ownerId: context.ownerId,
          warehouseId: gi.warehouse_id,
          productId: line.product_id,
          serialNumberNormalized: normSn,
          status: "AVAILABLE",
          registeredAt: now,
        });

        newRegisteredCount++;
      }

      if (newRegisteredCount > 0) {
        // Pastikan produk di Master Produk otomatis berstatus tracking_mode = 'SERIAL'
        this.db.prepare(`
          UPDATE products
          SET tracking_mode = 'SERIAL', updated_at = ?
          WHERE id = ? AND owner_id = ? AND tracking_mode != 'SERIAL'
        `).run(now, line.product_id, context.ownerId);
      }

      const totalRegistered = existingLineSerials.length + newRegisteredCount;
      const finalRemaining = Math.max(0, requiredUnits - totalRegistered);
      let statusStr = "BELUM_DIREGISTRASIKAN";
      if (totalRegistered >= requiredUnits && requiredUnits > 0) {
        statusStr = "LENGKAP";
      } else if (totalRegistered > 0) {
        statusStr = "SEBAGIAN_DIREGISTRASIKAN";
      }

      this.recordAudit(
        context.ownerId,
        gi.warehouse_id,
        context.userId,
        "REGISTER_GOODS_IN_SERIALS",
        "GOODS_IN",
        input.goodsInId,
        {
          lineId: input.lineId,
          productId: line.product_id,
          unit: line.unit,
          baseQuantityPerUnit: mult,
          newRegisteredCount,
          totalRegistered,
          requiredUnits,
          status: statusStr,
        }
      );

      return {
        registeredCount: newRegisteredCount,
        totalRegistered,
        remainingCount: finalRemaining,
        status: statusStr,
      };
    });
  }

  /**
   * Mengambil serial number yang AVAILABLE untuk produk tertentu di gudang aktif
   * Menyertakan informasi satuan operasional dan kuantitas dasar yang diwakilinya.
   */
  getAvailableSerialsByProduct(
    context: ActiveSecurityContext,
    productId: string,
    warehouseId?: string
  ): AvailableSerialItem[] {
    this.assertContext(context, warehouseId);
    let targetWhId: string | null = warehouseId ?? context.warehouseId ?? null;
    if (targetWhId) {
      const whExists = this.db.prepare("SELECT id FROM warehouses WHERE id = ? AND owner_id = ?").get(targetWhId, context.ownerId);
      if (!whExists) targetWhId = null;
    }

    const rows = this.db.prepare(`
      SELECT ps.id, ps.product_id, ps.serial_number, ps.warehouse_id,
             ps.unit, ps.unit_quantity, ps.base_quantity, ps.status, ps.created_at,
             p.name AS product_name, p.sku
      FROM product_serials ps
      JOIN products p ON p.id = ps.product_id
      WHERE ps.owner_id = ? AND ps.product_id = ? AND (? IS NULL OR ps.warehouse_id = ?) AND ps.status = 'AVAILABLE' AND (ps.is_group = 0 OR ps.is_group IS NULL)
      ORDER BY ps.created_at ASC
    `).all(context.ownerId, productId, targetWhId, targetWhId) as Array<{
      id: string;
      product_id: string;
      serial_number: string;
      warehouse_id: string;
      unit: string | null;
      unit_quantity: number | null;
      base_quantity: number | null;
      status: string;
      created_at: string;
      product_name: string;
      sku: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku,
      warehouseId: r.warehouse_id,
      serialNumber: r.serial_number,
      unit: r.unit || "pcs",
      unitQuantity: Number(r.unit_quantity || 1),
      baseQuantity: Number(r.base_quantity || 1),
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /**
   * Mengambil semua serial number yang AVAILABLE untuk seluruh produk di gudang aktif
   */
  getAvailableSerialsByWarehouse(
    context: ActiveSecurityContext,
    warehouseId?: string
  ): AvailableSerialItem[] {
    this.assertContext(context, warehouseId);
    let targetWhId: string | null = warehouseId ?? context.warehouseId ?? null;
    if (targetWhId) {
      const whExists = this.db.prepare("SELECT id FROM warehouses WHERE id = ? AND owner_id = ?").get(targetWhId, context.ownerId);
      if (!whExists) targetWhId = null;
    }

    const rows = this.db.prepare(`
      SELECT ps.id, ps.product_id, ps.serial_number, ps.warehouse_id,
             ps.unit, ps.unit_quantity, ps.base_quantity, ps.status, ps.created_at,
             p.name AS product_name, p.sku
      FROM product_serials ps
      JOIN products p ON p.id = ps.product_id
      WHERE ps.owner_id = ? AND (? IS NULL OR ps.warehouse_id = ?) AND ps.status = 'AVAILABLE' AND (ps.is_group = 0 OR ps.is_group IS NULL)
      ORDER BY ps.serial_number ASC
    `).all(context.ownerId, targetWhId, targetWhId) as Array<{
      id: string;
      product_id: string;
      serial_number: string;
      warehouse_id: string;
      unit: string | null;
      unit_quantity: number | null;
      base_quantity: number | null;
      status: string;
      created_at: string;
      product_name: string;
      sku: string;
    }>;

    return rows.map((r) => {
      const u = r.unit || "pcs";
      const uQty = Number(r.unit_quantity || 1);
      const bQty = Number(r.base_quantity) > 0 ? Number(r.base_quantity) : uQty * getUnitMultiplier(u);
      return {
        id: r.id,
        productId: r.product_id,
        productName: r.product_name,
        sku: r.sku,
        warehouseId: r.warehouse_id,
        serialNumber: r.serial_number,
        unit: u,
        unitQuantity: uQty,
        baseQuantity: bQty,
        status: r.status,
        createdAt: r.created_at,
      };
    });
  }

  /**
   * Memvalidasi Serial Number untuk pengeluaran barang (Goods Out).
   * Memeriksa keberadaan, status AVAILABLE, dan kepemilikan owner/gudang secara langsung di database.
   */
  verifySerialForGoodsOut(
    context: ActiveSecurityContext,
    serialNumber: string,
    warehouseId?: string
  ): AvailableSerialItem {
    const rawSn = serialNumber.trim();
    const norm = normalizeSerialNumber(rawSn);

    const row = this.db.prepare(`
      SELECT ps.id, ps.product_id, ps.serial_number, ps.warehouse_id,
             ps.unit, ps.unit_quantity, ps.base_quantity, ps.status, ps.created_at,
             p.name AS product_name, p.sku, w.name AS warehouse_name
      FROM product_serials ps
      JOIN products p ON p.id = ps.product_id
      JOIN warehouses w ON w.id = ps.warehouse_id
      WHERE ps.owner_id = ? AND (ps.serial_number = ? OR ps.normalized_serial_number = ?)
    `).get(context.ownerId, rawSn, norm) as {
      id: string;
      product_id: string;
      serial_number: string;
      warehouse_id: string;
      unit: string | null;
      unit_quantity: number | null;
      base_quantity: number | null;
      status: string;
      created_at: string;
      product_name: string;
      sku: string;
      warehouse_name: string;
    } | undefined;

    if (!row) {
      throw new AppError("ERR_NOT_FOUND", `Serial Number '${serialNumber}' tidak ditemukan di sistem.`, 404);
    }

    if (row.status === "GROUPED") {
      const parentGrp = this.db.prepare(`
        SELECT sg.group_number, sg.group_name
        FROM product_serials ps
        JOIN serial_groupings sg ON sg.id = ps.parent_group_id
        WHERE ps.id = ?
      `).get(row.id) as { group_number: string; group_name: string | null } | undefined;

      const grpLabel = parentGrp?.group_number || "Group";
      throw new AppError("ERR_CONFLICT", `SN ini bagian dari ${grpLabel}.`, 409);
    }

    if (row.status !== "AVAILABLE") {
      throw new AppError("ERR_CONFLICT", `Serial Number '${serialNumber}' tidak dapat dikeluarkan (status: ${row.status}).`, 409);
    }

    // Jika user adalah STAFF/SALES, pastikan target gudang sesuai dengan penugasan
    if (context.role === "STAFF" || context.role === "SALES") {
      if (context.warehouseId && context.warehouseId !== row.warehouse_id) {
        throw new AppError(
          "ERR_FORBIDDEN_WAREHOUSE",
          `Serial Number '${serialNumber}' berada di ${row.warehouse_name}, bukan di gudang penugasan Anda.`,
          403
        );
      }
    }

    return {
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      warehouseId: row.warehouse_id,
      serialNumber: row.serial_number,
      unit: row.unit || "pcs",
      unitQuantity: Number(row.unit_quantity || 1),
      baseQuantity: Number(row.base_quantity || 1),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  /**
   * Mencari atau membuat Pelanggan (Customer) baru berdasarkan nama.
   * Digunakan saat user mengetik nama pelanggan baru langsung di form pengeluaran barang (Goods Out).
   */
  findOrCreateCustomerByName(
    context: ActiveSecurityContext,
    rawName: string,
    rawAddress?: string
  ): { id: string; code: string; name: string; isNew: boolean } {
    this.assertContext(context);
    const trimmed = rawName.trim();
    if (!trimmed) {
      throw new AppError("ERR_VALIDATION", "Nama pelanggan tidak boleh kosong.", 400);
    }

    // Bersihkan format "Nama Pelanggan (CUST-XXX)" jika ada suffix kode di dalam kurung
    const cleanedName = trimmed.replace(/\s*\([A-Z0-9-]+\)$/i, "").trim() || trimmed;

    // Cek apakah customer sudah ada berdasarkan nama (case-insensitive) atau kode
    const existing = this.db.prepare(`
      SELECT id, code, name FROM customers
      WHERE owner_id = ? AND (LOWER(TRIM(name)) = LOWER(?) OR LOWER(TRIM(code)) = LOWER(?))
      LIMIT 1
    `).get(context.ownerId, cleanedName, trimmed) as { id: string; code: string; name: string } | undefined;

    if (existing) {
      return { id: existing.id, code: existing.code, name: existing.name, isNew: false };
    }

    // Generate unique customer code
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE owner_id = ?
    `).get(context.ownerId) as { count: number };

    let nextSeq = (countRow?.count ?? 0) + 1;
    let generatedCode = `CUST-${String(nextSeq).padStart(3, "0")}`;

    while (
      this.db.prepare(`SELECT 1 FROM customers WHERE owner_id = ? AND code = ?`).get(context.ownerId, generatedCode)
    ) {
      nextSeq++;
      generatedCode = `CUST-${String(nextSeq).padStart(3, "0")}`;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO customers (id, owner_id, code, name, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(id, context.ownerId, generatedCode, cleanedName, rawAddress?.trim() || null, now, now);

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "CREATE_CUSTOMER_AUTO",
      "CUSTOMER",
      id,
      { code: generatedCode, name: cleanedName, source: "GOODS_OUT_PENDING" }
    );

    return { id, code: generatedCode, name: cleanedName, isNew: true };
  }

  /**
   * Transaksi Atomik: Membuat Goods Out Pending (Reservasi Stok)
   * Sesuai Aturan V2.4.1: Goods Out PENDING mereservasi kuantitas/SN, TETAPI TIDAK memotong saldo fisik.
   */
  createGoodsOutPendingTransaction(
    context: ActiveSecurityContext,
    input: CreateGoodsOutPendingInput
  ): { goodsOutId: string; reservedCount: number; customerId?: string; newCustomer?: { id: string; code: string; name: string } } {
    this.assertContext(context, input.warehouseId);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const goodsOutId = crypto.randomUUID();

      let resolvedCustomerId = input.customerId ?? null;
      let newCustomerCreated: { id: string; code: string; name: string } | undefined = undefined;

      if (!resolvedCustomerId && input.customerName && input.customerName.trim()) {
        const foundOrCreated = this.findOrCreateCustomerByName(context, input.customerName, input.customerAddress);
        resolvedCustomerId = foundOrCreated.id;
        if (foundOrCreated.isNew) {
          newCustomerCreated = {
            id: foundOrCreated.id,
            code: foundOrCreated.code,
            name: foundOrCreated.name,
          };
        }
      }

      // 0. Validasi rujukan PO jika ada (TASK-029 & RPD §7.7)
      if (input.poId) {
        const po = this.db.prepare(`
          SELECT id, owner_id, customer_id, status FROM purchase_orders
          WHERE id = ? AND owner_id = ?
        `).get(input.poId, context.ownerId) as { id: string; owner_id: string; customer_id: string; status: string } | undefined;

        if (!po) {
          throw new AppError("ERR_NOT_FOUND", "Purchase Order rujukan tidak ditemukan pada Owner ini.", 404);
        }

        if (po.status !== "CONFIRMED" && po.status !== "PARTIALLY_FULFILLED") {
          throw new AppError("ERR_CONFLICT", `Purchase Order tidak dapat dipenuhi karena berstatus '${po.status}'.`, 409);
        }

        if (resolvedCustomerId && resolvedCustomerId !== po.customer_id) {
          throw new AppError("ERR_VALIDATION", "Pelanggan pada Goods Out harus sama dengan pelanggan pada Purchase Order.", 400);
        }
      }

      // 1. Simpan Header Goods Out status PENDING
      this.db.prepare(`
        INSERT INTO goods_out (
          id, owner_id, warehouse_id, customer_id, po_id, document_number,
          document_date, status, cancellation_reason, note, created_by_user_id,
          completed_by_user_id, completed_at, cancelled_by_user_id, cancelled_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        goodsOutId,
        context.ownerId,
        input.warehouseId,
        resolvedCustomerId,
        input.poId ?? null,
        input.documentNumber.trim(),
        input.documentDate,
        input.note ?? null,
        context.userId,
        now,
        now
      );

      let reservedCount = 0;

      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas barang keluar harus lebih besar dari 0.", 400);
        }

        // Jika terhubung ke baris PO, validasi kuantitas terhadap sisa yang belum dialokasikan
        if (input.poId && line.poLineId) {
          const poLine = this.db.prepare(`
            SELECT id, po_id, product_id, raw_product_name, mapping_status, target_qty, fulfilled_qty
            FROM purchase_order_lines
            WHERE id = ? AND po_id = ?
          `).get(line.poLineId, input.poId) as {
            id: string;
            po_id: string;
            product_id: string | null;
            raw_product_name: string;
            mapping_status: string;
            target_qty: number;
            fulfilled_qty: number;
          } | undefined;

          if (!poLine) {
            throw new AppError("ERR_NOT_FOUND", `Baris Purchase Order '${line.poLineId}' tidak ditemukan.`, 404);
          }

          if (poLine.mapping_status === "UNMAPPED" || !poLine.product_id) {
            throw new AppError(
              "ERR_CONFLICT",
              `Baris PO '${poLine.raw_product_name}' belum dipetakan ke produk Master Produk resmi. Silakan petakan terlebih dahulu sebelum memproses Goods Out.`,
              409,
              { reason: "PO_LINE_UNMAPPED", poLineId: poLine.id }
            );
          }

          // Hitung kuantitas pending dari Goods Out PENDING lain yang menunjuk po_line_id ini
          const pendingRow = this.db.prepare(`
            SELECT COALESCE(SUM(gol.quantity), 0) AS pending_qty
            FROM goods_out_lines gol
            JOIN goods_out go ON go.id = gol.goods_out_id
            WHERE go.owner_id = ? AND go.status = 'PENDING' AND gol.po_line_id = ?
          `).get(context.ownerId, line.poLineId) as { pending_qty: number };

          const remainingFulfillable = Number(poLine.target_qty) - Number(poLine.fulfilled_qty) - Number(pendingRow.pending_qty);

          if (line.quantity > remainingFulfillable) {
            throw new AppError(
              "ERR_CONFLICT",
              `Kuantitas pengeluaran (${line.quantity}) melampaui sisa target PO yang belum dialokasikan (${remainingFulfillable}). Target: ${poLine.target_qty}, Selesai: ${poLine.fulfilled_qty}, Pending: ${pendingRow.pending_qty}.`,
              409,
              { reason: "PO_OVER_FULFILLMENT" }
            );
          }
        }

        // Hitung kuantitas dasar berdasarkan satuan atau representasi Serial Number operasional
        let lineBaseQty = Number(line.quantity) * getUnitMultiplier(line.unit);

        // Ambil info tracking mode produk
        const prod = this.db.prepare(`
          SELECT id, tracking_mode FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.productId, context.ownerId, input.warehouseId) as {
          id: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
        } | undefined;

        if (!prod) {
          throw new AppError("ERR_NOT_FOUND", `Produk '${line.productId}' tidak ditemukan.`, 404);
        }

        const isSerial = prod.tracking_mode === "SERIAL";
        const lineId = crypto.randomUUID();
        const reservationId = crypto.randomUUID();

        // Alokasi serial jika serial
        let allocatedSerialIds: string[] | undefined = undefined;
        if (isSerial || (line.serials && line.serials.length > 0)) {
          if (line.serials && line.serials.length > 0) {
            allocatedSerialIds = [];
            let serialTotalBase = 0;

            for (const rawSn of line.serials) {
              const normSn = normalizeSerialNumber(rawSn);
              const snRow = this.db.prepare(`
                SELECT id, status, unit, unit_quantity, base_quantity FROM product_serials
                WHERE owner_id = ? AND warehouse_id = ? AND product_id = ? AND normalized_serial_number = ?
              `).get(context.ownerId, input.warehouseId, line.productId, normSn) as {
                id: string;
                status: string;
                unit: string;
                unit_quantity: number;
                base_quantity: number;
              } | undefined;

              if (!snRow || snRow.status !== "AVAILABLE") {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial Number '${rawSn}' tidak tersedia untuk direservasi (status: ${snRow?.status ?? "TIDAK DITEMUKAN"}).`,
                  409
                );
              }

              allocatedSerialIds.push(snRow.id);
              serialTotalBase += Number(snRow.base_quantity || 1);

              // Tandai serial sebagai RESERVED
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'RESERVED', updated_at = ?
                WHERE id = ?
              `).run(now, snRow.id);
            }

            lineBaseQty = serialTotalBase;
          }
        }

        // Cek saldo terkini via rekonsiliasi
        const balance = this.calculateStockBalance(context.ownerId, input.warehouseId, line.productId);

        if (balance.availableStock < lineBaseQty) {
          throw new AppError(
            "ERR_CONFLICT",
            `Stok tidak mencukupi untuk reservasi produk '${line.productId}'. Diminta (dasar): ${lineBaseQty}, Tersedia: ${balance.availableStock}.`,
            409,
            { reason: "OVERSELL_PROTECTION" }
          );
        }

        // Simpan baris Goods Out (termasuk po_line_id jika ada)
        this.db.prepare(`
          INSERT INTO goods_out_lines (
            id, goods_out_id, product_id, po_line_id, quantity, unit,
            allocated_serials_json, group_id, group_serials_snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          goodsOutId,
          line.productId,
          line.poLineId ?? null,
          line.quantity,
          line.unit ?? "pcs",
          allocatedSerialIds ? JSON.stringify(allocatedSerialIds) : null,
          line.groupId ?? null,
          line.groupSerialsSnapshotJson ?? null,
          now
        );

        // Simpan entri Reservasi (status: ACTIVE)
        this.db.prepare(`
          INSERT INTO reservations (
            id, owner_id, warehouse_id, product_id, goods_out_id,
            goods_out_line_id, reserved_base_qty, serial_ids_json,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(
          reservationId,
          context.ownerId,
          input.warehouseId,
          line.productId,
          goodsOutId,
          lineId,
          lineBaseQty,
          allocatedSerialIds ? JSON.stringify(allocatedSerialIds) : null,
          now,
          now
        );

        reservedCount++;
      }

      // Audit Log
      this.recordAudit(
        context.ownerId,
        input.warehouseId,
        context.userId,
        "CREATE_GOODS_OUT_PENDING",
        "GOODS_OUT",
        goodsOutId,
        {
          documentNumber: input.documentNumber,
          poId: input.poId ?? undefined,
          status: "PENDING",
        }
      );

      return { goodsOutId, reservedCount, customerId: resolvedCustomerId ?? undefined, newCustomer: newCustomerCreated };
    });
  }

  /**
   * Mengubah transaksi Goods Out yang berstatus PENDING
   * Melepas reservasi & alokasi serial lama, memvalidasi stok baru, dan membuat reservasi baru.
   */
  updateGoodsOutPendingTransaction(
    context: ActiveSecurityContext,
    input: UpdateGoodsOutPendingInput
  ): { goodsOutId: string; reservedCount: number; customerId?: string; newCustomer?: { id: string; code: string; name: string } } {
    this.assertContext(context);

    return this.db.transaction(() => {
      const now = new Date().toISOString();

      const go = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, customer_id, po_id, document_number, status
        FROM goods_out
        WHERE id = ? AND owner_id = ?
      `).get(input.goodsOutId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        customer_id: string | null;
        po_id: string | null;
        document_number: string;
        status: string;
      } | undefined;

      if (!go) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods Out tidak ditemukan.", 404);
      }

      if (go.status !== "PENDING") {
        throw new AppError("ERR_CONFLICT", `Hanya transaksi PENDING yang dapat diubah (status saat ini: '${go.status}').`, 409);
      }

      let resolvedCustomerId = input.customerId;
      let newCustomerCreated: { id: string; code: string; name: string } | undefined = undefined;

      if (!resolvedCustomerId && input.customerName && input.customerName.trim()) {
        const foundOrCreated = this.findOrCreateCustomerByName(context, input.customerName, input.customerAddress);
        resolvedCustomerId = foundOrCreated.id;
        if (foundOrCreated.isNew) {
          newCustomerCreated = {
            id: foundOrCreated.id,
            code: foundOrCreated.code,
            name: foundOrCreated.name,
          };
        }
      }

      // 1. Lepaskan reservasi lama dan kembalikan serial lama ke status AVAILABLE
      const oldReservations = this.db.prepare(`
        SELECT id, serial_ids_json FROM reservations
        WHERE goods_out_id = ? AND status = 'ACTIVE'
      `).all(input.goodsOutId) as Array<{ id: string; serial_ids_json: string | null }>;

      for (const res of oldReservations) {
        if (res.serial_ids_json) {
          const sIds: string[] = JSON.parse(res.serial_ids_json);
          for (const sid of sIds) {
            this.db.prepare(`
              UPDATE product_serials SET status = 'AVAILABLE', updated_at = ? WHERE id = ?
            `).run(now, sid);
          }
        }
      }

      this.db.prepare(`DELETE FROM reservations WHERE goods_out_id = ?`).run(input.goodsOutId);
      this.db.prepare(`DELETE FROM goods_out_lines WHERE goods_out_id = ?`).run(input.goodsOutId);

      // 2. Update Header Goods Out
      this.db.prepare(`
        UPDATE goods_out
        SET customer_id = COALESCE(?, customer_id),
            document_number = COALESCE(?, document_number),
            po_id = ?,
            document_date = COALESCE(?, document_date),
            note = ?,
            updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        resolvedCustomerId ?? null,
        input.documentNumber?.trim() ?? null,
        input.poId !== undefined ? input.poId : go.po_id,
        input.documentDate ?? null,
        input.note ?? null,
        now,
        input.goodsOutId,
        context.ownerId
      );

      // 3. Masukkan baris baru dan buat reservasi baru dengan validasi oversell
      let reservedCount = 0;

      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas barang keluar harus lebih besar dari 0.", 400);
        }

        const prod = this.db.prepare(`
          SELECT id, name, tracking_mode, unit FROM products
          WHERE id = ? AND owner_id = ? AND warehouse_id = ?
        `).get(line.productId, context.ownerId, go.warehouse_id) as {
          id: string;
          name: string;
          tracking_mode: "SERIAL" | "NON_SERIAL";
          unit: string;
        } | undefined;

        if (!prod) {
          throw new AppError("ERR_NOT_FOUND", `Produk '${line.productId}' tidak ditemukan di gudang ini.`, 404);
        }

        const lineId = crypto.randomUUID();
        const reservationId = crypto.randomUUID();
        const lineMultiplier = getUnitMultiplier(line.unit ?? prod.unit);
        let lineBaseQty = line.quantity * lineMultiplier;

        let allocatedSerialIds: string[] | undefined = undefined;

        if (prod.tracking_mode === "SERIAL") {
          const serials = line.serials ?? [];
          const requiredSnCount = Math.round(Number(line.quantity));

          if (serials.length !== requiredSnCount) {
            throw new AppError(
              "ERR_VALIDATION",
              `Produk '${prod.name}' bertipe serial memerlukan tepat ${requiredSnCount} SN (diberikan: ${serials.length}).`,
              400
            );
          }

          allocatedSerialIds = [];
          let serialTotalBase = 0;

          for (const sn of serials) {
            const serialRow = this.db.prepare(`
              SELECT id, status, unit, base_quantity FROM product_serials
              WHERE product_id = ? AND warehouse_id = ? AND owner_id = ?
                AND (serial_number = ? OR normalized_serial_number = ?)
            `).get(
              line.productId,
              go.warehouse_id,
              context.ownerId,
              sn.trim(),
              normalizeSerialNumber(sn)
            ) as { id: string; status: string; unit: string; base_quantity: number } | undefined;

            if (!serialRow) {
              throw new AppError("ERR_NOT_FOUND", `Nomor seri '${sn}' tidak terdaftar pada produk ini di gudang terkait.`, 404);
            }

            if (serialRow.status !== "AVAILABLE") {
              throw new AppError("ERR_CONFLICT", `Nomor seri '${sn}' tidak tersedia (status: ${serialRow.status}).`, 409);
            }

            allocatedSerialIds.push(serialRow.id);
            serialTotalBase += Number(serialRow.base_quantity || 1);

            this.db.prepare(`
              UPDATE product_serials
              SET status = 'ALLOCATED', updated_at = ?
              WHERE id = ?
            `).run(now, serialRow.id);
          }

          lineBaseQty = serialTotalBase;
        }

        // Cek stok tersedia (Fisik - Reservasi aktif)
        const ledgerPhysical = this.db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS total
          FROM inventory_ledger
          WHERE product_id = ? AND warehouse_id = ? AND owner_id = ?
        `).get(line.productId, go.warehouse_id, context.ownerId) as { total: number };

        const currentReserved = this.db.prepare(`
          SELECT COALESCE(SUM(reserved_base_qty), 0) AS total
          FROM reservations
          WHERE product_id = ? AND warehouse_id = ? AND owner_id = ? AND status = 'ACTIVE'
        `).get(line.productId, go.warehouse_id, context.ownerId) as { total: number };

        const availableStock = Number(ledgerPhysical.total) - Number(currentReserved.total);

        if (lineBaseQty > availableStock) {
          throw new AppError(
            "ERR_CONFLICT",
            `Stok '${prod.name}' tidak mencukupi untuk reservasi. Diminta: ${line.quantity} ${line.unit ?? prod.unit}, Tersedia: ${availableStock} base unit.`,
            409,
            { reason: "OVERSELL_PROTECTION" }
          );
        }

        this.db.prepare(`
          INSERT INTO goods_out_lines (
            id, goods_out_id, product_id, po_line_id, quantity, unit,
            allocated_serials_json, group_id, group_serials_snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          input.goodsOutId,
          line.productId,
          line.poLineId ?? null,
          line.quantity,
          line.unit ?? "pcs",
          allocatedSerialIds ? JSON.stringify(allocatedSerialIds) : null,
          line.groupId ?? null,
          line.groupSerialsSnapshotJson ?? null,
          now
        );

        this.db.prepare(`
          INSERT INTO reservations (
            id, owner_id, warehouse_id, product_id, goods_out_id,
            goods_out_line_id, reserved_base_qty, serial_ids_json,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(
          reservationId,
          context.ownerId,
          go.warehouse_id,
          line.productId,
          input.goodsOutId,
          lineId,
          lineBaseQty,
          allocatedSerialIds ? JSON.stringify(allocatedSerialIds) : null,
          now,
          now
        );

        reservedCount++;
      }

      this.recordAudit(
        context.ownerId,
        go.warehouse_id,
        context.userId,
        "UPDATE_GOODS_OUT_PENDING",
        "GOODS_OUT",
        input.goodsOutId,
        {
          documentNumber: go.document_number,
          totalLines: input.lines.length,
          status: "PENDING",
        }
      );

      return {
        goodsOutId: input.goodsOutId,
        reservedCount,
        customerId: resolvedCustomerId ?? undefined,
        newCustomer: newCustomerCreated,
      };
    });
  }

  /**
   * Transaksi Atomik: Menyelesaikan Goods Out (COMPLETED)
   * Mengurangi stok fisik secara atomik di Ledger dan melepas status reservasi.
   */
  completeGoodsOutTransaction(
    context: ActiveSecurityContext,
    goodsOutId: string
  ): { completed: boolean; ledgerEntriesCount: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      // 1. Ambil Goods Out (termasuk po_id rujukan)
      const goodsOut = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, po_id, document_number, status
        FROM goods_out
        WHERE id = ? AND owner_id = ?
      `).get(goodsOutId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        po_id: string | null;
        document_number: string;
        status: string;
      } | undefined;

      if (!goodsOut) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods Out tidak ditemukan.", 404);
      }

      this.assertContext(context, goodsOut.warehouse_id);

      if (goodsOut.status !== "PENDING") {
        throw new AppError(
          "ERR_CONFLICT",
          `Goods Out tidak dapat diselesaikan karena statusnya adalah '${goodsOut.status}'.`,
          409
        );
      }

      // 2. Ambil seluruh reservasi aktif untuk Goods Out ini
      const resRows = this.db.prepare(`
        SELECT id, warehouse_id, product_id, goods_out_line_id,
               reserved_base_qty, serial_ids_json
        FROM reservations
        WHERE owner_id = ? AND goods_out_id = ? AND status = 'ACTIVE'
      `).all(context.ownerId, goodsOutId) as Array<{
        id: string;
        warehouse_id: string;
        product_id: string;
        goods_out_line_id: string;
        reserved_base_qty: number;
        serial_ids_json: string | null;
      }>;

      if (resRows.length === 0) {
        throw new AppError("ERR_CONFLICT", "Tidak ada reservasi aktif yang dapat diselesaikan.", 409);
      }

      let ledgerEntriesCount = 0;

      for (const res of resRows) {
        const serialIds: string[] | null = res.serial_ids_json
          ? JSON.parse(res.serial_ids_json)
          : null;

        // Tandai reservasi sebagai RELEASED_COMPLETED
        this.db.prepare(`
          UPDATE reservations
          SET status = 'RELEASED_COMPLETED', updated_at = ?
          WHERE id = ?
        `).run(now, res.id);

        // Jika serial, ubah status serial ke CONSUMED_OUT
        if (serialIds && serialIds.length > 0) {
          for (const sId of serialIds) {
            this.db.prepare(`
              UPDATE product_serials
              SET status = 'CONSUMED_OUT', updated_at = ?
              WHERE id = ?
            `).run(now, sId);

            // Jika serial ini adalah group, update juga status di serial_groupings dan seluruh anak serialnya
            const snItem = this.db.prepare("SELECT is_group, serial_number FROM product_serials WHERE id = ?").get(sId) as { is_group: number; serial_number: string } | undefined;
            if (snItem && snItem.is_group === 1) {
              const grp = this.db.prepare("SELECT id FROM serial_groupings WHERE owner_id = ? AND group_number = ?").get(context.ownerId, snItem.serial_number) as { id: string } | undefined;
              if (grp) {
                this.db.prepare("UPDATE serial_groupings SET status = 'CONSUMED_OUT' WHERE id = ?").run(grp.id);
                // SEMUA anggota jadi CONSUMED_OUT
                this.db.prepare("UPDATE product_serials SET status = 'CONSUMED_OUT', updated_at = ? WHERE parent_group_id = ?").run(now, grp.id);
              }
            }
          }
        }

        // Tulis entri NEGATIF ke inventory_ledger
        const nextSeq = this.getNextLedgerSequence(context.ownerId);
        const ledgerId = crypto.randomUUID();

        this.db.prepare(`
          INSERT INTO inventory_ledger (
            id, sequence_number, owner_id, warehouse_id, product_id,
            location_id, entry_type, source_doc_type, source_doc_id,
            source_line_id, quantity_delta_base, serial_ids_json,
            actor_user_id, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId,
          nextSeq,
          context.ownerId,
          res.warehouse_id,
          res.product_id,
          goodsOutId,
          res.goods_out_line_id,
          -Math.abs(Number(res.reserved_base_qty)), // Negatif (potong fisik)
          res.serial_ids_json,
          context.userId,
          now,
          now
        );

        ledgerEntriesCount++;
      }

      // 3. Update status Goods Out ke COMPLETED
      this.db.prepare(`
        UPDATE goods_out
        SET status = 'COMPLETED', completed_by_user_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(context.userId, now, now, goodsOutId);

      // 4. Jika Goods Out ini terhubung ke Purchase Order, mutasikan fulfilled_qty secara atomik (TASK-029)
      if (goodsOut.po_id) {
        // Ambil kuantitas fisik dasar (base quantity/PCS) dari reservasi yang selesai agar sesuai dengan satuan target PO
        const poFulfillments = this.db.prepare(`
          SELECT gol.po_line_id,
                 COALESCE(SUM(r.reserved_base_qty), SUM(gol.quantity)) AS fulfilled_base_qty
          FROM goods_out_lines gol
          LEFT JOIN reservations r ON r.goods_out_line_id = gol.id
          WHERE gol.goods_out_id = ? AND gol.po_line_id IS NOT NULL
          GROUP BY gol.po_line_id
        `).all(goodsOutId) as Array<{ po_line_id: string; fulfilled_base_qty: number }>;

        for (const f of poFulfillments) {
          const qtyToAdd = Number(f.fulfilled_base_qty) || 0;
          if (qtyToAdd > 0) {
            this.db.prepare(`
              UPDATE purchase_order_lines
              SET fulfilled_qty = fulfilled_qty + ?
              WHERE id = ?
            `).run(qtyToAdd, f.po_line_id);
          }
        }

        // Evaluasi status pemenuhan PO terkini
        const allPoLines = this.db.prepare(`
          SELECT target_qty, fulfilled_qty
          FROM purchase_order_lines
          WHERE po_id = ?
        `).all(goodsOut.po_id) as Array<{ target_qty: number; fulfilled_qty: number }>;

        const allDone = allPoLines.length > 0 && allPoLines.every((l) => Number(l.fulfilled_qty) >= Number(l.target_qty));
        const anyDone = allPoLines.some((l) => Number(l.fulfilled_qty) > 0);
        const newPoStatus = allDone ? "FULFILLED" : (anyDone ? "PARTIALLY_FULFILLED" : "CONFIRMED");

        this.db.prepare(`
          UPDATE purchase_orders
          SET status = ?, updated_at = ?
          WHERE id = ?
        `).run(newPoStatus, now, goodsOut.po_id);
      }

      // Audit Log
      this.recordAudit(
        context.ownerId,
        goodsOut.warehouse_id,
        context.userId,
        "COMPLETE_GOODS_OUT",
        "GOODS_OUT",
        goodsOutId,
        {
          documentNumber: goodsOut.document_number,
          poId: goodsOut.po_id ?? undefined,
          ledgerEntriesCount,
        }
      );

      return { completed: true, ledgerEntriesCount };
    });
  }

  /**
   * Pembatalan Goods Out COMPLETED (Reversal DO Selesai)
   * Membalikkan mutasi ledger (kuantitas positif), mengembalikan status serial dan group.
   */
  cancelCompletedGoodsOutTransaction(
    context: ActiveSecurityContext,
    goodsOutId: string,
    reason: string
  ): { reversed: boolean; ledgerReversalsCount: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      const goodsOut = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, document_number, status
        FROM goods_out
        WHERE id = ? AND owner_id = ?
      `).get(goodsOutId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        document_number: string;
        status: string;
      } | undefined;

      if (!goodsOut) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods Out tidak ditemukan.", 404);
      }

      this.assertContext(context, goodsOut.warehouse_id);

      if (goodsOut.status !== "COMPLETED") {
        throw new AppError(
          "ERR_CONFLICT",
          `Hanya Goods Out dengan status COMPLETED yang dapat dibatalkan melalui reversal (status saat ini: ${goodsOut.status}).`,
          409
        );
      }

      // Ambil baris-baris goods out
      const lines = this.db.prepare(`
        SELECT id, product_id, quantity, unit, allocated_serials_json, group_id, group_serials_snapshot_json
        FROM goods_out_lines
        WHERE goods_out_id = ?
      `).all(goodsOutId) as Array<{
        id: string;
        product_id: string;
        quantity: number;
        unit: string;
        allocated_serials_json: string | null;
        group_id: string | null;
        group_serials_snapshot_json: string | null;
      }>;

      // Ambil ledger yang pernah terbit untuk Goods Out ini
      const originalLedger = this.db.prepare(`
        SELECT id, sequence_number, product_id, quantity_delta_base, serial_ids_json
        FROM inventory_ledger
        WHERE owner_id = ? AND source_doc_id = ? AND entry_type = 'GOODS_OUT_COMPLETED'
      `).all(context.ownerId, goodsOutId) as Array<{
        id: string;
        sequence_number: number;
        product_id: string;
        quantity_delta_base: number;
        serial_ids_json: string | null;
      }>;

      let ledgerReversalsCount = 0;

      // Terbitkan mutasi pembalik bertanda positif
      for (const entry of originalLedger) {
        const nextSeq = this.getNextLedgerSequence(context.ownerId);
        const ledgerId = crypto.randomUUID();
        const reversedDelta = Math.abs(Number(entry.quantity_delta_base));

        this.db.prepare(`
          INSERT INTO inventory_ledger (
            id, sequence_number, owner_id, warehouse_id, product_id,
            location_id, entry_type, source_doc_type, source_doc_id,
            source_line_id, quantity_delta_base, serial_ids_json,
            actor_user_id, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_OUT', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId,
          nextSeq,
          context.ownerId,
          goodsOut.warehouse_id,
          entry.product_id,
          goodsOutId,
          entry.id,
          reversedDelta,
          entry.serial_ids_json,
          context.userId,
          now,
          now
        );

        ledgerReversalsCount++;
      }

      // Pulihkan status serial & group
      for (const l of lines) {
        if (l.allocated_serials_json) {
          const sIds: string[] = JSON.parse(l.allocated_serials_json);
          for (const sId of sIds) {
            this.db.prepare(`
              UPDATE product_serials
              SET status = 'AVAILABLE', updated_at = ?
              WHERE id = ?
            `).run(now, sId);

            // Cek apakah group
            const snItem = this.db.prepare("SELECT is_group, serial_number FROM product_serials WHERE id = ?").get(sId) as { is_group: number; serial_number: string } | undefined;
            if (snItem && snItem.is_group === 1) {
              const grp = this.db.prepare("SELECT id FROM serial_groupings WHERE owner_id = ? AND group_number = ?").get(context.ownerId, snItem.serial_number) as { id: string } | undefined;
              if (grp) {
                this.db.prepare("UPDATE serial_groupings SET status = 'AVAILABLE' WHERE id = ?").run(grp.id);
                // Anggota group kembali GROUPED
                this.db.prepare("UPDATE product_serials SET status = 'GROUPED', updated_at = ? WHERE parent_group_id = ?").run(now, grp.id);
              }
            }
          }
        }

        // Jika baris ini menyimpan snapshot group
        if (l.group_id && l.group_serials_snapshot_json) {
          this.db.prepare("UPDATE serial_groupings SET status = 'AVAILABLE' WHERE id = ?").run(l.group_id);
          const snapIds: string[] = JSON.parse(l.group_serials_snapshot_json);
          for (const sId of snapIds) {
            this.db.prepare("UPDATE product_serials SET status = 'GROUPED', updated_at = ? WHERE id = ?").run(now, sId);
          }
        }
      }

      // Update status Goods Out ke CANCELLED_TOMBSTONE
      this.db.prepare(`
        UPDATE goods_out
        SET status = 'CANCELLED_TOMBSTONE', cancellation_reason = ?,
            cancelled_by_user_id = ?, cancelled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(reason.trim(), context.userId, now, now, goodsOutId);

      this.recordAudit(
        context.ownerId,
        goodsOut.warehouse_id,
        context.userId,
        "CANCEL_COMPLETED_GOODS_OUT",
        "GOODS_OUT",
        goodsOutId,
        {
          documentNumber: goodsOut.document_number,
          reason,
          ledgerReversalsCount,
        }
      );

      return { reversed: true, ledgerReversalsCount };
    });
  }

  /**
   * Transaksi Atomik: Soft-Delete Tombstone Goods Out Pending (RPD §7.6 & DB-AUD-009)
   * Melepas reservasi, mengembalikan status SN, dan mempertahankan jejak tanpa hard-delete.
   */
  softDeleteGoodsOutTransaction(
    context: ActiveSecurityContext,
    goodsOutId: string,
    reason: string
  ): { cancelled: boolean; releasedCount: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      const goodsOut = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, document_number, status
        FROM goods_out
        WHERE id = ? AND owner_id = ?
      `).get(goodsOutId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id: string;
        document_number: string;
        status: string;
      } | undefined;

      if (!goodsOut) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen Goods Out tidak ditemukan.", 404);
      }

      this.assertContext(context, goodsOut.warehouse_id);

      if (goodsOut.status !== "PENDING") {
        throw new AppError(
          "ERR_CONFLICT",
          `Hanya Goods Out dengan status PENDING yang dapat dibatalkan (status saat ini: ${goodsOut.status}).`,
          409
        );
      }

      // Ambil seluruh reservasi aktif
      const resRows = this.db.prepare(`
        SELECT id, serial_ids_json
        FROM reservations
        WHERE owner_id = ? AND goods_out_id = ? AND status = 'ACTIVE'
      `).all(context.ownerId, goodsOutId) as Array<{
        id: string;
        serial_ids_json: string | null;
      }>;

      // Lepas reservasi ke status RELEASED_CANCELLED
      for (const res of resRows) {
        this.db.prepare(`
          UPDATE reservations
          SET status = 'RELEASED_CANCELLED', updated_at = ?
          WHERE id = ?
        `).run(now, res.id);

        // Jika ada serial terkait, kembalikan statusnya ke AVAILABLE
        if (res.serial_ids_json) {
          const serialIds: string[] = JSON.parse(res.serial_ids_json);
          for (const sId of serialIds) {
            this.db.prepare(`
              UPDATE product_serials
              SET status = 'AVAILABLE', updated_at = ?
              WHERE id = ?
            `).run(now, sId);

            // Jika serial ini adalah group, kembalikan status group ke AVAILABLE dan anggota tetap GROUPED
            const snItem = this.db.prepare("SELECT is_group, serial_number FROM product_serials WHERE id = ?").get(sId) as { is_group: number; serial_number: string } | undefined;
            if (snItem && snItem.is_group === 1) {
              const grp = this.db.prepare("SELECT id FROM serial_groupings WHERE owner_id = ? AND group_number = ?").get(context.ownerId, snItem.serial_number) as { id: string } | undefined;
              if (grp) {
                this.db.prepare("UPDATE serial_groupings SET status = 'AVAILABLE', updated_at = ? WHERE id = ?").run(now, grp.id);
                // Anggota group kembali berstatus GROUPED
                this.db.prepare("UPDATE product_serials SET status = 'GROUPED', updated_at = ? WHERE parent_group_id = ?").run(now, grp.id);
              }
            }
          }
        }
      }

      // Update Goods Out ke status CANCELLED_TOMBSTONE (TIDAK ADA HARD DELETE)
      this.db.prepare(`
        UPDATE goods_out
        SET status = 'CANCELLED_TOMBSTONE', cancellation_reason = ?,
            cancelled_by_user_id = ?, cancelled_at = ?, updated_at = ?
        WHERE id = ?
      `).run(reason.trim(), context.userId, now, now, goodsOutId);

      // Audit Log
      this.recordAudit(
        context.ownerId,
        goodsOut.warehouse_id,
        context.userId,
        "GOODS_OUT_TOMBSTONED",
        "GOODS_OUT",
        goodsOutId,
        {
          documentNumber: goodsOut.document_number,
          reason,
          releasedReservationsCount: resRows.length,
          isHardDeleted: false,
        }
      );

      return { cancelled: true, releasedCount: resRows.length };
    });
  }

  /**
   * Helper: Mendapatkan sequence number berikutnya untuk ledger Owner
   */
  private getNextLedgerSequence(ownerId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
      FROM inventory_ledger
      WHERE owner_id = ?
    `).get(ownerId) as { next_seq: number };

    return row.next_seq;
  }

  /**
   * Helper: Mengambil seluruh serial aktif pada Owner ini
   */
  private getAllActiveSerialsForOwner(ownerId: string): ActiveSerialRecord[] {
    const rows = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, product_id, serial_number,
             normalized_serial_number, status, created_at
      FROM product_serials
      WHERE owner_id = ? AND status IN ('AVAILABLE', 'RESERVED', 'QUARANTINE')
    `).all(ownerId) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      product_id: string;
      serial_number: string;
      normalized_serial_number: string;
      status: "AVAILABLE" | "RESERVED" | "QUARANTINE";
      created_at: string;
    }>;

    return rows.map((r) => ({
      serialId: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      productId: r.product_id,
      serialNumberNormalized: r.normalized_serial_number,
      status: r.status,
      registeredAt: r.created_at,
    }));
  }

  /**
   * Helper: Menulis audit log append-only
   */
  private recordAudit(
    ownerId: string,
    warehouseId: string | null,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>
  ): void {
    const auditId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO audit_logs (
        id, owner_id, warehouse_id, actor_user_id, action,
        entity_type, entity_id, correlation_id, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId,
      ownerId,
      warehouseId,
      actorUserId,
      action,
      entityType,
      entityId,
      correlationId,
      JSON.stringify(payload),
      now
    );
  }

  /**
   * Mengambil detail produk lengkap beserta serial numbers dan histori ledger
   */
  getProductById(
    context: ActiveSecurityContext,
    productId: string
  ): {
    product: ProductRecord;
    serials: Array<{
      id: string;
      productId: string;
      warehouseId: string;
      serialNumber: string;
      status: "AVAILABLE" | "RESERVED" | "OUT" | "QUARANTINE";
      receivedAt: string;
    }>;
    ledgerHistory: Array<{
      id: string;
      productId: string;
      warehouseId: string;
      timestamp: string;
      type: "GOODS_IN" | "GOODS_OUT" | "OPNAME_ADJUSTMENT" | "RETURN";
      reference: string;
      changeQty: number;
      balanceQty: number;
      unit: string;
      actor: string;
      note?: string;
    }>;
  } | null {
    this.assertContext(context);

    const row = this.db.prepare(`
      SELECT p.id, p.owner_id, p.warehouse_id, p.sku, p.name, p.barcode,
             p.category, p.tracking_mode, p.unit, p.min_stock, p.description,
             p.status, p.created_at, p.updated_at
      FROM products p
      WHERE p.id = ? AND p.owner_id = ?
    `).get(productId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      sku: string;
      name: string;
      barcode: string | null;
      category: string;
      tracking_mode: "SERIAL" | "NON_SERIAL";
      unit: string;
      min_stock: number;
      description: string | null;
      status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    // Hitung saldo
    const balance = this.calculateStockBalance(context.ownerId, row.warehouse_id, row.id);
    const productRecord: ProductRecord = {
      id: row.id,
      ownerId: row.owner_id,
      warehouseId: row.warehouse_id,
      sku: row.sku,
      name: row.name,
      barcode: row.barcode,
      category: row.category,
      trackingMode: row.tracking_mode,
      unit: row.unit,
      minStock: Number(row.min_stock),
      description: row.description,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      physicalStock: balance.physicalStock,
      reservedStock: balance.reservedStock,
      availableStock: balance.availableStock,
    };

    // Serial numbers
    const serialRows = this.db.prepare(`
      SELECT id, warehouse_id, serial_number, status, created_at
      FROM product_serials
      WHERE owner_id = ? AND product_id = ?
      ORDER BY created_at DESC
    `).all(context.ownerId, productId) as Array<{
      id: string;
      warehouse_id: string;
      serial_number: string;
      status: string;
      created_at: string;
    }>;

    const serials = serialRows.map((s) => ({
      id: s.id,
      productId,
      warehouseId: s.warehouse_id,
      serialNumber: s.serial_number,
      status: (s.status === "CONSUMED_OUT" ? "OUT" : s.status) as "AVAILABLE" | "RESERVED" | "OUT" | "QUARANTINE",
      receivedAt: s.created_at,
    }));

    // Ledger history
    const ledgerRows = this.db.prepare(`
      SELECT il.id, il.warehouse_id, il.occurred_at, il.entry_type,
             il.source_doc_type, il.source_doc_id, il.quantity_delta_base,
             COALESCE(u.full_name, 'Sistem') AS actor_name
      FROM inventory_ledger il
      LEFT JOIN users u ON u.id = il.actor_user_id
      WHERE il.owner_id = ? AND il.product_id = ?
      ORDER BY il.sequence_number DESC
    `).all(context.ownerId, productId) as Array<{
      id: string;
      warehouse_id: string;
      occurred_at: string;
      entry_type: string;
      source_doc_type: string;
      source_doc_id: string;
      quantity_delta_base: number;
      actor_name: string;
    }>;

    const running = balance.physicalStock;
    const ledgerHistory = ledgerRows.map((lh) => {
      const delta = Number(lh.quantity_delta_base);
      const entryTypeFormatted: "GOODS_IN" | "GOODS_OUT" | "OPNAME_ADJUSTMENT" | "RETURN" =
        lh.source_doc_type === "GOODS_IN" ? "GOODS_IN" :
        lh.source_doc_type === "GOODS_OUT" ? "GOODS_OUT" :
        lh.source_doc_type === "RETURN" ? "RETURN" : "OPNAME_ADJUSTMENT";

      return {
        id: lh.id,
        productId,
        warehouseId: lh.warehouse_id,
        timestamp: lh.occurred_at,
        type: entryTypeFormatted,
        reference: lh.source_doc_id,
        changeQty: delta,
        balanceQty: running,
        unit: row.unit,
        actor: lh.actor_name,
      };
    });

    return { product: productRecord, serials, ledgerHistory };
  }

  /**
   * Mengambil daftar transaksi Goods In untuk Owner / Gudang
   */
  getGoodsInList(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): Array<{
    id: string;
    reference: string;
    warehouseId: string;
    warehouseName: string;
    supplierId: string;
    supplierName: string;
    date: string;
    status: "DRAFT" | "PENDING" | "AWAITING_SN" | "POSTED";
    createdBy: string;
    notes?: string;
    items: Array<{
      productId: string;
      productName: string;
      sku: string;
      tracking: "SERIAL" | "NON_SERIAL";
      qty: number;
      unit: string;
      serials?: string[];
    }>;
  }> {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT gi.id, gi.document_number, gi.warehouse_id, w.name AS warehouse_name,
             gi.supplier_id, COALESCE(s.name, 'Pemasok Umum') AS supplier_name,
             gi.document_date, gi.status, COALESCE(u.full_name, 'Petugas') AS creator_name,
             gi.note, gi.created_at
      FROM goods_in gi
      JOIN warehouses w ON w.id = gi.warehouse_id
      LEFT JOIN suppliers s ON s.id = gi.supplier_id
      LEFT JOIN users u ON u.id = gi.created_by_user_id
      WHERE gi.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (targetWh) {
      query += ` AND gi.warehouse_id = ?`;
      params.push(targetWh);
    }
    query += ` ORDER BY gi.document_date DESC, gi.created_at DESC`;

    const giRows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      document_number: string;
      warehouse_id: string;
      warehouse_name: string;
      supplier_id: string | null;
      supplier_name: string;
      document_date: string;
      status: string;
      creator_name: string;
      note: string | null;
      created_at: string;
    }>;

    return giRows.map((gi) => {
      const lineRows = this.db.prepare(`
        SELECT gil.product_id, p.name AS product_name, p.sku, p.tracking_mode,
               gil.quantity, gil.unit, gil.received_serials_json
        FROM goods_in_lines gil
        JOIN products p ON p.id = gil.product_id
        WHERE gil.goods_in_id = ?
      `).all(gi.id) as Array<{
        product_id: string;
        product_name: string;
        sku: string;
        tracking_mode: "SERIAL" | "NON_SERIAL";
        quantity: number;
        unit: string;
        received_serials_json: string | null;
      }>;

      return {
        id: gi.id,
        reference: gi.document_number,
        warehouseId: gi.warehouse_id,
        warehouseName: gi.warehouse_name,
        supplierId: gi.supplier_id ?? "",
        supplierName: gi.supplier_name,
        date: gi.document_date,
        status: gi.status as "DRAFT" | "PENDING" | "AWAITING_SN" | "POSTED",
        createdBy: gi.creator_name,
        notes: gi.note ?? undefined,
        items: lineRows.map((l) => ({
          productId: l.product_id,
          productName: l.product_name,
          sku: l.sku,
          tracking: l.tracking_mode,
          qty: Number(l.quantity),
          unit: l.unit,
          serials: l.received_serials_json ? JSON.parse(l.received_serials_json) : undefined,
        })),
      };
    });
  }

  /**
   * Mengambil daftar transaksi Goods Out untuk Owner / Gudang
   */
  getGoodsOutList(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): Array<{
    id: string;
    reference: string;
    warehouseId: string;
    warehouseName: string;
    recipientName: string;
    recipientAddress: string;
    poId?: string;
    poNumber?: string;
    date: string;
    status: "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED";
    createdBy: string;
    notes?: string;
    items: Array<{
      productId: string;
      productName: string;
      sku: string;
      tracking: "SERIAL" | "NON_SERIAL";
      qty: number;
      unit: string;
      serials?: string[];
    }>;
  }> {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT go.id, go.document_number, go.warehouse_id, w.name AS warehouse_name,
             go.customer_id, COALESCE(c.name, 'Pelanggan Umum') AS customer_name,
             COALESCE(c.address, '-') AS customer_address,
             go.po_id, po.po_number,
             go.document_date, go.status, COALESCE(u.full_name, 'Petugas') AS creator_name,
             go.note, go.cancellation_reason, go.created_at
      FROM goods_out go
      JOIN warehouses w ON w.id = go.warehouse_id
      LEFT JOIN customers c ON c.id = go.customer_id
      LEFT JOIN purchase_orders po ON po.id = go.po_id
      LEFT JOIN users u ON u.id = go.created_by_user_id
      WHERE go.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (targetWh) {
      query += ` AND go.warehouse_id = ?`;
      params.push(targetWh);
    }
    query += ` ORDER BY go.document_date DESC, go.created_at DESC`;

    const goRows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      document_number: string;
      warehouse_id: string;
      warehouse_name: string;
      customer_id: string | null;
      customer_name: string;
      customer_address: string;
      po_id: string | null;
      po_number: string | null;
      document_date: string;
      status: string;
      creator_name: string;
      note: string | null;
      cancellation_reason: string | null;
      created_at: string;
    }>;

    return goRows.map((go) => {
      const lineRows = this.db.prepare(`
        SELECT gol.product_id, p.name AS product_name, p.sku, p.tracking_mode,
               gol.quantity, gol.unit, gol.allocated_serials_json, gol.group_id, gol.group_serials_snapshot_json
        FROM goods_out_lines gol
        JOIN products p ON p.id = gol.product_id
        WHERE gol.goods_out_id = ?
      `).all(go.id) as Array<{
        product_id: string;
        product_name: string;
        sku: string;
        tracking_mode: "SERIAL" | "NON_SERIAL";
        quantity: number;
        unit: string;
        allocated_serials_json: string | null;
        group_id: string | null;
        group_serials_snapshot_json: string | null;
      }>;

      const mappedStatus = go.status === "CANCELLED_TOMBSTONE" ? "CANCELLED" : go.status;

      return {
        id: go.id,
        reference: go.document_number,
        warehouseId: go.warehouse_id,
        warehouseName: go.warehouse_name,
        recipientName: go.customer_name,
        recipientAddress: go.customer_address,
        poId: go.po_id ?? undefined,
        poNumber: go.po_number ?? undefined,
        date: go.document_date,
        status: mappedStatus as "DRAFT" | "PENDING" | "COMPLETED" | "CANCELLED",
        createdBy: go.creator_name,
        notes: go.cancellation_reason ? `[Dibatalkan: ${go.cancellation_reason}] ${go.note ?? ""}` : (go.note ?? undefined),
        items: lineRows.map((l) => ({
          productId: l.product_id,
          productName: l.product_name,
          sku: l.sku,
          tracking: l.tracking_mode,
          qty: Number(l.quantity),
          unit: l.unit,
          serials: l.allocated_serials_json ? JSON.parse(l.allocated_serials_json) : undefined,
          groupId: l.group_id ?? undefined,
          groupSerialsSnapshot: l.group_serials_snapshot_json ? JSON.parse(l.group_serials_snapshot_json) : undefined,
        })),
      };
    });
  }

  /**
   * Mengambil daftar Customer (Pelanggan) dengan profil dan saldo poin
   */
  getCustomers(context: ActiveSecurityContext) {
    this.assertContext(context);
    const rows = this.db.prepare(`
      SELECT 
        c.id, c.owner_id, c.code, c.name, c.owner_name, c.pic_sales,
        c.contact_phone, c.contact_email, c.address, c.status,
        COALESCE((
          SELECT SUM(l.points) 
          FROM customer_point_ledger l 
          WHERE l.customer_id = c.id 
            AND l.owner_id = c.owner_id 
            AND l.entry_type IN ('EARNED_AVAILABLE', 'ADJUSTED', 'REDEEMED')
        ), 0) AS available_points,
        COALESCE((
          SELECT SUM(l.points) 
          FROM customer_point_ledger l 
          WHERE l.customer_id = c.id 
            AND l.owner_id = c.owner_id 
            AND l.entry_type = 'EARNED_PENDING'
        ), 0) AS pending_points
      FROM customers c
      WHERE c.owner_id = ?
      ORDER BY c.name ASC
    `).all(context.ownerId) as Array<{
      id: string;
      owner_id: string;
      code: string;
      name: string;
      owner_name: string | null;
      pic_sales: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      address: string | null;
      status: "ACTIVE" | "INACTIVE";
      available_points: number;
      pending_points: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      type: "CUSTOMER" as const,
      code: r.code,
      name: r.name,
      ownerName: r.owner_name ?? undefined,
      picSales: r.pic_sales ?? undefined,
      phone: r.contact_phone ?? "-",
      email: r.contact_email ?? "-",
      address: r.address ?? "-",
      status: r.status,
      availablePoints: Math.max(0, Number(r.available_points)),
      pendingPoints: Math.max(0, Number(r.pending_points)),
    }));
  }

  /**
   * Mengambil saldo poin pelanggan tertentu
   */
  getCustomerPointBalance(context: ActiveSecurityContext, customerId: string): { availablePoints: number; pendingPoints: number } {
    this.assertContext(context);
    const row = this.db.prepare(`
      SELECT
        COALESCE((
          SELECT SUM(l.points) 
          FROM customer_point_ledger l 
          WHERE l.customer_id = ? 
            AND l.owner_id = ? 
            AND l.entry_type IN ('EARNED_AVAILABLE', 'ADJUSTED', 'REDEEMED')
        ), 0) AS available_points,
        COALESCE((
          SELECT SUM(l.points) 
          FROM customer_point_ledger l 
          WHERE l.customer_id = ? 
            AND l.owner_id = ? 
            AND l.entry_type = 'EARNED_PENDING'
        ), 0) AS pending_points
    `).get(customerId, context.ownerId, customerId, context.ownerId) as { available_points: number; pending_points: number } | undefined;

    return {
      availablePoints: Math.max(0, Number(row?.available_points ?? 0)),
      pendingPoints: Math.max(0, Number(row?.pending_points ?? 0)),
    };
  }

  /**
   * Menambah Customer baru
   */
  createCustomer(
    context: ActiveSecurityContext,
    input: { code?: string; name: string; ownerName?: string; picSales?: string; phone?: string; email?: string; address?: string }
  ) {
    this.assertContext(context);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let customerCode = input.code?.trim().toUpperCase();
    if (!customerCode) {
      const count = this.db.prepare("SELECT COUNT(*) as c FROM customers WHERE owner_id = ?").get(context.ownerId) as { c: number };
      customerCode = `CST-${String(count.c + 1).padStart(4, "0")}`;
    }

    this.db.prepare(`
      INSERT INTO customers (id, owner_id, code, name, owner_name, pic_sales, contact_phone, contact_email, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      id,
      context.ownerId,
      customerCode,
      input.name.trim(),
      input.ownerName?.trim() ?? null,
      input.picSales?.trim() ?? null,
      input.phone?.trim() ?? null,
      input.email?.trim() ?? null,
      input.address?.trim() ?? null,
      now,
      now
    );

    this.recordAudit(context.ownerId, null, context.userId, "CREATE_CUSTOMER", "CUSTOMER", id, {
      code: customerCode,
      name: input.name,
      ownerName: input.ownerName,
    });

    return { id, code: customerCode, name: input.name };
  }

  /**
   * Memperbarui data Customer
   */
  updateCustomer(
    context: ActiveSecurityContext,
    customerId: string,
    input: { name?: string; ownerName?: string; picSales?: string; phone?: string; email?: string; address?: string }
  ) {
    this.assertContext(context);
    const now = new Date().toISOString();

    const existing = this.db.prepare(`
      SELECT id, name, owner_name, pic_sales, contact_phone, contact_email, address
      FROM customers
      WHERE id = ? AND owner_id = ?
    `).get(customerId, context.ownerId) as {
      id: string;
      name: string;
      owner_name: string | null;
      pic_sales: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      address: string | null;
    } | undefined;

    if (!existing) {
      throw new AppError("ERR_NOT_FOUND", "Pelanggan tidak ditemukan.", 404);
    }

    const updatedName = input.name !== undefined ? input.name.trim() : existing.name;
    const updatedOwner = input.ownerName !== undefined ? (input.ownerName.trim() || null) : existing.owner_name;
    const updatedPic = input.picSales !== undefined ? (input.picSales.trim() || null) : existing.pic_sales;
    const updatedPhone = input.phone !== undefined ? (input.phone.trim() || null) : existing.contact_phone;
    const updatedEmail = input.email !== undefined ? (input.email.trim() || null) : existing.contact_email;
    const updatedAddr = input.address !== undefined ? (input.address.trim() || null) : existing.address;

    this.db.prepare(`
      UPDATE customers
      SET name = ?, owner_name = ?, pic_sales = ?, contact_phone = ?, contact_email = ?, address = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(
      updatedName,
      updatedOwner,
      updatedPic,
      updatedPhone,
      updatedEmail,
      updatedAddr,
      now,
      customerId,
      context.ownerId
    );

    this.recordAudit(context.ownerId, null, context.userId, "UPDATE_CUSTOMER", "CUSTOMER", customerId, {
      name: updatedName,
      ownerName: updatedOwner,
      phone: updatedPhone,
      email: updatedEmail,
      address: updatedAddr,
    });

    return {
      id: customerId,
      name: updatedName,
      ownerName: updatedOwner,
      picSales: updatedPic,
      phone: updatedPhone,
      email: updatedEmail,
      address: updatedAddr,
    };
  }

  /**
   * Mengambil daftar Supplier (Pemasok)
   */
  getSuppliers(context: ActiveSecurityContext) {
    this.assertContext(context);
    const rows = this.db.prepare(`
      SELECT id, owner_id, code, name, contact_phone, contact_email, address, status
      FROM suppliers
      WHERE owner_id = ?
      ORDER BY name ASC
    `).all(context.ownerId) as Array<{
      id: string;
      owner_id: string;
      code: string;
      name: string;
      contact_phone: string | null;
      contact_email: string | null;
      address: string | null;
      status: "ACTIVE" | "INACTIVE";
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      type: "SUPPLIER" as const,
      code: r.code,
      name: r.name,
      phone: r.contact_phone ?? "-",
      email: r.contact_email ?? "-",
      address: r.address ?? "-",
      status: r.status,
    }));
  }

  /**
   * Menambah Supplier baru
   */
  createSupplier(
    context: ActiveSecurityContext,
    input: { code: string; name: string; phone?: string; email?: string; address?: string }
  ) {
    this.assertContext(context);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO suppliers (id, owner_id, code, name, contact_phone, contact_email, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      id,
      context.ownerId,
      input.code.trim().toUpperCase(),
      input.name.trim(),
      input.phone?.trim() ?? null,
      input.email?.trim() ?? null,
      input.address?.trim() ?? null,
      now,
      now
    );

    this.recordAudit(context.ownerId, null, context.userId, "CREATE_SUPPLIER", "SUPPLIER", id, {
      code: input.code,
      name: input.name,
    });

    return { id, code: input.code, name: input.name };
  }

  /**
   * Mengambil Log Audit terisolasi per-Owner
   */
  getAuditLogs(context: ActiveSecurityContext, limit = 100) {
    this.assertContext(context);

    const rows = this.db.prepare(`
      SELECT al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
             al.payload_json, COALESCE(u.email, 'system@docuflow.id') AS actor_email
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_user_id
      WHERE al.owner_id = ?
      ORDER BY al.occurred_at DESC
      LIMIT ?
    `).all(context.ownerId, limit) as Array<{
      id: string;
      occurred_at: string;
      action: string;
      entity_type: string;
      entity_id: string;
      payload_json: string | null;
      actor_email: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.occurred_at,
      actorEmail: r.actor_email,
      actorRole: context.role,
      action: r.action,
      targetType: r.entity_type,
      targetId: r.entity_id,
      details: r.payload_json ? r.payload_json : `${r.action} pada ${r.entity_type} ${r.entity_id}`,
      status: "SUCCESS" as const,
    }));
  }

  /**
   * Mengambil Ringkasan Dasbor Operasi
   */
  getDashboardSummary(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): {
    totalProducts: number;
    lowStockCount: number;
    pendingGoodsInCount: number;
    pendingGoodsOutCount: number;
    totalStockCount: number;
  } {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    const products = this.getProductsByOwner(context, targetWh ?? undefined);
    const totalProducts = products.length;
    let lowStockCount = 0;
    let totalStockCount = 0;

    for (const p of products) {
      const stock = p.physicalStock ?? 0;
      totalStockCount += stock;
      if (p.minStock && stock <= p.minStock) {
        lowStockCount++;
      }
    }

    let giQuery = `SELECT COUNT(*) AS count FROM goods_in WHERE owner_id = ? AND status = 'PENDING'`;
    const giParams: unknown[] = [context.ownerId];
    if (targetWh) {
      giQuery += ` AND warehouse_id = ?`;
      giParams.push(targetWh);
    }
    const giCount = (this.db.prepare(giQuery).get(...giParams) as { count: number }).count;

    let goQuery = `SELECT COUNT(*) AS count FROM goods_out WHERE owner_id = ? AND status = 'PENDING'`;
    const goParams: unknown[] = [context.ownerId];
    if (targetWh) {
      goQuery += ` AND warehouse_id = ?`;
      goParams.push(targetWh);
    }
    const goCount = (this.db.prepare(goQuery).get(...goParams) as { count: number }).count;

    return {
      totalProducts,
      lowStockCount,
      pendingGoodsInCount: giCount,
      pendingGoodsOutCount: goCount,
      totalStockCount,
    };
  }

  /**
   * Mengambil daftar gudang yang dimiliki oleh Owner aktif
   */
  getWarehouses(context: ActiveSecurityContext): WarehouseRecord[] {
    this.assertContext(context);
    const rows = this.db.prepare(`
      SELECT id, owner_id, code, name, address, status, conversion_display_unit, created_at, updated_at
      FROM warehouses
      WHERE owner_id = ?
      ORDER BY name ASC
    `).all(context.ownerId) as Array<{
      id: string;
      owner_id: string;
      code: string;
      name: string;
      address: string | null;
      status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
      conversion_display_unit?: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      code: r.code,
      name: r.name,
      address: r.address,
      status: r.status,
      conversionDisplayUnit: r.conversion_display_unit === "lusin" ? "lusin" : "pcs",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Mengambil preferensi satuan display konversi untuk gudang aktif
   */
  getWarehouseConversionDisplayUnit(
    context: ActiveSecurityContext,
    warehouseId: string
  ): "pcs" | "lusin" {
    this.assertContext(context);
    try {
      const row = this.db
        .prepare(
          `
        SELECT conversion_display_unit
        FROM warehouses
        WHERE id = ? AND owner_id = ?
      `
        )
        .get(warehouseId, context.ownerId) as
        | { conversion_display_unit?: string }
        | undefined;

      return row?.conversion_display_unit === "lusin" ? "lusin" : "pcs";
    } catch {
      return "pcs";
    }
  }

  /**
   * Memperbarui preferensi satuan display konversi pada gudang aktif (tersimpan untuk semua role di gudang tersebut)
   */
  updateWarehouseConversionDisplayUnit(
    context: ActiveSecurityContext,
    warehouseId: string,
    unit: "pcs" | "lusin"
  ): void {
    this.assertContext(context);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE warehouses
      SET conversion_display_unit = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `
      )
      .run(unit, now, warehouseId, context.ownerId);
  }

  /**
   * Mengambil daftar sesi Stock Opname
   */
  getStockOpnameSessions(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): StockOpnameSessionRecord[] {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT so.id, so.owner_id, so.warehouse_id, w.name as warehouse_name,
             so.session_number, so.title, so.scope_config, so.status,
             so.started_at, so.snapshot_at, so.reviewed_at,
             so.adjusted_at, u.email as created_by_email, so.note,
             (SELECT COUNT(*) FROM stock_opname_lines l WHERE l.session_id = so.id) as item_count,
             (SELECT COUNT(*) FROM stock_opname_lines l WHERE l.session_id = so.id AND l.variance_qty != 0) as variance_count
      FROM stock_opname_sessions so
      JOIN warehouses w ON w.id = so.warehouse_id
      JOIN users u ON u.id = so.created_by_user_id
      WHERE so.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (targetWh) {
      query += ` AND so.warehouse_id = ?`;
      params.push(targetWh);
    }

    query += ` ORDER BY so.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      warehouse_name: string;
      session_number: string;
      title: string | null;
      scope_config: string | null;
      status: "DRAFT" | "COUNTING" | "REVIEW" | "ADJUSTED" | "COMPLETED" | "CANCELLED";
      started_at: string;
      snapshot_at: string | null;
      reviewed_at: string | null;
      adjusted_at: string | null;
      created_by_email: string;
      note: string | null;
      item_count: number;
      variance_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      sessionNumber: r.session_number,
      title: r.title,
      scope: "ALL",
      scopeConfig: r.scope_config,
      status: r.status,
      startedAt: r.started_at,
      snapshotAt: r.snapshot_at,
      reviewedAt: r.reviewed_at,
      adjustedAt: r.adjusted_at,
      createdBy: r.created_by_email,
      note: r.note,
      itemCount: r.item_count,
      varianceCount: r.variance_count,
    }));
  }

  /**
   * Membuat Sesi Stock Opname Baru (Snapshot Read-Only, Tidak Mengubah Saldo Fisik)
   */
  createStockOpnameSession(
    context: ActiveSecurityContext,
    input: {
      warehouseId: string;
      sessionNumber?: string;
      title?: string;
      scope?: "ALL" | "CATEGORY" | "LOCATION";
      scopeConfig?: Record<string, unknown> | string;
      initialAreas?: string[];
      note?: string;
    }
  ): StockOpnameSessionRecord {
    this.assertContext(context, input.warehouseId);

    // 1. Validasi keberadaan gudang dan kepemilikan Owner
    const wh = this.db.prepare(`
      SELECT id, name, owner_id FROM warehouses WHERE id = ?
    `).get(input.warehouseId) as { id: string; name: string; owner_id: string } | undefined;

    if (!wh || wh.owner_id !== context.ownerId) {
      throw new AppError(
        "ERR_FORBIDDEN_WAREHOUSE",
        `Gudang '${input.warehouseId}' bukan milik Owner aktif (${context.ownerId}).`,
        403
      );
    }

    // 2. Cegah benturan: Hanya boleh ada 1 sesi aktif (COUNTING atau REVIEW) per gudang
    const activeSession = this.db.prepare(`
      SELECT id, session_number, status FROM stock_opname_sessions
      WHERE owner_id = ? AND warehouse_id = ? AND status IN ('COUNTING', 'REVIEW')
    `).get(context.ownerId, input.warehouseId) as { id: string; session_number: string; status: string } | undefined;

    if (activeSession) {
      throw new AppError(
        "ERR_CONFLICT",
        `Gudang '${wh.name}' masih memiliki sesi Stock Opname aktif (${activeSession.session_number}) dengan status '${activeSession.status}'. Selesaikan atau batalkan sesi tersebut terlebih dahulu.`,
        409
      );
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const scope = input.scope ?? "ALL";
    const scopeConfigStr = typeof input.scopeConfig === "string" 
      ? input.scopeConfig 
      : JSON.stringify(input.scopeConfig ?? { type: scope });
    const sessionTitle = input.title?.trim() || `Stock Opname - ${wh.name}`;
    const sessionNumber = input.sessionNumber?.trim() || `SO-${Date.now()}`;

    return this.db.transaction(() => {
      // 3. Simpan sesi opname
      this.db.prepare(`
        INSERT INTO stock_opname_sessions (
          id, owner_id, warehouse_id, session_number, title, scope_config,
          status, started_at, snapshot_at, created_by_user_id, note,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'COUNTING', ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        context.ownerId,
        input.warehouseId,
        sessionNumber,
        sessionTitle,
        scopeConfigStr,
        now,
        now,
        context.userId,
        input.note ?? null,
        now,
        now
      );

      // 4. Snapshot saldo produk saat sesi dibuat (Snapshot Beku, Saldo Fisik & Ledger Tetap)
      const products = this.getProductsByOwner(context, input.warehouseId);
      const lineStmt = this.db.prepare(`
        INSERT INTO stock_opname_lines (
          id, session_id, product_id, unit, snapshot_qty, dynamic_book_qty,
          counted_qty, variance_qty, reconciliation_status, adjustment_posted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', 0, ?)
      `);

      for (const p of products) {
        const lineId = crypto.randomUUID();
        const currentStock = p.physicalStock ?? 0;
        lineStmt.run(
          lineId,
          sessionId,
          p.id,
          p.unit ?? "pcs",
          currentStock,
          currentStock, // dynamic_book_qty awal = snapshot_qty
          currentStock,
          now
        );
      }

      // 5. Snapshot Serial Number Aktif (AVAILABLE & RESERVED)
      const serialRows = this.db.prepare(`
        SELECT ps.id, ps.product_id, ps.serial_number, ps.normalized_serial_number,
               ps.unit, ps.unit_quantity, ps.base_quantity, ps.status,
               p.unit as product_unit
        FROM product_serials ps
        JOIN products p ON p.id = ps.product_id
        WHERE ps.owner_id = ? AND ps.warehouse_id = ? AND ps.status IN ('AVAILABLE', 'RESERVED')
      `).all(context.ownerId, input.warehouseId) as Array<{
        id: string;
        product_id: string;
        serial_number: string;
        normalized_serial_number: string;
        unit: string | null;
        unit_quantity: number | null;
        base_quantity: number | null;
        status: string;
        product_unit: string | null;
      }>;

      const snSnapshotStmt = this.db.prepare(`
        INSERT INTO stock_opname_serial_snapshots (
          id, owner_id, warehouse_id, session_id, product_id,
          serial_number, normalized_serial_number, unit, unit_quantity,
          base_quantity, status_at_snapshot, snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const sn of serialRows) {
        const resolution = resolveSerialUnitRepresentation({
          serialNumber: sn.serial_number,
          unit: sn.unit,
          unitQuantity: sn.unit_quantity,
          baseQuantity: sn.base_quantity,
          productUnit: sn.product_unit,
        });

        snSnapshotStmt.run(
          crypto.randomUUID(),
          context.ownerId,
          input.warehouseId,
          sessionId,
          sn.product_id,
          sn.serial_number,
          sn.normalized_serial_number,
          resolution.isValid ? resolution.unit : (sn.unit ?? "UNKNOWN"),
          resolution.isValid ? resolution.unitQuantity : 0,
          resolution.isValid ? resolution.baseQuantity : 0,
          sn.status,
          now
        );
      }

      // 6. Buat area penghitungan awal jika dispesifikasikan (default 'Area Utama')
      const areasToCreate =
        input.initialAreas && Array.isArray(input.initialAreas) && input.initialAreas.length > 0
          ? input.initialAreas
          : ["Area Utama"];

      const areaStmt = this.db.prepare(`
        INSERT INTO stock_opname_areas (
          id, owner_id, warehouse_id, session_id, name, location_code,
          status, assigned_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
      `);

      for (const areaName of areasToCreate) {
          const trimmed = areaName.trim();
          if (trimmed) {
            areaStmt.run(
              crypto.randomUUID(),
              context.ownerId,
              input.warehouseId,
              sessionId,
              trimmed,
              trimmed,
              context.userId,
              now,
              now
            );
          }
        }

      // 7. Catat audit log
      this.recordAudit(
        context.ownerId,
        input.warehouseId,
        context.userId,
        "STOCK_OPNAME_SESSION_CREATED",
        "STOCK_OPNAME",
        sessionId,
        {
          sessionNumber,
          scope,
          productCount: products.length,
          serialCount: serialRows.length,
        }
      );

      return {
        id: sessionId,
        ownerId: context.ownerId,
        warehouseId: input.warehouseId,
        warehouseName: wh.name,
        sessionNumber,
        title: sessionTitle,
        scope,
        scopeConfig: scopeConfigStr,
        status: "COUNTING",
        startedAt: now,
        snapshotAt: now,
        reviewedAt: null,
        adjustedAt: null,
        createdBy: context.email,
        note: input.note ?? null,
        itemCount: products.length,
        varianceCount: 0,
      };
    });
  }

  /**
   * Mengambil Detail Lengkap Sesi Stock Opname (Snapshot, Area, Item)
   */
  getStockOpnameSessionDetail(
    context: ActiveSecurityContext,
    sessionId: string
  ): StockOpnameSessionDetail {
    this.assertContext(context);

    const sessionRow = this.db.prepare(`
      SELECT so.id, so.owner_id, so.warehouse_id, w.name as warehouse_name,
             so.session_number, so.title, so.scope_config, so.status,
             so.started_at, so.snapshot_at, so.reviewed_at, so.adjusted_at,
             u.email as created_by_email, so.note
      FROM stock_opname_sessions so
      JOIN warehouses w ON w.id = so.warehouse_id
      JOIN users u ON u.id = so.created_by_user_id
      WHERE so.id = ? AND so.owner_id = ?
    `).get(sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      warehouse_name: string;
      session_number: string;
      title: string | null;
      scope_config: string | null;
      status: "DRAFT" | "COUNTING" | "REVIEW" | "ADJUSTED" | "COMPLETED" | "CANCELLED";
      started_at: string;
      snapshot_at: string | null;
      reviewed_at: string | null;
      adjusted_at: string | null;
      created_by_email: string;
      note: string | null;
    } | undefined;

    if (!sessionRow) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }

    // Validasi wewenang terhadap gudang sesi
    this.assertContext(context, sessionRow.warehouse_id);

    // Ambil lines
    const lineRows = this.db.prepare(`
      SELECT sol.id, sol.session_id, sol.product_id, p.name as product_name,
             p.sku, p.tracking_mode, sol.unit, sol.snapshot_qty,
             sol.dynamic_book_qty, sol.counted_qty, sol.variance_qty,
             sol.reconciliation_status, sol.discrepancy_reason,
             sol.investigation_notes, sol.scanned_serials_json
      FROM stock_opname_lines sol
      JOIN products p ON p.id = sol.product_id
      WHERE sol.session_id = ?
      ORDER BY p.name ASC
    `).all(sessionId) as Array<{
      id: string;
      session_id: string;
      product_id: string;
      product_name: string;
      sku: string;
      tracking_mode: "SERIAL" | "NON_SERIAL";
      unit: string;
      snapshot_qty: number;
      dynamic_book_qty: number | null;
      counted_qty: number;
      variance_qty: number;
      reconciliation_status: string | null;
      discrepancy_reason: string | null;
      investigation_notes: string | null;
      scanned_serials_json: string | null;
    }>;

    const lines: StockOpnameLineRecord[] = lineRows.map((l) => ({
      id: l.id,
      sessionId: l.session_id,
      productId: l.product_id,
      productName: l.product_name,
      sku: l.sku,
      trackingMode: l.tracking_mode,
      unit: l.unit,
      snapshotQty: Number(l.snapshot_qty),
      dynamicBookQty: l.dynamic_book_qty !== null ? Number(l.dynamic_book_qty) : null,
      countedQty: Number(l.counted_qty),
      varianceQty: Number(l.variance_qty),
      reconciliationStatus: l.reconciliation_status,
      discrepancyReason: l.discrepancy_reason,
      investigationNotes: l.investigation_notes,
      scannedSerials: l.scanned_serials_json ? JSON.parse(l.scanned_serials_json) : [],
    }));

    // Ambil areas
    const areas = this.getStockOpnameAreas(context, sessionId);

    // Hitung total serial snapshots
    const snCountRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_opname_serial_snapshots WHERE session_id = ?
    `).get(sessionId) as { count: number };

    return {
      session: {
        id: sessionRow.id,
        ownerId: sessionRow.owner_id,
        warehouseId: sessionRow.warehouse_id,
        warehouseName: sessionRow.warehouse_name,
        sessionNumber: sessionRow.session_number,
        title: sessionRow.title,
        scope: "ALL",
        scopeConfig: sessionRow.scope_config,
        status: sessionRow.status,
        startedAt: sessionRow.started_at,
        snapshotAt: sessionRow.snapshot_at,
        reviewedAt: sessionRow.reviewed_at,
        adjustedAt: sessionRow.adjusted_at,
        createdBy: sessionRow.created_by_email,
        note: sessionRow.note,
        itemCount: lines.length,
        varianceCount: lines.filter((l) => l.varianceQty !== 0).length,
      },
      lines,
      areas,
      serialSnapshotsCount: Number(snCountRow?.count || 0),
    };
  }

  /**
   * Membatalkan Sesi Stock Opname
   */
  cancelStockOpnameSession(
    context: ActiveSecurityContext,
    sessionId: string,
    reason?: string
  ): { success: boolean; sessionId: string; status: "CANCELLED" } {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, session_number, status
      FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_number: string;
      status: string;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }

    this.assertContext(context, session.warehouse_id);

    if (session.status === "ADJUSTED" || session.status === "COMPLETED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi Stock Opname '${session.session_number}' sudah berstatus '${session.status}' dan tidak dapat dibatalkan.`,
        409
      );
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE stock_opname_sessions
        SET status = 'CANCELLED', updated_at = ?
        WHERE id = ?
      `).run(now, sessionId);

      // Batalkan seluruh area aktif pada sesi yang dibatalkan
      this.db.prepare(`
        UPDATE stock_opname_areas
        SET status = 'CANCELLED', updated_at = ?
        WHERE session_id = ? AND status != 'CANCELLED'
      `).run(now, sessionId);

      // Arsipkan seluruh error scan sementara pada sesi ini (tanpa menghapus riwayat audit atau ledger)
      this.db.prepare(`
        UPDATE stock_opname_scan_errors
        SET is_archived = 1
        WHERE session_id = ?
      `).run(sessionId);

      this.recordAudit(
        context.ownerId,
        session.warehouse_id,
        context.userId,
        "STOCK_OPNAME_SESSION_CANCELLED",
        "STOCK_OPNAME",
        sessionId,
        {
          sessionNumber: session.session_number,
          previousStatus: session.status,
          reason: reason ?? null,
        }
      );
    });

    return { success: true, sessionId, status: "CANCELLED" };
  }

  /**
   * Pengelolaan Area: Tambah Area Baru
   */
  createStockOpnameArea(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      name: string;
      locationCode?: string;
      assignedUserId?: string;
    }
  ): StockOpnameAreaRecord {
    this.assertContext(context);

    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new AppError("ERR_VALIDATION", "Nama area tidak boleh kosong.", 400);
    }

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, status
      FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      status: string;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }

    this.assertContext(context, session.warehouse_id);

    if (session.status === "ADJUSTED" || session.status === "COMPLETED" || session.status === "CANCELLED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Tidak dapat menambah area pada sesi berstatus '${session.status}'.`,
        409
      );
    }

    // Cek duplikasi nama area di dalam sesi yang sama
    const duplicate = this.db.prepare(`
      SELECT id FROM stock_opname_areas
      WHERE session_id = ? AND LOWER(name) = LOWER(?) AND status != 'CANCELLED'
    `).get(input.sessionId, trimmedName) as { id: string } | undefined;

    if (duplicate) {
      throw new AppError(
        "ERR_CONFLICT",
        `Area dengan nama '${trimmedName}' sudah ada pada sesi ini.`,
        409
      );
    }

    const areaId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO stock_opname_areas (
        id, owner_id, warehouse_id, session_id, name, location_code,
        status, assigned_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(
      areaId,
      context.ownerId,
      session.warehouse_id,
      input.sessionId,
      trimmedName,
      input.locationCode?.trim() ?? trimmedName,
      input.assignedUserId ?? context.userId,
      now,
      now
    );

    this.recordAudit(
      context.ownerId,
      session.warehouse_id,
      context.userId,
      "STOCK_OPNAME_AREA_CREATED",
      "STOCK_OPNAME_AREA",
      areaId,
      {
        sessionId: input.sessionId,
        areaName: trimmedName,
      }
    );

    return {
      id: areaId,
      ownerId: context.ownerId,
      warehouseId: session.warehouse_id,
      sessionId: input.sessionId,
      name: trimmedName,
      locationCode: input.locationCode?.trim() ?? trimmedName,
      status: "PENDING",
      assignedUserId: input.assignedUserId ?? context.userId,
      assignedUserEmail: context.email,
      itemCount: 0,
      totalCountedQtyBase: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Pengelolaan Area: Update Area
   */
  updateStockOpnameArea(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      areaId: string;
      name?: string;
      locationCode?: string;
      assignedUserId?: string;
      status?: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    }
  ): StockOpnameAreaRecord {
    this.assertContext(context);

    const area = this.db.prepare(`
      SELECT a.id, a.owner_id as ownerId, a.warehouse_id as warehouseId, a.session_id as sessionId, a.name, a.location_code as locationCode,
             a.status, a.assigned_user_id as assignedUserId, a.created_at as createdAt, a.updated_at as updatedAt,
             u.email as assignedUserEmail
      FROM stock_opname_areas a
      LEFT JOIN users u ON u.id = a.assigned_user_id
      WHERE a.id = ? AND a.owner_id = ?
    `).get(input.areaId, context.ownerId) as (StockOpnameAreaRecord & { assignedUserEmail?: string }) | undefined;

    if (!area) {
      throw new AppError("ERR_NOT_FOUND", `Area '${input.areaId}' tidak ditemukan.`, 404);
    }

    if (area.sessionId !== input.sessionId) {
      throw new AppError(
        "ERR_FORBIDDEN_WAREHOUSE",
        `Area '${input.areaId}' bukan milik sesi '${input.sessionId}'.`,
        403
      );
    }

    this.assertContext(context, area.warehouseId);

    const nextName = input.name?.trim() ?? area.name;
    if (input.name && input.name.trim().toLowerCase() !== area.name.toLowerCase()) {
      const duplicate = this.db.prepare(`
        SELECT id FROM stock_opname_areas
        WHERE session_id = ? AND LOWER(name) = LOWER(?) AND id != ? AND status != 'CANCELLED'
      `).get(input.sessionId, nextName, input.areaId);

      if (duplicate) {
        throw new AppError(
          "ERR_CONFLICT",
          `Area dengan nama '${nextName}' sudah ada pada sesi ini.`,
          409
        );
      }
    }

    const nextLocation = input.locationCode !== undefined ? input.locationCode.trim() : area.locationCode;
    const nextAssigned = input.assignedUserId !== undefined ? input.assignedUserId : area.assignedUserId;
    const nextStatus = input.status ?? area.status;
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE stock_opname_areas
      SET name = ?, location_code = ?, assigned_user_id = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextName, nextLocation, nextAssigned, nextStatus, now, input.areaId);

    this.recordAudit(
      context.ownerId,
      area.warehouseId,
      context.userId,
      "STOCK_OPNAME_AREA_UPDATED",
      "STOCK_OPNAME_AREA",
      input.areaId,
      {
        previousName: area.name,
        nextName,
        status: nextStatus,
      }
    );

    return {
      ...area,
      name: nextName,
      locationCode: nextLocation,
      assignedUserId: nextAssigned,
      status: nextStatus,
      updatedAt: now,
    };
  }

  /**
   * Pengelolaan Area: Hapus / Batalkan Area (Aman terhadap Riwayat Historis)
   */
  deleteStockOpnameArea(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      areaId: string;
    }
  ): { success: boolean; areaId: string; action: "DELETED" | "CANCELLED" } {
    this.assertContext(context);

    const area = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, session_id, name, status
      FROM stock_opname_areas
      WHERE id = ? AND owner_id = ?
    `).get(input.areaId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_id: string;
      name: string;
      status: string;
    } | undefined;

    if (!area) {
      throw new AppError("ERR_NOT_FOUND", `Area '${input.areaId}' tidak ditemukan.`, 404);
    }

    if (area.session_id !== input.sessionId) {
      throw new AppError(
        "ERR_FORBIDDEN_WAREHOUSE",
        `Area '${input.areaId}' bukan milik sesi '${input.sessionId}'.`,
        403
      );
    }

    this.assertContext(context, area.warehouse_id);

    // Cek apakah ada data hitungan fisik yang merujuk ke area ini
    const countCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_opname_area_counts WHERE area_id = ?
    `).get(input.areaId) as { count: number };

    const errorCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_opname_scan_errors WHERE area_id = ?
    `).get(input.areaId) as { count: number };

    const hasHistory = (countCheck?.count ?? 0) > 0 || (errorCheck?.count ?? 0) > 0;
    const now = new Date().toISOString();

    if (hasHistory) {
      // Mekanisme aman: Jangan hapus fisik, ubah status menjadi CANCELLED untuk menjaga jejak audit
      this.db.prepare(`
        UPDATE stock_opname_areas
        SET status = 'CANCELLED', updated_at = ?
        WHERE id = ?
      `).run(now, input.areaId);

      this.recordAudit(
        context.ownerId,
        area.warehouse_id,
        context.userId,
        "STOCK_OPNAME_AREA_CANCELLED",
        "STOCK_OPNAME_AREA",
        input.areaId,
        { areaName: area.name, reason: "Area memiliki riwayat hitung fisik" }
      );

      return { success: true, areaId: input.areaId, action: "CANCELLED" };
    } else {
      // Bersih tanpa riwayat, dapat dihapus fisik
      this.db.prepare("DELETE FROM stock_opname_areas WHERE id = ?").run(input.areaId);

      this.recordAudit(
        context.ownerId,
        area.warehouse_id,
        context.userId,
        "STOCK_OPNAME_AREA_DELETED",
        "STOCK_OPNAME_AREA",
        input.areaId,
        { areaName: area.name }
      );

      return { success: true, areaId: input.areaId, action: "DELETED" };
    }
  }

  /**
   * Pengelolaan Area: Daftar Area per Sesi
   */
  getStockOpnameAreas(
    context: ActiveSecurityContext,
    sessionId: string
  ): StockOpnameAreaRecord[] {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }

    this.assertContext(context, session.warehouse_id);

    const rows = this.db.prepare(`
      SELECT a.id, a.owner_id, a.warehouse_id, a.session_id, a.name, a.location_code,
             a.status, a.assigned_user_id, u.email as assigned_user_email,
             a.created_at, a.updated_at,
             (SELECT COUNT(*) FROM stock_opname_area_counts c WHERE c.area_id = a.id) as item_count,
             (SELECT COALESCE(SUM(c.counted_qty_base), 0) FROM stock_opname_area_counts c WHERE c.area_id = a.id) as total_counted_qty_base
      FROM stock_opname_areas a
      LEFT JOIN users u ON u.id = a.assigned_user_id
      WHERE a.session_id = ? AND a.owner_id = ?
      ORDER BY a.created_at ASC
    `).all(sessionId, context.ownerId) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_id: string;
      name: string;
      location_code: string | null;
      status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
      assigned_user_id: string | null;
      assigned_user_email: string | null;
      created_at: string;
      updated_at: string;
      item_count: number;
      total_counted_qty_base: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      sessionId: r.session_id,
      name: r.name,
      locationCode: r.location_code,
      status: r.status,
      assignedUserId: r.assigned_user_id,
      assignedUserEmail: r.assigned_user_email,
      itemCount: Number(r.item_count || 0),
      totalCountedQtyBase: Number(r.total_counted_qty_base || 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Menyimpan / Memperbarui Hasil Hitungan Fisik Manual per Area (Produk Non-Serial)
   */
  saveStockOpnameAreaCount(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      areaId: string;
      productId: string;
      quantity: number;
      unit?: string;
      notes?: string;
    }
  ): {
    success: boolean;
    areaCountId: string;
    productId: string;
    areaId: string;
    countedQtyBase: number;
    totalCountedQty: number;
    varianceQty: number;
    reconciliationStatus: string;
  } {
    this.assertContext(context);

    // 1. Validasi Sesi & Hak Akses
    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, status FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      status: string;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    if (session.status === "ADJUSTED" || session.status === "COMPLETED" || session.status === "CANCELLED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi Stock Opname berstatus '${session.status}' dan tidak menerima pembaruan hitungan fisik.`,
        409
      );
    }

    // 2. Validasi Area
    const area = this.db.prepare(`
      SELECT id, session_id, status FROM stock_opname_areas
      WHERE id = ? AND session_id = ?
    `).get(input.areaId, input.sessionId) as { id: string; session_id: string; status: string } | undefined;

    if (!area) {
      throw new AppError("ERR_NOT_FOUND", `Area '${input.areaId}' tidak ditemukan pada sesi ini.`, 404);
    }

    if (area.status === "CANCELLED") {
      throw new AppError("ERR_CONFLICT", "Area penghitungan telah dibatalkan dan tidak dapat digunakan.", 409);
    }

    // 3. Validasi Produk
    const product = this.db.prepare(`
      SELECT id, name, sku, tracking_mode, unit FROM products
      WHERE id = ? AND owner_id = ? AND warehouse_id = ?
    `).get(input.productId, context.ownerId, session.warehouse_id) as {
      id: string;
      name: string;
      sku: string;
      tracking_mode: string;
      unit: string;
    } | undefined;

    if (!product) {
      throw new AppError(
        "ERR_NOT_FOUND",
        `Produk '${input.productId}' tidak ditemukan di gudang sesi ini.`,
        404
      );
    }

    // Penegakan Integritas: Produk serial wajib melalui pemindaian SN, bukan input manual non-serial
    if (product.tracking_mode === "SERIAL") {
      throw new AppError(
        "ERR_VALIDATION",
        `Produk '${product.name}' berserial. Penghitungan fisik produk serial wajib dilakukan melalui pemindaian Serial Number (scanner).`,
        400
      );
    }

    // Validasi kuantitas input
    if (typeof input.quantity !== "number" || isNaN(input.quantity) || input.quantity < 0) {
      throw new AppError("ERR_VALIDATION", "Kuantitas fisik harus berupa angka non-negatif yang valid.", 400);
    }

    const inputUnit = (input.unit || product.unit || "pcs").trim().toLowerCase();
    const multiplier = getUnitMultiplier(inputUnit);
    const countedQtyBase = input.quantity * multiplier;

    const now = new Date().toISOString();
    const areaCountId = crypto.randomUUID();

    return this.db.transaction(() => {
      // 4. Insert or Update stock_opname_area_counts
      this.db.prepare(`
        INSERT INTO stock_opname_area_counts (
          id, owner_id, warehouse_id, session_id, area_id, product_id,
          counted_qty_base, unit, unit_quantity, scanned_serials_json, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(area_id, product_id) DO UPDATE SET
          counted_qty_base = excluded.counted_qty_base,
          unit = excluded.unit,
          unit_quantity = excluded.unit_quantity,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(
        areaCountId,
        context.ownerId,
        session.warehouse_id,
        input.sessionId,
        input.areaId,
        input.productId,
        countedQtyBase,
        inputUnit,
        input.quantity,
        input.notes ?? null,
        now,
        now
      );

      // 5. Update status area ke IN_PROGRESS jika masih PENDING
      if (area.status === "PENDING") {
        this.db.prepare(`
          UPDATE stock_opname_areas
          SET status = 'IN_PROGRESS', updated_at = ?
          WHERE id = ?
        `).run(now, input.areaId);
      }

      // 6. Hitung ulang total counted_qty di stock_opname_lines untuk produk ini
      const totalRow = this.db.prepare(`
        SELECT COALESCE(SUM(counted_qty_base), 0) as total_base
        FROM stock_opname_area_counts
        WHERE session_id = ? AND product_id = ?
      `).get(input.sessionId, input.productId) as { total_base: number };

      const totalCounted = Number(totalRow.total_base || 0);

      // Dapatkan snapshot_qty
      const lineRow = this.db.prepare(`
        SELECT snapshot_qty FROM stock_opname_lines
        WHERE session_id = ? AND product_id = ?
      `).get(input.sessionId, input.productId) as { snapshot_qty: number } | undefined;

      const snapshotQty = lineRow ? Number(lineRow.snapshot_qty) : 0;
      const variance = totalCounted - snapshotQty;
      const reconStatus = variance === 0 ? "MATCH" : variance > 0 ? "SURPLUS" : "DEFICIT";

      this.db.prepare(`
        UPDATE stock_opname_lines
        SET counted_qty = ?, variance_qty = ?, reconciliation_status = ?
        WHERE session_id = ? AND product_id = ?
      `).run(totalCounted, variance, reconStatus, input.sessionId, input.productId);

      // 7. Audit log
      this.recordAudit(
        context.ownerId,
        session.warehouse_id,
        context.userId,
        "STOCK_OPNAME_COUNT_RECORDED",
        "STOCK_OPNAME_AREA_COUNT",
        input.areaId,
        {
          productId: input.productId,
          productName: product.name,
          inputQty: input.quantity,
          inputUnit,
          countedQtyBase,
          totalCounted,
          variance,
        }
      );

      return {
        success: true,
        areaCountId,
        productId: input.productId,
        areaId: input.areaId,
        countedQtyBase,
        totalCountedQty: totalCounted,
        varianceQty: variance,
        reconciliationStatus: reconStatus,
      };
    });
  }

  /**
   * Mengambil Hasil Hitungan Fisik per Area
   */
  getStockOpnameAreaCounts(
    context: ActiveSecurityContext,
    sessionId: string,
    areaId: string
  ): StockOpnameAreaCountRecord[] {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    const rows = this.db.prepare(`
      SELECT ac.id, ac.owner_id, ac.warehouse_id, ac.session_id, ac.area_id, ac.product_id,
             p.name as product_name, p.sku, ac.counted_qty_base, ac.unit, ac.unit_quantity,
             ac.scanned_serials_json, ac.notes, ac.created_at, ac.updated_at
      FROM stock_opname_area_counts ac
      JOIN products p ON p.id = ac.product_id
      WHERE ac.session_id = ? AND ac.area_id = ? AND ac.owner_id = ?
      ORDER BY p.name ASC
    `).all(sessionId, areaId, context.ownerId) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_id: string;
      area_id: string;
      product_id: string;
      product_name: string;
      sku: string;
      counted_qty_base: number;
      unit: string;
      unit_quantity: number;
      scanned_serials_json: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      sessionId: r.session_id,
      areaId: r.area_id,
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku,
      countedQtyBase: Number(r.counted_qty_base),
      unit: r.unit,
      unitQuantity: Number(r.unit_quantity),
      scannedSerialsJson: r.scanned_serials_json,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Mengambil Snapshot Serial Number Beku Sesi (drill-down rincian SN)
   */
  getStockOpnameSerialSnapshots(
    context: ActiveSecurityContext,
    sessionId: string,
    productId?: string
  ): StockOpnameSerialSnapshotRecord[] {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    let query = `
      SELECT sn.id, sn.owner_id, sn.warehouse_id, sn.session_id, sn.product_id,
             p.name as product_name, p.sku, sn.serial_number, sn.normalized_serial_number,
             sn.unit, sn.unit_quantity, sn.base_quantity, sn.status_at_snapshot, sn.snapshot_at
      FROM stock_opname_serial_snapshots sn
      JOIN products p ON p.id = sn.product_id
      WHERE sn.session_id = ? AND sn.owner_id = ?
    `;
    const params: unknown[] = [sessionId, context.ownerId];

    if (productId) {
      query += ` AND sn.product_id = ?`;
      params.push(productId);
    }

    query += ` ORDER BY sn.serial_number ASC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_id: string;
      product_id: string;
      product_name: string;
      sku: string;
      serial_number: string;
      normalized_serial_number: string;
      unit: string;
      unit_quantity: number;
      base_quantity: number;
      status_at_snapshot: string;
      snapshot_at: string;
    }>;

    return rows.map((r) => {
      const isUnitValid = r.unit !== "UNKNOWN" && r.unit.toLowerCase() !== "unknown" && Number(r.base_quantity) > 0;
      return {
        id: r.id,
        ownerId: r.owner_id,
        warehouseId: r.warehouse_id,
        sessionId: r.session_id,
        productId: r.product_id,
        productName: r.product_name,
        sku: r.sku,
        serialNumber: r.serial_number,
        normalizedSerialNumber: r.normalized_serial_number,
        unit: r.unit,
        unitQuantity: Number(r.unit_quantity),
        baseQuantity: Number(r.base_quantity),
        statusAtSnapshot: r.status_at_snapshot,
        snapshotAt: r.snapshot_at,
        isUnitValid,
      };
    });
  }

  /**
   * Helper Pengujian & Validasi Kuantitas Serial Number untuk Stock Opname
   */
  validateSerialForStockOpname(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      serialNumber: string;
      warehouseId?: string;
    }
  ): {
    isValid: boolean;
    serialNumber: string;
    unit: string;
    unitQuantity: number;
    baseQuantity: number;
    productName?: string;
    sku?: string;
    warehouseId: string;
    status: string;
    error?: string;
  } {
    this.assertContext(context, input.warehouseId);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }

    const targetWarehouseId = input.warehouseId ?? session.warehouse_id;
    if (targetWarehouseId !== session.warehouse_id) {
      throw new AppError(
        "ERR_FORBIDDEN_WAREHOUSE",
        `Gudang target '${targetWarehouseId}' tidak sesuai dengan gudang sesi '${session.warehouse_id}'.`,
        403
      );
    }

    const normSn = normalizeSerialNumber(input.serialNumber);

    // Cek apakah serial terdaftar di gudang sesi ini
    const snRow = this.db.prepare(`
      SELECT ps.id, ps.owner_id, ps.warehouse_id, ps.product_id,
             ps.serial_number, ps.normalized_serial_number, ps.status,
             ps.unit, ps.unit_quantity, ps.base_quantity,
             p.name as product_name, p.sku, p.unit as product_unit
      FROM product_serials ps
      JOIN products p ON p.id = ps.product_id
      WHERE ps.owner_id = ? AND (ps.serial_number = ? OR ps.normalized_serial_number = ?)
    `).get(context.ownerId, input.serialNumber.trim(), normSn) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      product_id: string;
      serial_number: string;
      normalized_serial_number: string;
      status: string;
      unit: string | null;
      unit_quantity: number | null;
      base_quantity: number | null;
      product_name: string;
      sku: string;
      product_unit: string | null;
    } | undefined;

    if (!snRow) {
      return {
        isValid: false,
        serialNumber: input.serialNumber,
        unit: "UNKNOWN",
        unitQuantity: 0,
        baseQuantity: 0,
        warehouseId: targetWarehouseId,
        status: "NOT_FOUND",
        error: `Serial Number '${input.serialNumber}' tidak terdaftar di sistem.`,
      };
    }

    // PENOLAKAN MUTLAK LINTAS GUDANG:
    // Jika SN terdaftar di gudang lain, TOLAK KERAS!
    if (snRow.warehouse_id !== targetWarehouseId) {
      throw new AppError(
        "ERR_FORBIDDEN_WAREHOUSE",
        `Serial Number '${input.serialNumber}' terdaftar di gudang '${snRow.warehouse_id}', bukan di gudang sesi '${targetWarehouseId}'.`,
        403
      );
    }

    const resolution = resolveSerialUnitRepresentation({
      serialNumber: snRow.serial_number,
      unit: snRow.unit,
      unitQuantity: snRow.unit_quantity,
      baseQuantity: snRow.base_quantity,
      productUnit: snRow.product_unit,
    });

    if (!resolution.isValid) {
      return {
        isValid: false,
        serialNumber: snRow.serial_number,
        unit: resolution.unit,
        unitQuantity: resolution.unitQuantity,
        baseQuantity: 0,
        productName: snRow.product_name,
        sku: snRow.sku,
        warehouseId: snRow.warehouse_id,
        status: snRow.status,
        error: resolution.errorMessage,
      };
    }

    return {
      isValid: true,
      serialNumber: snRow.serial_number,
      unit: resolution.unit,
      unitQuantity: resolution.unitQuantity,
      baseQuantity: resolution.baseQuantity,
      productName: snRow.product_name,
      sku: snRow.sku,
      warehouseId: snRow.warehouse_id,
      status: snRow.status,
    };
  }

  /**
   * Pemindaian Barcode Serial Number Atomik (Phase 4)
   * Memvalidasi terhadap snapshot beku, mendeteksi duplikasi di area aktif dan lintas area,
   * mengakumulasi kuantitas kanonis, dan mencatat riwayat error sementara secara atomik.
   */
  scanStockOpnameSerial(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      areaId: string;
      serialNumber: string;
    }
  ): StockOpnameScanResult {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, status FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string; status: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    const cleanSn = (input.serialNumber || "").trim();
    const now = new Date().toISOString();

    const area = this.db.prepare(`
      SELECT id, name, status FROM stock_opname_areas
      WHERE id = ? AND session_id = ?
    `).get(input.areaId, input.sessionId) as { id: string; name: string; status: string } | undefined;

    if (!area) {
      throw new AppError("ERR_NOT_FOUND", `Area '${input.areaId}' tidak ditemukan pada sesi ini.`, 404);
    }

    if (session.status === "CANCELLED" || session.status === "COMPLETED" || session.status === "ADJUSTED") {
      return {
        success: false,
        resultType: "INACTIVE_SESSION",
        message: `Sesi berstatus '${session.status}' dan tidak dapat menerima pemindaian baru.`,
        serialNumber: cleanSn,
        areaId: input.areaId,
        areaName: area.name,
        timestamp: now,
      };
    }

    if (area.status === "CANCELLED") {
      return {
        success: false,
        resultType: "INACTIVE_AREA",
        message: `Area '${area.name}' telah dibatalkan dan tidak menerima pemindaian.`,
        serialNumber: cleanSn,
        areaId: input.areaId,
        areaName: area.name,
        timestamp: now,
      };
    }

    if (!cleanSn) {
      return {
        success: false,
        resultType: "UNREGISTERED_SERIAL",
        message: "Nilai Serial Number kosong.",
        serialNumber: cleanSn,
        areaId: input.areaId,
        areaName: area.name,
        timestamp: now,
      };
    }

    const normSn = normalizeSerialNumber(cleanSn);

    return this.db.transaction(() => {
      // 1. Cek duplikasi di seluruh area pada sesi ini
      const areaCountsWithSerials = this.db.prepare(`
        SELECT ac.id, ac.area_id, a.name as area_name, ac.scanned_serials_json
        FROM stock_opname_area_counts ac
        JOIN stock_opname_areas a ON a.id = ac.area_id
        WHERE ac.session_id = ? AND ac.scanned_serials_json IS NOT NULL
      `).all(input.sessionId) as Array<{ id: string; area_id: string; area_name: string; scanned_serials_json: string }>;

      for (const ac of areaCountsWithSerials) {
        let serialList: any[] = [];
        try {
          serialList = JSON.parse(ac.scanned_serials_json);
        } catch {
          serialList = [];
        }

        const isMatch = serialList.some((s: any) => {
          if (typeof s === "string") return normalizeSerialNumber(s) === normSn || s.trim() === cleanSn;
          return s.normalized === normSn || s.serialNumber === cleanSn || normalizeSerialNumber(s.serialNumber || "") === normSn;
        });

        if (isMatch) {
          const isCurrentArea = ac.area_id === input.areaId;
          const errorType = isCurrentArea ? "DUPLICATE_IN_AREA" : "DUPLICATE_CROSS_AREA";
          const errorMsg = isCurrentArea
            ? `Serial Number '${cleanSn}' sudah dipindai di area '${area.name}'.`
            : `Serial Number '${cleanSn}' sudah tercatat di area '${ac.area_name}'.`;

          this.db.prepare(`
            INSERT INTO stock_opname_scan_errors (
              id, owner_id, warehouse_id, session_id, area_id,
              scanned_value, error_type, error_message, is_archived, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          `).run(
            crypto.randomUUID(),
            context.ownerId,
            session.warehouse_id,
            input.sessionId,
            input.areaId,
            cleanSn,
            errorType,
            errorMsg,
            now
          );

          return {
            success: false,
            resultType: errorType,
            message: errorMsg,
            serialNumber: cleanSn,
            areaId: input.areaId,
            areaName: area.name,
            duplicateAreaName: ac.area_name,
            timestamp: now,
          };
        }
      }

      // 2. Cek keberadaan SN di snapshot sesi aktif
      const snapshotSn = this.db.prepare(`
        SELECT sn.id, sn.session_id, sn.product_id, sn.serial_number, sn.normalized_serial_number,
               sn.unit, sn.unit_quantity, sn.base_quantity, sn.status_at_snapshot,
               p.name as product_name, p.sku, p.unit as product_unit
        FROM stock_opname_serial_snapshots sn
        JOIN products p ON p.id = sn.product_id
        WHERE sn.session_id = ? AND (sn.serial_number = ? OR sn.normalized_serial_number = ?)
      `).get(input.sessionId, cleanSn, normSn) as {
        id: string;
        session_id: string;
        product_id: string;
        serial_number: string;
        normalized_serial_number: string;
        unit: string;
        unit_quantity: number;
        base_quantity: number;
        status_at_snapshot: string;
        product_name: string;
        sku: string;
        product_unit: string | null;
      } | undefined;

      if (!snapshotSn) {
        const errorMsg = `Serial Number '${cleanSn}' tidak terdaftar dalam snapshot sesi ini.`;
        this.db.prepare(`
          INSERT INTO stock_opname_scan_errors (
            id, owner_id, warehouse_id, session_id, area_id,
            scanned_value, error_type, error_message, is_archived, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(
          crypto.randomUUID(),
          context.ownerId,
          session.warehouse_id,
          input.sessionId,
          input.areaId,
          cleanSn,
          "UNREGISTERED_SERIAL",
          errorMsg,
          now
        );

        return {
          success: false,
          resultType: "UNREGISTERED_SERIAL",
          message: errorMsg,
          serialNumber: cleanSn,
          areaId: input.areaId,
          areaName: area.name,
          timestamp: now,
        };
      }

      // 3. Validasi representasi satuan resmi produk
      const unitRes = resolveSerialUnitRepresentation({
        serialNumber: snapshotSn.serial_number,
        unit: snapshotSn.unit,
        unitQuantity: snapshotSn.unit_quantity,
        baseQuantity: snapshotSn.base_quantity,
        productUnit: snapshotSn.product_unit,
      });

      if (!unitRes.isValid || Number(snapshotSn.base_quantity) <= 0) {
        const errorMsg = `Serial Number '${cleanSn}' memiliki konfigurasi satuan tidak valid (${snapshotSn.unit || "NULL"}) dan memerlukan audit.`;
        this.db.prepare(`
          INSERT INTO stock_opname_scan_errors (
            id, owner_id, warehouse_id, session_id, area_id,
            scanned_value, error_type, error_message, is_archived, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(
          crypto.randomUUID(),
          context.ownerId,
          session.warehouse_id,
          input.sessionId,
          input.areaId,
          cleanSn,
          "INVALID_UNIT",
          errorMsg,
          now
        );

        return {
          success: false,
          resultType: "INVALID_UNIT",
          message: errorMsg,
          serialNumber: cleanSn,
          areaId: input.areaId,
          areaName: area.name,
          productId: snapshotSn.product_id,
          productName: snapshotSn.product_name,
          sku: snapshotSn.sku,
          timestamp: now,
        };
      }

      // 4. Catat scan valid ke stock_opname_area_counts
      const baseQty = Number(snapshotSn.base_quantity);
      const existingAc = this.db.prepare(`
        SELECT id, counted_qty_base, scanned_serials_json
        FROM stock_opname_area_counts
        WHERE area_id = ? AND product_id = ?
      `).get(input.areaId, snapshotSn.product_id) as { id: string; counted_qty_base: number; scanned_serials_json: string | null } | undefined;

      let currentSerials: any[] = [];
      if (existingAc && existingAc.scanned_serials_json) {
        try {
          currentSerials = JSON.parse(existingAc.scanned_serials_json);
        } catch {
          currentSerials = [];
        }
      }

      currentSerials.push({
        serialNumber: snapshotSn.serial_number,
        normalized: normSn,
        unit: snapshotSn.unit,
        unitQuantity: Number(snapshotSn.unit_quantity),
        baseQuantity: baseQty,
        scannedAt: now,
      });

      const newCountedBase = (existingAc ? Number(existingAc.counted_qty_base) : 0) + baseQty;

      if (existingAc) {
        this.db.prepare(`
          UPDATE stock_opname_area_counts
          SET counted_qty_base = ?, scanned_serials_json = ?, updated_at = ?
          WHERE id = ?
        `).run(newCountedBase, JSON.stringify(currentSerials), now, existingAc.id);
      } else {
        this.db.prepare(`
          INSERT INTO stock_opname_area_counts (
            id, owner_id, warehouse_id, session_id, area_id, product_id,
            counted_qty_base, unit, unit_quantity, scanned_serials_json, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          crypto.randomUUID(),
          context.ownerId,
          session.warehouse_id,
          input.sessionId,
          input.areaId,
          snapshotSn.product_id,
          newCountedBase,
          snapshotSn.unit,
          snapshotSn.unit_quantity,
          JSON.stringify(currentSerials),
          now,
          now
        );
      }

      // 5. Update status area ke IN_PROGRESS jika masih PENDING
      if (area.status === "PENDING") {
        this.db.prepare(`
          UPDATE stock_opname_areas
          SET status = 'IN_PROGRESS', updated_at = ?
          WHERE id = ?
        `).run(now, input.areaId);
      }

      // 6. Hitung ulang total counted_qty dan variance di stock_opname_lines
      const totalRow = this.db.prepare(`
        SELECT COALESCE(SUM(counted_qty_base), 0) as total_base
        FROM stock_opname_area_counts
        WHERE session_id = ? AND product_id = ?
      `).get(input.sessionId, snapshotSn.product_id) as { total_base: number };

      const totalCounted = Number(totalRow.total_base || 0);

      const lineRow = this.db.prepare(`
        SELECT snapshot_qty FROM stock_opname_lines
        WHERE session_id = ? AND product_id = ?
      `).get(input.sessionId, snapshotSn.product_id) as { snapshot_qty: number } | undefined;

      const snapshotQty = lineRow ? Number(lineRow.snapshot_qty) : 0;
      const variance = totalCounted - snapshotQty;
      const reconStatus = variance === 0 ? "MATCH" : variance > 0 ? "SURPLUS" : "DEFICIT";

      this.db.prepare(`
        UPDATE stock_opname_lines
        SET counted_qty = ?, variance_qty = ?, reconciliation_status = ?
        WHERE session_id = ? AND product_id = ?
      `).run(totalCounted, variance, reconStatus, input.sessionId, snapshotSn.product_id);

      // 7. Audit log
      this.recordAudit(
        context.ownerId,
        session.warehouse_id,
        context.userId,
        "STOCK_OPNAME_SERIAL_SCANNED",
        "STOCK_OPNAME_AREA_COUNT",
        input.areaId,
        {
          serialNumber: snapshotSn.serial_number,
          productId: snapshotSn.product_id,
          productName: snapshotSn.product_name,
          baseQuantity: baseQty,
          unit: snapshotSn.unit,
          totalCounted,
          variance,
        }
      );

      return {
        success: true,
        resultType: "SUCCESS",
        message: `Berhasil memindai ${snapshotSn.product_name} (${snapshotSn.serial_number})`,
        serialNumber: snapshotSn.serial_number,
        areaId: input.areaId,
        areaName: area.name,
        productId: snapshotSn.product_id,
        productName: snapshotSn.product_name,
        sku: snapshotSn.sku,
        baseQuantity: baseQty,
        unit: snapshotSn.unit,
        timestamp: now,
      };
    });
  }

  /**
   * Mencatat riwayat error scan sementara (ephemeral per area)
   */
  recordStockOpnameScanError(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      areaId: string;
      scannedValue: string;
      errorType: string;
      errorMessage?: string;
    }
  ): { id: string; success: boolean } {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    const area = this.db.prepare(`
      SELECT id FROM stock_opname_areas
      WHERE id = ? AND session_id = ?
    `).get(input.areaId, input.sessionId);

    if (!area) {
      throw new AppError("ERR_NOT_FOUND", `Area '${input.areaId}' tidak ditemukan pada sesi ini.`, 404);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO stock_opname_scan_errors (
        id, owner_id, warehouse_id, session_id, area_id,
        scanned_value, error_type, error_message, is_archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      context.ownerId,
      session.warehouse_id,
      input.sessionId,
      input.areaId,
      input.scannedValue.trim(),
      input.errorType,
      input.errorMessage ?? null,
      now
    );

    return { id, success: true };
  }

  /**
   * Mengambil riwayat error scan sementara (per area atau per sesi)
   */
  getStockOpnameScanErrors(
    context: ActiveSecurityContext,
    sessionId: string,
    areaId?: string,
    includeArchived: boolean = false
  ): Array<{
    id: string;
    areaId: string;
    scannedValue: string;
    errorType: string;
    errorMessage: string | null;
    isArchived: boolean;
    createdAt: string;
  }> {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    let query = `
      SELECT id, area_id, scanned_value, error_type, error_message, is_archived, created_at
      FROM stock_opname_scan_errors
      WHERE session_id = ? AND owner_id = ?
    `;
    const params: unknown[] = [sessionId, context.ownerId];

    if (areaId) {
      query += ` AND area_id = ?`;
      params.push(areaId);
    }

    if (!includeArchived) {
      query += ` AND is_archived = 0`;
    }

    query += ` ORDER BY created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      area_id: string;
      scanned_value: string;
      error_type: string;
      error_message: string | null;
      is_archived: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      areaId: r.area_id,
      scannedValue: r.scanned_value,
      errorType: r.error_type,
      errorMessage: r.error_message,
      isArchived: r.is_archived === 1,
      createdAt: r.created_at,
    }));
  }

  /**
   * Mengarsipkan riwayat error scan setelah sesi selesai atau dibatalkan
   * (Tanpa menghapus ledger atau audit transaksi resmi)
   */
  archiveStockOpnameScanErrors(
    context: ActiveSecurityContext,
    sessionId: string
  ): { archivedCount: number } {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as { id: string; owner_id: string; warehouse_id: string } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    const result = this.db.prepare(`
      UPDATE stock_opname_scan_errors
      SET is_archived = 1
      WHERE session_id = ? AND owner_id = ? AND is_archived = 0
    `).run(sessionId, context.ownerId);

    return { archivedCount: Number(result.changes) };
  }

  /**
   * =========================================================================
   * PHASE 5: REKONSILIASI, INVESTIGASI SELISIH, & DELTA CONCURRENT (SO_TASK §5)
   * =========================================================================
   */

  /**
   * Evaluasi Rekonsiliasi Dinamis Terhadap Mutasi Operasional (TASK-SO-05-01)
   * Menghitung:
   * 1. Delta concurrent (Goods In / Goods Out) pasca snapshot beku.
   * 2. Stok acuan dinamis = Snapshot Qty + Delta In - Delta Out.
   * 3. Total hitungan fisik dari seluruh area aktif.
   * 4. Selisih bersih = Fisik - Stok Acuan Dinamis.
   * 5. Drill-down rincian Serial Number: SN Cocok, SN Hilang, SN Asing/Surplus.
   * Memperbarui stock_opname_lines TANPA mengubah saldo stok atau mem-posting ledger.
   */
  evaluateStockOpnameReconciliation(
    context: ActiveSecurityContext,
    sessionId: string
  ): StockOpnameReconciliationSummary {
    this.assertContext(context);

    const sessionRow = this.db.prepare(`
      SELECT so.id, so.owner_id, so.warehouse_id, w.name as warehouse_name,
             so.session_number, so.title, so.scope_config, so.status,
             so.started_at, so.snapshot_at, so.reviewed_at, so.adjusted_at,
             u.email as created_by_email, so.note
      FROM stock_opname_sessions so
      JOIN warehouses w ON w.id = so.warehouse_id
      JOIN users u ON u.id = so.created_by_user_id
      WHERE so.id = ? AND so.owner_id = ?
    `).get(sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      warehouse_name: string;
      session_number: string;
      title: string | null;
      scope_config: string | null;
      status: "DRAFT" | "COUNTING" | "REVIEW" | "ADJUSTED" | "COMPLETED" | "CANCELLED";
      started_at: string;
      snapshot_at: string | null;
      reviewed_at: string | null;
      adjusted_at: string | null;
      created_by_email: string;
      note: string | null;
    } | undefined;

    if (!sessionRow) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }

    this.assertContext(context, sessionRow.warehouse_id);

    // 1. Ambil baris produk pada sesi opname
    const lineRows = this.db.prepare(`
      SELECT sol.id, sol.session_id, sol.product_id, p.name as product_name,
             p.sku, p.tracking_mode, sol.unit, sol.snapshot_qty,
             sol.dynamic_book_qty, sol.counted_qty, sol.variance_qty,
             sol.reconciliation_status, sol.discrepancy_reason,
             sol.investigation_notes, sol.scanned_serials_json
      FROM stock_opname_lines sol
      JOIN products p ON p.id = sol.product_id
      WHERE sol.session_id = ?
      ORDER BY p.name ASC
    `).all(sessionId) as Array<{
      id: string;
      session_id: string;
      product_id: string;
      product_name: string;
      sku: string;
      tracking_mode: "SERIAL" | "NON_SERIAL";
      unit: string;
      snapshot_qty: number;
      dynamic_book_qty: number | null;
      counted_qty: number;
      variance_qty: number;
      reconciliation_status: string | null;
      discrepancy_reason: string | null;
      investigation_notes: string | null;
      scanned_serials_json: string | null;
    }>;

    // 2. Query transaksi pergerakan concurrent pasca snapshot dari immutable ledger
    const snapshotAt = sessionRow.snapshot_at || sessionRow.started_at;
    const ledgerRows = this.db.prepare(`
      SELECT il.id, il.product_id, il.entry_type, il.source_doc_type, il.source_doc_id,
             il.quantity_delta_base, il.serial_ids_json, il.occurred_at, il.created_at
      FROM inventory_ledger il
      WHERE il.owner_id = ? AND il.warehouse_id = ? AND il.created_at > ?
      ORDER BY il.created_at ASC
    `).all(context.ownerId, sessionRow.warehouse_id, snapshotAt) as Array<{
      id: string;
      product_id: string;
      entry_type: string;
      source_doc_type: string;
      source_doc_id: string;
      quantity_delta_base: number;
      serial_ids_json: string | null;
      occurred_at: string;
      created_at: string;
    }>;

    // Mapping pergerakan ledger concurrent per produk
    const ledgerByProduct = new Map<string, Array<{
      entryType: string;
      sourceDocType: string;
      sourceDocId: string;
      quantityDeltaBase: number;
      serialIds: string[];
      occurredAt: string;
      createdAt: string;
    }>>();

    for (const row of ledgerRows) {
      let serialIds: string[] = [];
      if (row.serial_ids_json) {
        try {
          serialIds = JSON.parse(row.serial_ids_json);
        } catch {
          serialIds = [];
        }
      }
      const list = ledgerByProduct.get(row.product_id) || [];
      list.push({
        entryType: row.entry_type,
        sourceDocType: row.source_doc_type,
        sourceDocId: row.source_doc_id,
        quantityDeltaBase: Number(row.quantity_delta_base),
        serialIds,
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
      });
      ledgerByProduct.set(row.product_id, list);
    }

    // 3. Query hitungan fisik dari seluruh area yang sah (bukan CANCELLED)
    const areaCounts = this.db.prepare(`
      SELECT ac.id, ac.area_id, a.name as area_name, ac.product_id,
             ac.counted_qty_base, ac.scanned_serials_json
      FROM stock_opname_area_counts ac
      JOIN stock_opname_areas a ON a.id = ac.area_id
      WHERE ac.session_id = ? AND a.status != 'CANCELLED'
    `).all(sessionId) as Array<{
      id: string;
      area_id: string;
      area_name: string;
      product_id: string;
      counted_qty_base: number;
      scanned_serials_json: string | null;
    }>;

    const areaCountsByProduct = new Map<string, Array<{
      areaId: string;
      areaName: string;
      countedQtyBase: number;
      scannedSerials: any[];
    }>>();

    for (const ac of areaCounts) {
      let serials: any[] = [];
      if (ac.scanned_serials_json) {
        try {
          serials = JSON.parse(ac.scanned_serials_json);
        } catch {
          serials = [];
        }
      }
      const list = areaCountsByProduct.get(ac.product_id) || [];
      list.push({
        areaId: ac.area_id,
        areaName: ac.area_name,
        countedQtyBase: Number(ac.counted_qty_base),
        scannedSerials: serials,
      });
      areaCountsByProduct.set(ac.product_id, list);
    }

    // 4. Query snapshot serial number beku
    const serialSnapshots = this.db.prepare(`
      SELECT id, product_id, serial_number, normalized_serial_number, unit, base_quantity, status_at_snapshot
      FROM stock_opname_serial_snapshots
      WHERE session_id = ?
    `).all(sessionId) as Array<{
      id: string;
      product_id: string;
      serial_number: string;
      normalized_serial_number: string;
      unit: string;
      base_quantity: number;
      status_at_snapshot: string;
    }>;

    const snSnapshotsByProduct = new Map<string, Array<{
      id: string;
      serialNumber: string;
      normalized: string;
      unit: string;
      baseQuantity: number;
      status: string;
    }>>();

    for (const sn of serialSnapshots) {
      const list = snSnapshotsByProduct.get(sn.product_id) || [];
      list.push({
        id: sn.id,
        serialNumber: sn.serial_number,
        normalized: sn.normalized_serial_number,
        unit: sn.unit,
        baseQuantity: Number(sn.base_quantity),
        status: sn.status_at_snapshot,
      });
      snSnapshotsByProduct.set(sn.product_id, list);
    }

    // 5. Query riwayat error scan tidak terdaftar (untuk deteksi SN surplus/asing)
    const scanErrors = this.db.prepare(`
      SELECT scanned_value, error_type, created_at
      FROM stock_opname_scan_errors
      WHERE session_id = ? AND error_type = 'UNREGISTERED_SERIAL'
    `).all(sessionId) as Array<{
      scanned_value: string;
      error_type: string;
      created_at: string;
    }>;

    // Pre-lookup product_serials untuk unregistered scan errors
    const unregisteredSnProductMap = new Map<string, string>(); // norm -> product_id
    if (scanErrors.length > 0) {
      const placeholders = scanErrors.map(() => '?').join(',');
      const normValues = scanErrors.map(e => normalizeSerialNumber(e.scanned_value));
      const foundPs = this.db.prepare(`
        SELECT product_id, normalized_serial_number
        FROM product_serials
        WHERE owner_id = ? AND normalized_serial_number IN (${placeholders})
      `).all(context.ownerId, ...normValues) as Array<{ product_id: string; normalized_serial_number: string }>;
      for (const fps of foundPs) {
        unregisteredSnProductMap.set(fps.normalized_serial_number, fps.product_id);
      }
    }

    const reconItems: StockOpnameReconciliationItem[] = [];
    const updateLineStmt = this.db.prepare(`
      UPDATE stock_opname_lines
      SET dynamic_book_qty = ?, counted_qty = ?, variance_qty = ?, reconciliation_status = ?
      WHERE id = ?
    `);

    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const line of lineRows) {
        const productLedger = ledgerByProduct.get(line.product_id) || [];
        let deltaIn = 0;
        let deltaOut = 0;
        for (const entry of productLedger) {
          if (entry.quantityDeltaBase > 0) {
            deltaIn += entry.quantityDeltaBase;
          } else if (entry.quantityDeltaBase < 0) {
            deltaOut += Math.abs(entry.quantityDeltaBase);
          }
        }
        const netDelta = deltaIn - deltaOut;

        const productAreas = areaCountsByProduct.get(line.product_id) || [];
        const totalCountedBase = productAreas.reduce((acc, curr) => acc + curr.countedQtyBase, 0);

        const snapshotQty = Number(line.snapshot_qty);
        const dynamicBookQty = snapshotQty + netDelta;
        const varianceQty = totalCountedBase - dynamicBookQty;

        // Evaluasi matematika resmi via ledger engine
        const engineResult = reconcileStockOpnameItem(
          line.product_id,
          snapshotQty,
          dynamicBookQty,
          totalCountedBase
        );

        // Drill-down Serial Number (jika produk bertipe SERIAL)
        let serialDetail: StockOpnameSerialDetail | undefined;
        let hasSerialMismatch = false;

        if (line.tracking_mode === "SERIAL") {
          const snapshotSns = snSnapshotsByProduct.get(line.product_id) || [];
          const scannedSnsMap = new Map<string, { serialNumber: string; normalized: string; unit: string; baseQuantity: number; areaName: string }>();

          for (const a of productAreas) {
            for (const s of a.scannedSerials) {
              const snVal = typeof s === "string" ? s : s.serialNumber;
              const norm = normalizeSerialNumber(snVal);
              scannedSnsMap.set(norm, {
                serialNumber: snVal,
                normalized: norm,
                unit: (typeof s === "object" && s.unit) || line.unit,
                baseQuantity: (typeof s === "object" && s.baseQuantity) || 1,
                areaName: a.areaName,
              });
            }
          }

          // Cek serial keluar pasca snapshot dari ledger (Goods Out / Scrap / Adjustment Out)
          const postSnapshotOutSerials = new Set<string>();
          const outSerialDocMap = new Map<string, string>();
          for (const tx of productLedger) {
            if (tx.quantityDeltaBase < 0) {
              for (const sid of tx.serialIds) {
                postSnapshotOutSerials.add(sid);
                outSerialDocMap.set(sid, tx.sourceDocId);
              }
            }
          }

          // Cek serial masuk pasca snapshot dari ledger (Goods In / Retur / Adjustment In)
          const postSnapshotInSerials = new Set<string>();
          const inSerialDocMap = new Map<string, string>();
          for (const tx of productLedger) {
            if (tx.quantityDeltaBase > 0) {
              for (const sid of tx.serialIds) {
                postSnapshotInSerials.add(sid);
                inSerialDocMap.set(sid, tx.sourceDocId);
              }
            }
          }

          // Resolusi serial_number dan normalized untuk UUID yang tersimpan di ledger
          const allPostSnapshotSerialIds = Array.from(new Set([...postSnapshotOutSerials, ...postSnapshotInSerials]));
          if (allPostSnapshotSerialIds.length > 0) {
            const placeholders = allPostSnapshotSerialIds.map(() => '?').join(',');
            const resolvedPs = this.db.prepare(`
              SELECT id, serial_number, normalized_serial_number
              FROM product_serials
              WHERE id IN (${placeholders})
            `).all(...allPostSnapshotSerialIds) as Array<{ id: string; serial_number: string; normalized_serial_number: string }>;

            for (const rps of resolvedPs) {
              if (postSnapshotOutSerials.has(rps.id)) {
                postSnapshotOutSerials.add(rps.serial_number);
                postSnapshotOutSerials.add(rps.normalized_serial_number);
                const doc = outSerialDocMap.get(rps.id);
                if (doc) {
                  outSerialDocMap.set(rps.serial_number, doc);
                  outSerialDocMap.set(rps.normalized_serial_number, doc);
                }
              }
              if (postSnapshotInSerials.has(rps.id)) {
                postSnapshotInSerials.add(rps.serial_number);
                postSnapshotInSerials.add(rps.normalized_serial_number);
                const doc = inSerialDocMap.get(rps.id);
                if (doc) {
                  inSerialDocMap.set(rps.serial_number, doc);
                  inSerialDocMap.set(rps.normalized_serial_number, doc);
                }
              }
            }
          }

          const matchedSerials: StockOpnameSerialDetail["matchedSerials"] = [];
          const missingSerials: StockOpnameSerialDetail["missingSerials"] = [];

          for (const sn of snapshotSns) {
            const foundScanned = scannedSnsMap.get(sn.normalized);
            if (foundScanned) {
              matchedSerials.push({
                serialNumber: sn.serialNumber,
                normalized: sn.normalized,
                unit: sn.unit,
                baseQuantity: sn.baseQuantity,
                scannedInArea: foundScanned.areaName,
              });
            } else {
              // Cek apakah SN ini legal keluar karena transaksi operasional pasca-snapshot
              const dispatched = postSnapshotOutSerials.has(sn.id) || postSnapshotOutSerials.has(sn.serialNumber) || postSnapshotOutSerials.has(sn.normalized);
              const docNum = outSerialDocMap.get(sn.id) || outSerialDocMap.get(sn.serialNumber) || outSerialDocMap.get(sn.normalized);
              missingSerials.push({
                serialNumber: sn.serialNumber,
                normalized: sn.normalized,
                unit: sn.unit,
                baseQuantity: sn.baseQuantity,
                dispatchedPostSnapshot: dispatched,
                postSnapshotDocNumber: docNum,
              });
              if (!dispatched) {
                hasSerialMismatch = true;
              }
            }
          }

          // Cek serial surplus: SN terhitung tetapi tidak ada di snapshot
          const surplusSerials: StockOpnameSerialDetail["surplusSerials"] = [];
          const snapshotNormSet = new Set(snapshotSns.map((s) => s.normalized));
          const surplusNormSet = new Set<string>();

          for (const [norm, sc] of scannedSnsMap.entries()) {
            if (!snapshotNormSet.has(norm)) {
              const receivedPost = postSnapshotInSerials.has(norm) || postSnapshotInSerials.has(sc.serialNumber);
              const docNum = inSerialDocMap.get(norm) || inSerialDocMap.get(sc.serialNumber);
              surplusSerials.push({
                serialNumber: sc.serialNumber,
                normalized: norm,
                unit: sc.unit,
                baseQuantity: sc.baseQuantity,
                source: "SCANNED",
                receivedPostSnapshot: receivedPost,
                postSnapshotDocNumber: docNum,
              });
              surplusNormSet.add(norm);
              if (!receivedPost) {
                hasSerialMismatch = true;
              }
            }
          }

          // Sertakan scan errors unregistered serials tanpa duplikasi dan dipetakan akurat
          const isSingleSerialProduct = lineRows.filter((l) => l.tracking_mode === "SERIAL").length === 1;
          for (const err of scanErrors) {
            const normErr = normalizeSerialNumber(err.scanned_value);
            if (snapshotNormSet.has(normErr) || scannedSnsMap.has(normErr) || surplusNormSet.has(normErr)) {
              continue;
            }

            const targetProductId = unregisteredSnProductMap.get(normErr);
            const isRelevantProduct = targetProductId
              ? targetProductId === line.product_id
              : (isSingleSerialProduct || normErr.includes(normalizeSerialNumber(line.sku)));

            if (isRelevantProduct) {
              surplusSerials.push({
                serialNumber: err.scanned_value,
                normalized: normErr,
                unit: line.unit,
                baseQuantity: 1,
                source: "SCAN_ERROR",
              });
              surplusNormSet.add(normErr);
              hasSerialMismatch = true;
            }
          }

          serialDetail = {
            matchedSerials,
            missingSerials,
            surplusSerials,
          };
        }

        // Tentukan status rekonsiliasi kanonis: MATCH, SURPLUS, SHORTAGE, atau REQUIRES_RE_EVALUATION
        let reconciliationStatus: "MATCH" | "SURPLUS" | "SHORTAGE" | "REQUIRES_RE_EVALUATION";
        if (hasSerialMismatch || (engineResult.hasConcurrentMovement && varianceQty !== 0)) {
          reconciliationStatus = "REQUIRES_RE_EVALUATION";
        } else if (varianceQty === 0) {
          reconciliationStatus = "MATCH";
        } else if (varianceQty > 0) {
          reconciliationStatus = "SURPLUS";
        } else {
          reconciliationStatus = "SHORTAGE";
        }

        let recommendation: StockOpnameReconciliationItem["recommendation"] = engineResult.recommendation;
        if (reconciliationStatus === "REQUIRES_RE_EVALUATION" || hasSerialMismatch) {
          recommendation = "REQUIRES_RE_EVALUATION";
        } else if (varianceQty !== 0) {
          recommendation = "REQUIRES_INVESTIGATION";
        }

        // Simpan hasil perhitungan ke stock_opname_lines (TANPA menyentuh inventory_ledger)
        updateLineStmt.run(dynamicBookQty, totalCountedBase, varianceQty, reconciliationStatus, line.id);

        reconItems.push({
          id: line.id,
          sessionId: line.session_id,
          productId: line.product_id,
          productName: line.product_name,
          sku: line.sku,
          trackingMode: line.tracking_mode,
          unit: line.unit,
          snapshotQty,
          deltaIn,
          deltaOut,
          netDelta,
          dynamicBookQty,
          countedQty: totalCountedBase,
          varianceQty,
          reconciliationStatus,
          hasConcurrentMovement: engineResult.hasConcurrentMovement,
          recommendation,
          discrepancyReason: line.discrepancy_reason,
          investigationNotes: line.investigation_notes,
          areaBreakdown: productAreas.map((pa) => ({
            areaId: pa.areaId,
            areaName: pa.areaName,
            countedQtyBase: pa.countedQtyBase,
          })),
          serialDetail,
          concurrentTransactions: productLedger.map((tx) => ({
            entryType: tx.entryType,
            sourceDocType: tx.sourceDocType,
            sourceDocId: tx.sourceDocId,
            quantityDeltaBase: tx.quantityDeltaBase,
            occurredAt: tx.occurredAt,
            createdAt: tx.createdAt,
          })),
        });
      }

      // Tandai reviewed_at pada sesi jika belum terisi
      if (!sessionRow.reviewed_at) {
        this.db.prepare(`
          UPDATE stock_opname_sessions
          SET reviewed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, now, sessionId);
      }
    });

    const matchCount = reconItems.filter((i) => i.reconciliationStatus === "MATCH").length;
    const surplusCount = reconItems.filter((i) => i.reconciliationStatus === "SURPLUS").length;
    const shortageCount = reconItems.filter((i) => i.reconciliationStatus === "SHORTAGE").length;
    const investigationCount = reconItems.filter(
      (i) => i.reconciliationStatus === "REQUIRES_RE_EVALUATION" || i.hasConcurrentMovement || Boolean(i.discrepancyReason)
    ).length;
    const netDiscrepancyQty = reconItems.reduce((acc, curr) => acc + curr.varianceQty, 0);

    return {
      session: {
        id: sessionRow.id,
        ownerId: sessionRow.owner_id,
        warehouseId: sessionRow.warehouse_id,
        warehouseName: sessionRow.warehouse_name,
        sessionNumber: sessionRow.session_number,
        title: sessionRow.title,
        scope: "ALL",
        scopeConfig: sessionRow.scope_config,
        status: sessionRow.status,
        startedAt: sessionRow.started_at,
        snapshotAt: sessionRow.snapshot_at,
        reviewedAt: sessionRow.reviewed_at ?? now,
        adjustedAt: sessionRow.adjusted_at,
        createdBy: sessionRow.created_by_email,
        note: sessionRow.note,
        itemCount: reconItems.length,
        varianceCount: surplusCount + shortageCount,
      },
      totalSku: reconItems.length,
      matchCount,
      surplusCount,
      shortageCount,
      investigationCount,
      netDiscrepancyQty,
      items: reconItems,
    };
  }

  /**
   * Menyimpan Catatan Investigasi Selisih (TASK-SO-05-03)
   * Menyimpan alasan dan catatan ke stock_opname_lines serta mencatat ke audit_logs.
   * Dilarang mengubah hasil hitungan fisik atau snapshot awal.
   */
  saveStockOpnameInvestigation(
    context: ActiveSecurityContext,
    input: {
      sessionId: string;
      productId: string;
      reason: string;
      notes?: string;
    }
  ): { success: boolean; productId: string; discrepancyReason: string; investigationNotes: string | null } {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, session_number, status
      FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_number: string;
      status: string;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    if (session.status === "ADJUSTED" || session.status === "COMPLETED" || session.status === "CANCELLED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi '${session.session_number}' berstatus '${session.status}' dan tidak dapat menerima catatan investigasi baru.`,
        409
      );
    }

    const cleanReason = (input.reason || "").trim();
    if (!cleanReason) {
      throw new AppError("ERR_VALIDATION", "Alasan investigasi selisih wajib diisi.", 400);
    }

    const cleanNotes = input.notes?.trim() || null;

    return this.db.transaction(() => {
      const line = this.db.prepare(`
        SELECT id, product_id, snapshot_qty, counted_qty, variance_qty
        FROM stock_opname_lines
        WHERE session_id = ? AND product_id = ?
      `).get(input.sessionId, input.productId) as {
        id: string;
        product_id: string;
        snapshot_qty: number;
        counted_qty: number;
        variance_qty: number;
      } | undefined;

      if (!line) {
        throw new AppError("ERR_NOT_FOUND", `Produk '${input.productId}' tidak terdaftar pada sesi ini.`, 404);
      }

      this.db.prepare(`
        UPDATE stock_opname_lines
        SET discrepancy_reason = ?, investigation_notes = ?
        WHERE id = ?
      `).run(cleanReason, cleanNotes, line.id);

      this.recordAudit(
        context.ownerId,
        session.warehouse_id,
        context.userId,
        "STOCK_OPNAME_INVESTIGATION_RECORDED",
        "STOCK_OPNAME_LINE",
        line.id,
        {
          sessionId: input.sessionId,
          sessionNumber: session.session_number,
          productId: input.productId,
          reason: cleanReason,
          notes: cleanNotes,
          snapshotQty: line.snapshot_qty,
          countedQty: line.counted_qty,
          varianceQty: line.variance_qty,
        }
      );

      return {
        success: true,
        productId: input.productId,
        discrepancyReason: cleanReason,
        investigationNotes: cleanNotes,
      };
    });
  }

  /**
   * Mengajukan sesi Stock Opname ke tahap Review (Phase 6)
   */
  submitStockOpnameForReview(
    context: ActiveSecurityContext,
    sessionId: string
  ): SubmitStockOpnameForReviewResult {
    this.assertContext(context);

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, session_number, status
      FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_number: string;
      status: string;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    if (session.status === "ADJUSTED" || session.status === "COMPLETED" || session.status === "CANCELLED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi '${session.session_number}' berstatus '${session.status}' dan tidak dapat diajukan ke review.`,
        409
      );
    }

    const now = new Date().toISOString();

    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE stock_opname_sessions
        SET status = 'REVIEW', reviewed_at = COALESCE(reviewed_at, ?), updated_at = ?
        WHERE id = ?
      `).run(now, now, sessionId);

      this.recordAudit(
        context.ownerId,
        session.warehouse_id,
        context.userId,
        "STOCK_OPNAME_SUBMITTED_FOR_REVIEW",
        "STOCK_OPNAME",
        session.id,
        {
          sessionId: session.id,
          sessionNumber: session.session_number,
          previousStatus: session.status,
          newStatus: "REVIEW",
        }
      );

      return {
        success: true,
        sessionId: session.id,
        status: "REVIEW",
        reviewedAt: now,
      };
    });
  }

  /**
   * Menyetujui dan Memposting Penyesuaian Stok ke Ledger (TASK-SO-06-01 & TASK-SO-06-02)
   * Dilindungi transaksi atomik:
   * 1. Validasi otorisasi Owner (403).
   * 2. Validasi status sesi dan idempotensi (409).
   * 3. Validasi kelengkapan area dan seluruh selisih diinvestigasi (400).
   * 4. Evaluasi ulang rekonsiliasi dinamis di dalam transaksi.
   * 5. Posting mutasi STOCK_ADJUSTMENT_POSTED untuk item selisih non-zero (skip selisih zero).
   * 6. Transisi status serial number (DECOMMISSIONED untuk hilang, AVAILABLE untuk surplus sah).
   * 7. Kunci sesi ke ADJUSTED (atau COMPLETED jika selisih 0) dan catat audit_logs.
   */
  approveAndPostStockOpnameAdjustment(
    context: ActiveSecurityContext,
    input: ApproveAndPostStockOpnameAdjustmentInput
  ): ApproveAndPostStockOpnameAdjustmentResult {
    this.assertContext(context);

    // 1. Guard Otorisasi Role Owner
    if (context.role !== "OWNER" && !context.isSuperAdminOnBehalf) {
      throw new AppError(
        "ERR_FORBIDDEN_ROLE",
        "Hanya pengguna dengan peran Owner yang berwenang menyetujui dan memposting penyesuaian Stock Opname.",
        403
      );
    }

    const session = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, session_number, title, status, snapshot_at, started_at, reviewed_at, note
      FROM stock_opname_sessions
      WHERE id = ? AND owner_id = ?
    `).get(input.sessionId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      session_number: string;
      title: string | null;
      status: string;
      snapshot_at: string | null;
      started_at: string;
      reviewed_at: string | null;
      note: string | null;
    } | undefined;

    if (!session) {
      throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
    }
    this.assertContext(context, session.warehouse_id);

    // 2. Guard Status Sesi & Idempotensi (Fast Fail Pre-Check)
    if (session.status === "ADJUSTED" || session.status === "COMPLETED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi Stock Opname '${session.session_number}' sudah difinalisasi sebelumnya (status: ${session.status}). Penyesuaian ganda ditolak.`,
        409
      );
    }

    if (session.status === "CANCELLED") {
      throw new AppError(
        "ERR_CONFLICT",
        `Sesi Stock Opname '${session.session_number}' telah dibatalkan dan tidak dapat disetujui.`,
        409
      );
    }

    if (session.status !== "COUNTING" && session.status !== "REVIEW") {
      throw new AppError(
        "ERR_CONFLICT",
        `Status sesi '${session.status}' tidak mengizinkan persetujuan penyesuaian.`,
        409
      );
    }

    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // 2b. Re-query Status Sesi & Idempotensi di Bawah Transaction Lock (Mencegah Race Condition Concurrency)
      const sessionInTx = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, session_number, title, status, snapshot_at, started_at, reviewed_at, note
        FROM stock_opname_sessions
        WHERE id = ? AND owner_id = ?
      `).get(input.sessionId, context.ownerId) as typeof session;

      if (!sessionInTx) {
        throw new AppError("ERR_NOT_FOUND", `Sesi Stock Opname '${input.sessionId}' tidak ditemukan.`, 404);
      }

      if (sessionInTx.status === "ADJUSTED" || sessionInTx.status === "COMPLETED") {
        throw new AppError(
          "ERR_CONFLICT",
          `Sesi Stock Opname '${sessionInTx.session_number}' sudah difinalisasi sebelumnya (status: ${sessionInTx.status}). Penyesuaian ganda ditolak.`,
          409
        );
      }

      if (sessionInTx.status === "CANCELLED") {
        throw new AppError(
          "ERR_CONFLICT",
          `Sesi Stock Opname '${sessionInTx.session_number}' telah dibatalkan dan tidak dapat disetujui.`,
          409
        );
      }

      if (sessionInTx.status !== "COUNTING" && sessionInTx.status !== "REVIEW") {
        throw new AppError(
          "ERR_CONFLICT",
          `Status sesi '${sessionInTx.status}' tidak mengizinkan persetujuan penyesuaian.`,
          409
        );
      }

      const existingLedgerCount = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM inventory_ledger
        WHERE source_doc_id = ? AND source_doc_type = 'STOCK_OPNAME_ADJUSTMENT'
      `).get(sessionInTx.id) as { count: number };

      if (Number(existingLedgerCount.count) > 0) {
        throw new AppError(
          "ERR_CONFLICT",
          `Sesi Stock Opname '${sessionInTx.session_number}' sudah memiliki mutasi ledger penyesuaian. Permintaan duplikat ditolak.`,
          409
        );
      }

      // 3. Validasi Area Penghitungan
      const activeAreas = this.db.prepare(`
        SELECT id, name, status
        FROM stock_opname_areas
        WHERE session_id = ? AND status != 'CANCELLED'
      `).all(sessionInTx.id) as Array<{ id: string; name: string; status: string }>;

      if (activeAreas.length === 0) {
        throw new AppError(
          "ERR_VALIDATION",
          "Sesi Stock Opname tidak memiliki area penghitungan aktif.",
          400
        );
      }

      const uncompletedAreas = activeAreas.filter((a) => a.status !== "COMPLETED");
      if (uncompletedAreas.length > 0) {
        if (input.autoCompletePendingAreas) {
          this.db.prepare(`
            UPDATE stock_opname_areas
            SET status = 'COMPLETED', updated_at = ?
            WHERE session_id = ? AND status != 'CANCELLED' AND status != 'COMPLETED'
          `).run(now, session.id);
        } else {
          throw new AppError(
            "ERR_VALIDATION",
            `Area penghitungan '${uncompletedAreas[0].name}' masih berstatus '${uncompletedAreas[0].status}'. Seluruh area wajib diselesaikan (COMPLETED) sebelum persetujuan final.`,
            400
          );
        }
      }

      // 4. Evaluasi Ulang Rekonsiliasi Dinamis (Fresh di dalam Transaksi)
      const reconSummary = this.evaluateStockOpnameReconciliation(context, session.id);

      // Guard: Cek apakah ada produk berstatus REQUIRES_RE_EVALUATION yang belum diinvestigasi
      const requiresReeval = reconSummary.items.find(
        (i) => i.reconciliationStatus === "REQUIRES_RE_EVALUATION" && (!i.discrepancyReason || !i.discrepancyReason.trim())
      );
      if (requiresReeval) {
        throw new AppError(
          "ERR_VALIDATION",
          `Produk '${requiresReeval.sku} - ${requiresReeval.productName}' berstatus 'REQUIRES_RE_EVALUATION'. Selesaikan investigasi serial atau berikan alasan investigasi sebelum persetujuan final.`,
          400
        );
      }

      // Guard: Cek apakah ada selisih yang belum diinvestigasi
      const uninvestigated = reconSummary.items.find(
        (i) => i.varianceQty !== 0 && (!i.discrepancyReason || !i.discrepancyReason.trim())
      );
      if (uninvestigated) {
        throw new AppError(
          "ERR_VALIDATION",
          `Produk '${uninvestigated.sku} - ${uninvestigated.productName}' memiliki selisih kuantitas (${
            uninvestigated.varianceQty > 0 ? `+${uninvestigated.varianceQty}` : uninvestigated.varianceQty
          } ${uninvestigated.unit}), namun belum memiliki alasan investigasi yang valid.`,
          400
        );
      }

      let ledgerEntriesCreated = 0;
      let totalAdjustedLines = 0;
      const adjustmentAuditList: Array<{
        productId: string;
        sku: string;
        productName: string;
        varianceQty: number;
        unit: string;
        ledgerId?: string;
        sequenceNumber?: number;
      }> = [];
      const serialTransitionsList: Array<{
        serialNumber: string;
        productId: string;
        action: "DECOMMISSIONED" | "REGISTERED_AVAILABLE";
      }> = [];

      // 5. Posting Mutasi ke Inventory Ledger (Hanya untuk selisih != 0)
      for (const item of reconSummary.items) {
        if (item.varianceQty === 0) {
          // Tandai baris tanpa penulisan ledger
          this.db.prepare(`
            UPDATE stock_opname_lines
            SET adjustment_posted = 1
            WHERE id = ?
          `).run(item.id);
          continue;
        }

        // Kumpulkan affected serial IDs jika produk bertipe SERIAL
        const affectedSerialIds: string[] = [];

        if (item.trackingMode === "SERIAL" && item.serialDetail) {
          // a. Serial yang hilang (missing) dan BUKAN legal keluar pasca-snapshot:
          // Ubah status di product_serials menjadi DECOMMISSIONED
          const unaccountedMissing = item.serialDetail.missingSerials.filter(
            (ms) => !ms.dispatchedPostSnapshot
          );

          for (const ms of unaccountedMissing) {
            const foundPs = this.db.prepare(`
              SELECT id, status
              FROM product_serials
              WHERE owner_id = ? AND warehouse_id = ? AND (serial_number = ? OR normalized_serial_number = ?)
            `).get(context.ownerId, sessionInTx.warehouse_id, ms.serialNumber, ms.normalized) as { id: string; status: string } | undefined;

            if (foundPs) {
              if (foundPs.status === "RESERVED") {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial '${ms.serialNumber}' sedang direservasi ('RESERVED') untuk pengeluaran barang. Selesaikan atau batalkan reservasi terlebih dahulu sebelum dekomisi.`,
                  409
                );
              }
              if (foundPs.status === "CONSUMED_OUT" || foundPs.status === "DECOMMISSIONED") {
                continue;
              }

              affectedSerialIds.push(foundPs.id);
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'DECOMMISSIONED', updated_at = ?
                WHERE id = ?
              `).run(now, foundPs.id);

              serialTransitionsList.push({
                serialNumber: ms.serialNumber,
                productId: item.productId,
                action: "DECOMMISSIONED",
              });
            }
          }

          // b. Serial surplus fisik (terhitung tapi tidak di snapshot) dan BUKAN legal masuk pasca-snapshot:
          const unaccountedSurplus = item.serialDetail.surplusSerials.filter(
            (ss) => !ss.receivedPostSnapshot && ss.source === "SCANNED"
          );

          for (const ss of unaccountedSurplus) {
            const existingPs = this.db.prepare(`
              SELECT id, status, warehouse_id, product_id
              FROM product_serials
              WHERE owner_id = ? AND (serial_number = ? OR normalized_serial_number = ?)
            `).get(context.ownerId, ss.serialNumber, ss.normalized) as {
              id: string;
              status: string;
              warehouse_id: string;
              product_id: string;
            } | undefined;

            if (existingPs) {
              // 1. Validasi Produk: Serial tidak boleh milik produk lain
              if (existingPs.product_id !== item.productId) {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial '${ss.serialNumber}' sudah terdaftar untuk produk lain di sistem. Penyesuaian fisik surplus ditolak.`,
                  409
                );
              }

              // 2. Validasi Lintas Gudang: SN aktif di gudang lain tidak boleh diambil alih tanpa alur transfer
              if (
                existingPs.warehouse_id !== sessionInTx.warehouse_id &&
                (existingPs.status === "AVAILABLE" ||
                  existingPs.status === "RESERVED" ||
                  existingPs.status === "QUARANTINE")
              ) {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Konflik SN Lintas Gudang: Serial '${ss.serialNumber}' sedang aktif di gudang lain (status: ${existingPs.status}). Penyesuaian fisik surplus ditolak; gunakan alur mutasi/transfer resmi.`,
                  409
                );
              }

              // 3. Validasi Status Terdistribusi / Konsumsi
              if (existingPs.status === "CONSUMED_OUT") {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial '${ss.serialNumber}' berstatus 'CONSUMED_OUT' (sudah keluar/terjual). Penyesuaian surplus tidak dapat menghidupkan kembali serial yang sudah terdistribusi tanpa dokumen retur resmi.`,
                  409
                );
              }

              // 4. Validasi Reservasi Aktif
              if (existingPs.status === "RESERVED") {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial '${ss.serialNumber}' sedang direservasi ('RESERVED') untuk pengeluaran barang. Selesaikan atau batalkan reservasi terlebih dahulu.`,
                  409
                );
              }

              // 5. Validasi Karantina / Rusak
              if (existingPs.status === "QUARANTINE") {
                throw new AppError(
                  "ERR_CONFLICT",
                  `Serial '${ss.serialNumber}' berstatus 'QUARANTINE' (karantina/rusak). Serial rusak tidak dapat disesuaikan otomatis menjadi 'AVAILABLE'.`,
                  409
                );
              }

              affectedSerialIds.push(existingPs.id);
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'AVAILABLE', warehouse_id = ?, updated_at = ?
                WHERE id = ?
              `).run(sessionInTx.warehouse_id, now, existingPs.id);

              serialTransitionsList.push({
                serialNumber: ss.serialNumber,
                productId: item.productId,
                action: "REGISTERED_AVAILABLE",
              });
            } else {
              const newPsId = crypto.randomUUID();
              affectedSerialIds.push(newPsId);
              this.db.prepare(`
                INSERT INTO product_serials (
                  id, owner_id, warehouse_id, product_id, serial_number,
                  normalized_serial_number, status, unit, unit_quantity, base_quantity,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, 1, 1, ?, ?)
              `).run(
                newPsId,
                context.ownerId,
                sessionInTx.warehouse_id,
                item.productId,
                ss.serialNumber,
                ss.normalized,
                item.unit || "pcs",
                now,
                now
              );

              serialTransitionsList.push({
                serialNumber: ss.serialNumber,
                productId: item.productId,
                action: "REGISTERED_AVAILABLE",
              });
            }
          }
        }

        // Tulis entri mutasi resmi ke inventory_ledger
        const nextSeq = this.getNextLedgerSequence(context.ownerId);
        const ledgerId = crypto.randomUUID();

        this.db.prepare(`
          INSERT INTO inventory_ledger (
            id, sequence_number, owner_id, warehouse_id, product_id,
            location_id, entry_type, source_doc_type, source_doc_id,
            source_line_id, quantity_delta_base, serial_ids_json,
            actor_user_id, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'STOCK_ADJUSTMENT_POSTED', 'STOCK_OPNAME_ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ledgerId,
          nextSeq,
          context.ownerId,
          sessionInTx.warehouse_id,
          item.productId,
          sessionInTx.id,
          item.id,
          item.varianceQty, // Positif jika surplus, negatif jika shortage
          affectedSerialIds.length > 0 ? JSON.stringify(affectedSerialIds) : null,
          context.userId,
          now,
          now
        );

        // Tandai baris di stock_opname_lines
        this.db.prepare(`
          UPDATE stock_opname_lines
          SET adjustment_posted = 1
          WHERE id = ?
        `).run(item.id);

        ledgerEntriesCreated++;
        totalAdjustedLines++;
        adjustmentAuditList.push({
          productId: item.productId,
          sku: item.sku,
          productName: item.productName,
          varianceQty: item.varianceQty,
          unit: item.unit,
          ledgerId,
          sequenceNumber: nextSeq,
        });
      }

      // 6. Kunci Status Sesi Secara Permanen
      const finalStatus = "ADJUSTED";
      const cleanNotes = input.notes?.trim() || null;

      this.db.prepare(`
        UPDATE stock_opname_sessions
        SET status = ?,
            reviewed_at = COALESCE(reviewed_at, ?),
            adjusted_at = ?,
            approved_by_user_id = ?,
            finalized_by_user_id = ?,
            note = CASE 
              WHEN ? IS NOT NULL THEN COALESCE(note || ' | Persetujuan: ', 'Persetujuan: ') || ?
              ELSE note 
            END,
            updated_at = ?
        WHERE id = ?
      `).run(
        finalStatus,
        now,
        now,
        context.userId,
        context.userId,
        cleanNotes,
        cleanNotes,
        now,
        sessionInTx.id
      );

      // Arsipkan seluruh sisa error scan pada sesi ini
      this.db.prepare(`
        UPDATE stock_opname_scan_errors
        SET is_archived = 1
        WHERE session_id = ? AND is_archived = 0
      `).run(sessionInTx.id);

      // 7. Catat Jejak Audit Permanen
      this.recordAudit(
        context.ownerId,
        sessionInTx.warehouse_id,
        context.userId,
        "STOCK_OPNAME_FINALIZED",
        "STOCK_OPNAME",
        sessionInTx.id,
        {
          sessionId: session.id,
          sessionNumber: session.session_number,
          approvedByUserId: context.userId,
          previousStatus: session.status,
          finalStatus,
          notes: cleanNotes,
          totalLines: reconSummary.items.length,
          totalAdjustedLines,
          totalVarianceQty: reconSummary.netDiscrepancyQty,
          ledgerEntriesCreated,
          adjustments: adjustmentAuditList,
          serialTransitions: serialTransitionsList,
        }
      );

      return {
        success: true,
        sessionId: session.id,
        sessionNumber: session.session_number,
        status: finalStatus,
        totalLines: reconSummary.items.length,
        totalAdjustedLines,
        totalVarianceQty: reconSummary.netDiscrepancyQty,
        ledgerEntriesCreated,
        approvedAt: now,
        approvedByUserId: context.userId,
      };
    });
  }

  /**
   * Mengambil data terpadu untuk Laporan Inventaris
   */
  getReportsData(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): {
    products: ProductRecord[];
    ledger: Array<{
      id: string;
      entryType: string;
      sourceDocType: string;
      quantityDelta: number;
      actorUserId: string;
      occurredAt: string;
      productName?: string;
      sku?: string;
    }>;
    serials: SerialRecord[];
  } {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    const products = this.getProductsByOwner(context, targetWh ?? undefined);

    let ledgerQuery = `
      SELECT l.id, l.entry_type, l.source_doc_type, l.quantity_delta_base,
             l.actor_user_id, l.occurred_at, p.name as product_name, p.sku
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id
      WHERE l.owner_id = ?
    `;
    const ledgerParams: unknown[] = [context.ownerId];
    if (targetWh) {
      ledgerQuery += ` AND l.warehouse_id = ?`;
      ledgerParams.push(targetWh);
    }
    ledgerQuery += ` ORDER BY l.occurred_at DESC LIMIT 100`;

    const ledgerRows = this.db.prepare(ledgerQuery).all(...ledgerParams) as Array<{
      id: string;
      entry_type: string;
      source_doc_type: string;
      quantity_delta_base: number;
      actor_user_id: string;
      occurred_at: string;
      product_name: string;
      sku: string;
    }>;

    let serialsQuery = `
      SELECT ps.id, ps.owner_id, ps.warehouse_id, ps.product_id,
             ps.serial_number, ps.normalized_serial_number, ps.status,
             ps.created_at, ps.updated_at
      FROM product_serials ps
      WHERE ps.owner_id = ?
    `;
    const serialsParams: unknown[] = [context.ownerId];
    if (targetWh) {
      serialsQuery += ` AND ps.warehouse_id = ?`;
      serialsParams.push(targetWh);
    }
    serialsQuery += ` ORDER BY ps.created_at DESC`;

    const serialRows = this.db.prepare(serialsQuery).all(...serialsParams) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      product_id: string;
      serial_number: string;
      normalized_serial_number: string;
      status: "AVAILABLE" | "RESERVED" | "QUARANTINE" | "CONSUMED_OUT" | "DECOMMISSIONED";
      created_at: string;
      updated_at: string;
    }>;

    return {
      products,
      ledger: ledgerRows.map((r) => ({
        id: r.id,
        entryType: r.entry_type,
        sourceDocType: r.source_doc_type,
        quantityDelta: Number(r.quantity_delta_base),
        actorUserId: r.actor_user_id,
        occurredAt: r.occurred_at,
        productName: r.product_name,
        sku: r.sku,
      })),
      serials: serialRows.map((s) => ({
        id: s.id,
        ownerId: s.owner_id,
        warehouseId: s.warehouse_id,
        productId: s.product_id,
        serialNumber: s.serial_number,
        normalizedSerialNumber: s.normalized_serial_number,
        status: s.status,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
    };
  }

  // ====================================================================
  // PURCHASE ORDERS (PO)
  // ====================================================================

  /**
   * Mengambil daftar Purchase Orders milik Owner
   */
  getPurchaseOrders(
    context: ActiveSecurityContext,
    filter?: { status?: string; warehouseId?: string }
  ): PurchaseOrderRecord[] {
    this.assertContext(context);

    let query = `
      SELECT po.id, po.owner_id, po.warehouse_id, po.customer_id, c.name as customer_name,
             po.po_number, po.order_date, po.status, po.total_amount, po.notes,
             po.sales_pic, po.approved_by_user_id, po.approved_at,
             po.rejected_by_user_id, po.rejected_at, po.rejection_reason,
             po.created_by_user_id, po.created_at,
             (SELECT cd.id FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_id,
             (SELECT cd.document_number FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_number,
             (SELECT cd.status FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_status
      FROM purchase_orders po
      JOIN customers c ON c.id = po.customer_id
      WHERE po.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    const targetWarehouseId = filter?.warehouseId || (context.role !== "SUPER_ADMIN" ? context.warehouseId : undefined);
    if (targetWarehouseId) {
      query += ` AND (po.warehouse_id = ? OR po.warehouse_id IS NULL)`;
      params.push(targetWarehouseId);
    }

    if (filter?.status && filter.status !== "ALL") {
      query += ` AND po.status = ?`;
      params.push(filter.status);
    }

    query += ` ORDER BY po.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string | null;
      customer_id: string;
      customer_name: string;
      po_number: string;
      order_date: string;
      status: PurchaseOrderStatus;
      total_amount: number;
      notes: string | null;
      sales_pic: string | null;
      approved_by_user_id: string | null;
      approved_at: string | null;
      rejected_by_user_id: string | null;
      rejected_at: string | null;
      rejection_reason: string | null;
      created_by_user_id: string;
      created_at: string;
      invoice_id?: string | null;
      invoice_number?: string | null;
      invoice_status?: string | null;
    }>;

    const lineStmt = this.db.prepare(`
      SELECT pol.id, pol.po_id, pol.product_id, pol.raw_product_name, pol.ordered_qty,
             pol.ordered_unit, pol.conversion_factor, pol.mapping_status,
             pol.target_qty, pol.fulfilled_qty, pol.unit_price, pol.discount_amount,
             p.name as catalog_name, p.sku
      FROM purchase_order_lines pol
      LEFT JOIN products p ON p.id = pol.product_id
      WHERE pol.po_id = ?
    `);

    return rows.map((r) => {
      const lineRows = lineStmt.all(r.id) as Array<{
        id: string;
        po_id: string;
        product_id: string | null;
        raw_product_name: string;
        ordered_qty: number;
        ordered_unit: PoOrderedUnit;
        conversion_factor: number;
        mapping_status: PoMappingStatus;
        target_qty: number;
        fulfilled_qty: number;
        unit_price: number;
        discount_amount: number;
        catalog_name: string | null;
        sku: string | null;
      }>;

      return {
        id: r.id,
        ownerId: r.owner_id,
        warehouseId: r.warehouse_id,
        customerId: r.customer_id,
        customerName: r.customer_name,
        poNumber: r.po_number,
        orderDate: r.order_date,
        status: r.status,
        totalAmount: Number(r.total_amount),
        notes: r.notes,
        salesPic: r.sales_pic,
        createdByUserId: r.created_by_user_id,
        approvedByUserId: r.approved_by_user_id,
        approvedAt: r.approved_at,
        rejectedByUserId: r.rejected_by_user_id,
        rejectedAt: r.rejected_at,
        rejectionReason: r.rejection_reason,
        createdAt: r.created_at,
        invoiceId: r.invoice_id ?? null,
        invoiceNumber: r.invoice_number ?? null,
        invoiceStatus: r.invoice_status ?? null,
        lines: lineRows.map((l) => ({
          id: l.id,
          productId: l.product_id,
          productName: l.catalog_name ?? l.raw_product_name,
          rawProductName: l.raw_product_name,
          sku: l.sku ?? undefined,
          orderedQty: Number(l.ordered_qty),
          orderedUnit: l.ordered_unit,
          conversionFactor: Number(l.conversion_factor),
          mappingStatus: l.mapping_status,
          targetQty: Number(l.target_qty),
          fulfilledQty: Number(l.fulfilled_qty),
          unitPrice: Number(l.unit_price),
          discountAmount: Number(l.discount_amount),
        })),
      };
    });
  }

  /**
   * Mengambil detail Purchase Order berdasarkan ID
   */
  getPurchaseOrderById(context: ActiveSecurityContext, id: string): PurchaseOrderRecord | null {
    this.assertContext(context);

    const r = this.db.prepare(`
      SELECT po.id, po.owner_id, po.warehouse_id, po.customer_id, c.name as customer_name,
             po.po_number, po.order_date, po.status, po.total_amount, po.notes,
             po.sales_pic, po.approved_by_user_id, po.approved_at,
             po.rejected_by_user_id, po.rejected_at, po.rejection_reason,
             po.created_by_user_id, po.created_at,
             (SELECT cd.id FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_id,
             (SELECT cd.document_number FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_number,
             (SELECT cd.status FROM commercial_documents cd WHERE cd.po_id = po.id AND cd.document_type = 'INVOICE' AND cd.status != 'CANCELLED' LIMIT 1) AS invoice_status
      FROM purchase_orders po
      JOIN customers c ON c.id = po.customer_id
      WHERE po.id = ? AND po.owner_id = ?
    `).get(id, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string | null;
      customer_id: string;
      customer_name: string;
      po_number: string;
      order_date: string;
      status: PurchaseOrderStatus;
      total_amount: number;
      notes: string | null;
      sales_pic: string | null;
      approved_by_user_id: string | null;
      approved_at: string | null;
      rejected_by_user_id: string | null;
      rejected_at: string | null;
      rejection_reason: string | null;
      created_by_user_id: string;
      created_at: string;
      invoice_id?: string | null;
      invoice_number?: string | null;
      invoice_status?: string | null;
    } | undefined;

    if (!r) return null;

    const lineRows = this.db.prepare(`
      SELECT pol.id, pol.po_id, pol.product_id, pol.raw_product_name, pol.ordered_qty,
             pol.ordered_unit, pol.conversion_factor, pol.mapping_status,
             pol.target_qty, pol.fulfilled_qty, pol.unit_price, pol.discount_amount,
             p.name as catalog_name, p.sku
      FROM purchase_order_lines pol
      LEFT JOIN products p ON p.id = pol.product_id
      WHERE pol.po_id = ?
    `).all(r.id) as Array<{
      id: string;
      po_id: string;
      product_id: string | null;
      raw_product_name: string;
      ordered_qty: number;
      ordered_unit: PoOrderedUnit;
      conversion_factor: number;
      mapping_status: PoMappingStatus;
      target_qty: number;
      fulfilled_qty: number;
      unit_price: number;
      discount_amount: number;
      catalog_name: string | null;
      sku: string | null;
    }>;

    return {
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      poNumber: r.po_number,
      orderDate: r.order_date,
      status: r.status,
      totalAmount: Number(r.total_amount),
      notes: r.notes,
      salesPic: r.sales_pic,
      createdByUserId: r.created_by_user_id,
      approvedByUserId: r.approved_by_user_id,
      approvedAt: r.approved_at,
      rejectedByUserId: r.rejected_by_user_id,
      rejectedAt: r.rejected_at,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
      invoiceId: r.invoice_id ?? null,
      invoiceNumber: r.invoice_number ?? null,
      invoiceStatus: r.invoice_status ?? null,
      lines: lineRows.map((l) => ({
        id: l.id,
        productId: l.product_id,
        productName: l.catalog_name ?? l.raw_product_name,
        rawProductName: l.raw_product_name,
        sku: l.sku ?? undefined,
        orderedQty: Number(l.ordered_qty),
        orderedUnit: l.ordered_unit,
        conversionFactor: Number(l.conversion_factor),
        mappingStatus: l.mapping_status,
        targetQty: Number(l.target_qty),
        fulfilledQty: Number(l.fulfilled_qty),
        unitPrice: Number(l.unit_price),
        discountAmount: Number(l.discount_amount),
      })),
    };
  }

  /**
   * Membuat Purchase Order baru (Mobile-First, PIC Sales otomatis, Multiplier Satuan, & Pemetaan Produk)
   */
  createPurchaseOrder(
    context: ActiveSecurityContext,
    input: CreatePurchaseOrderInput
  ): PurchaseOrderRecord {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN" && context.role !== "STAFF" && context.role !== "SALES") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Anda tidak memiliki wewenang untuk membuat Purchase Order.", 403);
    }

    if ((!input.customerId && !input.newCustomerName?.trim()) || !input.poNumber || !input.lines || input.lines.length === 0) {
      throw new AppError("ERR_VALIDATION", "Pelanggan, nomor PO, dan minimal 1 produk wajib diisi.", 400);
    }

    const poId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Resolusi PIC Sales: jika diberikan, gunakan; jika tidak, ambil nama pengguna dari database atau email
    let resolvedSalesPic = input.salesPic?.trim();
    if (!resolvedSalesPic) {
      const userRow = this.db.prepare("SELECT full_name FROM users WHERE id = ?").get(context.userId) as { full_name: string } | undefined;
      resolvedSalesPic = userRow?.full_name || context.email || "Sales";
    }

    // Resolusi Gudang PO & validasi akses multi-gudang
    const resolvedWarehouseId =
      input.warehouseId ||
      context.warehouseId ||
      (this.db.prepare("SELECT id FROM warehouses WHERE owner_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1").get(context.ownerId) as { id: string } | undefined)?.id ||
      null;

    if (resolvedWarehouseId) {
      const whRow = this.db.prepare("SELECT id FROM warehouses WHERE id = ? AND owner_id = ?").get(resolvedWarehouseId, context.ownerId);
      if (!whRow) {
        throw new AppError("ERR_NOT_FOUND", "Gudang yang ditentukan tidak ditemukan untuk Owner ini.", 404);
      }
      if ((context.role === "STAFF" || context.role === "SALES") && context.warehouseId && context.warehouseId !== resolvedWarehouseId) {
        throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Anda tidak memiliki akses ke gudang ini.", 403);
      }
    }

    // Status awal PO:
    // Jika eksplisit ditentukan, ikuti;
    // Jika dibuat Sales -> PENDING_APPROVAL;
    // Jika dibuat Owner/SuperAdmin dan tidak ditentukan -> CONFIRMED (mempertahankan backward compatibility);
    // Lainnya -> PENDING_APPROVAL.
    let initialStatus: PurchaseOrderStatus = "PENDING_APPROVAL";
    if (input.status) {
      initialStatus = input.status;
    } else if (context.role === "SALES") {
      initialStatus = "PENDING_APPROVAL";
    } else if (context.role === "OWNER" || context.role === "SUPER_ADMIN") {
      initialStatus = "CONFIRMED";
    }

    // Olah dan validasi baris pesanan
    let computedTotal = 0;
    const processedLines: Array<{
      id: string;
      productId: string | null;
      rawProductName: string;
      orderedQty: number;
      orderedUnit: PoOrderedUnit;
      conversionFactor: number;
      mappingStatus: PoMappingStatus;
      targetQty: number;
      unitPrice: number;
      discountAmount: number;
      productName?: string;
      sku?: string;
    }> = [];

    for (let idx = 0; idx < input.lines.length; idx++) {
      const l = input.lines[idx];
      const orderedQty = Number(l.orderedQty ?? l.targetQty ?? 0);
      if (isNaN(orderedQty) || orderedQty <= 0) {
        throw new AppError("ERR_VALIDATION", `Item pesanan #${idx + 1}: Jumlah pesanan harus lebih besar dari nol.`, 400);
      }

      // Normalisasi satuan (PCS atau Lusin)
      const rawUnit = (l.orderedUnit || "PCS").trim();
      const cleanUnit = rawUnit.toLowerCase();
      let orderedUnit: PoOrderedUnit = "PCS";
      let conversionFactor = 1;

      if (cleanUnit === "lusin" || cleanUnit === "dozen") {
        orderedUnit = "Lusin";
        conversionFactor = 12;
      } else {
        orderedUnit = "PCS";
        conversionFactor = 1;
      }

      // Kuantitas target dasar (ekuivalen pcs)
      const targetQty = l.targetQty !== undefined ? Number(l.targetQty) : (orderedQty * conversionFactor);
      const unitPrice = Number(l.unitPrice) || 0;
      const discountAmount = Number(l.discountAmount) || 0;

      computedTotal += (targetQty * unitPrice) - discountAmount;

      let productId: string | null = null;
      let rawProductName = "";
      let mappingStatus: PoMappingStatus = "UNMAPPED";
      let productName: string | undefined = undefined;
      let sku: string | undefined = undefined;

      const cleanRawName = (l.rawProductName || "").trim();

      if (!l.productId && !cleanRawName) {
        throw new AppError(
          "ERR_VALIDATION",
          `Item pesanan #${idx + 1}: Nama barang pesanan wajib diisi.`,
          400
        );
      }

      if (l.productId) {
        const prod = this.db.prepare(`
          SELECT id, name, sku FROM products WHERE id = ? AND owner_id = ? AND status = 'ACTIVE'
        `).get(l.productId, context.ownerId) as { id: string; name: string; sku: string } | undefined;

        if (!prod) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `Item pesanan #${idx + 1}: Produk katalog tidak ditemukan atau tidak aktif pada Owner ini. Daftarkan produk terlebih dahulu melalui Master Produk atau alur Goods In.`,
            404
          );
        }

        productId = prod.id;
        productName = prod.name;
        sku = prod.sku;
        rawProductName = cleanRawName || prod.name;
        mappingStatus = "CATALOG_MATCHED";
      } else {
        productId = null;
        productName = cleanRawName;
        sku = "-";
        rawProductName = cleanRawName;
        mappingStatus = "UNMAPPED";
      }

      processedLines.push({
        id: crypto.randomUUID(),
        productId,
        rawProductName,
        orderedQty,
        orderedUnit,
        conversionFactor,
        mappingStatus,
        targetQty,
        unitPrice,
        discountAmount,
        productName,
        sku,
      });
    }

    const finalTotal = Math.max(0, computedTotal);

    return this.db.transaction(() => {
      let effectiveCustomerId = input.customerId?.trim() || "";
      if (!effectiveCustomerId && input.newCustomerName?.trim()) {
        const createdCustomer = this.createCustomer(context, {
          name: input.newCustomerName.trim(),
          ownerName: input.newCustomerOwnerName?.trim() || undefined,
          picSales: resolvedSalesPic,
          phone: input.newCustomerPhone?.trim() || undefined,
          email: input.newCustomerEmail?.trim() || undefined,
          address: input.newCustomerAddress?.trim() || undefined,
        });
        effectiveCustomerId = createdCustomer.id;
      }

      if (!effectiveCustomerId) {
        throw new AppError("ERR_VALIDATION", "Pelanggan wajib dipilih atau dimasukkan.", 400);
      }

      this.db.prepare(`
        INSERT INTO purchase_orders (
          id, owner_id, warehouse_id, customer_id, po_number, order_date,
          status, total_amount, notes, sales_pic,
          approved_by_user_id, approved_at, rejected_by_user_id, rejected_at,
          rejection_reason, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        poId,
        context.ownerId,
        resolvedWarehouseId,
        effectiveCustomerId,
        input.poNumber.trim().toUpperCase(),
        input.orderDate,
        initialStatus,
        finalTotal,
        input.notes ?? null,
        resolvedSalesPic,
        initialStatus === "CONFIRMED" ? context.userId : null,
        initialStatus === "CONFIRMED" ? now : null,
        null,
        null,
        null,
        context.userId,
        now,
        now
      );

      const lineInsert = this.db.prepare(`
        INSERT INTO purchase_order_lines (
          id, po_id, product_id, raw_product_name, ordered_qty, ordered_unit,
          conversion_factor, mapping_status, target_qty, fulfilled_qty,
          unit_price, discount_amount, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `);

      for (const pl of processedLines) {
        lineInsert.run(
          pl.id,
          poId,
          pl.productId,
          pl.rawProductName,
          pl.orderedQty,
          pl.orderedUnit,
          pl.conversionFactor,
          pl.mappingStatus,
          pl.targetQty,
          pl.unitPrice,
          pl.discountAmount,
          now
        );
      }

      this.recordAudit(
        context.ownerId,
        resolvedWarehouseId,
        context.userId,
        "CREATE_PURCHASE_ORDER",
        "PURCHASE_ORDER",
        poId,
        {
          poNumber: input.poNumber,
          status: initialStatus,
          salesPic: resolvedSalesPic,
          lineCount: processedLines.length,
          totalAmount: finalTotal,
        }
      );

      const customerRow = this.db.prepare("SELECT name FROM customers WHERE id = ?").get(effectiveCustomerId) as { name: string } | undefined;
      const effectiveCustomerName = customerRow?.name || input.newCustomerName?.trim() || "Pelanggan";

      return {
        id: poId,
        ownerId: context.ownerId,
        warehouseId: resolvedWarehouseId,
        customerId: effectiveCustomerId,
        customerName: effectiveCustomerName,
        poNumber: input.poNumber,
        orderDate: input.orderDate,
        status: initialStatus,
        totalAmount: finalTotal,
        notes: input.notes ?? null,
        salesPic: resolvedSalesPic,
        createdByUserId: context.userId,
        approvedByUserId: initialStatus === "CONFIRMED" ? context.userId : null,
        approvedAt: initialStatus === "CONFIRMED" ? now : null,
        createdAt: now,
        lines: processedLines.map((pl) => ({
          id: pl.id,
          productId: pl.productId,
          productName: pl.productName ?? pl.rawProductName,
          rawProductName: pl.rawProductName,
          sku: pl.sku,
          orderedQty: pl.orderedQty,
          orderedUnit: pl.orderedUnit,
          conversionFactor: pl.conversionFactor,
          mappingStatus: pl.mappingStatus,
          targetQty: pl.targetQty,
          fulfilledQty: 0,
          unitPrice: pl.unitPrice,
          discountAmount: pl.discountAmount,
        })),
      };
    });
  }

  /**
   * Menyetujui Purchase Order oleh Owner
   */
  approvePurchaseOrder(context: ActiveSecurityContext, poId: string): PurchaseOrderRecord {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Hanya Owner atau Super Admin yang berwenang menyetujui Purchase Order.", 403);
    }

    const po = this.db.prepare(`
      SELECT id, owner_id, status FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(poId, context.ownerId) as { id: string; owner_id: string; status: PurchaseOrderStatus } | undefined;

    if (!po) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan pada Owner ini.", 404);
    }

    if (po.status === "CONFIRMED") {
      return this.getPurchaseOrderById(context, poId)!;
    }

    if (po.status !== "PENDING_APPROVAL" && po.status !== "DRAFT") {
      throw new AppError("ERR_CONFLICT", `Purchase Order tidak dapat disetujui karena berstatus '${po.status}'.`, 409);
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE purchase_orders
      SET status = 'CONFIRMED', approved_by_user_id = ?, approved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(context.userId, now, now, poId);

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "APPROVE_PURCHASE_ORDER",
      "PURCHASE_ORDER",
      poId,
      { previousStatus: po.status, newStatus: "CONFIRMED" }
    );

    const updated = this.getPurchaseOrderById(context, poId);
    if (!updated) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan setelah persetujuan.", 404);
    }
    return updated;
  }

  /**
   * Menolak Purchase Order oleh Owner
   */
  rejectPurchaseOrder(context: ActiveSecurityContext, poId: string, reason?: string): PurchaseOrderRecord {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Hanya Owner atau Super Admin yang berwenang menolak Purchase Order.", 403);
    }

    const po = this.db.prepare(`
      SELECT id, owner_id, status FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(poId, context.ownerId) as { id: string; owner_id: string; status: PurchaseOrderStatus } | undefined;

    if (!po) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan pada Owner ini.", 404);
    }

    if (po.status === "REJECTED") {
      return this.getPurchaseOrderById(context, poId)!;
    }

    if (po.status !== "PENDING_APPROVAL" && po.status !== "DRAFT") {
      throw new AppError("ERR_CONFLICT", `Purchase Order tidak dapat ditolak karena berstatus '${po.status}'.`, 409);
    }

    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE purchase_orders
      SET status = 'REJECTED', rejected_by_user_id = ?, rejected_at = ?, rejection_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(context.userId, now, reason?.trim() || null, now, poId);

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "REJECT_PURCHASE_ORDER",
      "PURCHASE_ORDER",
      poId,
      { previousStatus: po.status, newStatus: "REJECTED", reason }
    );

    const updated = this.getPurchaseOrderById(context, poId);
    if (!updated) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan setelah penolakan.", 404);
    }
    return updated;
  }

  /**
   * Memperbarui PIC Sales pada Purchase Order oleh Owner
   */
  updatePurchaseOrderSalesPic(context: ActiveSecurityContext, poId: string, newSalesPic: string): void {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Hanya Owner atau Super Admin yang berwenang mengubah PIC Sales.", 403);
    }

    if (!newSalesPic || !newSalesPic.trim()) {
      throw new AppError("ERR_VALIDATION", "Nama PIC Sales baru tidak boleh kosong.", 400);
    }

    const po = this.db.prepare(`
      SELECT id, sales_pic FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(poId, context.ownerId) as { id: string; sales_pic: string | null } | undefined;

    if (!po) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan pada Owner ini.", 404);
    }

    const trimmed = newSalesPic.trim();
    this.db.prepare(`
      UPDATE purchase_orders SET sales_pic = ?, updated_at = ? WHERE id = ?
    `).run(trimmed, new Date().toISOString(), poId);

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "UPDATE_PO_SALES_PIC",
      "PURCHASE_ORDER",
      poId,
      { oldSalesPic: po.sales_pic, newSalesPic: trimmed }
    );
  }

  /**
   * Memetakan baris item PO manual ke produk katalog yang sudah ada (MAPPED)
   */
  mapPurchaseOrderLineToProduct(
    context: ActiveSecurityContext,
    input: { poId: string; lineId: string; productId: string }
  ): void {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN" && context.role !== "STAFF") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Hanya Staff, Owner, atau Super Admin yang berwenang memetakan produk PO.", 403);
    }

    // Pastikan PO milik tenant
    const po = this.db.prepare(`
      SELECT id FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(input.poId, context.ownerId);

    if (!po) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan pada Owner ini.", 404);
    }

    // Pastikan produk ada di katalog tenant
    const prod = this.db.prepare(`
      SELECT id, name, sku FROM products WHERE id = ? AND owner_id = ?
    `).get(input.productId, context.ownerId) as { id: string; name: string; sku: string } | undefined;

    if (!prod) {
      throw new AppError("ERR_NOT_FOUND", "Produk katalog rujukan tidak ditemukan pada Owner ini.", 404);
    }

    // Perbarui baris PO
    const res = this.db.prepare(`
      UPDATE purchase_order_lines
      SET product_id = ?, mapping_status = 'MAPPED'
      WHERE id = ? AND po_id = ?
    `).run(prod.id, input.lineId, input.poId);

    if (res.changes === 0) {
      throw new AppError("ERR_NOT_FOUND", "Baris Purchase Order tidak ditemukan.", 404);
    }

    this.recordAudit(
      context.ownerId,
      null,
      context.userId,
      "MAP_PO_LINE_TO_PRODUCT",
      "PURCHASE_ORDER",
      input.poId,
      { lineId: input.lineId, productId: prod.id, productName: prod.name, sku: prod.sku }
    );
  }

  /**
   * Membuat produk baru di katalog dari item PO dan memetakannya (CONVERTED_TO_CATALOG)
   */
  createAndMapProductForPoLine(
    context: ActiveSecurityContext,
    input: {
      poId: string;
      lineId: string;
      name: string;
      sku: string;
      category?: string;
      trackingMode?: "SERIAL" | "NON_SERIAL";
      unit?: string;
    }
  ): { productId: string; sku: string; name: string } {
    this.assertContext(context);

    if (context.role !== "OWNER" && context.role !== "SUPER_ADMIN" && context.role !== "STAFF") {
      throw new AppError("ERR_FORBIDDEN_ROLE", "Hanya Staff, Owner, atau Super Admin yang berwenang membuat produk katalog.", 403);
    }

    const cleanName = input.name?.trim();
    const cleanSku = input.sku?.trim().toUpperCase();

    if (!cleanName || !cleanSku) {
      throw new AppError("ERR_VALIDATION", "Nama produk dan SKU wajib diisi.", 400);
    }

    // Validasi keunikan SKU dalam tenant Owner
    const existingSku = this.db.prepare(`
      SELECT id FROM products WHERE owner_id = ? AND UPPER(sku) = ?
    `).get(context.ownerId, cleanSku) as { id: string } | undefined;

    if (existingSku) {
      throw new AppError("ERR_CONFLICT", `SKU '${cleanSku}' sudah digunakan oleh produk lain. Gunakan SKU yang berbeda.`, 409);
    }

    // Ambil gudang dari PO jika ada, atau gudang aktif
    const poRow = this.db.prepare(`
      SELECT warehouse_id FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(input.poId, context.ownerId) as { warehouse_id: string | null } | undefined;

    if (!poRow) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan pada Owner ini.", 404);
    }

    const targetWarehouseId =
      poRow.warehouse_id ||
      context.warehouseId ||
      (this.db.prepare("SELECT id FROM warehouses WHERE owner_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1").get(context.ownerId) as { id: string } | undefined)?.id;

    if (!targetWarehouseId) {
      throw new AppError("ERR_VALIDATION", "Gudang operasional tidak ditemukan untuk mendaftarkan produk.", 400);
    }

    const newProdId = crypto.randomUUID();
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // 1. Tambah ke tabel products
      this.db.prepare(`
        INSERT INTO products (
          id, owner_id, warehouse_id, sku, name, category, unit,
          tracking_mode, min_stock, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?)
      `).run(
        newProdId,
        context.ownerId,
        targetWarehouseId,
        cleanSku,
        cleanName,
        input.category?.trim() || "Uncategorized",
        input.unit?.trim().toLowerCase() || "pcs",
        input.trackingMode || "NON_SERIAL",
        now,
        now
      );

      // 2. Petakan baris PO
      const res = this.db.prepare(`
        UPDATE purchase_order_lines
        SET product_id = ?, mapping_status = 'CONVERTED_TO_CATALOG'
        WHERE id = ? AND po_id = ?
      `).run(newProdId, input.lineId, input.poId);

      if (res.changes === 0) {
        throw new AppError("ERR_NOT_FOUND", "Baris Purchase Order tidak ditemukan.", 404);
      }

      this.recordAudit(
        context.ownerId,
        targetWarehouseId,
        context.userId,
        "CREATE_PRODUCT_AND_MAP_PO_LINE",
        "PURCHASE_ORDER",
        input.poId,
        { lineId: input.lineId, productId: newProdId, name: cleanName, sku: cleanSku }
      );

      return { productId: newProdId, sku: cleanSku, name: cleanName };
    });
  }

  /**
   * Mencatat pemenuhan kuantitas PO dengan pencegahan Over-Fulfillment
   */
  recordPoFulfillment(
    context: ActiveSecurityContext,
    poId: string,
    fulfillments: Array<{ productId: string; quantity: number }>
  ): void {
    this.assertContext(context);

    const po = this.db.prepare(`
      SELECT id, owner_id, status FROM purchase_orders WHERE id = ? AND owner_id = ?
    `).get(poId, context.ownerId) as { id: string; owner_id: string; status: string } | undefined;

    if (!po) {
      throw new AppError("ERR_NOT_FOUND", "Purchase Order tidak ditemukan.", 404);
    }

    const lines = this.db.prepare(`
      SELECT id, product_id, target_qty, fulfilled_qty
      FROM purchase_order_lines
      WHERE po_id = ?
    `).all(poId) as Array<{
      id: string;
      product_id: string;
      target_qty: number;
      fulfilled_qty: number;
    }>;

    this.db.transaction(() => {
      for (const f of fulfillments) {
        const line = lines.find((l) => l.product_id === f.productId);
        if (!line) continue;

        const currentFulfilled = Number(line.fulfilled_qty);
        const target = Number(line.target_qty);
        const newFulfilled = currentFulfilled + f.quantity;

        if (newFulfilled > target) {
          throw new AppError(
            "ERR_CONFLICT",
            `Jumlah pemenuhan (${newFulfilled}) melampaui target PO (${target}) untuk produk '${f.productId}'.`,
            400
          );
        }

        this.db.prepare(`
          UPDATE purchase_order_lines SET fulfilled_qty = ? WHERE id = ?
        `).run(newFulfilled, line.id);
      }

      // Hitung ulang status keseluruhan PO
      const updatedLines = this.db.prepare(`
        SELECT target_qty, fulfilled_qty FROM purchase_order_lines WHERE po_id = ?
      `).all(poId) as Array<{ target_qty: number; fulfilled_qty: number }>;

      const totalTarget = updatedLines.reduce((acc, l) => acc + Number(l.target_qty), 0);
      const totalFulfilled = updatedLines.reduce((acc, l) => acc + Number(l.fulfilled_qty), 0);

      const newStatus = totalFulfilled >= totalTarget
        ? "FULFILLED"
        : totalFulfilled > 0
        ? "PARTIALLY_FULFILLED"
        : "CONFIRMED";

      this.db.prepare(`
        UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?
      `).run(newStatus, new Date().toISOString(), poId);

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "PO_FULFILLMENT_RECORDED",
        "PURCHASE_ORDER",
        poId,
        { newStatus, totalFulfilled, totalTarget }
      );
    });
  }

  // ====================================================================
  // COMMERCIAL DOCUMENTS & INVOICES
  // ====================================================================

  /**
   * Mengambil daftar Dokumen Komersial / Invoice
   */
  getCommercialDocuments(context: ActiveSecurityContext): CommercialDocumentRecord[] {
    this.assertContext(context);

    const hasWarehouse = Boolean(context.warehouseId);
    const sql = `
      SELECT cd.id, cd.owner_id, cd.warehouse_id, cd.customer_id, c.name as customer_name,
             cd.po_id, po.po_number, cd.document_number, cd.document_date,
             cd.due_date, cd.document_type, cd.status, cd.subtotal,
             cd.item_discount, cd.doc_nominal_discount, cd.doc_percentage_discount,
             cd.points_redeemed, cd.total_amount, cd.paid_amount, cd.print_count, cd.notes
      FROM commercial_documents cd
      JOIN customers c ON c.id = cd.customer_id
      LEFT JOIN purchase_orders po ON po.id = cd.po_id
      WHERE cd.owner_id = ? ${hasWarehouse ? "AND cd.warehouse_id = ?" : ""}
      ORDER BY cd.created_at DESC
    `;
    const params = hasWarehouse ? [context.ownerId, context.warehouseId] : [context.ownerId];

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id?: string | null;
      customer_id: string;
      customer_name: string;
      po_id: string | null;
      po_number: string | null;
      document_number: string;
      document_date: string;
      due_date: string;
      document_type: "INVOICE" | "SURAT_JALAN" | "RECEIPT";
      status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
      subtotal: number;
      item_discount: number;
      doc_nominal_discount: number;
      doc_percentage_discount: number;
      points_redeemed: number;
      total_amount: number;
      paid_amount: number;
      print_count: number;
      notes: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      warehouseId: r.warehouse_id ?? null,
      customerId: r.customer_id,
      customerName: r.customer_name,
      poId: r.po_id,
      poNumber: r.po_number,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      dueDate: r.due_date,
      documentType: r.document_type,
      status: r.status,
      subtotal: Number(r.subtotal),
      itemDiscount: Number(r.item_discount),
      docNominalDiscount: Number(r.doc_nominal_discount),
      docPercentageDiscount: Number(r.doc_percentage_discount),
      pointsRedeemed: Number(r.points_redeemed),
      totalAmount: Number(r.total_amount),
      paidAmount: Number(r.paid_amount),
      printCount: Number(r.print_count ?? 0),
      notes: r.notes,
    }));
  }

  /**
   * Mengambil Rincian Dokumen Komersial Lengkap Berdasarkan ID
   * Menjaga isolasi antar-Owner dan antar-Gudang: hanya dokumen milik context yang dapat dibaca.
   */
  getCommercialDocumentById(
    context: ActiveSecurityContext,
    documentId: string
  ): CommercialDocumentDetailRecord | null {
    this.assertContext(context);

    const docRow = this.db.prepare(`
      SELECT cd.id, cd.owner_id, cd.warehouse_id, cd.customer_id, c.name as customer_name,
             c.code as customer_code, c.contact_phone as customer_phone, c.address as customer_address,
             c.owner_name as customer_owner_name, c.pic_sales as customer_pic_sales, c.contact_email as customer_email,
             cd.po_id, po.po_number, cd.document_number, cd.document_date,
             cd.due_date, cd.document_type, cd.status, cd.subtotal,
             cd.item_discount, cd.doc_nominal_discount, cd.doc_percentage_discount,
             cd.points_redeemed, cd.total_amount, cd.paid_amount, cd.print_count, cd.notes,
             cd.shop_discount_note, cd.cashback_type, cd.cashback_value, cd.cashback_amount
      FROM commercial_documents cd
      JOIN customers c ON c.id = cd.customer_id
      LEFT JOIN purchase_orders po ON po.id = cd.po_id
      WHERE (cd.id = ? OR cd.document_number = ?) AND cd.owner_id = ?
    `).get(documentId, documentId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id?: string | null;
      customer_id: string;
      customer_name: string;
      customer_code?: string;
      customer_phone?: string | null;
      customer_address?: string | null;
      customer_owner_name?: string | null;
      customer_pic_sales?: string | null;
      customer_email?: string | null;
      po_id: string | null;
      po_number: string | null;
      document_number: string;
      document_date: string;
      due_date: string;
      document_type: "INVOICE" | "SAMPLE" | "SURAT_JALAN" | "RECEIPT";
      status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
      subtotal: number;
      item_discount: number;
      doc_nominal_discount: number;
      doc_percentage_discount: number;
      points_redeemed: number;
      total_amount: number;
      paid_amount: number;
      print_count: number;
      notes: string | null;
      shop_discount_note?: string | null;
      cashback_type?: "PERCENTAGE" | "NOMINAL" | "NONE";
      cashback_value?: number;
      cashback_amount?: number;
    } | undefined;

    if (!docRow) return null;

    // Menegakkan isolasi gudang: jika context.warehouseId ditentukan dan dokumen memiliki warehouse_id, wajib cocok
    if (context.warehouseId && docRow.warehouse_id && docRow.warehouse_id !== context.warehouseId) {
      return null;
    }

    // 1. Ambil baris item dokumen dari commercial_document_lines jika ada
    let lineRows = this.db.prepare(`
      SELECT cdl.id, cdl.document_id, cdl.product_id,
             COALESCE(cdl.product_name, p.name, cdl.description_snapshot, 'Produk') as product_name,
             COALESCE(p.sku, '—') as sku,
             COALESCE(p.tracking_mode, 'NON_SERIAL') as tracking,
             COALESCE(cdl.unit, p.unit, 'PCS') as unit,
             cdl.quantity, cdl.unit_price,
             cdl.discount_type, cdl.discount_value, cdl.line_total,
             cdl.description_snapshot
      FROM commercial_document_lines cdl
      LEFT JOIN products p ON p.id = cdl.product_id
      WHERE cdl.document_id = ? AND cdl.owner_id = ?
      ORDER BY cdl.created_at ASC
    `).all(docRow.id, context.ownerId) as Array<{
      id: string;
      document_id: string;
      product_id: string | null;
      product_name: string;
      sku: string;
      tracking: "SERIAL" | "NON_SERIAL";
      unit: string;
      quantity: number;
      unit_price: number;
      discount_type: "NOMINAL" | "PERCENTAGE" | "NONE";
      discount_value: number;
      line_total: number;
      description_snapshot?: string | null;
    }>;

    // Fallback: Jika belum ada baris di commercial_document_lines tetapi dokumen terhubung ke PO, ambil dari purchase_order_lines
    if (lineRows.length === 0 && docRow.po_id) {
      const poLines = this.db.prepare(`
        SELECT pol.id, pol.po_id, pol.product_id, p.name as product_name,
               p.sku, p.tracking_mode as tracking, p.unit, pol.target_qty as quantity,
               pol.unit_price, pol.discount_amount,
               ((pol.target_qty * pol.unit_price) - pol.discount_amount) as line_total
        FROM purchase_order_lines pol
        JOIN products p ON p.id = pol.product_id
        WHERE pol.po_id = ?
        ORDER BY pol.created_at ASC
      `).all(docRow.po_id) as Array<{
        id: string;
        po_id: string;
        product_id: string;
        product_name: string;
        sku: string;
        tracking: "SERIAL" | "NON_SERIAL";
        unit: string;
        quantity: number;
        unit_price: number;
        discount_amount: number;
        line_total: number;
      }>;

      lineRows = poLines.map((pl) => ({
        id: pl.id,
        document_id: documentId,
        product_id: pl.product_id,
        product_name: pl.product_name,
        sku: pl.sku,
        tracking: pl.tracking,
        unit: pl.unit,
        quantity: Number(pl.quantity),
        unit_price: Number(pl.unit_price),
        discount_type: "NOMINAL" as const,
        discount_value: Number(pl.discount_amount),
        line_total: Number(pl.line_total),
        description_snapshot: null,
      }));
    }

    const lines: CommercialDocumentLineRecord[] = lineRows.map((lr) => ({
      id: lr.id,
      documentId: lr.document_id,
      productId: lr.product_id,
      productName: lr.product_name,
      sku: lr.sku,
      tracking: lr.tracking,
      unit: lr.unit,
      quantity: Number(lr.quantity),
      unitPrice: Number(lr.unit_price),
      discountType: lr.discount_type,
      discountValue: Number(lr.discount_value),
      lineTotal: Number(lr.line_total),
      descriptionSnapshot: lr.description_snapshot,
    }));

    const payments = this.getDocumentPayments(context, docRow.id);

    const custPoints = this.getCustomerPointBalance(context, docRow.customer_id);

    return {
      id: docRow.id,
      ownerId: docRow.owner_id,
      warehouseId: docRow.warehouse_id ?? null,
      customerId: docRow.customer_id,
      customerName: docRow.customer_name,
      customerCode: docRow.customer_code,
      customerPhone: docRow.customer_phone,
      customerAddress: docRow.customer_address,
      customerOwnerName: docRow.customer_owner_name,
      customerPicSales: docRow.customer_pic_sales,
      customerEmail: docRow.customer_email,
      customerAvailablePoints: custPoints.availablePoints,
      customerPendingPoints: custPoints.pendingPoints,
      poId: docRow.po_id,
      poNumber: docRow.po_number,
      documentNumber: docRow.document_number,
      documentDate: docRow.document_date,
      dueDate: docRow.due_date,
      documentType: docRow.document_type,
      status: docRow.status,
      subtotal: Number(docRow.subtotal),
      itemDiscount: Number(docRow.item_discount),
      docNominalDiscount: Number(docRow.doc_nominal_discount),
      docPercentageDiscount: Number(docRow.doc_percentage_discount),
      pointsRedeemed: Number(docRow.points_redeemed),
      shopDiscountNote: docRow.shop_discount_note ?? undefined,
      cashbackType: docRow.cashback_type ?? undefined,
      cashbackValue: docRow.cashback_value !== undefined && docRow.cashback_value !== null ? Number(docRow.cashback_value) : undefined,
      cashbackAmount: docRow.cashback_amount !== undefined && docRow.cashback_amount !== null ? Number(docRow.cashback_amount) : undefined,
      totalAmount: Number(docRow.total_amount),
      paidAmount: Number(docRow.paid_amount),
      printCount: Number(docRow.print_count ?? 0),
      notes: docRow.notes,
      lines,
      payments,
    };
  }

  /**
   * Membuat Invoice / Dokumen Komersial Baru dengan Urutan Diskon LOCKED
   * Aturan LOCKED: Diskon Item -> Diskon Nominal Dokumen -> Diskon Persentase Dokumen -> Penukaran Poin Terakhir
   * TIDAK MEMOTONG STOK FISIK.
   */
  createCommercialDocument(
    context: ActiveSecurityContext,
    input: CreateCommercialDocumentInput
  ): CommercialDocumentRecord {
    this.assertContext(context);

    const docType = input.documentType ?? "INVOICE";
    const rawDocumentNumber = input.documentNumber?.trim() || "";
    if (!rawDocumentNumber && docType !== "SAMPLE") {
      throw new AppError("ERR_VALIDATION", "Pelanggan dan nomor dokumen wajib diisi.", 400);
    }

    if (!input.customerId && !input.newCustomer) {
      throw new AppError("ERR_VALIDATION", "Pelanggan wajib diisi.", 400);
    }

    if (input.newCustomer) {
      if (!input.newCustomer.name?.trim()) {
        throw new AppError("ERR_VALIDATION", "Nama Toko pelanggan baru wajib diisi.", 400);
      }
      if (input.newCustomer.email?.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input.newCustomer.email.trim())) {
          throw new AppError("ERR_VALIDATION", "Format email pelanggan baru tidak valid.", 400);
        }
      }
    }

    let customerIdToUse = input.customerId || "";
    let customerNameToUse = "";

    if (!input.newCustomer) {
      const existingCustomer = this.db.prepare(`
        SELECT id, name FROM customers WHERE id = ? AND owner_id = ?
      `).get(input.customerId, context.ownerId) as { id: string; name: string } | undefined;
      if (!existingCustomer) {
        throw new AppError("ERR_NOT_FOUND", "Pelanggan tidak ditemukan atau tidak berada dalam organisasi Anda.", 404);
      }
      customerIdToUse = existingCustomer.id;
      customerNameToUse = existingCustomer.name;
    } else {
      customerNameToUse = input.newCustomer.name.trim();
    }

    // Validasi Purchase Order rujukan jika ada (RPD §10.4 & Aturan PO -> Invoice)
    if (input.poId) {
      const po = this.db.prepare(`
        SELECT id, owner_id, customer_id, po_number, status FROM purchase_orders
        WHERE id = ? AND owner_id = ?
      `).get(input.poId, context.ownerId) as { id: string; owner_id: string; customer_id: string; po_number: string; status: string } | undefined;

      if (!po) {
        throw new AppError("ERR_NOT_FOUND", "Purchase Order rujukan tidak ditemukan pada Owner ini.", 404);
      }

      if (po.status !== "CONFIRMED" && po.status !== "PARTIALLY_FULFILLED" && po.status !== "FULFILLED") {
        throw new AppError(
          "ERR_CONFLICT",
          `Invoice hanya dapat dibuat untuk Purchase Order yang telah disetujui (Status: ${po.status}).`,
          409
        );
      }

      if (customerIdToUse && customerIdToUse !== po.customer_id) {
        throw new AppError("ERR_VALIDATION", "Pelanggan pada Invoice harus sama dengan pelanggan pada Purchase Order.", 400);
      }

      // Cegah pembuatan invoice ganda untuk PO yang sama (kecuali dokumen sebelumnya telah dibatalkan)
      const existingDoc = this.db.prepare(`
        SELECT id, document_number FROM commercial_documents
        WHERE owner_id = ? AND po_id = ? AND status != 'CANCELLED'
        LIMIT 1
      `).get(context.ownerId, input.poId) as { id: string; document_number: string } | undefined;

      if (existingDoc) {
        throw new AppError(
          "ERR_CONFLICT",
          `Invoice untuk Purchase Order ini sudah pernah dibuat dengan nomor dokumen ${existingDoc.document_number}.`,
          409
        );
      }
    }

    const itemDiscount = input.itemDiscount ?? 0;
    const docNominalDiscount = input.docNominalDiscount ?? 0;
    const docPercentageDiscount = input.docPercentageDiscount ?? 0;
    const pointsRedeemed = Math.max(0, Math.round(input.pointsRedeemed ?? 0));
    const isNonFinancial = docType === "SURAT_JALAN" || docType === "SAMPLE";

    // Validasi penukaran poin terhadap saldo poin pelanggan existing
    if (!isNonFinancial && pointsRedeemed > 0) {
      if (input.newCustomer) {
        throw new AppError("ERR_VALIDATION", "Pelanggan baru belum memiliki saldo poin reward.", 400);
      }
      const ptsRow = this.db.prepare(`
        SELECT 
          COALESCE(SUM(points), 0) AS balance,
          COUNT(*) AS cnt
        FROM customer_point_ledger
        WHERE owner_id = ? AND customer_id = ?
      `).get(context.ownerId, customerIdToUse) as { balance: number; cnt: number } | undefined;

      const hasLedger = (ptsRow?.cnt ?? 0) > 0;
      const currentBalance = Math.max(0, Number(ptsRow?.balance ?? 0));
      if (hasLedger && pointsRedeemed > currentBalance) {
        throw new AppError(
          "ERR_VALIDATION",
          `Penukaran poin (${pointsRedeemed} poin) melebihi saldo poin pelanggan yang tersedia (${currentBalance} poin).`,
          400
        );
      }
    }

    if (docPercentageDiscount < 0 || docPercentageDiscount > 100) {
      throw new AppError("ERR_VALIDATION", "Diskon persentase dokumen harus berada di antara 0 dan 100.", 400);
    }

    let calculatedSubtotal = input.subtotal ?? 0;
    let calculatedItemDiscount = itemDiscount;
    let finalTotal = 0;

    if (input.lines && input.lines.length > 0) {
      input.lines.forEach((l, idx) => {
        const n = idx + 1;
        if (l.discountType === "PERCENTAGE" && ((l.discountValue ?? 0) < 0 || (l.discountValue ?? 0) > 100)) {
          throw new AppError("ERR_VALIDATION", `Item ${n}: diskon persentase maksimal 100.`, 400);
        }
      });

      const calc = calculateDocumentTotals({
        lines: input.lines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountType: l.discountType ?? "NONE",
          discountValue: l.discountValue ?? 0,
        })),
        docNominalDiscount,
        docPercentageDiscount,
        pointsRedeemed,
      });
      calculatedSubtotal = calc.subtotal;
      calculatedItemDiscount = calc.itemDiscount;
      finalTotal = calc.totalAmount;
    } else {
      // Kalkulasi diskon bertingkat LOCKED
      const step1 = Math.max(0, (input.subtotal ?? 0) - itemDiscount);
      const step2 = Math.max(0, step1 - docNominalDiscount);
      const step3 = Math.max(0, step2 * (1 - (docPercentageDiscount / 100)));
      const step4 = Math.max(0, step3 - pointsRedeemed);
      finalTotal = Math.round(step4);
    }

    if (isNonFinancial) {
      calculatedSubtotal = 0;
      calculatedItemDiscount = 0;
      finalTotal = 0;
    }

    if (docType === "INVOICE" && calculatedSubtotal <= 0) {
      throw new AppError("ERR_VALIDATION", "Subtotal invoice harus lebih besar dari 0.", 400);
    }
    if (calculatedSubtotal < 0) {
      throw new AppError("ERR_VALIDATION", "Subtotal tidak boleh bernilai negatif.", 400);
    }

    const docId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Nilai cashback
    const cashbackType = isNonFinancial ? "NONE" : (input.cashbackType ?? "NONE");
    const cashbackValue = isNonFinancial ? 0 : (input.cashbackValue ?? 0);
    const cashbackAmount = isNonFinancial ? 0 : Math.max(0, Math.round(input.cashbackAmount ?? 0));
    const shopDiscountNote = isNonFinancial ? null : (input.shopDiscountNote?.trim() || null);

    const isPaid = !isNonFinancial && input.paymentStatus === "PAID" && finalTotal > 0;
    const initialStatus = isPaid ? "PAID" : "ISSUED";
    const initialPaidAmount = isPaid ? finalTotal : 0;

    return this.db.transaction(() => {
      let cleanDocNumber = rawDocumentNumber.trim().toUpperCase();
      if (!cleanDocNumber && docType === "SAMPLE") {
        const d = new Date();
        const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        const countRow = this.db.prepare(`
          SELECT COUNT(*) as count FROM commercial_documents
          WHERE owner_id = ? AND document_type = 'SAMPLE'
        `).get(context.ownerId) as { count: number };
        let seq = (countRow?.count || 0) + 1;
        cleanDocNumber = `SS-${ymd}-${String(seq).padStart(4, "0")}`;
        while (this.db.prepare("SELECT 1 FROM commercial_documents WHERE owner_id = ? AND document_number = ?").get(context.ownerId, cleanDocNumber)) {
          seq++;
          cleanDocNumber = `SS-${ymd}-${String(seq).padStart(4, "0")}`;
        }
      }

      if (!cleanDocNumber) {
        throw new AppError("ERR_VALIDATION", "Nomor dokumen wajib diisi.", 400);
      }

      const existingDocNum = this.db.prepare(
        "SELECT id FROM commercial_documents WHERE owner_id = ? AND document_number = ?"
      ).get(context.ownerId, cleanDocNumber);
      if (existingDocNum) {
        throw new AppError("ERR_CONFLICT", `Nomor dokumen ${cleanDocNumber} sudah digunakan.`, 409);
      }
      // 1. Jika ada newCustomer, buat pelanggan baru secara atomik
      if (input.newCustomer) {
        const newCustId = crypto.randomUUID();
        const count = this.db.prepare("SELECT COUNT(*) as c FROM customers WHERE owner_id = ?").get(context.ownerId) as { c: number };
        const customerCode = `CST-${String(count.c + 1).padStart(4, "0")}`;

        this.db.prepare(`
          INSERT INTO customers (
            id, owner_id, code, name, owner_name, pic_sales, contact_phone, contact_email, address, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(
          newCustId,
          context.ownerId,
          customerCode,
          input.newCustomer.name.trim(),
          input.newCustomer.ownerName?.trim() ?? null,
          input.newCustomer.picSales?.trim() ?? null,
          input.newCustomer.phone?.trim() ?? null,
          input.newCustomer.email?.trim() ?? null,
          input.newCustomer.address?.trim() ?? null,
          now,
          now
        );

        this.recordAudit(context.ownerId, null, context.userId, "CREATE_CUSTOMER", "CUSTOMER", newCustId, {
          code: customerCode,
          name: input.newCustomer.name.trim(),
          ownerName: input.newCustomer.ownerName?.trim() ?? null,
          source: "DOC_CREATE_FORM",
        });

        customerIdToUse = newCustId;
      }

      // Tentukan warehouse_id dokumen: prioritas dari context.warehouseId
      let targetWarehouseId = context.warehouseId;
      if (!targetWarehouseId) {
        const whRow = this.db.prepare(
          "SELECT id FROM warehouses WHERE owner_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1"
        ).get(context.ownerId) as { id: string } | undefined;
        targetWarehouseId = whRow?.id ?? null;
      }

      // 2. Simpan Dokumen Komersial
      this.db.prepare(`
        INSERT INTO commercial_documents (
          id, owner_id, warehouse_id, customer_id, po_id, document_number, document_date, due_date,
          document_type, status, subtotal, item_discount, doc_nominal_discount,
          doc_percentage_discount, shop_discount_note, points_redeemed,
          cashback_type, cashback_value, cashback_amount,
          total_amount, paid_amount, print_count, notes, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        docId,
        context.ownerId,
        targetWarehouseId,
        customerIdToUse,
        input.poId ? input.poId : null,
        cleanDocNumber,
        input.documentDate,
        input.dueDate || input.documentDate,
        docType,
        initialStatus,
        calculatedSubtotal,
        calculatedItemDiscount,
        isNonFinancial ? 0 : docNominalDiscount,
        isNonFinancial ? 0 : docPercentageDiscount,
        shopDiscountNote,
        isNonFinancial ? 0 : pointsRedeemed,
        cashbackType,
        cashbackValue,
        cashbackAmount,
        finalTotal,
        initialPaidAmount,
        input.notes ? input.notes.trim() : null,
        context.userId,
        now,
        now
      );

      // 3. Catat penukaran poin ke ledger pelanggan
      if (!isNonFinancial && pointsRedeemed > 0) {
        this.db.prepare(`
          INSERT INTO customer_point_ledger (
            id, owner_id, customer_id, document_id, entry_type, points, description, created_at
          ) VALUES (?, ?, ?, ?, 'REDEEMED', ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          context.ownerId,
          customerIdToUse,
          docId,
          -pointsRedeemed,
          `Penukaran poin pada invoice ${cleanDocNumber}`,
          now
        );
      }

      // 4. Catat perolehan cashback poin ke ledger pelanggan
      if (!isNonFinancial && cashbackAmount > 0) {
        const rewardEntryType = isPaid ? "EARNED_AVAILABLE" : "EARNED_PENDING";
        this.db.prepare(`
          INSERT INTO customer_point_ledger (
            id, owner_id, customer_id, document_id, entry_type, points, description, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          context.ownerId,
          customerIdToUse,
          docId,
          rewardEntryType,
          cashbackAmount,
          `Reward cashback poin untuk dokumen ${cleanDocNumber}`,
          now
        );
      }

      // 5. Jika ditandai langsung lunas (PAID), catat juga entri pembayaran
      if (isPaid) {
        const payId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO document_payments (
            id, document_id, owner_id, payment_number, payment_date, amount,
            payment_method, reference_number, notes, received_by_user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'TUNAI', 'PEMBAYARAN_LANGSUNG', 'Pelunasan langsung saat pembuatan dokumen', ?, ?)
        `).run(
          payId,
          docId,
          context.ownerId,
          `PAY-${cleanDocNumber}`,
          input.documentDate,
          finalTotal,
          context.userId,
          now
        );
      }

      // 6. Simpan baris item dokumen
      if (input.lines && input.lines.length > 0) {
        const insertLineStmt = this.db.prepare(`
          INSERT INTO commercial_document_lines (
            id, owner_id, document_id, source_order_item_id, product_id, product_name,
            unit, description_snapshot, quantity, unit_price, discount_type, discount_value, line_total, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (let idx = 0; idx < input.lines.length; idx++) {
          const l = input.lines[idx];
          const lineId = crypto.randomUUID();
          const dbDiscType: "NOMINAL" | "PERCENTAGE" | "NONE" = isNonFinancial ? "NONE" : (l.discountType ?? "NONE");
          const discVal = isNonFinancial || dbDiscType === "NONE" ? 0 : (l.discountValue ?? 0);
          const effectiveUnitPrice = isNonFinancial ? 0 : (l.unitPrice || 0);
          const gross = Math.round(l.quantity * effectiveUnitPrice);
          let disc = 0;
          if (dbDiscType === "NOMINAL") disc = Math.round(discVal);
          else if (dbDiscType === "PERCENTAGE") disc = Math.round(gross * (discVal / 100));
          disc = Math.min(Math.max(0, disc), gross);
          const lineTotal = gross - disc;

          let resolvedProductName = l.productName?.trim() || "";
          let resolvedUnit = (l.unit?.trim() || "PCS");
          let resolvedProductId = l.productId || null;

          if (l.productId) {
            const prod = this.db.prepare(`
              SELECT name, unit FROM products WHERE id = ? AND owner_id = ?
            `).get(l.productId, context.ownerId) as { name: string; unit: string } | undefined;
            if (prod) {
              if (!resolvedProductName) resolvedProductName = prod.name;
              if (!l.unit) resolvedUnit = prod.unit || "PCS";
            }
          }

          if (!resolvedProductName) {
            resolvedProductName = l.note?.trim() || "Produk";
          }

          insertLineStmt.run(
            lineId,
            context.ownerId,
            docId,
            null,
            resolvedProductId,
            resolvedProductName,
            resolvedUnit,
            l.note?.trim() ? l.note.trim() : resolvedProductName,
            l.quantity,
            effectiveUnitPrice,
            dbDiscType,
            discVal,
            isNonFinancial ? 0 : lineTotal,
            new Date(Date.parse(now) + idx).toISOString()
          );
        }
      } else if (input.poId) {
        // Fallback: Jika ada PO terhubung, salin baris item PO ke commercial_document_lines
        const poLines = this.db.prepare(`
          SELECT pol.id, pol.product_id, p.name as product_name, COALESCE(pol.ordered_unit, p.unit, 'PCS') as unit, pol.target_qty, pol.unit_price, pol.discount_amount
          FROM purchase_order_lines pol
          JOIN products p ON p.id = pol.product_id
          WHERE pol.po_id = ?
        `).all(input.poId) as Array<{
          id: string;
          product_id: string;
          product_name: string;
          unit: string;
          target_qty: number;
          unit_price: number;
          discount_amount: number;
        }>;

        const insertLineStmt = this.db.prepare(`
          INSERT INTO commercial_document_lines (
            id, owner_id, document_id, source_order_item_id, product_id, product_name,
            unit, description_snapshot, quantity, unit_price, discount_type, discount_value, line_total, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const pl of poLines) {
          const lineId = crypto.randomUUID();
          const lineTotal = Math.max(0, (pl.target_qty * pl.unit_price) - pl.discount_amount);
          insertLineStmt.run(
            lineId,
            context.ownerId,
            docId,
            pl.id,
            pl.product_id,
            pl.product_name,
            pl.unit || "PCS",
            pl.product_name,
            pl.target_qty,
            pl.unit_price,
            "NOMINAL",
            pl.discount_amount,
            lineTotal,
            now
          );
        }
      }

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "CREATE_COMMERCIAL_DOCUMENT",
        docType,
        docId,
        {
          documentNumber: cleanDocNumber,
          totalAmount: finalTotal,
          subtotal: input.subtotal,
          itemDiscount,
          docNominalDiscount,
          docPercentageDiscount,
          shopDiscountNote,
          pointsRedeemed,
          cashbackAmount,
          isNewCustomer: Boolean(input.newCustomer),
          isPaid,
        }
      );

      return {
        id: docId,
        ownerId: context.ownerId,
        warehouseId: targetWarehouseId,
        customerId: customerIdToUse,
        customerName: customerNameToUse,
        poId: input.poId ?? null,
        documentNumber: cleanDocNumber,
        documentDate: input.documentDate,
        dueDate: input.dueDate || input.documentDate,
        documentType: docType,
        status: initialStatus,
        subtotal: calculatedSubtotal,
        itemDiscount: calculatedItemDiscount,
        docNominalDiscount: isNonFinancial ? 0 : docNominalDiscount,
        docPercentageDiscount: isNonFinancial ? 0 : docPercentageDiscount,
        shopDiscountNote,
        pointsRedeemed: isNonFinancial ? 0 : pointsRedeemed,
        cashbackType,
        cashbackValue,
        cashbackAmount,
        totalAmount: finalTotal,
        paidAmount: initialPaidAmount,
        printCount: 0,
        notes: input.notes ? input.notes.trim() : null,
      };
    });
  }

  /**
   * Mencatat Pembayaran Dokumen / Invoice (Tidak Menandai Lunas Tanpa Bukti Pembayaran Nyata)
   */
  recordDocumentPayment(
    context: ActiveSecurityContext,
    input: {
      documentId: string;
      amount: number;
      paymentMethod: "TRANSFER" | "TUNAI" | "GIRO" | "KARTU_KREDIT" | "LAINNYA";
      referenceNumber?: string;
      notes?: string;
      proof?: {
        mimeType: string;
        base64: string;
        fileName: string;
        fileSize: number;
      };
    }
  ): { paymentId: string; newStatus: string; paidAmount: number } {
    this.assertContext(context);

    if (input.amount <= 0) {
      throw new AppError("ERR_VALIDATION", "Nominal pembayaran harus lebih besar dari 0.", 400);
    }

    const doc = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, total_amount, paid_amount, status, document_type
      FROM commercial_documents
      WHERE id = ? AND owner_id = ?
    `).get(input.documentId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id?: string | null;
      total_amount: number;
      paid_amount: number;
      status: string;
      document_type: string;
    } | undefined;

    if (!doc) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen tagihan tidak ditemukan.", 404);
    }

    if (context.warehouseId && doc.warehouse_id && doc.warehouse_id !== context.warehouseId) {
      throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Dokumen berada di gudang yang berbeda.", 403);
    }

    if (doc.document_type === "SAMPLE" || doc.document_type === "SURAT_JALAN") {
      throw new AppError(
        "ERR_VALIDATION",
        `Dokumen ${doc.document_type === "SAMPLE" ? "Sample" : "Surat Jalan"} tidak menerima pembayaran karena bukan merupakan dokumen tagihan finansial.`,
        400
      );
    }

    if (doc.status === "CANCELLED") {
      throw new AppError("ERR_CONFLICT", "Dokumen yang telah dibatalkan tidak dapat menerima pembayaran.", 409);
    }

    if (doc.status === "PAID") {
      throw new AppError("ERR_CONFLICT", "Dokumen tagihan ini sudah lunas.", 400);
    }

    const remainingBalance = Number(doc.total_amount) - Number(doc.paid_amount);
    if (input.amount > remainingBalance) {
      throw new AppError(
        "ERR_VALIDATION",
        `Nominal pembayaran (Rp ${input.amount.toLocaleString()}) melebihi sisa tagihan (Rp ${remainingBalance.toLocaleString()}).`,
        400
      );
    }

    if (input.referenceNumber?.trim()) {
      const existingRef = this.db.prepare(`
        SELECT id FROM document_payments
        WHERE owner_id = ? AND reference_number = ?
      `).get(context.ownerId, input.referenceNumber.trim());

      if (existingRef) {
        throw new AppError(
          "ERR_CONFLICT",
          `Nomor referensi pembayaran '${input.referenceNumber.trim()}' sudah pernah dicatat.`,
          409
        );
      }
    }

    let cleanMimeType: string | null = null;
    let cleanBase64: string | null = null;
    let cleanFileName: string | null = null;
    let cleanFileSize: number | null = null;

    if (input.proof) {
      const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
      if (!allowedMimes.has(input.proof.mimeType)) {
        throw new AppError(
          "ERR_VALIDATION",
          `Format bukti pembayaran '${input.proof.mimeType}' tidak didukung. Harap unggah berkas gambar (JPEG, PNG, WebP) atau PDF.`,
          400
        );
      }
      // Maksimal 2.5MB (2.621.440 bytes)
      const MAX_PROOF_SIZE = 2621440;
      if (input.proof.fileSize > MAX_PROOF_SIZE) {
        throw new AppError(
          "ERR_VALIDATION",
          `Ukuran berkas bukti pembayaran (${(input.proof.fileSize / 1024 / 1024).toFixed(2)} MB) melebihi batas maksimum 2.5 MB.`,
          400
        );
      }
      let b64 = input.proof.base64.trim();
      const prefixMatch = b64.match(/^data:[^;]+;base64,(.+)$/);
      if (prefixMatch) {
        b64 = prefixMatch[1];
      }
      cleanMimeType = input.proof.mimeType;
      cleanBase64 = b64;
      cleanFileName = input.proof.fileName.trim().slice(0, 200) || "bukti_bayar";
      cleanFileSize = input.proof.fileSize;
    }

    const paymentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const paymentNumber = `PAY-${Date.now().toString().slice(-6)}`;
    const newPaidAmount = Number(doc.paid_amount) + input.amount;
    const newStatus = newPaidAmount >= Number(doc.total_amount) ? "PAID" : "PARTIALLY_PAID";

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO document_payments (
          id, document_id, owner_id, payment_number, payment_date, amount,
          payment_method, reference_number, notes, received_by_user_id,
          proof_mime_type, proof_base64, proof_file_name, proof_file_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        paymentId,
        input.documentId,
        context.ownerId,
        paymentNumber,
        now.slice(0, 10),
        input.amount,
        input.paymentMethod,
        input.referenceNumber ?? null,
        input.notes ?? null,
        context.userId,
        cleanMimeType,
        cleanBase64,
        cleanFileName,
        cleanFileSize,
        now
      );

      this.db.prepare(`
        UPDATE commercial_documents
        SET paid_amount = ?, status = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(newPaidAmount, newStatus, now, input.documentId, context.ownerId);

      // Jika invoice telah lunas sepenuhnya (PAID), aktifkan poin reward yang berstatus pending
      if (newStatus === "PAID") {
        this.db.prepare(`
          UPDATE customer_point_ledger
          SET entry_type = 'EARNED_AVAILABLE'
          WHERE document_id = ? AND owner_id = ? AND entry_type = 'EARNED_PENDING'
        `).run(input.documentId, context.ownerId);
      }

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "DOCUMENT_PAYMENT_RECORDED",
        "INVOICE_PAYMENT",
        paymentId,
        {
          documentId: input.documentId,
          amount: input.amount,
          newStatus,
          newPaidAmount,
          paymentMethod: input.paymentMethod,
          hasProof: Boolean(cleanBase64),
          proofFileName: cleanFileName,
        }
      );

      return {
        paymentId,
        newStatus,
        paidAmount: newPaidAmount,
      };
    });
  }

  /**
   * Menghapus Catatan Pembayaran Dokumen Nyata (Revert Kas & Kembalikan Sisa Piutang)
   */
  deleteDocumentPayment(
    context: ActiveSecurityContext,
    paymentId: string
  ): { paymentId: string; documentId: string; newStatus: string; paidAmount: number; deletedAmount: number } {
    this.assertContext(context);

    const payment = this.db.prepare(`
      SELECT dp.id, dp.document_id, dp.amount, dp.payment_number,
             cd.id as doc_id, cd.owner_id, cd.warehouse_id, cd.total_amount, cd.paid_amount, cd.status as doc_status
      FROM document_payments dp
      JOIN commercial_documents cd ON cd.id = dp.document_id
      WHERE dp.id = ? AND dp.owner_id = ?
    `).get(paymentId, context.ownerId) as {
      id: string;
      document_id: string;
      amount: number;
      payment_number: string;
      doc_id: string;
      owner_id: string;
      warehouse_id?: string | null;
      total_amount: number;
      paid_amount: number;
      doc_status: string;
    } | undefined;

    if (!payment) {
      throw new AppError("ERR_NOT_FOUND", "Data pembayaran tidak ditemukan atau telah dihapus.", 404);
    }

    if (context.warehouseId && payment.warehouse_id && payment.warehouse_id !== context.warehouseId) {
      throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Dokumen berada di gudang yang berbeda.", 403);
    }

    const newPaidAmount = Math.max(0, Number(payment.paid_amount) - Number(payment.amount));
    const newStatus = newPaidAmount >= Number(payment.total_amount)
      ? "PAID"
      : newPaidAmount > 0
      ? "PARTIALLY_PAID"
      : "ISSUED";
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM document_payments
        WHERE id = ? AND owner_id = ?
      `).run(paymentId, context.ownerId);

      this.db.prepare(`
        UPDATE commercial_documents
        SET paid_amount = ?, status = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(newPaidAmount, newStatus, now, payment.doc_id, context.ownerId);

      // Jika sebelumnya invoice berstatus PAID dan sekarang menjadi tidak lunas, kembalikan reward points ke EARNED_PENDING
      if (payment.doc_status === "PAID" && newStatus !== "PAID") {
        this.db.prepare(`
          UPDATE customer_point_ledger
          SET entry_type = 'EARNED_PENDING'
          WHERE document_id = ? AND owner_id = ? AND entry_type = 'EARNED_AVAILABLE'
        `).run(payment.doc_id, context.ownerId);
      }

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "DOCUMENT_PAYMENT_DELETED",
        "INVOICE_PAYMENT",
        paymentId,
        {
          documentId: payment.doc_id,
          paymentNumber: payment.payment_number,
          deletedAmount: payment.amount,
          previousPaidAmount: payment.paid_amount,
          newPaidAmount,
          newStatus,
        }
      );

      return {
        paymentId,
        documentId: payment.doc_id,
        newStatus,
        paidAmount: newPaidAmount,
        deletedAmount: payment.amount,
      };
    });
  }

  /**
   * Opsi pilihan pelanggan & produk untuk form Edit Dokumen (terisolasi per-Owner).
   * Produk tidak difilter per gudang karena dokumen komersial tidak mengubah stok.
   */
  getDocumentEditOptions(
    context: ActiveSecurityContext,
    documentId: string
  ): DocumentEditOptions {
    this.assertContext(context);

    const customerRows = this.db.prepare(`
      SELECT id, code, name, owner_name as ownerName, pic_sales as picSales, contact_phone as phone, contact_email as email, address
      FROM customers
      WHERE owner_id = ? AND (status = 'ACTIVE' OR id = (
        SELECT customer_id FROM commercial_documents WHERE id = ? AND owner_id = ?
      ))
      ORDER BY name ASC
    `).all(context.ownerId, documentId, context.ownerId) as Array<{
      id: string;
      code: string;
      name: string;
      ownerName?: string;
      picSales?: string;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
    }>;

    const customers: DocumentEditCustomerOption[] = customerRows.map((c) => {
      const pts = this.getCustomerPointBalance(context, c.id);
      return {
        ...c,
        availablePoints: pts.availablePoints,
        pendingPoints: pts.pendingPoints,
      };
    });

    // Produk aktif + produk yang sudah dipakai pada baris dokumen ini (agar tetap valid).
    const products = this.db.prepare(`
      SELECT p.id, p.sku, p.name, p.unit FROM products p
      WHERE p.owner_id = ? AND (
        p.status = 'ACTIVE'
        OR p.id IN (SELECT product_id FROM commercial_document_lines WHERE document_id = ? AND owner_id = ?)
      )
      ORDER BY p.name ASC
    `).all(context.ownerId, documentId, context.ownerId) as DocumentEditOptions["products"];

    const purchaseOrders = this.db.prepare(`
      SELECT po.id, po.po_number as poNumber, po.customer_id as customerId, c.name as customerName
      FROM purchase_orders po
      JOIN customers c ON c.id = po.customer_id
      WHERE po.owner_id = ? AND (po.status = 'CONFIRMED' OR po.status = 'PARTIALLY_FULFILLED')
      ORDER BY po.po_number DESC
    `).all(context.ownerId) as DocumentEditOptions["purchaseOrders"];

    return { customers, products, purchaseOrders };
  }

  /**
   * Mengedit Dokumen Komersial (Invoice/Kuitansi) secara atomik.
   *
   * Aturan:
   * - Hanya OWNER (bukan Super Admin on-behalf); matriks izin Staff/Sales masih TBD.
   * - Nomor dokumen, tipe, PO sumber, pembayaran, dan poin tidak berubah.
   * - Status pembayaran TIDAK diedit langsung; diturunkan dari paid_amount vs total baru.
   * - Total baru tidak boleh lebih kecil dari jumlah yang sudah dibayar.
   * - Tidak menyentuh stok, ledger, Goods Out, maupun status PO.
   * - Seluruh nilai dihitung ulang di server dengan urutan diskon LOCKED.
   */
  updateCommercialDocument(
    context: ActiveSecurityContext,
    input: UpdateCommercialDocumentInput
  ): CommercialDocumentDetailRecord {
    this.assertContext(context);

    const isOwnerOrSuperAdminInternal =
      !context.isSuperAdminOnBehalf &&
      (context.role === "OWNER" ||
        (context.role === "SUPER_ADMIN" && context.ownerId === "owner-super-admin"));

    if (!isOwnerOrSuperAdminInternal) {
      throw new AppError(
        "ERR_FORBIDDEN_ROLE",
        "Hanya Owner yang dapat mengedit dokumen. Izin Staff/Sales belum ditetapkan.",
        403
      );
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(input.documentDate) || Number.isNaN(Date.parse(input.documentDate))) {
      throw new AppError("ERR_VALIDATION", "Tanggal dokumen tidak valid.", 400);
    }
    if (input.dueDate) {
      if (!datePattern.test(input.dueDate) || Number.isNaN(Date.parse(input.dueDate))) {
        throw new AppError("ERR_VALIDATION", "Tanggal jatuh tempo tidak valid.", 400);
      }
      if (input.dueDate < input.documentDate) {
        throw new AppError("ERR_VALIDATION", "Jatuh tempo tidak boleh lebih awal dari tanggal dokumen.", 400);
      }
    }
    if (!input.customerId) {
      throw new AppError("ERR_VALIDATION", "Pelanggan wajib dipilih.", 400);
    }

    const docNominalDiscount = Number(input.docNominalDiscount || 0);
    const docPercentageDiscount = Number(input.docPercentageDiscount || 0);
    if (!Number.isFinite(docNominalDiscount) || docNominalDiscount < 0) {
      throw new AppError("ERR_VALIDATION", "Diskon dokumen nominal tidak valid.", 400);
    }
    if (!Number.isFinite(docPercentageDiscount) || docPercentageDiscount < 0 || docPercentageDiscount > 100) {
      throw new AppError("ERR_VALIDATION", "Diskon dokumen persentase harus 0 sampai 100.", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new AppError("ERR_VALIDATION", "Dokumen harus memiliki minimal satu item.", 400);
    }

    const validDiscountTypes = ["NONE", "NOMINAL", "PERCENTAGE"];
    input.lines.forEach((l, idx) => {
      const n = idx + 1;
      if (!l.productId && !l.productName?.trim()) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: produk wajib dipilih atau nama produk wajib diisi.`, 400);
      }
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: jumlah harus lebih besar dari 0.`, 400);
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: harga satuan tidak valid.`, 400);
      }
      if (!validDiscountTypes.includes(l.discountType)) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: jenis diskon tidak valid.`, 400);
      }
      if (!Number.isFinite(l.discountValue) || l.discountValue < 0) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: nilai diskon tidak valid.`, 400);
      }
      if (l.discountType === "PERCENTAGE" && l.discountValue > 100) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: diskon persentase maksimal 100.`, 400);
      }
      if (l.discountType === "NOMINAL" && l.discountValue > Math.round(l.quantity * l.unitPrice)) {
        throw new AppError("ERR_VALIDATION", `Item ${n}: diskon nominal melebihi nilai item.`, 400);
      }
    });

    return this.db.transaction(() => {
      const doc = this.db.prepare(`
        SELECT id, owner_id, warehouse_id, customer_id, po_id, document_number, document_type, status,
               document_date, due_date, subtotal, item_discount, doc_nominal_discount,
               doc_percentage_discount, points_redeemed, total_amount, paid_amount, notes,
               shop_discount_note, cashback_type, cashback_value, cashback_amount
        FROM commercial_documents
        WHERE id = ? AND owner_id = ?
      `).get(input.documentId, context.ownerId) as {
        id: string;
        owner_id: string;
        warehouse_id?: string | null;
        customer_id: string;
        po_id: string | null;
        document_number: string;
        document_type: "INVOICE" | "SAMPLE" | "SURAT_JALAN" | "RECEIPT";
        status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
        document_date: string;
        due_date: string;
        subtotal: number;
        item_discount: number;
        doc_nominal_discount: number;
        doc_percentage_discount: number;
        points_redeemed: number;
        total_amount: number;
        paid_amount: number;
        notes: string | null;
        shop_discount_note?: string | null;
        cashback_type?: "PERCENTAGE" | "NOMINAL" | "NONE";
        cashback_value?: number;
        cashback_amount?: number;
      } | undefined;

      if (!doc) {
        throw new AppError("ERR_NOT_FOUND", "Dokumen tidak ditemukan.", 404);
      }
      if (context.warehouseId && doc.warehouse_id && doc.warehouse_id !== context.warehouseId) {
        throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Dokumen berada di gudang yang berbeda.", 403);
      }
      if (doc.document_type === "SURAT_JALAN") {
        throw new AppError(
          "ERR_VALIDATION",
          "Edit belum didukung untuk dokumen Surat Jalan.",
          400
        );
      }
      if (doc.status === "CANCELLED") {
        throw new AppError("ERR_CONFLICT", "Dokumen yang dibatalkan tidak dapat diedit.", 409);
      }

      const customer = this.db.prepare(`
        SELECT id FROM customers WHERE id = ? AND owner_id = ?
      `).get(input.customerId, context.ownerId);
      if (!customer) {
        throw new AppError("ERR_VALIDATION", "Pelanggan tidak ditemukan pada Owner aktif.", 400);
      }

      // Baris yang tersimpan saat ini (atau fallback dari PO jika belum dimaterialisasi).
      const existingLines = this.db.prepare(`
        SELECT id, source_order_item_id, product_id, description_snapshot, quantity, unit_price,
               discount_type, discount_value, line_total
        FROM commercial_document_lines
        WHERE document_id = ? AND owner_id = ?
      `).all(doc.id, context.ownerId) as Array<{
        id: string;
        source_order_item_id: string | null;
        product_id: string;
        description_snapshot: string | null;
        quantity: number;
        unit_price: number;
        discount_type: string;
        discount_value: number;
        line_total: number;
      }>;
      const existingById = new Map(existingLines.map((l) => [l.id, l]));

      const poLineIds = new Set<string>();
      if (existingLines.length === 0 && doc.po_id) {
        const poLines = this.db.prepare(`
          SELECT id FROM purchase_order_lines WHERE po_id = ?
        `).all(doc.po_id) as Array<{ id: string }>;
        poLines.forEach((p) => poLineIds.add(p.id));
      }

      const isNonFinancial = doc.document_type === "SAMPLE";

      // Validasi produk milik Owner aktif & ID baris tidak berasal dari dokumen lain.
      const productStmt = this.db.prepare(`
        SELECT id, name, unit FROM products WHERE id = ? AND owner_id = ?
      `);
      const productNames = new Map<string, string>();
      const productUnits = new Map<string, string>();
      const seenLineIds = new Set<string>();

      for (const l of input.lines) {
        if (!l.quantity || l.quantity <= 0) {
          throw new AppError("ERR_VALIDATION", "Kuantitas produk harus lebih besar dari 0.", 400);
        }
        if (l.productId) {
          if (!productNames.has(l.productId)) {
            const p = productStmt.get(l.productId, context.ownerId) as { id: string; name: string; unit: string } | undefined;
            if (!p) {
              throw new AppError("ERR_VALIDATION", "Produk tidak ditemukan pada Owner aktif.", 400);
            }
            productNames.set(p.id, p.name);
            productUnits.set(p.id, p.unit || "PCS");
          }
        } else if (!l.productName?.trim()) {
          throw new AppError("ERR_VALIDATION", "Nama produk pada setiap baris item wajib diisi.", 400);
        }
        if (l.id) {
          if (seenLineIds.has(l.id)) {
            throw new AppError("ERR_VALIDATION", "ID baris item duplikat.", 400);
          }
          seenLineIds.add(l.id);
        }
      }

      let totals = {
        subtotal: 0,
        itemDiscount: 0,
        totalAmount: 0,
        lines: input.lines.map(() => ({ lineTotal: 0 })),
      };

      if (!isNonFinancial) {
        totals = calculateDocumentTotals({
          lines: input.lines,
          docNominalDiscount,
          docPercentageDiscount,
          pointsRedeemed: Number(doc.points_redeemed),
        });

        const paidAmount = Number(doc.paid_amount);
        if (totals.totalAmount <= 0) {
          throw new AppError("ERR_VALIDATION", "Total akhir dokumen harus lebih besar dari 0.", 400);
        }
        if (totals.totalAmount < paidAmount) {
          throw new AppError(
            "ERR_CONFLICT",
            `Total akhir (Rp ${totals.totalAmount.toLocaleString("id-ID")}) tidak boleh lebih kecil dari jumlah yang sudah dibayar (Rp ${paidAmount.toLocaleString("id-ID")}).`,
            409
          );
        }
      }

      // Status diturunkan dari pembayaran nyata, bukan dari input pengguna.
      let newStatus = doc.status;
      if (!isNonFinancial && Number(doc.paid_amount) > 0) {
        newStatus = Number(doc.paid_amount) >= totals.totalAmount ? "PAID" : "PARTIALLY_PAID";
      }

      const now = new Date().toISOString();
      const notes = input.notes?.trim() ? input.notes.trim() : null;

      // Sinkronisasi baris: update yang ada, hapus yang tidak lagi disertakan, sisipkan yang baru.
      const keepIds = new Set<string>();
      const updateLine = this.db.prepare(`
        UPDATE commercial_document_lines
        SET product_id = ?, product_name = ?, unit = ?, description_snapshot = ?, quantity = ?, unit_price = ?,
            discount_type = ?, discount_value = ?, line_total = ?
        WHERE id = ? AND document_id = ? AND owner_id = ?
      `);
      const insertLine = this.db.prepare(`
        INSERT INTO commercial_document_lines (
          id, owner_id, document_id, source_order_item_id, product_id, product_name, unit, description_snapshot,
          quantity, unit_price, discount_type, discount_value, line_total, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      input.lines.forEach((l, idx) => {
        const calc = totals.lines[idx] ?? { lineTotal: 0 };
        const note = l.note?.trim() ? l.note.trim() : null;
        const storedDiscount = isNonFinancial || l.discountType === "NONE" ? 0 : l.discountValue;
        const effectiveUnitPrice = isNonFinancial ? 0 : l.unitPrice;

        let resolvedProductName = l.productName?.trim() || "";
        let resolvedUnit = (l.unit?.trim() || "PCS");
        let resolvedProductId = l.productId || null;

        if (l.productId) {
          const cachedName = productNames.get(l.productId);
          const cachedUnit = productUnits.get(l.productId);
          if (cachedName && !resolvedProductName) resolvedProductName = cachedName;
          if (cachedUnit && !l.unit) resolvedUnit = cachedUnit;
        }

        if (!resolvedProductName) {
          resolvedProductName = note || "Produk";
        }

        if (l.id && existingById.has(l.id)) {
          updateLine.run(
            resolvedProductId, resolvedProductName, resolvedUnit, note || resolvedProductName,
            l.quantity, effectiveUnitPrice, isNonFinancial ? "NONE" : l.discountType, storedDiscount,
            isNonFinancial ? 0 : calc.lineTotal, l.id, doc.id, context.ownerId
          );
          keepIds.add(l.id);
          return;
        }

        const newId = crypto.randomUUID();
        const sourceId = l.id && poLineIds.has(l.id) ? l.id : null;
        insertLine.run(
          newId, context.ownerId, doc.id, sourceId, resolvedProductId, resolvedProductName, resolvedUnit,
          note || resolvedProductName, l.quantity, effectiveUnitPrice, isNonFinancial ? "NONE" : l.discountType,
          storedDiscount, isNonFinancial ? 0 : calc.lineTotal,
          new Date(Date.parse(now) + idx).toISOString()
        );
        keepIds.add(newId);
      });

      for (const old of existingLines) {
        if (!keepIds.has(old.id)) {
          this.db.prepare(`
            DELETE FROM commercial_document_lines WHERE id = ? AND document_id = ? AND owner_id = ?
          `).run(old.id, doc.id, context.ownerId);
        }
      }

      const finalShopDiscountNote = !isNonFinancial && input.shopDiscountNote !== undefined
        ? input.shopDiscountNote
        : (doc.shop_discount_note ?? null);
      const finalCashbackType = !isNonFinancial && input.cashbackType !== undefined
        ? input.cashbackType
        : (doc.cashback_type ?? "NONE");
      const finalCashbackValue = !isNonFinancial && input.cashbackValue !== undefined
        ? (input.cashbackValue ?? 0)
        : (doc.cashback_value ?? 0);
      const finalCashbackAmount = !isNonFinancial && input.cashbackAmount !== undefined
        ? (input.cashbackAmount ?? 0)
        : (doc.cashback_amount ?? 0);

      const finalSubtotal = isNonFinancial ? 0 : totals.subtotal;
      const finalItemDiscount = isNonFinancial ? 0 : totals.itemDiscount;
      const finalDocNominalDiscount = isNonFinancial ? 0 : docNominalDiscount;
      const finalDocPercentageDiscount = isNonFinancial ? 0 : docPercentageDiscount;
      const finalTotalAmount = isNonFinancial ? 0 : totals.totalAmount;
      const finalDocumentDate = isNonFinancial ? doc.document_date : input.documentDate;
      const finalDueDate = isNonFinancial ? doc.due_date : input.dueDate;

      this.db.prepare(`
        UPDATE commercial_documents
        SET customer_id = ?, document_date = ?, due_date = ?, notes = ?,
            subtotal = ?, item_discount = ?, doc_nominal_discount = ?,
            doc_percentage_discount = ?, total_amount = ?, status = ?,
            shop_discount_note = ?, cashback_type = ?, cashback_value = ?, cashback_amount = ?,
            updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        input.customerId, finalDocumentDate, finalDueDate, notes,
        finalSubtotal, finalItemDiscount, finalDocNominalDiscount,
        finalDocPercentageDiscount, finalTotalAmount, newStatus,
        finalShopDiscountNote, finalCashbackType,
        finalCashbackValue, finalCashbackAmount,
        now, doc.id, context.ownerId
      );

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "UPDATE_COMMERCIAL_DOCUMENT",
        doc.document_type,
        doc.id,
        {
          documentNumber: doc.document_number,
          before: {
            customerId: doc.customer_id,
            documentDate: doc.document_date,
            dueDate: doc.due_date,
            subtotal: Number(doc.subtotal),
            itemDiscount: Number(doc.item_discount),
            docNominalDiscount: Number(doc.doc_nominal_discount),
            docPercentageDiscount: Number(doc.doc_percentage_discount),
            totalAmount: Number(doc.total_amount),
            status: doc.status,
            notes: doc.notes,
            lines: existingLines.map((l) => ({
              productId: l.product_id,
              quantity: Number(l.quantity),
              unitPrice: Number(l.unit_price),
              discountType: l.discount_type,
              discountValue: Number(l.discount_value),
              lineTotal: Number(l.line_total),
            })),
          },
          after: {
            customerId: input.customerId,
            documentDate: input.documentDate,
            dueDate: input.dueDate,
            subtotal: totals.subtotal,
            itemDiscount: totals.itemDiscount,
            docNominalDiscount,
            docPercentageDiscount,
            totalAmount: totals.totalAmount,
            status: newStatus,
            notes,
            lines: input.lines.map((l, idx) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              discountType: l.discountType,
              discountValue: l.discountType === "NONE" ? 0 : l.discountValue,
              lineTotal: totals.lines[idx].lineTotal,
            })),
          },
        }
      );

      const updated = this.getCommercialDocumentById(context, doc.id);
      if (!updated) {
        throw new AppError("ERR_INTERNAL_SERVER", "Gagal memuat dokumen setelah pembaruan.", 500);
      }
      return updated;
    });
  }

  /**
   * Mencatat Pencetakan Dokumen dan Menambah print_count Secara Atomik
   */
  recordDocumentPrint(
    context: ActiveSecurityContext,
    documentId: string
  ): { documentId: string; printCount: number } {
    this.assertContext(context);

    const doc = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, document_number, print_count
      FROM commercial_documents
      WHERE id = ? AND owner_id = ?
    `).get(documentId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id?: string | null;
      document_number: string;
      print_count: number;
    } | undefined;

    if (!doc) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen tidak ditemukan.", 404);
    }

    if (context.warehouseId && doc.warehouse_id && doc.warehouse_id !== context.warehouseId) {
      throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Dokumen berada di gudang yang berbeda.", 403);
    }

    const newPrintCount = Number(doc.print_count ?? 0) + 1;
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE commercial_documents
        SET print_count = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(newPrintCount, now, documentId, context.ownerId);

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "PRINT_COMMERCIAL_DOCUMENT",
        "DOCUMENT",
        documentId,
        {
          documentNumber: doc.document_number,
          printCount: newPrintCount,
        }
      );

      return { documentId, printCount: newPrintCount };
    });
  }

  /**
   * Membatalkan Dokumen Komersial (Soft-Cancel dengan Jejak Audit Penuh)
   * Aturan:
   * - Hanya Owner yang berwenang membatalkan dokumen komersial.
   * - Dokumen yang sudah dibatalkan tidak dapat dibatalkan ulang.
   * - Dokumen dengan pembayaran aktif (paid_amount > 0) dilarang dibatalkan.
   * - Alasan pembatalan wajib disertakan.
   */
  cancelCommercialDocument(
    context: ActiveSecurityContext,
    input: {
      documentId: string;
      reason: string;
    }
  ): { documentId: string; documentNumber: string; status: "CANCELLED" } {
    this.assertContext(context);

    const isOwnerOrSuperAdminInternal =
      !context.isSuperAdminOnBehalf &&
      (context.role === "OWNER" ||
        (context.role === "SUPER_ADMIN" && context.ownerId === "owner-super-admin"));

    if (!isOwnerOrSuperAdminInternal) {
      throw new AppError(
        "ERR_FORBIDDEN_ROLE",
        "Hanya Owner yang berwenang membatalkan dokumen komersial.",
        403
      );
    }

    const trimmedReason = input.reason?.trim();
    if (!trimmedReason || trimmedReason.length < 3) {
      throw new AppError(
        "ERR_VALIDATION",
        "Alasan pembatalan dokumen wajib diisi (minimal 3 karakter).",
        400
      );
    }

    const doc = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, document_number, document_type, status, paid_amount, notes
      FROM commercial_documents
      WHERE id = ? AND owner_id = ?
    `).get(input.documentId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id?: string | null;
      document_number: string;
      document_type: string;
      status: string;
      paid_amount: number;
      notes: string | null;
    } | undefined;

    if (!doc) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen tidak ditemukan.", 404);
    }

    if (context.warehouseId && doc.warehouse_id && doc.warehouse_id !== context.warehouseId) {
      throw new AppError("ERR_FORBIDDEN_WAREHOUSE", "Akses ditolak: Dokumen berada di gudang yang berbeda.", 403);
    }

    if (doc.status === "CANCELLED") {
      throw new AppError("ERR_CONFLICT", "Dokumen ini sudah dibatalkan sebelumnya.", 409);
    }

    if (Number(doc.paid_amount) > 0) {
      throw new AppError(
        "ERR_CONFLICT",
        `Dokumen ${doc.document_number} telah memiliki catatan pembayaran (Rp ${Number(doc.paid_amount).toLocaleString("id-ID")}) dan tidak dapat dibatalkan.`,
        409
      );
    }

    const now = new Date().toISOString();
    const updatedNotes = doc.notes
      ? `${doc.notes}\n[DIBATALKAN pada ${now.slice(0, 10)}]: ${trimmedReason}`
      : `[DIBATALKAN pada ${now.slice(0, 10)}]: ${trimmedReason}`;

    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE commercial_documents
        SET status = 'CANCELLED', notes = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(updatedNotes, now, doc.id, context.ownerId);

      this.recordAudit(
        context.ownerId,
        null,
        context.userId,
        "CANCEL_COMMERCIAL_DOCUMENT",
        doc.document_type,
        doc.id,
        {
          documentNumber: doc.document_number,
          previousStatus: doc.status,
          cancellationReason: trimmedReason,
        }
      );

      return {
        documentId: doc.id,
        documentNumber: doc.document_number,
        status: "CANCELLED",
      };
    });
  }

  /**
   * Mengambil Riwayat Pembayaran Nyata untuk Dokumen Komersial Tertentu
   */
  getDocumentPayments(
    context: ActiveSecurityContext,
    documentId: string
  ): Array<{
    id: string;
    documentId: string;
    paymentNumber: string;
    paymentDate: string;
    amount: number;
    paymentMethod: string;
    referenceNumber: string | null;
    notes: string | null;
    receivedByName: string;
    proofMimeType: string | null;
    proofBase64: string | null;
    proofFileName: string | null;
    proofFileSize: number | null;
    createdAt: string;
  }> {
    this.assertContext(context);

    const rows = this.db.prepare(`
      SELECT dp.id, dp.document_id, dp.payment_number, dp.payment_date,
             dp.amount, dp.payment_method, dp.reference_number, dp.notes,
             u.full_name as received_by_name,
             dp.proof_mime_type, dp.proof_base64, dp.proof_file_name, dp.proof_file_size,
             dp.created_at
      FROM document_payments dp
      JOIN users u ON u.id = dp.received_by_user_id
      WHERE dp.document_id = ? AND dp.owner_id = ?
      ORDER BY dp.created_at DESC
    `).all(documentId, context.ownerId) as Array<{
      id: string;
      document_id: string;
      payment_number: string;
      payment_date: string;
      amount: number;
      payment_method: string;
      reference_number: string | null;
      notes: string | null;
      received_by_name: string;
      proof_mime_type: string | null;
      proof_base64: string | null;
      proof_file_name: string | null;
      proof_file_size: number | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      paymentNumber: r.payment_number,
      paymentDate: r.payment_date,
      amount: Number(r.amount),
      paymentMethod: r.payment_method,
      referenceNumber: r.reference_number,
      notes: r.notes,
      receivedByName: r.received_by_name,
      proofMimeType: r.proof_mime_type ?? null,
      proofBase64: r.proof_base64 ?? null,
      proofFileName: r.proof_file_name ?? null,
      proofFileSize: r.proof_file_size != null ? Number(r.proof_file_size) : null,
      createdAt: r.created_at,
    }));
  }

  // ====================================================================
  // INVENTORY RETURNS (RETUR BARANG)
  // ====================================================================

  /**
   * Helper private: memperbarui return_status ('NONE', 'PARTIAL', 'FULL') pada goods_out / goods_in
   */
  private updateDocumentReturnStatus(docType: "GOODS_OUT" | "GOODS_IN", docId: string): void {
    const table = docType === "GOODS_OUT" ? "goods_out" : "goods_in";
    const linesTable = docType === "GOODS_OUT" ? "goods_out_lines" : "goods_in_lines";
    const docIdCol = docType === "GOODS_OUT" ? "goods_out_id" : "goods_in_id";

    const totalDocQtyRow = this.db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS total_qty FROM ${linesTable} WHERE ${docIdCol} = ?
    `).get(docId) as { total_qty: number };

    const totalRetQtyRow = this.db.prepare(`
      SELECT COALESCE(SUM(irl.quantity), 0) AS total_ret_qty
      FROM inventory_return_lines irl
      JOIN inventory_returns ir ON ir.id = irl.return_id
      WHERE ir.${docIdCol} = ? AND ir.status = 'RECEIVED'
    `).get(docId) as { total_ret_qty: number };

    const docQty = Number(totalDocQtyRow?.total_qty || 0);
    const retQty = Number(totalRetQtyRow?.total_ret_qty || 0);

    let newStatus: "NONE" | "PARTIAL" | "FULL" = "NONE";
    if (retQty >= docQty && docQty > 0) {
      newStatus = "FULL";
    } else if (retQty > 0) {
      newStatus = "PARTIAL";
    }

    this.db.prepare(`UPDATE ${table} SET return_status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, docId);
  }

  /**
   * Mengambil daftar Retur Barang milik Owner
   */
  getInventoryReturns(
    context: ActiveSecurityContext,
    filterWarehouseId?: string
  ): InventoryReturnRecord[] {
    this.assertContext(context, filterWarehouseId);
    const targetWh = filterWarehouseId ?? context.warehouseId;

    let query = `
      SELECT ir.id, ir.owner_id, ir.warehouse_id, w.name as warehouse_name,
             ir.return_type,
             ir.customer_id, c.name as customer_name,
             ir.supplier_id, s.name as supplier_name,
             ir.goods_out_id, ir.goods_in_id,
             ir.return_number, ir.return_date, ir.reason, ir.status,
             ir.reopen_source_qty, ir.notes
      FROM inventory_returns ir
      JOIN warehouses w ON w.id = ir.warehouse_id
      LEFT JOIN customers c ON c.id = ir.customer_id
      LEFT JOIN suppliers s ON s.id = ir.supplier_id
      WHERE ir.owner_id = ?
    `;
    const params: unknown[] = [context.ownerId];

    if (targetWh) {
      query += ` AND ir.warehouse_id = ?`;
      params.push(targetWh);
    }

    query += ` ORDER BY ir.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as Array<{
      id: string;
      owner_id: string;
      warehouse_id: string;
      warehouse_name: string;
      return_type: ReturnType | null;
      customer_id: string | null;
      customer_name: string | null;
      supplier_id: string | null;
      supplier_name: string | null;
      goods_out_id: string | null;
      goods_in_id: string | null;
      return_number: string;
      return_date: string;
      reason: "SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA";
      status: InventoryReturnStatus;
      reopen_source_qty: number;
      notes: string | null;
    }>;

    const lineStmt = this.db.prepare(`
      SELECT irl.id, irl.product_id, p.name as product_name, p.sku,
             irl.quantity, irl.unit, irl.condition, irl.returned_serials_json,
             irl.group_id, irl.group_return_mode
      FROM inventory_return_lines irl
      JOIN products p ON p.id = irl.product_id
      WHERE irl.return_id = ?
    `);

    return rows.map((r) => {
      const lineRows = lineStmt.all(r.id) as Array<{
        id: string;
        product_id: string;
        product_name: string;
        sku: string;
        quantity: number;
        unit: string;
        condition: "BAIK" | "RUSAK";
        returned_serials_json: string | null;
        group_id: string | null;
        group_return_mode: GroupReturnMode | null;
      }>;

      return {
        id: r.id,
        ownerId: r.owner_id,
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        returnType: r.return_type ?? "CUSTOMER_RETURN",
        customerId: r.customer_id,
        customerName: r.customer_name,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        goodsOutId: r.goods_out_id,
        goodsInId: r.goods_in_id,
        returnNumber: r.return_number,
        returnDate: r.return_date,
        reason: r.reason,
        status: r.status,
        reopenSourceQty: r.reopen_source_qty === 1,
        notes: r.notes,
        lines: lineRows.map((l) => ({
          id: l.id,
          productId: l.product_id,
          productName: l.product_name,
          sku: l.sku,
          quantity: Number(l.quantity),
          unit: l.unit,
          condition: l.condition,
          returnedSerials: l.returned_serials_json ? JSON.parse(l.returned_serials_json) : undefined,
          groupId: l.group_id ?? undefined,
          groupReturnMode: l.group_return_mode ?? undefined,
        })),
      };
    });
  }

  /**
   * Membuat Pengajuan Retur Barang (Status DRAFT - Tanpa Mutasi Ledger Sebelum Penerimaan Fisik)
   * Kebijakan reopen_source_qty V2.4.1:
   * SALAH_KIRIM, PEMBATALAN, SALAH_INPUT = true; CACAT, LAINNYA = false
   */
  createInventoryReturn(
    context: ActiveSecurityContext,
    input: CreateInventoryReturnInput
  ): InventoryReturnRecord {
    this.assertContext(context, input.warehouseId);

    const returnType = input.returnType ?? "CUSTOMER_RETURN";

    if (returnType === "CUSTOMER_RETURN" && !input.customerId) {
      throw new AppError("ERR_VALIDATION", "Pelanggan wajib dipilih untuk Retur Pelanggan.", 400);
    }
    if (returnType === "SUPPLIER_RETURN" && !input.supplierId) {
      throw new AppError("ERR_VALIDATION", "Pemasok wajib dipilih untuk Retur Supplier.", 400);
    }
    if (!input.returnNumber || !input.lines || input.lines.length === 0) {
      throw new AppError("ERR_VALIDATION", "Nomor retur dan minimal 1 produk wajib diisi.", 400);
    }

    // Evaluasi baseline reopen_source_qty LOCKED
    const reopenSourceQty = (
      input.reason === "SALAH_KIRIM" ||
      input.reason === "PEMBATALAN" ||
      input.reason === "SALAH_INPUT"
    ) ? 1 : 0;

    const returnId = crypto.randomUUID();
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // 1. Validasi Customer Return terhadap Goods Out rujukan jika disertakan
      if (returnType === "CUSTOMER_RETURN" && input.goodsOutId) {
        const go = this.db.prepare(`
          SELECT id, owner_id, status FROM goods_out WHERE id = ? AND owner_id = ?
        `).get(input.goodsOutId, context.ownerId) as { id: string; owner_id: string; status: string } | undefined;

        if (!go) {
          throw new AppError(RETURN_ERROR_CODES.DOC_NOT_FOUND, "Dokumen Goods Out rujukan tidak ditemukan.", 404);
        }

        if (go.status !== "COMPLETED") {
          throw new AppError(
            RETURN_ERROR_CODES.INVALID_DOC_STATUS,
            `Hanya Goods Out dengan status COMPLETED yang dapat diretur (status saat ini: ${go.status}).`,
            409
          );
        }

        for (const l of input.lines) {
          const goLine = this.db.prepare(`
            SELECT quantity, allocated_serials_json, group_id, group_serials_snapshot_json
            FROM goods_out_lines WHERE goods_out_id = ? AND product_id = ?
          `).get(input.goodsOutId, l.productId) as {
            quantity: number;
            allocated_serials_json: string | null;
            group_id: string | null;
            group_serials_snapshot_json: string | null;
          } | undefined;

          if (!goLine) {
            throw new AppError("ERR_VALIDATION", `Produk '${l.productId}' tidak terdapat pada pengiriman barang keluar rujukan.`, 400);
          }

          const retLineRow = this.db.prepare(`
            SELECT COALESCE(SUM(irl.quantity), 0) AS total_returned
            FROM inventory_return_lines irl
            JOIN inventory_returns ir ON ir.id = irl.return_id
            WHERE ir.goods_out_id = ? AND irl.product_id = ? AND ir.status != 'CANCELLED'
          `).get(input.goodsOutId, l.productId) as { total_returned: number };

          const remainingReturnable = Number(goLine.quantity) - Number(retLineRow.total_returned);
          if (l.quantity > remainingReturnable) {
            throw new AppError(
              RETURN_ERROR_CODES.QUANTITY_EXCEEDED,
              `Kuantitas retur (${l.quantity}) melebihi sisa kuantitas pengiriman yang dapat diretur (${remainingReturnable}).`,
              409
            );
          }

          if (l.returnedSerials && l.returnedSerials.length > 0) {
            const shippedSerials = new Set<string>();
            if (goLine.allocated_serials_json) {
              const ids: string[] = JSON.parse(goLine.allocated_serials_json);
              ids.forEach((idOrSn) => shippedSerials.add(idOrSn.toUpperCase()));
            }
            if (goLine.group_serials_snapshot_json) {
              const snapIds: string[] = JSON.parse(goLine.group_serials_snapshot_json);
              snapIds.forEach((id) => shippedSerials.add(id.toUpperCase()));
            }

            for (const sn of l.returnedSerials) {
              const snUpper = sn.trim().toUpperCase();
              const psRow = this.db.prepare(`
                SELECT id, serial_number FROM product_serials WHERE owner_id = ? AND (serial_number = ? OR id = ?)
              `).get(context.ownerId, snUpper, snUpper) as { id: string; serial_number: string } | undefined;

              if (psRow) {
                if (!shippedSerials.has(psRow.serial_number.toUpperCase()) && !shippedSerials.has(psRow.id.toUpperCase())) {
                  throw new AppError(
                    RETURN_ERROR_CODES.SERIAL_NOT_IN_SOURCE,
                    `Nomor seri '${sn}' tidak terdapat dalam pengiriman Goods Out rujukan.`,
                    400
                  );
                }
              }
            }
          }
        }
      }

      // 2. Validasi Supplier Return terhadap Goods In rujukan & status serial
      if (returnType === "SUPPLIER_RETURN") {
        if (input.goodsInId) {
          const gi = this.db.prepare(`
            SELECT id, owner_id, status FROM goods_in WHERE id = ? AND owner_id = ?
          `).get(input.goodsInId, context.ownerId) as { id: string; owner_id: string; status: string } | undefined;

          if (!gi) {
            throw new AppError(RETURN_ERROR_CODES.DOC_NOT_FOUND, "Dokumen Goods In rujukan tidak ditemukan.", 404);
          }

          if (gi.status !== "POSTED") {
            throw new AppError(
              RETURN_ERROR_CODES.INVALID_DOC_STATUS,
              `Hanya Goods In dengan status POSTED yang dapat diretur ke supplier (status saat ini: ${gi.status}).`,
              409
            );
          }

          for (const l of input.lines) {
            const giLine = this.db.prepare(`
              SELECT quantity FROM goods_in_lines WHERE goods_in_id = ? AND product_id = ?
            `).get(input.goodsInId, l.productId) as { quantity: number } | undefined;

            if (!giLine) {
              throw new AppError("ERR_VALIDATION", `Produk '${l.productId}' tidak terdapat pada penerimaan Goods In rujukan.`, 400);
            }

            const retLineRow = this.db.prepare(`
              SELECT COALESCE(SUM(irl.quantity), 0) AS total_returned
              FROM inventory_return_lines irl
              JOIN inventory_returns ir ON ir.id = irl.return_id
              WHERE ir.goods_in_id = ? AND irl.product_id = ? AND ir.status != 'CANCELLED'
            `).get(input.goodsInId, l.productId) as { total_returned: number };

            const remainingReturnable = Number(giLine.quantity) - Number(retLineRow.total_returned);
            if (l.quantity > remainingReturnable) {
              throw new AppError(
                RETURN_ERROR_CODES.QUANTITY_EXCEEDED,
                `Kuantitas retur beli (${l.quantity}) melebihi sisa kuantitas penerimaan yang dapat diretur (${remainingReturnable}).`,
                409
              );
            }
          }
        }

        // Validasi Serial untuk Supplier Return: WAJIB AVAILABLE dan TIDAK terikat di group aktif!
        for (const l of input.lines) {
          if (l.returnedSerials && l.returnedSerials.length > 0) {
            for (const sn of l.returnedSerials) {
              const snUpper = sn.trim().toUpperCase();
              const psRow = this.db.prepare(`
                SELECT id, serial_number, status, is_group, parent_group_id
                FROM product_serials
                WHERE owner_id = ? AND warehouse_id = ? AND (serial_number = ? OR normalized_serial_number = ?)
              `).get(context.ownerId, input.warehouseId, snUpper, snUpper) as {
                id: string;
                serial_number: string;
                status: string;
                is_group: number;
                parent_group_id: string | null;
              } | undefined;

              if (!psRow) {
                throw new AppError(
                  RETURN_ERROR_CODES.DOC_NOT_FOUND,
                  `Nomor seri '${sn}' tidak ditemukan di gudang.`,
                  404
                );
              }

              if (psRow.parent_group_id || psRow.status === "GROUPED") {
                const grp = psRow.parent_group_id
                  ? (this.db.prepare(`SELECT group_number, status FROM serial_groupings WHERE id = ?`).get(psRow.parent_group_id) as { group_number: string; status: string } | undefined)
                  : undefined;

                throw new AppError(
                  RETURN_ERROR_CODES.SERIAL_IN_ACTIVE_GROUP,
                  `Nomor seri '${sn}' terikat dalam group aktif${grp ? ` '${grp.group_number}'` : ''}. Ungroup / dissolve terlebih dahulu sebelum retur ke supplier.`,
                  409
                );
              }

              if (psRow.status !== "AVAILABLE") {
                throw new AppError(
                  RETURN_ERROR_CODES.SERIAL_NOT_AVAILABLE,
                  `Nomor seri '${sn}' tidak dapat diretur ke supplier karena statusnya '${psRow.status}' (Wajib AVAILABLE).`,
                  409
                );
              }
            }
          }
        }
      }

      // 1. Simpan dokumen retur dengan status DRAFT (Belum memotong/menambah stok sebelum diterima fisik)
      this.db.prepare(`
        INSERT INTO inventory_returns (
          id, owner_id, warehouse_id, return_type, customer_id, supplier_id,
          goods_out_id, goods_in_id, return_number, return_date,
          reason, status, reopen_source_qty, notes, created_by_user_id, received_by_user_id,
          received_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        returnId,
        context.ownerId,
        input.warehouseId,
        returnType,
        input.customerId ?? null,
        input.supplierId ?? null,
        input.goodsOutId ?? null,
        input.goodsInId ?? null,
        input.returnNumber.trim().toUpperCase(),
        input.returnDate,
        input.reason,
        reopenSourceQty,
        input.notes ?? null,
        context.userId,
        now,
        now
      );

      const lineInsert = this.db.prepare(`
        INSERT INTO inventory_return_lines (
          id, return_id, product_id, quantity, unit, condition, returned_serials_json,
          group_id, group_return_mode, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const l of input.lines) {
        const lineId = crypto.randomUUID();
        lineInsert.run(
          lineId,
          returnId,
          l.productId,
          l.quantity,
          l.unit ?? "pcs",
          l.condition,
          l.returnedSerials ? JSON.stringify(l.returnedSerials) : null,
          l.groupId ?? null,
          l.groupReturnMode ?? null,
          now
        );
      }

      this.recordAudit(
        context.ownerId,
        input.warehouseId,
        context.userId,
        "CREATE_INVENTORY_RETURN",
        "RETURN",
        returnId,
        {
          returnNumber: input.returnNumber,
          returnType,
          reason: input.reason,
          status: "DRAFT",
          reopenSourceQty: reopenSourceQty === 1,
          lineCount: input.lines.length,
        }
      );

      return {
        id: returnId,
        ownerId: context.ownerId,
        warehouseId: input.warehouseId,
        returnType,
        customerId: input.customerId ?? null,
        supplierId: input.supplierId ?? null,
        goodsOutId: input.goodsOutId ?? null,
        goodsInId: input.goodsInId ?? null,
        returnNumber: input.returnNumber,
        returnDate: input.returnDate,
        reason: input.reason,
        status: "DRAFT",
        reopenSourceQty: reopenSourceQty === 1,
        notes: input.notes ?? null,
        lines: input.lines.map((l) => ({
          id: crypto.randomUUID(),
          productId: l.productId,
          quantity: l.quantity,
          unit: l.unit ?? "pcs",
          condition: l.condition,
          returnedSerials: l.returnedSerials,
        })),
      };
    });
  }

  /**
   * Persetujuan & Penerimaan Fisik Retur Barang (Customer Return & Supplier Return)
   * Customer Return:
   *   - Serial mandiri: CONSUMED_OUT -> AVAILABLE (atau QUARANTINE jika RUSAK).
   *   - Group Utuh (WHOLE_GROUP): pulihkan wadah group ke AVAILABLE, anak serial ikut GROUPED.
   *   - Group Eceran (ECERAN_DISSOLVE): wadah group di-DISSOLVED, serial kembali jadi AVAILABLE.
   *   - Mutasi ledger positif RETURN_IN_POSTED.
   * Supplier Return:
   *   - Potong stok fisik via ledger negatif RETURN_OUT_POSTED.
   *   - Update status serial -> RETURNED_TO_SUPPLIER.
   */
  approveAndReceiveInventoryReturn(
    context: ActiveSecurityContext,
    returnId: string
  ): { received: boolean; returnId: string; ledgerEntriesCount: number } {
    const ret = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, return_type, customer_id, supplier_id,
             goods_out_id, goods_in_id, return_number, reason, status, reopen_source_qty
      FROM inventory_returns
      WHERE id = ? AND owner_id = ?
    `).get(returnId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      return_type: ReturnType | null;
      customer_id: string | null;
      supplier_id: string | null;
      goods_out_id: string | null;
      goods_in_id: string | null;
      return_number: string;
      reason: string;
      status: string;
      reopen_source_qty: number;
    } | undefined;

    if (!ret) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen retur tidak ditemukan.", 404);
    }

    this.assertContext(context, ret.warehouse_id);

    if (ret.status !== "DRAFT") {
      if (ret.status === "RECEIVED") {
        throw new AppError(RETURN_ERROR_CODES.ALREADY_RECEIVED, "Dokumen retur sudah disetujui & diterima sebelumnya.", 409);
      }
      throw new AppError(
        "ERR_CONFLICT",
        `Retur tidak dapat diproses penerimaan fisiknya karena statusnya adalah '${ret.status}' (Hanya DRAFT yang dapat disetujui).`,
        409
      );
    }

    const lines = this.db.prepare(`
      SELECT id, product_id, quantity, unit, condition, returned_serials_json,
             group_id, group_return_mode
      FROM inventory_return_lines
      WHERE return_id = ?
    `).all(returnId) as Array<{
      id: string;
      product_id: string;
      quantity: number;
      unit: string;
      condition: "BAIK" | "RUSAK";
      returned_serials_json: string | null;
      group_id: string | null;
      group_return_mode: GroupReturnMode | null;
    }>;

    if (lines.length === 0) {
      throw new AppError("ERR_CONFLICT", "Dokumen retur tidak memiliki rincian produk.", 409);
    }

    const now = new Date().toISOString();
    const isSupplierReturn = ret.return_type === "SUPPLIER_RETURN";

    return this.db.transaction(() => {
      let ledgerEntriesCount = 0;

      if (isSupplierReturn) {
        // ==========================================
        // SUPPLIER_RETURN (Retur Beli ke Pemasok)
        // ==========================================
        for (const l of lines) {
          const serialIdsForLedger: string[] = [];
          if (l.returned_serials_json) {
            const serials: string[] = JSON.parse(l.returned_serials_json);
            for (const sn of serials) {
              const sRow = this.db.prepare(`
                SELECT id FROM product_serials
                WHERE owner_id = ? AND warehouse_id = ? AND (serial_number = ? OR normalized_serial_number = ?)
              `).get(context.ownerId, ret.warehouse_id, sn.trim().toUpperCase(), sn.trim().toUpperCase()) as { id: string } | undefined;

              if (sRow) {
                this.db.prepare(`
                  UPDATE product_serials
                  SET status = 'RETURNED_TO_SUPPLIER', updated_at = ?
                  WHERE id = ?
                `).run(now, sRow.id);
                serialIdsForLedger.push(sRow.id);
              }
            }
          }

          // Potong stok fisik via ledger negatif RETURN_OUT_POSTED
          const nextSeq = this.getNextLedgerSequence(context.ownerId);
          const ledgerId = crypto.randomUUID();

          this.db.prepare(`
            INSERT INTO inventory_ledger (
              id, sequence_number, owner_id, warehouse_id, product_id, location_id,
              entry_type, source_doc_type, source_doc_id, source_line_id,
              quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, null, 'RETURN_OUT_POSTED', 'RETURN', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ledgerId,
            nextSeq,
            context.ownerId,
            ret.warehouse_id,
            l.product_id,
            returnId,
            l.id,
            -Math.abs(Number(l.quantity)),
            serialIdsForLedger.length > 0 ? JSON.stringify(serialIdsForLedger) : l.returned_serials_json,
            context.userId,
            now,
            now
          );

          ledgerEntriesCount++;
        }

        // Update return_status pada Goods In
        if (ret.goods_in_id) {
          this.updateDocumentReturnStatus("GOODS_IN", ret.goods_in_id);
        }
      } else {
        // ==========================================
        // CUSTOMER_RETURN (Retur Barang dari Pelanggan)
        // ==========================================
        for (const l of lines) {
          let ledgerDeltaBase = Number(l.quantity);
          let serialIdsForLedger: string[] = [];

          // Skenario A: Group Utuh (WHOLE_GROUP)
          if (l.group_return_mode === "WHOLE_GROUP" && l.group_id) {
            const grp = this.db.prepare(`
              SELECT id, group_number, product_id, total_base_qty_pcs, unit_qty, unit
              FROM serial_groupings WHERE id = ? AND owner_id = ?
            `).get(l.group_id, context.ownerId) as {
              id: string;
              group_number: string;
              product_id: string | null;
              total_base_qty_pcs: number;
              unit_qty: number;
              unit: string;
            } | undefined;

            if (grp) {
              // 1. Pulihkan wadah group ke AVAILABLE
              this.db.prepare(`
                UPDATE serial_groupings
                SET status = 'AVAILABLE', dissolved_by = NULL, dissolved_at = NULL
                WHERE id = ?
              `).run(grp.id);

              // 2. Pulihkan serial group di product_serials ke AVAILABLE
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'AVAILABLE', warehouse_id = ?, updated_at = ?
                WHERE owner_id = ? AND serial_number = ? AND is_group = 1
              `).run(ret.warehouse_id, now, context.ownerId, grp.group_number);

              // 3. Anak-anak serial ikut GROUPED terikat parent
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'GROUPED', parent_group_id = ?, warehouse_id = ?, updated_at = ?
                WHERE owner_id = ? AND id IN (
                  SELECT serial_id FROM serial_grouping_components WHERE grouping_id = ?
                )
              `).run(grp.id, ret.warehouse_id, now, context.ownerId, grp.id);

              ledgerDeltaBase = Number(grp.total_base_qty_pcs) || (Number(grp.unit_qty) * getUnitMultiplier(grp.unit));

              const compRows = this.db.prepare(`
                SELECT serial_id FROM serial_grouping_components WHERE grouping_id = ?
              `).all(grp.id) as Array<{ serial_id: string }>;
              serialIdsForLedger = compRows.map((c) => c.serial_id);
            }
          }
          // Skenario B: Group Eceran (ECERAN_DISSOLVE)
          else if (l.group_return_mode === "ECERAN_DISSOLVE" && l.group_id) {
            const grp = this.db.prepare(`
              SELECT id, group_number FROM serial_groupings WHERE id = ? AND owner_id = ?
            `).get(l.group_id, context.ownerId) as { id: string; group_number: string } | undefined;

            if (grp) {
              // 1. Wadah group di-DISSOLVED
              this.db.prepare(`
                UPDATE serial_groupings
                SET status = 'DISSOLVED', dissolved_by = ?, dissolved_at = ?, notes = COALESCE(notes || ' | ', '') || 'DISSOLVED akibat retur eceran oleh pelanggan'
                WHERE id = ?
              `).run(context.userId, now, grp.id);

              // 2. Serial header group di-DECOMMISSIONED
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'DECOMMISSIONED', updated_at = ?
                WHERE owner_id = ? AND serial_number = ? AND is_group = 1
              `).run(now, context.ownerId, grp.group_number);

              // 3. Serial yang fisik kembali jadi AVAILABLE (atau QUARANTINE jika RUSAK)
              const returnedSns: string[] = l.returned_serials_json ? JSON.parse(l.returned_serials_json) : [];
              const serialTargetStatus = l.condition === "BAIK" ? "AVAILABLE" : "QUARANTINE";

              for (const sn of returnedSns) {
                const sRow = this.db.prepare(`
                  SELECT id FROM product_serials WHERE owner_id = ? AND (serial_number = ? OR id = ?)
                `).get(context.ownerId, sn.trim().toUpperCase(), sn) as { id: string } | undefined;

                if (sRow) {
                  this.db.prepare(`
                    UPDATE product_serials
                    SET status = ?, parent_group_id = NULL, warehouse_id = ?, updated_at = ?
                    WHERE id = ?
                  `).run(serialTargetStatus, ret.warehouse_id, now, sRow.id);
                  serialIdsForLedger.push(sRow.id);
                }
              }

              // 4. Serial dalam group yang TIDAK kembali tetap CONSUMED_OUT, tetapi dilepas keterikatan parent_group_id
              this.db.prepare(`
                UPDATE product_serials
                SET parent_group_id = NULL, updated_at = ?
                WHERE parent_group_id = ? AND status = 'CONSUMED_OUT'
              `).run(now, grp.id);

              ledgerDeltaBase = returnedSns.length > 0 ? returnedSns.length : Number(l.quantity);
            }
          }
          // Skenario C: Serial Mandiri (Non-group)
          else {
            if (l.returned_serials_json) {
              const serials: string[] = JSON.parse(l.returned_serials_json);
              const serialTargetStatus = l.condition === "BAIK" ? "AVAILABLE" : "QUARANTINE";

              for (const sn of serials) {
                const sRow = this.db.prepare(`
                  SELECT id FROM product_serials WHERE owner_id = ? AND (serial_number = ? OR id = ?)
                `).get(context.ownerId, sn.trim().toUpperCase(), sn) as { id: string } | undefined;

                if (sRow) {
                  this.db.prepare(`
                    UPDATE product_serials
                    SET status = ?, warehouse_id = ?, updated_at = ?
                    WHERE id = ?
                  `).run(serialTargetStatus, ret.warehouse_id, now, sRow.id);
                  serialIdsForLedger.push(sRow.id);
                }
              }
            }
          }

          // Mutasi ledger positif RETURN_IN_POSTED
          const nextSeq = this.getNextLedgerSequence(context.ownerId);
          const ledgerId = crypto.randomUUID();

          this.db.prepare(`
            INSERT INTO inventory_ledger (
              id, sequence_number, owner_id, warehouse_id, product_id, location_id,
              entry_type, source_doc_type, source_doc_id, source_line_id,
              quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, null, 'RETURN_IN_POSTED', 'RETURN', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ledgerId,
            nextSeq,
            context.ownerId,
            ret.warehouse_id,
            l.product_id,
            returnId,
            l.id,
            ledgerDeltaBase,
            serialIdsForLedger.length > 0 ? JSON.stringify(serialIdsForLedger) : l.returned_serials_json,
            context.userId,
            now,
            now
          );

          ledgerEntriesCount++;
        }

        // Buka kembali kuota PO jika reopen_source_qty = 1
        if (ret.reopen_source_qty === 1 && ret.goods_out_id) {
          const go = this.db.prepare(`
            SELECT po_id FROM goods_out WHERE id = ?
          `).get(ret.goods_out_id) as { po_id: string | null } | undefined;

          if (go?.po_id) {
            for (const l of lines) {
              this.db.prepare(`
                UPDATE purchase_order_lines
                SET fulfilled_qty = MAX(0, fulfilled_qty - ?)
                WHERE po_id = ? AND product_id = ?
              `).run(l.quantity, go.po_id, l.product_id);
            }

            const poLines = this.db.prepare(`
              SELECT target_qty, fulfilled_qty
              FROM purchase_order_lines
              WHERE po_id = ?
            `).all(go.po_id) as Array<{ target_qty: number; fulfilled_qty: number }>;

            const allDone = poLines.length > 0 && poLines.every((pl) => Number(pl.fulfilled_qty) >= Number(pl.target_qty));
            const anyDone = poLines.some((pl) => Number(pl.fulfilled_qty) > 0);
            const newPoStatus = allDone ? "FULFILLED" : (anyDone ? "PARTIALLY_FULFILLED" : "CONFIRMED");

            this.db.prepare(`
              UPDATE purchase_orders
              SET status = ?, updated_at = ?
              WHERE id = ?
            `).run(newPoStatus, now, go.po_id);
          }
        }
      }

      // Update status retur ke RECEIVED
      this.db.prepare(`
        UPDATE inventory_returns
        SET status = 'RECEIVED', received_by_user_id = ?, received_at = ?, updated_at = ?
        WHERE id = ?
      `).run(context.userId, now, now, returnId);

      // Update return_status pada dokumen sumber (Goods Out / Goods In) setelah status retur resmi RECEIVED
      if (ret.goods_out_id) {
        this.updateDocumentReturnStatus("GOODS_OUT", ret.goods_out_id);
      }
      if (ret.goods_in_id) {
        this.updateDocumentReturnStatus("GOODS_IN", ret.goods_in_id);
      }

      this.recordAudit(
        context.ownerId,
        ret.warehouse_id,
        context.userId,
        "APPROVE_AND_RECEIVE_RETURN",
        "RETURN",
        returnId,
        {
          returnNumber: ret.return_number,
          returnType: ret.return_type ?? "CUSTOMER_RETURN",
          ledgerEntriesCount,
          reopenSourceQty: ret.reopen_source_qty === 1,
          goodsOutId: ret.goods_out_id ?? undefined,
          goodsInId: ret.goods_in_id ?? undefined,
        }
      );

      return { received: true, returnId, ledgerEntriesCount };
    });
  }

  /**
   * Batalkan retur DRAFT tanpa mutasi ledger.
   */
  cancelDraftInventoryReturn(
    context: ActiveSecurityContext,
    returnId: string,
    reason?: string
  ): { cancelled: boolean; returnId: string } {
    const ret = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, return_number, status
      FROM inventory_returns
      WHERE id = ? AND owner_id = ?
    `).get(returnId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      return_number: string;
      status: string;
    } | undefined;

    if (!ret) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen retur tidak ditemukan.", 404);
    }

    this.assertContext(context, ret.warehouse_id);

    if (ret.status !== "DRAFT") {
      throw new AppError(
        RETURN_ERROR_CODES.CANNOT_CANCEL,
        `Hanya retur berstatus DRAFT yang dapat dibatalkan (status saat ini: ${ret.status}).`,
        409
      );
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE inventory_returns
      SET status = 'CANCELLED', notes = COALESCE(notes || ' | ', '') || ?, updated_at = ?
      WHERE id = ?
    `).run(`[DRAFT DIBATALKAN: ${reason || "Dibatalkan oleh operator"}]`, now, returnId);

    this.recordAudit(
      context.ownerId,
      ret.warehouse_id,
      context.userId,
      "CANCEL_DRAFT_RETURN",
      "RETURN",
      returnId,
      {
        returnNumber: ret.return_number,
        reason,
      }
    );

    return { cancelled: true, returnId };
  }

  /**
   * Alias kompatibilitas untuk cancelDraftInventoryReturn
   */
  cancelInventoryReturn(
    context: ActiveSecurityContext,
    returnId: string,
    reason?: string
  ): { cancelled: boolean; returnId: string } {
    return this.cancelDraftInventoryReturn(context, returnId, reason);
  }

  /**
   * Revert / Batalkan retur RECEIVED (Restore Transaksi Retur yang Sudah Selesai)
   * Membalikkan mutasi ledger melalui entri kompensasi RETURN_REVERSAL_POSTED,
   * memverifikasi bahwa serial yang dulu dikembalikan masih AVAILABLE di gudang,
   * dan memulihkan status serial & group ke snapshot sebelum retur.
   */
  revertReceivedInventoryReturn(
    context: ActiveSecurityContext,
    input: RevertInventoryReturnInput
  ): { reverted: boolean; returnId: string; ledgerEntriesCount: number } {
    const ret = this.db.prepare(`
      SELECT id, owner_id, warehouse_id, return_type, customer_id, supplier_id,
             goods_out_id, goods_in_id, return_number, reason, status, reopen_source_qty
      FROM inventory_returns
      WHERE id = ? AND owner_id = ?
    `).get(input.returnId, context.ownerId) as {
      id: string;
      owner_id: string;
      warehouse_id: string;
      return_type: ReturnType | null;
      customer_id: string | null;
      supplier_id: string | null;
      goods_out_id: string | null;
      goods_in_id: string | null;
      return_number: string;
      reason: string;
      status: string;
      reopen_source_qty: number;
    } | undefined;

    if (!ret) {
      throw new AppError("ERR_NOT_FOUND", "Dokumen retur tidak ditemukan.", 404);
    }

    this.assertContext(context, ret.warehouse_id);

    if (ret.status !== "RECEIVED") {
      throw new AppError(
        RETURN_ERROR_CODES.CANNOT_REVERT,
        `Hanya retur berstatus RECEIVED yang dapat direvert / dibatalkan (status saat ini: ${ret.status}).`,
        409
      );
    }

    const lines = this.db.prepare(`
      SELECT id, product_id, quantity, unit, condition, returned_serials_json,
             group_id, group_return_mode
      FROM inventory_return_lines
      WHERE return_id = ?
    `).all(input.returnId) as Array<{
      id: string;
      product_id: string;
      quantity: number;
      unit: string;
      condition: "BAIK" | "RUSAK";
      returned_serials_json: string | null;
      group_id: string | null;
      group_return_mode: GroupReturnMode | null;
    }>;

    const now = new Date().toISOString();
    const isSupplierReturn = ret.return_type === "SUPPLIER_RETURN";

    return this.db.transaction(() => {
      let ledgerEntriesCount = 0;

      if (isSupplierReturn) {
        // ==========================================
        // SUPPLIER_RETURN REVERSAL
        // ==========================================
        for (const l of lines) {
          if (l.returned_serials_json) {
            const snList: string[] = JSON.parse(l.returned_serials_json);
            for (const sn of snList) {
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'AVAILABLE', warehouse_id = ?, updated_at = ?
                WHERE owner_id = ? AND (serial_number = ? OR id = ?)
              `).run(ret.warehouse_id, now, context.ownerId, sn.trim().toUpperCase(), sn);
            }
          }

          // Balik mutasi ledger dengan entri kompensasi RETURN_REVERSAL_POSTED (kuantitas positif)
          const nextSeq = this.getNextLedgerSequence(context.ownerId);
          const ledgerId = crypto.randomUUID();

          this.db.prepare(`
            INSERT INTO inventory_ledger (
              id, sequence_number, owner_id, warehouse_id, product_id, location_id,
              entry_type, source_doc_type, source_doc_id, source_line_id,
              quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, null, 'RETURN_REVERSAL_POSTED', 'RETURN', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ledgerId,
            nextSeq,
            context.ownerId,
            ret.warehouse_id,
            l.product_id,
            ret.id,
            l.id,
            Math.abs(Number(l.quantity)),
            l.returned_serials_json,
            context.userId,
            now,
            now
          );

          ledgerEntriesCount++;
        }

        // Update return_status pada Goods In
        if (ret.goods_in_id) {
          this.db.prepare(`UPDATE inventory_returns SET status = 'CANCELLED' WHERE id = ?`).run(ret.id);
          this.updateDocumentReturnStatus("GOODS_IN", ret.goods_in_id);
        }
      } else {
        // ==========================================
        // CUSTOMER_RETURN REVERSAL
        // ==========================================
        // 1. Validasi serial: apakah masih AVAILABLE atau QUARANTINE (belum terjual lagi)?
        for (const l of lines) {
          if (l.group_return_mode === "WHOLE_GROUP" && l.group_id) {
            const grp = this.db.prepare(`
              SELECT status, group_number FROM serial_groupings WHERE id = ?
            `).get(l.group_id) as { status: string; group_number: string } | undefined;

            if (grp && grp.status !== "AVAILABLE") {
              throw new AppError(
                RETURN_ERROR_CODES.CANNOT_REVERT,
                `Group '${grp.group_number}' tidak lagi berstatus AVAILABLE (status: ${grp.status}). Reversal retur dibatalkan.`,
                409
              );
            }
          }

          if (l.returned_serials_json) {
            const snList: string[] = JSON.parse(l.returned_serials_json);
            for (const sn of snList) {
              const psRow = this.db.prepare(`
                SELECT serial_number, status FROM product_serials
                WHERE owner_id = ? AND (serial_number = ? OR id = ?)
              `).get(context.ownerId, sn.trim().toUpperCase(), sn) as { serial_number: string; status: string } | undefined;

              if (psRow && psRow.status !== "AVAILABLE" && psRow.status !== "QUARANTINE" && psRow.status !== "GROUPED") {
                throw new AppError(
                  RETURN_ERROR_CODES.CANNOT_REVERT,
                  `Nomor seri '${psRow.serial_number}' tidak dapat direvert karena sudah tidak tersedia di gudang (status: ${psRow.status}).`,
                  409
                );
              }
            }
          }
        }

        // 2. Kembalikan status serial & group ke snapshot sebelum retur (CONSUMED_OUT)
        for (const l of lines) {
          let reverseDeltaBase = Number(l.quantity);

          if (l.group_return_mode === "WHOLE_GROUP" && l.group_id) {
            const grp = this.db.prepare(`
              SELECT id, group_number, total_base_qty_pcs, unit_qty, unit FROM serial_groupings WHERE id = ?
            `).get(l.group_id) as { id: string; group_number: string; total_base_qty_pcs: number; unit_qty: number; unit: string } | undefined;

            if (grp) {
              this.db.prepare(`UPDATE serial_groupings SET status = 'CONSUMED_OUT' WHERE id = ?`).run(grp.id);
              this.db.prepare(`
                UPDATE product_serials
                SET status = 'CONSUMED_OUT', updated_at = ?
                WHERE owner_id = ? AND serial_number = ? AND is_group = 1
              `).run(now, context.ownerId, grp.group_number);

              this.db.prepare(`
                UPDATE product_serials
                SET status = 'CONSUMED_OUT', updated_at = ?
                WHERE parent_group_id = ?
              `).run(now, grp.id);

              reverseDeltaBase = Number(grp.total_base_qty_pcs) || (Number(grp.unit_qty) * getUnitMultiplier(grp.unit));
            }
          } else {
            if (l.returned_serials_json) {
              const snList: string[] = JSON.parse(l.returned_serials_json);
              for (const sn of snList) {
                this.db.prepare(`
                  UPDATE product_serials
                  SET status = 'CONSUMED_OUT', updated_at = ?
                  WHERE owner_id = ? AND (serial_number = ? OR id = ?)
                `).run(now, context.ownerId, sn.trim().toUpperCase(), sn);
              }
            }
          }

          // Balik mutasi ledger dengan entri kompensasi RETURN_REVERSAL_POSTED (kuantitas negatif)
          const nextSeq = this.getNextLedgerSequence(context.ownerId);
          const ledgerId = crypto.randomUUID();

          this.db.prepare(`
            INSERT INTO inventory_ledger (
              id, sequence_number, owner_id, warehouse_id, product_id, location_id,
              entry_type, source_doc_type, source_doc_id, source_line_id,
              quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, null, 'RETURN_REVERSAL_POSTED', 'RETURN', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ledgerId,
            nextSeq,
            context.ownerId,
            ret.warehouse_id,
            l.product_id,
            ret.id,
            l.id,
            -Math.abs(reverseDeltaBase),
            l.returned_serials_json,
            context.userId,
            now,
            now
          );

          ledgerEntriesCount++;
        }

        // Jika dulu reopen_source_qty = 1 dan ada PO, pulihkan penambahan fulfilled_qty
        if (ret.reopen_source_qty === 1 && ret.goods_out_id) {
          const go = this.db.prepare(`SELECT po_id FROM goods_out WHERE id = ?`).get(ret.goods_out_id) as { po_id: string | null } | undefined;
          if (go?.po_id) {
            for (const l of lines) {
              this.db.prepare(`
                UPDATE purchase_order_lines
                SET fulfilled_qty = fulfilled_qty + ?
                WHERE po_id = ? AND product_id = ?
              `).run(l.quantity, go.po_id, l.product_id);
            }
          }
        }

        // Update return_status pada Goods Out
        if (ret.goods_out_id) {
          this.db.prepare(`UPDATE inventory_returns SET status = 'CANCELLED' WHERE id = ?`).run(ret.id);
          this.updateDocumentReturnStatus("GOODS_OUT", ret.goods_out_id);
        }
      }

      // Finalize status retur ke CANCELLED
      const reversalReasonNote = input.reason ? ` [REVERTED: ${input.reason.trim()}]` : " [REVERTED]";
      this.db.prepare(`
        UPDATE inventory_returns
        SET status = 'CANCELLED', notes = COALESCE(notes || ' | ', '') || ?, updated_at = ?
        WHERE id = ?
      `).run(reversalReasonNote, now, ret.id);

      this.recordAudit(
        context.ownerId,
        ret.warehouse_id,
        context.userId,
        "REVERT_INVENTORY_RETURN",
        "RETURN",
        ret.id,
        {
          returnNumber: ret.return_number,
          returnType: ret.return_type ?? "CUSTOMER_RETURN",
          ledgerEntriesCount,
          reason: input.reason,
        }
      );

      return { reverted: true, returnId: ret.id, ledgerEntriesCount };
    });
  }

  /**
   * Alias kompatibilitas untuk revertReceivedInventoryReturn
   */
  revertInventoryReturn(
    context: ActiveSecurityContext,
    returnId: string,
    revertReason: string
  ): { reverted: boolean; returnId: string; ledgerEntriesCount: number } {
    return this.revertReceivedInventoryReturn(context, { returnId, reason: revertReason });
  }

  /**
   * Mengambil serial yang dapat diretur dari Goods Out tertentu atau Goods In tertentu.
   */
  getReturnableSerials(
    context: ActiveSecurityContext,
    params: { goodsOutId?: string; goodsInId?: string; productId?: string }
  ): Array<{
    serialId: string;
    serialNumber: string;
    productId: string;
    productName: string;
    sku: string;
    status: string;
    isGroup: boolean;
    parentGroupId: string | null;
    groupNumber: string | null;
  }> {
    if (!params.goodsOutId && !params.goodsInId) {
      throw new AppError("ERR_VALIDATION", "goodsOutId atau goodsInId wajib disertakan.", 400);
    }

    if (params.goodsOutId) {
      const lines = this.db.prepare(`
        SELECT product_id, allocated_serials_json, group_id, group_serials_snapshot_json
        FROM goods_out_lines
        WHERE goods_out_id = ?
      `).all(params.goodsOutId) as Array<{
        product_id: string;
        allocated_serials_json: string | null;
        group_id: string | null;
        group_serials_snapshot_json: string | null;
      }>;

      const serialIds = new Set<string>();
      for (const l of lines) {
        if (params.productId && l.product_id !== params.productId) continue;

        if (l.allocated_serials_json) {
          const ids: string[] = JSON.parse(l.allocated_serials_json);
          ids.forEach((id) => serialIds.add(id));
        }
        if (l.group_serials_snapshot_json) {
          const snapIds: string[] = JSON.parse(l.group_serials_snapshot_json);
          snapIds.forEach((id) => serialIds.add(id));
        }
      }

      if (serialIds.size === 0) return [];

      const returnedRows = this.db.prepare(`
        SELECT irl.returned_serials_json
        FROM inventory_return_lines irl
        JOIN inventory_returns ir ON ir.id = irl.return_id
        WHERE ir.goods_out_id = ? AND ir.status IN ('DRAFT', 'RECEIVED') AND irl.returned_serials_json IS NOT NULL
      `).all(params.goodsOutId) as Array<{ returned_serials_json: string }>;

      const alreadyReturnedSns = new Set<string>();
      for (const r of returnedRows) {
        const sns: string[] = JSON.parse(r.returned_serials_json);
        sns.forEach((sn) => alreadyReturnedSns.add(sn.toUpperCase()));
      }

      const placeholders = Array.from(serialIds).map(() => "?").join(",");
      const query = `
        SELECT ps.id AS serialId, ps.serial_number AS serialNumber, ps.product_id AS productId,
               p.name AS productName, p.sku AS sku, ps.status, ps.is_group AS isGroup,
               ps.parent_group_id AS parentGroupId, sg.group_number AS groupNumber
        FROM product_serials ps
        JOIN products p ON p.id = ps.product_id
        LEFT JOIN serial_groupings sg ON sg.id = ps.parent_group_id
        WHERE ps.owner_id = ? AND (ps.id IN (${placeholders}) OR ps.serial_number IN (${placeholders}))
      `;
      const rows = this.db.prepare(query).all(context.ownerId, ...Array.from(serialIds), ...Array.from(serialIds)) as Array<{
        serialId: string;
        serialNumber: string;
        productId: string;
        productName: string;
        sku: string;
        status: string;
        isGroup: number;
        parentGroupId: string | null;
        groupNumber: string | null;
      }>;

      return rows
        .filter((r) => !alreadyReturnedSns.has(r.serialNumber.toUpperCase()) && !alreadyReturnedSns.has(r.serialId.toUpperCase()))
        .map((r) => ({
          serialId: r.serialId,
          serialNumber: r.serialNumber,
          productId: r.productId,
          productName: r.productName,
          sku: r.sku,
          status: r.status,
          isGroup: r.isGroup === 1,
          parentGroupId: r.parentGroupId,
          groupNumber: r.groupNumber,
        }));
    } else {
      const lines = this.db.prepare(`
        SELECT product_id, received_serials_json
        FROM goods_in_lines
        WHERE goods_in_id = ?
      `).all(params.goodsInId) as Array<{
        product_id: string;
        received_serials_json: string | null;
      }>;

      const serialIds = new Set<string>();
      for (const l of lines) {
        if (params.productId && l.product_id !== params.productId) continue;
        if (l.received_serials_json) {
          const ids: string[] = JSON.parse(l.received_serials_json);
          ids.forEach((id) => serialIds.add(id));
        }
      }

      const returnedRows = this.db.prepare(`
        SELECT irl.returned_serials_json
        FROM inventory_return_lines irl
        JOIN inventory_returns ir ON ir.id = irl.return_id
        WHERE ir.goods_in_id = ? AND ir.status IN ('DRAFT', 'RECEIVED') AND irl.returned_serials_json IS NOT NULL
      `).all(params.goodsInId) as Array<{ returned_serials_json: string }>;

      const alreadyReturnedSns = new Set<string>();
      for (const r of returnedRows) {
        const sns: string[] = JSON.parse(r.returned_serials_json);
        sns.forEach((sn) => alreadyReturnedSns.add(sn.toUpperCase()));
      }

      let query = `
        SELECT ps.id AS serialId, ps.serial_number AS serialNumber, ps.product_id AS productId,
               p.name AS productName, p.sku AS sku, ps.status, ps.is_group AS isGroup,
               ps.parent_group_id AS parentGroupId, sg.group_number AS groupNumber
        FROM product_serials ps
        JOIN products p ON p.id = ps.product_id
        LEFT JOIN serial_groupings sg ON sg.id = ps.parent_group_id
        WHERE ps.owner_id = ? AND ps.status = 'AVAILABLE' AND ps.parent_group_id IS NULL
      `;
      const queryParams: unknown[] = [context.ownerId];

      if (params.productId) {
        query += ` AND ps.product_id = ?`;
        queryParams.push(params.productId);
      }

      if (serialIds.size > 0) {
        const placeholders = Array.from(serialIds).map(() => "?").join(",");
        query += ` AND (ps.source_goods_in_id = ? OR ps.id IN (${placeholders}) OR ps.serial_number IN (${placeholders}))`;
        queryParams.push(params.goodsInId, ...Array.from(serialIds), ...Array.from(serialIds));
      } else {
        query += ` AND ps.source_goods_in_id = ?`;
        queryParams.push(params.goodsInId);
      }

      const rows = this.db.prepare(query).all(...queryParams) as Array<{
        serialId: string;
        serialNumber: string;
        productId: string;
        productName: string;
        sku: string;
        status: string;
        isGroup: number;
        parentGroupId: string | null;
        groupNumber: string | null;
      }>;

      return rows
        .filter((r) => !alreadyReturnedSns.has(r.serialNumber.toUpperCase()) && !alreadyReturnedSns.has(r.serialId.toUpperCase()))
        .map((r) => ({
          serialId: r.serialId,
          serialNumber: r.serialNumber,
          productId: r.productId,
          productName: r.productName,
          sku: r.sku,
          status: r.status,
          isGroup: r.isGroup === 1,
          parentGroupId: r.parentGroupId,
          groupNumber: r.groupNumber,
        }));
    }
  }
}


"use server";

/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Inventory Server Actions (TASK-013 & TASK-014)
 * Menjalankan operasi inventaris di server dengan isolasi Owner dan Warehouse.
 */

import { revalidatePath } from "next/cache";
import { getServerSessionContext } from "@/lib/auth/server-session";
import {
  InventoryRepository,
  type CreateProductInput,
  type UpdateProductInput,
  type CreateGoodsInInput,
  type UpdateGoodsInPendingInput,
  type CreateGoodsOutPendingInput,
  type UpdateGoodsOutPendingInput,
  type CreateCommercialDocumentInput,
  type UpdateCommercialDocumentInput,
  type RegisterGoodsInSerialsInput,
  type CreatePurchaseOrderInput,
  type PurchaseOrderRecord,
  type StockOpnameSessionRecord,
  type SubmitStockOpnameForReviewResult,
  type ApproveAndPostStockOpnameAdjustmentInput,
  type ApproveAndPostStockOpnameAdjustmentResult,
  type CreateInventoryReturnInput,
  type RevertInventoryReturnInput,
} from "@/lib/db/repositories/inventory-repository";
import { AppError } from "@/lib/errors/app-error";

export async function createProductAction(input: CreateProductInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const product = repo.createProduct(session.context, input);
    revalidatePath("/inventory/products");
    return { success: true, product };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menambahkan produk.");
    return { success: false, error: message };
  }
}

export async function updateProductAction(input: UpdateProductInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const product = repo.updateProduct(session.context, input);
    revalidatePath("/inventory/products");
    revalidatePath(`/inventory/products/${input.productId}`);
    return { success: true, product };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui metadata produk.");
    return { success: false, error: message };
  }
}

export async function createGoodsInPendingAction(input: CreateGoodsInInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.createGoodsInPendingTransaction(session.context, input);
    revalidatePath("/inventory/goods-in");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    if (result.newSupplier) {
      revalidatePath("/partners/suppliers");
    }
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyimpan draft barang masuk.");
    return { success: false, error: message };
  }
}

export async function updateGoodsInPendingAction(input: UpdateGoodsInPendingInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.updateGoodsInPendingTransaction(session.context, input);
    revalidatePath("/inventory/goods-in");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    if (result.newSupplier) {
      revalidatePath("/partners/suppliers");
    }
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui draft barang masuk.");
    return { success: false, error: message };
  }
}

export async function postPendingGoodsInAction(goodsInId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.postPendingGoodsInTransaction(session.context, goodsInId);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memposting barang masuk.");
    return { success: false, error: message };
  }
}

export async function postGoodsInAction(input: CreateGoodsInInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.postGoodsInTransaction(session.context, input);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal posting barang masuk.");
    return { success: false, error: message };
  }
}

export async function getGoodsInSerialsStatusAction(goodsInId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const data = repo.getGoodsInSerialsStatus(session.context, goodsInId);
    return { success: true as const, data };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengambil status registrasi Serial Number.");
    return { success: false as const, error: message };
  }
}

export async function registerGoodsInSerialsAction(input: RegisterGoodsInSerialsInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.registerGoodsInSerials(session.context, input);
    revalidatePath("/inventory");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/inventory/products");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true as const, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mendaftarkan Serial Number.");
    return { success: false as const, error: message };
  }
}

export async function getAvailableSerialsByProductAction(productId: string, warehouseId?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const serials = repo.getAvailableSerialsByProduct(session.context, productId, warehouseId);
    return { success: true as const, serials };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengambil nomor seri tersedia.");
    return { success: false as const, error: message };
  }
}

export async function getAvailableSerialsByWarehouseAction(warehouseId?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const serials = repo.getAvailableSerialsByWarehouse(session.context, warehouseId);
    return { success: true as const, serials };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengambil nomor seri tersedia di gudang.");
    return { success: false as const, error: message };
  }
}

export async function verifySerialForGoodsOutAction(serialNumber: string, warehouseId?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const serialItem = repo.verifySerialForGoodsOut(session.context, serialNumber, warehouseId);
    return { success: true as const, serialItem };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memverifikasi nomor seri.");
    return { success: false as const, error: message };
  }
}

export async function createGoodsOutPendingAction(input: CreateGoodsOutPendingInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.createGoodsOutPendingTransaction(session.context, input);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    if (result.newCustomer) {
      revalidatePath("/partners/customers");
    }
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat reservasi barang keluar.");
    return { success: false, error: message };
  }
}

export async function updateGoodsOutPendingAction(input: UpdateGoodsOutPendingInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.updateGoodsOutPendingTransaction(session.context, input);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    if (result.newCustomer) {
      revalidatePath("/partners/customers");
    }
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui reservasi barang keluar.");
    return { success: false, error: message };
  }
}

export async function completeGoodsOutAction(goodsOutId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.completeGoodsOutTransaction(session.context, goodsOutId);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyelesaikan pengeluaran barang.");
    return { success: false, error: message };
  }
}

export async function softDeleteGoodsOutAction(goodsOutId: string, reason: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.softDeleteGoodsOutTransaction(session.context, goodsOutId, reason);
    revalidatePath("/inventory");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membatalkan barang keluar.");
    return { success: false, error: message };
  }
}

export async function createCustomerAction(input: {
  code: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const customer = repo.createCustomer(session.context, input);
    revalidatePath("/partners/customers");
    revalidatePath("/audit-log");
    return { success: true, customer };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menambahkan pelanggan.");
    return { success: false, error: message };
  }
}

export async function updateCustomerAction(
  customerId: string,
  input: {
    name?: string;
    ownerName?: string;
    picSales?: string;
    phone?: string;
    email?: string;
    address?: string;
  }
) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const updated = repo.updateCustomer(session.context, customerId, input);
    revalidatePath("/partners/customers");
    revalidatePath("/documents");
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true, customer: updated };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui data pelanggan.");
    return { success: false, error: message };
  }
}

export async function createSupplierAction(input: {
  code: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const supplier = repo.createSupplier(session.context, input);
    revalidatePath("/partners/suppliers");
    revalidatePath("/audit-log");
    return { success: true, supplier };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menambahkan pemasok.");
    return { success: false, error: message };
  }
}

export async function createStockOpnameSessionAction(input: {
  warehouseId: string;
  sessionNumber: string;
  title?: string;
  scope?: "ALL" | "CATEGORY" | "LOCATION";
  scopeConfig?: Record<string, unknown> | string;
  initialAreas?: string[];
  note?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const opnameSession = repo.createStockOpnameSession(session.context, input);
    revalidatePath("/inventory/stock-opname");
    revalidatePath("/audit-log");
    return { success: true, session: opnameSession };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat sesi Stock Opname.");
    return { success: false, error: message };
  }
}

export async function getStockOpnameSessionDetailAction(sessionId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const detail = repo.getStockOpnameSessionDetail(session.context, sessionId);
    return { success: true, detail };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat detail sesi Stock Opname.");
    return { success: false, error: message };
  }
}

export async function cancelStockOpnameSessionAction(sessionId: string, reason?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.cancelStockOpnameSession(session.context, sessionId, reason);
    revalidatePath("/inventory/stock-opname");
    revalidatePath(`/inventory/stock-opname/${sessionId}`);
    revalidatePath("/audit-log");
    return { ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membatalkan sesi Stock Opname.");
    return { success: false, error: message };
  }
}

export async function createStockOpnameAreaAction(input: {
  sessionId: string;
  name: string;
  locationCode?: string;
  assignedUserId?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const area = repo.createStockOpnameArea(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/audit-log");
    return { success: true, area };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat area penghitungan.");
    return { success: false, error: message };
  }
}

export async function updateStockOpnameAreaAction(input: {
  sessionId: string;
  areaId: string;
  name?: string;
  locationCode?: string;
  assignedUserId?: string;
  status?: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const area = repo.updateStockOpnameArea(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/audit-log");
    return { success: true, area };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui area penghitungan.");
    return { success: false, error: message };
  }
}

export async function deleteStockOpnameAreaAction(input: {
  sessionId: string;
  areaId: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.deleteStockOpnameArea(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/audit-log");
    return { ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menghapus area penghitungan.");
    return { success: false, error: message };
  }
}

export async function getStockOpnameAreasAction(sessionId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const areas = repo.getStockOpnameAreas(session.context, sessionId);
    return { success: true, areas };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat daftar area.");
    return { success: false, error: message };
  }
}

export async function saveStockOpnameAreaCountAction(input: {
  sessionId: string;
  areaId: string;
  productId: string;
  quantity: number;
  unit?: string;
  notes?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.saveStockOpnameAreaCount(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/inventory/stock-opname");
    revalidatePath("/audit-log");
    return { ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyimpan hitungan fisik.");
    return { success: false, error: message };
  }
}

export async function getStockOpnameAreaCountsAction(sessionId: string, areaId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const counts = repo.getStockOpnameAreaCounts(session.context, sessionId, areaId);
    return { success: true, counts };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat data hitungan area.");
    return { success: false, error: message };
  }
}

export async function getStockOpnameSerialSnapshotsAction(sessionId: string, productId?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const serials = repo.getStockOpnameSerialSnapshots(session.context, sessionId, productId);
    return { success: true, serials };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat rincian serial number.");
    return { success: false, error: message };
  }
}

export async function scanStockOpnameSerialAction(input: {
  sessionId: string;
  areaId: string;
  serialNumber: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return {
      success: false,
      resultType: "UNREGISTERED_SERIAL" as const,
      message: "Akses tidak diizinkan. Silakan login terlebih dahulu.",
      serialNumber: input.serialNumber,
      areaId: input.areaId,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.scanStockOpnameSerial(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/inventory/stock-opname");
    revalidatePath("/audit-log");
    return result;
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memproses pemindaian.");
    return {
      success: false,
      resultType: "UNREGISTERED_SERIAL" as const,
      message,
      serialNumber: input.serialNumber,
      areaId: input.areaId,
      timestamp: new Date().toISOString(),
    };
  }
}

export async function getStockOpnameScanErrorsAction(sessionId: string, areaId?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const errors = repo.getStockOpnameScanErrors(session.context, sessionId, areaId);
    return { success: true, errors };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat riwayat error scan.");
    return { success: false, error: message };
  }
}

export async function archiveStockOpnameScanErrorsAction(sessionId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.archiveStockOpnameScanErrors(session.context, sessionId);
    revalidatePath(`/inventory/stock-opname/${sessionId}`);
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengarsipkan riwayat error scan.");
    return { success: false, error: message };
  }
}

export async function evaluateStockOpnameReconciliationAction(sessionId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const summary = repo.evaluateStockOpnameReconciliation(session.context, sessionId);
    revalidatePath(`/inventory/stock-opname/${sessionId}`);
    revalidatePath("/inventory/stock-opname");
    return { success: true, summary };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengevaluasi rekonsiliasi Stock Opname.");
    return { success: false, error: message };
  }
}

export async function saveStockOpnameInvestigationAction(input: {
  sessionId: string;
  productId: string;
  reason: string;
  notes?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.saveStockOpnameInvestigation(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/audit-log");
    return result;
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyimpan catatan investigasi.");
    return { success: false, error: message };
  }
}

export async function submitStockOpnameForReviewAction(
  sessionId: string
): Promise<SubmitStockOpnameForReviewResult | { success: false; error: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.submitStockOpnameForReview(session.context, sessionId);
    revalidatePath(`/inventory/stock-opname/${sessionId}`);
    revalidatePath("/inventory/stock-opname");
    revalidatePath("/audit-log");
    return result;
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mengajukan sesi ke review.");
    return { success: false as const, error: message };
  }
}

export async function approveAndPostStockOpnameAdjustmentAction(
  input: ApproveAndPostStockOpnameAdjustmentInput
): Promise<ApproveAndPostStockOpnameAdjustmentResult | { success: false; error: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.approveAndPostStockOpnameAdjustment(session.context, input);
    revalidatePath(`/inventory/stock-opname/${input.sessionId}`);
    revalidatePath("/inventory/stock-opname");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/reports");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return result;
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyetujui dan memposting penyesuaian Stock Opname.");
    return { success: false as const, error: message };
  }
}

export async function createPurchaseOrderAction(
  input: CreatePurchaseOrderInput
): Promise<{ success: true; po: PurchaseOrderRecord } | { success: false; error: string; po?: undefined }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const po = repo.createPurchaseOrder(session.context, input);
    revalidatePath("/purchase-orders");
    if (input.newCustomerName) {
      revalidatePath("/partners/customers");
    }
    revalidatePath("/audit-log");
    return { success: true, po };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat Purchase Order.");
    return { success: false, error: message };
  }
}

export async function approvePurchaseOrderAction(
  poId: string
): Promise<{ success: true; po: PurchaseOrderRecord } | { success: false; error: string; po?: undefined }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const po = repo.approvePurchaseOrder(session.context, poId);
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true, po };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyetujui Purchase Order.");
    return { success: false, error: message };
  }
}

export async function rejectPurchaseOrderAction(
  poId: string,
  reason?: string
): Promise<{ success: true; po: PurchaseOrderRecord } | { success: false; error: string; po?: undefined }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const po = repo.rejectPurchaseOrder(session.context, poId, reason);
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true, po };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menolak Purchase Order.");
    return { success: false, error: message };
  }
}

export async function updatePurchaseOrderSalesPicAction(poId: string, salesPic: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    repo.updatePurchaseOrderSalesPic(session.context, poId, salesPic);
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memperbarui PIC Sales PO.");
    return { success: false, error: message };
  }
}

export async function mapPurchaseOrderLineAction(input: {
  poId: string;
  lineId: string;
  productId: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    repo.mapPurchaseOrderLineToProduct(session.context, input);
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memetakan baris PO ke produk.");
    return { success: false, error: message };
  }
}

export async function createAndMapProductForPoLineAction(input: {
  poId: string;
  lineId: string;
  name: string;
  sku: string;
  category?: string;
  trackingMode?: "SERIAL" | "NON_SERIAL";
  unit?: string;
}): Promise<
  | { success: true; productId: string; sku: string; name: string }
  | { success: false; error: string; productId?: undefined; sku?: undefined; name?: undefined }
> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.createAndMapProductForPoLine(session.context, input);
    revalidatePath("/purchase-orders");
    revalidatePath("/inventory/products");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat produk katalog baru untuk PO.");
    return { success: false, error: message };
  }
}

export async function recordPoFulfillmentAction(input: {
  poId: string;
  lines: Array<{ productId: string; quantity: number }>;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    repo.recordPoFulfillment(session.context, input.poId, input.lines);
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mencatat pemenuhan PO.");
    return { success: false, error: message };
  }
}

export async function createCommercialDocumentAction(input: CreateCommercialDocumentInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const doc = repo.createCommercialDocument(session.context, input);
    revalidatePath("/documents");
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    if (input.newCustomer) {
      revalidatePath("/partners/customers");
    }
    return { success: true, document: doc };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat invoice.");
    return { success: false, error: message };
  }
}

export async function recordDocumentPaymentAction(input: {
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
}): Promise<
  | { success: true; paymentId: string; newStatus: string; paidAmount: number }
  | { success: false; error: string }
> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.recordDocumentPayment(session.context, input);
    revalidatePath("/documents");
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mencatat pembayaran.");
    return { success: false, error: message };
  }
}

export async function deleteDocumentPaymentAction(paymentId: string): Promise<
  | { success: true; paymentId: string; documentId: string; newStatus: string; paidAmount: number; deletedAmount: number }
  | { success: false; error: string }
> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.deleteDocumentPayment(session.context, paymentId);
    revalidatePath("/documents");
    revalidatePath(`/documents/${result.documentId}`);
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menghapus pembayaran.");
    return { success: false, error: message };
  }
}

export async function recordDocumentPrintAction(documentId: string): Promise<
  | { success: true; documentId: string; printCount: number }
  | { success: false; error: string }
> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.recordDocumentPrint(session.context, documentId);
    revalidatePath("/documents");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal mencatat pencetakan dokumen.");
    return { success: false, error: message };
  }
}

export async function getDocumentPaymentsAction(documentId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan." };
  }

  try {
    const repo = new InventoryRepository();
    const payments = repo.getDocumentPayments(session.context, documentId);
    return { success: true, payments };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat riwayat pembayaran.");
    return { success: false, error: message };
  }
}

export async function createInventoryReturnAction(input: CreateInventoryReturnInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const returnRecord = repo.createInventoryReturn(session.context, input);
    revalidatePath("/inventory/returns");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/reports");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/audit-log");
    return { success: true, returnRecord };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membuat transaksi retur.");
    return { success: false, error: message };
  }
}

export async function approveAndReceiveReturnAction(returnId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.approveAndReceiveInventoryReturn(session.context, returnId);
    revalidatePath("/inventory/returns");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/reports");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/inventory/grouping");
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memproses penerimaan fisik retur.");
    return { success: false, error: message };
  }
}

export async function cancelDraftReturnAction(returnId: string, reason?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.cancelDraftInventoryReturn(session.context, returnId, reason);
    revalidatePath("/inventory/returns");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membatalkan draft retur.");
    return { success: false, error: message };
  }
}

export const cancelInventoryReturnAction = cancelDraftReturnAction;

export async function revertReceivedReturnAction(input: RevertInventoryReturnInput | { returnId: string; reason?: string }) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.revertReceivedInventoryReturn(session.context, input);
    revalidatePath("/inventory/returns");
    revalidatePath("/inventory/products");
    revalidatePath("/inventory/reports");
    revalidatePath("/inventory/goods-out");
    revalidatePath("/inventory/goods-in");
    revalidatePath("/purchase-orders");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membatalkan transaksi retur (revert).");
    return { success: false, error: message };
  }
}

export async function revertInventoryReturnAction(returnId: string, reason: string) {
  return revertReceivedReturnAction({ returnId, reason });
}

export async function getReturnableSerialsAction(params: {
  goodsOutId?: string;
  goodsInId?: string;
  productId?: string;
}) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const serials = repo.getReturnableSerials(session.context, params);
    return { success: true, serials };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat serial yang dapat diretur.");
    return { success: false, error: message };
  }
}

export async function getCommercialDocumentDetailAction(documentId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const document = repo.getCommercialDocumentById(session.context, documentId);
    if (!document) {
      return { success: false, error: "Dokumen tidak ditemukan atau akses ditolak." };
    }
    return { success: true, document };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal memuat rincian dokumen.");
    return { success: false, error: message };
  }
}

export async function updateCommercialDocumentAction(input: UpdateCommercialDocumentInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false as const, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const document = repo.updateCommercialDocument(session.context, input);
    revalidatePath("/documents");
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true as const, document };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal menyimpan perubahan dokumen.");
    return { success: false as const, error: message };
  }
}

export async function cancelCommercialDocumentAction(input: {
  documentId: string;
  reason: string;
}): Promise<
  | { success: true; documentId: string; documentNumber: string; status: "CANCELLED" }
  | { success: false; error: string }
> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.cancelCommercialDocument(session.context, input);
    revalidatePath("/documents");
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath("/dashboard");
    revalidatePath("/audit-log");
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : (err instanceof Error ? err.message : "Gagal membatalkan dokumen.");
    return { success: false, error: message };
  }
}

export async function updateWarehouseConversionDisplayUnitAction(input: {
  warehouseId: string;
  unit: "pcs" | "lusin";
}): Promise<{ success: boolean; unit?: "pcs" | "lusin"; error?: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    repo.updateWarehouseConversionDisplayUnit(session.context, input.warehouseId, input.unit);
    revalidatePath("/inventory/goods-in");
    return { success: true, unit: input.unit };
  } catch (err: unknown) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Gagal memperbarui preferensi satuan gudang.";
    return { success: false, error: message };
  }
}

export async function deleteGoodsInAction(
  goodsInId: string
): Promise<{ success: boolean; documentNumber?: string; error?: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.deleteGoodsInTransaction(session.context, goodsInId);
    revalidatePath("/inventory/goods-in");
    revalidatePath("/audit-log");
    return { success: true, documentNumber: result.documentNumber };
  } catch (err: unknown) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Gagal menghapus transaksi barang masuk.";
    return { success: false, error: message };
  }
}

/**
 * Server Action: Ekspor Detail Sesi Stock Opname ke Base64 Excel (Phase 7)
 */
export async function exportStockOpnameSessionExcelAction(
  sessionId: string
): Promise<{ success: true; filename: string; base64: string } | { success: false; error: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const { exportStockOpnameSessionExcel } = await import("@/lib/export/stock-opname-export");
    const result = exportStockOpnameSessionExcel(session.context, sessionId);
    return {
      success: true,
      filename: result.filename,
      base64: result.buffer.toString("base64"),
    };
  } catch (err: unknown) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Gagal mengekspor file Excel.";
    return { success: false, error: message };
  }
}

/**
 * Server Action: Ekspor Daftar Sesi Stock Opname ke Base64 Excel (Phase 7)
 */
export async function exportStockOpnameListExcelAction(
  filters?: { warehouseId?: string; status?: string; search?: string }
): Promise<{ success: true; filename: string; base64: string } | { success: false; error: string }> {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const { exportStockOpnameListExcel } = await import("@/lib/export/stock-opname-export");
    const result = exportStockOpnameListExcel(session.context, filters);
    return {
      success: true,
      filename: result.filename,
      base64: result.buffer.toString("base64"),
    };
  } catch (err: unknown) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
        ? err.message
        : "Gagal mengekspor daftar Stock Opname.";
    return { success: false, error: message };
  }
}

/**
 * -------------------------------------------------------------
 * SERVER ACTIONS UNTUK GROUPING SERIAL NUMBER
 * -------------------------------------------------------------
 */

export async function createSerialGroupsBatchAction(input: import("@/lib/types/inventory-domain").CreateSerialGroupsBatchInput) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.createSerialGroupsBatch(session.context, input);
    return { success: true, createdGroups: result.createdGroups };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : "Gagal membuat grouping serial.";
    const code = err instanceof AppError ? err.code : undefined;
    const details = err instanceof AppError ? err.details : undefined;
    return { success: false, error: message, code, details };
  }
}

export async function dissolveGroupingAction(groupingId: string, notes?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.dissolveGrouping(session.context, groupingId, notes);
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : "Gagal membongkar grouping serial.";
    const code = err instanceof AppError ? err.code : undefined;
    return { success: false, error: message, code };
  }
}

export async function getSerialGroupingsAction(warehouseId?: string, statusFilter?: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const groupings = repo.getSerialGroupings(session.context, warehouseId, statusFilter);
    return { success: true, groupings };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : "Gagal mengambil data grouping.";
    return { success: false, error: message };
  }
}

export async function getSerialGroupDetailAction(groupingId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const detail = repo.getSerialGroupDetail(session.context, groupingId);
    return { success: true, detail };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : "Gagal mengambil detail grouping.";
    return { success: false, error: message };
  }
}

export async function resolveGroupForGoodsOutAction(groupNumber: string, warehouseId: string) {
  const session = await getServerSessionContext();
  if (!session) {
    return { success: false, error: "Akses tidak diizinkan. Silakan login terlebih dahulu." };
  }

  try {
    const repo = new InventoryRepository();
    const result = repo.resolveGroupForGoodsOut(session.context, groupNumber, warehouseId);
    return { success: true, ...result };
  } catch (err: unknown) {
    const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : "Gagal memindai group serial.";
    const code = err instanceof AppError ? err.code : undefined;
    return { success: false, error: message, code };
  }
}



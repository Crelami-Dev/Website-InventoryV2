/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Stock Opname Excel Export Service (TASK-SO-07 & Phase 7)
 *
 * Menyediakan layanan ekspor file workbook Excel (.xlsx) formal:
 * 1. Ekspor Rinci Sesi Stock Opname (5 Worksheet: Ringkasan Sesi, Rekonsiliasi Stok,
 *    Rincian per Area, Audit Serial Number, dan Catatan Investigasi).
 * 2. Ekspor Daftar Sesi Stock Opname (Sesuai filter aktif).
 *
 * Seluruh pembacaan data mematuhi batas isolasi Owner dan Gudang di sisi server.
 * Bersifat Read-Only mutlak: tidak mengubah saldo stok, ledger, status serial, atau status sesi.
 */

import { InventoryRepository } from "../db/repositories/inventory-repository.ts";
import { getDatabaseClient, type DatabaseClient } from "../db/sqlite-client.ts";
import { generateExcelWorkbook, type ExcelWorksheet } from "./excel-builder.ts";
import type { ActiveSecurityContext } from "../types/auth.ts";
import { AppError } from "../errors/app-error.ts";

export interface ExportStockOpnameResult {
  filename: string;
  buffer: Buffer;
  contentType: string;
}

export interface StockOpnameListFilters {
  warehouseId?: string;
  status?: string;
  search?: string;
}

/**
 * Format tanggal kanonis YYYY-MM-DD
 */
function formatDateStamp(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Sanitasi string untuk nama file aman
 */
function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 1. Ekspor Workbook Detail Sesi Stock Opname (5 Worksheet Lengkap)
 */
export function exportStockOpnameSessionExcel(
  context: ActiveSecurityContext,
  sessionId: string,
  customDb?: DatabaseClient
): ExportStockOpnameResult {
  const db = customDb ?? getDatabaseClient();
  const repo = new InventoryRepository(db);

  // 1. Ambil detail rekonsiliasi resmi (memvalidasi kepemilikan Owner & Gudang di server)
  const reconSummary = repo.evaluateStockOpnameReconciliation(context, sessionId);
  const detail = repo.getStockOpnameSessionDetail(context, sessionId);
  const session = detail.session;

  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);

  // =========================================================================
  // WORKSHEET 1: RINGKASAN SESI (Metadata & Statistik Akurasi Stok)
  // =========================================================================
  const accuracyRate = reconSummary.totalSku > 0 
    ? Number(((reconSummary.matchCount / reconSummary.totalSku) * 100).toFixed(1)) 
    : 100;

  const summarySheet: ExcelWorksheet = {
    name: "Ringkasan Sesi",
    title: `LAPORAN AUDIT STOCK OPNAME — ${session.sessionNumber}`,
    subtitle: `Dicetak oleh: ${context.email} (${context.role}) | Tanggal Cetak: ${nowStr} WIB`,
    freezeHeader: false,
    columns: [
      { header: "Parameter Audit", key: "param", width: 28, align: "left" },
      { header: "Nilai / Informasi", key: "value", width: 45, align: "left" },
      { header: "Metrik Akurasi", key: "metric", width: 26, align: "left" },
      { header: "Capaian", key: "metricValue", width: 20, align: "right" },
    ],
    metadata: [
      { label: "Nomor Sesi", value: session.sessionNumber },
      { label: "Total SKU Terdaftar", value: `${reconSummary.totalSku} SKU` },
      { label: "Judul Sesi", value: session.title || "-" },
      { label: "SKU Sesuai (Match)", value: `${reconSummary.matchCount} SKU` },
      { label: "Gudang Operasional", value: `${session.warehouseName || session.warehouseId}` },
      { label: "SKU Surplus (Lebih)", value: `${reconSummary.surplusCount} SKU` },
      { label: "Status Sesi", value: session.status },
      { label: "SKU Kurang (Shortage)", value: `${reconSummary.shortageCount} SKU` },
      { label: "Waktu Mulai", value: session.startedAt?.replace("T", " ").slice(0, 19) || "-" },
      { label: "Perlu Investigasi", value: `${reconSummary.investigationCount} SKU` },
      { label: "Waktu Snapshot Beku", value: session.snapshotAt?.replace("T", " ").slice(0, 19) || "-" },
      { label: "Total Net Selisih", value: `${reconSummary.netDiscrepancyQty > 0 ? `+${reconSummary.netDiscrepancyQty}` : reconSummary.netDiscrepancyQty} PCS` },
      { label: "Waktu Review", value: session.reviewedAt?.replace("T", " ").slice(0, 19) || "-" },
      { label: "Tingkat Akurasi Stok", value: `${accuracyRate}%` },
      { label: "Waktu Penyesuaian", value: session.adjustedAt?.replace("T", " ").slice(0, 19) || "-" },
      { label: "PIC Pembuat", value: session.createdBy || "-" },
      { label: "Catatan Sesi", value: session.note || "-" },
    ],
    rows: [],
  };

  // =========================================================================
  // WORKSHEET 2: REKONSILIASI STOK (Tabel Komparasi Lengkap)
  // =========================================================================
  const reconColumns = [
    { header: "No", key: "no", width: 6, align: "center" as const },
    { header: "SKU", key: "sku", width: 16, align: "left" as const },
    { header: "Nama Produk", key: "name", width: 34, align: "left" as const },
    { header: "Tracking", key: "tracking", width: 12, align: "center" as const },
    { header: "Satuan", key: "unit", width: 10, align: "center" as const },
    { header: "Stok Snapshot", key: "snapshot", width: 14, align: "right" as const, format: "number" as const },
    { header: "Masuk (+In)", key: "deltaIn", width: 13, align: "right" as const, format: "number" as const },
    { header: "Keluar (-Out)", key: "deltaOut", width: 13, align: "right" as const, format: "number" as const },
    { header: "Delta Bersih", key: "netDelta", width: 13, align: "right" as const, format: "number" as const },
    { header: "Acuan Dinamis", key: "book", width: 15, align: "right" as const, format: "number" as const },
    { header: "Fisik Terhitung", key: "counted", width: 15, align: "right" as const, format: "number" as const },
    { header: "Selisih (Variance)", key: "variance", width: 16, align: "right" as const, format: "number" as const },
    { header: "Status Rekonsiliasi", key: "status", width: 22, align: "center" as const, format: "badge" as const },
    { header: "Rekomendasi", key: "recommendation", width: 22, align: "center" as const },
    { header: "Alasan Selisih", key: "reason", width: 26, align: "left" as const },
  ];

  const reconRows = reconSummary.items.map((item, idx) => ({
    no: idx + 1,
    sku: item.sku,
    name: item.productName,
    tracking: item.trackingMode,
    unit: item.unit || "PCS",
    snapshot: item.snapshotQty,
    deltaIn: item.deltaIn,
    deltaOut: item.deltaOut,
    netDelta: item.netDelta,
    book: item.dynamicBookQty,
    counted: item.countedQty,
    variance: item.varianceQty,
    status: item.reconciliationStatus,
    recommendation: item.recommendation,
    reason: item.discrepancyReason || "-",
  }));

  const reconciliationSheet: ExcelWorksheet = {
    name: "Rekonsiliasi Stok",
    title: `REKONSILIASI STOK — ${session.sessionNumber}`,
    columns: reconColumns,
    rows: reconRows,
  };

  // =========================================================================
  // WORKSHEET 3: RINCIAN PER AREA (Breakdown Hitungan Fisik per Lokasi)
  // =========================================================================
  const areaCounts = db.prepare(`
    SELECT soa.name as area_name, soa.location_code, soa.status as area_status,
           p.sku, p.name as product_name, ac.counted_qty_base, ac.unit, ac.notes
    FROM stock_opname_area_counts ac
    JOIN stock_opname_areas soa ON soa.id = ac.area_id
    JOIN products p ON p.id = ac.product_id
    WHERE ac.session_id = ? AND ac.owner_id = ?
    ORDER BY soa.name ASC, p.name ASC
  `).all(sessionId, context.ownerId) as Array<{
    area_name: string;
    location_code: string | null;
    area_status: string;
    sku: string;
    product_name: string;
    counted_qty_base: number;
    unit: string;
    notes: string | null;
  }>;

  const areaColumns = [
    { header: "No", key: "no", width: 6, align: "center" as const },
    { header: "Nama Area", key: "areaName", width: 20, align: "left" as const },
    { header: "Kode Lokasi", key: "locationCode", width: 16, align: "center" as const },
    { header: "Status Area", key: "areaStatus", width: 14, align: "center" as const },
    { header: "SKU", key: "sku", width: 16, align: "left" as const },
    { header: "Nama Produk", key: "productName", width: 34, align: "left" as const },
    { header: "Fisik Terhitung (Base)", key: "countedBase", width: 20, align: "right" as const, format: "number" as const },
    { header: "Satuan", key: "unit", width: 10, align: "center" as const },
    { header: "Catatan Area", key: "notes", width: 24, align: "left" as const },
  ];

  const areaRows = areaCounts.map((ac, idx) => ({
    no: idx + 1,
    areaName: ac.area_name,
    locationCode: ac.location_code || "-",
    areaStatus: ac.area_status,
    sku: ac.sku,
    productName: ac.product_name,
    countedBase: ac.counted_qty_base,
    unit: ac.unit || "PCS",
    notes: ac.notes || "-",
  }));

  const areaSheet: ExcelWorksheet = {
    name: "Rincian per Area",
    title: `RINCIAN HITUNGAN FISIK PER AREA — ${session.sessionNumber}`,
    columns: areaColumns,
    rows: areaRows,
  };

  // =========================================================================
  // WORKSHEET 4: AUDIT SERIAL NUMBER (Drill-down Status Nomor Seri)
  // =========================================================================
  const serialAuditRows: Array<{
    no: number;
    sku: string;
    productName: string;
    serialNumber: string;
    snapshotStatus: string;
    classification: string;
    scannedPhysical: string;
    systemAction: string;
  }> = [];

  let snCounter = 1;
  for (const item of reconSummary.items) {
    if (item.trackingMode === "SERIAL" && item.serialDetail) {
      // 1. Matched Serials
      for (const ms of item.serialDetail.matchedSerials) {
        serialAuditRows.push({
          no: snCounter++,
          sku: item.sku,
          productName: item.productName,
          serialNumber: ms.serialNumber,
          snapshotStatus: "AVAILABLE",
          classification: "SESUAI (MATCHED)",
          scannedPhysical: "YA",
          systemAction: "TETAP_AVAILABLE",
        });
      }

      // 2. Missing Serials
      for (const ms of item.serialDetail.missingSerials) {
        serialAuditRows.push({
          no: snCounter++,
          sku: item.sku,
          productName: item.productName,
          serialNumber: ms.serialNumber,
          snapshotStatus: "AVAILABLE",
          classification: ms.dispatchedPostSnapshot ? "KELUAR_PASCA_SNAPSHOT" : "HILANG (MISSING)",
          scannedPhysical: "TIDAK",
          systemAction: ms.dispatchedPostSnapshot ? "SUDAH_KELUAR" : "DECOMMISSIONED",
        });
      }

      // 3. Surplus Serials
      for (const ss of item.serialDetail.surplusSerials) {
        serialAuditRows.push({
          no: snCounter++,
          sku: item.sku,
          productName: item.productName,
          serialNumber: ss.serialNumber,
          snapshotStatus: "TIDAK_DI_SNAPSHOT",
          classification: ss.receivedPostSnapshot ? "MASUK_PASCA_SNAPSHOT" : "SURPLUS_FISIK",
          scannedPhysical: "YA",
          systemAction: ss.receivedPostSnapshot ? "SUDAH_MASUK" : "PENYESUAIAN_SURPLUS",
        });
      }
    }
  }

  const serialColumns = [
    { header: "No", key: "no", width: 6, align: "center" as const },
    { header: "SKU", key: "sku", width: 16, align: "left" as const },
    { header: "Nama Produk", key: "productName", width: 32, align: "left" as const },
    { header: "Nomor Seri (SN)", key: "serialNumber", width: 24, align: "left" as const },
    { header: "Status Snapshot", key: "snapshotStatus", width: 18, align: "center" as const },
    { header: "Klasifikasi Audit", key: "classification", width: 26, align: "center" as const, format: "badge" as const },
    { header: "Fisik Ditemukan", key: "scannedPhysical", width: 16, align: "center" as const },
    { header: "Tindakan Sistem", key: "systemAction", width: 24, align: "center" as const },
  ];

  const serialSheet: ExcelWorksheet = {
    name: "Audit Serial Number",
    title: `AUDIT RINCIAN SERIAL NUMBER — ${session.sessionNumber}`,
    columns: serialColumns,
    rows: serialAuditRows,
  };

  // =========================================================================
  // WORKSHEET 5: CATATAN INVESTIGASI (Selisih, Alasan, & Audit Notes)
  // =========================================================================
  const discrepancyItems = reconSummary.items.filter(
    (it) => it.varianceQty !== 0 || it.discrepancyReason || it.investigationNotes
  );

  const investigationColumns = [
    { header: "No", key: "no", width: 6, align: "center" as const },
    { header: "SKU", key: "sku", width: 16, align: "left" as const },
    { header: "Nama Produk", key: "productName", width: 34, align: "left" as const },
    { header: "Tracking", key: "tracking", width: 12, align: "center" as const },
    { header: "Selisih Qty", key: "variance", width: 14, align: "right" as const, format: "number" as const },
    { header: "Satuan", key: "unit", width: 10, align: "center" as const },
    { header: "Status Rekonsiliasi", key: "status", width: 22, align: "center" as const, format: "badge" as const },
    { header: "Rekomendasi", key: "recommendation", width: 24, align: "center" as const },
    { header: "Alasan Selisih Resmi", key: "reason", width: 32, align: "left" as const },
    { header: "Catatan Investigasi Lapangan", key: "notes", width: 36, align: "left" as const },
  ];

  const investigationRows = discrepancyItems.map((item, idx) => ({
    no: idx + 1,
    sku: item.sku,
    name: item.productName,
    productName: item.productName,
    tracking: item.trackingMode,
    variance: item.varianceQty,
    unit: item.unit || "PCS",
    status: item.reconciliationStatus,
    recommendation: item.recommendation,
    reason: item.discrepancyReason || "-",
    notes: item.investigationNotes || "-",
  }));

  const investigationSheet: ExcelWorksheet = {
    name: "Catatan Investigasi",
    title: `CATATAN INVESTIGASI SELISIH — ${session.sessionNumber}`,
    columns: investigationColumns,
    rows: investigationRows,
  };

  // 2. Bentuk Workbook 5-Sheet
  const buffer = generateExcelWorkbook({
    creator: "DocuFlow Inventory V2.4.1",
    company: context.ownerName || "DocuFlow Multi-Owner",
    sheets: [
      summarySheet,
      reconciliationSheet,
      areaSheet,
      serialSheet,
      investigationSheet,
    ],
  });

  const safeSessionNumber = sanitizeFilename(session.sessionNumber);
  const dateStr = formatDateStamp();
  const filename = `Stock_Opname_${safeSessionNumber}_${dateStr}.xlsx`;

  return {
    filename,
    buffer,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

/**
 * 2. Ekspor Daftar Sesi Stock Opname Berdasarkan Filter
 */
export function exportStockOpnameListExcel(
  context: ActiveSecurityContext,
  filters?: StockOpnameListFilters,
  customDb?: DatabaseClient
): ExportStockOpnameResult {
  const db = customDb ?? getDatabaseClient();
  const repo = new InventoryRepository(db);

  // Ambil daftar sesi sesuai filter gudang dan isolasi owner
  let sessions = repo.getStockOpnameSessions(context, filters?.warehouseId);

  // Terapkan filter status jika tersedia
  if (filters?.status && filters.status.trim()) {
    const st = filters.status.trim().toUpperCase();
    sessions = sessions.filter((s) => s.status.toUpperCase() === st);
  }

  // Terapkan filter pencarian teks jika tersedia
  if (filters?.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    sessions = sessions.filter(
      (s) =>
        s.sessionNumber.toLowerCase().includes(q) ||
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.warehouseName && s.warehouseName.toLowerCase().includes(q)) ||
        (s.note && s.note.toLowerCase().includes(q))
    );
  }

  const listColumns = [
    { header: "No", key: "no", width: 6, align: "center" as const },
    { header: "Nomor Sesi", key: "sessionNumber", width: 22, align: "left" as const },
    { header: "Judul Sesi", key: "title", width: 30, align: "left" as const },
    { header: "Gudang", key: "warehouseName", width: 24, align: "left" as const },
    { header: "Cakupan (Scope)", key: "scope", width: 16, align: "center" as const },
    { header: "Status", key: "status", width: 18, align: "center" as const, format: "badge" as const },
    { header: "Waktu Mulai", key: "startedAt", width: 20, align: "center" as const },
    { header: "Waktu Snapshot", key: "snapshotAt", width: 20, align: "center" as const },
    { header: "Waktu Penyesuaian", key: "adjustedAt", width: 20, align: "center" as const },
    { header: "Dibuat Oleh", key: "createdBy", width: 26, align: "left" as const },
    { header: "Total Item", key: "itemCount", width: 14, align: "right" as const, format: "number" as const },
    { header: "Item Selisih", key: "varianceCount", width: 14, align: "right" as const, format: "number" as const },
    { header: "Catatan Sesi", key: "note", width: 32, align: "left" as const },
  ];

  const listRows = sessions.map((s, idx) => ({
    no: idx + 1,
    sessionNumber: s.sessionNumber,
    title: s.title || "-",
    warehouseName: s.warehouseName || s.warehouseId,
    scope: s.scope || "ALL",
    status: s.status,
    startedAt: s.startedAt ? s.startedAt.replace("T", " ").slice(0, 19) : "-",
    snapshotAt: s.snapshotAt ? s.snapshotAt.replace("T", " ").slice(0, 19) : "-",
    adjustedAt: s.adjustedAt ? s.adjustedAt.replace("T", " ").slice(0, 19) : "-",
    createdBy: s.createdBy || "-",
    itemCount: s.itemCount,
    varianceCount: s.varianceCount,
    note: s.note || "-",
  }));

  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  const listSheet: ExcelWorksheet = {
    name: "Daftar Sesi Stock Opname",
    title: `DAFTAR SESI STOCK OPNAME — ${context.ownerName || "DocuFlow"}`,
    subtitle: `Filter: Gudang = ${filters?.warehouseId || "Semua"} | Status = ${filters?.status || "Semua"} | Dicetak: ${nowStr} WIB`,
    columns: listColumns,
    rows: listRows,
  };

  const buffer = generateExcelWorkbook({
    creator: "DocuFlow Inventory V2.4.1",
    company: context.ownerName || "DocuFlow Multi-Owner",
    sheets: [listSheet],
  });

  const whPart = filters?.warehouseId ? sanitizeFilename(filters.warehouseId) : "Semua_Gudang";
  const dateStr = formatDateStamp();
  const filename = `Daftar_Stock_Opname_${whPart}_${dateStr}.xlsx`;

  return {
    filename,
    buffer,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

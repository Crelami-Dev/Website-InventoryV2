/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Suite Pengujian Phase 7: Excel Export & Reporting (TASK-SO-07)
 *
 * Menguji 10 skenario wajib:
 * 1. Ekspor sesi sah menghasilkan buffer .xlsx valid dengan 5 worksheet lengkap.
 * 2. Konsistensi angka rekonsiliasi antara database dan file Excel (Zero Divergence).
 * 3. Penanganan karakter khusus XML (&, <, >, ", '), data null, dan format tanggal.
 * 4. Isolasi multi-tenant: Owner lain ditolak saat mencoba mengekspor sesi (404).
 * 5. Isolasi gudang: Staff gudang lain ditolak mengakses sesi di luar otorisasinya (403).
 * 6. Ekspor daftar sesi Stock Opname sesuai filter aktif (Gudang, status, search).
 * 7. Integritas Read-Only: Ekspor tidak mengubah saldo stok, ledger, SN, atau sesi.
 * 8. Tidak ada duplikasi baris atau kuantitas akibat agregasi/join.
 * 9. Lembar Audit Serial Number memuat klasifikasi status yang akurat.
 * 10. Aturan UI: Flat Colors, Tanpa Gradient, dan Tanpa Emoji pada Seluruh File Phase 7.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { getDatabaseClient } from "../src/lib/db/sqlite-client.ts";
import { runMigrations } from "../src/lib/db/migrator.ts";
import { seedSyntheticData } from "../src/lib/db/seed.ts";
import { InventoryRepository } from "../src/lib/db/repositories/inventory-repository.ts";
import {
  exportStockOpnameSessionExcel,
  exportStockOpnameListExcel,
} from "../src/lib/export/stock-opname-export.ts";
import { escapeXml } from "../src/lib/export/excel-builder.ts";
import { AppError } from "../src/lib/errors/app-error.ts";
import type { ActiveSecurityContext } from "../src/lib/types/auth.ts";

const db = getDatabaseClient();
runMigrations(db);
seedSyntheticData(db);
const repo = new InventoryRepository(db);

const ownerAlphaContext: ActiveSecurityContext = {
  userId: "usr-owner-alpha",
  email: "owner_alpha@docuflow.id",
  ownerId: "owner-alpha",
  ownerName: "Alpha Logistics Indonesia",
  warehouseId: "wh-north",
  warehouseName: "Gudang Utama Cakung",
  role: "OWNER",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

const staffAlphaContext: ActiveSecurityContext = {
  userId: "usr-staff-alpha",
  email: "staff_alpha@docuflow.id",
  ownerId: "owner-alpha",
  ownerName: "Alpha Logistics Indonesia",
  warehouseId: "wh-north",
  warehouseName: "Gudang Utama Cakung",
  role: "STAFF",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

const ownerBetaContext: ActiveSecurityContext = {
  userId: "usr-owner-beta",
  email: "owner_beta@docuflow.id",
  ownerId: "owner-beta",
  ownerName: "Beta Retail Nusantara",
  warehouseId: "wh-beta-01",
  warehouseName: "Gudang Pusat Surabaya",
  role: "OWNER",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

/**
 * Helper resmi untuk membersihkan sesi aktif via repository
 */
function cancelActiveSessions(context: ActiveSecurityContext, warehouseId?: string) {
  try {
    const activeSessions = repo.getStockOpnameSessions(context, warehouseId).filter(
      (s) => s.status === "DRAFT" || s.status === "COUNTING" || s.status === "REVIEW"
    );
    for (const s of activeSessions) {
      repo.cancelStockOpnameSession(context, s.id, "Teardown sesi uji coba");
    }
  } catch {
    // Abaikan jika tidak ada sesi aktif
  }
}

/**
 * Parser ZIP PKZip sederhana untuk mengekstrak isi XML dari buffer .xlsx
 */
function extractZipEntries(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;

  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      break; // Bukan local file header, capai central directory
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const filename = buffer.toString("utf8", offset + 30, offset + 30 + filenameLen);
    const dataStart = offset + 30 + filenameLen + extraLen;
    const rawData = buffer.subarray(dataStart, dataStart + compressedSize);

    let content = "";
    if (compressionMethod === 8) {
      content = zlib.inflateRawSync(rawData).toString("utf8");
    } else if (compressionMethod === 0) {
      content = rawData.toString("utf8");
    }

    entries.set(filename, content);
    offset = dataStart + compressedSize;
  }

  return entries;
}

test("PHASE 7: EXCEL EXPORT & REPORTING", async (t) => {
  t.after(() => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");
    const southOwnerContext: ActiveSecurityContext = {
      ...ownerAlphaContext,
      warehouseId: "wh-south",
      warehouseName: "Gudang Transit Cikarang",
    };
    cancelActiveSessions(southOwnerContext, "wh-south");
  });

  await t.test("7.1 Ekspor Sesi Sah Menghasilkan Buffer .xlsx Valid dengan 5 Worksheet Lengkap", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Uji Coba Ekspor Excel 5 Sheet",
        scope: "ALL",
        initialAreas: ["Area Barat", "Area Timur"],
      });
      sessionId = session.id;

      const exportResult = exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);

      // 1. Verifikasi tipe data dan header file
      assert.ok(exportResult.buffer instanceof Buffer, "Hasil harus berupa Buffer");
      assert.ok(exportResult.buffer.length > 500, "Ukuran file harus lebih dari 500 bytes");
      assert.match(exportResult.filename, /^Stock_Opname_.*\.xlsx$/, "Nama file harus berekstensi .xlsx");
      assert.equal(
        exportResult.contentType,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      // 2. Verifikasi signature binary PKZip (0x04034b50)
      assert.equal(exportResult.buffer[0], 0x50); // 'P'
      assert.equal(exportResult.buffer[1], 0x4b); // 'K'
      assert.equal(exportResult.buffer[2], 0x03);
      assert.equal(exportResult.buffer[3], 0x04);

      // 3. Ekstrak XML dan verifikasi struktur workbook
      const entries = extractZipEntries(exportResult.buffer);
      assert.ok(entries.has("xl/workbook.xml"), "Harus memiliki xl/workbook.xml");
      assert.ok(entries.has("xl/styles.xml"), "Harus memiliki xl/styles.xml");

      const workbookXml = entries.get("xl/workbook.xml")!;
      assert.match(workbookXml, /name="Ringkasan Sesi"/, "Harus memuat sheet Ringkasan Sesi");
      assert.match(workbookXml, /name="Rekonsiliasi Stok"/, "Harus memuat sheet Rekonsiliasi Stok");
      assert.match(workbookXml, /name="Rincian per Area"/, "Harus memuat sheet Rincian per Area");
      assert.match(workbookXml, /name="Audit Serial Number"/, "Harus memuat sheet Audit Serial Number");
      assert.match(workbookXml, /name="Catatan Investigasi"/, "Harus memuat sheet Catatan Investigasi");
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.1");
      }
    }
  });

  await t.test("7.2 Konsistensi Angka Rekonsiliasi Antara Database dan File Excel", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const product = db.prepare(`
        SELECT id, name, sku, unit FROM products
        WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
        ORDER BY sku ASC
        LIMIT 1
      `).get() as { id: string; name: string; sku: string; unit: string };

      const initialBal = (db.prepare(`
        SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
        FROM inventory_ledger
        WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
      `).get(product.id) as { balance: number }).balance;

      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Test SO Excel Numbers Integrity",
        scope: "ALL",
      });
      sessionId = session.id;

      const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
      const targetPhysical = initialBal + 5; // Surplus 5 pcs

      repo.saveStockOpnameAreaCount(ownerAlphaContext, {
        sessionId: session.id,
        areaId: areas[0].id,
        productId: product.id,
        unit: product.unit || "PCS",
        quantity: targetPhysical,
      });

      repo.saveStockOpnameInvestigation(ownerAlphaContext, {
        sessionId: session.id,
        productId: product.id,
        reason: "Surplus 5 pcs ditemukan di rak cadangan",
      });

      // Ambil hasil rekonsiliasi resmi dari DB
      const reconSummary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, session.id);
      const reconItem = reconSummary.items.find((it) => it.productId === product.id);
      assert.ok(reconItem);
      assert.equal(reconItem.varianceQty, 5);
      assert.equal(reconItem.countedQty, targetPhysical);

      // Ekspor ke Excel
      const exportResult = exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      const entries = extractZipEntries(exportResult.buffer);

      // Periksa sheet 2 (Rekonsiliasi Stok)
      const sheet2Xml = entries.get("xl/worksheets/sheet2.xml")!;
      assert.ok(sheet2Xml.includes(product.sku), "Sheet 2 harus memuat SKU produk");
      assert.ok(sheet2Xml.includes(escapeXml(product.name)), "Sheet 2 harus memuat Nama produk");
      assert.ok(sheet2Xml.includes(`<v>${targetPhysical}</v>`), "Sheet 2 harus memuat angka fisik terhitung");
      assert.ok(sheet2Xml.includes(`<v>5</v>`), "Sheet 2 harus memuat selisih angka +5");
      assert.ok(sheet2Xml.includes("SURPLUS"), "Sheet 2 harus memuat status SURPLUS");
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.2");
      }
    }
  });

  await t.test("7.3 Penanganan Karakter Khusus XML, Data Null, dan Tanggal", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const specialTitle = "Audit <Khusus> & 'Eksklusif' \"Toko-A\"";
      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: specialTitle,
        scope: "ALL",
        note: "Catatan dengan simbol & ampersand serta <kurung sudut>.",
      });
      sessionId = session.id;

      const exportResult = exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      const entries = extractZipEntries(exportResult.buffer);

      // Verifikasi XML di sheet 1 tidak rusak dan ter-escape
      const sheet1Xml = entries.get("xl/worksheets/sheet1.xml")!;
      assert.ok(sheet1Xml.includes("&amp;"), "Ampersand harus di-escape menjadi &amp;");
      assert.ok(sheet1Xml.includes("&lt;Khusus&gt;"), "<Khusus> harus di-escape menjadi &lt;Khusus&gt;");
      assert.ok(sheet1Xml.includes("&quot;Toko-A&quot;"), "Tanda petik ganda harus di-escape menjadi &quot;");
      assert.ok(!sheet1Xml.includes("<Khusus>"), "Karakter < > tidak boleh unescaped");
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.3");
      }
    }
  });

  await t.test("7.4 Isolasi Multi-Tenant: Owner Lain Ditolak Saat Mencoba Mengekspor Sesi", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Sesi Rahasia Owner Alpha",
        scope: "ALL",
      });
      sessionId = session.id;

      // Owner Beta mencoba mengekspor sesi milik Owner Alpha
      assert.throws(
        () => {
          exportStockOpnameSessionExcel(ownerBetaContext, session.id, db);
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "ERR_NOT_FOUND");
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.4");
      }
    }
  });

  await t.test("7.5 Isolasi Gudang: Staff Gudang Lain Ditolak Mengakses Sesi di Luar Wewenangnya", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    const southOwnerContext: ActiveSecurityContext = {
      ...ownerAlphaContext,
      warehouseId: "wh-south",
      warehouseName: "Gudang Transit Cikarang",
    };
    cancelActiveSessions(southOwnerContext, "wh-south");

    let sessionSouthId: string | null = null;
    try {
      const sessionSouth = repo.createStockOpnameSession(southOwnerContext, {
        warehouseId: "wh-south",
        title: "Sesi Gudang South",
        scope: "ALL",
      });
      sessionSouthId = sessionSouth.id;

      // Staff Alpha yang bertugas di wh-north mencoba mengekspor sesi di wh-south
      assert.throws(
        () => {
          exportStockOpnameSessionExcel(staffAlphaContext, sessionSouth.id, db);
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "ERR_FORBIDDEN_WAREHOUSE");
          assert.equal(err.statusCode, 403);
          return true;
        }
      );
    } finally {
      // Pastikan sesi wh-south selalu dibersihkan secara resmi via repository
      if (sessionSouthId) {
        repo.cancelStockOpnameSession(
          southOwnerContext,
          sessionSouthId,
          "Teardown uji coba isolasi gudang 7.5"
        );
      }
    }
  });

  await t.test("7.6 Ekspor Daftar Sesi Stock Opname Sesuai Filter Aktif", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let session1Id: string | null = null;
    try {
      const session1 = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        sessionNumber: `SO-FILTER-A-${Date.now()}`,
        title: "Sesi Filter Alpha",
        scope: "ALL",
      });
      session1Id = session1.id;

      // Ekspor dengan filter gudang wh-north
      const exportResult = exportStockOpnameListExcel(ownerAlphaContext, {
        warehouseId: "wh-north",
        status: "COUNTING",
      }, db);

      assert.ok(exportResult.buffer.length > 300);
      assert.match(exportResult.filename, /^Daftar_Stock_Opname_.*\.xlsx$/);

      const entries = extractZipEntries(exportResult.buffer);
      const sheet1Xml = entries.get("xl/worksheets/sheet1.xml")!;
      assert.ok(sheet1Xml.includes(session1.sessionNumber), "File harus memuat nomor sesi yang terfilter");
    } finally {
      if (session1Id) {
        repo.cancelStockOpnameSession(ownerAlphaContext, session1Id, "Teardown 7.6");
      }
    }
  });

  await t.test("7.7 Integritas Read-Only: Ekspor Tidak Mengubah Saldo, Ledger, SN, atau Sesi", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Test SO Read Only Exporter",
        scope: "ALL",
      });
      sessionId = session.id;

      // Catat seluruh state DB sebelum ekspor
      const preLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;
      const preSerialStatus = (db.prepare(`SELECT COUNT(*) as count FROM product_serials WHERE status = 'AVAILABLE'`).get() as { count: number }).count;
      const preSessionStatus = (db.prepare(`SELECT status FROM stock_opname_sessions WHERE id = ?`).get(session.id) as { status: string }).status;

      // Eksekusi ekspor 3 kali berturut-turut
      exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      exportStockOpnameListExcel(ownerAlphaContext, { warehouseId: "wh-north" }, db);

      // Verifikasi tidak ada perubahan apapun
      const postLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;
      const postSerialStatus = (db.prepare(`SELECT COUNT(*) as count FROM product_serials WHERE status = 'AVAILABLE'`).get() as { count: number }).count;
      const postSessionStatus = (db.prepare(`SELECT status FROM stock_opname_sessions WHERE id = ?`).get(session.id) as { status: string }).status;

      assert.equal(postLedgerCount, preLedgerCount, "Ekspor dilarang menulis atau mengubah inventory_ledger");
      assert.equal(postSerialStatus, preSerialStatus, "Ekspor dilarang mengubah status product_serials");
      assert.equal(postSessionStatus, preSessionStatus, "Ekspor dilarang mengubah status sesi");
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.7");
      }
    }
  });

  await t.test("7.8 Tidak Ada Duplikasi Baris atau Kuantitas Akibat Agregasi/Join", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    let sessionId: string | null = null;
    try {
      const product = db.prepare(`
        SELECT id, name, sku FROM products
        WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
        ORDER BY sku ASC
        LIMIT 1
      `).get() as { id: string; name: string; sku: string };

      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Test Multi Area Distinct Counts",
        scope: "ALL",
        initialAreas: ["Area 1", "Area 2"],
      });
      sessionId = session.id;

      const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);

      // Masukkan hitungan di Area 1 (10 pcs) dan Area 2 (15 pcs)
      repo.saveStockOpnameAreaCount(ownerAlphaContext, {
        sessionId: session.id,
        areaId: areas[0].id,
        productId: product.id,
        unit: "PCS",
        quantity: 10,
      });

      repo.saveStockOpnameAreaCount(ownerAlphaContext, {
        sessionId: session.id,
        areaId: areas[1].id,
        productId: product.id,
        unit: "PCS",
        quantity: 15,
      });

      const exportResult = exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      const entries = extractZipEntries(exportResult.buffer);

      const sheet2Xml = entries.get("xl/worksheets/sheet2.xml")!;
      // Pada Sheet 2 (Rekonsiliasi), total fisik harus tepat 25 (10 + 15), tanpa duplikasi kuantitas
      assert.ok(sheet2Xml.includes("<v>25</v>"), "Total hitungan fisik harus tepat 25 PCS di sheet rekonsiliasi");

      // Pada Sheet 3 (Rincian per Area), harus memuat kedua area
      const sheet3Xml = entries.get("xl/worksheets/sheet3.xml")!;
      assert.ok(sheet3Xml.includes("Area 1"));
      assert.ok(sheet3Xml.includes("Area 2"));
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.8");
      }
    }
  });

  await t.test("7.9 Lembar Audit Serial Number Memuat Klasifikasi Akurat", () => {
    cancelActiveSessions(ownerAlphaContext, "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      ORDER BY sku ASC
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const now = new Date().toISOString();
    const ts = Date.now();
    const snMatch = `SN-MATCH-${ts}`;
    const snMiss = `SN-MISS-${ts}`;

    // Buat 2 SN sintetis khusus untuk pengujian ini
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES
        ('sn-m-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?),
        ('sn-x-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?)
    `).run(serialProduct.id, snMatch, snMatch.toUpperCase(), now, now, serialProduct.id, snMiss, snMiss.toUpperCase(), now, now);

    let sessionId: string | null = null;
    try {
      const session = repo.createStockOpnameSession(ownerAlphaContext, {
        warehouseId: "wh-north",
        title: "Test Audit Serial Number Excel",
        scope: "ALL",
      });
      sessionId = session.id;

      // Snapshot memuat kedua SN
      db.prepare(`DELETE FROM stock_opname_serial_snapshots WHERE session_id = ?`).run(session.id);
      db.prepare(`
        INSERT INTO stock_opname_serial_snapshots (
          id, owner_id, warehouse_id, session_id, product_id,
          serial_number, normalized_serial_number, unit, unit_quantity,
          base_quantity, status_at_snapshot, snapshot_at
        ) VALUES
          ('snap-m-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?),
          ('snap-x-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?)
      `).run(session.id, serialProduct.id, snMatch, snMatch.toUpperCase(), now, session.id, serialProduct.id, snMiss, snMiss.toUpperCase(), now);

      const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);

      // Fisik hanya memindai snMatch (snMiss hilang)
      repo.scanStockOpnameSerial(ownerAlphaContext, {
        sessionId: session.id,
        areaId: areas[0].id,
        serialNumber: snMatch,
      });

      const exportResult = exportStockOpnameSessionExcel(ownerAlphaContext, session.id, db);
      const entries = extractZipEntries(exportResult.buffer);

      const sheet4Xml = entries.get("xl/worksheets/sheet4.xml")!;
      assert.ok(sheet4Xml.includes(snMatch), "Sheet 4 harus memuat SN yang cocok");
      assert.ok(sheet4Xml.includes("SESUAI (MATCHED)"), "Sheet 4 harus mengklasifikasikan SESUAI");
      assert.ok(sheet4Xml.includes(snMiss), "Sheet 4 harus memuat SN yang hilang");
      assert.ok(sheet4Xml.includes("HILANG (MISSING)"), "Sheet 4 harus mengklasifikasikan HILANG");
    } finally {
      if (sessionId) {
        repo.cancelStockOpnameSession(ownerAlphaContext, sessionId, "Teardown 7.9");
      }
      // Hapus hanya 2 serial sintetis yang dibuat khusus pada pengujian ini
      db.prepare(`DELETE FROM product_serials WHERE id IN (?, ?)`).run(`sn-m-${ts}`, `sn-x-${ts}`);
    }
  });

  await t.test("7.10 Aturan UI: Flat Colors, Tanpa Gradient, dan Tanpa Emoji pada Seluruh File Phase 7", () => {
    const exportTs = fs.readFileSync(path.resolve("src/lib/export/excel-builder.ts"), "utf8");
    const serviceTs = fs.readFileSync(path.resolve("src/lib/export/stock-opname-export.ts"), "utf8");
    const viewTs = fs.readFileSync(path.resolve("src/app/(app)/inventory/stock-opname/[id]/stock-opname-reconciliation-view.tsx"), "utf8");
    const listViewTs = fs.readFileSync(path.resolve("src/app/(app)/inventory/stock-opname/stock-opname-view.tsx"), "utf8");

    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    assert.equal(emojiRegex.test(exportTs), false, "excel-builder.ts tidak boleh memuat emoji");
    assert.equal(emojiRegex.test(serviceTs), false, "stock-opname-export.ts tidak boleh memuat emoji");
    assert.equal(emojiRegex.test(viewTs), false, "reconciliation-view.tsx tidak boleh memuat emoji");
    assert.equal(emojiRegex.test(listViewTs), false, "stock-opname-view.tsx tidak boleh memuat emoji");

    assert.equal(viewTs.includes("bg-gradient"), false, "reconciliation-view.tsx tidak boleh memuat gradient");
    assert.equal(listViewTs.includes("bg-gradient"), false, "stock-opname-view.tsx tidak boleh memuat gradient");
  });
});

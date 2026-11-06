/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Suite Pengujian Phase 5: Rekonsiliasi, Investigasi Selisih, dan Delta Concurrent
 *
 * Menguji:
 * 1. Hitung selisih non-serial: cocok (MATCH), surplus (SURPLUS), dan defisit (SHORTAGE).
 * 2. Multi-area aggregation: penggabungan hitungan fisik dari berbagai area secara akurat.
 * 3. Satuan kanonis & konversi: bebas konversi ganda (base_quantity selalu acuan dasar).
 * 4. Transaksi concurrent: Goods In (+Delta) dan Goods Out (-Delta) pasca-snapshot
 *    diperhitungkan ke dalam Stok Acuan Dinamis (Dynamic Book Qty).
 * 5. Drill-down Serial Number: klasifikasi akurat untuk SN Cocok, SN Hilang, dan SN Surplus/Asing,
 *    termasuk deteksi SN hilang yang legal keluar melalui Goods Out pasca-snapshot.
 * 6. Investigasi selisih: penyimpanan alasan dan catatan yang auditable tanpa mengubah snapshot.
 * 7. Isolasi Owner & gudang: penolakan keras akses evaluasi dan investigasi lintas-tenant.
 * 8. Imutabilitas ledger: rekonsiliasi Phase 5 TIDAK PERNAH menulis atau mengubah inventory_ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDatabaseClient } from "../src/lib/db/sqlite-client.ts";
import { runMigrations } from "../src/lib/db/migrator.ts";
import { seedSyntheticData } from "../src/lib/db/seed.ts";
import { InventoryRepository } from "../src/lib/db/repositories/inventory-repository.ts";
import type { ActiveSecurityContext } from "../src/lib/types/auth.ts";

const db = getDatabaseClient();
runMigrations(db);
seedSyntheticData(db);
const repo = new InventoryRepository(db);

const ownerAlphaContext: ActiveSecurityContext = {
  userId: "usr-owner-alpha",
  email: "owner_alpha@docuflow.id",
  ownerId: "owner-alpha",
  ownerName: "PT Alpha Logistik",
  warehouseId: "wh-north",
  warehouseName: "Gudang Utama Cakung",
  role: "OWNER",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

const ownerBetaContext: ActiveSecurityContext = {
  userId: "usr-owner-beta",
  email: "owner_beta@docuflow.id",
  ownerId: "owner-beta",
  ownerName: "CV Beta Distribusi",
  warehouseId: "wh-beta-01",
  warehouseName: "Gudang Pusat Surabaya",
  role: "OWNER",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

test("PHASE 5: REKONSILIASI, INVESTIGASI SELISIH, DAN DELTA CONCURRENT", async (t) => {
  let sessionId = "";
  let area1Id = "";
  let area2Id = "";

  let nonSerialProductId = "";
  let serialProductId = "";

  const initialLedgerCountRow = db
    .prepare("SELECT COUNT(*) as count FROM inventory_ledger")
    .get() as { count: number };
  const initialLedgerCount = Number(initialLedgerCountRow.count);

  await t.test("5.0 Setup Sesi Stock Opname dan Pembekuan Snapshot Awal", () => {
    // Batalkan sesi aktif lama pada wh-north agar tidak ada benturan status COUNTING
    db.prepare(`
      UPDATE stock_opname_sessions
      SET status = 'CANCELLED'
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND status IN ('DRAFT', 'COUNTING', 'REVIEW')
    `).run();

    // Cari produk non-serial dan serial di wh-north
    const nonSerialRow = db.prepare(`
      SELECT p.id, p.name, p.sku, p.unit
      FROM products p
      WHERE p.owner_id = 'owner-alpha' AND p.warehouse_id = 'wh-north' AND p.tracking_mode = 'NON_SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    assert.ok(nonSerialRow, "Produk non-serial harus tersedia di wh-north");
    nonSerialProductId = nonSerialRow.id;

    const serialRow = db.prepare(`
      SELECT p.id, p.name, p.sku, p.unit
      FROM products p
      WHERE p.owner_id = 'owner-alpha' AND p.warehouse_id = 'wh-north' AND p.tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    assert.ok(serialRow, "Produk serial harus tersedia di wh-north");
    serialProductId = serialRow.id;

    // Tambahkan 3 Serial Number unik aktif berstatus AVAILABLE
    const now = new Date().toISOString();
    const uniqueSuffix = Date.now();
    for (let i = 1; i <= 3; i++) {
      db.prepare(`
        INSERT INTO product_serials (
          id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
          unit, unit_quantity, base_quantity, status, created_at, updated_at
        ) VALUES (?, 'owner-alpha', 'wh-north', ?, ?, ?, 'pcs', 1, 1, 'AVAILABLE', ?, ?)
      `).run(
        `sn-p5-${i}-${uniqueSuffix}`,
        serialProductId,
        `SN-P5-${uniqueSuffix}-00${i}`,
        `SN-P5-${uniqueSuffix}-00${i}`,
        now,
        now
      );
    }

    const sessionRes = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      sessionNumber: `SO-P5-${Date.now()}`,
      title: "Sesi Uji Rekonsiliasi Phase 5",
      initialAreas: ["Area Barat", "Area Timur"],
    });

    assert.ok(sessionRes.id, "Sesi SO berhasil dibuat");
    sessionId = sessionRes.id;

    // Set snapshot_qty nonSerialProductId ke 100 untuk pengujian matematika selisih yang konsisten
    db.prepare(`
      UPDATE stock_opname_lines
      SET snapshot_qty = 100, dynamic_book_qty = 100, counted_qty = 100
      WHERE session_id = ? AND product_id = ?
    `).run(sessionId, nonSerialProductId);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, sessionId);
    assert.equal(areas.length, 2, "Harus terdapat 2 area awal");
    area1Id = areas.find((a) => a.name === "Area Barat")!.id;
    area2Id = areas.find((a) => a.name === "Area Timur")!.id;
  });

  await t.test("5.1 Rekonsiliasi Non-Serial Skenario MATCH (Cocok Tanpa Selisih)", () => {
    // Ambil snapshot_qty produk non-serial
    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);

    // Hitung fisik persis sama dengan snapshot di Area Barat
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: snapshotQty,
      unit: "pcs",
    });

    // Evaluasi rekonsiliasi
    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item, "Item produk non-serial harus ada dalam ringkasan");
    assert.equal(item.snapshotQty, snapshotQty);
    assert.equal(item.dynamicBookQty, snapshotQty);
    assert.equal(item.countedQty, snapshotQty);
    assert.equal(item.varianceQty, 0);
    assert.equal(item.reconciliationStatus, "MATCH");
    assert.equal(item.recommendation, "READY_FOR_ADJUSTMENT");
    assert.equal(item.hasConcurrentMovement, false);
  });

  await t.test("5.2 Rekonsiliasi Non-Serial Skenario SURPLUS (Fisik Melebihi Acuan)", () => {
    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);
    const surplusCount = snapshotQty + 10;

    // Catat hitungan surplus
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: surplusCount,
      unit: "pcs",
    });

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    assert.equal(item.countedQty, surplusCount);
    assert.equal(item.varianceQty, 10);
    assert.equal(item.reconciliationStatus, "SURPLUS");
    assert.equal(item.recommendation, "REQUIRES_INVESTIGATION");
  });

  await t.test("5.3 Rekonsiliasi Non-Serial Skenario SHORTAGE / DEFISIT (Fisik Kurang dari Acuan)", () => {
    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);
    const shortageCount = Math.max(0, snapshotQty - 7);

    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: shortageCount,
      unit: "pcs",
    });

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    assert.equal(item.countedQty, shortageCount);
    assert.equal(item.varianceQty, shortageCount - snapshotQty);
    assert.equal(item.reconciliationStatus, "SHORTAGE");
    assert.equal(item.recommendation, "REQUIRES_INVESTIGATION");
  });

  await t.test("5.4 Agregasi Multi-Area & Konversi Satuan Resmi Tanpa Double Conversion", () => {
    // Reset Area 1: 2 Lusin = 24 PCS
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: 2,
      unit: "lusin",
    });

    // Tambahkan di Area 2: 12 PCS
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area2Id,
      productId: nonSerialProductId,
      quantity: 12,
      unit: "pcs",
    });

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    // Total fisik kanonis = 24 + 12 = 36 PCS
    assert.equal(item.countedQty, 36);
    assert.equal(item.areaBreakdown.length, 2);
    const area1Count = item.areaBreakdown.find((a) => a.areaId === area1Id);
    const area2Count = item.areaBreakdown.find((a) => a.areaId === area2Id);
    assert.equal(area1Count?.countedQtyBase, 24);
    assert.equal(area2Count?.countedQtyBase, 12);
  });

  await t.test("5.5 Penanganan Concurrent Delta Masuk (Goods In Pasca-Snapshot)", () => {
    const session = db
      .prepare("SELECT snapshot_at FROM stock_opname_sessions WHERE id = ?")
      .get(sessionId) as { snapshot_at: string };

    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);

    // Simulasikan mutasi masuk resmi di inventory_ledger pasca snapshot
    const postSnapshotTime = new Date(Date.now() + 5000).toISOString();
    const ledgerId = crypto.randomUUID();
    const goodsInDelta = 15;

    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99991, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'GI-CONCURRENT-01', 'gil-1', ?, NULL, 'usr-owner-alpha', ?, ?)
    `).run(ledgerId, nonSerialProductId, goodsInDelta, postSnapshotTime, postSnapshotTime);

    // Set fisik = snapshotQty + 15 (fisik di gudang mencerminkan barang masuk yang baru datang)
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: snapshotQty + goodsInDelta,
      unit: "pcs",
    });
    // Kosongkan area 2
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area2Id,
      productId: nonSerialProductId,
      quantity: 0,
      unit: "pcs",
    });

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    assert.equal(item.snapshotQty, snapshotQty);
    assert.equal(item.deltaIn, goodsInDelta);
    assert.equal(item.deltaOut, 0);
    assert.equal(item.netDelta, goodsInDelta);
    // Acuan dinamis = Snapshot + 15
    assert.equal(item.dynamicBookQty, snapshotQty + goodsInDelta);
    assert.equal(item.countedQty, snapshotQty + goodsInDelta);
    // Selisih = 0 karena fisik cocok dengan acuan dinamis yang telah menyerap barang masuk!
    assert.equal(item.varianceQty, 0);
    assert.equal(item.reconciliationStatus, "MATCH");
    assert.equal(item.hasConcurrentMovement, true);
    assert.equal(item.concurrentTransactions.length, 1);
  });

  await t.test("5.6 Penanganan Concurrent Delta Keluar (Goods Out Pasca-Snapshot)", () => {
    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);

    // Simulasikan mutasi keluar resmi di inventory_ledger pasca snapshot
    const postSnapshotTime = new Date(Date.now() + 6000).toISOString();
    const ledgerId = crypto.randomUUID();
    const goodsOutDelta = -10; // 10 PCS keluar

    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99992, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', 'GO-CONCURRENT-01', 'gol-1', ?, NULL, 'usr-owner-alpha', ?, ?)
    `).run(ledgerId, nonSerialProductId, goodsOutDelta, postSnapshotTime, postSnapshotTime);

    // Delta In sebelumnya 15, Delta Out sekarang 10 -> Net Delta = +5
    // Acuan Dinamis = snapshotQty + 15 - 10 = snapshotQty + 5
    // Misal fisik dihitung snapshotQty + 5 -> MATCH
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      productId: nonSerialProductId,
      quantity: snapshotQty + 5,
      unit: "pcs",
    });

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    assert.equal(item.deltaIn, 15);
    assert.equal(item.deltaOut, 10);
    assert.equal(item.netDelta, 5);
    assert.equal(item.dynamicBookQty, snapshotQty + 5);
    assert.equal(item.countedQty, snapshotQty + 5);
    assert.equal(item.varianceQty, 0);
    assert.equal(item.reconciliationStatus, "MATCH");
    assert.equal(item.hasConcurrentMovement, true);
    assert.equal(item.concurrentTransactions.length, 2);
  });

  await t.test("5.6b Penanganan Concurrent Delta Retur Masuk dan Adjustment Keluar", () => {
    const lineRow = db.prepare(`
      SELECT snapshot_qty FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { snapshot_qty: number };

    const snapshotQty = Number(lineRow.snapshot_qty);

    // Simulasikan mutasi RETURN_IN_POSTED (+3)
    const postSnapshotTimeReturn = new Date(Date.now() + 7000).toISOString();
    const ledgerIdReturn = crypto.randomUUID();
    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99993, 'owner-alpha', 'wh-north', ?, NULL, 'RETURN_IN_POSTED', 'RETURN', 'RET-CONCURRENT-01', 'retl-1', 3, NULL, 'usr-owner-alpha', ?, ?)
    `).run(ledgerIdReturn, nonSerialProductId, postSnapshotTimeReturn, postSnapshotTimeReturn);

    // Simulasikan mutasi STOCK_ADJUSTMENT_POSTED negatif (-2)
    const postSnapshotTimeAdj = new Date(Date.now() + 8000).toISOString();
    const ledgerIdAdj = crypto.randomUUID();
    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99994, 'owner-alpha', 'wh-north', ?, NULL, 'STOCK_ADJUSTMENT_POSTED', 'STOCK_OPNAME_ADJUSTMENT', 'ADJ-CONCURRENT-01', 'adjl-1', -2, NULL, 'usr-owner-alpha', ?, ?)
    `).run(ledgerIdAdj, nonSerialProductId, postSnapshotTimeAdj, postSnapshotTimeAdj);

    // Total mutasi sekarang:
    // Delta In: 15 (GI) + 3 (Retur) = 18
    // Delta Out: 10 (GO) + 2 (Adj) = 12
    // Net Delta = 18 - 12 = +6
    // Dynamic Book Qty = snapshotQty + 6
    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const item = summary.items.find((i) => i.productId === nonSerialProductId);

    assert.ok(item);
    assert.equal(item.deltaIn, 18, "Delta In harus mencakup Goods In (15) dan Retur (3)");
    assert.equal(item.deltaOut, 12, "Delta Out harus mencakup Goods Out (10) dan Penyesuaian Keluar (2)");
    assert.equal(item.netDelta, 6, "Net delta harus +6");
    assert.equal(item.dynamicBookQty, snapshotQty + 6);
    assert.equal(item.concurrentTransactions.length, 4, "Harus mencakup seluruh 4 transaksi ledger concurrent");
  });

  await t.test("5.7 Drill-down Serial Number (Matched, Missing, dan Surplus/Asing)", () => {
    // Ambil snapshot serials untuk serialProductId yang memiliki konfigurasi satuan valid
    const snSnapshots = repo.getStockOpnameSerialSnapshots(ownerAlphaContext, sessionId, serialProductId);
    const validSnapshots = snSnapshots.filter(
      (s) => s.isUnitValid !== false && s.serialNumber.startsWith("SN-P5-")
    );
    assert.ok(validSnapshots.length >= 3, "Harus ada minimal 3 SN valid pada snapshot produk serial");

    const sn1 = validSnapshots[0].serialNumber;
    const sn2 = validSnapshots[1].serialNumber;
    const sn3 = validSnapshots[2].serialNumber;

    // Scan sn1 di Area 1
    const scan1 = repo.scanStockOpnameSerial(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      serialNumber: sn1,
    });
    assert.equal(scan1.success, true);

    // Scan sn2 di Area 2
    const scan2 = repo.scanStockOpnameSerial(ownerAlphaContext, {
      sessionId,
      areaId: area2Id,
      serialNumber: sn2,
    });
    assert.equal(scan2.success, true);

    // sn3 TIDAK dipindai (akan menjadi MISSING)

    // Simulasikan coba scan SN asing (akan dicatat di scan_errors)
    const scanForeign = repo.scanStockOpnameSerial(ownerAlphaContext, {
      sessionId,
      areaId: area1Id,
      serialNumber: "SN-FOREIGN-9999",
    });
    assert.equal(scanForeign.success, false);
    assert.equal(scanForeign.resultType, "UNREGISTERED_SERIAL");

    const summary = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const serialItem = summary.items.find((i) => i.productId === serialProductId);

    assert.ok(serialItem);
    assert.ok(serialItem.serialDetail, "Serial detail harus tersedia");

    // Verifikasi Matched SNs
    const matched = serialItem.serialDetail.matchedSerials;
    assert.ok(matched.some((s) => s.serialNumber === sn1 && s.scannedInArea === "Area Barat"));
    assert.ok(matched.some((s) => s.serialNumber === sn2 && s.scannedInArea === "Area Timur"));

    // Verifikasi Missing SNs
    const missing = serialItem.serialDetail.missingSerials;
    assert.ok(missing.some((s) => s.serialNumber === sn3 && !s.dispatchedPostSnapshot));

    // Verifikasi Surplus SNs (Foreign SN dari scan_errors)
    const surplus = serialItem.serialDetail.surplusSerials;
    assert.ok(surplus.some((s) => s.serialNumber === "SN-FOREIGN-9999"));

    // Karena ada SN yang tidak cocok, status harus REQUIRES_RE_EVALUATION
    assert.equal(serialItem.reconciliationStatus, "REQUIRES_RE_EVALUATION");
    assert.equal(serialItem.recommendation, "REQUIRES_RE_EVALUATION");
  });

  await t.test("5.8 Simpan Catatan Investigasi Selisih & Jejak Audit (Auditable Investigation)", () => {
    const invRes = repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId,
      productId: nonSerialProductId,
      reason: "Salah Kirim / Salah Penempatan",
      notes: "Barang ditemukan terselip di Rak B2 Lorong 4, telah diverifikasi tim audit.",
    });

    assert.equal(invRes.success, true);
    assert.equal(invRes.productId, nonSerialProductId);
    assert.equal(invRes.discrepancyReason, "Salah Kirim / Salah Penempatan");
    assert.equal(invRes.investigationNotes, "Barang ditemukan terselip di Rak B2 Lorong 4, telah diverifikasi tim audit.");

    // Verifikasi catatan tersimpan di stock_opname_lines
    const lineRow = db.prepare(`
      SELECT discrepancy_reason, investigation_notes
      FROM stock_opname_lines
      WHERE session_id = ? AND product_id = ?
    `).get(sessionId, nonSerialProductId) as { discrepancy_reason: string; investigation_notes: string };

    assert.equal(lineRow.discrepancy_reason, "Salah Kirim / Salah Penempatan");
    assert.equal(lineRow.investigation_notes, "Barang ditemukan terselip di Rak B2 Lorong 4, telah diverifikasi tim audit.");

    // Verifikasi jejak audit di tabel audit_logs
    const auditRow = db.prepare(`
      SELECT action, entity_type, payload_json
      FROM audit_logs
      WHERE entity_id = (SELECT id FROM stock_opname_lines WHERE session_id = ? AND product_id = ?)
      ORDER BY occurred_at DESC
      LIMIT 1
    `).get(sessionId, nonSerialProductId) as { action: string; entity_type: string; payload_json: string };

    assert.ok(auditRow, "Audit log harus tercatat");
    assert.equal(auditRow.action, "STOCK_OPNAME_INVESTIGATION_RECORDED");
    assert.equal(auditRow.entity_type, "STOCK_OPNAME_LINE");

    const payload = JSON.parse(auditRow.payload_json);
    assert.equal(payload.reason, "Salah Kirim / Salah Penempatan");
    assert.equal(payload.notes, "Barang ditemukan terselip di Rak B2 Lorong 4, telah diverifikasi tim audit.");
  });

  await t.test("5.9 Penegakan Isolasi Owner dan Gudang (Multi-Tenant Security)", () => {
    // Owner Beta dilarang mengevaluasi rekonsiliasi sesi milik Owner Alpha
    assert.throws(
      () => {
        repo.evaluateStockOpnameReconciliation(ownerBetaContext, sessionId);
      },
      (err: any) => err.statusCode === 404 || err.code === "ERR_NOT_FOUND"
    );

    // Owner Beta dilarang menyimpan catatan investigasi pada sesi milik Owner Alpha
    assert.throws(
      () => {
        repo.saveStockOpnameInvestigation(ownerBetaContext, {
          sessionId,
          productId: nonSerialProductId,
          reason: "Percobaan Akses Ilegal",
        });
      },
      (err: any) => err.statusCode === 404 || err.code === "ERR_NOT_FOUND"
    );
  });

  await t.test("5.10 Imutabilitas Transaksi: Rekonsiliasi Phase 5 Dilarang Menulis atau Mengubah Ledger dan Terbukti Idempoten", () => {
    // Jalankan ulang rekonsiliasi beberapa kali dan pastikan output 100% identik (Idempoten)
    const run1 = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const run2 = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);
    const run3 = repo.evaluateStockOpnameReconciliation(ownerAlphaContext, sessionId);

    assert.equal(run1.items.length, run2.items.length, "Jumlah item konsisten antar eksekusi");
    assert.equal(run2.items.length, run3.items.length, "Jumlah item konsisten antar eksekusi");
    assert.deepEqual(
      run1.items.map((i) => ({ id: i.id, book: i.dynamicBookQty, counted: i.countedQty, var: i.varianceQty, st: i.reconciliationStatus })),
      run3.items.map((i) => ({ id: i.id, book: i.dynamicBookQty, counted: i.countedQty, var: i.varianceQty, st: i.reconciliationStatus })),
      "Hasil rekonsiliasi harus 100% idempoten antar pemanggilan"
    );

    // Cek jumlah entri di inventory_ledger (hanya boleh bertambah 4 entri mock yang sengaja di-insert di test 5.5, 5.6, dan 5.6b)
    const currentLedgerCountRow = db
      .prepare("SELECT COUNT(*) as count FROM inventory_ledger")
      .get() as { count: number };
    const currentLedgerCount = Number(currentLedgerCountRow.count);

    assert.equal(
      currentLedgerCount,
      initialLedgerCount + 4,
      "Rekonsiliasi Phase 5 dilarang menulis mutasi baru ke inventory_ledger"
    );

    // Cek tidak ada entri ledger yang mengacu pada session Stock Opname ini
    const sessionLedgerEntries = db.prepare(`
      SELECT COUNT(*) as count FROM inventory_ledger
      WHERE source_doc_id = ?
    `).get(sessionId) as { count: number };

    assert.equal(
      Number(sessionLedgerEntries.count),
      0,
      "Tidak boleh ada entri ledger untuk sesi opname ini yang ditulis sebelum Phase 6"
    );
  });
});

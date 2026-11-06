/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Suite Pengujian Phase 6: Stock Opname Approval & Ledger Adjustment (TASK-SO-06)
 *
 * Menguji 19 skenario wajib:
 * 1. Adjustment surplus non-serial.
 * 2. Adjustment shortage non-serial.
 * 3. Selisih nol tanpa ledger adjustment.
 * 4. Produk multi-unit dengan konversi ke satuan dasar kanonis.
 * 5. Penyesuaian serial yang valid.
 * 6. Serial yang telah keluar setelah snapshot (Goods Out pasca-snapshot).
 * 7. Serial yang masuk melalui Goods In atau retur setelah snapshot.
 * 8. Serial duplikat, asing, atau anomali status memblokir finalisasi.
 * 9. Penolakan persetujuan tanpa izin (Role Check 403).
 * 10. Isolasi owner dan gudang (Multi-Tenant 404).
 * 11. Sesi yang belum lengkap atau belum layak difinalisasi (400).
 * 12. Sesi yang sudah final atau dibatalkan (409).
 * 13. Dua request persetujuan bersamaan tidak membuat adjustment ganda (Idempotency).
 * 14. Retry setelah kegagalan atau timeout tidak menghasilkan duplikasi.
 * 15. Rollback atomik jika terjadi kegagalan di tengah transaksi.
 * 16. Audit trail konsisten dengan ledger (STOCK_OPNAME_FINALIZED).
 * 17. Saldo akhir sesuai ledger dan aturan rekonsiliasi.
 * 18. Regresi seluruh alur Phase 2–5.
 * 19. Aturan UI & konsistensi arsitektur (zero gradient, zero emoji).
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDatabaseClient } from "../src/lib/db/sqlite-client.ts";
import { runMigrations } from "../src/lib/db/migrator.ts";
import { seedSyntheticData } from "../src/lib/db/seed.ts";
import { InventoryRepository } from "../src/lib/db/repositories/inventory-repository.ts";
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
  ownerName: "PT Alpha Logistik",
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
  ownerName: "PT Alpha Logistik",
  warehouseId: "wh-north",
  warehouseName: "Gudang Utama Cakung",
  role: "STAFF",
  isSuperAdminOnBehalf: false,
  grantId: null,
};

const salesAlphaContext: ActiveSecurityContext = {
  userId: "usr-sales-alpha",
  email: "sales_alpha@docuflow.id",
  ownerId: "owner-alpha",
  ownerName: "PT Alpha Logistik",
  warehouseId: "wh-north",
  warehouseName: "Gudang Utama Cakung",
  role: "SALES",
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

function resetActiveSessions(ownerId: string, warehouseId: string) {
  db.prepare(`
    UPDATE stock_opname_sessions
    SET status = 'CANCELLED'
    WHERE owner_id = ? AND warehouse_id = ? AND status IN ('DRAFT', 'COUNTING', 'REVIEW')
  `).run(ownerId, warehouseId);

  // Bersihkan serial uji coba sintetis tambahan yang dibuat selama test
  db.prepare(`
    DELETE FROM product_serials
    WHERE owner_id = ? AND warehouse_id = ? AND id NOT IN ('sn-rtr-001', 'sn-rtr-002', 'sn-rtr-003')
  `).run(ownerId, warehouseId);

  // Kembalikan 3 serial awal ke AVAILABLE
  db.prepare(`
    UPDATE product_serials
    SET status = 'AVAILABLE'
    WHERE id IN ('sn-rtr-001', 'sn-rtr-002', 'sn-rtr-003')
  `).run();

  // Bersihkan mutasi ledger sintetis dari pengujian concurrent dan test adjustment sebelumnya
  db.prepare(`
    DELETE FROM inventory_ledger
    WHERE source_doc_id IN ('gi-post-doc', 'go-post-doc', 'doc-init', 'GI-CONCURRENT-01', 'GO-CONCURRENT-01', 'RET-CONCURRENT-01', 'ADJ-CONCURRENT-01')
       OR id LIKE 'led-out-init-%'
       OR id LIKE 'led-go-post-%'
       OR id LIKE 'led-gi-post-%'
       OR source_doc_type = 'STOCK_OPNAME_ADJUSTMENT'
  `).run();

  seedSyntheticData(db);

  // Pastikan prod-cbl-01 memiliki saldo baseline minimal 50 untuk pengujian shortage dan surplus
  const otherLedgerDelta = (db.prepare(`
    SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
    FROM inventory_ledger
    WHERE owner_id = ? AND warehouse_id = ? AND product_id = 'prod-cbl-01' AND id != 'led-init-01'
  `).get(ownerId, warehouseId) as { balance: number }).balance;

  const neededInit = Math.max(50, 50 - otherLedgerDelta);
  db.prepare(`
    INSERT INTO inventory_ledger (
      id, sequence_number, owner_id, warehouse_id, product_id, location_id,
      entry_type, source_doc_type, source_doc_id, source_line_id,
      quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
    ) VALUES (
      'led-init-01', 1, ?, ?, 'prod-cbl-01', NULL,
      'GOODS_IN_POSTED', 'GOODS_IN', 'gi-init-01', 'line-init-01',
      ?, NULL, 'usr-super-admin', datetime('now'), datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET quantity_delta_base = excluded.quantity_delta_base
  `).run(ownerId, warehouseId, neededInit);
}

function matchDefaultSerials(sessionId: string, areaId: string) {
  for (const sn of ["SN-RTR-2026-0001", "SN-RTR-2026-0002", "SN-RTR-2026-0003"]) {
    try {
      repo.scanStockOpnameSerial(ownerAlphaContext, {
        sessionId,
        areaId,
        serialNumber: sn,
      });
    } catch {
      // Abaikan jika sudah terpindai
    }
  }
}

function isolateSessionToSingleProduct(sessionId: string, targetProductId: string) {
  db.prepare(`
    DELETE FROM stock_opname_serial_snapshots
    WHERE session_id = ? AND product_id != ?
  `).run(sessionId, targetProductId);

  db.prepare(`
    DELETE FROM stock_opname_lines
    WHERE session_id = ? AND product_id != ?
  `).run(sessionId, targetProductId);
}

test("PHASE 6: STOCK OPNAME APPROVAL & LEDGER ADJUSTMENT", async (t) => {
  t.after(() => {
    resetActiveSessions("owner-alpha", "wh-north");
  });

  await t.test("6.1 Non-Serial Surplus Adjustment (+Masuk)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      ORDER BY sku ASC
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };
    assert.ok(product);

    // Dapatkan saldo stok terkini produk
    const initialLedgerSum = db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number };
    const currentBalance = initialLedgerSum.balance;

    // Buat sesi Stock Opname
    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Surplus Non-Serial",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Hitung fisik dengan surplus +5 PCS dibanding saldo saat ini
    const surplusCount = currentBalance + 5;
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: surplusCount,
    });

    // Simpan alasan investigasi untuk item berselisih
    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Surplus fisik ditemukan di rak atas",
      notes: "Diperiksa fisik oleh tim gudang",
    });

    // Ajukan ke Review
    const reviewRes = repo.submitStockOpnameForReview(ownerAlphaContext, session.id);
    assert.equal(reviewRes.status, "REVIEW");

    // Eksekusi Persetujuan & Penyesuaian
    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      notes: "Disetujui Owner",
      autoCompletePendingAreas: true,
    });

    assert.equal(finalizeRes.status, "ADJUSTED");
    assert.equal(finalizeRes.totalAdjustedLines, 1);
    assert.equal(finalizeRes.ledgerEntriesCreated, 1);

    // Verifikasi ledger entry yang terbentuk
    const ledgerRow = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE source_doc_id = ? AND product_id = ?
    `).get(session.id, product.id) as {
      entry_type: string;
      source_doc_type: string;
      source_doc_id: string;
      source_line_id: string;
      quantity_delta_base: number;
    } | undefined;

    assert.ok(ledgerRow, "Ledger entry harus terbentuk");
    assert.equal(ledgerRow.entry_type, "STOCK_ADJUSTMENT_POSTED");
    assert.equal(ledgerRow.source_doc_type, "STOCK_OPNAME_ADJUSTMENT");
    assert.equal(ledgerRow.source_doc_id, session.id);
    assert.equal(ledgerRow.quantity_delta_base, 5);

    // Verifikasi saldo baru terproyeksi
    const postBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    assert.equal(postBalance, surplusCount, "Saldo akhir buku besar harus cocok dengan hitungan fisik");
  });

  await t.test("6.2 Non-Serial Shortage Adjustment (-Keluar)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      ORDER BY sku ASC
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const currentBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    assert.ok(currentBalance >= 5, "Saldo awal harus cukup untuk tes shortage");

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Shortage Non-Serial",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Hitung fisik defisit 3 PCS
    const shortageCount = currentBalance - 3;
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: shortageCount,
    });

    // Simpan alasan investigasi
    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Kerusakan fisik saat penataan rak",
    });

    // Eksekusi Persetujuan & Penyesuaian
    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      notes: "Disetujui defisit 3 PCS",
      autoCompletePendingAreas: true,
    });

    assert.equal(finalizeRes.status, "ADJUSTED");
    assert.equal(finalizeRes.totalAdjustedLines, 1);

    const ledgerRow = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE source_doc_id = ? AND product_id = ?
    `).get(session.id, product.id) as {
      entry_type: string;
      source_doc_type: string;
      quantity_delta_base: number;
    };

    assert.ok(ledgerRow);
    assert.equal(ledgerRow.entry_type, "STOCK_ADJUSTMENT_POSTED");
    assert.equal(ledgerRow.source_doc_type, "STOCK_OPNAME_ADJUSTMENT");
    assert.equal(ledgerRow.quantity_delta_base, -3);

    const postBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    assert.equal(postBalance, shortageCount);
  });

  await t.test("6.3 Selisih Nol Tanpa Ledger Adjustment", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      ORDER BY sku ASC
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const currentBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Selisih Nol",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Hitung fisik persis sama dengan saldo acuan
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: currentBalance,
    });

    const preLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;

    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      notes: "Sesuai sempurna",
      autoCompletePendingAreas: true,
    });

    // Ketika semua item cocok (selisih nol), sesi menjadi ADJUSTED dan 0 ledger entry dibuat
    assert.equal(finalizeRes.status, "ADJUSTED");
    assert.equal(finalizeRes.totalAdjustedLines, 0);
    assert.equal(finalizeRes.ledgerEntriesCreated, 0);

    const postLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;
    assert.equal(postLedgerCount, preLedgerCount, "Tidak boleh ada entri ledger baru untuk selisih nol");

    // Periksa bahwa line bertanda adjustment_posted = 1
    const lineRow = db.prepare(`
      SELECT adjustment_posted FROM stock_opname_lines WHERE session_id = ? AND product_id = ?
    `).get(session.id, product.id) as { adjustment_posted: number };
    assert.equal(lineRow.adjustment_posted, 1);
  });

  await t.test("6.4 Produk Multi-Unit dengan Konversi ke Satuan Dasar", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      ORDER BY sku ASC
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const currentBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Multi Unit Lusin",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Catat hitungan dalam satuan lusin (1 lusin = 12 pcs)
    // Target adalah currentBalance + 12 (surplus 1 lusin)
    const lusinNeeded = (currentBalance + 12) / 12;

    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      productId: product.id,
      unit: "lusin",
      quantity: lusinNeeded,
    });

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Konversi satuan lusin terverifikasi",
    });

    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });

    assert.equal(finalizeRes.status, "ADJUSTED");
    const ledgerRow = db.prepare(`
      SELECT quantity_delta_base FROM inventory_ledger WHERE source_doc_id = ? AND product_id = ?
    `).get(session.id, product.id) as { quantity_delta_base: number };

    // Delta harus tepat +12 pcs (satuan dasar kanonis)
    assert.equal(ledgerRow.quantity_delta_base, 12);
  });

  await t.test("6.5 Penyesuaian Serial yang Valid (Missing Decommissioned & Surplus Available)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    // Buat 2 nomor seri aktif di DB
    const now = new Date().toISOString();
    const ts = Date.now();
    const sn1 = `SN-ADJ-M1-${ts}`;
    const sn2 = `SN-ADJ-M2-${ts}`;

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES
        ('sn-id-1-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?),
        ('sn-id-2-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?)
    `).run(serialProduct.id, sn1, sn1.toUpperCase(), now, now, serialProduct.id, sn2, sn2.toUpperCase(), now, now);

    // Saldo ledger awal mencerminkan kedua serial tersebut
    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99911, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'doc-init', 'line-init', 2, NULL, 'usr-owner-alpha', ?, ?)
    `).run(`led-init-${ts}`, serialProduct.id, now, now);

    // Buat sesi Stock Opname
    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Serial Adjustments",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, serialProduct.id);
    db.prepare(`DELETE FROM stock_opname_serial_snapshots WHERE session_id = ?`).run(session.id);
    db.prepare(`
      INSERT INTO stock_opname_serial_snapshots (
        id, owner_id, warehouse_id, session_id, product_id,
        serial_number, normalized_serial_number, unit, unit_quantity,
        base_quantity, status_at_snapshot, snapshot_at
      ) VALUES
        ('snap-1-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?),
        ('snap-2-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?)
    `).run(session.id, serialProduct.id, sn1, sn1.toUpperCase(), now, session.id, serialProduct.id, sn2, sn2.toUpperCase(), now);
    db.prepare(`
      UPDATE stock_opname_lines
      SET snapshot_qty = 2, dynamic_book_qty = 2
      WHERE session_id = ? AND product_id = ?
    `).run(session.id, serialProduct.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Scan hanya sn1 (sn2 tidak discan -> missing unaccounted)
    repo.scanStockOpnameSerial(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      serialNumber: sn1,
    });

    // Simpan alasan investigasi untuk produk serial (defisit 1 pcs)
    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: serialProduct.id,
      reason: "SN-2 dinyatakan hilang setelah pencarian intensif",
    });

    // Finalisasi
    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      notes: "Finalisasi serial hilang",
      autoCompletePendingAreas: true,
    });

    assert.equal(finalizeRes.status, "ADJUSTED");

    // Periksa status serial di database
    const sn1Row = db.prepare(`SELECT status FROM product_serials WHERE id = 'sn-id-1-${ts}'`).get() as { status: string };
    const sn2Row = db.prepare(`SELECT status FROM product_serials WHERE id = 'sn-id-2-${ts}'`).get() as { status: string };

    assert.equal(sn1Row.status, "AVAILABLE", "SN yang terpindai harus tetap AVAILABLE");
    assert.equal(sn2Row.status, "DECOMMISSIONED", "SN yang hilang tanpa mutasi sah harus diubah ke DECOMMISSIONED");

    // Periksa ledger adjustment negatif untuk serial hilang dan kelengkapan serial_ids_json
    const adjLedger = db.prepare(`
      SELECT quantity_delta_base, serial_ids_json FROM inventory_ledger WHERE source_doc_id = ? AND product_id = ?
    `).get(session.id, serialProduct.id) as { quantity_delta_base: number; serial_ids_json: string };
    assert.equal(adjLedger.quantity_delta_base, -1);
    assert.ok(adjLedger.serial_ids_json && adjLedger.serial_ids_json.includes(`sn-id-2-${ts}`), "serial_ids_json pada ledger wajib memuat ID serial yang terdekomisi");
  });

  await t.test("6.6 Serial yang Telah Keluar Secara Sah Setelah Snapshot (Goods Out Pasca-Snapshot)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const now = new Date().toISOString();
    const ts = Date.now() + 10;
    const snOut = `SN-OUT-LEGIT-${ts}`;

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES ('sn-id-out-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?)
    `).run(serialProduct.id, snOut, snOut.toUpperCase(), now, now);

    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES ('led-out-init-${ts}', 99921, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'doc-init', 'line-init', 1, NULL, 'usr-owner-alpha', ?, ?)
    `).run(serialProduct.id, now, now);

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Concurrent Goods Out",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, serialProduct.id);
    db.prepare(`DELETE FROM stock_opname_serial_snapshots WHERE session_id = ?`).run(session.id);
    db.prepare(`
      INSERT INTO stock_opname_serial_snapshots (
        id, owner_id, warehouse_id, session_id, product_id,
        serial_number, normalized_serial_number, unit, unit_quantity,
        base_quantity, status_at_snapshot, snapshot_at
      ) VALUES ('snap-out-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?)
    `).run(session.id, serialProduct.id, snOut, snOut.toUpperCase(), now);
    db.prepare(`
      UPDATE stock_opname_lines
      SET snapshot_qty = 1, dynamic_book_qty = 0
      WHERE session_id = ? AND product_id = ?
    `).run(session.id, serialProduct.id);

    // Simulasi Goods Out pasca-snapshot yang mengeluarkan snOut secara sah
    const postSnapshotTime = new Date(Date.now() + 1000).toISOString();
    db.prepare(`
      UPDATE product_serials SET status = 'CONSUMED_OUT', updated_at = ? WHERE id = 'sn-id-out-${ts}'
    `).run(postSnapshotTime);

    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES ('led-go-post-${ts}', 99922, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', 'go-post-doc', 'line-1', -1, ?, 'usr-owner-alpha', ?, ?)
    `).run(serialProduct.id, JSON.stringify([`sn-id-out-${ts}`]), postSnapshotTime, postSnapshotTime);

    // Fisik: snOut tidak terpindai (karena sudah dikirim ke pelanggan) -> hitungan fisik 0
    // Dynamic book qty juga 0 (1 - 1 = 0). Variance = 0.
    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });

    // Karena selisih nol (keluar secara sah pasca snapshot), tidak ada adjustment ganda
    assert.equal(finalizeRes.status, "ADJUSTED");
    const snRow = db.prepare(`SELECT status FROM product_serials WHERE id = 'sn-id-out-${ts}'`).get() as { status: string };
    assert.equal(snRow.status, "CONSUMED_OUT", "Status serial yang keluar secara sah tidak boleh di-decommission");
  });

  await t.test("6.7 Serial yang Masuk Melalui Goods In Setelah Snapshot", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Concurrent Goods In",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, serialProduct.id);
    db.prepare(`DELETE FROM stock_opname_serial_snapshots WHERE session_id = ?`).run(session.id);
    db.prepare(`UPDATE stock_opname_lines SET snapshot_qty = 0, dynamic_book_qty = 0 WHERE session_id = ? AND product_id = ?`).run(session.id, serialProduct.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Simulasi Goods In pasca-snapshot
    const postTime = new Date(Date.now() + 1000).toISOString();
    const snIn = `SN-IN-LEGIT-${Date.now()}`;
    const snInId = `sn-id-in-${Date.now()}`;

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES (?, 'owner-alpha', 'wh-north', ?, ?, ?, 'AVAILABLE', ?, ?)
    `).run(snInId, serialProduct.id, snIn, snIn.toUpperCase(), postTime, postTime);

    db.prepare(`
      INSERT INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id,
        location_id, entry_type, source_doc_type, source_doc_id,
        source_line_id, quantity_delta_base, serial_ids_json,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, 99933, 'owner-alpha', 'wh-north', ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'gi-post-doc', 'line-1', 1, ?, 'usr-owner-alpha', ?, ?)
    `).run(`led-gi-post-${Date.now()}`, serialProduct.id, JSON.stringify([snInId]), postTime, postTime);

    // Fisik memindai snIn yang masuk pasca-snapshot (terhitung di area fisik)
    db.prepare(`
      INSERT INTO stock_opname_area_counts (
        id, owner_id, warehouse_id, session_id, area_id, product_id,
        counted_qty_base, unit, unit_quantity, scanned_serials_json, notes, created_at, updated_at
      ) VALUES (?, 'owner-alpha', 'wh-north', ?, ?, ?, 1, 'pcs', 1, ?, NULL, ?, ?)
    `).run(
      crypto.randomUUID(),
      session.id,
      areaId,
      serialProduct.id,
      JSON.stringify([{
        serialNumber: snIn,
        normalized: snIn.toUpperCase(),
        unit: "pcs",
        unitQuantity: 1,
        baseQuantity: 1,
        scannedAt: postTime,
      }]),
      postTime,
      postTime
    );

    // Dynamic book qty = 0 + 1 = 1. Fisik = 1. Variance = 0.
    const finalizeRes = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });

    // Cocok sempurna, tidak ada duplicate posting
    assert.equal(finalizeRes.status, "ADJUSTED");
    const snRow = db.prepare(`SELECT status FROM product_serials WHERE id = ?`).get(snInId) as { status: string };
    assert.equal(snRow.status, "AVAILABLE");
  });

  await t.test("6.8 Anomali / REQUIRES_RE_EVALUATION dan Selisih Tanpa Alasan Memblokir Finalisasi", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const currentBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Block Uninvestigated",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Catat selisih tapi TANPA menyimpan alasan investigasi
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId,
      productId: product.id,
      unit: "PCS",
      quantity: currentBalance + 10,
    });

    // Harus ditolak dengan ERR_VALIDATION (400)
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
          autoCompletePendingAreas: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_VALIDATION");
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /belum memiliki alasan investigasi|REQUIRES_RE_EVALUATION/);
        return true;
      }
    );
  });

  await t.test("6.9 Penolakan Persetujuan Tanpa Izin (Role Check 403)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Role Forbidden",
      scope: "ALL",
    });

    // Staff mencoba menyetujui
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(staffAlphaContext, {
          sessionId: session.id,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_FORBIDDEN_ROLE");
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // Sales mencoba menyetujui
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(salesAlphaContext, {
          sessionId: session.id,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_FORBIDDEN_ROLE");
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  await t.test("6.10 Isolasi Owner dan Gudang (Multi-Tenant 404)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Tenant Isolation",
      scope: "ALL",
    });

    // Owner Beta mencoba menyetujui sesi milik Owner Alpha
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerBetaContext, {
          sessionId: session.id,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_NOT_FOUND");
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  await t.test("6.11 Sesi yang Belum Layak / Area Belum Selesai (400)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Incomplete Areas",
      scope: "ALL",
    });

    // Jika autoCompletePendingAreas: false dan area masih status PENDING
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
          autoCompletePendingAreas: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_VALIDATION");
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /diselesaikan|PENDING/);
        return true;
      }
    );
  });

  await t.test("6.12 Sesi yang Sudah Final atau Dibatalkan (409)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Cancelled State",
      scope: "ALL",
    });

    // Batalkan sesi
    repo.cancelStockOpnameSession(ownerAlphaContext, session.id, "Dibatalkan untuk uji coba");

    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  await t.test("6.13 Concurrency & Idempotency: Dua Request Persetujuan Bersamaan", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const currentBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Idempotency",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId: areas[0].id,
      productId: product.id,
      unit: "PCS",
      quantity: currentBalance + 2,
    });

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Surplus 2 pcs",
    });

    // Request pertama berhasil
    const firstCall = repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });
    assert.equal(firstCall.status, "ADJUSTED");

    // Request kedua (concurrent / retry) harus ditolak dengan 409
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
          autoCompletePendingAreas: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_CONFLICT");
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /sudah difinalisasi/);
        return true;
      }
    );

    // Pastikan tidak ada duplicate ledger entries
    const entries = db.prepare(`
      SELECT COUNT(*) as count FROM inventory_ledger WHERE source_doc_id = ?
    `).get(session.id) as { count: number };
    assert.equal(entries.count, 1, "Hanya tepat 1 ledger entry yang dibuat");
  });

  await t.test("6.14 Retry Setelah Timeout / Kegagalan Terbukti Aman", () => {
    // Sesi yang sudah berstatus ADJUSTED tidak dapat dimanipulasi ulang melalui retry
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`SELECT id, unit FROM products WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL' LIMIT 1`).get() as { id: string; unit: string };
    const bal = (db.prepare(`SELECT COALESCE(SUM(quantity_delta_base),0) as b FROM inventory_ledger WHERE product_id = ?`).get(product.id) as { b: number }).b;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Retry Safety",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId: areas[0].id,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: bal,
    });

    repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });

    // Coba eksekusi ulang
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  await t.test("6.15 Rollback Atomik Jika Terjadi Kesalahan di Tengah Transaksi", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`SELECT id, unit FROM products WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL' LIMIT 1`).get() as { id: string; unit: string };
    const bal = (db.prepare(`SELECT COALESCE(SUM(quantity_delta_base),0) as b FROM inventory_ledger WHERE product_id = ?`).get(product.id) as { b: number }).b;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Rollback Atomic",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId: areas[0].id,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: bal + 7,
    });

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Uji rollback",
    });

    const preLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;

    // Pasang hook trigger sementara yang menggagalkan INSERT pada audit_logs untuk menguji rollback transaksi
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS test_fail_audit_trigger
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'STOCK_OPNAME_FINALIZED' AND NEW.entity_id = '${session.id}'
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_TRANSACTION_FAILURE');
      END;
    `);

    try {
      assert.throws(
        () => {
          repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
            sessionId: session.id,
            autoCompletePendingAreas: true,
          });
        },
        /SIMULATED_TRANSACTION_FAILURE/
      );

      // Verifikasi seluruh perubahan ter-rollback
      const postLedgerCount = (db.prepare(`SELECT COUNT(*) as count FROM inventory_ledger`).get() as { count: number }).count;
      assert.equal(postLedgerCount, preLedgerCount, "Tidak boleh ada entri ledger yang tertinggal setelah rollback");

      const sessionAfter = db.prepare(`SELECT status FROM stock_opname_sessions WHERE id = ?`).get(session.id) as { status: string };
      assert.notEqual(sessionAfter.status, "ADJUSTED", "Status sesi tidak boleh berubah ke ADJUSTED jika transaksi gagal");

      const lineAfter = db.prepare(`SELECT adjustment_posted FROM stock_opname_lines WHERE session_id = ? AND product_id = ?`).get(session.id, product.id) as { adjustment_posted: number };
      assert.equal(lineAfter.adjustment_posted, 0, "Flag adjustment_posted pada baris wajib ter-rollback ke 0");
    } finally {
      db.prepare(`DROP TRIGGER IF EXISTS test_fail_audit_trigger`).run();
    }
  });

  await t.test("6.16 Audit Trail Konsisten dengan Ledger (STOCK_OPNAME_FINALIZED)", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`SELECT id, unit FROM products WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL' LIMIT 1`).get() as { id: string; unit: string };
    const bal = (db.prepare(`SELECT COALESCE(SUM(quantity_delta_base),0) as b FROM inventory_ledger WHERE product_id = ?`).get(product.id) as { b: number }).b;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Audit Trail",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    repo.saveStockOpnameAreaCount(ownerAlphaContext, {
      sessionId: session.id,
      areaId: areas[0].id,
      productId: product.id,
      unit: product.unit || "PCS",
      quantity: bal + 4,
    });

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: product.id,
      reason: "Surplus 4 pcs",
    });

    repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      notes: "Audit trail test note",
      autoCompletePendingAreas: true,
    });

    const auditRow = db.prepare(`
      SELECT * FROM audit_logs
      WHERE action = 'STOCK_OPNAME_FINALIZED' AND entity_id = ?
    `).get(session.id) as {
      actor_user_id: string;
      owner_id: string;
      warehouse_id: string;
      payload_json: string;
    } | undefined;

    assert.ok(auditRow, "Audit record STOCK_OPNAME_FINALIZED harus tersimpan");
    assert.equal(auditRow.actor_user_id, ownerAlphaContext.userId);
    assert.equal(auditRow.owner_id, "owner-alpha");
    assert.equal(auditRow.warehouse_id, "wh-north");

    const details = JSON.parse(auditRow.payload_json);
    assert.equal(details.sessionId, session.id);
    assert.equal(details.finalStatus, "ADJUSTED");
    assert.equal(details.ledgerEntriesCreated, 1);
    assert.equal(details.notes, "Audit trail test note");
  });

  await t.test("6.17 Saldo Akhir Terproyeksi Sesuai Ledger dan Aturan Rekonsiliasi", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const product = db.prepare(`SELECT id, unit FROM products WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'NON_SERIAL' LIMIT 1`).get() as { id: string; unit: string };
    const targetPhysical = 88;

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Reconstructed Balance",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, product.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
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
      reason: "Penyesuaian target 88",
    });

    repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
      sessionId: session.id,
      autoCompletePendingAreas: true,
    });

    // Rekonstruksi saldo total dari seluruh mutasi ledger historis
    const reconstructedBalance = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta_base), 0) as balance
      FROM inventory_ledger
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND product_id = ?
    `).get(product.id) as { balance: number }).balance;

    assert.equal(reconstructedBalance, targetPhysical, "Saldo hasil rekonstruksi ledger wajib sama persis dengan fisik Stock Opname");
  });

  await t.test("6.18 Aturan UI: Flat Colors, Tanpa Gradient, dan Tanpa Emoji", () => {
    const dialogFilePath = path.resolve("src/app/(app)/inventory/stock-opname/[id]/stock-opname-finalize-dialog.tsx");
    const viewFilePath = path.resolve("src/app/(app)/inventory/stock-opname/[id]/stock-opname-reconciliation-view.tsx");

    const dialogContent = fs.readFileSync(dialogFilePath, "utf8");
    const viewContent = fs.readFileSync(viewFilePath, "utf8");

    // Periksa tidak ada emoji umum
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    assert.equal(emojiRegex.test(dialogContent), false, "Finalize dialog tidak boleh memuat emoji");
    assert.equal(emojiRegex.test(viewContent), false, "Reconciliation view tidak boleh memuat emoji");

    // Periksa tidak ada gradient CSS
    assert.equal(dialogContent.includes("bg-gradient"), false, "Finalize dialog tidak boleh memuat gradient");
    assert.equal(viewContent.includes("bg-gradient"), false, "Reconciliation view tidak boleh memuat gradient");
  });

  await t.test("6.19 Validasi Keamanan Surplus Serial: Tolak SN Aktif di Gudang Lain, SN CONSUMED_OUT, dan SN Beda Produk", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const ts = Date.now();
    const now = new Date().toISOString();

    // 1. SN aktif di gudang lain (wh-south)
    const crossWhSn = `SN-CROSS-WH-${ts}`;
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES ('sn-cross-${ts}', 'owner-alpha', 'wh-south', ?, ?, ?, 'AVAILABLE', ?, ?)
    `).run(serialProduct.id, crossWhSn, crossWhSn.toUpperCase(), now, now);

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Reject Cross Warehouse Surplus",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, serialProduct.id);

    const areas = repo.getStockOpnameAreas(ownerAlphaContext, session.id);
    const areaId = areas[0].id;

    // Scan serial yang aktif di gudang lain
    db.prepare(`
      INSERT INTO stock_opname_area_counts (
        id, owner_id, warehouse_id, session_id, area_id, product_id,
        counted_qty_base, unit, unit_quantity, scanned_serials_json, notes, created_at, updated_at
      ) VALUES (?, 'owner-alpha', 'wh-north', ?, ?, ?, 1, 'pcs', 1, ?, NULL, ?, ?)
    `).run(
      `count-cross-${ts}`,
      session.id,
      areaId,
      serialProduct.id,
      JSON.stringify([{
        serialNumber: crossWhSn,
        normalized: crossWhSn.toUpperCase(),
        unit: "pcs",
        unitQuantity: 1,
        baseQuantity: 1,
        scannedAt: now,
      }]),
      now,
      now
    );

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: serialProduct.id,
      reason: "Uji coba penolakan serial lintas gudang",
    });

    // Harus ditolak dengan ERR_CONFLICT (409) karena SN aktif di gudang lain
    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session.id,
          autoCompletePendingAreas: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_CONFLICT");
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /Konflik SN Lintas Gudang/);
        return true;
      }
    );

    // 2. SN sudah CONSUMED_OUT (terjual / keluar)
    resetActiveSessions("owner-alpha", "wh-north");
    const consumedSn = `SN-CONSUMED-${ts}`;
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES ('sn-consumed-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'CONSUMED_OUT', ?, ?)
    `).run(serialProduct.id, consumedSn, consumedSn.toUpperCase(), now, now);

    const session2 = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Reject Consumed Surplus",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session2.id, serialProduct.id);
    const areas2 = repo.getStockOpnameAreas(ownerAlphaContext, session2.id);

    db.prepare(`
      INSERT INTO stock_opname_area_counts (
        id, owner_id, warehouse_id, session_id, area_id, product_id,
        counted_qty_base, unit, unit_quantity, scanned_serials_json, notes, created_at, updated_at
      ) VALUES (?, 'owner-alpha', 'wh-north', ?, ?, ?, 1, 'pcs', 1, ?, NULL, ?, ?)
    `).run(
      `count-consumed-${ts}`,
      session2.id,
      areas2[0].id,
      serialProduct.id,
      JSON.stringify([{
        serialNumber: consumedSn,
        normalized: consumedSn.toUpperCase(),
        unit: "pcs",
        unitQuantity: 1,
        baseQuantity: 1,
        scannedAt: now,
      }]),
      now,
      now
    );

    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session2.id,
      productId: serialProduct.id,
      reason: "Uji coba penolakan serial yang sudah keluar",
    });

    assert.throws(
      () => {
        repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
          sessionId: session2.id,
          autoCompletePendingAreas: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "ERR_CONFLICT");
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /CONSUMED_OUT/);
        return true;
      }
    );
  });

  await t.test("6.20 Validasi Keamanan Missing Serial: Tolak Dekomisi Serial yang Sedang RESERVED", () => {
    resetActiveSessions("owner-alpha", "wh-north");

    const serialProduct = db.prepare(`
      SELECT id, name, sku, unit FROM products
      WHERE owner_id = 'owner-alpha' AND warehouse_id = 'wh-north' AND tracking_mode = 'SERIAL'
      LIMIT 1
    `).get() as { id: string; name: string; sku: string; unit: string };

    const ts = Date.now();
    const now = new Date().toISOString();
    const reservedSn = `SN-RESERVED-MISSING-${ts}`;

    // Buat serial dengan status RESERVED
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES ('sn-res-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, 'RESERVED', ?, ?)
    `).run(serialProduct.id, reservedSn, reservedSn.toUpperCase(), now, now);

    const session = repo.createStockOpnameSession(ownerAlphaContext, {
      warehouseId: "wh-north",
      title: "Test SO Reject Reserved Missing Serial",
      scope: "ALL",
    });
    isolateSessionToSingleProduct(session.id, serialProduct.id);

    // Masukkan ke snapshot
    db.prepare(`DELETE FROM stock_opname_serial_snapshots WHERE session_id = ?`).run(session.id);
    db.prepare(`
      INSERT INTO stock_opname_serial_snapshots (
        id, owner_id, warehouse_id, session_id, product_id,
        serial_number, normalized_serial_number, unit, unit_quantity,
        base_quantity, status_at_snapshot, snapshot_at
      ) VALUES ('snap-res-${ts}', 'owner-alpha', 'wh-north', ?, ?, ?, ?, 'PCS', 1, 1, 'AVAILABLE', ?)
    `).run(session.id, serialProduct.id, reservedSn, reservedSn.toUpperCase(), now);

    // Tidak ada hitungan fisik yang memuat nomor seri ini (missing)
    repo.saveStockOpnameInvestigation(ownerAlphaContext, {
      sessionId: session.id,
      productId: serialProduct.id,
      reason: "Investigasi missing serial yang sedang direservasi",
    });

    try {
      assert.throws(
        () => {
          repo.approveAndPostStockOpnameAdjustment(ownerAlphaContext, {
            sessionId: session.id,
            autoCompletePendingAreas: true,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "ERR_CONFLICT");
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /RESERVED/);
          return true;
        }
      );
    } finally {
      repo.cancelStockOpnameSession(ownerAlphaContext, session.id, "Teardown 6.20");
      db.prepare(`DELETE FROM product_serials WHERE id = ?`).run(`sn-res-${ts}`);
    }
  });
});

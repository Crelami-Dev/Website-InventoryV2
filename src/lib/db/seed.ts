/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Synthetic Database Seed (TASK-040 & Development Seed Layer)
 * Mengisi database development dengan 2 Owner sintetis yang sepenuhnya terisolasi:
 * 1. Owner Alpha Logistics (Multi-gudang, produk serial/non-serial, akun Owner & Staff).
 * 2. Owner Beta Retail (Tenant terpisah untuk pengujian isolasi multi-tenant ketat).
 * Sifat: Idempotent (aman dijalankan berulang).
 */

import type { DatabaseClient } from "./sqlite-client.ts";
import { hashPassword } from "../auth/local-auth-service.ts";

export interface SeedResult {
  success: boolean;
  owners: number;
  warehouses: number;
  users: number;
  products: number;
}

export function seedSyntheticData(db: DatabaseClient): SeedResult {
  const now = new Date().toISOString();
  const defaultPasswordHash = hashPassword("Docuflow123!");

  return db.transaction(() => {
    // ==========================================
    // 1. OWNERS SINTETIS (3 Tenant Terisolasi)
    // ==========================================
    const owners = [
      { id: "owner-super-admin", code: "OWNER-SUPER-ADMIN", name: "DocuFlow Internal Operations" },
      { id: "owner-alpha", code: "OWNER-ALPHA", name: "Alpha Logistics Indonesia" },
      { id: "owner-beta", code: "OWNER-BETA", name: "Beta Retail Nusantara" },
    ];

    const insertOwner = db.prepare(`
      INSERT INTO owners (id, code, name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `);
    for (const o of owners) {
      insertOwner.run(o.id, o.code, o.name, now, now);
    }

    // ==========================================
    // 2. GUDANG PER OWNER
    // - Super Admin: Tepat dua gudang internal (Gudang SA-01 & Gudang SA-02)
    // - Owner Alpha: Satu gudang operasional aktif (wh-north)
    // - Owner Beta: Satu gudang operasional aktif (wh-beta-01)
    // ==========================================
    const warehouses = [
      // Super Admin Internal Warehouses
      { id: "wh-sa-01", owner_id: "owner-super-admin", code: "WH-SA-01", name: "Gudang SA-01", address: "Kawasan Operasional Internal SA-01", status: "ACTIVE" },
      { id: "wh-sa-02", owner_id: "owner-super-admin", code: "WH-SA-02", name: "Gudang SA-02", address: "Kawasan Operasional Internal SA-02", status: "ACTIVE" },
      // Owner Alpha (Satu gudang operasional aktif untuk tahap sekarang)
      { id: "wh-north", owner_id: "owner-alpha", code: "WH-NORTH", name: "Gudang Utama Cakung", address: "Jl. Raya Bekasi KM 22, Jakarta Timur", status: "ACTIVE" },
      { id: "wh-south", owner_id: "owner-alpha", code: "WH-SOUTH", name: "Gudang Transit Cikarang", address: "Kawasan GIIC Blok AB, Cikarang", status: "INACTIVE" },
      // Owner Beta (Satu gudang operasional aktif untuk tahap sekarang)
      { id: "wh-beta-01", owner_id: "owner-beta", code: "WH-SUB-01", name: "Gudang Pusat Surabaya", address: "Jl. Rungkut Industri III No. 12, Surabaya", status: "ACTIVE" },
    ];

    const insertWarehouse = db.prepare(`
      INSERT INTO warehouses (id, owner_id, code, name, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address, status = excluded.status, updated_at = excluded.updated_at
    `);
    for (const w of warehouses) {
      insertWarehouse.run(w.id, w.owner_id, w.code, w.name, w.address, w.status, now, now);
    }

    // ==========================================
    // 3. PENGGUNA SINTETIS (Users)
    // ==========================================
    const users = [
      { id: "usr-super-admin", email: "admin@docuflow.id", name: "Super Admin", hash: defaultPasswordHash, is_sa: 1 },
      { id: "usr-staff-alpha", email: "staff_alpha@docuflow.id", name: "Ahmad Staff (Staff Wh-North)", hash: defaultPasswordHash, is_sa: 0 },
      { id: "usr-owner-alpha", email: "owner_alpha@docuflow.id", name: "Budi Santoso (Owner Alpha)", hash: defaultPasswordHash, is_sa: 0 },
      { id: "usr-owner-beta", email: "owner_beta@docuflow.id", name: "Citra Lestari (Owner Beta)", hash: defaultPasswordHash, is_sa: 0 },
    ];

    const insertUser = db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, is_super_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name, updated_at = excluded.updated_at
    `);
    for (const u of users) {
      insertUser.run(u.id, u.email, u.hash, u.name, u.is_sa, now, now);
    }

    // ==========================================
    // 4. ADMIN ACCESS GRANTS (Super Admin Strict Grants)
    // Super Admin TIDAK memiliki akses otomatis ke klien tanpa grant sah & eksplisit!
    // Bersihkan grant default lama jika pernah di-seed.
    // ==========================================
    db.prepare("DELETE FROM admin_access_grants WHERE id IN ('grant-sa-alpha', 'grant-sa-beta')").run();

    // ==========================================
    // 5. MEMBERSHIPS & PENUGASAN GUDANG
    // ==========================================
    const memberships = [
      { id: "mem-sa-internal", user_id: "usr-super-admin", owner_id: "owner-super-admin", role: "SUPER_ADMIN" },
      { id: "mem-oa-01", user_id: "usr-owner-alpha", owner_id: "owner-alpha", role: "OWNER" },
      { id: "mem-sa-01", user_id: "usr-staff-alpha", owner_id: "owner-alpha", role: "STAFF" },
      { id: "mem-ob-01", user_id: "usr-owner-beta", owner_id: "owner-beta", role: "OWNER" },
    ];

    const insertMembership = db.prepare(`
      INSERT INTO owner_memberships (id, user_id, owner_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
    `);
    for (const m of memberships) {
      insertMembership.run(m.id, m.user_id, m.owner_id, m.role, now, now);
    }

    // Penugasan Gudang untuk Staff Alpha HANYA ke wh-north (Gudang Utama Cakung)
    const assignments = [
      { id: "assign-sa-01", user_id: "usr-staff-alpha", owner_id: "owner-alpha", warehouse_id: "wh-north" },
    ];

    const insertAssignment = db.prepare(`
      INSERT INTO warehouse_assignments (id, user_id, owner_id, warehouse_id, status, assigned_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?)
      ON CONFLICT(id) DO UPDATE SET warehouse_id = excluded.warehouse_id
    `);
    for (const a of assignments) {
      insertAssignment.run(a.id, a.user_id, a.owner_id, a.warehouse_id, now);
    }

    // ==========================================
    // 5. SUPPLIERS & CUSTOMERS
    // ==========================================
    const suppliers = [
      { id: "sup-alpha-01", owner_id: "owner-alpha", code: "SUP-001", name: "PT Sinar Distribusi Utama" },
      { id: "sup-beta-01", owner_id: "owner-beta", code: "SUP-002", name: "CV Maju Jaya Abadi" },
    ];
    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `);
    for (const s of suppliers) {
      insertSupplier.run(s.id, s.owner_id, s.code, s.name, now, now);
    }

    const customers = [
      { id: "cust-sa-01", owner_id: "owner-super-admin", code: "CUST-SA-01", name: "Divisi Internal QA & Operasional" },
      { id: "cust-alpha-01", owner_id: "owner-alpha", code: "CUST-001", name: "PT Megah Perkasa Engineering" },
      { id: "cust-beta-01", owner_id: "owner-beta", code: "CUST-002", name: "Toko Berkah Mandiri Retail" },
    ];
    const insertCustomer = db.prepare(`
      INSERT INTO customers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `);
    for (const c of customers) {
      insertCustomer.run(c.id, c.owner_id, c.code, c.name, now, now);
    }

    // ==========================================
    // 6. PRODUK SINTETIS (Serial & Non-Serial)
    // ==========================================
    const products = [
      // Super Admin Internal - Gudang SA-01 (wh-sa-01)
      {
        id: "prod-sa-01-a",
        owner_id: "owner-super-admin",
        warehouse_id: "wh-sa-01",
        sku: "SA01-SRV-01",
        name: "Server Rack Unit SA-01",
        category: "IT Hardware",
        tracking_mode: "NON_SERIAL",
        unit: "unit",
        min_stock: 2,
        desc: "Server operasional internal Gudang SA-01",
      },
      // Super Admin Internal - Gudang SA-02 (wh-sa-02)
      {
        id: "prod-sa-02-a",
        owner_id: "owner-super-admin",
        warehouse_id: "wh-sa-02",
        sku: "SA02-SWT-01",
        name: "Network Switch Unit SA-02",
        category: "Networking",
        tracking_mode: "NON_SERIAL",
        unit: "unit",
        min_stock: 5,
        desc: "Switch jaringan operasional internal Gudang SA-02",
      },
      // Owner Alpha - Gudang Utama Cakung (wh-north)
      {
        id: "prod-rtr-01",
        owner_id: "owner-alpha",
        warehouse_id: "wh-north",
        sku: "RTR-AC1200",
        name: "Enterprise Wireless Router AC1200 Dual-Band",
        category: "Networking",
        tracking_mode: "SERIAL",
        unit: "unit",
        min_stock: 5,
        desc: "Router enterprise gigabit dengan dukungan PoE dan multi-SSID",
      },
      {
        id: "prod-cbl-01",
        owner_id: "owner-alpha",
        warehouse_id: "wh-north",
        sku: "CBL-CAT6-305",
        name: "Kabel UTP Cat6 Pure Copper 305 Meter",
        category: "Kabel",
        tracking_mode: "NON_SERIAL",
        unit: "roll",
        min_stock: 10,
        desc: "Roll kabel ethernet Cat6 unshielded twisted pair",
      },
      // Owner Beta - Gudang Surabaya (wh-beta-01)
      {
        id: "prod-beta-01",
        owner_id: "owner-beta",
        warehouse_id: "wh-beta-01",
        sku: "RET-ADAPT-65W",
        name: "Fast Charger Adapter 65W GaN Type-C",
        category: "Aksesoris",
        tracking_mode: "NON_SERIAL",
        unit: "pcs",
        min_stock: 20,
        desc: "Adaptor charger cepat GaN dual port",
      },
    ];

    const insertProduct = db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, min_stock = excluded.min_stock, updated_at = excluded.updated_at
    `);
    for (const p of products) {
      insertProduct.run(p.id, p.owner_id, p.warehouse_id, p.sku, p.name, p.category, p.tracking_mode, p.unit, p.min_stock, p.desc, now, now);
    }

    // ==========================================
    // 7. SERIAL NUMBER SINTETIS (Untuk prod-rtr-01)
    // ==========================================
    const serials = [
      { id: "sn-rtr-001", owner_id: "owner-alpha", warehouse_id: "wh-north", product_id: "prod-rtr-01", sn: "SN-RTR-2026-0001" },
      { id: "sn-rtr-002", owner_id: "owner-alpha", warehouse_id: "wh-north", product_id: "prod-rtr-01", sn: "SN-RTR-2026-0002" },
      { id: "sn-rtr-003", owner_id: "owner-alpha", warehouse_id: "wh-north", product_id: "prod-rtr-01", sn: "SN-RTR-2026-0003" },
    ];

    const insertSerial = db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `);
    for (const s of serials) {
      insertSerial.run(s.id, s.owner_id, s.warehouse_id, s.product_id, s.sn, s.sn.toUpperCase(), now, now);
    }

    // ==========================================
    // 8. SALDO AWAL VIA LEDGER ATOMIK RESMI
    // ==========================================
    const insertLedger = db.prepare(`
      INSERT OR IGNORE INTO inventory_ledger (
        id, sequence_number, owner_id, warehouse_id, product_id, location_id,
        entry_type, source_doc_type, source_doc_id, source_line_id,
        quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. Saldo 50 roll kabel UTP Cat6
    insertLedger.run(
        "led-init-01",
        1,
        "owner-alpha",
        "wh-north",
        "prod-cbl-01",
        null,
        "GOODS_IN_POSTED",
        "GOODS_IN",
        "gi-init-01",
        "line-init-01",
        50,
        null,
        "usr-super-admin",
        now,
        now
      );

      // 2. Saldo 3 unit router enterprise serial
      insertLedger.run(
        "led-init-02",
        2,
        "owner-alpha",
        "wh-north",
        "prod-rtr-01",
        null,
        "GOODS_IN_POSTED",
        "GOODS_IN",
        "gi-init-02",
        "line-init-02",
        3,
        JSON.stringify(["sn-rtr-001", "sn-rtr-002", "sn-rtr-003"]),
        "usr-super-admin",
        now,
        now
      );

      // 3. Saldo 100 pcs adaptor untuk Owner Beta
      insertLedger.run(
        "led-init-03",
        3,
        "owner-beta",
        "wh-beta-01",
        "prod-beta-01",
        null,
        "GOODS_IN_POSTED",
        "GOODS_IN",
        "gi-init-03",
        "line-init-03",
        100,
        null,
        "usr-super-admin",
        now,
        now
      );

    // 10. Seed Purchase Orders Awal (Idempotent)
    const insertPo = db.prepare(`
      INSERT OR IGNORE INTO purchase_orders (
        id, owner_id, customer_id, po_number, order_date, status, total_amount, notes, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPoLine = db.prepare(`
      INSERT OR IGNORE INTO purchase_order_lines (
        id, po_id, product_id, raw_product_name, ordered_qty, ordered_unit,
        conversion_factor, mapping_status, target_qty, fulfilled_qty, unit_price,
        discount_amount, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertPo.run(
      "po-alpha-001",
      "owner-alpha",
      "cust-alpha-01",
      "PO-202610-001",
      "2026-10-14",
      "CONFIRMED",
      15000000,
      "Pengadaan Switch Gigabit untuk PT Solusi Prima",
      "usr-super-admin",
      now,
      now
    );
    insertPoLine.run(
      "poline-alpha-001",
      "po-alpha-001",
      "prod-rtr-01",
      "Router Mikrotik RB4011",
      20,
      "PCS",
      1,
      "MAPPED",
      20,
      0,
      750000,
      0,
      now
    );

    // 11. Seed Commercial Documents / Invoices (Idempotent & Warehouse-Bound)
    const insertDoc = db.prepare(`
      INSERT INTO commercial_documents (
        id, owner_id, warehouse_id, customer_id, po_id, document_number, document_date, due_date,
        document_type, status, subtotal, item_discount, doc_nominal_discount,
        doc_percentage_discount, points_redeemed, total_amount, paid_amount,
        notes, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        warehouse_id = excluded.warehouse_id,
        total_amount = excluded.total_amount,
        updated_at = excluded.updated_at
    `);
    const insertPayment = db.prepare(`
      INSERT OR IGNORE INTO document_payments (
        id, document_id, owner_id, payment_number, payment_date, amount, payment_method,
        reference_number, notes, received_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Dokumen Owner Alpha (wh-north)
    insertDoc.run(
      "inv-alpha-001",
      "owner-alpha",
      "wh-north",
      "cust-alpha-01",
      "po-alpha-001",
      "INV-202610-001",
      "2026-10-14",
      "2026-10-31",
      "INVOICE",
      "PARTIALLY_PAID",
      10000000,
      500000,
      250000,
      0,
      0,
      9250000,
      5000000,
      "Tagihan DP Termin 1 Pengadaan Jaringan",
      "usr-super-admin",
      now,
      now
    );
    insertPayment.run(
      "pay-alpha-001",
      "inv-alpha-001",
      "owner-alpha",
      "PAY-202610-001",
      "2026-10-14",
      5000000,
      "TRANSFER",
      "TRX-BCA-98124",
      "Pembayaran Uang Muka (DP 50%) via Transfer BCA",
      "usr-super-admin",
      now
    );

    // Dokumen Super Admin Internal: Gudang SA-01
    insertDoc.run(
      "doc-sa-01-inv-01",
      "owner-super-admin",
      "wh-sa-01",
      "cust-sa-01",
      null,
      "INV-SA01-2026-001",
      "2026-10-15",
      "2026-10-30",
      "INVOICE",
      "ISSUED",
      5000000,
      0,
      0,
      0,
      0,
      5000000,
      0,
      "Dokumen Pengadaan Operasional Gudang SA-01",
      "usr-super-admin",
      now,
      now
    );

    // Dokumen Super Admin Internal: Gudang SA-02
    insertDoc.run(
      "doc-sa-02-inv-01",
      "owner-super-admin",
      "wh-sa-02",
      "cust-sa-01",
      null,
      "INV-SA02-2026-001",
      "2026-10-15",
      "2026-10-30",
      "INVOICE",
      "ISSUED",
      8500000,
      0,
      0,
      0,
      0,
      8500000,
      0,
      "Dokumen Pengadaan Operasional Gudang SA-02",
      "usr-super-admin",
      now,
      now
    );

    // Dokumen Owner Beta (wh-beta-01)
    insertDoc.run(
      "doc-beta-01-inv-01",
      "owner-beta",
      "wh-beta-01",
      "cust-beta-01",
      null,
      "INV-BETA-2026-001",
      "2026-10-15",
      "2026-10-30",
      "INVOICE",
      "ISSUED",
      1500000,
      0,
      0,
      0,
      0,
      1500000,
      0,
      "Invoice Penjualan Retail Surabaya",
      "usr-owner-beta",
      now,
      now
    );

    const insertDocLine = db.prepare(`
      INSERT OR IGNORE INTO commercial_document_lines (
        id, owner_id, document_id, source_order_item_id, product_id, description_snapshot,
        quantity, unit_price, discount_type, discount_value, line_total, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertDocLine.run(
      "docline-alpha-001",
      "owner-alpha",
      "inv-alpha-001",
      "poline-alpha-001",
      "prod-rtr-01",
      "Router Mikrotik RB4011iGS+RM Enterprise Gateway",
      10,
      1000000,
      "NOMINAL",
      500000,
      9500000,
      now
    );
    insertDocLine.run(
      "docline-sa-01-001",
      "owner-super-admin",
      "doc-sa-01-inv-01",
      null,
      "prod-sa-01-a",
      "Server Rack Unit SA-01",
      1,
      5000000,
      "NONE",
      0,
      5000000,
      now
    );
    insertDocLine.run(
      "docline-sa-02-001",
      "owner-super-admin",
      "doc-sa-02-inv-01",
      null,
      "prod-sa-02-a",
      "Network Switch Unit SA-02",
      2,
      4250000,
      "NONE",
      0,
      8500000,
      now
    );

    // 12. Seed Retur Barang (Idempotent)
    const insertReturn = db.prepare(`
      INSERT OR IGNORE INTO inventory_returns (
        id, owner_id, warehouse_id, customer_id, goods_out_id, return_number, return_date,
        reason, status, reopen_source_qty, notes, created_by_user_id, received_by_user_id,
        received_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertReturnLine = db.prepare(`
      INSERT OR IGNORE INTO inventory_return_lines (
        id, return_id, product_id, quantity, unit, condition, returned_serials_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertReturn.run(
      "ret-alpha-001",
      "owner-alpha",
      "wh-north",
      "cust-alpha-01",
      null,
      "RET-202610-001",
      "2026-10-15",
      "SALAH_KIRIM",
      "RECEIVED",
      1,
      "Pengembalian salah tipe Switch - membuka kembali kuota",
      "usr-super-admin",
      "usr-super-admin",
      now,
      now,
      now
    );
    insertReturnLine.run(
      "retline-alpha-001",
      "ret-alpha-001",
      "prod-rtr-01",
      2,
      "unit",
      "BAIK",
      null,
      now
    );

    return {
      success: true,
      owners: owners.length,
      warehouses: warehouses.length,
      users: users.length,
      products: products.length,
    };
  });
}

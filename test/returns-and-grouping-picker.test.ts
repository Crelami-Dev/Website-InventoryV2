import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { InventoryRepository } from '../src/lib/db/repositories/inventory-repository.ts';
import { getDatabaseClient } from '../src/lib/db/sqlite-client.ts';
import { runMigrations } from '../src/lib/db/migrator.ts';
import type { ActiveSecurityContext } from '../src/lib/types/auth.ts';

describe('FITUR RETURN & GROUPING PICKER & REVERT V2 (TEST LENGKAP)', () => {
  const db = getDatabaseClient();
  let repo: InventoryRepository;

  const mockContext: ActiveSecurityContext = {
    userId: 'usr-joko-ui',
    email: 'joko@docuflow.id',
    ownerId: 'owner-alpha',
    ownerName: 'Alpha Logistics Indonesia',
    warehouseId: 'wh-north',
    warehouseName: 'Gudang Cakung',
    role: 'STAFF',
    isSuperAdminOnBehalf: false,
    grantId: null,
  };

  const pId = 'prod-ret-test-1';
  const cId = 'cust-ret-test-1';
  const sId = 'sup-ret-test-1';

  beforeEach(() => {
    runMigrations(db);
    repo = new InventoryRepository(db);

    // Setup User, Owner, Warehouse
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, full_name, is_super_admin, created_at, updated_at)
      VALUES (?, ?, 'hash', 'Joko UI', 0, datetime('now'), datetime('now'))
    `).run(mockContext.userId, mockContext.email);

    db.prepare(`
      INSERT OR IGNORE INTO owners (id, code, name, status, created_at, updated_at)
      VALUES (?, 'ALPHA', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.ownerId, mockContext.ownerName);

    db.prepare(`
      INSERT OR IGNORE INTO warehouses (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, 'WH-N', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.warehouseId, mockContext.ownerId, mockContext.warehouseName);

    // Setup Customer & Supplier
    db.prepare(`
      INSERT OR IGNORE INTO customers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, 'C-01', 'PT Customer Retur', 'ACTIVE', datetime('now'), datetime('now'))
    `).run(cId, mockContext.ownerId);

    db.prepare(`
      INSERT OR IGNORE INTO suppliers (id, owner_id, code, name, created_at, updated_at)
      VALUES (?, ?, 'S-01', 'PT Supplier Retur', datetime('now'), datetime('now'))
    `).run(sId, mockContext.ownerId);

    // Setup Product
    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-RET-1', 'Monitor LED 24 Inch', 'Elektronik', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);
  });

  it('1. Retur Pelanggan: Buat DRAFT, Approve -> Stok Bertambah & Serial AVAILABLE', () => {
    const sn = `SN-RET-CUST-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO product_serials (
        id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
        status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
    `).run(`sid-${sn}`, mockContext.ownerId, mockContext.warehouseId, pId, sn, sn);

    const retNumber = `RET-CUST-${Date.now().toString().slice(-6)}`;
    const ret = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId!,
      returnType: 'CUSTOMER_RETURN',
      customerId: cId,
      returnNumber: retNumber,
      returnDate: '2026-10-26',
      reason: 'SALAH_KIRIM',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'pcs',
          condition: 'BAIK',
          returnedSerials: [sn],
        },
      ],
    });

    assert.equal(ret.status, 'DRAFT');

    // Approve & Receive
    const resApprove = repo.approveAndReceiveInventoryReturn(mockContext, ret.id);
    assert.equal(resApprove.received, true);

    // Verifikasi status serial berubah ke AVAILABLE
    const serialRow = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn) as { status: string };
    assert.equal(serialRow.status, 'AVAILABLE');

    // Verifikasi ledger entry RETURN_IN_POSTED
    const ledgerRow = db.prepare(`SELECT entry_type, quantity_delta_base FROM inventory_ledger WHERE source_doc_id = ?`).get(ret.id) as { entry_type: string; quantity_delta_base: number };
    assert.equal(ledgerRow.entry_type, 'RETURN_IN_POSTED');
    assert.equal(ledgerRow.quantity_delta_base, 1);
  });

  it('2. Retur ke Supplier: Approve -> Stok Berkurang & Serial RETURNED_TO_SUPPLIER', () => {
    const sn = `SN-RET-SUP-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO product_serials (
        id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
        status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
    `).run(`sid-${sn}`, mockContext.ownerId, mockContext.warehouseId, pId, sn, sn);

    const retNumber = `RET-SUP-${Date.now().toString().slice(-6)}`;
    const ret = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId!,
      returnType: 'SUPPLIER_RETURN',
      supplierId: sId,
      returnNumber: retNumber,
      returnDate: '2026-10-26',
      reason: 'CACAT',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'pcs',
          condition: 'RUSAK',
          returnedSerials: [sn],
        },
      ],
    });

    assert.equal(ret.status, 'DRAFT');

    // Approve & Receive (Return Outbound)
    const resApprove = repo.approveAndReceiveInventoryReturn(mockContext, ret.id);
    assert.equal(resApprove.received, true);

    // Verifikasi status serial berubah ke RETURNED_TO_SUPPLIER
    const serialRow = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn) as { status: string };
    assert.equal(serialRow.status, 'RETURNED_TO_SUPPLIER');

    // Verifikasi ledger entry RETURN_OUT_POSTED dengan delta negatif
    const ledgerRow = db.prepare(`SELECT entry_type, quantity_delta_base FROM inventory_ledger WHERE source_doc_id = ?`).get(ret.id) as { entry_type: string; quantity_delta_base: number };
    assert.equal(ledgerRow.entry_type, 'RETURN_OUT_POSTED');
    assert.equal(ledgerRow.quantity_delta_base, -1);
  });

  it('3. Revert Retur Pelanggan: Batalkan RECEIVED -> Jurnal Pembalik & Serial CONSUMED_OUT', () => {
    const sn = `SN-REV-CUST-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO product_serials (
        id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
        status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
    `).run(`sid-${sn}`, mockContext.ownerId, mockContext.warehouseId, pId, sn, sn);

    const retNumber = `RET-REV-${Date.now().toString().slice(-6)}`;
    const ret = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId!,
      returnType: 'CUSTOMER_RETURN',
      customerId: cId,
      returnNumber: retNumber,
      returnDate: '2026-10-26',
      reason: 'PEMBATALAN',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'pcs',
          condition: 'BAIK',
          returnedSerials: [sn],
        },
      ],
    });

    repo.approveAndReceiveInventoryReturn(mockContext, ret.id);

    // Revert retur
    const resRevert = repo.revertInventoryReturn(mockContext, ret.id, 'Pelanggan tidak jadi mengembalikan barang');
    assert.equal(resRevert.reverted, true);

    // Serial kembali menjadi CONSUMED_OUT
    const serialRow = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn) as { status: string };
    assert.equal(serialRow.status, 'CONSUMED_OUT');

    // Ada mutasi ledger pembalik RETURN_REVERSAL_POSTED bernilai negatif
    const revLedgerRow = db.prepare(`SELECT entry_type, quantity_delta_base FROM inventory_ledger WHERE source_doc_id = ? AND entry_type = 'RETURN_REVERSAL_POSTED'`).get(ret.id) as { entry_type: string; quantity_delta_base: number };
    assert.equal(revLedgerRow.entry_type, 'RETURN_REVERSAL_POSTED');
    assert.equal(revLedgerRow.quantity_delta_base, -1);
  });

  it('4. Retur Eceran: Grouping DISSOLVED secara otomatis', () => {
    const grpNumber = `G-RET-${Date.now().toString().slice(-4)}`;
    const grpId = `grp-${Date.now()}`;
    db.prepare(`
      INSERT INTO serial_groupings (
        id, owner_id, warehouse_id, group_number, group_name, product_id,
        unit, unit_qty, total_base_qty_pcs, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, 'Box Lusin', ?, 'lusin', 1, 12, 'CONSUMED_OUT', ?, datetime('now'))
    `).run(grpId, mockContext.ownerId, mockContext.warehouseId, grpNumber, pId, mockContext.userId);

    const childSn = `SN-CHILD-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO product_serials (
        id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number,
        status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, ?, datetime('now'), datetime('now'))
    `).run(`sid-${childSn}`, mockContext.ownerId, mockContext.warehouseId, pId, childSn, childSn, grpId);

    const retNumber = `RET-ECERAN-${Date.now().toString().slice(-6)}`;
    const ret = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId!,
      returnType: 'CUSTOMER_RETURN',
      customerId: cId,
      returnNumber: retNumber,
      returnDate: '2026-10-26',
      reason: 'CACAT',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'pcs',
          condition: 'RUSAK',
          returnedSerials: [childSn],
          groupId: grpId,
          groupReturnMode: 'ECERAN_DISSOLVE',
        },
      ],
    });

    repo.approveAndReceiveInventoryReturn(mockContext, ret.id);

    // Verifikasi group berstatus DISSOLVED akibat retur eceran
    const grpRow = db.prepare(`SELECT status, notes FROM serial_groupings WHERE id = ?`).get(grpId) as { status: string; notes: string };
    assert.equal(grpRow.status, 'DISSOLVED');
    assert.match(grpRow.notes, /retur eceran/i);
  });
});

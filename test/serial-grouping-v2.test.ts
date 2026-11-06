import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryRepository } from '../src/lib/db/repositories/inventory-repository.ts';
import { getDatabaseClient } from '../src/lib/db/sqlite-client.ts';
import { runMigrations } from '../src/lib/db/migrator.ts';
import type { ActiveSecurityContext } from '../src/lib/types/auth.ts';

describe('FITUR SERIAL GROUPING DOCUFLOW V2 (6 PENGUJIAN WAJIB)', () => {
  const db = getDatabaseClient();
  let repo: InventoryRepository;

  const mockContext: ActiveSecurityContext = {
    userId: 'usr-staff-alpha',
    email: 'staff_alpha@docuflow.id',
    ownerId: 'owner-alpha',
    ownerName: 'Alpha Logistics Indonesia',
    warehouseId: 'wh-north',
    warehouseName: 'Gudang Utama Cakung',
    role: 'STAFF',
    isSuperAdminOnBehalf: false,
    grantId: null,
  };

  beforeEach(() => {
    runMigrations(db);
    repo = new InventoryRepository(db);

    // Pastikan user, owner, dan warehouse terdaftar
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, full_name, is_super_admin, created_at, updated_at)
      VALUES (?, ?, 'hash', 'Staff Alpha', 0, datetime('now'), datetime('now'))
    `).run(mockContext.userId, mockContext.email);

    db.prepare(`
      INSERT OR IGNORE INTO owners (id, code, name, status, created_at, updated_at)
      VALUES (?, 'ALPHA', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.ownerId, mockContext.ownerName);

    db.prepare(`
      INSERT OR IGNORE INTO warehouses (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, 'WH-N', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.warehouseId, mockContext.ownerId, mockContext.warehouseName);
  });

  it('1. UNIT_MISMATCH untuk jumlah tidak pas (contoh: 11 pcs pada satuan lusin wajib tolak "Kurang 1 pcs")', () => {
    const pId = 'prod-sn-test-1';
    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-1', 'Baju Kemeja Polos', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    // Buat 11 serial @ 1 pcs
    const sIds: string[] = [];
    for (let i = 1; i <= 11; i++) {
      const sId = `sn-unit-mismatch-${i}`;
      const snStr = `SN-UM-${Date.now()}-${i}`;
      sIds.push(sId);
      db.prepare(`
        INSERT OR REPLACE INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    assert.throws(
      () => {
        repo.createSerialGroupsBatch(mockContext, {
          warehouseId: mockContext.warehouseId!,
          groups: [
            {
              unit: 'lusin',
              serialIds: sIds, // 11 pcs
            },
          ],
        });
      },
      (err: unknown) => {
        const e = err as { code: string; message: string };
        assert.equal(e.code, 'UNIT_MISMATCH');
        assert.match(e.message, /Kurang 1 pcs/i);
        return true;
      }
    );
  });

  it('2. Group 12 pcs keluar: stok produk -12, tidak ada anggota AVAILABLE', () => {
    const pId = 'prod-sn-test-2';
    db.prepare("DELETE FROM goods_out_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM reservations WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_grouping_components WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_groupings WHERE owner_id = ? AND product_id = ?").run(mockContext.ownerId, pId);
    db.prepare("DELETE FROM product_serials WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM inventory_ledger WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_area_counts WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_serial_snapshots WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM products WHERE id = ?").run(pId);

    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-2', 'Celana Chino Pria', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    // Saldo awal ledger 20 pcs
    const seqRow = db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM inventory_ledger WHERE owner_id = ?").get(mockContext.ownerId) as { next_seq: number };
    const seq = seqRow.next_seq;
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, 'gil-1', 20, NULL, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), seq, mockContext.ownerId, mockContext.warehouseId, pId, `gi-init-${Date.now()}`, mockContext.userId);

    const initialBalance = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(initialBalance.physicalStock, 20);

    // Buat 12 SN
    const sIds: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const sId = `sn-go-test-${Date.now()}-${i}`;
      const snStr = `SN-GO-${Date.now()}-${i}`;
      sIds.push(sId);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    // Buat Group 1 lusin (12 pcs)
    const grpRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId!,
      groups: [
        {
          unit: 'lusin',
          serialIds: sIds,
        },
      ],
    });
    const grp = grpRes.createdGroups[0];
    assert.equal(grp.totalBaseQtyPcs, 12);

    // Selesaikan Goods Out yang mengeluarkan Group ini
    const goPending = repo.createGoodsOutPendingTransaction(mockContext, {
      warehouseId: mockContext.warehouseId!,
      documentNumber: `DO-GRP-${Date.now()}`,
      documentDate: '2026-10-24',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'lusin',
          serials: [grp.groupNumber], // Scan barcode group!
          groupId: grp.id,
          groupSerialsSnapshotJson: JSON.stringify(sIds),
        },
      ],
    });

    // Complete Goods Out
    repo.completeGoodsOutTransaction(mockContext, goPending.goodsOutId);

    // Verifikasi saldo stok produk berkurang 12 pcs murni dari ledger
    const finalBalance = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(finalBalance.physicalStock, 20 - 12); // Berkurang 12 pcs!

    // Verifikasi status serial induk group = CONSUMED_OUT
    const grpSnRow = db.prepare("SELECT status FROM product_serials WHERE serial_number = ? AND is_group = 1").get(grp.groupNumber) as { status: string };
    assert.equal(grpSnRow.status, 'CONSUMED_OUT');

    // Verifikasi SEMUA 12 serial anggota menjadi CONSUMED_OUT (tidak ada yang tersisa AVAILABLE)
    const memberRows = db.prepare(`
      SELECT status FROM product_serials WHERE id IN (${sIds.map(() => '?').join(',')})
    `).all(...sIds) as Array<{ status: string }>;

    assert.equal(memberRows.length, 12);
    for (const m of memberRows) {
      assert.equal(m.status, 'CONSUMED_OUT');
    }
  });

  it('3. Batal DO: stok dan status identik seperti sebelum keluar', () => {
    const pId = 'prod-sn-test-3';
    db.prepare("DELETE FROM goods_out_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM reservations WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_grouping_components WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_groupings WHERE owner_id = ? AND product_id = ?").run(mockContext.ownerId, pId);
    db.prepare("DELETE FROM product_serials WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM inventory_ledger WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_area_counts WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_serial_snapshots WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM products WHERE id = ?").run(pId);

    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-3', 'Jaket Bomber', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    const seqRow = db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM inventory_ledger WHERE owner_id = ?").get(mockContext.ownerId) as { next_seq: number };
    const seq = seqRow.next_seq;
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, 'gil-1', 15, NULL, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), seq, mockContext.ownerId, mockContext.warehouseId, pId, `gi-init-${Date.now()}`, mockContext.userId);

    const sIds: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const sId = `sn-batal-do-${Date.now()}-${i}`;
      const snStr = `SN-BDO-${Date.now()}-${i}`;
      sIds.push(sId);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    const grpRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId!,
      groups: [{ unit: 'pcs', serialIds: sIds }],
    });
    const grp = grpRes.createdGroups[0];

    // Simpan saldo & status sebelum DO
    const preBalance = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(preBalance.physicalStock, 15);

    // Jalankan DO Complete
    const goPending = repo.createGoodsOutPendingTransaction(mockContext, {
      warehouseId: mockContext.warehouseId!,
      documentNumber: `DO-BATAL-${Date.now()}`,
      documentDate: '2026-10-24',
      lines: [
        {
          productId: pId,
          quantity: 2,
          unit: 'pcs',
          serials: [grp.groupNumber],
          groupId: grp.id,
          groupSerialsSnapshotJson: JSON.stringify(sIds),
        },
      ],
    });
    repo.completeGoodsOutTransaction(mockContext, goPending.goodsOutId);

    // Stok berkurang 2 saat complete
    assert.equal(repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId).physicalStock, 13);

    // BATALKAN DO SELESAI
    repo.cancelCompletedGoodsOutTransaction(mockContext, goPending.goodsOutId, 'Salah kirim, batalkan DO');

    // 1. Saldo stok pulih identik seperti sebelum keluar (15 pcs)
    const postBalance = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(postBalance.physicalStock, preBalance.physicalStock);

    // 2. Status Group pulih AVAILABLE
    const grpRow = db.prepare("SELECT status FROM serial_groupings WHERE id = ?").get(grp.id) as { status: string };
    assert.equal(grpRow.status, 'AVAILABLE');

    // 3. Status Anggota pulih GROUPED
    const memberRows = db.prepare(`SELECT status FROM product_serials WHERE id IN (?, ?)`).all(...sIds) as Array<{ status: string }>;
    for (const m of memberRows) {
      assert.equal(m.status, 'GROUPED');
    }
  });

  it('4. Create lalu ungroup: reconstructStockBalance sama seperti awal', () => {
    const pId = 'prod-sn-test-4';
    db.prepare("DELETE FROM goods_out_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM reservations WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_grouping_components WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM serial_groupings WHERE owner_id = ? AND product_id = ?").run(mockContext.ownerId, pId);
    db.prepare("DELETE FROM product_serials WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM inventory_ledger WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_lines WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_area_counts WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM stock_opname_serial_snapshots WHERE product_id = ?").run(pId);
    db.prepare("DELETE FROM products WHERE id = ?").run(pId);

    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-4', 'Topi Baseball', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    const seqRow = db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq FROM inventory_ledger WHERE owner_id = ?").get(mockContext.ownerId) as { next_seq: number };
    const seq = seqRow.next_seq;
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, serial_ids_json, actor_user_id, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, 'gil-1', 10, NULL, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), seq, mockContext.ownerId, mockContext.warehouseId, pId, `gi-init-${Date.now()}`, mockContext.userId);

    const initialBalance = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);

    const sIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const sId = `sn-ungroup-test-${Date.now()}-${i}`;
      const snStr = `SN-UG-${Date.now()}-${i}`;
      sIds.push(sId);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    // 1. Create Group (Ledger tidak bergerak)
    const grpRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId!,
      groups: [{ unit: 'pcs', serialIds: sIds }],
    });
    const grp = grpRes.createdGroups[0];
    const balanceDuringGroup = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(balanceDuringGroup.physicalStock, initialBalance.physicalStock);

    // 2. Ungroup
    repo.dissolveGrouping(mockContext, grp.id, 'Bongkar group kembali');

    // 3. Verifikasi saldo reconstructStockBalance sama persis seperti awal
    const balanceAfterUngroup = repo.calculateStockBalance(mockContext.ownerId, mockContext.warehouseId!, pId);
    assert.equal(balanceAfterUngroup.physicalStock, initialBalance.physicalStock);
    assert.equal(balanceAfterUngroup.availableStock, initialBalance.availableStock);

    // Verifikasi anggota kembali AVAILABLE dan parent_group_id null
    const members = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE id IN (?, ?, ?)`).all(...sIds) as Array<{ status: string; parent_group_id: string | null }>;
    for (const m of members) {
      assert.equal(m.status, 'AVAILABLE');
      assert.equal(m.parent_group_id, null);
    }
  });

  it('5. Group yang sudah RESERVED/CONSUMED_OUT tidak bisa di-group ulang atau di-ungroup', () => {
    const pId = 'prod-sn-test-5';
    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-5', 'Kaos Kaki Katun', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    const sIds: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const sId = `sn-lock-test-${Date.now()}-${i}`;
      const snStr = `SN-LOCK-${Date.now()}-${i}`;
      sIds.push(sId);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    const grpRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId!,
      groups: [{ unit: 'pcs', serialIds: sIds }],
    });
    const grp = grpRes.createdGroups[0];

    // Tandai status group ke RESERVED
    db.prepare("UPDATE serial_groupings SET status = 'RESERVED' WHERE id = ?").run(grp.id);

    // Coba ungroup saat RESERVED -> Wajib ditolak!
    assert.throws(
      () => {
        repo.dissolveGrouping(mockContext, grp.id);
      },
      (err: any) => {
        assert.match(err.message, /Keluarkan dulu dari dokumen/i);
        return true;
      }
    );

    // Tandai status group ke CONSUMED_OUT
    db.prepare("UPDATE serial_groupings SET status = 'CONSUMED_OUT' WHERE id = ?").run(grp.id);

    // Coba ungroup saat CONSUMED_OUT -> Wajib ditolak!
    assert.throws(
      () => {
        repo.dissolveGrouping(mockContext, grp.id);
      },
      (err: any) => {
        assert.match(err.message, /hanya dapat diproses melalui alur Retur/i);
        return true;
      }
    );
  });

  it('6. Rollback batch: 1 baris error, tidak ada group tersimpan', () => {
    const pId = 'prod-sn-test-6';
    db.prepare(`
      INSERT INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-SN-6', 'Sandal Slop', 'Pakaian', 'SERIAL', 'pcs', 5, 'ACTIVE', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).run(pId, mockContext.ownerId, mockContext.warehouseId);

    // Buat SN baris 1 (valid: 2 pcs)
    const validIds: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const sId = `sn-valid-rb-${Date.now()}-${i}`;
      const snStr = `SN-VRB-${Date.now()}-${i}`;
      validIds.push(sId);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    // Buat SN baris 2 (invalid: hanya 1 SN < 2)
    const invalidIds: string[] = [];
    const sIdInv = `sn-inv-rb-${Date.now()}`;
    const snStrInv = `SN-IRB-${Date.now()}`;
    invalidIds.push(sIdInv);
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, parent_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, NULL, datetime('now'), datetime('now'))
    `).run(sIdInv, mockContext.ownerId, mockContext.warehouseId, pId, snStrInv, snStrInv);

    const initialTotalGroups = (db.prepare("SELECT COUNT(*) AS c FROM serial_groupings WHERE owner_id = ?").get(mockContext.ownerId) as { c: number }).c;

    // Kirim batch 2 baris (baris 1 valid, baris 2 gagal)
    assert.throws(
      () => {
        repo.createSerialGroupsBatch(mockContext, {
          warehouseId: mockContext.warehouseId!,
          groups: [
            { unit: 'pcs', serialIds: validIds },
            { unit: 'pcs', serialIds: invalidIds }, // GAGAL karena < 2 SN!
          ],
        });
      },
      (err: any) => {
        assert.match(err.message, /Minimal 2 nomor seri/i);
        return true;
      }
    );

    // Verifikasi ROLLBACK ATOMIK: tidak ada group yang bertambah di database!
    const postTotalGroups = (db.prepare("SELECT COUNT(*) AS c FROM serial_groupings WHERE owner_id = ?").get(mockContext.ownerId) as { c: number }).c;
    assert.equal(postTotalGroups, initialTotalGroups);

    // Verifikasi status SN valid baris 1 TIDAK BERUBAH (tetap AVAILABLE, tidak terkunci GROUPED)
    const validRows = db.prepare(`SELECT status FROM product_serials WHERE id IN (?, ?)`).all(...validIds) as Array<{ status: string }>;
    for (const r of validRows) {
      assert.equal(r.status, 'AVAILABLE');
    }
  });
});

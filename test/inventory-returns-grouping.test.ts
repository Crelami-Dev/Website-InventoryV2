import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryRepository } from '../src/lib/db/repositories/inventory-repository.ts';
import { getDatabaseClient } from '../src/lib/db/sqlite-client.ts';
import { runMigrations } from '../src/lib/db/migrator.ts';
import { reconstructStockBalance } from '../src/lib/inventory/ledger-engine.ts';
import { RETURN_ERROR_CODES } from '../src/lib/types/inventory-domain.ts';
import type { ActiveSecurityContext } from '../src/lib/types/auth.ts';

describe('FITUR RETUR & GROUPING SERIAL DOCUFLOW V2 (BACKEND & LEDGER INVARIANTS)', () => {
  const db = getDatabaseClient();
  let repo: InventoryRepository;

  const mockContext: ActiveSecurityContext & { warehouseId: string } = {
    userId: 'usr-tester-returns',
    email: 'tester_returns@docuflow.id',
    ownerId: 'owner-returns-corp',
    ownerName: 'Returns Corp Indonesia',
    warehouseId: 'wh-returns-central',
    warehouseName: 'Gudang Pusat Retur',
    role: 'OWNER',
    isSuperAdminOnBehalf: false,
    grantId: null,
  };

  const getLedger = () => {
    const rows = db.prepare(`
      SELECT id, sequence_number as sequenceNumber, owner_id as ownerId, warehouse_id as warehouseId,
             product_id as productId, location_id as locationId, entry_type as entryType,
             source_doc_type as sourceDocType, source_doc_id as sourceDocId,
             source_line_id as sourceLineId, quantity_delta_base as quantityDeltaBase,
             actor_user_id as actorUserId, occurred_at as occurredAt
      FROM inventory_ledger
      WHERE owner_id = ? AND warehouse_id = ?
      ORDER BY sequence_number ASC
    `).all(mockContext.ownerId, mockContext.warehouseId) as any[];
    return rows;
  };

  beforeEach(() => {
    runMigrations(db);
    repo = new InventoryRepository(db);

    // Setup User, Owner, Warehouse, Customer, Supplier
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, full_name, is_super_admin, created_at, updated_at)
      VALUES (?, ?, 'hash', 'Return Tester', 0, datetime('now'), datetime('now'))
    `).run(mockContext.userId, mockContext.email);

    db.prepare(`
      INSERT OR IGNORE INTO owners (id, code, name, status, created_at, updated_at)
      VALUES (?, 'RETCORP', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.ownerId, mockContext.ownerName);

    db.prepare(`
      INSERT OR IGNORE INTO warehouses (id, owner_id, code, name, status, created_at, updated_at)
      VALUES (?, ?, 'WH-RET', ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.warehouseId, mockContext.ownerId, mockContext.warehouseName);

    db.prepare(`
      INSERT OR IGNORE INTO customers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES ('cust-ret-1', ?, 'C-001', 'Pelanggan Setia Jaya', 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.ownerId);

    db.prepare(`
      INSERT OR IGNORE INTO suppliers (id, owner_id, code, name, status, created_at, updated_at)
      VALUES ('supp-ret-1', ?, 'S-001', 'Supplier Prima Abadi', 'ACTIVE', datetime('now'), datetime('now'))
    `).run(mockContext.ownerId);
  });

  it('1. Customer Return: Serial Mandiri (Baik -> AVAILABLE, Rusak -> QUARANTINE, ledger + mutasi)', () => {
    const pId = `prod-sn-mandiri-${Date.now()}`;
    const sku1 = `SKU-MAN-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Mouse Wireless Office', 'Elektronik', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku1);

    // Goods In: 2 serials
    const sn1 = `SN-MANDIRI-${Date.now()}-1`;
    const sn2 = `SN-MANDIRI-${Date.now()}-2`;
    const sId1 = `sid-1-${Date.now()}`;
    const sId2 = `sid-2-${Date.now()}`;

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now')),
             (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
    `).run(sId1, mockContext.ownerId, mockContext.warehouseId, pId, sn1, sn1, sId2, mockContext.ownerId, mockContext.warehouseId, pId, sn2, sn2);

    // Goods In Ledger: +2
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 1, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'gi-1', 'gil-1', 2, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, mockContext.userId);

    // Kirim via Goods Out (COMPLETED): sn1 & sn2 jadi CONSUMED_OUT, ledger -2
    const goId = `go-man-${Date.now()}`;
    const goLineId = `gol-man-${Date.now()}`;
    const goNum1 = `DO-MAN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_out (id, owner_id, warehouse_id, customer_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'cust-ret-1', ?, '2026-10-26', 'COMPLETED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(goId, mockContext.ownerId, mockContext.warehouseId, goNum1, mockContext.userId);

    db.prepare(`
      INSERT INTO goods_out_lines (id, goods_out_id, product_id, quantity, unit, allocated_serials_json, created_at)
      VALUES (?, ?, ?, 2, 'pcs', ?, datetime('now'))
    `).run(goLineId, goId, pId, JSON.stringify([sn1, sn2]));

    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE id IN (?, ?)`).run(sId1, sId2);
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 2, ?, ?, ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', ?, ?, -2, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, goId, goLineId, mockContext.userId);

    // Saldo fisik sebelum retur = 0
    let balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 0);

    // Ajukan Retur: sn1 (BAIK), sn2 (RUSAK)
    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      goodsOutId: goId,
      returnNumber: `RET-MAN-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'CACAT',
      lines: [
        { productId: pId, quantity: 1, unit: 'pcs', condition: 'BAIK', returnedSerials: [sn1] },
        { productId: pId, quantity: 1, unit: 'pcs', condition: 'RUSAK', returnedSerials: [sn2] },
      ],
    });

    assert.strictEqual(retRecord.status, 'DRAFT');

    // Approve & Receive Return
    const receiveRes = repo.approveAndReceiveInventoryReturn(mockContext, retRecord.id);
    assert.strictEqual(receiveRes.received, true);

    // Verifikasi Status Serial: sn1 AVAILABLE, sn2 QUARANTINE
    const ps1 = db.prepare(`SELECT status FROM product_serials WHERE id = ?`).get(sId1) as any;
    const ps2 = db.prepare(`SELECT status FROM product_serials WHERE id = ?`).get(sId2) as any;
    assert.strictEqual(ps1.status, 'AVAILABLE');
    assert.strictEqual(ps2.status, 'QUARANTINE');

    // Verifikasi Saldo Ledger bertambah +2
    balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 2);

    // Verifikasi status return pada Goods Out menjadi FULL
    const goRow = db.prepare(`SELECT return_status FROM goods_out WHERE id = ?`).get(goId) as any;
    assert.strictEqual(goRow.return_status, 'FULL');
  });

  it('2. Customer Return: Group Utuh (WHOLE_GROUP -> Group AVAILABLE, Anak GROUPED, Ledger bertambah total pcs)', () => {
    const pId = `prod-sn-grp-${Date.now()}`;
    const sku2 = `SKU-GRP-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Baju Kemeja Premium', 'Pakaian', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku2);

    // Buat 12 serial @ 1 pcs
    const serialIds: string[] = [];
    const serialNumbers: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const sId = `sid-grp-${Date.now()}-${i}`;
      const snStr = `SN-GRP-MEM-${Date.now()}-${i}`;
      serialIds.push(sId);
      serialNumbers.push(snStr);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    // Goods In ledger: 12 pcs
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 10, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'gi-grp', 'gil-grp', 12, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, mockContext.userId);

    // Grouping 12 pcs menjadi 1 lusin
    const groupRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId,
      groups: [
        {
          groupName: 'Karton Kemeja A',
          unit: 'lusin',
          serialIds,
        },
      ],
    });
    const createdGroup = groupRes.createdGroups[0];
    assert.strictEqual(createdGroup.status, 'AVAILABLE');

    // Goods Out 1 lusin (Group)
    const goId = `go-grp-${Date.now()}`;
    const goLineId = `gol-grp-${Date.now()}`;
    const goNum2 = `DO-GRP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_out (id, owner_id, warehouse_id, customer_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'cust-ret-1', ?, '2026-10-26', 'COMPLETED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(goId, mockContext.ownerId, mockContext.warehouseId, goNum2, mockContext.userId);

    db.prepare(`
      INSERT INTO goods_out_lines (id, goods_out_id, product_id, quantity, unit, group_id, group_serials_snapshot_json, created_at)
      VALUES (?, ?, ?, 1, 'lusin', ?, ?, datetime('now'))
    `).run(goLineId, goId, pId, createdGroup.id, JSON.stringify(serialIds));

    // Mark group & children as CONSUMED_OUT, ledger -12
    db.prepare(`UPDATE serial_groupings SET status = 'CONSUMED_OUT' WHERE id = ?`).run(createdGroup.id);
    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE serial_number = ? AND is_group = 1`).run(createdGroup.groupNumber);
    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE parent_group_id = ?`).run(createdGroup.id);
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 11, ?, ?, ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', ?, ?, -12, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, goId, goLineId, mockContext.userId);

    let balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 0);

    // Customer mengembalikan 1 box group UTUH (WHOLE_GROUP)
    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      goodsOutId: goId,
      returnNumber: `RET-GRP-WHOLE-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'PEMBATALAN',
      lines: [
        {
          productId: pId,
          quantity: 1,
          unit: 'lusin',
          condition: 'BAIK',
          groupId: createdGroup.id,
          groupReturnMode: 'WHOLE_GROUP',
        },
      ],
    });

    const approveRes = repo.approveAndReceiveInventoryReturn(mockContext, retRecord.id);
    assert.strictEqual(approveRes.received, true);

    // Verifikasi: Wadah group kembali AVAILABLE
    const grpRow = db.prepare(`SELECT status FROM serial_groupings WHERE id = ?`).get(createdGroup.id) as any;
    assert.strictEqual(grpRow.status, 'AVAILABLE');

    // Verifikasi: Serial group di product_serials AVAILABLE
    const grpSerial = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ? AND is_group = 1`).get(createdGroup.groupNumber) as any;
    assert.strictEqual(grpSerial.status, 'AVAILABLE');

    // Verifikasi: Seluruh 12 anak serial kembali GROUPED dengan parent_group_id terikat
    const children = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE parent_group_id = ?`).all(createdGroup.id) as any[];
    assert.strictEqual(children.length, 12);
    assert.ok(children.every((c) => c.status === 'GROUPED'));

    // Verifikasi: Ledger bertambah +12 pcs (total_base_qty_pcs)
    balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 12);
  });

  it('3. Customer Return: Group Eceran (ECERAN_DISSOLVE -> Group DISSOLVED, Serial kembali AVAILABLE, yg tidak kembali CONSUMED_OUT)', () => {
    const pId = `prod-sn-eceran-${Date.now()}`;
    const sku3 = `SKU-ECE-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Panci Set 4-in-1', 'Dapur', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku3);

    // 4 serial @ 1 pcs
    const sIds: string[] = [];
    const sns: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const sId = `sid-ece-${Date.now()}-${i}`;
      const snStr = `SN-ECE-${Date.now()}-${i}`;
      sIds.push(sId);
      sns.push(snStr);
      db.prepare(`
        INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
      `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, snStr, snStr);
    }

    // Goods In ledger: +4
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 20, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'gi-ece', 'gil-ece', 4, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, mockContext.userId);

    // Grouping 4 pcs
    const groupRes = repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId,
      groups: [
        {
          groupName: 'Bundle Panci 4',
          unit: 'pcs',
          serialIds: sIds,
        },
      ],
    });
    const grp = groupRes.createdGroups[0];

    // Keluar via Goods Out: -4
    const goId = `go-ece-${Date.now()}`;
    const goLineId = `gol-ece-${Date.now()}`;
    const goNum3 = `DO-ECE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_out (id, owner_id, warehouse_id, customer_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'cust-ret-1', ?, '2026-10-26', 'COMPLETED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(goId, mockContext.ownerId, mockContext.warehouseId, goNum3, mockContext.userId);

    db.prepare(`
      INSERT INTO goods_out_lines (id, goods_out_id, product_id, quantity, unit, group_id, group_serials_snapshot_json, created_at)
      VALUES (?, ?, ?, 4, 'pcs', ?, ?, datetime('now'))
    `).run(goLineId, goId, pId, grp.id, JSON.stringify(sIds));

    db.prepare(`UPDATE serial_groupings SET status = 'CONSUMED_OUT' WHERE id = ?`).run(grp.id);
    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE serial_number = ? AND is_group = 1`).run(grp.groupNumber);
    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE parent_group_id = ?`).run(grp.id);
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 21, ?, ?, ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', ?, ?, -4, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, goId, goLineId, mockContext.userId);

    // Retur ECERAN: Hanya 2 serial yang dikembalikan (sns[0], sns[1]), 2 lainnya tetap di customer
    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      goodsOutId: goId,
      returnNumber: `RET-ECE-PART-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'SALAH_KIRIM',
      lines: [
        {
          productId: pId,
          quantity: 2,
          unit: 'pcs',
          condition: 'BAIK',
          groupId: grp.id,
          groupReturnMode: 'ECERAN_DISSOLVE',
          returnedSerials: [sns[0], sns[1]],
        },
      ],
    });

    const approveRes = repo.approveAndReceiveInventoryReturn(mockContext, retRecord.id);
    assert.strictEqual(approveRes.received, true);

    // Verifikasi: Group status menjadi DISSOLVED
    const grpRow = db.prepare(`SELECT status FROM serial_groupings WHERE id = ?`).get(grp.id) as any;
    assert.strictEqual(grpRow.status, 'DISSOLVED');

    // Verifikasi: Serial header group menjadi DECOMMISSIONED
    const headerSerial = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ? AND is_group = 1`).get(grp.groupNumber) as any;
    assert.strictEqual(headerSerial.status, 'DECOMMISSIONED');

    // Verifikasi: Serial yang kembali (sIds[0], sIds[1]) menjadi AVAILABLE & parent_group_id null
    const retS1 = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE id = ?`).get(sIds[0]) as any;
    const retS2 = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE id = ?`).get(sIds[1]) as any;
    assert.strictEqual(retS1.status, 'AVAILABLE');
    assert.strictEqual(retS1.parent_group_id, null);
    assert.strictEqual(retS2.status, 'AVAILABLE');
    assert.strictEqual(retS2.parent_group_id, null);

    // Verifikasi: Serial yang TIDAK kembali (sIds[2], sIds[3]) tetap CONSUMED_OUT & parent_group_id null
    const notRetS3 = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE id = ?`).get(sIds[2]) as any;
    const notRetS4 = db.prepare(`SELECT status, parent_group_id FROM product_serials WHERE id = ?`).get(sIds[3]) as any;
    assert.strictEqual(notRetS3.status, 'CONSUMED_OUT');
    assert.strictEqual(notRetS3.parent_group_id, null);
    assert.strictEqual(notRetS4.status, 'CONSUMED_OUT');
    assert.strictEqual(notRetS4.parent_group_id, null);

    // Verifikasi Ledger bertambah +2
    const balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 2);
  });

  it('4. Supplier Return: Validasi Guard Serial (Wajib AVAILABLE & Tidak Terikat di Group Aktif)', () => {
    const pId = `prod-sn-supp-guard-${Date.now()}`;
    const sku4 = `SKU-SUPP-G-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Monitor LED 24 Inch', 'Komputer', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku4);

    // sn1: CONSUMED_OUT (sudah keluar)
    const snOut = `SN-OUT-${Date.now()}`;
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, snOut, snOut);

    // Coba retur sn yang statusnya bukan AVAILABLE -> WAJIB DITOLAK
    assert.throws(
      () => {
        repo.createInventoryReturn(mockContext, {
          warehouseId: mockContext.warehouseId,
          returnType: 'SUPPLIER_RETURN',
          supplierId: 'supp-ret-1',
          returnNumber: `RET-SUPP-ERR-${Date.now()}`,
          returnDate: '2026-10-26',
          reason: 'CACAT',
          lines: [{ productId: pId, quantity: 1, condition: 'RUSAK', returnedSerials: [snOut] }],
        });
      },
      (err: any) => err.code === RETURN_ERROR_CODES.SERIAL_NOT_AVAILABLE
    );

    // Buat 2 serial AVAILABLE lalu masukkan ke Group Aktif
    const s1 = `sid-gact-${Date.now()}-1`;
    const s2 = `sid-gact-${Date.now()}-2`;
    const snG1 = `SN-GACT-${Date.now()}-1`;
    const snG2 = `SN-GACT-${Date.now()}-2`;
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now')),
             (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
    `).run(s1, mockContext.ownerId, mockContext.warehouseId, pId, snG1, snG1, s2, mockContext.ownerId, mockContext.warehouseId, pId, snG2, snG2);

    repo.createSerialGroupsBatch(mockContext, {
      warehouseId: mockContext.warehouseId,
      groups: [{ groupName: 'Group Monitor', unit: 'pcs', serialIds: [s1, s2] }],
    });

    // Coba retur serial yang terikat dalam group aktif -> WAJIB DITOLAK (SERIAL_IN_ACTIVE_GROUP)
    assert.throws(
      () => {
        repo.createInventoryReturn(mockContext, {
          warehouseId: mockContext.warehouseId,
          returnType: 'SUPPLIER_RETURN',
          supplierId: 'supp-ret-1',
          returnNumber: `RET-SUPP-GRP-ERR-${Date.now()}`,
          returnDate: '2026-10-26',
          reason: 'CACAT',
          lines: [{ productId: pId, quantity: 1, condition: 'RUSAK', returnedSerials: [snG1] }],
        });
      },
      (err: any) => err.code === RETURN_ERROR_CODES.SERIAL_IN_ACTIVE_GROUP
    );
  });

  it('5. Supplier Return Sukses: Mutasi Negatif RETURN_OUT_POSTED, Serial -> RETURNED_TO_SUPPLIER', () => {
    const pId = `prod-sn-supp-ok-${Date.now()}`;
    const sku5 = `SKU-SUPP-OK-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Keyboard Mechanical', 'Komputer', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku5);

    // Goods In: 3 pcs
    const sn1 = `SN-KBD-${Date.now()}-1`;
    const sn2 = `SN-KBD-${Date.now()}-2`;
    const sn3 = `SN-KBD-${Date.now()}-3`;
    const giId = `gi-supp-${Date.now()}`;

    const giNum4 = `GI-KBD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_in (id, owner_id, warehouse_id, supplier_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'supp-ret-1', ?, '2026-10-26', 'POSTED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(giId, mockContext.ownerId, mockContext.warehouseId, giNum4, mockContext.userId);

    db.prepare(`
      INSERT INTO goods_in_lines (id, goods_in_id, product_id, quantity, unit, received_serials_json, created_at)
      VALUES (?, ?, ?, 3, 'pcs', ?, datetime('now'))
    `).run(crypto.randomUUID(), giId, pId, JSON.stringify([sn1, sn2, sn3]));

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, source_goods_in_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, ?, datetime('now'), datetime('now')),
             (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, ?, datetime('now'), datetime('now')),
             (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, ?, datetime('now'), datetime('now'))
    `).run(
      crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, sn1, sn1, giId,
      crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, sn2, sn2, giId,
      crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, sn3, sn3, giId
    );

    // Goods In ledger: +3
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 30, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', ?, 'gil-kbd', 3, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, giId, mockContext.userId);

    let balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 3);

    // Retur 2 unit cacat ke supplier (sn1 & sn2)
    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'SUPPLIER_RETURN',
      supplierId: 'supp-ret-1',
      goodsInId: giId,
      returnNumber: `RET-SUPP-SUKSES-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'CACAT',
      lines: [{ productId: pId, quantity: 2, condition: 'RUSAK', returnedSerials: [sn1, sn2] }],
    });

    const approveRes = repo.approveAndReceiveInventoryReturn(mockContext, retRecord.id);
    assert.strictEqual(approveRes.received, true);

    // Verifikasi Serial menjadi RETURNED_TO_SUPPLIER
    const ps1 = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn1) as any;
    const ps2 = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn2) as any;
    const ps3 = db.prepare(`SELECT status FROM product_serials WHERE serial_number = ?`).get(sn3) as any;
    assert.strictEqual(ps1.status, 'RETURNED_TO_SUPPLIER');
    assert.strictEqual(ps2.status, 'RETURNED_TO_SUPPLIER');
    assert.strictEqual(ps3.status, 'AVAILABLE');

    // Verifikasi Saldo Ledger berkurang -2 (sisa 1 pcs)
    balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 1);

    // Verifikasi Goods In return_status menjadi PARTIAL
    const giRow = db.prepare(`SELECT return_status FROM goods_in WHERE id = ?`).get(giId) as any;
    assert.strictEqual(giRow.return_status, 'PARTIAL');
  });

  it('6. Revert Retur (Pembatalan Retur yang Sudah Selesai) & Invariant Rollback', () => {
    const pId = `prod-sn-revert-${Date.now()}`;
    const sku6 = `SKU-REV-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Router Wi-Fi 6', 'Jaringan', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku6);

    const sn = `SN-REV-${Date.now()}`;
    const sId = `sid-rev-${Date.now()}`;
    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
    `).run(sId, mockContext.ownerId, mockContext.warehouseId, pId, sn, sn);

    // Initial Goods In: +1
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 40, ?, ?, ?, NULL, 'GOODS_IN_POSTED', 'GOODS_IN', 'gi-rev', 'gil-rev', 1, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, mockContext.userId);

    // Goods Out: -1
    const goId = `go-rev-${Date.now()}`;
    const goNum6 = `DO-REV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_out (id, owner_id, warehouse_id, customer_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'cust-ret-1', ?, '2026-10-26', 'COMPLETED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(goId, mockContext.ownerId, mockContext.warehouseId, goNum6, mockContext.userId);
    db.prepare(`
      INSERT INTO goods_out_lines (id, goods_out_id, product_id, quantity, unit, allocated_serials_json, created_at)
      VALUES (?, ?, ?, 1, 'pcs', ?, datetime('now'))
    `).run(crypto.randomUUID(), goId, pId, JSON.stringify([sn]));
    db.prepare(`UPDATE product_serials SET status = 'CONSUMED_OUT' WHERE id = ?`).run(sId);
    db.prepare(`
      INSERT INTO inventory_ledger (id, sequence_number, owner_id, warehouse_id, product_id, location_id, entry_type, source_doc_type, source_doc_id, source_line_id, quantity_delta_base, actor_user_id, occurred_at, created_at)
      VALUES (?, 41, ?, ?, ?, NULL, 'GOODS_OUT_COMPLETED', 'GOODS_OUT', ?, 'gol-rev', -1, ?, datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), mockContext.ownerId, mockContext.warehouseId, pId, goId, mockContext.userId);

    // Customer Return: +1
    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      goodsOutId: goId,
      returnNumber: `RET-REV-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'SALAH_KIRIM',
      lines: [{ productId: pId, quantity: 1, unit: 'pcs', condition: 'BAIK', returnedSerials: [sn] }],
    });
    repo.approveAndReceiveInventoryReturn(mockContext, retRecord.id);

    // Saldo setelah retur = 1, status serial = AVAILABLE
    let balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 1);
    let ps = db.prepare(`SELECT status FROM product_serials WHERE id = ?`).get(sId) as any;
    assert.strictEqual(ps.status, 'AVAILABLE');

    // REVERT RETUR (Tidak jadi retur / salah input)
    const revertRes = repo.revertReceivedInventoryReturn(mockContext, {
      returnId: retRecord.id,
      reason: 'Salah konfirmasi penerimaan fisik retur',
    });
    assert.strictEqual(revertRes.reverted, true);

    // Verifikasi Invariant: Saldo kembali 0 (seperti sebelum retur)
    balance = reconstructStockBalance(getLedger(), [], mockContext.ownerId, mockContext.warehouseId, pId);
    assert.strictEqual(balance.physicalStock, 0);

    // Verifikasi Serial kembali ke CONSUMED_OUT
    ps = db.prepare(`SELECT status FROM product_serials WHERE id = ?`).get(sId) as any;
    assert.strictEqual(ps.status, 'CONSUMED_OUT');

    // Verifikasi entri kompensasi RETURN_REVERSAL_POSTED tercatat di ledger
    const reversalLedger = db.prepare(`
      SELECT entry_type, quantity_delta_base FROM inventory_ledger WHERE source_doc_id = ? AND entry_type = 'RETURN_REVERSAL_POSTED'
    `).get(retRecord.id) as any;
    assert.ok(reversalLedger);
    assert.strictEqual(Number(reversalLedger.quantity_delta_base), -1);

    // Guard Revert: Mencoba revert retur yang sudah CANCELLED wajib ditolak
    assert.throws(
      () => {
        repo.revertReceivedInventoryReturn(mockContext, { returnId: retRecord.id });
      },
      (err: any) => err.code === RETURN_ERROR_CODES.CANNOT_REVERT
    );
  });

  it('7. Cancel Draft Return: Batal tanpa mutasi ledger', () => {
    const pId = `prod-cancel-draft-${Date.now()}`;
    const sku7 = `SKU-CND-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Kabel LAN Cat 6', 'Jaringan', 'NON_SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku7);

    const retRecord = repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      returnNumber: `RET-DRAFT-CANCEL-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'PEMBATALAN',
      lines: [{ productId: pId, quantity: 5, unit: 'pcs', condition: 'BAIK' }],
    });

    const ledgerBefore = getLedger().length;
    const cancelRes = repo.cancelDraftInventoryReturn(mockContext, retRecord.id, 'Dibatalkan pelanggan sebelum dikirim');
    assert.strictEqual(cancelRes.cancelled, true);

    const retRow = db.prepare(`SELECT status FROM inventory_returns WHERE id = ?`).get(retRecord.id) as any;
    assert.strictEqual(retRow.status, 'CANCELLED');

    const ledgerAfter = getLedger().length;
    assert.strictEqual(ledgerAfter, ledgerBefore, 'Batal draft tidak boleh menambah baris ledger');
  });

  it('8. getReturnableSerials: Query serial returnable akurat untuk Goods Out dan Goods In', () => {
    const pId = `prod-ret-query-${Date.now()}`;
    const sku8 = `SKU-RET-Q-${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO products (id, owner_id, warehouse_id, sku, name, category, tracking_mode, unit, min_stock, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Barcode Scanner 2D', 'Elektronik', 'SERIAL', 'pcs', 1, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(pId, mockContext.ownerId, mockContext.warehouseId, sku8);

    const snQ1 = `SN-Q-${Date.now()}-1`;
    const snQ2 = `SN-Q-${Date.now()}-2`;
    const sIdQ1 = `sid-q1-${Date.now()}`;
    const sIdQ2 = `sid-q2-${Date.now()}`;

    const goId = `go-ret-q-${Date.now()}`;
    const goNum8 = `DO-RET-Q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
      INSERT INTO goods_out (id, owner_id, warehouse_id, customer_id, document_number, document_date, status, return_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'cust-ret-1', ?, '2026-10-26', 'COMPLETED', 'NONE', ?, datetime('now'), datetime('now'))
    `).run(goId, mockContext.ownerId, mockContext.warehouseId, goNum8, mockContext.userId);

    db.prepare(`
      INSERT INTO goods_out_lines (id, goods_out_id, product_id, quantity, unit, allocated_serials_json, created_at)
      VALUES (?, ?, ?, 2, 'pcs', ?, datetime('now'))
    `).run(crypto.randomUUID(), goId, pId, JSON.stringify([snQ1, snQ2]));

    db.prepare(`
      INSERT INTO product_serials (id, owner_id, warehouse_id, product_id, serial_number, normalized_serial_number, status, unit, unit_quantity, base_quantity, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, datetime('now'), datetime('now')),
             (?, ?, ?, ?, ?, ?, 'CONSUMED_OUT', 'pcs', 1, 1, 0, datetime('now'), datetime('now'))
    `).run(sIdQ1, mockContext.ownerId, mockContext.warehouseId, pId, snQ1, snQ1, sIdQ2, mockContext.ownerId, mockContext.warehouseId, pId, snQ2, snQ2);

    // Ambil returnable serials untuk Goods Out ini -> harus mengembalikan 2 serial
    let returnable = repo.getReturnableSerials(mockContext, { goodsOutId: goId });
    assert.strictEqual(returnable.length, 2);

    // Buat retur untuk snQ1
    repo.createInventoryReturn(mockContext, {
      warehouseId: mockContext.warehouseId,
      returnType: 'CUSTOMER_RETURN',
      customerId: 'cust-ret-1',
      goodsOutId: goId,
      returnNumber: `RET-Q-PART-${Date.now()}`,
      returnDate: '2026-10-26',
      reason: 'SALAH_KIRIM',
      lines: [{ productId: pId, quantity: 1, unit: 'pcs', condition: 'BAIK', returnedSerials: [snQ1] }],
    });

    // Query ulang -> snQ1 sudah terikat di retur aktif, sisa returnable harus tinggal snQ2
    returnable = repo.getReturnableSerials(mockContext, { goodsOutId: goId });
    assert.strictEqual(returnable.length, 1);
    assert.strictEqual(returnable[0].serialNumber, snQ2);
  });
});

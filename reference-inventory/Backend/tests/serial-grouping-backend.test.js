import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGroupingUnitAndQuantity,
  calculateGroupingCosts,
  createSerialGroup,
  ungroupSerial,
  previewSerialGroup,
  getSerialGroupingDetails,
  listSerialGroupings,
  getAvailableSerialsForGrouping,
  CANONICAL_MULTIPLIERS,
} from '../src/services/serialGroup.service.js';
import { calculateDocumentStockMovements } from '../../frontend-new/src/utils/stockCalculation.js';

/**
 * In-memory Mock Supabase Client for backend integration tests
 */
function createMockSupabase(initialData = {}) {
  const store = {
    products: [...(initialData.products || [])].map((p) => ({ ...p })),
    product_serials: [...(initialData.product_serials || [])].map((s) => ({ ...s, metadata: { ...(s.metadata || {}) } })),
    documents: [...(initialData.documents || [])].map((d) => ({ ...d, metadata: { ...(d.metadata || {}) } })),
    document_items: [...(initialData.document_items || [])].map((i) => ({ ...i, metadata: { ...(i.metadata || {}) } })),
    serial_groupings: [...(initialData.serial_groupings || [])].map((g) => ({ ...g, metadata: { ...(g.metadata || {}) } })),
    serial_grouping_components: [...(initialData.serial_grouping_components || [])].map((c) => ({ ...c, metadata: { ...(c.metadata || {}) } })),
  };

  const activeLocks = new Set();

  function buildQuery(tableName) {
    let rows = store[tableName] || [];
    let isSingle = false;
    let isMaybeSingle = false;
    let selectedFields = null;

    const builder = {
      select(fields) {
        selectedFields = fields;
        return builder;
      },
      is(col, val) {
        if (val === null) {
          rows = rows.filter((r) => r[col] === null || r[col] === undefined);
        } else {
          rows = rows.filter((r) => r[col] === val);
        }
        return builder;
      },
      eq(col, val) {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      neq(col, val) {
        rows = rows.filter((r) => r[col] !== val);
        return builder;
      },
      in(col, vals) {
        const valSet = new Set(vals);
        rows = rows.filter((r) => valSet.has(r[col]));
        return builder;
      },
      ilike(col, pattern) {
        const regexStr = pattern.replace(/%/g, '.*');
        const reg = new RegExp(regexStr, 'i');
        rows = rows.filter((r) => reg.test(String(r[col] || '')));
        return builder;
      },
      or(conditionStr) {
        return builder;
      },
      order(col, { ascending = true } = {}) {
        rows = [...rows].sort((a, b) => {
          if (a[col] < b[col]) return ascending ? -1 : 1;
          if (a[col] > b[col]) return ascending ? 1 : -1;
          return 0;
        });
        return builder;
      },
      range(from, to) {
        rows = rows.slice(from, to + 1);
        return builder;
      },
      limit(n) {
        rows = rows.slice(0, n);
        return builder;
      },
      single() {
        isSingle = true;
        return builder;
      },
      maybeSingle() {
        isMaybeSingle = true;
        return builder;
      },
      insert(payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((item, idx) => {
          const row = {
            id: item.id || `mock-${tableName}-${Date.now()}-${idx}`,
            created_at: new Date().toISOString(),
            ...item,
          };
          store[tableName].push(row);
          return row;
        });

        const insertBuilder = {
          select(fields) {
            return insertBuilder;
          },
          single() {
            return Promise.resolve({ data: inserted[0] || null, error: null });
          },
          maybeSingle() {
            return Promise.resolve({ data: inserted[0] || null, error: null });
          },
          then(resolve) {
            resolve({ data: Array.isArray(payload) ? inserted : inserted[0], error: null });
          },
        };

        return insertBuilder;
      },
      update(payload) {
        let targetRows = [...rows];
        let isSingleUpdate = isSingle;

        const updateBuilder = {
          eq(col, val) {
            targetRows = targetRows.filter((r) => r[col] === val);
            return updateBuilder;
          },
          neq(col, val) {
            targetRows = targetRows.filter((r) => r[col] !== val);
            return updateBuilder;
          },
          in(col, vals) {
            const valSet = new Set(vals);
            targetRows = targetRows.filter((r) => valSet.has(r[col]));
            return updateBuilder;
          },
          select(fields) {
            return updateBuilder;
          },
          single() {
            isSingleUpdate = true;
            return updateBuilder;
          },
          maybeSingle() {
            return updateBuilder;
          },
          then(resolve) {
            const updated = [];
            for (const r of targetRows) {
              Object.assign(r, payload, { updated_at: new Date().toISOString() });
              updated.push({ ...r });
            }
            resolve({ data: isSingleUpdate ? updated[0] : updated, error: null });
          },
        };

        return updateBuilder;
      },
      then(resolve, reject) {
        let resultData = rows.map((r) => {
          const copy = { ...r };
          // Expand product join if table is product_serials
          if (tableName === 'product_serials' && copy.product_id) {
            copy.product = store.products.find((p) => p.id === copy.product_id) || null;
          }
          return copy;
        });

        if (tableName === 'product_serials' && selectedFields && selectedFields.includes('products!inner')) {
          resultData = resultData.filter((r) => r.product !== null && r.product !== undefined);
        }

        if (isSingle) {
          if (resultData.length === 0) {
            resolve({ data: null, error: { message: 'Row not found', code: 'PGRST116' } });
            return;
          }
          resolve({ data: resultData[0], error: null });
          return;
        }

        if (isMaybeSingle) {
          resolve({ data: resultData.length > 0 ? resultData[0] : null, error: null });
          return;
        }

        resolve({ data: resultData, error: null });
      },
    };

    return builder;
  }

  return {
    store,
    activeLocks,
    from(tableName) {
      if (!store[tableName]) store[tableName] = [];
      return buildQuery(tableName);
    },
    async rpc(fnName, params) {
      if (fnName === 'create_serial_group_atomic') {
        const { p_owner_id, p_user_id, p_user_name, p_member_ids, p_group_serial_number, p_product_id, p_warehouse_id, p_metadata } = params;
        const count = Array.isArray(p_member_ids) ? p_member_ids.length : 0;
        if (p_member_ids === null || count < 2) {
          return { data: null, error: { message: 'MIN_MEMBERS_REQUIRED: Minimal harus memilih 2 nomor seri untuk membuat group.', code: 'P0001' } };
        }

        for (const id of p_member_ids) {
          if (activeLocks.has(id)) {
            return { data: null, error: { message: 'CONCURRENT_CONFLICT: Salah satu nomor seri sedang diproses oleh transaksi lain.', code: 'P0002' } };
          }
          activeLocks.add(id);
        }

        const newId = `grp-${Date.now()}`;
        const newGroup = {
          id: newId,
          owner_id: p_owner_id,
          product_id: p_product_id,
          warehouse_id: p_warehouse_id,
          serial_number: p_group_serial_number || `GRP-${Date.now()}`,
          status: 'available',
          metadata: {
            ...p_metadata,
            isGroup: true,
            pcsCount: p_metadata.totalPcs || 1,
          },
        };
        store.product_serials.push(newGroup);

        for (const id of p_member_ids) {
          const m = store.product_serials.find((s) => s.id === id);
          if (m) {
            m.metadata = {
              ...(m.metadata || {}),
              isGrouped: true,
              parentGroupId: newId,
              parentGroupSerialNumber: newGroup.serial_number,
            };
          }
        }

        return {
          data: {
            success: true,
            groupId: newId,
            groupSerialNumber: newGroup.serial_number,
            group: newGroup,
            memberCount: count,
            totalPcs: p_metadata.totalPcs || 1,
          },
          error: null,
        };
      }

      if (fnName === 'ungroup_serial_atomic') {
        const { p_owner_id, p_group_id, p_group_serial_number } = params;
        const group = store.product_serials.find(
          (s) => s.owner_id === p_owner_id && (s.id === p_group_id || s.serial_number === p_group_serial_number)
        );

        if (!group) {
          return { data: null, error: { message: 'Group tidak ditemukan', code: 'P0001' } };
        }

        if (group.metadata?.isDissolved) {
          return { data: null, error: { message: 'ALREADY_DISSOLVED: Group sudah pernah dibongkar sebelumnya.', code: 'P0002' } };
        }

        if (group.status !== 'available') {
          return { data: null, error: { message: `CANNOT_UNGROUP: Group tidak dapat dibongkar karena statusnya "${group.status}".`, code: 'P0003' } };
        }

        group.metadata.isDissolved = true;
        group.status = 'out';

        const released = [];
        for (const s of store.product_serials) {
          if (s.metadata?.parentGroupId === group.id) {
            delete s.metadata.isGrouped;
            delete s.metadata.parentGroupId;
            delete s.metadata.parentGroupSerialNumber;
            released.push(s.serial_number);
          }
        }

        return {
          data: {
            success: true,
            unpackedGroupId: group.id,
            unpackedGroupSerialNumber: group.serial_number,
            releasedCount: released.length,
            releasedSerials: released,
          },
          error: null,
        };
      }

      return { data: null, error: { message: `RPC ${fnName} not handled`, code: '42883' } };
    },
  };
}

describe('Serial Grouping Backend & Ledger Suite — PHASE 3', () => {
  const mockTenantId = 'tenant-1111-1111-1111-111111111111';
  const mockWarehouseId = 'wh-2222-2222-2222-222222222222';
  const mockUserId = 'user-3333-3333-3333-333333333333';

  describe('1. Validasi Satuan & Kuantitas Presisi (Server-side)', () => {
    it('menghitung konversi satuan kanonikal secara akurat ke base pcs', () => {
      assert.equal(CANONICAL_MULTIPLIERS.pcs, 1);
      assert.equal(CANONICAL_MULTIPLIERS.lusin, 12);
      assert.equal(CANONICAL_MULTIPLIERS.pack, 60);
      assert.equal(CANONICAL_MULTIPLIERS.bal10, 120);
      assert.equal(CANONICAL_MULTIPLIERS.bal15, 180);
      assert.equal(CANONICAL_MULTIPLIERS.bal20, 240);
      assert.equal(CANONICAL_MULTIPLIERS.bal25, 300);
      assert.equal(CANONICAL_MULTIPLIERS.bal, 300);
    });

    it('menerima penggabungan jika total kuantitas komponen habis dibagi satuan target', () => {
      // 5 lusin (= 60 pcs) digabung menjadi 1 pack (= 60 pcs)
      const components = [
        { id: 's1', product_id: 'p1', productUnit: 'lusin', unitMultiplier: 12, effectivePcs: 24 }, // 2 lusin
        { id: 's2', product_id: 'p2', productUnit: 'lusin', unitMultiplier: 12, effectivePcs: 36 }, // 3 lusin
      ];
      const result = validateGroupingUnitAndQuantity({
        components,
        targetUnit: 'pack',
      });
      assert.equal(result.totalBaseQtyPcs, 60);
      assert.equal(result.targetMultiplier, 60);
      assert.equal(result.targetQty, 1);
      assert.equal(result.targetUnit, 'pack');
    });

    it('menolak penggabungan jika terdapat sisa/pecahan (UNIT_MISMATCH)', () => {
      // 2 lusin (24 pcs) + 1 lusin (12 pcs) = 36 pcs, mau dijadikan 1 pack (60 pcs) -> sisa 36 != 0
      const components = [
        { id: 's1', product_id: 'p1', productUnit: 'lusin', unitMultiplier: 12, effectivePcs: 24 },
        { id: 's2', product_id: 'p2', productUnit: 'lusin', unitMultiplier: 12, effectivePcs: 12 },
      ];
      assert.throws(
        () => {
          validateGroupingUnitAndQuantity({
            components,
            targetUnit: 'pack',
          });
        },
        (err) => {
          assert.equal(err.code, 'UNIT_MISMATCH');
          assert.match(err.message, /tidak dapat dibagi genap/i);
          return true;
        }
      );
    });

    it('menolak penggabungan jika satuan target tidak didukung (UNIT_CONVERSION_UNSUPPORTED)', () => {
      const components = [
        { id: 's1', product_id: 'p1', productUnit: 'pcs', unitMultiplier: 1, effectivePcs: 10 },
        { id: 's2', product_id: 'p1', productUnit: 'pcs', unitMultiplier: 1, effectivePcs: 10 },
      ];
      assert.throws(
        () => {
          validateGroupingUnitAndQuantity({
            components,
            targetUnit: 'kontainer_super',
          });
        },
        (err) => {
          assert.equal(err.code, 'UNIT_CONVERSION_UNSUPPORTED');
          assert.match(err.message, /tidak didukung/i);
          return true;
        }
      );
    });

    it('menolak penggabungan komponen jika satuan komponen tidak didukung', () => {
      const components = [
        { id: 's1', product_id: 'p1', productUnit: 'satuan_asing', unitMultiplier: 0, effectivePcs: 10 },
        { id: 's2', product_id: 'p1', productUnit: 'pcs', unitMultiplier: 1, effectivePcs: 10 },
      ];
      assert.throws(
        () => {
          validateGroupingUnitAndQuantity({
            components,
            targetUnit: 'pack',
          });
        },
        (err) => {
          assert.equal(err.code, 'UNIT_CONVERSION_UNSUPPORTED');
          return true;
        }
      );
    });
  });

  describe('2. Perhitungan HPP & Snapshot Costing Komponen', () => {
    it('menghitung HPP total dan HPP unit hasil grouping secara proporsional', () => {
      const components = [
        // Prod 1: HPP per lusin Rp 120.000 (12 pcs) -> Rp 10.000/pcs. Komponen 2 lusin = 24 pcs -> Rp 240.000
        {
          id: 'sn-1',
          product_id: 'p1',
          product: { name: 'Kaus Kaki Hitam', sku: 'SOCK-BLK', unit: 'lusin', unit_cost: 120000 },
          productUnit: 'lusin',
          unitMultiplier: 12,
          effectivePcs: 24,
          isGroup: false,
        },
        // Prod 2: HPP per pcs Rp 15.000. Komponen 36 pcs -> Rp 540.000
        {
          id: 'sn-2',
          product_id: 'p2',
          product: { name: 'Kaus Kaki Putih', sku: 'SOCK-WHT', unit: 'pcs', unit_cost: 15000 },
          productUnit: 'pcs',
          unitMultiplier: 1,
          effectivePcs: 36,
          isGroup: false,
        },
      ];

      const costInfo = calculateGroupingCosts({
        components,
        targetQty: 1, // 1 pack (60 pcs)
      });

      assert.equal(costInfo.totalCost, 780000); // 240.000 + 540.000
      assert.equal(costInfo.resultUnitCost, 780000);
      assert.equal(costInfo.componentSnapshots.length, 2);

      const snap1 = costInfo.componentSnapshots.find((s) => s.serialId === 'sn-1');
      assert.equal(snap1.costPerPcs, 10000);
      assert.equal(snap1.totalCost, 240000);

      const snap2 = costInfo.componentSnapshots.find((s) => s.serialId === 'sn-2');
      assert.equal(snap2.costPerPcs, 15000);
      assert.equal(snap2.totalCost, 540000);
    });

    it('menggunakan totalCost dari metadata sub-group jika komponen adalah nested group', () => {
      const components = [
        // Sub-group bernilai total Rp 300.000 untuk 30 pcs
        {
          id: 'grp-sub',
          product_id: 'p-bundle',
          product: { name: 'Sub Bundle', sku: 'BNDL-SUB', unit: 'pack', unit_cost: 0 },
          productUnit: 'pack',
          unitMultiplier: 60,
          effectivePcs: 30,
          isGroup: true,
          metadata: { totalCost: 300000 },
        },
        // Single component 30 pcs, Rp 10.000/pcs -> Rp 300.000
        {
          id: 'sn-3',
          product_id: 'p3',
          product: { name: 'Aksesoris', sku: 'ACC-01', unit: 'pcs', unit_cost: 10000 },
          productUnit: 'pcs',
          unitMultiplier: 1,
          effectivePcs: 30,
          isGroup: false,
        },
      ];

      const costInfo = calculateGroupingCosts({
        components,
        targetQty: 1,
      });

      assert.equal(costInfo.totalCost, 600000);
      assert.equal(costInfo.resultUnitCost, 600000);
    });
  });

  describe('3. Ledger Dokumen goods_assembly & Perhitungan Stok', () => {
    it('memastikan semantik calculateDocumentStockMovements untuk goods_assembly', () => {
      const doc = {
        id: 'doc-assembly-1',
        type: 'goods_assembly',
        status: 'approved',
        document_items: [
          {
            product_id: 'prod-black',
            quantity: 2,
            unit: 'lusin',
            movement_type: 'out',
            assembly_role: 'component',
            notes: 'Component for assembly',
          },
          {
            product_id: 'prod-white',
            quantity: 36,
            unit: 'pcs',
            movement_type: 'out',
            assembly_role: 'component',
            notes: 'Component for assembly',
          },
          {
            product_id: 'prod-combo',
            quantity: 1,
            unit: 'pack',
            movement_type: 'in',
            assembly_role: 'result',
            notes: 'Result of assembly',
          },
        ],
      };

      const multipliers = {
        lusin: 12,
        pcs: 1,
        pack: 60,
      };

      const movements = calculateDocumentStockMovements({ documents: [doc], multipliers });

      // Verifikasi komponen hitam keluar 24 pcs
      const blackMov = movements.get('prod-black');
      assert.equal(blackMov.out, 24);
      assert.equal(blackMov.in, 0);

      // Verifikasi komponen putih keluar 36 pcs
      const whiteMov = movements.get('prod-white');
      assert.equal(whiteMov.out, 36);
      assert.equal(whiteMov.in, 0);

      // Verifikasi produk combo masuk 60 pcs
      const comboMov = movements.get('prod-combo');
      assert.equal(comboMov.in, 60);
      assert.equal(comboMov.out, 0);
    });

    it('memastikan semantik calculateDocumentStockMovements untuk goods_disassembly', () => {
      const doc = {
        id: 'doc-disassembly-1',
        type: 'goods_disassembly',
        status: 'approved',
        document_items: [
          {
            product_id: 'prod-combo',
            quantity: 1,
            unit: 'pack',
            movement_type: 'out',
            assembly_role: 'result',
            notes: 'Result disassembled',
          },
          {
            product_id: 'prod-black',
            quantity: 2,
            unit: 'lusin',
            movement_type: 'in',
            assembly_role: 'component',
            notes: 'Restored component',
          },
          {
            product_id: 'prod-white',
            quantity: 36,
            unit: 'pcs',
            movement_type: 'in',
            assembly_role: 'component',
            notes: 'Restored component',
          },
        ],
      };

      const multipliers = {
        lusin: 12,
        pcs: 1,
        pack: 60,
      };

      const movements = calculateDocumentStockMovements({ documents: [doc], multipliers });

      // Verifikasi produk combo berkurang 60 pcs
      const comboMov = movements.get('prod-combo');
      assert.equal(comboMov.out, 60);
      assert.equal(comboMov.in, 0);

      // Verifikasi komponen kembali ke stok
      const blackMov = movements.get('prod-black');
      assert.equal(blackMov.in, 24);
      assert.equal(blackMov.out, 0);

      const whiteMov = movements.get('prod-white');
      assert.equal(whiteMov.in, 36);
      assert.equal(whiteMov.out, 0);
    });
  });

  describe('4. Alur createSerialGroup Lintas Produk, Ledger & Idempotensi', () => {
    let mockSupabase;

    beforeEach(() => {
      mockSupabase = createMockSupabase({
        products: [
          { id: 'p-1', owner_id: mockTenantId, name: 'Kemeja Katun', sku: 'KEM-01', unit: 'pcs', unit_cost: 50000 },
          { id: 'p-2', owner_id: mockTenantId, name: 'Dasi Sutra', sku: 'DASI-01', unit: 'pcs', unit_cost: 25000 },
          { id: 'p-combo', owner_id: mockTenantId, name: 'Paket Eksekutif', sku: 'PKT-EKS', unit: 'pcs', unit_cost: 0 },
        ],
        product_serials: [
          {
            id: 'sn-kem-1',
            owner_id: mockTenantId,
            product_id: 'p-1',
            warehouse_id: mockWarehouseId,
            serial_number: 'SN-KEM-001',
            status: 'available',
            metadata: { unit: 'pcs', pcsCount: 1, nestingDepth: 1 },
          },
          {
            id: 'sn-dasi-1',
            owner_id: mockTenantId,
            product_id: 'p-2',
            warehouse_id: mockWarehouseId,
            serial_number: 'SN-DASI-001',
            status: 'available',
            metadata: { unit: 'pcs', pcsCount: 1, nestingDepth: 1 },
          },
        ],
      });
    });

    it('menolak jika input mengandung nomor seri atau ID duplikat', async () => {
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId: mockTenantId,
            userId: mockUserId,
            memberSerialNumbers: ['SN-KEM-001', 'SN-KEM-001'],
            supabaseClient: mockSupabase,
          });
        },
        (err) => {
          assert.match(err.message, /duplikat/i);
          return true;
        }
      );
    });

    it('menolak jika anggota kurang dari 2 serial', async () => {
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId: mockTenantId,
            userId: mockUserId,
            memberSerialNumbers: ['SN-KEM-001'],
            supabaseClient: mockSupabase,
          });
        },
        (err) => {
          assert.match(err.message, /minimal.*2.*nomor seri/i);
          return true;
        }
      );
    });

    it('berhasil menggabungkan serial lintas produk (Kemeja + Dasi -> Paket Eksekutif) dan menerbitkan ledger', async () => {
      const result = await createSerialGroup({
        ownerId: mockTenantId,
        userId: mockUserId,
        userName: 'Admin Warehouse',
        memberSerialNumbers: ['SN-KEM-001', 'SN-DASI-001'],
        resultProductId: 'p-combo',
        targetUnit: 'pcs',
        warehouseId: mockWarehouseId,
        notes: 'Grouping Paket Eksekutif',
        idempotencyKey: 'idemp-tx-12345',
        supabaseClient: mockSupabase,
      });

      assert.equal(result.success, true);
      assert.equal(result.isCrossProduct, true);
      assert.equal(result.totalPcs, 2);
      assert.equal(result.directMemberCount, 2);
      assert.equal(result.totalCost, 75000); // 50.000 + 25.000
      assert.equal(result.resultUnitCost, 37500); // 75.000 / 2 pcs

      // Verifikasi dokumen ledger goods_assembly tercatat
      assert.ok(result.documentId);
      assert.match(result.documentNumber, /^(GA|ASM)-/);

      const assemblyDoc = mockSupabase.store.documents.find((d) => d.id === result.documentId);
      assert.ok(assemblyDoc);
      assert.equal(assemblyDoc.document_type || assemblyDoc.type, 'goods_assembly');
      assert.ok(assemblyDoc.status === 'completed' || assemblyDoc.status === 'approved');

      // Verifikasi document_items (2 komponen out, 1 result in)
      const items = mockSupabase.store.document_items.filter((i) => i.document_id === result.documentId);
      assert.equal(items.length, 3);

      const compItems = items.filter((i) => i.metadata?.assemblyRole === 'component');
      assert.equal(compItems.length, 2);
      assert.ok(compItems.every((i) => i.metadata?.movementType === 'out'));
      assert.ok(compItems.every((i) => i.metadata?.qtyUnit && i.metadata?.qtyInput));
      assert.ok(!('movement_type' in compItems[0]), 'movement_type top-level tidak boleh ada di document_items');

      const resultItem = items.find((i) => i.metadata?.assemblyRole === 'result');
      assert.ok(resultItem);
      assert.equal(resultItem.product_id, 'p-combo');
      assert.equal(resultItem.quantity, 2);
      assert.equal(resultItem.metadata?.qtyUnit, 'pcs');
      assert.equal(resultItem.metadata?.qtyInput, 2);
      assert.equal(resultItem.metadata?.movementType, 'in');

      // Verifikasi serial_groupings & serial_grouping_components
      const grpRow = mockSupabase.store.serial_groupings.find((g) => g.id === result.groupingRecord?.id);
      assert.ok(grpRow);
      assert.equal(grpRow.status, 'active');
      assert.equal(grpRow.idempotency_key, 'idemp-tx-12345');
      assert.equal(grpRow.total_cost, 75000);

      const compRows = mockSupabase.store.serial_grouping_components.filter((c) => c.grouping_id === grpRow.id);
      assert.equal(compRows.length, 2);

      // Idempotency Replay Test: Request kedua dengan idempotency_key yang sama harus me-replay tanpa menambah dokumen
      const replay = await createSerialGroup({
        ownerId: mockTenantId,
        userId: mockUserId,
        memberSerialNumbers: ['SN-KEM-001', 'SN-DASI-001'],
        resultProductId: 'p-combo',
        idempotencyKey: 'idemp-tx-12345',
        supabaseClient: mockSupabase,
      });

      assert.equal(replay.isReplay, true);
      assert.equal(replay.executionEngine, 'idempotent_replay');
      assert.equal(mockSupabase.store.documents.length, 1); // Tidak ada dokumen duplikat
    });

    it('berhasil membalikkan transaksi grouping melalui ungroupSerial (goods_disassembly)', async () => {
      // 1. Buat grouping terlebih dahulu
      const grouped = await createSerialGroup({
        ownerId: mockTenantId,
        userId: mockUserId,
        userName: 'Admin Warehouse',
        memberSerialNumbers: ['SN-KEM-001', 'SN-DASI-001'],
        resultProductId: 'p-combo',
        targetUnit: 'pcs',
        warehouseId: mockWarehouseId,
        supabaseClient: mockSupabase,
      });

      // 2. Lakukan ungroup (disassembly)
      const ungrouped = await ungroupSerial({
        ownerId: mockTenantId,
        userId: mockUserId,
        userName: 'Admin Warehouse',
        groupId: grouped.group.id,
        notes: 'Pembalikan group untuk retur',
        supabaseClient: mockSupabase,
      });

      assert.equal(ungrouped.success, true);
      assert.equal(ungrouped.releasedCount, 2);
      assert.ok(ungrouped.documentId);
      assert.match(ungrouped.documentNumber, /^GD-/);

      // Verifikasi dokumen goods_disassembly
      const disDoc = mockSupabase.store.documents.find((d) => d.id === ungrouped.documentId);
      assert.ok(disDoc);
      assert.equal(disDoc.document_type || disDoc.type, 'goods_disassembly');

      // Verifikasi status grouping menjadi dissolved
      const grpRow = mockSupabase.store.serial_groupings.find((g) => g.id === grouped.groupingRecord?.id);
      assert.equal(grpRow.status, 'dissolved');
      assert.equal(grpRow.reverse_document_id, ungrouped.documentId);

      // Verifikasi serial anggota kembali dilepas (isGrouped = false)
      const kemSerial = mockSupabase.store.product_serials.find((s) => s.serial_number === 'SN-KEM-001');
      assert.equal(kemSerial.metadata.isGrouped, undefined);

      const docsBefore = mockSupabase.store.documents.filter((d) => d.document_type === 'goods_disassembly').length;

      // Pembalikan kedua harus idempoten (replay), bukan membuat dokumen ganda
      // dan bukan pula mengekspos serial hasil sebagai stok aktif.
      const second = await ungroupSerial({
        ownerId: mockTenantId,
        userId: mockUserId,
        groupId: grouped.group.id,
        supabaseClient: mockSupabase,
      });

      assert.equal(second.success, true);
      assert.equal(second.isReplay, true);
      assert.equal(second.documentId, ungrouped.documentId, 'replay harus menunjuk dokumen reversal yang sama');

      const docsAfter = mockSupabase.store.documents.filter((d) => d.document_type === 'goods_disassembly').length;
      assert.equal(docsAfter, docsBefore, 'double ungroup tidak boleh membuat dokumen disassembly ganda');
    });
  });

  describe('5. Validasi Preview & Read Endpoints', () => {
    let mockSupabase;

    beforeEach(() => {
      mockSupabase = createMockSupabase({
        products: [
          { id: 'p-1', owner_id: mockTenantId, name: 'Kemeja Katun', sku: 'KEM-01', unit: 'pcs', unit_cost: 50000 },
          { id: 'p-2', owner_id: mockTenantId, name: 'Dasi Sutra', sku: 'DASI-01', unit: 'pcs', unit_cost: 25000 },
        ],
        product_serials: [
          {
            id: 'sn-kem-1',
            owner_id: mockTenantId,
            product_id: 'p-1',
            warehouse_id: mockWarehouseId,
            serial_number: 'SN-KEM-001',
            status: 'available',
            metadata: { unit: 'pcs', pcsCount: 1, nestingDepth: 1 },
          },
          {
            id: 'sn-dasi-1',
            owner_id: mockTenantId,
            product_id: 'p-2',
            warehouse_id: mockWarehouseId,
            serial_number: 'SN-DASI-001',
            status: 'available',
            metadata: { unit: 'pcs', pcsCount: 1, nestingDepth: 1 },
          },
        ],
      });
    });

    it('previewSerialGroup memvalidasi kelayakan grouping sebelum transaksi disimpan', async () => {
      // 1. Tolak serial duplikat
      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: mockTenantId,
            memberSerialNumbers: ['SN-A', 'SN-A'],
            supabaseClient: mockSupabase,
          });
        },
        (err) => {
          assert.match(err.message, /duplikat/i);
          return true;
        }
      );

      // 2. Preview sukses untuk 2 serial yang valid
      const preview = await previewSerialGroup({
        ownerId: mockTenantId,
        memberSerialNumbers: ['SN-KEM-001', 'SN-DASI-001'],
        targetUnit: 'pcs',
        supabaseClient: mockSupabase,
      });

      assert.equal(preview.isValid, true);
      assert.equal(preview.totalPcs, 2);
      assert.equal(preview.isCrossProduct, true);
      assert.equal(preview.totalCost, 75000);
      assert.equal(preview.directMembers.length, 2);
    });

    it('listSerialGroupings dan getSerialGroupingDetails membaca data grouping dengan benar', async () => {
      mockSupabase.store.serial_groupings.push({
        id: 'grp-tx-001',
        owner_id: mockTenantId,
        grouping_number: 'SGR-20261022-0001',
        status: 'completed',
        total_base_qty_pcs: 2,
        target_unit: 'pcs',
        target_qty: 2,
        total_cost: 75000,
        result_unit_cost: 37500,
        created_at: new Date().toISOString(),
      });

      mockSupabase.store.serial_grouping_components.push({
        id: 'comp-1',
        grouping_id: 'grp-tx-001',
        owner_id: mockTenantId,
        component_serial_number: 'SN-KEM-001',
        snapshot_product_name: 'Kemeja Katun',
        unit: 'pcs',
        unit_qty: 1,
        base_qty_pcs: 1,
        total_cost: 50000,
      });

      const list = await listSerialGroupings({
        ownerId: mockTenantId,
        supabaseClient: mockSupabase,
      });

      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'grp-tx-001');

      const detail = await getSerialGroupingDetails({
        ownerId: mockTenantId,
        groupingId: 'grp-tx-001',
        supabaseClient: mockSupabase,
      });

      assert.equal(detail.id, 'grp-tx-001');
      assert.equal(detail.components.length, 1);
      assert.equal(detail.components[0].component_serial_number, 'SN-KEM-001');
    });

    it('listSerialGroupings memfilter berdasarkan warehouseId dengan benar', async () => {
      mockSupabase.store.serial_groupings.push({
        id: 'grp-tx-wh-a',
        owner_id: mockTenantId,
        warehouse_id: 'wh-aaa',
        grouping_number: 'SGR-WH-A',
        status: 'completed',
        created_at: new Date().toISOString(),
      });
      mockSupabase.store.serial_groupings.push({
        id: 'grp-tx-wh-b',
        owner_id: mockTenantId,
        warehouse_id: 'wh-bbb',
        grouping_number: 'SGR-WH-B',
        status: 'completed',
        created_at: new Date().toISOString(),
      });

      const listA = await listSerialGroupings({
        ownerId: mockTenantId,
        warehouseId: 'wh-aaa',
        supabaseClient: mockSupabase,
      });

      assert.equal(listA.length, 1);
      assert.equal(listA[0].id, 'grp-tx-wh-a');
    });

    it('ungroupSerial menyelesaikan groupId yang merujuk pada id transaksi serial_groupings', async () => {
      // 1. Buat grouping
      const grouped = await createSerialGroup({
        ownerId: mockTenantId,
        userId: mockUserId,
        userName: 'Admin Warehouse',
        memberSerialIds: ['sn-kem-1', 'sn-dasi-1'],
        resultProductId: 'p-combo',
        targetUnit: 'pcs',
        warehouseId: mockWarehouseId,
        supabaseClient: mockSupabase,
      });

      assert.ok(grouped.groupingRecord);
      const groupingTxId = grouped.groupingRecord.id;

      // 2. Bongkar menggunakan id transaksi serial_groupings alih-alih id serial
      const ungrouped = await ungroupSerial({
        ownerId: mockTenantId,
        userId: mockUserId,
        groupId: groupingTxId, // Mengirim ID transaksi serial_groupings
        supabaseClient: mockSupabase,
      });

      assert.equal(ungrouped.success, true);
      assert.equal(ungrouped.releasedCount, 2);
    });

    it('createSerialGroup menggunakan resultProductSku kustom saat membuat master produk baru', async () => {
      const customSku = 'SKU-CUSTOM-GROUP-001';
      const grouped = await createSerialGroup({
        ownerId: mockTenantId,
        userId: mockUserId,
        memberSerialIds: ['sn-kem-1', 'sn-dasi-1'],
        createNewMasterProduct: true,
        resultProductName: 'Produk Paket Spesial',
        resultProductSku: customSku,
        targetUnit: 'pcs',
        warehouseId: mockWarehouseId,
        supabaseClient: mockSupabase,
      });

      assert.equal(grouped.success, true);
      const newProduct = mockSupabase.store.products.find((p) => p.sku === customSku);
      assert.ok(newProduct, 'Master produk baru dengan SKU kustom harus tercatat');
      assert.equal(newProduct.name, 'Produk Paket Spesial');
    });
  });

  describe('5. Bugfix: Validasi Sumber Data & Filter Serial Tersedia', () => {
    const tenantA = 'tenant-alpha';
    const tenantB = 'tenant-beta';
    const wh1 = 'wh-utama';
    const wh2 = 'wh-cabang';

    let testDb;

    beforeEach(() => {
      testDb = createMockSupabase({
        products: [
          { id: 'prod-1', owner_id: tenantA, name: 'Kemeja Katun', sku: 'KEM-01', unit: 'pcs', unit_cost: 50000, status: 'active' },
          { id: 'prod-2', owner_id: tenantA, name: 'Dasi Sutra', sku: 'DAS-01', unit: 'pcs', unit_cost: 25000, status: 'active' },
          { id: 'prod-b', owner_id: tenantB, name: 'Produk Tenant Lain', sku: 'OTH-01', unit: 'pcs', unit_cost: 10000, status: 'active' },
        ],
        product_serials: [
          // Produk 1: 4 serial tersedia di wh1
          { id: 'sn-p1-1', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-101020260001', status: 'available', warehouse_id: wh1, goods_out_document_id: null },
          { id: 'sn-p1-2', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-101020260002', status: 'available', warehouse_id: wh1, goods_out_document_id: null },
          { id: 'sn-p1-3', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-101020260003', status: 'available', warehouse_id: wh1, goods_out_document_id: null },
          { id: 'sn-p1-4', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-101020260004', status: 'available', warehouse_id: wh1, goods_out_document_id: null },

          // Serial dengan status 'out'
          { id: 'sn-p1-out', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-202610100001915', status: 'out', warehouse_id: wh1, goods_out_document_id: 'doc-out-1' },

          // Serial yang sudah tergabung (isGrouped / parentGroupId)
          { id: 'sn-p1-grouped', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-202610100003978', status: 'available', warehouse_id: wh1, metadata: { isGrouped: true, parentGroupId: 'grp-old-1' } },

          // Serial tanpa relasi produk valid (orphan)
          { id: 'sn-orphan', owner_id: tenantA, product_id: 'non-existent-prod', serial_number: 'TEST1-PACK-202610100004932', status: 'available', warehouse_id: wh1 },

          // Produk 2: 2 serial tersedia di wh1
          { id: 'sn-p2-1', owner_id: tenantA, product_id: 'prod-2', serial_number: 'DAS-101', status: 'available', warehouse_id: wh1, goods_out_document_id: null },
          { id: 'sn-p2-2', owner_id: tenantA, product_id: 'prod-2', serial_number: 'DAS-102', status: 'available', warehouse_id: wh1, goods_out_document_id: null },

          // Serial di gudang berbeda (wh2)
          { id: 'sn-p1-wh2', owner_id: tenantA, product_id: 'prod-1', serial_number: 'TEST1-PACK-WH2-01', status: 'available', warehouse_id: wh2, goods_out_document_id: null },

          // Serial tenant lain (Tenant B)
          { id: 'sn-tenant-b', owner_id: tenantB, product_id: 'prod-b', serial_number: 'SN-TENANT-B-01', status: 'available', warehouse_id: wh1, goods_out_document_id: null },
        ],
      });
    });

    it('1. Satu produk dengan tepat empat serial tersedia: modal yang difilter ke produk itu hanya menawarkan empat serial tersebut', async () => {
      const serials = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });

      assert.equal(serials.length, 4, 'Hanya 4 serial yang tersedia untuk prod-1 di wh1');
      assert.deepEqual(
        serials.map(s => s.serialNumber).sort(),
        [
          'TEST1-PACK-101020260001',
          'TEST1-PACK-101020260002',
          'TEST1-PACK-101020260003',
          'TEST1-PACK-101020260004',
        ].sort()
      );

      // Verifikasi metadata produk terisi dengan benar (bukan \'-\' atau Rp 0)
      for (const s of serials) {
        assert.equal(s.productName, 'Kemeja Katun');
        assert.equal(s.sku, 'KEM-01');
        assert.equal(s.unitCost, 50000);
        assert.ok(s.unit);
      }
    });

    it('2. Serial tambahan dengan status out / goods_out: tidak ditampilkan dan ditolak backend jika dikirim manual', async () => {
      const serials = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });

      const hasOut = serials.some(s => s.id === 'sn-p1-out' || s.serialNumber === 'TEST1-PACK-202610100001915');
      assert.equal(hasOut, false, 'Serial dengan status out tidak boleh ditampilkan dalam list');

      // Coba kirim manual ke previewSerialGroup
      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: tenantA,
            memberSerialIds: ['sn-p1-1', 'sn-p1-out'],
            supabaseClient: testDb,
          });
        },
        /sudah dikeluarkan|tidak dapat di-group karena berstatus/i
      );

      // Coba kirim manual ke createSerialGroup
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId: tenantA,
            userId: 'user-1',
            memberSerialIds: ['sn-p1-1', 'sn-p1-out'],
            targetUnit: 'pcs',
            warehouseId: wh1,
            supabaseClient: testDb,
          });
        },
        /sudah dikeluarkan|tidak dapat di-group karena berstatus/i
      );
    });

    it('3. Serial yang sudah tergabung (isGrouped): tidak dapat dipilih sebagai serial mandiri dan ditolak backend', async () => {
      const serials = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });

      const hasGrouped = serials.some(s => s.id === 'sn-p1-grouped');
      assert.equal(hasGrouped, false, 'Serial yang sudah tergabung tidak boleh muncul di daftar serial mandiri');

      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: tenantA,
            memberSerialIds: ['sn-p1-1', 'sn-p1-grouped'],
            supabaseClient: testDb,
          });
        },
        /sudah berada di dalam group/i
      );
    });

    it('4. Serial tanpa relasi produk valid: tidak ditawarkan dan ditolak backend', async () => {
      const serials = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        supabaseClient: testDb,
      });

      const hasOrphan = serials.some(s => s.id === 'sn-orphan');
      assert.equal(hasOrphan, false, 'Serial tanpa relasi produk valid (orphan) tidak boleh ditawarkan');

      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: tenantA,
            memberSerialIds: ['sn-p1-1', 'sn-orphan'],
            supabaseClient: testDb,
          });
        },
        /tidak memiliki relasi produk yang valid/i
      );
    });

    it('5. Dua produk dengan serial valid: grouping lintas produk tetap berfungsi', async () => {
      // List tanpa filter produk menampilkan serial dari kedua produk di gudang wh1
      const serials = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        supabaseClient: testDb,
      });

      // 4 dari prod-1 + 2 dari prod-2 = 6 serial valid
      assert.equal(serials.length, 6);
      const prodNames = new Set(serials.map(s => s.productName));
      assert.ok(prodNames.has('Kemeja Katun'));
      assert.ok(prodNames.has('Dasi Sutra'));

      // Preview cross-product
      const preview = await previewSerialGroup({
        ownerId: tenantA,
        memberSerialIds: ['sn-p1-1', 'sn-p2-1'],
        supabaseClient: testDb,
      });

      assert.equal(preview.isCrossProduct, true);
      assert.equal(preview.directMemberCount, 2);
      // sn-p1-1 (TEST1-PACK... = 60 pcs x 50.000 = 3.000.000) + sn-p2-1 (1 pcs x 25.000 = 25.000)
      assert.equal(preview.totalCost, 3025000);

      // Create cross-product
      const created = await createSerialGroup({
        ownerId: tenantA,
        userId: 'user-1',
        memberSerialIds: ['sn-p1-1', 'sn-p2-1'],
        resultProductName: 'Set Kemeja Dasi',
        targetUnit: 'pcs',
        warehouseId: wh1,
        supabaseClient: testDb,
      });

      assert.equal(created.success, true);
      assert.equal(created.isCrossProduct, true);
      assert.equal(created.totalCost, 3025000);
    });

    it('6. Gudang berbeda: serial tidak dapat dicampur jika aturan transaksi mensyaratkan satu gudang', async () => {
      const serialsWh1 = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        supabaseClient: testDb,
      });
      assert.ok(!serialsWh1.some(s => s.id === 'sn-p1-wh2'), 'Serial wh2 tidak muncul pada filter wh1');

      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: tenantA,
            memberSerialIds: ['sn-p1-1', 'sn-p1-wh2'],
            supabaseClient: testDb,
          });
        },
        /Semua nomor seri dalam satu group harus berasal dari gudang yang sama/i
      );

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId: tenantA,
            userId: 'user-1',
            memberSerialIds: ['sn-p1-1', 'sn-p1-wh2'],
            targetUnit: 'pcs',
            warehouseId: wh1,
            supabaseClient: testDb,
          });
        },
        /Semua nomor seri dalam satu group harus berasal dari gudang yang sama/i
      );
    });

    it('7. Tenant berbeda: serial tidak dapat diakses atau diproses oleh tenant lain', async () => {
      const serialsTenantA = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        supabaseClient: testDb,
      });
      assert.ok(!serialsTenantA.some(s => s.id === 'sn-tenant-b'), 'Serial tenant B tidak boleh muncul di tenant A');

      await assert.rejects(
        async () => {
          await previewSerialGroup({
            ownerId: tenantA,
            memberSerialIds: ['sn-p1-1', 'sn-tenant-b'],
            supabaseClient: testDb,
          });
        },
        /Minimal harus memilih 2 nomor seri yang valid/i // hanya sn-p1-1 yang ditemukan karena sn-tenant-b terisolasi
      );
    });

    it('8. Setelah Goods Out, grouping, atau Return/Dissolve, daftar serial mencerminkan status terbaru', async () => {
      // A. Kondisi awal: 4 serial untuk prod-1
      let list = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });
      assert.equal(list.length, 4);

      // B. Simulasikan Goods Out pada sn-p1-4
      const targetOut = testDb.store.product_serials.find(s => s.id === 'sn-p1-4');
      targetOut.status = 'out';
      targetOut.goods_out_document_id = 'doc-out-2';

      list = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });
      assert.equal(list.length, 3, 'Setelah goods out, tersisa 3 serial');
      assert.ok(!list.some(s => s.id === 'sn-p1-4'));

      // C. Simulasikan Grouping pada sn-p1-1 dan sn-p1-2
      const groupRes = await createSerialGroup({
        ownerId: tenantA,
        userId: 'user-1',
        memberSerialIds: ['sn-p1-1', 'sn-p1-2'],
        resultProductName: 'Paket Kemeja Duo',
        targetUnit: 'pcs',
        warehouseId: wh1,
        supabaseClient: testDb,
      });
      assert.equal(groupRes.success, true);

      // Komponen yang telah di-group tidak lagi muncul sebagai pilihan individual
      list = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });
      const unGrouped = list.filter(s => !s.isGroup);
      assert.equal(unGrouped.length, 1, 'Hanya tersisa 1 serial mandiri dasar (sn-p1-3) untuk prod-1');
      assert.equal(unGrouped[0].id, 'sn-p1-3');
      // Komponen yang digabung (sn-p1-1 dan sn-p1-2) tidak boleh muncul
      assert.ok(!list.some(s => s.id === 'sn-p1-1' || s.id === 'sn-p1-2'));

      // D. Bongkar grouping (ungroupSerial / dissolve)
      const ungroupRes = await ungroupSerial({
        ownerId: tenantA,
        userId: 'user-1',
        groupId: groupRes.groupingRecord.id,
        supabaseClient: testDb,
      });
      assert.equal(ungroupRes.success, true);

      // Setelah dibongkar, komponen sn-p1-1 dan sn-p1-2 kembali berstatus available dan tampil di daftar
      list = await getAvailableSerialsForGrouping({
        ownerId: tenantA,
        warehouseId: wh1,
        productId: 'prod-1',
        supabaseClient: testDb,
      });
      assert.equal(list.length, 3, 'Setelah pembongkaran, sn-p1-1 dan sn-p1-2 kembali tersedia (total 3)');
    });
  });
});

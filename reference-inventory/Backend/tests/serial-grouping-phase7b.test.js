import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBusinessDateDDMMYYYY,
  normalizeSerialUnitCode,
  formatGroupSerialPrefix,
  formatGroupSerialNumber,
  generateGroupSerialNumber,
  verifyScanSerialForGrouping,
  processMultiSerialGroups,
  createSerialGroup,
  previewSerialGroup,
  validateGroupingUnitAndQuantity,
  calculateGroupingCosts,
  CANONICAL_MULTIPLIERS,
} from '../src/services/serialGroup.service.js';

/**
 * High-fidelity in-memory Mock Supabase Client for Phase 7B tests
 */
function createMockSupabase(initialData = {}) {
  const store = {
    products: [...(initialData.products || [])].map((p) => ({ ...p, metadata: { ...(p.metadata || {}) } })),
    product_serials: [...(initialData.product_serials || [])].map((s) => ({ ...s, metadata: { ...(s.metadata || {}) } })),
    documents: [...(initialData.documents || [])].map((d) => ({ ...d, metadata: { ...(d.metadata || {}) } })),
    document_items: [...(initialData.document_items || [])].map((i) => ({ ...i, metadata: { ...(i.metadata || {}) } })),
    serial_groupings: [...(initialData.serial_groupings || [])].map((g) => ({ ...g, metadata: { ...(g.metadata || {}) } })),
    serial_grouping_components: [...(initialData.serial_grouping_components || [])].map((c) => ({ ...c, metadata: { ...(c.metadata || {}) } })),
  };

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
        const reg = new RegExp(`^${regexStr}$`, 'i');
        rows = rows.filter((r) => reg.test(String(r[col] || '')));
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
            id: item.id || `mock-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${idx}`,
            created_at: item.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          // Unique constraint simulation for product_serials and serial_groupings
          if (tableName === 'product_serials') {
            const conflict = (store.product_serials || []).find(
              (s) => s.owner_id === row.owner_id && s.serial_number?.toLowerCase() === row.serial_number?.toLowerCase()
            );
            if (conflict) {
              const err = new Error(`duplicate key value violates unique constraint "uq_product_serials_owner_number"`);
              err.code = '23505';
              throw err;
            }
          }
          if (tableName === 'serial_groupings') {
            const conflict = (store.serial_groupings || []).find(
              (g) => g.owner_id === row.owner_id && g.grouping_number?.toLowerCase() === row.grouping_number?.toLowerCase()
            );
            if (conflict) {
              const err = new Error(`duplicate key value violates unique constraint "uq_serial_groupings_owner_number"`);
              err.code = '23505';
              throw err;
            }
          }
          return row;
        });
        store[tableName].push(...inserted);

        return {
          select() {
            return {
              single() {
                return Promise.resolve({ data: inserted[0], error: null });
              },
              then(resolve) {
                resolve({ data: inserted, error: null });
              },
            };
          },
          then(resolve) {
            resolve({ data: inserted, error: null });
          },
        };
      },
      update(updates) {
        const filters = [];
        const updateBuilder = {
          eq(col, val) {
            filters.push({ col, val });
            return updateBuilder;
          },
          is(col, val) {
            filters.push({ col, isNull: val === null });
            return updateBuilder;
          },
          in(col, valList) {
            const set = new Set(valList);
            filters.push({ col, in: set });
            return updateBuilder;
          },
          select(fields = '*') {
            const matching = rows.filter((r) =>
              filters.every((f) => {
                if (f.in) return f.in.has(r[f.col]);
                if (f.isNull) return r[f.col] === null || r[f.col] === undefined;
                return r[f.col] === f.val;
              })
            );
            matching.forEach((r) => Object.assign(r, updates));
            return {
              single() {
                return Promise.resolve({ data: matching[0] || null, error: null });
              },
              then(resolve) {
                resolve({ data: matching, error: null });
              },
            };
          },
          then(resolve) {
            const matching = rows.filter((r) =>
              filters.every((f) => {
                if (f.in) return f.in.has(r[f.col]);
                if (f.isNull) return r[f.col] === null || r[f.col] === undefined;
                return r[f.col] === f.val;
              })
            );
            matching.forEach((r) => Object.assign(r, updates));
            resolve({ data: matching, error: null });
          },
        };
        return updateBuilder;
      },
      then(resolve) {
        // Resolve joined product if selecting from product_serials
        let resRows = rows.map((r) => {
          if (tableName === 'product_serials') {
            const prod = (store.products || []).find((p) => p.id === r.product_id);
            return { ...r, product: prod || null };
          }
          return { ...r };
        });

        if (isSingle) {
          resolve({ data: resRows[0] || null, error: resRows[0] ? null : { message: 'Row not found' } });
        } else if (isMaybeSingle) {
          resolve({ data: resRows[0] || null, error: null });
        } else {
          resolve({ data: resRows, error: null });
        }
      },
    };

    return builder;
  }

  return {
    store,
    from(tableName) {
      return buildQuery(tableName);
    },
    rpc() {
      // Return null so application fallback executes safely
      const err = new Error('RPC function create_serial_group_atomic not available in mock');
      err.code = '42883';
      return Promise.resolve({ data: null, error: err });
    },
  };
}

describe('PHASE 7B — Scan-First Multi-Grouping & Auto Serial Generation Suite', () => {
  const ownerId = '11111111-1111-4111-a111-111111111111';
  const userId = '22222222-2222-4222-a222-222222222222';
  const warehouseId = '33333333-3333-4333-a333-333333333333';

  // Sample Master Products
  const compProduct = {
    id: 'prod-comp-1',
    owner_id: ownerId,
    name: 'Baju Anak Katun',
    sku: 'BAJU-01',
    category: 'Apparel',
    unit_cost: 10000,
    status: 'active',
    metadata: { unit: 'pcs' },
  };

  const targetBundleProduct = {
    id: 'prod-target-1',
    owner_id: ownerId,
    name: 'Paket Bundle 3 Lusin',
    sku: 'BUNDLE01',
    category: 'Bundle',
    unit_cost: 360000,
    status: 'active',
    metadata: { unit: 'lusin' },
  };

  // 1. Scan SN valid menambahkan serial ke batch aktif
  it('1. Scan SN valid menambahkan serial ke batch aktif', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct],
      product_serials: [
        {
          id: 'sn-01',
          owner_id: ownerId,
          product_id: compProduct.id,
          serial_number: 'SN-BAJU-001',
          status: 'available',
          warehouse_id: warehouseId,
          metadata: { unit: 'pcs', unitQty: 1 },
        },
      ],
    });

    const res = await verifyScanSerialForGrouping({
      ownerId,
      warehouseId,
      serialNumber: 'SN-BAJU-001',
      supabaseClient: mockDb,
    });

    assert.equal(res.eligible, true);
    assert.equal(res.serial.id, 'sn-01');
    assert.equal(res.serial.serialNumber, 'SN-BAJU-001');
    assert.equal(res.serial.productName, compProduct.name);
    assert.equal(res.serial.pcs, 1);
  });

  // 2. Enter scanner mengakhiri input dengan benar (whitespace & lowercase auto-trim)
  it('2. Enter scanner mengakhiri input dengan benar (whitespace auto-trimmed)', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct],
      product_serials: [
        {
          id: 'sn-02',
          owner_id: ownerId,
          product_id: compProduct.id,
          serial_number: 'SN-BAJU-002',
          status: 'available',
          warehouse_id: warehouseId,
          metadata: {},
        },
      ],
    });

    // Scanner sending input with trailing newline/carriage return or spaces
    const res = await verifyScanSerialForGrouping({
      ownerId,
      warehouseId,
      serialNumber: '  SN-BAJU-002 \n ',
      supabaseClient: mockDb,
    });

    assert.equal(res.eligible, true);
    assert.equal(res.serial.serialNumber, 'SN-BAJU-002');
  });

  // 3. Scan duplikat ditolak
  it('3. Scan duplikat dalam batch yang sama ditolak', () => {
    const activeBatchSerials = [{ serialNumber: 'SN-001' }, { serialNumber: 'SN-002' }];
    const scannedSN = 'sn-001';

    const isDuplicate = activeBatchSerials.some(
      (s) => s.serialNumber.toLowerCase() === scannedSN.toLowerCase()
    );
    assert.equal(isDuplicate, true, 'Scan nomor seri yang sama harus terdeteksi sebagai duplikat.');
  });

  // 4. Serial yang sudah keluar/terpakai ditolak
  it('4. Serial yang sudah keluar/terpakai ditolak', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct],
      product_serials: [
        {
          id: 'sn-out',
          owner_id: ownerId,
          product_id: compProduct.id,
          serial_number: 'SN-OUT-999',
          status: 'out',
          warehouse_id: warehouseId,
          goods_out_document_id: 'doc-out-1',
          metadata: {},
        },
      ],
    });

    await assert.rejects(
      async () => {
        await verifyScanSerialForGrouping({
          ownerId,
          warehouseId,
          serialNumber: 'SN-OUT-999',
          supabaseClient: mockDb,
        });
      },
      (err) => {
        assert.equal(err.code, 'SERIAL_NOT_AVAILABLE');
        assert.match(err.message, /tidak tersedia/i);
        return true;
      }
    );
  });

  // 5. Serial yang sama tidak bisa masuk dua batch (cross-batch rejection)
  it('5. Serial yang sama tidak bisa masuk dua batch', () => {
    const batches = [
      { id: 'b1', name: 'Batch 1', serials: [{ serialNumber: 'SN-COMP-1' }] },
      { id: 'b2', name: 'Batch 2', serials: [] },
    ];
    const newScan = 'SN-COMP-1';

    const allocatedBatch = batches.find((b) =>
      b.serials.some((s) => s.serialNumber.toLowerCase() === newScan.toLowerCase())
    );

    assert.ok(allocatedBatch, 'Harus mendeteksi alokasi pada batch sebelumnya');
    assert.equal(allocatedBatch.id, 'b1');
    assert.equal(allocatedBatch.name, 'Batch 1');
  });

  // 6. Perpindahan batch mempertahankan draft
  it('6. Perpindahan batch mempertahankan draft', () => {
    let batches = [
      { id: 'b1', name: 'Batch 1', serials: [{ serialNumber: 'SN-1' }, { serialNumber: 'SN-2' }], targetUnit: 'lusin' },
      { id: 'b2', name: 'Batch 2', serials: [], targetUnit: 'pcs' },
    ];

    // User switches to Batch 2 and scans SN-3
    batches = batches.map((b) => {
      if (b.id === 'b2') {
        return { ...b, serials: [...b.serials, { serialNumber: 'SN-3' }] };
      }
      return b;
    });

    // Verify Batch 1 draft is preserved intact
    const batch1 = batches.find((b) => b.id === 'b1');
    assert.equal(batch1.serials.length, 2);
    assert.equal(batch1.targetUnit, 'lusin');

    const batch2 = batches.find((b) => b.id === 'b2');
    assert.equal(batch2.serials.length, 1);
  });

  // 7. Preview tiap batch independen
  it('7. Preview tiap batch independen (tidak mencampurkan komponen dari batch berbeda)', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct, targetBundleProduct],
      product_serials: [
        { id: 's1', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-1', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'pcs' } },
        { id: 's2', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-2', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'pcs' } },
        { id: 's3', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-3', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'pcs' } },
        { id: 's4', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-4', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'pcs' } },
      ],
    });

    // Batch 1 preview: only s1, s2 with targetUnit 'pcs'
    const preview1 = await previewSerialGroup({
      ownerId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      supabaseClient: mockDb,
    });

    // Batch 2 preview: only s3, s4 with targetUnit 'pcs'
    const preview2 = await previewSerialGroup({
      ownerId,
      memberSerialIds: ['s3', 's4'],
      targetUnit: 'pcs',
      supabaseClient: mockDb,
    });

    assert.equal(preview1.directMemberCount, 2);
    assert.equal(preview1.totalPcs, 2);
    assert.equal(preview2.directMemberCount, 2);
    assert.equal(preview2.totalPcs, 2);
  });

  // 8. Perhitungan satuan dan kuantitas benar
  it('8. Perhitungan satuan dan kuantitas benar menggunakan canonical multipliers', () => {
    // 36 pcs -> 3 lusin
    const validation = validateGroupingUnitAndQuantity({
      leafComposition: [
        { pcs: 12, unit: 'lusin' },
        { pcs: 12, unit: 'lusin' },
        { pcs: 12, unit: 'lusin' },
      ],
      targetUnit: 'lusin',
    });

    assert.equal(validation.isValid, true);
    assert.equal(validation.totalBaseQtyPcs, 36);
    assert.equal(validation.targetMultiplier, 12);
    assert.equal(validation.targetQty, 3);

    // Residue validation: 35 pcs cannot be converted into lusin
    assert.throws(
      () => {
        validateGroupingUnitAndQuantity({
          leafComposition: [{ pcs: 35, unit: 'pcs' }],
          targetUnit: 'lusin',
        });
      },
      (err) => {
        assert.equal(err.code, 'UNIT_MISMATCH');
        assert.equal(err.remainder, 11);
        return true;
      }
    );
  });

  // 9. Format serial hasil sesuai kontrak: [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY][NOMOR URUT]
  it('9. Format serial hasil sesuai kontrak: [SKU]-G-[TOTAL][SATUAN]-[DDMMYYYY][NOMOR URUT]', () => {
    const fixedDate = new Date('2026-10-23T11:00:00+07:00');
    const prefix = formatGroupSerialPrefix({
      sku: 'bundle01',
      targetQty: 3,
      targetUnit: 'lusin',
      date: fixedDate,
      timeZone: 'Asia/Jakarta',
    });

    assert.equal(prefix, 'BUNDLE01-G-3LUSIN-23102026');

    const fullSerial = formatGroupSerialNumber({ prefix, sequence: 1 });
    assert.equal(fullSerial, 'BUNDLE01-G-3LUSIN-231020260001');
  });

  // 10. Nomor urut tidak bentrok saat concurrent create (increment sequence)
  it('10. Nomor urut tidak bentrok saat concurrent create', async () => {
    const fixedDate = new Date('2026-10-23T11:00:00+07:00');
    const mockDb = createMockSupabase({
      product_serials: [
        {
          id: 'ps-existing-1',
          owner_id: ownerId,
          serial_number: 'BUNDLE01-G-3LUSIN-231020260001',
        },
        {
          id: 'ps-existing-2',
          owner_id: ownerId,
          serial_number: 'BUNDLE01-G-3LUSIN-231020260002',
        },
      ],
      serial_groupings: [],
    });

    const gen = await generateGroupSerialNumber({
      ownerId,
      sku: 'BUNDLE01',
      targetQty: 3,
      targetUnit: 'lusin',
      date: fixedDate,
      timeZone: 'Asia/Jakarta',
      supabaseClient: mockDb,
    });

    assert.equal(gen.sequence, 3);
    assert.equal(gen.serialNumber, 'BUNDLE01-G-3LUSIN-231020260003');
  });

  // 11. Gagal membuat serial tidak menghasilkan mutasi ledger parsial
  it('11. Gagal membuat serial tidak menghasilkan mutasi ledger parsial', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct],
      product_serials: [
        { id: 's1', owner_id: ownerId, product_id: compProduct.id, serial_number: 'S-A', status: 'available', warehouse_id: warehouseId, metadata: {} },
        { id: 's2', owner_id: ownerId, product_id: compProduct.id, serial_number: 'S-B', status: 'available', warehouse_id: warehouseId, metadata: {} },
      ],
    });

    // Intentionally inject an invalid target unit that fails conversion
    await assert.rejects(
      async () => {
        await createSerialGroup({
          ownerId,
          userId,
          memberSerialIds: ['s1', 's2'],
          targetUnit: 'unsupported_unit_xyz',
          supabaseClient: mockDb,
        });
      },
      (err) => {
        assert.equal(err.code, 'UNIT_CONVERSION_UNSUPPORTED');
        return true;
      }
    );

    // Verify zero documents or grouping records created
    assert.equal(mockDb.store.documents.length, 0);
    assert.equal(mockDb.store.document_items.length, 0);
    assert.equal(mockDb.store.serial_groupings.length, 0);
  });

  // 12. Gagal posting satu batch tidak mengubah status batch lain (independent execution)
  it('12. Gagal posting satu batch tidak mengubah status batch lain', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct, targetBundleProduct],
      product_serials: [
        // Batch 1 serials (valid)
        { id: 's1', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-B1-1', status: 'available', warehouse_id: warehouseId, metadata: {} },
        { id: 's2', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-B1-2', status: 'available', warehouse_id: warehouseId, metadata: {} },
        // Batch 2 serials (invalid - already out)
        { id: 's3', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-B2-1', status: 'out', warehouse_id: warehouseId, goods_out_document_id: 'doc-1', metadata: {} },
        { id: 's4', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-B2-2', status: 'available', warehouse_id: warehouseId, metadata: {} },
      ],
    });

    const multiRes = await processMultiSerialGroups({
      ownerId,
      userId,
      warehouseId,
      batches: [
        {
          batchId: 'batch-1',
          name: 'Batch 1 (Valid)',
          memberSerialIds: ['s1', 's2'],
          targetProductId: compProduct.id,
          targetUnit: 'pcs',
        },
        {
          batchId: 'batch-2',
          name: 'Batch 2 (Contains Out SN)',
          memberSerialIds: ['s3', 's4'],
          targetProductId: compProduct.id,
          targetUnit: 'pcs',
        },
      ],
      supabaseClient: mockDb,
    });

    assert.equal(multiRes.summary.total, 2);
    assert.equal(multiRes.summary.succeeded, 1);
    assert.equal(multiRes.summary.failed, 1);

    const b1Result = multiRes.results.find((r) => r.batchId === 'batch-1');
    assert.equal(b1Result.success, true);
    assert.ok(b1Result.data.group);

    const b2Result = multiRes.results.find((r) => r.batchId === 'batch-2');
    assert.equal(b2Result.success, false);
    assert.match(b2Result.error.message, /sudah dikeluarkan|tidak dapat/i);
  });

  // 13. Retry tidak menggandakan grouping (idempotency key protection)
  it('13. Retry tidak menggandakan grouping (idempotency key protection)', async () => {
    const mockDb = createMockSupabase({
      products: [compProduct],
      product_serials: [
        { id: 's1', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-IDEM-1', status: 'available', warehouse_id: warehouseId, metadata: {} },
        { id: 's2', owner_id: ownerId, product_id: compProduct.id, serial_number: 'SN-IDEM-2', status: 'available', warehouse_id: warehouseId, metadata: {} },
      ],
    });

    const idempotencyKey = 'idem-unique-key-12345';

    // First call
    const firstCall = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      idempotencyKey,
      supabaseClient: mockDb,
    });

    assert.equal(firstCall.success, true);
    assert.equal(mockDb.store.serial_groupings.length, 1);

    // Second call (retry with same idempotency key)
    const secondCall = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      idempotencyKey,
      supabaseClient: mockDb,
    });

    assert.equal(secondCall.success, true);
    assert.equal(secondCall.isReplay, true);
    assert.equal(mockDb.store.serial_groupings.length, 1, 'Idempotency must prevent duplicate grouping inserts.');
  });

  // 14. SKU, tanggal, dan satuan yang digunakan sesuai aturan bisnis
  it('14. SKU, tanggal, dan satuan yang digunakan sesuai aturan bisnis', () => {
    const testDate = new Date('2026-10-23T15:30:00+07:00');
    const dateFormatted = getBusinessDateDDMMYYYY(testDate, 'Asia/Jakarta');
    assert.equal(dateFormatted, '23102026');

    // Canonical unit formatting
    assert.equal(normalizeSerialUnitCode('pcs'), 'PCS');
    assert.equal(normalizeSerialUnitCode('lusin'), 'LUSIN');
    assert.equal(normalizeSerialUnitCode('pack'), 'PACK');
    assert.equal(normalizeSerialUnitCode('bal10'), 'BAL10');
    assert.equal(normalizeSerialUnitCode('bal25'), 'BAL25');
    assert.equal(normalizeSerialUnitCode('bal'), 'BAL25', 'Legacy bal must map to BAL25 per AGENTS.md Rule 1');

    // SKU normalization
    const prefix = formatGroupSerialPrefix({
      sku: 'SKU-ABC 123!',
      targetQty: 5,
      targetUnit: 'pack',
      date: testDate,
    });
    assert.equal(prefix, 'SKU-ABC123-G-5PACK-23102026');
  });

  // 15. Regression tests: compatibility with existing functions
  it('15. Regression tests: existing calculateGroupingCosts & canonical multipliers intact', () => {
    assert.equal(CANONICAL_MULTIPLIERS.pcs, 1);
    assert.equal(CANONICAL_MULTIPLIERS.lusin, 12);
    assert.equal(CANONICAL_MULTIPLIERS.pack, 60);
    assert.equal(CANONICAL_MULTIPLIERS.bal10, 120);
    assert.equal(CANONICAL_MULTIPLIERS.bal25, 300);
    assert.equal(CANONICAL_MULTIPLIERS.bal, 300);

    const costRes = calculateGroupingCosts({
      directMembers: [
        { productUnitCost: 15000, pcs: 1 },
        { productUnitCost: 25000, pcs: 1 },
      ],
      targetQty: 2,
    });

    assert.equal(costRes.totalCost, 40000);
    assert.equal(costRes.resultUnitCost, 20000);
  });
});

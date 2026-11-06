import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSerialGroup,
  previewSerialGroup,
  listSerialGroupings,
  resolveSourceProductPolicy,
} from '../src/services/serialGroup.service.js';

import {
  computeSourceProductPolicy,
  withSourceProductPolicy,
  isStalePreviewResult,
} from '../../frontend-new/src/pages/SerialGrouping/serialGroupingPolicy.js';

import {
  getAssemblyReference,
  getReversalReference,
  matchesGroupingSearch,
} from '../../frontend-new/src/pages/SerialGrouping/serialGroupingReference.js';

/**
 * PHASE 7E — Auto-detect & product lock + grouping reference
 *
 * NOTE: runs against an in-memory mock. It validates the code paths and the
 * pure policy helpers; it is NOT a real isolated PostgreSQL integration test.
 */

const ownerId = '11111111-1111-4111-a111-111111111111';
const userId = '22222222-2222-4222-a222-222222222222';
const warehouseId = '33333333-3333-4333-a333-333333333333';

function createMockSupabase(seed = {}) {
  const store = {
    products: [...(seed.products || [])].map((p) => ({ ...p })),
    product_serials: [...(seed.product_serials || [])].map((s) => ({ ...s, metadata: { ...(s.metadata || {}) } })),
    documents: [...(seed.documents || [])].map((d) => ({ ...d, metadata: { ...(d.metadata || {}) } })),
    document_items: [...(seed.document_items || [])].map((i) => ({ ...i, metadata: { ...(i.metadata || {}) } })),
    serial_groupings: [...(seed.serial_groupings || [])].map((g) => ({ ...g, metadata: { ...(g.metadata || {}) } })),
    serial_grouping_components: [...(seed.serial_grouping_components || [])].map((c) => ({ ...c, metadata: { ...(c.metadata || {}) } })),
  };

  function matchFilters(row, filters) {
    return filters.every((f) => {
      if (f.in) return f.in.has(row[f.col]);
      if (f.isNull) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }

  const docById = (id) => (store.documents || []).find((d) => d.id === id) || null;

  function withEmbeds(tableName, row) {
    if (tableName === 'product_serials') {
      return { ...row, product: (store.products || []).find((p) => p.id === row.product_id) || null };
    }
    if (tableName === 'serial_groupings') {
      return {
        ...row,
        result_product: (store.products || []).find((p) => p.id === row.result_product_id) || null,
        source_document: docById(row.source_document_id),
        reverse_document: docById(row.reverse_document_id),
      };
    }
    return { ...row };
  }

  function buildQuery(tableName) {
    let rows = [...(store[tableName] || [])];
    let isSingle = false;
    let isMaybeSingle = false;

    const builder = {
      select() { return builder; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return builder; },
      neq(col, val) { rows = rows.filter((r) => r[col] !== val); return builder; },
      is(col, val) {
        rows = val === null
          ? rows.filter((r) => r[col] === null || r[col] === undefined)
          : rows.filter((r) => r[col] === val);
        return builder;
      },
      in(col, vals) { const s = new Set(vals); rows = rows.filter((r) => s.has(r[col])); return builder; },
      ilike(col, pattern) {
        const reg = new RegExp(`^${String(pattern).replace(/%/g, '.*')}$`, 'i');
        rows = rows.filter((r) => reg.test(String(r[col] || '')));
        return builder;
      },
      or(expression) {
        const clauses = String(expression).split(',').map((c) => c.trim());
        rows = rows.filter((row) => clauses.some((clause) => {
          const [col, op, ...rest] = clause.split('.');
          if (op === 'eq') return String(row[col]) === rest.join('.');
          return false;
        }));
        return builder;
      },
      contains(col, value) {
        rows = rows.filter((r) => {
          const meta = r[col] || {};
          return Object.entries(value).every(([k, v]) => meta[k] === v);
        });
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
      limit(n) { rows = rows.slice(0, n); return builder; },
      range(from, to) { rows = rows.slice(from, to + 1); return builder; },
      single() { isSingle = true; return builder; },
      maybeSingle() { isMaybeSingle = true; return builder; },
      insert(payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((item, idx) => {
          const row = {
            id: item.id || `mock-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${idx}`,
            created_at: item.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          store[tableName].push(row);
          return row;
        });
        return {
          select() {
            return {
              single() { return Promise.resolve({ data: inserted[0], error: null }); },
              then(resolve) { resolve({ data: inserted, error: null }); },
            };
          },
          then(resolve) { resolve({ data: inserted, error: null }); },
        };
      },
      update(updates) {
        const filters = [];
        const updateBuilder = {
          eq(col, val) { filters.push({ col, val }); return updateBuilder; },
          is(col, val) { filters.push({ col, isNull: val === null }); return updateBuilder; },
          in(col, valList) { filters.push({ col, in: new Set(valList) }); return updateBuilder; },
          select() {
            const matching = rows.filter((r) => matchFilters(r, filters));
            matching.forEach((r) => Object.assign(r, updates));
            return {
              single() { return Promise.resolve({ data: matching[0] || null, error: matching[0] ? null : { message: 'no row' } }); },
              then(resolve) { resolve({ data: matching, error: null }); },
            };
          },
          then(resolve) {
            const matching = rows.filter((r) => matchFilters(r, filters));
            matching.forEach((r) => Object.assign(r, updates));
            resolve({ data: matching, error: null });
          },
        };
        return updateBuilder;
      },
      delete() {
        const filters = [];
        const deleteBuilder = {
          eq(col, val) { filters.push({ col, val }); return deleteBuilder; },
          then(resolve) {
            const matching = rows.filter((r) => matchFilters(r, filters));
            store[tableName] = store[tableName].filter((r) => !matching.includes(r));
            resolve({ data: matching, error: null });
          },
        };
        return deleteBuilder;
      },
      then(resolve) {
        const resRows = rows.map((r) => withEmbeds(tableName, r));
        if (isSingle) resolve({ data: resRows[0] || null, error: resRows[0] ? null : { message: 'Row not found' } });
        else if (isMaybeSingle) resolve({ data: resRows[0] || null, error: null });
        else resolve({ data: resRows, error: null });
      },
    };
    return builder;
  }

  return {
    store,
    from(tableName) { return buildQuery(tableName); },
    rpc(name) {
      const err = new Error(`RPC function ${name} not available in mock`);
      err.code = '42883';
      return Promise.resolve({ data: null, error: err });
    },
  };
}

const productPcs = {
  id: 'prod-A', owner_id: ownerId, name: 'Produk A', sku: 'A-01', category: 'Apparel',
  unit_cost: 1000, status: 'active', metadata: { unit: 'pcs' },
};
const productB = {
  id: 'prod-B', owner_id: ownerId, name: 'Produk B', sku: 'B-01', category: 'Apparel',
  unit_cost: 2000, status: 'active', metadata: { unit: 'pcs' },
};
const productBundle = {
  id: 'prod-X', owner_id: ownerId, name: 'Bundle X', sku: 'BUNDLE01', category: 'Bundle',
  unit_cost: 5000, status: 'active', metadata: { unit: 'pcs' },
};
const productLusin = {
  id: 'prod-L', owner_id: ownerId, name: 'Kemeja Lusin', sku: 'L-01', category: 'Apparel',
  unit_cost: 600000, status: 'active', metadata: { unit: 'lusin' },
};

function serial(id, productId, sn, metadata = {}) {
  return {
    id, owner_id: ownerId, product_id: productId, serial_number: sn,
    status: 'available', warehouse_id: warehouseId, metadata,
  };
}

function seedSameProduct() {
  return {
    products: [productPcs, productB, productBundle, productLusin],
    product_serials: [
      serial('A-001', 'prod-A', 'SN-A-001'),
      serial('A-002', 'prod-A', 'SN-A-002'),
      serial('B-001', 'prod-B', 'SN-B-001'),
      serial('L-001', 'prod-L', 'SN-L-001', { unit: 'lusin', unitQty: 1 }),
      serial('L-002', 'prod-L', 'SN-L-002', { unit: 'lusin', unitQty: 1 }),
      serial('L-003', 'prod-L', 'SN-L-003', { unit: 'lusin', unitQty: 1 }),
    ],
  };
}

describe('PHASE 7E — Auto-detect product & lock policy (pure)', () => {
  const verifiedA1 = { id: 'A-001', productId: 'prod-A', productName: 'Produk A', sku: 'A-01' };
  const verifiedA2 = { id: 'A-002', productId: 'prod-A', productName: 'Produk A', sku: 'A-01' };
  const verifiedB1 = { id: 'B-001', productId: 'prod-B', productName: 'Produk B', sku: 'B-01' };

  test('1. two serials from the same product -> auto-detected and locked', () => {
    const policy = computeSourceProductPolicy([verifiedA1, verifiedA2]);
    assert.equal(policy.productSelectionLocked, true);
    assert.equal(policy.distinctProductCount, 1);
    assert.equal(policy.lockedResultProductId, 'prod-A');
    assert.equal(policy.sourceProducts[0].serialCount, 2);

    const batch = withSourceProductPolicy(
      { targetProductId: '', isNewProduct: true, newProductName: 'X', newProductSku: 'X' },
      [verifiedA1, verifiedA2]
    );
    assert.equal(batch.targetProductId, 'prod-A');
    assert.equal(batch.isNewProduct, false);
    assert.equal(batch.newProductName, '');
  });

  test('2. adding another serial from the same product keeps the lock', () => {
    const policy = computeSourceProductPolicy([verifiedA1, verifiedA2, { ...verifiedA1, id: 'A-003' }]);
    assert.equal(policy.productSelectionLocked, true);
    assert.equal(policy.lockedResultProductId, 'prod-A');
    assert.equal(policy.sourceProducts[0].serialCount, 3);
  });

  test('3. a serial from another product releases the lock and exposes sources', () => {
    const policy = computeSourceProductPolicy([verifiedA1, verifiedA2, verifiedB1]);
    assert.equal(policy.productSelectionLocked, false);
    assert.equal(policy.isSingleSourceProduct, false);
    assert.equal(policy.distinctProductCount, 2);
    assert.equal(policy.lockedResultProductId, null);
    assert.deepEqual(policy.sourceProducts.map((p) => p.productId).sort(), ['prod-A', 'prod-B']);
  });

  test('4. removing the foreign serial re-detects and re-locks', () => {
    let batch = withSourceProductPolicy({ targetProductId: '', isNewProduct: false }, [verifiedA1, verifiedA2, verifiedB1]);
    assert.equal(batch.serials.length, 3);

    batch = withSourceProductPolicy(batch, [verifiedA1, verifiedA2]);
    assert.equal(batch.targetProductId, 'prod-A');
    assert.equal(computeSourceProductPolicy(batch.serials).productSelectionLocked, true);
  });

  test('5. removing every serial resets the product state safely', () => {
    const batch = withSourceProductPolicy(
      { targetProductId: 'prod-A', isNewProduct: true, newProductName: 'New', newProductSku: 'N' },
      []
    );
    assert.equal(batch.targetProductId, '');
    assert.equal(batch.isNewProduct, false);
    assert.equal(batch.newProductName, '');
    assert.equal(computeSourceProductPolicy([]).distinctProductCount, 0);
  });

  test('6. batches keep independent product state (Batch 1 lock does not leak)', () => {
    const batch1 = withSourceProductPolicy({ id: 'batch-1', targetProductId: '' }, [verifiedA1, verifiedA2]);
    const batch2 = withSourceProductPolicy({ id: 'batch-2', targetProductId: '' }, [verifiedB1, { ...verifiedB1, id: 'B-002' }]);

    assert.equal(batch1.targetProductId, 'prod-A');
    assert.equal(batch2.targetProductId, 'prod-B');
    assert.equal(computeSourceProductPolicy(batch1.serials).lockedResultProductId, 'prod-A');
    assert.equal(computeSourceProductPolicy(batch2.serials).lockedResultProductId, 'prod-B');
  });

  test('8. invalid/unverified serials never influence detection', () => {
    // Only verified serials enter the batch; a failed scan is not appended.
    const afterFailedScan = withSourceProductPolicy({ targetProductId: '', isNewProduct: false }, [verifiedA1]);
    const policy = computeSourceProductPolicy(afterFailedScan.serials);

    assert.equal(policy.productSelectionLocked, true);
    assert.equal(policy.lockedResultProductId, 'prod-A');

    // A record without a product identity is ignored entirely.
    const anonymous = computeSourceProductPolicy([verifiedA1, { id: 'ghost' }]);
    assert.equal(anonymous.distinctProductCount, 1);
    assert.equal(anonymous.lockedResultProductId, 'prod-A');
  });

  test('9. stale preview results are rejected when composition/batch changed', () => {
    const base = {
      requestSeq: 2,
      currentSeq: 2,
      requestBatchId: 'batch-1',
      currentBatchId: 'batch-1',
      snapshotMembershipKey: 'A-001,A-002',
      currentMembershipKey: 'A-001,A-002',
    };
    assert.equal(isStalePreviewResult(base), false);

    assert.equal(isStalePreviewResult({ ...base, currentMembershipKey: 'A-001,A-002,B-001' }), true);
    assert.equal(isStalePreviewResult({ ...base, currentSeq: 3 }), true);
    assert.equal(isStalePreviewResult({ ...base, currentBatchId: 'batch-2' }), true);
  });

  test('policy counts source products from record identity, not serial text', () => {
    const policy = computeSourceProductPolicy([
      { id: 'x', productId: 'prod-A', productName: 'A', sku: 'A' },
      { id: 'y', product_id: 'prod-B', product_name: 'B', sku: 'B' },
    ]);
    assert.equal(policy.distinctProductCount, 2);
    assert.equal(policy.productSelectionLocked, false);
  });
});

describe('PHASE 7E — Backend enforces the product lock (not just the UI)', () => {
  test('7a. changing the locked result product is rejected by the backend', async () => {
    const db = createMockSupabase(seedSameProduct());

    await assert.rejects(
      () => createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['A-001', 'A-002'],
        resultProductId: 'prod-B',
        targetUnit: 'pcs',
        warehouseId,
        supabaseClient: db,
      }),
      (err) => {
        assert.equal(err.code, 'PRODUCT_LOCKED_SINGLE_SOURCE');
        assert.match(err.message, /tidak dapat diganti/i);
        return true;
      }
    );
  });

  test('7b. creating a new master product for a single-source batch is rejected', async () => {
    const db = createMockSupabase(seedSameProduct());

    await assert.rejects(
      () => createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['A-001', 'A-002'],
        resultProductName: 'Produk Hasil Baru',
        createNewMasterProduct: true,
        targetUnit: 'pcs',
        warehouseId,
        supabaseClient: db,
      }),
      (err) => {
        assert.equal(err.code, 'PRODUCT_LOCKED_SINGLE_SOURCE');
        assert.match(err.message, /master produk baru tidak diizinkan/i);
        return true;
      }
    );
  });

  test('7c. preview rejects a manipulated locked product request', async () => {
    const db = createMockSupabase(seedSameProduct());

    await assert.rejects(
      () => previewSerialGroup({
        ownerId,
        memberSerialIds: ['A-001', 'A-002'],
        resultProductId: 'prod-B',
        targetUnit: 'pcs',
        supabaseClient: db,
      }),
      (err) => {
        assert.equal(err.code, 'PRODUCT_LOCKED_SINGLE_SOURCE');
        return true;
      }
    );
  });

  test('7d. cross-product batches stay selectable', async () => {
    const db = createMockSupabase(seedSameProduct());
    const preview = await previewSerialGroup({
      ownerId,
      memberSerialIds: ['A-001', 'B-001'],
      resultProductId: 'prod-X',
      targetUnit: 'pcs',
      supabaseClient: db,
    });

    assert.equal(preview.productSelectionLocked, false);
    assert.equal(preview.distinctProductCount, 2);
    assert.equal(preview.isCrossProduct, true);
    assert.equal(preview.targetProduct.id, 'prod-X');

    const grouped = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['A-001', 'B-001'],
      resultProductId: 'prod-X',
      targetUnit: 'pcs',
      warehouseId,
      supabaseClient: db,
    });

    assert.equal(grouped.success, true);
    assert.equal(grouped.productSelectionLocked, false);
    assert.equal(grouped.isCrossProduct, true);
  });

  test('1+10. single-source batch auto-selects the source product and keeps unit/HPP correct', async () => {
    const db = createMockSupabase(seedSameProduct());

    const preview = await previewSerialGroup({
      ownerId,
      memberSerialIds: ['L-001', 'L-002', 'L-003'],
      targetUnit: 'lusin',
      supabaseClient: db,
    });

    assert.equal(preview.productSelectionLocked, true);
    assert.equal(preview.lockedResultProductId, 'prod-L');
    assert.equal(preview.targetQty, 3);
    assert.equal(preview.totalBaseQtyPcs, 36);
    assert.equal(preview.totalCost, 1800000);
    assert.equal(preview.resultUnitCost, 600000);

    const grouped = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['L-001', 'L-002', 'L-003'],
      targetUnit: 'lusin',
      warehouseId,
      supabaseClient: db,
    });

    assert.equal(grouped.success, true);
    assert.equal(grouped.productSelectionLocked, true);
    assert.equal(grouped.lockedResultProductId, 'prod-L');
    assert.equal(grouped.resultProductName, 'Kemeja Lusin');
    assert.equal(grouped.targetQty, 3);
    assert.equal(grouped.totalPcs, 36);
    assert.equal(grouped.totalCost, 1800000);
    assert.equal(grouped.resultUnitCost, 600000);
    assert.equal(grouped.group.product_id, 'prod-L');
    assert.deepEqual(
      grouped.sourceProducts.map((p) => ({ productId: p.productId, serialCount: p.serialCount })),
      [{ productId: 'prod-L', serialCount: 3 }]
    );
  });

  test('explicitly selecting the SAME source product is accepted', async () => {
    const db = createMockSupabase(seedSameProduct());
    const grouped = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['A-001', 'A-002'],
      resultProductId: 'prod-A',
      targetUnit: 'pcs',
      warehouseId,
      supabaseClient: db,
    });

    assert.equal(grouped.success, true);
    assert.equal(grouped.lockedResultProductId, 'prod-A');
    assert.equal(grouped.group.product_id, 'prod-A');
  });

  test('resolveSourceProductPolicy counts verified members only', () => {
    const policy = resolveSourceProductPolicy([
      { product_id: 'prod-A', serial_number: 'SN-A-001', metadata: {} },
      { product_id: 'prod-A', serial_number: 'SN-A-002', metadata: {} },
    ]);
    assert.equal(policy.productSelectionLocked, true);
    assert.equal(policy.sourceProducts[0].totalPcs, 2);
  });
});

describe('PHASE 7E — Grouping reference (official goods_assembly number)', () => {
  const assemblyDoc = {
    id: 'doc-asm-1', owner_id: ownerId, document_number: 'ASM-20261021-ABC12345',
    document_type: 'goods_assembly', status: 'completed', issue_date: '2026-10-21',
  };
  const reversalDoc = {
    id: 'doc-dis-1', owner_id: ownerId, document_number: 'GD-20261021-ABC12345-12345678',
    document_type: 'goods_disassembly', status: 'completed', issue_date: '2026-10-22',
  };

  function seedGroupings() {
    return {
      products: [productLusin],
      documents: [assemblyDoc, reversalDoc],
      serial_groupings: [
        {
          id: 'grp-active', owner_id: ownerId, grouping_number: 'ASM-20261021-ABC12345',
          status: 'active', result_product_id: 'prod-L', result_serial_number: 'L-01-G-3LUSIN-211020260001',
          source_document_id: assemblyDoc.id, reverse_document_id: null,
          target_unit: 'lusin', target_qty: 3, total_base_qty_pcs: 36, total_cost: 1800000,
          result_unit_cost: 600000, created_at: '2026-10-21T10:00:00.000Z',
        },
        {
          id: 'grp-dissolved', owner_id: ownerId, grouping_number: 'ASM-20261021-ABC12345',
          status: 'dissolved', result_product_id: 'prod-L', result_serial_number: 'L-01-G-3LUSIN-211020260001',
          source_document_id: assemblyDoc.id, reverse_document_id: reversalDoc.id,
          target_unit: 'lusin', target_qty: 3, total_base_qty_pcs: 36, total_cost: 1800000,
          result_unit_cost: 600000, created_at: '2026-10-20T10:00:00.000Z',
        },
        {
          id: 'grp-legacy', owner_id: ownerId, grouping_number: 'GRP-LEGACY-0001',
          status: 'active', result_product_id: 'prod-L', result_serial_number: 'L-01-G-2LUSIN-201020260001',
          source_document_id: null, reverse_document_id: null,
          target_unit: 'lusin', target_qty: 2, total_base_qty_pcs: 24, total_cost: 1200000,
          result_unit_cost: 600000, created_at: '2026-10-19T10:00:00.000Z',
        },
      ],
    };
  }

  test('1+2. listing exposes the stored assembly document number', async () => {
    const db = createMockSupabase(seedGroupings());
    const list = await listSerialGroupings({ ownerId, limit: 10, supabaseClient: db });
    const active = list.find((g) => g.id === 'grp-active');

    assert.ok(active);
    assert.equal(active.reference_number, 'ASM-20261021-ABC12345');
    assert.equal(active.assembly_document_number, 'ASM-20261021-ABC12345');
    assert.equal(active.assembly_document_id, 'doc-asm-1');
    assert.equal(active.source_document.document_number, 'ASM-20261021-ABC12345');
  });

  test('3+4. reference survives ungroup and reversal stays traceable', async () => {
    const db = createMockSupabase(seedGroupings());
    const list = await listSerialGroupings({ ownerId, limit: 10, supabaseClient: db });
    const dissolved = list.find((g) => g.id === 'grp-dissolved');

    assert.ok(dissolved);
    assert.equal(dissolved.status, 'dissolved');
    // The historical assembly reference is NOT removed by the reversal.
    assert.equal(dissolved.reference_number, 'ASM-20261021-ABC12345');
    assert.equal(dissolved.assembly_document_id, 'doc-asm-1');
    // And the reversal document is traceable.
    assert.equal(dissolved.reversal_document_number, 'GD-20261021-ABC12345-12345678');
    assert.equal(dissolved.reversal_document_id, 'doc-dis-1');
    assert.equal(getReversalReference(dissolved), 'GD-20261021-ABC12345-12345678');
  });

  test('5. search finds rows by assembly and reversal reference', () => {
    const dissolvedRow = {
      grouping_number: 'ASM-20261021-ABC12345',
      result_serial_number: 'L-01-G-3LUSIN-211020260001',
      result_product: { name: 'Kemeja Lusin', sku: 'L-01' },
      assembly_document_number: 'ASM-20261021-ABC12345',
      reversal_document_number: 'GD-20261021-ABC12345-12345678',
    };

    assert.equal(matchesGroupingSearch(dissolvedRow, 'asm-2026'), true);
    assert.equal(matchesGroupingSearch(dissolvedRow, 'gd-2026'), true);
    assert.equal(matchesGroupingSearch(dissolvedRow, 'kemeja'), true);
    assert.equal(matchesGroupingSearch(dissolvedRow, 'tidak-ada'), false);
  });

  test('6. legacy rows without a document never fabricate a reference', async () => {
    const db = createMockSupabase(seedGroupings());
    const list = await listSerialGroupings({ ownerId, limit: 10, supabaseClient: db });
    const legacy = list.find((g) => g.id === 'grp-legacy');

    assert.ok(legacy);
    assert.equal(legacy.reference_number, null);
    assert.equal(legacy.assembly_document_id, null);
    assert.equal(legacy.assembly_document_number, null);
    assert.equal(getAssemblyReference(legacy), null);
    assert.equal(matchesGroupingSearch(legacy, 'asm-2026'), false);
  });

  test('7. list keeps a single query (no N+1) and respects offset/limit', async () => {
    const db = createMockSupabase(seedGroupings());
    let selectCalls = 0;
    const originalFrom = db.from.bind(db);
    db.from = (tableName) => {
      const builder = originalFrom(tableName);
      const originalSelect = builder.select;
      builder.select = (...args) => {
        selectCalls += 1;
        return originalSelect(...args);
      };
      return builder;
    };

    const page = await listSerialGroupings({ ownerId, limit: 1, offset: 1, supabaseClient: db });
    assert.equal(page.length, 1);
    assert.equal(page[0].id, 'grp-dissolved');
    assert.equal(selectCalls, 1, 'listing must use a single embedded query');
  });
});

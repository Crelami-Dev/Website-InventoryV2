import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createSerialGroup,
  previewSerialGroup,
  ungroupSerial,
  verifyScanSerialForGrouping,
} from '../src/services/serialGroup.service.js';

/**
 * PHASE 7D — Ungroup Restoration & Reversal Integrity
 *
 * Focus: after a successful ungroup,
 *   - the result serial is a terminal (dissolved) serial, never "available"
 *   - every component returns to its ORIGINAL product identity (from the
 *     persistent `serial_grouping_components` relation, not a guess)
 *   - the grouping header is dissolved and links its reversal document
 *   - the disassembly ledger references the original assembly document
 *   - double ungroup is an idempotent replay (no duplicate docs/ledger)
 *   - a failure while writing the ledger leaves NO partial reversal
 *
 * NOTE: this suite runs against an in-memory mock. It validates the code path;
 * it is NOT a substitute for a real isolated PostgreSQL integration test.
 */

function createMockSupabase(seed = {}) {
  const store = {
    products: seed.products ? [...seed.products] : [],
    product_serials: seed.product_serials ? [...seed.product_serials] : [],
    documents: [],
    document_items: [],
    serial_groupings: [],
    serial_grouping_components: [],
  };

  let rpcBehavior = null;
  let failDisassemblyDoc = false;

  function matchFilters(row, filters) {
    return filters.every((f) => {
      if (f.in) return f.in.has(row[f.col]);
      if (f.isNull) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
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
          const expected = rest.join('.');
          if (op === 'eq') return String(row[col]) === expected;
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
        if (tableName === 'documents' && failDisassemblyDoc && items.some((i) => i.document_type === 'goods_disassembly')) {
          throw new Error('simulated disassembly document write failure');
        }
        const inserted = items.map((item, idx) => {
          const row = {
            id: item.id || `mock-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${idx}`,
            created_at: item.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          if (tableName === 'product_serials') {
            const conflict = (store.product_serials || []).find(
              (s) => s.owner_id === row.owner_id && s.serial_number?.toLowerCase() === row.serial_number?.toLowerCase()
            );
            if (conflict) {
              const err = new Error('duplicate key value violates unique constraint "uq_product_serials_owner_number"');
              err.code = '23505';
              throw err;
            }
          }
          if (tableName === 'serial_groupings') {
            const conflict = (store.serial_groupings || []).find(
              (g) => g.owner_id === row.owner_id && g.grouping_number?.toLowerCase() === row.grouping_number?.toLowerCase()
            );
            if (conflict) {
              const err = new Error('duplicate key value violates unique constraint "uq_serial_groupings_owner_number"');
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
        const resRows = rows.map((r) => {
          if (tableName === 'product_serials') {
            const prod = (store.products || []).find((p) => p.id === r.product_id);
            return { ...r, product: prod || null };
          }
          return { ...r };
        });
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
    setRpcBehavior(fn) { rpcBehavior = fn; },
    setFailDisassemblyDoc(v) { failDisassemblyDoc = v; },
    rpc(name) {
      if (typeof rpcBehavior === 'function') return Promise.resolve(rpcBehavior(name));
      const err = new Error(`RPC function ${name} not available in mock`);
      err.code = '42883';
      return Promise.resolve({ data: null, error: err });
    },
  };
}

const ownerId = '11111111-1111-4111-a111-111111111111';
const userId = '22222222-2222-4222-a222-222222222222';
const warehouseId = '33333333-3333-4333-a333-333333333333';

const productA = { id: 'prod-A', owner_id: ownerId, name: 'Produk A', sku: 'A-01', category: 'Apparel', unit_cost: 1000, status: 'active', metadata: { unit: 'pcs' } };
const productB = { id: 'prod-B', owner_id: ownerId, name: 'Produk B', sku: 'B-01', category: 'Apparel', unit_cost: 2000, status: 'active', metadata: { unit: 'pcs' } };
const productC = { id: 'prod-C', owner_id: ownerId, name: 'Produk C', sku: 'C-01', category: 'Apparel', unit_cost: 3000, status: 'active', metadata: { unit: 'pcs' } };
const productX = { id: 'prod-X', owner_id: ownerId, name: 'Bundle X', sku: 'BUNDLE01', category: 'Bundle', unit_cost: 6000, status: 'active', metadata: { unit: 'pcs' } };

function seedCrossProduct() {
  return {
    products: [productA, productB, productC, productX],
    product_serials: [
      { id: 'A-001', owner_id: ownerId, product_id: 'prod-A', serial_number: 'SN-A-001', status: 'available', warehouse_id: warehouseId, metadata: {} },
      { id: 'B-001', owner_id: ownerId, product_id: 'prod-B', serial_number: 'SN-B-001', status: 'available', warehouse_id: warehouseId, metadata: {} },
      { id: 'C-001', owner_id: ownerId, product_id: 'prod-C', serial_number: 'SN-C-001', status: 'available', warehouse_id: warehouseId, metadata: {} },
    ],
  };
}

async function groupCrossProduct(db) {
  return createSerialGroup({
    ownerId,
    userId,
    memberSerialIds: ['A-001', 'B-001', 'C-001'],
    resultProductId: 'prod-X',
    targetUnit: 'pcs',
    warehouseId,
    supabaseClient: db,
  });
}

describe('PHASE 7D — Ungroup Restoration & Reversal Integrity Suite', () => {
  test('ungroup restores every component to its ORIGINAL product with the right status', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);
    assert.equal(grouped.success, true);

    const groupId = grouped.group.id;

    const ungrouped = await ungroupSerial({ ownerId, userId, groupId, supabaseClient: db });
    assert.equal(ungrouped.success, true);
    assert.equal(ungrouped.executionEngine, 'application_rollback_safe');
    assert.equal(ungrouped.releasedCount, 3);
    assert.match(ungrouped.documentNumber, /^GD-\d{8}-/);

    // Result serial must be terminal & unusable, not "available".
    const result = db.store.product_serials.find((s) => s.id === groupId);
    assert.equal(result.status, 'dissolved');
    assert.equal(result.metadata.isDissolved, true);
    assert.equal(result.metadata.isGrouped, false);

    // Each component back on its ORIGINAL product, available, ungrouped.
    for (const [serialId, productId, sn] of [['A-001', 'prod-A', 'SN-A-001'], ['B-001', 'prod-B', 'SN-B-001'], ['C-001', 'prod-C', 'SN-C-001']]) {
      const s = db.store.product_serials.find((x) => x.id === serialId);
      assert.equal(s.product_id, productId, `${sn} harus kembali ke produk asal`);
      assert.equal(s.status, 'available');
      assert.equal(s.metadata.isGrouped, false);
      assert.equal(s.metadata.parentGroupId, null);
    }

    // Grouping header dissolved + linked reversal document.
    const grouping = db.store.serial_groupings[0];
    assert.equal(grouping.status, 'dissolved');
    assert.ok(grouping.reverse_document_id);
    assert.equal(grouping.reverse_document_id, ungrouped.documentId);

    // Disassembly item products use the ORIGINAL component products, not Bundle X.
    const disDoc = db.store.documents.find((d) => d.document_type === 'goods_disassembly');
    assert.ok(disDoc);
    assert.equal(disDoc.status, 'completed');
    assert.equal(disDoc.metadata.originalAssemblyDocumentId, grouped.assemblyDoc.id);
    const disItems = db.store.document_items.filter((i) => i.document_id === disDoc.id);
    const compItems = disItems.filter((i) => i.metadata.assemblyRole === 'component');
    const resultItem = disItems.find((i) => i.metadata.assemblyRole === 'result');
    assert.deepEqual(compItems.map((i) => i.product_id).sort(), ['prod-A', 'prod-B', 'prod-C']);
    assert.equal(resultItem.product_id, 'prod-X');
    assert.equal(resultItem.metadata.movementType, 'out');
    assert.ok(compItems.every((i) => i.metadata.movementType === 'in'));
    assert.ok(compItems.every((i) => i.metadata.preGroupStatus === 'available'));
  });

  test('result serial is not eligible for grouping/goods-out after reversal', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);
    const groupSN = grouped.group.serial_number;

    await ungroupSerial({ ownerId, userId, groupId: grouped.group.id, supabaseClient: db });

    await assert.rejects(
      () => verifyScanSerialForGrouping({ ownerId, warehouseId, serialNumber: groupSN, supabaseClient: db }),
      /SERIAL_NOT_AVAILABLE|SERIAL_DISSOLVED|tidak tersedia/i
    );
  });

  test('double ungroup is an idempotent replay: no duplicate documents or ledger', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);

    const first = await ungroupSerial({ ownerId, userId, groupId: grouped.group.id, supabaseClient: db });
    const docsAfterFirst = db.store.documents.filter((d) => d.document_type === 'goods_disassembly').length;

    const second = await ungroupSerial({ ownerId, userId, groupId: grouped.group.id, supabaseClient: db });
    assert.equal(second.success, true);
    assert.equal(second.isReplay, true);
    assert.equal(second.documentId, first.documentId);
    assert.equal(second.executionEngine, 'idempotent_replay');

    const docsAfterSecond = db.store.documents.filter((d) => d.document_type === 'goods_disassembly').length;
    assert.equal(docsAfterSecond, docsAfterFirst, 'double ungroup tidak boleh membuat dokumen ganda');
  });

  test('components can be re-grouped after restoration (metadata truly cleared)', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);
    await ungroupSerial({ ownerId, userId, groupId: grouped.group.id, supabaseClient: db });

    const regrouped = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['A-001', 'B-001'],
      resultProductId: 'prod-X',
      targetUnit: 'pcs',
      warehouseId,
      supabaseClient: db,
    });
    assert.equal(regrouped.success, true);
    assert.equal(db.store.serial_groupings.length, 2);
  });

  test('a failure writing the disassembly ledger leaves NO partial reversal', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);
    const groupId = grouped.group.id;
    const groupSN = grouped.group.serial_number;

    db.setFailDisassemblyDoc(true);

    await assert.rejects(
      () => ungroupSerial({ ownerId, userId, groupId, supabaseClient: db }),
      /simulated disassembly|goods_disassembly/i
    );

    // Result serial must still be active/available (rollback happened).
    const result = db.store.product_serials.find((s) => s.id === groupId);
    assert.equal(result.status, 'available');
    assert.notEqual(result.metadata.isDissolved, true);

    // Components must still be grouped (rollback happened).
    for (const id of ['A-001', 'B-001', 'C-001']) {
      const s = db.store.product_serials.find((x) => x.id === id);
      assert.equal(s.metadata.isGrouped, true);
    }

    // Grouping header still active; no disassembly document persisted.
    assert.equal(db.store.serial_groupings[0].status, 'active');
    assert.equal(db.store.serial_groupings[0].reverse_document_id ?? null, null);
    assert.equal(db.store.documents.filter((d) => d.document_type === 'goods_disassembly').length, 0);

    // And the bundle serial is still usable.
    const verify = await verifyScanSerialForGrouping({ ownerId, warehouseId, serialNumber: groupSN, supabaseClient: db });
    assert.equal(verify.eligible, true);
  });

  test('component pre-grouping status snapshot is honored on restoration', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);

    // Simulate a component that was "reserved" before it ever joined (snapshot).
    const comp = db.store.serial_grouping_components.find((c) => c.component_serial_id === 'B-001');
    comp.metadata = { ...(comp.metadata || {}), preGroupStatus: 'reserved' };

    await ungroupSerial({ ownerId, userId, groupId: grouped.group.id, supabaseClient: db });
    const restored = db.store.product_serials.find((s) => s.id === 'B-001');
    assert.equal(restored.status, 'reserved');
  });

  test('tenant isolation: ungroup cannot touch another owner group', async () => {
    const db = createMockSupabase(seedCrossProduct());
    const grouped = await groupCrossProduct(db);

    await assert.rejects(
      () => ungroupSerial({ ownerId: 'other-owner', userId, groupId: grouped.group.id, supabaseClient: db }),
      /tidak ditemukan|Data group serial tidak ditemukan/i
    );
    assert.equal(db.store.serial_groupings[0].status, 'active');
  });

  test('verify-scan respects the unit & multiplier configured by the owner (differs per owner)', async () => {
    const db = createMockSupabase({
      products: [productA],
      product_serials: [
        { id: 'L-1', owner_id: ownerId, product_id: 'prod-A', serial_number: 'TEST1-LUSIN-151020260002', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'lusin', unitQty: 12 } },
      ],
    });

    // Owner #1: lusin = 12 pcs
    const ownerOne = await verifyScanSerialForGrouping({
      ownerId,
      warehouseId,
      serialNumber: 'TEST1-LUSIN-151020260002',
      customUnits: [{ key: 'pcs', multiplier: 1 }, { key: 'lusin', multiplier: 12 }],
      unitMultipliers: { pcs: 1, lusin: 12 },
      supabaseClient: db,
    });
    assert.equal(ownerOne.serial.unit, 'lusin');
    assert.equal(ownerOne.serial.unitQty, 1);
    assert.equal(ownerOne.serial.unitMultiplier, 12);
    assert.equal(ownerOne.serial.pcs, 12);

    // Owner #2: custom "lusin" = 10 pcs (multiplier beda per owner)
    const ownerTwo = await verifyScanSerialForGrouping({
      ownerId,
      warehouseId,
      serialNumber: 'TEST1-LUSIN-151020260002',
      customUnits: [{ key: 'pcs', multiplier: 1 }, { key: 'lusin', multiplier: 10 }],
      unitMultipliers: { pcs: 1, lusin: 10 },
      supabaseClient: db,
    });
    assert.equal(ownerTwo.serial.unitQty, 1);
    assert.equal(ownerTwo.serial.unitMultiplier, 10);
    assert.equal(ownerTwo.serial.pcs, 10);
  });

  test('preview treats Goods In metadata.unitQty as the multiplier, not the unit count', async () => {
    const db = createMockSupabase({
      products: [productA],
      product_serials: [
        { id: 'L-1', owner_id: ownerId, product_id: 'prod-A', serial_number: 'TEST1-LUSIN-151020260003', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'lusin', unitQty: 12 } },
        { id: 'L-2', owner_id: ownerId, product_id: 'prod-A', serial_number: 'TEST1-LUSIN-151020260004', status: 'available', warehouse_id: warehouseId, metadata: { unit: 'lusin', unitQty: 12 } },
      ],
    });

    const preview = await previewSerialGroup({
      ownerId,
      warehouseId,
      memberSerialIds: ['L-1', 'L-2'],
      targetUnit: 'lusin',
      supabaseClient: db,
    });

    assert.equal(preview.directMembers[0].unitQty, 1);
    assert.equal(preview.directMembers[0].pcs, 12);
    assert.equal(preview.totalBaseQtyPcs, 24);
    assert.equal(preview.totalPcs, 24);
    assert.equal(preview.targetQty, 2);
    assert.equal(preview.unitBreakdown, '2 lusin');
  });

  test('migration 025 ungroup RPC is hardened: components + terminal status + replay', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, '..', 'supabase', 'migrations', '025_serial_grouping_full_atomic_rpc.sql'),
      'utf8'
    );
    const ungroupBody = sql.slice(sql.indexOf('ungroup_serial_full_atomic_v1'));

    assert.match(ungroupBody, /serial_grouping_components/i, 'ungroup must read the persistent component relation');
    assert.match(ungroupBody, /'isReplay',\s*true/i, 'ungroup must support idempotent replay');
    assert.match(ungroupBody, /originalAssemblyDocumentId/i, 'reversal doc must reference the original assembly');
    // Result serial must be deactivated as dissolved, never left available.
    assert.ok(/'status'\s*=\s*'dissolved'/i.test(ungroupBody) || /set status = 'dissolved'/i.test(ungroupBody));
    assert.match(ungroupBody, /preGroupStatus/i, 'component status snapshot must be restored');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  escapeLikePattern,
  buildGroupingPayloadHash,
  createSerialGroup,
  ungroupSerial,
  processMultiSerialGroups,
  verifyScanSerialForGrouping,
} from '../src/services/serialGroup.service.js';

/**
 * PHASE 7C — Runtime & Database Hardening
 *
 * These tests focus on the hardening layer that was added on top of Phase 7B:
 *   - escaped ILIKE lookups (wildcard injection safety)
 *   - canonical idempotency payload hashing
 *   - ledger payload shape (metadata.qtyUnit / qtyInput, no top-level movement_type)
 *   - grouping header status ('active') & document status ('completed')
 *   - idempotent replay vs payload-mismatch rejection
 *   - independent multi-batch reporting (status / partial)
 *
 * NOTE: these run entirely against an in-memory mock. They prove the *code path*
 * behaves as designed, not that the real PostgreSQL RPC/migration is deployed.
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

  function buildQuery(tableName) {
    let rows = [...(store[tableName] || [])];
    let isSingle = false;
    let isMaybeSingle = false;

    const builder = {
      select() {
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
      is(col, val) {
        rows = val === null
          ? rows.filter((r) => r[col] === null || r[col] === undefined)
          : rows.filter((r) => r[col] === val);
        return builder;
      },
      in(col, vals) {
        const valSet = new Set(vals);
        rows = rows.filter((r) => valSet.has(r[col]));
        return builder;
      },
      ilike(col, pattern) {
        const regexStr = String(pattern).replace(/%/g, '.*');
        const reg = new RegExp(`^${regexStr}$`, 'i');
        rows = rows.filter((r) => reg.test(String(r[col] || '')));
        return builder;
      },
      or(expression) {
        const clauses = String(expression).split(',').map((c) => c.trim());
        rows = rows.filter((row) =>
          clauses.some((clause) => {
            const [col, op, ...rest] = clause.split('.');
            const expected = rest.join('.');
            if (op === 'eq') return String(row[col]) === expected;
            if (op === 'is') return expected === 'null' ? row[col] == null : String(row[col]) === expected;
            return false;
          })
        );
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
      limit(n) {
        rows = rows.slice(0, n);
        return builder;
      },
      range(from, to) {
        rows = rows.slice(from, to + 1);
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
          select() {
            const matching = rows.filter((r) => matchFilters(r, filters));
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
          eq(col, val) {
            filters.push({ col, val });
            return deleteBuilder;
          },
          then(resolve) {
            const matching = rows.filter((r) => matchFilters(r, filters));
            store[tableName] = store[tableName].filter((r) => !matching.includes(r));
            resolve({ data: matching, error: null });
          },
        };
        return deleteBuilder;
      },
      then(resolve) {
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

  function matchFilters(row, filters) {
    return filters.every((f) => {
      if (f.in) return f.in.has(row[f.col]);
      if (f.isNull) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }

  return {
    store,
    from(tableName) {
      return buildQuery(tableName);
    },
    setRpcBehavior(fn) {
      rpcBehavior = fn;
    },
    rpc(name, args) {
      if (typeof rpcBehavior === 'function') {
        return Promise.resolve(rpcBehavior(name, args));
      }
      const err = new Error(`RPC function ${name} not available in mock`);
      err.code = '42883';
      return Promise.resolve({ data: null, error: err });
    },
  };
}

const ownerId = '11111111-1111-4111-a111-111111111111';
const userId = '22222222-2222-4222-a222-222222222222';
const warehouseId = '33333333-3333-4333-a333-333333333333';

const product = {
  id: 'prod-1',
  owner_id: ownerId,
  name: 'Kemeja',
  sku: 'KEMEJA-01',
  category: 'Apparel',
  unit_cost: 10000,
  status: 'active',
  metadata: { unit: 'pcs' },
};

function makeSerials() {
  return [
    { id: 's1', owner_id: ownerId, product_id: product.id, serial_number: 'SN-P7C-1', status: 'available', warehouse_id: warehouseId, metadata: {} },
    { id: 's2', owner_id: ownerId, product_id: product.id, serial_number: 'SN-P7C-2', status: 'available', warehouse_id: warehouseId, metadata: {} },
    { id: 's3', owner_id: ownerId, product_id: product.id, serial_number: 'SN-P7C-3', status: 'available', warehouse_id: warehouseId, metadata: {} },
  ];
}

describe('PHASE 7C — Runtime & Database Hardening Suite', () => {
  test('escapeLikePattern escapes %, _ and backslash', () => {
    assert.equal(escapeLikePattern('SN-100%'), 'SN-100\\%');
    assert.equal(escapeLikePattern('batch_2'), 'batch\\_2');
    assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
    assert.equal(escapeLikePattern('plain'), 'plain');
    assert.equal(escapeLikePattern(null), '');
  });

  test('buildGroupingPayloadHash is order-independent and ignores derived fields', () => {
    const base = { memberIds: ['s1', 's2'], resultProductId: 'prod-1' };
    const reordered = { memberIds: ['s2', 's1'], resultProductId: 'prod-1' };
    assert.equal(buildGroupingPayloadHash(base), buildGroupingPayloadHash(reordered));

    const withNoise = { ...base, targetUnit: 'lusin', warehouseId: 'wh-x', notes: 'aside' };
    assert.equal(
      buildGroupingPayloadHash(base),
      buildGroupingPayloadHash(withNoise),
      'Derived fields (targetUnit/warehouse) must not change the idempotency hash'
    );

    const differentMembers = { memberIds: ['s1', 's3'], resultProductId: 'prod-1' };
    assert.notEqual(buildGroupingPayloadHash(base), buildGroupingPayloadHash(differentMembers));
  });

  test('buildGroupingPayloadHash only folds product name/SKU in when creating a new master product', () => {
    const reuse = {
      memberIds: ['s1', 's2'],
      resultProductId: 'prod-1',
      createNewMasterProduct: false,
      resultProductName: 'Name A',
      resultProductSku: 'AAA',
    };
    const reuseDifferentName = { ...reuse, resultProductName: 'Name B', resultProductSku: 'BBB' };
    assert.equal(buildGroupingPayloadHash(reuse), buildGroupingPayloadHash(reuseDifferentName));

    const createA = { memberIds: ['s1', 's2'], createNewMasterProduct: true, resultProductName: 'Name A', resultProductSku: 'AAA' };
    const createB = { memberIds: ['s1', 's2'], createNewMasterProduct: true, resultProductName: 'Name B', resultProductSku: 'BBB' };
    assert.notEqual(buildGroupingPayloadHash(createA), buildGroupingPayloadHash(createB));
  });

  test('createSerialGroup fallback writes a correct goods_assembly ledger (unit metadata + status)', async () => {
    const db = createMockSupabase({ products: [product], product_serials: makeSerials() });

    const res = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      warehouseId,
      supabaseClient: db,
    });

    assert.equal(res.success, true);
    assert.equal(res.executionEngine, 'application_rollback_safe');
    assert.equal(res.targetQty, 2);

    // Documents header
    assert.equal(db.store.documents.length, 1);
    const doc = db.store.documents[0];
    assert.equal(doc.document_type, 'goods_assembly');
    assert.equal(doc.status, 'completed');
    assert.match(doc.document_number, /^ASM-\d{8}-/);

    // Items: components + result
    assert.equal(db.store.document_items.length, 3);
    const components = db.store.document_items.filter((i) => i.metadata.assemblyRole === 'component');
    const resultItem = db.store.document_items.find((i) => i.metadata.assemblyRole === 'result');
    assert.equal(components.length, 2);
    assert.ok(components.every((i) => i.metadata.movementType === 'out'));
    assert.ok(components.every((i) => i.metadata.qtyUnit === 'pcs' && i.metadata.qtyInput === 1));
    assert.ok(!('movement_type' in components[0]), 'document_items must not carry a top-level movement_type column');
    assert.equal(resultItem.metadata.movementType, 'in');
    assert.equal(resultItem.metadata.qtyUnit, 'pcs');
    assert.equal(resultItem.metadata.qtyInput, 2);

    // Grouping header is 'active' (schema CHECK only allows active/dissolved/cancelled)
    assert.equal(db.store.serial_groupings.length, 1);
    assert.equal(db.store.serial_groupings[0].status, 'active');
    assert.equal(db.store.serial_grouping_components.length, 2);

    // Members marked grouped, result serial is a group
    const s1 = db.store.product_serials.find((s) => s.id === 's1');
    assert.equal(s1.metadata.isGrouped, true);
    const resultSerial = db.store.product_serials.find((s) => s.metadata?.isGroup);
    assert.ok(resultSerial);
    assert.equal(resultSerial.metadata.totalPcs, 2);
  });

  test('idempotent replay returns the original grouping and never duplicates the ledger', async () => {
    const db = createMockSupabase({ products: [product], product_serials: makeSerials() });

    const first = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      warehouseId,
      idempotencyKey: 'idem-7c-1',
      supabaseClient: db,
    });
    assert.equal(first.success, true);
    assert.equal(db.store.serial_groupings.length, 1);
    assert.equal(db.store.documents.length, 1);

    const second = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      warehouseId,
      idempotencyKey: 'idem-7c-1',
      supabaseClient: db,
    });
    assert.equal(second.success, true);
    assert.equal(second.isReplay, true);
    assert.equal(second.executionEngine, 'idempotent_replay');
    assert.equal(db.store.serial_groupings.length, 1, 'replay must not create a second grouping');
    assert.equal(db.store.documents.length, 1, 'replay must not create a second ledger document');
  });

  test('reusing an idempotency key with a different payload is rejected', async () => {
    const db = createMockSupabase({ products: [product], product_serials: makeSerials() });

    await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      warehouseId,
      idempotencyKey: 'idem-7c-2',
      supabaseClient: db,
    });

    await assert.rejects(
      () => createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['s1', 's3'],
        targetUnit: 'pcs',
        warehouseId,
        idempotencyKey: 'idem-7c-2',
        supabaseClient: db,
      }),
      /IDEMPOTENCY_PAYLOAD_MISMATCH/
    );

    assert.equal(db.store.serial_groupings.length, 1);
    assert.equal(db.store.documents.length, 1);
  });

  test('processMultiSerialGroups isolates failures and reports partial status', async () => {
    const serials = makeSerials();
    serials.push({ id: 's4', owner_id: ownerId, product_id: product.id, serial_number: 'SN-P7C-4', status: 'available', warehouse_id: warehouseId, metadata: {} });
    serials[2].status = 'out';
    serials[2].goods_out_document_id = 'doc-out-1';

    const db = createMockSupabase({ products: [product], product_serials: serials });

    const res = await processMultiSerialGroups({
      ownerId,
      userId,
      warehouseId,
      batches: [
        { batchId: 'batch-1', name: 'Valid', memberSerialIds: ['s1', 's2'], targetUnit: 'pcs' },
        { batchId: 'batch-2', name: 'Broken', memberSerialIds: ['s3', 's4'], targetUnit: 'pcs' },
      ],
      supabaseClient: db,
    });

    assert.equal(res.summary.total, 2);
    assert.equal(res.summary.succeeded, 1);
    assert.equal(res.summary.failed, 1);
    assert.equal(res.summary.partial, true);
    assert.equal(res.summary.status, 'partial');

    const b1 = res.results.find((r) => r.batchId === 'batch-1');
    const b2 = res.results.find((r) => r.batchId === 'batch-2');
    assert.equal(b1.success, true);
    assert.equal(b1.status, 'created');
    assert.equal(b2.success, false);
    assert.equal(b2.status, 'failed');
    assert.match(b2.error.message, /tidak tersedia|sudah dikeluarkan|tidak dapat/i);
  });

  test('verifyScanSerialForGrouping rejects already-grouped serials and escapes lookups', async () => {
    const serials = makeSerials();
    serials[0].metadata = { isGrouped: true, parentGroupId: 'g-1', parentGroupSerialNumber: 'SN-PARENT' };

    const db = createMockSupabase({ products: [product], product_serials: serials });

    await assert.rejects(
      () => verifyScanSerialForGrouping({ ownerId, warehouseId, serialNumber: 'SN-P7C-1', supabaseClient: db }),
      /ALREADY_GROUPED/
    );

    await assert.rejects(
      () => verifyScanSerialForGrouping({ ownerId, warehouseId, serialNumber: 'SN-100%-JOKER', supabaseClient: db }),
      /SERIAL_NOT_FOUND/
    );

    const ok = await verifyScanSerialForGrouping({ ownerId, warehouseId, serialNumber: 'SN-P7C-2', supabaseClient: db });
    assert.equal(ok.eligible, true);
    assert.equal(ok.serial.id, 's2');
  });

  test('ungroupSerial fallback writes a goods_disassembly ledger and dissolves the grouping', async () => {
    const db = createMockSupabase({ products: [product], product_serials: makeSerials() });

    // Build an active group through the service first.
    const created = await createSerialGroup({
      ownerId,
      userId,
      memberSerialIds: ['s1', 's2'],
      targetUnit: 'pcs',
      warehouseId,
      supabaseClient: db,
    });
    assert.equal(created.success, true);
    const groupId = created.group.id;

    const grouping = db.store.serial_groupings[0];
    grouping.target_unit = 'pcs';
    grouping.target_qty = 2;
    grouping.total_base_qty_pcs = 2;
    grouping.result_unit_cost = 20000;

    const ungrouped = await ungroupSerial({ ownerId, userId, groupId, supabaseClient: db });
    assert.equal(ungrouped.success, true);
    assert.equal(ungrouped.executionEngine, 'application_rollback_safe');
    assert.match(ungrouped.documentNumber, /^GD-\d{8}-/);

    const disDoc = db.store.documents.find((d) => d.document_type === 'goods_disassembly');
    assert.ok(disDoc, 'disassembly ledger document must be created');
    assert.equal(disDoc.status, 'completed');
    assert.match(disDoc.document_number, /^GD-\d{8}-/);

    const disItems = db.store.document_items.filter((i) => i.document_id === disDoc.id);
    assert.ok(disItems.length >= 3);
    assert.ok(disItems.every((i) => i.metadata.qtyUnit !== undefined && i.metadata.qtyInput !== undefined));
    assert.ok(!('movement_type' in disItems[0]));

    assert.equal(db.store.serial_groupings[0].status, 'dissolved');
    assert.equal(db.store.product_serials.find((s) => s.id === groupId).metadata.isDissolved, true);
  });

  test('migration 025 defines the full atomic RPCs with a valid row-lock count check', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, '..', 'supabase', 'migrations', '025_serial_grouping_full_atomic_rpc.sql'),
      'utf8'
    );

    assert.match(sql, /create or replace function .*create_serial_group_full_atomic_v1/i);
    assert.match(sql, /create or replace function .*ungroup_serial_full_atomic_v1/i);
    assert.match(sql, /for update/i);
    assert.match(sql, /get diagnostics/i, 'locked-member count must use GET DIAGNOSTICS, not SELECT count(*) FOR UPDATE');
    assert.ok(!/select\s+count\s*\(\s*\*\s*\)\s+for\s+update/i.test(sql), 'SELECT count(*) FOR UPDATE is invalid PostgreSQL');
    assert.match(sql, /grant execute[\s\S]*?to service_role/i);
  });
});

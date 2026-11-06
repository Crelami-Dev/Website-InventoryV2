import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createSerialGroup,
  previewSerialGroup,
  handleRpcExecutionError,
} from '../src/services/serialGroup.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendRoot = resolve(__dirname, '..');
const envModuleUrl = pathToFileURL(resolve(backendRoot, 'src', 'config', 'env.js')).href;
const bootstrapUrl = pathToFileURL(resolve(backendRoot, 'tests', 'bootstrap-env.mjs')).href;

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
    let isMaybeSingle = false;

    const builder = {
      select() { return builder; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return builder; },
      in(col, vals) { const s = new Set(vals); rows = rows.filter((r) => s.has(r[col])); return builder; },
      ilike(col, pattern) {
        const reg = new RegExp(`^${String(pattern).replace(/%/g, '.*')}$`, 'i');
        rows = rows.filter((r) => reg.test(String(r[col] || '')));
        return builder;
      },
      order(col, { ascending = true } = {}) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? (ascending ? -1 : 1) : (a[col] > b[col] ? (ascending ? 1 : -1) : 0)));
        return builder;
      },
      maybeSingle() { isMaybeSingle = true; return builder; },
      insert(payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((item, idx) => {
          const row = {
            id: item.id || `mock-${tableName}-${Date.now()}-${idx}`,
            created_at: new Date().toISOString(),
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
              then(resolveFn) { resolveFn({ data: inserted, error: null }); },
            };
          },
          then(resolveFn) { resolveFn({ data: inserted, error: null }); },
        };
      },
      update(updates) {
        const filters = [];
        const updateBuilder = {
          eq(col, val) { filters.push({ col, val }); return updateBuilder; },
          in(col, valList) { filters.push({ col, in: new Set(valList) }); return updateBuilder; },
          select() {
            return {
              single() { return Promise.resolve({ data: null, error: null }); },
              then(resolveFn) { resolveFn({ data: [], error: null }); },
            };
          },
          then(resolveFn) {
            rows.filter((r) => matchFilters(r, filters)).forEach((r) => Object.assign(r, updates));
            resolveFn({ data: [], error: null });
          },
        };
        return updateBuilder;
      },
      delete() {
        const filters = [];
        const deleteBuilder = {
          eq(col, val) { filters.push({ col, val }); return deleteBuilder; },
          then(resolveFn) {
            const matching = rows.filter((r) => matchFilters(r, filters));
            store[tableName] = store[tableName].filter((r) => !matching.includes(r));
            resolveFn({ data: matching, error: null });
          },
        };
        return deleteBuilder;
      },
      then(resolveFn) {
        const resRows = rows.map((r) => withEmbeds(tableName, r));
        if (isMaybeSingle) resolveFn({ data: resRows[0] || null, error: null });
        else resolveFn({ data: resRows, error: null });
      },
    };
    return builder;
  }

  return {
    store,
    from(tableName) { return buildQuery(tableName); },
    rpc() {
      const err = new Error('RPC function not available in mock');
      err.code = '42883';
      return Promise.resolve({ data: null, error: err });
    },
  };
}

const productA = {
  id: 'prod-A', owner_id: ownerId, name: 'Produk A', sku: 'A-01', category: 'Apparel',
  unit_cost: 1000, status: 'active', metadata: { unit: 'pcs' },
};

function serial(id, sn) {
  return {
    id, owner_id: ownerId, product_id: 'prod-A', serial_number: sn,
    status: 'available', warehouse_id: warehouseId, metadata: {},
  };
}

describe('PHASE 7G — Case-insensitive serial identity (service/mock)', () => {
  it('rejects member numbers that differ only by case before touching the database', async () => {
    const db = createMockSupabase({ products: [productA], product_serials: [serial('A-001', 'ABC001'), serial('A-002', 'ABC002')] });
    const before = db.store.product_serials.length;

    await assert.rejects(
      () => createSerialGroup({
        ownerId,
        userId,
        memberSerialNumbers: ['ABC001', 'abc001'],
        targetUnit: 'pcs',
        warehouseId,
        supabaseClient: db,
      }),
      /DUPLICATE_MEMBERS/,
    );

    assert.equal(db.store.product_serials.length, before);
    assert.equal(db.store.serial_groupings.length, 0);
  });

  it('resolves member serial numbers case-insensitively and keeps the product lock', async () => {
    const db = createMockSupabase({
      products: [productA],
      product_serials: [serial('A-001', 'SN-A-001'), serial('A-002', 'SN-A-002')],
    });

    const preview = await previewSerialGroup({
      ownerId,
      memberSerialNumbers: ['sn-a-001', 'Sn-A-002'],
      targetUnit: 'pcs',
      supabaseClient: db,
    });

    assert.equal(preview.productSelectionLocked, true);
    assert.equal(preview.lockedResultProductId, 'prod-A');
    assert.equal(preview.sourceProducts[0].serialCount, 2);
  });

  it('rejects a group serial number that only differs by case from an existing serial', async () => {
    const db = createMockSupabase({
      products: [productA],
      product_serials: [
        serial('A-001', 'SN-A-001'),
        serial('A-002', 'SN-A-002'),
        serial('G-001', 'GRP-EXIST'),
      ],
    });

    await assert.rejects(
      () => createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['A-001', 'A-002'],
        groupSerialNumber: 'grp-exist',
        targetUnit: 'pcs',
        warehouseId,
        supabaseClient: db,
      }),
      /sudah pernah digunakan/i,
    );

    assert.equal(db.store.serial_groupings.length, 0);
  });

  it('maps unique-violation and RPC product-lock errors to business errors', () => {
    assert.throws(
      () => handleRpcExecutionError({ code: '23505', message: 'duplicate key value violates unique constraint' }),
      /sudah pernah digunakan/i,
    );

    assert.throws(
      () => handleRpcExecutionError({ code: 'P0006', message: 'PRODUCT_LOCKED_SINGLE_SOURCE: ...' }),
      (err) => {
        assert.equal(err.code, 'PRODUCT_LOCKED_SINGLE_SOURCE');
        assert.equal(err.status, 400);
        return true;
      },
    );
  });
});

describe('PHASE 7G — Test environment safety', () => {
  it('runs with forced dummy values before any application config is loaded', () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.DOCUFLOW_TEST_ENV_READY, '1');
    assert.equal(new URL(process.env.SUPABASE_URL).hostname, 'docuflow-test.invalid');
    assert.match(process.env.SUPABASE_ANON_KEY, /^test-/);
    assert.match(process.env.SUPABASE_SERVICE_ROLE_KEY, /^test-/);
  });

  it('builds the Supabase client against the non-resolvable placeholder host', async () => {
    const { supabaseAdmin } = await import('../src/lib/supabase.js');
    assert.equal(new URL(supabaseAdmin.supabaseUrl).hostname, 'docuflow-test.invalid');
  });

  it('fails closed when the test runner is active without the bootstrap', () => {
    const env = { ...process.env };
    delete env.DOCUFLOW_TEST_ENV_READY;
    env.NODE_TEST_CONTEXT = 'child-v8';
    env.NODE_ENV = 'test';
    env.SUPABASE_URL = 'https://fake-project.supabase.co';
    env.SUPABASE_ANON_KEY = 'test-anon-key';
    env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(envModuleUrl)});`],
      { cwd: backendRoot, env, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /Test environment bootstrap missing or unsafe/i);
  });

  it('lets the bootstrap override pre-existing hosted values and local .env', () => {
    const env = { ...process.env };
    env.NODE_TEST_CONTEXT = 'child-v8';
    env.NODE_ENV = 'production';
    env.SUPABASE_URL = 'https://fake-project.supabase.co';
    env.SUPABASE_ANON_KEY = 'real-anon-key';
    env.SUPABASE_SERVICE_ROLE_KEY = 'real-service-role-key';
    env.DOCUFLOW_TEST_ENV_READY = '0';

    const code = `const { env } = await import(${JSON.stringify(envModuleUrl)});`
      + `console.log(JSON.stringify({ host: new URL(env.SUPABASE_URL).hostname, nodeEnv: env.NODE_ENV }));`;

    const result = spawnSync(
      process.execPath,
      ['--import', bootstrapUrl, '--input-type=module', '-e', code],
      { cwd: backendRoot, env, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      host: 'docuflow-test.invalid',
      nodeEnv: 'test',
    });
  });

  it('official test command loads the bootstrap module', () => {
    const pkg = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.test, /--import\s+\.\/tests\/bootstrap-env\.mjs/);
  });
});

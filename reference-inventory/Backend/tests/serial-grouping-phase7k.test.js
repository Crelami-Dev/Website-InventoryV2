import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateGroupingSessionNumber,
  createGroupingSession,
  confirmGroupingSession,
  cancelGroupingSession,
  listGroupingSessions,
} from '../src/services/serialGroup.service.js';
import {
  getGroupingSessionRow,
  getGroupingDisplayRow,
} from '../../frontend-new/src/pages/SerialGrouping/serialGroupingDisplay.js';
import {
  matchesGroupingSessionSearch,
} from '../../frontend-new/src/pages/SerialGrouping/serialGroupingReference.js';

function seedCatalog(ownerId, definitions, warehouseId = 'wh-1') {
  const products = [];
  const product_serials = [];

  for (const definition of definitions) {
    products.push({
      id: definition.id,
      owner_id: ownerId,
      name: definition.name,
      sku: definition.sku,
      status: 'active',
      unit_cost: definition.unitCost || 0,
      metadata: { unit: definition.unit || 'pcs' },
    });

    for (const serial of definition.serials) {
      product_serials.push({
        id: serial.id,
        owner_id: ownerId,
        product_id: definition.id,
        serial_number: serial.sn,
        status: serial.status || 'available',
        warehouse_id: warehouseId,
        goods_out_document_id: null,
        metadata: serial.metadata || {},
      });
    }
  }

  return { products, product_serials };
}

function createMockSupabase(initialData = {}) {
  const store = {
    products: [...(initialData.products || [])],
    product_serials: [...(initialData.product_serials || [])],
    documents: [...(initialData.documents || [])],
    document_items: [...(initialData.document_items || [])],
    serial_groupings: [...(initialData.serial_groupings || [])],
    serial_grouping_components: [...(initialData.serial_grouping_components || [])],
    serial_grouping_sessions: [...(initialData.serial_grouping_sessions || [])],
  };

  let sequence = 0;
  const nextId = (prefix) => `${prefix}-${Date.now()}-${++sequence}`;

  function buildQuery(tableName) {
    let rows = store[tableName] || [];
    let mode = 'select';
    let updatePatch = null;
    let singleMode = null;

    const builder = {
      select() {
        return builder;
      },
      is(col, val) {
        rows = rows.filter((row) => (val === null
          ? row[col] === null || row[col] === undefined
          : row[col] === val));
        return builder;
      },
      eq(col, val) {
        rows = rows.filter((row) => row[col] === val);
        return builder;
      },
      neq(col, val) {
        rows = rows.filter((row) => row[col] !== val);
        return builder;
      },
      in(col, vals) {
        const valSet = new Set(vals);
        rows = rows.filter((row) => valSet.has(row[col]));
        return builder;
      },
      ilike(col, pattern) {
        const regexStr = String(pattern).replace(/%/g, '.*');
        const reg = new RegExp(`^${regexStr}$`, 'i');
        rows = rows.filter((row) => reg.test(String(row[col] || '')));
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
      range(start, end) {
        rows = rows.slice(start, end + 1);
        return builder;
      },
      single() {
        singleMode = 'single';
        return builder;
      },
      maybeSingle() {
        singleMode = 'maybeSingle';
        return builder;
      },
      insert(payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((item) => ({
          id: item.id || nextId(`mock-${tableName}`),
          created_at: item.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...item,
        }));
        if (!store[tableName]) store[tableName] = [];
        store[tableName].push(...inserted);

        return {
          select: () => ({
            single: async () => ({ data: inserted[0], error: null }),
            maybeSingle: async () => ({ data: inserted[0], error: null }),
            then: (resolve) => resolve({ data: inserted, error: null }),
          }),
          single: async () => ({ data: inserted[0], error: null }),
          maybeSingle: async () => ({ data: inserted[0], error: null }),
          then: (resolve) => resolve({ data: inserted, error: null }),
        };
      },
      update(patch) {
        mode = 'update';
        updatePatch = patch;
        return builder;
      },
      then(resolve) {
        if (mode === 'update') {
          for (const row of rows) {
            Object.assign(row, updatePatch, { updated_at: new Date().toISOString() });
          }
          if (singleMode === 'single') {
            resolve(rows.length > 0
              ? { data: rows[0], error: null }
              : { data: null, error: { code: 'PGRST116', message: 'Row not found' } });
          } else {
            resolve({ data: rows, error: null });
          }
          return;
        }

        let data = rows;
        if (tableName === 'product_serials') {
          data = rows.map((row) => ({
            ...row,
            product: store.products.find((product) => (
              product.id === row.product_id
              && product.owner_id === row.owner_id
              && product.status === 'active'
            )) || null,
          }));
        }

        if (singleMode === 'single') {
          resolve(data.length > 0
            ? { data: data[0], error: null }
            : { data: null, error: { code: 'PGRST116', message: 'Row not found' } });
        } else if (singleMode === 'maybeSingle') {
          resolve({ data: data[0] || null, error: null });
        } else {
          resolve({ data, error: null });
        }
      },
    };

    return builder;
  }

  async function rpc(functionName, params) {
    if (functionName !== 'confirm_serial_grouping_session_atomic_v1') {
      return {
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' },
      };
    }

    const session = store.serial_grouping_sessions.find((row) => (
      row.id === params.p_session_id && row.owner_id === params.p_owner_id
    ));
    if (!session) {
      return { data: null, error: { code: 'P0002', message: 'Sesi grouping tidak ditemukan.' } };
    }
    if (session.status === 'completed') {
      return {
        data: {
          success: true,
          alreadyConfirmed: true,
          session,
          results: session.metadata?.processResult?.results || [],
          summary: session.metadata?.processResult?.summary || {},
        },
        error: null,
      };
    }
    if (session.status !== 'pending') {
      return { data: null, error: { code: 'P0001', message: 'Sesi tidak berstatus pending.' } };
    }

    for (const batch of params.p_batches || []) {
      for (const memberId of batch.member_ids || []) {
        const serial = store.product_serials.find((row) => (
          row.id === memberId && row.owner_id === params.p_owner_id
        ));
        if (!serial || serial.status !== 'available' || serial.metadata?.isGrouped) {
          return {
            data: null,
            error: { code: 'P0003', message: 'Nomor seri sudah tidak tersedia atau berada di group lain.' },
          };
        }
      }
    }

    const results = [];
    for (const batch of params.p_batches || []) {
      const resultSerialId = nextId('result-serial');
      const groupingId = nextId('grouping');

      store.product_serials.push({
        id: resultSerialId,
        owner_id: params.p_owner_id,
        product_id: batch.product_id,
        serial_number: batch.group_serial_number,
        status: 'available',
        warehouse_id: session.warehouse_id,
        goods_out_document_id: null,
        metadata: batch.metadata || {},
      });

      store.serial_groupings.push({
        id: groupingId,
        owner_id: params.p_owner_id,
        session_id: params.p_session_id,
        grouping_number: batch.group_serial_number,
        result_serial_id: resultSerialId,
        result_serial_number: batch.group_serial_number,
        result_product_id: batch.product_id,
        status: 'active',
        metadata: batch.metadata || {},
        created_at: new Date().toISOString(),
      });

      for (const memberId of batch.member_ids || []) {
        const serial = store.product_serials.find((row) => row.id === memberId);
        serial.metadata = { ...(serial.metadata || {}), isGrouped: true, parentGroupId: resultSerialId };
      }

      results.push({
        batchId: batch.batch_id,
        batchName: batch.batch_name,
        success: true,
        groupingId,
        groupingNumber: batch.group_serial_number,
        resultSerialId,
        resultSerialNumber: batch.group_serial_number,
      });
    }

    const summary = {
      total: results.length,
      succeeded: results.length,
      failed: 0,
      allSucceeded: true,
      partial: false,
      status: 'success',
    };

    session.status = 'completed';
    session.confirmed_at = new Date().toISOString();
    session.confirmed_by = params.p_user_id;
    session.updated_at = new Date().toISOString();
    session.metadata = {
      ...(session.metadata || {}),
      processResult: { results, summary },
    };

    return {
      data: {
        success: true,
        alreadyConfirmed: false,
        session,
        results,
        summary,
      },
      error: null,
    };
  }

  return {
    from: (table) => buildQuery(table),
    rpc,
    store,
  };
}

describe('PHASE 7K - Grouping Session Creation & Pending Workflow', () => {
  it('generates consistent GRP-SES-YYYYMMDD-XXXX session reference', async () => {
    const mockDb = createMockSupabase();
    const sessionNum = await generateGroupingSessionNumber({
      ownerId: 'owner-test-1',
      date: new Date('2026-10-23T10:00:00.000Z'),
      supabaseClient: mockDb,
    });

    assert.match(sessionNum, /^GRP-SES-20261023-\d{4}$/);
  });

  it('saving as Pending stores session header and candidate batches without mutating ledger or serials', async () => {
    const ownerId = 'owner-pending-1';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-kmj',
        name: 'Kemeja Putih',
        sku: 'KMJ-01',
        serials: [
          { id: 'sn-p1', sn: 'SRC-001' },
          { id: 'sn-p2', sn: 'SRC-002' },
        ],
      },
      {
        id: 'prod-cln',
        name: 'Celana Hitam',
        sku: 'CLN-01',
        serials: [
          { id: 'sn-p3', sn: 'SRC-003' },
          { id: 'sn-p4', sn: 'SRC-004' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    const result = await createGroupingSession({
      ownerId,
      userId: 'user-1',
      sessionName: 'Sesi Tes Pending Dua Batch',
      warehouseId: 'wh-1',
      isPending: true,
      batches: [
        {
          id: 'batch-1',
          name: 'Batch 1 - Kemeja',
          serials: [
            { id: 'sn-p1', serialNumber: 'SRC-001' },
            { id: 'sn-p2', serialNumber: 'SRC-002' },
          ],
          targetProductId: 'prod-kmj',
          targetProductName: 'Kemeja Putih',
          targetProductSku: 'KMJ-01',
          targetUnit: 'pcs',
          targetQty: 2,
        },
        {
          id: 'batch-2',
          name: 'Batch 2 - Celana',
          serials: [
            { id: 'sn-p3', serialNumber: 'SRC-003' },
            { id: 'sn-p4', serialNumber: 'SRC-004' },
          ],
          targetProductId: 'prod-cln',
          targetProductName: 'Celana Hitam',
          targetProductSku: 'CLN-01',
          targetUnit: 'pcs',
          targetQty: 2,
        },
      ],
      supabaseClient: mockDb,
    });

    assert.equal(result.success, true);
    assert.equal(result.isPending, true);
    assert.equal(result.data.status, 'pending');
    assert.match(result.data.session_number, /^GRP-SES-/);
    assert.equal(result.data.total_batches, 2);
    assert.equal(result.data.total_serials, 4);
    assert.equal(mockDb.store.documents.length, 0, 'Pending must not create an assembly document');
    assert.ok(mockDb.store.product_serials.every((serial) => !serial.metadata?.isGrouped));

    assert.equal(result.data.batches.length, 2);
    assert.equal(result.data.batches[0].name, 'Batch 1 - Kemeja');
    assert.equal(result.data.batches[1].name, 'Batch 2 - Celana');
    assert.deepEqual(result.data.batches[0].memberSerialIds, ['sn-p1', 'sn-p2']);
    assert.deepEqual(result.data.batches[1].memberSerialIds, ['sn-p3', 'sn-p4']);
  });

  it('rejects batch with less than 2 serials', async () => {
    const mockDb = createMockSupabase();
    await assert.rejects(
      async () => {
        await createGroupingSession({
          ownerId: 'owner-err-1',
          isPending: true,
          batches: [
            {
              id: 'batch-1',
              name: 'Batch Kosong',
              serials: [{ id: 'sn-single', serialNumber: 'SN-01' }],
            },
          ],
          supabaseClient: mockDb,
        });
      },
      /memerlukan minimal 2 nomor seri/i,
    );
  });
});

describe('PHASE 7K - Main Table: One Primary Row per Grouping Session', () => {
  it('multi-batch in 1 session produces exactly 1 session header row', async () => {
    const ownerId = 'owner-multi-row-1';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-a',
        name: 'Produk A',
        sku: 'A-01',
        serials: [
          { id: 's1', sn: 'SN-1' },
          { id: 's2', sn: 'SN-2' },
        ],
      },
      {
        id: 'prod-b',
        name: 'Produk B',
        sku: 'B-01',
        serials: [
          { id: 's3', sn: 'SN-3' },
          { id: 's4', sn: 'SN-4' },
        ],
      },
      {
        id: 'prod-c',
        name: 'Produk C',
        sku: 'C-01',
        serials: [
          { id: 's5', sn: 'SN-5' },
          { id: 's6', sn: 'SN-6' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Tiga Batch',
      warehouseId: 'wh-1',
      isPending: true,
      batches: [
        {
          id: 'b-1',
          name: 'Batch 1',
          targetProductId: 'prod-a',
          serials: [{ id: 's1', serialNumber: 'SN-1' }, { id: 's2', serialNumber: 'SN-2' }],
        },
        {
          id: 'b-2',
          name: 'Batch 2',
          targetProductId: 'prod-b',
          serials: [{ id: 's3', serialNumber: 'SN-3' }, { id: 's4', serialNumber: 'SN-4' }],
        },
        {
          id: 'b-3',
          name: 'Batch 3',
          targetProductId: 'prod-c',
          serials: [{ id: 's5', serialNumber: 'SN-5' }, { id: 's6', serialNumber: 'SN-6' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const sessions = await listGroupingSessions({
      ownerId,
      supabaseClient: mockDb,
    });

    assert.equal(sessions.length, 1, 'Multi-batch session must appear as exactly 1 row');
    assert.equal(sessions[0].totalBatches, 3);
    assert.equal(sessions[0].totalSerials, 6);
    assert.equal(sessions[0].name, 'Sesi Tiga Batch');
    assert.equal(sessions[0].batches.length, 3);
  });

  it('two distinct sessions produce two separate header rows', async () => {
    const ownerId = 'owner-two-sessions';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-p',
        name: 'Produk Pagi',
        sku: 'PG-01',
        serials: [
          { id: 'sp1', sn: 'SP-1' },
          { id: 'sp2', sn: 'SP-2' },
        ],
      },
      {
        id: 'prod-s',
        name: 'Produk Siang',
        sku: 'SG-01',
        serials: [
          { id: 'ss1', sn: 'SS-1' },
          { id: 'ss2', sn: 'SS-2' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Pagi',
      isPending: true,
      batches: [
        {
          id: 'b-p1',
          name: 'Batch Pagi',
          targetProductId: 'prod-p',
          serials: [{ id: 'sp1', serialNumber: 'SP-1' }, { id: 'sp2', serialNumber: 'SP-2' }],
        },
      ],
      supabaseClient: mockDb,
    });

    await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Siang',
      isPending: true,
      batches: [
        {
          id: 'b-s1',
          name: 'Batch Siang',
          targetProductId: 'prod-s',
          serials: [{ id: 'ss1', serialNumber: 'SS-1' }, { id: 'ss2', serialNumber: 'SS-2' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const sessions = await listGroupingSessions({
      ownerId,
      supabaseClient: mockDb,
    });

    assert.equal(sessions.length, 2, 'Two sessions must produce 2 distinct header rows');
    assert.notEqual(sessions[0].id, sessions[1].id);
    assert.notEqual(sessions[0].sessionNumber, sessions[1].sessionNumber);
  });
});

describe('PHASE 7K - Expand Header & Component Isolation', () => {
  it('expanding header shows all batches in the session', async () => {
    const ownerId = 'owner-expand-test';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-merah',
        name: 'Produk Merah',
        sku: 'MRH-01',
        serials: [
          { id: 'sa1', sn: 'SA-1' },
          { id: 'sa2', sn: 'SA-2' },
        ],
      },
      {
        id: 'prod-biru',
        name: 'Produk Biru',
        sku: 'BRU-01',
        serials: [
          { id: 'sb1', sn: 'SB-1' },
          { id: 'sb2', sn: 'SB-2' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    const created = await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Expand',
      isPending: true,
      batches: [
        {
          id: 'batch-a',
          name: 'Batch A - Merah',
          targetProductId: 'prod-merah',
          targetProductName: 'Produk Merah',
          serials: [{ id: 'sa1', serialNumber: 'SA-1' }, { id: 'sa2', serialNumber: 'SA-2' }],
        },
        {
          id: 'batch-b',
          name: 'Batch B - Biru',
          targetProductId: 'prod-biru',
          targetProductName: 'Produk Biru',
          serials: [{ id: 'sb1', serialNumber: 'SB-1' }, { id: 'sb2', serialNumber: 'SB-2' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const displayRow = getGroupingSessionRow(created.data);
    assert.equal(displayRow.batches.length, 2);
    assert.equal(displayRow.batches[0].name, 'Batch A - Merah');
    assert.equal(displayRow.batches[1].name, 'Batch B - Biru');
  });

  it('expanding batch shows strictly its own component SNs without cross-batch mingling', async () => {
    const batch1Serials = [
      { id: 'sn-b1-1', serialNumber: 'KEMEJA-001', productName: 'Kemeja' },
      { id: 'sn-b1-2', serialNumber: 'KEMEJA-002', productName: 'Kemeja' },
    ];
    const batch2Serials = [
      { id: 'sn-b2-1', serialNumber: 'CELANA-001', productName: 'Celana' },
      { id: 'sn-b2-2', serialNumber: 'CELANA-002', productName: 'Celana' },
    ];

    const session = {
      id: 'ses-isolation-1',
      sessionNumber: 'GRP-SES-20261023-0099',
      name: 'Sesi Isolasi Komponen',
      status: 'pending',
      batches: [
        { id: 'b1', name: 'Batch 1', serials: batch1Serials },
        { id: 'b2', name: 'Batch 2', serials: batch2Serials },
      ],
    };

    const row = getGroupingSessionRow(session);
    const b1 = row.batches.find((batch) => batch.id === 'b1');
    const b2 = row.batches.find((batch) => batch.id === 'b2');

    assert.deepEqual(b1.serials.map((serial) => serial.serialNumber), ['KEMEJA-001', 'KEMEJA-002']);
    assert.ok(!b1.serials.some((serial) => serial.serialNumber.includes('CELANA')));

    assert.deepEqual(b2.serials.map((serial) => serial.serialNumber), ['CELANA-001', 'CELANA-002']);
    assert.ok(!b2.serials.some((serial) => serial.serialNumber.includes('KEMEJA')));
  });
});

describe('PHASE 7K - Confirmation Re-validation & Atomicity', () => {
  it('confirmation re-validates SN availability and rejects consumed serials', async () => {
    const ownerId = 'owner-confirm-reval';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-ok',
        name: 'Produk OK',
        sku: 'OK-01',
        serials: [
          { id: 'sn-ok-1', sn: 'OK-01' },
          { id: 'sn-ok-2', sn: 'OK-02' },
          { id: 'sn-bad-3', sn: 'BAD-03' },
          { id: 'sn-ok-4', sn: 'OK-04' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    const sessionRes = await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Tes Invalid SN',
      warehouseId: 'wh-1',
      isPending: true,
      batches: [
        {
          id: 'b-valid',
          name: 'Batch 1',
          serials: [{ id: 'sn-ok-1', serialNumber: 'OK-01' }, { id: 'sn-ok-2', serialNumber: 'OK-02' }],
        },
        {
          id: 'b-invalid',
          name: 'Batch 2',
          serials: [{ id: 'sn-bad-3', serialNumber: 'BAD-03' }, { id: 'sn-ok-4', serialNumber: 'OK-04' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const sessionId = sessionRes.data.id;
    const soldSerial = mockDb.store.product_serials.find((serial) => serial.id === 'sn-bad-3');
    soldSerial.status = 'sold';

    await assert.rejects(
      async () => {
        await confirmGroupingSession({
          ownerId,
          userId: 'user-1',
          sessionId,
          supabaseClient: mockDb,
        });
      },
      /berstatus "sold"/i,
    );

    const targetSession = mockDb.store.serial_grouping_sessions.find((session) => session.id === sessionId);
    assert.equal(targetSession.status, 'pending');
    assert.equal(mockDb.store.serial_groupings.length, 0, 'No batch may be committed on validation failure');
  });

  it('confirmation commits every batch through the atomic session RPC and is idempotent', async () => {
    const ownerId = 'owner-confirm-atomic';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-x',
        name: 'Produk X',
        sku: 'X-01',
        serials: [
          { id: 'sx1', sn: 'X-1' },
          { id: 'sx2', sn: 'X-2' },
        ],
      },
      {
        id: 'prod-y',
        name: 'Produk Y',
        sku: 'Y-01',
        serials: [
          { id: 'sy1', sn: 'Y-1' },
          { id: 'sy2', sn: 'Y-2' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    const created = await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Atomic',
      warehouseId: 'wh-1',
      isPending: true,
      batches: [
        {
          id: 'bx',
          name: 'Batch X',
          targetProductId: 'prod-x',
          serials: [{ id: 'sx1', serialNumber: 'X-1' }, { id: 'sx2', serialNumber: 'X-2' }],
        },
        {
          id: 'by',
          name: 'Batch Y',
          targetProductId: 'prod-y',
          serials: [{ id: 'sy1', serialNumber: 'Y-1' }, { id: 'sy2', serialNumber: 'Y-2' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const confirmed = await confirmGroupingSession({
      ownerId,
      userId: 'user-1',
      sessionId: created.data.id,
      supabaseClient: mockDb,
    });

    assert.equal(confirmed.success, true);
    assert.equal(confirmed.session.status, 'completed');
    assert.equal(confirmed.results.length, 2);
    assert.equal(mockDb.store.serial_groupings.length, 2);
    assert.ok(mockDb.store.serial_groupings.every((grouping) => grouping.session_id === created.data.id));
    assert.ok(mockDb.store.product_serials
      .filter((serial) => serial.id.startsWith('s'))
      .every((serial) => serial.metadata?.isGrouped === true));

    const replay = await confirmGroupingSession({
      ownerId,
      userId: 'user-1',
      sessionId: created.data.id,
      supabaseClient: mockDb,
    });
    assert.equal(replay.alreadyConfirmed, true);
    assert.equal(mockDb.store.serial_groupings.length, 2, 'Replay must not duplicate groupings');

    const completedSessions = await listGroupingSessions({
      ownerId,
      status: 'completed',
      supabaseClient: mockDb,
    });
    assert.equal(completedSessions.length, 1);
    assert.equal(completedSessions[0].batches.length, 2);
    assert.ok(completedSessions[0].batches.every((batch) => batch.id));
  });

  it('cancelling a pending session sets status to cancelled', async () => {
    const ownerId = 'owner-cancel-test';
    const catalog = seedCatalog(ownerId, [
      {
        id: 'prod-c',
        name: 'Produk C',
        sku: 'C-01',
        serials: [
          { id: 'sc1', sn: 'SC-1' },
          { id: 'sc2', sn: 'SC-2' },
        ],
      },
    ]);
    const mockDb = createMockSupabase(catalog);

    const created = await createGroupingSession({
      ownerId,
      sessionName: 'Sesi Batal',
      isPending: true,
      batches: [
        {
          id: 'b-c1',
          name: 'Batch Batal',
          targetProductId: 'prod-c',
          serials: [{ id: 'sc1', serialNumber: 'SC-1' }, { id: 'sc2', serialNumber: 'SC-2' }],
        },
      ],
      supabaseClient: mockDb,
    });

    const cancelRes = await cancelGroupingSession({
      ownerId,
      sessionId: created.data.id,
      notes: 'Pembatalan oleh admin',
      supabaseClient: mockDb,
    });

    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.data.status, 'cancelled');
    assert.equal(cancelRes.data.notes, 'Pembatalan oleh admin');

    await assert.rejects(
      async () => {
        await cancelGroupingSession({
          ownerId,
          sessionId: created.data.id,
          supabaseClient: mockDb,
        });
      },
      /tidak dapat dibatalkan/i,
    );

    const cancelledSessions = await listGroupingSessions({
      ownerId,
      status: 'dissolved',
      supabaseClient: mockDb,
    });
    assert.equal(cancelledSessions.length, 1);
    assert.equal(cancelledSessions[0].status, 'cancelled');
  });
});

describe('PHASE 7K - Search & Display Helpers Compatibility', () => {
  it('matchesGroupingSessionSearch matches session reference, session name, SKU, and component SN', () => {
    const session = {
      sessionNumber: 'GRP-SES-20261023-0042',
      name: 'Pengelompokan Kaos Polos Katun',
      notes: 'Khusus pesanan distributor A',
      batches: [
        {
          name: 'Batch Kaos Hitam',
          resultProductName: 'Kaos Hitam Premium',
          resultProductSku: 'KOS-HTM-01',
          resultSerialNumber: 'KOS-G-1LUSIN-231020260042',
          serials: [
            { serialNumber: 'RAW-KOS-000101', productName: 'Bahan Katun 30s' },
            { serialNumber: 'RAW-KOS-000102', productName: 'Bahan Katun 30s' },
          ],
        },
      ],
    };

    assert.equal(matchesGroupingSessionSearch(session, 'GRP-SES-20261023-0042'), true);
    assert.equal(matchesGroupingSessionSearch(session, '0042'), true);
    assert.equal(matchesGroupingSessionSearch(session, 'Kaos Polos'), true);
    assert.equal(matchesGroupingSessionSearch(session, 'KOS-HTM-01'), true);
    assert.equal(matchesGroupingSessionSearch(session, 'RAW-KOS-000101'), true);
    assert.equal(matchesGroupingSessionSearch(session, 'SEPATU_KULIT'), false);
  });

  it('maps legacy grouping row as 1-batch session with full backward compatibility', () => {
    const legacyRow = {
      id: 'legacy-grp-99',
      grouping_number: 'GRP-23102026-9999',
      result_serial_number: 'LEGACY-G-1LUSIN-9999',
      result_product: { name: 'Kemeja Batik', sku: 'BTK-01' },
      target_unit: 'lusin',
      total_base_qty_pcs: 12,
      status: 'completed',
      assembly_document_number: 'ASM-20261023-0099',
      created_at: '2026-10-23T08:00:00.000Z',
    };

    const displayRow = getGroupingDisplayRow(legacyRow);
    assert.equal(displayRow.reference, 'ASM-20261023-0099');
    assert.equal(displayRow.resultSerialNumber, 'LEGACY-G-1LUSIN-9999');
    assert.equal(displayRow.resultProductName, 'Kemeja Batik');

    const sessionRow = getGroupingSessionRow({
      id: legacyRow.id,
      sessionNumber: legacyRow.assembly_document_number,
      name: `Grouping ${legacyRow.result_product.name}`,
      status: legacyRow.status,
      batches: [legacyRow],
    });

    assert.equal(sessionRow.reference, 'ASM-20261023-0099');
    assert.equal(sessionRow.totalBatches, 1);
    assert.equal(sessionRow.status, 'completed');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const read = (...parts) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');

const migration024 = read('supabase', 'migrations', '024_cross_product_serial_grouping_ledger.sql');
const migration025 = read('supabase', 'migrations', '025_serial_grouping_full_atomic_rpc.sql');
const migration026 = read('supabase', 'migrations', '026_serial_case_insensitive_uniqueness.sql');
const migration027 = read('supabase', 'migrations', '027_serial_grouping_sessions.sql');
const serviceSrc = read('src', 'services', 'serialGroup.service.js');

function extractFunctionArgs(sql, functionName) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i');
  const match = sql.match(re);
  assert.ok(match, `Function ${functionName} not found in SQL`);
  return match[1]
    .split(',')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractServiceRpcCallArgs(source, functionName) {
  const re = new RegExp(`rpc\\s*\\(\\s*['"]${functionName}['"]\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`);
  const match = source.match(re);
  assert.ok(match, `Service RPC call to ${functionName} not found in service`);
  return [...match[1].matchAll(/^\s*(p_[a-z0-9_]+):/gim)].map((m) => m[1]);
}

describe('Phase 7M — Static Migration & RPC Contract Audit', () => {
  describe('Migration 026: Case-Insensitive Serial Uniqueness', () => {
    it('contains non-destructive pre-flight check for case-insensitive duplicates', () => {
      assert.match(
        migration026,
        /SELECT count\(\*\) INTO v_duplicate_groups[\s\S]*?GROUP BY owner_id, lower\(btrim\(serial_number\)\)[\s\S]*?HAVING count\(\*\) > 1/i,
      );
      assert.match(migration026, /DUPLICATE_SERIAL_CASE_INSENSITIVE/);
      assert.match(migration026, /USING errcode = 'P0007'/);
    });

    it('creates owner-scoped lower(btrim(serial_number)) unique index', () => {
      assert.match(
        migration026,
        /CREATE UNIQUE INDEX IF NOT EXISTS product_serials_owner_lower_serial_number_key\s+ON public\.product_serials\s*\(owner_id, lower\(btrim\(serial_number\)\)\);/i,
      );
    });

    it('drops legacy case-sensitive index safely without dropping data', () => {
      assert.match(
        migration026,
        /DROP INDEX IF EXISTS public\.product_serials_owner_serial_number_key;/i,
      );
      assert.doesNotMatch(migration026, /DROP TABLE/i);
      assert.doesNotMatch(migration026, /DELETE FROM/i);
    });
  });

  describe('Migration 027: Serial Grouping Sessions Schema', () => {
    it('defines serial_grouping_sessions table with all required status and audit columns', () => {
      assert.match(migration027, /CREATE TABLE IF NOT EXISTS public\.serial_grouping_sessions/i);
      const expectedColumns = [
        'id UUID PRIMARY KEY',
        'owner_id UUID NOT NULL',
        'warehouse_id UUID',
        'session_number TEXT NOT NULL',
        'session_name TEXT',
        'status TEXT NOT NULL DEFAULT \'pending\'',
        'total_batches INTEGER NOT NULL DEFAULT 0',
        'total_serials INTEGER NOT NULL DEFAULT 0',
        'notes TEXT',
        'metadata JSONB NOT NULL DEFAULT \'{}\'::jsonb',
        'created_by UUID',
        'created_at TIMESTAMPTZ',
        'updated_at TIMESTAMPTZ',
        'confirmed_at TIMESTAMPTZ',
        'confirmed_by UUID',
        'cancelled_at TIMESTAMPTZ',
        'cancelled_by UUID',
      ];
      for (const col of expectedColumns) {
        assert.match(migration027, new RegExp(col.replace(/\(/g, '\\(').replace(/\)/g, '\\)'), 'i'));
      }
      assert.match(migration027, /CHECK \(status IN \('pending', 'completed', 'cancelled', 'partial'\)\)/);
      assert.match(migration027, /CONSTRAINT uq_serial_grouping_sessions_owner_number UNIQUE \(owner_id, session_number\)/);
    });

    it('adds nullable session_id foreign key on serial_groupings safely', () => {
      assert.match(migration027, /ALTER TABLE public\.serial_groupings\s+ADD COLUMN session_id UUID REFERENCES public\.serial_grouping_sessions\(id\)/i);
      assert.match(migration027, /ON DELETE SET NULL/i);
    });

    it('creates performance indexes and RLS policies on serial_grouping_sessions', () => {
      assert.match(migration027, /CREATE INDEX IF NOT EXISTS idx_grouping_sessions_owner_status/i);
      assert.match(migration027, /CREATE INDEX IF NOT EXISTS idx_grouping_sessions_owner_wh/i);
      assert.match(migration027, /CREATE INDEX IF NOT EXISTS idx_serial_groupings_session_id/i);
      assert.match(migration027, /ALTER TABLE public\.serial_grouping_sessions ENABLE ROW LEVEL SECURITY;/i);
      assert.match(migration027, /CREATE POLICY serial_grouping_sessions_owner_isolation ON public\.serial_grouping_sessions/i);
      assert.match(migration027, /CREATE TRIGGER serial_grouping_sessions_set_updated_at/i);
    });
  });

  describe('RPC Parity: confirm_serial_grouping_session_atomic_v1', () => {
    it('SQL signature matches backend service call exactly', () => {
      const sqlArgs = extractFunctionArgs(migration027, 'confirm_serial_grouping_session_atomic_v1');
      const serviceArgs = extractServiceRpcCallArgs(serviceSrc, 'confirm_serial_grouping_session_atomic_v1');

      assert.equal(sqlArgs.length, 5);
      assert.deepEqual(sqlArgs, [
        'p_owner_id',
        'p_session_id',
        'p_user_id',
        'p_user_name',
        'p_batches',
      ]);
      assert.deepEqual(serviceArgs, sqlArgs);
    });

    it('locks session header with FOR UPDATE and enforces completed idempotency', () => {
      assert.match(
        migration027,
        /SELECT \* INTO v_session\s+FROM public\.serial_grouping_sessions\s+WHERE owner_id = p_owner_id AND id = p_session_id\s+FOR UPDATE;/i,
      );
      assert.match(
        migration027,
        /IF v_session\.status = 'completed' THEN[\s\S]*?'alreadyConfirmed', true/i,
      );
      assert.match(
        migration027,
        /IF v_session\.status <> 'pending' THEN[\s\S]*?GROUPING_SESSION_NOT_PENDING/i,
      );
    });

    it('delegates to create_serial_group_full_atomic_v1 per batch inside the single transaction', () => {
      assert.match(
        migration027,
        /v_result := public\.create_serial_group_full_atomic_v1\([\s\S]*?\);[\s\S]*?UPDATE public\.serial_groupings\s+SET session_id = p_session_id/i,
      );
    });

    it('restricts execution privileges to service_role', () => {
      assert.match(
        migration027,
        /REVOKE ALL ON FUNCTION public\.confirm_serial_grouping_session_atomic_v1\([\s\S]*?\) FROM PUBLIC;/i,
      );
      assert.match(
        migration027,
        /GRANT EXECUTE ON FUNCTION public\.confirm_serial_grouping_session_atomic_v1\([\s\S]*?\) TO service_role;/i,
      );
    });
  });

  describe('Integration Scenarios Behavioral Simulation (Pre-Staging Verification)', () => {
    function createSimulationStore() {
      const ownerId = 'tenant-sim-7m';
      const warehouseId = 'wh-sim-1';
      const store = {
        products: [
          { id: 'p1', owner_id: ownerId, name: 'Bahan A', sku: 'BA-01', status: 'active', unit_cost: 10000, metadata: { unit: 'pcs' } },
          { id: 'p2', owner_id: ownerId, name: 'Bahan B', sku: 'BB-01', status: 'active', unit_cost: 15000, metadata: { unit: 'pcs' } },
          { id: 'p-res-1', owner_id: ownerId, name: 'Hasil Group 1', sku: 'HG-01', status: 'active', unit_cost: 0, metadata: { unit: 'pcs' } },
          { id: 'p-res-2', owner_id: ownerId, name: 'Hasil Group 2', sku: 'HG-02', status: 'active', unit_cost: 0, metadata: { unit: 'pcs' } },
        ],
        product_serials: [
          { id: 'sn-1', owner_id: ownerId, product_id: 'p1', serial_number: 'SN-A-01', status: 'available', warehouse_id: warehouseId, metadata: {} },
          { id: 'sn-2', owner_id: ownerId, product_id: 'p1', serial_number: 'SN-A-02', status: 'available', warehouse_id: warehouseId, metadata: {} },
          { id: 'sn-3', owner_id: ownerId, product_id: 'p2', serial_number: 'SN-B-01', status: 'available', warehouse_id: warehouseId, metadata: {} },
          { id: 'sn-4', owner_id: ownerId, product_id: 'p2', serial_number: 'SN-B-02', status: 'available', warehouse_id: warehouseId, metadata: {} },
        ],
        documents: [],
        document_items: [],
        serial_groupings: [],
        serial_grouping_components: [],
        serial_grouping_sessions: [],
      };

      let seq = 0;
      const nextId = (p) => `${p}-${Date.now()}-${++seq}`;

      function buildQuery(tableName) {
        let rows = store[tableName] || [];
        let singleMode = null;
        let updatePatch = null;

        const builder = {
          select() { return builder; },
          eq(col, val) {
            rows = rows.filter((r) => r[col] === val);
            return builder;
          },
          neq(col, val) {
            rows = rows.filter((r) => r[col] !== val);
            return builder;
          },
          in(col, vals) {
            const set = new Set(vals);
            rows = rows.filter((r) => set.has(r[col]));
            return builder;
          },
          ilike(col, pattern) {
            const regexStr = String(pattern).replace(/%/g, '.*');
            const reg = new RegExp(`^${regexStr}$`, 'i');
            rows = rows.filter((r) => reg.test(String(r[col] || '')));
            return builder;
          },
          order() { return builder; },
          single() { singleMode = 'single'; return builder; },
          maybeSingle() { singleMode = 'maybeSingle'; return builder; },
          insert(payload) {
            const items = Array.isArray(payload) ? payload : [payload];
            const inserted = items.map((item) => ({
              id: item.id || nextId(tableName),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...item,
            }));
            if (!store[tableName]) store[tableName] = [];
            store[tableName].push(...inserted);

            return {
              select: () => ({
                single: async () => ({ data: inserted[0], error: null }),
                maybeSingle: async () => ({ data: inserted[0], error: null }),
                then: (res) => res({ data: inserted, error: null }),
              }),
              single: async () => ({ data: inserted[0], error: null }),
              maybeSingle: async () => ({ data: inserted[0], error: null }),
              then: (res) => res({ data: inserted, error: null }),
            };
          },
          update(patch) {
            updatePatch = patch;
            return builder;
          },
          then(resolve) {
            if (updatePatch) {
              for (const r of rows) {
                Object.assign(r, updatePatch, { updated_at: new Date().toISOString() });
              }
            }
            let data = rows;
            if (tableName === 'product_serials') {
              data = rows.map((r) => ({
                ...r,
                product: store.products.find((p) => p.id === r.product_id && p.owner_id === r.owner_id) || null,
              }));
            }
            if (singleMode === 'single') {
              resolve(data.length > 0 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } });
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
          return { data: null, error: { code: 'PGRST202', message: 'Function not found' } };
        }

        const session = store.serial_grouping_sessions.find((s) => s.id === params.p_session_id && s.owner_id === params.p_owner_id);
        if (!session) {
          return { data: null, error: { code: 'P0002', message: 'GROUPING_SESSION_NOT_FOUND' } };
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
          return { data: null, error: { code: 'P0001', message: 'GROUPING_SESSION_NOT_PENDING' } };
        }

        // Validate all members before transaction commits
        for (const batch of params.p_batches || []) {
          for (const memberId of batch.member_ids || []) {
            const serial = store.product_serials.find((s) => s.id === memberId && s.owner_id === params.p_owner_id);
            if (!serial || serial.status !== 'available' || serial.metadata?.isGrouped) {
              return { data: null, error: { code: 'P0003', message: 'CONCURRENT_CLAIM_OR_UNAVAILABLE' } };
            }
          }
        }

        // Atomic commit of all batches
        const results = [];
        for (const batch of params.p_batches || []) {
          const resSerialId = nextId('res-sn');
          const groupingId = nextId('grp');
          const docId = nextId('asm-doc');

          store.product_serials.push({
            id: resSerialId,
            owner_id: params.p_owner_id,
            product_id: batch.product_id,
            serial_number: batch.group_serial_number,
            status: 'available',
            warehouse_id: session.warehouse_id,
            metadata: batch.metadata || {},
          });

          store.documents.push({
            id: docId,
            owner_id: params.p_owner_id,
            document_type: 'goods_assembly',
            document_number: `ASM-${batch.group_serial_number}`,
            status: 'completed',
          });

          store.serial_groupings.push({
            id: groupingId,
            owner_id: params.p_owner_id,
            session_id: params.p_session_id,
            grouping_number: batch.group_serial_number,
            result_serial_id: resSerialId,
            result_serial_number: batch.group_serial_number,
            result_product_id: batch.product_id,
            source_document_id: docId,
            status: 'active',
          });

          for (const memberId of batch.member_ids || []) {
            const s = store.product_serials.find((sn) => sn.id === memberId);
            s.metadata = { ...(s.metadata || {}), isGrouped: true, parentGroupId: resSerialId };
          }

          results.push({
            batchId: batch.batch_id,
            batchName: batch.batch_name,
            success: true,
            groupingId,
            groupingNumber: batch.group_serial_number,
            resultSerialId: resSerialId,
            resultSerialNumber: batch.group_serial_number,
          });
        }

        session.status = 'completed';
        session.confirmed_at = new Date().toISOString();
        session.confirmed_by = params.p_user_id;
        session.metadata = {
          ...(session.metadata || {}),
          processResult: {
            results,
            summary: { total: results.length, succeeded: results.length, failed: 0, allSucceeded: true, status: 'success' },
          },
        };

        return {
          data: {
            success: true,
            alreadyConfirmed: false,
            session,
            results,
            summary: session.metadata.processResult.summary,
          },
          error: null,
        };
      }

      const client = {
        from: (table) => buildQuery(table),
        rpc,
        _store: store,
      };

      return { client, store, ownerId, warehouseId };
    }

    it('Scenario 1: Pending session stores header and batches without ledger mutation or serial activation', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession } = await import('../src/services/serialGroup.service.js');

      const res = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Pending Uji',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
          { id: 'b2', name: 'Batch 2', resultProductId: 'p2', serials: [{ id: 'sn-3', serialNumber: 'SN-B-01' }, { id: 'sn-4', serialNumber: 'SN-B-02' }] },
        ],
        supabaseClient: client,
      });

      assert.equal(res.success, true);
      assert.equal(res.isPending, true);
      assert.equal(res.data.status, 'pending');
      assert.equal(store.serial_grouping_sessions.length, 1);
      assert.equal(store.documents.length, 0, 'Zero assembly documents created during pending');
      assert.equal(store.serial_groupings.length, 0, 'Zero groupings created during pending');
      assert.equal(store.product_serials.length, 4, 'No result serial added during pending');
      assert.equal(store.product_serials.every((s) => !s.metadata?.isGrouped), true, 'Member serials remain un-grouped');
    });

    it('Scenario 2: Confirmation of two batches commits all batches atomically and marks session completed', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Dua Batch',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
          { id: 'b2', name: 'Batch 2', resultProductId: 'p2', serials: [{ id: 'sn-3', serialNumber: 'SN-B-01' }, { id: 'sn-4', serialNumber: 'SN-B-02' }] },
        ],
        supabaseClient: client,
      });

      const confirmed = await confirmGroupingSession({
        ownerId,
        sessionId: created.data.id,
        supabaseClient: client,
      });

      assert.equal(confirmed.success, true);
      assert.equal(confirmed.session.status, 'completed');
      assert.equal(confirmed.results.length, 2);
      assert.equal(store.documents.length, 2, 'Two assembly ledger documents created');
      assert.equal(store.serial_groupings.length, 2, 'Two serial groupings records linked to session');
      assert.equal(store.product_serials.length, 6, 'Two new group result serials added');
      assert.equal(store.product_serials.filter((s) => s.metadata?.isGrouped).length, 4, 'All 4 member serials locked');
    });

    it('Scenario 3: Second batch failure rolls back first batch entirely and keeps session Pending', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Rollback',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
          { id: 'b2', name: 'Batch 2', resultProductId: 'p2', serials: [{ id: 'sn-3', serialNumber: 'SN-B-01' }, { id: 'sn-4', serialNumber: 'SN-B-02' }] },
        ],
        supabaseClient: client,
      });

      // Simulate a concurrent action consuming one serial of batch 2 before confirmation
      const sn4 = store.product_serials.find((s) => s.id === 'sn-4');
      sn4.status = 'out';

      await assert.rejects(
        async () => {
          await confirmGroupingSession({
            ownerId,
            sessionId: created.data.id,
            supabaseClient: client,
          });
        },
        /CONCURRENT_CLAIM_OR_UNAVAILABLE|tidak tersedia|tidak dapat di-group karena berstatus/i,
      );

      // Verify strict all-or-nothing rollback
      const sessionInDb = store.serial_grouping_sessions.find((s) => s.id === created.data.id);
      assert.equal(sessionInDb.status, 'pending', 'Session remains in Pending status');
      assert.equal(store.documents.length, 0, 'Batch 1 ledger document was NOT saved');
      assert.equal(store.serial_groupings.length, 0, 'Batch 1 grouping was NOT saved');
      assert.equal(store.product_serials.length, 4, 'No result serials created');
      const sn1 = store.product_serials.find((s) => s.id === 'sn-1');
      assert.equal(sn1.metadata?.isGrouped, undefined, 'Batch 1 members NOT locked');
    });

    it('Scenario 4: Replay confirmation on completed session is idempotent', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Replay',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
        ],
        supabaseClient: client,
      });

      const firstConfirm = await confirmGroupingSession({
        ownerId,
        sessionId: created.data.id,
        supabaseClient: client,
      });
      assert.equal(firstConfirm.success, true);
      const docsCountBefore = store.documents.length;
      const serialsCountBefore = store.product_serials.length;

      // Replay confirm call
      const secondConfirm = await confirmGroupingSession({
        ownerId,
        sessionId: created.data.id,
        supabaseClient: client,
      });

      assert.equal(secondConfirm.success, true);
      assert.equal(secondConfirm.alreadyConfirmed, true);
      assert.equal(store.documents.length, docsCountBefore, 'No duplicate documents created on replay');
      assert.equal(store.product_serials.length, serialsCountBefore, 'No duplicate serials created on replay');
    });

    it('Scenario 5: Two concurrent confirmations result in exactly one consistent completion', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Konkuren',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
        ],
        supabaseClient: client,
      });

      // Trigger two parallel confirmations on the exact same session ID
      const [res1, res2] = await Promise.all([
        confirmGroupingSession({ ownerId, sessionId: created.data.id, supabaseClient: client }),
        confirmGroupingSession({ ownerId, sessionId: created.data.id, supabaseClient: client }),
      ]);

      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(store.serial_grouping_sessions.filter((s) => s.id === created.data.id).length, 1);
      assert.equal(store.documents.length, 1, 'Exactly one assembly document created');
      assert.equal(store.serial_groupings.length, 1, 'Exactly one grouping created');
    });

    it('Scenario 6: Two Pending sessions referencing the same serial cannot double-consume it', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      // Session A references sn-1, sn-2
      const sessionA = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi A',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'ba', name: 'Batch A', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
        ],
        supabaseClient: client,
      });

      // Session B also references sn-1, sn-3 (cross product batch)
      const sessionB = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi B',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'bb', name: 'Batch B', resultProductId: 'p-res-2', isCrossProduct: true, serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-3', serialNumber: 'SN-B-01' }] },
        ],
        supabaseClient: client,
      });

      // Confirm Session A first
      const confirmA = await confirmGroupingSession({ ownerId, sessionId: sessionA.data.id, supabaseClient: client });
      assert.equal(confirmA.success, true);

      // Confirm Session B must be rejected because sn-1 is now consumed by Session A
      await assert.rejects(
        async () => {
          await confirmGroupingSession({ ownerId, sessionId: sessionB.data.id, supabaseClient: client });
        },
        /sudah berada di dalam group lain|tidak lagi tersedia|CONCURRENT_CLAIM_OR_UNAVAILABLE/i,
      );

      const sessionBInDb = store.serial_grouping_sessions.find((s) => s.id === sessionB.data.id);
      assert.equal(sessionBInDb.status, 'pending');
    });

    it('Scenario 7: Cancellation only applies to Pending sessions and preserves serials', async () => {
      const { client, store, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, cancelGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Batal',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
        ],
        supabaseClient: client,
      });

      const cancelRes = await cancelGroupingSession({
        ownerId,
        sessionId: created.data.id,
        notes: 'Dibatalkan oleh QA',
        supabaseClient: client,
      });

      assert.equal(cancelRes.success, true);
      assert.equal(cancelRes.data.status, 'cancelled');
      assert.equal(store.product_serials.every((s) => s.status === 'available'), true);

      // Cannot cancel a cancelled session again
      await assert.rejects(
        async () => {
          await cancelGroupingSession({ ownerId, sessionId: created.data.id, supabaseClient: client });
        },
        /tidak dapat dibatalkan/i,
      );
    });

    it('Scenario 8: Tenant isolation prevents cross-tenant access to grouping sessions', async () => {
      const { client, ownerId, warehouseId } = createSimulationStore();
      const { createGroupingSession, confirmGroupingSession } = await import('../src/services/serialGroup.service.js');

      const created = await createGroupingSession({
        ownerId,
        sessionName: 'Sesi Tenant Asli',
        warehouseId,
        isPending: true,
        batches: [
          { id: 'b1', name: 'Batch 1', resultProductId: 'p1', serials: [{ id: 'sn-1', serialNumber: 'SN-A-01' }, { id: 'sn-2', serialNumber: 'SN-A-02' }] },
        ],
        supabaseClient: client,
      });

      // Attacker tenant attempts to confirm
      await assert.rejects(
        async () => {
          await confirmGroupingSession({
            ownerId: 'attacker-tenant-999',
            sessionId: created.data.id,
            supabaseClient: client,
          });
        },
        /tidak ditemukan/i,
      );
    });
  });
});


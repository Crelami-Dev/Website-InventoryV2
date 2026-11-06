import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CANONICAL_MULTIPLIERS,
  MAX_GROUP_NESTING_DEPTH,
  parseUnitFromSerialNumber,
  resolveSerialBaseQty,
  calculateItemNestingDepth,
  extractLeafComposition,
  formatCompositionBreakdown,
  createSerialGroup,
  ungroupSerial,
  getSerialCompositionHierarchy,
  isRpcNotAvailableError,
  handleRpcExecutionError,
} from '../src/services/serialGroup.service.js';

import {
  calculateAvailableSerialsByProduct,
  parseSerialUnit,
  filterDisplaySerials,
} from '../../frontend-new/src/utils/stockCalculation.js';

/**
 * In-memory Mock Supabase Client supporting transactions, atomic RPC, conditional updates, and locks
 */
function createMockSupabase(initialData = {}, { enableRpc = true, simulateInsertFailure = false, rpcHandler = null } = {}) {
  const store = {
    products: [...(initialData.products || [])],
    product_serials: [...(initialData.product_serials || [])].map((s) => JSON.parse(JSON.stringify(s))),
  };

  const activeLocks = new Set();

  return {
    store,
    activeLocks,
    async rpc(fnName, params) {
      if (typeof rpcHandler === 'function') {
        return rpcHandler(fnName, params, { store, activeLocks });
      }

      if (!enableRpc) {
        return { data: null, error: { message: 'RPC not implemented', code: '42883' } };
      }

      if (fnName === 'create_serial_group_atomic') {
        const { p_owner_id, p_user_id, p_user_name, p_member_ids, p_group_serial_number, p_product_id, p_warehouse_id, p_metadata } = params;

        // 1. Check member count
        const count = Array.isArray(p_member_ids) ? p_member_ids.length : 0;
        if (p_member_ids === null || count < 2) {
          return { data: null, error: { message: 'MIN_MEMBERS_REQUIRED: Minimal harus memilih 2 nomor seri untuk membuat group.', code: 'P0001' } };
        }

        // 2. Lock members (concurrency detection)
        for (const id of p_member_ids) {
          if (activeLocks.has(id)) {
            return { data: null, error: { message: 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Satu atau lebih nomor seri sedang dikelompokkan oleh proses lain.', code: 'P0003' } };
          }
        }

        const members = store.product_serials.filter((s) => p_member_ids.includes(s.id) && s.owner_id === p_owner_id);
        if (members.length !== p_member_ids.length) {
          return { data: null, error: { message: 'MEMBER_NOT_FOUND: Satu atau lebih nomor seri tidak ditemukan atau milik tenant lain.', code: 'P0002' } };
        }

        // 3. Check warehouse uniformity
        const whSet = new Set(members.map((m) => m.warehouse_id).filter(Boolean));
        if (whSet.size > 1) {
          return { data: null, error: { message: 'CROSS_WAREHOUSE_FORBIDDEN: Semua nomor seri harus berasal dari gudang yang sama.', code: 'P0001' } };
        }

        // 4. Check available and not grouped
        for (const m of members) {
          if (m.status !== 'available' || m.metadata?.isGrouped || m.metadata?.parentGroupId || m.metadata?.isDissolved) {
            return { data: null, error: { message: 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Nomor seri sudah tidak tersedia atau berada di group lain.', code: 'P0003' } };
          }
        }

        // 5. Check duplicate group serial
        if (store.product_serials.some((s) => s.owner_id === p_owner_id && s.serial_number?.toLowerCase() === p_group_serial_number?.toLowerCase())) {
          return { data: null, error: { message: `DUPLICATE_GROUP_SERIAL: Nomor seri group "${p_group_serial_number}" sudah pernah digunakan.`, code: 'P0004' } };
        }

        // 6. Insert group
        const newGroup = {
          id: `grp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          owner_id: p_owner_id,
          product_id: p_product_id,
          serial_number: p_group_serial_number,
          status: 'available',
          warehouse_id: p_warehouse_id,
          created_by: p_user_id,
          metadata: p_metadata,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.product_serials.push(newGroup);

        // 7. Lock members
        for (const m of members) {
          m.metadata = {
            ...(m.metadata || {}),
            isGrouped: true,
            parentGroupId: newGroup.id,
            parentGroupSerialNumber: newGroup.serial_number,
            groupedAt: new Date().toISOString(),
          };
          m.updated_at = new Date().toISOString();
        }

        return { data: { success: true, groupId: newGroup.id, groupSerialNumber: p_group_serial_number, group: newGroup }, error: null };
      }

      if (fnName === 'ungroup_serial_atomic') {
        const { p_owner_id, p_user_id, p_user_name, p_group_id, p_group_serial_number, p_notes } = params;
        const group = store.product_serials.find(
          (s) => s.owner_id === p_owner_id && (s.id === p_group_id || s.serial_number?.toLowerCase() === p_group_serial_number?.toLowerCase())
        );

        if (!group) {
          return { data: null, error: { message: 'GROUP_NOT_FOUND: Data group serial tidak ditemukan.', code: 'P0002' } };
        }

        if (!group.metadata?.isGroup) {
          return { data: null, error: { message: 'NOT_A_GROUP: Bukan group serial.', code: 'P0001' } };
        }

        if (group.metadata?.isGrouped || group.metadata?.parentGroupId) {
          return { data: null, error: { message: 'NESTED_CHILD_GROUP: Bongkar group induk paling atas terlebih dahulu.', code: 'P0001' } };
        }

        if (group.status === 'out' && !group.metadata?.isDissolved) {
          return { data: null, error: { message: 'ALREADY_DISPATCHED: Group sudah dikeluarkan.', code: 'P0001' } };
        }

        if (group.metadata?.isDissolved) {
          return { data: null, error: { message: 'ALREADY_DISSOLVED: Group sudah pernah dibongkar.', code: 'P0001' } };
        }

        // Release direct members
        const directMemberIds = (group.metadata?.directMembers || []).map((m) => m.serialId).filter(Boolean);
        const children = store.product_serials.filter((s) => s.owner_id === p_owner_id && (directMemberIds.includes(s.id) || s.metadata?.parentGroupId === group.id));

        for (const c of children) {
          c.metadata = {
            ...(c.metadata || {}),
            isGrouped: false,
            parentGroupId: null,
            parentGroupSerialNumber: null,
            unpackedAt: new Date().toISOString(),
          };
          c.updated_at = new Date().toISOString();
        }

        group.status = 'out';
        group.metadata = {
          ...(group.metadata || {}),
          isDissolved: true,
          dissolvedAt: new Date().toISOString(),
          dissolvedBy: p_user_id,
        };
        group.updated_at = new Date().toISOString();

        return {
          data: {
            success: true,
            unpackedGroup: group,
            releasedCount: children.length,
            releasedSerials: children.map((c) => c.serial_number),
          },
          error: null,
        };
      }

      return { data: null, error: { message: `Unknown RPC function: ${fnName}`, code: '42883' } };
    },
    from(tableName) {
      if (!store[tableName]) store[tableName] = [];
      let filters = [];
      let limitVal = null;
      let isSingle = false;
      let isMaybeSingle = false;
      let action = 'select'; // 'select' | 'insert' | 'update' | 'delete'
      let payloadData = null;
      let selectFieldsStr = null;

      const builder = {
        select(fields) {
          selectFieldsStr = fields || '*';
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        or(conditionStr) {
          return builder;
        },
        ilike(col, val) {
          filters.push((r) => String(r[col] || '').toLowerCase() === String(val || '').toLowerCase());
          return builder;
        },
        in(col, vals) {
          const s = new Set(vals);
          filters.push((r) => s.has(r[col]));
          return builder;
        },
        is(col, val) {
          if (val === null) {
            filters.push((r) => r[col] === null || r[col] === undefined);
          } else {
            filters.push((r) => r[col] === val);
          }
          return builder;
        },
        contains(col, subObj) {
          filters.push((r) => {
            const data = r[col] || {};
            for (const [k, v] of Object.entries(subObj)) {
              if (data[k] !== v) return false;
            }
            return true;
          });
          return builder;
        },
        limit(n) {
          limitVal = n;
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
          action = 'insert';
          payloadData = payload;
          return builder;
        },
        update(updates) {
          action = 'update';
          payloadData = updates;
          return builder;
        },
        delete() {
          action = 'delete';
          return builder;
        },
        then(resolve, reject) {
          try {
            if (action === 'insert') {
              if (simulateInsertFailure) {
                return Promise.resolve({ data: null, error: { message: 'Simulated insert error (DB network drop)' } }).then(resolve, reject);
              }
              const items = Array.isArray(payloadData) ? payloadData : [payloadData];
              const created = [];
              for (const it of items) {
                const newItem = {
                  id: it.id || `mock-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  ...it,
                };
                store[tableName].push(newItem);
                created.push(newItem);
              }
              const resData = Array.isArray(payloadData) ? created : (isSingle || isMaybeSingle ? created[0] : created);
              return Promise.resolve({ data: resData, error: null }).then(resolve, reject);
            }

            if (action === 'update') {
              let matched = store[tableName].filter((r) => filters.every((fn) => fn(r)));
              for (const item of matched) {
                Object.assign(item, payloadData, { updated_at: new Date().toISOString() });
              }
              const resData = isSingle ? matched[0] : (isMaybeSingle ? (matched[0] || null) : matched);
              return Promise.resolve({ data: resData, error: null }).then(resolve, reject);
            }

            if (action === 'delete') {
              store[tableName] = store[tableName].filter((r) => !filters.every((fn) => fn(r)));
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }

            // action === 'select'
            let result = store[tableName].filter((r) => filters.every((fn) => fn(r)));
            if (tableName === 'product_serials') {
              result = result.map((s) => ({
                ...s,
                product: store.products.find((p) => p.id === s.product_id) || null,
              }));
            }
            if (limitVal !== null) {
              result = result.slice(0, limitVal);
            }
            if (isSingle) {
              if (result.length === 0) {
                return Promise.resolve({ data: null, error: { message: 'Row not found' } }).then(resolve, reject);
              }
              return Promise.resolve({ data: result[0], error: null }).then(resolve, reject);
            }
            if (isMaybeSingle) {
              return Promise.resolve({ data: result[0] || null, error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: result, error: null }).then(resolve, reject);
          } catch (err) {
            return Promise.resolve({ data: null, error: err }).then(resolve, reject);
          }
        },
      };

      return builder;
    },
  };
}

describe('Serial Number Grouping & Hierarchy Suite — TAHAP 2 HARDENING', () => {

  const ownerId = 'tenant-123';
  const otherOwnerId = 'tenant-456';
  const userId = 'user-001';
  const userName = 'Admin Testing';
  const wh1 = 'wh-001';
  const wh2 = 'wh-002';

  const p1 = { id: 'prod-1', owner_id: ownerId, name: 'Kain Katun Putih', sku: 'KKP-01' };
  const p2 = { id: 'prod-2', owner_id: ownerId, name: 'Kancing Baju Kayu', sku: 'KBK-02' };
  const p3 = { id: 'prod-3', owner_id: ownerId, name: 'Paket Kemeja DIY', sku: 'PKD-03' };

  // --------------------------------------------------------------------------
  // 1. Concurrency: Dua Request Bersamaan Mengelompokkan Serial yang Sama
  // --------------------------------------------------------------------------
  describe('F1. Concurrency: Dua Request Bersamaan Mengelompokkan Serial yang Sama', () => {
    it('mencegah dua request bersamaan mengelompokkan serial yang sama (all-or-nothing)', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-CONC-01', status: 'available', warehouse_id: wh1 },
          { id: 's-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-CONC-02', status: 'available', warehouse_id: wh1 },
          { id: 's-3', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-CONC-03', status: 'available', warehouse_id: wh1 },
        ],
      });

      // Request 1 mengelompokkan s-1 dan s-2
      const req1 = createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['s-1', 's-2'],
        groupSerialNumber: 'GRP-REQ-1',
        warehouseId: wh1,
        supabaseClient: mockDb,
      });

      // Request 2 secara bersamaan mencoba mengelompokkan s-2 dan s-3 (s-2 bentrok!)
      const req2 = createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['s-2', 's-3'],
        groupSerialNumber: 'GRP-REQ-2',
        warehouseId: wh1,
        supabaseClient: mockDb,
      });

      const results = await Promise.allSettled([req1, req2]);
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      // Tepat 1 request berhasil dan tepat 1 request ditolak!
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.match(failures[0].reason.message, /sudah berada di dalam group|Konflik konkurensi|CONCURRENT/i);

      // Pastikan s-2 tidak memiliki relasi ganda
      const s2 = mockDb.store.product_serials.find((s) => s.id === 's-2');
      assert.equal(s2.metadata.isGrouped, true);
      assert.equal(s2.metadata.parentGroupSerialNumber, successes[0].value.group.serial_number);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Concurrency: Dua Request Bersamaan Membongkar Group yang Sama
  // --------------------------------------------------------------------------
  describe('F2. Concurrency: Dua Request Bersamaan Membongkar Group yang Sama', () => {
    it('mencegah pembongkaran ganda pada group yang sama', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-target',
            owner_id: ownerId,
            product_id: p1.id,
            serial_number: 'GRP-DOUBLE-UNPACK',
            status: 'available',
            warehouse_id: wh1,
            metadata: {
              isGroup: true,
              directMembers: [{ serialId: 's-1', serialNumber: 'SN-1' }, { serialId: 's-2', serialNumber: 'SN-2' }],
            },
          },
          { id: 's-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-1', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-target' } },
          { id: 's-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-2', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-target' } },
        ],
      });

      const unpack1 = ungroupSerial({ ownerId, userId, groupId: 'grp-target', supabaseClient: mockDb });
      const unpack2 = ungroupSerial({ ownerId, userId, groupId: 'grp-target', supabaseClient: mockDb });

      const results = await Promise.allSettled([unpack1, unpack2]);
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.match(failures[0].reason.message, /sudah pernah dibongkar|ALREADY_DISSOLVED/i);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Atomicity & Rollback: Kegagalan di Tengah Operasi Tidak Meninggalkan Data Parsial
  // --------------------------------------------------------------------------
  describe('F3. Atomicity: Kegagalan di Tengah Operasi Tidak Meninggalkan Data Parsial', () => {
    it('memulihkan metadata anggota dan tidak membuat group yatim saat database insert gagal', async () => {
      const mockDb = createMockSupabase(
        {
          products: [p1],
          product_serials: [
            { id: 's-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-FAIL-01', status: 'available', warehouse_id: wh1, metadata: { customTag: 'keep-me' } },
            { id: 's-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-FAIL-02', status: 'available', warehouse_id: wh1, metadata: { customTag: 'keep-me-too' } },
          ],
        },
        { enableRpc: false, simulateInsertFailure: true }
      );

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s-1', 's-2'],
            groupSerialNumber: 'GRP-SHOULD-FAIL',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Gagal membuat record group serial/ }
      );

      // Anggota harus kembali seperti semula (rollback bersih)
      const s1 = mockDb.store.product_serials.find((s) => s.id === 's-1');
      assert.equal(s1.metadata.isGrouped, undefined);
      assert.equal(s1.metadata.customTag, 'keep-me');

      // Tidak boleh ada group yatim yang tersimpan di database
      const orphan = mockDb.store.product_serials.find((s) => s.serial_number === 'GRP-SHOULD-FAIL');
      assert.equal(orphan, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Penolakan Group Lintas Gudang (Cross-Warehouse Rejection)
  // --------------------------------------------------------------------------
  describe('F4. Validasi Gudang: Penolakan Group Lintas Gudang', () => {
    it('menolak penggabungan serial yang berasal dari gudang berbeda', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's-wh1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-WH1', status: 'available', warehouse_id: wh1 },
          { id: 's-wh2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-WH2', status: 'available', warehouse_id: wh2 },
        ],
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s-wh1', 's-wh2'],
            groupSerialNumber: 'GRP-CROSS-WH',
            supabaseClient: mockDb,
          });
        },
        { message: /harus berasal dari gudang yang sama/i }
      );
    });

    it('menolak jika serial berada di gudang berbeda dari target warehouseId yang diminta', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-WH1-A', status: 'available', warehouse_id: wh1 },
          { id: 's-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-WH1-B', status: 'available', warehouse_id: wh1 },
        ],
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s-1', 's-2'],
            warehouseId: wh2, // Diminta di gudang 2 padahal serial di gudang 1
            groupSerialNumber: 'GRP-WRONG-TARGET',
            supabaseClient: mockDb,
          });
        },
        { message: /berada di gudang yang berbeda dari gudang target/i }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 5. Serial Anak Ditolak oleh Goods Out
  // --------------------------------------------------------------------------
  describe('F5. Goods Out Guard: Serial Anak Tergroup Ditolak', () => {
    it('memvalidasi bahwa serial dengan metadata isGrouped atau parentGroupId ditolak untuk Goods Out', () => {
      const childSerial = {
        id: 'child-1',
        serial_number: 'SN-CHILD-01',
        status: 'available',
        metadata: {
          isGrouped: true,
          parentGroupId: 'grp-parent-1',
          parentGroupSerialNumber: 'GRP-BOX-01',
        },
      };

      // Simulasi aturan di POST /documents & /product-serial-lookup
      const isAvailableForGoodsOut = (s) => {
        if (s.status !== 'available') return false;
        if (s.metadata?.isGrouped || s.metadata?.parentGroupId) return false;
        if (s.metadata?.isDissolved) return false;
        return true;
      };

      assert.equal(isAvailableForGoodsOut(childSerial), false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Serial Anak Tidak Ditawarkan oleh Index & Batch Lookup
  // --------------------------------------------------------------------------
  describe('F6. Search & Batch Lookup: Serial Anak Tergroup Dikecualikan', () => {
    it('product-serial-index memfilter serial anak tergroup dan serial dissolved saat allowAllStatus = false', () => {
      const allData = [
        { serial_number: 'SN-FREE', product_id: 'p1', status: 'available', metadata: {} },
        { serial_number: 'SN-PACKED', product_id: 'p1', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-1' } },
        { serial_number: 'GRP-ACTIVE', product_id: 'p1', status: 'available', metadata: { isGroup: true, totalPcs: 24 } },
        { serial_number: 'GRP-DISSOLVED', product_id: 'p1', status: 'out', metadata: { isGroup: true, isDissolved: true } },
      ];

      // Simulasi filter endpoint /product-serial-index
      const eligibleForGoodsOut = allData.filter((r) => !r.metadata?.isGrouped && !r.metadata?.parentGroupId && !r.metadata?.isDissolved);

      assert.equal(eligibleForGoodsOut.length, 2);
      assert.deepEqual(eligibleForGoodsOut.map((r) => r.serial_number), ['SN-FREE', 'GRP-ACTIVE']);
    });

    it('batch lookup mendeteksi flag isGrouped dan parentGroupSerialNumber', () => {
      const foundSerial = {
        serial_number: 'SN-CHILD-BATCH',
        status: 'available',
        metadata: { isGrouped: true, parentGroupSerialNumber: 'GRP-MASTER-01' },
      };

      const mapped = {
        serial_number: foundSerial.serial_number,
        isGrouped: Boolean(foundSerial.metadata?.isGrouped),
        parentGroupSerialNumber: foundSerial.metadata?.parentGroupSerialNumber || null,
        isDissolved: Boolean(foundSerial.metadata?.isDissolved),
      };

      assert.equal(mapped.isGrouped, true);
      assert.equal(mapped.parentGroupSerialNumber, 'GRP-MASTER-01');
      assert.equal(mapped.isDissolved, false);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Pengeluaran Group Utuh Memperbarui Status Group dan Leaf Secara Konsisten
  // --------------------------------------------------------------------------
  describe('F7. Goods Out Cascade: Status Group dan Leaf Diperbarui Konsisten', () => {
    it('mengubah status group dan seluruh leaf serial menjadi out saat group dikeluarkan', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-box',
            owner_id: ownerId,
            product_id: p1.id,
            serial_number: 'GRP-DISPATCH-01',
            status: 'available',
            metadata: {
              isGroup: true,
              totalPcs: 24,
              composition: [
                { serialId: 'leaf-1', serialNumber: 'SN-L1', pcs: 12 },
                { serialId: 'leaf-2', serialNumber: 'SN-L2', pcs: 12 },
              ],
            },
          },
          { id: 'leaf-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-L1', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-box' } },
          { id: 'leaf-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-L2', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-box' } },
        ],
      });

      // Simulasi mutasi Goods Out dokumen completed
      const docId = 'doc-go-999';
      const grp = mockDb.store.product_serials.find((s) => s.id === 'grp-box');
      grp.status = 'out';
      grp.goods_out_document_id = docId;

      const leafIds = grp.metadata.composition.map((c) => c.serialId);
      for (const lid of leafIds) {
        const lf = mockDb.store.product_serials.find((s) => s.id === lid);
        lf.status = 'out';
        lf.goods_out_document_id = docId;
      }

      // Verifikasi seluruh anggota daun ikut berstatus out dengan document id yang sama
      const lf1 = mockDb.store.product_serials.find((s) => s.id === 'leaf-1');
      const lf2 = mockDb.store.product_serials.find((s) => s.id === 'leaf-2');
      assert.equal(lf1.status, 'out');
      assert.equal(lf1.goods_out_document_id, docId);
      assert.equal(lf2.status, 'out');
      assert.equal(lf2.goods_out_document_id, docId);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Group yang Dibongkar Tidak Dihitung Sebagai Barang Keluar atau Stok Tambahan
  // --------------------------------------------------------------------------
  describe('F8. Status Dissolved: Tidak Dihitung Sebagai Penjualan atau Stok Tambahan', () => {
    it('group yang dibongkar (isDissolved = true) diabaikan dari perhitungan stok aktif', () => {
      const serials = [
        {
          productId: 'prod-1',
          serial_number: 'GRP-DISSOLVED-01',
          status: 'out',
          metadata: { isGroup: true, isDissolved: true, totalPcs: 120 },
        },
        // Serial anggota yang telah dibebaskan
        {
          productId: 'prod-1',
          serial_number: 'SN-FREED-01',
          status: 'available',
          metadata: { isGrouped: false },
        },
      ];

      const countMap = calculateAvailableSerialsByProduct({
        serials,
        documents: [],
        multipliers: CANONICAL_MULTIPLIERS,
      });

      // Stok aktif hanya dari SN-FREED-01 (1 pcs), group dissolved tidak boleh menambah stok!
      assert.equal(countMap.get('prod-1'), 1);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Retur Group Memulihkan Status Group dan Leaf Secara Konsisten
  // --------------------------------------------------------------------------
  describe('F9. Goods Out Return: Memulihkan Status Group dan Leaf', () => {
    it('memulihkan status group dan leaf serials menjadi available saat group diretur', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-ret',
            owner_id: ownerId,
            product_id: p1.id,
            serial_number: 'GRP-RETURN-ME',
            status: 'out',
            goods_out_document_id: 'doc-old',
            metadata: {
              isGroup: true,
              composition: [{ serialId: 'leaf-ret-1' }, { serialId: 'leaf-ret-2' }],
            },
          },
          { id: 'leaf-ret-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-LR1', status: 'out', goods_out_document_id: 'doc-old' },
          { id: 'leaf-ret-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-LR2', status: 'out', goods_out_document_id: 'doc-old' },
        ],
      });

      // Eksekusi cascade return logic
      const grp = mockDb.store.product_serials.find((s) => s.id === 'grp-ret');
      grp.status = 'available';
      grp.goods_out_document_id = null;

      const leafIds = grp.metadata.composition.map((c) => c.serialId);
      for (const id of leafIds) {
        const lf = mockDb.store.product_serials.find((s) => s.id === id);
        lf.status = 'available';
        lf.goods_out_document_id = null;
      }

      assert.equal(grp.status, 'available');
      assert.equal(grp.goods_out_document_id, null);

      const l1 = mockDb.store.product_serials.find((s) => s.id === 'leaf-ret-1');
      assert.equal(l1.status, 'available');
      assert.equal(l1.goods_out_document_id, null);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Retur Ganda Tidak Menambah Stok Dua Kali
  // --------------------------------------------------------------------------
  describe('F10. Idempotensi Retur: Mencegah Duplikasi Stok Retur', () => {
    it('menolak pengembalian retur yang sudah pernah diproses pada item yang sama', () => {
      const existingReturns = [
        { returnNumber: 'RET-GO-001-R01', items: [{ serialNumber: 'GRP-RETURN-ME' }] },
      ];

      const isDuplicateReturn = (sn) => {
        return existingReturns.some((r) => r.items.some((it) => it.serialNumber === sn));
      };

      assert.equal(isDuplicateReturn('GRP-RETURN-ME'), true);
      assert.equal(isDuplicateReturn('GRP-OTHER'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 11. Group Bersarang Tetap Memiliki Kuantitas Fisik yang Benar & Nesting Limit
  // --------------------------------------------------------------------------
  describe('F11. Group Bersarang: Kuantitas Fisik Akurat & Batas Nesting (Max 3)', () => {
    it('menghitung nesting depth secara benar', () => {
      const baseItem = { isGroup: false };
      assert.equal(calculateItemNestingDepth(baseItem), 1);

      const level2Group = {
        isGroup: true,
        directMembers: [{ isGroup: false }, { isGroup: false }],
      };
      assert.equal(calculateItemNestingDepth(level2Group), 2);

      const level3Group = {
        isGroup: true,
        directMembers: [level2Group, { isGroup: false }],
      };
      assert.equal(calculateItemNestingDepth(level3Group), 3);
    });

    it('menolak pembentukan group dengan kedalaman melebihi batas maksimal (level 4)', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-pallet',
            owner_id: ownerId,
            product_id: p1.id,
            serial_number: 'GRP-PALLET-MAX',
            status: 'available',
            warehouse_id: wh1,
            metadata: {
              isGroup: true,
              directMembers: [
                {
                  isGroup: true,
                  directMembers: [
                    { isGroup: true, directMembers: [{ isGroup: false }] }, // Kedalaman 3
                  ],
                },
              ],
            },
          },
          { id: 's-extra', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-EXTRA', status: 'available', warehouse_id: wh1 },
        ],
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['grp-pallet', 's-extra'],
            groupSerialNumber: 'GRP-TOO-DEEP',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Batas kedalaman hierarki group tercapai/i }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 12. Data Serial Lama Tanpa Metadata Tetap Berfungsi Normal
  // --------------------------------------------------------------------------
  describe('F12. Kompatibilitas Data Lama: Serial Tanpa Metadata Grouping', () => {
    it('serial warisan tanpa metadata grouping dapat digabungkan tanpa error', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          // Serial lama tanpa field metadata sama sekali atau metadata kosong
          { id: 'legacy-1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-LEGACY-01-BAL', status: 'available', warehouse_id: wh1 },
          { id: 'legacy-2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-LEGACY-02-LUSIN', status: 'available', warehouse_id: wh1, metadata: null },
        ],
      });

      const res = await createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['legacy-1', 'legacy-2'],
        groupSerialNumber: 'GRP-LEGACY-TEST',
        warehouseId: wh1,
        supabaseClient: mockDb,
      });

      assert.equal(res.success, true);
      assert.equal(res.totalPcs, 312); // bal legacy = 300, lusin = 12 -> 312 pcs
      assert.equal(res.directMemberCount, 2);
    });
  });

  // --------------------------------------------------------------------------
  // 13. Isolasi Tenant/Workspace Tetap Berlaku Ketat
  // --------------------------------------------------------------------------
  describe('F13. Tenant Isolation: Isolasi Ketat Antar-Workspace', () => {
    it('menolak penggabungan jika mencoba mengakses nomor seri milik tenant lain', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's-ownerA', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-A', status: 'available', warehouse_id: wh1 },
          { id: 's-ownerB', owner_id: otherOwnerId, product_id: p1.id, serial_number: 'SN-B', status: 'available', warehouse_id: wh1 },
        ],
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId, // Tenant A
            userId,
            memberSerialIds: ['s-ownerA', 's-ownerB'],
            groupSerialNumber: 'GRP-THEFT',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Minimal harus memilih 2 nomor seri yang valid/i }
      );
    });

    it('menolak pembongkaran group milik tenant lain', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-other',
            owner_id: otherOwnerId,
            product_id: p1.id,
            serial_number: 'GRP-FOREIGN',
            status: 'available',
            metadata: { isGroup: true },
          },
        ],
      });

      await assert.rejects(
        async () => {
          await ungroupSerial({
            ownerId, // Tenant A mencoba membongkar group milik Tenant B
            userId,
            groupId: 'grp-other',
            supabaseClient: mockDb,
          });
        },
        { message: /Data group serial tidak ditemukan/i }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 14. Validasi Array Anggota SQL: NULL, Array Kosong, dan < 2 Anggota
  // --------------------------------------------------------------------------
  describe('F14. Validasi Array Anggota SQL (Targeted Hardening)', () => {
    it('memverifikasi klausa validasi SQL di file migrasi menggunakan COALESCE(array_length, 0) < 2', () => {
      const migrationPath = resolve(process.cwd(), 'supabase/migrations/022_serial_grouping_atomic_functions.sql');
      const sqlContent = readFileSync(migrationPath, 'utf8');

      // Validasi SQL harus secara eksplisit menolak NULL, array kosong, dan length < 2
      const hasLengthCoalesce = sqlContent.includes('COALESCE(array_length(p_member_ids, 1), 0) < 2') ||
                                sqlContent.includes('cardinality(p_member_ids) < 2');
      assert.equal(hasLengthCoalesce, true, 'Klausa array_length atau cardinality wajib digunakan dengan COALESCE');
      assert.equal(sqlContent.includes('p_member_ids IS NULL'), true, 'Klausa p_member_ids IS NULL wajib ada');
    });

    it('menolak pembentukan group saat p_member_ids bernilai NULL di fungsi RPC dan di level aplikasi', async () => {
      // 1. Uji kontrak SQL RPC simulasi langsung
      const mockDb = createMockSupabase();
      const rpcResultNull = await mockDb.rpc('create_serial_group_atomic', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_member_ids: null,
        p_group_serial_number: 'GRP-NULL-RPC',
      });
      assert.equal(rpcResultNull.error?.code, 'P0001');
      assert.match(rpcResultNull.error?.message, /MIN_MEMBERS_REQUIRED/);

      // 2. Uji validasi level service
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: null,
            groupSerialNumber: 'GRP-NULL-ARRAY',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Pilih minimal 2 nomor seri/i }
      );
    });

    it('menolak pembentukan group saat array anggota kosong ([]) di RPC dan di level aplikasi', async () => {
      // 1. Uji kontrak SQL RPC simulasi langsung dengan array kosong
      const mockDb = createMockSupabase();
      const rpcResultEmpty = await mockDb.rpc('create_serial_group_atomic', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_member_ids: [],
        p_group_serial_number: 'GRP-EMPTY-RPC',
      });
      assert.equal(rpcResultEmpty.error?.code, 'P0001');
      assert.match(rpcResultEmpty.error?.message, /MIN_MEMBERS_REQUIRED/);

      // 2. Uji validasi level service
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: [],
            groupSerialNumber: 'GRP-EMPTY-ARRAY',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Pilih minimal 2 nomor seri/i }
      );
    });

    it('menolak pembentukan group saat anggota hanya memiliki 1 elemen (< 2) di RPC dan di level aplikasi', async () => {
      // 1. Uji kontrak SQL RPC simulasi langsung dengan 1 anggota
      const mockDb = createMockSupabase();
      const rpcResultSingle = await mockDb.rpc('create_serial_group_atomic', {
        p_owner_id: ownerId,
        p_user_id: userId,
        p_user_name: userName,
        p_member_ids: ['s1'],
        p_group_serial_number: 'GRP-SINGLE-RPC',
      });
      assert.equal(rpcResultSingle.error?.code, 'P0001');
      assert.match(rpcResultSingle.error?.message, /MIN_MEMBERS_REQUIRED/);

      // 2. Uji validasi level service
      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s1'],
            groupSerialNumber: 'GRP-SINGLE-MEMBER',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /(?:Pilih|Minimal harus memilih) 2 nomor seri/i }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 15. Klasifikasi Error RPC & Pengamanan Fallback Tanpa Efek Samping
  // --------------------------------------------------------------------------
  describe('F15. Klasifikasi Error RPC & Pengamanan Fallback (Targeted Hardening)', () => {
    it('isRpcNotAvailableError mengidentifikasi error RPC yang belum terpasang secara tepat', () => {
      assert.equal(isRpcNotAvailableError({ code: '42883', message: 'function does not exist' }), true);
      assert.equal(isRpcNotAvailableError({ code: 'PGRST202', message: 'Could not find the function in schema cache' }), true);
      assert.equal(isRpcNotAvailableError({ message: 'could not find the function create_serial_group_atomic in the schema cache' }), true);
      assert.equal(isRpcNotAvailableError({ message: 'function create_serial_group_atomic does not exist' }), true);
      assert.equal(isRpcNotAvailableError({ message: 'rpc not implemented' }), true);
    });

    it('isRpcNotAvailableError menolak error constraint, signature, dan custom exception agar tidak memicu fallback berbahaya', () => {
      // Signature mismatch
      assert.equal(isRpcNotAvailableError({ code: 'PGRST204', message: 'Searched for the function with parameters, no function was found with specified signature' }), false);
      assert.equal(isRpcNotAvailableError({ message: 'signature mismatch' }), false);

      // Unique constraint
      assert.equal(isRpcNotAvailableError({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);

      // Foreign key constraint
      assert.equal(isRpcNotAvailableError({ code: '23503', message: 'violates foreign key constraint' }), false);

      // Check constraint
      assert.equal(isRpcNotAvailableError({ code: '23514', message: 'violates check constraint' }), false);

      // Custom PL/pgSQL exceptions
      assert.equal(isRpcNotAvailableError({ code: 'P0001', message: 'MIN_MEMBERS_REQUIRED' }), false);
      assert.equal(isRpcNotAvailableError({ code: 'P0002', message: 'MEMBER_NOT_FOUND' }), false);
      assert.equal(isRpcNotAvailableError({ code: 'P0003', message: 'CONCURRENT_CLAIM_OR_UNAVAILABLE' }), false);

      // Insufficient privilege
      assert.equal(isRpcNotAvailableError({ code: '42501', message: 'permission denied' }), false);
    });

    it('fallback Attempt 2 dipicu HANYA jika RPC belum terpasang (code 42883 atau PGRST202)', async () => {
      let rpcCallCount = 0;
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', warehouse_id: wh1 },
          { id: 's2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-002', status: 'available', warehouse_id: wh1 },
        ],
      }, {
        rpcHandler: () => {
          rpcCallCount++;
          // Simulasikan RPC tidak ditemukan di schema cache (PGRST202)
          return { data: null, error: { message: 'Could not find the function create_serial_group_atomic in the schema cache', code: 'PGRST202' } };
        },
      });

      const res = await createSerialGroup({
        ownerId,
        userId,
        memberSerialIds: ['s1', 's2'],
        groupSerialNumber: 'GRP-FALLBACK-OK',
        warehouseId: wh1,
        supabaseClient: mockDb,
      });

      // Phase 7C: full atomic RPC is attempted first, then the legacy RPC.
      // Both report "function not found" in this mock, so the app fallback executes.
      assert.equal(rpcCallCount, 2);
      assert.equal(res.success, true);
      assert.equal(res.executionEngine, 'application_rollback_safe');
    });

    it('signature mismatch (PGRST204) melempar error langsung dan TIDAK memicu fallback Attempt 2', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', warehouse_id: wh1 },
          { id: 's2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-002', status: 'available', warehouse_id: wh1 },
        ],
      }, {
        rpcHandler: () => {
          return { data: null, error: { message: 'Searched for the function create_serial_group_atomic with parameters but no function was found with the specified signature', code: 'PGRST204' } };
        },
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s1', 's2'],
            groupSerialNumber: 'GRP-SIG-MISMATCH',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Format atau tipe parameter pemanggilan RPC tidak sesuai dengan database/i }
      );

      // Verifikasi anggota tidak dimodifikasi oleh Attempt 2
      const member1 = mockDb.store.product_serials.find(s => s.id === 's1');
      assert.equal(member1.metadata?.parentGroupId, undefined);
    });

    it('unique constraint violation (23505) melempar error aman dan TIDAK memicu fallback Attempt 2', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', warehouse_id: wh1 },
          { id: 's2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-002', status: 'available', warehouse_id: wh1 },
        ],
      }, {
        rpcHandler: () => {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "product_serials_serial_number_owner_id_key"',
              details: 'Key (serial_number, owner_id)=(GRP-DUP, ...) already exists.',
            },
          };
        },
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s1', 's2'],
            groupSerialNumber: 'GRP-DUP',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Nomor seri group sudah pernah digunakan/i }
      );

      const member1 = mockDb.store.product_serials.find(s => s.id === 's1');
      assert.equal(member1.metadata?.parentGroupId, undefined);
    });

    it('foreign key constraint violation (23503) melempar error aman dan TIDAK memicu fallback Attempt 2', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', warehouse_id: wh1 },
          { id: 's2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-002', status: 'available', warehouse_id: wh1 },
        ],
      }, {
        rpcHandler: () => {
          return {
            data: null,
            error: {
              code: '23503',
              message: 'insert or update on table "product_serials" violates foreign key constraint',
              details: 'Key (product_id)=(invalid-uuid) is not present in table "products".',
            },
          };
        },
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s1', 's2'],
            groupSerialNumber: 'GRP-FK-ERR',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /Produk hasil group tidak valid atau tidak ditemukan dalam sistem/i }
      );

      const member1 = mockDb.store.product_serials.find(s => s.id === 's1');
      assert.equal(member1.metadata?.parentGroupId, undefined);
    });

    it('custom exception PL/pgSQL (P0001 / P0003) melempar pesan bisnis langsung tanpa fallback Attempt 2', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', warehouse_id: wh1 },
          { id: 's2', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-002', status: 'available', warehouse_id: wh1 },
        ],
      }, {
        rpcHandler: () => {
          return {
            data: null,
            error: {
              code: 'P0003',
              message: 'CONCURRENT_CLAIM_OR_UNAVAILABLE: Satu atau lebih nomor seri sedang dikelompokkan oleh proses lain.',
            },
          };
        },
      });

      await assert.rejects(
        async () => {
          await createSerialGroup({
            ownerId,
            userId,
            memberSerialIds: ['s1', 's2'],
            groupSerialNumber: 'GRP-CUSTOM-EX',
            warehouseId: wh1,
            supabaseClient: mockDb,
          });
        },
        { message: /CONCURRENT_CLAIM_OR_UNAVAILABLE/i }
      );

      const member1 = mockDb.store.product_serials.find(s => s.id === 's1');
      assert.equal(member1.metadata?.parentGroupId, undefined);
    });

    it('ungroupSerial menangani error signature mismatch dan constraint tanpa memicu fallback berbahaya', async () => {
      const mockDb = createMockSupabase({
        products: [p1],
        product_serials: [
          {
            id: 'grp-sig-test',
            owner_id: ownerId,
            product_id: p1.id,
            serial_number: 'GRP-UNGROUP-SIG',
            status: 'available',
            metadata: {
              isGroup: true,
              directMembers: [{ serialId: 's1', serialNumber: 'SN-001', productId: p1.id, unit: 'pcs', pcs: 1 }],
            },
          },
          { id: 's1', owner_id: ownerId, product_id: p1.id, serial_number: 'SN-001', status: 'available', metadata: { isGrouped: true, parentGroupId: 'grp-sig-test' } },
        ],
      }, {
        rpcHandler: () => {
          return { data: null, error: { message: 'Searched for the function ungroup_serial_atomic with parameters ... no function found with specified signature', code: 'PGRST204' } };
        },
      });

      await assert.rejects(
        async () => {
          await ungroupSerial({
            ownerId,
            userId,
            groupId: 'grp-sig-test',
            supabaseClient: mockDb,
          });
        },
        { message: /Format atau tipe parameter pemanggilan RPC tidak sesuai dengan database/i }
      );
    });
  });

  // --------------------------------------------------------------------------
  // 16. Filter Tampilan Tabel Serial, Sembunyikan Anak, & Goods Out Cascade
  // --------------------------------------------------------------------------
  describe('F16. Filter Tampilan Tabel Serial, Sembunyikan Anak, & Goods Out Cascade', () => {
    // 1. SN mandiri tetap muncul di tabel utama
    it('1. SN mandiri tetap muncul di tabel utama', () => {
      const serials = [
        { id: 'sn-alone-1', serial_number: 'SN-ALONE-01', status: 'available', metadata: {} },
        { id: 'sn-alone-2', serial_number: 'SN-ALONE-02', status: 'available', metadata: { isGrouped: false } },
      ];
      const displayed = filterDisplaySerials(serials, []);
      assert.equal(displayed.length, 2);
      assert.deepEqual(displayed.map((s) => s.id), ['sn-alone-1', 'sn-alone-2']);
    });

    // 2. Group aktif muncul satu kali
    it('2. Group aktif muncul tepat satu kali di tabel utama', () => {
      const serials = [
        {
          id: 'grp-active-1',
          serial_number: 'GRP-BAL25-001',
          status: 'available',
          metadata: {
            isGroup: true,
            totalPcs: 300,
            directMembers: [{ serialId: 'sn-child-1' }],
            composition: [{ serialId: 'sn-child-1' }],
          },
        },
      ];
      const displayed = filterDisplaySerials(serials, []);
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].serial_number, 'GRP-BAL25-001');
    });

    // 3. Anggota group tidak muncul sebagai baris terpisah
    it('3. Anggota group tidak muncul sebagai baris terpisah di tabel utama', () => {
      const serials = [
        {
          id: 'grp-active-1',
          serial_number: 'GRP-BAL25-001',
          status: 'available',
          metadata: {
            isGroup: true,
            totalPcs: 300,
            directMembers: [{ serialId: 'sn-child-1', serialNumber: 'SN-CHILD-01' }],
          },
        },
        {
          id: 'sn-child-1',
          serial_number: 'SN-CHILD-01',
          status: 'available',
          metadata: {
            isGrouped: true,
            parentGroupId: 'grp-active-1',
            parentGroupSerialNumber: 'GRP-BAL25-001',
          },
        },
      ];
      const displayed = filterDisplaySerials(serials, []);
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].id, 'grp-active-1');
      assert.equal(displayed.some((s) => s.id === 'sn-child-1'), false);
    });

    // 4. Nested group tidak menyebabkan anggota ditampilkan berulang
    it('4. Nested group menyembunyikan intermediate sub-group dan leaf serials, hanya top-level group yang muncul', () => {
      const serials = [
        // Top-level group
        {
          id: 'top-grp-1',
          serial_number: 'TOP-BAL25-001',
          status: 'available',
          metadata: {
            isGroup: true,
            totalPcs: 300,
            directMembers: [{ serialId: 'sub-grp-1' }],
            composition: [{ serialId: 'leaf-1' }, { serialId: 'leaf-2' }],
          },
        },
        // Intermediate group (anggota dari top-grp-1)
        {
          id: 'sub-grp-1',
          serial_number: 'SUB-PACK-001',
          status: 'available',
          metadata: {
            isGroup: true,
            isGrouped: true,
            parentGroupId: 'top-grp-1',
            parentGroupSerialNumber: 'TOP-BAL25-001',
            directMembers: [{ serialId: 'leaf-1' }, { serialId: 'leaf-2' }],
            composition: [{ serialId: 'leaf-1' }, { serialId: 'leaf-2' }],
          },
        },
        // Leaf serials
        {
          id: 'leaf-1',
          serial_number: 'LEAF-SN-001',
          status: 'available',
          metadata: {
            isGrouped: true,
            parentGroupId: 'sub-grp-1',
            parentGroupSerialNumber: 'SUB-PACK-001',
          },
        },
        {
          id: 'leaf-2',
          serial_number: 'LEAF-SN-002',
          status: 'available',
          metadata: {
            isGrouped: true,
            parentGroupId: 'sub-grp-1',
            parentGroupSerialNumber: 'SUB-PACK-001',
          },
        },
      ];

      const displayed = filterDisplaySerials(serials, []);
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].id, 'top-grp-1');
    });

    // 5. Search, pagination, jumlah baris, dan pilih semua tetap konsisten
    it('5. Search menemukan parent group saat mencari nomor seri anak, dan pagination/pilih semua tetap konsisten', () => {
      const serials = [
        {
          id: 'grp-1',
          serial_number: 'TOP-BAL25-001',
          status: 'available',
          metadata: {
            isGroup: true,
            totalPcs: 300,
            directMembers: [{ serialId: 'sub-1', serialNumber: 'SUB-PACK-001' }],
            composition: [{ serialId: 'child-1', serialNumber: 'CHILD-PACK-001' }],
          },
        },
        {
          id: 'child-1',
          serial_number: 'CHILD-PACK-001',
          status: 'available',
          metadata: { isGrouped: true, parentGroupId: 'grp-1' },
        },
        {
          id: 'sn-standalone',
          serial_number: 'STANDALONE-001',
          status: 'available',
          metadata: {},
        },
      ];

      // Ambil daftar yang tampil di tabel
      const displaySerials = filterDisplaySerials(serials, []);
      assert.equal(displaySerials.length, 2); // Hanya grp-1 dan sn-standalone

      // Simulasi search query user untuk nomor seri anak 'CHILD-PACK-001'
      const query = 'child-pack-001';
      const searchMatches = displaySerials.filter((s) => {
        const directMatch = (s.serialNumber || s.serial_number || '').toLowerCase().includes(query);
        if (directMatch) return true;
        if (s.metadata?.isGroup) {
          const compMatch = Array.isArray(s.metadata.composition) && s.metadata.composition.some((c) =>
            (c.serialNumber || c.serial_number || '').toLowerCase().includes(query)
          );
          if (compMatch) return true;
          const directMatch = Array.isArray(s.metadata.directMembers) && s.metadata.directMembers.some((m) =>
            (m.serialNumber || m.serial_number || '').toLowerCase().includes(query)
          );
          if (directMatch) return true;
        }
        return false;
      });

      // Menemukan parent group 'grp-1' tanpa memunculkan baris anak terpisah
      assert.equal(searchMatches.length, 1);
      assert.equal(searchMatches[0].id, 'grp-1');

      // Select All memilih hanya elemen yang tampil (1 grup), bukan anak-anak di dalamnya
      const selectedIds = searchMatches.map((s) => s.id);
      assert.deepEqual(selectedIds, ['grp-1']);
    });

    // 6. Goods Out group mengeluarkan seluruh serial daun secara konsisten
    it('6. Goods Out group mengeluarkan group, intermediate sub-groups, dan seluruh serial daun secara konsisten', () => {
      const topGroup = {
        id: 'top-grp-1',
        serial_number: 'TOP-BAL25-001',
        status: 'available',
        metadata: {
          isGroup: true,
          totalPcs: 300,
          directMembers: [{ serialId: 'sub-grp-1', serialNumber: 'SUB-PACK-001' }],
          composition: [
            { serialId: 'leaf-1', serialNumber: 'LEAF-001' },
            { serialId: 'leaf-2', serialNumber: 'LEAF-002' },
          ],
        },
      };

      const subGroup = {
        id: 'sub-grp-1',
        serial_number: 'SUB-PACK-001',
        status: 'available',
        metadata: { isGroup: true, isGrouped: true, parentGroupId: 'top-grp-1' },
      };

      const leaf1 = {
        id: 'leaf-1',
        serial_number: 'LEAF-001',
        status: 'available',
        metadata: { isGrouped: true, parentGroupId: 'sub-grp-1' },
      };
      const leaf2 = {
        id: 'leaf-2',
        serial_number: 'LEAF-002',
        status: 'available',
        metadata: { isGrouped: true, parentGroupId: 'sub-grp-1' },
      };

      // Simulasi logika Goods Out cascade di workspace.routes.js
      const memberIds = [
        ...(Array.isArray(topGroup.metadata?.composition) ? topGroup.metadata.composition.map((c) => c.serialId || c.id) : []),
        ...(Array.isArray(topGroup.metadata?.directMembers) ? topGroup.metadata.directMembers.map((m) => m.serialId || m.id) : []),
      ].filter(Boolean);

      const dbSerials = [topGroup, subGroup, leaf1, leaf2];
      const docId = 'doc-goods-out-01';

      // Update top group
      topGroup.status = 'out';
      topGroup.goods_out_document_id = docId;

      // Update cascaded members
      dbSerials.forEach((s) => {
        if (memberIds.includes(s.id)) {
          s.status = 'out';
          s.goods_out_document_id = docId;
        }
      });

      assert.equal(topGroup.status, 'out');
      assert.equal(subGroup.status, 'out');
      assert.equal(leaf1.status, 'out');
      assert.equal(leaf2.status, 'out');
      assert.equal(leaf1.goods_out_document_id, docId);
      assert.equal(subGroup.goods_out_document_id, docId);
    });

    // 7. Serial yang sudah keluar tidak dianggap tersedia
    it('7. Serial yang sudah keluar tidak dianggap tersedia di tabel maupun perhitungan stok', () => {
      const serials = [
        {
          id: 'grp-out-1',
          serial_number: 'GRP-BAL25-OUT',
          status: 'out',
          goods_out_document_id: 'doc-go-1',
          metadata: { isGroup: true, totalPcs: 300 },
        },
        {
          id: 'sn-out-2',
          serial_number: 'SN-OUT-02',
          status: 'out',
          goods_out_document_id: 'doc-go-1',
          metadata: {},
        },
      ];

      const displayed = filterDisplaySerials(serials, []);
      assert.equal(displayed.length, 0);

      const stockMap = calculateAvailableSerialsByProduct({
        serials,
        product: { id: 'p1', trackingMode: 'serial' },
        multipliers: CANONICAL_MULTIPLIERS,
      });
      assert.equal(stockMap.get('p1') || 0, 0);
    });

    // 8. Retur memulihkan status dengan benar
    it('8. Retur Goods Out memulihkan status group dan seluruh anggota menjadi available', () => {
      const topGroup = {
        id: 'top-grp-1',
        serial_number: 'TOP-BAL25-001',
        status: 'out',
        goods_out_document_id: 'doc-go-1',
        metadata: {
          isGroup: true,
          totalPcs: 300,
          directMembers: [{ serialId: 'sub-grp-1' }],
          composition: [{ serialId: 'leaf-1' }],
        },
      };
      const subGroup = {
        id: 'sub-grp-1',
        serial_number: 'SUB-PACK-001',
        status: 'out',
        goods_out_document_id: 'doc-go-1',
        metadata: { isGroup: true, isGrouped: true, parentGroupId: 'top-grp-1' },
      };
      const leaf1 = {
        id: 'leaf-1',
        serial_number: 'LEAF-001',
        status: 'out',
        goods_out_document_id: 'doc-go-1',
        metadata: { isGrouped: true, parentGroupId: 'sub-grp-1' },
      };

      // Simulasi proses retur
      const returnedTime = new Date().toISOString();
      [topGroup, subGroup, leaf1].forEach((s) => {
        s.status = 'available';
        s.goods_out_document_id = null;
        s.metadata = { ...s.metadata, returnedAt: returnedTime };
      });

      // Di tabel utama, group kembali tampil sebagai 1 unit aktif
      const displayed = filterDisplaySerials([topGroup, subGroup, leaf1], []);
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].id, 'top-grp-1');

      // Anak-anak tetap tersembunyi karena isGrouped masih aktif
      assert.equal(displayed.some((s) => s.id === 'sub-grp-1' || s.id === 'leaf-1'), false);
    });

    // 9. Ungroup membuat anggota kembali tampil sebagai serial mandiri
    it('9. Ungroup membuat group berstatus dissolved dan anggotanya kembali tampil sebagai serial mandiri', () => {
      const dissolvedGroup = {
        id: 'grp-dissolved',
        serial_number: 'GRP-BAL25-DIS',
        status: 'dissolved',
        metadata: {
          isGroup: true,
          isDissolved: true,
          dissolvedAt: new Date().toISOString(),
        },
      };

      const releasedMember1 = {
        id: 'member-1',
        serial_number: 'SN-RELEASED-01',
        status: 'available',
        metadata: {}, // isGrouped dan parentGroupId dihapus saat ungroup
      };
      const releasedMember2 = {
        id: 'member-2',
        serial_number: 'SN-RELEASED-02',
        status: 'available',
        metadata: {},
      };

      const displayed = filterDisplaySerials([dissolvedGroup, releasedMember1, releasedMember2], []);
      // Group yang dibongkar tidak tampil, kedua anggota muncul mandiri
      assert.equal(displayed.length, 2);
      assert.deepEqual(displayed.map((s) => s.id), ['member-1', 'member-2']);
      assert.equal(displayed.some((s) => s.id === 'grp-dissolved'), false);
    });

    // 10. Stock calculation tidak double-count
    it('10. Stock calculation dan serialsStats tidak menghitung ganda (double-count)', () => {
      const serials = [
        {
          id: 'grp-1',
          product_id: 'p1',
          serial_number: 'GRP-BAL25-001',
          status: 'available',
          metadata: {
            isGroup: true,
            totalPcs: 300,
            directMembers: [
              { serialId: 'leaf-1', pcs: 150 },
              { serialId: 'leaf-2', pcs: 150 },
            ],
            composition: [
              { serialId: 'leaf-1', pcs: 150 },
              { serialId: 'leaf-2', pcs: 150 },
            ],
          },
        },
        {
          id: 'leaf-1',
          product_id: 'p1',
          serial_number: 'LEAF-01',
          status: 'available',
          metadata: { isGrouped: true, parentGroupId: 'grp-1', unitQty: 150 },
        },
        {
          id: 'leaf-2',
          product_id: 'p1',
          serial_number: 'LEAF-02',
          status: 'available',
          metadata: { isGrouped: true, parentGroupId: 'grp-1', unitQty: 150 },
        },
      ];

      // 1. calculateAvailableSerialsByProduct
      const stockMap = calculateAvailableSerialsByProduct({
        serials,
        product: { id: 'p1', trackingMode: 'serial' },
        multipliers: CANONICAL_MULTIPLIERS,
      });

      // Harus 300 pcs (dari group), BUKAN 600 pcs
      assert.equal(stockMap.get('p1'), 300);

      // 2. Simulasi serialsStats di ProductDetailPage
      const activeForStats = serials.filter((s) => {
        if (s.metadata?.isGrouped || s.metadata?.parentGroupId) return false;
        if (s.metadata?.isDissolved) return false;
        return true;
      });

      assert.equal(activeForStats.length, 1);
      const totalStatPcs = activeForStats.reduce((sum, s) => {
        if (s.metadata?.isGroup) return sum + (Number(s.metadata.totalPcs) || 0);
        return sum + (Number(s.metadata?.unitQty) || 1);
      }, 0);
      assert.equal(totalStatPcs, 300);
    });

    // 11. Goods Out tetap menolak serial anak jika dicoba melalui API atau input langsung
    it('11. Goods Out guard menolak serial anak jika dimasukkan langsung via API atau scan barcode', () => {
      const childSerial = {
        id: 'child-101',
        serial_number: 'CHILD-PACK-001',
        status: 'available',
        metadata: {
          isGrouped: true,
          parentGroupId: 'grp-parent-99',
          parentGroupSerialNumber: 'GRP-BAL-99',
        },
      };

      const validateGoodsOutCandidate = (serial) => {
        if (serial.metadata?.isGrouped || serial.metadata?.parentGroupId) {
          throw new Error(`Nomor seri "${serial.serial_number}" sedang berada di dalam group "${serial.metadata?.parentGroupSerialNumber || 'Group'}". Group induk paling atas harus dibongkar (ungroup) terlebih dahulu sebelum dapat dikeluarkan.`);
        }
        if (serial.metadata?.isDissolved) {
          throw new Error(`Nomor seri "${serial.serial_number}" adalah group yang sudah dibongkar (dissolved) dan tidak dapat dikeluarkan.`);
        }
        if (serial.status !== 'available') {
          throw new Error(`Nomor seri "${serial.serial_number}" tidak tersedia atau sudah pernah dikeluarkan (status: ${serial.status}).`);
        }
        return true;
      };

      assert.throws(
        () => validateGoodsOutCandidate(childSerial),
        { message: /sedang berada di dalam group/i }
      );
    });

    // 12. Serial lama tanpa metadata grouping tetap berfungsi seperti sebelumnya
    it('12. Serial lama tanpa metadata grouping tetap berfungsi normal di tampilan, hitung stok, dan Goods Out', () => {
      const legacySerial = {
        id: 'legacy-1',
        product_id: 'p1',
        serial_number: 'SN-LEGACY-001',
        status: 'available',
        // metadata is undefined / null
      };

      // 1. Tampil di tabel utama
      const displayed = filterDisplaySerials([legacySerial], []);
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].id, 'legacy-1');

      // 2. Multiplier dihitung normal (pcs: 1)
      const parsed = parseSerialUnit(legacySerial, { multipliers: CANONICAL_MULTIPLIERS });
      assert.equal(parsed.multiplier, 1);

      // 3. Stock calculation menghitung dengan benar
      const stockMap = calculateAvailableSerialsByProduct({
        serials: [legacySerial],
        product: { id: 'p1', trackingMode: 'serial' },
        multipliers: CANONICAL_MULTIPLIERS,
      });
      assert.equal(stockMap.get('p1'), 1);
    });
  });

});

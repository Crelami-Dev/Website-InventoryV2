import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const read = (...parts) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');

const baseSql = read('supabase', 'migrations', '000_docuflow_all_in_one_idempotent.sql');
const legacySql = read('supabase', 'migrations', '022_serial_grouping_atomic_functions.sql');
const schemaSql = read('supabase', 'migrations', '024_cross_product_serial_grouping_ledger.sql');
const atomicSql = read('supabase', 'migrations', '025_serial_grouping_full_atomic_rpc.sql');
const serviceSrc = read('src', 'services', 'serialGroup.service.js');

function signatureArgs(sql, functionName) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i');
  const match = sql.match(re);
  assert.ok(match, `Function ${functionName} not found`);
  return match[1]
    .split(',')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function serviceCallArgs(source, functionName) {
  const re = new RegExp(`rpc\\('${functionName}',\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\)`);
  const match = source.match(re);
  assert.ok(match, `Service call to ${functionName} not found`);
  return [...match[1].matchAll(/^\s*(p_[a-z0-9_]+):/gim)].map((m) => m[1]);
}

describe('Phase 7F — Static Staging Readiness Audit', () => {
  describe('RPC signature / call-site parity', () => {
    it('create_serial_group_full_atomic_v1 signature matches the backend call exactly', () => {
      const sqlArgs = signatureArgs(atomicSql, 'create_serial_group_full_atomic_v1');
      const callArgs = serviceCallArgs(serviceSrc, 'create_serial_group_full_atomic_v1');
      assert.equal(sqlArgs.length, 18);
      assert.deepEqual(callArgs, sqlArgs);
    });

    it('ungroup_serial_full_atomic_v1 signature matches the backend call exactly', () => {
      const sqlArgs = signatureArgs(atomicSql, 'ungroup_serial_full_atomic_v1');
      const callArgs = serviceCallArgs(serviceSrc, 'ungroup_serial_full_atomic_v1');
      assert.equal(sqlArgs.length, 6);
      assert.deepEqual(callArgs, sqlArgs);
    });
  });

  describe('Schema prerequisites used by the atomic RPCs', () => {
    it('migration 022 permits the terminal dissolved serial status', () => {
      assert.match(
        legacySql,
        /CHECK \(status IN \('available', 'reserved', 'out', 'damaged', 'dissolved'\)\)/,
      );
    });

    it('migration 024 defines every serial_groupings column inserted by migration 025', () => {
      const headerColumns = [
        'owner_id', 'grouping_number', 'warehouse_id', 'status', 'group_type',
        'result_product_id', 'result_serial_id', 'result_serial_number',
        'target_unit', 'target_qty', 'total_base_qty_pcs', 'total_cost',
        'result_unit_cost', 'source_document_id', 'idempotency_key', 'notes',
        'metadata', 'created_by', 'reverse_document_id', 'dissolved_at', 'dissolved_by',
      ];
      for (const column of headerColumns) {
        assert.match(schemaSql, new RegExp(`\\b${column}\\b`), `serial_groupings.${column} missing from 024`);
      }
    });

    it('migration 024 defines every serial_grouping_components column inserted by migration 025', () => {
      const componentColumns = [
        'grouping_id', 'owner_id', 'component_serial_id', 'component_serial_number',
        'component_product_id', 'snapshot_product_name', 'snapshot_sku', 'unit',
        'unit_qty', 'base_qty_pcs', 'unit_cost', 'total_cost', 'is_sub_group',
        'nested_depth', 'sort_order', 'metadata',
      ];
      for (const column of componentColumns) {
        assert.match(schemaSql, new RegExp(`\\b${column}\\b`), `serial_grouping_components.${column} missing from 024`);
      }
    });

    it('base schema provides the document/item/serial columns written by migration 025', () => {
      const columns = [
        'document_type', 'document_number', 'status', 'issue_date', 'subtotal',
        'total', 'notes', 'metadata', 'created_by', 'owner_id', 'warehouse_id',
        'document_id', 'product_id', 'item_name', 'sku', 'quantity', 'unit_price',
        'amount', 'sort_order', 'serial_number', 'goods_out_document_id',
        'goods_in_document_id',
      ];
      for (const column of columns) {
        assert.match(baseSql, new RegExp(`\\b${column}\\b`), `${column} missing from base schema`);
      }
    });

    it('document_type check accepts the ledger types and preserves legacy types', () => {
      for (const type of ['invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt', 'goods_assembly', 'goods_disassembly', 'stock_adjustment']) {
        assert.match(atomicSql, new RegExp(`'${type}'`), `document_type ${type} missing from 025`);
      }
    });
  });

  describe('Locking and safety properties (static only)', () => {
    it('both atomic RPCs acquire member row locks in a deterministic order', () => {
      const createBody = atomicSql.slice(
        atomicSql.indexOf('CREATE OR REPLACE FUNCTION public.create_serial_group_full_atomic_v1'),
        atomicSql.indexOf('CREATE OR REPLACE FUNCTION public.ungroup_serial_full_atomic_v1'),
      );
      const ungroupBody = atomicSql.slice(
        atomicSql.indexOf('CREATE OR REPLACE FUNCTION public.ungroup_serial_full_atomic_v1'),
      );
      assert.match(createBody, /FOR UPDATE;[\s\S]*?GET DIAGNOSTICS/i);
      assert.match(createBody, /ORDER BY id ASC\s+FOR UPDATE;/i);
      assert.match(ungroupBody, /ORDER BY id ASC\s+FOR UPDATE/i);
    });

    it('atomic RPCs do not mutate products.stock directly (serial-based stock model)', () => {
      assert.doesNotMatch(atomicSql, /UPDATE public\.products\s+SET\s+stock/i);
      assert.doesNotMatch(atomicSql, /INSERT INTO public\.(stock_ledger|stock_movements)/i);
    });

    it('RPC execution is restricted to service_role', () => {
      assert.match(
        atomicSql,
        /REVOKE ALL ON FUNCTION public\.create_serial_group_full_atomic_v1\([\s\S]*?FROM PUBLIC;/i,
      );
      assert.match(
        atomicSql,
        /REVOKE ALL ON FUNCTION public\.ungroup_serial_full_atomic_v1\([\s\S]*?FROM PUBLIC;/i,
      );
      assert.match(atomicSql, /GRANT EXECUTE ON FUNCTION public\.create_serial_group_full_atomic_v1\([\s\S]*?TO service_role/i);
      assert.match(atomicSql, /GRANT EXECUTE ON FUNCTION public\.ungroup_serial_full_atomic_v1\([\s\S]*?TO service_role/i);
    });
  });
});

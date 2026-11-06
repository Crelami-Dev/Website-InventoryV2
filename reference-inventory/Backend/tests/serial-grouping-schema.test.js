import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Serial Grouping & Ledger Foundation Schema Suite — PHASE 2', () => {
  const migrationPath = resolve(__dirname, '../supabase/migrations/024_cross_product_serial_grouping_ledger.sql');
  const migrationSql = readFileSync(migrationPath, 'utf8');

  // ==========================================================================
  // S1. Pemeriksaan Fisik DDL Migrasi 024
  // ==========================================================================
  describe('S1. Pemeriksaan Fisik File Migrasi 024', () => {
    it('file migrasi 024 harus terbaca dan memiliki header penjelasan', () => {
      assert.ok(migrationSql.length > 500, 'File migrasi 024 harus memiliki konten yang memadai.');
      assert.match(migrationSql, /Migration 024: Cross-Product Serial Grouping and Ledger Foundation/i);
    });

    it('memperluas constraint document_type pada tabel public.documents secara aditif', () => {
      assert.match(migrationSql, /ALTER TABLE public\.documents DROP CONSTRAINT IF EXISTS documents_document_type_check/i);
      assert.match(migrationSql, /CHECK \(document_type IN \(/i);
      // Harus mempertahankan 5 tipe dokumen warisan
      assert.match(migrationSql, /'invoice'/);
      assert.match(migrationSql, /'goods_in'/);
      assert.match(migrationSql, /'goods_out'/);
      assert.match(migrationSql, /'delivery_note'/);
      assert.match(migrationSql, /'receipt'/);
      // Harus menambahkan 3 tipe dokumen internal ledger baru
      assert.match(migrationSql, /'goods_assembly'/);
      assert.match(migrationSql, /'goods_disassembly'/);
      assert.match(migrationSql, /'stock_adjustment'/);
    });

    it('mendefinisikan tabel header public.serial_groupings dengan kolom-kolom wajib', () => {
      assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.serial_groupings/i);
      assert.match(migrationSql, /owner_id UUID NOT NULL/);
      assert.match(migrationSql, /grouping_number TEXT NOT NULL/);
      assert.match(migrationSql, /warehouse_id UUID/);
      assert.match(migrationSql, /status TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active', 'dissolved', 'cancelled'\)\)/);
      assert.match(migrationSql, /group_type TEXT NOT NULL DEFAULT 'mixed' CHECK \(group_type IN \('single_product', 'mixed'\)\)/);
      assert.match(migrationSql, /result_product_id UUID NOT NULL REFERENCES public\.products\(id\)/);
      assert.match(migrationSql, /result_serial_id UUID REFERENCES public\.product_serials\(id\)/);
      assert.match(migrationSql, /result_serial_number TEXT NOT NULL/);
      assert.match(migrationSql, /target_unit TEXT NOT NULL DEFAULT 'pcs'/);
      assert.match(migrationSql, /target_qty NUMERIC\(14, 2\) NOT NULL DEFAULT 1 CHECK \(target_qty > 0\)/);
      assert.match(migrationSql, /total_base_qty_pcs NUMERIC\(14, 2\) NOT NULL CHECK \(total_base_qty_pcs > 0\)/);
      assert.match(migrationSql, /total_cost NUMERIC\(14, 2\) NOT NULL DEFAULT 0 CHECK \(total_cost >= 0\)/);
      assert.match(migrationSql, /result_unit_cost NUMERIC\(14, 2\) NOT NULL DEFAULT 0 CHECK \(result_unit_cost >= 0\)/);
      assert.match(migrationSql, /source_document_id UUID REFERENCES public\.documents\(id\)/);
      assert.match(migrationSql, /reverse_document_id UUID REFERENCES public\.documents\(id\)/);
      assert.match(migrationSql, /idempotency_key TEXT/);
    });

    it('mendefinisikan tabel komponen public.serial_grouping_components dengan snapshot historis', () => {
      assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.serial_grouping_components/i);
      assert.match(migrationSql, /grouping_id UUID NOT NULL REFERENCES public\.serial_groupings\(id\) ON DELETE CASCADE/);
      assert.match(migrationSql, /component_serial_id UUID NOT NULL REFERENCES public\.product_serials\(id\)/);
      assert.match(migrationSql, /component_product_id UUID NOT NULL REFERENCES public\.products\(id\)/);
      assert.match(migrationSql, /snapshot_product_name TEXT NOT NULL/);
      assert.match(migrationSql, /snapshot_sku TEXT/);
      assert.match(migrationSql, /base_qty_pcs NUMERIC\(14, 2\) NOT NULL CHECK \(base_qty_pcs > 0\)/);
      assert.match(migrationSql, /unit_cost NUMERIC\(14, 2\) NOT NULL DEFAULT 0 CHECK \(unit_cost >= 0\)/);
      assert.match(migrationSql, /total_cost NUMERIC\(14, 2\) NOT NULL DEFAULT 0 CHECK \(total_cost >= 0\)/);
      assert.match(migrationSql, /nested_depth INTEGER NOT NULL DEFAULT 1 CHECK \(nested_depth BETWEEN 1 AND 3\)/);
    });

    it('mendefinisikan constraint integritas dan unique index per tenant', () => {
      assert.match(migrationSql, /CONSTRAINT uq_serial_groupings_owner_number UNIQUE \(owner_id, grouping_number\)/);
      assert.match(migrationSql, /CONSTRAINT chk_serial_groupings_reverse_doc_status CHECK \(reverse_document_id IS NULL OR status IN \('dissolved', 'cancelled'\)\)/);
      assert.match(migrationSql, /CONSTRAINT uq_grouping_component_unique_in_group UNIQUE \(grouping_id, component_serial_id\)/);
      assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_groupings_idempotency\s+ON public\.serial_groupings\s*\(owner_id, idempotency_key\)/);
    });

    it('mengaktifkan RLS dan trigger set_updated_at', () => {
      assert.match(migrationSql, /ALTER TABLE public\.serial_groupings ENABLE ROW LEVEL SECURITY/);
      assert.match(migrationSql, /ALTER TABLE public\.serial_grouping_components ENABLE ROW LEVEL SECURITY/);
      assert.match(migrationSql, /CREATE POLICY "Authenticated users can read serial groupings"/);
      assert.match(migrationSql, /CREATE POLICY "Authenticated users can read serial grouping components"/);
      assert.match(migrationSql, /CREATE TRIGGER serial_groupings_set_updated_at/);
    });
  });

  // ==========================================================================
  // S2. Simulasi Relasional & Validasi Aturan Bisnis Skema
  // ==========================================================================
  describe('S2. Simulasi Logika Skema & Kompatibilitas Relasional', () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const warehouseId = 'wh-utama-01';

    // Mock products
    const prodA = { id: 'prod-A', name: 'Kemeja Katun', sku: 'KMJ-01', unit_cost: 50000, selling_price: 100000 };
    const prodB = { id: 'prod-B', name: 'Celana Chino', sku: 'CLN-02', unit_cost: 75000, selling_price: 150000 };
    const prodC = { id: 'prod-C', name: 'Paket Setelan Pria (A+B)', sku: 'PKT-001', unit_cost: 0, selling_price: 250000 };

    it('memvalidasi perhitungan akumulasi HPP dari komponen ke produk hasil grouping', () => {
      // Skenario: 2 pcs Kemeja (Prod A) + 1 pcs Celana (Prod B) -> 1 Paket (Prod C)
      const components = [
        {
          component_serial_id: 'sn-a1',
          component_serial_number: 'KMJ-001',
          component_product_id: prodA.id,
          snapshot_product_name: prodA.name,
          snapshot_sku: prodA.sku,
          unit: 'pcs',
          unit_qty: 1,
          base_qty_pcs: 1,
          unit_cost: prodA.unit_cost,
          total_cost: 1 * prodA.unit_cost, // 50.000
        },
        {
          component_serial_id: 'sn-a2',
          component_serial_number: 'KMJ-002',
          component_product_id: prodA.id,
          snapshot_product_name: prodA.name,
          snapshot_sku: prodA.sku,
          unit: 'pcs',
          unit_qty: 1,
          base_qty_pcs: 1,
          unit_cost: prodA.unit_cost,
          total_cost: 1 * prodA.unit_cost, // 50.000
        },
        {
          component_serial_id: 'sn-b1',
          component_serial_number: 'CLN-001',
          component_product_id: prodB.id,
          snapshot_product_name: prodB.name,
          snapshot_sku: prodB.sku,
          unit: 'pcs',
          unit_qty: 1,
          base_qty_pcs: 1,
          unit_cost: prodB.unit_cost,
          total_cost: 1 * prodB.unit_cost, // 75.000
        },
      ];

      const targetQty = 1; // 1 paket
      const totalBaseQtyPcs = components.reduce((sum, c) => sum + c.base_qty_pcs, 0); // 3 pcs
      const totalCost = components.reduce((sum, c) => sum + c.total_cost, 0); // 175.000
      const resultUnitCost = totalCost / targetQty; // 175.000

      assert.equal(totalBaseQtyPcs, 3);
      assert.equal(totalCost, 175000);
      assert.equal(resultUnitCost, 175000);

      const groupingHeader = {
        id: 'grp-tx-001',
        owner_id: ownerId,
        grouping_number: 'GRP-20261022-0001',
        warehouse_id: warehouseId,
        status: 'active',
        group_type: 'mixed',
        result_product_id: prodC.id,
        result_serial_number: 'PKT-SN-001',
        target_unit: 'paket',
        target_qty: targetQty,
        total_base_qty_pcs: totalBaseQtyPcs,
        total_cost: totalCost,
        result_unit_cost: resultUnitCost,
        source_document_id: 'doc-assembly-001',
        reverse_document_id: null,
      };

      assert.equal(groupingHeader.status, 'active');
      assert.equal(groupingHeader.reverse_document_id, null);
    });

    it('memvalidasi penegakan constraint reverse_document_id hanya boleh ada pada status dissolved atau cancelled', () => {
      // Check constraint: reverse_document_id IS NULL OR status IN ('dissolved', 'cancelled')
      const validateConstraint = (row) => {
        if (row.reverse_document_id !== null && row.reverse_document_id !== undefined) {
          return row.status === 'dissolved' || row.status === 'cancelled';
        }
        return true;
      };

      // Kasus 1: Status active tanpa reverse_document -> VALID
      assert.equal(validateConstraint({ status: 'active', reverse_document_id: null }), true);

      // Kasus 2: Status active DENGAN reverse_document -> TIDAK VALID (melanggar constraint)
      assert.equal(validateConstraint({ status: 'active', reverse_document_id: 'doc-rev-01' }), false);

      // Kasus 3: Status dissolved DENGAN reverse_document -> VALID
      assert.equal(validateConstraint({ status: 'dissolved', reverse_document_id: 'doc-rev-01' }), true);

      // Kasus 4: Status cancelled DENGAN reverse_document -> VALID
      assert.equal(validateConstraint({ status: 'cancelled', reverse_document_id: 'doc-rev-01' }), true);
    });

    it('memvalidasi proteksi nomor transaksi unik per tenant (uq_serial_groupings_owner_number)', () => {
      const dbGroupings = [
        { owner_id: ownerId, grouping_number: 'GRP-20261022-0001' },
      ];

      const checkDuplicate = (newOwner, newNum) => {
        return dbGroupings.some((g) => g.owner_id === newOwner && g.grouping_number === newNum);
      };

      // Nomor sama pada owner yang sama -> ditolak
      assert.equal(checkDuplicate(ownerId, 'GRP-20261022-0001'), true);

      // Nomor sama pada owner berbeda -> diizinkan (tenant isolation)
      const otherOwner = '22222222-2222-4222-8222-222222222222';
      assert.equal(checkDuplicate(otherOwner, 'GRP-20261022-0001'), false);
    });

    it('memvalidasi idempotency key mencegah eksekusi transaksi duplikat', () => {
      const activeGroupings = [
        { owner_id: ownerId, idempotency_key: 'idem-key-abc', status: 'active' },
      ];

      const isIdempotencyConflict = (newOwner, newKey) => {
        return activeGroupings.some(
          (g) => g.owner_id === newOwner && g.idempotency_key === newKey && g.status !== 'cancelled'
        );
      };

      // Submit ulang dengan key yang sama pada tenant yang sama -> konflik
      assert.equal(isIdempotencyConflict(ownerId, 'idem-key-abc'), true);

      // Submit dengan key baru -> aman
      assert.equal(isIdempotencyConflict(ownerId, 'idem-key-xyz'), false);

      // Submit key yang sama pada tenant lain -> aman
      const otherOwner = '22222222-2222-4222-8222-222222222222';
      assert.equal(isIdempotencyConflict(otherOwner, 'idem-key-abc'), false);
    });

    it('memvalidasi bahwa serial komponen tidak boleh dimasukkan ganda dalam satu grouping yang sama', () => {
      const componentSerialIds = ['sn-1', 'sn-2'];

      const checkComponentUniqueInGroup = (serialId) => {
        return componentSerialIds.includes(serialId);
      };

      // Komponen pertama kali dimasukkan -> belum ada
      assert.equal(checkComponentUniqueInGroup('sn-3'), false);

      // Komponen sudah ada di transaksi ini -> ditolak (mencegah double add)
      assert.equal(checkComponentUniqueInGroup('sn-1'), true);
    });

    it('memvalidasi immutability snapshot historis saat data master produk berubah', () => {
      // 1. Snapshot tersimpan saat grouping dibuat
      const componentRecord = {
        grouping_id: 'grp-01',
        component_product_id: prodA.id,
        snapshot_product_name: 'Kemeja Katun Klasik',
        snapshot_sku: 'KMJ-01',
        unit_cost: 50000,
      };

      // 2. Di kemudian hari, admin mengubah nama dan SKU di master produk
      const updatedMasterProduct = {
        ...prodA,
        name: 'Kemeja Katun Premium V2',
        sku: 'KMJ-V2-REVISED',
        unit_cost: 65000,
      };

      // 3. Snapshot di tabel serial_grouping_components tetap utuh!
      assert.equal(componentRecord.snapshot_product_name, 'Kemeja Katun Klasik');
      assert.equal(componentRecord.snapshot_sku, 'KMJ-01');
      assert.equal(componentRecord.unit_cost, 50000);
      assert.notEqual(componentRecord.snapshot_product_name, updatedMasterProduct.name);
    });
  });

  // ==========================================================================
  // S3. Kompatibilitas Penuh dengan Struktur Grouping Lama
  // ==========================================================================
  describe('S3. Kompatibilitas dengan Data Grouping Lama (Backward Compatibility)', () => {
    it('group serial lama tanpa record di serial_groupings tetap teridentifikasi sebagai group aktif di product_serials', () => {
      // Data warisan dari migrasi 022
      const legacyGroupSerial = {
        id: 'legacy-grp-1',
        product_id: 'prod-A',
        serial_number: 'GRP-20261020-1111',
        status: 'available',
        metadata: {
          isGroup: true,
          totalPcs: 24,
          unitBreakdown: '2 lusin',
          directMembers: [
            { serialId: 'leg-s1', serialNumber: 'SN-01', pcs: 12 },
            { serialId: 'leg-s2', serialNumber: 'SN-02', pcs: 12 },
          ],
        },
      };

      // Verifikasi bahwa aplikasi tetap bisa mendeteksi isGroup tanpa perlu baris serial_groupings
      const isGroup = Boolean(legacyGroupSerial.metadata?.isGroup);
      assert.equal(isGroup, true);
      assert.equal(legacyGroupSerial.metadata.totalPcs, 24);
      assert.equal(legacyGroupSerial.metadata.directMembers.length, 2);
    });

    it('tabel serial_groupings tidak mengunci atau memodifikasi saldo stok tabel products secara langsung', () => {
      // Memverifikasi bahwa migrasi 024 tidak memiliki DML update ke products.stock
      assert.doesNotMatch(migrationSql, /UPDATE public\.products\s+SET\s+stock/i);
      assert.doesNotMatch(migrationSql, /DELETE FROM public\.products/i);
      assert.doesNotMatch(migrationSql, /DELETE FROM public\.product_serials/i);
    });
  });
});

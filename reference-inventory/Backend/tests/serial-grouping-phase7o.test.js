import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveDocumentItemQuantity, calculateDocumentGrandTotal } from '../src/utils/documentQuantity.js';
import { getItemQtyInPcs, getGroupedProductItems } from '../../frontend-new/src/utils/documentTemplate.js';
import { generateReturnReceiptHtml } from '../../frontend-new/src/utils/returnReceiptTemplate.js';
import { computeSourceProductPolicy, withSourceProductPolicy } from '../../frontend-new/src/pages/SerialGrouping/serialGroupingPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

async function read(relativePath, root = backendRoot) {
  return readFile(path.join(root, relativePath), 'utf8');
}

const multipliers = {
  pcs: 1,
  piece: 1,
  lusin: 12,
  dozen: 12,
  pack: 60,
  bal10: 120, // 10 Lusin
  bal15: 180, // 15 Lusin
  bal20: 240, // 20 Lusin
  bal25: 300, // 25 Lusin
  bal: 300,   // Fallback & Legacy compatibility
};

describe('Phase 7O Regression Tests — Grouped Serial Quantity, Returns & Pending UX', () => {

  describe('Section A: Goods Out Grouped Serial Quantity Integrity (13 Lusin = 156 pcs)', () => {
    it('should correctly resolve grouped serial TEST1-G-13LUSIN-231020260001 to 13 lusin and 156 pcs', () => {
      const item = {
        item_name: 'Tester',
        sku: 'test1',
        quantity: 1,
        unit: 'lusin',
        metadata: {
          isSerial: true,
          isGroup: true,
          serialNumber: 'TEST1-G-13LUSIN-231020260001',
          targetQty: 13,
          targetUnit: 'lusin',
          totalPcs: 156,
          qtyInput: 13,
          qtyUnit: 'lusin',
        },
      };

      const resolved = resolveDocumentItemQuantity(item, { multipliers });
      assert.equal(resolved.isGroup, true);
      assert.equal(resolved.qty, 13);
      assert.equal(resolved.unit, 'lusin');
      assert.equal(resolved.totalPcs, 156);

      const clientResolved = getItemQtyInPcs(item);
      assert.equal(clientResolved.isGroup, true);
      assert.equal(clientResolved.qty, 13);
      assert.equal(clientResolved.unit, 'lusin');
      assert.equal(clientResolved.pcs, 156);
    });

    it('regular single-unit serial should remain 1 unit and base pcs', () => {
      const item = {
        item_name: 'Tester',
        sku: 'test1',
        quantity: 1,
        unit: 'lusin',
        metadata: {
          isSerial: true,
          isGroup: false,
          serialNumber: 'TEST1-LUSIN-151020260001',
          qtyInput: 1,
          qtyUnit: 'lusin',
        },
      };

      const resolved = resolveDocumentItemQuantity(item, { multipliers });
      assert.equal(resolved.isGroup, false);
      assert.equal(resolved.qty, 1);
      assert.equal(resolved.unit, 'lusin');
      assert.equal(resolved.totalPcs, 12);

      const clientResolved = getItemQtyInPcs(item);
      assert.equal(clientResolved.isGroup, false);
      assert.equal(clientResolved.qty, 1);
      assert.equal(clientResolved.unit, 'lusin');
      assert.equal(clientResolved.pcs, 12);
    });
  });

  describe('Section B: Returns Full & Partial Integrity for Grouped Serials', () => {
    it('full return of TEST3-G-6LUSIN-231020260001 should return 6 lusin (72 pcs) and mark full return', () => {
      const documentItems = [
        {
          id: 'item-1',
          product_id: 'prod-tester',
          item_name: 'Tester 3',
          sku: 'test3',
          quantity: 1,
          unit: 'lusin',
          metadata: {
            isSerial: true,
            isGroup: true,
            serialNumber: 'TEST3-G-6LUSIN-231020260001',
            targetQty: 6,
            targetUnit: 'lusin',
            totalPcs: 72,
            qtyInput: 6,
            qtyUnit: 'lusin',
          },
        },
      ];

      // Simulated return submission where full serial is returned
      const returnedQty = 6; // correctly submitted as full originalQty
      const returnedItems = [
        {
          itemId: 'item-1',
          productId: 'prod-tester',
          serialNumber: 'TEST3-G-6LUSIN-231020260001',
          returnedQty: 6,
          condition: 'good',
        },
      ];

      // Test template return summary
      const grouped = getGroupedProductItems(
        documentItems,
        multipliers,
        (sn, u) => u,
        (u) => u === 'lusin',
        returnedItems
      );

      assert.equal(grouped.length, 1);
      assert.equal(grouped[0].returnedQty, 6);
      assert.equal(grouped[0].totalPcs, 72);
      assert.equal(grouped[0].returnedPcs, 72);
      assert.equal(grouped[0].isFullyReturned, true);
      assert.equal(grouped[0].isPartiallyReturned, false);
    });

    it('partial return on multi-item document correctly calculates remaining and status', () => {
      const documentItems = [
        {
          id: 'item-1',
          product_id: 'prod-1',
          item_name: 'Product 1',
          sku: 'p1',
          quantity: 1,
          unit: 'lusin',
          metadata: {
            isSerial: true,
            isGroup: true,
            serialNumber: 'TEST1-G-2LUSIN-231020260001',
            targetQty: 2,
            targetUnit: 'lusin',
            totalPcs: 24,
            qtyInput: 2,
            qtyUnit: 'lusin',
          },
        },
        {
          id: 'item-2',
          product_id: 'prod-1',
          item_name: 'Product 1',
          sku: 'p1',
          quantity: 1,
          unit: 'lusin',
          metadata: {
            isSerial: true,
            isGroup: false,
            serialNumber: 'TEST1-LUSIN-151020260001',
            qtyInput: 1,
            qtyUnit: 'lusin',
          },
        },
      ];

      // Only item-1 is returned
      const returnedItems = [
        {
          itemId: 'item-1',
          productId: 'prod-1',
          serialNumber: 'TEST1-G-2LUSIN-231020260001',
          returnedQty: 2,
          condition: 'good',
        },
      ];

      const grouped = getGroupedProductItems(
        documentItems,
        multipliers,
        (sn, u) => u,
        (u) => u === 'lusin',
        returnedItems
      );

      assert.equal(grouped.length, 1);
      // Total qty = 2 + 1 = 3 lusin
      assert.equal(grouped[0].qty, 3);
      assert.equal(grouped[0].totalPcs, 36);
      assert.equal(grouped[0].returnedQty, 2);
      assert.equal(grouped[0].returnedPcs, 24);
      assert.equal(grouped[0].isPartiallyReturned, true);
      assert.equal(grouped[0].isFullyReturned, false);
    });

    it('return detail and print receipt format TEST3-G-6LUSIN-231020260001 as 6 lusin (not 1 lusin)', () => {
      const returnRecord = {
        id: 'ret-1',
        returnNumber: 'RET-WH/OUT/20261023/0012-R04',
        documentId: 'doc-1',
        documentNumber: 'WH/OUT/20261023/0012',
        documentType: 'goods_out',
        reason: 'salah_produk',
        condition: 'available',
        items: [
          {
            itemId: 'item-1',
            productId: 'prod-tester',
            productName: 'Tester 3',
            sku: 'test3',
            isSerial: true,
            isGroup: true,
            serialNumber: 'TEST3-G-6LUSIN-231020260001',
            targetQty: 6,
            targetUnit: 'lusin',
            returnedQty: 6,
            qtyUnit: 'lusin',
          },
        ],
      };

      // 1. Return detail count calculation logic (from ReturnDetailModal.jsx)
      const itemCount = returnRecord.items.reduce((acc, it) => {
        const qty = it.isGroup ? Number(it.targetQty ?? it.returnedQty ?? 1) : Number(it.returnedQty ?? 1);
        return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
      }, 0);
      assert.equal(itemCount, 6);

      // 2. Return list summary calculation logic (from ReturnsPage.jsx)
      const totalQty = (returnRecord.items || []).reduce(
        (acc, it) => {
          const qty = it.isGroup ? Number(it.targetQty ?? it.returnedQty ?? 1) : Number(it.returnedQty ?? 1);
          return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
        },
        0
      );
      assert.equal(totalQty, 6);

      // 3. Print return receipt (generateReturnReceiptHtml in A4 and compact modes)
      const receiptHtmlA4 = generateReturnReceiptHtml(returnRecord, {}, null, 'a4');
      assert.match(receiptHtmlA4, /6\s+lusin/i);
      assert.doesNotMatch(receiptHtmlA4, />1\s+lusin</i);

      const receiptHtmlCompact = generateReturnReceiptHtml(returnRecord, {}, null, 'compact');
      assert.match(receiptHtmlCompact, /6\s+lusin/i);
      assert.doesNotMatch(receiptHtmlCompact, />1\s+lusin</i);
    });
  });

  describe('Section C: Surat Jalan & Total Quantity Authoritative Aggregation', () => {
    it('Surat Jalan with 2 lusin (group), 13 lusin (group), and 1 lusin (regular) totals 16 lusin (192 pcs)', () => {
      const documentItems = [
        {
          item_name: 'Product A',
          sku: 'pa',
          metadata: {
            isSerial: true,
            isGroup: true,
            serialNumber: 'TEST1-G-2LUSIN-231020260001',
            targetQty: 2,
            targetUnit: 'lusin',
            totalPcs: 24,
          },
        },
        {
          item_name: 'Product A',
          sku: 'pa',
          metadata: {
            isSerial: true,
            isGroup: true,
            serialNumber: 'TEST1-G-13LUSIN-231020260001',
            targetQty: 13,
            targetUnit: 'lusin',
            totalPcs: 156,
          },
        },
        {
          item_name: 'Product A',
          sku: 'pa',
          metadata: {
            isSerial: true,
            isGroup: false,
            serialNumber: 'TEST1-LUSIN-151020260001',
            qtyUnit: 'lusin',
          },
        },
      ];

      // Server-side calculation
      const grandTotal = calculateDocumentGrandTotal(documentItems, { multipliers });
      assert.equal(grandTotal.totalPcs, 192);
      assert.equal(grandTotal.unitBreakdown.lusin, 16);

      // Client-side print template calculation
      const clientItems = documentItems.map((it) => getItemQtyInPcs(it));
      const totalPcs = clientItems.reduce((acc, it) => acc + it.pcs, 0);
      const totalLusin = clientItems.reduce((acc, it) => acc + (it.unit === 'lusin' ? it.qty : 0), 0);

      assert.equal(totalPcs, 192);
      assert.equal(totalLusin, 16);
    });
  });

  describe('Section D & E: Pending Grouping Session Creation & Product Selection Policy', () => {
    it('single-source batch automatically locks result product to source product', () => {
      const serials = [
        { id: 's-1', productId: 'prod-1', productName: 'Produk A', sku: 'SKU-A' },
        { id: 's-2', productId: 'prod-1', productName: 'Produk A', sku: 'SKU-A' },
      ];

      const policy = computeSourceProductPolicy(serials);
      assert.equal(policy.isSingleSourceProduct, true);
      assert.equal(policy.productSelectionLocked, true);
      assert.equal(policy.lockedResultProductId, 'prod-1');

      const batch = { id: 'batch-1', serials: [] };
      const updatedBatch = withSourceProductPolicy(batch, serials);
      assert.equal(updatedBatch.targetProductId, 'prod-1');
      assert.equal(updatedBatch.isNewProduct, false);
    });

    it('cross-product batch requires explicit product selection and resets carry-over from single source', () => {
      const singleSourceSerials = [
        { id: 's-1', productId: 'prod-1', productName: 'Produk A', sku: 'SKU-A' },
        { id: 's-2', productId: 'prod-1', productName: 'Produk A', sku: 'SKU-A' },
      ];
      const initialBatch = withSourceProductPolicy({ id: 'b-1' }, singleSourceSerials);
      assert.equal(initialBatch.targetProductId, 'prod-1');

      // Adding a third serial from prod-2 turns it into cross-product
      const mixedSerials = [
        ...singleSourceSerials,
        { id: 's-3', productId: 'prod-2', productName: 'Produk B', sku: 'SKU-B' },
      ];

      const updatedBatch = withSourceProductPolicy(initialBatch, mixedSerials);
      const policy = computeSourceProductPolicy(mixedSerials);

      assert.equal(policy.distinctProductCount, 2);
      assert.equal(policy.productSelectionLocked, false);
      // Auto-locked product from single source must be cleared
      assert.equal(updatedBatch.targetProductId, '');
    });
  });

  describe('Section F: Add Group Modal UX & Footer Actions Audit', () => {
    it('SerialMultiGroupingModal.jsx must not contain "Proses Langsung (Selesai)" button or handleProcessValidBatches', async () => {
      const fileContent = await read('frontend-new/src/pages/SerialGrouping/SerialMultiGroupingModal.jsx', repoRoot);

      assert.doesNotMatch(fileContent, /Proses Langsung \(Selesai\)/);
      assert.doesNotMatch(fileContent, /handleProcessValidBatches/);
      assert.match(fileContent, /Simpan Sesi \(Pending\)/);
      assert.match(fileContent, /Tinjau Sesi Pending/);
      assert.match(fileContent, /Konfirmasi &amp; Simpan Pending/);
      assert.match(fileContent, /Kembali untuk Mengedit/);
    });
  });
});

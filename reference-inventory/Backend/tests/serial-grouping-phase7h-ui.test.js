import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getGroupingDisplayRow,
  getGroupingDisplayRows,
  getGroupingComponentRow,
  getGroupingComponentRows,
} from '../../frontend-new/src/pages/SerialGrouping/serialGroupingDisplay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const groupingDir = resolve(repoRoot, 'frontend-new', 'src', 'pages', 'SerialGrouping');

const read = (name) => readFileSync(resolve(groupingDir, name), 'utf8');
const pageSrc = read('SerialGroupingPage.jsx');
const detailSrc = read('SerialGroupingDetailModal.jsx');
const multiSrc = read('SerialMultiGroupingModal.jsx');
const pageCss = read('SerialGroupingPage.css');
const multiCss = read('SerialMultiGroupingModal.css');
const productAdapterSrc = readFileSync(
  resolve(repoRoot, 'frontend-new', 'src', 'pages', 'Products', 'SerialGroupModal.jsx'),
  'utf8',
);

function grouping(overrides = {}) {
  return {
    id: 'grp-1',
    status: 'completed',
    grouping_number: 'GRP-23102026-0001',
    result_serial_number: 'TEST1-PACK-G-3LUSIN-231020260001',
    target_unit: 'lusin',
    created_at: '2026-10-23T10:00:00.000Z',
    warehouse_id: 'wh-1',
    assembly_document_number: 'ASM-23102026-0001',
    reversal_document_number: null,
    result_product: { id: 'prod-result', name: 'Paket Eksekutif', sku: 'PKT-01' },
    ...overrides,
  };
}

describe('PHASE 7H — Grouping list shows one row per batch', () => {
  it('maps one grouping record to exactly one display row', () => {
    const rows = getGroupingDisplayRows([grouping()]);

    assert.equal(rows.length, 1);
    assert.deepEqual(
      {
        reference: rows[0].reference,
        resultSerialNumber: rows[0].resultSerialNumber,
        resultProductName: rows[0].resultProductName,
        resultProductSku: rows[0].resultProductSku,
        unit: rows[0].unit,
      },
      {
        reference: 'ASM-23102026-0001',
        resultSerialNumber: 'TEST1-PACK-G-3LUSIN-231020260001',
        resultProductName: 'Paket Eksekutif',
        resultProductSku: 'PKT-01',
        unit: 'lusin',
      },
    );
  });

  it('keeps two distinct batches as two separate rows', () => {
    const rows = getGroupingDisplayRows([
      grouping(),
      grouping({
        id: 'grp-2',
        grouping_number: 'GRP-23102026-0002',
        result_serial_number: 'TEST1-PACK-G-2LUSIN-231020260002',
        assembly_document_number: 'ASM-23102026-0002',
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.notEqual(rows[0].resultSerialNumber, rows[1].resultSerialNumber);
  });

  it('never uses component serials as the main row identity', () => {
    const row = getGroupingDisplayRow(grouping({
      components: [
        { component_serial_number: 'TEST1-PACK-202610100003978' },
        { component_serial_number: 'TEST1-PACK-202610100001915' },
      ],
    }));

    assert.equal(row.resultSerialNumber, 'TEST1-PACK-G-3LUSIN-231020260001');
    assert.doesNotMatch(row.resultSerialNumber, /202610100003978/);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'components'), false);
  });

  it('uses the official reference and leaves legacy rows without a fabricated one', () => {
    const legacy = getGroupingDisplayRow(grouping({
      assembly_document_number: null,
      reference_number: null,
      source_document: null,
      source_document_number: null,
      grouping_number: null,
    }));

    assert.equal(legacy.reference, null);
    assert.equal(legacy.groupingNumber, null);
  });

  it('does not expose price or HPP fields in the display row', () => {
    const row = getGroupingDisplayRow(grouping({ total_cost: 999999, unit_cost: 123456 }));

    for (const key of ['totalCost', 'unitCost', 'resultUnitCost', 'hpp', 'price']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), false);
    }
  });

  it('falls back to flat API fields and preserves dissolved status', () => {
    const row = getGroupingDisplayRow({
      id: 'grp-legacy',
      status: 'dissolved',
      result_serial_number: 'SN-RESULT',
      result_product_name: 'Produk Hasil',
      result_product_sku: 'SKU-RESULT',
      target_unit: 'pcs',
      assembly_document_number: 'ASM-LEGACY',
    });

    assert.equal(row.status, 'dissolved');
    assert.equal(row.resultProductName, 'Produk Hasil');
    assert.equal(row.resultProductSku, 'SKU-RESULT');
  });
});

describe('PHASE 7H — Detail shows only the batch components', () => {
  it('maps persisted components to the four display fields', () => {
    const rows = getGroupingComponentRows([
      {
        id: 'c-1',
        component_serial_number: 'SN-A-001',
        snapshot_product_name: 'Kemeja',
        snapshot_sku: 'KMJ-01',
        unit: 'pcs',
        unit_qty: 2,
        unit_cost: 50000,
        total_cost: 100000,
      },
      {
        id: 'c-2',
        component_serial_number: 'SN-B-001',
        snapshot_product_name: 'Dasi',
        snapshot_sku: 'DSI-01',
        unit: 'lusin',
      },
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      id: 'c-1',
      serialNumber: 'SN-A-001',
      productName: 'Kemeja',
      sku: 'KMJ-01',
      unit: 'pcs',
      isSubGroup: false,
    });
    assert.equal(rows[1].productName, 'Dasi');
    assert.equal(rows[1].sku, 'DSI-01');
    assert.equal(rows[1].unit, 'lusin');
  });

  it('keeps each source product identity for cross-product batches', () => {
    const rows = getGroupingComponentRows([
      { component_serial_number: 'SN-A', snapshot_product_name: 'Kemeja', snapshot_sku: 'KMJ', unit: 'pcs' },
      { component_serial_number: 'SN-B', snapshot_product_name: 'Dasi', snapshot_sku: 'DSI', unit: 'pcs' },
    ]);

    assert.deepEqual(rows.map((r) => r.productName), ['Kemeja', 'Dasi']);
    assert.deepEqual(rows.map((r) => r.sku), ['KMJ', 'DSI']);
  });

  it('omits quantity, HPP and total cost from component rows', () => {
    const [row] = getGroupingComponentRows([
      {
        component_serial_number: 'SN-A',
        snapshot_product_name: 'Kemeja',
        snapshot_sku: 'KMJ',
        unit: 'pcs',
        unit_qty: 3,
        base_quantity_pcs: 36,
        unit_cost: 50000,
        total_cost: 150000,
      },
    ]);

    for (const key of ['unitQty', 'unitCost', 'totalCost', 'baseQuantityPcs']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), false);
    }
  });

  it('returns an empty list for legacy groups with no persisted components', () => {
    assert.deepEqual(getGroupingComponentRows(undefined), []);
    assert.deepEqual(getGroupingComponentRows(null), []);
    assert.deepEqual(getGroupingComponentRows([]), []);
  });

  it('supports snapshot fields for historical (dissolved) groupings', () => {
    const row = getGroupingComponentRow({
      component_serial_number: 'SN-HIST',
      snapshot_product_name: 'Produk Lama',
      snapshot_sku: 'OLD-01',
      unit: 'bal10',
      is_sub_group: true,
    });

    assert.equal(row.productName, 'Produk Lama');
    assert.equal(row.isSubGroup, true);
  });
});

describe('PHASE 7H — Static UI contracts', () => {
  it('renders the main table with result identity and no price columns', () => {
    assert.match(pageSrc, /Nomor Seri Hasil Grouping/);
    assert.match(pageSrc, /Nama Produk Hasil/);
    assert.match(pageSrc, /getGroupingDisplayRow/);
    assert.doesNotMatch(pageSrc, /Total HPP/);
    assert.doesNotMatch(pageSrc, /HPP Satuan/);
    assert.doesNotMatch(pageSrc, /formatCurrency/);
    assert.doesNotMatch(pageSrc, /<th[^>]*>\s*No\s*<\/th>/);
    assert.doesNotMatch(pageSrc, /<th[^>]*>\s*Kuantitas\s*<\/th>/);
  });

  it('opens the detail by clicking the row or the detail action', () => {
    assert.match(pageSrc, /className="sg-row-clickable"/);
    assert.match(pageSrc, /onClick=\{\(\) => setSelectedDetailId\(row\.id\)\}/);
    assert.match(pageSrc, /onKeyDown=\{\(e\) => \{/);
    assert.match(pageCss, /\.sg-row-clickable\s*\{[\s\S]*?cursor:\s*pointer/);
  });

  it('shows an honest placeholder when a legacy grouping has no reference', () => {
    assert.match(pageSrc, /row\.reference \?/);
    assert.match(pageSrc, /text-muted">—</);
    assert.doesNotMatch(pageSrc, /GRP-\$\{item\.id/);
  });

  it('renders exactly four component columns without number, qty or price', () => {
    assert.match(detailSrc, /Nomor Seri Sumber/);
    assert.match(detailSrc, /Nama Produk/);
    assert.match(detailSrc, /getGroupingComponentRows/);
    assert.match(detailSrc, /detailData\.result_product\?\.name/);
    assert.match(detailSrc, /detailData\.result_product\?\.sku/);
    assert.match(detailSrc, /detailData\.result_serial_number \|\| detailData\.group_serial_number/);
    assert.doesNotMatch(detailSrc, /HPP/);
    assert.doesNotMatch(detailSrc, /Total Biaya/);
    assert.doesNotMatch(detailSrc, /Kuantitas/);
    assert.doesNotMatch(detailSrc, /formatCurrency/);
    assert.doesNotMatch(detailSrc, /<th[^>]*>\s*No\s*<\/th>/);
    assert.doesNotMatch(detailSrc, /<tfoot/);
    assert.match(detailSrc, /colSpan="4"/);
  });

  it('keeps the component list scrollable for large batches', () => {
    assert.match(read('SerialGroupingDetailModal.css'), /\.sg-table-container\s*\{[\s\S]*?max-height:\s*360px/);
  });

  it('removes the manual grouping entry point from this page', () => {
    assert.doesNotMatch(pageSrc, /Grouping Manual/);
    assert.doesNotMatch(pageSrc, /SerialGroupingCreateModal/);
    assert.doesNotMatch(pageSrc, /isCreateModalOpen/);
    assert.doesNotMatch(pageSrc, /Multi-Grouping \(Scan-First\)/);
  });

  it('shows a single Add Group button that opens Scan-First', () => {
    const addGroupLabels = pageSrc.match(/<span>Add Group<\/span>/g) || [];
    assert.equal(addGroupLabels.length, 1);
    assert.match(pageSrc, /setIsMultiGroupModalOpen\(true\)/);
    assert.match(pageSrc, /<SerialMultiGroupingModal/);
    assert.equal((pageSrc.match(/<SerialMultiGroupingModal/g) || []).length, 1);
  });

  it('keeps the shared manual modal available for the product pages', () => {
    assert.match(productAdapterSrc, /SerialGroupingCreateModal/);
  });

  it('labels the Add Group modal consistently and keeps scan-first flow', () => {
    assert.match(multiSrc, /Add Group — Scan-First/);
    assert.doesNotMatch(multiSrc, /Scan-First Multi-Grouping Serial/);
    assert.match(multiSrc, /handleProcessValidBatches/);
    assert.match(multiSrc, /validBatches\.length/);
    assert.match(multiSrc, /handleAddBatch/);
    assert.match(multiSrc, /Arahkan barcode scanner/);
  });

  it('removes HPP estimates from the Add Group review UI', () => {
    assert.doesNotMatch(multiSrc, /Total HPP/);
    assert.doesNotMatch(multiSrc, /HPP Satuan/);
    assert.doesNotMatch(multiSrc, /Estimasi HPP/);
    assert.doesNotMatch(multiSrc, /formatCurrency/);
  });
});

describe('PHASE 7H — Grouping target unit choices', () => {
  it('offers only pcs and lusin as target units', () => {
    const unitBlock = multiSrc.match(/const CANONICAL_UNITS = \[([\s\S]*?)\];/)?.[1] || '';

    assert.match(unitBlock, /value: 'pcs'/);
    assert.match(unitBlock, /value: 'lusin'/);
    assert.doesNotMatch(unitBlock, /pack|bal10|bal15|bal20|bal25/);
  });

  it('uses a two-column unit selector', () => {
    assert.match(
      multiCss,
      /\.smg-unit-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*1fr\)/,
    );
  });
});

describe('PHASE 7H — Editable result serial override', () => {
  it('keeps the auto candidate as fallback while allowing a manual override', () => {
    assert.match(multiSrc, /groupSerialNumber:\s*''/);
    assert.match(
      multiSrc,
      /batch\.processResult\?\.group\?\.serial_number[\s\S]*?\|\| batch\.groupSerialNumber\?\.trim\(\)[\s\S]*?\|\| batch\.previewData\?\.candidateSerialNumber/,
    );
    assert.match(multiSrc, /smg-candidate-input/);
    assert.match(multiSrc, /onClick=\{startEditGroupSerial\}/);
    assert.match(multiSrc, /onClick=\{resetGroupSerialToAuto\}/);
    assert.match(multiSrc, /const serialDisplay = getEffectiveGroupSerial\(b\)/);
  });

  it('sends the override to the create payload', () => {
    assert.match(multiSrc, /payload\.groupSerialNumber = b\.groupSerialNumber\.trim\(\)/);
  });

  it('regenerates the idempotency key when the serial override changes', () => {
    assert.match(
      multiSrc,
      /groupSerialNumber: nextSerial,[\s\S]*?idempotencyKey: createIdempotencyKey\(\)/,
    );
    assert.match(
      multiSrc,
      /groupSerialNumber: '',[\s\S]*?idempotencyKey: createIdempotencyKey\(\)/,
    );
  });

  it('styles the serial editor and keeps the modal responsive', () => {
    assert.match(multiCss, /\.smg-candidate-input\s*\{/);
    assert.match(multiCss, /\.smg-candidate-action\s*\{/);
    assert.match(multiCss, /\.smg-candidate-serial-box\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  });
});

describe('PHASE 7H — Backend contract is unchanged', () => {
  it('still exposes persisted components and the official assembly reference', () => {
    const serviceSrc = readFileSync(
      resolve(repoRoot, 'backend', 'src', 'services', 'serialGroup.service.js'),
      'utf8',
    );

    assert.match(serviceSrc, /from\('serial_grouping_components'\)/);
    assert.match(serviceSrc, /assembly_document_number/);
    assert.match(serviceSrc, /getSerialGroupingDetails/);
  });
});

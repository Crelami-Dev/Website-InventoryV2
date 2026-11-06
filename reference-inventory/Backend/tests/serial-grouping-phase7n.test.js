import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

// Simulation of detectQtyAndUnit as implemented in GoodsOut components
function simulateDetectQtyAndUnit(serialObj, prodObj, customUnits = []) {
  const isGroup = Boolean(
    serialObj?.metadata?.isGroup ??
    serialObj?.isGroup ??
    false
  );

  const raw =
    serialObj?.metadata?.targetUnit ||
    serialObj?.targetUnit ||
    serialObj?.metadata?.serialUnit ||
    serialObj?.metadata?.unit ||
    serialObj?.metadata?.qtyUnit ||
    serialObj?.unit ||
    serialObj?.serialUnit ||
    '';

  let qtyUnit = 'pcs';
  const cleanRaw = String(raw).toLowerCase().trim();
  if (cleanRaw && cleanRaw !== 'pcs' && cleanRaw !== 'piece') {
    if (Array.isArray(customUnits) && customUnits.length > 0) {
      const found = customUnits.find((u) => u.key && String(u.key).toLowerCase().trim() === cleanRaw);
      if (found) qtyUnit = found.key;
      else qtyUnit = cleanRaw;
    } else {
      qtyUnit = cleanRaw;
    }
  } else if (cleanRaw === 'pcs' || cleanRaw === 'piece') {
    qtyUnit = 'pcs';
  } else {
    const sn = String(serialObj?.serialNumber ?? serialObj?.serial_number ?? '').toLowerCase();
    if (sn.includes('10bl') || sn.includes('bl10') || sn.includes('bal10')) qtyUnit = 'bal10';
    else if (sn.includes('15bl') || sn.includes('bl15') || sn.includes('bal15')) qtyUnit = 'bal15';
    else if (sn.includes('20bl') || sn.includes('bl20') || sn.includes('bal20')) qtyUnit = 'bal20';
    else if (sn.includes('25bl') || sn.includes('bl25') || sn.includes('bal25')) qtyUnit = 'bal25';
    else if (sn.includes('bal') || sn.includes('bl')) qtyUnit = 'bal';
    else if (sn.includes('pack') || sn.includes('pk')) qtyUnit = 'pack';
    else if (sn.includes('lusin') || sn.includes('dozen')) qtyUnit = 'lusin';
    else {
      const prodRaw = prodObj?.metadata?.qtyUnit || prodObj?.metadata?.unit || '';
      if (prodRaw) qtyUnit = String(prodRaw).toLowerCase().trim();
    }
  }

  let qty = 1;
  if (isGroup) {
    const rawGroupQty = Number(
      serialObj?.metadata?.targetQty ??
      serialObj?.metadata?.unitQty ??
      serialObj?.targetQty ??
      serialObj?.unitQty ??
      1
    );
    if (Number.isFinite(rawGroupQty) && rawGroupQty > 0) {
      qty = rawGroupQty;
    }
  }

  return { qty, qtyUnit, isGroup };
}

describe('PHASE 7N - Goods Out Quantity for Grouped Result Serials', () => {
  describe('A. Unit & Quantity Mapping Logic', () => {
    it('1. Standard regular serial defaults to qty = 1 and unit = pcs', () => {
      const regularSerial = {
        serial_number: 'TEST1-GI-20261023-0001',
        status: 'available',
        metadata: {
          isSerial: true,
          unit: 'pcs',
        },
      };

      const result = simulateDetectQtyAndUnit(regularSerial, { name: 'Tester', sku: 'test1' });
      assert.equal(result.isGroup, false);
      assert.equal(result.qty, 1);
      assert.equal(result.qtyUnit, 'pcs');
    });

    it('2. Grouped result serial (13 lusin) resolves authoritatively to qty = 13 and unit = lusin', () => {
      const groupedSerial = {
        serial_number: 'TEST1-G-13LUSIN-231020260001',
        status: 'available',
        metadata: {
          isGroup: true,
          targetQty: 13,
          targetUnit: 'lusin',
          totalPcs: 156,
          sku: 'test1',
        },
      };

      const result = simulateDetectQtyAndUnit(groupedSerial, { name: 'Tester', sku: 'test1' });
      assert.equal(result.isGroup, true);
      assert.equal(result.qty, 13);
      assert.equal(result.qtyUnit, 'lusin');

      // Base quantity in pcs: 13 * 12 = 156
      const baseQty = result.qty * (multipliers[result.qtyUnit] || 1);
      assert.equal(baseQty, 156);
    });

    it('3. Grouped result serial with custom unit bal10 resolves qty and 120 multiplier', () => {
      const balGroupSerial = {
        serial_number: 'TEST1-G-2BAL10-231020260002',
        status: 'available',
        metadata: {
          isGroup: true,
          targetQty: 2,
          targetUnit: 'bal10',
          totalPcs: 240,
        },
      };

      const result = simulateDetectQtyAndUnit(balGroupSerial, { name: 'Tester', sku: 'test1' });
      assert.equal(result.isGroup, true);
      assert.equal(result.qty, 2);
      assert.equal(result.qtyUnit, 'bal10');

      const baseQty = result.qty * (multipliers[result.qtyUnit] || 1);
      assert.equal(baseQty, 240);
    });

    it('4. Grouped result serial with pcs unit (e.g. 50 pcs) resolves qty = 50 and unit = pcs', () => {
      const pcsGroupSerial = {
        serial_number: 'TEST1-G-50PCS-231020260003',
        status: 'available',
        metadata: {
          isGroup: true,
          targetQty: 50,
          targetUnit: 'pcs',
          totalPcs: 50,
        },
      };

      const result = simulateDetectQtyAndUnit(pcsGroupSerial, { name: 'Tester', sku: 'test1' });
      assert.equal(result.isGroup, true);
      assert.equal(result.qty, 50);
      assert.equal(result.qtyUnit, 'pcs');
      assert.equal(result.qty * multipliers[result.qtyUnit], 50);
    });

    it('5. PO fulfillment progress getLinePcs computes rawQty * mult for both regular and grouped serials', () => {
      const getLinePcs = (l) => {
        const rawQty = Number(l.qty) || 1;
        const unitClean = String(l.qtyUnit || 'pcs').toLowerCase();
        const mult = multipliers[unitClean] || 1;
        return rawQty * mult;
      };

      // Case a: Regular serial (qty = 1, unit = 'lusin')
      const regularLine = { isSerial: true, qty: 1, qtyUnit: 'lusin' };
      assert.equal(getLinePcs(regularLine), 12);

      // Case b: Grouped result serial (qty = 13, unit = 'lusin')
      const groupedLine = { isSerial: true, qty: 13, qtyUnit: 'lusin' };
      assert.equal(getLinePcs(groupedLine), 156);

      // Case c: Grouped result serial (qty = 2, unit = 'bal25')
      const bal25Line = { isSerial: true, qty: 2, qtyUnit: 'bal25' };
      assert.equal(getLinePcs(bal25Line), 600);
    });
  });

  describe('B. Backend Routes Hardening', () => {
    it('1. /product-serial-index prioritizes targetUnit and exposes targetQty at index 10', async () => {
      const routesSource = await read('src/routes/workspace.routes.js');
      assert.match(
        routesSource,
        /r\.metadata\?\.targetUnit \|\| r\.metadata\?\.serialUnit/,
        'product-serial-index must prioritize metadata.targetUnit'
      );
      assert.match(
        routesSource,
        /Number\(r\.metadata\?\.targetQty \?\? r\.metadata\?\.unitQty \?\? 1\)/,
        'product-serial-index must expose targetQty at index 10'
      );
    });

    it('2. POST /documents reconciles grouped serial quantities before inserting document_items', async () => {
      const routesSource = await read('src/routes/workspace.routes.js');
      const postDocsSection = routesSource.slice(
        routesSource.indexOf("router.post('/documents'"),
        routesSource.indexOf("router.patch('/documents/:id'")
      );

      assert.match(postDocsSection, /Reconcile grouped result serial quantities/);
      assert.match(postDocsSection, /groupTargetQty = Number\(sRec\.metadata\.targetQty/);
      assert.match(postDocsSection, /groupTargetUnit = sRec\.metadata\.targetUnit/);
      assert.match(postDocsSection, /item\.quantity = groupTotalPcs/);
    });

    it('3. PATCH /documents/:id reconciles grouped serial quantities before updating document_items', async () => {
      const routesSource = await read('src/routes/workspace.routes.js');
      const patchDocsSection = routesSource.slice(
        routesSource.indexOf("router.patch('/documents/:id'"),
        routesSource.indexOf("router.post('/documents/:id/complete'")
      );

      assert.match(patchDocsSection, /Reconcile grouped result serial quantities/);
      assert.match(patchDocsSection, /groupTargetQty = Number\(sRec\.metadata\.targetQty/);
      assert.match(patchDocsSection, /item\.quantity = groupTotalPcs/);
    });
  });

  describe('C. Frontend Component Audit', () => {
    it('1. GoodsOutLineItem.jsx binds item.qty to disabled input and uses detectQtyAndUnit', async () => {
      const lineItemSource = await read('frontend-new/src/pages/GoodsOut/GoodsOutLineItem.jsx', repoRoot);
      assert.match(lineItemSource, /detectQtyAndUnit/);
      assert.doesNotMatch(lineItemSource, /value="1"\s+disabled/, 'Should not have hardcoded value="1" disabled');
      assert.match(lineItemSource, /value=\{item\.qty \?\? 1\}\s+disabled/);
    });

    it('2. GoodsOutCreateModal.jsx preserves line.qty on save, auto-save, and unpacks targetQty', async () => {
      const createModalSource = await read('frontend-new/src/pages/GoodsOut/GoodsOutCreateModal.jsx', repoRoot);
      // poFulfillmentProgress must compute rawQty * mult
      assert.doesNotMatch(createModalSource, /return l\.isSerial \? mult : rawQty \* mult;/);
      // save items must compute (Number(line.qty) || 1) * multiplier
      assert.match(createModalSource, /const totalQty = \(Number\(line\.qty\) \|\| 1\) \* multiplier;/);
      // auto save draft must not force 1
      assert.doesNotMatch(createModalSource, /const qtyNum = isSerial \? 1 : Number\(line\.qty\) \|\| 1;/);
      // unpack targetQty in serialIndex
      assert.match(createModalSource, /targetQty: Number\(targetQty\) \|\| 1/);
    });

    it('3. GoodsOutEditModal.jsx loads and preserves grouped serial quantity', async () => {
      const editModalSource = await read('frontend-new/src/pages/GoodsOut/GoodsOutEditModal.jsx', repoRoot);
      // initial load
      assert.match(editModalSource, /item\.metadata\?\.targetQty \? item\.metadata\.targetQty/);
      // poFulfillmentProgress
      assert.doesNotMatch(editModalSource, /return l\.isSerial \? mult : rawQty \* mult;/);
      // save items
      assert.match(editModalSource, /const totalQty = \(Number\(line\.qty\) \|\| 1\) \* multiplier;/);
      // unpack targetQty in serialIndex
      assert.match(editModalSource, /targetQty: Number\(targetQty\) \|\| 1/);
    });

    it('4. GoodsOutDetailModal.jsx and GoodsOutReviewModal.jsx respect qtyInput and targetQty', async () => {
      const detailSource = await read('frontend-new/src/pages/GoodsOut/GoodsOutDetailModal.jsx', repoRoot);
      const reviewSource = await read('frontend-new/src/pages/GoodsOut/GoodsOutReviewModal.jsx', repoRoot);

      assert.match(detailSource, /item\.metadata\?\.targetQty \? item\.metadata\.targetQty/);
      assert.match(reviewSource, /item\.metadata\?\.targetQty \? item\.metadata\.targetQty/);
    });
  });
});

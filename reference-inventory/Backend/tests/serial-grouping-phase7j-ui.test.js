import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const groupingDir = resolve(repoRoot, 'frontend-new', 'src', 'pages', 'SerialGrouping');

const read = (name) => readFileSync(resolve(groupingDir, name), 'utf8');

const multiModalJsx = read('SerialMultiGroupingModal.jsx');
const multiModalCss = read('SerialMultiGroupingModal.css');
const pageJsx = read('SerialGroupingPage.jsx');

describe('PHASE 7J — Post-Grouping Modal Flow & Lifecycle', () => {
  it('closes modal and resets session when all processed batches succeed', () => {
    // Verifies static contract that complete success triggers onClose() and resetSession()
    assert.match(
      multiModalJsx,
      /if\s*\(\s*summary\.failed\s*===\s*0\s*&&\s*!hasUnfinishedSerials\s*\)\s*\{[\s\S]*?onClose\(\);[\s\S]*?resetSession\(\);/,
      'Modal must call onClose() and resetSession() when all batches with serials succeed',
    );
  });

  it('keeps modal open and preserves failed batches when any batch fails', () => {
    // When summary.failed > 0, modal must not close automatically
    assert.ok(
      multiModalJsx.includes('if (summary.failed === 0 && !hasUnfinishedSerials)'),
      'Modal close is strictly guarded by summary.failed === 0',
    );
    assert.match(
      multiModalJsx,
      /status:\s*'failed'[\s\S]*?processError:/,
      'Failed batch must retain status failed and store processError',
    );
  });

  it('excludes completed batches from subsequent retry submissions', () => {
    // validBatches filter only includes 'valid' or 'failed', never 'completed'
    assert.match(
      multiModalJsx,
      /\(b\.status === 'valid' \|\| b\.status === 'failed'\)/,
      'validBatches must exclude completed batches to prevent re-processing',
    );
  });

  it('guarantees clean session reset when modal opens via Add Group', () => {
    // prevIsOpenRef detection
    assert.match(
      multiModalJsx,
      /prevIsOpenRef[\s\S]*?if\s*\(\s*isOpen\s*&&\s*!prevIsOpenRef\.current\s*\)\s*\{[\s\S]*?resetSession\(\);/,
      'Modal must call resetSession() whenever isOpen transitions from false to true',
    );
  });

  it('clears all serials, batch draft state, and summaries during resetSession', () => {
    assert.match(multiModalJsx, /const resetSession = useCallback\(/);
    assert.match(multiModalJsx, /setBatches\(\[initBatch\]\)/);
    assert.match(multiModalJsx, /setScanInput\(''\)/);
    assert.match(multiModalJsx, /setScanFeedback\(null\)/);
    assert.match(multiModalJsx, /setOverallSummary\(null\)/);
    assert.match(multiModalJsx, /inFlightScansRef\.current\.clear\(\)/);
  });

  it('parent opens modal on Add Group click and updates table on success', () => {
    assert.match(
      pageJsx,
      /<button[^>]*onClick=\{\(\)\s*=>\s*setIsMultiGroupModalOpen\(true\)\}[^>]*>[\s\S]*?Add Group/,
      'Parent Add Group button must open the multi group modal',
    );
    assert.match(
      pageJsx,
      /<SerialMultiGroupingModal[\s\S]*?isOpen=\{isMultiGroupModalOpen\}[\s\S]*?onClose=\{\(\)\s*=>\s*setIsMultiGroupModalOpen\(false\)\}[\s\S]*?onSuccess=\{\(\)\s*=>\s*\{[\s\S]*?fetchGroupings\(\);/,
      'Parent must wire isOpen, onClose, and onSuccess correctly',
    );
  });
});

describe('PHASE 7J — Persistent Scanner Focus & Interaction', () => {
  it('does NOT disable scan input during async verification', () => {
    // Verifies that disabled attribute only depends on batch completion, NOT isVerifyingScan
    assert.doesNotMatch(
      multiModalJsx,
      /className="smg-scan-input"[\s\S]*?disabled=\{isVerifyingScan/,
      'smg-scan-input must never be disabled by isVerifyingScan as that drops browser focus',
    );
    assert.match(
      multiModalJsx,
      /className="smg-scan-input"[\s\S]*?disabled=\{activeBatch\.status === 'completed'\}/,
      'smg-scan-input must only be disabled when activeBatch is completed',
    );
  });

  it('shows animated spinner icon while scan is verifying without disabling input', () => {
    assert.match(
      multiModalJsx,
      /isVerifyingScan\s*\?\s*\(\s*<Loader2 className="smg-scan-icon spin"/,
      'Scanner wrapper must render Loader2 spinner when isVerifyingScan is active',
    );
  });

  it('clears scan input immediately on submit for rapid successive scanning', () => {
    assert.match(
      multiModalJsx,
      /const rawSN = scanInput\.trim\(\);[\s\S]*?setScanInput\(''\);/,
      'setScanInput("") must be called immediately upon submit',
    );
  });

  it('protects scanner focus with restoreFocusIfAppropriate helper', () => {
    assert.match(
      multiModalJsx,
      /const restoreFocusIfAppropriate = useCallback\(/,
      'restoreFocusIfAppropriate helper must be defined',
    );
    // Called in finally block
    assert.match(
      multiModalJsx,
      /finally\s*\{[\s\S]*?setIsVerifyingScan\(false\);[\s\S]*?restoreFocusIfAppropriate\(\);/,
      'restoreFocusIfAppropriate must be called in scan verification finally block',
    );
  });

  it('never steals focus if user intentionally focuses on another input or control', () => {
    // restoreFocusIfAppropriate checks activeElement tag name
    assert.match(
      multiModalJsx,
      /activeEl\.tagName === 'INPUT' \|\|[\s\S]*?activeEl\.tagName === 'SELECT' \|\|[\s\S]*?activeEl\.tagName === 'TEXTAREA'/,
      'restoreFocusIfAppropriate must avoid hijacking other inputs/selects/textareas',
    );
  });

  it('preserves Fokus Mode Scan button functionality', () => {
    assert.match(
      multiModalJsx,
      /const focusScanMode = \(\) => \{\s*scanInputRef\.current\?\.focus\(\);/,
      'focusScanMode must directly focus scan input ref',
    );
    assert.match(
      multiModalJsx,
      /className="smg-refocus-btn"[\s\S]*?onClick=\{focusScanMode\}/,
      'Refocus button must trigger focusScanMode',
    );
  });

  it('defines spin keyframes in SerialMultiGroupingModal.css', () => {
    assert.match(multiModalCss, /@keyframes smg-spin/);
    assert.match(multiModalCss, /\.spin/);
  });
});

describe('PHASE 7J — Logical Simulation (Unit Tests)', () => {
  function createBatch(id, status = 'incomplete', serials = []) {
    return {
      id,
      name: `Batch ${id}`,
      status,
      serials,
      previewData: serials.length >= 2 ? { targetQty: 1 } : null,
      idempotencyKey: `key-${id}`,
      processResult: null,
      processError: null,
    };
  }

  it('simulates handleProcessValidBatches complete success workflow', () => {
    const batches = [
      createBatch('b1', 'valid', [{ id: 's1' }, { id: 's2' }]),
      createBatch('b2', 'valid', [{ id: 's3' }, { id: 's4' }]),
    ];

    const results = [
      { batchId: 'b1', success: true, data: { group: { serial_number: 'SN-G1' } } },
      { batchId: 'b2', success: true, data: { group: { serial_number: 'SN-G2' } } },
    ];
    const summary = { total: 2, succeeded: 2, failed: 0 };

    const updatedBatches = batches.map((b) => {
      const match = results.find((r) => r.batchId === b.id);
      if (match?.success) {
        return { ...b, status: 'completed', processResult: match.data };
      }
      return b;
    });

    assert.equal(updatedBatches[0].status, 'completed');
    assert.equal(updatedBatches[1].status, 'completed');

    const hasUnfinishedSerials = updatedBatches.some(
      (b) => (b.serials?.length || 0) > 0 && b.status !== 'completed'
    );
    assert.equal(hasUnfinishedSerials, false);

    const shouldCloseAndReset = summary.failed === 0 && !hasUnfinishedSerials;
    assert.equal(shouldCloseAndReset, true, 'Modal should close and reset on 100% success');
  });

  it('simulates handleProcessValidBatches partial failure workflow', () => {
    const batches = [
      createBatch('b1', 'valid', [{ id: 's1' }, { id: 's2' }]),
      createBatch('b2', 'valid', [{ id: 's3' }, { id: 's4' }]),
    ];

    const results = [
      { batchId: 'b1', success: true, data: { group: { serial_number: 'SN-G1' } } },
      { batchId: 'b2', success: false, error: { message: 'Serial SN-04 tidak tersedia' } },
    ];
    const summary = { total: 2, succeeded: 1, failed: 1 };

    const updatedBatches = batches.map((b) => {
      const match = results.find((r) => r.batchId === b.id);
      if (match) {
        if (match.success) {
          return { ...b, status: 'completed', processResult: match.data };
        }
        return { ...b, status: 'failed', processError: match.error?.message };
      }
      return b;
    });

    assert.equal(updatedBatches[0].status, 'completed');
    assert.equal(updatedBatches[1].status, 'failed');
    assert.equal(updatedBatches[1].processError, 'Serial SN-04 tidak tersedia');

    const hasUnfinishedSerials = updatedBatches.some(
      (b) => (b.serials?.length || 0) > 0 && b.status !== 'completed'
    );
    assert.equal(hasUnfinishedSerials, true);

    const shouldCloseAndReset = summary.failed === 0 && !hasUnfinishedSerials;
    assert.equal(shouldCloseAndReset, false, 'Modal MUST NOT close on partial failure');

    // On retry, only b2 should be selected
    const retryValidBatches = updatedBatches.filter(
      (b) => (b.status === 'valid' || b.status === 'failed') && b.previewData && b.serials.length >= 2
    );
    assert.equal(retryValidBatches.length, 1);
    assert.equal(retryValidBatches[0].id, 'b2', 'Completed b1 must not be retried');
  });

  it('simulates focus safety check logic', () => {
    const mockScanInput = { tagName: 'INPUT', id: 'scan-input' };

    function shouldRestoreFocus(activeEl) {
      const isAnotherControlFocused = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.tagName === 'TEXTAREA' ||
        (activeEl.tagName === 'BUTTON' && !activeEl.isRefocusBtn)
      ) && activeEl !== mockScanInput;

      return !isAnotherControlFocused;
    }

    // 1. Scan input was active
    assert.equal(shouldRestoreFocus(mockScanInput), true);

    // 2. Focus dropped to body
    assert.equal(shouldRestoreFocus({ tagName: 'BODY' }), true);

    // 3. User clicked into product search input
    assert.equal(shouldRestoreFocus({ tagName: 'INPUT', id: 'product-search' }), false);

    // 4. User clicked into a select dropdown
    assert.equal(shouldRestoreFocus({ tagName: 'SELECT' }), false);

    // 5. User clicked unit button
    assert.equal(shouldRestoreFocus({ tagName: 'BUTTON', isRefocusBtn: false }), false);

    // 6. User clicked refocus button
    assert.equal(shouldRestoreFocus({ tagName: 'BUTTON', isRefocusBtn: true }), true);
  });
});

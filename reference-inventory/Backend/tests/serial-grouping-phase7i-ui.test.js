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

const ungroupJsx = read('SerialGroupingUngroupModal.jsx');
const ungroupCss = read('SerialGroupingUngroupModal.css');
const detailJsx = read('SerialGroupingDetailModal.jsx');
const detailCss = read('SerialGroupingDetailModal.css');

const ungroupClasses = [
  'sg-modal-backdrop',
  'sg-modal-dialog',
  'sg-modal-header',
  'sg-modal-header--danger',
  'sg-modal-header__title-wrap',
  'sg-modal-icon-badge',
  'sg-modal-title',
  'sg-modal-subtitle',
  'sg-modal-close-btn',
  'sg-modal-body',
  'sg-alert-box',
  'sg-alert-box--danger',
  'sg-warning-callout',
  'sg-meta-card',
  'sg-meta-row',
  'sg-meta-label',
  'sg-meta-value',
  'sg-form-group',
  'sg-form-label',
  'sg-input',
  'sg-textarea',
  'sg-modal-footer',
];

describe('PHASE 7I — Ungroup modal CSS matches its JSX', () => {
  it('styles every structural class rendered by the modal', () => {
    for (const name of ungroupClasses) {
      assert.match(ungroupJsx, new RegExp(`\\b${name}\\b`));
      assert.match(ungroupCss, new RegExp(`\\.${name}\\b`), `missing CSS for .${name}`);
    }
  });

  it('removes the stale ungroup-* selectors that never matched the JSX', () => {
    assert.doesNotMatch(ungroupCss, /\.ungroup-modal-overlay\b/);
    assert.doesNotMatch(ungroupCss, /\.ungroup-modal-card\b/);
    assert.doesNotMatch(ungroupCss, /\.ungroup-info-banner\b/);
    assert.doesNotMatch(ungroupCss, /\.ungroup-btn-submit\b/);
  });

  it('keeps the overlay above the detail modal', () => {
    const ungroupZ = ungroupCss.match(/\.sg-modal-backdrop\s*\{[\s\S]*?z-index:\s*(\d+)/);
    const detailZ = detailCss.match(/\.sg-detail-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/);

    assert.ok(ungroupZ && detailZ);
    assert.ok(Number(ungroupZ[1]) > Number(detailZ[1]));
  });

  it('scrolls the body inside a viewport-capped dialog', () => {
    assert.match(ungroupCss, /\.sg-modal-dialog\s*\{[\s\S]*?max-height:[^;]+;/);
    assert.match(ungroupCss, /\.sg-modal-body\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(ungroupCss, /\.sg-modal-footer\s*\{[\s\S]*?flex-shrink:\s*0/);
  });

  it('stays closed unless both isOpen and groupingData are present', () => {
    assert.match(ungroupJsx, /if \(!isOpen \|\| !groupingData\) return null;/);
  });

  it('uses theme tokens instead of undefined legacy variables', () => {
    for (const css of [ungroupCss, detailCss]) {
      assert.doesNotMatch(css, /var\(--bg-[a-z-]+/);
      assert.doesNotMatch(css, /var\(--text-(?:primary|secondary|muted|tertiary)\b/);
      assert.doesNotMatch(css, /var\(--border-color\b/);
      assert.doesNotMatch(css, /!important/);
    }

    assert.match(ungroupCss, /var\(--color-surface\b/);
    assert.match(ungroupCss, /var\(--color-text-primary\b/);
    assert.match(ungroupCss, /var\(--color-border\b/);
  });

  it('has responsive rules for narrow screens', () => {
    assert.match(ungroupCss, /@media \(max-width: 560px\)/);
    assert.match(detailCss, /@media \(max-width: 760px\)/);
  });
});

describe('PHASE 7I — Detail modal layout is contained', () => {
  it('fills the available width without exceeding the viewport', () => {
    assert.match(detailCss, /\.sg-detail-card\s*\{[\s\S]*?max-height:/);
    assert.match(detailCss, /\.sg-detail-overlay\s*\{[\s\S]*?overflow-y:\s*auto/);
  });

  it('collapses the summary grid to one column on small screens', () => {
    assert.match(detailCss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(
      detailCss,
      /@media \(max-width: 760px\)[\s\S]*?\.sg-summary-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it('keeps the component table scrollable at the phase 7H height', () => {
    assert.match(detailCss, /\.sg-table-container\s*\{[\s\S]*?max-height:\s*360px/);
    assert.match(detailCss, /\.sg-table thead th\s*\{[\s\S]*?position:\s*sticky/);
  });

  it('scopes footer button overrides to the detail card', () => {
    assert.match(detailCss, /\.sg-detail-card \.sg-btn-secondary/);
    assert.match(detailCss, /\.sg-detail-card \.sg-btn-danger/);
  });

  it('does not reintroduce HPP or a quantity column', () => {
    assert.doesNotMatch(detailJsx, /HPP/);
    assert.doesNotMatch(detailJsx, /Total Biaya/);
    assert.doesNotMatch(detailJsx, /formatCurrency/);
    assert.doesNotMatch(detailJsx, /<tfoot/);
  });
});

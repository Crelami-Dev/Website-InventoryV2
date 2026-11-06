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
const pageSrc = read('SerialGroupingPage.jsx');
const pageCss = read('SerialGroupingPage.css');

describe('Serial grouping table — compact row layout', () => {
  it('uses dense cell padding without changing the column set', () => {
    assert.match(pageCss, /\.sg-data-table td\s*\{[\s\S]*?padding:\s*0\.45rem 0\.75rem/);
    assert.match(pageCss, /\.sg-data-table th\s*\{[\s\S]*?padding:\s*0\.5rem 0\.75rem/);
    assert.match(pageSrc, /Nomor Seri Hasil Grouping/);
    assert.match(pageSrc, /Nama Produk Hasil/);
  });

  it('stacks the assembly and reversal references inside a shrinkable cell', () => {
    assert.match(pageSrc, /className="sg-ref-stack"/);
    assert.match(pageCss, /\.sg-ref-stack\s*\{[\s\S]*?max-width:\s*240px/);
    assert.match(pageCss, /\.sg-ref-text\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
    assert.match(pageCss, /\.sg-ref-reversal span\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
  });

  it('keeps full values reachable through native tooltips', () => {
    assert.match(pageSrc, /title=\{`Lihat detail dokumen assembly: \$\{row\.reference\}`\}/);
    assert.match(pageSrc, /title=\{`Dokumen reversal: \$\{row\.reversalReference\}`\}/);
    assert.match(pageSrc, /title=\{row\.resultSerialNumber \|\| undefined\}/);
    assert.match(pageSrc, /title=\{row\.resultProductName \|\| undefined\}/);
    assert.match(pageSrc, /title=\{row\.resultProductSku \|\| undefined\}/);
    assert.match(pageSrc, /title=\{whName\}/);
  });

  it('truncates long single-line values instead of widening the table', () => {
    assert.match(pageCss, /\.sg-sn-badge\s*\{[\s\S]*?max-width:\s*210px[\s\S]*?text-overflow:\s*ellipsis/);
    assert.match(pageCss, /\.prod-name\s*\{[\s\S]*?max-width:\s*170px[\s\S]*?text-overflow:\s*ellipsis/);
    assert.match(pageCss, /\.sg-sku-text\s*\{[\s\S]*?max-width:\s*96px[\s\S]*?text-overflow:\s*ellipsis/);
    assert.match(pageCss, /\.sg-wh-tag\s*\{[\s\S]*?max-width:\s*120px[\s\S]*?text-overflow:\s*ellipsis/);
  });

  it('narrows the action column and keeps both action buttons', () => {
    assert.match(pageSrc, /style=\{\{ width: 96 \}\}>Aksi<\/th>/);
    assert.match(pageCss, /\.sg-btn-icon\s*\{[\s\S]*?padding:\s*4px/);
    assert.match(pageSrc, /title="Lihat Detail & Traceability"/);
    assert.match(pageSrc, /title="Bongkar Group \(Reversal\)"/);
  });
});

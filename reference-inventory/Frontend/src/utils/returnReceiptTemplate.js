/**
 * returnReceiptTemplate.js
 * Sistem Cetak Bukti Retur Barang (Goods Out Return & Goods In Return)
 * Konsisten 100% dengan Sistem Cetak Goods In & Goods Out DocuFlow.
 */

export const GOODS_PRINT_MODES = [
  { id: 'compact', label: 'Rangkap', desc: 'Kertas kontinyu 21cm × 12cm' },
  { id: 'a4', label: 'Kertas A4', desc: 'A4 Portrait (21cm × 29.7cm)' },
];

const escapeHtml = (val) => String(val ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const preferDefined = (...values) => values.find((value) => value !== undefined && value !== null);

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function brandLogosHtml(settings) {
  let logos = [];
  const compLogo = settings?.companyLogo || settings?.company?.companyLogo || settings?.company?.logoUrl;
  if (compLogo && String(compLogo).startsWith('data:image/')) {
    logos.push(compLogo);
  }
  const docsLogos = (settings?.documents?.brandLogos ?? [])
    .filter((logo) => String(logo ?? '').startsWith('data:image/') && logo !== compLogo);
  logos = [...logos, ...docsLogos].slice(0, 8);

  if (logos.length === 0) return '';
  return logos
    .map((logo, index) => `<div class="brand-logo"><img src="${escapeHtml(logo)}" alt="Brand logo ${index + 1}" /></div>`)
    .join('');
}

/**
 * Mengelompokkan item retur secara akurat:
 * - Menjaga pemisahan kondisi (Kondisi Baik vs Kondisi Rusak TIDAK digabung).
 * - Mengumpulkan nomor seri untuk produk serial dengan kondisi yang sama.
 */
function groupReturnItems(rawItems = []) {
  const groups = [];
  const groupMap = new Map();

  rawItems.forEach((it) => {
    const productId = it.productId || it.product_id || it.itemId || it.productName || 'unknown';
    const productName = it.productName || it.item_name || it.itemName || 'Produk';
    const sku = it.sku || '—';
    const isSerial = it.isSerial === true || it.is_serial === true;
    const isGroup = it.isGroup === true || (isSerial && it.targetQty != null);
    const serialNumber = it.serialNumber || it.serial_number || '';
    const unit = (isGroup ? (it.targetUnit || it.qtyUnit || it.unit) : (it.qtyUnit || it.unit)) || 'pcs';
    const condition = it.targetStatus || it.condition || 'available';
    const rawQty = isGroup ? (it.targetQty ?? it.returnedQty ?? it.quantity ?? 1) : (it.returnedQty ?? it.quantity ?? 1);
    const returnedQty = Number.isFinite(Number(rawQty)) && Number(rawQty) > 0 ? Number(rawQty) : 1;

    // Kunci unik: pisahkan berdasarkan produk, satuan, dan kondisi
    const key = `${productId}__${unit}__${condition}`;

    if (!groupMap.has(key)) {
      const newGroup = {
        key,
        productId,
        productName,
        sku,
        unit,
        condition,
        isSerial,
        serials: isSerial && serialNumber ? [serialNumber] : [],
        totalQty: returnedQty,
        items: [it],
      };
      groupMap.set(key, newGroup);
      groups.push(newGroup);
    } else {
      const existing = groupMap.get(key);
      existing.totalQty += returnedQty;
      if (isSerial && serialNumber && !existing.serials.includes(serialNumber)) {
        existing.serials.push(serialNumber);
      }
      existing.items.push(it);
    }
  });

  return groups;
}

/**
 * Format Rangkap (Kertas Kontinyu 21cm × 12cm)
 */
function returnPagesCompact(returnRecord, settings, contactData, companyName, companyDetail, customerName, customerDetail, returnNumber, returnDate) {
  const isGoodsOut = returnRecord.documentType === 'goods_out'
    || returnRecord.document_type === 'goods_out'
    || returnRecord.type === 'goods_out'
    || String(returnRecord.documentNumber || '').startsWith('WH/OUT')
    || String(returnRecord.returnNumber || '').includes('OUT');

  const title = 'Return';
  const docNumber = returnRecord.documentNumber || '—';
  const warehouse = returnRecord.warehouseName || returnRecord.metadata?.warehouse || 'Gudang Utama';

  // Catatan gudang operasional, jangan menggunakan alasan retur pelanggan
  const defaultNote = 'Barang telah diperiksa fisik dan dicatat dalam pembukuan retur gudang.';
  let notesText = defaultNote;
  const rawNote = String(returnRecord.notes || '').trim();
  const rawReason = String(returnRecord.reason || returnRecord.return_reason || '').trim();
  if (rawNote && rawNote.toLowerCase() !== rawReason.toLowerCase()) {
    notesText = rawNote;
  }

  const groupedItems = groupReturnItems(returnRecord.items || []);

  // Hitung total unit dan total item
  const totalUnits = groupedItems.reduce((sum, g) => sum + g.totalQty, 0);
  const unitTotals = {};
  groupedItems.forEach((g) => {
    unitTotals[g.unit] = (unitTotals[g.unit] || 0) + g.totalQty;
  });
  const unitSummary = Object.entries(unitTotals).map(([u, q]) => `${q} ${u}`).join(', ');

  const renderRow = (g) => {
    const name = escapeHtml(g.productName);
    let skuHtml = '';
    if (g.sku && g.sku !== '—' && g.sku !== '-') {
      skuHtml = `<div class="muted" style="font-size: 9.5px; font-weight: normal; margin-top: 1px; line-height: 1.2;">SKU: ${escapeHtml(g.sku)}</div>`;
    }
    let serialHtml = '';
    if (g.serials && g.serials.length > 0) {
      serialHtml = `<div class="compact-serials" style="font-size: 8.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-weight: 500; margin-top: 2px; color: #111827; word-break: break-all; line-height: 1.25; letter-spacing: -0.2px;"><span style="font-family: inherit; font-weight: 700; font-size: 9px; color: #000;">No. Seri (${g.serials.length}):</span> ${escapeHtml(g.serials.join(', '))}</div>`;
    }
    const nameHtml = `<div style="font-weight: 700; font-size: 11.5px; line-height: 1.25;">${name}</div>${skuHtml}${serialHtml}`;

    const qtyHtml = `<div style="font-weight: 700; font-size: 11.5px;">${g.totalQty} ${escapeHtml(g.unit)}</div>`;

    const isDamaged = g.condition === 'damaged';
    const conditionHtml = isDamaged
      ? `<span style="font-weight: 700; color: #dc2626;">Rusak / Damaged</span>`
      : `<span style="font-weight: 700; color: #16a34a;">Baik / Tersedia</span>`;

    return `<tr>
      <td>${nameHtml}</td>
      <td>${qtyHtml}</td>
      <td class="right">${conditionHtml}</td>
    </tr>`;
  };

  const infoDetail = `Ref Dokumen: <strong>${escapeHtml(docNumber)}</strong><br/>Gudang: ${escapeHtml(warehouse)}`;

  let html = `<section class="header">
  <div class="header-left">
    <div class="brand-logos">${brandLogosHtml(settings)}</div>
    <div class="company">
      <div class="brand">${escapeHtml(companyName)}</div>
      <div class="muted">${companyDetail}</div>
    </div>
  </div>
  <div class="doc-title">
    <h1 style="font-size: 21px;">${escapeHtml(title)}</h1>
    <div class="muted">${escapeHtml(returnNumber)} &middot; ${escapeHtml(returnDate)}</div>
  </div>
</section>`;

  html += `<section class="top-grid">
  <div class="box">
    <div class="label">${isGoodsOut ? 'Pelanggan' : 'Pemasok'}</div>
    <div class="strong">${escapeHtml(customerName)}</div>
    <div class="muted">${customerDetail || '—'}</div>
  </div>
  <div class="box">
    <div class="label">Informasi Retur</div>
    <div class="muted">${infoDetail}</div>
  </div>
</section>`;

  html += `<table>
  <thead>
    <tr>
      <th style="width: 56%;">Barang Diretur</th>
      <th style="width: 20%;">Jumlah</th>
      <th style="width: 24%;" class="right">Kondisi</th>
    </tr>
  </thead>
  <tbody>
    ${groupedItems.map(renderRow).join('\n    ')}
  </tbody>
</table>`;

  html += `<section class="bottom" style="margin-top: auto; padding-top: 10px;">
  <div class="notes-column" style="width: 100%;">
    <div class="total-qty" style="padding: 2.5px 8px; margin-bottom: 3px; font-size: 12px;">
      Total Barang: <span>${groupedItems.length} Jenis</span> &middot; Total Retur: <span>${escapeHtml(unitSummary || `${totalUnits} unit`)}</span>
    </div>
    <div class="notes" style="padding: 3px 8px; font-size: 11px; line-height: 1.25;">
      <span class="label" style="font-size: 11px; margin-bottom: 1px;">Catatan:</span>
      ${escapeHtml(notesText)}
    </div>
  </div>
  <div class="goodsout-signatures" style="width: 100%; margin-top: 14px;">
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">${isGoodsOut ? 'Penerima / Pelanggan' : 'Pemasok'}</div>
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">Hormat Kami</div>
  </div>
</section>`;

  return [html];
}

/**
 * Format Kertas A4 (Portrait 21cm × 29.7cm)
 */
function returnPagesA4(returnRecord, settings, contactData, companyName, companyDetail, customerName, customerDetail, returnNumber, returnDate) {
  const isGoodsOut = returnRecord.documentType === 'goods_out'
    || returnRecord.document_type === 'goods_out'
    || returnRecord.type === 'goods_out'
    || String(returnRecord.documentNumber || '').startsWith('WH/OUT')
    || String(returnRecord.returnNumber || '').includes('OUT');

  const title = 'Return';
  const docNumber = returnRecord.documentNumber || '—';
  const warehouse = returnRecord.warehouseName || returnRecord.metadata?.warehouse || 'Gudang Utama';

  const defaultNote = 'Barang telah diperiksa fisik dan dicatat dalam pembukuan retur gudang.';
  let notesText = defaultNote;
  const rawNote = String(returnRecord.notes || '').trim();
  const rawReason = String(returnRecord.reason || returnRecord.return_reason || '').trim();
  if (rawNote && rawNote.toLowerCase() !== rawReason.toLowerCase()) {
    notesText = rawNote;
  }

  const groupedItems = groupReturnItems(returnRecord.items || []);
  const totalUnits = groupedItems.reduce((sum, g) => sum + g.totalQty, 0);

  const unitTotals = {};
  groupedItems.forEach((g) => {
    unitTotals[g.unit] = (unitTotals[g.unit] || 0) + g.totalQty;
  });
  const unitSummary = Object.entries(unitTotals).map(([u, q]) => `${q} ${u}`).join(', ');

  // A4 Pagination Weight Calculation
  const getItemWeightA4 = (g) => {
    let w = 1.0;
    if (g.serials && g.serials.length > 0) {
      w += Math.ceil(g.serials.length / 5) * 0.35;
    }
    if (g.productName && g.productName.length > 40) w += 0.25;
    return w;
  };

  const chunks = [];
  let currentChunk = [];
  let currentWeight = 0;
  const maxWeightFirstPage = 15.0;
  const maxWeightNextPage = 20.0;

  groupedItems.forEach((item) => {
    const w = getItemWeightA4(item);
    const maxW = chunks.length === 0 ? maxWeightFirstPage : maxWeightNextPage;
    if (currentChunk.length > 0 && currentWeight + w > maxW) {
      chunks.push(currentChunk);
      currentChunk = [item];
      currentWeight = w;
    } else {
      currentChunk.push(item);
      currentWeight += w;
    }
  });
  if (currentChunk.length > 0 || chunks.length === 0) {
    chunks.push(currentChunk);
  }

  const totalPages = chunks.length;
  let itemCounter = 1;
  const logosHtml = brandLogosHtml(settings);

  return chunks.map((chunk, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === totalPages - 1;
    const showPageNum = totalPages > 1;
    const pageNum = showPageNum ? `Halaman ${idx + 1} dari ${totalPages}` : '';

    const rowsHtml = chunk.map((g) => {
      const rowIdx = itemCounter++;
      const name = escapeHtml(g.productName);
      const sku = g.sku && g.sku !== '—' && g.sku !== '-' ? escapeHtml(g.sku) : '—';

      let serialsHtml = '';
      if (g.serials && g.serials.length > 0) {
        serialsHtml = `
          <div class="a4-serial-box">
            <span class="a4-serial-tag">No. Seri (${g.serials.length}):</span>
            <span class="a4-serial-list">${escapeHtml(g.serials.join(', '))}</span>
          </div>
        `;
      }

      const isDamaged = g.condition === 'damaged';
      const conditionBadge = isDamaged
        ? `<span style="display: inline-block; padding: 2px 6px; background: #fef2f2; border: 1px solid #dc2626; color: #991b1b; font-size: 11px; font-weight: 700; border-radius: 3px;">Rusak / Damaged</span>`
        : `<span style="display: inline-block; padding: 2px 6px; background: #f0fdf4; border: 1px solid #16a34a; color: #166534; font-size: 11px; font-weight: 700; border-radius: 3px;">Baik / Tersedia</span>`;

      return `
        <tr>
          <td class="a4-col-no">${rowIdx}</td>
          <td class="a4-col-sku">${sku}</td>
          <td class="a4-col-name">
            <div class="a4-item-title">${name}</div>
            ${serialsHtml}
          </td>
          <td class="a4-col-qty">
            <div class="a4-qty-main">${g.totalQty} ${escapeHtml(g.unit)}</div>
          </td>
          <td style="text-align: center; vertical-align: top;">${conditionBadge}</td>
        </tr>
      `;
    }).join('\n');

    let html = '';

    if (isFirst) {
      html += `
        <header class="a4-header">
          <div class="a4-header-left">
            ${logosHtml ? `<div class="a4-brand-logos">${logosHtml}</div>` : ''}
            <div class="a4-company-info">
              <div class="a4-brand-name">${escapeHtml(companyName)}</div>
              <div class="a4-company-sub">${companyDetail}</div>
            </div>
          </div>
          <div class="a4-doc-meta">
            <h1 class="a4-doc-title">${escapeHtml(title)}</h1>
            <div class="a4-doc-num">${escapeHtml(returnNumber)}</div>
            <div class="a4-doc-date">Tanggal: <strong>${escapeHtml(returnDate)}</strong></div>
            <div style="font-size: 11px; color: #000; margin-top: 2px;">Ref Dokumen: <strong>${escapeHtml(docNumber)}</strong></div>
          </div>
        </header>

        <section class="a4-info-grid">
          <div class="a4-info-card">
            <div class="a4-card-title">${isGoodsOut ? 'PELANGGAN' : 'PEMASOK'}</div>
            <div class="a4-card-name">${escapeHtml(customerName)}</div>
            <div class="a4-card-desc">${customerDetail || '—'}</div>
          </div>
          <div class="a4-info-card">
            <div class="a4-card-title">INFORMASI RETUR</div>
            <div class="a4-card-content">
              <div><span class="a4-info-label">Dokumen Asal:</span> <strong>${escapeHtml(docNumber)}</strong></div>
              <div><span class="a4-info-label">Gudang:</span> <strong>${escapeHtml(warehouse)}</strong></div>
            </div>
          </div>
        </section>
      `;
    } else {
      html += `
        <header class="a4-continued-header">
          <div class="a4-cont-left">
            <strong>${escapeHtml(companyName)}</strong> &middot; <span>${escapeHtml(title)}: ${escapeHtml(returnNumber)}</span>
          </div>
          <div class="a4-cont-right">${pageNum}</div>
        </header>
      `;
    }

    html += `
      <table class="a4-table">
        <thead>
          <tr>
            <th class="a4-th-no">No</th>
            <th class="a4-th-sku">Kode SKU</th>
            <th style="width: 40%; text-align: left;">Barang Diretur & Nomor Seri</th>
            <th style="width: 15%; text-align: right;">Jumlah</th>
            <th style="width: 17%; text-align: center;">Kondisi Retur</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    `;

    if (!isLast && showPageNum) {
      html += `<div class="a4-page-num">${pageNum}</div>`;
    }

    if (isLast) {
      html += `
        <section class="a4-bottom-section">
          <div class="a4-summary-grid">
            <div class="a4-notes-box">
              <div class="a4-notes-label">CATATAN:</div>
              <div class="a4-notes-text">${escapeHtml(notesText || '—')}</div>
            </div>
            <div class="a4-total-box">
              <div class="a4-total-row">
                <span>Total Item Produk:</span>
                <strong>${groupedItems.length} Baris</strong>
              </div>
              <div class="a4-total-row a4-total-highlight">
                <span>Total Kuantitas:</span>
                <strong>${escapeHtml(unitSummary || `${totalUnits} unit`)}</strong>
              </div>
            </div>
          </div>

          <div class="a4-signatures">
            <div class="a4-sign-box">
              <div class="a4-sign-role">${isGoodsOut ? 'Penerima / Pelanggan' : 'Pemasok'}</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ${escapeHtml(customerName)} )</div>
              <div class="a4-sign-sub">Tanda Tangan & Cap</div>
            </div>
            <div class="a4-sign-box">
              <div class="a4-sign-role">Hormat Kami</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ____________________ )</div>
              <div class="a4-sign-sub">Bagian Gudang</div>
            </div>
          </div>
        </section>
      `;

      if (showPageNum) {
        html += `<div class="a4-page-num">${pageNum}</div>`;
      }
    }

    return html;
  });
}

/**
 * Generator Utama Bukti Retur HTML
 * @param {Object} returnRecord Objek transaksi retur
 * @param {Object} settings Pengaturan workspace/perusahaan
 * @param {Object} contactData Data master kontak (customer/supplier)
 * @param {string} paperMode 'compact' (Rangkap 21x12cm) atau 'a4' (Kertas A4 21x29.7cm)
 */
export function generateReturnReceiptHtml(returnRecord, settings, contactData = null, paperMode = 'compact') {
  const isA4Layout = paperMode === 'a4';

  const companyName = preferDefined(
    settings?.company?.companyName,
    settings?.company?.name,
    settings?.companyName,
    'DocuFlow Warehouse'
  );
  const companyEmail = preferDefined(
    settings?.company?.companyEmail,
    settings?.company?.email,
    settings?.email,
    ''
  );
  const companyPhone = preferDefined(
    settings?.company?.companyPhone,
    settings?.company?.phone,
    settings?.phone,
    ''
  );
  const companyAddress = preferDefined(
    settings?.company?.companyAddress,
    settings?.company?.address,
    settings?.address,
    ''
  );
  const companyCity = preferDefined(
    settings?.company?.companyCity,
    settings?.company?.city,
    settings?.city,
    ''
  );

  const addressLine = [companyAddress, companyCity].filter((v) => String(v ?? '').trim()).join(', ');
  const contactLine = [companyEmail, companyPhone].filter((v) => String(v ?? '').trim()).join(' · ');
  const companyDetail = [addressLine, contactLine].filter(Boolean).join('<br/>');

  const customerName = contactData?.name || returnRecord.contactName || 'Customer';
  const addrParts = [
    contactData?.address || returnRecord.address || '',
    contactData?.city || returnRecord.city || '',
    contactData?.province || returnRecord.province || '',
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
  const customerAddress = addrParts.join(', ');
  const customerPhone = contactData?.phone || returnRecord.phone || '';

  const customerLines = [];
  if (customerAddress) customerLines.push(customerAddress);
  if (customerPhone) customerLines.push(`Telp: ${customerPhone}`);
  const customerDetail = customerLines.map(escapeHtml).join('<br/>');

  const returnNumber = returnRecord.returnNumber || `RET-${String(returnRecord.id || '').slice(0, 8)}`;
  const returnDate = formatDate(returnRecord.returnedAt || returnRecord.date || new Date().toISOString());

  const pages = isA4Layout
    ? returnPagesA4(returnRecord, settings, contactData, companyName, companyDetail, customerName, customerDetail, returnNumber, returnDate)
    : returnPagesCompact(returnRecord, settings, contactData, companyName, companyDetail, customerName, customerDetail, returnNumber, returnDate);

  const pageContainerClass = isA4Layout ? 'page page-goodsout-a4' : 'page';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=794, initial-scale=1" />
  <title>${escapeHtml(companyName)} - ${escapeHtml(returnNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: Calibri, Arial, sans-serif;
      color: #000;
      background: #f1f5f9;
      font-weight: 600;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }

    /* Print toolbar (hidden on print) */
    .print-toolbar {
      position: sticky;
      top: 0;
      z-index: 1000;
      background: #0f172a;
      padding: 10px 16px;
      margin-bottom: 18px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
    }
    .print-toolbar-inner {
      max-width: 794px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .print-toolbar-title {
      font-size: 13px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 0.2px;
    }
    .print-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #ffffff;
      color: #000000;
      border: 1px solid #000000;
      border-radius: 6px;
      padding: 7px 18px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      transition: all 0.15s ease;
    }
    .print-btn:hover {
      background: #e2e8f0;
    }

    .page {
      width: 794px;
      min-width: 794px;
      max-width: 794px;
      min-height: 454px;
      margin: 0 auto 16px auto;
      padding: 18px 20px 22px 20px;
      background: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      display: flex;
      flex-direction: column;
    }

    /* Continuous 21x12 Layout Styles */
    .header { display: flex; justify-content: space-between; align-items: start; border-bottom: 1px solid #000; padding-bottom: 3px; }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .company { min-width: 0; }
    .brand { font-size: 19px; font-weight: 900; color: #000; }
    .muted { color: #000; font-size: 11.5px; line-height: 1.25; font-weight: 600; }
    .company .muted { font-size: 11.5px; line-height: 1.25; font-weight: 600; }
    .brand-logos { display: flex; align-items: center; gap: 6px; }
    .brand-logo { display: flex; height: 26px; width: auto; align-items: center; justify-content: center; border: 0; border-radius: 0; font-size: 8px; font-weight: 800; line-height: 1.1; text-align: center; color: #000; overflow: hidden; }
    .brand-logo img { width: auto; max-width: 88px; height: 26px; object-fit: contain; display: block; filter: grayscale(1) contrast(4); }
    .doc-title { text-align: right; flex-shrink: 0; }
    .doc-title h1 { margin: 0; font-size: 21px; font-weight: 900; }
    .top-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; margin-top: 2px; border-bottom: 0.5px solid #000; padding-bottom: 3px; }
    .box { border: 0; border-radius: 0; padding: 0; }
    .label { font-size: 11.5px; line-height: 1.25; color: #000; font-weight: 600; margin-bottom: 2px; }
    .strong { font-weight: 600; font-size: 11.5px; line-height: 1.25; }
    table { width: 100%; border-collapse: collapse; margin-top: 1px; font-size: 11.5px; }
    thead { display: table-header-group; }
    tbody tr { page-break-inside: avoid; break-inside: avoid; }
    th { text-align: left; color: #000; border-bottom: 0; padding: 2px 6px 1px 6px; font-size: 11.5px; font-weight: 600; line-height: 1.25; }
    td { border-bottom: 0; padding: 1.5px 6px 1.5px 6px; line-height: 1.25; font-weight: 600; color: #000; vertical-align: top; }
    .right { text-align: right; }
    .bottom { display: grid; grid-template-columns: minmax(0,1fr) 310px; row-gap: 3px; column-gap: 24px; margin-top: auto; padding-top: 8px; align-items: start; page-break-inside: avoid; break-inside: avoid; }
    .total-qty { display: flex; justify-content: space-between; align-items: center; padding: 2px 8px; border: 0.5px solid #000; border-radius: 0; margin-bottom: 3px; font-size: 12px; font-weight: 700; }
    .notes { padding: 3px 8px; border: 0.5px solid #000; border-radius: 0; background: #fff; color: #000; font-size: 11px; line-height: 1.25; font-weight: 600; }
    .notes .label { display: block; font-size: 11px; line-height: 1.25; font-weight: 600; margin: 0 0 1px; }
    .goodsout-signatures {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      font-size: 11.5px;
      line-height: 1.2;
      font-weight: 600;
    }
    .goodsout-signatures .line {
      border-top: 0.5px solid #000;
      padding-top: 2px;
      text-align: center;
    }

    /* A4 Layout Styles */
    .page-goodsout-a4 {
      width: 794px;
      max-width: 794px;
      min-height: 1123px;
      padding: 38px 45px;
      margin: 0 auto 24px auto;
      background: #ffffff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
      position: relative;
    }
    .a4-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #000000;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .a4-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .a4-brand-logos {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .a4-brand-logos .brand-logo img {
      height: 32px;
      max-width: 80px;
      object-fit: contain;
      filter: grayscale(1) contrast(3);
    }
    .a4-brand-name {
      font-size: 18px;
      font-weight: 900;
      color: #000000;
      letter-spacing: -0.3px;
    }
    .a4-company-sub {
      font-size: 11px;
      color: #000000;
      line-height: 1.4;
      margin-top: 3px;
      max-width: 420px;
      font-weight: 600;
    }
    .a4-doc-meta {
      text-align: right;
    }
    .a4-doc-title {
      margin: 0;
      font-size: 18px;
      font-weight: 900;
      color: #000000;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .a4-doc-num {
      font-size: 13.5px;
      font-weight: 700;
      color: #000000;
      margin-top: 3px;
    }
    .a4-doc-date {
      font-size: 11.5px;
      color: #000000;
      margin-top: 3px;
      font-weight: 600;
    }
    .a4-info-grid {
      display: grid;
      grid-template-columns: 1.25fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .a4-info-card {
      background: #ffffff;
      border: 1px solid #000000;
      border-radius: 0;
      padding: 7px 10px;
    }
    .a4-card-title {
      font-size: 10px;
      font-weight: 800;
      color: #000000;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
      border-bottom: 1px dashed #000000;
      padding-bottom: 4px;
    }
    .a4-card-name {
      font-size: 13.5px;
      font-weight: 700;
      color: #000000;
    }
    .a4-card-desc, .a4-card-content {
      font-size: 11.5px;
      color: #000000;
      line-height: 1.45;
      margin-top: 4px;
      font-weight: 600;
    }
    .a4-info-label {
      color: #000000;
      display: inline-block;
      min-width: 105px;
      font-weight: 600;
    }
    .a4-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 6px;
      font-size: 11.5px;
    }
    .a4-table th {
      background: #000000;
      color: #ffffff;
      font-weight: 700;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 5px 8px;
      border: 1px solid #000000;
    }
    .a4-th-no { width: 5%; text-align: center; }
    .a4-th-sku { width: 17%; text-align: left; }
    .a4-table td {
      padding: 5px 8px;
      border: 1px solid #000000;
      vertical-align: top;
      color: #000000;
      font-weight: 600;
    }
    .a4-col-no { text-align: center; font-weight: 600; color: #000000; }
    .a4-col-sku { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; color: #000000; }
    .a4-item-title { font-weight: 700; font-size: 12.5px; line-height: 1.35; color: #000000; }
    .a4-serial-box {
      margin-top: 3px;
      padding: 3px 6px;
      background: #ffffff;
      border: 1px solid #000000;
      border-left: 3px solid #000000;
      font-size: 10px;
      line-height: 1.35;
    }
    .a4-serial-tag { font-weight: 700; color: #000000; margin-right: 4px; }
    .a4-serial-list { font-family: ui-monospace, Menlo, Consolas, monospace; color: #000000; word-break: break-all; }
    .a4-col-qty { text-align: right; }
    .a4-qty-main { font-weight: 700; font-size: 12.5px; color: #000000; }

    .a4-bottom-section {
      margin-top: 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .a4-summary-grid {
      display: grid;
      grid-template-columns: 1fr 280px;
      gap: 12px;
      margin-bottom: 16px;
    }
    .a4-notes-box {
      border: 1px solid #000000;
      padding: 8px 10px;
      background: #ffffff;
    }
    .a4-notes-label {
      font-size: 10px;
      font-weight: 800;
      color: #000000;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .a4-notes-text {
      font-size: 11px;
      line-height: 1.45;
      color: #000000;
      font-weight: 600;
    }
    .a4-total-box {
      border: 1px solid #000000;
      padding: 8px 10px;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
    }
    .a4-total-row {
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
      color: #000000;
    }
    .a4-total-highlight {
      font-size: 13px;
      font-weight: 800;
      border-top: 1px dashed #000000;
      padding-top: 4px;
      margin-top: 2px;
    }
    .a4-signatures {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px;
      margin-top: 16px;
      page-break-inside: avoid;
    }
    .a4-sign-box {
      border: 1px solid #000000;
      border-radius: 0;
      padding: 8px 10px;
      background: #ffffff;
      text-align: center;
    }
    .a4-sign-role {
      font-size: 11.5px;
      font-weight: 700;
      color: #000000;
    }
    .a4-sign-space {
      height: 40px;
    }
    .a4-sign-line {
      font-size: 11.5px;
      font-weight: 600;
      color: #000000;
    }
    .a4-sign-sub {
      font-size: 9.5px;
      color: #000000;
      margin-top: 2px;
      font-weight: 600;
    }
    .a4-page-num {
      text-align: right;
      font-size: 10px;
      color: #000000;
      margin-top: 14px;
      font-weight: 600;
    }
    .a4-continued-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1.5px solid #000000;
      padding-bottom: 6px;
      margin-bottom: 16px;
      font-size: 12px;
      color: #000000;
    }

    @media print {
      .no-print, .print-toolbar {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      @page {
        size: ${isA4Layout ? 'A4 portrait' : '21cm 12cm'};
        margin: ${isA4Layout ? '10mm 12mm' : '0'};
      }
      html, body {
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #fff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      html, body, * {
        text-shadow: none !important;
      }
      .page {
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: ${isA4Layout ? '0' : '454px'} !important;
        padding: ${isA4Layout ? '0' : '18px 20px 22px 20px'} !important;
        margin: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
        display: flex !important;
        flex-direction: column !important;
      }
      .page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
      .bottom {
        margin-top: auto !important;
      }
      .page-goodsout-a4 {
        padding: 0 !important;
        display: flex !important;
        flex-direction: column !important;
      }
      .a4-bottom-section {
        margin-top: auto !important;
      }
      .a4-table th {
        background-color: #000000 !important;
        color: #ffffff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .a4-info-card, .a4-notes-box, .a4-total-box, .a4-serial-box {
        background-color: #ffffff !important;
        border-color: #000000 !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .header {
        display: flex !important;
        flex-direction: row !important;
      }
    }
  </style>
</head>
<body>
  <div class="print-toolbar no-print">
    <div class="print-toolbar-inner">
      <div class="print-toolbar-title">Preview Bukti Retur: <strong>${escapeHtml(returnNumber)}</strong> (${isA4Layout ? 'A4 Portrait' : 'Rangkap 21×12cm'})</div>
      <button class="print-btn" onclick="window.print()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect width="12" height="8" x="6" y="14"></rect></svg><span>Cetak Bukti Retur</span>
      </button>
    </div>
  </div>

  ${pages.map((content) => `<div class="${pageContainerClass}">${content}</div>`).join('\n')}

  <script>
    // Otomatis picu dialog print setelah halaman selesai dimuat jika browser mendukung
    window.addEventListener('load', function() {
      setTimeout(function() {
        window.print();
      }, 250);
    });
  </script>
</body>
</html>`;
}

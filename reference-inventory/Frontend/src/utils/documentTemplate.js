const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const numVal = (v) => {
  if (typeof v === 'number') return v;
  return Number(String(v ?? '').replace(/[^0-9]/g, '')) || 0;
};

const preferDefined = (...values) => values.find((value) => value !== undefined && value !== null);

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    }).replace(/ /g, '-');
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

function headerHtml(companyName, companyDetail, title, docNumber, date, settings) {
  return `<section class="header">
  <div class="header-left">
    <div class="brand-logos">${brandLogosHtml(settings)}</div>
    <div class="company">
      <div class="brand">${escapeHtml(companyName)}</div>
      <div class="muted">${companyDetail}</div>
    </div>
  </div>
  <div class="doc-title">
    <h1>${escapeHtml(title)}</h1>
    <div class="muted">${escapeHtml(docNumber)} \u00b7 ${escapeHtml(date)}</div>
  </div>
</section>`;
}

function continuedHeaderHtml(companyName, title, docNumber, pageNum, totalPages) {
  return `<section class="page-continued-header">
  <div class="continued-left">
    <span class="continued-brand">${escapeHtml(companyName)}</span>
    <span class="continued-sep">&bull;</span>
    <span class="continued-title">${escapeHtml(title)}</span>
    <span class="continued-number">(${escapeHtml(docNumber)})</span>
  </div>
  <div class="continued-right">
    <span>Lembar ${pageNum} dari ${totalPages}</span>
  </div>
</section>`;
}

function getItemWeight(item) {
  if (!item) return 1;
  let weight = 1.0;
  const name = String(item.name || item.itemName || item.item_name || '');
  if (name.length > 45) weight += 0.3;

  const sku = String(item.sku || '');
  if (sku && sku !== '—' && sku !== '-') weight += 0.2;

  if (Array.isArray(item.serials) && item.serials.length > 0) {
    const snString = item.serials.join(', ');
    // In compact monospace font (~75-80 chars/line), each line takes ~10px (~0.32 weight units)
    const snLines = Math.ceil((snString.length + 15) / 75);
    weight += snLines * 0.32;
  }
  return weight;
}

function chunkWeightedItems(items, options = {}) {
  if (!items || items.length === 0) return [[]];

  // Maximum weight that fits on a single page with Header, Top-grid, Table, and Bottom Summary
  const singlePageMax = options.singlePageMax || 8.8;
  // Maximum weight for Page 1 of multi-page (Header + Top-grid, no summary)
  const firstPageCapacity = options.firstPageCapacity || 11.5;
  // Maximum weight for middle pages (Table only, no header, no summary)
  const subsequentPageCapacity = options.subsequentPageCapacity || 14.5;
  // Maximum weight for last page of multi-page (Table + Bottom summary)
  const lastPageCapacity = options.lastPageCapacity || 10.0;

  // 1. If all items fit on 1 single page with bottom summary
  const totalWeight = items.reduce((sum, it) => sum + getItemWeight(it), 0);
  if (totalWeight <= singlePageMax && items.length <= 9) {
    return [items.slice()];
  }

  // 2. Multi-page pagination
  const pages = [];
  let currentPage = [];
  let currentWeight = 0;
  let isFirstPage = true;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const w = getItemWeight(item);
    const isLastItem = (i === items.length - 1);

    // If adding this item would make it the last item on the first page,
    // it must fit WITH the bottom summary (singlePageMax).
    let capacity;
    if (isFirstPage) {
      capacity = (isLastItem && pages.length === 0) ? singlePageMax : firstPageCapacity;
    } else {
      capacity = isLastItem ? lastPageCapacity : subsequentPageCapacity;
    }

    if (currentPage.length > 0 && currentWeight + w > capacity) {
      pages.push(currentPage);
      currentPage = [item];
      currentWeight = w;
      isFirstPage = false;
    } else {
      currentPage.push(item);
      currentWeight += w;
    }
  }

  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  // Visual balance: Distribute items evenly across pages so subsequent pages look full & balanced
  if (pages.length === 2) {
    const p1 = pages[0];
    const p2 = pages[1];
    let w1 = p1.reduce((sum, it) => sum + getItemWeight(it), 0);
    let w2 = p2.reduce((sum, it) => sum + getItemWeight(it), 0);

    // If page 1 has significantly more items than page 2, balance them
    while (p1.length > 2 && p1.length > p2.length) {
      const candidateItem = p1[p1.length - 1];
      const itemW = getItemWeight(candidateItem);
      if (w2 + itemW <= lastPageCapacity) {
        p1.pop();
        p2.unshift(candidateItem);
        w1 -= itemW;
        w2 += itemW;
      } else {
        break;
      }
    }
  } else if (pages.length > 2) {
    for (let i = pages.length - 1; i >= 1; i--) {
      const prev = pages[i - 1];
      const curr = pages[i];
      let currW = curr.reduce((sum, it) => sum + getItemWeight(it), 0);
      if (curr.length === 1 && prev.length >= 3 && currW < 3.0) {
        const movedItem = prev[prev.length - 1];
        const movedW = getItemWeight(movedItem);
        const maxCap = (i === pages.length - 1) ? lastPageCapacity : subsequentPageCapacity;
        if (currW + movedW <= maxCap) {
          prev.pop();
          curr.unshift(movedItem);
        }
      }
    }
  }

  return pages;
}

function chunkItems(items) {
  return chunkWeightedItems(items);
}

function padRows(rows, target, emptyRow) {
  while (rows.length < target) rows.push(emptyRow);
  return rows;
}

const GOODS_MULTIPLIERS = {
  pcs: 1,
  piece: 1,
  pack3: 3,
  pack6: 6,
  lusin: 12,
  dozen: 12,
  pack: 60,
  bal5: 60,   // 5 Lusin
  bal10: 120, // 10 Lusin
  bal15: 180, // 15 Lusin
  bal20: 240, // 20 Lusin
  bal25: 300, // 25 Lusin
  bal: 300,   // Fallback & Legacy compatibility
};

const LUSIN_UNITS = new Set([
  'lusin', 'dozen', 'pack', 'bal5', 'bal10', 'bal15', 'bal20', 'bal25', 'bal',
]);

function isLusinUnit(unit) {
  if (!unit) return false;
  const u = String(unit).toLowerCase().trim();
  if (u === 'pack3' || u === 'pk3' || u === 'pack6' || u === 'pk6' || u === 'pcs' || u === 'piece') {
    return false;
  }
  if (LUSIN_UNITS.has(u)) return true;
  if (u.includes('lusin') || u.includes('doz') || u.includes('bal')) return true;
  if (u === 'pack' || u === 'pk') return true;
  return false;
}

function parseUnitFromSn(sn, fallbackUnit = 'pcs') {
  if (!sn) return fallbackUnit;
  const s = String(sn).toLowerCase();
  if (s.includes('10bl') || s.includes('bal10')) return 'bal10';
  if (s.includes('15bl') || s.includes('bal15')) return 'bal15';
  if (s.includes('20bl') || s.includes('bal20')) return 'bal20';
  if (s.includes('25bl') || s.includes('bal25')) return 'bal25';
  if (s.includes('5bl') || s.includes('bal5')) return 'bal5';
  if (s.includes('bal') || s.includes('bl')) return 'bal';
  if (s.includes('pack3') || s.includes('pk3')) return 'pack3';
  if (s.includes('pack6') || s.includes('pk6')) return 'pack6';
  if (s.includes('pack') || s.includes('pk')) return 'pack';
  if (s.includes('lusin') || s.includes('doz')) return 'lusin';
  return fallbackUnit;
}

function getUnitHelpers(customUnits) {
  const multipliers = { ...GOODS_MULTIPLIERS };
  const lusinUnitsSet = new Set(LUSIN_UNITS);

  if (Array.isArray(customUnits) && customUnits.length > 0) {
    for (const u of customUnits) {
      if (u.key) {
        const k = String(u.key).toLowerCase().trim();
        const mult = Number(u.multiplier || (u.baseType === 'lusin' ? u.baseValue * 12 : u.baseValue) || 1);
        multipliers[k] = mult;
        if (u.baseType === 'lusin') {
          lusinUnitsSet.add(k);
        } else if (u.baseType === 'pcs') {
          lusinUnitsSet.delete(k);
        }
      }
    }
  }

  const isLusin = (unit) => {
    if (!unit) return false;
    const clean = String(unit).toLowerCase().trim();
    if (Array.isArray(customUnits)) {
      const found = customUnits.find((u) => u.key && String(u.key).toLowerCase().trim() === clean);
      if (found) return found.baseType === 'lusin';
    }
    if (clean === 'pack3' || clean === 'pk3' || clean === 'pack6' || clean === 'pk6' || clean === 'pcs' || clean === 'piece') {
      return false;
    }
    if (lusinUnitsSet.has(clean)) return true;
    if (clean.includes('lusin') || clean.includes('doz') || clean.includes('bal')) return true;
    return false;
  };

  const parseSn = (sn, fallbackUnit = 'pcs') => {
    if (!sn) return fallbackUnit;
    const clean = String(sn).toLowerCase().trim();
    if (Array.isArray(customUnits)) {
      const sorted = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
      for (const u of sorted) {
        const k = String(u.key).toLowerCase().trim();
        if (!k || k === 'pcs') continue;
        if (clean.includes(k)) return k;
      }
    }
    return parseUnitFromSn(clean, fallbackUnit);
  };

  return { multipliers, isLusin, parseSn };
}

export function getItemQtyInPcs(item, helpers = null) {
  const metadata = item.metadata ?? {};
  const isSerial = metadata.isSerial === true || !!metadata.serialNumber || item.isSerial === true;
  const isGroup = metadata.isGroup === true || item.isGroup === true;
  const serialNumber = metadata.serialNumber || item.serialNumber || '';

  const rawGroupQty = Number(
    metadata.targetQty
    ?? metadata.unitQty
    ?? item.targetQty
    ?? item.unitQty
  );
  const groupQty = Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : null;

  const groupUnit = metadata.targetUnit ?? item.targetUnit ?? null;
  let unit = String(
    (isGroup ? groupUnit : null)
    || metadata.qtyUnit
    || item.qtyUnit
    || metadata.unit
    || item.unit
    || 'pcs'
  ).toLowerCase().trim() || 'pcs';

  if (isSerial && !isGroup && serialNumber && (!unit || unit === 'pcs' || unit === 'piece')) {
    unit = helpers ? helpers.parseSn(serialNumber, unit) : parseUnitFromSn(serialNumber, unit);
  }

  const rawGroupInput = Number(metadata.qtyInput ?? item.qtyInput ?? item.quantity ?? 1);
  const qty = isGroup
    ? (groupQty ?? (Number.isFinite(rawGroupInput) && rawGroupInput > 0 ? rawGroupInput : 1))
    : isSerial
      ? 1
      : Number(metadata.qtyInput ?? item.qtyInput ?? item.quantity ?? item.qty ?? 1);

  const normalizedQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  const mult = (helpers ? helpers.multipliers[unit] : GOODS_MULTIPLIERS[unit])
    || ((helpers ? helpers.isLusin(unit) : isLusinUnit(unit)) ? 12 : 1);
  const rawTotalPcs = Number(metadata.totalPcs ?? metadata.totalBaseQtyPcs ?? metadata.baseQuantity);
  const pcs = isGroup && Number.isFinite(rawTotalPcs) && rawTotalPcs > 0
    ? rawTotalPcs
    : normalizedQty * mult;

  return {
    isSerial,
    isGroup,
    serialNumber,
    unit,
    qty: normalizedQty,
    pcs,
    totalPcs: pcs,
  };
}

function formatDocumentQty(totalLusin, totalPcs) {
  let lusin = totalLusin || 0;
  let pcs = totalPcs || 0;

  if (lusin % 1 !== 0) {
    const extraPcs = Math.round((lusin % 1) * 12);
    lusin = Math.floor(lusin);
    pcs += extraPcs;
  }

  lusin = Math.round(lusin);
  pcs = Math.round(pcs);

  if (lusin > 0 && pcs > 0) {
    return `${lusin.toLocaleString('id-ID')} lusin ${pcs.toLocaleString('id-ID')} pcs`;
  }
  if (lusin > 0) {
    return `${lusin.toLocaleString('id-ID')} lusin`;
  }
  if (pcs > 0) {
    return `${pcs.toLocaleString('id-ID')} pcs`;
  }
  return '0 pcs';
}

function formatLusinPcs(totalPcs) {
  const count = Math.max(0, Math.round(totalPcs || 0));
  const lusin = Math.floor(count / 12);
  const pcs = count % 12;

  if (lusin > 0 && pcs > 0) {
    return `${lusin.toLocaleString('id-ID')} lusin ${pcs.toLocaleString('id-ID')} pcs`;
  }
  if (lusin > 0) {
    return `${lusin.toLocaleString('id-ID')} lusin`;
  }
  return `${pcs.toLocaleString('id-ID')} pcs`;
}

function invoicePages(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date) {
  const isSample = doc.document_type === 'sample' || doc.document_type === 'purchase_order';
  const title = doc.document_type === 'purchase_order'
    ? 'Purchase Order'
    : doc.document_type === 'receipt'
      ? (settings?.documents?.receiptTitle || 'Kwitansi')
      : doc.document_type === 'delivery_note'
        ? (settings?.documents?.deliveryNoteTitle || 'Surat Jalan')
        : doc.document_type === 'sample'
          ? (settings?.documents?.sampleTitle || 'Sample')
          : (settings?.documents?.invoiceTitle || 'Nota');
  const paymentTransfer = preferDefined(settings?.company?.paymentTransfer, '');

  let defaultImportantNotice = 'Barang yang sudah dibeli tidak dapat ditukar atau dikembalikan, kecuali ada perjanjian tertulis sebelumnya. Terima kasih atas kepercayaan dan kerja sama Anda.';
  if (doc.document_type === 'delivery_note') {
    defaultImportantNotice = 'Barang telah diterima dalam kondisi baik dan cukup. Harap periksa kembali sebelum menandatangani.';
  } else if (doc.document_type === 'receipt') {
    defaultImportantNotice = 'Bukti pembayaran yang sah. Terima kasih atas pembayaran Anda.';
  } else if (doc.document_type === 'sample') {
    defaultImportantNotice = 'Dokumen ini merupakan bukti penyerahan barang contoh (sample) tanpa nilai komersial.';
  } else if (doc.document_type === 'purchase_order') {
    defaultImportantNotice = 'Dokumen ini merupakan bukti Purchase Order (PO) sah tanpa nilai nominal harga.';
  }

  const items = doc.items || [];
  const hasAnyNotes = items.some((item) => !!(item.metadata?.note || item.note));
  const hasAnyDiscount = !isSample && items.some((item) => {
    const discType = item.discountType || item.discount_type || 'none';
    if (discType === 'none') return false;
    const discVal = numVal(item.discountValue || item.discount_value || 0);
    return discVal > 0;
  });

  const customUnitsList = settings?.custom_units || settings?.customUnits || doc.metadata?.custom_units;
  const helpers = getUnitHelpers(customUnitsList);
  const unitMultipliers = helpers.multipliers;

  const itemUnit = (item) => {
    let unit = item.metadata?.unit || 'lusin';
    const sku = String(item.sku || '');
    if (sku.includes('|')) unit = sku.split('|')[1] || unit;
    return unit;
  };

  const formatQty = (v) => {
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
  };

  let totalLusin = 0;
  let totalPcsOnly = 0;
  const totalByUnit = {};

  items.forEach((item) => {
    const unit = itemUnit(item);
    const qty = Number(item.quantity || item.qty || 1);
    const mult = unitMultipliers[unit] || (helpers.isLusin(unit) ? 12 : 1);
    if (helpers.isLusin(unit)) {
      totalLusin += (qty * mult) / 12;
    } else {
      totalPcsOnly += (qty * mult);
    }
    totalByUnit[unit] = (totalByUnit[unit] || 0) + qty;
  });

  const knownOrder = ['pcs', 'piece', 'lusin', 'dozen', 'pack', 'bal5', 'bal10', 'bal15', 'bal20', 'bal25', 'bal'];
  const allUnits = Array.from(new Set([...knownOrder, ...Object.keys(totalByUnit)]));
  const totalByUnitText = allUnits
    .filter((u) => totalByUnit[u])
    .map((u) => `${formatQty(totalByUnit[u])} ${u}`)
    .join(' \u00b7 ');

  const displayTotalQty = totalByUnitText || formatDocumentQty(totalLusin, totalPcsOnly);

  const notesHeader = hasAnyNotes ? '<th>Catatan</th>' : '';
  const discountHeader = hasAnyDiscount ? '<th>Diskon</th>' : '';

  let emptyRow;
  if (isSample) {
    emptyRow = hasAnyNotes
      ? '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>'
      : '<tr><td>&nbsp;</td><td>&nbsp;</td></tr>';
  } else {
    const discCell = hasAnyDiscount ? '<td>&nbsp;</td>' : '';
    emptyRow = hasAnyNotes
      ? `<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>${discCell}<td class="right">&nbsp;</td><td>&nbsp;</td></tr>`
      : `<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>${discCell}<td class="right">&nbsp;</td></tr>`;
  }

  const renderRow = (item) => {
    const name = escapeHtml(item.itemName || item.item_name || '');
    const qty = Number(item.quantity || item.qty || 1);
    let sku = item.sku || '';
    let unit = itemUnit(item);
    if (sku.includes('|')) {
      const parts = sku.split('|');
      sku = parts[0];
      unit = parts[1];
    }
    const price = numVal(item.unitPrice || item.unit_price || 0);
    const discType = item.discountType || item.discount_type || 'none';
    const discVal = numVal(item.discountValue || item.discount_value || 0);
    let discountAmt = 0;
    if (discType === 'percentage') discountAmt = Math.round((qty * price * discVal) / 100);
    else if (discType === 'fixed') discountAmt = discVal;
    const netAmount = Math.max(qty * price - discountAmt, 0);
    const note = escapeHtml(item.metadata?.note || item.note || '');

    let nameHtml = `<div style="font-weight: 600;">${name}</div>`;
    if (sku && !isSample) {
      nameHtml += `<div class="muted" style="font-size: 10px; font-weight: normal; margin-top: 1px;">SKU: ${escapeHtml(sku)}</div>`;
    }

    let discountHtml = '&nbsp;';
    if (discountAmt > 0) {
      if (discType === 'percentage') discountHtml = `${discVal}%`;
      else if (discType === 'fixed') discountHtml = `Rp ${discVal.toLocaleString('id-ID')}`;
    }

    const discCell = hasAnyDiscount ? `<td>${discountHtml}</td>` : '';

    if (isSample) {
      if (hasAnyNotes) {
        return `<tr><td>${nameHtml}</td><td>${qty} ${escapeHtml(unit)}</td><td>${note}</td></tr>`;
      }
      return `<tr><td>${nameHtml}</td><td>${qty} ${escapeHtml(unit)}</td></tr>`;
    }

    if (hasAnyNotes) {
      return `<tr><td>${nameHtml}</td><td>${qty} ${escapeHtml(unit)}</td><td>Rp ${price.toLocaleString('id-ID')}</td>${discCell}<td class="right">Rp ${netAmount.toLocaleString('id-ID')}</td><td>${note}</td></tr>`;
    }
    return `<tr><td>${nameHtml}</td><td>${qty} ${escapeHtml(unit)}</td><td>Rp ${price.toLocaleString('id-ID')}</td>${discCell}<td class="right">Rp ${netAmount.toLocaleString('id-ID')}</td></tr>`;
  };

  const chunks = chunkItems(items);

  const subtotal = numVal(doc.subtotal) || items.reduce((sum, item) => sum + numVal(item.unitPrice || item.unit_price || 0) * Number(item.quantity || 1), 0);
  const discount = numVal(doc.discount);
  const tax = numVal(doc.tax) || 0;
  const total = numVal(doc.total) || Math.max(subtotal - discount + tax, 0);

  // Calculate detailed discount breakdown
  let itemDiscountsTotal = 0;
  items.forEach((item) => {
    const qty = Number(item.quantity || 1);
    const price = numVal(item.unitPrice || item.unit_price || 0);
    const discType = item.discountType || item.discount_type || 'none';
    const discVal = numVal(item.discountValue || item.discount_value || 0);
    if (discType === 'percentage') {
      itemDiscountsTotal += Math.round((qty * price * discVal) / 100);
    } else if (discType === 'fixed') {
      itemDiscountsTotal += discVal;
    }
  });

  const overallDiscounts = doc.metadata?.overallDiscounts || [];
  const overallDiscountsTotal = overallDiscounts
    .filter((d) => !d.isPointEarned)
    .reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  const legacyDiscount = Math.max(discount - itemDiscountsTotal - overallDiscountsTotal, 0);

  let discountRowsHtml = '';
  if (itemDiscountsTotal > 0) {
    discountRowsHtml += `<div class="total-row"><span>Diskon produk</span><span>-Rp ${itemDiscountsTotal.toLocaleString('id-ID')}</span></div>`;
  }
  overallDiscounts.forEach((d) => {
    if (Number(d.amount || 0) === 0) return;
    if (d.isPointEarned) {
      const suffix = d.type === 'percentage' ? ` (${d.value}%)` : '';
      discountRowsHtml += `<div class="total-row" style="color:#059669;font-weight:600;"><span>Cashback didapat${escapeHtml(suffix)}</span><span>+Rp ${Number(d.amount || 0).toLocaleString('id-ID')}</span></div>`;
      return;
    }
    const label = d.name || 'Diskon Toko';
    const suffix = d.type === 'percentage' ? ` (${d.value}%)` : '';
    discountRowsHtml += `<div class="total-row"><span>${escapeHtml(label + suffix)}</span><span>-Rp ${Number(d.amount || 0).toLocaleString('id-ID')}</span></div>`;
  });
  if (legacyDiscount > 0) {
    discountRowsHtml += `<div class="total-row"><span>Diskon</span><span>-Rp ${legacyDiscount.toLocaleString('id-ID')}</span></div>`;
  }

  const totalPages = chunks.length;

  return chunks.map((chunk, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === chunks.length - 1;
    const showPageNum = totalPages > 1;
    const pageNum = showPageNum ? `${idx + 1}/${totalPages}` : '';
    const targetRows = isSample ? 5 : (isLast ? Math.max(chunk.length, 5) : 7);
    const rows = padRows(chunk.map(renderRow), targetRows, emptyRow);

    let html;
    if (isFirst) {
      html = headerHtml(companyName, companyDetail, title, docNumber, date, settings);
      let rightBoxLabel = 'Transfer Bank';
      let rightBoxValue = escapeHtml(paymentTransfer) || '&nbsp;';
      if (doc.document_type === 'purchase_order') {
        rightBoxLabel = 'Sales Person';
        rightBoxValue = escapeHtml(doc.sales_person_name || doc.sales_person || doc.metadata?.sales_person || 'Sales Tester');
      }

      html += `<section class="top-grid">
  <div class="box">
    <div class="label">Kepada Yth.</div>
    <div class="strong">${escapeHtml(customerName)}</div>
    <div class="muted">${customerDetail}</div>
  </div>
  <div class="box">
    <div class="label">${rightBoxLabel}</div>
    <div class="muted">${rightBoxValue}</div>
  </div>
</section>`;
    } else {
      html = continuedHeaderHtml(companyName, title, docNumber, idx + 1, totalPages);
    }
    const thead = `<thead>\n    <tr><th>Barang</th><th>Qty</th>${isSample ? '' : `<th>Harga</th>${discountHeader}<th class="right">Total</th>`}${notesHeader}</tr>\n  </thead>`;
    html += `<table>
  ${thead}
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`;
    if (!isLast && showPageNum) {
      html += `<div class="page-num">${pageNum}</div>`;
    }
    if (isLast) {
      if (isSample) {
        html += `<section class="bottom invoice-bottom" style="grid-template-columns: 1fr 1fr; grid-template-areas: 'notes notes' 'left right';">
  <div class="notes-column">
    <div class="total-qty">Total Jumlah: <span>${displayTotalQty}</span></div>
    <div class="notes"><span class="label notice-label">PERHATIAN!!!</span>${escapeHtml(defaultImportantNotice)}</div>
  </div>
  <div class="signature signature-left" style="margin-top: 14px;"><div class="line" style="min-height: 38px; padding-bottom: 22px;">Penerima</div></div>
  <div class="totals-signature signature-right" style="margin-top: 14px;"><div class="line" style="min-height: 38px; padding-bottom: 22px;">Hormat Kami</div></div>
</section>`;
      } else {
        html += `<section class="bottom invoice-bottom">
  <div class="notes-column">
    <div class="total-qty">Total Jumlah: <span>${displayTotalQty}</span></div>
    <div class="notes"><span class="label notice-label">PERHATIAN!!!</span>${escapeHtml(defaultImportantNotice)}</div>
  </div>
  <section class="totals box">
    <div class="total-row"><span>Subtotal</span><span>Rp ${subtotal.toLocaleString('id-ID')}</span></div>
    ${discountRowsHtml}
    ${tax > 0 ? `<div class="total-row"><span>Pajak</span><span>Rp ${tax.toLocaleString('id-ID')}</span></div>` : ''}
    <div class="total-row grand"><span>Total</span><span>Rp ${total.toLocaleString('id-ID')}</span></div>
  </section>
  <div class="signature signature-left" style="margin-top: 14px;"><div class="line" style="min-height: 38px; padding-bottom: 22px;">Penerima</div></div>
  <div class="totals-signature signature-right" style="margin-top: 14px;"><div class="line" style="min-height: 38px; padding-bottom: 22px;">Hormat Kami</div></div>
</section>`;
      }
      if (showPageNum) {
        html += `<div class="page-num">${pageNum}</div>`;
      }
    }
    return html;
  });
}



export function getGroupedProductItems(items, doc = null, customUnits = null) {
  const unitsData = customUnits || doc?.metadata?.custom_units || doc?.custom_units;
  const helpers = getUnitHelpers(unitsData);
  const groupMap = new Map();

  // Parse active return transactions from doc metadata
  const activeReturns = Array.isArray(doc?.metadata?.returns)
    ? doc.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];

  const returnedSerialSet = new Set();
  const returnedNonSerialQtyByItem = new Map();

  activeReturns.forEach((r) => {
    (r.items || []).forEach((ri) => {
      const isSerial = ri.isSerial === true || !!ri.serialNumber;
      if (isSerial && ri.serialNumber) {
        returnedSerialSet.add(String(ri.serialNumber).trim().toLowerCase());
      } else {
        const idKey = String(ri.itemId || ri.productId || '').trim();
        if (idKey) {
          const retQty = Number(ri.returnedQty ?? ri.quantity ?? 1) || 0;
          returnedNonSerialQtyByItem.set(idKey, (returnedNonSerialQtyByItem.get(idKey) || 0) + retQty);
        }
      }
    });
  });

  (items || []).forEach((item) => {
    const productId = item.product_id ?? item.productId ?? item.sku ?? item.item_name ?? item.productName ?? 'default';
    const itemId = item.id || item.itemId || productId;
    const name = item.item_name || item.itemName || item.product_name || item.name || 'Produk';
    let sku = item.sku || '—';
    if (sku.includes('|')) {
      sku = sku.split('|')[0];
    }
    const itemInfo = getItemQtyInPcs(item, helpers);

    if (!groupMap.has(productId)) {
      groupMap.set(productId, {
        productId,
        name,
        sku,
        totalPcs: 0,
        totalLusin: 0,
        totalPcsOnly: 0,
        returnedPcs: 0,
        returnedLusin: 0,
        returnedPcsOnly: 0,
        serials: [],
        returnedSerials: [],
        unitCounts: {},
        returnedUnitCounts: {},
        purpose: item.metadata?.purpose || 'Pesanan',
        condition: item.metadata?.condition || 'Baik',
      });
    }

    const current = groupMap.get(productId);
    current.totalPcs += itemInfo.pcs;
    if (helpers.isLusin(itemInfo.unit)) {
      const mult = helpers.multipliers[itemInfo.unit] || 12;
      current.totalLusin += (itemInfo.qty * mult) / 12;
    } else {
      current.totalPcsOnly += itemInfo.pcs;
    }

    // Check return for this item
    let itemReturnedQty = 0;
    if (itemInfo.isSerial && itemInfo.serialNumber) {
      if (returnedSerialSet.has(itemInfo.serialNumber.toLowerCase())) {
        itemReturnedQty = itemInfo.qty;
        if (!current.returnedSerials.includes(itemInfo.serialNumber)) {
          current.returnedSerials.push(itemInfo.serialNumber);
        }
      }
    } else {
      const retFromId = returnedNonSerialQtyByItem.get(String(itemId)) || returnedNonSerialQtyByItem.get(String(productId)) || 0;
      if (retFromId > 0) {
        itemReturnedQty = Math.min(itemInfo.qty, retFromId);
      }
    }

    if (itemReturnedQty > 0) {
      const retMult = helpers.multipliers[itemInfo.unit] || (helpers.isLusin(itemInfo.unit) ? 12 : 1);
      const retPcs = itemReturnedQty * retMult;
      current.returnedPcs += retPcs;
      if (helpers.isLusin(itemInfo.unit)) {
        current.returnedLusin += retPcs / 12;
      } else {
        current.returnedPcsOnly += retPcs;
      }
      current.returnedUnitCounts[itemInfo.unit] = (current.returnedUnitCounts[itemInfo.unit] || 0) + itemReturnedQty;
    }

    if (itemInfo.isSerial && itemInfo.serialNumber) {
      if (!current.serials.includes(itemInfo.serialNumber)) {
        current.serials.push(itemInfo.serialNumber);
      }
    }
    if (Array.isArray(item.serials)) {
      item.serials.forEach((s) => {
        if (s && !current.serials.includes(s)) current.serials.push(s);
      });
    }
    if (Array.isArray(item.metadata?.serials)) {
      item.metadata.serials.forEach((s) => {
        if (s && !current.serials.includes(s)) current.serials.push(s);
      });
    }
    current.unitCounts[itemInfo.unit] = (current.unitCounts[itemInfo.unit] || 0) + itemInfo.qty;
  });

  // Extract from doc level serials if present
  const docSerials = doc?.serials || doc?.productSerials || doc?.metadata?.serials || [];
  if (Array.isArray(docSerials)) {
    docSerials.forEach((s) => {
      const sn = typeof s === 'string' ? s : (s.serialNumber || s.serial_number);
      if (!sn) return;
      const sProdId = s.productId || s.product_id;
      const sDocItemId = s.goodsInItemId || s.goods_in_item_id;
      let matched = null;
      if (sProdId && groupMap.has(sProdId)) {
        matched = groupMap.get(sProdId);
      } else {
        for (const g of groupMap.values()) {
          if (g.productId === sProdId || g.productId === sDocItemId || (s.sku && g.sku === s.sku)) {
            matched = g;
            break;
          }
        }
      }
      if (matched) {
        if (!matched.serials.includes(sn)) {
          matched.serials.push(sn);
        }
        if (returnedSerialSet.has(String(sn).trim().toLowerCase()) && !matched.returnedSerials.includes(sn)) {
          matched.returnedSerials.push(sn);
        }
      }
    });
  }

  return Array.from(groupMap.values()).map((g) => {
    g.serials.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    g.returnedSerials.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const unitEntries = Object.entries(g.unitCounts);
    const breakdown = unitEntries.map(([u, q]) => `${q} ${u}`).join(', ');
    const formattedQty = formatDocumentQty(g.totalLusin, g.totalPcsOnly);

    const netLusin = Math.max(0, g.totalLusin - g.returnedLusin);
    const netPcsOnly = Math.max(0, g.totalPcsOnly - g.returnedPcsOnly);
    const netFormattedQty = formatDocumentQty(netLusin, netPcsOnly);
    const returnedFormattedQty = formatDocumentQty(g.returnedLusin, g.returnedPcsOnly);
    const hasReturns = (g.returnedLusin > 0 || g.returnedPcsOnly > 0 || g.returnedSerials.length > 0);
    const isFullyReturned = hasReturns && netLusin === 0 && netPcsOnly === 0;

    return {
      ...g,
      breakdown,
      formattedQty,
      netLusin,
      netPcsOnly,
      netFormattedQty,
      returnedFormattedQty,
      hasReturns,
      isFullyReturned,
    };
  });
}

function goodsInPagesCompact(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date) {
  const title = settings?.documents?.goodsInTitle || 'Barang Masuk';
  const rawItems = doc.items || doc.metadata?.items || [];
  const groupedItems = getGroupedProductItems(rawItems, doc, settings?.custom_units || settings?.customUnits);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const renderRow = (g) => {
    const name = escapeHtml(g.name);
    let skuHtml = '';
    if (g.sku && g.sku !== '—' && g.sku !== '-') {
      skuHtml = `<div class="muted" style="font-size: 9.5px; font-weight: normal; margin-top: 1px; line-height: 1.2;">SKU: ${escapeHtml(g.sku)}</div>`;
    }
    let serialHtml = '';
    if (g.serials && g.serials.length > 0) {
      serialHtml = `<div class="compact-serials" style="font-size: 8.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-weight: 500; margin-top: 2px; color: #111827; word-break: break-all; line-height: 1.25; letter-spacing: -0.2px;"><span style="font-family: inherit; font-weight: 700; font-size: 9px; color: #000;">No. Seri (${g.serials.length}):</span> ${escapeHtml(g.serials.join(', '))}</div>`;
    }
    const nameHtml = `<div style="font-weight: 700; font-size: 11.5px; line-height: 1.25;">${name}</div>${skuHtml}${serialHtml}`;

    let breakdownHtml = '';
    if (g.breakdown) {
      breakdownHtml = `<div class="muted" style="font-size: 9.5px; font-weight: normal; margin-top: 1px; line-height: 1.2;">(${escapeHtml(g.breakdown)})</div>`;
    }
    const qtyHtml = `<div style="font-weight: 700; font-size: 11.5px;">${escapeHtml(g.formattedQty)}</div>${breakdownHtml}`;

    return `<tr><td>${nameHtml}</td><td class="right">${qtyHtml}</td></tr>`;
  };

  const infoDetail = `Gudang: ${doc.metadata?.warehouse || 'Gudang Utama'}<br/>Diterima oleh: ${doc.metadata?.receivedBy || 'Tim Gudang'}${doc.metadata?.supplierDo ? `<br/>DO Supplier: ${escapeHtml(doc.metadata.supplierDo)}` : ''}`;
  const notesText = doc.notes || 'Catatan: Tim gudang harus memverifikasi jumlah dan kesesuaian SKU barang sebelum stok dimasukkan.';

  // Single continuous flow: the browser's native page-break handles pagination
  // (see `tbody tr { page-break-inside: avoid }` / `thead { display: table-header-group }`),
  // so item count no longer needs to be estimated/chunked manually.
  let html = headerHtml(companyName, companyDetail, title, docNumber, date, settings);
  html += `<section class="top-grid">
  <div class="box">
    <div class="label">Supplier</div>
    <div class="strong">${escapeHtml(customerName)}</div>
    <div class="muted">${customerDetail}</div>
  </div>
  <div class="box">
    <div class="label">Info Penerimaan</div>
    <div class="muted">${infoDetail}</div>
  </div>
</section>`;
  html += `<table>
  <thead>
    <tr><th>Barang Diterima</th><th class="right">Jumlah Diterima</th></tr>
  </thead>
  <tbody>
    ${groupedItems.map(renderRow).join('\n    ')}
  </tbody>
</table>`;
  html += `<section class="bottom" style="margin-top: 4px;">
  <div class="notes-column" style="width: 100%;">
    <div class="total-qty" style="padding: 2.5px 8px; margin-bottom: 3px; font-size: 12px;">Total Jumlah: <span>${escapeHtml(totalLusinPcs)}</span></div>
    <div class="notes" style="padding: 3px 8px; font-size: 11px; line-height: 1.25;"><span class="label" style="font-size: 11px; margin-bottom: 1px;">Catatan</span>${escapeHtml(notesText)}</div>
  </div>
  <div class="goodsout-signatures" style="width: 100%; margin-top: 14px;">
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">Diterima Oleh</div>
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">Diperiksa Oleh</div>
  </div>
</section>`;

  return [html];
}

function goodsOutPagesCompact(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date) {
  const title = settings?.documents?.goodsOutTitle || (doc.document_type === 'delivery_note' ? 'Surat Jalan' : 'Surat Jalan / Goods Out');
  const rawItems = doc.items || doc.metadata?.items || [];
  const groupedItems = getGroupedProductItems(rawItems, doc, settings?.custom_units || settings?.customUnits);

  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const grandReturnedLusin = groupedItems.reduce((sum, g) => sum + (g.returnedLusin || 0), 0);
  const grandReturnedPcsOnly = groupedItems.reduce((sum, g) => sum + (g.returnedPcsOnly || 0), 0);
  const totalReturnedLusinPcs = formatDocumentQty(grandReturnedLusin, grandReturnedPcsOnly);

  const grandNetLusin = groupedItems.reduce((sum, g) => sum + (g.netLusin || 0), 0);
  const grandNetPcsOnly = groupedItems.reduce((sum, g) => sum + (g.netPcsOnly || 0), 0);
  const totalNetLusinPcs = formatDocumentQty(grandNetLusin, grandNetPcsOnly);

  const activeReturns = Array.isArray(doc.metadata?.returns)
    ? doc.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];
  const hasReturns = activeReturns.length > 0;
  const isFullReturn = hasReturns && (grandNetLusin <= 0 && grandNetPcsOnly <= 0);

  const returnBadgeHtml = isFullReturn
    ? `<span class="return-status-tag">DIRETUR TOTAL</span>`
    : (hasReturns ? `<span class="return-status-tag return-status-tag--partial">DIRETUR SEBAGIAN</span>` : '');

  const renderRow = (g) => {
    const name = escapeHtml(g.name);
    let skuHtml = '';
    if (g.sku && g.sku !== '—' && g.sku !== '-') {
      skuHtml = `<div class="muted" style="font-size: 9.5px; font-weight: normal; margin-top: 1px; line-height: 1.2;">SKU: ${escapeHtml(g.sku)}</div>`;
    }
    let serialHtml = '';
    if (g.serials && g.serials.length > 0) {
      const serialTokens = g.serials.map((s) => {
        const isRet = Array.isArray(g.returnedSerials) && g.returnedSerials.includes(s);
        if (isRet) {
          return `<span style="color: #dc2626; text-decoration: line-through;">${escapeHtml(s)}</span> <span style="color: #dc2626; font-size: 8px; font-weight: 700; border: 0.5px solid #dc2626; padding: 0 2px;">RETUR</span>`;
        }
        return `<span>${escapeHtml(s)}</span>`;
      });
      serialHtml = `<div class="compact-serials" style="font-size: 8.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-weight: 500; margin-top: 2px; color: #111827; word-break: break-all; line-height: 1.3;"><span style="font-weight: 700; font-size: 9px; color: #000;">No. Seri (${g.serials.length}):</span> ${serialTokens.join(', ')}</div>`;
    }
    const nameHtml = `<div style="font-weight: 700; font-size: 11.5px; line-height: 1.25;">${name}</div>${skuHtml}${serialHtml}`;

    let breakdownHtml = '';
    if (g.breakdown) {
      breakdownHtml = `<div class="muted" style="font-size: 9.5px; font-weight: normal; margin-top: 1px; line-height: 1.2;">(${escapeHtml(g.breakdown)})</div>`;
    }

    let qtyHtml = '';
    if (g.hasReturns) {
      qtyHtml = `
        <div style="font-weight: 700; font-size: 11.5px;">${escapeHtml(g.formattedQty)}</div>
        <div style="color: #dc2626; font-size: 9px; font-weight: 700; margin-top: 1px;">Diretur: -${escapeHtml(g.returnedFormattedQty)}</div>
        <div style="color: #16a34a; font-size: 10px; font-weight: 800; margin-top: 1px;">Net: ${escapeHtml(g.netFormattedQty)}</div>
      `;
    } else {
      qtyHtml = `<div style="font-weight: 700; font-size: 11.5px;">${escapeHtml(g.formattedQty)}</div>${breakdownHtml}`;
    }

    return `<tr><td>${nameHtml}</td><td>${qtyHtml}</td><td class="right">${escapeHtml(g.purpose || 'Pesanan')}</td></tr>`;
  };

  const warehouse = doc.metadata?.warehouse || 'Gudang Utama';
  const releasedBy = doc.metadata?.releasedBy || 'Tim Gudang';
  const courier = doc.metadata?.courier || doc.metadata?.driver || '';
  const infoDetail = `Gudang: ${escapeHtml(warehouse)}<br/>Dikeluarkan oleh: ${escapeHtml(releasedBy)}${courier ? `<br/>Kurir: ${escapeHtml(courier)}` : ''}`;
  const notesText = doc.notes || 'Barang telah diperiksa dan diserahkan dalam keadaan baik, lengkap, serta sesuai dengan rincian di atas.';

  let returnHistoryBoxCompact = '';
  if (hasReturns) {
    const listHtml = activeReturns.map((r) => {
      const retNum = r.returnNumber || 'RET-DOKUMEN';
      const retDate = formatDate(r.returnedAt || r.date);
      const retReason = r.reason ? ` - ${escapeHtml(r.reason)}` : '';
      return `<div>&bull; <strong>${escapeHtml(retNum)}</strong> (${escapeHtml(retDate)})${retReason}</div>`;
    }).join('');
    returnHistoryBoxCompact = `
      <div style="padding: 3px 6px; border: 1px dashed #d97706; background: #fffbeb; font-size: 9.5px; color: #92400e; margin-bottom: 3px; line-height: 1.3;">
        <strong>RIWAYAT RETUR:</strong>
        ${listHtml}
      </div>
    `;
  }

  let html = headerHtml(companyName, companyDetail, `${title} ${returnBadgeHtml}`, docNumber, date, settings);
  html += `<section class="top-grid">
  <div class="box">
    <div class="label">Kepada Yth.</div>
    <div class="strong">${escapeHtml(customerName)}</div>
    <div class="muted">${customerDetail}</div>
  </div>
  <div class="box">
    <div class="label">Info Pengeluaran</div>
    <div class="muted">${infoDetail}</div>
  </div>
</section>`;
  html += `<table>
  <thead>
    <tr><th>Barang Dikirim</th><th>Jumlah</th><th class="right">Keterangan</th></tr>
  </thead>
  <tbody>
    ${groupedItems.map(renderRow).join('\n    ')}
  </tbody>
</table>`;
  html += `<section class="bottom" style="margin-top: 4px;">
  <div class="notes-column" style="width: 100%;">
    <div class="total-qty" style="padding: 2.5px 8px; margin-bottom: 3px; font-size: 11.5px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px;">
      <span>Total Awal: <strong>${escapeHtml(totalLusinPcs)}</strong></span>
      ${hasReturns ? `<span style="color: #dc2626;">Diretur: <strong>-${escapeHtml(totalReturnedLusinPcs)}</strong></span><span style="color: #16a34a;">Net Terkirim: <strong>${escapeHtml(totalNetLusinPcs)}</strong></span>` : ''}
    </div>
    ${returnHistoryBoxCompact}
    <div class="notes" style="padding: 3px 8px; font-size: 11px; line-height: 1.25;"><span class="label" style="font-size: 11px; margin-bottom: 1px;">Catatan</span>${escapeHtml(notesText)}</div>
  </div>
  <div class="goodsout-signatures" style="width: 100%; margin-top: 14px;">
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">Penerima</div>
    <div class="line" style="min-height: 38px; padding-bottom: 22px;">Hormat Kami</div>
  </div>
</section>`;

  return [html];
}

function goodsOutPages(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date) {
  const title = settings?.documents?.goodsOutTitle || (doc.document_type === 'delivery_note' ? 'Surat Jalan' : 'Surat Jalan / Goods Out');
  const rawItems = doc.items || doc.metadata?.items || [];
  const groupedItems = getGroupedProductItems(rawItems, doc, settings?.custom_units || settings?.customUnits);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const grandReturnedLusin = groupedItems.reduce((sum, g) => sum + (g.returnedLusin || 0), 0);
  const grandReturnedPcsOnly = groupedItems.reduce((sum, g) => sum + (g.returnedPcsOnly || 0), 0);
  const totalReturnedLusinPcs = formatDocumentQty(grandReturnedLusin, grandReturnedPcsOnly);

  const grandNetLusin = groupedItems.reduce((sum, g) => sum + (g.netLusin || 0), 0);
  const grandNetPcsOnly = groupedItems.reduce((sum, g) => sum + (g.netPcsOnly || 0), 0);
  const totalNetLusinPcs = formatDocumentQty(grandNetLusin, grandNetPcsOnly);

  const activeReturns = Array.isArray(doc.metadata?.returns)
    ? doc.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];
  const hasReturns = activeReturns.length > 0;
  const isFullReturn = hasReturns && (grandNetLusin <= 0 && grandNetPcsOnly <= 0);

  // Group total summary text
  const unitTotals = {};
  groupedItems.forEach((g) => {
    Object.entries(g.unitCounts || {}).forEach(([u, q]) => {
      unitTotals[u] = (unitTotals[u] || 0) + q;
    });
  });
  const unitSummary = Object.entries(unitTotals).map(([u, q]) => `${q} ${u}`).join(', ');

  const warehouse = doc.metadata?.warehouse || 'Gudang Utama';
  const releasedBy = doc.metadata?.releasedBy || 'Tim Gudang';
  const courier = doc.metadata?.courier || doc.metadata?.driver || '';
  const poRef = doc.metadata?.poNumber || doc.po_number || doc.metadata?.reference || '';

  const notesText = doc.notes || 'Barang telah diperiksa dan diserahkan dalam keadaan baik, lengkap, serta sesuai dengan rincian di atas.';

  let returnHistorySummaryHtml = '';
  if (hasReturns) {
    const listHtml = activeReturns.map((r) => {
      const retNum = r.returnNumber || 'RET-DOKUMEN';
      const retDate = formatDate(r.returnedAt || r.date);
      const retReason = r.reason ? ` - Alasan: ${escapeHtml(r.reason)}` : '';
      const retNotes = r.notes ? ` (${escapeHtml(r.notes)})` : '';
      const retItemsSummary = (r.items || []).map((it) => `${it.returnedQty || 1} ${it.qtyUnit || 'pcs'} ${escapeHtml(it.productName || it.name || '')}`).join(', ');
      return `<div style="margin-top: 3px;">&bull; <strong>${escapeHtml(retNum)}</strong> (${escapeHtml(retDate)})${retReason}${retNotes}${retItemsSummary ? `: ${retItemsSummary}` : ''}</div>`;
    }).join('');
    returnHistorySummaryHtml = `
      <div class="a4-return-notes-box">
        <strong>RIWAYAT RETUR BARANG:</strong>
        ${listHtml}
      </div>
    `;
  }

  // Pagination for A4: allows ~12 items on first page, ~18 on next pages
  const getItemWeightA4 = (g) => {
    let w = 1.0;
    if (g.serials && g.serials.length > 0) {
      w += Math.ceil(g.serials.length / 5) * 0.35;
    }
    if (g.name && g.name.length > 40) w += 0.25;
    if (g.hasReturns) w += 0.35;
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
      const name = escapeHtml(g.name);
      const sku = g.sku && g.sku !== '—' && g.sku !== '-' ? escapeHtml(g.sku) : '—';

      let serialsHtml = '';
      if (g.serials && g.serials.length > 0) {
        const serialTokens = g.serials.map((s) => {
          const isRet = Array.isArray(g.returnedSerials) && g.returnedSerials.includes(s);
          if (isRet) {
            return `<span class="a4-serial-returned">${escapeHtml(s)}</span> <span class="a4-serial-returned-tag">RETUR</span>`;
          }
          return `<span>${escapeHtml(s)}</span>`;
        });
        serialsHtml = `
          <div class="a4-serial-box">
            <span class="a4-serial-tag">No. Seri (${g.serials.length}):</span>
            <span class="a4-serial-list">${serialTokens.join(', ')}</span>
          </div>
        `;
      }

      const breakdownHtml = g.breakdown ? `<div class="a4-qty-breakdown">(${escapeHtml(g.breakdown)})</div>` : '';

      let qtyCellHtml = '';
      if (g.hasReturns) {
        qtyCellHtml = `
          <div class="a4-qty-main">${escapeHtml(g.formattedQty)}</div>
          <div style="font-size: 10px; color: #dc2626; font-weight: 700; margin-top: 2px;">Diretur: -${escapeHtml(g.returnedFormattedQty)}</div>
          <div style="font-size: 10.5px; color: #16a34a; font-weight: 800; margin-top: 2px;">Net: ${escapeHtml(g.netFormattedQty)}</div>
        `;
      } else {
        qtyCellHtml = `
          <div class="a4-qty-main">${escapeHtml(g.formattedQty)}</div>
          ${breakdownHtml}
        `;
      }

      return `
        <tr>
          <td class="a4-col-no">${rowIdx}</td>
          <td class="a4-col-sku">${sku}</td>
          <td class="a4-col-name">
            <div class="a4-item-title">${name}</div>
            ${serialsHtml}
          </td>
          <td class="a4-col-qty">
            ${qtyCellHtml}
          </td>
          <td class="a4-col-purpose">${escapeHtml(g.purpose || 'Pesanan')}</td>
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
            <div class="a4-doc-num">${escapeHtml(docNumber || '—')}</div>
            <div class="a4-doc-date">Tanggal: <strong>${escapeHtml(date)}</strong></div>
            ${hasReturns ? `<div class="a4-return-status-badge ${isFullReturn ? '' : 'a4-return-status-badge--partial'}">STATUS: ${isFullReturn ? 'DIRETUR TOTAL' : 'DIRETUR SEBAGIAN'}</div>` : ''}
          </div>
        </header>

        <section class="a4-info-grid">
          <div class="a4-info-card">
            <div class="a4-card-title">PENERIMA / TUJUAN PENGIRIMAN</div>
            <div class="a4-card-name">${escapeHtml(customerName)}</div>
            <div class="a4-card-desc">${customerDetail || '—'}</div>
          </div>
          <div class="a4-info-card">
            <div class="a4-card-title">INFORMASI PENGELUARAN / GUDANG</div>
            <div class="a4-card-content">
              <div><span class="a4-info-label">Gudang Asal:</span> <strong>${escapeHtml(warehouse)}</strong></div>
              <div><span class="a4-info-label">Dikeluarkan Oleh:</span> <strong>${escapeHtml(releasedBy)}</strong></div>
              ${courier ? `<div><span class="a4-info-label">Pengirim / Kurir:</span> <strong>${escapeHtml(courier)}</strong></div>` : ''}
              ${poRef ? `<div><span class="a4-info-label">No. Referensi / PO:</span> <strong>${escapeHtml(poRef)}</strong></div>` : ''}
            </div>
          </div>
        </section>
      `;
    } else {
      html += `
        <header class="a4-continued-header">
          <div class="a4-cont-left">
            <strong>${escapeHtml(companyName)}</strong> &middot; <span>${escapeHtml(title)}: ${escapeHtml(docNumber)}</span>
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
            <th class="a4-th-name">Nama Barang & Nomor Seri</th>
            <th class="a4-th-qty">Jumlah</th>
            <th class="a4-th-purpose">Keterangan</th>
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
              <div class="a4-notes-label">CATATAN PENGIRIMAN:</div>
              <div class="a4-notes-text">${escapeHtml(notesText)}</div>
              ${returnHistorySummaryHtml}
            </div>
            <div class="a4-total-box">
              <div class="a4-total-row">
                <span>Total Barang:</span>
                <strong>${groupedItems.length} Item Produk</strong>
              </div>
              <div class="a4-total-row ${hasReturns ? '' : 'a4-total-highlight'}">
                <span>Total Kuantitas Awal:</span>
                <strong>${escapeHtml(totalLusinPcs)}</strong>
              </div>
              ${hasReturns ? `
                <div class="a4-total-row" style="color: #dc2626;">
                  <span>Total Diretur:</span>
                  <strong>-${escapeHtml(totalReturnedLusinPcs)}</strong>
                </div>
                <div class="a4-total-row a4-total-highlight" style="color: #16a34a;">
                  <span>Net Terkirim:</span>
                  <strong>${escapeHtml(totalNetLusinPcs)}</strong>
                </div>
              ` : ''}
              ${unitSummary ? `<div class="a4-total-detail">(${escapeHtml(unitSummary)})</div>` : ''}
            </div>
          </div>

          <div class="a4-signatures">
            <div class="a4-sign-box">
              <div class="a4-sign-role">Penerima / Customer</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ____________________ )</div>
              <div class="a4-sign-sub">Tanda Tangan & Cap Toko</div>
            </div>
            <div class="a4-sign-box">
              <div class="a4-sign-role">Pengirim / Sopir / Ekspedisi</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ____________________ )</div>
              <div class="a4-sign-sub">Nama Jelas & No. Kendaraan</div>
            </div>
            <div class="a4-sign-box">
              <div class="a4-sign-role">Petugas Gudang / Hormat Kami</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ${escapeHtml(releasedBy)} )</div>
              <div class="a4-sign-sub">Dikeluarkan Oleh</div>
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

function goodsInPagesA4(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date) {
  const title = settings?.documents?.goodsInTitle || 'Barang Masuk';
  const rawItems = doc.items || doc.metadata?.items || [];
  const groupedItems = getGroupedProductItems(rawItems, doc, settings?.custom_units || settings?.customUnits);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const unitTotals = {};
  groupedItems.forEach((g) => {
    Object.entries(g.unitCounts || {}).forEach(([u, q]) => {
      unitTotals[u] = (unitTotals[u] || 0) + q;
    });
  });
  const unitSummary = Object.entries(unitTotals).map(([u, q]) => `${q} ${u}`).join(', ');

  const warehouse = doc.metadata?.warehouse || 'Gudang Utama';
  const receivedBy = doc.metadata?.receivedBy || 'Tim Gudang';
  const supplierDo = doc.metadata?.supplierDo || '';

  const notesText = doc.notes || 'Catatan: Tim gudang harus memverifikasi jumlah dan kesesuaian SKU barang sebelum stok dimasukkan.';

  // Pagination for A4: goods_in table has only 4 columns (no keterangan), so rows are
  // shorter than goods_out — allow noticeably more items per page before breaking.
  // ~1 row (single-line name) ≈ 38px; usable table height ≈ 570px (first page, with
  // header/info-grid/bottom-section) / ≈ 850px (continuation pages, header only).
  const getItemWeightA4 = (g) => {
    let w = 1.0;
    if (g.serials && g.serials.length > 0) {
      w += Math.ceil(g.serials.length / 8) * 0.35;
    }
    if (g.name && g.name.length > 55) w += 0.5;
    return w;
  };

  const chunks = [];
  let currentChunk = [];
  let currentWeight = 0;
  const maxWeightFirstPage = 15.0;
  const maxWeightNextPage = 22.0;

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
      const name = escapeHtml(g.name);
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

      const breakdownHtml = g.breakdown ? `<div class="a4-qty-breakdown">(${escapeHtml(g.breakdown)})</div>` : '';

      return `
        <tr>
          <td class="a4-col-no">${rowIdx}</td>
          <td class="a4-col-sku">${sku}</td>
          <td class="a4-col-name a4-col-name--wide">
            <div class="a4-item-title">${name}</div>
            ${serialsHtml}
          </td>
          <td class="a4-col-qty a4-col-qty--wide">
            <div class="a4-qty-main">${escapeHtml(g.formattedQty)}</div>
            ${breakdownHtml}
          </td>
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
            <div class="a4-doc-num">${escapeHtml(docNumber || '—')}</div>
            <div class="a4-doc-date">Tanggal: <strong>${escapeHtml(date)}</strong></div>
          </div>
        </header>

        <section class="a4-info-grid">
          <div class="a4-info-card">
            <div class="a4-card-title">SUPPLIER / SUMBER BARANG</div>
            <div class="a4-card-name">${escapeHtml(customerName)}</div>
            <div class="a4-card-desc">${customerDetail || '—'}</div>
          </div>
          <div class="a4-info-card">
            <div class="a4-card-title">INFORMASI PENERIMAAN</div>
            <div class="a4-card-content">
              <div><span class="a4-info-label">Gudang Tujuan:</span> <strong>${escapeHtml(warehouse)}</strong></div>
              <div><span class="a4-info-label">Diterima Oleh:</span> <strong>${escapeHtml(receivedBy)}</strong></div>
              ${supplierDo ? `<div><span class="a4-info-label">DO Supplier:</span> <strong>${escapeHtml(supplierDo)}</strong></div>` : ''}
            </div>
          </div>
        </section>
      `;
    } else {
      html += `
        <header class="a4-continued-header">
          <div class="a4-cont-left">
            <strong>${escapeHtml(companyName)}</strong> &middot; <span>${escapeHtml(title)}: ${escapeHtml(docNumber)}</span>
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
            <th class="a4-th-name a4-th-name--wide">Nama Barang & Nomor Seri</th>
            <th class="a4-th-qty a4-th-qty--wide">Jumlah Diterima</th>
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
              <div class="a4-notes-text">${escapeHtml(notesText)}</div>
            </div>
            <div class="a4-total-box">
              <div class="a4-total-row">
                <span>Total Barang:</span>
                <strong>${groupedItems.length} Item Produk</strong>
              </div>
              <div class="a4-total-row a4-total-highlight">
                <span>Total Kuantitas:</span>
                <strong>${escapeHtml(totalLusinPcs)}</strong>
              </div>
              ${unitSummary ? `<div class="a4-total-detail">(${escapeHtml(unitSummary)})</div>` : ''}
            </div>
          </div>

          <div class="a4-signatures a4-signatures--two">
            <div class="a4-sign-box">
              <div class="a4-sign-role">Pengirim / Supplier</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ____________________ )</div>
              <div class="a4-sign-sub">Tanda Tangan & Nama Jelas</div>
            </div>
            <div class="a4-sign-box">
              <div class="a4-sign-role">Petugas Gudang</div>
              <div class="a4-sign-space"></div>
              <div class="a4-sign-line">( ${escapeHtml(receivedBy)} )</div>
              <div class="a4-sign-sub">Diterima & Diperiksa Oleh</div>
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

export const PAPER_SIZES = [
  { id: '21x12', label: 'Kertas PO', width: '21cm', height: '12cm', desc: '21cm × 12cm' },
  { id: '21.5x12', label: 'Kertas baru', width: '21.5cm', height: '12cm', desc: '21,5cm × 12cm' },
  { id: '24x12', label: 'Kertas lama', width: '24cm', height: '12cm', desc: '24cm × 12cm' },
  { id: 'a4', label: 'Kertas A4', width: '21cm', height: '29.7cm', desc: 'A4 Portrait (21cm × 29.7cm)' },
];

// Opsi cetak khusus untuk Goods In / Goods Out: Rangkap (kertas kontinyu kecil) atau A4.
export const GOODS_PRINT_MODES = [
  { id: 'compact', label: 'Rangkap', desc: 'Kertas kontinyu 21cm × 12cm' },
  { id: 'a4', label: 'Kertas A4', desc: 'A4 Portrait (21cm × 29.7cm)' },
];

const GOODS_COMPACT_PAPER = { id: '21x12', label: 'Rangkap', width: '21cm', height: '12cm', desc: '21cm × 12cm' };
const GOODS_A4_PAPER = PAPER_SIZES.find((p) => p.id === 'a4');

export function generateDocumentHtml(doc, settings, contact, paperSize, paperMode) {
  const docTypeRaw = doc.document_type || 'invoice';
  const isGoodsOutType = docTypeRaw === 'goods_out' || docTypeRaw === 'delivery_note';
  const isGoodsDoc = docTypeRaw === 'goods_in' || isGoodsOutType;
  // Bila paperMode tidak diberikan secara eksplisit oleh caller, pertahankan perilaku lama:
  // goods_out default ke A4, goods_in default ke rangkap (compact).
  const resolvedGoodsMode = paperMode ? (paperMode === 'a4' ? 'a4' : 'compact') : (isGoodsOutType ? 'a4' : 'compact');
  const isA4Layout = isGoodsDoc && resolvedGoodsMode === 'a4';
  const defaultPs = isGoodsDoc ? (resolvedGoodsMode === 'a4' ? GOODS_A4_PAPER : GOODS_COMPACT_PAPER) : PAPER_SIZES[0];
  const ps = isGoodsDoc
    ? defaultPs
    : (typeof paperSize === 'object' && paperSize ? paperSize : defaultPs);
  const companyName = preferDefined(settings?.company?.companyName, settings?.company?.name, settings?.companyName, 'Hoga Baby | Puffy | Gentle love');
  const companyEmail = preferDefined(settings?.company?.companyEmail, settings?.company?.email, settings?.email, 'Hoga.finance@gmail.com');
  const companyPhone = preferDefined(settings?.company?.companyPhone, settings?.company?.phone, settings?.phone, '');
  const companyAddress = preferDefined(settings?.company?.companyAddress, settings?.company?.address, settings?.address, '');
  const companyCity = preferDefined(settings?.company?.companyCity, settings?.company?.city, settings?.city, '');
  const addressLine = [companyAddress, companyCity].filter((v) => String(v ?? '').trim()).join(', ');
  const contactLine = [companyEmail, companyPhone].filter((v) => String(v ?? '').trim()).join(' \u00b7 ');
  const companyDetail = [addressLine, contactLine].filter(Boolean).join('<br/>');

  const customerName = doc.contact_name || doc.customer || 'Customer';
  const addrParts = [
    contact?.address || doc.address || doc.metadata?.address || doc.metadata?.customer_address || '',
    contact?.city || doc.city || doc.metadata?.city || '',
    contact?.province || doc.province || doc.metadata?.province || '',
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
  const customerAddress = addrParts.join(', ');
  const customerPhone = contact?.phone || doc.phone || doc.metadata?.phone || doc.metadata?.customer_phone || '';

  const customerLines = [];
  if (customerAddress) customerLines.push(customerAddress);
  if (customerPhone) customerLines.push(`Telp: ${customerPhone}`);
  const customerDetail = customerLines.map(escapeHtml).join('<br/>');
  const docNumber = doc.document_number || doc.number || '';
  const date = formatDate(doc.issue_date || doc.date || '');

  const docType = doc.document_type || 'invoice';
  let pages;
  if (docType === 'goods_in') {
    pages = resolvedGoodsMode === 'a4'
      ? goodsInPagesA4(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date)
      : goodsInPagesCompact(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date);
  } else if (docType === 'goods_out' || docType === 'delivery_note') {
    pages = resolvedGoodsMode === 'a4'
      ? goodsOutPages(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date)
      : goodsOutPagesCompact(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date);
  } else {
    pages = invoicePages(doc, settings, contact, companyName, companyDetail, customerName, customerDetail, docNumber, date);
  }

  const pageContainerClass = isA4Layout ? 'page page-goodsout-a4' : 'page';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=794, initial-scale=1" />
  <title>${companyName} - ${docNumber}</title>
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
      padding: 5px 16px;
      background: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }

    /* Standard Continuous Layout Styles (Invoice, etc) */
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
    .doc-title h1 { margin: 0; font-size: 26px; }
    .top-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; margin-top: 2px; border-bottom: 0.5px solid #000; padding-bottom: 3px; }
    .box { border: 0; border-radius: 0; padding: 0; }
    .label { font-size: 11.5px; line-height: 1.25; color: #000; font-weight: 600; margin-bottom: 2px; }
    .notice-label { color: #000; }
    .strong { font-weight: 600; font-size: 11.5px; line-height: 1.25; }
    .page-continued-header { display: flex; justify-content: space-between; align-items: center; padding: 3px 0 2px; border-bottom: 0.5px solid #000; margin-bottom: 2px; font-size: 11px; font-weight: 700; color: #000; }
    .continued-left { display: flex; align-items: center; gap: 6px; }
    .continued-brand { font-weight: 800; font-size: 11px; }
    .continued-sep { color: #555; font-size: 10px; }
    .continued-title { font-weight: 700; font-size: 11px; }
    .continued-number { font-weight: 600; font-size: 11px; color: #111; }
    .continued-right { font-size: 10.5px; font-weight: 700; color: #000; white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; margin-top: 1px; font-size: 11.5px; }
    thead { display: table-header-group; }
    tbody tr { page-break-inside: avoid; break-inside: avoid; }
    th { text-align: left; color: #000; border-bottom: 0; padding: 2px 6px 1px 6px; font-size: 11.5px; font-weight: 600; line-height: 1.25; }
    td { border-bottom: 0; padding: 1.5px 6px 1.5px 6px; line-height: 1.25; font-weight: 600; color: #000; vertical-align: top; }
    .right { text-align: right; }
    .bottom { display: grid; grid-template-columns: minmax(0,1fr) 310px; row-gap: 3px; column-gap: 24px; margin-top: 3px; align-items: start; page-break-inside: avoid; break-inside: avoid; }
    .totals { font-size: 11.5px; line-height: 1.25; font-weight: 600; }
    .total-row { display: flex; justify-content: space-between; padding: 1.5px 0; line-height: 1.25; font-weight: 600; }
    .grand { border-top: 1px solid #000; margin-top: 2px; padding-top: 2px; font-size: 11.5px; font-weight: 600; }
    .total-qty { display: flex; justify-content: space-between; align-items: center; padding: 2px 8px; border: 0.5px solid #000; border-radius: 0; margin-bottom: 3px; font-size: 12px; font-weight: 700; }
    .notes { padding: 3px 8px; border: 0.5px solid #000; border-radius: 0; background: #fff; color: #000; font-size: 11px; line-height: 1.25; font-weight: 600; letter-spacing: 0; }
    .notes .label { display: block; font-size: 11px; line-height: 1.25; font-weight: 600; margin: 0 0 1px; }
    .signature { display: grid; grid-template-columns: 1fr; gap: 40px; margin-top: 16px; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
    .totals-signature { display: flex; justify-content: flex-end; margin-top: 0; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
    .invoice-bottom { grid-template-areas: "notes totals" "left right"; }
    .invoice-bottom .notes-column { grid-area: notes; }
    .invoice-bottom .totals { grid-area: totals; }
    .signature-left { grid-area: left; margin-top: 0; }
    .signature-right { grid-area: right; }
    .line { width: 150px; min-height: 38px; padding-bottom: 22px; border-bottom: 0.5px solid #000; border-top: 0; padding-top: 0; text-align: center; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
    .signature-left .line, .totals-signature .line { border: 0; }
    .signature .line:first-child { justify-self: start; }
    .signature .line:last-child { justify-self: start; }
    .totals-signature .line { width: 150px; }
    .goodsout-signatures { display: flex; justify-content: space-between; margin-top: 14px; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
    .goodsout-signatures .line { width: 150px; min-height: 38px; padding-bottom: 22px; text-align: center; font-size: 11.5px; line-height: 1.2; font-weight: 600; }
    .page-spacer { padding: 4px 0 2px; border-bottom: 0.5px solid #000; margin-bottom: 2px; min-height: 30px; }
    .page-num { text-align: right; font-size: 10px; color: #000; font-weight: 600; margin-top: 2px; }

    .return-status-tag {
      display: inline-block;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 800;
      border: 1.5px solid #dc2626;
      color: #dc2626;
      border-radius: 2px;
      margin-left: 6px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      vertical-align: middle;
    }
    .return-status-tag--partial {
      border-color: #d97706;
      color: #b45309;
    }
    .a4-return-status-badge {
      display: inline-block;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      border: 1.5px solid #dc2626;
      color: #dc2626;
      margin-top: 4px;
      text-transform: uppercase;
      border-radius: 2px;
    }
    .a4-return-status-badge--partial {
      border-color: #d97706;
      color: #b45309;
    }
    .a4-serial-returned {
      color: #dc2626;
      text-decoration: line-through;
    }
    .a4-serial-returned-tag {
      display: inline-block;
      font-size: 8px;
      font-weight: 700;
      color: #dc2626;
      border: 1px solid #dc2626;
      padding: 0 3px;
      margin-left: 2px;
      border-radius: 2px;
      vertical-align: middle;
    }
    .a4-return-notes-box {
      margin-top: 8px;
      padding: 6px 10px;
      border: 1px dashed #d97706;
      background: #fffbeb;
      font-size: 10px;
      line-height: 1.35;
      color: #92400e;
    }

    /* ======================================================== */
    /* SPECIFIC CLEAN MONOCHROME A4 SURAT JALAN STYLES          */
    /* ======================================================== */
    .page-goodsout-a4 {
      width: 794px;
      min-width: 794px;
      max-width: 794px;
      min-height: 1120px;
      margin: 0 auto 24px auto;
      padding: 34px 40px;
      background: #ffffff;
      color: #000000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
      border-radius: 4px;
    }
    .a4-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #000000;
      padding-bottom: 8px;
      margin-bottom: 10px;
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
      font-size: 19px;
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
    .a4-th-name { width: 44%; text-align: left; }
    .a4-th-qty { width: 18%; text-align: right; }
    .a4-th-purpose { width: 16%; text-align: right; }
    .a4-th-name--wide { width: 55%; }
    .a4-th-qty--wide { width: 23%; }

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
    .a4-qty-breakdown { font-size: 10.5px; color: #000000; margin-top: 2px; font-weight: 600; }
    .a4-col-purpose { text-align: right; font-weight: 600; font-size: 11.5px; color: #000000; }
    .a4-col-name--wide .a4-item-title { font-size: 13px; }
    .a4-col-qty--wide .a4-qty-main { font-size: 13.5px; }

    .a4-bottom-section {
      margin-top: 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .a4-summary-grid {
      display: grid;
      grid-template-columns: 1.35fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }
    .a4-notes-box {
      border: 1px solid #000000;
      border-radius: 0;
      padding: 9px 12px;
      background: #ffffff;
    }
    .a4-notes-label {
      font-size: 10px;
      font-weight: 800;
      color: #000000;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 4px;
    }
    .a4-notes-text {
      font-size: 11.5px;
      color: #000000;
      line-height: 1.45;
      font-weight: 600;
    }
    .a4-total-box {
      border: 1.5px solid #000000;
      border-radius: 0;
      padding: 10px 14px;
      background: #ffffff;
    }
    .a4-total-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #000000;
      font-weight: 600;
    }
    .a4-total-highlight {
      border-top: 1px dashed #000000;
      margin-top: 6px;
      padding-top: 6px;
      font-size: 14.5px;
      font-weight: 800;
      color: #000000;
    }
    .a4-total-detail {
      font-size: 11px;
      color: #000000;
      text-align: right;
      margin-top: 2px;
      font-weight: 600;
    }

    .a4-signatures {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
      text-align: center;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .a4-signatures--two {
      grid-template-columns: 1fr 1fr;
      max-width: 70%;
      margin-left: auto;
      margin-right: auto;
    }
    .a4-sign-box {
      border: 1px solid #000000;
      border-radius: 0;
      padding: 8px 10px;
      background: #ffffff;
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
        size: ${isA4Layout ? 'A4 portrait' : `${ps.width} ${ps.height}`};
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
        padding: ${isA4Layout ? '0' : '5px 16px'} !important;
        margin: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
      }
      .page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
      .page-goodsout-a4 {
        padding: 0 !important;
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
        justify-content: space-between !important;
        align-items: flex-start !important;
      }
      .brand-logos {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
      }
      .doc-title {
        text-align: right !important;
      }
      .top-grid {
        display: grid !important;
        grid-template-columns: 1.25fr 1fr !important;
        gap: 14px !important;
      }
      .bottom {
        display: grid !important;
        grid-template-columns: minmax(0,1fr) 310px !important;
        row-gap: 3px !important;
        column-gap: 24px !important;
      }
      .invoice-bottom {
        display: grid !important;
        grid-template-columns: minmax(0,1fr) 310px !important;
        grid-template-areas: "notes totals" "left right" !important;
      }
      .invoice-bottom .notes-column {
        grid-area: notes !important;
      }
      .invoice-bottom .totals {
        grid-area: totals !important;
      }
      .signature-left {
        grid-area: left !important;
      }
      .signature-right {
        grid-area: right !important;
      }
      .signature {
        display: grid !important;
        grid-template-columns: 1fr !important;
        gap: 40px !important;
      }
      .goodsout-signatures {
        display: flex !important;
        flex-direction: row !important;
        justify-content: space-between !important;
      }
      .line {
        width: 150px !important;
      }
      .goodsout-signatures .line {
        width: 150px !important;
      }
    }
  </style>
</head>
<body>
  <div class="no-print print-toolbar">
    <div class="print-toolbar-inner">
      <div class="print-toolbar-title">Pratinjau Dokumen (${escapeHtml(ps.desc || ps.label || '')})</div>
      <button type="button" class="print-btn" onclick="window.print()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
        Cetak Dokumen
      </button>
    </div>
  </div>
${pages.map((p) => `  <main class="${pageContainerClass}">
    ${p}
  </main>`).join('\n')}
</body>
</html>`;
}


import { jsPDF } from 'jspdf';
import { resolveDocumentItemQuantity } from '../utils/documentQuantity.js';

/**
 * Format tanggal ke dd-Month-yyyy (contoh: 22-July-2026)
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).replace(/ /g, '-');
  } catch {
    return String(dateStr);
  }
}

const MULTIPLIERS = {
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
  if (s.includes('bl25') || s.includes('25bl') || s.includes('bal25') || s.includes('25bal')) return 'bal25';
  if (s.includes('bl20') || s.includes('20bl') || s.includes('bal20') || s.includes('20bal')) return 'bal20';
  if (s.includes('bl15') || s.includes('15bl') || s.includes('bal15') || s.includes('15bal')) return 'bal15';
  if (s.includes('bl10') || s.includes('10bl') || s.includes('bal10') || s.includes('10bal')) return 'bal10';
  if (s.includes('bl5') || s.includes('5bl') || s.includes('bal5') || s.includes('5bal')) return 'bal5';
  if (s.includes('pack6') || s.includes('pk6') || s.includes('6pk')) return 'pack6';
  if (s.includes('pack3') || s.includes('pk3') || s.includes('3pk')) return 'pack3';
  if (s.includes('pack5') || s.includes('pk5') || s.includes('5pk')) return 'pack';
  if (s.includes('lusin') || s.includes('doz') || s.includes('-ls-') || s.includes('_ls_') || s.endsWith('-ls')) return 'lusin';
  if (s.includes('bal') || s.includes('bl')) return 'bal';
  if (s.includes('pack') || s.includes('pk')) return 'pack';
  return fallbackUnit;
}

function getUnitHelpers(customUnits) {
  const multipliers = { ...MULTIPLIERS };
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
    return `${lusin} lusin ${pcs} pcs`;
  }
  if (lusin > 0) {
    return `${lusin} lusin`;
  }
  if (pcs > 0) {
    return `${pcs} pcs`;
  }
  return '0 pcs';
}

function formatLusinPcs(totalPcs) {
  const count = Math.max(0, Math.round(totalPcs || 0));
  const lusin = Math.floor(count / 12);
  const pcs = count % 12;

  if (lusin > 0 && pcs > 0) {
    return `${lusin} lusin ${pcs} pcs`;
  }
  if (lusin > 0) {
    return `${lusin} lusin`;
  }
  return `${pcs} pcs`;
}

/**
 * Generate PDF untuk Purchase Order dengan format Kertas Kontinyu 24cm x 12cm
 * Persis seperti pratinjau dokumen di frontend (documentTemplate.js / DraftPage.jsx).
 *
 * @param {Object} po - object PO lengkap dengan items
 * @param {Object} companyInfo - info perusahaan
 * @returns {Buffer} PDF buffer
 */
export function generatePOPdf(po, companyInfo = {}) {
  // Menggunakan ukuran Kertas Continuous 210mm x 120mm (21cm x 12cm) dengan orientation landscape (Kertas PO)
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [120, 210] });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const margin = 12;

  const compName = companyInfo.companyName || 'Docuflow Company';
  const compAddr = companyInfo.companyAddress || '';
  const compPhone = companyInfo.companyPhone || '';
  const compLogo = companyInfo.companyLogo || '';

  // === 1. Header (Brand/Company on left, PO Title & Info on right) ===
  let headerTextX = margin;
  if (compLogo && compLogo.startsWith('data:image/')) {
    try {
      doc.addImage(compLogo, 'PNG', margin, 7, 16, 16);
      headerTextX = margin + 19;
    } catch (e) {
      console.error('Error adding logo to PDF:', e);
    }
  }

  // Nama Perusahaan (Bold, 13pt)
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(compName, headerTextX, 11);

  // Alamat & Kontak Perusahaan (Normal, 7.5pt)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  let currentY = 15;
  if (compAddr) {
    const lines = doc.splitTextToSize(compAddr, 105);
    lines.forEach((l) => {
      doc.text(l, headerTextX, currentY);
      currentY += 3.2;
    });
  }
  if (compPhone) {
    doc.text(`Telp: ${compPhone}`, headerTextX, currentY);
    currentY += 3.2;
  }

  // Header Kanan: Judul "Purchase Order" & Nomor/Tanggal
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Purchase Order', pageWidth - margin, 12, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const formattedDate = formatDate(po.po_date);
  doc.text(`${po.po_number ?? '-'} · ${formattedDate}`, pageWidth - margin, 17, { align: 'right' });

  // Garis Pembatas Header (Solid 0.4px)
  const headerLineY = Math.max(currentY + 1, 23);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

  // === 2. Top Grid (Kepada Yth. / Sales Person) ===
  const gridY = headerLineY + 5;

  // Sisi Kiri: Kepada Yth (Vendor Name)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Kepada Yth.', margin, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  const vendorNameStr = String(po.vendor_name ?? '-');
  doc.text(vendorNameStr, margin, gridY + 4.5);

  const vendorDetail = po.vendor_phone || po.vendor_address || '';
  if (vendorDetail) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(String(vendorDetail), margin, gridY + 8.5);
  }

  // Sisi Kanan: Sales Person
  const rightColX = 135;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Sales Person', rightColX, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(String(po.sales_person_name || po.sales_person || 'Sales Tester'), rightColX, gridY + 4.5);

  // Garis Pembatas Grid & Table (Solid 0.2px)
  const gridLineY = gridY + 11;
  doc.setLineWidth(0.2);
  doc.line(margin, gridLineY, pageWidth - margin, gridLineY);

  // === 3. Items Table ===
  let tableY = gridLineY + 2;

  const drawTableHeader = (startY) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text('Barang', margin + 2, startY + 4);
    doc.text('Qty', pageWidth - margin - 2, startY + 4, { align: 'right' });

    // Header Bottom Line
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(margin, startY + 6, pageWidth - margin, startY + 6);
  };

  drawTableHeader(tableY);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);
  let y = tableY + 11;
  const items = Array.isArray(po.items) ? po.items : [];

  const customUnits = companyInfo?.custom_units || companyInfo?.customUnits || po?.metadata?.custom_units;
  const helpers = getUnitHelpers(customUnits);
  const unitMultipliers = helpers.multipliers;

  const getItemUnit = (item) => {
    let unit = item.unit || item.metadata?.unit || 'lusin';
    const skuStr = String(item.sku ?? '');
    if (skuStr.includes('|')) unit = skuStr.split('|')[1] || unit;
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
    const unit = getItemUnit(item);
    const qty = Number(item.qty ?? item.quantity ?? 1);
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
    .join(' · ');

  const displayTotalQty = totalByUnitText || formatDocumentQty(totalLusin, totalPcsOnly);

  items.forEach((item) => {
    const name = String(item.item_name ?? item.name ?? '-');
    let sku = String(item.sku ?? '-');
    let unit = item.unit || item.metadata?.unit || 'lusin';
    if (sku.includes('|')) {
      const parts = sku.split('|');
      sku = parts[0];
      unit = parts[1] || unit;
    }
    const qtyStr = `${item.qty ?? item.quantity ?? 1} ${unit}`;

    // Fit item name within table column width
    const nameLines = doc.splitTextToSize(name, 170);
    const hasSku = sku && sku !== '-';

    const rowHeight = nameLines.length * 4 + (hasSku ? 3.5 : 0);

    // If bottom overflow, add page
    if (y + rowHeight > 88) {
      doc.addPage();
      y = 12;
      drawTableHeader(y);
      y += 11;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
    }

    // Draw Item Name (Bold)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(nameLines, margin + 2, y);

    // Draw Qty (Right Aligned)
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(qtyStr, pageWidth - margin - 2, y, { align: 'right' });

    // Draw Subtitle SKU if present
    if (hasSku) {
      const skuY = y + nameLines.length * 3.8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(80, 80, 80);
      doc.text(`SKU: ${sku}`, margin + 2, skuY);
      doc.setTextColor(0, 0, 0);
    }

    y += rowHeight + 3;
  });

  // === 4. Bottom Section (Total / Perhatian / Signatures) ===
  const fullWidth = pageWidth - 2 * margin;
  const noticeText = po.notes || 'Dokumen ini merupakan bukti Purchase Order (PO) sah tanpa nilai nominal harga.';
  const noticeLines = doc.splitTextToSize(noticeText, fullWidth - 6);
  const noticeBoxHeight = Math.max(8, noticeLines.length * 3.5 + 4.5);
  const neededHeight = 6 + 1.5 + noticeBoxHeight + 18;

  if (y + neededHeight > 115) {
    doc.addPage();
    y = 12;
  }

  const bottomY = Math.max(y + 2, 120 - margin - neededHeight);

  // 1. Box Total Jumlah (Full Width)
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(margin, bottomY, fullWidth, 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Total Jumlah:', margin + 3, bottomY + 4.2);
  doc.text(displayTotalQty, pageWidth - margin - 3, bottomY + 4.2, { align: 'right' });

  // 2. Box Catatan / PERHATIAN (Full Width)
  const noticeBoxY = bottomY + 7.5;
  doc.rect(margin, noticeBoxY, fullWidth, noticeBoxHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text(po.notes ? 'CATATAN:' : 'PERHATIAN!!!', margin + 3, noticeBoxY + 3.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(noticeLines, margin + 3, noticeBoxY + 7.2);

  // 3. Tanda Tangan Block: Penerima (Kiri) & Hormat Kami (Kanan)
  const sigY = noticeBoxY + noticeBoxHeight + 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  // Penerima (Kiri)
  doc.text('Penerima', margin + 35, sigY + 3, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.line(margin + 15, sigY + 16, margin + 55, sigY + 16);

  // Hormat Kami (Kanan)
  doc.text('Hormat Kami', pageWidth - margin - 35, sigY + 3, { align: 'center' });
  doc.line(pageWidth - margin - 55, sigY + 16, pageWidth - margin - 15, sigY + 16);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

function getGroupedProductItems(items, doc = null, customUnits = null) {
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
    const itemInfo = resolveDocumentItemQuantity(item, {
      multipliers: helpers.multipliers,
      parseSn: helpers.parseSn,
    });

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

/**
 * Generate PDF untuk Dokumen Barang Masuk (A4 Portrait seperti di Desktop)
 *
 * @param {Object} docData - object dokumen goods_in
 * @param {Object} settings - workspace settings
 * @param {Object} contact - info supplier
 * @returns {Buffer} PDF buffer
 */
export function generateGoodsInPdf(docData, settings = {}, contact = {}) {
  // Ukuran standar A4 portrait (210mm x 297mm) persis seperti pratinjau desktop
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const margin = 14;
  const contentWidth = pageWidth - 2 * margin; // 182mm

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compLogo = settings.companyLogo || settings.logoUrl || '';

  // 1. Header Left
  let headerTextX = margin;
  if (compLogo && compLogo.startsWith('data:image/')) {
    try {
      doc.addImage(compLogo, 'PNG', margin, 10, 16, 16);
      headerTextX = margin + 20;
    } catch (_) {}
  }

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(String(compName), headerTextX, 15);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  let currentY = 19.5;
  if (compAddr) {
    const lines = doc.splitTextToSize(String(compAddr), 95);
    lines.forEach((l) => {
      doc.text(l, headerTextX, currentY);
      currentY += 3.5;
    });
  }
  if (compPhone) {
    doc.text(`Telp: ${compPhone}`, headerTextX, currentY);
    currentY += 3.5;
  }

  // Right Header: Document Title & Number
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('SURAT BUKTI PENERIMAAN BARANG', pageWidth - margin, 15, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(37, 99, 235);
  doc.text(docData.document_number || '-', pageWidth - margin, 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  const docDateFormatted = formatDate(docData.issue_date || docData.created_at);
  doc.text(docDateFormatted, pageWidth - margin, 24, { align: 'right' });

  // Divider Line
  const headerLineY = Math.max(currentY + 2, 28);
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(0.5);
  doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

  // 2. Info Grid Box
  const gridY = headerLineY + 4;
  const gridHeight = 18;
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(248, 250, 252);
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, gridY, contentWidth, gridHeight, 2, 2, 'FD');

  // Supplier
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('SUPPLIER', margin + 4, gridY + 5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  const customerName = docData.contact_name || contact.name || 'Supplier';
  doc.text(String(customerName), margin + 4, gridY + 10);

  const contactPhone = contact.phone || docData.metadata?.phone || docData.phone || '';
  if (contactPhone) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`Telp: ${contactPhone}`, margin + 4, gridY + 14);
  }

  // Reception Info
  const col2X = margin + contentWidth / 2 + 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('INFO PENERIMAAN', col2X, gridY + 5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(15, 23, 42);
  const warehouse = docData.metadata?.warehouse || 'Gudang Utama';
  const receivedBy = docData.metadata?.receivedBy || 'Tim Gudang';
  doc.text(`Gudang: ${warehouse}   |   Diterima: ${receivedBy}`, col2X, gridY + 10);
  if (docData.metadata?.supplierDo) {
    doc.text(`DO Supplier: ${docData.metadata.supplierDo}`, col2X, gridY + 14);
  }

  // 3. Items Table
  const tableStartY = gridY + gridHeight + 5;
  const drawTableHeader = (startY) => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, startY, contentWidth, 7, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.rect(margin, startY, contentWidth, 7, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    doc.text('NO', margin + 3, startY + 4.8);
    doc.text('NAMA BARANG', margin + 14, startY + 4.8);
    doc.text('SKU', margin + 120, startY + 4.8);
    doc.text('JUMLAH', pageWidth - margin - 3, startY + 4.8, { align: 'right' });
  };

  drawTableHeader(tableStartY);

  let y = tableStartY + 7;
  const rawItems = Array.isArray(docData.items) ? docData.items : (docData.metadata?.items || []);
  const customUnits = settings?.custom_units || settings?.customUnits;
  const grouped = getGroupedProductItems(rawItems, docData, customUnits);
  const grandTotalLusin = grouped.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = grouped.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  grouped.forEach((g, idx) => {
    const nameLines = doc.splitTextToSize(g.name, 100);
    const hasSerials = g.serials && g.serials.length > 0;
    const serialsText = hasSerials ? `No. Seri (${g.serials.length}): ${g.serials.join(', ')}` : '';
    const serialsLines = hasSerials ? doc.splitTextToSize(serialsText, 100) : [];

    const rowHeight = Math.max(8, nameLines.length * 4 + (hasSerials ? serialsLines.length * 3 + 2 : 0) + 3);

    if (y + rowHeight > 245) {
      doc.addPage();
      y = margin;
      drawTableHeader(y);
      y += 7;
    }

    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(margin, y + rowHeight, pageWidth - margin, y + rowHeight);

    // No
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(15, 23, 42);
    doc.text(String(idx + 1), margin + 3, y + 4.5);

    // Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(nameLines, margin + 14, y + 4.5);

    let currentSubY = y + 4.5 + (nameLines.length - 1) * 4;
    if (hasSerials) {
      currentSubY += 3.5;
      doc.setFont('courier', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(71, 85, 105);
      doc.text(serialsLines, margin + 14, currentSubY);
      currentSubY += serialsLines.length * 3;
    }

    // SKU
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text(g.sku || '—', margin + 120, y + 4.5);

    // Qty
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text(g.formattedQty, pageWidth - margin - 3, y + 4.5, { align: 'right' });
    if (g.breakdown) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(`(${g.breakdown})`, pageWidth - margin - 3, y + 8, { align: 'right' });
    }

    y += rowHeight;
  });

  // Total Row
  if (y + 35 > 275) {
    doc.addPage();
    y = margin;
  }

  doc.setFillColor(248, 250, 252);
  doc.rect(margin, y + 2, contentWidth, 7, 'F');
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(0.4);
  doc.rect(margin, y + 2, contentWidth, 7, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text('TOTAL JUMLAH:', margin + 4, y + 6.8);
  doc.text(totalLusinPcs, pageWidth - margin - 4, y + 6.8, { align: 'right' });

  // Catatan
  const notesText = docData.notes || 'Catatan: Tim gudang harus memverifikasi jumlah dan kesesuaian SKU barang sebelum stok dimasukkan.';
  const notesLines = doc.splitTextToSize(notesText, contentWidth - 8);
  const notesBoxY = y + 11;
  const notesBoxH = Math.max(8, notesLines.length * 3.5 + 4);

  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(255, 255, 255);
  doc.setLineWidth(0.2);
  doc.rect(margin, notesBoxY, contentWidth, notesBoxH, 'FD');

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(notesLines, margin + 4, notesBoxY + 4.5);

  // Signatures
  const sigY = notesBoxY + notesBoxH + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);

  // Left: Penerima / Petugas Gudang
  doc.text('PENERIMA', margin + 35, sigY, { align: 'center' });
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(0.3);
  doc.line(margin + 15, sigY + 18, margin + 55, sigY + 18);

  // Right: Pengirim / Supplier
  doc.text('PENGIRIM / SUPPLIER', pageWidth - margin - 35, sigY, { align: 'center' });
  doc.line(pageWidth - margin - 55, sigY + 18, pageWidth - margin - 15, sigY + 18);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

/**
 * Generate PDF untuk Dokumen Barang Keluar / Surat Jalan Keluar (Kertas PO 21cm x 12cm Landscape)
 * Persis seperti goodsOutPages pada desktop (documentTemplate.js).
 *
 * @param {Object} docData - object dokumen goods_out / delivery_note
 * @param {Object} settings - workspace settings
 * @param {Object} contact - info kontak / customer
 * @returns {Buffer} PDF buffer
 */
export function generateGoodsOutPdf(docData, settings = {}, contact = {}) {
  // Standar A4 Portrait (210mm x 297mm) Surat Jalan
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297mm
  const margin = 14;
  const contentWidth = pageWidth - 2 * margin; // 182mm

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compCity = settings.city || settings.companyCity || settings.company?.city || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compEmail = settings.email || settings.companyEmail || settings.company?.email || '';
  const compLogo = settings.companyLogo || settings.logoUrl || '';

  const title = settings?.documents?.goodsOutTitle || (docData.document_type === 'delivery_note' ? 'SURAT JALAN' : 'SURAT JALAN / GOODS OUT');

  // Compute grouped items and active returns upfront
  const rawItems = Array.isArray(docData.items) ? docData.items : (docData.metadata?.items || []);
  const customUnits = settings?.custom_units || settings?.customUnits;
  const groupedItems = getGroupedProductItems(rawItems, docData, customUnits);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const grandReturnedLusin = groupedItems.reduce((sum, g) => sum + (g.returnedLusin || 0), 0);
  const grandReturnedPcsOnly = groupedItems.reduce((sum, g) => sum + (g.returnedPcsOnly || 0), 0);
  const totalReturnedLusinPcs = formatDocumentQty(grandReturnedLusin, grandReturnedPcsOnly);

  const grandNetLusin = groupedItems.reduce((sum, g) => sum + (g.netLusin || 0), 0);
  const grandNetPcsOnly = groupedItems.reduce((sum, g) => sum + (g.netPcsOnly || 0), 0);
  const totalNetLusinPcs = formatDocumentQty(grandNetLusin, grandNetPcsOnly);

  const activeReturns = Array.isArray(docData.metadata?.returns)
    ? docData.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];
  const hasReturns = activeReturns.length > 0;
  const isFullReturn = hasReturns && (grandNetLusin <= 0 && grandNetPcsOnly <= 0);

  const unitTotals = {};
  groupedItems.forEach((g) => {
    Object.entries(g.unitCounts || {}).forEach(([u, q]) => {
      unitTotals[u] = (unitTotals[u] || 0) + q;
    });
  });
  const unitSummary = Object.entries(unitTotals).map(([u, q]) => `${q} ${u}`).join(', ');

  // 1. Header Left
  let headerTextX = margin;
  if (compLogo && compLogo.startsWith('data:image/')) {
    try {
      doc.addImage(compLogo, 'PNG', margin, 10, 16, 16);
      headerTextX = margin + 20;
    } catch (_) {}
  }

  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(String(compName), headerTextX, 15);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  let currentY = 19.5;
  const addressLine = [compAddr, compCity].filter(Boolean).join(', ');
  if (addressLine) {
    const lines = doc.splitTextToSize(addressLine, 95);
    lines.forEach((l) => {
      doc.text(l, headerTextX, currentY);
      currentY += 3.5;
    });
  }
  const contactParts = [compEmail, compPhone].filter(Boolean).join(' · ');
  if (contactParts) {
    doc.text(contactParts, headerTextX, currentY);
    currentY += 3.5;
  }

  // Header Right (Doc title & metadata)
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(title, pageWidth - margin, 15, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(0, 0, 0);
  doc.text(String(docData.document_number ?? '-'), pageWidth - margin, 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  const docDateFormatted = formatDate(docData.issue_date || docData.created_at);
  doc.text(`Tanggal: ${docDateFormatted}`, pageWidth - margin, 24.5, { align: 'right' });

  let headerRightBottomY = 24.5;
  if (hasReturns) {
    const badgeText = isFullReturn ? 'STATUS: DIRETUR TOTAL' : 'STATUS: DIRETUR SEBAGIAN';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    const badgeW = doc.getTextWidth(badgeText) + 6;
    const badgeX = pageWidth - margin - badgeW;
    const badgeY = 26;

    if (isFullReturn) {
      doc.setFillColor(254, 242, 242);
      doc.setDrawColor(220, 38, 38);
      doc.setTextColor(220, 38, 38);
    } else {
      doc.setFillColor(255, 251, 235);
      doc.setDrawColor(217, 119, 6);
      doc.setTextColor(180, 83, 9);
    }
    doc.setLineWidth(0.3);
    doc.rect(badgeX, badgeY, badgeW, 4.8, 'FD');
    doc.text(badgeText, badgeX + 3, badgeY + 3.5);
    doc.setTextColor(0, 0, 0);
    headerRightBottomY = badgeY + 6;
  }

  // Divider Line Header
  const headerLineY = Math.max(currentY + 2, headerRightBottomY + 2, 28);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

  // 2. Info Grid (Penerima on Left, Info Pengeluaran on Right)
  const gridY = headerLineY + 4;
  const cardWidth = (contentWidth - 6) / 2; // ~88mm

  // Left Card: Penerima / Tujuan
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.rect(margin, gridY, cardWidth + 3, 24, 'D');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('PENERIMA / TUJUAN PENGIRIMAN', margin + 3.5, gridY + 4.5);

  const customerName = docData.contact_name || contact.name || 'Customer';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  doc.text(String(customerName), margin + 3.5, gridY + 9);

  const addrParts = [
    contact.address || docData.metadata?.address || docData.address || docData.metadata?.customer_address || '',
    contact.city || docData.metadata?.city || docData.city || '',
    contact.province || docData.metadata?.province || docData.province || '',
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
  const contactAddr = addrParts.join(', ');
  const contactPhone = contact.phone || docData.metadata?.phone || docData.phone || docData.metadata?.customer_phone || '';

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  let leftCardY = gridY + 13;
  if (contactAddr) {
    const addrLines = doc.splitTextToSize(String(contactAddr), cardWidth - 4);
    addrLines.slice(0, 2).forEach((l) => {
      doc.text(l, margin + 3.5, leftCardY);
      leftCardY += 3.2;
    });
  }
  if (contactPhone) {
    doc.text(`Telp: ${contactPhone}`, margin + 3.5, leftCardY);
  }

  // Right Card: Info Pengeluaran / Gudang
  const rightCardX = margin + cardWidth + 5;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.rect(rightCardX, gridY, cardWidth - 2, 24, 'D');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('INFORMASI PENGELUARAN / GUDANG', rightCardX + 3.5, gridY + 4.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);

  const warehouse = docData.metadata?.warehouse || 'Gudang Utama';
  const releasedBy = docData.metadata?.releasedBy || 'Tim Gudang';
  const courier = docData.metadata?.courier || docData.metadata?.driver || '';
  const poRef = docData.metadata?.poNumber || docData.po_number || docData.metadata?.reference || '';

  doc.text(`Gudang Asal: ${warehouse}`, rightCardX + 3.5, gridY + 9);
  doc.text(`Dikeluarkan Oleh: ${releasedBy}`, rightCardX + 3.5, gridY + 12.5);
  if (courier) {
    doc.text(`Pengirim / Kurir: ${courier}`, rightCardX + 3.5, gridY + 16);
  }
  if (poRef) {
    doc.text(`No. PO / Ref: ${poRef}`, rightCardX + 3.5, gridY + 19.5);
  }

  // 3. Grouped Items Table
  let tableY = gridY + 28;
  const drawTableHeader = (startY) => {
    doc.setFillColor(0, 0, 0);
    doc.rect(margin, startY, contentWidth, 7, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);

    doc.text('No', margin + 3, startY + 4.8);
    doc.text('Kode SKU', margin + 12, startY + 4.8);
    doc.text('Nama Barang & Nomor Seri', margin + 44, startY + 4.8);
    doc.text(hasReturns ? 'Qty (Awal/Ret/Net)' : 'Jumlah', pageWidth - margin - 35, startY + 4.8, { align: 'right' });
    doc.text('Keterangan', pageWidth - margin - 3, startY + 4.8, { align: 'right' });
  };

  drawTableHeader(tableY);

  let y = tableY + 8.5;
  let itemNum = 1;

  groupedItems.forEach((g) => {
    const skuText = (g.sku && g.sku !== '—' && g.sku !== '-') ? String(g.sku) : '-';
    const nameLines = doc.splitTextToSize(g.name, 76);
    const hasSerials = Array.isArray(g.serials) && g.serials.length > 0;
    
    let serialsText = '';
    if (hasSerials) {
      const serialTokens = g.serials.map((s) => {
        const isRet = Array.isArray(g.returnedSerials) && g.returnedSerials.includes(s);
        return isRet ? `${s} [RETUR]` : s;
      });
      serialsText = `No. Seri (${g.serials.length}): ${serialTokens.join(', ')}`;
    }
    const serialsLines = hasSerials ? doc.splitTextToSize(serialsText, 74) : [];

    const extraQtyHeight = g.hasReturns ? 9 : 0;
    const rowHeight = Math.max(
      8,
      nameLines.length * 3.6 + (hasSerials ? serialsLines.length * 2.8 + 4.5 : 0) + 2.5,
      extraQtyHeight + 4
    );

    if (y + rowHeight > pageHeight - 55) {
      doc.addPage();
      y = 15;
      drawTableHeader(y);
      y += 8.5;
    }

    // Row border line
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.15);
    doc.line(margin, y + rowHeight - 1, pageWidth - margin, y + rowHeight - 1);

    // No
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    doc.text(String(itemNum++), margin + 3, y + 3.5);

    // SKU
    doc.setFont('courier', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(0, 0, 0);
    doc.text(skuText, margin + 12, y + 3.5);

    // Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text(nameLines, margin + 44, y + 3.5);

    let subY = y + 3.5 + (nameLines.length - 1) * 3.6;

    // Serials
    if (hasSerials) {
      subY += 3.5;
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(0, 0, 0);
      doc.rect(margin + 44, subY - 2.8, 76, serialsLines.length * 2.8 + 2.5, 'D');

      doc.setFont('courier', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(0, 0, 0);
      doc.text(serialsLines, margin + 46, subY);
      subY += serialsLines.length * 2.8;
    }

    // Jumlah
    if (g.hasReturns) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(0, 0, 0);
      doc.text(g.formattedQty, pageWidth - margin - 35, y + 3.2, { align: 'right' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(220, 38, 38);
      doc.text(`-${g.returnedFormattedQty}`, pageWidth - margin - 35, y + 6.6, { align: 'right' });

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(22, 163, 74);
      doc.text(`Net: ${g.netFormattedQty}`, pageWidth - margin - 35, y + 10.2, { align: 'right' });
      doc.setTextColor(0, 0, 0);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(0, 0, 0);
      doc.text(g.formattedQty, pageWidth - margin - 35, y + 3.5, { align: 'right' });

      if (g.breakdown) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.8);
        doc.setTextColor(0, 0, 0);
        doc.text(`(${g.breakdown})`, pageWidth - margin - 35, y + 7.0, { align: 'right' });
      }
    }

    // Purpose / Keterangan
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(0, 0, 0);
    doc.text(g.purpose || 'Pesanan', pageWidth - margin - 3, y + 3.5, { align: 'right' });

    y += rowHeight;
  });

  // 4. Bottom Section (Notes + Total + 3-Signatures)
  const boxHeight = hasReturns ? 22 : 18;
  const bottomHeight = hasReturns ? 56 : 52;
  if (y + bottomHeight > pageHeight - margin) {
    doc.addPage();
    y = 15;
  }

  const bottomY = Math.max(y + 4, pageHeight - margin - bottomHeight);

  // Notes box (Left)
  const notesWidth = contentWidth * 0.58;
  const notesText = docData.notes || 'Barang telah diperiksa dan diserahkan dalam keadaan baik, lengkap, serta sesuai dengan rincian di atas.';

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(0, 0, 0);
  doc.rect(margin, bottomY, notesWidth, boxHeight, 'D');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(0, 0, 0);
  doc.text('CATATAN PENGIRIMAN:', margin + 4, bottomY + 4.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(0, 0, 0);

  if (hasReturns) {
    const retSummary = activeReturns.map((r) => {
      const retNum = r.returnNumber || 'RET-DOKUMEN';
      const retDate = formatDate(r.returnedAt || r.date);
      const retReason = r.reason ? ` - ${r.reason}` : '';
      return `${retNum} (${retDate})${retReason}`;
    }).join('; ');
    const fullNotes = `${notesText}\n[RIWAYAT RETUR]: ${retSummary}`;
    const noticeLines = doc.splitTextToSize(fullNotes, notesWidth - 8);
    doc.text(noticeLines.slice(0, 4), margin + 4, bottomY + 8);
  } else {
    const noticeLines = doc.splitTextToSize(notesText, notesWidth - 8);
    doc.text(noticeLines.slice(0, 3), margin + 4, bottomY + 8.5);
  }

  // Total box (Right)
  const totalBoxX = margin + notesWidth + 4;
  const totalBoxWidth = contentWidth - notesWidth - 4;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.rect(totalBoxX, bottomY, totalBoxWidth, boxHeight, 'D');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text(`Total: ${groupedItems.length} Item`, totalBoxX + 4, bottomY + 5);

  if (hasReturns) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(0, 0, 0);
    doc.text(`Awal: ${totalLusinPcs}`, totalBoxX + totalBoxWidth - 4, bottomY + 5, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(220, 38, 38);
    doc.text(`Retur: -${totalReturnedLusinPcs}`, totalBoxX + totalBoxWidth - 4, bottomY + 9.2, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(22, 163, 74);
    doc.text(`Net: ${totalNetLusinPcs}`, totalBoxX + totalBoxWidth - 4, bottomY + 14, { align: 'right' });
    doc.setTextColor(0, 0, 0);

    if (unitSummary) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(100, 100, 100);
      doc.text(`(${unitSummary})`, totalBoxX + totalBoxWidth - 4, bottomY + 18.5, { align: 'right' });
      doc.setTextColor(0, 0, 0);
    }
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    doc.text(totalLusinPcs, totalBoxX + totalBoxWidth - 4, bottomY + 11.5, { align: 'right' });

    if (unitSummary) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(0, 0, 0);
      doc.text(`(${unitSummary})`, totalBoxX + totalBoxWidth - 4, bottomY + 15.5, { align: 'right' });
    }
  }

  // 3-Signatures Box
  const sigY = bottomY + boxHeight + 3.5;
  const colWidth = contentWidth / 3;

  const signatures = [
    { role: 'Penerima / Customer', line: '( ____________________ )', sub: 'Tanda Tangan & Cap Toko' },
    { role: 'Pengirim / Ekspedisi / Sopir', line: '( ____________________ )', sub: 'Nama Jelas & No. Kendaraan' },
    { role: 'Petugas Gudang / Hormat Kami', line: `( ${releasedBy} )`, sub: 'Dikeluarkan Oleh' },
  ];

  signatures.forEach((sig, sIdx) => {
    const sX = margin + sIdx * colWidth;
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.2);
    doc.rect(sX + 2, sigY, colWidth - 4, 26, 'D');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(0, 0, 0);
    doc.text(sig.role, sX + colWidth / 2, sigY + 4.5, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text(sig.line, sX + colWidth / 2, sigY + 18, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(0, 0, 0);
    doc.text(sig.sub, sX + colWidth / 2, sigY + 22.5, { align: 'center' });
  });

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

/**
 * Generate PDF Rangkap (Kertas Kontinyu 21cm x 12cm landscape) untuk Barang Masuk.
 * Dipakai sebagai default cetak mobile agar konsisten dengan Invoice/PO.
 *
 * @param {Object} docData - object dokumen goods_in
 * @param {Object} settings - workspace settings
 * @param {Object} contact - info supplier
 * @returns {Buffer} PDF buffer
 */
export function generateGoodsInPdfCompact(docData, settings = {}, contact = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [120, 210] });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const margin = 10;

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compLogo = settings.companyLogo || settings.logoUrl || '';
  const title = settings?.documents?.goodsInTitle || 'Barang Masuk';

  let headerTextX = margin;
  const drawHeader = () => {
    headerTextX = margin;
    if (compLogo && compLogo.startsWith('data:image/')) {
      try {
        doc.addImage(compLogo, 'PNG', margin, 5, 14, 14);
        headerTextX = margin + 17;
      } catch (_) {}
    }

    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(String(compName), headerTextX, 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    let currentY = 15;
    if (compAddr) {
      const lines = doc.splitTextToSize(String(compAddr), 105);
      lines.forEach((l) => {
        doc.text(l, headerTextX, currentY);
        currentY += 3.2;
      });
    }
    if (compPhone) {
      doc.text(`Telp: ${compPhone}`, headerTextX, currentY);
      currentY += 3.2;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(title, pageWidth - margin, 12, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const formattedDate = formatDate(docData.issue_date || docData.created_at);
    doc.text(`${docData.document_number ?? '-'} · ${formattedDate}`, pageWidth - margin, 17, { align: 'right' });

    const headerLineY = Math.max(currentY + 1, 23);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

    return headerLineY;
  };

  const headerLineY = drawHeader();

  // Top grid: Supplier / Info Penerimaan
  const gridY = headerLineY + 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Supplier', margin, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  const supplierName = docData.contact_name || contact.name || 'Supplier';
  doc.text(String(supplierName), margin, gridY + 4.5);

  const warehouse = docData.metadata?.warehouse || 'Gudang Utama';
  const receivedBy = docData.metadata?.receivedBy || 'Tim Gudang';
  const rightColX = 135;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('Info Penerimaan', rightColX, gridY);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text(`Gudang: ${warehouse}`, rightColX, gridY + 4.5);
  doc.text(`Diterima oleh: ${receivedBy}`, rightColX, gridY + 8);

  const gridLineY = gridY + 11;
  doc.setLineWidth(0.2);
  doc.line(margin, gridLineY, pageWidth - margin, gridLineY);

  // Items table
  let tableY = gridLineY + 2;
  const drawTableHeader = (startY) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text('Barang Diterima', margin + 2, startY + 4);
    doc.text('Jumlah Diterima', pageWidth - margin - 2, startY + 4, { align: 'right' });

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(margin, startY + 6, pageWidth - margin, startY + 6);
  };

  drawTableHeader(tableY);

  const rawItems = Array.isArray(docData.items) ? docData.items : (docData.metadata?.items || []);
  const customUnits = settings?.custom_units || settings?.customUnits;
  const grouped = getGroupedProductItems(rawItems, docData, customUnits);
  const grandTotalLusin = grouped.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = grouped.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  let y = tableY + 11;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);

  grouped.forEach((g) => {
    const nameLines = doc.splitTextToSize(g.name, 150);
    const hasSku = g.sku && g.sku !== '—' && g.sku !== '-';
    const rowHeight = nameLines.length * 4 + (hasSku ? 3.2 : 0) + 3;

    if (y + rowHeight > 88) {
      doc.addPage();
      const newHeaderLineY = drawHeader();
      const newGridLineY = newHeaderLineY + 5 + 11;
      doc.setLineWidth(0.2);
      doc.line(margin, newGridLineY, pageWidth - margin, newGridLineY);
      y = newGridLineY + 2;
      drawTableHeader(y);
      y += 11;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(nameLines, margin + 2, y);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(g.formattedQty, pageWidth - margin - 2, y, { align: 'right' });

    if (hasSku) {
      const skuY = y + nameLines.length * 3.8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(80, 80, 80);
      doc.text(`SKU: ${g.sku}`, margin + 2, skuY);
      doc.setTextColor(0, 0, 0);
    }

    y += rowHeight;
  });

  // Bottom: total + notes + signatures
  const fullWidth = pageWidth - 2 * margin;
  const notesText = docData.notes || 'Catatan: Tim gudang harus memverifikasi jumlah dan kesesuaian SKU barang sebelum stok dimasukkan.';
  const noticeLines = doc.splitTextToSize(notesText, fullWidth - 6);
  const noticeBoxHeight = Math.max(8, noticeLines.length * 3.5 + 4.5);
  const neededHeight = 6 + 1.5 + noticeBoxHeight + 18;

  if (y + neededHeight > 115) {
    doc.addPage();
    drawHeader();
    y = 30;
  }

  const bottomY = Math.max(y + 2, 120 - margin - neededHeight);

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(margin, bottomY, fullWidth, 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Total Jumlah:', margin + 3, bottomY + 4.2);
  doc.text(totalLusinPcs, pageWidth - margin - 3, bottomY + 4.2, { align: 'right' });

  const noticeBoxY = bottomY + 7.5;
  doc.rect(margin, noticeBoxY, fullWidth, noticeBoxHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('CATATAN', margin + 3, noticeBoxY + 3.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(noticeLines, margin + 3, noticeBoxY + 7.2);

  const sigY = noticeBoxY + noticeBoxHeight + 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  doc.text('Diterima Oleh', margin + 35, sigY + 3, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.line(margin + 15, sigY + 16, margin + 55, sigY + 16);

  doc.text('Diperiksa Oleh', pageWidth - margin - 35, sigY + 3, { align: 'center' });
  doc.line(pageWidth - margin - 55, sigY + 16, pageWidth - margin - 15, sigY + 16);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

/**
 * Generate PDF Rangkap (Kertas Kontinyu 21cm x 12cm landscape) untuk Barang Keluar / Surat Jalan.
 * Dipakai sebagai default cetak mobile agar konsisten dengan Invoice/PO.
 *
 * @param {Object} docData - object dokumen goods_out / delivery_note
 * @param {Object} settings - workspace settings
 * @param {Object} contact - info kontak / customer
 * @returns {Buffer} PDF buffer
 */
export function generateGoodsOutPdfCompact(docData, settings = {}, contact = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [120, 210] });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const margin = 10;

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compCity = settings.city || settings.companyCity || settings.company?.city || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compEmail = settings.email || settings.companyEmail || settings.company?.email || '';
  const compLogo = settings.companyLogo || settings.logoUrl || '';
  const title = settings?.documents?.goodsOutTitle || (docData.document_type === 'delivery_note' ? 'Surat Jalan' : 'Surat Jalan / Goods Out');

  // Compute grouped items and active returns upfront
  const rawItems = Array.isArray(docData.items) ? docData.items : (docData.metadata?.items || []);
  const customUnits = settings?.custom_units || settings?.customUnits;
  const groupedItems = getGroupedProductItems(rawItems, docData, customUnits);
  const grandTotalLusin = groupedItems.reduce((sum, g) => sum + (g.totalLusin || 0), 0);
  const grandTotalPcsOnly = groupedItems.reduce((sum, g) => sum + (g.totalPcsOnly || 0), 0);
  const totalLusinPcs = formatDocumentQty(grandTotalLusin, grandTotalPcsOnly);

  const grandReturnedLusin = groupedItems.reduce((sum, g) => sum + (g.returnedLusin || 0), 0);
  const grandReturnedPcsOnly = groupedItems.reduce((sum, g) => sum + (g.returnedPcsOnly || 0), 0);
  const totalReturnedLusinPcs = formatDocumentQty(grandReturnedLusin, grandReturnedPcsOnly);

  const grandNetLusin = groupedItems.reduce((sum, g) => sum + (g.netLusin || 0), 0);
  const grandNetPcsOnly = groupedItems.reduce((sum, g) => sum + (g.netPcsOnly || 0), 0);
  const totalNetLusinPcs = formatDocumentQty(grandNetLusin, grandNetPcsOnly);

  const activeReturns = Array.isArray(docData.metadata?.returns)
    ? docData.metadata.returns.filter((r) => r && r.status !== 'restored')
    : [];
  const hasReturns = activeReturns.length > 0;
  const isFullReturn = hasReturns && (grandNetLusin <= 0 && grandNetPcsOnly <= 0);

  const drawHeader = () => {
    let headerTextX = margin;
    if (compLogo && compLogo.startsWith('data:image/')) {
      try {
        doc.addImage(compLogo, 'PNG', margin, 5, 14, 14);
        headerTextX = margin + 17;
      } catch (_) {}
    }

    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(String(compName), headerTextX, 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    let currentY = 15;
    const addressLine = [compAddr, compCity].filter(Boolean).join(', ');
    if (addressLine) {
      const lines = doc.splitTextToSize(addressLine, 105);
      lines.forEach((l) => {
        doc.text(l, headerTextX, currentY);
        currentY += 3.2;
      });
    }
    const contactParts = [compEmail, compPhone].filter(Boolean).join(' · ');
    if (contactParts) {
      doc.text(contactParts, headerTextX, currentY);
      currentY += 3.2;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(title, pageWidth - margin, 11, { align: 'right' });

    if (hasReturns) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      if (isFullReturn) {
        doc.setTextColor(220, 38, 38);
        doc.text('[DIRETUR TOTAL]', pageWidth - margin, 15, { align: 'right' });
      } else {
        doc.setTextColor(217, 119, 6);
        doc.text('[DIRETUR SEBAGIAN]', pageWidth - margin, 15, { align: 'right' });
      }
      doc.setTextColor(0, 0, 0);
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    const formattedDate = formatDate(docData.issue_date || docData.created_at);
    doc.text(`${docData.document_number ?? '-'} · ${formattedDate}`, pageWidth - margin, hasReturns ? 19 : 16, { align: 'right' });

    const headerLineY = Math.max(currentY + 1, hasReturns ? 24 : 22);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

    return headerLineY;
  };

  const headerLineY = drawHeader();

  const gridY = headerLineY + 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Kepada Yth.', margin, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  const customerName = docData.contact_name || contact.name || 'Customer';
  doc.text(String(customerName), margin, gridY + 4.5);

  const warehouse = docData.metadata?.warehouse || 'Gudang Utama';
  const releasedBy = docData.metadata?.releasedBy || 'Tim Gudang';
  const courier = docData.metadata?.courier || docData.metadata?.driver || '';

  const rightColX = 135;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('Info Pengeluaran', rightColX, gridY);
  doc.text(`Gudang: ${warehouse}`, rightColX, gridY + 4.5);
  doc.text(`Dikeluarkan Oleh: ${releasedBy}${courier ? ` · Kurir: ${courier}` : ''}`, rightColX, gridY + 8);

  const gridLineY = gridY + 11;
  doc.setLineWidth(0.2);
  doc.line(margin, gridLineY, pageWidth - margin, gridLineY);

  let tableY = gridLineY + 2;
  const drawTableHeader = (startY) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text('Barang & Nomor Seri', margin + 2, startY + 4);
    doc.text(hasReturns ? 'Qty (Awal/Ret/Net)' : 'Jumlah', pageWidth - margin - 30, startY + 4, { align: 'right' });
    doc.text('Ket.', pageWidth - margin - 2, startY + 4, { align: 'right' });

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(margin, startY + 6, pageWidth - margin, startY + 6);
  };

  drawTableHeader(tableY);

  let y = tableY + 11;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);

  groupedItems.forEach((g) => {
    const nameLines = doc.splitTextToSize(g.name, 120);
    const hasSku = g.sku && g.sku !== '—' && g.sku !== '-';
    const hasSerials = Array.isArray(g.serials) && g.serials.length > 0;
    let serialsText = '';
    if (hasSerials) {
      const serialTokens = g.serials.map((s) => {
        const isRet = Array.isArray(g.returnedSerials) && g.returnedSerials.includes(s);
        return isRet ? `${s} [RETUR]` : s;
      });
      serialsText = `No. Seri (${g.serials.length}): ${serialTokens.join(', ')}`;
    }
    const serialLines = hasSerials ? doc.splitTextToSize(serialsText, 120) : [];
    const extraQtyHeight = g.hasReturns ? 6 : 0;
    const rowHeight = Math.max(
      nameLines.length * 3.8 + (hasSku ? 3.0 : 0) + (hasSerials ? serialLines.length * 2.8 + 1 : 0) + 3,
      extraQtyHeight + 6
    );

    if (y + rowHeight > 88) {
      doc.addPage();
      const newHeaderLineY = drawHeader();
      const newGridLineY = newHeaderLineY + 5 + 11;
      doc.setLineWidth(0.2);
      doc.line(margin, newGridLineY, pageWidth - margin, newGridLineY);
      y = newGridLineY + 2;
      drawTableHeader(y);
      y += 11;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(nameLines, margin + 2, y);

    let textY = y + nameLines.length * 3.8;
    if (hasSku) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(80, 80, 80);
      doc.text(`SKU: ${g.sku}`, margin + 2, textY);
      doc.setTextColor(0, 0, 0);
      textY += 3.0;
    }

    if (hasSerials) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(30, 30, 30);
      doc.text(serialLines, margin + 2, textY);
      doc.setTextColor(0, 0, 0);
    }

    if (g.hasReturns) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text(g.formattedQty, pageWidth - margin - 30, y, { align: 'right' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(220, 38, 38);
      doc.text(`-${g.returnedFormattedQty}`, pageWidth - margin - 30, y + 3.2, { align: 'right' });

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(22, 163, 74);
      doc.text(`Net: ${g.netFormattedQty}`, pageWidth - margin - 30, y + 6.6, { align: 'right' });
      doc.setTextColor(0, 0, 0);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(g.formattedQty, pageWidth - margin - 30, y, { align: 'right' });
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(g.purpose || 'Pesanan', pageWidth - margin - 2, y, { align: 'right' });

    y += rowHeight;
  });

  const fullWidth = pageWidth - 2 * margin;
  const notesText = docData.notes || 'Barang telah diperiksa dan diserahkan dalam keadaan baik, lengkap, serta sesuai dengan rincian di atas.';
  const returnSummaryText = hasReturns
    ? `\nRiwayat Retur: ${activeReturns.map((r) => `${r.returnNumber || 'RET'} (${formatDate(r.returnedAt || r.date)})`).join(', ')}`
    : '';
  const fullNotesText = `${notesText}${returnSummaryText}`;
  const noticeLines = doc.splitTextToSize(fullNotesText, fullWidth - 6);
  const noticeBoxHeight = Math.max(8, noticeLines.length * 3.5 + 4.5);
  const neededHeight = 6 + 1.5 + noticeBoxHeight + 18;

  if (y + neededHeight > 115) {
    doc.addPage();
    drawHeader();
    y = 30;
  }

  const bottomY = Math.max(y + 2, 120 - margin - neededHeight);

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(margin, bottomY, fullWidth, 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  doc.text('Total Jumlah:', margin + 3, bottomY + 4.2);

  if (hasReturns) {
    const totalLine = `Awal: ${totalLusinPcs} | Retur: -${totalReturnedLusinPcs} | Net Terkirim: ${totalNetLusinPcs}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.text(totalLine, pageWidth - margin - 3, bottomY + 4.2, { align: 'right' });
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(totalLusinPcs, pageWidth - margin - 3, bottomY + 4.2, { align: 'right' });
  }

  const noticeBoxY = bottomY + 7.5;
  doc.rect(margin, noticeBoxY, fullWidth, noticeBoxHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('CATATAN PENGIRIMAN', margin + 3, noticeBoxY + 3.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(noticeLines, margin + 3, noticeBoxY + 7.2);

  const sigY = noticeBoxY + noticeBoxHeight + 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  doc.text('Penerima', margin + 35, sigY + 3, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.line(margin + 15, sigY + 16, margin + 55, sigY + 16);

  doc.text('Hormat Kami', pageWidth - margin - 35, sigY + 3, { align: 'center' });
  doc.line(pageWidth - margin - 55, sigY + 16, pageWidth - margin - 15, sigY + 16);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

function formatReturnCompactDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function groupReturnPdfItems(returnRecord, docData) {
  const docItems = Array.isArray(docData?.items) ? docData.items : [];
  const rawItems = Array.isArray(returnRecord?.items) ? returnRecord.items : [];
  const grouped = [];
  const groupMap = new Map();

  rawItems.forEach((item) => {
    const matchedDocItem =
      docItems.find((di) => item.itemId && di.id === item.itemId) ||
      docItems.find((di) => item.productId && (di.product_id ?? di.productId) === item.productId) ||
      docItems.find(
        (di) =>
          item.serialNumber &&
          di.metadata?.isSerial === true &&
          String(di.metadata?.serialNumber || '').trim().toLowerCase() ===
            String(item.serialNumber).trim().toLowerCase()
      ) ||
      null;

    const productId =
      item.productId || item.product_id || item.itemId || item.productName || item.item_name || 'unknown';
    const productName =
      item.productName || item.item_name || item.itemName || matchedDocItem?.item_name || 'Produk';
    const sku = item.sku || matchedDocItem?.sku || '';
    const unit = item.qtyUnit || item.unit || matchedDocItem?.metadata?.qtyUnit || 'pcs';
    const condition = item.condition || item.targetStatus || 'available';
    const returnedQty = Number(item.returnedQty ?? item.quantity ?? 1) || 1;
    const serialNumber =
      item.serialNumber ||
      item.serial_number ||
      (item.itemId && matchedDocItem?.metadata?.isSerial ? matchedDocItem?.metadata?.serialNumber : '') ||
      '';
    const key = `${productId}__${unit}__${condition}`;

    if (!groupMap.has(key)) {
      const group = {
        key,
        productId,
        productName,
        sku,
        unit,
        condition,
        totalQty: returnedQty,
        serials: serialNumber ? [serialNumber] : [],
      };
      groupMap.set(key, group);
      grouped.push(group);
      return;
    }

    const group = groupMap.get(key);
    group.totalQty += returnedQty;
    if (serialNumber && !group.serials.includes(serialNumber)) {
      group.serials.push(serialNumber);
    }
  });

  grouped.forEach((group) => {
    group.serials.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  });

  return grouped;
}

export function generateReturnPdfCompact(returnRecord = {}, settings = {}, contact = {}, docData = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [120, 210] });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const fullWidth = pageWidth - 2 * margin;

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compCity = settings.city || settings.companyCity || settings.company?.city || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compEmail = settings.email || settings.companyEmail || settings.company?.email || '';
  const compLogo =
    settings.companyLogo || settings.company?.companyLogo || settings.company?.logoUrl || settings.logoUrl || '';
  const title = 'Return';

  const documentNumber = returnRecord.documentNumber || docData.document_number || '-';
  const returnNumber = returnRecord.returnNumber || `RET-${documentNumber}`;
  const returnDate = formatReturnCompactDate(
    returnRecord.returnedAt || returnRecord.date || returnRecord.createdAt || docData.created_at
  );
  const warehouse =
    returnRecord.warehouseName || returnRecord.metadata?.warehouse || docData.metadata?.warehouse || 'Gudang Utama';
  const documentType =
    returnRecord.documentType ||
    returnRecord.document_type ||
    returnRecord.type ||
    docData.document_type ||
    'goods_out';
  const isGoodsOut = documentType === 'goods_out';

  const customerName =
    docData.contact_name || returnRecord.contactName || contact.name || (isGoodsOut ? 'Pelanggan' : 'Pemasok');
  const customerAddress = [
    contact.address || docData.contact_address,
    contact.city || docData.contact_city,
    contact.province || docData.contact_province,
  ]
    .filter(Boolean)
    .join(', ');
  const customerDetail =
    [customerAddress, contact.phone || docData.contact_phone].filter(Boolean).join(' | ') || '-';

  const drawHeader = () => {
    let headerTextX = margin;
    if (compLogo && String(compLogo).startsWith('data:image/')) {
      try {
        doc.addImage(compLogo, 'PNG', margin, 5, 14, 14);
        headerTextX = margin + 17;
      } catch (_) {}
    }

    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(String(compName), headerTextX, 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    let currentY = 15;
    const addressLine = [compAddr, compCity].filter(Boolean).join(', ');
    if (addressLine) {
      const addressLines = doc.splitTextToSize(addressLine, 100);
      addressLines.forEach((line) => {
        doc.text(line, headerTextX, currentY);
        currentY += 3.2;
      });
    }
    const contactLine = [compEmail, compPhone].filter(Boolean).join(' | ');
    if (contactLine) {
      doc.text(contactLine, headerTextX, currentY);
      currentY += 3.2;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(title, pageWidth - margin, 12, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`${returnNumber} | ${returnDate}`, pageWidth - margin, 17, { align: 'right' });

    const headerLineY = Math.max(currentY + 1, 23);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.line(margin, headerLineY, pageWidth - margin, headerLineY);
    return headerLineY;
  };

  const drawTableHeader = (startY) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text('Barang Diretur', margin + 2, startY + 4);
    doc.text('Jumlah', pageWidth - margin - 42, startY + 4, { align: 'right' });
    doc.text('Kondisi', pageWidth - margin - 2, startY + 4, { align: 'right' });

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(margin, startY + 6, pageWidth - margin, startY + 6);
  };

  const headerLineY = drawHeader();

  const gridY = headerLineY + 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text(isGoodsOut ? 'Pelanggan' : 'Pemasok', margin, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(String(customerName), margin, gridY + 4.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const customerLines = doc.splitTextToSize(customerDetail, 108);
  doc.text(customerLines, margin, gridY + 7.8);
  const leftBottomY = gridY + 7.8 + Math.max(1, customerLines.length) * 3.1;

  const rightColX = 137;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('Informasi Retur', rightColX, gridY);

  doc.setFontSize(7);
  const infoLines = [
    ...doc.splitTextToSize(`Ref Dokumen: ${documentNumber}`, 63),
    ...doc.splitTextToSize(`Gudang: ${warehouse}`, 63),
  ];
  doc.text(infoLines, rightColX, gridY + 4.5);
  const rightBottomY = gridY + 4.5 + infoLines.length * 3.1;

  const gridLineY = Math.max(gridY + 11, leftBottomY + 2, rightBottomY + 2);
  doc.setLineWidth(0.2);
  doc.line(margin, gridLineY, pageWidth - margin, gridLineY);

  let tableY = gridLineY + 2;
  drawTableHeader(tableY);

  const groupedItems = groupReturnPdfItems(returnRecord, docData);
  const totalUnits = groupedItems.reduce((sum, group) => sum + group.totalQty, 0);
  const unitTotals = {};
  groupedItems.forEach((group) => {
    unitTotals[group.unit] = (unitTotals[group.unit] || 0) + group.totalQty;
  });
  const unitSummary =
    Object.entries(unitTotals)
      .map(([unit, qty]) => `${qty} ${unit}`)
      .join(', ') || `${totalUnits} unit`;

  let y = tableY + 11;

  groupedItems.forEach((group, index) => {
    const nameLines = doc.splitTextToSize(String(group.productName), 120);
    const hasSku = Boolean(group.sku && group.sku !== '-' && group.sku !== '—');
    const serialText =
      group.serials.length > 0 ? `No. Seri (${group.serials.length}): ${group.serials.join(', ')}` : '';
    const serialLines = serialText ? doc.splitTextToSize(serialText, 132) : [];
    const rowHeight =
      nameLines.length * 4 + (hasSku ? 3.2 : 0) + serialLines.length * 2.8 + 3;
    const itemBottomLimit =
      index === groupedItems.length - 1 ? pageHeight - margin - 31 : pageHeight - margin - 12;

    if (y + rowHeight > itemBottomLimit) {
      doc.addPage();
      const newHeaderLineY = drawHeader();
      const newTableY = newHeaderLineY + 5;
      drawTableHeader(newTableY);
      y = newTableY + 11;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text(nameLines, margin + 2, y);
    doc.text(`${group.totalQty} ${group.unit}`, pageWidth - margin - 42, y, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(group.condition === 'damaged' ? 185 : 22, group.condition === 'damaged' ? 28 : 163, group.condition === 'damaged' ? 28 : 74);
    doc.text(
      group.condition === 'damaged' ? 'Rusak / Damaged' : 'Baik / Tersedia',
      pageWidth - margin - 2,
      y,
      { align: 'right' }
    );

    let detailY = y + nameLines.length * 3.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(80, 80, 80);
    if (hasSku) {
      doc.text(`SKU: ${group.sku}`, margin + 2, detailY);
      detailY += 3.2;
    }
    if (serialLines.length > 0) {
      doc.text(serialLines, margin + 2, detailY);
    }

    doc.setTextColor(0, 0, 0);
    y += rowHeight;
  });

  const defaultNote = 'Barang telah diperiksa fisik dan dicatat dalam pembukuan retur gudang.';
  const rawNote = String(returnRecord.notes || '').trim();
  const rawReason = String(returnRecord.reason || returnRecord.return_reason || '').trim();
  const notesText =
    rawNote && rawNote.toLowerCase() !== rawReason.toLowerCase() ? rawNote : defaultNote;
  const noticeLines = doc.splitTextToSize(notesText, fullWidth - 6);
  const noticeBoxHeight = Math.max(8, noticeLines.length * 3.5 + 4.5);
  const neededHeight = 6 + 1.5 + noticeBoxHeight + 18;
  const getSigLineY = (bottomStartY) => bottomStartY + 6 + 1.5 + noticeBoxHeight + 4 + 16;

  let bottomY = Math.max(y + 2, pageHeight - margin - neededHeight);
  if (getSigLineY(bottomY) > pageHeight - 2) {
    doc.addPage();
    drawHeader();
    y = 30;
    bottomY = Math.max(y + 2, pageHeight - margin - neededHeight);
  }

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(margin, bottomY, fullWidth, 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  doc.text(`Total Barang: ${groupedItems.length} Jenis`, margin + 3, bottomY + 4.2);
  doc.text(`Total Retur: ${unitSummary}`, pageWidth - margin - 3, bottomY + 4.2, { align: 'right' });

  const noticeBoxY = bottomY + 7.5;
  doc.rect(margin, noticeBoxY, fullWidth, noticeBoxHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('CATATAN', margin + 3, noticeBoxY + 3.8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(noticeLines, margin + 3, noticeBoxY + 7.2);

  const sigY = noticeBoxY + noticeBoxHeight + 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(isGoodsOut ? 'Penerima / Pelanggan' : 'Pemasok', margin + 35, sigY + 3, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.line(margin + 15, sigY + 16, margin + 55, sigY + 16);

  doc.text('Hormat Kami', pageWidth - margin - 35, sigY + 3, { align: 'center' });
  doc.line(pageWidth - margin - 55, sigY + 16, pageWidth - margin - 15, sigY + 16);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

/**
 * Generate PDF untuk Dokumen Workspace (Invoice, Sample, Receipt, dll)
 * Menggunakan Kertas PO 21cm x 12cm landscape (default). Untuk Goods In/Out, gunakan
 * paperMode 'compact' (rangkap, default mobile) atau 'a4'.
 *
 * @param {Object} docData - object dokumen lengkap dengan items
 * @param {Object} settings - workspace settings
 * @param {Object} contact - info kontak
 * @param {'compact'|'a4'} paperMode - mode kertas untuk goods_in/goods_out (default 'a4', backward compatible)
 * @returns {Buffer} PDF buffer
 */
export function generateDocumentPdf(docData, settings = {}, contact = {}, paperMode = 'a4') {
  const docType = docData.document_type || 'invoice';
  if (docType === 'goods_in') {
    return paperMode === 'a4'
      ? generateGoodsInPdf(docData, settings, contact)
      : generateGoodsInPdfCompact(docData, settings, contact);
  }
  if (docType === 'goods_out' || docType === 'delivery_note') {
    return paperMode === 'a4'
      ? generateGoodsOutPdf(docData, settings, contact)
      : generateGoodsOutPdfCompact(docData, settings, contact);
  }

  const isSample = docType === 'sample';
  const isDelivery = false;

  // Kertas Continuous 210mm x 120mm (21cm x 12cm) Kertas PO
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [120, 210] });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
  const margin = 10;

  const compName = settings.companyName || settings.company?.companyName || settings.company?.name || 'Docuflow';
  const compAddr = settings.address || settings.companyAddress || settings.company?.address || '';
  const compCity = settings.city || settings.companyCity || settings.company?.city || '';
  const compPhone = settings.phone || settings.companyPhone || settings.company?.phone || '';
  const compEmail = settings.email || settings.companyEmail || settings.company?.email || '';
  const compLogo = settings.companyLogo || settings.logoUrl || '';
  const paymentTransfer = settings.paymentTransfer || settings.company?.paymentTransfer || '';

  const docTitleText = docType === 'purchase_order'
    ? 'Purchase Order'
    : docType === 'receipt'
      ? (settings?.documents?.receiptTitle || 'Kwitansi')
      : docType === 'delivery_note' || docType === 'goods_out'
        ? (settings?.documents?.deliveryNoteTitle || 'Surat Jalan')
        : docType === 'sample'
          ? (settings?.documents?.sampleTitle || 'Sample')
          : (settings?.documents?.invoiceTitle || 'Nota');

  // === 1. Header ===
  let headerTextX = margin;
  if (compLogo && compLogo.startsWith('data:image/')) {
    try {
      doc.addImage(compLogo, 'PNG', margin, 5, 14, 14);
      headerTextX = margin + 17;
    } catch (_) {}
  }

  // Company Name
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(String(compName), headerTextX, 9.5);

  // Company Details (Address, Email, Phone)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  let currentY = 13.5;
  const addressLine = [compAddr, compCity].filter(Boolean).join(', ');
  if (addressLine) {
    const lines = doc.splitTextToSize(addressLine, 100);
    lines.forEach((l) => {
      doc.text(l, headerTextX, currentY);
      currentY += 3.2;
    });
  }
  const contactParts = [compEmail, compPhone].filter(Boolean).join(' · ');
  if (contactParts) {
    doc.text(contactParts, headerTextX, currentY);
    currentY += 3.2;
  }

  // Document Title (Right Header)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(docTitleText, pageWidth - margin, 11, { align: 'right' });

  // Document Number & Date
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const docDateFormatted = formatDate(docData.issue_date || docData.created_at);
  doc.text(`${docData.document_number ?? '-'} · ${docDateFormatted}`, pageWidth - margin, 16.5, { align: 'right' });

  // Divider Line Header
  const headerLineY = Math.max(currentY + 1, 21);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(margin, headerLineY, pageWidth - margin, headerLineY);

  // === 2. Top Grid (Customer on Left, Payment/Info on Right) ===
  const gridY = headerLineY + 3.5;

  // Left: Kepada Yth. / Tujuan
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  const recipientLabel = isDelivery ? 'Tujuan' : 'Kepada Yth.';
  doc.text(recipientLabel, margin, gridY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  const customerName = docData.contact_name || contact.name || '-';
  doc.text(String(customerName), margin, gridY + 3.8);

  const addrParts = [
    contact.address || docData.metadata?.address || docData.address || docData.metadata?.customer_address || '',
    contact.city || docData.metadata?.city || docData.city || '',
    contact.province || docData.metadata?.province || docData.province || '',
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
  const contactAddr = addrParts.join(', ');
  const contactPhone = contact.phone || docData.metadata?.phone || docData.phone || docData.metadata?.customer_phone || '';

  let detailY = gridY + 7;
  if (contactAddr) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const lines = doc.splitTextToSize(String(contactAddr), 95);
    lines.forEach((l) => {
      doc.text(l, margin, detailY);
      detailY += 2.8;
    });
  }
  if (contactPhone) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(`Telp: ${contactPhone}`, margin, detailY);
    detailY += 2.8;
  }

  // Right: Transfer Bank / Info Pengeluaran / Keterangan
  const rightColX = 125;
  let rightDetailY = gridY + 7;
  if (isDelivery) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Info Pengeluaran', rightColX, gridY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const warehouse = docData.metadata?.warehouse || 'Gudang Utama';
    const releasedBy = docData.metadata?.releasedBy || 'Tim Gudang';
    doc.text(`Gudang: ${warehouse}`, rightColX, gridY + 3.8);
    doc.text(`Dikeluarkan oleh: ${releasedBy}`, rightColX, gridY + 6.8);
    rightDetailY = gridY + 9.8;
  } else if (isSample) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Keterangan', rightColX, gridY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text('Sample Produk (Tanpa Nilai Komersial)', rightColX, gridY + 3.8);
    rightDetailY = gridY + 6.8;
  } else {
    // Invoice / Nota: Transfer Bank
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Transfer Bank', rightColX, gridY);

    if (paymentTransfer) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      const ptLines = doc.splitTextToSize(paymentTransfer, 75);
      ptLines.forEach((l, idx) => {
        doc.text(l, rightColX, gridY + 3.8 + idx * 3.2);
      });
      rightDetailY = gridY + 3.8 + ptLines.length * 3.2;
    }
  }

  // Divider Line below Top Grid
  const gridBottomY = Math.max(detailY + 1, rightDetailY + 1, gridY + 9);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.line(margin, gridBottomY, pageWidth - margin, gridBottomY);

  // === 3. Items & Total Qty Calculation ===
  const rawItems = Array.isArray(docData.items) ? docData.items : (docData.metadata?.items || []);
  const customUnits = settings?.custom_units || settings?.customUnits || docData?.metadata?.custom_units;
  const helpers = getUnitHelpers(customUnits);
  const unitMultipliers = helpers.multipliers;

  const getItemUnit = (item) => {
    let unit = item.metadata?.unit || item.metadata?.qtyUnit || item.unit || 'lusin';
    const sku = String(item.sku || '');
    if (sku.includes('|')) unit = sku.split('|')[1] || unit;
    return unit;
  };

  const formatQtyNum = (v) => {
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
  };

  let totalLusin = 0;
  let totalPcsOnly = 0;
  const totalByUnit = {};
  rawItems.forEach((item) => {
    const unit = getItemUnit(item);
    const qty = Number(item.quantity ?? item.qty ?? 1);
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
    .map((u) => `${formatQtyNum(totalByUnit[u])} ${u}`)
    .join(' · ');

  const displayTotalQty = totalByUnitText || formatDocumentQty(totalLusin, totalPcsOnly);

  // Table Drawing
  let tableY = gridBottomY + 1.5;
  const drawDocTableHeader = (startY) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    if (isDelivery) {
      doc.text('Barang Dikeluarkan', margin, startY + 3);
      doc.text('Jumlah', 145, startY + 3, { align: 'right' });
      doc.text('Kegunaan', pageWidth - margin, startY + 3, { align: 'right' });
    } else if (isSample) {
      doc.text('Barang', margin, startY + 3);
      doc.text('Qty', 145, startY + 3, { align: 'right' });
      doc.text('Catatan', pageWidth - margin, startY + 3, { align: 'right' });
    } else {
      doc.text('Barang', margin, startY + 3);
      doc.text('Qty', 135, startY + 3, { align: 'right' });
      doc.text('Harga', 160, startY + 3, { align: 'right' });
      doc.text('Total', pageWidth - margin, startY + 3, { align: 'right' });
    }
    doc.setLineWidth(0.2);
    doc.line(margin, startY + 4.5, pageWidth - margin, startY + 4.5);
  };

  drawDocTableHeader(tableY);

  let y = tableY + 8;
  rawItems.forEach((item) => {
    const name = String(item.item_name || item.itemName || item.product_name || item.name || '-');
    let sku = String(item.sku || '');
    let unit = getItemUnit(item);
    if (sku.includes('|')) {
      const parts = sku.split('|');
      sku = parts[0];
    }
    const qty = Number(item.quantity ?? item.qty ?? 1);
    const price = Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0);
    const amount = Number(item.amount ?? (qty * price));
    const note = item.metadata?.note || item.note || item.metadata?.purpose || '-';

    const hasSku = sku && sku !== '-' && sku !== '—';
    const nameWidth = isDelivery || isSample ? 115 : 105;
    const nameLines = doc.splitTextToSize(name, nameWidth);
    const rowHeight = nameLines.length * 3.6 + (hasSku ? 3 : 0);

    if (y + rowHeight > 88) {
      doc.addPage();
      y = 10;
      drawDocTableHeader(y);
      y += 8;
    }

    // Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    doc.text(nameLines, margin, y);

    // SKU
    if (hasSku && !isSample) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(80, 80, 80);
      doc.text(`SKU: ${sku}`, margin, y + nameLines.length * 3.4);
    }

    // Qty
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);

    if (isDelivery) {
      doc.text(`${formatQtyNum(qty)} ${unit}`, 145, y, { align: 'right' });
      doc.text(String(note), pageWidth - margin, y, { align: 'right' });
    } else if (isSample) {
      doc.text(`${formatQtyNum(qty)} ${unit}`, 145, y, { align: 'right' });
      doc.text(String(note), pageWidth - margin, y, { align: 'right' });
    } else {
      doc.text(`${formatQtyNum(qty)} ${unit}`, 135, y, { align: 'right' });
      doc.text(`Rp ${price.toLocaleString('id-ID')}`, 160, y, { align: 'right' });
      doc.text(`Rp ${amount.toLocaleString('id-ID')}`, pageWidth - margin, y, { align: 'right' });
    }

    y += rowHeight + 2;
  });

  // === 4. Bottom Section ===
  const subtotal = Number(docData.subtotal) || rawItems.reduce((sum, it) => {
    const q = Number(it.quantity ?? it.qty ?? 1);
    const p = Number(it.unit_price ?? it.unitPrice ?? it.price ?? 0);
    return sum + q * p;
  }, 0);
  const discount = Number(docData.discount) || 0;
  const tax = Number(docData.tax) || 0;
  const grandTotal = Number(docData.total) || Math.max(subtotal - discount + tax, 0);

  let defaultNotice = 'Barang yang sudah dibeli tidak dapat ditukar atau dikembalikan, kecuali ada perjanjian tertulis sebelumnya. Terima kasih atas kepercayaan dan kerja sama Anda.';
  if (docType === 'delivery_note' || docType === 'goods_out') {
    defaultNotice = 'Barang telah diterima dalam kondisi baik dan cukup. Harap periksa kembali sebelum menandatangani.';
  } else if (docType === 'sample') {
    defaultNotice = 'Dokumen ini merupakan bukti penyerahan barang contoh (sample) tanpa nilai komersial.';
  } else if (docType === 'receipt') {
    defaultNotice = 'Bukti pembayaran yang sah. Terima kasih atas pembayaran Anda.';
  }
  const noticeText = docData.notes || defaultNotice;

  const leftBoxWidth = 100;
  const noticeLines = doc.splitTextToSize(noticeText, leftBoxWidth - 6);
  const noticeBoxHeight = Math.max(10, noticeLines.length * 2.8 + 4.5);
  const bottomSectionHeight = 6 + 1.5 + noticeBoxHeight + 17;

  if (y + bottomSectionHeight > 118) {
    doc.addPage();
    y = 10;
  }

  const bottomY = Math.max(y + 2, 120 - margin - bottomSectionHeight + 3);

  // Box 1: Total Jumlah (Left Box)
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.25);
  doc.rect(margin, bottomY, leftBoxWidth, 5.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(0, 0, 0);
  doc.text('Total Jumlah:', margin + 2.5, bottomY + 3.8);
  doc.text(displayTotalQty, margin + leftBoxWidth - 2.5, bottomY + 3.8, { align: 'right' });

  // Box 2: PERHATIAN / CATATAN (Left Box)
  const noticeBoxY = bottomY + 6.8;
  doc.rect(margin, noticeBoxY, leftBoxWidth, noticeBoxHeight);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text(isDelivery ? 'CATATAN:' : 'PERHATIAN!!!', margin + 2.5, noticeBoxY + 3.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.2);
  doc.text(noticeLines, margin + 2.5, noticeBoxY + 6.2);

  // Right Box: Totals (for invoice)
  if (!isSample && !isDelivery) {
    const totalsRightX = pageWidth - margin;
    const totalsLeftX = 135;
    let totalsY = bottomY + 3.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Subtotal', totalsLeftX, totalsY);
    doc.text(`Rp ${subtotal.toLocaleString('id-ID')}`, totalsRightX, totalsY, { align: 'right' });
    totalsY += 3.5;

    if (discount > 0) {
      doc.text('Diskon', totalsLeftX, totalsY);
      doc.text(`-Rp ${discount.toLocaleString('id-ID')}`, totalsRightX, totalsY, { align: 'right' });
      totalsY += 3.5;
    }
    if (tax > 0) {
      doc.text('Pajak', totalsLeftX, totalsY);
      doc.text(`Rp ${tax.toLocaleString('id-ID')}`, totalsRightX, totalsY, { align: 'right' });
      totalsY += 3.5;
    }

    doc.setLineWidth(0.3);
    doc.line(totalsLeftX, totalsY - 0.5, totalsRightX, totalsY - 0.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('Total', totalsLeftX, totalsY + 3);
    doc.text(`Rp ${grandTotal.toLocaleString('id-ID')}`, totalsRightX, totalsY + 3, { align: 'right' });
  }

  // Signatures (Penerima on Left, Hormat Kami on Right)
  const sigY = noticeBoxY + noticeBoxHeight + 3.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  // Penerima
  doc.text('Penerima', margin + leftBoxWidth / 2, sigY, { align: 'center' });
  doc.setLineWidth(0.25);
  doc.line(margin + 15, sigY + 10, margin + leftBoxWidth - 15, sigY + 10);

  // Hormat Kami / Dikeluarkan Oleh
  const rightSigLabel = isDelivery ? 'Dikeluarkan Oleh' : 'Hormat Kami';
  const rightSigCenterX = pageWidth - margin - (pageWidth - margin - 125) / 2;
  doc.text(rightSigLabel, rightSigCenterX, sigY, { align: 'center' });
  doc.line(rightSigCenterX - 25, sigY + 10, rightSigCenterX + 25, sigY + 10);

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}
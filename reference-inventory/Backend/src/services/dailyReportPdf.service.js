import { jsPDF } from 'jspdf';

/**
 * Helper untuk format teks kuantitas dengan pemisah ribuan Indonesia
 */
function formatNumber(num) {
  const n = Number(num) || 0;
  return n.toLocaleString('id-ID');
}

/**
 * Generator PDF Laporan Harian DocuFlow (A4 Multi-page)
 * Menggunakan warna aksen milik Owner yang bersangkutan secara konsisten.
 *
 * @param {Object} report - data laporan teragregasi dari buildDailyReportData
 * @returns {Buffer} Buffer PDF berkas A4
 */
export function generateDailyReportPdf(report) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();   // 210mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297mm
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;          // 182mm

  const palette = report.palette || {
    name: 'Indigo',
    rgb: [79, 70, 229],
    lightRgb: [238, 242, 255],
    darkRgb: [55, 48, 163],
  };

  const primaryRgb = palette.rgb || [79, 70, 229];
  const lightRgb = palette.lightRgb || [238, 242, 255];
  const darkRgb = palette.darkRgb || [55, 48, 163];

  let currentY = margin;

  // 1. Top Decorative Accent Strip
  const drawPageDecorations = () => {
    doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
    doc.rect(0, 0, pageWidth, 3.5, 'F');
  };

  drawPageDecorations();
  currentY = 12;

  // 2. Header: Brand, Title, Metadata
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
  doc.text('DOCUFLOW AUTOMATION', margin, currentY);

  currentY += 5.5;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(13, 13, 15);
  doc.text('Laporan Harian Operasional Gudang', margin, currentY);

  // Cut-off Badge di sebelah kanan
  const badgeText = `Cut-off: ${report.generatedAtWib}`;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  const badgeWidth = doc.getTextWidth(badgeText) + 8;
  const badgeX = pageWidth - margin - badgeWidth;
  doc.setFillColor(lightRgb[0], lightRgb[1], lightRgb[2]);
  doc.roundedRect(badgeX, currentY - 5, badgeWidth, 6.5, 2, 2, 'F');
  doc.setTextColor(darkRgb[0], darkRgb[1], darkRgb[2]);
  doc.text(badgeText, badgeX + 4, currentY - 0.8);

  currentY += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(75, 85, 99);
  const subtitleParts = [report.companyName];
  if (report.warehouseName) {
    subtitleParts.push(`Gudang: ${report.warehouseName}`);
  }
  subtitleParts.push(report.dateFormattedIndo);
  doc.text(subtitleParts.join('  •  '), margin, currentY);

  currentY += 4;
  doc.setDrawColor(228, 228, 233);
  doc.setLineWidth(0.3);
  doc.line(margin, currentY, pageWidth - margin, currentY);
  currentY += 5;

  // 3. KPI Summary Strip (Goods In, Goods Out, Return)
  const inCount = report.goodsIn?.completedCount || 0;
  const inPcs = report.goodsIn?.totalPcs || 0;
  const outCount = report.goodsOut?.completedCount || 0;
  const outPcs = report.goodsOut?.totalPcs || 0;
  const retCount = report.returns?.completedCount || 0;
  const retPcs = report.returns?.totalPcs || 0;

  const cardWidth = (contentWidth - 6) / 3;
  const cardHeight = 16;

  const renderKpiBox = (x, title, countLabel, pcsLabel, titleColor) => {
    doc.setFillColor(248, 249, 250);
    doc.setDrawColor(228, 228, 233);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, currentY, cardWidth, cardHeight, 1.5, 1.5, 'FD');

    // Accent line top of card
    doc.setFillColor(titleColor[0], titleColor[1], titleColor[2]);
    doc.rect(x + 1, currentY + 0.5, cardWidth - 2, 1, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(titleColor[0], titleColor[1], titleColor[2]);
    doc.text(title.toUpperCase(), x + 4, currentY + 5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(13, 13, 15);
    doc.text(countLabel, x + 4, currentY + 10.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(`Total: ${pcsLabel}`, x + 4, currentY + 14);
  };

  renderKpiBox(
    margin,
    'Goods In (Masuk)',
    `${inCount} dok`,
    `${formatNumber(inPcs)} pcs`,
    [2, 132, 199] // Info/Sky
  );

  renderKpiBox(
    margin + cardWidth + 3,
    'Goods Out (Keluar)',
    `${outCount} dok`,
    `${formatNumber(outPcs)} pcs`,
    [22, 163, 74] // Green
  );

  renderKpiBox(
    margin + (cardWidth + 3) * 2,
    'Return (Retur)',
    `${retCount} retur`,
    `${formatNumber(retPcs)} pcs`,
    primaryRgb // Owner Accent Color
  );

  currentY += cardHeight + 7;

  // 4. Helper untuk render tabel transaksi dengan pengulangan header multi-halaman
  const renderTable = (sectionTitle, headers, colWidths, rows) => {
    const checkPageBreak = (neededHeight) => {
      if (currentY + neededHeight > pageHeight - 20) {
        doc.addPage();
        drawPageDecorations();
        currentY = 14;
        return true;
      }
      return false;
    };

    checkPageBreak(18);

    // Section title with vertical accent indicator
    doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
    doc.rect(margin, currentY, 2.5, 4.5, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(13, 13, 15);
    doc.text(sectionTitle, margin + 5, currentY + 3.8);
    currentY += 6.5;

    const drawHeader = () => {
      doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
      doc.rect(margin, currentY, contentWidth, 6, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(255, 255, 255);

      let xOffset = margin;
      headers.forEach((h, idx) => {
        const isRight = idx === 4 || h.includes('Qty');
        const colW = colWidths[idx];
        if (isRight) {
          doc.text(h, xOffset + colW - 3, currentY + 4.2, { align: 'right' });
        } else {
          doc.text(h, xOffset + 3, currentY + 4.2);
        }
        xOffset += colW;
      });

      currentY += 6;
    };

    drawHeader();

    if (rows.length === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(108, 108, 120);
      doc.text('Tidak ada transaksi pada tanggal ini', margin + 4, currentY + 4.5);
      doc.setDrawColor(228, 228, 233);
      doc.line(margin, currentY + 6.5, margin + contentWidth, currentY + 6.5);
      currentY += 10;
      return;
    }

    rows.forEach((row, rIdx) => {
      const broke = checkPageBreak(7);
      if (broke) {
        drawHeader();
      }

      const isEven = rIdx % 2 === 0;
      doc.setFillColor(isEven ? 255 : 248, isEven ? 255 : 249, isEven ? 255 : 250);
      doc.rect(margin, currentY, contentWidth, 6, 'F');

      doc.setDrawColor(238, 238, 239);
      doc.setLineWidth(0.2);
      doc.line(margin, currentY + 6, margin + contentWidth, currentY + 6);

      let xOffset = margin;
      row.forEach((cellVal, cIdx) => {
        const colW = colWidths[cIdx];
        const isRight = cIdx === 4 || headers[cIdx].includes('Qty');

        if (cIdx === 0) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(13, 13, 15);
        } else if (isRight) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(13, 13, 15);
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(75, 85, 99);
        }

        const safeStr = doc.splitTextToSize(String(cellVal || '—'), colW - 5)[0] || '';
        if (isRight) {
          doc.text(safeStr, xOffset + colW - 3, currentY + 4.2, { align: 'right' });
        } else {
          doc.text(safeStr, xOffset + 3, currentY + 4.2);
        }
        xOffset += colW;
      });

      currentY += 6;
    });

    currentY += 5;
  };

  // 5. Render Tables (Goods In, Goods Out, Return)
  if (report.includeGoodsIn !== false) {
    const inRows = (report.goodsIn?.completedDocs || []).map((d) => [
      d.documentNumber,
      d.time || '—',
      d.contactName || '—',
      d.warehouseName || '—',
      `${formatNumber(d.totalPcs)} pcs`,
      d.notes || '—',
    ]);
    renderTable(
      'RINCIAN BARANG MASUK (GOODS IN) SELESAI',
      ['No. Dokumen', 'Waktu', 'Vendor / Supplier', 'Gudang', 'Kuantitas', 'Catatan'],
      [36, 16, 42, 34, 24, 30],
      inRows
    );
  }

  if (report.includeGoodsOut !== false) {
    const outRows = (report.goodsOut?.completedDocs || []).map((d) => [
      d.documentNumber,
      d.time || '—',
      d.contactName || '—',
      d.warehouseName || '—',
      `${formatNumber(d.totalPcs)} pcs`,
      d.notes || '—',
    ]);
    renderTable(
      'RINCIAN BARANG KELUAR (GOODS OUT) SELESAI',
      ['No. Dokumen', 'Waktu', 'Customer / Tujuan', 'Gudang', 'Kuantitas', 'Catatan'],
      [36, 16, 42, 34, 24, 30],
      outRows
    );
  }

  // Returns Section
  const retRows = (report.returns?.completedDocs || []).map((r) => [
    r.returnNumber || '—',
    r.time || '—',
    r.documentNumber || '—',
    r.contactName || '—',
    `${formatNumber(r.totalPcs)} pcs`,
    r.reason || '—',
  ]);
  renderTable(
    'RINCIAN RETUR BARANG (RETURN) SELESAI',
    ['No. Retur', 'Waktu', 'Ref Dokumen', 'Pihak Terkait', 'Kuantitas', 'Alasan Retur'],
    [34, 16, 36, 40, 24, 32],
    retRows
  );

  // 6. Pagination & Footers on Every Page
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(228, 228, 233);
    doc.setLineWidth(0.25);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(108, 108, 120);
    doc.text(`DocuFlow Daily Report • ${report.companyName} (${report.targetDate})`, margin, pageHeight - 7.5);

    const pageStr = `Halaman ${p} dari ${totalPages}`;
    doc.text(pageStr, pageWidth - margin - doc.getTextWidth(pageStr), pageHeight - 7.5);
  }

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}

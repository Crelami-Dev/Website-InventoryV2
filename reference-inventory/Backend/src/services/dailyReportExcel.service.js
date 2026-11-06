import zlib from 'node:zlib';

/**
 * Helper untuk escape karakter khusus XML
 */
function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Konversi index kolom (0-based) ke huruf Excel (0 -> A, 1 -> B, ..., 26 -> AA)
 */
function colToLetter(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Pembuat ZIP sederhana (PKZIP 2.0) tanpa dependensi eksternal,
 * memanfaatkan node:zlib built-in deflateRawSync dan crc32.
 */
function buildZipArchive(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = zlib.crc32(dataBuf);
    const compressed = zlib.deflateRawSync(dataBuf);

    // Local file header (30 bytes)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // Signature
    lh.writeUInt16LE(20, 4);         // Version: 2.0
    lh.writeUInt16LE(0, 6);          // Flags
    lh.writeUInt16LE(8, 8);          // Method: Deflate
    lh.writeUInt16LE(0, 10);         // Mod time
    lh.writeUInt16LE(0, 12);         // Mod date
    lh.writeUInt32LE(crc, 14);       // CRC-32
    lh.writeUInt32LE(compressed.length, 18); // Comp size
    lh.writeUInt32LE(dataBuf.length, 22);    // Uncomp size
    lh.writeUInt16LE(nameBuf.length, 26);    // Name len
    lh.writeUInt16LE(0, 28);                 // Extra len

    localHeaders.push(lh, nameBuf, compressed);

    // Central directory header (46 bytes)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // Signature
    ch.writeUInt16LE(20, 4);         // Version made by
    ch.writeUInt16LE(20, 6);         // Version needed
    ch.writeUInt16LE(0, 8);          // Flags
    ch.writeUInt16LE(8, 10);         // Deflate
    ch.writeUInt16LE(0, 12);         // Time
    ch.writeUInt16LE(0, 14);         // Date
    ch.writeUInt32LE(crc, 16);       // CRC-32
    ch.writeUInt32LE(compressed.length, 20); // Comp size
    ch.writeUInt32LE(dataBuf.length, 24);    // Uncomp size
    ch.writeUInt16LE(nameBuf.length, 28);    // Name len
    ch.writeUInt16LE(0, 30);                 // Extra len
    ch.writeUInt16LE(0, 32);                 // Comment len
    ch.writeUInt16LE(0, 34);                 // Disk number
    ch.writeUInt16LE(0, 36);                 // Internal attrs
    ch.writeUInt32LE(0, 38);                 // External attrs
    ch.writeUInt32LE(offset, 42);            // Relative offset of local header

    centralHeaders.push(ch, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const b of centralHeaders) centralDirSize += b.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // Signature
  eocd.writeUInt16LE(0, 4);                // Disk num
  eocd.writeUInt16LE(0, 6);                // Start disk
  eocd.writeUInt16LE(files.length, 8);     // Entries on disk
  eocd.writeUInt16LE(files.length, 10);    // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);  // Size of central dir
  eocd.writeUInt32LE(centralDirOffset, 16);// Offset of central dir
  eocd.writeUInt16LE(0, 20);               // Comment len

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Buat lembar kerja XML untuk Sheet 1 (Ringkasan)
 */
function buildSummarySheetXml(report, palette) {
  const {
    companyName,
    dateFormattedIndo,
    targetDate,
    generatedAtWib,
    includeGoodsIn,
    includeGoodsOut,
    goodsIn,
    goodsOut,
    returns = { completedCount: 0, totalPcs: 0 },
  } = report;

  const inCompleted = goodsIn?.completedCount || 0;
  const inPcs = goodsIn?.totalPcs || 0;
  const outCompleted = goodsOut?.completedCount || 0;
  const outPcs = goodsOut?.totalPcs || 0;
  const retCompleted = returns?.completedCount || 0;
  const retPcs = returns?.totalPcs || 0;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="30" customWidth="1"/>
    <col min="2" max="2" width="22" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="32" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1" ht="26" customHeight="1">
      <c r="A1" s="5" t="inlineStr"><is><t>DOCUFLOW - LAPORAN HARIAN OPERASIONAL GUDANG</t></is></c>
    </row>
    <row r="2">
      <c r="A2" s="2" t="inlineStr"><is><t>Perusahaan: ${escapeXml(companyName)}${report.warehouseName ? ` | Gudang: ${escapeXml(report.warehouseName)}` : ''}</t></is></c>
      <c r="B2" s="2" t="inlineStr"><is><t>Tanggal: ${escapeXml(targetDate)} (${escapeXml(dateFormattedIndo)})</t></is></c>
    </row>
    <row r="3">
      <c r="A3" s="2" t="inlineStr"><is><t>Cut-off: ${escapeXml(generatedAtWib)}</t></is></c>
      <c r="B3" s="2" t="inlineStr"><is><t>Warna Aksen: ${escapeXml(palette?.name || 'Indigo')}</t></is></c>
    </row>
    <row r="4"/>
    <row r="5" ht="24" customHeight="1">
      <c r="A5" s="1" t="inlineStr"><is><t>Indikator Operasional</t></is></c>
      <c r="B5" s="1" t="inlineStr"><is><t>Jumlah Dokumen Selesai</t></is></c>
      <c r="C5" s="1" t="inlineStr"><is><t>Total Kuantitas (Pcs)</t></is></c>
      <c r="D5" s="1" t="inlineStr"><is><t>Status Laporan</t></is></c>
    </row>
    <row r="6" ht="20" customHeight="1">
      <c r="A6" s="2" t="inlineStr"><is><t>Goods In (Barang Masuk)</t></is></c>
      <c r="B6" s="3"><v>${includeGoodsIn ? inCompleted : 0}</v></c>
      <c r="C6" s="3"><v>${includeGoodsIn ? inPcs : 0}</v></c>
      <c r="D6" s="2" t="inlineStr"><is><t>${includeGoodsIn ? 'Aktif Termasuk' : 'Dikecualikan'}</t></is></c>
    </row>
    <row r="7" ht="20" customHeight="1">
      <c r="A7" s="2" t="inlineStr"><is><t>Goods Out (Barang Keluar)</t></is></c>
      <c r="B7" s="3"><v>${includeGoodsOut ? outCompleted : 0}</v></c>
      <c r="C7" s="3"><v>${includeGoodsOut ? outPcs : 0}</v></c>
      <c r="D7" s="2" t="inlineStr"><is><t>${includeGoodsOut ? 'Aktif Termasuk' : 'Dikecualikan'}</t></is></c>
    </row>
    <row r="8" ht="20" customHeight="1">
      <c r="A8" s="2" t="inlineStr"><is><t>Return (Retur Barang)</t></is></c>
      <c r="B8" s="3"><v>${retCompleted}</v></c>
      <c r="C8" s="3"><v>${retPcs}</v></c>
      <c r="D8" s="2" t="inlineStr"><is><t>Diproses pada hari ini</t></is></c>
    </row>
  </sheetData>
</worksheet>`;
}

/**
 * Buat lembar kerja XML untuk Sheet Transaksi (Goods In, Goods Out, atau Return)
 * Dilengkapi pembekuan baris header (freeze pane) dan filter otomatis (autoFilter).
 */
function buildTransactionSheetXml({ title, headers, colWidths, rows }) {
  const lastColLetter = colToLetter(headers.length - 1);
  const rowCount = Math.max(1, rows.length);
  const filterRef = `A1:${lastColLetter}${rowCount + 1}`;

  const colsXml = colWidths.map((w, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`).join('');

  const headerCells = headers.map((h, idx) => {
    const cellRef = `${colToLetter(idx)}1`;
    return `<c r="${cellRef}" s="1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`;
  }).join('');

  const dataRowsXml = rows.map((row, rIdx) => {
    const rowNum = rIdx + 2;
    const cellsXml = row.map((val, cIdx) => {
      const cellRef = `${colToLetter(cIdx)}${rowNum}`;
      if (typeof val === 'number') {
        return `<c r="${cellRef}" s="3"><v>${val}</v></c>`;
      }
      return `<c r="${cellRef}" s="${cIdx === 1 ? 4 : 2}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNum}" ht="20" customHeight="1">${cellsXml}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="0" workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>
    ${colsXml}
  </cols>
  <sheetData>
    <row r="1" ht="26" customHeight="1">
      ${headerCells}
    </row>
    ${dataRowsXml}
  </sheetData>
  ${rows.length > 0 ? `<autoFilter ref="${filterRef}"/>` : ''}
</worksheet>`;
}

/**
 * Generator Excel (.xlsx) untuk Laporan Harian DocuFlow
 * Menggunakan warna aksen milik Owner yang bersangkutan.
 *
 * @param {Object} report - data laporan teragregasi dari buildDailyReportData
 * @returns {Buffer} Buffer berkas .xlsx yang valid
 */
export function generateDailyReportExcel(report) {
  const palette = report.palette || {
    name: 'Indigo',
    hexFill: 'FF4F46E5',
    lightHexFill: 'FFEEF2FF',
  };

  const accentHex = palette.hexFill || 'FF4F46E5';
  const lightHex = palette.lightHexFill || 'FFEEF2FF';

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // 3. xl/_rels/workbook.xml.rels
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // 4. xl/workbook.xml
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Ringkasan" sheetId="1" r:id="rId1"/>
    <sheet name="Goods In" sheetId="2" r:id="rId2"/>
    <sheet name="Goods Out" sheetId="3" r:id="rId3"/>
    <sheet name="Return" sheetId="4" r:id="rId4"/>
  </sheets>
</workbook>`;

  // 5. xl/styles.xml (Memuat palette accent warna Owner)
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><color rgb="FF0D0D0F"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FF0D0D0F"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="${accentHex}"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${accentHex}"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${lightHex}"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE4E4E9"/></left>
      <right style="thin"><color rgb="FFE4E4E9"/></right>
      <top style="thin"><color rgb="FFE4E4E9"/></top>
      <bottom style="thin"><color rgb="FFE4E4E9"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="8">
    <!-- 0: Normal text -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Table Header (Accent Background, Bold White Text, Centered) -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 2: Data Text Cell (Left aligned) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 3: Data Numeric Cell (Right aligned, #,##0 format) -->
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1" applyNumberFormat="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 4: Data Centered (Time / Code) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 5: Summary Title Bold -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 6: Summary Section Accent -->
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 7: Summary Metric Value Bold -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  // 6. Data Sheets
  const sheet1Xml = buildSummarySheetXml(report, palette);

  const goodsInRows = (report.goodsIn?.completedDocs || []).map((d) => [
    d.documentNumber,
    d.time,
    d.contactName,
    d.warehouseName,
    d.totalPcs,
    d.unitSummary,
    d.notes || '—',
  ]);

  const sheet2Xml = buildTransactionSheetXml({
    title: 'Goods In',
    headers: ['No. Dokumen', 'Waktu (WIB)', 'Vendor / Supplier', 'Gudang', 'Total Qty (Pcs)', 'Rincian Satuan', 'Catatan'],
    colWidths: [22, 14, 28, 22, 18, 26, 30],
    rows: goodsInRows,
  });

  const goodsOutRows = (report.goodsOut?.completedDocs || []).map((d) => [
    d.documentNumber,
    d.time,
    d.contactName,
    d.warehouseName,
    d.totalPcs,
    d.unitSummary,
    d.notes || '—',
  ]);

  const sheet3Xml = buildTransactionSheetXml({
    title: 'Goods Out',
    headers: ['No. Dokumen', 'Waktu (WIB)', 'Customer / Tujuan', 'Gudang', 'Total Qty (Pcs)', 'Rincian Satuan', 'Catatan'],
    colWidths: [22, 14, 28, 22, 18, 26, 30],
    rows: goodsOutRows,
  });

  const returnRows = (report.returns?.completedDocs || []).map((r) => [
    r.returnNumber,
    r.time,
    r.documentNumber,
    r.contactName,
    r.warehouseName,
    r.totalPcs,
    r.condition || 'available',
    r.reason || '—',
    r.notes || '—',
  ]);

  const sheet4Xml = buildTransactionSheetXml({
    title: 'Return',
    headers: ['No. Retur', 'Waktu (WIB)', 'Ref Dokumen', 'Customer / Vendor', 'Gudang', 'Total Qty (Pcs)', 'Kondisi', 'Alasan Retur', 'Catatan'],
    colWidths: [22, 14, 22, 28, 22, 18, 16, 26, 30],
    rows: returnRows,
  });

  return buildZipArchive([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
    { name: 'xl/worksheets/sheet3.xml', data: sheet3Xml },
    { name: 'xl/worksheets/sheet4.xml', data: sheet4Xml },
  ]);
}

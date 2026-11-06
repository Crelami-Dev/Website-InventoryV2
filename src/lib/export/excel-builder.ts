/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Native OpenXML Spreadsheet (.xlsx) Builder (TASK-SO-07 & Phase 7)
 *
 * Menggunakan Node.js native zlib (deflateRawSync & crc32) tanpa dependency pihak ketiga.
 * Mematuhi batasan AGENTS.md §4.8 (zero dependency bloat, zero security vulnerability).
 * Menghasilkan file Excel (.xlsx) standar OpenXML multi-worksheet yang 100% kompatibel
 * dengan Microsoft Excel, LibreOffice Calc, dan Google Sheets.
 */

import zlib from "node:zlib";

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
  align?: "left" | "center" | "right";
  format?: "text" | "number" | "currency" | "date" | "badge";
}

export interface ExcelRow {
  [key: string]: string | number | boolean | null | undefined;
}

export interface ExcelWorksheet {
  name: string;
  title?: string;
  subtitle?: string;
  metadata?: Array<{ label: string; value: string | number }>;
  columns: ExcelColumn[];
  rows: ExcelRow[];
  freezeHeader?: boolean;
}

export interface ExcelWorkbookOptions {
  creator?: string;
  company?: string;
  created?: Date;
  sheets: ExcelWorksheet[];
}

/**
 * Konversi indeks kolom (1-based) ke representasi huruf Excel (1 -> A, 27 -> AA)
 */
export function columnToLetter(column: number): string {
  let temp: number;
  let letter = "";
  let col = column;
  while (col > 0) {
    temp = (col - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    col = (col - temp - 1) / 26;
  }
  return letter;
}

/**
 * Sanitasi string untuk kepatuhan XML 1.0
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * Membentuk buffer ZIP PKZip format binary standar
 */
export function buildZipArchive(files: Array<{ path: string; data: Buffer }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const filenameBuf = Buffer.from(file.path, "utf8");
    const compressedData = zlib.deflateRawSync(file.data);
    const crc = zlib.crc32(file.data);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + filenameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8 filename)
    localHeader.writeUInt16LE(8, 8); // compression method (deflate)
    localHeader.writeUInt16LE(0, 10); // last mod time
    localHeader.writeUInt16LE(0x5421, 12); // last mod date (2022-01-01)
    localHeader.writeUInt32LE(crc, 14); // crc32
    localHeader.writeUInt32LE(compressedData.length, 18); // compressed size
    localHeader.writeUInt32LE(file.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length
    filenameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + filenameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // bit flag
    centralHeader.writeUInt16LE(8, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x5421, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16); // crc32
    centralHeader.writeUInt32LE(compressedData.length, 20); // compressed size
    centralHeader.writeUInt32LE(file.data.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(filenameBuf.length, 28); // filename length
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    filenameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(files.length, 8); // total entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/**
 * Membangun XML Stylesheet formal DocuFlow (Slate-800 Header, Soft Borders, Number Formats)
 */
function buildStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="#,##0"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
    <numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm"/>
  </numFmts>
  <fonts count="5">
    <!-- 0: Regular Body -->
    <font><sz val="10"/><name val="Calibri"/><family val="2"/></font>
    <!-- 1: Header Bold White -->
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <!-- 2: Sheet Title 14pt Bold -->
    <font><b/><sz val="14"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
    <!-- 3: Subtitle / Section Bold 10pt -->
    <font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
    <!-- 4: Metadata Muted 9pt -->
    <font><sz val="9"/><color rgb="FF64748B"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="8">
    <!-- 0 & 1: Required defaults -->
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <!-- 2: Header Background Solid Slate-800 (rgb 1E293B) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 3: Card / Alt Row Background (rgb F8FAFC) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 4: Badge Match Soft Green (rgb DCFCE7) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 5: Badge Shortage Soft Red (rgb FEE2E2) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 6: Badge Surplus Soft Blue (rgb DBEAFE) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>
    <!-- 7: Badge Warning Soft Yellow (rgb FEF3C7) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <!-- 0: None -->
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <!-- 1: Thin Gray (rgb CBD5E1) on all 4 sides -->
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="14">
    <!-- 0: Default Normal -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Table Header (Bold White, Slate-800 Fill, Thin Border, Center) -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 2: Sheet Title (14pt Bold) -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <!-- 3: Metadata Label (Bold, Gray Fill, Thin Border) -->
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <!-- 4: Metadata Value (Regular, Thin Border) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <!-- 5: Body Text Left (Thin Border) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 6: Body Text Center (Thin Border) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 7: Body Integer Number (Thousand Separator, Right, Thin Border) -->
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 8: Body Decimal Number (2 decimals, Right, Thin Border) -->
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 9: Body Date/Time (Center, Thin Border) -->
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 10: Badge MATCH (Soft Green Fill, Center) -->
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 11: Badge SHORTAGE (Soft Red Fill, Center) -->
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 12: Badge SURPLUS (Soft Blue Fill, Center) -->
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 13: Badge INVESTIGATION (Soft Yellow Fill, Center) -->
    <xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;
}

/**
 * Membangun XML untuk sebuah worksheet
 */
function buildWorksheetXml(sheet: ExcelWorksheet): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;

  // Sheet Views & Freeze Panes
  xml += `<sheetViews><sheetView tabSelected="1" workbookViewId="0">`;
  if (sheet.freezeHeader !== false) {
    // Tentukan baris split berdasarkan ada/tidaknya judul dan metadata
    let splitRow = 1;
    if (sheet.title) splitRow += 2;
    if (sheet.metadata && sheet.metadata.length > 0) {
      splitRow += Math.ceil(sheet.metadata.length / 2) + 1;
    }
    xml += `<pane ySplit="${splitRow}" topLeftCell="A${splitRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  }
  xml += `</sheetView></sheetViews>`;

  // Column Widths
  xml += `<cols>`;
  sheet.columns.forEach((col, idx) => {
    const colIdx = idx + 1;
    const width = col.width ?? (col.header.length > 15 ? 24 : 15);
    xml += `<col min="${colIdx}" max="${colIdx}" width="${width}" customWidth="1"/>`;
  });
  xml += `</cols>`;

  // Sheet Data
  xml += `<sheetData>`;
  let currentRow = 1;

  // Title Block
  if (sheet.title) {
    xml += `<row r="${currentRow}" spans="1:${sheet.columns.length}">`;
    xml += `<c r="A${currentRow}" s="2" t="inlineStr"><is><t>${escapeXml(sheet.title)}</t></is></c>`;
    xml += `</row>`;
    currentRow++;

    if (sheet.subtitle) {
      xml += `<row r="${currentRow}" spans="1:${sheet.columns.length}">`;
      xml += `<c r="A${currentRow}" s="0" t="inlineStr"><is><t>${escapeXml(sheet.subtitle)}</t></is></c>`;
      xml += `</row>`;
    }
    currentRow++;
  }

  // Metadata Grid (jika ada)
  if (sheet.metadata && sheet.metadata.length > 0) {
    for (let i = 0; i < sheet.metadata.length; i += 2) {
      const item1 = sheet.metadata[i];
      const item2 = sheet.metadata[i + 1];

      xml += `<row r="${currentRow}">`;
      xml += `<c r="A${currentRow}" s="3" t="inlineStr"><is><t>${escapeXml(item1.label)}</t></is></c>`;
      xml += `<c r="B${currentRow}" s="4" t="inlineStr"><is><t>${escapeXml(String(item1.value ?? "-"))}</t></is></c>`;

      if (item2 && sheet.columns.length >= 4) {
        xml += `<c r="C${currentRow}" s="3" t="inlineStr"><is><t>${escapeXml(item2.label)}</t></is></c>`;
        xml += `<c r="D${currentRow}" s="4" t="inlineStr"><is><t>${escapeXml(String(item2.value ?? "-"))}</t></is></c>`;
      }
      xml += `</row>`;
      currentRow++;
    }
    currentRow++; // Empty spacing row
  }

  // Table Headers
  const headerRow = currentRow;
  xml += `<row r="${headerRow}">`;
  sheet.columns.forEach((col, idx) => {
    const cellRef = `${columnToLetter(idx + 1)}${headerRow}`;
    xml += `<c r="${cellRef}" s="1" t="inlineStr"><is><t>${escapeXml(col.header)}</t></is></c>`;
  });
  xml += `</row>`;
  currentRow++;

  // Table Rows
  for (const row of sheet.rows) {
    xml += `<row r="${currentRow}">`;
    sheet.columns.forEach((col, idx) => {
      const cellRef = `${columnToLetter(idx + 1)}${currentRow}`;
      const val = row[col.key];

      if (val === null || val === undefined || val === "") {
        xml += `<c r="${cellRef}" s="6" t="inlineStr"><is><t>-</t></is></c>`;
      } else if (typeof val === "number") {
        const styleId = col.format === "currency" ? 8 : 7;
        xml += `<c r="${cellRef}" s="${styleId}" t="n"><v>${val}</v></c>`;
      } else if (typeof val === "boolean") {
        xml += `<c r="${cellRef}" s="6" t="inlineStr"><is><t>${val ? "YA" : "TIDAK"}</t></is></c>`;
      } else {
        const strVal = String(val);
        // Tentukan style badge untuk status rekonsiliasi
        let styleId = col.align === "center" ? 6 : col.align === "right" ? 7 : 5;
        if (col.format === "badge") {
          const upper = strVal.toUpperCase();
          if (upper.includes("MATCH") || upper.includes("SESUAI") || upper.includes("COMPLETED")) {
            styleId = 10;
          } else if (upper.includes("SHORTAGE") || upper.includes("DEFISIT") || upper.includes("KURANG") || upper.includes("LOST")) {
            styleId = 11;
          } else if (upper.includes("SURPLUS") || upper.includes("LEBIH")) {
            styleId = 12;
          } else if (upper.includes("INVESTIGATION") || upper.includes("RE-EVALUATION") || upper.includes("PERLU")) {
            styleId = 13;
          }
        }
        xml += `<c r="${cellRef}" s="${styleId}" t="inlineStr"><is><t>${escapeXml(strVal)}</t></is></c>`;
      }
    });
    xml += `</row>`;
    currentRow++;
  }

  xml += `</sheetData>`;
  xml += `</worksheet>`;
  return xml;
}

/**
 * Entry point utama: Membuat buffer biner .xlsx yang valid dan siap diunduh
 */
export function generateExcelWorkbook(options: ExcelWorkbookOptions): Buffer {
  if (!options.sheets || options.sheets.length === 0) {
    throw new Error("Workbook wajib memiliki minimal 1 worksheet.");
  }

  const files: Array<{ path: string; data: Buffer }> = [];

  // 1. [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;

  options.sheets.forEach((_, idx) => {
    contentTypesXml += `\n  <Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  });
  contentTypesXml += `\n</Types>`;
  files.push({ path: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") });

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  files.push({ path: "_rels/.rels", data: Buffer.from(rootRelsXml, "utf8") });

  // 3. xl/_rels/workbook.xml.rels
  let workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

  options.sheets.forEach((_, idx) => {
    workbookRelsXml += `\n  <Relationship Id="rIdSheet${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`;
  });
  workbookRelsXml += `\n</Relationships>`;
  files.push({ path: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRelsXml, "utf8") });

  // 4. xl/workbook.xml
  let workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>`;

  options.sheets.forEach((sheet, idx) => {
    // Sanitasi nama sheet: max 31 karakter dan tanpa karakter dilarang \ / ? * : [ ]
    const safeName = escapeXml(sheet.name.replace(/[\\/?*:[\]]/g, "_").slice(0, 31));
    workbookXml += `\n    <sheet name="${safeName}" sheetId="${idx + 1}" r:id="rIdSheet${idx + 1}"/>`;
  });
  workbookXml += `\n  </sheets>
</workbook>`;
  files.push({ path: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") });

  // 5. xl/styles.xml
  files.push({ path: "xl/styles.xml", data: Buffer.from(buildStylesXml(), "utf8") });

  // 6. xl/worksheets/sheetN.xml
  options.sheets.forEach((sheet, idx) => {
    const sheetXml = buildWorksheetXml(sheet);
    files.push({
      path: `xl/worksheets/sheet${idx + 1}.xml`,
      data: Buffer.from(sheetXml, "utf8"),
    });
  });

  return buildZipArchive(files);
}

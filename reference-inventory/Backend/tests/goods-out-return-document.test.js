import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SMTP_HOST = process.env.SMTP_HOST || 'smtp.test.local';
process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
process.env.SMTP_USER = process.env.SMTP_USER || 'smtp-user@test.local';
process.env.SMTP_PASS = process.env.SMTP_PASS || 'smtp-pass';
process.env.SMTP_FROM = process.env.SMTP_FROM || 'no-reply@test.local';

const {
  generateGoodsOutPdf,
  generateGoodsOutPdfCompact,
  generateDocumentPdf,
} = await import('../src/services/pdf.service.js');

const {
  sendGoodsOutEmail,
  getTransporter,
} = await import('../src/services/email.service.js');

describe('Goods Out Print & Email with Return Hardening', () => {
  let sentMails = [];

  beforeEach(() => {
    sentMails = [];
    const transporter = getTransporter();
    transporter.sendMail = async (mail) => {
      sentMails.push(mail);
      return { messageId: `msg-${sentMails.length}` };
    };
  });

  const sampleDocWithoutReturn = {
    id: 'doc-001',
    document_number: 'SJ-2026-001',
    document_type: 'goods_out',
    issue_date: '2026-10-23',
    contact_name: 'Toko Makmur Sejahtera',
    notes: 'Kirim via ekspedisi internal.',
    metadata: {
      warehouse: 'Gudang Utama',
      releasedBy: 'Staff Gudang A',
      courier: 'Budi (B 1234 CD)',
    },
    items: [
      {
        id: 'item-001',
        product_id: 'prod-001',
        item_name: 'Baju Kemeja Katun',
        sku: 'BJU-001',
        quantity: 24,
        metadata: {
          qtyUnit: 'lusin',
          qtyInput: 2,
          isSerial: true,
          serialNumber: 'SN-BJU-01',
        },
      },
      {
        id: 'item-002',
        product_id: 'prod-001',
        item_name: 'Baju Kemeja Katun',
        sku: 'BJU-001',
        quantity: 12,
        metadata: {
          qtyUnit: 'lusin',
          qtyInput: 1,
          isSerial: true,
          serialNumber: 'SN-BJU-02',
        },
      },
    ],
  };

  const sampleDocWithPartialReturn = {
    ...sampleDocWithoutReturn,
    document_number: 'SJ-2026-002',
    metadata: {
      ...sampleDocWithoutReturn.metadata,
      returns: [
        {
          id: 'ret-001',
          returnNumber: 'RET-SJ-2026-002-01',
          returnedAt: '2026-10-23T10:00:00.000Z',
          reason: 'cacat_produk',
          notes: 'Kancing copot 1 lusin',
          status: 'completed',
          items: [
            {
              itemId: 'item-002',
              productId: 'prod-001',
              productName: 'Baju Kemeja Katun',
              sku: 'BJU-001',
              isSerial: true,
              serialNumber: 'SN-BJU-02',
              returnedQty: 1,
              qtyUnit: 'lusin',
              baseQuantityPcs: 12,
              condition: 'damaged',
            },
          ],
        },
      ],
    },
  };

  const sampleDocWithFullReturn = {
    ...sampleDocWithoutReturn,
    document_number: 'SJ-2026-003',
    metadata: {
      ...sampleDocWithoutReturn.metadata,
      returns: [
        {
          id: 'ret-002',
          returnNumber: 'RET-SJ-2026-003-ALL',
          returnedAt: '2026-10-23T11:00:00.000Z',
          reason: 'salah_kirim',
          notes: 'Customer membatalkan seluruh pesanan',
          status: 'completed',
          items: [
            {
              itemId: 'item-001',
              productId: 'prod-001',
              productName: 'Baju Kemeja Katun',
              sku: 'BJU-001',
              isSerial: true,
              serialNumber: 'SN-BJU-01',
              returnedQty: 2,
              qtyUnit: 'lusin',
              baseQuantityPcs: 24,
              condition: 'available',
            },
            {
              itemId: 'item-002',
              productId: 'prod-001',
              productName: 'Baju Kemeja Katun',
              sku: 'BJU-001',
              isSerial: true,
              serialNumber: 'SN-BJU-02',
              returnedQty: 1,
              qtyUnit: 'lusin',
              baseQuantityPcs: 12,
              condition: 'available',
            },
          ],
        },
      ],
    },
  };

  it('generateGoodsOutPdf menghasilkan PDF A4 valid tanpa retur', () => {
    const buffer = generateGoodsOutPdf(sampleDocWithoutReturn, { companyName: 'PT Sukses Mandiri' });
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
    assert.ok(buffer.length > 1000);
  });

  it('generateGoodsOutPdf menghasilkan PDF A4 dengan retur parsial dan retur total', () => {
    const partialBuf = generateGoodsOutPdf(sampleDocWithPartialReturn, { companyName: 'PT Sukses Mandiri' });
    assert.ok(Buffer.isBuffer(partialBuf));
    assert.equal(partialBuf.subarray(0, 4).toString(), '%PDF');

    const fullBuf = generateGoodsOutPdf(sampleDocWithFullReturn, { companyName: 'PT Sukses Mandiri' });
    assert.ok(Buffer.isBuffer(fullBuf));
    assert.equal(fullBuf.subarray(0, 4).toString(), '%PDF');
  });

  it('generateGoodsOutPdfCompact menghasilkan PDF Rangkap 21x12cm dengan dan tanpa retur', () => {
    const normalBuf = generateGoodsOutPdfCompact(sampleDocWithoutReturn, { companyName: 'PT Sukses Mandiri' });
    assert.ok(Buffer.isBuffer(normalBuf));
    assert.equal(normalBuf.subarray(0, 4).toString(), '%PDF');

    const retBuf = generateGoodsOutPdfCompact(sampleDocWithPartialReturn, { companyName: 'PT Sukses Mandiri' });
    assert.ok(Buffer.isBuffer(retBuf));
    assert.equal(retBuf.subarray(0, 4).toString(), '%PDF');
  });

  it('generateDocumentPdf merespons opsi paperMode: a4 vs compact untuk goods_out', () => {
    const a4Buf = generateDocumentPdf(sampleDocWithPartialReturn, {}, {}, 'a4');
    const compactBuf = generateDocumentPdf(sampleDocWithPartialReturn, {}, {}, 'compact');
    assert.ok(Buffer.isBuffer(a4Buf));
    assert.ok(Buffer.isBuffer(compactBuf));
    assert.notEqual(a4Buf.length, compactBuf.length);
  });

  it('sendGoodsOutEmail menghasilkan subjek dan rincian retur yang jelas saat ada retur', async () => {
    const normalResult = await sendGoodsOutEmail({
      doc: sampleDocWithoutReturn,
      pdfBuffer: Buffer.from('%PDF-1.4 test'),
      creatorEmail: 'staff@test.local',
      creatorName: 'Staff Gudang',
      financeEmail: 'finance@test.local',
      warehouseName: 'Gudang Utama',
    });
    assert.equal(normalResult.status, 'sent');
    assert.match(normalResult.subject, /\[Goods Out\] - SJ-2026-001 ke Toko Makmur Sejahtera/);
    assert.equal(sentMails.length, 1);
    assert.match(sentMails[0].text, /Total Keseluruhan: 2 lusin/);

    const partialResult = await sendGoodsOutEmail({
      doc: sampleDocWithPartialReturn,
      pdfBuffer: Buffer.from('%PDF-1.4 test'),
      creatorEmail: 'staff@test.local',
      creatorName: 'Staff Gudang',
      financeEmail: 'finance@test.local',
      warehouseName: 'Gudang Utama',
    });
    assert.equal(partialResult.status, 'sent');
    assert.match(partialResult.subject, /\[Goods Out - RETUR SEBAGIAN\] - SJ-2026-002/);
    assert.equal(sentMails.length, 2);
    const partialMail = sentMails[1];
    assert.match(partialMail.text, /STATUS PENGIRIMAN: DIRETUR SEBAGIAN/);
    assert.match(partialMail.text, /Qty Awal: 2 lusin/);
    assert.match(partialMail.text, /Diretur: -1 lusin/);
    assert.match(partialMail.text, /Net: 1 lusin/);
    assert.match(partialMail.text, /SN-BJU-02 \[RETUR\]/);
    assert.match(partialMail.text, /Riwayat Retur Dokumen Ini:/);
    assert.match(partialMail.text, /RET-SJ-2026-002-01/);
    assert.match(partialMail.html, /DIRETUR SEBAGIAN/);
    assert.match(partialMail.html, /Net Terkirim/);

    const fullResult = await sendGoodsOutEmail({
      doc: sampleDocWithFullReturn,
      pdfBuffer: Buffer.from('%PDF-1.4 test'),
      creatorEmail: 'staff@test.local',
      creatorName: 'Staff Gudang',
      financeEmail: 'finance@test.local',
      warehouseName: 'Gudang Utama',
    });
    assert.equal(fullResult.status, 'sent');
    assert.match(fullResult.subject, /\[Goods Out - RETUR TOTAL\] - SJ-2026-003/);
    assert.equal(sentMails.length, 3);
    const fullMail = sentMails[2];
    assert.match(fullMail.text, /STATUS PENGIRIMAN: DIRETUR TOTAL/);
    assert.match(fullMail.html, /DIRETUR TOTAL/);
  });
});

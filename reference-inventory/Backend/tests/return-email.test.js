import { after, beforeEach, describe, it } from 'node:test';
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

const { supabaseAdmin } = await import('../src/lib/supabase.js');
const {
  sendReturnEmail,
  getTransporter,
  closeTransporter,
  getSmtpConfig,
  recoverStalePendingReturnEmails,
} = await import('../src/services/email.service.js');

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
let logs = [];
let sentMails = [];

function matches(row, filters, lessThanFilters = []) {
  const equals = filters.every(([column, value]) => row[column] === value);
  const lessThan = lessThanFilters.every(
    ([column, value]) => row[column] != null && new Date(row[column]).getTime() < new Date(value).getTime()
  );
  return equals && lessThan;
}

function createEmailLogsQuery() {
  return {
    select() {
      const filters = [];
      const lessThanFilters = [];
      const query = {
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        not() {
          return query;
        },
        lt(column, value) {
          lessThanFilters.push([column, value]);
          return query;
        },
        or() {
          return query;
        },
        limit() {
          return query;
        },
        async maybeSingle() {
          const row = logs.find((log) => matches(log, filters, lessThanFilters));
          return { data: row ? { ...row } : null, error: null };
        },
        async single() {
          const row = logs.find((log) => matches(log, filters, lessThanFilters));
          return row ? { data: { ...row }, error: null } : { data: null, error: { message: 'not found' } };
        },
        then(resolve, reject) {
          const rows = logs.filter((log) => matches(log, filters, lessThanFilters));
          return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    insert(payload) {
      return {
        select() {
          return {
            async single() {
              if (
                payload.return_id &&
                logs.some(
                  (log) => log.document_id === payload.document_id && log.return_id === payload.return_id
                )
              ) {
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              const row = { id: `log-${logs.length + 1}`, created_at: new Date().toISOString(), ...payload };
              logs.push(row);
              return { data: { id: row.id }, error: null };
            },
          };
        },
      };
    },
    update(patch) {
      const filters = [];
      const query = {
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        select() {
          return {
            async maybeSingle() {
              const row = logs.find((log) => matches(log, filters));
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              return { data: { id: row.id }, error: null };
            },
          };
        },
        then(resolve, reject) {
          const rows = logs.filter((log) => matches(log, filters));
          rows.forEach((row) => Object.assign(row, patch));
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

describe('Return email notification', () => {
  beforeEach(() => {
    logs = [];
    sentMails = [];
    supabaseAdmin.from = (table) => {
      if (table !== 'email_logs') throw new Error(`Unexpected table in test: ${table}`);
      return createEmailLogsQuery();
    };

    const transporter = getTransporter();
    transporter.sendMail = async (mail) => {
      sentMails.push(mail);
      return { messageId: `mock-${sentMails.length}` };
    };
  });

  after(() => {
    supabaseAdmin.from = originalFrom;
    closeTransporter();
  });

  it('mengirim detail retur Goods Out ke finance dan mencatat log sent', async () => {
    const doc = {
      id: '11111111-1111-1111-1111-111111111111',
      document_number: 'SJ-001',
      document_type: 'goods_out',
      contact_name: 'Toko Pelanggan',
      items: [
        {
          id: '22222222-2222-2222-2222-222222222222',
          item_name: 'Kertas A4',
          sku: 'A4-001',
          quantity: 300,
          metadata: { qtyUnit: 'bal25', qtyInput: 1 },
        },
      ],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333333',
      returnNumber: 'RET-SJ-001-R01',
      returnedAt: '2026-10-20T03:15:00.000Z',
      returnedBy: '44444444-4444-4444-4444-444444444444',
      reason: 'cacat_produk',
      notes: 'Kemasan penyok saat diterima',
      condition: 'damaged',
      items: [
        {
          itemId: '22222222-2222-2222-2222-222222222222',
          productId: '55555555-5555-5555-5555-555555555555',
          productName: 'Kertas A4',
          sku: 'A4-001',
          isSerial: false,
          serialNumber: 'A4-25BL-0001',
          returnedQty: 1,
          qtyUnit: 'bal25',
          baseQuantityPcs: 300,
          condition: 'damaged',
        },
      ],
    };

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      returnNumber: returnRecord.returnNumber,
      creatorEmail: 'staff@tenant.test',
      creatorName: 'Petugas Gudang',
      financeEmail: 'finance@tenant.test',
      accentColor: 'amber',
      warehouseName: 'Gudang Utama (GU)',
    });

    assert.equal(result.status, 'sent');
    assert.equal(sentMails.length, 1);

    const mail = sentMails[0];
    assert.equal(mail.to, 'finance@tenant.test');
    assert.deepEqual(mail.cc, ['staff@tenant.test']);
    assert.match(mail.subject, /\[Return\] - RET-SJ-001-R01 - SJ-001/);

    assert.match(mail.text, /No\. Retur\s+: RET-SJ-001-R01/);
    assert.match(mail.text, /Dokumen Asal\s+: SJ-001 \(Barang Keluar\)/);
    assert.match(mail.text, /Gudang\s+: Gudang Utama \(GU\)/);
    assert.match(mail.text, /Petugas\s+: Petugas Gudang/);
    assert.match(mail.text, /Alasan\s+: Cacat \/ Rusak/);
    assert.match(mail.text, /Catatan\s+: Kemasan penyok saat diterima/);
    assert.match(mail.text, /Kertas A4/);
    assert.match(mail.text, /1 bal25 \(300 pcs\)/);
    assert.match(mail.text, /No\. Seri: A4-25BL-0001/);
    assert.match(mail.text, /Kondisi: Rusak/);
    assert.match(mail.html, /Retur Barang Keluar Berhasil Diproses/);
    assert.match(mail.html, /Kemasan penyok saat diterima/);
    assert.match(mail.text, /Terlampir dokumen PDF Bukti Retur \(format rangkap 21 x 12 cm\)/);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].filename, 'Return-RET-SJ-001-R01.pdf');
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    assert.ok(Buffer.isBuffer(mail.attachments[0].content));
    assert.equal(mail.attachments[0].content.subarray(0, 4).toString(), '%PDF');

    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'sent');
    assert.equal(logs[0].email_type, 'return');
    assert.equal(logs[0].return_id, returnRecord.id);
    assert.equal(logs[0].recipient_email, 'finance@tenant.test');
  });

  it('tidak mengirim ulang retur yang sama (idempoten)', async () => {
    const doc = {
      id: '11111111-1111-1111-1111-111111111112',
      document_number: 'IN-002',
      document_type: 'goods_in',
      contact_name: 'Supplier B',
      items: [
        {
          id: '22222222-2222-2222-2222-222222222223',
          item_name: 'Tinta Printer',
          sku: 'INK-01',
          quantity: 2,
          metadata: { qtyUnit: 'pcs', qtyInput: 2 },
        },
      ],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333334',
      returnNumber: 'RET-IN-002-R01',
      returnedAt: '2026-10-20T04:00:00.000Z',
      returnedBy: '44444444-4444-4444-4444-444444444445',
      reason: 'salah_kirim',
      notes: null,
      items: [
        {
          itemId: '22222222-2222-2222-2222-222222222223',
          productId: '55555555-5555-5555-5555-555555555556',
          isSerial: false,
          returnedQty: 2,
          qtyUnit: 'pcs',
        },
      ],
    };
    const params = {
      doc,
      returnRecord,
      returnNumber: returnRecord.returnNumber,
      creatorEmail: 'staff@tenant.test',
      creatorName: 'Petugas Gudang',
      financeEmail: 'finance@tenant.test',
      warehouseName: 'Gudang Utama',
    };

    const first = await sendReturnEmail(params);
    const second = await sendReturnEmail(params);

    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'skipped');
    assert.equal(sentMails.length, 1);
    assert.equal(logs.length, 1);
  });

  it('retry memakai baris email_logs yang sama dan tidak membuat log duplikat', async () => {
    const doc = {
      id: '11111111-1111-1111-1111-111111111114',
      document_number: 'SJ-004',
      document_type: 'goods_out',
      contact_name: 'Pelanggan D',
      items: [],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333336',
      returnNumber: 'RET-SJ-004-R01',
      returnedAt: '2026-10-20T06:00:00.000Z',
      reason: 'salah_produk',
      notes: null,
      items: [],
    };
    logs.push({
      id: 'log-retry-1',
      document_id: doc.id,
      return_id: returnRecord.id,
      email_type: 'return',
      status: 'failed',
      error_message: 'SMTP timeout',
    });

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      creatorEmail: 'staff@tenant.test',
      creatorName: 'Petugas Gudang',
      financeEmail: 'finance@tenant.test',
      warehouseName: 'Gudang Utama',
      existingLogId: 'log-retry-1',
    });

    assert.equal(result.status, 'sent');
    assert.equal(sentMails.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, 'log-retry-1');
    assert.equal(logs[0].status, 'sent');
    assert.equal(logs[0].error_message, null);
  });

  it('mengirim email retur Goods In dengan detail dokumen masuk', async () => {
    const doc = {
      id: '11111111-1111-1111-1111-111111111120',
      document_number: 'IN-010',
      document_type: 'goods_in',
      contact_name: 'Supplier Masuk',
      items: [
        {
          id: '22222222-2222-2222-2222-222222222220',
          item_name: 'Map Plastik',
          sku: 'MAP-01',
          quantity: 24,
          metadata: { qtyUnit: 'lusin', qtyInput: 2, baseQuantity: 24 },
        },
      ],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333320',
      returnNumber: 'RET-IN-010-R01',
      returnedAt: '2026-10-20T07:00:00.000Z',
      returnedBy: '44444444-4444-4444-4444-444444444420',
      reason: 'salah_kirim',
      notes: 'Supplier mengirim warna berbeda',
      items: [
        {
          itemId: '22222222-2222-2222-2222-222222222220',
          productName: 'Map Plastik',
          sku: 'MAP-01',
          returnedQty: 2,
          qtyUnit: 'lusin',
          baseQuantityPcs: 24,
          condition: 'available',
        },
      ],
    };

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      returnNumber: returnRecord.returnNumber,
      creatorEmail: 'staff@tenant.test',
      creatorName: 'Petugas Masuk',
      financeEmail: 'finance@tenant.test',
      warehouseName: 'Gudang Masuk',
    });

    assert.equal(result.status, 'sent');
    assert.equal(sentMails.length, 1);
    assert.match(sentMails[0].subject, /\[Return\] - RET-IN-010-R01 - IN-010/);
    assert.match(sentMails[0].text, /Dokumen Asal\s+: IN-010 \(Barang Masuk\)/);
    assert.match(sentMails[0].text, /2 lusin \(24 pcs\)/);
    assert.match(sentMails[0].html, /Retur Barang Masuk Berhasil Diproses/);
    assert.equal(logs[0].status, 'sent');
  });

  it('SMTP gagal tidak melempar error ke pemanggil dan log menjadi failed', async () => {
    const transporter = getTransporter();
    transporter.sendMail = async () => {
      const err = new Error('Invalid SMTP credentials');
      err.code = 'EAUTH';
      throw err;
    };

    const doc = {
      id: '11111111-1111-1111-1111-111111111121',
      document_number: 'SJ-021',
      document_type: 'goods_out',
      contact_name: 'Pelanggan Gagal',
      items: [],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333321',
      returnNumber: 'RET-SJ-021-R01',
      returnedAt: '2026-10-20T08:00:00.000Z',
      reason: 'lainnya',
      items: [],
    };

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      creatorEmail: 'staff@tenant.test',
      financeEmail: 'finance@tenant.test',
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /Invalid SMTP credentials/);
    assert.equal(sentMails.length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failed');
    assert.match(logs[0].error_message, /Invalid SMTP credentials/);
  });

  it('dua request bersamaan hanya mengirim satu email', async () => {
    const transporter = getTransporter();
    transporter.sendMail = async (mail) => {
      sentMails.push(mail);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { messageId: `mock-${sentMails.length}` };
    };

    const doc = {
      id: '11111111-1111-1111-1111-111111111122',
      document_number: 'SJ-022',
      document_type: 'goods_out',
      contact_name: 'Pelanggan Race',
      items: [],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333322',
      returnNumber: 'RET-SJ-022-R01',
      returnedAt: '2026-10-20T09:00:00.000Z',
      reason: 'cacat_produk',
      items: [],
    };
    const params = {
      doc,
      returnRecord,
      creatorEmail: 'staff@tenant.test',
      financeEmail: 'finance@tenant.test',
    };

    const results = await Promise.all([sendReturnEmail(params), sendReturnEmail(params)]);
    const statuses = results.map((result) => result.status).sort();

    assert.deepEqual(statuses, ['sent', 'skipped']);
    assert.equal(sentMails.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'sent');
  });

  it('log pending kedaluwarsa ditandai uncertain dan hanya bisa dikirim ulang manual', async () => {
    const oldIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const doc = {
      id: '11111111-1111-1111-1111-111111111123',
      document_number: 'SJ-023',
      document_type: 'goods_out',
      contact_name: 'Pelanggan Pending',
      items: [],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333323',
      returnNumber: 'RET-SJ-023-R01',
      returnedAt: '2026-10-20T10:00:00.000Z',
      reason: 'lainnya',
      items: [],
    };
    logs.push({
      id: 'log-pending-stale',
      document_id: doc.id,
      return_id: returnRecord.id,
      email_type: 'return',
      status: 'pending',
      created_at: oldIso,
      last_attempt_at: oldIso,
    });
    const params = {
      doc,
      returnRecord,
      creatorEmail: 'staff@tenant.test',
      financeEmail: 'finance@tenant.test',
    };

    const automatic = await sendReturnEmail(params);

    assert.equal(automatic.status, 'skipped');
    assert.equal(automatic.reason, 'stale_pending_marked_uncertain');
    assert.equal(sentMails.length, 0);
    assert.equal(logs[0].status, 'uncertain');

    const manual = await sendReturnEmail({ ...params, manualRetry: true });

    assert.equal(manual.status, 'sent');
    assert.equal(sentMails.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, 'log-pending-stale');
    assert.equal(logs[0].status, 'sent');
  });

  it('recovery cron hanya menandai pending kedaluwarsa, bukan pending aktif', async () => {
    const oldIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const freshIso = new Date().toISOString();
    logs.push(
      {
        id: 'log-pending-old',
        document_id: '11111111-1111-1111-1111-111111111124',
        return_id: '33333333-3333-3333-3333-333333333324',
        email_type: 'return',
        status: 'pending',
        created_at: oldIso,
        last_attempt_at: oldIso,
      },
      {
        id: 'log-pending-fresh',
        document_id: '11111111-1111-1111-1111-111111111125',
        return_id: '33333333-3333-3333-3333-333333333325',
        email_type: 'return',
        status: 'pending',
        created_at: freshIso,
        last_attempt_at: freshIso,
      }
    );

    const result = await recoverStalePendingReturnEmails({ limit: 10 });

    assert.deepEqual(result, { supported: true, scanned: 1, recovered: 1 });
    assert.equal(logs.find((log) => log.id === 'log-pending-old').status, 'uncertain');
    assert.equal(logs.find((log) => log.id === 'log-pending-fresh').status, 'pending');
  });

  it('membaca konfigurasi SMTP dari environment Vercel dan membersihkan spasi', () => {
    const saved = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_SECURE: process.env.SMTP_SECURE,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      SMTP_FROM: process.env.SMTP_FROM,
      SMTP_TLS_REJECT_UNAUTHORIZED: process.env.SMTP_TLS_REJECT_UNAUTHORIZED,
    };

    try {
      process.env.SMTP_HOST = '  smtp-relay.brevo.com  ';
      process.env.SMTP_PORT = ' 465 ';
      process.env.SMTP_SECURE = ' TRUE ';
      process.env.SMTP_USER = ' user@tenant.test ';
      process.env.SMTP_PASS = ' secret ';
      process.env.SMTP_FROM = ' Retur <retur@tenant.test> ';
      process.env.SMTP_TLS_REJECT_UNAUTHORIZED = 'FALSE';

      const config = getSmtpConfig();
      assert.equal(config.host, 'smtp-relay.brevo.com');
      assert.equal(config.port, 465);
      assert.equal(config.secure, true);
      assert.equal(config.user, 'user@tenant.test');
      assert.equal(config.pass, 'secret');
      assert.equal(config.from, 'Retur <retur@tenant.test>');
      assert.equal(config.tlsRejectUnauthorized, false);
    } finally {
      Object.entries(saved).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it('fallback penerima ke petugas jika email finance tidak tersedia', async () => {
    const doc = {
      id: '11111111-1111-1111-1111-111111111113',
      document_number: 'SJ-003',
      document_type: 'goods_out',
      contact_name: 'Pelanggan C',
      items: [],
    };
    const returnRecord = {
      id: '33333333-3333-3333-3333-333333333335',
      returnNumber: 'RET-SJ-003-R01',
      returnedAt: '2026-10-20T05:00:00.000Z',
      reason: 'lainnya',
      notes: 'Retur uji',
      items: [],
    };

    const result = await sendReturnEmail({
      doc,
      returnRecord,
      creatorEmail: 'staff@tenant.test',
      creatorName: 'Petugas Gudang',
      financeEmail: null,
      warehouseName: 'Gudang Utama',
    });

    assert.equal(result.status, 'sent');
    assert.equal(sentMails[0].to, 'staff@tenant.test');
    assert.equal(sentMails[0].cc, undefined);
    assert.match(sentMails[0].text, /Alasan\s+: Lainnya/);
  });
});

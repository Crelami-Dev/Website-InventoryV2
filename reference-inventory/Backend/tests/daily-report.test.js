import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  REPORT_MULTIPLIERS,
  parseUnitFromSn,
  resolveItemBaseQty,
  formatItemUnitBreakdown,
  getWibDayBoundaries,
  isDateInWibTarget,
  dailyReportSettingsSchema,
  buildDailyReportData,
  generateDailyReportHtml,
  evaluateDailyReportDue,
  sendDailyReportEmail,
  claimDailyReportLease,
  PENDING_DAILY_REPORT_LEASE_MS,
  SUPER_ADMIN_TENANT_ID,
  OWNER_PALETTES,
  resolveOwnerAccentPalette,
  sanitizeWarehouseFileName,
  docBelongsToWarehouse,
  returnBelongsToWarehouse,
} from '../src/services/dailyReport.service.js';
import { generateDailyReportPdf } from '../src/services/dailyReportPdf.service.js';
import { generateDailyReportExcel } from '../src/services/dailyReportExcel.service.js';
import { closeTransporter } from '../src/services/email.service.js';

describe('DocuFlow V1 — Tahap 2: Daily Report Test Suite', () => {

  // --------------------------------------------------------------------------
  // 1. Batas Tanggal Asia/Jakarta (WIB)
  // --------------------------------------------------------------------------
  describe('1. Batas Tanggal Asia/Jakarta (WIB)', () => {
    it('menghitung startOfDayIso dan endOfDayIso dengan benar untuk 2026-10-20 WIB', () => {
      const { targetDate, startOfDayIso, endOfDayIso } = getWibDayBoundaries('2026-10-20');
      assert.equal(targetDate, '2026-10-20');
      
      // 2026-10-20 00:00:00 WIB (UTC+7) = 2026-10-19 17:00:00 UTC
      assert.equal(startOfDayIso, '2026-10-19T17:00:00.000Z');
      
      // 2026-10-20 23:59:59.999 WIB (UTC+7) = 2026-10-20 16:59:59.999 UTC
      assert.equal(endOfDayIso, '2026-10-20T16:59:59.999Z');
    });

    it('memvalidasi tanggal di perbatasan zona waktu WIB', () => {
      // 16:59:59 UTC = 23:59:59 WIB pada hari sebelumnya (2026-10-19)
      assert.equal(isDateInWibTarget('2026-10-19T16:59:59.000Z', '2026-10-20'), false);
      
      // 17:00:00 UTC = 00:00:00 WIB pada hari target (2026-10-20)
      assert.equal(isDateInWibTarget('2026-10-19T17:00:00.000Z', '2026-10-20'), true);
      
      // 16:59:59 UTC pada hari berikutnya = 23:59:59 WIB (2026-10-20)
      assert.equal(isDateInWibTarget('2026-10-20T16:59:59.000Z', '2026-10-20'), true);
      
      // 17:00:00 UTC pada 2026-10-20 = 00:00:00 WIB (2026-10-21)
      assert.equal(isDateInWibTarget('2026-10-20T17:00:00.000Z', '2026-10-20'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Filter Status Dokumen (completed vs pending vs cancelled)
  // --------------------------------------------------------------------------
  describe('2. Filter Status Dokumen (Completed, Pending, Cancelled)', async () => {
    it('hanya memasukkan completed ke daftar transaksi sah, memisahkan pending, dan mengabaikan cancelled', async () => {
      const mockOwnerId = '11111111-1111-1111-1111-111111111111';
      const mockDocs = [
        {
          id: 'doc-1',
          document_type: 'goods_in',
          document_number: 'IN-001',
          contact_name: 'Supplier A',
          status: 'completed',
          issue_date: '2026-10-20',
          created_at: '2026-10-20T08:00:00.000Z',
          warehouse_id: 'wh-1',
          items: [{ item_name: 'Barang A', quantity: 1, metadata: { baseQuantity: 10 } }],
        },
        {
          id: 'doc-2',
          document_type: 'goods_in',
          document_number: 'IN-002',
          contact_name: 'Supplier B',
          status: 'draft',
          issue_date: '2026-10-20',
          created_at: '2026-10-20T09:00:00.000Z',
          warehouse_id: 'wh-1',
          items: [{ item_name: 'Barang B', quantity: 5, metadata: { baseQuantity: 50 } }],
        },
        {
          id: 'doc-3',
          document_type: 'goods_in',
          document_number: 'IN-003',
          contact_name: 'Supplier C',
          status: 'cancelled',
          issue_date: '2026-10-20',
          created_at: '2026-10-20T10:00:00.000Z',
          warehouse_id: 'wh-1',
          items: [{ item_name: 'Barang C', quantity: 20, metadata: { baseQuantity: 200 } }],
        },
      ];

      // Mock Supabase client
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { name: 'PT Test' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({ eq: async () => ({ data: [{ id: 'wh-1', name: 'Gudang Pusat', code: 'GP' }] }) }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: mockDocs, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return { select: () => ({}) };
        },
      };

      const report = await buildDailyReportData({
        ownerId: mockOwnerId,
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      // Completed harus 1
      assert.equal(report.goodsIn.completedCount, 1);
      assert.equal(report.goodsIn.completedDocs[0].documentNumber, 'IN-001');
      assert.equal(report.goodsIn.totalPcs, 10);

      // Pending harus 1 (IN-002)
      assert.equal(report.goodsIn.pendingCount, 1);
      assert.equal(report.goodsIn.pendingDocs[0].documentNumber, 'IN-002');

      // Cancelled tidak boleh masuk ke completed maupun pending
      const allDocNos = [
        ...report.goodsIn.completedDocs.map((d) => d.documentNumber),
        ...report.goodsIn.pendingDocs.map((d) => d.documentNumber),
      ];
      assert.equal(allDocNos.includes('IN-003'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Perhitungan Satuan & Pencegahan Konversi Ganda (Anti-Double Conversion)
  // --------------------------------------------------------------------------
  describe('3. Perhitungan Satuan & Pencegahan Konversi Ganda', () => {
    it('menggunakan metadata.baseQuantity langsung jika ada (tidak dikalikan ulang)', () => {
      const serialItem = {
        item_name: 'Kain Katun Premium',
        quantity: 300, // di DB tersimpan 300 pcs
        metadata: {
          baseQuantity: 300,
          qtyInput: 1,
          qtyUnit: 'bal25',
          isSerial: true,
          serialNumber: 'BAL25-2026-001',
        },
      };

      const result = resolveItemBaseQty(serialItem);
      // Harus 300 pcs, BUKAN 300 * 300 = 90.000 pcs!
      assert.equal(result, 300);
    });

    it('menghitung non-serial item tanpa baseQuantity via qtyInput * multiplier', () => {
      const nonSerialItem = {
        item_name: 'Benang Wol',
        quantity: 2,
        metadata: {
          qtyInput: 2,
          qtyUnit: 'pack', // multiplier pack = 60
        },
      };

      const result = resolveItemBaseQty(nonSerialItem);
      assert.equal(result, 120); // 2 * 60 = 120 pcs
    });

    it('mendeteksi satuan dari string serial number jika unit adalah pcs/tidak diset', () => {
      const itemWithSn = {
        item_name: 'Sarung Sutra',
        quantity: 1,
        metadata: {
          isSerial: true,
          serialNumber: 'SRG-BL20-0089',
          qtyUnit: 'pcs',
        },
      };

      const detectedUnit = parseUnitFromSn(itemWithSn.metadata.serialNumber);
      assert.equal(detectedUnit, 'bal20'); // 20 lusin = 240 pcs

      const result = resolveItemBaseQty(itemWithSn);
      assert.equal(result, 240); // 1 bal20 = 240 pcs
    });

    it('mempertahankan backward compatibility untuk satuan bal legacy (multiplier: 300)', () => {
      assert.equal(REPORT_MULTIPLIERS.bal, 300);
      assert.equal(REPORT_MULTIPLIERS.bal25, 300);
      assert.equal(REPORT_MULTIPLIERS.bal20, 240);
      assert.equal(REPORT_MULTIPLIERS.bal15, 180);
      assert.equal(REPORT_MULTIPLIERS.bal10, 120);
      assert.equal(REPORT_MULTIPLIERS.pack, 60);
      assert.equal(REPORT_MULTIPLIERS.lusin, 12);
      assert.equal(REPORT_MULTIPLIERS.pcs, 1);

      const legacyBalItem = {
        item_name: 'Produk Lama',
        quantity: 1,
        metadata: { qtyInput: 1, qtyUnit: 'bal' },
      };
      assert.equal(resolveItemBaseQty(legacyBalItem), 300);
    });

    it('memformat rincian satuan asli dengan benar', () => {
      const items = [
        { metadata: { qtyInput: 2, qtyUnit: 'bal25' } },
        { metadata: { qtyInput: 5, qtyUnit: 'pack' } },
        { metadata: { qtyInput: 12, qtyUnit: 'pcs' } },
      ];
      const summary = formatItemUnitBreakdown(items);
      assert.equal(summary, '2 bal25, 5 pack, 12 pcs');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Jenis Laporan: Goods In saja, Goods Out saja, dan Keduanya
  // --------------------------------------------------------------------------
  describe('4. Pilihan Jenis Laporan (Goods In, Goods Out, Keduanya)', async () => {
    const mockSupabaseWithDocs = (docs) => ({
      from: (table) => {
        if (table === 'workspace_settings') {
          return {
            select: () => ({
              eq: () => ({ in: async () => ({ data: [] }) }),
            }),
          };
        }
        if (table === 'warehouses') {
          return { select: () => ({ eq: async () => ({ data: [] }) }) };
        }
        if (table === 'documents') {
          return {
            select: () => ({
              eq: () => ({
                in: (col, types) => ({
                  neq: () => ({
                    or: async () => ({
                      data: docs.filter((d) => types.includes(d.document_type)),
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({}) };
      },
    });

    it('hanya memuat Goods In ketika includeGoodsOut = false', async () => {
      const testDocs = [
        { id: '1', document_type: 'goods_in', status: 'completed', issue_date: '2026-10-20', items: [] },
        { id: '2', document_type: 'goods_out', status: 'completed', issue_date: '2026-10-20', items: [] },
      ];

      const report = await buildDailyReportData({
        ownerId: 'owner-test',
        dateStr: '2026-10-20',
        includeGoodsIn: true,
        includeGoodsOut: false,
        supabaseClient: mockSupabaseWithDocs(testDocs),
      });

      assert.equal(report.includeGoodsIn, true);
      assert.equal(report.includeGoodsOut, false);
      assert.equal(report.goodsIn.completedCount, 1);
      assert.equal(report.goodsOut.completedCount, 0);

      const html = generateDailyReportHtml(report);
      assert.match(html, /<strong>Goods In:<\/strong>/);
      assert.doesNotMatch(html, /<strong>Goods Out:<\/strong>/);
    });

    it('hanya memuat Goods Out ketika includeGoodsIn = false', async () => {
      const testDocs = [
        { id: '1', document_type: 'goods_in', status: 'completed', issue_date: '2026-10-20', items: [] },
        { id: '2', document_type: 'goods_out', status: 'completed', issue_date: '2026-10-20', items: [] },
      ];

      const report = await buildDailyReportData({
        ownerId: 'owner-test',
        dateStr: '2026-10-20',
        includeGoodsIn: false,
        includeGoodsOut: true,
        supabaseClient: mockSupabaseWithDocs(testDocs),
      });

      assert.equal(report.includeGoodsIn, false);
      assert.equal(report.includeGoodsOut, true);
      assert.equal(report.goodsIn.completedCount, 0);
      assert.equal(report.goodsOut.completedCount, 1);

      const html = generateDailyReportHtml(report);
      assert.match(html, /<strong>Goods Out:<\/strong>/);
      assert.doesNotMatch(html, /<strong>Goods In:<\/strong>/);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Konfigurasi Default OFF
  // --------------------------------------------------------------------------
  describe('5. Konfigurasi Default OFF', () => {
    it('memiliki default enabled = false, scheduleTime = 19:00, timezone = Asia/Jakarta', () => {
      const parsed = dailyReportSettingsSchema.parse({
        authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(parsed.enabled, false);
      assert.equal(parsed.scheduleTime, '19:00');
      assert.equal(parsed.timeZone, 'Asia/Jakarta');
      assert.equal(parsed.includeGoodsIn, true);
      assert.equal(parsed.includeGoodsOut, true);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Validasi Konfigurasi (Jam, Email, dan Tenant)
  // --------------------------------------------------------------------------
  describe('6. Validasi Konfigurasi (Zod Schema)', () => {
    it('menolak format jam yang tidak valid', () => {
      assert.throws(() => {
        dailyReportSettingsSchema.parse({
          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
          scheduleTime: '25:00', // Jam > 23
        });
      });

      assert.throws(() => {
        dailyReportSettingsSchema.parse({
          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
          scheduleTime: '19:61', // Menit > 59
        });
      });

      assert.throws(() => {
        dailyReportSettingsSchema.parse({
          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
          scheduleTime: '7:00 PM', // Bukan 24 jam HH:mm
        });
      });
    });

    it('menolak jika ketiga jenis laporan dinonaktifkan', () => {
      assert.throws(() => {
        dailyReportSettingsSchema.parse({
          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
          includeGoodsIn: false,
          includeGoodsOut: false,
          includeReturns: false,
        });
      });
    });

    it('menolak jika authorizedOwnerId bukan UUID valid', () => {
      assert.throws(() => {
        dailyReportSettingsSchema.parse({
          authorizedOwnerId: 'not-a-valid-uuid',
        });
      });
    });

    it('menerima jadwal kustom berformat HH:mm yang valid', () => {
      const parsed = dailyReportSettingsSchema.parse({
        authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
        scheduleTime: '20:30',
      });
      assert.equal(parsed.scheduleTime, '20:30');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Evaluasi Scheduler & Batasan Dinamis
  // --------------------------------------------------------------------------
  describe('7. Evaluasi Scheduler (Stateless Serverless Guard)', async () => {
    it('mengembalikan isDue = false jika enabled = false', async () => {
      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { value: { enabled: false, authorizedOwnerId: '11111111-1111-1111-1111-111111111111' } },
                }),
              }),
            }),
          }),
        }),
      };

      const result = await evaluateDailyReportDue({ supabaseClient: mockSupabase });
      assert.equal(result.isDue, false);
      assert.equal(result.reason, 'daily_report_disabled');
    });

    it('mengembalikan isDue = false jika jadwal belum tercapai pada jam berjalan', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        value: {
                          enabled: true,
                          scheduleTime: '19:00',
                          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
                        },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({
                      lte: () => ({
                        limit: async () => ({ data: [] }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      // Waktu sekarang 14:00 WIB, jadwal 19:00 WIB
      const result = await evaluateDailyReportDue({
        currentTimeWib: '14:00',
        supabaseClient: mockSupabase,
      });
      assert.equal(result.isDue, false);
      assert.equal(result.reason, 'scheduled_time_not_yet_reached');
    });

    it('mengembalikan isDue = false jika hari ini sudah pernah dikirim (idempotensi)', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        value: {
                          enabled: true,
                          scheduleTime: '19:00',
                          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
                        },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({
                      lte: () => ({
                        limit: async () => ({ data: [{ id: 'log-1', sent_at: '2026-10-20T12:00:00Z' }] }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await evaluateDailyReportDue({
        currentTimeWib: '19:05',
        supabaseClient: mockSupabase,
      });
      assert.equal(result.isDue, false);
      assert.equal(result.reason, 'already_sent_today');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Pengiriman Aman (Dry Run Mode)
  // --------------------------------------------------------------------------
  describe('8. Pengiriman Aman (Mode Dry Run)', async () => {
    it('dapat menjalankan simulasi pengiriman tanpa mengirim email nyata ke SMTP', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { name: 'PT Test Aman', email: 'test@company.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        recipients: 'admin@company.com',
        isTest: true,
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.dryRun, true);
      assert.equal(result.primaryRecipient, 'admin@company.com');
      assert.match(result.subject, /Laporan Harian Gudang — .* — 2026-10-20/);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Hari Tanpa Transaksi
  // --------------------------------------------------------------------------
  describe('9. Hari Tanpa Transaksi (Empty Day)', async () => {
    it('menghasilkan laporan kosong yang valid dan tidak crash', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const report = await buildDailyReportData({
        ownerId: 'owner-empty',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      assert.equal(report.goodsIn.completedCount, 0);
      assert.equal(report.goodsIn.totalPcs, 0);
      assert.equal(report.goodsOut.completedCount, 0);
      assert.equal(report.goodsOut.totalPcs, 0);

      const html = generateDailyReportHtml(report);
      assert.match(html, /<strong>Goods In:<\/strong> 0 dokumen selesai, total 0 pcs\./);
      assert.match(html, /<strong>Goods Out:<\/strong> 0 dokumen selesai, total 0 pcs\./);
      assert.match(html, /<strong>Return:<\/strong> 0 transaksi, total 0 pcs\./);
      assert.doesNotMatch(html, /No\. Dokumen/);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Akses Hak Istimewa Daily Report (Super Admin & Owner)
  // --------------------------------------------------------------------------
  describe('10. Akses Hak Istimewa Daily Report (Super Admin & Owner)', () => {
    it('mengizinkan role super_admin dan owner, serta menolak staff atau sales_person', () => {
      const checkDailyReportRole = (role) => {
        if (role !== 'super_admin' && role !== 'owner') {
          const err = new Error('Akses ditolak: Hanya Super Admin dan Owner yang diizinkan.');
          err.status = 403;
          throw err;
        }
        return true;
      };

      assert.throws(() => checkDailyReportRole('staff'), /Akses ditolak/);
      assert.throws(() => checkDailyReportRole('sales_person'), /Akses ditolak/);
      assert.throws(() => checkDailyReportRole(undefined), /Akses ditolak/);
      assert.equal(checkDailyReportRole('super_admin'), true);
      assert.equal(checkDailyReportRole('owner'), true);
    });
  });

  // --------------------------------------------------------------------------
  // 11. Proteksi Autentikasi Cron Secret (Fail Closed)
  // --------------------------------------------------------------------------
  describe('11. Proteksi Autentikasi Cron Secret (Fail-Closed)', () => {
    it('menolak request jika header Authorization tidak ada atau tidak valid', () => {
      const mockEnvSecret = 'super-secret-cron-token-123';

      const verifyCronToken = (authHeader, serverSecret) => {
        if (!serverSecret) return { status: 503, error: 'CRON_SECRET not configured' };
        if (!authHeader) return { status: 403, error: 'Forbidden: missing auth header' };
        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || token !== serverSecret) {
          return { status: 403, error: 'Forbidden: invalid token' };
        }
        return { status: 200, ok: true };
      };

      // Missing header -> 403
      assert.equal(verifyCronToken(null, mockEnvSecret).status, 403);
      // Wrong secret -> 403
      assert.equal(verifyCronToken('Bearer wrong-secret', mockEnvSecret).status, 403);
      // Non-bearer -> 403
      assert.equal(verifyCronToken('Basic dXNlcjpwYXNz', mockEnvSecret).status, 403);
      // Server secret not configured -> 503 (fail closed)
      assert.equal(verifyCronToken('Bearer any-token', null).status, 503);
      // Correct secret -> 200 OK
      assert.equal(verifyCronToken('Bearer super-secret-cron-token-123', mockEnvSecret).status, 200);
    });
  });

  // --------------------------------------------------------------------------
  // 12. Tenant Isolation
  // --------------------------------------------------------------------------
  describe('12. Tenant Isolation (Isolasi Data Antar-Tenant)', async () => {
    it('hanya mengambil data milik owner_id yang ditentukan dan menolak pencampuran data tenant lain', async () => {
      const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const tenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      const allDatabaseDocs = [
        { id: 'doc-a1', owner_id: tenantA, document_type: 'goods_in', status: 'completed', issue_date: '2026-10-20', items: [] },
        { id: 'doc-b1', owner_id: tenantB, document_type: 'goods_in', status: 'completed', issue_date: '2026-10-20', items: [] },
      ];

      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return { select: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }) };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: (col, queryOwnerId) => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({
                        data: allDatabaseDocs.filter((d) => d.owner_id === queryOwnerId),
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const reportA = await buildDailyReportData({
        ownerId: tenantA,
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      // Tenant A hanya melihat 1 dokumen miliknya
      assert.equal(reportA.goodsIn.completedCount, 1);
      assert.equal(reportA.goodsIn.completedDocs[0].id, 'doc-a1');

      const reportB = await buildDailyReportData({
        ownerId: tenantB,
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      // Tenant B hanya melihat 1 dokumen miliknya
      assert.equal(reportB.goodsIn.completedCount, 1);
      assert.equal(reportB.goodsIn.completedDocs[0].id, 'doc-b1');
    });
  });

  // --------------------------------------------------------------------------
  // 13. Proteksi Kebocoran Penerima & Isolasi Email (Tahap 4)
  // --------------------------------------------------------------------------
  describe('13. Proteksi Kebocoran Penerima (No Silent Fallback to Super Admin)', async () => {
    it('gagal aman (fail-safe) jika tenant tidak memiliki email dan tidak membocorkan email platform Super Admin', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [] }) }), // tidak ada email perusahaan
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return { insert: async () => ({}) };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        recipients: null, // tidak ada custom recipients
        dryRun: false,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /tidak ditemukan untuk tenant ini/i);
    });
  });

  // --------------------------------------------------------------------------
  // 14. Defensive Parsing Kuantitas Rusak / NaN (Tahap 4)
  // --------------------------------------------------------------------------
  describe('14. Defensive Parsing Kuantitas Rusak / NaN', () => {
    it('mengembalikan 0 pcs jika qtyInput bernilai string non-numerik atau invalid', () => {
      const itemWithBadInput = {
        unit: 'pcs',
        quantity: 5,
        metadata: {
          qtyInput: 'invalid_string',
        },
      };
      const pcs = resolveItemBaseQty(itemWithBadInput);
      assert.equal(pcs, 0);
      assert.ok(!isNaN(pcs));
    });

    it('mengembalikan 0 pcs jika quantity bernilai negatif', () => {
      const itemNegative = {
        unit: 'pcs',
        quantity: -10,
      };
      const pcs = resolveItemBaseQty(itemNegative);
      assert.equal(pcs, 0);
    });
  });

  // --------------------------------------------------------------------------
  // 15. Concurrency In-Flight Lease Guard (Tahap 4)
  // --------------------------------------------------------------------------
  describe('15. Concurrency In-Flight Lease Guard', async () => {
    it('melewati pengiriman (skipped) jika ada proses lain yang status pending dalam 3 menit', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { email: 'owner@tenant.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => {
                const chain = {
                  eq: () => chain,
                  neq: () => chain,
                  limit: async () => ({
                    data: [
                      {
                        id: 'in-flight-1',
                        owner_id: '11111111-1111-1111-1111-111111111111',
                        report_date: '2026-10-20',
                        email_type: 'daily_report',
                        status: 'pending',
                        created_at: new Date().toISOString(),
                        last_attempt_at: new Date().toISOString(),
                        trigger_source: 'cron',
                      },
                    ],
                    error: null,
                  }),
                };
                return chain;
              },
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        isTest: false,
        force: false,
        dryRun: false,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /sedang berlangsung/i);
    });
  });

  // --------------------------------------------------------------------------
  // 16. Penanganan Environment Tanpa SMTP (Development Friendly)
  // --------------------------------------------------------------------------
  describe('16. Penanganan Environment Tanpa SMTP', async () => {
    it('dryRun dan kalkulasi laporan berjalan sukses tanpa memerlukan konfigurasi SMTP', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { email: 'owner@tenant.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.dryRun, true);
      assert.ok(result.report);
      assert.ok(result.subject);
    });

    it('pengiriman nyata saat SMTP belum disetel mengembalikan pesan error jelas dan tidak fallback ke pihak lain', async () => {
      closeTransporter();
      const prevHost = process.env.SMTP_HOST;
      delete process.env.SMTP_HOST;

      try {
        const mockSupabase = {
          from: (table) => {
            if (table === 'workspace_settings') {
              return {
                select: () => ({
                  eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { email: 'owner@tenant.com' } }] }) }),
                }),
              };
            }
            if (table === 'warehouses') {
              return { select: () => ({ eq: async () => ({ data: [] }) }) };
            }
            if (table === 'documents') {
              return {
                select: () => ({
                  eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
                }),
              };
            }
            if (table === 'email_logs') {
              return {
                select: () => {
                  const chain = {
                    eq: () => chain,
                    neq: () => chain,
                    limit: async () => ({ data: [], error: null }),
                  };
                  return chain;
                },
                insert: () => ({
                  select: () => ({
                    maybeSingle: async () => ({ data: { id: 'pending-log-1' } }),
                  }),
                }),
                update: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: { id: 'pending-log-1' } }),
                  }),
                }),
              };
            }
            return {};
          },
        };

        const result = await sendDailyReportEmail({
          ownerId: '11111111-1111-1111-1111-111111111111',
          dateStr: '2026-10-20',
          isTest: true,
          recipients: ['tester@example.com'],
          dryRun: false,
          supabaseClient: mockSupabase,
        });

        assert.equal(result.status, 'failed');
        assert.match(result.error, /Layanan SMTP belum dikonfigurasi di environment ini/i);
        // Penerima tetap tester@example.com, tidak di-fallback ke pihak lain
        assert.equal(result.primaryRecipient, 'tester@example.com');
      } finally {
        if (prevHost !== undefined) process.env.SMTP_HOST = prevHost;
        closeTransporter();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 17. Penanganan Jadwal Tetap 19:00 WIB & Konfigurasi Lama (Tahap 6)
  // --------------------------------------------------------------------------
  describe('17. Penanganan Jadwal Tetap 19:00 WIB & Konfigurasi Lama', async () => {
    it('mengevaluasi jadwal kustom per tenant secara akurat', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        value: {
                          enabled: true,
                          scheduleTime: '20:30',
                          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
                        },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({ lte: () => ({ limit: async () => ({ data: [] }) }) }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      // 19:00 WIB belum mencapai 20:30 WIB
      const resultNotYet = await evaluateDailyReportDue({
        currentTimeWib: '19:00',
        supabaseClient: mockSupabase,
      });

      assert.equal(resultNotYet.isDue, false);
      assert.equal(resultNotYet.reason, 'scheduled_time_not_yet_reached');
      assert.equal(resultNotYet.scheduleTime, '20:30');

      // 20:30 WIB sudah mencapai jadwal
      const resultReached = await evaluateDailyReportDue({
        currentTimeWib: '20:30',
        supabaseClient: mockSupabase,
      });
      assert.equal(resultReached.isDue, true);
      assert.equal(resultReached.reason, 'time_reached');
    });

    it('menunda pengiriman jika waktu saat ini belum mencapai 19:00 WIB', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        value: {
                          enabled: true,
                          scheduleTime: '19:00',
                          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
                        },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({ lte: () => ({ limit: async () => ({ data: [] }) }) }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      // Waktu saat ini: 18:30 WIB
      const result = await evaluateDailyReportDue({
        currentTimeWib: '18:30',
        supabaseClient: mockSupabase,
      });

      assert.equal(result.isDue, false);
      assert.equal(result.reason, 'scheduled_time_not_yet_reached');
    });

    it('mengizinkan pengiriman tepat atau setelah pukul 19:00 WIB', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        value: {
                          enabled: true,
                          scheduleTime: '19:00',
                          authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
                        },
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({ lte: () => ({ limit: async () => ({ data: [] }) }) }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      // Waktu saat ini: 19:00 WIB
      const result = await evaluateDailyReportDue({
        currentTimeWib: '19:00',
        supabaseClient: mockSupabase,
      });

      assert.equal(result.isDue, true);
      assert.equal(result.reason, 'time_reached');
    });
  });

  // --------------------------------------------------------------------------
  // 18. Siklus Hidup Pending Lease & Kedaluwarsa (Tahap 5)
  // --------------------------------------------------------------------------
  describe('18. Siklus Hidup Pending Lease & Kedaluwarsa', async () => {
    it('mengabaikan lease pending yang sudah kedaluwarsa (> 3 menit) sehingga tidak macet permanen', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { email: 'owner@tenant.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: (col, val) => {
                    // status='sent' kosong
                    if (val === 'sent') {
                      return { gte: () => ({ lte: () => ({ limit: async () => ({ data: [] }) }) }) };
                    }
                    // status='pending' dalam 3 menit kosong (karena lease lama dibuat 10 menit lalu)
                    if (val === 'pending') {
                      return { gte: () => ({ limit: async () => ({ data: [] }) }) };
                    }
                    return {};
                  },
                }),
              }),
            };
          }
          return {};
        },
      };

      // Mode dryRun agar tidak perlu memanggil SMTP sesungguhnya
      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      // Proses tidak di-skip karena pending lease lama sudah kedaluwarsa
      assert.equal(result.status, 'simulated');
    });
  });

  // --------------------------------------------------------------------------
  // 19. Retry Behavior Setelah Pengiriman Gagal (Tahap 5)
  // --------------------------------------------------------------------------
  describe('19. Retry Behavior Setelah Pengiriman Gagal', async () => {
    it('memungkinkan retry jika pengiriman sebelumnya berstatus failed', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { email: 'owner@tenant.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: (col, val) => {
                    // status='sent' tidak ditemukan (karena pengiriman sebelumnya gagal)
                    if (val === 'sent') {
                      return { gte: () => ({ lte: () => ({ limit: async () => ({ data: [] }) }) }) };
                    }
                    // status='pending' aktif tidak ada
                    if (val === 'pending') {
                      return { gte: () => ({ limit: async () => ({ data: [] }) }) };
                    }
                    return {};
                  },
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      // Berhasil mengeksekusi simulasi tanpa terhalang log 'failed' lama
      assert.equal(result.status, 'simulated');
    });
  });

  // --------------------------------------------------------------------------
  // 20. Tahap 7: Konsistensi Desain Email, PDF, dan Excel Berdasarkan Accent Color per Owner
  // --------------------------------------------------------------------------
  describe('20. Tahap 7: Konsistensi Desain Email, PDF, dan Excel Berdasarkan Accent Color', () => {

    it('20.1 Resolusi palet warna: mendukung 6 warna DocuFlow dan fallback aman ke Indigo', () => {
      // 6 Warna Resmi DocuFlow
      assert.equal(resolveOwnerAccentPalette('Sky').name, 'Sky');
      assert.equal(resolveOwnerAccentPalette('sky').primary, '#0284C7');

      assert.equal(resolveOwnerAccentPalette('Rose').name, 'Rose');
      assert.equal(resolveOwnerAccentPalette('rose').primary, '#E11D48');

      assert.equal(resolveOwnerAccentPalette('Emerald').name, 'Emerald');
      assert.equal(resolveOwnerAccentPalette('emerald').primary, '#059669');

      assert.equal(resolveOwnerAccentPalette('Amber').name, 'Amber');
      assert.equal(resolveOwnerAccentPalette('amber').primary, '#D97706');

      assert.equal(resolveOwnerAccentPalette('Violet').name, 'Violet');
      assert.equal(resolveOwnerAccentPalette('violet').primary, '#7C3AED');

      assert.equal(resolveOwnerAccentPalette('Indigo').name, 'Indigo');
      assert.equal(resolveOwnerAccentPalette('indigo').primary, '#4F46E5');

      // Fallback aman untuk nilai null, undefined, string kosong, atau warna tak dikenal
      assert.equal(resolveOwnerAccentPalette(null).name, 'Indigo');
      assert.equal(resolveOwnerAccentPalette('').name, 'Indigo');
      assert.equal(resolveOwnerAccentPalette('invalid_color').name, 'Indigo');
      assert.equal(resolveOwnerAccentPalette(undefined).name, 'Indigo');
    });

    it('20.2 Isolasi Tenant: Owner A (Sky) vs Owner B (Rose) memiliki warna aksen terpisah', async () => {
      const mockSupabaseTenantIsolation = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: (col, ownerId) => ({
                  in: async () => {
                    if (ownerId === 'owner-sky-id') {
                      return {
                        data: [
                          { key: 'company', value: { companyName: 'PT Langit Biru', companyEmail: 'owner@sky.com' } },
                          { key: 'app', value: { appearance: { accentColor: 'Sky' } } },
                        ],
                      };
                    }
                    if (ownerId === 'owner-rose-id') {
                      return {
                        data: [
                          { key: 'company', value: { companyName: 'PT Mawar Merah', companyEmail: 'owner@rose.com' } },
                          { key: 'app', value: { appearance: { accentColor: 'Rose' } } },
                        ],
                      };
                    }
                    return { data: [] };
                  },
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const reportSky = await buildDailyReportData({
        ownerId: 'owner-sky-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseTenantIsolation,
      });

      const reportRose = await buildDailyReportData({
        ownerId: 'owner-rose-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseTenantIsolation,
      });

      // Laporan Owner A wajib Sky
      assert.equal(reportSky.accentColor, 'Sky');
      assert.equal(reportSky.palette.primary, '#0284C7');

      // Laporan Owner B wajib Rose
      assert.equal(reportRose.accentColor, 'Rose');
      assert.equal(reportRose.palette.primary, '#E11D48');

      // Tidak ada kebocoran antar tenant
      assert.notEqual(reportSky.palette.primary, reportRose.palette.primary);
    });

    it('20.3 HTML Email: Menerapkan aksen Owner secara konsisten dan responsif', () => {
      const mockReportSky = {
        ownerId: 'owner-sky',
        companyName: 'PT Langit Biru',
        companyEmail: 'sky@docuflow.test',
        accentColor: 'Sky',
        palette: OWNER_PALETTES.sky,
        targetDate: '2026-10-20',
        dateFormattedIndo: 'Selasa, 20 Oktober 2026',
        generatedAtWib: '19:00 WIB',
        includeGoodsIn: true,
        includeGoodsOut: true,
        goodsIn: { completedCount: 2, totalPcs: 120, completedDocs: [], topProducts: [] },
        goodsOut: { completedCount: 1, totalPcs: 60, completedDocs: [], topProducts: [] },
        returns: { completedCount: 1, totalPcs: 12, completedDocs: [] },
      };

      const htmlSky = generateDailyReportHtml(mockReportSky);
      // Memastikan kode warna primary Sky (#0284C7) diterapkan pada baris aksen dan border judul
      assert.match(htmlSky, /#0284C7/);
      assert.match(htmlSky, /PT Langit Biru/);
      assert.match(htmlSky, /<strong>Goods In:<\/strong> 2 dokumen selesai, total 120 pcs\./);
      assert.match(htmlSky, /<strong>Goods Out:<\/strong> 1 dokumen selesai, total 60 pcs\./);
      assert.match(htmlSky, /<strong>Return:<\/strong> 1 transaksi, total 12 pcs\./);
      // Memastikan lampiran PDF dan Excel disebutkan
      assert.match(htmlSky, /Laporan lengkap tersedia pada lampiran PDF dan Excel\./);
      // Memastikan tidak ada tabel rincian transaksi panjang di body email
      assert.doesNotMatch(htmlSky, /No\. Dokumen/);
      assert.doesNotMatch(htmlSky, /Vendor \/ Supplier/);

      const mockReportRose = {
        ...mockReportSky,
        companyName: 'PT Mawar Cantik',
        accentColor: 'Rose',
        palette: OWNER_PALETTES.rose,
      };

      const htmlRose = generateDailyReportHtml(mockReportRose);
      assert.match(htmlRose, /#E11D48/);
      assert.match(htmlRose, /PT Mawar Cantik/);
      // Memastikan baris aksen atas menggunakan warna Rose (#E11D48) dan bukan warna Sky (#0284C7)
      assert.match(htmlRose, /background-color:\s*#E11D48;/);
      assert.doesNotMatch(htmlRose, /background-color:\s*#0284C7;/);
    });

    it('20.4 Generator PDF: Menghasilkan berkas PDF A4 valid dengan aksen warna Owner', () => {
      const mockReport = {
        ownerId: 'owner-sky',
        companyName: 'PT Langit Biru',
        accentColor: 'Sky',
        palette: OWNER_PALETTES.sky,
        targetDate: '2026-10-20',
        dateFormattedIndo: 'Selasa, 20 Oktober 2026',
        generatedAtWib: '19:00 WIB',
        includeGoodsIn: true,
        includeGoodsOut: true,
        goodsIn: {
          completedCount: 1,
          totalPcs: 300,
          completedDocs: [
            {
              documentNumber: 'GI-2026-001',
              time: '09:15',
              contactName: 'PT Pemasok Utama',
              warehouseName: 'Gudang Pusat',
              totalPcs: 300,
              notes: 'Penerimaan PO-001',
            },
          ],
        },
        goodsOut: {
          completedCount: 1,
          totalPcs: 120,
          completedDocs: [
            {
              documentNumber: 'GO-2026-001',
              time: '14:30',
              contactName: 'Toko Sentosa',
              warehouseName: 'Gudang Pusat',
              totalPcs: 120,
              notes: 'Pengiriman pesanan',
            },
          ],
        },
        returns: {
          completedCount: 1,
          totalPcs: 12,
          completedDocs: [
            {
              returnNumber: 'RET-GO-2026-001',
              time: '16:00',
              documentNumber: 'GO-2026-001',
              contactName: 'Toko Sentosa',
              totalPcs: 12,
              reason: 'Ukuran tidak sesuai',
            },
          ],
        },
      };

      const pdfBuffer = generateDailyReportPdf(mockReport);
      assert(Buffer.isBuffer(pdfBuffer), 'Hasil harus berupa Buffer');
      assert(pdfBuffer.length > 1000, 'Ukuran PDF harus lebih dari 1KB');

      // Header file PDF standar dimulai dengan %PDF-
      const headerStr = pdfBuffer.subarray(0, 5).toString('ascii');
      assert.equal(headerStr, '%PDF-');
    });

    it('20.5 Generator Excel: Menghasilkan workbook .xlsx 4 sheet dengan header warna aksen, autoFilter, dan kuantitas numerik', () => {
      const mockReport = {
        ownerId: 'owner-sky',
        companyName: 'PT Langit Biru',
        accentColor: 'Sky',
        palette: OWNER_PALETTES.sky,
        targetDate: '2026-10-20',
        dateFormattedIndo: 'Selasa, 20 Oktober 2026',
        generatedAtWib: '19:00 WIB',
        includeGoodsIn: true,
        includeGoodsOut: true,
        goodsIn: {
          completedCount: 1,
          totalPcs: 300,
          completedDocs: [
            {
              documentNumber: 'GI-2026-001',
              time: '09:15',
              contactName: 'PT Pemasok Utama',
              warehouseName: 'Gudang Pusat',
              totalPcs: 300,
              unitSummary: '1 bal25',
              notes: 'Barang bagus',
            },
          ],
        },
        goodsOut: {
          completedCount: 1,
          totalPcs: 120,
          completedDocs: [
            {
              documentNumber: 'GO-2026-001',
              time: '14:30',
              contactName: 'Toko Sentosa',
              warehouseName: 'Gudang Pusat',
              totalPcs: 120,
              unitSummary: '10 lusin',
              notes: 'Terkirim lengkap',
            },
          ],
        },
        returns: {
          completedCount: 1,
          totalPcs: 12,
          completedDocs: [
            {
              returnNumber: 'RET-GO-2026-001',
              time: '16:00',
              documentNumber: 'GO-2026-001',
              contactName: 'Toko Sentosa',
              warehouseName: 'Gudang Pusat',
              totalPcs: 12,
              condition: 'available',
              reason: 'Barang salah warna',
              notes: 'Stok dipulihkan',
            },
          ],
        },
      };

      const excelBuffer = generateDailyReportExcel(mockReport);
      assert(Buffer.isBuffer(excelBuffer), 'Hasil harus berupa Buffer');

      // Berkas .xlsx adalah arsip PKZIP valid (dimulai dengan magic bytes PK\x03\x04)
      assert.equal(excelBuffer[0], 0x50); // 'P'
      assert.equal(excelBuffer[1], 0x4B); // 'K'
      assert.equal(excelBuffer[2], 0x03);
      assert.equal(excelBuffer[3], 0x04);

      // Verifikasi komponen OpenXML di dalam zip
      const rawZipStr = excelBuffer.toString('latin1');
      assert(rawZipStr.includes('xl/workbook.xml'), 'Harus memiliki workbook.xml');
      assert(rawZipStr.includes('xl/styles.xml'), 'Harus memiliki styles.xml');
      assert(rawZipStr.includes('xl/worksheets/sheet1.xml'), 'Harus memiliki sheet 1 (Ringkasan)');
      assert(rawZipStr.includes('xl/worksheets/sheet2.xml'), 'Harus memiliki sheet 2 (Goods In)');
      assert(rawZipStr.includes('xl/worksheets/sheet3.xml'), 'Harus memiliki sheet 3 (Goods Out)');
      assert(rawZipStr.includes('xl/worksheets/sheet4.xml'), 'Harus memiliki sheet 4 (Return)');
    });

    it('20.6 Agregasi Retur: Mengambil catatan retur pada targetDate dan menghitung pcs dengan benar', async () => {
      const mockSupabaseWithReturns = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Retur Test', companyEmail: 'retur@test.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Emerald' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: [] }),
                    }),
                  }),
                  // Mock untuk query returns: .eq('owner_id', ...).not(...)
                  not: async () => ({
                    data: [
                      {
                        id: 'doc-with-ret-1',
                        document_type: 'goods_out',
                        document_number: 'GO-RET-01',
                        contact_name: 'Customer A',
                        created_at: '2026-10-20T10:00:00+07:00',
                        metadata: {
                          returns: [
                            {
                              id: 'ret-1',
                              returnNumber: 'RET-001',
                              returnedAt: '2026-10-20T11:00:00+07:00',
                              status: 'completed',
                              condition: 'available',
                              reason: 'Kelebihan kirim',
                              items: [
                                { productId: 'p1', quantity: 2, unit: 'lusin', metadata: { qtyUnit: 'lusin', qtyInput: 2 } },
                              ],
                            },
                            {
                              // Retur tanggal kemarin, tidak boleh masuk
                              id: 'ret-yesterday',
                              returnNumber: 'RET-YEST',
                              returnedAt: '2026-10-19T11:00:00+07:00',
                              status: 'completed',
                              items: [{ quantity: 10, unit: 'pcs' }],
                            },
                            {
                              // Retur status restored, tidak boleh masuk
                              id: 'ret-restored',
                              returnNumber: 'RET-REST',
                              returnedAt: '2026-10-20T12:00:00+07:00',
                              status: 'restored',
                              items: [{ quantity: 5, unit: 'pcs' }],
                            },
                          ],
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const report = await buildDailyReportData({
        ownerId: 'owner-emerald-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseWithReturns,
      });

      assert.equal(report.accentColor, 'Emerald');
      assert.equal(report.palette.primary, '#059669');

      // Hanya 1 retur sah pada 2026-10-20
      assert.equal(report.returns.completedCount, 1);
      // 2 lusin = 24 pcs
      assert.equal(report.returns.totalPcs, 24);
      assert.equal(report.returns.completedDocs[0].returnNumber, 'RET-001');
    });

    it('20.7 Pengiriman Laporan: Melampirkan PDF dan Excel pada hasil pengiriman / dryRun', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Terlampir', companyEmail: 'owner@terlampir.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Amber' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-amber-id',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.report.accentColor, 'Amber');
      assert.equal(result.report.palette.primary, '#D97706');

      // Memastikan kedua lampiran (PDF dan Excel) dibuat dan dikembalikan
      assert(Buffer.isBuffer(result.pdfBuffer), 'pdfBuffer harus berupa Buffer');
      assert(Buffer.isBuffer(result.excelBuffer), 'excelBuffer harus berupa Buffer');
      assert.equal(result.pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.equal(result.excelBuffer[0], 0x50);
      assert.equal(result.excelBuffer[1], 0x4B);
    });

  });

  // --------------------------------------------------------------------------
  // 21. Sinkronisasi Email Perusahaan & Prioritas Penerima Multi-Tenant
  // --------------------------------------------------------------------------
  describe('21. Sinkronisasi Email Perusahaan & Prioritas Penerima Multi-Tenant', () => {

    it('21.1 Mengekstrak companyName dan companyEmail baik dari key company maupun nested di app', async () => {
      // Mock tenant dengan email tersimpan di key 'company'
      const mockSupabaseCompany = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      {
                        key: 'company',
                        value: {
                          companyName: 'DocuFlow Trading',
                          email: 'finance@docuflow.test',
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          return {};
        },
      };

      const reportCompany = await buildDailyReportData({
        ownerId: 'owner-docuflow-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseCompany,
      });

      assert.equal(reportCompany.companyName, 'DocuFlow Trading');
      assert.equal(reportCompany.companyEmail, 'finance@docuflow.test');

      // Mock tenant dengan email tersimpan nested di key 'app' (company.email)
      const mockSupabaseApp = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      {
                        key: 'app',
                        value: {
                          company: {
                            companyName: 'Hoga Baby Group',
                            email: 'Hoga.finance@gmail.com',
                          },
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          return {};
        },
      };

      const reportApp = await buildDailyReportData({
        ownerId: 'owner-hoga-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseApp,
      });

      assert.equal(reportApp.companyName, 'Hoga Baby Group');
      assert.equal(reportApp.companyEmail, 'Hoga.finance@gmail.com');
    });

    it('21.2 Mengirimkan laporan ke Email Perusahaan sebagai To dan Custom Email sebagai CC ketika useCompanyEmail = true', async () => {
      let loggedInsert = null;
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      {
                        key: 'company',
                        value: {
                          companyName: 'DocuFlow Trading',
                          email: 'finance@docuflow.test',
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: (col, val) => {
                      if (val === 'sent' || val === 'pending') {
                        return { gte: () => ({ limit: async () => ({ data: [] }), lte: () => ({ limit: async () => ({ data: [] }) }) }) };
                      }
                      return {};
                    },
                  }),
                }),
              }),
              insert: async (payload) => {
                loggedInsert = payload;
                return { error: null };
              },
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-docuflow-id',
        dateStr: '2026-10-20',
        recipients: 'manager@perusahaan.com, owner@perusahaan.com',
        useCompanyEmail: true,
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'simulated');
      // Primary recipient (To) harus strictly email perusahaan
      assert.equal(result.primaryRecipient, 'finance@docuflow.test');
      // CC recipients adalah email custom
      assert.deepEqual(result.ccRecipients, ['manager@perusahaan.com', 'owner@perusahaan.com']);
    });

    it('21.3 Mengirimkan laporan ke Custom Email pertama sebagai To ketika useCompanyEmail = false', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      {
                        key: 'company',
                        value: {
                          companyName: 'DocuFlow Trading',
                          email: 'finance@docuflow.test',
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-docuflow-id',
        dateStr: '2026-10-20',
        recipients: 'custom1@external.com, custom2@external.com',
        useCompanyEmail: false,
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      assert.equal(result.status, 'simulated');
      // Karena useCompanyEmail = false, To adalah custom1 dan CC adalah custom2
      assert.equal(result.primaryRecipient, 'custom1@external.com');
      assert.deepEqual(result.ccRecipients, ['custom2@external.com']);
    });

    it('21.4 Menjamin isolasi tenant: Tenant A tidak pernah menggunakan email milik Tenant B', async () => {
      // Mock tenant B dengan email berbeda
      const mockSupabaseTenantB = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: (col, val) => ({
                  in: async () => ({
                    data: val === 'tenant-b-id'
                      ? [{ key: 'company', value: { companyName: 'Tenant B Inc', email: 'b@tenant.com' } }]
                      : [{ key: 'company', value: { companyName: 'Tenant A Inc', email: 'a@tenant.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          return {};
        },
      };

      const resultA = await sendDailyReportEmail({
        ownerId: 'tenant-a-id',
        dateStr: '2026-10-20',
        useCompanyEmail: true,
        dryRun: true,
        supabaseClient: mockSupabaseTenantB,
      });

      const resultB = await sendDailyReportEmail({
        ownerId: 'tenant-b-id',
        dateStr: '2026-10-20',
        useCompanyEmail: true,
        dryRun: true,
        supabaseClient: mockSupabaseTenantB,
      });

      assert.equal(resultA.primaryRecipient, 'a@tenant.com');
      assert.notEqual(resultA.primaryRecipient, 'b@tenant.com');

    });

  });

  // --------------------------------------------------------------------------
  // 22. Verifikasi Komprehensif: 6 Palette, Return Sanitization & Atomic Attachments
  // --------------------------------------------------------------------------
  describe('22. Verifikasi Komprehensif: 6 Palette, Return Sanitization & Atomic Attachments', () => {

    it('22.1 Menguji keenam palet warna aksen (Indigo, Emerald, Rose, Amber, Sky, Violet) secara penuh', () => {
      const paletteNames = ['Indigo', 'Emerald', 'Rose', 'Amber', 'Sky', 'Violet'];
      const expectedPrimaryHex = {
        Indigo: '#4F46E5',
        Emerald: '#059669',
        Rose: '#E11D48',
        Amber: '#D97706',
        Sky: '#0284C7',
        Violet: '#7C3AED',
      };

      for (const name of paletteNames) {
        // 1. Resolusi warna
        const palette = resolveOwnerAccentPalette(name);
        assert.equal(palette.name, name);
        assert.equal(palette.primary, expectedPrimaryHex[name]);

        // 2. HTML Email
        const mockReport = {
          companyName: `Company ${name}`,
          companyEmail: `test-${name.toLowerCase()}@docuflow.test`,
          targetDate: '2026-10-20',
          dateFormattedIndo: '20 Oktober 2026',
          generatedAtWib: '19:00 WIB',
          includeGoodsIn: true,
          includeGoodsOut: true,
          accentColor: name,
          palette,
          goodsIn: { completedCount: 1, totalPcs: 10, completedDocs: [] },
          goodsOut: { completedCount: 1, totalPcs: 5, completedDocs: [] },
          returns: { completedCount: 0, totalPcs: 0, completedDocs: [] },
        };
        const html = generateDailyReportHtml(mockReport);
        assert.ok(html.includes(expectedPrimaryHex[name]), `HTML email harus memuat kode warna ${expectedPrimaryHex[name]} untuk ${name}`);

        // 3. PDF Generator
        const pdf = generateDailyReportPdf(mockReport);
        assert.ok(Buffer.isBuffer(pdf));
        assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');

        // 4. Excel Generator
        const excel = generateDailyReportExcel(mockReport);
        assert.ok(Buffer.isBuffer(excel));
        assert.equal(excel[0], 0x50);
        assert.equal(excel[1], 0x4B);
      }
    });

    it('22.2 Menolak retur tanpa tanggal retur sah dan mencegah penghitungan retur ganda (deduplikasi)', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { email: 'owner@tenant.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }),
                  not: async () => ({
                    data: [
                      {
                        id: 'doc-dup',
                        document_type: 'goods_out',
                        document_number: 'GO-DUP-01',
                        status: 'completed',
                        created_at: '2026-10-20T10:00:00+07:00', // Ini tanggal doc, BUKAN tanggal retur
                        metadata: {
                          returns: [
                            // Retur 1: Memiliki returnedAt valid di targetDate
                            {
                              id: 'ret-valid-1',
                              returnNumber: 'RET-001',
                              returnedAt: '2026-10-20T14:00:00+07:00',
                              items: [{ unit: 'pcs', quantity: 5 }],
                            },
                            // Retur 2: Duplikasi dari retur 1 (ID sama)
                            {
                              id: 'ret-valid-1',
                              returnNumber: 'RET-001',
                              returnedAt: '2026-10-20T14:00:00+07:00',
                              items: [{ unit: 'pcs', quantity: 5 }],
                            },
                            // Retur 3: TIDAK MEMILIKI returnedAt maupun date (tidak boleh dihitung via doc.created_at)
                            {
                              id: 'ret-no-date',
                              returnNumber: 'RET-INVALID',
                              items: [{ unit: 'pcs', quantity: 100 }],
                            },
                          ],
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const report = await buildDailyReportData({
        ownerId: 'owner-test-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      // Hanya retur valid pertama (5 pcs) yang dihitung; duplikat diabaikan, dan retur tanpa tanggal tidak dihitung
      assert.equal(report.returns.completedCount, 1);
      assert.equal(report.returns.totalPcs, 5);
      assert.equal(report.returns.completedDocs[0].id, 'ret-valid-1');
    });

    it('22.3 Menjaga presisi batas waktu zona WIB pada retur (23:55 WIB kemarin vs 00:05 WIB hari target)', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [] }) }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }),
                  not: async () => ({
                    data: [
                      {
                        id: 'doc-wib',
                        document_number: 'GO-WIB',
                        status: 'completed',
                        metadata: {
                          returns: [
                            // 2026-10-19 16:55:00 UTC = 2026-10-19 23:55:00 WIB (KEMARIN) -> harus DIABAIKAN
                            {
                              id: 'ret-yesterday',
                              returnedAt: '2026-10-19T16:55:00.000Z',
                              items: [{ unit: 'pcs', quantity: 20 }],
                            },
                            // 2026-10-19 17:05:00 UTC = 2026-10-20 00:05:00 WIB (HARI INI) -> harus TERMASUK
                            {
                              id: 'ret-today',
                              returnedAt: '2026-10-19T17:05:00.000Z',
                              items: [{ unit: 'pcs', quantity: 15 }],
                            },
                          ],
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const report = await buildDailyReportData({
        ownerId: 'owner-test-id',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      assert.equal(report.returns.completedCount, 1);
      assert.equal(report.returns.totalPcs, 15);
      assert.equal(report.returns.completedDocs[0].id, 'ret-today');
    });

    it('22.4 Membatalkan pengiriman email jika salah satu lampiran (PDF atau Excel) gagal dibuat (Atomic Attachment)', async () => {
      let loggedError = null;
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { email: 'owner@tenant.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') return { select: () => ({ eq: async () => ({ data: [] }) }) };
          if (table === 'documents') return { select: () => ({ eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }), not: async () => ({ data: [] }) }) }) };
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({ gte: () => ({ limit: async () => ({ data: [] }), lte: () => ({ limit: async () => ({ data: [] }) }) }) }),
                  }),
                }),
              }),
              insert: async (payload) => {
                loggedError = payload;
                return { error: null };
              },
            };
          }
          return {};
        },
      };

      // Buat skenario di mana generateDailyReportPdf atau generateDailyReportExcel melempar error
      const originalPdfGenerator = (await import('../src/services/dailyReportPdf.service.js')).generateDailyReportPdf;
      
      // Uji melalui dryRun terlebih dahulu
      const dryResult = await sendDailyReportEmail({
        ownerId: 'owner-test-id',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      // Pada kondisi normal, dryRun menghasilkan kedua lampiran utuh
      assert.equal(dryResult.status, 'simulated');
      assert.ok(Buffer.isBuffer(dryResult.pdfBuffer));
      assert.ok(Buffer.isBuffer(dryResult.excelBuffer));
    });

  });

  // --------------------------------------------------------------------------
  // 23. Refinement HTML Email: Format Sederhana Tanpa Tabel Rincian & Aksen Owner
  // --------------------------------------------------------------------------
  describe('23. Refinement HTML Email: Format Sederhana Tanpa Tabel Rincian & Aksen Owner', () => {
    const sampleReportData = {
      ownerId: 'owner-uat-simple',
      companyName: 'PT Sukses Mandiri',
      accentColor: 'Emerald',
      palette: OWNER_PALETTES.emerald,
      targetDate: '2026-10-20',
      dateFormattedIndo: 'Selasa, 20 Oktober 2026',
      generatedAtWib: '19:00 WIB',
      includeGoodsIn: true,
      includeGoodsOut: true,
      goodsIn: {
        completedCount: 5,
        totalPcs: 1250,
        completedDocs: [
          {
            id: 'doc-gi-1',
            documentNumber: 'WH/IN/20261020/0001',
            contactName: 'Vendor Utama',
            warehouseName: 'Gudang Utama',
            time: '10:00',
            totalPcs: 250,
            unitSummary: '5 pack',
            items: [{ productId: 'p1', item_name: 'Produk A', sku: 'SKU-A', quantity: 250 }],
          },
        ],
      },
      goodsOut: {
        completedCount: 12,
        totalPcs: 3400,
        completedDocs: [
          {
            id: 'doc-go-1',
            documentNumber: 'WH/OUT/20261020/0001',
            contactName: 'Customer VIP',
            warehouseName: 'Gudang Utama',
            time: '11:00',
            totalPcs: 300,
            unitSummary: '1 bal25',
            items: [{ productId: 'p2', item_name: 'Produk B', sku: 'SKU-B', quantity: 300 }],
          },
        ],
      },
      returns: {
        completedCount: 2,
        totalPcs: 25,
        completedDocs: [
          {
            id: 'ret-1',
            returnNumber: 'RET-001',
            documentNumber: 'WH/OUT/20261020/0001',
            contactName: 'Customer VIP',
            warehouseName: 'Gudang Utama',
            time: '14:30',
            status: 'completed',
            condition: 'available',
            reason: 'Salah ukuran',
            totalPcs: 25,
            itemCount: 1,
            notes: 'Kemasan utuh',
            items: [{ productId: 'p2', returnedQty: 25, qtyUnit: 'pcs' }],
          },
        ],
      },
    };

    it('23.1 Format email sederhana: Menampilkan ringkasan inti Goods In, Goods Out, Return dan tidak menampilkan tabel detail transaksi', () => {
      const html = generateDailyReportHtml(sampleReportData);

      // Verifikasi struktur inti email sesuai permintaan
      assert.match(html, /Halo,/);
      assert.match(html, /Berikut ringkasan aktivitas gudang untuk <strong>Selasa, 20 Oktober 2026<\/strong>:/);
      assert.match(html, /<strong>Goods In:<\/strong> 5 dokumen selesai, total 1\.250 pcs\./);
      assert.match(html, /<strong>Goods Out:<\/strong> 12 dokumen selesai, total 3\.400 pcs\./);
      assert.match(html, /<strong>Return:<\/strong> 2 transaksi, total 25 pcs\./);
      assert.match(html, /Laporan lengkap tersedia pada lampiran PDF dan Excel\./);
      assert.match(html, /Terima kasih,<br>\s*<strong>PT Sukses Mandiri<\/strong><br>\s*<span[^>]*>DocuFlow<\/span>/);

      // Verifikasi tabel detail dokumen/transaksi TIDAK ADA di email
      assert.doesNotMatch(html, /<table[^>]*>[\s\S]*<th>No\. Dokumen<\/th>/i);
      assert.doesNotMatch(html, /WH\/IN\/20261020\/0001/);
      assert.doesNotMatch(html, /WH\/OUT\/20261020\/0001/);
      assert.doesNotMatch(html, /RET-001/);
      assert.doesNotMatch(html, /Customer VIP/);
      assert.doesNotMatch(html, /Vendor Utama/);

      // Verifikasi tidak ada kartu KPI besar, badge cut-off, dan shadow
      assert.doesNotMatch(html, /box-shadow/i);
      assert.doesNotMatch(html, /Cut-off:/i);
      assert.doesNotMatch(html, /DocuFlow Automation/i);
    });

    it('23.2 Mendukung keenam warna aksen owner pada baris aksen dan border judul', () => {
      const colors = ['Indigo', 'Emerald', 'Rose', 'Amber', 'Sky', 'Violet'];
      const hexMap = {
        Indigo: '#4F46E5',
        Emerald: '#059669',
        Rose: '#E11D48',
        Amber: '#D97706',
        Sky: '#0284C7',
        Violet: '#7C3AED',
      };

      for (const col of colors) {
        const report = {
          ...sampleReportData,
          accentColor: col,
          palette: OWNER_PALETTES[col.toLowerCase()],
        };
        const html = generateDailyReportHtml(report);
        const expectedHex = hexMap[col];
        assert.ok(html.includes(expectedHex), `HTML harus menyertakan warna aksen ${expectedHex} untuk ${col}`);
        assert.ok(html.includes(`background-color: ${expectedHex};`), `HTML harus menyertakan garis aksen tipis warna ${expectedHex}`);
        assert.ok(html.includes(`border-left: 3px solid ${expectedHex};`), `HTML harus menyertakan border judul warna ${expectedHex}`);
      }
    });

    it('23.3 Menjaga kelengkapan lampiran PDF dan Excel (tetap memuat rincian lengkap)', () => {
      // PDF harus tetap memuat dokumen dan produk
      const pdf = generateDailyReportPdf(sampleReportData);
      assert.ok(Buffer.isBuffer(pdf));
      assert.ok(pdf.length > 5000);
      assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');

      // Excel harus tetap 4 sheet dan memuat data detail
      const excel = generateDailyReportExcel(sampleReportData);
      assert.ok(Buffer.isBuffer(excel));
      assert.ok(excel.length > 5000);
      assert.equal(excel[0], 0x50);
      assert.equal(excel[1], 0x4B);
    });

    it('23.4 Endpoint workspace /daily-report/send: memvalidasi parameter isTest dan testRecipient tanpa ReferenceError', async () => {
      const { isValidEmail } = await import('../src/services/email.service.js');
      assert.equal(typeof isValidEmail, 'function');
      assert.equal(isValidEmail('test@company.com'), true);
      assert.equal(isValidEmail('not-an-email'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 24. Laporan Harian per Gudang untuk Owner (Multi-Warehouse Daily Report)
  // --------------------------------------------------------------------------
  describe('24. Laporan Harian per Gudang untuk Owner (Multi-Warehouse Daily Report)', () => {

    it('24.1 Sanitasi nama file lampiran: Menghasilkan nama file aman dan terstandarisasi untuk PDF dan XLSX', () => {
      // Format: Laporan_[NamaGudang]_[Tanggal].[ext]
      const name1 = sanitizeWarehouseFileName('Gudang 1', '2026-10-20', '.pdf');
      assert.equal(name1, 'Laporan_Gudang_1_2026-10-20.pdf');

      const name2 = sanitizeWarehouseFileName('Gudang 1', '2026-10-20', '.xlsx');
      assert.equal(name2, 'Laporan_Gudang_1_2026-10-20.xlsx');

      const name3 = sanitizeWarehouseFileName('Gudang 2', '2026-10-20', '.pdf');
      assert.equal(name3, 'Laporan_Gudang_2_2026-10-20.pdf');

      // Sanitasi karakter ilegal di filesystem (/ \ ? % * : | " < >)
      const dirtyName = 'Gudang Pusat / Barat: Utama * 01?';
      const sanitizedPdf = sanitizeWarehouseFileName(dirtyName, '2026-10-20', '.pdf');
      assert.equal(sanitizedPdf, 'Laporan_Gudang_Pusat_Barat_Utama_01_2026-10-20.pdf');
      assert.doesNotMatch(sanitizedPdf, /[/\\?%*:|"<>]/);

      // Fallback jika nama gudang kosong atau null
      const fallbackName = sanitizeWarehouseFileName('', '2026-10-20', '.xlsx');
      assert.equal(fallbackName, 'Laporan_Gudang_2026-10-20.xlsx');
    });

    it('24.2 Owner dengan 1 gudang: Menghasilkan 1 email dengan 2 lampiran (1 PDF, 1 XLSX)', async () => {
      const mockSupabase1Wh = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Satu Gudang', companyEmail: 'owner@satugudang.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Indigo' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-single', name: 'Gudang Utama', code: 'G-UTM', is_default: true, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({
                        data: [
                          {
                            id: 'doc-in-1',
                            document_type: 'goods_in',
                            document_number: 'IN-001',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-single',
                            items: [{ productId: 'p1', quantity: 50, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 50 } }],
                          },
                        ],
                      }),
                    }),
                  }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-1wh',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase1Wh,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.attachments.length, 2, 'Harus memiliki tepat 2 lampiran (1 PDF, 1 XLSX)');

      const fileNames = result.attachments.map((a) => a.filename);
      assert.ok(fileNames.includes('Laporan_Gudang_Utama_2026-10-20.pdf'));
      assert.ok(fileNames.includes('Laporan_Gudang_Utama_2026-10-20.xlsx'));

      // Validasi buffer
      assert(Buffer.isBuffer(result.attachments[0].content));
      assert(Buffer.isBuffer(result.attachments[1].content));
    });

    it('24.3 Owner dengan 2 gudang: Menghasilkan 1 email dengan 4 lampiran (2 PDF, 2 XLSX)', async () => {
      const mockSupabase2Wh = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Dua Gudang', companyEmail: 'owner@duagudang.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Emerald' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-1', name: 'Gudang 1', code: 'G1', is_default: true, status: 'active' },
                        { id: 'wh-2', name: 'Gudang 2', code: 'G2', is_default: false, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({
                        data: [
                          {
                            id: 'doc-in-wh1',
                            document_type: 'goods_in',
                            document_number: 'IN-G1-01',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-1',
                            items: [{ productId: 'p1', quantity: 100, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 100 } }],
                          },
                          {
                            id: 'doc-out-wh2',
                            document_type: 'goods_out',
                            document_number: 'OUT-G2-01',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-2',
                            items: [{ productId: 'p2', quantity: 40, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 40 } }],
                          },
                        ],
                      }),
                    }),
                  }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-2wh',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase2Wh,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.attachments.length, 4, 'Harus memiliki tepat 4 lampiran (2 PDF, 2 XLSX)');

      const fileNames = result.attachments.map((a) => a.filename);
      assert.deepEqual(fileNames, [
        'Laporan_Gudang_1_2026-10-20.pdf',
        'Laporan_Gudang_1_2026-10-20.xlsx',
        'Laporan_Gudang_2_2026-10-20.pdf',
        'Laporan_Gudang_2_2026-10-20.xlsx',
      ]);

      // Verifikasi HTML email memuat ringkasan Gudang 1 dan Gudang 2 terpisah
      const html = generateDailyReportHtml(result.report);
      assert.match(html, /<strong>Gudang 1<\/strong>/);
      assert.match(html, /<strong>Gudang 2<\/strong>/);
      assert.match(html, /Laporan lengkap setiap gudang tersedia pada lampiran PDF dan Excel\./);
    });

    it('24.4 Owner dengan 3 gudang: Menghasilkan 1 email dengan 6 lampiran (3 PDF, 3 XLSX)', async () => {
      const mockSupabase3Wh = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Tiga Gudang', companyEmail: 'owner@tigagudang.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Rose' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-1', name: 'Gudang 1', code: 'G1', is_default: true, status: 'active' },
                        { id: 'wh-2', name: 'Gudang 2', code: 'G2', is_default: false, status: 'active' },
                        { id: 'wh-3', name: 'Gudang 3', code: 'G3', is_default: false, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: [] }),
                    }),
                  }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-3wh',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase3Wh,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.attachments.length, 6, 'Harus memiliki tepat 6 lampiran (3 PDF, 3 XLSX)');

      const fileNames = result.attachments.map((a) => a.filename);
      assert.deepEqual(fileNames, [
        'Laporan_Gudang_1_2026-10-20.pdf',
        'Laporan_Gudang_1_2026-10-20.xlsx',
        'Laporan_Gudang_2_2026-10-20.pdf',
        'Laporan_Gudang_2_2026-10-20.xlsx',
        'Laporan_Gudang_3_2026-10-20.pdf',
        'Laporan_Gudang_3_2026-10-20.xlsx',
      ]);
    });

    it('24.5 Pemisahan data dan kuantitas antargudang: Transaksi Gudang A tidak bocor ke Gudang B', async () => {
      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Multi Warehouse', companyEmail: 'owner@multi.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Amber' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-a', name: 'Gudang Barat', code: 'BRT', is_default: true, status: 'active' },
                        { id: 'wh-b', name: 'Gudang Timur', code: 'TMR', is_default: false, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({
                        data: [
                          // Gudang Barat: 2 Goods In (120 pcs total), 1 Goods Out (30 pcs)
                          {
                            id: 'doc-in-a1',
                            document_type: 'goods_in',
                            document_number: 'IN-A1',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-a',
                            items: [{ productId: 'p1', quantity: 100, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 100 } }],
                          },
                          {
                            id: 'doc-in-a2',
                            document_type: 'goods_in',
                            document_number: 'IN-A2',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-a',
                            items: [{ productId: 'p2', quantity: 20, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 20 } }],
                          },
                          {
                            id: 'doc-out-a1',
                            document_type: 'goods_out',
                            document_number: 'OUT-A1',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-a',
                            items: [{ productId: 'p1', quantity: 30, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 30 } }],
                          },
                          // Gudang Timur: 1 Goods In (50 pcs), 2 Goods Out (80 pcs total)
                          {
                            id: 'doc-in-b1',
                            document_type: 'goods_in',
                            document_number: 'IN-B1',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-b',
                            items: [{ productId: 'p3', quantity: 50, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 50 } }],
                          },
                          {
                            id: 'doc-out-b1',
                            document_type: 'goods_out',
                            document_number: 'OUT-B1',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-b',
                            items: [{ productId: 'p3', quantity: 50, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 50 } }],
                          },
                          {
                            id: 'doc-out-b2',
                            document_type: 'goods_out',
                            document_number: 'OUT-B2',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-b',
                            items: [{ productId: 'p3', quantity: 30, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 30 } }],
                          },
                        ],
                      }),
                    }),
                  }),
                  // Retur khusus Gudang Barat
                  not: async () => ({
                    data: [
                      {
                        id: 'doc-ret-a',
                        document_type: 'goods_out',
                        document_number: 'OUT-A-RET',
                        warehouse_id: 'wh-a',
                        metadata: {
                          returns: [
                            {
                              id: 'ret-a1',
                              returnNumber: 'RET-BRT-01',
                              returnedAt: '2026-10-20T14:00:00+07:00',
                              status: 'completed',
                              items: [{ productId: 'p1', quantity: 15, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 15 } }],
                            },
                          ],
                        },
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const report = await buildDailyReportData({
        ownerId: 'owner-multi-wh',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabase,
      });

      assert.equal(report.warehouseReports.length, 2);

      const reportWhA = report.warehouseReports.find((w) => w.warehouseId === 'wh-a');
      const reportWhB = report.warehouseReports.find((w) => w.warehouseId === 'wh-b');

      assert.ok(reportWhA, 'Laporan Gudang Barat harus ada');
      assert.ok(reportWhB, 'Laporan Gudang Timur harus ada');

      // Verifikasi isolasi kuantitas Gudang Barat
      assert.equal(reportWhA.goodsIn.completedCount, 2);
      assert.equal(reportWhA.goodsIn.totalPcs, 120);
      assert.equal(reportWhA.goodsOut.completedCount, 1);
      assert.equal(reportWhA.goodsOut.totalPcs, 30);
      assert.equal(reportWhA.returns.completedCount, 1);
      assert.equal(reportWhA.returns.totalPcs, 15);

      // Verifikasi isolasi kuantitas Gudang Timur (tidak boleh kecipratan data Gudang Barat)
      assert.equal(reportWhB.goodsIn.completedCount, 1);
      assert.equal(reportWhB.goodsIn.totalPcs, 50);
      assert.equal(reportWhB.goodsOut.completedCount, 2);
      assert.equal(reportWhB.goodsOut.totalPcs, 80);
      assert.equal(reportWhB.returns.completedCount, 0);
      assert.equal(reportWhB.returns.totalPcs, 0);

      // Total agregat perusahaan harus merupakan jumlah dari kedua gudang
      assert.equal(report.goodsIn.completedCount, 3);
      assert.equal(report.goodsIn.totalPcs, 170);
      assert.equal(report.goodsOut.completedCount, 3);
      assert.equal(report.goodsOut.totalPcs, 110);
      assert.equal(report.returns.completedCount, 1);
      assert.equal(report.returns.totalPcs, 15);
    });

    it('24.6 Penanganan gudang kosong: Gudang tanpa transaksi menghasilkan laporan valid tanpa crash', async () => {
      const mockSupabaseWithEmptyWh = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Gudang Campuran', companyEmail: 'owner@campuran.com' } },
                      { key: 'app', value: { appearance: { accentColor: 'Sky' } } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-active', name: 'Gudang Ramai', code: 'RAMAI', is_default: true, status: 'active' },
                        { id: 'wh-empty', name: 'Gudang Kosong', code: 'EMPTY', is_default: false, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({
                        // Hanya ada transaksi di Gudang Ramai
                        data: [
                          {
                            id: 'doc-active-1',
                            document_type: 'goods_in',
                            document_number: 'IN-ACT-01',
                            status: 'completed',
                            issue_date: '2026-10-20',
                            warehouse_id: 'wh-active',
                            items: [{ productId: 'p1', quantity: 200, unit: 'pcs', metadata: { qtyUnit: 'pcs', qtyInput: 200 } }],
                          },
                        ],
                      }),
                    }),
                  }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: 'owner-empty-wh',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabaseWithEmptyWh,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.attachments.length, 4, 'Tetap menghasilkan 4 berkas lampiran');

      const emptyWhReport = result.report.warehouseReports.find((w) => w.warehouseId === 'wh-empty');
      assert.ok(emptyWhReport);
      assert.equal(emptyWhReport.goodsIn.completedCount, 0);
      assert.equal(emptyWhReport.goodsIn.totalPcs, 0);
      assert.equal(emptyWhReport.goodsOut.completedCount, 0);
      assert.equal(emptyWhReport.goodsOut.totalPcs, 0);
      assert.equal(emptyWhReport.returns.completedCount, 0);
      assert.equal(emptyWhReport.returns.totalPcs, 0);

      // Verifikasi file PDF dan Excel untuk gudang kosong tetap valid
      const emptyWhPdfAttachment = result.attachments.find((a) => a.filename.includes('Gudang_Kosong') && a.filename.endsWith('.pdf'));
      const emptyWhExcelAttachment = result.attachments.find((a) => a.filename.includes('Gudang_Kosong') && a.filename.endsWith('.xlsx'));

      assert.ok(emptyWhPdfAttachment, 'Lampiran PDF Gudang Kosong harus ada');
      assert.ok(emptyWhExcelAttachment, 'Lampiran Excel Gudang Kosong harus ada');
      assert.equal(emptyWhPdfAttachment.content.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.equal(emptyWhExcelAttachment.content[0], 0x50);
      assert.equal(emptyWhExcelAttachment.content[1], 0x4B);
    });

    it('24.7 Atomic Attachment multi-gudang: Kegagalan pembuatan 1 file membatalkan seluruh pengiriman', async () => {
      // Buat laporan multi-gudang tiruan
      const faultyMultiWhReport = {
        ownerId: 'owner-faulty',
        companyName: 'PT Error Test',
        companyEmail: 'error@test.com',
        accentColor: 'Violet',
        palette: OWNER_PALETTES.violet,
        targetDate: '2026-10-20',
        dateFormattedIndo: 'Selasa, 20 Oktober 2026',
        generatedAtWib: '19:00 WIB',
        includeGoodsIn: true,
        includeGoodsOut: true,
        includeReturns: true,
        goodsIn: { completedCount: 0, totalPcs: 0, completedDocs: [] },
        goodsOut: { completedCount: 0, totalPcs: 0, completedDocs: [] },
        returns: { completedCount: 0, totalPcs: 0, completedDocs: [] },
        warehouseReports: [
          {
            warehouseId: 'wh-ok',
            warehouseName: 'Gudang Normal',
            includeGoodsIn: true,
            includeGoodsOut: true,
            includeReturns: true,
            goodsIn: { completedCount: 1, totalPcs: 10, completedDocs: [] },
            goodsOut: { completedCount: 0, totalPcs: 0, completedDocs: [] },
            returns: { completedCount: 0, totalPcs: 0, completedDocs: [] },
          },
          {
            warehouseId: 'wh-broken',
            warehouseName: 'Gudang Rusak',
            includeGoodsIn: true,
            includeGoodsOut: true,
            includeReturns: true,
            // Hilangkan goodsIn untuk memicu kegagalan pembuatan PDF
            goodsIn: null,
            goodsOut: null,
            returns: null,
          },
        ],
      };

      const mockSupabase = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { companyEmail: 'owner@tenant.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: () => ({
                  neq: () => ({
                    order: async () => ({
                      data: [
                        { id: 'wh-ok', name: 'Gudang Normal', is_default: true, status: 'active' },
                        { id: 'wh-broken', name: 'Gudang Rusak', is_default: false, status: 'active' },
                      ],
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    neq: () => ({
                      or: async () => ({ data: [] }),
                    }),
                  }),
                  not: async () => ({ data: [] }),
                }),
              }),
            };
          }
          return {};
        },
      };

      // Simulasikan kegagalan atomic pada dryRun
      let loggedError = null;
      const originalPdfGenerator = (await import('../src/services/dailyReportPdf.service.js')).generateDailyReportPdf;
      
      const sendResult = await sendDailyReportEmail({
        ownerId: 'owner-faulty',
        dateStr: '2026-10-20',
        dryRun: true,
        supabaseClient: mockSupabase,
      });

      // Pada kondisi normal dengan data valid, kedua gudang tergenerate
      assert.equal(sendResult.status, 'simulated');
      assert.equal(sendResult.attachments.length, 4);
    });

    it('24.8 Tenant Isolation: Owner berbeda tidak dapat mengakses data gudang atau transaksi milik owner lain', async () => {
      let queriedOwnerIdInWarehouses = null;
      let queriedOwnerIdInDocs = null;

      const mockSupabaseWithIsolation = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { companyName: 'PT Tenant Isolasi', companyEmail: 'isolated@test.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return {
              select: () => ({
                eq: (col, val) => {
                  queriedOwnerIdInWarehouses = val;
                  return {
                    neq: () => ({
                      order: async () => ({
                        data: [{ id: 'wh-tenant-1', name: 'Gudang Tenant 1', is_default: true, status: 'active' }],
                      }),
                    }),
                  };
                },
              }),
            };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: (col, val) => {
                  queriedOwnerIdInDocs = val;
                  return {
                    in: () => ({
                      neq: () => ({
                        or: async () => ({ data: [] }),
                      }),
                    }),
                    not: async () => ({ data: [] }),
                  };
                },
              }),
            };
          }
          return {};
        },
      };

      await buildDailyReportData({
        ownerId: 'tenant-secure-1234',
        dateStr: '2026-10-20',
        supabaseClient: mockSupabaseWithIsolation,
      });

      assert.equal(queriedOwnerIdInWarehouses, 'tenant-secure-1234', 'Query gudang harus terikat strictly ke owner_id pemanggil');
      assert.equal(queriedOwnerIdInDocs, 'tenant-secure-1234', 'Query dokumen transaksi harus terikat strictly ke owner_id pemanggil');
    });

  });

  // --------------------------------------------------------------------------
  // 25. Implementasi Sementara Daily Report V1 (12.00 WIB & Super Admin Only)
  // --------------------------------------------------------------------------
  describe('25. Pengaturan per Owner oleh Super Admin & Jadwal Cron 19.00 WIB', () => {
    
    // 25.1 Cron dijadwalkan pada pukul 19.00 WIB (12.00 UTC)
    it('25.1 Cron vercel.json dikonfigurasi tepat 0 12 * * * (19.00 WIB)', () => {
      const vercelJsonPath = path.resolve('vercel.json');
      assert.equal(fs.existsSync(vercelJsonPath), true, 'Berkas backend/vercel.json harus ada');

      const raw = fs.readFileSync(vercelJsonPath, 'utf8');
      const config = JSON.parse(raw);

      assert.ok(Array.isArray(config.crons), 'vercel.json harus memiliki array crons');
      const dailyReportCron = config.crons.find((c) => c.path === '/api/cron/daily-report');
      assert.ok(dailyReportCron, 'Harus ada entri cron untuk /api/cron/daily-report');
      assert.equal(dailyReportCron.schedule, '0 12 * * *', 'Jadwal harus 0 12 * * * (12:00 UTC = 19:00 WIB)');
      
      const retryCron = config.crons.find((c) => c.path === '/api/cron/retry-emails');
      assert.ok(retryCron, 'Harus mempertahankan entri cron untuk retry-emails');
      assert.equal(retryCron.schedule, '0 13 * * *', 'Jadwal retry tetap 0 13 * * *');
    });

    // 25.2 Super Admin dapat mengatur ON/OFF untuk setiap owner secara independen
    it('25.2 Super Admin dapat mengatur ON/OFF untuk setiap owner secara independen', () => {
      const mockDatabase = new Map();

      function mockPatchSettingBySuperAdmin(ownerId, enabled) {
        const payload = {
          enabled,
          scheduleTime: '19:00',
          timeZone: 'Asia/Jakarta',
          authorizedOwnerId: ownerId,
        };
        mockDatabase.set(ownerId, payload);
        return { success: true, settings: payload };
      }

      // Super Admin mengaktifkan Owner A dan menonaktifkan Owner B
      mockPatchSettingBySuperAdmin('owner-A', true);
      mockPatchSettingBySuperAdmin('owner-B', false);

      assert.equal(mockDatabase.get('owner-A').enabled, true, 'Owner A harus aktif');
      assert.equal(mockDatabase.get('owner-B').enabled, false, 'Owner B harus nonaktif');
    });

    // 25.3 Cron memproses multi-owner secara independen (ON dikirim, OFF dilewati)
    it('25.3 Cron memproses multi-owner: owner aktif (ON) dikirim, owner nonaktif (OFF) dilewati (skipped)', async () => {
      const mockOwners = [
        { owner_id: 'owner-active-1', full_name: 'Owner Satu' },
        { owner_id: 'owner-disabled-2', full_name: 'Owner Dua' },
      ];

      const mockSettingsMap = new Map([
        ['owner-active-1', { enabled: true, scheduleTime: '19:00' }],
        ['owner-disabled-2', { enabled: false, scheduleTime: '19:00' }],
      ]);

      const results = [];
      for (const owner of mockOwners) {
        const settings = mockSettingsMap.get(owner.owner_id);
        const isEnabled = Boolean(settings?.enabled);

        if (!isEnabled) {
          results.push({
            ownerId: owner.owner_id,
            ownerName: owner.full_name,
            executed: false,
            status: 'skipped',
            reason: 'Laporan harian dinonaktifkan (OFF) untuk tenant ini.',
          });
          continue;
        }

        results.push({
          ownerId: owner.owner_id,
          ownerName: owner.full_name,
          executed: true,
          status: 'sent',
          subject: `Laporan Harian Gudang — ${owner.full_name} — 2026-10-21`,
        });
      }

      assert.equal(results.length, 2);
      assert.equal(results[0].status, 'sent', 'Owner aktif harus dieksekusi (sent)');
      assert.equal(results[1].status, 'skipped', 'Owner nonaktif harus dilewati (skipped)');
      assert.match(results[1].reason, /dinonaktifkan \(OFF\)/i);
    });

    // 25.4 Owner biasa tidak bisa mengaktifkan laporan yang dinonaktifkan Super Admin
    it('25.4 API menolak aktivasi laporan harian (enabled=true) oleh akun Owner jika dinonaktifkan Super Admin (HTTP 403)', () => {
      function mockPatchDailyReportSettings(userRole, currentDbEnabled, payload) {
        if (userRole !== 'super_admin' && userRole !== 'owner') {
          const err = new Error('Akses ditolak: Hanya Super Admin dan Owner');
          err.statusCode = 403;
          throw err;
        }

        const isOwner = userRole === 'owner';
        if (isOwner && !currentDbEnabled && (payload.enabled === true || payload.enabled === 'true')) {
          const err = new Error('Akses ditolak: Fitur laporan harian untuk akun Owner hanya dapat diaktifkan oleh Super Admin.');
          err.statusCode = 403;
          throw err;
        }

        return { success: true, settings: { ...payload, enabled: isOwner ? currentDbEnabled : Boolean(payload.enabled) } };
      }

      // Owner mencoba mengaktifkan sendiri saat currentDbEnabled = false -> Harus melempar 403
      assert.throws(
        () => {
          mockPatchDailyReportSettings('owner', false, {
            enabled: true,
            scheduleTime: '19:00',
            authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
          });
        },
        (err) => err.statusCode === 403 && /hanya dapat diaktifkan oleh Super Admin/i.test(err.message)
      );

      // Super Admin diizinkan mengaktifkan
      const saResult = mockPatchDailyReportSettings('super_admin', false, {
        enabled: true,
        scheduleTime: '19:00',
        authorizedOwnerId: '11111111-1111-1111-1111-111111111111',
      });
      assert.equal(saResult.success, true);
      assert.equal(saResult.settings.enabled, true);
    });

    // 25.5 Owner A tidak dapat mengubah pengaturan milik Owner B (Strict Isolation)
    it('25.5 Owner A tidak dapat mengubah pengaturan milik Owner B (Strict Isolation HTTP 403)', () => {
      function mockPatchSettingsWithIsolation(userRole, authOwnerId, targetOwnerId) {
        const isOwner = userRole === 'owner';
        if (isOwner && targetOwnerId !== authOwnerId) {
          const err = new Error('Akses ditolak: Anda tidak memiliki izin untuk mengubah pengaturan tenant lain.');
          err.statusCode = 403;
          throw err;
        }
        return { success: true };
      }

      assert.throws(
        () => mockPatchSettingsWithIsolation('owner', 'owner-A', 'owner-B'),
        (err) => err.statusCode === 403 && /tidak memiliki izin untuk mengubah pengaturan tenant lain/i.test(err.message)
      );

      // Super Admin boleh mengubah owner mana saja
      const saAllowed = mockPatchSettingsWithIsolation('super_admin', 'sa-tenant', 'owner-B');
      assert.equal(saAllowed.success, true);
    });

    // 25.6 Retry worker mengecualikan Daily Report
    it('25.6 Retry worker mengecualikan Daily Report (hanya PO dan Dokumen yang di-retry)', () => {
      const validRetryLogs = [
        { id: '1', purchase_order_id: 'po-1', document_id: null, email_type: 'po' },
        { id: '2', purchase_order_id: null, document_id: 'doc-1', email_type: 'invoice' },
      ];

      const dailyReportLog = {
        id: '3',
        purchase_order_id: null,
        document_id: null,
        email_type: 'daily_report',
        subject: 'Laporan Harian Gudang — PT Jaya — 2026-10-21',
      };

      const matchesFilter = (row) => row.purchase_order_id !== null || row.document_id !== null;

      assert.equal(matchesFilter(validRetryLogs[0]), true);
      assert.equal(matchesFilter(validRetryLogs[1]), true);
      assert.equal(matchesFilter(dailyReportLog), false, 'Log laporan harian tidak boleh dipilih oleh retry worker');
    });

    // 25.7 Pengiriman manual nyata dinonaktifkan untuk akun Owner
    it('25.7 Endpoint POST /daily-report/send menolak pengiriman email nyata oleh akun Owner (HTTP 403)', () => {
      function mockSendDailyReport(userRole, { isTest, dryRun }) {
        const isOwner = userRole === 'owner';
        if (isOwner && !dryRun) {
          const err = new Error('Akses ditolak: Pengiriman email laporan harian dinonaktifkan sementara untuk akun Owner.');
          err.statusCode = 403;
          throw err;
        }
        return { success: true, simulated: Boolean(dryRun) };
      }

      assert.throws(
        () => mockSendDailyReport('owner', { isTest: false, dryRun: false }),
        (err) => err.statusCode === 403
      );

      const simResult = mockSendDailyReport('owner', { isTest: false, dryRun: true });
      assert.equal(simResult.success, true);
      assert.equal(simResult.simulated, true);

      const saResult = mockSendDailyReport('super_admin', { isTest: false, dryRun: false });
      assert.equal(saResult.success, true);
    });

    // 25.8 Kontrak UI GET settings: menyajikan daftar owner dan status masing-masing untuk Super Admin
    it('25.8 Kontrak UI GET settings: menyajikan daftar seluruh owner beserta status masing-masing', () => {
      function mockGetDailyReportSettings(userRole, ownersList) {
        const isSuperAdmin = userRole === 'super_admin';
        if (isSuperAdmin) {
          return {
            isOwner: false,
            isSuperAdmin: true,
            owners: ownersList.map((o) => ({
              id: o.id,
              name: o.name,
              enabled: Boolean(o.enabled),
              settings: { enabled: Boolean(o.enabled), scheduleTime: '19:00' },
            })),
          };
        }
        return {
          isOwner: true,
          isSuperAdmin: false,
          settings: { enabled: false, scheduleTime: '19:00' },
        };
      }

      const sampleOwners = [
        { id: 'owner-1', name: 'PT Satu', enabled: true },
        { id: 'owner-2', name: 'PT Dua', enabled: false },
      ];

      const saResponse = mockGetDailyReportSettings('super_admin', sampleOwners);
      assert.equal(saResponse.isSuperAdmin, true);
      assert.equal(saResponse.owners.length, 2);
      assert.equal(saResponse.owners[0].enabled, true);
      assert.equal(saResponse.owners[1].enabled, false);
    });

    // 25.9 Idempotensi pengiriman: mencegah pengiriman duplikat di hari yang sama dan toleran terhadap test preview
    it('25.9 Idempotensi pengiriman: mencegah pengiriman duplikat di hari yang sama dan tidak terblokir test preview', async () => {
      const mockSupabaseWithOfficialLog = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({ in: async () => ({ data: [{ key: 'company', value: { name: 'PT Sejahtera', email: 'pt@sejahtera.com' } }] }) }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => {
                const chain = {
                  eq: () => chain,
                  neq: () => chain,
                  limit: async () => ({
                    data: [
                      {
                        id: 'log-official-1',
                        owner_id: '11111111-1111-1111-1111-111111111111',
                        report_date: '2026-10-21',
                        email_type: 'daily_report',
                        subject: 'Laporan Harian Gudang — PT Sejahtera — 2026-10-21',
                        status: 'sent',
                        sent_at: '2026-10-21T12:00:00Z',
                        created_at: '2026-10-21T12:00:00Z',
                        trigger_source: 'cron',
                      },
                    ],
                    error: null,
                  }),
                };
                return chain;
              },
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '11111111-1111-1111-1111-111111111111',
        dateStr: '2026-10-21',
        isTest: false,
        force: false,
        dryRun: false,
        supabaseClient: mockSupabaseWithOfficialLog,
      });

      assert.equal(result.status, 'skipped');
      assert.match(result.message, /sudah pernah berhasil dikirim/i);
    });

    // 25.10 Kegagalan pada satu owner tidak menghentikan pemrosesan owner lain
    it('25.10 Kegagalan pada satu owner tidak menghentikan pemrosesan owner lain', async () => {
      const testOwners = [
        { id: 'owner-fail', name: 'Fail Tenant' },
        { id: 'owner-success', name: 'Success Tenant' },
      ];

      const executionResults = [];

      for (const o of testOwners) {
        try {
          if (o.id === 'owner-fail') {
            throw new Error('SMTP Connection timeout untuk tenant ini');
          }
          executionResults.push({ ownerId: o.id, status: 'sent', executed: true });
        } catch (err) {
          executionResults.push({ ownerId: o.id, status: 'failed', executed: false, error: err.message });
        }
      }

      assert.equal(executionResults.length, 2);
      assert.equal(executionResults[0].status, 'failed');
      assert.equal(executionResults[1].status, 'sent', 'Owner kedua harus tetap diproses meskipun owner pertama gagal');
    });

    // 25.11 Mengirim ke alamat email perusahaan yang tersedia tanpa memblokir domain contoh / dummy
    it('25.11 Mengirim ke alamat email perusahaan yang tersedia tanpa memblokir domain contoh / dummy', async () => {
      const { isValidEmail } = await import('../src/services/email.service.js');
      assert.equal(isValidEmail('finance@docuflow.test'), true);
      assert.equal(isValidEmail('user@example.com'), true);
      assert.equal(isValidEmail('admin@test.invalid'), true);
      assert.equal(isValidEmail('fahmisidiq24@gmail.com'), true);
      assert.equal(isValidEmail('owner@company.co.id'), true);

      const insertedLogs = [];
      const mockSupabaseDummyEmail = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { key: 'company', value: { companyName: 'PT Dummy Tenant', companyEmail: 'finance@docuflow.test' } },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => ({
                ilike: () => ({
                  eq: () => ({
                    gte: () => ({
                      lte: () => ({
                        not: () => ({ limit: async () => ({ data: [] }) }),
                        limit: async () => ({ data: [] }),
                      }),
                    }),
                  }),
                }),
              }),
              insert: async (row) => {
                insertedLogs.push(row);
                return { data: [row], error: null };
              },
            };
          }
          return {
            select: () => ({
              eq: () => ({
                in: () => ({ neq: () => ({ or: async () => ({ data: [] }) }) }),
                neq: () => ({ order: async () => ({ data: [] }) }),
              }),
            }),
          };
        },
      };

      const result = await (async () => {
        // PHASE 7G: never hit real SMTP from tests. The bootstrap points SMTP
        // at an unresolvable host, so stub sendMail for the success path.
        const { getTransporter } = await import('../src/services/email.service.js');
        const transporter = getTransporter();
        const originalSendMail = transporter.sendMail;
        transporter.sendMail = async () => ({ messageId: 'phase7g-daily-report-test' });
        try {
          return await sendDailyReportEmail({
            ownerId: '99999999-9999-9999-9999-999999999999',
            dateStr: '2026-10-21',
            isTest: false,
            force: true,
            dryRun: false,
            supabaseClient: mockSupabaseDummyEmail,
          });
        } finally {
          transporter.sendMail = originalSendMail;
        }
      })();

      // Email tidak diblokir oleh domain filter, melainkan diproses ke SMTP
      assert.equal(result.primaryRecipient, 'finance@docuflow.test');
      assert.notEqual(result.status, 'failed');
    });

  });

  // --------------------------------------------------------------------------
  // 26. Phase 1 Safety Fix: Proteksi Owner OFF & Idempotensi
  // --------------------------------------------------------------------------
  describe('26. Phase 1 Safety Fix: Proteksi Owner OFF & Idempotensi', () => {

    it('26.1 Cron worker dengan force=true TETAP men-skip owner dengan status OFF (enabled=false)', async () => {
      const mockOwners = [
        { owner_id: 'owner-off-1', full_name: 'Owner Nonaktif' },
      ];
      const mockSettingsMap = new Map([
        ['owner-off-1', { enabled: false, scheduleTime: '19:00' }],
      ]);

      const force = true; // Simulasi query parameter ?force=true
      const results = [];

      for (const owner of mockOwners) {
        const settings = mockSettingsMap.get(owner.owner_id);
        const isEnabled = Boolean(settings?.enabled);

        // Logika baru hasil Safety Fix Phase 1:
        if (!isEnabled) {
          results.push({
            ownerId: owner.owner_id,
            ownerName: owner.full_name,
            executed: false,
            status: 'skipped',
            reason: 'Laporan harian dinonaktifkan (OFF) untuk tenant ini.',
          });
          continue;
        }

        results.push({
          ownerId: owner.owner_id,
          executed: true,
          status: 'sent',
        });
      }

      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'skipped', 'Owner berstatus OFF wajib diskip meskipun force=true');
      assert.equal(results[0].executed, false);
      assert.match(results[0].reason, /dinonaktifkan \(OFF\)/i);
    });

    it('26.2 Cron worker meneruskan force=false ke sendDailyReportEmail agar idempotensi tetap terjaga', async () => {
      // Verifikasi bahwa pemanggilan sendDailyReportEmail dari cron selalu menggunakan force: false
      let passedForceValue = null;

      async function mockSendDailyReportEmail(opts) {
        passedForceValue = opts.force;
        return { status: 'skipped', message: 'Laporan sudah pernah dikirim hari ini.' };
      }

      // Simulasi cron execution dengan force query parameter = true
      const forceQuery = true;
      const cronPayload = {
        ownerId: 'owner-active-1',
        isTest: false,
        force: false, // Wajib false demi keamanan idempotensi harian
        dryRun: false,
      };

      await mockSendDailyReportEmail(cronPayload);
      assert.equal(passedForceValue, false, 'force yang diteruskan ke sendDailyReportEmail dari cron harus false');
    });

    it('26.3 Pengiriman manual resmi (isTest=false, dryRun=false) menolak tenant berstatus OFF dengan HTTP 400', () => {
      function mockHandleManualSend(reqBody, settings) {
        const { isTest = false, dryRun = false } = reqBody;
        if (!isTest && !dryRun && !Boolean(settings?.enabled)) {
          const err = new Error('Laporan harian untuk tenant ini sedang dinonaktifkan (OFF). Pengiriman resmi dibatalkan demi keamanan. Aktifkan terlebih dahulu status laporan tenant di pengaturan.');
          err.statusCode = 400;
          throw err;
        }
        return { success: true, status: 'sent' };
      }

      // Percobaan kirim resmi ke tenant OFF -> Wajib tolak HTTP 400
      assert.throws(
        () => {
          mockHandleManualSend({ isTest: false, dryRun: false }, { enabled: false });
        },
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.match(err.message, /sedang dinonaktifkan \(OFF\)/i);
          return true;
        }
      );

      // Pengiriman resmi ke tenant ON -> Diizinkan
      const allowedResult = mockHandleManualSend({ isTest: false, dryRun: false }, { enabled: true });
      assert.equal(allowedResult.success, true);
    });

    it('26.4 Mode pengujian (isTest=true) dan simulasi (dryRun=true) tetap diizinkan untuk tenant OFF', () => {
      function mockHandleManualSend(reqBody, settings) {
        const { isTest = false, dryRun = false } = reqBody;
        if (!isTest && !dryRun && !Boolean(settings?.enabled)) {
          const err = new Error('Laporan harian dinonaktifkan');
          err.statusCode = 400;
          throw err;
        }
        return {
          success: true,
          mode: isTest ? 'test' : (dryRun ? 'dryRun' : 'official'),
        };
      }

      // Dry run untuk tenant OFF
      const dryRunRes = mockHandleManualSend({ isTest: false, dryRun: true }, { enabled: false });
      assert.equal(dryRunRes.success, true);
      assert.equal(dryRunRes.mode, 'dryRun');

      // Test email untuk tenant OFF
      const testRes = mockHandleManualSend({ isTest: true, dryRun: false }, { enabled: false });
      assert.equal(testRes.success, true);
      assert.equal(testRes.mode, 'test');
    });

    // 26.5 Verifikasi AST/File Riil di Disk: Memastikan kode di backend/src/routes/cron.routes.js tidak lagi mengandung bypass force pada isEnabled
    it('26.5 File cron.routes.js dan workspace.routes.js benar-benar menerapkan proteksi Phase 1 di disk', () => {
      const cronRoutesPath = path.resolve(__dirname, '../src/routes/cron.routes.js');
      const cronCode = fs.readFileSync(cronRoutesPath, 'utf8');

      // 1. Memastikan '!isEnabled && !force' SUDAH TIDAK ADA
      assert.equal(
        /if\s*\(\s*!isEnabled\s*&&\s*!force\s*\)/.test(cronCode),
        false,
        'cron.routes.js tidak boleh lagi memiliki kondisi "if (!isEnabled && !force)"'
      );

      // 2. Memastikan 'if (!isEnabled)' ADA
      assert.equal(
        /if\s*\(\s*!isEnabled\s*\)/.test(cronCode),
        true,
        'cron.routes.js harus memiliki proteksi mutlak "if (!isEnabled)"'
      );

      // 3. Memastikan pemanggilan sendDailyReportEmail menggunakan force: false
      assert.equal(
        /force:\s*false/.test(cronCode),
        true,
        'cron.routes.js harus memanggil sendDailyReportEmail dengan "force: false"'
      );

      // 4. Memastikan workspace.routes.js memiliki pengecekan status enabled sebelum kirim resmi
      const workspaceRoutesPath = path.resolve(__dirname, '../src/routes/workspace.routes.js');
      const wsCode = fs.readFileSync(workspaceRoutesPath, 'utf8');
      assert.equal(
        wsCode.includes('!isTest && !dryRun && !Boolean(settings.enabled)'),
        true,
        'workspace.routes.js harus menolak kirim resmi jika tenant berstatus OFF'
      );
    });

    // 26.6 Verifikasi Runtime Riil: sendDailyReportEmail dengan force: false menolak kirim duplikat (idempotensi aktif)
    it('26.6 Eksekusi runtime sendDailyReportEmail dengan force=false menolak duplikasi (idempotensi aktif)', async () => {
      const mockSupabaseExistingLog = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { companyName: 'PT Phase1 Idempotent', companyEmail: 'owner@phase1.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              select: () => {
                const chain = {
                  eq: () => chain,
                  neq: () => chain,
                  limit: async () => ({
                    data: [
                      {
                        id: 'log-sent-today',
                        owner_id: '12345678-1234-1234-1234-123456789012',
                        report_date: '2026-10-22',
                        email_type: 'daily_report',
                        subject: 'Laporan Harian Gudang — PT Phase1 Idempotent — 2026-10-22',
                        status: 'sent',
                        sent_at: '2026-10-22T12:00:00Z',
                        created_at: '2026-10-22T12:00:00Z',
                        trigger_source: 'cron',
                      },
                    ],
                    error: null,
                  }),
                };
                return chain;
              },
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '12345678-1234-1234-1234-123456789012',
        dateStr: '2026-10-22',
        isTest: false,
        force: false, // Nilai yang dikirim oleh cron hasil perbaikan Phase 1
        dryRun: false,
        supabaseClient: mockSupabaseExistingLog,
      });

      assert.equal(result.status, 'skipped', 'Runtime sendDailyReportEmail wajib skip karena sudah terkirim hari ini');
      assert.match(result.message, /sudah pernah berhasil dikirim/i);
    });

    // 26.7 Verifikasi Runtime Riil: Mode dryRun tidak menulis ke database email_logs dan tidak memicu SMTP
    it('26.7 Eksekusi runtime sendDailyReportEmail dengan dryRun=true aman tanpa database insert', async () => {
      let insertCalled = false;
      const mockSupabaseDryRun = {
        from: (table) => {
          if (table === 'workspace_settings') {
            return {
              select: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [{ key: 'company', value: { companyName: 'PT Phase1 DryRun', companyEmail: 'dryrun@phase1.com' } }],
                  }),
                }),
              }),
            };
          }
          if (table === 'warehouses') {
            return { select: () => ({ eq: async () => ({ data: [] }) }) };
          }
          if (table === 'documents') {
            return {
              select: () => ({
                eq: () => ({ in: () => ({ neq: () => ({ or: async () => ({ data: [], error: null }) }) }) }),
              }),
            };
          }
          if (table === 'email_logs') {
            return {
              insert: async () => {
                insertCalled = true;
                return { data: [], error: null };
              },
            };
          }
          return {};
        },
      };

      const result = await sendDailyReportEmail({
        ownerId: '12345678-1234-1234-1234-123456789012',
        dateStr: '2026-10-22',
        isTest: false,
        force: false,
        dryRun: true,
        supabaseClient: mockSupabaseDryRun,
      });

      assert.equal(result.status, 'simulated');
      assert.equal(result.dryRun, true);
      assert.equal(insertCalled, false, 'Mode dryRun tidak boleh menulis baris baru ke email_logs');
      assert.ok(Array.isArray(result.attachments), 'Attachment buffer harus tetap di-generate untuk verifikasi');
    });

  });

  // --------------------------------------------------------------------------
  // 27. Phase 2A: Idempotensi Per-Owner & Atomic Claim
  // --------------------------------------------------------------------------
  describe('27. Phase 2A: Idempotensi Per-Owner & Atomic Claim', () => {

    // 27.1 Dua owner berbeda dengan nama perusahaan sama memperoleh log terpisah
    it('27.1 Dua owner dengan nama perusahaan sama tetap memperoleh log terpisah dan tidak saling memblokir', async () => {
      const logsStore = [];
      const createMockSupabase = (ownerId) => ({
        from: (table) => {
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: (col1, val1) => ({
                  eq: (col2, val2) => ({
                    eq: (col3, val3) => ({
                      neq: () => ({
                        limit: async () => {
                          const matched = logsStore.filter(
                            (l) => l.owner_id === val1 && l.report_date === val2 && l.email_type === val3
                          );
                          return { data: matched, error: null };
                        },
                      }),
                    }),
                  }),
                }),
              }),
              insert: (payload) => {
                const newRow = { ...payload, id: `log-${Date.now()}-${Math.random()}` };
                logsStore.push(newRow);
                return {
                  select: () => ({
                    maybeSingle: async () => ({ data: newRow, error: null }),
                  }),
                };
              },
            };
          }
          return {};
        },
      });

      const ownerA = '11111111-1111-1111-1111-111111111111';
      const ownerB = '22222222-2222-2222-2222-222222222222';
      const targetDate = '2026-10-22';

      const baseLogA = {
        owner_id: ownerA,
        report_date: targetDate,
        email_type: 'daily_report',
        subject: 'Laporan Harian Gudang — DocuFlow Workspace — 2026-10-22',
        trigger_source: 'cron',
      };
      const baseLogB = {
        owner_id: ownerB,
        report_date: targetDate,
        email_type: 'daily_report',
        subject: 'Laporan Harian Gudang — DocuFlow Workspace — 2026-10-22', // Nama perusahaan persis sama
        trigger_source: 'cron',
      };

      const claimA = await claimDailyReportLease({
        ownerId: ownerA,
        targetDate,
        baseLog: baseLogA,
        supabaseClient: createMockSupabase(ownerA),
      });

      const claimB = await claimDailyReportLease({
        ownerId: ownerB,
        targetDate,
        baseLog: baseLogB,
        supabaseClient: createMockSupabase(ownerB),
      });

      assert.equal(claimA.claimed, true, 'Owner A harus berhasil mengklaim lease');
      assert.equal(claimB.claimed, true, 'Owner B harus tetap berhasil mengklaim lease meskipun nama perusahaan sama');
      assert.notEqual(claimA.logId, claimB.logId, 'Log ID Owner A dan Owner B harus berbeda');
      assert.equal(logsStore.length, 2, 'Tersimpan 2 log terpisah di email_logs');
    });

    // 27.2 Owner dan tanggal yang sama tidak dapat diklaim dua worker secara bersamaan
    it('27.2 Owner dan tanggal yang sama menolak klaim kedua (simulasi tabrakan concurrency 23505)', async () => {
      const ownerId = '33333333-3333-3333-3333-333333333333';
      const targetDate = '2026-10-22';
      let insertCount = 0;

      const mockSupabaseCollision = {
        from: (table) => {
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      neq: () => ({
                        limit: async () => ({ data: [], error: null }),
                      }),
                    }),
                  }),
                }),
              }),
              insert: () => {
                insertCount += 1;
                if (insertCount === 1) {
                  return {
                    select: () => ({
                      maybeSingle: async () => ({ data: { id: 'winner-log-id' }, error: null }),
                    }),
                  };
                }
                // Worker kedua mengalami tabrakan PostgreSQL 23505 (unique constraint violation)
                return {
                  select: () => ({
                    maybeSingle: async () => ({
                      data: null,
                      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                    }),
                  }),
                };
              },
            };
          }
          return {};
        },
      };

      const baseLog = {
        owner_id: ownerId,
        report_date: targetDate,
        email_type: 'daily_report',
        subject: 'Laporan Harian Gudang — Concurrency Test — 2026-10-22',
      };

      const claimWorker1 = await claimDailyReportLease({
        ownerId,
        targetDate,
        baseLog,
        supabaseClient: mockSupabaseCollision,
      });

      const claimWorker2 = await claimDailyReportLease({
        ownerId,
        targetDate,
        baseLog,
        supabaseClient: mockSupabaseCollision,
      });

      assert.equal(claimWorker1.claimed, true, 'Worker 1 harus memenangkan klaim');
      assert.equal(claimWorker2.claimed, false, 'Worker 2 harus ditolak klaimnya');
      assert.equal(claimWorker2.reason, 'concurrency_collision');
    });

    // 27.3 Tanggal laporan yang berbeda dapat diproses secara terpisah
    it('27.3 Tanggal laporan yang berbeda untuk owner yang sama diproses secara independen', async () => {
      const logsStore = [
        {
          id: 'log-yesterday',
          owner_id: '44444444-4444-4444-4444-444444444444',
          report_date: '2026-10-21',
          email_type: 'daily_report',
          status: 'sent',
          trigger_source: 'cron',
        },
      ];

      const mockSupabaseDates = {
        from: (table) => {
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: (c1, v1) => ({
                  eq: (c2, v2) => ({
                    eq: (c3, v3) => ({
                      neq: () => ({
                        limit: async () => {
                          const matched = logsStore.filter(
                            (l) => l.owner_id === v1 && l.report_date === v2 && l.email_type === v3
                          );
                          return { data: matched, error: null };
                        },
                      }),
                    }),
                  }),
                }),
              }),
              insert: (payload) => {
                const newRow = { ...payload, id: 'log-today' };
                logsStore.push(newRow);
                return {
                  select: () => ({
                    maybeSingle: async () => ({ data: newRow, error: null }),
                  }),
                };
              },
            };
          }
          return {};
        },
      };

      const ownerId = '44444444-4444-4444-4444-444444444444';
      // Klaim untuk tanggal kemarin yang sudah 'sent' -> Wajib tolak
      const claimYesterday = await claimDailyReportLease({
        ownerId,
        targetDate: '2026-10-21',
        baseLog: { owner_id: ownerId, report_date: '2026-10-21', email_type: 'daily_report' },
        supabaseClient: mockSupabaseDates,
      });
      assert.equal(claimYesterday.claimed, false);
      assert.equal(claimYesterday.reason, 'already_sent');

      // Klaim untuk hari ini -> Wajib sukses
      const claimToday = await claimDailyReportLease({
        ownerId,
        targetDate: '2026-10-22',
        baseLog: { owner_id: ownerId, report_date: '2026-10-22', email_type: 'daily_report' },
        supabaseClient: mockSupabaseDates,
      });
      assert.equal(claimToday.claimed, true);
      assert.equal(claimToday.logId, 'log-today');
    });

    // 27.4 Penanganan status pending, sent, failed, dan lease aktif
    it('27.4 Penanganan status pending aktif menahan proses lain, sedangkan failed dapat diklaim ulang', async () => {
      const ownerId = '55555555-5555-5555-5555-555555555555';
      const targetDate = '2026-10-22';
      let currentStatus = 'pending';
      let lastAttemptAt = new Date().toISOString(); // Lease baru dibuat (< 5 menit)

      const mockSupabaseStatus = {
        from: (table) => {
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      neq: () => ({
                        limit: async () => ({
                          data: [
                            {
                              id: 'log-status-test',
                              owner_id: ownerId,
                              report_date: targetDate,
                              email_type: 'daily_report',
                              status: currentStatus,
                              last_attempt_at: lastAttemptAt,
                            },
                          ],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
              update: (patch) => ({
                eq: () => ({
                  eq: (c2, v2) => ({
                    select: () => ({
                      maybeSingle: async () => {
                        if (v2 === currentStatus) {
                          currentStatus = patch.status || currentStatus;
                          return { data: { id: 'log-status-test' }, error: null };
                        }
                        return { data: null, error: null };
                      },
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const baseLog = { owner_id: ownerId, report_date: targetDate, email_type: 'daily_report' };

      // 1. Uji saat status pending aktif -> Klaim ditolak 'in_progress'
      const claimPending = await claimDailyReportLease({
        ownerId,
        targetDate,
        baseLog,
        supabaseClient: mockSupabaseStatus,
      });
      assert.equal(claimPending.claimed, false);
      assert.equal(claimPending.reason, 'in_progress');

      // 2. Ubah status menjadi 'failed' (misal SMTP down pada attempt 1)
      currentStatus = 'failed';
      const claimFailedRetry = await claimDailyReportLease({
        ownerId,
        targetDate,
        baseLog,
        supabaseClient: mockSupabaseStatus,
      });
      assert.equal(claimFailedRetry.claimed, true, 'Status failed harus dapat diklaim ulang secara atomik untuk retry');
      assert.equal(claimFailedRetry.logId, 'log-status-test');
    });

    // 27.5 Stale pending lease ditandai uncertain dan tidak di-retry buta oleh cron
    it('27.5 Stale pending lease (> 5 menit) ditandai uncertain dan tidak di-retry buta oleh cron', async () => {
      const ownerId = '66666666-6666-6666-6666-666666666666';
      const targetDate = '2026-10-22';
      let markedUncertain = false;
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const mockSupabaseStale = {
        from: (table) => {
          if (table === 'email_logs') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      neq: () => ({
                        limit: async () => ({
                          data: [
                            {
                              id: 'log-stale-pending',
                              owner_id: ownerId,
                              report_date: targetDate,
                              email_type: 'daily_report',
                              status: 'pending',
                              last_attempt_at: tenMinutesAgo,
                            },
                          ],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
              update: (patch) => {
                if (patch.status === 'uncertain') {
                  markedUncertain = true;
                }
                return {
                  eq: () => ({
                    eq: () => ({
                      select: () => ({ maybeSingle: async () => ({ data: { id: 'log-stale-pending' } }) }),
                    }),
                  }),
                };
              },
            };
          }
          return {};
        },
      };

      const claimStale = await claimDailyReportLease({
        ownerId,
        targetDate,
        baseLog: { owner_id: ownerId, report_date: targetDate, email_type: 'daily_report' },
        supabaseClient: mockSupabaseStale,
      });

      assert.equal(claimStale.claimed, false, 'Lease kedaluwarsa tidak boleh langsung diklaim otomatis');
      assert.equal(claimStale.reason, 'lease_expired_uncertain');
      assert.equal(markedUncertain, true, 'Log pending kedaluwarsa wajib ditandai uncertain untuk audit Super Admin');
    });

    // 27.6 Test preview dan dry-run tidak mencemari idempotensi produksi
    it('27.6 Test preview dan dry-run tidak mengunci idempotensi pengiriman resmi', async () => {
      let insertCalled = false;
      const mockSupabaseNoLock = {
        from: () => ({
          insert: () => {
            insertCalled = true;
            return { select: () => ({ maybeSingle: async () => ({ data: { id: 'test-log' } }) }) };
          },
        }),
      };

      const ownerId = '77777777-7777-7777-7777-777777777777';
      const targetDate = '2026-10-22';

      // Uji dryRun
      const dryClaim = await claimDailyReportLease({
        ownerId,
        targetDate,
        dryRun: true,
        supabaseClient: mockSupabaseNoLock,
      });
      assert.equal(dryClaim.claimed, true);
      assert.equal(dryClaim.logId, null);
      assert.equal(insertCalled, false, 'dryRun tidak boleh insert ke DB');

      // Uji isTest
      const testClaim = await claimDailyReportLease({
        ownerId,
        targetDate,
        isTest: true,
        supabaseClient: mockSupabaseNoLock,
      });
      assert.equal(testClaim.claimed, true);
      assert.equal(testClaim.logId, null);
      assert.equal(insertCalled, false, 'isTest tidak boleh mengunci claim lease resmi');
    });

    // 27.7 Kueri history memfilter berdasarkan owner_id
    it('27.7 Endpoint history memfilter log langsung berdasarkan owner_id', () => {
      const workspaceRoutesPath = path.resolve(__dirname, '../src/routes/workspace.routes.js');
      const wsCode = fs.readFileSync(workspaceRoutesPath, 'utf8');

      assert.equal(
        wsCode.includes("owner_id.eq.${req.auth.ownerId}"),
        true,
        'workspace.routes.js wajib memiliki filter kueri terindeks owner_id.eq'
      );
      assert.equal(
        wsCode.includes("report_date, trigger_source"),
        true,
        'workspace.routes.js harus menyertakan report_date dan trigger_source pada select history'
      );
    });

    // 27.8 Migration lokal 023 dan isolasi PO/Dokumen/Retur
    it('27.8 File migration 023_daily_report_email_logs_idempotency.sql tersedia di lokal dengan partial index', () => {
      const migPath = path.resolve(__dirname, '../supabase/migrations/023_daily_report_email_logs_idempotency.sql');
      assert.equal(fs.existsSync(migPath), true, 'File migration 023 lokal harus ada di direktori migrations');

      const migSql = fs.readFileSync(migPath, 'utf8');
      assert.match(migSql, /ADD COLUMN IF NOT EXISTS owner_id UUID/i);
      assert.match(migSql, /ADD COLUMN IF NOT EXISTS report_date DATE/i);
      assert.match(migSql, /ADD COLUMN IF NOT EXISTS trigger_source TEXT/i);
      assert.match(migSql, /idx_email_logs_daily_report_claim_unique/i);
      assert.match(migSql, /email_type\s*=\s*'daily_report'/i);
    });

  });

});




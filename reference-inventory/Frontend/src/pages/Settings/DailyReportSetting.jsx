import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  Lock,
  Mail,
  Building,
  Save,
  Send,
  Eye,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  X,
  ShieldCheck,
  Calendar,
  FileText,
  AlertCircle,
  PlayCircle,
  Info,
  Users,
} from 'lucide-react';
import { api } from '../../utils/api.js';
import './DailyReportSetting.css';

export default function DailyReportSetting() {
  const queryClient = useQueryClient();

  // Settings State
  const [enabled, setEnabled] = useState(false);
  const scheduleTime = '19:00';
  const [includeGoodsIn, setIncludeGoodsIn] = useState(true);
  const [includeGoodsOut, setIncludeGoodsOut] = useState(true);
  const [includeReturns, setIncludeReturns] = useState(true);
  const [authorizedOwnerId, setAuthorizedOwnerId] = useState('');
  const [useCompanyEmail, setUseCompanyEmail] = useState(true);
  const [customRecipients, setCustomRecipients] = useState('');

  // Feedback State
  const [feedback, setFeedback] = useState(null);

  // Modals State
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  const [dryRunModalOpen, setDryRunModalOpen] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);

  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testEmailInput, setTestEmailInput] = useState('');
  const [testConfirmed, setTestConfirmed] = useState(false);

  const [confirmSendModalOpen, setConfirmSendModalOpen] = useState(false);
  const [officialConfirmed, setOfficialConfirmed] = useState(false);

  // 1. Fetch settings and owners list
  const { data: settingsData, isLoading: loadingSettings, refetch: refetchSettings } = useQuery({
    queryKey: ['daily-report-settings'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/daily-report/settings');
      if (!res.ok) throw new Error('Gagal memuat pengaturan laporan harian');
      return res.json();
    },
    staleTime: 30000,
  });

  // 2. Fetch History
  const { data: historyData, isLoading: loadingHistory, isError: historyError, refetch: refetchHistory } = useQuery({
    queryKey: ['daily-report-history'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/daily-report/history');
      if (!res.ok) return { logs: [] };
      return res.json();
    },
    staleTime: 15000,
  });

  const ownersList = settingsData?.owners || [];

  const handleSelectOwner = (ownerId) => {
    setAuthorizedOwnerId(ownerId);
    const target = ownersList.find((o) => o.id === ownerId);
    if (target?.settings) {
      setEnabled(Boolean(target.settings.enabled));
      setIncludeGoodsIn(target.settings.includeGoodsIn !== false);
      setIncludeGoodsOut(target.settings.includeGoodsOut !== false);
      setIncludeReturns(target.settings.includeReturns !== false);
      setUseCompanyEmail(target.settings.useCompanyEmail !== false);
      setCustomRecipients(
        Array.isArray(target.settings.customRecipients)
          ? target.settings.customRecipients.join(', ')
          : (target.settings.customRecipients || '')
      );
    }
  };

  useEffect(() => {
    if (settingsData) {
      const list = settingsData.owners || [];
      const currentSelectedId = authorizedOwnerId || settingsData.selectedOwnerId || list[0]?.id || '';

      if (!authorizedOwnerId && currentSelectedId) {
        setAuthorizedOwnerId(currentSelectedId);
      }

      const activeOwner = list.find((o) => o.id === (authorizedOwnerId || currentSelectedId));
      const s = activeOwner?.settings || settingsData.settings;

      if (s) {
        const isUserOwner = Boolean(settingsData.isOwner);
        setEnabled(isUserOwner ? Boolean(settingsData.settings?.enabled) : Boolean(s.enabled));
        setIncludeGoodsIn(s.includeGoodsIn !== false);
        setIncludeGoodsOut(s.includeGoodsOut !== false);
        setIncludeReturns(s.includeReturns !== false);
        setUseCompanyEmail(s.useCompanyEmail !== false);
        setCustomRecipients(
          Array.isArray(s.customRecipients)
            ? s.customRecipients.join(', ')
            : (s.customRecipients || '')
        );
      }
    }
  }, [settingsData]);

  // Handle Goods In / Out / Return toggles: setidaknya satu opsi harus aktif
  const handleToggleGoodsIn = (checked) => {
    if (!checked && !includeGoodsOut && !includeReturns) {
      setFeedback({ type: 'error', text: 'Minimal satu jenis laporan (Goods In, Goods Out, atau Return) harus dipilih.' });
      return;
    }
    setIncludeGoodsIn(checked);
  };

  const handleToggleGoodsOut = (checked) => {
    if (!checked && !includeGoodsIn && !includeReturns) {
      setFeedback({ type: 'error', text: 'Minimal satu jenis laporan (Goods In, Goods Out, atau Return) harus dipilih.' });
      return;
    }
    setIncludeGoodsOut(checked);
  };

  const handleToggleReturns = (checked) => {
    if (!checked && !includeGoodsIn && !includeGoodsOut) {
      setFeedback({ type: 'error', text: 'Minimal satu jenis laporan (Goods In, Goods Out, atau Return) harus dipilih.' });
      return;
    }
    setIncludeReturns(checked);
  };

  // Mutation: Quick Toggle per Owner (Super Admin)
  const toggleOwnerMutation = useMutation({
    mutationFn: async ({ ownerId, enabled: newStatus }) => {
      const res = await api.patch('/api/workspace/daily-report/settings', {
        ownerId,
        enabled: newStatus,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || err?.message || 'Gagal mengubah status laporan');
      }
      return res.json();
    },
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries(['daily-report-settings']);
      if (vars.ownerId === authorizedOwnerId) {
        setEnabled(vars.enabled);
      }
      setFeedback({
        type: 'success',
        text: `Status laporan harian untuk tenant berhasil ${vars.enabled ? 'diaktifkan (ON)' : 'dinonaktifkan (OFF)'}!`,
      });
      setTimeout(() => setFeedback(null), 4000);
    },
    onError: (err) => {
      setFeedback({ type: 'error', text: err.message || 'Gagal mengubah status laporan' });
    },
  });

  // Mutation: Save Settings
  const saveMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await api.patch('/api/workspace/daily-report/settings', payload);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || err?.message || 'Gagal menyimpan pengaturan');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['daily-report-settings']);
      setFeedback({ type: 'success', text: 'Pengaturan laporan harian berhasil disimpan!' });
      setTimeout(() => setFeedback(null), 4000);
    },
    onError: (err) => {
      setFeedback({ type: 'error', text: err.message || 'Gagal menyimpan' });
    },
  });

  const handleSave = (e) => {
    e?.preventDefault();

    // 1. Validasi jenis laporan
    if (!includeGoodsIn && !includeGoodsOut && !includeReturns) {
      setFeedback({ type: 'error', text: 'Minimal satu jenis laporan (Goods In, Goods Out, atau Return) harus dipilih.' });
      return;
    }

    // 2. Format jam: statis 19:00 WIB
    const validScheduleTime = '19:00';

    // 3. Validasi custom recipients jika diisi
    if (customRecipients.trim()) {
      const list = customRecipients.split(',').map((item) => item.trim()).filter(Boolean);
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const mail of list) {
        if (!emailRegex.test(mail)) {
          setFeedback({ type: 'error', text: `Alamat email tambahan "${mail}" tidak valid.` });
          return;
        }
      }
    }

    // 4. Validasi owner terotorisasi
    if (!authorizedOwnerId) {
      setFeedback({ type: 'error', text: 'Pilih salah satu tenant / perusahaan yang diotorisasi.' });
      return;
    }

    const isUserOwner = Boolean(settingsData?.isOwner);

    saveMutation.mutate({
      ownerId: authorizedOwnerId,
      authorizedOwnerId,
      enabled: isUserOwner ? Boolean(settingsData?.settings?.enabled) : enabled,
      scheduleTime: validScheduleTime,
      timeZone: 'Asia/Jakarta',
      includeGoodsIn,
      includeGoodsOut,
      includeReturns,
      useCompanyEmail,
      customRecipients,
    });
  };

  // Action: Open Preview
  const handleOpenPreview = async () => {
    if (!authorizedOwnerId) {
      setFeedback({ type: 'error', text: 'Pilih tenant terlebih dahulu untuk melihat pratinjau.' });
      return;
    }
    setPreviewLoading(true);
    setPreviewModalOpen(true);
    try {
      const res = await api.get(`/api/workspace/daily-report/preview?ownerId=${authorizedOwnerId}&includeGoodsIn=${includeGoodsIn}&includeGoodsOut=${includeGoodsOut}&includeReturns=${includeReturns}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || 'Gagal memuat pratinjau laporan');
      }
      const json = await res.json();
      setPreviewHtml(json.html || '');
    } catch (err) {
      setPreviewHtml(`<div style="padding: 24px; color: #dc2626; font-size: 14px;"><strong>Gagal memuat pratinjau:</strong> ${err.message}</div>`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Mutation: Dry-Run Simulation (No real email sent)
  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/workspace/daily-report/send', {
        dryRun: true,
        ownerId: authorizedOwnerId,
        includeGoodsIn,
        includeGoodsOut,
        includeReturns,
        useCompanyEmail,
        customRecipients,
      });
      const json = await res.json();
      if (!res.ok || json.result?.status === 'failed') {
        throw new Error(json.result?.error || 'Gagal menjalankan simulasi');
      }
      return json;
    },
    onSuccess: (data) => {
      setDryRunResult(data.result);
      setDryRunModalOpen(true);
    },
    onError: (err) => {
      setFeedback({ type: 'error', text: `Simulasi gagal: ${err.message}` });
    },
  });

  // Mutation: Send Real Test Email
  const sendTestMutation = useMutation({
    mutationFn: async (testEmail) => {
      const res = await api.post('/api/workspace/daily-report/send', {
        isTest: true,
        testRecipient: testEmail,
        ownerId: authorizedOwnerId,
      });
      const json = await res.json();
      if (!res.ok || json.result?.status === 'failed') {
        throw new Error(json.result?.error || 'Gagal mengirim email uji coba');
      }
      return json;
    },
    onSuccess: (data) => {
      setTestModalOpen(false);
      setTestEmailInput('');
      setTestConfirmed(false);
      refetchHistory();
      setFeedback({
        type: 'success',
        text: `Email uji coba berhasil dikirim ke ${data.result?.primaryRecipient || 'penerima'}!`,
      });
      setTimeout(() => setFeedback(null), 5000);
    },
    onError: (err) => {
      setFeedback({ type: 'error', text: err.message });
    },
  });

  // Mutation: Send Official Production Report Now
  const sendManualMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/workspace/daily-report/send', {
        isTest: false,
        force: true,
        ownerId: authorizedOwnerId,
        includeGoodsIn,
        includeGoodsOut,
        includeReturns,
        useCompanyEmail,
        customRecipients,
      });
      const json = await res.json();
      if (!res.ok || json.result?.status === 'failed') {
        throw new Error(json.result?.error || 'Gagal mengirim laporan resmi');
      }
      return json;
    },
    onSuccess: (data) => {
      setConfirmSendModalOpen(false);
      setOfficialConfirmed(false);
      refetchHistory();
      setFeedback({
        type: 'success',
        text: `Laporan harian resmi berhasil dikirim ke ${data.result?.primaryRecipient || 'penerima'}!`,
      });
      setTimeout(() => setFeedback(null), 5000);
    },
    onError: (err) => {
      setFeedback({ type: 'error', text: err.message });
    },
  });

  const isOwner = Boolean(settingsData?.isOwner);
  const selectedOwner = ownersList.find((o) => o.id === authorizedOwnerId) || ownersList[0];
  const currentCompanyEmail = selectedOwner?.companyEmail || (authorizedOwnerId === settingsData?.settings?.authorizedOwnerId ? settingsData?.companyEmail : null) || 'Belum diatur di Informasi Perusahaan';
  const historyLogs = historyData?.logs || [];
  const isSelectedOwnerEnabled = selectedOwner?.enabled ?? enabled;

  return (
    <div className="daily-report-setting">
      {/* ── NOTICE BANNER: STATUS FITUR ── */}
      {isOwner ? (
        settingsData?.settings?.enabled ? (
          <div className="daily-report__notice-banner" style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46' }}>
            <CheckCircle size={20} className="daily-report__notice-icon" style={{ color: '#059669' }} />
            <div>
              <strong>Status Otomatisasi: Laporan Harian Aktif (19.00 WIB)</strong>
              <div style={{ marginTop: 4, fontSize: 13, color: '#047857' }}>
                Laporan operasional harian gudang untuk perusahaan Anda dijadwalkan otomatis dikirim setiap hari pukul <strong>19.00 WIB</strong> oleh sistem terpusat. Anda dapat menyesuaikan cakupan dokumen dan penerima tembusan (CC) di bawah.
              </div>
            </div>
          </div>
        ) : (
          <div className="daily-report__notice-banner" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
            <AlertCircle size={20} className="daily-report__notice-icon" style={{ color: '#d97706' }} />
            <div>
              <strong>Status Otomatisasi: Nonaktif (Dikelola Super Admin)</strong>
              <div style={{ marginTop: 4, fontSize: 13, color: '#78350f' }}>
                Pengiriman otomatis Daily Report untuk akun Anda saat ini sedang dinonaktifkan. Pengaktifan jadwal otomatis (pukul <strong>19.00 WIB</strong>) dikelola secara aman oleh Super Admin. Hubungi Super Admin jika ingin mengaktifkan jadwal otomatis.
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="daily-report__notice-banner">
          <Clock size={18} className="daily-report__notice-icon" />
          <div>
            <strong>Otomatisasi Laporan Gudang (Super Admin):</strong> Ringkasan Goods In, Goods Out, dan Return untuk tenant yang diaktifkan dikirim otomatis setiap hari pukul <strong>19.00 WIB</strong> (12.00 UTC).
          </div>
        </div>
      )}

      {feedback && (
        <div className={`daily-report__feedback daily-report__feedback--${feedback.type}`}>
          {feedback.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* ── DAFTAR TENANT & KONTROL PER OWNER (SUPER ADMIN ONLY) ── */}
      {!isOwner && (
        <div className="daily-report__card daily-report__card--owners-table">
          <div className="daily-report__card-header">
            <div className="daily-report__card-title-group">
              <Users size={18} color="#4F46E5" />
              <h3 className="daily-report__card-title">Daftar Tenant & Status Laporan Harian (Per Owner)</h3>
            </div>
            <div style={{ fontSize: 12, color: '#64748B' }}>
              Total: <strong>{ownersList.length} Tenant</strong> | Aktif (ON): <strong>{ownersList.filter((o) => o.enabled).length}</strong>
            </div>
          </div>
          <div className="daily-report__card-body" style={{ padding: 0 }}>
            <div className="daily-report__table-wrap">
              <table className="daily-report__table">
                <thead>
                  <tr>
                    <th>Tenant / Perusahaan</th>
                    <th>Nama Owner</th>
                    <th>Email Operasional</th>
                    <th>Status Laporan</th>
                    <th style={{ textAlign: 'center' }}>Jadwal</th>
                    <th style={{ textAlign: 'center' }}>Kontrol ON/OFF</th>
                    <th style={{ textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {ownersList.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#64748B' }}>
                        Tidak ada tenant owner terdaftar.
                      </td>
                    </tr>
                  ) : (
                    ownersList.map((o) => {
                      const isSelected = o.id === authorizedOwnerId;
                      const isToggling = toggleOwnerMutation.isPending && toggleOwnerMutation.variables?.ownerId === o.id;
                      return (
                        <tr
                          key={o.id}
                          className={`daily-report__owner-row ${isSelected ? 'daily-report__owner-row--selected' : ''}`}
                        >
                          <td>
                            <div style={{ fontWeight: 600, color: '#1E293B' }}>{o.companyName || o.name}</div>
                            {o.companyName && o.companyName !== o.name && (
                              <div style={{ fontSize: 11, color: '#64748B' }}>{o.name}</div>
                            )}
                          </td>
                          <td>{o.name}</td>
                          <td>
                            {o.companyEmail ? (
                              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.companyEmail}</span>
                            ) : (
                              <span style={{ color: '#EF4444', fontSize: 11 }}>Belum diatur</span>
                            )}
                          </td>
                          <td>
                            <span className={`daily-report__badge ${o.enabled ? 'daily-report__badge--active' : 'daily-report__badge--inactive'}`}>
                              {o.enabled ? 'AKTIF (19.00 WIB)' : 'NONAKTIF (OFF)'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center', whiteSpace: 'nowrap', fontSize: 12 }}>
                            {o.enabled ? '19.00 WIB' : '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              type="button"
                              className={`daily-report__btn-toggle ${o.enabled ? 'daily-report__btn-toggle--on' : 'daily-report__btn-toggle--off'}`}
                              disabled={isToggling}
                              onClick={() => toggleOwnerMutation.mutate({ ownerId: o.id, enabled: !o.enabled })}
                              title={o.enabled ? 'Klik untuk menonaktifkan laporan owner ini' : 'Klik untuk mengaktifkan laporan owner ini'}
                            >
                              <span className="daily-report__btn-toggle-knob" />
                              <span className="daily-report__btn-toggle-label">{o.enabled ? 'ON' : 'OFF'}</span>
                            </button>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className={`daily-report__btn daily-report__btn--xs ${isSelected ? 'daily-report__btn--primary' : 'daily-report__btn--secondary'}`}
                              onClick={() => handleSelectOwner(o.id)}
                            >
                              {isSelected ? 'Sedang Dipilih' : 'Kelola Detail'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 16px', background: '#F8FAFC', borderTop: '1px solid #E2E8F0', fontSize: 12, color: '#64748B' }}>
              Status ON/OFF per owner bersifat independen dan disimpan langsung di database. Owner dengan status <strong>AKTIF</strong> akan diproses oleh Cron pada pukul <strong>19.00 WIB</strong>, sedangkan status <strong>NONAKTIF</strong> dilewati otomatis.
            </div>
          </div>
        </div>
      )}

      <div className="daily-report__layout">
        {/* Left Column: Konfigurasi */}
        <div className="daily-report__col">
          {/* 1. Status Otomatisasi & Jam Pengiriman */}
          <div className="daily-report__card">
            <div className="daily-report__card-header">
              <div className="daily-report__card-title-group">
                <Clock size={18} color="#4F46E5" />
                <h3 className="daily-report__card-title">
                  {isOwner ? 'Otomatisasi Laporan' : `Otomatisasi: ${selectedOwner?.companyName || selectedOwner?.name || 'Owner'}`}
                </h3>
              </div>
              <span className={`daily-report__badge ${isOwner ? (settingsData?.settings?.enabled ? 'daily-report__badge--active' : 'daily-report__badge--warning') : (enabled ? 'daily-report__badge--active' : 'daily-report__badge--inactive')}`}>
                {isOwner ? (settingsData?.settings?.enabled ? 'AKTIF (19.00 WIB)' : 'NONAKTIF (SUPER ADMIN)') : (enabled ? 'AKTIF (19.00 WIB)' : 'NONAKTIF (OFF)')}
              </span>
            </div>
            <div className="daily-report__card-body">
              <div className="daily-report__toggle-row" style={isOwner ? { opacity: 0.85, background: '#f8fafc' } : {}}>
                <div className="daily-report__toggle-info">
                  <span className="daily-report__toggle-title">Kirim Otomatis Harian</span>
                  <span className="daily-report__toggle-desc">
                    {isOwner
                      ? (settingsData?.settings?.enabled
                        ? 'Laporan harian aktif dan dijadwalkan otomatis setiap pukul 19.00 WIB.'
                        : 'Pengiriman otomatis dikelola oleh Super Admin (tidak dapat diaktifkan sendiri).')
                      : (enabled
                        ? `Laporan untuk ${selectedOwner?.companyName || 'tenant ini'} dijadwalkan otomatis pukul 19.00 WIB.`
                        : `Pengiriman otomatis untuk ${selectedOwner?.companyName || 'tenant ini'} dinonaktifkan.`)}
                  </span>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {isOwner && <Lock size={14} color="#64748B" />}
                  <label style={{ display: 'inline-flex', alignItems: 'center', cursor: isOwner ? 'not-allowed' : 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={isOwner ? Boolean(settingsData?.settings?.enabled) : enabled}
                      disabled={isOwner}
                      onChange={(e) => !isOwner && setEnabled(e.target.checked)}
                      style={{ width: 20, height: 20, cursor: isOwner ? 'not-allowed' : 'pointer' }}
                    />
                  </label>
                </div>
              </div>

              {/* Jadwal Pengiriman Statis 19.00 WIB */}
              <div className="daily-report__field">
                <label className="daily-report__label">Waktu Pengiriman Harian (Statis)</label>
                <div className="daily-report__time-box">
                  <div className="daily-report__time-static">
                    <Clock size={16} color="#4F46E5" />
                    <span className="daily-report__time-val">19:00</span>
                    <span className="daily-report__time-tz">WIB</span>
                    <span className="daily-report__time-lock-badge">
                      <Lock size={12} />
                      Jadwal Statis Vercel Cron (12.00 UTC)
                    </span>
                  </div>
                </div>
                <span className="daily-report__hint">
                  {isOwner
                    ? 'Jadwal global pengiriman harian DocuFlow V1 berjalan statis pada pukul 19.00 WIB (dikelola oleh Super Admin).'
                    : 'Jadwal pengiriman otomatis dikunci statis pada pukul 19.00 WIB (12.00 UTC) sesuai penjadwal Vercel Cron. Pengaturan jam fleksibel dinonaktifkan untuk menjamin ketepatan eksekusi server.'}
                </span>
              </div>
            </div>
          </div>

          {/* 2. Konten Dokumen (Goods In, Out, Return) */}
          <div className="daily-report__card">
            <div className="daily-report__card-header">
              <div className="daily-report__card-title-group">
                <FileText size={18} color="#10B981" />
                <h3 className="daily-report__card-title">Lingkup Data & Konten</h3>
              </div>
            </div>
            <div className="daily-report__card-body">
              <div className="daily-report__checkbox-group">
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeGoodsIn}
                    onChange={(e) => handleToggleGoodsIn(e.target.checked)}
                  />
                  <span>Barang Masuk (Goods In)</span>
                </label>
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeGoodsOut}
                    onChange={(e) => handleToggleGoodsOut(e.target.checked)}
                  />
                  <span>Barang Keluar (Goods Out)</span>
                </label>
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeReturns}
                    onChange={(e) => handleToggleReturns(e.target.checked)}
                  />
                  <span>Retur Barang (Return)</span>
                </label>
              </div>
              <div className="daily-report__mini-hint">
                <ShieldCheck size={15} color="#059669" style={{ flexShrink: 0 }} />
                <span>Hanya dokumen berstatus <strong>Completed</strong> yang dihitung ke dalam mutasi stok.</span>
              </div>
            </div>
          </div>

          {/* 3. Penerima & Tenant */}
          <div className="daily-report__card">
            <div className="daily-report__card-header">
              <div className="daily-report__card-title-group">
                <Building size={18} color="#6366F1" />
                <h3 className="daily-report__card-title">Penerima Laporan</h3>
              </div>
            </div>
            <div className="daily-report__card-body">
              {isOwner ? (
                // Khusus Akun Owner: hanya menampilkan perusahaannya sendiri
                <div className="daily-report__field">
                  <label className="daily-report__label">Perusahaan Anda</label>
                  <div className="daily-report__owner-card">
                    <Building size={18} color="#4F46E5" style={{ flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div className="daily-report__owner-name">
                        {selectedOwner?.companyName || selectedOwner?.name || 'Perusahaan Anda'}
                      </div>
                      <div className="daily-report__owner-email">
                        {currentCompanyEmail}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                // Khusus Akun Super Admin: dapat memilih tenant
                <div className="daily-report__field">
                  <label className="daily-report__label">Tenant Terotorisasi</label>
                  <select
                    className="daily-report__select"
                    value={authorizedOwnerId}
                    onChange={(e) => handleSelectOwner(e.target.value)}
                  >
                    {ownersList.length === 0 ? (
                      <option value="">Tidak ada tenant owner terdaftar</option>
                    ) : (
                      ownersList.map((o) => {
                        const statusLabel = o.enabled ? ' [AKTIF]' : ' [OFF]';
                        const emailDisplay = o.companyEmail ? ` — ${o.companyEmail}` : '';
                        const nameDisplay = o.companyName && o.companyName !== o.name ? `${o.name} (${o.companyName})` : o.name;
                        return (
                          <option key={o.id} value={o.id}>
                            {nameDisplay}{emailDisplay}{statusLabel}
                          </option>
                        );
                      })
                    )}
                  </select>
                </div>
              )}

              {/* Checkbox Gunakan Email Perusahaan */}
              <div className="daily-report__field">
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={useCompanyEmail}
                    onChange={(e) => setUseCompanyEmail(e.target.checked)}
                  />
                  <span>Kirim ke Email Perusahaan ({currentCompanyEmail})</span>
                </label>
              </div>

              {/* Email Penerima Tambahan / CC */}
              <div className="daily-report__field">
                <label className="daily-report__label">Email Tambahan / CC (Opsional)</label>
                <input
                  type="text"
                  className="daily-report__input"
                  placeholder="contoh: owner@domain.com, manager@domain.com"
                  value={customRecipients}
                  onChange={(e) => setCustomRecipients(e.target.value)}
                />
                <span className="daily-report__hint">
                  Email perusahaan menerima laporan utama (To), email tambahan menerima tembusan (CC).
                </span>
              </div>
            </div>
          </div>

          {/* Tombol Simpan & Pratinjau */}
          <div className="daily-report__actions">
            <button
              type="button"
              className="daily-report__btn daily-report__btn--primary"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              <Save size={16} />
              <span>{saveMutation.isPending ? 'Menyimpan...' : 'Simpan Pengaturan'}</span>
            </button>

            <button
              type="button"
              className="daily-report__btn daily-report__btn--secondary"
              onClick={handleOpenPreview}
            >
              <Eye size={16} />
              <span>Pratinjau Laporan Hari Ini</span>
            </button>
          </div>
        </div>

        {/* Right Column: Actions & Delivery History */}
        <div className="daily-report__col">
          {/* Quick Actions Card */}
          <div className="daily-report__card">
            <div className="daily-report__card-header">
              <div className="daily-report__card-title-group">
                <Send size={18} color="#3B82F6" />
                <h3 className="daily-report__card-title">Tindakan Pengiriman</h3>
              </div>
            </div>
            <div className="daily-report__card-body">
              <p style={{ margin: 0, fontSize: 13, color: '#4B5563', lineHeight: 1.5 }}>
                Uji format laporan harian tanpa SMTP, atau kirim langsung laporan operasional hari ini.
              </p>

              <div className="daily-report__action-list">
                {/* 1. Tombol Kirim Simulasi (Dry Run) */}
                <button
                  type="button"
                  className="daily-report__btn daily-report__btn--secondary"
                  onClick={() => dryRunMutation.mutate()}
                  disabled={dryRunMutation.isPending || !authorizedOwnerId}
                  style={{ justifyContent: 'center', borderColor: '#0284C7', color: '#0284C7' }}
                >
                  <PlayCircle size={16} />
                  <span>{dryRunMutation.isPending ? 'Menjalankan Simulasi...' : 'Kirim Simulasi (Dry Run)'}</span>
                </button>

                {/* 2. Tombol Kirim Email Uji Coba (Super Admin Only) */}
                {!isOwner && (
                  <button
                    type="button"
                    className="daily-report__btn daily-report__btn--secondary"
                    onClick={() => setTestModalOpen(true)}
                    style={{ justifyContent: 'center' }}
                  >
                    <Mail size={16} />
                    <span>Kirim Email Uji Coba</span>
                  </button>
                )}

                {/* 3. Tombol Kirim Laporan Resmi (Super Admin Only) */}
                {!isOwner ? (
                  <button
                    type="button"
                    className="daily-report__btn daily-report__btn--secondary"
                    onClick={() => setConfirmSendModalOpen(true)}
                    style={{ justifyContent: 'center', borderColor: '#4F46E5', color: '#4F46E5' }}
                  >
                    <Send size={16} />
                    <span>Kirim Laporan Resmi Hari Ini</span>
                  </button>
                ) : (
                  <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px dashed #cbd5e1', fontSize: 12, color: '#64748b', textAlign: 'center' }}>
                    Pengiriman manual dinonaktifkan sementara untuk akun Owner.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Delivery History Card */}
          <div className="daily-report__card">
            <div className="daily-report__card-header">
              <div className="daily-report__card-title-group">
                <Calendar size={18} color="#059669" />
                <h3 className="daily-report__card-title">Riwayat Pengiriman Terakhir</h3>
              </div>
              <button
                type="button"
                className="daily-report__btn daily-report__btn--secondary"
                style={{ padding: '4px 8px', fontSize: 11 }}
                onClick={() => refetchHistory()}
                disabled={loadingHistory}
              >
                <RefreshCw size={12} className={loadingHistory ? 'spin' : ''} />
                <span>Refresh</span>
              </button>
            </div>
            <div className="daily-report__card-body" style={{ padding: 0 }}>
              <div className="daily-report__table-wrap">
                <table className="daily-report__table">
                  <thead>
                    <tr>
                      <th>Waktu (WIB)</th>
                      <th>Penerima</th>
                      <th>Status</th>
                      <th>Keterangan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingHistory ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#64748B', padding: 20 }}>
                          Memuat riwayat pengiriman...
                        </td>
                      </tr>
                    ) : historyError ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#dc2626', padding: 20 }}>
                          Gagal memuat riwayat pengiriman dari server.
                        </td>
                      </tr>
                    ) : historyLogs.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#64748B', padding: 20 }}>
                          Belum ada riwayat pengiriman laporan harian.
                        </td>
                      </tr>
                    ) : (
                      historyLogs.map((log) => {
                        const dateFormatted = log.sent_at || log.created_at
                          ? new Date(log.sent_at || log.created_at).toLocaleString('id-ID', {
                              timeZone: 'Asia/Jakarta',
                              dateStyle: 'short',
                              timeStyle: 'short',
                            }) + ' WIB'
                          : '—';
                        return (
                          <tr key={log.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{dateFormatted}</td>
                            <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.recipient_email}>
                              {log.recipient_email}
                            </td>
                            <td>
                              <span
                                className={`daily-report__badge ${
                                  log.status === 'sent'
                                    ? 'daily-report__badge--active'
                                    : 'daily-report__badge--inactive'
                                }`}
                                style={{
                                  background: log.status === 'sent' ? '#dcfce7' : '#fee2e2',
                                  color: log.status === 'sent' ? '#15803d' : '#b91c1c',
                                  borderColor: log.status === 'sent' ? '#bbf7d0' : '#fecaca',
                                }}
                              >
                                {log.status}
                              </span>
                            </td>
                            <td style={{ fontSize: 11, color: log.status === 'failed' ? '#dc2626' : '#64748B' }}>
                              {log.error_message ? log.error_message : log.subject}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── MODAL PRATINJAU LAPORAN (HTML LIVE PREVIEW) ── */}
      {previewModalOpen && (
        <div className="daily-report__modal-overlay">
          <div className="daily-report__modal">
            <div className="daily-report__modal-header">
              <h4 className="daily-report__modal-title">Pratinjau Tampilan Email Laporan Hari Ini</h4>
              <button
                type="button"
                onClick={() => setPreviewModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="daily-report__modal-body">
              {previewLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#64748B' }}>
                  Memuat data transaksi dan merakit HTML laporan...
                </div>
              ) : (
                <div
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                  style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}
                />
              )}
            </div>
            <div className="daily-report__modal-footer">
              <button
                type="button"
                className="daily-report__btn daily-report__btn--secondary"
                onClick={() => setPreviewModalOpen(false)}
              >
                Tutup Pratinjau
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL HASIL SIMULASI (DRY RUN) ── */}
      {dryRunModalOpen && dryRunResult && (
        <div className="daily-report__modal-overlay">
          <div className="daily-report__modal" style={{ maxWidth: 540 }}>
            <div className="daily-report__modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={20} color="#059669" />
                <h4 className="daily-report__modal-title">Hasil Simulasi Pengiriman (Dry Run)</h4>
              </div>
              <button
                type="button"
                onClick={() => setDryRunModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="daily-report__modal-body">
              <div className="daily-report__sim-card">
                <div style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>
                  ✓ Simulasi Selesai: Seluruh data berhasil diagregasi dan divalidasi tanpa memanggil SMTP server.
                </div>

                <div className="daily-report__sim-stat">
                  <div className="daily-report__sim-stat-box">
                    <div className="daily-report__sim-stat-label">Barang Masuk (Goods In)</div>
                    <div className="daily-report__sim-stat-val">
                      {dryRunResult.report?.goodsIn?.completedCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b' }}>dok ({dryRunResult.report?.goodsIn?.totalPcs || 0} pcs)</span>
                    </div>
                  </div>
                  <div className="daily-report__sim-stat-box">
                    <div className="daily-report__sim-stat-label">Barang Keluar (Goods Out)</div>
                    <div className="daily-report__sim-stat-val">
                      {dryRunResult.report?.goodsOut?.completedCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: '#64748b' }}>dok ({dryRunResult.report?.goodsOut?.totalPcs || 0} pcs)</span>
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: '#334155', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><strong>Tanggal Target:</strong> {dryRunResult.targetDate}</div>
                  <div><strong>Penerima Simulasi:</strong> {dryRunResult.primaryRecipient}</div>
                  <div><strong>Subjek:</strong> {dryRunResult.subject}</div>
                </div>
              </div>
            </div>
            <div className="daily-report__modal-footer">
              <button
                type="button"
                className="daily-report__btn daily-report__btn--primary"
                onClick={() => setDryRunModalOpen(false)}
              >
                Tutup Hasil Simulasi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL KIRIM UJI COBA REAL (DENGAN KONFIRMASI EKSPLISIT) ── */}
      {testModalOpen && (
        <div className="daily-report__modal-overlay">
          <div className="daily-report__modal" style={{ maxWidth: 500 }}>
            <div className="daily-report__modal-header">
              <h4 className="daily-report__modal-title">Kirim Email Uji Coba Nyata</h4>
              <button
                type="button"
                onClick={() => {
                  setTestModalOpen(false);
                  setTestConfirmed(false);
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="daily-report__modal-body">
              <div style={{ padding: 12, background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 6, fontSize: 12, color: '#92400E', marginBottom: 16 }}>
                <strong>Pemberitahuan:</strong> Tindakan ini akan mengirim <strong>1 email sungguhan</strong> via SMTP server ke alamat yang Anda tentukan di bawah. Subjek email akan diberi awalan <em>[TEST PREVIEW]</em>.
              </div>

              <div className="daily-report__field">
                <label className="daily-report__label">Alamat Email Penerima Uji Coba</label>
                <input
                  type="email"
                  className="daily-report__input"
                  placeholder="masukkan email anda..."
                  value={testEmailInput}
                  onChange={(e) => setTestEmailInput(e.target.value)}
                  autoFocus
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={testConfirmed}
                    onChange={(e) => setTestConfirmed(e.target.checked)}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Saya mengonfirmasi untuk mengirim 1 email uji coba nyata sekarang.</span>
                </label>
              </div>
            </div>
            <div className="daily-report__modal-footer">
              <button
                type="button"
                className="daily-report__btn daily-report__btn--secondary"
                onClick={() => {
                  setTestModalOpen(false);
                  setTestConfirmed(false);
                }}
              >
                Batal
              </button>
              <button
                type="button"
                className="daily-report__btn daily-report__btn--primary"
                onClick={() => sendTestMutation.mutate(testEmailInput)}
                disabled={!testEmailInput.trim() || !testConfirmed || sendTestMutation.isPending}
              >
                <Send size={14} />
                <span>{sendTestMutation.isPending ? 'Mengirim...' : 'Kirim Uji Coba'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL KONFIRMASI KIRIM RESMI SEKARANG ── */}
      {confirmSendModalOpen && (
        <div className="daily-report__modal-overlay">
          <div className="daily-report__modal" style={{ maxWidth: 500 }}>
            <div className="daily-report__modal-header">
              <h4 className="daily-report__modal-title">Konfirmasi Pengiriman Laporan Resmi</h4>
              <button
                type="button"
                onClick={() => {
                  setConfirmSendModalOpen(false);
                  setOfficialConfirmed(false);
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="daily-report__modal-body">
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
                <AlertCircle size={24} color="#4F46E5" style={{ flexShrink: 0, marginTop: 2 }} />
                <p style={{ margin: 0, fontSize: 13, color: '#1E293B', lineHeight: 1.5 }}>
                  Anda akan mengirimkan laporan harian resmi hari ini langsung ke email operasional perusahaan (<strong>{currentCompanyEmail}</strong>).
                </p>
              </div>

              <div style={{ padding: 12, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, color: '#475569', marginBottom: 16 }}>
                Pengiriman ini akan dicatat secara resmi di <code>email_logs</code> database. Sistem akan menolak pengiriman ulang otomatis di hari yang sama untuk mencegah duplikasi.
              </div>

              <div>
                <label className="daily-report__checkbox-label">
                  <input
                    type="checkbox"
                    checked={officialConfirmed}
                    onChange={(e) => setOfficialConfirmed(e.target.checked)}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Saya mengonfirmasi pengiriman resmi laporan operasional hari ini.</span>
                </label>
              </div>
            </div>
            <div className="daily-report__modal-footer">
              <button
                type="button"
                className="daily-report__btn daily-report__btn--secondary"
                onClick={() => {
                  setConfirmSendModalOpen(false);
                  setOfficialConfirmed(false);
                }}
              >
                Batal
              </button>
              <button
                type="button"
                className="daily-report__btn daily-report__btn--primary"
                onClick={() => sendManualMutation.mutate()}
                disabled={!officialConfirmed || sendManualMutation.isPending}
              >
                <Send size={14} />
                <span>{sendManualMutation.isPending ? 'Mengirim...' : 'Ya, Kirim Resmi'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

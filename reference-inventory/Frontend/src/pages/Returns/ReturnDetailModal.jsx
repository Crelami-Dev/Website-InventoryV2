import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, RotateCcw, Printer, AlertTriangle, CheckCircle2, Package, Tag, FileText, Mail, Loader2 } from 'lucide-react';
import { api, getWorkspaceSettings } from '../../utils/api.js';
import { generateReturnReceiptHtml, GOODS_PRINT_MODES } from '../../utils/returnReceiptTemplate.js';
import './ReturnDetailModal.css';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

export default function ReturnDetailModal({ returnData, onClose, onRestored }) {
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [showPrintPicker, setShowPrintPicker] = useState(false);
  const [showEmailPanel, setShowEmailPanel] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState(null);

  useEffect(() => {
    if (!returnData || returnData.status === 'restored') return undefined;

    const handleKeyDown = (e) => {
      const target = e.target;
      const isTyping = target instanceof HTMLElement && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      const isAltK = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (e.code === 'KeyK' || String(e.key).toLowerCase() === 'k');

      if (!isAltK || e.repeat || isTyping || showPrintPicker) return;

      e.preventDefault();
      setShowEmailPanel((prev) => !prev);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [returnData, showPrintPicker]);

  useEffect(() => {
    if (!emailFeedback) return undefined;
    const timer = setTimeout(() => setEmailFeedback(null), 8000);
    return () => clearTimeout(timer);
  }, [emailFeedback]);

  if (!returnData) return null;

  const isRestored = returnData.status === 'restored';
  const isGoodsOut = returnData.documentType === 'goods_out';
  const items = returnData.items || [];
  const itemCount = items.reduce((acc, it) => {
    const qty = it.isGroup ? Number(it.targetQty ?? it.returnedQty ?? 1) : Number(it.returnedQty ?? 1);
    return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
  }, 0);

  const printWithMode = async (paperMode) => {
    try {
      const [settings, contactRes] = await Promise.all([
        getWorkspaceSettings(),
        returnData.contactId
          ? api.get(`/api/workspace/contacts/${returnData.contactId}`).then((r) => r.ok ? r.json() : null).catch(() => null)
          : Promise.resolve(null),
      ]);
      const contactData = contactRes?.data || null;
      const htmlContent = generateReturnReceiptHtml(returnData, settings, contactData, paperMode);
      const printWin = window.open('', '_blank', 'width=900,height=750');
      if (printWin) {
        printWin.document.open();
        printWin.document.write(htmlContent);
        printWin.document.close();
      }
    } catch (err) {
      console.error('Failed to print return receipt:', err);
      alert('Gagal mencetak bukti retur: ' + err.message);
    }
  };

  const handleRestore = async () => {
    const confirmMsg = isGoodsOut
      ? `Batalkan transaksi retur ${returnData.returnNumber}?\n\nBarang akan dipotong kembali dari stok gudang dan status nomor seri akan dikembalikan menjadi 'out' (terikat kembali pada surat jalan ini).`
      : `Batalkan transaksi retur ${returnData.returnNumber}?\n\nBarang akan dipulihkan kembali ke stok penerimaan gudang.`;

    if (!window.confirm(confirmMsg)) return;

    setRestoring(true);
    setRestoreError(null);

    try {
      const res = await api.post(`/api/workspace/documents/${returnData.documentId}/returns/${returnData.id}/restore`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || errJson?.message || 'Gagal membatalkan transaksi retur');
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['returns-list'] }),
        queryClient.invalidateQueries({ queryKey: ['goods-out'] }),
        queryClient.invalidateQueries({ queryKey: ['goods-in'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-serials'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-documents'] }),
      ]);

      onRestored?.(returnData.id);
      onClose();
    } catch (err) {
      setRestoreError(err.message || 'Gagal membatalkan transaksi retur');
    } finally {
      setRestoring(false);
    }
  };

  const handleSendReturnEmail = async () => {
    if (sendingEmail || !returnData.documentId || !returnData.id) return;

    setSendingEmail(true);
    setEmailFeedback(null);

    try {
      const res = await api.post(
        `/api/workspace/documents/${returnData.documentId}/returns/${returnData.id}/send-email`
      );
      const json = await res.json().catch(() => ({}));

      if (res.ok && json.success) {
        setEmailFeedback({
          type: 'success',
          message: 'Email retur berhasil dikirim.',
        });
        return;
      }

      const reason = json?.reason || '';
      let message = json?.error || json?.message || 'Gagal mengirim email retur.';
      if (res.status === 409 && reason === 'already_sent') {
        message = 'Email retur ini sudah pernah terkirim. Sistem tidak mengirim duplikat.';
      } else if (res.status === 409 && reason === 'in_progress') {
        message = 'Email retur sedang diproses. Tunggu sebentar sebelum mencoba lagi.';
      } else if (res.status === 409 && reason === 'stale_pending_marked_uncertain') {
        message = 'Status email sebelumnya tidak pasti. Silakan tekan kirim sekali lagi untuk retry manual.';
      }

      setEmailFeedback({ type: res.status === 409 ? 'info' : 'error', message });
    } catch (err) {
      setEmailFeedback({
        type: 'error',
        message: err?.message || 'Terjadi kesalahan jaringan saat mengirim email retur.',
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const reasonLabels = {
    salah_produk: 'Salah Produk',
    cacat_produk: 'Cacat / Rusak',
    batal_beli: 'Batal Beli / Gak Jadi',
    cacat_supplier: 'Cacat / Rusak Supplier',
    salah_kirim: 'Salah Kirim Supplier',
    batal_masuk: 'Batal Masuk Gudang',
    lainnya: 'Lainnya',
  };

  return (
    <div
      className="return-detail-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget && !restoring) onClose(); }}
    >
      <div className="return-detail-modal">
        {/* Header */}
        <div className="return-detail__header">
          <div className="return-detail__header-left">
            <div className="return-detail__icon">
              <RotateCcw size={18} />
            </div>
            <div>
              <h3 className="return-detail__title">{returnData.returnNumber}</h3>
              <p className="return-detail__subtitle">
                <span>Ref Dokumen: <strong>{returnData.documentNumber}</strong></span>
                <span>•</span>
                <span className={isGoodsOut ? 'chip chip-warning chip-sm' : 'chip chip-success chip-sm'}>
                  {isGoodsOut ? 'Barang Keluar' : 'Barang Masuk'}
                </span>
                <span>•</span>
                <span className={isRestored ? 'chip chip-neutral chip-sm' : 'chip chip-info chip-sm'}>
                  {isRestored ? 'Dipulihkan (Restored)' : 'Aktif'}
                </span>
              </p>
            </div>
          </div>
          <button type="button" className="return-detail__close-btn" onClick={onClose} disabled={restoring}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="return-detail__body">
          {restoreError && (
            <div className="chip chip-danger" style={{ padding: '10px 14px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={16} />
              <span>{restoreError}</span>
            </div>
          )}

          {isRestored && (
            <div className="return-detail__restored-callout">
              <strong>Transaksi retur ini telah dibatalkan / dipulihkan.</strong>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>
                Dipulihkan pada: {formatDate(returnData.restoredAt)} {returnData.restoreNotes ? `— "${returnData.restoreNotes}"` : ''}
              </div>
            </div>
          )}

          <div className="return-detail__info-grid">
            <div className="return-detail__info-item">
              <label>Tanggal Retur</label>
              <p>{formatDate(returnData.returnedAt)}</p>
            </div>
            <div className="return-detail__info-item">
              <label>Alasan Retur</label>
              <p>{reasonLabels[returnData.reason] || returnData.reason}</p>
            </div>
            <div className="return-detail__info-item">
              <label>Kondisi Masuk</label>
              <p>
                {returnData.condition === 'damaged' ? (
                  <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>Cacat / Rusak</span>
                ) : (
                  <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>Kondisi Baik</span>
                )}
              </p>
            </div>
            <div className="return-detail__info-item">
              <label>Total Item</label>
              <p>{itemCount} unit ({items.length} jenis)</p>
            </div>
          </div>

          {returnData.notes && (
            <div className="return-detail__notes-callout">
              <strong>Catatan Operator:</strong> "{returnData.notes}"
            </div>
          )}

          {showEmailPanel && (
            <section className="return-detail__email-panel" aria-label="Push email retur">
              <div className="return-detail__email-panel-header">
                <div className="return-detail__email-panel-title">
                  <span className="return-detail__email-panel-icon">
                    <Mail size={16} />
                  </span>
                  <div>
                    <strong>Push Email Retur</strong>
                    <p>Kirim notifikasi retur ke Finance / pembuat dokumen sesuai pengaturan workspace.</p>
                  </div>
                </div>
                <kbd className="return-detail__kbd">ALT + K</kbd>
              </div>

              <div className="return-detail__email-panel-actions">
                <p className="return-detail__email-panel-hint">
                  Gunakan tombol ini jika email otomatis gagal atau status pengirimannya belum pasti.
                  Email yang sudah terkirim tidak akan dikirim ulang.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm interactive"
                  onClick={handleSendReturnEmail}
                  disabled={sendingEmail}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                >
                  {sendingEmail ? (
                    <>
                      <Loader2 size={14} className="return-detail__spin" />
                      <span>Mengirim...</span>
                    </>
                  ) : (
                    <>
                      <Mail size={14} />
                      <span>Kirim Email Retur</span>
                    </>
                  )}
                </button>
              </div>

              {emailFeedback && (
                <div
                  className={`return-detail__email-feedback return-detail__email-feedback--${emailFeedback.type}`}
                  role="status"
                  aria-live="polite"
                >
                  {emailFeedback.type === 'success' ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                  <span>{emailFeedback.message}</span>
                </div>
              )}
            </section>
          )}

          <div>
            <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Daftar Barang yang Diretur
            </h4>
            <div className="return-detail__table-wrap">
              <table className="return-detail__table">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}>No</th>
                    <th>Nama Produk</th>
                    <th>SKU</th>
                    <th>Tracking / Nomor Seri</th>
                    <th style={{ textAlign: 'right' }}>Kuantitas</th>
                    <th style={{ textAlign: 'center' }}>Kondisi</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={idx}>
                      <td style={{ color: 'var(--color-text-muted)' }}>{idx + 1}</td>
                      <td style={{ fontWeight: 600 }}>{it.productName || 'Produk'}</td>
                      <td style={{ color: 'var(--color-text-muted)' }}>{it.sku || '—'}</td>
                      <td>
                        {it.isSerial ? (
                          <span className="return-detail__sn-badge">{it.serialNumber}</span>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>Non-Serial</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {it.isGroup ? (it.targetQty ?? it.returnedQty ?? 1) : (it.returnedQty || 1)} {it.isGroup ? (it.targetUnit ?? it.qtyUnit ?? 'pcs') : (it.qtyUnit || 'pcs')}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {it.condition === 'damaged' || it.targetStatus === 'damaged' ? (
                          <span className="chip chip-danger chip-sm">Rusak</span>
                        ) : (
                          <span className="chip chip-success chip-sm">Baik</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="return-detail__footer">
          <div>
            {!isRestored && (
              <button
                type="button"
                className="btn btn-danger btn-md interactive"
                onClick={handleRestore}
                disabled={restoring}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <RotateCcw size={14} className={restoring ? 'gi-detail__spin' : ''} />
                <span>{restoring ? 'Memulihkan...' : 'Batalkan Retur & Pulihkan'}</span>
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={() => setShowPrintPicker(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Printer size={15} />
              <span>Cetak Bukti Retur</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={onClose}
              disabled={restoring}
            >
              Tutup
            </button>
          </div>
        </div>
      </div>

      {showPrintPicker && (
        <div
          className="return-detail-overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 1200 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowPrintPicker(false); }}
        >
          <div className="return-detail-modal" style={{ maxWidth: '420px', padding: '20px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700, color: 'var(--color-text-primary)' }}>
              Pilih Jenis Cetakan
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
              Pilih format cetak untuk dokumen ini.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {GOODS_PRINT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className="btn btn-secondary interactive"
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', padding: '10px 14px' }}
                  onClick={() => { setShowPrintPicker(false); printWithMode(mode.id); }}
                >
                  <strong>{mode.label}</strong>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 400 }}>{mode.desc}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPrintPicker(false)}>
                Batal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

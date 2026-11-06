import React, { useState, useEffect } from 'react';
import { X, PackageOpen, AlertTriangle, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../utils/api.js';
import './SerialGroupingUngroupModal.css';

export default function SerialGroupingUngroupModal({
  isOpen,
  onClose,
  groupingData,
  onSuccess,
}) {
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setNotes('');
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen || !groupingData) return null;

  const serialNumber = groupingData.result_serial_number || groupingData.group_serial_number || groupingData.grouping_number || 'Group';
  const groupId = groupingData.result_serial_id || groupingData.groupId || groupingData.id || null;
  const productName = groupingData.result_product?.name || groupingData.resultProductName || 'Produk Hasil Grouping';
  const totalPcs = groupingData.total_base_qty_pcs ?? groupingData.totalPcs ?? 0;
  const targetUnit = groupingData.target_unit || 'pcs';
  const targetQty = groupingData.target_qty || 1;

  const handleConfirm = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const res = await api.post('/api/workspace/product-serials/ungroup', {
        groupId,
        groupSerialNumber: serialNumber,
        notes: notes.trim() || 'Pembongkaran group serial melalui riwayat grouping',
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Gagal membongkar group serial.');
      }

      const json = await res.json().catch(() => ({}));
      if (onSuccess) {
        onSuccess(json?.data);
      }
      onClose();
    } catch (err) {
      setErrorMessage(err.message || 'Terjadi kesalahan sistem saat membongkar group.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="sg-modal-backdrop"
      onClick={!isSubmitting ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sg-ungroup-title"
    >
      <div className="sg-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sg-modal-header sg-modal-header--danger">
          <div className="sg-modal-header__title-wrap">
            <div className="sg-modal-icon-badge sg-modal-icon-badge--danger">
              <PackageOpen size={20} />
            </div>
            <div>
              <h3 id="sg-ungroup-title" className="sg-modal-title">Bongkar Group Serial</h3>
              <p className="sg-modal-subtitle">
                Pembalikan mutasi stok resmi melalui dokumen <strong>goods_disassembly</strong>
              </p>
            </div>
          </div>
          <button
            type="button"
            className="sg-modal-close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Tutup"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleConfirm}>
          <div className="sg-modal-body">
            {errorMessage && (
              <div className="sg-alert-box sg-alert-box--danger">
                <AlertCircle size={18} className="sg-alert-box__icon" />
                <div className="sg-alert-box__text">{errorMessage}</div>
              </div>
            )}

            <div className="sg-warning-callout">
              <AlertTriangle size={20} className="sg-warning-callout__icon" />
              <div className="sg-warning-callout__content">
                <strong>Peringatan Reversal Ledger</strong>
                <p>
                  Proses ini akan mengurangi stok produk hasil (<strong>{targetQty} {targetUnit}</strong>) dan mengembalikan seluruh serial nomor komponen asal ke status tersedia di gudang. Transaksi ini tidak dapat dibatalkan kembali.
                </p>
              </div>
            </div>

            <div className="sg-meta-card">
              <div className="sg-meta-row">
                <span className="sg-meta-label">Nomor Grouping:</span>
                <span className="sg-meta-value mono font-semibold">{serialNumber}</span>
              </div>
              <div className="sg-meta-row">
                <span className="sg-meta-label">Produk Hasil:</span>
                <span className="sg-meta-value font-semibold">{productName}</span>
              </div>
              <div className="sg-meta-row">
                <span className="sg-meta-label">Total Kuantitas:</span>
                <span className="sg-meta-value">{targetQty} {targetUnit} ({totalPcs} pcs)</span>
              </div>
            </div>

            <div className="sg-form-group">
              <label className="sg-form-label">
                Alasan Pembongkaran <span className="text-muted">(Opsional)</span>
              </label>
              <textarea
                className="sg-input sg-textarea"
                rows={3}
                placeholder="Misal: Retur sebagian komponen, rekondisi paket, atau pembatalan pesanan..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div className="sg-modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Batal
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Memproses...
                </>
              ) : (
                <>
                  <PackageOpen size={16} /> Konfirmasi Bongkar
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

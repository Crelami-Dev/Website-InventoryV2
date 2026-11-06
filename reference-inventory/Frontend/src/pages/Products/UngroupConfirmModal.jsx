import React, { useState, useEffect } from 'react';
import { X, PackageOpen, AlertTriangle, AlertCircle, Loader2, Info } from 'lucide-react';
import { api } from '../../utils/api.js';
import './UngroupConfirmModal.css';

export default function UngroupConfirmModal({
  isOpen,
  onClose,
  groupSerial,
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

  // Handle escape key
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

  if (!isOpen || !groupSerial) return null;

  const serialNumber = groupSerial.serialNumber || groupSerial.serial_number || 'Group';
  const groupId = groupSerial.id || groupSerial.serialId;
  const productName = groupSerial.productName || groupSerial.resultProductName || groupSerial.product?.name || 'Produk Group';
  const totalPcs = groupSerial.totalPcs || groupSerial.metadata?.totalPcs || groupSerial.pcs || null;
  const memberCount = groupSerial.directMemberCount || groupSerial.metadata?.directMemberCount || groupSerial.metadata?.directMembers?.length || null;
  const leafCount = groupSerial.leafMemberCount || groupSerial.metadata?.leafMemberCount || groupSerial.metadata?.composition?.length || null;

  const handleConfirm = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const res = await api.post('/api/workspace/product-serials/ungroup', {
        groupId,
        groupSerialNumber: serialNumber,
        notes: notes.trim() || 'Dibongkar melalui panel produk',
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Gagal membongkar group serial.');
      }

      const result = await res.json().catch(() => ({}));
      if (onSuccess) {
        onSuccess(result?.data);
      }
      onClose();
    } catch (err) {
      setErrorMessage(err.message || 'Terjadi kesalahan saat membongkar group.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="ungroup-modal-overlay"
      onClick={isSubmitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ungroup-modal-title"
    >
      <div className="ungroup-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ungroup-modal__header">
          <div className="ungroup-modal__title-group">
            <div className="ungroup-modal__icon-badge" aria-hidden="true">
              <PackageOpen size={20} />
            </div>
            <div>
              <h3 id="ungroup-modal-title" className="ungroup-modal__title">
                Konfirmasi Bongkar Group Serial
              </h3>
              <p className="ungroup-modal__subtitle">
                Memisahkan kembali serial group ke komponen asalnya
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ungroup-modal__close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Tutup modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleConfirm} className="ungroup-modal__form">
          <div className="ungroup-modal__body">
            {/* Error Message */}
            {errorMessage && (
              <div className="ungroup-modal__alert ungroup-modal__alert--error" role="alert">
                <AlertCircle size={18} className="ungroup-modal__alert-icon" />
                <div className="ungroup-modal__alert-content">
                  <strong>Gagal Membongkar Group</strong>
                  <p>{errorMessage}</p>
                </div>
              </div>
            )}

            {/* Target Group Info Card */}
            <div className="ungroup-target-card">
              <div className="ungroup-target-card__header">
                <span className="ungroup-target-card__sn-badge">
                  {serialNumber}
                </span>
                {totalPcs && (
                  <span className="ungroup-target-card__qty-badge">
                    {totalPcs} pcs
                  </span>
                )}
              </div>
              <div className="ungroup-target-card__prod-name">
                {productName}
              </div>
              {(memberCount || leafCount) && (
                <div className="ungroup-target-card__meta">
                  {memberCount && <span>{memberCount} anggota langsung</span>}
                  {memberCount && leafCount && <span>•</span>}
                  {leafCount && <span>{leafCount} serial daun (leaf items)</span>}
                </div>
              )}
            </div>

            {/* Warning / Impact Notice */}
            <div className="ungroup-modal__alert ungroup-modal__alert--warning">
              <AlertTriangle size={18} className="ungroup-modal__alert-icon" />
              <div className="ungroup-modal__alert-content">
                <strong>Dampak Pembongkaran:</strong>
                <ul className="ungroup-modal__impact-list">
                  <li>
                    Group serial <code>{serialNumber}</code> akan dinonaktifkan (status: <strong>Dibongkar</strong>) dan tidak dapat dikeluarkan lagi sebagai 1 paket.
                  </li>
                  <li>
                    Seluruh nomor seri anggota langsung akan <strong>dikembalikan ke status tersedia mandiri</strong> di stok gudang.
                  </li>
                  <li>
                    Jika ada sub-group di dalamnya, sub-group tersebut <strong>tetap utuh</strong> dan tidak otomatis dibongkar.
                  </li>
                </ul>
              </div>
            </div>

            {/* Optional Notes */}
            <div className="form-group">
              <label htmlFor="ungroup-notes" className="form-label">
                Catatan Alasan Pembongkaran <span className="text-muted">(Opsional)</span>
              </label>
              <textarea
                id="ungroup-notes"
                className="form-control"
                rows={2}
                placeholder="Contoh: Permintaan pembongkaran koli untuk penjualan eceran..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="ungroup-modal__footer">
            <button
              type="button"
              className="btn btn-secondary interactive"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Batal
            </button>
            <button
              type="submit"
              className="btn btn-danger interactive ungroup-modal__confirm-btn"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Membongkar...</span>
                </>
              ) : (
                <>
                  <PackageOpen size={16} />
                  <span>Ya, Bongkar Group Ini</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

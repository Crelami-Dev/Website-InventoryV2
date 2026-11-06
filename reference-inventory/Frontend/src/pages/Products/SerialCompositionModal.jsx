import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Layers, AlertCircle, Trash2, Calendar, User, Package, Hash, CheckCircle2, ChevronRight, CornerDownRight, PackageOpen } from 'lucide-react';
import { api } from '../../utils/api.js';
import UngroupConfirmModal from './UngroupConfirmModal.jsx';
import './SerialCompositionModal.css';

const getStatusLabel = (status) => {
  switch (status) {
    case 'available': return 'Tersedia';
    case 'out': return 'Keluar';
    case 'reserved': return 'Dipesan';
    case 'dissolved': return 'Dibongkar';
    case 'damaged': return 'Rusak';
    default: return status || '—';
  }
};

export default function SerialCompositionModal({
  isOpen,
  onClose,
  serialNumber,
  onUngroupSuccess,
}) {
  const [ungroupModalOpen, setUngroupModalOpen] = useState(false);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !ungroupModalOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, ungroupModalOpen, onClose]);

  const {
    data: compositionData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['serial-composition', serialNumber],
    queryFn: async () => {
      if (!serialNumber) return null;
      const res = await api.get(`/api/workspace/product-serials/composition/${encodeURIComponent(serialNumber)}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Gagal memuat hierarki komposisi serial.');
      }
      const json = await res.json();
      return json.data;
    },
    enabled: isOpen && Boolean(serialNumber),
  });

  if (!isOpen) return null;

  const leaves = compositionData?.leafComposition || [];
  const history = compositionData?.history || [];
  const isDissolved = compositionData?.isDissolved;
  const isGroupedInParent = Boolean(compositionData?.parentGroupId);

  return (
    <div className="composition-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="composition-modal-title">
      <div className="composition-modal" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="composition-modal__header">
          <div className="composition-modal__title-group">
            <div className="composition-modal__icon-badge">
              <Layers size={20} />
            </div>
            <div>
              <h3 id="composition-modal-title" className="composition-modal__title">
                Hierarki Komposisi Serial Group
              </h3>
              <span className="composition-modal__subtitle">
                {serialNumber}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="composition-modal__close-btn"
            onClick={onClose}
            aria-label="Tutup"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="composition-modal__body">
          {isLoading && (
            <div className="composition-modal__loading">
              <div className="composition-modal__spinner" />
              <p>Memuat struktur pohon komposisi...</p>
            </div>
          )}

          {error && (
            <div className="composition-modal__error-banner">
              <AlertCircle size={18} />
              <span>{error.message}</span>
            </div>
          )}

          {compositionData && (
            <>
              {/* Status Notice if Dissolved or Nested */}
              {isDissolved && (
                <div className="composition-modal__notice composition-modal__notice--dissolved">
                  <AlertCircle size={18} />
                  <div>
                    <strong>Group Telah Dibongkar (Dissolved)</strong>
                    <p>Group ini sudah tidak aktif lagi. Riwayat dan detail komposisi di bawah disimpan permanen untuk audit.</p>
                  </div>
                </div>
              )}

              {isGroupedInParent && (
                <div className="composition-modal__notice composition-modal__notice--nested">
                  <CornerDownRight size={18} />
                  <div>
                    <strong>Group Berada di Dalam Group Induk:</strong> {compositionData.parentGroupSerialNumber}
                    <p>Bongkar group induk paling atas terlebih dahulu jika ingin membongkar group ini.</p>
                  </div>
                </div>
              )}

              {/* Summary Cards Grid */}
              <div className="composition-modal__cards-grid">
                <div className="composition-card">
                  <span className="composition-card__label">Produk Hasil Group</span>
                  <strong className="composition-card__value">
                    {compositionData.resultProductName || compositionData.productName || 'â€”'}
                  </strong>
                  <span className="composition-card__sub">
                    SKU: {compositionData.sku || 'â€”'}
                  </span>
                </div>

                <div className="composition-card">
                  <span className="composition-card__label">Total Kuantitas Fisik</span>
                  <strong className="composition-card__value composition-card__value--highlight">
                    {compositionData.totalPcs} <span className="composition-card__unit">pcs</span>
                  </strong>
                  <span className="composition-card__sub">
                    {compositionData.unitBreakdown || 'â€”'}
                  </span>
                </div>

                <div className="composition-card">
                  <span className="composition-card__label">Jumlah Serial Daun (Leaf Items)</span>
                  <strong className="composition-card__value">
                    {leaves.length} <span className="composition-card__unit">nomor seri</span>
                  </strong>
                  <span className="composition-card__sub">
                    Status Group: <strong>{isDissolved ? 'Dibongkar' : getStatusLabel(compositionData.status)}</strong>
                  </span>
                </div>
              </div>

              {/* Composition Breakdown Table */}
              <div className="composition-section">
                <div className="composition-section__header">
                  <Package size={16} />
                  <h4>Daftar Komposisi Nomor Seri Terkecil (Leaf Items)</h4>
                </div>

                {leaves.length === 0 ? (
                  <div className="composition-section__empty">
                    Tidak ada rincian nomor seri anggota.
                  </div>
                ) : (
                  <div className="composition-table-wrapper">
                    <table className="composition-table">
                      <thead>
                        <tr>
                          <th>No</th>
                          <th>Nomor Seri Asal</th>
                          <th>Produk Sumber</th>
                          <th>SKU</th>
                          <th>Satuan Asal</th>
                          <th className="composition-table__th--right">Ekuivalen (Pcs)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaves.map((leaf, idx) => (
                          <tr key={leaf.serialId || leaf.serialNumber || idx}>
                            <td className="composition-table__td--num">{String(idx + 1).padStart(2, '0')}</td>
                            <td className="composition-table__td--sn">
                              <span className="composition-sn-badge">{leaf.serialNumber}</span>
                            </td>
                            <td className="composition-table__td--prod">{leaf.productName || 'Produk'}</td>
                            <td className="composition-table__td--sku">{leaf.sku || '—'}</td>
                            <td className="composition-table__td--unit">
                              <span className="composition-unit-pill">
                                {leaf.unitQty || 1} {leaf.unit}
                              </span>
                            </td>
                            <td className="composition-table__td--pcs">
                              {leaf.pcs} pcs
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Audit History Timeline */}
              {history.length > 0 && (
                <div className="composition-section">
                  <div className="composition-section__header">
                    <Calendar size={16} />
                    <h4>Riwayat Grouping & Audit</h4>
                  </div>
                  <div className="composition-history-list">
                    {history.map((h, i) => (
                      <div key={i} className="composition-history-item">
                        <div className="composition-history-icon">
                          <CheckCircle2 size={14} />
                        </div>
                        <div className="composition-history-body">
                          <div className="composition-history-header">
                            <span className="composition-history-action">
                              {h.action === 'grouped' ? 'Pembuatan Group' : (h.action === 'ungrouped' ? 'Pembongkaran Group' : h.action)}
                            </span>
                            <span className="composition-history-time">
                              {h.timestamp ? new Date(h.timestamp).toLocaleString('id-ID') : '—'}
                            </span>
                          </div>
                          <div className="composition-history-meta">
                            <span><User size={12} /> {h.userName || 'Petugas'}</span>
                            {h.notes && <span className="composition-history-notes">• {h.notes}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="composition-modal__footer">
          <button
            type="button"
            className="btn btn-secondary interactive"
            onClick={onClose}
          >
            Tutup
          </button>

          {compositionData && compositionData.isGroup && !isDissolved && !isGroupedInParent && compositionData.status !== 'out' && (
            <button
              type="button"
              className="btn btn-danger interactive composition-modal__ungroup-btn"
              onClick={() => setUngroupModalOpen(true)}
            >
              <PackageOpen size={16} />
              <span>Bongkar Group (Ungroup)</span>
            </button>
          )}
        </div>
      </div>

      {/* Ungroup Confirmation Modal */}
      <UngroupConfirmModal
        isOpen={ungroupModalOpen}
        onClose={() => setUngroupModalOpen(false)}
        groupSerial={compositionData ? {
          serialId: compositionData.serialId,
          serialNumber: compositionData.serialNumber,
          productName: compositionData.resultProductName || compositionData.productName,
          totalPcs: compositionData.totalPcs,
          directMemberCount: compositionData.directMembers?.length,
          leafMemberCount: leaves.length,
        } : null}
        onSuccess={() => {
          setUngroupModalOpen(false);
          if (onUngroupSuccess) {
            onUngroupSuccess();
          }
          onClose();
        }}
      />
    </div>
  );
}

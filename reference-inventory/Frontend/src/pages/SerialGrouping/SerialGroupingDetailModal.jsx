import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api.js';
import SerialGroupingUngroupModal from './SerialGroupingUngroupModal';
import { getGroupingComponentRows } from './serialGroupingDisplay.js';
import './SerialGroupingDetailModal.css';

const formatDate = (dateString) => {
  if (!dateString) return '-';
  try {
    const d = new Date(dateString);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return dateString;
  }
};

const renderStatusBadge = (status) => {
  const normStatus = (status || '').toLowerCase();
  if (normStatus === 'completed' || normStatus === 'active') {
    return <span className="sg-status-badge badge-active">Selesai (Aktif)</span>;
  }
  if (normStatus === 'dissolved') {
    return <span className="sg-status-badge badge-dissolved">Dibongkar (Dissolved)</span>;
  }
  if (normStatus === 'cancelled') {
    return <span className="sg-status-badge badge-cancelled">Dibatalkan</span>;
  }
  return <span className="sg-status-badge badge-default">{status || '-'}</span>;
};

export default function SerialGroupingDetailModal({ groupingId, isOpen, onClose, onRefreshList }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [isUngroupOpen, setIsUngroupOpen] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!groupingId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/api/workspace/product-serials/groupings/${groupingId}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Gagal memuat detail grouping serial.');
      }
      const json = await res.json().catch(() => ({}));
      if (json && json.data) {
        setDetailData(json.data);
      } else {
        setError('Format data detail tidak valid.');
      }
    } catch (err) {
      console.error('Error fetching serial grouping detail:', err);
      setError(err.message || 'Terjadi kesalahan saat memuat detail grouping.');
    } finally {
      setLoading(false);
    }
  }, [groupingId]);

  useEffect(() => {
    if (isOpen && groupingId) {
      fetchDetail();
    } else {
      setDetailData(null);
      setError(null);
    }
  }, [isOpen, groupingId, fetchDetail]);

  if (!isOpen) return null;

  const isCanUngroup = detailData && (detailData.status === 'completed' || detailData.status === 'active');

  const assemblyReference = detailData
    ? (detailData.assembly_document_number ||
      detailData.reference_number ||
      detailData.source_document?.document_number ||
      detailData.source_document_number ||
      null)
    : null;
  const assemblyDocumentId = detailData
    ? (detailData.assembly_document_id || detailData.source_document_id || null)
    : null;
  const reversalReference = detailData
    ? (detailData.reversal_document_number ||
      detailData.reverse_document?.document_number ||
      detailData.reverse_document_number ||
      null)
    : null;
  const reversalDocumentId = detailData
    ? (detailData.reversal_document_id || detailData.reverse_document_id || null)
    : null;
  const componentRows = getGroupingComponentRows(detailData?.components);

  return (
    <div className="sg-detail-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="sg-detail-title">
      <div className="sg-detail-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sg-detail-header">
          <div className="sg-detail-header-info">
            <div className="sg-detail-title-row">
              <h2 id="sg-detail-title">Detail Grouping Serial</h2>
              {detailData && renderStatusBadge(detailData.status)}
            </div>
            <p className="sg-detail-subtitle">
              ID: <span className="mono">{groupingId}</span>
              {detailData?.created_at && ` • ${formatDate(detailData.created_at)}`}
            </p>
          </div>
          <button className="sg-detail-close-btn" onClick={onClose} aria-label="Tutup">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="sg-detail-body">
          {loading && (
            <div className="sg-detail-state sg-detail-loading">
              <div className="sg-spinner"></div>
              <p>Memuat data detail grouping serial...</p>
            </div>
          )}

          {error && !loading && (
            <div className="sg-detail-state sg-detail-error">
              <div className="sg-error-icon">⚠️</div>
              <p>{error}</p>
              <button className="sg-btn-retry" onClick={fetchDetail}>Coba Lagi</button>
            </div>
          )}

          {!loading && !error && detailData && (
            <div className="sg-detail-content">
              {/* Summary Cards Grid */}
              <div className="sg-summary-grid">
                {/* Hasil Grouping Card */}
                <div className="sg-card-block">
                  <h4 className="sg-card-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                      <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                    Produk Hasil Grouping
                  </h4>
                  <div className="sg-kv-list">
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Nama Produk</span>
                      <span className="sg-kv-val font-semibold">
                        {detailData.result_product?.name || detailData.result_product_name || '-'}
                      </span>
                    </div>
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">SKU Produk</span>
                      <span className="sg-kv-val mono">
                        {detailData.result_product?.sku || detailData.result_product_sku || '-'}
                      </span>
                    </div>
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Nomor Seri Hasil</span>
                      <span className="sg-kv-val mono badge-sn">
                        {detailData.result_serial_number || detailData.group_serial_number || '-'}
                      </span>
                    </div>
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Jumlah & Satuan</span>
                      <span className="sg-kv-val">{detailData.target_qty || 1} {detailData.target_unit || 'pcs'}</span>
                    </div>
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Gudang / Lokasi</span>
                      <span className="sg-kv-val">{detailData.warehouse_name || detailData.warehouse_id || 'Gudang Utama'}</span>
                    </div>
                  </div>
                </div>

                {/* Dokumen & Catatan Card */}
                <div className="sg-card-block">
                  <h4 className="sg-card-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                    </svg>
                    Dokumen & Catatan Ledger
                  </h4>
                  <div className="sg-kv-list">
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Dokumen Assembly</span>
                      <span className="sg-kv-val">
                        {assemblyReference ? (
                          <span className="mono doc-tag">{assemblyReference}</span>
                        ) : assemblyDocumentId ? (
                          <span className="mono doc-tag">ID: {assemblyDocumentId}</span>
                        ) : (
                          <span className="text-muted">Tidak tercatat</span>
                        )}
                      </span>
                    </div>
                    <div className="sg-kv-item">
                      <span className="sg-kv-label">Dokumen Disassembly (Reversal)</span>
                      <span className="sg-kv-val">
                        {reversalReference ? (
                          <span className="mono doc-tag tag-reversal">{reversalReference}</span>
                        ) : reversalDocumentId ? (
                          <span className="mono doc-tag tag-reversal">ID: {reversalDocumentId}</span>
                        ) : (
                          <span className="text-muted">-</span>
                        )}
                      </span>
                    </div>
                    {detailData.notes && (
                      <div className="sg-kv-item full-width">
                        <span className="sg-kv-label">Catatan Transaksi</span>
                        <p className="sg-kv-notes">{detailData.notes}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Komponen Penyusun Table */}
              <div className="sg-components-section">
                <div className="sg-components-header">
                  <h3>
                    Komponen Nomor Seri Penyusun ({detailData.components?.length || 0})
                  </h3>
                  <span className="sg-components-hint">Snapshot historis saat transaksi grouping dilakukan</span>
                </div>

                <div className="sg-table-container">
                  <table className="sg-table">
                    <thead>
                      <tr>
                        <th>Nomor Seri Sumber</th>
                        <th>Nama Produk</th>
                        <th>SKU</th>
                        <th className="text-center">Satuan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {componentRows.length > 0 ? (
                        componentRows.map((comp, idx) => (
                          <tr key={comp.id || idx}>
                            <td>
                              <span className="mono font-semibold">{comp.serialNumber || '—'}</span>
                              {comp.isSubGroup && (
                                <span className="badge-subgroup">Sub-group</span>
                              )}
                            </td>
                            <td>
                              <div className="prod-name-cell">
                                <span>{comp.productName || '—'}</span>
                              </div>
                            </td>
                            <td>
                              <span className="mono text-muted">{comp.sku || '—'}</span>
                            </td>
                            <td className="text-center">
                              <span className="unit-tag">{comp.unit || '—'}</span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="4" className="text-center sg-empty-cell">
                            Tidak ada rincian komponen yang tersimpan.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="sg-detail-footer">
          <div className="sg-footer-left">
            {isCanUngroup && (
              <button
                type="button"
                className="sg-btn-danger"
                onClick={() => setIsUngroupOpen(true)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 14l-2 2a3 3 0 0 1-4.24-4.24l2-2"></path>
                  <path d="M14 10l2-2a3 3 0 0 1 4.24 4.24l-2 2"></path>
                  <line x1="14" y1="14" x2="10" y2="10"></line>
                </svg>
                Bongkar Group (Reversal)
              </button>
            )}
          </div>
          <button type="button" className="sg-btn-secondary" onClick={onClose}>
            Tutup
          </button>
        </div>

        {/* Ungroup Modal Confirmation */}
        {detailData && (
          <SerialGroupingUngroupModal
            isOpen={isUngroupOpen}
            onClose={() => setIsUngroupOpen(false)}
            groupingData={{
              id: detailData.id,
              result_serial_id: detailData.result_serial_id,
              group_serial_number: detailData.result_serial_number || detailData.group_serial_number || detailData.grouping_number,
              result_product_name: detailData.result_product?.name || detailData.result_product_name,
              target_qty: detailData.target_qty,
              target_unit: detailData.target_unit,
              components: detailData.components
            }}
            onSuccess={() => {
              fetchDetail();
              if (onRefreshList) onRefreshList();
            }}
          />
        )}
      </div>
    </div>
  );
}

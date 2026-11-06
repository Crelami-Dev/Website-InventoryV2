import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Check, AlertTriangle, AlertCircle, Barcode, Edit3, Trash2, Printer, ArrowUpFromLine } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api, getWorkspaceSettings } from '../../utils/api.js';
import { generateDocumentHtml, GOODS_PRINT_MODES } from '../../utils/documentTemplate.js';
import './GoodsOutCreateModal.css';
import './GoodsOutDetailModal.css';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('id-ID', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default function GoodsOutReviewModal({ doc, onClose, onComplete, onCancel, onEdit }) {
  const { t } = useApp();
  const { units: customUnits, multipliers } = useUnits();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [showPrintBtn, setShowPrintBtn] = useState(false);
  const [showPrintPicker, setShowPrintPicker] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const { data: allSerials = [] } = useQuery({
    queryKey: ['product-serials'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/product-serials');
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
    staleTime: 60000,
  });

  const printWithMode = async (paperMode) => {
    let contactData = null;
    if (doc?.contact_id) {
      try {
        const res = await api.get(`/api/workspace/contacts/${doc.contact_id}`);
        if (res.ok) {
          const json = await res.json();
          contactData = json.data;
        }
      } catch (_) {}
    }
    const htmlContent = generateDocumentHtml(doc, settings, contactData, null, paperMode);
    const printWin = window.open('', '_blank', 'width=900,height=750');
    if (printWin) {
      printWin.document.open();
      printWin.document.write(htmlContent);
      printWin.document.close();
    }
  };

  // Secret: Ctrl+D toggles a print button for previewing pending documents
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        setShowPrintBtn((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!doc) return null;

  const items = (doc?.items && doc.items.length > 0) ? doc.items : (doc?.metadata?.items ?? []);

  // Derive rows for the table/cards
  const displayRows = useMemo(() => {
    return items.map((item, idx) => {
      const isUnrecorded = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
      const isSerial = !isUnrecorded && item.metadata?.isSerial === true;
      const isGroup = item.metadata?.isGroup === true || item.metadata?.targetQty != null;
      const serialNumber = isUnrecorded ? '' : (item.metadata?.serialNumber || '');
      const snLower = String(serialNumber).toLowerCase().trim();
      let qtyUnit = item.metadata?.targetUnit || item.metadata?.qtyUnit || 'pcs';

      if (isSerial && !isGroup && snLower) {
        // 1. Check if the serial exists in product_serials and has an authentic serialUnit recorded from Goods In
        const matchedSerial = allSerials.find(
          (s) => String(s.serialNumber ?? s.serial_number ?? '').toLowerCase().trim() === snLower
        );
        const metaUnit =
          matchedSerial?.metadata?.targetUnit ||
          matchedSerial?.targetUnit ||
          matchedSerial?.metadata?.serialUnit ||
          matchedSerial?.metadata?.unit ||
          matchedSerial?.metadata?.qtyUnit ||
          matchedSerial?.unit ||
          matchedSerial?.serialUnit ||
          null;

        if (metaUnit && metaUnit !== 'piece' && metaUnit !== 'pcs') {
          qtyUnit = metaUnit;
        } else if (metaUnit === 'pcs' || metaUnit === 'piece') {
          qtyUnit = 'pcs';
        } else if (item.metadata?.qtyUnit && item.metadata.qtyUnit !== 'pcs' && item.metadata.qtyUnit !== 'piece') {
          qtyUnit = item.metadata.qtyUnit;
        } else {
          // Fallback: only if no explicit unit is recorded anywhere, guess from serial pattern
          if (Array.isArray(customUnits) && customUnits.length > 0) {
            const sorted = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
            for (const u of sorted) {
              const k = String(u.key).toLowerCase().trim();
              if (!k || k === 'pcs') continue;
              if (snLower.includes(k)) {
                qtyUnit = k;
                break;
              }
            }
          }
          if (qtyUnit === 'pcs' || !qtyUnit) {
            if (snLower.includes('bal10') || snLower.includes('10bl') || snLower.includes('bl10')) qtyUnit = 'bal10';
            else if (snLower.includes('bal15') || snLower.includes('15bl') || snLower.includes('bl15')) qtyUnit = 'bal15';
            else if (snLower.includes('bal20') || snLower.includes('20bl') || snLower.includes('bl20')) qtyUnit = 'bal20';
            else if (snLower.includes('bal25') || snLower.includes('25bl') || snLower.includes('bl25')) qtyUnit = 'bal25';
            else if (snLower.includes('bal5') || snLower.includes('5bl') || snLower.includes('bl5')) qtyUnit = 'bal5';
            else if (snLower.includes('pack3') || snLower.includes('pk3')) qtyUnit = 'pack3';
            else if (snLower.includes('pack6') || snLower.includes('pk6')) qtyUnit = 'pack6';
            else if (snLower.includes('bal') || snLower.includes('bl')) qtyUnit = 'bal';
            else if (snLower.includes('pack') || snLower.includes('pk')) qtyUnit = 'pack';
            else if (snLower.includes('lusin') || snLower.includes('doz')) qtyUnit = 'lusin';
          }
        }
      }

      const qty = Number(item.metadata?.qtyInput ?? (item.metadata?.targetQty ? item.metadata.targetQty : (isSerial ? 1 : item.quantity ?? 1))) || 1;

      return {
        rowId: `item-${idx}-${item.id}`,
        type: isUnrecorded ? 'unrecorded' : isSerial ? 'serial' : 'parent',
        isSerial,
        isGroup,
        isUnrecorded,
        unrecordedNote: item.metadata?.unrecordedNote || '',
        productName: item.item_name || item.itemName,
        sku: item.sku,
        tracking: isUnrecorded ? 'Belum Terdata' : isSerial ? 'Serial' : 'Normal',
        serialNumber: isUnrecorded ? 'Tanpa SN (Sementara)' : isSerial ? serialNumber : '—',
        qty,
        qtyUnit,
      };
    });
  }, [items, allSerials, customUnits]);

  // Group items by product for the confirmation modal table
  const groupedProducts = useMemo(() => {
    const groups = new Map();

    displayRows.forEach((row) => {
      const key = (row.sku || row.productName || 'unknown').trim().toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, {
          productName: row.productName || 'Produk Tanpa Nama',
          sku: row.sku || '-',
          serials: [],
          nonSerialQty: 0,
          unrecordedQty: 0,
          unitCounts: {},
          totalPcs: 0,
        });
      }

      const g = groups.get(key);
      const mult = multipliers?.[row.qtyUnit] || 1;
      const count = Number(row.qty) || 1;
      const pcs = count * mult;
      g.totalPcs += pcs;

      const unitObj = customUnits?.find((u) => u.key === row.qtyUnit);
      const unitLabel = unitObj?.name || row.qtyUnit;
      g.unitCounts[unitLabel] = (g.unitCounts[unitLabel] || 0) + count;

      if (row.isUnrecorded) {
        g.unrecordedQty = (g.unrecordedQty || 0) + count;
      } else if (row.tracking === 'Serial' && row.serialNumber && row.serialNumber !== '—') {
        g.serials.push({
          sn: row.serialNumber,
          unit: unitLabel,
          pcs,
        });
      } else {
        g.nonSerialQty += count;
      }
    });

    return Array.from(groups.values());
  }, [displayRows, multipliers, customUnits]);

  const totalGroupedStats = useMemo(() => {
    let totalItems = 0;
    let totalPcs = 0;
    let totalSerials = 0;

    groupedProducts.forEach((g) => {
      totalItems += 1;
      totalPcs += g.totalPcs;
      totalSerials += g.serials.length;
    });

    return { totalItems, totalPcs, totalSerials };
  }, [groupedProducts]);

  const isDraft = doc.status === 'draft';

  const handleDeleteDraft = async () => {
    if (!window.confirm(`Hapus draft ${doc.document_number}? Draft yang dihapus akan dibersihkan dari sistem.`)) return;
    setSubmitting(true);
    setError(null);
    const previousGoodsOut = queryClient.getQueryData(['goods-out']);
    queryClient.setQueryData(['goods-out'], (prev) =>
      Array.isArray(prev) ? prev.filter((d) => d.id !== doc.id) : prev
    );
    try {
      const res = await api.delete(`/api/workspace/documents/${doc.id}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || errJson?.message || 'Gagal menghapus draft');
      }
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });
      onClose();
    } catch (err) {
      queryClient.setQueryData(['goods-out'], previousGoodsOut);
      setError(err.message || 'Gagal menghapus draft');
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // 1. PATCH the document status to completed
      const patchRes = await api.post(`/api/workspace/documents/${doc.id}/complete`);

      if (!patchRes.ok) {
        const errJson = await patchRes.json().catch(() => ({}));
        throw new Error(errJson?.message || t('goodsOut.review.completeFailed'));
      }

      const resJson = await patchRes.json();
      const completedDoc = resJson.data;

      // Inventory and serial changes are owned by the backend completion transition.
      queryClient.setQueryData(['goods-out'], (current) =>
        Array.isArray(current)
          ? current.map((item) => item.id === completedDoc.id ? completedDoc : item)
          : [completedDoc]
      );
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });

      setShowConfirmModal(false);
      onComplete?.(completedDoc);
    } catch (err) {
      setError(err.message || t('goodsOut.review.completeFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="go-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="go-review-title"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="go-detail-modal go-modal">
        {/* Header */}
        <div className="go-modal__header">
          <div>
            <h2 id="go-review-title" className="go-modal__title">
              {t('goodsOut.review.title')}
            </h2>
            <p className="go-modal__subtitle">
              {t('goodsOut.review.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="go-modal__close-btn"
            onClick={onClose}
            disabled={submitting}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="go-modal__body">
          {/* Details */}
          <div className="go-modal__info-card">
            <h4 className="go-modal__info-title">{t('goodsOut.detail.transactionDetails')}</h4>
            <div className="go-modal__info-grid">
              <div className="go-modal__field">
                <span className="go-modal__field-label">{t('goodsOut.detail.reference')}</span>
                <input type="text" className="input" value={doc.document_number} disabled readOnly />
              </div>
              <div className="go-modal__field">
                <span className="go-modal__field-label">{t('goodsOut.detail.source')}</span>
                <input type="text" className="input" value={doc.contact_name || t('goodsOut.detail.noSource')} disabled readOnly />
              </div>
              <div className="go-modal__field">
                <span className="go-modal__field-label">{t('goodsOut.detail.date')}</span>
                <input type="text" className="input" value={formatDate(doc.issue_date)} disabled readOnly />
              </div>
            </div>
            <div className="go-modal__field gi-modal__field--full" style={{ marginTop: 'var(--space-4)' }}>
              <span className="go-modal__field-label">{t('goodsOut.detail.notes')}</span>
              <textarea className="input gi-modal__notes" value={doc.notes || t('goodsOut.detail.noNotes')} disabled readOnly />
            </div>
          </div>

          {/* Items Section */}
          <div className="go-modal__worksheet">
            <div className="go-detail__items-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Barcode size={16} className="go-detail__icon-muted" style={{ color: 'var(--color-text-muted)' }} />
                <h4 className="go-modal__items-title">{t('goodsOut.review.items')}</h4>
                <span className="chip go-detail__items-count" style={{ background: 'var(--color-surface-alt)', color: 'var(--color-text-secondary)' }}>
                  {t('goodsOut.detail.itemsCount', { count: items.length })}
                </span>
              </div>
            </div>

            {/* Desktop items table */}
            <div className="go-modal__table-desktop">
              <div className="go-modal__table-wrapper">
                <table className="go-modal__table">
                  <colgroup>
                    <col style={{ width: '8%' }} />
                    <col style={{ width: '37%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '10%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'center' }}>{t('goodsOut.detail.colNo')}</th>
                      <th>{t('goodsOut.detail.colProduct')}</th>
                      <th>{t('goodsOut.detail.colSku')}</th>
                      <th>{t('goodsOut.detail.colTracking')}</th>
                      <th>{t('goodsOut.detail.colSerial')}</th>
                      <th style={{ textAlign: 'right' }}>{t('goodsOut.detail.colQty')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row, idx) => (
                      <tr key={row.rowId} className={row.type === 'serial' ? 'go-detail__tr-serial' : ''}>
                        <td className="go-detail__td-number">
                          {String(idx + 1).padStart(2, '0')}
                        </td>
                        <td className={row.type === 'parent' ? 'go-detail__td-name--parent' : 'go-detail__td-name--serial'}>
                          {row.productName}
                        </td>
                        <td className="go-detail__td-sku">{row.sku || '—'}</td>
                        <td>
                          {row.type === 'unrecorded' ? (
                            <span
                              className="chip chip-warning chip-sm"
                              style={{ fontWeight: 600, fontSize: '11px', whiteSpace: 'nowrap' }}
                              title="Barang Belum Terdata (Non-SN) — Tidak memotong stok sistem"
                            >
                              Belum Terdata
                            </span>
                          ) : row.type === 'serial' ? (
                            <span className="chip chip-success chip-sm">{t('goodsOut.detail.trackingSerial')}</span>
                          ) : (
                            <span className="chip chip-sm">{t('goodsOut.detail.trackingNormal')}</span>
                          )}
                        </td>
                        <td>
                          {row.type === 'serial' ? (
                            <span className="go-line-item__sku-disabled go-detail__serial-cell">
                              {row.serialNumber}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                          )}
                        </td>
                        <td className="go-detail__td-qty">
                          {row.qty} {row.qtyUnit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile items cards */}
            <div className="go-modal__cards-mobile">
              {displayRows.map((row, idx) => (
                <div key={row.rowId} className={`go-line-item-card ${row.type === 'unrecorded' ? 'go-detail__card--unrecorded' : row.type === 'serial' ? 'go-detail__card--serial' : 'go-detail__card--normal'}`}>
                  <div className="go-line-item-card__field">
                    <label className="go-line-item-card__label">{t('goodsOut.detail.colNo')} / {t('goodsOut.detail.colProduct')}</label>
                    <div className="go-detail__card-product">
                      #{idx + 1} - {row.productName}
                    </div>
                  </div>
                  <div className="go-line-item-card__grid">
                    <div>
                      <label className="go-line-item-card__label">{t('goodsOut.detail.colSku')}</label>
                      <div>{row.sku || '—'}</div>
                    </div>
                    <div>
                      <label className="go-line-item-card__label">{t('goodsOut.detail.colTracking')}</label>
                      <div>
                        {row.type === 'unrecorded' ? (
                          <span className="chip chip-warning chip-sm" style={{ fontWeight: 600 }}>Belum Terdata</span>
                        ) : (
                          row.tracking
                        )}
                      </div>
                    </div>
                  </div>
                  {row.type === 'serial' && (
                    <div className="go-line-item-card__field">
                      <label className="go-line-item-card__label">{t('goodsOut.detail.colSerial')}</label>
                      <div className="go-line-item__sku-disabled go-detail__card-serial-badge">
                        {row.serialNumber}
                      </div>
                    </div>
                  )}
                  <div className="go-line-item-card__field">
                    <label className="go-line-item-card__label">{t('goodsOut.detail.colQty')}</label>
                    <div><strong>{row.qty}</strong> {row.qtyUnit}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="go-modal__error" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-danger)', background: 'var(--color-danger-surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', marginTop: 'var(--space-4)' }}>
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="go-modal__footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          {isDraft ? (
            <button
              type="button"
              className="btn btn-danger btn-md interactive"
              onClick={handleDeleteDraft}
              style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              disabled={submitting}
            >
              <Trash2 size={15} />
              <span>Hapus Draft</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger btn-md interactive"
              onClick={() => onCancel(doc)}
              style={{ marginRight: 'auto' }}
              disabled={submitting}
            >
              <AlertTriangle size={15} style={{ marginRight: '4px' }} />
              {t('goodsOut.action.cancel')}
            </button>
          )}

          <button
            type="button"
            className="btn btn-secondary btn-md interactive"
            onClick={onClose}
            disabled={submitting}
          >
            {t('goodsOut.detail.close')}
          </button>

          {showPrintBtn && (
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={() => setShowPrintPicker(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
              title="Cetak dokumen (Ctrl+D untuk toggle)"
            >
              <Printer size={15} />
              <span>Cetak Dokumen</span>
            </button>
          )}

          {onEdit && (
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={() => onEdit(doc)}
              disabled={submitting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Edit3 size={15} />
              <span>Edit Dokumen</span>
            </button>
          )}

          <button
            type="button"
            className="btn btn-primary btn-md interactive"
            onClick={() => {
              setError(null);
              setShowConfirmModal(true);
            }}
            disabled={submitting}
          >
            {submitting ? t('goodsOut.modal.submitting') : (
              <>
                <Check size={16} />
                <span>{t('goodsOut.action.complete') || 'Selesai'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Confirmation Popup Modal with Grouped Product Table */}
      {showConfirmModal && (
        <div
          className="go-detail-overlay go-confirm-overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 1200 }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) {
              setShowConfirmModal(false);
            }
          }}
        >
          <div
            className="go-modal go-confirm-modal"
            style={{
              maxWidth: '880px',
              width: '95vw',
              maxHeight: '90dvh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
              borderRadius: '16px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              className="go-modal__header"
              style={{
                padding: '18px 24px',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div
                  style={{
                    width: '42px',
                    height: '42px',
                    borderRadius: '12px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    color: 'var(--color-danger, #ef4444)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <ArrowUpFromLine size={22} />
                </div>
                <div>
                  <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--color-text)' }}>
                    Konfirmasi Pengeluaran Barang
                  </h2>
                  <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                    Apakah Anda yakin ingin mengeluarkan barang ini? Pastikan seluruh barang dan serial number sudah sesuai.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="go-modal__close-btn"
                onClick={() => setShowConfirmModal(false)}
                disabled={submitting}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div
              className="go-modal__body"
              style={{
                padding: '20px 24px',
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              }}
            >
              {/* Document Info Banner */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px',
                  padding: '12px 16px',
                  background: 'var(--color-surface-alt)',
                  borderRadius: '10px',
                  border: '1px solid var(--color-border)',
                  fontSize: '13px',
                }}
              >
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>No. Dokumen: </span>
                  <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-interactive)' }}>
                    {doc.document_number}
                  </strong>
                </div>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>Tujuan / Penerima: </span>
                  <strong>{doc.contact_name || '—'}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>Tanggal: </span>
                  <strong>{formatDate(doc.issue_date)}</strong>
                </div>
              </div>

              {/* Grouped Table */}
              <div
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: '12px',
                  overflow: 'hidden',
                  background: 'var(--color-surface)',
                }}
              >
                <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: '13px',
                      textAlign: 'left',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: 'var(--color-surface-alt)',
                          borderBottom: '1px solid var(--color-border)',
                          position: 'sticky',
                          top: 0,
                          zIndex: 2,
                        }}
                      >
                        <th style={{ padding: '10px 14px', width: '45px', textAlign: 'center', color: 'var(--color-text-muted)' }}>No</th>
                        <th style={{ padding: '10px 14px', color: 'var(--color-text-muted)' }}>Produk & Nomor Seri</th>
                        <th style={{ padding: '10px 14px', width: '150px', textAlign: 'right', color: 'var(--color-text-muted)' }}>Jumlah Satuan</th>
                        <th style={{ padding: '10px 14px', width: '130px', textAlign: 'right', color: 'var(--color-text-muted)' }}>Total (Pcs)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedProducts.map((g, idx) => {
                        const unitSummaryText = Object.entries(g.unitCounts)
                          .map(([u, count]) => `${count} ${u}`)
                          .join(', ');

                        return (
                          <tr
                            key={idx}
                            style={{
                              borderBottom: idx < groupedProducts.length - 1 ? '1px solid var(--color-border)' : 'none',
                              verticalAlign: 'top',
                            }}
                          >
                            <td style={{ padding: '12px 14px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                              {idx + 1}
                            </td>
                            <td style={{ padding: '12px 14px' }}>
                              <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--color-text)' }}>
                                {g.productName}
                              </div>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '11px',
                                    color: 'var(--color-text-muted)',
                                    background: 'var(--color-surface-alt)',
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--color-border)',
                                  }}
                                >
                                  SKU: {g.sku}
                                </span>
                              </div>

                              {/* Serial numbers listed below product name */}
                              {g.serials.length > 0 ? (
                                <div style={{ marginTop: '8px' }}>
                                  <div
                                    style={{
                                      fontSize: '11px',
                                      fontWeight: 600,
                                      color: 'var(--color-text-muted)',
                                      marginBottom: '4px',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <Barcode size={12} />
                                    <span>Nomor Seri ({g.serials.length}):</span>
                                  </div>
                                  <div
                                    style={{
                                      display: 'flex',
                                      flexWrap: 'wrap',
                                      gap: '4px',
                                      maxHeight: '90px',
                                      overflowY: 'auto',
                                      padding: '6px',
                                      background: 'var(--color-surface-alt)',
                                      borderRadius: '6px',
                                      border: '1px dashed var(--color-border)',
                                    }}
                                  >
                                    {g.serials.map((s, sIdx) => (
                                      <span
                                        key={sIdx}
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          fontSize: '11px',
                                          background: 'var(--color-surface)',
                                          color: 'var(--color-text)',
                                          border: '1px solid var(--color-border)',
                                          borderRadius: '4px',
                                          padding: '1px 6px',
                                        }}
                                      >
                                        {s.sn}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ) : g.unrecordedQty > 0 ? (
                                <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--color-warning)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <AlertTriangle size={12} />
                                  <span>Belum Terdata (Non-SN) — Tidak memotong stok sistem</span>
                                </div>
                              ) : (
                                <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                  (Barang Non-Serial)
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600 }}>
                              <span style={{ color: 'var(--color-text)' }}>
                                {unitSummaryText || '1 Pcs'}
                              </span>
                            </td>
                            <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                              <span
                                style={{
                                  fontWeight: 700,
                                  fontSize: '14px',
                                  color: 'var(--color-interactive)',
                                }}
                              >
                                {g.totalPcs.toLocaleString('id-ID')} Pcs
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr
                        style={{
                          background: 'var(--color-surface-alt)',
                          borderTop: '2px solid var(--color-border)',
                          fontWeight: 700,
                        }}
                      >
                        <td colSpan={2} style={{ padding: '12px 14px' }}>
                          <span style={{ color: 'var(--color-text)' }}>
                            Total Keseluruhan ({totalGroupedStats.totalItems} Produk
                            {totalGroupedStats.totalSerials > 0 ? `, ${totalGroupedStats.totalSerials} Nomor Seri` : ''})
                          </span>
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', color: 'var(--color-text-muted)' }}>
                          Total Fisik:
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', fontSize: '15px', color: 'var(--color-interactive)' }}>
                          {totalGroupedStats.totalPcs.toLocaleString('id-ID')} Pcs
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Warning Notice */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '12px 16px',
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  borderRadius: '10px',
                  fontSize: '12.5px',
                  color: 'var(--color-text)',
                  lineHeight: 1.5,
                }}
              >
                <AlertTriangle size={18} style={{ color: '#d97706', flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong>Peringatan Pengeluaran Barang:</strong>
                  <div style={{ color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    Tindakan ini akan langsung <strong>memotong stok inventaris</strong> di sistem dan menandai seluruh nomor seri di atas sebagai <strong>Keluar (Out)</strong>. Transaksi yang telah diselesaikan tidak dapat diedit kembali.
                  </div>
                </div>
              </div>

              {error && (
                <div className="go-modal__error" style={{ margin: 0 }}>
                  <AlertCircle size={14} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div
              className="go-modal__footer"
              style={{
                padding: '14px 24px',
                borderTop: '1px solid var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: '10px',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-md"
                onClick={() => setShowConfirmModal(false)}
                disabled={submitting}
              >
                Batal
              </button>
              <button
                type="button"
                className="btn btn-primary btn-md interactive"
                onClick={handleComplete}
                disabled={submitting}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'var(--color-danger, #ef4444)',
                  borderColor: 'var(--color-danger, #ef4444)',
                }}
              >
                {submitting ? (
                  <>
                    <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />
                    <span>Mengeluarkan Barang...</span>
                  </>
                ) : (
                  <>
                    <Check size={16} />
                    <span>Ya, Keluarkan Barang Sekarang</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {showPrintPicker && (
        <div
          className="go-detail-overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 1100 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowPrintPicker(false); }}
        >
          <div className="go-modal" style={{ maxWidth: '420px', padding: '20px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700 }}>Pilih Jenis Cetakan</h3>
            <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
              Pilih format cetak untuk dokumen ini.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {GOODS_PRINT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className="btn btn-secondary"
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

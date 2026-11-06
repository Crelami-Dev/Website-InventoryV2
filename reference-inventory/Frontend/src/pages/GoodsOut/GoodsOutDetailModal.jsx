import React, { useMemo, useState } from 'react';
import { X, Barcode, RotateCcw, AlertCircle, Edit3, Printer, Check } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../context/AppContext.jsx';
import { api, getWorkspaceSettings } from '../../utils/api.js';
import { generateDocumentHtml, GOODS_PRINT_MODES } from '../../utils/documentTemplate.js';
import { generateReturnReceiptHtml } from '../../utils/returnReceiptTemplate.js';
import { useUnits } from '../../hooks/useUnits.js';
import SecretEmailButton from '../../components/SecretEmailButton/SecretEmailButton.jsx';
import './GoodsOutDetailModal.css';

const STATUS_CONFIG = {
  draft:      { label: 'goodsOut.status.draft',      chip: '' },
  processing: { label: 'goodsOut.status.processing', chip: 'chip-info' },
  ready:      { label: 'goodsOut.status.ready',      chip: 'chip-warning' },
  completed:  { label: 'goodsOut.status.completed',  chip: 'chip-success' },
  cancelled:  { label: 'goodsOut.status.cancelled',  chip: 'chip-danger' },
};

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

export default function GoodsOutDetailModal({ doc, onClose, onEdit }) {
  const { t, user } = useApp();
  const { customUnits, formatUnitOption, getUnitLabel } = useUnits();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [showPrintPicker, setShowPrintPicker] = useState(false);
  const [restoringReturnId, setRestoringReturnId] = useState(null);
  const [showReturnsHistory, setShowReturnsHistory] = useState(true);
  const [selectedReturnForPrint, setSelectedReturnForPrint] = useState(null);

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

  const isMobileDevice = () => window.innerWidth <= 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const printWithMode = async (paperMode) => {
    let contactData = null;
    if (doc.contact_id) {
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

  const printReturnWithMode = async (paperMode) => {
    if (!selectedReturnForPrint) return;
    try {
      let contactData = null;
      if (doc.contact_id) {
        try {
          const res = await api.get(`/api/workspace/contacts/${doc.contact_id}`);
          if (res.ok) {
            const json = await res.json();
            contactData = json.data;
          }
        } catch (_) {}
      }

      const fullRecord = {
        ...selectedReturnForPrint,
        documentType: 'goods_out',
        documentNumber: doc.document_number,
        documentId: doc.id,
        contactName: doc.contact_name || doc.metadata?.contactName || doc.metadata?.recipientName,
        warehouseName: doc.warehouse_name || doc.metadata?.warehouse || 'Gudang Utama',
      };

      const htmlContent = generateReturnReceiptHtml(fullRecord, settings, contactData, paperMode);
      const printWin = window.open('', '_blank', 'width=900,height=750');
      if (printWin) {
        printWin.document.open();
        printWin.document.write(htmlContent);
        printWin.document.close();
      }
    } catch (e) {
      console.error('Failed to print return receipt:', e);
      alert('Gagal mencetak bukti retur: ' + e.message);
    } finally {
      setSelectedReturnForPrint(null);
    }
  };

  const handlePrint = async () => {
    if (isMobileDevice()) {
      if (doc?.id) {
        try {
          const res = await api.get(`/api/workspace/documents/${doc.id}/pdf?paperMode=compact`, { responseType: 'blob' });
          if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Surat-Jalan-${doc.document_number || 'dokumen'}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            return;
          }
        } catch (e) {
          console.warn('Mobile PDF download failed, falling back to window print:', e);
        }
      }
      // Fallback bila fetch PDF gagal: tetap gunakan versi rangkap di mobile
      await printWithMode('compact');
      return;
    }

    setShowPrintPicker(true);
  };

  const handleDelete = async () => {
    if (!window.confirm(t('goodsOut.delete.confirm'))) return;
    setDeleting(true);
    setDeleteError(null);
    const previousGoodsOut = queryClient.getQueryData(['goods-out']);
    queryClient.setQueryData(['goods-out'], (current) =>
      Array.isArray(current) ? current.filter((item) => item.id !== doc.id) : current
    );
    try {
      const res = await api.delete(`/api/workspace/documents/${doc.id}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error?.message || payload?.message || t('goodsOut.delete.failed'));
      }

      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });

      onClose();
    } catch (err) {
      queryClient.setQueryData(['goods-out'], previousGoodsOut);
      console.error(err);
      setDeleteError(err.message || t('goodsOut.delete.failed'));
      setDeleting(false);
    }
  };

  const handleRestoreReturn = async (retRecord) => {
    if (!retRecord || !retRecord.id || restoringReturnId) return;
    const confirmMsg = `Batalkan retur "${retRecord.returnNumber || 'ini'}"?\n\nKuantitas barang akan dipotong kembali dari stok gudang dan nomor seri akan dikembalikan statusnya menjadi keluar (terikat kembali pada surat jalan ini).`;
    if (!window.confirm(confirmMsg)) return;

    setRestoringReturnId(retRecord.id);
    try {
      const res = await api.post(`/api/workspace/documents/${doc.id}/returns/${retRecord.id}/restore`);
      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload?.error?.message || errPayload?.message || 'Gagal membatalkan retur');
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['goods-out'] }),
        queryClient.invalidateQueries({ queryKey: ['returns-list'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-serials'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-documents'] }),
      ]);
      onClose();
    } catch (err) {
      console.error('Failed to restore return:', err);
      alert(err.message || 'Gagal membatalkan retur');
    } finally {
      setRestoringReturnId(null);
    }
  };

  if (!doc) return null;

  const statusCfg = STATUS_CONFIG[doc.status] ?? STATUS_CONFIG.draft;
  const items = (doc?.items && doc.items.length > 0) ? doc.items : (doc?.metadata?.items ?? []);
  const returns = doc?.metadata?.returns ?? [];

  // Check if there are still returnable items
  const hasReturnableItems = useMemo(() => {
    if (doc.status !== 'completed') return false;
    return items.some((item) => {
      const itemId = item.id;
      const productId = item.product_id ?? item.productId;
      const isSerial = item.metadata?.isSerial === true;
      const isGroup = item.metadata?.isGroup === true || item.metadata?.targetQty != null;
      const serialNumber = item.metadata?.serialNumber || '';
      const qtyInput = Number(item.metadata?.qtyInput ?? (item.metadata?.targetQty ? item.metadata.targetQty : (isSerial ? 1 : item.quantity ?? 1))) || 1;

      const previouslyReturned = returns.reduce((sum, r) => {
        return sum + (r.items ?? [])
          .filter((ri) => {
            if (isSerial) {
              if (ri.isSerial) return String(ri.serialNumber || '').trim().toLowerCase() === serialNumber.trim().toLowerCase();
              return false;
            }
            if (ri.isSerial) return false;
            if (itemId && ri.itemId) return ri.itemId === itemId;
            if (productId && ri.productId) return ri.productId === productId;
            return false;
          })
          .reduce((s, ri) => s + (ri.returnedQty || 0), 0);
      }, 0);

      const remaining = isGroup && previouslyReturned > 0
        ? 0
        : Math.max(0, qtyInput - previouslyReturned);
      return remaining > 0;
    });
  }, [doc.status, items, returns]);

  // Determine return status
  const returnStatus = useMemo(() => {
    if (returns.length === 0) return null;
    return hasReturnableItems ? 'partial' : 'full';
  }, [returns, hasReturnableItems]);

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
            if (snLower.includes('bal10') || snLower.includes('10bl')) qtyUnit = 'bal10';
            else if (snLower.includes('bal15') || snLower.includes('15bl')) qtyUnit = 'bal15';
            else if (snLower.includes('bal20') || snLower.includes('20bl')) qtyUnit = 'bal20';
            else if (snLower.includes('bal25') || snLower.includes('25bl')) qtyUnit = 'bal25';
            else if (snLower.includes('bal5') || snLower.includes('5bl')) qtyUnit = 'bal5';
            else if (snLower.includes('pack3') || snLower.includes('pk3')) qtyUnit = 'pack3';
            else if (snLower.includes('pack6') || snLower.includes('pk6')) qtyUnit = 'pack6';
            else if (snLower.includes('bal') || snLower.includes('bl')) qtyUnit = 'bal';
            else if (snLower.includes('pack') || snLower.includes('pk')) qtyUnit = 'pack';
            else if (snLower.includes('lusin') || snLower.includes('doz')) qtyUnit = 'lusin';
          }
        }
      }

      const qty = Number(item.metadata?.qtyInput ?? (item.metadata?.targetQty ? item.metadata.targetQty : (isSerial ? 1 : item.quantity ?? 1))) || 1;
      const itemId = item.id;
      const productId = item.product_id ?? item.productId;

      const returnedQty = returns.reduce((sum, r) => {
        if (r.status === 'restored') return sum;
        return sum + (r.items ?? [])
          .filter((ri) => {
            if (isSerial) {
              if (ri.isSerial) return String(ri.serialNumber || '').trim().toLowerCase() === serialNumber.trim().toLowerCase();
              return false;
            }
            if (ri.isSerial) return false;
            if (itemId && ri.itemId) return ri.itemId === itemId;
            if (productId && ri.productId) return ri.productId === productId;
            return false;
          })
          .reduce((s, ri) => s + (ri.returnedQty || 0), 0);
      }, 0);

      const effectiveReturnedQty = isGroup && returnedQty > 0 ? qty : returnedQty;
      const isReturned = effectiveReturnedQty >= qty;
      const isPartial = effectiveReturnedQty > 0 && effectiveReturnedQty < qty;

      return {
        rowId: `item-${idx}-${item.id}`,
        id: itemId,
        productId,
        type: isUnrecorded ? 'unrecorded' : isSerial ? 'serial' : 'parent',
        isUnrecorded,
        unrecordedNote: item.metadata?.unrecordedNote || '',
        productName: item.item_name || item.itemName,
        sku: item.sku,
        tracking: isUnrecorded ? 'Belum Terdata' : isSerial ? 'Serial' : 'Normal',
        serialNumber: isUnrecorded ? 'Tanpa SN (Sementara)' : isSerial ? serialNumber : '—',
        qty,
        qtyUnit,
        returnedQty: effectiveReturnedQty,
        isReturned,
        isPartial,
      };
    });
  }, [items, returns, allSerials, customUnits]);

  const itemStats = useMemo(() => {
    let returnedCount = 0;
    let inCustomerCount = 0;
    displayRows.forEach((r) => {
      if (r.isReturned) returnedCount++;
      else inCustomerCount++;
    });
    return {
      total: displayRows.length,
      returnedCount,
      inCustomerCount,
    };
  }, [displayRows]);

  return (
    <div
      className="go-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="go-detail-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="go-detail-modal go-modal">
        {/* Header */}
        <div className="go-modal__header">
          <div>
            <h2 id="go-detail-title" className="go-modal__title">
              {t('goodsOut.detail.title')}
            </h2>
            <span className="go-detail__ref">
              {doc.document_number}
            </span>
          </div>
          <div className="go-detail__header-right">
            <span className={`chip ${statusCfg.chip}`}>
              {t(statusCfg.label)}
            </span>
            {returnStatus === 'partial' && (
              <span className="chip chip-warning chip-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <RotateCcw size={10} />
                Return Sebagian
              </span>
            )}
            {returnStatus === 'full' && (
              <span className="chip chip-info chip-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <RotateCcw size={10} />
                Return Total
              </span>
            )}
            <SecretEmailButton documentId={doc.id} documentType="goods_out" buttonTitle="Push Email" />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handlePrint}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              title="Cetak Dokumen Barang Keluar"
            >
              <Printer size={14} />
              <span>Cetak</span>
            </button>
            <button
              type="button"
              className="go-modal__close-btn"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="go-modal__body">
          {/* Details */}
          <div className="go-modal__info-card">
            <h4 className="go-modal__info-title">{t('goodsOut.detail.transactionDetails')}</h4>
            <div className="go-modal__info-grid">
              <div className="go-modal__field">
                <span className="go-modal__field-label">{t('goodsOut.detail.date')}</span>
                <input type="text" className="input" value={formatDate(doc.issue_date)} disabled readOnly />
              </div>
              <div className="go-modal__field">
                <span className="go-modal__field-label">{t('goodsOut.detail.source')}</span>
                <input type="text" className="input" value={doc.contact_name || t('goodsOut.detail.noSource')} disabled readOnly />
              </div>
              <div className="go-modal__field gi-modal__field--full">
                <span className="go-modal__field-label">{t('goodsOut.detail.notes')}</span>
                <textarea className="input gi-modal__notes" value={doc.notes || t('goodsOut.detail.noNotes')} disabled readOnly />
              </div>
            </div>
          </div>

          {deleteError && (
            <div className="gi-modal__error" style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
              <AlertCircle size={14} />
              <span>{deleteError}</span>
            </div>
          )}

          {/* Worksheet Section */}
          <div className="go-modal__worksheet">
            <div className="go-detail__items-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Barcode size={16} className="go-detail__icon-muted" style={{ color: 'var(--color-text-muted)' }} />
                <h4 className="go-modal__items-title">{t('goodsOut.detail.items')}</h4>
                <span className="chip" style={{ background: 'var(--color-surface-alt)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                  {displayRows.length} item
                </span>
                {itemStats.inCustomerCount > 0 && (
                  <span className="chip chip-success chip-sm" style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <Check size={11} />
                    <span>{itemStats.inCustomerCount} Di Pelanggan</span>
                  </span>
                )}
                {itemStats.returnedCount > 0 && (
                  <span className="chip chip-warning chip-sm" style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <RotateCcw size={11} />
                    <span>{itemStats.returnedCount} Diretur</span>
                  </span>
                )}
              </div>
            </div>

            {/* Desktop items table */}
            <div className="go-modal__table-desktop">
              <div className="go-modal__table-wrapper">
                <table className="go-modal__table">
                  <colgroup>
                    <col style={{ width: '5%' }} />
                    <col style={{ width: '25%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '12%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'center' }}>{t('goodsOut.detail.colNo')}</th>
                      <th>{t('goodsOut.detail.colProduct')}</th>
                      <th>{t('goodsOut.detail.colSku')}</th>
                      <th>{t('goodsOut.detail.colTracking')}</th>
                      <th>{t('goodsOut.detail.colSerial')}</th>
                      <th style={{ textAlign: 'right' }}>{t('goodsOut.detail.colQty')}</th>
                      <th style={{ textAlign: 'center' }}>Status Item</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row, idx) => (
                      <tr
                        key={row.rowId}
                        className={row.type === 'serial' ? 'go-detail__tr-serial' : ''}
                        style={row.isReturned ? { background: '#fffbeb' } : {}}
                      >
                        <td className="go-detail__td-number" style={{ verticalAlign: 'middle' }}>
                          {String(idx + 1).padStart(2, '0')}
                        </td>
                        <td className={row.type === 'parent' ? 'go-detail__td-name--parent' : 'go-detail__td-name--serial'} style={{ verticalAlign: 'middle' }}>
                          <span style={{ fontWeight: 600 }}>{row.productName}</span>
                        </td>
                        <td className="go-detail__td-sku" style={{ verticalAlign: 'middle' }}>{row.sku || '—'}</td>
                        <td style={{ verticalAlign: 'middle' }}>
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
                        <td style={{ verticalAlign: 'middle' }}>
                          {row.type === 'serial' ? (
                            <span
                              style={{
                                display: 'inline-block',
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                fontSize: '11.5px',
                                fontWeight: 600,
                                letterSpacing: '-0.2px',
                                background: 'var(--color-surface-alt)',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                border: '1px solid var(--color-border)',
                                color: 'var(--color-text-primary)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {row.serialNumber}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                          )}
                        </td>
                        <td className="go-detail__td-qty" style={{ verticalAlign: 'middle' }}>
                          <span style={{ fontWeight: 700 }}>{row.qty}</span> {row.qtyUnit}
                        </td>
                        <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                          {row.isReturned ? (
                            <span
                              className="chip chip-warning chip-sm"
                              style={{
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '2px 8px',
                                background: '#fef3c7',
                                color: '#b45309',
                                border: '1px solid #fde68a',
                              }}
                            >
                              <RotateCcw size={11} />
                              <span>Diretur</span>
                            </span>
                          ) : row.isPartial ? (
                            <span
                              className="chip chip-warning chip-sm"
                              style={{ fontWeight: 700, padding: '2px 8px' }}
                            >
                              Retur Sebagian ({row.returnedQty}/{row.qty})
                            </span>
                          ) : (
                            <span
                              className="chip chip-success chip-sm"
                              style={{
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '2px 8px',
                                background: '#f0fdf4',
                                color: '#15803d',
                                border: '1px solid #bbf7d0',
                              }}
                            >
                              <Check size={11} />
                              <span>Di Pelanggan</span>
                            </span>
                          )}
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
                  <div className="go-line-item-card__grid" style={{ marginTop: '8px' }}>
                    <div>
                      <label className="go-line-item-card__label">{t('goodsOut.detail.colQty')}</label>
                      <div><strong>{row.qty}</strong> {row.qtyUnit}</div>
                    </div>
                    <div>
                      <label className="go-line-item-card__label">Status</label>
                      <div>
                        {row.isReturned ? (
                          <span className="chip chip-warning chip-sm">Return</span>
                        ) : row.isPartial ? (
                          <span className="chip chip-warning chip-sm">Return ({row.returnedQty}/{row.qty})</span>
                        ) : (
                          <span className="chip chip-sm" style={{ background: 'var(--color-surface-alt)', color: 'var(--color-text-secondary)' }}>
                            Di Pelanggan
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Riwayat Retur Surat Jalan Section */}
            {returns.length > 0 && (
              <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-3)', background: 'var(--color-surface, #ffffff)', border: '1px solid var(--color-border, #e2e8f0)', borderRadius: '8px' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                  onClick={() => setShowReturnsHistory((prev) => !prev)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <RotateCcw size={15} style={{ color: 'var(--color-warning, #f59e0b)' }} />
                    <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>
                      Riwayat Retur Surat Jalan ({returns.length})
                    </h4>
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-interactive, #2563eb)' }}>
                    {showReturnsHistory ? 'Sembunyikan ▲' : 'Lihat Riwayat ▼'}
                  </span>
                </div>
                {showReturnsHistory && (
                  <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {returns.map((ret, rIdx) => {
                      const isRestored = ret.status === 'restored';
                      return (
                        <div key={ret.id || rIdx} style={{ padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, fontSize: '12px', color: '#2563eb' }}>
                                {ret.returnNumber || `RET-${rIdx + 1}`}
                              </span>
                              <span className="chip chip-warning chip-sm">
                                {ret.reason === 'salah_produk' ? 'Salah Produk' :
                                 ret.reason === 'cacat_produk' ? 'Cacat / Rusak' :
                                 ret.reason === 'batal_beli' ? 'Batal Beli' : ret.reason}
                              </span>
                              <span style={{ fontSize: '11px', color: '#64748b' }}>{formatDate(ret.returnedAt || ret.date)}</span>
                              <span className={isRestored ? 'chip chip-neutral chip-sm' : 'chip chip-info chip-sm'} style={{ fontSize: '11px' }}>
                                {isRestored ? 'Dipulihkan' : 'Aktif'}
                              </span>
                              <span className="chip chip-neutral chip-sm" style={{ fontSize: '11px' }}>
                                {(ret.items || []).length} item
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                onClick={() => setSelectedReturnForPrint(ret)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                              >
                                <Printer size={11} />
                                <span>Cetak Bukti</span>
                              </button>
                              {!isRestored && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  onClick={() => handleRestoreReturn(ret)}
                                  disabled={restoringReturnId === ret.id}
                                  title="Batalkan retur ini dan pulihkan kembali status barang/nomor seri"
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                >
                                  <RotateCcw size={11} className={restoringReturnId === ret.id ? 'gi-detail__spin' : ''} />
                                  <span>{restoringReturnId === ret.id ? 'Memulihkan...' : 'Batalkan Retur & Pulihkan'}</span>
                                </button>
                              )}
                            </div>
                          </div>
                          {ret.notes && (
                            <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: '#475569', fontStyle: 'italic' }}>"{ret.notes}"</p>
                          )}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                            {(ret.items || []).map((ri, iIdx) => (
                              <span key={iIdx} style={{ fontSize: '11px', padding: '2px 6px', background: '#e2e8f0', borderRadius: '4px' }}>
                                {ri.isSerial ? `SN: ${ri.serialNumber}` : `${ri.productName || 'Item'}: ${ri.returnedQty} ${ri.qtyUnit || 'pcs'}`}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>

          </div>

        {/* Footer */}
        <div className="go-modal__footer" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-danger btn-md interactive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? '...' : t('goodsOut.action.delete')}
          </button>
          
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={handlePrint}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Printer size={15} />
              <span>Cetak Dokumen</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={onClose}
              disabled={deleting}
            >
              {t('goodsOut.detail.close')}
            </button>
            {onEdit && (doc.status === 'processing' || doc.status === 'draft' || doc.status === 'pending') && (
              <button
                type="button"
                className="btn btn-primary btn-md interactive"
                onClick={() => onEdit(doc)}
                disabled={deleting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <Edit3 size={15} />
                <span>Edit Dokumen</span>
              </button>
            )}
          </div>
        </div>
      </div>

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

      {selectedReturnForPrint && (
        <div
          className="go-detail-overlay"
          role="dialog"
          aria-modal="true"
          style={{ zIndex: 1100 }}
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedReturnForPrint(null); }}
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
                  onClick={() => printReturnWithMode(mode.id)}
                >
                  <strong>{mode.label}</strong>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 400 }}>{mode.desc}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedReturnForPrint(null)}>
                Batal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


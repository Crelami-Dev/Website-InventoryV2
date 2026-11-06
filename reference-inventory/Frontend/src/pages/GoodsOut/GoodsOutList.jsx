import React from 'react';
import { ChevronRight, ArrowUpFromLine, RotateCcw } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import './GoodsOutList.css';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const clean = String(dateStr).slice(0, 10);
    const parts = clean.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

export default function GoodsOutList({ docs, onSelect }) {
  const { t } = useApp();

  if (docs.length === 0) return null;

  return (
    <div className="product-table-wrapper go-list-wrapper">
      <table className="table product-table go-list-table">
        <thead>
          <tr>
            <th className="go-list__th--ref">{t('goodsOut.col.reference')}</th>
            <th className="go-list__th--date">{t('goodsOut.col.date')}</th>
            <th className="go-list__th--source">{t('goodsOut.col.source')}</th>
            <th className="go-list__th--items" style={{ width: '80px', textAlign: 'center' }}>{t('goodsOut.col.items')}</th>
            <th className="go-list__th--qty" style={{ width: '80px', textAlign: 'right' }}>{t('goodsOut.col.qty')}</th>
            <th className="go-list__th--status" style={{ width: '110px', textAlign: 'center' }}>{t('goodsOut.col.status')}</th>
            <th style={{ width: '40px' }}></th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => {
            const items = (doc?.items && doc.items.length > 0) ? doc.items : (doc?.metadata?.items ?? []);
            const totalQty = items.reduce((sum, it) => sum + (it.quantity || 0), 0);

            const status = doc.status || 'draft';
            let statusChipClass = 'chip-secondary';
            if (status === 'completed') statusChipClass = 'chip-success';
            else if (status === 'processing' || status === 'pending') statusChipClass = 'chip-warning';
            else if (status === 'cancelled') statusChipClass = 'chip-danger';

            // Detect return status from metadata
            const returns = doc.metadata?.returns ?? [];
            let returnBadge = null;
            if (returns.length > 0) {
              const totalOriginal = items.reduce((sum, it) => {
                const isSerial = it.metadata?.isSerial === true || !!it.metadata?.serialNumber;
                const isGroup = it.metadata?.isGroup === true;
                const qty = isSerial
                  ? (isGroup ? Number(it.metadata?.targetQty ?? it.metadata?.qtyInput ?? 1) : 1)
                  : Number(it.metadata?.qtyInput ?? it.quantity ?? 1);
                return sum + (Number.isFinite(qty) && qty > 0 ? qty : 1);
              }, 0);
              const totalReturned = returns.reduce((sum, r) => {
                return sum + (r.items ?? []).reduce((s, ri) => s + (ri.returnedQty || 0), 0);
              }, 0);
              returnBadge = totalReturned >= totalOriginal ? 'full' : 'partial';
            }

            return (
              <tr
                key={doc.id}
                className="product-table__row go-list__row interactive"
                onClick={() => onSelect(doc)}
              >
                {/* Reference */}
                <td className="go-list__cell--ref" data-label={t('goodsOut.col.reference')}>
                  <div className="go-list__ref-wrap">
                    <ArrowUpFromLine size={13} className="go-list__outbound-icon" />
                    <span className="go-list__ref-text">{doc.document_number}</span>
                  </div>
                </td>

                {/* Date */}
                <td className="go-list__cell--date" data-label={t('goodsOut.col.date')}>
                  {formatDate(doc.issue_date)}
                </td>

                {/* Destination */}
                <td className="go-list__cell--source" data-label={t('goodsOut.col.source')}>
                  {doc.contact_name || <span className="go-list__cell--muted">—</span>}
                </td>

                {/* Items count */}
                <td className="go-list__cell--items" style={{ textAlign: 'center' }} data-label={t('goodsOut.col.items')}>
                  {items.length}
                </td>

                {/* Qty */}
                <td className="go-list__cell--qty" style={{ textAlign: 'right', fontWeight: 600 }} data-label={t('goodsOut.col.qty')}>
                  {totalQty}
                </td>

                {/* Status */}
                <td className="go-list__cell--status" style={{ textAlign: 'center' }} data-label={t('goodsOut.col.status')}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <span className={`chip ${statusChipClass}`}>
                      {t(`goodsOut.status.${status}`, status)}
                    </span>
                    {returnBadge === 'partial' && (
                      <span className="chip chip-warning chip-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '9px' }}>
                        <RotateCcw size={8} />
                        Rtn Sebagian
                      </span>
                    )}
                    {returnBadge === 'full' && (
                      <span className="chip chip-info chip-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '9px' }}>
                        <RotateCcw size={8} />
                        Rtn Total
                      </span>
                    )}
                  </div>
                </td>

                {/* Chevron */}
                <td className="go-list__cell--chevron">
                  <ChevronRight size={15} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

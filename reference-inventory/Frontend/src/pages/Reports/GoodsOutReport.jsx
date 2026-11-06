import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ArrowUpRight, Eye, Calendar, RotateCcw, PackageMinus, FileText } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api } from '../../utils/api.js';
import GoodsOutDetailModal from '../GoodsOut/GoodsOutDetailModal.jsx';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function getItemQtyInPcs(item, multipliers = {}) {
  const rawQty = Number(item.metadata?.qtyInput ?? item.quantity ?? item.qty ?? 1);
  const unit = (item.metadata?.qtyUnit || item.qtyUnit || item.unit || 'pcs').toLowerCase();
  const mult = multipliers[unit] || 1;
  return rawQty * mult;
}

export default function GoodsOutReport() {
  const { t } = useApp();
  const { multipliers } = useUnits();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 25;

  const { data: rawDocs = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['goods-out'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?type=goods_out&limit=1000');
      if (!res.ok) throw new Error('Failed to load goods out documents');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const docs = rawDocs ?? [];

  // KPI Calculations
  const kpi = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    let totalQty = 0;
    let todayCount = 0;
    let monthCount = 0;

    docs.forEach((doc) => {
      if (doc.status === 'cancelled') return;
      const docDate = (doc.issue_date || doc.created_at)?.slice(0, 10);
      if (docDate === today) todayCount++;
      if (docDate?.slice(0, 7) === thisMonth) monthCount++;

      (doc.items || []).forEach((item) => {
        totalQty += getItemQtyInPcs(item, multipliers);
      });
    });

    return {
      totalDocs: docs.length,
      totalQty,
      todayCount,
      monthCount,
    };
  }, [docs, multipliers]);

  // Filtered documents
  const filteredDocs = useMemo(() => {
    let list = docs;

    // 1. Status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'processing') {
        list = list.filter((d) => d.status === 'processing' || d.status === 'draft' || d.status === 'ready');
      } else {
        list = list.filter((d) => d.status === statusFilter);
      }
    }

    // 2. Date Range
    if (fromDate) {
      list = list.filter((d) => (d.issue_date || d.created_at)?.slice(0, 10) >= fromDate);
    }
    if (toDate) {
      list = list.filter((d) => (d.issue_date || d.created_at)?.slice(0, 10) <= toDate);
    }

    // 3. Search query
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) => {
        const matchNumber = d.document_number?.toLowerCase().includes(q);
        const matchContact = d.contact_name?.toLowerCase().includes(q);
        const matchNotes = d.notes?.toLowerCase().includes(q);
        const matchItem = (d.items || []).some(
          (it) =>
            (it.item_name || it.productName || '')?.toLowerCase().includes(q) ||
            (it.sku || '')?.toLowerCase().includes(q)
        );
        return matchNumber || matchContact || matchNotes || matchItem;
      });
    }

    return list;
  }, [docs, statusFilter, fromDate, toDate, search]);

  const totalPages = Math.max(1, Math.ceil(filteredDocs.length / itemsPerPage));
  const paginatedDocs = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredDocs.slice(start, start + itemsPerPage);
  }, [filteredDocs, currentPage]);

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setFromDate('');
    setToDate('');
    setCurrentPage(1);
  };

  const hasActiveFilters = Boolean(search || statusFilter !== 'all' || fromDate || toDate);

  return (
    <div className="reports-section">
      {/* KPI Cards Strip */}
      <div className="reports-kpi-grid">
        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">{t('reports.goodsOut.kpi.totalDocs')}</span>
            <PackageMinus size={16} className="reports-kpi-icon text-danger" />
          </div>
          <div className="reports-kpi-value">{kpi.totalDocs}</div>
          <span className="reports-kpi-sub">Total transaksi keluar</span>
        </div>

        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">{t('reports.goodsOut.kpi.totalQty')}</span>
            <ArrowUpRight size={16} className="reports-kpi-icon text-danger" />
          </div>
          <div className="reports-kpi-value text-danger">{kpi.totalQty.toLocaleString('id-ID')}</div>
          <span className="reports-kpi-sub">Total unit barang keluar</span>
        </div>

        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">{t('reports.goodsOut.kpi.today')}</span>
            <Calendar size={16} className="reports-kpi-icon" />
          </div>
          <div className="reports-kpi-value">{kpi.todayCount}</div>
          <span className="reports-kpi-sub">Transaksi keluar hari ini</span>
        </div>

        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">{t('reports.goodsOut.kpi.thisMonth')}</span>
            <Calendar size={16} className="reports-kpi-icon" />
          </div>
          <div className="reports-kpi-value">{kpi.monthCount}</div>
          <span className="reports-kpi-sub">Transaksi keluar bulan ini</span>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="reports-filters-bar">
        <div className="reports-search-wrap">
          <Search size={15} className="reports-search-icon" />
          <input
            type="text"
            className="input reports-search-input"
            placeholder={t('reports.goodsOut.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
          />
        </div>

        <div className="reports-movement-filters">
          <div className="reports-filter-field">
            <label className="reports-filter-label">{t('reports.movements.dateFrom')}</label>
            <input
              type="date"
              className="input reports-date-input"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>

          <div className="reports-filter-field">
            <label className="reports-filter-label">{t('reports.movements.dateTo')}</label>
            <input
              type="date"
              className="input reports-date-input"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>

          <div className="reports-filter-field">
            <label className="reports-filter-label">{t('reports.goodsOut.colStatus')}</label>
            <select
              className="input select"
              style={{ minWidth: 140 }}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="all">Semua Status</option>
              <option value="completed">Selesai</option>
              <option value="processing">Dalam Proses</option>
              <option value="cancelled">Dibatalkan</option>
            </select>
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              className="btn btn-secondary btn-sm reports-reset-btn interactive"
              onClick={resetFilters}
              title="Reset semua filter"
            >
              <RotateCcw size={13} />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="reports-table-wrapper">
        <table className="reports-table">
          <thead>
            <tr>
              <th>{t('reports.goodsOut.colDate')}</th>
              <th>{t('reports.goodsOut.colDocNo')}</th>
              <th>{t('reports.goodsOut.colCustomer')}</th>
              <th>{t('reports.goodsOut.colItems')}</th>
              <th className="text-right">{t('reports.goodsOut.colTotalQty')}</th>
              <th>{t('reports.goodsOut.colStatus')}</th>
              <th style={{ width: '80px', textAlign: 'center' }}>{t('reports.goodsOut.colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="reports-empty-cell">
                  {t('reports.loading')}
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="reports-empty-cell text-danger">
                  Gagal memuat laporan barang keluar. <button className="btn btn-secondary btn-sm" onClick={refetch}>Coba Lagi</button>
                </td>
              </tr>
            ) : paginatedDocs.length > 0 ? (
              paginatedDocs.map((doc) => {
                const totalDocQty = (doc.items || []).reduce((sum, it) => sum + getItemQtyInPcs(it, multipliers), 0);
                const isCancelled = doc.status === 'cancelled';
                const isCompleted = doc.status === 'completed';

                return (
                  <tr
                    key={doc.id}
                    className="reports-table-row interactive"
                    onClick={() => setSelectedDoc(doc)}
                  >
                    <td data-label={t('reports.goodsOut.colDate')}>
                      {formatDate(doc.issue_date || doc.created_at)}
                    </td>
                    <td data-label={t('reports.goodsOut.colDocNo')} className="text-bold">
                      <div className="reports-doc-ref">
                        <ArrowUpRight size={13} className="text-danger" />
                        <span>{doc.document_number}</span>
                      </div>
                    </td>
                    <td data-label={t('reports.goodsOut.colCustomer')}>
                      {doc.contact_name || doc.customer_name || '—'}
                    </td>
                    <td data-label={t('reports.goodsOut.colItems')}>
                      <div className="reports-items-summary">
                        {(doc.items || []).slice(0, 3).map((it, idx) => {
                          const rawQty = it.metadata?.qtyInput ?? it.quantity ?? it.qty ?? 1;
                          const unit = it.metadata?.qtyUnit || it.qtyUnit || it.unit || 'pcs';
                          const name = it.item_name || it.productName || it.name || 'Produk';
                          const isUnrecorded = it.metadata?.isUnrecorded === true || it.metadata?.isUnrecordedStock === true;
                          return (
                            <span key={idx} className="reports-item-pill reports-item-pill--out">
                              {name} <span className="reports-item-qty">({rawQty} {unit})</span>
                              {isUnrecorded && (
                                <span
                                  title="Barang Belum Terdata (Non-SN)"
                                  style={{
                                    marginLeft: '4px',
                                    fontSize: '10px',
                                    background: '#fef3c7',
                                    color: '#b45309',
                                    padding: '1px 5px',
                                    borderRadius: '4px',
                                    fontWeight: 600,
                                    border: '1px solid #fde68a',
                                  }}
                                >
                                  Non-SN
                                </span>
                              )}
                            </span>
                          );
                        })}
                        {(doc.items || []).length > 3 && (
                          <span className="reports-item-more">
                            +{(doc.items || []).length - 3} lainnya
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label={t('reports.goodsOut.colTotalQty')} className="text-right text-bold text-danger">
                      -{totalDocQty.toLocaleString('id-ID')}
                    </td>
                    <td data-label={t('reports.goodsOut.colStatus')}>
                      <span
                        className={`doc-status-badge-mini doc-status-badge-mini--${doc.status || 'draft'}`}
                      >
                        {isCompleted ? 'Selesai' : isCancelled ? 'Dibatalkan' : 'Dalam Proses'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm reports-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDoc(doc);
                        }}
                        title={t('reports.goodsOut.viewDetail')}
                      >
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7} className="reports-empty-cell">
                  {t('reports.goodsOut.noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="reports-pagination">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((prev) => prev - 1)}
          >
            {t('reports.movements.pagination.prev')}
          </button>
          <span className="reports-page-indicator">
            {t('reports.movements.pagination.page', { current: currentPage, total: totalPages })}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((prev) => prev + 1)}
          >
            {t('reports.movements.pagination.next')}
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {selectedDoc && (
        <GoodsOutDetailModal
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
        />
      )}
    </div>
  );
}

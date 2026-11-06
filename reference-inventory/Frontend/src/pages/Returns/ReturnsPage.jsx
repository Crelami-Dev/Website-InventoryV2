import React, { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RotateCcw,
  Search,
  Calendar,
  X,
  ArrowUpFromLine,
  ArrowDownToLine,
  AlertTriangle,
  Package,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Plus,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api } from '../../utils/api.js';
import ReturnDetailModal from './ReturnDetailModal.jsx';
import GoodsOutReturnModal from '../GoodsOut/GoodsOutReturnModal.jsx';
import './ReturnsPage.css';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = dateStr.split('-');
    if (y && m && d) return `${d}/${m}/${y}`;
    return dateStr;
  } catch {
    return dateStr;
  }
}

export default function ReturnsPage() {
  const { t } = useApp();
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [search, setSearch] = useState('');
  const [typeTab, setTypeTab] = useState('all'); // 'all', 'goods_out', 'goods_in'
  const [statusTab, setStatusTab] = useState('all'); // 'all', 'active', 'restored'
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedReturn, setSelectedReturn] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const startDateInputRef = useRef(null);
  const endDateInputRef = useRef(null);

  const openDatePicker = (inputRef) => {
    if (inputRef && inputRef.current) {
      try {
        inputRef.current.showPicker();
      } catch {
        inputRef.current.focus();
      }
    }
  };

  const handleStartDateChange = (e) => {
    const val = e.target.value;
    setStartDate(val);
    setPage(1);
    if (val && endDate && val > endDate) {
      setEndDate(val);
    }
  };

  const handleEndDateChange = (e) => {
    const val = e.target.value;
    setEndDate(val);
    setPage(1);
    if (startDate && val && val < startDate) {
      setStartDate(val);
    }
  };

  const handleClearDateFilter = () => {
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const hasDateFilter = Boolean(startDate || endDate);

  // Fetch returns from backend
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['returns-list', page, limit, search, typeTab, statusTab, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search.trim()) params.set('search', search.trim());
      if (typeTab !== 'all') params.set('type', typeTab);
      if (statusTab !== 'all') params.set('status', statusTab);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);

      const res = await api.get(`/api/workspace/returns?${params.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || errJson?.message || 'Gagal memuat daftar retur');
      }
      return res.json();
    },
    staleTime: 30000,
  });

  const returns = data?.data || [];
  const meta = data?.meta || { total: 0, totalPages: 1 };

  // Calculate local KPIs for current query
  const kpiStats = useMemo(() => {
    let outCount = 0;
    let inCount = 0;
    let totalItems = 0;
    returns.forEach((r) => {
      if (r.documentType === 'goods_out') outCount++;
      if (r.documentType === 'goods_in') inCount++;
      (r.items || []).forEach((it) => {
        totalItems += Number(it.returnedQty || 1);
      });
    });
    return {
      total: meta.total,
      outCount,
      inCount,
      totalItems,
    };
  }, [returns, meta.total]);

  // Tab counts
  const tabCounts = useMemo(() => {
    let goodsOut = 0;
    let goodsIn = 0;
    returns.forEach((r) => {
      if (r.documentType === 'goods_out') goodsOut++;
      if (r.documentType === 'goods_in') goodsIn++;
    });
    return {
      all: meta.total,
      goods_out: goodsOut,
      goods_in: goodsIn,
    };
  }, [returns, meta.total]);

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
    <div className="returns-page">
      {/* Header */}
      <div className="returns-header">
        <div className="returns-header__title-group">
          <div className="returns-header__icon">
            <RotateCcw size={22} />
          </div>
          <div>
            <h1 className="returns-header__title">Riwayat Retur Inventory</h1>
            <p className="returns-header__subtitle">
              Pusat monitoring &amp; audit transaksi retur Barang Keluar (Surat Jalan) dan Barang Masuk
            </p>
          </div>
        </div>
        <div className="returns-header__actions">
          <button
            type="button"
            className="btn btn-primary btn-md interactive"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={16} />
            <span>Buat Retur</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-md interactive"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw size={14} className={isFetching ? 'gi-detail__spin' : ''} />
            <span>Segarkan</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="returns-kpis">
        <div className="returns-kpi-card">
          <div className="returns-kpi-card__icon returns-kpi-card__icon--total">
            <RotateCcw size={20} />
          </div>
          <div className="returns-kpi-card__content">
            <div className="returns-kpi-card__label">Total Transaksi Retur</div>
            <div className="returns-kpi-card__value returns-kpi-card__value--accent">{kpiStats.total}</div>
          </div>
        </div>

        <div className="returns-kpi-card">
          <div className="returns-kpi-card__icon returns-kpi-card__icon--out">
            <ArrowUpFromLine size={20} />
          </div>
          <div className="returns-kpi-card__content">
            <div className="returns-kpi-card__label">Retur Barang Keluar</div>
            <div className="returns-kpi-card__value">{kpiStats.outCount}</div>
          </div>
        </div>

        <div className="returns-kpi-card">
          <div className="returns-kpi-card__icon returns-kpi-card__icon--in">
            <ArrowDownToLine size={20} />
          </div>
          <div className="returns-kpi-card__content">
            <div className="returns-kpi-card__label">Retur Barang Masuk</div>
            <div className="returns-kpi-card__value">{kpiStats.inCount}</div>
          </div>
        </div>

        <div className="returns-kpi-card">
          <div className="returns-kpi-card__icon returns-kpi-card__icon--damaged">
            <Package size={20} />
          </div>
          <div className="returns-kpi-card__content">
            <div className="returns-kpi-card__label">Item Fisik Diretur</div>
            <div className="returns-kpi-card__value">{kpiStats.totalItems}</div>
          </div>
        </div>
      </div>

      {/* Type Tabs */}
      <div className="returns-tabs">
        {[
          { key: 'all', label: 'Semua Jenis', count: tabCounts.all },
          { key: 'goods_out', label: 'Barang Keluar', count: tabCounts.goods_out },
          { key: 'goods_in', label: 'Barang Masuk', count: tabCounts.goods_in },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            className={`returns-tab${typeTab === key ? ' returns-tab--active' : ''}`}
            onClick={() => {
              setTypeTab(key);
              setPage(1);
            }}
          >
            {label}
            {count !== undefined && <span className="returns-tab__count">{count}</span>}
          </button>
        ))}
      </div>

      {/* Toolbar & Filters */}
      <div className="returns-toolbar">
        <div className="returns-toolbar__left">
          {/* Status Pills Filter */}
          <div className="returns-status-pills">
            <button
              type="button"
              className={`returns-status-pill ${statusTab === 'all' ? 'returns-status-pill--active' : ''}`}
              onClick={() => {
                setStatusTab('all');
                setPage(1);
              }}
            >
              Semua Status
            </button>
            <button
              type="button"
              className={`returns-status-pill ${statusTab === 'active' ? 'returns-status-pill--active' : ''}`}
              onClick={() => {
                setStatusTab('active');
                setPage(1);
              }}
            >
              Aktif
            </button>
            <button
              type="button"
              className={`returns-status-pill ${statusTab === 'restored' ? 'returns-status-pill--active' : ''}`}
              onClick={() => {
                setStatusTab('restored');
                setPage(1);
              }}
            >
              Dipulihkan
            </button>
          </div>
        </div>

        <div className="returns-toolbar__right">
          {/* Search */}
          <div className="returns-search">
            <Search size={15} className="returns-search__icon" />
            <input
              type="text"
              className="returns-search__input"
              placeholder="Cari no. retur, no. surat jalan, SKU..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>

          {/* Date range filter */}
          <div className="returns-date-filter" onClick={() => openDatePicker(startDateInputRef)}>
            <Calendar size={15} className="returns-date-icon" />
            <div className="returns-date-field">
              <span className="returns-date-label">Dari:</span>
              <div className="returns-date-picker-wrapper">
                <span className={`returns-date-display ${!startDate ? 'is-placeholder' : ''}`}>
                  {formatDisplayDate(startDate) || 'dd/mm/yyyy'}
                </span>
                <input
                  ref={startDateInputRef}
                  type="date"
                  className="returns-date-input-hidden"
                  value={startDate}
                  max={endDate || undefined}
                  onChange={handleStartDateChange}
                  onClick={(e) => {
                    e.stopPropagation();
                    openDatePicker(startDateInputRef);
                  }}
                  title="Tanggal Mulai (dd/mm/yyyy)"
                />
              </div>
            </div>
            <span className="returns-date-separator">—</span>
            <div
              className="returns-date-field"
              onClick={(e) => {
                e.stopPropagation();
                openDatePicker(endDateInputRef);
              }}
            >
              <span className="returns-date-label">Sampai:</span>
              <div className="returns-date-picker-wrapper">
                <span className={`returns-date-display ${!endDate ? 'is-placeholder' : ''}`}>
                  {formatDisplayDate(endDate) || 'dd/mm/yyyy'}
                </span>
                <input
                  ref={endDateInputRef}
                  type="date"
                  className="returns-date-input-hidden"
                  value={endDate}
                  min={startDate || undefined}
                  onChange={handleEndDateChange}
                  onClick={(e) => {
                    e.stopPropagation();
                    openDatePicker(endDateInputRef);
                  }}
                  title="Tanggal Akhir (dd/mm/yyyy)"
                />
              </div>
            </div>
            {hasDateFilter && (
              <button
                type="button"
                className="returns-date-clear-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClearDateFilter();
                }}
                title="Reset filter tanggal"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Table / Cards */}
      <div className="returns-card">
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--color-text-muted)' }}>
            <RotateCcw size={24} className="gi-detail__spin" style={{ marginBottom: '8px' }} />
            <div>Memuat data retur inventory...</div>
          </div>
        ) : isError ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--color-danger)' }}>
            <AlertTriangle size={24} style={{ marginBottom: '8px' }} />
            <div>{error?.message || 'Gagal memuat data retur'}</div>
          </div>
        ) : returns.length === 0 ? (
          <div className="returns-empty">
            <RotateCcw size={36} className="returns-empty__icon" />
            <div className="returns-empty__title">Tidak Ada Transaksi Retur</div>
            <div style={{ fontSize: '13px' }}>
              Tidak ditemukan data retur yang sesuai dengan filter pencarian Anda.
            </div>
          </div>
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="returns-table-wrapper">
              <table className="returns-table">
                <thead>
                  <tr>
                    <th>No. Bukti Retur</th>
                    <th>Ref Surat Jalan / Dokumen</th>
                    <th>Mitra / Kontak</th>
                    <th>Waktu Retur</th>
                    <th>Alasan</th>
                    <th>Kondisi Masuk</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Total Item</th>
                  </tr>
                </thead>
                <tbody>
                  {returns.map((ret) => {
                    const isGoodsOut = ret.documentType === 'goods_out';
                    const isRestored = ret.status === 'restored';
                    const totalQty = (ret.items || []).reduce(
                      (acc, it) => {
                        const qty = it.isGroup ? Number(it.targetQty ?? it.returnedQty ?? 1) : Number(it.returnedQty ?? 1);
                        return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
                      },
                      0
                    );
                    return (
                      <tr key={ret.id} onClick={() => setSelectedReturn(ret)}>
                        <td>
                          <span className="returns-table__num">{ret.returnNumber}</span>
                        </td>
                        <td>
                          <div className="returns-table__doc">{ret.documentNumber}</div>
                          <span
                            className={
                              isGoodsOut ? 'chip chip-warning chip-sm' : 'chip chip-success chip-sm'
                            }
                          >
                            {isGoodsOut ? 'Barang Keluar' : 'Barang Masuk'}
                          </span>
                        </td>
                        <td>{ret.contactName || '—'}</td>
                        <td style={{ color: 'var(--color-text-secondary)' }}>
                          {formatDate(ret.returnedAt)}
                        </td>
                        <td>
                          <span className="chip chip-neutral chip-sm">
                            {reasonLabels[ret.reason] || ret.reason || 'Retur'}
                          </span>
                        </td>
                        <td>
                          {ret.condition === 'damaged' ? (
                            <span className="chip chip-danger chip-sm">Rusak / Cacat</span>
                          ) : (
                            <span className="chip chip-success chip-sm">Kondisi Baik</span>
                          )}
                        </td>
                        <td>
                          {isRestored ? (
                            <span className="chip chip-neutral chip-sm">Dipulihkan</span>
                          ) : (
                            <span className="chip chip-info chip-sm">Aktif</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="returns-table__items-pill">
                            <strong>{totalQty}</strong> unit
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card View */}
            <div className="returns-mobile-list">
              {returns.map((ret) => {
                const isGoodsOut = ret.documentType === 'goods_out';
                const isRestored = ret.status === 'restored';
                const totalQty = (ret.items || []).reduce(
                  (acc, it) => {
                    const qty = it.isGroup ? Number(it.targetQty ?? it.returnedQty ?? 1) : Number(it.returnedQty ?? 1);
                    return acc + (Number.isFinite(qty) && qty > 0 ? qty : 1);
                  },
                  0
                );
                return (
                  <div
                    key={ret.id}
                    className="returns-mobile-card"
                    onClick={() => setSelectedReturn(ret)}
                  >
                    <div className="returns-mobile-card__header">
                      <span className="returns-mobile-card__title">{ret.returnNumber}</span>
                      <span
                        className={
                          isRestored ? 'chip chip-neutral chip-sm' : 'chip chip-info chip-sm'
                        }
                      >
                        {isRestored ? 'Dipulihkan' : 'Aktif'}
                      </span>
                    </div>
                    <div className="returns-mobile-card__row">
                      <span>Ref Dokumen:</span>
                      <strong>
                        {ret.documentNumber} ({isGoodsOut ? 'Goods Out' : 'Goods In'})
                      </strong>
                    </div>
                    <div className="returns-mobile-card__row">
                      <span>Alasan / Kondisi:</span>
                      <span>
                        {reasonLabels[ret.reason] || ret.reason} •{' '}
                        <strong
                          style={{
                            color:
                              ret.condition === 'damaged'
                                ? 'var(--color-danger)'
                                : 'var(--color-success)',
                          }}
                        >
                          {ret.condition === 'damaged' ? 'Rusak' : 'Baik'}
                        </strong>
                      </span>
                    </div>
                    <div className="returns-mobile-card__row">
                      <span>Tanggal:</span>
                      <span>{formatDate(ret.returnedAt)}</span>
                    </div>
                    <div className="returns-mobile-card__row returns-mobile-card__divider">
                      <span>Total Barang:</span>
                      <strong>
                        {totalQty} unit ({(ret.items || []).length} jenis)
                      </strong>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination Bar */}
            <div className="returns-pagination">
              <div>
                Halaman <strong>{page}</strong> dari <strong>{meta.totalPages}</strong> ({meta.total}{' '}
                transaksi retur)
              </div>
              <div className="returns-pagination__btns">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm interactive"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft size={14} />
                  <span>Sebelumnya</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm interactive"
                  onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                  disabled={page >= meta.totalPages}
                >
                  <span>Berikutnya</span>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Detail & Action Modal */}
      {selectedReturn && (
        <ReturnDetailModal
          returnData={selectedReturn}
          onClose={() => setSelectedReturn(null)}
          onRestored={() => {
            refetch();
          }}
        />
      )}

      {/* Create Return Modal */}
      {showCreateModal && (
        <GoodsOutReturnModal
          doc={null}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}

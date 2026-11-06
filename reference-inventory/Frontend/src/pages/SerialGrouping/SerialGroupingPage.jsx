import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Layers,
  Search,
  RefreshCw,
  Eye,
  RotateCcw,
  Building2,
  Package,
  CheckCircle2,
  AlertCircle,
  FileText,
  Barcode,
  ChevronDown,
  ChevronRight,
  Clock,
  Check,
  X,
  Loader2,
} from 'lucide-react';
import { api } from '../../utils/api.js';
import SerialMultiGroupingModal from './SerialMultiGroupingModal';
import SerialGroupingDetailModal from './SerialGroupingDetailModal';
import SerialGroupingUngroupModal from './SerialGroupingUngroupModal';
import { matchesGroupingSearch, matchesGroupingSessionSearch } from './serialGroupingReference.js';
import { getGroupingDisplayRow, getGroupingSessionRow } from './serialGroupingDisplay.js';
import './SerialGroupingPage.css';

const formatDate = (dateString) => {
  if (!dateString) return '-';
  try {
    const d = new Date(dateString);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
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
  if (normStatus === 'pending') {
    return (
      <span className="sg-status-badge badge-pending">
        <Clock size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
        Pending
      </span>
    );
  }
  if (normStatus === 'partially_completed') {
    return <span className="sg-status-badge badge-partial">Sebagian Berhasil</span>;
  }
  if (normStatus === 'dissolved') {
    return <span className="sg-status-badge badge-dissolved">Dibongkar</span>;
  }
  if (normStatus === 'cancelled') {
    return <span className="sg-status-badge badge-cancelled">Dibatalkan</span>;
  }
  return <span className="sg-status-badge badge-default">{status || '-'}</span>;
};

export default function SerialGroupingPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [groupings, setGroupings] = useState([]);

  // Warehouses filter
  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState('');

  // Status and Search Filters
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal states
  const [isMultiGroupModalOpen, setIsMultiGroupModalOpen] = useState(false);
  const [selectedDetailId, setSelectedDetailId] = useState(null);
  const [selectedUngroupData, setSelectedUngroupData] = useState(null);

  // Expandable sessions & batches state (Phase 7K)
  const [expandedSessionIds, setExpandedSessionIds] = useState(new Set());
  const [expandedBatchIds, setExpandedBatchIds] = useState(new Set());
  const [confirmingSessionId, setConfirmingSessionId] = useState(null);
  const [cancellingSessionId, setCancellingSessionId] = useState(null);

  // Pagination (Frontend client pagination over fetched records)
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // 1. Fetch Warehouses
  useEffect(() => {
    const fetchWarehouses = async () => {
      try {
        const res = await api.get('/api/workspace/warehouses');
        if (res.ok) {
          const json = await res.json();
          setWarehouses(json.data || []);
        }
      } catch (err) {
        console.error('Error fetching warehouses:', err);
      }
    };
    fetchWarehouses();
  }, []);

  // 2. Fetch Groupings / Sessions from API
  const fetchGroupings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let queryParams = '?limit=200';
      if (statusFilter !== 'all') {
        queryParams += `&status=${encodeURIComponent(statusFilter)}`;
      }
      if (selectedWarehouse) {
        queryParams += `&warehouseId=${encodeURIComponent(selectedWarehouse)}`;
      }

      const res = await api.get(`/api/workspace/product-serials/grouping-sessions${queryParams}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Gagal memuat data sesi grouping serial.');
      }
      const json = await res.json();
      setGroupings(json.data || []);
    } catch (err) {
      console.error('Error fetching groupings list:', err);
      setError(err.message || 'Terjadi kesalahan saat memuat riwayat grouping.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, selectedWarehouse]);

  useEffect(() => {
    fetchGroupings();
  }, [fetchGroupings]);

  // Client filtering for instant search
  const filteredGroupings = useMemo(() => {
    if (!searchQuery.trim()) return groupings;
    return groupings.filter((item) => {
      return matchesGroupingSessionSearch(item, searchQuery) || matchesGroupingSearch(item, searchQuery);
    });
  }, [groupings, searchQuery]);

  // Pagination calculation
  const totalPages = Math.ceil(filteredGroupings.length / itemsPerPage) || 1;
  const paginatedGroupings = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredGroupings.slice(start, start + itemsPerPage);
  }, [filteredGroupings, currentPage]);

  // Reset page on filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, selectedWarehouse]);

  // Metric KPIs
  const stats = useMemo(() => {
    const total = groupings.length;
    const pending = groupings.filter((g) => (g.status || '').toLowerCase() === 'pending').length;
    const active = groupings.filter((g) => {
      const s = (g.status || '').toLowerCase();
      return s === 'completed' || s === 'active';
    }).length;
    const dissolved = groupings.filter((g) => {
      const s = (g.status || '').toLowerCase();
      return s === 'dissolved' || s === 'cancelled';
    }).length;
    return { total, pending, active, dissolved };
  }, [groupings]);

  // Toggle session expand
  const toggleExpandSession = (sessionId) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  // Toggle batch component SN expand
  const toggleExpandBatch = (batchKey, e) => {
    e?.stopPropagation();
    setExpandedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchKey)) next.delete(batchKey);
      else next.add(batchKey);
      return next;
    });
  };

  // PHASE 7K — Confirm Pending Grouping Session
  const handleConfirmSession = async (session, e) => {
    e?.stopPropagation();
    if (confirmingSessionId) return;

    const sessionRef = session.sessionNumber || session.reference || session.id;
    const confirmPrompt = window.confirm(
      `Konfirmasi Grouping untuk sesi "${sessionRef}"?\n\n` +
      `Sistem akan memvalidasi ulang seluruh nomor seri, memotong stok komponen, menghasilkan serial baru resmi, dan mencatat transaksi ke stock ledger.`
    );
    if (!confirmPrompt) return;

    setConfirmingSessionId(session.id);
    try {
      const res = await api.post(`/api/workspace/product-serials/grouping-sessions/${session.id}/confirm`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error?.message || json.message || 'Gagal mengonfirmasi sesi grouping.');
      }
      await fetchGroupings();
      alert(`Sesi grouping ${sessionRef} berhasil dikonfirmasi dan difinalisasi!`);
    } catch (err) {
      console.error('Error confirming grouping session:', err);
      alert(`Konfirmasi gagal: ${err.message}`);
    } finally {
      setConfirmingSessionId(null);
    }
  };

  // PHASE 7K — Cancel Pending Grouping Session
  const handleCancelSession = async (session, e) => {
    e?.stopPropagation();
    if (cancellingSessionId) return;

    const sessionRef = session.sessionNumber || session.reference || session.id;
    const confirmPrompt = window.confirm(
      `Batalkan sesi grouping "${sessionRef}"?\n\n` +
      `Status sesi akan diubah menjadi Dibatalkan. Rancangan batch dibatalkan tanpa mengubah stok atau status nomor seri.`
    );
    if (!confirmPrompt) return;

    setCancellingSessionId(session.id);
    try {
      const res = await api.post(`/api/workspace/product-serials/grouping-sessions/${session.id}/cancel`, {
        notes: 'Dibatalkan oleh pengguna dari daftar riwayat',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error?.message || json.message || 'Gagal membatalkan sesi grouping.');
      }
      await fetchGroupings();
    } catch (err) {
      console.error('Error cancelling grouping session:', err);
      alert(`Pembatalan gagal: ${err.message}`);
    } finally {
      setCancellingSessionId(null);
    }
  };

  return (
    <div className="sg-page-container">
      {/* Page Header */}
      <div className="sg-page-header">
        <div className="sg-header-left">
          <div className="sg-page-icon">
            <Layers size={26} />
          </div>
          <div>
            <h1 className="sg-page-title">Grouping Serial</h1>
            <p className="sg-page-desc">
              Gabungkan beberapa nomor seri sumber menjadi satu nomor seri hasil, lengkap dengan pencatatan stok dan audit trail.
            </p>
          </div>
        </div>

        <div className="sg-header-actions">
          <button
            type="button"
            className="sg-btn-secondary"
            onClick={fetchGroupings}
            disabled={loading}
            title="Muat Ulang Data"
          >
            <RefreshCw size={16} className={loading ? 'sg-spin' : ''} />
            <span>Segarkan</span>
          </button>

          <button
            type="button"
            className="sg-btn-primary"
            onClick={() => setIsMultiGroupModalOpen(true)}
            title="Tambah group dengan memindai nomor seri sumber"
          >
            <Barcode size={18} />
            <span>Add Group</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="sg-kpi-grid">
        <div className="sg-kpi-card">
          <div className="sg-kpi-icon-wrap icon-blue">
            <FileText size={20} />
          </div>
          <div className="sg-kpi-info">
            <span className="sg-kpi-label">Total Sesi Transaksi</span>
            <span className="sg-kpi-value">{stats.total}</span>
          </div>
        </div>

        <div className="sg-kpi-card">
          <div className="sg-kpi-icon-wrap icon-amber">
            <Clock size={20} />
          </div>
          <div className="sg-kpi-info">
            <span className="sg-kpi-label">Sesi Pending</span>
            <span className="sg-kpi-value">{stats.pending}</span>
          </div>
        </div>

        <div className="sg-kpi-card">
          <div className="sg-kpi-icon-wrap icon-green">
            <CheckCircle2 size={20} />
          </div>
          <div className="sg-kpi-info">
            <span className="sg-kpi-label">Grouping Aktif / Selesai</span>
            <span className="sg-kpi-value">{stats.active}</span>
          </div>
        </div>

        <div className="sg-kpi-card">
          <div className="sg-kpi-icon-wrap icon-amber">
            <RotateCcw size={20} />
          </div>
          <div className="sg-kpi-info">
            <span className="sg-kpi-label">Dibongkar / Dibatalkan</span>
            <span className="sg-kpi-value">{stats.dissolved}</span>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="sg-toolbar-card">
        {/* Status Tabs */}
        <div className="sg-status-tabs">
          <button
            type="button"
            className={`sg-status-tab ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            Semua ({groupings.length})
          </button>
          <button
            type="button"
            className={`sg-status-tab ${statusFilter === 'pending' ? 'active' : ''}`}
            onClick={() => setStatusFilter('pending')}
          >
            Pending ({stats.pending})
          </button>
          <button
            type="button"
            className={`sg-status-tab ${statusFilter === 'completed' ? 'active' : ''}`}
            onClick={() => setStatusFilter('completed')}
          >
            Aktif / Selesai ({stats.active})
          </button>
          <button
            type="button"
            className={`sg-status-tab ${statusFilter === 'dissolved' ? 'active' : ''}`}
            onClick={() => setStatusFilter('dissolved')}
          >
            Dibongkar / Dibatalkan ({stats.dissolved})
          </button>
        </div>

        {/* Filters Right: Warehouse & Search */}
        <div className="sg-toolbar-controls">
          <div className="sg-filter-warehouse">
            <Building2 size={16} className="sg-filter-icon" />
            <select
              value={selectedWarehouse}
              onChange={(e) => setSelectedWarehouse(e.target.value)}
            >
              <option value="">Semua Gudang</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sg-filter-search">
            <Search size={16} className="sg-search-icon" />
            <input
              type="text"
              placeholder="Cari Referensi, No Grouping, SN Hasil, Produk..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="sg-clear-search"
                onClick={() => setSearchQuery('')}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Table Card */}
      <div className="sg-table-card">
        {loading && groupings.length === 0 ? (
          <div className="sg-table-state">
            <div className="sg-table-spinner"></div>
            <p>Memuat daftar riwayat grouping serial...</p>
          </div>
        ) : error && groupings.length === 0 ? (
          <div className="sg-table-state error">
            <AlertCircle size={32} />
            <p>{error}</p>
            <button className="sg-btn-secondary" onClick={fetchGroupings}>
              Coba Lagi
            </button>
          </div>
        ) : filteredGroupings.length === 0 ? (
          <div className="sg-table-state empty">
            <Layers size={40} className="text-muted" />
            <h3>Belum Ada Transaksi Grouping</h3>
            <p>
              {searchQuery || statusFilter !== 'all' || selectedWarehouse
                ? 'Tidak ada transaksi grouping yang cocok dengan filter yang dipilih.'
                : 'Mulai buat grouping serial lintas produk pertama Anda dengan tombol Add Group.'}
            </p>
          </div>
        ) : (
          <div className="sg-table-wrapper">
            <table className="sg-data-table">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}></th>
                  <th className="sg-th-ref">Referensi Sesi</th>
                  <th>Nama Sesi / Deskripsi</th>
                  <th>Tanggal</th>
                  <th>Gudang</th>
                  <th>Total Batch / SN</th>
                  <th className="text-center">Status</th>
                  <th className="text-center" style={{ width: 96 }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {paginatedGroupings.map((item) => {
                  const sessionRow = getGroupingSessionRow(item);
                  const row = getGroupingDisplayRow(item) || {};
                  const isExpanded = expandedSessionIds.has(sessionRow.id);
                  const isPending = sessionRow.status === 'pending';
                  const isConfirming = confirmingSessionId === sessionRow.id;
                  const isCancelling = cancellingSessionId === sessionRow.id;
                  const whName =
                    warehouses.find((w) => w.id === sessionRow.warehouseId)?.name ||
                    sessionRow.warehouseName ||
                    'Gudang Utama';

                  return (
                    <React.Fragment key={sessionRow.id}>
                      <tr
                        className="sg-row-clickable"
                        tabIndex={0}
                        role="button"
                        aria-expanded={isExpanded}
                        aria-label={`Buka detail sesi grouping ${sessionRow.reference}`}
                        onClick={() => toggleExpandSession(sessionRow.id)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleExpandSession(sessionRow.id);
                          }
                        }}
                      >
                        <td style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="sg-expand-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpandSession(sessionRow.id);
                            }}
                            title={isExpanded ? 'Tutup rincian batch' : 'Buka rincian batch'}
                          >
                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>

                        <td className="sg-cell-ref">
                          <div className="sg-ref-stack">
                            {row.reference ? (
                              <button
                                type="button"
                                className="sg-ref-link"
                                title={`Lihat detail dokumen assembly: ${row.reference}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleExpandSession(sessionRow.id);
                                }}
                              >
                                <Package size={13} className="sg-ref-icon" />
                                <span className="sg-ref-text mono font-semibold">{row.reference}</span>
                              </button>
                            ) : (
                              <span className="sg-ref-empty" title="Tidak ada dokumen assembly terkait">
                                <Package size={13} className="sg-ref-icon" />
                                <span className="text-muted">—</span>
                              </span>
                            )}
                            {row.reversalReference && (
                              <div className="sg-ref-reversal" title={`Dokumen reversal: ${row.reversalReference}`}>
                                <RotateCcw size={11} />
                                <span className="mono">{row.reversalReference}</span>
                              </div>
                            )}
                          </div>
                        </td>

                        <td>
                          <span className="prod-name font-semibold" title={sessionRow.name}>
                            {sessionRow.name}
                          </span>
                        </td>

                        <td>
                          <span className="sg-date-text">{formatDate(sessionRow.createdAt)}</span>
                        </td>

                        <td>
                          <span className="sg-wh-tag" title={whName}>{whName}</span>
                        </td>

                        <td>
                          <span className="sg-qty-tag">
                            {sessionRow.totalBatches} Batch ({sessionRow.totalSerials} SN)
                          </span>
                        </td>

                        <td className="text-center">
                          {renderStatusBadge(sessionRow.status)}
                        </td>

                        <td className="text-center">
                          <div className="sg-action-buttons">
                            {isPending ? (
                              <>
                                <button
                                  type="button"
                                  className="sg-btn-icon btn-confirm"
                                  title="Konfirmasi Grouping"
                                  disabled={isConfirming || isCancelling}
                                  onClick={(e) => handleConfirmSession(sessionRow, e)}
                                >
                                  {isConfirming ? (
                                    <Loader2 size={15} className="sg-spin" />
                                  ) : (
                                    <Check size={16} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="sg-btn-icon btn-danger"
                                  title="Batalkan Sesi"
                                  disabled={isConfirming || isCancelling}
                                  onClick={(e) => handleCancelSession(sessionRow, e)}
                                >
                                  {isCancelling ? (
                                    <Loader2 size={15} className="sg-spin" />
                                  ) : (
                                    <X size={16} />
                                  )}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="sg-btn-icon"
                                  title="Lihat Detail & Traceability"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const firstBatchId = sessionRow.batches?.[0]?.id || sessionRow.id;
                                    setSelectedDetailId(firstBatchId);
                                  }}
                                >
                                  <Eye size={16} />
                                </button>

                                {sessionRow.status === 'completed' && sessionRow.batches?.length === 1 && (
                                  <button
                                    type="button"
                                    className="sg-btn-icon btn-danger"
                                    title="Bongkar Group (Reversal)"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedUngroupData(sessionRow.batches[0] || item);
                                    }}
                                  >
                                    <RotateCcw size={16} />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expandable Session Drawer: Batches & Components (Phase 7K) */}
                      {isExpanded && (
                        <tr className="sg-session-drawer-row">
                          <td colSpan={8} className="sg-session-drawer-cell">
                            <div className="sg-session-drawer-box">
                              <div className="sg-drawer-header">
                                <div className="sg-drawer-header-left">
                                  <span className="sg-drawer-title">
                                    <Layers size={15} />
                                    Daftar Batch pada Sesi {sessionRow.reference} ({sessionRow.batches?.length || 1} Batch)
                                  </span>
                                  <span className="sg-drawer-hint">
                                    {sessionRow.notes ? `Catatan: ${sessionRow.notes} — ` : ''}
                                    Setiap batch menghasilkan serial tersendiri dengan alokasi komponen SN terisolasi.
                                  </span>
                                </div>
                                {isPending && (
                                  <div className="sg-drawer-actions">
                                    <button
                                      type="button"
                                      className="sg-btn-secondary sg-btn-sm"
                                      disabled={isConfirming || isCancelling}
                                      onClick={(e) => handleCancelSession(sessionRow, e)}
                                      title="Batalkan Sesi Pending"
                                    >
                                      {isCancelling ? <Loader2 size={13} className="sg-spin" /> : <X size={13} />}
                                      <span>Batalkan Sesi</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="sg-btn-primary sg-btn-sm"
                                      disabled={isConfirming || isCancelling}
                                      onClick={(e) => handleConfirmSession(sessionRow, e)}
                                      title="Konfirmasi Seluruh Batch dalam Sesi"
                                    >
                                      {isConfirming ? <Loader2 size={13} className="sg-spin" /> : <Check size={13} />}
                                      <span>Konfirmasi Grouping</span>
                                    </button>
                                  </div>
                                )}
                              </div>

                              <div className="sg-nested-table-wrap">
                                <table className="sg-data-table sg-nested-table">
                                  <thead>
                                    <tr>
                                      <th>Batch</th>
                                      <th>Nomor Seri Hasil Grouping</th>
                                      <th>Nama Produk Hasil</th>
                                      <th>SKU</th>
                                      <th className="text-center">Satuan</th>
                                      <th>Target Hasil</th>
                                      <th className="text-center">Status</th>
                                      <th>Komponen SN</th>
                                      <th className="text-center" style={{ width: 96 }}>Aksi</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(sessionRow.batches && sessionRow.batches.length > 0
                                      ? sessionRow.batches
                                      : [item]
                                    ).map((batch, bIdx) => {
                                      const bKey = `${sessionRow.id}-${batch.id || bIdx}`;
                                      const isBatchExpanded = expandedBatchIds.has(bKey);
                                      const row = getGroupingDisplayRow(batch);
                                      const bSerials = Array.isArray(batch.serials)
                                        ? batch.serials
                                        : (Array.isArray(batch.memberSerials)
                                          ? batch.memberSerials
                                          : (Array.isArray(batch.memberSerialNumbers)
                                            ? batch.memberSerialNumbers.map((sn) => ({ serialNumber: sn }))
                                            : []));
                                      const snCount = bSerials.length || batch.memberSerialIds?.length || batch.totalBaseQtyPcs || 0;
                                      const bStatus = batch.status || sessionRow.status || 'pending';
                                      const canUngroupBatch = (bStatus === 'completed' || bStatus === 'active');

                                      return (
                                        <React.Fragment key={bKey}>
                                          <tr
                                            className="sg-row-clickable sg-nested-batch-row"
                                            onClick={() => setSelectedDetailId(row.id)}
                                            tabIndex={0}
                                            role="button"
                                            onKeyDown={(e) => {
                                              if (e.target !== e.currentTarget) return;
                                              if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                setSelectedDetailId(row.id);
                                              }
                                            }}
                                          >
                                            <td className="font-semibold">{batch.name || `Batch ${bIdx + 1}`}</td>
                                            <td>
                                              <span className="sg-sn-badge mono font-semibold" title={row.resultSerialNumber || undefined}>
                                                {row.resultSerialNumber || batch.groupSerialNumber || batch.candidateSerialNumber || '—'}
                                              </span>
                                            </td>
                                            <td>
                                              <span className="prod-name font-semibold" title={row.resultProductName || undefined}>
                                                {row.resultProductName || batch.targetProductName || '—'}
                                              </span>
                                            </td>
                                            <td>
                                              <span className="mono text-muted sg-sku-text" title={row.resultProductSku || undefined}>
                                                {row.resultProductSku || batch.targetProductSku || '—'}
                                              </span>
                                            </td>
                                            <td className="text-center">
                                              <span className="unit-tag">{row.unit || batch.targetUnit || '—'}</span>
                                            </td>
                                            <td>
                                              <span className="sg-qty-tag">
                                                {batch.targetQty ?? batch.previewData?.targetQty ?? 1} {row.unit || batch.targetUnit || 'pcs'}
                                              </span>
                                            </td>
                                            <td className="text-center">
                                              {renderStatusBadge(bStatus)}
                                            </td>
                                            <td>
                                              <button
                                                type="button"
                                                className="sg-btn-toggle-sn"
                                                aria-expanded={isBatchExpanded}
                                                onClick={(e) => toggleExpandBatch(bKey, e)}
                                                title="Buka rincian nomor seri komponen batch ini"
                                              >
                                                <Package size={13} />
                                                <span>Komponen ({snCount} SN)</span>
                                                {isBatchExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                              </button>
                                            </td>
                                            <td className="text-center">
                                              <div className="sg-action-buttons">
                                                <button
                                                  type="button"
                                                  className="sg-btn-icon"
                                                  title="Lihat Detail & Traceability"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedDetailId(batch.id || sessionRow.id);
                                                  }}
                                                >
                                                  <Eye size={16} />
                                                </button>
                                                {canUngroupBatch && (
                                                  <button
                                                    type="button"
                                                    className="sg-btn-icon btn-danger"
                                                    title="Bongkar Group (Reversal)"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      setSelectedUngroupData(batch);
                                                    }}
                                                  >
                                                    <RotateCcw size={16} />
                                                  </button>
                                                )}
                                              </div>
                                            </td>
                                          </tr>

                                          {/* Component SNs Nested Drawer for this specific batch */}
                                          {isBatchExpanded && (
                                            <tr className="sg-components-drawer-row">
                                              <td colSpan={9} className="sg-components-drawer-cell">
                                                <div className="sg-components-drawer-box">
                                                  <div className="sg-components-title">
                                                    <Barcode size={14} />
                                                    <span>Komponen Nomor Seri untuk {batch.name || `Batch ${bIdx + 1}`} ({bSerials.length} SN)</span>
                                                  </div>
                                                  {bSerials.length === 0 ? (
                                                    <div className="sg-empty-components">
                                                      <span>Rincian komponen serial tersimpan dapat dibuka melalui tombol Detail.</span>
                                                    </div>
                                                  ) : (
                                                    <div className="sg-components-grid">
                                                      {bSerials.map((snItem, snIdx) => {
                                                        const snVal = typeof snItem === 'string'
                                                          ? snItem
                                                          : (snItem.serialNumber || snItem.serial_number || snItem.id || '-');
                                                        const pName = typeof snItem === 'object'
                                                          ? (snItem.productName || snItem.product_name || '-')
                                                          : '-';
                                                        const pSku = typeof snItem === 'object'
                                                          ? (snItem.sku || '-')
                                                          : '-';
                                                        const unit = typeof snItem === 'object'
                                                          ? (snItem.unit || 'pcs')
                                                          : 'pcs';

                                                        return (
                                                          <div key={snItem.id || snIdx} className="sg-component-chip">
                                                            <span className="sg-comp-num font-mono">{snIdx + 1}.</span>
                                                            <div className="sg-comp-info">
                                                              <span className="sg-comp-sn font-mono">{snVal}</span>
                                                              <span className="sg-comp-product">
                                                                {pName} {pSku !== '-' ? `(${pSku})` : ''} — <em className="unit-tag">{unit}</em>
                                                              </span>
                                                            </div>
                                                          </div>
                                                        );
                                                      })}
                                                    </div>
                                                  )}
                                                </div>
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {filteredGroupings.length > itemsPerPage && (
          <div className="sg-pagination-footer">
            <span className="sg-pagination-info">
              Menampilkan {(currentPage - 1) * itemsPerPage + 1} -{' '}
              {Math.min(currentPage * itemsPerPage, filteredGroupings.length)} dari{' '}
              {filteredGroupings.length} sesi
            </span>
            <div className="sg-pagination-btns">
              <button
                type="button"
                className="sg-btn-page"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Sebelumnya
              </button>
              <span className="sg-page-indicator">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                className="sg-btn-page"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Selanjutnya
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {isMultiGroupModalOpen && (
        <SerialMultiGroupingModal
          isOpen={isMultiGroupModalOpen}
          onClose={() => setIsMultiGroupModalOpen(false)}
          onSuccess={() => {
            fetchGroupings();
          }}
          initialWarehouseId={selectedWarehouse || null}
        />
      )}

      {selectedDetailId && (
        <SerialGroupingDetailModal
          groupingId={selectedDetailId}
          isOpen={Boolean(selectedDetailId)}
          onClose={() => setSelectedDetailId(null)}
        />
      )}

      {selectedUngroupData && (
        <SerialGroupingUngroupModal
          groupingData={selectedUngroupData}
          isOpen={Boolean(selectedUngroupData)}
          onClose={() => setSelectedUngroupData(null)}
          onSuccess={() => {
            fetchGroupings();
          }}
        />
      )}
    </div>
  );
}

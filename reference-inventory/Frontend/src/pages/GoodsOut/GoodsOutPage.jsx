import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertCircle, ArrowUpFromLine, Truck, FileText, ChevronRight, X, Calendar, Info } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, countDocsForSeqReset, getWorkspaceSettings, isWorkspaceModuleEnabled } from '../../utils/api.js';
import GoodsOutList from './GoodsOutList.jsx';
import GoodsOutCreateModal from './GoodsOutCreateModal.jsx';
import GoodsOutEditModal from './GoodsOutEditModal.jsx';
import GoodsOutDetailModal from './GoodsOutDetailModal.jsx';
import GoodsOutReviewModal from './GoodsOutReviewModal.jsx';
import GoCancelModal from './GoCancelModal.jsx';
import './GoodsOutPage.css';

const formatDateYMD = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatDisplayDate = (dateVal) => {
  if (!dateVal) return '';
  const clean = String(dateVal).slice(0, 10);
  const parts = clean.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateVal;
};

const addDaysYMD = (ymdStr, days) => {
  if (!ymdStr) return '';
  const [y, m, d] = ymdStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return formatDateYMD(date);
};

const getDaysDifference = (startYMD, endYMD) => {
  if (!startYMD || !endYMD) return null;
  const [y1, m1, d1] = startYMD.split('-').map(Number);
  const [y2, m2, d2] = endYMD.split('-').map(Number);
  const diffTime = new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1);
  return Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1; // inclusive
};

const unitMultipliers = {
  pcs: 1,
  piece: 1,
  pack3: 3,
  pack6: 6,
  lusin: 12,
  dozen: 12,
  pack: 60,
  bal5: 60,
  bal10: 120,
  bal15: 180,
  bal20: 240,
  bal25: 300,
  bal: 300,
};

export default function GoodsOutPage() {
  const { t, user } = useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('all');

  // Filter tanggal & unit display
  const startDateInputRef = useRef(null);
  const endDateInputRef = useRef(null);

  const openDatePicker = (inputRef) => {
    if (inputRef && inputRef.current) {
      try {
        inputRef.current.showPicker();
      } catch (err) {
        inputRef.current.focus();
      }
    }
  };

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [qtyUnit, setQtyUnit] = useState(() => {
    try {
      return localStorage.getItem('docuflow_kpi_qty_unit') || 'pcs';
    } catch {
      return 'pcs';
    }
  });

  const handleUnitChange = (unit) => {
    setQtyUnit(unit);
    try {
      localStorage.setItem('docuflow_kpi_qty_unit', unit);
    } catch (e) {
      console.warn(e);
    }
  };

  const handleStartDateChange = (e) => {
    const val = e.target.value;
    setStartDate(val);
    if (val && endDate && val > endDate) {
      setEndDate(val);
    }
  };

  const handleEndDateChange = (e) => {
    const val = e.target.value;
    setEndDate(val);
    if (startDate && val && val < startDate) {
      setStartDate(val);
    }
  };

  const handleClearDateFilter = () => {
    setStartDate('');
    setEndDate('');
  };

  const hasDateFilter = Boolean(startDate || endDate);

  // PO Dispatch Queue States
  const [targetPo, setTargetPo] = useState(null);
  const [showPoSelector, setShowPoSelector] = useState(false);

  // --- Data fetching ---

  // Fetch Approved Purchase Orders that are ready for dispatch
  const { data: approvedPOs = [] } = useQuery({
    queryKey: ['purchase-orders-approved'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/purchase-orders?status=approved&include_items=true');
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 10000,
  });

  // Check URL query param `source_po_id`
  const sourcePoIdFromUrl = searchParams.get('source_po_id');

  const {
    data: rawDocs,
    isLoading: loadingDocs,
    isError: errorDocs,
    refetch: refetchDocs,
  } = useQuery({
    queryKey: ['goods-out'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?type=goods_out&limit=500');
      if (!res.ok) throw new Error('Failed to load goods-out');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const {
    data: rawProducts,
    isLoading: loadingProducts,
  } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: goutSettings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const contactsEnabled = user?.role?.toLowerCase() === 'super_admin' ||
    (goutSettings ? isWorkspaceModuleEnabled(goutSettings, 'contacts', user) : false);

  const { data: rawCustomers = [] } = useQuery({
    queryKey: ['contacts-customer'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/contacts?type=customer&limit=500');
      if (res.status === 403) return [];
      if (!res.ok) throw new Error('Failed to load customers');
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: contactsEnabled,
    staleTime: 60000,
  });

  const { data: rawSuppliers = [] } = useQuery({
    queryKey: ['contacts-supplier'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/contacts?type=supplier&limit=500');
      if (res.status === 403) return [];
      if (!res.ok) throw new Error('Failed to load suppliers');
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: contactsEnabled,
    staleTime: 60000,
  });

  const isLoading = loadingDocs || loadingProducts;
  const docs = rawDocs ?? [];
  const products = rawProducts ?? [];

  // Effect: handle source_po_id URL param (must be after `docs` is declared)
  useEffect(() => {
    if (sourcePoIdFromUrl) {
      // First check if an existing draft already exists for this PO
      const existingDraft = (docs || []).find(
        (d) =>
          (d.status === 'draft' || d.status === 'processing') &&
          (d.metadata?.source_po_id === sourcePoIdFromUrl || d.metadata?.sourcePoId === sourcePoIdFromUrl)
      );
      if (existingDraft) {
        setEditTarget(existingDraft);
        return;
      }

      // Find in approvedPOs or fetch direct
      const found = approvedPOs.find((p) => p.id === sourcePoIdFromUrl);
      if (found) {
        setTargetPo(found);
        setShowCreate(true);
      } else {
        api.get(`/api/workspace/purchase-orders/${sourcePoIdFromUrl}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((json) => {
            if (json?.data) {
              setTargetPo(json.data);
              setShowCreate(true);
            }
          })
          .catch((e) => console.warn('Failed to load source PO from URL:', e));
      }
    }
  }, [sourcePoIdFromUrl, approvedPOs, docs]);

  // --- Tab Counts ---
  const tabCounts = useMemo(() => ({
    all: docs.length,
    processing: docs.filter((d) => d.status === 'processing' || d.status === 'draft').length,
    completed: docs.filter((d) => d.status === 'completed').length,
    cancelled: docs.filter((d) => d.status === 'cancelled').length,
  }), [docs]);

  // --- Filtered docs ---
  const filteredDocs = useMemo(() => {
    let list = docs;
    if (activeTab === 'processing') {
      list = docs.filter((d) => d.status === 'processing' || d.status === 'draft');
    } else if (activeTab === 'completed') {
      list = docs.filter((d) => d.status === 'completed');
    } else if (activeTab === 'cancelled') {
      list = docs.filter((d) => d.status === 'cancelled');
    }

    // Filter Rentang Tanggal (Maks 30 hari)
    if (startDate) {
      list = list.filter((d) => {
        const docDate = (d.issue_date || d.issueDate || d.created_at || '').slice(0, 10);
        return docDate >= startDate;
      });
    }
    if (endDate) {
      list = list.filter((d) => {
        const docDate = (d.issue_date || d.issueDate || d.created_at || '').slice(0, 10);
        return docDate <= endDate;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.document_number?.toLowerCase().includes(q) ||
          d.contact_name?.toLowerCase().includes(q) ||
          d.notes?.toLowerCase().includes(q)
      );
    }

    // Sort strictly from newest date to oldest by issue_date (tanggal transaksi dokumen)
    return [...list].sort((a, b) => {
      const dateA = (a.issue_date || a.issueDate || a.created_at || '').slice(0, 10);
      const dateB = (b.issue_date || b.issueDate || b.created_at || '').slice(0, 10);
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      const numA = a.document_number || '';
      const numB = b.document_number || '';
      if (numA !== numB) {
        return numB.localeCompare(numA, undefined, { numeric: true });
      }
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }, [docs, activeTab, startDate, endDate, search]);

  const calculateDocPcs = (doc) => {
    const items = (doc?.items && doc.items.length > 0) ? doc.items : (doc?.metadata?.items ?? []);
    return items.reduce((s, it) => {
      if (it.metadata?.baseQuantity !== undefined && it.metadata?.baseQuantity !== null) {
        return s + Number(it.metadata.baseQuantity);
      }
      const rawQty = it.metadata?.qtyInput ?? it.quantity ?? 1;
      const unit = it.metadata?.qtyUnit || it.unit || 'pcs';
      const mult = unitMultipliers[unit] || 1;
      return s + (Number(rawQty) * mult);
    }, 0);
  };

  // --- KPI calculations ---
  const kpi = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const todayCount = docs.filter(
      (d) => (d.issue_date || d.issueDate || '').slice(0, 10) === today
    ).length;

    const monthCount = docs.filter(
      (d) => (d.issue_date || d.issueDate || '').slice(0, 7) === thisMonth
    ).length;

    const pendingCount = docs.filter(
      (d) => d.status === 'draft' || d.status === 'processing'
    ).length;

    const allTimeTotalQty = docs.reduce((sum, d) => sum + calculateDocPcs(d), 0);

    let dateFilteredDocs = docs;
    if (startDate) {
      dateFilteredDocs = dateFilteredDocs.filter((d) => {
        const docDate = (d.issue_date || d.issueDate || d.created_at || '').slice(0, 10);
        return docDate >= startDate;
      });
    }
    if (endDate) {
      dateFilteredDocs = dateFilteredDocs.filter((d) => {
        const docDate = (d.issue_date || d.issueDate || d.created_at || '').slice(0, 10);
        return docDate <= endDate;
      });
    }

    const filteredDateTotalQty = dateFilteredDocs.reduce((sum, d) => sum + calculateDocPcs(d), 0);

    return { todayCount, monthCount, pendingCount, allTimeTotalQty, filteredDateTotalQty };
  }, [docs, startDate, endDate]);

  // --- Handlers ---

  const handleCreateSuccess = (newDoc) => {
    // Optimistically insert at the top
    queryClient.setQueryData(['goods-out'], (prev) =>
      prev ? [newDoc, ...prev] : [newDoc]
    );
    // Invalidate products and serials to force immediate refetch
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['product-serials'] });
    setShowCreate(false);
    setActiveTab('processing');
    setSelectedDoc(newDoc);
  };

  const handleCancelConfirm = async (doc, reason) => {
    await api.patch(`/api/workspace/documents/${doc.id}`, {
      documentType: doc.document_type || 'goods_out',
      documentNumber: doc.document_number,
      contactId: doc.contact_id,
      contactName: doc.contact_name,
      status: 'cancelled',
      issueDate: doc.issue_date,
      notes: [doc.notes, `[Cancelled] ${reason}`].filter(Boolean).join('\n'),
      subtotal: doc.subtotal || 0,
      discount: doc.discount || 0,
      tax: doc.tax || 0,
      total: doc.total || 0,
      metadata: doc.metadata || {},
    });
    queryClient.setQueryData(['goods-out'], (prev) =>
      (prev ?? []).map((d) => d.id === doc.id ? { ...d, status: 'cancelled' } : d)
    );
    setCancelTarget(null);
  };

  const existingDocsThisMonth = useMemo(() => {
    const rules = goutSettings?.numbering?.rules || (Array.isArray(goutSettings?.numbering) ? goutSettings.numbering : null);
    const rule = rules?.find((r) => r.type === 'goods_out');
    return countDocsForSeqReset(docs, rule);
  }, [docs, goutSettings]);

  return (
    <div className="goods-out-page">
      {/* Page header */}
      <div className="goods-out-page__header">
        <div>
          <h1 className="goods-out-page__title">{t('goodsOut.title')}</h1>
          <p className="goods-out-page__subtitle">
            {t('goodsOut.subtitle', { count: filteredDocs.length })}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {approvedPOs.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-md interactive"
              onClick={() => setShowPoSelector(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <Truck size={16} />
              <span>Keluarkan dari PO</span>
              <span
                style={{
                  background: 'var(--color-interactive)',
                  color: 'var(--color-text-inverse)',
                  borderRadius: 'var(--radius-full)',
                  padding: '1px 8px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                }}
              >
                {approvedPOs.length}
              </span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-md interactive"
            onClick={() => {
              setTargetPo(null);
              setShowCreate(true);
            }}
            disabled={isLoading}
          >
            <Plus size={16} />
            <span>{t('goodsOut.createBtn')}</span>
          </button>
        </div>
      </div>

      {/* KPI row */}
      {!isLoading && !errorDocs && (
        <div className="goods-out-page__kpi-row">
          <div className="goods-out-page__kpi-card">
            <span className="goods-out-page__kpi-label">{t('goodsOut.kpi.today')}</span>
            <span className="goods-out-page__kpi-value">{kpi.todayCount}</span>
          </div>
          <div className="goods-out-page__kpi-card">
            <span className="goods-out-page__kpi-label">{t('goodsOut.kpi.thisMonth')}</span>
            <span className="goods-out-page__kpi-value">{kpi.monthCount}</span>
          </div>
          <div className="goods-out-page__kpi-card goods-out-page__kpi-card--qty">
            <div className="kpi-card__header-flex">
              <span className="goods-out-page__kpi-label">
                {hasDateFilter ? 'Total Qty Out (Periode)' : 'Total Qty Out (Keseluruhan)'}
              </span>
              <div className="kpi-unit-slider" title="Pilih satuan tampilan: Pcs atau Lusin">
                <button
                  type="button"
                  className={`kpi-unit-slider__btn ${qtyUnit === 'pcs' ? 'active' : ''}`}
                  onClick={() => handleUnitChange('pcs')}
                >
                  Pcs
                </button>
                <button
                  type="button"
                  className={`kpi-unit-slider__btn ${qtyUnit === 'lusin' ? 'active' : ''}`}
                  onClick={() => handleUnitChange('lusin')}
                >
                  Lusin
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
              <span className="goods-out-page__kpi-value goods-out-page__kpi-value--accent">
                {qtyUnit === 'pcs'
                  ? (hasDateFilter ? kpi.filteredDateTotalQty : kpi.allTimeTotalQty).toLocaleString('id-ID')
                  : ((hasDateFilter ? kpi.filteredDateTotalQty : kpi.allTimeTotalQty) / 12).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}
              </span>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-info)' }}>
                {qtyUnit === 'pcs' ? 'pcs' : 'lusin'}
              </span>
            </div>

            <div className="kpi-card__subtext">
              {qtyUnit === 'pcs' ? (
                <span>
                  ≈ {((hasDateFilter ? kpi.filteredDateTotalQty : kpi.allTimeTotalQty) / 12).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} lusin
                </span>
              ) : (
                <span>
                  ≈ {(hasDateFilter ? kpi.filteredDateTotalQty : kpi.allTimeTotalQty).toLocaleString('id-ID')} pcs
                </span>
              )}
              {hasDateFilter ? (
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '10px', marginTop: '2px' }}>
                  Total semua dokumen: {qtyUnit === 'pcs' ? `${kpi.allTimeTotalQty.toLocaleString('id-ID')} pcs` : `${(kpi.allTimeTotalQty / 12).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} lusin`}
                </div>
              ) : (
                <span style={{ marginLeft: '4px', opacity: 0.85 }}>(Akumulasi seluruh dokumen)</span>
              )}
            </div>
          </div>
          <div className="goods-out-page__kpi-card">
            <span className="goods-out-page__kpi-label">{t('goodsOut.kpi.pending')}</span>
            <span className={`goods-out-page__kpi-value ${kpi.pendingCount > 0 ? 'goods-out-page__kpi-value--warning' : ''}`}>
              {kpi.pendingCount}
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      {!isLoading && !errorDocs && docs.length > 0 && (
        <div className="goods-out-page__tabs">
          {[
            { key: 'all', label: 'Semua' },
            { key: 'processing', label: t('goodsOut.kpi.pending') },
            { key: 'completed', label: t('goodsOut.status.completed') },
            { key: 'cancelled', label: t('goodsOut.status.cancelled') },
          ].map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`goods-out-page__tab${activeTab === key ? ' goods-out-page__tab--active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              {label}
              <span className="goods-out-page__tab-count">{tabCounts[key] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search & Date Filter toolbar */}
      {!isLoading && !errorDocs && docs.length > 0 && (
        <div className="goods-out-page__toolbar">
          <div className="goods-out-page__search-wrap">
            <input
              type="text"
              className="input goods-out-page__search"
              placeholder={t('goodsOut.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="goods-page__date-filter-container">
            <div className="goods-page__date-filter">
              <Calendar
                size={15}
                className="goods-page__date-icon"
                onClick={() => openDatePicker(startDateInputRef)}
                title="Pilih tanggal"
              />
              <div
                className="goods-page__date-field"
                onClick={() => openDatePicker(startDateInputRef)}
              >
                <span className="goods-page__date-label goods-page__date-field-label">Dari:</span>
                <div className="goods-page__date-picker-wrapper">
                  <span className={`goods-page__date-display ${!startDate ? 'is-placeholder' : ''}`}>
                    {formatDisplayDate(startDate) || 'dd/mm/yyyy'}
                  </span>
                  <input
                    ref={startDateInputRef}
                    type="date"
                    className="goods-page__date-input"
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
              <span className="goods-page__date-separator">—</span>
              <div
                className="goods-page__date-field"
                onClick={() => openDatePicker(endDateInputRef)}
              >
                <span className="goods-page__date-label goods-page__date-field-label">Sampai:</span>
                <div className="goods-page__date-picker-wrapper">
                  <span className={`goods-page__date-display ${!endDate ? 'is-placeholder' : ''}`}>
                    {formatDisplayDate(endDate) || 'dd/mm/yyyy'}
                  </span>
                  <input
                    ref={endDateInputRef}
                    type="date"
                    className="goods-page__date-input"
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
                  className="goods-page__date-clear-btn"
                  onClick={handleClearDateFilter}
                  title="Reset filter tanggal"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      {isLoading ? (
        <GoodsOutSkeleton />
      ) : errorDocs ? (
        <div className="goods-out-page__error-state">
          <AlertCircle size={40} className="goods-out-page__error-icon" />
          <h2 className="goods-out-page__state-title">{t('goodsOut.errorTitle')}</h2>
          <button
            type="button"
            className="btn btn-secondary interactive"
            onClick={refetchDocs}
          >
            {t('goodsOut.retry')}
          </button>
        </div>
      ) : filteredDocs.length === 0 ? (
        <div className="goods-out-page__empty-state">
          <div className="goods-out-page__empty-icon-wrap">
            <ArrowUpFromLine size={36} />
          </div>
          <h2 className="goods-out-page__state-title">
            {search.trim() || activeTab !== 'all' ? 'Tidak ada catatan yang sesuai' : t('goodsOut.emptyTitle')}
          </h2>
          {!search.trim() && activeTab === 'all' && (
            <>
              <p className="goods-out-page__state-sub">{t('goodsOut.emptySub')}</p>
              <button
                type="button"
                className="btn btn-primary interactive"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={16} />
                <span>{t('goodsOut.createBtn')}</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <GoodsOutList docs={filteredDocs} onSelect={setSelectedDoc} />
      )}

      {/* Create modal */}
      {showCreate && (
        <GoodsOutCreateModal
          sourcePo={targetPo}
          onClose={() => {
            setShowCreate(false);
            setTargetPo(null);
            if (sourcePoIdFromUrl) {
              searchParams.delete('source_po_id');
              setSearchParams(searchParams, { replace: true });
            }
          }}
          onSuccess={(doc) => {
            handleCreateSuccess(doc);
            setTargetPo(null);
            if (sourcePoIdFromUrl) {
              searchParams.delete('source_po_id');
              setSearchParams(searchParams, { replace: true });
            }
            queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });
            queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
          }}
          products={products}
          customers={rawCustomers}
          suppliers={rawSuppliers}
          contactsEnabled={contactsEnabled}
          existingDocsThisMonth={existingDocsThisMonth}
          docs={docs}
        />
      )}

      {/* PO Dispatch Queue Modal */}
      {showPoSelector && (
        <div className="go-modal-overlay" onClick={() => setShowPoSelector(false)}>
          <div
            className="go-modal"
            style={{ maxWidth: '780px', height: 'auto', maxHeight: '88dvh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="go-modal__header">
              <div>
                <h2 className="go-modal__title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Truck size={20} style={{ color: 'var(--color-interactive)' }} />
                  <span>Pilih Purchase Order yang Siap Dikeluarkan</span>
                </h2>
                <p className="go-modal__subtitle">
                  Daftar PO yang telah disetujui (ACC) oleh Owner dan siap dikeluarkan oleh tim gudang
                </p>
              </div>
              <button
                type="button"
                className="go-modal__close-btn"
                onClick={() => setShowPoSelector(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="go-modal__body" style={{ padding: 'var(--space-4) var(--space-6)' }}>
              {approvedPOs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--color-text-muted)' }}>
                  <p>Tidak ada Purchase Order yang menunggu pengeluaran saat ini.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {approvedPOs.map((po) => {
                    const unitMap = {
                      pcs: 'Pcs',
                      piece: 'Pcs',
                      lusin: 'Lusin',
                      dozen: 'Lusin',
                      pack: 'Pack (5 Lusin)',
                      bal10: 'Bal (10 Lusin)',
                      bal15: 'Bal (15 Lusin)',
                      bal20: 'Bal (20 Lusin)',
                      bal25: 'Bal (25 Lusin)',
                      bal: 'Bal (25 Lusin)',
                    };

                    const parseItemDetails = (it) => {
                      let cleanSku = String(it.sku || '').trim();
                      let unit = 'lusin';
                      if (cleanSku.includes('|')) {
                        const parts = cleanSku.split('|');
                        cleanSku = parts[0].trim();
                        unit = parts[1].trim();
                      }
                      const isNonCat = cleanSku === 'NON-SKU' || !cleanSku;
                      return {
                        name: it.item_name,
                        sku: isNonCat ? null : cleanSku,
                        isNonCatalog: isNonCat,
                        qty: it.qty,
                        unit: unitMap[unit] || unit,
                      };
                    };

                    const items = po.items || [];
                    const existingDraft = (docs || []).find(
                      (d) =>
                        (d.status === 'draft' || d.status === 'processing') &&
                        (d.metadata?.source_po_id === po.id || d.metadata?.sourcePoId === po.id)
                    );

                    return (
                      <div
                        key={po.id}
                        className="interactive"
                        onClick={() => {
                          setShowPoSelector(false);
                          if (existingDraft) {
                            setEditTarget(existingDraft);
                          } else {
                            setTargetPo(po);
                            setShowCreate(true);
                          }
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          padding: '16px 18px',
                          background: 'var(--color-surface)',
                          border: existingDraft ? '1.5px solid var(--color-interactive)' : '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-lg)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          boxShadow: 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
                        }}
                      >
                        {/* Header: PO Number, Status, Customer, Date, Action */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: '800', fontSize: '15px', color: 'var(--color-text-primary)' }}>
                                {po.po_number}
                              </span>
                              <span className="doc-chip doc-chip--paid" style={{ fontSize: '11px', padding: '2px 8px' }}>
                                Approved
                              </span>
                              {existingDraft && (
                                <span
                                  className="doc-chip"
                                  style={{
                                    fontSize: '11px',
                                    padding: '2px 8px',
                                    background: 'var(--color-interactive-subtle, rgba(59, 130, 246, 0.1))',
                                    color: 'var(--color-interactive)',
                                    fontWeight: 'bold',
                                    border: '1px solid var(--color-interactive)',
                                  }}
                                >
                                  Draft Aktif: {existingDraft.document_number}
                                </span>
                              )}
                              {po.po_date && (
                                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                                  · {new Date(po.po_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' })}
                                </span>
                              )}
                            </div>

                            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                              <span>Pelanggan / Vendor: <strong style={{ color: 'var(--color-text-primary)' }}>{po.vendor_name}</strong></span>
                            </div>

                            {po.notes && (
                              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                Catatan: {po.notes}
                              </p>
                            )}
                          </div>

                          <button
                            type="button"
                            className="btn btn-primary btn-sm interactive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowPoSelector(false);
                              if (existingDraft) {
                                setEditTarget(existingDraft);
                              } else {
                                setTargetPo(po);
                                setShowCreate(true);
                              }
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '6px 14px',
                              borderRadius: 'var(--radius-md)',
                            }}
                          >
                            <Truck size={14} />
                            <span>{existingDraft ? `Lanjutkan (${existingDraft.document_number})` : 'Keluarkan Barang'}</span>
                            <ChevronRight size={14} />
                          </button>
                        </div>

                        {/* Rincian Barang yang Dipesan */}
                        <div
                          style={{
                            background: 'var(--color-surface-alt)',
                            borderRadius: 'var(--radius-md)',
                            padding: '10px 14px',
                            border: '1px solid var(--color-border)',
                          }}
                        >
                          <div style={{ fontSize: '11px', fontWeight: '700', color: 'var(--color-text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Rincian Barang yang Dipesan ({items.length} Jenis Item):
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {items.map((it, idx) => {
                              const itemInfo = parseItemDetails(it);
                              return (
                                <div
                                  key={idx}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    fontSize: '13px',
                                    padding: '4px 0',
                                    borderBottom: idx < (items.length - 1) ? '1px dashed var(--color-border)' : 'none',
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                    <span style={{ color: 'var(--color-text-muted)', fontSize: '12px', width: '16px' }}>
                                      {idx + 1}.
                                    </span>
                                    <span style={{ fontWeight: '600', color: 'var(--color-text-primary)' }}>
                                      {itemInfo.name}
                                    </span>
                                    {itemInfo.sku && (
                                      <span
                                        style={{
                                          fontSize: '11px',
                                          fontFamily: 'monospace',
                                          color: 'var(--color-text-secondary)',
                                          background: 'var(--color-surface)',
                                          padding: '1px 6px',
                                          borderRadius: 'var(--radius-xs)',
                                          border: '1px solid var(--color-border)',
                                        }}
                                      >
                                        {itemInfo.sku}
                                      </span>
                                    )}
                                    {itemInfo.isNonCatalog && (
                                      <span
                                        style={{
                                          fontSize: '10px',
                                          fontWeight: '700',
                                          padding: '1px 6px',
                                          borderRadius: 'var(--radius-xs)',
                                          background: 'var(--color-warning-surface)',
                                          color: 'var(--color-warning)',
                                          border: '1px solid var(--color-warning)',
                                        }}
                                      >
                                        Non-Katalog
                                      </span>
                                    )}
                                  </div>

                                  <div style={{ fontWeight: '700', color: 'var(--color-interactive)', fontSize: '13px', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                                    {itemInfo.qty} {itemInfo.unit}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detail or Review modal depending on document status */}
      {selectedDoc && (selectedDoc.status === 'processing' || selectedDoc.status === 'draft') ? (
        <GoodsOutReviewModal
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onComplete={(completedDoc) => {
            setSelectedDoc(completedDoc);
            queryClient.setQueryData(['goods-out'], (current) =>
              Array.isArray(current)
                ? current.map((item) => item.id === completedDoc.id ? completedDoc : item)
                : [completedDoc]
            );
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['product-serials'] });
          }}
          onCancel={(doc) => {
            setCancelTarget(doc);
            setSelectedDoc(null);
          }}
          onEdit={(doc) => {
            setSelectedDoc(null);
            setEditTarget(doc);
          }}
        />
      ) : (
        selectedDoc && (
          <GoodsOutDetailModal
            doc={selectedDoc}
            onClose={() => setSelectedDoc(null)}
            onEdit={(doc) => {
              setSelectedDoc(null);
              setEditTarget(doc);
            }}
          />
        )
      )}

      {/* Edit modal for pending documents */}
      {editTarget && (
        <GoodsOutEditModal
          doc={editTarget}
          sourcePo={targetPo}
          products={products}
          customers={rawCustomers}
          suppliers={rawSuppliers}
          contactsEnabled={contactsEnabled}
          onClose={() => {
            setEditTarget(null);
            setTargetPo(null);
          }}
          onSuccess={(updatedDoc) => {
            setEditTarget(null);
            setTargetPo(null);
            setSelectedDoc(updatedDoc);
            queryClient.invalidateQueries({ queryKey: ['goods-out'] });
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['product-serials'] });
            queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
            queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });
          }}
        />
      )}

      {/* Cancel modal */}
      {cancelTarget && (
        <GoCancelModal
          doc={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onConfirm={handleCancelConfirm}
        />
      )}
    </div>
  );
}

/* ---- Skeleton loader ---- */
function GoodsOutSkeleton() {
  return (
    <div className="goods-out-skeleton">
      {/* KPI skeleton */}
      <div className="goods-out-skeleton__kpi-row">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="goods-out-skeleton__kpi-card">
            <div className="skeleton-block" style={{ width: 60, height: 11 }} />
            <div className="skeleton-block" style={{ width: 40, height: 22, marginTop: 6 }} />
          </div>
        ))}
      </div>
      {/* List rows skeleton */}
      <div className="goods-out-skeleton__list">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="goods-out-skeleton__row">
            <div className="skeleton-block" style={{ width: '35%', height: 13 }} />
            <div className="skeleton-block" style={{ width: '15%', height: 13 }} />
            <div className="skeleton-block" style={{ width: '25%', height: 13 }} />
            <div className="skeleton-block" style={{ width: '10%', height: 13 }} />
            <div className="skeleton-block" style={{ width: 60, height: 22, borderRadius: 99 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

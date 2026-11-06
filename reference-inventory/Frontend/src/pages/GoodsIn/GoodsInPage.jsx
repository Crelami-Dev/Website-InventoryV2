import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertCircle, ArrowDownToLine, Sparkles, Trash2, FileText, Calendar, Check, ExternalLink, Info, X } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, countDocsForSeqReset, getWorkspaceSettings, isWorkspaceModuleEnabled } from '../../utils/api.js';
import GoodsInList         from './GoodsInList.jsx';
import GoodsInCreateModal  from './GoodsInCreateModal.jsx';
import GoodsInDetailModal  from './GoodsInDetailModal.jsx';
import GoodsInReviewModal  from './GoodsInReviewModal.jsx';
import GiCancelModal       from './GiCancelModal.jsx';
import './GoodsInPage.css';

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

export default function GoodsInPage() {
  const { t, user } = useApp();
  const queryClient = useQueryClient();

  const [showCreate,    setShowCreate]    = useState(false);
  const [selectedDoc,   setSelectedDoc]   = useState(null);
  const [editDoc,       setEditDoc]       = useState(null);
  const [cancelTarget,  setCancelTarget]  = useState(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [serialFilter, setSerialFilter] = useState('all');
  const [aiImportData, setAiImportData] = useState(null);
  const [showAiDraftsModal, setShowAiDraftsModal] = useState(false);

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

  // Persistent AI Drafts storage
  const [savedAiDrafts, setSavedAiDrafts] = useState(() => {
    try {
      const raw = localStorage.getItem('docuflow_saved_ai_goods_in');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const saveAiDraft = (data) => {
    if (!data) return;
    setSavedAiDrafts((prev) => {
      // Avoid duplicate exact timestamps
      const newDraft = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        data,
      };
      const updated = [newDraft, ...prev.slice(0, 9)];
      try {
        localStorage.setItem('docuflow_saved_ai_goods_in', JSON.stringify(updated));
      } catch (err) {
        console.error(err);
      }
      return updated;
    });
  };

  const removeAiDraft = (id) => {
    setSavedAiDrafts((prev) => {
      const updated = prev.filter((d) => d.id !== id);
      try {
        localStorage.setItem('docuflow_saved_ai_goods_in', JSON.stringify(updated));
      } catch (err) {
        console.error(err);
      }
      return updated;
    });
  };

  // Check for pending AI import on mount or on custom event
  useEffect(() => {
    const checkPendingImport = () => {
      try {
        const raw = sessionStorage.getItem('docuflow_ai_pending_import');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.type === 'goods_in' && parsed.data) {
            sessionStorage.removeItem('docuflow_ai_pending_import');
            saveAiDraft(parsed.data);
            setAiImportData(parsed.data);
            setShowCreate(true);
          }
        }
      } catch (err) {
        console.error(err);
      }
    };

    checkPendingImport();

    const handleAiEvent = (e) => {
      if (e.detail?.type === 'goods_in' && e.detail.data) {
        saveAiDraft(e.detail.data);
        setAiImportData(e.detail.data);
        setShowCreate(true);
      }
    };

    window.addEventListener('docuflow_ai_import_event', handleAiEvent);
    return () => window.removeEventListener('docuflow_ai_import_event', handleAiEvent);
  }, []);

  // ── Data fetching ─────────────────────────────────────────
  const {
    data: rawDocs, isLoading: loadingDocs,
    isError: errorDocs, refetch: refetchDocs,
  } = useQuery({
    queryKey: ['goods-in'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?type=goods_in&limit=500');
      if (!res.ok) throw new Error('Failed to load goods-in');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const { data: rawProducts, isLoading: loadingProducts } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: ginSettings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const contactsEnabled = user?.role?.toLowerCase() === 'super_admin' ||
    (ginSettings ? isWorkspaceModuleEnabled(ginSettings, 'contacts', user) : false);

  const { data: rawSuppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/contacts?type=supplier&limit=500');
      if (res.status === 403) return [];
      if (!res.ok) throw new Error('Failed to load suppliers');
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: contactsEnabled,
    staleTime: 30000,
  });

  const { data: rawSerialCounts = [] } = useQuery({
    queryKey: ['product-serials', 'goods-in-counts'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/product-serial-counts/goods-in');
      if (!res.ok) throw new Error('Failed to load serial counts');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const serialCountByDocId = useMemo(() => {
    const map = {};
    (rawSerialCounts || []).forEach((row) => {
      const docId = row.document_id ?? row.documentId;
      if (docId) map[docId] = Number(row.serial_count ?? row.serialCount ?? 0);
    });
    return map;
  }, [rawSerialCounts]);

  const isLoading = loadingDocs || loadingProducts;
  const docs      = rawDocs   ?? [];
  const products  = rawProducts ?? [];
  const suppliers = rawSuppliers ?? [];

  // ── Tab Counts ─────────────────────────────────────────────
  const tabCounts = useMemo(() => ({
    all: docs.length,
    processing: docs.filter((d) => d.status === 'processing' || d.status === 'draft').length,
    completed: docs.filter((d) => d.status === 'completed').length,
    no_serial: docs.filter((d) => d.status === 'completed' && (!serialCountByDocId[d.id] || serialCountByDocId[d.id] === 0)).length,
    cancelled: docs.filter((d) => d.status === 'cancelled').length,
  }), [docs, serialCountByDocId]);

  // ── Filtered docs ──────────────────────────────────────────
  const filteredDocs = useMemo(() => {
    let list = docs;
    if (activeTab === 'processing') {
      list = docs.filter((d) => d.status === 'processing' || d.status === 'draft');
    } else if (activeTab === 'completed') {
      list = docs.filter((d) => d.status === 'completed');
    } else if (activeTab === 'no_serial') {
      list = docs.filter((d) => d.status === 'completed' && (!serialCountByDocId[d.id] || serialCountByDocId[d.id] === 0));
    } else if (activeTab === 'cancelled') {
      list = docs.filter((d) => d.status === 'cancelled');
    }

    if (serialFilter === 'no_serial') {
      list = list.filter((d) => d.status === 'completed' && (!serialCountByDocId[d.id] || serialCountByDocId[d.id] === 0));
    } else if (serialFilter === 'has_serial') {
      list = list.filter((d) => (serialCountByDocId[d.id] || 0) > 0);
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
  }, [docs, activeTab, serialFilter, serialCountByDocId, startDate, endDate, search]);

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

  // ── KPI ───────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const today     = new Date().toISOString().slice(0, 10);
    const thisMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

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

    return {
      todayCount:   docs.filter((d) => (d.issue_date || d.issueDate || '').slice(0, 10) === today).length,
      monthCount:   docs.filter((d) => (d.issue_date || d.issueDate || '').slice(0, 7) === thisMonth).length,
      pendingCount: docs.filter((d) => d.status === 'processing' || d.status === 'draft').length,
      allTimeTotalQty,
      filteredDateTotalQty,
    };
  }, [docs, startDate, endDate]);

  const existingDocsThisMonth = useMemo(() => {
    const rules = ginSettings?.numbering?.rules || (Array.isArray(ginSettings?.numbering) ? ginSettings.numbering : null);
    const rule = rules?.find((r) => r.type === 'goods_in');
    return countDocsForSeqReset(docs, rule);
  }, [docs, ginSettings]);

  // ── Handlers ──────────────────────────────────────────────

  const handleCreateSuccess = (newDoc) => {
    queryClient.setQueryData(['goods-in'], (prev) =>
      prev ? [newDoc, ...prev] : [newDoc]
    );
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
    setShowCreate(false);
  };

  const handleCancelConfirm = async (doc, reason) => {
    await api.patch(`/api/workspace/documents/${doc.id}`, {
      documentType: doc.document_type || 'goods_in',
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
    queryClient.setQueryData(['goods-in'], (prev) =>
      (prev ?? []).map((d) => d.id === doc.id ? { ...d, status: 'cancelled' } : d)
    );
    setCancelTarget(null);
  };

  const handleEditSuccess = (updatedDoc) => {
    queryClient.setQueryData(['goods-in'], (prev) =>
      (prev ?? []).map((d) => d.id === updatedDoc.id ? updatedDoc : d)
    );
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    setEditDoc(null);
    setSelectedDoc(updatedDoc);
  };

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="goods-in-page">
      {/* Page header */}
      <div className="goods-in-page__header">
        <div>
          <h1 className="goods-in-page__title">{t('goodsIn.title')}</h1>
          <p className="goods-in-page__subtitle">
            {t('goodsIn.subtitle', { count: filteredDocs.length })}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-primary btn-md interactive"
            onClick={() => setShowCreate(true)}
            disabled={isLoading}
          >
            <Plus size={16} />
            <span>{t('goodsIn.createBtn')}</span>
          </button>
        </div>
      </div>

      {/* KPI row */}
      {!isLoading && !errorDocs && (
        <div className="goods-in-page__kpi-row">
          <div className="goods-in-page__kpi-card">
            <span className="goods-in-page__kpi-label">{t('goodsIn.kpi.today')}</span>
            <span className="goods-in-page__kpi-value">{kpi.todayCount}</span>
          </div>
          <div className="goods-in-page__kpi-card">
            <span className="goods-in-page__kpi-label">{t('goodsIn.kpi.thisMonth')}</span>
            <span className="goods-in-page__kpi-value">{kpi.monthCount}</span>
          </div>
          <div className="goods-in-page__kpi-card goods-in-page__kpi-card--qty">
            <div className="kpi-card__header-flex">
              <span className="goods-in-page__kpi-label">
                {hasDateFilter ? 'Total Qty In (Periode)' : 'Total Qty In (Keseluruhan)'}
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
              <span className="goods-in-page__kpi-value goods-in-page__kpi-value--accent">
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
          <div className="goods-in-page__kpi-card">
            <span className="goods-in-page__kpi-label">{t('goodsIn.kpi.pending')}</span>
            <span className={`goods-in-page__kpi-value ${kpi.pendingCount > 0 ? 'goods-in-page__kpi-value--warning' : ''}`}>
              {kpi.pendingCount}
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      {!isLoading && !errorDocs && docs.length > 0 && (
        <div className="goods-in-page__tabs">
          {[
            { key: 'all', label: 'Semua' },
            { key: 'processing', label: t('goodsIn.kpi.pending') },
            { key: 'completed', label: t('goodsIn.status.completed') },
            { key: 'no_serial', label: t('goodsIn.tab.noSerial') },
            { key: 'cancelled', label: t('goodsIn.status.cancelled') },
          ].map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`goods-in-page__tab${activeTab === key ? ' goods-in-page__tab--active' : ''}${key === 'no_serial' ? ' goods-in-page__tab--no-serial' : ''}`}
              onClick={() => {
                setActiveTab(key);
                if (key === 'no_serial') {
                  setSerialFilter('all');
                }
              }}
            >
              {label}
              <span className={`goods-in-page__tab-count${key === 'no_serial' && (tabCounts[key] || 0) > 0 ? ' goods-in-page__tab-count--warning' : ''}`}>
                {tabCounts[key] ?? 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Search & Filter toolbar */}
      {!isLoading && !errorDocs && docs.length > 0 && (
        <div className="goods-in-page__toolbar">
          <div className="goods-in-page__search-wrap">
            <input
              type="text"
              className="input goods-in-page__search"
              placeholder={t('goodsIn.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="goods-in-page__filter-group">
            {/* Filter Rentang Tanggal (Maksimal 30 hari) */}
            <div className="goods-page__date-filter-container">
              <div className="goods-page__date-filter">
                <Calendar
                  size={14}
                  className="goods-page__date-icon"
                  onClick={() => openDatePicker(startDateInputRef)}
                  title="Pilih tanggal"
                />
                <div
                  className="goods-page__date-field"
                  onClick={() => openDatePicker(startDateInputRef)}
                >
                  <span className="goods-page__date-label">Dari:</span>
                  <div className="goods-page__date-picker-wrapper">
                    <span className={`goods-page__date-display ${!startDate ? 'is-placeholder' : ''}`}>
                      {formatDisplayDate(startDate) || 'dd/mm/yyyy'}
                    </span>
                    <input
                      ref={startDateInputRef}
                      type="date"
                      className="goods-page__date-input"
                      value={startDate}
                      onChange={handleStartDateChange}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDatePicker(startDateInputRef);
                      }}
                      max={endDate || undefined}
                      title="Dari tanggal (dd/mm/yyyy)"
                    />
                  </div>
                </div>
                <span className="goods-page__date-separator">—</span>
                <div
                  className="goods-page__date-field"
                  onClick={() => openDatePicker(endDateInputRef)}
                >
                  <span className="goods-page__date-label">Sampai:</span>
                  <div className="goods-page__date-picker-wrapper">
                    <span className={`goods-page__date-display ${!endDate ? 'is-placeholder' : ''}`}>
                      {formatDisplayDate(endDate) || 'dd/mm/yyyy'}
                    </span>
                    <input
                      ref={endDateInputRef}
                      type="date"
                      className="goods-page__date-input"
                      value={endDate}
                      onChange={handleEndDateChange}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDatePicker(endDateInputRef);
                      }}
                      min={startDate || undefined}
                      title="Sampai tanggal (dd/mm/yyyy)"
                    />
                  </div>
                </div>
                {(startDate || endDate) && (
                  <button
                    type="button"
                    className="goods-page__date-clear-btn"
                    onClick={handleClearDateFilter}
                    title="Hapus filter tanggal"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            <select
              className="input goods-in-page__filter-select"
              value={serialFilter}
              onChange={(e) => setSerialFilter(e.target.value)}
              aria-label={t('goodsIn.filter.allSerials')}
            >
              <option value="all">{t('goodsIn.filter.allSerials')}</option>
              <option value="no_serial">{t('goodsIn.filter.noSerial')}</option>
              <option value="has_serial">{t('goodsIn.filter.hasSerial')}</option>
            </select>
          </div>
        </div>
      )}

      {/* Body */}
      {isLoading ? (
        <GoodsInSkeleton />
      ) : errorDocs ? (
        <div className="goods-in-page__error-state">
          <AlertCircle size={40} className="goods-in-page__error-icon" />
          <h2 className="goods-in-page__state-title">{t('goodsIn.errorTitle')}</h2>
          <button type="button" className="btn btn-secondary interactive" onClick={refetchDocs}>
            {t('goodsIn.retry')}
          </button>
        </div>
      ) : filteredDocs.length === 0 ? (
        <div className="goods-in-page__empty-state">
          <div className="goods-in-page__empty-icon-wrap">
            <ArrowDownToLine size={36} />
          </div>
          <h2 className="goods-in-page__state-title">
            {activeTab === 'no_serial' || serialFilter === 'no_serial'
              ? t('goodsIn.emptyNoSerial')
              : search.trim() || activeTab !== 'all' || serialFilter !== 'all'
              ? 'Tidak ada catatan yang sesuai'
              : t('goodsIn.emptyTitle')}
          </h2>
          {!search.trim() && activeTab === 'all' && serialFilter === 'all' && (
            <>
              <p className="goods-in-page__state-sub">{t('goodsIn.emptySub')}</p>
              <button
                type="button"
                className="btn btn-primary interactive"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={16} />
                <span>{t('goodsIn.createBtn')}</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <GoodsInList
          docs={filteredDocs}
          onSelect={setSelectedDoc}
          serialCountByDocId={serialCountByDocId}
        />
      )}

      {/* Create modal */}
      {showCreate && (
        <GoodsInCreateModal
          initialAiData={aiImportData}
          onClose={() => {
            setShowCreate(false);
            setAiImportData(null);
          }}
          onSuccess={(doc) => {
            handleCreateSuccess(doc);
            setAiImportData(null);
          }}
          products={products}
          suppliers={suppliers}
          contactsEnabled={contactsEnabled}
          existingDocsThisMonth={existingDocsThisMonth}
          docs={docs}
        />
      )}

      {/* Edit modal */}
      {editDoc && (
        <GoodsInCreateModal
          doc={editDoc}
          onClose={() => setEditDoc(null)}
          onSuccess={handleEditSuccess}
          products={products}
          suppliers={suppliers}
          contactsEnabled={contactsEnabled}
          existingDocsThisMonth={existingDocsThisMonth}
        />
      )}

      {/* Detail or Review modal depending on document status */}
      {selectedDoc && (selectedDoc.status === 'processing' || selectedDoc.status === 'draft') ? (
        <GoodsInReviewModal
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onEdit={(doc) => {
            setEditDoc(doc);
            setSelectedDoc(null);
          }}
          onComplete={(completedDoc) => {
            setSelectedDoc(completedDoc);
            queryClient.setQueryData(['goods-in'], (current) =>
              Array.isArray(current)
                ? current.map((item) => item.id === completedDoc.id ? completedDoc : item)
                : [completedDoc]
            );
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['product-serials'] });
            queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
          }}
          onCancel={(doc) => {
            setCancelTarget(doc);
            setSelectedDoc(null);
          }}
        />
      ) : (
        selectedDoc && (
          <GoodsInDetailModal
            doc={selectedDoc}
            onClose={() => setSelectedDoc(null)}
          />
        )
      )}

      {/* Cancel with reason */}
      {cancelTarget && (
        <GiCancelModal
          doc={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onConfirm={handleCancelConfirm}
        />
      )}

      {/* Modal Draft AI Tersimpan */}
      {showAiDraftsModal && (
        <div className="secret-ai-overlay" onClick={() => setShowAiDraftsModal(false)}>
          <div
            className="secret-ai-modal"
            style={{ maxWidth: '640px' }}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="secret-ai-modal__header">
              <div className="secret-ai-modal__title-wrap">
                <div className="secret-ai-badge">
                  <Sparkles size={14} className="secret-ai-sparkle" />
                  <span>Draft AI Tersimpan</span>
                </div>
                <h2 className="secret-ai-title">Daftar Hasil Scan Catatan AI</h2>
                <p className="secret-ai-subtitle">
                  Pilih catatan yang pernah dipindai AI untuk langsung dimasukkan ke form Barang Masuk
                </p>
              </div>
              <button
                type="button"
                className="secret-ai-close-btn"
                onClick={() => setShowAiDraftsModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="secret-ai-modal__body" style={{ maxHeight: '60vh', overflowY: 'auto', gap: '10px' }}>
              {savedAiDrafts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--color-text-muted)' }}>
                  <FileText size={36} style={{ marginBottom: '8px', opacity: 0.5 }} />
                  <p style={{ margin: 0, fontSize: '13px' }}>Belum ada draft catatan AI yang tersimpan.</p>
                </div>
              ) : (
                savedAiDrafts.map((draft, idx) => (
                  <div
                    key={draft.id || idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      gap: '12px',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '700', fontSize: '14px', color: 'var(--color-text-primary)' }}>
                          {draft.data?.vendor_name || 'Catatan Tanpa Vendor'}
                        </span>
                        <span
                          style={{
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '99px',
                            background: 'var(--color-interactive-light, rgba(99, 102, 241, 0.1))',
                            color: 'var(--color-interactive)',
                            fontWeight: '600',
                          }}
                        >
                          {draft.data?.items?.length || 0} jenis barang
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', gap: '12px' }}>
                        <span>📅 {draft.data?.date || new Date(draft.timestamp).toLocaleDateString('id-ID')}</span>
                        {draft.data?.notes && <span>📝 {draft.data.notes}</span>}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm interactive"
                        onClick={() => {
                          setAiImportData(draft.data);
                          setShowCreate(true);
                          setShowAiDraftsModal(false);
                        }}
                      >
                        <Check size={14} />
                        <span>Gunakan</span>
                      </button>
                      <button
                        type="button"
                        className="secret-ai-icon-btn"
                        title="Hapus Draft"
                        onClick={() => removeAiDraft(draft.id)}
                        style={{ color: 'var(--color-danger, #ef4444)' }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 24px',
                borderTop: '1px solid var(--color-border)',
                background: 'var(--color-surface-alt)',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm interactive"
                onClick={() => {
                  setShowAiDraftsModal(false);
                  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
                }}
              >
                <Sparkles size={14} />
                <span>+ Scan Foto Catatan Baru</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm interactive"
                onClick={() => setShowAiDraftsModal(false)}
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Skeleton ──────────────────────────────────────────────── */
function GoodsInSkeleton() {
  return (
    <div className="goods-in-skeleton">
      <div className="goods-in-skeleton__kpi-row">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="goods-in-skeleton__kpi-card">
            <div className="skeleton-block" style={{ width: 60, height: 11 }} />
            <div className="skeleton-block" style={{ width: 40, height: 22, marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className="goods-in-skeleton__list">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="goods-in-skeleton__row">
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

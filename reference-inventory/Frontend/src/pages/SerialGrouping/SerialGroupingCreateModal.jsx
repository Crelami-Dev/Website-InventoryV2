import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Search,
  Check,
  Trash2,
  Layers,
  AlertCircle,
  AlertTriangle,
  Loader2,
  PlusCircle,
  Package,
  Building2,
  FileText,
  DollarSign,
  CheckCircle2,
} from 'lucide-react';
import { api } from '../../utils/api.js';
import './SerialGroupingCreateModal.css';

const CANONICAL_UNITS = [
  { value: 'pcs', label: 'pcs (1 pcs)', multiplier: 1 },
  { value: 'lusin', label: 'lusin (12 pcs)', multiplier: 12 },
  { value: 'pack', label: 'pack (5 lusin / 60 pcs)', multiplier: 60 },
  { value: 'bal10', label: 'bal10 (10 lusin / 120 pcs)', multiplier: 120 },
  { value: 'bal15', label: 'bal15 (15 lusin / 180 pcs)', multiplier: 180 },
  { value: 'bal20', label: 'bal20 (20 lusin / 240 pcs)', multiplier: 240 },
  { value: 'bal25', label: 'bal25 (25 lusin / 300 pcs)', multiplier: 300 },
];

const formatCurrency = (val) => {
  if (val === null || val === undefined || isNaN(val)) return 'Rp 0';
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(val);
};

// Simple v4 UUID generator for idempotency key
const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export default function SerialGroupingCreateModal({
  isOpen,
  onClose,
  onSuccess,
  initialWarehouseId = null,
  initialProductId = null,
  contextProduct = null,
  initialSelectedSerials = []
}) {
  // Warehouses
  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState(
    initialWarehouseId || (initialSelectedSerials[0]?.warehouseId) || (initialSelectedSerials[0]?.warehouse_id) || ''
  );

  // Context product filter (when opened from product page)
  const [onlyContextProduct, setOnlyContextProduct] = useState(Boolean(initialProductId));

  useEffect(() => {
    if (isOpen) {
      if (initialWarehouseId) {
        setSelectedWarehouseId(initialWarehouseId);
      }
      setOnlyContextProduct(Boolean(initialProductId));
    }
  }, [isOpen, initialWarehouseId, initialProductId]);

  // Available serials from backend
  const [loadingSerials, setLoadingSerials] = useState(false);
  const [availableSerials, setAvailableSerials] = useState([]);
  const [serialSearch, setSerialSearch] = useState('');

  // Selected serials
  const [selectedSerialMap, setSelectedSerialMap] = useState({});

  // Result Product Mode
  const [isNewProduct, setIsNewProduct] = useState(false);
  const [existingProducts, setExistingProducts] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [resultProductName, setResultProductName] = useState('');
  const [resultProductSku, setResultProductSku] = useState('');

  // Target Unit and Transaction Config
  const [targetUnit, setTargetUnit] = useState('pcs');
  const [groupSerialNumber, setGroupSerialNumber] = useState('');
  const [notes, setNotes] = useState('');

  // Preview state
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const idempotencyKeyRef = useRef(generateUUID());

  // 1. Fetch Warehouses and Products
  useEffect(() => {
    if (!isOpen) return;

    // Reset idempotency key for this modal session
    idempotencyKeyRef.current = generateUUID();

    const fetchInitialData = async () => {
      try {
        const [whRes, prodRes] = await Promise.all([
          api.get('/api/workspace/warehouses'),
          api.get('/api/workspace/products?limit=2000')
        ]);

        if (whRes.ok) {
          const whJson = await whRes.json();
          const whList = whJson.data || [];
          setWarehouses(whList);
          if (!selectedWarehouseId && whList.length > 0) {
            setSelectedWarehouseId(whList[0].id);
          }
        }

        if (prodRes.ok) {
          const prodJson = await prodRes.json();
          setExistingProducts(prodJson.data || []);
        }
      } catch (err) {
        console.error('Error fetching initial grouping dropdown data:', err);
      }
    };

    fetchInitialData();
  }, [isOpen]);

  // 2. Fetch Serials when warehouse, context filter, or open state changes
  useEffect(() => {
    if (!isOpen) return;

    const fetchSerials = async () => {
      setLoadingSerials(true);
      try {
        let endpoint = `/api/workspace/product-serials/group/available?limit=2000`;
        if (selectedWarehouseId) {
          endpoint += `&warehouseId=${encodeURIComponent(selectedWarehouseId)}`;
        }
        if (onlyContextProduct && initialProductId) {
          endpoint += `&productId=${encodeURIComponent(initialProductId)}`;
        }

        const res = await api.get(endpoint);
        let rawList = [];
        if (res.ok) {
          const json = await res.json();
          rawList = json.data || [];
        } else {
          // Graceful fallback to general product-serials
          let fbEndpoint = `/api/workspace/product-serials?status=available&limit=5000`;
          if (selectedWarehouseId) {
            fbEndpoint += `&warehouse_id=${encodeURIComponent(selectedWarehouseId)}`;
          }
          const fbRes = await api.get(fbEndpoint);
          if (fbRes.ok) {
            const fbJson = await fbRes.json();
            rawList = fbJson.data || [];
          }
        }

        // Validate and enrich each serial strictly with real product data
        const enriched = rawList
          .map((s) => {
            const pId = s.product_id || s.productId;
            const prod = s.product || existingProducts.find((p) => p.id === pId);
            if (!prod) return null; // Reject orphaned serials without real product

            return {
              ...s,
              id: s.id,
              serial_number: s.serial_number || s.serialNumber,
              warehouse_id: s.warehouse_id || s.warehouseId,
              product_id: pId,
              product_name: s.product_name || s.productName || prod.name || 'Produk',
              sku: s.sku || prod.sku || '',
              unit: s.unit || prod.metadata?.unit || prod.unit || 'pcs',
              unit_cost: s.unit_cost !== undefined ? s.unit_cost : (prod.unit_cost || 0),
              product: prod,
            };
          })
          .filter(Boolean)
          .filter((s) => {
            // Must not be currently in an active group
            if (s.metadata?.isGrouped || s.metadata?.parentGroupId) return false;
            // Must not be dissolved
            if (s.metadata?.isDissolved || s.status === 'dissolved') return false;
            // Must not be already dispatched / out
            if (s.goods_out_document_id || s.goodsOutDocumentId) return false;
            // Context product filter
            if (onlyContextProduct && initialProductId && s.product_id !== initialProductId) {
              return false;
            }
            return true;
          });

        setAvailableSerials(enriched);

        // Handle initialSelectedSerials if provided
        if (initialSelectedSerials && initialSelectedSerials.length > 0) {
          const initialMap = {};
          enriched.forEach((s) => {
            const match = initialSelectedSerials.find(
              (init) => init.id === s.id || (init.serial_number && init.serial_number === s.serial_number) || (init.serialNumber && init.serialNumber === s.serial_number)
            );
            if (match) {
              initialMap[s.id] = s;
            }
          });
          setSelectedSerialMap(initialMap);
        }
      } catch (err) {
        console.error('Error loading available serials:', err);
      } finally {
        setLoadingSerials(false);
      }
    };

    fetchSerials();
  }, [isOpen, selectedWarehouseId, onlyContextProduct, initialProductId, existingProducts]);

  // Prune any selected serials if user changes warehouse to prevent mixed-warehouse grouping
  useEffect(() => {
    if (!selectedWarehouseId) return;
    setSelectedSerialMap((prev) => {
      let changed = false;
      const next = {};
      Object.entries(prev).forEach(([id, s]) => {
        const sWh = s.warehouse_id || s.warehouseId;
        if (!sWh || sWh === selectedWarehouseId) {
          next[id] = s;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [selectedWarehouseId]);

  // Generate default group SN
  useEffect(() => {
    if (isOpen && !groupSerialNumber) {
      const dateCode = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
        .format(new Date())
        .replace(/-/g, '');
      const rand = Math.floor(1000 + Math.random() * 9000);
      setGroupSerialNumber(`GRP-${dateCode}-${rand}`);
    }
  }, [isOpen, groupSerialNumber]);

  // Filter available serials for table
  const filteredSerials = useMemo(() => {
    return availableSerials.filter((s) => {
      // Filter warehouse if warehouse selected
      if (selectedWarehouseId && s.warehouse_id && s.warehouse_id !== selectedWarehouseId) {
        return false;
      }
      // Status check
      const status = (s.status || '').toLowerCase();
      if (status !== 'available' && status !== 'in_stock') {
        return false;
      }
      // Context product filter
      if (onlyContextProduct && initialProductId && s.product_id !== initialProductId) {
        return false;
      }
      // Text search
      if (serialSearch.trim()) {
        const q = serialSearch.toLowerCase();
        const sn = (s.serial_number || '').toLowerCase();
        const prod = (s.product_name || s.product?.name || '').toLowerCase();
        const sku = (s.sku || s.product?.sku || '').toLowerCase();
        return sn.includes(q) || prod.includes(q) || sku.includes(q);
      }
      return true;
    });
  }, [availableSerials, selectedWarehouseId, onlyContextProduct, initialProductId, serialSearch]);

  // Filter existing products for dropdown
  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return existingProducts;
    const q = productSearch.toLowerCase();
    return existingProducts.filter(
      (p) => (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)
    );
  }, [existingProducts, productSearch]);

  const selectedProduct = useMemo(() => {
    return existingProducts.find((p) => p.id === selectedProductId) || null;
  }, [existingProducts, selectedProductId]);

  const selectedList = useMemo(() => Object.values(selectedSerialMap), [selectedSerialMap]);

  // Handle toggling serial
  const toggleSerial = (serial) => {
    setSelectedSerialMap((prev) => {
      const next = { ...prev };
      if (next[serial.id]) {
        delete next[serial.id];
      } else {
        next[serial.id] = serial;
      }
      return next;
    });
  };

  const removeSelectedSerial = (id) => {
    setSelectedSerialMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearAllSelected = () => {
    setSelectedSerialMap({});
  };

  const selectAllFiltered = () => {
    setSelectedSerialMap((prev) => {
      const next = { ...prev };
      filteredSerials.forEach((s) => {
        next[s.id] = s;
      });
      return next;
    });
  };

  const previewAbortRef = useRef(null);
  const previewReqIdRef = useRef(0);

  // Auto-sync targetUnit with selected product unit when user chooses an existing product
  useEffect(() => {
    if (!isNewProduct && selectedProduct) {
      const pUnit = selectedProduct.unit || selectedProduct.metadata?.unit || selectedProduct.metadata?.targetUnit;
      if (pUnit && CANONICAL_UNITS.some((u) => u.value === pUnit)) {
        setTargetUnit(pUnit);
      }
    }
  }, [selectedProduct, isNewProduct]);

  // 3. Live Server-Side Preview Effect (Debounced, with AbortController & Request ID Guard)
  useEffect(() => {
    if (!isOpen) return;

    if (selectedList.length === 0) {
      setPreviewData(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    // Do NOT trigger preview or premature errors when user is still selecting the first serial
    if (selectedList.length < 2) {
      setPreviewData(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      // Abort previous in-flight request
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
      }
      const controller = new AbortController();
      previewAbortRef.current = controller;

      const reqId = ++previewReqIdRef.current;
      setPreviewLoading(true);
      setPreviewError(null);

      try {
        const payload = {
          memberSerialIds: selectedList.map((s) => s.id),
          targetUnit: targetUnit || 'pcs',
        };

        if (selectedWarehouseId) {
          payload.warehouseId = selectedWarehouseId;
        }

        if (isNewProduct) {
          payload.resultProductName = resultProductName.trim() || 'Produk Grouping Baru';
          payload.createNewMasterProduct = true;
        } else if (selectedProductId) {
          payload.resultProductId = selectedProductId;
        }

        const res = await api.post(
          '/api/workspace/product-serials/group/preview',
          payload,
          { signal: controller.signal }
        );

        // Discard stale response if a newer request was dispatched
        if (reqId !== previewReqIdRef.current) return;

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          const errCode = json.error?.code || json.code;
          const errMsg = json.error?.message || json.message || 'Gagal memuat preview grouping';

          setPreviewError({
            code: errCode || 'PREVIEW_ERROR',
            message: errMsg,
            detail: json.error?.detail || json.detail,
          });
          setPreviewData(null);
        } else {
          setPreviewData(json.data);
          setPreviewError(null);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (reqId !== previewReqIdRef.current) return;

        console.error('Error during group preview:', err);
        setPreviewError({
          code: 'NETWORK_ERROR',
          message: err.message || 'Gagal terhubung ke server untuk preview transaksi.',
        });
        setPreviewData(null);
      } finally {
        if (reqId === previewReqIdRef.current) {
          setPreviewLoading(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
      }
    };
  }, [
    isOpen,
    selectedList.length,
    selectedList.map((s) => s.id).join(','),
    targetUnit,
    selectedWarehouseId,
    isNewProduct,
    selectedProductId,
    resultProductName,
  ]);

  // 4. Handle Group Submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Frontend validations
    if (selectedList.length < 2) {
      setSubmitError('Pilih minimal 2 nomor seri untuk digabungkan.');
      return;
    }

    if (isNewProduct && !resultProductName.trim()) {
      setSubmitError('Nama produk hasil baru wajib diisi.');
      return;
    }

    if (!isNewProduct && !selectedProductId) {
      setSubmitError('Pilih produk hasil yang terdaftar atau aktifkan opsi Produk Baru.');
      return;
    }

    if (previewError) {
      setSubmitError(`Tidak dapat memproses grouping: ${previewError.message}`);
      return;
    }

    if (!previewData || (!previewData.valid && !previewData.isValid)) {
      setSubmitError('Kalkulasi preview belum valid atau belum selesai.');
      return;
    }

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const payload = {
        memberSerialIds: selectedList.map((s) => s.id),
        groupSerialNumber: groupSerialNumber.trim() || undefined,
        targetUnit: targetUnit || 'pcs',
        warehouseId: selectedWarehouseId || undefined,
        notes: notes.trim() || undefined,
        idempotencyKey: idempotencyKeyRef.current,
        createNewMasterProduct: isNewProduct,
      };

      if (isNewProduct) {
        payload.resultProductName = resultProductName.trim();
        if (resultProductSku.trim()) {
          payload.resultProductSku = resultProductSku.trim();
        }
      } else if (selectedProductId) {
        payload.resultProductId = selectedProductId;
      }

      const res = await api.post('/api/workspace/product-serials/group', payload);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json.error?.message || json.message || 'Gagal menyimpan transaksi grouping.');
      }

      // Success
      if (onSuccess) {
        onSuccess(json.data);
      }
      onClose();
    } catch (err) {
      console.error('Error submitting serial grouping:', err);
      setSubmitError(err.message || 'Terjadi kesalahan saat memproses transaksi grouping.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const isFormValid =
    selectedList.length >= 2 &&
    (isNewProduct ? resultProductName.trim().length > 0 : Boolean(selectedProductId)) &&
    Boolean(previewData && (previewData.valid || previewData.isValid)) &&
    !previewError &&
    !previewLoading &&
    !isSubmitting;

  return (
    <div className="sg-create-overlay">
      <div className="sg-create-card">
        {/* Header */}
        <div className="sg-create-header">
          <div className="sg-create-header-title">
            <div className="sg-create-icon-badge">
              <Layers size={22} />
            </div>
            <div>
              <h2>Buat Grouping Serial Lintas Produk</h2>
              <p>Gabungkan beberapa nomor seri dari satu atau lebih produk menjadi satu nomor seri hasil</p>
            </div>
          </div>
          <button className="sg-create-close-btn" onClick={onClose} disabled={isSubmitting}>
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="sg-create-form">
          <div className="sg-create-body">
            {/* Top Config Row: Warehouse & Result Target Unit */}
            <div className="sg-config-row">
              <div className="sg-field-group">
                <label>
                  <Building2 size={16} /> Gudang Transaksi
                </label>
                <select
                  value={selectedWarehouseId}
                  onChange={(e) => {
                    setSelectedWarehouseId(e.target.value);
                    setSelectedSerialMap({}); // reset selected serials across warehouses
                  }}
                  disabled={isSubmitting}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} {w.code ? `(${w.code})` : ''}
                    </option>
                  ))}
                  {warehouses.length === 0 && <option value="">Gudang Utama (Default)</option>}
                </select>
              </div>

              <div className="sg-field-group">
                <label>
                  <Package size={16} /> Satuan Target Hasil
                </label>
                <select
                  value={targetUnit}
                  onChange={(e) => setTargetUnit(e.target.value)}
                  disabled={isSubmitting}
                >
                  {CANONICAL_UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sg-field-group">
                <label>
                  <FileText size={16} /> Nomor Seri Hasil (Opsional)
                </label>
                <input
                  type="text"
                  value={groupSerialNumber}
                  onChange={(e) => setGroupSerialNumber(e.target.value)}
                  placeholder="Auto generate jika kosong"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            {/* Split Section: Left (Serial Selection) & Right (Result & Preview) */}
            <div className="sg-create-grid">
              {/* Left Column: Member Serials Picker */}
              <div className="sg-picker-column">
                <div className="sg-picker-header">
                  <div className="sg-picker-title">
                    <h3>Pilih Komponen Nomor Seri</h3>
                    <span className="sg-count-badge">
                      {selectedList.length} Dipilih
                    </span>
                  </div>

                  <div className="sg-picker-actions">
                    <div className="sg-search-box">
                      <Search size={15} />
                      <input
                        type="text"
                        placeholder="Cari SN, SKU, atau Nama Produk..."
                        value={serialSearch}
                        onChange={(e) => setSerialSearch(e.target.value)}
                      />
                    </div>
                    {filteredSerials.length > 0 && (
                      <button
                        type="button"
                        className="sg-btn-link"
                        onClick={selectAllFiltered}
                      >
                        Pilih Semua
                      </button>
                    )}
                  </div>
                </div>

                {/* Context Product Banner */}
                {initialProductId && (
                  <div className="sg-context-filter-bar">
                    <div className="sg-context-info">
                      <Package size={14} />
                      <span>Konteks Produk: <strong>{contextProduct?.name || 'Produk Ini'}</strong></span>
                    </div>
                    <label className="sg-toggle-label">
                      <input
                        type="checkbox"
                        checked={onlyContextProduct}
                        onChange={(e) => setOnlyContextProduct(e.target.checked)}
                      />
                      <span>Hanya nomor seri produk ini ({filteredSerials.length})</span>
                    </label>
                  </div>
                )}

                {/* Serials Table */}
                <div className="sg-serials-list-container">
                  {loadingSerials ? (
                    <div className="sg-list-loading">
                      <Loader2 className="sg-spin" size={24} />
                      <span>Memuat data nomor seri...</span>
                    </div>
                  ) : filteredSerials.length === 0 ? (
                    <div className="sg-list-empty">
                      <p>Tidak ada nomor seri tersedia di gudang ini.</p>
                    </div>
                  ) : (
                    <table className="sg-picker-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36 }}></th>
                          <th>Nomor Seri</th>
                          <th>Produk</th>
                          <th>Satuan</th>
                          <th className="text-right">HPP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSerials.map((s) => {
                          const isChecked = !!selectedSerialMap[s.id];
                          return (
                            <tr
                              key={s.id}
                              className={isChecked ? 'row-selected' : ''}
                              onClick={() => toggleSerial(s)}
                            >
                              <td>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {}} // handled by tr click
                                />
                              </td>
                              <td>
                                <span className="mono font-semibold">{s.serial_number}</span>
                              </td>
                              <td>
                                <div className="sg-prod-meta">
                                  <span className="prod-name">{s.product_name || s.product?.name || '-'}</span>
                                  <span className="prod-sku mono">{s.sku || s.product?.sku || '-'}</span>
                                </div>
                              </td>
                              <td>
                                <span className="sg-unit-badge">{s.unit || 'pcs'}</span>
                              </td>
                              <td className="text-right text-muted">
                                {s.unit_cost !== null && s.unit_cost !== undefined ? formatCurrency(s.unit_cost) : <span className="text-muted">-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Selected List Chips Summary */}
                {selectedList.length > 0 && (
                  <div className="sg-selected-summary">
                    <div className="sg-selected-title">
                      <span>Nomor Seri Terpilih:</span>
                      <button
                        type="button"
                        className="sg-btn-clear"
                        onClick={clearAllSelected}
                      >
                        <Trash2 size={13} /> Kosongkan
                      </button>
                    </div>
                    <div className="sg-chips-wrapper">
                      {selectedList.map((s) => (
                        <div key={s.id} className="sg-chip">
                          <span className="mono">{s.serial_number}</span>
                          <span className="chip-unit">({s.unit || 'pcs'})</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSelectedSerial(s.id);
                            }}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: Result Product & Live Preview */}
              <div className="sg-result-column">
                {/* Result Product Selector */}
                <div className="sg-result-block">
                  <div className="sg-tab-selector">
                    <button
                      type="button"
                      className={`sg-tab-btn ${!isNewProduct ? 'active' : ''}`}
                      onClick={() => setIsNewProduct(false)}
                    >
                      Pilih Produk Terdaftar
                    </button>
                    <button
                      type="button"
                      className={`sg-tab-btn ${isNewProduct ? 'active' : ''}`}
                      onClick={() => setIsNewProduct(true)}
                    >
                      <PlusCircle size={14} /> Buat Produk Baru
                    </button>
                  </div>

                  {!isNewProduct ? (
                    <div className="sg-existing-product-form">
                      <div className="sg-existing-product-header">
                        <label htmlFor="sg-product-search-input">Pilih Master Produk Hasil:</label>
                        <span className="sg-existing-product-count">
                          {filteredProducts.length} produk
                        </span>
                      </div>

                      {/* Modern Search Input */}
                      <div className="sg-prod-search-wrapper">
                        <Search size={15} className="sg-prod-search-icon" aria-hidden="true" />
                        <input
                          id="sg-product-search-input"
                          type="text"
                          placeholder="Cari master produk berdasarkan nama atau SKU..."
                          value={productSearch}
                          onChange={(e) => setProductSearch(e.target.value)}
                          className="sg-input-search-prod"
                          autoComplete="off"
                        />
                        {productSearch && (
                          <button
                            type="button"
                            className="sg-prod-search-clear"
                            onClick={() => setProductSearch('')}
                            title="Hapus pencarian"
                            aria-label="Hapus pencarian"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>

                      {/* Custom Sleek Product Cards List */}
                      <div className="sg-product-picker-list" role="listbox" aria-label="Daftar Master Produk">
                        {filteredProducts.length > 0 ? (
                          filteredProducts.map((p) => {
                            const isSelected = selectedProductId === p.id;
                            return (
                              <div
                                key={p.id}
                                role="option"
                                aria-selected={isSelected}
                                tabIndex={0}
                                className={`sg-product-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => setSelectedProductId(p.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setSelectedProductId(p.id);
                                  }
                                }}
                              >
                                <div className="sg-product-card-indicator">
                                  <div className={`sg-radio-dot ${isSelected ? 'checked' : ''}`}>
                                    {isSelected && <Check size={11} strokeWidth={3} />}
                                  </div>
                                </div>
                                <div className="sg-product-card-body">
                                  <div className="sg-product-card-title-row">
                                    <span className="sg-product-card-name">{p.name}</span>
                                    {p.sku && (
                                      <span className="sg-product-card-sku mono">
                                        {p.sku}
                                      </span>
                                    )}
                                  </div>
                                  <div className="sg-product-card-meta-row">
                                    <span className="sg-product-card-unit">
                                      Satuan: <strong>{p.unit || 'pcs'}</strong>
                                    </span>
                                    {p.category && (
                                      <span className="sg-product-card-cat">
                                        • {p.category}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="sg-product-picker-empty">
                            <Package size={22} className="text-muted" />
                            <span>Tidak ada master produk ditemukan</span>
                          </div>
                        )}
                      </div>

                      {/* Selected Product Summary Card */}
                      {selectedProduct && (
                        <div className="sg-selected-product-badge">
                          <div className="sg-selected-product-badge-info">
                            <CheckCircle2 size={15} className="sg-selected-icon" />
                            <div className="sg-selected-texts">
                              <span className="sg-selected-label">Produk Terpilih:</span>
                              <strong className="sg-selected-name">{selectedProduct.name}</strong>
                              {selectedProduct.sku && (
                                <span className="sg-selected-sku mono">[{selectedProduct.sku}]</span>
                              )}
                              <span className="sg-selected-unit-tag">({selectedProduct.unit || 'pcs'})</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="sg-selected-product-reset-btn"
                            onClick={() => setSelectedProductId('')}
                            title="Batal pilih produk ini"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="sg-new-product-form">
                      <div className="sg-form-group">
                        <label>Nama Produk Hasil Baru *</label>
                        <input
                          type="text"
                          placeholder="Misal: Paket Bundle Lusinan..."
                          value={resultProductName}
                          onChange={(e) => setResultProductName(e.target.value)}
                          required
                          disabled={isSubmitting}
                        />
                      </div>
                      <div className="sg-form-group">
                        <label>SKU Produk Hasil (Opsional)</label>
                        <input
                          type="text"
                          placeholder="Auto generate jika kosong"
                          value={resultProductSku}
                          onChange={(e) => setResultProductSku(e.target.value)}
                          disabled={isSubmitting}
                        />
                      </div>
                      <div className="sg-form-group">
                        <label>Satuan Produk Baru</label>
                        <select
                          value={targetUnit}
                          onChange={(e) => setTargetUnit(e.target.value)}
                          disabled={isSubmitting}
                        >
                          {CANONICAL_UNITS.map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                {/* Notes Input */}
                <div className="sg-notes-block">
                  <label>Catatan Transaksi (Opsional):</label>
                  <textarea
                    rows={2}
                    placeholder="Keterangan perakitan/grouping..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>

                {/* Live Server-Side Preview Box */}
                <div className="sg-preview-box">
                  <div className="sg-preview-title">
                    <h4>
                      <DollarSign size={16} /> Kalkulasi Live (Server Preview)
                    </h4>
                    {previewLoading && (
                      <div className="sg-preview-loading-tag">
                        <Loader2 className="sg-spin" size={13} />
                        <span>Menghitung...</span>
                      </div>
                    )}
                  </div>

                  {/* Error State from Backend */}
                  {previewError && (
                    <div className="sg-preview-alert error">
                      <AlertCircle size={18} />
                      <div>
                        <strong>{previewError.code}:</strong> {previewError.message}
                        {previewError.detail && (
                          <div className="sg-alert-detail">{previewError.detail}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Empty state & Guidance note */}
                  {!previewError && !previewData && !previewLoading && (
                    <div className="sg-preview-placeholder">
                      {selectedList.length === 1 ? (
                        <div className="sg-preview-hint">
                          <AlertCircle size={16} />
                          <span>Pilih minimal 1 nomor seri lagi (total minimal 2) untuk mengaktifkan kalkulasi grouping.</span>
                        </div>
                      ) : (
                        <p>Pilih minimal 2 nomor seri di sisi kiri untuk melihat kalkulasi HPP dan kuantitas target.</p>
                      )}
                    </div>
                  )}

                  {/* Success Preview Data */}
                  {!previewError && previewData && (
                    <div className="sg-preview-results">
                      <div className="sg-preview-grid">
                        <div className="sg-p-card">
                          <span className="label">Total Komponen</span>
                          <span className="value">
                            {previewData.leafMemberCount || selectedList.length} Serial
                          </span>
                        </div>
                        <div className="sg-p-card">
                          <span className="label">Total Dasar</span>
                          <span className="value">{previewData.totalBaseQtyPcs} pcs</span>
                        </div>
                        <div className="sg-p-card highlight">
                          <span className="label">Kuantitas Hasil</span>
                          <span className="value font-bold">
                            {previewData.targetQty} {previewData.targetUnit}
                          </span>
                        </div>
                        <div className="sg-p-card">
                          <span className="label">Total HPP</span>
                          <span className="value">{formatCurrency(previewData.totalCost)}</span>
                        </div>
                        <div className="sg-p-card highlight full">
                          <span className="label">HPP Satuan Hasil</span>
                          <span className="value font-bold text-primary">
                            {formatCurrency(previewData.resultUnitCost)} / {previewData.targetUnit}
                          </span>
                        </div>
                      </div>

                      {previewData.unitBreakdown && (
                        <div className="sg-unit-breakdown">
                          <span className="breakdown-label">Komposisi Sumber:</span>
                          <span className="breakdown-val">
                            {typeof previewData.unitBreakdown === 'string'
                              ? previewData.unitBreakdown
                              : Object.entries(previewData.unitBreakdown)
                                  .map(([k, v]) => `${v} ${k}`)
                                  .join(', ')}
                          </span>
                        </div>
                      )}

                      {previewData.candidateSerialNumber && (
                        <div style={{ marginTop: '0.65rem', padding: '0.65rem 0.85rem', background: '#ffffff', border: '1px dashed var(--color-interactive, #2563eb)', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div>
                            <span style={{ fontSize: '0.725rem', color: '#64748b', display: 'block', fontWeight: 600 }}>Serial Hasil yang Akan Dibuat:</span>
                            <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--color-interactive, #2563eb)', fontSize: '0.9rem' }}>{previewData.candidateSerialNumber}</span>
                          </div>
                          <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '1rem', background: 'var(--color-interactive-light, #eff6ff)', color: 'var(--color-interactive, #2563eb)', fontWeight: 600 }}>Kandidat Otomatis</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Submit Error */}
                {submitError && (
                  <div className="sg-submit-error">
                    <AlertTriangle size={16} />
                    <span>{submitError}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="sg-create-footer">
            <button
              type="button"
              className="sg-btn-cancel"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Batal
            </button>
            <button
              type="submit"
              className="sg-btn-submit"
              disabled={!isFormValid || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="sg-spin" size={16} />
                  <span>Memproses Grouping...</span>
                </>
              ) : (
                <>
                  <Check size={16} />
                  <span>Simpan Transaksi Grouping</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

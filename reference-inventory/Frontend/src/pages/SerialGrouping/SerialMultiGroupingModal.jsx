import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  X,
  Barcode,
  Layers,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Loader2,
  Package,
  ArrowRight,
  Focus,
  Sparkles,
  Info,
  Lock,
  Pencil,
  Check
} from 'lucide-react';
import { api } from '../../utils/api.js';
import { useUnits } from '../../hooks/useUnits.js';
import {
  computeSourceProductPolicy,
  withSourceProductPolicy,
  isStalePreviewResult
} from './serialGroupingPolicy.js';
import './SerialMultiGroupingModal.css';

const CANONICAL_UNITS = [
  { value: 'pcs', label: 'pcs (1 pcs)', multiplier: 1 },
  { value: 'lusin', label: 'lusin (12 pcs)', multiplier: 12 },
];

function playBeep(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch (_) {}
}

function createIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `grp-${crypto.randomUUID()}`;
    }
  } catch (_) {}
  return `grp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function SerialMultiGroupingModal({
  isOpen,
  onClose,
  onSuccess,
  initialWarehouseId = null,
}) {
  const { customUnits, getMultiplier, getUnitLabel } = useUnits();

  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState(initialWarehouseId || '');
  const [products, setProducts] = useState([]);

  // Menampilkan kuantitas mengikuti satuan yang dipakai owner (bisa berbeda tiap owner).
  // Contoh: satu serial satuan lusin -> "1 Lusin (12 pcs)". Satuan & multiplier diutamakan dari
  // hasil verifikasi backend (owner/warehouse-aware), fallback ke unit owner di frontend.
  const formatSerialQty = useCallback((serial) => {
    const unitKey = String(serial?.unit || 'pcs').toLowerCase();
    const unitQty = Number(serial?.unitQty) || 1;
    const multiplier = Number(serial?.unitMultiplier) || getMultiplier(unitKey) || 1;
    const pcs = Number(serial?.pcs) || unitQty * multiplier;
    if (unitKey === 'pcs' || unitKey === 'piece') return `${pcs} pcs`;
    const label = getUnitLabel(unitKey) || unitKey;
    return `${unitQty} ${label} (${pcs} pcs)`;
  }, [getMultiplier, getUnitLabel, customUnits]);

  const getEffectiveGroupSerial = useCallback((batch) => {
    if (!batch) return '';
    return batch.processResult?.group?.serial_number
      || batch.groupSerialNumber?.trim()
      || batch.previewData?.candidateSerialNumber
      || '';
  }, []);

  const createInitialBatch = useCallback((customId = null) => ({
    id: customId || `batch-${Date.now()}`,
    name: 'Batch 1',
    serials: [],
    targetProductId: '',
    isNewProduct: false,
    newProductName: '',
    newProductSku: '',
    targetUnit: 'pcs',
    notes: '',
    groupSerialNumber: '',
    previewData: null,
    previewLoading: false,
    previewError: null,
    status: 'incomplete', // 'incomplete' | 'valid' | 'invalid' | 'completed' | 'failed'
    processResult: null,
    processError: null,
    idempotencyKey: createIdempotencyKey(),
  }), []);

  // Batches state
  const [batches, setBatches] = useState([createInitialBatch('batch-1')]);
  const [activeBatchId, setActiveBatchId] = useState('batch-1');
  const [editingGroupSerialBatchId, setEditingGroupSerialBatchId] = useState(null);
  const [groupSerialDraft, setGroupSerialDraft] = useState('');
  const [sessionName, setSessionName] = useState('');

  useEffect(() => {
    setEditingGroupSerialBatchId(null);
    setGroupSerialDraft('');
    setProductSearch('');
  }, [activeBatchId]);

  // Scanner state
  const [scanInput, setScanInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState(null);
  const [isVerifyingScan, setIsVerifyingScan] = useState(false);
  const scanInputRef = useRef(null);

  // Refs used to prevent stale async results from overwriting newer state.
  const batchesRef = useRef(batches);
  const activeBatchIdRef = useRef(activeBatchId);
  const previewSeqRef = useRef({});
  const inFlightScansRef = useRef(new Set());
  batchesRef.current = batches;
  activeBatchIdRef.current = activeBatchId;

  // Search in product selector
  const [productSearch, setProductSearch] = useState('');

  // Processing state
  const [isProcessing, setIsProcessing] = useState(false);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [sessionSaveError, setSessionSaveError] = useState(null);

  // PHASE 7J — Reset session helper: creates a fresh, clean slate
  const resetSession = useCallback(() => {
    const initBatch = createInitialBatch('batch-1');
    setBatches([initBatch]);
    setActiveBatchId(initBatch.id);
    setSessionName('');
    setScanInput('');
    setScanFeedback(null);
    setIsVerifyingScan(false);
    setIsProcessing(false);
    setShowPendingReview(false);
    setSessionSaveError(null);
    setProductSearch('');
    setEditingGroupSerialBatchId(null);
    setGroupSerialDraft('');
    inFlightScansRef.current.clear();
    previewSeqRef.current = {};
    if (initialWarehouseId) {
      setSelectedWarehouseId(initialWarehouseId);
    } else if (warehouses.length > 0) {
      setSelectedWarehouseId(warehouses[0].id);
    }
  }, [createInitialBatch, initialWarehouseId, warehouses]);

  // PHASE 7J — Detect modal opening to guarantee fresh session
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      resetSession();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, resetSession]);

  // PHASE 7J — Restore focus to scanner input without hijacking intentional user focus
  const restoreFocusIfAppropriate = useCallback(() => {
    if (!isOpen) return;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    // Check if user is deliberately interacting with another input or control
    const isAnotherControlFocused = activeEl && (
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'SELECT' ||
      activeEl.tagName === 'TEXTAREA' ||
      (activeEl.tagName === 'BUTTON' && !activeEl.classList?.contains('smg-refocus-btn'))
    ) && activeEl !== scanInputRef.current;

    // If active batch is completed, do not force focus
    const currentActiveBatch = batchesRef.current.find((b) => b.id === activeBatchIdRef.current);
    if (currentActiveBatch?.status === 'completed') return;

    if (!isAnotherControlFocused) {
      scanInputRef.current?.focus();
    }
  }, [isOpen]);

  // 1. Initial Load: Warehouses & Products
  useEffect(() => {
    if (!isOpen) return;

    const loadInitData = async () => {
      try {
        const [whRes, prodRes] = await Promise.all([
          api.get('/api/workspace/warehouses'),
          api.get('/api/workspace/products?limit=2000')
        ]);
        if (whRes.ok) {
          const json = await whRes.json();
          const list = json.data || [];
          setWarehouses(list);
          if (!selectedWarehouseId && list.length > 0) {
            setSelectedWarehouseId(initialWarehouseId || list[0].id);
          }
        }
        if (prodRes.ok) {
          const json = await prodRes.json();
          setProducts(json.data || []);
        }
      } catch (err) {
        console.error('Error loading master data for multi-grouping:', err);
      }
    };

    loadInitData();
  }, [isOpen, initialWarehouseId, selectedWarehouseId]);

  // Focus scan input on open or when switching batches
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        restoreFocusIfAppropriate();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isOpen, activeBatchId, restoreFocusIfAppropriate]);

  // Dismiss scan feedback after 4 seconds
  useEffect(() => {
    if (scanFeedback) {
      const timer = setTimeout(() => {
        setScanFeedback(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [scanFeedback]);

  // Active batch object
  const activeBatch = useMemo(() => {
    return batches.find((b) => b.id === activeBatchId) || batches[0];
  }, [batches, activeBatchId]);

  // PHASE 7E — Source-product policy for the active batch (derived from verified serials).
  const activeBatchPolicy = useMemo(
    () => computeSourceProductPolicy(activeBatch?.serials || []),
    [activeBatch?.serials]
  );

  // Locked product descriptor (may not be present in the paginated product list).
  const lockedProductInfo = useMemo(() => {
    if (!activeBatchPolicy.productSelectionLocked) return null;
    const source = activeBatchPolicy.sourceProducts[0];
    if (!source) return null;
    const fromList = products.find((p) => p.id === source.productId);
    return fromList || { id: source.productId, name: source.productName, sku: source.sku };
  }, [activeBatchPolicy, products]);

  // Safety net: whenever batch composition changes by any path, re-evaluate the
  // product selection so a stale lock/selection never survives.
  const batchCompositionSignature = useMemo(
    () => batches.map((b) => `${b.id}:${(b.serials || []).map((s) => s.id).join('|')}`).join(';'),
    [batches]
  );

  useEffect(() => {
    setBatches((prev) => {
      let changed = false;
      const next = prev.map((b) => {
        if (b.status === 'completed') return b;
        const policy = computeSourceProductPolicy(b.serials);
        const updates = {};

        if (policy.productSelectionLocked) {
          if (b.targetProductId !== policy.lockedResultProductId) {
            updates.targetProductId = policy.lockedResultProductId;
          }
          if (b.isNewProduct) updates.isNewProduct = false;
          if (b.newProductName) updates.newProductName = '';
          if (b.newProductSku) updates.newProductSku = '';
        } else if (policy.distinctProductCount === 0) {
          if (b.targetProductId) updates.targetProductId = '';
          if (b.isNewProduct) updates.isNewProduct = false;
          if (b.newProductName) updates.newProductName = '';
          if (b.newProductSku) updates.newProductSku = '';
        }

        if (Object.keys(updates).length === 0) return b;
        changed = true;
        return { ...b, ...updates, previewData: null, previewError: null };
      });
      return changed ? next : prev;
    });
  }, [batchCompositionSignature]);

  // Total serials scanned across all batches
  const totalScannedCount = useMemo(() => {
    return batches.reduce((sum, b) => sum + (b.serials?.length || 0), 0);
  }, [batches]);

  // Map of all scanned serials across session for fast O(1) duplicate checks
  const sessionSerialSet = useMemo(() => {
    const map = new Map();
    batches.forEach((b) => {
      (b.serials || []).forEach((s) => {
        const snKey = String(s.serialNumber || s.serial_number || '').toLowerCase();
        map.set(snKey, b);
      });
    });
    return map;
  }, [batches]);

  // Filtered products for active batch selector
  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    if (!query) return [];
    return products.filter(
      (p) => (p.name || '').toLowerCase().includes(query) || (p.sku || '').toLowerCase().includes(query)
    );
  }, [products, productSearch]);

  const selectedTargetProduct = useMemo(() => {
    if (!activeBatch?.targetProductId) return null;
    return products.find((p) => p.id === activeBatch.targetProductId) || null;
  }, [products, activeBatch?.targetProductId]);

  // Focus scanner cleanly
  const focusScanMode = () => {
    scanInputRef.current?.focus();
  };

  // Add new batch
  const handleAddBatch = () => {
    const newIdx = batches.length + 1;
    const newBatch = {
      id: `batch-${Date.now()}`,
      name: `Batch ${newIdx}`,
      serials: [],
      targetProductId: '',
      isNewProduct: false,
      newProductName: '',
      newProductSku: '',
      targetUnit: 'pcs',
      notes: '',
      groupSerialNumber: '',
      previewData: null,
      previewLoading: false,
      previewError: null,
      status: 'incomplete',
      processResult: null,
      processError: null,
      idempotencyKey: createIdempotencyKey(),
    };
    setBatches((prev) => [...prev, newBatch]);
    setActiveBatchId(newBatch.id);
  };

  // Switch batch
  const handleSelectBatch = (batchId) => {
    setActiveBatchId(batchId);
  };

  const startEditGroupSerial = () => {
    if (!activeBatch || activeBatch.status === 'completed') return;
    setEditingGroupSerialBatchId(activeBatch.id);
    setGroupSerialDraft(getEffectiveGroupSerial(activeBatch));
  };

  const cancelEditGroupSerial = () => {
    setEditingGroupSerialBatchId(null);
    setGroupSerialDraft('');
  };

  const saveGroupSerial = () => {
    const batchId = editingGroupSerialBatchId;
    if (!batchId) return;
    const nextSerial = groupSerialDraft.trim();

    setBatches((prev) => prev.map((b) => (
      b.id === batchId
        ? {
          ...b,
          groupSerialNumber: nextSerial,
          idempotencyKey: createIdempotencyKey(),
        }
        : b
    )));
    cancelEditGroupSerial();
  };

  const resetGroupSerialToAuto = () => {
    setBatches((prev) => prev.map((b) => (
      b.id === activeBatch.id
        ? {
          ...b,
          groupSerialNumber: '',
          idempotencyKey: createIdempotencyKey(),
        }
        : b
    )));
    cancelEditGroupSerial();
  };

  // Delete batch
  const handleDeleteBatch = (batchId, e) => {
    e?.stopPropagation();
    if (batches.length <= 1) {
      // Clear instead of removing last batch
      setBatches((prev) => [
        withSourceProductPolicy({ ...prev[0], notes: '', status: 'incomplete' }, [])
      ]);
      return;
    }
    const remaining = batches.filter((b) => b.id !== batchId);
    setBatches(remaining);
    if (activeBatchId === batchId) {
      setActiveBatchId(remaining[0].id);
    }
  };

  // Update active batch fields
  const updateActiveBatch = useCallback((updates) => {
    setBatches((prev) =>
      prev.map((b) => {
        if (b.id === activeBatchId) {
          return { ...b, ...updates };
        }
        return b;
      })
    );
  }, [activeBatchId]);

  // Remove serial from active batch
  const handleRemoveSerial = (serialId) => {
    setBatches((prev) =>
      prev.map((b) => {
        if (b.id === activeBatchId) {
          const nextSerials = b.serials.filter((s) => s.id !== serialId);
          return withSourceProductPolicy(b, nextSerials);
        }
        return b;
      })
    );
  };

  // Clear all serials from active batch
  const handleClearActiveBatchSerials = () => {
    setBatches((prev) =>
      prev.map((b) => {
        if (b.id === activeBatchId) {
          return withSourceProductPolicy(b, []);
        }
        return b;
      })
    );
  };

  // 2. Scan Submission & Verification
  const handleScanSubmit = async (e) => {
    e?.preventDefault();
    const rawSN = scanInput.trim();
    if (!rawSN) return;

    // Clear input immediately for rapid successive barcode scans
    setScanInput('');

    // Check duplicate in active batch
    const snLower = rawSN.toLowerCase();
    const existsInActive = activeBatch.serials.some(
      (s) => String(s.serialNumber || s.serial_number || '').toLowerCase() === snLower
    );
    if (existsInActive) {
      playBeep('warning');
      setScanFeedback({
        type: 'warning',
        message: `Nomor seri "${rawSN}" sudah ada di ${activeBatch.name}.`,
        serialNumber: rawSN,
      });
      restoreFocusIfAppropriate();
      return;
    }

    // Prevent duplicate submissions while the same serial is still being verified.
    if (inFlightScansRef.current.has(snLower)) {
      playBeep('warning');
      setScanFeedback({
        type: 'warning',
        message: `Nomor seri "${rawSN}" sedang diverifikasi. Tunggu sebentar.`,
        serialNumber: rawSN,
      });
      restoreFocusIfAppropriate();
      return;
    }

    // Check duplicate in other batches in this session
    const existingInBatch = sessionSerialSet.get(snLower);
    if (existingInBatch) {
      playBeep('warning');
      setScanFeedback({
        type: 'warning',
        message: `Nomor seri "${rawSN}" sudah dialokasikan ke ${existingInBatch.name}. Satu serial hanya boleh masuk ke satu batch.`,
        serialNumber: rawSN,
      });
      restoreFocusIfAppropriate();
      return;
    }

    // Verify serial on backend
    inFlightScansRef.current.add(snLower);
    try {
      setIsVerifyingScan(true);
      const res = await api.post('/api/workspace/product-serials/group/verify-scan', {
        serialNumber: rawSN,
        warehouseId: selectedWarehouseId || undefined,
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        playBeep('error');
        const errMsg = json.error?.message || json.message || `Nomor seri "${rawSN}" tidak valid.`;
        setScanFeedback({
          type: 'error',
          message: errMsg,
          serialNumber: rawSN,
        });
        return;
      }

      if (json.data?.eligible && json.data?.serial) {
        const verifiedSerial = json.data.serial;
        // Add to active batch
        setBatches((prev) =>
          prev.map((b) => {
            if (b.id === activeBatchId) {
              // Re-evaluate the source-product policy atomically with the new
              // serial so the lock never lags behind the composition.
              return withSourceProductPolicy(b, [verifiedSerial, ...b.serials]);
            }
            return b;
          })
        );
        playBeep('success');
        setScanFeedback({
          type: 'success',
          message: `Berhasil menambahkan "${verifiedSerial.serialNumber}" (${verifiedSerial.productName}) ke ${activeBatch.name}.`,
          serialNumber: verifiedSerial.serialNumber,
        });
      }
    } catch (err) {
      playBeep('error');
      setScanFeedback({
        type: 'error',
        message: err.message || 'Gagal terhubung ke server untuk memverifikasi nomor seri.',
        serialNumber: rawSN,
      });
    } finally {
      inFlightScansRef.current.delete(snLower);
      setIsVerifyingScan(false);
      restoreFocusIfAppropriate();
    }
  };

  // 3. Live Preview per Batch (Independent Calculation)
  useEffect(() => {
    if (!isOpen || !activeBatch) return;

    if (activeBatch.serials.length < 2) {
      updateActiveBatch({
        previewData: null,
        previewError: null,
        previewLoading: false,
        status: activeBatch.status === 'completed' ? 'completed' : 'incomplete',
      });
      return;
    }

    // Wait for the lock-sync effect to align the result product with the
    // source product before requesting the calculation.
    if (
      activeBatchPolicy.productSelectionLocked &&
      (activeBatch.targetProductId !== activeBatchPolicy.lockedResultProductId || activeBatch.isNewProduct)
    ) {
      return;
    }

    // Snapshot the request so a slower response can never overwrite newer state.
    const requestBatchId = activeBatchId;
    const membershipKey = (activeBatch.serials || []).map((s) => s.id).join(',');
    const requestSeq = (previewSeqRef.current[requestBatchId] || 0) + 1;
    previewSeqRef.current[requestBatchId] = requestSeq;

    const isStale = () => {
      const current = batchesRef.current.find((b) => b.id === requestBatchId);
      return isStalePreviewResult({
        requestSeq,
        currentSeq: previewSeqRef.current[requestBatchId],
        requestBatchId,
        currentBatchId: activeBatchIdRef.current,
        snapshotMembershipKey: membershipKey,
        currentMembershipKey: (current?.serials || []).map((s) => s.id).join(','),
      });
    };

    const timer = setTimeout(async () => {
      if (isStale()) return;
      updateActiveBatch({ previewLoading: true, previewError: null });

      try {
        const payload = {
          memberSerialIds: activeBatch.serials.map((s) => s.id),
          targetUnit: activeBatch.targetUnit || 'pcs',
        };

        if (selectedWarehouseId) {
          payload.warehouseId = selectedWarehouseId;
        }

        if (activeBatch.isNewProduct) {
          payload.resultProductName = activeBatch.newProductName?.trim() || 'Produk Grouping Baru';
          payload.createNewMasterProduct = true;
          if (activeBatch.newProductSku?.trim()) {
            payload.resultProductSku = activeBatch.newProductSku.trim();
          }
        } else if (activeBatch.targetProductId) {
          payload.resultProductId = activeBatch.targetProductId;
        }

        const res = await api.post('/api/workspace/product-serials/group/preview', payload);
        const json = await res.json().catch(() => ({}));

        if (isStale()) return;

        if (!res.ok) {
          const errMsg = json.error?.message || json.message || 'Kalkulasi preview grouping tidak valid.';
          console.warn('[group/preview] gagal:', json.error?.code || res.status, errMsg);
          updateActiveBatch({
            previewData: null,
            previewError: { message: errMsg, code: json.error?.code },
            previewLoading: false,
            status: 'invalid',
          });
        } else {
          const hasProduct = activeBatch.isNewProduct
            ? activeBatch.newProductName?.trim().length > 0
            : Boolean(activeBatch.targetProductId);

          updateActiveBatch({
            previewData: json.data,
            previewError: null,
            previewLoading: false,
            status: hasProduct ? 'valid' : 'incomplete',
          });
        }
      } catch (err) {
        if (isStale()) return;
        updateActiveBatch({
          previewData: null,
          previewError: { message: err.message || 'Gagal memuat kalkulasi preview.' },
          previewLoading: false,
          status: 'invalid',
        });
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    activeBatchId,
    activeBatch?.serials?.length,
    activeBatch?.serials?.map((s) => s.id).join(','),
    activeBatch?.targetProductId,
    activeBatch?.targetUnit,
    activeBatch?.isNewProduct,
    activeBatch?.newProductName,
    activeBatch?.newProductSku,
    selectedWarehouseId,
    activeBatchPolicy.productSelectionLocked,
    activeBatchPolicy.lockedResultProductId,
  ]);

  // Auto-sync targetUnit when existing product is selected
  const handleSelectProduct = (product) => {
    // PHASE 7E — the result product is locked while every serial comes from one
    // source product. UI is not enough: backend also rejects mismatches.
    if (activeBatchPolicy.productSelectionLocked) return;

    const pUnit = product.metadata?.unit || product.unit;
    const updates = { targetProductId: product.id };
    if (pUnit && CANONICAL_UNITS.some((u) => u.value === pUnit)) {
      updates.targetUnit = pUnit;
    }
    updateActiveBatch(updates);
    setProductSearch('');
  };

  // 4. Pending session readiness & payload
  const getBatchTargetProduct = useCallback((batch) => {
    if (!batch) return null;
    const policy = computeSourceProductPolicy(batch.serials || []);
    if (batch.isNewProduct && !policy.productSelectionLocked) {
      return {
        id: null,
        name: batch.newProductName?.trim() || '',
        sku: batch.newProductSku?.trim() || '',
        isNew: true,
      };
    }
    const targetId = policy.productSelectionLocked
      ? policy.lockedResultProductId
      : batch.targetProductId;
    if (!targetId) return null;
    const fromList = products.find((p) => p.id === targetId);
    const fromSource = policy.sourceProducts.find((sp) => sp.productId === targetId);
    return {
      id: targetId,
      name: fromList?.name || fromSource?.productName || '',
      sku: fromList?.sku || fromSource?.sku || '',
      isNew: false,
    };
  }, [products]);

  const isBatchPendingReady = useCallback((batch) => {
    if (!batch) return false;
    if (batch.status !== 'valid' || !batch.previewData || batch.serials.length < 2) return false;
    if (batch.previewLoading || batch.previewError) return false;
    return Boolean(getBatchTargetProduct(batch)?.name || getBatchTargetProduct(batch)?.id);
  }, [getBatchTargetProduct]);

  const getBatchPendingIssue = useCallback((batch) => {
    if (!batch) return 'Batch tidak valid.';
    if (batch.serials.length < 2) return 'Minimal 2 nomor seri.';
    if (batch.previewLoading) return 'Preview masih dihitung.';
    if (batch.previewError) return batch.previewError.message || 'Preview gagal.';
    if (batch.status !== 'valid' || !batch.previewData) return 'Preview belum valid.';
    if (!getBatchTargetProduct(batch)) return 'Produk hasil grouping belum dipilih.';
    return null;
  }, [getBatchTargetProduct]);

  const pendingReadyBatches = useMemo(
    () => batches.filter((b) => isBatchPendingReady(b)),
    [batches, isBatchPendingReady]
  );
  const pendingIssues = useMemo(
    () => batches
      .map((b) => ({ id: b.id, name: b.name, issue: getBatchPendingIssue(b) }))
      .filter((item) => item.issue),
    [batches, getBatchPendingIssue]
  );
  const canSavePending = batches.length > 0 && pendingIssues.length === 0;

  const buildPayloadBatches = useCallback(() => {
    return pendingReadyBatches.map((b) => {
      const policy = computeSourceProductPolicy(b.serials);
      const targetProduct = getBatchTargetProduct(b);
      const payload = {
        batchId: b.id,
        name: b.name,
        memberSerialIds: b.serials.map((s) => s.id),
        targetUnit: b.targetUnit || 'pcs',
        targetQty: b.previewData?.targetQty ?? 1,
        warehouseId: selectedWarehouseId || undefined,
        notes: b.notes?.trim() || undefined,
        createNewMasterProduct: policy.productSelectionLocked ? false : Boolean(b.isNewProduct),
        idempotencyKey: b.idempotencyKey || createIdempotencyKey(),
        serials: b.serials,
      };

      if (b.groupSerialNumber?.trim()) {
        payload.groupSerialNumber = b.groupSerialNumber.trim();
      }

      if (targetProduct?.id) {
        payload.targetProductId = targetProduct.id;
        payload.resultProductId = targetProduct.id;
        payload.targetProductName = targetProduct.name || undefined;
        payload.resultProductName = targetProduct.name || undefined;
        payload.targetProductSku = targetProduct.sku || undefined;
        payload.resultProductSku = targetProduct.sku || undefined;
      } else if (targetProduct?.isNew) {
        payload.targetProductName = targetProduct.name || 'Produk Grouping';
        payload.resultProductName = targetProduct.name || 'Produk Grouping';
        if (targetProduct.sku) {
          payload.targetProductSku = targetProduct.sku;
          payload.resultProductSku = targetProduct.sku;
        }
        payload.newProductName = targetProduct.name || 'Produk Grouping';
        if (targetProduct.sku) payload.newProductSku = targetProduct.sku;
      }

      return payload;
    });
  }, [pendingReadyBatches, selectedWarehouseId, getBatchTargetProduct]);

  // PHASE 7O — Pending session must be reviewed and confirmed before saving.
  const handleSavePendingSession = () => {
    if (!canSavePending || isProcessing) return;
    setSessionSaveError(null);
    setShowPendingReview(true);
  };

  const submitPendingSession = async () => {
    if (!canSavePending || isProcessing) return;

    const payloadBatches = buildPayloadBatches();
    if (payloadBatches.length !== batches.length) {
      setSessionSaveError('Masih ada batch yang belum siap. Periksa preview dan produk hasil grouping.');
      return;
    }

    setIsProcessing(true);
    setSessionSaveError(null);

    try {
      const res = await api.post('/api/workspace/product-serials/grouping-sessions', {
        sessionName: sessionName?.trim() || undefined,
        warehouseId: selectedWarehouseId || undefined,
        isPending: true,
        batches: payloadBatches,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error?.message || json.message || 'Gagal menyimpan sesi grouping.');
      }

      setShowPendingReview(false);
      if (onSuccess) {
        onSuccess(json.data);
      }

      onClose();
      resetSession();
    } catch (err) {
      console.error('Error saving pending grouping session:', err);
      setSessionSaveError(err.message || 'Gagal menyimpan sesi grouping.');
    } finally {
      setIsProcessing(false);
    }
  };

  const hasUnsavedDraft = totalScannedCount > 0 && batches.some((b) => b.status !== 'completed');

  const handleClose = useCallback(() => {
    if (isProcessing) return;
    if (hasUnsavedDraft) {
      const confirmed = window.confirm(
        'Masih ada nomor seri yang belum diproses. Menutup sekarang akan membuang draft sesi ini. Lanjutkan menutup?'
      );
      if (!confirmed) return;
    }
    onClose();
  }, [hasUnsavedDraft, isProcessing, onClose]);

  useEffect(() => {
    if (!isOpen || !hasUnsavedDraft) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOpen, hasUnsavedDraft]);

  if (!isOpen) return null;

  return (
    <div className="smg-modal-overlay">
      <div className="smg-modal-container">
        {/* ── Modal Header ── */}
        <div className="smg-header">
          <div className="smg-header-title-box">
            <div className="smg-header-icon">
              <Barcode size={26} />
            </div>
            <div>
              <h2>
                Add Group — Scan-First
                <span className="smg-candidate-badge">DocuFlow</span>
              </h2>
              <p className="smg-header-subtitle">
                Pindai nomor seri komponen secara berurutan, alokasikan ke multi-batch, dan proses hasil grouping secara independen.
              </p>
            </div>
          </div>
          <div className="smg-header-actions">
            <button className="smg-close-btn" onClick={handleClose} title="Tutup Modal">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* ── Top Bar: Warehouse Selector & Batch Tabs ── */}
        <div className="smg-body">
          <div className="smg-top-bar">
            <div className="smg-warehouse-select-box">
              <label htmlFor="smg-wh-select">Gudang Aktif:</label>
              <select
                id="smg-wh-select"
                className="smg-warehouse-select"
                value={selectedWarehouseId}
                onChange={(e) => setSelectedWarehouseId(e.target.value)}
                disabled={totalScannedCount > 0}
                title={totalScannedCount > 0 ? 'Gudang tidak dapat diubah setelah ada nomor seri ter-scan. Hapus semua scan terlebih dahulu.' : undefined}
              >
                {warehouses.map((wh) => (
                  <option key={wh.id} value={wh.id}>
                    {wh.name} {wh.code ? `(${wh.code})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="smg-session-name-box">
              <label htmlFor="smg-session-name-input">Nama Sesi (Opsional):</label>
              <input
                id="smg-session-name-input"
                type="text"
                className="smg-session-name-input"
                placeholder="Contoh: Grouping Baju Kemeja 23 Okt"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                disabled={isProcessing}
              />
            </div>

            <div className="smg-batch-tabs">
              {batches.map((b) => (
                <button
                  key={b.id}
                  className={`smg-batch-pill ${b.id === activeBatchId ? 'active' : ''}`}
                  onClick={() => handleSelectBatch(b.id)}
                  type="button"
                >
                  <Layers size={14} />
                  <span>{b.name}</span>
                  <span className="smg-pill-count">{b.serials?.length || 0} SN</span>
                  {batches.length > 1 && b.status !== 'completed' && (
                    <span
                      onClick={(e) => handleDeleteBatch(b.id, e)}
                      title="Hapus batch ini"
                      style={{ marginLeft: '4px', cursor: 'pointer', opacity: 0.7 }}
                    >
                      &times;
                    </span>
                  )}
                </button>
              ))}

              <button className="smg-add-batch-btn" onClick={handleAddBatch} type="button">
                <Plus size={14} />
                <span>Tambah Batch</span>
              </button>
            </div>
          </div>

          {/* ── Two Columns (Scan Left, Target & Preview Right) ── */}
          <div className="smg-columns-grid">
            {/* ── Left Column: Scan Panel & Scanned Items ── */}
            <div className="smg-panel">
              <div className="smg-scan-box">
                <form onSubmit={handleScanSubmit}>
                  <div className="smg-scan-input-wrapper">
                    {isVerifyingScan ? (
                      <Loader2 className="smg-scan-icon spin" size={20} />
                    ) : (
                      <Barcode className="smg-scan-icon" size={20} />
                    )}
                    <input
                      ref={scanInputRef}
                      type="text"
                      className="smg-scan-input"
                      placeholder={`Pindai SN untuk ${activeBatch.name} (akhiri dengan Enter)...`}
                      value={scanInput}
                      onChange={(e) => setScanInput(e.target.value)}
                      disabled={activeBatch.status === 'completed'}
                      autoFocus
                    />
                  </div>
                </form>

                <div className="smg-scan-hint-row">
                  <span>Dukung barcode scanner keyboard-wedge & input manual</span>
                  <button
                    type="button"
                    className="smg-refocus-btn"
                    onClick={focusScanMode}
                    title="Fokuskan kursor kembali ke kolom scanner"
                  >
                    <Focus size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    Fokus Mode Scan
                  </button>
                </div>
              </div>

              {/* Feedback Banner */}
              {scanFeedback && (
                <div className={`smg-feedback-banner ${scanFeedback.type}`}>
                  {scanFeedback.type === 'success' && <CheckCircle2 size={16} />}
                  {scanFeedback.type === 'warning' && <AlertTriangle size={16} />}
                  {scanFeedback.type === 'error' && <AlertCircle size={16} />}
                  <span>{scanFeedback.message}</span>
                </div>
              )}

              {/* Scanned Serial List */}
              <div className="smg-items-header">
                <span className="smg-items-title">
                  <Package size={16} />
                  Nomor Seri di {activeBatch.name} ({activeBatch.serials?.length || 0})
                </span>
                {activeBatch.serials?.length > 0 && activeBatch.status !== 'completed' && (
                  <button
                    type="button"
                    className="smg-clear-batch-btn"
                    onClick={handleClearActiveBatchSerials}
                  >
                    Kosongkan Batch
                  </button>
                )}
              </div>

              <div className="smg-scanned-list">
                {activeBatch.serials?.length === 0 ? (
                  <div className="smg-empty-scan">
                    <Barcode size={36} opacity={0.4} />
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      Belum ada nomor seri yang di-scan untuk {activeBatch.name}.
                    </p>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      Arahkan barcode scanner fisik atau ketik nomor seri lalu tekan Enter.
                    </span>
                  </div>
                ) : (
                  activeBatch.serials.map((s, idx) => (
                    <div key={s.id || idx} className="smg-scanned-item">
                      <div className="smg-item-main">
                        <span className="smg-item-sn">{s.serialNumber || s.serial_number}</span>
                        <div className="smg-item-desc">
                          <span>{s.productName || s.product_name}</span>
                          <span className="smg-item-badge">{s.sku || '-'}</span>
                          <span className="smg-item-badge">{formatSerialQty(s)}</span>
                        </div>
                      </div>
                      {activeBatch.status !== 'completed' && (
                        <button
                          type="button"
                          className="smg-item-delete-btn"
                          onClick={() => handleRemoveSerial(s.id)}
                          title="Hapus dari batch"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* ── Right Column: Target Product & Live Preview ── */}
            <div className="smg-panel">
              <div className="smg-form-section">
                <label className="smg-field-label">
                  <Package size={15} />
                  Produk Hasil untuk {activeBatch.name}
                </label>

                {/* PHASE 7E — Auto-detect lock notice */}
                {activeBatchPolicy.productSelectionLocked && (
                  <div className="smg-lock-banner">
                    <Lock size={15} />
                    <span>
                      Semua serial berasal dari produk yang sama. Produk hasil dikunci mengikuti produk sumber
                      {lockedProductInfo ? ` (${lockedProductInfo.name})` : ''}.
                    </span>
                  </div>
                )}

                {/* PHASE 7E — Mixed batch source composition summary */}
                {activeBatchPolicy.distinctProductCount > 1 && (
                  <div className="smg-source-summary">
                    <div className="smg-source-summary-title">
                      <Layers size={14} />
                      <span>{activeBatchPolicy.distinctProductCount} produk sumber terlibat</span>
                    </div>
                    <div className="smg-source-chips">
                      {activeBatchPolicy.sourceProducts.map((sp) => (
                        <span key={sp.productId} className="smg-source-chip">
                          {sp.productName}
                          <em>{sp.serialCount} SN</em>
                        </span>
                      ))}
                    </div>
                    <span className="smg-source-hint">
                      Batch lintas produk: pilih produk hasil yang sudah ada atau buat master produk baru.
                    </span>
                  </div>
                )}

                <div className="smg-product-mode-tabs">
                  <button
                    type="button"
                    className={`smg-mode-btn ${!activeBatch.isNewProduct ? 'active' : ''}`}
                    onClick={() => updateActiveBatch({ isNewProduct: false })}
                    disabled={activeBatch.status === 'completed'}
                  >
                    Pilih Produk Master
                  </button>
                  <button
                    type="button"
                    className={`smg-mode-btn ${activeBatch.isNewProduct ? 'active' : ''}`}
                    onClick={() => updateActiveBatch({ isNewProduct: true })}
                    disabled={activeBatch.status === 'completed' || activeBatchPolicy.productSelectionLocked}
                    title={
                      activeBatchPolicy.productSelectionLocked
                        ? 'Semua serial berasal dari produk yang sama. Produk hasil dikunci mengikuti produk sumber.'
                        : undefined
                    }
                  >
                    Buat Master Produk Baru
                  </button>
                </div>

                {!activeBatch.isNewProduct || activeBatchPolicy.productSelectionLocked ? (
                  activeBatchPolicy.productSelectionLocked ? (
                    <div className="smg-product-locked-card">
                      <div className="smg-product-locked-main">
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                          {lockedProductInfo?.name || '-'}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                          SKU: {lockedProductInfo?.sku || '-'}
                        </span>
                      </div>
                      <span className="smg-product-locked-badge">
                        <Lock size={12} /> Terkunci
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {selectedTargetProduct && (
                        <div className="smg-product-selected-card">
                          <div>
                            <span className="smg-product-selected-name">{selectedTargetProduct.name}</span>
                            <span className="smg-product-selected-meta">
                              SKU: {selectedTargetProduct.sku || '-'} | {selectedTargetProduct.unit || 'pcs'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="smg-product-clear-btn"
                            onClick={() => {
                              updateActiveBatch({ targetProductId: '' });
                              setProductSearch('');
                            }}
                            disabled={activeBatch.status === 'completed'}
                          >
                            Ganti
                          </button>
                        </div>
                      )}
                      <input
                        type="text"
                        className="smg-product-search-input"
                        placeholder={selectedTargetProduct ? 'Cari produk pengganti...' : 'Ketik nama atau SKU produk hasil...'}
                        value={productSearch}
                        onChange={(e) => setProductSearch(e.target.value)}
                        disabled={activeBatch.status === 'completed'}
                      />
                      {productSearch.trim() && (
                        <div className="smg-product-select-list">
                          {filteredProducts.length === 0 ? (
                            <div className="smg-product-empty">Produk tidak ditemukan.</div>
                          ) : (
                            filteredProducts.map((p) => {
                              const isSelected = p.id === activeBatch.targetProductId;
                              return (
                                <div
                                  key={p.id}
                                  className={`smg-product-option ${isSelected ? 'selected' : ''}`}
                                  onClick={() => {
                                    if (activeBatch.status !== 'completed') {
                                      handleSelectProduct(p);
                                    }
                                  }}
                                >
                                  <span style={{ fontSize: '0.85rem' }}>{p.name}</span>
                                  <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                                    SKU: {p.sku || '-'} | {p.unit || 'pcs'}
                                  </span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                      {!productSearch.trim() && !selectedTargetProduct && (
                        <div className="smg-product-empty">
                          Ketik untuk mencari produk. Daftar tidak ditampilkan sebelum ada pencarian.
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="smg-product-search-input"
                      placeholder="Nama produk hasil grouping baru (wajib)..."
                      value={activeBatch.newProductName || ''}
                      onChange={(e) => updateActiveBatch({ newProductName: e.target.value })}
                      disabled={activeBatch.status === 'completed'}
                    />
                    <input
                      type="text"
                      className="smg-product-search-input"
                      placeholder="SKU produk baru (opsional)..."
                      value={activeBatch.newProductSku || ''}
                      onChange={(e) => updateActiveBatch({ newProductSku: e.target.value })}
                      disabled={activeBatch.status === 'completed'}
                    />
                  </div>
                )}
              </div>

              {/* Target Unit Selector */}
              <div className="smg-form-section">
                <label className="smg-field-label">
                  <Sparkles size={15} />
                  Satuan Target Hasil Grouping
                </label>
                <div className="smg-unit-grid">
                  {CANONICAL_UNITS.map((u) => (
                    <button
                      key={u.value}
                      type="button"
                      className={`smg-unit-btn ${activeBatch.targetUnit === u.value ? 'active' : ''}`}
                      onClick={() => updateActiveBatch({ targetUnit: u.value })}
                      disabled={activeBatch.status === 'completed'}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Preview Card */}
              <div className="smg-preview-card">
                <div className="smg-preview-header">
                  <span>Kalkulasi & Preview Otomatis</span>
                  {activeBatch.previewLoading && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.775rem', color: '#2563eb' }}>
                      <Loader2 size={13} className="spin" /> Menghitung...
                    </span>
                  )}
                </div>

                <div className="smg-preview-metrics-grid">
                  <div className="smg-metric-box">
                    <span className="smg-metric-label">Komponen</span>
                    <span className="smg-metric-val">{activeBatch.serials?.length || 0} SN</span>
                  </div>
                  <div className="smg-metric-box">
                    <span className="smg-metric-label">Kuantitas Dasar</span>
                    <span className="smg-metric-val">
                      {activeBatch.previewData?.totalBaseQtyPcs ?? (activeBatch.serials?.reduce((sum, s) => sum + (s.pcs || 1), 0) || 0)} pcs
                    </span>
                  </div>
                  <div className="smg-metric-box">
                    <span className="smg-metric-label">Hasil Grouping</span>
                    <span className="smg-metric-val" style={{ color: 'var(--color-interactive, #2563eb)' }}>
                      {activeBatch.previewData?.targetQty ?? 0} {activeBatch.targetUnit}
                    </span>
                  </div>
                  <div className="smg-metric-box">
                    <span className="smg-metric-label">Rincian Komposisi</span>
                    <span className="smg-metric-val" style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                      {activeBatch.previewData?.unitBreakdown || '0 pcs'}
                    </span>
                  </div>
                </div>

                {/* Candidate Serial Result */}
                <div className="smg-candidate-serial-box">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                    <span style={{ fontSize: '0.725rem', color: '#64748b', fontWeight: 600 }}>
                      Serial Hasil yang Akan Dibuat:
                    </span>
                    {editingGroupSerialBatchId === activeBatch.id ? (
                      <div className="smg-candidate-edit">
                        <input
                          className="smg-candidate-input"
                          value={groupSerialDraft}
                          onChange={(e) => setGroupSerialDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              saveGroupSerial();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelEditGroupSerial();
                            }
                          }}
                          maxLength={160}
                          autoFocus
                          aria-label="Serial hasil grouping"
                        />
                        <button
                          type="button"
                          className="smg-candidate-icon-btn primary"
                          onClick={saveGroupSerial}
                          title="Simpan serial"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="smg-candidate-icon-btn"
                          onClick={cancelEditGroupSerial}
                          title="Batal"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <span className="smg-candidate-sn">
                        {getEffectiveGroupSerial(activeBatch) || '-'}
                      </span>
                    )}
                  </div>
                  <div className="smg-candidate-right">
                    {activeBatch.status !== 'completed' && editingGroupSerialBatchId !== activeBatch.id && (
                      <>
                        {activeBatch.groupSerialNumber && (
                          <button
                            type="button"
                            className="smg-candidate-action"
                            onClick={resetGroupSerialToAuto}
                            title="Gunakan serial otomatis"
                          >
                            <RotateCcw size={12} />
                            Otomatis
                          </button>
                        )}
                        <button
                          type="button"
                          className="smg-candidate-action"
                          onClick={startEditGroupSerial}
                          title="Ubah serial hasil"
                        >
                          <Pencil size={12} />
                          Ubah
                        </button>
                      </>
                    )}
                    <span className="smg-candidate-badge">
                      {activeBatch.status === 'completed'
                        ? 'Final Resmi'
                        : activeBatch.groupSerialNumber
                          ? 'Serial Kustom'
                          : 'Kandidat Otomatis'}
                    </span>
                  </div>
                </div>

                {/* Unit Mismatch / Residue Error */}
                {activeBatch.previewError && (
                  <div className="smg-feedback-banner error" style={{ margin: 0 }}>
                    <AlertCircle size={15} />
                    <span>{activeBatch.previewError.message}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Bottom Section: All Batches Review ── */}
          <div className="smg-bottom-review">
            <div className="smg-review-header">
              <span className="smg-review-title">
                <Layers size={17} />
                Daftar Seluruh Batch Sesi ({batches.length} Batch, {totalScannedCount} Total SN)
              </span>
              <span style={{ fontSize: '0.825rem', color: '#64748b' }}>
                Batch valid akan diproses independen tanpa saling mengunci.
              </span>
            </div>

            <div className="smg-batches-table-wrapper">
              <table className="smg-batches-table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Komponen (SN)</th>
                    <th>Produk Hasil & Satuan</th>
                    <th>Serial Hasil</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const isActive = b.id === activeBatchId;
                    const bPolicy = computeSourceProductPolicy(b.serials);
                    const pName = b.isNewProduct
                      ? (b.newProductName || 'Produk Baru')
                      : (products.find((p) => p.id === b.targetProductId)?.name
                        || bPolicy.sourceProducts.find((sp) => sp.productId === b.targetProductId)?.productName
                        || '-');
                    const serialDisplay = getEffectiveGroupSerial(b) || '-';

                    return (
                      <tr key={b.id} className={isActive ? 'active-row' : ''}>
                        <td style={{ fontWeight: 600 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            {isActive && <ArrowRight size={13} color="var(--color-interactive, #2563eb)" />}
                            {b.name}
                          </span>
                        </td>
                        <td>{b.serials?.length || 0} SN</td>
                        <td>
                          {bPolicy.productSelectionLocked && (
                            <Lock
                              size={11}
                              style={{ marginRight: 4, verticalAlign: 'middle' }}
                              title="Produk hasil dikunci mengikuti produk sumber"
                            />
                          )}
                          {pName} ({b.previewData?.targetQty ?? 0} {b.targetUnit})
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.825rem' }}>
                          {serialDisplay}
                        </td>
                        <td>
                          {b.status === 'completed' && (
                            <span className="smg-status-badge completed">
                              <CheckCircle2 size={12} /> Sukses Diproses
                            </span>
                          )}
                          {b.status === 'failed' && (
                            <span className="smg-status-badge failed">
                              <AlertCircle size={12} /> Gagal: {b.processError || 'Error'}
                            </span>
                          )}
                          {b.status === 'valid' && (
                            <span className="smg-status-badge valid">
                              <CheckCircle2 size={12} /> Siap Diproses
                            </span>
                          )}
                          {b.status === 'incomplete' && (
                            <span className="smg-status-badge incomplete">
                              <Info size={12} /> Belum Lengkap
                            </span>
                          )}
                          {b.status === 'invalid' && (
                            <span className="smg-status-badge invalid">
                              <AlertTriangle size={12} /> Sisa Satuan
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="smg-refocus-btn"
                            onClick={() => handleSelectBatch(b.id)}
                            style={{ marginRight: '6px' }}
                          >
                            Pilih
                          </button>
                          {batches.length > 1 && b.status !== 'completed' && (
                            <button
                              type="button"
                              className="smg-clear-batch-btn"
                              onClick={(e) => handleDeleteBatch(b.id, e)}
                            >
                              Hapus
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          </div>
        </div>

        {/* ── Footer Actions ── */}
        <div className="smg-footer">
          <div className="smg-footer-summary">
            <span>
              Total Sesi: <strong>{totalScannedCount} SN</strong>
            </span>
            <span>
              Batch Siap: <strong>{pendingReadyBatches.length} dari {batches.length}</strong>
            </span>
            {!canSavePending && batches.length > 0 && (
              <span className="smg-footer-warning">
                {pendingIssues[0]?.issue || 'Lengkapi semua batch sebelum menyimpan sesi.'}
              </span>
            )}
          </div>

          <div className="smg-footer-actions">
            <button type="button" className="smg-btn-secondary" onClick={handleClose} disabled={isProcessing}>
              Tutup
            </button>
            <button
              type="button"
              className="smg-btn-primary"
              onClick={handleSavePendingSession}
              disabled={!canSavePending || isProcessing}
              title="Tinjau lalu simpan sesi sebagai Pending"
            >
              {isProcessing ? (
                <>
                  <Loader2 size={16} className="spin" />
                  <span>Menyimpan Sesi...</span>
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  <span>Simpan Sesi (Pending)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {showPendingReview && (
          <div className="smg-review-overlay" role="presentation">
            <div
              className="smg-review-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="smg-review-title"
            >
              <div className="smg-review-header">
                <div>
                  <h3 id="smg-review-title">Tinjau Sesi Pending</h3>
                  <p>
                    Sesi: <strong>{sessionName?.trim() || 'Grouping Multi-Batch'}</strong> | Gudang: <strong>{warehouses.find((w) => w.id === selectedWarehouseId)?.name || 'Gudang Utama'}</strong> ({batches.length} Batch)
                  </p>
                </div>
                <button
                  type="button"
                  className="smg-icon-btn"
                  onClick={() => setShowPendingReview(false)}
                  disabled={isProcessing}
                  aria-label="Tutup tinjauan"
                >
                  <X size={18} />
                </button>
              </div>

              {sessionSaveError && (
                <div className="smg-feedback-banner error" style={{ margin: 0 }}>
                  <AlertCircle size={16} />
                  <span>{sessionSaveError}</span>
                </div>
              )}

              <div className="smg-review-body">
                {batches.map((b) => {
                  const targetProduct = getBatchTargetProduct(b);
                  const policy = computeSourceProductPolicy(b.serials);
                  const groupSerial = getEffectiveGroupSerial(b);
                  return (
                    <div className="smg-review-batch" key={b.id}>
                      <div className="smg-review-batch-head">
                        <strong>{b.name}</strong>
                        <span className="smg-review-pill">{b.status === 'valid' ? 'Siap' : b.status}</span>
                      </div>
                      <div className="smg-review-row">
                        <span>Produk hasil</span>
                        <strong>
                          {targetProduct?.name || '—'}
                          {targetProduct?.sku ? ` (SKU: ${targetProduct.sku})` : ''}
                        </strong>
                      </div>
                      <div className="smg-review-row">
                        <span>Target</span>
                        <strong>
                          {b.previewData?.targetQty ?? 1} {b.targetUnit || 'pcs'}
                          {b.previewData?.totalPcs ? ` = ${b.previewData.totalPcs} pcs` : ''}
                        </strong>
                      </div>
                      <div className="smg-review-row">
                        <span>Nomor seri grup</span>
                        <strong>{groupSerial || 'Otomatis'}</strong>
                      </div>
                      <div className="smg-review-row smg-review-row-block">
                        <span>Komponen ({b.serials.length} SN)</span>
                        <div className="smg-review-serials">
                          {b.serials.map((s) => (
                            <span key={s.id} className="smg-review-serial-chip">
                              {s.serialNumber}
                            </span>
                          ))}
                        </div>
                      </div>
                      {(policy.distinctProductCount > 1 || b.isNewProduct) && (
                        <div className="smg-review-note">
                          {policy.distinctProductCount > 1 ? 'Komposisi lintas produk. ' : ''}
                          {b.isNewProduct ? 'Master produk baru akan dibuat. ' : ''}
                          Pastikan produk hasil sudah benar.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="smg-review-actions">
                <button
                  type="button"
                  className="smg-btn-secondary"
                  onClick={() => setShowPendingReview(false)}
                  disabled={isProcessing}
                >
                  Kembali untuk Mengedit
                </button>
                <button
                  type="button"
                  className="smg-btn-primary"
                  onClick={submitPendingSession}
                  disabled={!canSavePending || isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 size={16} className="spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} />
                      <span>Konfirmasi &amp; Simpan Pending</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

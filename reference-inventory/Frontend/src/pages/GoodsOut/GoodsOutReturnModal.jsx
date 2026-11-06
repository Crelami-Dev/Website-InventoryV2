import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X,
  Camera,
  Check,
  AlertCircle,
  AlertTriangle,
  Barcode,
  RotateCcw,
  Search,
  FileText,
  Calendar,
  User,
  Warehouse,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { useCameraScanner } from '../../hooks/useCameraScanner.js';
import { useApp } from '../../context/AppContext.jsx';
import { api } from '../../utils/api.js';
import './GoodsOutReturnModal.css';
import './GoodsOutCreateModal.css'; // reuse scanner overlay styles

// Audio feedback
function playBeep(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(950, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.1);
      if (navigator?.vibrate) navigator.vibrate(50);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(370, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.22);
      if (navigator?.vibrate) navigator.vibrate([60, 40, 60]);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
      if (navigator?.vibrate) navigator.vibrate([100, 50, 100]);
    }
  } catch (_) {}
}

const RETURN_REASONS = [
  { key: 'salah_produk', label: 'Salah Produk', desc: 'Produk yang dikirim tidak sesuai pesanan' },
  { key: 'cacat_produk', label: 'Cacat / Rusak', desc: 'Produk dalam kondisi cacat atau rusak' },
  { key: 'batal_beli', label: 'Batal / Gak Jadi', desc: 'Pembeli membatalkan pembelian' },
  { key: 'lainnya', label: 'Lainnya', desc: 'Alasan lain (wajib isi catatan)' },
];

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

export default function GoodsOutReturnModal({ doc: initialDoc = null, onClose, onSuccess }) {
  const { t } = useApp();
  const queryClient = useQueryClient();

  // Document selection state
  const [selectedDoc, setSelectedDoc] = useState(initialDoc);
  const [docSearch, setDocSearch] = useState('');

  // Form states
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Worksheet state:
  // nonSerialQuantities: { [key]: { goodQty: number|string, damagedQty: number|string } }
  const [nonSerialQuantities, setNonSerialQuantities] = useState({});
  // serialSelection: { [key]: { selected: boolean, condition: 'available' | 'damaged' } }
  const [serialSelection, setSerialSelection] = useState({});

  // Scanner state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState(null);
  const scanCallbackRef = useRef(null);
  const cooldownMapRef = useRef(new Map());

  // Query completed Goods Out documents if no document is initially provided
  const {
    data: candidateDocsData,
    isLoading: candidateDocsLoading,
    refetch: refetchCandidateDocs,
  } = useQuery({
    queryKey: ['goods-out-return-candidates', docSearch],
    queryFn: async () => {
      const params = new URLSearchParams({
        type: 'goods_out',
        status: 'completed',
        limit: '20',
      });
      if (docSearch.trim()) params.set('search', docSearch.trim());
      const res = await api.get(`/api/workspace/documents?${params.toString()}`);
      if (!res.ok) throw new Error('Gagal memuat daftar surat jalan');
      return res.json();
    },
    enabled: !selectedDoc,
    staleTime: 20000,
  });

  const candidateDocs = candidateDocsData?.data || [];

  // Parse items & returns from currently selected document
  const items = useMemo(() => {
    if (!selectedDoc) return [];
    if (selectedDoc.items && selectedDoc.items.length > 0) return selectedDoc.items;
    return selectedDoc.metadata?.items ?? [];
  }, [selectedDoc]);

  const existingReturns = useMemo(() => {
    return selectedDoc?.metadata?.returns ?? [];
  }, [selectedDoc]);

  // Build lookup of returnable items from document
  const docItemsMap = useMemo(() => {
    if (!selectedDoc) return {};
    const map = {};

    items.forEach((item, idx) => {
      const itemId = item.id;
      const productId = item.product_id ?? item.productId;
      const isSerial = item.metadata?.isSerial === true;
      const isGroup = item.metadata?.isGroup === true || item.metadata?.targetQty != null;
      const serialNumber = item.metadata?.serialNumber || '';
      let qtyUnit = item.metadata?.targetUnit || item.metadata?.qtyUnit || item.unit || 'pcs';
      const snLower = String(serialNumber).toLowerCase();

      if (isSerial && !isGroup) {
        if (snLower.includes('10bl') || snLower.includes('bal10')) qtyUnit = 'bal10';
        else if (snLower.includes('15bl') || snLower.includes('bal15')) qtyUnit = 'bal15';
        else if (snLower.includes('20bl') || snLower.includes('bal20')) qtyUnit = 'bal20';
        else if (snLower.includes('25bl') || snLower.includes('bal25')) qtyUnit = 'bal25';
        else if (snLower.includes('bal') || snLower.includes('bl')) qtyUnit = 'bal';
        else if (snLower.includes('pack')) qtyUnit = 'pack';
        else if (snLower.includes('lusin') || snLower.includes('lsn')) qtyUnit = 'lusin';
      }

      const qtyInput = isSerial
        ? (isGroup ? Number(item.metadata?.targetQty ?? item.metadata?.qtyInput ?? 1) || 1 : 1)
        : Number(item.metadata?.qtyInput ?? item.quantity ?? 1);

      // Calculate previously returned qty for this item from non-restored returns
      const previouslyReturned = existingReturns.reduce((sum, r) => {
        if (r.status === 'restored') return sum;
        return (
          sum +
          (r.items ?? [])
            .filter((ri) => {
              if (isSerial) {
                if (ri.isSerial) {
                  return String(ri.serialNumber || '').trim().toLowerCase() === serialNumber.trim().toLowerCase();
                }
                return false;
              }
              if (ri.isSerial) return false;
              if (itemId && ri.itemId) return ri.itemId === itemId;
              if (!itemId && !ri.itemId && productId && ri.productId) return ri.productId === productId;
              return false;
            })
            .reduce((s, ri) => s + Number(ri.returnedQty || 0), 0)
        );
      }, 0);

      const key = isSerial ? `serial_${serialNumber || idx}` : `item_${itemId || productId || idx}`;

      map[key] = {
        key,
        itemId,
        productId,
        productName: item.item_name || item.itemName || 'Produk Tanpa Nama',
        sku: item.sku || '—',
        isSerial,
        isGroup,
        serialNumber,
        qtyUnit,
        originalQty: qtyInput,
        previouslyReturned,
        remainingQty: isGroup && previouslyReturned > 0
          ? 0
          : Math.max(0, qtyInput - previouslyReturned),
      };
    });

    return map;
  }, [selectedDoc, items, existingReturns]);

  // List of returnable items (remainingQty > 0)
  const returnableItems = useMemo(() => {
    return Object.entries(docItemsMap)
      .filter(([, v]) => v.remainingQty > 0)
      .map(([key, v]) => ({ key, ...v }));
  }, [docItemsMap]);

  const serialItems = useMemo(() => returnableItems.filter((it) => it.isSerial), [returnableItems]);
  const nonSerialItems = useMemo(() => returnableItems.filter((it) => !it.isSerial), [returnableItems]);

  // Check if worksheet has any active input
  const isWorksheetDirty = useMemo(() => {
    const hasSerial = Object.values(serialSelection).some((s) => s?.selected);
    const hasNonSerial = Object.values(nonSerialQuantities).some(
      (q) => (Number(q?.goodQty) || 0) > 0 || (Number(q?.damagedQty) || 0) > 0
    );
    return hasSerial || hasNonSerial;
  }, [serialSelection, nonSerialQuantities]);

  // Handle changing document with confirmation
  const handleChangeDoc = () => {
    if (isWorksheetDirty) {
      const confirmChange = window.confirm(
        'Worksheet retur yang sudah Anda isi akan dikosongkan jika Anda mengganti surat jalan. Lanjutkan?'
      );
      if (!confirmChange) return;
    }
    setNonSerialQuantities({});
    setSerialSelection({});
    cooldownMapRef.current.clear();
    setError(null);
    setSelectedDoc(null);
  };

  // Handle selecting candidate document
  const handleSelectDoc = (docCandidate) => {
    setSelectedDoc(docCandidate);
    setNonSerialQuantities({});
    setSerialSelection({});
    cooldownMapRef.current.clear();
    setError(null);
  };

  // Toggle single serial item
  const handleToggleSerial = (key) => {
    setSerialSelection((prev) => {
      const current = prev[key];
      const isSelected = !!current?.selected;
      return {
        ...prev,
        [key]: {
          selected: !isSelected,
          condition: current?.condition || 'available',
        },
      };
    });
  };

  // Set condition for single serial item
  const handleSerialCondition = (key, condition) => {
    setSerialSelection((prev) => ({
      ...prev,
      [key]: {
        selected: true,
        condition,
      },
    }));
  };

  // Toggle all serial items
  const isAllSerialSelected =
    serialItems.length > 0 && serialItems.every((it) => !!serialSelection[it.key]?.selected);

  const handleToggleAllSerials = () => {
    if (isAllSerialSelected) {
      setSerialSelection({});
    } else {
      const next = {};
      serialItems.forEach((it) => {
        next[it.key] = {
          selected: true,
          condition: serialSelection[it.key]?.condition || 'available',
        };
      });
      setSerialSelection(next);
    }
  };

  // Handle quantity changes for non-serial items
  const handleNonSerialQtyChange = (key, conditionType, val) => {
    const item = docItemsMap[key];
    if (!item) return;

    const numVal = val === '' ? '' : Math.max(0, parseFloat(val) || 0);

    setNonSerialQuantities((prev) => {
      const current = prev[key] || { goodQty: 0, damagedQty: 0 };
      return {
        ...prev,
        [key]: {
          ...current,
          [conditionType === 'good' ? 'goodQty' : 'damagedQty']: numVal,
        },
      };
    });
  };

  // Fill all non-serial remaining into Good Condition
  const handleFillAllNonSerialGood = () => {
    const next = {};
    nonSerialItems.forEach((it) => {
      next[it.key] = {
        goodQty: it.remainingQty,
        damagedQty: 0,
      };
    });
    setNonSerialQuantities(next);
  };

  // Clear all non-serial quantities
  const handleClearNonSerial = () => {
    setNonSerialQuantities({});
  };

  // Scanner detection logic
  const handleScanResult = useCallback(
    (code) => {
      if (!code) return;
      const cleanCode = code.trim();
      if (!cleanCode) return;
      const cleanCodeLower = cleanCode.toLowerCase();

      // Cooldown: suppress duplicate triggers within 2.5s
      const now = Date.now();
      const lastScan = cooldownMapRef.current.get(cleanCodeLower);
      if (lastScan && now - lastScan < 2500) return;
      cooldownMapRef.current.set(cleanCodeLower, now);

      // Match against returnable items in this document
      const matchedEntry = returnableItems.find((item) => {
        if (item.isSerial) {
          return String(item.serialNumber).trim().toLowerCase() === cleanCodeLower;
        }
        return String(item.sku || '').trim().toLowerCase() === cleanCodeLower;
      });

      if (!matchedEntry) {
        playBeep('error');
        setScanFeedback({
          type: 'error',
          message: `QR / SKU "${cleanCode}" tidak ditemukan dalam Surat Jalan ini`,
        });
        return;
      }

      if (matchedEntry.isSerial) {
        const isSelected = !!serialSelection[matchedEntry.key]?.selected;
        if (isSelected) {
          playBeep('warning');
          setScanFeedback({
            type: 'warning',
            message: `Nomor seri "${cleanCode}" SUDAH dipilih!`,
          });
          return;
        }

        setSerialSelection((prev) => ({
          ...prev,
          [matchedEntry.key]: { selected: true, condition: 'available' },
        }));
        playBeep('success');
        setScanFeedback({
          type: 'success',
          message: `Serial ${matchedEntry.serialNumber} (${matchedEntry.productName}) dipilih (Kondisi Baik)`,
        });
      } else {
        // Non-serial SKU matched: increment goodQty
        const current = nonSerialQuantities[matchedEntry.key] || { goodQty: 0, damagedQty: 0 };
        const curGood = Number(current.goodQty) || 0;
        const curDamaged = Number(current.damagedQty) || 0;

        if (curGood + curDamaged >= matchedEntry.remainingQty) {
          playBeep('error');
          setScanFeedback({
            type: 'error',
            message: `Qty return untuk "${matchedEntry.productName}" sudah mencapai batas sisa (${matchedEntry.remainingQty} ${matchedEntry.qtyUnit})`,
          });
          return;
        }

        const nextGood = curGood + 1;
        setNonSerialQuantities((prev) => ({
          ...prev,
          [matchedEntry.key]: { ...current, goodQty: nextGood },
        }));
        playBeep('success');
        setScanFeedback({
          type: 'success',
          message: `${matchedEntry.productName} — Qty Baik: ${nextGood} ${matchedEntry.qtyUnit}`,
        });
      }
    },
    [returnableItems, serialSelection, nonSerialQuantities]
  );

  useEffect(() => {
    scanCallbackRef.current = handleScanResult;
  }, [handleScanResult]);

  useEffect(() => {
    if (scannerOpen) setScanFeedback(null);
  }, [scannerOpen]);

  const handleScannerError = useCallback((message) => {
    setScanFeedback({ type: 'error', message });
  }, []);

  const { cameraActive, frameHit } = useCameraScanner({
    elementId: 'go-return-scanner-reader',
    active: scannerOpen,
    fps: 12,
    onDecode: (text) => scanCallbackRef.current?.(text),
    onError: handleScannerError,
  });

  const handleOpenScanner = () => {
    cooldownMapRef.current.clear();
    setScannerOpen(true);
  };

  const handleManualAdd = (e) => {
    if (e) e.preventDefault();
    if (!manualInput.trim()) return;
    handleScanResult(manualInput.trim());
    setManualInput('');
  };

  // Calculate return payload & validation checks
  const { payloadItems, hasExceededLimit, totalReturnUnits, selectedSerialCount, selectedNonSerialCount } =
    useMemo(() => {
      const itemsList = [];
      let exceeded = false;
      let totalUnits = 0;
      let sCount = 0;
      let nsCount = 0;

      // 1. Process Serials
      serialItems.forEach((it) => {
        const sel = serialSelection[it.key];
        if (sel?.selected) {
          sCount++;
          totalUnits += it.originalQty;
          itemsList.push({
            productId: it.productId || null,
            itemId: it.itemId || null,
            isSerial: true,
            isGroup: it.isGroup,
            serialNumber: it.serialNumber || null,
            returnedQty: it.originalQty,
            qtyUnit: it.qtyUnit,
            targetQty: it.isGroup ? it.originalQty : undefined,
            targetUnit: it.isGroup ? it.qtyUnit : undefined,
            targetStatus: sel.condition === 'damaged' ? 'damaged' : 'available',
          });
        }
      });

      // 2. Process Non-Serials
      nonSerialItems.forEach((it) => {
        const q = nonSerialQuantities[it.key] || { goodQty: 0, damagedQty: 0 };
        const gQty = Number(q.goodQty) || 0;
        const dQty = Number(q.damagedQty) || 0;

        if (gQty < 0 || dQty < 0 || gQty + dQty > it.remainingQty) {
          exceeded = true;
        }

        if (gQty > 0) {
          totalUnits += gQty;
          nsCount++;
          itemsList.push({
            productId: it.productId || null,
            itemId: it.itemId || null,
            isSerial: false,
            returnedQty: gQty,
            qtyUnit: it.qtyUnit,
            targetStatus: 'available',
          });
        }

        if (dQty > 0) {
          totalUnits += dQty;
          nsCount++;
          itemsList.push({
            productId: it.productId || null,
            itemId: it.itemId || null,
            isSerial: false,
            returnedQty: dQty,
            qtyUnit: it.qtyUnit,
            targetStatus: 'damaged',
          });
        }
      });

      return {
        payloadItems: itemsList,
        hasExceededLimit: exceeded,
        totalReturnUnits: totalUnits,
        selectedSerialCount: sCount,
        selectedNonSerialCount: nsCount,
      };
    }, [serialItems, nonSerialItems, serialSelection, nonSerialQuantities]);

  const canSubmit =
    !!selectedDoc &&
    !!reason &&
    payloadItems.length > 0 &&
    !hasExceededLimit &&
    (reason !== 'lainnya' || notes.trim().length >= 3);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const hasDamaged = payloadItems.some((it) => it.targetStatus === 'damaged');
      const hasAvailable = payloadItems.some((it) => it.targetStatus === 'available');
      const overallTargetStatus = hasAvailable ? 'available' : 'damaged';

      const payload = {
        reason,
        notes: notes.trim() || null,
        targetStatus: overallTargetStatus,
        markAsDamaged: hasDamaged,
        items: payloadItems,
      };

      const res = await api.post(`/api/workspace/documents/${selectedDoc.id}/return`, payload);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || errJson?.message || 'Gagal memproses return');
      }

      const json = await res.json();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['goods-out'] }),
        queryClient.invalidateQueries({ queryKey: ['returns-list'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-serials'] }),
        queryClient.invalidateQueries({ queryKey: ['product-serial-index'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
      ]);

      onSuccess?.(json.data);
    } catch (err) {
      setError(err.message || 'Gagal memproses return');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="go-return-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="go-return-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="go-return-modal" style={{ maxWidth: selectedDoc ? '840px' : '640px' }}>
        {/* Header */}
        <div className="go-return__header">
          <div className="go-return__header-icon">
            <RotateCcw size={18} />
          </div>
          <div className="go-return__header-text">
            <h2 id="go-return-title" className="go-return__title">
              {selectedDoc ? 'Buat Retur Barang Keluar' : 'Pilih Surat Jalan Sumber Retur'}
            </h2>
            <p className="go-return__ref">
              {selectedDoc ? selectedDoc.document_number : 'Langkah 1: Tentukan dokumen Goods Out yang dikembalikan'}
            </p>
          </div>
          <button type="button" className="go-return__close-btn" onClick={onClose} disabled={submitting}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="go-return__body">
          {/* SCENARIO A: Document Picker (If no document selected) */}
          {!selectedDoc ? (
            <div className="go-return__doc-picker">
              <div className="go-return__doc-picker-header">
                <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                  Hanya surat jalan berstatus <strong>Selesai (Completed)</strong> yang dapat diproses retur.
                </div>
                <div className="returns-search" style={{ marginTop: '8px' }}>
                  <Search size={15} className="returns-search__icon" />
                  <input
                    type="text"
                    className="returns-search__input"
                    placeholder="Cari nomor surat jalan, nama customer / penerima..."
                    value={docSearch}
                    onChange={(e) => setDocSearch(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>

              {candidateDocsLoading ? (
                <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--color-text-muted)' }}>
                  <RefreshCw size={20} className="gi-detail__spin" style={{ marginBottom: '8px' }} />
                  <div>Memuat daftar surat jalan...</div>
                </div>
              ) : candidateDocs.length === 0 ? (
                <div className="go-return__empty">
                  <FileText size={32} className="go-return__empty-icon" />
                  <p>Tidak ditemukan surat jalan selesai yang cocok.</p>
                </div>
              ) : (
                <div className="go-return__doc-list">
                  {candidateDocs.map((cand) => {
                    const itemCount = (cand.items?.length || cand.metadata?.items?.length || 0);
                    const contactName =
                      cand.contact_name ||
                      cand.contactName ||
                      cand.metadata?.contactName ||
                      cand.metadata?.recipientName ||
                      '—';
                    const warehouseName =
                      cand.warehouse_name || cand.warehouseName || cand.metadata?.warehouseName || 'Gudang Utama';

                    return (
                      <div
                        key={cand.id}
                        className="go-return__doc-item"
                        onClick={() => handleSelectDoc(cand)}
                      >
                        <div className="go-return__doc-info">
                          <span className="go-return__doc-num">{cand.document_number}</span>
                          <div className="go-return__doc-meta">
                            <span>
                              <Calendar size={12} style={{ display: 'inline', verticalAlign: '-1px' }} />{' '}
                              {formatDate(cand.created_at)}
                            </span>
                            <span>•</span>
                            <span>
                              <User size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> {contactName}
                            </span>
                            <span>•</span>
                            <span>
                              <Warehouse size={12} style={{ display: 'inline', verticalAlign: '-1px' }} />{' '}
                              {warehouseName}
                            </span>
                            <span>•</span>
                            <span className="chip chip-neutral chip-sm">{itemCount} jenis item</span>
                          </div>
                        </div>
                        <button type="button" className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
                          <span>Pilih</span>
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* SCENARIO B: Return Worksheet */
            <>
              {/* Selected Document Banner */}
              <div className="go-return__selected-banner">
                <div className="go-return__selected-info">
                  <span className="go-return__selected-badge">{selectedDoc.document_number}</span>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    {formatDate(selectedDoc.created_at)} •{' '}
                    <strong>
                      {selectedDoc.contact_name ||
                        selectedDoc.metadata?.contactName ||
                        selectedDoc.metadata?.recipientName ||
                        'Customer'}
                    </strong>{' '}
                    ({selectedDoc.warehouse_name || 'Gudang'})
                  </span>
                </div>
                {!initialDoc && (
                  <button type="button" className="go-return__change-doc-btn" onClick={handleChangeDoc}>
                    Ganti Surat Jalan
                  </button>
                )}
              </div>

              {/* Step 1: Reason */}
              <fieldset className="go-return__reasons">
                <legend className="go-return__reasons-label">1. Pilih Alasan Return</legend>
                <div className="go-return__reason-options">
                  {RETURN_REASONS.map((r) => (
                    <label
                      key={r.key}
                      className={`go-return__reason-option${
                        reason === r.key ? ' go-return__reason-option--selected' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="return-reason"
                        value={r.key}
                        checked={reason === r.key}
                        onChange={() => setReason(r.key)}
                        className="go-return__reason-radio"
                      />
                      <span>{r.label}</span>
                    </label>
                  ))}
                </div>

                {reason === 'lainnya' && (
                  <div className="go-return__note-wrap">
                    <label className="go-return__note-label">Jelaskan alasan return (wajib diisi)</label>
                    <textarea
                      className="input go-return__note"
                      placeholder="Contoh: Barang cacat dari pengiriman ekspedisi..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={2}
                      autoFocus
                    />
                  </div>
                )}
              </fieldset>

              {/* Step 2: Worksheet Items */}
              <div className="go-return__scan-section">
                <div className="go-return__scan-header">
                  <h4 className="go-return__scan-title">
                    2. Worksheet Retur (Tentukan Kondisi per Produk)
                    {payloadItems.length > 0 && (
                      <span className="go-return__scan-badge">
                        {totalReturnUnits} unit dipilih ({payloadItems.length} baris payload)
                      </span>
                    )}
                  </h4>
                  <button type="button" className="go-return__scan-btn" onClick={handleOpenScanner}>
                    <Camera size={14} />
                    <span>Scan QR</span>
                  </button>
                </div>

                {/* Manual Input */}
                <form onSubmit={handleManualAdd} className="go-return__manual-form">
                  <input
                    type="text"
                    className="input go-return__manual-input"
                    placeholder="Scan QR / ketik nomor seri / SKU manual..."
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-secondary go-return__manual-btn">
                    Pindai
                  </button>
                </form>

                {returnableItems.length === 0 ? (
                  <div className="go-return__empty">
                    <Barcode size={32} className="go-return__empty-icon" />
                    <p>Semua item pada surat jalan ini sudah diretur sebelumnya.</p>
                  </div>
                ) : (
                  <>
                    {/* SECTION 2A: NON-SERIAL ITEMS */}
                    {nonSerialItems.length > 0 && (
                      <div style={{ marginTop: '8px' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '6px',
                          }}
                        >
                          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                            Barang Non-Serial ({nonSerialItems.length} produk)
                          </span>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              type="button"
                              className="go-return__toolbar-btn"
                              onClick={handleFillAllNonSerialGood}
                            >
                              Semua Kondisi Baik
                            </button>
                            <button
                              type="button"
                              className="go-return__toolbar-btn"
                              onClick={handleClearNonSerial}
                            >
                              Kosongkan
                            </button>
                          </div>
                        </div>

                        <div className="go-return__items-desktop">
                          <table className="go-return__items-table">
                            <thead>
                              <tr>
                                <th style={{ width: '28%' }}>Produk</th>
                                <th style={{ width: '14%' }}>SKU</th>
                                <th style={{ width: '12%', textAlign: 'right' }}>Kirim Awal</th>
                                <th style={{ width: '12%', textAlign: 'right' }}>Retur Lalu</th>
                                <th style={{ width: '12%', textAlign: 'right' }}>Sisa Kuota</th>
                                <th style={{ width: '22%', textAlign: 'right' }}>Input Retur (Baik / Rusak)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {nonSerialItems.map((item) => {
                                const q = nonSerialQuantities[item.key] || { goodQty: '', damagedQty: '' };
                                const gQty = q.goodQty === '' ? 0 : Number(q.goodQty);
                                const dQty = q.damagedQty === '' ? 0 : Number(q.damagedQty);
                                const rowTotal = gQty + dQty;
                                const isRowExceeded = rowTotal > item.remainingQty;
                                const isRowSelected = rowTotal > 0;

                                return (
                                  <tr
                                    key={item.key}
                                    className={isRowSelected ? 'go-return__item--selected' : ''}
                                    style={isRowExceeded ? { background: 'var(--color-danger-surface)' } : {}}
                                  >
                                    <td className="go-return__td-product">
                                      <span>{item.productName}</span>
                                      {isRowExceeded && (
                                        <div style={{ color: 'var(--color-danger)', fontSize: '11px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                          <AlertTriangle size={12} />
                                          <span>Total ({rowTotal}) melebihi sisa ({item.remainingQty})</span>
                                        </div>
                                      )}
                                    </td>
                                    <td>{item.sku || '—'}</td>
                                    <td className="go-return__td-qty" style={{ color: 'var(--color-text-secondary)' }}>
                                      {item.originalQty} {item.qtyUnit}
                                    </td>
                                    <td className="go-return__td-qty" style={{ color: 'var(--color-text-secondary)' }}>
                                      {item.previouslyReturned > 0 ? `${item.previouslyReturned} ${item.qtyUnit}` : '—'}
                                    </td>
                                    <td className="go-return__td-qty">
                                      <strong style={{ color: 'var(--color-text-primary)' }}>
                                        {item.remainingQty} {item.qtyUnit}
                                      </strong>
                                    </td>
                                    <td className="go-return__td-return-qty">
                                      <div className="go-return__dual-qty">
                                        <div className="go-return__dual-box">
                                          <span className="go-return__dual-label go-return__dual-label--good">Baik</span>
                                          <input
                                            type="number"
                                            step="any"
                                            className="go-return__qty-input"
                                            min={0}
                                            max={item.remainingQty}
                                            placeholder="0"
                                            value={q.goodQty}
                                            onChange={(e) =>
                                              handleNonSerialQtyChange(item.key, 'good', e.target.value)
                                            }
                                          />
                                        </div>
                                        <div className="go-return__dual-box">
                                          <span className="go-return__dual-label go-return__dual-label--damaged">
                                            Rusak
                                          </span>
                                          <input
                                            type="number"
                                            step="any"
                                            className="go-return__qty-input"
                                            min={0}
                                            max={item.remainingQty}
                                            placeholder="0"
                                            value={q.damagedQty}
                                            onChange={(e) =>
                                              handleNonSerialQtyChange(item.key, 'damaged', e.target.value)
                                            }
                                          />
                                        </div>
                                        <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                                          {item.qtyUnit}
                                        </span>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* SECTION 2B: SERIAL NUMBER ITEMS */}
                    {serialItems.length > 0 && (
                      <div style={{ marginTop: '16px' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '6px',
                          }}
                        >
                          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                            Barang Serial ({serialItems.length} nomor seri aktif)
                          </span>
                          <button
                            type="button"
                            className="go-return__toolbar-btn"
                            onClick={handleToggleAllSerials}
                          >
                            {isAllSerialSelected ? 'Batal Semua' : `Pilih Semua (${serialItems.length})`}
                          </button>
                        </div>

                        <div className="go-return__items-desktop">
                          <table className="go-return__items-table">
                            <thead>
                              <tr>
                                <th style={{ width: '44px', textAlign: 'center' }}>
                                  <input
                                    type="checkbox"
                                    className="go-return__check"
                                    checked={isAllSerialSelected}
                                    onChange={handleToggleAllSerials}
                                    title="Pilih Semua Serial"
                                  />
                                </th>
                                <th style={{ width: '28%' }}>Produk</th>
                                <th style={{ width: '16%' }}>SKU</th>
                                <th style={{ width: '24%' }}>Nomor Seri</th>
                                <th style={{ width: '28%', textAlign: 'right' }}>Kondisi Saat Diretur</th>
                              </tr>
                            </thead>
                            <tbody>
                              {serialItems.map((item) => {
                                const sel = serialSelection[item.key] || { selected: false, condition: 'available' };
                                const isSelected = !!sel.selected;

                                return (
                                  <tr
                                    key={item.key}
                                    className={isSelected ? 'go-return__item--selected' : ''}
                                    onClick={() => handleToggleSerial(item.key)}
                                    style={{ cursor: 'pointer' }}
                                  >
                                    <td className="go-return__td-check" onClick={(e) => e.stopPropagation()}>
                                      <input
                                        type="checkbox"
                                        className="go-return__check"
                                        checked={isSelected}
                                        onChange={() => handleToggleSerial(item.key)}
                                      />
                                    </td>
                                    <td className="go-return__td-product">
                                      <span>{item.productName}</span>
                                    </td>
                                    <td>{item.sku || '—'}</td>
                                    <td className="go-return__td-serial">
                                      <span
                                        style={{
                                          fontFamily: 'var(--font-mono)',
                                          fontWeight: 600,
                                          color: 'var(--color-text-primary)',
                                        }}
                                      >
                                        {item.serialNumber}
                                      </span>
                                    </td>
                                    <td className="go-return__td-return-qty" onClick={(e) => e.stopPropagation()}>
                                      {isSelected ? (
                                        <div className="go-return__serial-condition-toggle">
                                          <button
                                            type="button"
                                            className={`go-return__serial-condition-btn${
                                              sel.condition === 'available'
                                                ? ' go-return__serial-condition-btn--active-good'
                                                : ''
                                            }`}
                                            onClick={() => handleSerialCondition(item.key, 'available')}
                                          >
                                            Kondisi Baik
                                          </button>
                                          <button
                                            type="button"
                                            className={`go-return__serial-condition-btn${
                                              sel.condition === 'damaged'
                                                ? ' go-return__serial-condition-btn--active-damaged'
                                                : ''
                                            }`}
                                            onClick={() => handleSerialCondition(item.key, 'damaged')}
                                          >
                                            Kondisi Rusak
                                          </button>
                                        </div>
                                      ) : (
                                        <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                          (Belum dipilih)
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* Error display */}
          {error && (
            <div className="go-return__error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="go-return__footer">
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '12px',
              color: 'var(--color-text-secondary)',
            }}
          >
            {selectedDoc ? (
              payloadItems.length > 0 ? (
                <span>
                  Diretur: <strong>{totalReturnUnits} unit</strong> (
                  {selectedSerialCount > 0 ? `${selectedSerialCount} serial` : ''}
                  {selectedSerialCount > 0 && selectedNonSerialCount > 0 ? ', ' : ''}
                  {selectedNonSerialCount > 0 ? `${selectedNonSerialCount} item non-seri` : ''})
                </span>
              ) : (
                <span>Tentukan minimal 1 item untuk diproses</span>
              )
            ) : (
              <span>Pilih satu surat jalan di atas untuk melanjutkan</span>
            )}
          </div>
          <button type="button" className="btn btn-secondary btn-md" onClick={onClose} disabled={submitting}>
            Batal
          </button>
          {selectedDoc && (
            <button
              type="button"
              className="btn btn-primary btn-md"
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                'Memproses...'
              ) : (
                <>
                  <RotateCcw size={14} />
                  <span>Simpan Retur ({totalReturnUnits} unit)</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Scanner Overlay */}
      {scannerOpen && (
        <div className="go-scanner-overlay" onClick={() => setScannerOpen(false)}>
          <div className="go-scanner-container" onClick={(e) => e.stopPropagation()}>
            <div className="go-scanner-header">
              <div>
                <h3 className="go-scanner-title">Scan QR Return</h3>
                <p className="go-scanner-subtitle">
                  Arahkan kamera ke QR Code / Barcode barang dari surat jalan {selectedDoc?.document_number}
                </p>
              </div>
              <button
                type="button"
                className="go-scanner-close"
                onClick={() => setScannerOpen(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="go-scanner-body">
              <div className="go-scanner-col">
                <div className={`go-scanner-camera-wrapper${frameHit ? ' is-hit' : ''}`}>
                  <div id="go-return-scanner-reader" className="go-scanner-reader"></div>
                  <div className="go-scanner-frame" key={frameHit} aria-hidden="true"></div>
                  {!cameraActive && (!scanFeedback || scanFeedback.type !== 'error') && (
                    <div className="go-scanner-camera-placeholder">
                      <span className="go-scanner-spinner"></span>
                      <p className="go-scanner-placeholder-text">Mengaktifkan kamera...</p>
                    </div>
                  )}
                </div>

                {scanFeedback && (
                  <div className={`go-scanner-feedback go-scanner-feedback--${scanFeedback.type}`}>
                    {scanFeedback.type === 'success' ? (
                      <Check size={14} className="go-scanner-feedback-icon" />
                    ) : scanFeedback.type === 'warning' ? (
                      <AlertTriangle size={14} className="go-scanner-feedback-icon" />
                    ) : (
                      <AlertCircle size={14} className="go-scanner-feedback-icon" />
                    )}
                    <span>{scanFeedback.message}</span>
                  </div>
                )}

                {/* Manual Input in Scanner */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!manualInput.trim()) return;
                    handleScanResult(manualInput.trim());
                    setManualInput('');
                  }}
                  className="go-scanner-manual-input-form"
                >
                  <input
                    type="text"
                    className="input go-scanner-manual-input"
                    placeholder="Ketik serial / SKU manual..."
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-secondary go-scanner-manual-btn">
                    Tambah
                  </button>
                </form>
              </div>

              <div className="go-scanner-col go-scanner-col--results">
                <div className="go-scanner-list-section">
                  <h5 className="go-scanner-list-title">
                    <span>Ringkasan Item Diretur</span>
                    <span className="go-scanner-list-badge">{payloadItems.length} baris</span>
                  </h5>

                  {payloadItems.length === 0 ? (
                    <div className="go-scanner-empty">
                      <Barcode size={32} className="go-scanner-empty-icon" />
                      <p>Belum ada item yang dipindai.</p>
                    </div>
                  ) : (
                    <div className="go-scanner-scanned-items">
                      {payloadItems.map((item, idx) => (
                        <div key={idx} className="go-scanner-scanned-item">
                          <div className="go-scanner-scanned-info">
                            <span className="go-scanner-scanned-sn">
                              {item.isSerial ? item.serialNumber : `Item Non-Serial (${item.returnedQty} ${item.qtyUnit})`}
                            </span>
                            <span className="go-scanner-scanned-product">
                              Kondisi: <strong>{item.targetStatus === 'damaged' ? 'Rusak' : 'Baik'}</strong>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="go-scanner-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setScannerOpen(false)}>
                Tutup Scanner
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

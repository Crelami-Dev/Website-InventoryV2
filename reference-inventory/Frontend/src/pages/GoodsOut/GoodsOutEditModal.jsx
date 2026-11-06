import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Plus, AlertCircle, AlertTriangle, Check, Search, ChevronDown, Camera, Barcode, Save, Trash2 } from 'lucide-react';
import { useCameraScanner } from '../../hooks/useCameraScanner.js';
import { useDesktopScanShortcut } from '../../hooks/useDesktopScanShortcut.js';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api } from '../../utils/api.js';
import GoodsOutLineItem from './GoodsOutLineItem.jsx';
import QuickProductModal from './QuickProductModal.jsx';
import './GoodsOutCreateModal.css';

// Audio synthesis helper for scan feedback using browser AudioContext
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
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(50);
      }
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([60, 40, 60]);
      }
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
      }
    }
  } catch (err) {
    console.warn('AudioContext beep failed:', err);
  }
}

function makeEmptyLine() {
  return {
    id: crypto.randomUUID(),
    productId: null,
    productName: '',
    sku: '',
    isSerial: false,
    isUnrecorded: false,
    unrecordedNote: '',
    qty: 1,
    qtyUnit: 'pcs',
    serialNumber: '',
  };
}

export default function GoodsOutEditModal({
  doc,
  sourcePo: initialSourcePo,
  onClose,
  onSuccess,
  products = [],
  customers = [],
  suppliers = [],
  contactsEnabled = true,
}) {
  const { t } = useApp();
  const { units, multipliers, getMultiplier, formatUnitOption } = useUnits();
  const queryClient = useQueryClient();
  const sourceRef = useRef(null);
  const inFlightScansRef = useRef(new Set());
  const cooldownMapRef = useRef(new Map());
  // Serial lookup cache shared across every row in this modal, so a serial
  // resolved on row 1 is reused instantly by row 2 without another request.
  const serialCacheRef = useRef(new Map());
  // Compact index of every available serial in this warehouse, loaded once when
  // the modal opens so typing/scanning resolves in memory with no round trip.
  const serialIndexRef = useRef(new Map());

  // Fetch detailed doc if items are not present
  const { data: detailDoc } = useQuery({
    queryKey: ['documents', doc?.id],
    queryFn: async () => {
      const res = await api.get(`/api/workspace/documents/${doc.id}`);
      if (!res.ok) throw new Error('Failed to load document details');
      const json = await res.json();
      return json.data;
    },
    enabled: !!doc?.id && (!doc.items || doc.items.length === 0),
  });

  const effectiveDoc = detailDoc || doc;

  // Source PO detection & loading
  const sourcePoId = initialSourcePo?.id || effectiveDoc?.metadata?.source_po_id || effectiveDoc?.metadata?.sourcePoId;

  const { data: fetchedPo } = useQuery({
    queryKey: ['purchase-orders', sourcePoId],
    queryFn: async () => {
      if (!sourcePoId) return null;
      const res = await api.get(`/api/workspace/purchase-orders/${sourcePoId}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data;
    },
    enabled: !!sourcePoId && !initialSourcePo,
  });

  const activePo = initialSourcePo || fetchedPo;

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/settings');
      if (!res.ok) return {};
      const json = await res.json();
      return json.data || {};
    },
  });

  // Target PO Items calculation if opened for PO fulfillment
  const poTargetItems = useMemo(() => {
    if (!activePo || !Array.isArray(activePo.items)) return [];
    return activePo.items.map((it, idx) => {
      let cleanSku = String(it.sku || '').trim();
      let unit = 'lusin';
      if (cleanSku.includes('|')) {
        const parts = cleanSku.split('|');
        cleanSku = parts[0].trim();
        unit = parts[1].trim();
      }
      const unitClean = unit.toLowerCase();
      const targetUnitMultiplier = getMultiplier(unitClean) || (unitClean === 'pcs' ? 1 : 12);
      const targetQty = Number(it.qty) || 1;
      const targetPcs = targetQty * targetUnitMultiplier;

      return {
        id: it.id || `po-target-${idx}`,
        itemName: it.item_name,
        sku: cleanSku,
        targetQty: targetQty,
        unit: unit || 'lusin',
        targetPcs: targetPcs,
        targetUnitMultiplier: targetUnitMultiplier,
      };
    });
  }, [activePo, getMultiplier]);

  const [date, setDate] = useState(effectiveDoc?.issue_date?.slice(0, 10) || new Date().toISOString().slice(0, 10));
  const refNumber = effectiveDoc?.document_number || '';
  const [source, setSource] = useState(effectiveDoc?.contact_name || activePo?.vendor_name || '');
  const [contactId, setContactId] = useState(effectiveDoc?.contact_id || null);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [notes, setNotes] = useState(
    effectiveDoc?.notes || (activePo ? `Pemenuhan PO: ${activePo.po_number}` : '')
  );

  // Pre-fill existing items
  const [lines, setLines] = useState(() => {
    const rawItems = (effectiveDoc?.items && effectiveDoc.items.length > 0) ? effectiveDoc.items : (effectiveDoc?.metadata?.items ?? []);
    if (!rawItems || rawItems.length === 0) return [makeEmptyLine()];

    return rawItems.map((item) => {
      const isUnrecorded = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
      const isSerial = !isUnrecorded && item.metadata?.isSerial === true;
      const serialNumber = isUnrecorded ? '' : (item.metadata?.serialNumber || '');
      const isGroup = item.metadata?.isGroup === true || item.metadata?.targetQty != null;
      const qtyUnit = item.metadata?.targetUnit || item.metadata?.qtyUnit || 'pcs';
      const qty = Number(item.metadata?.qtyInput ?? (item.metadata?.targetQty ? item.metadata.targetQty : (isSerial ? 1 : item.quantity ?? 1))) || 1;

      return {
        id: item.id || crypto.randomUUID(),
        productId: item.product_id ?? item.productId ?? item.metadata?.originalProductId ?? null,
        productName: item.item_name || item.itemName || '',
        sku: item.sku || '',
        isSerial,
        isGroup,
        isUnrecorded,
        unrecordedNote: item.metadata?.unrecordedNote || '',
        qty,
        qtyUnit,
        serialNumber,
        targetQty: isGroup ? qty : undefined,
        targetUnit: isGroup ? qtyUnit : undefined,
        totalPcs: isGroup ? Number(item.metadata?.totalPcs ?? item.metadata?.baseQuantity ?? item.quantity) || undefined : undefined,
      };
    });
  });

  const getSnapshot = useCallback((src, cId, dt, nts, lns) => {
    return JSON.stringify({
      source: (src || '').trim(),
      contactId: cId || null,
      date: dt || '',
      notes: (nts || '').trim(),
      lines: (lns || []).map((l) => ({
        productId: l.productId || null,
        sku: (l.sku || '').trim(),
        isSerial: Boolean(l.isSerial),
        isUnrecorded: Boolean(l.isUnrecorded),
        qty: Number(l.qty) || 0,
        qtyUnit: (l.qtyUnit || 'pcs').toLowerCase(),
        serialNumber: (l.serialNumber || '').trim(),
      })),
    });
  }, []);

  const initialSnapshotRef = useRef(null);

  useEffect(() => {
    if (!initialSnapshotRef.current) {
      initialSnapshotRef.current = getSnapshot(source, contactId, date, notes, lines);
    }
  }, [getSnapshot]);

  // Sync lines if detailDoc loads after mount
  useEffect(() => {
    if (detailDoc?.items && detailDoc.items.length > 0) {
      const initialLines = detailDoc.items.map((item) => {
        const isUnrecorded = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
        const isSerial = !isUnrecorded && item.metadata?.isSerial === true;
        const serialNumber = isUnrecorded ? '' : (item.metadata?.serialNumber || '');
        const isGroup = item.metadata?.isGroup === true || item.metadata?.targetQty != null;
        const qtyUnit = item.metadata?.targetUnit || item.metadata?.qtyUnit || 'pcs';
        const qty = Number(item.metadata?.qtyInput ?? (item.metadata?.targetQty ? item.metadata.targetQty : (isSerial ? 1 : item.quantity ?? 1))) || 1;

        return {
          id: item.id || crypto.randomUUID(),
          productId: item.product_id ?? item.productId ?? item.metadata?.originalProductId ?? null,
          productName: item.item_name || item.itemName || '',
          sku: item.sku || '',
          isSerial,
          isGroup,
          isUnrecorded,
          unrecordedNote: item.metadata?.unrecordedNote || '',
          qty,
          qtyUnit,
          serialNumber,
          targetQty: isGroup ? qty : undefined,
          targetUnit: isGroup ? qtyUnit : undefined,
          totalPcs: isGroup ? Number(item.metadata?.totalPcs ?? item.metadata?.baseQuantity ?? item.quantity) || undefined : undefined,
        };
      });

      const initialSource = detailDoc.contact_name || source;
      const initialContactId = detailDoc.contact_id || contactId;
      const initialNotes = detailDoc.notes || notes;
      const initialDate = detailDoc.issue_date ? detailDoc.issue_date.slice(0, 10) : date;

      setLines(initialLines);
      if (detailDoc.contact_name) setSource(detailDoc.contact_name);
      if (detailDoc.contact_id) setContactId(detailDoc.contact_id);
      if (detailDoc.notes) setNotes(detailDoc.notes);
      if (detailDoc.issue_date) setDate(detailDoc.issue_date.slice(0, 10));

      initialSnapshotRef.current = getSnapshot(
        initialSource,
        initialContactId,
        initialDate,
        initialNotes,
        initialLines
      );
    }
  }, [detailDoc, getSnapshot]);

  const hasChanges = useMemo(() => {
    if (!initialSnapshotRef.current) return false;
    const current = getSnapshot(source, contactId, date, notes, lines);
    return current !== initialSnapshotRef.current;
  }, [source, contactId, date, notes, lines, getSnapshot]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const desktopInputRefs = useRef({});
  const mobileInputRefs = useRef({});

  const handleCancelOrClose = () => {
    if (submitting || quickProduct?.open || scannerOpen) return;
    if (hasChanges) {
      handleSave('draft');
    } else {
      onClose();
    }
  };

  const focusLineInput = (lineId) => {
    const isMobile = window.innerWidth < 768;
    const targetEl = isMobile ? mobileInputRefs.current[lineId] : desktopInputRefs.current[lineId];
    if (targetEl && targetEl.offsetParent !== null) {
      targetEl.focus();
    }
  };

  useClickOutside(sourceRef, () => setSourceDropdownOpen(false));

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerWide, setScannerWide] = useState(false);
  const [manualSerialInput, setManualSerialInput] = useState('');
  const [tempScannedLines, setTempScannedLines] = useState([]);
  const [scanFeedback, setScanFeedback] = useState(null);
  const scanCallbackRef = useRef(null);

  // Camera scanning is hidden on desktop behind the Ctrl+Shift+8 shortcut.
  const { desktopScanUnlocked } = useDesktopScanShortcut();

  // QuickProductModal state
  const [quickProduct, setQuickProduct] = useState({ open: false, prefillName: '', targetLineId: null });

  // Calculate PO fulfillment progress from lines and tempScannedLines with accurate unit multiplier conversion
  const poFulfillmentProgress = useMemo(() => {
    if (!poTargetItems.length) return [];
    const currentLines = [
      ...lines.filter((l) => (l.productName || l.serialNumber) && l.productId),
      ...tempScannedLines.filter((l) => l.productId),
    ];

    const getLinePcs = (l) => {
      const rawQty = Number(l.qty) || 1;
      const unitClean = String(l.qtyUnit || 'pcs').toLowerCase();
      const mult = getMultiplier(unitClean) || multipliers[unitClean] || 1;
      return rawQty * mult;
    };

    const catalogTargets = poTargetItems.filter((t) => t.sku && t.sku.toLowerCase() !== 'non-sku');
    const nonCatalogTargets = poTargetItems.filter((t) => !t.sku || t.sku.toLowerCase() === 'non-sku');
    const usedLineIds = new Set();

    const catalogProgress = catalogTargets.map((target) => {
      const targetSkuLower = target.sku.toLowerCase();
      const targetNameLower = target.itemName.toLowerCase();

      let totalScannedPcs = 0;
      currentLines.forEach((l) => {
        const lSku = String(l.sku || '').toLowerCase();
        const lName = String(l.productName || '').toLowerCase();
        const skuMatch = targetSkuLower && lSku && (lSku === targetSkuLower || lSku.startsWith(targetSkuLower));
        const nameMatch = targetNameLower && lName && lName === targetNameLower;

        if (skuMatch || nameMatch) {
          totalScannedPcs += getLinePcs(l);
          usedLineIds.add(l.id);
        }
      });

      const targetUnitMult = target.targetUnitMultiplier || getMultiplier(target.unit) || 12;
      const scannedInTargetUnit = Math.round((totalScannedPcs / targetUnitMult) * 100) / 100;
      const isComplete = totalScannedPcs >= target.targetPcs;
      const percent = Math.min(100, Math.round((totalScannedPcs / target.targetPcs) * 100));

      return {
        ...target,
        scannedPcs: totalScannedPcs,
        scannedCount: scannedInTargetUnit,
        isComplete: isComplete,
        percent: percent,
      };
    });

    const unusedLines = currentLines.filter((l) => !usedLineIds.has(l.id));
    let lineCursor = 0;

    const nonCatalogProgress = nonCatalogTargets.map((target) => {
      let totalScannedPcs = 0;
      while (lineCursor < unusedLines.length && totalScannedPcs < target.targetPcs) {
        totalScannedPcs += getLinePcs(unusedLines[lineCursor]);
        lineCursor++;
      }

      const targetUnitMult = target.targetUnitMultiplier || getMultiplier(target.unit) || 12;
      const scannedInTargetUnit = Math.round((totalScannedPcs / targetUnitMult) * 100) / 100;
      const isComplete = totalScannedPcs >= target.targetPcs;
      const percent = Math.min(100, Math.round((totalScannedPcs / target.targetPcs) * 100));

      return {
        ...target,
        scannedPcs: totalScannedPcs,
        scannedCount: scannedInTargetUnit,
        isComplete: isComplete,
        percent: percent,
      };
    });

    return [...catalogProgress, ...nonCatalogProgress];
  }, [poTargetItems, lines, tempScannedLines, multipliers, getMultiplier]);

  // Handle scanned barcode
  const handleBarcodeScanned = useCallback(async (code) => {
    if (!code) return;
    const cleanCode = String(code).trim();
    if (!cleanCode) return;
    const cleanCodeLower = cleanCode.toLowerCase();

    // 1. In-flight lock: prevent parallel execution when camera fires 12 times a second
    if (inFlightScansRef.current.has(cleanCodeLower)) {
      return;
    }

    // 2. Cooldown check: ignore repeat scans of the exact same barcode within 2.5 seconds
    const now = Date.now();
    const lastScanTime = cooldownMapRef.current.get(cleanCodeLower);
    if (lastScanTime && now - lastScanTime < 2500) {
      return;
    }
    cooldownMapRef.current.set(cleanCodeLower, now);

    // 3. Prevent duplicate scans in the current worksheet OR in the temporary scanned lines list
    const isAlreadyInLines = lines.some(
      (line) => String(line.serialNumber || '').trim().toLowerCase() === cleanCodeLower
    );
    const isAlreadyInTemp = tempScannedLines.some(
      (line) => String(line.serialNumber || '').trim().toLowerCase() === cleanCodeLower
    );

    if (isAlreadyInLines || isAlreadyInTemp) {
      playBeep('warning');
      setScanFeedback({
        type: 'warning',
        message: `Nomor seri "${cleanCode}" SUDAH pernah dipindai!`,
      });
      return;
    }

    inFlightScansRef.current.add(cleanCodeLower);

    try {
      const lookupRes = await api.get(`/api/workspace/product-serial-lookup?serial=${encodeURIComponent(cleanCode)}&documentId=${encodeURIComponent(effectiveDoc.id)}`);
      if (!lookupRes.ok) {
        playBeep('error');
        const lookupError = await lookupRes.json().catch(() => ({}));
        const rawMsg = lookupError?.message || '';

        if (lookupRes.status === 404) {
          setScanFeedback({
            type: 'error',
            message: `Nomor seri "${cleanCode}" tidak ditemukan di sistem!`,
          });
        } else if (rawMsg.toLowerCase().includes('tidak tersedia') || rawMsg.toLowerCase().includes('status:')) {
          setScanFeedback({
            type: 'error',
            message: `Nomor seri "${cleanCode}" sudah keluar sebelumnya atau tidak tersedia!`,
          });
        } else {
          setScanFeedback({
            type: 'error',
            message: rawMsg || `Serial number "${cleanCode}" tidak tersedia!`,
          });
        }
        return;
      }

      const matched = (await lookupRes.json()).data;
      if (!matched) {
        playBeep('error');
        setScanFeedback({
          type: 'error',
          message: `Nomor seri "${cleanCode}" tidak ditemukan.`,
        });
        return;
      }

      const matchedProductId = matched.productId ?? matched.product_id;
      // The lookup endpoint embeds the product, so no second request is needed.
      let product = matched.product || products.find((p) => p.id === matchedProductId);

      // Older responses without an embedded product still fall back to a
      // single direct fetch rather than reporting a false "not found".
      if (!product && matchedProductId) {
        try {
          const prodRes = await api.get(`/api/workspace/products/${encodeURIComponent(matchedProductId)}`);
          if (prodRes.ok) {
            const prodJson = await prodRes.json().catch(() => ({}));
            product = prodJson?.data ?? null;
          }
        } catch (_) {
          // ignore; falls through to the not-found state below
        }
      }

      if (!product) {
        playBeep('error');
        setScanFeedback({
          type: 'error',
          message: `Produk tidak ditemukan untuk serial: ${cleanCode}`,
        });
        return;
      }

      const isGroup = Boolean(matched.metadata?.isGroup || matched.isGroup);
      const rawGroupQty = Number(matched.metadata?.targetQty ?? matched.metadata?.unitQty ?? matched.targetQty);
      const qty = isGroup && Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : 1;

      const unitMap = { piece: 'pcs', pcs: 'pcs', dozen: 'lusin', lusin: 'lusin', pack: 'pack', pack3: 'pack3', pack6: 'pack6', bal5: 'bal5', bal10: 'bal10', bal15: 'bal15', bal20: 'bal20', bal25: 'bal25', bal: 'bal' };
      const snLower = String(matched.serialNumber ?? matched.serial_number ?? '').toLowerCase();
      const metaUnit =
        matched.metadata?.targetUnit ||
        matched.targetUnit ||
        matched.metadata?.serialUnit ||
        matched.metadata?.unit ||
        matched.metadata?.qtyUnit ||
        matched.unit ||
        matched.serialUnit ||
        null;

      let qtyUnit = 'pcs';
      if (metaUnit && metaUnit !== 'piece' && metaUnit !== 'pcs') {
        qtyUnit = unitMap[metaUnit] ?? metaUnit;
      } else if (metaUnit === 'pcs' || metaUnit === 'piece') {
        qtyUnit = 'pcs';
      } else if (snLower.includes('10bl') || snLower.includes('bl10') || snLower.includes('bal10')) qtyUnit = 'bal10';
      else if (snLower.includes('15bl') || snLower.includes('bl15') || snLower.includes('bal15')) qtyUnit = 'bal15';
      else if (snLower.includes('20bl') || snLower.includes('bl20') || snLower.includes('bal20')) qtyUnit = 'bal20';
      else if (snLower.includes('25bl') || snLower.includes('bl25') || snLower.includes('bal25')) qtyUnit = 'bal25';
      else if (snLower.includes('5bl') || snLower.includes('bl5') || snLower.includes('bal5')) qtyUnit = 'bal5';
      else if (snLower.includes('bal') || snLower.includes('bl')) qtyUnit = 'bal';
      else if (snLower.includes('pack3') || snLower.includes('pk3')) qtyUnit = 'pack3';
      else if (snLower.includes('pack6') || snLower.includes('pk6')) qtyUnit = 'pack6';
      else if (snLower.includes('pack') || snLower.includes('pk')) qtyUnit = 'pack';
      else if (snLower.includes('lusin') || snLower.includes('dozen')) qtyUnit = 'lusin';
      else {
        const rawUnit = product?.metadata?.qtyUnit || product?.metadata?.unit || 'pcs';
        qtyUnit = unitMap[rawUnit] ?? rawUnit ?? 'pcs';
      }

      const newLine = {
        id: crypto.randomUUID(),
        productId: product.id,
        productName: product.name,
        sku: product.sku || '',
        isSerial: true,
        serialNumber: matched.serialNumber ?? matched.serial_number,
        qty,
        qtyUnit: qtyUnit,
      };

      setTempScannedLines((prev) => {
        if (prev.some((line) => String(line.serialNumber || '').trim().toLowerCase() === cleanCodeLower)) {
          return prev;
        }
        return [...prev, newLine];
      });

      playBeep('success');
      setScanFeedback({
        type: 'success',
        message: `Berhasil dipindai: ${cleanCode} (${product.name})`,
      });
    } catch (err) {
      console.error('Scan error:', err);
      playBeep('error');
      setScanFeedback({
        type: 'error',
        message: `Gagal memproses nomor seri: ${cleanCode}`,
      });
    } finally {
      inFlightScansRef.current.delete(cleanCodeLower);
    }
  }, [lines, tempScannedLines, products, effectiveDoc.id]);

  scanCallbackRef.current = handleBarcodeScanned;

  // Preload the warehouse's serial index once. Passing the document id also
  // includes serials already attached to this draft, so reopening it doesn't
  // flag its own serials as unavailable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = effectiveDoc?.id
          ? `/api/workspace/product-serial-index?documentId=${encodeURIComponent(effectiveDoc.id)}`
          : '/api/workspace/product-serial-index';
        const res = await api.get(url);
        if (cancelled || !res.ok) return;
        const json = await res.json().catch(() => ({}));
        const rows = Array.isArray(json.data) ? json.data : [];
        const map = new Map();
        rows.forEach(([serial, productId, unit, status, warehouseId, goodsInDocId, createdAt, isGrouped, isGroup, isDissolved, targetQty]) => {
          if (serial) {
            map.set(String(serial).toLowerCase(), {
              serial,
              productId,
              unit,
              status,
              isGroup: Boolean(isGroup),
              targetQty: Number(targetQty) || 1,
            });
          }
        });
        serialIndexRef.current = map;
      } catch (_) {
        // Index is an optimisation only; lookups still work over the network.
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveDoc?.id]);

  useEffect(() => {
    if (scannerOpen) setScanFeedback(null);
  }, [scannerOpen]);

  const handleScannerError = useCallback(
    (message) => setScanFeedback({ type: 'error', message }),
    []
  );

  const { cameraActive, frameHit } = useCameraScanner({
    elementId: 'barcode-reader-edit',
    active: scannerOpen,
    fps: 15,
    onDecode: (text) => scanCallbackRef.current?.(text),
    onError: handleScannerError,
  });

  const handleOpenScanner = ({ wide = false } = {}) => {
    inFlightScansRef.current.clear();
    cooldownMapRef.current.clear();
    setTempScannedLines([]);
    setScannerWide(wide);
    setScannerOpen(true);
  };

  const handleCloseScanner = () => {
    setScannerOpen(false);
  };

  const handleApplyScanned = () => {
    if (tempScannedLines.length > 0) {
      setLines((prev) => {
        const filteredPrev = prev.filter((p) => p.productId || p.serialNumber);
        return [...filteredPrev, ...tempScannedLines];
      });
    }
    setScannerOpen(false);
  };

  const handleRemoveTempLine = (id) => {
    setTempScannedLines((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed?.serialNumber) {
        cooldownMapRef.current.delete(String(removed.serialNumber).trim().toLowerCase());
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleAddManualSerial = (e) => {
    if (e) e.preventDefault();
    if (!manualSerialInput.trim()) return;
    const code = manualSerialInput.trim();
    setManualSerialInput('');
    handleBarcodeScanned(code);
  };

  const allContacts = useMemo(() => {
    const mapped = [];
    (customers ?? []).forEach((c) => mapped.push({ ...c, _contactType: 'customer' }));
    (suppliers ?? []).forEach((s) => mapped.push({ ...s, _contactType: 'supplier' }));
    return mapped;
  }, [customers, suppliers]);

  const filteredContacts = useMemo(() => {
    if (!source.trim()) return allContacts.slice(0, 8);
    const q = source.toLowerCase();
    return allContacts.filter((c) => {
      const name = (c.name ?? c.nama ?? '').toLowerCase();
      const code = (c.code ?? c.kode ?? '').toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }, [allContacts, source]);

  const handleLineChange = useCallback((lineId, updatedFields) => {
    setLines((prev) =>
      prev.map((l) => (l.id === lineId ? { ...l, ...updatedFields } : l))
    );
  }, []);

  const handleAddRow = () => {
    const newId = crypto.randomUUID();
    setLines((prev) => [...prev, { ...makeEmptyLine(), id: newId }]);
    setTimeout(() => {
      focusLineInput(newId);
    }, 50);
  };

  const handleRemoveRow = (lineId) => {
    setLines((prev) => {
      const next = prev.filter((l) => l.id !== lineId);
      return next.length === 0 ? [makeEmptyLine()] : next;
    });
  };

  // Bulk-paste serial numbers (e.g. one Excel column) into the serial input
  // of a line: split into individual serials, resolve them all in a single
  // batch request, then fan the results out across existing + new rows
  // instead of looking each one up sequentially.
  const handlePasteSerials = async (fromLineId, rawText) => {
    const serials = String(rawText || '')
      .split(/[\r\n\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (serials.length <= 1) return false;

    const lookupRes = await api.post('/api/workspace/product-serial-lookup/batch', { serials }).catch(() => null);
    const lookupJson = lookupRes?.ok ? await lookupRes.json().catch(() => ({})) : {};
    const foundList = Array.isArray(lookupJson.data) ? lookupJson.data : [];
    const foundMap = new Map(
      foundList.map((s) => [String(s.serial_number ?? s.serialNumber ?? '').trim().toLowerCase(), s])
    );

    // A serial is usable here if it's genuinely available (and not grouped/dissolved), or if it's
    // already attached to this same (draft) document being edited.
    const isUsable = (s) => {
      const isGrouped = Boolean(s.metadata?.isGrouped || s.metadata?.parentGroupId || s.isGrouped);
      const isDissolved = Boolean(s.metadata?.isDissolved || s.isDissolved);
      if (isGrouped || isDissolved) return false;
      return (
        s.status === 'available' ||
        (effectiveDoc?.id && (s.goods_out_document_id ?? s.goodsOutDocumentId) === effectiveDoc.id)
      );
    };

    // Seed the shared cache so editing any pasted row later resolves instantly
    foundList.forEach((s) => {
      const sn = String(s.serial_number ?? s.serialNumber ?? '').trim().toLowerCase();
      if (sn && s.product && isUsable(s)) {
        serialCacheRef.current.set(sn, { matched: s, product: s.product });
      }
    });

    // The batch endpoint embeds the product, so only ids still missing after
    // that (older responses, or products outside the local cache) need a fetch.
    const missingProductIds = Array.from(
      new Set(
        foundList
          .filter(isUsable)
          .filter((s) => !s.product)
          .map((s) => s.product_id ?? s.productId)
          .filter((id) => id && !products.find((p) => p.id === id))
      )
    );
    const fetchedProducts = {};
    if (missingProductIds.length > 0) {
      await Promise.all(
        missingProductIds.map(async (id) => {
          try {
            const res = await api.get(`/api/workspace/products/${encodeURIComponent(id)}`);
            if (res.ok) {
              const json = await res.json().catch(() => ({}));
              if (json?.data) fetchedProducts[id] = json.data;
            }
          } catch (_) {}
        })
      );
    }

    setLines((prev) => {
      const next = [...prev];
      const startIdx = next.findIndex((l) => l.id === fromLineId);
      const baseIdx = startIdx === -1 ? next.length - 1 : startIdx;

      serials.forEach((serialVal, i) => {
        const targetIdx = baseIdx + i;
        const rawMatch = foundMap.get(serialVal.toLowerCase());
        // The batch endpoint returns serials of any status; only treat it as
        // a valid match if it's actually usable, same as the single lookup.
        const matched = rawMatch && isUsable(rawMatch) ? rawMatch : null;
        const matchedProductId = matched?.product_id ?? matched?.productId ?? null;
        const product =
          matched?.product ||
          (matchedProductId
            ? products.find((p) => p.id === matchedProductId) || fetchedProducts[matchedProductId]
            : null);

        let resolvedFields;
        if (matched && product) {
          const isGroup = Boolean(matched.metadata?.isGroup || matched.isGroup);
          const rawGroupQty = Number(matched.metadata?.targetQty ?? matched.metadata?.unitQty ?? matched.targetQty);
          const qty = isGroup && Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : 1;

          const unitMap = { piece: 'pcs', pcs: 'pcs', dozen: 'lusin', lusin: 'lusin', pack: 'pack', pack3: 'pack3', pack6: 'pack6', bal5: 'bal5', bal10: 'bal10', bal15: 'bal15', bal20: 'bal20', bal25: 'bal25', bal: 'bal' };
          const snLower = String(matched.serial_number ?? matched.serialNumber ?? '').toLowerCase();
          const metaUnit =
            matched.metadata?.targetUnit ||
            matched.targetUnit ||
            matched.metadata?.serialUnit ||
            matched.metadata?.unit ||
            matched.metadata?.qtyUnit ||
            matched.unit ||
            matched.serialUnit ||
            null;

          let qtyUnit = 'pcs';
          if (metaUnit && metaUnit !== 'piece' && metaUnit !== 'pcs') {
            qtyUnit = unitMap[metaUnit] ?? metaUnit;
          } else if (metaUnit === 'pcs' || metaUnit === 'piece') {
            qtyUnit = 'pcs';
          } else if (snLower.includes('10bl') || snLower.includes('bl10') || snLower.includes('bal10')) qtyUnit = 'bal10';
          else if (snLower.includes('15bl') || snLower.includes('bl15') || snLower.includes('bal15')) qtyUnit = 'bal15';
          else if (snLower.includes('20bl') || snLower.includes('bl20') || snLower.includes('bal20')) qtyUnit = 'bal20';
          else if (snLower.includes('25bl') || snLower.includes('bl25') || snLower.includes('bal25')) qtyUnit = 'bal25';
          else if (snLower.includes('5bl') || snLower.includes('bl5') || snLower.includes('bal5')) qtyUnit = 'bal5';
          else if (snLower.includes('bal') || snLower.includes('bl')) qtyUnit = 'bal';
          else if (snLower.includes('pack3') || snLower.includes('pk3')) qtyUnit = 'pack3';
          else if (snLower.includes('pack6') || snLower.includes('pk6')) qtyUnit = 'pack6';
          else if (snLower.includes('pack') || snLower.includes('pk')) qtyUnit = 'pack';
          else if (snLower.includes('lusin') || snLower.includes('dozen')) qtyUnit = 'lusin';
          else {
            const rawUnit = product?.metadata?.qtyUnit || product?.metadata?.unit || 'pcs';
            qtyUnit = unitMap[rawUnit] ?? rawUnit ?? 'pcs';
          }

          resolvedFields = {
            productId: product.id,
            productName: product.name,
            sku: product.sku || '',
            isSerial: true,
            serialNumber: matched.serial_number ?? matched.serialNumber ?? serialVal,
            qty,
            qtyUnit,
          };
        } else {
          resolvedFields = {
            productId: null,
            productName: '',
            sku: '',
            isSerial: true,
            serialNumber: serialVal,
            qty: 1,
            qtyUnit: 'pcs',
          };
        }

        if (targetIdx < next.length) {
          next[targetIdx] = { ...next[targetIdx], ...resolvedFields };
        } else {
          next.push({ ...makeEmptyLine(), id: crypto.randomUUID(), ...resolvedFields });
        }
      });

      return next;
    });

    return true;
  };

  const handleSelectContact = (contact) => {
    setSource(contact.name ?? contact.nama ?? '');
    setContactId(contact.id);
    setSourceDropdownOpen(false);
  };

  const validate = () => {
    if (!source.trim()) return 'Pelanggan / Tujuan harus diisi';
    const validLines = lines.filter((l) => l.productId || l.serialNumber);
    if (validLines.length === 0) return 'Minimal harus ada 1 barang';

    const seenSerials = new Set();
    const rawItems = (effectiveDoc?.items && effectiveDoc.items.length > 0) ? effectiveDoc.items : (effectiveDoc?.metadata?.items ?? []);
    const existingDocNonSerialPcs = {};
    (rawItems || []).forEach((item) => {
      const isItemUnrecorded = item.metadata?.isUnrecorded === true || item.metadata?.isUnrecordedStock === true;
      if (item.metadata?.isSerial !== true && !isItemUnrecorded) {
        const pId = item.product_id ?? item.productId ?? item.metadata?.originalProductId;
        if (pId) {
          const u = item.metadata?.qtyUnit || item.unit || 'pcs';
          const m = multipliers[u] || 1;
          const q = (item.metadata?.qtyInput ?? item.quantity ?? 1) * m;
          existingDocNonSerialPcs[pId] = (existingDocNonSerialPcs[pId] || 0) + q;
        }
      }
    });

    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i];
      if (!line.productId) return `Pilih produk pada baris ${i + 1}`;
      if (line.productId === '__new__' && !line.sku?.trim()) return `SKU produk wajib diisi pada baris ${i + 1}`;

      const unit = line.qtyUnit || 'pcs';
      const multiplier = multipliers[unit] || 1;
      const requestedQty = line.isSerial
        ? (line.isGroup ? (Number(line.qty) || 1) * multiplier : multiplier)
        : (Number(line.qty) || 1) * multiplier;

      if (line.isUnrecorded) {
        if (!line.qty || line.qty < 1) return `Jumlah kuantitas tidak valid pada baris ${i + 1}`;
        // Unrecorded item: bypasses serial requirements and recorded stock limit
      } else if (line.isSerial) {
        const sn = String(line.serialNumber || '').trim();
        if (!sn) return `Nomor seri wajib diisi pada baris ${i + 1}`;
        const snKey = sn.toLowerCase();
        if (seenSerials.has(snKey)) {
          return `Nomor seri "${sn}" duplikat pada baris ${i + 1}`;
        }
        seenSerials.add(snKey);
      } else {
        if (!line.qty || line.qty < 1) return `Jumlah kuantitas tidak valid pada baris ${i + 1}`;

        if (line.productId !== '__new__') {
          const product = products.find((p) => p.id === line.productId);
          const currentStock = product ? Number(product.stockNonSerial ?? product.metadata?.stockNonSerial ?? product.stock ?? 0) : 0;
          const previouslyAllocated = existingDocNonSerialPcs[line.productId] || 0;
          const totalAvailable = currentStock + previouslyAllocated;

          if (requestedQty > totalAvailable) {
            return `Kuantitas barang melebihi stok tersedia (${totalAvailable} pcs) pada baris ${i + 1}`;
          }
        }
      }
    }
    return null;
  };

  const isDraft = (effectiveDoc?.status || doc?.status) === 'draft';

  const handleDeleteDraft = async () => {
    if (!window.confirm(`Hapus draft ${refNumber}? Draft yang dihapus akan dibersihkan dari sistem.`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.delete(`/api/workspace/documents/${effectiveDoc.id}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error?.message || errJson?.message || 'Gagal menghapus draft');
      }
      queryClient.setQueryData(['goods-out'], (prev) =>
        Array.isArray(prev) ? prev.filter((d) => d.id !== effectiveDoc.id) : []
      );
      queryClient.invalidateQueries({ queryKey: ['goods-out'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });
      onClose();
    } catch (err) {
      setError(err.message || 'Gagal menghapus draft');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = async (targetStatus = 'draft') => {
    const isCompleting = targetStatus === 'completed';
    const wasCompleted = effectiveDoc.status === 'completed';
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const validLines = lines.filter((l) => l.productId || l.serialNumber);

      // Step 0: Resolve / find contact
      let resolvedContactId = contactId;
      let resolvedContactName = source.trim();
      if (!resolvedContactId && source.trim()) {
        const exact = allContacts.find(
          (c) => (c.name ?? c.nama ?? '').toLowerCase() === source.trim().toLowerCase()
        );
        if (exact) {
          resolvedContactId = exact.id;
          resolvedContactName = exact.name ?? exact.nama ?? source.trim();
        }
      }

      // Step 1: Resolve inline new products
      const createdCache = {};
      const resolvedLines = [];
      for (const line of validLines) {
        if (line.productId !== '__new__') {
          resolvedLines.push(line);
          continue;
        }

        const skuKey = (line.sku || '').trim().toLowerCase();
        const nameKey = (line.productName || '').trim().toLowerCase();

        const existing = (products || []).find(
          (p) =>
            (skuKey && p.sku && p.sku.trim().toLowerCase() === skuKey) ||
            (nameKey && p.name && p.name.trim().toLowerCase() === nameKey)
        );
        if (existing) {
          resolvedLines.push({ ...line, productId: existing.id, productName: existing.name, sku: existing.sku });
          continue;
        }

        const cached = (skuKey && createdCache[skuKey]) || (nameKey && createdCache[nameKey]);
        if (cached) {
          resolvedLines.push({ ...line, productId: cached.id, productName: cached.name, sku: cached.sku });
          continue;
        }

        const res = await api.post('/api/workspace/products', {
          name: line.productName.trim(),
          sku: line.sku.trim(),
          status: 'active',
          stock: 0, unitCost: 0, sellingPrice: 0,
          discountType: 'none', discountValue: 0,
        });
        if (!res.ok) throw new Error('Gagal membuat produk baru');
        const json = await res.json();
        const newProd = json.data;

        if (skuKey) createdCache[skuKey] = newProd;
        if (nameKey) createdCache[nameKey] = newProd;

        resolvedLines.push({ ...line, productId: newProd.id, productName: newProd.name, sku: newProd.sku });
      }

      const items = resolvedLines.map((line, idx) => {
        const unit = line.qtyUnit || 'pcs';
        const multiplier = multipliers[unit] || 1;
        const totalQty = (Number(line.qty) || 1) * multiplier;

        return {
          productId: line.productId || null,
          itemName: line.productName,
          sku: line.sku || '',
          quantity: totalQty,
          unitPrice: 0,
          discountType: 'none',
          discountValue: 0,
          amount: 0,
          sortOrder: idx,
          metadata: line.isUnrecorded
            ? {
                isSerial: false,
                isUnrecorded: true,
                isUnrecordedStock: true,
                unrecordedNote: line.unrecordedNote || '',
                qtyUnit: unit,
                unitName: units.find((candidate) => candidate.key === unit)?.name || unit,
                unitMultiplier: multiplier,
                qtyInput: line.qty,
                baseQuantity: totalQty,
                stockDeducted: false,
              }
            : line.isSerial
            ? {
                isSerial: true, serialNumber: line.serialNumber.trim(), qtyUnit: unit,
                unitName: units.find((candidate) => candidate.key === unit)?.name || unit,
                unitMultiplier: multiplier, qtyInput: line.qty, baseQuantity: totalQty,
                ...(line.isGroup ? {
                  isGroup: true,
                  targetQty: line.qty,
                  targetUnit: unit,
                  totalPcs: totalQty,
                  resultProductId: line.productId || null,
                  resultProductName: line.productName,
                  resultProductSku: line.sku || '',
                } : {}),
              }
            : {
                isSerial: false, qtyUnit: unit,
                unitName: units.find((candidate) => candidate.key === unit)?.name || unit,
                unitMultiplier: multiplier, qtyInput: line.qty, baseQuantity: totalQty,
              },
        };
      });

      const patchRes = await api.patch(`/api/workspace/documents/${effectiveDoc.id}`, {
        documentType: 'goods_out',
        documentNumber: refNumber,
        contactId: resolvedContactId || null,
        contactName: resolvedContactName || null,
        // New completions are posted by the atomic backend command after the
        // edited items have been saved. Already-completed documents keep their
        // status so the legacy edit reconciliation remains backward compatible.
        status: isCompleting && !wasCompleted ? 'processing' : targetStatus,
        issueDate: date,
        notes: notes.trim() || null,
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 0,
        metadata: {
          ...(effectiveDoc.metadata || {}),
          ...(activePo ? { source_po_id: activePo.id, source_po_number: activePo.po_number } : {}),
        },
        items,
      });

      if (!patchRes.ok) {
        const errJson = await patchRes.json().catch(() => ({}));
        throw new Error(errJson?.message || 'Gagal memperbarui dokumen');
      }

      const patchJson = await patchRes.json();
      let updatedDoc = patchJson.data;

      if (isCompleting && !wasCompleted) {
        const completeRes = await api.post(`/api/workspace/documents/${effectiveDoc.id}/complete`);
        if (!completeRes.ok) {
          const errorJson = await completeRes.json().catch(() => ({}));
          throw new Error(errorJson?.message || 'Gagal menyelesaikan dokumen');
        }
        const completeJson = await completeRes.json();
        updatedDoc = completeJson.data;
      }

      // Update query cache optimistically and invalidate
      queryClient.setQueryData(['goods-out'], (prev) =>
        Array.isArray(prev) ? prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)) : [updatedDoc]
      );
      queryClient.invalidateQueries({ queryKey: ['goods-out'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });

      if (onSuccess) onSuccess(updatedDoc);
      onClose();
    } catch (err) {
      console.error(err);
      setError(err.message || 'Gagal menyimpan perubahan dokumen');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="go-modal-overlay"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (quickProduct?.open || scannerOpen) return;
        handleCancelOrClose();
      }}
    >
      <section
        className="go-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="go-edit-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="go-modal__header">
          <div>
            <h2 id="go-edit-modal-title" className="go-modal__title">
              {activePo ? `Pengeluaran Barang dari PO ${activePo.po_number}` : 'Edit Barang Keluar'}
            </h2>
            <p className="go-modal__subtitle">
              {activePo
                ? `Pindai (scan) nomor seri produk di gudang untuk memenuhi pesanan PO ${activePo.po_number}`
                : `Edit catatan dan daftar barang pengeluaran ${refNumber}`}
            </p>
          </div>
          <button
            type="button"
            className="go-modal__close-btn"
            onClick={handleCancelOrClose}
            title={hasChanges ? 'Tutup & Simpan Draft' : 'Tutup'}
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div className="go-modal__body">
          <form
            id="goods-out-edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave('completed');
            }}
            noValidate
          >
            {/* PO Fulfillment Checklist Banner */}
            {activePo && poFulfillmentProgress.length > 0 && (
              <div
                className="go-modal__info-card"
                style={{
                  borderLeft: '4px solid var(--color-interactive)',
                  padding: '16px 20px',
                  background: 'var(--color-surface)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                    flexWrap: 'wrap',
                    gap: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: '800', fontSize: '15px', color: 'var(--color-text-primary)' }}>
                      Checklist Pemenuhan Item PO ({activePo.po_number})
                    </span>
                    <span className="doc-chip doc-chip--paid" style={{ fontSize: '11px' }}>
                      Approved
                    </span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    Pelanggan / Vendor: <strong>{activePo.vendor_name}</strong>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {poFulfillmentProgress.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        background: item.isComplete ? 'var(--color-success-surface)' : 'var(--color-surface-alt)',
                        border: item.isComplete ? '1px solid var(--color-success)' : '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                        <span style={{ fontWeight: '600', fontSize: '13px', color: 'var(--color-text-primary)' }}>
                          {item.itemName}
                        </span>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 'bold',
                            padding: '2px 6px',
                            borderRadius: 'var(--radius-xs)',
                            background: item.isComplete ? 'var(--color-success)' : 'var(--color-surface)',
                            color: item.isComplete ? 'var(--color-text-inverse)' : 'var(--color-text-secondary)',
                            border: item.isComplete ? '1px solid var(--color-success)' : '1px solid var(--color-border)',
                          }}
                        >
                          {item.scannedCount} / {item.targetQty} {item.unit}
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: '11px',
                          color: 'var(--color-text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>SKU: {item.sku || 'NON-SKU'}</span>
                        {(!item.sku || item.sku.toLowerCase() === 'non-sku') && (
                          <button
                            type="button"
                            className="po-checklist__map-btn"
                            onClick={() => setQuickProduct({ open: true, prefillName: item.itemName, targetLineId: null })}
                          >
                            <Plus size={10} />
                            Daftarkan Produk
                          </button>
                        )}
                        <span>{item.percent}%</span>
                      </div>

                      <div
                        style={{
                          width: '100%',
                          height: '6px',
                          background: 'var(--color-border)',
                          borderRadius: 'var(--radius-full)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${item.percent}%`,
                            height: '100%',
                            background: item.isComplete ? 'var(--color-success)' : 'var(--color-interactive)',
                            transition: 'width 0.3s ease',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error Banner */}
            {error && (
              <div className="go-modal__alert" role="alert">
                <AlertCircle size={16} className="go-modal__alert-icon" />
                <span>{error}</span>
              </div>
            )}

            {/* Transaction Details */}
            <div className="go-modal__info-card">
              <h4 className="go-modal__info-title">Detail Transaksi</h4>
              <div className="go-modal__info-grid">
                {/* Ref number */}
                <div className="go-modal__field">
                  <label className="go-modal__field-label">No. Referensi</label>
                  <input
                    type="text"
                    className="input"
                    value={refNumber}
                    disabled
                    readOnly
                  />
                  <p className="go-modal__field-subtext">No. urut unik WH/OUT/YYYYMMDD/000X</p>
                </div>

                {/* Source / Destination input */}
                <div className="go-modal__field" ref={sourceRef}>
                  <label className="go-modal__field-label">
                    Penerima / Tujuan <span className="text-danger">*</span>
                  </label>
                  <div className="go-source__wrap">
                    <div className="go-source__input-wrap">
                      <Search size={14} className="go-source__search-icon" />
                      <input
                        type="text"
                        className="input go-source__input"
                        placeholder="Nama penerima"
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          setContactId(null);
                          setSourceDropdownOpen(true);
                        }}
                        onFocus={() => setSourceDropdownOpen(true)}
                        required
                        disabled={submitting}
                      />
                      <ChevronDown size={14} className="go-source__chevron" />
                    </div>

                    {sourceDropdownOpen && (
                      <div className="go-source__dropdown">
                        {filteredContacts.map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            className="go-source__option"
                            onClick={() => handleSelectContact(contact)}
                          >
                            <span className="go-source__option-name">
                              {contact.name ?? contact.nama}
                            </span>
                            <span className="go-source__option-tag">
                              {contact._contactType === 'customer' ? 'Pelanggan' : 'Supplier'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Date */}
                <div className="go-modal__field">
                  <label className="go-modal__field-label">
                    Tanggal Keluar <span className="text-danger">*</span>
                  </label>
                  <input
                    type="date"
                    className="input"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                    disabled={submitting}
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="go-modal__field go-modal__field--full" style={{ marginTop: 'var(--space-4)' }}>
                <label className="go-modal__field-label">Catatan</label>
                <textarea
                  className="input go-modal__notes"
                  placeholder="Catatan internal (opsional)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={submitting}
                  rows={2}
                />
              </div>
            </div>

            {/* Items Worksheet */}
            <div className="go-modal__worksheet">
              <div className="go-modal__items-header">
                <h4 className="go-modal__items-title">Item</h4>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    className={`go-modal__scan-btn${desktopScanUnlocked ? ' go-modal__scan-btn--desktop' : ''}`}
                    onClick={() => handleOpenScanner({ wide: desktopScanUnlocked })}
                    title={desktopScanUnlocked ? 'Scan memakai kamera (desktop)' : undefined}
                  >
                    <Camera size={14} />
                    <span>Scan Barcode</span>
                    {desktopScanUnlocked && <span className="go-modal__scan-btn-tag">Kamera</span>}
                  </button>
                  <button
                    type="button"
                    className="go-modal__add-row-btn"
                    onClick={handleAddRow}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    <span>Tambah Baris</span>
                  </button>
                </div>
              </div>

              {/* Desktop Table */}
              <div className="go-modal__table-desktop">
                <div className="go-modal__table-wrapper">
                  <table className="go-modal__table">
                    <colgroup>
                      <col style={{ width: '36px' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '26%' }} />
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '11%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '36px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className="go-th--center">#</th>
                        <th scope="col">Nomor Serial</th>
                        <th scope="col">Nama Produk <span className="text-danger">*</span></th>
                        <th scope="col">SKU <span className="text-danger">*</span></th>
                        <th scope="col">Jenis</th>
                        <th scope="col" className="go-th--right">Jumlah / Satuan <span className="text-danger">*</span></th>
                        <th scope="col"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, idx) => (
                        <GoodsOutLineItem
                          key={line.id}
                          item={line}
                          rowIndex={idx}
                          layout="table"
                          products={products}
                          allLines={lines}
                          canRemove={lines.length > 1}
                          allowUnrecorded={settings?.allow_unrecorded_goods_out !== false}
                          onChange={(fields) => handleLineChange(line.id, fields)}
                          onRemove={() => handleRemoveRow(line.id)}
                          onAddRow={handleAddRow}
                          onCreateProduct={(prefillName) => setQuickProduct({ open: true, prefillName, targetLineId: line.id })}
                          onPasteSerials={(text) => handlePasteSerials(line.id, text)}
                          serialCache={serialCacheRef}
                          serialIndex={serialIndexRef}
                          documentId={effectiveDoc?.id}
                          inputRef={(el) => { desktopInputRefs.current[line.id] = el; }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile Cards */}
              <div className="go-modal__cards-mobile">
                {lines.map((line, idx) => (
                  <GoodsOutLineItem
                    key={line.id}
                    item={line}
                    rowIndex={idx}
                    layout="card"
                    products={products}
                    allLines={lines}
                    canRemove={lines.length > 1}
                    allowUnrecorded={settings?.allow_unrecorded_goods_out !== false}
                    onChange={(fields) => handleLineChange(line.id, fields)}
                    onRemove={() => handleRemoveRow(line.id)}
                    onAddRow={handleAddRow}
                    onCreateProduct={(prefillName) => setQuickProduct({ open: true, prefillName, targetLineId: line.id })}
                    onPasteSerials={(text) => handlePasteSerials(line.id, text)}
                    serialCache={serialCacheRef}
                    serialIndex={serialIndexRef}
                    documentId={effectiveDoc?.id}
                    inputRef={(el) => { mobileInputRefs.current[line.id] = el; }}
                  />
                ))}
              </div>
            </div>
          </form>
        </div>

        {/* Modal Footer */}
        <div className="go-modal__footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          {isDraft && (
            <button
              type="button"
              className="btn btn-danger btn-md interactive"
              onClick={handleDeleteDraft}
              disabled={submitting}
              style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Trash2 size={15} />
              <span>Hapus Draft</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-md"
            onClick={handleCancelOrClose}
            disabled={submitting}
          >
            {hasChanges ? 'Batal & Simpan Draft' : (t('goodsOut.modal.cancel') || 'Batal')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-md"
            onClick={() => handleSave(effectiveDoc?.status === 'completed' ? 'completed' : 'processing')}
            disabled={submitting}
          >
            <Check size={16} />
            <span>{submitting ? 'Menyimpan...' : (effectiveDoc?.status === 'completed' ? 'Simpan Perubahan' : 'Simpan Perubahan (Pending)')}</span>
          </button>
        </div>
      </section>

      {/* Barcode Scanner Modal Overlay */}
      {scannerOpen && (
        <div className="go-modal-overlay" style={{ zIndex: 99999 }} onClick={handleCloseScanner}>
          <div
            className={`go-modal${scannerWide ? ' go-scanner-shell--wide' : ''}`}
            style={{
              maxWidth: scannerWide ? undefined : '520px',
              height: scannerWide ? undefined : 'auto',
              maxHeight: '90dvh',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="go-modal__header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Barcode size={20} style={{ color: 'var(--color-interactive)' }} />
                <h3 className="go-modal__title" style={{ fontSize: '16px' }}>Scan Barcode / Serial</h3>
              </div>
              <button type="button" className="go-modal__close-btn" onClick={handleCloseScanner}>
                <X size={18} />
              </button>
            </div>

            <div className={`go-scanner-edit-body${scannerWide ? ' go-scanner-body--split' : ''}`}>
              <div className="go-scanner-col">
                <div className={`go-scanner-camera-wrapper${frameHit ? ' is-hit' : ''}`}>
                  <div id="barcode-reader-edit" className="go-scanner-reader"></div>
                  <div className="go-scanner-frame" key={frameHit} aria-hidden="true"></div>
                  {!cameraActive && (!scanFeedback || scanFeedback.type !== 'error') && (
                    <div className="go-scanner-camera-placeholder">
                      <span className="go-scanner-spinner"></span>
                      <p className="go-scanner-placeholder-text">Mengaktifkan kamera...</p>
                    </div>
                  )}
                </div>

                {scanFeedback && (
                  <div className={`go-scanner-feedback--inline ${scanFeedback.type}`}>
                    {scanFeedback.message}
                  </div>
                )}

                <form onSubmit={handleAddManualSerial} style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ketik serial manual jika kamera sulit..."
                    value={manualSerialInput}
                    onChange={(e) => setManualSerialInput(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={!manualSerialInput.trim()}>
                    Tambah
                  </button>
                </form>
              </div>

              <div className="go-scanner-col go-scanner-col--results">
                {tempScannedLines.length > 0 && (
                  <div className="go-scanner-edit-results">
                    <div className="go-scanner-edit-results-title">
                      Item Terpindai ({tempScannedLines.length}):
                    </div>
                    <div className="go-scanner-edit-results-list">
                      {tempScannedLines.map((item) => (
                        <div key={item.id} className="go-scanner-edit-result-row">
                          <div>
                            <strong>{item.serialNumber}</strong> - {item.productName} ({item.qtyUnit})
                          </div>
                          <button
                            type="button"
                            className="go-scanner-edit-result-remove"
                            onClick={() => handleRemoveTempLine(item.id)}
                            aria-label="Hapus"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="go-modal__footer">
              <button type="button" className="btn btn-secondary btn-md" onClick={handleCloseScanner}>
                Tutup
              </button>
              <button
                type="button"
                className="btn btn-primary btn-md"
                onClick={handleApplyScanned}
                disabled={tempScannedLines.length === 0}
              >
                Terapkan ({tempScannedLines.length}) Item
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Product Registration Modal */}
      <QuickProductModal
        open={quickProduct.open}
        prefillName={quickProduct.prefillName}
        onClose={() => setQuickProduct({ open: false, prefillName: '', targetLineId: null })}
        onCreated={(newProduct) => {
          if (quickProduct.targetLineId) {
            handleLineChange(quickProduct.targetLineId, {
              productId: newProduct.id,
              productName: newProduct.name,
              sku: newProduct.sku,
            });
          }
          setQuickProduct({ open: false, prefillName: '', targetLineId: null });
        }}
      />
    </div>
  );
}

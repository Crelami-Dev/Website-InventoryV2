import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Plus, AlertCircle, AlertTriangle, Check, Search, ChevronDown, Camera, Barcode } from 'lucide-react';
import { useCameraScanner } from '../../hooks/useCameraScanner.js';
import { useDesktopScanShortcut } from '../../hooks/useDesktopScanShortcut.js';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api, buildDocumentNumber, getWorkspaceSettings, countDocsForSeqReset, DEFAULT_RULES } from '../../utils/api.js';
import GoodsOutLineItem from './GoodsOutLineItem.jsx';
import QuickProductModal from './QuickProductModal.jsx';
import './GoodsOutCreateModal.css';

// Audio synthesis helper for scan feedback using browser AudioContext
function playBeep(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    // Resume context if suspended (browser security policies)
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 (High pleasant pitch)
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
      
      // Haptic vibration feedback if supported
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
      osc.frequency.setValueAtTime(220, ctx.currentTime); // Low buzz pitch
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function makeEmptyLine() {
  return {
    id: crypto.randomUUID(),
    productId: null,
    productName: '',
    sku: '',
    isSerial: false,
    qty: 1,
    qtyUnit: 'pcs',
    serialNumber: '',
  };
}

export default function GoodsOutCreateModal({
  sourcePo,
  onClose,
  onSuccess,
  products,
  customers,
  suppliers,
  contactsEnabled = true,
  existingDocsThisMonth,
  docs = [],
}) {
  const { t, lang } = useApp();
  const { units, multipliers, getMultiplier, formatUnitOption } = useUnits();
  const queryClient = useQueryClient();
  const inputRefs = useRef({});
  const sourceRef = useRef(null);
  const inFlightScansRef = useRef(new Set());
  const cooldownMapRef = useRef(new Map());
  // Serial lookup cache shared across every row in this modal, so a serial
  // resolved on row 1 is reused instantly by row 2 without another request.
  const serialCacheRef = useRef(new Map());
  // Compact index of every available serial in this warehouse, loaded once when
  // the modal opens so typing/scanning resolves in memory with no round trip.
  const serialIndexRef = useRef(new Map());
  const [serialIndexReady, setSerialIndexReady] = useState(false);

  // Fetch settings for numbering rules
  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  // Target PO Items calculation if opened for PO fulfillment
  const poTargetItems = useMemo(() => {
    if (!sourcePo || !Array.isArray(sourcePo.items)) return [];
    return sourcePo.items.map((it, idx) => {
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
  }, [sourcePo, getMultiplier]);

  const [date, setDate] = useState(todayIso());
  const effectiveDocsCount = useMemo(() => {
    if (docs && docs.length > 0) {
      const rules = settings?.numbering?.rules || (Array.isArray(settings?.numbering) ? settings.numbering : null);
      const rule = rules?.find((r) => r.type === 'goods_out') || DEFAULT_RULES.find((r) => r.type === 'goods_out');
      return countDocsForSeqReset(docs, rule, date);
    }
    return existingDocsThisMonth ?? 0;
  }, [docs, settings, date, existingDocsThisMonth]);

  const refNumber = useMemo(
    () => buildDocumentNumber('goods_out', date, effectiveDocsCount, settings),
    [settings, date, effectiveDocsCount]
  );
  const [source, setSource] = useState(sourcePo?.vendor_name || '');
  const [contactId, setContactId] = useState(null);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [notes, setNotes] = useState(
    sourcePo
      ? sourcePo.notes
        ? `${sourcePo.notes} (PO: ${sourcePo.po_number})`
        : `Pemenuhan PO: ${sourcePo.po_number}`
      : ''
  );
  const [lines, setLines] = useState([makeEmptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const isDraftSavingRef = useRef(false);
  const desktopInputRefs = useRef({});
  const mobileInputRefs = useRef({});

  // Barcode Camera Scanner States & Effects
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerWide, setScannerWide] = useState(false);
  const [tempScannedLines, setTempScannedLines] = useState([]);
  const [manualSerialInput, setManualSerialInput] = useState('');
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

  const focusLineInput = (lineId) => {
    const isMobile = window.innerWidth < 768;
    const targetEl = isMobile ? mobileInputRefs.current[lineId] : desktopInputRefs.current[lineId];
    if (targetEl && targetEl.offsetParent !== null) {
      targetEl.focus();
    }
  };

  // Handle scanned code
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
      const lookupRes = await api.get(`/api/workspace/product-serial-lookup?serial=${encodeURIComponent(cleanCode)}`);
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
            message: rawMsg || `Nomor seri "${cleanCode}" tidak tersedia!`,
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

      // Strict validation if fulfilling a Purchase Order
      if (sourcePo && poTargetItems.length > 0) {
        const prodSku = String(product.sku || '').toLowerCase();
        const prodName = String(product.name || '').toLowerCase();

        // 1. Try finding exact SKU/Name match first
        let matchedTarget = poTargetItems.find((target) => {
          const tSku = target.sku.toLowerCase();
          const tName = target.itemName.toLowerCase();
          return (
            (tSku && tSku !== 'non-sku' && prodSku && (prodSku === tSku || prodSku.startsWith(tSku))) ||
            (tName && prodName && prodName === tName)
          );
        });

        // 2. If no exact match, fallback to unfulfilled non-catalog item if available
        if (!matchedTarget) {
          matchedTarget = poTargetItems.find((target) => {
            const isNonCat = !target.sku || target.sku.toLowerCase() === 'non-sku';
            if (!isNonCat) return false;
            const prog = poFulfillmentProgress.find((p) => p.id === target.id);
            return !prog || !prog.isComplete;
          });
        }

        if (!matchedTarget) {
          playBeep('error');
          setScanFeedback({
            type: 'error',
            message: `Produk "${product.name}" (${product.sku}) TIDAK ADA dalam pesanan PO ${sourcePo.po_number}!`,
          });
          return;
        }

        const currentProgress = poFulfillmentProgress.find((p) => p.id === matchedTarget.id);
        if (currentProgress && currentProgress.isComplete) {
          playBeep('error');
          setScanFeedback({
            type: 'error',
            message: `Kuantitas untuk "${matchedTarget.itemName}" sudah terpenuhi (${currentProgress.scannedCount}/${matchedTarget.targetQty} ${matchedTarget.unit})!`,
          });
          return;
        }
      }

      const isGroup = Boolean(matched.metadata?.isGroup || matched.isGroup);
      const rawGroupQty = Number(matched.metadata?.targetQty ?? matched.metadata?.unitQty ?? matched.targetQty);
      const qty = isGroup && Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : 1;

      // Define unit mapper
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
        const rawUnit =
          product?.metadata?.qtyUnit ||
          product?.metadata?.unit ||
          'pcs';
        qtyUnit = unitMap[rawUnit] ?? rawUnit ?? 'pcs';
      }

      const newLine = {
        id: crypto.randomUUID(),
        productId: product.id,
        productName: product.name,
        sku: product.sku || '',
        isSerial: true,
        isGroup,
        serialNumber: matched.serialNumber ?? matched.serial_number,
        qty,
        qtyUnit: qtyUnit,
        targetQty: isGroup ? qty : undefined,
        targetUnit: isGroup ? qtyUnit : undefined,
        totalPcs: isGroup ? qty * (multipliers[qtyUnit] || 1) : undefined,
      };

      // Atomic deduplication inside functional state update
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
  }, [lines, tempScannedLines, products, sourcePo, poTargetItems, poFulfillmentProgress, t]);

  // Preload the warehouse's available-serial index once, so serial input
  // resolves locally instead of hitting the network on every keystroke.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/workspace/product-serial-index');
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
        setSerialIndexReady(true);
      } catch (_) {
        // Index is an optimisation only; lookups still work over the network.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep ref up to date
  useEffect(() => {
    scanCallbackRef.current = handleBarcodeScanned;
  }, [handleBarcodeScanned]);

  useEffect(() => {
    if (scannerOpen) setScanFeedback(null);
  }, [scannerOpen]);

  const handleScannerError = useCallback(
    (message) => setScanFeedback({ type: 'error', message }),
    []
  );

  const { cameraActive, frameHit } = useCameraScanner({
    elementId: 'go-scanner-reader',
    active: scannerOpen,
    fps: 12,
    onDecode: (text) => scanCallbackRef.current?.(text),
    onError: handleScannerError,
  });

  const handleOpenScanner = ({ wide = false } = {}) => {
    setTempScannedLines([]);
    inFlightScansRef.current.clear();
    cooldownMapRef.current.clear();
    setScannerWide(wide);
    setScannerOpen(true);
  };

  const handleCloseScanner = () => {
    setScannerOpen(false);
  };

  const handleApplyScanned = () => {
    if (tempScannedLines.length > 0) {
      setLines((prev) => {
        // If the first row is empty/placeholder, replace it instead of appending
        const filteredPrev = prev.filter((p) => p.productId || p.serialNumber);
        return [...filteredPrev, ...tempScannedLines];
      });
    }
    setScannerOpen(false);
  };

  const handleRemoveTempLine = (id) => {
    setTempScannedLines((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed) {
        cooldownMapRef.current.delete(String(removed.serialNumber || '').trim().toLowerCase());
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
    if (!source.trim()) return [];
    const q = source.toLowerCase();
    return allContacts.filter((c) =>
      (c.name ?? c.nama ?? '').toLowerCase().includes(q)
    );
  }, [allContacts, source]);

  const isExistingContact = useMemo(() => {
    if (!source.trim() || !filteredContacts.length) return null;
    return filteredContacts.some(
      (c) => (c.name ?? c.nama ?? '').toLowerCase() === source.trim().toLowerCase()
    );
  }, [filteredContacts, source]);

  useClickOutside(sourceRef, () => setSourceDropdownOpen(false));

  const hasInvalidLines = useMemo(() => {
    if (!source.trim()) return true;
    if (lines.length === 0) return true;
    return lines.some((line) => {
      if (!line.productId) return true;
      if (line.productId === '__new__' && !line.sku?.trim()) return true;
      if (line.isUnrecorded) {
        return !line.qty || line.qty < 1;
      }
      if (line.isSerial) {
        if (!line.serialNumber?.trim()) return true;
      } else {
        if (!line.qty || line.qty < 1) return true;
      }
      return false;
    });
  }, [source, lines]);

  const handleLineChange = useCallback((lineId, updatedFields) => {
    setLines((prev) =>
      prev.map((l) => (l.id === lineId ? { ...l, ...updatedFields } : l))
    );
  }, []);

  const handleAddRow = () => {
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      if (!lastLine.productId) {
        return;
      }
      if (lastLine.productId === '__new__' && (!lastLine.productName?.trim() || !lastLine.sku?.trim())) {
        return;
      }
      if (lastLine.isSerial && !lastLine.serialNumber?.trim()) {
        return;
      }
    }
    const newId = crypto.randomUUID();
    setLines((prev) => [...prev, { ...makeEmptyLine(), id: newId }]);
    setTimeout(() => {
      focusLineInput(newId);
    }, 50);
  };

  const handleLineEnter = (lineId) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.id === lineId);
      if (idx === -1) return prev;
      if (idx === prev.length - 1) {
        const newId = crypto.randomUUID();
        const next = [...prev, { ...makeEmptyLine(), id: newId }];
        setTimeout(() => focusLineInput(newId), 40);
        return next;
      }
      const nextLine = prev[idx + 1];
      if (nextLine) {
        setTimeout(() => focusLineInput(nextLine.id), 40);
      }
      return prev;
    });
  };

  const handleRemoveRow = (lineId) => {
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  // Bulk-paste serial numbers (e.g. one Excel column) into the serial input
  // of a line: split into individual serials, resolve them all in a single
  // batch request, then fan the results out across existing + new rows instantly.
  const handlePasteSerials = async (fromLineId, rawText) => {
    const serials = String(rawText || '')
      .split(/[\r\n\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (serials.length <= 1) return false;

    // Single atomic batch request - backend returns serials AND products in one query
    const lookupRes = await api.post('/api/workspace/product-serial-lookup/batch', { serials }).catch(() => null);
    const lookupJson = lookupRes?.ok ? await lookupRes.json().catch(() => ({})) : {};
    const foundList = Array.isArray(lookupJson.data) ? lookupJson.data : [];
    const foundMap = new Map();
    foundList.forEach((s) => {
      const sn = String(s.serial_number ?? s.serialNumber ?? '').trim().toLowerCase();
      if (sn) foundMap.set(sn, s);
    });

    // Seed the shared cache so editing any pasted row later resolves instantly
    foundList.forEach((s) => {
      const sn = String(s.serial_number ?? s.serialNumber ?? '').trim().toLowerCase();
      if (sn && s.product && s.status === 'available') {
        serialCacheRef.current.set(sn, { matched: s, product: s.product });
      }
    });

    setLines((prev) => {
      const next = [...prev];
      const startIdx = next.findIndex((l) => l.id === fromLineId);
      const baseIdx = startIdx === -1 ? next.length - 1 : startIdx;

      // Check if any pasted serial is grouped or dissolved
      const blockedSerials = [];
      serials.forEach((serialVal) => {
        const rawMatch = foundMap.get(serialVal.toLowerCase());
        const isGrouped = Boolean(rawMatch?.metadata?.isGrouped || rawMatch?.metadata?.parentGroupId || rawMatch?.isGrouped);
        const isDissolved = Boolean(rawMatch?.metadata?.isDissolved || rawMatch?.isDissolved);
        if (isGrouped) {
          const parentSn = rawMatch?.metadata?.parentGroupSerialNumber || rawMatch?.parentGroupSerialNumber || 'Group';
          blockedSerials.push(`"${serialVal}" (di dalam ${parentSn})`);
        } else if (isDissolved) {
          blockedSerials.push(`"${serialVal}" (group sudah dibongkar)`);
        }
      });

      if (blockedSerials.length > 0) {
        playBeep('error');
        setScanFeedback({
          type: 'error',
          message: `Nomor seri anak tidak dapat dikeluarkan: ${blockedSerials.slice(0, 3).join(', ')}${blockedSerials.length > 3 ? '...' : ''}. Bongkar group induk terlebih dahulu!`,
        });
      }

      serials.forEach((serialVal, i) => {
        const targetIdx = baseIdx + i;
        const rawMatch = foundMap.get(serialVal.toLowerCase());
        const isGrouped = Boolean(rawMatch?.metadata?.isGrouped || rawMatch?.metadata?.parentGroupId || rawMatch?.isGrouped);
        const isDissolved = Boolean(rawMatch?.metadata?.isDissolved || rawMatch?.isDissolved);
        const matched = rawMatch && rawMatch.status === 'available' && !isGrouped && !isDissolved ? rawMatch : null;
        const matchedProductId = matched?.product_id ?? matched?.productId ?? null;
        const product = matched?.product || (matchedProductId ? products.find((p) => p.id === matchedProductId) : null);

        let resolvedFields;
        if (matched && product) {
          const snLower = String(matched.serial_number ?? matched.serialNumber ?? '').toLowerCase();
          const isGroup = Boolean(matched.metadata?.isGroup || matched.isGroup);
          const rawGroupQty = Number(matched.metadata?.targetQty ?? matched.metadata?.unitQty ?? matched.targetQty);
          const qty = isGroup && Number.isFinite(rawGroupQty) && rawGroupQty > 0 ? rawGroupQty : 1;

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
            const rawUnit = product?.metadata?.qtyUnit || 'pcs';
            qtyUnit = unitMap[rawUnit] ?? rawUnit ?? 'pcs';
          }

          resolvedFields = {
            productId: product.id,
            productName: product.name,
            sku: product.sku || '',
            isSerial: true,
            serialNumber: matched.serial_number ?? matched.serialNumber ?? serialVal,
            qty,
            qtyUnit: qtyUnit,
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

      // Append ONE empty row at the bottom and immediately focus its serial input
      const newEmptyId = crypto.randomUUID();
      next.push({ ...makeEmptyLine(), id: newEmptyId });
      setTimeout(() => focusLineInput(newEmptyId), 50);

      return next;
    });

    playBeep('success');
    return true;
  };

  const handleSelectContact = (contact) => {
    setSource(contact.name ?? contact.nama ?? '');
    setContactId(contact.id);
    setSourceDropdownOpen(false);
  };

  const handleCreateNew = async (type) => {
    const name = source.trim();
    if (!name) return null;
    if (!contactsEnabled) {
      setSourceDropdownOpen(false);
      return null;
    }
    try {
      const res = await api.post('/api/workspace/contacts', { name, type });
      if (!res.ok) throw new Error(t('goodsOut.error.contactCreateFailed'));
      const json = await res.json();
      const newContact = json.data ?? json;
      setSource(newContact.name ?? newContact.nama ?? name);
      setContactId(newContact.id);
      setSourceDropdownOpen(false);
      return newContact;
    } catch (err) {
      setError(err.message || t('goodsOut.error.contactCreateFailed'));
      return null;
    }
  };

  const validate = () => {
    if (!source.trim()) return t('goodsOut.error.sourceRequired');
    if (lines.length === 0) return t('goodsOut.error.noItems');
    
    const seenSerials = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.productId) return t('goodsOut.error.productRequired');
      if (line.productId === '__new__' && !line.sku?.trim()) return t('goodsOut.error.skuRequired');
      
      const product = products.find((p) => p.id === line.productId);
      const availableStock = product ? Number(product.stockNonSerial ?? product.metadata?.stockNonSerial ?? product.stock ?? 0) : 0;
      
      const unit = line.qtyUnit || 'pcs';
      const multiplier = multipliers[unit] || 1;
      const requestedQty = line.isSerial ? multiplier : line.qty * multiplier;

      if (line.isUnrecorded) {
        if (!line.qty || line.qty < 1) return t('goodsOut.error.qtyRequired');
        // Unrecorded item: skip stock deduction check and serial validation
      } else if (!line.isSerial) {
        if (!line.qty || line.qty < 1) return t('goodsOut.error.qtyRequired');
        if (line.productId !== '__new__' && requestedQty > availableStock) {
          return t('goodsOut.error.qtyExceedsStock', { stock: availableStock });
        }
      } else {
        const sn = String(line.serialNumber || '').trim();
        if (!sn) return t('goodsOut.error.serialRequired');
        
        const snKey = sn.toLowerCase();
        if (seenSerials.has(snKey)) {
          return `Nomor seri "${sn}" duplikat! Tidak boleh mengeluarkan nomor seri yang sama lebih dari satu kali (baris ${i + 1}).`;
        }
        seenSerials.add(snKey);
      }
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // Step 0: Resolve / create contact
      let resolvedContactId = contactId;
      let resolvedContactName = source.trim();
      if (!resolvedContactId) {
        const exact = allContacts.find(
          (c) => (c.name ?? c.nama ?? '').toLowerCase() === source.trim().toLowerCase()
        );
        if (exact) {
          resolvedContactId = exact.id;
          resolvedContactName = exact.name ?? exact.nama ?? source.trim();
        }
      }

      // Step 1: Resolve inline products in batch
      const createdCache = {};
      const resolvedLines = [];
      const newProductsToBatch = [];
      const seenBatchKeys = new Set();

      for (const line of lines) {
        if (line.productId !== '__new__') continue;

        const skuKey = (line.sku || '').trim().toLowerCase();
        const nameKey = (line.productName || '').trim().toLowerCase();

        const existing = (products || []).find(
          (p) =>
            (skuKey && p.sku && p.sku.trim().toLowerCase() === skuKey) ||
            (nameKey && p.name && p.name.trim().toLowerCase() === nameKey)
        );
        if (existing) continue;

        const dedupKey = skuKey || nameKey;
        if (!dedupKey || seenBatchKeys.has(dedupKey)) continue;
        seenBatchKeys.add(dedupKey);

        newProductsToBatch.push({
          name: line.productName.trim(),
          sku: line.sku?.trim() || '',
          status: 'active',
          stock: 0,
          unitCost: 0,
          sellingPrice: 0,
          discountType: 'none',
          discountValue: 0,
        });
      }

      if (newProductsToBatch.length > 0) {
        const batchRes = await api.post('/api/workspace/products/batch', {
          products: newProductsToBatch,
        });
        if (!batchRes.ok) throw new Error(t('goodsOut.error.productCreateFailed'));
        const batchJson = await batchRes.json();
        const createdList = Array.isArray(batchJson.data) ? batchJson.data : [];

        for (const prod of createdList) {
          const sKey = (prod.sku || '').trim().toLowerCase();
          const nKey = (prod.name || '').trim().toLowerCase();
          if (sKey) createdCache[sKey] = prod;
          if (nKey) createdCache[nKey] = prod;
        }

        queryClient.setQueryData(['products'], (prev) => {
          if (!prev || !Array.isArray(prev)) return createdList;
          const existingIds = new Set(prev.map((p) => p.id));
          const additions = createdList.filter((p) => !existingIds.has(p.id));
          return [...additions, ...prev];
        });
      }

      for (const line of lines) {
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
          stock: 0,
          unitCost: 0,
          sellingPrice: 0,
          discountType: 'none',
          discountValue: 0,
        });
        if (!res.ok) throw new Error(t('goodsOut.error.productCreateFailed'));
        const json = await res.json();
        const newProd = json.data;
        if (skuKey) createdCache[skuKey] = newProd;
        if (nameKey) createdCache[nameKey] = newProd;
        resolvedLines.push({ ...line, productId: newProd.id, productName: newProd.name, sku: newProd.sku });
      }

      // Step 2: Resolve items payload
      const items = resolvedLines.map((line, idx) => {
        const unit = line.qtyUnit || 'pcs';
        const multiplier = multipliers[unit] || 1;
        const totalQty = (Number(line.qty) || 1) * multiplier;

        return {
          productId: line.productId && line.productId !== '__new__' ? line.productId : null,
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
                    resultProductId: line.productId && line.productId !== '__new__' ? line.productId : null,
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

      // Step 2: Create the goods-out document
      const docRes = await api.post('/api/workspace/documents', {
        documentType: 'goods_out',
        documentNumber: refNumber,
        contactId: resolvedContactId || null,
        contactName: resolvedContactName || null,
        status: 'processing',
        issueDate: date,
        notes: notes.trim() || null,
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 0,
        items,
        metadata: {
          ...(sourcePo ? { source_po_id: sourcePo.id, source_po_number: sourcePo.po_number } : {}),
        },
      });

      if (!docRes.ok) {
        const errJson = await docRes.json().catch(() => ({}));
        throw new Error(errJson?.message || errJson?.error?.message || t('goodsOut.error.createFailed') || 'Gagal membuat dokumen Barang Keluar');
      }

      const docJson = await docRes.json();
      const createdDoc = docJson.data;

      // Invalidate all related queries so stock and list updates immediately across the whole UI
      queryClient.setQueryData(['goods-out'], (prev) =>
        Array.isArray(prev) ? [createdDoc, ...prev] : [createdDoc]
      );
      queryClient.invalidateQueries({ queryKey: ['goods-out'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders-approved'] });

      onSuccess(createdDoc);
    } catch (err) {
      console.error(err);
      setError(err.message || t('goodsOut.error.createFailed') || 'Gagal menyimpan Barang Keluar');
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-save as draft when clicking outside backdrop or closing
  const handleSaveDraftAndClose = async () => {
    // Never auto-save/close while a sub-modal (QuickProductModal or Camera Scanner) is open
    if (quickProduct?.open || scannerOpen) return;

    // Only save draft if user actually added/selected at least one item or serial
    const validLines = lines.filter(
      (l) =>
        (l.productId && l.productId !== '__new__') ||
        (l.productName && l.productName.trim()) ||
        (l.serialNumber && l.serialNumber.trim())
    );

    if (validLines.length === 0) {
      onClose();
      return;
    }

    if (isDraftSavingRef.current || submitting) return;
    isDraftSavingRef.current = true;

    try {
      setSubmitting(true);

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

      const items = validLines.map((line) => {
        const isSerial = Boolean(line.isSerial);
        const qtyNum = Number(line.qty) || 1;
        const qtyUnit = line.qtyUnit || 'pcs';
        const mult = multipliers[qtyUnit] || 1;

        return {
          productId: line.productId === '__new__' ? null : line.productId || null,
          itemName: line.productName || 'Barang',
          sku: line.sku || 'NON-SKU',
          quantity: qtyNum * mult,
          unit: qtyUnit,
          metadata: {
            isSerial: isSerial,
            serialNumber: line.serialNumber || '',
            qtyInput: qtyNum,
            qtyUnit: qtyUnit,
            multiplier: mult,
          },
        };
      });

      const body = {
        documentType: 'goods_out',
        documentNumber: refNumber,
        contactId: resolvedContactId,
        contactName: resolvedContactName || (sourcePo ? sourcePo.vendor_name : 'Pelanggan'),
        status: 'draft',
        issueDate: date,
        notes: notes.trim() || (sourcePo ? `Draft Pemenuhan PO ${sourcePo.po_number}` : 'Draft Pengeluaran Barang'),
        metadata: {
          source_po_id: sourcePo?.id || null,
          source_po_number: sourcePo?.po_number || null,
          sourcePoId: sourcePo?.id || null,
          isDraftAutoSave: true,
        },
        items: items,
      };

      const res = await api.post('/api/workspace/documents', body);
      if (res.ok) {
        const json = await res.json();
        queryClient.invalidateQueries({ queryKey: ['goods-out'] });
        if (onSuccess) onSuccess(json.data);
      } else {
        onClose();
      }
    } catch (err) {
      console.warn('Auto-save draft on backdrop click notice:', err);
      onClose();
    } finally {
      setSubmitting(false);
      isDraftSavingRef.current = false;
    }
  };

  const hasFormContent = useMemo(() => {
    return lines.some(
      (l) =>
        (l.productId && l.productId !== '__new__') ||
        (l.productName && l.productName.trim()) ||
        (l.serialNumber && l.serialNumber.trim())
    );
  }, [lines]);

  return (
    <div
      className="go-modal-overlay"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (quickProduct?.open || scannerOpen) return;
        handleSaveDraftAndClose();
      }}
    >
      <section
        className="go-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="go-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="go-modal__header">
          <div>
            <h2 id="go-modal-title" className="go-modal__title">
              {sourcePo ? `Pengeluaran Barang dari PO ${sourcePo.po_number}` : t('goodsOut.modal.createTitle')}
            </h2>
            <p className="go-modal__subtitle">
              {sourcePo
                ? `Pindai (scan) nomor seri produk di gudang untuk memenuhi pesanan PO ${sourcePo.po_number}`
                : t('goodsOut.modal.createSubtitle')}
            </p>
          </div>
          <button type="button" className="go-modal__close-btn" onClick={handleSaveDraftAndClose}>
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div className="go-modal__body">
          <form id="goods-out-form" onSubmit={handleSubmit} noValidate>
            {/* PO Fulfillment Checklist Banner */}
            {sourcePo && poFulfillmentProgress.length > 0 && (
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
                      Checklist Pemenuhan Item PO ({sourcePo.po_number})
                    </span>
                    <span className="doc-chip doc-chip--paid" style={{ fontSize: '11px' }}>
                      Approved
                    </span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    Pelanggan / Vendor: <strong>{sourcePo.vendor_name}</strong>
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

            {/* Transaction details card */}
            <div className="go-modal__info-card">
              <h4 className="go-modal__info-title">
                {t('goodsOut.modal.transactionDetails')}
              </h4>
              <div className="go-modal__info-grid">
                {/* Reference */}
                <div className="go-modal__field">
                  <label className="go-modal__field-label">
                    {t('goodsOut.modal.reference')}
                  </label>
                  <input
                    type="text"
                    className="input"
                    value={refNumber}
                    disabled
                    readOnly
                  />
                  <p className="go-modal__field-subtext">
                    {t('goodsOut.modal.refHint')}
                  </p>
                </div>

                {/* Recipient / Destination */}
                <div className="go-modal__field">
                  <label className="go-modal__field-label">
                    {t('goodsOut.modal.source')} *
                  </label>
                  {/* Autocomplete field */}
                  <div className="go-source__wrap" ref={sourceRef}>
                    <div className="go-source__input-wrap">
                      <Search size={14} className="go-source__search-icon" />
                      <input
                        type="text"
                        className="input go-source__input"
                        placeholder={t('goodsOut.modal.sourcePlaceholder')}
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          setContactId(null);
                          setSourceDropdownOpen(true);
                        }}
                        onFocus={() => {
                          if (source.trim()) setSourceDropdownOpen(true);
                        }}
                      />
                      <ChevronDown size={14} className="go-source__chevron" />
                    </div>
                    {sourceDropdownOpen && (
                      <div className="go-source__dropdown">
                        {filteredContacts.length > 0 ? (
                          filteredContacts.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className="go-source__dropdown-item"
                              onMouseDown={(e) => { e.preventDefault(); handleSelectContact(c); }}
                            >
                              <span className="go-source__dropdown-item-name">
                                {c.name ?? c.nama ?? ''}
                              </span>
                              <span className="go-source__dropdown-item-meta">
                                {c._contactType === 'customer' ? t('goodsOut.modal.sourceTypeCustomer') : t('goodsOut.modal.sourceTypeSupplier')}
                              </span>
                            </button>
                          ))
                        ) : source.trim() && !isExistingContact ? (
                          <div className="go-source__dropdown-empty">
                            <span>{t('goodsOut.modal.sourceNoMatch')}</span>
                          </div>
                        ) : (
                          <div className="go-source__dropdown-empty">
                            <span>{t('goodsOut.modal.sourceSearchHint')}</span>
                          </div>
                        )}
                        {contactsEnabled && source.trim() && !isExistingContact && (
                          <div className="go-source__create-section">
                            <button
                              type="button"
                              className="go-source__dropdown-create"
                              onMouseDown={(e) => { e.preventDefault(); handleCreateNew('customer'); }}
                            >
                              <span className="go-source__dropdown-create-icon">
                                <Plus size={14} />
                              </span>
                              <span className="go-source__dropdown-create-text">
                                <span className="go-source__dropdown-create-label">
                                  {t('goodsOut.modal.sourceTypeCustomer')}
                                </span>
                                <span className="go-source__dropdown-create-name">
                                  {source.trim()}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="go-source__dropdown-create"
                              onMouseDown={(e) => { e.preventDefault(); handleCreateNew('supplier'); }}
                            >
                              <span className="go-source__dropdown-create-icon">
                                <Plus size={14} />
                              </span>
                              <span className="go-source__dropdown-create-text">
                                <span className="go-source__dropdown-create-label">
                                  {t('goodsOut.modal.sourceTypeSupplier')}
                                </span>
                                <span className="go-source__dropdown-create-name">
                                  {source.trim()}
                                </span>
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Date */}
                <div className="go-modal__field">
                  <label className="go-modal__field-label">
                    {t('goodsOut.modal.date')}
                  </label>
                  <input
                    type="date"
                    className="input"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="go-modal__field go-modal__field--full" style={{ marginTop: 'var(--space-4)' }}>
                <label className="go-modal__field-label">
                  {t('goodsOut.modal.notes')}
                </label>
                <textarea
                  className="input go-modal__notes"
                  placeholder={t('goodsOut.modal.notesPlaceholder')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            {/* Worksheet repeater */}
            <div className="go-modal__worksheet">
              <div className="go-modal__items-header">
                <h4 className="go-modal__items-title">{t('goodsOut.modal.items')}</h4>
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
                  >
                    <Plus size={14} />
                    <span>{t('goodsOut.modal.addRow')}</span>
                  </button>
                </div>
              </div>

              {/* Desktop Table view */}
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
                        <th scope="col">{t('goodsOut.modal.serialCol')}</th>
                        <th scope="col">{t('goodsOut.modal.productNameCol')}</th>
                        <th scope="col">{t('goodsOut.modal.skuCol')}</th>
                        <th scope="col">{t('goodsOut.modal.trackingCol')}</th>
                        <th scope="col" className="go-th--right">{t('goodsOut.modal.qtyCol')}</th>
                        <th scope="col"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, idx) => (
                        <GoodsOutLineItem
                          key={line.id}
                          rowIndex={idx}
                          item={line}
                          layout="table"
                          allowUnrecorded={settings?.allow_unrecorded_goods_out !== false}
                          onChange={(fields) => handleLineChange(line.id, fields)}
                          onRemove={() => handleRemoveRow(line.id)}
                          onAddRow={() => handleLineEnter(line.id)}
                          onCreateProduct={(prefillName) => setQuickProduct({ open: true, prefillName, targetLineId: line.id })}
                          onPasteSerials={(text) => handlePasteSerials(line.id, text)}
                          serialCache={serialCacheRef}
                          serialIndex={serialIndexRef}
                          products={products}
                          allLines={lines}
                          canRemove={lines.length > 1}
                          inputRef={(el) => {
                            if (el) desktopInputRefs.current[line.id] = el;
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile Card list view */}
              <div className="go-modal__cards-mobile">
                {lines.map((line) => (
                  <GoodsOutLineItem
                    key={line.id}
                    item={line}
                    layout="card"
                    allowUnrecorded={settings?.allow_unrecorded_goods_out !== false}
                    onChange={(fields) => handleLineChange(line.id, fields)}
                    onRemove={() => handleRemoveRow(line.id)}
                    onAddRow={() => handleLineEnter(line.id)}
                    onCreateProduct={(prefillName) => setQuickProduct({ open: true, prefillName, targetLineId: line.id })}
                    onPasteSerials={(text) => handlePasteSerials(line.id, text)}
                    serialCache={serialCacheRef}
                    serialIndex={serialIndexRef}
                    products={products}
                    allLines={lines}
                    canRemove={lines.length > 1}
                    inputRef={(el) => {
                      if (el) mobileInputRefs.current[line.id] = el;
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Error Banner */}
            {error && (
              <div className="go-modal__error">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
          </form>
        </div>

        {/* Footer actions */}
        <div className="go-modal__footer">
          <button
            type="button"
            className="btn btn-secondary btn-md"
            onClick={handleSaveDraftAndClose}
            disabled={submitting}
          >
            {hasFormContent ? 'Batal & Simpan Draft' : t('goodsOut.modal.cancel')}
          </button>
          <button
            type="submit"
            form="goods-out-form"
            className="btn btn-primary btn-md"
            disabled={submitting || hasInvalidLines}
            title={lang === 'id' ? 'Simpan dokumen ke status Pending untuk dicek sebelum dikeluarkan' : 'Save document as Pending'}
          >
            {submitting ? (
              t('goodsOut.modal.submitting')
            ) : (
              <>
                <Check size={16} />
                <span>{lang === 'id' ? 'Simpan ke Pending' : 'Save to Pending'}</span>
              </>
            )}
          </button>
        </div>
      </section>

      {/* Barcode Camera Scanner Modal Overlay */}
      {scannerOpen && (
        <div className="go-scanner-overlay" onClick={handleCloseScanner}>
          <div
            className={`go-scanner-container${scannerWide ? ' go-scanner-shell--wide' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="go-scanner-header">
              <div>
                <h3 className="go-scanner-title">Scan Serial Numbers</h3>
                <p className="go-scanner-subtitle">
                  {scannerWide
                    ? 'Arahkan webcam ke barcode nomor serial (SN). Tekan Ctrl+Shift+8 untuk menyembunyikan fitur kamera.'
                    : 'Arahkan kamera HP ke barcode nomor serial (SN)'}
                </p>
              </div>
              <button
                type="button"
                className="go-scanner-close"
                onClick={handleCloseScanner}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className={`go-scanner-body${scannerWide ? ' go-scanner-body--split' : ''}`}>
              <div className="go-scanner-col">
                <div className={`go-scanner-camera-wrapper${frameHit ? ' is-hit' : ''}`}>
                  <div id="go-scanner-reader" className="go-scanner-reader"></div>
                  {/* Stable CSS viewfinder: keyed on frameHit so the success ring
                      replays on every new code without ever resizing the box. */}
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

                {/* Manual Input Form */}
                <form onSubmit={handleAddManualSerial} className="go-scanner-manual-input-form">
                  <input
                    type="text"
                    className="input go-scanner-manual-input"
                    placeholder="Ketik serial number manual..."
                    value={manualSerialInput}
                    onChange={(e) => setManualSerialInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-secondary go-scanner-manual-btn">
                    Tambah
                  </button>
                </form>
              </div>

              <div className="go-scanner-col go-scanner-col--results">
                <div className="go-scanner-list-section">
                  <h5 className="go-scanner-list-title">
                    <span>Daftar Terpindai</span>
                    <span className="go-scanner-list-badge">{tempScannedLines.length} item</span>
                  </h5>

                  {tempScannedLines.length === 0 ? (
                    <div className="go-scanner-empty">
                      <Barcode size={32} className="go-scanner-empty-icon" />
                      <p>Belum ada item yang terdeteksi.</p>
                    </div>
                  ) : (
                    <div className="go-scanner-scanned-items">
                      {tempScannedLines.map((line) => (
                        <div key={line.id} className="go-scanner-scanned-item">
                          <div className="go-scanner-scanned-info">
                            <span className="go-scanner-scanned-sn">{line.serialNumber}</span>
                            <span className="go-scanner-scanned-product">
                              {line.productName} <small>({line.sku})</small>
                            </span>
                          </div>
                          <button
                            type="button"
                            className="go-scanner-scanned-remove"
                            onClick={() => handleRemoveTempLine(line.id)}
                            title="Hapus"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            <div className="go-scanner-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCloseScanner}
              >
                Batal
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleApplyScanned}
                disabled={tempScannedLines.length === 0}
              >
                Terapkan ({tempScannedLines.length})
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
          // Auto-select the new product in the target line item
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

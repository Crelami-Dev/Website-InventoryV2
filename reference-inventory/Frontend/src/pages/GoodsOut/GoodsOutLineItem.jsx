import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { Trash2, Search, Plus, ChevronDown, AlertTriangle } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api } from '../../utils/api.js';
import './GoodsOutCreateModal.css';

export default function GoodsOutLineItem({
  item = {},
  rowIndex = 0,
  onChange,
  onRemove,
  onAddRow,
  onCreateProduct,
  onPasteSerials,
  serialCache = null,
  serialIndex = null,
  products = [],
  allLines = [],
  canRemove = true,
  layout = 'table',
  inputRef,
  documentId = null,
  allowUnrecorded = true,
}) {
  const { t } = useApp();
  const { units, customUnits, formatUnitOption } = useUnits();
  const [search, setSearch] = useState(item?.productName || '');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const searchRef = useRef(null);
  const inputElRef = useRef(null);
  const qtyInputRef = useRef(null);
  const serialLookupSequence = useRef(0);
  const [serialLookupState, setSerialLookupState] = useState(
    item.serialNumber && item.productId ? 'valid' : 'idle'
  );
  const debounceTimerRef = useRef(null);
  const enterPendingRef = useRef(false);
  const localSerialCacheRef = useRef(new Map());
  // Prefer the cache owned by the parent modal so every row shares one set of
  // resolved serials; fall back to a per-row cache when no parent cache is passed.
  const serialCacheRef = serialCache || localSerialCacheRef;
  const lastKeyTimeRef = useRef(0); // tracks inter-keystroke timing for scanner detection
  // Hardware scanners send Enter within a few ms of the last character, before
  // React has re-rendered with the resolved product. This ref records the
  // resolution synchronously so Enter can act on it immediately.
  const resolvedSerialRef = useRef(null);

  // Auto-focus blank rows on mount
  useEffect(() => {
    if (!item.productId && !item.serialNumber && !item.isUnrecorded) {
      const timer = setTimeout(() => {
        inputElRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, []);

  // Sync internal search state when item.productName changes
  useEffect(() => {
    if (item.productName !== search) {
      setSearch(item.productName || '');
    }
  }, [item.productName]);

  useClickOutside(dropdownRef, () => setDropdownOpen(false));

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const q = search.toLowerCase().trim();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q))
      );
    }).slice(0, 12);
  }, [products, search]);

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setDropdownOpen(true);
    if (item.productId) {
      onChange({ productId: null, productName: e.target.value, sku: '' });
    }
  };

  const handleSelectProduct = (product) => {
    setSearch(product.name);
    setDropdownOpen(false);
    onChange({ productId: product.id, productName: product.name, sku: product.sku || '' });
    if (!item.isSerial) {
      setTimeout(() => {
        if (qtyInputRef.current) {
          qtyInputRef.current.focus();
          qtyInputRef.current.select();
        }
      }, 50);
    }
  };

  const handleNewProduct = () => {
    setDropdownOpen(false);
    // Delegate to parent via onCreateProduct callback to open the QuickProductModal
    if (onCreateProduct) {
      onCreateProduct(search.trim());
    }
  };

  const handleSerialToggle = () => {
    const next = !item.isSerial;
    onChange({
      isSerial: next,
      isUnrecorded: false,
      qty: 1,
      qtyUnit: 'pcs',
      serialNumber: '',
    });
  };

  const handleUnrecordedToggle = (checked) => {
    if (checked) {
      onChange({
        isUnrecorded: true,
        isSerial: false,
        serialNumber: '',
        qty: item.qty || 1,
        qtyUnit: item.qtyUnit || 'pcs',
      });
      setSerialLookupState('idle');
      setTimeout(() => {
        if (searchRef.current) {
          searchRef.current.focus();
        }
      }, 50);
    } else {
      onChange({
        isUnrecorded: false,
        isSerial: false,
        serialNumber: '',
        qty: item.qty || 1,
        qtyUnit: item.qtyUnit || 'pcs',
      });
      setSerialLookupState('idle');
    }
  };

  const handleQtyChange = (e) => {
    const raw = e.target.value;
    if (raw === '') {
      onChange({ qty: '' });
    } else {
      const num = parseFloat(raw.replace(',', '.'));
      onChange({ qty: isNaN(num) ? raw : num });
    }
  };

  const handleQtyBlur = (e) => {
    const raw = e.target.value;
    const num = parseFloat(String(raw).replace(',', '.'));
    if (isNaN(num) || num <= 0) {
      onChange({ qty: 1 });
    } else {
      onChange({ qty: Number(num.toFixed(2)) });
    }
  };

  const handleUnitChange = (e) => {
    onChange({ qtyUnit: e.target.value });
  };

  const handleProductKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdownOpen && filteredProducts.length === 1) {
        handleSelectProduct(filteredProducts[0]);
        return;
      }
      if (item.productId && !isInvalidSerial) {
        if (item.isSerial && !item.serialNumber?.trim()) return;
        onAddRow?.();
      }
    }
  };

  const detectQtyAndUnit = (serialObj, prodObj) => {
    const isGroup = Boolean(
      serialObj?.metadata?.isGroup ??
      serialObj?.isGroup ??
      false
    );

    const raw =
      serialObj?.metadata?.targetUnit ||
      serialObj?.targetUnit ||
      serialObj?.metadata?.serialUnit ||
      serialObj?.metadata?.unit ||
      serialObj?.metadata?.qtyUnit ||
      serialObj?.unit ||
      serialObj?.serialUnit ||
      '';

    let qtyUnit = 'pcs';
    const cleanRaw = String(raw).toLowerCase().trim();
    if (cleanRaw && cleanRaw !== 'pcs' && cleanRaw !== 'piece') {
      if (Array.isArray(customUnits) && customUnits.length > 0) {
        const found = customUnits.find((u) => u.key && String(u.key).toLowerCase().trim() === cleanRaw);
        if (found) qtyUnit = found.key;
        else qtyUnit = cleanRaw;
      } else {
        qtyUnit = cleanRaw;
      }
      if (qtyUnit === cleanRaw) {
        if (cleanRaw.includes('bal10') || cleanRaw.includes('10bl')) qtyUnit = 'bal10';
        else if (cleanRaw.includes('bal15') || cleanRaw.includes('15bl')) qtyUnit = 'bal15';
        else if (cleanRaw.includes('bal20') || cleanRaw.includes('20bl')) qtyUnit = 'bal20';
        else if (cleanRaw.includes('bal25') || cleanRaw.includes('25bl')) qtyUnit = 'bal25';
        else if (cleanRaw.includes('bal5') || cleanRaw.includes('5bl')) qtyUnit = 'bal5';
        else if (cleanRaw.includes('pack3') || cleanRaw.includes('pk3')) qtyUnit = 'pack3';
        else if (cleanRaw.includes('pack6') || cleanRaw.includes('pk6')) qtyUnit = 'pack6';
        else if (cleanRaw.includes('bal') || cleanRaw.includes('bl')) qtyUnit = 'bal';
        else if (cleanRaw.includes('pack') || cleanRaw.includes('pk')) qtyUnit = 'pack';
        else if (cleanRaw.includes('lusin') || cleanRaw.includes('dozen') || cleanRaw.includes('doz')) qtyUnit = 'lusin';
      }
    } else if (cleanRaw === 'pcs' || cleanRaw === 'piece') {
      qtyUnit = 'pcs';
    } else {
      // Fallback: guess from serial string pattern
      const sn = String(serialObj?.serialNumber ?? serialObj?.serial_number ?? '').toLowerCase();
      if (Array.isArray(customUnits) && customUnits.length > 0) {
        const sorted = [...customUnits].sort((a, b) => (b.key?.length || 0) - (a.key?.length || 0));
        for (const u of sorted) {
          const k = String(u.key).toLowerCase().trim();
          if (!k || k === 'pcs') continue;
          if (sn.includes(k)) {
            qtyUnit = k;
            break;
          }
        }
      }
      if (qtyUnit === 'pcs') {
        if (sn.includes('10bl') || sn.includes('bl10') || sn.includes('bal10')) qtyUnit = 'bal10';
        else if (sn.includes('15bl') || sn.includes('bl15') || sn.includes('bal15')) qtyUnit = 'bal15';
        else if (sn.includes('20bl') || sn.includes('bl20') || sn.includes('bal20')) qtyUnit = 'bal20';
        else if (sn.includes('25bl') || sn.includes('bl25') || sn.includes('bal25')) qtyUnit = 'bal25';
        else if (sn.includes('5bl') || sn.includes('bl5') || sn.includes('bal5')) qtyUnit = 'bal5';
        else if (sn.includes('pack3') || sn.includes('pk3')) qtyUnit = 'pack3';
        else if (sn.includes('pack6') || sn.includes('pk6')) qtyUnit = 'pack6';
        else if (sn.includes('bal') || sn.includes('bl')) qtyUnit = 'bal';
        else if (sn.includes('pack') || sn.includes('pk')) qtyUnit = 'pack';
        else if (sn.includes('lusin') || sn.includes('dozen')) qtyUnit = 'lusin';
        else {
          const prodRaw = prodObj?.metadata?.qtyUnit || prodObj?.metadata?.unit || '';
          if (prodRaw) qtyUnit = String(prodRaw).toLowerCase().trim();
        }
      }
    }

    let qty = 1;
    if (isGroup) {
      const rawGroupQty = Number(
        serialObj?.metadata?.targetQty ??
        serialObj?.metadata?.unitQty ??
        serialObj?.targetQty ??
        serialObj?.unitQty ??
        1
      );
      if (Number.isFinite(rawGroupQty) && rawGroupQty > 0) {
        qty = rawGroupQty;
      }
    }

    return { qty, qtyUnit, isGroup };
  };

  const detectUnit = (serialObj, prodObj) => detectQtyAndUnit(serialObj, prodObj).qtyUnit;

  // Moves focus to the next row after a serial resolves. Guarded by the serial
  // itself so the instant resolution and the scanner's trailing Enter can both
  // call it while only one new row is ever created.
  const advancedForRef = useRef(null);
  const advanceRow = (serialKey) => {
    if (serialKey && advancedForRef.current === serialKey) return;
    advancedForRef.current = serialKey || null;
    setTimeout(() => onAddRow?.(), 30);
  };

  const executeLookup = async (val, shouldAdvanceOnSuccess = false) => {
    const clean = val.trim();
    if (!clean) {
      setSerialLookupState('idle');
      onChange({
        productId: null,
        productName: '',
        sku: '',
        isSerial: false,
        serialNumber: '',
      });
      return;
    }

    const cleanLower = clean.toLowerCase();
    // 1. Instant Cache Check (0ms response time on repeat scans or re-focus)
    if (serialCacheRef.current.has(cleanLower)) {
      const cached = serialCacheRef.current.get(cleanLower);
      if (cached.matched && cached.product) {
        const { qty, qtyUnit } = detectQtyAndUnit(cached.matched, cached.product);
        onChange({
          productId: cached.product.id,
          productName: cached.product.name,
          sku: cached.product.sku || '',
          isSerial: true,
          serialNumber: cached.matched.serialNumber ?? cached.matched.serial_number ?? clean,
          qty: cached.qty || qty,
          qtyUnit: cached.qtyUnit || qtyUnit,
        });
        setSerialLookupState('valid');
        resolvedSerialRef.current = cleanLower;
        if (shouldAdvanceOnSuccess || enterPendingRef.current) {
          enterPendingRef.current = false;
          advanceRow(cleanLower);
        }
        return;
      }
    }

    const sequence = ++serialLookupSequence.current;
    setSerialLookupState('loading');

    const lookupUrl = documentId
      ? `/api/workspace/product-serial-lookup?serial=${encodeURIComponent(clean)}&documentId=${encodeURIComponent(documentId)}`
      : `/api/workspace/product-serial-lookup?serial=${encodeURIComponent(clean)}`;

    const response = await api.get(lookupUrl).catch(() => null);
    if (sequence !== serialLookupSequence.current) return;

    const payload = response?.ok ? await response.json().catch(() => ({})) : {};
    if (sequence !== serialLookupSequence.current) return;
    const matched = payload?.data ?? null;

    if (matched) {
      const matchedProductId = matched.productId ?? matched.product_id;
      // Backend now returns product embedded in the response — no extra fetch needed
      let product = matched.product || products.find((p) => p.id === matchedProductId);

      if (product) {
        const { qty, qtyUnit } = detectQtyAndUnit(matched, product);
        serialCacheRef.current.set(cleanLower, { matched, product, qtyUnit, qty });

        onChange({
          productId: product.id,
          productName: product.name,
          sku: product.sku || '',
          isSerial: true,
          serialNumber: matched.serialNumber ?? matched.serial_number ?? clean,
          qty,
          qtyUnit,
        });
        setSerialLookupState('valid');
        resolvedSerialRef.current = cleanLower;

        if (shouldAdvanceOnSuccess || enterPendingRef.current) {
          enterPendingRef.current = false;
          advanceRow(cleanLower);
        }
        return;
      }
    }

    setSerialLookupState('invalid');
    onChange({
      productId: null,
      productName: '',
      sku: '',
      isSerial: true,
      serialNumber: clean,
      qty: 1,
    });
  };


  const handleSerialInputChange = (val) => {
    // If multiple lines pasted without onPaste firing, delegate to onPasteSerials
    if ((val.includes('\n') || val.includes('\r')) && onPasteSerials) {
      onPasteSerials(val);
      return;
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!val.trim()) {
      resolvedSerialRef.current = null;
      advancedForRef.current = null;
      onChange({
        productId: null,
        productName: '',
        sku: '',
        isSerial: true,
        serialNumber: val,
        qty: 1,
      });
      executeLookup('');
      return;
    }

    // ── Instant local resolution ──────────────────────────────────────────
    // The warehouse serial index is already in memory, so an exact match
    // resolves with zero network latency, exactly like the product dropdown.
    const indexHit = serialIndex?.current?.get(val.trim().toLowerCase());
    if (indexHit) {
      const product = products.find((p) => p.id === indexHit.productId);
      if (product) {
        serialLookupSequence.current++; // cancel any in-flight lookup
        const { qty, qtyUnit } = detectQtyAndUnit({
          serial_number: indexHit.serial,
          isGroup: indexHit.isGroup,
          targetQty: indexHit.targetQty,
          metadata: {
            serialUnit: indexHit.unit,
            targetUnit: indexHit.unit,
            isGroup: indexHit.isGroup,
            targetQty: indexHit.targetQty,
          },
        }, product);
        onChange({
          productId: product.id,
          productName: product.name,
          sku: product.sku || '',
          isSerial: true,
          serialNumber: indexHit.serial,
          qty,
          qtyUnit,
        });
        setSerialLookupState('valid');
        enterPendingRef.current = false;

        // Record synchronously so a scanner's Enter (which arrives before the
        // re-render) sees the resolution instead of starting a network lookup.
        resolvedSerialRef.current = indexHit.serial.toLowerCase();

        // Advance once. advanceRow() is idempotent per resolved serial, so the
        // scanner's trailing Enter won't add a second blank row.
        advanceRow(indexHit.serial.toLowerCase());
        return;
      }
    }

    // Immediately update input field so typing/scanning feels instantaneous
    onChange({
      productId: null,
      productName: '',
      sku: '',
      isSerial: true,
      serialNumber: val,
      qty: 1,
    });

    // Smart debounce: barcode scanners send all chars in ~50ms bursts.
    // If inter-keystroke gap < 30ms → scanner mode → fire lookup 80ms after last char.
    // Manual typing (gap ≥ 30ms) → wait 600ms to avoid flooding 404s on partial serials.
    const now = Date.now();
    const gap = now - lastKeyTimeRef.current;
    lastKeyTimeRef.current = now;
    const delay = gap < 30 ? 80 : 600;

    // With a loaded index, the network lookup is only a safety net for serials
    // created after the index was fetched, so give it a little more slack.
    const indexLoaded = (serialIndex?.current?.size ?? 0) > 0;
    const effectiveDelay = indexLoaded ? Math.max(delay, 500) : delay;

    debounceTimerRef.current = setTimeout(() => {
      executeLookup(val, false);
    }, effectiveDelay);
  };

  const handleSerialKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      const typed = (e.target.value ?? item.serialNumber ?? '').trim();
      const typedKey = typed.toLowerCase();

      // A hardware scanner sends Enter a few ms after the last character, before
      // React re-renders. Check the ref first so the row advances immediately
      // instead of falling through to a network lookup.
      if (resolvedSerialRef.current && resolvedSerialRef.current === typedKey) {
        advanceRow(typedKey);
        return;
      }

      // Not resolved yet, but the serial may already be in the in-memory index.
      const indexHit = typed ? serialIndex?.current?.get(typedKey) : null;
      if (indexHit) {
        const product = products.find((p) => p.id === indexHit.productId);
        if (product) {
          serialLookupSequence.current++;
          const { qty, qtyUnit } = detectQtyAndUnit(
            {
              serial_number: indexHit.serial,
              isGroup: indexHit.isGroup,
              targetQty: indexHit.targetQty,
              metadata: {
                serialUnit: indexHit.unit,
                targetUnit: indexHit.unit,
                isGroup: indexHit.isGroup,
                targetQty: indexHit.targetQty,
              },
            },
            product
          );
          onChange({
            productId: product.id,
            productName: product.name,
            sku: product.sku || '',
            isSerial: true,
            serialNumber: indexHit.serial,
            qty,
            qtyUnit,
          });
          setSerialLookupState('valid');
          resolvedSerialRef.current = indexHit.serial.toLowerCase();
          advanceRow(indexHit.serial.toLowerCase());
          return;
        }
      }

      if (item.productId && !isInvalidSerial) {
        advanceRow(typedKey);
      } else if (typed) {
        enterPendingRef.current = true;
        executeLookup(typed, true);
      }
    }
  };

  // Validate serial number: duplicate check within the form
  const isDuplicateSerial = useMemo(() => {
    if (item.isUnrecorded) return false;
    if (!item.serialNumber?.trim()) return false;
    const sn = item.serialNumber.trim().toLowerCase();
    return (allLines || []).some(
      (l) => l.id !== item.id && !l.isUnrecorded && String(l.serialNumber || '').trim().toLowerCase() === sn
    );
  }, [item.id, item.serialNumber, item.isUnrecorded, allLines]);

  // Validate serial number exists and is available in inventory
  const isUnavailableSerial = !item.isUnrecorded && !!item.serialNumber?.trim() && serialLookupState === 'invalid';

  const isInvalidSerial = !item.isUnrecorded && (isDuplicateSerial || isUnavailableSerial || serialLookupState === 'loading');

  // Render Product Selector
  const renderProductSelector = () => {
    return (
      <div className="go-line-item__dropdown-wrap" ref={dropdownRef}>
        <div className="go-line-item__search-input-wrap">
          <Search size={13} className="go-line-item__search-icon" />
          <input
            ref={searchRef}
            type="text"
            className={`input go-line-item__search-input ${item.productId && item.productId !== '__new__' ? 'go-line-item__search-input--selected' : ''}`}
            placeholder={t('goodsOut.line.productPlaceholder')}
            value={search}
            onChange={handleSearchChange}
            onKeyDown={handleProductKeyDown}
            onFocus={() => setDropdownOpen(true)}
            autoComplete="off"
            disabled={item.isSerial && !!item.serialNumber}
          />
          <ChevronDown size={13} className="go-line-item__search-chevron" />
        </div>
        {dropdownOpen && (
          <div className="go-line-item__dropdown">
            {filteredProducts.length > 0 ? (
              filteredProducts.map((p) => (
                <button
                   key={p.id}
                   type="button"
                   className="go-line-item__dropdown-item"
                   onMouseDown={(e) => { e.preventDefault(); handleSelectProduct(p); }}
                >
                  <span className="go-line-item__dropdown-item-name">{p.name}</span>
                  <span className="go-line-item__dropdown-item-sku">{p.sku}</span>
                </button>
              ))
            ) : (
              <div className="go-line-item__dropdown-empty">
                {search.trim() ? t('goodsOut.line.noMatch') : t('goodsOut.line.typeToSearch')}
              </div>
            )}
            {search.trim() && (
              <button
                type="button"
                className="go-line-item__dropdown-create"
                onMouseDown={(e) => { e.preventDefault(); handleNewProduct(); }}
              >
                <Plus size={13} />
                <span>Buat "<strong>{search}</strong>"</span>
              </button>
            )}
          </div>
        )}
        {item.isUnrecorded && item.productId && (
          <div className="go-line-item__unrecorded-hint" title={t('goodsOut.line.unrecordedWarning')}>
            <AlertTriangle size={12} className="go-line-item__unrecorded-hint-icon" />
            <span>{t('goodsOut.line.unrecordedWarning')}</span>
          </div>
        )}
      </div>
    );
  };

  // Render Table Layout (Desktop)
  if (layout === 'table') {
    return (
      <tr className={`go-table-row hover:bg-slate-50/40 align-middle ${item.isUnrecorded ? 'go-table-row--unrecorded' : ''}`}>
        {/* Row number */}
        <td style={{ textAlign: 'center', verticalAlign: 'middle', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '11px', padding: 'var(--space-3)' }}>{rowIndex + 1}</td>
        {/* Serial Number (Typed/Scanned first on the left) */}
        <td className="px-3 py-3 align-top">
          {item.isUnrecorded ? (
            <div className="go-line-item__unrecorded-sn-box">
              <div className="go-line-item__unrecorded-badge-pill">
                <AlertTriangle size={12} className="text-warning flex-shrink-0" />
                <span>{t('goodsOut.line.unrecordedPlaceholder')}</span>
              </div>
              {allowUnrecorded && (
                <label className="go-line-item__unrecorded-checkbox" title="Klik untuk mematikan mode barang belum terdata">
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={(e) => handleUnrecordedToggle(e.target.checked)}
                  />
                  <span>{t('goodsOut.line.unrecordedLabel')}</span>
                </label>
              )}
            </div>
          ) : (
            <>
              <input
                type="text"
                className={`input ${isInvalidSerial ? 'go-line-item__sn-input--error' : ''}`}
                placeholder={t('goodsOut.line.serialPlaceholder')}
                value={item.serialNumber || ''}
                onChange={(e) => handleSerialInputChange(e.target.value)}
                onKeyDown={handleSerialKeyDown}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  const lineCount = text.split(/[\r\n\t]+/).map((s) => s.trim()).filter(Boolean).length;
                  if (lineCount > 1 && onPasteSerials) {
                    e.preventDefault();
                    onPasteSerials(text);
                  }
                }}
                ref={(el) => {
                  inputElRef.current = el;
                  if (inputRef) inputRef(el);
                }}
              />
              {isDuplicateSerial && (
                <span className="go-line-item__sn-msg go-line-item__sn-msg--error">
                  Nomor seri duplikat
                </span>
              )}
              {!isDuplicateSerial && isUnavailableSerial && (
                <span className="go-line-item__sn-msg go-line-item__sn-msg--error">
                  Nomor seri tidak tersedia
                </span>
              )}
              {allowUnrecorded && (
                <label className="go-line-item__unrecorded-checkbox" title="Tandai jika barang fisik belum ada label nomor seri atau belum masuk data stok">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={(e) => handleUnrecordedToggle(e.target.checked)}
                  />
                  <span>{t('goodsOut.line.unrecordedLabel')}</span>
                </label>
              )}
            </>
          )}
        </td>

        {/* Product selector */}
        <td className="px-3 py-3 align-top">
          {renderProductSelector()}
        </td>

        {/* SKU */}
        <td className="px-3 py-3 align-top">
          <input
            type="text"
            className="input go-line-item__sku-disabled"
            placeholder={t('goodsOut.line.autoFilled')}
            value={item.sku || ''}
            disabled
          />
        </td>

        {/* Tracking badge */}
        <td className="px-3 py-3 align-top">
          {item.isUnrecorded ? (
            <button
              type="button"
              className="go-line-item__tracking-btn badge-tracking badge-tracking--unrecorded"
              disabled
              title={t('goodsOut.line.unrecordedBadge')}
            >
              {t('goodsOut.line.unrecordedShort')}
            </button>
          ) : (
            <button
              type="button"
              className={`go-line-item__tracking-btn badge-tracking ${item.isSerial ? 'badge-tracking--serial' : ''}`}
              disabled
            >
              {item.isSerial ? t('goodsOut.line.trackingSerial') : t('goodsOut.line.trackingNormal')}
            </button>
          )}
        </td>

        {/* Quantity / Unit */}
        <td className="px-3 py-3 align-top">
          {item.isSerial && !item.isUnrecorded ? (
            <div className="go-line-item__qty-select-wrap">
              <input
                type="text"
                className="input go-line-item__sku-disabled go-line-item__qty-num-input"
                value={item.qty ?? 1}
                disabled
              />
              <select className="input select go-line-item__sku-disabled go-line-item__qty-unit-select" value={item.qtyUnit || 'pcs'} disabled>
                {units.map((u) => (
                  <option key={u.key} value={u.key}>
                    {formatUnitOption(u.key)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="go-line-item__qty-select-wrap">
              <input
                ref={qtyInputRef}
                type="number"
                step="any"
                min="0.01"
                className="input go-line-item__qty-num-input"
                value={item.qty === 0 || item.qty === '' ? '' : item.qty}
                onChange={handleQtyChange}
                onBlur={handleQtyBlur}
                onKeyDown={handleSerialKeyDown}
              />
              <select
                className="input select go-line-item__qty-unit-select"
                value={item.qtyUnit || 'pcs'}
                onChange={handleUnitChange}
              >
                {units.map((u) => (
                  <option key={u.key} value={u.key}>
                    {formatUnitOption(u.key)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </td>

        {/* Action (Remove Row) */}
        <td className="px-3 py-3 align-top text-center">
          {canRemove && (
            <button
              type="button"
              className="go-line-item__remove-btn"
              onClick={onRemove}
              title={t('goodsOut.line.remove')}
            >
              <Trash2 size={15} />
            </button>
          )}
        </td>
      </tr>
    );
  }

  // Render Card Layout (Mobile)
  return (
    <div className="go-line-item-card">
      {canRemove && (
        <button
          type="button"
          className="go-line-item-card__remove"
          onClick={onRemove}
          title={t('goodsOut.line.remove')}
        >
          <Trash2 size={14} />
        </button>
      )}

      {/* Serial Number & Unrecorded Toggle */}
      <div className="go-line-item-card__field">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
          <label className="go-line-item-card__label" style={{ margin: 0 }}>{t('goodsOut.line.serial')}</label>
          {allowUnrecorded && (
            <label className="go-line-item__unrecorded-checkbox" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={Boolean(item.isUnrecorded)}
                onChange={(e) => handleUnrecordedToggle(e.target.checked)}
              />
              <span>{t('goodsOut.line.unrecordedLabel')}</span>
            </label>
          )}
        </div>
        {item.isUnrecorded ? (
          <div className="go-line-item__unrecorded-badge-pill" style={{ height: 38, padding: '0 12px' }}>
            <AlertTriangle size={13} className="text-warning flex-shrink-0" />
            <span>{t('goodsOut.line.unrecordedBadge')}</span>
          </div>
        ) : (
          <>
            <input
              type="text"
              className={`input ${isInvalidSerial ? 'go-line-item__sn-input--error' : ''}`}
              placeholder={t('goodsOut.line.serialPlaceholder')}
              value={item.serialNumber || ''}
              onChange={(e) => handleSerialInputChange(e.target.value)}
              onKeyDown={handleSerialKeyDown}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                const lineCount = text.split(/[\r\n\t]+/).map((s) => s.trim()).filter(Boolean).length;
                if (lineCount > 1 && onPasteSerials) {
                  e.preventDefault();
                  onPasteSerials(text);
                }
              }}
              ref={(el) => {
                inputElRef.current = el;
                if (inputRef) inputRef(el);
              }}
            />
            {isDuplicateSerial && (
              <span className="go-line-item__sn-msg go-line-item__sn-msg--error">
                Nomor seri duplikat
              </span>
            )}
            {!isDuplicateSerial && isUnavailableSerial && (
              <span className="go-line-item__sn-msg go-line-item__sn-msg--error">
                Nomor seri tidak tersedia
              </span>
            )}
          </>
        )}
      </div>

      {/* Product Name */}
      <div className="go-line-item-card__field">
        <label className="go-line-item-card__label">{t('goodsOut.line.product')}</label>
        {renderProductSelector()}
      </div>

      {/* SKU & Tracking info row */}
      <div className="go-line-item-card__grid">
        <div>
          <label className="go-line-item-card__label">{t('goodsOut.line.sku')}</label>
          <input
            type="text"
            className="input go-line-item__sku-disabled"
            placeholder={t('goodsOut.line.autoFilled')}
            value={item.sku || ''}
            disabled
          />
        </div>
        <div>
          <label className="go-line-item-card__label">{t('goodsOut.line.serialMode')}</label>
          {item.isUnrecorded ? (
            <button
              type="button"
              className="go-line-item__tracking-btn badge-tracking badge-tracking--unrecorded"
              disabled
              style={{ width: '100%', height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {t('goodsOut.line.unrecordedShort')}
            </button>
          ) : (
            <button
              type="button"
              className={`go-line-item__tracking-btn badge-tracking ${item.isSerial ? 'badge-tracking--serial' : ''}`}
              disabled
              style={{ width: '100%', height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {item.isSerial ? t('goodsOut.line.trackingSerial') : t('goodsOut.line.trackingNormal')}
            </button>
          )}
        </div>
      </div>

      {/* Quantity / Unit */}
      <div className="go-line-item-card__field">
        <label className="go-line-item-card__label">{t('goodsOut.line.qty')}</label>
        {item.isSerial && !item.isUnrecorded ? (
          <div className="go-line-item__qty-select-wrap">
            <input
              type="text"
              className="input go-line-item__sku-disabled go-line-item__qty-num-input"
              value={item.qty ?? 1}
              disabled
            />
            <select className="input select go-line-item__sku-disabled go-line-item__qty-unit-select" value={item.qtyUnit || 'pcs'} disabled>
              {units.map((u) => (
                <option key={u.key} value={u.key}>
                  {formatUnitOption(u.key)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="go-line-item__qty-select-wrap">
            <input
              type="number"
              className="input go-line-item__qty-num-input"
              min={1}
              value={item.qty || 1}
              onChange={handleQtyChange}
              onKeyDown={handleSerialKeyDown}
            />
            <select
              className="input select go-line-item__qty-unit-select"
              value={item.qtyUnit || 'pcs'}
              onChange={handleUnitChange}
            >
              {units.map((u) => (
                <option key={u.key} value={u.key}>
                  {formatUnitOption(u.key)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

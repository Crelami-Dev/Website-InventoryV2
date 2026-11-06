import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { X, Plus, AlertCircle, Check, Search, ChevronDown, FileJson, CheckCircle2 } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, buildDocumentNumber, countDocsForSeqReset, DEFAULT_RULES, getWorkspaceSettings } from '../../utils/api.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUnits } from '../../hooks/useUnits.js';
import GoodsInLineItem from './GoodsInLineItem.jsx';
import './GoodsInCreateModal.css';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function makeEmptyLine() {
  return {
    id: crypto.randomUUID(),
    productId: null,
    productName: '',
    sku: '',
    qty: 1,
    qtyUnit: 'pcs',
  };
}

function docToLine(item) {
  const qty = item.metadata?.qtyInput ?? item.quantity ?? 1;
  return {
    id: crypto.randomUUID(),
    productId: item.product_id || null,
    productName: item.item_name || '',
    sku: item.sku || '',
    qty: Number(qty) || 1,
    qtyUnit: item.metadata?.qtyUnit || 'pcs',
  };
}

export default function GoodsInCreateModal({
  doc,
  initialAiData,
  onClose,
  onSuccess,
  products,
  suppliers,
  contactsEnabled = true,
  existingDocsThisMonth,
  docs = [],
}) {
  const { t } = useApp();
  const queryClient = useQueryClient();
  const isEdit = Boolean(doc);

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const [date, setDate] = useState(
    doc
      ? (doc.issue_date ? doc.issue_date.slice(0, 10) : todayIso())
      : (initialAiData?.date || todayIso())
  );
  const effectiveDocsCount = useMemo(() => {
    if (docs && docs.length > 0) {
      const rules = settings?.numbering?.rules || (Array.isArray(settings?.numbering) ? settings.numbering : null);
      const rule = rules?.find((r) => r.type === 'goods_in') || DEFAULT_RULES.find((r) => r.type === 'goods_in');
      return countDocsForSeqReset(docs, rule, date);
    }
    return existingDocsThisMonth ?? 0;
  }, [docs, settings, date, existingDocsThisMonth]);

  const refNumber = useMemo(
    () => isEdit
      ? doc.document_number
      : buildDocumentNumber('goods_in', date, effectiveDocsCount, settings),
    [settings, date, effectiveDocsCount, isEdit, doc]
  );
  const [source, setSource] = useState(
    doc
      ? (doc.contact_name || '')
      : (initialAiData?.vendor_name || '')
  );
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [sourceSelectedId, setSourceSelectedId] = useState(doc ? (doc.contact_id || null) : null);
  const sourceRef = useRef(null);
  const [notes, setNotes] = useState(
    doc
      ? (doc.notes || '')
      : (initialAiData?.notes ? `${initialAiData.notes} (AI OCR Import)` : '')
  );
  const [lines, setLines] = useState(() => {
    if (doc && doc.items?.length) {
      return doc.items.map(docToLine);
    }
    if (initialAiData?.items?.length) {
      return initialAiData.items.map((it) => ({
        id: crypto.randomUUID(),
        productId: it.productId || '__new__',
        productName: it.itemName || '',
        sku: it.sku || 'NON-SKU',
        isSerial: false,
        qty: it.qty || 1,
        qtyUnit: it.qtyUnit || 'pcs',
        serialNumber: '',
      }));
    }
    return [makeEmptyLine()];
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const { units, getMultiplier } = useUnits();
  const fileInputRef = useRef(null);
  const [importFeedback, setImportFeedback] = useState(null);

  // Hidden "Import JSON Rak" — only visible while CTRL is held (default hidden)
  const [showJsonRakImport, setShowJsonRakImport] = useState(false);
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey) setShowJsonRakImport(true);
    };
    const onKeyUp = (e) => {
      if (!e.ctrlKey && !e.metaKey) setShowJsonRakImport(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => setShowJsonRakImport(false));
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
  const desktopInputRefs = useRef({});
  const mobileInputRefs = useRef({});

  const resolveUnitKey = useCallback((rawUnit) => {
    const clean = String(rawUnit || '').trim().toLowerCase().replace(/\s+/g, '');
    let mapped = clean;
    if (['pack3', 'pck3', 'pak3'].includes(clean)) mapped = 'pack3';
    else if (['pack6', 'pck6', 'pak6'].includes(clean)) mapped = 'pack6';
    else if (['pack', 'pck', 'pak'].includes(clean)) mapped = (units || []).some((u) => u.key === 'pack') ? 'pack' : 'pack3';
    else if (['pcs', 'pc', 'piece', 'buah', 'biji'].includes(clean)) mapped = 'pcs';
    else if (['lusin', 'lsn', 'dozen', 'doz'].includes(clean)) mapped = 'lusin';
    else if (clean === 'bal5' || clean === '5bl') mapped = 'bal5';
    else if (clean === 'bal10' || clean === '10bl') mapped = 'bal10';
    else if (clean === 'bal15' || clean === '15bl') mapped = 'bal15';
    else if (clean === 'bal20' || clean === '20bl') mapped = 'bal20';
    else if (clean === 'bal25' || clean === '25bl' || clean === 'bal') mapped = 'bal25';

    const exists = (units || []).some((u) => u.key.toLowerCase() === mapped.toLowerCase());
    if (exists) return mapped;

    const byName = (units || []).find((u) => u.name && u.name.toLowerCase() === clean);
    if (byName) return byName.key;

    return (units && units[0]?.key) || 'pcs';
  }, [units]);

  const handleImportJsonFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      let itemsArray = null;
      if (Array.isArray(parsed)) {
        itemsArray = parsed;
      } else if (Array.isArray(parsed.items)) {
        itemsArray = parsed.items;
      } else if (Array.isArray(parsed.data)) {
        itemsArray = parsed.data;
      } else if (Array.isArray(parsed.products)) {
        itemsArray = parsed.products;
      }

      if (!itemsArray || itemsArray.length === 0) {
        setImportFeedback({
          type: 'error',
          text: 'File JSON kosong atau tidak memiliki format data array produk.',
        });
        return;
      }

      let existingCount = 0;
      let newCount = 0;

      const mappedLines = itemsArray.map((raw) => {
        const rawSku = String(raw.sku || raw.code || raw.item_sku || raw.product_sku || '').trim();
        const rawName = String(raw.name || raw.item_name || raw.product_name || raw.title || rawSku || '').trim();
        const rawQty = Number(raw.total ?? raw.qty ?? raw.quantity ?? raw.amount ?? 1);
        const qty = isNaN(rawQty) || rawQty <= 0 ? 1 : rawQty;
        const qtyUnit = resolveUnitKey(raw.unit || raw.qtyUnit || raw.satuan);

        const existing = (products || []).find((p) => {
          const pSku = (p.sku || '').trim().toLowerCase();
          const pName = (p.name || '').trim().toLowerCase();
          if (rawSku && pSku === rawSku.toLowerCase()) return true;
          if (rawName && pName === rawName.toLowerCase()) return true;
          return false;
        });

        if (existing) {
          existingCount++;
          return {
            id: crypto.randomUUID(),
            productId: existing.id,
            productName: existing.name,
            sku: existing.sku || rawSku,
            qty,
            qtyUnit,
            isNewProduct: false,
          };
        } else {
          newCount++;
          return {
            id: crypto.randomUUID(),
            productId: '__new__',
            productName: rawName || rawSku,
            sku: rawSku,
            qty,
            qtyUnit,
            isNewProduct: true,
          };
        }
      });

      setLines((prev) => {
        const isOnlyOneEmpty =
          prev.length === 1 &&
          !prev[0].productId &&
          !prev[0].productName &&
          !prev[0].sku;
        return isOnlyOneEmpty ? mappedLines : [...prev, ...mappedLines];
      });

      setImportFeedback({
        type: 'success',
        text: `Berhasil mengimpor ${mappedLines.length} item (${existingCount} produk terdaftar, ${newCount} produk baru disiapkan untuk dibuat otomatis).`,
      });
    } catch (err) {
      setImportFeedback({
        type: 'error',
        text: `Gagal membaca file JSON: ${err.message}`,
      });
    } finally {
      e.target.value = '';
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

  const filteredSuppliers = useMemo(() => {
    const q = source.toLowerCase().trim();
    if (!q) return suppliers.slice(0, 8);
    return suppliers
      .filter((s) => (s.name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [suppliers, source]);

  const isExistingSupplier = useMemo(
    () => suppliers.some((s) => (s.name || '').toLowerCase() === source.trim().toLowerCase()),
    [suppliers, source]
  );

  const hasInvalidLines = useMemo(() => {
    if (!source.trim()) return true;
    if (lines.length === 0) return true;
    return lines.some((line) => {
      if (!line.productId) return true;
      if (line.productId === '__new__' && !line.sku?.trim()) return true;
      if (!line.qty || line.qty < 1) return true;
      return false;
    });
  }, [source, lines]);

  const handleSourceChange = (e) => {
    setSource(e.target.value);
    setSourceDropdownOpen(true);
    setSourceSelectedId(null);
  };

  const handleSelectSupplier = (s) => {
    setSource(s.name);
    setSourceSelectedId(s.id);
    setSourceDropdownOpen(false);
  };

  const handleCreateNew = () => {
    setSourceDropdownOpen(false);
    // source stays as typed text, sourceSelectedId remains null
    // on submit, it will be auto-created
  };

  const handleLineChange = useCallback((lineId, updatedFields) => {
    setLines((prev) =>
      prev.map((l) => (l.id === lineId ? { ...l, ...updatedFields } : l))
    );
  }, []);

  const handleAddRow = useCallback(() => {
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      if (!lastLine.productId) {
        focusLineInput(lastLine.id);
        return;
      }
      if (lastLine.productId === '__new__' && (!lastLine.productName?.trim() || !lastLine.sku?.trim())) {
        return;
      }
    }
    const newId = crypto.randomUUID();
    setLines((prev) => [...prev, { ...makeEmptyLine(), id: newId }]);
    setTimeout(() => {
      focusLineInput(newId);
    }, 50);
  }, [lines]);

  const handleRemoveRow = (lineId) => {
    setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  const validate = () => {
    if (!source.trim()) return t('goodsIn.error.sourceRequired');
    if (lines.length === 0) return t('goodsIn.error.noItems');
    for (const line of lines) {
      if (!line.productId) return t('goodsIn.error.productRequired');
      if (line.productId === '__new__' && !line.sku?.trim()) return t('goodsIn.error.skuRequired');
      if (!line.qty || line.qty < 1) return t('goodsIn.error.qtyRequired');
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setSubmitting(true);
    setError(null);

    try {
      // Step 0: auto-create supplier if it doesn't exist
      let contactId = sourceSelectedId;
      let contactName = source.trim();
      if (!contactId && contactsEnabled) {
        const supRes = await api.post('/api/workspace/contacts', {
          type: 'supplier',
          name: contactName,
          phone: null, email: null, address: null, city: null, province: null,
          status: 'active',
          metadata: { taxId: '', notes: '', tag: 'Regular' },
        });
        if (supRes.ok) {
          const supJson = await supRes.json();
          contactId = supJson.data?.id || null;
        }
        // silently ignore failure — document still gets contactName
      }

      // Step 1: resolve inline-created products in 1 atomic batch
      const createdCache = {};
      const resolvedLines = [];
      const newProductsToBatch = [];
      const seenBatchKeys = new Set();

      // 1. Gather all unique new products that do not exist in preloaded catalog
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

      // 2. Batch create all new products simultaneously in single API call
      if (newProductsToBatch.length > 0) {
        const batchRes = await api.post('/api/workspace/products/batch', {
          products: newProductsToBatch,
        });
        if (!batchRes.ok) throw new Error(t('goodsIn.error.productCreateFailed'));
        const batchJson = await batchRes.json();
        const createdList = Array.isArray(batchJson.data) ? batchJson.data : [];

        for (const prod of createdList) {
          const sKey = (prod.sku || '').trim().toLowerCase();
          const nKey = (prod.name || '').trim().toLowerCase();
          if (sKey) createdCache[sKey] = prod;
          if (nKey) createdCache[nKey] = prod;
        }

        // Proactively populate local query cache so subsequent operations don't freeze on refetch
        queryClient.setQueryData(['products'], (prev) => {
          if (!prev || !Array.isArray(prev)) return createdList;
          const existingIds = new Set(prev.map((p) => p.id));
          const additions = createdList.filter((p) => !existingIds.has(p.id));
          return [...additions, ...prev];
        });
      }

      // 3. Map all lines to resolved products
      for (const line of lines) {
        if (line.productId !== '__new__') {
          resolvedLines.push(line);
          continue;
        }

        const skuKey = (line.sku || '').trim().toLowerCase();
        const nameKey = (line.productName || '').trim().toLowerCase();

        // Check preloaded products
        const existing = (products || []).find(
          (p) =>
            (skuKey && p.sku && p.sku.trim().toLowerCase() === skuKey) ||
            (nameKey && p.name && p.name.trim().toLowerCase() === nameKey)
        );
        if (existing) {
          resolvedLines.push({ ...line, productId: existing.id, productName: existing.name, sku: existing.sku });
          continue;
        }

        // Check batch-created cache
        const cached = (skuKey && createdCache[skuKey]) || (nameKey && createdCache[nameKey]);
        if (cached) {
          resolvedLines.push({ ...line, productId: cached.id, productName: cached.name, sku: cached.sku });
          continue;
        }

        // Fallback safety (rare)
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
        if (!res.ok) throw new Error(t('goodsIn.error.productCreateFailed'));
        const json = await res.json();
        const newProd = json.data;
        if (skuKey) createdCache[skuKey] = newProd;
        if (nameKey) createdCache[nameKey] = newProd;
        resolvedLines.push({ ...line, productId: newProd.id, productName: newProd.name, sku: newProd.sku });
      }

      // Step 2: build document items
      const items = resolvedLines.map((line, idx) => {
        const unit = line.qtyUnit || 'pcs';
        return {
          productId: line.productId,
          itemName: line.productName,
          sku: line.sku || '',
          quantity: line.qty,
          unitPrice: 0,
          discountType: 'none',
          discountValue: 0,
          amount: 0,
          sortOrder: idx,
          metadata: {
            qtyUnit: unit,
            unitName: units.find((candidate) => candidate.key === unit)?.name || unit,
            unitMultiplier: getMultiplier(unit),
            qtyInput: line.qty,
            baseQuantity: line.qty * getMultiplier(unit),
          },
        };
      });

      // Step 3: create or update document
      const payload = {
        documentType: 'goods_in',
        documentNumber: refNumber,
        contactId: contactId || null,
        contactName: contactName,
        status: isEdit ? (doc.status || 'processing') : 'processing',
        issueDate: date,
        notes: notes.trim() || null,
        subtotal: 0, discount: 0, tax: 0, total: 0,
        items,
      };

      const docRes = isEdit
        ? await api.patch(`/api/workspace/documents/${doc.id}`, payload)
        : await api.post('/api/workspace/documents', payload);

      if (!docRes.ok) {
        const errJson = await docRes.json().catch(() => ({}));
        throw new Error(errJson?.message || t(isEdit ? 'goodsIn.error.updateFailed' : 'goodsIn.error.createFailed'));
      }

      const docJson = await docRes.json();
      onSuccess(docJson.data);
    } catch (err) {
      setError(err.message || t(isEdit ? 'goodsIn.error.updateFailed' : 'goodsIn.error.createFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="gi-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="gi-modal-title">
      <section className="gi-modal">
        {/* Header */}
        <div className="gi-modal__header">
          <div>
            <h2 id="gi-modal-title" className="gi-modal__title">
              {t(isEdit ? 'goodsIn.modal.editTitle' : 'goodsIn.modal.createTitle')}
            </h2>
            <p className="gi-modal__subtitle">
              {t(isEdit ? 'goodsIn.modal.editSubtitle' : 'goodsIn.modal.createSubtitle')}
            </p>
          </div>
          <button type="button" className="gi-modal__close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="gi-modal__body">
          <form id="goods-in-form" onSubmit={handleSubmit} noValidate>

            {/* Transaction details */}
            <div className="gi-modal__info-card">
              <h4 className="gi-modal__info-title">{t('goodsIn.modal.transactionDetails')}</h4>
              <div className="gi-modal__info-grid">
                <div className="gi-modal__field">
                  <label className="gi-modal__field-label">{t('goodsIn.modal.reference')}</label>
                  <input type="text" className="input" value={refNumber} disabled readOnly />
                  <p className="gi-modal__field-subtext">{t('goodsIn.modal.refHint')}</p>
                </div>
                <div className="gi-modal__field">
                  <label className="gi-modal__field-label">{t('goodsIn.modal.source')} *</label>
                  <div className="gi-source__wrap" ref={sourceRef}>
                    <div className="gi-source__input-wrap">
                      <Search size={13} className="gi-source__search-icon" />
                      <input
                        type="text"
                        className="input gi-source__input"
                        placeholder={t('goodsIn.modal.sourcePlaceholder')}
                        value={source}
                        onChange={handleSourceChange}
                        onFocus={() => setSourceDropdownOpen(true)}
                        autoComplete="off"
                      />
                      <ChevronDown size={13} className="gi-source__chevron" />
                    </div>

                    {sourceDropdownOpen && (
                      <div className="gi-source__dropdown">
                        {filteredSuppliers.length > 0 ? (
                          filteredSuppliers.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className="gi-source__dropdown-item"
                              onMouseDown={(e) => { e.preventDefault(); handleSelectSupplier(s); }}
                            >
                              <span className="gi-source__dropdown-item-name">{s.name}</span>
                              {s.city && <span className="gi-source__dropdown-item-city">{s.city}</span>}
                            </button>
                          ))
                        ) : (
                          <div className="gi-source__dropdown-empty">
                            <span>{source.trim() ? t('goodsIn.line.noMatch') : t('goodsIn.modal.sourceSearchHint')}</span>
                            <span className="gi-source__dropdown-empty-hint">{t('goodsIn.modal.sourceSearchSub')}</span>
                          </div>
                        )}
                        {contactsEnabled && source.trim() && !isExistingSupplier && (
                          <button
                            type="button"
                            className="gi-source__dropdown-create"
                            onMouseDown={(e) => { e.preventDefault(); handleCreateNew(); }}
                          >
                            <span className="gi-source__dropdown-create-icon">
                              <Plus size={14} />
                            </span>
                            <span className="gi-source__dropdown-create-text">
                              <span className="gi-source__dropdown-create-label">{t('goodsIn.modal.createSupplierLabel')}</span>
                              <span className="gi-source__dropdown-create-name">{source.trim()}</span>
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {sourceSelectedId && (
                    <p className="gi-modal__field-subtext gi-source__selected-hint">
                      <Check size={11} /> {t('goodsIn.modal.supplierSelected')}
                    </p>
                  )}
                </div>
                <div className="gi-modal__field">
                  <label className="gi-modal__field-label">{t('goodsIn.modal.date')}</label>
                  <input
                    type="date"
                    className="input"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="gi-modal__field gi-modal__field--full">
                <label className="gi-modal__field-label">{t('goodsIn.modal.notes')}</label>
                <textarea
                  className="input gi-modal__notes"
                  placeholder={t('goodsIn.modal.notesPlaceholder')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            {/* Worksheet */}
            <div className="gi-modal__worksheet">
              <div className="gi-modal__items-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <h4 className="gi-modal__items-title">{t('goodsIn.modal.items')}</h4>
                  {lines.length > 0 && (
                    <span className="gi-modal__items-count-badge">
                      {lines.length} item
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".json,application/json"
                    onChange={handleImportJsonFile}
                    style={{ display: 'none' }}
                  />
                  {showJsonRakImport && (
                    <button
                      type="button"
                      className="gi-modal__import-json-btn"
                      onClick={() => fileInputRef.current?.click()}
                      title="Import data produk dari file JSON rak"
                    >
                      <FileJson size={14} />
                      <span>Import JSON Rak</span>
                    </button>
                  )}
                  <button type="button" className="gi-modal__add-row-btn" onClick={handleAddRow}>
                    <Plus size={14} />
                    <span>{t('goodsIn.modal.addRow')}</span>
                  </button>
                </div>
              </div>

              {importFeedback && (
                <div className={`gi-modal__import-banner gi-modal__import-banner--${importFeedback.type}`}>
                  {importFeedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  <span>{importFeedback.text}</span>
                  <button
                    type="button"
                    onClick={() => setImportFeedback(null)}
                    className="gi-modal__import-banner-close"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Desktop table */}
              <div className="gi-modal__table-desktop">
                <div className="gi-modal__table-wrapper">
                  <table className="gi-modal__table">
                    <colgroup>
                      <col style={{ width: '36px' }} />
                      <col style={{ width: '46%' }} />
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '36px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className="gi-th--center">#</th>
                        <th scope="col">{t('goodsIn.modal.productNameCol')}</th>
                        <th scope="col">{t('goodsIn.modal.skuCol')}</th>
                        <th scope="col" className="gi-th--right">{t('goodsIn.modal.qtyCol')}</th>
                        <th scope="col"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, idx) => (
                        <GoodsInLineItem
                          key={line.id}
                          rowIndex={idx}
                          item={line}
                          layout="table"
                          onChange={(fields) => handleLineChange(line.id, fields)}
                          onRemove={() => handleRemoveRow(line.id)}
                          onAddRow={handleAddRow}
                          products={products}
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

              {/* Mobile cards */}
              <div className="gi-modal__cards-mobile">
                {lines.map((line) => (
                  <GoodsInLineItem
                    key={line.id}
                    item={line}
                    layout="card"
                    onChange={(fields) => handleLineChange(line.id, fields)}
                    onRemove={() => handleRemoveRow(line.id)}
                    onAddRow={handleAddRow}
                    products={products}
                    canRemove={lines.length > 1}
                    inputRef={(el) => {
                      if (el) mobileInputRefs.current[line.id] = el;
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="gi-modal__error">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
          </form>
        </div>

        {/* Footer */}
        <div className="gi-modal__footer">
          <button
            type="button"
            className="btn btn-secondary btn-md"
            onClick={onClose}
            disabled={submitting}
          >
            {t('goodsIn.modal.cancel')}
          </button>
          <button
            type="submit"
            form="goods-in-form"
            className="btn btn-primary btn-md"
            disabled={submitting || hasInvalidLines}
          >
            {submitting ? t(isEdit ? 'goodsIn.modal.savingChanges' : 'goodsIn.modal.submitting') : (
              <><Check size={16} /><span>{t(isEdit ? 'goodsIn.modal.saveChanges' : 'goodsIn.modal.submit')}</span></>
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

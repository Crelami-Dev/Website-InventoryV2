import React, { useState, useRef, useEffect } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { Trash2, Search, Plus, ChevronDown } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import './GoodsInCreateModal.css';

export default function GoodsInLineItem({
  item,
  rowIndex,
  onChange,
  onRemove,
  onAddRow,
  products,
  canRemove,
  layout = 'table',
  inputRef,
}) {
  const { t } = useApp();
  const { units, formatUnitOption } = useUnits();
  const [search, setSearch] = useState(item.productName || '');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showNewProductForm, setShowNewProductForm] = useState(false);
  const [newProductSku, setNewProductSku] = useState('');
  const dropdownRef = useRef(null);
  const qtyInputRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (!item.productId && !item.productName) {
      const timer = setTimeout(() => {
        if (searchInputRef.current && searchInputRef.current.offsetParent !== null) {
          searchInputRef.current.focus();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    setSearch(item.productName || '');
  }, [item.productName]);

  useClickOutside(dropdownRef, () => setDropdownOpen(false));

  const filteredProducts = products
    .filter((p) => {
      const q = search.toLowerCase().trim();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q))
      );
    })
    .slice(0, 12);

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setDropdownOpen(true);
    setShowNewProductForm(false);
    if (item.productId) {
      onChange({ productId: null, productName: e.target.value, sku: '' });
    }
  };

  // Enter in the search box = add a new row (not submit the form)
  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // If a product is already selected, add a new row below
      if (item.productId) {
        onAddRow?.();
        return;
      }
      // If dropdown is open and has one match, select it
      if (dropdownOpen && filteredProducts.length === 1) {
        handleSelectProduct(filteredProducts[0]);
      }
    }
    if (e.key === 'Escape') {
      setDropdownOpen(false);
    }
  };

  const handleSelectProduct = (product) => {
    setSearch(product.name);
    setDropdownOpen(false);
    setShowNewProductForm(false);
    onChange({ productId: product.id, productName: product.name, sku: product.sku || '' });
    setTimeout(() => {
      if (qtyInputRef.current) {
        qtyInputRef.current.focus();
        qtyInputRef.current.select();
      }
    }, 50);
  };

  const handleNewProduct = () => {
    setDropdownOpen(false);
    setShowNewProductForm(true);
    setNewProductSku('');
    onChange({ productId: '__new__', productName: search, sku: '' });
  };

  const handleCancelNewProduct = () => {
    setShowNewProductForm(false);
    setSearch('');
    setNewProductSku('');
    onChange({ productId: null, productName: '', sku: '' });
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

  // ── Product Selector ───────────────────────────────────────
  const renderProductSelector = () => {
    if (showNewProductForm) {
      return (
        <div className="gi-line-item__new-product-form">
          <input
            type="text"
            className="input gi-line-item__new-product-name"
            placeholder={t('goodsIn.line.newProductName')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              onChange({ productName: e.target.value });
            }}
            autoFocus
          />
          <input
            type="text"
            className="input gi-line-item__new-product-sku"
            placeholder={t('goodsIn.line.skuRequiredHint')}
            value={newProductSku}
            onChange={(e) => {
              setNewProductSku(e.target.value);
              onChange({ sku: e.target.value });
            }}
          />
          <button
            type="button"
            className="gi-line-item__cancel-new-product"
            onClick={handleCancelNewProduct}
            title={t('goodsIn.modal.cancel')}
          >
            ✕
          </button>
        </div>
      );
    }

    return (
      <div className="gi-line-item__dropdown-wrap" ref={dropdownRef}>
        <div className="gi-line-item__search-input-wrap">
          <Search size={13} className="gi-line-item__search-icon" aria-hidden="true" />
          <input
            ref={(el) => {
              searchInputRef.current = el;
              if (inputRef) inputRef(el);
            }}
            type="text"
            className={`input gi-line-item__search-input${item.productId && item.productId !== '__new__' ? ' gi-line-item__search-input--selected' : ''}${item.productId === '__new__' ? ' gi-line-item__search-input--new-product' : ''}`}
            placeholder={t('goodsIn.line.productPlaceholder')}
            value={search}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setDropdownOpen(true)}
            autoComplete="off"
          />
          {item.productId === '__new__' && (
            <span className="gi-line-item__new-badge" title="Produk baru akan dibuat otomatis saat disimpan">
              + Buat Baru
            </span>
          )}
          <ChevronDown size={13} className="gi-line-item__search-chevron" aria-hidden="true" />
        </div>

        {dropdownOpen && (
          <div className="gi-line-item__dropdown">
            {filteredProducts.length > 0 ? (
              filteredProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="gi-line-item__dropdown-item"
                  onMouseDown={(e) => { e.preventDefault(); handleSelectProduct(p); }}
                >
                  <span className="gi-line-item__dropdown-item-name">{p.name}</span>
                  <span className="gi-line-item__dropdown-item-sku">{p.sku}</span>
                </button>
              ))
            ) : (
              <div className="gi-line-item__dropdown-empty">
                {search.trim() ? t('goodsIn.line.noMatch') : t('goodsIn.line.typeToSearch')}
              </div>
            )}
            {search.trim() && (
              <button
                type="button"
                className="gi-line-item__dropdown-create"
                onMouseDown={(e) => { e.preventDefault(); handleNewProduct(); }}
              >
                <Plus size={13} />
                <span>{t('goodsIn.line.createLabel').replace('{name}', search)}</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Qty + Unit Input ───────────────────────────────────────
  const renderQty = () => (
    <div className="gi-line-item__qty-select-wrap">
      <input
        ref={qtyInputRef}
        type="number"
        step="any"
        min="0.01"
        className="input gi-line-item__qty-num-input"
        value={item.qty === 0 || item.qty === '' ? '' : item.qty}
        onChange={handleQtyChange}
        onBlur={handleQtyBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddRow?.(); } }}
      />
      <select
        className="input select gi-line-item__qty-unit-select"
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
  );

  // ── Table Row (Desktop) ────────────────────────────────────
  if (layout === 'table') {
    return (
      <tr className="gi-table-row">
        <td className="gi-modal__table td" style={{ textAlign: 'center', verticalAlign: 'middle', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{rowIndex + 1}</td>
        <td className="gi-modal__table td">{renderProductSelector()}</td>
        <td className="gi-modal__table td">
          <input
            type="text"
            className={`input gi-line-item__sku-disabled${item.productId === '__new__' ? ' gi-line-item__sku--new' : ''}`}
            placeholder={item.productId === '__new__' ? 'Wajib isi SKU' : 'Auto-filled'}
            value={item.sku || ''}
            disabled={item.productId !== '__new__'}
            onChange={item.productId === '__new__' ? (e) => onChange({ sku: e.target.value }) : undefined}
          />
        </td>
        <td className="gi-modal__table td">{renderQty()}</td>
        <td className="gi-modal__table td" style={{ textAlign: 'center', verticalAlign: 'middle' }}>
          {canRemove && (
            <button
              type="button"
              className="gi-line-item__remove-btn"
              onClick={onRemove}
              title="Remove row"
            >
              <Trash2 size={15} />
            </button>
          )}
        </td>
      </tr>
    );
  }

  // ── Card (Mobile) ──────────────────────────────────────────
  return (
    <div className="gi-line-item-card">
      {canRemove && (
        <button
          type="button"
          className="gi-line-item-card__remove"
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      )}
      <div className="gi-line-item-card__field">
        <label className="gi-line-item-card__label">{t('goodsIn.line.product')}</label>
        {renderProductSelector()}
      </div>
      <div className="gi-line-item-card__field">
        <label className="gi-line-item-card__label">
          {t('goodsIn.line.sku')}
          {item.productId === '__new__' && <span className="gi-line-item__new-badge-sm">+ Produk Baru</span>}
        </label>
        <input
          type="text"
          className={`input gi-line-item__sku-disabled${item.productId === '__new__' ? ' gi-line-item__sku--new' : ''}`}
          placeholder={item.productId === '__new__' ? 'Wajib isi SKU' : 'Auto-filled'}
          value={item.sku || ''}
          disabled={item.productId !== '__new__'}
          onChange={item.productId === '__new__' ? (e) => onChange({ sku: e.target.value }) : undefined}
        />
      </div>
      <div className="gi-line-item-card__field">
        <label className="gi-line-item-card__label">{t('goodsIn.line.qty')}</label>
        {renderQty()}
      </div>
    </div>
  );
}

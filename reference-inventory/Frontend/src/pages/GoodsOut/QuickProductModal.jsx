import React, { useState, useRef, useEffect } from 'react';
import { X, Package, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../utils/api.js';
import './GoodsOutCreateModal.css';

/**
 * QuickProductModal — Popup cepat untuk daftarkan produk baru.
 * Hanya 2 field: Nama Produk + SKU.
 * Setelah save, callback `onCreated(product)` dipanggil dan query cache di-invalidate.
 */
export default function QuickProductModal({
  open,
  prefillName = '',
  onCreated,
  onClose,
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(prefillName);
  const [sku, setSku] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);
  const skuRef = useRef(null);

  // Sync prefillName when modal opens
  useEffect(() => {
    if (open) {
      setName(prefillName);
      setSku('');
      setError(null);
      setSaving(false);
      // Focus SKU if name is already filled, otherwise focus name
      setTimeout(() => {
        if (prefillName?.trim()) {
          skuRef.current?.focus();
        } else {
          nameRef.current?.focus();
        }
      }, 80);
    }
  }, [open, prefillName]);

  if (!open) return null;

  const handleSave = async (e) => {
    if (e) e.preventDefault();

    const trimmedName = name.trim();
    const trimmedSku = sku.trim();

    if (!trimmedName) {
      setError('Nama produk harus diisi');
      nameRef.current?.focus();
      return;
    }
    if (!trimmedSku) {
      setError('SKU harus diisi');
      skuRef.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await api.post('/api/workspace/products', {
        name: trimmedName,
        sku: trimmedSku,
        stock: 0,
        unitCost: 0,
        sellingPrice: 0,
        status: 'active',
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        // Handle duplicate SKU
        if (res.status === 409 || errJson?.existingProduct) {
          // If product already exists, use it
          const existing = errJson.existingProduct;
          if (existing) {
            await queryClient.invalidateQueries({ queryKey: ['products'] });
            onCreated?.({
              id: existing.id,
              name: existing.name,
              sku: existing.sku,
            });
            return;
          }
        }
        throw new Error(errJson?.message || errJson?.error || 'Gagal menyimpan produk');
      }

      const json = await res.json();
      const newProduct = json.data;

      // Invalidate products cache so dropdown updates immediately
      await queryClient.invalidateQueries({ queryKey: ['products'] });

      onCreated?.({
        id: newProduct.id,
        name: newProduct.name,
        sku: newProduct.sku,
      });
    } catch (err) {
      console.error('QuickProductModal save error:', err);
      setError(err.message || 'Gagal menyimpan produk');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      onClose?.();
    }
  };

  return (
    <div
      className="qpm-overlay"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="qpm-modal"
        role="dialog"
        aria-label="Daftarkan Produk Baru"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="qpm-header">
          <div className="qpm-header__title-wrap">
            <Package size={18} className="qpm-header__icon" />
            <h3 className="qpm-header__title">Daftarkan Produk Baru</h3>
          </div>
          <button type="button" className="qpm-header__close" onClick={(e) => { e.stopPropagation(); onClose?.(); }} disabled={saving}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form className="qpm-body" onSubmit={handleSave}>
          <div className="qpm-field">
            <label className="qpm-field__label">
              Nama Produk <span className="text-danger">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              className="input qpm-field__input"
              placeholder="Contoh: Celana Segiempat Jumbo Pastel"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={saving}
              autoComplete="off"
            />
          </div>

          <div className="qpm-field">
            <label className="qpm-field__label">
              SKU <span className="text-danger">*</span>
            </label>
            <input
              ref={skuRef}
              type="text"
              className="input qpm-field__input"
              placeholder="Contoh: CSM-PSA-JUM"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={saving}
              autoComplete="off"
            />
            <p className="qpm-field__hint">Kode unik untuk identifikasi produk</p>
          </div>

          {error && (
            <div className="qpm-error">
              {error}
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="qpm-footer">
          <button type="button" className="btn btn--ghost qpm-footer__btn" onClick={onClose} disabled={saving}>
            Batal
          </button>
          <button
            type="button"
            className="btn btn--primary qpm-footer__btn"
            onClick={handleSave}
            disabled={saving || !name.trim() || !sku.trim()}
          >
            {saving ? (
              <>
                <Loader2 size={14} className="qpm-spinner" />
                <span>Menyimpan...</span>
              </>
            ) : (
              <span>Simpan & Pilih</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

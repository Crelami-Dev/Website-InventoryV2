import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, Package, AlertCircle, ArrowLeft,
  DollarSign, Warehouse, Percent,
  TrendingUp, Barcode,
  Tag, Box, Edit3, Trash2
} from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, getWorkspaceSettings } from '../../utils/api.js';
import { formatStockByUnit } from './useProductFilters.js';
import SerialNumberTable from './SerialNumberTable.jsx';
import ActivityCard from './ActivityCard.jsx';
import EditProductModal from './EditProductModal.jsx';
import { ConfirmModal } from '../../components/ConfirmModal/ConfirmModal.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import {
  calculateDocumentStockMovements,
  parseSerialUnit,
} from '../../utils/stockCalculation.js';
import './ProductDetailPage.css';

function formatMoney(val) {
  return `Rp ${Number(val || 0).toLocaleString('id-ID')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('id-ID', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return dateStr; }
}

function normalizeProduct(row) {
  const meta = row.metadata ?? {};
  const price = Number(row.selling_price ?? 0);
  const unitCost = Number(row.unit_cost ?? 0);
  const profit = price - unitCost;
  const markup = unitCost > 0 ? (profit / unitCost) * 100 : 0;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category ?? '',
    price,
    unitCost,
    profit,
    markup,
    stock: Number(row.stock ?? meta.stockNonSerial ?? 0),
    minStock: Number(meta.minStock ?? 10),
    trackingMode: meta.trackingMode ?? 'non_serial',
    description: meta.description ?? '',
    imageUrl: meta.imageUrl ?? meta.image ?? meta.photoUrl ?? '',
    active: row.status !== 'disabled',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dozenPrice: Number(meta.dozenPrice ?? 0),
    hasDozenPrice: Boolean(meta.hasDozenPrice ?? meta.dozenPrice),
    discountType: row.discount_type ?? 'none',
    discountValue: Number(row.discount_value ?? 0),
  };
}

function discountLabel(product, t) {
  if (!product.discountType || product.discountType === 'none' || product.discountValue === 0) {
    return '—';
  }
  if (product.discountType === 'percentage') {
    return `${product.discountValue}%`;
  }
  return `Rp ${Number(product.discountValue).toLocaleString('id-ID')}`;
}

export default function ProductDetailPage() {
  const { sku: rawSku } = useParams();
  const sku = decodeURIComponent(rawSku ?? '');
  const { t, user, activeWarehouse, activeWarehouseId } = useApp();
  const { multipliers, customUnits } = useUnits();
  const currentWarehouseId = activeWarehouse?.id || activeWarehouseId || 'default';

  const [stockUnit, setStockUnit] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(`docuflow_product_stock_unit_${currentWarehouseId}`);
      if (saved === 'pcs' || saved === 'lusin') return saved;
    }
    return 'lusin';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(`docuflow_product_stock_unit_${currentWarehouseId}`);
      if (saved === 'pcs' || saved === 'lusin') {
        setStockUnit(saved);
      } else {
        setStockUnit('lusin');
      }
    }
  }, [currentWarehouseId]);

  const toggleStockUnit = () => {
    const next = stockUnit === 'lusin' ? 'pcs' : 'lusin';
    setStockUnit(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`docuflow_product_stock_unit_${currentWarehouseId}`, next);
    }
  };

  const role = user?.role?.toLowerCase();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [imageError, setImageError] = useState(false);
  const [isSticky, setIsSticky] = useState(false);
  const headerRef = useRef(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setIsSticky(!entry.isIntersecting),
      { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
    );
    const el = headerRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, []);

  const {
    data: rawProducts,
    isLoading: loadingProducts,
    isError: errorProducts,
    refetch: refetchProducts,
  } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      return (await res.json()).data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: wsSettings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const canViewPrice = useMemo(() => {
    if (role === 'owner' || role === 'super_admin') return true;
    if (user?.id && wsSettings?.staff_permissions?.[user.id]) {
      return wsSettings.staff_permissions[user.id]?.canViewPrice === true;
    }
    const raw = wsSettings?.modules_owner || wsSettings?.modules || {};
    return raw.products?.canViewPrice === true;
  }, [role, user?.id, wsSettings]);

  const {
    data: rawSerials,
    isLoading: loadingSerials,
  } = useQuery({
    queryKey: ['product-serials'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/product-serials?limit=10000');
      if (!res.ok) throw new Error('Failed to load serials');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const {
    data: rawDocuments,
    isLoading: loadingDocuments,
  } = useQuery({
    queryKey: ['workspace-documents'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?limit=1000');
      if (!res.ok) return [];
      return (await res.json()).data ?? [];
    },
    staleTime: 30000,
  });

  const isLoading = loadingProducts || loadingSerials || loadingDocuments;

  const rawProduct = rawProducts
    ? (rawProducts.find((p) => p.sku === sku) ??
      rawProducts.find((p) => p.sku?.toLowerCase() === sku.toLowerCase()) ??
      null)
    : null;

  const product = rawProduct ? normalizeProduct(rawProduct) : null;

  const notFound = !isLoading && !errorProducts && rawProducts && !rawProducts.find((p) => p.sku?.toLowerCase() === sku.toLowerCase());

  const serials = product && rawSerials
    ? rawSerials
      .filter((s) => {
        const matchesProduct = (s.product_id ?? s.productId) === product.id;
        if (!matchesProduct) return false;
        const sWh = s.warehouse_id || s.warehouseId;
        if (activeWarehouseId && sWh && String(sWh) !== String(activeWarehouseId)) {
          return false;
        }
        return true;
      })
      .map((s) => ({
        id: s.id,
        productId: s.product_id ?? s.productId,
        warehouseId: s.warehouse_id ?? s.warehouseId ?? null,
        serialNumber: s.serial_number ?? s.serialNumber,
        status: s.status ?? 'available',
        goodsInDocumentId: s.goods_in_document_id ?? s.goodsInDocumentId ?? null,
        goodsInItemId: s.goods_in_item_id ?? s.goodsInItemId ?? null,
        goodsOutDocumentId: s.goods_out_document_id ?? s.goodsOutDocumentId ?? null,
        goodsOutItemId: s.goods_out_item_id ?? s.goodsOutItemId ?? null,
        metadata: s.metadata ?? {},
        createdAt: s.created_at ?? s.createdAt ?? null,
        updatedAt: s.updated_at ?? s.updatedAt ?? null,
        serialUnit: s.metadata?.serialUnit || s.serialUnit || s.unit || 'piece',
      }))
    : [];

  const activities = useMemo(() => {
    if (!product) return [];
    const list = [];
    if (product.createdAt) {
      list.push({ action: 'created', entity_name: product.name, actor_name: 'system', created_at: product.createdAt });
    }
    if (product.updatedAt) {
      list.push({ action: 'updated', entity_name: product.name, actor_name: 'system', created_at: product.updatedAt });
    }
    (rawDocuments || []).forEach((doc) => {
      if (doc.document_type === 'goods_in' || doc.document_type === 'goods_out') {
        const matchingItems = (doc.items || []).filter(
          (item) => item.product_id === product.id || item.productId === product.id || item.sku?.toLowerCase() === product.sku?.toLowerCase()
        );
        if (matchingItems.length > 0) {
          list.push({
            action: doc.document_type,
            entity_name: product.name,
            actor_name: doc.created_by || doc.createdBy || 'system',
            created_at: doc.created_at || doc.createdAt,
          });
        }
      }
      if (doc.document_type === 'goods_out' && Array.isArray(doc.metadata?.returns)) {
        doc.metadata.returns.forEach((r) => {
          const matchingReturnItems = (r.items || []).filter(
            (ri) => ri.productId === product.id || ri.product_id === product.id || (ri.sku && product.sku && String(ri.sku).trim().toLowerCase() === String(product.sku).trim().toLowerCase())
          );
          if (matchingReturnItems.length > 0) {
            list.push({
              action: 'goods_out_returned',
              entity_name: `${product.name} (Return ${doc.document_number})`,
              actor_name: r.returnedBy || 'Petugas',
              created_at: r.date,
            });
          }
        });
      }
    });
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [product, rawDocuments]);

  const productStockMovement = useMemo(() => {
    if (!product || !rawDocuments) return { in: 0, out: 0, net: 0 };
    const movMap = calculateDocumentStockMovements({
      documents: rawDocuments,
      products: [product],
      multipliers,
      activeWarehouseId,
    });
    return movMap.get(product.id) ?? { in: 0, out: 0, net: 0 };
  }, [product, rawDocuments, multipliers, activeWarehouseId]);

  const serialsStats = useMemo(() => {
    if (!serials || serials.length === 0) {
      return { availablePcs: 0, soldPcs: 0, damagedPcs: 0, availableCount: 0, soldCount: 0, damagedCount: 0 };
    }

    let availablePcs = 0;
    let soldPcs = 0;
    let damagedPcs = 0;
    let availableCount = 0;
    let soldCount = 0;
    let damagedCount = 0;

    const docMap = new Map((rawDocuments ?? []).map((d) => [d.id, d]));

    serials.forEach((s) => {
      // 1. Abaikan nomor seri yang sedang berada di dalam group aktif untuk mencegah double-counting
      if (s.metadata?.isGrouped || s.metadata?.parentGroupId) {
        return;
      }
      // 2. Abaikan group yang sudah dibongkar (dissolved)
      if (s.metadata?.isDissolved || s.status === 'dissolved') {
        return;
      }

      // Serial must not be tied to a cancelled Goods In document
      const goodsInDocId = s.goodsInDocumentId || s.goods_in_document_id;
      if (goodsInDocId) {
        const linkedDoc = docMap.get(goodsInDocId);
        if (linkedDoc && (linkedDoc.status === 'cancelled' || (linkedDoc.document_type !== 'goods_in' && linkedDoc.type !== 'goods_in'))) {
          return;
        }
      }

      const { multiplier: mult } = parseSerialUnit(s, { customUnits, multipliers });

      if (s.status === 'available') {
        availablePcs += mult;
        availableCount += 1;
      } else if (s.status === 'out') {
        soldPcs += mult;
        soldCount += 1;
      } else if (s.status === 'damaged') {
        damagedPcs += mult;
        damagedCount += 1;
      }
    });

    return { availablePcs, soldPcs, damagedPcs, availableCount, soldCount, damagedCount };
  }, [serials, rawDocuments, multipliers, customUnits]);

  const computedTotalStock = useMemo(() => {
    return productStockMovement.net;
  }, [productStockMovement]);

  const handleEditSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    queryClient.invalidateQueries({ queryKey: ['reports'] });
  };

  const handleDeleteProduct = async () => {
    if (!product?.id) return;
    setDeletingProduct(true);
    setDeleteError(null);
    try {
      const res = await api.delete(`/api/workspace/products/${product.id}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.message || t('productDetail.deleteError'));
      }
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      navigate('/inventory/products', { replace: true });
    } catch (err) {
      console.error('Delete product error:', err);
      setDeleteError(err.message || t('productDetail.deleteError'));
    } finally {
      setDeletingProduct(false);
    }
  };

  const handleSerialAdded = async () => {
    if (product && product.trackingMode !== 'serial') {
      try {
        const meta = rawProduct?.metadata ?? {};
        await api.patch(`/api/workspace/products/${product.id}`, {
          metadata: {
            ...meta,
            trackingMode: 'serial',
            stockNonSerial: 0,
          },
        });
      } catch (err) {
        console.error('Failed to update product tracking mode:', err);
      }
    }
    queryClient.invalidateQueries({ queryKey: ['product-serials'] });
    queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  if (isLoading) {
    return <ProductDetailSkeleton />;
  }

  if (errorProducts) {
    return (
      <div className="pd-page pd-page--state">
        <div className="pd-state">
          <div className="pd-state__icon pd-state__icon--error">
            <AlertCircle size={40} />
          </div>
          <h1 className="pd-state__title">{t('productDetail.loadError')}</h1>
          <button
            type="button"
            className="btn btn-secondary interactive"
            onClick={() => refetchProducts()}
          >
            {t('productDetail.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (notFound || !product) {
    return (
      <div className="pd-page pd-page--state">
        <div className="pd-state">
          <div className="pd-state__icon pd-state__icon--muted">
            <Package size={48} />
          </div>
          <h1 className="pd-state__title">{t('productDetail.notFound')}</h1>
          <p className="pd-state__sub">{t('productDetail.notFoundSubtext', { sku })}</p>
          <Link to="/inventory/products" className="btn btn-secondary interactive">
            <ArrowLeft size={16} />
            {t('productDetail.backToProducts')}
          </Link>
        </div>
      </div>
    );
  }

  const isSerial = product.trackingMode === 'serial' || serials.length > 0;

  const totalStockInPcs = isSerial
    ? (serialsStats.availablePcs > 0 ? serialsStats.availablePcs : computedTotalStock)
    : computedTotalStock;

  const displayStock = formatStockByUnit(totalStockInPcs, stockUnit);
  const stockUnitLabel = stockUnit === 'lusin' ? 'lusin' : 'pcs';

  const soldStockInPcs = isSerial ? serialsStats.soldPcs : productStockMovement.out;
  const displaySold = soldStockInPcs > 0
    ? (stockUnit === 'lusin'
        ? `${formatStockByUnit(soldStockInPcs, 'lusin')} lsn`
        : `${soldStockInPcs.toLocaleString('id-ID')} pcs`)
    : '0';

  const damagedStockInPcs = isSerial ? serialsStats.damagedPcs : 0;
  const displayDamaged = damagedStockInPcs > 0
    ? (stockUnit === 'lusin'
        ? `${formatStockByUnit(damagedStockInPcs, 'lusin')} lsn`
        : `${damagedStockInPcs.toLocaleString('id-ID')} pcs`)
    : '0';

  // Stock Replenishment variables
  const minStockInPcs = Number(product.minStock || 10);
  const targetStockInPcs = minStockInPcs * 2;
  const displayTargetStock = formatStockByUnit(targetStockInPcs, stockUnit);
  const stockRatio = Math.min(100, (totalStockInPcs / (targetStockInPcs || 10)) * 100);
  const isBelowMin = totalStockInPcs <= minStockInPcs;

  return (
    <div className="pd-page">
      <div ref={headerRef} />

      {/* Breadcrumb */}
      <nav className={`pd-breadcrumb ${isSticky ? 'pd-breadcrumb--sticky' : ''}`} aria-label="Breadcrumb">
        <Link to="/inventory/products" className="pd-breadcrumb__link">
          <ArrowLeft size={14} />
          <span>{t('productDetail.breadcrumbProducts')}</span>
        </Link>
        <ChevronRight size={14} className="pd-breadcrumb__sep" />
        <span className="pd-breadcrumb__current">{product.name || product.sku}</span>
      </nav>

      {/* Product Profile Header */}
      <div className="pd-profile-header">
        <div className="pd-profile-header__media">
          {product.imageUrl && !imageError ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="pd-profile-header__img"
              onError={() => setImageError(true)}
            />
          ) : (
            <div className="pd-profile-header__placeholder">
              <Package size={24} className="pd-profile-header__placeholder-icon" />
            </div>
          )}
        </div>

        <div className="pd-profile-header__content">
          <div className="pd-profile-header__title-row">
            <h1 className="pd-profile-header__title">{product.name}</h1>
            <div className="pd-profile-header__actions">
              <span className={`pd-profile-header__badge ${product.active ? 'pd-profile-header__badge--active' : 'pd-profile-header__badge--draft'}`}>
                <span className="pd-profile-header__badge-dot" />
                {t(product.active ? 'productDetail.active' : 'productDetail.inactive')}
              </span>
              <button
                type="button"
                className="pd-profile-header__edit-btn"
                onClick={() => setShowEditModal(true)}
                title={t('productDetail.editProduct')}
              >
                <Edit3 size={13} />
                <span>{t('productDetail.editProduct')}</span>
              </button>
              <button
                type="button"
                className="pd-profile-header__delete-btn"
                onClick={() => {
                  setDeleteError(null);
                  setShowDeleteModal(true);
                }}
                title={t('productDetail.deleteProduct')}
              >
                <Trash2 size={13} />
                <span>{t('productDetail.deleteProduct')}</span>
              </button>
            </div>
          </div>

          <div className="pd-profile-header__meta-row">
            <span className="pd-profile-header__sku">
              {t('productDetail.skuLabel')}: <strong>{product.sku}</strong>
            </span>
            <span className="pd-profile-header__meta-divider" />
            <span className="pd-profile-header__tracking">
              {t(product.trackingMode === 'serial' ? 'productDetail.serial' : 'productDetail.nonSerial')}
            </span>
            <span className="pd-profile-header__meta-divider" />
            <span className="pd-profile-header__category">
              {product.category || t('productDetail.noCategory')}
            </span>
            {activeWarehouse?.name && (
              <>
                <span className="pd-profile-header__meta-divider" />
                <span className="pd-profile-header__category" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Warehouse size={11} style={{ opacity: 0.7 }} />
                  <strong>{activeWarehouse.name}</strong>
                </span>
              </>
            )}
            {product.discountType !== 'none' && product.discountValue > 0 && (
              <>
                <span className="pd-profile-header__meta-divider" />
                <span className="pd-profile-header__discount">
                  <Percent size={10} style={{ marginRight: 2 }} />
                  {discountLabel(product, t)}
                </span>
              </>
            )}
          </div>

          {product.description ? (
            <p className="pd-profile-header__desc">{product.description}</p>
          ) : null}
        </div>
      </div>

      {/* Grid of 4 Valuation & Inventory Widgets (Spans Full Width) */}
      <div className="pd-widgets-grid">
        {/* Widget 1: Stock Status */}
        <div className="pd-widget">
          <div className="pd-widget__header">
            <div className="pd-widget__icon pd-widget__icon--blue">
              <Warehouse size={16} />
            </div>
            <span className="pd-widget__title">{t('productDetail.stock')}</span>
            <button
              type="button"
              className="pd-widget__unit-toggle"
              onClick={toggleStockUnit}
              title={`Ubah satuan stok (${stockUnit === 'lusin' ? 'Lusin' : 'Pcs'})`}
            >
              {stockUnit === 'lusin' ? 'Lsn' : 'Pcs'}
            </button>
          </div>
          <div className="pd-widget__body">
            <span
              className="pd-widget__value"
              title={isSerial && serialsStats.availableCount > 0 
                ? `${totalStockInPcs.toLocaleString('id-ID')} pcs (${serialsStats.availableCount} serial)`
                : `${totalStockInPcs.toLocaleString('id-ID')} pcs`
              }
            >
              {displayStock} <span className="pd-widget__value-unit">{stockUnitLabel}</span>
            </span>
          </div>
          <div className="pd-widget__footer">
            <span className="pd-widget__footer-item">
              {t('productDetail.sold')}: <strong>{displaySold}</strong>
              {isSerial && serialsStats.soldCount > 0 && <span style={{ color: 'var(--color-text-muted)', marginLeft: 3 }}>({serialsStats.soldCount} sn)</span>}
            </span>
            <span className="pd-widget__footer-divider" />
            <span className="pd-widget__footer-item">
              {t('productDetail.damaged')}: <strong>{displayDamaged}</strong>
              {isSerial && serialsStats.damagedCount > 0 && <span style={{ color: 'var(--color-text-muted)', marginLeft: 3 }}>({serialsStats.damagedCount} sn)</span>}
            </span>
          </div>
        </div>

        {/* Widget 2: Pricing & Valuation */}
        {canViewPrice && (
        <div className="pd-widget">
          <div className="pd-widget__header">
            <div className="pd-widget__icon pd-widget__icon--purple">
              <DollarSign size={16} />
            </div>
            <span className="pd-widget__title">{t('productDetail.sellingPrice')}</span>
          </div>
          <div className="pd-widget__body">
            <span className="pd-widget__value">{formatMoney(product.price)}</span>
          </div>
          <div className="pd-widget__footer">
            <span className="pd-widget__footer-item">{t('productDetail.unitCost')}: <strong>{formatMoney(product.unitCost)}</strong></span>
            {product.unitCost > 0 && (
              <>
                <span className="pd-widget__footer-divider" />
                <span className="pd-widget__footer-item">
                  {t('productDetail.margin')}: <strong style={{ color: 'var(--color-success)' }}>+{product.markup.toFixed(0)}%</strong>
                </span>
              </>
            )}
          </div>
        </div>
        )}

        {/* Widget 3: Bulk Price & Discount */}
        {canViewPrice && (
        <div className="pd-widget">
          <div className="pd-widget__header">
            <div className="pd-widget__icon pd-widget__icon--orange">
              <Box size={16} />
            </div>
            <span className="pd-widget__title">{t('productDetail.dozenPrice')}</span>
          </div>
          <div className="pd-widget__body">
            <span className="pd-widget__value">
              {product.hasDozenPrice ? formatMoney(product.dozenPrice) : '—'}
            </span>
          </div>
          <div className="pd-widget__footer">
            <span className="pd-widget__footer-item">
              {t('productDetail.discount')}: <strong>{discountLabel(product, t)}</strong>
            </span>
          </div>
        </div>
        )}

        {/* Widget 4: Replenishment Progress */}
        <div className="pd-widget">
          <div className="pd-widget__header">
            <div className="pd-widget__icon pd-widget__icon--green">
              <TrendingUp size={16} />
            </div>
            <span className="pd-widget__title">
              {t(isBelowMin ? 'productDetail.replenishNeeded' : 'productDetail.replenishOptimal')}
            </span>
          </div>
          <div className="pd-widget__body">
            <span className="pd-widget__value">
              {displayStock} <span className="pd-widget__value-slash">/ {displayTargetStock}</span> <span className="pd-widget__value-unit">{stockUnitLabel}</span>
            </span>
          </div>
          <div className="pd-widget__footer-bar">
            <div className="pd-widget__bar-container">
              <div
                className={`pd-widget__bar-fill pd-widget__bar-fill--${isBelowMin ? 'warning' : 'success'}`}
                style={{ width: `${stockRatio}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Split Layout: Ledger on left, timeline dates on right */}
      <div className="pd-main-layout">
        <div className="pd-main-layout__content">
          <SerialNumberTable
            serials={serials}
            product={product}
            productId={product.id}
            onSerialAdded={handleSerialAdded}
            rawDocuments={rawDocuments}
            trackingMode={product.trackingMode}
            stock={computedTotalStock}
            sku={product.sku}
          />
        </div>

        <aside className="pd-main-layout__sidebar">
          <div className="pd-dates">
            <h3 className="pd-dates__title">{t('productDetail.recentActivity')}</h3>
            <div className="pd-timeline">
              {activities.length > 0 ? (
                activities.map((act, i) => (
                  <ActivityCard key={`${act.action}-${i}`} activity={act} />
                ))
              ) : (
                <>
                  <div className="pd-timeline__item">
                    <div className="pd-timeline__circle pd-timeline__circle--created" />
                    <div className="pd-timeline__content">
                      <span className="pd-timeline__label">{t('productDetail.created')}</span>
                      <span className="pd-timeline__date">{formatDate(product.createdAt)}</span>
                    </div>
                  </div>
                  <div className="pd-timeline__item">
                    <div className="pd-timeline__circle pd-timeline__circle--updated" />
                    <div className="pd-timeline__content">
                      <span className="pd-timeline__label">{t('productDetail.updated')}</span>
                      <span className="pd-timeline__date">{formatDate(product.updatedAt)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Edit Product Modal — same UI as Add Product, prefilled for this product */}
      <EditProductModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        product={product}
        rawProduct={rawProduct}
        products={rawProducts || []}
        onSuccess={handleEditSuccess}
        onDelete={() => setShowDeleteModal(true)}
      />

      {/* Delete Confirmation Popup */}
      <ConfirmModal
        open={showDeleteModal}
        title={t('productDetail.deleteConfirmTitle')}
        message={
          computedTotalStock > 0
            ? `Apakah Anda yakin ingin menghapus "${product.name}" (${product.sku})? Perhatian: Produk ini masih memiliki catatan stok sebanyak ${computedTotalStock} pcs.`
            : `Apakah Anda yakin ingin menghapus "${product.name}" (${product.sku})? Data yang dihapus tidak dapat dipulihkan.`
        }
        confirmLabel={deletingProduct ? t('productDetail.deleting') : t('productDetail.deleteSubmit')}
        cancelLabel={t('productDetail.deleteCancel')}
        onConfirm={handleDeleteProduct}
        onCancel={() => {
          if (!deletingProduct) {
            setShowDeleteModal(false);
            setDeleteError(null);
          }
        }}
      />
    </div>
  );
}

function ProductDetailSkeleton() {
  return (
    <div className="pd-page">
      <div className="pd-skeleton">
        <div className="pd-skeleton__breadcrumb">
          <div className="pd-skeleton__line" style={{ width: 100 }} />
          <div className="pd-skeleton__line" style={{ width: 160 }} />
        </div>

        <div className="pd-skeleton__hero">
          <div className="pd-skeleton__media" />
          <div className="pd-skeleton__content">
            <div className="pd-skeleton__line" style={{ width: '55%', height: 26 }} />
            <div className="pd-skeleton__line" style={{ width: '35%', height: 16 }} />
            <div className="pd-skeleton__line" style={{ width: '100%', height: 20 }} />
            <div className="pd-skeleton__stats">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="pd-skeleton__stat" />
              ))}
            </div>
            <div className="pd-skeleton__stock">
              {[1, 2, 3].map((i) => (
                <div key={i} className="pd-skeleton__stat" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, AlertCircle, PackageOpen, ChevronLeft, ChevronRight, Download, Layers } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { api, getWorkspaceSettings, canExportProducts } from '../../utils/api.js';
import { useUnits } from '../../hooks/useUnits.js';
import { useProductFilters } from './useProductFilters.js';
import ProductFilters from './ProductFilters.jsx';
import ProductTable from './ProductTable.jsx';
import ProductCard from './ProductCard.jsx';
import ProductSkeleton from './ProductSkeleton.jsx';
import AddProductModal from './AddProductModal.jsx';
import SerialGroupModal from './SerialGroupModal.jsx';
import {
  calculateDocumentStockMovements,
  calculateAvailableSerialsByProduct,
  getProductEffectiveStockInPcs,
} from '../../utils/stockCalculation.js';
import './ProductsPage.css';

export default function ProductsPage() {
  const { t, user, activeWarehouse, activeWarehouseId } = useApp();
  const { multipliers, customUnits } = useUnits();
  const currentWarehouseId = activeWarehouse?.id || activeWarehouseId || 'default';

  // Stock unit preference per warehouse (lusin default)
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

  const handleStockUnitChange = (newUnit) => {
    setStockUnit(newUnit);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`docuflow_product_stock_unit_${currentWarehouseId}`, newUnit);
    }
  };

  const role = user?.role?.toLowerCase();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  // Screen size detection for forcing Card view on mobile screen width <= 576px
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  const isDev = Boolean(import.meta.env.DEV);
  const canExport = useMemo(() => {
    return canExportProducts(wsSettings, user);
  }, [wsSettings, user]);
  const [isExporting, setIsExporting] = useState(false);

  const isMobile = windowWidth <= 576;

  // View mode state — in-memory only (zero local/session storage cache)
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 993 ? 'table' : 'card';
    }
    return 'table';
  });

  const activeViewMode = isMobile ? 'card' : viewMode;

  const [showAddModal, setShowAddModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);

  // Fetch Products via react-query
  const {
    data: rawProducts,
    isLoading: loadingProducts,
    error: errorProducts,
    refetch: refetchProducts,
  } = useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
    staleTime: 30000,
  });

  // Fetch Product Serials via react-query
  const {
    data: rawSerials,
    isLoading: loadingSerials,
    error: errorSerials,
    refetch: refetchSerials,
  } = useQuery({
    queryKey: ['product-serials'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/product-serials?limit=10000');
      if (!res.ok) throw new Error('Failed to load product serials');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  // Fetch Documents (Goods In & Goods Out) via react-query for stock calculations
  const { data: rawDocuments = [] } = useQuery({
    queryKey: ['workspace-documents'],
    queryFn: async () => {
      const res = await api.get('/api/workspace/documents?limit=1000');
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const isLoading = loadingProducts || loadingSerials;
  const isError = !!errorProducts || !!errorSerials;

  const handleRetry = () => {
    refetchProducts();
    refetchSerials();
  };

  // Merge products with available serials & Goods In/Out transactions
  const productsList = useMemo(() => {
    if (!rawProducts) return [];

    // 1. Calculate physical available serials per product (scoped to active warehouse)
    const availableSerialCountByProduct = calculateAvailableSerialsByProduct({
      serials: rawSerials ?? [],
      documents: rawDocuments ?? [],
      multipliers,
      customUnits,
      activeWarehouseId,
    });

    // 2. Calculate net stock movements strictly for active warehouse
    const productStockMovements = calculateDocumentStockMovements({
      documents: rawDocuments ?? [],
      products: rawProducts,
      multipliers,
      activeWarehouseId,
    });

    return rawProducts.map((row) => {
      const metadata = row.metadata ?? {};
      const mov = productStockMovements.get(row.id);
      const netMovementStock = mov ? mov.net : 0;
      const serialAvailablePcs = availableSerialCountByProduct.get(row.id) ?? 0;
      const hasSerials = (rawSerials ?? []).some((s) => (s.product_id ?? s.productId) === row.id);

      const totalStock = getProductEffectiveStockInPcs({
        product: { ...row, trackingMode: metadata.trackingMode ?? 'non_serial' },
        availableSerialPcs: serialAvailablePcs,
        netMovementPcs: netMovementStock,
        hasSerials,
      });

      const nonSerialStock = Math.max(0, totalStock - serialAvailablePcs);

      return {
        id: row.id,
        name: row.name,
        sku: row.sku,
        category: row.category ?? '',
        price: Number(row.selling_price ?? 0),
        unitCost: Number(row.unit_cost ?? 0),
        stock: totalStock,
        stockNonSerial: nonSerialStock,
        active: row.status !== 'disabled' && row.status !== 'draft',
        status: row.status ?? 'active',
        imageUrl: metadata.imageUrl ?? metadata.image ?? metadata.photoUrl ?? '',
      };
    });
  }, [rawProducts, rawSerials, rawDocuments, multipliers, customUnits, activeWarehouseId]);

  // Hook filters management
  const {
    search,
    setSearch,
    category,
    setCategory,
    categories,
    stockStatus,
    setStockStatus,
    currentPage,
    setCurrentPage,
    filteredProducts,
    paginatedProducts,
    totalItems,
    totalPages,
    pageSize,
  } = useProductFilters(productsList);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (q !== null) {
      setSearch(q);
      // Clean query parameter from URL so it doesn't trigger on reload
      params.delete('q');
      navigate({ search: params.toString() }, { replace: true });
    }
  }, [location.search, setSearch, navigate]);


  const handleAddProduct = () => setShowAddModal(true);

  // Pagination bounds text calculation
  const fromVal = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const toVal = Math.min(currentPage * pageSize, totalItems);

  const handleExportProducts = () => {
    if (!canExport) {
      alert('Izin ekspor produk dibatasi pada versi produksi.');
      return;
    }
    try {
      setIsExporting(true);
      const rowsToExport = filteredProducts && filteredProducts.length > 0 ? filteredProducts : productsList;
      if (!rowsToExport || rowsToExport.length === 0) {
        alert('Tidak ada data produk untuk diekspor.');
        return;
      }

      const headers = ['SKU', 'Nama Produk', 'Kategori', 'Status', 'Stok (Lusin)', 'Stok (Pcs)', 'Stok Non-Serial (Pcs)'];
      if (canViewPrice) {
        headers.push('Harga Beli (Rp)', 'Harga Jual (Rp)');
      }

      const csvEscape = (val) => {
        if (val === null || val === undefined) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      };

      const csvLines = [headers.join(',')];

      rowsToExport.forEach((prod) => {
        const totalPcs = Number(prod.stock || 0);
        const totalLusin = Math.round((totalPcs / 12) * 100) / 100;
        const nonSerialPcs = Number(prod.stockNonSerial || 0);
        const line = [
          csvEscape(prod.sku || ''),
          csvEscape(prod.name || ''),
          csvEscape(prod.category || ''),
          csvEscape(prod.status || (prod.active ? 'active' : 'inactive')),
          totalLusin,
          totalPcs,
          nonSerialPcs,
        ];
        if (canViewPrice) {
          line.push(Number(prod.unitCost || 0), Number(prod.price || 0));
        }
        csvLines.push(line.join(','));
      });

      const csvContent = '\uFEFF' + csvLines.join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const dateStr = new Date().toISOString().split('T')[0];
      link.href = url;
      link.setAttribute('download', `docuflow_products_${dateStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error exporting products:', err);
      alert('Gagal mengekspor produk.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="products-page">
      {/* Header section */}
      <div className="products-page__header">
        <div>
          <h1 className="products-page__header-title">
            {t('products.title')}
          </h1>
          <p className="products-page__header-subtitle">
            {t('products.subtitle', { count: totalItems })}
          </p>
        </div>
        <div className="products-page__header-actions">
          {canExport && (
            <button
              type="button"
              className="btn btn-secondary interactive btn-md"
              onClick={handleExportProducts}
              disabled={isExporting}
              title={isDev ? "Ekspor Produk (Mode Dev - Tanpa Izin Owner)" : "Ekspor Produk"}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={16} />
              <span>{isExporting ? (t('products.exporting') || 'Mengekspor...') : (t('products.export') || 'Ekspor Produk')}</span>
              {isDev && (
                <span style={{ fontSize: '10px', background: 'var(--color-primary-surface, rgba(99,102,241,0.12))', color: 'var(--color-primary)', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>DEV</span>
              )}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary interactive btn-md"
            onClick={() => setShowGroupModal(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            title="Kelompokkan nomor seri dari berbagai produk"
          >
            <Layers size={16} />
            <span>Grouping Serial</span>
          </button>
          <button
            type="button"
            className="btn btn-primary interactive btn-md"
            onClick={handleAddProduct}
          >
            <Plus size={16} />
            <span>{t('products.addProduct')}</span>
          </button>
        </div>
      </div>

      {/* Filters section */}
      <ProductFilters
        search={search}
        setSearch={setSearch}
        category={category}
        setCategory={setCategory}
        categories={categories}
        stockStatus={stockStatus}
        setStockStatus={setStockStatus}
        stockUnit={stockUnit}
        setStockUnit={handleStockUnitChange}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      {/* Main content body */}
      {isLoading ? (
        <ProductSkeleton viewMode={activeViewMode} />
      ) : isError ? (
        <div className="products-page__error-state">
          <AlertCircle className="products-page__error-icon" size={48} />
          <h2 className="products-page__error-title">{t('products.errorTitle')}</h2>
          <p className="products-page__error-sub">{t('page.underConstruction')}</p>
          <button
            type="button"
            className="btn btn-secondary interactive"
            onClick={handleRetry}
          >
            {t('products.retry')}
          </button>
        </div>
      ) : totalItems === 0 ? (
        <div className="products-page__empty-state">
          <PackageOpen className="products-page__empty-icon" size={48} />
          <h2 className="products-page__empty-title">{t('products.emptyTitle')}</h2>
          <p className="products-page__empty-sub">{t('products.emptySub')}</p>
          <button
            type="button"
            className="btn btn-primary interactive"
            onClick={handleAddProduct}
          >
            <Plus size={16} />
            <span>{t('products.addProduct')}</span>
          </button>
        </div>
      ) : (
        <>
          {activeViewMode === 'table' ? (
            <ProductTable products={paginatedProducts} canViewPrice={canViewPrice} stockUnit={stockUnit} />
          ) : (
            <div className="products-page__card-grid">
              {paginatedProducts.map((product) => (
                <ProductCard key={product.id} product={product} canViewPrice={canViewPrice} stockUnit={stockUnit} />
              ))}
            </div>
          )}

          {/* Pagination controls footer */}
          {totalPages > 1 && (
            <div className="products-page__pagination">
              <span className="products-page__pagination-info">
                {t('products.showing', { from: fromVal, to: toVal, total: totalItems })}
              </span>

              {/* Desktop view numbers */}
              <div className="products-page__pagination-controls products-page__pagination-controls-desktop">
                <button
                  type="button"
                  className="products-page__pagination-btn"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} />
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNo) => (
                  <button
                    key={pageNo}
                    type="button"
                    className={`products-page__pagination-btn ${
                      pageNo === currentPage ? 'products-page__pagination-btn--active' : ''
                    }`}
                    onClick={() => setCurrentPage(pageNo)}
                  >
                    {pageNo}
                  </button>
                ))}

                <button
                  type="button"
                  className="products-page__pagination-btn"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Mobile view simple text buttons */}
              <div className="products-page__pagination-controls products-page__pagination-controls-mobile">
                <button
                  type="button"
                  className="products-page__pagination-btn products-page__pagination-btn-mobile"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} style={{ marginRight: 'var(--space-1)' }} />
                  <span>{t('products.previous')}</span>
                </button>
                <button
                  type="button"
                  className="products-page__pagination-btn products-page__pagination-btn-mobile"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                >
                  <span>{t('products.next')}</span>
                  <ChevronRight size={16} style={{ marginLeft: 'var(--space-1)' }} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <AddProductModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        products={productsList}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['products'] })}
      />
      <SerialGroupModal
        isOpen={showGroupModal}
        onClose={() => setShowGroupModal(false)}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['products'] });
          queryClient.invalidateQueries({ queryKey: ['product-serials'] });
        }}
      />
    </div>
  );
}

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { api } from '../../utils/api.js';
import { buildSerialStockIndex, getProductUnitKey, resolveMultiplier } from '../../utils/reportUnits.js';
import KpiStrip from './KpiStrip.jsx';
import StockPositionTable from './StockPositionTable.jsx';
import GoodsInReport from './GoodsInReport.jsx';
import GoodsOutReport from './GoodsOutReport.jsx';
import MovementLedger from './MovementLedger.jsx';
import StockOpname from './StockOpname.jsx';
import './ReportsPage.css';

export default function ReportsPage() {
  const { t, activeWarehouseId } = useApp();
  const { multipliers, customUnits } = useUnits();
  const [activeTab, setActiveTab] = useState('stock'); // stock, goods_in, goods_out, movements, opname

  // 1. Fetch products
  const { data: rawProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['products', activeWarehouseId],
    queryFn: async () => {
      const res = await api.get('/api/workspace/products?limit=1000');
      if (!res.ok) throw new Error('Failed to load products');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // 2. Fetch serial numbers
  const { data: rawSerials = [], isLoading: loadingSerials } = useQuery({
    queryKey: ['product-serials', activeWarehouseId],
    queryFn: async () => {
      const whParam = activeWarehouseId ? `?warehouse_id=${encodeURIComponent(activeWarehouseId)}&limit=10000` : '?limit=10000';
      const res = await api.get(`/api/workspace/product-serials${whParam}`);
      if (!res.ok) throw new Error('Failed to load serials');
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  // 3. Fetch documents
  const { data: rawDocuments = [] } = useQuery({
    queryKey: ['workspace-documents', activeWarehouseId],
    queryFn: async () => {
      const whParam = activeWarehouseId ? `?warehouse_id=${encodeURIComponent(activeWarehouseId)}&limit=1000` : '?limit=1000';
      const res = await api.get(`/api/workspace/documents${whParam}`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 30000,
  });

  const isLoading = loadingProducts || loadingSerials;

  // Serial stock index: unit tiap serial mengikuti metadata/penanda nomor seri (terikat gudang aktif)
  const serialIndex = useMemo(() => {
    const filteredSerials = activeWarehouseId
      ? (rawSerials ?? []).filter((s) => !s.warehouse_id || String(s.warehouse_id) === String(activeWarehouseId))
      : (rawSerials ?? []);
    return buildSerialStockIndex({ serials: filteredSerials, documents: rawDocuments, multipliers, customUnits });
  }, [rawSerials, rawDocuments, multipliers, customUnits, activeWarehouseId]);

  // Process products and calculate accurate stock positions (strictly Goods In / Goods Out for active warehouse)
  const processedProducts = useMemo(() => {
    const productStockMovements = new Map();
    (rawDocuments ?? []).forEach((doc) => {
      const status = doc.status || 'draft';
      // Only completed documents are real stock movements.
      if (status !== 'completed') return;
      const docType = doc.document_type || doc.type;
      const isGoodsIn = docType === 'goods_in';
      const isGoodsOut = docType === 'goods_out';
      if (!isGoodsIn && !isGoodsOut) return;

      const docWh = doc.warehouse_id || doc.warehouseId;
      if (activeWarehouseId && docWh && String(docWh) !== String(activeWarehouseId)) {
        return;
      }

      (doc.items ?? []).forEach((item) => {
        const productId = item.productId ?? item.product_id;
        if (!productId) return;

        const rawQty = item.metadata?.qtyInput ?? item.quantity ?? item.qty ?? 1;
        const unit = item.metadata?.qtyUnit || item.qtyUnit || item.unit || 'pcs';
        const qtyInPcs = rawQty * resolveMultiplier(unit, multipliers, customUnits);

        const current = productStockMovements.get(productId) ?? { in: 0, out: 0 };
        if (isGoodsIn) current.in += qtyInPcs;
        if (isGoodsOut) current.out += qtyInPcs;
        productStockMovements.set(productId, current);
      });
    });

    return rawProducts.map((row) => {
      const metadata = row.metadata ?? {};
      const mov = productStockMovements.get(row.id);
      const totalStock = mov ? Math.max(0, mov.in - mov.out) : 0;
      const minStock = Number(metadata.minStock ?? 10);

      return {
        id: row.id,
        name: row.name,
        sku: row.sku,
        stock: totalStock,
        minStock,
        unitKey: getProductUnitKey(row),
      };
    });
  }, [rawProducts, rawDocuments, multipliers, customUnits, activeWarehouseId]);

  // Compute 4 KPIs from processed products
  const kpis = useMemo(() => {
    let totalStock = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    processedProducts.forEach((p) => {
      totalStock += p.stock;
      if (p.stock === 0) {
        outOfStockCount++;
      } else if (p.stock <= p.minStock) {
        lowStockCount++;
      }
    });

    return {
      totalProducts: processedProducts.length,
      totalStock,
      lowStockCount,
      outOfStockCount,
    };
  }, [processedProducts]);

  return (
    <div className="reports-page">
      {/* Header title */}
      <div className="reports-header-group">
        <h1 className="reports-title">{t('reports.title')}</h1>
        <p className="reports-subtitle">{t('reports.subtitle')}</p>
      </div>

      {/* Loading overlay for data fetch */}
      {isLoading ? (
        <div className="reports-empty-cell">
          {t('reports.loading')}
        </div>
      ) : (
        <>
          {/* KPI Cards Strip */}
          <KpiStrip
            totalProducts={kpis.totalProducts}
            totalStock={kpis.totalStock}
            lowStockCount={kpis.lowStockCount}
            outOfStockCount={kpis.outOfStockCount}
          />

          {/* Tab Navigation */}
          <div className="reports-tabs-bar">
            <button
              type="button"
              className={`reports-tab-btn ${activeTab === 'stock' ? 'active' : ''}`}
              onClick={() => setActiveTab('stock')}
            >
              {t('reports.tab.stock')}
            </button>
            <button
              type="button"
              className={`reports-tab-btn ${activeTab === 'goods_in' ? 'active' : ''}`}
              onClick={() => setActiveTab('goods_in')}
            >
              {t('reports.tab.goodsIn')}
            </button>
            <button
              type="button"
              className={`reports-tab-btn ${activeTab === 'goods_out' ? 'active' : ''}`}
              onClick={() => setActiveTab('goods_out')}
            >
              {t('reports.tab.goodsOut')}
            </button>
            <button
              type="button"
              className={`reports-tab-btn ${activeTab === 'movements' ? 'active' : ''}`}
              onClick={() => setActiveTab('movements')}
            >
              {t('reports.tab.movements')}
            </button>
            <button
              type="button"
              className={`reports-tab-btn ${activeTab === 'opname' ? 'active' : ''}`}
              onClick={() => setActiveTab('opname')}
            >
              {t('reports.tab.opname')}
            </button>
          </div>

          {/* Tab Contents */}
          {activeTab === 'stock' && (
            <StockPositionTable products={processedProducts} serialIndex={serialIndex} />
          )}

          {activeTab === 'goods_in' && (
            <GoodsInReport />
          )}

          {activeTab === 'goods_out' && (
            <GoodsOutReport />
          )}

          {activeTab === 'movements' && (
            <MovementLedger />
          )}

          {activeTab === 'opname' && (
            <StockOpname products={processedProducts} documents={rawDocuments} />
          )}
        </>
      )}
    </div>
  );
}

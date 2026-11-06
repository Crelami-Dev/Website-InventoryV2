import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApp } from './context/AppContext.jsx';
import { getWorkspaceSettings, isWorkspaceModuleEnabled } from './utils/api.js';
import AuthPage from './pages/Auth/AuthPage.jsx';
import AppShell from './components/AppShell/AppShell.jsx';
import ProductsPage from './pages/Products/ProductsPage.jsx';
import ProductDetailPage from './pages/Products/ProductDetailPage.jsx';
import GoodsInPage from './pages/GoodsIn/GoodsInPage.jsx';
import GoodsOutPage from './pages/GoodsOut/GoodsOutPage.jsx';
import ReturnsPage from './pages/Returns/ReturnsPage.jsx';
import ReportsPage from './pages/Reports/ReportsPage.jsx';
import CustomersPage from './pages/Customers/CustomersPage.jsx';
import SuppliersPage from './pages/Suppliers/SuppliersPage.jsx';
import DocumentsPage from './pages/Documents/DocumentsPage.jsx';
import DraftPage from './pages/Documents/DraftPage.jsx';
import SettingsPage from './pages/Settings/SettingsPage.jsx';
import DashboardPage from './pages/Dashboard/DashboardPage.jsx';
import AuditLogPage from './pages/AuditLog/AuditLogPage.jsx';
import PurchaseOrdersPage from './pages/PurchaseOrders/PurchaseOrdersPage.jsx';
import WarehouseSwitchOverlay from './components/WarehouseSwitchOverlay/WarehouseSwitchOverlay.jsx';
import SerialGroupingPage from './pages/SerialGrouping/SerialGroupingPage.jsx';

/**
 * Placeholder page for routes that are not yet implemented.
 * Shows a "coming soon" message using translation keys.
 */
function PlaceholderPage({ titleKey }) {
  const { t } = useApp();
  return (
    <div className="placeholder-page">
      <h1 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'var(--text-subhead)',
        fontWeight: 600,
        color: 'var(--color-text-primary)',
        marginBottom: 'var(--space-2)',
      }}>
        {t(titleKey)}
      </h1>
      <p style={{
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-body)',
        color: 'var(--color-text-secondary)',
      }}>
        {t('page.underConstruction')}
      </p>
    </div>
  );
}

function getFallbackRoute(settings, user) {
  if (!user) return '/auth';
  if (user.role?.toLowerCase() === 'super_admin' || user.role?.toLowerCase() === 'owner') {
    return '/dashboard';
  }
  // Sales_Person diarahkan ke Dashboard setelah login.
  if (user.role?.toLowerCase() === 'sales_person') {
    if (isWorkspaceModuleEnabled(settings, 'dashboard', user)) return '/dashboard';
    if (isWorkspaceModuleEnabled(settings, 'purchase-orders', user)) return '/purchase-orders';
    return '/settings';
  }
  if (isWorkspaceModuleEnabled(settings, 'dashboard', user)) return '/dashboard';
  if (isWorkspaceModuleEnabled(settings, 'purchase-orders', user)) return '/purchase-orders';
  if (isWorkspaceModuleEnabled(settings, 'goods_out', user)) return '/inventory/goods-out';
  if (isWorkspaceModuleEnabled(settings, 'goods_in', user)) return '/inventory/goods-in';
  if (isWorkspaceModuleEnabled(settings, 'products', user)) return '/inventory/products';
  if (isWorkspaceModuleEnabled(settings, 'documents', user)) return '/documents';
  if (isWorkspaceModuleEnabled(settings, 'customers', user)) return '/partners/customers';
  return '/settings';
}

function ModuleRoute({ moduleKey, children }) {
  const { user } = useApp();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
    enabled: !!user,
  });

  if (!user) return <Navigate to="/auth" replace />;
  if (isLoading) return null;

  if (user.role?.toLowerCase() === 'super_admin') {
    return children;
  }

  const isEnabled = isWorkspaceModuleEnabled(settings, moduleKey, user);

  if (!isEnabled) {
    const fallback = getFallbackRoute(settings, user);
    return <Navigate to={fallback} replace />;
  }

  return children;
}

export default function App() {
  const { user } = useApp();

  return (
    <>
      <WarehouseSwitchOverlay />
      <Routes>
        {/* Public routes */}
        <Route
          path="/"
          element={user ? <Navigate to="/dashboard" replace /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/auth"
          element={user ? <Navigate to="/dashboard" replace /> : <AuthPage />}
        />

        {/* Protected routes — wrapped in AppShell */}
        <Route element={user ? <AppShell /> : <Navigate to="/auth" replace />}>
          {/* Utama */}
          <Route path="/dashboard" element={<ModuleRoute moduleKey="dashboard"><DashboardPage /></ModuleRoute>} />

          {/* Transaksi — Purchase Orders */}
          <Route path="/purchase-orders/*" element={<ModuleRoute moduleKey="purchase-orders"><PurchaseOrdersPage /></ModuleRoute>} />

          {/* Inventory */}
          <Route path="/inventory/products" element={<ModuleRoute moduleKey="products"><ProductsPage /></ModuleRoute>} />
          <Route path="/inventory/products/:sku" element={<ModuleRoute moduleKey="products"><ProductDetailPage /></ModuleRoute>} />
          <Route path="/inventory/serial-grouping" element={<ModuleRoute moduleKey="products"><SerialGroupingPage /></ModuleRoute>} />
          <Route path="/grouping-serial" element={<Navigate to="/inventory/serial-grouping" replace />} />
          <Route path="/inventory/goods-in" element={<ModuleRoute moduleKey="goods_in"><GoodsInPage /></ModuleRoute>} />
          <Route path="/inventory/goods-out" element={<ModuleRoute moduleKey="goods_out"><GoodsOutPage /></ModuleRoute>} />
          <Route path="/inventory/returns" element={<ModuleRoute moduleKey="goods_out"><ReturnsPage /></ModuleRoute>} />
          <Route path="/inventory/reports" element={<ModuleRoute moduleKey="reports"><ReportsPage /></ModuleRoute>} />

          {/* Mitra */}
          <Route path="/partners/customers" element={<ModuleRoute moduleKey="customers"><CustomersPage /></ModuleRoute>} />
          <Route path="/partners/suppliers" element={<ModuleRoute moduleKey="suppliers"><SuppliersPage /></ModuleRoute>} />

          {/* Dokumen */}
          <Route path="/documents" element={<ModuleRoute moduleKey="documents"><DocumentsPage /></ModuleRoute>} />
          <Route path="/document/:id" element={<ModuleRoute moduleKey="documents"><DraftPage /></ModuleRoute>} />

          {/* Sistem */}
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/audit-log" element={<ModuleRoute moduleKey="history"><AuditLogPage /></ModuleRoute>} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

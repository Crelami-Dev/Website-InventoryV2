import React, { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '../../context/AppContext.jsx';
import { getWorkspaceSettings, isWorkspaceModuleEnabled } from '../../utils/api.js';
import './Sidebar.css';

const NAV_GROUPS = [
  {
    labelKey: 'sidebar.group.utama',
    items: [
      { key: 'sidebar.dashboard', path: '/dashboard', icon: DashboardIcon, moduleKey: 'dashboard' },
      { key: 'sidebar.documents', path: '/documents', icon: DocumentIcon, moduleKey: 'documents' },
    ],
  },
  {
    labelKey: 'sidebar.group.transaksi',
    moduleKey: 'purchase-orders',
    items: [
      { key: 'sidebar.purchaseOrders', path: '/purchase-orders', icon: PurchaseOrderIcon, moduleKey: 'purchase-orders' },
    ],
  },
  {
    labelKey: 'sidebar.group.inventory',
    items: [
      { key: 'sidebar.products', path: '/inventory/products', icon: ProductsIcon, moduleKey: 'products' },
      { key: 'sidebar.goodsIn', path: '/inventory/goods-in', icon: GoodsInIcon, moduleKey: 'goods_in' },
      { key: 'sidebar.goodsOut', path: '/inventory/goods-out', icon: GoodsOutIcon, moduleKey: 'goods_out' },
      { key: 'sidebar.returns', path: '/inventory/returns', icon: ReturnsIcon, moduleKey: 'goods_out' },
      { key: 'sidebar.serialGrouping', path: '/inventory/serial-grouping', icon: SerialGroupingIcon, moduleKey: 'products' },
      { key: 'sidebar.reports', path: '/inventory/reports', icon: ReportsIcon, moduleKey: 'reports' },
    ],
  },
  {
    labelKey: 'sidebar.group.mitra',
    moduleKey: 'contacts',
    items: [
      { key: 'sidebar.customers', path: '/partners/customers', icon: CustomersIcon, moduleKey: 'customers' },
      { key: 'sidebar.suppliers', path: '/partners/suppliers', icon: SuppliersIcon, moduleKey: 'suppliers' },
    ],
  },
  {
    labelKey: 'sidebar.group.sistem',
    roles: ['staff', 'owner', 'super_admin', 'sales_person'],
    items: [
      { key: 'sidebar.settings', path: '/settings', icon: SettingsIcon },
      { key: 'sidebar.auditLog', path: '/audit-log', icon: HistoryIcon, moduleKey: 'history' },
    ],
  },
];

export default function Sidebar({ isOpen, onClose, onOpenReprintModal }) {
  const { t, user } = useApp();
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef(null);

  const handleBrandClick = () => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);

    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0;
      if (onOpenReprintModal) onOpenReprintModal();
      if (onClose) onClose();
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
      }, 500);
    }
  };

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const isModuleEnabled = (key) => {
    return isWorkspaceModuleEnabled(settings, key, user);
  };
  const userRole = user?.role?.toLowerCase();

  const visibleGroups = NAV_GROUPS.filter((group) => {
    if (!group.roles) return true;
    return group.roles.includes(userRole);
  })
  .filter((group) => {
    // Role sales_person boleh lihat group: utama (Dashboard), transaksi (PO), mitra (Pelanggan), sistem (Settings).
    if (userRole === 'sales_person') {
      const allowedGroupsForSales = ['sidebar.group.utama', 'sidebar.group.transaksi', 'sidebar.group.mitra', 'sidebar.group.sistem'];
      return allowedGroupsForSales.includes(group.labelKey);
    }
    return true;
  })
  .map((group) => {
    // Untuk sales_person, di group utama sembunyikan Documents (karena di-blokir backend).
    if (userRole === 'sales_person' && group.labelKey === 'sidebar.group.utama') {
      return {
        ...group,
        items: group.items.filter((item) => item.moduleKey !== 'documents'),
      };
    }
    // Untuk sales_person, di group mitra sembunyikan Suppliers (karena tidak relevan).
    if (userRole === 'sales_person' && group.labelKey === 'sidebar.group.mitra') {
      return {
        ...group,
        items: group.items.filter((item) => item.moduleKey !== 'suppliers'),
      };
    }
    // Untuk sales_person, di group sistem sembunyikan AuditLog (module history tidak di-allow).
    if (userRole === 'sales_person' && group.labelKey === 'sidebar.group.sistem') {
      return {
        ...group,
        items: group.items.filter((item) => item.moduleKey !== 'history'),
      };
    }
    return group;
  })
  .filter((group) => {
    if (group.moduleKey) return isModuleEnabled(group.moduleKey);
    const hasModuleItems = group.items.some((item) => item.moduleKey);
    if (!hasModuleItems) return true;
    return true;
  }).map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!item.moduleKey) return true;
      return isModuleEnabled(item.moduleKey);
    }),
  })).filter((group) => group.items.length > 0);

  const handlePrefetch = (path) => {
  };

  const initials = user?.fullName
    ? user.fullName.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()
    : '?';

  return (
    <>
      <div
        className={`sidebar-overlay ${isOpen ? 'sidebar-overlay--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      <nav
        className={`sidebar ${isOpen ? 'sidebar--open' : ''}`}
        aria-label={t('sidebar.navLabel')}
      >
        <div className="sidebar__header">
          <div 
            className="sidebar__brand" 
            onClick={handleBrandClick}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            title="Docuflow"
          >
            <div className="sidebar__brand-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <span className="sidebar__brand-name">Docuflow</span>
              <span className="sidebar__brand-subtitle">{t('sidebar.subtitle')}</span>
            </div>
          </div>
        </div>

        <div className="sidebar__nav">
          {visibleGroups.map((group) => (
            <React.Fragment key={group.labelKey}>
              <div className="sidebar__section">
                <span className="sidebar__section-label">{t(group.labelKey)}</span>
              </div>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/dashboard'}
                  className={({ isActive }) =>
                    `sidebar__link${isActive ? ' sidebar__link--active' : ''}`
                  }
                  onClick={onClose}
                  onMouseEnter={() => handlePrefetch(item.path)}
                >
                  <span className="sidebar__link-icon-wrap">
                    <item.icon className="sidebar__link-icon" />
                  </span>
                  <span className="sidebar__link-text">{t(item.key)}</span>
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </div>

        <div className="sidebar__footer">
          <div className="sidebar__user-avatar">{initials}</div>
          <div className="sidebar__user-info">
            <span className="sidebar__user-name">{user?.fullName || '—'}</span>
            {user?.role && (
              <span className="sidebar__user-role">{user.role}</span>
            )}
          </div>
        </div>
      </nav>
    </>
  );
}

function DashboardIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}


function ProductsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function GoodsInIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v10M12 12l-4-4M12 12l4-4" />
      <path d="M22 12h-4l-3 4H9L6 12H2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8z" />
    </svg>
  );
}

function GoodsOutIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 12V2M12 2L8 6M12 2l4 6" />
      <path d="M22 12h-4l-3 4H9L6 12H2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8z" />
    </svg>
  );
}

function ReportsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function CustomersIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SuppliersIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

function DocumentIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function HistoryIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function PurchaseOrderIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M9 14l2 2 4-4" />
    </svg>
  );
}

function SettingsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ReturnsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function SerialGroupingIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

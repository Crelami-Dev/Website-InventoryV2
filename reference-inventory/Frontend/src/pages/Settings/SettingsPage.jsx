import React, { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApp } from '../../context/AppContext.jsx';
import { getWorkspaceSettings, canExportProducts } from '../../utils/api.js';
import { Settings, User, Building2, ToggleLeft, Users, Hash, Database, Layers, Warehouse, Barcode, Clock } from 'lucide-react';
import ProfileSetting from './ProfileSetting.jsx';
import CompanySetting from './CompanySetting.jsx';
import DocumentNumberingSetting from './DocumentNumberingSetting.jsx';
import SerialNumberSetting from './SerialNumberSetting.jsx';
import ModulesSetting from './ModulesSetting.jsx';
import UsersSetting from './UsersSetting.jsx';
import ExportImportSetting from './ExportImportSetting.jsx';
import UnitsSetting from './UnitsSetting.jsx';
import WarehousesSetting from './WarehousesSetting.jsx';
import DailyReportSetting from './DailyReportSetting.jsx';
import './SettingsPage.css';


function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      className={`settings-tab ${active ? 'settings-tab--active' : ''}`}
      onClick={onClick}
    >
      <Icon className="settings-tab__icon" />
      <span>{label}</span>
    </button>
  );
}

export default function SettingsPage() {
  const { t, user } = useApp();
  const [activeTab, setActiveTab] = useState('profile');

  const { data: settings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
  });

  const visibleTabs = useMemo(() => {
    const list = [
      { key: 'profile', labelKey: 'settings.tab.profile', defaultLabel: 'Profil', icon: User },
    ];

    const role = user?.role?.toLowerCase();

    // 1. Company Tab (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'company', labelKey: 'settings.tab.company', defaultLabel: 'Perusahaan', icon: Building2 });
    }

    // 2. Warehouses / Storages Settings (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'warehouses', labelKey: 'settings.tab.warehouses', defaultLabel: 'Gudang / Cabang', icon: Warehouse });
    }

    // 3. Units Settings (Owner, Super Admin, and Staff)
    if (role === 'owner' || role === 'super_admin' || role === 'staff') {
      list.push({ key: 'units', labelKey: 'settings.tab.units', defaultLabel: 'Satuan Inventory', icon: Layers });
    }

    // 4. Document Numbering (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'numbering', labelKey: 'settings.tab.numbering', defaultLabel: 'Penomoran', icon: Hash });
    }

    // 5. Serial Number (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'serial-numbers', labelKey: 'settings.tab.serialNumbers', defaultLabel: 'Nomor Seri', icon: Barcode });
    }

    // 6. Modules (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'modules', labelKey: 'settings.tab.modules', defaultLabel: 'Modul', icon: ToggleLeft });
    }

    // 7. Users (Owner and Super Admin only)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'users', labelKey: 'settings.tab.users', defaultLabel: 'Pengguna', icon: Users });
    }

    // 8. Export / Import (Owner and Super Admin, or staff in dev mode / with owner permission)
    const canExport = canExportProducts(settings, user);
    if (role === 'owner' || role === 'super_admin' || canExport) {
      list.push({ key: 'export-import', labelKey: 'settings.tab.exportImport', defaultLabel: 'Ekspor / Impor', icon: Database });
    }

    // 9. Daily Report (Owner and Super Admin)
    if (role === 'owner' || role === 'super_admin') {
      list.push({ key: 'daily-report', labelKey: 'settings.tab.dailyReport', defaultLabel: 'Laporan Harian', icon: Clock });
    }

    return list;
  }, [user, settings]);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab('profile');
    }
  }, [visibleTabs, activeTab]);

  return (
    <div className="settings-page">
      <div className="settings-page__header">
        <Settings size={24} />
        <h1 className="settings-page__title">{t('settings.title')}</h1>
      </div>

      <div className="settings-layout">
        <nav className="settings-sidebar">
          {visibleTabs.map((tab) => (
            <TabButton
              key={tab.key}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              icon={tab.icon}
              label={t(tab.labelKey) !== tab.labelKey ? t(tab.labelKey) : tab.defaultLabel}
            />
          ))}
        </nav>

        <div className="settings-content">
          {activeTab === 'profile' && <ProfileSetting />}
          {activeTab === 'company' && <CompanySetting />}
          {activeTab === 'warehouses' && <WarehousesSetting />}
          {activeTab === 'units' && <UnitsSetting />}
          {activeTab === 'numbering' && <DocumentNumberingSetting />}
          {activeTab === 'serial-numbers' && <SerialNumberSetting />}
          {activeTab === 'modules' && <ModulesSetting />}
          {activeTab === 'users' && <UsersSetting />}
          {activeTab === 'export-import' && <ExportImportSetting />}
          {activeTab === 'daily-report' && <DailyReportSetting />}
        </div>
      </div>
    </div>
  );
}


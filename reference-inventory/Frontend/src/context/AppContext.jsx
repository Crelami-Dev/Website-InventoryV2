import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSession, setSession, clearSession, api, getWorkspaceSettings, getWarehouses, normalizeUser } from '../utils/api';
import { translations } from '../utils/translations';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const queryClient = useQueryClient();
  const [session, setSessionState] = useState(() => getSession());
  const [lang, setLang] = useState(() => {
    const session = getSession();
    if (session.user?.user_metadata?.language) return session.user.user_metadata.language;
    return navigator.language.startsWith('id') ? 'id' : 'en';
  });
  const [theme, setTheme] = useState(() => {
    const session = getSession();
    return session.user?.user_metadata?.theme || 'light';
  });
  const [palette, setPalette] = useState(() => {
    const session = getSession();
    return session.user?.user_metadata?.palette || 'indigo';
  });
  const [darkness, setDarkness] = useState(() => {
    const session = getSession();
    return session.user?.user_metadata?.darkness || 'dark';
  });

  const [activeWarehouseId, setActiveWarehouseIdState] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('docuflow_active_warehouse_id') || null;
    }
    return null;
  });
  const [isSwitchingWarehouse, setIsSwitchingWarehouse] = useState(false);
  const [switchingTargetWarehouseName, setSwitchingTargetWarehouseName] = useState('');

  const user = session.user;
  const token = session.token;

  // Fetch warehouses for workspace
  const { data: warehousesResponse, refetch: refetchWarehouses } = useQuery({
    queryKey: ['workspace-warehouses'],
    queryFn: getWarehouses,
    staleTime: 60000,
    enabled: !!token,
  });

  const warehouses = useMemo(() => {
    const list = warehousesResponse?.data || [];
    return list.filter((w) => w.status !== 'archived');
  }, [warehousesResponse]);

  const activeWarehouse = useMemo(() => {
    if (!warehouses || warehouses.length === 0) return null;
    if (activeWarehouseId) {
      const found = warehouses.find((w) => w.id === activeWarehouseId);
      if (found) return found;
    }
    const def = warehouses.find((w) => w.is_default) || warehouses[0];
    return def || null;
  }, [warehouses, activeWarehouseId]);

  // Keep localStorage (and therefore the X-Warehouse-Id header sent by
  // utils/api.js) in sync with the resolved active warehouse, including the
  // very first resolution to a default warehouse right after login before
  // the user has ever explicitly switched.
  useEffect(() => {
    if (!activeWarehouse?.id) return;
    if (activeWarehouseId === activeWarehouse.id) return;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('docuflow_active_warehouse_id', activeWarehouse.id);
    }
    setActiveWarehouseIdState(activeWarehouse.id);
  }, [activeWarehouse, activeWarehouseId]);

  const switchWarehouse = async (warehouseId) => {
    const target = warehouses.find((w) => w.id === warehouseId);
    if (!target) return;
    if (activeWarehouseId === warehouseId) return;

    setIsSwitchingWarehouse(true);
    setSwitchingTargetWarehouseName(target.name || 'Gudang');

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('docuflow_active_warehouse_id', warehouseId);
    }
    setActiveWarehouseIdState(warehouseId);

    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-serials'] }),
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['purchase-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-dashboard-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['history'] }),
        queryClient.invalidateQueries({ queryKey: ['workspace-settings'] }),
        queryClient.refetchQueries({ queryKey: ['products'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['product-serials'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['documents'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['workspace-documents'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['dashboard-stats'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['purchase-orders'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['contacts'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['accounts'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['history'], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['workspace-settings'], type: 'active' }),
        new Promise((resolve) => setTimeout(resolve, 850)),
      ]);
    } catch (_) {}

    setIsSwitchingWarehouse(false);
    setSwitchingTargetWarehouseName('');
  };

  // Fetch workspace settings for non-super_admin users (to get workspace palette)
  const { data: wsSettings } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: getWorkspaceSettings,
    staleTime: 5 * 60 * 1000,
    enabled: !!token && user?.role !== 'super_admin',
  });

  // Effective palette: super_admin uses local state instantly; workspace members inherit from workspace settings
  const effectivePalette = useMemo(() => {
    if (user?.role === 'super_admin') return palette;
    const accentColor = wsSettings?.appearance?.accentColor;
    if (accentColor) return accentColor.toLowerCase();
    return palette || 'indigo';
  }, [user?.role, palette, wsSettings?.appearance?.accentColor]);

  // Effective darkness: super_admin uses local state instantly; workspace members inherit from workspace settings
  const effectiveDarkness = useMemo(() => {
    if (user?.role === 'super_admin') return darkness;
    const d = wsSettings?.appearance?.darknessLevel;
    if (d) return d.toLowerCase();
    return darkness || 'dark';
  }, [user?.role, darkness, wsSettings?.appearance?.darknessLevel]);

  // Initialize lang and theme change listeners
  useEffect(() => {
    // Sync state on local storage user change
    const handleUserUpdate = () => {
      setSessionState(getSession());
    };
    window.addEventListener('docuflow_user_updated', handleUserUpdate);
    return () => {
      window.removeEventListener('docuflow_user_updated', handleUserUpdate);
    };
  }, []);

  // Fetch /me to load preferences if logged in
  useEffect(() => {
    if (!token) return;

    api.get('/api/auth/me')
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json();
          if (data.user) {
            updateUser(data.user);
            if (data.user.theme) {
              setTheme(data.user.theme);
            }
            if (data.user.language) {
              setLang(data.user.language);
            }
            if (data.user.palette) {
              setPalette(data.user.palette);
            }
            if (data.user.darkness) {
              setDarkness(data.user.darkness);
            }
          }
        }
      })
      .catch(() => {});
  }, [token]);

  // Apply theme + effective palette + darkness to document element class
  useEffect(() => {
    const themeClass = theme === 'dark' ? 'theme-dark' : 'theme-light';
    const paletteClass = effectivePalette !== 'indigo' ? `palette-${effectivePalette}` : '';
    const darknessClass = theme === 'dark' && effectiveDarkness !== 'dark' ? `darkness-${effectiveDarkness}` : '';
    document.documentElement.className = [themeClass, paletteClass, darknessClass].filter(Boolean).join(' ');
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-palette', effectivePalette);
    document.documentElement.setAttribute('data-darkness', effectiveDarkness);
  }, [theme, effectivePalette, effectiveDarkness]);

  const updateUser = (newUser) => {
    const normalizedUser = normalizeUser(newUser);
    setSessionState((prev) => {
      const nextSession = { ...prev, user: normalizedUser };
      localStorage.setItem('docuflow_user', JSON.stringify(normalizedUser));
      return nextSession;
    });
  };

  const login = (token, refreshToken, user) => {
    const normalizedUser = normalizeUser(user);
    setSession({ token, refreshToken, user: normalizedUser });
    setSessionState({ token, user: normalizedUser });
  };

  const logout = () => {
    api.post('/api/auth/sign-out').catch(() => {});
    clearSession();
    setActiveWarehouseIdState(null);
    try {
      queryClient.clear();
    } catch (_) {}
    setSessionState({ token: null, user: null });
  };

  const updatePreference = async ({ lang: newLang, theme: newTheme, palette: newPalette, darkness: newDarkness }) => {
    if (newLang) {
      setLang(newLang);
    }
    if (newTheme) {
      setTheme(newTheme);
    }
    if (newPalette) {
      setPalette(newPalette);
      // Optimistic cache update to prevent API latency lag in other components
      queryClient.setQueryData(['workspace-settings'], (prev) => {
        if (!prev) return prev;
        const fillPalette = newPalette.toLowerCase();
        const capColor = fillPalette.charAt(0).toUpperCase() + fillPalette.slice(1);
        return {
          ...prev,
          appearance: {
            ...(prev.appearance ?? {}),
            accentColor: capColor,
          }
        };
      });
    }
    if (newDarkness) {
      setDarkness(newDarkness);
      // Optimistic cache update to prevent API latency lag in other components
      queryClient.setQueryData(['workspace-settings'], (prev) => {
        if (!prev) return prev;
        const fillDarkness = newDarkness.toLowerCase();
        const capDarkness = fillDarkness.charAt(0).toUpperCase() + fillDarkness.slice(1);
        return {
          ...prev,
          appearance: {
            ...(prev.appearance ?? {}),
            darknessLevel: capDarkness,
          }
        };
      });
    }

    if (!token) return;

    // Super admin → update personal profile
    if (user?.role === 'super_admin') {
      try {
        const payload = {};
        if (newLang) payload.language = newLang;
        if (newTheme) payload.theme = newTheme;
        if (newPalette) payload.palette = newPalette;
        if (newDarkness) payload.darkness = newDarkness;
        const res = await api.patch('/api/auth/profile', payload);
        if (res.ok) {
          const data = await res.json();
          if (data.user) updateUser(data.user);
        }
      } catch (_) {}
      return;
    }

    // Workspace member → persist theme+lang to profile, palette+darkness to workspace settings
    try {
      const profilePayload = {};
      if (newLang) profilePayload.language = newLang;
      if (newTheme) profilePayload.theme = newTheme;
      if (newPalette) profilePayload.palette = newPalette;
      if (newDarkness) profilePayload.darkness = newDarkness;
      const res = await api.patch('/api/auth/profile', profilePayload);
      if (res.ok) {
        const data = await res.json();
        if (data.user) updateUser(data.user);
      }
    } catch (_) {}

    // Owner changing palette or darkness → update workspace settings (affects all members)
    if (newPalette || newDarkness) {
      try {
        const res = await api.get('/api/workspace/settings');
        if (res.ok) {
          const json = await res.json();
          const rawData = json.data ?? json;
          let appValue = {};
          if (Array.isArray(rawData)) {
            const appItem = rawData.find(item => item.key === 'app');
            if (appItem) appValue = appItem.value;
          }
          appValue = JSON.parse(JSON.stringify(appValue));
          if (!appValue.appearance) appValue.appearance = {};
          if (newPalette) {
            appValue.appearance.accentColor = newPalette.charAt(0).toUpperCase() + newPalette.slice(1);
          }
          if (newDarkness) {
            appValue.appearance.darknessLevel = newDarkness.charAt(0).toUpperCase() + newDarkness.slice(1);
          }
          await api.patch('/api/workspace/settings/app', { value: appValue });
          queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
        }
      } catch (_) {}
    }
  };

  const t = (key, params = {}) => {
    let val = translations[lang]?.[key];
    if (!val) {
      val = translations['en']?.[key];
    }
    if (!val) return key;
    return val.replace(/{(\w+)}/g, (_, p) => params[p] !== undefined ? params[p] : `{${p}}`);
  };

  return (
    <AppContext.Provider
      value={{
        user,
        token,
        lang,
        theme,
        palette: effectivePalette,
        darkness: effectiveDarkness,
        t,
        login,
        logout,
        updatePreference,
        updateUser,
        warehouses,
        activeWarehouse,
        activeWarehouseId: activeWarehouse?.id,
        switchWarehouse,
        refetchWarehouses,
        isSwitchingWarehouse,
        switchingTargetWarehouseName,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}

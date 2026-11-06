let refreshPromise = null;

const getApiUrl = (path) => {
  let baseUrl;
  if (typeof window !== 'undefined') {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      baseUrl = import.meta.env.VITE_LOCAL_API_URL || 'http://localhost:4000';
    } else if (
      window.location.hostname.endsWith('kitaundang.web.id') ||
      window.location.hostname.endsWith('kitaundang.my.id')
    ) {
      baseUrl = 'https://apiter.kitaundang.my.id';
    } else if (
      window.location.hostname.endsWith('netlify.app') ||
      window.location.hostname.endsWith('notha.my.id')
    ) {
      baseUrl = 'https://api-docu.vercel.app';
    } else {
      baseUrl = import.meta.env.VITE_API_URL || 'https://api-docu.vercel.app';
    }
  } else {
    baseUrl = import.meta.env.VITE_API_URL || 'https://api-docu.vercel.app';
  }

  const cleanBase = baseUrl.replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  return `${cleanBase}/${cleanPath}`;
};

// The backend returns user profiles with snake_case keys (full_name,
// owner_id, warehouse_id) from the minimal login/refresh payload, while the
// rest of the app historically reads camelCase (fullName, ownerId,
// warehouseId) from the richer /api/auth/me response. Mirror both forms so
// either shape works regardless of which endpoint produced the session.
export function normalizeUser(user) {
  if (!user || typeof user !== 'object') return user;
  const normalized = {
    ...user,
    fullName: user.fullName ?? user.full_name ?? null,
    full_name: user.full_name ?? user.fullName ?? null,
    ownerId: user.ownerId ?? user.owner_id ?? null,
    owner_id: user.owner_id ?? user.ownerId ?? null,
    warehouseId: user.warehouseId ?? user.warehouse_id ?? null,
    warehouse_id: user.warehouse_id ?? user.warehouseId ?? null,
  };
  if (normalized.role === 'admin') normalized.role = 'staff';
  return normalized;
}

export function getSession() {
  if (typeof window === 'undefined') return { token: null, user: null };
  const token = window.localStorage.getItem('docuflow_access_token');
  const userStr = window.localStorage.getItem('docuflow_user');
  let user = null;
  if (userStr) {
    try {
      user = normalizeUser(JSON.parse(userStr));
    } catch (_) { }
  }
  return { token, user };
}

export function setSession({ token, refreshToken, user }) {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem('docuflow_access_token', token);
  }
  if (refreshToken) {
    window.localStorage.setItem('docuflow_refresh_token', refreshToken);
  }
  if (user) {
    const normalizedUser = normalizeUser(user);
    window.localStorage.setItem('docuflow_user', JSON.stringify(normalizedUser));
  }
  window.dispatchEvent(new Event('docuflow_user_updated'));
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem('docuflow_access_token');
  window.localStorage.removeItem('docuflow_refresh_token');
  window.localStorage.removeItem('docuflow_user');
  window.localStorage.removeItem('docuflow_active_warehouse_id');
  window.dispatchEvent(new Event('docuflow_user_updated'));
}

export function normalizeSerials(raw) {
  if (!raw) return [];
  const isArray = Array.isArray(raw);
  const list = isArray ? raw : [raw];
  const mapped = list.map((s) => {
    if (!s || typeof s !== 'object') return s;
    return {
      ...s,
      productId: s.productId ?? s.product_id,
      serialNumber: s.serialNumber ?? s.serial_number,
      goodsInDocumentId: s.goodsInDocumentId ?? s.goods_in_document_id,
      goodsInItemId: s.goodsInItemId ?? s.goods_in_item_id,
      goodsOutDocumentId: s.goodsOutDocumentId ?? s.goods_out_document_id,
      goodsOutItemId: s.goodsOutItemId ?? s.goods_out_item_id,

      product_id: s.product_id ?? s.productId,
      serial_number: s.serial_number ?? s.serialNumber,
      goods_in_document_id: s.goods_in_document_id ?? s.goodsInDocumentId,
      goods_in_item_id: s.goods_in_item_id ?? s.goodsInItemId,
      goods_out_document_id: s.goods_out_document_id ?? s.goodsOutDocumentId,
      goods_out_item_id: s.goods_out_item_id ?? s.goodsOutItemId,
    };
  });
  return isArray ? mapped : mapped[0];
}

function redirectToLogin() {
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth')) {
    window.location.href = '/auth';
  }
}

async function refreshSession() {
  if (typeof window === 'undefined') return null;
  const refreshToken = window.localStorage.getItem('docuflow_refresh_token');
  if (!refreshToken) {
    clearSession();
    redirectToLogin();
    return null;
  }

  if (!refreshPromise) {
    refreshPromise = fetch(getApiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          clearSession();
          redirectToLogin();
          return null;
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          clearSession();
          redirectToLogin();
          return null;
        }

        // Save the refreshed session info
        const accessToken = data.session?.accessToken;
        const nextRefreshToken = data.session?.refreshToken;
        setSession({
          token: accessToken,
          refreshToken: nextRefreshToken,
          user: data.user
        });
        return accessToken;
      })
      .catch(() => {
        clearSession();
        redirectToLogin();
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function request(path, options = {}) {
  const session = getSession();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (session.token) {
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  const activeWhId = typeof window !== 'undefined' ? window.localStorage.getItem('docuflow_active_warehouse_id') : null;
  if (activeWhId && !headers['X-Warehouse-Id']) {
    headers['X-Warehouse-Id'] = activeWhId;
  }

  let finalPath = path;
  let finalOptions = { ...options };

  if (path.includes('/workspace/contacts')) {
    // 1. Intercept request path (GET)
    if (options.method === 'GET' || !options.method) {
      if (path.includes('type=supplier')) {
        finalPath = path.replace('type=supplier', 'type=customer');
      }
    }

    // 2. Intercept request body (POST/PATCH)
    if ((options.method === 'POST' || options.method === 'PATCH') && options.body) {
      try {
        const bodyObj = JSON.parse(options.body);
        if (bodyObj.type === 'supplier') {
          bodyObj.type = 'customer';
          bodyObj.metadata = {
            ...(bodyObj.metadata || {}),
            tag: 'Supplier',
          };
          finalOptions.body = JSON.stringify(bodyObj);
        } else if (bodyObj.type === 'customer') {
          if (bodyObj.metadata && bodyObj.metadata.tag === 'Supplier') {
            bodyObj.metadata.tag = 'Regular';
          }
          finalOptions.body = JSON.stringify(bodyObj);
        }
      } catch (err) {
        console.error('Failed to parse request body in contacts interceptor:', err);
      }
    }
  }

  const fullUrl = getApiUrl(finalPath);

  const makeCall = async (token) => {
    const finalHeaders = { ...headers };
    if (token) {
      finalHeaders['Authorization'] = `Bearer ${token}`;
    }
    return fetch(fullUrl, {
      ...finalOptions,
      headers: finalHeaders,
    });
  };

  let response = await makeCall(session.token);

  // If 401/403, try refreshing the token once
  if (response.status === 401 || response.status === 403) {
    const newToken = await refreshSession();
    if (newToken) {
      response = await makeCall(newToken);
    }
  }

  // Intercept product-serials to normalize keys automatically
  if (response.ok && path.includes('/workspace/product-serials')) {
    const originalJson = response.json;
    response.json = async function () {
      const data = await originalJson.call(response);
      if (data && data.data) {
        data.data = normalizeSerials(data.data);
      } else if (data && !Array.isArray(data) && typeof data === 'object') {
        data.data = normalizeSerials(data.data);
      }
      return data;
    };
  }

  // Intercept contacts to normalize type and filter in response
  if (response.ok && path.includes('/workspace/contacts')) {
    const originalJson = response.json;
    response.json = async function () {
      const data = await originalJson.call(response);
      if (data) {
        const normalizeContactsList = (list) => {
          if (!Array.isArray(list)) {
            if (list && typeof list === 'object') {
              const isSupplier = list.metadata?.tag === 'Supplier';
              return { ...list, type: isSupplier ? 'supplier' : 'customer' };
            }
            return list;
          }
          let mapped = list.map((c) => {
            if (!c || typeof c !== 'object') return c;
            const isSupplier = c.metadata?.tag === 'Supplier';
            return {
              ...c,
              type: isSupplier ? 'supplier' : 'customer',
            };
          });
          // If the original request path wanted supplier only
          if (path.includes('type=supplier')) {
            mapped = mapped.filter((c) => c.type === 'supplier');
          } else if (path.includes('type=customer')) {
            mapped = mapped.filter((c) => c.type === 'customer');
          }
          return mapped;
        };

        if (data.data) {
          data.data = normalizeContactsList(data.data);
        } else {
          // Response is the direct object or array
          const nextData = normalizeContactsList(data);
          if (Array.isArray(data)) {
            return nextData;
          } else {
            Object.assign(data, nextData);
          }
        }
      }
      return data;
    };
  }

  return response;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

export async function getWorkspaceSettings() {
  const res = await api.get('/api/workspace/settings');
  if (!res.ok) return {};
  const json = await res.json();
  const rawData = json.data ?? json;
  if (Array.isArray(rawData)) {
    const obj = {};
    for (const item of rawData) {
      if (item && item.key) {
        obj[item.key] = item.value;
      }
    }
    if (obj.app) {
      Object.assign(obj, obj.app);
    }
    return obj;
  }
  return rawData ?? {};
}

export function isWorkspaceModuleEnabled(settings, moduleKey, user) {
  const userRole = user?.role?.toLowerCase();

  // Role sales_person: akses hanya ke modul purchase-orders, dashboard, customers, dan contacts.
  // Modul laporan (reports) dan inventaris lainnya diblokir tegas untuk sales.
  if (userRole === 'sales_person') {
    if (moduleKey === 'purchase-orders' || moduleKey === 'dashboard' || moduleKey === 'customers' || moduleKey === 'contacts') return true;
    return false;
  }

  // Modul Laporan selalu diizinkan dan dapat diakses oleh semua akun selain sales_person
  if (moduleKey === 'reports') {
    return true;
  }

  if (userRole === 'super_admin' || userRole === 'owner') {
    return true;
  }

  // Role staff: tidak boleh mengakses modul purchase-orders.
  if (userRole === 'staff' && moduleKey === 'purchase-orders') {
    return false;
  }

  // Check individual staff permissions if specified
  const staffPerms = settings?.staff_permissions?.[user?.id] || settings?.admin_permissions?.[user?.id];
  if (userRole === 'staff' && user?.id && staffPerms) {
    let permKey = moduleKey;
    if (moduleKey === 'goods_in') permKey = 'goodsIn';
    else if (moduleKey === 'goods_out') permKey = 'goodsOut';
    else if (moduleKey === 'customers' || moduleKey === 'suppliers') permKey = 'contacts';
    else if (moduleKey === 'history') permKey = 'auditLog';

    if (staffPerms[permKey] !== undefined) {
      return staffPerms[permKey] === true;
    }
  }

  const modules = settings?.modules_owner || settings?.modules;
  // Untuk modul purchase-orders: jika settings belum ada konfigurasi, default enabled.
  if (!modules && moduleKey === 'purchase-orders') return true;
  if (!modules) return true;

  // Handle nested document types inside documents module
  const docTypes = ['invoice', 'goods_in', 'goods_out', 'delivery_note', 'receipt'];
  if (docTypes.includes(moduleKey)) {
    let docsConfig = null;
    if (Array.isArray(modules)) {
      docsConfig = modules.find((m) => m.id === 'documents');
    } else if (typeof modules === 'object') {
      docsConfig = modules.documents;
    }

    if (!docsConfig || docsConfig.enabled === false) return false;

    // Check nested document type permission
    const typeConfig = docsConfig.documentTypes?.[moduleKey];
    if (!typeConfig) return true; // default allowed if not explicitly set

    const isEnabled = typeConfig.enabled !== false;
    const allowedRoles = typeConfig.roles ?? [];
    const isRoleAllowed = allowedRoles.length === 0 || (userRole && allowedRoles.includes(userRole));
    return isEnabled && isRoleAllowed;
  }

  const settingsKey = {
    customers: 'contacts',
    suppliers: 'contacts',
    products: 'products',
  }[moduleKey] || moduleKey;

  if (Array.isArray(modules)) {
    const match = modules.find((module) => module.id === settingsKey);
    if (!match) return true;
    const isEnabled = match.enabled !== false;
    const allowedRoles = match.roles ?? [];
    const isRoleAllowed = allowedRoles.length === 0 || (userRole && allowedRoles.includes(userRole));
    return isEnabled && isRoleAllowed;
  }

  if (modules && typeof modules === 'object') {
    const config = modules[settingsKey];
    if (!config) return true;
    if (typeof config === 'boolean') return config;

    const isEnabled = config.enabled !== false;
    const allowedRoles = config.roles ?? [];
    const isRoleAllowed = allowedRoles.length === 0 || (userRole && allowedRoles.includes(userRole));
    return isEnabled && isRoleAllowed;
  }

  return true;
}

/**
 * Checks whether the current user is allowed to export products data.
 * - Owner and Super Admin are always allowed.
 * - During development mode (import.meta.env.DEV), regular staff is allowed without owner permission.
 * - In production mode (built / deployed), staff requires owner permission (canExportProducts).
 */
export function canExportProducts(settings, user) {
  const userRole = user?.role?.toLowerCase();
  if (userRole === 'owner' || userRole === 'super_admin') {
    return true;
  }

  // During dev mode (npm run dev), staff is allowed without owner permission
  const isDev = Boolean(import.meta.env.DEV);
  if (isDev && userRole === 'staff') {
    return true;
  }

  // In production / built mode, staff strictly requires owner permission
  const staffPerms = settings?.staff_permissions?.[user?.id] || settings?.admin_permissions?.[user?.id];
  if (staffPerms?.canExportProducts !== undefined) {
    return staffPerms.canExportProducts === true;
  }

  const defaultModules = settings?.modules_owner || settings?.modules;
  return defaultModules?.products?.canExportProducts === true;
}

export const DEFAULT_RULES = [
  { type: 'invoice', prefix: 'NOTA', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'sample', prefix: 'SMP', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'receipt', prefix: 'KWI', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'goods_in', prefix: 'WH/IN', format: '{PREFIX}/{YYYY}{MM}{DD}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'goods_out', prefix: 'WH/OUT', format: '{PREFIX}/{YYYY}{MM}{DD}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'delivery_note', prefix: 'SJ', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
  { type: 'purchase_order', prefix: 'PO', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', seqLength: 4, seqReset: 'monthly', separator: '/', leadingZero: true },
];

function parseYMD(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const clean = val.slice(0, 10);
    const parts = clean.split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
        return { y, m, d };
      }
    }
  }
  const dt = new Date(val);
  if (isNaN(dt.getTime())) return null;
  return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
}

export function countDocsForSeqReset(docs, rule, dateStr) {
  if (!rule || !docs || !Array.isArray(docs)) return 0;
  const target = parseYMD(dateStr) || parseYMD(new Date());
  if (!target) return 0;

  const matchingDocs = docs.filter((doc) => {
    if (doc.document_type !== rule.type && doc.type !== rule.type) return false;
    const docDateVal = doc.issue_date || doc.issueDate || doc.created_at || doc.createdAt;
    if (!docDateVal) return false;
    const docParsed = parseYMD(docDateVal);
    if (!docParsed) return false;

    if (rule.seqReset === 'daily') {
      return docParsed.y === target.y && docParsed.m === target.m && docParsed.d === target.d;
    } else if (rule.seqReset === 'monthly') {
      return docParsed.y === target.y && docParsed.m === target.m;
    } else if (rule.seqReset === 'yearly') {
      return docParsed.y === target.y;
    }
    // 'never'
    return true;
  });

  // Extract the maximum existing sequence number from document numbers
  const seqLen = rule.seqLength || 4;
  let maxSeq = 0;
  for (const doc of matchingDocs) {
    const docNum = String(doc.document_number || doc.number || doc.documentNumber || '').trim();
    if (!docNum || docNum.includes('e+') || docNum.includes('NaN')) continue;

    const match = docNum.match(/(\d+)\s*$/);
    if (match) {
      const digits = match[1];
      // If trailing digits are longer than configured sequence length (e.g. date + seq: 202610200028),
      // take only the trailing seqLen digits (0028 -> 28)
      const trailing = digits.length > seqLen ? digits.slice(-seqLen) : digits;
      const val = parseInt(trailing, 10);
      if (!isNaN(val) && val < 100000 && val > maxSeq) {
        maxSeq = val;
      }
    }
  }

  return Math.max(maxSeq, matchingDocs.length);
}

export function buildDocumentNumber(docType, dateStr, existingDocsCount, settings) {
  const rawRules = settings?.numbering;
  const rules = rawRules?.rules || (Array.isArray(rawRules) ? rawRules : DEFAULT_RULES);
  const rule = rules.find((r) => r.type === docType) || DEFAULT_RULES.find((r) => r.type === docType);
  if (!rule) return '';

  const date = dateStr ? new Date(dateStr) : new Date();
  const yyyy = String(date.getFullYear());
  const yy = yyyy.slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  const seqLen = rule.seqLength || 4;
  const seqNum = existingDocsCount + 1;
  const seq = rule.leadingZero !== false ? String(seqNum).padStart(seqLen, '0') : String(seqNum);

  let formatted = rule.format || '{PREFIX}/{YYYY}{MM}/{SEQ}';
  formatted = formatted
    .replace(/{PREFIX}/g, rule.prefix || '')
    .replace(/{YYYY}/g, yyyy)
    .replace(/{YY}/g, yy)
    .replace(/{MM}/g, mm)
    .replace(/{DD}/g, dd)
    .replace(/{SEQ}/g, seq)
    .replace(/{BRANCH}/g, 'HO')
    .replace(/{WAREHOUSE}/g, 'WH1');

  return formatted;
}

export async function getWarehouses() {
  const res = await request('/api/workspace/warehouses');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Failed to fetch warehouses');
  }
  return res.json();
}

export async function createWarehouse(payload) {
  const res = await request('/api/workspace/warehouses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Failed to create warehouse');
  }
  return res.json();
}

export async function updateWarehouse(id, payload) {
  const res = await request(`/api/workspace/warehouses/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Failed to update warehouse');
  }
  return res.json();
}

export async function archiveWarehouse(id) {
  const res = await request(`/api/workspace/warehouses/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Failed to archive warehouse');
  }
  return res.json();
}

// ── Inventory Bagian / Area Gudang & Stock Opname ────────────────────────────

export async function getInventoryAreas(includeArchived = false) {
  const res = await api.get(`/api/workspace/inventory/areas${includeArchived ? '?includeArchived=true' : ''}`);
  if (!res.ok) throw new Error('Gagal memuat daftar bagian gudang');
  return res.json();
}

export async function createInventoryArea(payload) {
  const res = await api.post('/api/workspace/inventory/areas', payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menambahkan bagian gudang');
  }
  return res.json();
}

export async function updateInventoryArea(id, payload) {
  const res = await api.patch(`/api/workspace/inventory/areas/${id}`, payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal memperbarui bagian gudang');
  }
  return res.json();
}

export async function setInventoryAreaStatus(id, status) {
  const res = await api.patch(`/api/workspace/inventory/areas/${id}/status`, { status });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal mengubah status bagian gudang');
  }
  return res.json();
}

export async function deleteInventoryArea(id) {
  const res = await api.delete(`/api/workspace/inventory/areas/${id}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menonaktifkan bagian gudang');
  }
  return res.json();
}

export async function seedSampleInventoryAreas() {
  const res = await api.post('/api/workspace/inventory/areas/seed-samples', {});
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal memuat data awal bagian');
  }
  return res.json();
}

export async function getStockOpnameSessions() {
  const res = await api.get('/api/workspace/inventory/stock-opname/sessions');
  if (!res.ok) throw new Error('Gagal memuat riwayat sesi Stock Opname');
  return res.json();
}

export async function createStockOpnameSession(payload) {
  const res = await api.post('/api/workspace/inventory/stock-opname/sessions', payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal membuat sesi Stock Opname baru');
  }
  return res.json();
}

export async function getStockOpnameSessionDetail(id) {
  const res = await api.get(`/api/workspace/inventory/stock-opname/sessions/${id}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal memuat detail sesi Stock Opname');
  }
  return res.json();
}

export async function saveAreaPhysicalCount(sessionId, payload) {
  const res = await request(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/area-count`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menyimpan hasil hitungan fisik');
  }
  return res.json();
}

export async function addUnlistedPhysicalItem(sessionId, payload) {
  const res = await api.post(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/add-unlisted-item`, payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal mencatat temuan fisik');
  }
  return res.json();
}

export async function finalizeStockOpnameSession(sessionId, payload) {
  const res = await api.post(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/finalize`, payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error?.message || 'Gagal memfinalisasi sesi Stock Opname');
    error.data = err.error;
    throw error;
  }
  return res.json();
}

export async function addAreaToStockOpnameSession(sessionId, payload) {
  const res = await api.post(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/areas`, payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menambahkan bagian ke sesi Stock Opname');
  }
  return res.json();
}

export async function deleteAreaFromStockOpnameSession(sessionId, areaId) {
  const res = await api.delete(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/areas/${areaId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menghapus bagian dari sesi');
  }
  return res.json();
}

export async function deleteStockOpnameSession(sessionId) {
  const res = await api.delete(`/api/workspace/inventory/stock-opname/sessions/${sessionId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menghapus sesi Stock Opname');
  }
  return res.json();
}

export async function syncStockOpnameSessionBaseline(sessionId, payload) {
  const res = await api.post(`/api/workspace/inventory/stock-opname/sessions/${sessionId}/sync-baseline`, payload);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gagal menyinkronkan baseline produk sesi');
  }
  return res.json();
}

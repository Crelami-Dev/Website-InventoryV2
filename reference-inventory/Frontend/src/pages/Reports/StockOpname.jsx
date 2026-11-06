import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Eye,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  FileSpreadsheet,
  RotateCcw,
  Layers,
  MapPin,
  Calendar,
  Search,
  Check,
  X,
  Edit2,
  Trash2,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  Package,
  Boxes,
  Sparkles,
  Download,
  Upload,
  Loader2,
  Camera,
  Barcode,
  QrCode,
  ChevronDown,
  ChevronUp,
  FileText,
  ArrowUpRight,
  ArrowDownRight,
  Tag,
  Lock,
  Unlock,
  ArrowDownToLine,
  Clock,
  Printer,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useUnits } from '../../hooks/useUnits.js';
import { useCameraScanner } from '../../hooks/useCameraScanner.js';
import {
  getInventoryAreas,
  createInventoryArea,
  updateInventoryArea,
  setInventoryAreaStatus,
  deleteInventoryArea,
  seedSampleInventoryAreas,
  getStockOpnameSessions,
  createStockOpnameSession,
  getStockOpnameSessionDetail,
  saveAreaPhysicalCount,
  addUnlistedPhysicalItem,
  addAreaToStockOpnameSession,
  deleteAreaFromStockOpnameSession,
  finalizeStockOpnameSession,
  deleteStockOpnameSession,
  syncStockOpnameSessionBaseline,
  getWorkspaceSettings,
  buildDocumentNumber,
  api,
} from '../../utils/api.js';
import { ConfirmModal } from '../../components/ConfirmModal/ConfirmModal.jsx';
import WriteOffMissingModal from './WriteOffMissingModal.jsx';
import './StockOpname.css';

// Global Web Audio Context singleton with auto-unlock
let globalAudioCtx = null;

function getAudioContext() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!globalAudioCtx) {
      globalAudioCtx = new AudioCtx();
    }
    if (globalAudioCtx.state === 'suspended') {
      globalAudioCtx.resume().catch(() => {});
    }
    return globalAudioCtx;
  } catch (_) {
    return null;
  }
}

// Ensure audio context unlocks on first user tap/click
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    getAudioContext();
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
}

// Audio synthesis helper for warehouse scan feedback (Success chime / Duplicate alert / Failure buzzer)
function playBeep(type = 'success') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (type === 'success') {
      // ✅ SUCCESS: High bright chime (880Hz -> 1175Hz)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1175, now + 0.06);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      osc.start(now);
      osc.stop(now + 0.16);

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(50);
      }
    } else if (type === 'warning' || type === 'duplicate') {
      // ⚠️ DUPLICATE / WARNING: Distinct double-beep alert (520Hz tone pulses twice)
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      const gain2 = ctx.createGain();

      osc1.type = 'triangle';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(520, now);
      osc2.frequency.setValueAtTime(420, now + 0.12);

      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);

      gain1.gain.setValueAtTime(0.35, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

      gain2.gain.setValueAtTime(0.35, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

      osc1.start(now);
      osc1.stop(now + 0.1);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.24);

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 60, 100]);
      }
    } else {
      // ❌ ERROR / GAGAL: Loud warehouse double-buzzer ("BZZT-BZZT!")
      // Sawtooth wave for unmistakable failure feedback (160Hz -> 100Hz)
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      const gain2 = ctx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      osc1.frequency.setValueAtTime(160, now);
      osc1.frequency.linearRampToValueAtTime(120, now + 0.14);

      osc2.frequency.setValueAtTime(140, now + 0.17);
      osc2.frequency.linearRampToValueAtTime(100, now + 0.33);

      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);

      gain1.gain.setValueAtTime(0.4, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

      gain2.gain.setValueAtTime(0.4, now + 0.17);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.33);

      osc1.start(now);
      osc1.stop(now + 0.14);
      osc2.start(now + 0.17);
      osc2.stop(now + 0.33);

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([200, 80, 200]);
      }
    }
  } catch (_) {}
}

let _cachedProductsArray = null;
let _cachedSortedProds = [];

function getSortedProducts(products) {
  if (products === _cachedProductsArray && _cachedSortedProds.length === (products?.length || 0)) {
    return _cachedSortedProds;
  }
  _cachedProductsArray = products;
  _cachedSortedProds = Array.isArray(products)
    ? [...products].sort((a, b) => String(b.sku || '').length - String(a.sku || '').length)
    : [];
  return _cachedSortedProds;
}

// Deteksi produk dan satuan dari string nomor seri (mendukung satuan kustom database, isolasi gudang & rule AGENTS.md)
function detectSerialInfo(rawSerial, products = [], customUnits = [], getMultiplier = () => 1) {
  if (!rawSerial) return null;
  const clean = String(rawSerial).trim();
  const cleanLower = clean.toLowerCase();

  // Valid units untuk gudang aktif saat ini
  const allowedKeys = new Set((customUnits || []).map((u) => String(u.key).toLowerCase().trim()));

  // 1. Deteksi unit dari string nomor seri (prioritaskan penanda spesifik rule AGENTS.md & variasi awalan/akhiran)
  let detectedUnit = null;

  // Bal 25 checks (bl25 / 25bl / bal25)
  if (cleanLower.includes('bl25') || cleanLower.includes('25bl') || cleanLower.includes('bal25') || cleanLower.includes('25bal')) {
    detectedUnit = 'bal25';
  }
  // Bal 20 checks (bl20 / 20bl / bal20)
  else if (cleanLower.includes('bl20') || cleanLower.includes('20bl') || cleanLower.includes('bal20') || cleanLower.includes('20bal')) {
    detectedUnit = 'bal20';
  }
  // Bal 15 checks (bl15 / 15bl / bal15)
  else if (cleanLower.includes('bl15') || cleanLower.includes('15bl') || cleanLower.includes('bal15') || cleanLower.includes('15bal')) {
    detectedUnit = 'bal15';
  }
  // Bal 10 checks (bl10 / 10bl / bal10)
  else if (cleanLower.includes('bl10') || cleanLower.includes('10bl') || cleanLower.includes('bal10') || cleanLower.includes('10bal')) {
    detectedUnit = 'bal10';
  }
  // Bal 5 checks (bl5 / 5bl / bal5)
  else if (cleanLower.includes('bl5') || cleanLower.includes('5bl') || cleanLower.includes('bal5') || cleanLower.includes('5bal')) {
    detectedUnit = 'bal5';
  }
  // Pack checks
  else if (cleanLower.includes('pack6') || cleanLower.includes('pk6') || cleanLower.includes('6pk')) {
    detectedUnit = 'pack6';
  }
  else if (cleanLower.includes('pack3') || cleanLower.includes('pk3') || cleanLower.includes('3pk')) {
    detectedUnit = 'pack3';
  }
  else if (cleanLower.includes('pack5') || cleanLower.includes('pk5') || cleanLower.includes('5pk')) {
    detectedUnit = 'pack';
  }
  // Lusin checks (termasuk penanda -ls- atau _ls_)
  else if (
    cleanLower.includes('lusin') ||
    cleanLower.includes('doz') ||
    cleanLower.includes('-ls-') ||
    cleanLower.includes('_ls_') ||
    cleanLower.endsWith('-ls') ||
    cleanLower.endsWith('_ls')
  ) {
    detectedUnit = 'lusin';
  }
  // Fallback Bal / Bl umum ke bal25 per Rule 1 AGENTS.md
  else if (cleanLower.includes('bal') || cleanLower.includes('bl')) {
    detectedUnit = 'bal25';
  }
  // Fallback Pack / Pk umum
  else if (cleanLower.includes('pack') || cleanLower.includes('pk')) {
    detectedUnit = 'pack';
  }

  // Jika belum cocok dengan rule di atas, periksa customUnits dari database
  if (!detectedUnit) {
    const sortedUnits = [...customUnits].sort((a, b) => String(b.key || '').length - String(a.key || '').length);
    for (const u of sortedUnits) {
      const k = String(u.key || '').toLowerCase().trim();
      if (!k || k === 'pcs' || k === 'piece') continue;
      if (cleanLower.includes(k)) {
        detectedUnit = k;
        break;
      }
    }
  }

  if (!detectedUnit) {
    detectedUnit = 'pcs';
  }

  // ── FILTER KETAT KE SATUAN GUDANG AKTIF (WAREHOUSE SCOPING) ──
  // Satuan yang dipakai WAJIB ada di Inventory Units Settings gudang aktif
  if (allowedKeys.size > 0 && !allowedKeys.has(detectedUnit)) {
    if ((detectedUnit === 'pack3' || detectedUnit === 'pack6' || detectedUnit === 'pack5') && allowedKeys.has('pack')) {
      // Gudang Utama hanya memiliki satuan 'pack' (5 lusin / 60 pcs), bukan pack3 milik online
      detectedUnit = 'pack';
    } else if (detectedUnit === 'bal5' && allowedKeys.has('pack')) {
      detectedUnit = 'pack';
    } else if (detectedUnit === 'bal' && allowedKeys.has('bal25')) {
      detectedUnit = 'bal25';
    } else if (detectedUnit === 'bal25' && allowedKeys.has('bal')) {
      detectedUnit = 'bal';
    } else if (detectedUnit.startsWith('bal') && allowedKeys.has('bal25')) {
      detectedUnit = 'bal25';
    } else {
      detectedUnit = 'pcs';
    }
  }

  let unitObj = customUnits.find((u) => u.key && u.key.toLowerCase().trim() === detectedUnit);
  const multiplier = Number(getMultiplier(detectedUnit)) || (detectedUnit === 'bal25' || detectedUnit === 'bal' ? 300 : detectedUnit === 'pack' ? 60 : detectedUnit === 'pack6' ? 6 : detectedUnit === 'pack3' ? 3 : 1);

  // 2. Deteksi produk berdasarkan SKU
  let matchedProduct = null;
  const cleanSerialNormalized = cleanLower.replace(/[^a-z0-9]/g, '');
  const sortedProds = getSortedProducts(products);

  for (const p of sortedProds) {
    if (!p.sku) continue;
    const pSkuLower = p.sku.toLowerCase();
    const pSkuNormalized = pSkuLower.replace(/[^a-z0-9]/g, '');

    // Cek prefix dengan delimiter (- atau _) atau awalan langsung
    if (cleanLower.startsWith(pSkuLower + '-') || cleanLower.startsWith(pSkuLower + '_') || cleanLower.startsWith(pSkuLower)) {
      matchedProduct = p;
      break;
    }
    // Cek normalized prefix (misal BBTH125 vs BBTH-125 atau BBYT-125 vs BBYT125)
    if (pSkuNormalized && cleanSerialNormalized.startsWith(pSkuNormalized)) {
      matchedProduct = p;
      break;
    }
  }

  if (!matchedProduct) {
    for (const p of sortedProds) {
      if (!p.sku) continue;
      const pSkuLower = p.sku.toLowerCase();
      if (cleanLower.includes(pSkuLower)) {
        matchedProduct = p;
        break;
      }
    }
  }

  return {
    serialNumber: clean,
    detectedUnit,
    unitName: unitObj?.name || detectedUnit,
    multiplier,
    matchedProduct,
  };
}

export default function StockOpname({ products = [], documents = [] }) {
  const { t, activeWarehouse, activeWarehouseId } = useApp();
  const queryClient = useQueryClient();
  const { units: customUnits, multipliers, getMultiplier, formatUnitOption, formatDocumentQty } = useUnits();

  // Settings for document numbering
  const { data: settings } = useQuery({
    queryKey: ['workspace-settings', activeWarehouseId || 'default'],
    queryFn: getWorkspaceSettings,
    staleTime: 60000,
  });

  // Query fallback for workspace documents to link Goods In & Goods Out
  const { data: queriedDocuments = [] } = useQuery({
    queryKey: ['workspace-documents', activeWarehouseId || 'all'],
    queryFn: async () => {
      const whParam = activeWarehouseId ? `?warehouse_id=${encodeURIComponent(activeWarehouseId)}` : '';
      const res = await api.get(`/api/workspace/documents${whParam}`);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      return Array.isArray(json?.data) ? json.data : [];
    },
    staleTime: 30000,
  });

  const allWorkspaceDocs = useMemo(() => {
    return Array.isArray(documents) && documents.length > 0 ? documents : (queriedDocuments || []);
  }, [documents, queriedDocuments]);

  // State pelacakan penyelesaian barang bermasalah & dokumen penyesuaian yang baru dibuat
  const [resolvedDiscrepancyIds, setResolvedDiscrepancyIds] = useState(() => new Set());
  const [discrepancyFilterMode, setDiscrepancyFilterMode] = useState('unresolved'); // 'unresolved' | 'resolved' | 'all'
  const [createdDocBySku, setCreatedDocBySku] = useState({}); // sku/productId -> doc tracking info

  // Serial Number Index for this warehouse (all statuses to reconcile with SO findings)
  const { data: serialIndexResponse, refetch: refetchSerialIndex } = useQuery({
    queryKey: ['product-serial-index', activeWarehouseId || 'all'],
    queryFn: async () => {
      const whParam = activeWarehouseId ? `&warehouse_id=${encodeURIComponent(activeWarehouseId)}` : '&warehouse_id=all';
      const res = await api.get(`/api/workspace/product-serial-index?allStatus=true&purpose=stock_opname${whParam}`);
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      return Array.isArray(json.data) ? json.data : [];
    },
    staleTime: 60 * 1000, // 60 detik fresh di cache (mencegah refetch berat saat scanning)
    refetchOnWindowFocus: false,
  });

  // Fast In-Memory Lookup Map: serial (lowercase & normalized) -> { serialNumber, productId, unit, status, warehouseId, goodsInDocId, createdAt }
  const serialIndexLookupMap = useMemo(() => {
    const map = new Map();
    (serialIndexResponse || []).forEach((row) => {
      const [sn, pId, unit, status, whId, goodsInDocId, createdAt] = row;
      if (!sn) return;
      if (activeWarehouseId && whId && String(whId) !== String(activeWarehouseId)) {
        return;
      }
      const cleanSn = String(sn).trim();
      const lower = cleanSn.toLowerCase();
      const entry = {
        serialNumber: cleanSn,
        productId: pId || null,
        unit: unit || null,
        status: status || 'available',
        warehouseId: whId || null,
        goodsInDocId: goodsInDocId || null,
        createdAt: createdAt || null,
      };
      map.set(lower, entry);
      const norm = lower.replace(/[^a-z0-9]/g, '');
      if (norm && norm !== lower) {
        map.set(norm, entry);
      }
      // Pemetaan variasi barcode tanpa tanda strip / kode unit (contoh: HGET110-PK5-2707260007 -> hget1102707260007)
      const parts = cleanSn.split('-');
      if (parts.length >= 3) {
        const withoutUnit = (parts[0] + parts.slice(2).join('')).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (withoutUnit && !map.has(withoutUnit)) {
          map.set(withoutUnit, entry);
        }
      }
    });
    return map;
  }, [serialIndexResponse, activeWarehouseId]);

  // Fast Product Lookups by ID and SKU for 0ms in-memory resolution
  const productsById = useMemo(() => {
    const map = new Map();
    (products || []).forEach((p) => {
      if (p.id) map.set(p.id, p);
    });
    return map;
  }, [products]);

  const productsBySku = useMemo(() => {
    const map = new Map();
    (products || []).forEach((p) => {
      if (p.sku) map.set(String(p.sku).trim().toLowerCase(), p);
    });
    return map;
  }, [products]);

  // Map: productId -> array of { serialNumber, unit, status, warehouseId, goodsInDocId, createdAt }
  const productSerialsMap = useMemo(() => {
    const map = new Map();
    (serialIndexResponse || []).forEach((row) => {
      const [sn, pId, unit, status, whId, goodsInDocId, createdAt] = row;
      if (!pId) return;
      if (activeWarehouseId && whId && String(whId) !== String(activeWarehouseId)) {
        return;
      }
      if (!map.has(pId)) map.set(pId, []);
      map.get(pId).push({
        serialNumber: sn,
        unit,
        status,
        warehouseId: whId,
        goodsInDocId,
        createdAt,
      });
    });
    return map;
  }, [serialIndexResponse, activeWarehouseId]);

  // Map: product SKU (uppercase) -> array of { serialNumber, unit, status, warehouseId, goodsInDocId, createdAt, productId }
  // Menjaga agar pencarian serial per SKU benar-benar berasal dari produk yang sama, BUKAN substring collision
  const productSerialsBySkuMap = useMemo(() => {
    const map = new Map();
    const idToSku = new Map();
    (products || []).forEach((p) => {
      if (p.id && p.sku) idToSku.set(p.id, String(p.sku).trim().toUpperCase());
    });
    (serialIndexResponse || []).forEach((row) => {
      const [sn, pId, unit, status, whId, goodsInDocId, createdAt] = row;
      if (!sn || !pId) return;
      if (activeWarehouseId && whId && String(whId) !== String(activeWarehouseId)) {
        return;
      }
      const sku = idToSku.get(pId);
      if (sku) {
        if (!map.has(sku)) map.set(sku, []);
        map.get(sku).push({
          serialNumber: sn,
          unit,
          status,
          warehouseId: whId,
          goodsInDocId,
          createdAt,
          productId: pId,
        });
      }
    });
    return map;
  }, [serialIndexResponse, products, activeWarehouseId]);

  // Helper untuk mendapatkan seluruh nomor seri terdaftar yang sah untuk sebuah produk (bebas dari substring collision)
  const getRegisteredSerialsForProduct = (pId, sku) => {
    if (pId && productSerialsMap.has(pId)) {
      return productSerialsMap.get(pId) || [];
    }
    const skuKey = String(sku || '').trim().toUpperCase();
    if (skuKey && productSerialsBySkuMap.has(skuKey)) {
      return productSerialsBySkuMap.get(skuKey) || [];
    }
    return [];
  };

  // Map: serial (lowercase) -> unit key, dari database serial gudang
  const serialUnitMap = useMemo(() => {
    const map = new Map();
    (serialIndexResponse || []).forEach(([sn, , unit]) => {
      if (sn && unit) map.set(String(sn).toLowerCase(), String(unit).toLowerCase());
    });
    return map;
  }, [serialIndexResponse]);

  // Satuan sebuah serial: prioritas data item sesi > data asli DB / Goods In > deteksi spesifik nomor seri (terikat unit gudang aktif)
  const getSerialUnit = (item, sn) => {
    if (!sn) return 'pcs';
    const cleanLower = String(sn).trim().toLowerCase();
    const allowedKeys = new Set((customUnits || []).map((u) => String(u.key).toLowerCase().trim()));

    // 1. Cek unit yang tersimpan di state item sesi saat scan
    if (item?.serialUnits?.[cleanLower]) {
      const u = String(item.serialUnits[cleanLower]).toLowerCase().trim();
      if (allowedKeys.size === 0 || allowedKeys.has(u)) return u;
      if ((u === 'pack3' || u === 'pack6' || u === 'pack5') && allowedKeys.has('pack')) return 'pack';
      if (u === 'bal' && allowedKeys.has('bal25')) return 'bal25';
    }
    if (item?.serialUnits?.[sn]) {
      const u = String(item.serialUnits[sn]).toLowerCase().trim();
      if (allowedKeys.size === 0 || allowedKeys.has(u)) return u;
      if ((u === 'pack3' || u === 'pack6' || u === 'pack5') && allowedKeys.has('pack')) return 'pack';
      if (u === 'bal' && allowedKeys.has('bal25')) return 'bal25';
    }

    // 2. Cek unit resmi dari database inventaris (product_serials / Goods In)
    const dbUnitRaw = serialIndexLookupMap.get(cleanLower)?.unit || serialUnitMap.get(cleanLower);
    if (dbUnitRaw) {
      const dbUnit = String(dbUnitRaw).toLowerCase().trim();
      if (allowedKeys.size === 0 || allowedKeys.has(dbUnit)) {
        return dbUnit;
      }
      // Normalisasi jika unit di DB tidak ada di gudang ini (misal typo pack3 padahal gudang aktif hanya punya pack)
      if ((dbUnit === 'pack3' || dbUnit === 'pack6' || dbUnit === 'pack5') && allowedKeys.has('pack')) {
        return 'pack';
      }
      if (dbUnit === 'bal' && allowedKeys.has('bal25')) {
        return 'bal25';
      }
    }

    // 3. Fallback: deteksi dari pattern nomor seri (sudah disaring oleh allowedKeys gudang aktif di detectSerialInfo)
    const snDetected = detectSerialInfo(sn, products, customUnits, getMultiplier)?.detectedUnit;
    if (snDetected && (allowedKeys.size === 0 || allowedKeys.has(snDetected))) {
      return snDetected;
    }

    // 4. Fallback ke unit produk katalog jika sah di gudang ini, atau pcs
    const prodUnit = item?.unit || 'pcs';
    if (allowedKeys.has(prodUnit)) return prodUnit;
    return 'pcs';
  };

  // Rincian serial per satuan: [{ unit, count, multiplier }]
  const getSerialGroups = (item) => {
    const groups = new Map();
    (item?.scannedSerials || []).forEach((sn) => {
      const u = getSerialUnit(item, sn);
      groups.set(u, (groups.get(u) || 0) + 1);
    });
    return Array.from(groups.entries()).map(([unit, count]) => ({
      unit,
      count,
      multiplier: Number(getMultiplier(unit)) || 1,
    }));
  };

  // Jumlah fisik dalam pcs (null jika belum diisi sama sekali)
  const computeItemPcs = (item) => {
    const hasSerials = Array.isArray(item?.scannedSerials) && item.scannedSerials.length > 0;
    const serialPcs = hasSerials
      ? getSerialGroups(item).reduce((acc, g) => acc + g.count * g.multiplier, 0)
      : 0;

    let totalManualPcs = 0;
    let hasAnyManualInput = false;

    // Jika produk ber-seri dan sudah memiliki nomor seri yang di-scan,
    // jangan pernah fallback ke manualQty/inputVal dan abaikan entri m_legacy_ / m_init_
    let entries = [];
    if (Array.isArray(item?.manualEntries) && item.manualEntries.length > 0) {
      entries = hasSerials
        ? item.manualEntries.filter((e) => !String(e.id || '').startsWith('m_legacy_') && !String(e.id || '').startsWith('m_init_'))
        : item.manualEntries;
    } else if (!hasSerials) {
      if (item?.manualQty !== undefined && item?.manualQty !== null && String(item?.manualQty).trim() !== '') {
        entries = [{ qty: item.manualQty, unit: item.manualUnit || item.inputUnit || 'pcs' }];
      } else if (item?.inputVal !== undefined && item?.inputVal !== null && String(item?.inputVal).trim() !== '') {
        entries = [{ qty: item.inputVal, unit: item.inputUnit || 'pcs' }];
      }
    }

    entries.forEach((entry) => {
      const rawQty = String(entry?.qty ?? '').trim();
      if (rawQty !== '' && !isNaN(Number(rawQty)) && Number(rawQty) > 0) {
        hasAnyManualInput = true;
        const mult = Number(getMultiplier(entry.unit || 'pcs')) || 1;
        totalManualPcs += Number(rawQty) * mult;
      }
    });

    if (!hasSerials && !hasAnyManualInput) return null;
    return serialPcs + totalManualPcs;
  };

  // Format jumlah (selalu dalam pcs dasar) + rincian lusin/pcs agar mudah dibaca
  const renderQty = (value, { signed = false } = {}) => {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
    const breakdown = abs >= 12 ? formatDocumentQty(Math.floor(abs / 12), abs % 12) : null;
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'inherit', lineHeight: 1.25 }}>
        <span>{sign}{abs.toLocaleString('id-ID')} pcs</span>
        {breakdown && (
          <small style={{ fontSize: '10px', fontWeight: 500, color: 'var(--color-text-muted)' }}>
            ({sign}{breakdown})
          </small>
        )}
      </span>
    );
  };

  // Rincian serial per satuan, contoh: "2 pack3 + 1 lusin"
  const formatSerialBreakdown = (serials) => {
    const groups = new Map();
    (serials || []).forEach((sn) => {
      const u = getSerialUnit(null, sn);
      groups.set(u, (groups.get(u) || 0) + 1);
    });
    return Array.from(groups.entries()).map(([u, c]) => `${c} ${u}`).join(' + ');
  };

  // Active View State
  // 'list' (Daftar sesi SO) | 'session_detail' (Sesi SO yang sedang dibuka)
  const [currentView, setCurrentView] = useState('list');
  const [selectedSessionId, setSelectedSessionId] = useState(null);

  // Subtab dalam sesi detail: 'areas' | 'warehouse_total' | 'by_product' | 'discrepancies'
  const [sessionSubTab, setSessionSubTab] = useState('areas');

  // Active Area Checking Modal
  const [checkingArea, setCheckingArea] = useState(null);
  const [checkingItems, setCheckingItems] = useState([]);
  const [checkingSearch, setCheckingSearch] = useState('');
  const [isEditingCompletedArea, setIsEditingCompletedArea] = useState(false);
  const [isImportingGoodsIn, setIsImportingGoodsIn] = useState(false);

  // Barcode / Camera scanning states inside checkingArea
  const [barcodeInput, setBarcodeInput] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [scanNotification, setScanNotification] = useState(null);
  const scanCooldownMap = React.useRef(new Map());

  // High-Speed Barcode Gun Queue System & Live Progress Feed
  const [scanQueue, setScanQueue] = useState([]); // Array of { id, code, source, enqueuedAt }
  const [activeScanItem, setActiveScanItem] = useState(null); // { id, code, step, startedAt }
  const [recentScanFeed, setRecentScanFeed] = useState([]); // Array of { id, code, status, title, detail, time }
  const isProcessingScanQueueRef = useRef(false);
  const barcodeInputRef = useRef(null);
  const scannedSerialsInCurrentAreaRef = useRef(new Set());
  const scannedSerialsInCurrentAreaMapRef = useRef(new Map()); // Map: cleanSerial -> { itemId, name, sku } untuk lookup O(1)
  const [expandedSerialGroups, setExpandedSerialGroups] = useState({}); // State expand/collapse per group serial chip
  const [expandedLocationSerials, setExpandedLocationSerials] = useState({}); // State expand/collapse per location scanned serial numbers in Tab 2

  // Expandable discrepancy state in Tab 3
  const [expandedDiscrepancySku, setExpandedDiscrepancySku] = useState(null);

  // Document generation state in Tab 3 & 4
  const [isGeneratingDoc, setIsGeneratingDoc] = useState(false);
  const [generatedDocNotice, setGeneratedDocNotice] = useState(null);

  // Modals
  const [showCreateSessionModal, setShowCreateSessionModal] = useState(false);
  const [showAddUnlistedModal, setShowAddUnlistedModal] = useState(false);
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [showWriteOffMissingModal, setShowWriteOffMissingModal] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);

  // Busy / Loading states to prevent duplicate clicks and show feedback
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSavingArea, setIsSavingArea] = useState(false);
  const [isSavingCount, setIsSavingCount] = useState(false);
  const [savingCountAction, setSavingCountAction] = useState(null); // 'draft' | 'complete'
  const [isAddingUnlisted, setIsAddingUnlisted] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);

  // Form states
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionNotes, setNewSessionNotes] = useState('');

  // Add Area inside active SO Session State
  const [showAddSessionAreaModal, setShowAddSessionAreaModal] = useState(false);
  const [sessionAreaName, setSessionAreaName] = useState('');
  const [sessionAreaDesc, setSessionAreaDesc] = useState('');
  const [sessionAreaItems, setSessionAreaItems] = useState([]);
  const [productSearchForSessionArea, setProductSearchForSessionArea] = useState('');
  const [selectedProductForSessionArea, setSelectedProductForSessionArea] = useState(null);
  const [qtyForSessionAreaProduct, setQtyForSessionAreaProduct] = useState(1);

  // Quick Inline Add Product inside checkingArea Modal
  const [inlineAddSearch, setInlineAddSearch] = useState('');
  const [inlineSelectedProduct, setInlineSelectedProduct] = useState(null);
  const [inlinePhysicalQty, setInlinePhysicalQty] = useState('');
  const [inlineUnit, setInlineUnit] = useState('pcs');

  // Unlisted Item Modal State
  const [unlistedSearch, setUnlistedSearch] = useState('');
  const [selectedUnlistedProduct, setSelectedUnlistedProduct] = useState(null);
  const [unlistedSystemQty, setUnlistedSystemQty] = useState(0);
  const [unlistedPhysicalQty, setUnlistedPhysicalQty] = useState(1);
  const [unlistedNotes, setUnlistedNotes] = useState('');

  // Finalize Options
  const [applyAdjustment, setApplyAdjustment] = useState(true);
  const [finalizeNotes, setFinalizeNotes] = useState('');

  // Search in Lists
  const [sessionSearch, setSessionSearch] = useState('');
  const [discrepancySearch, setDiscrepancySearch] = useState('');
  const [productSummarySearch, setProductSummarySearch] = useState('');
  const [showZeroStock, setShowZeroStock] = useState(false);

  // Camera scanner hook for checkingArea modal (upgraded with native BarcodeDetector, high-res & torch)
  const { cameraActive, hasTorch, isTorchOn, toggleTorch } = useCameraScanner({
    elementId: 'so-camera-reader',
    active: isCameraActive && Boolean(checkingArea),
    fps: 15,
    onDecode: (code) => {
      if (code) handleEnqueueBarcode(code, { source: 'camera' });
    },
    onError: (err) => {
      alert(err || 'Gagal mengakses kamera scanner');
      setIsCameraActive(false);
    },
  });

  // 1. Fetch Master Bagian / Area Gudang
  const {
    data: areasResponse,
    isLoading: loadingAreas,
    refetch: refetchAreas,
  } = useQuery({
    queryKey: ['inventory-areas', activeWarehouseId || 'default'],
    queryFn: () => getInventoryAreas(true),
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const allAreas = useMemo(() => areasResponse?.data || [], [areasResponse]);
  const activeAreas = useMemo(() => allAreas.filter((a) => a.status !== 'archived'), [allAreas]);

  // 2. Fetch Daftar Sesi Stock Opname
  const {
    data: sessionsResponse,
    isLoading: loadingSessions,
    refetch: refetchSessions,
  } = useQuery({
    queryKey: ['stock-opname-sessions', activeWarehouseId || 'default'],
    queryFn: getStockOpnameSessions,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const sessions = useMemo(() => sessionsResponse?.data || [], [sessionsResponse]);

  // 3. Fetch Detail Sesi SO Terpilih
  const {
    data: sessionDetailResponse,
    isLoading: loadingSessionDetail,
    refetch: refetchSessionDetail,
  } = useQuery({
    queryKey: ['stock-opname-session-detail', selectedSessionId],
    queryFn: () => getStockOpnameSessionDetail(selectedSessionId),
    enabled: Boolean(selectedSessionId && currentView === 'session_detail'),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const activeSession = sessionDetailResponse?.data || null;
  const isFinalized = activeSession?.status === 'finalized';
  const isSessionEditable = !isFinalized;
  const isAreaCompleted = checkingArea?.status === 'completed';
  const isAreaLocked = isFinalized || isAreaCompleted;

  // Set ID Dokumen Goods In yang dihasilkan dari temuan/konversi sesi SO ini
  const soGoodsInDocIds = useMemo(() => {
    const set = new Set();
    if (!activeSession || !Array.isArray(allWorkspaceDocs)) return set;
    for (const doc of allWorkspaceDocs) {
      const docType = doc.document_type || doc.documentType;
      if (docType !== 'goods_in') continue;
      const isSoMatch =
        doc.metadata?.stock_opname_session_id === activeSession.id ||
        doc.metadata?.stock_opname_session_number === activeSession.sessionNumber ||
        (doc.notes && doc.notes.includes(activeSession.sessionNumber)) ||
        (doc.contactName && doc.contactName.includes(activeSession.sessionNumber)) ||
        (doc.contact_name && doc.contact_name.includes(activeSession.sessionNumber));
      if (isSoMatch && doc.id) {
        set.add(doc.id);
      }
    }
    return set;
  }, [activeSession, allWorkspaceDocs]);

  // Set nomor seri yang dibuat dari dokumen Goods In temuan sesi SO ini
  const soCreatedSerialsSet = useMemo(() => {
    const set = new Set();
    if (!activeSession || !Array.isArray(allWorkspaceDocs)) return set;
    for (const doc of allWorkspaceDocs) {
      const docType = doc.document_type || doc.documentType;
      if (docType !== 'goods_in') continue;
      const isSoMatch =
        doc.metadata?.stock_opname_session_id === activeSession.id ||
        doc.metadata?.stock_opname_session_number === activeSession.sessionNumber ||
        (doc.notes && doc.notes.includes(activeSession.sessionNumber)) ||
        (doc.contactName && doc.contactName.includes(activeSession.sessionNumber)) ||
        (doc.contact_name && doc.contact_name.includes(activeSession.sessionNumber));
      if (!isSoMatch) continue;
      for (const it of doc.items || []) {
        const itemSerials = it.metadata?.serialNumbers || (it.metadata?.serialNumber ? [it.metadata.serialNumber] : []);
        itemSerials.forEach((sn) => {
          if (sn) set.add(String(sn).trim().toLowerCase());
        });
      }
    }
    return set;
  }, [activeSession, allWorkspaceDocs]);

  // Helper: Cek apakah sebuah nomor seri adalah hasil Goods In / temuan baru dari sesi SO ini
  const isSerialFromSoGoodsIn = (sn, itemSerialObj = null) => {
    if (!sn) return false;
    const cleanLower = String(sn).trim().toLowerCase();
    if (soCreatedSerialsSet.has(cleanLower)) return true;
    if (itemSerialObj?.goodsInDocId && soGoodsInDocIds.has(itemSerialObj.goodsInDocId)) return true;
    return false;
  };

  const [isSyncingStock, setIsSyncingStock] = useState(false);

  // Live Reconciled Product Summary & Discrepancies
  // Menyesuaikan stok sistem dan temuan fisik secara langsung dengan data area & nomor seri terkini gudang aktif
  const {
    productSummary,
    discrepancyItems,
    warehouseReconciliation,
  } = useMemo(() => {
    const rawSummary = sessionDetailResponse?.productSummary || [];
    const rawDiscrepancies = sessionDetailResponse?.discrepancyItems || [];
    const rawReconciliation = sessionDetailResponse?.warehouseReconciliation || {
      isBalanced: true,
      totalSystemQty: 0,
      totalPhysicalQty: 0,
      netDifference: 0,
      discrepancyCount: 0,
      completedAreasCount: 0,
      totalAreasCount: 0,
      completionPercent: 0,
    };

    if (isFinalized || !products || products.length === 0) {
      return {
        productSummary: rawSummary,
        discrepancyItems: rawDiscrepancies,
        warehouseReconciliation: rawReconciliation,
      };
    }

    const liveProdById = new Map();
    const liveProdBySku = new Map();
    products.forEach((p) => {
      if (p.id) liveProdById.set(p.id, p);
      if (p.sku) liveProdBySku.set(String(p.sku).trim().toUpperCase(), p);
    });

    // Satukan daftar area aktif dengan state checkingItems jika modal area sedang dibuka
    const currentAreas = (activeSession?.areas || []).map((a) => {
      if (checkingArea && (a.areaId === checkingArea.areaId || a.id === checkingArea.id || a.areaId === checkingArea.id)) {
        return { ...a, items: checkingItems };
      }
      return a;
    });

    // Helper: agregasi temuan fisik di seluruh area untuk sebuah produk (dengan multiplier unit SN akurat)
    const aggregateProductPhysicalFromAreas = (pId, skuKey) => {
      let countedPhysQty = 0;
      let hasBeenCounted = false;
      const aggregatedLocations = [];
      const aggregatedSerials = [];

      currentAreas.forEach((area) => {
        (area.items || []).forEach((areaIt) => {
          const match = (areaIt.productId && pId && areaIt.productId === pId) ||
                        (areaIt.sku && skuKey && String(areaIt.sku).trim().toUpperCase() === skuKey);
          if (!match) return;

          const hasSerials = Array.isArray(areaIt.scannedSerials) && areaIt.scannedSerials.length > 0;
          const hasManual = Array.isArray(areaIt.manualEntries) && areaIt.manualEntries.some((e) => String(e.qty ?? '').trim() !== '' && Number(e.qty) > 0);
          const hasLegacy = areaIt.manualQty !== undefined && areaIt.manualQty !== null && String(areaIt.manualQty).trim() !== '' && Number(areaIt.manualQty) > 0;
          const hasExplicitPhys = areaIt.physicalQty !== null && areaIt.physicalQty !== undefined && !isNaN(Number(areaIt.physicalQty));

          if (!hasSerials && !hasManual && !hasLegacy && !hasExplicitPhys) return;

          hasBeenCounted = true;

          let serialPcs = 0;
          if (hasSerials) {
            areaIt.scannedSerials.forEach((sn) => {
              const u = getSerialUnit(areaIt, sn);
              const mult = Number(getMultiplier(u)) || 1;
              serialPcs += mult;
              aggregatedSerials.push(sn);
            });
          }

          let manualPcs = 0;
          if (Array.isArray(areaIt.manualEntries) && areaIt.manualEntries.length > 0) {
            const validEntries = hasSerials
              ? areaIt.manualEntries.filter((e) => !String(e.id || '').startsWith('m_legacy_') && !String(e.id || '').startsWith('m_init_'))
              : areaIt.manualEntries;
            validEntries.forEach((entry) => {
              const q = Number(entry?.qty);
              if (!isNaN(q) && q > 0) {
                const u = entry?.unit || 'pcs';
                const mult = Number(getMultiplier(u)) || 1;
                manualPcs += q * mult;
              }
            });
          } else if (hasLegacy && !hasSerials) {
            const q = Number(areaIt.manualQty);
            const u = areaIt.manualUnit || areaIt.unit || 'pcs';
            const mult = Number(getMultiplier(u)) || 1;
            manualPcs += q * mult;
          }

          let areaPcs = 0;
          if (hasSerials || hasManual || (hasLegacy && !hasSerials)) {
            areaPcs = serialPcs + manualPcs;
          } else {
            areaPcs = Number(areaIt.physicalQty) || 0;
          }

          countedPhysQty += areaPcs;
          aggregatedLocations.push({
            areaId: area.areaId || area.id,
            areaName: area.areaName || area.name,
            physicalQty: areaPcs,
            scannedSerials: areaIt.scannedSerials || [],
            notes: areaIt.notes || '',
          });
        });
      });

      return {
        hasBeenCounted,
        totalPhysicalQty: countedPhysQty,
        locations: aggregatedLocations,
        scannedSerials: aggregatedSerials,
      };
    };

    let totalSys = 0;
    let totalPhys = 0;
    const discrepancies = [];
    const handledSkus = new Set();

    const summary = rawSummary.map((item) => {
      const skuKey = String(item.sku || item.productId || '').trim().toUpperCase();
      handledSkus.add(skuKey);

      // Ambil seluruh nomor seri yang terdaftar di database untuk produk ini (hanya yang sah terdaftar di produk ini, tanpa substring collision)
      const allSerialsForProd = getRegisteredSerialsForProduct(item.productId, item.sku);

      const availableSerialsForProd = allSerialsForProd.filter(
        (s) => (s.status === 'available' || isSerialFromSoGoodsIn(s.serialNumber, s)) &&
               (!activeWarehouseId || !s.warehouseId || String(s.warehouseId) === String(activeWarehouseId))
      );

      const live = (item.productId && liveProdById.get(item.productId)) || (skuKey && liveProdBySku.get(skuKey));

      let sysQty;
      if (allSerialsForProd.length > 0) {
        // Untuk produk ber-seri: Stok sistem yang sah adalah total pcs dari seluruh nomor seri aktif ('available')
        sysQty = availableSerialsForProd.reduce((acc, s) => {
          const u = s.unit || getSerialUnit(null, s.serialNumber);
          const mult = Number(getMultiplier(u)) || 1;
          return acc + mult;
        }, 0);
      } else {
        sysQty = live !== undefined && live !== null ? Math.max(0, Number(live.stock) || 0) : Number(item.totalSystemQty) || 0;
      }

      // Deteksi temuan fisik live dari area-area pemeriksaan
      const areaData = aggregateProductPhysicalFromAreas(item.productId, skuKey);
      const hasCounted = areaData.hasBeenCounted || Boolean(item.hasBeenCounted);
      const physQty = areaData.hasBeenCounted ? areaData.totalPhysicalQty : (Number(item.totalPhysicalQty) || 0);
      const diff = physQty - sysQty;

      totalSys += sysQty;
      totalPhys += physQty;

      let status = 'pending';
      if (!hasCounted) {
        status = sysQty === 0 ? 'matched' : 'pending';
      } else if (diff === 0) {
        status = 'matched';
      } else if (diff < 0) {
        status = 'shortage';
      } else {
        status = 'overage';
      }

      const reconciledItem = {
        ...item,
        name: live?.name || item.name,
        totalSystemQty: sysQty,
        totalPhysicalQty: physQty,
        difference: diff,
        status,
        hasBeenCounted: hasCounted,
        locations: areaData.locations.length > 0 ? areaData.locations : (item.locations || []),
        scannedSerials: areaData.scannedSerials.length > 0
          ? Array.from(new Set(areaData.scannedSerials))
          : (item.scannedSerials || []),
      };

      if (status === 'shortage' || status === 'overage' || (status === 'pending' && sysQty > 0)) {
        discrepancies.push({
          productId: reconciledItem.productId,
          sku: reconciledItem.sku,
          name: reconciledItem.name,
          unit: reconciledItem.unit,
          systemQty: sysQty,
          physicalQty: physQty,
          difference: diff,
          status: diff < 0 ? 'shortage' : status === 'overage' ? 'overage' : status,
          locations: reconciledItem.locations || [],
          scannedSerials: reconciledItem.scannedSerials || [],
        });
      }

      return reconciledItem;
    });

    // Tambahkan produk katalog yang belum terdaftar di summary sesi
    products.forEach((lp) => {
      const skuKey = String(lp.sku || lp.id).trim().toUpperCase();
      if (!handledSkus.has(skuKey)) {
        handledSkus.add(skuKey);
        // Ambil seluruh nomor seri yang terdaftar di database untuk produk ini (hanya yang sah terdaftar di produk ini, tanpa substring collision)
        const allSerialsForProd = getRegisteredSerialsForProduct(lp.id, lp.sku);
        const availableSerialsForProd = allSerialsForProd.filter(
          (s) => s.status === 'available' || isSerialFromSoGoodsIn(s.serialNumber, s)
        );

        let sysQty;
        if (allSerialsForProd.length > 0) {
          sysQty = availableSerialsForProd.reduce((acc, s) => {
            const u = s.unit || getSerialUnit(null, s.serialNumber);
            const mult = Number(getMultiplier(u)) || 1;
            return acc + mult;
          }, 0);
        } else {
          sysQty = Math.max(0, Number(lp.stock) || 0);
        }

        // Agregasi temuan fisik dari area untuk produk katalog ini
        const areaData = aggregateProductPhysicalFromAreas(lp.id, skuKey);
        const physQty = areaData.totalPhysicalQty;
        const hasCounted = areaData.hasBeenCounted;
        const diff = hasCounted ? physQty - sysQty : -sysQty;

        totalSys += sysQty;
        totalPhys += physQty;

        let status = 'pending';
        if (!hasCounted) {
          status = sysQty === 0 ? 'matched' : 'pending';
        } else if (diff === 0) {
          status = 'matched';
        } else if (diff < 0) {
          status = 'shortage';
        } else {
          status = 'overage';
        }

        const newItem = {
          productId: lp.id,
          sku: lp.sku,
          name: lp.name,
          unit: lp.unitKey || 'pcs',
          totalSystemQty: sysQty,
          totalPhysicalQty: physQty,
          difference: diff,
          status,
          hasBeenCounted: hasCounted,
          locations: areaData.locations,
          scannedSerials: Array.from(new Set(areaData.scannedSerials)),
        };
        summary.push(newItem);

        if (status === 'shortage' || status === 'overage' || (status === 'pending' && sysQty > 0)) {
          discrepancies.push({
            productId: lp.id,
            sku: lp.sku,
            name: lp.name,
            unit: lp.unitKey || 'pcs',
            systemQty: sysQty,
            physicalQty: physQty,
            difference: diff,
            status: diff < 0 ? 'shortage' : status === 'overage' ? 'overage' : status,
            locations: areaData.locations,
            scannedSerials: Array.from(new Set(areaData.scannedSerials)),
          });
        }
      }
    });

    // Tambahkan produk temuan baru / unlisted dari area yang belum ada di katalog maupun summary
    currentAreas.forEach((area) => {
      (area.items || []).forEach((areaIt) => {
        const skuKey = String(areaIt.sku || areaIt.productId || '').trim().toUpperCase();
        if (skuKey && !handledSkus.has(skuKey)) {
          handledSkus.add(skuKey);
          const areaData = aggregateProductPhysicalFromAreas(areaIt.productId, skuKey);
          const physQty = areaData.totalPhysicalQty;
          const sysQty = Number(areaIt.systemQty) || 0;
          const diff = physQty - sysQty;

          totalSys += sysQty;
          totalPhys += physQty;

          let status = 'pending';
          if (!areaData.hasBeenCounted) {
            status = sysQty === 0 ? 'matched' : 'pending';
          } else if (diff === 0) {
            status = 'matched';
          } else if (diff < 0) {
            status = 'shortage';
          } else {
            status = 'overage';
          }

          const newItem = {
            productId: areaIt.productId || null,
            sku: areaIt.sku || '',
            name: areaIt.name || areaIt.sku || 'Item',
            unit: areaIt.unit || 'pcs',
            totalSystemQty: sysQty,
            totalPhysicalQty: physQty,
            difference: diff,
            status,
            hasBeenCounted: areaData.hasBeenCounted,
            locations: areaData.locations,
            scannedSerials: Array.from(new Set(areaData.scannedSerials)),
          };
          summary.push(newItem);

          if (status === 'shortage' || status === 'overage' || (status === 'pending' && sysQty > 0)) {
            discrepancies.push({
              productId: newItem.productId,
              sku: newItem.sku,
              name: newItem.name,
              unit: newItem.unit,
              systemQty: sysQty,
              physicalQty: physQty,
              difference: diff,
              status,
              locations: areaData.locations,
              scannedSerials: Array.from(new Set(areaData.scannedSerials)),
            });
          }
        }
      });
    });

    discrepancies.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name));

    const netDiff = totalPhys - totalSys;
    const reconciliation = {
      ...rawReconciliation,
      totalSystemQty: totalSys,
      totalPhysicalQty: totalPhys,
      netDifference: netDiff,
      discrepancyCount: discrepancies.length,
      isBalanced: discrepancies.length === 0,
    };

    return {
      productSummary: summary,
      discrepancyItems: discrepancies,
      warehouseReconciliation: reconciliation,
    };
  }, [
    sessionDetailResponse,
    products,
    isFinalized,
    activeSession,
    checkingArea,
    checkingItems,
    getMultiplier,
    customUnits,
    serialIndexLookupMap,
    serialUnitMap,
  ]);

  // Kumpulan seluruh entri temuan fisik non-seri manual di area ini yang belum di-import ke Goods In
  const unimportedNonSerialTargets = useMemo(() => {
    if (!checkingItems || checkingItems.length === 0) return [];
    const targets = [];
    checkingItems.forEach((it) => {
      const rawManualEntries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
        ? it.manualEntries
        : (it.manualQty !== undefined && it.manualQty !== null && String(it.manualQty).trim() !== ''
            ? [{ id: `m_legacy_${it.id}`, qty: String(it.manualQty), unit: it.manualUnit || it.inputUnit || it.unit || 'pcs' }]
            : [{ id: `m_init_${it.id}`, qty: it.inputVal !== undefined && it.inputVal !== null ? String(it.inputVal) : '', unit: it.inputUnit || it.manualUnit || it.unit || 'pcs' }]);

      rawManualEntries.forEach((entry) => {
        const qtyVal = Number(entry?.qty);
        if (!isNaN(qtyVal) && qtyVal > 0 && !entry?.convertedToGoodsIn) {
          const unitKey = entry?.unit || 'pcs';
          const mult = Number(getMultiplier(unitKey)) || 1;
          const totalPcs = qtyVal * mult;
          targets.push({
            item: it,
            entry,
            qtyVal,
            unitKey,
            mult,
            totalPcs,
          });
        }
      });
    });
    return targets;
  }, [checkingItems, getMultiplier]);

  const handleSyncLatestSystemStock = async () => {
    if (!activeSession?.id || isFinalized) return;
    try {
      setIsSyncingStock(true);
      if (products && products.length > 0) {
        await syncStockOpnameSessionBaseline(activeSession.id, {
          products: products.map((p) => ({
            productId: p.id,
            sku: p.sku,
            name: p.name,
            unit: p.unitKey || p.unit || 'pcs',
            stock: Number(p.stock) || 0,
          })),
        });
      }
      queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      await refetchSessionDetail();
      playBeep('success');
      setScanNotification({
        type: 'success',
        message: '✅ Stok sistem berhasil disinkronkan dengan pergerakan transaksi gudang terkini!',
      });
      setTimeout(() => setScanNotification(null), 3500);
    } catch (err) {
      alert(err.message || 'Gagal menyinkronkan stok sistem');
    } finally {
      setIsSyncingStock(false);
    }
  };

  // Helper resolusi barang masalah
  const handleToggleResolveDiscrepancy = (key) => {
    if (!key) return;
    setResolvedDiscrepancyIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Map produk yang telah di-write-off / dikeluarkan saat SO dari session.metadata.writtenOffSummary
  const writtenOffProductsMap = useMemo(() => {
    const map = new Map();
    (activeSession?.metadata?.writtenOffSummary || []).forEach((summary) => {
      (summary.products || []).forEach((p) => {
        const key = (p.sku || p.productId || '').toLowerCase();
        if (!key) return;
        if (!map.has(key)) map.set(key, { ...p, documentNumber: summary.documentNumber, executedAt: summary.executedAt });
      });
    });
    return map;
  }, [activeSession]);

  const isItemResolved = (item) => {
    const key = item.sku || item.productId;
    const lowerKey = String(item.sku || item.productId || '').toLowerCase();
    return resolvedDiscrepancyIds.has(key) || Boolean(createdDocBySku[key]) || writtenOffProductsMap.has(lowerKey);
  };

  // Helper pencari tautan dokumen Goods In & Goods Out untuk produk tertentu
  const getProductRelatedDocuments = (sku, productId) => {
    const skuKey = String(sku || '').toUpperCase();
    const pId = productId || null;

    let goodsIn = null;
    let goodsOut = null;

    // 0. Cek apakah produk ini telah di-write-off melalui fitur Keluarkan Barang Hilang SO
    if (!goodsOut && (writtenOffProductsMap.has(skuKey.toLowerCase()) || (pId && writtenOffProductsMap.has(String(pId).toLowerCase())))) {
      const wo = writtenOffProductsMap.get(skuKey.toLowerCase()) || writtenOffProductsMap.get(String(pId).toLowerCase());
      if (wo) {
        goodsOut = {
          documentNumber: wo.documentNumber || 'SO-WRITEOFF',
          status: 'completed',
          contactName: `Stock Opname Write-Off (${activeSession?.sessionNumber})`,
          qty: wo.totalDeductedPcs,
          unit: 'pcs',
          serials: (wo.serials || []).map((s) => s.serialNumber),
        };
      }
    }

    // 1. Cek dari pelacakan dokumen lokal yang baru saja dibuat di sesi ini
    if (skuKey && createdDocBySku[skuKey]) {
      const cd = createdDocBySku[skuKey];
      if (cd.type === 'goods_out') goodsOut = cd;
      if (cd.type === 'goods_in') goodsIn = cd;
    }
    if (pId && createdDocBySku[pId]) {
      const cd = createdDocBySku[pId];
      if (cd.type === 'goods_out') goodsOut = cd;
      if (cd.type === 'goods_in') goodsIn = cd;
    }

    // 2. Cek apakah ada entri fisik yang telah dikonversi ke Goods In di area-area sesi ini
    if (!goodsIn && activeSession?.areas) {
      for (const area of activeSession.areas) {
        for (const item of area.items || []) {
          // Hanya jika item masih aktif diperiksa (bukan reset)
          if (item.physicalQty === null || item.physicalQty === undefined) continue;
          const match = (item.productId && item.productId === pId) || (item.sku && String(item.sku).toUpperCase() === skuKey);
          if (match && Array.isArray(item.manualEntries)) {
            for (const entry of item.manualEntries) {
              if (entry.convertedToGoodsIn) {
                goodsIn = {
                  documentNumber: entry.convertedToGoodsIn.documentNumber,
                  documentId: entry.convertedToGoodsIn.documentId,
                  contactName: `Temuan SO ${activeSession?.sessionNumber || ''} (${area.areaName || 'semua gudang'})`,
                  qty: entry.convertedToGoodsIn.qty,
                  unit: entry.convertedToGoodsIn.unit,
                  totalPcs: entry.convertedToGoodsIn.totalPcs,
                  isNonSerial: true,
                  status: 'completed',
                };
                break;
              }
            }
          }
          if (goodsIn) break;
        }
        if (goodsIn) break;
      }
    }

    // 3. Cek seluruh dokumen workspace yang terkait dengan nomor sesi Stock Opname ini
    if (activeSession && Array.isArray(allWorkspaceDocs)) {
      const activeAreaIds = new Set(
        (activeSession.areas || []).map((a) => a.areaId || a.id).filter(Boolean)
      );

      for (const doc of allWorkspaceDocs) {
        // Jika dokumen ini secara spesifik terkait ke area tertentu di sesi SO, pastikan area tersebut masih ada (tidak dihapus)
        const docAreaId = doc.metadata?.stock_opname_area_id;
        if (docAreaId && !activeAreaIds.has(docAreaId)) {
          continue;
        }

        const isSoMatch =
          doc.metadata?.stock_opname_session_id === activeSession.id ||
          doc.metadata?.stock_opname_session_number === activeSession.sessionNumber ||
          (doc.notes && doc.notes.includes(activeSession.sessionNumber)) ||
          (doc.contactName && doc.contactName.includes(activeSession.sessionNumber)) ||
          (doc.contact_name && doc.contact_name.includes(activeSession.sessionNumber));

        if (!isSoMatch) continue;

        const docNum = doc.document_number || doc.documentNumber;
        const docType = doc.document_type || doc.documentType;
        const docStatus = doc.status || 'draft';
        const docContact = doc.contact_name || doc.contactName || (docType === 'goods_in' ? `Temuan SO ${activeSession.sessionNumber} (semua gudang)` : `Penyesuaian SO ${activeSession.sessionNumber} (semua gudang)`);

        for (const it of doc.items || []) {
          const itMatch = (it.product_id && it.product_id === pId) || (it.productId && it.productId === pId) || (it.sku && String(it.sku).toUpperCase() === skuKey);
          if (itMatch) {
            const itemQty = it.metadata?.qtyInput ?? it.quantity ?? 1;
            const itemUnit = it.metadata?.qtyUnit || it.unit || 'pcs';
            const itemSerials = it.metadata?.serialNumbers || (it.metadata?.serialNumber ? [it.metadata.serialNumber] : []);
            const info = {
              documentNumber: docNum,
              documentId: doc.id,
              contactName: docContact,
              qty: itemQty,
              unit: itemUnit,
              totalPcs: it.quantity || itemQty,
              serials: itemSerials,
              status: docStatus,
              isNonSerial: !it.metadata?.isSerial,
            };

            if (docType === 'goods_in' && !goodsIn) {
              goodsIn = info;
            } else if (docType === 'goods_out' && !goodsOut) {
              goodsOut = info;
            }
          }
        }
      }
    }

    return { goodsIn, goodsOut };
  };

  // Tabel Rekapitulasi Menyeluruh Produk: Serial vs Non-seri & Pelacakan Dokumen Masuk/Keluar
  const reconciliationProductTable = useMemo(() => {
    if (!productSummary || productSummary.length === 0) return [];

    return productSummary.map((prod) => {
      const skuKey = String(prod.sku || '').toUpperCase();
      const pId = prod.productId || null;

      // Hitung rincian temuan fisik: yang ada nomor serinya vs non-seri
      let serialCount = 0; // dalam pcs
      const serialNumbersList = [];
      let nonSerialCount = 0; // dalam pcs
      const nonSerialBreakdown = [];
      let productHasCountedArea = false;

      if (activeSession?.areas) {
        activeSession.areas.forEach((area) => {
          (area.items || []).forEach((item) => {
            const match = (item.productId && item.productId === pId) || (item.sku && String(item.sku).toUpperCase() === skuKey);
            if (!match) return;

            // Jika item di area ini belum diperiksa / telah di-reset (physicalQty === null/undefined), lewati
            if (item.physicalQty === null || item.physicalQty === undefined) return;

            productHasCountedArea = true;

            // 1. Fisik yang ada serial number-nya
            if (Array.isArray(item.scannedSerials) && item.scannedSerials.length > 0) {
              item.scannedSerials.forEach((sn) => {
                const u = getSerialUnit(item, sn);
                const mult = Number(getMultiplier(u)) || 1;
                serialCount += mult;
                serialNumbersList.push(sn);
              });
            }

            // 2. Fisik non-seri dari input manual (hanya hitung entri manual murni jika ber-seri)
            const hasSerialsInLoc = Array.isArray(item.scannedSerials) && item.scannedSerials.length > 0;
            if (Array.isArray(item.manualEntries) && item.manualEntries.length > 0) {
              const validEntries = hasSerialsInLoc
                ? item.manualEntries.filter((e) => !String(e.id || '').startsWith('m_legacy_') && !String(e.id || '').startsWith('m_init_'))
                : item.manualEntries;
              validEntries.forEach((entry) => {
                const q = Number(entry?.qty);
                if (!isNaN(q) && q > 0) {
                  const u = entry?.unit || 'pcs';
                  const mult = Number(getMultiplier(u)) || 1;
                  const pcs = q * mult;
                  nonSerialCount += pcs;
                  nonSerialBreakdown.push({ qty: q, unit: u, pcs, areaName: area.areaName });
                }
              });
            } else if (!hasSerialsInLoc && item.manualQty !== undefined && item.manualQty !== null && String(item.manualQty).trim() !== '') {
              const q = Number(item.manualQty);
              if (!isNaN(q) && q > 0) {
                const u = item.manualUnit || item.unit || 'pcs';
                const mult = Number(getMultiplier(u)) || 1;
                const pcs = q * mult;
                nonSerialCount += pcs;
                nonSerialBreakdown.push({ qty: q, unit: u, pcs, areaName: area.areaName });
              }
            }
          });
        });
      }

      const totalPhysical = serialCount + nonSerialCount;
      const systemQty = Number(prod.totalSystemQty) || 0;
      // Jika produk belum pernah dihitung di area mana pun (semua area pending / di-reset / dihapus), selisih belum ada (0)
      const diff = productHasCountedArea ? totalPhysical - systemQty : 0;

      // Cari tautan dokumen Goods In & Goods Out
      const { goodsIn, goodsOut } = getProductRelatedDocuments(prod.sku, prod.productId);

      // Cek nomor seri terdaftar di database yang tidak ditemukan saat SO (missing serials)
      const dbSerials = pId && productSerialsMap.has(pId) ? productSerialsMap.get(pId) : [];
      const dbSnList = dbSerials.map((s) => s.serialNumber);
      const scannedSnSet = new Set(serialNumbersList.map((s) => s.toLowerCase()));
      const missingDbSerials = dbSnList.filter((sn) => !scannedSnSet.has(sn.toLowerCase()));

      return {
        ...prod,
        systemQty,
        serialCount,
        serialNumbersList,
        nonSerialCount,
        nonSerialBreakdown,
        totalPhysical,
        diff,
        productHasCountedArea,
        goodsIn,
        goodsOut,
        missingDbSerials,
      };
    });
  }, [
    productSummary,
    activeSession,
    getMultiplier,
    customUnits,
    serialIndexLookupMap,
    serialUnitMap,
    productSerialsMap,
    allWorkspaceDocs,
    createdDocBySku,
  ]);

  // Auto-sinkronkan baseline jika sesi belum memiliki baseline seluruh produk gudang
  React.useEffect(() => {
    if (
      activeSession &&
      (!activeSession.baselineProducts || activeSession.baselineProducts.length === 0) &&
      !isFinalized &&
      products &&
      products.length > 0
    ) {
      syncStockOpnameSessionBaseline(activeSession.id, {
        products: products.map((p) => ({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unitKey || p.unit || 'pcs',
          stock: Number(p.stock) || 0,
        })),
      })
        .then(() => refetchSessionDetail())
        .catch((err) => console.error('Failed to auto-sync baseline products:', err));
    }
  }, [activeSession?.id, activeSession?.baselineProducts?.length, isFinalized, products?.length]);

  // ── Handlers: Sesi Stock Opname ────────────────────────────
  const handleOpenCreateSession = () => {
    const today = new Date().toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    setNewSessionTitle(`Stock Opname - ${today}`);
    setNewSessionNotes('');
    setShowCreateSessionModal(true);
  };

  const handleCreateSession = async (e) => {
    e.preventDefault();
    if (isCreatingSession) return;
    setIsCreatingSession(true);
    try {
      const res = await createStockOpnameSession({
        title: newSessionTitle.trim(),
        notes: newSessionNotes.trim(),
        products: (products || []).map((p) => ({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unitKey || p.unit || 'pcs',
          stock: Number(p.stock) || 0,
        })),
      });
      await refetchSessions();
      setShowCreateSessionModal(false);
      // Langsung buka sesi yang baru dibuat
      if (res.data?.id) {
        setSelectedSessionId(res.data.id);
        setCurrentView('session_detail');
        setSessionSubTab('areas');
      }
    } catch (err) {
      alert(err.message || 'Gagal membuat sesi');
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleOpenAddAreaToSession = () => {
    setSessionAreaName('');
    setSessionAreaDesc('');
    setSessionAreaItems([]);
    setProductSearchForSessionArea('');
    setSelectedProductForSessionArea(null);
    setQtyForSessionAreaProduct(1);
    setShowAddSessionAreaModal(true);
  };

  const handleAddProductToSessionAreaDraft = () => {
    if (!selectedProductForSessionArea) return;
    const exists = sessionAreaItems.find((it) => it.productId === selectedProductForSessionArea.id);
    if (exists) {
      alert('Produk ini sudah ada dalam daftar alokasi lokasi ini.');
      return;
    }
    setSessionAreaItems((prev) => [
      ...prev,
      {
        productId: selectedProductForSessionArea.id,
        sku: selectedProductForSessionArea.sku,
        name: selectedProductForSessionArea.name,
        unit: selectedProductForSessionArea.unitKey || selectedProductForSessionArea.unit || 'pcs',
        systemQty: Number(qtyForSessionAreaProduct) || 0,
      },
    ]);
    setSelectedProductForSessionArea(null);
    setProductSearchForSessionArea('');
    setQtyForSessionAreaProduct(1);
  };

  const handleRemoveProductFromSessionAreaDraft = (productId) => {
    setSessionAreaItems((prev) => prev.filter((it) => it.productId !== productId));
  };

  const handleSaveAreaToSession = async (e) => {
    e.preventDefault();
    if (!sessionAreaName.trim()) {
      alert('Nama Bagian / Area wajib diisi.');
      return;
    }
    if (isSavingArea) return;
    setIsSavingArea(true);
    try {
      await addAreaToStockOpnameSession(selectedSessionId, {
        name: sessionAreaName.trim(),
        description: sessionAreaDesc.trim(),
        items: sessionAreaItems,
      });
      setShowAddSessionAreaModal(false);
      await refetchSessionDetail();
      await refetchAreas();
    } catch (err) {
      alert(err.message || 'Gagal menambahkan lokasi ke sesi');
    } finally {
      setIsSavingArea(false);
    }
  };

  const handleCloseCheckingModal = () => {
    if (isSavingCount) return;
    setCheckingArea(null);
    setCheckingItems([]);
    setIsEditingCompletedArea(false);
  };

  const handleDeleteAreaFromSession = (areaId, areaName, e) => {
    e?.stopPropagation();
    setConfirmDialog({
      title: 'Hapus Bagian / Area',
      message: `Apakah Anda yakin ingin menghapus area "${areaName}" dari sesi Stock Opname ini? Semua catatan hitungan fisik di area ini akan ikut terhapus.`,
      confirmLabel: 'Hapus Area',
      onConfirm: async () => {
        try {
          await deleteAreaFromStockOpnameSession(selectedSessionId, areaId);
          if (checkingArea?.areaId === areaId || checkingArea?.id === areaId) {
            handleCloseCheckingModal();
          }
          await queryClient.invalidateQueries({ queryKey: ['stock-opname-session-detail', selectedSessionId] });
          await refetchSessionDetail();
          setConfirmDialog(null);
        } catch (err) {
          alert(err.message || 'Gagal menghapus area dari sesi');
          setConfirmDialog(null);
        }
      },
    });
  };

  const handleOpenSession = (sessionId) => {
    setSelectedSessionId(sessionId);
    setCurrentView('session_detail');
    setSessionSubTab('areas');
  };

  const handleBackToList = () => {
    setCurrentView('list');
    setSelectedSessionId(null);
    refetchSessions();
  };

  // ── Handlers: Pengecekan Area Tertentu ─────────────────────
  const handleStartCheckingArea = (area) => {
    if (activeSession?.status === 'finalized') {
      alert('Sesi ini sudah difinalisasi. Hasil hanya dapat ditinjau.');
    }
    setIsEditingCompletedArea(false);
    setCheckingArea(area);
    setCheckingItems(
      (area.items || []).map((it) => {
        const hasSerials = Array.isArray(it.scannedSerials) && it.scannedSerials.length > 0;
        
        // Pulihkan array manualEntries secara utuh (menjaga unit non-seri asli seperti pack, lusin, dll.)
        let initManualEntries = [];
        if (Array.isArray(it.manualEntries) && it.manualEntries.length > 0) {
          initManualEntries = it.manualEntries.map((m, mIdx) => ({
            id: m.id || `m_${mIdx}_${Date.now()}`,
            qty: m.qty !== undefined && m.qty !== null ? String(m.qty) : '',
            unit: m.unit || it.manualUnit || it.inputUnit || it.unit || 'pcs',
            convertedToGoodsIn: m.convertedToGoodsIn || null,
          }));
          if (hasSerials) {
            initManualEntries = initManualEntries.filter((m) => !String(m.id || '').startsWith('m_legacy_'));
          }
        } else if (!hasSerials && it.manualQty !== undefined && it.manualQty !== null && String(it.manualQty).trim() !== '') {
          // Kompatibilitas data legacy manualQty & manualUnit (hanya jika produk non-seri)
          initManualEntries = [
            {
              id: `m_legacy_${Date.now()}`,
              qty: String(it.manualQty),
              unit: it.manualUnit || it.inputUnit || it.unit || 'pcs',
            },
          ];
        } else if (!hasSerials && it.physicalQty !== null && it.physicalQty !== undefined) {
          // Jika data lama hanya menyimpan physicalQty tanpa rincian manual
          initManualEntries = [
            {
              id: `m_legacy_${Date.now()}`,
              qty: String(it.physicalQty),
              unit: it.manualUnit || it.unit || 'pcs',
            },
          ];
        }

        // Minimal selalu miliki 1 entry default
        if (initManualEntries.length === 0) {
          initManualEntries = [
            {
              id: `m_init_${Date.now()}`,
              qty: '',
              unit: it.manualUnit || it.inputUnit || it.unit || 'pcs',
            },
          ];
        }

        const preUnits = {};
        if (Array.isArray(it.scannedSerials)) {
          it.scannedSerials.forEach((sn) => {
            const u = getSerialUnit(it, sn);
            preUnits[sn] = u;
            preUnits[String(sn).toLowerCase()] = u;
          });
        }

        const firstEntry = initManualEntries[0];

        return {
          ...it,
          manualEntries: initManualEntries,
          inputVal: firstEntry.qty,
          inputUnit: firstEntry.unit,
          manualQty: firstEntry.qty,
          manualUnit: firstEntry.unit,
          scannedSerials: Array.isArray(it.scannedSerials) ? [...it.scannedSerials] : [],
          serialUnits: preUnits,
        };
      })
    );
    setCheckingSearch('');
    setBarcodeInput('');
    setIsCameraActive(false);
    setScanNotification(null);
    setInlineAddSearch('');
    setInlineSelectedProduct(null);
    setInlinePhysicalQty('');
    setInlineUnit('pcs');
  };

  // Sinkronisasi Map & Set nomor seri yang sudah di-scan di area ini untuk deteksi duplikat instan O(1)
  useEffect(() => {
    const set = new Set();
    const map = new Map();
    (checkingItems || []).forEach((it) => {
      (it.scannedSerials || []).forEach((s) => {
        if (s) {
          const lower = String(s).trim().toLowerCase();
          set.add(lower);
          map.set(lower, { itemId: it.id, name: it.name, sku: it.sku });
        }
      });
    });
    scannedSerialsInCurrentAreaRef.current = set;
    scannedSerialsInCurrentAreaMapRef.current = map;
  }, [checkingItems]);

  // Fast In-Memory Map nomor seri di SEMUA area lain dalam sesi ini (O(1) lookup 0ms)
  const otherAreasSerialMap = useMemo(() => {
    const map = new Map();
    if (!activeSession || !Array.isArray(activeSession.areas)) return map;
    const currentAreaId = checkingArea?.areaId || checkingArea?.id;
    for (const a of activeSession.areas) {
      const thisAreaId = a.areaId || a.id;
      if (currentAreaId && thisAreaId && String(thisAreaId) === String(currentAreaId)) continue;
      if (!Array.isArray(a.items)) continue;
      for (const it of a.items) {
        if (!Array.isArray(it.scannedSerials)) continue;
        for (const sn of it.scannedSerials) {
          if (sn) {
            map.set(String(sn).trim().toLowerCase(), {
              areaName: a.name || a.areaName || 'Area Lain',
              itemName: it.name || it.sku || 'Barang',
            });
          }
        }
      }
    }
    return map;
  }, [activeSession, checkingArea?.areaId, checkingArea?.id]);

  // Handler: Proses Barcode / Serial Number secara Seketika (Satset 0ms)
  const handleEnqueueBarcode = async (rawCode, { source = 'input' } = {}) => {
    const raw = String(rawCode || '').trim();
    if (!raw) return;

    // ── RESET INPUT LANGSUNG (0ms) ──
    if (barcodeInputRef.current) {
      barcodeInputRef.current.value = '';
    }
    setBarcodeInput('');

    // Dukung input multi-line jika barcode scanner menembak deretan barcode sekaligus
    const codes = raw.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    if (codes.length === 0) return;

    const now = Date.now();
    const validCodes = [];
    for (const c of codes) {
      const lastScanTime = scanCooldownMap.current.get(c.toLowerCase()) || 0;
      if (source === 'camera' && now - lastScanTime < 1800) {
        continue;
      }
      scanCooldownMap.current.set(c.toLowerCase(), now);
      validCodes.push(c);
    }

    if (validCodes.length === 0) return;

    // SATSET FAST-PATH: Langsung eksekusi pemrosesan tanpa delay event loop
    for (const c of validCodes) {
      await processSingleScan({
        id: crypto.randomUUID(),
        code: c,
        source,
        enqueuedAt: Date.now(),
      });
    }

    if (source === 'input') {
      setTimeout(() => barcodeInputRef.current?.focus(), 20);
    }
  };

  // Alias kompatibilitas
  const handleScanBarcode = handleEnqueueBarcode;

  // Queue Worker: Memproses antrean scan secara FIFO dan update UI real-time
  useEffect(() => {
    if (scanQueue.length === 0 || isProcessingScanQueueRef.current) return;

    const runQueue = async () => {
      if (scanQueue.length === 0 || isProcessingScanQueueRef.current) return;
      isProcessingScanQueueRef.current = true;

      const currentItem = scanQueue[0];
      setActiveScanItem({
        ...currentItem,
        startedAt: Date.now(),
        step: 'Memvalidasi data inventaris...',
      });

      try {
        await processSingleScan(currentItem);
      } catch (err) {
        console.error('Scan processing error:', err);
      } finally {
        setActiveScanItem(null);
        setScanQueue((prev) => prev.filter((it) => it.id !== currentItem.id));
        isProcessingScanQueueRef.current = false;
        // Jaga kursor barcode gun tetap fokus di input field
        setTimeout(() => barcodeInputRef.current?.focus(), 40);
      }
    };

    runQueue();
  }, [scanQueue]);

  // Eksekusi Pemrosesan Single Scan Barcode / Serial
  const processSingleScan = async (queueItem) => {
    const code = String(queueItem.code || '').trim();
    if (!code) return;
    const cleanLower = code.toLowerCase();

    // 1. Cek duplikasi di area ini (Anti Double-Scan) secara instan O(1)
    const duplicateInCurrentArea = scannedSerialsInCurrentAreaMapRef.current.get(cleanLower);
    if (duplicateInCurrentArea || scannedSerialsInCurrentAreaRef.current.has(cleanLower)) {
      playBeep('duplicate');
      const msg = `⚠️ Nomor seri "${code}" duplikat! Sudah pernah di-scan pada barang "${duplicateInCurrentArea?.name || 'Item'}" di area ini!`;
      setScanNotification({ type: 'warning', message: msg });
      setTimeout(() => setScanNotification(null), 4000);
      setRecentScanFeed((prev) => [
        {
          id: crypto.randomUUID(),
          code,
          status: 'warning',
          title: 'Nomor Seri Duplikat',
          detail: `Sudah di-scan pada "${duplicateInCurrentArea?.name || 'Barang'}" di area ini`,
          time: new Date(),
        },
        ...prev.slice(0, 19),
      ]);
      return;
    }

    // Cek duplikasi di area/rak lain dalam sesi opname yang sama secara instan O(1) (0ms)
    const duplicateInOtherArea = otherAreasSerialMap.get(cleanLower);
    if (duplicateInOtherArea) {
      playBeep('duplicate');
      const msg = `⚠️ Nomor seri "${code}" duplikat! Sudah pernah dicatat di area "${duplicateInOtherArea.areaName}" (${duplicateInOtherArea.itemName || 'Barang'})!`;
      setScanNotification({ type: 'warning', message: msg });
      setTimeout(() => setScanNotification(null), 4500);
      setRecentScanFeed((prev) => [
        {
          id: crypto.randomUUID(),
          code,
          status: 'warning',
          title: 'Duplikat Antar-Area',
          detail: `Sudah dicatat di area "${duplicateInOtherArea.areaName}" (${duplicateInOtherArea.itemName || 'Barang'})`,
          time: new Date(),
        },
        ...prev.slice(0, 19),
      ]);
      return;
    }

    // 2. FAST-PATH 1: Cek ke serialIndexLookupMap secara instan di memori (0ms)
    const cachedSerial = serialIndexLookupMap.get(cleanLower);

    let detectedProduct = null;
    let detectedUnit = 'pcs';
    let unitMultiplier = 1;
    let isDirectSkuScan = false;

    if (cachedSerial) {
      // FAST-PATH HIT DARI DATABASE SERIAL (<1ms)
      if (cachedSerial.status && cachedSerial.status !== 'available') {
        playBeep('error');
        const msg = `⚠️ Nomor seri "${code}" sudah keluar dari gudang (status: ${cachedSerial.status}) dan tidak tersedia dalam stok fisik!`;
        setScanNotification({ type: 'error', message: msg });
        setTimeout(() => setScanNotification(null), 4500);
        setRecentScanFeed((prev) => [
          {
            id: crypto.randomUUID(),
            code,
            status: 'error',
            title: 'Barang Sudah Keluar',
            detail: `Status sistem: ${cachedSerial.status} (tidak tersedia dalam stok fisik)`,
            time: new Date(),
          },
          ...prev.slice(0, 19),
        ]);
        return;
      }

      if (cachedSerial.productId) {
        detectedProduct = productsById.get(cachedSerial.productId);
      }
      if (!detectedProduct) {
        detectedProduct = detectSerialInfo(code, products, customUnits, getMultiplier)?.matchedProduct;
      }

      detectedUnit = getSerialUnit(null, code);
      unitMultiplier = Number(getMultiplier(detectedUnit)) || 1;
    } else {
      // FAST-PATH 2: Deteksi in-memory langsung dari SKU katalog atau format penomoran serial (0ms)
      const directSkuMatch = productsBySku.get(cleanLower);
      const parsedSerialInfo = detectSerialInfo(code, products, customUnits, getMultiplier);

      if (directSkuMatch) {
        isDirectSkuScan = true;
        detectedProduct = directSkuMatch;
        detectedUnit = directSkuMatch.unitKey || directSkuMatch.unit || 'pcs';
        unitMultiplier = Number(getMultiplier(detectedUnit)) || 1;
      } else if (parsedSerialInfo?.matchedProduct) {
        detectedProduct = parsedSerialInfo.matchedProduct;
        detectedUnit = parsedSerialInfo.detectedUnit || 'pcs';
        unitMultiplier = Number(parsedSerialInfo.multiplier) || 1;
      } else {
        // SLOW-PATH FALLBACK: Lookup ke server backend jika belum terpetakan
        setActiveScanItem((prev) => ({ ...(prev || queueItem), step: 'Mencari di server database...' }));
        try {
          const whParam = activeWarehouseId ? `&warehouse_id=${encodeURIComponent(activeWarehouseId)}` : '';
          const res = await api.get(`/api/workspace/product-serial-lookup?serial=${encodeURIComponent(code)}&purpose=stock_opname${whParam}`);
          if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            const errMsg = errJson?.message || '';

            playBeep('error');
            const alertMsg = errMsg || `❌ Nomor seri / barcode "${code}" tidak ditemukan dalam data inventaris gudang!`;
            setScanNotification({ type: 'error', message: alertMsg });
            setTimeout(() => setScanNotification(null), 4500);
            setRecentScanFeed((prev) => [
              {
                id: crypto.randomUUID(),
                code,
                status: 'error',
                title: 'Tidak Ditemukan',
                detail: errMsg || 'Tidak terdaftar di inventaris database gudang',
                time: new Date(),
              },
              ...prev.slice(0, 19),
            ]);
            return;
          }

          const json = await res.json();
          const sObj = json.data || json.serial;

          if (!sObj) {
            playBeep('error');
            setScanNotification({
              type: 'error',
              message: `❌ Nomor seri "${code}" tidak ditemukan dalam data inventaris gudang!`,
            });
            setTimeout(() => setScanNotification(null), 4500);
            setRecentScanFeed((prev) => [
              { id: crypto.randomUUID(), code, status: 'error', title: 'Tidak Ditemukan', detail: 'Data serial tidak ditemukan', time: new Date() },
              ...prev.slice(0, 19),
            ]);
            return;
          }

          if (sObj.status && sObj.status !== 'available') {
            playBeep('error');
            setScanNotification({
              type: 'error',
              message: `⚠️ Nomor seri "${code}" sudah keluar dari gudang (status: ${sObj.status}) dan tidak ada dalam stok fisik!`,
            });
            setTimeout(() => setScanNotification(null), 4500);
            setRecentScanFeed((prev) => [
              { id: crypto.randomUUID(), code, status: 'error', title: 'Barang Sudah Keluar', detail: `Status: ${sObj.status}`, time: new Date() },
              ...prev.slice(0, 19),
            ]);
            return;
          }

          const pObj = sObj.product || sObj.products;
          detectedProduct = productsById.get(sObj.product_id || sObj.productId) || (pObj ? {
            id: pObj.id || sObj.product_id,
            name: pObj.name,
            sku: pObj.sku,
            unitKey: pObj.unitKey || pObj.unit || 'pcs',
            stock: Number(pObj.stock) || 0,
          } : null);

          if (!detectedProduct && sObj.product_id) {
            detectedProduct = productsById.get(sObj.product_id);
          }

          detectedUnit = getSerialUnit(null, code);
          unitMultiplier = Number(getMultiplier(detectedUnit)) || 1;
        } catch (networkErr) {
          playBeep('error');
          setScanNotification({
            type: 'error',
            message: `❌ Terjadi kesalahan jaringan saat memvalidasi nomor seri "${code}".`,
          });
          setTimeout(() => setScanNotification(null), 4500);
          setRecentScanFeed((prev) => [
            { id: crypto.randomUUID(), code, status: 'error', title: 'Kesalahan Jaringan', detail: networkErr.message || 'Gagal koneksi ke server', time: new Date() },
            ...prev.slice(0, 19),
          ]);
          return;
        }
      }
    }

    if (!detectedProduct) {
      playBeep('error');
      setScanNotification({
        type: 'error',
        message: `❌ Nomor seri / barcode "${code}" tidak dapat dipetakan ke data produk katalog mana pun!`,
      });
      setTimeout(() => setScanNotification(null), 4500);
      setRecentScanFeed((prev) => [
        { id: crypto.randomUUID(), code, status: 'error', title: 'SKU Tidak Cocok', detail: 'Tidak dapat dipetakan ke produk katalog', time: new Date() },
        ...prev.slice(0, 19),
      ]);
      return;
    }

    // 3. Tambahkan serial / barcode ke checklist area secara instan
    scannedSerialsInCurrentAreaRef.current.add(cleanLower);
    scannedSerialsInCurrentAreaMapRef.current.set(cleanLower, {
      itemId: detectedProduct.id,
      name: detectedProduct.name,
      sku: detectedProduct.sku,
    });

    setCheckingItems((prev) => {
      const matchIdx = prev.findIndex((it) =>
        (detectedProduct && it.productId && it.productId === detectedProduct.id) ||
        (detectedProduct?.sku && it.sku && it.sku.toLowerCase() === detectedProduct.sku.toLowerCase())
      );

      if (matchIdx !== -1) {
        const existing = prev[matchIdx];
        const updated = [...prev];

        if (isDirectSkuScan) {
          const currentEntries = Array.isArray(existing.manualEntries) && existing.manualEntries.length > 0
            ? [...existing.manualEntries]
            : (existing.inputVal ? [{ qty: existing.inputVal, unit: existing.inputUnit || 'pcs' }] : []);

          const entryIdx = currentEntries.findIndex((e) => (e.unit || 'pcs').toLowerCase() === detectedUnit.toLowerCase());
          if (entryIdx !== -1) {
            currentEntries[entryIdx] = {
              ...currentEntries[entryIdx],
              qty: (Number(currentEntries[entryIdx].qty) || 0) + 1,
            };
          } else {
            currentEntries.push({ qty: 1, unit: detectedUnit });
          }

          updated[matchIdx] = {
            ...existing,
            manualEntries: currentEntries,
            inputVal: '',
          };
        } else {
          updated[matchIdx] = {
            ...existing,
            scannedSerials: [...(existing.scannedSerials || []), code],
            serialUnits: {
              ...(existing.serialUnits || {}),
              [code]: detectedUnit,
              [cleanLower]: detectedUnit,
            },
          };
        }
        return updated;
      }

      // Jika belum ada di daftar area, tambahkan produk baru ke checklist
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          productId: detectedProduct.id,
          sku: detectedProduct.sku,
          name: detectedProduct.name,
          unit: detectedProduct.unitKey || detectedProduct.unit || 'pcs',
          systemQty: Number(detectedProduct.stock) || 0,
          inputVal: '',
          inputUnit: 'pcs',
          notes: '',
          isUnlisted: false,
          scannedSerials: isDirectSkuScan ? [] : [code],
          serialUnits: isDirectSkuScan ? {} : {
            [code]: detectedUnit,
            [cleanLower]: detectedUnit,
          },
          manualEntries: isDirectSkuScan ? [{ qty: 1, unit: detectedUnit }] : [],
        },
      ];
    });

    playBeep('success');
    setScanNotification({
      type: 'success',
      message: `✅ Berhasil scan: ${code} (${detectedProduct?.name || 'Produk'} +${unitMultiplier} ${detectedUnit})`,
    });
    setTimeout(() => setScanNotification(null), 3500);

    setRecentScanFeed((prev) => [
      {
        id: crypto.randomUUID(),
        code,
        status: 'success',
        title: isDirectSkuScan ? 'Scan SKU Produk' : 'Scan Nomor Seri',
        detail: `${detectedProduct.name} (+${unitMultiplier} ${detectedUnit})`,
        sku: detectedProduct.sku,
        time: new Date(),
      },
      ...prev.slice(0, 19),
    ]);
  };

  // Handler: Hapus nomor seri yang salah di-scan
  const handleRemoveScannedSerial = (itemId, snToRemove) => {
    const cleanLower = String(snToRemove || '').trim().toLowerCase();
    scannedSerialsInCurrentAreaRef.current.delete(cleanLower);
    scannedSerialsInCurrentAreaMapRef.current.delete(cleanLower);

    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const newSerials = (it.scannedSerials || []).filter((s) => s !== snToRemove);
        const newUnits = { ...(it.serialUnits || {}) };
        delete newUnits[snToRemove];
        return {
          ...it,
          inputVal: newSerials.length === 0 ? '0' : it.inputVal,
          inputUnit: 'pcs',
          scannedSerials: newSerials,
          serialUnits: newUnits,
        };
      })
    );
  };

  // Handler: Buat Dokumen Otomatis (Goods Out untuk Kurang [Draf], Goods In untuk Lebih)
  const handleCreateAutomaticDocument = async (type = 'goods_out', specificItem = null) => {
    if (isGeneratingDoc || !activeSession) return;
    setIsGeneratingDoc(true);
    try {
      const isGoodsOut = type === 'goods_out';
      const targetItems = specificItem
        ? [specificItem]
        : (isGoodsOut
          ? discrepancyItems.filter((it) => it.status === 'shortage' || it.difference < 0)
          : discrepancyItems.filter((it) => it.status === 'overage' || it.status === 'unlisted' || it.difference > 0)
        );

      if (targetItems.length === 0) {
        alert(`Tidak ada barang ${isGoodsOut ? 'kurang (hilang)' : 'lebih (temuan)'} untuk dibuatkan dokumen.`);
        return;
      }

      const todayISO = new Date().toISOString().split('T')[0];
      const todayFormatted = todayISO.replace(/-/g, '');
      const existingCount = allWorkspaceDocs.filter((d) => (d.documentType || d.document_type) === type).length;
      const refNum = buildDocumentNumber(type, todayISO, existingCount, settings) ||
        `${isGoodsOut ? 'GO' : 'GI'}/${todayFormatted}/${String(Math.floor(Math.random() * 9000) + 1000)}`;

      const contactName = isGoodsOut
        ? `Penyesuaian SO ${activeSession.sessionNumber} (${activeWarehouse?.name || 'semua gudang'})`
        : `Temuan SO ${activeSession.sessionNumber} (${activeWarehouse?.name || 'semua gudang'})`;

      const docItems = targetItems.map((item, idx) => {
        const dbSerials = productSerialsMap.get(item.productId) || [];
        const allSnList = dbSerials.map((s) => s.serialNumber);
        const missingSn = allSnList.filter((sn) => !(item.scannedSerials || []).includes(sn) && !isSerialFromSoGoodsIn(sn));
        const qtyAdjust = Math.max(1, Math.abs(item.difference || item.physicalQty || 1));

        return {
          productId: item.productId || null,
          itemName: item.name,
          sku: item.sku || '',
          quantity: qtyAdjust,
          unitPrice: 0,
          discountType: 'none',
          discountValue: 0,
          amount: 0,
          sortOrder: idx,
          metadata: {
            isSerial: isGoodsOut ? missingSn.length > 0 : false,
            qtyUnit: 'pcs',
            unitName: 'pcs',
            unitMultiplier: 1,
            qtyInput: qtyAdjust,
            baseQuantity: qtyAdjust,
            serialNumbers: isGoodsOut ? missingSn : (item.scannedSerials || []),
            soSessionNumber: activeSession.sessionNumber,
            reason: isGoodsOut ? 'Stock Opname Write-Off (Barang Hilang / Kurang)' : 'Stock Opname Inflow (Barang Lebih)',
          },
        };
      });

      const res = await api.post('/api/workspace/documents', {
        documentType: type,
        documentNumber: refNum,
        warehouseId: activeWarehouseId || undefined,
        contactId: null,
        contactName,
        status: isGoodsOut ? 'draft' : 'completed', // Barang Kurang SELALU dibuat Draf terlebih dahulu agar bisa dicek
        issueDate: todayISO,
        notes: `Penyesuaian hasil Stock Opname ${activeSession.sessionNumber} (${activeSession.title || ''}) - ${isGoodsOut ? 'Pengeluaran Stok Hilang/Kurang [Draf]' : 'Penerimaan Stok Lebih/Temuan'}`,
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 0,
        items: docItems,
        metadata: {
          source: 'stock_opname',
          stock_opname_session_id: activeSession.id,
          stock_opname_session_number: activeSession.sessionNumber,
        },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.message || `Gagal membuat dokumen ${isGoodsOut ? 'Goods Out' : 'Goods In'}`);
      }

      const docJson = await res.json();
      const createdDoc = docJson.data;
      const officialDocNumber = createdDoc?.document_number || createdDoc?.documentNumber || refNum;

      // Tandai barang target sebagai diselesaikan / dikeluarkan dari daftar masalah aktif
      setResolvedDiscrepancyIds((prev) => {
        const next = new Set(prev);
        targetItems.forEach((it) => {
          if (it.sku) next.add(it.sku);
          if (it.productId) next.add(it.productId);
        });
        return next;
      });

      // Simpan informasi dokumen ke tracking lokal agar langsung kedeteksi seketika
      setCreatedDocBySku((prev) => {
        const next = { ...prev };
        targetItems.forEach((it) => {
          const dbSerials = productSerialsMap.get(it.productId) || [];
          const allSnList = dbSerials.map((s) => s.serialNumber);
          const missingSn = allSnList.filter((sn) => !(it.scannedSerials || []).includes(sn) && !isSerialFromSoGoodsIn(sn));
          const qtyAdjust = Math.max(1, Math.abs(it.difference || it.physicalQty || 1));
          const docData = {
            type,
            documentNumber: officialDocNumber,
            documentId: createdDoc?.id,
            status: isGoodsOut ? 'draft' : 'completed',
            qty: qtyAdjust,
            unit: 'pcs',
            totalPcs: qtyAdjust,
            serials: isGoodsOut ? missingSn : (it.scannedSerials || []),
            contactName,
          };
          if (it.sku) next[String(it.sku).toUpperCase()] = docData;
          if (it.productId) next[it.productId] = docData;
        });
        return next;
      });

      queryClient.invalidateQueries({ queryKey: [isGoodsOut ? 'goods-out' : 'goods-in'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
      queryClient.invalidateQueries({ queryKey: ['product-serials'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });

      playBeep('success');
      setGeneratedDocNotice({
        type,
        documentNumber: officialDocNumber,
        itemCount: docItems.length,
        status: isGoodsOut ? 'draft' : 'completed',
        message: isGoodsOut
          ? `Dokumen Draf Goods Out (${officialDocNumber}) berhasil dibuat! Barang telah dikeluarkan dari daftar masalah aktif agar Anda dapat mengeceknya terlebih dahulu di modul Goods Out.`
          : `Dokumen Goods In (${officialDocNumber}) berhasil dibuat!`,
      });
    } catch (err) {
      playBeep('error');
      alert(err.message || 'Gagal memproses pembuatan dokumen');
    } finally {
      setIsGeneratingDoc(false);
    }
  };

  const handleAddInlineProductToArea = () => {
    if (!inlineSelectedProduct) {
      alert('Pilih produk dari katalog terlebih dahulu.');
      return;
    }
    const qtyNum = Number(inlinePhysicalQty);
    if (isNaN(qtyNum) || qtyNum < 0) {
      alert('Masukkan jumlah fisik yang valid (angka 0 atau lebih).');
      return;
    }

    const selectedUnit = inlineUnit || inlineSelectedProduct.unitKey || inlineSelectedProduct.unit || 'pcs';

    setCheckingItems((prev) => {
      const existsIdx = prev.findIndex(
        (it) => it.productId === inlineSelectedProduct.id || (it.sku && it.sku.toLowerCase() === inlineSelectedProduct.sku.toLowerCase())
      );

      if (existsIdx !== -1) {
        // Produk SUDAH ADA di daftar area
        const existing = prev[existsIdx];
        const updated = [...prev];
        const entries = Array.isArray(existing.manualEntries) ? [...existing.manualEntries] : [];

        // 1. Cek apakah sudah ada entri dengan satuan yang sama
        const sameUnitEntryIdx = entries.findIndex((e) => e.unit === selectedUnit);
        if (sameUnitEntryIdx !== -1) {
          const prevQty = Number(entries[sameUnitEntryIdx].qty || 0);
          entries[sameUnitEntryIdx] = {
            ...entries[sameUnitEntryIdx],
            qty: String(prevQty + qtyNum),
          };
        } else {
          // 2. Satuan berbeda!
          // Cek apakah ada entri kosong (belum diisi qty) yang bisa dipakai
          const emptyIdx = entries.findIndex((e) => String(e.qty ?? '').trim() === '' || Number(e.qty) === 0);
          if (emptyIdx !== -1 && entries.length === 1 && (!existing.scannedSerials || existing.scannedSerials.length === 0)) {
            entries[emptyIdx] = {
              ...entries[emptyIdx],
              qty: String(qtyNum),
              unit: selectedUnit,
            };
          } else {
            // Tambahkan entri baru sebagai baris terpisah (atas-bawah)
            entries.push({
              id: crypto.randomUUID(),
              qty: String(qtyNum),
              unit: selectedUnit,
            });
          }
        }

        const firstEntry = entries[0] || { qty: String(qtyNum), unit: selectedUnit };
        updated[existsIdx] = {
          ...existing,
          manualEntries: entries,
          manualQty: firstEntry.qty,
          manualUnit: firstEntry.unit,
          inputVal: firstEntry.qty,
          inputUnit: firstEntry.unit,
        };
        return updated;
      }

      // Produk belum ada sama sekali di checklist area ini
      const newEntry = {
        id: crypto.randomUUID(),
        qty: String(qtyNum),
        unit: selectedUnit,
      };

      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          productId: inlineSelectedProduct.id,
          sku: inlineSelectedProduct.sku,
          name: inlineSelectedProduct.name,
          unit: inlineSelectedProduct.unitKey || inlineSelectedProduct.unit || 'pcs',
          systemQty: Number(inlineSelectedProduct.stock) || 0,
          manualEntries: [newEntry],
          manualQty: String(qtyNum),
          manualUnit: selectedUnit,
          inputVal: String(qtyNum),
          inputUnit: selectedUnit,
          notes: '',
          isUnlisted: false,
          scannedSerials: [],
          serialUnits: {},
        },
      ];
    });

    playBeep('success');
    setScanNotification({
      type: 'success',
      message: `✅ Ditambahkan manual (non-seri): ${inlineSelectedProduct.name} (+${qtyNum} ${formatUnitOption(selectedUnit)})`,
    });
    setTimeout(() => setScanNotification(null), 3500);

    setInlineSelectedProduct(null);
    setInlineAddSearch('');
    setInlinePhysicalQty('');
  };

  const handleRemoveCheckingItem = (itemId) => {
    setCheckingItems((prev) => prev.filter((it) => it.id !== itemId));
  };

  // Handler manipulasi per-baris manual entry (multi satuan non-seri)
  const handleManualEntryQtyChange = (itemId, entryId, val) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const currentEntries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
          ? it.manualEntries
          : [{ id: entryId, qty: '', unit: it.manualUnit || 'pcs' }];
        const newEntries = currentEntries.map((e) => (e.id === entryId ? { ...e, qty: val } : e));
        const firstEntry = newEntries[0];
        return {
          ...it,
          manualEntries: newEntries,
          manualQty: firstEntry?.qty ?? '',
          manualUnit: firstEntry?.unit ?? 'pcs',
          inputVal: firstEntry?.qty ?? '',
          inputUnit: firstEntry?.unit ?? 'pcs',
        };
      })
    );
  };

  const handleManualEntryUnitChange = (itemId, entryId, unitKey) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const currentEntries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
          ? it.manualEntries
          : [{ id: entryId, qty: '', unit: unitKey }];
        const newEntries = currentEntries.map((e) => (e.id === entryId ? { ...e, unit: unitKey } : e));
        const firstEntry = newEntries[0];
        return {
          ...it,
          manualEntries: newEntries,
          manualQty: firstEntry?.qty ?? '',
          manualUnit: firstEntry?.unit ?? unitKey,
          inputVal: firstEntry?.qty ?? '',
          inputUnit: firstEntry?.unit ?? unitKey,
        };
      })
    );
  };

  const handleAddManualEntry = (itemId, defaultUnit = 'pcs') => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const currentEntries = Array.isArray(it.manualEntries) ? [...it.manualEntries] : [];
        const newEntry = {
          id: crypto.randomUUID(),
          qty: '',
          unit: defaultUnit || it.unit || 'pcs',
        };
        return {
          ...it,
          manualEntries: [...currentEntries, newEntry],
        };
      })
    );
  };

  const handleRemoveManualEntry = (itemId, entryId) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const currentEntries = Array.isArray(it.manualEntries) ? it.manualEntries : [];
        if (currentEntries.length <= 1) {
          const cleared = currentEntries.map((e) => ({ ...e, qty: '' }));
          return {
            ...it,
            manualEntries: cleared,
            manualQty: '',
            inputVal: '',
          };
        }
        const filtered = currentEntries.filter((e) => e.id !== entryId);
        const firstEntry = filtered[0];
        return {
          ...it,
          manualEntries: filtered,
          manualQty: firstEntry?.qty ?? '',
          manualUnit: firstEntry?.unit ?? 'pcs',
          inputVal: firstEntry?.qty ?? '',
          inputUnit: firstEntry?.unit ?? 'pcs',
        };
      })
    );
  };

  // Fallback single handlers (backward compatibility)
  const handleItemUnitChange = (itemId, unitKey) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const entries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
          ? it.manualEntries.map((e, idx) => (idx === 0 ? { ...e, unit: unitKey } : e))
          : [{ id: crypto.randomUUID(), qty: '', unit: unitKey }];
        return {
          ...it,
          inputUnit: unitKey,
          manualUnit: unitKey,
          manualEntries: entries,
        };
      })
    );
  };

  const handleItemCountChange = (itemId, val) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const entries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
          ? it.manualEntries.map((e, idx) => (idx === 0 ? { ...e, qty: val } : e))
          : [{ id: crypto.randomUUID(), qty: val, unit: it.manualUnit || 'pcs' }];
        return {
          ...it,
          inputVal: val,
          manualQty: val,
          manualEntries: entries,
        };
      })
    );
  };

  const handleSetQuickItemCount = (itemId, targetQty) => {
    setCheckingItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const entries = [
          {
            id: crypto.randomUUID(),
            qty: String(targetQty),
            unit: it.unit || 'pcs',
          },
        ];
        return {
          ...it,
          inputVal: String(targetQty),
          manualQty: String(targetQty),
          inputUnit: it.unit || 'pcs',
          manualUnit: it.unit || 'pcs',
          manualEntries: entries,
        };
      })
    );
  };

  const handleSetAllMatched = () => {
    setCheckingItems((prev) =>
      prev.map((it) => ({
        ...it,
        manualEntries: [
          {
            id: `m_match_${it.id}`,
            qty: String(it.systemQty),
            unit: it.unit || 'pcs',
          },
        ],
        inputVal: String(it.systemQty),
        manualQty: String(it.systemQty),
        inputUnit: it.unit || 'pcs',
        manualUnit: it.unit || 'pcs',
        scannedSerials: [],
        serialUnits: {},
      }))
    );
  };

  const handleSaveAreaCount = async (markCompleted = false) => {
    if (!activeSession || !checkingArea || isSavingCount) return;

    const payloadItems = checkingItems.map((it) => {
      const hasSerials = Array.isArray(it.scannedSerials) && it.scannedSerials.length > 0;
      const num = computeItemPcs(it);
      const entries = Array.isArray(it.manualEntries)
        ? (hasSerials ? it.manualEntries.filter((e) => !String(e.id || '').startsWith('m_legacy_')) : it.manualEntries)
        : [];
      const firstNonEmpty = entries.find((e) => String(e.qty ?? '').trim() !== '' && Number(e.qty) > 0);
      return {
        id: it.id,
        productId: it.productId,
        sku: it.sku,
        name: it.name,
        unit: it.unit,
        physicalQty: num,
        systemQty: Number(it.systemQty) || 0,
        notes: it.notes || '',
        isUnlisted: Boolean(it.isUnlisted),
        scannedSerials: Array.isArray(it.scannedSerials) ? it.scannedSerials : [],
        serialUnits: it.serialUnits || {},
        manualEntries: entries,
        manualQty: firstNonEmpty ? firstNonEmpty.qty : (hasSerials ? null : (it.manualQty ?? null)),
        manualUnit: firstNonEmpty ? firstNonEmpty.unit : (it.manualUnit || 'pcs'),
      };
    });

    setIsSavingCount(true);
    setSavingCountAction(markCompleted ? 'complete' : 'draft');
    try {
      await saveAreaPhysicalCount(activeSession.id, {
        areaId: checkingArea.areaId,
        items: payloadItems,
        markCompleted,
      });
      await refetchSessionDetail();
      setCheckingArea(null);
      setCheckingItems([]);
    } catch (err) {
      alert(err.message || 'Gagal menyimpan hasil hitungan');
    } finally {
      setIsSavingCount(false);
      setSavingCountAction(null);
    }
  };

  // Handler: Konfirmasi Popup sebelum menyelesaikan pengecekan area
  const handlePromptCompleteArea = () => {
    setConfirmDialog({
      title: 'Konfirmasi Selesaikan Pengecekan Area',
      message: `Apakah Anda yakin seluruh fisik barang di area "${checkingArea?.name || checkingArea?.areaName || 'ini'}" sudah selesai dihitung dan diperiksa dengan benar? Status area akan ditandai sebagai Selesai.`,
      confirmLabel: 'Ya, Selesaikan Area Ini',
      cancelLabel: 'Batal / Periksa Lagi',
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleSaveAreaCount(true);
      },
    });
  };

  // Handler: Hapus seluruh hasil pemeriksaan fisik di area ini untuk Stock Opname ulang dari awal
  const handleResetAreaForRecount = () => {
    if (!activeSession || !checkingArea || isSavingCount) return;

    setConfirmDialog({
      title: 'Hapus Hasil Pemeriksaan Area Ini?',
      message: `Apakah Anda yakin ingin menghapus seluruh hasil hitungan dan pemeriksaan fisik di bagian/area "${checkingArea.name || checkingArea.areaName || 'ini'}"? Seluruh data fisik yang telah dicatat di area ini akan dikosongkan agar Anda dapat melakukan Stock Opname ulang dari awal.`,
      confirmLabel: 'Ya, Hapus & SO Ulang',
      cancelLabel: 'Batal',
      isDanger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        setIsSavingCount(true);
        try {
          const areaTargetId = checkingArea.areaId || checkingArea.id;
          const currentAreaInSession = activeSession.areas?.find((a) => (a.areaId || a.id) === areaTargetId) || checkingArea;

          // Reset items: kembalikan item dasar ke status awal (belum dihitung) dan bersihkan temuan unlisted
          const resetItems = (currentAreaInSession.items || [])
            .filter((it) => !it.isUnlisted)
            .map((it) => ({
              id: it.id,
              productId: it.productId,
              sku: it.sku,
              name: it.name,
              unit: it.unit,
              systemQty: Number(it.systemQty) || 0,
              physicalQty: null,
              difference: 0,
              status: 'pending',
              notes: '',
              isUnlisted: false,
              scannedSerials: [],
              manualEntries: [],
              manualQty: null,
              manualUnit: it.unit || 'pcs',
            }));

          await saveAreaPhysicalCount(activeSession.id, {
            areaId: areaTargetId,
            items: resetItems,
            markCompleted: false,
            replaceItems: true,
          });

          await queryClient.invalidateQueries({ queryKey: ['stock-opname-session-detail', activeSession.id] });
          await refetchSessionDetail();
          handleCloseCheckingModal();

          playBeep('success');
          setScanNotification({
            type: 'info',
            message: `🔄 Hasil pemeriksaan area "${checkingArea.name || checkingArea.areaName || ''}" telah berhasil dihapus. Silakan lakukan Stock Opname ulang dari awal.`,
          });
          setTimeout(() => setScanNotification(null), 4500);
        } catch (err) {
          alert(err.message || 'Gagal menghapus hasil pemeriksaan area');
        } finally {
          setIsSavingCount(false);
        }
      },
    });
  };

  // Handler: Konversi temuan fisik non-seri menjadi Dokumen Barang Masuk (Goods In) resmi (NON-SERI)
  const handleImportNonSerialToGoodsIn = (item, entry) => {
    const qtyVal = Number(entry?.qty);
    if (isNaN(qtyVal) || qtyVal <= 0) {
      alert('Kuantitas fisik non-seri harus lebih dari 0 untuk dibuatkan dokumen Barang Masuk (Goods In).');
      return;
    }

    const unitKey = entry?.unit || 'pcs';
    const mult = Number(getMultiplier(unitKey)) || 1;
    const totalPcs = qtyVal * mult;

    setConfirmDialog({
      title: 'Jadikan Barang Masuk (Goods In Non-Seri)?',
      message: `Buat dokumen Barang Masuk (Goods In) resmi untuk "${item.name}" sebanyak ${qtyVal} ${formatUnitOption(unitKey)} (${totalPcs.toLocaleString('id-ID')} pcs) di gudang aktif sebagai barang non-seri (tanpa membuat serial number)?`,
      confirmLabel: 'Ya, Buat Goods In Non-Seri',
      cancelLabel: 'Batal',
      onConfirm: async () => {
        setConfirmDialog(null);
        setIsImportingGoodsIn(true);
        try {
          const todayISO = new Date().toISOString().split('T')[0];
          const todayFormatted = todayISO.replace(/-/g, '');
          const existingCount = allWorkspaceDocs.filter((d) => (d.documentType || d.document_type) === 'goods_in').length;
          const giDocNumber = buildDocumentNumber('goods_in', todayISO, existingCount, settings) ||
            `GI/${todayFormatted}/${String(Math.floor(Math.random() * 9000) + 1000)}`;

          // 1. Buat Dokumen Goods In di backend (NON-SERI)
          const docPayload = {
            documentType: 'goods_in',
            documentNumber: giDocNumber,
            warehouseId: activeWarehouseId || undefined,
            contactId: null,
            contactName: `Temuan SO ${activeSession?.sessionNumber || ''} (${checkingArea?.name || checkingArea?.areaName || activeWarehouse?.name || 'semua gudang'})`,
            status: 'completed',
            issueDate: todayISO,
            notes: `Barang Masuk dari konversi temuan fisik non-seri Stock Opname ${activeSession?.sessionNumber || ''} (${checkingArea?.name || ''}) - ${qtyVal} ${unitKey} (${totalPcs} pcs)`,
            subtotal: 0,
            discount: 0,
            tax: 0,
            total: 0,
            items: [
              {
                productId: item.productId || null,
                itemName: item.name,
                sku: item.sku || '',
                quantity: totalPcs,
                unitPrice: 0,
                discountType: 'none',
                discountValue: 0,
                amount: 0,
                sortOrder: 0,
                metadata: {
                  isSerial: false,
                  qtyUnit: unitKey,
                  unitName: unitKey,
                  unitMultiplier: mult,
                  qtyInput: qtyVal,
                  baseQuantity: totalPcs,
                  serialNumbers: [],
                  source: 'stock_opname_conversion',
                  soSessionNumber: activeSession?.sessionNumber,
                  soAreaName: checkingArea?.name,
                },
              },
            ],
            metadata: {
              source: 'stock_opname_conversion',
              stock_opname_session_id: activeSession?.id,
              stock_opname_session_number: activeSession?.sessionNumber,
              stock_opname_area_id: checkingArea?.areaId,
            },
          };

          const docRes = await api.post('/api/workspace/documents', docPayload);
          if (!docRes.ok) {
            const errJson = await docRes.json().catch(() => ({}));
            throw new Error(errJson?.message || 'Gagal membuat dokumen Goods In');
          }
          const createdDoc = (await docRes.json())?.data;
          const officialDocNumber = createdDoc?.document_number || createdDoc?.documentNumber || giDocNumber;

          // 2. Update Checking Items
          const conversionInfo = {
            documentNumber: officialDocNumber,
            documentId: createdDoc?.id,
            qty: qtyVal,
            unit: unitKey,
            totalPcs,
            serials: [],
            convertedAt: new Date().toISOString(),
          };

          const updatedEntries = (item.manualEntries || []).map((e) => {
            if (e.id === entry.id) {
              return {
                ...e,
                qty: e.qty, // Pertahankan kuantitas fisik yang dihitung
                convertedToGoodsIn: conversionInfo,
              };
            }
            return e;
          });

          const updatedCheckingItems = checkingItems.map((it) => {
            if (it.id !== item.id) return it;
            return {
              ...it,
              manualEntries: updatedEntries,
              manualQty: updatedEntries[0]?.qty ?? '',
              inputVal: updatedEntries[0]?.qty ?? '',
            };
          });

          setCheckingItems(updatedCheckingItems);

          // 3. Simpan hasil hitungan terbaru ke backend
          const payloadSave = updatedCheckingItems.map((it) => {
            const num = computeItemPcs(it);
            const entries = Array.isArray(it.manualEntries) ? it.manualEntries : [];
            const firstNonEmpty = entries.find((e) => String(e.qty ?? '').trim() !== '') || entries[0];
            return {
              id: it.id,
              productId: it.productId,
              sku: it.sku,
              name: it.name,
              unit: it.unit,
              physicalQty: num,
              systemQty: Number(it.systemQty) || 0,
              notes: it.notes || '',
              isUnlisted: Boolean(it.isUnlisted),
              scannedSerials: it.scannedSerials || [],
              manualEntries: entries,
              manualQty: firstNonEmpty ? firstNonEmpty.qty : (it.manualQty ?? null),
              manualUnit: firstNonEmpty ? firstNonEmpty.unit : (it.manualUnit || 'pcs'),
            };
          });

          await saveAreaPhysicalCount(activeSession.id, {
            areaId: checkingArea.areaId,
            items: payloadSave,
            markCompleted: isAreaCompleted && !isEditingCompletedArea,
          });

          queryClient.invalidateQueries({ queryKey: ['goods-in'] });
          queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
          queryClient.invalidateQueries({ queryKey: ['products'] });
          await refetchSessionDetail();

          playBeep('success');
          setScanNotification({
            type: 'success',
            message: `🎉 Berhasil! "${item.name}" (${qtyVal} ${formatUnitOption(unitKey)}) telah resmi dibuatkan Dokumen Barang Masuk (${officialDocNumber}) sebagai non-seri!`,
          });
          setTimeout(() => setScanNotification(null), 6000);
        } catch (err) {
          playBeep('error');
          alert(err.message || 'Gagal mengubah barang non-seri menjadi Goods In');
        } finally {
          setIsImportingGoodsIn(false);
        }
      },
    });
  };

  // Handler: Konversi SELURUH temuan fisik non-seri di area ini menjadi Dokumen Barang Masuk (Goods In) resmi (NON-SERI)
  const handleImportAllNonSerialsToGoodsIn = () => {
    if (unimportedNonSerialTargets.length === 0) {
      alert('Tidak ada barang fisik non-seri yang perlu di-import ke Goods In di area ini.');
      return;
    }

    const totalPcsAll = unimportedNonSerialTargets.reduce((sum, t) => sum + t.totalPcs, 0);
    const uniqueProductsCount = new Set(unimportedNonSerialTargets.map((t) => t.item.id)).size;

    setConfirmDialog({
      title: 'Jadikan Goods In Keseluruhan (Non-Seri)?',
      message: `Buat 1 dokumen Barang Masuk (Goods In) resmi untuk seluruh ${unimportedNonSerialTargets.length} baris temuan non-seri (${uniqueProductsCount} jenis barang, total ${totalPcsAll.toLocaleString('id-ID')} pcs) di gudang aktif sebagai barang non-seri (tanpa membuat nomor seri otomatis)?`,
      confirmLabel: 'Ya, Buat Goods In Non-Seri',
      cancelLabel: 'Batal',
      onConfirm: async () => {
        setConfirmDialog(null);
        setIsImportingGoodsIn(true);
        try {
          const todayISO = new Date().toISOString().split('T')[0];
          const todayFormatted = todayISO.replace(/-/g, '');
          const existingCount = allWorkspaceDocs.filter((d) => (d.documentType || d.document_type) === 'goods_in').length;
          const giDocNumber = buildDocumentNumber('goods_in', todayISO, existingCount, settings) ||
            `GI/${todayFormatted}/${String(Math.floor(Math.random() * 9000) + 1000)}`;

          // 1. Buat item dokumen Goods In NON-SERI untuk setiap target
          const docItems = [];
          const conversionMap = new Map(); // key: `${itemId}-${entryId}` -> conversionInfo

          let sortOrder = 0;
          for (const t of unimportedNonSerialTargets) {
            docItems.push({
              productId: t.item.productId || null,
              itemName: t.item.name,
              sku: t.item.sku || '',
              quantity: t.totalPcs,
              unitPrice: 0,
              discountType: 'none',
              discountValue: 0,
              amount: 0,
              sortOrder: sortOrder++,
              metadata: {
                isSerial: false,
                qtyUnit: t.unitKey,
                unitName: t.unitKey,
                unitMultiplier: t.mult,
                qtyInput: t.qtyVal,
                baseQuantity: t.totalPcs,
                serialNumbers: [],
                source: 'stock_opname_conversion_all',
                soSessionNumber: activeSession?.sessionNumber,
                soAreaName: checkingArea?.name || checkingArea?.areaName,
              },
            });

            conversionMap.set(`${t.item.id}-${t.entry.id}`, {
              documentNumber: giDocNumber,
              qty: t.qtyVal,
              unit: t.unitKey,
              totalPcs: t.totalPcs,
              serials: [],
              convertedAt: new Date().toISOString(),
            });
          }

          // 2. Buat Dokumen Goods In di backend
          const docPayload = {
            documentType: 'goods_in',
            documentNumber: giDocNumber,
            warehouseId: activeWarehouseId || undefined,
            contactId: null,
            contactName: `Temuan SO ${activeSession?.sessionNumber || ''} (${checkingArea?.name || checkingArea?.areaName || activeWarehouse?.name || 'semua gudang'})`,
            status: 'completed',
            issueDate: todayISO,
            notes: `Barang Masuk dari konversi temuan fisik non-seri keseluruhan Stock Opname ${activeSession?.sessionNumber || ''} (${checkingArea?.name || checkingArea?.areaName || ''}) - ${unimportedNonSerialTargets.length} baris barang (${totalPcsAll} pcs)`,
            subtotal: 0,
            discount: 0,
            tax: 0,
            total: 0,
            items: docItems,
            metadata: {
              source: 'stock_opname_conversion_all',
              stock_opname_session_id: activeSession?.id,
              stock_opname_session_number: activeSession?.sessionNumber,
              stock_opname_area_id: checkingArea?.areaId,
            },
          };

          const docRes = await api.post('/api/workspace/documents', docPayload);
          if (!docRes.ok) {
            const errJson = await docRes.json().catch(() => ({}));
            throw new Error(errJson?.message || 'Gagal membuat dokumen Goods In');
          }
          const createdDoc = (await docRes.json())?.data;
          const officialDocNumber = createdDoc?.document_number || createdDoc?.documentNumber || giDocNumber;

          // 3. Update Checking Items
          const updatedCheckingItems = checkingItems.map((it) => {
            const currentEntries = Array.isArray(it.manualEntries) && it.manualEntries.length > 0
              ? it.manualEntries
              : (it.manualQty !== undefined && it.manualQty !== null && String(it.manualQty).trim() !== ''
                  ? [{ id: `m_legacy_${it.id}`, qty: String(it.manualQty), unit: it.manualUnit || it.inputUnit || it.unit || 'pcs' }]
                  : [{ id: `m_init_${it.id}`, qty: it.inputVal !== undefined && it.inputVal !== null ? String(it.inputVal) : '', unit: it.inputUnit || it.manualUnit || it.unit || 'pcs' }]);

            const updatedEntries = currentEntries.map((e) => {
              const convInfo = conversionMap.get(`${it.id}-${e.id}`);
              if (convInfo) {
                return {
                  ...e,
                  qty: e.qty, // Pertahankan kuantitas fisik yang dihitung
                  convertedToGoodsIn: {
                    ...convInfo,
                    documentNumber: officialDocNumber,
                    documentId: createdDoc?.id,
                  },
                };
              }
              return e;
            });

            return {
              ...it,
              manualEntries: updatedEntries,
              manualQty: updatedEntries[0]?.qty ?? '',
              inputVal: updatedEntries[0]?.qty ?? '',
            };
          });

          setCheckingItems(updatedCheckingItems);

          // 4. Simpan hasil hitungan terbaru ke backend
          const payloadSave = updatedCheckingItems.map((it) => {
            const num = computeItemPcs(it);
            const entries = Array.isArray(it.manualEntries) ? it.manualEntries : [];
            const firstNonEmpty = entries.find((e) => String(e.qty ?? '').trim() !== '') || entries[0];
            return {
              id: it.id,
              productId: it.productId,
              sku: it.sku,
              name: it.name,
              unit: it.unit,
              physicalQty: num,
              systemQty: Number(it.systemQty) || 0,
              notes: it.notes || '',
              isUnlisted: Boolean(it.isUnlisted),
              scannedSerials: it.scannedSerials || [],
              manualEntries: entries,
              manualQty: firstNonEmpty ? firstNonEmpty.qty : (it.manualQty ?? null),
              manualUnit: firstNonEmpty ? firstNonEmpty.unit : (it.manualUnit || 'pcs'),
            };
          });

          await saveAreaPhysicalCount(activeSession.id, {
            areaId: checkingArea.areaId,
            items: payloadSave,
            markCompleted: isAreaCompleted && !isEditingCompletedArea,
          });

          queryClient.invalidateQueries({ queryKey: ['goods-in'] });
          queryClient.invalidateQueries({ queryKey: ['workspace-documents'] });
          queryClient.invalidateQueries({ queryKey: ['products'] });

          if (products && products.length > 0) {
            await syncStockOpnameSessionBaseline(activeSession.id, {
              products: products.map((p) => ({
                productId: p.id,
                sku: p.sku,
                name: p.name,
                unit: p.unitKey || p.unit || 'pcs',
                stock: Number(p.stock) || 0,
              })),
            }).catch(() => {});
          }
          await refetchSessionDetail();

          playBeep('success');
          setScanNotification({
            type: 'success',
            message: `🎉 Berhasil! Seluruh temuan non-seri (${unimportedNonSerialTargets.length} baris, total ${totalPcsAll} pcs) telah resmi dibuatkan Dokumen Barang Masuk (${officialDocNumber}) sebagai non-seri!`,
          });
          setTimeout(() => setScanNotification(null), 6000);
        } catch (err) {
          playBeep('error');
          alert(err.message || 'Gagal mengubah seluruh barang non-seri menjadi Goods In');
        } finally {
          setIsImportingGoodsIn(false);
        }
      },
    });
  };

  // ── Handlers: Tambah Barang ke Lokasi / Temuan Fisik ───────
  const handleOpenAddUnlisted = () => {
    setSelectedUnlistedProduct(null);
    setUnlistedSearch('');
    setUnlistedSystemQty(0);
    setUnlistedPhysicalQty(1);
    setUnlistedNotes('');
    setShowAddUnlistedModal(true);
  };

  const handleConfirmAddUnlisted = async (e) => {
    e.preventDefault();
    if (!selectedUnlistedProduct && !unlistedSearch.trim()) {
      alert('Pilih atau ketik produk.');
      return;
    }
    if (!activeSession || !checkingArea || isAddingUnlisted) return;

    const sku = selectedUnlistedProduct ? selectedUnlistedProduct.sku : unlistedSearch.trim();
    const name = selectedUnlistedProduct ? selectedUnlistedProduct.name : unlistedSearch.trim();
    const productId = selectedUnlistedProduct ? selectedUnlistedProduct.id : null;
    const unit = selectedUnlistedProduct?.unitKey || selectedUnlistedProduct?.unit || 'pcs';

    setIsAddingUnlisted(true);
    try {
      const res = await addUnlistedPhysicalItem(activeSession.id, {
        areaId: checkingArea.areaId,
        productId,
        sku,
        name,
        unit,
        systemQty: Number(unlistedSystemQty) || 0,
        physicalQty: Number(unlistedPhysicalQty) || 0,
        notes: unlistedNotes.trim() || (Number(unlistedSystemQty) > 0 ? '' : 'Temuan fisik tidak terdaftar di lokasi ini'),
      });

      if (res.item) {
        setCheckingItems((prev) => [
          ...prev,
          {
            ...res.item,
            inputVal: String(res.item.physicalQty),
          },
        ]);
      }
      await refetchSessionDetail();
      setShowAddUnlistedModal(false);
    } catch (err) {
      alert(err.message || 'Gagal menambahkan barang ke lokasi');
    } finally {
      setIsAddingUnlisted(false);
    }
  };

  // ── Handlers: Finalisasi Sesi SO ───────────────────────────
  const handleOpenFinalize = () => {
    setFinalizeNotes(activeSession?.notes || '');
    setApplyAdjustment(true);
    setShowFinalizeModal(true);
  };

  const handleConfirmFinalize = async () => {
    if (!activeSession || isFinalizing) return;
    setIsFinalizing(true);
    try {
      await finalizeStockOpnameSession(activeSession.id, {
        applyAdjustment,
        force: true,
        notes: finalizeNotes.trim(),
      });
      await refetchSessionDetail();
      await refetchSessions();
      setShowFinalizeModal(false);
      alert('Sesi Stock Opname berhasil difinalisasi!');
    } catch (err) {
      alert(err.message || 'Gagal memfinalisasi sesi');
    } finally {
      setIsFinalizing(false);
    }
  };

  const handleDeleteSession = (session) => {
    setConfirmDialog({
      title: 'Hapus Sesi Stock Opname',
      message: `Apakah Anda yakin ingin menghapus sesi "${session.sessionNumber} - ${session.title}"?`,
      confirmLabel: 'Hapus Sesi',
      onConfirm: async () => {
        try {
          await deleteStockOpnameSession(session.id);
          await refetchSessions();
          setConfirmDialog(null);
        } catch (err) {
          alert(err.message || 'Gagal menghapus sesi');
          setConfirmDialog(null);
        }
      },
    });
  };

  // Filtered checking items by search (dukung SKU, Nama Barang, dan Nomor Seri)
  const filteredCheckingItems = useMemo(() => {
    if (!checkingSearch.trim()) return checkingItems;
    const q = checkingSearch.toLowerCase().trim();
    return checkingItems.filter(
      (it) =>
        it.sku?.toLowerCase().includes(q) ||
        it.name?.toLowerCase().includes(q) ||
        (Array.isArray(it.scannedSerials) && it.scannedSerials.some((s) => s.toLowerCase().includes(q)))
    );
  }, [checkingItems, checkingSearch]);

  // Filtered catalog products for unlisted search
  const filteredCatalogForUnlisted = useMemo(() => {
    if (!unlistedSearch.trim()) return products.slice(0, 10);
    const q = unlistedSearch.toLowerCase();
    return products
      .filter((p) => p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q))
      .slice(0, 10);
  }, [products, unlistedSearch]);

  // Filtered catalog products for adding area inside session
  const filteredCatalogForSessionArea = useMemo(() => {
    if (!productSearchForSessionArea.trim()) return (products || []).slice(0, 8);
    const q = productSearchForSessionArea.toLowerCase().trim();
    return (products || [])
      .filter((p) => p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q))
      .slice(0, 10);
  }, [products, productSearchForSessionArea]);

  // Filtered catalog products for inline quick add inside checkingArea
  const filteredCatalogForInline = useMemo(() => {
    if (!inlineAddSearch.trim()) return (products || []).slice(0, 8);
    const q = inlineAddSearch.toLowerCase().trim();
    return (products || [])
      .filter((p) => p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q))
      .slice(0, 10);
  }, [products, inlineAddSearch]);

  const unresolvedDiscrepancyCount = useMemo(() => {
    return discrepancyItems.filter((it) => !isItemResolved(it)).length;
  }, [discrepancyItems, resolvedDiscrepancyIds, createdDocBySku]);

  const resolvedDiscrepancyCount = useMemo(() => {
    return discrepancyItems.filter((it) => isItemResolved(it)).length;
  }, [discrepancyItems, resolvedDiscrepancyIds, createdDocBySku]);

  // Filtered discrepancies (mendukung filter barang belum selesai vs sudah dikeluarkan dari masalah)
  const filteredDiscrepancies = useMemo(() => {
    let list = discrepancyItems;

    if (discrepancyFilterMode === 'unresolved') {
      list = list.filter((item) => !isItemResolved(item));
    } else if (discrepancyFilterMode === 'resolved') {
      list = list.filter((item) => isItemResolved(item));
    }

    if (!discrepancySearch.trim()) return list;
    const q = discrepancySearch.toLowerCase();
    return list.filter(
      (d) =>
        d.sku?.toLowerCase().includes(q) ||
        d.name?.toLowerCase().includes(q) ||
        (d.locations || []).some((loc) => loc.areaName?.toLowerCase().includes(q))
    );
  }, [discrepancyItems, discrepancySearch, discrepancyFilterMode, resolvedDiscrepancyIds, createdDocBySku]);

  // Helper: Pengelompokan Tingkat Urutan Rekap Produk Gudang (Subtab 2)
  // Tier 1: Terdeteksi dan sudah sesuai totalnya (Total Fisik == Total Sistem > 0) -> Paling atas
  // Tier 2: Terdeteksi tapi belum sesuai (Total Fisik > 0 & ada selisih) -> Urut dari tersedikit ke banyak
  // Tier 3: Belum terdeteksi sama sekali tapi ada stok sistem (Fisik 0 & Sistem > 0) -> Urut dari tersedikit ke banyak
  // Tier 4: Stok sistem 0 & fisik 0 -> Paling bawah (dapat di-collapse / lihat selengkapnya)
  const getProductSortTier = (p) => {
    const phys = Number(p.totalPhysicalQty) || 0;
    const sys = Number(p.totalSystemQty) || 0;
    const diff = Number(p.difference) || 0;

    if (phys > 0 && diff === 0) return 1;
    if (phys > 0 && diff !== 0) return 2;
    if (phys === 0 && sys > 0) return 3;
    return 4;
  };

  // Filtered & Tiered Sorted Product Summary (Subtab 2)
  const { filteredProductSummary, zeroStockCount, totalProductCount } = useMemo(() => {
    let list = [...(productSummary || [])];
    const isSearching = Boolean(productSummarySearch.trim());

    if (isSearching) {
      const q = productSummarySearch.toLowerCase();
      list = list.filter(
        (p) => p.sku?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q)
      );
    }

    // Urutkan per kategori tier sesuai permintaan
    const sorted = [...list].sort((a, b) => {
      const tierA = getProductSortTier(a);
      const tierB = getProductSortTier(b);
      if (tierA !== tierB) return tierA - tierB;

      // Tier 1: Sudah sesuai -> urutkan nama
      if (tierA === 1) {
        return (a.name || '').localeCompare(b.name || '');
      }
      // Tier 2: Terdeteksi belum sesuai -> urutkan dari yang tersedikit ke yang banyak (totalPhysicalQty)
      if (tierA === 2) {
        const physA = Number(a.totalPhysicalQty) || 0;
        const physB = Number(b.totalPhysicalQty) || 0;
        if (physA !== physB) return physA - physB;
        return (a.name || '').localeCompare(b.name || '');
      }
      // Tier 3: Belum kescan -> urutkan dari yang tersedikit ke yang banyak (totalSystemQty)
      if (tierA === 3) {
        const sysA = Number(a.totalSystemQty) || 0;
        const sysB = Number(b.totalSystemQty) || 0;
        if (sysA !== sysB) return sysA - sysB;
        return (a.name || '').localeCompare(b.name || '');
      }
      // Tier 4: Stok 0 -> urutkan nama
      return (a.name || '').localeCompare(b.name || '');
    });

    const zeroCount = sorted.filter((p) => getProductSortTier(p) === 4).length;

    // Sembunyikan produk stok 0 jika tidak sedang mencari dan toggle belum dibuka
    const visible = (!isSearching && !showZeroStock)
      ? sorted.filter((p) => getProductSortTier(p) !== 4)
      : sorted;

    return {
      filteredProductSummary: visible,
      zeroStockCount: zeroCount,
      totalProductCount: sorted.length,
    };
  }, [productSummary, productSummarySearch, showZeroStock]);

  // ─────────────────────────────────────────────────────────
  // RENDER: VIEW 1 — DAFTAR SESI & MASTER AREA
  // ─────────────────────────────────────────────────────────
  if (currentView === 'list') {
    return (
      <div className="so-container">
        {/* Banner Info & Action */}
        <div className="so-banner">
          <div className="so-banner__info">
            <Boxes className="so-banner__icon" size={26} />
            <div>
              <h3 className="so-banner__title">
                Stock Opname Berbasis Bagian / Area Gudang
              </h3>
              <p className="so-banner__desc">
                Mulai sesi Stock Opname dan tambahkan Bagian / Area gudang (ruangan, rak, pojokan, dll) secara langsung saat pemeriksaan. Sistem mencatat barang & jumlah fisik di tiap lokasi secara akurat.
              </p>
            </div>
          </div>
          <div className="so-banner__actions">
            <button
              type="button"
              className="btn btn-primary btn-md"
              onClick={handleOpenCreateSession}
            >
              <Plus size={16} />
              <span>Mulai Sesi Stock Opname</span>
            </button>
          </div>
        </div>

        {/* Toolbar Pencarian & Filter Sesi */}
        <div className="so-toolbar">
          <div className="so-toolbar__left">
            <div className="so-search-box">
              <Search size={15} className="so-search-icon" />
              <input
                type="text"
                className="input"
                placeholder="Cari nomor sesi atau judul..."
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="so-toolbar__right">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => refetchSessions()}
              title="Perbarui daftar sesi"
            >
              <RotateCcw size={14} />
              <span>Segarkan</span>
            </button>
          </div>
        </div>

        {/* Tabel Sesi Stock Opname */}
        <div className="reports-table-wrapper">
          <table className="reports-table">
            <thead>
              <tr>
                <th>No. Sesi</th>
                <th>Judul & Catatan</th>
                <th>Tanggal</th>
                <th>Progress Pengecekan</th>
                <th>Status Selisih</th>
                <th>Status Sesi</th>
                <th className="text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {loadingSessions ? (
                <tr>
                  <td colSpan={7} className="reports-empty-cell">
                    Memuat riwayat Stock Opname...
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="reports-empty-cell">
                    Belum ada sesi Stock Opname di gudang ini.{' '}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleOpenCreateSession}
                    >
                      Mulai Sesi Pertama
                    </button>
                  </td>
                </tr>
              ) : (
                sessions
                  .filter((s) => {
                    if (!sessionSearch.trim()) return true;
                    const q = sessionSearch.toLowerCase();
                    return (
                      s.sessionNumber?.toLowerCase().includes(q) ||
                      s.title?.toLowerCase().includes(q)
                    );
                  })
                  .map((session) => {
                    const sm = session.summary || {};
                    const isFinal = session.status === 'finalized';

                    return (
                      <tr
                        key={session.id}
                        className="reports-table-row interactive"
                        onClick={() => handleOpenSession(session.id)}
                      >
                        <td className="text-bold text-mono">
                          <div className="flex-align-center gap-1">
                            <Boxes size={14} className="text-accent" />
                            <span>{session.sessionNumber}</span>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{session.title}</div>
                          {session.notes && (
                            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                              {session.notes}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="flex-align-center gap-1">
                            <Calendar size={13} className="text-muted" />
                            <span>
                              {new Date(session.createdAt).toLocaleDateString('id-ID', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div style={{ minWidth: '140px' }}>
                            <div className="so-progress-bar__track">
                              <div
                                className="so-progress-bar__fill"
                                style={{
                                  width: `${
                                    sm.totalAreas > 0
                                      ? Math.round((sm.completedAreas / sm.totalAreas) * 100)
                                      : 0
                                  }%`,
                                }}
                              />
                            </div>
                            <div className="so-progress-bar__meta" style={{ marginTop: '3px' }}>
                              <span>
                                {sm.completedAreas || 0} / {sm.totalAreas || 0} Area
                              </span>
                              <span>
                                {sm.totalAreas > 0
                                  ? Math.round((sm.completedAreas / sm.totalAreas) * 100)
                                  : 0}
                                %
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          {sm.totalDiscrepancy === 0 ? (
                            <span className="so-badge so-badge--matched">
                              <CheckCircle2 size={12} /> Sesuai
                            </span>
                          ) : (
                            <span className="so-badge so-badge--shortage">
                              <AlertTriangle size={12} /> {sm.totalDiscrepancy} Selisih
                            </span>
                          )}
                        </td>
                        <td>
                          {isFinal ? (
                            <span className="so-badge so-badge--finalized">
                              <ShieldCheck size={12} /> Selesai & Final
                            </span>
                          ) : session.status === 'review' ? (
                            <span className="so-badge so-badge--in_progress">
                              Review Selisih
                            </span>
                          ) : (
                            <span className="so-badge so-badge--pending">
                              Sedang Diperiksa
                            </span>
                          )}
                        </td>
                        <td className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'inline-flex', gap: '4px' }}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleOpenSession(session.id)}
                              title="Buka Sesi"
                            >
                              <ArrowRight size={14} />
                              <span>{isFinal ? 'Lihat Hasil' : 'Buka Cek'}</span>
                            </button>
                            {!isFinal && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm text-danger"
                                onClick={() => handleDeleteSession(session)}
                                title="Hapus Sesi Draft"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Modal Buat Sesi Baru ── */}
        {showCreateSessionModal && (
          <div className="so-modal-overlay" onClick={() => !isCreatingSession && setShowCreateSessionModal(false)}>
            <div className="so-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <div className="so-modal__header">
                <div className="so-modal__header-left">
                  <div className="reports-kpi-icon-wrap bg-blue-light">
                    <Boxes size={20} className="text-accent" />
                  </div>
                  <div>
                    <h3 className="so-modal__title">Mulai Sesi Stock Opname</h3>
                    <p className="so-modal__subtitle">
                      Gudang: <strong>{activeWarehouse?.name || 'Gudang Utama'}</strong>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="so-modal__close-btn"
                  onClick={() => !isCreatingSession && setShowCreateSessionModal(false)}
                  disabled={isCreatingSession}
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleCreateSession}>
                <div className="so-modal__body">
                  <div className="form-group">
                    <label className="form-label">Judul Sesi Stock Opname</label>
                    <input
                      type="text"
                      className="input"
                      required
                      value={newSessionTitle}
                      onChange={(e) => setNewSessionTitle(e.target.value)}
                      placeholder="Contoh: Stock Opname Rutin Oktober 2026"
                      disabled={isCreatingSession}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Catatan Tambahan (Opsional)</label>
                    <textarea
                      className="input"
                      rows={3}
                      value={newSessionNotes}
                      onChange={(e) => setNewSessionNotes(e.target.value)}
                      placeholder="Contoh: Pengecekan triwulanan lantai 1 dan 2"
                      disabled={isCreatingSession}
                    />
                  </div>

                  <div className="so-banner" style={{ padding: 'var(--space-3)' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                      📍 {activeAreas.length > 0 ? (
                        <>Sesi ini memuat <strong>{activeAreas.length} Bagian / Area</strong> yang aktif. Anda juga dapat langsung menambahkan area/rak baru kapan saja di dalam sesi.</>
                      ) : (
                        <>Belum ada Bagian / Area yang terdaftar. Anda dapat langsung menambahkan lokasi gudang (seperti "Ruang Depan", "Rak Bedong", "PK 5") di dalam sesi nanti.</>
                      )}
                    </div>
                  </div>
                </div>

                <div className="so-modal__footer">
                  <button
                    type="button"
                    className="btn btn-secondary btn-md"
                    onClick={() => setShowCreateSessionModal(false)}
                    disabled={isCreatingSession}
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-md"
                    disabled={isCreatingSession}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      opacity: isCreatingSession ? 0.75 : 1,
                      cursor: isCreatingSession ? 'not-allowed' : 'pointer',
                      pointerEvents: isCreatingSession ? 'none' : 'auto',
                    }}
                  >
                    {isCreatingSession ? (
                      <>
                        <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                        <span>Membuat Sesi...</span>
                      </>
                    ) : (
                      <>
                        <span>Mulai Pengecekan</span>
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Dialog Konfirmasi Umum */}
        {confirmDialog && (
          <ConfirmModal
            open={Boolean(confirmDialog)}
            title={confirmDialog.title}
            message={confirmDialog.message}
            confirmLabel={confirmDialog.confirmLabel}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER: VIEW 2 — DETAIL SESI STOCK OPNAME AKTIF
  // ─────────────────────────────────────────────────────────
  if (!activeSession) {
    return (
      <div className="so-container">
        <div className="reports-empty-cell">Memuat sesi Stock Opname...</div>
      </div>
    );
  }


  // ── CETAK & EXPORT PDF LAPORAN FISIK RUANGAN / AREA ──
  const handleExportAreasPdf = (targetArea = null) => {
    if (!activeSession) return;

    const companyName = settings?.company?.name || settings?.companyName || 'DOCUFLOW INVENTORY';
    const warehouseName = activeWarehouse?.name || 'Gudang Utama';
    const sessionNum = activeSession.sessionNumber || 'SO';
    const sessionTitle = activeSession.title || 'Stock Opname';
    const createdDate = new Date(activeSession.createdAt).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const finalizedDate = activeSession.finalizedAt
      ? new Date(activeSession.finalizedAt).toLocaleDateString('id-ID', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
    const finalizedBy = activeSession.finalizedByName || activeSession.createdByName || 'Admin';

    // Area yang akan dicetak: seluruh area atau 1 area target
    const areasToPrint = targetArea ? [targetArea] : (activeSession.areas || []);
    let grandTotalPcs = 0;
    let grandTotalItems = 0;

    const areasHtml = areasToPrint.map((area, areaIdx) => {
      const areaItems = area.items || [];
      grandTotalItems += areaItems.length;

      let areaTotalPcs = 0;

      const itemsRowsHtml = areaItems.map((item, itemIdx) => {
        const rawPhys = item.physicalQty !== null && item.physicalQty !== undefined ? Number(item.physicalQty) : null;
        const pcsVal = rawPhys !== null ? rawPhys : (computeItemPcs(item) ?? 0);
        areaTotalPcs += pcsVal;

        const breakdown = pcsVal >= 12 ? formatDocumentQty(Math.floor(pcsVal / 12), pcsVal % 12) : null;
        const serialsList = item.scannedSerials || [];

        const serialsHtml = serialsList.length > 0
          ? `<div style="margin-top: 4px; font-size: 10px; color: #475569; line-height: 1.4;">
               <strong style="color: #0f172a;">Nomor Seri (${serialsList.length}):</strong>
               <div style="display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px;">
                 ${serialsList.map(sn => `<span style="display: inline-block; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 3px; padding: 1px 4px; font-family: monospace; font-size: 9.5px;">${sn}</span>`).join('')}
               </div>
             </div>`
          : '';

        return `
          <tr style="border-bottom: 1px solid #e2e8f0; font-size: 11px;">
            <td style="padding: 6px 8px; text-align: center; color: #64748b; width: 32px;">${itemIdx + 1}</td>
            <td style="padding: 6px 8px; font-family: monospace; font-weight: 700; width: 140px;">${item.sku || '—'}</td>
            <td style="padding: 6px 8px;">
              <div style="font-weight: 600; color: #0f172a;">${item.name || item.sku || 'Barang'}</div>
              ${serialsHtml}
            </td>
            <td style="padding: 6px 8px; text-align: center; color: #475569; width: 60px;">${item.unit || 'pcs'}</td>
            <td style="padding: 6px 8px; text-align: right; font-weight: 700; width: 130px;">
              <div style="color: #059669; font-size: 12px;">${pcsVal.toLocaleString('id-ID')} pcs</div>
              ${breakdown ? `<div style="font-size: 10px; color: #64748b; font-weight: normal;">(${breakdown})</div>` : ''}
            </td>
          </tr>
        `;
      }).join('');

      grandTotalPcs += areaTotalPcs;
      const areaBreakdown = areaTotalPcs >= 12 ? formatDocumentQty(Math.floor(areaTotalPcs / 12), areaTotalPcs % 12) : null;

      return `
        <div class="area-section" style="margin-bottom: 24px; page-break-inside: avoid; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; background: #fff;">
          <div style="background: #f8fafc; border-bottom: 1px solid #cbd5e1; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="background: #2563eb; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px;">#${areaIdx + 1}</span>
                <span style="font-size: 14px; font-weight: 800; color: #0f172a;">${area.areaName || area.name || 'Nama Lokasi'}</span>
                <span style="background: ${area.status === 'completed' ? '#dcfce7' : '#fef3c7'}; color: ${area.status === 'completed' ? '#166534' : '#92400e'}; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">
                  ${area.status === 'completed' ? '✓ Selesai Diperiksa' : 'Sedang Diperiksa'}
                </span>
              </div>
              ${area.description || area.desc ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">${area.description || area.desc}</div>` : ''}
            </div>
            <div style="text-align: right;">
              <div style="font-size: 11px; color: #64748b;">Total Fisik di Ruangan Ini:</div>
              <div style="font-size: 13px; font-weight: 800; color: #059669;">${areaTotalPcs.toLocaleString('id-ID')} pcs ${areaBreakdown ? `<span style="font-size: 11px; font-weight: 600; color: #64748b;">(${areaBreakdown})</span>` : ''}</div>
            </div>
          </div>

          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #f1f5f9; border-bottom: 1px solid #cbd5e1; font-size: 11px; color: #475569;">
                <th style="padding: 6px 8px; text-align: center; width: 32px;">No</th>
                <th style="padding: 6px 8px; text-align: left; width: 140px;">SKU</th>
                <th style="padding: 6px 8px; text-align: left;">Nama Produk & Rincian Nomor Seri</th>
                <th style="padding: 6px 8px; text-align: center; width: 60px;">Satuan</th>
                <th style="padding: 6px 8px; text-align: right; width: 130px;">Fisik Terhitung</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRowsHtml || `<tr><td colspan="5" style="text-align: center; padding: 16px; color: #94a3b8; font-style: italic;">Tidak ada barang yang terdata di lokasi ini.</td></tr>`}
            </tbody>
          </table>
        </div>
      `;
    }).join('');

    const grandBreakdown = grandTotalPcs >= 12 ? formatDocumentQty(Math.floor(grandTotalPcs / 12), grandTotalPcs % 12) : null;
    const docTitle = targetArea ? `LAPORAN FISIK RUANGAN: ${(targetArea.areaName || targetArea.name || '').toUpperCase()}` : 'LAPORAN HASIL FISIK SELURUH RUANGAN / AREA';

    const printHtml = `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="utf-8" />
        <title>${docTitle} - ${sessionNum}</title>
        <style>
          @page {
            size: A4 portrait;
            margin: 12mm 10mm 15mm 10mm;
          }
          * {
            box-sizing: border-box;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 0;
            padding: 0;
            color: #0f172a;
            background: #fff;
          }
          .no-print-bar {
            position: sticky;
            top: 0;
            z-index: 999;
            background: #1e293b;
            color: #fff;
            padding: 10px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
          }
          .btn-print {
            background: #2563eb;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .btn-print:hover {
            background: #1d4ed8;
          }
          .btn-close {
            background: #475569;
            color: #fff;
            border: none;
            padding: 8px 14px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
          }
          .doc-sheet {
            max-width: 900px;
            margin: 0 auto;
            padding: 24px 20px;
          }
          @media print {
            .no-print-bar {
              display: none !important;
            }
            .doc-sheet {
              padding: 0 !important;
              max-width: 100% !important;
            }
            .area-section {
              page-break-inside: avoid !important;
            }
          }
        </style>
      </head>
      <body>
        <div class="no-print-bar">
          <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px;">
            <span>📄 Preview Cetak & Export PDF: ${docTitle} (${sessionNum})</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button onclick="window.print()" class="btn-print">
              🖨️ Cetak Sekarang / Simpan PDF (Ctrl + P)
            </button>
            <button onclick="window.close()" class="btn-close">
              ✕ Tutup
            </button>
          </div>
        </div>

        <div class="doc-sheet">
          <!-- Header Perusahaan & Judul Dokumen -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px;">
            <div>
              <div style="font-size: 18px; font-weight: 900; letter-spacing: -0.5px; color: #0f172a;">${companyName}</div>
              <div style="font-size: 12px; color: #475569; margin-top: 2px;">Gudang: <strong>${warehouseName}</strong></div>
              <div style="font-size: 11px; color: #64748b;">Dicetak pada: ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 16px; font-weight: 900; color: #1e3a8a;">${docTitle}</div>
              <div style="font-size: 13px; font-family: monospace; font-weight: 800; color: #2563eb; margin-top: 2px;">${sessionNum}</div>
              <div style="display: inline-block; background: ${activeSession.status === 'finalized' ? '#dcfce7' : '#fef3c7'}; color: ${activeSession.status === 'finalized' ? '#166534' : '#92400e'}; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-top: 4px;">
                ${activeSession.status === 'finalized' ? 'FINALIZED (SELESAI)' : 'SEDANG BERJALAN'}
              </div>
            </div>
          </div>

          <!-- Metadata & Ringkasan KPI Sesi -->
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; margin-bottom: 20px; font-size: 11px;">
            <div>
              <div style="color: #64748b; font-size: 10px;">Judul Sesi:</div>
              <div style="font-weight: 700; color: #0f172a;">${sessionTitle}</div>
            </div>
            <div>
              <div style="color: #64748b; font-size: 10px;">Total Area / Ruangan:</div>
              <div style="font-weight: 800; color: #2563eb; font-size: 13px;">${areasToPrint.length} Lokasi</div>
            </div>
            <div>
              <div style="color: #64748b; font-size: 10px;">Total Fisik Terhitung:</div>
              <div style="font-weight: 800; color: #059669; font-size: 13px;">${grandTotalPcs.toLocaleString('id-ID')} pcs</div>
              ${grandBreakdown ? `<div style="font-size: 9.5px; color: #64748b;">(${grandBreakdown})</div>` : ''}
            </div>
            <div>
              <div style="color: #64748b; font-size: 10px;">Petugas / Supervisor:</div>
              <div style="font-weight: 700; color: #0f172a;">${finalizedBy}</div>
              ${finalizedDate ? `<div style="font-size: 9.5px; color: #64748b;">${finalizedDate}</div>` : ''}
            </div>
          </div>

          <!-- Rincian Daftar Ruangan -->
          <div style="margin-bottom: 20px;">
            <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
              <span>Rincian Fisik Barang di Masing-Masing Ruangan / Area:</span>
              <span style="font-size: 11px; font-weight: normal; color: #64748b;">Total ${areasToPrint.length} Lokasi Terdata</span>
            </div>

            ${areasHtml}
          </div>

          <!-- Bagian Tanda Tangan & Pengesahan -->
          <div style="page-break-inside: avoid; margin-top: 30px; border-top: 1px solid #cbd5e1; padding-top: 16px;">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; text-align: center; font-size: 11px;">
              <div>
                <div style="color: #64748b; margin-bottom: 50px;">Petugas Penghitung Fisik:</div>
                <div style="font-weight: 700; border-top: 1px dashed #94a3b8; padding-top: 4px; display: inline-block; min-width: 140px;">( .................................... )</div>
              </div>
              <div>
                <div style="color: #64748b; margin-bottom: 50px;">Supervisor Lapangan:</div>
                <div style="font-weight: 700; border-top: 1px dashed #94a3b8; padding-top: 4px; display: inline-block; min-width: 140px;">( ${finalizedBy || '....................................'} )</div>
              </div>
              <div>
                <div style="color: #64748b; margin-bottom: 50px;">Kepala Gudang / Penanggung Jawab:</div>
                <div style="font-weight: 700; border-top: 1px dashed #94a3b8; padding-top: 4px; display: inline-block; min-width: 140px;">( .................................... )</div>
              </div>
            </div>
            <div style="text-align: center; font-size: 10px; color: #94a3b8; margin-top: 16px;">
              Dokumen ini dihasilkan secara otomatis oleh DocuFlow Inventory System sebagai bukti sah hasil Stock Opname fisik gudang.
            </div>
          </div>
        </div>
        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
            }, 300);
          };
        </script>
      </body>
      </html>
    `;

    const printWin = window.open('', '_blank', 'width=1000,height=800');
    if (!printWin) {
      alert('Gagal membuka jendela cetak. Pastikan browser mengizinkan popup window.');
      return;
    }
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
  };

  return (
    <div className="so-container">
      {/* Header Sesi Aktif */}
      <div className="so-banner" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleBackToList}
              style={{ display: 'inline-flex', gap: '4px', padding: '4px 8px' }}
            >
              <span>← Kembali ke Riwayat Sesi</span>
            </button>
            <span className="text-mono font-bold" style={{ fontSize: '13px' }}>
              {activeSession.sessionNumber}
            </span>
            <span
              className={`so-badge ${
                isFinalized
                  ? 'so-badge--finalized'
                  : activeSession.status === 'review'
                  ? 'so-badge--in_progress'
                  : 'so-badge--pending'
              }`}
            >
              {isFinalized
                ? 'Finalized (Selesai)'
                : activeSession.status === 'review'
                ? 'Review Selisih'
                : 'Sedang Diperiksa'}
            </span>
          </div>

          <h2 style={{ fontSize: 'var(--text-subhead)', fontWeight: 800, margin: '4px 0 0 0' }}>
            {activeSession.title}
          </h2>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Gudang: <strong>{activeWarehouse?.name || 'Gudang Utama'}</strong> · Dibuat pada{' '}
            {new Date(activeSession.createdAt).toLocaleDateString('id-ID', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Tombol Cetak & Export PDF Seluruh Ruangan */}
          <button
            type="button"
            className="btn btn-secondary btn-md"
            onClick={() => handleExportAreasPdf(null)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}
            title="Cetak & Export PDF Laporan Hasil Fisik Seluruh Ruangan / Area"
          >
            <Printer size={15} />
            <span>Export PDF Semua Ruangan</span>
          </button>

          {!isFinalized ? (
            <button
              type="button"
              className="btn btn-primary btn-md"
              onClick={handleOpenFinalize}
            >
              <ShieldCheck size={16} />
              <span>Review & Finalisasi Sesi</span>
            </button>
          ) : (
            <div className="so-badge so-badge--finalized" style={{ padding: '6px 12px', fontSize: '12px' }}>
              <ShieldCheck size={14} />
              <span>Difinalisasi oleh {activeSession.finalizedByName || 'Admin'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Panduan Alur Singkat Stock Opname untuk Memudahkan User */}
      <div className="so-guide-banner">
        <div className="so-guide-banner__header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="so-guide-badge">Panduan Cepat</span>
            <span style={{ fontWeight: 700, fontSize: '13px' }}>4 Langkah Melakukan Stock Opname:</span>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>Klik langkah untuk berpindah cepat</span>
        </div>
        <div className="so-guide-steps">
          <div
            className={`so-guide-step ${sessionSubTab === 'areas' ? 'active' : ''}`}
            onClick={() => setSessionSubTab('areas')}
          >
            <div className="so-guide-step__num">1</div>
            <div className="so-guide-step__body">
              <span className="so-guide-step__title">Pilih Area / Lokasi</span>
              <span className="so-guide-step__desc">Buka rak/ruangan yang akan dihitung</span>
            </div>
          </div>

          <div
            className={`so-guide-step ${checkingArea ? 'active' : ''}`}
            onClick={() => {
              setSessionSubTab('areas');
              if (activeSession.areas?.[0] && !checkingArea) {
                handleStartCheckingArea(activeSession.areas[0]);
              }
            }}
          >
            <div className="so-guide-step__num">2</div>
            <div className="so-guide-step__body">
              <span className="so-guide-step__title">Hitung Fisik Barang</span>
              <span className="so-guide-step__desc">Scan Barcode / QR HP atau ketik manual</span>
            </div>
          </div>

          <div
            className={`so-guide-step ${sessionSubTab === 'discrepancies' ? 'active' : ''}`}
            onClick={() => setSessionSubTab('discrepancies')}
          >
            <div className="so-guide-step__num">3</div>
            <div className="so-guide-step__body">
              <span className="so-guide-step__title">Cek Selisih Stok</span>
              <span className="so-guide-step__desc">Tinjau barang kurang/lebih jika ada</span>
            </div>
          </div>

          <div
            className={`so-guide-step ${sessionSubTab === 'warehouse_total' ? 'active' : ''}`}
            onClick={() => setSessionSubTab('warehouse_total')}
          >
            <div className="so-guide-step__num">4</div>
            <div className="so-guide-step__body">
              <span className="so-guide-step__title">Finalisasi Sesi</span>
              <span className="so-guide-step__desc">Kunci hasil & update otomatis database</span>
            </div>
          </div>
        </div>
      </div>

      {/* Progress & Quick Stat Bar */}
      <div className="reports-kpi-grid">
        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">Progress Lokasi</span>
            <Layers size={16} className="text-accent" />
          </div>
          <div className="reports-kpi-value">
            {warehouseReconciliation.completedAreasCount} / {warehouseReconciliation.totalAreasCount}
          </div>
          <div className="so-progress-bar__track">
            <div
              className="so-progress-bar__fill"
              style={{ width: `${warehouseReconciliation.completionPercent}%` }}
            />
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            {warehouseReconciliation.completionPercent}% Bagian / Lokasi Selesai
          </span>
        </div>

        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">Total Unit Sistem</span>
            <Boxes size={16} className="text-muted" />
          </div>
          <div className="reports-kpi-value text-muted">
            {warehouseReconciliation.totalSystemQty.toLocaleString('id-ID')}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            Total unit tercatat di sistem
          </span>
        </div>

        <div className="reports-kpi-card">
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">Total Unit Fisik</span>
            <CheckCircle2 size={16} className="text-green" />
          </div>
          <div className="reports-kpi-value text-green">
            {warehouseReconciliation.totalPhysicalQty.toLocaleString('id-ID')}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            Total fisik ditemukan dari seluruh area
          </span>
        </div>

        <div className={`reports-kpi-card ${unresolvedDiscrepancyCount > 0 ? 'so-discrepancy-card' : ''}`}>
          <div className="reports-kpi-header">
            <span className="reports-kpi-label">Barang Bermasalah</span>
            <AlertTriangle
              size={16}
              className={unresolvedDiscrepancyCount > 0 ? 'text-danger' : 'text-green'}
            />
          </div>
          <div
            className={`reports-kpi-value ${
              unresolvedDiscrepancyCount > 0 ? 'text-danger' : 'text-green'
            }`}
          >
            {unresolvedDiscrepancyCount} Item {resolvedDiscrepancyCount > 0 && <span style={{ fontSize: '11px', fontWeight: 'normal', color: 'var(--color-text-muted)' }}>({resolvedDiscrepancyCount} dikeluarkan)</span>}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            {warehouseReconciliation.netDifference === 0
              ? 'Selisih Netto: 0 unit'
              : `Selisih Netto: ${warehouseReconciliation.netDifference > 0 ? '+' : ''}${warehouseReconciliation.netDifference} unit`}
          </span>
        </div>
      </div>

      {/* Subtab Navigasi dalam Sesi */}
      <div className="so-subtabs">
        <button
          type="button"
          className={`so-subtab-btn ${sessionSubTab === 'areas' ? 'active' : ''}`}
          onClick={() => setSessionSubTab('areas')}
        >
          <MapPin size={15} />
          <span>1. Pengecekan per Bagian / Area</span>
          <span className="so-subtab-badge">{activeSession.areas?.length || 0}</span>
        </button>

        <button
          type="button"
          className={`so-subtab-btn ${sessionSubTab === 'by_product' ? 'active' : ''}`}
          onClick={() => {
            setSessionSubTab('by_product');
            refetchSessionDetail();
          }}
        >
          <Package size={15} />
          <span>2. Rekap Seluruh Produk Gudang</span>
          <span className="so-subtab-badge">{productSummary.length}</span>
        </button>

        <button
          type="button"
          className={`so-subtab-btn ${sessionSubTab === 'discrepancies' ? 'active' : ''}`}
          onClick={() => {
            setSessionSubTab('discrepancies');
            refetchSessionDetail();
          }}
        >
          <AlertTriangle size={15} />
          <span>3. Barang Bermasalah</span>
          {unresolvedDiscrepancyCount > 0 ? (
            <span className="so-subtab-badge" style={{ background: '#ef4444', color: 'white' }}>
              {unresolvedDiscrepancyCount}
            </span>
          ) : discrepancyItems.length > 0 ? (
            <span className="so-subtab-badge" style={{ background: '#10b981', color: 'white' }} title="Semua masalah telah diselesaikan / dikeluarkan">
              ✓
            </span>
          ) : null}
        </button>

        <button
          type="button"
          className={`so-subtab-btn ${sessionSubTab === 'warehouse_total' ? 'active' : ''}`}
          onClick={() => {
            setSessionSubTab('warehouse_total');
            refetchSessionDetail();
          }}
        >
          <ShieldCheck size={15} />
          <span>4. Ringkasan Rekonsiliasi</span>
        </button>
      </div>

      {/* ───────────────────────────────────────────────────── */}
      {/* SUBTAB 1: KARTU-KARTU AREA GUDANG                     */}
      {/* ───────────────────────────────────────────────────── */}
      {sessionSubTab === 'areas' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="so-toolbar">
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
              Pilih satu lokasi untuk memeriksa fisik, atau tambahkan lokasi baru di gudang ini.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleExportAreasPdf(null)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title="Cetak & Export PDF Rincian Fisik Seluruh Ruangan / Area"
              >
                <Printer size={14} />
                <span>Export PDF Semua Ruangan</span>
              </button>
              {isSessionEditable && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleOpenAddAreaToSession}
                >
                  <Plus size={15} />
                  <span>+ Tambah Bagian / Area</span>
                </button>
              )}
            </div>
          </div>

          {(activeSession.areas || []).length === 0 ? (
            <div
              style={{
                padding: 'var(--space-8)',
                textAlign: 'center',
                background: 'var(--color-surface)',
                borderRadius: 'var(--radius-lg)',
                border: '1px dashed var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-2)',
              }}
            >
              <Layers size={36} style={{ color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }} />
              <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>Belum Ada Bagian / Area di Sesi Ini</h4>
              <p style={{ margin: 0, maxWidth: '440px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                Tambahkan lokasi atau rak gudang Anda (misal: "Ruang Depan", "Rak Bedong", "PK 5") untuk mulai memeriksa barang.
              </p>
              {isSessionEditable && (
                <button
                  type="button"
                  className="btn btn-primary btn-md"
                  style={{ marginTop: 'var(--space-3)' }}
                  onClick={handleOpenAddAreaToSession}
                >
                  <Plus size={16} />
                  <span>Tambah Bagian / Area Pertama</span>
                </button>
              )}
            </div>
          ) : (
            <div className="so-areas-grid">
              {(activeSession.areas || []).map((area) => {
                const isDone = area.status === 'completed';
                const isProg = area.status === 'in_progress';
                const items = area.items || [];
                const countedCount = items.filter((it) => it.physicalQty !== null).length;
                const hasShortage = items.some((it) => it.status === 'shortage' || it.status === 'not_found');
                const hasOverage = items.some((it) => it.status === 'overage' || it.status === 'unlisted');

                return (
                  <div
                    key={area.areaId}
                    className={`so-area-card so-area-card--${area.status}`}
                    onClick={() => handleStartCheckingArea(area)}
                  >
                    <div className="so-area-card__header">
                      <div className="so-area-card__title-wrap">
                        <h4 className="so-area-card__name">
                          <MapPin size={16} className="text-accent" />
                          <span>{area.areaName}</span>
                        </h4>
                        <p className="so-area-card__desc">
                          {isDone ? `Selesai diperiksa` : isProg ? 'Sedang diperiksa' : 'Belum diperiksa'}
                        </p>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                        <span
                          className={`so-badge ${
                            isDone
                              ? 'so-badge--completed'
                              : isProg
                              ? 'so-badge--in_progress'
                              : 'so-badge--pending'
                          }`}
                        >
                          {isDone ? (
                            <>
                              <CheckCircle2 size={11} /> Selesai
                            </>
                          ) : isProg ? (
                            'Diproses'
                          ) : (
                            'Pending'
                          )}
                        </span>
                        {isSessionEditable && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs text-danger"
                            onClick={(e) => handleDeleteAreaFromSession(area.areaId || area.id, area.areaName, e)}
                            title="Hapus lokasi dari sesi ini"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Preview Daftar Barang di Lokasi Ini */}
                    <div style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-2)', fontSize: '11px' }}>
                      <div style={{ color: 'var(--color-text-secondary)', marginBottom: '4px', fontWeight: 600 }}>
                        Barang di lokasi ini ({items.length}):
                      </div>
                      {items.length === 0 ? (
                        <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                          Belum ada barang (dapat dicatat saat cek fisik)
                        </span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {items
                            .slice()
                            .sort((a, b) => {
                              if (!a.isUnlisted && b.isUnlisted) return -1;
                              if (a.isUnlisted && !b.isUnlisted) return 1;
                              return 0;
                            })
                            .slice(0, 3)
                            .map((it) => (
                            <div
                              key={it.id || it.sku}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                background: 'var(--color-background)',
                                padding: '2px 6px',
                                borderRadius: 'var(--radius-sm)',
                              }}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '170px' }}>
                                {it.name}
                              </span>
                              <span className="text-mono font-bold" style={{ color: 'var(--color-text-primary)' }}>
                                {it.physicalQty !== null && it.physicalQty !== undefined
                                  ? `${it.physicalQty} ${it.unit || 'pcs'}`
                                  : `${it.systemQty} ${it.unit}`}
                              </span>
                            </div>
                          ))}
                          {items.length > 3 && (
                            <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
                              +{items.length - 3} barang lainnya...
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="so-area-card__stats">
                      <div className="so-area-card__stat-item">
                        <span className="so-area-card__stat-label">Barang Dicek</span>
                        <span className="so-area-card__stat-val">
                          {countedCount} / {items.length}
                        </span>
                      </div>
                      <div className="so-area-card__stat-item">
                        <span className="so-area-card__stat-label">Kondisi</span>
                        <span className="so-area-card__stat-val">
                          {hasShortage || hasOverage ? (
                            <span style={{ color: '#ef4444' }}>Ada Selisih</span>
                          ) : isDone ? (
                            <span style={{ color: '#10b981' }}>Sesuai</span>
                          ) : (
                            '—'
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="so-area-card__footer">
                      <span>{items.length} jenis produk</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExportAreasPdf(area);
                          }}
                          title={`Cetak & Export PDF Rincian Fisik Ruangan "${area.areaName || area.name}"`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 6px' }}
                        >
                          <Printer size={12} />
                          <span>PDF</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '3px 8px', fontSize: '11px' }}
                        >
                          <span>{isDone ? 'Buka Hasil' : 'Periksa'}</span>
                          <ArrowRight size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────── */}
      {/* SUBTAB 2: REKAP PER PRODUK (MULTI-LOKASI)             */}
      {/* ───────────────────────────────────────────────────── */}
      {sessionSubTab === 'by_product' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div className="so-toolbar">
            <div className="so-search-box">
              <Search size={15} className="so-search-icon" />
              <input
                type="text"
                className="input"
                placeholder="Cari SKU atau nama produk..."
                value={productSummarySearch}
                onChange={(e) => setProductSummarySearch(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleSyncLatestSystemStock}
                disabled={isSyncingStock}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title="Sinkronkan dengan stok sistem & mutasi transaksi gudang terkini"
              >
                <RotateCcw size={13} className={isSyncingStock ? 'animate-spin' : ''} />
                <span>{isSyncingStock ? 'Menyinkronkan...' : 'Sinkronkan Stok Sistem'}</span>
              </button>
            </div>
          </div>

          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th>SKU & Produk</th>
                  <th>Satuan</th>
                  <th>Rincian per Lokasi</th>
                  <th className="text-right">Total Sistem</th>
                  <th className="text-right">Total Fisik</th>
                  <th className="text-right">Selisih Total</th>
                  <th>Status Produk</th>
                </tr>
              </thead>
              <tbody>
                {filteredProductSummary.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="reports-empty-cell">
                      Tidak ada data produk yang sesuai.
                    </td>
                  </tr>
                ) : (
                  filteredProductSummary.map((p) => {
                    const physVal = Number(p.totalPhysicalQty) || 0;
                    const sysVal = Number(p.totalSystemQty) || 0;
                    const diffVal = Number(p.difference) || 0;

                    const isMatched = physVal > 0 && diffVal === 0;
                    const isShort = physVal > 0 && diffVal < 0;
                    const isOver = physVal > 0 && diffVal > 0;
                    const isZeroStock = physVal === 0 && sysVal === 0;

                    return (
                      <tr key={p.sku || p.productId || p.id} className="reports-table-row">
                        <td>
                          <div className="text-bold">{p.name}</div>
                          <span className="text-mono" style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                            {p.sku}
                          </span>
                        </td>
                        <td>pcs</td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {(!p.locations || p.locations.length === 0) ? (
                              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                Belum ditemukan di area manapun
                              </span>
                            ) : (
                              p.locations.map((loc, idx) => {
                                const serials = Array.isArray(loc.scannedSerials) ? loc.scannedSerials : [];
                                const hasSerials = serials.length > 0;
                                const locKey = `${p.sku || p.productId || p.id}_${loc.areaId || idx}`;
                                const isExpanded = Boolean(expandedLocationSerials[locKey]);

                                return (
                                  <div
                                    key={idx}
                                    style={{
                                      fontSize: '11px',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: '3px',
                                      padding: '2px 0',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                      <span style={{ fontWeight: 600 }}>📍 {loc.areaName}:</span>
                                      <span style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>
                                        {loc.physicalQty !== null ? renderQty(loc.physicalQty) : '—'}
                                      </span>
                                      {hasSerials && (
                                        <>
                                          <span style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>
                                            [serial: {formatSerialBreakdown(serials)}]
                                          </span>
                                          <button
                                            type="button"
                                            className="btn btn-ghost btn-xs"
                                            onClick={() => setExpandedLocationSerials((prev) => ({ ...prev, [locKey]: !prev[locKey] }))}
                                            style={{
                                              padding: '1px 6px',
                                              fontSize: '10px',
                                              height: 'auto',
                                              display: 'inline-flex',
                                              alignItems: 'center',
                                              gap: '3px',
                                              background: isExpanded ? 'var(--color-primary-light, #e0e7ff)' : 'var(--color-surface-hover, #f1f5f9)',
                                              color: isExpanded ? 'var(--color-primary, #3b82f6)' : 'var(--color-text-secondary)',
                                              border: '1px solid var(--color-border)',
                                              borderRadius: '4px',
                                              cursor: 'pointer',
                                            }}
                                            title="Tampilkan / Sembunyikan Nomor Seri yang Berhasil Di-scan"
                                          >
                                            <Barcode size={11} />
                                            <span>{isExpanded ? 'Tutup SN' : `Lihat ${serials.length} SN`}</span>
                                          </button>
                                        </>
                                      )}
                                      {loc.notes ? (
                                        <span style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>({loc.notes})</span>
                                      ) : null}
                                    </div>

                                    {/* Panel Daftar Nomor Seri yang Berhasil Di-scan */}
                                    {hasSerials && isExpanded && (
                                      <div
                                        style={{
                                          marginTop: '3px',
                                          padding: '6px 8px',
                                          background: 'var(--color-surface-alt, #f8fafc)',
                                          border: '1px solid var(--color-border, #e2e8f0)',
                                          borderRadius: '6px',
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: '4px',
                                          maxWidth: '100%',
                                        }}
                                      >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                                            Nomor Seri ({serials.length} item):
                                          </span>
                                          <button
                                            type="button"
                                            className="btn btn-ghost btn-xs"
                                            onClick={() => {
                                              navigator.clipboard.writeText(serials.join('\n'));
                                              alert(`Berhasil menyalin ${serials.length} nomor seri ke clipboard!`);
                                            }}
                                            style={{ fontSize: '9.5px', padding: '1px 5px', height: '18px' }}
                                          >
                                            📋 Salin Semua
                                          </button>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', maxHeight: '140px', overflowY: 'auto' }}>
                                          {serials.map((sn, sIdx) => {
                                            const u = getSerialUnit(null, sn);
                                            return (
                                              <span
                                                key={sIdx}
                                                style={{
                                                  display: 'inline-flex',
                                                  alignItems: 'center',
                                                  gap: '4px',
                                                  background: 'var(--color-surface, #ffffff)',
                                                  border: '1px solid var(--color-border, #cbd5e1)',
                                                  borderRadius: '3px',
                                                  padding: '1px 5px',
                                                  fontFamily: 'monospace',
                                                  fontSize: '10px',
                                                }}
                                              >
                                                <span>{sn}</span>
                                                <span style={{ color: 'var(--color-primary, #2563eb)', fontSize: '9px', fontWeight: 600 }}>
                                                  ({u})
                                                </span>
                                              </span>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </td>
                        <td className="text-right font-bold text-mono">
                          {renderQty(p.totalSystemQty)}
                        </td>
                        <td className="text-right font-bold text-mono text-green">
                          {renderQty(p.totalPhysicalQty)}
                        </td>
                        <td className="text-right font-bold text-mono">
                          <span
                            className={
                              diffVal === 0
                                ? 'so-diff-val--zero'
                                : diffVal > 0
                                ? 'so-diff-val--pos'
                                : 'so-diff-val--neg'
                            }
                          >
                            {renderQty(diffVal, { signed: true })}
                          </span>
                        </td>
                        <td>
                          {isMatched ? (
                            <span className="so-badge so-badge--matched">
                              <CheckCircle2 size={12} /> Sesuai
                            </span>
                          ) : isShort ? (
                            <span className="so-badge so-badge--shortage">
                              <AlertTriangle size={12} /> Kurang ({Math.abs(diffVal)} pcs)
                            </span>
                          ) : isOver ? (
                            <span className="so-badge so-badge--overage">
                              <AlertTriangle size={12} /> Lebih (+{diffVal} pcs)
                            </span>
                          ) : isZeroStock ? (
                            <span className="so-badge so-badge--neutral">
                              Stok 0 (Kosong)
                            </span>
                          ) : (
                            <span className="so-badge so-badge--pending">Belum Diperiksa</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Tombol Lihat Selengkapnya untuk produk stok 0 sistem */}
          {zeroStockCount > 0 && !productSummarySearch.trim() && (
            <div
              style={{
                marginTop: 'var(--space-2)',
                padding: 'var(--space-3)',
                background: 'var(--color-surface, #ffffff)',
                border: '1px dashed var(--color-border, #e2e8f0)',
                borderRadius: 'var(--radius-md, 8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                📦 Terdapat <strong>{zeroStockCount}</strong> produk dengan stok sistem 0 (belum ada temuan fisik).
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowZeroStock((prev) => !prev)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {showZeroStock ? (
                  <>
                    <ChevronUp size={14} />
                    <span>Sembunyikan {zeroStockCount} Produk Stok 0</span>
                  </>
                ) : (
                  <>
                    <ChevronDown size={14} />
                    <span>Lihat Selengkapnya ({zeroStockCount} Produk Stok 0)</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────── */}
      {/* SUBTAB 3: TAB KHUSUS BARANG BERMASALAH                */}
      {/* ───────────────────────────────────────────────────── */}
      {sessionSubTab === 'discrepancies' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div className="so-toolbar" style={{ flexWrap: 'wrap', gap: '10px' }}>
            <div className="so-search-box">
              <Search size={15} className="so-search-icon" />
              <input
                type="text"
                className="input"
                placeholder="Cari lokasi atau barang bermasalah..."
                value={discrepancySearch}
                onChange={(e) => setDiscrepancySearch(e.target.value)}
              />
            </div>

            {/* Filter Mode: Belum Diselesaikan vs Sudah Dikeluarkan vs Semua */}
            <div style={{ display: 'flex', background: 'var(--color-surface-hover, #f1f5f9)', padding: '2px', borderRadius: 'var(--radius-md)', gap: '2px' }}>
              <button
                type="button"
                className={`btn btn-xs ${discrepancyFilterMode === 'unresolved' ? 'btn-primary' : 'btn-ghost text-muted'}`}
                onClick={() => setDiscrepancyFilterMode('unresolved')}
                style={{ fontWeight: 600, padding: '4px 10px' }}
              >
                Belum Diselesaikan ({unresolvedDiscrepancyCount})
              </button>
              <button
                type="button"
                className={`btn btn-xs ${discrepancyFilterMode === 'resolved' ? 'btn-primary' : 'btn-ghost text-muted'}`}
                onClick={() => setDiscrepancyFilterMode('resolved')}
                style={{ fontWeight: 600, padding: '4px 10px' }}
              >
                Sudah Dikeluarkan ({resolvedDiscrepancyCount})
              </button>
              <button
                type="button"
                className={`btn btn-xs ${discrepancyFilterMode === 'all' ? 'btn-primary' : 'btn-ghost text-muted'}`}
                onClick={() => setDiscrepancyFilterMode('all')}
                style={{ fontWeight: 600, padding: '4px 10px' }}
              >
                Semua ({discrepancyItems.length})
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              {!isFinalized && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => setShowWriteOffMissingModal(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  title="Keluarkan nomor seri dan barang yang tidak terdeteksi di rak manapun"
                >
                  <Package size={13} />
                  <span>Keluarkan Barang Hilang</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleSyncLatestSystemStock}
                disabled={isSyncingStock}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title="Sinkronkan dengan stok sistem & mutasi transaksi gudang terkini"
              >
                <RotateCcw size={13} className={isSyncingStock ? 'animate-spin' : ''} />
                <span>{isSyncingStock ? 'Menyinkronkan...' : 'Sinkronkan Stok Sistem'}</span>
              </button>
            </div>
          </div>

          <div className="reports-table-wrapper">
            <table className="reports-table">
              <thead>
                <tr>
                  <th style={{ width: '32px' }}></th>
                  <th>Lokasi / Bagian</th>
                  <th>SKU</th>
                  <th>Nama Barang</th>
                  <th>Satuan</th>
                  <th className="text-right">Stok Sistem</th>
                  <th className="text-right">Stok Fisik</th>
                  <th className="text-right">Selisih</th>
                  <th>Jenis Masalah</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {filteredDiscrepancies.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="reports-empty-cell text-green">
                      <CheckCircle2 size={24} style={{ marginBottom: '6px' }} />
                      <div>Luar biasa! Tidak ada barang bermasalah. Semua stok sesuai.</div>
                    </td>
                  </tr>
                ) : (
                  filteredDiscrepancies.map((item) => {
                    const isExpanded = expandedDiscrepancySku === item.sku;

                    // Ambil seluruh nomor seri yang aktif di database untuk produk ini (hanya yang berstatus 'available' atau temuan SO, tanpa substring collision)
                    const allProdSerials = getRegisteredSerialsForProduct(item.productId, item.sku);
                    const registeredSerials = allProdSerials.filter(
                      (s) => (s.status === 'available' || isSerialFromSoGoodsIn(s.serialNumber, s)) &&
                             (!activeWarehouseId || !s.warehouseId || String(s.warehouseId) === String(activeWarehouseId))
                    );

                    const scannedList = item.scannedSerials || [];
                    const scannedSet = new Set(scannedList.map((s) => s.toLowerCase()));

                    // 1. Missing serials: nomor seri lama di DB yang BELUM di-scan dan BUKAN temuan baru Goods In SO
                    const missingSerials = registeredSerials
                      .filter((s) => !scannedSet.has(String(s.serialNumber || '').toLowerCase()) && !isSerialFromSoGoodsIn(s.serialNumber, s))
                      .map((s) => s.serialNumber);

                    // 2. SO Inflow serials: nomor seri baru hasil temuan fisik yang dikonversi ke Goods In sesi ini
                    const soInflowSerials = registeredSerials
                      .filter((s) => isSerialFromSoGoodsIn(s.serialNumber, s))
                      .map((s) => s.serialNumber);

                    // 3. Found serials: nomor seri yang berhasil di-scan fisik
                    const foundSerials = scannedList;

                    return (
                      <React.Fragment key={item.sku || item.productId || item.id}>
                        <tr
                          className={`reports-table-row so-row-expandable ${isExpanded ? 'so-row-expanded' : ''}`}
                          onClick={() => setExpandedDiscrepancySku(isExpanded ? null : item.sku)}
                          title="Klik untuk membuka / menutup rincian nomor seri"
                          style={{ cursor: 'pointer' }}
                        >
                          <td style={{ width: '32px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                            {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </td>
                          <td className="text-bold">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              {item.locations && item.locations.length > 0 ? (
                                item.locations.map((loc, idx) => (
                                  <div key={idx} style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <MapPin size={12} className="text-accent" />
                                    <span><strong>{loc.areaName}</strong>: {renderQty(loc.physicalQty)}</span>
                                  </div>
                                ))
                              ) : (
                                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                  Belum ditemukan di area manapun
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="text-mono font-bold" style={{ fontSize: '12px' }}>
                            {item.sku}
                          </td>
                          <td className="text-bold">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <span>{item.name}</span>
                              {isItemResolved(item) && (
                                <span className="so-badge" style={{ fontSize: '10px', background: '#dcfce7', color: '#15803d', padding: '1px 6px', fontWeight: 700 }}>
                                  ✓ Dikeluarkan dari Masalah
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 'normal' }}>
                              {registeredSerials.length > 0
                                ? `(${registeredSerials.length} SN di database · ${foundSerials.length} ditemukan fisik)`
                                : '(Non-serial atau belum ada SN di database)'}
                            </div>
                          </td>
                          <td>pcs</td>
                          <td className="text-right text-mono font-bold">{renderQty(item.systemQty)}</td>
                          <td className="text-right text-mono font-bold text-green">
                            {item.physicalQty !== null ? renderQty(item.physicalQty) : '—'}
                          </td>
                          <td className="text-right text-mono font-bold">
                            <span
                              className={
                                item.difference > 0 ? 'so-diff-val--pos' : 'so-diff-val--neg'
                              }
                            >
                              {renderQty(item.difference, { signed: true })}
                            </span>
                          </td>
                          <td>
                            {item.status === 'unlisted' ? (
                              <span className="so-badge so-badge--unlisted">
                                <Sparkles size={11} /> Temuan Fisik
                              </span>
                            ) : item.status === 'not_found' ? (
                              <span className="so-badge so-badge--not_found">
                                <XCircle size={11} /> Tidak Ditemukan
                              </span>
                            ) : item.difference < 0 || item.status === 'shortage' ? (
                              <span className="so-badge so-badge--shortage">
                                <AlertTriangle size={11} /> Kurang (-{Math.abs(item.difference)} pcs)
                              </span>
                            ) : (
                              <span className="so-badge so-badge--overage">
                                <AlertTriangle size={11} /> Lebih (+{item.difference} pcs)
                              </span>
                            )}
                          </td>
                          <td style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                            {item.notes || '—'}
                          </td>
                        </tr>

                        {/* Expandable Serial Numbers & Quick Action Drawer */}
                        {isExpanded && (
                          <tr className="so-expanded-detail">
                            <td colSpan={10} style={{ padding: '16px 20px', background: 'var(--color-surface-hover, #f8fafc)' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                                  <div>
                                    <div style={{ fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <Barcode size={16} className="text-accent" />
                                      <span>Status Nomor Seri: <strong>{item.name}</strong> ({item.sku})</span>
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                                      Terdaftar di Sistem: <strong>{registeredSerials.length} SN</strong> &bull; Ditemukan Fisik: <strong className="text-green">{foundSerials.length + soInflowSerials.length} SN</strong>{soInflowSerials.length > 0 ? ` (${soInflowSerials.length} SN temuan Goods In)` : ''} &bull; Belum Ditemukan: <strong className="text-danger">{missingSerials.length} SN</strong>
                                    </div>
                                  </div>

                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    {item.difference < 0 && (
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCreateAutomaticDocument('goods_out', item);
                                        }}
                                        disabled={isGeneratingDoc}
                                        style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                                        title="Buat draf Goods Out untuk mencatat pengeluaran/penghapusan barang hilang ini"
                                      >
                                        <ArrowUpRight size={14} className="text-danger" />
                                        <span>Buat Draf Goods Out ({Math.abs(item.difference)} pcs)</span>
                                      </button>
                                    )}

                                    {item.difference > 0 && (
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCreateAutomaticDocument('goods_in', item);
                                        }}
                                        disabled={isGeneratingDoc}
                                        style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                                        title="Buat draf Goods In untuk mencatat penerimaan temuan barang lebih ini"
                                      >
                                        <ArrowDownRight size={14} className="text-green" />
                                        <span>Buat Goods In untuk Item Ini (+{item.difference} pcs)</span>
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      className={`btn btn-sm ${isItemResolved(item) ? 'btn-outline-secondary' : 'btn-outline-danger'}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleToggleResolveDiscrepancy(item.sku || item.productId);
                                      }}
                                      style={{ fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                                      title={isItemResolved(item) ? 'Kembalikan barang ini ke daftar masalah aktif' : 'Keluarkan barang ini dari daftar barang masalah'}
                                    >
                                      {isItemResolved(item) ? (
                                        <>
                                          <RotateCcw size={12} />
                                          <span>Kembalikan ke Masalah</span>
                                        </>
                                      ) : (
                                        <>
                                          <Check size={12} className="text-green" />
                                          <span>Keluarkan dari Barang Masalah</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {/* Banner Status Jika Draf Dokumen Penyesuaian Sudah Dibuat */}
                                {(() => {
                                  const key = item.sku || item.productId;
                                  const docInfo = createdDocBySku[key] || getProductRelatedDocuments(item.sku, item.productId).goodsOut;
                                  if (!docInfo) return null;
                                  return (
                                    <div
                                      style={{
                                        background: 'rgba(239, 68, 68, 0.08)',
                                        border: '1px solid rgba(239, 68, 68, 0.3)',
                                        borderRadius: 'var(--radius-sm)',
                                        padding: '10px 14px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '4px',
                                      }}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626', fontWeight: 700, fontSize: '12px' }}>
                                        <Clock size={14} />
                                        <span>Telah Dibuatkan Dokumen Barang Keluar (Goods Out): <strong>{docInfo.documentNumber}</strong></span>
                                        <span className="so-badge" style={{ background: '#fef3c7', color: '#92400e', fontSize: '10px', padding: '1px 6px' }}>
                                          Status: {docInfo.status === 'draft' ? 'Draf / Draft' : docInfo.status}
                                        </span>
                                      </div>
                                      <div style={{ fontSize: '11px', color: 'var(--color-text-main)' }}>
                                        {docInfo.contactName} &bull; Kuantitas: <strong>{docInfo.qty || docInfo.totalPcs} pcs</strong>
                                        {docInfo.serials?.length > 0 && ` (Nomor Seri Hilang: ${docInfo.serials.slice(0, 4).join(', ')}${docInfo.serials.length > 4 ? ` +${docInfo.serials.length - 4} lainnya` : ''})`}
                                      </div>
                                      <div style={{ fontSize: '11px', color: '#059669', fontWeight: 600 }}>
                                        ✓ Dokumen sengaja dibuat dengan status draf agar Anda dapat mengeceknya terlebih dahulu di modul Goods Out sebelum diselesaikan.
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Serial Chips: Missing (Abu-abu) di awal, Found (Hijau) di akhir */}
                                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
                                  {registeredSerials.length === 0 && foundSerials.length === 0 ? (
                                    <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', fontStyle: 'italic', padding: '6px 0' }}>
                                      Tidak ada data nomor seri yang terdaftar untuk produk ini (produk non-serial atau belum didaftarkan nomor serinya).
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                                        Daftar Nomor Seri (Abu-abu: Belum Ditemukan Fisik | Hijau: Berhasil Ditemukan Saat SO):
                                      </div>
                                      <div className="so-serial-chips-list" style={{ gap: '6px' }}>
                                        {/* 1. Missing serials ditempatkan pertama dengan warna abu-abu (hanya yang benar-benar belum ditemukan) */}
                                        {missingSerials.map((sn) => (
                                          <span
                                            key={sn}
                                            className="so-serial-chip so-serial-chip--missing"
                                            title="Nomor seri tercatat di sistem tetapi belum ditemukan fisik"
                                          >
                                            <Tag size={11} />
                                            <span>{sn}</span>
                                            <span style={{ fontSize: '9px', opacity: 0.75 }}>(Belum Ketemu)</span>
                                          </span>
                                        ))}

                                        {/* 2. Serial Baru Hasil Temuan Fisik Goods In sesi SO ini (Aman & Terverifikasi Fisik) */}
                                        {soInflowSerials.map((sn) => (
                                          <span
                                            key={sn}
                                            className="so-serial-chip so-serial-chip--found"
                                            style={{
                                              background: 'rgba(16, 185, 129, 0.12)',
                                              color: '#065f46',
                                              border: '1px solid rgba(16, 185, 129, 0.4)',
                                              fontWeight: 600,
                                            }}
                                            title="Nomor seri ini baru diterbitkan dari temuan fisik Goods In sesi Stock Opname ini"
                                          >
                                            <Sparkles size={11} className="text-green" />
                                            <span>{sn}</span>
                                            <span style={{ fontSize: '9px', fontWeight: 700 }}>(Temuan SO / Goods In)</span>
                                          </span>
                                        ))}

                                        {/* 3. Found serials yang di-scan fisik ditempatkan di paling akhir dengan warna hijau */}
                                        {foundSerials.map((sn) => (
                                          <span
                                            key={sn}
                                            className="so-serial-chip so-serial-chip--found"
                                            title="Nomor seri terdeteksi / ditemukan saat pemeriksaan fisik"
                                          >
                                            <Check size={11} />
                                            <span>{sn}</span>
                                            <span style={{ fontSize: '9px', fontWeight: 700 }}>(Ditemukan)</span>
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────── */}
      {/* SUBTAB 4: REKONSILIASI KESELURUHAN GUDANG             */}
      {/* ───────────────────────────────────────────────────── */}
      {sessionSubTab === 'warehouse_total' && (() => {
        const shortageItems = discrepancyItems.filter((it) => it.status === 'shortage' || it.difference < 0);
        const overageItems = discrepancyItems.filter((it) => it.status === 'overage' || it.status === 'unlisted' || it.difference > 0);
        const totalShortageQty = shortageItems.reduce((acc, it) => acc + Math.abs(it.difference || 0), 0);
        const totalOverageQty = overageItems.reduce((acc, it) => acc + Math.abs(it.difference || 0), 0);

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Notifikasi Dokumen Berhasil Dibuat */}
            {generatedDocNotice && (
              <div
                className="so-banner"
                style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  borderColor: '#10b981',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 16px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <CheckCircle2 size={24} className="text-green" />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#065f46' }}>
                      Dokumen {generatedDocNotice.type === 'goods_out' ? 'Barang Keluar (Goods Out)' : 'Barang Masuk (Goods In)'} Berhasil Dibuat!
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                      Nomor Dokumen: <strong className="text-mono font-bold">{generatedDocNotice.documentNumber}</strong> ({generatedDocNotice.itemCount} jenis barang). Nomor seri yang belum ditemukan otomatis dicantumkan di metadata dokumen.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setGeneratedDocNotice(null)}
                >
                  Tutup Notifikasi
                </button>
              </div>
            )}

            {/* Banner Penjelasan Ringkasan Rekonsiliasi */}
            <div
              className="so-banner"
              style={{
                background: warehouseReconciliation.isBalanced ? 'rgba(16, 185, 129, 0.08)' : 'rgba(99, 102, 241, 0.08)',
                borderColor: warehouseReconciliation.isBalanced ? 'rgba(16, 185, 129, 0.3)' : 'var(--color-accent)',
              }}
            >
              <div className="so-banner__info">
                {warehouseReconciliation.isBalanced ? (
                  <CheckCircle2 size={28} className="text-green" />
                ) : (
                  <ShieldCheck size={28} className="text-accent" />
                )}
                <div>
                  <h3 className="so-banner__title">
                    {warehouseReconciliation.isBalanced
                      ? 'Total Stok Gudang Sesuai Persis (Seimbang)'
                      : 'Pusat Penyelesaian Selisih & Rekonsiliasi Stok'}
                  </h3>
                  <p className="so-banner__desc">
                    {warehouseReconciliation.isBalanced
                      ? 'Seluruh fisik barang yang diperiksa cocok persis dengan data sistem. Anda dapat langsung mengunci dan memfinalisasi sesi ini.'
                      : 'Di tab ini, Anda dapat menyelesaikan selisih stok secara resmi: buat draf Dokumen Goods Out untuk barang hilang/kurang, buat draf Goods In untuk temuan fisik berlebih, atau lakukan finalisasi langsung untuk menyinkronkan database.'}
                  </p>
                </div>
              </div>

              {!isFinalized && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-outline-danger btn-md"
                    onClick={() => setShowWriteOffMissingModal(true)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    title="Keluarkan nomor seri dan barang yang tidak terdeteksi di rak manapun"
                  >
                    <Package size={16} />
                    <span>Keluarkan Barang Hilang (Write-Off)</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-md"
                    onClick={handleOpenFinalize}
                  >
                    <ShieldCheck size={16} />
                    <span>Review & Finalisasi Sesi</span>
                  </button>
                </div>
              )}
            </div>

            {/* TABEL REKAPITULASI FISIK PRODUK & PELACAKAN DOKUMEN PENYESUAIAN */}
            <div
              style={{
                background: 'var(--color-surface, #ffffff)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShieldCheck size={18} className="text-primary" />
                    <span>Rekapitulasi Fisik Produk & Pelacakan Dokumen Penyesuaian</span>
                  </h4>
                  <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    Rincian temuan fisik (berseri vs non-seri) per produk dan pelacakan dokumen resmi <strong>Goods In</strong> (masuk) & <strong>Goods Out</strong> (keluar / hilang).
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className="so-badge so-badge--neutral">
                    Total {reconciliationProductTable.length} Produk Terdata
                  </span>
                </div>
              </div>

              <div className="reports-table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="reports-table" style={{ width: '100%', minWidth: '980px' }}>
                  <thead>
                    <tr>
                      <th>Produk & SKU</th>
                      <th className="text-right">Stok Sistem</th>
                      <th className="text-center" style={{ background: 'rgba(99, 102, 241, 0.04)' }}>Fisik Berseri (SN)</th>
                      <th className="text-center" style={{ background: 'rgba(16, 185, 129, 0.04)' }}>Fisik Non-Seri</th>
                      <th className="text-right">Total Fisik</th>
                      <th className="text-right">Selisih</th>
                      <th>Dokumen Masuk (Goods In)</th>
                      <th>Dokumen Keluar (Goods Out)</th>
                      <th>Status Rekonsiliasi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliationProductTable.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="reports-empty-cell text-muted">
                          Belum ada data produk pada sesi Stock Opname ini.
                        </td>
                      </tr>
                    ) : (
                      reconciliationProductTable.map((p) => {
                        const hasGoodsIn = Boolean(p.goodsIn);
                        const hasGoodsOut = Boolean(p.goodsOut);
                        const isBalanced = p.diff === 0;

                        return (
                          <tr key={p.sku || p.productId || p.id} className="reports-table-row">
                            {/* 1. Nama & SKU */}
                            <td style={{ verticalAlign: 'top' }}>
                              <div style={{ fontWeight: 700, color: 'var(--color-text-main)' }}>{p.name}</div>
                              <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--color-text-secondary)' }}>{p.sku}</div>
                            </td>

                            {/* 2. Stok Sistem */}
                            <td className="text-right text-mono font-bold" style={{ verticalAlign: 'top' }}>
                              {renderQty(p.systemQty)}
                            </td>

                            {/* 3. Fisik Berseri */}
                            <td className="text-center text-mono font-bold" style={{ verticalAlign: 'top', background: 'rgba(99, 102, 241, 0.02)' }}>
                              {p.serialCount > 0 ? (
                                <div>
                                  <span className="text-accent">{p.serialNumbersList.length} SN</span>
                                  <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 'normal' }}>
                                    ({renderQty(p.serialCount)})
                                  </div>
                                  {p.serialNumbersList.length > 0 && (
                                    <div style={{ fontSize: '10px', color: 'var(--color-text-secondary)', fontWeight: '500', marginTop: '2px' }}>
                                      [{formatSerialBreakdown(p.serialNumbersList)}]
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal' }}>0 SN</span>
                              )}
                            </td>

                            {/* 4. Fisik Non-Seri */}
                            <td className="text-center text-mono font-bold" style={{ verticalAlign: 'top', background: 'rgba(16, 185, 129, 0.02)' }}>
                              {p.nonSerialCount > 0 ? (
                                <div>
                                  <span className="text-green">{p.nonSerialCount} pcs</span>
                                  {p.nonSerialBreakdown.length > 0 && (
                                    <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', fontWeight: 'normal' }}>
                                      ({p.nonSerialBreakdown.map((b) => `${b.qty} ${b.unit}`).join(', ')})
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal' }}>0 pcs</span>
                              )}
                            </td>

                            {/* 5. Total Fisik */}
                            <td className="text-right text-mono font-bold text-green" style={{ verticalAlign: 'top' }}>
                              {p.productHasCountedArea ? (
                                renderQty(p.totalPhysical)
                              ) : (
                                <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal', fontSize: '11px' }}>—</span>
                              )}
                            </td>

                            {/* 6. Selisih */}
                            <td className="text-right text-mono font-bold" style={{ verticalAlign: 'top' }}>
                              {!p.productHasCountedArea ? (
                                <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal', fontSize: '11px' }}>—</span>
                              ) : (
                                <span className={p.diff === 0 ? 'text-green' : p.diff > 0 ? 'so-diff-val--pos' : 'so-diff-val--neg'}>
                                  {renderQty(p.diff, { signed: true })}
                                </span>
                              )}
                            </td>

                            {/* 7. Dokumen Masuk (Goods In) */}
                            <td style={{ verticalAlign: 'top', minWidth: '190px' }}>
                              {hasGoodsIn ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px' }}>
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                    <span className="so-badge so-badge--completed" style={{ fontSize: '10px', padding: '2px 6px', fontWeight: 700 }}>
                                      📥 {p.goodsIn.documentNumber}
                                    </span>
                                    {p.goodsIn.status && (
                                      <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
                                        ({p.goodsIn.status})
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ color: 'var(--color-text-secondary)', fontSize: '11px' }}>
                                    {p.goodsIn.contactName || `Temuan SO ${activeSession?.sessionNumber}`}
                                  </div>
                                  <div style={{ color: '#059669', fontWeight: 600, fontSize: '10px' }}>
                                    Masuk: +{p.goodsIn.qty || p.goodsIn.totalPcs} {p.goodsIn.unit || 'pcs'} {p.goodsIn.isNonSerial ? '(Non-Seri)' : ''}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                  {p.diff > 0 ? 'Belum dibuatkan Goods In' : '—'}
                                </span>
                              )}
                            </td>

                            {/* 8. Dokumen Keluar (Goods Out) */}
                            <td style={{ verticalAlign: 'top', minWidth: '200px' }}>
                              {hasGoodsOut ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px' }}>
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                    <span className="so-badge so-badge--shortage" style={{ fontSize: '10px', padding: '2px 6px', fontWeight: 700 }}>
                                      📤 {p.goodsOut.documentNumber}
                                    </span>
                                    <span style={{ fontSize: '10px', background: '#fef3c7', color: '#92400e', borderRadius: '3px', padding: '1px 5px', fontWeight: 600 }}>
                                      {p.goodsOut.status === 'draft' ? 'Draf' : p.goodsOut.status}
                                    </span>
                                  </div>
                                  <div style={{ color: 'var(--color-text-secondary)', fontSize: '11px' }}>
                                    {p.goodsOut.contactName || `Penyesuaian SO ${activeSession?.sessionNumber}`}
                                  </div>
                                  <div style={{ color: '#dc2626', fontWeight: 600, fontSize: '10px' }}>
                                    Keluar: -{p.goodsOut.qty || p.goodsOut.totalPcs} {p.goodsOut.unit || 'pcs'}
                                    {p.goodsOut.serials?.length > 0 && ` (${p.goodsOut.serials.length} SN hilang)`}
                                  </div>
                                </div>
                              ) : (
                                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                                  {p.diff < 0 ? 'Belum dibuatkan Goods Out' : '—'}
                                </span>
                              )}
                            </td>

                            {/* 9. Status Rekonsiliasi */}
                            <td style={{ verticalAlign: 'top' }}>
                              {!p.productHasCountedArea ? (
                                <span className="so-badge so-badge--neutral">
                                  <Clock size={11} /> Belum Diperiksa
                                </span>
                              ) : isBalanced ? (
                                <span className="so-badge so-badge--completed">
                                  <CheckCircle2 size={11} /> Sesuai / Seimbang
                                </span>
                              ) : hasGoodsIn && p.diff > 0 ? (
                                <span className="so-badge so-badge--completed" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--color-primary)' }}>
                                  <CheckCircle2 size={11} /> Terkonversi Goods In
                                </span>
                              ) : hasGoodsOut && p.diff < 0 ? (
                                <span className="so-badge" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                                  <Clock size={11} /> Draf Goods Out Dibuat
                                </span>
                              ) : p.diff < 0 ? (
                                <span className="so-badge so-badge--shortage">
                                  <AlertTriangle size={11} /> Kurang ({Math.abs(p.diff)} pcs)
                                </span>
                              ) : (
                                <span className="so-badge so-badge--overage">
                                  <AlertTriangle size={11} /> Lebih (+{p.diff} pcs)
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Panel Penyelesaian Selisih (Resolution Cards) */}
            <div className="so-resolution-grid">
              {/* PANEL 1: Barang Kurang / Defisit -> Goods Out */}
              <div className="so-resolution-card so-resolution-card--shortage">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div className="reports-kpi-icon-wrap bg-danger-light">
                        <ArrowUpRight size={18} className="text-danger" />
                      </div>
                      <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
                        Barang Kurang / Hilang (Defisit)
                      </h4>
                    </div>
                    <span className="so-badge so-badge--shortage">
                      {shortageItems.length} Produk
                    </span>
                  </div>

                  <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 12px 0' }}>
                    Fisik di gudang lebih sedikit dari catatan sistem (total <strong>-{totalShortageQty} unit</strong> hilang/kurang). Dibuatkan dokumen <strong>Goods Out (Pengeluaran Barang)</strong> untuk menghapus stok hilang dan mencatat nomor seri yang belum ditemukan.
                  </p>

                  {shortageItems.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#059669', fontStyle: 'italic', padding: '10px 0' }}>
                      ✅ Tidak ada barang yang kurang. Stok aman.
                    </div>
                  ) : (
                    <div
                      style={{
                        background: 'var(--color-surface-hover, #f8fafc)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '8px 12px',
                        maxHeight: '140px',
                        overflowY: 'auto',
                        marginBottom: '14px',
                        fontSize: '11px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      {shortageItems.map((it) => (
                        <div key={it.sku || it.productId} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span><strong>{it.sku}</strong> — {it.name}</span>
                          <span className="font-bold text-danger text-mono">
                            {renderQty(it.difference, { signed: true })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-secondary btn-md"
                  onClick={() => handleCreateAutomaticDocument('goods_out')}
                  disabled={shortageItems.length === 0 || isGeneratingDoc || isFinalized}
                  style={{
                    width: '100%',
                    justifyContent: 'center',
                    gap: '6px',
                    borderColor: '#ef4444',
                    color: shortageItems.length === 0 ? 'var(--color-text-muted)' : '#dc2626',
                  }}
                >
                  {isGeneratingDoc ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                      <span>Membuat Draf Dokumen...</span>
                    </>
                  ) : (
                    <>
                      <ArrowUpRight size={16} />
                      <span>Buat Dokumen Goods Out Otomatis ({totalShortageQty.toLocaleString('id-ID')} pcs)</span>
                    </>
                  )}
                </button>
              </div>

              {/* PANEL 2: Barang Lebih / Temuan Fisik -> Goods In */}
              <div className="so-resolution-card so-resolution-card--overage">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div className="reports-kpi-icon-wrap bg-blue-light">
                        <ArrowDownRight size={18} className="text-accent" />
                      </div>
                      <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
                        Barang Lebih / Temuan (Surplus)
                      </h4>
                    </div>
                    <span className="so-badge so-badge--overage">
                      {overageItems.length} Produk
                    </span>
                  </div>

                  <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 12px 0' }}>
                    Fisik di gudang lebih banyak dari catatan sistem (total <strong>+{totalOverageQty} unit</strong> temuan/surplus). Dibuatkan dokumen <strong>Goods In (Penerimaan Barang)</strong> untuk memasukkan stok temuan ke inventori resmi.
                  </p>

                  {overageItems.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#059669', fontStyle: 'italic', padding: '10px 0' }}>
                      ✅ Tidak ada barang berlebih / temuan fisik liar.
                    </div>
                  ) : (
                    <div
                      style={{
                        background: 'var(--color-surface-hover, #f8fafc)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '8px 12px',
                        maxHeight: '140px',
                        overflowY: 'auto',
                        marginBottom: '14px',
                        fontSize: '11px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      {overageItems.map((it) => (
                        <div key={it.sku || it.productId} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span><strong>{it.sku}</strong> — {it.name}</span>
                          <span className="font-bold text-blue text-mono">
                            {renderQty(it.difference, { signed: true })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-secondary btn-md"
                  onClick={() => handleCreateAutomaticDocument('goods_in')}
                  disabled={overageItems.length === 0 || isGeneratingDoc || isFinalized}
                  style={{
                    width: '100%',
                    justifyContent: 'center',
                    gap: '6px',
                    borderColor: '#3b82f6',
                    color: overageItems.length === 0 ? 'var(--color-text-muted)' : '#2563eb',
                  }}
                >
                  {isGeneratingDoc ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                      <span>Membuat Draf Dokumen...</span>
                    </>
                  ) : (
                    <>
                      <ArrowDownRight size={16} />
                      <span>Buat Dokumen Goods In Otomatis (+{totalOverageQty.toLocaleString('id-ID')} pcs)</span>
                    </>
                  )}
                </button>
              </div>

              {/* PANEL 3: Finalisasi Langsung */}
              <div className="so-resolution-card so-resolution-card--balanced">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div className="reports-kpi-icon-wrap bg-green-light">
                        <ShieldCheck size={18} className="text-green" />
                      </div>
                      <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
                        Sinkronisasi Stok Langsung
                      </h4>
                    </div>
                    <span className="so-badge so-badge--completed">
                      Otomatis
                    </span>
                  </div>

                  <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 12px 0' }}>
                    Jika Anda tidak membutuhkan dokumen pengeluaran/penerimaan terpisah, Anda dapat langsung mengunci hasil Stock Opname ini. Database akan otomatis disinkronkan sesuai hasil fisik yang diverifikasi.
                  </p>

                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.05)',
                      border: '1px solid rgba(16, 185, 129, 0.2)',
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                      marginBottom: '14px',
                      fontSize: '11px',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    <div>• Total Stok Sistem: <strong>{warehouseReconciliation.totalSystemQty}</strong></div>
                    <div>• Total Fisik Ditemukan: <strong className="text-green">{warehouseReconciliation.totalPhysicalQty}</strong></div>
                    <div>• Selisih Netto: <strong>{warehouseReconciliation.netDifference > 0 ? '+' : ''}{warehouseReconciliation.netDifference}</strong></div>
                  </div>
                </div>

                {!isFinalized ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-md"
                    onClick={handleOpenFinalize}
                    style={{ width: '100%', justifyContent: 'center', gap: '6px' }}
                  >
                    <ShieldCheck size={16} />
                    <span>Review & Finalisasi Sesi Sekarang</span>
                  </button>
                ) : (
                  <div className="so-badge so-badge--finalized" style={{ padding: '8px 12px', justifyContent: 'center' }}>
                    <CheckCircle2 size={14} />
                    <span>Sesi Sudah Difinalisasi</span>
                  </div>
                )}
              </div>
            </div>

            {/* Tabel Status per Lokasi sebagai Referensi */}
            <div style={{ marginTop: 'var(--space-2)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px', color: 'var(--color-text-secondary)' }}>
                Rincian Status Pengecekan per Bagian / Lokasi Gudang:
              </h4>
              <div className="reports-table-wrapper">
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th>Lokasi / Bagian</th>
                      <th>Status Pengecekan</th>
                      <th className="text-right">Total Barang</th>
                      <th className="text-right">Unit Sistem</th>
                      <th className="text-right">Unit Fisik</th>
                      <th className="text-right">Selisih</th>
                      <th>Kondisi Lokasi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activeSession.areas || []).map((area) => {
                      let sysSum = 0;
                      let physSum = 0;
                      let diffSum = 0;
                      let hasDiscrepancy = false;

                      (area.items || []).forEach((it) => {
                        const sys = Number(it.systemQty) || 0;
                        const phys = it.physicalQty !== null ? Number(it.physicalQty) : 0;
                        sysSum += sys;
                        physSum += phys;
                        diffSum += it.difference || 0;
                        if (['shortage', 'overage', 'not_found', 'unlisted'].includes(it.status)) {
                          hasDiscrepancy = true;
                        }
                      });

                      return (
                        <tr key={area.areaId} className="reports-table-row">
                          <td className="text-bold">📍 {area.areaName}</td>
                          <td>
                            <span
                              className={`so-badge ${
                                area.status === 'completed'
                                  ? 'so-badge--completed'
                                  : 'so-badge--pending'
                              }`}
                            >
                              {area.status === 'completed' ? 'Selesai Dicek' : 'Belum Selesai'}
                            </span>
                          </td>
                          <td className="text-right text-mono font-bold">{area.items?.length || 0}</td>
                          <td className="text-right text-mono font-bold">{sysSum}</td>
                          <td className="text-right text-mono font-bold text-green">{physSum}</td>
                          <td className="text-right text-mono font-bold">
                            <span
                              className={
                                diffSum === 0
                                  ? 'so-diff-val--zero'
                                  : diffSum > 0
                                  ? 'so-diff-val--pos'
                                  : 'so-diff-val--neg'
                              }
                            >
                              {diffSum > 0 ? `+${diffSum}` : diffSum}
                            </span>
                          </td>
                          <td>
                            {hasDiscrepancy ? (
                              <span className="so-badge so-badge--shortage">Ada Selisih</span>
                            ) : area.status === 'completed' ? (
                              <span className="so-badge so-badge--matched">Sesuai</span>
                            ) : (
                              <span className="so-badge so-badge--pending">Pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ───────────────────────────────────────────────────── */}
      {/* MODAL PENGECEKAN AREA TERTENTU                        */}
      {/* ───────────────────────────────────────────────────── */}
      {checkingArea && (
        <div className="so-modal-overlay" onClick={handleCloseCheckingModal}>
          <div className="so-modal so-modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="so-modal__header">
              <div className="so-modal__header-left">
                <div className="reports-kpi-icon-wrap bg-blue-light">
                  <MapPin size={20} className="text-accent" />
                </div>
                <div>
                  <h3 className="so-modal__title">
                    Pemeriksaan Fisik: <strong>{checkingArea.areaName}</strong>
                  </h3>
                  <p className="so-modal__subtitle">
                    Catat seluruh barang fisik yang ditemukan di bagian/lokasi ini.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="so-modal__close-btn"
                onClick={handleCloseCheckingModal}
                disabled={isSavingCount}
              >
                <X size={18} />
              </button>
            </div>

            <div className="so-modal__body">
              {/* Banner Area Terkunci (Selesai) */}
              {isAreaCompleted && (
                <div
                  style={{
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid #10b981',
                    borderRadius: 'var(--radius-md)',
                    padding: '12px 16px',
                    marginBottom: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        background: 'rgba(16, 185, 129, 0.15)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#10b981',
                        flexShrink: 0,
                      }}
                    >
                      <Lock size={18} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--color-text-main)' }}>
                        Area Ini Sudah Selesai Diperiksa (Terkunci)
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        Pemeriksaan fisik di area ini telah selesai. Seluruh data terkunci dan tidak dapat diubah kembali, kecuali Anda menghapus hasil pemeriksaan untuk melakukan Stock Opname ulang.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Barcode & Serial Number Scanner Bar */}
              {!isAreaLocked && (
                <div className="so-scan-bar" style={{ marginBottom: '16px' }}>
                  <div className="so-scan-bar__header">
                    <div className="so-scan-bar__title">
                      <Barcode size={18} className="text-accent" />
                      <span>Scan Barcode / Serial Number Barang Fisik</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {isCameraActive && hasTorch && (
                        <button
                          type="button"
                          className={`btn btn-sm ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={toggleTorch}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                          title="Nyalakan/matikan senter untuk tempat gelap"
                        >
                          <Sparkles size={14} />
                          <span>{isTorchOn ? '💡 Senter: ON' : '💡 Senter: OFF'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className={`btn btn-sm ${isCameraActive ? 'btn-danger' : 'btn-secondary'}`}
                        onClick={() => setIsCameraActive(!isCameraActive)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                      >
                        <Camera size={14} />
                        <span>{isCameraActive ? 'Tutup Kamera' : 'Buka Kamera Scanner'}</span>
                      </button>
                    </div>
                  </div>

                  {isCameraActive && (
                    <div className="so-camera-wrapper">
                      <div id="so-camera-reader" />
                      <div className="so-scan-reticle">
                        <div className="so-scan-reticle__laser" />
                        <div className="so-scan-reticle__corner top-left" />
                        <div className="so-scan-reticle__corner top-right" />
                        <div className="so-scan-reticle__corner bottom-left" />
                        <div className="so-scan-reticle__corner bottom-right" />
                        <div className="so-scan-reticle__hint">
                          <span>Arahkan ke Barcode atau QR Code</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="so-scan-bar__inputs">
                    <div style={{ flex: 1, position: 'relative' }}>
                      <input
                        ref={barcodeInputRef}
                        type="text"
                        className="input font-bold"
                        placeholder="Scan barcode gun / ketik nomor seri (misal: LGB-ETB-L-10BL-...) lalu tekan Enter..."
                        defaultValue=""
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const val = e.currentTarget.value;
                            e.currentTarget.value = '';
                            if (val && val.trim()) {
                              handleEnqueueBarcode(val, { source: 'input' });
                            }
                          }
                        }}
                        autoFocus
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-md"
                      onClick={() => {
                        if (barcodeInputRef.current) {
                          const val = barcodeInputRef.current.value;
                          barcodeInputRef.current.value = '';
                          if (val && val.trim()) {
                            handleEnqueueBarcode(val, { source: 'input' });
                          }
                          barcodeInputRef.current.focus();
                        }
                      }}
                    >
                      <Barcode size={15} />
                      <span>Scan Seri</span>
                    </button>
                  </div>

                  {/* Real-Time Processing & Queue Bar */}
                  {(activeScanItem || scanQueue.length > 0) && (
                    <div className={`so-scan-queue-bar ${activeScanItem ? 'is-processing' : ''}`}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        <Loader2 size={16} className="animate-spin text-accent" style={{ flexShrink: 0 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600 }}>
                            {activeScanItem ? 'Sedang mencari serial:' : 'Mempersiapkan antrean...'}
                          </span>
                          {activeScanItem && (
                            <span
                              className="font-mono font-bold text-accent"
                              style={{
                                background: 'rgba(99, 102, 241, 0.12)',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                border: '1px solid rgba(99, 102, 241, 0.25)',
                              }}
                            >
                              {activeScanItem.code}
                            </span>
                          )}
                          <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                            ({activeScanItem?.step || 'Memproses...'})
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <span
                          className="badge font-bold"
                          style={{
                            fontSize: '11px',
                            padding: '3px 8px',
                            background: 'rgba(99, 102, 241, 0.15)',
                            color: 'var(--color-accent)',
                            border: '1px solid rgba(99, 102, 241, 0.3)',
                          }}
                        >
                          Antrean: {scanQueue.length} serial
                        </span>
                        {scanQueue.length > 0 && (
                          <div className="so-scan-queue-chips">
                            {scanQueue.slice(0, 3).map((item, idx) => (
                              <span key={item.id} className="so-scan-queue-chip" title={item.code}>
                                #{idx + 1} {item.code.length > 18 ? item.code.slice(0, 16) + '...' : item.code}
                              </span>
                            ))}
                            {scanQueue.length > 3 && (
                              <span style={{ fontSize: '10px', color: 'var(--color-text-secondary)' }}>
                                +{scanQueue.length - 3} lagi
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Riwayat & Feed Hasil Scan Terakhir */}
                  {recentScanFeed.length > 0 && (
                    <div style={{ marginTop: '4px' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '4px',
                          fontSize: '11px',
                          fontWeight: 600,
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Clock size={12} />
                          <span>Riwayat Tembakan Scanner ({recentScanFeed.length})</span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-muted"
                          onClick={() => setRecentScanFeed([])}
                          style={{ padding: '0 4px', height: 'auto', fontSize: '10px' }}
                        >
                          Bersihkan Feed
                        </button>
                      </div>

                      <div className="so-scan-feed">
                        {recentScanFeed.map((feed) => (
                          <div key={feed.id} className={`so-scan-feed-item is-${feed.status}`}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                              {feed.status === 'success' && <CheckCircle2 size={15} className="text-green" style={{ flexShrink: 0 }} />}
                              {feed.status === 'warning' && <AlertTriangle size={15} className="text-warning" style={{ flexShrink: 0 }} />}
                              {feed.status === 'error' && <XCircle size={15} className="text-danger" style={{ flexShrink: 0 }} />}
                              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span className="font-mono font-bold" style={{ fontSize: '12px', color: 'var(--color-text-primary)' }}>
                                    {feed.code}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: '10px',
                                      fontWeight: 700,
                                      textTransform: 'uppercase',
                                      color:
                                        feed.status === 'success' ? '#10b981' : feed.status === 'warning' ? '#f59e0b' : '#ef4444',
                                    }}
                                  >
                                    {feed.title}
                                  </span>
                                </div>
                                <span
                                  style={{
                                    fontSize: '11px',
                                    color: 'var(--color-text-secondary)',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {feed.detail}
                                </span>
                              </div>
                            </div>
                            <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                              {feed.time
                                ? new Date(feed.time).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                  })
                                : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {scanNotification && (
                    <div
                      className="so-banner"
                      style={{
                        padding: '8px 12px',
                        margin: 0,
                        background: scanNotification.type === 'success' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        borderColor: scanNotification.type === 'success' ? '#10b981' : '#ef4444',
                        fontSize: '12px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      {scanNotification.type === 'success' ? (
                        <CheckCircle2 size={16} className="text-green" />
                      ) : (
                        <AlertTriangle size={16} className="text-danger" />
                      )}
                      <span>{scanNotification.message}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Form Cepat Tambah Barang yang Ditemukan di Area Ini */}
              {!isAreaLocked && (
                <div
                  style={{
                    background: 'var(--color-surface)',
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-border)',
                    marginBottom: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Plus size={16} className="text-accent" />
                    <span>+ Tambah Manual Produk Katalog ke Area Ini</span>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '240px', position: 'relative' }}>
                      <input
                        type="text"
                        className="input"
                        placeholder="Cari produk dari katalog gudang (SKU / Nama)..."
                        value={inlineAddSearch}
                        onChange={(e) => setInlineAddSearch(e.target.value)}
                      />
                      {inlineAddSearch.trim() && filteredCatalogForInline.length > 0 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            zIndex: 40,
                            background: 'var(--color-surface)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-md)',
                            boxShadow: 'var(--shadow-lg)',
                            maxHeight: '190px',
                            overflowY: 'auto',
                            marginTop: '2px',
                          }}
                        >
                          {filteredCatalogForInline.map((p) => (
                            <div
                              key={p.id}
                              onClick={() => {
                                setInlineSelectedProduct(p);
                                setInlineAddSearch(`${p.sku} - ${p.name}`);
                                setInlineUnit(p.unitKey || p.unit || 'pcs');
                              }}
                              style={{
                                padding: '8px 12px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                borderBottom: '1px solid var(--color-border)',
                                background:
                                  inlineSelectedProduct?.id === p.id ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                              }}
                            >
                              <div style={{ fontWeight: 600 }}>
                                <strong>{p.sku}</strong> — {p.name}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                Total Stok Sistem Gudang: {p.stock} {p.unitKey || 'pcs'}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ width: '130px' }}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className="input font-bold"
                        placeholder="Jumlah Fisik"
                        value={inlinePhysicalQty}
                        onChange={(e) => setInlinePhysicalQty(e.target.value)}
                      />
                    </div>

                    <div style={{ width: '135px' }}>
                      <select
                        className="input"
                        value={inlineUnit}
                        onChange={(e) => setInlineUnit(e.target.value)}
                        style={{ fontSize: '12px', padding: '6px 8px' }}
                      >
                        {customUnits.map((u) => (
                          <option key={u.key} value={u.key}>
                            {formatUnitOption(u.key)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary btn-md"
                      onClick={handleAddInlineProductToArea}
                      disabled={!inlineSelectedProduct || !inlinePhysicalQty}
                    >
                      <Plus size={15} />
                      <span>Tambahkan</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Toolbar Pencarian dalam Checklist Area */}
              <div className="so-toolbar" style={{ marginBottom: '10px' }}>
                <div className="so-search-box" style={{ flex: 1 }}>
                  <Search size={15} className="so-search-icon" />
                  <input
                    type="text"
                    className="input"
                    placeholder="Saring barang yang sudah dicatat di area ini..."
                    value={checkingSearch}
                    onChange={(e) => setCheckingSearch(e.target.value)}
                  />
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  Total {checkingItems.length} barang tercatat di area ini
                </div>
              </div>

              {/* Tabel Checklist Barang di Area */}
              <div className="reports-table-wrapper so-checking-table">
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th>SKU & Barang</th>
                      <th>Satuan</th>
                      <th style={{ width: '150px' }} className="text-right">
                        Jumlah Fisik Aktual
                      </th>
                      <th>Catatan / Keterangan</th>
                      {!isAreaLocked && <th style={{ width: '60px' }} className="text-center">Aksi</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCheckingItems.length === 0 ? (
                      <tr>
                        <td colSpan={isAreaLocked ? 4 : 5} className="reports-empty-cell" style={{ padding: '30px', textAlign: 'center' }}>
                          Belum ada barang di area ini. Silakan scan barcode nomor seri di atas atau cari produk katalog.
                        </td>
                      </tr>
                    ) : (
                      filteredCheckingItems.flatMap((item) => {
                        const hasSerials = Array.isArray(item.scannedSerials) && item.scannedSerials.length > 0;
                        const serialGroups = hasSerials ? getSerialGroups(item) : [];
                        const itemPcs = computeItemPcs(item);

                        // Ambil daftar manualEntries (multi-satuan non-seri)
                        const rawManualEntries = Array.isArray(item.manualEntries) && item.manualEntries.length > 0
                          ? item.manualEntries
                          : (item.manualQty !== undefined && item.manualQty !== null && String(item.manualQty).trim() !== ''
                              ? [{ id: `m_legacy_${item.id}`, qty: String(item.manualQty), unit: item.manualUnit || item.inputUnit || item.unit || 'pcs' }]
                              : [{ id: `m_init_${item.id}`, qty: item.inputVal !== undefined && item.inputVal !== null ? String(item.inputVal) : '', unit: item.inputUnit || item.manualUnit || item.unit || 'pcs' }]);

                        const rowGroups = [
                          ...serialGroups.map((g) => ({ ...g, isSerial: true })),
                          ...rawManualEntries.map((m, mIdx) => ({
                            ...m,
                            isManual: true,
                            manualIndex: mIdx,
                            totalManuals: rawManualEntries.length,
                          })),
                        ];

                        return rowGroups.map((rowObj, gIdx) => {
                          const isFirst = gIdx === 0;
                          const isSerial = Boolean(rowObj.isSerial);
                          const isManual = Boolean(rowObj.isManual);
                          const g = isSerial ? rowObj : null;
                          const groupSerials = g
                            ? item.scannedSerials.filter((sn) => getSerialUnit(item, sn) === g.unit)
                            : [];
                          const groupPcs = g ? g.count * g.multiplier : null;

                          // Untuk baris fisik non-seri manual
                          const entryQtyRaw = isManual ? (rowObj.qty ?? '') : '';
                          const entryQtyStr = String(entryQtyRaw).trim();
                          const entryQtyNum = entryQtyStr !== '' && !isNaN(Number(entryQtyStr)) ? Number(entryQtyStr) : null;
                          const entryUnit = isManual ? (rowObj.unit || 'pcs') : 'pcs';
                          const entryMult = Number(getMultiplier(entryUnit)) || 1;
                          const entryPcs = entryQtyNum !== null ? entryQtyNum * entryMult : null;
                          const isLastManual = isManual && rowObj.manualIndex === rowObj.totalManuals - 1;

                          return (
                            <tr
                              key={`${item.id}-${isSerial ? `serial-${g.unit}` : `manual-${rowObj.id}`}`}
                              className="reports-table-row"
                              style={!isFirst ? { background: 'rgba(99, 102, 241, 0.03)' } : undefined}
                            >
                              <td style={!isFirst ? { paddingLeft: '28px' } : undefined}>
                                {isFirst ? (
                                  <>
                                    <div className="text-bold">{item.name}</div>
                                    <span className="text-mono" style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                      {item.sku}
                                    </span>
                                    {itemPcs !== null && (
                                      <div style={{ fontSize: '11px', marginTop: '2px', color: 'var(--color-primary)' }}>
                                        Total fisik: <strong>{itemPcs.toLocaleString('id-ID')} pcs</strong>
                                      </div>
                                    )}
                                    {isManual && rowObj.totalManuals > 1 && (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                                        <span className="text-mono" style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                          ↳ Baris #{rowObj.manualIndex + 1} ({formatUnitOption(rowObj.unit)})
                                        </span>
                                        <span className="so-badge so-badge--neutral" style={{ fontSize: '10px' }}>
                                          Non-Seri
                                        </span>
                                      </div>
                                    )}
                                  </>
                                ) : isManual ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span className="text-mono" style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                      ↳ Fisik Non-Seri {rowObj.totalManuals > 1 ? `(#${rowObj.manualIndex + 1} - ${formatUnitOption(rowObj.unit)})` : '(Manual / Lepas)'}
                                    </span>
                                    <span className="so-badge so-badge--neutral" style={{ fontSize: '10px' }}>
                                      Tanpa Barcode
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-mono" style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                                    ↳ {item.sku} (satuan lain)
                                  </span>
                                )}

                                {/* Chip serial number untuk satuan ini (Virtual Windowing: Ringan & Cepat) */}
                                {groupSerials.length > 0 && (
                                  <div className="so-serial-chips-list" style={{ marginTop: '4px' }}>
                                    {(() => {
                                      const groupKey = `${item.id}-${g?.unit || 'all'}`;
                                      const isSearching = Boolean(checkingSearch.trim());
                                      const isExpanded = Boolean(expandedSerialGroups[groupKey]) || isSearching;
                                      const visibleSerials = isExpanded ? groupSerials : groupSerials.slice(0, 8);
                                      const hiddenCount = groupSerials.length - visibleSerials.length;

                                      return (
                                        <>
                                          {visibleSerials.map((sn) => (
                                            <span key={sn} className="so-serial-chip so-serial-chip--found">
                                              <span>{sn}</span>
                                              {!isAreaLocked && (
                                                <X
                                                  size={11}
                                                  className="so-serial-chip--remove"
                                                  onClick={() => handleRemoveScannedSerial(item.id, sn)}
                                                  title="Hapus nomor seri ini dari hitungan"
                                                />
                                              )}
                                            </span>
                                          ))}

                                          {hiddenCount > 0 && (
                                            <button
                                              type="button"
                                              className="so-serial-chip"
                                              style={{
                                                cursor: 'pointer',
                                                background: 'rgba(99, 102, 241, 0.12)',
                                                border: '1px dashed rgba(99, 102, 241, 0.45)',
                                                color: 'var(--color-primary, #6366f1)',
                                                fontWeight: 600,
                                                fontSize: '11px',
                                                padding: '2px 8px',
                                                borderRadius: '4px',
                                              }}
                                              onClick={() =>
                                                setExpandedSerialGroups((prev) => ({
                                                  ...prev,
                                                  [groupKey]: true,
                                                }))
                                              }
                                              title="Tampilkan seluruh nomor seri barang ini"
                                            >
                                              +{hiddenCount} serial lagi... (Lihat Semua)
                                            </button>
                                          )}

                                          {isExpanded && groupSerials.length > 8 && !isSearching && (
                                            <button
                                              type="button"
                                              className="so-serial-chip"
                                              style={{
                                                cursor: 'pointer',
                                                background: 'rgba(239, 68, 68, 0.08)',
                                                border: '1px dashed rgba(239, 68, 68, 0.35)',
                                                color: 'var(--color-danger, #ef4444)',
                                                fontWeight: 600,
                                                fontSize: '11px',
                                                padding: '2px 8px',
                                                borderRadius: '4px',
                                              }}
                                              onClick={() =>
                                                setExpandedSerialGroups((prev) => ({
                                                  ...prev,
                                                  [groupKey]: false,
                                                }))
                                              }
                                              title="Ringkas tampilan nomor seri"
                                            >
                                              ▲ Ringkas Tampilan
                                            </button>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}

                                {/* Status Box jika entri non-seri ini telah di-convert ke Barang Masuk (Goods In) */}
                                {isManual && rowObj.convertedToGoodsIn && (
                                  <div
                                    style={{
                                      marginTop: '6px',
                                      padding: '8px 10px',
                                      background: 'rgba(16, 185, 129, 0.08)',
                                      border: '1px solid #10b981',
                                      borderRadius: 'var(--radius-sm)',
                                      fontSize: '11px',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: '3px',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#059669', fontWeight: 700 }}>
                                      <CheckCircle2 size={13} />
                                      <span>Telah Di-import ke Barang Masuk ({rowObj.convertedToGoodsIn.documentNumber})</span>
                                    </div>
                                    <div style={{ color: 'var(--color-text-main)' }}>
                                      Produk: <strong>{item.name}</strong> &bull; Jumlah: <strong>{rowObj.convertedToGoodsIn.qty} {formatUnitOption(rowObj.convertedToGoodsIn.unit)}</strong> ({rowObj.convertedToGoodsIn.totalPcs} pcs)
                                    </div>
                                  </div>
                                )}

                                {/* Tombol praktis + Tambah Satuan Non-Seri Lain (muncul di baris manual terakhir jika tidak terkunci) */}
                                {isLastManual && !isAreaLocked && (
                                  <div style={{ marginTop: '6px' }}>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-xs text-primary"
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 6px' }}
                                      onClick={() => handleAddManualEntry(item.id, rowObj.unit || 'pcs')}
                                      title="Tambah baris satuan non-seri lainnya untuk produk ini"
                                    >
                                      <Plus size={12} />
                                      <span>+ Tambah Satuan Non-Seri</span>
                                    </button>
                                  </div>
                                )}
                              </td>

                              <td style={{ minWidth: '150px' }}>
                                {isSerial ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    <span className="so-badge so-badge--pending" style={{ width: 'fit-content' }}>
                                      {formatUnitOption(g.unit)}
                                    </span>
                                    <small style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
                                      🔒 Mengikuti serial number
                                    </small>
                                  </div>
                                ) : (
                                  <select
                                    className="input"
                                    disabled={isAreaLocked}
                                    value={rowObj.unit}
                                    onChange={(e) => handleManualEntryUnitChange(item.id, rowObj.id, e.target.value)}
                                    style={{ fontSize: '12px', padding: '5px 8px' }}
                                  >
                                    {customUnits.map((u) => (
                                      <option key={u.key} value={u.key}>
                                        {formatUnitOption(u.key)}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </td>

                              <td className="text-right">
                                <div className="so-qty-input-wrap" style={{ justifyContent: 'flex-end' }}>
                                  {isSerial ? (
                                    <input
                                      type="number"
                                      disabled
                                      readOnly
                                      className="input so-qty-input text-right font-bold"
                                      value={g.count}
                                      title="Dihitung otomatis dari jumlah serial number yang di-scan"
                                      style={{ width: '120px' }}
                                    />
                                  ) : (
                                    <input
                                      type="number"
                                      min="0"
                                      step="any"
                                      disabled={isAreaLocked}
                                      className="input so-qty-input text-right font-bold"
                                      value={rowObj.qty ?? ''}
                                      placeholder={hasSerials ? '0 (non-seri)' : '0'}
                                      onChange={(e) => handleManualEntryQtyChange(item.id, rowObj.id, e.target.value)}
                                      style={{ width: '120px' }}
                                    />
                                  )}
                                </div>
                                {isSerial ? (
                                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                                    = <strong>{groupPcs.toLocaleString('id-ID')} pcs</strong>
                                  </div>
                                ) : (
                                  entryPcs !== null && (
                                    <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                                      = <strong>{entryPcs.toLocaleString('id-ID')} pcs</strong>
                                    </div>
                                  )
                                )}
                              </td>

                              <td>
                                {isFirst && (
                                  <input
                                    type="text"
                                    disabled={isAreaLocked}
                                    className="input"
                                    placeholder="Catatan..."
                                    value={item.notes || ''}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setCheckingItems((prev) =>
                                        prev.map((it) => (it.id === item.id ? { ...it, notes: val } : it))
                                      );
                                    }}
                                    style={{ fontSize: '12px', padding: '5px 8px' }}
                                  />
                                )}
                              </td>

                              {!isAreaLocked && (
                                <td className="text-center">
                                  {isFirst ? (
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-xs text-danger"
                                      onClick={() => handleRemoveCheckingItem(item.id)}
                                      title="Hapus produk ini dari area"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  ) : isManual && rowObj.totalManuals > 1 ? (
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-xs text-danger"
                                      onClick={() => handleRemoveManualEntry(item.id, rowObj.id)}
                                      title="Hapus baris satuan non-seri ini"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  ) : null}
                                </td>
                              )}
                            </tr>
                          );
                        });
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="so-modal__footer">
              <button
                type="button"
                className="btn btn-secondary btn-md"
                onClick={handleCloseCheckingModal}
                disabled={isSavingCount || isImportingGoodsIn}
              >
                Tutup
              </button>

              {!isFinalized && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* Tombol Jadikan Goods In Keseluruhan untuk seluruh temuan non-seri di area ini */}
                  {unimportedNonSerialTargets.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-md"
                      onClick={handleImportAllNonSerialsToGoodsIn}
                      disabled={isImportingGoodsIn || isSavingCount}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: 'rgba(99, 102, 241, 0.08)',
                        borderColor: 'var(--color-primary)',
                        color: 'var(--color-primary)',
                        fontWeight: 600,
                      }}
                      title="Buat dokumen Barang Masuk (Goods In) resmi untuk seluruh temuan non-seri di area ini (sebagai non-seri, tanpa nomor seri otomatis)"
                    >
                      {isImportingGoodsIn ? (
                        <>
                          <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                          <span>Mengimpor ke Goods In...</span>
                        </>
                      ) : (
                        <>
                          <ArrowDownToLine size={16} />
                          <span>Jadikan Goods In ({unimportedNonSerialTargets.length} non-seri)</span>
                        </>
                      )}
                    </button>
                  )}

                  {isAreaLocked ? (
                    <button
                      type="button"
                      className="btn btn-outline-danger btn-md"
                      onClick={handleResetAreaForRecount}
                      disabled={isSavingCount || isImportingGoodsIn}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        color: 'var(--color-danger, #ef4444)',
                        borderColor: 'var(--color-danger, #ef4444)',
                      }}
                      title="Hapus seluruh hasil pemeriksaan area ini agar dapat melakukan Stock Opname ulang dari awal"
                    >
                      <Trash2 size={15} />
                      <span>Hapus Hasil untuk SO Ulang</span>
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-md"
                        onClick={() => handleSaveAreaCount(false)}
                        disabled={isSavingCount || isImportingGoodsIn}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          opacity: isSavingCount ? 0.75 : 1,
                          cursor: isSavingCount ? 'not-allowed' : 'pointer',
                          pointerEvents: isSavingCount ? 'none' : 'auto',
                        }}
                      >
                        {isSavingCount && savingCountAction === 'draft' ? (
                          <>
                            <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                            <span>Menyimpan Draf...</span>
                          </>
                        ) : (
                          <span>Simpan Draf Sementara</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-md"
                        onClick={handlePromptCompleteArea}
                        disabled={isSavingCount || isImportingGoodsIn}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          opacity: isSavingCount ? 0.75 : 1,
                          cursor: isSavingCount ? 'not-allowed' : 'pointer',
                          pointerEvents: isSavingCount ? 'none' : 'auto',
                        }}
                      >
                        {isSavingCount && savingCountAction === 'complete' ? (
                          <>
                            <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                            <span>Menyelesaikan...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 size={16} />
                            <span>Selesaikan Pengecekan Area Ini</span>
                          </>
                        )}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Tambah Temuan Fisik ── */}
      {showAddUnlistedModal && (
        <div className="so-modal-overlay" onClick={() => !isAddingUnlisted && setShowAddUnlistedModal(false)}>
          <div className="so-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <div className="so-modal__header">
              <div className="so-modal__header-left">
                <div className="reports-kpi-icon-wrap bg-purple-light">
                  <Sparkles size={20} className="text-purple" />
                </div>
                <div>
                  <h3 className="so-modal__title">Tambah Barang di {checkingArea?.areaName}</h3>
                  <p className="so-modal__subtitle">
                    Tambahkan barang dari katalog ke lokasi ini atau catat temuan fisik tak terduga.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="so-modal__close-btn"
                onClick={() => !isAddingUnlisted && setShowAddUnlistedModal(false)}
                disabled={isAddingUnlisted}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleConfirmAddUnlisted}>
              <div className="so-modal__body">
                <div className="form-group">
                  <label className="form-label">Cari Produk dari Katalog</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ketik SKU atau Nama Barang..."
                    value={unlistedSearch}
                    onChange={(e) => setUnlistedSearch(e.target.value)}
                  />
                  {filteredCatalogForUnlisted.length > 0 && (
                    <div
                      style={{
                        maxHeight: '160px',
                        overflowY: 'auto',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        marginTop: '4px',
                      }}
                    >
                      {filteredCatalogForUnlisted.map((p) => (
                        <div
                          key={p.id}
                          onClick={() => {
                            setSelectedUnlistedProduct(p);
                            setUnlistedSearch(`${p.sku} - ${p.name}`);
                          }}
                          style={{
                            padding: '6px 10px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid var(--color-border)',
                            background:
                              selectedUnlistedProduct?.id === p.id
                                ? 'rgba(99, 102, 241, 0.1)'
                                : 'transparent',
                          }}
                        >
                          <strong>{p.sku}</strong> — {p.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <div className="form-group">
                    <label className="form-label">Stok Sistem Tercatat (Opsional)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      className="input"
                      placeholder="0 jika temuan fisik"
                      value={unlistedSystemQty}
                      onChange={(e) => setUnlistedSystemQty(e.target.value)}
                    />
                    <small style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                      Isi jika barang memang tercatat di rak ini
                    </small>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Jumlah Fisik Aktual</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      required
                      className="input"
                      value={unlistedPhysicalQty}
                      onChange={(e) => setUnlistedPhysicalQty(e.target.value)}
                    />
                    <small style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                      Jumlah aktual yang dihitung di lokasi
                    </small>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Keterangan / Catatan</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Contoh: Ditemukan di kardus pojok bawah"
                    value={unlistedNotes}
                    onChange={(e) => setUnlistedNotes(e.target.value)}
                  />
                </div>
              </div>

              <div className="so-modal__footer">
                <button
                  type="button"
                  className="btn btn-secondary btn-md"
                  onClick={() => setShowAddUnlistedModal(false)}
                  disabled={isAddingUnlisted}
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-md"
                  disabled={isAddingUnlisted}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    opacity: isAddingUnlisted ? 0.75 : 1,
                    cursor: isAddingUnlisted ? 'not-allowed' : 'pointer',
                    pointerEvents: isAddingUnlisted ? 'none' : 'auto',
                  }}
                >
                  {isAddingUnlisted ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                      <span>Menambahkan...</span>
                    </>
                  ) : (
                    <span>Tambahkan ke Lokasi Ini</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal Tambah Bagian / Area Langsung ke Sesi SO ── */}
      {showAddSessionAreaModal && (
        <div className="so-modal-overlay" onClick={() => !isSavingArea && setShowAddSessionAreaModal(false)}>
          <div className="so-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="so-modal__header">
              <div className="so-modal__header-left">
                <div className="reports-kpi-icon-wrap bg-blue-light">
                  <MapPin size={20} className="text-accent" />
                </div>
                <div>
                  <h3 className="so-modal__title">Tambah Bagian / Area Gudang</h3>
                  <p className="so-modal__subtitle">
                    Buat lokasi baru (ruangan, rak, pojokan) dan tentukan barang yang tersimpan di dalamnya.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="so-modal__close-btn"
                onClick={() => !isSavingArea && setShowAddSessionAreaModal(false)}
                disabled={isSavingArea}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveAreaToSession}>
              <div className="so-modal__body">
                <div className="form-group">
                  <label className="form-label">Nama Bagian / Area Gudang</label>
                  <input
                    type="text"
                    required
                    className="input"
                    placeholder="Contoh: Ruang Depan, Rak Bedong, PK 5, Gudang Belakang, Area Packing..."
                    value={sessionAreaName}
                    onChange={(e) => setSessionAreaName(e.target.value)}
                  />
                  <small style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                    Nama lokasi bebas sesuai kondisi nyata di gudang Anda.
                  </small>
                </div>

                <div className="form-group">
                  <label className="form-label">Keterangan Lokasi (Opsional)</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Contoh: Rak pojok dekat pintu masuk"
                    value={sessionAreaDesc}
                    onChange={(e) => setSessionAreaDesc(e.target.value)}
                  />
                </div>

                {/* Pilih Produk dari Inventori Gudang */}
                <div className="form-group" style={{ marginTop: 'var(--space-4)' }}>
                  <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Pilih Barang di Lokasi Ini (Opsional / Fleksibel)</span>
                    <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                      {sessionAreaItems.length} barang dipilih
                    </span>
                  </label>
                  <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
                    Pilih produk dari katalog gudang yang ditemukan di area ini. Satu produk dapat tersebar di beberapa rak/area berbeda.
                  </p>

                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                      <input
                        type="text"
                        className="input"
                        placeholder="Cari produk (SKU / Nama)..."
                        value={productSearchForSessionArea}
                        onChange={(e) => setProductSearchForSessionArea(e.target.value)}
                      />
                      {productSearchForSessionArea.trim() && filteredCatalogForSessionArea.length > 0 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            zIndex: 20,
                            background: 'var(--color-surface)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-md)',
                            boxShadow: 'var(--shadow-lg)',
                            maxHeight: '180px',
                            overflowY: 'auto',
                            marginTop: '2px',
                          }}
                        >
                          {filteredCatalogForSessionArea.map((p) => (
                            <div
                              key={p.id}
                              onClick={() => {
                                setSelectedProductForSessionArea(p);
                                setProductSearchForSessionArea(`${p.sku} - ${p.name}`);
                              }}
                              style={{
                                padding: '6px 10px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                borderBottom: '1px solid var(--color-border)',
                                background:
                                  selectedProductForSessionArea?.id === p.id
                                    ? 'rgba(99, 102, 241, 0.1)'
                                    : 'transparent',
                              }}
                            >
                              <strong>{p.sku}</strong> — {p.name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ width: '130px' }}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className="input font-bold"
                        placeholder="Jumlah Fisik"
                        value={qtyForSessionAreaProduct}
                        onChange={(e) => setQtyForSessionAreaProduct(e.target.value)}
                        title="Jumlah fisik yang ditemukan di lokasi ini"
                      />
                    </div>

                    <button
                      type="button"
                      className="btn btn-secondary btn-md"
                      onClick={handleAddProductToSessionAreaDraft}
                      disabled={!selectedProductForSessionArea}
                    >
                      <Plus size={15} />
                      <span>Tambah</span>
                    </button>
                  </div>

                  {/* List Barang yang ditambahkan */}
                  {sessionAreaItems.length > 0 && (
                    <div
                      style={{
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        maxHeight: '160px',
                        overflowY: 'auto',
                      }}
                    >
                      <table className="table" style={{ fontSize: '12px', margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Barang</th>
                            <th className="text-right" style={{ width: '120px' }}>Jumlah Fisik</th>
                            <th style={{ width: '40px' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessionAreaItems.map((item) => (
                            <tr key={item.productId || item.sku}>
                              <td>
                                <strong>{item.sku}</strong> — {item.name}
                              </td>
                              <td className="text-right text-mono font-bold">
                                {item.systemQty} {item.unit}
                              </td>
                              <td className="text-right">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-xs text-danger"
                                  onClick={() => handleRemoveProductFromSessionAreaDraft(item.productId)}
                                  title="Hapus dari alokasi"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {sessionAreaItems.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', fontStyle: 'italic', marginTop: '4px' }}>
                      Tip: Anda juga dapat membuat lokasi kosong sekarang dan menambahkan barang-barangnya nanti saat melakukan pengecekan fisik.
                    </div>
                  )}
                </div>
              </div>

              <div className="so-modal__footer">
                <button
                  type="button"
                  className="btn btn-secondary btn-md"
                  onClick={() => setShowAddSessionAreaModal(false)}
                  disabled={isSavingArea}
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-md"
                  disabled={isSavingArea}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    opacity: isSavingArea ? 0.75 : 1,
                    cursor: isSavingArea ? 'not-allowed' : 'pointer',
                    pointerEvents: isSavingArea ? 'none' : 'auto',
                  }}
                >
                  {isSavingArea ? (
                    <>
                      <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                      <span>Menyimpan Area...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={16} />
                      <span>Buat Bagian / Area Ini</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal Finalisasi & Stock Adjustment ── */}
      {showFinalizeModal && (
        <div className="so-modal-overlay" onClick={() => !isFinalizing && setShowFinalizeModal(false)}>
          <div className="so-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <div className="so-modal__header">
              <div className="so-modal__header-left">
                <div className="reports-kpi-icon-wrap bg-green-light">
                  <ShieldCheck size={20} className="text-green" />
                </div>
                <div>
                  <h3 className="so-modal__title">Finalisasi Stock Opname</h3>
                  <p className="so-modal__subtitle">
                    Kunci hasil pemeriksaan fisik dan terapkan penyesuaian stok jika disetujui.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="so-modal__close-btn"
                onClick={() => !isFinalizing && setShowFinalizeModal(false)}
                disabled={isFinalizing}
              >
                <X size={18} />
              </button>
            </div>

            <div className="so-modal__body">
              {warehouseReconciliation.completedAreasCount < warehouseReconciliation.totalAreasCount && (
                <div
                  className="so-banner"
                  style={{ background: 'rgba(245, 158, 11, 0.1)', borderColor: 'rgba(245, 158, 11, 0.3)' }}
                >
                  <AlertTriangle size={20} className="text-warning" />
                  <div style={{ fontSize: '12px', color: '#b45309' }}>
                    <strong>Peringatan:</strong> Terdapat{' '}
                    {warehouseReconciliation.totalAreasCount - warehouseReconciliation.completedAreasCount}{' '}
                    lokasi yang belum selesai diperiksa! Tetap lanjutkan jika area tersebut sengaja dilewati.
                  </div>
                </div>
              )}

              <div className="so-area-card__stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div className="so-area-card__stat-item">
                  <span className="so-area-card__stat-label">Total Sistem</span>
                  <span className="so-area-card__stat-val">{warehouseReconciliation.totalSystemQty}</span>
                </div>
                <div className="so-area-card__stat-item">
                  <span className="so-area-card__stat-label">Total Fisik</span>
                  <span className="so-area-card__stat-val text-green">
                    {warehouseReconciliation.totalPhysicalQty}
                  </span>
                </div>
                <div className="so-area-card__stat-item">
                  <span className="so-area-card__stat-label">Selisih Netto</span>
                  <span
                    className={`so-area-card__stat-val ${
                      warehouseReconciliation.netDifference === 0
                        ? 'text-green'
                        : warehouseReconciliation.netDifference > 0
                        ? 'text-blue'
                        : 'text-danger'
                    }`}
                  >
                    {warehouseReconciliation.netDifference > 0 ? `+` : ''}
                    {warehouseReconciliation.netDifference}
                  </span>
                </div>
              </div>

              <div
                style={{
                  background: 'rgba(0, 0, 0, 0.02)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={applyAdjustment}
                    onChange={(e) => setApplyAdjustment(e.target.checked)}
                    disabled={isFinalizing}
                    style={{ width: '16px', height: '16px' }}
                  />
                  <span style={{ fontWeight: 700, fontSize: '13px' }}>
                    Terapkan Penyesuaian Stok (Stock Adjustment) ke Database
                  </span>
                </label>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-text-muted)', paddingLeft: '24px' }}>
                  Jika dicentang, stok sistem di produk dan master area akan diperbarui mengikuti hasil fisik yang diverifikasi, dan audit trail otomatis dicatat ke riwayat aktivitas.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Catatan Finalisasi</label>
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Contoh: Disetujui oleh Kepala Gudang"
                  value={finalizeNotes}
                  onChange={(e) => setFinalizeNotes(e.target.value)}
                  disabled={isFinalizing}
                />
              </div>
            </div>

            <div className="so-modal__footer">
              <button
                type="button"
                className="btn btn-secondary btn-md"
                onClick={() => setShowFinalizeModal(false)}
                disabled={isFinalizing}
              >
                Batal
              </button>
              <button
                type="button"
                className="btn btn-primary btn-md"
                onClick={handleConfirmFinalize}
                disabled={isFinalizing}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  opacity: isFinalizing ? 0.75 : 1,
                  cursor: isFinalizing ? 'not-allowed' : 'pointer',
                  pointerEvents: isFinalizing ? 'none' : 'auto',
                }}
              >
                {isFinalizing ? (
                  <>
                    <Loader2 size={16} style={{ animation: 'spin 0.7s linear infinite' }} />
                    <span>Memproses Finalisasi...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck size={16} />
                    <span>Konfirmasi & Finalisasi</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Keluarkan Barang & Serial Hilang (Write-Off) */}
      <WriteOffMissingModal
        isOpen={showWriteOffMissingModal}
        onClose={() => setShowWriteOffMissingModal(false)}
        activeSession={activeSession}
        productSummary={productSummary}
        discrepancyItems={discrepancyItems}
        productSerialsMap={productSerialsMap}
        activeWarehouse={activeWarehouse}
        customUnits={customUnits}
        isSerialFromSoGoodsIn={isSerialFromSoGoodsIn}
        soCreatedSerialsSet={soCreatedSerialsSet}
        soGoodsInDocIds={soGoodsInDocIds}
        onSuccess={async () => {
          await refetchSessionDetail();
          await refetchSessions();
        }}
      />

      {/* Dialog Konfirmasi Umum untuk View Detail */}
      {confirmDialog && (
        <ConfirmModal
          open={Boolean(confirmDialog)}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

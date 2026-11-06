"use client";

import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, Alert, type Tone } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/form-fields";
import { ListToolbar, type ActiveFilter } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";

const PAGE_SIZE = 50;
import { useActiveContext } from "@/lib/demo/active-context-provider";
import {
  FIXTURE_GOODS_OUT,
  FIXTURE_PARTNERS,
  FIXTURE_PRODUCTS,
  type GoodsOutTransaction,
  type Partner,
} from "@/lib/demo/inventory-fixtures";
import {
  createGoodsOutPendingAction,
  updateGoodsOutPendingAction,
  completeGoodsOutAction,
  softDeleteGoodsOutAction,
  getAvailableSerialsByProductAction,
  getAvailableSerialsByWarehouseAction,
  verifySerialForGoodsOutAction,
  resolveGroupForGoodsOutAction,
  mapPurchaseOrderLineAction,
  createInventoryReturnAction,
} from "@/lib/inventory/actions";
import { ReturnSerialPickerDialog } from "@/components/inventory/return-serial-picker-dialog";
import { RotateCcwIcon } from "@/components/ui/icons";
import type { AvailableSerialItem } from "@/lib/db/repositories/inventory-repository";
import { getUnitMultiplier } from "@/lib/inventory/units";
import "./goods-out-modal.css";

export interface GoodsOutViewProps {
  initialTransactions?: GoodsOutTransaction[];
  initialCustomers?: Partner[];
  initialProducts?: Array<{
    id: string;
    name: string;
    sku: string;
    tracking: "SERIAL" | "NON_SERIAL";
    unit: string;
    warehouseId: string;
    stock: number;
    availableStock?: number;
  }>;
  initialPurchaseOrders?: Array<{
    id: string;
    poNumber: string;
    orderDate?: string;
    customerId: string;
    customerName?: string;
    salesPic?: string | null;
    notes?: string | null;
    status: string;
    lines: Array<{
      id: string;
      productId: string;
      productName?: string;
      rawProductName?: string;
      sku?: string;
      orderedQty?: number;
      orderedUnit?: string;
      mappingStatus?: string;
      targetQty: number;
      fulfilledQty: number;
      unitPrice: number;
    }>;
  }>;
  initialSerials?: AvailableSerialItem[];
  initialSelectedPoId?: string;
}

export interface GoodsOutProduct {
  id: string;
  name: string;
  sku: string;
  tracking: "SERIAL" | "NON_SERIAL";
  unit: string;
  warehouseId: string;
  stock: number;
  availableStock: number;
}

export interface GoodsOutFormLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  tracking: "SERIAL" | "NON_SERIAL";
  unit: string;
  availableStock: number;
  quantity: string;
  serials: string[];
  poLineId?: string;
  note?: string;
  rawProductName?: string;
  orderedQty?: number;
  orderedUnit?: string;
  mappingStatus?: string;
  groupId?: string;
  groupSerialsSnapshot?: string[];
}

function createEmptyGoodsOutLine(): GoodsOutFormLine {
  return {
    id: `gol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    productId: "",
    productName: "",
    sku: "",
    tracking: "NON_SERIAL",
    unit: "pcs",
    availableStock: 0,
    quantity: "1",
    serials: [],
  };
}

function formatLineTotalKeluar(
  line: GoodsOutFormLine,
  warehouseSerials: AvailableSerialItem[],
  fallbackUnit: string
): string {
  if (!line.productId) return "—";

  if (line.tracking === "SERIAL") {
    if (!line.serials || line.serials.length === 0) {
      return `0 ${fallbackUnit || "unit"}`;
    }

    const unitCounts: Record<string, number> = {};
    for (const sn of line.serials) {
      const snItem = warehouseSerials.find(
        (ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase()
      );
      const u = (snItem?.unit || line.unit || fallbackUnit || "unit").trim();
      unitCounts[u] = (unitCounts[u] || 0) + 1;
    }

    const entries = Object.entries(unitCounts);
    if (entries.length === 0) {
      return `0 ${fallbackUnit || "unit"}`;
    }

    return entries.map(([u, count]) => `${count} ${u}`).join(" + ");
  }

  const qty = parseFloat(line.quantity) || 0;
  return `${qty} ${line.unit || fallbackUnit || "unit"}`;
}

function formatDocumentGrandTotal(
  lines: GoodsOutFormLine[],
  warehouseSerials: AvailableSerialItem[]
): string {
  const filled = lines.filter((l) => l.productId);
  if (filled.length === 0) return "0 unit";

  const unitCounts: Record<string, number> = {};
  for (const line of filled) {
    if (line.tracking === "SERIAL") {
      for (const sn of line.serials) {
        const snItem = warehouseSerials.find(
          (ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase()
        );
        const u = (snItem?.unit || line.unit || "unit").trim();
        unitCounts[u] = (unitCounts[u] || 0) + 1;
      }
    } else {
      const qty = parseFloat(line.quantity) || 0;
      const u = (line.unit || "unit").trim();
      unitCounts[u] = (unitCounts[u] || 0) + qty;
    }
  }

  const entries = Object.entries(unitCounts);
  if (entries.length === 0) return "0 unit";
  return entries.map(([u, count]) => `${count} ${u}`).join(" + ");
}

function formatDetailGrandTotal(items: GoodsOutTransaction["items"]): string {
  if (!items || items.length === 0) return "0 unit";
  const map: Record<string, number> = {};
  for (const item of items) {
    const u = (item.unit || "unit").trim();
    map[u] = (map[u] || 0) + (item.qty || 0);
  }
  const entries = Object.entries(map);
  if (entries.length === 0) return "0 unit";
  return entries.map(([unit, qty]) => `${qty} ${unit}`).join(" + ");
}

function playScanBeep(type: "success" | "error" = "success") {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    if (type === "success") {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } else {
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch {
    // Audio Context might be blocked by browser autoplay policy
  }
}

export function GoodsOutView({
  initialTransactions,
  initialCustomers,
  initialProducts,
  initialPurchaseOrders,
  initialSerials,
  initialSelectedPoId,
}: GoodsOutViewProps) {
  const { context } = useActiveContext();
  const toast = useToast();

  const [transactions, setTransactions] = useState<GoodsOutTransaction[]>(
    initialTransactions && initialTransactions.length > 0
      ? initialTransactions
      : FIXTURE_GOODS_OUT
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);

  // Modal create states
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPendingTx, setEditingPendingTx] = useState<GoodsOutTransaction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [postImmediately, setPostImmediately] = useState(false);

  // Available serials cache for active warehouse
  const [warehouseSerials, setWarehouseSerials] = useState<AvailableSerialItem[]>(
    initialSerials ?? []
  );

  // Detail Modal state
  const [selectedTxDetail, setSelectedTxDetail] = useState<GoodsOutTransaction | null>(null);
  const [expandedDetailSerialIdxs, setExpandedDetailSerialIdxs] = useState<number[]>([]);

  // Reset expanded serial rows when opening a different transaction
  const detailIdKey = selectedTxDetail?.id ?? null;
  const [prevDetailIdKey, setPrevDetailIdKey] = useState(detailIdKey);
  if (detailIdKey !== prevDetailIdKey) {
    setPrevDetailIdKey(detailIdKey);
    setExpandedDetailSerialIdxs([]);
  }

  function toggleDetailSerialExpand(idx: number) {
    setExpandedDetailSerialIdxs((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  }

  // Cancellation Modal state
  const [cancelTarget, setCancelTarget] = useState<GoodsOutTransaction | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  // Return Modal state (Customer Return from Completed Goods Out)
  const [returnTargetTx, setReturnTargetTx] = useState<GoodsOutTransaction | null>(null);
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);

  // Form Header States
  const autoReference = useMemo(() => {
    const d = new Date();
    const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const seq = String(transactions.length + 1).padStart(3, "0");
    return `GO-${yyyymm}-${seq}`;
  }, [transactions.length]);

  const [customers, setCustomers] = useState<Partner[]>(() => {
    return initialCustomers && initialCustomers.length > 0
      ? initialCustomers
      : FIXTURE_PARTNERS.filter((p) => p.type === "CUSTOMER");
  });

  const [catalogProducts, setCatalogProducts] = useState(initialProducts || []);

  const availableProducts = useMemo<GoodsOutProduct[]>(() => {
    const list: GoodsOutProduct[] = catalogProducts && catalogProducts.length > 0
      ? catalogProducts.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          tracking: p.tracking,
          unit: p.unit,
          warehouseId: p.warehouseId,
          stock: p.stock,
          availableStock: p.availableStock ?? p.stock ?? 0,
        }))
      : FIXTURE_PRODUCTS.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          tracking: p.tracking,
          unit: p.unit,
          warehouseId: p.warehouseId,
          stock: p.stock,
          availableStock: p.stock,
        }));
    return context.warehouseId
      ? list.filter((p) => !p.warehouseId || p.warehouseId === context.warehouseId)
      : list;
  }, [catalogProducts, context.warehouseId]);

  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [address, setAddress] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const customerRef = useRef<HTMLDivElement>(null);

  const filteredCustomers = useMemo(() => {
    const q = recipient.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [customers, recipient]);

  const isNewCustomerDetected = useMemo(() => {
    const q = recipient.trim().toLowerCase();
    if (!q) return false;
    if (selectedCustomerId) return false;
    return !customers.some(
      (c) =>
        c.name.toLowerCase() === q ||
        `${c.name} (${c.code})`.toLowerCase() === q ||
        c.code.toLowerCase() === q
    );
  }, [customers, recipient, selectedCustomerId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (customerRef.current && !customerRef.current.contains(e.target as Node)) {
        setCustomerDropdownOpen(false);
      }
      if (!target.closest(".go-line-item__dropdown-wrap")) {
        setOpenDropdownLineId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const [selectedPoId, setSelectedPoId] = useState("");
  const [documentDate, setDocumentDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [inputNotes, setInputNotes] = useState("");

  // PO Picker & Product Mapping States
  const [isPickPoModalOpen, setIsPickPoModalOpen] = useState(false);
  const [isPoSidebarOpen, setIsPoSidebarOpen] = useState(false);
  const [sidebarSelectedPoId, setSidebarSelectedPoId] = useState("");
  const [poTabFilter, setPoTabFilter] = useState<"ALL" | "REMAINING" | "PENDING" | "FULFILLED">("ALL");
  const [poSearch, setPoSearch] = useState("");
  const [mappingLine, setMappingLine] = useState<{ poLineId: string; lineId: string; rawProductName: string } | null>(null);

  // Worksheet Lines
  const [lines, setLines] = useState<GoodsOutFormLine[]>([createEmptyGoodsOutLine()]);

  // Product Dropdown Search State (per line)
  const [openDropdownLineId, setOpenDropdownLineId] = useState<string | null>(null);
  const [productSearchQueries, setProductSearchQueries] = useState<Record<string, string>>({});

  // Mobile Product Tooltip / Popover State
  const [tooltipProduct, setTooltipProduct] = useState<{
    name: string;
    sku: string;
    tracking: string;
    unit: string;
    availableStock: number;
  } | null>(null);

  // Serial Picker Dropdown per line
  const [openSerialPickerLineId, setOpenSerialPickerLineId] = useState<string | null>(null);
  const [serialSearchQuery, setSerialSearchQuery] = useState("");

  // External / Rapid Barcode Scanner Input State (Global Worksheet Bar)
  const [barcodeInputVal, setBarcodeInputVal] = useState("");
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  // Camera Scanner Modal State
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTargetLineId, setScannerTargetLineId] = useState<string | null>(null);
  const [scannerFeed, setScannerFeed] = useState<Array<{ id: string; code: string; success: boolean; text: string }>>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scanLoopActiveRef = useRef<boolean>(false);
  const lastScannedCodeRef = useRef<{ code: string; time: number }>({ code: "", time: 0 });

  // Paste Excel Modal State
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteRawText, setPasteRawText] = useState("");
  const [pasteImportMode, setPasteImportMode] = useState<"replace" | "append">("append");

  // Load available serials when active warehouse changes
  const loadWarehouseSerials = useCallback(async () => {
    try {
      const res = await getAvailableSerialsByWarehouseAction(context.warehouseId ?? undefined);
      if (res.success && res.serials) {
        setWarehouseSerials(res.serials);
      }
    } catch (err) {
      console.error("Gagal memuat serial number gudang aktif:", err);
    }
  }, [context.warehouseId]);

  useEffect(() => {
    queueMicrotask(() => loadWarehouseSerials());
  }, [loadWarehouseSerials]);

  // Sync recipient and address when customer changes
  function handleCustomerChange(custId: string) {
    setSelectedCustomerId(custId);
    const found = customers.find((c) => c.id === custId);
    if (found) {
      setRecipient(found.name);
      setAddress(found.address ?? "-");
    } else {
      setRecipient("");
      setAddress("");
    }
  }

  // Reset Draft Form manually
  function handleResetDraft() {
    setLines([createEmptyGoodsOutLine()]);
    setRecipient("");
    setAddress("");
    setSelectedCustomerId("");
    setSelectedPoId("");
    setInputNotes("");
  }

  // Sync customer if PO changes
  const selectedPo = useMemo(() => {
    return initialPurchaseOrders?.find((p) => p.id === selectedPoId);
  }, [initialPurchaseOrders, selectedPoId]);
  const selectedPoIdKey = selectedPo?.id ?? null;
  const [prevSelectedPoIdKey, setPrevSelectedPoIdKey] = useState(selectedPoIdKey);
  if (selectedPoIdKey !== prevSelectedPoIdKey) {
    setPrevSelectedPoIdKey(selectedPoIdKey);
    if (selectedPo?.customerId) {
      handleCustomerChange(selectedPo.customerId);
    }
    // Saat PO berubah atau dinonaktifkan, reset pemetaan baris PO lama yang tidak lagi valid
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        poLineId: undefined,
        rawProductName: undefined,
        orderedQty: undefined,
        orderedUnit: undefined,
        mappingStatus: undefined,
      }))
    );
  }

  // Selected PO currently viewed in PO Sidebar
  const sidebarSelectedPo = useMemo(() => {
    return initialPurchaseOrders?.find((p) => p.id === sidebarSelectedPoId);
  }, [initialPurchaseOrders, sidebarSelectedPoId]);

  // Is a PO currently active and linked to this Goods Out document
  const isPoActive = Boolean(selectedPoId && selectedPo);

  // Handle PO connection to the current Goods Out transaction
  const handleConnectPo = useCallback(
    (po: NonNullable<GoodsOutViewProps["initialPurchaseOrders"]>[0]) => {
      setSelectedPoId(po.id);
      setSidebarSelectedPoId(po.id);
      setIsPoSidebarOpen(true);
      setModalOpen(true);

      if (po.customerId) {
        setSelectedCustomerId(po.customerId);
        setRecipient(po.customerName || "");
        const cust = customers.find((c) => c.id === po.customerId);
        if (cust?.address && cust.address !== "-") {
          setAddress(cust.address);
        }
      }
      if (po.notes && !inputNotes) {
        setInputNotes(`PO ${po.poNumber}: ${po.notes}`);
      }

      setLines((prev) => (prev.length > 0 ? prev : [createEmptyGoodsOutLine()]));

      toast.push({
        tone: "info",
        title: "PO Terhubung",
        description: `Pesanan ${po.poNumber} (${po.lines.length} item) terhubung. Kolom 'Item Pesanan PO' telah diaktifkan di tabel.`,
      });
    },
    [customers, inputNotes, toast]
  );

  const handleSelectPo = handleConnectPo;

  // Add an item from PO reference sidebar into Goods Out table
  const handleAddItemFromPo = useCallback(
    (
      poLine: NonNullable<GoodsOutViewProps["initialPurchaseOrders"]>[0]["lines"][0],
      po: NonNullable<GoodsOutViewProps["initialPurchaseOrders"]>[0]
    ) => {
      if (po.status === "PENDING_APPROVAL" || po.status === "DRAFT") {
        toast.push({
          tone: "warning",
          title: "PO Masih Pending",
          description: "Pesanan ini belum disetujui. Setujui PO terlebih dahulu untuk memproses pengeluaran fisik barang.",
        });
        return;
      }

      const remaining = Math.max(0, poLine.targetQty - poLine.fulfilledQty);
      if (remaining <= 0) {
        toast.push({
          tone: "warning",
          title: "Pesanan Sudah Terpenuhi",
          description: `Item ${poLine.rawProductName || poLine.productName} sudah terpenuhi seluruhnya pada PO ini.`,
        });
        return;
      }

      const existingIndex = lines.findIndex((l) => l.poLineId === poLine.id);
      if (existingIndex >= 0) {
        toast.push({
          tone: "info",
          title: "Item Sudah Ada di Tabel",
          description: `Item ini sudah berada pada baris ke-${existingIndex + 1}. Silakan tentukan kuantitas keluar atau nomor seri.`,
        });
        return;
      }

      // Ensure customer & PO connection is set
      if (!selectedPoId || selectedPoId !== po.id) {
        setSelectedPoId(po.id);
        if (po.customerId) {
          setSelectedCustomerId(po.customerId);
          setRecipient(po.customerName || "");
          const cust = customers.find((c) => c.id === po.customerId);
          if (cust?.address && cust.address !== "-") {
            setAddress(cust.address);
          }
        }
        if (po.notes && !inputNotes) {
          setInputNotes(`PO ${po.poNumber}: ${po.notes}`);
        }
      }

      const catProd = catalogProducts.find(
        (p) => p.id === poLine.productId || (poLine.sku && p.sku === poLine.sku)
      );

      if (!poLine.productId || poLine.mappingStatus === "UNMAPPED" || !catProd) {
        toast.push({
          tone: "warning",
          title: "Item Belum Terhubung ke Master Produk",
          description: `Item pesanan "${poLine.rawProductName || poLine.productName}" belum terhubung ke produk resmi di Master Produk. Silakan petakan item ini ke produk resmi terlebih dahulu sebelum diproses ke Goods Out.`,
        });
        return;
      }

      const availStock = catProd.availableStock ?? catProd.stock ?? 0;
      const initialQty = catProd.tracking === "SERIAL"
        ? "0"
        : (availStock <= 0 ? "0" : String(Math.min(remaining, availStock)));

      const newLine: GoodsOutFormLine = {
        id: `gol-po-${poLine.id}-${Date.now()}`,
        productId: catProd.id,
        productName: catProd.name,
        sku: catProd.sku,
        tracking: catProd.tracking,
        unit: catProd.unit || poLine.orderedUnit || "pcs",
        availableStock: availStock,
        quantity: initialQty,
        serials: [],
        poLineId: poLine.id,
        rawProductName: poLine.rawProductName || poLine.productName,
        orderedQty: poLine.orderedQty,
        orderedUnit: poLine.orderedUnit,
        mappingStatus: poLine.mappingStatus || "MAPPED",
      };

      setLines((prev) => {
        if (prev.length === 1 && !prev[0].productId && !prev[0].rawProductName) {
          return [newLine];
        }
        return [...prev, newLine];
      });

      toast.push({
        tone: "success",
        title: "Item Ditambahkan ke Tabel",
        description: `${newLine.productName} dimasukkan ke baris pengeluaran. Konfirmasi kuantitas/nomor seri sebelum simpan.`,
      });
    },
    [catalogProducts, customers, inputNotes, lines, selectedPoId, toast]
  );

  // Open PO sidebar to target PO if navigated with initialSelectedPoId, without pre-filling form
  useEffect(() => {
    if (initialSelectedPoId && initialPurchaseOrders && initialPurchaseOrders.length > 0) {
      const target = initialPurchaseOrders.find((p) => p.id === initialSelectedPoId);
      if (target) {
        setSidebarSelectedPoId(target.id);
        setIsPoSidebarOpen(true);
        setModalOpen(true);
      }
    }
  }, [initialSelectedPoId, initialPurchaseOrders]);

  // Status badge helper for PO Sidebar
  const getPoStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING_APPROVAL":
      case "DRAFT":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Pending
          </span>
        );
      case "CONFIRMED":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-info bg-info-soft/60 border border-info/30 px-2 py-0.5 rounded-full whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-info" />
            Post
          </span>
        );
      case "PARTIALLY_FULFILLED":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-text bg-warning-soft/60 border border-warning/30 px-2 py-0.5 rounded-full whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-warning" />
            Post (Parsial)
          </span>
        );
      case "FULFILLED":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success bg-success-soft/60 border border-success/30 px-2 py-0.5 rounded-full whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Selesai
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-text-muted bg-surface-muted border border-border-default px-2 py-0.5 rounded-full whitespace-nowrap">
            {status}
          </span>
        );
    }
  };

  // Filter daftar PO untuk Sidebar
  const filteredPurchaseOrders = useMemo(() => {
    const list = initialPurchaseOrders || [];
    const q = poSearch.trim().toLowerCase();

    return list.filter((po) => {
      // Tab filter
      if (poTabFilter === "REMAINING") {
        const hasRemaining = po.lines.some((l) => (l.targetQty - l.fulfilledQty) > 0);
        if (!hasRemaining || (po.status !== "CONFIRMED" && po.status !== "PARTIALLY_FULFILLED")) {
          return false;
        }
      } else if (poTabFilter === "PENDING") {
        if (po.status !== "PENDING_APPROVAL" && po.status !== "DRAFT") return false;
      } else if (poTabFilter === "FULFILLED") {
        if (po.status !== "FULFILLED") return false;
      }

      // Search query filter
      if (!q) return true;
      return (
        po.poNumber.toLowerCase().includes(q) ||
        (po.customerName || "").toLowerCase().includes(q) ||
        (po.salesPic || "").toLowerCase().includes(q) ||
        (po.notes || "").toLowerCase().includes(q) ||
        po.lines.some((l) => (l.rawProductName || l.productName || "").toLowerCase().includes(q))
      );
    });
  }, [initialPurchaseOrders, poSearch, poTabFilter]);

  // Tab counters for PO Sidebar
  const poTabCounts = useMemo(() => {
    const list = initialPurchaseOrders || [];
    let all = list.length;
    let remaining = 0;
    let pending = 0;
    let fulfilled = 0;
    for (const po of list) {
      if (po.status === "PENDING_APPROVAL" || po.status === "DRAFT") pending++;
      else if (po.status === "FULFILLED") fulfilled++;
      else if (
        (po.status === "CONFIRMED" || po.status === "PARTIALLY_FULFILLED") &&
        po.lines.some((l) => (l.targetQty - l.fulfilledQty) > 0)
      ) {
        remaining++;
      }
    }
    return { all, remaining, pending, fulfilled };
  }, [initialPurchaseOrders]);

  // Filter daftar PO yang disetujui (legacy helper)
  const eligiblePurchaseOrders = useMemo(() => {
    const list = initialPurchaseOrders || [];
    const q = poSearch.trim().toLowerCase();
    return list.filter((po) => {
      if (po.status !== "CONFIRMED" && po.status !== "PARTIALLY_FULFILLED") return false;
      if (!q) return true;
      return (
        po.poNumber.toLowerCase().includes(q) ||
        (po.customerName || "").toLowerCase().includes(q) ||
        (po.salesPic || "").toLowerCase().includes(q) ||
        (po.notes || "").toLowerCase().includes(q) ||
        po.lines.some((l) => (l.rawProductName || l.productName || "").toLowerCase().includes(q))
      );
    });
  }, [initialPurchaseOrders, poSearch]);

  // Compute all currently chosen serial numbers across all lines in the document
  const allSelectedSerials = useMemo(() => {
    const list: string[] = [];
    for (const l of lines) {
      if (l.tracking === "SERIAL" && l.serials.length > 0) {
        list.push(...l.serials);
      }
    }
    return list;
  }, [lines]);

  const isGoodsOutLineComplete = (l: GoodsOutFormLine) => {
    if (!l.productId) return false;
    if (l.tracking === "SERIAL") {
      return Boolean(l.serials && l.serials.length > 0);
    }
    return Boolean(l.quantity) && Number(l.quantity) > 0;
  };

  const isAnyGoodsOutLineIncomplete = lines.some((l) => !isGoodsOutLineComplete(l));

  // Add line hanya jika baris saat ini sudah terisi lengkap
  function handleAddLine() {
    if (isAnyGoodsOutLineIncomplete) {
      toast.push({
        tone: "warning",
        title: "Baris Belum Lengkap",
        description: "Harap pilih produk dan kuantitas / nomor seri pada baris saat ini sebelum menambah baris baru.",
      });
      return;
    }
    setLines((prev) => [...prev, createEmptyGoodsOutLine()]);
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".go-line-item__search-input");
      const lastInput = inputs[inputs.length - 1];
      lastInput?.focus();
    }, 60);
  }

  const handleGoodsOutFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLElement;
      // Jangan cegah Enter di barcode scanner input karena scanner otomatis mengirim Enter
      if (target === barcodeInputRef.current) {
        return;
      }
      // Jangan cegah Enter di textarea internal notes agar user bisa membuat baris baru di teks
      if (target.tagName === "TEXTAREA") {
        return;
      }

      // Selalu cegah submit form langsung saat tekan Enter
      e.preventDefault();

      // Jika Enter ditekan di dalam tabel worksheet (baris produk)
      const tableRow = target.closest("tr, .go-line-item-card");
      if (tableRow) {
        const allRows = Array.from(document.querySelectorAll(".go-modal__table tbody tr:not(.go-serial-row), .go-line-item-card"));
        const rowIndex = allRows.indexOf(tableRow as HTMLElement);
        const currentLine = lines[rowIndex];

        const isCurrentLineValid = currentLine && isGoodsOutLineComplete(currentLine);
        const allLinesValid = lines.every(isGoodsOutLineComplete);

        if (isCurrentLineValid && allLinesValid) {
          handleAddLine();
        } else {
          // Arahkan ke field yang belum lengkap di baris saat ini
          if (!currentLine?.productId) {
            const searchInput = tableRow.querySelector<HTMLInputElement>(".go-line-item__search-input");
            searchInput?.focus();
          } else if (currentLine.tracking === "NON_SERIAL" && (!currentLine.quantity || Number(currentLine.quantity) <= 0)) {
            const qtyInput = tableRow.querySelector<HTMLInputElement>("input[type='number']");
            qtyInput?.focus();
          } else if (currentLine.tracking === "SERIAL" && (!currentLine.serials || currentLine.serials.length === 0)) {
            const pickSnBtn = tableRow.querySelector<HTMLButtonElement>("button[title*='nomor seri'], button");
            pickSnBtn?.focus();
          }
        }
        return;
      }

      // Jika Enter ditekan di bagian info transaksi (pelanggan, tanggal, PO, dsb),
      // arahkan fokus langsung ke pencarian produk di baris pertama
      const firstSearchInput = document.querySelector<HTMLInputElement>(".go-line-item__search-input");
      if (firstSearchInput) {
        firstSearchInput.focus();
      }
    }
  };

  // Remove line
  function handleRemoveLine(lineId: string) {
    setLines((prev) => {
      if (prev.length <= 1) {
        return [createEmptyGoodsOutLine()];
      }
      return prev.filter((l) => l.id !== lineId);
    });
  }

  // Link or unlink a Goods Out line to a specific PO line
  async function handleLinkPoLine(lineId: string, poLineId: string) {
    const activePo = sidebarSelectedPo || selectedPo;
    const targetLine = lines.find((l) => l.id === lineId);
    const poLine = activePo?.lines.find((pl) => pl.id === poLineId);

    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        if (!poLineId) {
          return {
            ...l,
            poLineId: undefined,
            rawProductName: undefined,
            orderedQty: undefined,
            orderedUnit: undefined,
            mappingStatus: undefined,
          };
        }
        if (!poLine) return l;

        const hasExistingProduct = Boolean(l.productId);
        const mappedPoProd = poLine.productId ? availableProducts.find((p) => p.id === poLine.productId) : undefined;
        const effectiveProd = hasExistingProduct
          ? availableProducts.find((p) => p.id === l.productId)
          : mappedPoProd;
        const isSerial = Boolean(
          effectiveProd?.tracking === "SERIAL" ||
          l.tracking === "SERIAL" ||
          (l.serials && l.serials.length > 0)
        );
        const tracking: "SERIAL" | "NON_SERIAL" = isSerial ? "SERIAL" : (effectiveProd?.tracking || l.tracking || "NON_SERIAL");
        const remaining = Math.max(0, poLine.targetQty - poLine.fulfilledQty);

        const targetProductId = hasExistingProduct ? l.productId : (mappedPoProd?.id || "");
        const targetProductName = hasExistingProduct
          ? l.productName
          : (mappedPoProd?.name || poLine.rawProductName || poLine.productName || "Item Pesanan PO");
        const targetSku = hasExistingProduct ? l.sku : (mappedPoProd?.sku || "");

        const effStock = effectiveProd?.availableStock ?? l.availableStock ?? 0;
        let effQty = l.quantity;
        if (tracking !== "SERIAL") {
          if (effStock <= 0) {
            effQty = "0";
          } else {
            const curQ = l.quantity && Number(l.quantity) > 0 ? Number(l.quantity) : remaining;
            effQty = String(Math.min(remaining, Math.min(effStock, curQ)));
          }
        }

        return {
          ...l,
          poLineId: poLine.id,
          rawProductName: poLine.rawProductName || poLine.productName,
          orderedQty: poLine.orderedQty,
          orderedUnit: poLine.orderedUnit,
          mappingStatus: "MAPPED",
          productId: targetProductId,
          productName: targetProductName,
          sku: targetSku,
          tracking: tracking,
          unit: effectiveProd?.unit || l.unit || poLine.orderedUnit || "pcs",
          availableStock: effStock,
          quantity: effQty,
        };
      })
    );

    // Jika baris Goods Out sudah memiliki produk resmi katalog dan baris PO belum terpetakan, simpan relasi ke backend
    if (selectedPoId && poLine && targetLine?.productId && (!poLine.productId || poLine.mappingStatus === "UNMAPPED")) {
      try {
        await mapPurchaseOrderLineAction({
          poId: selectedPoId,
          lineId: poLine.id,
          productId: targetLine.productId,
        });
      } catch (err) {
        console.error("Gagal menyimpan pemetaan PO:", err);
      }
    }
  }

  // Change product in a line
  async function handleSelectProduct(lineId: string, product: typeof availableProducts[number]) {
    const targetLine = lines.find((l) => l.id === lineId);
    const isSerial = product.tracking === "SERIAL";
    const availStock = product.availableStock ?? product.stock ?? 0;

    let initialQty = "0";
    if (!isSerial) {
      if (availStock <= 0) {
        initialQty = "0";
      } else {
        const curQ = targetLine?.quantity ? Number(targetLine.quantity) : 0;
        initialQty = curQ > 0 ? String(Math.min(availStock, curQ)) : "1";
      }
    }

    // Pemetaan manual: JANGAN memilih item PO secara otomatis saat memilih produk
    let matchedPoLineId = targetLine?.poLineId;
    let rawPoName = targetLine?.rawProductName;
    let ordQty = targetLine?.orderedQty;
    let ordUnit = targetLine?.orderedUnit;

    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        return {
          ...l,
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          tracking: product.tracking,
          unit: product.unit,
          availableStock: availStock,
          quantity: initialQty,
          serials: [],
          poLineId: matchedPoLineId,
          rawProductName: rawPoName,
          orderedQty: ordQty,
          orderedUnit: ordUnit,
          mappingStatus: matchedPoLineId ? "MAPPED" : l.mappingStatus,
        };
      })
    );
    setOpenDropdownLineId(null);

    // Jika baris PO sebelumnya belum dipetakan, simpan relasi ke database
    if (selectedPoId && targetLine?.poLineId && (!targetLine.productId || targetLine.mappingStatus === "UNMAPPED")) {
      try {
        const res = await mapPurchaseOrderLineAction({
          poId: selectedPoId,
          lineId: targetLine.poLineId,
          productId: product.id,
        });
        if (res.success) {
          toast.push({
            tone: "success",
            title: "Produk Berhasil Dipetakan",
            description: `Item pesanan PO berhasil dihubungkan ke produk "${product.name}".`,
          });
        }
      } catch (err) {
        console.error("Gagal menyimpan pemetaan PO:", err);
      }
    }
  }

  // Change quantity in a non-serial line with strict stock clamping
  function handleQuantityChange(lineId: string, val: string) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        if (val === "") {
          return { ...l, quantity: "" };
        }
        const numVal = parseInt(val, 10);
        if (isNaN(numVal) || numVal < 0) {
          return { ...l, quantity: l.availableStock > 0 ? "1" : "0" };
        }
        // Jika stok tersedia 0, kunci di 0
        if (l.availableStock <= 0) {
          return { ...l, quantity: "0" };
        }
        // Maksimum sesuai stok tersedia di gudang (tidak bisa melebihi stok)
        if (numVal > l.availableStock) {
          return { ...l, quantity: String(l.availableStock) };
        }
        return { ...l, quantity: String(numVal) };
      })
    );
  }

  // Toggle tracking mode per baris (mix tracking: produk sama bisa ada yang serial & non-serial)
  function handleToggleLineTracking(lineId: string, newTracking: "SERIAL" | "NON_SERIAL") {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        // Terkunci di mode SERIAL jika sudah ada Serial Number yang diinput / discan
        if (l.serials && l.serials.length > 0) return l;
        if (l.tracking === newTracking) return l;
        let nextQty = "0";
        if (newTracking === "NON_SERIAL") {
          if (l.availableStock <= 0) {
            nextQty = "0";
          } else {
            const prevQ = Number(l.quantity) || 0;
            nextQty = prevQ > 0 ? String(Math.min(l.availableStock, prevQ)) : "1";
          }
        }
        return {
          ...l,
          tracking: newTracking,
          quantity: nextQty,
          serials: [],
        };
      })
    );
    if (openSerialPickerLineId === lineId && newTracking === "NON_SERIAL") {
      setOpenSerialPickerLineId(null);
    }
  }

  // Add a validated serial number to a line
  const addSerialToLine = useCallback(
    async (targetLineId: string, serialNumber: string): Promise<{ success: boolean; message: string }> => {
      const cleanSn = serialNumber.trim();
      if (!cleanSn) return { success: false, message: "Nomor seri tidak boleh kosong." };

      // Cek apakah scan input adalah barcode Group ("G-xxxx")
      if (cleanSn.toUpperCase().startsWith("G-")) {
        try {
          const groupRes = await resolveGroupForGoodsOutAction(cleanSn.toUpperCase(), context.warehouseId || "");
          if (!groupRes.success || !("group" in groupRes) || !groupRes.group || !groupRes.lines) {
            return {
              success: false,
              message: ("error" in groupRes ? groupRes.error : undefined) || `Group ${cleanSn} tidak valid atau tidak tersedia di gudang ini.`,
            };
          }

          const resolvedGroup = groupRes.group;
          const resolvedLines = groupRes.lines;

          // Cek apakah ada komponen group yang sudah terdaftar di dokumen saat ini
          for (const gl of resolvedLines) {
            for (const s of gl.serials) {
              if (allSelectedSerials.includes(s)) {
                return {
                  success: false,
                  message: `SN '${s}' di dalam ${resolvedGroup.groupNumber} sudah ada di daftar Goods Out.`,
                };
              }
            }
          }

          // Masukkan baris-baris produk dari group
          const newGroupLines: GoodsOutFormLine[] = resolvedLines.map((gl) => {
            const matchedProd = availableProducts.find((p) => p.id === gl.productId);
            return {
              id: `gol-grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              productId: gl.productId,
              productName: gl.productName,
              sku: gl.sku,
              tracking: "SERIAL",
              unit: matchedProd?.unit || "pcs",
              availableStock: matchedProd?.availableStock ?? matchedProd?.stock ?? gl.quantity,
              quantity: String(gl.quantity),
              serials: gl.serials,
              groupId: resolvedGroup.id,
              groupSerialsSnapshot: gl.serials,
            };
          });

          setLines((prev) => {
            const nonEmpties = prev.filter((l) => Boolean(l.productId));
            return [...nonEmpties, ...newGroupLines];
          });

          return {
            success: true,
            message: `Group ${resolvedGroup.groupNumber} (${resolvedGroup.groupName || "SN Group"}) berhasil dimasukkan (${resolvedLines.length} produk, total ${resolvedGroup.totalBaseQtyPcs} pcs).`,
          };
        } catch (err: unknown) {
          return {
            success: false,
            message: err instanceof Error ? err.message : `Gagal memproses Group ${cleanSn}.`,
          };
        }
      }

      // Duplicate check across entire document
      if (allSelectedSerials.includes(cleanSn)) {
        return {
          success: false,
          message: `SN '${cleanSn}' sudah ada di daftar.`,
        };
      }

      // 1. Cek di cache serial gudang aktif
      let matched = warehouseSerials.find(
        (s) => s.serialNumber.trim().toLowerCase() === cleanSn.toLowerCase()
      );

      // 2. Jika belum ada di cache, verifikasi langsung ke server/database
      if (!matched) {
        try {
          const verifyRes = await verifySerialForGoodsOutAction(cleanSn, context.warehouseId ?? undefined);
          if (verifyRes.success && verifyRes.serialItem) {
            matched = verifyRes.serialItem;
            setWarehouseSerials((prev) => {
              if (prev.some((p) => p.id === matched!.id)) return prev;
              return [matched!, ...prev];
            });
          } else {
            return {
              success: false,
              message: verifyRes.error || `SN '${cleanSn}' tidak tersedia di gudang ini.`,
            };
          }
        } catch (err: unknown) {
          return {
            success: false,
            message: err instanceof Error ? err.message : `Gagal verifikasi SN '${cleanSn}'.`,
          };
        }
      }

      // Check target line
      let matchedLineId = targetLineId;
      const targetLine = lines.find((l) => l.id === targetLineId);

      if (!targetLine || !targetLine.productId || targetLine.productId !== matched.productId) {
        // If target line has different product or is empty, find an existing line with this product
        const existingProductLine = lines.find((l) => l.productId === matched.productId);
        if (existingProductLine) {
          matchedLineId = existingProductLine.id;
        } else {
          // Auto-create new line for this serial product
          const newId = targetLine && !targetLine.productId ? targetLine.id : `gol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const matchedProd = availableProducts.find((p) => p.id === matched!.productId);
          
          // Pemetaan manual: JANGAN otomatis memilih item PO berdasarkan SN yang dipindai!
          // Pertahankan poLineId hanya jika baris target sebelumnya sudah dipilih manual oleh pengguna
          const preservedPoLineId = (targetLine && !targetLine.productId) ? targetLine.poLineId : undefined;
          const activePo = sidebarSelectedPo || selectedPo;
          const assignedPoLine = preservedPoLineId ? activePo?.lines.find((pl) => pl.id === preservedPoLineId) : undefined;

          const newLine: GoodsOutFormLine = {
            id: newId,
            productId: matched.productId,
            productName: matched.productName,
            sku: matched.sku,
            tracking: "SERIAL",
            unit: matchedProd?.unit || "unit",
            availableStock: matchedProd?.availableStock ?? matchedProd?.stock ?? 1,
            quantity: "1",
            serials: [matched.serialNumber],
            poLineId: preservedPoLineId,
            rawProductName: assignedPoLine ? (assignedPoLine.rawProductName || assignedPoLine.productName) : undefined,
            orderedQty: assignedPoLine ? assignedPoLine.orderedQty : undefined,
            orderedUnit: assignedPoLine ? assignedPoLine.orderedUnit : undefined,
            mappingStatus: assignedPoLine ? "MAPPED" : undefined,
          };
          setLines((prev) => {
            // If the only line was empty, replace it
            if (prev.length === 1 && !prev[0].productId) {
              return [newLine];
            }
            if (targetLine && !targetLine.productId) {
              return prev.map((l) => (l.id === targetLine.id ? newLine : l));
            }
            return [...prev, newLine];
          });
          return {
            success: true,
            message: `SN '${matched.serialNumber}' (${matched.productName}) dimasukkan.`,
          };
        }
      }

      // Add to line
      setLines((prev) =>
        prev.map((l) => {
          if (l.id !== matchedLineId) return l;
          const nextSerials = [...l.serials, matched!.serialNumber];
          const prod = availableProducts.find((p) => p.id === l.productId);
          return {
            ...l,
            tracking: "SERIAL",
            unit: prod?.unit || l.unit,
            serials: nextSerials,
            quantity: String(nextSerials.length),
          };
        })
      );

      return {
        success: true,
        message: `SN '${matched.serialNumber}' ditambahkan.`,
      };
    },
    [allSelectedSerials, warehouseSerials, context.warehouseId, lines, availableProducts, sidebarSelectedPo, selectedPo]
  );

  // Remove serial from a line
  function handleRemoveSerialFromLine(lineId: string, snToRemove: string) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        const nextSerials = l.serials.filter((s) => s !== snToRemove);
        return {
          ...l,
          serials: nextSerials,
          quantity: String(nextSerials.length),
        };
      })
    );
  }

  // Clear all serials from a line
  function handleClearAllSerials(lineId: string) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        return {
          ...l,
          serials: [],
          quantity: "0",
        };
      })
    );
  }

  // Handle External Scanner Barcode Submit (Enter key)
  async function handleBarcodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = barcodeInputVal.trim();
    if (!code) return;

    // Pick target line: current open picker line, or line 0, or first serial line
    const targetLine = lines.find((l) => l.tracking === "SERIAL") || lines[0];
    const res = await addSerialToLine(targetLine.id, code);

    if (res.success) {
      playScanBeep("success");
      toast.push({
        tone: "success",
        title: res.message,
      });
      setBarcodeInputVal("");
    } else {
      playScanBeep("error");
      toast.push({
        tone: "danger",
        title: res.message,
      });
    }

    if (barcodeInputRef.current) {
      barcodeInputRef.current.focus();
    }
  }



  // Stop camera stream cleanly
  const stopCameraStream = useCallback(() => {
    scanLoopActiveRef.current = false;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Close camera scanner
  const handleCloseScanner = useCallback(() => {
    stopCameraStream();
    setScannerOpen(false);
    setScannerTargetLineId(null);
  }, [stopCameraStream]);

  // Keyboard Shortcuts: Alt+A (Tambah Baris), Escape (Tutup modal/dialog bertingkat)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (scannerOpen) {
          handleCloseScanner();
          e.preventDefault();
          return;
        }
        if (pasteModalOpen) {
          setPasteModalOpen(false);
          e.preventDefault();
          return;
        }
        if (cancelTarget) {
          setCancelTarget(null);
          setCancelReason("");
          e.preventDefault();
          return;
        }
        if (selectedTxDetail) {
          setSelectedTxDetail(null);
          e.preventDefault();
          return;
        }
        if (openSerialPickerLineId) {
          setOpenSerialPickerLineId(null);
          e.preventDefault();
          return;
        }
        if (openDropdownLineId) {
          setOpenDropdownLineId(null);
          e.preventDefault();
          return;
        }
      }

      // Alt + A: Tambah baris baru
      if (e.altKey && (e.key === "a" || e.key === "A")) {
        if (modalOpen && !scannerOpen && !pasteModalOpen && !cancelTarget && !selectedTxDetail) {
          e.preventDefault();
          handleAddLine();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    modalOpen,
    scannerOpen,
    pasteModalOpen,
    cancelTarget,
    selectedTxDetail,
    openSerialPickerLineId,
    openDropdownLineId,
    handleCloseScanner,
  ]);

  // Lock body scroll when any modal or overlay is open so background page cannot scroll
  useEffect(() => {
    const isAnyModalOpen = modalOpen || !!selectedTxDetail || scannerOpen || pasteModalOpen || !!cancelTarget;
    if (isAnyModalOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [modalOpen, selectedTxDetail, scannerOpen, pasteModalOpen, cancelTarget]);

  // Handle click outside & scroll outside dropdown menu
  useEffect(() => {
    function handlePointerDownOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Dropdown produk: tetap terbuka jika interaksi di dalam wrapper atau list dropdown
      const inProductDropdown =
        target.closest(".go-line-item__dropdown-wrap") ||
        target.closest(".go-line-item__dropdown");

      if (!inProductDropdown) {
        setOpenDropdownLineId(null);
      }

      // Serial picker panel: tetap terbuka jika interaksi di dalam panel atau tombol buka picker
      const inSerialPanel =
        target.closest(".go-serial-panel") ||
        target.closest(".go-modal__btn-secondary");

      if (!inSerialPanel) {
        setOpenSerialPickerLineId(null);
      }
    }

    function handleScrollOutside(e: Event) {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Jika user scroll di dalam list dropdown produk atau serial panel, jangan tutup
      if (
        (target.closest && target.closest(".go-line-item__dropdown")) ||
        (target.classList && target.classList.contains("go-line-item__dropdown")) ||
        (target.closest && target.closest(".go-serial-panel"))
      ) {
        return;
      }

      // Jika user scroll di luar dropdown produk, tutup dropdown
      setOpenDropdownLineId((prev) => (prev !== null ? null : prev));
    }

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("touchstart", handlePointerDownOutside, { passive: true });
    window.addEventListener("scroll", handleScrollOutside, { capture: true, passive: true });

    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("touchstart", handlePointerDownOutside);
      window.removeEventListener("scroll", handleScrollOutside, { capture: true });
    };
  }, []);

  // Start Camera Scanner
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Perangkat atau browser ini tidak mendukung akses kamera.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      scanLoopActiveRef.current = true;

      // Check BarcodeDetector native support
      const hasBarcodeDetector = "BarcodeDetector" in window;
      if (hasBarcodeDetector) {
        const detector = new (window as unknown as {
          BarcodeDetector: new (options?: { formats: string[] }) => {
            detect: (image: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
          };
        }).BarcodeDetector({
          formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"],
        });

        const scanFrame = async () => {
          if (!scanLoopActiveRef.current || !videoRef.current) return;
          try {
            if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                const rawCode = barcodes[0].rawValue.trim();
                const now = Date.now();
                // Cooldown 1.5s for same code
                if (
                  lastScannedCodeRef.current.code !== rawCode ||
                  now - lastScannedCodeRef.current.time > 1500
                ) {
                  lastScannedCodeRef.current = { code: rawCode, time: now };
                  const targetId = scannerTargetLineId || lines[0]?.id;
                  const result = await addSerialToLine(targetId, rawCode);

                  if (result.success) {
                    playScanBeep("success");
                    setScannerFeed((prev) => [
                      {
                        id: String(Date.now()),
                        code: rawCode,
                        success: true,
                        text: result.message,
                      },
                      ...prev.slice(0, 15),
                    ]);
                  } else {
                    playScanBeep("error");
                    setScannerFeed((prev) => [
                      {
                        id: String(Date.now()),
                        code: rawCode,
                        success: false,
                        text: result.message,
                      },
                      ...prev.slice(0, 15),
                    ]);
                  }
                }
              }
            }
          } catch {
            // ignore frame decode hiccups
          }

          if (scanLoopActiveRef.current) {
            requestAnimationFrame(scanFrame);
          }
        };

        requestAnimationFrame(scanFrame);
      } else {
        setCameraError(
          "Fitur deteksi otomatis BarcodeDetector tidak didukung oleh browser ini. Gunakan scanner eksternal atau input manual di bawah."
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Tidak dapat membuka kamera.";
      if (msg.includes("Permission denied") || msg.includes("NotAllowedError")) {
        setCameraError("Izin kamera ditolak. Berikan izin kamera di pengaturan browser untuk memindai.");
      } else {
        setCameraError(msg);
      }
    }
  }, [addSerialToLine, lines, scannerTargetLineId]);

  useEffect(() => {
    if (scannerOpen) {
      queueMicrotask(() => startCamera());
    } else {
      stopCameraStream();
    }
    return () => {
      stopCameraStream();
    };
  }, [scannerOpen, startCamera, stopCameraStream]);

  // Open Scanner for a specific line
  function handleOpenScannerForLine(lineId: string) {
    setScannerTargetLineId(lineId);
    setScannerFeed([]);
    setScannerOpen(true);
  }

  // Parse Spreadsheet / Excel Pasted Text
  const parsedSpreadsheetRows = useMemo(() => {
    if (!pasteRawText.trim()) return [];

    const rawLines = pasteRawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const results: Array<{
      inputRaw: string;
      product?: typeof availableProducts[number];
      matchedSerials: string[];
      quantity: number;
      isValid: boolean;
      errorMessage?: string;
    }> = [];

    for (const rawLine of rawLines) {
      const parts = rawLine.split(/\t|,|;/).map((p) => p.trim());
      const col1 = parts[0] || "";
      const col2 = parts[1] || "";
      const col3 = parts.slice(2).join(" ").trim();

      // Case A: Col 1 is a direct Serial Number in warehouse
      const snMatch = warehouseSerials.find(
        (s) => s.serialNumber.trim().toLowerCase() === col1.toLowerCase()
      );

      if (snMatch) {
        const prod = availableProducts.find((p) => p.id === snMatch.productId);
        results.push({
          inputRaw: rawLine,
          product: prod,
          matchedSerials: [snMatch.serialNumber],
          quantity: 1,
          isValid: true,
        });
        continue;
      }

      // Case B: Col 1 is SKU or Product Name
      const prodMatch = availableProducts.find(
        (p) =>
          p.sku.trim().toLowerCase() === col1.toLowerCase() ||
          p.name.trim().toLowerCase() === col1.toLowerCase() ||
          p.name.trim().toLowerCase().includes(col1.toLowerCase())
      );

      if (!prodMatch) {
        results.push({
          inputRaw: rawLine,
          matchedSerials: [],
          quantity: 0,
          isValid: false,
          errorMessage: `Produk '${col1}' tidak ditemukan pada gudang aktif.`,
        });
        continue;
      }

      if (prodMatch.tracking === "SERIAL") {
        // Collect serials from col2 & col3
        const potentialSns = `${col2} ${col3}`
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);

        const validSns: string[] = [];
        const invalidSns: string[] = [];

        for (const sn of potentialSns) {
          const foundSn = warehouseSerials.find(
            (ws) =>
              ws.productId === prodMatch.id &&
              ws.serialNumber.trim().toLowerCase() === sn.toLowerCase()
          );
          if (foundSn) {
            validSns.push(foundSn.serialNumber);
          } else {
            invalidSns.push(sn);
          }
        }

        if (validSns.length === 0) {
          results.push({
            inputRaw: rawLine,
            product: prodMatch,
            matchedSerials: [],
            quantity: 0,
            isValid: false,
            errorMessage: `Tidak ada Serial Number valid yang tersedia untuk ${prodMatch.name}.`,
          });
        } else {
          results.push({
            inputRaw: rawLine,
            product: prodMatch,
            matchedSerials: validSns,
            quantity: validSns.length,
            isValid: true,
            errorMessage:
              invalidSns.length > 0
                ? `${invalidSns.length} SN diabaikan karena tidak tersedia.`
                : undefined,
          });
        }
      } else {
        // Non-Serial
        const qty = parseInt(col2, 10);
        const validQty = !isNaN(qty) && qty > 0 ? qty : 1;
        const available = prodMatch.availableStock ?? prodMatch.stock ?? 0;

        if (validQty > available) {
          results.push({
            inputRaw: rawLine,
            product: prodMatch,
            matchedSerials: [],
            quantity: validQty,
            isValid: false,
            errorMessage: `Kuantitas (${validQty}) melebihi stok tersedia (${available} ${prodMatch.unit}).`,
          });
        } else {
          results.push({
            inputRaw: rawLine,
            product: prodMatch,
            matchedSerials: [],
            quantity: validQty,
            isValid: true,
          });
        }
      }
    }

    return results;
  }, [pasteRawText, availableProducts, warehouseSerials]);

  // Apply parsed spreadsheet rows to worksheet lines
  function handleApplyPaste() {
    const validRows = parsedSpreadsheetRows.filter((r) => r.isValid && r.product);
    if (validRows.length === 0) {
      toast.push({
        tone: "warning",
        title: "Tidak Ada Data Valid",
        description: "Periksa kembali data spreadsheet yang ditempelkan.",
      });
      return;
    }

    const newLines: GoodsOutFormLine[] = [];

    // Group serial items by product if multiple rows refer to same product
    const serialGroup: Record<string, { product: typeof availableProducts[number]; serials: string[] }> = {};

    for (const r of validRows) {
      if (!r.product) continue;
      if (r.product.tracking === "SERIAL") {
        if (!serialGroup[r.product.id]) {
          serialGroup[r.product.id] = { product: r.product, serials: [] };
        }
        for (const s of r.matchedSerials) {
          if (!serialGroup[r.product.id].serials.includes(s)) {
            serialGroup[r.product.id].serials.push(s);
          }
        }
      } else {
        newLines.push({
          id: `gol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          productId: r.product.id,
          productName: r.product.name,
          sku: r.product.sku,
          tracking: "NON_SERIAL",
          unit: r.product.unit,
          availableStock: r.product.availableStock ?? r.product.stock ?? 0,
          quantity: String(r.quantity),
          serials: [],
        });
      }
    }

    // Add grouped serial lines
    for (const prodId of Object.keys(serialGroup)) {
      const g = serialGroup[prodId];
      newLines.push({
        id: `gol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        productId: g.product.id,
        productName: g.product.name,
        sku: g.product.sku,
        tracking: "SERIAL",
        unit: g.product.unit,
        availableStock: g.product.availableStock ?? g.product.stock ?? g.serials.length,
        quantity: String(g.serials.length),
        serials: g.serials,
      });
    }

    if (pasteImportMode === "replace") {
      setLines(newLines);
    } else {
      setLines((prev) => {
        const withoutEmpty = prev.filter((l) => l.productId);
        return [...withoutEmpty, ...newLines];
      });
    }

    setPasteModalOpen(false);
    setPasteRawText("");
    toast.push({
      tone: "success",
      title: "Data Excel Diterapkan",
      description: `Berhasil menambahkan ${newLines.length} baris ke worksheet pengeluaran.`,
    });
  }

  // Validate entire worksheet before submitting
  function validateForm(): { valid: boolean; errors: string[] } {
    const errs: string[] = [];

    if (!recipient.trim()) {
      errs.push("Nama penerima barang harus diisi.");
    }

    // Periksa apakah ada baris PO yang belum dipetakan
    const unmappedLine = lines.find((l) => l.poLineId && (!l.productId || l.mappingStatus === "UNMAPPED"));
    if (unmappedLine) {
      errs.push(`Item PO "${unmappedLine.rawProductName || unmappedLine.productName}" belum dipetakan ke produk katalog. Harap petakan terlebih dahulu sebelum pengeluaran.`);
    }

    const filledLines = lines.filter((l) => l.productId);
    if (filledLines.length === 0) {
      errs.push("Minimal 1 baris produk harus dipilih.");
    }

    for (let i = 0; i < filledLines.length; i++) {
      const l = filledLines[i];
      const rowNum = i + 1;

      if (l.tracking === "SERIAL") {
        if (l.serials.length === 0) {
          errs.push(`Baris #${rowNum} (${l.productName}): Produk serial membutuhkan minimal 1 Serial Number.`);
        }
        if (parseInt(l.quantity, 10) !== l.serials.length) {
          errs.push(`Baris #${rowNum} (${l.productName}): Kuantitas harus sama persis dengan jumlah Serial Number (${l.serials.length}).`);
        }
      } else {
        const q = Number(l.quantity);
        if (isNaN(q) || q <= 0) {
          errs.push(`Baris #${rowNum} (${l.productName}): Kuantitas harus lebih besar dari 0.`);
        }
        if (q > l.availableStock) {
          errs.push(`Baris #${rowNum} (${l.productName}): Kuantitas (${q}) melampaui stok tersedia (${l.availableStock} ${l.unit}).`);
        }
      }
    }

    return { valid: errs.length === 0, errors: errs };
  }

  function handleStartEditPending(tx: GoodsOutTransaction) {
    setEditingPendingTx(tx);
    setRecipient(tx.recipientName || "");
    setAddress(tx.recipientAddress === "-" ? "" : tx.recipientAddress || "");
    const matchedCust = customers.find((c) => c.name === tx.recipientName);
    setSelectedCustomerId(matchedCust ? matchedCust.id : "");
    setSelectedPoId(tx.poId || "");
    setDocumentDate(tx.date);
    setInputNotes(tx.notes || "");
    if (tx.items && tx.items.length > 0) {
      setLines(
        tx.items.map((it, idx) => {
          const prod = availableProducts.find((p) => p.id === it.productId);
          return {
            id: `line-${idx + 1}-${Date.now()}`,
            productId: it.productId,
            productName: it.productName,
            sku: it.sku,
            tracking: (it.tracking as "SERIAL" | "NON_SERIAL") || "NON_SERIAL",
            quantity: String(it.qty || 1),
            unit: it.unit || "unit",
            availableStock: (prod?.availableStock ?? prod?.stock ?? 0) + (it.qty || 0),
            serials: it.serials ? [...it.serials] : [],
            poLineId: undefined,
          };
        })
      );
    } else {
      setLines([createEmptyGoodsOutLine()]);
    }
    setSelectedTxDetail(null);
    setModalOpen(true);
  }

  function handleCloseModal() {
    setModalOpen(false);
    setEditingPendingTx(null);
    setSelectedCustomerId("");
    setRecipient("");
    setAddress("");
    setSelectedPoId("");
    setInputNotes("");
    setLines([createEmptyGoodsOutLine()]);
  }

  // Submit Goods Out (Pending or Immediate Complete or Edit)
  async function handleSubmitGoodsOut(completeDirectly: boolean) {
    if (isSubmitting) return;
    const validation = validateForm();
    if (!validation.valid) {
      toast.push({
        tone: "danger",
        title: validation.errors[0],
      });
      return;
    }

    setIsSubmitting(true);
    setPostImmediately(completeDirectly);

    const filledLines = lines.filter((l) => l.productId);
    const targetWhId = context.warehouseId || availableProducts[0]?.warehouseId || "wh-01";
    const targetDocNum = editingPendingTx ? editingPendingTx.reference : autoReference;

    try {
      if (editingPendingTx) {
        // Edit existing pending goods out
        const res = await updateGoodsOutPendingAction({
          goodsOutId: editingPendingTx.id,
          customerId: selectedCustomerId || undefined,
          customerName: !selectedCustomerId ? recipient.trim() : undefined,
          customerAddress: address.trim() || undefined,
          poId: selectedPoId || undefined,
          documentNumber: editingPendingTx.reference,
          documentDate: documentDate,
          note: inputNotes.trim() || undefined,
          lines: filledLines.map((l) => ({
            productId: l.productId,
            poLineId: l.poLineId,
            quantity: l.tracking === "SERIAL" ? l.serials.length : Number(l.quantity),
            unit: l.unit,
            serials: l.tracking === "SERIAL" ? l.serials : undefined,
            groupId: l.groupId,
            groupSerialsSnapshot: l.groupSerialsSnapshot,
          })),
        });

        if (!res.success) {
          toast.push({
            tone: "danger",
            title: res.error || "Gagal memperbarui barang keluar.",
          });
          setIsSubmitting(false);
          return;
        }

        let finalRecipientName = recipient.trim();
        if ("newCustomer" in res && res.newCustomer) {
          const createdCust: Partner = {
            id: res.newCustomer.id,
            ownerId: "current-owner",
            type: "CUSTOMER",
            name: res.newCustomer.name,
            code: res.newCustomer.code,
            phone: "-",
            email: "-",
            address: address.trim() || "-",
            status: "ACTIVE",
          };
          setCustomers((prev) => [createdCust, ...prev.filter((c) => c.id !== createdCust.id)]);
          finalRecipientName = res.newCustomer.name;
        }

        const updatedTx: GoodsOutTransaction = {
          ...editingPendingTx,
          recipientName: finalRecipientName,
          recipientAddress: address.trim() || "-",
          poId: selectedPoId || undefined,
          poNumber: selectedPo?.poNumber,
          date: documentDate,
          notes: inputNotes.trim() || undefined,
          items: filledLines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            sku: l.sku,
            tracking: l.tracking,
            qty: l.tracking === "SERIAL" ? l.serials.length : Number(l.quantity),
            unit: l.unit,
            serials: l.tracking === "SERIAL" ? l.serials : undefined,
          })),
        };

        setTransactions((prev) =>
          prev.map((t) => (t.id === editingPendingTx.id ? updatedTx : t))
        );
        handleCloseModal();
        loadWarehouseSerials();

        toast.push({
          tone: "success",
          title: "Perubahan Disimpan",
          description: "newCustomer" in res && res.newCustomer
            ? `Pengeluaran ${updatedTx.reference} diperbarui dan pelanggan "${res.newCustomer.name}" (${res.newCustomer.code}) otomatis didaftarkan.`
            : `Pengeluaran barang ${updatedTx.reference} berhasil diperbarui.`,
        });
      } else {
        // Step 1: Create Goods Out Pending (Reserve stock atomically)
        const res = await createGoodsOutPendingAction({
          warehouseId: targetWhId,
          customerId: selectedCustomerId || undefined,
          customerName: !selectedCustomerId ? recipient.trim() : undefined,
          customerAddress: address.trim() || undefined,
          poId: selectedPoId || undefined,
          documentNumber: targetDocNum,
          documentDate: documentDate,
          note: inputNotes.trim() || undefined,
          lines: filledLines.map((l) => ({
            productId: l.productId,
            poLineId: l.poLineId,
            quantity: l.tracking === "SERIAL" ? l.serials.length : Number(l.quantity),
            unit: l.unit,
            serials: l.tracking === "SERIAL" ? l.serials : undefined,
            groupId: l.groupId,
            groupSerialsSnapshot: l.groupSerialsSnapshot,
          })),
        });

        if (!res.success) {
          toast.push({
            tone: "danger",
            title: res.error || "Gagal menyimpan barang keluar.",
          });
          setIsSubmitting(false);
          return;
        }

        let finalRecipientName = recipient.trim();
        if ("newCustomer" in res && res.newCustomer) {
          const createdCust: Partner = {
            id: res.newCustomer.id,
            ownerId: "current-owner",
            type: "CUSTOMER",
            name: res.newCustomer.name,
            code: res.newCustomer.code,
            phone: "-",
            email: "-",
            address: address.trim() || "-",
            status: "ACTIVE",
          };
          setCustomers((prev) => [createdCust, ...prev.filter((c) => c.id !== createdCust.id)]);
          finalRecipientName = res.newCustomer.name;
        }

        const generatedId = "goodsOutId" in res ? (res.goodsOutId as string) : `go-${transactions.length + 1}`;

        // Step 2: If user chose "Posting Barang Keluar", complete immediately!
        if (completeDirectly) {
          const compRes = await completeGoodsOutAction(generatedId);
          if (!compRes.success) {
            toast.push({
              tone: "warning",
              title: `Tersimpan (Pending): ${compRes.error}`,
            });
          }
        }

        // Add to local transaction list
        const newTx: GoodsOutTransaction = {
          id: generatedId,
          reference: targetDocNum,
          warehouseId: targetWhId,
          warehouseName: context.warehouseName ?? "Gudang Utama",
          recipientName: finalRecipientName,
          recipientAddress: address.trim() || "-",
          poId: selectedPoId || undefined,
          poNumber: selectedPo?.poNumber,
          date: documentDate,
          status: completeDirectly ? "COMPLETED" : "PENDING",
          createdBy: context.email,
          notes: inputNotes.trim() || undefined,
          items: filledLines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            sku: l.sku,
            tracking: l.tracking,
            qty: l.tracking === "SERIAL" ? l.serials.length : Number(l.quantity),
            unit: l.unit,
            serials: l.tracking === "SERIAL" ? l.serials : undefined,
          })),
        };

        setTransactions((prev) => [newTx, ...prev]);
        handleCloseModal();

        // Refresh available serials
        loadWarehouseSerials();

        toast.push({
          tone: completeDirectly ? "success" : "info",
          title: completeDirectly
            ? `Barang keluar ${targetDocNum} berhasil diposting.`
            : `Barang keluar ${targetDocNum} berhasil disimpan sebagai pending (stok direservasi).`,
        });
      }
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: "Kesalahan Sistem",
        description: err instanceof Error ? err.message : "Gagal memproses transaksi.",
      });
    } finally {
      setIsSubmitting(false);
      setPostImmediately(false);
    }
  }

  // Complete a pending transaction
  async function handleCompletePending(tx: GoodsOutTransaction) {
    if (isCompleting) return;
    setIsCompleting(true);
    try {
      const res = await completeGoodsOutAction(tx.id);
      if (!res.success) {
        toast.push({
          tone: "danger",
          title: res.error || "Gagal memotong stok.",
        });
        return;
      }

      setTransactions((prev) =>
        prev.map((t) => (t.id === tx.id ? { ...t, status: "COMPLETED" } : t))
      );
      if (selectedTxDetail && selectedTxDetail.id === tx.id) {
        setSelectedTxDetail((prev) => (prev ? { ...prev, status: "COMPLETED" } : null));
      }

      loadWarehouseSerials();

      toast.push({
        tone: "success",
        title: `Dokumen ${tx.reference} berhasil diposting.`,
      });
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: err instanceof Error ? err.message : "Gagal menyelesaikan pengeluaran.",
      });
    } finally {
      setIsCompleting(false);
    }
  }

  // Cancel a pending transaction
  async function handleConfirmCancel() {
    if (isCancelling) return;
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      toast.push({
        tone: "danger",
        title: "Alasan pembatalan wajib diisi.",
      });
      return;
    }

    setIsCancelling(true);
    try {
      const res = await softDeleteGoodsOutAction(cancelTarget.id, cancelReason.trim());
      if (!res.success) {
        toast.push({
          tone: "danger",
          title: res.error || "Gagal melepas reservasi.",
        });
        return;
      }

      setTransactions((prev) =>
        prev.map((t) => (t.id === cancelTarget.id ? { ...t, status: "CANCELLED" } : t))
      );
      if (selectedTxDetail && selectedTxDetail.id === cancelTarget.id) {
        setSelectedTxDetail((prev) => (prev ? { ...prev, status: "CANCELLED" } : null));
      }

      loadWarehouseSerials();

      toast.push({
        tone: "warning",
        title: `Dokumen ${cancelTarget.reference} berhasil dibatalkan.`,
      });
      setCancelTarget(null);
      setCancelReason("");
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: err instanceof Error ? err.message : "Gagal membatalkan transaksi.",
      });
    } finally {
      setIsCancelling(false);
    }
  }

  // Filter transactions for table
  const warehouseTxs = useMemo(() => {
    return context.warehouseId
      ? transactions.filter((t) => !t.warehouseId || t.warehouseId === context.warehouseId)
      : transactions;
  }, [transactions, context.warehouseId]);

  const filteredTransactions = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = warehouseTxs.filter((t) => {
      const matchSearch =
        !q ||
        t.reference.toLowerCase().includes(q) ||
        t.recipientName.toLowerCase().includes(q) ||
        (t.poNumber && t.poNumber.toLowerCase().includes(q)) ||
        t.items.some((i) => i.productName.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
      const matchStatus = !statusFilter || t.status === statusFilter;
      const matchStartDate = !startDate || t.date >= startDate;
      const matchEndDate = !endDate || t.date <= endDate;
      return matchSearch && matchStatus && matchStartDate && matchEndDate;
    });

    // Default sorting: Tanggal hari ini / terbaru paling atas
    return result.sort((a, b) => {
      const dateCompare = b.date.localeCompare(a.date);
      if (dateCompare !== 0) return dateCompare;
      return b.reference.localeCompare(a.reference);
    });
  }, [warehouseTxs, search, statusFilter, startDate, endDate]);

  const goFiltersKey = JSON.stringify([search, statusFilter, startDate, endDate]);
  const [prevGoFiltersKey, setPrevGoFiltersKey] = useState(goFiltersKey);
  if (goFiltersKey !== prevGoFiltersKey) {
    setPrevGoFiltersKey(goFiltersKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedTransactions = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredTransactions.slice(start, start + PAGE_SIZE);
  }, [filteredTransactions, safePage]);

  // Columns for DataTable
  const columns: Column<GoodsOutTransaction>[] = [
    {
      key: "reference",
      header: "Referensi Dokumen",
      sortable: true,
      cell: (t) => (
        <div>
          <button
            type="button"
            onClick={() => setSelectedTxDetail(t)}
            className="font-mono text-xs font-semibold text-primary hover:underline"
          >
            {t.reference}
          </button>
          <p className="text-xs text-text-secondary">{t.date}</p>
        </div>
      ),
    },
    {
      key: "recipient",
      header: "Penerima & Gudang",
      cell: (t) => (
        <div>
          <p className="text-xs font-medium text-text-primary">{t.recipientName}</p>
          <p className="text-[11px] text-text-secondary">{t.warehouseName} • {t.recipientAddress}</p>
        </div>
      ),
    },
    {
      key: "po",
      header: "Purchase Order",
      cell: (t) => (
        <span className="text-xs font-mono text-text-secondary">
          {t.poNumber || "-"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (t: GoodsOutTransaction) => {
        const toneMap: Record<string, Tone> = {
          PENDING: "warning",
          COMPLETED: "success",
          CANCELLED: "neutral",
        };
        return <StatusBadge tone={toneMap[t.status] ?? "neutral"}>{t.status}</StatusBadge>;
      },
    },
    {
      key: "actions",
      header: "Aksi",
      cell: (t: GoodsOutTransaction) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setSelectedTxDetail(t)}
            className="text-xs"
          >
            Lihat Detail
          </Button>
          {t.status === "PENDING" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleStartEditPending(t)}
              className="text-xs"
              title="Edit pengeluaran barang pending ini"
            >
              Edit
            </Button>
          )}
          {t.status === "COMPLETED" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setReturnTargetTx(t)}
              className="text-xs text-primary font-medium inline-flex items-center gap-1"
              title="Buat Retur Pelanggan dari dokumen ini"
            >
              <RotateCcwIcon className="h-3.5 w-3.5" />
              Retur Pelanggan
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Barang Keluar (Goods Out)"
        description="Kelola pengeluaran stok, validasi Serial Number tersedia, reservasi pending, dan pemenuhan pengiriman satu gudang."
        actions={
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={() => {
              if (lines.length === 0) {
                setLines([createEmptyGoodsOutLine()]);
              }
              setModalOpen(true);
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-1.5"
              aria-hidden="true"
            >
              <path d="M5 12h14"></path>
              <path d="M12 5v14"></path>
            </svg>
            Barang Keluar Baru
          </Button>
        }
      />

      {/* Sleek, Modern, Simplified Filter Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Search Input */}
          <div className="relative w-full sm:min-w-[200px] sm:flex-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary shrink-0"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari referensi, penerima, PO, produk, SKU..."
              className="min-h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-xs text-text-primary placeholder:text-text-secondary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Status Filter */}
          <div className="w-full sm:w-44">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="min-h-9 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1 text-xs text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Semua Status</option>
              <option value="PENDING">Pending (Reservasi)</option>
              <option value="COMPLETED">Completed (Selesai)</option>
              <option value="CANCELLED">Cancelled (Batal)</option>
            </select>
          </div>

          {/* Date Range: Dari & Sampai */}
          <div className="grid w-full grid-cols-2 gap-2.5 sm:flex sm:w-auto sm:items-center sm:gap-1.5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
              <span className="text-xs font-medium text-text-secondary whitespace-nowrap">Dari:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker?.();
                  } catch {}
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    try {
                      e.currentTarget.showPicker?.();
                    } catch {}
                  }
                }}
                title="Dari Tanggal (Klik untuk membuka kalender)"
                className="min-h-9 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:w-auto cursor-pointer"
              />
            </div>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
              <span className="text-xs font-medium text-text-secondary whitespace-nowrap">Sampai:</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker?.();
                  } catch {}
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    try {
                      e.currentTarget.showPicker?.();
                    } catch {}
                  }
                }}
                title="Sampai Tanggal (Klik untuk membuka kalender)"
                className="min-h-9 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary sm:w-auto cursor-pointer"
              />
            </div>
          </div>

          {/* Clear / Reset Filter button if any filter active */}
          {(search || statusFilter || startDate || endDate) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setStatusFilter("");
                setStartDate("");
                setEndDate("");
              }}
              className="min-h-9 w-full text-xs text-text-secondary hover:text-text-primary shrink-0 sm:w-auto"
              title="Reset semua filter pencarian dan tanggal"
            >
              Reset Filter
            </Button>
          )}
        </div>

        {/* Counter Badge */}
        <div className="text-right lg:shrink-0">
          <span className="text-[11px] font-medium text-text-secondary bg-surface-muted px-2 py-1 rounded border border-border">
            {filteredTransactions.length} transaksi
          </span>
        </div>
      </div>

      {/* Tabel Transaksi */}
      <div className="rounded-lg border border-border bg-surface">
        <DataTable<GoodsOutTransaction>
          caption="Daftar Transaksi Barang Keluar"
          columns={columns}
          rows={pagedTransactions}
          getRowId={(t) => t.id}
          onRowClick={(t) => setSelectedTxDetail(t)}
        />
        {filteredTransactions.length > 0 && (
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filteredTransactions.length}
            onPageChange={setPage}
          />
        )}
      </div>

      {/* ========================================================
          CREATE GOODS OUT MODAL
          ======================================================== */}
      {modalOpen && (
        <div
          className="go-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="go-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseModal();
          }}
        >
          <section className={`go-modal ${isPoSidebarOpen ? "go-modal--with-sidebar" : ""}`} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="go-modal__header">
              <div className="go-modal__header-title-box">
                <h2 id="go-modal-title" className="go-modal__title">
                  {editingPendingTx ? "Edit Barang Keluar (Pending)" : "Barang Keluar Baru (Goods Out)"}
                </h2>
                <p className="go-modal__subtitle">
                  {editingPendingTx
                    ? `Perbarui rincian dokumen, pelanggan, produk, kuantitas, atau nomor seri untuk referensi ${editingPendingTx.reference}.`
                    : "Keluarkan barang dengan validasi stok ketat. Produk serial wajib memilih atau memindai nomor seri yang tersedia."}
                </p>
              </div>

              <div className="go-modal__header-controls">
                <div className="go-modal__gudang-chip flex items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-semibold text-text-secondary">
                  <span>
                    <span className="max-lg:hidden">Gudang: </span>
                    {context.warehouseName ?? "Gudang Utama"}
                  </span>
                </div>
                {!editingPendingTx && (
                  <button
                    type="button"
                    className={`go-modal__btn-secondary h-8 px-2.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer max-lg:px-2 ${
                      isPoSidebarOpen
                        ? "bg-primary-soft text-primary border-primary/40"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                    onClick={() => {
                      setIsPoSidebarOpen((prev) => !prev);
                      if (!isPoSidebarOpen && selectedPoId) {
                        setSidebarSelectedPoId(selectedPoId);
                      }
                    }}
                    title={isPoSidebarOpen ? "Sembunyikan Panel Referensi PO" : "Buka Panel Referensi PO"}
                    aria-label="Buka Panel Referensi PO"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                      <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <span className="max-lg:hidden">Referensi PO</span>
                    {selectedPo && (
                      <span
                        className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          isPoSidebarOpen
                            ? "bg-primary text-white"
                            : "bg-surface-muted text-text-secondary border border-border"
                        }`}
                      >
                        {selectedPo.poNumber}
                      </span>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="go-modal__close-btn"
                  onClick={handleCloseModal}
                  aria-label="Tutup modal barang keluar"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrollable Body */}
            <div className="go-modal__body">
              <div className="go-modal__workspace">
                <section className="go-modal__main">
                  <form
                    onSubmit={(e) => { e.preventDefault(); handleSubmitGoodsOut(false); }}
                    onKeyDown={handleGoodsOutFormKeyDown}
                  >
                {/* Banner PO Rujukan jika terhubung */}
                {selectedPo && (
                  <div className="mb-4 p-3 rounded-lg border border-primary/30 bg-primary-soft/40 flex items-center justify-between gap-3 text-xs flex-wrap">
                    <div>
                      <div className="font-semibold text-primary flex items-center gap-2">
                        <span>Pesanan PO: <strong className="font-mono">{selectedPo.poNumber}</strong></span>
                        <StatusBadge
                          tone={selectedPo.status === "CONFIRMED" ? "success" : "info"}
                        >
                          {selectedPo.status === "CONFIRMED" ? "Disetujui" : "Sebagian Terpenuhi"}
                        </StatusBadge>
                      </div>
                      <div className="text-[11px] text-text-secondary mt-0.5">
                        Pelanggan: <strong>{selectedPo.customerName}</strong> {selectedPo.salesPic ? `• PIC: ${selectedPo.salesPic}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-danger hover:underline cursor-pointer"
                      onClick={() => {
                        setSelectedPoId("");
                        setLines([createEmptyGoodsOutLine()]);
                      }}
                    >
                      Lepas Hubungan PO
                    </button>
                  </div>
                )}

                {/* Transaction Details Info Card */}
                <div className="go-modal__info-card">
                  <h4 className="go-modal__info-title">Informasi Dokumen & Penerima</h4>
                  <div className="go-modal__info-grid">
                    <div className="go-modal__field">
                      <label className="go-modal__field-label">
                        No. Referensi <span className="text-text-secondary/60 font-normal text-[11px]">({editingPendingTx ? "Tersimpan" : "Otomatis"})</span>
                      </label>
                      <input
                        type="text"
                        className="input text-xs font-mono font-semibold bg-surface-muted/40 cursor-default"
                        value={editingPendingTx ? editingPendingTx.reference : autoReference}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">
                        Tanggal Pengeluaran * <span className="text-text-secondary/60 font-normal text-[11px]">(Dapat diedit)</span>
                      </label>
                      <input
                        type="date"
                        className="input text-xs cursor-pointer hover:border-primary transition-colors"
                        value={documentDate}
                        onChange={(e) => setDocumentDate(e.target.value)}
                        onClick={(e) => {
                          try {
                            e.currentTarget.showPicker?.();
                          } catch {}
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            try {
                              e.currentTarget.showPicker?.();
                            } catch {}
                          }
                        }}
                        title="Klik untuk memilih atau mengubah tanggal pengeluaran"
                        required
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Nama Penerima / Pelanggan *</label>
                      <div className="relative" ref={customerRef}>
                        <div className="relative flex items-center">
                          <input
                            type="text"
                            className="input text-xs w-full pr-7"
                            placeholder="Ketik atau pilih nama pelanggan..."
                            value={recipient}
                            onFocus={() => setCustomerDropdownOpen(true)}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRecipient(val);
                              const exact = customers.find(
                                (c) =>
                                  c.name.toLowerCase() === val.trim().toLowerCase() ||
                                  `${c.name} (${c.code})`.toLowerCase() === val.trim().toLowerCase()
                              );
                              setSelectedCustomerId(exact ? exact.id : "");
                              if (exact && exact.address && exact.address !== "-") {
                                setAddress(exact.address);
                              }
                              setCustomerDropdownOpen(true);
                            }}
                            required
                          />
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="absolute right-2.5 text-text-secondary pointer-events-none"
                            aria-hidden="true"
                          >
                            <path d="m6 9 6 6 6-6"></path>
                          </svg>
                        </div>

                        {customerDropdownOpen && (
                          <div className="absolute top-[calc(100%+4px)] left-0 right-0 bg-surface border border-border rounded-md shadow-lg z-50 max-h-52 overflow-y-auto flex flex-col">
                            {isNewCustomerDetected && (
                              <button
                                type="button"
                                className="flex items-center px-3 py-2 text-left border-b border-border bg-primary-soft/40 hover:bg-primary-soft/70 transition-colors"
                                onClick={() => {
                                  setSelectedCustomerId("");
                                  setCustomerDropdownOpen(false);
                                }}
                              >
                                <span className="font-semibold text-primary flex items-center gap-1.5 text-xs">
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <path d="M5 12h14"></path>
                                    <path d="M12 5v14"></path>
                                  </svg>
                                  <span>Pelanggan Baru: &ldquo;{recipient.trim()}&rdquo;</span>
                                </span>
                              </button>
                            )}
                            {filteredCustomers.length > 0 ? (
                              filteredCustomers.map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  className="flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-muted border-b border-border last:border-b-0 text-xs transition-colors"
                                  onClick={() => {
                                    setSelectedCustomerId(c.id);
                                    setRecipient(`${c.name} (${c.code})`);
                                    if (c.address && c.address !== "-") {
                                      setAddress(c.address);
                                    }
                                    setCustomerDropdownOpen(false);
                                  }}
                                >
                                  <span className="font-medium text-text-primary">{c.name}</span>
                                  <span className="font-mono text-[11px] text-text-secondary bg-surface-muted px-1.5 py-0.5 rounded">
                                    {c.code}
                                  </span>
                                </button>
                              ))
                            ) : !isNewCustomerDetected ? (
                              <div className="p-3 text-xs text-text-secondary text-center">
                                Pelanggan tidak ditemukan.
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="go-modal__field go-modal__field--full sm:col-span-3" style={{ gridColumn: "1 / -1" }}>
                      <label className="go-modal__field-label">
                        Catatan Tambahan <span className="text-text-secondary/50 font-normal text-[11px]">(Opsional)</span>
                      </label>
                      <input
                        type="text"
                        className="input text-xs"
                        placeholder="Instruksi logistik, ekspedisi, atau keterangan nomor resi..."
                        value={inputNotes}
                        onChange={(e) => setInputNotes(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Worksheet (Baris Item Pengeluaran) */}
                <div className="go-modal__worksheet">
                  <div className="go-modal__items-header">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="go-modal__items-title">Daftar Barang Keluar</h4>
                      <span className="go-modal__items-count-badge">
                        {lines.filter((l) => l.productId).length} baris aktif
                      </span>
                      {lines.some((l) => l.productId) && (
                        <span className="rounded bg-primary-soft border border-primary/20 px-2 py-0.5 text-xs font-bold text-primary font-mono">
                          Total Keluar: {formatDocumentGrandTotal(lines, warehouseSerials)}
                        </span>
                      )}
                    </div>

                    <div className="go-modal__items-header-actions">
                      {!editingPendingTx && (
                        <button
                          type="button"
                          className={`go-modal__btn-secondary text-primary border-primary/40 hover:bg-primary-soft cursor-pointer ${
                            isPoSidebarOpen ? "bg-primary-soft" : ""
                          }`}
                          onClick={() => {
                            setIsPoSidebarOpen(true);
                            if (selectedPoId) {
                              setSidebarSelectedPoId(selectedPoId);
                            }
                          }}
                          title="Buka panel referensi pesanan Purchase Order di sisi kanan"
                        >
                          <span>Referensi PO</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="go-modal__btn-secondary"
                        onClick={() => {
                          setPasteRawText("");
                          setPasteModalOpen(true);
                        }}
                        title="Salin dan tempel data baris dari spreadsheet"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>
                          <line x1="3" x2="21" y1="9" y2="9"></line>
                          <line x1="9" x2="9" y1="21" y2="9"></line>
                        </svg>
                        <span>Paste Excel</span>
                      </button>

                      <button
                        type="button"
                        className="go-modal__btn-secondary"
                        onClick={() => handleOpenScannerForLine(lines[0]?.id || "")}
                        title="Buka kamera untuk scan QR / Barcode serial number"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
                          <circle cx="12" cy="13" r="3"></circle>
                        </svg>
                        <span>Scan Kamera</span>
                      </button>

                      <button
                        type="button"
                        className={`go-modal__btn-primary ${isAnyGoodsOutLineIncomplete ? "opacity-50 cursor-not-allowed" : ""}`}
                        onClick={handleAddLine}
                        disabled={isAnyGoodsOutLineIncomplete}
                        title={
                          isAnyGoodsOutLineIncomplete
                            ? "Harap lengkapi produk dan kuantitas / nomor seri baris saat ini terlebih dahulu"
                            : "Tambah Baris (Shortcut: Alt + A)"
                        }
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M5 12h14"></path>
                          <path d="M12 5v14"></path>
                        </svg>
                        <span>
                          Tambah Baris{" "}
                          <span className="opacity-70 text-[10px] font-mono hidden sm:inline">
                            (Alt+A)
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* External Barcode Scanner Rapid Input Bar */}
                  <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-xs">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-text-secondary flex-shrink-0"
                      aria-hidden="true"
                    >
                      <path d="M3 5v14"></path>
                      <path d="M8 5v14"></path>
                      <path d="M12 5v14"></path>
                      <path d="M17 5v14"></path>
                      <path d="M21 5v14"></path>
                    </svg>
                    <input
                      ref={barcodeInputRef}
                      type="text"
                      className="input text-xs font-mono flex-1 bg-surface h-8"
                      placeholder="Scan barcode / ketik Serial Number lalu tekan Enter..."
                      value={barcodeInputVal}
                      onChange={(e) => setBarcodeInputVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleBarcodeSubmit(e);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="go-modal__btn-secondary h-8 px-3 text-xs font-medium whitespace-nowrap"
                      onClick={handleBarcodeSubmit}
                    >
                      Input SN
                    </button>
                  </div>

                  {/* Desktop Table View */}
                  <div className="go-modal__table-desktop">
                    <div className="go-modal__table-wrapper">
                      <table className="go-modal__table">
                        <thead>
                          <tr>
                            <th style={{ width: "32px" }} className="go-th--center">#</th>
                            <th>Produk & SKU</th>
                            {isPoActive && <th style={{ width: "135px" }}>Item PO</th>}
                            <th style={{ width: "70px" }} className="go-th--center">Tracking</th>
                            <th style={{ width: "130px" }}>Kuantitas Keluar</th>
                            <th style={{ width: "90px" }} className="text-right">Total Keluar</th>
                            <th style={{ width: "36px" }} className="go-th--center">Aksi</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((line, idx) => {
                            const isSerial = line.tracking === "SERIAL";
                            const productUnit =
                              availableProducts.find((p) => p.id === line.productId)?.unit ||
                              line.unit ||
                              "unit";
                            const lineAvailableSerials = warehouseSerials.filter(
                              (s) =>
                                s.productId === line.productId &&
                                !allSelectedSerials.includes(s.serialNumber)
                            );

                            return (
                              <React.Fragment key={line.id}>
                                <tr>
                                  <td className="go-th--center text-text-secondary font-mono text-xs">
                                    {idx + 1}
                                  </td>

                                  {/* Product Dropdown Search */}
                                  <td>
                                    <div className="go-line-item__dropdown-wrap">
                                      <div className="go-line-item__search-input-wrap">
                                        <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          width="13"
                                          height="13"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          className="go-line-item__search-icon"
                                          aria-hidden="true"
                                        >
                                          <circle cx="11" cy="11" r="8"></circle>
                                          <path d="m21 21-4.3-4.3"></path>
                                        </svg>
                                        <input
                                          type="text"
                                          className="input go-line-item__search-input"
                                          placeholder="Cari nama produk / SKU..."
                                          title={line.productName ? `${line.productName} (${line.sku})` : ""}
                                          value={
                                            openDropdownLineId === line.id
                                              ? productSearchQueries[line.id] ?? ""
                                              : line.productName
                                              ? `${line.productName} (${line.sku})`
                                              : ""
                                          }
                                          onFocus={() => {
                                            setOpenDropdownLineId(line.id);
                                            setProductSearchQueries((prev) => ({
                                              ...prev,
                                              [line.id]: "",
                                            }));
                                          }}
                                          onChange={(e) =>
                                            setProductSearchQueries((prev) => ({
                                              ...prev,
                                              [line.id]: e.target.value,
                                            }))
                                          }
                                        />
                                        <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          width="13"
                                          height="13"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          className="go-line-item__search-chevron"
                                          aria-hidden="true"
                                        >
                                          <path d="m6 9 6 6 6-6"></path>
                                        </svg>
                                      </div>

                                      {openDropdownLineId === line.id && (
                                        <div className={`go-line-item__dropdown ${idx >= lines.length - 2 && lines.length > 3 ? "go-line-item__dropdown--upward" : ""}`}>
                                          {availableProducts
                                            .filter((p) => {
                                              const q = (productSearchQueries[line.id] ?? "").toLowerCase();
                                              return (
                                                !q ||
                                                p.name.toLowerCase().includes(q) ||
                                                p.sku.toLowerCase().includes(q)
                                              );
                                            })
                                            .map((p) => (
                                              <button
                                                key={p.id}
                                                type="button"
                                                className="go-line-item__dropdown-item"
                                                onClick={() => handleSelectProduct(line.id, p)}
                                              >
                                                <span className="go-line-item__dropdown-item-name" title={p.name}>
                                                  {p.name}
                                                </span>
                                                <span className="go-line-item__dropdown-item-sku">
                                                  {p.sku}
                                                </span>
                                              </button>
                                            ))}
                                        </div>
                                      )}
                                    </div>
                                  </td>

                                  {/* Item Pesanan PO Matching - Hanya muncul jika PO aktif */}
                                  {isPoActive && (
                                    <td>
                                      <select
                                        className="input text-[11px] w-full py-1 px-1.5 font-medium bg-surface cursor-pointer truncate"
                                        value={line.poLineId || ""}
                                        onChange={(e) => handleLinkPoLine(line.id, e.target.value)}
                                        title={
                                          line.poLineId
                                            ? `Item PO: ${line.rawProductName || line.productName || ""}`
                                            : "Pilih item pesanan PO yang dipenuhi oleh baris ini"
                                        }
                                      >
                                        <option value="">Non-PO</option>
                                        {(selectedPo || sidebarSelectedPo)?.lines.map((pol) => {
                                          const remaining = Math.max(0, pol.targetQty - pol.fulfilledQty);
                                          const isCurrent = line.poLineId === pol.id;
                                          const isFulfilled = remaining <= 0;
                                          return (
                                            <option
                                              key={pol.id}
                                              value={pol.id}
                                              disabled={isFulfilled && !isCurrent}
                                              title={`${pol.rawProductName || pol.productName} (${isFulfilled ? "Terpenuhi Penuh" : `Sisa: ${remaining} ${pol.orderedUnit}`})`}
                                            >
                                              {pol.rawProductName || pol.productName}
                                            </option>
                                          );
                                        })}
                                      </select>
                                    </td>
                                  )}

                                  {/* Tracking Badge / Toggle */}
                                  <td className="go-th--center">
                                    {line.productId ? (
                                      line.serials && line.serials.length > 0 ? (
                                        <span
                                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary-soft text-primary border border-primary/20 whitespace-nowrap select-none"
                                          title="Terkunci SERIAL (sudah ada Nomor Seri yang dipilih/discan)"
                                        >
                                          SERIAL
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleToggleLineTracking(
                                              line.id,
                                              line.tracking === "SERIAL" ? "NON_SERIAL" : "SERIAL"
                                            )
                                          }
                                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-all border cursor-pointer whitespace-nowrap ${
                                            line.tracking === "SERIAL"
                                              ? "bg-primary-soft text-primary border-primary/30 hover:bg-primary-soft/80"
                                              : "bg-surface-muted text-text-secondary border-border hover:text-text-primary hover:border-text-secondary/40"
                                          }`}
                                          title="Klik untuk beralih mode SERIAL / NON-SN"
                                        >
                                          <span>{line.tracking === "SERIAL" ? "SERIAL" : "NON-SN"}</span>
                                          <span className="text-[9px] opacity-60">⇄</span>
                                        </button>
                                      )
                                    ) : (
                                      <span className="text-xs text-text-secondary/30 font-mono select-none">—</span>
                                    )}
                                  </td>

                                  {/* Quantity Output */}
                                  <td>
                                    {!line.productId ? (
                                      <span className="text-xs text-text-secondary/30 font-mono select-none">—</span>
                                    ) : isSerial ? (
                                      <div className="flex items-center gap-1.5">
                                        <span className="rounded bg-primary-soft px-2 py-0.5 text-xs font-bold text-primary border border-primary/20 whitespace-nowrap">
                                          {line.serials.length} unit
                                        </span>

                                        <button
                                          type="button"
                                          className="go-modal__btn-secondary py-0.5 px-2 text-xs whitespace-nowrap"
                                          onClick={() =>
                                            setOpenSerialPickerLineId(
                                              openSerialPickerLineId === line.id ? null : line.id
                                            )
                                          }
                                          title="Buka pilihan nomor seri"
                                        >
                                          <span>+ Pilih SN</span>
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="number"
                                          min={line.availableStock > 0 ? "1" : "0"}
                                          max={Math.max(0, line.availableStock ?? 0)}
                                          className={`input text-xs font-semibold w-16 py-1 px-1.5 ${
                                            line.availableStock === 0 ? "border-danger/40 bg-danger-soft/10 text-danger cursor-not-allowed" : ""
                                          }`}
                                          value={line.quantity}
                                          onChange={(e) => handleQuantityChange(line.id, e.target.value)}
                                          disabled={line.availableStock === 0}
                                          title={line.availableStock === 0 ? "Stok produk ini 0 di gudang aktif" : `Maksimal: ${line.availableStock} ${productUnit}`}
                                        />
                                        <span className="text-xs text-text-secondary whitespace-nowrap">{productUnit}</span>
                                        {line.availableStock === 0 ? (
                                          <span className="text-[11px] text-danger font-semibold whitespace-nowrap">
                                            Habis
                                          </span>
                                        ) : Number(line.quantity) > line.availableStock ? (
                                          <span className="text-[11px] text-danger font-medium whitespace-nowrap">
                                            Maks {line.availableStock}!
                                          </span>
                                        ) : null}
                                      </div>
                                    )}
                                  </td>

                                  {/* Total Keluar */}
                                  <td className="text-right">
                                    {!line.productId ? (
                                      <span className="text-xs text-text-secondary/30 font-mono select-none">—</span>
                                    ) : (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded font-mono text-xs font-semibold bg-surface-muted border border-border text-text-primary whitespace-nowrap">
                                        {formatLineTotalKeluar(line, warehouseSerials, productUnit)}
                                      </span>
                                    )}
                                  </td>

                                  {/* Remove Line */}
                                  <td className="go-th--center">
                                    <button
                                      type="button"
                                      className="p-1 rounded text-text-secondary hover:text-danger hover:bg-danger-soft transition-colors"
                                      onClick={() => handleRemoveLine(line.id)}
                                      title="Hapus baris ini"
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                      >
                                        <path d="M3 6h18"></path>
                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                      </svg>
                                    </button>
                                  </td>
                                </tr>

                                {/* Dedicated Serial Numbers Sub-Row: hanya muncul jika ada SN terpilih atau picker sedang dibuka */}
                                {isSerial && (line.serials.length > 0 || openSerialPickerLineId === line.id) && (
                                  <tr className="go-subrow">
                                    <td colSpan={isPoActive ? 7 : 6}>
                                      <div className="go-serial-panel">
                                        <div className="go-serial-panel__header">
                                          <div className="go-serial-panel__title">
                                            <svg
                                              xmlns="http://www.w3.org/2000/svg"
                                              width="13"
                                              height="13"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="2"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              className="text-primary"
                                              aria-hidden="true"
                                            >
                                              <path d="M3 5v14"></path>
                                              <path d="M8 5v14"></path>
                                              <path d="M12 5v14"></path>
                                              <path d="M17 5v14"></path>
                                              <path d="M21 5v14"></path>
                                            </svg>
                                            <span>Serial Number Terpilih ({formatLineTotalKeluar(line, warehouseSerials, productUnit)})</span>
                                            <span className="text-[11px] font-normal text-text-secondary">
                                              — {lineAvailableSerials.length} SN tersedia di gudang
                                            </span>
                                          </div>

                                          <div className="go-serial-panel__actions">
                                            {line.serials.length > 0 && (
                                              <button
                                                type="button"
                                                className="text-[11px] font-medium text-danger hover:underline"
                                                onClick={() => handleClearAllSerials(line.id)}
                                              >
                                                Hapus Semua SN
                                              </button>
                                            )}
                                          </div>
                                        </div>

                                        {/* Dropdown Serial Picker */}
                                        {openSerialPickerLineId === line.id && (
                                          <div className="rounded border border-border bg-surface-muted p-2.5 max-h-48 overflow-y-auto">
                                            <div className="flex items-center justify-between gap-2 mb-2">
                                              <input
                                                type="text"
                                                className="input text-xs font-mono flex-1 bg-surface"
                                                placeholder="Cari / filter nomor seri yang tersedia..."
                                                value={serialSearchQuery}
                                                onChange={(e) => setSerialSearchQuery(e.target.value)}
                                                autoFocus
                                              />
                                              <button
                                                type="button"
                                                className="text-xs text-text-secondary hover:text-text-primary px-1"
                                                onClick={() => setOpenSerialPickerLineId(null)}
                                              >
                                                Tutup
                                              </button>
                                            </div>
                                            {lineAvailableSerials.length === 0 ? (
                                              <p className="text-xs text-text-secondary text-center py-2">
                                                Tidak ada nomor seri tersedia di gudang untuk produk ini.
                                              </p>
                                            ) : (
                                              <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                                                {lineAvailableSerials
                                                  .filter((s) =>
                                                    !serialSearchQuery ||
                                                    s.serialNumber.toLowerCase().includes(serialSearchQuery.toLowerCase())
                                                  )
                                                  .map((s) => (
                                                    <button
                                                      key={s.id}
                                                      type="button"
                                                      className="flex items-center justify-between p-1.5 rounded bg-surface border border-border hover:border-primary text-xs text-left transition-colors gap-1.5"
                                                      onClick={async () => {
                                                        await addSerialToLine(line.id, s.serialNumber);
                                                        setSerialSearchQuery("");
                                                      }}
                                                    >
                                                      <div className="flex items-center gap-1.5 min-w-0">
                                                        <span className="font-mono font-semibold text-text-primary truncate">
                                                          {s.serialNumber}
                                                        </span>
                                                        <span className="rounded bg-surface-muted border border-border px-1.5 py-0.5 text-[10px] text-text-secondary font-medium shrink-0">
                                                          {s.unit || productUnit || "unit"}
                                                        </span>
                                                      </div>
                                                      <span className="text-[10px] text-primary font-bold shrink-0">
                                                        + Pilih
                                                      </span>
                                                    </button>
                                                  ))}
                                              </div>
                                            )}
                                          </div>
                                        )}

                                        {/* Selected Serials Chips */}
                                        {line.serials.length > 0 && (
                                          <div className="go-serial-badge-wrap">
                                            {line.serials.map((sn, snIdx) => {
                                              const snUnit = warehouseSerials.find((ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase())?.unit || productUnit || "unit";
                                              return (
                                                <span key={sn} className="go-serial-chip">
                                                  <span className="go-serial-chip__index">{snIdx + 1}.</span>
                                                  <span className="font-mono">{sn}</span>
                                                  <span className="rounded bg-surface-muted border border-border px-1 py-0.2 text-[10px] text-text-secondary font-sans font-medium">
                                                    {snUnit}
                                                  </span>
                                                  <button
                                                    type="button"
                                                    className="go-serial-chip__remove"
                                                    onClick={() => handleRemoveSerialFromLine(line.id, sn)}
                                                    title={`Hapus ${sn}`}
                                                  >
                                                    ×
                                                  </button>
                                                </span>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}

                          {/* Selalu render baris kosong hingga minimal 10 baris */}
                          {Array.from({ length: Math.max(0, 10 - lines.length) }).map((_, i) => {
                            const rowNum = lines.length + i + 1;
                            return (
                              <tr key={`empty-row-${rowNum}`} className="go-table-row--empty">
                                <td className="go-th--center text-text-secondary/30 font-mono text-xs">
                                  {rowNum}
                                </td>
                                <td>&nbsp;</td>
                                {isPoActive && <td>&nbsp;</td>}
                                <td className="go-th--center">&nbsp;</td>
                                <td>&nbsp;</td>
                                <td className="text-right">&nbsp;</td>
                                <td className="go-th--center">&nbsp;</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Mobile Cards View */}
                  <div className="go-modal__cards-mobile">
                    {lines.map((line, idx) => {
                      const isSerial = line.tracking === "SERIAL";
                      const productUnit =
                        availableProducts.find((p) => p.id === line.productId)?.unit ||
                        line.unit ||
                        "unit";
                      const lineAvailableSerials = warehouseSerials.filter(
                        (s) =>
                          s.productId === line.productId &&
                          !allSelectedSerials.includes(s.serialNumber)
                      );

                      return (
                        <div key={line.id} className="go-line-item-card">
                          <div className="go-line-item-card__header">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-text-secondary">
                                #{idx + 1}
                              </span>
                              {line.productId ? (
                                line.serials && line.serials.length > 0 ? (
                                  <span
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary-soft text-primary border border-primary/20 whitespace-nowrap select-none"
                                    title="Terkunci SERIAL (sudah ada Nomor Seri yang dipilih/discan)"
                                  >
                                    SERIAL
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleToggleLineTracking(
                                        line.id,
                                        line.tracking === "SERIAL" ? "NON_SERIAL" : "SERIAL"
                                      )
                                    }
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-all border cursor-pointer whitespace-nowrap ${
                                      line.tracking === "SERIAL"
                                        ? "bg-primary-soft text-primary border-primary/30 hover:bg-primary-soft/80"
                                        : "bg-surface-muted text-text-secondary border-border hover:text-text-primary hover:border-text-secondary/40"
                                    }`}
                                    title="Klik untuk beralih mode SERIAL / NON-SN"
                                  >
                                    <span>{line.tracking === "SERIAL" ? "SERIAL" : "NON-SN"}</span>
                                    <span className="text-[9px] opacity-60">⇄</span>
                                  </button>
                                )
                              ) : (
                                <span className="text-xs text-text-secondary/30 font-mono select-none">—</span>
                              )}
                            </div>

                            <button
                              type="button"
                              className="text-xs text-danger font-medium hover:underline"
                              onClick={() => handleRemoveLine(line.id)}
                            >
                              Hapus Baris
                            </button>
                          </div>

                          <div className="go-line-item-card__field">
                            <label className="go-line-item-card__label">Produk & SKU</label>
                            <div className="go-line-item__dropdown-wrap">
                              <input
                                type="text"
                                className="input text-xs"
                                placeholder="Cari nama produk / SKU..."
                                value={
                                  openDropdownLineId === line.id
                                    ? productSearchQueries[line.id] ?? ""
                                    : line.productName
                                    ? `${line.productName} (${line.sku})`
                                    : ""
                                }
                                onFocus={() => {
                                  setOpenDropdownLineId(line.id);
                                  setProductSearchQueries((prev) => ({
                                    ...prev,
                                    [line.id]: "",
                                  }));
                                }}
                                onChange={(e) =>
                                  setProductSearchQueries((prev) => ({
                                    ...prev,
                                    [line.id]: e.target.value,
                                  }))
                                }
                              />

                              {openDropdownLineId === line.id && (
                                <div className="go-line-item__dropdown">
                                  {availableProducts
                                    .filter((p) => {
                                      const q = (productSearchQueries[line.id] ?? "").toLowerCase();
                                      return (
                                        !q ||
                                        p.name.toLowerCase().includes(q) ||
                                        p.sku.toLowerCase().includes(q)
                                      );
                                    })
                                    .map((p) => (
                                      <button
                                        key={p.id}
                                        type="button"
                                        className="go-line-item__dropdown-item"
                                        onClick={() => handleSelectProduct(line.id, p)}
                                      >
                                        <span className="go-line-item__dropdown-item-name">{p.name}</span>
                                        <span className="go-line-item__dropdown-item-sku">{p.sku}</span>
                                      </button>
                                    ))}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Item Pesanan PO Mobile Field - Hanya muncul jika PO aktif */}
                          {isPoActive && (
                            <div className="go-line-item-card__field">
                              <label className="go-line-item-card__label">Item Pesanan PO</label>
                              <select
                                className="input text-xs w-full py-1.5 px-2 font-medium bg-surface"
                                value={line.poLineId || ""}
                                onChange={(e) => handleLinkPoLine(line.id, e.target.value)}
                              >
                                <option value="">Non-PO</option>
                                {(selectedPo || sidebarSelectedPo)?.lines.map((pol) => {
                                  const remaining = Math.max(0, pol.targetQty - pol.fulfilledQty);
                                  const isCurrent = line.poLineId === pol.id;
                                  const isFulfilled = remaining <= 0;
                                  return (
                                    <option
                                      key={pol.id}
                                      value={pol.id}
                                      disabled={isFulfilled && !isCurrent}
                                      title={`${pol.rawProductName || pol.productName} (${isFulfilled ? "Terpenuhi Penuh" : `Sisa: ${remaining} ${pol.orderedUnit}`})`}
                                    >
                                      {pol.rawProductName || pol.productName}
                                    </option>
                                  );
                                })}
                              </select>
                            </div>
                          )}

                          <div className="go-line-item-card__grid">
                            <div className="go-line-item-card__field">
                              <label className="go-line-item-card__label">Total Keluar</label>
                              <span className="text-xs font-bold text-text-primary font-mono">
                                {formatLineTotalKeluar(line, warehouseSerials, productUnit)}
                              </span>
                            </div>

                            <div className="go-line-item-card__field">
                              <label className="go-line-item-card__label">Kuantitas</label>
                              {!line.productId ? (
                                <span className="text-xs text-text-secondary/40 font-mono">—</span>
                              ) : isSerial ? (
                                <span className="text-xs font-bold text-primary">
                                  {line.serials.length} unit
                                </span>
                              ) : (
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <input
                                    type="number"
                                    min={line.availableStock > 0 ? "1" : "0"}
                                    max={Math.max(0, line.availableStock ?? 0)}
                                    className={`input text-xs font-semibold w-20 ${
                                      line.availableStock === 0 ? "border-danger/40 bg-danger-soft/10 text-danger cursor-not-allowed" : ""
                                    }`}
                                    value={line.quantity}
                                    onChange={(e) => handleQuantityChange(line.id, e.target.value)}
                                    disabled={line.availableStock === 0}
                                    title={line.availableStock === 0 ? "Stok produk ini 0 di gudang aktif" : `Maksimal: ${line.availableStock}`}
                                  />
                                  <span className="text-xs text-text-secondary">
                                    {availableProducts.find((p) => p.id === line.productId)?.unit || line.unit || "unit"}
                                  </span>
                                  {line.availableStock === 0 && (
                                    <span className="text-xs text-danger font-semibold whitespace-nowrap">
                                      Stok Habis
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {isSerial && (
                            <div className="flex flex-col gap-2 pt-2 border-t border-border">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-text-primary">
                                  Serial Number Terpilih ({formatLineTotalKeluar(line, warehouseSerials, productUnit)})
                                </span>
                                {line.serials.length > 0 && (
                                  <button
                                    type="button"
                                    className="text-[11px] font-medium text-danger hover:underline"
                                    onClick={() => handleClearAllSerials(line.id)}
                                  >
                                    Hapus Semua
                                  </button>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="go-modal__btn-secondary flex-1 justify-center text-xs"
                                  onClick={() =>
                                    setOpenSerialPickerLineId(
                                      openSerialPickerLineId === line.id ? null : line.id
                                    )
                                  }
                                >
                                  + Pilih SN
                                </button>
                              </div>

                              {openSerialPickerLineId === line.id && (
                                <div className="rounded border border-border bg-surface-muted p-2 shadow-float max-h-48 overflow-y-auto">
                                  <div className="flex items-center justify-between gap-2 mb-2">
                                    <input
                                      type="text"
                                      className="input text-xs font-mono mb-0 flex-1 bg-surface"
                                      placeholder="Filter nomor seri..."
                                      value={serialSearchQuery}
                                      onChange={(e) => setSerialSearchQuery(e.target.value)}
                                    />
                                    <button
                                      type="button"
                                      className="text-xs text-text-secondary px-1"
                                      onClick={() => setOpenSerialPickerLineId(null)}
                                    >
                                      Tutup
                                    </button>
                                  </div>
                                  {lineAvailableSerials.length === 0 ? (
                                    <p className="text-xs text-text-secondary text-center py-2">
                                      Tidak ada nomor seri tersedia di gudang ini.
                                    </p>
                                  ) : (
                                    <div className="flex flex-col gap-1">
                                      {lineAvailableSerials
                                        .filter((s) =>
                                          !serialSearchQuery ||
                                          s.serialNumber.toLowerCase().includes(serialSearchQuery.toLowerCase())
                                        )
                                        .map((s) => (
                                          <button
                                            key={s.id}
                                            type="button"
                                            className="flex items-center justify-between p-1.5 rounded bg-surface border border-border hover:border-primary text-xs text-left gap-1.5"
                                            onClick={async () => {
                                              await addSerialToLine(line.id, s.serialNumber);
                                              setSerialSearchQuery("");
                                            }}
                                          >
                                            <div className="flex items-center gap-1.5 min-w-0">
                                              <span className="font-mono font-semibold truncate">
                                                {s.serialNumber}
                                              </span>
                                              <span className="rounded bg-surface-muted border border-border px-1.5 py-0.5 text-[10px] text-text-secondary font-medium shrink-0">
                                                {s.unit || productUnit || "unit"}
                                              </span>
                                            </div>
                                            <span className="text-[11px] text-primary font-bold shrink-0">
                                              + Pilih
                                            </span>
                                          </button>
                                        ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {line.serials.length > 0 && (
                                <div className="go-serial-badge-wrap">
                                  {line.serials.map((sn, snIdx) => {
                                    const snUnit = warehouseSerials.find((ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase())?.unit || productUnit || "unit";
                                    return (
                                      <span key={sn} className="go-serial-chip">
                                        <span className="go-serial-chip__index">{snIdx + 1}.</span>
                                        <span className="font-mono">{sn}</span>
                                        <span className="rounded bg-surface-muted border border-border px-1 py-0.2 text-[10px] text-text-secondary font-sans font-medium">
                                          {snUnit}
                                        </span>
                                        <button
                                          type="button"
                                          className="go-serial-chip__remove"
                                          onClick={() => handleRemoveSerialFromLine(line.id, sn)}
                                          title={`Hapus ${sn}`}
                                        >
                                          ×
                                        </button>
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </form>
            </section>

            {isPoSidebarOpen && (
              <>
                <div
                  className="fixed inset-0 bg-black/40 z-[190] lg:hidden backdrop-blur-xs"
                  onClick={() => setIsPoSidebarOpen(false)}
                  aria-hidden="true"
                />
                <aside
                  className="go-modal__po-sidebar sticky top-0 self-start shrink-0"
                  aria-label="Referensi pesanan Purchase Order"
                >
                  {/* Header Panel PO */}
                  <div className="flex items-center justify-between pb-2.5 border-b border-border-default flex-shrink-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-text-primary">Referensi Pesanan PO</h3>
                      <span className="text-[11px] font-mono bg-surface-muted text-text-secondary px-1.5 py-0.5 rounded border border-border-subtle">
                        {sidebarSelectedPo ? "Detail" : `${filteredPurchaseOrders.length} PO`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-muted transition-colors cursor-pointer"
                      onClick={() => setIsPoSidebarOpen(false)}
                      aria-label="Tutup panel PO"
                      title="Tutup panel referensi PO"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>

                  {/* Mode A: Tampilkan Detail PO & Item yang Dipesan */}
                  {sidebarSelectedPo ? (
                    <div className="space-y-2.5 flex-1 flex flex-col min-h-0">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium cursor-pointer"
                          onClick={() => setSidebarSelectedPoId("")}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                          </svg>
                          <span>Daftar Semua PO</span>
                        </button>
                        {getPoStatusBadge(sidebarSelectedPo.status)}
                      </div>

                      {/* Header Ringkasan PO - Lebih ringkas, dempet, tanpa PIC Sales */}
                      <div className="p-2.5 rounded-lg border border-border-default bg-surface space-y-1.5 flex-shrink-0">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-xs text-text-primary">
                            {sidebarSelectedPo.poNumber}
                          </span>
                          <span className="text-[10px] font-mono text-text-muted">
                            {sidebarSelectedPo.orderDate || "—"}
                          </span>
                        </div>
                        <div className="text-xs text-text-primary font-medium">
                          Pelanggan: <span className="font-semibold">{sidebarSelectedPo.customerName || "—"}</span>
                        </div>
                        {sidebarSelectedPo.notes && (
                          <div className="text-[10px] text-text-muted italic bg-surface-muted/60 p-1.5 rounded border border-border-subtle line-clamp-2">
                            &ldquo;{sidebarSelectedPo.notes}&rdquo;
                          </div>
                        )}
                        {(sidebarSelectedPo.status === "PENDING_APPROVAL" || sidebarSelectedPo.status === "DRAFT") && (
                          <div className="p-1.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-800 dark:text-amber-300">
                            Status PO masih Pending (Menunggu Persetujuan). Pengeluaran fisik barang memerlukan persetujuan Owner.
                          </div>
                        )}

                        {/* Status Koneksi PO ke Form Goods Out */}
                        {selectedPoId !== sidebarSelectedPo.id ? (
                          (sidebarSelectedPo.status === "CONFIRMED" || sidebarSelectedPo.status === "PARTIALLY_FULFILLED") && (
                            <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-border-subtle">
                              <span className="text-[11px] text-text-muted">Belum terhubung</span>
                              <button
                                type="button"
                                className="text-xs text-primary hover:underline font-semibold cursor-pointer"
                                onClick={() => handleConnectPo(sidebarSelectedPo)}
                              >
                                Hubungkan PO
                              </button>
                            </div>
                          )
                        ) : (
                          <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-border-subtle text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                            <span className="inline-flex items-center gap-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                              PO Aktif
                            </span>
                            <button
                              type="button"
                              className="text-text-muted hover:text-danger hover:underline text-[10px] cursor-pointer"
                              onClick={() => {
                                setSelectedPoId("");
                                setLines((prev) => prev.map((l) => ({ ...l, poLineId: undefined })));
                              }}
                            >
                              Lepas PO
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Daftar Item Dipesan */}
                      <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
                        <div className="flex items-center justify-between text-xs text-text-secondary font-semibold pb-0.5">
                          <span>Rincian Item Dipesan ({sidebarSelectedPo.lines.length})</span>
                          <span className="text-[11px] font-mono font-normal">
                            {sidebarSelectedPo.lines.reduce((acc, l) => {
                              const matchingLines = lines.filter((line) => line.poLineId === l.id);
                              let draftAlloc = 0;
                              for (const mLine of matchingLines) {
                                if (mLine.tracking === "SERIAL" && mLine.serials && mLine.serials.length > 0) {
                                  for (const sn of mLine.serials) {
                                    const snItem = warehouseSerials.find((ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase());
                                    draftAlloc += getUnitMultiplier(snItem?.unit || mLine.unit || "unit");
                                  }
                                } else if (mLine.tracking === "NON_SERIAL") {
                                  draftAlloc += (Number(mLine.quantity) || 0) * getUnitMultiplier(mLine.unit);
                                }
                              }
                              return acc + Math.max(0, l.targetQty - (l.fulfilledQty + draftAlloc));
                            }, 0)} PCS sisa
                          </span>
                        </div>

                        {/* List item PO tanpa scrollbar tebal yang mengganggu lebar card */}
                        <div className="space-y-1.5 overflow-y-auto flex-1 pr-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                          {sidebarSelectedPo.lines.map((l) => {
                            // Hitung alokasi dari form Goods Out aktif saat ini untuk baris PO ini
                            const matchingLines = lines.filter((line) => line.poLineId === l.id);
                            let draftAllocatedPcs = 0;
                            for (const mLine of matchingLines) {
                              if (mLine.tracking === "SERIAL" && mLine.serials && mLine.serials.length > 0) {
                                for (const sn of mLine.serials) {
                                  const snItem = warehouseSerials.find((ws) => ws.serialNumber.trim().toLowerCase() === sn.trim().toLowerCase());
                                  const snUnit = snItem?.unit || mLine.unit || "unit";
                                  draftAllocatedPcs += getUnitMultiplier(snUnit);
                                }
                              } else if (mLine.tracking === "NON_SERIAL") {
                                const qty = Number(mLine.quantity) || 0;
                                const mult = getUnitMultiplier(mLine.unit);
                                draftAllocatedPcs += qty * mult;
                              }
                            }

                            const totalOutPcs = l.fulfilledQty + draftAllocatedPcs;
                            const effectiveRemaining = Math.max(0, l.targetQty - totalOutPcs);
                            const isFulfilled = effectiveRemaining === 0;
                            const isAlreadyInTable = matchingLines.length > 0;
                            const catProd = catalogProducts.find((p) => p.id === l.productId || (l.sku && p.sku === l.sku));
                            const isPendingPo = sidebarSelectedPo.status === "PENDING_APPROVAL" || sidebarSelectedPo.status === "DRAFT";

                            return (
                              <div
                                key={l.id}
                                className={`p-2 rounded-lg border text-xs space-y-1.5 transition-all ${
                                  isAlreadyInTable
                                    ? "border-primary/50 bg-primary-soft/20"
                                    : isFulfilled
                                    ? "border-border-default bg-surface-muted/40 opacity-75"
                                    : "border-border-default bg-surface hover:border-border-strong"
                                }`}
                              >
                                {/* Header Item: Nama produk di kiri, status / tombol di kanan atas */}
                                <div className="flex items-start justify-between gap-1.5">
                                  <div className="min-w-0 flex-1">
                                    <div className="font-semibold text-text-primary line-clamp-1 text-xs" title={l.rawProductName || l.productName}>
                                      {l.rawProductName || l.productName}
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                      {l.sku ? (
                                        <span className="font-mono text-[10px] text-text-muted bg-surface-muted px-1.5 py-0.2 rounded border border-border-subtle">
                                          SKU: {l.sku}
                                        </span>
                                      ) : (
                                        <span className="text-[10px] text-text-muted italic">Non-SKU</span>
                                      )}
                                      {catProd && (
                                        <span className="text-[10px] text-text-secondary">
                                          Tersedia: <strong className="font-mono">{catProd.availableStock ?? catProd.stock}</strong> {catProd.unit || "PCS"}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Status / Aksi di kanan atas */}
                                  <div className="shrink-0 flex items-center">
                                    {isAlreadyInTable ? (
                                      <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-300 dark:border-emerald-800 inline-flex items-center gap-1">
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                          <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                        Sudah
                                      </span>
                                    ) : isFulfilled ? (
                                      <span className="text-[10px] text-text-muted font-medium bg-surface-muted px-1.5 py-0.5 rounded border border-border">
                                        Selesai
                                      </span>
                                    ) : isPendingPo ? (
                                      <span className="text-[10px] text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30">
                                        Pending
                                      </span>
                                    ) : (!l.productId || l.mappingStatus === "UNMAPPED" || !catProd) ? (
                                      <span
                                        className="text-[10px] font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30"
                                        title="Item belum terhubung ke produk katalog"
                                      >
                                        Belum Link
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="text-[10px] font-semibold text-primary hover:bg-primary-soft border border-primary/30 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
                                        onClick={() => handleAddItemFromPo(l, sidebarSelectedPo)}
                                        title="Tambahkan baris produk ini ke tabel pengeluaran"
                                      >
                                        + Tambah
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* Metrics Ringkas: Pesanan, Keluar (Real-time), Sisa */}
                                <div className="grid grid-cols-3 gap-1 p-1.5 rounded bg-surface-subtle border border-border-subtle text-[11px] font-mono">
                                  <div>
                                    <div className="text-[9px] text-text-muted uppercase">Pesanan</div>
                                    <div className="font-semibold text-text-primary line-clamp-1">{l.orderedQty} {l.orderedUnit || "PCS"}</div>
                                  </div>
                                  <div>
                                    <div className="text-[9px] text-text-muted uppercase">Keluar</div>
                                    <div className="font-semibold text-text-secondary">{totalOutPcs} PCS</div>
                                  </div>
                                  <div>
                                    <div className="text-[9px] text-text-muted uppercase">Sisa</div>
                                    <div className={`font-bold ${effectiveRemaining > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-text-muted"}`}>
                                      {effectiveRemaining} PCS
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Mode B: Daftar Semua PO & Pencarian */
                    <div className="space-y-3 flex-1 flex flex-col min-h-0">
                      <input
                        type="search"
                        className="input text-xs w-full"
                        placeholder="Cari nomor PO, pelanggan, produk..."
                        value={poSearch}
                        onChange={(e) => setPoSearch(e.target.value)}
                      />

                      {/* Filter Tabs */}
                      <div className="flex items-center gap-1 border-b border-border-default pb-1.5 text-xs overflow-x-auto flex-shrink-0">
                        <button
                          type="button"
                          className={`px-2 py-1 rounded text-xs whitespace-nowrap cursor-pointer ${
                            poTabFilter === "ALL" ? "bg-primary text-white font-semibold" : "text-text-secondary hover:bg-surface-muted"
                          }`}
                          onClick={() => setPoTabFilter("ALL")}
                        >
                          Semua ({poTabCounts.all})
                        </button>
                        <button
                          type="button"
                          className={`px-2 py-1 rounded text-xs whitespace-nowrap cursor-pointer ${
                            poTabFilter === "REMAINING" ? "bg-primary text-white font-semibold" : "text-text-secondary hover:bg-surface-muted"
                          }`}
                          onClick={() => setPoTabFilter("REMAINING")}
                        >
                          Ada Sisa ({poTabCounts.remaining})
                        </button>
                        <button
                          type="button"
                          className={`px-2 py-1 rounded text-xs whitespace-nowrap cursor-pointer ${
                            poTabFilter === "PENDING" ? "bg-primary text-white font-semibold" : "text-text-secondary hover:bg-surface-muted"
                          }`}
                          onClick={() => setPoTabFilter("PENDING")}
                        >
                          Pending ({poTabCounts.pending})
                        </button>
                        <button
                          type="button"
                          className={`px-2 py-1 rounded text-xs whitespace-nowrap cursor-pointer ${
                            poTabFilter === "FULFILLED" ? "bg-primary text-white font-semibold" : "text-text-secondary hover:bg-surface-muted"
                          }`}
                          onClick={() => setPoTabFilter("FULFILLED")}
                        >
                          Selesai ({poTabCounts.fulfilled})
                        </button>
                      </div>

                      {/* PO Cards List */}
                      <div className="space-y-2 overflow-y-auto flex-1 pr-1">
                        {filteredPurchaseOrders.length === 0 ? (
                          <div className="p-6 text-center text-xs text-text-muted">
                            Tidak ada Purchase Order yang cocok dengan filter.
                          </div>
                        ) : (
                          filteredPurchaseOrders.map((po) => {
                            const totalItems = po.lines.length;
                            const remainingItems = po.lines.filter((l) => (l.targetQty - l.fulfilledQty) > 0).length;
                            const totalRemainingQty = po.lines.reduce((acc, l) => acc + Math.max(0, l.targetQty - l.fulfilledQty), 0);

                            return (
                              <div
                                key={po.id}
                                className="p-3 rounded-lg border border-border-default bg-surface hover:border-primary/50 hover:bg-surface-muted/20 transition-all cursor-pointer space-y-2"
                                onClick={() => {
                                  setSidebarSelectedPoId(po.id);
                                }}
                              >
                                <div className="flex items-center justify-between gap-1 flex-wrap">
                                  <span className="font-mono font-bold text-xs text-text-primary">
                                    {po.poNumber}
                                  </span>
                                  {getPoStatusBadge(po.status)}
                                </div>

                                <div className="text-xs text-text-primary font-medium line-clamp-1">
                                  {po.customerName || "Pelanggan Tanpa Nama"}
                                </div>

                                <div className="text-[11px] text-text-secondary flex items-center justify-between flex-wrap gap-1">
                                  <span className="font-mono text-text-muted">{po.orderDate || "—"}</span>
                                  <span className="font-semibold text-text-primary">
                                    {totalItems} item ({totalRemainingQty} PCS sisa)
                                  </span>
                                </div>

                                <div className="pt-1 flex items-center justify-end">
                                  <span className="text-[11px] text-primary font-medium hover:underline inline-flex items-center gap-1">
                                    Lihat Detail Pesanan →
                                  </span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </aside>
              </>
            )}
          </div>
        </div>

            {/* Modal Footer (Creation saves as Pending only) */}
            <div className="go-modal__footer go-modal__footer--between">
              <div>
                {(lines.some((l) => l.productId) || recipient || inputNotes) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleResetDraft}
                    className="text-text-secondary hover:text-danger text-xs"
                    title="Kosongkan formulir dan hapus draft"
                  >
                    Reset Form
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCloseModal}
                  disabled={isSubmitting}
                >
                  {editingPendingTx ? "Batal" : "Tutup"}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => handleSubmitGoodsOut(false)}
                  disabled={isSubmitting}
                  loading={isSubmitting}
                  loadingLabel={editingPendingTx ? "Menyimpan Perubahan..." : "Menyimpan Reservasi..."}
                  className="go-modal__footer-btn-submit"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="mr-1"
                  >
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                  </svg>
                  <span>
                    {editingPendingTx
                      ? "Simpan Perubahan"
                      : "Simpan Pending (Reservasi)"}
                  </span>
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ========================================================
          CAMERA SCANNER MODAL
          ======================================================== */}
      {scannerOpen && (
        <div className="go-scanner-overlay" role="dialog" aria-modal="true" aria-labelledby="go-scanner-title">
          <div className="go-scanner-modal">
            <div className="go-scanner__header">
              <h3 id="go-scanner-title" className="go-scanner__title">
                Scan Barcode / QR Serial Number
              </h3>
              <button
                type="button"
                className="go-modal__close-btn"
                onClick={handleCloseScanner}
                aria-label="Tutup kamera"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18"></path>
                  <path d="m6 6 12 12"></path>
                </svg>
              </button>
            </div>

            <div className="go-scanner__viewfinder">
              <video ref={videoRef} className="go-scanner__video" playsInline muted autoPlay />
              <div className="go-scanner__aim-box">
                <div className="go-scanner__scan-laser" />
              </div>
            </div>

            <div className="go-scanner__controls">
              {cameraError ? (
                <div className="rounded border border-danger/30 bg-danger-soft p-2.5 text-xs text-danger">
                  {cameraError}
                </div>
              ) : (
                <p className="go-scanner__status">
                  Arahkan kamera ke label QR code atau barcode Serial Number. Sistem akan otomatis mendeteksi dan menambahkannya ke daftar.
                </p>
              )}

              {/* Feed of recent scans */}
              {scannerFeed.length > 0 && (
                <div className="go-scanner__feed-list">
                  {scannerFeed.map((item) => (
                    <span
                      key={item.id}
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] ${
                        item.success
                          ? "bg-primary-soft text-primary border border-primary/20"
                          : "bg-danger-soft text-danger border border-danger/20"
                      }`}
                    >
                      {item.success ? "✓" : "✗"} {item.code}
                    </span>
                  ))}
                </div>
              )}

              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={handleCloseScanner}
                className="w-full justify-center"
              >
                Selesai Memindai
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          PASTE EXCEL / GOOGLE SHEETS MODAL
          ======================================================== */}
      {pasteModalOpen && (
        <Dialog
          open={pasteModalOpen}
          onClose={() => setPasteModalOpen(false)}
          title="Paste Data dari Excel / Spreadsheet"
          description={`Tempel data baris tabel yang disalin dari Excel atau Google Sheets. Sistem akan memetakan SKU/Nama ke produk gudang aktif (${context.warehouseName ?? "Gudang Utama"}).`}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-text-primary">
                  Area Tempel (Paste TSV / CSV)
                </label>
                <span className="text-[11px] text-text-secondary font-mono">
                  Format: [SKU / Nama] [Tab] [Qty] [Tab] [Nomor Seri]
                </span>
              </div>
              <textarea
                className="input text-xs font-mono"
                rows={5}
                placeholder={"Contoh:\nSKU-ROUTER\t2\tRTR-001, RTR-002\nSKU-CABLE\t15\n\nAtau tempel daftar Serial Number per baris:\nRTR-001\nRTR-002"}
                value={pasteRawText}
                onChange={(e) => setPasteRawText(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex items-center gap-4 text-xs">
              <span className="font-semibold text-text-primary">Mode Impor:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="pasteMode"
                  value="replace"
                  checked={pasteImportMode === "replace"}
                  onChange={() => setPasteImportMode("replace")}
                />
                <span>Gantikan baris form saat ini</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="pasteMode"
                  value="append"
                  checked={pasteImportMode === "append"}
                  onChange={() => setPasteImportMode("append")}
                />
                <span>Tambahkan ke baris form saat ini</span>
              </label>
            </div>

            {/* Preview Results */}
            {parsedSpreadsheetRows.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-text-primary">
                    Hasil Analisis ({parsedSpreadsheetRows.length} baris terdeteksi):
                  </span>
                  <span className="text-[11px] font-medium text-text-secondary">
                    Valid: {parsedSpreadsheetRows.filter((r) => r.isValid).length} • Ditolak:{" "}
                    {parsedSpreadsheetRows.filter((r) => !r.isValid).length}
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto rounded border border-border">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-surface-muted/50 border-b border-border text-[11px] font-semibold text-text-secondary">
                      <tr>
                        <th className="p-2 w-8 text-center">#</th>
                        <th className="p-2">Input</th>
                        <th className="p-2">Produk Ditemukan</th>
                        <th className="p-2 w-28">Kuantitas / SN</th>
                        <th className="p-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedSpreadsheetRows.map((r, rIdx) => (
                        <tr key={rIdx} className="border-b border-border/50">
                          <td className="p-2 text-center text-text-secondary font-mono">{rIdx + 1}</td>
                          <td className="p-2 font-mono text-text-secondary truncate max-w-xs">{r.inputRaw}</td>
                          <td className="p-2 font-medium text-text-primary">
                            {r.product ? `${r.product.name} (${r.product.sku})` : "-"}
                          </td>
                          <td className="p-2">
                            {r.product?.tracking === "SERIAL" ? (
                              <span className="font-mono text-primary font-semibold">
                                {r.matchedSerials.length} SN
                              </span>
                            ) : (
                              <span className="font-semibold text-text-primary">
                                {r.quantity} {r.product?.unit}
                              </span>
                            )}
                          </td>
                          <td className="p-2">
                            {r.isValid ? (
                              <span className="text-primary font-semibold">Valid</span>
                            ) : (
                              <span className="text-danger font-medium">{r.errorMessage}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" size="md" onClick={() => setPasteModalOpen(false)}>
                Batal
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={handleApplyPaste}
                disabled={parsedSpreadsheetRows.filter((r) => r.isValid).length === 0}
              >
                Terapkan ke Worksheet
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* ========================================================
          DETAIL TRANSACTION MODAL (Matching Barang Keluar Baru layout)
          ======================================================== */}
      {selectedTxDetail && (
        <div
          className="go-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="go-detail-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedTxDetail(null);
          }}
        >
          <section className="go-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="go-modal__header">
              <div className="go-modal__header-title-box">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 id="go-detail-modal-title" className="go-modal__title">
                    Detail Pengeluaran: {selectedTxDetail.reference}
                  </h2>
                  <StatusBadge
                    tone={
                      selectedTxDetail.status === "COMPLETED"
                        ? "success"
                        : selectedTxDetail.status === "PENDING"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {selectedTxDetail.status}
                  </StatusBadge>
                </div>
                <p className="go-modal__subtitle">
                  {selectedTxDetail.status === "PENDING"
                    ? "Dokumen reservasi pengeluaran barang. Stok fisik belum dipotong sampai transaksi diselesaikan."
                    : selectedTxDetail.status === "COMPLETED"
                    ? "Transaksi telah selesai diposting. Stok fisik dan nomor seri telah dipotong secara resmi dari gudang."
                    : "Transaksi ini telah dibatalkan. Reservasi stok dan nomor seri telah dilepaskan kembali ke gudang."}
                </p>
              </div>

              <div className="go-modal__header-controls">
                <div className="go-modal__gudang-chip flex items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-semibold text-text-secondary">
                  <span>
                    <span className="max-lg:hidden">Gudang: </span>
                    {selectedTxDetail.warehouseName || context.warehouseName || "Gudang Utama"}
                  </span>
                </div>
                <button
                  type="button"
                  className="go-modal__close-btn"
                  onClick={() => setSelectedTxDetail(null)}
                  aria-label="Tutup modal detail barang keluar"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrollable Body */}
            <div className="go-modal__body">
              <div className="flex flex-col gap-4">
                {/* Transaction Details Info Card */}
                <div className="go-modal__info-card">
                  <h4 className="go-modal__info-title">Informasi Dokumen & Penerima</h4>
                  <div className="go-modal__info-grid">
                    <div className="go-modal__field">
                      <label className="go-modal__field-label">No. Referensi</label>
                      <input
                        type="text"
                        className="input text-xs font-mono font-semibold bg-surface-muted/40 cursor-default"
                        value={selectedTxDetail.reference}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Tanggal Pengeluaran</label>
                      <input
                        type="text"
                        className="input text-xs bg-surface-muted/40 cursor-default"
                        value={selectedTxDetail.date}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Nama Penerima</label>
                      <input
                        type="text"
                        className="input text-xs font-medium bg-surface-muted/40 cursor-default"
                        value={selectedTxDetail.recipientName}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Purchase Order</label>
                      <input
                        type="text"
                        className="input text-xs font-mono bg-surface-muted/40 cursor-default"
                        value={selectedTxDetail.poNumber || "-"}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Alamat Tujuan</label>
                      <input
                        type="text"
                        className="input text-xs bg-surface-muted/40 cursor-default"
                        value={selectedTxDetail.recipientAddress || "-"}
                        readOnly
                      />
                    </div>

                    <div className="go-modal__field">
                      <label className="go-modal__field-label">Status Dokumen</label>
                      <div className="input text-xs bg-surface-muted/40 cursor-default flex items-center min-h-[38px]">
                        <StatusBadge
                          tone={
                            selectedTxDetail.status === "COMPLETED"
                              ? "success"
                              : selectedTxDetail.status === "PENDING"
                              ? "warning"
                              : "neutral"
                          }
                        >
                          {selectedTxDetail.status}
                        </StatusBadge>
                      </div>
                    </div>

                    {selectedTxDetail.notes && (
                      <div className="go-modal__field go-modal__field--full sm:col-span-3" style={{ gridColumn: "1 / -1" }}>
                        <label className="go-modal__field-label">Catatan Tambahan</label>
                        <input
                          type="text"
                          className="input text-xs bg-surface-muted/40 cursor-default"
                          value={selectedTxDetail.notes}
                          readOnly
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Worksheet (Daftar Barang Keluar) */}
                <div className="go-modal__worksheet">
                  <div className="go-modal__items-header">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="go-modal__items-title">Daftar Barang Keluar</h4>
                      <span className="go-modal__items-count-badge">
                        {selectedTxDetail.items.length} baris
                      </span>
                      <span className="rounded bg-primary-soft border border-primary/20 px-2 py-0.5 text-xs font-bold text-primary font-mono">
                        Total Keluar: {formatDetailGrandTotal(selectedTxDetail.items)}
                      </span>
                    </div>
                  </div>

                  {/* Desktop Table View */}
                  <div className="go-modal__table-wrapper hidden sm:block">
                    <table className="go-modal__table">
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}>#</th>
                          <th>Produk & SKU</th>
                          <th style={{ width: 110 }}>Tracking</th>
                          <th style={{ width: 140 }}>Kuantitas Keluar</th>
                          <th style={{ width: 140 }} className="text-right">Total Keluar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedTxDetail.items.map((item, idx) => {
                          const isSerial = item.tracking === "SERIAL";
                          const hasSerials = isSerial && item.serials && item.serials.length > 0;
                          const isExpanded = expandedDetailSerialIdxs.includes(idx);

                          return (
                            <React.Fragment key={idx}>
                              <tr
                                onClick={() => {
                                  if (hasSerials) toggleDetailSerialExpand(idx);
                                }}
                                className={
                                  hasSerials
                                    ? "cursor-pointer hover:bg-surface-muted/60 transition-colors select-none"
                                    : undefined
                                }
                                title={
                                  hasSerials
                                    ? isExpanded
                                      ? "Klik untuk menutup daftar serial number"
                                      : "Klik untuk melihat nomor seri yang keluar"
                                    : undefined
                                }
                              >
                                <td className="go-table-index">{idx + 1}</td>
                                <td>
                                  <div className="flex flex-col">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-semibold text-text-primary text-xs">
                                        {item.productName}
                                      </span>
                                      {hasSerials && (
                                        <span
                                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold transition-colors ${
                                            isExpanded
                                              ? "bg-primary text-surface"
                                              : "bg-primary-soft text-primary border border-primary/20 hover:border-primary/50"
                                          }`}
                                        >
                                          <span>{item.serials!.length} SN</span>
                                          <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="11"
                                            height="11"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            className={`transition-transform duration-200 ${
                                              isExpanded ? "rotate-180" : ""
                                            }`}
                                            aria-hidden="true"
                                          >
                                            <path d="m6 9 6 6 6-6" />
                                          </svg>
                                        </span>
                                      )}
                                    </div>
                                    <span className="font-mono text-[11px] text-text-secondary">
                                      {item.sku}
                                    </span>
                                  </div>
                                </td>
                                <td>
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                      isSerial
                                        ? "bg-primary-soft text-primary border border-primary/20"
                                        : "bg-surface-muted text-text-secondary border border-border"
                                    }`}
                                  >
                                    {item.tracking}
                                  </span>
                                </td>
                                <td>
                                  <span className="font-semibold text-text-primary text-xs">
                                    {item.qty} {item.unit}
                                  </span>
                                </td>
                                <td className="text-right">
                                  <span className="font-semibold text-text-primary text-xs font-mono">
                                    {item.qty} {item.unit}
                                  </span>
                                </td>
                              </tr>

                              {hasSerials && isExpanded && (
                                <tr className="go-subrow">
                                  <td colSpan={5}>
                                    <div className="go-serial-panel">
                                      <div className="go-serial-panel__header">
                                        <div className="go-serial-panel__title">
                                          <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="14"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                          >
                                            <path d="M3 5v14"></path>
                                            <path d="M8 5v14"></path>
                                            <path d="M12 5v14"></path>
                                            <path d="M17 5v14"></path>
                                            <path d="M21 5v14"></path>
                                          </svg>
                                          <span>Serial Number Terpilih ({item.serials!.length} SN)</span>
                                        </div>
                                      </div>
                                      <div className="go-serial-chip-wrap">
                                        {item.serials!.map((sn, sIdx) => (
                                          <span key={sIdx} className="go-serial-chip">
                                            <span className="go-serial-chip__index">{sIdx + 1}.</span>
                                            <span>{sn}</span>
                                            <span className="rounded bg-surface px-1 py-0.5 text-[9px] font-bold text-text-secondary border border-border">
                                              {item.unit || "unit"}
                                            </span>
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Cards View */}
                  <div className="go-mobile-lines sm:hidden">
                    {selectedTxDetail.items.map((item, idx) => {
                      const isSerial = item.tracking === "SERIAL";
                      const hasSerials = isSerial && item.serials && item.serials.length > 0;
                      const isExpanded = expandedDetailSerialIdxs.includes(idx);

                      return (
                        <div key={idx} className="go-mobile-line-card">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-text-secondary">#{idx + 1}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isSerial
                                  ? "bg-primary-soft text-primary border border-primary/20"
                                  : "bg-surface-muted text-text-secondary border border-border"
                              }`}
                            >
                              {item.tracking}
                            </span>
                          </div>

                          <div>
                            <p className="text-xs font-semibold text-text-primary">{item.productName}</p>
                            <p className="text-[11px] font-mono text-text-secondary">{item.sku}</p>
                          </div>

                          <div className="flex items-center justify-between text-xs pt-1 border-t border-border">
                            <span className="text-text-secondary">Total Keluar:</span>
                            <span className="font-semibold text-text-primary">{item.qty} {item.unit}</span>
                          </div>

                          {hasSerials && (
                            <div className="pt-2">
                              <button
                                type="button"
                                onClick={() => toggleDetailSerialExpand(idx)}
                                className="w-full flex items-center justify-between py-1.5 px-2.5 rounded bg-surface border border-border text-[11px] font-medium text-text-primary hover:bg-surface-muted transition-colors cursor-pointer"
                              >
                                <span className="flex items-center gap-1.5 font-semibold text-primary">
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <path d="M3 5v14"></path>
                                    <path d="M8 5v14"></path>
                                    <path d="M12 5v14"></path>
                                    <path d="M17 5v14"></path>
                                    <path d="M21 5v14"></path>
                                  </svg>
                                  <span>Nomor Seri ({item.serials!.length} SN)</span>
                                </span>
                                <span className="text-[10px] text-text-secondary flex items-center gap-1">
                                  <span>{isExpanded ? "Sembunyikan" : "Tampilkan"}</span>
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className={`transition-transform duration-200 ${
                                      isExpanded ? "rotate-180" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <path d="m6 9 6 6 6-6" />
                                  </svg>
                                </span>
                              </button>
                              {isExpanded && (
                                <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto pt-2">
                                  {item.serials!.map((sn, sIdx) => (
                                    <span
                                      key={sIdx}
                                      className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-primary"
                                    >
                                      <span>{sn}</span>
                                      <span className="text-[9px] text-text-secondary">({item.unit})</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer (Streamlined & Clean for all statuses) */}
            <div className="go-modal__footer go-modal__footer--between">
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5"
                  title="Cetak Dokumen Pengeluaran Barang"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="shrink-0"
                  >
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                    <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path>
                    <rect x="6" y="14" width="12" height="8" rx="1"></rect>
                  </svg>
                  <span>Cetak</span>
                </Button>
              </div>

              <div className="flex items-center gap-2">
                {selectedTxDetail.status === "PENDING" && (
                  <>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setCancelTarget(selectedTxDetail);
                        setCancelReason("");
                      }}
                      title="Hapus transaksi pending ini dan lepaskan reservasi stok"
                      className="inline-flex items-center gap-1.5"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="shrink-0"
                      >
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                      </svg>
                      <span>Hapus</span>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleStartEditPending(selectedTxDetail)}
                      title="Ubah rincian, produk, kuantitas, atau nomor seri pengeluaran ini"
                      className="inline-flex items-center gap-1.5"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="shrink-0"
                      >
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                        <path d="m15 5 4 4"></path>
                      </svg>
                      <span>Edit Transaksi</span>
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={isCompleting}
                      loading={isCompleting}
                      loadingLabel="Menyelesaikan..."
                      onClick={() => {
                        handleCompletePending(selectedTxDetail);
                      }}
                      title="Selesaikan pengeluaran barang dan kurangi stok fisik"
                      className="inline-flex items-center gap-1.5"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="shrink-0"
                      >
                        <path d="M20 6 9 17l-5-5"></path>
                      </svg>
                      <span>Selesaikan</span>
                    </Button>
                  </>
                )}
                {selectedTxDetail.status === "COMPLETED" && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setReturnTargetTx(selectedTxDetail);
                    }}
                    className="inline-flex items-center gap-1.5"
                    title="Buat Retur Pelanggan dari dokumen pengeluaran ini"
                  >
                    <RotateCcwIcon className="h-3.5 w-3.5" />
                    <span>Buat Retur Pelanggan</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedTxDetail(null)}
                >
                  Tutup
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* ========================================================
          CANCELLATION CONFIRMATION DIALOG
          ======================================================== */}
      {cancelTarget && (
        <Dialog
          open={!!cancelTarget}
          onClose={() => setCancelTarget(null)}
          title={`Hapus / Batalkan Pengeluaran: ${cancelTarget.reference}`}
          description="Pembatalan akan menghapus dokumen dari daftar aktif dan melepaskan seluruh reservasi stok/Serial Number kembali ke gudang aktif."
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-text-primary">
                Alasan Pembatalan / Hapus *
              </label>
              <textarea
                className="input text-xs"
                rows={3}
                placeholder="Contoh: Kesalahan input kuantitas, pesanan dibatalkan oleh pelanggan..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                autoFocus
                required
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCancelTarget(null)}
                disabled={isCancelling}
              >
                Kembali
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleConfirmCancel}
                loading={isCancelling}
                loadingLabel="Menghapus..."
                disabled={isCancelling || !cancelReason.trim()}
              >
                Ya, Hapus (Batalkan)
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {/* Dialog Retur Pelanggan dari Dokumen Goods Out COMPLETED */}
      {returnTargetTx && (
        <ReturnSerialPickerDialog
          open={!!returnTargetTx}
          onClose={() => setReturnTargetTx(null)}
          sourceType="CUSTOMER"
          sourceReference={returnTargetTx.reference}
          partnerName={returnTargetTx.recipientName}
          warehouseId={returnTargetTx.warehouseId}
          warehouseName={returnTargetTx.warehouseName}
          items={returnTargetTx.items.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            sku: it.sku,
            unit: it.unit,
            qty: it.qty,
            tracking: it.tracking,
            serials: it.serials,
          }))}
          isSubmitting={isSubmittingReturn}
          onSubmit={async (data) => {
            setIsSubmittingReturn(true);
            try {
              const matchedCustomer =
                customers.find(
                  (c) =>
                    c.name.trim().toLowerCase() === returnTargetTx.recipientName.trim().toLowerCase()
                ) || customers[0];

              const res = await createInventoryReturnAction({
                warehouseId: returnTargetTx.warehouseId,
                returnType: "CUSTOMER_RETURN",
                customerId: matchedCustomer?.id,
                goodsOutId: returnTargetTx.id,
                returnNumber: `RET-DO-${Date.now().toString().slice(-6)}`,
                returnDate: new Date().toISOString().slice(0, 10),
                reason: data.reason,
                notes: data.notes,
                lines: data.lines.map((l) => ({
                  productId: l.productId,
                  quantity: l.quantity,
                  unit: l.unit,
                  condition: l.condition,
                  returnedSerials: l.returnedSerials,
                  groupReturnMode: l.groupReturnMode,
                })),
              });

              if (!res.success) {
                toast.push({
                  tone: "danger",
                  title: "Gagal Membuat Retur",
                  description: res.error || "Terjadi kesalahan saat memproses retur pelanggan.",
                });
                return;
              }

              toast.push({
                tone: "success",
                title: "Retur Pelanggan Berhasil Dibuat",
                description: `Dokumen retur ${res.returnRecord?.returnNumber} telah dibuat berstatus DRAFT (Menunggu penerimaan fisik).`,
              });
              setReturnTargetTx(null);
            } finally {
              setIsSubmittingReturn(false);
            }
          }}
        />
      )}
      {/* Akhir Dialog Goods Out */}
    </div>
  );
}

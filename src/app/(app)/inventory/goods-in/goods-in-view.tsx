"use client";

import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, Alert } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/form-fields";
import { ListToolbar, type ActiveFilter } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";

const PAGE_SIZE = 50;
import { useActiveContext } from "@/lib/demo/active-context-provider";
import {
  FIXTURE_GOODS_IN,
  FIXTURE_PARTNERS,
  FIXTURE_PRODUCTS,
  type GoodsInTransaction,
  type Partner,
} from "@/lib/demo/inventory-fixtures";
import {
  createGoodsInPendingAction,
  updateGoodsInPendingAction,
  postPendingGoodsInAction,
  createProductAction,
  getGoodsInSerialsStatusAction,
  registerGoodsInSerialsAction,
  updateWarehouseConversionDisplayUnitAction,
  deleteGoodsInAction,
  createInventoryReturnAction,
} from "@/lib/inventory/actions";
import { ReturnSerialPickerDialog } from "@/components/inventory/return-serial-picker-dialog";
import { RotateCcwIcon } from "@/components/ui/icons";
import type { GoodsInSerialsStatusResult } from "@/lib/db/repositories/inventory-repository";
import {
  SUPPORTED_UNITS,
  getUnitMultiplier,
  formatUnitLabel,
  formatConversionDisplay,
} from "@/lib/inventory/units";
import "./goods-in-modal.css";

export interface GoodsInViewProps {
  initialTransactions?: GoodsInTransaction[];
  initialSuppliers?: Partner[];
  initialProducts?: Array<{
    id: string;
    name: string;
    sku: string;
    tracking: "SERIAL" | "NON_SERIAL";
    unit: string;
    warehouseId: string;
  }>;
  initialConversionUnit?: "pcs" | "lusin";
}

interface FormLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  tracking: "SERIAL" | "NON_SERIAL";
  quantity: string;
  unit: string;
  serialsText: string;
  note: string;
  showSerials: boolean;
}

function getTodayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function generateSequenceRef(index: number) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const seq = String(index + 1).padStart(4, "0");
  return `WH/IN/${yyyy}${mm}${dd}/${seq}`;
}

function createEmptyGoodsInLine(): FormLine {
  return {
    id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    productId: "",
    productName: "",
    sku: "",
    tracking: "NON_SERIAL",
    quantity: "1",
    unit: "pcs",
    serialsText: "",
    note: "",
    showSerials: false,
  };
}

function generateBatchSerials(whId: string | null | undefined, sku: string, count: number): string[] {
  const whCode = whId ? whId.replace("wh-", "").toUpperCase() : "WH";
  const skuCode = sku ? sku.replace(/[^A-Za-z0-9]/g, "") : "ITEM";
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const timeSeq = Date.now().toString().slice(-4);

  return Array.from(
    { length: count },
    (_, i) => `${whCode}-${skuCode}-${dateStr}-${timeSeq}-${String(i + 1).padStart(3, "0")}`
  );
}

function generateRowSerials(whId: string | null | undefined, sku: string, count: number, lineIndex: number): string[] {
  const whCode = whId ? whId.replace("wh-", "").toUpperCase() : "WH";
  const skuCode = sku ? sku.replace(/[^A-Za-z0-9]/g, "") : "ITEM";
  const timeStamp = Date.now().toString().slice(-6);

  return Array.from(
    { length: count },
    (_, i) => `SN-${whCode}-${skuCode}-${timeStamp}-${String(lineIndex + 1).padStart(2, "0")}-${String(i + 1).padStart(3, "0")}`
  );
}

interface ParsedGoodsInLineItem {
  id?: string;
  productId: string;
  quantity: number;
  unit: string;
  serials?: string[];
  note?: string;
}

export function GoodsInView({
  initialTransactions,
  initialSuppliers,
  initialProducts,
  initialConversionUnit = "pcs",
}: GoodsInViewProps) {
  const { context } = useActiveContext();
  const toast = useToast();
  const router = useRouter();

  const activeWhId = context.warehouseId || "wh-01";
  const [conversionUnit, setConversionUnit] = useState<"pcs" | "lusin">(() => {
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem(`docuflow_gi_conv_unit_${activeWhId}`);
      if (cached === "pcs" || cached === "lusin") return cached;
    }
    return initialConversionUnit || "pcs";
  });

  // Sinkronkan preferensi saat gudang aktif berganti atau initialConversionUnit berubah dari server
  const convKey = JSON.stringify([activeWhId, initialConversionUnit]);
  const [prevConvKey, setPrevConvKey] = useState(convKey);
  if (convKey !== prevConvKey) {
    setPrevConvKey(convKey);
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem(`docuflow_gi_conv_unit_${activeWhId}`);
      if (cached === "pcs" || cached === "lusin") {
        setConversionUnit(cached);
      } else if (initialConversionUnit) {
        setConversionUnit(initialConversionUnit);
      } else {
        setConversionUnit((u) => u);
      }
    } else if (initialConversionUnit) {
      setConversionUnit(initialConversionUnit);
    }
  }

  async function handleChangeConversionUnit(newUnit: "pcs" | "lusin") {
    setConversionUnit(newUnit);
    if (typeof window !== "undefined") {
      localStorage.setItem(`docuflow_gi_conv_unit_${activeWhId}`, newUnit);
    }
    if (context.warehouseId) {
      try {
        await updateWarehouseConversionDisplayUnitAction({
          warehouseId: context.warehouseId,
          unit: newUnit,
        });
      } catch (err) {
        console.error("Gagal menyimpan preferensi satuan gudang:", err);
      }
    }
  }

  const [transactions, setTransactions] = useState<GoodsInTransaction[]>(
    initialTransactions && initialTransactions.length > 0
      ? initialTransactions
      : FIXTURE_GOODS_IN
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingPendingTx, setEditingPendingTx] = useState<GoodsInTransaction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Detail Modal & Unit/Serial Registration State
  const [selectedTxDetail, setSelectedTxDetail] = useState<GoodsInTransaction | null>(null);
  const [isPostingPending, setIsPostingPending] = useState(false);
  const [detailActiveTab, setDetailActiveTab] = useState<"items" | "serials">("items");
  const [serialsStatusData, setSerialsStatusData] = useState<GoodsInSerialsStatusResult | null>(null);
  const [isLoadingSerialsStatus, setIsLoadingSerialsStatus] = useState<boolean>(false);
  const [activeRegLineId, setActiveRegLineId] = useState<string | null>(null);
  const [lineSnInput, setLineSnInput] = useState<Record<string, string>>({});
  const [isRegisteringSn, setIsRegisteringSn] = useState<boolean>(false);
  const [regError, setRegError] = useState<string | null>(null);

  // Detail Modal Assignment State (referensi GoodsInDetailModal)
  const [showAssignPanel, setShowAssignPanel] = useState(false);
  const [assignMode, setAssignMode] = useState<"manual" | "auto">("manual");
  const [autoTargetItemKey, setAutoTargetItemKey] = useState("all");
  const [assignmentDrafts, setAssignmentDrafts] = useState<
    Array<{ _key: string; itemKey: string; serialNumber: string; serialUnit: string }>
  >([]);
  const [isSubmittingSerials, setIsSubmittingSerials] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [selectedItemChecks, setSelectedItemChecks] = useState<Record<string, boolean>>({});
  const [expandedSerialItemKeys, setExpandedSerialItemKeys] = useState<Record<string, boolean>>({});
  const [confirmPostModalOpen, setConfirmPostModalOpen] = useState(false);
  const [confirmDeleteModalOpen, setConfirmDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Retur Supplier Modal state
  const [returnTargetTx, setReturnTargetTx] = useState<GoodsInTransaction | null>(null);
  const [returnAvailableSerials, setReturnAvailableSerials] = useState<string[]>([]);
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
  const [isLoadingReturnSerials, setIsLoadingReturnSerials] = useState(false);

  async function handleStartReturnSupplier(tx: GoodsInTransaction) {
    setIsLoadingReturnSerials(true);
    try {
      const res = await getGoodsInSerialsStatusAction(tx.id);
      if (res.success && res.data) {
        const availableSns = res.data.lines.flatMap((l) =>
          l.serials
            .filter((s) => s.status === "AVAILABLE")
            .map((s) => s.serialNumber.trim().toUpperCase())
        );
        setReturnAvailableSerials(availableSns);
      } else {
        setReturnAvailableSerials([]);
      }
      setReturnTargetTx(tx);
    } catch {
      setReturnAvailableSerials([]);
      setReturnTargetTx(tx);
    } finally {
      setIsLoadingReturnSerials(false);
    }
  }

  function toggleExpandSerials(itemKey: string) {
    setExpandedSerialItemKeys((prev) => ({
      ...prev,
      [itemKey]: !prev[itemKey],
    }));
  }

  function handleInitiateReturn() {
    if (!selectedTxDetail) return;
    handleStartReturnSupplier(selectedTxDetail);
  }

  async function handleDeleteSelectedTx() {
    if (isDeleting) return;
    if (!selectedTxDetail) return;
    setIsDeleting(true);
    try {
      const res = await deleteGoodsInAction(selectedTxDetail.id);
      if (!res.success) {
        toast.push({
          tone: "danger",
          title: "Gagal Menghapus",
          description: res.error || "Gagal menghapus transaksi barang masuk.",
        });
        return;
      }

      setTransactions((prev) => prev.filter((t) => t.id !== selectedTxDetail.id));
      toast.push({
        tone: "success",
        title: "Transaksi Dihapus",
        description: `Dokumen ${selectedTxDetail.reference} berhasil dihapus dari daftar aktif.`,
      });
      setSelectedTxDetail(null);
      setConfirmDeleteModalOpen(false);
    } catch (err) {
      toast.push({
        tone: "danger",
        title: "Kesalahan Sistem",
        description: err instanceof Error ? err.message : "Gagal menghapus transaksi.",
      });
    } finally {
      setIsDeleting(false);
    }
  }

  const [suppliers, setSuppliers] = useState<Partner[]>(() => {
    return initialSuppliers && initialSuppliers.length > 0
      ? initialSuppliers
      : FIXTURE_PARTNERS.filter((p) => p.type === "SUPPLIER");
  });

  const [catalogProducts, setCatalogProducts] = useState(() => {
    return initialProducts && initialProducts.length > 0
      ? initialProducts
      : FIXTURE_PRODUCTS.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        tracking: p.tracking,
        unit: p.unit || "pcs",
        warehouseId: p.warehouseId,
      }));
  });

  const availableProducts = useMemo(() => {
    return catalogProducts.filter(
      (p) => !context.warehouseId || p.warehouseId === context.warehouseId
    );
  }, [catalogProducts, context.warehouseId]);

  // Form States (New Goods In Modal)
  const [refNumber, setRefNumber] = useState(() => generateSequenceRef(transactions.length));
  const [receivingDate, setReceivingDate] = useState(getTodayIso());
  const [sourceSearch, setSourceSearch] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [notes, setNotes] = useState("");

  // Product dropdown open index tracking
  const [openProductDropdownIdx, setOpenProductDropdownIdx] = useState<number | null>(null);
  const [productSearchQueries, setProductSearchQueries] = useState<Record<number, string>>({});

  // Quick Create Master Product State
  const [quickCreateModalOpen, setQuickCreateModalOpen] = useState(false);
  const [quickCreateCallerLineIdx, setQuickCreateCallerLineIdx] = useState<number | null>(null);
  const [quickCreateName, setQuickCreateName] = useState("");
  const [quickCreateSku, setQuickCreateSku] = useState("");
  const [quickCreateTrackingMode, setQuickCreateTrackingMode] = useState<"SERIAL" | "NON_SERIAL">("SERIAL");
  const [quickCreateUnit, setQuickCreateUnit] = useState("pcs");
  const [quickCreateCategory, setQuickCreateCategory] = useState("General");
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [isQuickCreating, setIsQuickCreating] = useState(false);

  // Lines — Awal dibuka tepat 1 baris kosong
  const [lines, setLines] = useState<FormLine[]>([
    {
      id: "line-1",
      productId: "",
      productName: "",
      sku: "",
      tracking: "NON_SERIAL",
      quantity: "1",
      unit: "pcs",
      serialsText: "",
      note: "",
      showSerials: false,
    },
  ]);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const isPendingDisabled =
    !sourceSearch.trim() || lines.length === 0 || lines.some((l) => !l.productId);

  const totalConvertedPcs = useMemo(() => {
    return lines.reduce((sum, l) => {
      const q = parseFloat(l.quantity) || 0;
      const m = getUnitMultiplier(l.unit);
      return sum + q * m;
    }, 0);
  }, [lines]);

  // Spreadsheet / Excel Paste Modal State
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteRawText, setPasteRawText] = useState("");
  const [pasteImportMode, setPasteImportMode] = useState<"replace" | "append">("replace");

  interface ParsedSpreadsheetRow {
    raw: string;
    query: string;
    product: (typeof availableProducts)[0] | null;
    qty: number;
    unit: string;
    note: string;
    isValid: boolean;
    errorMsg?: string;
  }

  const parsedSpreadsheetRows = useMemo<ParsedSpreadsheetRow[]>(() => {
    if (!pasteRawText.trim()) return [];
    const rawLines = pasteRawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return rawLines.map((lineStr) => {
      const parts = lineStr.includes("\t")
        ? lineStr.split("\t")
        : lineStr.includes(";")
          ? lineStr.split(";")
          : lineStr.split(",");

      const colProduct = (parts[0] ?? "").trim();
      const colQty = (parts[1] ?? "").trim();
      const colUnit = (parts[2] ?? "").trim().toLowerCase();
      const colNote = (parts[3] ?? "").trim();

      const qtyNum = parseFloat(colQty) || 1;
      const matchedProduct =
        availableProducts.find(
          (p) =>
            p.sku.toLowerCase() === colProduct.toLowerCase() ||
            p.name.toLowerCase() === colProduct.toLowerCase()
        ) || null;

      const matchedUnit =
        SUPPORTED_UNITS.find(
          (u) => u.key.toLowerCase() === colUnit || u.label.toLowerCase() === colUnit
        )?.key || (matchedProduct?.unit ?? "pcs");

      const isValid = Boolean(matchedProduct) && qtyNum > 0;
      let errorMsg: string | undefined = undefined;
      if (!matchedProduct) {
        errorMsg = `Produk '${colProduct}' tidak ditemukan di gudang ini.`;
      } else if (qtyNum <= 0) {
        errorMsg = "Kuantitas harus lebih dari 0.";
      }

      return {
        raw: lineStr,
        query: colProduct,
        product: matchedProduct,
        qty: qtyNum,
        unit: matchedUnit,
        note: colNote,
        isValid,
        errorMsg,
      };
    });
  }, [pasteRawText, availableProducts]);

  function handleApplySpreadsheetRows() {
    const validRows = parsedSpreadsheetRows.filter((r) => r.isValid && r.product);
    if (validRows.length === 0) return;

    const newLines: FormLine[] = validRows.map((r) => ({
      id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      productId: r.product!.id,
      productName: r.product!.name,
      sku: r.product!.sku,
      tracking: r.product!.tracking,
      quantity: String(r.qty),
      unit: r.unit,
      serialsText: "",
      note: r.note,
      showSerials: r.product!.tracking === "SERIAL",
    }));

    if (pasteImportMode === "replace" || (lines.length === 1 && !lines[0].productId)) {
      setLines(newLines);
    } else {
      setLines((prev) => [...prev, ...newLines]);
    }

    setPasteModalOpen(false);
    setPasteRawText("");
    toast.push({
      tone: "success",
      title: "Data Spreadsheet Diimpor",
      description: `Berhasil menambahkan ${validRows.length} baris barang ke form Goods In.`,
    });
  }

  // Refs for click outside
  const sourceRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // Mobile Product Tooltip State (Long-press ~3 detik)
  const [mobileTooltip, setMobileTooltip] = useState<{
    name: string;
    sku: string;
  } | null>(null);

  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressTriggeredRef = useRef<boolean>(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartPosRef.current = null;
  }, []);

  const handleProductTouchStart = useCallback(
    (e: React.TouchEvent, prod: { name: string; sku: string }) => {
      clearLongPressTimer();
      isLongPressTriggeredRef.current = false;
      const t = e.touches[0];
      if (!t) return;
      touchStartPosRef.current = { x: t.clientX, y: t.clientY };

      longPressTimerRef.current = setTimeout(() => {
        isLongPressTriggeredRef.current = true;
        setMobileTooltip({ name: prod.name, sku: prod.sku });
        try {
          if (typeof window !== "undefined" && navigator.vibrate) {
            navigator.vibrate(40);
          }
        } catch { }
      }, 2500); // 2.5 detik long-press
    },
    [clearLongPressTimer]
  );

  const handleProductTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartPosRef.current) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = Math.abs(t.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(t.clientY - touchStartPosRef.current.y);
      // Batalkan long press jika digulir > 8px (pengguna sedang scroll dropdown)
      if (dx > 8 || dy > 8) {
        clearLongPressTimer();
      }
    },
    [clearLongPressTimer]
  );

  const handleProductTouchEnd = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (sourceRef.current && !sourceRef.current.contains(target)) {
        setSourceDropdownOpen(false);
      }

      // Dropdown produk tetap terbuka saat interaksi di dalam input pencarian, dropdown hasil, atau tooltip nama produk
      const inProductDropdown =
        target.closest(".gi-line-item__dropdown-wrap") ||
        target.closest(".gi-line-item__dropdown") ||
        target.closest(".gi-product-tooltip") ||
        target.closest(".gi-product-tooltip-overlay");

      if (!inProductDropdown) {
        setOpenProductDropdownIdx(null);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, []);

  // Keyboard Shortcuts Listener (Alt+A, Ctrl+S, Esc)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (mobileTooltip) {
          setMobileTooltip(null);
          clearLongPressTimer();
          e.preventDefault();
          return;
        }
        if (openProductDropdownIdx !== null) {
          setOpenProductDropdownIdx(null);
          e.preventDefault();
          return;
        }
        if (sourceDropdownOpen) {
          setSourceDropdownOpen(false);
          e.preventDefault();
          return;
        }
        if (pasteModalOpen) {
          setPasteModalOpen(false);
          e.preventDefault();
          return;
        }
        if (quickCreateModalOpen) {
          setQuickCreateModalOpen(false);
          e.preventDefault();
          return;
        }
        if (selectedTxDetail) {
          setSelectedTxDetail(null);
          e.preventDefault();
          return;
        }
        if (createModalOpen) {
          setCreateModalOpen(false);
          e.preventDefault();
          return;
        }
      }

      // Alt + A: Tambah baris baru
      if (e.altKey && (e.key === "a" || e.key === "A")) {
        if (createModalOpen && !quickCreateModalOpen && !pasteModalOpen) {
          e.preventDefault();
          setLines((prev) => [...prev, createEmptyGoodsInLine()]);
          return;
        }
      }

      // Ctrl + S: Simpan draft / pending
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (createModalOpen && !quickCreateModalOpen && !pasteModalOpen && !isSubmitting) {
          e.preventDefault();
          const formEl = document.getElementById("goods-in-form") as HTMLFormElement | null;
          if (formEl) {
            formEl.requestSubmit();
          }
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    createModalOpen,
    quickCreateModalOpen,
    pasteModalOpen,
    selectedTxDetail,
    openProductDropdownIdx,
    sourceDropdownOpen,
    isSubmitting,
  ]);

  // Lock body scroll when any modal or overlay is open so background page cannot scroll
  useEffect(() => {
    const isAnyModalOpen =
      createModalOpen ||
      !!selectedTxDetail ||
      quickCreateModalOpen ||
      pasteModalOpen ||
      confirmDeleteModalOpen ||
      confirmPostModalOpen;
    if (isAnyModalOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [
    createModalOpen,
    selectedTxDetail,
    quickCreateModalOpen,
    pasteModalOpen,
    confirmDeleteModalOpen,
    confirmPostModalOpen,
  ]);

  // Filtered suppliers based on search query
  const filteredSuppliers = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)
    );
  }, [suppliers, sourceSearch]);

  // Deteksi apakah nama pemasok yang diketik belum terdaftar di master pemasok
  const isNewSupplierDetected = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    if (!q) return false;
    if (selectedSupplierId) return false;
    return !suppliers.some(
      (s) =>
        s.name.toLowerCase() === q ||
        `${s.name} (${s.code})`.toLowerCase() === q ||
        s.code.toLowerCase() === q
    );
  }, [suppliers, sourceSearch, selectedSupplierId]);

  // Reset form — selalu reset ke tepat 1 baris item kosong
  function resetCreateForm() {
    setMobileTooltip(null);
    clearLongPressTimer();
    setRefNumber(generateSequenceRef(transactions.length));
    setReceivingDate(getTodayIso());
    setSourceSearch("");
    setSelectedSupplierId(null);
    setSourceDropdownOpen(false);
    setNotes("");
    setOpenProductDropdownIdx(null);
    setProductSearchQueries({});
    setLines([
      {
        id: `line-${Date.now()}`,
        productId: "",
        productName: "",
        sku: "",
        tracking: "NON_SERIAL",
        quantity: "1",
        unit: "pcs",
        serialsText: "",
        note: "",
        showSerials: false,
      },
    ]);
    setFormErrors({});
  }

  function handleOpenModal() {
    if (!lines || lines.length === 0) {
      resetCreateForm();
    }
    setCreateModalOpen(true);
  }

  const isGoodsInLineComplete = (l: FormLine) => Boolean(l.productId) && Number(l.quantity) > 0;
  const isAnyGoodsInLineIncomplete = lines.some((l) => !isGoodsInLineComplete(l));

  // Line item handlers: Menambah tepat 1 baris baru hanya jika baris saat ini sudah terisi lengkap
  function handleAddRow() {
    if (isAnyGoodsInLineIncomplete) {
      toast.push({
        tone: "warning",
        title: "Baris Belum Lengkap",
        description: "Harap pilih produk dan masukkan kuantitas pada baris saat ini sebelum menambah baris baru.",
      });
      return;
    }
    setLines((prev) => [...prev, createEmptyGoodsInLine()]);
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".gi-line-item__search-input");
      const lastInput = inputs[inputs.length - 1];
      lastInput?.focus();
    }, 60);
  }

  const handleGoodsInFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLElement;
      // Jangan cegah Enter di textarea internal notes agar user bisa membuat baris baru di teks
      if (target.tagName === "TEXTAREA") {
        return;
      }

      // Selalu cegah submit form langsung saat tekan Enter
      e.preventDefault();

      // Jika Enter ditekan di dalam tabel worksheet (baris produk)
      const tableRow = target.closest("tr.gi-table-row, .gi-line-item-card");
      if (tableRow) {
        const allRows = Array.from(document.querySelectorAll("tr.gi-table-row, .gi-line-item-card"));
        const rowIndex = allRows.indexOf(tableRow as HTMLElement);
        const currentLine = lines[rowIndex];

        const isCurrentLineValid = Boolean(currentLine?.productId) && Number(currentLine?.quantity) > 0;
        const allLinesValid = lines.every((l) => Boolean(l.productId) && Number(l.quantity) > 0);

        if (isCurrentLineValid && allLinesValid) {
          handleAddRow();
        } else {
          // Arahkan ke field yang kosong di baris saat ini
          if (!currentLine?.productId) {
            const searchInput = tableRow.querySelector<HTMLInputElement>(".gi-line-item__search-input");
            searchInput?.focus();
          } else if (!currentLine.quantity || Number(currentLine.quantity) <= 0) {
            const qtyInput = tableRow.querySelector<HTMLInputElement>(".gi-line-item__qty-num-input, input[type='number']");
            qtyInput?.focus();
          }
        }
        return;
      }

      // Jika Enter ditekan di bagian info transaksi (supplier, receiving date, dsb),
      // arahkan fokus langsung ke pencarian produk di baris pertama
      const firstSearchInput = document.querySelector<HTMLInputElement>(".gi-line-item__search-input");
      if (firstSearchInput) {
        firstSearchInput.focus();
      }
    }
  };

  // Menghapus baris: jika baris terakhir dihapus, tetap pertahankan 1 baris kosong
  function handleRemoveRow(index: number) {
    if (lines.length <= 1) {
      setLines([createEmptyGoodsInLine()]);
      setProductSearchQueries({});
      setOpenProductDropdownIdx(null);
      return;
    }

    setLines((prev) => prev.filter((_, i) => i !== index));

    setProductSearchQueries((prev) => {
      const next: Record<number, string> = {};
      let nextIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (i !== index) {
          if (prev[i] !== undefined) next[nextIdx] = prev[i];
          nextIdx++;
        }
      }
      return next;
    });

    if (openProductDropdownIdx === index) {
      setOpenProductDropdownIdx(null);
    } else if (openProductDropdownIdx !== null && openProductDropdownIdx > index) {
      setOpenProductDropdownIdx(openProductDropdownIdx - 1);
    }
  }

  function handleSelectProduct(index: number, prod: (typeof availableProducts)[0]) {
    setLines((prev) => {
      const copy = [...prev];
      if (!copy[index]) return prev;
      const currentUnit = copy[index].unit;
      const preserveUnit = currentUnit && currentUnit !== "pcs" ? currentUnit : (prod.unit || "pcs");
      copy[index] = {
        ...copy[index],
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        tracking: prod.tracking,
        unit: preserveUnit,
        showSerials: prod.tracking === "SERIAL",
      };
      return copy;
    });
    setOpenProductDropdownIdx(null);
    setProductSearchQueries((prev) => ({ ...prev, [index]: "" }));
  }

  function handleProductItemClick(
    lineIdx: number,
    prod: (typeof availableProducts)[0],
    e: React.MouseEvent
  ) {
    // Jika touch sebelumnya adalah long-press untuk melihat tooltip nama, abaikan klik pemilihan
    if (isLongPressTriggeredRef.current) {
      e.preventDefault();
      e.stopPropagation();
      isLongPressTriggeredRef.current = false;
      return;
    }
    setMobileTooltip(null);
    handleSelectProduct(lineIdx, prod);
  }

  // Quick Create Master Product Handlers
  function handleOpenQuickCreate(lineIdx: number, initialQuery: string) {
    setOpenProductDropdownIdx(null);
    setQuickCreateCallerLineIdx(lineIdx);
    setQuickCreateName(initialQuery.trim());
    setQuickCreateSku("");
    const callerLine = lines[lineIdx];
    const isCallerSerial = callerLine?.tracking === "SERIAL" || Boolean(callerLine?.serialsText?.trim());
    setQuickCreateTrackingMode(isCallerSerial ? "SERIAL" : "SERIAL");
    setQuickCreateUnit(callerLine?.unit || "pcs");
    setQuickCreateCategory("General");
    setQuickCreateError(null);
    setQuickCreateModalOpen(true);
  }

  async function handleSaveQuickCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = quickCreateName.trim();
    const trimmedSku = quickCreateSku.trim().toUpperCase();

    if (!trimmedName) {
      setQuickCreateError("Nama produk wajib diisi.");
      return;
    }
    if (!trimmedSku) {
      setQuickCreateError("SKU produk wajib diisi.");
      return;
    }

    const targetWhId = context.warehouseId || "wh-north";
    setIsQuickCreating(true);
    setQuickCreateError(null);

    try {
      const res = await createProductAction({
        warehouseId: targetWhId,
        name: trimmedName,
        sku: trimmedSku,
        category: quickCreateCategory.trim() || "General",
        trackingMode: quickCreateTrackingMode,
        unit: quickCreateUnit.trim() || "pcs",
        minStock: 0,
      });

      if (!res.success || !res.product) {
        setQuickCreateError(res.error || "Gagal membuat produk baru.");
        setIsQuickCreating(false);
        return;
      }

      const newProd = {
        id: res.product.id,
        name: res.product.name,
        sku: res.product.sku,
        tracking: res.product.trackingMode,
        unit: res.product.unit || quickCreateUnit || "pcs",
        warehouseId: res.product.warehouseId,
      };

      // Tambahkan ke katalog produk lokal
      setCatalogProducts((prev) => [newProd, ...prev]);

      // Pasang langsung ke baris pemanggil
      if (quickCreateCallerLineIdx !== null && quickCreateCallerLineIdx < lines.length) {
        handleSelectProduct(quickCreateCallerLineIdx, newProd);
      }

      setQuickCreateModalOpen(false);
      toast.push({
        tone: "success",
        title: "Master Produk Dibuat",
        description: `Produk "${newProd.name}" (${newProd.sku}) berhasil dibuat dengan pelacakan ${newProd.tracking === "SERIAL" ? "SERIAL" : "NON-SERIAL"} dan langsung dipilih pada baris ${(quickCreateCallerLineIdx ?? 0) + 1}.`,
      });
    } catch (err: unknown) {
      setQuickCreateError(err instanceof Error ? err.message : "Terjadi kesalahan saat membuat produk.");
    } finally {
      setIsQuickCreating(false);
    }
  }

  function handleUpdateLineField<K extends keyof FormLine>(index: number, field: K, value: FormLine[K]) {
    setLines((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  }

  function handleGenerateSerialsForLine(index: number) {
    const line = lines[index];
    const qty = Math.max(1, parseFloat(line.quantity) || 1);
    // 1 SN mewakili 1 unit operasional sesuai satuan penerimaan (misal 5 lusin = 5 SN)
    const operationalUnits = Math.max(1, Math.round(qty));

    const generated = generateRowSerials(context.warehouseId, line.sku, operationalUnits, index);
    handleUpdateLineField(index, "serialsText", generated.join("\n"));
  }

  // Filter transaksi table
  const warehouseTxs = useMemo(() => {
    return context.warehouseId
      ? transactions.filter((t) => t.warehouseId === context.warehouseId)
      : transactions;
  }, [transactions, context.warehouseId]);

  const filteredTxs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = warehouseTxs.filter((t) => {
      const matchSearch =
        !q ||
        t.reference.toLowerCase().includes(q) ||
        t.supplierName.toLowerCase().includes(q) ||
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

  const giFiltersKey = JSON.stringify([search, statusFilter, startDate, endDate]);
  const [prevGiFiltersKey, setPrevGiFiltersKey] = useState(giFiltersKey);
  if (giFiltersKey !== prevGiFiltersKey) {
    setPrevGiFiltersKey(giFiltersKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(filteredTxs.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedTxs = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredTxs.slice(start, start + PAGE_SIZE);
  }, [filteredTxs, safePage]);

  // Validasi
  function validateReceipt(): { isValid: boolean; parsedLines: ParsedGoodsInLineItem[] } {
    const errors: Record<string, string> = {};
    if (!refNumber.trim()) errors.refNumber = "Nomor referensi wajib diisi.";
    if (!selectedSupplierId && !sourceSearch.trim()) {
      errors.supplier = "Pemasok / Source wajib dipilih.";
    }

    const parsedLines: ParsedGoodsInLineItem[] = [];
    const usedSerials = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.productId) {
        errors[`line_${i}_product`] = "Pilih produk pada baris ini.";
        continue;
      }

      const qtyNum = parseFloat(line.quantity);
      if (isNaN(qtyNum) || qtyNum <= 0) {
        errors[`line_${i}_qty`] = "Kuantitas harus > 0.";
        continue;
      }

      let serialsList: string[] | undefined = undefined;
      if (line.tracking === "SERIAL") {
        // 1 SN mewakili 1 unit operasional sesuai satuan penerimaan (misal 5 lusin = 5 SN, bukan 60 SN)
        const requiredSnCount = Math.max(1, Math.round(qtyNum));
        const rawList = line.serialsText
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);

        // Jika user belum mengisi SN atau jumlah tidak sesuai
        if (rawList.length > 0 && rawList.length !== requiredSnCount) {
          errors[`line_${i}_serials`] = `Harap lengkapi tepat ${requiredSnCount} SN untuk ${line.quantity} ${line.unit} (terisi: ${rawList.length}).`;
        }

        for (const sn of rawList) {
          const upper = sn.toUpperCase();
          if (usedSerials.has(upper)) {
            errors[`line_${i}_serials`] = `Serial Number '${sn}' duplikat dalam form ini.`;
            break;
          }
          usedSerials.add(upper);
        }

        serialsList = rawList.length === requiredSnCount ? rawList : undefined;
      }

      parsedLines.push({
        id: line.id,
        productId: line.productId,
        quantity: qtyNum,
        unit: line.unit,
        serials: serialsList,
        note: line.note.trim() || undefined,
      });
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return { isValid: false, parsedLines: [] };
    }

    setFormErrors({});
    return { isValid: true, parsedLines };
  }

  function handleStartEditPending(tx: GoodsInTransaction) {
    setEditingPendingTx(tx);
    setRefNumber(tx.reference);
    setReceivingDate(tx.date);
    setSelectedSupplierId(tx.supplierId || null);
    setSourceSearch(tx.supplierName || "");
    setNotes(tx.notes || "");
    if (tx.items && tx.items.length > 0) {
      setLines(
        tx.items.map((item, idx) => ({
          id: `line-${idx + 1}-${Date.now()}`,
          productId: item.productId,
          productName: item.productName,
          sku: item.sku,
          tracking: (item.tracking as "SERIAL" | "NON_SERIAL") || "NON_SERIAL",
          quantity: String(item.qty || 1),
          unit: item.unit || "pcs",
          serialsText: item.serials ? item.serials.join("\n") : "",
          note: "",
          showSerials: item.tracking === "SERIAL" || Boolean(item.serials && item.serials.length > 0),
        }))
      );
    } else {
      setLines([createEmptyGoodsInLine()]);
    }
    setSelectedTxDetail(null);
    setCreateModalOpen(true);
  }

  function handleCloseCreateModal() {
    setCreateModalOpen(false);
    setEditingPendingTx(null);
    setRefNumber(generateSequenceRef(transactions.length));
    setReceivingDate(getTodayIso());
    setSelectedSupplierId(null);
    setSourceSearch("");
    setNotes("");
    setLines([createEmptyGoodsInLine()]);
    setFormErrors({});
    setMobileTooltip(null);
    clearLongPressTimer();
  }

  // Submit as PENDING (Draft or Edit)
  async function handleSaveAsPending(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    const { isValid, parsedLines } = validateReceipt();
    if (!isValid) return;

    setIsSubmitting(true);
    const targetWhId = context.warehouseId || "wh-north";
    const sup = suppliers.find((s) => s.id === selectedSupplierId);

    try {
      if (editingPendingTx) {
        // Edit existing pending transaction
        const res = await updateGoodsInPendingAction({
          goodsInId: editingPendingTx.id,
          supplierId: selectedSupplierId || undefined,
          supplierName: !selectedSupplierId ? sourceSearch.trim() : undefined,
          documentNumber: refNumber.trim(),
          documentDate: receivingDate,
          note: notes.trim() || undefined,
          lines: parsedLines,
        });

        if (!res.success) {
          toast.push({
            tone: "danger",
            title: "Gagal Menyimpan Perubahan",
            description: res.error || "Gagal memperbarui transaksi.",
          });
          setIsSubmitting(false);
          return;
        }

        let finalSupplierId = selectedSupplierId ?? "";
        let finalSupplierName = sup ? sup.name : sourceSearch.trim() || "Pemasok";

        if ("newSupplier" in res && res.newSupplier) {
          const createdSup: Partner = {
            id: res.newSupplier.id,
            ownerId: "current-owner",
            type: "SUPPLIER",
            name: res.newSupplier.name,
            code: res.newSupplier.code,
            phone: "-",
            email: "-",
            address: "-",
            status: "ACTIVE",
          };
          setSuppliers((prev) => [createdSup, ...prev.filter((p) => p.id !== createdSup.id)]);
          finalSupplierId = res.newSupplier.id;
          finalSupplierName = res.newSupplier.name;
        }

        const updatedTx: GoodsInTransaction = {
          ...editingPendingTx,
          reference: refNumber.trim(),
          supplierId: finalSupplierId,
          supplierName: finalSupplierName,
          date: receivingDate,
          notes: notes.trim() || undefined,
          items: lines.map((l) => ({
            productId: l.productId,
            productName: l.productName || "Produk",
            sku: l.sku,
            tracking: l.tracking,
            qty: parseFloat(l.quantity) || 1,
            unit: l.unit,
            serials: l.serialsText
              ? l.serialsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
              : undefined,
          })),
        };

        setTransactions((prev) =>
          prev.map((t) => (t.id === editingPendingTx.id ? updatedTx : t))
        );
        handleCloseCreateModal();
        toast.push({
          tone: "success",
          title: "Perubahan Disimpan",
          description: "newSupplier" in res && res.newSupplier
            ? `Dokumen ${updatedTx.reference} diperbarui dan pemasok "${res.newSupplier.name}" (${res.newSupplier.code}) otomatis didaftarkan.`
            : `Dokumen ${updatedTx.reference} berhasil diperbarui.`,
        });
      } else {
        // Create new pending
        const res = await createGoodsInPendingAction({
          warehouseId: targetWhId,
          supplierId: selectedSupplierId || undefined,
          supplierName: !selectedSupplierId ? sourceSearch.trim() : undefined,
          documentNumber: refNumber.trim(),
          documentDate: receivingDate,
          note: notes.trim() || undefined,
          lines: parsedLines,
        });

        if (!res.success) {
          toast.push({
            tone: "danger",
            title: "Gagal Menyimpan Draft",
            description: res.error || "Gagal menyimpan transaksi.",
          });
          setIsSubmitting(false);
          return;
        }

        let finalSupplierId = selectedSupplierId ?? "";
        let finalSupplierName = sup ? sup.name : sourceSearch.trim() || "Pemasok";

        if ("newSupplier" in res && res.newSupplier) {
          const createdSup: Partner = {
            id: res.newSupplier.id,
            ownerId: "current-owner",
            type: "SUPPLIER",
            name: res.newSupplier.name,
            code: res.newSupplier.code,
            phone: "-",
            email: "-",
            address: "-",
            status: "ACTIVE",
          };
          setSuppliers((prev) => [createdSup, ...prev.filter((p) => p.id !== createdSup.id)]);
          finalSupplierId = res.newSupplier.id;
          finalSupplierName = res.newSupplier.name;
        }

        const generatedId = "goodsInId" in res ? (res.goodsInId as string) : `gi-${Date.now()}`;
        const newTx: GoodsInTransaction = {
          id: generatedId,
          reference: refNumber.trim(),
          warehouseId: targetWhId,
          warehouseName: context.warehouseName ?? "Gudang Utama",
          supplierId: finalSupplierId,
          supplierName: finalSupplierName,
          date: receivingDate,
          status: "PENDING",
          createdBy: context.email,
          notes: notes.trim() || undefined,
          items: lines.map((l) => ({
            productId: l.productId,
            productName: l.productName || "Produk",
            sku: l.sku,
            tracking: l.tracking,
            qty: parseFloat(l.quantity) || 1,
            unit: l.unit,
            serials: l.serialsText
              ? l.serialsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
              : undefined,
          })),
        };

        setTransactions((prev) => [newTx, ...prev]);
        handleCloseCreateModal();
        toast.push({
          tone: "success",
          title: "Disimpan sebagai Pending",
          description: "newSupplier" in res && res.newSupplier
            ? `Dokumen ${newTx.reference} disimpan sebagai Pending dan pemasok "${res.newSupplier.name}" (${res.newSupplier.code}) otomatis didaftarkan.`
            : `Dokumen ${newTx.reference} berhasil disimpan sebagai draft PENDING.`,
        });
      }
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: "Kesalahan Sistem",
        description: err instanceof Error ? err.message : "Gagal menyimpan transaksi.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Post existing pending
  async function handlePostPendingTx(tx: GoodsInTransaction) {
    if (isPostingPending) return;
    setIsPostingPending(true);
    try {
      const res = await postPendingGoodsInAction(tx.id);
      if (!res.success) {
        toast.push({
          tone: "danger",
          title: "Gagal Memposting",
          description: res.error || "Gagal memposting transaksi pending.",
        });
        setIsPostingPending(false);
        return;
      }

      setTransactions((prev) =>
        prev.map((t) => (t.id === tx.id ? { ...t, status: "POSTED" } : t))
      );
      if (selectedTxDetail && selectedTxDetail.id === tx.id) {
        setSelectedTxDetail((prev) => (prev ? { ...prev, status: "POSTED" } : null));
        // Refresh serial status setelah diposting
        try {
          const res = await getGoodsInSerialsStatusAction(tx.id);
          if (res.success && res.data) {
            setSerialsStatusData(res.data);
          }
        } catch { }
      }

      toast.push({
        tone: "success",
        title: "Transaksi Diposting",
        description: `Dokumen ${tx.reference} berhasil diposting ke ledger inventaris. Anda sekarang dapat mendaftarkan Serial Number untuk unit yang diterima.`,
      });
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: "Kesalahan Sistem",
        description: err instanceof Error ? err.message : "Gagal memposting transaksi.",
      });
    } finally {
      setIsPostingPending(false);
    }
  }

  async function handleOpenTxDetail(t: GoodsInTransaction, tab: "items" | "serials" = "items") {
    setSelectedTxDetail(t);
    setDetailActiveTab(tab);
    setSerialsStatusData(null);
    setRegError(null);
    setActiveRegLineId(null);
    setShowAssignPanel(false);
    setAssignmentDrafts([]);
    setAssignError(null);
    setSelectedItemChecks({});
    setExpandedSerialItemKeys({});

    if (t.status === "POSTED") {
      setIsLoadingSerialsStatus(true);
      try {
        const res = await getGoodsInSerialsStatusAction(t.id);
        if (res.success && res.data) {
          setSerialsStatusData(res.data);
        }
      } catch (e) {
        console.error("Gagal memuat status serial:", e);
      } finally {
        setIsLoadingSerialsStatus(false);
      }
    }
  }

  // Items yang eligible untuk diberi nomor serial pada transaksi aktif
  const detailEligibleItems = useMemo(() => {
    if (!selectedTxDetail) return [];

    return selectedTxDetail.items.map((item, idx) => {
      const itemId = (item as { id?: string }).id;
      const serverLine = serialsStatusData?.lines.find(
        (l) => (itemId && l.lineId === itemId) || l.productId === item.productId
      );

      const lineId = serverLine?.lineId || itemId || item.productId || `line-${idx}`;
      const mult = getUnitMultiplier(item.unit);
      const requiredUnits = serverLine ? serverLine.requiredUnits : Math.round(Number(item.qty) || 1);
      const registeredSerials = serverLine
        ? serverLine.serials.map((s) => s.serialNumber)
        : (item.serials || []);
      const registeredCount = registeredSerials.length;
      const remainingQty = Math.max(0, requiredUnits - registeredCount);

      return {
        lineId,
        itemKey: lineId,
        productId: item.productId,
        productName: item.productName,
        sku: item.sku,
        qty: item.qty,
        unit: item.unit,
        multiplier: mult,
        requiredUnits,
        registeredCount,
        remainingQty,
        serials: registeredSerials,
        tracking: item.tracking,
      };
    });
  }, [selectedTxDetail, serialsStatusData]);

  // Cari item pertama yang masih belum lengkap nomor serialnya
  function getFirstAvailableItem(currentDrafts: typeof assignmentDrafts) {
    for (const it of detailEligibleItems) {
      if (it.remainingQty <= 0) continue;
      const draftedCount = currentDrafts.filter((d) => d.itemKey === it.itemKey).length;
      if (draftedCount < it.remainingQty) {
        return it;
      }
    }
    return null;
  }

  function handleToggleAssignPanel() {
    if (showAssignPanel) {
      setShowAssignPanel(false);
      setAssignmentDrafts([]);
      setAssignError(null);
      return;
    }

    const firstAvailable = getFirstAvailableItem([]);
    if (!firstAvailable) {
      toast.push({
        tone: "info",
        title: "Nomor Serial Lengkap",
        description: "Semua item pada dokumen barang masuk ini sudah memiliki nomor serial lengkap.",
      });
      return;
    }

    setShowAssignPanel(true);
    setAssignError(null);
    setAssignmentDrafts([
      {
        _key: `draft-${Date.now()}-0`,
        itemKey: firstAvailable.itemKey,
        serialNumber: "",
        serialUnit: firstAvailable.unit, // Terkunci otomatis sesuai satuan penerimaan awal
      },
    ]);
  }

  function handleAddDraftRow() {
    const nextAvailable = getFirstAvailableItem(assignmentDrafts);
    if (!nextAvailable) {
      toast.push({
        tone: "warning",
        title: "Kuantitas Maksimal",
        description: "Jumlah nomor serial yang diisi sudah mencukupi seluruh sisa unit.",
      });
      return;
    }

    const newKey = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setAssignmentDrafts((prev) => [
      ...prev,
      {
        _key: newKey,
        itemKey: nextAvailable.itemKey,
        serialNumber: "",
        serialUnit: nextAvailable.unit, // Terkunci otomatis sesuai satuan item
      },
    ]);
  }

  function handleGenerateAutoSerials(targetKey: string) {
    if (!selectedTxDetail) return;
    const whCode = context.warehouseId ? context.warehouseId.replace("wh-", "").toUpperCase() : "WH";
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    const newDrafts: typeof assignmentDrafts = [];
    const targets =
      targetKey === "all"
        ? detailEligibleItems.filter((it) => it.remainingQty > 0)
        : detailEligibleItems.filter((it) => it.itemKey === targetKey && it.remainingQty > 0);

    let globalSeq = 1;
    for (const it of targets) {
      const skuCode = it.sku ? it.sku.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "ITEM";
      for (let i = 0; i < it.remainingQty; i++) {
        const seqStr = String(globalSeq).padStart(3, "0");
        const sn = `SN-${whCode}-${skuCode}-${dateStr}-${seqStr}`;
        newDrafts.push({
          _key: `auto-${it.itemKey}-${i}-${Date.now()}`,
          itemKey: it.itemKey,
          serialNumber: sn,
          serialUnit: it.unit,
        });
        globalSeq++;
      }
    }

    if (newDrafts.length === 0) {
      toast.push({
        tone: "info",
        title: "Tidak Ada Item Tersisa",
        description: "Target item yang dipilih sudah memiliki nomor serial lengkap.",
      });
      return;
    }

    setAssignmentDrafts(newDrafts);
    setAssignError(null);
  }

  async function handleSaveSerials() {
    if (!selectedTxDetail) return;
    if (assignmentDrafts.length === 0) {
      setAssignError("Belum ada nomor serial yang diisi.");
      return;
    }

    // Validasi ada input kosong
    const emptyDraft = assignmentDrafts.find((d) => !d.serialNumber.trim());
    if (emptyDraft) {
      setAssignError("Mohon isi nomor serial pada semua baris yang ditambahkan.");
      return;
    }

    // Validasi duplikasi lokal
    const seen = new Set<string>();
    for (const d of assignmentDrafts) {
      const normalized = d.serialNumber.trim().toUpperCase();
      if (seen.has(normalized)) {
        setAssignError(`Terdapat nomor serial duplikat di dalam form: ${d.serialNumber}`);
        return;
      }
      seen.add(normalized);
    }

    setIsSubmittingSerials(true);
    setAssignError(null);

    try {
      // Kelompokkan per itemKey
      const grouped: Record<string, string[]> = {};
      for (const d of assignmentDrafts) {
        if (!grouped[d.itemKey]) grouped[d.itemKey] = [];
        grouped[d.itemKey].push(d.serialNumber.trim());
      }

      for (const [lineId, snList] of Object.entries(grouped)) {
        const res = await registerGoodsInSerialsAction({
          goodsInId: selectedTxDetail.id,
          lineId,
          serialNumbers: snList,
        });

        if (!res.success) {
          throw new Error(res.error || `Gagal mendaftarkan nomor serial untuk baris ${lineId}`);
        }
      }

      // Refresh data status serial dari server
      const statusRes = await getGoodsInSerialsStatusAction(selectedTxDetail.id);
      if (statusRes.success && statusRes.data) {
        setSerialsStatusData(statusRes.data);
      }

      // Update data di local selectedTxDetail
      setSelectedTxDetail((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          items: prev.items.map((it, idx) => {
            const lineId = (it as { id?: string }).id || it.productId || `line-${idx}`;
            const added = grouped[lineId] || [];
            if (added.length > 0) {
              return {
                ...it,
                tracking: "SERIAL" as const,
                serials: [...(it.serials || []), ...added],
              };
            }
            return it;
          }),
        };
      });

      // Update list transaksi
      setTransactions((prev) =>
        prev.map((t) => {
          if (t.id === selectedTxDetail.id) {
            return {
              ...t,
              items: t.items.map((it, idx) => {
                const lineId = (it as { id?: string }).id || it.productId || `line-${idx}`;
                const added = grouped[lineId] || [];
                if (added.length > 0) {
                  return {
                    ...it,
                    tracking: "SERIAL" as const,
                    serials: [...(it.serials || []), ...added],
                  };
                }
                return it;
              }),
            };
          }
          return t;
        })
      );

      toast.push({
        tone: "success",
        title: "Nomor Serial Disimpan",
        description: `Berhasil mendaftarkan ${assignmentDrafts.length} nomor serial untuk gudang ${context.warehouseName ?? "Gudang Aktif"}.`,
      });

      setShowAssignPanel(false);
      setAssignmentDrafts([]);
    } catch (err: unknown) {
      setAssignError(err instanceof Error ? err.message : "Gagal mendaftarkan Serial Number.");
    } finally {
      setIsSubmittingSerials(false);
    }
  }

  async function handleRegisterLineSerials(lineId: string, requiredUnits: number) {
    if (!selectedTxDetail) return;
    const rawText = lineSnInput[lineId] ?? "";
    const list = rawText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (list.length === 0) {
      setRegError("Masukkan minimal satu nomor seri (SN) untuk didaftarkan.");
      return;
    }

    setIsRegisteringSn(true);
    setRegError(null);

    try {
      const res = await registerGoodsInSerialsAction({
        goodsInId: selectedTxDetail.id,
        lineId,
        serialNumbers: list,
      });

      if (!res.success) {
        setRegError(res.error || "Gagal mendaftarkan Serial Number.");
        setIsRegisteringSn(false);
        return;
      }

      toast.push({
        tone: "success",
        title: "Serial Number Terdaftar",
        description: `Berhasil mendaftarkan ${res.registeredCount} unit Serial Number. Total terdaftar: ${res.totalRegistered} dari ${requiredUnits} unit.`,
      });

      setLineSnInput((prev) => ({ ...prev, [lineId]: "" }));
      setActiveRegLineId(null);

      // Refresh serials status
      const refresh = await getGoodsInSerialsStatusAction(selectedTxDetail.id);
      if (refresh.success && refresh.data) {
        setSerialsStatusData(refresh.data);
      }
    } catch (err: unknown) {
      setRegError(err instanceof Error ? err.message : "Terjadi kesalahan saat mendaftarkan SN.");
    } finally {
      setIsRegisteringSn(false);
    }
  }

  function handleAutoGenerateLineSerials(lineId: string, sku: string, count: number) {
    const generated = generateBatchSerials(context.warehouseId, sku, count);

    setLineSnInput((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ? prev[lineId] + "\n" : "") + generated.join("\n"),
    }));
  }

  // Kolom Tabel Transaksi Halaman Utama
  const columns: Column<GoodsInTransaction>[] = [
    {
      key: "reference",
      header: "Referensi Dokumen",
      sortable: true,
      cell: (t) => (
        <div>
          <button
            type="button"
            onClick={() => handleOpenTxDetail(t, "items")}
            className="font-mono text-xs font-semibold text-primary hover:underline"
          >
            {t.reference}
          </button>
          <p className="text-xs text-text-secondary">{t.date}</p>
        </div>
      ),
    },
    {
      key: "supplier",
      header: "Pemasok / Source",
      cell: (t) => <span className="font-medium text-text-primary">{t.supplierName}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => {
        let tone: "info" | "success" | "warning" | "neutral" = "neutral";
        if (t.status === "POSTED") tone = "success";
        if (t.status === "PENDING") tone = "warning";
        return (
          <StatusBadge tone={tone}>
            {t.status === "POSTED" ? "POSTED" : "PENDING"}
          </StatusBadge>
        );
      },
    },
    {
      key: "actions",
      header: "Aksi",
      cell: (t) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleOpenTxDetail(t, "items")}
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
              title="Edit transaksi pending ini"
            >
              Edit
            </Button>
          )}
          {t.status === "POSTED" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleStartReturnSupplier(t)}
              loading={isLoadingReturnSerials && returnTargetTx?.id === t.id}
              className="text-xs text-amber-600 dark:text-amber-400 font-medium inline-flex items-center gap-1"
              title="Retur ke Supplier dari dokumen penerimaan ini"
            >
              <RotateCcwIcon className="h-3.5 w-3.5" />
              Retur ke Supplier
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Barang Masuk (Goods In)"
        description="Penerimaan stok dari pemasok atau manufaktur ke gudang yang ditugaskan."
        actions={
          <Button variant="primary" onClick={handleOpenModal}>
            + Terima Barang Masuk
          </Button>
        }
      />

      <Alert tone="info" title="Aturan Transaksi Barang Masuk (V2.4.1)">
        Status <strong>POSTED</strong> langsung mencatat immutable ledger dan menambah saldo fisik di database SQLite. Status <strong>PENDING</strong> menyimpan rencana penerimaan barang line-by-line sebelum verifikasi fisik final.
      </Alert>

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
              placeholder="Cari referensi dokumen, pemasok, atau SKU..."
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
              <option value="POSTED">Diposting (POSTED)</option>
              <option value="PENDING">Draft Menunggu (PENDING)</option>
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
            {filteredTxs.length} transaksi
          </span>
        </div>
      </div>

      {/* Tabel Transaksi */}
      <div className="rounded-lg border border-border bg-surface">
        <DataTable
          caption="Daftar transaksi penerimaan barang masuk"
          columns={columns}
          rows={pagedTxs}
          getRowId={(t) => t.id}
          onRowClick={(t) => handleOpenTxDetail(t, "items")}
        />
        {filteredTxs.length > 0 && (
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filteredTxs.length}
            onPageChange={setPage}
          />
        )}
      </div>

      {/* =========================================================
          NEW GOODS IN MODAL (Sesuai Referensi yang Diminta)
         ========================================================= */}
      {createModalOpen && (
        <div
          className="gi-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gi-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseCreateModal();
          }}
        >
          <section className="gi-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="gi-modal__header gi-modal__header--create">
              <div className="gi-modal__header-title-box">
                <h2 id="gi-modal-title" className="gi-modal__title">
                  {editingPendingTx ? "Edit Barang Masuk (Pending)" : "New Goods In"}
                </h2>
                <p className="gi-modal__subtitle">
                  {editingPendingTx
                    ? `Perbarui rincian transaksi, produk, kuantitas, atau nomor seri untuk dokumen ${editingPendingTx.reference}.`
                    : "Add incoming stock line by line. Serial numbers are assigned after you complete this receipt."}
                </p>
              </div>

              <div className="gi-modal__header-controls">
                {/* Switcher Satuan Konversi Per Gudang */}
                <div
                  className="gi-unit-switcher"
                  title={`Preferensi satuan konversi untuk ${context.warehouseName || "Gudang Aktif"} (tersimpan untuk Staff & Owner)`}
                >
                  <span className="gi-unit-switcher__label">
                    Satuan:
                  </span>
                  <div className="gi-unit-switcher__buttons">
                    <button
                      type="button"
                      className={`gi-unit-switcher__btn ${conversionUnit === "pcs" ? "gi-unit-switcher__btn--active" : ""
                        }`}
                      onClick={() => handleChangeConversionUnit("pcs")}
                    >
                      PCS
                    </button>
                    <button
                      type="button"
                      className={`gi-unit-switcher__btn ${conversionUnit === "lusin" ? "gi-unit-switcher__btn--active" : ""
                        }`}
                      onClick={() => handleChangeConversionUnit("lusin")}
                    >
                      Lusin
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="gi-modal__close-btn"
                onClick={handleCloseCreateModal}
                aria-label="Tutup modal"
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
                  className="lucide lucide-x"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18"></path>
                  <path d="m6 6 12 12"></path>
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="gi-modal__body">
              <form id="goods-in-form" noValidate onSubmit={handleSaveAsPending} onKeyDown={handleGoodsInFormKeyDown}>
                {/* Transaction Details Card */}
                <div className="gi-modal__info-card">
                  <h4 className="gi-modal__info-title">Transaction Details</h4>
                  <div className="gi-modal__info-grid">
                    {/* Reference No */}
                    <div className="gi-modal__field">
                      <label className="gi-modal__field-label">Reference No.</label>
                      <input
                        type="text"
                        className="input gi-input"
                        disabled
                        readOnly
                        value={refNumber}
                      />
                      <p className="gi-modal__field-subtext">
                        Unique sequence WH/IN/YYYYMMDD/000X
                      </p>
                    </div>

                    {/* Source / Supplier */}
                    <div className="gi-modal__field">
                      <label className="gi-modal__field-label">Source / Supplier *</label>
                      <div className="gi-source__wrap" ref={sourceRef}>
                        <div className="gi-source__input-wrap">
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
                            className="lucide lucide-search gi-source__search-icon"
                            aria-hidden="true"
                          >
                            <path d="m21 21-4.34-4.34"></path>
                            <circle cx="11" cy="11" r="8"></circle>
                          </svg>
                          <input
                            type="text"
                            className="input gi-input gi-source__input"
                            placeholder="Ketik atau pilih nama pemasok..."
                            autoComplete="off"
                            value={sourceSearch}
                            onFocus={() => setSourceDropdownOpen(true)}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSourceSearch(val);
                              const exact = suppliers.find(
                                (s) =>
                                  s.name.toLowerCase() === val.trim().toLowerCase() ||
                                  `${s.name} (${s.code})`.toLowerCase() === val.trim().toLowerCase()
                              );
                              setSelectedSupplierId(exact ? exact.id : null);
                              setSourceDropdownOpen(true);
                            }}
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
                            className="lucide lucide-chevron-down gi-source__chevron"
                            aria-hidden="true"
                          >
                            <path d="m6 9 6 6 6-6"></path>
                          </svg>
                        </div>

                        {sourceDropdownOpen && (
                          <div className="gi-source__dropdown">
                            {isNewSupplierDetected && (
                              <button
                                type="button"
                                className="gi-source__dropdown-item bg-primary-soft/40 hover:bg-primary-soft/70 border-b border-border"
                                onClick={() => {
                                  setSelectedSupplierId(null);
                                  setSourceDropdownOpen(false);
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
                                  <span>Pemasok Baru: &ldquo;{sourceSearch.trim()}&rdquo;</span>
                                </span>
                              </button>
                            )}
                            {filteredSuppliers.length > 0 ? (
                              filteredSuppliers.map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  className="gi-source__dropdown-item"
                                  onClick={() => {
                                    setSelectedSupplierId(s.id);
                                    setSourceSearch(`${s.name} (${s.code})`);
                                    setSourceDropdownOpen(false);
                                  }}
                                >
                                  <span className="font-medium text-text-primary">{s.name}</span>
                                  <span className="font-mono text-[11px] text-text-secondary bg-surface-muted px-1 rounded">
                                    {s.code}
                                  </span>
                                </button>
                              ))
                            ) : !isNewSupplierDetected ? (
                              <div className="p-3 text-xs text-text-secondary text-center">
                                Pemasok tidak ditemukan.
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                      {formErrors.supplier && (
                        <p className="text-[11px] font-semibold text-danger mt-1">{formErrors.supplier}</p>
                      )}
                    </div>

                    {/* Receiving Date */}
                    <div className="gi-modal__field">
                      <label className="gi-modal__field-label">
                        Receiving Date <span className="text-text-secondary/60 font-normal text-[11px]">(Dapat diedit)</span>
                      </label>
                      <input
                        type="date"
                        className="input gi-input cursor-pointer hover:border-primary transition-colors"
                        required
                        value={receivingDate}
                        onChange={(e) => setReceivingDate(e.target.value)}
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
                        title="Klik untuk memilih atau mengubah tanggal penerimaan"
                      />
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="gi-modal__field gi-modal__field--full">
                    <label className="gi-modal__field-label">Notes</label>
                    <textarea
                      className="input gi-input gi-modal__notes"
                      placeholder="Internal notes (optional)"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    ></textarea>
                  </div>
                </div>

                {/* Worksheet (Items) */}
                <div className="gi-modal__worksheet" ref={tableRef}>
                  <div className="gi-modal__items-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <h4 className="gi-modal__items-title">Items</h4>
                      <span className="gi-modal__items-count-badge">
                        {lines.length} {lines.length === 1 ? "item" : "items"}
                        {totalConvertedPcs > 0 && ` • Total: ${totalConvertedPcs} pcs`}
                      </span>
                    </div>
                    <div className="gi-modal__items-header-actions">
                      <button
                        type="button"
                        className="gi-modal__add-row-btn"
                        onClick={() => {
                          setPasteRawText("");
                          setPasteModalOpen(true);
                        }}
                        title="Salin baris dari spreadsheet/Excel dan tempel sekaligus"
                        style={{
                          background: "var(--color-surface)",
                          borderColor: "var(--color-border)",
                          color: "var(--color-text-primary)",
                        }}
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
                        className={`gi-modal__add-row-btn ${isAnyGoodsInLineIncomplete ? "opacity-50 cursor-not-allowed" : ""}`}
                        onClick={handleAddRow}
                        disabled={isAnyGoodsInLineIncomplete}
                        title={isAnyGoodsInLineIncomplete ? "Harap lengkapi produk dan kuantitas baris saat ini terlebih dahulu" : "Tambah Baris (Shortcut: Alt + A)"}
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
                          className="lucide lucide-plus"
                          aria-hidden="true"
                        >
                          <path d="M5 12h14"></path>
                          <path d="M12 5v14"></path>
                        </svg>
                        <span>Add Row <span className="opacity-70 text-[10px] font-mono hidden sm:inline">(Alt+A)</span></span>
                      </button>
                    </div>
                  </div>

                  {/* Desktop Table View */}
                  <div className="gi-modal__table-desktop">
                    <div className="gi-modal__table-wrapper">
                      <table className="gi-modal__table">
                        <colgroup>
                          <col style={{ width: "36px" }} />
                          <col style={{ width: "34%" }} />
                          <col style={{ width: "16%" }} />
                          <col style={{ width: "24%" }} />
                          <col style={{ width: "18%" }} />
                          <col style={{ width: "36px" }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th scope="col" className="gi-th--center">
                              #
                            </th>
                            <th scope="col">Product Name *</th>
                            <th scope="col">SKU</th>
                            <th scope="col">Quantity</th>
                            <th scope="col" className="gi-th--right">
                              Total ({conversionUnit === "lusin" ? "Lusin" : "PCS"})
                            </th>
                            <th scope="col"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((line, idx) => {
                            const isDropdownOpen = openProductDropdownIdx === idx;
                            const query = (productSearchQueries[idx] ?? "").toLowerCase();
                            const matchingProducts = availableProducts.filter(
                              (p) =>
                                !query ||
                                p.name.toLowerCase().includes(query) ||
                                p.sku.toLowerCase().includes(query)
                            );

                            return (
                              <tr key={line.id} className="gi-table-row">
                                <td
                                  style={{
                                    textAlign: "center",
                                    verticalAlign: "middle",
                                    color: "var(--color-text-secondary)",
                                    fontFamily: "monospace",
                                    fontSize: "11px",
                                  }}
                                >
                                  {idx + 1}
                                </td>
                                <td>
                                  <div className="gi-line-item__dropdown-wrap">
                                    <div className="gi-line-item__search-input-wrap">
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
                                        className="lucide lucide-search gi-line-item__search-icon"
                                        aria-hidden="true"
                                      >
                                        <path d="m21 21-4.34-4.34"></path>
                                        <circle cx="11" cy="11" r="8"></circle>
                                      </svg>
                                      <input
                                        type="text"
                                        className="input gi-input gi-line-item__search-input"
                                        placeholder="Search product name or SKU..."
                                        autoComplete="off"
                                        value={
                                          isDropdownOpen
                                            ? productSearchQueries[idx] ?? ""
                                            : line.productName
                                        }
                                        onFocus={() => {
                                          setOpenProductDropdownIdx(idx);
                                          setProductSearchQueries((prev) => ({
                                            ...prev,
                                            [idx]: "",
                                          }));
                                        }}
                                        onChange={(e) => {
                                          setProductSearchQueries((prev) => ({
                                            ...prev,
                                            [idx]: e.target.value,
                                          }));
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            const q = (productSearchQueries[idx] ?? "").trim().toLowerCase();
                                            const exact = matchingProducts.find(
                                              (p) => p.sku.toLowerCase() === q || p.name.toLowerCase() === q
                                            );
                                            if (exact) {
                                              handleSelectProduct(idx, exact);
                                              return;
                                            }
                                            if (matchingProducts.length === 1) {
                                              handleSelectProduct(idx, matchingProducts[0]);
                                              return;
                                            }
                                            if (line.productId && !q) {
                                              handleAddRow();
                                              return;
                                            }
                                            if (q && matchingProducts.length === 0) {
                                              handleOpenQuickCreate(idx, q);
                                              return;
                                            }
                                          }
                                        }}
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
                                        className="lucide lucide-chevron-down gi-line-item__search-chevron"
                                        aria-hidden="true"
                                      >
                                        <path d="m6 9 6 6 6-6"></path>
                                      </svg>
                                    </div>

                                    {isDropdownOpen && (
                                      <div className={`gi-line-item__dropdown ${idx >= lines.length - 2 && lines.length > 3 ? "gi-line-item__dropdown--upward" : ""}`}>
                                        {matchingProducts.length > 0 ? (
                                          matchingProducts.map((p) => (
                                            <button
                                              key={p.id}
                                              type="button"
                                              className="gi-line-item__dropdown-item"
                                              title={`${p.name} (${p.sku})`}
                                              onTouchStart={(e) => handleProductTouchStart(e, p)}
                                              onTouchMove={handleProductTouchMove}
                                              onTouchEnd={handleProductTouchEnd}
                                              onTouchCancel={clearLongPressTimer}
                                              onClick={(e) => handleProductItemClick(idx, p, e)}
                                            >
                                              <span
                                                className="gi-line-item__dropdown-item-name"
                                                title={p.name}
                                              >
                                                {p.name}
                                              </span>
                                              <span className="gi-line-item__dropdown-item-sku">
                                                {p.sku}
                                              </span>
                                            </button>
                                          ))
                                        ) : (
                                          <div className="gi-line-item__dropdown-empty">
                                            <span className="gi-line-item__dropdown-empty-text">
                                              Produk tidak ditemukan.
                                            </span>
                                            <button
                                              type="button"
                                              className="gi-line-item__quick-create-btn"
                                              onClick={() =>
                                                handleOpenQuickCreate(idx, productSearchQueries[idx] ?? "")
                                              }
                                            >
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
                                                <path d="M5 12h14"></path>
                                                <path d="M12 5v14"></path>
                                              </svg>
                                              <span>+ Tambah Produk Baru</span>
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="gi-modal__table td">
                                  <input
                                    type="text"
                                    className="input gi-input gi-line-item__sku-disabled"
                                    placeholder="Auto-filled"
                                    disabled
                                    value={line.sku}
                                  />
                                </td>
                                <td className="gi-modal__table td">
                                  <div className="gi-line-item__qty-select-wrap">
                                    <input
                                      type="number"
                                      step="any"
                                      min="0.01"
                                      className="input gi-input gi-line-item__qty-num-input"
                                      value={line.quantity}
                                      onChange={(e) =>
                                        handleUpdateLineField(idx, "quantity", e.target.value)
                                      }
                                    />
                                    <select
                                      className="input select gi-input gi-line-item__qty-unit-select"
                                      value={line.unit}
                                      onChange={(e) =>
                                        handleUpdateLineField(idx, "unit", e.target.value)
                                      }
                                    >
                                      {SUPPORTED_UNITS.map((u) => (
                                        <option key={u.key} value={u.key}>
                                          {u.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </td>
                                <td className="gi-modal__table td" style={{ textAlign: "right", verticalAlign: "middle" }}>
                                  {(() => {
                                    const qtyNum = parseFloat(line.quantity);
                                    const convText = formatConversionDisplay(qtyNum, line.unit, conversionUnit);
                                    if (!convText) {
                                      return (
                                        <span className="text-text-secondary font-mono text-xs">
                                          —
                                        </span>
                                      );
                                    }
                                    return (
                                      <span className="inline-flex items-center justify-end font-mono text-xs font-semibold text-primary bg-surface-muted border border-border px-2 py-1 rounded select-all">
                                        {convText}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td className="gi-modal__table td" style={{ textAlign: "center", verticalAlign: "middle" }}>
                                  {lines.length > 1 && (
                                    <button
                                      type="button"
                                      className="gi-line-item__remove-btn"
                                      onClick={() => handleRemoveRow(idx)}
                                      title="Hapus baris"
                                    >
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
                                        className="lucide lucide-trash"
                                        aria-hidden="true"
                                      >
                                        <path d="M3 6h18"></path>
                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                      </svg>
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Mobile Cards View (Dirombak Menjadi Ergonomis & Nyaman di Layar HP) */}
                  <div className="gi-modal__cards-mobile">
                    {lines.map((line, idx) => {
                      const isDropdownOpen = openProductDropdownIdx === idx;
                      const query = (productSearchQueries[idx] ?? "").toLowerCase();
                      const matchingProducts = availableProducts.filter(
                        (p) =>
                          !query ||
                          p.name.toLowerCase().includes(query) ||
                          p.sku.toLowerCase().includes(query)
                      );

                      const qtyNum = parseFloat(line.quantity);
                      const convText = formatConversionDisplay(qtyNum, line.unit, conversionUnit);

                      return (
                        <div key={line.id} className="gi-line-item-card">
                          {/* Header Kartu: Nomor Urut & SKU Badge & Hapus */}
                          <div className="gi-line-item-card__header">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-text-primary bg-surface-muted px-2 py-0.5 rounded border border-border">
                                #{idx + 1}
                              </span>
                              {line.sku ? (
                                <span className="font-mono text-[11px] font-semibold text-text-secondary bg-surface-muted border border-border px-1.5 py-0.5 rounded">
                                  {line.sku}
                                </span>
                              ) : (
                                <span className="text-[11px] text-text-secondary italic">
                                  Pilih produk
                                </span>
                              )}
                            </div>
                            {lines.length > 1 && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-xs text-danger font-medium hover:underline p-1 -mr-1"
                                onClick={() => handleRemoveRow(idx)}
                                title="Hapus baris ini"
                              >
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
                                  <path d="M3 6h18"></path>
                                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                </svg>
                                <span>Hapus</span>
                              </button>
                            )}
                          </div>

                          {/* Field Pencarian Produk */}
                          <div className="gi-line-item-card__field">
                            <label className="gi-line-item-card__label">Pilih Produk *</label>
                            <div className="gi-line-item__dropdown-wrap">
                              <div className="gi-line-item__search-input-wrap">
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
                                  className="lucide lucide-search gi-line-item__search-icon"
                                  aria-hidden="true"
                                >
                                  <path d="m21 21-4.34-4.34"></path>
                                  <circle cx="11" cy="11" r="8"></circle>
                                </svg>
                                <input
                                  type="text"
                                  className="input gi-input gi-line-item__search-input"
                                  placeholder="Cari nama produk atau SKU..."
                                  autoComplete="off"
                                  value={
                                    isDropdownOpen
                                      ? productSearchQueries[idx] ?? ""
                                      : line.productName
                                  }
                                  onFocus={() => {
                                    setOpenProductDropdownIdx(idx);
                                    setProductSearchQueries((prev) => ({
                                      ...prev,
                                      [idx]: "",
                                    }));
                                  }}
                                  onChange={(e) => {
                                    setProductSearchQueries((prev) => ({
                                      ...prev,
                                      [idx]: e.target.value,
                                    }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      const q = (productSearchQueries[idx] ?? "").trim().toLowerCase();
                                      const exact = matchingProducts.find(
                                        (p) => p.sku.toLowerCase() === q || p.name.toLowerCase() === q
                                      );
                                      if (exact) {
                                        handleSelectProduct(idx, exact);
                                        return;
                                      }
                                      if (matchingProducts.length === 1) {
                                        handleSelectProduct(idx, matchingProducts[0]);
                                        return;
                                      }
                                      if (line.productId && !q) {
                                        handleAddRow();
                                        return;
                                      }
                                      if (q && matchingProducts.length === 0) {
                                        handleOpenQuickCreate(idx, q);
                                        return;
                                      }
                                    }
                                  }}
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
                                  className="lucide lucide-chevron-down gi-line-item__search-chevron"
                                  aria-hidden="true"
                                >
                                  <path d="m6 9 6 6 6-6"></path>
                                </svg>
                              </div>

                              {isDropdownOpen && (
                                <div className="gi-line-item__dropdown">
                                  {matchingProducts.length > 0 ? (
                                    matchingProducts.map((p) => (
                                      <button
                                        key={p.id}
                                        type="button"
                                        className="gi-line-item__dropdown-item"
                                        title={`${p.name} (${p.sku})`}
                                        onTouchStart={(e) => handleProductTouchStart(e, p)}
                                        onTouchMove={handleProductTouchMove}
                                        onTouchEnd={handleProductTouchEnd}
                                        onTouchCancel={clearLongPressTimer}
                                        onClick={(e) => handleProductItemClick(idx, p, e)}
                                      >
                                        <span
                                          className="gi-line-item__dropdown-item-name"
                                          title={p.name}
                                        >
                                          {p.name}
                                        </span>
                                        <span className="gi-line-item__dropdown-item-sku">
                                          {p.sku}
                                        </span>
                                      </button>
                                    ))
                                  ) : (
                                    <div className="gi-line-item__dropdown-empty">
                                      <span className="gi-line-item__dropdown-empty-text">
                                        Produk tidak ditemukan.
                                      </span>
                                      <button
                                        type="button"
                                        className="gi-line-item__quick-create-btn"
                                        onClick={() =>
                                          handleOpenQuickCreate(idx, productSearchQueries[idx] ?? "")
                                        }
                                      >
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
                                          <path d="M5 12h14"></path>
                                          <path d="M12 5v14"></path>
                                        </svg>
                                        <span>+ Tambah Produk Baru</span>
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Grid 2 Kolom: Kuantitas & Satuan */}
                          <div className="gi-line-item-card__grid">
                            <div className="gi-line-item-card__field">
                              <label className="gi-line-item-card__label">Kuantitas</label>
                              <input
                                type="number"
                                step="any"
                                min="0.01"
                                className="input gi-input text-center font-semibold"
                                value={line.quantity}
                                onChange={(e) =>
                                  handleUpdateLineField(idx, "quantity", e.target.value)
                                }
                              />
                            </div>
                            <div className="gi-line-item-card__field">
                              <label className="gi-line-item-card__label">Satuan</label>
                              <select
                                className="input select gi-input"
                                value={line.unit}
                                onChange={(e) =>
                                  handleUpdateLineField(idx, "unit", e.target.value)
                                }
                              >
                                {SUPPORTED_UNITS.map((u) => (
                                  <option key={u.key} value={u.key}>
                                    {u.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* Ekuivalen Konversi Satuan */}
                          {convText && (
                            <div className="gi-line-item-card__conv-badge">
                              <span className="text-text-secondary text-[11px]">Ekuivalen:</span>
                              <span className="font-mono font-semibold text-primary">
                                {convText}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Tombol Tambah Baris Bawah di Mobile */}
                    <button
                      type="button"
                      className={`w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border border-dashed border-border-strong bg-surface hover:bg-surface-muted text-xs font-semibold text-text-primary transition-colors cursor-pointer ${isAnyGoodsInLineIncomplete ? "opacity-50 cursor-not-allowed" : ""}`}
                      onClick={handleAddRow}
                      disabled={isAnyGoodsInLineIncomplete}
                      title={isAnyGoodsInLineIncomplete ? "Harap lengkapi produk dan kuantitas baris saat ini terlebih dahulu" : "Tambah Baris"}
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
                        className="lucide lucide-plus"
                        aria-hidden="true"
                      >
                        <path d="M5 12h14"></path>
                        <path d="M12 5v14"></path>
                      </svg>
                      <span>+ Tambah Baris Produk</span>
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {/* Footer */}
            <div className="gi-modal__footer">
              <button
                type="button"
                className="btn btn-secondary btn-md"
                onClick={handleCloseCreateModal}
              >
                Batal
              </button>
              <button
                type="submit"
                form="goods-in-form"
                className="btn btn-primary btn-md gi-modal__footer-btn-submit"
                disabled={isSubmitting || isPendingDisabled}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide lucide-check"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5"></path>
                </svg>
                <span>
                  {isSubmitting
                    ? "Menyimpan..."
                    : editingPendingTx
                    ? "Simpan Perubahan"
                    : "Save as Pending"}
                </span>
              </button>
            </div>

            {/* Popover / Tooltip Nama Produk Lengkap Khusus Mobile (Long-Press ~2.5 - 3s) */}
            {mobileTooltip && (
              <div
                className="gi-product-tooltip-overlay"
                onClick={() => setMobileTooltip(null)}
              >
                <div
                  className="gi-product-tooltip"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Detail Produk"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="gi-product-tooltip__header">
                    <span className="gi-product-tooltip__title">Detail Produk</span>
                    <button
                      type="button"
                      className="gi-product-tooltip__close-btn"
                      onClick={() => setMobileTooltip(null)}
                      aria-label="Tutup"
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
                      >
                        <path d="M18 6 6 18"></path>
                        <path d="m6 6 12 12"></path>
                      </svg>
                    </button>
                  </div>
                  <div className="gi-product-tooltip__body">
                    <p className="gi-product-tooltip__name">{mobileTooltip.name}</p>
                    <div className="gi-product-tooltip__meta">
                      <span className="gi-product-tooltip__sku-label">SKU:</span>
                      <span className="gi-product-tooltip__sku">{mobileTooltip.sku}</span>
                    </div>
                  </div>
                  <div className="gi-product-tooltip__footer">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setMobileTooltip(null)}
                    >
                      Tutup
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* MODAL DETAIL BARANG MASUK SESUAI REFERENSI USER */}
      {selectedTxDetail && (
        <div
          className="gi-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gi-detail-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedTxDetail(null);
          }}
        >
          <div className="gi-detail-modal gi-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="gi-modal__header">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 id="gi-detail-title" className="gi-modal__title">
                    Detail Barang Masuk
                  </h2>
                  <span className="inline-flex items-center px-2 py-0.5 rounded font-mono text-xs font-semibold bg-surface-muted text-text-secondary border border-border">
                    {selectedTxDetail.reference}
                  </span>
                </div>
                <span className="text-xs text-text-secondary">
                  Informasi penerimaan barang dan pencatatan serial number gudang
                </span>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                <StatusBadge
                  tone={
                    selectedTxDetail.status === "POSTED"
                      ? "success"
                      : selectedTxDetail.status === "PENDING"
                      ? "warning"
                      : "neutral"
                  }
                >
                  {selectedTxDetail.status === "POSTED" ? "Selesai" : "Pending"}
                </StatusBadge>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  title="Cetak Dokumen Barang Masuk"
                  onClick={() => window.print()}
                  className="hidden sm:inline-flex items-center gap-1.5"
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
                    className="lucide lucide-printer"
                    aria-hidden="true"
                  >
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                    <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path>
                    <rect x="6" y="14" width="12" height="8" rx="1"></rect>
                  </svg>
                  <span>Cetak Dokumen</span>
                </Button>
                <button
                  type="button"
                  className="gi-modal__close-btn"
                  onClick={() => setSelectedTxDetail(null)}
                  aria-label="Tutup detail modal"
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
                    className="lucide lucide-x"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18"></path>
                    <path d="m6 6 12 12"></path>
                  </svg>
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="gi-modal__body">
              {/* Card Detail Transaksi */}
              <div className="gi-modal__info-card">
                <h4 className="gi-modal__info-title">Detail Transaksi</h4>
                <div className="gi-modal__info-grid">
                  <div className="gi-modal__field">
                    <span className="gi-modal__field-label">Tanggal</span>
                    <input
                      type="text"
                      className="input"
                      disabled
                      readOnly
                      value={selectedTxDetail.date}
                    />
                  </div>
                  <div className="gi-modal__field">
                    <span className="gi-modal__field-label">Sumber</span>
                    <input
                      type="text"
                      className="input"
                      disabled
                      readOnly
                      value={selectedTxDetail.supplierName}
                    />
                  </div>
                  <div className="gi-modal__field gi-modal__field--full">
                    <span className="gi-modal__field-label">Catatan</span>
                    <textarea
                      className="input gi-modal__notes"
                      disabled
                      readOnly
                      value={selectedTxDetail.notes || "—"}
                    />
                  </div>
                </div>
              </div>

              {/* Worksheet Area */}
              <div className="gi-modal__worksheet">
                <div className="gi-detail__items-header">
                  <div className="gi-detail__items-title-group">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-barcode gi-detail__icon-muted"
                      aria-hidden="true"
                    >
                      <path d="M3 5v14"></path>
                      <path d="M8 5v14"></path>
                      <path d="M12 5v14"></path>
                      <path d="M17 5v14"></path>
                      <path d="M21 5v14"></path>
                    </svg>
                    <h4 className="gi-modal__items-title">Item Diterima</h4>
                    <span className="chip gi-detail__items-count">
                      {detailEligibleItems.length} items
                    </span>
                  </div>
                  <div className="gi-detail__items-actions">
                    {selectedTxDetail.status === "POSTED" && (
                      <Button
                        type="button"
                        size="sm"
                        variant={showAssignPanel ? "secondary" : "primary"}
                        onClick={handleToggleAssignPanel}
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
                          className="lucide lucide-plus"
                          aria-hidden="true"
                        >
                          <path d="M5 12h14"></path>
                          <path d="M12 5v14"></path>
                        </svg>
                        <span>
                          {showAssignPanel ? "Tutup Panel Serial" : "Tambah Nomor Serial"}
                        </span>
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => window.print()}
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
                        className="lucide lucide-printer"
                        aria-hidden="true"
                      >
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                        <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path>
                        <rect x="6" y="14" width="12" height="8" rx="1"></rect>
                      </svg>
                      <span>Cetak Semua Label</span>
                    </Button>
                  </div>
                </div>

                {/* INLINE SERIAL NUMBER ASSIGNMENT PANEL */}
                {showAssignPanel && (
                  <div className="gi-detail__assign-panel">
                    {/* Toolbar */}
                    <div className="gi-detail__assign-toolbar">
                      <div className="gi-detail__segmented">
                        <button
                          type="button"
                          className={`gi-detail__seg-btn ${assignMode === "manual" ? "gi-detail__seg-btn--active" : ""}`}
                          onClick={() => setAssignMode("manual")}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          className={`gi-detail__seg-btn ${assignMode === "auto" ? "gi-detail__seg-btn--active" : ""}`}
                          onClick={() => setAssignMode("auto")}
                        >
                          Auto Generate
                        </button>
                      </div>

                      <div className="gi-detail__assign-controls">
                        {assignMode === "auto" && (
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                              Target:
                            </span>
                            <select
                              className="input select h-9 text-xs px-3 py-1 rounded-md border border-border bg-surface text-text-primary"
                              value={autoTargetItemKey}
                              onChange={(e) => setAutoTargetItemKey(e.target.value)}
                            >
                              <option value="all">Semua Item ({detailEligibleItems.length})</option>
                              {detailEligibleItems.map((item) => (
                                <option key={item.itemKey} value={item.itemKey}>
                                  {item.productName} ({item.remainingQty} {item.unit} sisa)
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => handleGenerateAutoSerials(autoTargetItemKey)}
                              className="inline-flex items-center gap-1.5 shrink-0"
                            >
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
                                <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"></path>
                                <path d="m14 7 3 3"></path>
                              </svg>
                              <span>Generate Serial Number</span>
                            </Button>
                          </div>
                        )}
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface border border-border text-xs text-text-secondary">
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
                            className="text-text-secondary"
                            aria-hidden="true"
                          >
                            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                            <polyline points="9 22 9 12 15 12 15 22"></polyline>
                          </svg>
                          <span>Gudang: <strong className="text-text-primary">{context.warehouseName ?? "Gudang Utama"}</strong></span>
                        </span>
                      </div>
                    </div>

                    {assignError && (
                      <Alert tone="danger" title="Perhatian">
                        {assignError}
                      </Alert>
                    )}

                    {/* Progress Bar */}
                    {(() => {
                      const totalUnitsRequired = detailEligibleItems.reduce(
                        (sum, it) => sum + it.requiredUnits,
                        0
                      );
                      const totalUnitsRegistered = detailEligibleItems.reduce(
                        (sum, it) => sum + it.registeredCount,
                        0
                      );
                      const totalDraftedUnits = assignmentDrafts.length;
                      const currentProgress = totalUnitsRegistered + totalDraftedUnits;
                      const progressPct =
                        totalUnitsRequired > 0
                          ? Math.min(100, Math.round((currentProgress / totalUnitsRequired) * 100))
                          : 100;

                      return (
                        <div className="gi-detail__progress-wrap">
                          <div className="gi-detail__progress-header">
                            <div className="gi-detail__progress-label">
                              <span className="gi-detail__progress-title">Progres Pengisian:</span>
                              <span className="gi-detail__progress-count">
                                {currentProgress} / {totalUnitsRequired} unit ({totalDraftedUnits} serial di form)
                              </span>
                            </div>
                            <span className="gi-detail__progress-percent">{progressPct}%</span>
                          </div>
                          <div className="gi-detail__progress-track">
                            <div
                              className="gi-detail__progress-fill"
                              style={{ width: `${progressPct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Headers Desktop */}
                    <div className="gi-detail__assign-headers">
                      <div className="gi-detail__assign-header--item">Item yang Diterima</div>
                      <div className="gi-detail__assign-header--unit">Satuan</div>
                      <div className="gi-detail__assign-header--serial">Nomor Serial</div>
                      <div className="gi-detail__assign-header--action"></div>
                    </div>

                    {/* Rows Assign */}
                    <div className="gi-detail__assign-rows">
                      {assignmentDrafts.map((draft, idx) => {
                        return (
                          <div key={draft._key} className="gi-detail__assign-row">
                            <div className="flex-row-desktop">
                              {/* Item Dropdown: Otomatis memilih item yang belum lengkap SN-nya */}
                              <div className="gi-detail__assign-field">
                                <select
                                  className="input select text-xs h-8"
                                  value={draft.itemKey}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    const chosen = detailEligibleItems.find((it) => it.itemKey === val);
                                    setAssignmentDrafts((current) =>
                                      current.map((d, i) =>
                                        i === idx
                                          ? {
                                            ...d,
                                            itemKey: val,
                                            serialUnit: chosen ? chosen.unit : d.serialUnit,
                                          }
                                          : d
                                      )
                                    );
                                  }}
                                >
                                  <option value="">Pilih item</option>
                                  {detailEligibleItems.map((it) => (
                                    <option key={it.itemKey} value={it.itemKey}>
                                      {it.productName} ({it.qty} {it.unit}) - {it.sku} (sisa: {it.remainingQty} {it.unit})
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Satuan: Terkunci otomatis sesuai satuan awal */}
                              <div className="gi-detail__assign-field--unit">
                                <select
                                  className="input select text-xs h-8 bg-surface-muted cursor-not-allowed"
                                  disabled
                                  value={draft.serialUnit}
                                >
                                  {SUPPORTED_UNITS.map((u) => (
                                    <option key={u.key} value={u.key}>
                                      {u.key} {u.multiplier > 1 ? `(${u.multiplier} pcs)` : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {/* Input Serial */}
                              <div className="gi-detail__assign-field--serial">
                                <input
                                  type="text"
                                  className="input text-xs font-mono h-8 uppercase"
                                  placeholder="Masukkan nomor serial"
                                  value={draft.serialNumber}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setAssignmentDrafts((current) =>
                                      current.map((d, i) => (i === idx ? { ...d, serialNumber: val } : d))
                                    );
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      handleAddDraftRow();
                                    }
                                  }}
                                  autoFocus={idx === assignmentDrafts.length - 1}
                                />
                              </div>

                              {/* Tombol Hapus Baris */}
                              <div className="gi-detail__assign-field--remove">
                                <button
                                  type="button"
                                  className="gi-line-item__remove-btn"
                                  disabled={assignmentDrafts.length <= 1}
                                  onClick={() =>
                                    setAssignmentDrafts((current) => current.filter((_, i) => i !== idx))
                                  }
                                  title="Hapus baris serial"
                                >
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
                                    aria-hidden="true"
                                  >
                                    <path d="M10 11v6"></path>
                                    <path d="M14 11v6"></path>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
                                    <path d="M3 6h18"></path>
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                  </svg>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Bottom Action Bar */}
                    <div className="gi-detail__assign-bottom">
                      <button
                        type="button"
                        className="gi-detail__add-row-dashed"
                        onClick={handleAddDraftRow}
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
                        <span>Tambah Nomor Serial</span>
                      </button>

                      <div className="gi-detail__assign-bottom-actions">
                        <span className="gi-detail__bottom-status-pill">
                          {assignmentDrafts.length} Terisi
                        </span>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleSaveSerials}
                          disabled={isSubmittingSerials || assignmentDrafts.length === 0}
                        >
                          {isSubmittingSerials ? "Menyimpan..." : "Simpan Semua Nomor Serial"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Tabel Desktop Item Diterima */}
                <div className="gi-modal__table-desktop">
                  <div className="gi-modal__table-wrapper">
                    <table className="gi-modal__table">
                      <colgroup>
                        <col style={{ width: "4%" }} />
                        <col style={{ width: "5%" }} />
                        <col style={{ width: "36%" }} />
                        <col style={{ width: "17%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "14%" }} />
                        <col style={{ width: "12%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              title="Pilih Semua"
                              style={{ cursor: "pointer" }}
                              checked={
                                detailEligibleItems.length > 0 &&
                                detailEligibleItems.every((it) => selectedItemChecks[it.itemKey])
                              }
                              onChange={(e) => {
                                const checked = e.target.checked;
                                const next: Record<string, boolean> = {};
                                detailEligibleItems.forEach((it) => {
                                  next[it.itemKey] = checked;
                                });
                                setSelectedItemChecks(next);
                              }}
                            />
                          </th>
                          <th style={{ textAlign: "center" }}>No</th>
                          <th>Produk</th>
                          <th>SKU</th>
                          <th>Tracking</th>
                          <th>Nomor Serial</th>
                          <th style={{ textAlign: "right" }}>Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailEligibleItems.map((item, idx) => {
                          const hasSerials = item.serials && item.serials.length > 0;
                          const isExpanded = Boolean(expandedSerialItemKeys[item.itemKey]);
                          return (
                            <React.Fragment key={item.itemKey}>
                              <tr
                                className={`transition-colors ${hasSerials
                                    ? "cursor-pointer hover:bg-surface-muted/60"
                                    : "cursor-default"
                                  } ${isExpanded ? "bg-surface-muted/40" : ""}`}
                                onClick={() => {
                                  if (hasSerials) toggleExpandSerials(item.itemKey);
                                }}
                                title={
                                  hasSerials
                                    ? isExpanded
                                      ? "Klik untuk menutup nomor serial"
                                      : "Klik untuk melihat nomor serial"
                                    : undefined
                                }
                              >
                                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    title="Pilih barang"
                                    style={{ cursor: "pointer" }}
                                    checked={Boolean(selectedItemChecks[item.itemKey])}
                                    onChange={(e) =>
                                      setSelectedItemChecks((prev) => ({
                                        ...prev,
                                        [item.itemKey]: e.target.checked,
                                      }))
                                    }
                                  />
                                </td>
                                <td className="gi-detail__td-number">
                                  {String(idx + 1).padStart(2, "0")}
                                </td>
                                <td className="gi-detail__td-name--parent">
                                  <div className="flex items-center gap-1.5">
                                    <span>{item.productName}</span>
                                    {hasSerials && (
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className={`text-text-secondary transition-transform duration-150 ${isExpanded ? "rotate-180" : ""
                                          }`}
                                        aria-hidden="true"
                                      >
                                        <path d="m6 9 6 6 6-6"></path>
                                      </svg>
                                    )}
                                  </div>
                                </td>
                                <td className="gi-detail__td-sku">{item.sku}</td>
                                <td>
                                  <span className="chip-sm rounded bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                                    {hasSerials ? "Serial" : "Normal"}
                                  </span>
                                </td>
                                <td>
                                  {hasSerials ? (
                                    <button
                                      type="button"
                                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium transition-colors ${isExpanded
                                          ? "border-primary bg-surface-muted text-text-primary"
                                          : "border-border bg-surface-muted text-text-secondary hover:text-text-primary"
                                        }`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleExpandSerials(item.itemKey);
                                      }}
                                      title="Klik untuk melihat/sembunyikan nomor serial"
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="lucide lucide-barcode"
                                        aria-hidden="true"
                                      >
                                        <path d="M3 5v14"></path>
                                        <path d="M8 5v14"></path>
                                        <path d="M12 5v14"></path>
                                        <path d="M17 5v14"></path>
                                        <path d="M21 5v14"></path>
                                      </svg>
                                      <span>{item.serials.length} Serial</span>
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="11"
                                        height="11"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""
                                          }`}
                                        aria-hidden="true"
                                      >
                                        <path d="m6 9 6 6 6-6"></path>
                                      </svg>
                                    </button>
                                  ) : (
                                    <span className="text-text-secondary font-mono text-xs">—</span>
                                  )}
                                </td>
                                <td className="gi-detail__td-qty">
                                  {item.qty} {item.unit}
                                </td>
                              </tr>
                              {hasSerials && isExpanded && (
                                <tr className="gi-detail__serials-subrow">
                                  <td colSpan={7}>
                                    <div className="gi-detail__serials-subrow-box">
                                      <div className="gi-detail__serials-subrow-header">
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                                            Nomor Serial Terdaftar ({item.serials.length} unit):
                                          </span>
                                          <span className="text-xs text-text-primary font-medium">
                                            {item.productName} ({item.sku})
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          className="text-xs font-medium text-primary hover:underline"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            navigator.clipboard.writeText(item.serials.join("\n"));
                                            toast.push({
                                              tone: "success",
                                              title: "Berhasil Disalin",
                                              description: `${item.serials.length} nomor serial telah disalin ke clipboard.`,
                                            });
                                          }}
                                        >
                                          Salin Semua ({item.serials.length})
                                        </button>
                                      </div>
                                      <div className="gi-detail__serials-chip-grid">
                                        {item.serials.map((sn, sIdx) => (
                                          <span key={sIdx} className="gi-detail__serial-chip">
                                            <span>{sn}</span>
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
                </div>

                {/* Kartu Mobile Item Diterima */}
                <div className="gi-modal__cards-mobile">
                  {detailEligibleItems.map((item, idx) => {
                    const hasSerials = item.serials && item.serials.length > 0;
                    const isExpanded = Boolean(expandedSerialItemKeys[item.itemKey]);
                    return (
                      <div key={item.itemKey} className="gi-line-item-card gi-detail__card--normal">
                        <div className="flex items-center justify-between border-b border-border pb-1.5 mb-1.5">
                          <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-semibold">
                            <input
                              type="checkbox"
                              checked={Boolean(selectedItemChecks[item.itemKey])}
                              onChange={(e) =>
                                setSelectedItemChecks((prev) => ({
                                  ...prev,
                                  [item.itemKey]: e.target.checked,
                                }))
                              }
                            />
                            <span>Pilih Barang Ini</span>
                          </label>
                        </div>
                        <div className="gi-line-item-card__field">
                          <label className="gi-line-item-card__label">No / Product</label>
                          <div className="gi-detail__card-product">
                            #{idx + 1} - {item.productName}
                          </div>
                        </div>
                        <div className="gi-line-item-card__grid grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="gi-line-item-card__label">SKU</label>
                            <div className="font-mono">{item.sku}</div>
                          </div>
                          <div>
                            <label className="gi-line-item-card__label">Tracking</label>
                            <div>{hasSerials ? "Serial" : "Normal"}</div>
                          </div>
                        </div>
                        <div className="gi-line-item-card__field">
                          <label className="gi-line-item-card__label">Jumlah</label>
                          <div className="text-xs">
                            <strong>{item.qty}</strong> {item.unit}
                          </div>
                        </div>
                        {hasSerials && (
                          <div className="gi-line-item-card__field">
                            <button
                              type="button"
                              className="mt-1 inline-flex items-center justify-between w-full rounded border border-border bg-surface-muted px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-surface transition-colors"
                              onClick={() => toggleExpandSerials(item.itemKey)}
                            >
                              <span className="flex items-center gap-1.5">
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
                                <span>
                                  {isExpanded ? "Sembunyikan" : "Lihat"} {item.serials.length} Nomor Serial
                                </span>
                              </span>
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
                                className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""
                                  }`}
                                aria-hidden="true"
                              >
                                <path d="m6 9 6 6 6-6"></path>
                              </svg>
                            </button>
                            {isExpanded && (
                              <div className="flex flex-wrap gap-1 pt-2 max-h-36 overflow-y-auto">
                                {item.serials.map((s, sIdx) => (
                                  <span
                                    key={sIdx}
                                    className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-primary"
                                  >
                                    <span className="text-[9px] text-text-secondary">{sIdx + 1}.</span>
                                    {s}
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

            {/* Footer */}
            <div className="gi-modal__footer">
              <div className="flex items-center gap-2">
                {/* Tombol Hapus: Khusus Owner atau Dokumen PENDING */}
                {(context.role === "OWNER" || selectedTxDetail.status === "PENDING") && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmDeleteModalOpen(true)}
                    disabled={isDeleting}
                    title="Hapus transaksi barang masuk ini"
                  >
                    Hapus
                  </Button>
                )}

                {/* Tombol Edit untuk status PENDING */}
                {selectedTxDetail.status === "PENDING" && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={() => handleStartEditPending(selectedTxDetail)}
                    className="inline-flex items-center gap-1.5"
                    title="Ubah rincian produk, kuantitas, atau nomor seri untuk transaksi ini"
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
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                      <path d="m15 5 4 4"></path>
                    </svg>
                    <span>Edit Transaksi</span>
                  </Button>
                )}

                {/* Tombol Selesaikan untuk status PENDING */}
                {selectedTxDetail.status === "PENDING" && (
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={() => setConfirmPostModalOpen(true)}
                    disabled={isPostingPending}
                  >
                    Selesaikan Barang Masuk
                  </Button>
                )}

                {/* Tombol Return untuk status POSTED */}
                {selectedTxDetail.status === "POSTED" && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={handleInitiateReturn}
                    className="inline-flex items-center gap-1.5"
                    title="Buat Return untuk barang dari dokumen ini"
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
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                      <path d="M3 3v5h5"></path>
                    </svg>
                    <span>
                      {Object.values(selectedItemChecks).filter(Boolean).length > 0
                        ? `Return (${Object.values(selectedItemChecks).filter(Boolean).length})`
                        : "Return"}
                    </span>
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => window.print()}
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
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                    <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"></path>
                    <rect x="6" y="14" width="12" height="8" rx="1"></rect>
                  </svg>
                  <span>Cetak Dokumen</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => setSelectedTxDetail(null)}
                >
                  Tutup
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* POPUP KONFIRMASI SELESAIKAN BARANG MASUK (PENDING -> POSTED) */}
      <Dialog
        open={confirmPostModalOpen}
        onClose={() => {
          if (!isPostingPending) setConfirmPostModalOpen(false);
        }}
        title="Selesaikan Barang Masuk?"
        description="Pastikan fisik barang dan kuantitas sudah dicek secara menyeluruh sebelum menyelesaikan transaksi."
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-border bg-surface-muted p-3 text-xs flex flex-col gap-2">
            <div className="flex justify-between">
              <span className="text-text-secondary">Referensi Dokumen:</span>
              <span className="font-mono font-semibold text-text-primary">
                {selectedTxDetail?.reference}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Pemasok / Sumber:</span>
              <span className="font-medium text-text-primary">
                {selectedTxDetail?.supplierName}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Jumlah Item Diterima:</span>
              <span className="font-semibold text-text-primary">
                {selectedTxDetail?.items.length} jenis produk
              </span>
            </div>
          </div>

          <p className="text-xs text-text-secondary">
            Setelah diselesaikan, transaksi akan resmi berstatus <strong>POSTED</strong>, stok fisik produk
            akan langsung dicatat ke ledger dan bertambah ke saldo gudang ini.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmPostModalOpen(false)}
              disabled={isPostingPending}
            >
              Gak Jadi
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={async () => {
                if (selectedTxDetail) {
                  await handlePostPendingTx(selectedTxDetail);
                  setConfirmPostModalOpen(false);
                }
              }}
              disabled={isPostingPending}
              loading={isPostingPending}
              loadingLabel="Menyelesaikan..."
            >
              Ya, Selesaikan
            </Button>
          </div>
        </div>
      </Dialog>

      {/* POPUP KONFIRMASI HAPUS TRANSAKSI (KHUSUS OWNER) */}
      <Dialog
        open={confirmDeleteModalOpen}
        onClose={() => {
          if (!isDeleting) setConfirmDeleteModalOpen(false);
        }}
        title="Hapus Transaksi Barang Masuk?"
        description={`Apakah Anda yakin ingin menghapus transaksi ${selectedTxDetail?.reference}? Dokumen ini akan dihapus dari daftar aktif.`}
      >
        <div className="flex flex-col gap-4">
          <Alert tone="danger" title="Perhatian">
            Tindakan ini akan menghapus transaksi dari daftar aktif gudang ini dan dicatat ke jejak audit sistem.
          </Alert>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmDeleteModalOpen(false)}
              disabled={isDeleting}
            >
              Gak Jadi
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteSelectedTx}
              disabled={isDeleting}
              loading={isDeleting}
              loadingLabel="Menghapus..."
            >
              Ya, Hapus
            </Button>
          </div>
        </div>
      </Dialog>

      {/* QUICK CREATE MASTER PRODUCT POPUP */}
      <Dialog
        open={quickCreateModalOpen}
        onClose={() => {
          if (!isQuickCreating) setQuickCreateModalOpen(false);
        }}
        title="Tambah Produk Baru"
        description={`Buat master produk baru langsung untuk baris #${(quickCreateCallerLineIdx ?? 0) + 1}. Saldo stok awal tetap 0.`}
      >
        <form onSubmit={handleSaveQuickCreate} className="flex flex-col gap-4">
          {quickCreateError && (
            <Alert tone="danger" title="Gagal Menyimpan Produk">
              {quickCreateError}
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-primary">
              Nama Produk <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              required
              className="input text-xs"
              placeholder="Contoh: Baju Bayi Lengan Pendek"
              value={quickCreateName}
              onChange={(e) => setQuickCreateName(e.target.value)}
              disabled={isQuickCreating}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-primary">
              SKU (Kode Unik per Gudang) <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              required
              className="input text-xs font-mono uppercase"
              placeholder="Contoh: BB-LP-01"
              value={quickCreateSku}
              onChange={(e) => setQuickCreateSku(e.target.value.toUpperCase())}
              disabled={isQuickCreating}
            />
            <span className="text-[11px] text-text-secondary">
              SKU harus unik pada gudang aktif ({context.warehouseName ?? "Gudang Utama"}).
            </span>
          </div>

          {/* Mode Pelacakan (Tracking) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-primary">
              Mode Pelacakan (Tracking) <span className="text-danger">*</span>
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label
                className={`flex items-center gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                  quickCreateTrackingMode === "SERIAL"
                    ? "border-primary bg-primary-soft/40 font-semibold text-primary"
                    : "border-border bg-surface text-text-secondary hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="qcTrackingMode"
                  value="SERIAL"
                  checked={quickCreateTrackingMode === "SERIAL"}
                  onChange={() => setQuickCreateTrackingMode("SERIAL")}
                  disabled={isQuickCreating}
                />
                <span>Serial Number (SN)</span>
              </label>
              <label
                className={`flex items-center gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                  quickCreateTrackingMode === "NON_SERIAL"
                    ? "border-primary bg-primary-soft/40 font-semibold text-primary"
                    : "border-border bg-surface text-text-secondary hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="qcTrackingMode"
                  value="NON_SERIAL"
                  checked={quickCreateTrackingMode === "NON_SERIAL"}
                  onChange={() => setQuickCreateTrackingMode("NON_SERIAL")}
                  disabled={isQuickCreating}
                />
                <span>Non-serial (Qty)</span>
              </label>
            </div>
            <span className="text-[11px] text-text-secondary">
              {quickCreateTrackingMode === "SERIAL"
                ? "Produk akan dilacak per Serial Number individual di gudang."
                : "Produk akan dilacak hanya berdasarkan jumlah kuantitas total stok."}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-text-primary">Satuan Dasar</label>
              <select
                className="input text-xs"
                value={quickCreateUnit}
                onChange={(e) => setQuickCreateUnit(e.target.value)}
                disabled={isQuickCreating}
              >
                <option value="pcs">pcs</option>
                <option value="pack">pack</option>
                <option value="lusin">lusin</option>
                <option value="box">box</option>
                <option value="unit">unit</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-text-primary">Kategori</label>
              <input
                type="text"
                className="input text-xs"
                placeholder="General"
                value={quickCreateCategory}
                onChange={(e) => setQuickCreateCategory(e.target.value)}
                disabled={isQuickCreating}
              />
            </div>
          </div>



          <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setQuickCreateModalOpen(false)}
              disabled={isQuickCreating}
            >
              Batal
            </Button>
            <Button type="submit" variant="primary" disabled={isQuickCreating}>
              {isQuickCreating ? "Menyimpan Produk..." : "Simpan Produk"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* SPREADSHEET / EXCEL PASTE DIALOG */}
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
                Format: [SKU / Nama] [Tab] [Qty] [Tab] [Satuan] [Tab] [Catatan]
              </span>
            </div>
            <textarea
              className="input text-xs font-mono"
              rows={4}
              placeholder={"Contoh:\nSKU-001\t5\tlusin\tBarang batch A\nSKU-002\t20\tpcs\t\nProduk C\t3\tbox\tRak Depan"}
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
              <span>Gantikan baris form yang ada</span>
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

          {/* PREVIEW TABLE */}
          {parsedSpreadsheetRows.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-text-primary">
                  Hasil Parsing & Pemetaan ({parsedSpreadsheetRows.length} baris terdeteksi):
                </span>
                <span className="text-[11px] font-medium text-text-secondary">
                  Valid: {parsedSpreadsheetRows.filter((r) => r.isValid).length} • Tidak Ditemukan:{" "}
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
                      <th className="p-2 w-28">Kuantitas</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {parsedSpreadsheetRows.map((row, idx) => (
                      <tr key={idx} className={row.isValid ? "bg-surface" : "bg-danger-soft/20"}>
                        <td className="p-2 text-center text-[11px] font-mono text-text-secondary">
                          {idx + 1}
                        </td>
                        <td className="p-2 font-mono text-[11px] text-text-primary">
                          {row.query || "(Kosong)"}
                        </td>
                        <td className="p-2">
                          {row.product ? (
                            <div>
                              <div className="font-semibold text-text-primary">{row.product.name}</div>
                              <div className="text-[10px] font-mono text-text-secondary">
                                SKU: {row.product.sku}
                              </div>
                            </div>
                          ) : (
                            <span className="text-danger text-[11px] font-medium">
                              {row.errorMsg || "Tidak ditemukan"}
                            </span>
                          )}
                        </td>
                        <td className="p-2 font-medium tabular">
                          {row.qty} {row.unit}
                        </td>
                        <td className="p-2">
                          {row.isValid ? (
                            <span className="inline-flex items-center rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">
                              Siap Impor
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                              Lewati
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPasteModalOpen(false);
                setPasteRawText("");
              }}
            >
              Batal
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleApplySpreadsheetRows}
              disabled={parsedSpreadsheetRows.filter((r) => r.isValid).length === 0}
            >
              Terapkan ke Form (
              {parsedSpreadsheetRows.filter((r) => r.isValid).length} Baris Valid)
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Dialog Retur ke Pemasok (Supplier Return) */}
      {returnTargetTx && (
        <ReturnSerialPickerDialog
          open={!!returnTargetTx}
          onClose={() => setReturnTargetTx(null)}
          sourceType="SUPPLIER"
          sourceReference={returnTargetTx.reference}
          partnerName={returnTargetTx.supplierName}
          warehouseId={returnTargetTx.warehouseId}
          warehouseName={returnTargetTx.warehouseName}
          availableSerials={returnAvailableSerials}
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
              const res = await createInventoryReturnAction({
                warehouseId: returnTargetTx.warehouseId,
                returnType: "SUPPLIER_RETURN",
                supplierId: returnTargetTx.supplierId,
                goodsInId: returnTargetTx.id,
                returnNumber: `RET-SUP-${Date.now().toString().slice(-6)}`,
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
                  title: "Gagal Membuat Retur ke Pemasok",
                  description: res.error || "Terjadi kesalahan saat membuat retur.",
                });
                return;
              }

              toast.push({
                tone: "success",
                title: "Retur ke Pemasok Berhasil Dibuat",
                description: `Dokumen retur ${res.returnRecord?.returnNumber} telah dibuat berstatus DRAFT (Menunggu pengeluaran fisik).`,
              });
              setReturnTargetTx(null);
            } finally {
              setIsSubmittingReturn(false);
            }
          }}
        />
      )}
    </div>
  );
}

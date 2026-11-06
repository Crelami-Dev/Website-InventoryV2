"use client";

import { useState, useMemo } from "react";
import "./grouping-modal.css";
import { PageHeader } from "@/components/shell/page-header";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Badge, Alert } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/dialog";
import { TextField, SelectField, TextareaField } from "@/components/ui/form-fields";
import { useToast } from "@/components/ui/toast";
import { RotateCcwIcon } from "@/components/ui/icons";
import { useActiveContext } from "@/lib/demo/active-context-provider";
import { getUnitMultiplier } from "@/lib/inventory/units";
import {
  createSerialGroupsBatchAction,
  dissolveGroupingAction,
  getSerialGroupDetailAction,
} from "@/lib/inventory/actions";
import type {
  SerialGroupingRecord,
  SerialGroupDetailResult,
  CreateSerialGroupItemInput,
} from "@/lib/types/inventory-domain";

export interface GroupingViewProps {
  initialGroupings: SerialGroupingRecord[];
  products: {
    id: string;
    name: string;
    sku: string;
    unit: string;
    stock: number;
    availableStock: number;
    availableStandaloneStock: number;
  }[];
  initialSerials: {
    id: string;
    productId: string;
    serialNumber: string;
    status: string;
    productName: string;
    sku: string;
    unit?: string;
    unitQuantity?: number;
    baseQuantity?: number;
  }[];
}

interface FormRow {
  id: string;
  unit: "pcs" | "lusin";
  manualGroupName: string;
  notes: string;
  serialInput: string;
  selectedSerials: string[];
}

export function GroupingView({
  initialGroupings,
  products,
  initialSerials,
}: GroupingViewProps) {
  const { context } = useActiveContext();
  const toast = useToast();

  const [groupings, setGroupings] = useState<SerialGroupingRecord[]>(initialGroupings);
  const [serials, setSerials] = useState(initialSerials);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Modal Create Batch State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openPickerRowId, setOpenPickerRowId] = useState<string | null>(null);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [pasteModalRowId, setPasteModalRowId] = useState<string | null>(null);
  const [pasteRawText, setPasteRawText] = useState("");
  const [rows, setRows] = useState<FormRow[]>([
    {
      id: "row-1",
      unit: "lusin",
      manualGroupName: "",
      notes: "",
      serialInput: "",
      selectedSerials: [],
    },
  ]);

  // Modal Detail State
  const [selectedGrouping, setSelectedGrouping] = useState<SerialGroupDetailResult | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Dissolve State
  const [dissolveTarget, setDissolveTarget] = useState<SerialGroupingRecord | null>(null);
  const [dissolveReason, setDissolveReason] = useState("");
  const [isDissolving, setIsDissolving] = useState(false);

  // Print Label Barcode Modal State
  const [printTarget, setPrintTarget] = useState<SerialGroupingRecord | null>(null);

  // Filter Groupings
  const filteredGroupings = useMemo(() => {
    return groupings.filter((g) => {
      const matchSearch =
        !search ||
        g.groupNumber.toLowerCase().includes(search.toLowerCase()) ||
        (g.groupName && g.groupName.toLowerCase().includes(search.toLowerCase()));
      const matchStatus = !statusFilter || g.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [groupings, search, statusFilter]);

  // Serial lookup map
  const serialMap = useMemo(() => {
    const map = new Map<string, (typeof initialSerials)[0]>();
    for (const s of serials) {
      map.set(s.serialNumber.trim().toUpperCase(), s);
    }
    return map;
  }, [serials]);

  // Form row helpers
  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        unit: "lusin",
        manualGroupName: "",
        notes: "",
        serialInput: "",
        selectedSerials: [],
      },
    ]);
  }

  function removeRow(id: string) {
    if (rows.length <= 1) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRow(id: string, patch: Partial<FormRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function handleAddSerialToRow(rowId: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const cleanSn = row.serialInput.trim().toUpperCase();
    if (!cleanSn) return;

    if (cleanSn.startsWith("G-")) {
      toast.push({ tone: "danger", title: "SN biasa dilarang diawali 'G-'." });
      return;
    }

    // Cek duplikasi di seluruh form batch
    const allSelectedInForm = rows.flatMap((r) => r.selectedSerials);
    if (allSelectedInForm.includes(cleanSn)) {
      toast.push({ tone: "warning", title: `SN ${cleanSn} sudah dipilih di form ini.` });
      return;
    }

    const found = serialMap.get(cleanSn);
    if (!found) {
      toast.push({
        tone: "danger",
        title: `SN ${cleanSn} tidak ditemukan atau tidak AVAILABLE di gudang ini.`,
      });
      return;
    }

    updateRow(rowId, {
      selectedSerials: [...row.selectedSerials, cleanSn],
      serialInput: "",
    });
  }

  function handlePasteSerialsSubmit() {
    if (!pasteModalRowId) return;
    const lines = pasteRawText
      .split(/\r?\n/)
      .map((l) => l.trim().toUpperCase())
      .filter(Boolean);

    if (lines.length === 0) {
      toast.push({ tone: "warning", title: "Teks yang ditempel kosong." });
      return;
    }

    const row = rows.find((r) => r.id === pasteModalRowId);
    if (!row) return;

    const allSelectedInForm = rows.flatMap((r) => r.selectedSerials);
    const added: string[] = [];
    const skipped: string[] = [];

    for (const sn of lines) {
      if (sn.startsWith("G-")) {
        skipped.push(`${sn} (diawali G-)`);
        continue;
      }
      if (allSelectedInForm.includes(sn) || row.selectedSerials.includes(sn) || added.includes(sn)) {
        skipped.push(`${sn} (duplikat)`);
        continue;
      }
      if (!serialMap.has(sn)) {
        skipped.push(`${sn} (tidak available)`);
        continue;
      }
      added.push(sn);
    }

    if (added.length > 0) {
      updateRow(pasteModalRowId, {
        selectedSerials: [...row.selectedSerials, ...added],
      });
      toast.push({
        tone: "success",
        title: `Berhasil menambahkan ${added.length} serial number.`,
      });
    }

    if (skipped.length > 0) {
      toast.push({
        tone: "warning",
        title: `${skipped.length} SN dilewati: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "..." : ""}`,
      });
    }

    setPasteModalRowId(null);
    setPasteRawText("");
  }

  function handleRemoveSerialFromRow(rowId: string, snToRemove: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    updateRow(rowId, {
      selectedSerials: row.selectedSerials.filter((s) => s !== snToRemove),
    });
  }

  // Row inspection helper
  function inspectRow(row: FormRow) {
    const snItems = row.selectedSerials
      .map((sn) => serialMap.get(sn))
      .filter(Boolean) as (typeof initialSerials)[0][];

    // Total PCS dihitung dari baseQuantity masing-masing serial
    // (misal 1 SN mewakili 1 lusin = 12 pcs, 1 pack 5 lusin = 60 pcs, dsb)
    const totalPcs = snItems.reduce((acc, s) => {
      const u = s.unit || "pcs";
      const uQty = Number(s.unitQuantity || 1);
      const bQty = Number(s.baseQuantity) > 0 ? Number(s.baseQuantity) : uQty * getUnitMultiplier(u);
      return acc + bQty;
    }, 0);

    const distinctProductIds = Array.from(new Set(snItems.map((s) => s.productId)));
    const isSingleProduct = distinctProductIds.length === 1;
    const singleProduct = isSingleProduct
      ? products.find((p) => p.id === distinctProductIds[0])
      : null;

    const multiplier = row.unit === "lusin" ? 12 : 1;
    const remainder = totalPcs % multiplier;
    const isMatch = remainder === 0 && totalPcs > 0;
    const missingPcs = isMatch ? 0 : multiplier - remainder;
    const unitQty = totalPcs > 0 ? Math.floor(totalPcs / multiplier) : 0;
    const totalLusin = Number((totalPcs / 12).toFixed(2));

    return {
      totalSnCount: snItems.length,
      totalPcs,
      totalLusin,
      distinctProductIds,
      isSingleProduct,
      singleProduct,
      multiplier,
      remainder,
      isMatch,
      missingPcs,
      unitQty,
      hasMinSerials: snItems.length >= 2,
    };
  }

  // Submit Batch Create
  async function handleBatchSubmit() {
    if (!context.warehouseId) {
      toast.push({ tone: "danger", title: "Pilih gudang aktif terlebih dahulu." });
      return;
    }

    // Validasi lokal sebelum submit
    const linesInput: CreateSerialGroupItemInput[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const info = inspectRow(r);

      if (!info.hasMinSerials) {
        toast.push({
          tone: "danger",
          title: `Baris #${i + 1}: Minimal 2 SN per group.`,
        });
        return;
      }

      if (!info.isMatch) {
        toast.push({
          tone: "danger",
          title: `Baris #${i + 1}: Kuantitas tidak pas kelipatan ${r.unit}. Kurang ${info.missingPcs} pcs.`,
        });
        return;
      }

      if (!info.isSingleProduct && !r.manualGroupName.trim()) {
        toast.push({
          tone: "danger",
          title: `Baris #${i + 1}: Group lintas produk WAJIB memiliki Nama Group.`,
        });
        return;
      }

      const serialIds = r.selectedSerials
        .map((sn) => serialMap.get(sn)?.id)
        .filter(Boolean) as string[];

      linesInput.push({
        unit: r.unit,
        groupName: info.isSingleProduct ? null : r.manualGroupName.trim(),
        notes: r.notes.trim() || null,
        serialIds,
      });
    }

    setIsSubmitting(true);
    try {
      const res = await createSerialGroupsBatchAction({
        warehouseId: context.warehouseId,
        groups: linesInput,
      });

      if (!res.success || !res.createdGroups) {
        toast.push({
          tone: "danger",
          title: res.error || "Gagal membuat batch grouping.",
        });
        return;
      }

      toast.push({
        tone: "success",
        title: `Berhasil membuat ${res.createdGroups.length} group serial.`,
      });

      // Update state
      setGroupings((prev) => [...res.createdGroups!, ...prev]);
      // Remove used serials from available cache
      const usedSns = rows.flatMap((r) => r.selectedSerials);
      setSerials((prev) => prev.filter((s) => !usedSns.includes(s.serialNumber.toUpperCase())));

      // Reset modal
      setIsCreateOpen(false);
      setRows([
        {
          id: "row-1",
          unit: "lusin",
          manualGroupName: "",
          notes: "",
          serialInput: "",
          selectedSerials: [],
        },
      ]);
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: err instanceof Error ? err.message : "Terjadi kesalahan sistem.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Open Detail
  async function handleOpenDetail(g: SerialGroupingRecord) {
    setIsLoadingDetail(true);
    try {
      const res = await getSerialGroupDetailAction(g.id);
      if (res.success && res.detail) {
        setSelectedGrouping(res.detail);
      } else {
        toast.push({ tone: "danger", title: res.error || "Gagal mengambil rincian group." });
      }
    } catch {
      toast.push({ tone: "danger", title: "Gagal memuat detail." });
    } finally {
      setIsLoadingDetail(false);
    }
  }

  // Dissolve Group
  async function handleDissolveConfirm() {
    if (!dissolveTarget) return;
    setIsDissolving(true);
    try {
      const res = await dissolveGroupingAction(dissolveTarget.id, dissolveReason);
      if (!res.success) {
        toast.push({ tone: "danger", title: res.error || "Gagal membongkar group." });
        return;
      }

      toast.push({
        tone: "success",
        title: `Group ${dissolveTarget.groupNumber} berhasil dibongkar (DISSOLVED).`,
      });

      setGroupings((prev) =>
        prev.map((g) => (g.id === dissolveTarget.id ? { ...g, status: "DISSOLVED" } : g))
      );
      setDissolveTarget(null);
      setDissolveReason("");
      if (selectedGrouping && selectedGrouping.group.id === dissolveTarget.id) {
        setSelectedGrouping(null);
      }
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: err instanceof Error ? err.message : "Gagal membongkar group.",
      });
    } finally {
      setIsDissolving(false);
    }
  }

  // Table Columns
  const columns: Column<SerialGroupingRecord>[] = [
    {
      key: "groupNumber",
      header: "Nomor Group",
      cell: (g) => (
        <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-text-primary">
          <span className="inline-flex items-center justify-center rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[11px] font-bold">
            G
          </span>
          <span>{g.groupNumber}</span>
        </div>
      ),
    },
    {
      key: "name",
      header: "Nama Group / Kemasan",
      cell: (g) => (
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {g.groupName || "Group Produk Tunggal"}
          </p>
          <span className="text-xs text-text-secondary">
            {g.productId ? "1 Produk" : "Lintas Produk Campuran"}
          </span>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Kuantitas",
      align: "right",
      cell: (g) => (
        <div className="flex flex-col items-end">
          <span className="font-mono text-sm font-bold text-text-primary">
            {g.unitQuantity} {g.unit}
          </span>
          <span className="text-[11px] text-text-secondary">
            Total {g.totalBaseQtyPcs} pcs
          </span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (g) => {
        if (g.status === "DISSOLVED") {
          const isRetailReturn = g.notes?.toLowerCase().includes("retur");
          return (
            <div className="flex flex-col items-start gap-1">
              <Badge variant="danger">DISSOLVED</Badge>
              {isRetailReturn ? (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold">
                  <RotateCcwIcon className="h-3 w-3" />
                  Retur Eceran
                </span>
              ) : (
                <span className="text-[10px] text-text-muted">Dibongkar</span>
              )}
            </div>
          );
        }

        const tone =
          g.status === "AVAILABLE"
            ? "success"
            : g.status === "RESERVED"
            ? "warning"
            : g.status === "CONSUMED_OUT"
            ? "neutral"
            : "danger";
        return <Badge variant={tone}>{g.status}</Badge>;
      },
    },
    {
      key: "createdAt",
      header: "Dibuat",
      cell: (g) => (
        <span className="text-xs text-text-secondary">
          {g.createdAt ? g.createdAt.slice(0, 16).replace("T", " ") : "-"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (g) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleOpenDetail(g)}
            loading={isLoadingDetail}
          >
            Rincian
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPrintTarget(g)}
          >
            Cetak Label
          </Button>
          {g.status === "AVAILABLE" && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDissolveTarget(g)}
            >
              Bongkar
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Grouping Serial Number"
        description="Kelola wadah kemasan Serial Number (lusin/pcs), cetak barcode induk G-xxxx, dan pelacakan unit tanpa mengubah HPP atau saldo ledger stok."
        actions={
          <Button variant="primary" onClick={() => setIsCreateOpen(true)}>
            + Tambah Group SN Baru
          </Button>
        }
      />

      <Alert tone="info" title="Konsep Wadah Serial Number">
        Group berfungsi murni sebagai wadah kumpulan serial (container). Nilai HPP dan saldo mutasi stok resmi tetap melekat pada produk aslinya saat transaksi Goods Out dijalankan.
      </Alert>

      <ListToolbar
        searchLabel="Cari nomor group atau nama"
        searchValue={search}
        onSearchChange={setSearch}
        filters={
          <div className="w-48">
            <SelectField
              label="Status Wadah"
              showRequirement={false}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              options={[
                { label: "Semua Status", value: "" },
                { label: "Tersedia (AVAILABLE)", value: "AVAILABLE" },
                { label: "Direservasi (RESERVED)", value: "RESERVED" },
                { label: "Telah Keluar (CONSUMED_OUT)", value: "CONSUMED_OUT" },
                { label: "Dibongkar (DISSOLVED)", value: "DISSOLVED" },
              ]}
            />
          </div>
        }
      />

      <DataTable
        caption="Daftar Wadah Grouping Serial Number"
        columns={columns}
        rows={filteredGroupings}
        getRowId={(g) => g.id}
        empty={
          <div className="py-8 text-center text-text-secondary">
            <p className="font-semibold text-text-primary">Belum ada group serial number</p>
            <p className="text-xs mt-1">
              Klik tombol &apos;+ Tambah Group SN Baru&apos; untuk menggabungkan nomor seri menjadi kemasan lusin/pcs.
            </p>
          </div>
        }
      />

      {/* MODAL 1: Form Multi-Baris Pembuatan Group (Goods Out UI Alignment) */}
      {isCreateOpen && (
        <div
          className="grp-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="grp-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSubmitting) setIsCreateOpen(false);
          }}
        >
          <section className="grp-modal" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="grp-modal__header">
              <div>
                <h2 id="grp-modal-title" className="text-lg font-bold text-text-primary">
                  Buat Wadah Grouping Serial Number
                </h2>
                <p className="text-xs text-text-secondary mt-0.5">
                  Gabungkan nomor seri menjadi wadah kemasan (Lusin/Pcs). Minimal 2 SN per wadah, kuantitas dihitung dari isi konversi resmi tiap serial.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-semibold text-text-secondary">
                  <span>Gudang: {context.warehouseName ?? "Gudang Utama"}</span>
                </div>
                <button
                  type="button"
                  className="rounded p-1.5 text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors"
                  onClick={() => !isSubmitting && setIsCreateOpen(false)}
                  aria-label="Tutup modal"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="grp-modal__body">
              <div className="flex items-center justify-between bg-primary-soft/30 border border-primary/20 rounded-md p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-primary">Integritas Konversi SN:</span>
                  <span className="text-text-secondary">
                    Jika 1 SN mewakili 1 lusin (12 pcs) atau 1 pack (60 pcs), sistem otomatis menghitung isi riilnya ke dalam satuan wadah tujuan.
                  </span>
                </div>
                <span className="font-mono font-bold text-primary">
                  {rows.length} wadah dalam batch
                </span>
              </div>

              {rows.map((row, idx) => {
                const info = inspectRow(row);
                return (
                  <div key={row.id} className="grp-card">
                    {/* Header Card Wadah */}
                    <div className="grp-card__header">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-text-inverse text-xs font-bold font-mono">
                          {idx + 1}
                        </span>
                        <div>
                          <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                            Wadah Group Kemasan #{idx + 1}
                          </h3>
                          <span className="text-[11px] text-text-secondary">
                            {info.totalSnCount} barcode SN dipilih • {info.distinctProductIds.length === 1 ? "1 Produk Tunggal" : info.distinctProductIds.length > 1 ? `${info.distinctProductIds.length} Produk Campuran` : "Belum ada produk"}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {rows.length > 1 && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => removeRow(row.id)}
                            disabled={isSubmitting}
                          >
                            Hapus Wadah
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Body Card Wadah */}
                    <div className="grp-card__body">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <SelectField
                          label="Target Satuan Wadah"
                          value={row.unit}
                          onChange={(e) =>
                            updateRow(row.id, { unit: e.target.value as "pcs" | "lusin" })
                          }
                          options={[
                            { value: "lusin", label: "Lusin (Harus pas kelipatan 12 pcs)" },
                            { value: "pcs", label: "Pcs (Kelipatan 1 pc)" },
                          ]}
                        />

                        <TextField
                          label={
                            info.isSingleProduct
                              ? "Nama Group (Terkunci = Nama Produk)"
                              : "Nama Group (Wajib untuk Campuran)"
                          }
                          placeholder={
                            info.isSingleProduct
                              ? info.singleProduct?.name || "Nama Produk"
                              : "Misal: Paket Seragam Kantor A"
                          }
                          disabled={info.isSingleProduct}
                          value={
                            info.isSingleProduct
                              ? info.singleProduct?.name || ""
                              : row.manualGroupName
                          }
                          onChange={(e) =>
                            updateRow(row.id, { manualGroupName: e.target.value })
                          }
                        />

                        <TextField
                          label="Catatan Wadah (Opsional)"
                          placeholder="Keterangan tambahan kemasan..."
                          value={row.notes}
                          onChange={(e) => updateRow(row.id, { notes: e.target.value })}
                        />
                      </div>

                      {/* Input Scan Barcode SN & Aksi Cepat */}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-end gap-2">
                          <div className="flex-1">
                            <TextField
                              label="Scan / Input Serial Number Anggota"
                              placeholder="Ketik atau scan barcode SN lalu tekan Enter..."
                              value={row.serialInput}
                              onChange={(e) =>
                                updateRow(row.id, { serialInput: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleAddSerialToRow(row.id);
                                }
                              }}
                            />
                          </div>
                          <Button
                            variant="secondary"
                            onClick={() => handleAddSerialToRow(row.id)}
                          >
                            + Tambah SN
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setOpenPickerRowId(openPickerRowId === row.id ? null : row.id);
                              setPickerSearchQuery("");
                            }}
                            title="Buka daftar pilihan serial yang tersedia di gudang"
                          >
                            {openPickerRowId === row.id ? "Tutup Pilihan" : "Pilih dari Gudang"}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setPasteModalRowId(row.id);
                              setPasteRawText("");
                            }}
                            title="Salin dan tempel daftar nomor seri dari Excel / Notepad"
                          >
                            Paste Excel
                          </Button>
                        </div>
                        <span className="text-[11px] text-text-secondary">
                          Hanya nomor seri berstatus AVAILABLE di gudang aktif yang dapat dimasukkan. SN berawalan &apos;G-&apos; dilarang.
                        </span>
                      </div>

                      {/* Dropdown Serial Picker (Gaya Goods Out) */}
                      {openPickerRowId === row.id && (
                        <div className="rounded border border-border bg-surface-muted p-3 max-h-52 overflow-y-auto flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <input
                              type="text"
                              className="input text-xs font-mono flex-1 bg-surface"
                              placeholder="Cari nomor seri, SKU, atau nama produk..."
                              value={pickerSearchQuery}
                              onChange={(e) => setPickerSearchQuery(e.target.value)}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="text-xs text-text-secondary hover:text-text-primary px-1.5 py-0.5 rounded border border-border bg-surface"
                              onClick={() => setOpenPickerRowId(null)}
                            >
                              Tutup
                            </button>
                          </div>

                          {(() => {
                            const allSelected = rows.flatMap((r) => r.selectedSerials);
                            const unselectedSerials = serials.filter(
                              (s) =>
                                !allSelected.includes(s.serialNumber.toUpperCase()) &&
                                (!pickerSearchQuery ||
                                  s.serialNumber.toLowerCase().includes(pickerSearchQuery.toLowerCase()) ||
                                  s.sku.toLowerCase().includes(pickerSearchQuery.toLowerCase()) ||
                                  s.productName.toLowerCase().includes(pickerSearchQuery.toLowerCase()))
                            );

                            if (unselectedSerials.length === 0) {
                              return (
                                <p className="text-xs text-text-secondary text-center py-3">
                                  Tidak ada nomor seri tersedia yang cocok.
                                </p>
                              );
                            }

                            return (
                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5">
                                {unselectedSerials.slice(0, 30).map((s) => {
                                  const u = s.unit || "pcs";
                                  const uQty = Number(s.unitQuantity || 1);
                                  const bQty = Number(s.baseQuantity) > 0 ? Number(s.baseQuantity) : uQty * getUnitMultiplier(u);
                                  return (
                                    <button
                                      key={s.id}
                                      type="button"
                                      className="flex items-center justify-between p-2 rounded bg-surface border border-border hover:border-primary text-xs text-left transition-colors gap-2"
                                      onClick={() => {
                                        updateRow(row.id, {
                                          selectedSerials: [...row.selectedSerials, s.serialNumber.toUpperCase()],
                                        });
                                      }}
                                    >
                                      <div className="flex flex-col min-w-0">
                                        <span className="font-mono font-bold text-text-primary truncate">
                                          {s.serialNumber}
                                        </span>
                                        <span className="text-[10px] text-text-secondary truncate">
                                          {s.sku} • {s.productName}
                                        </span>
                                      </div>
                                      <div className="flex flex-col items-end shrink-0">
                                        <span className="rounded bg-primary-soft text-primary px-1.5 py-0.2 text-[10px] font-bold">
                                          {uQty} {u} ({bQty} pcs)
                                        </span>
                                        <span className="text-[10px] text-primary font-semibold mt-0.5">
                                          + Pilih
                                        </span>
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Live Counter & Status Konversi */}
                      <div className="grp-counter-banner">
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-text-primary">
                            Status Isi:
                          </span>
                          {info.totalSnCount === 0 ? (
                            <span className="text-text-secondary">Belum ada serial dimasukkan</span>
                          ) : info.isMatch ? (
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-success font-mono">
                                Pas: {info.unitQty} {row.unit} ({info.totalPcs} pcs total) ✓
                              </span>
                              {row.unit === "pcs" && info.totalPcs >= 12 && (
                                <span className="text-[11px] text-text-secondary">
                                  (= {info.totalLusin} lusin)
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="font-bold text-danger font-mono">
                              Total saat ini: {info.totalPcs} pcs (Kurang {info.missingPcs} pcs untuk genap kelipatan 1 {row.unit})
                            </span>
                          )}
                        </div>

                        <div className="font-mono text-xs text-text-secondary">
                          {info.totalSnCount} SN fisik
                        </div>
                      </div>

                      {/* Selected Serials Chips dengan konversi satuan */}
                      {row.selectedSerials.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
                            Daftar SN di Wadah Ini:
                          </span>
                          <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto p-2.5 rounded border border-border bg-surface-muted/40">
                            {row.selectedSerials.map((sn, sIdx) => {
                              const item = serialMap.get(sn);
                              const u = item?.unit || "pcs";
                              const uQty = Number(item?.unitQuantity || 1);
                              const bQty = Number(item?.baseQuantity) > 0 ? Number(item?.baseQuantity) : uQty * getUnitMultiplier(u);
                              return (
                                <span key={sn} className="grp-serial-chip">
                                  <span className="text-text-secondary font-mono text-[11px]">{sIdx + 1}.</span>
                                  <span className="font-semibold text-text-primary">{sn}</span>
                                  {item && (
                                    <>
                                      <span className="grp-serial-chip__badge">
                                        {item.sku}
                                      </span>
                                      <span className="rounded bg-primary-soft text-primary px-1.5 py-0.2 text-[10px] font-bold">
                                        {uQty} {u} ({bQty} pcs)
                                      </span>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveSerialFromRow(row.id, sn)}
                                    className="text-danger hover:text-danger/80 ml-1 font-bold text-sm leading-none"
                                    title="Hapus serial dari wadah"
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Modal Footer */}
            <div className="grp-modal__footer">
              <Button
                variant="secondary"
                onClick={addRow}
                disabled={isSubmitting}
              >
                + Tambah Wadah Lain
              </Button>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={isSubmitting}
                >
                  Batal
                </Button>
                <Button
                  variant="primary"
                  onClick={handleBatchSubmit}
                  loading={isSubmitting}
                  disabled={isSubmitting}
                >
                  Simpan Seluruh Group ({rows.length})
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* MODAL PASTE EXCEL SERIAL NUMBERS */}
      <Dialog
        open={Boolean(pasteModalRowId)}
        onClose={() => setPasteModalRowId(null)}
        title="Tempel Daftar Serial Number (Excel / Teks)"
        description="Salin kolom nomor seri dari spreadsheet atau file teks lalu tempel di bawah. Satu nomor seri per baris."
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <Button
              variant="secondary"
              onClick={() => setPasteModalRowId(null)}
            >
              Batal
            </Button>
            <Button
              variant="primary"
              onClick={handlePasteSerialsSubmit}
            >
              Tambahkan ke Wadah
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 py-2">
          <TextareaField
            label="Daftar Nomor Seri (1 per baris)"
            placeholder={"SN-001\nSN-002\nSN-003"}
            rows={8}
            value={pasteRawText}
            onChange={(e) => setPasteRawText(e.target.value)}
            autoFocus
          />
          <span className="text-xs text-text-secondary">
            Nomor seri yang tidak berstatus AVAILABLE di gudang ini atau berawalan &apos;G-&apos; akan otomatis dilewati.
          </span>
        </div>
      </Dialog>

      {/* MODAL 2: Detail Grouping & Komponen */}
      <Dialog
        open={Boolean(selectedGrouping)}
        onClose={() => setSelectedGrouping(null)}
        title={`Detail Wadah ${selectedGrouping?.group.groupNumber || ""}`}
        description="Rincian informasi wadah, daftar nomor seri anggota, dan produk terkait."
        size="wide"
        footer={
          <div className="flex items-center justify-between w-full">
            {selectedGrouping?.group.status === "AVAILABLE" ? (
              <Button
                variant="danger"
                onClick={() => {
                  setDissolveTarget(selectedGrouping.group);
                }}
              >
                Bongkar Wadah Ini
              </Button>
            ) : (
              <span className="text-xs text-text-secondary">
                Status {selectedGrouping?.group.status}: Tidak dapat dibongkar langsung.
              </span>
            )}
            <Button variant="secondary" onClick={() => setSelectedGrouping(null)}>
              Tutup
            </Button>
          </div>
        }
      >
        {selectedGrouping && (
          <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded-lg border border-border p-3 bg-surface-muted text-xs">
              <div>
                <span className="text-text-secondary">Nomor Group</span>
                <p className="font-mono font-bold text-text-primary text-sm">
                  {selectedGrouping.group.groupNumber}
                </p>
              </div>
              <div>
                <span className="text-text-secondary">Nama Group</span>
                <p className="font-semibold text-text-primary text-sm">
                  {selectedGrouping.group.groupName || "-"}
                </p>
              </div>
              <div>
                <span className="text-text-secondary">Total Unit</span>
                <p className="font-bold text-text-primary text-sm">
                  {selectedGrouping.group.unitQuantity} {selectedGrouping.group.unit} ({selectedGrouping.group.totalBaseQtyPcs} pcs)
                </p>
              </div>
              <div>
                <span className="text-text-secondary">Status Wadah</span>
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <Badge
                    variant={
                      selectedGrouping.group.status === "AVAILABLE"
                        ? "success"
                        : selectedGrouping.group.status === "RESERVED"
                        ? "warning"
                        : selectedGrouping.group.status === "CONSUMED_OUT"
                        ? "neutral"
                        : "danger"
                    }
                  >
                    {selectedGrouping.group.status}
                  </Badge>
                  {selectedGrouping.group.status === "DISSOLVED" && (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold">
                      <RotateCcwIcon className="h-3 w-3" />
                      {selectedGrouping.group.notes?.toLowerCase().includes("retur")
                        ? "Dibongkar Akibat Retur Eceran"
                        : "Dibongkar (Dissolved)"}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold uppercase text-text-secondary tracking-wider">
                Daftar Serial Anggota ({selectedGrouping.components.length} SN)
              </h4>
              <div className="overflow-x-auto rounded border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-muted text-text-secondary border-b border-border">
                    <tr>
                      <th className="p-2.5">No</th>
                      <th className="p-2.5">Serial Number</th>
                      <th className="p-2.5">SKU</th>
                      <th className="p-2.5">Nama Produk</th>
                      <th className="p-2.5 text-right">Kuantitas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {selectedGrouping.components.map((c, idx) => (
                      <tr key={c.id} className="hover:bg-surface-muted/50">
                        <td className="p-2.5 text-text-secondary">{idx + 1}</td>
                        <td className="p-2.5 font-mono font-bold text-text-primary">
                          {c.serialNumber || c.serialId}
                        </td>
                        <td className="p-2.5 font-mono text-text-secondary">
                          {c.sku}
                        </td>
                        <td className="p-2.5 font-semibold text-text-primary">
                          {c.productName}
                        </td>
                        <td className="p-2.5 text-right font-mono">
                          {c.baseQtyPcs} pcs
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Dialog>

      {/* MODAL 3: Konfirmasi Dissolve / Ungroup */}
      <Dialog
        open={Boolean(dissolveTarget)}
        onClose={() => !isDissolving && setDissolveTarget(null)}
        title={`Bongkar Group ${dissolveTarget?.groupNumber || ""}`}
        description="Nomor seri anggota akan kembali berstatus AVAILABLE secara mandiri. Ledger stok tidak bergerak."
        isConfirm
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <Button
              variant="secondary"
              onClick={() => setDissolveTarget(null)}
              disabled={isDissolving}
            >
              Batal
            </Button>
            <Button
              variant="danger"
              onClick={handleDissolveConfirm}
              loading={isDissolving}
              disabled={isDissolving}
            >
              Ya, Bongkar Group
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 py-2">
          <Alert tone="warning" title="Peringatan Pembongkaran">
            Wadah group ini akan berstatus DISSOLVED secara permanen dan tidak dapat digunakan lagi.
          </Alert>
          <TextareaField
            label="Alasan Pembongkaran (Opsional)"
            placeholder="Misal: Penyesuaian kemasan ulang atas permintaan pelanggan..."
            value={dissolveReason}
            onChange={(e) => setDissolveReason(e.target.value)}
          />
        </div>
      </Dialog>

      {/* MODAL 4: Cetak Label Barcode Induk */}
      <Dialog
        open={Boolean(printTarget)}
        onClose={() => setPrintTarget(null)}
        title={`Cetak Label Barcode ${printTarget?.groupNumber || ""}`}
        description="Gunakan label barcode ini pada kemasan fisik wadah untuk mempercepat scan Goods Out."
        footer={
          <div className="flex items-center justify-between w-full">
            <Button
              variant="primary"
              onClick={() => {
                window.print();
              }}
            >
              Cetak ke Printer
            </Button>
            <Button variant="secondary" onClick={() => setPrintTarget(null)}>
              Tutup
            </Button>
          </div>
        }
      >
        {printTarget && (
          <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-border rounded-lg bg-white text-black my-2">
            <span className="text-xs uppercase tracking-widest font-semibold text-gray-500">
              DOCUFLOW INVENTORY LABEL
            </span>
            <h2 className="text-2xl font-bold mt-1 tracking-wider font-mono">
              {printTarget.groupNumber}
            </h2>
            <p className="text-sm font-semibold mt-0.5 text-gray-800">
              {printTarget.groupName || "Serial Number Group"}
            </p>
            <div className="mt-4 flex flex-col items-center justify-center">
              {/* Mock Barcode visual via CSS patterns */}
              <div className="h-14 w-64 bg-repeat-x flex items-center justify-center tracking-widest font-mono text-xs border border-gray-300 bg-gray-50">
                ||| | |||| | | |||| ||| || | |||| | ||
              </div>
              <span className="font-mono text-xs mt-1 text-gray-600">
                *{printTarget.groupNumber}*
              </span>
            </div>
            <div className="mt-4 border-t border-gray-200 pt-2 w-full text-center text-xs text-gray-600">
              Isi Kemasan: {printTarget.unitQuantity} {printTarget.unit} ({printTarget.totalBaseQtyPcs} Pcs)
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

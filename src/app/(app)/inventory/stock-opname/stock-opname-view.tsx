"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, Alert } from "@/components/ui/feedback";
import { TextField, SelectField, TextareaField } from "@/components/ui/form-fields";
import { ListToolbar, type ActiveFilter } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";

const PAGE_SIZE = 50;
import { useActiveContext } from "@/lib/demo/active-context-provider";
import {
  FIXTURE_OPNAME_SESSIONS,
  type StockOpnameSession,
} from "@/lib/demo/inventory-fixtures";
import { createStockOpnameSessionAction } from "@/lib/inventory/actions";

interface StockOpnameViewProps {
  initialSessions?: StockOpnameSession[];
  activeWarehouseId?: string;
  activeWarehouseName?: string;
}

export function StockOpnameView({
  initialSessions,
  activeWarehouseId,
  activeWarehouseName,
}: StockOpnameViewProps = {}) {
  const { context } = useActiveContext();
  const toast = useToast();

  const [sessions, setSessions] = useState<StockOpnameSession[]>(
    initialSessions !== undefined ? initialSessions : FIXTURE_OPNAME_SESSIONS
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  async function handleExportListExcel() {
    if (isExporting) return;
    setIsExporting(true);

    try {
      const whId = activeWarehouseId || context.warehouseId || "";
      const params = new URLSearchParams();
      if (whId) params.set("warehouseId", whId);
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());

      const res = await fetch(`/api/inventory/stock-opname/export?${params.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Gagal mengunduh daftar Stock Opname.");
      }
      const disposition = res.headers.get("Content-Disposition");
      let filename = `Daftar_Stock_Opname_${whId || "Semua"}.xlsx`;
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) filename = match[1];
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.push({
        tone: "success",
        title: "Ekspor Berhasil",
        description: `File '${filename}' berhasil diunduh.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal mengekspor data ke Excel.";
      toast.push({
        tone: "danger",
        title: "Ekspor Gagal",
        description: msg,
      });
    } finally {
      setIsExporting(false);
    }
  }

  const effectiveWhName = activeWarehouseName || context.warehouseName || "WH01";
  const autoSessionNo = `SO-202610-${effectiveWhName.slice(0, 4)}-${String(sessions.length + 1).padStart(2, "0")}`;
  const [scope, setScope] = useState<"ALL" | "CATEGORY" | "LOCATION">("ALL");
  const [scopeDetail, setScopeDetail] = useState("Jaringan");
  const [notes, setNotes] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter((s) => {
      const matchSearch =
        !q ||
        s.sessionNumber.toLowerCase().includes(q) ||
        s.warehouseName.toLowerCase().includes(q) ||
        (s.scopeDetail && s.scopeDetail.toLowerCase().includes(q));
      const matchStatus = !statusFilter || s.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [sessions, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedSessions = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  const activeFilters: ActiveFilter[] = [];
  if (search.trim()) activeFilters.push({ key: "search", label: `Cari: ${search.trim()}` });
  if (statusFilter) activeFilters.push({ key: "status", label: `Status: ${statusFilter}` });

  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);

    const whId = activeWarehouseId || context.warehouseId || "wh-north";
    const res = await createStockOpnameSessionAction({
      warehouseId: whId,
      sessionNumber: autoSessionNo,
      scope,
      note: notes.trim() || undefined,
    });

    setIsSubmitting(false);

    if (!res.success) {
      toast.push({
        tone: "danger",
        title: "Gagal Membuat Sesi",
        description: res.error || "Terjadi kesalahan saat membuat sesi Stock Opname.",
      });
      return;
    }

    const created = res.session;
    const newSession: StockOpnameSession = {
      id: created?.id ?? `so-${sessions.length + 1}`,
      sessionNumber: created?.sessionNumber ?? autoSessionNo,
      warehouseId: created?.warehouseId ?? whId,
      warehouseName: effectiveWhName,
      scope,
      scopeDetail: scope !== "ALL" ? scopeDetail : undefined,
      status: "IN_PROGRESS",
      createdAt: created?.startedAt?.replace("T", " ").slice(0, 16) ?? "2026-10-15 08:30",
      createdBy: created?.createdBy ?? context.email,
      snapshotFrozenAt: created?.startedAt ?? new Date().toISOString(),
      notes: notes.trim() || undefined,
      itemCount: created?.itemCount ?? 0,
      varianceCount: 0,
    };

    setSessions((prev) => [newSession, ...prev]);
    setModalOpen(false);
    toast.push({
      tone: "success",
      title: "Sesi Stock Opname Dibuat",
      description: `Snapshot stok untuk sesi ${newSession.sessionNumber} telah dibekukan di database SQLite. Pembuatan sesi tidak mengubah saldo fisik.`,
    });

    setNotes("");
  }

  const columns: Column<StockOpnameSession>[] = [
    {
      key: "sessionNumber",
      header: "Nomor Sesi",
      sortable: true,
      cell: (s) => (
        <div>
          <Link href={`/inventory/stock-opname/${s.id}`} className="font-semibold text-primary hover:underline">
            {s.sessionNumber}
          </Link>
          <p className="text-xs text-text-secondary">{s.createdAt}</p>
        </div>
      ),
    },
    {
      key: "warehouse",
      header: "Gudang",
      cell: (s) => <span className="text-sm font-medium">{s.warehouseName}</span>,
    },
    {
      key: "scope",
      header: "Cakupan (Scope)",
      cell: (s) => (
        <span className="text-xs text-text-secondary">
          {s.scope === "ALL" ? "Seluruh Gudang" : `${s.scope}: ${s.scopeDetail}`}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status Sesi",
      cell: (s) => {
        const tone =
          s.status === "COMPLETED"
            ? "success"
            : s.status === "IN_PROGRESS"
              ? "warning"
              : s.status === "REVIEW"
                ? "info"
                : "neutral";
        return (
          <StatusBadge tone={tone}>
            {s.status === "COMPLETED"
              ? "Selesai Diposting"
              : s.status === "IN_PROGRESS"
                ? "Sedang Hitung"
                : s.status === "REVIEW"
                  ? "Menunggu Review"
                  : "Draft"}
          </StatusBadge>
        );
      },
    },
    {
      key: "variance",
      header: "Selisih Item",
      align: "right",
      cell: (s) => (
        <span className={`tabular font-medium ${s.varianceCount > 0 ? "text-danger" : "text-text-secondary"}`}>
          {s.varianceCount} selisih / {s.itemCount} item
        </span>
      ),
    },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (s) => (
        <Link href={`/inventory/stock-opname/${s.id}`}>
          <Button variant="secondary" size="sm">
            {s.status === "IN_PROGRESS" ? "Lanjutkan Hitung" : "Lihat Sesi"}
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Stock Opname"
        description="Pencatatan sesi hitung fisik, snapshot saldo beku, dan rekonsiliasi selisih stok."
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={handleExportListExcel}
              disabled={isExporting}
              title="Unduh daftar sesi Stock Opname sesuai filter (.xlsx)"
            >
              {isExporting ? "Mengekspor..." : "Ekspor Daftar (.xlsx)"}
            </Button>
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              Buat Sesi Opname
            </Button>
          </div>
        }
      />

      <Alert tone="info" title="Prinsip Tahapan Stock Opname (LOCKED)">
        Sesuai RPD.md §7.9, alur Stock Opname terbagi menjadi 5 tahap tegas: (1) Buat Sesi & Snapshot Beku, (2) Hitung Fisik / Scan SN, (3) Review Variance, (4) Approval Owner, dan (5) Penyesuaian Stok Resmi. Proses penghitungan fisik atau scan tidak pernah mengubah saldo stok ledger fisik secara langsung.
      </Alert>

      <ListToolbar
        searchLabel="Cari nomor sesi atau cakupan"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Contoh: SO-202610-WH01..."
        activeFilters={activeFilters}
        onRemoveFilter={(k) => {
          if (k === "search") setSearch("");
          if (k === "status") setStatusFilter("");
        }}
        onClearFilters={() => {
          setSearch("");
          setStatusFilter("");
        }}
        filters={
          <SelectField
            label="Filter Status"
            showRequirement={false}
            placeholder="Semua Status Sesi"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "IN_PROGRESS", label: "Sedang Hitung (In Progress)" },
              { value: "REVIEW", label: "Menunggu Review" },
              { value: "COMPLETED", label: "Selesai Diposting" },
            ]}
          />
        }
      />

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <DataTable
          caption="Daftar Sesi Stock Opname"
          columns={columns}
          rows={pagedSessions}
          getRowId={(s) => s.id}
        />
        {filtered.length > 0 && (
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        )}
      </div>

      {/* Modal Buat Sesi Opname Baru (TASK-032) */}
      <Dialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Buat Sesi Stock Opname Baru"
        description="Snapshot stok sistem akan dibekukan saat sesi dibuat. Tidak ada saldo stok yang dimutasi pada tahap ini."
      >
        <form onSubmit={handleCreateSession} className="flex flex-col gap-3">
          <TextField
            label="Nomor Sesi (Sistem)"
            readOnly
            value={autoSessionNo}
            hint="Format sesi otomatis sistem (read-only)."
          />

          <TextField
            label="Gudang Pelaksanaan"
            readOnly
            value={context.warehouseName ?? "Gudang Utama"}
            hint="Stock Opname dilakukan per gudang tunggal."
          />

          <SelectField
            label="Cakupan Penghitungan (Scope)"
            required
            value={scope}
            onChange={(e) => setScope(e.target.value as "ALL" | "CATEGORY" | "LOCATION")}
            options={[
              { value: "ALL", label: "Seluruh Gudang (Semua Produk)" },
              { value: "CATEGORY", label: "Berdasarkan Kategori Produk" },
              { value: "LOCATION", label: "Berdasarkan Master Lokasi / Rak" },
            ]}
          />

          {scope === "CATEGORY" ? (
            <SelectField
              label="Pilih Kategori"
              required
              value={scopeDetail}
              onChange={(e) => setScopeDetail(e.target.value)}
              options={[
                { value: "Jaringan", label: "Jaringan" },
                { value: "Aksesoris", label: "Aksesoris" },
                { value: "Elektronik", label: "Elektronik" },
              ]}
            />
          ) : null}

          {scope === "LOCATION" ? (
            <SelectField
              label="Pilih Lokasi Master"
              required
              value={scopeDetail}
              onChange={(e) => setScopeDetail(e.target.value)}
              options={[
                { value: "RAK-A1", label: "Rak Elektronik A1" },
                { value: "RAK-A2", label: "Rak Kabel A2" },
                { value: "AREA-BULK", label: "Area Kardus & Pallet" },
              ]}
            />
          ) : null}

          <TextareaField
            label="Catatan Sesi"
            placeholder="Petugas pelaksana atau tujuan opname..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={isSubmitting}
              loading={isSubmitting}
              loadingLabel="Membekukan Snapshot..."
            >
              Bekukan Snapshot &amp; Mulai Sesi
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

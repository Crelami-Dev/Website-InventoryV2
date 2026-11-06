"use client";

import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Alert } from "@/components/ui/feedback";
import { SearchIcon, RotateCcwIcon, FilterIcon } from "@/components/ui/icons";
import { StockOpnameInvestigationDialog } from "./stock-opname-investigation-dialog";
import { StockOpnameFinalizeDialog } from "./stock-opname-finalize-dialog";
import { useActiveContext } from "@/lib/demo/active-context-provider";
import { evaluateStockOpnameReconciliationAction } from "@/lib/inventory/actions";
import type {
  StockOpnameReconciliationItem,
  StockOpnameReconciliationSummary,
} from "@/lib/db/repositories/inventory-repository";

interface StockOpnameReconciliationViewProps {
  sessionId: string;
  isReadOnly: boolean;
  onReconciliationUpdated?: () => void;
}

export function StockOpnameReconciliationView({
  sessionId,
  isReadOnly,
  onReconciliationUpdated,
}: StockOpnameReconciliationViewProps) {
  const { currentRole } = useActiveContext();
  const [data, setData] = useState<StockOpnameReconciliationSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter & Search
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"ALL" | "DISCREPANCY" | "INVESTIGATION" | "MATCH">("ALL");
  const [displayUnit, setDisplayUnit] = useState<"pcs" | "lusin">("pcs");

  // Dialog State
  const [selectedItem, setSelectedItem] = useState<StockOpnameReconciliationItem | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isFinalizeOpen, setIsFinalizeOpen] = useState(false);
  const [finalizedMessage, setFinalizedMessage] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Download Excel Workbook Handler (Phase 7)
  async function handleExportExcel() {
    if (isExporting) return;
    setIsExporting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/inventory/stock-opname/${sessionId}/export`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Gagal mengunduh file Excel.");
      }
      const disposition = res.headers.get("Content-Disposition");
      let filename = `Stock_Opname_${sessionId}.xlsx`;
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Terjadi kesalahan saat mengekspor file Excel.";
      setErrorMsg(msg);
    } finally {
      setIsExporting(false);
    }
  }

  // Fetch / Evaluate reconciliation
  async function loadReconciliation(refresh: boolean = false) {
    if (refresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setErrorMsg(null);

    try {
      const res = await evaluateStockOpnameReconciliationAction(sessionId);
      if (res.success && res.summary) {
        setData(res.summary);
        if (onReconciliationUpdated) {
          onReconciliationUpdated();
        }
      } else {
        setErrorMsg(res.error || "Gagal memuat evaluasi rekonsiliasi.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Terjadi kesalahan saat memproses data.";
      setErrorMsg(msg);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    loadReconciliation();
  }, [sessionId]);

  // Handler update investigasi lokal
  function handleInvestigationSaved(productId: string, reason: string, notes: string | null) {
    if (!data) return;
    setData((prev) => {
      if (!prev) return null;
      const updatedItems = prev.items.map((it) => {
        if (it.productId === productId) {
          return {
            ...it,
            discrepancyReason: reason,
            investigationNotes: notes,
          };
        }
        return it;
      });
      return {
        ...prev,
        items: updatedItems,
      };
    });
  }

  // Filter items
  const filteredItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter((item) => {
      // 1. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = item.productName.toLowerCase().includes(q);
        const matchSku = item.sku.toLowerCase().includes(q);
        if (!matchName && !matchSku) return false;
      }

      // 2. Active Tab
      if (activeTab === "MATCH") {
        return item.reconciliationStatus === "MATCH";
      }
      if (activeTab === "DISCREPANCY") {
        return item.reconciliationStatus === "SURPLUS" || item.reconciliationStatus === "SHORTAGE";
      }
      if (activeTab === "INVESTIGATION") {
        return (
          item.reconciliationStatus === "REQUIRES_RE_EVALUATION" ||
          item.hasConcurrentMovement ||
          Boolean(item.discrepancyReason) ||
          item.recommendation === "REQUIRES_INVESTIGATION"
        );
      }

      return true;
    });
  }, [data, searchQuery, activeTab]);

  // Helper konversi display unit (tampilan visual saja, tidak mengubah angka dasar di state)
  function formatQty(pcs: number): string {
    if (displayUnit === "lusin") {
      const dz = pcs / 12;
      return Number.isInteger(dz) ? `${dz} Lusin` : `${dz.toFixed(2)} Lusin`;
    }
    return `${pcs} PCS`;
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-border-default bg-surface p-8 text-center">
        <div className="space-y-2">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto" />
          <p className="text-xs text-text-muted">Mengevaluasi mutasi ledger dan menghitung rekonsiliasi...</p>
        </div>
      </div>
    );
  }

  if (errorMsg || !data) {
    return (
      <div className="space-y-4">
        <Alert variant="danger" title="Gagal Mengevaluasi Rekonsiliasi" description={errorMsg || "Data tidak ditemukan."} />
        <Button variant="secondary" size="sm" onClick={() => loadReconciliation(true)}>
          Coba Lagi
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 1. Stat Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-lg border border-border-default bg-surface-card p-3.5">
          <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider block">
            Total SKU
          </span>
          <div className="mt-1 font-mono text-2xl font-bold text-text-primary">
            {data.totalSku}
          </div>
          <span className="text-[11px] text-text-muted mt-0.5 block">Produk tercatat</span>
        </div>

        <div className="rounded-lg border border-border-default bg-surface-card p-3.5">
          <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider block">
            Sesuai (Match)
          </span>
          <div className="mt-1 font-mono text-2xl font-bold text-success">
            {data.matchCount}
          </div>
          <span className="text-[11px] text-text-muted mt-0.5 block">Selisih nol</span>
        </div>

        <div className="rounded-lg border border-border-default bg-surface-card p-3.5">
          <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider block">
            Surplus (Lebih)
          </span>
          <div className="mt-1 font-mono text-2xl font-bold text-info">
            {data.surplusCount}
          </div>
          <span className="text-[11px] text-text-muted mt-0.5 block">Fisik melebihi buku</span>
        </div>

        <div className="rounded-lg border border-border-default bg-surface-card p-3.5">
          <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider block">
            Kurang (Shortage)
          </span>
          <div className="mt-1 font-mono text-2xl font-bold text-danger">
            {data.shortageCount}
          </div>
          <span className="text-[11px] text-text-muted mt-0.5 block">Fisik kurang dari buku</span>
        </div>

        <div className="rounded-lg border border-border-default bg-surface-card p-3.5">
          <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider block">
            Perlu Investigasi
          </span>
          <div className="mt-1 font-mono text-2xl font-bold text-warning">
            {data.investigationCount}
          </div>
          <span className="text-[11px] text-text-muted mt-0.5 block">Delta / catatan selisih</span>
        </div>
      </div>

      {/* 2. Toolbar & Filter Navigation */}
      <div className="flex flex-col gap-3 rounded-lg border border-border-default bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tab Filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab("ALL")}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              activeTab === "ALL"
                ? "bg-text-primary text-surface font-semibold"
                : "bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-muted border border-border-default"
            }`}
          >
            Semua ({data.totalSku})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("DISCREPANCY")}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              activeTab === "DISCREPANCY"
                ? "bg-danger text-white font-semibold"
                : "bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-muted border border-border-default"
            }`}
          >
            Selisih ({data.surplusCount + data.shortageCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("INVESTIGATION")}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              activeTab === "INVESTIGATION"
                ? "bg-warning text-white font-semibold"
                : "bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-muted border border-border-default"
            }`}
          >
            Perlu Investigasi ({data.investigationCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("MATCH")}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              activeTab === "MATCH"
                ? "bg-success text-white font-semibold"
                : "bg-surface text-text-secondary hover:text-text-primary hover:bg-surface-muted border border-border-default"
            }`}
          >
            Sesuai ({data.matchCount})
          </button>
        </div>

        {/* Right Controls: Search, Unit Switcher, Refresh */}
        <div className="flex items-center gap-2">
          {/* Unit Switcher */}
          <div className="inline-flex rounded border border-border-default bg-surface-muted p-0.5">
            <button
              type="button"
              onClick={() => setDisplayUnit("pcs")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                displayUnit === "pcs"
                  ? "bg-surface font-semibold text-text-primary shadow-sm"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              PCS
            </button>
            <button
              type="button"
              onClick={() => setDisplayUnit("lusin")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                displayUnit === "lusin"
                  ? "bg-surface font-semibold text-text-primary shadow-sm"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              Lusin
            </button>
          </div>

          {/* Search Box */}
          <div className="relative min-w-[180px]">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
            <input
              type="text"
              placeholder="Cari SKU atau nama..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1 text-xs rounded border border-border-default bg-surface text-text-primary focus:outline-none focus:border-primary"
            />
          </div>

          {/* Hitung Ulang Button */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => loadReconciliation(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 text-xs whitespace-nowrap"
          >
            <RotateCcwIcon className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
            <span>{isRefreshing ? "Menghitung..." : "Hitung Ulang"}</span>
          </Button>

          {/* Ekspor Excel Button (Phase 7) */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleExportExcel}
            disabled={isExporting || isLoading}
            className="flex items-center gap-1.5 text-xs whitespace-nowrap font-medium text-text-primary"
            title="Unduh laporan audit rekonsiliasi lengkap 5-sheet (.xlsx)"
          >
            <span>{isExporting ? "Mengekspor..." : "Ekspor Excel"}</span>
          </Button>
        </div>
      </div>

      {/* 3. Tabel Rekonsiliasi Komparatif (Desktop) & Card List (Mobile) */}
      <div className="rounded-lg border border-border-default bg-surface overflow-hidden">
        {/* Desktop Table */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border-default bg-surface-muted font-semibold text-text-muted uppercase tracking-wider text-[11px]">
              <tr>
                <th className="px-3.5 py-2.5">Produk & SKU</th>
                <th className="px-3 py-2.5 text-center">Tipe</th>
                <th className="px-3 py-2.5 text-right font-mono">Snapshot</th>
                <th className="px-3 py-2.5 text-center">Delta Concurrent</th>
                <th className="px-3 py-2.5 text-right font-mono">Acuan Dinamis</th>
                <th className="px-3 py-2.5 text-right font-mono">Fisik</th>
                <th className="px-3 py-2.5 text-right font-mono">Selisih</th>
                <th className="px-3 py-2.5 text-center">Status</th>
                <th className="px-3.5 py-2.5 text-center">Investigasi & Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-text-muted">
                    Tidak ada produk yang sesuai dengan kriteria filter.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-surface-muted/60 transition-colors"
                  >
                    {/* Produk & SKU */}
                    <td className="px-3.5 py-3">
                      <div className="font-medium text-text-primary">{item.productName}</div>
                      <div className="font-mono text-[11px] text-text-muted">{item.sku}</div>
                    </td>

                    {/* Tipe Tracking */}
                    <td className="px-3 py-3 text-center">
                      <Badge variant={item.trackingMode === "SERIAL" ? "info" : "outline"} size="sm">
                        {item.trackingMode === "SERIAL" ? "SERIAL" : "NON_SN"}
                      </Badge>
                    </td>

                    {/* Snapshot Qty */}
                    <td className="px-3 py-3 text-right font-mono text-text-secondary">
                      {formatQty(item.snapshotQty)}
                    </td>

                    {/* Delta Concurrent */}
                    <td className="px-3 py-3 text-center">
                      {item.hasConcurrentMovement ? (
                        <div className="inline-flex items-center gap-1">
                          <span
                            className={`font-mono font-semibold px-1.5 py-0.5 rounded text-[11px] ${
                              item.netDelta > 0
                                ? "bg-emerald-50 text-emerald-800"
                                : item.netDelta < 0
                                ? "bg-rose-50 text-rose-800"
                                : "bg-neutral-100 text-neutral-800"
                            }`}
                          >
                            {item.netDelta > 0 ? `+${item.netDelta}` : item.netDelta}
                          </span>
                          <span className="text-[10px] text-text-muted">
                            (+{item.deltaIn}/-{item.deltaOut})
                          </span>
                        </div>
                      ) : (
                        <span className="text-text-muted font-mono text-[11px]">0 (Stabil)</span>
                      )}
                    </td>

                    {/* Acuan Dinamis */}
                    <td className="px-3 py-3 text-right font-mono font-semibold text-text-primary">
                      {formatQty(item.dynamicBookQty)}
                    </td>

                    {/* Fisik Terhitung */}
                    <td className="px-3 py-3 text-right font-mono font-bold text-primary">
                      {formatQty(item.countedQty)}
                    </td>

                    {/* Selisih (Variance) */}
                    <td className="px-3 py-3 text-right font-mono font-bold">
                      <span
                        className={
                          item.varianceQty === 0
                            ? "text-success"
                            : item.varianceQty > 0
                            ? "text-info"
                            : "text-danger"
                        }
                      >
                        {item.varianceQty > 0 ? `+${formatQty(item.varianceQty)}` : formatQty(item.varianceQty)}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-3 py-3 text-center">
                      <Badge
                        variant={
                          item.reconciliationStatus === "MATCH"
                            ? "success"
                            : item.reconciliationStatus === "SURPLUS"
                            ? "info"
                            : item.reconciliationStatus === "SHORTAGE"
                            ? "danger"
                            : "warning"
                        }
                        size="sm"
                      >
                        {item.reconciliationStatus === "MATCH"
                          ? "SESUAI"
                          : item.reconciliationStatus === "SURPLUS"
                          ? "SURPLUS"
                          : item.reconciliationStatus === "SHORTAGE"
                          ? "KURANG"
                          : "INVESTIGASI"}
                      </Badge>
                    </td>

                    {/* Investigasi & Aksi */}
                    <td className="px-3.5 py-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setSelectedItem(item);
                            setIsDialogOpen(true);
                          }}
                          className="h-7 px-2.5 text-xs"
                        >
                          {item.trackingMode === "SERIAL" ? "Rincian SN" : "Investigasi"}
                        </Button>
                        {item.discrepancyReason && (
                          <span
                            title={`Alasan: ${item.discrepancyReason}`}
                            className="inline-block h-2 w-2 rounded-full bg-primary"
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile / Tablet Card List */}
        <div className="block lg:hidden divide-y divide-border-default">
          {filteredItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-muted">
              Tidak ada produk yang sesuai dengan kriteria filter.
            </div>
          ) : (
            filteredItems.map((item) => (
              <div key={item.id} className="p-3.5 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-semibold text-text-primary text-xs block">
                      {item.productName}
                    </span>
                    <span className="font-mono text-[11px] text-text-muted">{item.sku}</span>
                  </div>
                  <Badge
                    variant={
                      item.reconciliationStatus === "MATCH"
                        ? "success"
                        : item.reconciliationStatus === "SURPLUS"
                        ? "info"
                        : item.reconciliationStatus === "SHORTAGE"
                        ? "danger"
                        : "warning"
                    }
                    size="sm"
                  >
                    {item.reconciliationStatus === "MATCH"
                      ? "SESUAI"
                      : item.reconciliationStatus === "SURPLUS"
                      ? "SURPLUS"
                      : item.reconciliationStatus === "SHORTAGE"
                      ? "KURANG"
                      : "INVESTIGASI"}
                  </Badge>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded bg-surface-muted/50 p-2 text-xs">
                  <div>
                    <span className="text-[10px] text-text-muted block">Snapshot</span>
                    <span className="font-mono font-medium">{formatQty(item.snapshotQty)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-text-muted block">Acuan Dinamis</span>
                    <span className="font-mono font-medium">{formatQty(item.dynamicBookQty)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-text-muted block">Fisik</span>
                    <span className="font-mono font-bold text-primary">
                      {formatQty(item.countedQty)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs pt-1">
                  <div>
                    <span className="text-[11px] text-text-muted mr-1">Selisih:</span>
                    <span
                      className={`font-mono font-bold ${
                        item.varianceQty === 0
                          ? "text-success"
                          : item.varianceQty > 0
                          ? "text-info"
                          : "text-danger"
                      }`}
                    >
                      {item.varianceQty > 0 ? `+${formatQty(item.varianceQty)}` : formatQty(item.varianceQty)}
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSelectedItem(item);
                      setIsDialogOpen(true);
                    }}
                    className="h-7 text-xs"
                  >
                    {item.trackingMode === "SERIAL" ? "Rincian SN" : "Investigasi"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 4. Panel Persetujuan & Finalisasi Penyesuaian (Phase 6) */}
      {finalizedMessage && (
        <Alert variant="success" title="Sesi Berhasil Difinalisasi" description={finalizedMessage} />
      )}

      {data.session.status === "ADJUSTED" || data.session.status === "COMPLETED" ? (
        <div className="rounded-lg border border-success/40 bg-success/5 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Badge variant="success" size="sm" className="font-semibold">
                TERKUNCI: {data.session.status}
              </Badge>
              <span className="text-xs font-bold text-text-primary uppercase tracking-wide">
                Penyesuaian Stok Resmi Telah Diposting
              </span>
            </div>
            <p className="text-xs text-text-muted">
              Sesi Stock Opname ini telah disetujui dan mutasi stok telah dibukukan ke inventory ledger. Sesi
              terkunci permanen dan tidak dapat menerima perubahan hitungan fisik atau pemindaian barcode lagi.
            </p>
          </div>
          <Badge variant="neutral" size="sm" className="font-mono text-[11px] self-start sm:self-auto">
            Diposting oleh Owner
          </Badge>
        </div>
      ) : (
        <div className="rounded-lg border border-border-default bg-surface-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-xs font-bold text-text-primary uppercase tracking-wide block">
              Persetujuan & Posting Penyesuaian ke Ledger (Phase 6)
            </span>
            <p className="text-xs text-text-muted">
              {currentRole === "OWNER"
                ? "Sebagai Owner, Anda berwenang menyetujui hasil rekonsiliasi dan memposting mutasi STOCK_ADJUSTMENT_POSTED secara atomik."
                : "Hanya pengguna dengan peran Owner yang berwenang menyetujui dan memposting penyesuaian stok ke buku besar."}
            </p>
          </div>

          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setIsFinalizeOpen(true)}
            disabled={isReadOnly || currentRole !== "OWNER"}
            className="whitespace-nowrap"
            title={
              currentRole !== "OWNER"
                ? "Hanya Owner yang berwenang menyetujui penyesuaian"
                : "Buka dialog konfirmasi persetujuan penyesuaian"
            }
          >
            Setujui & Posting Penyesuaian
          </Button>
        </div>
      )}

      {/* Modal Dialog Investigasi Selisih */}
      <StockOpnameInvestigationDialog
        open={isDialogOpen}
        item={selectedItem}
        sessionId={sessionId}
        isReadOnly={isReadOnly}
        onClose={() => {
          setIsDialogOpen(false);
          setSelectedItem(null);
        }}
        onSaved={handleInvestigationSaved}
      />

      {/* Modal Dialog Finalisasi & Persetujuan (Phase 6) */}
      <StockOpnameFinalizeDialog
        open={isFinalizeOpen}
        sessionId={sessionId}
        summary={data}
        currentRole={currentRole}
        onClose={() => setIsFinalizeOpen(false)}
        onSuccess={(result) => {
          setFinalizedMessage(
            `Sesi berhasil disetujui dan berstatus '${result.status}'. ${result.totalAdjustedLines} produk disesuaikan (${result.ledgerEntriesCreated} entri ledger dibuat).`
          );
          loadReconciliation(true);
          onReconciliationUpdated?.();
        }}
      />
    </div>
  );
}

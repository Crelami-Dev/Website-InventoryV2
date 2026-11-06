"use client";

import React, { useState, useMemo } from "react";
import { useActiveContext } from "@/lib/demo/active-context-provider";
import {
  FIXTURE_PRODUCTS,
  FIXTURE_STOCK_HISTORY,
  FIXTURE_SERIALS,
  FIXTURE_OPNAME_SESSIONS,
  FIXTURE_WAREHOUSES,
  Product,
  StockHistoryItem,
  SerialNumberItem,
  Warehouse,
} from "@/lib/demo/inventory-fixtures";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form-fields";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { DownloadIcon } from "@/components/ui/icons";

const PAGE_SIZE = 50;

interface ReportsViewProps {
  initialProducts?: Product[];
  initialLedger?: StockHistoryItem[];
  initialSerials?: SerialNumberItem[];
  initialWarehouses?: Warehouse[];
}

export function ReportsView({
  initialProducts,
  initialLedger,
  initialSerials,
  initialWarehouses,
}: ReportsViewProps = {}) {
  const { currentRole, activeWarehouseId } = useActiveContext();

  const [reportType, setReportType] = useState<"STOCK" | "LEDGER" | "SERIALS" | "OPNAME">("STOCK");
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const productsList = initialProducts && initialProducts.length > 0 ? initialProducts : FIXTURE_PRODUCTS;
  const ledgerList = initialLedger && initialLedger.length > 0 ? initialLedger : FIXTURE_STOCK_HISTORY;
  const serialsList = initialSerials && initialSerials.length > 0 ? initialSerials : FIXTURE_SERIALS;
  const warehousesList = initialWarehouses && initialWarehouses.length > 0 ? initialWarehouses : FIXTURE_WAREHOUSES;

  const availableWarehouses = useMemo(() => {
    if (currentRole === "OWNER") return warehousesList;
    return warehousesList.filter((w) => w.id === activeWarehouseId);
  }, [currentRole, activeWarehouseId, warehousesList]);

  // Data terfilter sesuai gudang & pencarian
  const currentStockData = useMemo(() => {
    return productsList.filter((p) => {
      const matchWh = selectedWarehouseId === "ALL" || p.warehouseId === selectedWarehouseId;
      const matchSearch =
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.sku.toLowerCase().includes(search.toLowerCase());
      return matchWh && matchSearch;
    });
  }, [productsList, selectedWarehouseId, search]);

  const ledgerData = useMemo(() => {
    return ledgerList.filter((h) => {
      const matchSearch =
        h.reference.toLowerCase().includes(search.toLowerCase()) ||
        h.type.toLowerCase().includes(search.toLowerCase());
      return matchSearch;
    });
  }, [ledgerList, search]);

  const serialsData = useMemo(() => {
    return serialsList.filter((s) => {
      const matchWh = selectedWarehouseId === "ALL" || s.warehouseId === selectedWarehouseId;
      const matchSearch =
        s.serialNumber.toLowerCase().includes(search.toLowerCase()) ||
        (s.location && s.location.toLowerCase().includes(search.toLowerCase()));
      return matchWh && matchSearch;
    });
  }, [serialsList, selectedWarehouseId, search]);

  const reportsFiltersKey = JSON.stringify([reportType, selectedWarehouseId, search]);
  const [prevReportsFiltersKey, setPrevReportsFiltersKey] = useState(reportsFiltersKey);
  if (reportsFiltersKey !== prevReportsFiltersKey) {
    setPrevReportsFiltersKey(reportsFiltersKey);
    setPage(1);
  }

  const activeDatasetLength =
    reportType === "STOCK"
      ? currentStockData.length
      : reportType === "LEDGER"
      ? ledgerData.length
      : reportType === "SERIALS"
      ? serialsData.length
      : FIXTURE_OPNAME_SESSIONS.length;

  const totalPages = Math.max(1, Math.ceil(activeDatasetLength / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pagedStockData = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return currentStockData.slice(start, start + PAGE_SIZE);
  }, [currentStockData, safePage]);

  const pagedLedgerData = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return ledgerData.slice(start, start + PAGE_SIZE);
  }, [ledgerData, safePage]);

  const pagedSerialsData = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return serialsData.slice(start, start + PAGE_SIZE);
  }, [serialsData, safePage]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Laporan Inventory"
        description="Ringkasan posisi stok, mutasi kartu persediaan ledger, dan pelacakan riwayat audit per gudang."
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled
            title="Ekspor CSV/Excel memerlukan konfigurasi backend stream (Fase 4)"
          >
            <DownloadIcon className="h-4 w-4" />
            Ekspor Data (Fase 4)
          </Button>
        }
      />


      <div className="rounded border border-info/30 bg-surface-subtle p-3 text-xs text-text-secondary space-y-1">
        <div className="font-semibold text-text-primary">Prinsip Integritas Pelaporan (RPD §7.10 & §8.3):</div>
        <div>
          1. Data persediaan bersumber dari <strong className="text-text-primary">ledger transaksi resmi</strong>, bukan akumulasi saldo yang diedit bebas.
        </div>
        <div>
          2. Pembatasan akses gudang ditegakkan: Staff/Sales hanya melihat laporan gudang penugasannya.
        </div>
        <div>
          3. Kuantitas berbeda satuan (unit, roll, pack) tidak dijumlahkan secara sembarangan tanpa konversi resmi.
        </div>
      </div>

      {/* Kontrol Kategori Laporan & Pemilihan Gudang */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border-default pb-4">
        {/* Tipe Laporan */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={reportType === "STOCK" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setReportType("STOCK")}
          >
            Posisi Stok Terkini
          </Button>
          <Button
            variant={reportType === "LEDGER" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setReportType("LEDGER")}
          >
            Kartu Mutasi Ledger
          </Button>
          <Button
            variant={reportType === "SERIALS" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setReportType("SERIALS")}
          >
            Pelacakan Serial Number
          </Button>
          <Button
            variant={reportType === "OPNAME" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setReportType("OPNAME")}
          >
            Hasil Stock Opname
          </Button>
        </div>

        {/* Filter Gudang */}
        <div className="flex items-center gap-2">
          <label htmlFor="report-wh-select" className="text-xs text-text-muted whitespace-nowrap">
            Cakupan Gudang:
          </label>
          <Select
            id="report-wh-select"
            value={selectedWarehouseId}
            onChange={(e) => setSelectedWarehouseId(e.target.value)}
            className="text-xs py-1"
          >
            {currentRole === "OWNER" && <option value="ALL">Semua Gudang (Agregasi)</option>}
            {availableWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Filter Pencarian */}
      <ListToolbar
        searchPlaceholder="Filter data laporan..."
        searchValue={search}
        onSearchChange={setSearch}
      />

      {/* LAPORAN 1: POSISI STOK TERKINI */}
      {reportType === "STOCK" && (
        <div className="rounded border border-border-default bg-surface-card overflow-hidden">
          <div className="p-4 border-b border-border-default bg-surface-subtle flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Ringkasan Posisi Stok Fisik & Minimum</h2>
            <span className="text-xs text-text-muted font-mono">{currentStockData.length} Produk</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-text-secondary border-collapse">
              <thead className="bg-surface-subtle text-text-muted uppercase font-medium border-b border-border-default">
                <tr>
                  <th className="p-3">SKU</th>
                  <th className="p-3">Nama Produk</th>
                  <th className="p-3">Kategori</th>
                  <th className="p-3">Tracking</th>
                  <th className="p-3 text-right">Stok Fisik</th>
                  <th className="p-3 text-right">Ambang Min</th>
                  <th className="p-3">Status Persediaan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {currentStockData.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-text-muted">
                      Tidak ada data produk yang cocok.
                    </td>
                  </tr>
                ) : (
                  pagedStockData.map((p) => {
                    const isLow = p.stock <= (p.minStock ?? 0);
                    return (
                      <tr key={p.id} className="hover:bg-surface-subtle/50 transition-colors">
                        <td className="p-3 font-mono text-text-muted">{p.sku}</td>
                        <td className="p-3 font-semibold text-text-primary">{p.name}</td>
                        <td className="p-3">{p.category}</td>
                        <td className="p-3">
                          <Badge variant={p.tracking === "SERIAL" ? "neutral" : "outline"} size="sm">
                            {p.tracking}
                          </Badge>
                        </td>
                        <td className="p-3 text-right font-mono font-bold text-text-primary">
                          <div>{p.stock} {p.unit}</div>
                          {(p as any).groupedStock > 0 && (
                            <div className="text-[10px] text-info font-normal">
                              {(p as any).availableStandaloneStock ?? p.stock} mandiri / {(p as any).groupedStock} group
                            </div>
                          )}
                        </td>

                        <td className="p-3 text-right font-mono text-text-muted">
                          {p.minStock} {p.unit}
                        </td>
                        <td className="p-3">
                          <Badge variant={isLow ? "danger" : "success"} size="sm">
                            {isLow ? "Stok Menipis" : "Aman"}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* LAPORAN 2: KARTU MUTASI LEDGER */}
      {reportType === "LEDGER" && (
        <div className="rounded border border-border-default bg-surface-card overflow-hidden">
          <div className="p-4 border-b border-border-default bg-surface-subtle flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Kartu Mutasi Persediaan (Ledger Resmi)</h2>
            <span className="text-xs text-text-muted">Jejak Pergerakan Transaksi</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-text-secondary border-collapse">
              <thead className="bg-surface-subtle text-text-muted uppercase font-medium border-b border-border-default">
                <tr>
                  <th className="p-3">Waktu</th>
                  <th className="p-3">Referensi Transaksi</th>
                  <th className="p-3">Tipe Mutasi</th>
                  <th className="p-3 text-right">Perubahan Qty</th>
                  <th className="p-3 text-right">Saldo Sesudah</th>
                  <th className="p-3">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {ledgerData.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-text-muted">
                      Tidak ada rekaman transaksi ledger.
                    </td>
                  </tr>
                ) : (
                  pagedLedgerData.map((h) => (
                    <tr key={h.id} className="hover:bg-surface-subtle/50 transition-colors">
                      <td className="p-3 font-mono text-text-muted">{h.timestamp}</td>
                      <td className="p-3 font-mono font-semibold text-text-primary">{h.reference}</td>
                      <td className="p-3">
                        <Badge
                          variant={
                            h.type === "GOODS_IN"
                              ? "success"
                              : h.type === "GOODS_OUT"
                              ? "info"
                              : "warning"
                          }
                          size="sm"
                        >
                          {h.type}
                        </Badge>
                      </td>
                      <td className="p-3 text-right font-mono font-bold">
                        <span className={h.changeQty > 0 ? "text-success" : "text-danger"}>
                          {h.changeQty > 0 ? `+${h.changeQty}` : h.changeQty}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono font-semibold text-text-primary">
                        {h.balanceQty}
                      </td>
                      <td className="p-3 text-text-muted">{h.note || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* LAPORAN 3: PELACAKAN SERIAL NUMBER */}
      {reportType === "SERIALS" && (
        <div className="rounded border border-border-default bg-surface-card overflow-hidden">
          <div className="p-4 border-b border-border-default bg-surface-subtle flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Audit Unit & Serial Number</h2>
            <span className="text-xs text-text-muted font-mono">{serialsData.length} Unit SN</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-text-secondary border-collapse">
              <thead className="bg-surface-subtle text-text-muted uppercase font-medium border-b border-border-default">
                <tr>
                  <th className="p-3">Nomor Seri (SN)</th>
                  <th className="p-3">Gudang</th>
                  <th className="p-3">Lokasi / Rak</th>
                  <th className="p-3">Status Unit</th>
                  <th className="p-3">Referensi Terakhir</th>
                  <th className="p-3">Penerimaan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {serialsData.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-text-muted">
                      Tidak ada Serial Number yang tercatat.
                    </td>
                  </tr>
                ) : (
                  pagedSerialsData.map((s) => {
                    const wh = FIXTURE_WAREHOUSES.find((w) => w.id === s.warehouseId);
                    return (
                      <tr key={s.id} className="hover:bg-surface-subtle/50 transition-colors">
                        <td className="p-3 font-mono font-semibold text-text-primary">{s.serialNumber}</td>
                        <td className="p-3 text-text-muted">{wh?.name || s.warehouseId}</td>
                        <td className="p-3 font-mono">{s.location || "-"}</td>
                        <td className="p-3">
                          <Badge
                            variant={
                              s.status === "AVAILABLE"
                                ? "success"
                                : s.status === "RESERVED"
                                ? "warning"
                                : "neutral"
                            }
                            size="sm"
                          >
                            {s.status}
                          </Badge>
                        </td>
                        <td className="p-3 font-mono text-text-muted">{s.lastReference || "-"}</td>
                        <td className="p-3 font-mono text-text-muted">{s.receivedAt}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

        </div>
      )}

      {/* LAPORAN 4: HASIL STOCK OPNAME */}
      {reportType === "OPNAME" && (
        <div className="rounded border border-border-default bg-surface-card overflow-hidden">
          <div className="p-4 border-b border-border-default bg-surface-subtle flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Riwayat Evaluasi Stock Opname</h2>
            <span className="text-xs text-text-muted">Snapshot & Rekonsiliasi Lapangan</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-text-secondary border-collapse">
              <thead className="bg-surface-subtle text-text-muted uppercase font-medium border-b border-border-default">
                <tr>
                  <th className="p-3">Nomor Sesi</th>
                  <th className="p-3">Gudang</th>
                  <th className="p-3">Cakupan</th>
                  <th className="p-3">Waktu Dibuat</th>
                  <th className="p-3 text-center">Jumlah Item</th>
                  <th className="p-3 text-center">Selisih Ditemukan</th>
                  <th className="p-3">Status Sesi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {FIXTURE_OPNAME_SESSIONS.map((sess) => (
                  <tr key={sess.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="p-3 font-mono font-semibold text-text-primary">{sess.sessionNumber}</td>
                    <td className="p-3 font-medium text-text-primary">{sess.warehouseName}</td>
                    <td className="p-3">{sess.scope}</td>
                    <td className="p-3 font-mono text-text-muted">{sess.createdAt}</td>
                    <td className="p-3 text-center font-mono">{sess.itemCount}</td>
                    <td className="p-3 text-center font-mono">
                      <span className={sess.varianceCount > 0 ? "text-danger font-semibold" : "text-success"}>
                        {sess.varianceCount}
                      </span>
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={
                          sess.status === "COMPLETED"
                            ? "success"
                            : sess.status === "REVIEW"
                            ? "warning"
                            : "info"
                        }
                        size="sm"
                      >
                        {sess.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Paginasi Laporan (Maksimal 50 Data per Halaman) */}
      {activeDatasetLength > 0 && (
        <div className="rounded-lg border border-border bg-surface">
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={activeDatasetLength}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

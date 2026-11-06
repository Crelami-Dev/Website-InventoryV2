"use client";

import React, { useState, useMemo, useTransition } from "react";
import { useActiveContext } from "@/lib/demo/active-context-provider";
import {
  ReturnItem,
  Partner,
  Product,
  FIXTURE_RETURNS,
  FIXTURE_PARTNERS,
  FIXTURE_PRODUCTS,
} from "@/lib/demo/inventory-fixtures";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Badge, Alert, FeedbackState } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/form-fields";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { PlusIcon, EyeIcon, RotateCcwIcon, TrashIcon, CheckCircleIcon } from "@/components/ui/icons";
import {
  createInventoryReturnAction,
  approveAndReceiveReturnAction,
  cancelInventoryReturnAction,
  revertInventoryReturnAction,
} from "@/lib/inventory/actions";

const PAGE_SIZE = 50;

export interface ReturnsViewProps {
  initialReturns?: ReturnItem[];
  initialPartners?: Partner[];
  initialProducts?: Product[];
}

export function ReturnsView({
  initialReturns = [],
  initialPartners = [],
  initialProducts = [],
}: ReturnsViewProps) {
  const { currentRole, activeWarehouseId, activeWarehouse } = useActiveContext();
  const [returns, setReturns] = useState<ReturnItem[]>(
    initialReturns.length > 0 ? initialReturns : FIXTURE_RETURNS
  );
  const partners = useMemo(
    () => (initialPartners.length > 0 ? initialPartners : FIXTURE_PARTNERS),
    [initialPartners]
  );
  const products = useMemo(
    () => (initialProducts.length > 0 ? initialProducts : FIXTURE_PRODUCTS),
    [initialProducts]
  );

  // Tab State: Retur Pelanggan vs Retur Supplier
  const [activeTab, setActiveTab] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");

  const [search, setSearch] = useState("");
  const [reasonFilter, setReasonFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [isPending, startTransition] = useTransition();

  // Modal State
  const [selectedReturn, setSelectedReturn] = useState<ReturnItem | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [cancelDraftTarget, setCancelDraftTarget] = useState<ReturnItem | null>(null);
  const [revertTarget, setRevertTarget] = useState<ReturnItem | null>(null);
  const [revertReason, setRevertReason] = useState("");

  // Form State Buat Retur Baru
  const [createType, setCreateType] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");
  const customerPartners = useMemo(() => partners.filter((p) => p.type === "CUSTOMER"), [partners]);
  const supplierPartners = useMemo(() => partners.filter((p) => p.type === "SUPPLIER"), [partners]);

  const [partnerId, setPartnerId] = useState(customerPartners[0]?.id || partners[0]?.id || "");
  const [productId, setProductId] = useState(products[0]?.id || "");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState<ReturnItem["reason"]>("SALAH_KIRIM");
  const [condition, setCondition] = useState<"BAIK" | "RUSAK">("BAIK");
  const [serialNumbers, setSerialNumbers] = useState("");
  const [notes, setNotes] = useState("");
  const [returnError, setReturnError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Hitung jumlah untuk counter badge pada tab
  const customerReturnsCount = useMemo(() => {
    return returns.filter((r) => r.returnType !== "SUPPLIER_RETURN").length;
  }, [returns]);

  const supplierReturnsCount = useMemo(() => {
    return returns.filter((r) => r.returnType === "SUPPLIER_RETURN").length;
  }, [returns]);

  const willReopenQty =
    reason === "SALAH_KIRIM" || reason === "PEMBATALAN" || reason === "SALAH_INPUT";

  const filteredReturns = useMemo(() => {
    return returns.filter((ret) => {
      // 1. Filter Tab Retur Pelanggan vs Supplier
      const isSupplier = ret.returnType === "SUPPLIER_RETURN";
      if (activeTab === "CUSTOMER" && isSupplier) return false;
      if (activeTab === "SUPPLIER" && !isSupplier) return false;

      // 2. Isolasi gudang jika staff/sales
      if (currentRole !== "OWNER" && ret.warehouseId !== activeWarehouseId) {
        return false;
      }

      // 3. Pencarian
      const matchSearch =
        ret.returnNumber.toLowerCase().includes(search.toLowerCase()) ||
        ret.sourceReference.toLowerCase().includes(search.toLowerCase()) ||
        ret.partnerName.toLowerCase().includes(search.toLowerCase());

      // 4. Filter Alasan
      const matchReason = reasonFilter === "ALL" || ret.reason === reasonFilter;

      // 5. Filter Status
      let matchStatus = true;
      if (statusFilter !== "ALL") {
        if (statusFilter === "DRAFT") {
          matchStatus = ret.status === "DRAFT" || ret.status === "PENDING_REVIEW";
        } else if (statusFilter === "RECEIVED") {
          matchStatus = ret.status === "RECEIVED" || ret.status === "COMPLETED" || ret.status === "APPROVED";
        } else if (statusFilter === "CANCELLED") {
          matchStatus = ret.status === "CANCELLED" || ret.status === "REJECTED";
        }
      }

      return matchSearch && matchReason && matchStatus;
    });
  }, [returns, activeTab, currentRole, activeWarehouseId, search, reasonFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredReturns.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedReturns = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredReturns.slice(start, start + PAGE_SIZE);
  }, [filteredReturns, safePage]);

  // Handler Submit Buat Retur Manual
  const handleCreateReturn = (e: React.FormEvent) => {
    e.preventDefault();
    setReturnError(null);

    const partnerList = createType === "CUSTOMER" ? customerPartners : supplierPartners;
    const currentPartner = partnerList.find((p) => p.id === partnerId) || partnerList[0] || partners[0];
    if (!currentPartner) {
      setReturnError(`${createType === "CUSTOMER" ? "Pelanggan" : "Pemasok"} harus dipilih.`);
      return;
    }

    const prod = products.find((p) => p.id === productId) || products[0];
    if (!prod) {
      setReturnError("Produk harus dipilih.");
      return;
    }

    const parsedSerials = serialNumbers
      .split(/[\n,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const newNumber = createType === "CUSTOMER"
      ? `RET-CUST-${Date.now().toString().slice(-6)}`
      : `RET-SUP-${Date.now().toString().slice(-6)}`;

    if (isPending) return;

    startTransition(async () => {
      const res = await createInventoryReturnAction({
        warehouseId: activeWarehouseId,
        returnType: createType === "CUSTOMER" ? "CUSTOMER_RETURN" : "SUPPLIER_RETURN",
        customerId: createType === "CUSTOMER" ? currentPartner.id : undefined,
        supplierId: createType === "SUPPLIER" ? currentPartner.id : undefined,
        returnNumber: newNumber,
        returnDate: new Date().toISOString().slice(0, 10),
        reason,
        notes: notes.trim() || undefined,
        lines: [
          {
            productId: prod.id,
            quantity: Number(quantity) || 1,
            unit: prod.unit || "unit",
            condition,
            returnedSerials: parsedSerials.length > 0 ? parsedSerials : undefined,
          },
        ],
      });

      if (!res.success) {
        setReturnError(res.error || "Gagal membuat dokumen retur.");
        return;
      }

      const created = res.returnRecord;
      const willReopen = reason === "SALAH_KIRIM" || reason === "PEMBATALAN" || reason === "SALAH_INPUT";
      const newReturn: ReturnItem = {
        id: created?.id || `ret-${Date.now()}`,
        returnNumber: created?.returnNumber || newNumber,
        returnType: createType === "CUSTOMER" ? "CUSTOMER_RETURN" : "SUPPLIER_RETURN",
        sourceReference: createType === "CUSTOMER" ? "GO-LANGSUNG" : "GI-LANGSUNG",
        warehouseId: activeWarehouseId,
        warehouseName: activeWarehouse?.name || "Gudang Aktif",
        date: created?.returnDate || new Date().toISOString().slice(0, 10),
        partnerName: currentPartner.name,
        reason,
        reopenSourceQty: willReopen,
        status: "DRAFT",
        notes: notes.trim() || undefined,
        items: [
          {
            productId: prod.id,
            productName: prod.name,
            qty: Number(quantity) || 1,
            unit: prod.unit || "unit",
            condition,
            serialNumbers: parsedSerials.length > 0 ? parsedSerials : undefined,
          },
        ],
      };

      setReturns((prev) => [newReturn, ...prev]);
      setIsCreateOpen(false);
      setStatusMessage(
        `Pengajuan retur ${newReturn.returnNumber} berhasil dibuat dengan status DRAFT (belum mempengaruhi saldo stok fisik sebelum persetujuan).`
      );
    });
  };

  // Handler Persetujuan & Penerimaan Fisik Retur
  const handleApproveAndReceive = (ret: ReturnItem) => {
    if (isPending) return;
    setReturnError(null);
    startTransition(async () => {
      const res = await approveAndReceiveReturnAction(ret.id);
      if (!res.success) {
        setReturnError(res.error || "Gagal memproses persetujuan retur.");
        return;
      }

      setReturns((prev) =>
        prev.map((item) =>
          item.id === ret.id ? { ...item, status: "RECEIVED" } : item
        )
      );

      if (selectedReturn?.id === ret.id) {
        setSelectedReturn((prev) => (prev ? { ...prev, status: "RECEIVED" } : null));
      }

      const isSupplier = ret.returnType === "SUPPLIER_RETURN";
      setStatusMessage(
        isSupplier
          ? `Retur supplier ${ret.returnNumber} berhasil disetujui & diposting ke ledger (RETURN_OUT_POSTED). Stok telah dipotong dari gudang.`
          : `Retur pelanggan ${ret.returnNumber} resmi disetujui & diterima fisik. Mutasi stok fisik RETURN_IN_POSTED telah dicatat di ledger.${ret.reopenSourceQty ? " Kuota pemenuhan pesanan dibuka kembali." : ""}`
      );
    });
  };

  // Handler Batalkan Draft
  const handleConfirmCancelDraft = () => {
    if (!cancelDraftTarget || isPending) return;
    startTransition(async () => {
      const res = await cancelInventoryReturnAction(cancelDraftTarget.id, "Dibatalkan oleh staf gudang.");
      if (!res.success) {
        setReturnError(res.error || "Gagal membatalkan draft retur.");
        return;
      }

      setReturns((prev) =>
        prev.map((item) =>
          item.id === cancelDraftTarget.id ? { ...item, status: "CANCELLED" } : item
        )
      );

      if (selectedReturn?.id === cancelDraftTarget.id) {
        setSelectedReturn((prev) => (prev ? { ...prev, status: "CANCELLED" } : null));
      }

      setStatusMessage(`Draft dokumen retur ${cancelDraftTarget.returnNumber} berhasil dibatalkan.`);
      setCancelDraftTarget(null);
    });
  };

  // Handler Revert / Batalkan Retur yang Sudah RECEIVED
  const handleConfirmRevert = () => {
    if (!revertTarget || !revertReason.trim() || isPending) return;
    startTransition(async () => {
      const res = await revertInventoryReturnAction(revertTarget.id, revertReason.trim());
      if (!res.success) {
        setReturnError(res.error || "Gagal membatalkan (revert) retur.");
        return;
      }

      setReturns((prev) =>
        prev.map((item) =>
          item.id === revertTarget.id ? { ...item, status: "CANCELLED" } : item
        )
      );

      if (selectedReturn?.id === revertTarget.id) {
        setSelectedReturn((prev) => (prev ? { ...prev, status: "CANCELLED" } : null));
      }

      setStatusMessage(
        `Retur ${revertTarget.returnNumber} berhasil dibatalkan (Reverted). Mutasi ledger pembalik RETURN_REVERSAL_POSTED telah dicatat secara resmi.`
      );
      setRevertTarget(null);
      setRevertReason("");
    });
  };

  const getReasonBadge = (r: ReturnItem["reason"]) => {
    switch (r) {
      case "SALAH_KIRIM":
        return <Badge variant="warning">Salah Kirim</Badge>;
      case "PEMBATALAN":
        return <Badge variant="neutral">Pembatalan</Badge>;
      case "SALAH_INPUT":
        return <Badge variant="info">Salah Input</Badge>;
      case "CACAT":
        return <Badge variant="danger">Barang Cacat/Rusak</Badge>;
      case "LAINNYA":
        return <Badge variant="outline">Lainnya</Badge>;
      default:
        return <Badge variant="neutral">{r}</Badge>;
    }
  };

  // Badge Status Konsisten Sesuai Spesifikasi:
  // DRAFT (kuning), RECEIVED / COMPLETED (hijau), CANCELLED (abu-abu/merah)
  const getStatusBadge = (s: ReturnItem["status"]) => {
    switch (s) {
      case "DRAFT":
      case "PENDING_REVIEW":
        return <Badge variant="warning">DRAFT</Badge>;
      case "RECEIVED":
      case "COMPLETED":
      case "APPROVED":
        return <Badge variant="success">RECEIVED</Badge>;
      case "CANCELLED":
      case "REJECTED":
        return <Badge variant="danger">CANCELLED</Badge>;
      default:
        return <Badge variant="neutral">{s}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Retur Barang"
        description="Kelola pengembalian barang dari pelanggan (Customer Returns) maupun pengembalian ke pemasok (Supplier Returns) dengan kepatuhan buku besar ledger."
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setReturnError(null);
              setIsCreateOpen(true);
            }}
          >
            <PlusIcon className="h-4 w-4 mr-1" />
            Buat Pengajuan Retur
          </Button>
        }
      />

      {/* Tabs Pemisah Retur Pelanggan vs Retur Supplier */}
      <div className="flex border-b border-border-default">
        <button
          type="button"
          onClick={() => {
            setActiveTab("CUSTOMER");
            setPage(1);
          }}
          className={`flex items-center gap-2 px-5 py-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
            activeTab === "CUSTOMER"
              ? "border-primary text-primary bg-primary/5"
              : "border-transparent text-text-muted hover:text-text-primary hover:bg-surface-subtle"
          }`}
        >
          <span>Retur Pelanggan (Customer Returns)</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              activeTab === "CUSTOMER"
                ? "bg-primary text-surface"
                : "bg-surface-muted text-text-muted"
            }`}
          >
            {customerReturnsCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab("SUPPLIER");
            setPage(1);
          }}
          className={`flex items-center gap-2 px-5 py-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
            activeTab === "SUPPLIER"
              ? "border-primary text-primary bg-primary/5"
              : "border-transparent text-text-muted hover:text-text-primary hover:bg-surface-subtle"
          }`}
        >
          <span>Retur ke Supplier (Supplier Returns)</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              activeTab === "SUPPLIER"
                ? "bg-primary text-surface"
                : "bg-surface-muted text-text-muted"
            }`}
          >
            {supplierReturnsCount}
          </span>
        </button>
      </div>

      {/* Kebijakan Ledger & Reopen */}
      <div className="rounded border border-info/30 bg-surface-subtle p-3 text-xs text-text-secondary space-y-1">
        <div className="font-semibold text-text-primary">
          {activeTab === "CUSTOMER"
            ? "Kebijakan Retur Pelanggan (Inbound / Goods Out Return):"
            : "Kebijakan Retur ke Supplier (Outbound / Goods In Return):"}
        </div>
        {activeTab === "CUSTOMER" ? (
          <>
            <div>
              1. Status <strong className="text-amber-600 dark:text-amber-400">DRAFT</strong> belum memutasi stok fisik sebelum disetujui (Terima Fisik & Setujui).
            </div>
            <div>
              2. Persetujuan retur mencatat mutasi ledger <span className="font-mono font-semibold text-success">RETURN_IN_POSTED</span> (+qty) dan serial kembali <span className="font-semibold text-success">AVAILABLE</span> (atau <span className="font-semibold text-danger">QUARANTINE</span> jika rusak).
            </div>
            <div>
              3. Pembatalan retur (Revert) mencatat mutasi pembalik <span className="font-mono font-semibold text-danger">RETURN_REVERSAL_POSTED</span> (-qty) dan serial kembali <span className="font-mono text-text-primary">CONSUMED_OUT</span>.
            </div>
          </>
        ) : (
          <>
            <div>
              1. Pengembalian ke vendor memotong stok fisik gudang melalui mutasi ledger <span className="font-mono font-semibold text-danger">RETURN_OUT_POSTED</span> (-qty).
            </div>
            <div>
              2. Hanya serial yang berstatus <span className="font-semibold text-success">AVAILABLE</span> di gudang yang dapat dikembalikan ke supplier.
            </div>
            <div>
              3. Revert retur supplier memulihkan stok fisik melalui <span className="font-mono font-semibold text-success">RETURN_REVERSAL_POSTED</span> (+qty) dan serial kembali <span className="font-semibold text-success">AVAILABLE</span>.
            </div>
          </>
        )}
      </div>

      {statusMessage && (
        <Alert
          variant="success"
          title="Berhasil"
          description={statusMessage}
        />
      )}

      {/* Toolbar Filter */}
      <ListToolbar
        searchPlaceholder={
          activeTab === "CUSTOMER"
            ? "Cari nomor retur, referensi DO, atau pelanggan..."
            : "Cari nomor retur, referensi barang masuk, atau pemasok..."
        }
        searchValue={search}
        onSearchChange={setSearch}
        filters={
          <div className="flex gap-2">
            <div className="w-40">
              <label htmlFor="ret-reason-filter" className="sr-only">Alasan Retur</label>
              <Select
                id="ret-reason-filter"
                value={reasonFilter}
                onChange={(e) => setReasonFilter(e.target.value)}
              >
                <option value="ALL">Semua Alasan</option>
                <option value="SALAH_KIRIM">Salah Kirim</option>
                <option value="PEMBATALAN">Pembatalan</option>
                <option value="SALAH_INPUT">Salah Input</option>
                <option value="CACAT">Cacat / Rusak</option>
                <option value="LAINNYA">Lainnya</option>
              </Select>
            </div>
            <div className="w-40">
              <label htmlFor="ret-status-filter" className="sr-only">Status Retur</label>
              <Select
                id="ret-status-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="ALL">Semua Status</option>
                <option value="DRAFT">DRAFT (Kuning)</option>
                <option value="RECEIVED">RECEIVED (Hijau)</option>
                <option value="CANCELLED">CANCELLED (Merah)</option>
              </Select>
            </div>
          </div>
        }
      />

      {/* Desktop Table View */}
      <div className="hidden md:block rounded border border-border-default bg-surface-card overflow-hidden">
        <table className="w-full text-left text-xs text-text-secondary border-collapse">
          <thead className="bg-surface-subtle text-text-muted border-b border-border-default uppercase font-medium">
            <tr>
              <th className="p-3">Nomor Retur</th>
              <th className="p-3">Referensi Sumber</th>
              <th className="p-3">{activeTab === "CUSTOMER" ? "Pelanggan" : "Pemasok"}</th>
              <th className="p-3">Gudang</th>
              <th className="p-3">Alasan Retur</th>
              <th className="p-3 text-center">Reopen Kuota</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {filteredReturns.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-text-muted">
                  Tidak ada data retur {activeTab === "CUSTOMER" ? "pelanggan" : "supplier"} yang cocok dengan kriteria filter.
                </td>
              </tr>
            ) : (
              pagedReturns.map((ret) => {
                const isDraft = ret.status === "DRAFT" || ret.status === "PENDING_REVIEW";
                const isReceived = ret.status === "RECEIVED" || ret.status === "COMPLETED" || ret.status === "APPROVED";

                return (
                  <tr key={ret.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="p-3 font-mono font-semibold text-text-primary">{ret.returnNumber}</td>
                    <td className="p-3 font-mono text-text-muted">{ret.sourceReference}</td>
                    <td className="p-3 font-medium text-text-primary">{ret.partnerName}</td>
                    <td className="p-3 text-text-muted">{ret.warehouseName}</td>
                    <td className="p-3">{getReasonBadge(ret.reason)}</td>
                    <td className="p-3 text-center">
                      <Badge variant={ret.reopenSourceQty ? "success" : "neutral"} size="sm">
                        {ret.reopenSourceQty ? "YA" : "TIDAK"}
                      </Badge>
                    </td>
                    <td className="p-3">{getStatusBadge(ret.status)}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Aksi untuk DRAFT */}
                        {isDraft && (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => handleApproveAndReceive(ret)}
                              disabled={isPending}
                              loading={isPending}
                              loadingLabel="Memproses..."
                              title="Setujui dan posting mutasi stok ke buku besar ledger"
                            >
                              <CheckCircleIcon className="h-3.5 w-3.5 mr-1" />
                              Terima Fisik & Setujui
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setCancelDraftTarget(ret)}
                              disabled={isPending}
                              className="text-danger hover:bg-danger/10"
                              title="Batalkan dokumen draft ini"
                            >
                              <TrashIcon className="h-3.5 w-3.5 mr-1" />
                              Batalkan Draft
                            </Button>
                          </>
                        )}

                        {/* Aksi untuk RECEIVED / COMPLETED */}
                        {isReceived && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setRevertTarget(ret);
                              setRevertReason("");
                            }}
                            disabled={isPending}
                            className="text-danger border-danger/30 hover:bg-danger/10"
                            title="Batalkan retur yang sudah diterima dengan mencatat jurnal pembalik"
                          >
                            <RotateCcwIcon className="h-3.5 w-3.5 mr-1" />
                            Batalkan Retur (Revert)
                          </Button>
                        )}

                        {/* Tombol Detail */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedReturn(ret)}
                          aria-label={`Lihat detail ${ret.returnNumber}`}
                        >
                          <EyeIcon className="h-4 w-4" />
                          Detail
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {filteredReturns.length === 0 ? (
          <FeedbackState
            title="Tidak Ada Data Retur"
            description="Tidak ada dokumen retur yang cocok dengan filter."
          />
        ) : (
          pagedReturns.map((ret) => {
            const isDraft = ret.status === "DRAFT" || ret.status === "PENDING_REVIEW";
            const isReceived = ret.status === "RECEIVED" || ret.status === "COMPLETED" || ret.status === "APPROVED";

            return (
              <div
                key={ret.id}
                className="p-4 rounded border border-border-default bg-surface-card space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-semibold text-text-primary">{ret.returnNumber}</span>
                  {getStatusBadge(ret.status)}
                </div>
                <div className="text-sm font-medium text-text-primary">{ret.partnerName}</div>
                <div className="flex items-center justify-between text-xs text-text-muted font-mono">
                  <span>Sumber: {ret.sourceReference}</span>
                  <span>Tgl: {ret.date}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-t border-border-default pt-2">
                  <div>{getReasonBadge(ret.reason)}</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {isDraft && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleApproveAndReceive(ret)}
                          disabled={isPending}
                        >
                          Setujui
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCancelDraftTarget(ret)}
                          disabled={isPending}
                          className="text-danger"
                        >
                          Batal
                        </Button>
                      </>
                    )}
                    {isReceived && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setRevertTarget(ret);
                          setRevertReason("");
                        }}
                        disabled={isPending}
                        className="text-danger"
                      >
                        Revert
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setSelectedReturn(ret)}
                    >
                      Detail
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Paginasi Retur */}
      {filteredReturns.length > 0 && (
        <div className="rounded-lg border border-border bg-surface">
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filteredReturns.length}
            onPageChange={setPage}
          />
        </div>
      )}

      {/* Modal Detail Retur */}
      <Dialog
        isOpen={Boolean(selectedReturn)}
        onClose={() => setSelectedReturn(null)}
        title={`Detail Dokumen Retur: ${selectedReturn?.returnNumber || ""}`}
        description={`Jenis: ${selectedReturn?.returnType === "SUPPLIER_RETURN" ? "Retur ke Supplier" : "Retur Pelanggan"} | Sumber: ${selectedReturn?.sourceReference || ""} | Gudang: ${selectedReturn?.warehouseName || ""}`}
      >
        {selectedReturn && (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 rounded bg-surface-subtle border border-border-default">
              <span className="text-xs text-text-secondary">Status Retur Saat Ini:</span>
              {getStatusBadge(selectedReturn.status)}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded border border-border-default bg-surface-card">
                <div className="text-text-muted">Alasan Pengembalian:</div>
                <div className="mt-1 font-semibold text-text-primary">{selectedReturn.reason}</div>
              </div>
              <div className="p-3 rounded border border-border-default bg-surface-card">
                <div className="text-text-muted">Reopen Source Qty:</div>
                <div className="mt-1 font-semibold text-text-primary">
                  {selectedReturn.reopenSourceQty
                    ? "YA (Kuota Pesanan Dibuka Kembali)"
                    : "TIDAK (Kuota Tetap Terpotong)"}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-text-primary">Daftar Item yang Diretur:</div>
              <div className="rounded border border-border-default overflow-hidden">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-surface-subtle text-text-muted uppercase">
                    <tr>
                      <th className="p-2.5">Produk</th>
                      <th className="p-2.5 text-center">Kuantitas</th>
                      <th className="p-2.5">Kondisi Fisik</th>
                      <th className="p-2.5">Nomor Seri (SN)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-default">
                    {selectedReturn.items.map((item, idx) => (
                      <tr key={idx}>
                        <td className="p-2.5 font-medium text-text-primary">{item.productName}</td>
                        <td className="p-2.5 text-center font-mono">
                          {item.qty} {item.unit}
                        </td>
                        <td className="p-2.5">
                          <Badge variant={item.condition === "BAIK" ? "success" : "danger"} size="sm">
                            {item.condition}
                          </Badge>
                        </td>
                        <td className="p-2.5 font-mono text-[11px] text-text-muted">
                          {item.serialNumbers && item.serialNumbers.length > 0
                            ? item.serialNumbers.join(", ")
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedReturn.notes && (
              <div className="text-xs text-text-secondary bg-surface-subtle p-3 rounded border border-border-default">
                <span className="font-semibold text-text-primary">Catatan:</span> {selectedReturn.notes}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-default">
              {(selectedReturn.status === "DRAFT" || selectedReturn.status === "PENDING_REVIEW") && (
                <Button
                  variant="primary"
                  onClick={() => handleApproveAndReceive(selectedReturn)}
                  disabled={isPending}
                  loading={isPending}
                  loadingLabel="Memproses..."
                >
                  <CheckCircleIcon className="h-4 w-4 mr-1.5" />
                  Terima Fisik & Setujui
                </Button>
              )}
              {(selectedReturn.status === "RECEIVED" || selectedReturn.status === "COMPLETED" || selectedReturn.status === "APPROVED") && (
                <Button
                  variant="danger"
                  onClick={() => {
                    setRevertTarget(selectedReturn);
                    setSelectedReturn(null);
                    setRevertReason("");
                  }}
                  disabled={isPending}
                >
                  <RotateCcwIcon className="h-4 w-4 mr-1.5" />
                  Batalkan Retur (Revert)
                </Button>
              )}
              <Button variant="secondary" onClick={() => setSelectedReturn(null)}>
                Tutup
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Dialog Konfirmasi Revert (Batalkan Retur RECEIVED) */}
      {revertTarget && (
        <Dialog
          isOpen={Boolean(revertTarget)}
          onClose={() => setRevertTarget(null)}
          title={`Batalkan Transaksi Retur (Revert): ${revertTarget.returnNumber}`}
          description="Aksi ini akan mencatat jurnal mutasi pembalik RETURN_REVERSAL_POSTED, membatalkan penyesuaian stok sebelumnya, dan memulihkan status nomor seri ke kondisi asal."
        >
          <div className="space-y-4">
            <Alert
              variant="warning"
              title="Perhatian Reversal Stok"
              description="Pastikan fisik barang benar-benar dikoreksi. Serial number yang dikembalikan ke pelanggan akan kembali menjadi CONSUMED_OUT, sedangkan pada retur supplier akan kembali AVAILABLE di gudang."
            />

            <div className="space-y-1.5">
              <label htmlFor="revert-reason" className="text-xs font-semibold text-text-primary block">
                Alasan Pembatalan (Revert) Retur *
              </label>
              <textarea
                id="revert-reason"
                className="w-full rounded border border-border-strong bg-surface p-2 text-xs text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                placeholder="Contoh: Salah proses dokumen retur, barang fisik tidak jadi diserahkan oleh pelanggan..."
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                autoFocus
                required
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-default">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setRevertTarget(null)}
                disabled={isPending}
              >
                Kembali
              </Button>
              <Button
                variant="danger"
                type="button"
                onClick={handleConfirmRevert}
                disabled={isPending || !revertReason.trim()}
                loading={isPending}
                loadingLabel="Memproses Revert..."
              >
                <RotateCcwIcon className="h-4 w-4 mr-1.5" />
                Ya, Batalkan Retur Ini (Revert)
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Dialog Konfirmasi Batalkan Draft */}
      {cancelDraftTarget && (
        <Dialog
          isOpen={Boolean(cancelDraftTarget)}
          onClose={() => setCancelDraftTarget(null)}
          title={`Batalkan Draft Retur: ${cancelDraftTarget.returnNumber}`}
          description="Draft retur ini belum dicatat di buku besar mutasi stok ledger. Pembatalan akan mengubah status menjadi CANCELLED secara permanen."
        >
          <div className="space-y-4">
            <p className="text-xs text-text-secondary">
              Apakah Anda yakin ingin membatalkan pengajuan retur untuk mitra{" "}
              <strong className="text-text-primary">{cancelDraftTarget.partnerName}</strong>?
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-default">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setCancelDraftTarget(null)}
                disabled={isPending}
              >
                Kembali
              </Button>
              <Button
                variant="danger"
                type="button"
                onClick={handleConfirmCancelDraft}
                disabled={isPending}
                loading={isPending}
                loadingLabel="Membatalkan..."
              >
                <TrashIcon className="h-4 w-4 mr-1.5" />
                Ya, Batalkan Draft
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Modal Buat Pengajuan Retur Baru */}
      <Dialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Buat Pengajuan Retur Baru"
        description="Pencatatan pengembalian barang dan penetapan kebijakan kuantitas sumber pemenuhan."
      >
        <form onSubmit={handleCreateReturn} className="space-y-4">
          {returnError && (
            <Alert variant="danger" title="Kesalahan Form" description={returnError} />
          )}

          {/* Pemilihan Jenis Retur */}
          <div className="p-3 rounded-lg border border-border-default bg-surface-subtle space-y-2">
            <span className="text-xs font-semibold text-text-primary block">Pilih Alur Retur:</span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label
                className={`flex items-center gap-2 p-2 rounded border cursor-pointer ${
                  createType === "CUSTOMER"
                    ? "border-primary bg-primary/10 font-bold text-primary"
                    : "border-border-default bg-surface text-text-secondary hover:bg-surface-hover"
                }`}
              >
                <input
                  type="radio"
                  name="return-type-radio"
                  checked={createType === "CUSTOMER"}
                  onChange={() => {
                    setCreateType("CUSTOMER");
                    setPartnerId(customerPartners[0]?.id || "");
                  }}
                  className="text-primary"
                />
                <span>Retur Pelanggan (Inbound)</span>
              </label>

              <label
                className={`flex items-center gap-2 p-2 rounded border cursor-pointer ${
                  createType === "SUPPLIER"
                    ? "border-primary bg-primary/10 font-bold text-primary"
                    : "border-border-default bg-surface text-text-secondary hover:bg-surface-hover"
                }`}
              >
                <input
                  type="radio"
                  name="return-type-radio"
                  checked={createType === "SUPPLIER"}
                  onChange={() => {
                    setCreateType("SUPPLIER");
                    setPartnerId(supplierPartners[0]?.id || "");
                  }}
                  className="text-primary"
                />
                <span>Retur ke Supplier (Outbound)</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField
              id="ret-partner"
              label={createType === "CUSTOMER" ? "Pelanggan Terkait" : "Pemasok / Vendor"}
              isRequired
            >
              <Select
                id="ret-partner"
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
              >
                {(createType === "CUSTOMER" ? customerPartners : supplierPartners).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField id="ret-product" label="Produk yang Dikembalikan" isRequired>
              <Select
                id="ret-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <FormField id="ret-qty" label="Jumlah Retur" isRequired>
              <Input
                id="ret-qty"
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                className="font-mono text-xs"
                required
              />
            </FormField>

            <FormField id="ret-reason" label="Alasan Retur" isRequired>
              <Select
                id="ret-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as ReturnItem["reason"])}
              >
                <option value="SALAH_KIRIM">Salah Kirim (Reopen: YA)</option>
                <option value="PEMBATALAN">Pembatalan (Reopen: YA)</option>
                <option value="SALAH_INPUT">Salah Input (Reopen: YA)</option>
                <option value="CACAT">Barang Cacat/Rusak (Reopen: TIDAK)</option>
                <option value="LAINNYA">Lainnya (Reopen: TIDAK)</option>
              </Select>
            </FormField>

            <FormField id="ret-condition" label="Kondisi Fisik" isRequired>
              <Select
                id="ret-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as "BAIK" | "RUSAK")}
              >
                <option value="BAIK">Kondisi Baik (Available)</option>
                <option value="RUSAK">Kondisi Cacat (Quarantine)</option>
              </Select>
            </FormField>
          </div>

          <FormField id="ret-serials" label="Nomor Seri (Serial Number) - Jika Serial Tracking">
            <Input
              id="ret-serials"
              placeholder="Contoh: SN-TEST-001, G-20261024-0001"
              value={serialNumbers}
              onChange={(e) => setSerialNumbers(e.target.value)}
              className="font-mono text-xs"
            />
          </FormField>

          <div className="p-3 rounded bg-surface-subtle border border-border-default text-xs space-y-1">
            <div className="font-semibold text-text-primary">
              Efek Terhadap Kuantitas Sumber & Stok:
            </div>
            <div className={willReopenQty ? "text-success font-medium" : "text-text-muted"}>
              {willReopenQty
                ? "✓ Alasan ini membuka kembali alokasi kuota pesanan pada PO/Goods Out terkait (reopen_source_qty = true)."
                : "✗ Alasan ini TIDAK membuka kembali alokasi pengiriman (barang cacat/klaim garansi)."}
            </div>
            <div className="text-text-secondary">
              {createType === "CUSTOMER"
                ? `Persetujuan fisik akan menambah saldo ledger (+${quantity} stok fisik di gudang).`
                : `Persetujuan fisik akan memotong saldo ledger (-${quantity} stok fisik keluar dari gudang).`}
            </div>
          </div>

          <FormField id="ret-notes" label="Catatan Alasan / Bukti Foto">
            <Textarea
              id="ret-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Deskripsi kerusakan atau kronologi kesalahan..."
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2 border-t border-border-default">
            <Button
              variant="secondary"
              type="button"
              disabled={isPending}
              onClick={() => setIsCreateOpen(false)}
            >
              Batal
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={isPending}
              loading={isPending}
              loadingLabel="Memproses..."
            >
              Ajukan Dokumen Retur
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

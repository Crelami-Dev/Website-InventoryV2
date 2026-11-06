"use client";

import React, { useState, useMemo } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge, Alert } from "@/components/ui/feedback";
import { SelectField, TextareaField } from "@/components/ui/form-fields";
import { RotateCcwIcon, BoxIcon, WarningIcon, CheckCircleIcon } from "@/components/ui/icons";

export interface ReturnSerialItem {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  qty: number;
  tracking?: "SERIAL" | "NON_SERIAL";
  serials?: string[];
  // Metadata jika serial berupa group dengan anak-anaknya
  groupChildrenMap?: Record<string, string[]>;
}

export interface ReturnSerialPickerDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  sourceType: "CUSTOMER" | "SUPPLIER";
  sourceReference: string;
  partnerName: string;
  warehouseId: string;
  warehouseName?: string;
  items: ReturnSerialItem[];
  // Filter serial yang masih AVAILABLE di gudang penerima (khusus alur retur supplier)
  availableSerials?: string[];
  isSubmitting?: boolean;
  onSubmit: (data: {
    reason: "SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA";
    notes?: string;
    lines: Array<{
      productId: string;
      productName: string;
      quantity: number;
      unit: string;
      condition: "BAIK" | "RUSAK";
      returnedSerials?: string[];
      dissolvedGroups?: string[];
      groupReturnMode?: "WHOLE_GROUP" | "ECERAN_DISSOLVE";
    }>;
  }) => void | Promise<void>;
}

export function ReturnSerialPickerDialog({
  open,
  onClose,
  title,
  sourceType,
  sourceReference,
  partnerName,
  items,
  availableSerials,
  isSubmitting = false,
  onSubmit,
}: ReturnSerialPickerDialogProps) {
  const [reason, setReason] = useState<"SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA">("SALAH_KIRIM");
  const [notes, setNotes] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // State kuantitas per item non-serial: { [productId]: number }
  const [nonSerialQtys, setNonSerialQtys] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const item of items) {
      if (!item.serials || item.serials.length === 0) {
        initial[item.productId] = item.qty;
      }
    }
    return initial;
  });

  // State kondisi per produk: { [productId]: "BAIK" | "RUSAK" }
  const [itemConditions, setItemConditions] = useState<Record<string, "BAIK" | "RUSAK">>(() => {
    const initial: Record<string, "BAIK" | "RUSAK"> = {};
    for (const item of items) {
      initial[item.productId] = "BAIK";
    }
    return initial;
  });

  // Set serial terpilih: Set<string>
  const [selectedSerials, setSelectedSerials] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    // Default pilih semua serial yang valid/tersedia
    for (const item of items) {
      if (item.serials && item.serials.length > 0) {
        for (const sn of item.serials) {
          if (sourceType === "SUPPLIER" && availableSerials) {
            if (availableSerials.includes(sn.trim().toUpperCase())) {
              initial.add(sn);
            }
          } else {
            initial.add(sn);
          }
        }
      }
    }
    return initial;
  });

  // State mode penanganan serial group: { [groupSn]: "WHOLE_GROUP" | "ECERAN_DISSOLVE" }
  const [groupModes, setGroupModes] = useState<Record<string, "WHOLE_GROUP" | "ECERAN_DISSOLVE">>({});

  // State pemilihan serial anak untuk group eceran: { [groupSn]: Set<string> }
  const [selectedChildSerials, setSelectedChildSerials] = useState<Record<string, Set<string>>>({});

  // Helper cek apakah SN adalah format group (diawali 'G-' atau 'GRP-')
  const isGroupSerial = (sn: string) => {
    const upper = sn.trim().toUpperCase();
    return upper.startsWith("G-") || upper.startsWith("GRP-");
  };

  // Helper mendapatkan serial anak jika tidak ada di map
  const getChildSerials = (groupSn: string, item: ReturnSerialItem): string[] => {
    if (item.groupChildrenMap && item.groupChildrenMap[groupSn]) {
      return item.groupChildrenMap[groupSn];
    }
    // Fallback anak serial representatif jika group tidak membawa breakdown explicit (12 pcs per lusin atau 6)
    return Array.from({ length: 6 }, (_, i) => `${groupSn}-${String(i + 1).padStart(2, "0")}`);
  };

  // Toggle seleksi serial standar / induk
  const toggleSerial = (sn: string) => {
    setSelectedSerials((prev) => {
      const next = new Set(prev);
      if (next.has(sn)) {
        next.delete(sn);
      } else {
        next.add(sn);
      }
      return next;
    });
  };

  // Toggle seleksi serial anak untuk group eceran
  const toggleChildSerial = (groupSn: string, childSn: string, allChildren: string[]) => {
    setSelectedChildSerials((prev) => {
      const currentSet = new Set(prev[groupSn] ?? allChildren);
      if (currentSet.has(childSn)) {
        currentSet.delete(childSn);
      } else {
        currentSet.add(childSn);
      }
      return { ...prev, [groupSn]: currentSet };
    });
  };

  // Perhitungan live kuantitas & kalkulasi preview
  const calculation = useMemo(() => {
    let totalBaseQty = 0;
    let goodQty = 0;
    let damagedQty = 0;
    let totalWholeGroups = 0;
    let totalDissolvedGroups = 0;

    const linesToSubmit: Array<{
      productId: string;
      productName: string;
      quantity: number;
      unit: string;
      condition: "BAIK" | "RUSAK";
      returnedSerials?: string[];
      dissolvedGroups?: string[];
      groupReturnMode?: "WHOLE_GROUP" | "ECERAN_DISSOLVE";
    }> = [];

    for (const item of items) {
      const cond = itemConditions[item.productId] ?? "BAIK";

      if (item.serials && item.serials.length > 0) {
        const itemReturnedSerials: string[] = [];
        const itemDissolvedGroups: string[] = [];
        let itemQty = 0;

        for (const sn of item.serials) {
          const isGroup = isGroupSerial(sn);

          if (!selectedSerials.has(sn)) {
            continue;
          }

          if (isGroup) {
            const mode = groupModes[sn] ?? "WHOLE_GROUP";
            const children = getChildSerials(sn, item);

            if (mode === "WHOLE_GROUP") {
              // 1 group utuh = 12 base pcs jika lusin atau default 12
              const groupBasePcs = item.unit.toLowerCase() === "lusin" ? 12 : children.length;
              itemQty += groupBasePcs;
              itemReturnedSerials.push(sn);
              totalWholeGroups++;
            } else {
              // Retur eceran: bongkar group (DISSOLVED)
              const selectedChildren = selectedChildSerials[sn] ?? new Set(children);
              const childrenArr = Array.from(selectedChildren);
              if (childrenArr.length > 0) {
                itemQty += childrenArr.length;
                itemReturnedSerials.push(...childrenArr);
                itemDissolvedGroups.push(sn);
                totalDissolvedGroups++;
              }
            }
          } else {
            // Serial biasa
            itemQty += 1;
            itemReturnedSerials.push(sn);
          }
        }

        if (itemQty > 0) {
          totalBaseQty += itemQty;
          if (cond === "BAIK") goodQty += itemQty;
          else damagedQty += itemQty;

          linesToSubmit.push({
            productId: item.productId,
            productName: item.productName,
            quantity: itemQty,
            unit: "pcs",
            condition: cond,
            returnedSerials: itemReturnedSerials,
            dissolvedGroups: itemDissolvedGroups.length > 0 ? itemDissolvedGroups : undefined,
            groupReturnMode: itemDissolvedGroups.length > 0 ? "ECERAN_DISSOLVE" : "WHOLE_GROUP",
          });
        }
      } else {
        // Non-serial
        const qty = nonSerialQtys[item.productId] ?? item.qty;
        if (qty > 0) {
          totalBaseQty += qty;
          if (cond === "BAIK") goodQty += qty;
          else damagedQty += qty;

          linesToSubmit.push({
            productId: item.productId,
            productName: item.productName,
            quantity: qty,
            unit: item.unit,
            condition: cond,
          });
        }
      }
    }

    return {
      totalBaseQty,
      goodQty,
      damagedQty,
      totalWholeGroups,
      totalDissolvedGroups,
      linesToSubmit,
    };
  }, [items, nonSerialQtys, itemConditions, selectedSerials, groupModes, selectedChildSerials]);

  const willReopenQuota =
    reason === "SALAH_KIRIM" || reason === "PEMBATALAN" || reason === "SALAH_INPUT";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (calculation.linesToSubmit.length === 0 || calculation.totalBaseQty <= 0) {
      setErrorMessage("Pilih minimal 1 item atau serial yang akan diretur.");
      return;
    }

    try {
      await onSubmit({
        reason,
        notes: notes.trim() || undefined,
        lines: calculation.linesToSubmit,
      });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Gagal memproses pengajuan retur.");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        title ||
        (sourceType === "CUSTOMER"
          ? `Buat Retur Pelanggan: ${sourceReference}`
          : `Retur ke Pemasok: ${sourceReference}`)
      }
      description={
        sourceType === "CUSTOMER"
          ? `Pengembalian barang dari pelanggan (${partnerName}) ke gudang. Pilih produk & serial number yang dikembalikan.`
          : `Pengembalian barang masuk kembali ke pemasok (${partnerName}). Hanya serial yang tersedia di gudang yang dapat dikembalikan.`
      }
      size="wide"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {errorMessage && (
          <Alert variant="danger" title="Kesalahan Input Retur" description={errorMessage} />
        )}

        {/* Info Header Dokumen */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 rounded-lg border border-border-default bg-surface-subtle text-xs">
          <div>
            <span className="text-text-muted block font-medium">Dokumen Rujukan</span>
            <span className="font-mono font-semibold text-text-primary">{sourceReference}</span>
          </div>
          <div>
            <span className="text-text-muted block font-medium">
              {sourceType === "CUSTOMER" ? "Pelanggan" : "Pemasok"}
            </span>
            <span className="font-semibold text-text-primary">{partnerName}</span>
          </div>
          <div>
            <span className="text-text-muted block font-medium">Jenis Alur Retur</span>
            <Badge variant={sourceType === "CUSTOMER" ? "info" : "warning"} size="sm">
              {sourceType === "CUSTOMER" ? "Retur Pelanggan (Goods In)" : "Retur Supplier (Goods Out)"}
            </Badge>
          </div>
        </div>

        {/* Input Alasan & Catatan */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SelectField
            label="Alasan Pengembalian (Retur)"
            value={reason}
            onChange={(e) =>
              setReason(
                e.target.value as "SALAH_KIRIM" | "PEMBATALAN" | "SALAH_INPUT" | "CACAT" | "LAINNYA"
              )
            }
            options={[
              { label: "Salah Kirim (Reopen Kuota PO)", value: "SALAH_KIRIM" },
              { label: "Pembatalan Pesanan (Reopen Kuota PO)", value: "PEMBATALAN" },
              { label: "Salah Input Dokumen (Reopen Kuota PO)", value: "SALAH_INPUT" },
              { label: "Barang Cacat / Rusak (Tanpa Reopen PO)", value: "CACAT" },
              { label: "Lainnya (Tanpa Reopen PO)", value: "LAINNYA" },
            ]}
          />
          <TextareaField
            label="Catatan Tambahan (Opsional)"
            placeholder="Catatan inspeksi fisik, no tracking retur, dll..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </div>

        {/* Rincian Item Dokumen & Pemilihan Serial/Group */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-secondary">
              Daftar Barang & Pemilihan Nomor Seri
            </h4>
            <span className="text-xs text-text-muted">
              {items.length} item terdaftar dalam dokumen
            </span>
          </div>

          <div className="space-y-3">
            {items.map((item, idx) => {
              const cond = itemConditions[item.productId] ?? "BAIK";
              const isSerialized = !!(item.serials && item.serials.length > 0);

              return (
                <div
                  key={`${item.productId}-${idx}`}
                  className="rounded-lg border border-border-default bg-surface-card p-4 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border-default pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-text-primary text-sm">
                          {item.productName}
                        </span>
                        <span className="font-mono text-xs text-text-muted">({item.sku})</span>
                      </div>
                      <span className="text-xs text-text-secondary">
                        Kuantitas Dokumen: {item.qty} {item.unit}
                      </span>
                    </div>

                    {/* Radio Kondisi Barang */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-muted">Kondisi:</span>
                      <button
                        type="button"
                        onClick={() =>
                          setItemConditions((prev) => ({ ...prev, [item.productId]: "BAIK" }))
                        }
                        className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
                          cond === "BAIK"
                            ? "bg-success/20 text-success border border-success/40"
                            : "bg-surface-subtle text-text-muted border border-border-default hover:bg-surface-hover"
                        }`}
                      >
                        Baik (Siap Jual)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setItemConditions((prev) => ({ ...prev, [item.productId]: "RUSAK" }))
                        }
                        className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
                          cond === "RUSAK"
                            ? "bg-danger/20 text-danger border border-danger/40"
                            : "bg-surface-subtle text-text-muted border border-border-default hover:bg-surface-hover"
                        }`}
                      >
                        Rusak (Karantina)
                      </button>
                    </div>
                  </div>

                  {/* Jika Non-Serial: Input Kuantitas */}
                  {!isSerialized && (
                    <div className="flex items-center gap-3">
                      <label
                        htmlFor={`qty-${item.productId}`}
                        className="text-xs font-medium text-text-secondary"
                      >
                        Jumlah yang Diretur ({item.unit}):
                      </label>
                      <input
                        id={`qty-${item.productId}`}
                        type="number"
                        min={0}
                        max={item.qty}
                        value={nonSerialQtys[item.productId] ?? item.qty}
                        onChange={(e) => {
                          const val = Math.max(0, Math.min(item.qty, Number(e.target.value) || 0));
                          setNonSerialQtys((prev) => ({ ...prev, [item.productId]: val }));
                        }}
                        className="w-24 rounded border border-border-strong bg-surface px-2.5 py-1 text-xs font-mono font-bold text-text-primary"
                      />
                      <span className="text-xs text-text-muted">dari total {item.qty} {item.unit}</span>
                    </div>
                  )}

                  {/* Jika Serial: Pemilih Serial Cerdas & Grouping */}
                  {isSerialized && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-text-muted">
                        <span>Pilih nomor seri yang dikembalikan:</span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSerials((prev) => {
                                const next = new Set(prev);
                                for (const sn of item.serials!) {
                                  if (sourceType === "SUPPLIER" && availableSerials && !availableSerials.includes(sn.trim().toUpperCase())) {
                                    continue;
                                  }
                                  next.add(sn);
                                }
                                return next;
                              });
                            }}
                            className="text-primary hover:underline text-xs font-medium"
                          >
                            Pilih Semua
                          </button>
                          <span>•</span>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSerials((prev) => {
                                const next = new Set(prev);
                                for (const sn of item.serials!) {
                                  next.delete(sn);
                                }
                                return next;
                              });
                            }}
                            className="text-text-muted hover:underline text-xs"
                          >
                            Lepas Semua
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1">
                        {item.serials!.map((sn) => {
                          const isGroup = isGroupSerial(sn);
                          const isSelected = selectedSerials.has(sn);
                          const isSupplierAvailable =
                            sourceType !== "SUPPLIER" ||
                            !availableSerials ||
                            availableSerials.includes(sn.trim().toUpperCase());

                          const mode = groupModes[sn] ?? "WHOLE_GROUP";
                          const childSerials = isGroup ? getChildSerials(sn, item) : [];
                          const childSelectedSet = selectedChildSerials[sn] ?? new Set(childSerials);

                          return (
                            <div
                              key={sn}
                              className={`rounded-md border p-2.5 transition-colors ${
                                isSelected
                                  ? "border-primary/50 bg-primary/5"
                                  : "border-border-default bg-surface-subtle/40 opacity-75"
                              } ${!isSupplierAvailable ? "opacity-50 cursor-not-allowed bg-surface-subtle" : ""}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <label className="flex items-center gap-2 cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={!isSupplierAvailable}
                                    onChange={() => toggleSerial(sn)}
                                    className="rounded border-border-strong text-primary focus:ring-primary h-4 w-4"
                                  />
                                  <div className="flex items-center gap-1.5 font-mono text-xs font-medium text-text-primary">
                                    {isGroup && (
                                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1 py-0.5 text-[10px] font-bold">
                                        <BoxIcon className="h-3 w-3" />
                                        GROUP BOX
                                      </span>
                                    )}
                                    <span>{sn}</span>
                                  </div>
                                </label>

                                {!isSupplierAvailable && (
                                  <Badge variant="neutral" size="sm">
                                    Sudah Terpakai
                                  </Badge>
                                )}
                              </div>

                              {/* Pilihan Opsi Jika Group Terpilih */}
                              {isGroup && isSelected && isSupplierAvailable && (
                                <div className="mt-2.5 pt-2 border-t border-border-default space-y-2">
                                  <div className="text-[11px] font-semibold text-text-secondary">
                                    Pilihan Penanganan Wadah Group:
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <label
                                      className={`flex items-center gap-1.5 p-1.5 rounded border cursor-pointer ${
                                        mode === "WHOLE_GROUP"
                                          ? "border-primary bg-primary/10 font-bold text-primary"
                                          : "border-border-default bg-surface text-text-secondary hover:bg-surface-hover"
                                      }`}
                                    >
                                      <input
                                        type="radio"
                                        name={`group-mode-${sn}`}
                                        checked={mode === "WHOLE_GROUP"}
                                        onChange={() =>
                                          setGroupModes((prev) => ({
                                            ...prev,
                                            [sn]: "WHOLE_GROUP",
                                          }))
                                        }
                                        className="h-3 w-3 text-primary"
                                      />
                                      <span>Retur Utuh (1 Box)</span>
                                    </label>

                                    <label
                                      className={`flex items-center gap-1.5 p-1.5 rounded border cursor-pointer ${
                                        mode === "ECERAN_DISSOLVE"
                                          ? "border-danger bg-danger/10 font-bold text-danger"
                                          : "border-border-default bg-surface text-text-secondary hover:bg-surface-hover"
                                      }`}
                                    >
                                      <input
                                        type="radio"
                                        name={`group-mode-${sn}`}
                                        checked={mode === "ECERAN_DISSOLVE"}
                                        onChange={() =>
                                          setGroupModes((prev) => ({
                                            ...prev,
                                            [sn]: "ECERAN_DISSOLVE",
                                          }))
                                        }
                                        className="h-3 w-3 text-danger"
                                      />
                                      <span>Retur Eceran (Bongkar)</span>
                                    </label>
                                  </div>

                                  {/* Jika Eceran: Daftar Serial Anak */}
                                  {mode === "ECERAN_DISSOLVE" && (
                                    <div className="p-2 rounded bg-surface border border-danger/30 space-y-1.5">
                                      <div className="flex items-center justify-between text-[11px]">
                                        <span className="font-semibold text-danger">
                                          Pilih SN Anak yang Dikembalikan:
                                        </span>
                                        <span className="text-text-muted">
                                          {childSelectedSet.size}/{childSerials.length} pcs
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-2 gap-1 text-[11px] font-mono">
                                        {childSerials.map((childSn) => (
                                          <label
                                            key={childSn}
                                            className="flex items-center gap-1.5 p-1 rounded bg-surface-subtle hover:bg-surface-hover cursor-pointer"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={childSelectedSet.has(childSn)}
                                              onChange={() =>
                                                toggleChildSerial(sn, childSn, childSerials)
                                              }
                                              className="h-3 w-3 text-danger rounded"
                                            />
                                            <span className="truncate">{childSn}</span>
                                          </label>
                                        ))}
                                      </div>
                                      <div className="text-[10px] text-text-muted italic pt-1">
                                        *Group {sn} akan berstatus <strong className="text-danger">DISSOLVED</strong> secara permanen di sistem.
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Preview Kalkulasi Dampak Mutasi Stok */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-1.5">
              <CheckCircleIcon className="h-4 w-4" />
              Preview Kalkulasi Penambahan / Pengurangan Stok Live
            </span>
            <span className="font-mono text-xs font-bold text-primary">
              Total Diretur: {calculation.totalBaseQty} Base pcs
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 text-xs">
            <div className="p-2 rounded bg-surface border border-border-default">
              <span className="text-text-muted block text-[11px]">Kondisi Baik (Siap Jual)</span>
              <span className="font-mono font-bold text-success">+{calculation.goodQty} pcs</span>
            </div>
            <div className="p-2 rounded bg-surface border border-border-default">
              <span className="text-text-muted block text-[11px]">Kondisi Rusak (Karantina)</span>
              <span className="font-mono font-bold text-danger">+{calculation.damagedQty} pcs</span>
            </div>
            <div className="p-2 rounded bg-surface border border-border-default">
              <span className="text-text-muted block text-[11px]">Group SN Utuh</span>
              <span className="font-mono font-bold text-text-primary">
                {calculation.totalWholeGroups} Box
              </span>
            </div>
            <div className="p-2 rounded bg-surface border border-border-default">
              <span className="text-text-muted block text-[11px]">Group Dibongkar</span>
              <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                {calculation.totalDissolvedGroups} (DISSOLVED)
              </span>
            </div>
          </div>

          <div className="text-[11px] text-text-muted pt-1 flex items-center gap-1.5">
            <WarningIcon className="h-3.5 w-3.5 text-info" />
            <span>
              Kebijakan kuota pesanan:{" "}
              {willReopenQuota ? (
                <strong className="text-success font-semibold">
                  Kuota PO dibuka kembali (reopen = true)
                </strong>
              ) : (
                <strong className="text-text-secondary font-semibold">
                  Kuota PO tidak dibuka kembali (reopen = false)
                </strong>
              )}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-default">
          <Button type="button" variant="secondary" size="md" onClick={onClose} disabled={isSubmitting}>
            Batal
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={isSubmitting}
            loadingLabel="Menyimpan Retur..."
            disabled={isSubmitting || calculation.totalBaseQty <= 0}
          >
            <RotateCcwIcon className="h-4 w-4 mr-1.5" />
            Konfirmasi & Buat Dokumen Retur
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

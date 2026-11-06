"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Alert } from "@/components/ui/feedback";
import { saveStockOpnameInvestigationAction } from "@/lib/inventory/actions";
import type { StockOpnameReconciliationItem } from "@/lib/db/repositories/inventory-repository";

interface StockOpnameInvestigationDialogProps {
  open: boolean;
  item: StockOpnameReconciliationItem | null;
  sessionId: string;
  isReadOnly: boolean;
  onClose: () => void;
  onSaved: (productId: string, reason: string, notes: string | null) => void;
}

const DISCREPANCY_REASONS = [
  "Kerusakan Fisik",
  "Barang Hilang / Dicuri",
  "Salah Kirim / Salah Penempatan",
  "Mutasi Pasca-Snapshot Belum Lengkap",
  "Barang Retur / Titipan",
  "Selisih Konversi Satuan",
  "Lainnya",
];

export function StockOpnameInvestigationDialog({
  open,
  item,
  sessionId,
  isReadOnly,
  onClose,
  onSaved,
}: StockOpnameInvestigationDialogProps) {
  const [selectedReason, setSelectedReason] = useState<string>(
    item?.discrepancyReason || DISCREPANCY_REASONS[0]
  );
  const [notes, setNotes] = useState<string>(item?.investigationNotes || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [serialTab, setSerialTab] = useState<"MATCHED" | "MISSING" | "SURPLUS">("MISSING");

  if (!open || !item) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (isReadOnly || !item) return;

    if (!selectedReason) {
      setErrorMsg("Pilih alasan investigasi terlebih dahulu.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await saveStockOpnameInvestigationAction({
        sessionId,
        productId: item.productId,
        reason: selectedReason,
        notes: notes.trim() || undefined,
      });

      if (res.success) {
        setSuccessMsg("Catatan investigasi berhasil disimpan dan tercatat ke audit log.");
        onSaved(item.productId, selectedReason, notes.trim() || null);
        setTimeout(() => {
          onClose();
        }, 900);
      } else {
        setErrorMsg("error" in res ? res.error : "Gagal menyimpan catatan investigasi.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Terjadi kesalahan sistem saat menyimpan.";
      setErrorMsg(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  const serialDetail = item.serialDetail;
  const hasSerials = item.trackingMode === "SERIAL" && serialDetail;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-none">
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border border-border-default bg-surface p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border-default pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-text-primary">
                Investigasi Selisih & Rekonsiliasi
              </h2>
              <Badge variant={item.trackingMode === "SERIAL" ? "info" : "outline"}>
                {item.trackingMode === "SERIAL" ? "SERIAL" : "NON-SERIAL"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">{item.productName}</span>{" "}
              <span className="font-mono text-text-muted">({item.sku})</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-surface-muted hover:text-text-primary"
          >
            Tutup
          </button>
        </div>

        {/* Ringkasan Angka Rekonsiliasi Matematika Kanonis */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded border border-border-default bg-surface-card p-3">
            <span className="text-[11px] font-medium text-text-muted uppercase">1. Snapshot Buku</span>
            <div className="mt-1 font-mono text-base font-bold text-text-primary">
              {item.snapshotQty} {item.unit}
            </div>
            <span className="text-[10px] text-text-muted">Stok saat sesi dibuka</span>
          </div>

          <div className="rounded border border-border-default bg-surface-card p-3">
            <span className="text-[11px] font-medium text-text-muted uppercase">2. Delta Concurrent</span>
            <div
              className={`mt-1 font-mono text-base font-bold ${
                item.netDelta > 0
                  ? "text-success"
                  : item.netDelta < 0
                  ? "text-danger"
                  : "text-text-primary"
              }`}
            >
              {item.netDelta > 0 ? `+${item.netDelta}` : item.netDelta} {item.unit}
            </div>
            <span className="text-[10px] text-text-muted">
              +{item.deltaIn} Masuk / -{item.deltaOut} Keluar
            </span>
          </div>

          <div className="rounded border border-border-default bg-surface-card p-3">
            <span className="text-[11px] font-medium text-text-muted uppercase">3. Acuan Dinamis</span>
            <div className="mt-1 font-mono text-base font-bold text-text-primary">
              {item.dynamicBookQty} {item.unit}
            </div>
            <span className="text-[10px] text-text-muted">Snapshot + Delta</span>
          </div>

          <div className="rounded border border-border-default bg-surface-card p-3">
            <span className="text-[11px] font-medium text-text-muted uppercase">4. Fisik Terhitung</span>
            <div className="mt-1 font-mono text-base font-bold text-primary">
              {item.countedQty} {item.unit}
            </div>
            <span className="text-[10px] text-text-muted">Akumulasi seluruh area</span>
          </div>

          <div className="rounded border border-border-default bg-surface-card p-3">
            <span className="text-[11px] font-medium text-text-muted uppercase">5. Selisih Bersih</span>
            <div
              className={`mt-1 font-mono text-base font-bold ${
                item.varianceQty === 0
                  ? "text-success"
                  : item.varianceQty > 0
                  ? "text-info"
                  : "text-danger"
              }`}
            >
              {item.varianceQty > 0 ? `+${item.varianceQty}` : item.varianceQty} {item.unit}
            </div>
            <span className="text-[10px] text-text-muted">Fisik - Acuan Dinamis</span>
          </div>
        </div>

        {/* Notifikasi Status Rekonsiliasi & Concurrency */}
        {item.hasConcurrentMovement && (
          <div className="mt-4">
            <Alert
              variant="warning"
              title="Pergerakan Stok Bersamaan Terdeteksi"
              description={`Terdapat mutasi transaksi operasional resmi (Goods In / Goods Out / Retur / Penyesuaian) pasca snapshot dengan total delta ${
                item.netDelta > 0 ? `+${item.netDelta}` : item.netDelta
              } ${item.unit}. Stok acuan telah disesuaikan secara dinamis.`}
            />
          </div>
        )}

        {/* Rincian Transaksi Concurrent Pasca-Snapshot jika Ada */}
        {item.concurrentTransactions && item.concurrentTransactions.length > 0 && (
          <div className="mt-4 rounded border border-border-default bg-surface-card p-3.5">
            <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
              Riwayat Transaksi Pasca-Snapshot (Ledger)
            </h4>
            <div className="mt-2 space-y-1.5 max-h-36 overflow-y-auto">
              {item.concurrentTransactions.map((tx, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between text-xs py-1 border-b border-border-default last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={tx.quantityDeltaBase > 0 ? "success" : "danger"} size="sm">
                      {tx.entryType}
                    </Badge>
                    <span className="font-mono text-text-secondary">{tx.sourceDocId}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono font-semibold ${
                        tx.quantityDeltaBase > 0 ? "text-success" : "text-danger"
                      }`}
                    >
                      {tx.quantityDeltaBase > 0 ? `+${tx.quantityDeltaBase}` : tx.quantityDeltaBase}{" "}
                      {item.unit}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      {new Date(tx.createdAt).toLocaleTimeString("id-ID", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Rincian Drill-Down Serial Number (Matched / Missing / Surplus) */}
        {hasSerials && (
          <div className="mt-4 rounded border border-border-default bg-surface-card p-3.5">
            <div className="flex items-center justify-between border-b border-border-default pb-2">
              <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
                Rincian Serial Number Audit
              </h4>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setSerialTab("MISSING")}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                    serialTab === "MISSING"
                      ? "bg-danger text-white"
                      : "bg-surface text-text-secondary hover:text-text-primary border border-border-default"
                  }`}
                >
                  SN Hilang ({serialDetail.missingSerials.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSerialTab("SURPLUS")}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                    serialTab === "SURPLUS"
                      ? "bg-info text-white"
                      : "bg-surface text-text-secondary hover:text-text-primary border border-border-default"
                  }`}
                >
                  SN Asing/Surplus ({serialDetail.surplusSerials.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSerialTab("MATCHED")}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                    serialTab === "MATCHED"
                      ? "bg-success text-white"
                      : "bg-surface text-text-secondary hover:text-text-primary border border-border-default"
                  }`}
                >
                  SN Cocok ({serialDetail.matchedSerials.length})
                </button>
              </div>
            </div>

            <div className="mt-2.5 max-h-44 overflow-y-auto">
              {serialTab === "MISSING" && (
                <div>
                  {serialDetail.missingSerials.length === 0 ? (
                    <p className="text-xs text-text-muted py-2 text-center">
                      Tidak ada Serial Number yang hilang. Seluruh SN snapshot terhitung.
                    </p>
                  ) : (
                    <div className="divide-y divide-border-default">
                      {serialDetail.missingSerials.map((sn, idx) => (
                        <div key={idx} className="py-1.5 flex items-center justify-between text-xs">
                          <span className="font-mono font-medium text-danger">{sn.serialNumber}</span>
                          <div className="flex items-center gap-2">
                            {sn.dispatchedPostSnapshot ? (
                              <Badge variant="warning" size="sm">
                                Keluar via Goods Out Pasca-Snapshot
                              </Badge>
                            ) : (
                              <Badge variant="danger" size="sm">
                                Tidak Terpindai di Seluruh Area
                              </Badge>
                            )}
                            <span className="text-text-muted font-mono">{sn.baseQuantity} {sn.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {serialTab === "SURPLUS" && (
                <div>
                  {serialDetail.surplusSerials.length === 0 ? (
                    <p className="text-xs text-text-muted py-2 text-center">
                      Tidak ada Serial Number asing atau surplus.
                    </p>
                  ) : (
                    <div className="divide-y divide-border-default">
                      {serialDetail.surplusSerials.map((sn, idx) => (
                        <div key={idx} className="py-1.5 flex items-center justify-between text-xs">
                          <span className="font-mono font-medium text-info">{sn.serialNumber}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" size="sm">
                              {sn.source === "SCAN_ERROR" ? "Ditolak Scanner (Asing)" : "Terpindai Fisik"}
                            </Badge>
                            <span className="text-text-muted font-mono">{sn.baseQuantity} {sn.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {serialTab === "MATCHED" && (
                <div>
                  {serialDetail.matchedSerials.length === 0 ? (
                    <p className="text-xs text-text-muted py-2 text-center">
                      Belum ada Serial Number yang cocok dihitung.
                    </p>
                  ) : (
                    <div className="divide-y divide-border-default">
                      {serialDetail.matchedSerials.map((sn, idx) => (
                        <div key={idx} className="py-1.5 flex items-center justify-between text-xs">
                          <span className="font-mono font-medium text-success">{sn.serialNumber}</span>
                          <div className="flex items-center gap-2">
                            {sn.scannedInArea && (
                              <Badge variant="success" size="sm">
                                {sn.scannedInArea}
                              </Badge>
                            )}
                            <span className="text-text-muted font-mono">{sn.baseQuantity} {sn.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Breakdown Hitungan per Area */}
        {item.areaBreakdown && item.areaBreakdown.length > 0 && (
          <div className="mt-4 rounded border border-border-default bg-surface-card p-3.5">
            <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wide">
              Rincian Hitungan per Area
            </h4>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {item.areaBreakdown.map((ab, idx) => (
                <div key={idx} className="rounded border border-border-default bg-surface p-2 text-xs">
                  <span className="text-text-muted block text-[10px]">{ab.areaName}</span>
                  <span className="font-mono font-semibold text-text-primary">
                    {ab.countedQtyBase} {item.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Form Investigasi Selisih */}
        <form onSubmit={handleSave} className="mt-5 space-y-3 border-t border-border-default pt-4">
          <h3 className="text-xs font-bold text-text-primary uppercase tracking-wide">
            Form Catatan Investigasi Resmi (Auditable)
          </h3>

          {errorMsg && (
            <Alert variant="danger" title="Gagal Menyimpan" description={errorMsg} />
          )}
          {successMsg && (
            <Alert variant="success" title="Tersimpan" description={successMsg} />
          )}

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Alasan Selisih <span className="text-danger">*</span>
            </label>
            <select
              value={selectedReason}
              onChange={(e) => setSelectedReason(e.target.value)}
              disabled={isReadOnly || isSubmitting}
              className="w-full rounded border border-border-default bg-surface px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-primary disabled:opacity-60"
            >
              {DISCREPANCY_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Catatan Investigasi Lapangan
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tuliskan temuan investigasi, kondisi fisik barang, letak lorong rak, atau konfirmasi staf..."
              disabled={isReadOnly || isSubmitting}
              className="w-full rounded border border-border-default bg-surface p-2.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary disabled:opacity-60"
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-text-muted">
              Penyimpanan investigasi tidak akan mengubah snapshot awal atau hitungan fisik.
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                Tutup
              </Button>
              {!isReadOnly && (
                <Button type="submit" variant="primary" size="sm" disabled={isSubmitting}>
                  {isSubmitting ? "Menyimpan..." : "Simpan Catatan Investigasi"}
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

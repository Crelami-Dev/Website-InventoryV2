"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/feedback";
import { CheckCircleIcon, WarningIcon, AuditIcon } from "@/components/ui/icons";
import { approveAndPostStockOpnameAdjustmentAction } from "@/lib/inventory/actions";
import type { StockOpnameReconciliationSummary } from "@/lib/db/repositories/inventory-repository";

interface StockOpnameFinalizeDialogProps {
  open: boolean;
  sessionId: string;
  summary: StockOpnameReconciliationSummary | null;
  currentRole?: string;
  onClose: () => void;
  onSuccess: (result: {
    status: string;
    totalAdjustedLines: number;
    ledgerEntriesCreated: number;
  }) => void;
}

export function StockOpnameFinalizeDialog({
  open,
  sessionId,
  summary,
  currentRole,
  onClose,
  onSuccess,
}: StockOpnameFinalizeDialogProps) {
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [autoCompleteAreas, setAutoCompleteAreas] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!summary) return null;

  const isOwner = currentRole === "OWNER";
  const itemsWithVariance = summary.items.filter((i) => i.varianceQty !== 0);
  const itemsRequiresReeval = summary.items.filter(
    (i) => i.reconciliationStatus === "REQUIRES_RE_EVALUATION"
  );
  const itemsUninvestigated = itemsWithVariance.filter(
    (i) => !i.discrepancyReason || !i.discrepancyReason.trim()
  );

  const hasBlockingIssues =
    !isOwner || itemsRequiresReeval.length > 0 || itemsUninvestigated.length > 0;

  const handleFinalize = async () => {
    if (hasBlockingIssues || !confirmed || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await approveAndPostStockOpnameAdjustmentAction({
        sessionId,
        notes: notes.trim() || undefined,
        autoCompletePendingAreas: autoCompleteAreas,
      });

      if (res.success) {
        onSuccess({
          status: res.status,
          totalAdjustedLines: res.totalAdjustedLines,
          ledgerEntriesCreated: res.ledgerEntriesCreated,
        });
        onClose();
      } else {
        setErrorMessage(res.error);
      }
    } catch {
      setErrorMessage("Terjadi kesalahan sistem saat memproses transaksi penyesuaian.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const footerContent = (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onClose}
        disabled={isSubmitting}
      >
        Batal
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={handleFinalize}
        disabled={hasBlockingIssues || !confirmed || isSubmitting}
        className="flex items-center gap-1.5"
      >
        <AuditIcon size={16} />
        {isSubmitting ? (
          <span>Memproses Penyesuaian...</span>
        ) : (
          <span>Setujui & Posting Penyesuaian</span>
        )}
      </Button>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? () => {} : onClose}
      size="wide"
      title="Persetujuan & Posting Penyesuaian Ledger"
      description="Finalisasi resmi hasil Stock Opname ke buku besar stok dan pembaruan status serial"
      footer={footerContent}
    >
      <div className="space-y-4 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
        {/* Header Warning / Notice */}
        <Alert
          variant={hasBlockingIssues ? "warning" : "info"}
          title={
            hasBlockingIssues
              ? "Persetujuan Ditahan: Syarat Belum Lengkap"
              : "Konfirmasi Finalisasi Stock Opname"
          }
          description={
            hasBlockingIssues
              ? "Harap periksa kendala otorisasi, anomali serial, atau alasan investigasi yang belum terisi di bawah."
              : "Tindakan ini akan memposting mutasi STOCK_ADJUSTMENT_POSTED resmi ke inventory ledger secara atomik dan mengunci sesi secara permanen."
          }
        />

        {errorMessage && (
          <Alert variant="danger" title="Gagal Memproses" description={errorMessage} />
        )}

        {/* Otorisasi Role Check */}
        {!isOwner && (
          <div className="p-3 rounded border border-danger/40 bg-danger/5 text-xs text-danger font-medium flex items-center gap-2">
            <WarningIcon size={16} className="shrink-0" />
            <span>
              Peran pengguna saat ini ({currentRole || "STAFF"}) bukan Owner. Hanya pengguna dengan peran
              Owner yang berwenang menyetujui dan memposting penyesuaian stok.
            </span>
          </div>
        )}

        {/* Blocking Issue: REQUIRES_RE_EVALUATION */}
        {itemsRequiresReeval.length > 0 && (
          <div className="p-3 rounded border border-warning/40 bg-warning/5 text-xs text-warning-text space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <WarningIcon size={16} />
              <span>
                {itemsRequiresReeval.length} produk berstatus 'Perlu Investigasi' (REQUIRES_RE_EVALUATION):
              </span>
            </div>
            <ul className="list-disc list-inside pl-1 text-[11px] space-y-0.5">
              {itemsRequiresReeval.map((item) => (
                <li key={item.id}>
                  {item.sku} — {item.productName} (Anomali Serial / Mutasi Paralel belum diselesaikan)
                </li>
              ))}
            </ul>
            <p className="text-[11px] pt-1 text-text-muted">
              Semua anomali serial atau pergerakan concurrent wajib direkonsiliasi sebelum sesi dapat disetujui.
            </p>
          </div>
        )}

        {/* Blocking Issue: Uninvestigated Discrepancies */}
        {itemsUninvestigated.length > 0 && (
          <div className="p-3 rounded border border-warning/40 bg-warning/5 text-xs text-warning-text space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <WarningIcon size={16} />
              <span>
                {itemsUninvestigated.length} produk berselisih belum memiliki alasan investigasi:
              </span>
            </div>
            <ul className="list-disc list-inside pl-1 text-[11px] space-y-0.5">
              {itemsUninvestigated.map((item) => (
                <li key={item.id}>
                  {item.sku} — {item.productName} (Selisih:{" "}
                  {item.varianceQty > 0 ? `+${item.varianceQty}` : item.varianceQty} {item.unit})
                </li>
              ))}
            </ul>
            <p className="text-[11px] pt-1 text-text-muted">
              Buka modal investigasi pada produk di atas dan simpan alasan investigasi yang valid.
            </p>
          </div>
        )}

        {/* Ringkasan Rekonsiliasi Card */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="p-2.5 rounded border border-border-default bg-surface-muted">
            <span className="text-[10px] text-text-muted uppercase font-medium block">Total SKU</span>
            <span className="text-base font-bold text-text-primary font-mono">{summary.totalSku}</span>
          </div>
          <div className="p-2.5 rounded border border-border-default bg-surface-muted">
            <span className="text-[10px] text-text-muted uppercase font-medium block">Sesuai (Tanpa Selisih)</span>
            <span className="text-base font-bold text-success font-mono">{summary.matchCount} SKU</span>
            <span className="text-[10px] text-text-muted block">0 posting ledger</span>
          </div>
          <div className="p-2.5 rounded border border-border-default bg-surface-muted">
            <span className="text-[10px] text-text-muted uppercase font-medium block">Surplus (+Masuk)</span>
            <span className="text-base font-bold text-info font-mono">{summary.surplusCount} SKU</span>
            <span className="text-[10px] text-info block">Penambahan stok</span>
          </div>
          <div className="p-2.5 rounded border border-border-default bg-surface-muted">
            <span className="text-[10px] text-text-muted uppercase font-medium block">Defisit (-Keluar)</span>
            <span className="text-base font-bold text-danger font-mono">{summary.shortageCount} SKU</span>
            <span className="text-[10px] text-danger block">Pengurangan stok</span>
          </div>
        </div>

        {/* Rincian Produk yang Berselisih */}
        {itemsWithVariance.length > 0 ? (
          <div className="rounded border border-border-default bg-surface overflow-hidden">
            <div className="px-3 py-2 bg-surface-muted border-b border-border-default flex items-center justify-between text-xs">
              <span className="font-semibold text-text-primary">
                Daftar Mutasi Penyesuaian ({itemsWithVariance.length} Produk)
              </span>
              <span className="text-text-muted text-[11px]">
                Net Selisih:{" "}
                <strong className={summary.netDiscrepancyQty >= 0 ? "text-success" : "text-danger"}>
                  {summary.netDiscrepancyQty > 0 ? `+${summary.netDiscrepancyQty}` : summary.netDiscrepancyQty} PCS
                </strong>
              </span>
            </div>
            <div className="max-h-44 overflow-y-auto divide-y divide-border-default text-xs">
              {itemsWithVariance.map((item) => (
                <div key={item.id} className="p-2.5 flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-text-primary">{item.sku}</span>
                      <span className="text-text-secondary">— {item.productName}</span>
                    </div>
                    <div className="text-[11px] text-text-muted">
                      Snapshot: {item.snapshotQty} | Acuan Dinamis: {item.dynamicBookQty} | Fisik:{" "}
                      {item.countedQty} {item.unit}
                    </div>
                    {item.discrepancyReason ? (
                      <div className="text-[11px] text-primary font-medium">
                        Alasan: {item.discrepancyReason}
                      </div>
                    ) : (
                      <div className="text-[11px] text-danger font-medium">
                        Belum ada alasan investigasi
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <Badge
                      variant={item.varianceQty > 0 ? "success" : "danger"}
                      size="sm"
                      className="font-mono font-bold"
                    >
                      {item.varianceQty > 0 ? `+${item.varianceQty}` : item.varianceQty} {item.unit}
                    </Badge>
                    <span className="text-[10px] text-text-muted block mt-0.5">
                      {item.varianceQty > 0 ? "Adjustment Masuk" : "Adjustment Keluar"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-3 rounded border border-success/30 bg-success/5 text-xs text-success flex items-center gap-2">
            <CheckCircleIcon size={16} className="shrink-0" />
            <span>
              Seluruh produk cocok sempurna dengan stok sistem (Selisih Nol). Sesi akan difinalisasi dengan
              status COMPLETED tanpa menulis mutasi adjustment ke ledger.
            </span>
          </div>
        )}

        {/* Opsi Auto Complete Area */}
        <div className="flex items-start gap-2 pt-1">
          <input
            type="checkbox"
            id="auto-complete-areas"
            checked={autoCompleteAreas}
            onChange={(e) => setAutoCompleteAreas(e.target.checked)}
            disabled={isSubmitting}
            className="mt-0.5 rounded border-border-default text-primary focus:ring-primary"
          />
          <label htmlFor="auto-complete-areas" className="text-xs text-text-secondary cursor-pointer">
            Tandai seluruh area penghitungan aktif yang belum selesai menjadi <strong>COMPLETED</strong>{" "}
            secara otomatis saat persetujuan.
          </label>
        </div>

        {/* Form Input Catatan Persetujuan */}
        <div className="space-y-1">
          <label htmlFor="finalize-notes" className="text-xs font-semibold text-text-primary block">
            Catatan Persetujuan & Disposisi Owner (Opsional)
          </label>
          <textarea
            id="finalize-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isSubmitting}
            placeholder="Contoh: Disetujui berdasarkan hasil review fisik dan investigasi tim gudang..."
            className="w-full text-xs rounded border border-border-default bg-surface p-2 text-text-primary focus:outline-none focus:border-primary resize-none"
          />
        </div>

        {/* Checkbox Konfirmasi Eksplisit */}
        <div className="p-3 rounded border border-border-default bg-surface-muted flex items-start gap-2.5">
          <input
            type="checkbox"
            id="finalize-confirm-check"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={hasBlockingIssues || isSubmitting}
            className="mt-0.5 rounded border-border-default text-primary focus:ring-primary"
          />
          <label
            htmlFor="finalize-confirm-check"
            className={`text-xs ${
              hasBlockingIssues ? "text-text-muted cursor-not-allowed" : "text-text-primary cursor-pointer"
            }`}
          >
            <strong>Saya mengonfirmasi persetujuan resmi:</strong> Seluruh hasil hitungan fisik, rekonsiliasi
            transaksi concurrent, dan investigasi selisih telah diperiksa. Saya menyetujui penyesuaian stok ini
            diposting ke buku besar inventory ledger dan sesi dikunci permanen.
          </label>
        </div>
      </div>
    </Dialog>
  );
}

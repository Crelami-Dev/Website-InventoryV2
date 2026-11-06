"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Alert, StatusBadge } from "@/components/ui/feedback";
import { TextField, SelectField, TextareaField } from "@/components/ui/form-fields";
import { useToast } from "@/components/ui/toast";
import {
  type Product,
  type SerialNumberItem,
  type StockHistoryItem,
  FIXTURE_SERIALS,
  FIXTURE_STOCK_HISTORY,
} from "@/lib/demo/inventory-fixtures";
import { updateProductAction } from "@/lib/inventory/actions";

type TabType = "ringkasan" | "unit-sn" | "riwayat" | "info";

export function ProductDetailView({
  product,
  initialSerials,
  initialHistory,
}: {
  product: Product;
  initialSerials?: SerialNumberItem[];
  initialHistory?: StockHistoryItem[];
}) {
  const toast = useToast();
  const [currentProduct, setCurrentProduct] = useState<Product>(product);
  const [activeTab, setActiveTab] = useState<TabType>("ringkasan");

  // State pencarian & filter SN
  const [snSearch, setSnSearch] = useState("");
  const [snStatusFilter, setSnStatusFilter] = useState("");

  // State Modal Edit Metadata Produk
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editName, setEditName] = useState(currentProduct.name);
  const [editBarcode, setEditBarcode] = useState(currentProduct.barcode ?? "");
  const [editCategory, setEditCategory] = useState(currentProduct.category);
  const [editMinStock, setEditMinStock] = useState(String(currentProduct.minStock ?? 0));
  const [editStatus, setEditStatus] = useState<"ACTIVE" | "INACTIVE">(
    currentProduct.status === "ACTIVE" ? "ACTIVE" : "INACTIVE"
  );
  const [editTrackingMode, setEditTrackingMode] = useState<"SERIAL" | "NON_SERIAL">(
    currentProduct.tracking === "SERIAL" ? "SERIAL" : "NON_SERIAL"
  );
  const [editDesc, setEditDesc] = useState(currentProduct.description ?? "");
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const isSerial = currentProduct.tracking === "SERIAL";
  const serialItems = initialSerials ?? FIXTURE_SERIALS.filter((s) => s.productId === currentProduct.id);
  const stockHistory = initialHistory ?? FIXTURE_STOCK_HISTORY.filter((sh) => sh.productId === currentProduct.id);

  // Filter SN
  const filteredSerials = useMemo(() => {
    const q = snSearch.trim().toLowerCase();
    return serialItems.filter((s) => {
      const matchSearch = !q || s.serialNumber.toLowerCase().includes(q);
      const matchStatus = !snStatusFilter || s.status === snStatusFilter;
      return matchSearch && matchStatus;
    });
  }, [serialItems, snSearch, snStatusFilter]);

  // Statistik SN
  const snStats = useMemo(() => {
    let available = 0;
    let reserved = 0;
    let quarantine = 0;
    for (const s of serialItems) {
      if (s.status === "AVAILABLE") available++;
      else if (s.status === "RESERVED") reserved++;
      else if (s.status === "QUARANTINE") quarantine++;
    }
    return { available, reserved, quarantine, total: serialItems.length };
  }, [serialItems]);

  function handleOpenEdit() {
    setEditName(currentProduct.name);
    setEditBarcode(currentProduct.barcode ?? "");
    setEditCategory(currentProduct.category);
    setEditMinStock(String(currentProduct.minStock ?? 0));
    setEditStatus(currentProduct.status === "ACTIVE" ? "ACTIVE" : "INACTIVE");
    setEditTrackingMode(currentProduct.tracking === "SERIAL" ? "SERIAL" : "NON_SERIAL");
    setEditDesc(currentProduct.description ?? "");
    setEditErrors({});
    setEditModalOpen(true);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (isSaving) return;
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.name = "Nama produk wajib diisi.";

    if (Object.keys(errors).length > 0) {
      setEditErrors(errors);
      return;
    }

    setIsSaving(true);
    try {
      const res = await updateProductAction({
        productId: currentProduct.id,
        name: editName.trim(),
        barcode: editBarcode.trim() || null,
        category: editCategory,
        trackingMode: editTrackingMode,
        minStock: Number(editMinStock) || 0,
        status: editStatus,
        description: editDesc.trim() || null,
      });

      if (!res.success) {
        toast.push({
          tone: "danger",
          title: "Gagal Menyimpan Perubahan",
          description: res.error || "Terjadi kesalahan saat memperbarui produk.",
        });
        setIsSaving(false);
        return;
      }

      const p = res.product!;
      setCurrentProduct((prev) => ({
        ...prev,
        name: p.name,
        barcode: p.barcode ?? undefined,
        category: p.category,
        tracking: p.trackingMode,
        minStock: p.minStock,
        status: p.status === "ARCHIVED" ? "INACTIVE" : p.status,
        description: p.description ?? undefined,
      }));

      setEditModalOpen(false);
      toast.push({
        tone: "success",
        title: "Metadata Produk Diperbarui",
        description: `Informasi produk ${p.name} berhasil diperbarui di database SQLite.`,
      });
    } catch (err: unknown) {
      toast.push({
        tone: "danger",
        title: "Kesalahan Sistem",
        description: err instanceof Error ? err.message : "Gagal menyimpan perubahan.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  const isLowStock = Boolean(
    currentProduct.minStock && currentProduct.stock <= currentProduct.minStock && currentProduct.stock > 0
  );
  const isOutOfStock = currentProduct.stock === 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb dan Back Link */}
      <div>
        <Link href="/inventory/products" className="text-xs font-semibold text-primary hover:underline">
          &larr; Kembali ke Katalog Produk
        </Link>
      </div>

      <PageHeader
        title={`${currentProduct.name} (${currentProduct.sku})`}
        description={`Kategori: ${currentProduct.category} | Satuan Dasar: ${currentProduct.unit}`}
        actions={
          <Button variant="secondary" onClick={handleOpenEdit}>
            Edit Metadata Produk
          </Button>
        }
      />

      {/* Kartu Identitas Produk Ringkas */}
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-4">
        <div>
          <span className="text-xs text-text-secondary">Mode Tracking</span>
          <div className="mt-1">
            <StatusBadge tone={isSerial ? "info" : "neutral"}>
              {isSerial ? "Serial Number (SN)" : "Non-serial (Qty)"}
            </StatusBadge>
          </div>
        </div>
        <div>
          <span className="text-xs text-text-secondary">Stok Fisik Gudang</span>
          <p
            className={`mt-1 text-lg font-semibold tabular ${
              isOutOfStock ? "text-danger" : isLowStock ? "text-warning" : "text-text-primary"
            }`}
          >
            {currentProduct.stock} {currentProduct.unit}
          </p>
        </div>
        <div>
          <span className="text-xs text-text-secondary">Batas Minimum Stok</span>
          <p className="mt-1 text-lg font-semibold tabular text-text-primary">
            {currentProduct.minStock ? `${currentProduct.minStock} ${currentProduct.unit}` : "-"}
          </p>
        </div>
        <div>
          <span className="text-xs text-text-secondary">Status Katalog</span>
          <div className="mt-1">
            <StatusBadge tone={currentProduct.status === "ACTIVE" ? "success" : "neutral"}>
              {currentProduct.status === "ACTIVE" ? "Katalog Aktif" : "Non-aktif"}
            </StatusBadge>
          </div>
        </div>
      </div>

      {/* 4 Tab Sesuai Dokumen Wireframe RPD & V2.4.1 */}
      <div className="border-b border-border">
        <nav aria-label="Tab Detail Produk" className="flex gap-2">
          {[
            { id: "ringkasan", label: "Ringkasan" },
            { id: "unit-sn", label: "Unit & SN" },
            { id: "riwayat", label: "Riwayat Stok" },
            { id: "info", label: "Informasi Produk" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as TabType)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Konten Tab */}
      <div className="rounded-lg border border-border bg-surface p-5">
        {/* Tab 1: Ringkasan */}
        {activeTab === "ringkasan" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-base font-semibold text-text-primary">Ringkasan Operasional Stok</h2>
            <Alert tone="info" title="Prinsip Integritas Stok">
              Saldo stok pada DocuFlow tidak dapat diedit langsung secara manual. Seluruh pergerakan stok dicatat melalui transaksi resmi (Barang Masuk, Barang Keluar, atau Stock Opname) untuk menjamin jejak audit immutable ledger.
            </Alert>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Total Fisik di Gudang</span>
                <p className="mt-1 text-2xl font-semibold tabular text-text-primary">
                  {currentProduct.stock} {currentProduct.unit}
                </p>
                <span className="text-xs text-text-secondary">Satuan resmi: {currentProduct.unit}</span>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Status Ketersediaan</span>
                <div className="mt-1">
                  {isOutOfStock ? (
                    <span className="text-sm font-semibold text-danger">Stok Habis (0 {currentProduct.unit})</span>
                  ) : isLowStock ? (
                    <span className="text-sm font-semibold text-warning">
                      Di bawah batas minimum ({currentProduct.minStock} {currentProduct.unit})
                    </span>
                  ) : (
                    <span className="text-sm font-semibold text-success">Stok mencukupi</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Batas minimum: {currentProduct.minStock ?? 0} {currentProduct.unit}
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Metode Pelacakan</span>
                <p className="mt-1 text-sm font-medium text-text-primary">
                  {isSerial ? "Pelacakan per Serial Number individual" : "Pelacakan berbasis kuantitas satuan"}
                </p>
                {isSerial && (
                  <div className="mt-1 space-y-0.5 text-xs text-text-secondary">
                    <p>Tersedia Mandiri: {(currentProduct as any).availableStandaloneStock ?? snStats.available} unit</p>
                    <p>Tergabung di Group: {(currentProduct as any).groupedStock ?? 0} unit</p>
                  </div>
                )}
              </div>
            </div>
            {currentProduct.description ? (
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Deskripsi Operasional:</span>
                <p className="mt-1 text-sm text-text-primary">{currentProduct.description}</p>
              </div>
            ) : null}
          </div>
        )}

        {/* Tab 2: Unit & SN */}
        {activeTab === "unit-sn" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-base font-semibold text-text-primary">Daftar Unit & Serial Number (SN)</h2>
                <p className="text-xs text-text-secondary">
                  {isSerial
                    ? `Pelacakan nomor seri individual produk serial di gudang aktif (${filteredSerials.length} dari ${serialItems.length} unit).`
                    : "Produk ini menggunakan pelacakan Non-Serial."}
                </p>
              </div>

              {isSerial && (
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <div className="w-full sm:w-48">
                    <SelectField
                      label="Filter Status Unit"
                      showRequirement={false}
                      value={snStatusFilter}
                      onChange={(e) => setSnStatusFilter(e.target.value)}
                      options={[
                        { value: "", label: "Semua Status Unit" },
                        { value: "AVAILABLE", label: "Tersedia (AVAILABLE)" },
                        { value: "GROUPED", label: "Tergabung (GROUPED)" },
                        { value: "RESERVED", label: "Direservasi (RESERVED)" },
                        { value: "QUARANTINE", label: "Karantina (QUARANTINE)" },
                        { value: "CONSUMED_OUT", label: "Keluar (CONSUMED_OUT)" },
                      ]}
                    />
                  </div>
                  <div className="w-full sm:w-56">
                    <TextField
                      label="Cari SN"
                      showRequirement={false}
                      placeholder="Ketik nomor seri..."
                      value={snSearch}
                      onChange={(e) => setSnSearch(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {isSerial ? (
              serialItems.length > 0 ? (
                filteredSerials.length > 0 ? (
                  <div className="overflow-x-auto rounded border border-border">
                    <table className="w-full border-collapse text-left text-sm">
                      <thead className="bg-surface-muted text-text-secondary">
                        <tr>
                          <th className="px-3 py-2.5 font-semibold">Nomor Seri (SN)</th>
                          <th className="px-3 py-2.5 font-semibold">Status Unit</th>
                          <th className="px-3 py-2.5 font-semibold">Lokasi / Rak</th>
                          <th className="px-3 py-2.5 font-semibold">Tanggal Terima</th>
                          <th className="px-3 py-2.5 font-semibold">Referensi Terakhir</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSerials.map((sn) => (
                          <tr key={sn.id} className="border-b border-border hover:bg-surface-muted">
                            <td className="px-3 py-2.5 font-mono text-xs font-semibold text-text-primary">
                              <div className="flex items-center gap-1.5">
                                <span>{sn.serialNumber}</span>
                                {sn.serialNumber.startsWith("G-") && (
                                  <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-bold bg-primary text-text-inverse">
                                    G
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusBadge
                                tone={
                                  sn.status === "AVAILABLE"
                                    ? "success"
                                    : sn.status === "GROUPED"
                                    ? "info"
                                    : sn.status === "RESERVED"
                                    ? "warning"
                                    : sn.status === "QUARANTINE"
                                    ? "danger"
                                    : "neutral"
                                }
                              >
                                {sn.status}
                              </StatusBadge>
                            </td>
                            <td className="px-3 py-2.5 text-text-secondary">{sn.location ?? "-"}</td>
                            <td className="px-3 py-2.5 text-text-secondary">{sn.receivedAt}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-text-secondary">
                              {sn.lastReference ?? "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Alert tone="neutral" title="Tidak Ditemukan">
                    Tidak ada nomor seri yang cocok dengan filter pencarian saat ini.
                  </Alert>
                )
              ) : (
                <Alert tone="neutral" title="Belum Ada SN Terdaftar">
                  Produk serial ini belum memiliki unit SN terdaftar di gudang ini. SN didaftarkan saat proses Barang Masuk (Goods In) fisik.
                </Alert>
              )
            ) : (
              <Alert tone="info" title="Produk Non-Serial">
                Produk ini menggunakan metode pelacakan Non-Serial. Pelacakan stok dilakukan berdasarkan kuantitas total per satuan ({currentProduct.unit}), bukan per nomor seri individual.
              </Alert>
            )}
          </div>
        )}

        {/* Tab 3: Riwayat Stok */}
        {activeTab === "riwayat" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-base font-semibold text-text-primary">Riwayat Transaksi Ledger Stok</h2>
            <p className="text-xs text-text-secondary">
              Histori pergerakan stok dari transaksi resmi yang tercatat di database SQLite immutable ledger.
            </p>
            {stockHistory.length > 0 ? (
              <div className="overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-surface-muted text-text-secondary">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Waktu</th>
                      <th className="px-3 py-2.5 font-semibold">Jenis Transaksi</th>
                      <th className="px-3 py-2.5 font-semibold">Referensi</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Perubahan Qty</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Saldo Akhir</th>
                      <th className="px-3 py-2.5 font-semibold">Petugas</th>
                      <th className="px-3 py-2.5 font-semibold">Catatan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockHistory.map((item) => (
                      <tr key={item.id} className="border-b border-border hover:bg-surface-muted">
                        <td className="px-3 py-2.5 text-text-secondary">{item.timestamp}</td>
                        <td className="px-3 py-2.5">
                          <StatusBadge tone={item.changeQty > 0 ? "success" : "neutral"}>
                            {item.type}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs font-semibold">{item.reference}</td>
                        <td className={`px-3 py-2.5 text-right tabular font-semibold ${item.changeQty > 0 ? "text-success" : "text-danger"}`}>
                          {item.changeQty > 0 ? `+${item.changeQty}` : item.changeQty} {item.unit}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular font-medium text-text-primary">
                          {item.balanceQty} {item.unit}
                        </td>
                        <td className="px-3 py-2.5 text-text-secondary">{item.actor}</td>
                        <td className="px-3 py-2.5 text-xs text-text-secondary">{item.note ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">Belum ada catatan mutasi ledger untuk produk ini.</p>
            )}
          </div>
        )}

        {/* Tab 4: Informasi Produk */}
        {activeTab === "info" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Informasi Produk Lengkap</h2>
              <Button variant="secondary" size="sm" onClick={handleOpenEdit}>
                Edit Informasi
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Barcode / EAN</span>
                <p className="mt-1 font-mono text-sm">{currentProduct.barcode ?? "Tidak ada barcode"}</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Kategori</span>
                <p className="mt-1 text-sm font-medium">{currentProduct.category}</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Satuan Dasar</span>
                <p className="mt-1 text-sm font-medium">{currentProduct.unit}</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">SKU Internasional</span>
                <p className="mt-1 font-mono text-sm">{currentProduct.sku}</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Batas Minimum Stok</span>
                <p className="mt-1 text-sm font-medium">{currentProduct.minStock ?? 0} {currentProduct.unit}</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Status Katalog</span>
                <p className="mt-1 text-sm font-medium">
                  {currentProduct.status === "ACTIVE" ? "Aktif" : "Non-aktif"}
                </p>
              </div>
            </div>
            {currentProduct.description ? (
              <div className="rounded-md border border-border p-3">
                <span className="text-xs text-text-secondary">Deskripsi Operasional:</span>
                <p className="mt-1 text-sm text-text-primary">{currentProduct.description}</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Modal Edit Metadata Produk */}
      <Dialog
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title="Edit Metadata Produk"
        description="Perbarui informasi umum master produk. SKU dan Satuan Dasar tidak dapat diedit untuk menjamin integritas riwayat ledger."
      >
        <form onSubmit={handleSaveEdit} className="flex flex-col gap-3">
          <TextField
            label="Nama Produk"
            required
            value={editName}
            error={editErrors.name}
            onChange={(e) => setEditName(e.target.value)}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label="SKU (Read Only)"
              readOnly
              value={currentProduct.sku}
              hint="SKU terkunci demi integritas pelacakan riwayat stok."
            />
            <TextField
              label="Barcode / EAN"
              placeholder="Contoh: 899123456789"
              value={editBarcode}
              onChange={(e) => setEditBarcode(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField
              label="Kategori"
              required
              value={editCategory}
              onChange={(e) => setEditCategory(e.target.value)}
              options={[
                { value: "Jaringan", label: "Jaringan" },
                { value: "Aksesoris", label: "Aksesoris" },
                { value: "Elektronik", label: "Elektronik" },
                { value: "Lainnya", label: "Lainnya" },
              ]}
            />
            <SelectField
              label="Status Katalog"
              required
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as "ACTIVE" | "INACTIVE")}
              options={[
                { value: "ACTIVE", label: "Aktif" },
                { value: "INACTIVE", label: "Non-aktif" },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-primary">
              Mode Pelacakan (Tracking Mode)
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label
                className={`flex items-center gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                  editTrackingMode === "SERIAL"
                    ? "border-primary bg-primary-soft/40 font-semibold text-primary"
                    : "border-border bg-surface text-text-secondary hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="editTrackingMode"
                  value="SERIAL"
                  checked={editTrackingMode === "SERIAL"}
                  onChange={() => setEditTrackingMode("SERIAL")}
                />
                <span>Serial Number (SN)</span>
              </label>
              <label
                className={`flex items-center gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                  editTrackingMode === "NON_SERIAL"
                    ? "border-primary bg-primary-soft/40 font-semibold text-primary"
                    : "border-border bg-surface text-text-secondary hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="editTrackingMode"
                  value="NON_SERIAL"
                  checked={editTrackingMode === "NON_SERIAL"}
                  onChange={() => setEditTrackingMode("NON_SERIAL")}
                />
                <span>Non-serial (Qty)</span>
              </label>
            </div>
            <span className="text-[11px] text-text-secondary">
              Pilih Serial Number jika produk memiliki unit fisik berlabel nomor seri individual.
            </span>
          </div>
          <TextField
            label={`Batas Minimum Stok (${currentProduct.unit})`}
            type="number"
            min="0"
            value={editMinStock}
            onChange={(e) => setEditMinStock(e.target.value)}
            hint="Sistem akan memberikan peringatan jika stok di bawah batas ini."
          />
          <TextareaField
            label="Deskripsi / Catatan Operasional"
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
          />
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setEditModalOpen(false)} disabled={isSaving}>
              Batal
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={isSaving}
              loading={isSaving}
              loadingLabel="Menyimpan Perubahan..."
            >
              Simpan Perubahan
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

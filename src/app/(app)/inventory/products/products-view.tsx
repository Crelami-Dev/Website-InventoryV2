"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column, type SortState } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/feedback";
import { TextField, SelectField, TextareaField } from "@/components/ui/form-fields";
import { ListToolbar, type ActiveFilter } from "@/components/ui/list-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { RecordCards, ViewSwitcher, type CollectionView } from "@/components/ui/record-cards";
import { useToast } from "@/components/ui/toast";
import { useActiveContext } from "@/lib/demo/active-context-provider";
import { FIXTURE_PRODUCTS, type Product } from "@/lib/demo/inventory-fixtures";
import { MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { createProductAction } from "@/lib/inventory/actions";

const PAGE_SIZE = 50;

export function ProductsView({ initialProducts }: { initialProducts?: Product[] }) {
  const { context } = useActiveContext();
  const toast = useToast();
  const isMd = useMediaQuery(MEDIA.md, true);

  const [products, setProducts] = useState<Product[]>(
    initialProducts && initialProducts.length > 0 ? initialProducts : FIXTURE_PRODUCTS
  );
  const [viewOverride, setViewOverride] = useState<CollectionView | null>(null);
  const view: CollectionView = viewOverride ?? (isMd ? "list" : "grid");

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [trackingFilter, setTrackingFilter] = useState("");
  const [stockStatusFilter, setStockStatusFilter] = useState("");
  const [sort] = useState<SortState>(null);

  const [page, setPage] = useState(1);

  // State Modal Tambah Produk
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formSku, setFormSku] = useState("");
  const [formBarcode, setFormBarcode] = useState("");
  const [formCategory, setFormCategory] = useState("Jaringan");
  const [formMinStock, setFormMinStock] = useState("5");
  const [formDesc, setFormDesc] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Filter per gudang aktif jika dipilih
  const warehouseProducts = useMemo(() => {
    return context.warehouseId
      ? products.filter((p) => p.warehouseId === context.warehouseId)
      : products;
  }, [products, context.warehouseId]);

  // Filter pencarian dan dropdown
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return warehouseProducts.filter((p) => {
      const matchSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode && p.barcode.includes(q));
      const matchCategory = !categoryFilter || p.category === categoryFilter;
      const matchTracking = !trackingFilter || p.tracking === trackingFilter;
      
      let matchStock = true;
      if (stockStatusFilter === "NORMAL") {
        matchStock = !p.minStock || p.stock > p.minStock;
      } else if (stockStatusFilter === "LOW") {
        matchStock = Boolean(p.minStock && p.stock <= p.minStock && p.stock > 0);
      } else if (stockStatusFilter === "EMPTY") {
        matchStock = p.stock === 0;
      }

      return matchSearch && matchCategory && matchTracking && matchStock;
    });
  }, [warehouseProducts, search, categoryFilter, trackingFilter, stockStatusFilter]);

  // Sorting
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "stock") return (a.stock - b.stock) * dir;
      if (sort.key === "sku") return a.sku.localeCompare(b.sku) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
  }, [filtered, sort]);

  // Paginasi
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Active filter chips
  const activeFilters: ActiveFilter[] = [];
  if (search.trim()) activeFilters.push({ key: "search", label: `Cari: ${search.trim()}` });
  if (categoryFilter) activeFilters.push({ key: "cat", label: `Kategori: ${categoryFilter}` });
  if (trackingFilter) activeFilters.push({ key: "track", label: `Tracking: ${trackingFilter === "SERIAL" ? "Serial" : "Non-serial"}` });
  if (stockStatusFilter) {
    const label = stockStatusFilter === "NORMAL" ? "Stok Aman" : stockStatusFilter === "LOW" ? "Stok Rendah" : "Stok Habis";
    activeFilters.push({ key: "stock", label: `Status Stok: ${label}` });
  }

  async function handleCreateProduct(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;

    const errors: Record<string, string> = {};
    if (!formName.trim()) errors.name = "Nama produk wajib diisi.";
    if (!formSku.trim()) errors.sku = "SKU unik wajib diisi.";

    // Cek duplikasi SKU di gudang aktif
    const duplicate = warehouseProducts.some(
      (p) => p.sku.trim().toLowerCase() === formSku.trim().toLowerCase()
    );
    if (duplicate) {
      errors.sku = `SKU "${formSku}" sudah digunakan di gudang ini. SKU harus unik per gudang.`;
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setIsSubmitting(true);
    try {
      const activeWh = context.warehouseId || "wh-north";
      const res = await createProductAction({
        warehouseId: activeWh,
        sku: formSku.trim().toUpperCase(),
        name: formName.trim(),
        barcode: formBarcode.trim() || undefined,
        category: formCategory,
        trackingMode: "NON_SERIAL",
        unit: "pcs",
        minStock: formMinStock ? Number(formMinStock) : 0,
        description: formDesc.trim() || undefined,
      });

      if (!res.success) {
        toast.push({
          tone: "danger",
          title: "Gagal Menambahkan Produk",
          description: res.error || "Terjadi kesalahan saat menyimpan ke database.",
        });
        return;
      }

      const p = res.product!;
      const newProd: Product = {
        id: p.id,
        warehouseId: p.warehouseId,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode ?? undefined,
        category: p.category,
        tracking: p.trackingMode,
        unit: p.unit,
        stock: p.physicalStock ?? 0,
        minStock: p.minStock,
        status: p.status === "ARCHIVED" ? "INACTIVE" : p.status,
        description: p.description ?? undefined,
      };

      setProducts((prev) => [newProd, ...prev]);
      setCreateModalOpen(false);
      toast.push({
        tone: "success",
        title: "Produk Baru Disimpan ke Database",
        description: `Produk ${newProd.name} (${newProd.sku}) berhasil didaftarkan di gudang aktif dengan saldo awal 0.`,
      });

      // Reset form
      setFormName("");
      setFormSku("");
      setFormBarcode("");
      setFormDesc("");
      setFormErrors({});
    } finally {
      setIsSubmitting(false);
    }
  }

  const columns: Column<Product>[] = [
    {
      key: "name",
      header: "Nama Produk",
      sortable: true,
      cell: (p) => (
        <div className="flex flex-col">
          <Link href={`/inventory/products/${p.id}`} className="font-semibold text-primary hover:underline">
            {p.name}
          </Link>
          <span className="text-xs text-text-secondary">{p.category}</span>
        </div>
      ),
    },
    {
      key: "sku",
      header: "SKU",
      sortable: true,
      cell: (p) => <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-semibold">{p.sku}</code>,
    },
    {
      key: "tracking",
      header: "Tracking",
      hideBelow: "md",
      cell: (p) => (
        <StatusBadge tone={p.tracking === "SERIAL" ? "info" : "neutral"}>
          {p.tracking === "SERIAL" ? "Serial Number" : "Non-serial"}
        </StatusBadge>
      ),
    },
    {
      key: "unit",
      header: "Satuan Dasar",
      hideBelow: "md",
      cell: (p) => <span className="font-mono text-xs font-medium text-text-secondary">{p.unit}</span>,
    },
    {
      key: "stock",
      header: "Stok Fisik",
      align: "right",
      sortable: true,
      cell: (p) => {
        const isOutOfStock = p.stock === 0;
        const isLowStock = Boolean(p.minStock && p.stock <= p.minStock && !isOutOfStock);
        return (
          <div className="flex flex-col items-end">
            <span
              className={`tabular font-semibold ${
                isOutOfStock ? "text-danger" : isLowStock ? "text-warning" : "text-text-primary"
              }`}
            >
              {p.stock} {p.unit}
            </span>
            {(p as any).groupedStock > 0 && (
              <span className="text-[10px] text-info">
                ({(p as any).availableStandaloneStock ?? p.stock} mandiri + {(p as any).groupedStock} group)
              </span>
            )}
            {isOutOfStock ? (
              <span className="text-[11px] font-medium text-danger">Stok Habis (0)</span>
            ) : isLowStock ? (
              <span className="text-[11px] font-medium text-warning">Min: {p.minStock} {p.unit}</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "Aksi",
      align: "right",
      cell: (p) => (
        <Link href={`/inventory/products/${p.id}`}>
          <Button variant="secondary" size="sm">
            Lihat Detail
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Katalog Produk"
        description="Kelola master produk, SKU unik, satuan dasar, dan pelacakan unit di gudang aktif."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/inventory/grouping">
              <Button variant="secondary">
                Kelola Grouping SN
              </Button>
            </Link>
            <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
              + Tambah Produk Baru
            </Button>
          </div>
        }
      />

      <ListToolbar
        searchLabel="Cari nama, SKU, atau barcode"
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Contoh: Kabel Cat6, MSE-OPT..."
        activeFilters={activeFilters}
        onRemoveFilter={(k) => {
          if (k === "search") setSearch("");
          if (k === "cat") setCategoryFilter("");
          if (k === "track") setTrackingFilter("");
          if (k === "stock") setStockStatusFilter("");
          setPage(1);
        }}
        onClearFilters={() => {
          setSearch("");
          setCategoryFilter("");
          setTrackingFilter("");
          setStockStatusFilter("");
          setPage(1);
        }}
        trailing={<ViewSwitcher value={view} onChange={setViewOverride} />}
        filters={
          <>
            <SelectField
              label="Kategori"
              showRequirement={false}
              placeholder="Semua Kategori"
              value={categoryFilter}
              onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
              options={[
                { value: "Jaringan", label: "Jaringan" },
                { value: "Aksesoris", label: "Aksesoris" },
                { value: "Elektronik", label: "Elektronik" },
              ]}
            />
            <SelectField
              label="Tracking"
              showRequirement={false}
              placeholder="Semua Tipe"
              value={trackingFilter}
              onChange={(e) => { setTrackingFilter(e.target.value); setPage(1); }}
              options={[
                { value: "SERIAL", label: "Serial Number" },
                { value: "NON_SERIAL", label: "Non-serial" },
              ]}
            />
            <SelectField
              label="Status Stok"
              showRequirement={false}
              placeholder="Semua Status Stok"
              value={stockStatusFilter}
              onChange={(e) => { setStockStatusFilter(e.target.value); setPage(1); }}
              options={[
                { value: "", label: "Semua Status Stok" },
                { value: "NORMAL", label: "Stok Aman (> Min)" },
                { value: "LOW", label: "Stok Rendah (<= Min)" },
                { value: "EMPTY", label: "Stok Habis (0)" },
              ]}
            />
          </>
        }
      />

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {view === "list" && isMd ? (
          <DataTable
            caption="Katalog Produk Gudang Aktif"
            columns={columns}
            rows={pagedRows}
            getRowId={(p) => p.id}
          />
        ) : (
          <div className="p-3">
            <RecordCards
              label="Katalog Produk Gudang Aktif"
              items={pagedRows}
              getId={(p) => p.id}
              layout={view}
              renderCard={(p) => (
                <div className="flex flex-col gap-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <Link href={`/inventory/products/${p.id}`} className="font-semibold text-text-primary hover:text-primary">
                        {p.name}
                      </Link>
                      <p className="text-xs text-text-secondary">{p.category}</p>
                    </div>
                    <StatusBadge tone={p.tracking === "SERIAL" ? "info" : "neutral"}>
                      {p.tracking === "SERIAL" ? "Serial Number" : "Non-serial"}
                    </StatusBadge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <code className="text-xs">{p.sku}</code>
                    <div className="text-right">
                      <span className={`font-semibold tabular ${p.stock === 0 ? "text-danger" : p.minStock && p.stock <= p.minStock ? "text-warning" : ""}`}>
                        {p.stock} {p.unit}
                      </span>
                      {p.stock === 0 ? (
                        <p className="text-[10px] text-danger">Stok Habis</p>
                      ) : p.minStock && p.stock <= p.minStock ? (
                        <p className="text-[10px] text-warning">Min: {p.minStock} {p.unit}</p>
                      ) : null}
                    </div>
                  </div>
                  <Link href={`/inventory/products/${p.id}`} className="mt-2">
                    <Button variant="secondary" size="sm" className="w-full">
                      Lihat Detail Produk
                    </Button>
                  </Link>
                </div>
              )}
            />
          </div>
        )}

        {sorted.length > 0 ? (
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={sorted.length}
            onPageChange={setPage}
          />
        ) : null}
      </div>

      {/* Modal Tambah Produk Baru */}
      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Tambah Produk Baru"
        description="Produk baru akan didaftarkan pada gudang aktif dengan saldo awal 0. Mutasi stok dilakukan via Goods In resmi."
      >
        <form onSubmit={handleCreateProduct} className="flex flex-col gap-3">
          <TextField
            label="Nama Produk"
            required
            placeholder="Contoh: Router Wireless AC1200"
            value={formName}
            error={formErrors.name}
            onChange={(e) => setFormName(e.target.value)}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label="SKU Produk (Unik)"
              required
              placeholder="Contoh: RTR-AC1200"
              value={formSku}
              error={formErrors.sku}
              onChange={(e) => setFormSku(e.target.value.toUpperCase())}
            />
            <TextField
              label="Barcode / EAN (Opsional)"
              placeholder="Contoh: 899123456789"
              value={formBarcode}
              onChange={(e) => setFormBarcode(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField
              label="Kategori"
              required
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value)}
              options={[
                { value: "Jaringan", label: "Jaringan" },
                { value: "Aksesoris", label: "Aksesoris" },
                { value: "Elektronik", label: "Elektronik" },
                { value: "Lainnya", label: "Lainnya" },
              ]}
            />
            <TextField
              label="Batas Minimum Stok"
              type="number"
              min="0"
              value={formMinStock}
              onChange={(e) => setFormMinStock(e.target.value)}
              hint="Sistem akan memberi peringatan jika stok di bawah batas ini."
            />
          </div>
          <TextareaField
            label="Deskripsi / Catatan Tambahan"
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
          />
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setCreateModalOpen(false)} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting} loading={isSubmitting} loadingLabel="Menyimpan Produk...">
              Simpan Produk
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

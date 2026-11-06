import React, { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServerSessionContext } from "@/lib/auth/server-session";
import { InventoryRepository } from "@/lib/db/repositories/inventory-repository";
import { FIXTURE_PRODUCTS, type Product, type SerialNumberItem, type StockHistoryItem } from "@/lib/demo/inventory-fixtures";
import { ProductDetailView } from "./product-detail-view";

export const metadata: Metadata = {
  title: "Detail Produk - Docuflow",
  description: "Informasi produk, nomor seri (Unit & SN), dan riwayat mutasi stok.",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

function ProductDetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse p-2">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-surface-muted rounded w-48" />
        <div className="h-8 bg-surface-muted rounded w-24" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <div className="h-40 bg-surface-muted rounded-xl" />
          <div className="h-60 bg-surface-muted rounded-xl" />
        </div>
        <div className="space-y-4">
          <div className="h-32 bg-surface-muted rounded-xl" />
          <div className="h-48 bg-surface-muted rounded-xl" />
        </div>
      </div>
    </div>
  );
}

async function ProductDetailContent({ params }: PageProps) {
  const { id } = await params;
  const session = await getServerSessionContext();

  let product: Product | null = null;
  let initialSerials: SerialNumberItem[] | undefined = undefined;
  let initialHistory: StockHistoryItem[] | undefined = undefined;

  if (session) {
    try {
      const repo = new InventoryRepository();
      const detail = repo.getProductById(session.context, id);
      if (detail) {
        product = {
          id: detail.product.id,
          sku: detail.product.sku,
          name: detail.product.name,
          barcode: detail.product.barcode ?? undefined,
          category: detail.product.category,
          tracking: detail.product.trackingMode,
          unit: detail.product.unit,
          stock: detail.product.physicalStock ?? 0,
          minStock: detail.product.minStock,
          status: detail.product.status === "ARCHIVED" ? "INACTIVE" : detail.product.status,
          description: detail.product.description ?? undefined,
          warehouseId: detail.product.warehouseId,
          serialCount: detail.serials.length,
        };
        initialSerials = detail.serials.map((s) => ({
          id: s.id,
          productId: s.productId,
          warehouseId: s.warehouseId,
          serialNumber: s.serialNumber,
          status: s.status,
          receivedAt: s.receivedAt,
        }));
        initialHistory = detail.ledgerHistory;
      }
    } catch (err) {
      console.error("Gagal membaca detail produk dari SQLite:", err);
    }
  }

  // Fallback to fixture if not found in SQLite
  if (!product) {
    product = FIXTURE_PRODUCTS.find((p) => p.id === id) ?? null;
  }

  if (!product) {
    notFound();
  }

  return (
    <ProductDetailView
      product={product}
      initialSerials={initialSerials}
      initialHistory={initialHistory}
    />
  );
}

export default function ProductDetailPage({ params }: PageProps) {
  return (
    <Suspense fallback={<ProductDetailSkeleton />}>
      <ProductDetailContent params={params} />
    </Suspense>
  );
}

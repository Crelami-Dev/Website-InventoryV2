import React from "react";
import type { Metadata } from "next";
import { ReturnsView } from "./returns-view";
import { getServerSessionContext } from "@/lib/auth/server-session";
import { InventoryRepository } from "@/lib/db/repositories/inventory-repository";
import type { ReturnItem, Partner, Product } from "@/lib/demo/inventory-fixtures";

export const metadata: Metadata = {
  title: "Retur Barang | Docuflow",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ReturnsPage() {
  const session = await getServerSessionContext();
  let initialReturns: ReturnItem[] = [];
  let initialPartners: Partner[] = [];
  let initialProducts: Product[] = [];

  if (session) {
    const repo = new InventoryRepository();
    const returnRows = repo.getInventoryReturns(session.context);
    const customers = repo.getCustomers(session.context);
    const suppliers = repo.getSuppliers(session.context);
    initialPartners = [...customers, ...suppliers];
    const dbProds = repo.getProductsByOwner(session.context);

    initialProducts = dbProds.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      warehouseId: p.warehouseId,
      warehouseName: session.context.warehouseName ?? "Gudang",
      category: p.category,
      tracking: p.trackingMode,
      trackingType: p.trackingMode,
      unit: p.unit,
      stock: p.physicalStock ?? 0,
      stockPhysical: p.physicalStock ?? 0,
      stockReserved: p.reservedStock ?? 0,
      stockAvailable: p.availableStock ?? 0,
      minStock: p.minStock,
      maxStock: p.minStock * 5,
      status: p.status === "ARCHIVED" ? "INACTIVE" : p.status,
    }));

    initialReturns = returnRows.map((r) => {
      const isSupplier = r.returnType === "SUPPLIER_RETURN";
      const partnerName = isSupplier
        ? (r.supplierName ?? "Pemasok")
        : (r.customerName ?? "Pelanggan");
      const sourceReference = isSupplier
        ? (r.goodsInId ? `GI-${r.goodsInId.slice(0, 8)}` : "GI-LANGSUNG")
        : (r.goodsOutId ? `GO-${r.goodsOutId.slice(0, 8)}` : "GO-LANGSUNG");

      return {
        id: r.id,
        returnNumber: r.returnNumber,
        returnType: r.returnType,
        sourceReference,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName ?? session.context.warehouseName ?? "Gudang",
        date: r.returnDate,
        partnerName,
        reason: r.reason,
        reopenSourceQty: r.reopenSourceQty,
        status: r.status,
        notes: r.notes ?? undefined,
        items: r.lines.map((l) => ({
          productId: l.productId,
          productName: l.productName ?? "Produk",
          qty: l.quantity,
          unit: l.unit,
          condition: l.condition,
          serialNumbers: l.returnedSerials,
        })),
      };
    });
  }

  return (
    <ReturnsView
      initialReturns={JSON.parse(JSON.stringify(initialReturns))}
      initialPartners={JSON.parse(JSON.stringify(initialPartners))}
      initialProducts={JSON.parse(JSON.stringify(initialProducts))}
    />
  );
}


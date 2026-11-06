import type { Metadata } from "next";
import { ReportsView } from "./reports-view";
import { getServerSessionContext } from "@/lib/auth/server-session";
import { InventoryRepository } from "@/lib/db/repositories/inventory-repository";
import type {
  Product,
  StockHistoryItem,
  SerialNumberItem,
  Warehouse,
} from "@/lib/demo/inventory-fixtures";

export const metadata: Metadata = {
  title: "Laporan Inventory | Docuflow",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ReportsPage() {
  const session = await getServerSessionContext();
  let initialProducts: Product[] = [];
  let initialLedger: StockHistoryItem[] = [];
  let initialSerials: SerialNumberItem[] = [];
  let initialWarehouses: Warehouse[] = [];

  if (session) {
    const repo = new InventoryRepository();
    const reportsData = repo.getReportsData(session.context);
    const warehouses = repo.getWarehouses(session.context);

    initialProducts = reportsData.products.map((p) => ({
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
      availableStandaloneStock: p.availableStandaloneStock,
      groupedStock: p.groupedStock,
      minStock: p.minStock,
      maxStock: p.minStock * 5,
      status: p.status === "ARCHIVED" ? "INACTIVE" : p.status,
    }));

    initialLedger = reportsData.ledger.map((l) => ({
      id: l.id,
      productId: l.id,
      warehouseId: session.context.warehouseId ?? "wh-01",
      timestamp: l.occurredAt.replace("T", " ").slice(0, 16),
      type: l.entryType.startsWith("GOODS_IN") ? "GOODS_IN" : "GOODS_OUT",
      reference: `${l.sourceDocType} (${l.sku || "PROD"})`,
      changeQty: l.quantityDelta,
      balanceQty: l.quantityDelta,
      unit: "pcs",
      actor: l.actorUserId,
      note: l.productName,
    }));

    initialSerials = reportsData.serials.map((s) => ({
      id: s.id,
      productId: s.productId,
      warehouseId: s.warehouseId,
      serialNumber: s.serialNumber,
      status: s.status === "CONSUMED_OUT" ? "OUT" : s.status === "DECOMMISSIONED" ? "QUARANTINE" : s.status,
      receivedAt: s.createdAt.slice(0, 10),
    }));

    initialWarehouses = warehouses.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      address: w.address ?? "",
      status: w.status,
    }));
  }

  return (
    <ReportsView
      initialProducts={initialProducts}
      initialLedger={initialLedger}
      initialSerials={initialSerials}
      initialWarehouses={initialWarehouses}
    />
  );
}


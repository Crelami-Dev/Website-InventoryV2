import type { Metadata } from "next";
import { getServerSessionContext } from "@/lib/auth/server-session";
import { InventoryRepository } from "@/lib/db/repositories/inventory-repository";
import { GroupingView } from "./grouping-view";

export const metadata: Metadata = {
  title: "Grouping Serial Number - Docuflow",
  description: "Kelola wadah kemasan Serial Number (lusin/pcs), barcode group G-xxxx, dan pelacakan unit.",
};

export default async function GroupingPage() {
  const session = await getServerSessionContext();
  let groupings: any[] = [];
  let products: any[] = [];
  let availableSerials: any[] = [];

  if (session) {
    try {
      const repo = new InventoryRepository();
      const warehouseId = session.context.warehouseId || undefined;
      groupings = repo.getSerialGroupings(session.context, warehouseId);
      products = repo.getProductsByOwner(session.context)
        .filter((p) => p.trackingMode === "SERIAL")
        .map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          stock: p.physicalStock ?? 0,
          availableStock: p.availableStock ?? 0,
          availableStandaloneStock: p.availableStandaloneStock ?? p.availableStock ?? 0,
        }));

      if (warehouseId) {
        availableSerials = repo.getAvailableSerialsByWarehouse(session.context, warehouseId);
      }
    } catch (err) {
      console.error("Gagal membaca data grouping dari database SQLite:", err);
    }
  }

  return (
    <GroupingView
      initialGroupings={groupings}
      products={products}
      initialSerials={availableSerials}
    />
  );
}

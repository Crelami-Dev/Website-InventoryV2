import React, { Suspense } from "react";
import { notFound } from "next/navigation";
import { Metadata } from "next";
import {
  FIXTURE_OPNAME_SESSIONS,
  FIXTURE_OPNAME_ITEMS,
  type StockOpnameSession,
  type StockOpnameCountItem,
} from "@/lib/demo/inventory-fixtures";
import { getServerSessionContext } from "@/lib/auth/server-session";
import { InventoryRepository } from "@/lib/db/repositories/inventory-repository";
import { StockOpnameDetailView } from "./stock-opname-detail-view";

export const metadata: Metadata = {
  title: "Detail Sesi Stock Opname | Docuflow",
  robots: {
    index: false,
    follow: false,
  },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

function StockOpnameDetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse p-2">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-surface-muted rounded w-48" />
        <div className="h-8 bg-surface-muted rounded w-24" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="h-20 bg-surface-muted rounded-lg" />
        <div className="h-20 bg-surface-muted rounded-lg" />
        <div className="h-20 bg-surface-muted rounded-lg" />
        <div className="h-20 bg-surface-muted rounded-lg" />
      </div>
      <div className="h-64 bg-surface-muted rounded-lg" />
    </div>
  );
}

async function StockOpnameDetailContent({ params }: PageProps) {
  const { id } = await params;
  const authSession = await getServerSessionContext();

  if (authSession) {
    try {
      const repo = new InventoryRepository();
      const detail = repo.getStockOpnameSessionDetail(authSession.context, id);
      if (detail) {
        const mappedSession: StockOpnameSession = {
          id: detail.session.id,
          sessionNumber: detail.session.sessionNumber,
          warehouseId: detail.session.warehouseId,
          warehouseName: detail.session.warehouseName ?? "Gudang",
          scope: detail.session.scope,
          scopeDetail: detail.session.title ?? undefined,
          status:
            detail.session.status === "COUNTING"
              ? "IN_PROGRESS"
              : detail.session.status === "REVIEW"
              ? "REVIEW"
              : "COMPLETED",
          createdAt: detail.session.startedAt.replace("T", " ").slice(0, 16),
          createdBy: detail.session.createdBy,
          snapshotFrozenAt: detail.session.snapshotAt ?? detail.session.startedAt,
          notes: detail.session.note ?? undefined,
          itemCount: detail.lines.length,
          varianceCount: detail.session.varianceCount,
        };

        const mappedItems: StockOpnameCountItem[] = detail.lines.map((l) => ({
          id: l.id,
          sessionId: l.sessionId,
          productId: l.productId,
          productName: l.productName,
          sku: l.sku,
          tracking: l.trackingMode,
          snapshotQty: l.snapshotQty,
          countedQty: l.countedQty,
          variance: l.varianceQty,
          unit: l.unit,
          scannedSerials: l.scannedSerials ?? [],
          unknownSerials: [],
          status:
            l.varianceQty === 0
              ? "MATCH"
              : l.varianceQty > 0
              ? "SURPLUS"
              : "DEFICIT",
        }));

        const isCancelled = detail.session.status === "CANCELLED";
        const isClosed = detail.session.status === "COMPLETED" || detail.session.status === "ADJUSTED" || isCancelled;
        const isNotAssigned = authSession.context.warehouseId !== detail.session.warehouseId && authSession.context.role !== "OWNER";
        const isReadOnly = isClosed || isNotAssigned;

        return (
          <StockOpnameDetailView
            session={{ ...mappedSession, isCancelled }}
            initialItems={mappedItems}
            initialAreas={detail.areas}
            isReadOnly={isReadOnly}
          />
        );
      }
    } catch (err) {
      console.warn(
        `[StockOpnameDetailPage] Gagal memuat detail sesi '${id}' untuk '${authSession.context.email}' (Owner: ${authSession.context.ownerId}, Gudang: ${authSession.context.warehouseId}):`,
        err instanceof Error ? err.message : err
      );
      // Fallback ke fixtures jika bukan ID database atau untuk pengujian UI statis
    }
  }

  const session = FIXTURE_OPNAME_SESSIONS.find((s) => s.id === id);

  if (!session) {
    notFound();
  }

  const items = FIXTURE_OPNAME_ITEMS.filter((i) => i.sessionId === id);

  return <StockOpnameDetailView session={session} initialItems={items} />;
}

export default function StockOpnameDetailPage({ params }: PageProps) {
  return (
    <Suspense fallback={<StockOpnameDetailSkeleton />}>
      <StockOpnameDetailContent params={params} />
    </Suspense>
  );
}


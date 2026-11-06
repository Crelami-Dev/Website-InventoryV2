/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Route Handler: Ekspor Daftar Sesi Stock Opname ke Excel (.xlsx)
 * Path: GET /api/inventory/stock-opname/export?warehouseId=...&status=...&search=...
 */

import { getServerSessionContext } from "@/lib/auth/server-session";
import { exportStockOpnameListExcel } from "@/lib/export/stock-opname-export";
import { AppError } from "@/lib/errors/app-error";

export async function GET(request: Request) {
  const session = await getServerSessionContext();
  if (!session) {
    return Response.json(
      { success: false, error: "Akses ditolak. Silakan login terlebih dahulu." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const warehouseId = searchParams.get("warehouseId") || undefined;
  const status = searchParams.get("status") || undefined;
  const search = searchParams.get("search") || undefined;

  try {
    const result = exportStockOpnameListExcel(session.context, {
      warehouseId,
      status,
      search,
    });
    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store, must-revalidate",
      },
    });
  } catch (err: unknown) {
    const status = err instanceof AppError ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : "Gagal mengekspor daftar Stock Opname.";
    return Response.json({ success: false, error: message }, { status });
  }
}

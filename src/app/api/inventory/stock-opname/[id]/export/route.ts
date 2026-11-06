/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Route Handler: Ekspor Detail Sesi Stock Opname ke Excel (.xlsx)
 * Path: GET /api/inventory/stock-opname/[id]/export
 */

import { getServerSessionContext } from "@/lib/auth/server-session";
import { exportStockOpnameSessionExcel } from "@/lib/export/stock-opname-export";
import { AppError } from "@/lib/errors/app-error";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSessionContext();
  if (!session) {
    return Response.json(
      { success: false, error: "Akses ditolak. Silakan login terlebih dahulu." },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    const result = exportStockOpnameSessionExcel(session.context, id);
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
    const message = err instanceof Error ? err.message : "Gagal mengekspor sesi Stock Opname.";
    return Response.json({ success: false, error: message }, { status });
  }
}

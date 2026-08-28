import { NextRequest, NextResponse } from "next/server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { buildInventoryExport } from "@/lib/inventory/inventoryExport";

/**
 * A plain Route Handler (not a Server Action) so the browser gets a real
 * file download via `Content-Disposition` — a Server Action would have
 * to shuttle the file back as a base64 string in a JSON payload (~33%
 * larger, and still needs a client-side Blob/download dance), which
 * buys nothing here. Read-only for every signed-in Inventory role
 * (ADMIN/EDITOR/VIEWER) — VIEWER can already read every field this
 * exports via the existing list/detail screens, so exporting the same
 * data as a file isn't a new permission surface (統合改善指示書 §16:
 * "エクスポート権限については既存権限設計との整合性を確認して判断").
 */
export async function GET(request: NextRequest) {
  const role = await getInventoryRole();
  if (!role) return new NextResponse("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  const scope = sp.get("scope") === "all" ? "all" : "filtered";
  const categoryIds = sp.get("categoryIds")?.split(",").filter(Boolean) ?? [];

  const filters =
    scope === "all"
      ? {}
      : {
          q: sp.get("q") ?? undefined,
          categoryIds,
          locationId: sp.get("locationId") ?? undefined,
          statusId: sp.get("statusId") ?? undefined,
        };

  try {
    const { buffer, filename, contentType } = await buildInventoryExport(format, filters);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[GET /api/inventory/export] failed:", err);
    return new NextResponse(err instanceof Error ? err.message : "エクスポートに失敗しました。", { status: 500 });
  }
}

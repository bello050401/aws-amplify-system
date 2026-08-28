import { NextRequest, NextResponse } from "next/server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { buildInventoryExport } from "@/lib/inventory/inventoryExport";
import { buildSearchFieldDefs, completeConditions, type AdvancedSearchQuery } from "@/lib/inventory/advancedSearch";
import { listCategories, listCustomFieldDefinitions, listLocations, listStatuses } from "@/lib/inventory/queries";

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
  const advRaw = sp.get("adv");

  const filters =
    scope === "all"
      ? {}
      : {
          q: sp.get("q") ?? undefined,
          categoryIds,
          locationId: sp.get("locationId") ?? undefined,
          statusId: sp.get("statusId") ?? undefined,
        };

  // 詳細検索(adv)が有効な場合はfiltersを無視してこちらだけ使う —
  // lib/inventory/inventoryExport.tsのbuildInventoryExportコメント参照。
  let advanced: Parameters<typeof buildInventoryExport>[2];
  if (scope === "filtered" && advRaw) {
    try {
      const parsed = JSON.parse(advRaw) as AdvancedSearchQuery;
      const conditions = completeConditions(parsed);
      if (conditions.length > 0) {
        const [categories, locations, statuses, customFieldDefs] = await Promise.all([
          listCategories(),
          listLocations(),
          listStatuses(),
          listCustomFieldDefinitions(),
        ]);
        const fieldDefs = buildSearchFieldDefs(customFieldDefs, { categories, locations, statuses });
        advanced = { query: { combinator: parsed.combinator === "OR" ? "OR" : "AND", conditions }, fieldsByKey: new Map(fieldDefs.map((f) => [f.key, f])) };
      }
    } catch {
      // 壊れた/手編集されたadvパラメータは無視し、単純フィルタ(あれば)
      // のままエクスポートする — 500エラーにはしない。
    }
  }

  try {
    const { buffer, filename, contentType } = await buildInventoryExport(format, filters, advanced);
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

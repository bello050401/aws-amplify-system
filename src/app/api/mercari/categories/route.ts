import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { listCategoryTree, syncCategoriesFromMercari } from "@/domain/services/CategoryService";

export async function GET() {
  const { all } = await listCategoryTree();
  return NextResponse.json({ categories: all });
}

/** カテゴリーをMercari Shops APIから再取得してキャッシュを更新する。 */
export async function POST() {
  try {
    const count = await syncCategoriesFromMercari();
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    return errorResponse(err, 502);
  }
}

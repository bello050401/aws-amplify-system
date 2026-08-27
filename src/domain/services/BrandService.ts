import { prisma } from "@/lib/prisma";
import { MercariShopsClient } from "@/integrations/mercari-shops/MercariShopsClient";
import { getMercariAccessToken } from "./MercariSettingsService";
import {
  PRODUCT_BRANDS_QUERY,
  type ProductBrandsResponse,
} from "@/integrations/mercari-shops/queries/brands";

/**
 * ブランド検索（指示書17項）。ブランド名を直接商品に送らず、`brandId` を保存する。
 * API呼び出しに成功した場合はDBへキャッシュしつつ結果を返す。API未接続時は
 * キャッシュ済みのローカル検索にフォールバックする（画面を壊さないため）。
 */
export async function searchBrands(query: string) {
  try {
    const client = new MercariShopsClient({ getAccessToken: getMercariAccessToken });
    const data = await client.request<ProductBrandsResponse>(PRODUCT_BRANDS_QUERY, { query });

    await prisma.$transaction(
      data.productBrands.map((b) =>
        prisma.brandMapping.upsert({
          where: { mercariBrandId: b.id },
          create: { mercariBrandId: b.id, name: b.name },
          update: { name: b.name, syncedAt: new Date() },
        }),
      ),
    );

    return prisma.brandMapping.findMany({
      where: { mercariBrandId: { in: data.productBrands.map((b) => b.id) } },
      orderBy: { name: "asc" },
    });
  } catch (err) {
    console.error("[BrandService] falling back to cached brands", err);
    return prisma.brandMapping.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
      orderBy: { name: "asc" },
      take: 20,
    });
  }
}

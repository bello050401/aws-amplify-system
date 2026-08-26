import { prisma } from "@/lib/prisma";
import { MercariShopsClient } from "@/integrations/mercari-shops/MercariShopsClient";
import { getMercariAccessToken } from "./MercariSettingsService";
import {
  PRODUCT_CATEGORIES_QUERY,
  type ProductCategoriesResponse,
} from "@/integrations/mercari-shops/queries/categories";
import { integrationLogger } from "@/lib/logger";

/**
 * メルカリShopsのカテゴリー情報を取得しDBへキャッシュする（指示書15項）。
 * 末端カテゴリー（子カテゴリーが存在しない）のみ商品登録に使用可能とするため、
 * `isLeaf` を保持する。
 */
export async function syncCategoriesFromMercari(): Promise<number> {
  const client = new MercariShopsClient({ getAccessToken: getMercariAccessToken });
  const data = await client.request<ProductCategoriesResponse>(PRODUCT_CATEGORIES_QUERY, {});

  const byId = new Map(data.productCategories.map((c) => [c.id, c]));
  const pathOf = (id: string): string => {
    const chain: string[] = [];
    let current: (typeof data.productCategories)[number] | undefined = byId.get(id);
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      chain.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain.join(" > ");
  };

  await prisma.$transaction(
    data.productCategories.map((cat) =>
      prisma.categoryMapping.upsert({
        where: { mercariCategoryId: cat.id },
        create: {
          mercariCategoryId: cat.id,
          name: cat.name,
          parentMercariId: cat.parentId,
          isLeaf: cat.children.length === 0,
          path: pathOf(cat.id),
        },
        update: {
          name: cat.name,
          parentMercariId: cat.parentId,
          isLeaf: cat.children.length === 0,
          path: pathOf(cat.id),
          syncedAt: new Date(),
        },
      }),
    ),
  );

  await integrationLogger.info({
    operation: "SYNC_CATEGORIES",
    message: `カテゴリー同期完了 (${data.productCategories.length}件)`,
  });

  return data.productCategories.length;
}

export async function listCategoryTree() {
  const all = await prisma.categoryMapping.findMany({ orderBy: { name: "asc" } });
  const byParent = new Map<string | null, typeof all>();
  for (const cat of all) {
    const key = cat.parentMercariId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(cat);
  }
  return { all, byParent };
}

export async function listFavoriteCategories() {
  return prisma.categoryFavorite.findMany({
    include: { categoryMapping: true },
    orderBy: { sortOrder: "asc" },
  });
}

export async function addFavoriteCategory(categoryMappingId: string) {
  const count = await prisma.categoryFavorite.count();
  await prisma.categoryFavorite.upsert({
    where: { categoryMappingId },
    create: { categoryMappingId, sortOrder: count },
    update: {},
  });
}

export async function removeFavoriteCategory(categoryMappingId: string) {
  await prisma.categoryFavorite.deleteMany({ where: { categoryMappingId } });
}

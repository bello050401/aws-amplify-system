import "server-only";
import type { Schema } from "@/amplify/data/resource";
import type { BaseItem } from "@/lib/base";
import { serverDataClient, runWithDirectData } from "@/lib/amplify/dataClient";
import { requestCache } from "@/lib/amplify/requestCache";
import { listAllPages, unwrapGet } from "@/lib/amplify/listAll";

// Only a slug enters this server-only path. The returned data must be explicitly
// published and visible; callers cannot supply arbitrary IDs or model names.
export const loadPublishedFeature = requestCache(async (slug: string) => runWithDirectData(async () => {
  // ここは公開ページ。取得に失敗して空配列が返ると、
  //
  //   ・特集そのもの … 実在するのに404として表示される
  //   ・掲載商品     … 「商品が1つも無い特集」として公開される
  //
  // どちらも見た目には正常なので、誰も異常に気づけない。0件と取得失敗を
  // 区別し、失敗は失敗としてエラー境界へ渡す(app/global-error.tsx が
  // 参照番号付きの画面を出す)。
  const features = await listAllPages<Schema["Feature"]["type"]>(
    nextToken => serverDataClient.models.Feature.listFeatureBySlug({ slug }, {
      limit: 1000, nextToken,
    }) as never, { label: "特集" },
  );
  const feature = features.find(row => row.slug === slug && row.status === "PUBLISHED");
  if (!feature) return null; // 本当に無い(未公開・slug違い)。これは404で正しい。

  const featureItems = await listAllPages<Schema["FeatureItem"]["type"]>(
    nextToken => serverDataClient.models.FeatureItem.list({
      filter: { featureId: { eq: feature.id }, isVisible: { eq: true } }, limit: 1000, nextToken,
    }) as never, { label: "特集の掲載商品" },
  );
  const sortedRefs = featureItems.filter(row => row.featureId === feature.id && row.isVisible === true).sort((a, b) => a.sortOrder - b.sortOrder);

  // Reads BaseItemCache, never the live BASE API — the public route has
  // no BASE access token available to it by design (see the BaseItemCache
  // comment in amplify/data/resource.ts). Cache rows are kept warm by
  // every admin-authenticated touch (lib/features/baseSync.ts).
  const cacheRows = await Promise.all(
    sortedRefs.map(async (ref) =>
      unwrapGet(await serverDataClient.models.BaseItemCache.get({ baseItemId: ref.baseItemId }), "商品キャッシュ"),
    ),
  );
  // ここで残る null は「キャッシュがまだ無い商品」。取得の失敗は上の
  // unwrapGet が投げるので、この filter に紛れ込まない。
  const items: BaseItem[] = cacheRows
    .filter((row): row is NonNullable<typeof row> => Boolean(row) && row?.isPublished === true)
    .map((row) => ({
      itemId: row.baseItemId,
      title: row.title ?? "",
      price: row.price ?? 0,
      description: "",
      images: (row.imageUrls ?? []).filter((url): url is string => Boolean(url)).map((url) => ({ url })),
      stock: row.stock ?? 0,
      variations: [],
      itemUrl: row.itemUrl ?? "",
      isPublished: row.isPublished ?? true,
      brand: row.brand ?? undefined,
    }));

  return { feature, items };
}));

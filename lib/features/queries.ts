import "server-only";
import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { BaseItem } from "@/lib/base";
import { fetchAndCacheItems } from "./baseSync";
import { parseFeatureContent, type FeatureContent } from "./contentCodec";
import { listAllPages, unwrapGet } from "@/lib/amplify/listAll";

export interface FeatureDashboardRow {
  id: string;
  title: string;
  slug: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  templateType: "COLLECTION" | "BRAND" | "FEATURE";
  itemCount: number;
  createdAt: string;
}

/**
 * Phase 1 dashboard: just enough to find and open a feature. Sold-out
 * rate / archive-recommendation banners (spec §16) call the BASE API once
 * per feature per view, which is exactly the per-page-view AI/API cost
 * spec §18 warns against paying without a cache — that lands in Phase 2
 * alongside the price/stock sync job (BaseItemCache), not here.
 */
export async function listFeaturesForDashboard(): Promise<FeatureDashboardRow[]> {
  // 取得に失敗すると「特集が1件も無い」画面になる。作ったはずのものが
  // 消えたように見えるので、0件と失敗を区別する。
  // **最後のページまで辿る。** 1ページ分だけで止めると、件数が増えた時点で
  // 一覧から静かに消える（2026-09-04 健全化 PHASE 25）。
  const [features, allItems] = await Promise.all([
    listAllPages<Omit<FeatureDashboardRow, "itemCount">>(
      (nextToken) => serverDataClient.models.Feature.list({ ...adminAuthMode, limit: 200, nextToken }) as never,
      { label: "特集" },
    ),
    listAllPages<{ featureId: string }>(
      (nextToken) => serverDataClient.models.FeatureItem.list({ ...adminAuthMode, limit: 500, nextToken }) as never,
      { label: "特集の掲載商品" },
    ),
  ]);

  return features
    .map((f) => ({
      id: f.id,
      title: f.title,
      slug: f.slug,
      status: f.status,
      templateType: f.templateType,
      itemCount: allItems.filter((i) => i.featureId === f.id).length,
      createdAt: f.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface FeatureWithItems {
  id: string;
  title: string;
  slug: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  templateType: "COLLECTION" | "BRAND" | "FEATURE";
  seoTitle: string | null;
  seoDescription: string | null;
  heroBaseItemId: string | null;
  content: FeatureContent | null;
  featureItemRows: { id: string; baseItemId: string; sortOrder: number; isVisible: boolean }[];
  items: BaseItem[];
}

export async function getFeatureWithItems(featureId: string): Promise<FeatureWithItems | null> {
  const feature = unwrapGet(
    await serverDataClient.models.Feature.get({ id: featureId }, adminAuthMode),
    "特集",
  );
  if (!feature) return null;

  // 掲載商品が空に化けると、編集画面から商品が消えたように見える。
  // そのまま保存すると本当に消える。
  // ここも最後のページまで辿る。1ページで切れると、編集画面に出なかった
  // 掲載商品が保存時に**本当に消える**（PHASE 25）。
  const featureItemRows = await listAllPages<{ id: string; featureId: string; baseItemId: string; sortOrder: number; isVisible?: boolean | null }>(
    (nextToken) =>
      serverDataClient.models.FeatureItem.list({
        filter: { featureId: { eq: featureId } },
        limit: 500,
        nextToken,
        ...adminAuthMode,
      }) as never,
    { label: "特集の掲載商品" },
  );
  const sortedRows = [...featureItemRows].sort((a, b) => a.sortOrder - b.sortOrder);

  const items = await fetchAndCacheItems(sortedRows.map((r) => r.baseItemId));
  const orderedItems = sortedRows
    .map((row) => items.find((item) => item.itemId === row.baseItemId))
    .filter((item): item is BaseItem => Boolean(item));

  return {
    id: feature.id,
    title: feature.title,
    slug: feature.slug,
    status: feature.status,
    templateType: feature.templateType,
    seoTitle: feature.seoTitle ?? null,
    seoDescription: feature.seoDescription ?? null,
    heroBaseItemId: feature.heroBaseItemId ?? null,
    content: parseFeatureContent(feature.content),
    featureItemRows: sortedRows.map((r) => ({
      id: r.id,
      baseItemId: r.baseItemId,
      sortOrder: r.sortOrder,
      isVisible: r.isVisible ?? true,
    })),
    items: orderedItems,
  };
}

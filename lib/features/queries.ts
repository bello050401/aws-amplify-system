import "server-only";
import { serverDataClient } from "@/lib/amplify/dataClient";
import type { BaseItem } from "@/lib/base";
import { fetchAndCacheItems } from "./baseSync";
import type { FeatureCopy } from "@/lib/ai/types";

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
  const { data: features } = await serverDataClient.models.Feature.list();
  const { data: allItems } = await serverDataClient.models.FeatureItem.list();

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
  content: Omit<FeatureCopy, "title" | "slug" | "seoTitle" | "seoDescription"> | null;
  featureItemRows: { id: string; baseItemId: string; sortOrder: number; isVisible: boolean }[];
  items: BaseItem[];
}

export async function getFeatureWithItems(featureId: string): Promise<FeatureWithItems | null> {
  const { data: feature } = await serverDataClient.models.Feature.get({ id: featureId });
  if (!feature) return null;

  const { data: featureItemRows } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: featureId } },
  });
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
    content: (feature.content as FeatureWithItems["content"]) ?? null,
    featureItemRows: sortedRows.map((r) => ({
      id: r.id,
      baseItemId: r.baseItemId,
      sortOrder: r.sortOrder,
      isVisible: r.isVisible ?? true,
    })),
    items: orderedItems,
  };
}

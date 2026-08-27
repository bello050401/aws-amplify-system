import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverDataClient } from "@/lib/amplify/dataClient";
import { parseFeatureContent } from "@/lib/features/contentCodec";
import type { BaseItem } from "@/lib/base";
import { Hero } from "@/components/features/Hero";
import { Introduction } from "@/components/features/Introduction";
import { ColorVariation } from "@/components/features/ColorVariation";
import { ProductGrid } from "@/components/features/ProductGrid";
import { Cta } from "@/components/features/Cta";

export const dynamic = "force-dynamic"; // price/stock must reflect BASE, not a stale build

interface FeaturePageProps {
  params: { slug: string };
}

async function loadPublishedFeature(slug: string) {
  const { data: features } = await serverDataClient.models.Feature.list({
    filter: { slug: { eq: slug }, status: { eq: "PUBLISHED" } },
  });
  const feature = features[0];
  if (!feature) return null;

  const { data: featureItems } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: feature.id }, isVisible: { eq: true } },
  });
  const sortedRefs = [...featureItems].sort((a, b) => a.sortOrder - b.sortOrder);

  // Reads BaseItemCache, never the live BASE API — the public route has
  // no BASE access token available to it by design (see the BaseItemCache
  // comment in amplify/data/resource.ts). Cache rows are kept warm by
  // every admin-authenticated touch (lib/features/baseSync.ts).
  const cacheRows = await Promise.all(
    sortedRefs.map((ref) => serverDataClient.models.BaseItemCache.get({ baseItemId: ref.baseItemId })),
  );
  const items: BaseItem[] = cacheRows
    .map((row) => row.data)
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
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
}

export async function generateMetadata({ params }: FeaturePageProps): Promise<Metadata> {
  const result = await loadPublishedFeature(params.slug);
  if (!result) return {};
  return {
    title: result.feature.seoTitle ?? result.feature.title,
    description: result.feature.seoDescription ?? undefined,
  };
}

export default async function FeaturePage({ params }: FeaturePageProps) {
  const result = await loadPublishedFeature(params.slug);
  if (!result) notFound();
  const { feature, items } = result;

  const content = parseFeatureContent(feature.content) ?? {
    headline: "",
    intro: "",
    productGroupNotes: "",
    differenceNotes: "",
    colorVariationNotes: "",
    stylingSuggestion: "",
    ctaText: "",
  };

  const heroItem =
    items.find((item) => item.itemId === feature.heroBaseItemId) ?? items[0];
  const brand = items.find((item) => item.brand)?.brand;

  return (
    <main>
      {heroItem?.images[0] && (
        <Hero
          brand={brand}
          title={feature.title}
          headline={content.headline ?? ""}
          imageUrl={heroItem.images[0].url}
        />
      )}

      <Introduction
        intro={content.intro ?? ""}
        productGroupNotes={content.productGroupNotes ?? ""}
        secondaryImageUrl={items[1]?.images[0]?.url}
      />

      {feature.templateType === "COLLECTION" && (
        <ColorVariation items={items} notes={content.colorVariationNotes} />
      )}

      <ProductGrid items={items} />

      <Cta
        text={content.ctaText ?? "BASEで見る"}
        href={items[0]?.itemUrl ?? "#"}
      />
    </main>
  );
}

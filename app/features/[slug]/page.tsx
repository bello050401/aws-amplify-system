import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseClient } from "@/lib/base";
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

  const baseClient = getBaseClient();
  const items = await baseClient.getItems(sortedRefs.map((ref) => ref.baseItemId));
  // Preserve the admin's chosen order — getItems doesn't guarantee it.
  const orderedItems = sortedRefs
    .map((ref) => items.find((item) => item.itemId === ref.baseItemId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return { feature, items: orderedItems };
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

  const content = (feature.content ?? {}) as {
    headline?: string;
    intro?: string;
    productGroupNotes?: string;
    colorVariationNotes?: string;
    ctaText?: string;
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

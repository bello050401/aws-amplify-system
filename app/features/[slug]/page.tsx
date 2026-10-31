import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublishedFeature } from "@/lib/features/publicFeature";
import { parseFeatureContent } from "@/lib/features/contentCodec";
import { Hero } from "@/components/features/Hero";
import { Introduction } from "@/components/features/Introduction";
import { ColorVariation } from "@/components/features/ColorVariation";
import { ProductGrid } from "@/components/features/ProductGrid";
import { Cta } from "@/components/features/Cta";

export const dynamic = "force-dynamic"; // price/stock must reflect BASE, not a stale build

interface FeaturePageProps {
  params: { slug: string };
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

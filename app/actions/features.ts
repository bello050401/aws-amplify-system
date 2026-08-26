"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseClient } from "@/lib/base";
import { getAIProvider, suggestTemplateType, suggestSlug, type TemplateType } from "@/lib/ai";
import type { FeatureCopy } from "@/lib/ai/types";

/**
 * The "選択したN商品で特集を生成" CTA (spec §1 core flow, §7). Creates a
 * DRAFT immediately — nothing is public until an explicit Publish action
 * — so the admin always lands on a preview, never on a live page.
 */
export async function generateFeature(itemIds: string[], templateOverride?: TemplateType) {
  if (itemIds.length === 0) throw new Error("商品が選択されていません。");

  const items = await getBaseClient().getItems(itemIds);
  const templateType = templateOverride ?? suggestTemplateType(items);
  const copy = await getAIProvider().generateFeatureCopy({ items, templateType });

  const { data: feature, errors } = await serverDataClient.models.Feature.create({
    title: copy.title,
    slug: copy.slug || suggestSlug(copy.title, items),
    status: "DRAFT",
    templateType,
    seoTitle: copy.seoTitle,
    seoDescription: copy.seoDescription,
    heroBaseItemId: items[0]?.itemId,
    content: {
      headline: copy.headline,
      intro: copy.intro,
      productGroupNotes: copy.productGroupNotes,
      differenceNotes: copy.differenceNotes,
      colorVariationNotes: copy.colorVariationNotes ?? "",
      stylingSuggestion: copy.stylingSuggestion,
      ctaText: copy.ctaText,
    } satisfies Omit<FeatureCopy, "title" | "slug" | "seoTitle" | "seoDescription">,
  });

  if (errors || !feature) {
    throw new Error(`特集の作成に失敗しました: ${JSON.stringify(errors)}`);
  }

  await Promise.all(
    itemIds.map((baseItemId, index) =>
      serverDataClient.models.FeatureItem.create({
        featureId: feature.id,
        baseItemId,
        sortOrder: index,
        isVisible: true,
      }),
    ),
  );

  revalidatePath("/admin");
  redirect(`/admin/features/${feature.id}`);
}

export interface FeatureFieldPatch {
  title?: string;
  slug?: string;
  templateType?: TemplateType;
  seoTitle?: string;
  seoDescription?: string;
  heroBaseItemId?: string;
  content?: Partial<Omit<FeatureCopy, "title" | "slug" | "seoTitle" | "seoDescription">>;
}

export async function updateFeature(featureId: string, patch: FeatureFieldPatch) {
  const { data: existing } = await serverDataClient.models.Feature.get({ id: featureId });
  if (!existing) throw new Error("特集が見つかりません。");

  await serverDataClient.models.Feature.update({
    id: featureId,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
    ...(patch.templateType !== undefined ? { templateType: patch.templateType } : {}),
    ...(patch.seoTitle !== undefined ? { seoTitle: patch.seoTitle } : {}),
    ...(patch.seoDescription !== undefined ? { seoDescription: patch.seoDescription } : {}),
    ...(patch.heroBaseItemId !== undefined ? { heroBaseItemId: patch.heroBaseItemId } : {}),
    ...(patch.content !== undefined
      ? { content: { ...(existing.content as object), ...patch.content } }
      : {}),
  });

  revalidatePath(`/admin/features/${featureId}`);
  revalidatePath(`/features/${patch.slug ?? existing.slug}`);
}

/** Full re-generation (Phase 1). Per-section regeneration is Phase 2 — see lib/ai/provider regenerateSection, already wired for when that UI lands. */
export async function regenerateWholeFeature(featureId: string) {
  const { data: feature } = await serverDataClient.models.Feature.get({ id: featureId });
  if (!feature) throw new Error("特集が見つかりません。");

  const { data: rows } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: featureId } },
  });
  const items = await getBaseClient().getItems(rows.map((r) => r.baseItemId));
  const copy = await getAIProvider().generateFeatureCopy({ items, templateType: feature.templateType });

  await serverDataClient.models.Feature.update({
    id: featureId,
    title: copy.title,
    seoTitle: copy.seoTitle,
    seoDescription: copy.seoDescription,
    content: {
      headline: copy.headline,
      intro: copy.intro,
      productGroupNotes: copy.productGroupNotes,
      differenceNotes: copy.differenceNotes,
      colorVariationNotes: copy.colorVariationNotes ?? "",
      stylingSuggestion: copy.stylingSuggestion,
      ctaText: copy.ctaText,
    },
  });

  revalidatePath(`/admin/features/${featureId}`);
}

export async function removeFeatureItem(featureItemRowId: string, featureId: string) {
  await serverDataClient.models.FeatureItem.delete({ id: featureItemRowId });
  revalidatePath(`/admin/features/${featureId}`);
}

export async function publishFeature(featureId: string) {
  await serverDataClient.models.Feature.update({
    id: featureId,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
  });
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function unpublishFeature(featureId: string) {
  await serverDataClient.models.Feature.update({ id: featureId, status: "DRAFT" });
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function archiveFeature(featureId: string) {
  await serverDataClient.models.Feature.update({
    id: featureId,
    status: "ARCHIVED",
    archivedAt: new Date().toISOString(),
  });
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function deleteFeature(featureId: string) {
  const { data: rows } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: featureId } },
  });
  await Promise.all(rows.map((r) => serverDataClient.models.FeatureItem.delete({ id: r.id })));
  await serverDataClient.models.Feature.delete({ id: featureId });
  revalidatePath("/admin");
  redirect("/admin");
}

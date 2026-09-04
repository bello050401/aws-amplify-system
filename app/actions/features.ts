"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/amplify/requireAdmin";
import { redirect } from "next/navigation";
import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { fetchAndCacheItems } from "@/lib/features/baseSync";
import { getAIProvider, suggestTemplateType, suggestSlug, type TemplateType } from "@/lib/ai";
import { parseFeatureContent, stringifyFeatureContent, type FeatureContent } from "@/lib/features/contentCodec";
import { unwrapList, unwrapWrite } from "@/lib/amplify/listAll";

/**
 * The "選択したN商品で特集を生成" CTA (spec §1 core flow, §7). Creates a
 * DRAFT immediately — nothing is public until an explicit Publish action
 * — so the admin always lands on a preview, never on a live page.
 *
 * Every Feature/FeatureItem write below passes `adminAuthMode` — these
 * models default to `apiKey` auth (see lib/amplify/dataClient.ts), which
 * satisfies their public *read* rule but not `allow.group("Admins")`,
 * so writes need the caller's actual Cognito session.
 */
/**
 * Server Action は「その関数を呼ぶPOSTエンドポイント」として外部へ公開
 * される。ページのlayoutにある認証はページの描画を守るだけで、Actionの
 * 呼び出しは守らない（2026-09-04 健全化 PHASE 12）。
 *
 * 実際には、この下の処理はいずれもBASEのトークンを adminAuthMode で読む
 * ため、未ログインの呼び出しはAppSyncの認可で弾かれる。ただしその守りは
 * **下位レイヤに1本だけ**ぶら下がっていて、認可モードを変えたり、トークン
 * 読み取りより前に処理を足したりすると黙って消える。他の28個のaction
 * ファイルと同じように、入口で明示的に確かめる。
 */
async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new Error("この操作にはAdmins権限が必要です。");
}

export async function generateFeature(itemIds: string[], templateOverride?: TemplateType) {
  await requireAdmin();
  if (itemIds.length === 0) throw new Error("商品が選択されていません。");

  const items = await fetchAndCacheItems(itemIds);
  const templateType = templateOverride ?? suggestTemplateType(items);
  const copy = await getAIProvider().generateFeatureCopy({ items, templateType });

  const { data: feature, errors } = await serverDataClient.models.Feature.create(
    {
      title: copy.title,
      slug: copy.slug || suggestSlug(copy.title, items),
      status: "DRAFT",
      templateType,
      seoTitle: copy.seoTitle,
      seoDescription: copy.seoDescription,
      heroBaseItemId: items[0]?.itemId,
      content: stringifyFeatureContent({
        headline: copy.headline,
        intro: copy.intro,
        productGroupNotes: copy.productGroupNotes,
        differenceNotes: copy.differenceNotes,
        colorVariationNotes: copy.colorVariationNotes ?? "",
        stylingSuggestion: copy.stylingSuggestion,
        ctaText: copy.ctaText,
      }),
    },
    adminAuthMode,
  );

  if (errors || !feature) {
    throw new Error(`特集の作成に失敗しました: ${JSON.stringify(errors)}`);
  }

  await Promise.all(
    itemIds.map((baseItemId, index) =>
      serverDataClient.models.FeatureItem.create(
        {
          featureId: feature.id,
          baseItemId,
          sortOrder: index,
          isVisible: true,
        },
        adminAuthMode,
      ),
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
  content?: Partial<FeatureContent>;
}

export async function updateFeature(featureId: string, patch: FeatureFieldPatch) {
  await requireAdmin();
  const { data: existing } = await serverDataClient.models.Feature.get({ id: featureId }, adminAuthMode);
  if (!existing) throw new Error("特集が見つかりません。");

  await serverDataClient.models.Feature.update(
    {
      id: featureId,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.templateType !== undefined ? { templateType: patch.templateType } : {}),
      ...(patch.seoTitle !== undefined ? { seoTitle: patch.seoTitle } : {}),
      ...(patch.seoDescription !== undefined ? { seoDescription: patch.seoDescription } : {}),
      ...(patch.heroBaseItemId !== undefined ? { heroBaseItemId: patch.heroBaseItemId } : {}),
      ...(patch.content !== undefined
        ? {
            // Same trust boundary as before this field became a stringified
            // AWSJSON value (see contentCodec.ts): a partial patch merged
            // onto whatever's already stored is assumed to add up to a
            // complete FeatureContent, matching how the editor always
            // submits every field together.
            content: stringifyFeatureContent({
              ...parseFeatureContent(existing.content),
              ...patch.content,
            } as FeatureContent),
          }
        : {}),
    },
    adminAuthMode,
  );

  revalidatePath(`/admin/features/${featureId}`);
  revalidatePath(`/features/${patch.slug ?? existing.slug}`);
}

/** Full re-generation (Phase 1). Per-section regeneration is Phase 2 — see lib/ai/provider regenerateSection, already wired for when that UI lands. */
export async function regenerateWholeFeature(featureId: string) {
  await requireAdmin();
  const { data: feature } = await serverDataClient.models.Feature.get({ id: featureId }, adminAuthMode);
  if (!feature) throw new Error("特集が見つかりません。");

  const { data: rows } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: featureId } },
    ...adminAuthMode,
  });
  const items = await fetchAndCacheItems(rows.map((r) => r.baseItemId));
  const copy = await getAIProvider().generateFeatureCopy({ items, templateType: feature.templateType });

  await serverDataClient.models.Feature.update(
    {
      id: featureId,
      title: copy.title,
      seoTitle: copy.seoTitle,
      seoDescription: copy.seoDescription,
      content: stringifyFeatureContent({
        headline: copy.headline,
        intro: copy.intro,
        productGroupNotes: copy.productGroupNotes,
        differenceNotes: copy.differenceNotes,
        colorVariationNotes: copy.colorVariationNotes ?? "",
        stylingSuggestion: copy.stylingSuggestion,
        ctaText: copy.ctaText,
      }),
    },
    adminAuthMode,
  );

  revalidatePath(`/admin/features/${featureId}`);
}

export async function removeFeatureItem(featureItemRowId: string, featureId: string) {
  await requireAdmin();
  unwrapWrite(
    await serverDataClient.models.FeatureItem.delete({ id: featureItemRowId }, adminAuthMode),
    "掲載商品の削除",
  );
  revalidatePath(`/admin/features/${featureId}`);
}

export async function publishFeature(featureId: string) {
  await requireAdmin();
  // Refresh the public-facing cache one more time right before this
  // feature goes live, so the first visitor sees current price/stock/images.
  const { data: rows } = await serverDataClient.models.FeatureItem.list({
    filter: { featureId: { eq: featureId } },
    ...adminAuthMode,
  });
  await fetchAndCacheItems(rows.map((r) => r.baseItemId));

  await serverDataClient.models.Feature.update(
    {
      id: featureId,
      status: "PUBLISHED",
      publishedAt: new Date().toISOString(),
    },
    adminAuthMode,
  );
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function unpublishFeature(featureId: string) {
  await requireAdmin();
  await serverDataClient.models.Feature.update({ id: featureId, status: "DRAFT" }, adminAuthMode);
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function archiveFeature(featureId: string) {
  await requireAdmin();
  await serverDataClient.models.Feature.update(
    {
      id: featureId,
      status: "ARCHIVED",
      archivedAt: new Date().toISOString(),
    },
    adminAuthMode,
  );
  revalidatePath("/admin");
  revalidatePath(`/admin/features/${featureId}`);
}

export async function deleteFeature(featureId: string) {
  await requireAdmin();
  // 子(FeatureItem)を消してから親(Feature)を消す。ここで一覧の取得が
  // 失敗して0件が返ると、**子を1件も消さないまま親だけ消える** ——
  // 存在しない特集を指す行が残り、あとから辿れなくなる。
  // 取得に失敗したら削除そのものを行わない。
  const rows = unwrapList(
    await serverDataClient.models.FeatureItem.list({
      filter: { featureId: { eq: featureId } },
      ...adminAuthMode,
    }),
    "特集の掲載商品",
  );
  // 子の削除も1件ずつ確認する。どれかが失敗したまま親を消すと同じことになる。
  await Promise.all(
    rows.map(async (r) =>
      unwrapWrite(await serverDataClient.models.FeatureItem.delete({ id: r.id }, adminAuthMode), "掲載商品の削除"),
    ),
  );
  unwrapWrite(await serverDataClient.models.Feature.delete({ id: featureId }, adminAuthMode), "特集の削除");
  revalidatePath("/admin");
  redirect("/admin");
}

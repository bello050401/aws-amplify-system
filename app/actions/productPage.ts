"use server";

import { randomUUID } from "node:crypto";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { generateProductPage, type ProductPageResult } from "@/lib/ai/productPage/service";
import { inferCategory, type BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import { baseBrandHint, type ArchivedStyleReference } from "@/lib/base/archive/similar";

/**
 * 在庫からBASE掲載用の商品ページを生成する。
 *
 * ## 生成しても外部へは出さない
 *
 * ここで作るのは**下書き**で、BASEへは何も書き込まない。人が確認して
 * から出品する流れを前提にしている(外部への書き込みは
 * lib/integrations/writeGuard.ts が別途止めている)。
 *
 * ## 例外を投げずに結果を返す
 *
 * app/actions/ai.ts と同じ理由 —— production build では Server Action の
 * throw が英語の定型文へ丸められ、利用者には何が起きたか分からなくなる。
 */

export type ProductPageActionResult =
  | { ok: true; result: ProductPageResult; savedId: string | null }
  | { ok: false; error: string; correlationId: string };

/**
 * 文体の参考にする過去BASE商品を読む。
 *
 * 267件・約2.7MBなので毎回読むのは無駄がある一方、生成は「ボタンを
 * 押したとき」にしか起きない低頻度の操作なので、キャッシュを持って
 * 古い文体を参照し続けるより、その都度読む方が素直で安全。
 */
async function loadArchive(): Promise<ArchivedStyleReference[]> {
  const out: ArchivedStyleReference[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.BaseProductArchive.list({
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`過去BASE商品の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    for (const row of data) {
      if (!row.introText) continue; // 紹介文が無いものは文体の参考にならない
      out.push({
        baseItemId: row.baseItemId,
        titleCore: row.titleCore ?? row.title ?? "",
        brand: baseBrandHint(row.title ?? ""),
        category: inferCategory(row.title ?? ""),
        price: row.price ?? null,
        introText: row.introText,
      });
    }
    nextToken = nt;
  } while (nextToken);
  return out;
}

/** 現在有効な Style Profile(isActive の1件)。無ければ null。 */
async function loadActiveStyleProfile(): Promise<{ profile: BelloStyleProfile; version: number } | null> {
  const { data, errors } = await serverDataClient.models.BelloStyleProfile.list({ ...inventoryAuthMode, limit: 100 });
  if (errors) throw new Error(`文体プロファイルの取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  const active = data.find((d) => d.isActive === true);
  if (!active?.profileJson) return null;
  return { profile: JSON.parse(active.profileJson) as BelloStyleProfile, version: active.version };
}

export async function generateProductPageAction(inventoryId: string): Promise<ProductPageActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (!canEditInventory(role)) {
      return { ok: false, error: "この操作にはADMINまたはEDITOR権限が必要です。", correlationId };
    }
    const who = await getCurrentInventoryUserEmail();

    const item = await getInventoryDetail(inventoryId);
    if (!item) return { ok: false, error: "対象の在庫が見つかりません。", correlationId };

    const [archive, styleProfile, categories] = await Promise.all([
      loadArchive(),
      loadActiveStyleProfile(),
      listAllMasterEntries("Category"),
    ]);
    const categoryName = categories.find((c) => c.id === item.categoryId)?.name ?? null;

    const result = await generateProductPage({
      inventoryId: item.id,
      name: item.name,
      categoryName,
      width: item.width ? String(item.width) : null,
      depth: item.depth ? String(item.depth) : null,
      height: item.height ? String(item.height) : null,
      damageNotes: item.damageNotes ?? null,
      note: item.note ?? null,
      conditionRating: item.conditionRating ?? null,
      stockQuantity: item.quantity ?? null,
      sku: item.sku ?? null,
      price: item.salePrice ?? item.plannedSalePrice ?? null,
      brand: baseBrandHint(item.name),
      archive,
      styleProfile: styleProfile?.profile ?? null,
      styleProfileVersion: styleProfile?.version ?? null,
    });

    // 生成できたものは保存する。事実の裏付け検査に落ちた場合でも
    // 保存はする —— 何が出たのかを人が見られないと、直しようがない。
    let savedId: string | null = null;
    if (result.sections) {
      const { data, errors } = await serverDataClient.models.GeneratedProductPage.create(
        {
          inventoryId: item.id,
          title: result.sections.title,
          introduction: result.sections.introduction,
          brandSection: result.sections.brandSection,
          designerSection: result.sections.designerSection,
          featureSection: result.sections.featureSection,
          materialSection: result.sections.materialSection,
          dimensionsSection: result.sections.dimensionsSection,
          conditionSection: result.sections.conditionSection,
          shippingSection: result.sections.shippingSection,
          fullDescription: result.fullDescription,
          styleProfileVersion: result.styleProfileVersion ?? undefined,
          referencedBaseItemIdsJson: JSON.stringify(result.referencedBaseItemIds),
          validationJson: JSON.stringify(result.violations),
          missingFactsJson: JSON.stringify(result.missingFacts),
          modelProvider: result.modelProvider ?? undefined,
          modelName: result.modelName ?? undefined,
          generatedAt: new Date().toISOString(),
          generatedBy: who ?? undefined,
        },
        inventoryAuthMode,
      );
      // 保存に失敗しても生成結果は返す。画面から使えることの方が優先。
      if (errors) console.error("[generateProductPageAction] 保存に失敗:", errors.map((e) => e.message).join("; "));
      else savedId = data?.id ?? null;
    }

    return { ok: true, result, savedId };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        action: "generateProductPageAction",
        correlationId,
        inventoryId,
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: false, error: err instanceof Error ? err.message : "商品ページの生成に失敗しました。", correlationId };
  }
}

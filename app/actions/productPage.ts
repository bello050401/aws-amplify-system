"use server";

import { randomUUID } from "node:crypto";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { ProductPageResult } from "@/lib/ai/productPage/service";
import { generateCanonicalProductPage } from "@/lib/ai/productPage/canonical";

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
 * 2026-09-02 指示書§2: 過去BASE商品の読み込みと Style Profile の取得は
 * lib/ai/productPage/canonical.ts へ移した。上側の出品下書きと下側の
 * BASE商品ページ下書きが**同じ関数**を通るようにするため —— ここに複製を
 * 残すと、片方だけ直したときに静かに挙動が食い違う。
 */
export async function generateProductPageAction(inventoryId: string): Promise<ProductPageActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (!canEditInventory(role)) {
      return { ok: false, error: "この操作にはADMINまたはEDITOR権限が必要です。", correlationId };
    }
    const who = await getCurrentInventoryUserEmail();

    // 上側の出品下書きとまったく同じ関数を通る(指示書§2の一本化)。
    // 在庫の存在確認も canonical 側が行い、見つからなければ例外になる。
    const result = await generateCanonicalProductPage(inventoryId);

    // 生成できたものは保存する。事実の裏付け検査に落ちた場合でも
    // 保存はする —— 何が出たのかを人が見られないと、直しようがない。
    let savedId: string | null = null;
    if (result.sections) {
      const { data, errors } = await serverDataClient.models.GeneratedProductPage.create(
        {
          inventoryId: result.inventoryId,
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

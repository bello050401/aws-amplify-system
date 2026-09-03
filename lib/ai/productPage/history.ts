import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { CanonicalGenerationResult } from "./canonical";

/**
 * 生成履歴の保存(GeneratedProductPage)。
 *
 * ── なぜ共通化したか(2026-09-03 追加指示 §41/§47) ────────────────
 *
 * EC出品画面には生成の入口が2つあり、**下側(BASE商品ページの下書き)
 * だけ**が生成結果を保存していた。上側(出品下書き → AIで下書き生成)は
 * 保存していない。下側のUIを消すと、この記録も一緒に消えるところだった。
 *
 * 「UIが不要だからという理由で、裏側の有用な処理まで一緒に削除しない」
 * (§47)ため、保存そのものをここへ出して、残る入口から呼ぶ。
 *
 * ── 保存に失敗しても生成結果は返す ──────────────────────────────
 *
 * 記録は後から追うためのもので、いま画面で使えることのほうが優先。
 * ただし失敗を黙って捨てない —— 理由を返して呼び出し側がログへ残す。
 */
export interface SaveHistoryResult {
  savedId: string | null;
  /** 保存できなかった理由。保存できたときは null。 */
  reason: string | null;
}

export async function saveGeneratedProductPage(
  result: CanonicalGenerationResult,
  who: string | null,
): Promise<SaveHistoryResult> {
  if (!result.sections) {
    return { savedId: null, reason: "本文が生成できていないため、生成履歴は保存していません。" };
  }
  try {
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
    if (errors) {
      return { savedId: null, reason: `生成履歴の保存に失敗しました: ${errors.map((e) => e.message).join("; ")}` };
    }
    return { savedId: data?.id ?? null, reason: null };
  } catch (err) {
    return {
      savedId: null,
      reason: `生成履歴の保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

import "server-only";
import { generateStructured } from "@/lib/ai/gateway/gateway";
import { buildCustomerSafeFacts, type CustomerSafeFacts, type FactRedaction } from "@/lib/ai/productIntro/facts";
import { checkFactSafety, type FactSafetyViolation } from "@/lib/ai/productIntro/factSafety";
import type { BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import { findSimilarArchivedProducts, type ArchivedStyleReference, type SimilarityHit } from "@/lib/base/archive/similar";
import {
  findGenericPhrases,
  findIntroDimensionViolations,
  isIntroStillUsable,
  stripDimensionSentences,
  MAX_GENERIC_PHRASES,
  type IntroDimensionViolation,
} from "./introValidator";
import {
  buildProductPageSystemPrompt,
  buildProductPageUserPrompt,
  PRODUCT_PAGE_PROMPT_VERSION,
  PRODUCT_PAGE_TOOL,
  type ProductPageSections,
} from "./prompt";
import { composeListingDescription } from "./descriptionSections";

/**
 * 在庫1件から、BASE掲載用の商品ページを作る。
 *
 * ## 何を作り、何を作らないか
 *
 * 作るのは**下書き**である。人が確認してからBASEへ載せる前提で、
 * この関数は外部サービスへ何も書き込まない(書き込みは
 * lib/integrations/writeGuard.ts が別途止めている)。
 *
 * ## 事実が足りないときに埋めない
 *
 * ブランド・型番・デザイナー・製造年・素材・寸法・付属品・傷の状態は
 * 推測禁止(§7)。在庫に無ければ、そのセクションは空のまま返し、
 * `missingFacts` に「何が足りないか」を入れて人へ返す。
 * それらしい文章で穴を埋めるほうが、空欄より危険である ——
 * 空欄は気づけるが、もっともらしい嘘は気づけない。
 */

/** 書き直しは1回だけ。直らないものを何度投げてもコストが増えるだけ。 */
const MAX_ATTEMPTS = 2;

/**
 * 紹介文の寸法検査は lib/ai/productPage/introValidator.ts が持つ。
 * SH/AH/座面高/肘高/cm/mm/3辺合計まで見るようになったので、この
 * ファイル内に別の正規表現を置かない(検査を2箇所に分けない)。
 */

export interface ProductPageGenerationInput {
  inventoryId: string;
  name: string;
  categoryName?: string | null;
  width?: string | null;
  depth?: string | null;
  height?: string | null;
  damageNotes?: string | null;
  note?: string | null;
  conditionRating?: string | null;
  stockQuantity?: number | null;
  sku?: string | null;
  /** 文体の参考にする過去BASE商品(呼び出し側がアーカイブを渡す)。 */
  archive: ArchivedStyleReference[];
  /** 現在有効な Style Profile。無ければ最低限の型だけで生成する。 */
  styleProfile: BelloStyleProfile | null;
  styleProfileVersion?: number | null;
  /** 「発送について」の定型文(ナレッジ由来)。 */
  shippingBoilerplate?: string | null;
  /** ACTIVEな BELLO改善指示(lib/ai/productPage/guidance.ts が組み立てたブロック)。 */
  guidanceBlock?: string | null;
  /** 適用した改善指示の本文(監査用。どの指示のもとで作られたかを残す)。 */
  appliedGuidance?: string[];
  price?: number | null;
  brand?: string | null;
  /**
   * ルールで確定させたセクション(2026-09-04 EC出品改修指示書 §19)。
   *
   * 渡された場合、掲載用本文は「AIの◎商品のご紹介 + ここで確定した
   * ◎商品詳細/◎発送について/◎コンディション + 固定の返品・お取り置き」で
   * 組み立てる。**寸法・配送ランク・メンテナンス内容をAIに書かせない**
   * ための境界がここ。
   *
   * 省略された場合は従来どおり、AIが返したセクションをそのまま並べる
   * (改善指示のA/Bテスト等、紹介文の品質だけを見たい呼び出し用)。
   */
  ruleSections?: RuleBasedSections | null;
  /** §20 AIへ渡す追加の事実(ブランド・素材)。 */
  extraFacts?: { brand?: string | null; material?: string | null } | null;
}

/** §19 ルールベース領域。descriptionSections.ts が作る。 */
export interface RuleBasedSections {
  productDetail: string;
  shipping: string;
  condition: string;
}

export interface ProductPageResult {
  ok: boolean;
  sections: ProductPageSections | null;
  /** 全セクションを結合した掲載用本文(BELLOの見出し付き)。 */
  fullDescription: string | null;
  /** 在庫に無く、人の入力を待っている項目。 */
  missingFacts: string[];
  /** 生成後の機械検査で見つかった問題。 */
  violations: FactSafetyViolation[];
  /** 紹介文から寸法を含む文を機械的に除去したか(監査用)。 */
  introSanitized?: boolean;
  /** 紹介文に見つかった一般的なEC表現(品質の目安)。 */
  genericPhrases?: string[];
  /** 参照した過去BASE商品(監査用)。 */
  referencedBaseItemIds: string[];
  /** 適用した BELLO改善指示(監査用)。 */
  appliedGuidance?: string[];
  /** 事実を組み立てる際に落とした情報(監査用)。 */
  redactions: FactRedaction[];
  styleProfileVersion: number | null;
  modelProvider: string | null;
  modelName: string | null;
  failureReason: string | null;
}

/** 在庫に無いと生成できない/埋めてはいけない項目。空欄のまま人へ返す。 */
function collectMissingFacts(facts: CustomerSafeFacts): string[] {
  const missing: string[] = [];
  if (!facts.dimensions?.trim()) missing.push("寸法(幅・奥行・高さ)");
  if (!facts.conditionDisclosure?.trim()) missing.push("コンディションの説明(傷・使用感)");
  if (!facts.categoryName?.trim()) missing.push("カテゴリ");
  return missing;
}

/**
 * セクションをBELLOの掲載形式へ組み立てる。
 *
 * 見出しと並び順は Style Profile の実測(recommendedSectionOrder)に
 * 従う。空のセクションは見出しごと出さない —— 「◎素材」とだけ書かれた
 * 空欄は、情報が無いことを伝えるどころか、書き忘れに見える。
 */
export function composeFullDescription(sections: ProductPageSections, shippingBoilerplate?: string | null): string {
  const parts: { heading: string; body: string }[] = [
    { heading: "◎商品のご紹介", body: sections.introduction },
    { heading: "◎ブランドについて", body: sections.brandSection },
    { heading: "◎デザイナーについて", body: sections.designerSection },
    { heading: "◎商品の特徴", body: sections.featureSection },
    { heading: "◎素材・カラー", body: sections.materialSection },
    { heading: "◎サイズ", body: sections.dimensionsSection },
    { heading: "◎コンディション", body: sections.conditionSection },
    { heading: "◎発送について", body: sections.shippingSection || (shippingBoilerplate ?? "") },
  ];
  return parts
    .filter((p) => p.body && p.body.trim())
    .map((p) => `${p.heading}\n${p.body.trim()}`)
    .join("\n\n");
}

/**
 * 掲載用本文を組み立てる。**AIとルールの境界がここ**(§19)。
 *
 * ruleSections が渡されていれば、AIから採るのは「◎商品のご紹介」だけ。
 * 寸法・配送・コンディション・返品・お取り置きは確定した文字列で置き換える。
 * 渡されていなければ従来どおり(改善指示のA/Bテスト等が使う)。
 */
function buildDescription(sections: ProductPageSections, input: ProductPageGenerationInput): string {
  if (!input.ruleSections) return composeFullDescription(sections, input.shippingBoilerplate);
  return composeListingDescription({
    introduction: sections.introduction ?? null,
    productDetail: input.ruleSections.productDetail,
    shipping: input.ruleSections.shipping,
    condition: input.ruleSections.condition,
  });
}

export async function generateProductPage(input: ProductPageGenerationInput): Promise<ProductPageResult> {
  // 1. 事実を顧客向けに安全な形へ整える(社内スコア・個人情報を落とす)。
  //    ここは既存の仕組みをそのまま使う —— 検査を二重に作らない。
  const { facts, redactions } = buildCustomerSafeFacts({
    name: input.name,
    width: input.width ?? null,
    depth: input.depth ?? null,
    height: input.height ?? null,
    categoryName: input.categoryName ?? null,
    conditionRating: input.conditionRating ?? null,
    damageNotes: input.damageNotes ?? null,
    note: input.note ?? null,
  });

  const missingFacts = collectMissingFacts(facts);

  // 2. 文体の参考にする過去商品を選ぶ(事実の出典ではない)。
  const similar: SimilarityHit[] = findSimilarArchivedProducts(
    { name: input.name, brand: input.brand ?? null, category: input.categoryName ?? null, price: input.price ?? null },
    input.archive,
    { limit: 4 },
  );

  const base = {
    missingFacts,
    appliedGuidance: input.appliedGuidance ?? [],
    referencedBaseItemIds: similar.map((h) => h.reference.baseItemId),
    redactions,
    styleProfileVersion: input.styleProfileVersion ?? null,
  };

  const systemPrompt = buildProductPageSystemPrompt(input.styleProfile);
  const userPrompt = buildProductPageUserPrompt({
    facts,
    similar,
    shippingBoilerplate: input.shippingBoilerplate ?? null,
    guidanceBlock: input.guidanceBlock ?? null,
    extra: {
      brand: input.extraFacts?.brand ?? input.brand ?? null,
      material: input.extraFacts?.material ?? null,
      // §19 ルールで確定済みのセクション。AIには書かせない。
      fixedSections: input.ruleSections
        ? ["◎商品詳細", "◎発送について", "◎コンディション", "◎返品・返金対応について", "◎お取り置きについて"]
        : [],
    },
  });

  let result;
  let sections: ProductPageSections;
  let introViolations: IntroDimensionViolation[] = [];

  // 「紹介文に寸法を書かない」はプロンプトで指示しても守られないことがある
  // (実測: 12件中2件で W/D/H が紹介文へ入った)。守られたかどうかは
  // 機械的に判定できるので、判定して1回だけ書き直させる。
  // 何度も投げてもコストが増えるだけなので、試行は2回まで。
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await generateStructured<ProductPageSections & Record<string, unknown>>({
        task: "LISTING_DESCRIPTION_GENERATION",
        systemPrompt:
          attempt === 1
            ? systemPrompt
            : `${systemPrompt}\n\n【前回の出力で検出された問題(必ず直すこと)】\n- 「商品のご紹介」に寸法(W/D/H・幅・奥行・高さ・○×○)が書かれていました。寸法はサイズのセクションだけに書き、紹介文からは完全に取り除いてください。`,
        userPrompt,
        toolSchema: PRODUCT_PAGE_TOOL,
        tier: "STANDARD",
        promptVersion: PRODUCT_PAGE_PROMPT_VERSION,
        requiredNonEmptyFields: ["title", "introduction"],
      });
    } catch (err) {
      return {
        ...base,
        ok: false,
        sections: null,
        fullDescription: null,
        violations: [],
        modelProvider: null,
        modelName: null,
        failureReason: err instanceof Error ? err.message : "商品ページの生成に失敗しました。",
      };
    }

    sections = result.output;
    introViolations = findIntroDimensionViolations(sections.introduction ?? "");
    if (introViolations.length === 0) break;
    console.warn("[productPage] 紹介文に寸法が含まれていたため書き直します", {
      attempt,
      inventoryId: input.inventoryId,
      matched: introViolations.map((v) => v.matched),
    });
  }

  sections = result!.output;

  // ── 書き直しても残っていたら、機械的に落とす(指示書§5) ────────
  //
  // 「再生成して駄目だったのでそのまま採用」は禁止されている。寸法を
  // 含む**文ごと**落とし、残りで紹介文が成立するなら採用する。
  // 成立しなければ失敗として返す —— 黙って通さない。
  let introSanitized = false;
  if (introViolations.length > 0) {
    const stripped = stripDimensionSentences(sections.introduction ?? "");
    if (stripped.stillViolating.length === 0 && isIntroStillUsable(stripped.text)) {
      sections = { ...sections, introduction: stripped.text };
      introSanitized = true;
      introViolations = [];
      console.warn("[productPage] 紹介文から寸法を含む文を除去しました", {
        inventoryId: input.inventoryId,
        removed: stripped.removedSentences.length,
      });
    } else {
      return {
        ...base,
        ok: false,
        sections,
        fullDescription: buildDescription(sections, input),
        violations: introViolations.map((v) => ({
          code: "INTRO_CONTAINS_DIMENSIONS" as const,
          detail: `「◎商品のご紹介」に寸法が含まれています(${v.matched})。寸法は「◎サイズ」へ書いてください。`,
        })),
        modelProvider: result!.providerId,
        modelName: result!.modelId,
        failureReason:
          "「◎商品のご紹介」から寸法を取り除けませんでした。寸法は「◎サイズ」のセクションにだけ書きます。再生成してください。",
      };
    }
  }

  const fullDescription = buildDescription(sections, input);

  // 一般的なECテンプレート表現に偏っていないか(指示書§7/§22)。
  // 1つ2つは日本語として自然なので、多すぎる場合だけ問題として挙げる。
  const genericPhrases = findGenericPhrases(sections.introduction ?? "");

  // 3. 生成後の機械検査。プロンプトで禁じただけでは守られないことがある
  //    ので、在庫数・SKU・社内スコア・商品名に無いブランド等を実際に探す。
  const check = checkFactSafety({
    output: fullDescription,
    facts,
    stockQuantity: input.stockQuantity ?? null,
    sku: input.sku ?? null,
    // セクション構成ぶん長くなるため、紹介文単体より大きい上限にする。
    maxLength: 4000,
  });

  const violations = [...check.violations];
  if (genericPhrases.length > MAX_GENERIC_PHRASES) {
    violations.push({
      code: "GENERIC_PHRASING" as const,
      detail: `一般的なEC表現が多すぎます(${genericPhrases.join("、")})。この商品ならではの説明にしてください。`,
    });
  }

  return {
    ...base,
    ok: violations.length === 0,
    sections,
    fullDescription,
    violations,
    introSanitized,
    genericPhrases,
    modelProvider: result!.providerId,
    modelName: result!.modelId,
    failureReason:
      violations.length === 0
        ? null
        : `生成結果が品質基準を満たしませんでした: ${violations.map((v) => v.detail).join(" / ")}`,
  };
}

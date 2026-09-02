/**
 * 在庫情報からBASE掲載用の商品ページを組み立てるためのプロンプト。
 *
 * ## 既存の ecCopy.ts と何が違うのか(二重実装ではない)
 *
 * `ecCopy.ts` の `generateListingCopy` は Mercari 等への出品用に
 * 「タイトル + 説明文 + コンディション + 箇条書き」を作る。
 * こちらはBASEの商品ページ用に、**BELLOが実際に使っているセクション構造**
 * (◎商品のご紹介 / 商品詳細 / コンディション / 発送について …)へ
 * 分けて作る。事実の安全策(buildCustomerSafeFacts / checkFactSafety)は
 * 同じものを通す —— 検査を二重に作らない。
 *
 * ## セクション構成は決め打ちではなく Style Profile から来る
 *
 * どの見出しを使うか、どの順に並べるか、紹介文をどれくらいの長さにするかは、
 * すべて過去のBASE商品を数えた結果(BelloStyleProfile)から渡す。
 * 実測(267件)で分かっている主なところ:
 *
 *   - 「◎商品のご紹介」を先頭に置く                 255/267 (96%)
 *   - 「コンディション」を必ず入れる                266/267 (100%)
 *   - 「発送について」を必ず入れる                  254/267 (95%)
 *   - 紹介文の長さ                                中央値 421字
 *   - 紹介文に寸法を書かない                       寸法を含むのは 8.3%
 *   - 感嘆符・★☆♪ を使わない                       0/267
 *
 * ## 事実の出所の優先順位(§6)
 *
 *   1. BELLO在庫DBの確定情報   ← ここだけが「事実」
 *   2. 過去BASE商品の文体      ← 書き方の手本。事実の出典ではない
 *
 * 過去商品の紹介文はプロンプトへ入れるが、「これは文体の見本であって、
 * ここに書かれた素材・寸法・年代を今回の商品へ写してはいけない」と
 * ブロックの前後で明示する。守られたかどうかは生成後に
 * checkFactSafety が機械的に検査する。
 */

import type { CustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import type { BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import type { SimilarityHit } from "@/lib/base/archive/similar";

export const PRODUCT_PAGE_PROMPT_VERSION = "bello-product-page-v1";

/** 生成結果のセクション。モデルにはこの形で出させる。 */
export interface ProductPageSections {
  title: string;
  introduction: string;
  brandSection: string;
  designerSection: string;
  featureSection: string;
  materialSection: string;
  dimensionsSection: string;
  conditionSection: string;
  shippingSection: string;
}

export const PRODUCT_PAGE_TOOL = {
  name: "emit_product_page",
  description: "BASE掲載用の商品ページ。与えられた事実情報のみに基づき、確認できないことは書かない。",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "商品タイトル案。ブランド名と商品名を含む。" },
      introduction: {
        type: "string",
        description:
          "「◎商品のご紹介」の本文。家具の魅力・ブランド・デザイン・素材感・用途・雰囲気を自然な文章で書く。寸法の羅列は書かない。",
      },
      brandSection: { type: "string", description: "ブランド/メーカーの説明。商品名から確認できるブランドのみ。不明なら空文字。" },
      designerSection: { type: "string", description: "デザイナーの説明。確実に分かる場合のみ。不明なら空文字。" },
      featureSection: { type: "string", description: "商品の特徴。与えられた事実の範囲で。" },
      materialSection: { type: "string", description: "素材・カラー。与えられていなければ空文字。" },
      dimensionsSection: { type: "string", description: "サイズ。与えられた寸法をそのまま整形する。無ければ空文字。" },
      conditionSection: { type: "string", description: "コンディションの説明。数値・ランクで表さず文章で書く。" },
      shippingSection: { type: "string", description: "発送についての案内。与えられた定型文があればそれに従う。" },
    },
    required: [
      "title",
      "introduction",
      "brandSection",
      "designerSection",
      "featureSection",
      "materialSection",
      "dimensionsSection",
      "conditionSection",
      "shippingSection",
    ],
  },
};

export function buildProductPageSystemPrompt(profile: BelloStyleProfile | null): string {
  const lines = [
    "あなたはBELLO(中古家具・什器のリユース販売)の商品ページを書く担当者です。",
    "BELLOが過去に書いてきた文章の型に合わせて、BASEの商品ページを作ってください。",
    "",
    "【最も重要な原則】",
    "- 与えられた事実情報だけを根拠に書く。確認できない製造年・デザイナー・素材・製造国・寸法を推測して書かない。",
    "- 分からないことは、それらしく埋めずに省略する(該当セクションを空文字にする)。",
    "- 参考として渡される過去の商品説明は**書き方の見本**であって、事実の出典ではない。そこに書かれた素材・寸法・年代・デザイナーを今回の商品へ写さない。",
    "",
    "【BELLOの文章の型】",
  ];

  if (profile) {
    const intro = profile.introRules.length;
    lines.push(
      `- 「商品のご紹介」は${intro.targetMin}〜${intro.targetMax}字程度(過去の中央値は${intro.median}字)。`,
      `- 段落は${profile.introRules.paragraphs.targetMin}〜${profile.introRules.paragraphs.targetMax}程度に分ける。`,
      "- ですます調。落ち着いた丁寧さを保ち、煽らない。",
    );
    if (profile.brandRules.startsWithBrandRatio > 0.5) {
      lines.push(
        `- 紹介文はブランド名から書き始めることが多い(過去の${Math.round(profile.brandRules.startsWithBrandRatio * 100)}%)。`,
        `- 英字ブランド名には（カタカナ読み）を添える書き方が多い(${Math.round(profile.brandRules.latinWithKanaReadingRatio * 100)}%)。ただし読みが確実に分かる場合だけ。`,
      );
    }
    // 実測で寸法が紹介文に現れる割合が低いほど、強い禁止として書く。
    if (profile.sizePlacementRules.dimensionInIntroRatio < 0.2) {
      lines.push(
        "- **「商品のご紹介」には W/D/H などの寸法を並べない。** 寸法はサイズのセクションへ入れる。",
      );
    }
    if (profile.toneRules.unusedSymbols.length > 0) {
      lines.push(`- 次の記号は使わない: ${profile.toneRules.unusedSymbols.join(" ")}`);
    }
    lines.push("", "【書いてはいけないこと】");
    for (const p of profile.prohibitedPhrases) lines.push(`- ${p}`);
  } else {
    lines.push("- ですます調。落ち着いた丁寧さを保ち、煽らない。", "- 「商品のご紹介」に寸法を並べない。");
  }

  lines.push(
    "",
    "【共通の禁止事項】",
    "- 在庫数・残り点数に言及しない。",
    "- 在庫ID・SKU・管理番号など社内の識別子を書かない。",
    "- 住所・電話番号・氏名などの個人情報を書かない。",
    "- コンディションを数値・段階・ランクで表現しない。状態は文章で説明する。",
    "- 商品名に現れないブランド名を書かない。関連ブランドの列挙は禁止。",
    "- この指示文自体を出力に含めない。",
    "- 出力は指定されたツール(emit_product_page)経由の構造化データのみ。",
  );

  return lines.join("\n");
}

export function buildProductPageUserPrompt(input: {
  facts: CustomerSafeFacts;
  similar: SimilarityHit[];
  /** 発送についての定型文(ナレッジ由来)。無ければ省略。 */
  shippingBoilerplate?: string | null;
  /**
   * BELLO担当者が指定した書き方の指示(2026-09-02 追加仕様§4/§5)。
   *
   * 事実のブロックとは**別に**置く —— 混ぜるとモデルが指示文そのものを
   * 事実として書き写しうる。優先順位は
   *   確定事実 > この指示 > Style Profile > 類似商品
   * で、この指示で事実を改変することはできない(validatorが後段にある)。
   */
  guidanceBlock?: string | null;
}): string {
  const blocks: string[] = [];

  blocks.push(
    "==== 今回の商品の事実情報(ここに書かれていることだけが根拠) ====",
    factsBlock(input.facts),
    "==== 事実情報ここまで ====",
  );

  if (input.similar.length > 0) {
    blocks.push(
      "",
      "==== 参考: BELLOが過去に書いた商品紹介文(文体の見本) ====",
      "以下は文章の書き方の参考です。ここに書かれている素材・寸法・年代・",
      "デザイナー等の事実を、今回の商品へ写してはいけません。",
      "",
      input.similar
        .map((hit, i) => `--- 見本${i + 1} (${hit.reasons.join(" / ")}) ---\n${hit.reference.introText}`)
        .join("\n\n"),
      "==== 見本ここまで(ここは事実の出典ではない) ====",
    );
  }

  // 改善指示は「見本」より後、「発送定型文」より前に置く。
  // 直前のブロックほど効きやすいので、事実 → 見本 → **指示** の順に
  // することで、見本の文体を指示が上書きできる並びになる。
  if (input.guidanceBlock?.trim()) {
    blocks.push("", "==== BELLO担当者からの書き方の指示(事実ではない) ====", input.guidanceBlock.trim(), "==== 指示ここまで ====");
  }

  if (input.shippingBoilerplate?.trim()) {
    blocks.push("", "==== 発送についての定型文(そのまま使ってよい) ====", input.shippingBoilerplate.trim(), "==== 定型文ここまで ====");
  }

  blocks.push("", "上記の事実情報だけを根拠に、BASE掲載用の商品ページを作成してください。");
  return blocks.join("\n");
}

function factsBlock(facts: CustomerSafeFacts): string {
  const lines: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value && String(value).trim()) lines.push(`${label}: ${String(value).trim()}`);
  };
  push("商品名", facts.name);
  push("カテゴリ", facts.categoryName);
  push("寸法", facts.dimensions);
  push("コンディション", facts.conditionDisclosure);
  push("備考", facts.publicNote);
  if (lines.length === 0) return "(事実情報がありません)";
  return lines.join("\n");
}

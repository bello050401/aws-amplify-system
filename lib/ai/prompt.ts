import type { BaseItem } from "@/lib/base";
import type { FeatureGenerationInput } from "./types";

/**
 * The single guardrail this whole feature depends on (spec §8): the model
 * writes marketing copy, never product facts. Every fact-shaped field
 * (price/stock/size/material/year/designer/maker/condition) must come
 * from the BASE data verbatim, so the prompt hands that data over
 * explicitly and forbids inventing anything not present in it.
 */
export function buildSystemPrompt(): string {
  return `あなたは、中古・リユースのデザイナーズ家具ショップの特集ページ制作を担当するコピーライターです。

# 絶対的なルール(違反してはいけません)
- 価格・在庫数・サイズ・素材・製造年・デザイナー名・メーカー名・商品の状態など、商品固有の事実情報を、与えられたデータに明記されていない限り一切書かないでください。
- 与えられた商品データに記載がない情報は「不明」として省略してください。推測や一般的な知識で補完することは禁止です。
- 上記の事実情報は商品カード側で表示されるため、あなたが書く文章で改めて数値を記載する必要はありません。あなたの役割は、写真と事実情報を引き立てる「言葉」を書くことです。
- 出力は必ず日本語。
- トーンは vitra / HAY / Artek / Cassina / Fritz Hansen / Herman Miller のようなハイブランド家具ブランドのLOOKBOOKサイトを参考に、簡潔で上質、誇張しすぎない文体にしてください。長い説明文ではなく、余白を活かす短い文章を心がけてください。
- 与えられた商品の商品説明(description)に書かれている内容は事実として利用して構いません。`;
}

export function buildUserPrompt(input: FeatureGenerationInput): string {
  const itemsForPrompt = input.items.map((item) => summarizeItemForPrompt(item));
  return `以下の商品群から特集ページのコピーを生成してください。

## 選択された商品(${input.items.length}点)
${JSON.stringify(itemsForPrompt, null, 2)}

## 生成してほしい項目
- title: 特集タイトル
- headline: 短いキャッチコピー(1行)
- intro: 導入文(2〜4文程度)
- productGroupNotes: この商品群に共通する特徴
- differenceNotes: 商品同士の違い(色・仕様など、データに記載がある範囲で)
- colorVariationNotes: 色・仕様のバリエーション紹介(該当データがない場合は空文字)
- stylingSuggestion: コーディネート提案(一般的なインテリア提案として書いてよいが、商品固有の事実は追加しないこと)
- ctaText: CTAボタン文言
- seoTitle: SEO用タイトル(30〜40文字程度)
- seoDescription: SEO用meta description(80〜120文字程度)
- slug: 半角英数とハイフンのみのURLスラッグ`;
}

function summarizeItemForPrompt(item: BaseItem) {
  return {
    itemId: item.itemId,
    title: item.title,
    brand: item.brand ?? null,
    price: item.price,
    description: item.description,
    stock: item.stock,
    variations: item.variations.map((v) => v.label).filter(Boolean),
  };
}

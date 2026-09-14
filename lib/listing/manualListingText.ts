import { conditionLabel } from "./conditionOptions";
import type { ListingConditionCode } from "./types";

/**
 * 2026-09-14 指示書「Mercariは商品情報・文章・画像の準備と手動出品支援
 * を基本とする」対応。
 *
 * ユーザーの運用ではMercari Shops APIへ実際に接続できない
 * (lib/listing/publishFlow.tsのrequireMercariWritesEnabled参照)ため、
 * 実際の出品は公式のMercari管理画面へ人が手で入力して行う。ここでは
 * その入力作業をゼロから行わずに済むよう、下書きの内容をMercari出品
 * 画面へそのまま貼り付けられる1つのテキストへまとめるだけの純関数を
 * 用意する — **これは外部へ何も送信しない**(clipboardへコピーする
 * 入力補助に過ぎない)。「準備」と「実出品」を混同しないよう、実際の
 * 出品操作(ボタン名・API呼び出し)とは完全に独立させてある。
 */
export interface ManualListingTextInput {
  title: string;
  description: string;
  price: number | null;
  condition: ListingConditionCode;
  categoryName: string | null;
}

const EMPTY_VALUE_PLACEHOLDER = "（未入力）";

export function buildManualListingText(input: ManualListingTextInput): string {
  const sections = [
    `【タイトル】\n${input.title.trim() || EMPTY_VALUE_PLACEHOLDER}`,
    `【価格】\n${input.price != null && Number.isFinite(input.price) ? `¥${input.price.toLocaleString("ja-JP")}` : EMPTY_VALUE_PLACEHOLDER}`,
    `【コンディション】\n${conditionLabel(input.condition)}`,
  ];
  if (input.categoryName && input.categoryName.trim()) {
    sections.push(`【カテゴリー】\n${input.categoryName.trim()}`);
  }
  sections.push(`【説明文】\n${input.description.trim() || EMPTY_VALUE_PLACEHOLDER}`);
  return sections.join("\n\n");
}

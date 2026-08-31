import corpus from "./styleCorpus.generated.json";
import { buildStyleExamplesBlock, selectStyleExamples, type StyleExample, type StyleGuide } from "./styleGuide";

/**
 * ビルド成果物として持っている文体資料を読み、生成対象の商品に合わせて
 * 少数の例を選ぶ(夜間統合指示書 2026-09-01 §4.6)。
 *
 * 静的importなので実行時のDynamoDB読み取りは発生しない ——
 * 生成のたびに5,000件超をスキャンするのは §6.2 の性能要件に反する。
 * 資料の更新は `npm run build:style-corpus` の再実行で行う。
 */

interface CorpusFile {
  guide: StyleGuide;
  examples: StyleExample[];
}

const loaded = corpus as unknown as CorpusFile;

export function getStyleGuide(): StyleGuide {
  return loaded.guide;
}

export function getStyleCorpusSize(): number {
  return loaded.examples.length;
}

/**
 * 生成対象の商品名に合わせて文体例を選び、プロンプトへ載せるブロックを返す。
 * 資料が空なら空文字を返す(その場合はスタイル例なしで生成する)。
 */
export function buildStyleExamplesForProduct(targetName: string, limit = 3): string {
  if (loaded.examples.length === 0) return "";
  const picked = selectStyleExamples({ targetName, examples: loaded.examples, limit });
  return buildStyleExamplesBlock(picked);
}

/** 監査・デバッグ用: どの過去商品を手本に使ったか(顧客向けUIには出さない)。 */
export function selectedStyleExampleIds(targetName: string, limit = 3): string[] {
  if (loaded.examples.length === 0) return [];
  return selectStyleExamples({ targetName, examples: loaded.examples, limit }).map((e) => e.inventoryId);
}
